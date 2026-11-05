// CLI 启动协调层：先处理一次性命令，再选会话和可信目录、创建服务，最后进入交互/打印/RPC；真正模型与工具循环位于 SDK 下游。
/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

// readline 用于跨项目会话复制前的简单终端确认。
import { createInterface } from "node:readline";
// ImageContent 仅是图片块类型；modelsAreEqual 比较模型身份供候选范围选择。
import { type ImageContent, modelsAreEqual } from "@earendil-works/pi-ai";
// 终端能力覆盖由最终设置应用到 TUI 模块。
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
// chalk 提供终端着色函数，不改变控制流。
import chalk from "chalk";
// 导入 CLI 输入/模式类型、会话名规范化、参数解析与帮助输出入口。
import { type Args, type Mode, normalizeSessionName, parseArgs, printHelp } from "./cli/args.ts";
// 下面是一组认证检查能力，普通聊天启动不会必然执行它们。
import {
	// 认证状态结果类型，区分 ready/not_ready/invalid。
	type AuthCheckResult,
	// 检查认证可用性，区别于发送真实模型聊天请求。
	checkProviderAuth,
	// 为 auth check 创建无需联网刷新模型目录的运行时。
	createAuthCheckModelRuntime,
	// 在显式要求时取得可打印凭证，可能触发 OAuth 刷新。
	getProviderCredential,
	// 以上符号来自认证检查适配层。
} from "./cli/auth-check.ts";
// 下面集中导入认证子命令的解析/校验/文案能力。
import {
	// 认证命令的判别联合类型。
	type AuthCommand,
	// 可识别的命令参数错误类。
	AuthCommandError,
	// 按认证命令种类取得展示名称。
	getAuthCommandName,
	// 按种类取得帮助用法字符串。
	getAuthCommandUsage,
	// 识别认证子命令帮助请求。
	isAuthCommandHelp,
	// 将原始 argv 解析成认证命令或表示非认证命令的 undefined。
	parseAuthCommand,
	// 打印认证专用帮助。
	printAuthCommandHelp,
	// 验证认证命令允许的参数组合。
	validateAuthCommandArgs,
	// 所有认证命令语法都由同一模块维护。
} from "./cli/auth-command.ts";
// 为 print-api-key/print-bearer-token 选择唯一凭证；返回值是真实秘密文字。
import { resolveCredentialForPrint } from "./cli/credential-print.ts";
// 读取 @file 文本或图片内容，具体文件错误向外抛。
import { processFileArguments } from "./cli/file-processor.ts";
// 将 stdin、文件文字与第一条 CLI 问题拼成初始输入，且会消费 parsed.messages 首项。
import { buildInitialMessage } from "./cli/initial-message.ts";
// 列出模型目录，接受可选搜索模式。
import { listModels } from "./cli/list-models.ts";
// 把 CLI 当前模式/启动 UI 适配成项目信任上下文；创建它不等于已经弹窗。
import { createProjectTrustContext } from "./cli/project-trust.ts";
// 显示已有会话选择器，按需调用本地/全局列表回调。
import { selectSession } from "./cli/session-picker.ts";
// 首次主题/分析选项初始化及通用启动选择器。
import { shouldRunFirstTimeSetup, showFirstTimeSetup, showStartupSelector } from "./cli/startup-ui.ts";
// 应用名、版本、动态环境变量名与安装/用户配置路径都从 config 统一取得。
import { APP_NAME, ENV_SESSION_DIR, expandTildePath, getAgentDir, getPackageDir, VERSION } from "./config.ts";
// 运行时容器负责后续切换，工厂类型约束 main 中保存的重建回调。
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./core/agent-session-runtime.ts";
// 分组导入目录服务创建与会话装配的两个阶段。
import {
	// 结构化诊断类型，CLI 决定打印和退出策略。
	type AgentSessionRuntimeDiagnostic,
	// 现成服务上创建 AgentSession，避免重复加载资源。
	createAgentSessionFromServices,
	// 创建 cwd 相关模型/设置/资源服务，但还未发起问答。
	createAgentSessionServices,
	// 两个装配阶段共享此模块的服务契约。
} from "./core/agent-session-services.ts";
// 统一无可用模型时的说明文本。
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
// 普通认证存储可持久化刷新；ReadOnlyAuthStorage 用于显式不刷新的读取。
import { AuthStorage, ReadOnlyAuthStorage } from "./core/auth-storage.ts";
// 会话 JSONL 导出为 HTML 的入口，会写目标文件。
import { exportFromFile } from "./core/export-html/index.ts";
// 宿主直接传入扩展的类型，只在 TS 检查时使用。
import type { InlineExtension } from "./core/extensions/types.ts";
// 应用代理设置并配置 HTTP dispatcher，影响后续网络请求。
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
// 把 CLI 模型引用/范围解析成具体元数据与可选思考级别。
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
// 模型目录、认证和供应商请求路由运行时。
import { ModelRuntime } from "./core/model-runtime.ts";
// 接管 stdout 防止扩展日志污染机器输出，完成打印模式后再恢复。
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
// AppMode 包含四种宿主模式；resolveProjectTrusted 执行实际信任规则。
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
// SDK 会话配置类型用于本文件的参数翻译，不在此重复定义全部字段。
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
// 恢复文件记录的 cwd 已消失时，使用以下检测与提示能力。
import {
	// 构造交互选择器的目录缺失提示。
	formatMissingSessionCwdPrompt,
	// 检查会话是否引用不存在的工作目录。
	getMissingSessionCwdIssue,
	// 非交互模式用这个错误形成明确失败消息。
	MissingSessionCwdError,
	// 缺失目录问题的数据结构类型。
	type SessionCwdIssue,
	// 以上是目录问题处理模块的入口。
} from "./core/session-cwd.ts";
// 会话历史工厂与显式 session id 的校验规则。
import { assertValidSessionId, SessionManager } from "./core/session-manager.ts";
// 收集设置解析问题，并将多阶段重复诊断去重。
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "./core/settings-diagnostics.ts";
// 设置合并及存取入口，信任状态影响是否读取项目设置。
import { SettingsManager } from "./core/settings-manager.ts";
// 性能计时的初始化、标记与输出函数。
import { printTimings, resetTimings, time } from "./core/timings.ts";
// 判断项目是否有需信任资源，并读取/保存持久信任决策。
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
// 随应用提供的内置扩展工厂列表。
import { builtInExtensions } from "./extensions/index.ts";
// MCP CLI 懒加载入口，仅 mcp 子命令才加载其实现。
import { loadMcpCommand } from "./extensions/mcp/cli.lazy.ts";
// 启动前迁移旧数据，并在交互模式展示弃用提示。
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
// 三类运行模式的入口；json 是打印模式的一种输出格式。
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
// 主题初始化、JSON 校验器注入与文件 watcher 清理。
import { initTheme, setThemeJsonValidator, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
// 主题文件的运行时 schema 校验器。
import { validateThemeJson } from "./modes/interactive/theme/theme-schema.ts";
// 处理包更新/安装/配置等一次性命令，并清理受管理安装的残留状态。
import { cleanupManagedInstall, handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
// 识别本地路径，并统一规范/绝对化 CLI 资源路径。
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";
// 清理 Windows 自更新时隔离的旧安装目录。
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

// 扩展加载失败时展示的恢复建议，模板只在模块加载时插入应用名，不执行命令。
const EXTENSION_LOAD_FAILURE_HINT = `Hint: Start without extensions using "${APP_NAME} -ne".`;

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
// 收集管道 stdin。无参数，返回去首尾空白后的文本或 undefined；会注册流监听并等待结束。
// TTY 直接跳过；例如 echo hello | pi 得到 hello；空白管道当无输入。此实现未单独监听 stdin error，其他启动错误交外层处理。
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	// TTY 表示终端交互输入，不应当作一次读到结束的管道。
	if (process.stdin.isTTY) {
		// 返回 undefined，让后面保留交互输入通道。
		return undefined;
	}

	// Promise executor 在创建时立即注册监听；resolve 使外层 await 在 end 后恢复。
	return new Promise((resolve) => {
		// 局部缓冲字符串累积所有输入，不做分段发送。
		let data = "";
		// 让后续 data 事件直接返回 UTF-8 字符串。
		process.stdin.setEncoding("utf8");
		// data 回调输入当前文字块，无返回值，副作用是追加缓冲；只有流实际收到数据时才运行。
		process.stdin.on("data", (chunk) => {
			// += 把当前块连接到完整 stdin 文本。
			data += chunk;
		});
		// end 回调无输入，在管道关闭时决定最终结果并完成 Promise。
		process.stdin.on("end", () => {
			// trim 去首尾空白；|| 把空结果转成 undefined。
			resolve(data.trim() || undefined);
		});
		// 主动让流进入 flowing 状态，开始消费管道输入。
		process.stdin.resume();
	});
}

// 输出诊断。输入只读数组，无返回值；逐条按严重程度着色写 stderr，不改变数组，也不退出。
// 例如 error 显示红色 Error: 前缀，info 使用暗色文字。
function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	// for...of 按列表顺序处理每条诊断。
	for (const diagnostic of diagnostics) {
		// 嵌套三元表达式选择一个颜色函数，此刻还没输出文字。
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		// error/warning 有对应英文前缀，info 前缀为空。
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		// 调用颜色函数并写 stderr，避免混入正常 stdout 结果。
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

// 解析环境变量开关。输入可能不存在的字符串，返回 boolean，无副作用。
// 只接受 1/true/yes（后两者忽略大小写），例如 TRUE 为 true，带空白的 true 不会自动 trim。
function isTruthyEnvFlag(value: string | undefined): boolean {
	// undefined 或空串立即视为关闭。
	if (!value) return false;
	// 按明确白名单判断，不把任意非空字符串都当 true。
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

// 决定宿主运行模式。输入参数与两个 TTY 状态，返回四种模式之一，无副作用。
// 优先 rpc/json；其次 -p 或任一非 TTY 就 print；其余 interactive。例如重定向 stdout 到文件会转打印模式。
function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
	// 显式 RPC 优先于自动管道/TTY 推断。
	if (parsed.mode === "rpc") {
		// 返回 RPC 协议运行模式。
		return "rpc";
	}
	// 显式 JSON 使用打印流程的 JSON 输出，而不是 RPC。
	if (parsed.mode === "json") {
		// 返回 json 宿主模式。
		return "json";
	}
	// 显式 print、输入是管道或输出非终端都采用一次性打印。
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
		// 返回普通打印模式。
		return "print";
	}
	// 剩余条件才启动交互终端 UI。
	return "interactive";
}

// 把宿主模式转成打印层格式。输入 AppMode，返回 text/json，无副作用；Exclude 在类型层去掉 rpc。
// 例如 print 映射 text，json 保留 json；调用方只在打印分支使用。
function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	// 用一个三元表达式完成格式映射。
	return appMode === "json" ? "json" : "text";
}

