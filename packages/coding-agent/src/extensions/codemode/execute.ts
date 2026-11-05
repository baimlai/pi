/**
 * Runs one codemode script in the sandbox. Split from tool.ts and loaded through
 * execute.lazy.ts so the sandbox runtime only loads when a script runs.
 */

// 一次codemode脚本的宿主执行层，上游tool.ts通过lazy导入本文件。它准备获准工具/辅助函数、排worker名额、运行QuickJS，再组装模型可见输出。
// 例：脚本await tools.read(...)，调用跨沙箱JSON边界回宿主ctx.executeTool，仍走原验证/扩展钩子/权限流程；脚本没有直接Node能力。
// 脚本失败会保留已有输出，已经执行的外部副作用不回滚；只有成功结果的store写入才尝试交宿主持久化。
import type { AgentTool, AgentToolCallOutcome, AgentToolResult } from "@earendil-works/pi-agent-core";
// 只导入模型/内容/用量的TS结构，不在这里创建某个供应商SDK。
import type {
	AnyModel,
	ClassifierContext,
	ImageContent,
	ImagesContext,
	ModelType,
	ModelTypeMap,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai";
// 运行时需要的沙箱、WASM加载、源码选项解析和声明渲染；type项仅用于编译检查。
import {
	type CodemodeOutputItem,
	type CodemodeResult,
	CodemodeSandbox,
	type CodemodeTool,
	loadQuickJSWasm,
	parseCodemodeSource,
	renderToolSample,
	toCodemodeIdentifier,
} from "@earendil-works/pi-codemode";
// worker和WASM资产统一通过config解析，适配源码/npm/打包二进制。
import { getCodemodeWorkerSpecifier, getQuickJSWasmPath } from "../../config.ts";
// 上下文提供会话工具管线、分支记录和模型注册表；没有ctx仍能算纯JS，但不能调用会话工具。
import type { ExtensionToolContext, ToolNamespace } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
// 格式化临时图片大小、合并用量、写输出文件各复用专职helper。
import { formatSize } from "../../core/tools/truncate.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { writeOutputFile } from "../../utils/output-files.ts";
// 搜索辅助复用本地BM25排名器，不会因为searchTools就调用模型。
import { Bm25Ranker, createToolSearchDocument, DEFAULT_TOOL_SEARCH_LIMIT } from "../tool-search/tool.ts";
// 与声明入口共享store条目类型、目录/类型/工具筛选规则；模块循环中的值在函数执行时才使用。
import {
	CODEMODE_DOCS_PATH,
	CODEMODE_STORE_ENTRY_TYPE,
	type CodemodeModelRuntime,
	type CodemodeNestedCall,
	type CodemodeStoreEntryData,
	type CodemodeToolDetails,
	type CodemodeToolInput,
	type CodemodeToolOptions,
	getCodemodeCallableTools,
	toCodemodeDeclaration,
} from "./tool.ts";

// 参数UI预览最多200个UTF-16代码单元，错误预览500；这些不是token/终端列数上限。
const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;
/** `models.classify()` and `models.generateImages()` calls one script may have in flight; `Promise.all` over many items queues the rest. */
// 每次脚本内models分类/生图共用4并发限额，不约束普通嵌套工具的并发数，也不是整个进程最多4次模型调用。
const MAX_CONCURRENT_MODEL_CALLS = 4;
/**
 * Heap limit for the QuickJS VM. The worker shares pi's process, so without a limit a runaway
 * script can grow to wasm32's 4 GiB and take the session down. Overruns throw
 * `InternalError: out of memory` inside the script.
 */
// QuickJS堆限256MiB，和Node宿主/worker整体内存不同；限制不代表进程所有内存合计<=256MiB。
const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
// Shared across calls and sessions. Allow one replacement while a cancelled worker is still exiting.
// 进程内默认最多2个仍被计数的worker，跨会话共用；取消结果落定后，线程未真实退出时仍占名额。
const DEFAULT_MAX_CODEMODE_WORKERS = 2;

/** `PI_CODEMODE_MAX_WORKERS` if it is a positive integer. Read per call so SDK hosts can set it at runtime. */
// 读取当前环境的正整数上限；每次准入循环可重新读，运行中降低上限不会主动杀掉已运行worker。
function maxCodemodeWorkers(): number {
	// Number会转换字符串，未设置为NaN，空白为0；下行统一判有效。
	const value = Number(process.env.PI_CODEMODE_MAX_WORKERS);
	// 只要求整数且>0，未额外要求safe integer；不符合则默认2。
	return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_CODEMODE_WORKERS;
}
/**
 * How long a script waits for a free worker before failing. Bounds the wait when every worker is
 * held by a script that waits on another script, for example an in-process subagent that uses codemode.
 */
// 最多等空位60秒，显式更短脚本时限还会进一步收紧等待；不是所有脚本默认60秒执行超时。
const CODEMODE_WORKER_WAIT_MS = 60_000;
// 模块级活跃名额计数，其他会话也共享；代表预约/在途worker生命周期，不等于当前正在执行工具的数量。
let activeCodemodeWorkers = 0;
/** Scripts waiting for a worker, in arrival order. */
// FIFO等待回调数组，队首先得到空位；函数类型() => void只表示通知动作。
const codemodeWorkerWaiters: (() => void)[] = [];

/**
 * Reserve one worker slot, waiting in arrival order while all are taken. Resolves with why it could
 * not reserve one: the signal aborted, or `timeoutMs` passed.
 */
// 排队预约一个worker名额：先取消就aborted，否则入队并竞争空位/取消/定时器，返回标签字符串供调用方分支。
function reserveCodemodeWorker(
	// 参数必须给出但可为undefined，不等于可省略的?形参。
	signal: AbortSignal | undefined,
	// 本次等名额的毫秒时限，调用者取脚本预算与60秒的较小者。
	timeoutMs: number,
): Promise<"reserved" | "aborted" | "timeout"> {
	// 已取消立即返回已完成Promise，不建timer、不占空位。
	if (signal?.aborted) return Promise.resolve("aborted");
	// executor同步执行，回调闭包稍后才由名额/取消/timer触发。
	return new Promise((resolve) => {
		// 统一落定函数负责清timer、卸监听并从队列移除；Promise自身只落定一次，但这里没另设settled布尔锁。
		const settle = (outcome: "reserved" | "aborted" | "timeout") => {
			// 成功准入也清等待timer，避免之后又尝试超时。
			clearTimeout(timer);
			// 可选信号才移监听。
			signal?.removeEventListener("abort", onAbort);
			// 找到本次grant回调的位置，不按脚本ID查。
			const index = codemodeWorkerWaiters.indexOf(grant);
			// 仍在队列时删掉；已经被shift准入的回调找不到，不误删别项。
			if (index >= 0) codemodeWorkerWaiters.splice(index, 1);
			// 返回reserved/aborted/timeout三种结果之一，不抛通用异常。
			resolve(outcome);
		};
		// 准入回调只标reserved，计数由admit在调用它前增加。
		const grant = () => settle("reserved");
		// 取消回调只标aborted，尚未准入就不需要归还计数。
		const onAbort = () => settle("aborted");
		// 等位timer，不是脚本VM的执行timer。
		const timer = setTimeout(() => settle("timeout"), timeoutMs);
		// 入队，即使当下有空位也统一经过FIFO逻辑。
		codemodeWorkerWaiters.push(grant);
		// once在abort后自动卸掉，本次正常落定也显式卸。
		signal?.addEventListener("abort", onAbort, { once: true });
		// 入队后立即尝试发空位，无须等下一次release。
		admitCodemodeWorkers();
	});
}

/** Give free slots to waiting scripts in arrival order. */
// 按FIFO发可用名额，不启动VM；调用后续流程才创建沙箱和worker。
function admitCodemodeWorkers(): void {
	// 有等待且计数低于当前环境配置才继续。
	while (codemodeWorkerWaiters.length > 0 && activeCodemodeWorkers < maxCodemodeWorkers()) {
		// 先占名额，避免同步通知引发重入时超发。
		activeCodemodeWorkers++;
		// 取队首并调用；?.处理数组可能已空的类型，按正常while条件这里有项。
		codemodeWorkerWaiters.shift()?.();
	}
}

// 归还一份已预约名额并尝试准入下一项；调用方必须保证只还一次，函数不自行检查负数/重复释放。
function releaseCodemodeWorker(): void {
	// 计数减1，不直接终止任何worker。
	activeCodemodeWorkers--;
	// 释放后立即唤醒队列。
	admitCodemodeWorkers();
}
// 脚本可查询的三种模型类型；运行时Set配合unknown输入检查，ReadonlySet只是TS视图。
const MODEL_TYPES: ReadonlySet<string> = new Set<ModelType>(["chat", "image", "classifier"]);

// 截显示预览的头部，超过时加三点；length/slice按UTF-16代码单元，可能切半代理对，不是按字素/字节安全截断。
function truncateText(text: string, maxChars: number): string {
	// 预算含三个点；这里的调用上限200/500，没额外处理maxChars<3等通用情况。
	return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

// 把未知参数做紧凑JSON预览，最多200码元；序列化失败返回空串，UI预览缺失不阻止真实工具参数继续执行。
function previewArgs(args: unknown): string {
	// 没传参数不显示undefined文字。
	if (args === undefined) return "";
	try {
		// JSON没有结果用空串，再裁UI预览；不会保存完整参数文件。
		return truncateText(JSON.stringify(args) ?? "", ARGS_PREVIEW_CHARS);
	} catch {
		// 循环引用/BigInt等预览失败统一空串。
		return "";
	}
}

// 只提取工具结果的text块并按LF合并，图片/结构化内容不包含；用于没有结构化输出时的脚本值和错误文字。
function textOf(result: AgentToolResult<unknown>): string {
	// content空缺可退空数组，这不是把非法content各种形状都修成正确数组。
	return (
		(result.content ?? [])
			// 类型谓词过滤后，后续map可直接访问text。
			.filter((block): block is TextContent => block.type === "text")
			// 取各文本原文。
			.map((block) => block.text)
			// 即使相邻文字本身有LF也会再加分隔，不做trim。
			.join("\n")
	);
}

// 脚本JSON边界检查模型类别，只接受chat/image/classifier；错值报明确提示，不自动猜类别。
function toModelType(value: unknown): ModelType {
	// 先typeof收窄，再Set成员检查，as把通过的字符串与联合类型关联。
	if (typeof value === "string" && MODEL_TYPES.has(value)) return value as ModelType;
	// JSON.stringify用于报错，异常值若本身不可序列化也可能在生成提示时抛别的错。
	throw new Error(`Unknown model type ${JSON.stringify(value)}. Use "chat", "image", or "classifier".`);
}

// 可选provider筛选值：null/undefined视为未给，其他必须字符串；空串不在这里trim/拒绝。
function toProvider(value: unknown): string | undefined {
	// 显式null也退无筛选。
	if (value === undefined || value === null) return undefined;
	// unknown边界检查，不把数字自动String化成提供商名称。
	if (typeof value !== "string") throw new Error("provider must be a string");
	// 合法字符串原样交注册表。
	return value;
}

/** Catalog entry for scripts. `headers` is dropped because models.json headers can carry credentials. */
// 给脚本返回目录信息的浅拷贝，只删顶层headers以免泄露配置头；不是通用递归脱敏器，其他字段照原定义返回。
function toModelInfo(model: AnyModel): Record<string, unknown> {
	// 对象展开复制自有可枚举顶层字段，嵌套对象不深复制。
	const info: Record<string, unknown> = { ...model };
	// 只删除副本的headers，不改原模型对象。
	delete info.headers;
	// 返回纯数据视图，跨VM还会经历JSON转换。
	return info;
}

/** `an image`, `a classifier`. */
// 仅按首个小写元音字母决定a/an，服务于image/classifier等固定词；不是通用英语语音规则。
function withArticle(word: string): string {
	// 正则只认开头字符，未开i；模板拼显示文字。
	return `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
}

/** A JSON value from a script, read field by field: values that are not objects have no fields. */
// 为跨沙箱JSON值逐字段读取而写的局部断言类型；不保证输入已是对象，实际字段需要在边界检查，readonly不冻结原值。
type ScriptValue = { readonly [key: string]: unknown } | null | undefined;

/** A script value in an error message: `undefined`, `a string`, `an array`, or its keys (`{ prompt }`). */
// 生成简洁形状提示而非输出完整数据。例{prompt:"敏感内容"}只列键{ prompt }，但键名仍原样显示，不是完整脱敏承诺。
function describeValue(value: unknown): string {
	// null/undefined直接写名字。
	if (value === undefined || value === null) return String(value);
	// 数组只区分是否空，不列里面的内容。
	if (Array.isArray(value)) return value.length === 0 ? "an empty array" : "an array";
	// 对象分支列键。
	if (typeof value === "object") {
		// 只枚举自有可枚举字符串键。
		const keys = Object.keys(value);
		// 没有键显示{}。
		if (keys.length === 0) return "{}";
		// 最多6个键，更多加省略标记。
		return `{ ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", ..." : ""} }`;
	}
	// 其他值只报typeof类别；字符串不回显正文。
	return typeof value === "string" ? "a string" : `a ${typeof value}`;
}

// 分类上下文的错误提示示例；真正检查函数只核有限形状，不是把这串schema执行起来。
const CLASSIFIER_CONTEXT_SHAPE =
	'{ state: { ... }, images?: [{ type: "image", data: <base64>, mimeType }], questions: { <id>: { type: "choice", instructions, criteria: { <label>: <meaning> } } | { type: "score", instructions, criteria: [<lowest level>, ..., <highest level>] } | { type: "bool", instructions, criteria: { true: <meaning>, false: <meaning> } } } }';

/** Check a script's classifier context, so mistakes fail with the expected shape instead of a provider error. */
// 检查脚本传来的分类上下文，提前给清楚报错：根/state对象、可选图像数组、非空questions及各题type。不会验证图片字节、权限或所有业务约束。
function checkClassifierContext(context: unknown): ClassifierContext {
	// 局部fail只构造Error，不直接throw；下面分支决定何时报错。
	const fail = (problem: string) =>
		new Error(
			// 提示含形状与本地参考文档路径，不发模型请求。
			`models.classify() ${problem}. Expected context: ${CLASSIFIER_CONTEXT_SHAPE}. See "Classify" in ${CODEMODE_DOCS_PATH}.`,
		);
	// 未知根值必须非null非数组对象。
	if (typeof context !== "object" || context === null || Array.isArray(context)) {
		// 错误含收到的形状描述。
		throw fail(`expects a context object as its second argument, got ${describeValue(context)}`);
	}
	// 检查根后解构字段，内部仍是unknown，不能因这个断言直接信任。
	const { state, images, questions } = context as Record<string, unknown>;
	// state同样要求对象，但允许空对象，不验证具体业务字段。
	if (typeof state !== "object" || state === null || Array.isArray(state)) {
		// 指出state位置而非笼统说参数错。
		throw fail(`context.state must be an object, got ${describeValue(state)}`);
	}
	// images可省略；给了null也会因非数组而拒绝。
	if (images !== undefined) {
		// 必须数组，但空数组允许。
		if (!Array.isArray(images)) throw fail(`context.images must be an array, got ${describeValue(images)}`);
		// ScriptValue只为属性访问提供类型，数组元素仍通过下行判断。
		images.forEach((image: ScriptValue, index) => {
			// 每项必须标记image且data/mimeType字符串；没有base64解码/尺寸/MIME白名单完整校验。
			if (image?.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") {
				// 错误带具体数组下标。
				throw fail(`context.images[${index}] must be an image block, got ${describeValue(image)}`);
			}
		});
	}
	// questions要求非空对象，组合条件逐项短路，避免对null取keys。
	if (
		typeof questions !== "object" ||
		questions === null ||
		Array.isArray(questions) ||
		Object.keys(questions).length === 0
	) {
		// 没有可回答题目就明确拒绝。
		throw fail(`context.questions must map question IDs to questions, got ${describeValue(questions)}`);
	}
	// 内部检查“非空且每项为字符串”，字符串自身可为空；不查选项数量最小2等更强规则。
	const isStrings = (values: unknown[]) => values.length > 0 && values.every((value) => typeof value === "string");
	// 每个题ID对应一份题目对象，Object.entries按自有字段遍历。
	for (const [id, question] of Object.entries(questions)) {
		// 构造题目位置用于可读报错。
		const at = `context.questions.${id}`;
		// 每题必须非null非数组对象。
		if (typeof question !== "object" || question === null || Array.isArray(question)) {
			// 题目形状不对直接拒绝。
			throw fail(`${at} must be a question object, got ${describeValue(question)}`);
		}
		// 取类型、指令与准则，仍需分别检查。
		const { type, instructions, criteria } = question as Record<string, unknown>;
		// instructions必须字符串，可为空；没有检查长度/语义。
		if (typeof instructions !== "string") throw fail(`${at}.instructions must be a string`);
		// choice的criteria为标签→含义对象。
		if (type === "choice") {
			if (
				// criteria必须对象，null和数组不接受。
				typeof criteria !== "object" ||
				criteria === null ||
				Array.isArray(criteria) ||
				// 所有值必须字符串且至少一项；键名在这里没额外白名单。
				!isStrings(Object.values(criteria))
			) {
				// 说明选择题需键值映射。
				throw fail(`${at} is a "choice" question, so criteria must map each label to its meaning`);
			}
			// score的criteria是低到高的字符串数组。
		} else if (type === "score") {
			// 这里只验非空字符串数组，不证明顺序真的由低到高。
			if (!Array.isArray(criteria) || !isStrings(criteria)) {
				// 错误提示给出预期形状。
				throw fail(`${at} is a "score" question, so criteria must list the levels as strings, lowest first`);
			}
			// bool要求true/false两个标签的说明文字。
		} else if (type === "bool") {
			// 断言不验证criteria本身是否普通对象。
			const labels = criteria as ScriptValue;
			// 按字段检查两项字符串，不强制只有这两个键或排除其他承载这些字段的值。
			if (typeof labels?.true !== "string" || typeof labels.false !== "string") {
				// 布尔题准则错误。
				throw fail(`${at} is a "bool" question, so criteria must be { true: string, false: string }`);
			}
		} else {
			// 不认识题type直接拒绝，JSON文字用于显示收到的值。
			throw fail(`${at}.type must be "choice", "score", or "bool", got ${JSON.stringify(type)}`);
		}
	}
	// 有限检查通过后对接ClassifierContext类型；不是对全部结构做JSON Schema验证。
	return context as unknown as ClassifierContext;
}

/** Check a script's image context, so mistakes such as `{ prompt }` fail with the expected shape. */
// 检查生图上下文的{input:[text/image]}形状，例只传{prompt:"猫"}会报期待input块数组；不验证图片编码或模型能力。
function checkImagesContext(context: unknown): ImagesContext {
	// 局部错误构造器复用文档路径与形状提示。
	const fail = (problem: string) =>
		new Error(
			`models.generateImages() ${problem}. Expected context: { input: [{ type: "text", text: <prompt> }, ...optional { type: "image", data: <base64>, mimeType } references] }. See "Generate images" in ${CODEMODE_DOCS_PATH}.`,
		);
	// 根值必须非null非数组对象。
	if (typeof context !== "object" || context === null || Array.isArray(context)) {
		// 根形状错即报错。
		throw fail(`expects a context object as its second argument, got ${describeValue(context)}`);
	}
	// 取input仍为unknown。
	const { input } = context as Record<string, unknown>;
	// input必须非空数组。
	if (!Array.isArray(input) || input.length === 0) {
		// 说明空数组/缺数组问题。
		throw fail(`context.input must be a non-empty array of blocks, got ${describeValue(input)}`);
	}
	// 逐项检查，只核有限type/字符串字段。
	input.forEach((block: ScriptValue, index) => {
		// text标记+字符串text通过，空字符串没有另拒绝。
		if (block?.type === "text" && typeof block.text === "string") return;
		// image标记+字符串data/mimeType通过，不解码验证。
		if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") return;
		// 其他条目带下标报错。
		throw fail(`context.input[${index}] must be a text or image block, got ${describeValue(block)}`);
	});
	// 通过边界检查后断言成ImagesContext，不转换成另一份内容。
	return context as unknown as ImagesContext;
}

/** The fields of `ClassifierResult` and `AssistantImages` that a nested call row reports. */
// 分类/生图共同报告字段；模型结果其余字段通过泛型TResult原样保留。
interface ModelCallResult {
	// 终态是成功/错误/取消，和工具预览status的词不同。
	stopReason: "stop" | "error" | "aborted";
	// 可选错误文字。
	errorMessage?: string;
	// 可选用量，返回时汇总为codemode额外usage。
	usage?: Usage;
}

/** Runs at most `limit` calls at once, in call order. */
// 创建本脚本的并发限制器：名额满就FIFO等，run结束无论成败都唤醒一项；不自己监听取消，等待者以后仍会调用run，由run遵守信号。
function createLimiter(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
	// 局部活跃计数，不与其他脚本共享。
	let active = 0;
	// 等待唤醒的回调队列。
	const waiting: (() => void)[] = [];
	// 返回的async函数带调用级泛型，T保留每次run自己的结果类型。
	return async (run) => {
		// 满额就挂起，此等待Promise本身没有超时/取消处理。
		if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
		// 到自己执行时占位。
		active++;
		try {
			// await在try内，让finally等运行落定后释放。
			return await run();
		} finally {
			// 失败也减计数。
			active--;
			// 唤醒一位等待者，但不强制对方run成功。
			waiting.shift()?.();
		}
	};
}

// 识别会话自定义条目的有限形状；不验证set里的值都为JSON，也没排除根/set数组，不能解释为完整持久化schema校验。
function isStoreEntryData(data: unknown): data is CodemodeStoreEntryData {
	// 先筛非null对象，数组在此不排除。
	if (typeof data !== "object" || data === null) return false;
	// Partial使字段可缺，delete改变量名deleted避免用关键字作局部绑定。
	const { set, delete: deleted } = data as Partial<CodemodeStoreEntryData>;
	return (
		// set只要是非null对象，数组也可过，后面Object.entries会按它的自有字段回放。
		typeof set === "object" &&
		set !== null &&
		// delete必须数组。
		Array.isArray(deleted) &&
		// 每个待删除键都是字符串，空键未另拒绝。
		deleted.every((key: unknown) => typeof key === "string")
	);
}

/** Values of `load()`: the `codemode-store` entries on the branch, applied from the root. */
/** 从已按祖先到叶顺序给出的当前分支回放store变更。先删再写，后条目覆盖前条目；例set a=1→delete a→set a=2最终a=2。只回放，不写会话。 */
export function readCodemodeStore(branch: readonly SessionEntry[]): Record<string, unknown> {
	// Map使任意字符串键按数据键存，不用普通对象原型属性查找。
	const store = new Map<string, unknown>();
	// 使用调用者给的条目顺序，不自己排序或查父链。
	for (const entry of branch) {
		// 只处理custom且类型匹配并通过有限形状检查的条目，其余跳过。
		if (entry.type !== "custom" || entry.customType !== CODEMODE_STORE_ENTRY_TYPE || !isStoreEntryData(entry.data)) {
			continue;
		}
		// 同一变更集先删。
		for (const key of entry.data.delete) store.delete(key);
		// 再写，所以同一键同时出现在delete和set时写入值获胜；嵌套值不深复制。
		for (const [key, value] of Object.entries(entry.data.set)) store.set(key, value);
	}
	// 转成普通对象供沙箱JSON读入；不是跨所有分支合并记忆。
	return Object.fromEntries(store);
}

/** Default token budget for script output. */
// 默认模型文本输出预算10000估算token。
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
/** Characters per token when estimating. */
// 用UTF-16字符数/4估算token，非真实分词器。
const CHARS_PER_TOKEN = 4;

/** Like the script's `text()`: strings as is, other values as compact JSON. */
// 返回值转文字：字符串原样，其他紧凑JSON，无JSON结果再String；BigInt/循环值抛错，没有catch。
function valueText(value: unknown): string {
	// 字符串不加JSON引号。
	if (typeof value === "string") return value;
	// ??回退不吞JSON.stringify抛错。
	return JSON.stringify(value) ?? String(value);
}

/**
 * Lay out the script's output so the model can tell items apart: providers join adjacent text
 * blocks with a newline or with nothing. With more than one text item (`text()` or the returned
 * value), each starts with a `==> text N/M <==` line. `console.*` lines follow all other output in
 * one `<console_output>` block.
 */
// 整理脚本输出：普通text按需要编号，image留在原位置，console文字统一挪最后；不是完全保留全部输出项原交错顺序。
function formatOutput(output: readonly CodemodeOutputItem[]): (TextContent | ImageContent)[] {
	// 只数非console文字，图像/console不占text N/M编号。
	const total = output.filter((item) => item.type === "text" && !item.console).length;
	// 模型内容新数组。
	const items: (TextContent | ImageContent)[] = [];
	// 单独积累console，稍后合并成块。
	const consoleLines: string[] = [];
	// 普通text计数从0开始。
	let index = 0;
	// 按原产生顺序扫描。
	for (const item of output) {
		// 图像分支保留图像块。
		if (item.type === "image") {
			// 不在这里保存图片文件。
			items.push(item);
			// console标记的文字延后处理。
		} else if (item.console) {
			// 只收原文字，保留console之间顺序。
			consoleLines.push(item.text);
		} else {
			// 普通text才递增编号。
			index++;
			// 多于1项普通text才加编号，一项保持原文字；不会转义用户输出中的类似标签。
			items.push({ type: "text", text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text });
		}
	}
	// 有console才在最后附一个独立块。
	if (consoleLines.length > 0) {
		// console用LF拼接包标签，没有把正文当可信XML解析。
		items.push({ type: "text", text: `<console_output>\n${consoleLines.join("\n")}\n</console_output>` });
	}
	// 返回整理后的内容块。
	return items;
}

/**
 * Join adjacent text items into one, each part starting on its own line. The separator check looks
 * at the last non-empty part, not the joined text: reading the end of a growing concatenation makes
 * V8 copy it on every item, which is quadratic (#10678).
 */
// 合并相邻文本以减少多块展示/供应商拼接差异；遇image先flush，保持文字与图像的分界，按最后非空片段决定补LF，避免反复读巨型拼接串。
function joinAdjacentText(items: (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
	// 合并结果，图像对象仍原引用。
	const joined: (TextContent | ImageContent)[] = [];
	// 待拼文字片段，不每次+成一个越来越大的字符串。
	let parts: string[] = [];
	// 记最近非空部分的结尾状态。
	let lastPart = "";
	// 局部flush把积累片段一次join，随后清空；不写文件或发模型。
	const flush = () => {
		// 有片段才产生一块text；全部片段空字符串也可能得到空text。
		if (parts.length > 0) joined.push({ type: "text", text: parts.join("") });
		// 重新置空数组，为下一段文字准备。
		parts = [];
		// 重置最后片段。
		lastPart = "";
	};
	// 按内容顺序遍历。
	for (const item of items) {
		// 图像等非text先结清文字。
		if (item.type !== "text") {
			// 输出前面连续文字。
			flush();
			// 非文字原样放入。
			joined.push(item);
			// 开始处理下个项。
			continue;
		}
		// 最近非空片段末尾没LF才补一个，当前项自己开头有LF也不会抵消它。
		if (lastPart !== "" && !lastPart.endsWith("\n")) {
			// 只推LF片段，稍后join。
			parts.push("\n");
			// 把最后非空片段更新为LF。
			lastPart = "\n";
		}
		// 加入当前文字，允许空串。
		parts.push(item.text);
		// 空串不覆盖上一个非空片段的结尾信息。
		if (item.text !== "") lastPart = item.text;
	}
	// 遍历完还要flush最后文字。
	flush();
	// 返回新块数组。
	return joined;
}

// 失败时列出已记录调用及状态，提醒外部副作用不会回滚；它不是取消/重放机制。
function formatCallSummary(calls: readonly CodemodeNestedCall[]): string {
	// 零条记录用固定提示。
	if (calls.length === 0) return "No tool calls were made.";
	// map生成名字与状态后join，原始提示字符串不变。
	return `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
}

// 按失败标签生成人类可读错误并附调用摘要。Extract把CodemodeResult收窄成ok:false的分支，调用时不做额外runtime检测。
function formatError(result: Extract<CodemodeResult, { ok: false }>, calls: readonly CodemodeNestedCall[]): string {
	// 只有失败分支有error字段。
	const { error } = result;
	// 不同错误种类选不同前缀。
	const head =
		error.kind === "script"
			? // 脚本错误优先stack，缺失才用name/message；不在此脱敏，显式空stack也因??保留。
				(error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
			: error.kind === "timeout"
				? // 超时显示timeout文字，不承诺远端操作已立即停止。
					`Script timed out: ${error.message}`
				: error.kind === "aborted"
					? // 取消显示aborted文字。
						`Script aborted: ${error.message}`
					: // 剩余沙箱/worker故障用sandbox前缀。
						`Script sandbox failed: ${error.message}`;
	// 加调用摘要说明已运行的工具不会撤销。
	return `${head}\n\n${formatCallSummary(calls)}`;
}

/** Write the full text output to a temp file, like bash does for truncated output. */
// 保存完整文本到临时文件，成功返回path、失败返回error文字。例输出太长时模型只见首尾，仍可按路径读全文；不是自动再次读取。
async function spillOutput(text: string): Promise<{ path: string } | { error: string }> {
	try {
		// await放try内捕获异步写失败，工具helper决定临时目录和文件名。
		return { path: await writeOutputFile("pi-codemode", ".txt", text) };
	} catch (error) {
		// 失败成为数据供正文说明，不因为磁盘满就悄悄丢弃已经执行的脚本结果。
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** File extensions of the image types `image()` accepts. Must list every type the sandbox's `image()` detects. */
// 沙箱允许image的MIME到文件扩展映射；宿主在这里不重新嗅探图片内容。
const IMAGE_EXTENSIONS: Record<string, string> = {
	// PNG。
	"image/png": ".png",
	// JPEG使用.jpg。
	"image/jpeg": ".jpg",
	// GIF。
	"image/gif": ".gif",
	// WebP。
	"image/webp": ".webp",
};

/**
 * Save each image to a temp file and put a text item with its path before it. The model sees the
 * image but has no other way to reach its bytes: scripts cannot write files, and `write` only takes
 * text. Images shown more than once are saved once.
 */
// 给每个image前加临时文件路径文字；同一base64在本次调用只写一次。例两个相同图像仍显示两次，但共用保存标签；无跨脚本缓存。
async function saveImages(items: (TextContent | ImageContent)[]): Promise<(TextContent | ImageContent)[]> {
	// 局部Map保存base64→标签Promise，键不包含MIME，同数据不同MIME也共享首次标签/扩展。
	const labels = new Map<string, Promise<string>>();
	// 局部label解构图片数据与MIME，异步返回标签文字。
	const label = async ({ data, mimeType }: ImageContent): Promise<string> => {
		// 解base64得到字节，Buffer解码较宽松，不是完整图片格式验证。
		const bytes = Buffer.from(data, "base64");
		// 标签说明MIME和实际解码字节大小。
		const kind = `${mimeType}, ${formatSize(bytes.length)}`;
		// 只按MIME取扩展，没有分析文件头。
		const extension = IMAGE_EXTENSIONS[mimeType];
		// 未知扩展的错误发生在写盘try外，会拒绝label；正常沙箱输出类型限制应由前面边界保证。
		if (!extension) throw new Error(`No file extension for image type ${mimeType}`);
		// A failed write (disk full, unwritable temp dir) must not discard the result of a script whose
		// tool calls already ran, so it becomes part of the label.
		// 写盘失败降级标签，格式/扩展解析错误不全包含在这个try。
		try {
			// 把图片字节交共享输出文件helper，不给脚本本身fs权限。
			const path = await writeOutputFile("pi-codemode", extension, bytes);
			// 标签告诉模型保存路径。
			return `[Image saved to ${path} (${kind})]`;
		} catch (error) {
			// 即使保存失败仍可保留后续图像块；异常文字不在此脱敏。
			return `[Image (${kind}) could not be saved: ${error instanceof Error ? error.message : String(error)}]`;
		}
	};
	// 各内容项可并行处理，但Promise.all保持输入顺序；任一未捕获拒绝会使整个保存流程拒绝。
	const result = await Promise.all(
		// 每项映射成0/1额外标签加原图的数组，返回Promise数组元素。
		items.map(async (item): Promise<(TextContent | ImageContent)[]> => {
			// 非图像直接单元素数组。
			if (item.type !== "image") return [item];
			// 先找本次已在进行的相同数据保存。
			let pending = labels.get(item.data);
			// 没有才创建标签Promise。
			if (!pending) {
				// 立即启动保存/生成标签。
				pending = label(item);
				// 立刻记录Promise，让同一轮稍后相同图像也能复用。
				labels.set(item.data, pending);
			}
			// 等标签后把文字放在原图像前，图像本身不删。
			return [{ type: "text", text: await pending }, item];
		}),
	);
	// 扁平一层，保持各项顺序。
	return result.flat();
}

/**
 * Apply the token budget: when the combined text exceeds it, the text items become one
 * item that keeps the start and end of the text, and images follow it. The full text is written to
 * a temp file.
 */
// 按估算token裁模型文本：超预算就合并全部文字、保留首尾、尽力存全文，再把图像移到文字后。例maxTokens=30只给首尾共120码元预算，警告/路径/标题还会额外增加最终长度。
async function truncateOutput(
	// 输入已整理内容块，不会裁图像base64大小。
	items: (TextContent | ImageContent)[],
	// 调用方从首行选项取非负安全整数，默认10000；这里不再验证通用范围。
	maxTokens: number,
): Promise<{ items: (TextContent | ImageContent)[]; fullOutputPath?: string }> {
	// 过滤成TextContent后取正文数组，含console/错误说明等已有文本。
	const texts = items.filter((item): item is TextContent => item.type === "text").map((item) => item.text);
	// 用LF合成待裁全文，这份全文可能含处理后的输出标记，不是原JS源文件。
	const combined = texts.join("\n");
	// token×4转UTF-16代码单元预算，不是UTF-8字节数/模型真实token。
	const budget = maxTokens * CHARS_PER_TOKEN;
	// 没文字或没超预算时返回原items引用，保留原图文交错顺序。
	if (texts.length === 0 || combined.length <= budget) return { items };
	// 首半向下取整。
	const headChars = Math.floor(budget / 2);
	// 余数给尾半。
	const tailChars = budget - headChars;
	// 计算移除的代码单元数，后面再/4估算token。
	const removed = combined.length - headChars - tailChars;
	// slice可切半UTF-16代理对，不是按字素安全切片。
	const head = combined.slice(0, headChars);
	// 尾预算0时显式空串，避免slice(-0)把全文又拿回来。
	const tail = tailChars > 0 ? combined.slice(-tailChars) : "";
	// 警告、原估算token、逻辑行数与截断标记自身都不含在保留首尾的预算内。
	let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split("\n").length}\n\n${head}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}`;
	// 尝试保存完整合并文本；失败返回error数据而不是立即抛。
	const spilled = await spillOutput(combined);
	// 再补全文路径或保存失败提示，继续增加最终正文长度。
	text +=
		// 用in区分{path}与{error}联合，TS随之收窄。
		"path" in spilled
			? // 路径给后续read按需读取，不自动读全文回模型。
				`\n\n[Full output: ${spilled.path} (read with offset/limit)]`
			: // 写盘失败仍返回已裁输出，并报告原因。
				`\n\n[Could not save the full output: ${spilled.error}]`;
	// 返回处理后的内容与可能的全文路径。
	return {
		// 触发截断才把所有图像挪到唯一文字块后，不保持原来图文交错；图像彼此顺序保持。
		items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
		// 仅成功保存时附fullOutputPath键，缺失不伪造路径。
		...("path" in spilled ? { fullOutputPath: spilled.path } : {}),
	};
}

/**
 * The value a script receives for a nested call: a tool that declares
 * `outputSchema` resolves to its `structuredContent`, also for error results that carry one (such
 * as MCP results with `isError`); any other tool resolves to its text content. Other failures
 * reject with the tool's error text.
 */
// 给脚本决定嵌套工具的返回值：有truthy outputSchema且structuredContent非undefined优先原样返回（即使错误）；否则失败抛文字、成功返回合并text，不把details/图像自动给脚本。
function toScriptValue(tool: AgentTool<any>, outcome: AgentToolCallOutcome): unknown {
	// 从管线结果取实际工具结果对象。
	const { result } = outcome;
	// 这个条件先于isError；null等结构值可返回，显式false的outputSchema因truthy判断不会走这里，也不按schema验证结构值。
	if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
	// 没有可用结构值就提取文字，可能为空串。
	const text = textOf(result);
	// 普通失败让脚本await抛Error，脚本可try/catch；没有正文用工具名兜底。
	if (outcome.isError) throw new Error(text || `Tool "${tool.name}" failed`);
	// 成功时仅返回文字，不包装成{content,...}；要结构值须工具声明并提供它。
	return text;
}

/**
 * Run one script. Without a session context (a plain Agent or a direct call) scripts cannot call
 * tools, `store()` starts empty, and writes are dropped.
 */
/**
 * 执行一次脚本：解析首行选项→准备工具/说明与进度→排worker→启动QuickJS→收结果/关闭→成功时持久化store→整理/截断/保存图像→回模型结果。
 * 例：text(await tools.read({path:"a.txt"}))只把脚本输出交模型；没有ctx仍能return 1+1，但没有会话工具/历史store/models。
 * 普通脚本失败来自沙箱ok:false，保留部分输出；选项解析、进度回调、存储/输出处理等宿主异常仍可能直接拒绝，不能承诺所有失败都变同款结果。
 */
export async function executeCodemode(
	// 父工具调用ID，嵌套记录据它生成关联ID。
	toolCallId: string,
	// schema已决定code:string，但首行@options内容仍需运行时解析。
	input: CodemodeToolInput,
	// 整个调用的外部取消，后续传排队和VM；取消不回滚已经执行的工具副作用。
	signal: AbortSignal | undefined,
	// 可选进度回调，函数本身可抛错，这里没有通用异常隔离。
	onUpdate: ((result: AgentToolResult<CodemodeToolDetails>) => void) | undefined,
	// 可能没有会话上下文，函数路径据此决定可用能力。
	ctx: ExtensionToolContext | undefined,
	// 可选展示/模型/store宿主依赖。
	options: CodemodeToolOptions = {},
): Promise<AgentToolResult<CodemodeToolDetails>> {
	// 高精度相对时钟，用于总墙钟耗时显示，不是Date时间戳。
	const startedAt = performance.now();
	// 解析首行指令并保留源码行号，非首行指令/非法JSON等在沙箱try之前抛错；解析不证明JS语法已有效。
	const { code, options: sourceOptions } = parseCodemodeSource(input.code);
	// 本次UI嵌套记录，工具与models调用都可加入。
	const calls: CodemodeNestedCall[] = [];
	// Usage of the script's `models.*` calls. Nested tool calls report theirs through the session.
	// 只累计脚本models.*的usage；普通嵌套工具usage通过会话父子管线另行记账，避免本地再次累加。
	let modelUsage: Usage | undefined;
	// Images returned by `models.generateImages()`, to notice a script that never shows them.
	// 记录models生图总返回数，用于发现脚本忘了image()显示；不是存图片字节的缓存。
	let generatedImages = 0;
	// 局部回调累加生成数量。
	const addGeneratedImages = (count: number) => {
		// 只改本次计数。
		generatedImages += count;
	};
	// 局部用量合并回调，初次沿用usage引用，后续helper合并。
	const addModelUsage = (usage: Usage) => {
		// 已有用量才combine；不从调用次数猜费用。
		modelUsage = modelUsage ? combineUsage(modelUsage, usage) : usage;
	};

	// 给UI的浅快照，复制数组与每条记录；不深拷贝额外任意对象，本记录主要是标量字段。
	const snapshot = (): CodemodeToolDetails => ({ calls: calls.map((call) => ({ ...call })) });
	// 发布空content+details，不在进度阶段把脚本最终正文推给模型。
	const publish = () => onUpdate?.({ content: [], details: snapshot() });
	// Show the script as running before its first nested call, so the row's timer starts.
	// 首个嵌套调用之前也先发进度，让计时器开始；回调抛错会中断宿主流程。
	publish();

	// 有ctx只取它已经允许的工具并排自身；没有ctx则空，不因description里列过就增加资格。
	const callable = ctx ? getCodemodeCallableTools(ctx.tools) : [];
	// ALL_TOOLS entries carry the declaration.
	// 本次取规则快照，可能没有；不在每个调用里重新取。
	const guidelines = options.getToolGuidelines?.();
	// Map缓存本脚本各工具的说明+声明文字，供ALL_TOOLS和describeTool复用。
	const samples = new Map(
		// 每个工具先转声明，再renderToolSample；schema只用于说明，不替代ctx执行验证。
		callable.map((tool) => [tool.name, renderToolSample(toCodemodeDeclaration(tool, guidelines?.get(tool.name)))]),
	);
	// 把获准工具适配成沙箱可跨边界调用的表，脚本没有拿到宿主原execute函数引用。
	const sandboxTools: CodemodeTool[] = callable.map((tool) => ({
		// 原工具名，沙箱同时生成可用脚本标识符。
		name: tool.name,
		// ALL_TOOLS的description携完整参考声明。
		description: samples.get(tool.name),
		// 每次脚本调用这个工具才执行闭包；解构把局部取消信号改名callSignal，区分外部signal。
		execute: async (args, { signal: callSignal }) => {
			// 先创建运行中UI记录，不等工具真正完成。
			const record: CodemodeNestedCall = {
				// 尚无管线生成ID，暂用父id/?。
				id: `${toolCallId}/?`,
				// 记录工具名。
				name: tool.name,
				// 参数只做有限长度显示预览，不改变传给工具的args。
				args: previewArgs(args),
				// 初始running。
				status: "running",
			};
			// 数组push保持发起顺序，完成顺序可能不同。
			calls.push(record);
			// 立即更新UI。
			publish();
			// 计时从真正准备调用管线附近开始，不含前面的worker排队。
			const callStartedAt = performance.now();
			// Only tools from ctx.tools are callable, so ctx is set here.
			// 没有会话上下文时明确拒绝调用，避免绕过会话的工具执行管线。
			if (!ctx) throw new Error("Tool calls need a session");
			// 真正经宿主管线执行：验证/权限/扩展钩子与普通工具一致，传局部取消信号。
			const outcome = await ctx.executeTool(tool.name, args, { signal: callSignal });
			// 管线返回后才更新真实toolCall.id。
			record.id = outcome.toolCall.id;
			// 记录耗时，包含管线等待/工具实际执行。
			record.durationMs = performance.now() - callStartedAt;
			// 先按管线isError决定UI状态，不因为结构返回值里自带isError就自动检查每个业务字段。
			if (outcome.isError) {
				// 失败时再看信号是否已取消，选cancelled或error；成功结果即使信号已取消仍走ok分支。
				record.status = callSignal.aborted ? "cancelled" : "error";
				// 错误文字最多500码元，不带完整堆栈/自动脱敏保证。
				record.error = truncateText(textOf(outcome.result) || `Tool "${tool.name}" failed`, ERROR_PREVIEW_CHARS);
			} else {
				// 管线正常则记录ok。
				record.status = "ok";
			}
			// 完成时再发一次快照。
			publish();
			// 转换脚本值可能抛错，且有结构值的错误也可能作为值返回，UI记录与脚本try/catch结果不能简单等同。
			return toScriptValue(tool, outcome);
		},
	}));

	// The wait for a worker counts toward the script's deadline.
	// 未设置timeout_ms明确传Infinity禁VM默认时限；显式时限要扣等worker时间，但前面选项解析/目录准备时间没扣进这份deadline。
	const deadline = sourceOptions.timeoutMs ?? Number.POSITIVE_INFINITY;
	// 开始只测等名额时长。
	const waitStartedAt = performance.now();
	// 等待上限取显式脚本时限与60秒较小者，已有外部取消可立即返回aborted。
	const admission = await reserveCodemodeWorker(signal, Math.min(deadline, CODEMODE_WORKER_WAIT_MS));
	// 扣实际排队耗时，事件循环调度可能让它稍超计时目标。
	const waitedMs = performance.now() - waitStartedAt;
	// 没拿到空位就不启动沙箱，返回普通错误结果。
	if (admission !== "reserved") {
		// 显示总耗时含前期准备，不只等名额。
		const waited = ((performance.now() - startedAt) / 1000).toFixed(1);
		// 外部取消原因可能任意值。
		const reason = signal?.reason;
		// 按取消、显式短时限、进程名额占满分别生成提示。
		const error =
			admission === "aborted"
				? // 只对Error原因展示message，其余用固定Execution aborted，不String回显全部任意数据。
					`Script aborted: ${reason instanceof Error ? reason.message : "Execution aborted"}`
				: // 显式deadline<=60秒时把等待失败归为脚本超时。
					deadline <= CODEMODE_WORKER_WAIT_MS
					? `Script timed out: Execution timed out after ${deadline} ms while waiting for a free codemode worker`
					: `No codemode worker became free within ${CODEMODE_WORKER_WAIT_MS / 1000} seconds. All ${maxCodemodeWorkers()} workers, shared by every session in this process, are held by other scripts. Retry after they finish.`;
		// 结果明确脚本未启动，没有虚构完成输出。
		return {
			content: [
				// 保持执行结果头格式，供renderer识别。
				{ type: "text", text: `Script failed\nWall time ${waited} seconds\nOutput:\n` },
				// 错误正文说明未启动，不声称工具执行失败后回滚。
				{ type: "text", text: `Script error:\n${error}\n\nThe script did not start.` },
			],
			// 此时一般calls为空，仍用统一快照。
			details: snapshot(),
			// 错误标记true。
			isError: true,
		};
	}
	// The reservation covers the one worker this script starts. A launch that resumes after the result
	// settled finds it released and starts no worker.
	// 当前宿主还持有预约；WASM没加载完就超时/取消时要释放，并让迟到启动拒绝，防后台再起worker。
	let reserved = true;

	// 构造失败前可能没有sandbox，finally用可选链。
	let sandbox: CodemodeSandbox | undefined;
	// 结果联合由await沙箱得到；宿主抛异常时不会继续走后处理。
	let result: CodemodeResult;
	// try只从沙箱构造开始，前面的解析/回调不在里面；这里只finally清理，没有catch把所有宿主异常转结果。
	try {
		// 每脚本新沙箱，实际VM在worker中，构造器注册工具/全局并可因名称冲突等抛错。
		sandbox = new CodemodeSandbox({
			// 传已适配的工具表，不传所有宿主模块。
			tools: sandboxTools,
			// 全局辅助与工具分开注册。
			globals: [
				// 发现辅助始终存在，即使没有工具也能得到空结果。
				...createDiscoveryGlobals(callable, samples, options),
				// 只有options.models为true且有ctx才提供models接口；说明开关本身不够产生上下文。
				...(options.models && ctx
					? // 把模型注册表和进度/统计回调交给宿主辅助，不把凭证原样传到JS VM。
						createModelGlobals(ctx.modelRegistry, toolCallId, calls, publish, addModelUsage, addGeneratedImages)
					: // 否则没有models全局成员。
						[]),
			],
			// 只扣worker等待，至少1ms并四舍五入；Infinity保持无限。计时器到sandbox.execute创建Execution时才启动。
			// WASM加载已提前启动；计时覆盖剩余的WASM等待和VM运行，不含沙箱构造、分支store回放、初始store序列化及后处理。
			timeoutMs: Math.max(1, Math.round(deadline - waitedMs)),
			// VM堆限256MiB，不限制所有Node/文件/工具内存。
			memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
			// 按项目分发路径加载WASM，返回编译模块Promise；加载等待也可能遇到取消/超时。
			wasm: loadQuickJSWasm(getQuickJSWasmPath()),
			// 选择源码/打包适用的worker入口，可能undefined让库用默认。
			workerUrl: getCodemodeWorkerSpecifier(),
			// 实际创建worker之前由库调用这个同步准入回调，在WASM加载之后。
			acquireWorker: () => {
				// 预约已被finally归还表示结果已结束，迟到启动直接拒绝，不能再占别人的名额。
				if (!reserved) throw new Error("The script already settled");
				// From here the sandbox releases the slot when the worker actually exits.
				// 将归还责任移交库持有的worker退出回调；不是此行已经释放名额。
				reserved = false;
				// 返回归还函数，worker构造失败或真实exit时由库调用一次。
				return releaseCodemodeWorker;
			},
		});
		// 按当前分支祖先条目回放store，没有ctx从空表开始；不读取其他分支写入。
		const store = ctx ? readCodemodeStore(ctx.sessionManager.getBranch()) : {};
		// 以异步函数体运行code，传外部取消/初始store；一般脚本错误返回ok:false，宿主初始化/序列化仍可能拒绝。
		result = await sandbox.execute(code, { signal, store });
	} finally {
		// 请求沙箱关闭并等执行结果落定，不等worker实际exit，也不证明所有不响应信号的宿主工具结束。close若异常可能影响后续清理。
		await sandbox?.close();
		// 若还没交worker退出回调，宿主负责归还预约。
		if (reserved) {
			// 先清标记，防迟到acquireWorker再启动。
			reserved = false;
			// 释放并唤醒下一位；已创建worker的则由真实exit另行释放。
			releaseCodemodeWorker();
		}
	}
	// Calls still marked running were cut off by the script ending, a timeout, or an abort.
	// 沙箱结果已落定时，把仍running的显示记录统一标取消。
	for (const call of calls) {
		// 这里只写UI状态，不是再次执行底层取消/远端撤销，迟到宿主回调仍有各自完成路径。
		if (call.status === "running") call.status = "cancelled";
	}

	// 浅复制已收集输出项，避免push返回值改沙箱result.output数组。
	const scriptOutput = [...result.output];
	// 仅成功脚本持久化store并追加return值，失败仍保留原partial output。
	if (result.ok) {
		// delete字段解构改名deleted；沙箱成功结果才有storeWrites。
		const { set, delete: deleted } = result.storeWrites;
		// 确有写入/删除才追加会话记录，不为只读脚本造空条目。
		if (Object.keys(set).length > 0 || deleted.length > 0) {
			// 可选宿主同步appendEntry，没给则丢跨次持久化；回调抛错在前面finally之后，不会自动回滚已执行工具。
			options.appendEntry?.(CODEMODE_STORE_ENTRY_TYPE, { set, delete: deleted });
		}
		// pi extension: a returned value is appended like text().
		// return undefined不当输出，其他值转文字并放在显式text项后；valueText若失败也可拒绝宿主结果。
		if (result.value !== undefined) scriptOutput.push({ type: "text", text: valueText(result.value) });
	}
	// 统一输出编号与console最后合并。
	const items = formatOutput(scriptOutput);
	// 脚本失败再附错误+已执行调用摘要，不丢前面partial输出。
	if (!result.ok) items.push({ type: "text", text: `Script error:\n${formatError(result, calls)}` });
	// 只要生成过图且最终没有任何image块就提醒；并非逐张比较哪些图没显示，任一image可使提示不出现。
	if (generatedImages > 0 && !items.some((item) => item.type === "image")) {
		// 追加提醒文字，不自动把所有生成图回传给模型。
		items.push({
			type: "text",
			text: `Note: models.generateImages() returned ${generatedImages} image${generatedImages === 1 ? "" : "s"} that the script did not show. Show each image block of result.output with image(block).`,
		});
	}

	// 先合相邻文字，再按估算文本预算裁；可能写完整文本临时文件。
	const truncated = await truncateOutput(
		// 合并不会跨图像边界，但truncate超预算时会重新把图像移后。
		joinAdjacentText(items),
		// ??保留显式0预算，没配才10000；不是运行模型请求的maxTokens。
		sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
	);
	// After truncation, which joins the text items and moves images after them, so each path stays
	// next to its image and is never cut.
	// 裁后再保存图像并加路径，避免路径被截断；路径/图片标签还会额外增加正文预算外长度，然后再合相邻文字。
	const output = joinAdjacentText(await saveImages(truncated.items));
	// 总耗时包含准备、排队、VM、后处理与保存输出，不等于纯JS执行时间。
	const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
	// 头部根据沙箱ok选成功/失败；后处理抛异常则到不了这一步。
	const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${wallTime} seconds\nOutput:\n`;
	// 最后取显示快照。
	const details = snapshot();
	// 只有文本全文确实保存成功才附其路径，图片路径标签另放正文。
	if (truncated.fullOutputPath) details.fullOutputPath = truncated.fullOutputPath;
	// 返回一个标准工具结果。
	return {
		// 头部单独一块text，后面输出可文字/图片交替，供renderer去头。
		content: [{ type: "text", text: header }, ...output],
		// UI详情不自动成为脚本/模型正文。
		details,
		// 有models用量才附usage；普通嵌套工具usage由会话管线处理，此处不重复相加。
		...(modelUsage ? { usage: modelUsage } : {}),
		// 成功时省略isError，失败才显式true，不强制写false。
		...(result.ok ? {} : { isError: true }),
	};
}

/**
 * Whether `query` names the namespace: its name or one of its aliases, as written or as the same
 * script identifier (`dev-radius` and `dev_radius` are both `dev_radius`).
 */
// 比较命名空间名称/别名，允许原名或映射后相同标识符。例dev-radius/dev_radius可等价，但不是忽略大小写/模糊匹配。
function isNamespaceName(namespace: ToolNamespace, query: string): boolean {
	// query映射为脚本标识符，原大小写保留。
	const queryId = toCodemodeIdentifier(query);
	// 名称和所有alias放一起，some任一个匹配即true。
	return [namespace.name, ...(namespace.aliases ?? [])].some(
		// 原字串相等或映射后相等；映射可能有碰撞，不是唯一身份凭证。
		(name) => name === query || toCodemodeIdentifier(name) === queryId,
	);
}

/**
 * `searchTools()`, `describeTool()`, and `describeNamespace()`: ranked search and lookup over the
 * script's nested tools and their namespaces.
 */
// 构建脚本发现辅助，操作本次callable快照：searchTools排名、describeTool拿完整声明、describeNamespace拿组说明与工具名；它们不修改模型工具激活集合。
function createDiscoveryGlobals(
	// 只搜索本次已允许调用的工具，不访问任意全局工具目录。
	tools: readonly AgentTool<any>[],
	// 预先生成的声明说明Map。
	samples: ReadonlyMap<string, string>,
	// 命名空间通过宿主回调按需要取。
	options: CodemodeToolOptions,
): CodemodeTool[] {
	// 每个脚本一个评分器对象，但rank仍每次重建文档索引。
	const ranker = new Bm25Ranker();
	// 返回给脚本的name是映射后的可用标识符，description用该原名的完整参考声明。
	const entry = (name: string) => ({ name: toCodemodeIdentifier(name), description: samples.get(name) ?? "" });
	// 三份CodemodeTool作为globals注册，而不是tools.<name>成员。
	return [
		{
			// 脚本中await searchTools(...)。
			name: "searchTools",
			// spread=true让宿主拿全部参数数组，不只第一参数。
			spread: true,
			// 边界执行回调，输入来自VM JSON往返。
			execute: (args) => {
				// 元组断言不验证形状；后面逐字段检查query/limit/namespace，未做额外所有键过滤。
				const [query, searchOptions] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
				// query必须字符串，纯空串未在这里显式拒绝，排名器会得到空结果。
				if (typeof query !== "string") throw new Error("searchTools() expects a query string");
				// 缺limit（含null）默认8。
				const limit = searchOptions?.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
				// 必须正整数，不用Number隐式转换字符串数字。
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
					// 不合要求直接拒绝脚本调用。
					throw new Error("searchTools() limit must be a positive integer");
				}
				// 可选namespace过滤字段，不额外trim。
				const namespace = searchOptions?.namespace;
				// null/undefined允许作无过滤，其他非字符串拒绝。
				if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
					throw new Error("searchTools() namespace must be a string");
				}
				// 按工具收集可搜索文档，flatMap顺便过滤命名空间。
				const documents = tools.flatMap((tool) => {
					// 从回调取命名空间；没提供回调时工具无命名空间信息。
					const toolNamespace = options.getToolNamespace?.(tool.name);
					// truthy namespace才过滤，空串等于不过滤；非空但没该namespace则排除。
					if (namespace && (!toolNamespace || !isNamespaceName(toolNamespace, namespace))) return [];
					// 工具原描述/schema/namespace构建文档；排名description不含附加guidelines，而返回sample含规则，二者用途不同。
					return [createToolSearchDocument(tool, toolNamespace)];
				});
				// rank结果不向脚本返回score，只给映射名称和完整声明文字，不激活工具。
				return ranker.rank(query, documents, limit).map((match) => entry(match.name));
			},
		},
		{
			// 脚本按名字取一条说明。
			name: "describeTool",
			// 仍按完整参数数组接收，额外参数不在此使用。
			spread: true,
			// 查找回调，不执行被查工具。
			execute: (args) => {
				// 只取第一个name，断言不替代下一行类型检查。
				const [name] = args as unknown[];
				// 必须字符串，找不到是undefined而不是抛“工具不存在”。
				if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
				// 从本次允许工具快照找第一个。
				const tool = tools.find(
					// 原名或工具映射名相等；query本身没再映射、没trim、没忽略大小写。
					(candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name,
				);
				// 找到给完整sample，未找到给undefined，跨JSON数组边界undefined语义由库处理。
				return tool ? samples.get(tool.name) : undefined;
			},
		},
		{
			// 脚本按命名空间拿整组的按需说明。
			name: "describeNamespace",
			// 接收参数数组。
			spread: true,
			// 执行查询辅助。
			execute: (args) => {
				// 只使用首个名称参数。
				const [name] = args as unknown[];
				// 名称类型错误拒绝。
				if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
				// 保存首个匹配工具的namespace元数据。
				let namespace: ToolNamespace | undefined;
				// 累计本组可调用工具的映射名。
				const names: string[] = [];
				// 只枚举本次工具快照，不拉所有远端服务器目录。
				for (const tool of tools) {
					// 回调返回工具所属namespace。
					const toolNamespace = options.getToolNamespace?.(tool.name);
					// 没有组或名称不匹配就跳过。
					if (!toolNamespace || !isNamespaceName(toolNamespace, name)) continue;
					// ??=只存首个元数据，不合并后面同名组不同说明。
					namespace ??= toolNamespace;
					// 工具名映射为脚本标识符加入列表。
					names.push(toCodemodeIdentifier(tool.name));
				}
				// 整组没匹配返回undefined。
				if (!namespace) return undefined;
				// 返回可序列化的普通说明对象。
				return {
					// 名称按首个namespace原名。
					name: namespace.name,
					// description truthy才出现。
					...(namespace.description ? { description: namespace.description } : {}),
					// instructions这里按需返回，不塞进每个工具描述。
					...(namespace.instructions ? { instructions: namespace.instructions } : {}),
					// 组内工具名数组，不附原execute函数。
					tools: names,
				};
			},
		},
	];
}

/**
 * `models.*` for scripts: the model registry methods documented in docs/codemode.md.
 * Classifier and image calls appear as nested call rows so the renderer shows them, and their usage
 * goes to `addUsage`. Rows show only the model, never prompts or image data.
 */
// 给脚本开放有限models宿主接口：目录查询、分类/生图；后两种记录嵌套进度/usage并共用4并发限额，不把registry整个对象复制进VM。
function createModelGlobals(
	// 真实宿主注册表接口，脚本只传模型provider/id供重新查。
	models: CodemodeModelRuntime,
	// 父调用ID，辅助调用记录关联到它。
	toolCallId: string,
	// 与普通嵌套调用共用显示数组。
	calls: CodemodeNestedCall[],
	// 进度发布回调。
	publish: () => void,
	// 汇总模型用量回调。
	addUsage: (usage: Usage) => void,
	// 累计生图数量回调。
	addGeneratedImages: (count: number) => void,
): CodemodeTool[] {
	// 每脚本新限制器，仅分类/生成图调用runModelCall时占此限额，目录查询不占。
	const limit = createLimiter(MAX_CONCURRENT_MODEL_CALLS);
	// 给本脚本models调用编号，不共享普通tool管线编号。
	let callCount = 0;

	/**
	 * Resolve the script's model by provider and id only, check the context, then run the call as a
	 * nested call row. A script-supplied baseUrl or headers must never receive the credentials.
	 */
	// 共用分类/生图执行：只按provider/id重新查可信目录模型 → 有限上下文检查 → 记录进度 → 限并发执行 → 状态/用量 → 原样结果。脚本自带baseUrl/headers不被用于路由认证。
	const runModelCall = async <TType extends "classifier" | "image", TContext, TResult extends ModelCallResult>(
		// 可展示的辅助方法名。
		name: string,
		// TType只允许classifier/image，影响下面ModelTypeMap索引结果类型。
		type: TType,
		// 形参直接解构JSON数组前两项，额外参数不使用。
		[model, context]: unknown[],
		// 上下文检查函数把unknown变成对应TContext，不自动执行通用schema。
		checkContext: (context: unknown) => TContext,
		// 异步run的模型类型由TType决定，返回TResult保留完整结果但至少有ModelCallResult字段。
		run: (resolved: ModelTypeMap[TType], context: TContext) => Promise<TResult>,
	): Promise<TResult> => {
		// 错误附可用模型查询建议文字，不在错误路径自动跑这次查询。
		const listHint = `List the ${type} models you can use with models.getAvailableOfType("${type}").`;
		// as ScriptValue仅便于字段访问，真实输入仍不可信。
		const given = model as ScriptValue;
		// provider/id必须字符串，空字符串未另拒绝，后续目录查找决定是否存在。
		if (typeof given?.provider !== "string" || typeof given.id !== "string") {
			// undefined arrives as null: spread arguments cross the sandbox as a JSON array.
			// 未找到模型传null/undefined时给专门提示，JSON数组里的undefined通常变null。
			const undefinedHint =
				model === undefined || model === null
					? " models.getModelOfType() returns undefined for an unknown provider or id."
					: "";
			// 拒绝错误模型参数；没有向任意脚本提供的端点发送凭证。
			throw new Error(
				`${name}() expects ${withArticle(type)} model as its first argument, got ${describeValue(model)}.${undefinedHint} ${listHint}`,
			);
		}
		// 只抽提供商。
		const provider = given.provider;
		// 只抽模型ID，不采用其余脚本模型字段。
		const id = given.id;
		// 组合显示引用，ID里有斜杠也不在这里切开。
		const ref = `${provider}/${id}`;
		// 从宿主目录按实际类型+provider/id查模型，拿宿主认可的baseUrl/headers等。
		const resolved = models.getModelOfType(type, provider, id);
		// 没查到时再诊断是不是用错模型类别。
		if (!resolved) {
			// 只在其他两种类别找第一个匹配。
			const actualType = [...MODEL_TYPES].find(
				// 集合里string收窄到ModelType；调用依同一宿主注册表，不使用脚本伪造对象。
				(other) => other !== type && models.getModelOfType(other as ModelType, provider, id) !== undefined,
			);
			// 抛类型不符或未知模型的区别提示。
			throw new Error(
				actualType
					? `"${ref}" is ${withArticle(actualType)} model, not ${withArticle(type)} model. ${listHint}`
					: `Unknown ${type} model "${ref}". ${listHint}`,
			);
		}
		// 查到真实模型后才检查上下文，失败还没建立运行记录/发请求。
		const checked = checkContext(context);

		// 建立models预览记录；目录查询本身没有这种进度行。
		const record: CodemodeNestedCall = {
			// 前置++先加1再用于ID，初次从1开始。
			id: `${toolCallId}/${name}/${++callCount}`,
			// 属性简写保存辅助方法名。
			name,
			// UI参数只显示宿主模型provider/id，不显示prompt或图片数据；错误文字仍可能带底层细节。
			args: `${resolved.provider}/${resolved.id}`,
			// 先标running，排4并发队列时也显示running。
			status: "running",
		};
		// 按调用开始顺序记录。
		calls.push(record);
		// 发布UI更新。
		publish();
		// 从进入并发队列前计时，所以耗时包含这份排队等待。
		const startedAt = performance.now();
		// 限额内才真正调run，队列本身不监听取消，run收到信号后决定处理。拒绝没有本地catch更新record，将由脚本/沙箱其他路径处理。
		const result = await limit(() => run(resolved, checked));
		// 模型方法正常返回才记耗时。
		record.durationMs = performance.now() - startedAt;
		// 成功/取消/错误按stopReason标签映射，模型返回error仍作为结果对象交脚本，不自动throw。
		record.status = result.stopReason === "stop" ? "ok" : result.stopReason === "aborted" ? "cancelled" : "error";
		// 存在错误文字才截预览到500码元。
		if (result.errorMessage) record.error = truncateText(result.errorMessage, ERROR_PREVIEW_CHARS);
		// 有usage才统计，不按调用次数估算。
		if (result.usage) {
			// 用返回usage.cost.total作为USD成本。
			record.cost = result.usage.cost.total;
			// 把usage交外层合并。
			addUsage(result.usage);
		}
		// 完成后更新进度快照。
		publish();
		// 返回完整TResult，脚本自己检查stopReason等字段，额外JSON边界由沙箱实现。
		return result;
	};
	// 对象索引类型CodemodeTool["execute"]复用辅助函数签名，字段键是全局命名空间成员。
	const implementations: Record<string, CodemodeTool["execute"]> = {
		// 同步目录查询，不发模型推理请求。
		"models.getModelsOfType": (args) => {
			// 取类别/可选provider，后续边界检查。
			const [type, provider] = args as unknown[];
			// 所有目录模型先去顶层headers再给脚本，不等于每个模型当前认证可用。
			return models.getModelsOfType(toModelType(type), toProvider(provider)).map(toModelInfo);
		},
		// 可用目录查询可做认证/目录刷新等待，传脚本局部取消信号；不直接表示已远端测试每个模型。
		"models.getAvailableOfType": async (args, { signal }) => {
			// 取查询参数。
			const [type, provider] = args as unknown[];
			// 委托注册表的可用性规则，不在这里另造密钥检查。
			const available = await models.getAvailableOfType(toModelType(type), toProvider(provider), { signal });
			// 同样只剔顶层headers后返回数据。
			return available.map(toModelInfo);
		},
		// 查一个具体模型，没找到undefined，不是自动按id搜索任意provider。
		"models.getModelOfType": (args) => {
			// 类别、提供商、ID分别传参。
			const [type, provider, id] = args as unknown[];
			// 后两项必须字符串；类别交toModelType检查。
			if (typeof provider !== "string" || typeof id !== "string") {
				// 错误解释三个独立参数，避免把整串provider/id误传一个参数。
				throw new Error(
					`models.getModelOfType(type, provider, id) expects three strings, got (${(args as unknown[]).map(describeValue).join(", ")}). The provider and the id are separate arguments, for example models.getModelOfType("classifier", "typesafe", "jev-latest").`,
				);
			}
			// 使用宿主目录查询。
			const model = models.getModelOfType(toModelType(type), provider, id);
			// 不存在保留undefined，存在返回去headers的浅数据视图。
			return model === undefined ? undefined : toModelInfo(model);
		},
		// 分类调用由宿主执行，能发真实模型请求；认证和路由交给宿主的模型注册表。
		"models.classify": (args, { signal }) =>
			// 用共用模型重查+分类上下文检查+并发限制/记录。
			runModelCall("models.classify", "classifier", args as unknown[], checkClassifierContext, (resolved, context) =>
				// 真实模型调用传沙箱局部取消信号，不把脚本任意请求配置带入认证路径。
				models.classify(resolved, context, { signal }),
			),
		// 生图调用同一限制器，与分类共同最多4在途。
		"models.generateImages": (args, { signal }) =>
			runModelCall(
				// 记录的辅助名。
				"models.generateImages",
				// 实际必须image模型。
				"image",
				// 参数来自JSON边界数组，检查在runModelCall。
				args as unknown[],
				// 检查input内容块的有限形状。
				checkImagesContext,
				// 真正生图回调，用重新查到的模型及已检查context。
				async (resolved, context) => {
					// 委托注册表，可能产生真实费用；不在此自行取得脚本提供的URL认证。
					const result = await models.generateImages(resolved, context, { signal });
					// 只累计返回output中image块数量，供最终提醒是否一个都没显示。
					addGeneratedImages(result.output.filter((block) => block.type === "image").length);
					// 保持完整结果给共用记录逻辑与脚本。
					return result;
				},
			),
	};
	// 遍历实现表转成globals数组，每项spread让JS多参数跨边界作为数组；方法名含点会被库分组为models命名空间。
	return Object.entries(implementations).map(([name, execute]) => ({ name, spread: true, execute }));
}
