// 所属：packages/durable/src/codemode，可持久化的代码模式工具（codemode）实现。
// 作用：让模型写一段 JavaScript，在 QuickJS 沙箱里调用其他工具；脚本状态可跨进程重启存活。核心机制是
// 确定性重放：沙箱只在宿主交付结果时推进；相同的起始数据、时钟、种子和顺序相同的结果会产生相同的调用。
// 重启后 execute() 重新执行，从 pi.codemode.run 取出 start 数据，按 pi.codemode.journal 的顺序重新交付旧结果，
// 再继续实时运行；嵌套工具调用按 key（c<VM 调用 id>）重新挂到已有任务，不会重复执行。
// 职责边界：本文件只负责工具注册、调用生命周期、journal 持久化、重放/分叉检测、结果格式化和 details；
// 不实现沙箱（CodemodeSandboxBase）、不实现工具本身（api.executeTool）、不定义模型能力（models.ts）。
// 上游：Harness 以 ToolTask 调用 createCodemodeTool() 生成的工具；宿主通过 createCodemodeExtension 安装工具与
// `codemode` 提示词段。下游：pi-codemode 的沙箱/源码解析/标识符，describe.ts（说明与目录）、models.ts（模型能力）、
// output.ts（结果排版）、durable 的 documents/harness/tool/search。
// 能力清单（导出项）：
// - CODEMODE_MODULE_VERSION：结果映射/全局/start 数据版本；升级需递增，避免旧脚本被新代码重放。
// - CODEMODE_TOOL_NAME：工具名 "codemode"。
// - CodemodeRunDoc：任务级文档，保存 start、输出目录与最终 result。
// - CodemodeJournalDoc：任务级文档，按交付顺序保存结果与已发出调用计数。
// - CodemodeStoreDoc：会话级、可回溯、按 fork 点复制的 store()/load() 键值。
// - CodemodeNestedCall/CodemodeToolDetails：结果 details 中的调用行与完整输出路径。
// - CodemodeGlobal：脚本可调用的顶层全局函数（内部扩展点）。
// - CodemodeToolInput/CodemodeToolOptions：工具参数与创建选项。
// - createCodemodeTool(options)：返回 name 为 "codemode" 的 ToolRegistration。
// - createCodemodeExtension(options)：返回包含工具、内部模型工具和提示词段的 Extension。
// 典型调用：
//   const extension = createCodemodeExtension({ sandbox });
//   // 模型调用 codemode({ code: "const r = await tools.read({ path: 'a.txt' }); return r;" })
// 建议阅读顺序：先 Start/JournalEntry 等持久化类型与三个文档，再看 createCodemodeTool/createCodemodeExtension，
// 然后按 CodemodeCall.execute 的主流程读 decide/complete/onCall/onIdle/release/pump，最后读文件尾部的小工具函数。
/**
 * Durable code mode: a tool that runs model-written JavaScript in a QuickJS sandbox, whose script survives a restart.
 *
 * Problem: a script is in-memory VM state. A restart while
 *
 *     const results = await Promise.all(paths.map((path) => tools.read({ path })));
 *
 * waits for the last of 200 reads would lose the script and every read it made.
 *
 * Solution: deterministic replay (`CodemodeSandboxBase.start()` in pi-codemode). The VM only runs when the host hands
 * it a result; given the same start data, clock, seed, and results in the same order, it makes the same calls with
 * the same arguments. The tool is replay-safe: after a restart, `execute()` runs again, starts the script again from
 * the stored start data, and hands it the results it got before, in the order it got them, from a journal written
 * before each delivery. Nested tool calls reattach to their tasks by key (`c<VM call id>`), so they never run twice
 * unless their own replay policy reruns them; their results come from `NestedCallDoc`. Then the script continues live.
 *
 * Documents, scoped to the code mode call's task and gone when it settles:
 * - `pi.codemode.run`: the start data, written once before the VM starts, and the outcome, written once when the call
 *   decides it (with the store writes, in one transaction), so a rerun after that returns it without a VM.
 * - `pi.codemode.journal`: one entry per delivered result, in delivery order: the VM call ID, the clock value, the
 *   calls the VM had issued after processing it (once acknowledged), and a global's outcome, which nothing else stores.
 *
 * Each result's acknowledged call count is recorded with the next journal commit, or at once when the VM has processed
 * everything delivered: a script waiting on a long call is where a restart usually finds it. A sequential script
 * therefore costs one journal commit and one count commit per result, on top of its nested calls' own; that is the
 * price of checking the most common crash point.
 *
 * A call is launched only once the count of calls issued in the drain that made it is committed. So every key an earlier
 * attempt admitted is at most its last recorded count; a replay checks every recorded count, so when it releases its
 * calls it has made every call an earlier attempt could have admitted, and later calls are new.
 *
 * A rerun refuses to replay (no new nested calls; nested calls admitted earlier may still resume on their own and are
 * aborted by the call's cleanup) when this module's version or the VM's fingerprint changed, when the deadline passed,
 * or when the script diverges: it makes another call, or calls in another order, than the journal says. Each ends the
 * call with an error result.
 */