// 判断是否为普通帮助/模型列表命令。输入解析结果，返回布尔值，无副作用。
// 未显式 print/mode 时的 --help 返回 true，使帮助输出不用走机器输出接管策略。
function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	// 必须没开 -p、没指定 mode，并请求 help 或 listModels；!==undefined 可保留布尔/空搜索形式。
	return !parsed.print && parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}

// 尝试处理认证子命令。输入原始 argv，返回是否已处理；可能写秘密到 stdout、刷新/保存 OAuth、设置退出码。
// 先专用帮助/解析→通用参数校验→打印凭证或检查状态。例如 auth check 的 ready 返回退出码 0，但不表示已发送聊天请求。非认证命令返回 false 让 main 继续。
async function runAuthCommand(args: string[]): Promise<boolean> {
	// 认证专用帮助优先，不需要创建模型运行时。
	if (isAuthCommandHelp(args)) {
		// 立即输出认证帮助文字。
		printAuthCommandHelp();
		// true 表示 main 不要再把这组参数按聊天命令解释。
		return true;
	}

	// 声明可选判别联合命令对象，稍后由解析器赋值。
	let command: AuthCommand | undefined;
	// 专用解析可能因缺少子命令参数抛错。
	try {
		// 识别 auth 子命令，并保留其剩余通用参数。
		command = parseAuthCommand(args);
		// 把语法错误转换成 CLI 输出与失败码。
	} catch (error) {
		// 已知命令错误用具体消息，其他异常避免直接泄漏任意内部细节。
		const message = error instanceof AuthCommandError ? error.message : "Failed to parse auth command";
		// 向 stderr 输出红色错误。
		console.error(chalk.red(`Error: ${message}`));
		// 设置退出码而非立即强制退出，让调用链自然结束。
		process.exitCode = 1;
		// 解析失败仍算已处理，不能继续启动普通聊天。
		return true;
	}
	// 没有匹配认证命令，交给 main 其他命令流程。
	if (!command) return false;

	// 专用开关移除后，剩余参数用通用 CLI 解析器处理。
	const parsed = parseArgs(command.args);
	// 认证命令不允许扩展式未知参数，在这里直接报错。
	if (parsed.unknownFlags.size > 0) {
		// 读取 Map 第一个未知参数名，用于简短错误提示。
		const option = parsed.unknownFlags.keys().next().value;
		// 输出具体参数名和当前认证子命令名称。
		console.error(chalk.red(`Unknown option --${option} for "${getAuthCommandName(command.kind)}".`));
		// 附上主帮助/当前子命令用法，方便用户纠正。
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getAuthCommandUsage(command.kind)}".`));
		// 未知参数按普通命令参数失败设置 1。
		process.exitCode = 1;
		// 终止该命令处理，避免继续解析凭证。
		return true;
	}
	// 以下认证与校验错误统一映射为可控 CLI 失败结果。
	try {
		// 通用解析器留下诊断时，不带错误继续认证。
		if (parsed.diagnostics.length > 0) {
			// 将诊断消息逐条拼为多行命令错误；map 输入一条诊断返回文字，join 插换行。
			throw new AuthCommandError(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		}
		// 非 check 分支是显式打印 API Key 或 Bearer token。
		if (command.kind !== "check") {
			// 创建 15 秒后自动取消的信号；数字中的下划线仅提高可读性。
			const signal = AbortSignal.timeout(15_000);
			// 创建模型/认证运行时，禁止此时联网刷新模型目录；后续 OAuth 刷新仍可联网。
			const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, signal });
			// 等待选择并解析唯一可导出的秘密值，失败向本层 catch 传播。
			const credential = await resolveCredentialForPrint(
				// 传入通用参数，包括目标 provider/model。
				parsed,
				// 共享刚创建的认证运行时。
				modelRuntime,
				// kind 决定 API Key 或 OAuth Bearer 类型筛选。
				command.kind,
				// 传可选的最小 OAuth 剩余有效期要求。
				command.minExpiryMs,
				// 将启动超时信号传给实际认证读取/刷新。
				signal,
			);
			// 这是命令明确要求的秘密输出，追加一个换行，不记录其他文字到 stdout。
			process.stdout.write(`${credential}\n`);
			// 打印结束，main 无需继续启动会话。
			return true;
		}

		// check 分支先验证目标参数组合；错误由外层 catch 处理。
		const requestedAuth = validateAuthCommandArgs(parsed, command.kind);
		// 声明认证状态结果，后面 try/catch 两条路径都会赋值。
		let result: AuthCheckResult;
		// 只有明确要求 --credentials 且状态 ready 才尝试取得秘密。
		let credential: string | undefined;
		// 认证运行时和存储异常在此统一变为 invalid_state。
		try {
			// noRefresh 选择只读存储，避免持久化刷新；否则使用正常可写认证存储。
			const credentials = command.noRefresh ? new ReadOnlyAuthStorage() : AuthStorage.create();
			// 用该存储创建轻量认证检查运行时，不先做模型网络刷新。
			const modelRuntime = await createAuthCheckModelRuntime(credentials);
			// 传 refresh 明确决定是否走真实认证解析/可能的 OAuth 刷新。
			result = await checkProviderAuth(parsed, modelRuntime, { refresh: !command.noRefresh });
			// 仅在要求输出凭证且状态 ready 时读取秘密，普通 check 不打印秘密。
			if (command.credentials && result.status === "ready") {
				// 等待当前已确定供应商的可导出凭证。
				credential = await getProviderCredential(result.provider, modelRuntime, credentials, {
					// 同样遵循 noRefresh；不刷新 OAuth 时可返回存储中的现有 access。
					refresh: !command.noRefresh,
				});
				// 状态 ready 但拿不到实际字符串时需要降为未准备好。
				if (!credential) {
					// 保留供应商，给出 credential_not_available 原因。
					result = { status: "not_ready", provider: result.provider, reason: "credential_not_available" };
				}
			}
			// 认证检查内部异常不把原始异常文本直接输出为状态 JSON。
		} catch {
			// 构造统一异常状态结果。
			result = {
				// invalid 区别于仅未配置凭证的 not_ready。
				status: "invalid",
				// 有 provider 用它，否则非空断言 model! 依赖前面参数验证；! 不做运行时补值。
				provider: requestedAuth.provider ?? requestedAuth.model!,
				// 隐藏底层错误细节，使用稳定机器可读原因码。
				reason: "invalid_state",
			};
		}
		// 输出格式由认证子命令的 json 标志决定。
		const output = command.json
			? // JSON 分支展开状态，再条件展开 credentials 字段；无秘密时不附字段。
				JSON.stringify({ ...result, ...(credential ? { credentials: credential } : {}) })
			: // 普通文字优先输出请求到的凭证，否则仅输出状态名。
				(credential ?? result.status);
		// 一次写出结果加换行，方便脚本读取。
		process.stdout.write(`${output}\n`);
		// 嵌套三元设置稳定退出码：ready=0、not_ready=1、invalid=2。
		process.exitCode = result.status === "ready" ? 0 : result.status === "not_ready" ? 1 : 2;
		// 参数/凭证解析错误的最终出口。
	} catch (error) {
		// 命令错误保留具体消息，其他异常用统一凭证失败提示。
		const message = error instanceof AuthCommandError ? error.message : "Failed to resolve credential";
		// 错误文字写 stderr，不混入凭证 stdout。
		console.error(chalk.red(`Error: ${message}`));
		// check 的参数/状态异常为 2，打印秘密命令失败为 1。
		process.exitCode = command.kind === "check" ? 2 : 1;
	}
	// 只要识别成认证命令，无论成功失败都阻止普通聊天启动。
	return true;
}

// 准备首次输入。输入解析结果和可选 stdin，返回文字/图片；会读取 @file，并由 buildInitialMessage 消费第一条 messages。
// 不在这里请求模型；例如 stdin=A、文件=B、首问=C 拼成 ABC，余下消息留给模式入口继续发送。
async function prepareInitialMessage(
	// 参数包含 @file 列表以及一个或多个文字问题。
	parsed: Args,
	// 管道输入已被上层收集，可省略。
	stdinContent?: string,
	// Promise 内联对象类型描述返回的两个可选字段。
): Promise<{
	// 拼好的首句文字，完全无输入时可没有。
	initialMessage?: string;
	// 独立图片内容块，不串成文本。
	initialImages?: ImageContent[];
	// 结束内联返回类型后开始函数体。
}> {
	// 没有 @file 时省去文件读取步骤。
	if (parsed.fileArgs.length === 0) {
		// 直接转交拼接助手，它仍可能消费 parsed.messages 首项。
		return buildInitialMessage({ parsed, stdinContent });
	}

	// AgentSession resizes these after extension hooks select the request model.
	// 读取所有文件并解构 text/images；先不缩图，等扩展选出请求模型再由会话按能力调整。
	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages: false });
	// 把文件结果和其他输入一起交给统一拼接器。
	return buildInitialMessage({
		// 传入可被消费首消息的同一 parsed 对象。
		parsed,
		// 文件文字单独标记，拼接器按 stdin→文件→问题顺序使用。
		fileText: text,
		// 文件图片通过独立字段返回，避免丢失多模态内容。
		fileImages: images,
		// 保留可选管道文字。
		stdinContent,
	});
}

