/**
 * pi-evals 的 harness 适配层：把 Pi coding agent 包装成 vitest-evals 可调用的运行器。
 *
 * 所属包与模块：packages/evals/src 的评测运行时适配层。评测文件只描述场景与判分，
 * 本文件负责真正的进程内隔离、模型认证、会话执行和结果归一化。
 *
 * 解决什么问题：一个评测运行臂需要在“干净”的 Pi 环境里执行一组 prompt/reload 步骤，
 * 同时满足：
 * - 每次运行都有独立的 HOME、agent 目录、workspace 和会话目录；
 * - 只加载本次显式提供的扩展，不读取用户已有扩展；
 * - 凭据只从宿主机 auth.json（或解析出的 API key）注入内存，运行结束后清理；
 * - 运行进程中再降到一个非特权 UID，使模型可调用的工具无法读取评测源码或凭据；
 * - 把 Pi 会话消息转换成 vitest-evals 的 TranscriptEvent，并附带 token、工具调用、
 *   系统提示哈希、会话 JSONL 等遥测；
 * - 文档对照评测还要求校验系统提示确实包含/去掉了 Pi 文档路由。
 *
 * 上下游：
 * - 上游：evals/*.docs.eval.ts 等文件调用 createPiDocumentationEvalHarness 或
 *   createPiCodingAgentHarness；vitest-evals 的 describeEval 在用例中调用 harness.run。
 * - 下游：@earendil-works/pi-coding-agent 的 ModelRuntime、SessionManager、
 *   createAgentSessionServices / createAgentSessionFromServices、AgentSession；
 *   @earendil-works/pi-ai 的内存凭据存储、contentText、getCurrentSystemPrompt；
 *   vitest-evals/harness 的 createHarness / normalizeHarnessRun / attachHarnessRunToError。
 * - 结果：返回 SimpleHarnessResult（output、events、usage、metadata），或把部分运行摘要
 *   附加到抛出的错误上；会话文件通过 setArtifact 交给报告层持久化。
 *
 * 本文件的能力清单：
 * - PiCodingAgentInput：一次 harness 运行的输入，可以是单个 prompt，或 prompt/reload 步骤数组。
 * - PiCodingAgentModelSelection：显式模型选择的 { provider, id }。
 * - PiCodingAgentHarnessOptions / PiCodingAgentHarnessWithOutput：harness 选项与可选输出回调。
 * - resolveModelSelection：从显式选择或 PI_PROVIDER/PI_MODEL 解析模型。
 * - applyIsolatedEnvironment：临时改写 HOME/USERPROFILE/PI_CODING_AGENT_DIR 并清除 PI_EVAL_*，
 *   返回恢复函数。
 * - verifySystemPrompt：按预期检查系统提示是否包含 rules 与 Pi 文档段。
 * - createPiCodingAgentHarness：通用 Pi harness 工厂（重载区分是否带 output）。
 * - DOCUMENTATION_EVAL_TOOLS：文档评测允许的工具白名单。
 * - resolveDocumentationVariant：从 PI_EVAL_VARIANT 解析 without_docs/with_docs。
 * - excludePiDocumentation：从默认系统提示中删除 <docs> 段。
 * - createPiDocumentationEvalHarness：仅允许在容器沙箱中使用的文档对照 harness 工厂。
 * - 内部辅助：沙箱身份解析、chown、Vite 转换产物保护、降权、消息转事件、
 *   workspace 种子文件、单次 prompt 执行和核心 runPiCodingAgent。
 *
 * 典型调用示例（示例，不是本文件自动执行的内容）：
 *   const harness = createPiDocumentationEvalHarness();
 *   const run = await harness.run("List the files in the workspace.", {
 *     artifacts: {},
 *     setArtifact: (name, value) => { (runArtifacts as Record<string, unknown>)[name] = value; },
 *   });
 *   // run.output 是最后一个 assistant 文本，run.usage / run.events 来自本次会话。
 *
 * 建议阅读顺序：先看输入/选项类型与 resolveModelSelection，理解模型从哪来；
 * 再看 applyIsolatedEnvironment、沙箱身份与 enterToolSandbox 的隔离边界；
 * 然后读 toTranscriptEvents / seedWorkspace / promptAgent；
 * 最后从头到尾读 runPiCodingAgent 的主流程，以及两个 harness 工厂和文档变体辅助。
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { chmod, chown, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { contentText, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import {
	type AgentSession,
	type CreateAgentSessionOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
	getAgentDir,
	type InlineExtension,
	ModelRuntime,
	readStoredCredential,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	attachHarnessRunToError,
	createHarness,
	type Harness,
	type HarnessContext,
	type JsonValue,
	normalizeHarnessRun,
	normalizeRecord,
	type SimpleHarnessResult,
	type TranscriptEvent,
	toJsonValue,
	type UsageSummary,
} from "vitest-evals/harness";
import type { DocumentationVariant } from "./plan.ts";
import { PI_SESSION_SNAPSHOT_ARTIFACT } from "./report.ts";

// 内部运行诊断：会话事件、附加元数据和 usage 汇总。
// 这些字段稍后直接传给 normalizeHarnessRun 形成标准 HarnessRun。
type PiRunDiagnostics = {
	events: TranscriptEvent[];
	metadata: Record<string, unknown>;
	usage: UsageSummary;
};

// harness 输入是判别联合的简写：字符串 prompt，或由 prompt/reload 组成的步骤数组。
// 用对象而不是裸字符串表达步骤，后续可以扩展其他动作而不破坏已有调用。
export type PiCodingAgentInput = string | Array<{ type: "prompt"; content: string } | { type: "reload" }>;

// 显式模型选择。provider 是供应商 id，id 是模型 id；与 EvalTask.model 的 "provider/model" 不同。
export type PiCodingAgentModelSelection = {
	provider: string;
	id: string;
};

// harness 选项。工具相关字段用索引访问类型复用 SDK 的声明，避免在这里重复维护一份形状：
// CreateAgentSessionOptions["noTools"] 等价于直接取那个属性类型。
export type PiCodingAgentHarnessOptions = {
	// harness 名称，默认 pi-coding-agent；文档变体里会覆盖为变体名。
	name?: string;
	// 显式模型；缺省时回退到环境变量。
	model?: PiCodingAgentModelSelection;
	// 传给 AgentSession 的工具禁用开关。
	noTools?: CreateAgentSessionOptions["noTools"];
	// 工具白名单/过滤器。
	tools?: CreateAgentSessionOptions["tools"];
	// 评测额外注入的自定义工具。
	customTools?: CreateAgentSessionOptions["customTools"];
	// 在 workspace 中预先写入的文件，键是相对路径，值是内容。
	workspaceFiles?: Readonly<Record<string, string>>;
	// 在 before_agent_start 钩子里改写系统提示；用于 without_docs 变体。
	transformSystemPrompt?: (defaultPrompt: string) => string;
	// 若设置，则要求最终系统提示包含（true）或不包含（false）Pi 文档段。
	expectedPiDocumentation?: boolean;
};

// 带输出回调的选项：在 harness 跑完后，用 response/session/systemPrompt/agentDir
// 计算自定义 JSON 输出。泛型 TOutput 受 JsonValue 约束，保证结果可被 vitest-evals 归一化。
export type PiCodingAgentHarnessWithOutput<TOutput extends JsonValue> = PiCodingAgentHarnessOptions & {
	output: (args: {
		response: string;
		session: AgentSession;
		systemPrompt: string;
		agentDir: string;
	}) => TOutput | Promise<TOutput>;
};

// 解析本次运行使用哪个模型。优先显式选择，其次环境变量；两者都必须有 provider 与 id。
// 输入 explicitModel 与可注入的 environment；缺少任一项时抛 Error。
// 示例：resolveModelSelection(undefined, { PI_PROVIDER: "p", PI_MODEL: "m" }) -> { provider: "p", id: "m" }。
export function resolveModelSelection(
	explicitModel: PiCodingAgentModelSelection | undefined,
	environment: { PI_PROVIDER?: string; PI_MODEL?: string } = process.env,
): PiCodingAgentModelSelection {
	// 空值合并 `??` 只回退 undefined/null，不把空字符串当缺失；trim 后再判断。
	const provider = (explicitModel?.provider ?? environment.PI_PROVIDER)?.trim();
	const id = (explicitModel?.id ?? environment.PI_MODEL)?.trim();
	if (!provider || !id) {
		throw new Error("Select a harness model explicitly or set both PI_PROVIDER and PI_MODEL as defaults.");
	}
	return { provider, id };
}

// 临时隔离进程环境，返回一个恢复函数。
// 输入 home 与 agentDir；副作用是修改 process.env：
// - 清零所有 PI_EVAL_*，防止容器元数据泄漏进被评测的 agent；
// - 覆盖 HOME、USERPROFILE、PI_CODING_AGENT_DIR，让 Pi 只看到临时目录。
// 返回的函数按原值恢复（原先不存在的键会被删除）。
// 示例：const restore = applyIsolatedEnvironment("/tmp/h", "/tmp/h/.pi/agent"); try {...} finally { restore(); }
export function applyIsolatedEnvironment(home: string, agentDir: string): () => void {
	const overrides = { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir };
	// 保存原环境，undefined 表示该键原先不存在。
	const previous = new Map<string, string | undefined>();
	for (const name of Object.keys(process.env)) {
		if (!name.startsWith("PI_EVAL_")) continue;
		previous.set(name, process.env[name]);
		// delete 从进程环境中移除该变量；这与赋 undefined 不同，后者可能留下字符串 "undefined"。
		delete process.env[name];
	}
	for (const [name, value] of Object.entries(overrides)) {
		// 只有尚未记录时才保存，避免 PI_EVAL_* 循环与这里重复覆盖同一键时丢失原始值。
		if (!previous.has(name)) previous.set(name, process.env[name]);
		process.env[name] = value;
	}
	return () => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

// 非特权运行身份。只在两个变量都设置时启用沙箱降权。
type SandboxIdentity = { uid: number; gid: number };

// 解析一个沙箱 id 环境变量。未设置返回 undefined；不是正安全整数时抛错。
// 名称参数被限制为两个字面量联合，避免误传任意字符串。
function parseSandboxId(name: "PI_EVAL_SANDBOX_UID" | "PI_EVAL_SANDBOX_GID"): number | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	const id = Number(value);
	if (!Number.isSafeInteger(id) || id < 1) throw new Error(`${name} must be a positive integer.`);
	return id;
}

// 读取两个沙箱 id 并要求成对出现。返回 undefined（不降权）或 { uid, gid }。
// 只设置一个时抛错，避免出现 uid 与 gid 不一致的半配置状态。
function resolveSandboxIdentity(): SandboxIdentity | undefined {
	const uid = parseSandboxId("PI_EVAL_SANDBOX_UID");
	const gid = parseSandboxId("PI_EVAL_SANDBOX_GID");
	if (uid === undefined && gid === undefined) return undefined;
	if (uid === undefined || gid === undefined) {
		throw new Error("Set both PI_EVAL_SANDBOX_UID and PI_EVAL_SANDBOX_GID, or neither.");
	}
	return { uid, gid };
}

// 递归把一棵目录树的所有者改成沙箱身份。输入路径与身份；副作用是 chown，可能抛错。
// lstat 不跟随符号链接，避免通过链接把 chown 作用到树外；目录先递归子项再 chown 自身。
async function chownTree(path: string, identity: SandboxIdentity): Promise<void> {
	const stats = await lstat(path);
	if (stats.isDirectory() && !stats.isSymbolicLink()) {
		// Promise.all 只等待所有并发 chown 完成，不保证完成顺序。
		await Promise.all((await readdir(path)).map((entry) => chownTree(join(path, entry), identity)));
	}
	await chown(path, identity.uid, identity.gid);
}

// 保护 Vite 生成的 SSR 转换模块，返回被保护的绝对路径列表。
// 为什么要做：这些临时文件可能包含评测源码/断言逻辑；降权后的 agent 工具若能读取，
// 就能看到评测答案。做法：遍历系统临时目录，对每个带 ssr 子目录的缓存根把目录设为可穿越 0755、
// 文件设为仅属主可读 0600（当前进程此时还是 root）。
// 输入无；readdir 的 ENOENT 表示该目录没有 ssr 子目录，直接跳过；其他错误上抛。
async function protectTransformedModules(): Promise<string[]> {
	const protectedPaths: string[] = [];
	// withFileTypes 让 Dirent 直接告诉条目是不是目录，省一次 stat。
	for (const directory of await readdir(tmpdir(), { withFileTypes: true })) {
		if (!directory.isDirectory()) continue;
		const cacheRoot = join(tmpdir(), directory.name);
		const ssrRoot = join(cacheRoot, "ssr");
		let files: Dirent[];
		try {
			files = await readdir(ssrRoot, { withFileTypes: true });
		} catch (error) {
			// `"code" in error` 在运行时收窄 unknown 错误对象；ENOENT 表示没有该缓存目录。
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		// 目录要允许沙箱用户穿越（否则连路径都访问不了），文件本身则只有 root 能读。
		await Promise.all([chmod(cacheRoot, 0o755), chmod(ssrRoot, 0o755)]);
		for (const file of files) {
			if (!file.isFile()) continue;
			const path = join(ssrRoot, file.name);
			await chmod(path, 0o600);
			protectedPaths.push(path);
		}
	}
	return protectedPaths;
}

// 让当前进程永久进入非特权工具沙箱。输入临时根目录与可选身份；无返回。
// 未配置身份时直接返回（宿主本地运行）；配置了则要求 POSIX API、当前为 root，
// 然后 chown 临时根、清空附加组、setgid/setuid，并验证确实降权且受保护模块不可读。
// 注意：setuid 是不可逆的单向操作，之后无法再回到 root。
async function enterToolSandbox(root: string, identity: SandboxIdentity | undefined): Promise<void> {
	if (!identity) return;
	// process.setuid 等在非 POSIX 平台可能不存在；逐个检查可调用性（运行时检查，类型层面已声明）。
	if (
		typeof process.getuid !== "function" ||
		typeof process.geteuid !== "function" ||
		typeof process.setuid !== "function" ||
		typeof process.setgid !== "function" ||
		typeof process.setgroups !== "function"
	) {
		throw new Error("The eval filesystem sandbox requires POSIX user APIs.");
	}
	// 只有 root 才能 setuid；getuid 与 geteuid 都查，避免 setuid 位造成的意外。
	if (process.getuid() !== 0 || process.geteuid() !== 0) {
		throw new Error("The eval runner must start as root before entering the unprivileged tool sandbox.");
	}

	// 在降权前完成文件属主修改与源码保护。
	const protectedPaths = await protectTransformedModules();
	await chownTree(root, identity);
	// 清空附加组，防止继承 root 的组权限。
	process.setgroups([]);
	process.setgid(identity.gid);
	process.setuid(identity.uid);
	// 再次读取真实/有效 uid，确认降权生效。
	if (process.getuid() !== identity.uid || process.geteuid() !== identity.uid) {
		throw new Error("Failed to enter the unprivileged eval tool sandbox.");
	}
	for (const path of protectedPaths) {
		try {
			await readFile(path);
		} catch (error) {
			// EACCES 表示权限拒绝，符合预期；ENOENT 表示缓存已被清理，也没有可读内容。
			if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "ENOENT")) {
				continue;
			}
			throw error;
		}
		// 能读到内容说明保护失败，直接抛错而不是继续评测。
		throw new Error(`The unprivileged eval process can read a transformed eval module: ${path}`);
	}
}

// 把 Pi 会话消息转换为 vitest-evals 的标准事件数组。
// 输入 AgentSession["messages"]；返回 TranscriptEvent[]，不修改会话。
// 用户消息转 message；助手消息拆成可选的文本 message 和每个 toolCall 一条 tool_call；
// 工具结果转 tool_result，纯文本内容保留字符串，混合内容转 JSON，错误结果附加 error。
function toTranscriptEvents(messages: AgentSession["messages"]): TranscriptEvent[] {
	const events: TranscriptEvent[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			// contentText 把字符串或内容块数组统一拼成文本。
			events.push({ type: "message", role: "user", content: contentText(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			const text = contentText(message.content);
			// 纯工具调用的助手消息没有文本，不生成空 message 事件。
			if (text) events.push({ type: "message", role: "assistant", content: text });
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				events.push({
					type: "tool_call",
					id: part.id,
					name: part.name,
					// normalizeRecord 只保留 JSON 安全值，避免把任意运行时对象塞进报告。
					arguments: normalizeRecord(part.arguments),
				});
			}
			continue;
		}
		if (message.role === "toolResult") {
			const text = contentText(message.content);
			events.push({
				type: "tool_result",
				toolCallId: message.toolCallId,
				name: message.toolName,
				// every 检查所有内容块都是 text；是则保留文本，否则整体转 JSON 保留结构。
				content: message.content.every((part) => part.type === "text") ? text : toJsonValue(message.content),
				// 条件展开：只有错误结果才添加 error 字段，成功结果保持原形状。
				...(message.isError ? { error: { message: text || "Tool failed" } } : {}),
			});
		}
		// 其他 role（如果未来出现）不会进入事件；这里没有默认分支。
	}
	return events;
}

// 把评测提供的文件写进隔离 workspace。输入 workspace 根与可选文件映射；无返回。
// 每个键必须是相对路径，且 resolve 后不能逃出 workspace，否则抛 TypeError。
// 副作用：递归创建父目录并以 0600 写文件。
async function seedWorkspace(workspace: string, files: Readonly<Record<string, string>> | undefined): Promise<void> {
	// files 为 undefined 时 ?? {} 让循环安全地不执行。
	for (const [name, content] of Object.entries(files ?? {})) {
		// 拒绝空路径与绝对路径（绝对路径会在 workspace 之外）。
		if (!name || isAbsolute(name)) throw new TypeError(`Invalid workspace fixture path: ${name}`);
		const path = resolve(workspace, name);
		const pathFromWorkspace = relative(workspace, path);
		// 以 ".." 开头或恰好等于 ".." 表示越界；isAbsolute 覆盖跨盘符等边界情况。
		if (pathFromWorkspace === ".." || pathFromWorkspace.startsWith(`..${sep}`) || isAbsolute(pathFromWorkspace)) {
			throw new TypeError(`Workspace fixture escapes the workspace: ${name}`);
		}
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, { mode: 0o600 });
	}
}

// 执行一次 prompt 并返回该轮最后一个 assistant 文本。输入会话、prompt 与可选取消信号。
// 副作用：向会话推进一轮、产生模型请求与工具调用。
// 错误：已取消、没有 assistant 消息、停止原因不是 stop/toolUse、或 stop 却没有文本。
async function promptAgent(session: AgentSession, input: string, signal: AbortSignal | undefined): Promise<string> {
	// throwIfAborted 在已经取消时立即抛 AbortError，避免发起新请求。
	signal?.throwIfAborted();
	// 记录调用前的消息数，之后只看本轮新增的部分。
	const previousMessageCount = session.messages.length;
	await session.prompt(input);
	// slice 取新增消息，reverse 后 find 找最近一条 assistant；reverse 会原地修改新切片，不影响会话。
	const assistant = session.messages
		.slice(previousMessageCount)
		.reverse()
		.find((message) => message.role === "assistant");
	if (!assistant) throw new Error("Agent run completed without an assistant message.");
	// 正常完成可能以 stop（纯文本回答）或 toolUse（停在一轮工具调用后）结束；其他原因视为失败。
	if (assistant.stopReason !== "stop" && assistant.stopReason !== "toolUse") {
		throw new Error(
			assistant.errorMessage ?? `Agent run ended with unexpected stop reason: ${assistant.stopReason}.`,
		);
	}
	const output = session.getLastAssistantText();
	// stop 却没有文本通常意味着模型输出被丢弃或解析失败，按错误处理。
	if (!output && assistant.stopReason === "stop") throw new Error("Agent run produced no assistant text.");
	// toolUse 时可能没有文本，返回空串而不是 undefined。
	return output ?? "";
}

// 按预期验证系统提示。输入提示文本与 name/expectedPiDocumentation。
// expectedPiDocumentation 未设置时原样返回（宿主 smoke eval 不做文档检查）。
// 设置了则要求 rules 段存在，并且 docs 段的有无必须与期望一致；否则抛错。
// 返回原字符串，便于在调用处链式使用。
export function verifySystemPrompt(
	systemPrompt: string,
	options: Pick<PiCodingAgentHarnessOptions, "name" | "expectedPiDocumentation">,
): string {
	if (options.expectedPiDocumentation === undefined) return systemPrompt;
	// 用前后换行定位完整标签行，减少正文中出现同名文本造成的误判。
	if (!systemPrompt.includes("\n<rules>\n")) {
		throw new Error(`Pi system prompt lost its rules in the ${options.name} eval variant.`);
	}
	const hasDocumentation = systemPrompt.includes("\n<docs>\nPi documentation (read only");
	// 布尔比较同时覆盖“without_docs 却还有文档”和“with_docs 却没文档”。
	if (hasDocumentation !== options.expectedPiDocumentation) {
		throw new Error(`Pi system prompt does not match the ${options.name} eval variant.`);
	}
	return systemPrompt;
}

// 核心运行函数：完成一次 Pi agent 运行的隔离、认证、会话创建、步骤执行和清理。
// 输入 harness input、取消信号、产物写入回调与选项；返回带 events/usage/metadata/timings 的结果。
// 失败路径：运行错误与清理错误会合并成 AggregateError；若有部分诊断，会附加到错误上再抛出，
// 让报告层仍能读到已产生的 session/usage。
async function runPiCodingAgent<TOutput extends JsonValue>(
	input: PiCodingAgentInput,
	signal: AbortSignal | undefined,
	setArtifact: HarnessContext["setArtifact"],
	options: PiCodingAgentHarnessOptions | PiCodingAgentHarnessWithOutput<TOutput>,
): Promise<SimpleHarnessResult<string | TOutput>> {
	// 用单调时钟记录开始时间，避免系统时间调整影响耗时。
	const startedAt = performance.now();
	signal?.throwIfAborted();
	const selection = resolveModelSelection(options.model);
	// 必须在 applyIsolatedEnvironment 之前读取真实 agent 目录；之后 getAgentDir 会指向临时目录。
	const hostAgentDir = getAgentDir();
	const sandboxIdentity = resolveSandboxIdentity();
	// mkdtemp 原子地创建唯一临时目录（前缀 pi-eval-），避免并发运行互相覆盖。
	const root = await mkdtemp(join(tmpdir(), "pi-eval-"));
	const workspace = join(root, "workspace");
	const isolatedHome = join(root, "home");
	// Pi 的配置、认证和扩展都从 PI_CODING_AGENT_DIR 读取，这里指到临时 home 下。
	const agentDir = join(isolatedHome, ".pi", "agent");
	const extensionFactories: InlineExtension[] = [];
	let forcedSystemPrompt: string | undefined;
	// 需要改写系统提示时，注册一个隐藏的内联扩展，在每次 agent 启动前替换提示。
	if (options.transformSystemPrompt) {
		// 先赋给局部常量，避免在回调里反复读取可选属性导致类型收窄失效。
		const transform = options.transformSystemPrompt;
		extensionFactories.push({
			name: "eval-system-prompt-transform",
			hidden: true,
			factory: (pi) => {
				// before_agent_start 的返回值会替换本次运行的系统提示。
				pi.on("before_agent_start", ({ systemPrompt }) => {
					forcedSystemPrompt = transform(systemPrompt);
					return { systemPrompt: forcedSystemPrompt };
				});
			},
		});
	}

	// 下面这些变量需要在 try/catch/finally 之间共享；先声明为可能 undefined。
	let sessionManager: SessionManager | undefined;
	let session: AgentSession | undefined;
	let result: SimpleHarnessResult<string | TOutput> | undefined;
	let runDiagnostics: PiRunDiagnostics | undefined;
	let runError: unknown;
	const cleanupErrors: unknown[] = [];
	let hiddenCredentialEnvironment: { name: string; value: string } | undefined;
	// 环境隔离必须尽早生效，并在 finally 中恢复，即使后续创建失败也不例外。
	const restoreEnvironment = applyIsolatedEnvironment(isolatedHome, agentDir);
	try {
		// 宿主机（容器入口复制出的）auth.json；readStoredCredential 读取失败会返回 undefined。
		const authPath = join(hostAgentDir, "auth.json");
		const credentials = new InMemoryCredentialStore();
		const storedCredential = readStoredCredential(selection.provider, authPath);
		// modify 是凭据存储的串行写入口；回调返回要写入的值。这里仅把宿主凭据放进内存，不落盘。
		if (storedCredential) await credentials.modify(selection.provider, async () => storedCredential);
		const modelRuntime = await ModelRuntime.create({ credentials });
		// workspace 与 agent 目录并行创建；agentDir 需要 recursive 创建多级 .pi/agent。
		await Promise.all([mkdir(workspace), mkdir(agentDir, { recursive: true })]);
		await seedWorkspace(workspace, options.workspaceFiles);
		const model = modelRuntime.getModel(selection.provider, selection.id);
		if (!model) throw new Error(`Eval model not found: ${selection.provider}/${selection.id}`);
		const auth = await modelRuntime.getAuth(model);
		if (!auth) {
			throw new Error(`Eval model has no configured authentication: ${selection.provider}/${selection.id}`);
		}
		// 没有存储凭据但解析出 API key（例如环境变量）时，把 key 注入内存运行时。
		// 不写回 auth.json，避免污染宿主机状态。
		if (!storedCredential && auth.auth.apiKey) {
			await modelRuntime.setRuntimeApiKey(selection.provider, auth.auth.apiKey);
		}
		if (sandboxIdentity) {
			// 降权后进程不应再能读到凭据文件；先删除容器入口复制出的 auth.json。
			await rm(authPath, { force: true });
			// 若凭据来自某个环境变量（auth.source 如 ANTHROPIC_API_KEY），先保存值再从当前环境移除，
			// 防止被评测 agent 的工具读取；finally 中恢复。
			const credentialEnvironmentValue = auth.source ? process.env[auth.source] : undefined;
			if (auth.source && /^[A-Z][A-Z0-9_]*$/.test(auth.source) && credentialEnvironmentValue) {
				hiddenCredentialEnvironment = { name: auth.source, value: credentialEnvironmentValue };
				delete process.env[auth.source];
			}
		}

		// 创建 cwd 绑定的服务；extensionFactories 让内联提示改写扩展随资源加载。
		const services = await createAgentSessionServices({
			cwd: workspace,
			modelRuntime,
			resourceLoaderOptions: { extensionFactories },
		});
		signal?.throwIfAborted();
		// 会话历史写到临时 root 下的 sessions 目录，不接触用户真实会话。
		sessionManager = SessionManager.create(workspace, join(root, "sessions"));
		// runId 作为产物元数据，供报告定位本次会话。
		setArtifact("runId", sessionManager.getSessionId());
		// 用已创建的服务和显式选项装配 AgentSession；thinkingLevel 固定 off 以保证对照可复现。
		session = (
			await createAgentSessionFromServices({
				services,
				sessionManager,
				model,
				thinkingLevel: "off",
				tools: options.tools,
				noTools: options.noTools,
				customTools: options.customTools,
			})
		).session;

		// 只允许本次显式注册的内联扩展。内联扩展在 getExtensionPaths 中显示为 <inline:name>。
		const expectedInlinePaths = new Set(extensionFactories.map(({ name }) => `<inline:${name}>`));
		const unexpectedExtensions = session.extensionRunner
			.getExtensionPaths()
			.filter((path) => !expectedInlinePaths.has(path));
		if (unexpectedExtensions.length > 0) {
			throw new Error(`Isolated eval loaded unexpected extensions: ${unexpectedExtensions.join(", ")}`);
		}

		// 所有需要 root 的准备完成后降权；此后 agent 工具以非特权身份读写文件。
		await enterToolSandbox(root, sandboxIdentity);
		let response: string | undefined;
		// 字符串输入规范化为一个 prompt 步骤；数组输入按顺序执行。
		const steps = typeof input === "string" ? [{ type: "prompt" as const, content: input }] : input;
		let abortPromise: Promise<void> | undefined;
		const abort = () => {
			// ??= 只在第一次取消时调用 session.abort()，后续事件复用同一个 Promise。
			abortPromise ??= session!.abort();
		};
		// once: true 让监听器在第一次 abort 后自动移除；signal 可能为 undefined。
		signal?.addEventListener("abort", abort, { once: true });
		try {
			for (const step of steps) {
				if (step.type === "reload") {
					// reload 重新加载资源/扩展，不产生模型响应。
					await session.reload();
					continue;
				}
				// 多步输入时保留最后一个 prompt 的响应作为 output。
				response = await promptAgent(session, step.content, signal);
			}
		} finally {
			// 无论成功、失败还是取消都移除监听器，并等待已发起的 abort 完成。
			signal?.removeEventListener("abort", abort);
			if (abortPromise) await abortPromise;
		}
		if (response === undefined) {
			// 只有 reload 没有 prompt 的输入无法产生输出。
			throw new Error("Pi eval input must include at least one prompt step.");
		}
		// A forced prompt is not recorded in the transcript, so use the one the transform
		// extension sent; otherwise the replayed transcript prompt is what the provider received.
		// 中文说明：被强制替换的提示不会自动记录进 transcript，所以优先使用扩展捕获的值；
		// 否则从会话消息中重放当前系统提示。
		const systemPrompt = forcedSystemPrompt ?? getCurrentSystemPrompt(session.messages);
		const stats = session.getSessionStats();
		// 只有模型（含 tier）至少有一个非零价格时才报告成本，避免把“未知价格”显示成 $0。
		const hasPricing = [model.cost, ...(model.cost.tiers ?? [])].some(
			({ input: inputCost, output: outputCost, cacheRead, cacheWrite }) =>
				inputCost > 0 || outputCost > 0 || cacheRead > 0 || cacheWrite > 0,
		);
		runDiagnostics = {
			events: toTranscriptEvents(session.messages),
			// 只存哈希而非完整提示，既可用于对照，又避免把长提示重复塞进报告。
			metadata: { systemPromptSha256: createHash("sha256").update(systemPrompt).digest("hex") },
			usage: {
				provider: model.provider,
				model: model.id,
				inputTokens: stats.tokens.input,
				outputTokens: stats.tokens.output,
				totalTokens: stats.tokens.total,
				toolCalls: stats.toolCalls,
				metadata: {
					cacheReadTokens: stats.tokens.cacheRead,
					cacheWriteTokens: stats.tokens.cacheWrite,
					// 条件展开：没有定价时完全不出现 estimatedCostUsd 键。
					...(hasPricing ? { estimatedCostUsd: stats.cost } : {}),
				},
			},
		};
		verifySystemPrompt(systemPrompt, options);
		// `"output" in options` 是运行时属性检查，同时让 TypeScript 收窄到带 output 的联合分支。
		const output =
			"output" in options ? await options.output({ response, session, systemPrompt, agentDir }) : response;
		// 展开诊断字段（events/metadata/usage），再附加 output。
		result = { output, ...runDiagnostics };
	} catch (error) {
		// 运行期错误先保存，等 finally 清理完再统一决定抛什么。
		runError = error;
	} finally {
		if (sessionManager) {
			// 会话文件可能尚未刷盘或路径不存在；缺失视为清理失败但仍保留其他产物。
			const sessionPath = sessionManager.getSessionFile();
			if (!sessionPath || !existsSync(sessionPath)) {
				cleanupErrors.push(new Error("Pi eval produced no session file."));
			} else {
				try {
					// 把会话 JSONL 内容通过 setArtifact 交给报告层，由 report.ts 持久化。
					setArtifact(PI_SESSION_SNAPSHOT_ARTIFACT, await readFile(sessionPath, "utf8"));
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
		}
		try {
			// dispose 释放会话资源；即使它抛错也要继续清理临时目录。
			session?.dispose();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			// force 让不存在的路径也不报错；recursive 删除整棵临时树。
			await rm(root, { recursive: true, force: true });
		} catch (error) {
			cleanupErrors.push(error);
		}
		// 恢复环境变量和此前隐藏的凭据环境变量；顺序不影响正确性，但必须都执行。
		restoreEnvironment();
		if (hiddenCredentialEnvironment) {
			process.env[hiddenCredentialEnvironment.name] = hiddenCredentialEnvironment.value;
		}
	}

	// 合并失败：运行错误优先与清理错误一起打包；只有清理错误时单独或聚合抛出。
	let failure = runError;
	if (runError !== undefined && cleanupErrors.length > 0) {
		failure = new AggregateError([runError, ...cleanupErrors], "Agent run failed and cleanup also failed.");
	} else if (cleanupErrors.length === 1) {
		failure = cleanupErrors[0];
	} else if (cleanupErrors.length > 1) {
		failure = new AggregateError(cleanupErrors, "Agent cleanup failed.");
	}
	if (failure !== undefined) {
		if (runDiagnostics) {
			// 已有部分诊断时构造 normalizeHarnessRun 结果并附加到错误上；
			// report.ts 仍能读到 usage/session，便于把失败臂记录为 errored 而不是完全丢失。
			const partialRun = normalizeHarnessRun(input, {
				...runDiagnostics,
				errors: [failure],
				timings: { totalMs: performance.now() - startedAt },
			});
			throw attachHarnessRunToError(failure, partialRun);
		}
		throw failure;
	}
	if (!result) throw new Error("Pi eval completed without a result.");
	// timings 在最后补上，确保所有路径使用同一开始时间。
	return { ...result, timings: { totalMs: performance.now() - startedAt } };
}

// 通用 Pi harness 工厂。重载一：提供 output 回调时返回对应 TOutput；
// 重载二：不提供时输出固定为字符串。
// 示例：const harness = createPiCodingAgentHarness({ model: { provider: "p", id: "m" } });
export function createPiCodingAgentHarness<TOutput extends JsonValue>(
	options: PiCodingAgentHarnessWithOutput<TOutput>,
): Harness<PiCodingAgentInput, TOutput>;
export function createPiCodingAgentHarness(options?: PiCodingAgentHarnessOptions): Harness<PiCodingAgentInput, string>;
export function createPiCodingAgentHarness<TOutput extends JsonValue>(
	// 实现签名必须兼容两个重载；默认空对象让第二个重载可省略参数。
	options: PiCodingAgentHarnessOptions | PiCodingAgentHarnessWithOutput<TOutput> = {},
): Harness<PiCodingAgentInput, string | TOutput> {
	// createHarness 负责把轻量结果归一化成 HarnessRun；这里只提供 name 与 run 回调。
	return createHarness<PiCodingAgentInput, string | TOutput>({
		name: options.name ?? "pi-coding-agent",
		run: ({ input, signal, setArtifact }) => runPiCodingAgent(input, signal, setArtifact, options),
	});
}

/** Documentation evals intentionally exclude shell and unrestricted network tools. */
// 文档评测的工具白名单：只允许读写文件与查找，不暴露 shell 和网络工具。
// as const 让元素保持字面量类型，展开成数组时仍是这些具体的工具名。
export const DOCUMENTATION_EVAL_TOOLS = ["read", "write", "edit", "grep", "find", "ls"] as const;