import type { Context } from "@earendil-works/chord/context";
import { ownedSlice } from "@earendil-works/chord/delta";
import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import type { TextContent } from "@earendil-works/pi-ai";
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type {
	CodemodeHostCall,
	CodemodeOutcome,
	CodemodeResult,
	CodemodeRun,
	CodemodeSandboxBase,
} from "@earendil-works/pi-codemode/portable";
import { CODEMODE_SOURCE_GRAMMAR, parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { obj, type Static, str } from "@earendil-works/pi-schema";
import { defineDoc } from "../documents.ts";
import type { ExecutionEnv } from "../env/index.ts";
import { errorMessage } from "../errors.ts";
import { defineExtension, defineTool, section } from "../harness/define.ts";
import { NestedCallDoc, type ToolTaskInput } from "../harness/tool.ts";
import type {
	Extension,
	NestedToolExecutionResult,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from "../harness/types.ts";
import { rankDocuments } from "../search.ts";
import type { JsonObject } from "../types.ts";
import {
	type CodemodeNamespace,
	codemodeDescription,
	codemodeSection,
	DEFAULT_CODEMODE_INLINE_BUDGET,
	namespaceOf,
	sampleOf,
} from "./describe.ts";
import {
	CATALOG_GLOBALS,
	CODEMODE_INTERNAL_PREFIX,
	catalogCall,
	createModelTools,
	GENERATE_IMAGES_TOOL,
	MAX_CONCURRENT_MODEL_CALLS,
	MODEL_CALLS,
} from "./models.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, formatResult, type OutputFile } from "./output.ts";

/**
 * Version of everything in this module that turns stored results into what a script sees: result mapping, globals,
 * start data. Bump it when that changes, so a call started before an upgrade is not replayed by different code.
 */
// 重放兼容版本：改变“存储结果 → 脚本可见值”的映射、全局函数或 start 数据结构时递增。
// 旧调用在新版本下会拒绝重放并返回错误，而不是用不同语义悄悄继续。
export const CODEMODE_MODULE_VERSION = 2;

// 工具对模型暴露的名称；也是 Harness 路由和 replay key 的依据。
export const CODEMODE_TOOL_NAME = "codemode";

/** One tool as the script sees it: `tools.<jsName>`. */
/**
 * `structured`: the tool declares `structuredOutputSchema`, so an error result with a value resolves with it.
 * `hidden`: an internal tool of this extension (`pi.codemode.*`), which scripts reach only through a global such as
 * `models.classify()`; never in `tools`, `ALL_TOOLS`, or tool search.
 */
// 脚本视角的一个工具声明：name 是注册名，jsName 是转换后的合法 JS 标识符，description 是调用样例。
// structured 表示有 structuredOutputSchema（错误结果若带值也会作为成功值）；hidden 表示内部工具，
// 不出现在 tools/ALL_TOOLS/搜索中，只能由全局函数间接调用。这些字段会写入 start 数据，供重放时保持一致。
type DeclaredTool = { name: string; jsName: string; description: string; structured?: true; hidden?: true };

/** What a call starts with; a rerun starts the VM from exactly this. */
// 一次调用的起始数据；重启后的重跑完全从这里恢复 VM，保证确定性。
// startedAt/seed 固定时钟和随机数；fingerprint 在校验后记录；deadline 是绝对超时时间；
// tools/namespaces/globals 是脚本可见环境；maxOutputTokens 与 store 快照也属于起始状态。
type Start = {
	version: number;
	startedAt: number;
	seed: number;
	/** The VM's fingerprint, recorded by the first run before any call is admitted. */
	fingerprint?: string;
	/** `startedAt + timeout_ms` when the script set one. */
	deadline?: number;
	tools: DeclaredTool[];
	/** The namespaces of the tools, as `describeNamespace()` and `searchTools()` see them. */
	namespaces: { name: string; description?: string; instructions?: string; tools: string[] }[];
	globals: { name: string; spread: boolean }[];
	/** `max_output_tokens` of the script's options line, or the default. */
	maxOutputTokens: number;
	store: Record<string, JsonValue>;
};

// 运行状态文档的内容：start 只写一次；outputDir 记录结果文件目录；result 一旦决定就不再改变。
type RunState = {
	start?: Start;
	/** Directory of the result's files (the full output, images), created once: a rerun writes the same files again. */
	outputDir?: string;
	/** The outcome, decided once. */
	result?: JsonObject;
};

// 任务级文档 pi.codemode.run：保存 start 与最终结果。scope 为 task，任务结束后文档随之隐退；
// checkpointWhen 恒 false 表示不单独生成检查点（由任务/会话的提交机制负责持久化）。
export const CodemodeRunDoc = defineDoc<RunState>({
	kind: "pi.codemode.run",
	version: 1,
	scope: "task",
	initial: () => ({}),
	// The document retires with its task.
	checkpointWhen: () => false,
});

// journal 条目：id 是 VM 调用编号；at 是处理该结果时的 VM 时钟；issuedAfter 是 VM 处理完后已发出的调用数
// （确认后写入）；global 记录全局函数调用的参数与结果（工具结果来自嵌套任务，无需在此重复）。
type JournalEntry = {
	/** The VM's call ID. Its result is the entry's position + 1 (`seq`). */
	id: number;
	/** The VM clock while it processes this result. */
	at: number;
	/** Calls the VM had issued after processing this result; absent until acknowledged. */
	issuedAfter?: number;
	/** A global's call and outcome; a tool's result is its nested call's. */
	global?: { name: string; args?: JsonValue; outcome: JsonObject };
};

// journal 文档内容：entries 按交付顺序排列；firstIssued 是首次运行后、任何结果前的调用数（确认后才存在）。
type JournalState = {
	entries: JournalEntry[];
	/** Calls the VM had issued after the script's first run, before any result; absent until acknowledged. */
	firstIssued?: number;
};

// 任务级文档 pi.codemode.journal：重放的数据源。每个交付结果对应一个条目，确认计数随后合并写入；
// checkpointWhen 恒 false，生命周期与任务一致。
export const CodemodeJournalDoc = defineDoc<JournalState>({
	kind: "pi.codemode.journal",
	version: 1,
	scope: "task",
	initial: () => ({ entries: [] }),
	// The document retires with its task.
	checkpointWhen: () => false,
});

/**
 * What scripts keep with `store()` and read with `load()`, per conversation. Rewindable and copied as of the fork
 * point, so a fork sees the values as they were when its entry was committed.
 */
// 脚本 store()/load() 的持久化数据：按会话作用域，history 为 rewindable（可回溯），fork 为 asOf
// （分叉时复制分叉点当时的值）。只有累计 64 个 delta 才建议生成检查点，避免每次写都做快照。
export const CodemodeStoreDoc = defineDoc<{ values: Record<string, JsonValue> }>({
	kind: "pi.codemode.store",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ values: {} }),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/** One tool call a script made, as the code mode call's details show it. */
// details 中的一行嵌套工具调用；id 是 VM 的调用编号，嵌套任务 key 为 "c<id>"。
// args/error 是截断后的展示文本，不用于重放或执行。
export type CodemodeNestedCall = {
	/** The VM's number for the call; its nested call ID is `<callId>/c<id>`. */
	id: number;
	name: string;
	/** Compact JSON of the arguments, cut for display. */
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	/** Error text, cut for display. */
	error?: string;
};

/**
 * The code mode call's details, in its result: its tool calls in the order it made them, with their status. Calls to
 * globals are not listed. While the script runs, UIs show its nested calls from `pi.live.nestedTools`, so the list is
 * written once, with the result.
 */
// codemode 结果的 details：按调用顺序列出工具调用（不含全局函数调用）与截断时的完整输出路径。
// 脚本运行期间的实时展示走 pi.live.nestedTools，这里只在最终结果中写一次。
export type CodemodeToolDetails = {
	calls: CodemodeNestedCall[];
	/** Temp file with the complete text output, when the output was cut to its token budget. */
	fullOutputPath?: string;
};

// 参数与错误预览的字符上限：args 保留 200 字符，error 保留 500 字符。
const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;

// 截断展示文本：超过上限时保留前 max-3 个字符并加 "..."；ownedSlice 返回拷贝，
// 让 details 行不长期引用可能很大的参数/错误字符串。
function cut(text: string, max: number): string {
	// A copy: the row outlives the arguments or error text it previews.
	return text.length > max ? `${ownedSlice(text, 0, max - 3)}...` : text;
}

/** A function scripts call as a top-level global; its result is journaled. */
// 脚本可调用的顶层全局函数：name 是脚本中的名字，spread=true 表示以展开参数调用（如 text(...)）；
// execute 接收脚本参数、工具执行 API 和取消上下文，返回 JSON 值或 undefined。
// 全局调用的结果会写入 journal 的 global 字段，重放时不再真正执行。
export type CodemodeGlobal = {
	readonly name: string;
	readonly spread?: boolean;
	execute(args: unknown, api: ToolExecutionApi, context: Context): Promise<JsonValue | undefined>;
};

// codemode 工具的参数：code 是原始 JavaScript 源码。open:true 允许模型多传字段。
const codemodeSchema = obj({ code: str({ description: "Raw JavaScript source." }) }, { open: true });

// 由 schema 推导的编译期参数类型；不产生运行时校验代码。
export type CodemodeToolInput = Static<typeof codemodeSchema>;

// 创建 codemode 工具的选项：sandbox 必需；namespaces 用于提示词分组与搜索；
// inlineBudget 控制工具声明预算；models=false 关闭 models.*；globals 仅供宿主内部扩展。
export type CodemodeToolOptions = {
	/** Runs the scripts: `CodemodeSandbox` on Node, `RemoteCodemodeSandbox` on Cloudflare. */
	readonly sandbox: CodemodeSandboxBase;
	/** Groups of tools by name prefix, such as MCP servers, for the `codemode` section and tool search. */
	readonly namespaces?: readonly CodemodeNamespace[];
	/** Estimated tokens the tool declarations in the `codemode` section may use. Default 3000. */
	readonly inlineBudget?: number;
	/** Give scripts `models.*`: the model catalog, classifiers, and image generation. Default true. */
	readonly models?: boolean;
	/** @internal Host functions scripts call as globals. */
	readonly globals?: readonly CodemodeGlobal[];
};

/** Outputs bounded by the script's own token budget; the Harness's limits only stop a runaway. */
// 工具输出上限：远大于正常 token 预算，只用于兜底防止失控输出；实际截断由 output.ts 的预算完成。
const OUTPUT_LIMITS = { maxBytes: 4 * 1024 * 1024, maxLines: 100_000 } as const;

/** Globals for finding tools, answered from the start data, so a replay sees what the first run saw. */
// 三个发现类全局函数；它们完全由 start 数据回答，不访问实时状态，因此重放结果一致。
const DISCOVERY_GLOBALS = ["searchTools", "describeTool", "describeNamespace"] as const;
// searchTools() 未指定 limit 时的默认返回条数。
const DEFAULT_SEARCH_LIMIT = 8;

/** The code mode tool. Scripts call the conversation's callable tools as `tools.<name>(args)`. */
// 创建 codemode 工具注册；构造时不启动沙箱、不读写文档。
// description 固定（models 开关只影响是否介绍 models.*）；replay:"safe" 告诉 Harness 重启后可以重新执行；
// callers:["model"] 表示只由模型调用，不被其他工具调用；constrainedSampling 让支持的模型按语法直接写源码。
// 每次 execute 都新建 CodemodeCall，由它管理本次调用的重放/持久化状态。
export function createCodemodeTool(options: CodemodeToolOptions): ToolRegistration<typeof codemodeSchema> {
	return defineTool({
		name: CODEMODE_TOOL_NAME,
		description: codemodeDescription(options.models !== false),
		parameters: codemodeSchema,
		outputLimits: OUTPUT_LIMITS,
		// Capable models write the script as raw text instead of a JSON-escaped string; pi-ai applies it only for them.
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		callers: ["model"],
		replay: "safe",
		// 交给 CodemodeCall：解析源码、恢复/创建 start、驱动沙箱与 journal。
		execute: (args, api, context) => new CodemodeCall(options, api, context).execute(args.code),
	});
}

/**
 * The `codemode` extension: the code mode tool, and the `codemode` prompt section listing the tools scripts can call.
 */
// 组装完整扩展：主工具 + 可选的 models 内部工具 + 动态提示词段。
// 提示词段只列出非内部、非 deferred 的可调用工具；deferred 工具由脚本用 searchTools() 查找。
// 没有可调用工具时 codemodeSection 返回 undefined，该段自然省略。构造时同样无 I/O。
export function createCodemodeExtension(options: CodemodeToolOptions): Extension {
	return defineExtension({
		name: "codemode",
		tools: [createCodemodeTool(options), ...(options.models === false ? [] : createModelTools())],
		sections: [
			section("codemode", (input) =>
				codemodeSection(
					// Deferred tools are found with `searchTools()`, as the coding agent leaves them out too.
					// 过滤内部工具（pi.codemode.*）和 deferred 工具；前者只能经全局函数访问，后者按需搜索。
					input.agent.callable.filter(
						(tool) => !tool.name.startsWith(CODEMODE_INTERNAL_PREFIX) && tool.deferred !== true,
					),
					options.namespaces ?? [],
					options.inlineBudget ?? DEFAULT_CODEMODE_INLINE_BUDGET,
				),
			),
		],
	});
}

/**
 * What a script gets for a nested call, as in the coding agent. A tool with a schema resolves with its value, also on
 * an error result that carries one (`bash`'s `{ output, exitCode }` for a nonzero exit); a schema-less tool
 * resolves with its text output, images left out, as its declaration says. Any other error rejects, with its text: a
 * schema-less tool's output, else its error diagnostics.
 */
// 把嵌套工具结果转成脚本可观察的 CodemodeOutcome：
// - 有 structuredOutputSchema 的工具：成功或“带值的错误”都 resolve 该值（如 bash 非零退出仍返回 {output,exitCode}）；
// - 无 schema 的工具：resolve 文本输出（图片被忽略），否则 reject 文本或错误诊断。
// 失败消息优先用工具文本，其次 error 级诊断，最后回退 “Tool <name> failed”。
function outcomeOf(name: string, structured: boolean, result: NestedToolExecutionResult): CodemodeOutcome {
	// 有 schema 时保留原始 JSON 值；无 schema 时压缩成文本。
	const value = structured ? result.structuredOutput : textOf(result.structuredOutput);
	// 非错误，或“有 schema 且确实带回值”：视为成功。
	if (!result.isError || (structured && value !== undefined)) return { ok: true, value };
	// 无 schema 时 value 是文本；有 schema 的错误值只作为 properties 附带，不作为消息。
	const message = structured ? "" : (value as string);
	// 只收集 error 级诊断并拼接；warning/info 不进入失败原因。
	const diagnostics = result.diagnostics
		.filter((diagnostic) => diagnostic.severity === "error")
		.map((diagnostic) => diagnostic.message)
		.join("\n");
	// 有值（即使失败）时放进 properties.structuredOutput，脚本仍可读取；undefined 则省略该键。
	return {
		ok: false,
		message: message || diagnostics || `Tool ${name} failed`,
		...(value === undefined ? {} : { properties: { structuredOutput: value } }),
	};
}

/** The text of a schema-less tool's collapsed output: a string, one image, or an array of text and image blocks. */
// 无 schema 工具的 structuredOutput 可能是字符串、单张图片块或混合块数组；这里只保留文本块并用换行连接，
// 图片没有文本表示，直接忽略。非数组、非字符串的异常形状返回空串。
function textOf(value: JsonValue | undefined): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	// flatMap：文本块映射为 [text]，其他块映射为 []，再扁平化；join 统一成多行文本。
	return value.flatMap((item) => (isText(item) ? [item.text] : [])).join("\n");
}

// 类型谓词：item 是 unknown（来自跨 VM 的 JSON 值），运行时检查对象且 type === "text"，
// 返回 true 后调用处可安全读取 item.text。这不是仅靠断言。
function isText(item: unknown): item is TextContent {
	return typeof item === "object" && item !== null && (item as TextContent).type === "text";
}

// 构造一个错误工具结果：模型看到文本，isError=true；没有 details。
function errorResult(message: string): ToolExecutionResult {
	return { output: [{ type: "text", text: message }], isError: true };
}

/** One execution of the code mode tool: a first run, or a rerun after a restart that replays the journal. */
// 一次 codemode 工具执行：可能是首次运行，也可能是重启后的重跑。实例保存本次尝试的全部内存状态，
// 并负责在重放与实时运行之间切换；持久化状态都在 CodemodeRunDoc/CodemodeJournalDoc 中。
class CodemodeCall {
	private readonly options: CodemodeToolOptions;
	private readonly api: ToolExecutionApi;
	private readonly context: Context;
	// 内部取消控制器：宿主取消、分叉/失败时中止沙箱与嵌套调用；与 context.abortSignal 联动。
	private readonly controller = new AbortController();
	// run 在 start() 之后才赋值，! 是 TS 明确赋值断言，不产生运行时检查。
	private run!: CodemodeRun;
	// start 在第一次提交（读取或创建 start 数据）后赋值。
	private start!: Start;
	/** The journal as this attempt found it; replay delivers exactly these. */
	// 本次尝试开始时读到的 journal 快照；重放只交付这些条目。
	private replayed: JournalEntry[] = [];
	/** Entries in the journal, replayed and live; the next delivery is `length + 1`. */
	// 当前 journal 总条目数（重放 + 实时）；下一次交付的 seq 是 length + 1。
	private journalLength = 0;
	/** Replayed entries delivered so far. */
	// 已重放交付的条目数，也是下一条待交付的重放条目下标。
	private nextReplayed = 0;
	// true 表示当前处于重放阶段：只交付 journal 结果，不启动 journal 中没有的调用。
	private replaying = false;
	/** Whether an earlier attempt ran this call: its nested call keys may already exist. */
	// true 表示更早的尝试运行过本调用，嵌套任务 key 可能已存在，需要检查是否由别的调用占用。
	private rerun = false;
	/** Whether live calls may launch; before, they are held (see `release()`). */
	// true 表示实时调用可以启动；此前调用先进入 held，等待 release()。
	private released = false;
	/** The count an earlier attempt recorded after the script's first run. */
	// 更早尝试记录的“首次运行后已发出调用数”；用于校验重放路径是否一致。
	private firstIssued: number | undefined;
	/** The highest issued count known to be committed: calls up to it may launch. */
	// 已知已提交的最高“已发出调用数”；只有 id 不超过它的调用才能启动，避免提前产生未记录的 key。
	private durableIssued = 0;
	/** Live calls waiting for their issued count to be committed. */
	// 已产生但等待计数提交的实时调用；计数提交后由 launchCovered 启动。
	private waiting: CodemodeHostCall[] = [];
	/** Journal index of each replayed call ID. */
	// 重放条目的调用 ID → 在 replayed 数组中的下标，用于判断一个调用是否已记录及其参数/目标。
	private replayIndex = new Map<number, number>();
	/** Calls the VM issued so far; its call IDs are 1, 2, ... */
	// VM 目前发出的最大调用编号；调用 ID 从 1 开始递增。
	private issued = 0;
	/** Replay: results of journaled calls, ready to deliver in journal order. */
	// 重放阶段：已准备好但尚未按 journal 顺序交付的结果。
	private readonly ready = new Map<number, CodemodeOutcome>();
	/** Replay: calls the journal does not have, admitted once replay is done. */
	// 重放阶段：journal 中没有的新调用，等重放结束后再准入（可能属于脚本的新路径）。
	private held: CodemodeHostCall[] = [];
	/** Live: finished calls waiting for their journal commit. */
	// 实时阶段：已完成、等待与 journal/计数一起提交的调用结果。
	private queue: { id: number; at: number; outcome: CodemodeOutcome; global?: JournalEntry["global"] }[] = [];
	/** Acknowledged counts to record, by result number (0: the script's first run). */
	// 待记录的确认计数：seq → 已发出调用数；seq=0 表示首次运行后、任何结果之前。
	private readonly acks = new Map<number, number>();
	// 防止多个 commit 并发：同一时间只提交一批 journal/计数，期间到达的进入下一批。
	private committing = false;
	/** Set once the call decided an outcome other than the script's own (divergence, mismatch) or failed. */
	// 一旦调用决定了一个非脚本自身的结果（分叉、版本/指纹不匹配）或失败，就保存下来，避免重复决定。
	private ended: ToolExecutionResult | undefined;
	// 内部失败（提交/执行错误）暂存于此，在 execute 的 await 之后重新抛出。
	private failure: unknown;
	/** `models.classify()`/`generateImages()` calls in flight, and those waiting for a slot. */
	// 正在运行的付费模型调用数，以及等待名额的 resolver 队列。
	private modelCalls = 0;
	private readonly modelWaiters: (() => void)[] = [];
	/** Images `models.generateImages()` returned, to notice a script that never shows them. */
	// generateImages 返回的图片总数，用于提示脚本未展示图片。
	private generatedImages = 0;
	/** The script's tool calls for `details`, by VM call ID. */
	// details 展示用的调用行，按 VM 调用 ID 保存。
	private readonly rows = new Map<number, CodemodeNestedCall>();
	/** Resolves once the VM's fingerprint is checked or recorded; nothing is delivered or admitted before. */
	// 门闩：指纹校验/记录完成前，不交付任何结果、不启动任何调用。
	private gate!: Promise<void>;
	private openGate!: () => void;

	// 保存外部依赖；创建门闩 Promise，openGate 在 checkFingerprint 成功后调用。
	constructor(options: CodemodeToolOptions, api: ToolExecutionApi, context: Context) {
		this.options = options;
		this.api = api;
		this.context = context;
		this.gate = new Promise((resolve) => {
			this.openGate = resolve;
		});
	}

	// 工具入口：source 是模型给的原始 JS。流程：解析源码/选项 → 读取可调用工具并冻结 start 环境 →
	// 在一个事务中读取或创建 run 文档与 journal → 校验版本/截止时间/指纹 → 启动沙箱并可选重放 →
	// 等待结果，处理分叉检测 → complete 提交最终结果与 store 写入。
	// 会读写文档、启动沙箱、执行嵌套工具；出错时通过 failure 或返回错误结果结束。
	async execute(source: string): Promise<ToolExecutionResult> {
		// 解析首行 // @options（timeout_ms/max_output_tokens 等）与纯代码；解析错误直接抛出。
		const { code, options: sourceOptions } = parseCodemodeSource(source);
		const { api, context } = this;
		// 获取当前会话/任务可见的工具与模型信息；这是异步边界，之后工具集合视为本次调用的快照。
		const agent = await api.agent(context);
		// 把每个注册工具转成脚本可见声明：name 保留注册名，jsName 转成合法 JS 标识符，
		// description 用 sampleOf 生成调用样例；有输出 schema 记 structured，内部工具记 hidden。
		const tools: DeclaredTool[] = agent.callable.map((tool) => ({
			name: tool.name,
			jsName: toCodemodeIdentifier(tool.name),
			description: sampleOf(tool),
			...(tool.structuredOutputSchema === undefined ? {} : { structured: true as const }),
			...(tool.name.startsWith(CODEMODE_INTERNAL_PREFIX) ? { hidden: true as const } : {}),
		}));
		// callable 用于命名空间分组：排除内部工具，避免把 pi.codemode.* 暴露到目录/命名空间中。
		const callable = agent.callable.filter((tool) => !tool.name.startsWith(CODEMODE_INTERNAL_PREFIX));
		// 模型目录全局：models=false 时为空；否则是三个目录函数加 classify/generateImages 两个付费调用名。
		const models = this.options.models === false ? [] : [...CATALOG_GLOBALS, ...Object.keys(MODEL_CALLS)];
		// 全局函数列表：发现函数与模型函数都以展开参数调用（spread:true）；宿主扩展的全局按其配置。
		const globals = [
			...DISCOVERY_GLOBALS.map((name) => ({ name, spread: true })),
			...models.map((name) => ({ name, spread: true })),
			...(this.options.globals ?? []).map((global) => ({ name: global.name, spread: global.spread === true })),
		];
		// 按命名空间聚合工具名，供脚本的 describeNamespace()/searchTools() 与提示词段使用。
		const namespaces: Start["namespaces"] = [];
		for (const tool of callable) {
			// 同名前缀取最长匹配；不属于任何命名空间的工具跳过。
			const namespace = namespaceOf(tool.name, this.options.namespaces ?? []);
			if (namespace === undefined) continue;
			// 同一个命名空间只建一个条目；find 按名称匹配。
			let entry = namespaces.find((candidate) => candidate.name === namespace.name);
			if (entry === undefined) {
				// 可选描述/说明用条件展开，缺省时不写 undefined 键；tools 从空数组开始。
				entry = {
					name: namespace.name,
					...(namespace.description === undefined ? {} : { description: namespace.description }),
					...(namespace.instructions === undefined ? {} : { instructions: namespace.instructions }),
					tools: [],
				};
				namespaces.push(entry);
			}
			// 保留原始注册名；脚本标识符在需要时用 toCodemodeIdentifier 转换。
			entry.tools.push(tool.name);
		}
		// 首次运行的逻辑时钟与随机种子：一起写入 start，重放时使用相同值。
		const now = api.now();
		// crypto 提供安全随机数；[0]! 断言数组至少有一个元素（TypedArray 长度为 1）。
		const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
		// 事务结果的可辨识联合：done 表示已有最终结果（重跑直接返回）；否则带回 start/journal 等重放数据。
		// 类型别名只用于本地，不参与运行时；in 操作符在下面收窄分支。
		type Found =
			| { done: ToolExecutionResult }
			| { start: Start; journal: JournalEntry[]; firstIssued: number | undefined; rerun: boolean };
		// 一个事务内完成：读 run；若已有 result 直接返回；否则首次运行时创建 start（含 store 快照），
		// 再读 journal。事务保证 start 与 journal 快照一致，且首次运行不会并发创建两份 start。
		const found = await api.commit(async (tx): Promise<Found> => {
			const run = await tx.doc(CodemodeRunDoc, api.taskId);
			// result 是不可变决定：一旦存在，重跑无需启动 VM，直接复制后返回。
			if (run.result !== undefined) return { done: copyJson(run.result as JsonValue) as ToolExecutionResult };
			// start 已存在说明是重跑；否则本次是首次运行。
			const rerun = run.start !== undefined;
			if (run.start === undefined) {
				// 读取会话级 store 当前值，作为脚本起始快照；与 journal 在同一事务中保持一致。
				const store = await tx.doc(CodemodeStoreDoc, api.conversationId);
				// 脚本 options 行中的超时是毫秒数；deadline 存绝对时间，重启后仍可判断是否过期。
				const timeout = sourceOptions.timeoutMs;
				run.start = {
					version: CODEMODE_MODULE_VERSION,
					startedAt: now,
					seed,
					...(timeout === undefined ? {} : { deadline: now + timeout }),
					tools,
					namespaces,
					globals,
					maxOutputTokens: sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
					// copyJson 深拷贝并只保留 JSON 值，避免脚本后续修改引用到文档对象。
					store: copyJson(store.values as JsonValue) as Record<string, JsonValue>,
				};
			}
			const journal = await tx.doc(CodemodeJournalDoc, api.taskId);
			// 再次深拷贝 run.start/journal，返回给调用方后不再受事务对象生命周期影响。
			return {
				start: copyJson(run.start as unknown as JsonValue) as unknown as Start,
				journal: copyJson(journal.entries as unknown as JsonValue) as unknown as JournalEntry[],
				firstIssued: journal.firstIssued,
				rerun,
			};
		}, context);
		// in 收窄联合类型：done 分支直接返回已保存结果，不启动沙箱。
		if ("done" in found) return found.done;
		// 其余分支是重跑或首次运行：保存本次尝试的起始环境与重放快照。
		this.start = found.start;
		this.replayed = found.journal;
		// 建立调用 ID → journal 下标索引；后续 onCall 用它判断调用是否已记录。
		this.replayIndex = new Map(found.journal.map((entry, index) => [entry.id, index]));
		this.journalLength = found.journal.length;
		// 有 journal 条目就进入重放阶段；首次运行（空 journal）直接实时运行。
		this.replaying = found.journal.length > 0;
		this.rerun = found.rerun;
		this.firstIssued = found.firstIssued;
		// A loop, not spread arguments: a journal can hold more entries than a call takes arguments.
		// 用 reduce 求最大已确认计数（而不是 Math.max(...数组)），避免 journal 很大时超出参数个数限制。
		this.durableIssued = found.journal.reduce(
			(max, entry) => Math.max(max, entry.issuedAfter ?? 0),
			found.firstIssued ?? 0,
		);

		// 模块版本变化意味着结果映射语义可能不同，拒绝重放并记录错误结果。
		if (this.start.version !== CODEMODE_MODULE_VERSION) {
			return this.decide(
				errorResult(
					`The script cannot resume: it started under code mode version ${this.start.version}, this is ${CODEMODE_MODULE_VERSION}.`,
				),
			);
		}
		// 截止时间在中断期间已过：不再启动 VM，直接以超时结果结束。
		// remaining 是剩余毫秒数；没有 deadline 时为 undefined，表示不限制。
		const remaining = this.start.deadline === undefined ? undefined : this.start.deadline - this.api.now();
		if (remaining !== undefined && remaining <= 0) {
			return this.decide(errorResult(`Script timed out: its deadline passed while it was interrupted.`));
		}

		// 把宿主的取消信号桥接到内部 controller：宿主中止时沙箱和嵌套调用一起停。
		const onAbort = () => this.controller.abort(context.abortSignal?.reason);
		context.abortSignal?.addEventListener("abort", onAbort, { once: true });
		// 监听前已经中止时，addEventListener 不会再触发，需要手动补一次。
		if (context.abortSignal?.aborted) onAbort();
		try {
			// 启动沙箱：全部参数来自已持久化的 start，保证重放条件一致；
			// hidden 工具不交给脚本，脚本只能通过全局函数间接使用它们。
			this.run = this.options.sandbox.start(code, {
				startedAt: this.start.startedAt,
				seed: this.start.seed,
				tools: this.start.tools.filter((tool) => tool.hidden !== true),
				globals: this.start.globals,
				store: this.start.store,
				signal: this.controller.signal,
				...(remaining === undefined ? {} : { timeoutMs: remaining }),
				// 指纹校验完成前门闩保持关闭，不会交付结果或启动调用。
				onStarted: (fingerprint) => void this.checkFingerprint(fingerprint),
				onCall: (call) => this.onCall(call),
				onIdle: (seq, issued) => this.onIdle(seq, issued),
			});
			// 等待脚本结束（成功、脚本错误、超时或被中止）；期间的结果交付/调用启动由回调驱动。
			const result = await this.run.result;
			// 内部失败（提交错误等）优先重新抛出，交给 Harness 记为该任务失败。
			if (this.failure !== undefined) throw this.failure;
			// 分叉/版本等已经决定的结果，直接返回，不再把脚本结果写入文档。
			if (this.ended !== undefined) return this.ended;
			// 宿主取消：抛 AbortError，让 Harness 按取消处理。
			context.abortSignal?.throwIfAborted();
			// Aborted, but not by this call: the host closed the sandbox, for example while shutting down before closing the
			// Harness. That decides nothing about the script: store nothing and end with this invocation, so a later attempt
			// replays it.
			// 不是本调用主动中止、而是宿主关闭沙箱：不写结果，等宿主取消后抛错，让下次尝试重放。
			if (!result.ok && result.error.kind === "aborted" && !this.controller.signal.aborted) {
				await new Promise<void>((resolve) => {
					// 没有外部信号或已经中止时立即返回；否则等 abort 事件。
					if (context.abortSignal === undefined || context.abortSignal.aborted) resolve();
					else context.abortSignal.addEventListener("abort", () => resolve(), { once: true });
				});
				context.abortSignal?.throwIfAborted();
				throw new Error("The code mode sandbox was closed while the script ran");
			}
			// A replay that ends where the live run went on is a divergence (design §4.3).
			// during 描述重放结束时 VM 已经处理到哪个结果、发出了多少调用。
			const during = result.during;
			// Within the replayed part, the first run included: a rerun without journal entries replays that much too.
			// 只有重跑且结束点落在 journal 已记录范围内时才需要比较；超过范围说明是正常的新路径。
			if (this.rerun && during !== undefined && during.seq <= this.replayed.length) {
				// The live run went on: it acknowledged that result, or it made a call that later results answer, which the
				// replay never made.
				// continued 为真表示首次运行在同一点之后还继续了：
				// - seq=0 时，首次运行后已有 journal 条目或已记录调用数；
				// - 否则该结果的 issuedAfter 已存在（说明处理完后仍有调用）；
				// - 或后续 journal 条目引用了 VM 在此之后才发出的调用 ID。
				const continued =
					(during.seq === 0
						? this.replayed.length > 0 || this.firstIssued !== undefined
						: this.replayed[during.seq - 1]?.issuedAfter !== undefined) ||
					this.replayed.slice(during.seq).some((entry) => entry.id > during.issued);
				if (continued) {
					// 脚本走了更短的路径：判定分叉，记录错误结果并结束。
					return this.decide(
						errorResult(
							`The script took a different path when resumed after a restart: it ended after result ${during.seq}, where it went on before.`,
						),
					);
				}
			}
			// 脚本正常结束：格式化输出并提交最终结果与 store 写入。
			return this.complete(result);
		} finally {
			// 无论成功、失败还是取消，都移除宿主 abort 监听，避免泄漏。
			context.abortSignal?.removeEventListener("abort", onAbort);
		}
	}

	/** Store an outcome the call decided, and end the VM if it runs; returns the outcome. */
	// 保存调用自己决定的结果（分叉、版本/指纹不匹配、超时等），并附带当前 details 后返回。
	// 用 ??= 只写第一次：并发/多次决定时已有结果优先，保证最终结果唯一。
	// 这是一个事务提交，可能失败；失败会向上抛出，由 execute 的调用处处理。
	private async decide(decided: ToolExecutionResult): Promise<ToolExecutionResult> {
		const result = { ...decided, details: this.details() as unknown as JsonValue };
		await this.api.commit(async (tx) => {
			const run = await tx.doc(CodemodeRunDoc, this.api.taskId);
			// omitUndefinedProperties 避免把 undefined 写成非法 JSON；??= 保证只决定一次。
			run.result ??= copyJson(result as unknown as JsonValue, { omitUndefinedProperties: true }) as JsonObject;
		}, this.context);
		return result;
	}

	/** End the call with `message`: store it as the outcome, then stop the VM with an error the script cannot catch. */
	// 判定脚本分叉：先记录错误结果，再中止沙箱（错误对象带原因）。已结束/已失败时不重复处理。
	// 这是同步入口，异步提交结果通过 then 处理；提交失败转入 fail。
	private diverge(message: string): void {
		if (this.ended !== undefined || this.failure !== undefined) return;
		const result = errorResult(`The script took a different path when resumed after a restart: ${message}`);
		this.ended = result;
		this.decide(result).then(
			() => this.controller.abort(new Error(message)),
			(error: unknown) => this.fail(error),
		);
	}

	/** Whether nothing more may happen: the run has its outcome, or the call decided or failed. */
	// 三种停止条件：调用已决定结果、内部失败、或沙箱运行已结束。run 尚未创建时可选链返回 undefined。
	// 所有回调（onCall/onIdle/launch 等）都先检查它，避免结束后继续交付或启动调用。
	private get stopped(): boolean {
		return this.ended !== undefined || this.failure !== undefined || this.run?.finished === true;
	}

	// 记录首个内部失败并中止沙箱；后续失败不覆盖首个错误。
	private fail(error: unknown): void {
		if (this.failure !== undefined) return;
		this.failure = error;
		this.controller.abort(error);
	}

	/** The script's own outcome, stored with its store writes in one transaction. */
	// 处理脚本正常结束的结果：格式化输出（可能写 output.txt/图片临时文件），把 result 与 store 写入
	// 放在同一事务中提交，保证“脚本成功”和其 store 修改要么都生效、要么都不生效。
	// 若 run.result 已存在（例如并发重跑先完成），返回已保存的结果，不覆盖。
	private async complete(result: CodemodeResult): Promise<ToolExecutionResult> {
		// details 在格式化前生成：包含所有已结束的调用行，运行中的标为 cancelled。
		const details = this.details();
		// 墙钟时间用真实时钟差；输出预算/上限来自 start 与常量。
		const formatted = await formatResult(result, {
			generatedImages: this.generatedImages,
			wallMs: this.api.now() - this.start.startedAt,
			maxOutputTokens: this.start.maxOutputTokens,
			calls: details.calls,
			limits: OUTPUT_LIMITS,
			write: this.outputFiles(),
		});
		// 工具结果：output 给模型，details 给 UI，isError 反映脚本成败。
		const tool: ToolExecutionResult = {
			output: formatted.content,
			isError: !result.ok,
			details: {
				...details,
				...(formatted.fullOutputPath === undefined ? {} : { fullOutputPath: formatted.fullOutputPath }),
			} as unknown as JsonValue,
		};
		// 只有成功的脚本才会产生 storeWrites；失败脚本的写入不生效。
		const writes = result.ok ? result.storeWrites : undefined;
		return this.api.commit(async (tx) => {
			const run = await tx.doc(CodemodeRunDoc, this.api.taskId);
			// 结果已存在说明更早的尝试已决定：返回它，避免覆盖并保证幂等。
			if (run.result !== undefined) return run.result as ToolExecutionResult;
			run.result = copyJson(tool as unknown as JsonValue, { omitUndefinedProperties: true }) as JsonObject;
			// 有实际写入（set 非空或 delete 非空）时才读 store 文档，减少事务内读取。
			if (writes !== undefined && (Object.keys(writes.set).length > 0 || writes.delete.length > 0)) {
				const store = await tx.doc(CodemodeStoreDoc, this.api.conversationId);
				// 先删除再写入：同一事务内 set 可覆盖刚删除的同名键。
				for (const key of writes.delete) delete store.values[key];
				for (const [key, value] of Object.entries(writes.set)) store.values[key] = value as JsonValue;
			}
			return tool;
		}, this.context);
	}

	/** Writes the result's files under fixed names into the run's output directory, so a rerun overwrites them. */
	// 返回 OutputFile 回调，供 output.ts 写 output.txt 与图片；文件名固定，因此重跑会覆盖同一文件。
	// 目录 Promise 只解析一次；没有执行环境或写入失败时返回 { error }，不抛错（避免丢掉脚本结果）。
	private outputFiles(): OutputFile {
		const env = this.api.env;
		// 缓存目录的 Promise，避免每次写文件都查询/创建目录；??= 保证只启动一次。
		let directory: Promise<string> | undefined;
		return async (name, data) => {
			if (env === undefined) return { error: "no execution environment" };
			try {
				directory ??= this.outputDir(env);
				// 先等目录，再拼接文件名；await 同一 Promise 多次是安全的。
				const path = `${await directory}/${name}`;
				const written = await env.writeFile(path, data, this.context);
				return written.ok ? { path } : { error: written.error.message };
			} catch (error) {
				// 目录创建/提交等异常同样转成错误文本，保持“结果尽力而为”。
				return { error: errorMessage(error) };
			}
		};
	}

	/** The run's output directory: the recorded one, else a new temp directory, recorded before any file is written. */
	// 解析运行输出目录：先读 run 文档中记录的 outputDir；没有则创建临时目录并记录后再返回。
	// 记录先于写文件，保证重跑能找到第一次的目录并覆盖同样的文件。
	// 并发时用 ??= 保留先写入者；! 断言此时 outputDir 一定存在。
	private async outputDir(env: ExecutionEnv): Promise<string> {
		const recorded = await this.api.commit(
			async (tx) => (await tx.doc(CodemodeRunDoc, this.api.taskId)).outputDir,
			this.context,
		);
		if (recorded !== undefined) return recorded;
		// createTempDir 的前缀用于宿主清理；失败则抛出，最终变成输出文件错误文本。
		const created = await env.createTempDir("pi-codemode-", this.context);
		if (!created.ok) throw new Error(created.error.message);
		return this.api.commit(async (tx) => {
			const run = await tx.doc(CodemodeRunDoc, this.api.taskId);
			run.outputDir ??= created.value;
			return run.outputDir!;
		}, this.context);
	}

	// 校验沙箱指纹：首次运行时记录；重跑时比较，不一致则拒绝继续（不同沙箱版本可能产生不同结果）。
	// 成功后打开门闩，开始重放或首次实时运行。异步失败会转入 fail。
	private async checkFingerprint(fingerprint: string): Promise<void> {
		const recorded = this.start.fingerprint;
		if (recorded !== undefined) {
			if (recorded !== fingerprint) {
				// 先设定 ended，防止后续回调继续推进；decide 保存错误结果；提交失败则转入 fail。
				this.ended = errorResult(
					`The script cannot resume: the sandbox changed since it started (${recorded} -> ${fingerprint}).`,
				);
				await this.decide(this.ended).catch((error: unknown) => this.fail(error));
				this.controller.abort(new Error("Sandbox fingerprint changed"));
				return;
			}
		} else {
			try {
				// 首次运行：在 run.start 中持久化指纹；若重跑已有 start 则沿用已有关系。
				await this.api.commit(async (tx) => {
					const run = await tx.doc(CodemodeRunDoc, this.api.taskId);
					if (run.start !== undefined) run.start.fingerprint = fingerprint;
				}, this.context);
			} catch (error) {
				this.fail(error);
				return;
			}
		}
		// 指纹一致或已记录：放行之前的交付/启动等待。
		this.openGate();
		// Nothing was delivered before the gate: start now. A rerun without a journal releases its calls at the
		// script's first acknowledgment instead.
		// 门闩前没有交付任何结果：有 journal 立即重放；首次运行直接释放持有调用；
		// 无 journal 的重跑则等首次确认（onIdle seq=0）后再释放。
		if (this.replaying) this.deliverReplayed();
		else if (!this.rerun) void this.release();
	}

	// 沙箱回调：VM 发出一次调用（工具或全局）时触发。
	// 先经 asToolCall 把 models.classify/generateImages 全局映射成内部工具调用；工具调用立即登记 running 行。
	// 重放阶段且 journal 有该调用 ID 时：校验目标/参数并复用记录结果（工具调用仍按 key 重新挂任务）；
	// journal 没有的新调用则等 release 后按已提交计数启动。
	private onCall(made: CodemodeHostCall): void {
		if (this.stopped) return;
		// 映射内部模型全局；其他调用原样返回。
		const call = asToolCall(made);
		// 工具调用先建行，脚本等待期间 UI 也能看到 running 状态。
		if (call.target === "tool") this.started(call);
		// 记录 VM 已发出的最大编号；调用 ID 单调递增。
		this.issued = Math.max(this.issued, call.id);
		// 只有重放阶段才查 journal；-1 表示 journal 没有这个调用。
		const index = this.replaying ? (this.replayIndex.get(call.id) ?? -1) : -1;
		if (index === -1) {
			if (this.released) {
				// 已释放：进入等待队列，由 launchCovered 按 durableIssued 启动。
				this.waiting.push(call);
				this.launchCovered();
			} else this.held.push(call);
			return;
		}
		// 非空断言：index 来自有效索引。
		const entry = this.replayed[index]!;
		if (entry.global !== undefined) {
			// 全局调用必须与 journal 记录的目标、函数名和参数完全一致，否则是脚本分叉。
			if (call.target !== "global" || call.name !== entry.global.name || !sameJson(call.args, entry.global.args)) {
				this.diverge(`call ${call.id} is ${describe(call)}, but was a call to ${entry.global.name}`);
				return;
			}
			// 直接复用记录的结果，不重新执行全局函数。
			this.ready.set(call.id, entry.global.outcome as CodemodeOutcome);
			void this.gate.then(() => this.deliverReplayed());
			return;
		}
		// journal 记录的是工具调用；当前若变成全局调用即为分叉。
		if (call.target !== "tool") {
			this.diverge(`call ${call.id} is ${describe(call)}, but was a tool call`);
			return;
		}
		// 工具调用重新执行：executeTool 按 key 重挂到已有任务；是否产生副作用由嵌套工具自身的 replay 策略决定
		// （replay:"safe" 时复用已有结果，不作保证时仍可能重跑）。结果就绪后按顺序交付。
		void this.gate
			.then(() => this.callTool(call))
			.then(
				(outcome) => {
					this.ready.set(call.id, outcome);
					this.deliverReplayed();
				},
				(error: unknown) => {
					if (this.stopped) return;
					// 宿主取消造成的中断按内部失败处理；否则说明同名 key 对应了别的工具/参数，判定分叉。
					if (this.context.abortSignal?.aborted) this.fail(error);
					// The key names another tool or other arguments.
					else this.diverge(`call ${call.id} is ${describe(call)}: ${errorMessage(error)}`);
				},
			);
	}

	/** Replay: deliver journaled results in journal order, each once the VM has issued its call. */
	// 重放交付循环：严格按 journal 顺序，只有 VM 已发出该调用且结果已就绪时才交付；
	// 交付序号 seq 是 1-based 的条目位置，at 使用 journal 记录的 VM 时钟。
	// 遇到未发出/未就绪的条目就停止，等后续 onCall 再触发。
	private deliverReplayed(): void {
		while (this.nextReplayed < this.replayed.length && !this.stopped) {
			const entry = this.replayed[this.nextReplayed]!;
			const outcome = this.ready.get(entry.id);
			// 调用尚未发出，或结果尚未准备好：保持原位等待。
			if (entry.id > this.issued || outcome === undefined) return;
			// 每个结果只交付一次，然后前进到下一个条目。
			this.ready.delete(entry.id);
			this.nextReplayed++;
			this.run.deliver(this.nextReplayed, entry.at, entry.id, outcome);
		}
	}

	// 沙箱回调：VM 已处理完已交付的结果并进入空闲。seq=0 表示首次运行后、任何结果之前；
	// seq>0 表示处理完第 seq 个结果。issued 是此时 VM 已发出的调用数。
	// 重跑时先与 journal 记录的计数比较，不一致即分叉；随后记录确认计数，必要时立即提交；
	// 重放阶段确认完最后一条后切换到实时运行。
	private onIdle(seq: number, issued: number): void {
		if (this.stopped) return;
		// A count an earlier attempt recorded must match; a missing one is recorded now.
		// 只校验重跑且处于 journal 范围内的确认点；首次运行没有历史可比较。
		if (this.rerun && seq <= this.replayed.length) {
			const recorded = seq === 0 ? this.firstIssued : this.replayed[seq - 1]!.issuedAfter;
			if (recorded !== undefined && recorded !== issued) {
				// 记录的调用数不同，说明脚本走了不同路径；错误消息区分首次运行后与某个结果之后。
				this.diverge(
					seq === 0
						? `its first run made ${issued} calls, where it had made ${recorded}`
						: `after result ${seq} it had made ${issued} calls, where it had made ${recorded}`,
				);
				return;
			}
		}
		// 确认计数进入待提交表；pump 会把它与 journal 条目一起提交。
		this.acks.set(seq, issued);
		if (!this.replaying) {
			// A rerun without a journal: every call an earlier attempt could have admitted is made by now.
			// 无 journal 的重跑：首次确认时，早期尝试可能准入的调用都已在 VM 中发出，可以安全释放。
			if (seq === 0 && this.rerun) void this.release();
			// Committed at once when the script has processed everything delivered: calls it made wait for it, and a script
			// waiting on a long call is where a restart usually finds it. Otherwise with the next commit; the VM catches up
			// without waiting on anything.
			// 已处理完所有已交付结果：立即提交，缩小重启丢失确认计数的窗口；
			// 否则等下一次提交，VM 无需等待。
			if (seq === this.journalLength) void this.pump();
			return;
		}
		// Caught up: the VM processed everything delivered and waits.
		// 重放阶段：seq 必须等于已交付数；落后说明还没追上，直接返回。
		if (seq !== this.nextReplayed) return;
		const next = this.replayed[seq];
		if (next !== undefined) {
			// 下一条记录存在但 VM 没有发出对应调用：脚本在等待一个它以前发过的调用，判定分叉。
			if (next.id > issued) this.diverge(`it waits without making call ${next.id}, which it made before`);
			return;
		}
		// The last replayed result is acknowledged: continue live, admitting the calls the journal did not have once their
		// count is committed.
		// 最后一条已确认：退出重放，提交确认计数并释放 journal 中没有的新调用。
		this.replaying = false;
		void this.pump();
		void this.release();
	}

	/**
	 * Let the held calls launch, and later live calls, each once its issued count is committed. On a rerun, an earlier
	 * attempt may have admitted some of them under their keys, as other calls: when the replay releases (idle after the
	 * last journaled result, or after its first run without a journal) its counts matched every recorded one, so it has
	 * made every call an earlier attempt could have admitted. All held calls are checked first, whatever their target,
	 * and a divergence launches none. Calls made after this are new.
	 */
	// 释放持有的调用：等门闩打开后，重跑时先检查每个 key 是否被更早尝试用于别的调用；
	// 有冲突则分叉且一个都不启动。否则标记 released，把持有调用与期间新增的调用一起放入 waiting，
	// 由 launchCovered 按已提交计数启动。之后的调用都视为新路径。
	private async release(): Promise<void> {
		await this.gate;
		if (this.stopped || this.released) return;
		// splice(0) 取出并清空；之后 held 只可能收到释放过程中新到的调用。
		const calls = this.held.splice(0);
		if (this.rerun) {
			for (const call of calls) {
				let other: string | undefined;
				try {
					other = await this.earlier(call);
				} catch (error) {
					// 查询嵌套任务失败：本次调用失败，不启动任何持有调用。
					this.fail(error);
					return;
				}
				if (this.stopped) return;
				if (other !== undefined) {
					// key 已被别的调用占用：脚本路径与早期尝试不同。
					this.diverge(`call ${call.id} is ${describe(call)}, but was ${other}`);
					return;
				}
			}
		}
		this.released = true;
		// 先放已检查的调用，再放检查期间新加入 held 的调用；它们都是首次出现，无需冲突检查。
		this.waiting.push(...calls, ...this.held.splice(0));
		this.launchCovered();
	}

	/** Launch the waiting calls whose issued count is committed. */
	// 启动 id 不超过 durableIssued 的等待调用；其余继续等待下一次计数提交。
	// 先过滤启动列表，再从 waiting 中移除，避免启动过程中修改数组影响遍历。
	private launchCovered(): void {
		if (!this.released || this.stopped) return;
		const covered = this.waiting.filter((call) => call.id <= this.durableIssued);
		if (covered.length === 0) return;
		this.waiting = this.waiting.filter((call) => call.id > this.durableIssued);
		for (const call of covered) this.launch(call);
	}

	/** The call an earlier attempt made under this call's key, when it is another one: another target, tool, or arguments. */
	// 查询更早尝试在 key "c<id>" 下创建过的嵌套任务：
	// - 没有任务：说明该调用从未被准入，可以安全启动；
	// - 任务不是 nested 输入：不是本工具创建的，视为无冲突；
	// - 同名工具且参数 JSON 相等：同一次调用，允许继续；
	// - 否则返回早期调用的描述，供分叉错误使用。
	private async earlier(call: CodemodeHostCall): Promise<string | undefined> {
		const { api, context } = this;
		// snapshot 按 key 找嵌套调用文档；?.taskId 处理不存在的情况。
		const taskId = (await api.snapshot(NestedCallDoc, api.taskId, `c${call.id}`, context))?.taskId;
		if (taskId === undefined) return undefined;
		// getTask 读取任务输入；as ToolTaskInput 只是本地类型视图，随后仍检查 kind。
		const input = (await api.getTask(taskId, context))?.input as ToolTaskInput | undefined;
		if (input?.kind !== "nested") return undefined;
		const made = input.call;
		// 参数缺省视为 {}，与工具调用规范化后的参数比较；key 顺序不影响 sameJson。
		if (call.target === "tool" && made.name === call.name && sameJson(made.arguments, call.args ?? {}))
			return undefined;
		return `tools.${made.name}(${JSON.stringify(made.arguments)})`;
	}

	/** Run one live call and journal its result. */
	// 启动一个实时调用：工具调用走 callTool，全局调用走 callGlobal 并把参数/结果一并记入 journal。
	// 完成后放入 queue，由 pump 提交后再交付给 VM；失败时按是否宿主取消区分为 fail 或分叉。
	private launch(call: CodemodeHostCall): void {
		if (this.stopped) return;
		// 联合类型：工具调用只需 outcome；全局调用还需要 global 字段，重放时据此复用结果。
		const running: Promise<{ outcome: CodemodeOutcome; global?: JournalEntry["global"] }> =
			call.target === "tool"
				? this.callTool(call).then((outcome) => ({ outcome }))
				: this.callGlobal(call).then((outcome) => ({
						outcome,
						global: {
							name: call.name,
							...(call.args === undefined ? {} : { args: call.args as JsonValue }),
							outcome: outcome as JsonObject,
						},
					}));
		running.then(
			(done) => {
				// A result after the outcome is decided has nowhere to go, and the call's API has ended.
				// 已结束：结果无处交付，直接丢弃。
				if (this.stopped) return;
				// 记录完成时刻（VM 时钟）与结果；pump 负责与确认计数一起提交。
				this.queue.push({ id: call.id, at: this.api.now(), ...done });
				void this.pump();
			},
			(error: unknown) => {
				// Stopped meanwhile: the outcome is decided, or a waiting model call gave up.
				if (this.stopped) return;
				// 宿主取消导致的中断：内部失败；其他错误说明 key 被别的调用占用或执行环境异常，判定分叉。
				if (this.context.abortSignal?.aborted) this.fail(error);
				// A key an earlier attempt admitted with another tool or other arguments: this attempt took another path.
				else this.diverge(`call ${call.id} is ${describe(call)}: ${errorMessage(error)}`);
			},
		);
	}

	// 执行一次嵌套工具调用：参数按脚本原样传递（非对象由工具校验报告）；内部模型工具受并发名额限制。
	// executeTool 的 key 为 "c<id>"，重跑时同 key 会重新挂到已有任务，由嵌套工具自己的 replay 策略决定是否重跑。
	// 返回脚本可见的 outcome，并更新 details 行与图片计数。
	private async callTool(call: CodemodeHostCall): Promise<CodemodeOutcome> {
		// Passed as the script gave them; validation reports arguments that are not an object.
		// args 缺省为 {}；as JsonObject 只是类型视图，运行时参数仍来自 VM（信任边界由工具 schema 校验）。
		const args = (call.args ?? {}) as JsonObject;
		// 内部工具（classify/generateImages）是付费调用，需要遵守并发上限。
		const model = call.name.startsWith(CODEMODE_INTERNAL_PREFIX);
		if (model) {
			await this.modelSlot();
			// The call may have stopped while this one waited: a finished script admits no new paid call.
			// 等待名额期间脚本可能已结束：不启动新的付费调用，并归还未占用的名额。
			if (this.stopped) {
				this.releaseModelSlot();
				throw new Error("The script has ended");
			}
		}
		let result: NestedToolExecutionResult;
		try {
			// 真正的工具执行：嵌套任务、实时行、取消、用量、重放策略都由 Harness 处理。
			result = await this.api.executeTool(call.name, args, this.context, { key: `c${call.id}` });
		} finally {
			// 无论成功失败都释放模型名额，避免死锁。
			if (model) this.releaseModelSlot();
		}
		// generateImages 返回的图片数量累加，用于最终“未展示图片”提示。
		if (call.name === GENERATE_IMAGES_TOOL) this.generatedImages += countImages(result.structuredOutput);
		// 工具声明来自 start 快照：重放时使用与首次运行相同的 structured 判定。
		const structured = this.start.tools.find((tool) => tool.name === call.name)?.structured === true;
		const outcome = outcomeOf(call.name, structured, result);
		this.finishRow(call.id, outcome, result);
		return outcome;
	}

	/** The script made a tool call: its row appears, running, also while it waits to launch. */
	// 登记一次工具调用的展示行；同一 id 只登记一次。内部工具名去掉前缀后展示，避免暴露保留名。
	// args 压缩成 JSON 并截断；参数可能很大，因此不保留原引用。
	private started(call: CodemodeHostCall): void {
		if (this.rows.has(call.id)) return;
		const args = call.args === undefined ? "" : (JSON.stringify(call.args) ?? "");
		const name = call.name.startsWith(CODEMODE_INTERNAL_PREFIX)
			? call.name.slice(CODEMODE_INTERNAL_PREFIX.length)
			: call.name;
		this.rows.set(call.id, { id: call.id, name, args: cut(args, ARGS_PREVIEW_CHARS), status: "running" });
	}

	/** A tool call ended: its row gets its status, duration, and error. */
	/** The call ended: an error result is an error row, also when the script got its value (bash's nonzero exit). */
	// 结束一行：状态由 isError 决定（即使脚本拿到了值，如 bash 非零退出也标 error）；
	// 记录耗时；错误文本优先用 outcome.message，其次 error 级诊断，最后只在 error 行显示。
	private finishRow(id: number, outcome: CodemodeOutcome, result: NestedToolExecutionResult): void {
		const row = this.rows.get(id);
		if (row === undefined) return;
		row.status = result.isError ? "error" : "ok";
		if (result.durationMs !== undefined) row.durationMs = result.durationMs;
		const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
		const error = !outcome.ok ? outcome.message : errors.map((diagnostic) => diagnostic.message).join("\n");
		if (result.isError && error !== "") row.error = cut(error, ERROR_PREVIEW_CHARS);
	}

	/** The rows in call order; calls still running when the script ended were cancelled. */
	// 生成 details：按调用 id 排序；脚本结束时仍在 running 的调用实际已被取消，复制成 cancelled 行。
	// 返回新数组，调用方可安全持有。
	private details(): CodemodeToolDetails {
		const calls = [...this.rows.values()]
			.sort((a, b) => a.id - b.id)
			.map((row) => (row.status === "running" ? { ...row, status: "cancelled" as const } : row));
		return { calls };
	}

	// 执行一个全局函数调用：发现函数由 start 数据回答，目录函数走 catalogCall，其余查找宿主扩展的 globals。
	// 未知名称返回失败 outcome（不会抛给沙箱）；执行异常在非宿主取消时也转成失败 outcome。
	// 返回值原样保留 undefined：journal 会省略该字段，重放时同样得到 undefined。
	private async callGlobal(call: CodemodeHostCall): Promise<CodemodeOutcome> {
		// 用 as readonly string[] 让 tuple 的 includes 接受任意字符串；这是类型层面的放宽，运行时仍精确比较。
		const discovery = (DISCOVERY_GLOBALS as readonly string[]).includes(call.name);
		const catalog = (CATALOG_GLOBALS as readonly string[]).includes(call.name);
		// 发现/目录函数是内置的；其他名字才去宿主扩展中查找。
		const global =
			discovery || catalog ? undefined : this.options.globals?.find((candidate) => candidate.name === call.name);
		if (!discovery && !catalog && global === undefined) return { ok: false, message: `Unknown global ${call.name}` };
		try {
			// `undefined` stays undefined: the journal omits the value, and a replay resolves with undefined again.
			// 三元表达式按发现 → 目录 → 宿主扩展分派；! 断言 global 在非前两类时一定存在。
			const value = discovery
				? this.discover(call)
				: catalog
					? await catalogCall(call.name, call.args, this.api.models, this.context)
					: await global!.execute(call.args, this.api, this.context);
			return { ok: true, value };
		} catch (error) {
			// 宿主取消需要让整个调用中止，而不是变成脚本可捕获的失败。
			if (this.context.abortSignal?.aborted) throw error;
			return { ok: false, message: errorMessage(error) };
		}
	}

	// 模型调用并发闸门：达到上限时排队等待，被唤醒后才占用名额。
	// 这是 VM 内的逻辑，和 Harness 的嵌套任务并发限制相互独立。
	private async modelSlot(): Promise<void> {
		if (this.modelCalls >= MAX_CONCURRENT_MODEL_CALLS) {
			await new Promise<void>((resolve) => this.modelWaiters.push(resolve));
		}
		this.modelCalls++;
	}

	// 释放一个模型名额并唤醒最早的等待者；shift 为空时可选调用不做事。
	private releaseModelSlot(): void {
		this.modelCalls--;
		this.modelWaiters.shift()?.();
	}

	/** `searchTools()`, `describeTool()`, `describeNamespace()`: answered from the start data. */
	// 三个发现函数都只读 start 快照，因此重放结果稳定：
	// - describeTool(name)：按注册名或 jsName 返回工具样例（undefined 表示不存在）；
	// - describeNamespace(name)：返回命名空间描述，工具名转成脚本标识符；
	// - searchTools(query, {limit, namespace})：用 BM25 在工具样例 + 命名空间文本上排序，返回 jsName 与描述。
	// 参数来自 VM（unknown），因此这里的 typeof/Array.isArray 检查是真实信任边界；非法参数抛错，由 callGlobal 转成失败。
	private discover(call: CodemodeHostCall): JsonValue | undefined {
		// 非数组参数按空列表处理；后续必要参数检查会给出具体错误。
		const args = Array.isArray(call.args) ? call.args : [];
		const { namespaces } = this.start;
		// hidden 内部工具不出现在发现结果中。
		const tools = this.start.tools.filter((tool) => tool.hidden !== true);
		const namespaceOfTool = (name: string) => namespaces.find((namespace) => namespace.tools.includes(name));
		// 命名空间名允许原始名或转换后的标识符匹配。
		const matchesNamespace = (namespace: Start["namespaces"][number], query: string) =>
			namespace.name === query || toCodemodeIdentifier(namespace.name) === toCodemodeIdentifier(query);
		if (call.name === "describeTool") {
			const [name] = args;
			if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
			// description 是 sampleOf 生成的“说明 + 声明”；找不到时返回 undefined。
			return tools.find((tool) => tool.name === name || tool.jsName === name)?.description;
		}
		if (call.name === "describeNamespace") {
			const [name] = args;
			if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
			const namespace = namespaces.find((candidate) => matchesNamespace(candidate, name));
			if (namespace === undefined) return undefined;
			// 可选字段条件展开；tools 一律转成脚本可调用的标识符。
			return {
				name: namespace.name,
				...(namespace.description === undefined ? {} : { description: namespace.description }),
				...(namespace.instructions === undefined ? {} : { instructions: namespace.instructions }),
				tools: namespace.tools.map((tool) => toCodemodeIdentifier(tool)),
			};
		}
		// 以下为 searchTools；解构只取前两个参数，多余参数忽略。
		const [query, options] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
		if (typeof query !== "string") throw new Error("searchTools() expects a query string");
		// limit 缺省用默认值；必须是正整数。
		const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
		if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
			throw new Error("searchTools() limit must be a positive integer");
		}
		const namespace = options?.namespace;
		// namespace 可省略或为 null；提供时必须是字符串。
		if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
			throw new Error("searchTools() namespace must be a string");
		}
		// 构造检索文档：name 用于返回，text 是工具样例，namespaceText 把命名空间信息也纳入评分。
		const documents = tools.flatMap((tool) => {
			const own = namespaceOfTool(tool.name);
			// 指定 namespace 时过滤掉不属于它的工具；无命名空间的工具也被排除。
			if (typeof namespace === "string" && (own === undefined || !matchesNamespace(own, namespace))) return [];
			const namespaceText =
				own === undefined ? "" : [own.name, own.description ?? "", own.instructions ?? ""].join(" ");
			// `description` is the tool's sample: its description and declaration, with the parameters' names and descriptions.
			return [{ name: tool.name, text: tool.description, namespaceText }];
		});
		// rankDocuments 返回按相关性排序的注册名；再映射回脚本可见的 jsName 与描述。
		return rankDocuments(query, documents, limit).map((name) => {
			// 非空断言：rankDocuments 只会返回传入文档中的 name。
			const tool = tools.find((candidate) => candidate.name === name)!;
			return { name: tool.jsName, description: tool.description };
		});
	}

	/**
	 * Journal finished calls and acknowledged counts in one commit, then deliver the calls and launch the calls the
	 * counts cover; one commit in flight at a time, so what arrives meanwhile goes into the next.
	 */
	// 提交循环：同一时刻只允许一个 commit 在飞，期间新到的结果/确认进入下一批。
	// 一个事务内先写确认计数（firstIssued/issuedAfter），再按完成顺序追加 journal 条目；
	// 提交成功后才更新 durableIssued、交付结果并启动被覆盖的调用；最后再调用一次自身处理残留。
	private async pump(): Promise<void> {
		if (this.committing || this.stopped) return;
		// 没有结果也没有待写确认：无事可做。
		if (this.queue.length === 0 && this.acks.size === 0) return;
		this.committing = true;
		// splice(0) 取走当前批次并清空队列；acks 快照后立即清空，保证后续到达进入下一批。
		const batch = this.queue.splice(0);
		const acks = [...this.acks];
		this.acks.clear();
		try {
			await this.api.commit(async (tx) => {
				const journal = await tx.doc(CodemodeJournalDoc, this.api.taskId);
				for (const [seq, issued] of acks) {
					// seq=0 是首次运行后的计数；??= 保留更早写入的值。
					if (seq === 0) journal.firstIssued ??= issued;
					else {
						// seq 是 1-based 结果序号，对应 entries[seq-1]；已有确认时不覆盖。
						const entry = journal.entries[seq - 1];
						if (entry !== undefined && entry.issuedAfter === undefined) entry.issuedAfter = issued;
					}
				}
				for (const item of batch) {
					// 工具结果本身在 NestedCallDoc 中，journal 只存 id/at；全局调用额外存 global（参数+结果）。
					const entry = {
						id: item.id,
						at: item.at,
						...(item.global === undefined ? {} : { global: item.global }),
					};
					// 深拷贝为 JSON，防止后续修改内存对象影响已提交数据。
					journal.entries.push(
						copyJson(entry as unknown as JsonValue, { omitUndefinedProperties: true }) as unknown as JournalEntry,
					);
				}
			}, this.context);
		} catch (error) {
			// 提交失败是内部致命错误；保持 committing 为 true 不再尝试，由 fail 中止整个调用。
			this.fail(error);
			return;
		}
		// 只有提交成功，计数才算 durable：之后启动的调用不会产生“未记录”的 key。
		for (const [, issued] of acks) this.durableIssued = Math.max(this.durableIssued, issued);
		for (const item of batch) {
			// journalLength 是本条目的 1-based 序号；VM 已结束则无需交付。
			this.journalLength++;
			if (!this.run.finished) this.run.deliver(this.journalLength, item.at, item.id, item.outcome);
		}
		// 计数推进后，启动等待队列中被覆盖的调用。
		this.launchCovered();
		this.committing = false;
		// 处理提交期间新到的结果/确认（尾递归式，不阻塞当前调用栈）。
		void this.pump();
	}
}

