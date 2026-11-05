// 收集故障报告材料、有限规则脱敏、导出ZIP或调用当前模型生成摘要；/bug交互层决定用户选择与最终上传。本文件不会自动上传，但生成摘要会发送选中的对话给模型。
// 命名空间导入os读取系统版本，不执行shell命令。
import * as os from "node:os";
// AgentMessage/StreamFn/ThinkingLevel只作类型约束。
import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
// 运行值用于抽取文字、规范上下文和生成id，RetryPolicy仅是类型。
import { contentText, normalizeContext, type RetryPolicy, uuidv7 } from "@earendil-works/pi-ai";
// compat导出层提供旧接口关联类型，不在此构造供应商。
import type { Api, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
// 通过统一配置读取版本。
import { VERSION } from "../config.ts";
// 构造User-Agent文字，不在此发送网络请求。
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
// ZIP工具负责字节结构与写文件。
import { writeZipArchive } from "../utils/zip.ts";
// 共用摘要请求/近似token估计/响应失败检查，不进入普通Agent工具循环。
import { completeSummarization, estimateTokens, getSummarizationFailure } from "./compaction/compaction.ts";
// 把选中的消息转为可读转录文字供模型。
import { serializeConversation } from "./compaction/utils.ts";
// 崩溃记录契约，下面只去notified标记，不完整脱敏堆栈。
import type { CrashRecord } from "./crash-log.ts";
// 扩展元数据类型。
import type { Extension } from "./extensions/types.ts";
// 把内部消息转换为模型支持的消息，过滤/包装非模型消息。
import { convertToLlm } from "./messages.ts";
// 运行时用于查询provider状态，不直接读取原始凭据值。
import type { ModelRuntime } from "./model-runtime.ts";
// 只读会话接口可获取全部原始条目。
import type { ReadonlySessionManager } from "./session-manager.ts";
// 设置是类型，不在此加载用户设置文件。
import type { Settings } from "./settings-manager.ts";

// 成功发送/导出后会话记录用的customType标识，内容不作为普通用户消息。
export const BUG_REPORT_CUSTOM_ENTRY_TYPE = "pi.bug-report";
// 报告JSON格式版本，与Pi软件版本不同。
const BUG_REPORT_SCHEMA_VERSION = 1;
// 敏感字段替换为固定占位符，URL编码后尖括号可能被转义。
const REDACTED = "<redacted>";
// 按分隔边界识别apiKey/secret/token等键名，i忽略大小写；不是任意正文秘密扫描，也不匹配所有复合词。
const SENSITIVE_KEY = /(?:^|[-_])(api[-_]?key|secret|token|password|passwd|credential|authorization|cookie)(?:$|[-_])/i;

// 判断键名像不像秘密字段，返回boolean；例：apiKey会先变api_Key，reserveTokens不会被当成token字段。只有本正则覆盖的命名规则，无I/O。
function isSensitiveKey(key: string): boolean {
	// 先把小写/数字紧接大写的边界加_，再匹配敏感词；替换串$1/$2是捕获组。
	return SENSITIVE_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

/** Strip credentials and secret-looking query parameters from a URL. */
// 移除可解析URL的用户凭据并替换敏感query值，返回文字；例：git:https://pat@host会递归清内部URL。无改动保持原字符串；非URL/解析错误返回原文，不清路径/片段中的秘密或普通错误正文。
export function redactUrl(value: string): string {
	// 识别scheme:scheme://形式的嵌套来源，exec返回匹配数组或null。
	const nested = /^([a-z][a-z0-9+.-]*:)([a-z][a-z0-9+.-]*:\/\/.*)$/i.exec(value);
	// 保留外层前缀，递归处理内部URL；不是下载或重定向请求。
	if (nested) return `${nested[1]}${redactUrl(nested[2])}`;
	// URL解析与修改在try内，失败保留原文。
	try {
		// new URL只解析，不联网。
		const url = new URL(value);
		// let记录是否实际改过，避免无关规范化改变原展示文字。
		let changed = false;
		// 用户名或密码任一非空就去掉两者。
		if (url.username || url.password) {
			// 清username。
			url.username = "";
			// 清password。
			url.password = "";
			// 标记需要输出规范化后的URL。
			changed = true;
		}
		// 遍历query键名，内容仍由URLSearchParams解码后判断。
		for (const key of url.searchParams.keys()) {
			// 只替换命中敏感键名的参数，不扫描每个参数值。
			if (isSensitiveKey(key)) {
				// set替换同名参数值，可能合并重复键；没有承诺保留原query排列和重复结构。
				url.searchParams.set(key, REDACTED);
				// 有修改时更新标记。
				changed = true;
			}
		}
		// 修改过才URL.toString，可能同时规范化其他URL格式。
		return changed ? url.toString() : value;
		// 坏URL等异常降级原文，不能当成“已保证脱敏”。
	} catch {
		// 原文返回不代表它不含秘密。
		return value;
	}
}

/** Copy a JSON value while removing values that may contain credentials. */
// 对可JSON序列化数据做JSON往返复制，并按键/URL规则脱敏，返回unknown；例：嵌套Authorization变占位符。循环/BigInt/不支持顶层值仍可抛，toJSON等遵循原生JSON语义，不是通用深克隆。
export function redactJsonValue(value: unknown): unknown {
	// 显式undefined直接返回，避免JSON.parse(undefined)。
	if (value === undefined) return undefined;
	// 先stringify过滤，再parse得到新的JSON数据树。
	return JSON.parse(
		// replacer对每个键/值运行，child:unknown不假定外部数据类型。
		JSON.stringify(value, (key, child: unknown) => {
			// null/undefined敏感值不替换，其他命中键整个子树变占位符。
			if (child !== null && child !== undefined && isSensitiveKey(key)) return REDACTED;
			// 字符串走URL规则，其他值原样交JSON编码；普通文本秘密没有扫描。
			return typeof child === "string" ? redactUrl(child) : child;
		}),
	);
}

// 移除设置顶层trackingId/deviceId，再按键脱敏并返回Settings视图；例：reserveTokens仍保留。as不运行schema校验，未知键按JSON规则保留或替换，不保证所有设置内容匿名。
function redactSettings(settings: Settings): Settings {
	// 对象剩余解构将两个ID取走，_前缀表示不再使用；rest为新顶层对象。
	const { trackingId: _trackingId, deviceId: _deviceId, ...rest } = settings;
	// JSON往返后断言类型，不补默认设置值。
	return redactJsonValue(rest) as Settings;
}

// 构造运行环境元数据，不收集完整环境值字典；例：PI_变量只列名字，但TERM等列出的诊断值会保留。读取系统API可能抛，不在此捕获；无上传副作用。
function collectEnvironment() {
	// 局部env帮助函数读取指定环境字符串，缺失/空串为null；例：TERM空串不会原样保存。
	const env = (name: string): string | null => process.env[name] || null;
	// 返回推断的对象类型，没手写宽泛any。
	return {
		// Pi版本。
		version: VERSION,
		// 详细User-Agent展示本版本/平台。
		userAgent: getPiUserAgent(VERSION),
		// 检测Bun版本存在时标bun，否则node/加process.version；node文字可能含版本自带v。
		runtime: process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`,
		// OS平台标识。
		platform: process.platform,
		// CPU架构标识。
		arch: process.arch,
		// 系统release来自os模块，不是Pi版本。
		osRelease: os.release(),
		// 更详细系统version。
		osVersion: os.version(),
		// SHELL路径按/或反斜杠拆，仅取basename，空结果回null。
		shell: process.env.SHELL?.split(/[\\/]/).pop() || null,
		// 终端诊断子对象。
		terminal: {
			// 终端能力类型。
			term: env("TERM"),
			// 终端程序名。
			program: env("TERM_PROGRAM"),
			// 终端程序版本。
			programVersion: env("TERM_PROGRAM_VERSION"),
			// 终端色彩提示。
			colorterm: env("COLORTERM"),
			// TMUX任意非空值为true，不解析"0"。
			tmux: Boolean(process.env.TMUX),
			// 三个SSH环境只要有非空就true，不检测网络会话真实性。
			ssh: Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY),
			// CI同样以非空判断，文字false仍true。
			ci: Boolean(process.env.CI),
		},
		// Names help diagnose configuration; values never leave the machine.
		// Object.keys只收集环境变量名称。
		piEnvironmentVariables: Object.keys(process.env)
			// 只保留PI_前缀，值不进入此列表。
			.filter((name) => name.startsWith("PI_"))
			// 按默认字符串排序，生成稳定展示。
			.sort(),
	};
}

// 构造模型可诊断视图，返回新顶层对象；例：headers只列名字、baseUrl按URL规则脱敏。部分数组/映射仍共享引用，既不查询模型也不保证所有模型字段秘密都能识别。
function describeModel(model: Model<Api>) {
	// 逐字段选择，避免直接展开所有模型配置。
	return {
		// 供应商id。
		provider: model.provider,
		// 模型id。
		id: model.id,
		// 模型显示名。
		name: model.name,
		// API适配类别。
		api: model.api,
		// URL账号和敏感query按既有规则清理。
		baseUrl: redactUrl(model.baseUrl),
		// reasoning能力标记。
		reasoning: model.reasoning,
		// 支持的输入类别数组原引用。
		input: model.input,
		// 目录声明上下文窗口。
		contextWindow: model.contextWindow,
		// 目录声明最大输出。
		maxTokens: model.maxTokens,
		// samplingParams存在时做JSON脱敏，否则null。
		samplingParams: model.samplingParams ? redactJsonValue(model.samplingParams) : null,
		// 兼容字段同样有限规则脱敏。
		compat: model.compat ? redactJsonValue(model.compat) : null,
		// 思考级别映射直接保留引用，缺省null，不额外脱敏。
		thinkingLevelMap: model.thinkingLevelMap ?? null,
		// 只列已配模型请求头名称并排序，不发送其值。
		headerNames: Object.keys(model.headers ?? {}).sort(),
	};
}

// 构造供应商身份/认证状态视图，不导出token；例：声明oauth能力不等于登录成功。同步查询运行时状态，可能抛；不主动刷新认证或发请求。
function describeProvider(modelRuntime: ModelRuntime, provider: Provider) {
	// 字面量联合数组只允许两种认证能力名字。
	const authTypes: Array<"api_key" | "oauth"> = [];
	// 有apiKey配置就列能力，不读取key。
	if (provider.auth.apiKey) authTypes.push("api_key");
	// 有oauth配置就列能力。
	if (provider.auth.oauth) authTypes.push("oauth");
	// 返回有限元数据对象。
	return {
		// 供应商标识。
		id: provider.id,
		// 显示名。
		name: provider.name,
		// 非空baseUrl才脱敏，缺省null。
		baseUrl: provider.baseUrl ? redactUrl(provider.baseUrl) : null,
		// 只留provider头名字。
		headerNames: Object.keys(provider.headers ?? {}).sort(),
		// 返回能力数组属性简写。
		authTypes,
		// 当前运行时快照认证状态，不是联网验token。
		authStatus: modelRuntime.getProviderAuthStatus(provider.id),
		// 由运行时判断当前是否使用OAuth。
		usingOAuth: modelRuntime.isUsingOAuth(provider.id),
		// 是否存在扩展注册覆盖，按id集合判断，不等于整个供应商来自扩展。
		registeredByExtension: modelRuntime.getRegisteredProviderIds().includes(provider.id),
	};
}

// 选择扩展来源/路径等诊断字段，返回新对象；例：npm来源保留，网络来源只按URL规则清理。不会执行扩展，path未匿名化。
function describeExtension(extension: Extension) {
	// 不展开handler等不可序列化内容。
	return {
		// 原扩展路径原样保留。
		path: extension.path,
		// source可能是URL或npm表达式，不能解析的原样返回。
		source: redactUrl(extension.sourceInfo.source),
		// 资源范围user/project/temporary。
		scope: extension.sourceInfo.scope,
		// 来源package/top-level。
		origin: extension.sourceInfo.origin,
		// 只有显式true标为hidden，其余false。
		hidden: extension.hidden === true,
	};
}

// 收集报告元数据所需输入契约；include标记由交互层选择，函数不再次确认。
interface CollectBugReportMetadataOptions {
	// 可显式指定报告id，缺省UUIDv7。
	id?: string;
	// 用户错误描述，可缺省但不做正文秘密扫描。
	hint?: string;
	// 当前会话id。
	sessionId: string;
	// 只在includeSession=true时放进session元数据的cwd。
	cwd: string;
	// 是否附会话原文的展示标记，本函数本身不读原文。
	includeSession: boolean;
	// 是否附模型摘要的标记，本函数不生成摘要。
	includeSummary: boolean;
	// 调用方给的消息数，不在此重新统计。
	messageCount: number;
	// 可无当前模型。
	model?: Model<Api>;
	// 提供商查询能力。
	modelRuntime: ModelRuntime;
	// 当前思考档位。
	thinkingLevel: ThinkingLevel;
	// 只读扩展数组，类型不冻结元素。
	extensions: readonly Extension[];
	// 只读错误数组，错误文字会按原值保留。
	extensionErrors: ReadonlyArray<{ path: string; error: string }>;
	// 全局设置快照。
	globalSettings: Settings;
	// 项目设置快照。
	projectSettings: Settings;
}

// 组合版本/环境/模型/扩展/设置等报告元数据，返回新对象，不写文件/上传；例：不附原文时不放cwd。但hint、扩展path/error等仍可能含用户文字，不能把整个报告描述为完全脱敏。
export function collectBugReportMetadata(options: CollectBugReportMetadataOptions) {
	// 可选链trim描述，空白/缺失统一null；普通文本不做redactJsonValue。
	const hint = options.hint?.trim() || null;
	// 有模型时按provider id查配置，缺模型不查询。
	const provider = options.model ? options.modelRuntime.getProvider(options.model.provider) : undefined;
	// 对象由TS推断，ReturnType稍后复用这一精确形状。
	return {
		// 报告格式版本。
		schemaVersion: BUG_REPORT_SCHEMA_VERSION,
		// ??只在id空缺时生成，显式空串id仍保留。
		id: options.id ?? uuidv7(),
		// 记录本次构建时间。
		createdAt: new Date().toISOString(),
		// 用户描述简写。
		hint,
		// 同步读取环境诊断。
		environment: collectEnvironment(),
		// 会话展示信息子对象，不是原始消息数组。
		session: {
			// 会话身份。
			id: options.sessionId,
			// 原文是否附带由调用方声明。
			included: options.includeSession,
			// 摘要是否附带由调用方声明。
			summaryIncluded: options.includeSummary,
			// 直接用给定消息计数。
			messageCount: options.messageCount,
			// 条件对象展开：只在允许原文时加cwd，否则展开空对象而省略键。
			...(options.includeSession ? { cwd: options.cwd } : {}),
		},
		// 有模型才描述，否则明确null。
		model: options.model ? describeModel(options.model) : null,
		// 目录查到供应商才描述，否则null。
		provider: provider ? describeProvider(options.modelRuntime, provider) : null,
		// 记录当前思考设置。
		thinkingLevel: options.thinkingLevel,
		// map创建扩展视图数组，不复制扩展实现。
		extensions: options.extensions.map(describeExtension),
		// 解构后仅保留path/error，两者没有在此统一脱敏。
		extensionErrors: options.extensionErrors.map(({ path, error }) => ({ path, error })),
		// 分别处理全局/项目设置。
		settings: {
			// 去ID并按键/URL规则脱敏全局值。
			global: redactSettings(options.globalSettings),
			// 同样处理项目值。
			project: redactSettings(options.projectSettings),
		},
	};
}

/** Collect failed assistant turns without collecting conversation content. */
// 从全部原始条目收集异常assistant诊断及崩溃信息，不收集消息content正文；返回报告对象。例：无diagnostics但stopReason=error也收录。错误文字/诊断/崩溃可能含正文或秘密，这里不再脱敏，不只取当前分支。
export function collectBugReportDiagnostics(
	// 只读会话管理接口，不通过本函数更改leaf。
	sessionManager: ReadonlySessionManager,
	// 缺省无崩溃；readonly不冻结记录。
	crashes: readonly CrashRecord[] = [],
) {
	// getEntries是全部追加历史条目，不是当前分支模型投影。
	const entries = sessionManager.getEntries();
	// 局部数组随push由TS推导元素形状，不是显式any声明。
	const assistant = [];
	// 统计所有assistant消息，包含后面未纳入诊断列表的正常回复。
	let assistantMessageCount = 0;
	// 按追加顺序遍历。
	for (const entry of entries) {
		// 非message/非assistant跳过，双标签让TS收窄。
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		// 先计助手总数，再筛异常。
		assistantMessageCount++;
		// 取当前消息引用。
		const message = entry.message;
		// 无diagnostics用空数组；存在时后面保留原引用。
		const diagnostics = message.diagnostics ?? [];
		// 以下条件必须全部满足才跳过。
		if (
			// 没有诊断条目。
			diagnostics.length === 0 &&
			// 不是error结束。
			message.stopReason !== "error" &&
			// 不是aborted结束。
			message.stopReason !== "aborted" &&
			// 也没有非空errorMessage。
			!message.errorMessage
		) {
			// 正常回复不存诊断行，但已计总数。
			continue;
		}
		// 将异常回复的元信息加入新列表。
		assistant.push({
			// 原会话树条目id，便于定位。
			entryId: entry.id,
			// 条目时间而非读取当前时刻。
			timestamp: entry.timestamp,
			// 响应归属provider。
			provider: message.provider,
			// 响应model，不取当前选择模型。
			model: message.model,
			// 响应API类别。
			api: message.api,
			// 统一stopReason。
			stopReason: message.stopReason,
			// 仅undefined时省略rawStopReason，空串/null等现有值仍可保留。
			...(message.rawStopReason === undefined ? {} : { rawStopReason: message.rawStopReason }),
			// 同样只按undefined省略errorMessage，不做正文脱敏。
			...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
			// 保存原diagnostics数组，不扫描其中字段。
			diagnostics,
		});
	}
	// 返回汇总对象，不保存会话新条目。
	return {
		// 报告格式版本。
		schemaVersion: BUG_REPORT_SCHEMA_VERSION,
		// 读取该管理器会话id。
		sessionId: sessionManager.getSessionId(),
		// 全部原始条目数，含非消息条目。
		entryCount: entries.length,
		// 全部assistant计数简写。
		assistantMessageCount,
		// 异常助手元信息数组简写。
		assistant,
		// 对象剩余解构仅去掉notified，堆栈/cwd等原字段仍保留；不修改原crashes元素。
		crashes: crashes.map(({ notified: _notified, ...record }) => record),
	};
}

// ReturnType<typeof fn>从实际返回类型派生别名，typeof在此是类型查询，不是运行时调用函数。
export type BugReportMetadata = ReturnType<typeof collectBugReportMetadata>;
// 诊断类型也复用函数推断，修改返回字段会影响消费者编译检查。
export type BugReportDiagnostics = ReturnType<typeof collectBugReportDiagnostics>;

// 上传/导出共享材料包，接口自己不执行脱敏或用户授权。
export interface BugReportBundle {
	// 运行/配置元数据。
	metadata: BugReportMetadata;
	// 错误/崩溃诊断。
	diagnostics: BugReportDiagnostics;
	// 可选的已序列化会话原文，附带后会直接写出，不自动脱敏。
	sessionJsonl?: string;
	// 可选模型生成摘要，仍需上层决定是否发送。
	summary?: string;
}

// 会话custom entry中记录一次报告投递，不存整个报告包。
export interface BugReportSessionEntryData {
	// 报告id，与会话/请求id不同。
	id: string;
	// 报告构建时间。
	createdAt: string;
	// 用户线索，null表示未给非空文字。
	hint: string | null;
	// 是否包含原文。
	sessionIncluded: boolean;
	// 是否包含摘要。
	summaryIncluded: boolean;
	// zip是本地导出、upload是网络发送，标签联合不代表操作已在类型声明时执行。
	delivery: "zip" | "upload";
	// 可选本地导出路径，上传记录通常不带此项。
	path?: string;
}

// 一个文本报告文件描述，由ZIP和multipart出口复用；非真实已打开文件句柄。
interface BugReportFile {
	// 文件名兼上传表单字段名。
	name: string;
	// MIME媒体类型，ZIP写入器只用name/data。
	contentType: string;
	// UTF-8文本源字符串，不是文件磁盘路径。
	data: string;
}

/** Files shared by upload and zip export. */
// 把bundle转换为文件清单，返回新数组；总有report/diagnostics，可选原文/摘要。例：summary为空串也会生成只含LF的文件。这里不写盘/上传，也不二次脱敏，JSON编码异常会抛。
export function bugReportFiles(bundle: BugReportBundle): BugReportFile[] {
	// 数组有明确BugReportFile元素类型，检查name/contentType/data。
	const files: BugReportFile[] = [
		// 元数据格式化2空格并加末尾LF，JSON.stringify不是敏感内容清理器。
		{ name: "report.json", contentType: "application/json", data: `${JSON.stringify(bundle.metadata, null, 2)}\n` },
		// 第二项是诊断文件描述对象。
		{
			// 固定诊断文件名。
			name: "diagnostics.json",
			// JSON媒体类型。
			contentType: "application/json",
			// 诊断对象同样JSON格式化，不过滤其错误文字。
			data: `${JSON.stringify(bundle.diagnostics, null, 2)}\n`,
		},
	];
	// 只与undefined比较，因此显式空原文也会附文件。
	if (bundle.sessionJsonl !== undefined) {
		// 原JSONL字符串原样保存，不解析/重序列化每条记录。
		files.push({ name: "session.jsonl", contentType: "application/x-ndjson", data: bundle.sessionJsonl });
	}
	// 摘要存在即附，包括空串。
	if (bundle.summary !== undefined) {
		// 追加一项，不改变bundle。
		files.push({
			// Markdown文件名。
			name: "summary.md",
			// Markdown媒体类型。
			contentType: "text/markdown",
			// 已经以LF结尾就保持，否则只补一个；不删除多余末尾换行。
			data: bundle.summary.endsWith("\n") ? bundle.summary : `${bundle.summary}\n`,
		});
	}
	// 返回清单，内容均为文字数据。
	return files;
}

// 将报告文件清单交ZIP工具写入filePath，返回Promise<void>；例：导出到/tmp/report.zip。创建ZIP同步压缩，文件写入异步；不在此创建父目录/确认覆盖，错误向上传播。
export function writeBugReportArchive(bundle: BugReportBundle, filePath: string): Promise<void> {
	// bugReportFiles先构造文件，再writeZipArchive；没有上传操作。
	return writeZipArchive(filePath, bugReportFiles(bundle));
}

// 构造建议ZIP文件名，无I/O；例：id=abc得到pi-bug-report-abc.zip。不会净化任意id中的路径分隔符，调用方一般使用生成的UUID。
export function bugReportArchiveFileName(id: string): string {
	// 模板串直接拼接id和后缀，返回string。
	return `pi-bug-report-${id}.zip`;
}

// 给模型的系统提示：把后续对话当材料写故障报告，不继续回答对话。多行模板内容是实际模型输入，注释只放在常量外。
const BUG_SUMMARY_SYSTEM_PROMPT = `You are helping a user file a bug report about pi, the coding agent they are talking to. You will be shown the conversation transcript. Write a report for the pi developers describing what the user was doing and what went wrong.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the report.`;

// 规定Markdown报告章节、事实和秘密处理要求；这是自然语言要求，不是本地强制脱敏验证，模板原文保持。
const BUG_SUMMARY_INSTRUCTIONS = `Write the bug report in Markdown with these sections:

## What the user was doing
One short paragraph.

## What went wrong
Concrete description of the failure: wrong output, errors, hangs, tool failures, unexpected behavior. Quote error messages and tool output verbatim where they exist.

## Steps to reproduce
Numbered list, as specific as the transcript allows.

## Relevant details
Tool calls involved, files touched, model behavior, anything else that helps a developer reproduce or locate the problem.

Do not include file contents, secrets, or credentials from the transcript; refer to files by path only. Keep the report factual and concise.`;

// 从末尾取连续一段消息直到近似token预算，恢复原顺序后返回新数组；例：最新单条就超预算仍保留它。到第一条放不下就break，不跳过它找更短旧消息，不保证转换后一定适配模型窗口。
function selectMessages(messages: readonly AgentMessage[], tokenBudget: number): AgentMessage[] {
	// 新结果数组，消息对象仍共享引用。
	const selected: AgentMessage[] = [];
	// 累计近似token，使用let后续+=更新。
	let tokens = 0;
	// 从最新消息向前扫描。
	for (let index = messages.length - 1; index >= 0; index--) {
		// 当前消息引用，不删改原数组。
		const message = messages[index];
		// estimateTokens是启发式，不是供应商精确tokenizer。
		const next = estimateTokens(message);
		// 至少先收一条；已有结果时遇预算溢出立即停止，所以可能少于预算。
		if (selected.length > 0 && tokens + next > tokenBudget) break;
		// 暂时按新到旧顺序push。
		selected.push(message);
		// 累加该消息估算。
		tokens += next;
	}
	// 仅反转新数组，恢复旧到新对话次序。
	return selected.reverse();
}

// 摘要调用选项；上游会话解析模型认证并提供当前有效消息。
interface GenerateBugReportSummaryOptions {
	// 待选消息只读数组，不自动拿磁盘全部会话。
	messages: readonly AgentMessage[];
	// 可选用户线索，发模型前只trim。
	hint?: string;
	// 实际摘要模型，支持虚拟路由后的选择。
	model: Model<Api>;
	// 可选已经解析的凭据，不在此登录。
	apiKey?: string;
	// 本次请求头。
	headers?: Record<string, string>;
	// 本次供应商环境覆盖。
	env?: Record<string, string>;
	// 必需取消信号，类型不表示调用时尚未取消。
	signal: AbortSignal;
	// 可选统一思考档位。
	thinkingLevel?: ThinkingLevel;
	// 可注入流函数，通常沿用当前会话运行时；测试可用faux而不访问真实模型。
	streamFn?: StreamFn;
	// 瞬时失败重试策略。
	retry?: RetryPolicy;
	// 可复用会话路由id，不等于启用缓存保留。
	sessionId?: string;
}

/** Ask the session model for a report when the user does not share the transcript. */
// 用当前模型从选中的对话生成故障报告摘要，返回非空Markdown文字；先选历史、组提示与选项，再调用公共摘要请求，拒绝取消/error/length/工具调用/空输出。
// 例：用户不附原文时可选择只把摘要附报告，但生成摘要仍需把选中对话发给模型供应商；指令要求不含秘密，代码没有验证输出已彻底脱敏。不在这里上传给报告网关或保存usage。
export async function generateBugReportSummary(options: GenerateBugReportSummaryOptions): Promise<string> {
	// 对象解构读取模型引用。
	const { model } = options;
	// 正上下文窗口才用目录值，否则回退128000；不是实际测量。
	const contextWindow = model.contextWindow > 0 ? model.contextWindow : 128_000;
	// 用窗口60%的近似预算选消息，未额外扣除系统提示/用户线索/序列化膨胀。
	const messages = selectMessages(options.messages, Math.floor(contextWindow * 0.6));
	// 可选线索trim，空白变空串，下面truthy时才放入提示。
	const hint = options.hint?.trim();
	// 先构建可能含undefined的提示段数组。
	const prompt = [
		// 只有删减过消息才加说明。
		messages.length < options.messages.length
			? // 模板串告诉模型原总数和保留数。
				`Note: only the last ${messages.length} of ${options.messages.length} messages are shown.`
			: // 没有删减时用undefined占位，后面filter去掉。
				undefined,
		// 内部消息转模型消息后序列化成文字包在conversation标签，原文可能含文件/命令输出，没有先用redactJsonValue。
		`<conversation>\n${serializeConversation(convertToLlm(messages))}\n</conversation>`,
		// 非空用户线索包在user-report标签，不做XML转义或正文秘密扫描。
		hint ? `<user-report>\n${hint}\n</user-report>` : undefined,
		// 追加章节/行为要求常量。
		BUG_SUMMARY_INSTRUCTIONS,
	]
		// filter只删undefined，不trim已产生的段内容。
		.filter((part) => part !== undefined)
		// 以两条真实LF连接各段。
		.join("\n\n");
	// 类型注解限制公共流选项字段，不是运行时JSON校验。
	const requestOptions: SimpleStreamOptions = {
		// 输出上限取4096和正模型上限的较小值；没有正目录上限时Infinity只是用来选择4096。
		maxTokens: Math.min(4096, model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY),
		// 传调用方取消信号。
		signal: options.signal,
		// 传已解析apiKey，可缺省。
		apiKey: options.apiKey,
		// 传本次headers，可缺省。
		headers: options.headers,
		// 传本次环境覆盖，不修改process.env。
		env: options.env,
		// 传路由id，公共摘要层缺省时会生成。
		sessionId: options.sessionId,
		// 条件展开只在模型支持推理、档位有值且非off时加reasoning。
		...(model.reasoning && options.thinkingLevel && options.thinkingLevel !== "off"
			? // 满足条件时构建一个reasoning字段对象。
				{ reasoning: options.thinkingLevel }
			: // 否则展开空对象，省略reasoning键。
				{}),
	};
	// 真正模型调用在共享摘要入口，底层异常可直接使本函数拒绝。
	const response = await completeSummarization(
		// 传模型，身份不在这里硬编码某一家。
		model,
		// 把一次用户消息与系统指令规范化为TranscriptContext。
		normalizeContext({
			// 系统层约束摘要任务。
			systemPrompt: BUG_SUMMARY_SYSTEM_PROMPT,
			// 整段转录包装成一条user文本消息，时间取现在，不重放原工具执行。
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		}),
		// 传刚建请求选项；completeSummarization会覆盖cacheRetention为none并处理路由。
		requestOptions,
		// 优先沿用注入streamFn，没有则走兼容层完成函数。
		options.streamFn,
		// 传重试策略给共享重试器。
		options.retry,
	);
	// 取消即抛，不把中途收到的片段当报告。
	if (response.stopReason === "aborted") throw new Error("Bug report summary was cancelled");
	// 公共失败检查处理error/length，返回说明或undefined。
	const failure = getSummarizationFailure(response, "Bug report summary");
	// 失败文字转Error，不附一份假成功摘要。
	if (failure) throw new Error(failure);
	// some检查是否出现任何工具调用块。
	if (response.content.some((block) => block.type === "toolCall")) {
		// 不实际执行工具；报告请求意外调用工具视为失败。
		throw new Error("Bug report summary attempted to call a tool");
	}
	// 抽取文本内容再去首尾空白，不把thinking块当报告正文。
	const text = contentText(response.content).trim();
	// 空结果拒绝，即使stopReason看起来正常。
	if (!text) throw new Error("Bug report summary was empty");
	// 返回文字，不在这里检查Markdown章节齐全或秘密已移除。
	return text;
}