// 解析文档变体。输入可覆盖的值，默认读 PI_EVAL_VARIANT；只接受两个字面量之一。
// 其他值（包括 undefined）抛 TypeError，避免拼写错误悄悄选错镜像。
export function resolveDocumentationVariant(
	value: string | undefined = process.env.PI_EVAL_VARIANT,
): DocumentationVariant {
	if (value === "without_docs" || value === "with_docs") return value;
	throw new TypeError('PI_EVAL_VARIANT must be "without_docs" or "with_docs".');
}

// 从默认系统提示中删除 Pi 文档路由段，供 without_docs 变体使用。
// 输入默认提示；返回删除 `<docs>...</docs>` 后的新字符串。
// 找不到开始标记、结束标记，或 cwd 段位置异常时抛错（fail closed，绝不带着文档继续跑）。
// 示例：excludePiDocumentation("...<docs>...</docs>...cwd...") 返回中间文档段被移除的提示。
export function excludePiDocumentation(defaultPrompt: string): string {
	const documentationStartMarker = "\n<docs>\n";
	const documentationEndMarker = "\n</docs>";
	const documentationStart = defaultPrompt.indexOf(documentationStartMarker);
	// 没有文档段说明默认提示结构已变化，无法安全构造对照。
	if (documentationStart === -1) throw new Error("Default Pi system prompt has no Pi documentation section.");
	// 从开始标记之后找结束标记，避免匹配到前面的同名文本。
	const documentationEnd = defaultPrompt.indexOf(documentationEndMarker, documentationStart);
	if (documentationEnd === -1) throw new Error("Default Pi system prompt has no complete Pi documentation section.");
	// 用最后出现的 <cwd> 作为工作目录段；它必须在文档段之后，否则拼接会破坏提示结构。
	const cwdStart = defaultPrompt.lastIndexOf("\n<cwd>\n");
	if (cwdStart < documentationEnd) throw new Error("Default Pi system prompt has no working-directory section.");
	// 拼接前后两段，越过结束标记本身（+ length），从而完全删除 docs 段。
	return (
		defaultPrompt.slice(0, documentationStart) + defaultPrompt.slice(documentationEnd + documentationEndMarker.length)
	);
}