/** A script's call of `models.classify()` or `models.generateImages()` as the call of its internal tool. */
// 把脚本的模型全局调用映射成内部工具调用：只有 target=global 且在 MODEL_CALLS 中才转换。
// 参数按位置 [model, context] 取出，缺省用 null，使内部工具参数始终是对象；其他调用原样返回。
function asToolCall(call: CodemodeHostCall): CodemodeHostCall {
	const tool = call.target === "global" ? MODEL_CALLS[call.name] : undefined;
	if (tool === undefined) return call;
	const [model, context] = Array.isArray(call.args) ? call.args : [];
	return { id: call.id, target: "tool", name: tool, args: { model: model ?? null, context: context ?? null } };
}

/** Image blocks in a `models.generateImages()` result. */
// 统计 generateImages 结果中的图片块数量；值来自 VM/模型结果，因此做对象与数组检查。
// 没有 output 或形状不符时返回 0。
function countImages(value: unknown): number {
	const output = typeof value === "object" && value !== null ? (value as { output?: unknown }).output : undefined;
	return Array.isArray(output) ? output.filter((item) => (item as { type?: unknown })?.type === "image").length : 0;
}

// 生成调用的可读描述，用于分叉错误：工具调用加 "tools." 前缀，全局调用不加。
// JSON.stringify 对 undefined 返回 undefined，?? "" 避免出现 "undefined" 文本。
function describe(call: CodemodeHostCall): string {
	return `${call.target === "tool" ? "tools." : ""}${call.name}(${JSON.stringify(call.args) ?? ""})`;
}

/** Structural JSON equality; key order does not matter. */
// 结构化 JSON 相等：先处理原始值/同一引用，再区分数组（逐项递归）与对象（键集合相同且逐键递归）。
// 键顺序无关；Object.hasOwn 避免把原型链属性当作自有键。仅用于重放校验，不修改输入。
function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	// 任一不是非空对象（包括 null）就不相等；typeof null === "object" 因此要单独排除。
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		// 只有两边都是数组、长度相同且逐项相等才成立。
		return (
			Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]))
		);
	}
	const keys = Object.keys(a);
	// 键数量相同且 b 含每个自有键、对应值递归相等。
	return (
		keys.length === Object.keys(b).length &&
		keys.every(
			(key) =>
				Object.hasOwn(b, key) && sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
		)
	);
}