/** Result from resolving a session argument */
// 判别联合描述“如何找到会话”；switch(type) 后 TS 能知道当前分支有哪些字段。
type ResolvedSession =
	// 含路径分隔符或 .jsonl 的参数直接解析为文件地址。
	| { type: "path"; path: string } // Direct file path
	// 本项目找到的会话有 path，不必附 cwd。
	| { type: "local"; path: string } // Found in current project
	// 其他项目找到的会话额外携带原 cwd，以决定是否复制到当前目录。
	| { type: "global"; path: string; cwd: string } // Found in different project
	// 找不到时保留原输入 arg，用于明确报错。
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
// 按完整 id 查当前项目。输入 id/cwd/可选日志目录，返回 local 结果或 undefined；只读会话头。
// 例如完整 UUID 命中时省去完整元数据扫描；这个函数不处理前缀，上方旧英文宽泛描述实际由下面 resolveSessionPath 承担。
function findLocalSessionByExactId(
	// 要求完整 session id，不在此做 startsWith。
	sessionId: string,
	// 限制搜索所属项目。
	cwd: string,
	// 可覆盖默认日志目录。
	sessionDir?: string,
	// 返回类型只有 local 或没有结果，不返回其他项目。
): { type: "local"; path: string } | undefined {
	// 调用轻量会话头索引查找。
	const path = SessionManager.findById(cwd, sessionId, sessionDir);
	// 有路径就封装判别字段，未找到保持 undefined。
	return path ? { type: "local", path } : undefined;
}