// 文档 harness 选项：Omit 去掉 name/transformSystemPrompt/expectedPiDocumentation，
// 因为这些由工厂根据变体强制设置，调用者不能覆盖。
type DocumentationHarnessOptions = Omit<
	PiCodingAgentHarnessOptions,
	"name" | "transformSystemPrompt" | "expectedPiDocumentation"
>;
// 带 output 的文档 harness 选项同理。Omit 是纯编译期工具类型。
type DocumentationHarnessWithOutput<TOutput extends JsonValue> = Omit<
	PiCodingAgentHarnessWithOutput<TOutput>,
	"name" | "transformSystemPrompt" | "expectedPiDocumentation"
>;

// 文档对照评测 harness 工厂。重载与通用工厂一致：有 output 回调返回 TOutput，否则返回 string。
// 运行时先强制检查容器环境与沙箱身份，再按 PI_EVAL_VARIANT 选择变体：
// - without_docs 注入 excludePiDocumentation 并期望最终提示没有文档；
// - with_docs 不改提示并期望有文档；
// - 两者都默认使用 DOCUMENTATION_EVAL_TOOLS 白名单。
// 示例：createPiDocumentationEvalHarness() -> Harness<PiCodingAgentInput, string>。
export function createPiDocumentationEvalHarness<TOutput extends JsonValue>(
	options: DocumentationHarnessWithOutput<TOutput>,
): Harness<PiCodingAgentInput, TOutput>;
export function createPiDocumentationEvalHarness(
	options?: DocumentationHarnessOptions,
): Harness<PiCodingAgentInput, string>;
export function createPiDocumentationEvalHarness<TOutput extends JsonValue>(
	options: DocumentationHarnessOptions | DocumentationHarnessWithOutput<TOutput> = {},
) {
	// 只有容器入口设置 PI_EVAL_CONTAINER=1 且配置了沙箱 uid/gid 时才允许运行。
	// 这是安全边界：在开发者本机上直接跑文档评测会绕过降权和文件保护。
	if (process.env.PI_EVAL_CONTAINER !== "1" || !resolveSandboxIdentity()) {
		throw new Error("Documentation evals must run in the isolated container sandbox.");
	}
	const variant = resolveDocumentationVariant();
	return createPiCodingAgentHarness({
		...options,
		// 用变体名覆盖可能来自 options 的名称（类型上已被 Omit 排除，但展开仍可能带额外属性）。
		name: variant,
		// 调用者可以给更窄的工具集；默认使用文档评测白名单。
		tools: options.tools ?? [...DOCUMENTATION_EVAL_TOOLS],
		// 条件展开：只有 without_docs 才注入删除文档段的变换。
		...(variant === "without_docs" ? { transformSystemPrompt: excludePiDocumentation } : {}),
		// 最终提示必须与变体一致，由 verifySystemPrompt 在运行后检查。
		expectedPiDocumentation: variant === "with_docs",
	});
}