// 把会话参数解析为目标。输入字符串、当前 cwd、可选目录；异步返回路径/本地/跨项目/未找到，无会话写入。
// 顺序：路径形式→完整本地 id→本地前缀→全局完整/前缀。例如短 id 优先匹配当前项目；没有额外拒绝多个前缀候选，find 取列表首项。
async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, resolve it before handing it to the session manager.
	// 有 /、反斜线或 .jsonl 后缀就按路径处理，不尝试 id 搜索。
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		// 相对当前 cwd 解析绝对路径，但不在此确认文件真实存在。
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	// Exact IDs only require reading session headers. Fall back to the full
	// metadata listing for prefix matches.
	// 完整本地 id 先走低成本查询。
	const exactLocalMatch = findLocalSessionByExactId(sessionArg, cwd, sessionDir);
	// 命中后无需再扫描消息/全局目录。
	if (exactLocalMatch) {
		// 直接返回 local 判别结果。
		return exactLocalMatch;
	}

	// 完整查询未命中才异步列出本项目会话元数据。
	const localSessions = await SessionManager.list(cwd, sessionDir);
	// find 回调判断 id 前缀，返回列表中第一项匹配。
	const localMatch = localSessions.find((s) => s.id.startsWith(sessionArg));

	// 本地前缀命中优先于其他项目。
	if (localMatch) {
		// 把命中会话的实际文件路径返回。
		return { type: "local", path: localMatch.path };
	}

	// Try global search across all projects
	// 本地找不到，再跨项目列出会话。
	const allSessions = await SessionManager.listAll(sessionDir);
	// 接下来的多行表达式先完整、后前缀匹配。
	const globalMatch =
		// ?? 在完整 id 无结果时才寻找前缀，find 顺序仍由列表顺序决定。
		allSessions.find((s) => s.id === sessionArg) ?? allSessions.find((s) => s.id.startsWith(sessionArg));

	// 全局命中需要把原项目 cwd 一起返回。
	if (globalMatch) {
		// 宿主可以提示来源目录，并在需要时 fork 到当前 cwd。
		return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
	}

	// Not found anywhere
	// 所有路径都失败后保留原参数生成 not_found 结果。
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
// 显示简单 yes/no 确认。输入提示文字，异步返回 boolean；会读 stdin、写 stdout 并关闭 readline。
// 只有 y/yes（忽略大小写）为 true，直接回车按否；例如跨项目恢复前确认是否复制。
async function promptConfirm(message: string): Promise<boolean> {
	// 把基于回调的 readline 接口包成可 await 的 Promise。
	return new Promise((resolve) => {
		// 创建一次性终端问答接口。
		const rl = createInterface({
			// 用户回答从当前进程 stdin 读取。
			input: process.stdin,
			// 提示写当前 stdout，非本函数内部的 TUI。
			output: process.stdout,
		});
		// 回答回调输入 answer 字符串，关闭接口并完成 Promise；直到用户提交后才运行。
		rl.question(`${message} [y/N] `, (answer) => {
			// 先释放 readline 监听，避免挂住进程输入。
			rl.close();
			// 不自动 trim，只按小写后的 y/yes 判断肯定。
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

// 检查 --fork 互斥开关。输入解析结果，无返回值；冲突时写 stderr 并立即 exit(1)。
// 例如 --fork 与 --continue 同时出现会拒绝，避免不清楚是复制还是延续会话。
function validateForkFlags(parsed: Args): void {
	// 没有 fork 请求就不执行这组互斥检查。
	if (!parsed.fork) return;

	// 用条件值构建可能的冲突名称列表。
	const conflictingFlags = [
		// 显式 --session 不能和 fork 共用。
		parsed.session ? "--session" : undefined,
		// 最近会话 --continue 与 fork 冲突。
		parsed.continue ? "--continue" : undefined,
		// 选择器 --resume 与 fork 冲突。
		parsed.resume ? "--resume" : undefined,
		// 纯内存 --no-session 与持久化 fork 冲突。
		parsed.noSession ? "--no-session" : undefined,
		// filter 排除 undefined；flag is string 同时缩窄数组元素类型。
	].filter((flag): flag is string => flag !== undefined);

	// 至少一个冲突才报告失败。
	if (conflictingFlags.length > 0) {
		// 用逗号连接所有冲突项，让用户一次看全。
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		// 立即终止 CLI，不会继续创建任何会话。
		process.exit(1);
	}
}

// 检查显式 --session-id 的组合和格式。输入解析结果，无返回值；冲突/非法 id 时打印并退出 1。
// 例如指定 id 同时 --resume 不允许；单独有效 id 后续会先找已有会话。
function validateSessionIdFlags(parsed: Args): void {
	// 只检查确实传过 sessionId 的输入，空串也不能在此跳过校验。
	if (parsed.sessionId === undefined) return;

	// 收集不能与指定 id 共用的会话选择方式。
	const conflictingFlags = [
		// --session 已指定目标，不能再给新的 id 选择。
		parsed.session ? "--session" : undefined,
		// --continue 目标由最近会话决定。
		parsed.continue ? "--continue" : undefined,
		// --resume 目标由选择器决定。
		parsed.resume ? "--resume" : undefined,
		// 删去不存在的项，并用谓词得到 string[]。
	].filter((flag): flag is string => flag !== undefined);

	// 有互斥项就先报告，不继续格式校验。
	if (conflictingFlags.length > 0) {
		// 展示所有冲突开关名称。
		console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
		// 以失败状态立即退出。
		process.exit(1);
	}

	// 格式校验可能抛出具体参数错误。
	try {
		// 复用 SessionManager 的合法 id 规则，避免 CLI 自己另写一套。
		assertValidSessionId(parsed.sessionId);
		// unknown 明确异常未必是 Error，需要读取前区分。
	} catch (error: unknown) {
		// Error 取 message，其他抛出值转字符串。
		const message = error instanceof Error ? error.message : String(error);
		// 显示非法 id 的具体原因。
		console.error(chalk.red(`Error: ${message}`));
		// 阻止创建带非法 id 的会话。
		process.exit(1);
	}
}

// 打开指定日志并把异常变成 CLI 退出。输入路径/可选日志目录，返回 SessionManager；可能读/迁移文件。
// 例如损坏 JSONL 导致 open 抛错时，这里打印并 exit(1)，不向调用方返回空对象。
function openSessionOrExit(path: string, sessionDir?: string): SessionManager {
	// 将底层读取/迁移异常限制在本次命令边界。
	try {
		// 省略 cwdOverride，通常沿用文件头中的项目目录。
		return SessionManager.open(path, sessionDir);
		// 捕获任意底层异常。
	} catch (error: unknown) {
		// 统一转换可显示的错误信息。
		const message = error instanceof Error ? error.message : String(error);
		// 错误走 stderr。
		console.error(chalk.red(`Error: ${message}`));
		// 失败后立即退出，函数不会继续返回。
		process.exit(1);
	}
}

// 把源会话复制成当前项目新会话。输入源地址、目标 cwd、目录和可选新 id；返回新管理器，读写文件。
// forkFrom 会创建新头和新文件，原历史保留；失败打印并 exit(1)。例如把 /a 项目历史复制到 /b。
function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string, sessionId?: string): SessionManager {
	// 捕获文件读取、id 校验和独占写入等失败。
	try {
		// 传入新 id（可 undefined），使用完整源历史生成目标项目会话。
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id: sessionId });
		// 底层异常统一转换为 CLI 失败。
	} catch (error: unknown) {
		// 兼容 Error 和非 Error 抛出值。
		const message = error instanceof Error ? error.message : String(error);
		// 打印具体复制失败原因。
		console.error(chalk.red(`Error: ${message}`));
		// 失败时立即终止启动。
		process.exit(1);
	}
}

// 选择/创建启动历史。输入 CLI 参数、启动 cwd、日志目录和 UI 设置；返回管理器，可能读写日志/打开选择器/退出。
// 按 noSession/help/list→fork→session→resume→continue→sessionId→新建优先处理。例如 --continue 找最近会话，没有则新建；此时还没创建 Agent 或发请求。
export async function createSessionManager(
	// 解析结果决定会话选择模式。
	parsed: Args,
	// 进程启动目录，跨项目复制的目标也使用它。
	cwd: string,
	// 显式联合 undefined 表示第三个参数必须占位，但值可以缺省。
	sessionDir: string | undefined,
	// 启动选择 UI 读取的设置，不一定等于最终会话 cwd 的设置。
	settingsManager: SettingsManager,
	// 异步返回历史管理器，选择器需要等待用户操作。
): Promise<SessionManager> {
	// 无持久化请求、帮助或模型列表都用内存，不意外写会话日志。
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		// 如提供 id 则传给内存管理器；只是创建历史，不运行会话。
		return SessionManager.inMemory(cwd, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
	}

	// 显式 fork 优先于普通新建流程。
	if (parsed.fork) {
		// 指定新 id 时先避免与当前项目已有会话冲突。
		if (parsed.sessionId) {
			// 只按完整 id 查询当前项目是否已有目标。
			const existingTarget = findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
			// 已有同 id 不允许悄悄复用或覆盖。
			if (existingTarget) {
				// 指出具体重复 id。
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				// 退出 1，源与目标均不会在此分支继续复制。
				process.exit(1);
			}
		}

		// 解析 fork 源，可为文件、本地 id、跨项目 id。
		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		// 按 ResolvedSession 的 type 收窄字段。
		switch (resolved.type) {
			// 直接文件路径可作 fork 源。
			case "path":
			// 本项目匹配会话也可作源。
			case "local":
			// 跨项目源同样允许；显式 fork 已表达复制意图，无额外确认。
			case "global":
				// 三种有效源统一复制到启动 cwd，采用可选新 id。
				return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);

			// 没有找到源时不能凭空创建看似成功的分叉。
			case "not_found":
				// 用原始参数说明未匹配源。
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				// 失败退出。
				process.exit(1);
		}
	}

	// 普通 --session 选择流程，与显式 fork 的复制语义不同。
	if (parsed.session) {
		// 解析完整路径或会话 id/前缀。
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		// 按匹配来源决定打开还是询问复制。
		switch (resolved.type) {
			// 直接地址按目标文件打开。
			case "path":
			// 本项目会话直接打开。
			case "local":
				// 共享错误到退出的包装器，不复制这两类结果。
				return openSessionOrExit(resolved.path, sessionDir);

			// 跨项目 id 匹配分支用局部块保存确认变量。
			case "global": {
				// 提示会话原工作目录，以免用户误以为是当前项目日志。
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				// 等待用户确认是否将历史 fork 到当前 cwd。
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				// 用户否定或默认回车时终止。
				if (!shouldFork) {
					// 显示主动取消提示，属于正常结束。
					console.log(chalk.dim("Aborted."));
					// 退出码 0 表示不是系统/参数失败。
					process.exit(0);
				}
				// 同意后复制到当前项目；新 id 由底层生成。
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}

			// 未找到目标会话时报告错误。
			case "not_found":
				// 保留用户输入帮助定位查找失败。
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				// 失败退出，不自动新建替代 session。
				process.exit(1);
		}
	}

	// --resume 打开交互会话列表。
	if (parsed.resume) {
		// 选择器可能加载主题，结束后总要清理 watcher。
		try {
			// 等待 UI 选择一个现有会话路径。
			const selectedPath = await selectSession(
				// 本地列表回调接收进度/取消信号并原样传入；选择器调用时才扫描，不是现在预先执行。
				(onProgress, signal) => SessionManager.list(cwd, sessionDir, onProgress, signal),
				// 全局列表回调同样延迟执行，切换全局视图时可报告进度/取消。
				(onProgress, signal) => SessionManager.listAll(sessionDir, onProgress, signal),
				// 把启动设置交给选择器初始化主题和交互偏好。
				settingsManager,
			);
			// 没选择表示取消或无目标，正常退出。
			if (!selectedPath) {
				// 输出选择结果为空的提示。
				console.log(chalk.dim("No session selected"));
				// 没有错误，退出 0。
				process.exit(0);
			}
			// 打开选中文件，实际 cwd 会从会话头读取。
			return SessionManager.open(selectedPath, sessionDir);
			// finally 无论成功 return 还是异常都会执行。
		} finally {
			// 停止选择器启动的主题监听，后面正式 UI 再按需初始化。
			stopThemeWatcher();
		}
	}

	// --continue 不显示选择器，直接找当前项目最近会话。
	if (parsed.continue) {
		// 底层没有最近会话时会新建，仍返回一个管理器。
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	// 独立 --session-id 优先尝试恢复精确同 id 的本地日志。
	if (parsed.sessionId) {
		// 仅完整 id、本项目匹配。
		const existingSession = findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		// 已有会话则直接恢复，不重复创建。
		if (existingSession) {
			// 返回该文件的管理器。
			return SessionManager.open(existingSession.path, sessionDir);
		}
		// 没有该 id 时先输出警告，再在后面新建相同 id。
		console.error(
			// 警告用黄色，区别于退出错误。
			chalk.yellow(
				// 模板中指出 id 及即将新建的行为；整条文字不被修改。
				`Warning: No project session found with id '${parsed.sessionId}'; creating a new session with that id.`,
			),
		);
	}

	// 默认创建新会话；传入 id 为 undefined 时底层生成 id，通常尚未立即写首条对话文件。
	return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}

// 将 CLI 模型/工具选项翻译为 SDK 输入。输入解析参数、候选模型、是否恢复、运行时和设置；返回 options、思考来源标志及诊断，无请求发送。
// 显式模型优先，新会话可从 --models 范围挑默认，显式 --thinking 最终覆盖范围值；例如 --model p/m:high 会记录思考来自模型后缀。
function buildSessionOptions(
	// 原始 CLI 的结构化解析结果。
	parsed: Args,
	// 已解析的模型范围，供新会话初选及 Ctrl+P 循环使用。
	scopedModels: ScopedModel[],
	// 已有消息时不要让范围首项覆盖历史模型恢复。
	hasExistingSession: boolean,
	// 用于解析模型 id、认证状态和元数据。
	modelRuntime: ModelRuntime,
	// 提供保存的默认模型和思考设置。
	settingsManager: SettingsManager,
	// 下面是内联返回对象类型，不是运行时对象值。
): {
	// 待交给 SDK 的配置对象。
	options: CreateAgentSessionOptions;
	// 是否从 CLI 模型后缀取得思考级别，供后续标记显式覆盖。
	cliThinkingFromModel: boolean;
	// 参数解析中的 warning/error 列表。
	diagnostics: AgentSessionRuntimeDiagnostic[];
	// 返回类型结束后进入实际函数体。
} {
	// 从空配置开始，只写 CLI/范围明确决定的字段，其他交 SDK 恢复/兜底。
	const options: CreateAgentSessionOptions = {};
	// 收集问题而不是直接打印或退出。
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	// 默认不认为 CLI 从模型后缀覆盖思考。
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	// 只有 provider 却没有 model 时不能构成明确选择。
	if (parsed.provider && !parsed.model) {
		// 追加可操作的参数错误，后面仍继续收集其他问题。
		diagnostics.push({
			// 将此诊断标为 error。
			type: "error",
			// 示例提示在文字里展示 provider/model 组合，不在运行时自动选择模型。
			message: `--provider requires --model (for example: --provider ${parsed.provider} --model <pattern>)`,
		});
	}
	// 确实提供模型引用才调用解析器。
	if (parsed.model) {
		// 同步按当前目录解析具体模型和可选思考后缀。
		const resolved = resolveCliModel({
			// 可选供应商限制，例如 --provider p。
			cliProvider: parsed.provider,
			// 模型引用可包含 provider 前缀/模式。
			cliModel: parsed.model,
			// 显式思考参数传给解析器处理优先级/冲突。
			cliThinking: parsed.thinking,
			// Boolean 仅表示是否有内联 API Key，帮助模型选择；秘密本身稍后才设置到运行时。
			inlineApiKey: Boolean(parsed.apiKey),
			// 使用当前目标 cwd 的模型目录/认证配置。
			modelRuntime,
		});
		// 解析器可能同时给模型和提示，warning 不直接阻止选择。
		if (resolved.warning) {
			// 把警告包装到统一诊断数组。
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		// 具体解析错误也放入诊断，交启动层最终决定退出。
		if (resolved.error) {
			// 保留解析器提供的错误文字。
			diagnostics.push({ type: "error", message: resolved.error });
		}
		// 成功选到具体模型才写 SDK 选项。
		if (resolved.model) {
			// 保存元数据引用，不复制或运行模型。
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			// 显式 --thinking 没提供且解析到后缀级别时，先使用后缀。
			if (!parsed.thinking && resolved.thinkingLevel) {
				// 把后缀思考选择传给 SDK。
				options.thinkingLevel = resolved.thinkingLevel;
				// 记录这是用户 CLI 直接选择，区别于默认范围配置。
				cliThinkingFromModel = true;
			}
		}
	}

	// 无显式模型、范围非空且是新会话时，从范围选择初始模型。
	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		// 读取保存的默认供应商。
		const savedProvider = settingsManager.getDefaultProvider();
		// 读取保存的默认模型 id。
		const savedModelId = settingsManager.getDefaultModel();
		// 两个默认字段都存在才查询模型，否则不给假定的半截选择。
		const savedModel = savedProvider && savedModelId ? modelRuntime.getModel(savedProvider, savedModelId) : undefined;
		// find 回调比较模型身份，在候选范围找出保存的默认模型。
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		// 保存默认仍在允许循环范围中时优先使用它。
		if (savedInScope) {
			// 采用范围里的那份模型对象。
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			// 范围项有思考设置且无显式覆盖时使用它。
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				// 保存该候选项的级别。
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
			// 保存默认不在范围时退回第一个范围项。
		} else {
			// 范围已确认非空，因此 [0] 是可用初选。
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			// 首项有思考设置且无显式 --thinking 时采用。
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				// 保存首项级别。
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	// 显式 --thinking 在本函数最后覆盖前面的模型后缀/范围配置。
	if (parsed.thinking) {
		// 将 CLI 级别写入 SDK 参数。
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	// 有模型范围才传给会话，供交互快捷切换。
	if (scopedModels.length > 0) {
		// map 回调输入范围项，返回只含模型和可选级别的新对象，不执行切换。
		options.scopedModels = scopedModels.map((sm) => ({
			// 保留模型元数据。
			model: sm.model,
			// 未定义保持 undefined，切换时表示继承当前会话级别。
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set as a non-persistent runtime override
	// (handled by caller before createAgentSession)

	// Tools
	// --no-tools 代表全面抑制默认工具。
	if (parsed.noTools) {
		// SDK 使用 all 字面量表达这个模式。
		options.noTools = "all";
		// 未全禁用但传 --no-builtin-tools 时，只抑制内置默认工具。
	} else if (parsed.noBuiltinTools) {
		// SDK 使用 builtin 模式，让扩展/自定义工具仍可按默认规则启用。
		options.noTools = "builtin";
	}
	// 存在显式工具列表（包括空数组）就传给 SDK。
	if (parsed.tools) {
		// 数组展开复制列表，避免直接共用 CLI 数组引用。
		options.tools = [...parsed.tools];
	}
	// 有排除规则也需继续传递。
	if (parsed.excludeTools) {
		// 复制排除列表，SDK 会在允许规则之后应用它。
		options.excludeTools = [...parsed.excludeTools];
	}

	// 把三个并行结果一起返回，不在此创建 AgentSession。
	return { options, cliThinkingFromModel, diagnostics };
}

// 提前解析 CLI 资源本地路径。输入启动 cwd 与可选路径列表，返回对应数组或 undefined，不读取资源。
// 例如 ./ext.ts 固定成启动目录绝对路径，npm: 包源保持原字符串；之后切换 cwd 不会误解释相对路径。
function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	// 可选链省略列表时保持 undefined；map 回调只绝对化 isLocalPath 判定的本地项。
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

// 提示恢复目录已失效。输入问题与 UI 设置，异步返回回退目录或 undefined；只显示选择器，不改历史文件。
// 例如原 /old 已删除，Continue 选择当前 cwd，Cancel 让启动结束。
async function promptForMissingSessionCwd(
	// 包含原 session cwd、日志路径与可用回退 cwd。
	issue: SessionCwdIssue,
	// 用于启动选择器主题/终端偏好。
	settingsManager: SettingsManager,
	// 用户取消时返回 undefined，不默认同意覆盖目录。
): Promise<string | undefined> {
	// 把统一提示和两个选项交给启动 UI。
	return showStartupSelector(settingsManager, formatMissingSessionCwdPrompt(issue), [
		// Continue 的返回值是明确的回退目录地址。
		{ label: "Continue", value: issue.fallbackCwd },
		// Cancel 的返回值为空，后面据此退出。
		{ label: "Cancel", value: undefined },
	]);
}

// main 的可选嵌入配置接口；它不是 CLI argv 参数本身。
export interface MainOptions {
	// 宿主附加内联扩展，与随包内置扩展合并交给加载器。
	extensionFactories?: InlineExtension[];
}

// 运行 CLI。输入 argv 与可选宿主扩展，异步完成；可能迁移/读写设置与日志、处理认证/包命令、打开 UI 或开始问答。
// 流程：一次性命令→参数校验→选会话 cwd→信任/服务/SDK 装配→模式入口。例如 pi -p hello 最后进入 runPrintMode，再由它调用 session.prompt。多个错误分支直接 process.exit。
export async function main(args: string[], options?: MainOptions) {
	// 每次 main 调用重置启动计时，避免重复调用累计旧时间点。
	resetTimings();
	// Commands and startup selectors can load user-authored themes before runtime creation.
	// 在任何启动选择器读用户主题前注入运行时 JSON 校验器；只注册函数，不立即验证所有主题。
	setThemeJsonValidator(validateThemeJson);
	// 数组展开先放内置扩展，再追加宿主选项里的扩展；省略选项时追加空数组。
	const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];
	// 离线模式来自显式 --offline 或环境开关，两者任一为真即可。
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
	// 启用离线时把标志写回环境，供下游模块统一读取。
	if (offlineMode) {
		// 设置运行时离线环境开关，影响后续目录网络行为。
		process.env.PI_OFFLINE = "1";
		// 同时跳过版本检查；这不保证用户自行编写的扩展完全不联网。
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}

	// 先处理认证命令，避免不必要的主题/会话/项目资源启动。
	if (await runAuthCommand(args)) {
		// 认证已处理就结束 main，使用其设置的 exitCode。
		return;
	}

	// 只有 Windows 才清理自更新隔离目录。
	if (process.platform === "win32") {
		// 用统一包根定位旧安装残留，具体清理边界由 helper 实现。
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}
	// 清理受管理安装的过期状态，发生在普通参数解析前。
	cleanupManagedInstall();

	// 声明启动 cwd；process.cwd 可能因目录已被删除而失败。
	let cwd: string;
	// 把读取进程 cwd 的系统错误转为可理解提示。
	try {
		// 取得真正进程启动工作目录，后面选中会话可能使用另一 cwd。
		cwd = process.cwd();
		// 捕获当前目录不可用等异常。
	} catch (error) {
		// 只特别处理 ENOENT，其他系统异常仍抛给外层；as 只为读取 code 提供类型。
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		// 目录失效提示写 stderr。
		console.error(
			// 以红色突出启动错误。
			chalk.red(
				// 固定提示用户先切换到存在目录；不在代码里自动猜另一个目录。
				"Error: The current working directory no longer exists. Change to an existing directory and try again.",
			),
		);
		// 启动目录不可用时立即失败退出。
		process.exit(1);
	}
	// 统一取得用户配置根目录。
	const agentDir = getAgentDir();
	// 启动网络配置阶段暂不信任项目，只读全局设置，避免加载未批准项目设置。
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	// 把全局 HTTP 代理设置应用到后续请求环境。
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	// 配置默认 HTTP dispatcher；此时尚未创建会话服务。
	configureHttpDispatcher();

	// 包安装/更新等命令自行处理参数，处理成功后不走普通聊天分支。
	if (await handlePackageCommand(args, { extensionFactories })) {
		// 使用该命令设定的 exitCode，没有就按成功 0。
		const exitCode = process.exitCode ?? 0;
		// Windows 成功 update 是特殊自然退出路径，避免 Node fetch teardown 断言问题。
		if (process.platform === "win32" && exitCode === 0 && args[0] === "update") {
			// We normally prefer process.exit(0) for package commands so bad extensions cannot keep
			// one-shot commands alive. On Windows, Node can assert after fetch() if process.exit(0)
			// runs during teardown; let successful `pi update` drain naturally instead.
			// https://github.com/nodejs/node/issues/56645
			// 让成功 Windows 更新自然收尾，而不是强制立即退出。
			return;
		}
		// 其他一次性包命令直接按退出码结束，防止扩展残留任务挂住进程。
		process.exit(exitCode);
		// process.exit 通常不返回；保留 return 明确逻辑终止。
		return;
	}

	// 配置命令也先于聊天参数解析，可能展示配置 UI/写设置。
	if (await handleConfigCommand(args, { extensionFactories })) {
		// 配置命令完成后结束 main。
		return;
	}

	// 首个参数为 mcp 时走独立 MCP 管理命令。
	if (args[0] === "mcp") {
		// 等待懒加载模块，普通启动不付出这段加载成本。
		const { runMcpCommand } = await loadMcpCommand();
		// 去掉 mcp 首项，把其余参数和目录传给处理器，并采用其退出码。
		process.exitCode = await runMcpCommand(args.slice(1), { cwd, agentDir });
		// MCP 管理命令不创建聊天会话。
		return;
	}

	// 其余 argv 按普通 coding-agent 参数解析，得到结构化 Args。
	const parsed = parseArgs(args);
	// 诊断可能含警告和错误，先逐条打印。
	if (parsed.diagnostics.length > 0) {
		// for...of 保留解析器诊断顺序。
		for (const d of parsed.diagnostics) {
			// error 红色，其他解析诊断黄色。
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			// 按严重程度构造前缀，将具体消息写 stderr。
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		// some 回调检查是否存在 error，警告本身不要求退出。
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			// 参数错误时退出，避免带错配置继续加载扩展。
			process.exit(1);
		}
	}
	// 记录参数解析阶段耗时点。
	time("parseArgs");

	// --version 是只读一次性输出，直接结束。
	if (parsed.version) {
		// 打印 config 从启动清单得到的版本。
		console.log(VERSION);
		// 版本查询成功退出 0。
		process.exit(0);
	}

	// --export 直接把会话文件导出为 HTML，不走模型运行时。
	if (parsed.export) {
		// 暂存成功导出的实际目标路径。
		let result: string;
		// 文件读取/解析/写入异常都转为 CLI 失败。
		try {
			// 首个位置消息可用作输出文件名，未指定则让导出器决定默认路径。
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			// 真正读取 JSONL 并写 HTML，等待完成。
			result = await exportFromFile(parsed.export, outputPath);
			// 异常可能是 Error 或其他值。
		} catch (error: unknown) {
			// Error 展示其原因，其余使用统一导出失败提示。
			const message = error instanceof Error ? error.message : "Failed to export session";
			// 错误写 stderr。
			console.error(chalk.red(`Error: ${message}`));
			// 导出失败退出 1。
			process.exit(1);
		}
		// 成功后把目标地址展示给用户。
		console.log(`Exported to: ${result}`);
		// 导出成功退出 0，不再初始化聊天。
		process.exit(0);
	}

	// 先按显式模式与当前 TTY 推断宿主模式；后面 stdin 实际内容也可能进一步调整。
	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	// 机器输出模式需要保护 stdout；普通 help/list 的人类可读输出例外。
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	// 只有符合条件才修改 stdout 路由。
	if (shouldTakeOverStdout) {
		// 将普通 process.stdout.write 导向 stderr，真实协议输出由模式层使用 raw stdout 写入。
		takeOverStdout();
	}

	// RPC 的 stdin 用协议通信，不接受 CLI @file 输入形式。
	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		// 输出不支持的参数组合原因。
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		// 立即失败，不把文件内容混入 RPC 协议。
		process.exit(1);
	}

	// 检查 fork 相关互斥开关，失败内部退出。
	validateForkFlags(parsed);
	// 检查 session-id 组合和格式，失败内部退出。
	validateSessionIdFlags(parsed);

	// Run migrations (pass cwd for project-local migrations)
	// 执行旧配置/认证数据迁移；解构时把 migratedAuthProviders 重命名为 migratedProviders，另取弃用警告。
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd);
	// 记录迁移阶段时间点。
	time("runMigrations");

	// 创建启动目录的设置实例，供首次设置与会话选择使用；最终会话设置稍后按其 cwd 再建。
	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	// 收集设置解析/读取诊断，稍后与运行时诊断合并去重。
	const startupSettingsDiagnostics = collectSettingsDiagnostics(startupSettingsManager);

	// Experimental first-time setup: theme choice and analytics opt-in.
	// Runs before any runtime services are created so the chosen settings apply everywhere.
	// 仅正常交互启动且确实首次需要时运行 setup，help/list 不会触发它。
	if (appMode === "interactive" && !parsed.help && parsed.listModels === undefined && shouldRunFirstTimeSetup()) {
		// 等待主题与分析选项选择，结果在服务创建前写入设置。
		await showFirstTimeSetup(startupSettingsManager);
		// 记录首次 setup 耗时。
		time("firstTimeSetup");
	}

	// --use-theme 的临时交互覆盖只应用于交互启动。
	if (appMode === "interactive" && parsed.useTheme !== undefined) {
		// 应用运行期设置覆盖，具体持久化与否由 applyOverrides 语义决定（该方法不写设置文件）。
		startupSettingsManager.applyOverrides({ theme: parsed.useTheme });
	}

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	// 读取按应用名生成的会话目录环境变量。
	const envSessionDir = process.env[ENV_SESSION_DIR];
	// 目录优先级是 CLI→环境→启动目录设置，不把空的可选输入强行当路径。
	const sessionDir =
		// CLI 给目录就先 normalizePath，处理波浪号等形式。
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		// CLI 未给时展开环境目录；?? 不会跳过已经确定的非空字符串。
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		// 两者都缺失时取设置中的 sessionDir，仍可能 undefined 让管理器用默认。
		startupSettingsManager.getSessionDir();
	// 先选定/创建历史，最终会话 cwd 必须在加载项目资源前确定。
	let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
	// 比较文件记录的 cwd 是否存在，并携带当前启动 cwd 作为回退建议。
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	// 仅旧会话目录确实缺失时需要处理。
	if (missingSessionCwdIssue) {
		// 交互模式可以询问是否用当前目录继续。
		if (appMode === "interactive") {
			// 等待选择 Continue/Cancel，不自动改目录。
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			// 取消或无选择就正常结束启动。
			if (!selectedCwd) {
				// 退出 0，不视为配置损坏。
				process.exit(0);
			}
			// 重新打开同一日志并显式覆盖 cwd；! 依赖 issue 来自已存在 sessionFile 的检查，不生成运行时校验。
			sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
			// 脚本/JSON/RPC 没有这段终端选择流程。
		} else {
			// 构造包含原目录/当前目录的具体错误并输出。
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			// 非交互恢复目录失效时失败退出，不悄悄使用回退目录。
			process.exit(1);
		}
	}
	// 用户显式指定会话显示名时才处理，空串也需进入校验。
	if (parsed.name !== undefined) {
		// 按统一规则去除/规范化名字，空名返回 undefined。
		const name = normalizeSessionName(parsed.name);
		// 规范化后空名不合法。
		if (name === undefined) {
			// 提示必须提供非空名字。
			console.error(chalk.red("Error: --name requires a non-empty value"));
			// 参数失败退出。
			process.exit(1);
		}
		// 把会话名写入历史元数据；不是发给模型的一条用户消息。
		sessionManager.appendSessionInfo(name);
	}
	// 会话历史选择完成，记录耗时点。
	time("createSessionManager");

	// 创建持久信任存储，根目录与其他用户配置一致。
	const trustStore = new ProjectTrustStore(agentDir);
	// 读取最终选中会话的有效 cwd，可能不同于进程 cwd。
	const sessionCwd = sessionManager.getCwd();
	// 记录一个 UI 重载时可特殊处理的目录标记，不在此给所有项目永久授信。
	const autoTrustOnReloadCwd =
		// 没有显式信任覆盖，且初始没有需信任的项目资源时才设置标记。
		parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(sessionCwd)
			? // 保存该特定 cwd，供交互模式后续重载逻辑使用。
				sessionCwd
			: // 其余情况不设置此标记。
				undefined;
	// 帮助/模型列表强制使用 print 式信任上下文，避免只看元数据时弹交互授权 UI。
	const trustPromptMode: AppMode = parsed.help || parsed.listModels !== undefined ? "print" : appMode;
	// 进程内缓存每个 cwd 的布尔决策；false 与没查过的 undefined 必须区分。
	const projectTrustByCwd = new Map<string, boolean>();

	// CLI 扩展相对路径按启动 cwd 固定，之后切换会话不重新解释。
	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
	// 同样固定技能来源路径，本地绝对化，包源保持原文字。
	const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	// 同样固定提示词模板来源路径。
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
	// 同样固定额外主题来源路径。
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	// 保存完整运行时工厂回调，输入目标目录/历史/事件/信任上下文，返回会话、服务和诊断。
	// 此处定义不执行；首次和后续 new/resume/fork 才调用。流程是信任准备→服务加载→模型/工具选项→SDK 会话。例如恢复 /b 的历史时会按 /b 重新发现项目资源，而 CLI 扩展路径保持启动时解析结果。
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		// 参数对象解构得到本次目标 cwd，遮蔽外层启动 cwd 只在工厂作用域生效。
		cwd,
		// 使用调用方给定的同一用户配置目录。
		agentDir,
		// 本次新建/打开的历史管理器。
		sessionManager,
		// 首次通常未传事件，替换时有 new/resume/fork 信息。
		sessionStartEvent,
		// 宿主可为后续切换提供适合当前 UI 的信任上下文。
		projectTrustContext,
		// 解构结束后开始异步工厂体；函数被调用后才运行以下资源加载步骤。
	}) => {
		// 用是否有启动事件区分首次和后续重建。
		const isInitialRuntime = sessionStartEvent === undefined;
		// 收集 project_trust 扩展处理时的警告。
		const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
		// 读取当前进程对这个 cwd 的既有信任决策。
		const cachedProjectTrust = projectTrustByCwd.get(cwd);
		// 检查目标项目是否存在需要信任才能加载的资源。
		const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
		// 下面决定是否必须在 reload 阶段正式解决信任问题。
		const shouldResolveProjectTrust =
			// 无显式覆盖、无进程缓存且有项目资源，才需要实际 resolve 流程。
			parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustRequiringResources;
		// 为加载器构造最初信任状态。
		const projectTrusted = shouldResolveProjectTrust
			? // 尚待决策时先设 false，防止在询问前读取受限项目设置。
				false
			: // 否则依次取进程缓存、CLI 覆盖、持久信任、无资源默认允许；?? 保留明确 false。
				(cachedProjectTrust ?? parsed.projectTrustOverride ?? trustStore.get(cwd) ?? !hasTrustRequiringResources);
		// 按本次目标 cwd/信任状态创建新的设置管理器。
		const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		// 实际等待目录服务创建：模型运行时、设置与资源加载器在此准备。
		const services = await createAgentSessionServices({
			// 服务绑定本次目标 cwd。
			cwd,
			// 服务绑定同一用户配置根。
			agentDir,
			// 复用刚创建且具有正确初始信任状态的设置对象。
			settingsManager: runtimeSettingsManager,
			// 给新模型运行时创建阶段 15 秒取消信号，不是整段扩展执行的强制超时。
			modelRuntimeSignal: AbortSignal.timeout(15_000),
			// 把普通解析器未知参数交扩展参数声明匹配，未注册的名字会变诊断。
			extensionFlagValues: parsed.unknownFlags,
			// 只有需要正式信任决策时才注入资源加载阶段选项。
			resourceLoaderReloadOptions: shouldResolveProjectTrust
				? // 条件对象包含 resolveProjectTrust 回调，创建对象还未询问用户。
					{
						// 信任回调由 resourceLoader.reload 在预加载信任扩展后调用；输入扩展结果，返回 boolean，并缓存结果。
						// 例如扩展先处理 project_trust，没决定时再依据存储/默认/有无 UI 询问；副作用可能是交互和信任持久化。
						resolveProjectTrust: async ({ extensionsResult }) => {
							// 等待统一信任解析器；不在 main 里重新实现授权优先级。
							const trusted = await resolveProjectTrusted({
								// 把当前目标 cwd 作为被授权目录。
								cwd,
								// 持久信任存储可读已有选择，也可按用户决定写入。
								trustStore,
								// 传 CLI 显式覆盖，解析器内部优先处理它。
								trustOverride: parsed.projectTrustOverride,
								// 首次启动全局/启动设置中的默认信任策略。
								defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
								// 预加载的信任扩展可接管 project_trust 事件。
								extensionsResult,
								// 下面选择使用宿主提供的上下文还是 CLI 启动适配器。
								projectTrustContext:
									// 有外部上下文就复用，不再创建启动 UI 适配。
									projectTrustContext ??
									// 没有时构造按本次模式受限的信任交互上下文；构造本身不弹窗。
									createProjectTrustContext({
										// 上下文报告被判断的目标目录。
										cwd,
										// 首次使用元数据命令调整后的 trustPromptMode，后续使用当前 appMode。
										mode: isInitialRuntime ? trustPromptMode : appMode,
										// 启动 UI 使用启动设置的主题与交互偏好。
										settingsManager: startupSettingsManager,
										// 只有首次且正常 interactive 时，这个默认适配器才报告有 UI。
										hasUI: isInitialRuntime && trustPromptMode === "interactive",
									}),
								// 错误通知回调输入消息，追加 warning 并返回 push 长度（返回值调用方不使用）；真正信任扩展报错时才运行。
								onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
							});
							// 记住当前进程这次决策，包括 false，后续回到同 cwd 可复用。
							projectTrustByCwd.set(cwd, trusted);
							// 把布尔结果还给资源加载器，它会据此更新设置并继续受控加载。
							return trusted;
						},
					}
				: // 不需要正式解析时不传 reload 信任回调，沿用已确定状态。
					undefined,
			// 以下对象是资源加载构造选项，传递路径和抑制开关，不在对象字面量内执行资源。
			resourceLoaderOptions: {
				// 额外扩展路径已按启动目录解析。
				additionalExtensionPaths: resolvedExtensionPaths,
				// 额外技能来源同样固定。
				additionalSkillPaths: resolvedSkillPaths,
				// 额外提示词模板来源。
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				// 额外主题来源。
				additionalThemePaths: resolvedThemePaths,
				// 关闭默认扩展发现，精确规则交给加载器处理。
				noExtensions: parsed.noExtensions,
				// --no-mcp 时只禁用名为 mcp 的内置扩展，而不是删除所有扩展能力。
				disabledBuiltinExtensions: parsed.noMcp ? ["mcp"] : undefined,
				// 抑制默认技能发现。
				noSkills: parsed.noSkills,
				// 抑制默认提示词模板发现。
				noPromptTemplates: parsed.noPromptTemplates,
				// 抑制默认主题发现。
				noThemes: parsed.noThemes,
				// 抑制上下文文件发现，影响 AGENTS 等资源注入。
				noContextFiles: parsed.noContextFiles,
				// 传 CLI 指定的系统提示词输入，由加载器解析具体来源。
				systemPrompt: parsed.systemPrompt,
				// 传需追加到系统提示词的内容/输入选项。
				appendSystemPrompt: parsed.appendSystemPrompt,
				// 合并后的内置与宿主扩展工厂引用由加载器适时执行。
				extensionFactories,
			},
		});
		// 从就绪服务包解构三个共享实例，不重新创建。
		const { settingsManager, modelRuntime, resourceLoader } = services;
		// 按加载阶段聚合运行时诊断，让宿主一次展示。
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			// 先加入信任扩展警告。
			...projectTrustDiagnostics,
			// 再加入参数/模型注册等服务装配诊断。
			...services.diagnostics,
			// 收集这个最终 cwd 设置的解析问题。
			...collectSettingsDiagnostics(settingsManager),
			// 把每个扩展加载错误映射为统一诊断对象；回调解构 path/error，返回对象而非执行扩展。
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				// as const 保持 type 是字面量 error，供联合类型检查，不冻结对象。
				type: "error" as const,
				// 带上扩展文件地址与失败原因。
				message: `Failed to load extension "${path}": ${error}`,
			})),
			// warnings 可缺省，用空数组回退再映射；不把无警告当错误。
			...(resourceLoader.getExtensions().warnings ?? []).map(({ path, warning }) => ({
				// 将警告级别保持为字面量 warning。
				type: "warning" as const,
				// 带上资源包来源与具体警告。
				message: `Extension package "${path}": ${warning}`,
			})),
		];

		// 显式 --models 覆盖设置的 enabledModels，空数组也是明确值。
		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		// 下面只在存在非空模式范围时解析候选列表。
		const scopedModels =
			// 先检查数组存在且至少一项。
			modelPatterns && modelPatterns.length > 0
				? // 按当前模型目录解析所有候选，使用 15 秒取消信号；不是向这些模型逐个发聊天请求。
					await resolveModelScope(modelPatterns, modelRuntime, { signal: AbortSignal.timeout(15_000) })
				: // 没有范围就使用空列表，后续 SDK 可按默认/历史选择。
					[];
		// 对象解构同时取配置、思考来源标记和诊断，并对两个字段重命名。
		const {
			// 把返回 options 改名 sessionOptions，与外层 main options 区分。
			options: sessionOptions,
			// 保留是否由 CLI 模型后缀显式决定思考。
			cliThinkingFromModel,
			// 把本步骤诊断改名，便于追加到聚合数组。
			diagnostics: sessionOptionDiagnostics,
			// 调用纯配置翻译函数，不在这一步创建 Agent。
		} = buildSessionOptions(
			// 传普通 CLI 解析结果。
			parsed,
			// 传已解析的可切换模型范围。
			scopedModels,
			// 用当前有效历史是否有消息判断恢复；不是只看 JSONL 文件是否存在。
			sessionManager.buildSessionContext().messages.length > 0,
			// 用本 cwd 的模型运行时匹配引用。
			modelRuntime,
			// 用本 cwd 的设置决定默认选择。
			settingsManager,
		);
		// 展开追加模型/工具选项诊断，保留前面资源问题。
		diagnostics.push(...sessionOptionDiagnostics);

		// 只有显式提供 API Key 时才设置运行期凭证覆盖。
		if (parsed.apiKey) {
			// 需要先有可定位供应商的具体模型，否则 key 不知道归谁。
			if (!sessionOptions.model) {
				// 把这种参数缺失记为诊断，不随意给任意供应商使用秘密。
				diagnostics.push({
					// 此问题会阻止后续正常运行。
					type: "error",
					// 提示三种能明确模型/供应商的 CLI 选择方式。
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
				// 已有模型时可以设置它所属供应商的覆盖。
			} else {
				// 等待运行期 API Key 设置；不把 CLI key 持久化成 auth.json 常规登录记录。
				await modelRuntime.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		// 目录服务和选项都确定后才创建上层会话，内部注册请求回调而不是立即发问。
		const created = await createAgentSessionFromServices({
			// 共享加载完资源的服务包。
			services,
			// 使用本次选好的历史分支。
			sessionManager,
			// 传递首次/替换启动原因。
			sessionStartEvent,
			// 显式选择可缺省，让 SDK 继续历史恢复/默认选择。
			model: sessionOptions.model,
			// 思考级别可缺省，让 SDK 按优先级解析。
			thinkingLevel: sessionOptions.thinkingLevel,
			// 保留交互模型循环范围。
			scopedModels: sessionOptions.scopedModels,
			// 传工具允许名单或增删修饰列表。
			tools: sessionOptions.tools,
			// 传排除规则，后续注册工具也会应用。
			excludeTools: sessionOptions.excludeTools,
			// 传默认工具抑制模式。
			noTools: sessionOptions.noTools,
			// 传自定义工具；这里来自翻译结果，普通 CLI 目前通常未设置该字段。
			customTools: sessionOptions.customTools,
		});
		// 显式 --thinking 或模型后缀都算用户覆盖，范围默认不算。
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		// 有具体模型且存在 CLI 覆盖时再应用当前有效级别。
		if (created.session.model && cliThinkingOverride) {
			// 调用会话 setter 重新按可用级别处理；此调用没有 persist 选项，且相同级别不会重复追加变更记录。
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		// 返回完整工厂结果供 runtime 容器应用。
		return {
			// 展开 SDK 的 session/扩展结果/回退提示。
			...created,
			// 附上这个 cwd 配套基础设施。
			services,
			// 附上所有运行时诊断，不在工厂内部强制退出。
			diagnostics,
		};
	};
	// 这里只完成了工厂定义，记录该阶段时间点；下一行才首次调用。
	time("createRuntime");
	// 验证目标 cwd 后真正调用工厂创建首次会话，并保存工厂供后续切换复用。
	const runtime = await createAgentSessionRuntime(createRuntime, {
		// 会话头/覆盖后的有效 cwd，区别于 main 启动 cwd。
		cwd: sessionManager.getCwd(),
		// 同一用户配置根目录。
		agentDir,
		// CLI 已选定的历史管理器。
		sessionManager,
	});
	// 记录首次运行时装配完成时间。
	time("createAgentSessionRuntime");
	// 从容器取当前首次会话、服务和回退提示；后续模式主要持有 runtime 以支持替换。
	const { services, session, modelFallbackMessage } = runtime;
	// 取共享设置、模型运行时和资源加载器供启动收尾使用。
	const { settingsManager, modelRuntime, resourceLoader } = services;
	// 最终目录设置的终端能力覆盖应用到 TUI。
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	// 最终全局代理配置再应用，确保与实际服务设置一致。
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	// 按有效 HTTP 空闲超时重配 dispatcher，供后续请求使用。
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	// 合并启动和最终运行时诊断并去重，避免同一设置问题重复打印。
	const startupDiagnostics = deduplicateDiagnostics([...startupSettingsDiagnostics, ...runtime.diagnostics]);
	// 只看运行时 error 决定正常运行能否开始；warning 不在此当失败。
	const hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");

	// help 等扩展加载后再输出，才能列出扩展注册的额外参数。
	if (parsed.help) {
		// 帮助输出前先报告所有启动诊断。
		reportDiagnostics(startupDiagnostics);
		// 从共享加载器读取扩展参数声明，而不是再次执行扩展。
		const extensionFlags = resourceLoader
			// 取得当前扩展加载结果。
			.getExtensions()
			// flatMap 将每个扩展的 flag Map 值数组展开成一份帮助列表。
			.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		// 打印内置与扩展参数帮助。
		printHelp(extensionFlags);
		// 帮助成功退出，即使资源存在诊断也不运行会话。
		process.exit(0);
	}

	// 只要显式请求列表（包括布尔 true）就执行此命令。
	if (parsed.listModels !== undefined) {
		// 先展示设置/资源诊断。
		reportDiagnostics(startupDiagnostics);
		// listModels 联合类型区分“全部列表”与字符串搜索；只有字符串传过滤模式。
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		// 等待模型列表输出，取消信号限制 15 秒；不是发送一次聊天问题。
		await listModels(modelRuntime, searchPattern, AbortSignal.timeout(15_000));
		// 列表完成即成功退出。
		process.exit(0);
	}

	// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
	// 预留管道文字，RPC 分支保持 undefined，因为它独占 stdin 协议。
	let stdinContent: string | undefined;
	// 只有非 RPC 模式才一次性读 stdin 到结束。
	if (appMode !== "rpc") {
		// TTY 返回 undefined，真正管道等待 end 后得到文本。
		stdinContent = await readPipedStdin();
		// 实际发现管道输入且仍被推断成交互时，进一步改为打印模式。
		if (stdinContent !== undefined && appMode === "interactive") {
			// 防止把已消费的管道当成 TUI 输入继续启动。
			appMode = "print";
		}
	}
	// 记录 stdin 准备耗时。
	time("readPipedStdin");

	// 读取 @file 并拼首句，解构文字/图片；此步骤会消费 parsed.messages 首问题。
	const { initialMessage, initialImages } = await prepareInitialMessage(parsed, stdinContent);
	// 记录首次输入准备耗时。
	time("prepareInitialMessage");
	// 用最终主题初始化 UI；只有交互模式要求相应交互主题监听行为。
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	// 记录主题初始化耗时。
	time("initTheme");

	// Show deprecation warnings in interactive mode
	// 弃用迁移提示仅在交互模式且确实有警告时展示。
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		// 等待用户可见的弃用提示流程完成。
		await showDeprecationWarnings(deprecationWarnings);
	}

	// 记录模型范围解析相关时间点，实际范围工作已在工厂内完成。
	time("resolveModelScope");
	// 非交互总打印诊断；交互正常启动交给 UI 展示，若有 error 则先在这里打印。
	if (appMode !== "interactive" || hasRuntimeErrors) {
		// 调用统一 stderr 诊断输出函数。
		reportDiagnostics(startupDiagnostics);
	}
	// 存在运行时错误就不能开始正常问答。
	if (hasRuntimeErrors) {
		// 此处通过加载错误文案判断是否补扩展禁用建议，属于当前实现的字符串匹配规则。
		if (runtime.diagnostics.some((diagnostic) => diagnostic.message.includes("Failed to load extension"))) {
			// 提示可用 -ne 启动，只有文字展示，不自动重启或禁用扩展。
			console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
		}
		// 运行时装配问题按失败退出。
		process.exit(1);
	}
	// 记录会话准备完成阶段点。
	time("createAgentSession");

	// 非交互无法在稍后的设置 UI 补选模型，因此必须提前有模型。
	if (appMode !== "interactive" && !session.model) {
		// 显示认证/模型配置引导文字。
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		// 缺模型时失败退出，交互模式则允许进入界面继续配置。
		process.exit(1);
	}

	// 启动性能测量开关使用相同环境布尔解析规则。
	const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);
	// 这个测量流程依赖 TUI 初始化，仅支持交互模式。
	if (startupBenchmark && appMode !== "interactive") {
		// 错误说明输出到 stderr。
		console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
		// 模式不合法立即退出 1。
		process.exit(1);
	}

	// RPC refreshes catalogs here in the background; interactive mode starts its refresh after TUI initialization.
	// 仅非离线 RPC 在这里后台刷新目录；交互模式把刷新推迟到 TUI 初始化后。
	if (!offlineMode && appMode === "rpc") {
		// 创建可手动取消的控制器，供此次后台刷新使用。
		const controller = new AbortController();
		// 定时器回调无输入，15 秒后调用 abort 发取消信号；不是同步等待 15 秒。
		const timeout = setTimeout(() => controller.abort(), 15_000);
		// void 表示有意不 await 该 Promise，允许 RPC 启动与刷新重叠，不会自动取消任务。
		void modelRuntime
			// 真正启动模型目录刷新，默认网络策略由运行时决定，传信号控制取消。
			.refresh({ signal: controller.signal })
			// catch 回调不使用异常，后台刷新失败不阻止已能工作的 RPC 启动。
			.catch(() => {})
			// finally 无论成功失败都清理超时定时器，避免残留。
			.finally(() => clearTimeout(timeout));
	}

	// 到这里根据最终宿主模式进入实际运行入口。
	if (appMode === "rpc") {
		// 输出被启用的启动计时结果，未启用时 helper 自行处理。
		printTimings();
		// RPC 读取 stdin 命令并可多轮驱动 runtime，不启动终端交互 UI。
		await runRpcMode(runtime);
		// 普通交互模式走持久终端界面。
	} else if (appMode === "interactive") {
		// 构造交互控制器，保存 runtime 与启动数据；真正事件循环稍后 run 才开始。
		const interactiveMode = new InteractiveMode(runtime, {
			// 把迁移过的供应商交 UI 展示提示。
			migratedProviders,
			// 交互界面显示尚未在成功路径 stderr 打印的诊断。
			startupDiagnostics,
			// 带上历史模型恢复失败时的回退说明。
			modelFallbackMessage,
			// 交给 UI 初始无信任资源的特定 cwd 标记，用于后续重载处理。
			autoTrustOnReloadCwd,
			// 首句已经合并 stdin/文件/问题，供 UI 启动后发送。
			initialMessage,
			// 首句相关图片独立传入。
			initialImages,
			// 其余 CLI 问题数组，首项已经被 prepareInitialMessage 消费。
			initialMessages: parsed.messages,
			// 是否显示更详细启动信息。
			verbose: parsed.verbose,
			// CLI 指定的终端 UI 模式。
			tuiMode: parsed.tuiMode,
			// 传临时启动主题选择，供 UI 保持首次设置行为。
			initialThemeSetting: parsed.useTheme,
		});
		// 启动基准模式只初始化并关闭，不进入持续问答循环。
		if (startupBenchmark) {
			// 实际初始化 TUI，可能执行终端查询和扩展 UI 初始化。
			await interactiveMode.init();
			// 记录 TUI 初始化耗时。
			time("interactiveMode.init");
			// Give the TUI's stdin handler a brief chance to consume terminal query replies
			// (Kitty keyboard protocol, device attributes, cell size) before restoring the terminal.
			// Promise executor 安排 150ms 定时器，回调完成等待，让终端查询回复有机会被 stdin 处理；不是无限等待。
			await new Promise((resolve) => setTimeout(resolve, 150));
			// 停止 TUI 并恢复终端状态。
			interactiveMode.stop();
			// 移除主题文件监听。
			stopThemeWatcher();
			// 输出测量结果。
			printTimings();
			// stdout 缓冲还有数据时等其排空，避免测量退出丢末尾控制符/输出。
			if (process.stdout.writableLength > 0) {
				// Promise<void> 只等 drain，无业务值；once 回调收到排空事件后 resolve。
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			// stderr 同样需要排空自己的缓冲。
			if (process.stderr.writableLength > 0) {
				// 等待一次 stderr drain；这里不写额外诊断。
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			// 性能测量结束，不运行普通交互主循环。
			return;
		}

		// 正常交互启动先输出计时，再进入界面循环。
		printTimings();
		// 等待用户交互直到模式退出，内部会处理多轮 prompt/工具事件。
		await interactiveMode.run();
		// 其余情况为 text/json 打印模式，一次性处理初始及剩余消息。
	} else {
		// 打印启动计时信息。
		printTimings();
		// 执行打印模式并等待退出码；真正 session.prompt 由该入口根据消息队列触发。
		const exitCode = await runPrintMode(runtime, {
			// json 保留 JSON 事件输出，print 使用普通 text。
			mode: toPrintOutputMode(appMode),
			// 传尚未消费的后续问题，支持一组 CLI 多消息依次处理。
			messages: parsed.messages,
			// 传合并后的第一句问题，避免重复发送。
			initialMessage,
			// 传附带图片给首轮输入。
			initialImages,
		});
		// 打印结束后停止主题监听，避免 watcher 挂住进程。
		stopThemeWatcher();
		// 恢复 stdout 原始写入函数，防止后续宿主代码仍被重定向。
		restoreStdout();
		// 模式返回失败时才覆盖进程退出码。
		if (exitCode !== 0) {
			// 让 CLI 自然退出时携带该非零结果。
			process.exitCode = exitCode;
		}
		// 打印模式结束，返回 main 的调用者。
		return;
	}
}
