// 发现/加载扩展模块，给工厂提供注册 API，并把加载阶段变更转交共享运行时；资源加载器是上游，runner 绑定后才获得会话动作。
/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 */

// 命名空间导入同步文件系统 API，用于扩展发现和入口探测。
import * as fs from "node:fs";
// ESM 中建立相对当前模块的 require 解析器，后面定位 TypeBox 包文件。
import { createRequire } from "node:module";
// 路径 API 整体作为 path 对象使用，兼容平台分隔符。
import * as path from "node:path";
// 把 import.meta.url 的 file URL 转成磁盘路径。
import { fileURLToPath } from "node:url";
// 原生 Provider 的类型，含目录/认证/流实现；type 导入本身不运行供应商。
import type { Provider } from "@earendil-works/pi-ai";
// 键名类型 KeyId 供扩展快捷键声明使用。
import type { KeyId } from "@earendil-works/pi-tui";
// 只导入 createJiti 的函数类型；实际实现会在第一次加载扩展时异步取得。
import type { createJiti } from "jiti";
// 全局/项目目录名和打包模式统一来自 config。
import { CONFIG_DIR_NAME, getAgentDir, isBunBinary, isBundledNode } from "../../config.ts";
// resolvePath 规范并绝对化路径，pathsEqual 按平台比较地址，不自动追踪符号链接。
import { pathsEqual, resolvePath } from "../../utils/paths.ts";
// 扩展间共享的进程内事件总线；可由宿主提供，否则本模块创建。
import { createEventBus, type EventBus } from "../event-bus.ts";
// 扩展 exec 动作的子进程配置类型。
import type { ExecOptions } from "../exec.ts";
// 真正执行命令的统一入口，调用时才启动子进程。
import { execCommand } from "../exec.ts";
// MCP 配置类型、会话注册表、命名空间规范化和外部配置校验入口。
import { type McpServerConfig, McpServerRegistry, mcpNamespace, validateMcpServerConfig } from "../mcp-servers.ts";
// 安全读取 package.json 的 pi 资源声明；坏文件/无有效字段返回 null。
import { readPiManifest } from "../pi-manifest.ts";
// 为文件/内联/内置扩展生成来源元数据，并区分是否有真实文件目录。
import { createSyntheticSourceInfo, getSyntheticPathSource, isSyntheticPath } from "../source-info.ts";
// 记录模块导入和工厂初始化耗时，不调用模型。
import { time } from "../timings.ts";
// 虚拟模型请求/定义契约，路由由运行期回调完成。
import type { ModelRouteRequest, VirtualModelDefinition } from "../virtual-models.ts";
// 下面分组只导入扩展系统自己的类型契约，JS 中会擦除。
import type {
	// 自定义非模型上下文条目的显示函数类型。
	EntryRenderer,
	// 加载后的扩展记录，存放事件/工具/命令等注册表。
	Extension,
	// 传给工厂的公开 API 接口。
	ExtensionAPI,
	// 接 ExtensionAPI 的同步或异步初始化函数类型。
	ExtensionFactory,
	// 所有扩展共享的状态与最终会话动作接口。
	ExtensionRuntime,
	// 带扩展 ctx 的虚拟模型声明类型。
	ExtensionVirtualModel,
	// 扩展列表、错误、警告与共享 runtime 的返回类型。
	LoadExtensionsResult,
	// Markdown 显示前的纯文字变换类型，不是改模型上下文。
	MarkdownTransformer,
	// custom_message 的 TUI 显示函数类型。
	MessageRenderer,
	// 配置式供应商注册声明类型。
	ProviderConfig,
	// 扩展命令注册结构，含实际 handler。
	RegisteredCommand,
	// 工具定义包含 schema/execute/显示及提示词元信息。
	ToolDefinition,
	// 工具渲染器中间件的解析类型。
	ToolRendererResolver,
	// 这些类型共用 types.ts，不在本模块重复声明它们。
} from "./types.ts";

// 以当前 ESM 模块位置为基准建立 require，后面只用 resolve 找模块地址。
const require = createRequire(import.meta.url);

// 下面判断是否是 Node 单可执行文件 SEA，供选择嵌入模块加载策略。
const isNodeSeaBinary =
	// 优先使用 process.features 中公开的 sea 标记。
	("sea" in process.features && process.features.sea === true) ||
	// 否则安全取得 node:sea 内建模块并询问 isSea；可选链容忍没有模块。
	process.getBuiltinModule("node:sea")?.isSea() === true;
// 既不是 Bun binary 且当前扩展加载器文件仍为 .ts 时，视为源码运行模式。
const isTypeScriptSourceRuntime = !isBunBinary && path.extname(fileURLToPath(import.meta.url)) === ".ts";
// Bun binary、Node SEA 和 Node bundle 都走内嵌模块策略。
const usesEmbeddedModules = isBunBinary || isNodeSeaBinary || isBundledNode;

// 缓存“取得 jiti 构造函数”的 Promise；typeof createJiti 引用函数类型，不执行它。
let createJitiPromise: Promise<typeof createJiti> | undefined;

// 取得 jiti 实现。无输入，返回构造函数 Promise；首次异步加载，后续复用同一 Promise。
// 嵌入模式用 static 入口以带上转译依赖，普通模式用懒入口；例如启动不加载任何外部扩展时不用加载 Babel。若首次导入失败，拒绝 Promise 也会留在此缓存。
function getCreateJiti(): Promise<typeof createJiti> {
	// ??= 只在缓存尚空时加载；这里是既有真实动态 import，调用这个函数时才开始，不是类型引用。
	createJitiPromise ??= (usesEmbeddedModules ? import("./jiti-static-loader.ts") : import("./jiti-loader.ts")).then(
		// then 回调输入模块命名空间，返回其中 createJiti 函数引用，不创建 jiti 实例。
		(module) => module.createJiti,
	);
	// 返回已缓存的加载结果，包含进行中/成功/失败状态。
	return createJitiPromise;
}

// 虚拟模块字典的异步缓存，键是包入口名，值可能是各种导出对象。
let virtualModulesPromise: Promise<Record<string, unknown>> | undefined;

// 取得供 jiti 复用宿主包的虚拟模块。无输入，返回模块字典 Promise，无模型请求。
// 第一次导入 virtual-modules 后取 VIRTUAL_MODULES，之后复用；清扩展工厂缓存不会清这个 Promise。
function getVirtualModules(): Promise<Record<string, unknown>> {
	// 动态导入在首次执行这里时发生；then 仅提取字典，不调用字典中函数。
	virtualModulesPromise ??= import("./virtual-modules.ts").then((module) => module.VIRTUAL_MODULES);
	// 返回同一虚拟模块加载 Promise。
	return virtualModulesPromise;
}

/**
 * Get aliases for jiti (used in built Node.js mode).
 * In compiled binary mode, virtualModules is used instead.
 */
// 普通未打包 Node 产物使用的包别名缓存，null 表示尚未计算。
let _aliases: Record<string, string> | null = null;

// 计算未打包构建的 jiti 包入口别名。无输入，返回缓存字典；会探测文件/解析模块，不执行扩展工厂。
// 优先工作区 dist，否则用安装解析；同时支持现包名、旧包名和旧 TypeBox 名称。例如扩展导入 pi-ai 时指向扩展兼容视图。
function getAliases(): Record<string, string> {
	// 已有别名直接返回同一对象，不重复磁盘探测。
	if (_aliases) return _aliases;

	// 由此加载器 URL 算模块目录；这是既有适配实现，不要把该布局假设复制到普通业务模块。
	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	// 按构建后的目录结构定位 coding-agent index.js。
	const packageIndex = path.resolve(__dirname, "../..", "index.js");

	// 定位当前安装的 TypeBox 主入口，resolve 不执行模块。
	const typeboxEntry = require.resolve("typebox");
	// 定位 TypeBox 编译校验器子入口。
	const typeboxCompileEntry = require.resolve("typebox/compile");
	// 定位 TypeBox value 操作子入口。
	const typeboxValueEntry = require.resolve("typebox/value");

	// 从扩展目录向上定位工作区 packages 根，供源码仓库构建产物优先解析。
	const packagesRoot = path.resolve(__dirname, "../../../../");
	// 解析助手输入工作区相对文件和包 specifier，返回实际文件路径；只读存在性/模块解析，失败可抛。
	// 例如 agent/dist/index.js 存在就复用，否则按当前安装解析 pi-agent-core，避免加载不同副本。
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
		// 把 packages 根和期望构建产物拼成候选。
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		// 优先使用已经存在的工作区 dist 文件。
		if (fs.existsSync(workspacePath)) {
			// 直接返回工作区路径。
			return workspacePath;
		}
		// 不存在则用 ESM 解析已安装包入口，再转成本地路径。
		return fileURLToPath(import.meta.resolve(specifier));
	};

	// coding-agent 入口使用已经确定的 index.js。
	const piCodingAgentEntry = packageIndex;
	// Agent core 指向同一工作区/安装依赖，保持类型与运行时对象一致。
	const piAgentCoreEntry = resolveWorkspaceOrImport("agent/dist/index.js", "@earendil-works/pi-agent-core");
	// TUI 也复用宿主对应包入口。
	const piTuiEntry = resolveWorkspaceOrImport("tui/dist/index.js", "@earendil-works/pi-tui");
	// Extensions resolve the pi-ai root to the extension view: the compat
	// entrypoint (a strict superset of the core entrypoint) plus TypeBox's Type,
	// Static and TSchema, so extensions using the old global API and pi-ai's
	// former TypeBox re-exports keep working.
	// 扩展的 pi-ai 根使用兼容视图，还补旧版 TypeBox 重导出，不直接指普通 core 根。
	const piAiCompatEntry = path.resolve(__dirname, "pi-ai-extension-view.js");
	// Models 专门子入口仍指对应真实模块。
	const piAiModelsEntry = resolveWorkspaceOrImport("ai/dist/models.js", "@earendil-works/pi-ai/models");
	// OAuth 专门子入口指实际安装/工作区文件。
	const piAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "@earendil-works/pi-ai/oauth");
	// 供应商工厂子入口按同样优先规则解析。
	const piAiProvidersEntry = resolveWorkspaceOrImport(
		// 工作区候选是 ai/dist/providers/all.js。
		"ai/dist/providers/all.js",
		// 候选不存在时使用标准供应商包 specifier。
		"@earendil-works/pi-ai/providers/all",
	);

	// 构造 specifier 到文件地址字典；赋给模块缓存供后续 jiti 实例复用。
	_aliases = {
		// 当前 coding-agent 包名映射到宿主入口。
		"@earendil-works/pi-coding-agent": piCodingAgentEntry,
		// 当前 Agent core 包名映射到宿主实例。
		"@earendil-works/pi-agent-core": piAgentCoreEntry,
		// 当前 TUI 包名映射到宿主实例。
		"@earendil-works/pi-tui": piTuiEntry,
		// 供应商工厂入口保持独立映射。
		"@earendil-works/pi-ai/providers/all": piAiProvidersEntry,
		// 显式 compat 与根入口共用扩展兼容视图。
		"@earendil-works/pi-ai/compat": piAiCompatEntry,
		// 模型集合入口使用实际 Models 文件。
		"@earendil-works/pi-ai/models": piAiModelsEntry,
		// OAuth 入口使用实际 OAuth 文件。
		"@earendil-works/pi-ai/oauth": piAiOauthEntry,
		// pi-ai 根统一导向扩展兼容视图。
		"@earendil-works/pi-ai": piAiCompatEntry,
		// 旧 coding-agent 包名也指向同一宿主入口，兼容老扩展。
		"@mariozechner/pi-coding-agent": piCodingAgentEntry,
		// 旧 Agent core 包名避免重新加载另一个副本。
		"@mariozechner/pi-agent-core": piAgentCoreEntry,
		// 旧 TUI 包名同样复用当前 TUI。
		"@mariozechner/pi-tui": piTuiEntry,
		// 旧供应商入口映射到当前供应商工厂。
		"@mariozechner/pi-ai/providers/all": piAiProvidersEntry,
		// 旧 compat 映射到当前扩展兼容视图。
		"@mariozechner/pi-ai/compat": piAiCompatEntry,
		// 旧 Models 子入口映射到当前实现。
		"@mariozechner/pi-ai/models": piAiModelsEntry,
		// 旧 OAuth 子入口映射到当前实现。
		"@mariozechner/pi-ai/oauth": piAiOauthEntry,
		// 旧 pi-ai 根也使用同一兼容视图。
		"@mariozechner/pi-ai": piAiCompatEntry,
		// 现代 typebox 根入口。
		typebox: typeboxEntry,
		// 现代 typebox/compile 子入口。
		"typebox/compile": typeboxCompileEntry,
		// 现代 typebox/value 子入口。
		"typebox/value": typeboxValueEntry,
		// 旧 @sinclair/typebox 根也指向当前 TypeBox，保持 schema 标记一致。
		"@sinclair/typebox": typeboxEntry,
		// 旧编译入口复用当前 compile。
		"@sinclair/typebox/compile": typeboxCompileEntry,
		// 旧 value 入口复用当前 value。
		"@sinclair/typebox/value": typeboxValueEntry,
	};

	// 返回构造好的别名表，不自动加载其中所有文件。
	return _aliases;
}

// 内部处理器统一签名接受任意参数并给 Promise<unknown>；公开事件的具体类型由 ExtensionAPI 重载约束。
type HandlerFn = (...args: unknown[]) => Promise<unknown>;

// 工厂缓存当前所属的规范 cwd；切目录时需要失效。
let extensionCacheCwd: string | undefined;
// 缓存代次，清理后增加，防止清理前在途导入回写旧工厂。
let extensionCacheGeneration = 0;
// 按解析后的扩展地址缓存工厂函数；缓存的是函数，不是已初始化 Extension 对象。
const extensionCache = new Map<string, ExtensionFactory>();

// 导入开始时捕获的缓存身份，用 cwd 和代次共同判断是否还能读写缓存。
interface ExtensionCacheToken {
	// 该次加载所属的规范 cwd。
	cwd: string;
	// 开始加载时的清理代次。
	generation: number;
}

// 清工厂缓存。无输入/返回，清 Map、重置 cwd 并递增代次；不撤销旧扩展运行时或清 jiti 实现 Promise。
// 例如 /reload 后再次导入文件；旧在途导入不再能写入新代次缓存。
export function clearExtensionCache(): void {
	// 移除所有已缓存工厂引用。
	extensionCache.clear();
	// 清掉所属目录，下一次缓存加载重新绑定。
	extensionCacheCwd = undefined;
	// 即使 cwd 相同，代次不同也让旧 token 失效。
	extensionCacheGeneration++;
}

// 为缓存加载绑定 cwd。输入目录，返回规范 cwd/当前代次 token；切目录会清缓存，不运行工厂。
// 例如从 /a 切 /b 时不能复用 /a 下的工厂解析结果。
function useExtensionCacheCwd(cwd: string): ExtensionCacheToken {
	// 统一绝对化和展开目录形式。
	const resolvedCwd = resolvePath(cwd);
	// 只有已经绑定且平台路径比较不等时才清缓存。
	if (extensionCacheCwd !== undefined && !pathsEqual(extensionCacheCwd, resolvedCwd)) {
		// 清工厂并增加代次，旧 token 不能回写。
		clearExtensionCache();
	}
	// 记录本次规范目录。
	extensionCacheCwd = resolvedCwd;
	// 对象属性显式返回 token，后续导入可验证它仍有效。
	return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
// 创建未绑定会话的共享 runtime。无输入，返回状态/动作对象；多数动作先抛未初始化错误，注册 Provider 可先排队。
// 例如扩展加载时可 registerProvider，但不能 sendUserMessage；runner.bindCore 后会替换动作。此函数不创建 AgentSession 或请求模型。
export function createExtensionRuntime(): ExtensionRuntime {
	// 未初始化动作桩无参数、无正常返回；一旦被调用立即抛错，避免工厂误用会话动作。
	const notInitialized = () => {
		// 明确提示加载期不能调用动作，异常将由工厂加载边界处理。
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	// 共享失效状态，闭包读取它以拒绝旧 API；? 表示尚未失效时没有消息。
	const state: { staleMessage?: string } = {};
	// 追踪事件总线退订函数，运行时失效时统一清理。
	const eventBusUnsubscribers = new Set<() => void>();
	// 活动检查无输入/返回，失效才抛错；不负责初始化完成与否，动作桩另行处理。
	const assertActive = () => {
		// 非空 staleMessage 表示已经失效。
		if (state.staleMessage) {
			// 抛原失效说明，阻止后续旧上下文动作。
			throw new Error(state.staleMessage);
		}
	};

	// 下面字面量提供所有字段，后面通过 bindCore 替换可执行会话能力。
	const runtime: ExtensionRuntime = {
		// 发 custom 消息在加载期不可用。
		sendMessage: notInitialized,
		// 发用户消息在加载期不可用。
		sendUserMessage: notInitialized,
		// 追加持久 custom 状态在绑定前不可用。
		appendEntry: notInitialized,
		// 设置显示名在绑定前不可用。
		setSessionName: notInitialized,
		// 读取当前显示名在绑定前不可用。
		getSessionName: notInitialized,
		// 设置历史标签在绑定前不可用。
		setLabel: notInitialized,
		// 读取激活工具要等会话注册表绑定。
		getActiveTools: notInitialized,
		// 读取工具信息要等会话绑定。
		getAllTools: notInitialized,
		// 读取有效设置的动作也使用未初始化桩。
		getSettings: notInitialized,
		// 改变激活工具在绑定前不可用。
		setActiveTools: notInitialized,
		// registerTool() is valid during extension load; refresh is only needed post-bind.
		// refreshTools 桩无参且无操作，使加载期 registerTool 合法；绑定后才真正刷新会话注册表。
		refreshTools: () => {},
		// 列斜杠命令在绑定前不可用。
		getCommands: notInitialized,
		// setModel 桩返回拒绝 Promise 而非同步 throw，保留公开异步签名；创建桩时不产生拒绝。
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		// 思考级别读取依赖会话，绑定前拒绝。
		getThinkingLevel: notInitialized,
		// 思考级别设置同样拒绝。
		setThinkingLevel: notInitialized,
		// 所有扩展共享参数值 Map，默认值与 CLI 显式值最终汇入这里。
		flagValues: new Map(),
		// 配置式 Provider 注册暂存队列。
		pendingProviderRegistrations: [],
		// 原生 Provider 注册暂存队列。
		pendingNativeProviderRegistrations: [],
		// 会话级 MCP 声明注册表，此处只创建表，不建立服务器连接。
		mcpServers: new McpServerRegistry(),
		// 虚拟模型声明暂存队列，route 稍后才执行。
		pendingVirtualModelRegistrations: [],
		// 真正 ctx 也要等 runner 提供，加载期不能拿可用会话上下文。
		createContext: notInitialized,
		// 属性简写把上方的失效检查函数放入 runtime。
		assertActive,
		// 失效回调输入可选消息、返回 void；只首次记录并清本运行时总线订阅，不卸载任意用户资源。
		invalidate: (message) => {
			// 已记录非空失效消息时重复 invalidate 无操作。
			if (state.staleMessage) return;
			// 选择给定或默认旧上下文错误消息。
			state.staleMessage =
				// ?? 保留明确字符串，只在未提供时用固定文案。
				message ??
				// 默认文案说明替换后应改用 withSession 新上下文；只是字符串，不执行其中提到的操作。
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
			// 依次调用本运行时追踪的总线退订函数。
			for (const unsubscribe of eventBusUnsubscribers) unsubscribe();
			// 清空追踪集合，释放订阅闭包引用。
			eventBusUnsubscribers.clear();
		},
		// 追踪订阅回调接原退订函数，返回幂等包装；注册追踪本身不会取消订阅。例：手动 off 一次后，runtime.invalidate 不重复 off。
		trackEventBusSubscription: (unsubscribe) => {
			// 局部 active 标记记录该订阅是否仍需清理。
			let active = true;
			// 退订包装无输入/返回，删除追踪项并调用原 off，重复调用直接跳过。
			const trackedUnsubscribe = () => {
				// 已经清理过则无需再次调用原函数。
				if (!active) return;
				// 先标为不活动，保证重入时也不重复清理。
				active = false;
				// 从集合删掉当前包装，避免失效时重复处理。
				eventBusUnsubscribers.delete(trackedUnsubscribe);
				// 实际取消底层事件总线订阅。
				unsubscribe();
			};
			// 加入追踪集合以便运行时失效统一释放。
			eventBusUnsubscribers.add(trackedUnsubscribe);
			// 返回包装后的 off 给调用者，而非原 off。
			return trackedUnsubscribe;
		},
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		// 绑定前配置式注册回调接名称/配置/来源，返回 void，只追加队列；不校验整个 Provider 或发请求。
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			// 把三个字段对象追加，后续服务装配或 bindCore 消费。
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		// 原生注册回调接完整 Provider 与来源，返回 void，只暂存对象，不调用其 stream。
		registerNativeProvider: (provider, extensionPath = "<unknown>") => {
			// 队列保存 Provider 引用与错误归属路径。
			runtime.pendingNativeProviderRegistrations.push({ provider, extensionPath });
		},
		// 绑定前注销回调输入名称，只删除两类未消费声明；不改变已经注册的模型运行时。
		unregisterProvider: (name) => {
			// filter 建新数组，去掉所有同名配置式待注册项。
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
			// 同时筛掉同名原生声明，不只处理配置式路径。
			runtime.pendingNativeProviderRegistrations = runtime.pendingNativeProviderRegistrations.filter(
				// 原生声明的身份使用 provider.id。
				(r) => r.provider.id !== name,
			);
		},
		// 虚拟注册回调输入定义/来源，返回 void；先排队，不调用路由器。
		registerVirtualModel: (definition, extensionPath = "<unknown>") => {
			// 保存供绑定后实际登记的虚拟声明。
			runtime.pendingVirtualModelRegistrations.push({ definition, extensionPath });
		},
		// 绑定前虚拟注销回调接 provider/id，返回 void；只从待处理队列剔除相同二元身份。
		unregisterVirtualModel: (provider, id) => {
			// 用 filter 生成保留项数组。
			runtime.pendingVirtualModelRegistrations = runtime.pendingVirtualModelRegistrations.filter(
				// 只要 provider 或 id 有一个不同就保留，两个都相同才删除。
				({ definition }) => definition.provider !== provider || definition.id !== id,
			);
		},
	};

	// 返回共享对象；此刻它仍不是已经具备全部会话动作的 runner。
	return runtime;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
// 为单个扩展创建 API 与 commit/discard 控制器。输入扩展记录、共享 runtime、cwd 和总线；返回三者，不执行工厂。
// 本地工具/事件等写 extension；加载期共享变更先暂存，成功后 commit，失败 discard 清订阅/待处理项。它不是任意用户副作用或部分提交的原子回滚机制。
function createExtensionAPI(
	// 本扩展私有注册表，成功后才进入加载结果 extensions。
	extension: Extension,
	// 所有扩展共享的会话桥梁，绑定前后动作实现不同。
	runtime: ExtensionRuntime,
	// exec 未显式给 cwd 时使用这个加载目录。
	cwd: string,
	// 同一批扩展间共享的通道事件总线。
	eventBus: EventBus,
	// 返回 api 和两个无参生命周期回调；公开工厂只得到 api。
): { api: ExtensionAPI; commit: () => void; discard: () => void } {
	// 本工厂尚未提交的参数默认值，防止失败工厂提前污染共享值。
	const pendingFlagValues = new Map<string, boolean | string>();
	// 待提交共享注册变更函数数组，存闭包而不是马上执行。
	const pendingRuntimeChanges: Array<() => void> = [];
	// 加载期间创建的总线 off 列表，失败时负责清掉这些订阅。
	const loadingUnsubscribers: Array<() => void> = [];
	// 字面量联合约束三阶段；初始 loading，成功 commit 才 active，失败 discard 成 failed。
	let state: "loading" | "active" | "failed" = "loading";
	// 此 API 的检查无参/无返回；先拒绝失败工厂，再检查共享 runtime 是否已失效。
	const assertActive = () => {
		// 工厂已失败后，保留的 API 引用也不能继续操作。
		if (state === "failed") {
			// 错误中保留扩展地址帮助定位，直接抛给调用方。
			throw new Error(`Extension "${extension.path}" failed to load and its API is no longer active.`);
		}
		// 即便本工厂成功，也必须拒绝会话替换后的旧 runtime。
		runtime.assertActive();
	};
	// 变更调度助手接无参 change 函数、返回 void；加载时排队，active 时即刻执行。例：registerProvider 在初始化成功后才跨到共享 runtime。
	const applyRuntimeChange = (change: () => void) => {
		// loading 时只保存闭包，不提前提交共享注册。
		if (state === "loading") pendingRuntimeChanges.push(change);
		// 已经 active 就执行本次变更，异常向当前调用者传播。
		else change();
	};
	// 清待处理容器，无输入/返回；只清列表/Map，不调用其中变更，也不撤销已执行的变更。
	const clearPending = () => {
		// 丢弃还未提交的默认参数值。
		pendingFlagValues.clear();
		// 清空变更数组，释放闭包。
		pendingRuntimeChanges.length = 0;
		// 清掉加载期 off 列表；成功时订阅仍由 runtime 追踪，失败时先另行调用 off。
		loadingUnsubscribers.length = 0;
	};

	// 构造实际传给工厂的对象；后面的动作都是方法定义，此刻没有逐个执行。
	const api = {
		// Registration methods - write to extension
		// 注册事件处理器。输入事件名/回调，返回 off；只写本扩展 handlers。例：pi.on('input',fn) 可多次注册，按顺序保存，不在注册时调用 fn。
		on(event: string, handler: HandlerFn): () => void {
			// 允许 loading/active，但拒绝失败或已失效实例。
			assertActive();
			// 创建独立转发闭包，保证同一个原 handler 注册两次也能分别退订；参数/返回值原样透传。
			const registeredHandler: HandlerFn = (...args) => handler(...args);
			// 该事件已有数组则复用，否则建新数组。
			const list = extension.handlers.get(event) ?? [];
			// 追加到事件尾部，决定同一扩展内执行顺序。
			list.push(registeredHandler);
			// 把数组写回本扩展 Map。
			extension.handlers.set(event, list);

			// off 回调无参数，按当前数组查找并删除本次包装；可重复调用，不清其他相同原 handler 注册。
			return () => {
				// 退订时重新读当前事件数组，容忍已经被清空。
				const handlers = extension.handlers.get(event);
				// 该事件不存在则无操作。
				if (!handlers) return;
				// 按本次包装函数引用找下标，不比较函数代码。
				const handlerIndex = handlers.indexOf(registeredHandler);
				// 包装已退订时直接返回。
				if (handlerIndex === -1) return;
				// splice 修改本事件数组，仅去掉一项。
				handlers.splice(handlerIndex, 1);
				// 最后一个处理器移除后删除事件键。
				if (handlers.length === 0) extension.handlers.delete(event);
			};
		},

		// 注册工具定义。输入 ToolDefinition，返回 void；校验 schema 外层形状，写本扩展表并请求刷新。
		// 同一扩展重复同名 set 覆盖旧定义，跨扩展同名规则由 runner 首个胜出；例如注册 read 不会立刻读取文件。
		registerTool(tool: ToolDefinition): void {
			// 工具注册也必须使用有效 API。
			assertActive();
			// 声明边界只要求 parameters 是非 null、非数组对象；不证明 schema 本身有效或一定是 object 类型 schema。
			if (typeof tool.parameters !== "object" || tool.parameters === null || Array.isArray(tool.parameters)) {
				// 不符合外层 schema 容器形状就抛错，拒绝登记工具。
				throw new Error(
					// 带工具名和扩展地址说明哪份声明缺 schema 对象。
					`Tool "${tool.name}" registered by extension "${extension.path}" must define an object parameter schema.`,
				);
			}
			// 按名称保存注册记录，Map.set 同名覆盖本扩展旧值。
			extension.tools.set(tool.name, {
				// 保存原工具定义引用，不复制或执行 execute。
				definition: tool,
				// 记录声明它的扩展来源，供提示与诊断使用。
				sourceInfo: extension.sourceInfo,
			});
			// 加载期默认无操作；绑定后会重建会话工具定义/实现/激活状态，可能触发 prepareLoadout 钩子。
			runtime.refreshTools();
		},

		// 注册斜杠命令。输入名称与去掉 name/sourceInfo 后的配置，返回 void；检查名称和 handler 后写本扩展 Map。
		// 例如注册 review 不执行 handler；同扩展同名覆盖，跨扩展同名最终由 runner 编成 name:序号。
		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			// 拒绝失败/失效 API，加载期间可以注册。
			assertActive();
			// 来自可执行扩展的声明边界仍检查非空字符串；没有额外 trim 名称。
			if (typeof name !== "string" || name.length === 0) {
				// 非法名称立即抛错。
				throw new Error(
					// 提示合法 registerCommand 调用格式，不自动生成默认名称。
					`Command registered by extension "${extension.path}" must have a non-empty string name. Use pi.registerCommand("name", { description, handler }).`,
				);
			}
			// 实际运行时确认 options.handler 是函数，而不只依赖 TS 声明。
			if (typeof options?.handler !== "function") {
				// 缺少命令执行函数就拒绝登记。
				throw new Error(`Command "/${name}" registered by extension "${extension.path}" must define handler().`);
			}
			// 以本扩展内命令名建索引，同名 set 覆盖。
			extension.commands.set(name, {
				// 默认记录调用者给的名称。
				name,
				// 标记命令来自当前扩展。
				sourceInfo: extension.sourceInfo,
				// 展开 description/handler/completion 等选项；运行时后展开同名键有优先权，Omit 只是编译期限制。
				...options,
			});
		},

		// 注册快捷键。输入 KeyId 与描述/handler，返回 void，只保存定义；冲突检测与规范小写在 runner.getShortcuts。
		// 例如注册 ctrl+alt+r 不立即执行回调，回调可能同步或异步。
		registerShortcut(
			// 快捷键字串在 TS 层受 KeyId 约束。
			shortcut: KeyId,
			// 内联对象类型声明可选说明与必需执行回调。
			options: {
				// 可供帮助/快捷键提示显示的描述。
				description?: string;
				// 既有 import(...) 在这里是类型查询，编译后擦除，不是实际动态加载；handler 接当前上下文，可返回 Promise 或 void。
				handler: (ctx: import("./types.ts").ExtensionContext) => Promise<void> | void;
			},
			// 注册方法无业务返回值，不向调用者返回键盘监听器。
		): void {
			// 检查 API 生命周期有效。
			assertActive();
			// 按快捷键原字符串保存；同扩展同原名覆盖，跨扩展小写归一后后者胜出但保留内置保留键限制。
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		// 声明 CLI 参数。输入名称、boolean/string 类别及默认值，返回 void；检查默认值类别、存声明并按阶段填默认值。
		// 例如 boolean 参数默认 false 不会因是假值而丢弃；已有共享显式值不会被默认覆盖。
		registerFlag(
			// 参数名称在本扩展 flags 中登记。
			name: string,
			// 实现内部用联合字段接两类声明，公开 ExtensionAPI 的判别联合约束更精确。
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
			// 无返回值，获取参数值需另调 getFlag。
		): void {
			// 确认工厂/API 尚可使用。
			assertActive();
			// 只有提供 default 时检查 typeof 是否与声明类别一致，校验来自扩展声明的运行时边界。
			if (options.default !== undefined && typeof options.default !== options.type) {
				// 默认值类型不符就报错，避免把字符串 true 当布尔默认。
				throw new Error(
					// 消息附参数名、声明类别及实际类别，不自动转换默认值。
					`Invalid default for flag "${name}": expected ${options.type}, got ${typeof options.default}`,
				);
			}
			// 保存声明与来源；这里的默认值尚不一定已经进入共享 runtime。
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			// 已有共享值优先；未提供 default 就不填值，false/空串仍是显式默认。
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				// 工厂未成功初始化时先隔离默认值。
				if (state === "loading") {
					// 本工厂同名默认首次暂存胜出，后续重复注册不覆写待提交默认。
					if (!pendingFlagValues.has(name)) pendingFlagValues.set(name, options.default);
					// API 已 active 才直接补共享默认。
				} else {
					// 将默认值写到共享 Map，仍不覆盖已有值。
					runtime.flagValues.set(name, options.default);
				}
			}
		},

		// 登记 custom_message 渲染器。输入 customType 与泛型 renderer，返回 void，按类型名保存，不画界面。
		// 例如 debug 消息稍后在 TUI 展示才调用；同扩展同类型替换原渲染器。
		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			// 拒绝失败或旧运行时 API。
			assertActive();
			// 断言擦掉此注册项的 details 泛型以放异构 Map，不转换函数或调用渲染。
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		// 登记 Markdown 显示变换。输入函数引用，返回 void；本扩展只保留一个，重复赋值替换。
		// 例如把界面 Markdown 链接改展示形式，并不改模型对话上下文。
		registerMarkdownTransformer(transformer: MarkdownTransformer): void {
			// 检查实例未失效。
			assertActive();
			// 只保存回调，实际渲染时由 UI 调用。
			extension.markdownTransformer = transformer;
		},

		// 登记不进模型上下文的 custom entry 渲染器。输入类型名/函数，返回 void；延迟建 Map 后保存。
		// 例如自定义状态条目在会话视图中可显示，登记不触发绘制。
		registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void {
			// 检查 API 可用性。
			assertActive();
			// ??= 只在可选 Map 缺省时创建，不清旧渲染器。
			extension.entryRenderers ??= new Map();
			// 按 customType 替换，as 仅把泛型函数放入统一表。
			extension.entryRenderers.set(customType, renderer as EntryRenderer);
		},

		// 追加工具渲染解析器。输入 resolver，返回 void，不执行 next 或渲染。
		// 后续 runner 按扩展加载顺序再按本数组顺序组成中间件，resolver 可委托 next。
		registerToolRenderer(resolver: ToolRendererResolver): void {
			// 拒绝旧 API 注册。
			assertActive();
			// 可选数组首次使用才创建。
			extension.toolRenderers ??= [];
			// push 保留多个解析器的注册顺序，不覆盖前一个。
			extension.toolRenderers.push(resolver);
		},

		// Flag access - checks extension registered it, reads from runtime
		// 读本扩展声明的 CLI 参数。输入名，返回 boolean/string/undefined，无额外解析。
		// 共享值优先于尚待提交默认，例如工厂内可读取自己刚 registerFlag 的默认；不能借此读取自己没声明的参数。
		getFlag(name: string): boolean | string | undefined {
			// 读取也受 failed/stale 生命周期约束。
			assertActive();
			// 本扩展未声明名字即返回 undefined，即使共享 Map 有同名值也不可读。
			if (!extension.flags.has(name)) return undefined;
			// has 区分缺键与合法 false/空字符串；共享值存在就取它，否则取本工厂待提交默认。
			return runtime.flagValues.has(name) ? runtime.flagValues.get(name) : pendingFlagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		// 委托发送自定义消息。输入消息/投递选项，返回 void；绑定前动作桩抛错，绑定后宿主决定入队/记历史/是否触发模型。
		// 例如 display:false 仍可能给模型作为上下文，这里不 await 回答。
		sendMessage(message, options): void {
			// 先检查当前 API 尚有效。
			assertActive();
			// 原样交共享动作，实际副作用和异步错误处理由绑定实现承担。
			runtime.sendMessage(message, options);
		},

		// 委托用户消息。输入文字/图片及选项，返回 void，绑定后可能开始或排队一轮模型工作。
		// 例如 deliverAs:followUp 在忙碌时排追问；本方法不返回完整助手回复 Promise。
		sendUserMessage(content, options): void {
			// 先检查 API 生命周期。
			assertActive();
			// 转给当前宿主动作，绑定前会同步报未初始化。
			runtime.sendUserMessage(content, options);
		},

		// 追加自定义状态条目。输入类型与可选 unknown 数据，返回 void，绑定后可能持久化；不作为模型消息发送。
		// 例如保存扩展审批状态，恢复时再从历史读。
		appendEntry(customType: string, data?: unknown): void {
			// 防止失效工厂继续写旧会话。
			assertActive();
			// 实际历史写入交 runtime.appendEntry，不在这里自行访问 JSONL。
			runtime.appendEntry(customType, data);
		},

		// 设置会话名。输入名称，返回 void，绑定后写会话元数据/发通知；例如扩展命令给当前任务起名，不切会话。
		setSessionName(name: string): void {
			// 拒绝失败或失效实例操作。
			assertActive();
			// 名称规范与持久化由当前会话动作处理。
			runtime.setSessionName(name);
		},

		// 读取会话显示名。无参数，返回字符串或 undefined，无写入；绑定前桩抛错。例如未命名会话得到 undefined。
		getSessionName(): string | undefined {
			// 读取旧会话 API 也需要失败检查。
			assertActive();
			// 转交运行时 getter，不缓存旧名字。
			return runtime.getSessionName();
		},

		// 设置/清除条目标签。输入 entryId 与可选 label，返回 void；绑定后追加标签元数据。
		// 例如传 undefined 清标签，不删目标对话条目。
		setLabel(entryId: string, label: string | undefined): void {
			// 先拒绝失效 API。
			assertActive();
			// 交历史管理层实施标签规则。
			runtime.setLabel(entryId, label);
		},

		// 执行子进程。输入程序、独立 argv 和可选配置，返回 ExecResult Promise；会实际启动命令。
		// 显式 options.cwd 优先，否则使用扩展加载 cwd；例如 git status 参数分开传，不在此自动串成 shell 命令。
		exec(command: string, args: string[], options?: ExecOptions) {
			// 有效 API 才能启动外部动作；加载期若工厂主动 exec，它可立即发生，不属于待提交 Provider 队列。
			assertActive();
			// ?? 在 cwd 未给时回退，原选项继续传给 execCommand；错误/取消按其返回契约处理。
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		// 读取激活工具名。无输入，返回数组，绑定前报错；例如 read 已注册但未激活时不在该名单。
		getActiveTools(): string[] {
			// 防止从旧运行时读取陈旧状态。
			assertActive();
			// 让宿主返回当前激活集合，而非只列本扩展工具。
			return runtime.getActiveTools();
		},

		// 读取完整工具信息。无输入，返回 ToolInfo 数组；可包含未激活/非声明工具，绑定前报错。
		// 例如扩展可据 exposure 选择展示，但这不等于所有项都可直接执行。
		getAllTools() {
			// 检查 API 生命周期。
			assertActive();
			// 向共享会话索取 schema/来源/暴露信息，不执行工具。
			return runtime.getAllTools();
		},

		// 读取有效设置。无输入，返回宿主的 Settings 拷贝，绑定前不可用。
		// 例如读压缩策略不会发起压缩，也不把返回对象改动自动保存。
		getSettings() {
			// 失效上下文不能继续读旧会话设置。
			assertActive();
			// 具体合并与复制规则由宿主 getSettings 提供。
			return runtime.getSettings();
		},

		// 指定激活工具名称。输入数组，返回 void，绑定后调整声明/提示词并可能运行 prepareLoadout。
		// 例如只激活 read；未知和 hidden 名由会话规则忽略，不是在此删除工具注册。
		setActiveTools(toolNames: string[]): void {
			// 检查有效 API。
			assertActive();
			// 原名单交会话处理允许/排除和暴露策略。
			runtime.setActiveTools(toolNames);
		},

		// 列当前斜杠命令。无输入，返回 SlashCommandInfo 数组，绑定前报错。
		// 包括扩展、模板、技能命令，不执行 handler。
		getCommands() {
			// 读取前检查生命周期。
			assertActive();
			// 委托宿主收集当前命令列表。
			return runtime.getCommands();
		},

		// 切换当前会话模型。输入模型对象，返回 Promise<boolean>；绑定前拒绝，绑定后认证未配置可 false，具体设置异常仍可拒绝。
		// 成功改变会话选择和历史，不在此发一次聊天，也不修改全局默认。
		setModel(model) {
			// 检查旧 API 不得继续操作。
			assertActive();
			// 透传当前绑定 setModel 的异步结果，调用者可以 await。
			return runtime.setModel(model);
		},

		// 读取思考级别。无输入，返回当前级别，绑定前报错；例如 high 是设置选择，不是已消耗思考 token。
		getThinkingLevel() {
			// 拒绝失效上下文读取。
			assertActive();
			// 从会话实时读取，而非工厂创建时快照。
			return runtime.getThinkingLevel();
		},

		// 设置思考级别。输入级别，返回 void；绑定后按模型能力限制并写会话变更，不直接触发推理。
		// 例如 unsupported max 可能收窄到支持级别，全局默认由其他持久化入口控制。
		setThinkingLevel(level) {
			// 生命周期检查在委托之前。
			assertActive();
			// 让会话统一执行能力收窄和通知。
			runtime.setThinkingLevel(level);
		},

		// 注册供应商的两种实现入口。输入原生 Provider 或名称+配置，返回 void；加载期先暂存，active 后直接委托。
		// 字符串必须伴 config；例如自建代理不等于立即请求模型，实际结构校验主要在后续运行时注册边界。
		registerProvider(providerOrName: Provider | string, config?: ProviderConfig) {
			// 失败工厂或陈旧 API 不能再登记。
			assertActive();
			// typeof 收窄合法联合，区分配置式与原生式注册。
			if (typeof providerOrName === "string") {
				// 配置式名称没有 config 就立即拒绝，避免只排一个不完整声明。
				if (!config) throw new Error("Provider config is required when registering by name");
				// 闭包捕获名称/配置/来源：loading 暂存，commit/active 时调用共享注册函数。
				applyRuntimeChange(() => runtime.registerProvider(providerOrName, config, extension.path));
				// 配置式路径处理完提前结束，不误走原生分支。
				return;
			}
			// 原生 Provider 同样按阶段调度，保存对象不调用其 auth/stream。
			applyRuntimeChange(() => runtime.registerNativeProvider(providerOrName, extension.path));
		},

		// 注销供应商扩展覆盖。输入名称，返回 void；加载期暂存注销，active 后交运行时处理。
		// 例如内置供应商被覆盖时，注销可恢复基础定义，不保证整个供应商消失。
		unregisterProvider(name: string) {
			// 检查 API 可用性。
			assertActive();
			// 带来源交共享注销函数；绑定前行为是过滤待注册队列。
			applyRuntimeChange(() => runtime.unregisterProvider(name, extension.path));
		},

		// 登记会话级 MCP 声明。输入名/配置，返回 void；校验配置、归属和命名空间后按阶段写注册表，不自行建立连接。
		// 例如 docs-server 与 docs_server 规范化后会占同一 namespace，已提交表出现这种冲突会被拒绝；加载成功后由处理 MCP 的扩展连接。
		registerMcpServer(name: string, config: McpServerConfig) {
			// 先检查实例可用。
			assertActive();
			// 把声明作为外部配置边界运行验证，返回规范配置或错误字符串。
			const validated = validateMcpServerConfig(name, config);
			// string 分支代表验证失败，而不是服务器 URL 本身。
			if (typeof validated === "string") {
				// 抛带扩展来源的配置错误，不继续注册。
				throw new Error(`Invalid MCP server registered by extension "${extension.path}": ${validated}`);
			}
			// 查询当前共享表里同名服务器的所有者，可能尚不存在。
			const owner = runtime.mcpServers.get(name)?.extensionPath;
			// 只允许未占用或同扩展替换，其他扩展同名拒绝。
			if (owner !== undefined && owner !== extension.path) {
				// 说明哪份扩展已经占用此名字。
				throw new Error(`MCP server "${name}" is already registered by extension "${owner}"`);
			}
			// Names that differ only in `-` and `_` would share a namespace.
			// 下面检查原名称不同却规范 namespace 相同的冲突。
			const clash = runtime.mcpServers
				// list 给服务器拷贝列表，不直接改变共享表。
				.list()
				// find 检查不同原名的 mcpNamespace 是否相等，返回首个冲突项。
				.find((server) => server.name !== name && mcpNamespace(server.name) === mcpNamespace(name));
			// 冲突时抛错，避免两个服务器暴露相同工具命名空间。
			if (clash) throw new Error(`MCP server "${name}" conflicts with registered server "${clash.name}"`);
			// structuredClone 复制已验证配置，让后续调用者修改原输入不影响该登记值。
			const server = { name, config: structuredClone(validated), extensionPath: extension.path };
			// 调度实际注册；加载期还没写表，检查依据当前已提交表，不是整个待提交列表的事务预检。
			applyRuntimeChange(() => runtime.mcpServers.register(server));
		},

		// 移除本扩展 MCP 声明。输入名称，返回 void；按阶段调度，注册表仅允许所有者注销。
		// 连接关闭由监听注册变化的 MCP 扩展协调，本函数不直接发关闭协议。
		unregisterMcpServer(name: string) {
			// 拒绝旧 API。
			assertActive();
			// 传当前扩展路径执行归属检查，不删除其他扩展的服务器。
			applyRuntimeChange(() => runtime.mcpServers.unregister(name, extension.path));
		},

		// 列已提交 MCP 声明。无输入，返回 RegisteredMcpServer 数组拷贝，不建立连接。
		// 加载阶段尚未 commit 的本工厂登记可能还不在列表里。
		getMcpServers() {
			// 检查共享 runtime 还有效。
			assertActive();
			// 注册表 list 复制条目和配置，调用者不会直接拿到内部 Map。
			return runtime.mcpServers.list();
		},

		// 登记带扩展 ctx 的虚拟模型。输入泛型声明，返回 void；包装 route 后按阶段注册。
		// TState 仅约束路由状态类型，真正请求时才创建最新 ctx 并调用 model.route，例如 smart 根据会话负载选真实模型。
		registerVirtualModel<TState>(model: ExtensionVirtualModel<TState>) {
			// 检查本扩展 API 未失效。
			assertActive();
			// Routing runs after the runner binds, so the context is created per request. The state
			// comes from the session branch that this router wrote.
			// 构造底层不额外接 ctx 的 VirtualModelDefinition。
			const definition: VirtualModelDefinition = {
				// 保留目录展示/能力等声明字段。
				...model,
				// route 回调接底层 request，断言状态泛型后交扩展 route；每次调用才 runtime.createContext，不在这里提前缓存上下文或发送请求。
				route: (request) => model.route(request as ModelRouteRequest<TState>, runtime.createContext()),
			};
			// 注册函数本身仍受 loading/active 阶段调度，不马上运行 route。
			applyRuntimeChange(() => runtime.registerVirtualModel(definition, extension.path));
		},

		// 注销某虚拟模型。输入 provider/id，返回 void；加载期删除/调度待登记项，绑定后交模型运行时移除目录。
		// 不抹除会话原始历史中的模型选择记录。
		unregisterVirtualModel(provider: string, id: string) {
			// 拒绝 failed/stale API。
			assertActive();
			// 无参变更闭包延迟到提交或当下执行。
			applyRuntimeChange(() => runtime.unregisterVirtualModel(provider, id));
		},

		// events 是扩展间通信总线，不是 Agent 生命周期 pi.on 的处理器表。
		events: {
			// 发送通道消息。输入 channel/data，返回 void，立即通知当前总线监听器。
			// 例如 ready 通道发连接状态；监听器异步完成不由本方法 await，也不是所有副作用可由 discard 回滚。
			emit(channel, data) {
				// 失效 API 不允许继续 emit。
				assertActive();
				// 共享总线按通道分发，具体异常隔离由 EventBus 实现处理。
				eventBus.emit(channel, data);
			},
			// 订阅共享通道。输入 channel/handler，返回可重复调用的 off；现在登记监听，不立刻调用 handler。
			// 加载期失败会清此 off，成功后运行时失效也会统一清理。
			on(channel, handler) {
				// 先拒绝失效实例。
				assertActive();
				// 先订阅，再用 runtime 包装/追踪退订函数。
				const unsubscribe = runtime.trackEventBusSubscription(eventBus.on(channel, handler));
				// loading 时额外列入失败工厂清理表；active 订阅只需 runtime 生命周期追踪。
				if (state === "loading") loadingUnsubscribers.push(unsubscribe);
				// 把包装后的 off 交扩展手动解除。
				return unsubscribe;
			},
		},
		// as ExtensionAPI 让实现对象按公开重载契约对外，断言不进行结构验证或修改方法。
	} as ExtensionAPI;

	// 向初始化器同时返回 API 与加载事务控制动作，工厂本身只接 api。
	return {
		// 工厂注册入口对象引用。
		api,
		// commit 无参数/返回，成功工厂后提交默认值和共享变更；过程可能抛错且不保证原子回滚。
		// 例如第一个共享变更成功第二个抛错，已应用项不会被下面 discard 自动撤销。
		commit: () => {
			// 只允许 loading 提交一次，active/failed 重复调用无操作。
			if (state !== "loading") return;
			// 共享 runtime 若已被替换，应停止提交旧工厂。
			runtime.assertActive();
			// 逐个合并待提交默认值，保留迭代顺序。
			for (const [name, value] of pendingFlagValues) {
				// 已有共享值优先，避免覆盖 CLI/其他已提交声明值。
				if (!runtime.flagValues.has(name)) runtime.flagValues.set(name, value);
			}
			// 按原始注册顺序真正执行待变更闭包，任一抛错会打断后续循环。
			for (const apply of pendingRuntimeChanges) apply();
			// 全部执行成功后才进入 active，后续注册实时生效。
			state = "active";
			// 清掉暂存容器，成功订阅仍保留在 runtime 追踪集合。
			clearPending();
		},
		// discard 无参数/返回，只对 loading 工厂标失败并解除加载期总线订阅。
		// 不恢复先前已 commit 的状态，也不回滚工厂自行 exec/文件写入等任意副作用。
		discard: () => {
			// 非 loading 时不做二次清理。
			if (state !== "loading") return;
			// 先标 failed，使遗留 API 引用后续调用抛错。
			state = "failed";
			// 解除加载过程中登记的共享总线监听。
			for (const unsubscribe of loadingUnsubscribers) unsubscribe();
			// 丢弃未执行共享变更与默认值，清空本地追踪列表。
			clearPending();
		},
	};
}

// 判断异步加载的缓存 token 仍有效。输入可选 token，返回 boolean 并在 TS 层收窄类型；不读文件。
// cwd 和 generation 都一致才可读写工厂缓存，例如 reload 后旧导入虽完成也不能回写。
function isCurrentCacheToken(cacheToken: ExtensionCacheToken | undefined): cacheToken is ExtensionCacheToken {
	// 下面三个条件必须同时成立。
	return (
		// 先确认实参不是 undefined，后面安全读字段。
		cacheToken !== undefined &&
		// 目录必须与此刻缓存所属字符串完全一致。
		extensionCacheCwd === cacheToken.cwd &&
		// 缓存代次也必须一致，防止同目录清理后旧结果复活。
		extensionCacheGeneration === cacheToken.generation
	);
}

// 加载模块并取工厂。输入解析后扩展地址与可选缓存 token；异步返回工厂或 undefined，导入/转译错误抛出。
// 有效缓存命中就复用函数；否则按打包模式配置 jiti 导入，只有导出为函数才接受。复用工厂不等于复用上次初始化状态。
async function loadExtensionModule(extensionPath: string, cacheToken?: ExtensionCacheToken) {
	// 先检查 token 是当前代次，非缓存调用不会读 Map。
	if (isCurrentCacheToken(cacheToken)) {
		// 按绝对扩展地址取已导入工厂。
		const cachedFactory = extensionCache.get(extensionPath);
		// 命中函数才可直接复用，Map 不缓存无效导出。
		if (cachedFactory) {
			// 返回旧工厂引用，调用方仍会重新执行初始化。
			return cachedFactory;
		}
	}

	// 真正首次加载 jiti 实现并等待可创建实例。
	const createJitiImpl = await getCreateJiti();
	// Compiled binaries and the bundled Node distribution use embedded modules.
	// Source TypeScript reuses host modules and root tsconfig paths. Unbundled
	// Node builds use dist aliases and do not need the bundled virtual modules.
	// 按 binary/bundle、TS 源码、普通 dist 三条路径选择模块解析策略。
	const resolutionOptions = usesEmbeddedModules
		? // 嵌入环境用宿主虚拟模块，并禁 jiti 优先原生加载，保证包能解析到嵌入实现。
			{ virtualModules: await getVirtualModules(), tryNative: false }
		: // 非嵌入但本文件仍为 .ts 时走源码模式。
			isTypeScriptSourceRuntime
			? // 源码复用虚拟模块并开启 tsconfig paths，避免宿主工作区包变成另一份实例。
				{ virtualModules: await getVirtualModules(), tsconfigPaths: true }
			: // 普通 Node 构建产物只用 dist 别名，不加载整份虚拟模块。
				{ alias: getAliases() };
	// 为本次模块导入新建 jiti，父解析基址是当前加载器 URL。
	const jiti = createJitiImpl(import.meta.url, {
		// 关闭 jiti 的模块运行期缓存，允许非工厂缓存路径重新读/执行模块；不等于禁用了全部磁盘转译缓存。
		moduleCache: false,
		// 展开上面模式专属解析选项。
		...resolutionOptions,
	});

	// 真实导入并执行扩展模块顶层代码；default:true 按 jiti 契约取 default 或模块自身，不保证一定有工厂。
	const module = await jiti.import(extensionPath, { default: true });
	// 先作 TS 工厂断言，下一条件才实际检查运行时函数形状。
	const factory = module as ExtensionFactory;
	// 模块导出外部边界检查：非函数不能调用初始化。
	if (typeof factory !== "function") {
		// 用 undefined 告诉上游缺少合法工厂，而不是这里自己生成错误文字。
		return undefined;
	}
	// 等待导入期间 cache 可能被清理/切目录，写回前重新检查。
	if (isCurrentCacheToken(cacheToken)) {
		// 仅当前 token 有效时保存工厂，缓存不包含 Extension 对象。
		extensionCache.set(extensionPath, factory);
	}
	// 返回验证过是函数的工厂引用，尚未执行工厂体。
	return factory;
}

/**
 * Create an Extension object with empty collections.
 */
// 创建空扩展记录。输入展示地址与解析地址，返回各类空 Map，无文件/模型副作用。
// 合成入口没有真实 baseDir，例如 <inline:x> 来源可保留诊断名；文件入口从 resolvedPath 取父目录。
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	// 合成路径可带 builtin/inline 来源，普通文件默认 local。
	const source = getSyntheticPathSource(extensionPath) ?? "local";
	// 只有真实文件地址才给 baseDir，避免把尖括号诊断名当目录。
	const baseDir = isSyntheticPath(extensionPath) ? undefined : path.dirname(resolvedPath);

	// 返回注册容器，后续 factory(api) 会往这里填声明。
	return {
		// path 保留调用者展示/来源标识。
		path: extensionPath,
		// resolvedPath 用于真实定位或合成入口身份。
		resolvedPath,
		// 创建标准来源信息，不读取源码内容。
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		// 事件名到处理器数组，允许同事件多次注册。
		handlers: new Map(),
		// 工具名到定义/来源条目。
		tools: new Map(),
		// custom_message 类型的渲染器 Map。
		messageRenderers: new Map(),
		// 不进上下文的 custom entry 渲染器 Map。
		entryRenderers: new Map(),
		// 命令名到 handler/描述等定义。
		commands: new Map(),
		// 参数名到 boolean/string 声明。
		flags: new Map(),
		// 快捷键到回调声明，不在此监听键盘。
		shortcuts: new Map(),
	};
}

// 初始化一个工厂。输入工厂、展示/解析地址、cwd、总线和共享 runtime，返回已登记 Extension Promise。
// 先造空表与隔离 API→await factory→commit；失败 discard 后原错抛出。例如同步/异步工厂都可用，但工厂任意文件/网络副作用不由这里自动回滚。
async function initializeExtension(
	// 已经确认可调用的初始化函数。
	factory: ExtensionFactory,
	// 用户可读的原地址或合成来源名。
	extensionPath: string,
	// 用于真实定位的解析地址，内联时可仍为合成名。
	resolvedPath: string,
	// 扩展默认 exec 的工作目录。
	cwd: string,
	// 供本工厂与其他扩展通信的同一总线。
	eventBus: EventBus,
	// 本批共享状态/动作，生命周期由宿主维护。
	runtime: ExtensionRuntime,
	// 异步成功给完整注册容器，失败拒绝 Promise。
): Promise<Extension> {
	// 准备本扩展所有空注册集合。
	const extension = createExtension(extensionPath, resolvedPath);
	// 建立尚处 loading 阶段的 API 及提交/丢弃控制器。
	const load = createExtensionAPI(extension, runtime, cwd, eventBus);
	// 工厂和提交任一失败都进入同一清理出口。
	try {
		// 真正执行用户扩展初始化；await 同时兼容同步 void 与 Promise<void>。
		await factory(load.api);
		// 工厂正常完成后提交待默认值/共享注册，仍可能抛出提交异常。
		load.commit();
		// 捕获原工厂或提交过程异常。
	} catch (error) {
		// 标失败、清加载期总线监听与暂存项，不撤销任意已发生副作用。
		load.discard();
		// 原异常继续向上，文件加载入口会转错误文字，内联入口则直接拒绝。
		throw error;
	}
	// 仅成功路径记录 factory 阶段时间。
	time(`${extensionPath} factory`, "extensions");
	// 把初始化完成的注册容器交上游加入 extensions。
	return extension;
}

// 加载单个文件扩展。输入地址/cwd/共享依赖和可选 token，返回 {extension,error} Promise。
// 路径规范后在 try 中导入/校验/初始化；模块或工厂错误转字符串，不阻断后面文件。例如错误导出得到 extension:null，路径解析自身在 try 外失败仍可拒绝。
async function loadExtension(
	// 调用者给定扩展地址，用于展示错误来源。
	extensionPath: string,
	// 相对地址的解析基准。
	cwd: string,
	// 同一批共享总线。
	eventBus: EventBus,
	// 同一批共享 runtime。
	runtime: ExtensionRuntime,
	// 可选工厂缓存身份；不是全局永久缓存许可。
	cacheToken?: ExtensionCacheToken,
	// 成功 extension 非空/error 为 null；失败则相反，类型未用判别联合静态强制互斥。
): Promise<{ extension: Extension | null; error: string | null }> {
	// 规范化 Unicode 空格等输入形式并绝对化；本函数不会在此确认文件可读。
	const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

	// 模块导入和工厂初始化错误在此汇总。
	try {
		// 等待导入得到工厂；缓存命中仍跳不过后面的初始化。
		const factory = await loadExtensionModule(resolvedPath, cacheToken);
		// 记录当前扩展模块导入阶段耗时。
		time(`${extensionPath} module import`, "extensions");
		// 没有可调用导出就产生明确错误结果。
		if (!factory) {
			// 返回无扩展和具体导出格式错误，而不执行非函数值。
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		// 真正初始化并提交扩展声明，等待完成。
		const extension = await initializeExtension(factory, extensionPath, resolvedPath, cwd, eventBus, runtime);

		// 成功时将 error 明确置 null，保留完整 extension。
		return { extension, error: null };
		// 文件导入或工厂初始化抛出时转为加载错误。
	} catch (err) {
		// 兼容 Error 与任意 JS 抛出值。
		const message = err instanceof Error ? err.message : String(err);
		// 失败结果保留原因，不把部分扩展记录当成功返回。
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
// 从内联函数加载扩展。输入工厂/cwd/共享总线/runtime/可选名字，返回 Extension Promise；不做文件模块导入。
// 例如测试注入 factory 时可用 <inline:test>；初始化异常直接向调用者传播，不像 loadExtension 转成 error 字段。
export async function loadExtensionFromFactory(
	// 函数引用来自宿主，仍要实际调用它完成注册。
	factory: ExtensionFactory,
	// 提供工厂默认执行目录。
	cwd: string,
	// 宿主传共享总线，不在此另建一份。
	eventBus: EventBus,
	// 宿主传共享 runtime，绑定时机仍由上游决定。
	runtime: ExtensionRuntime,
	// 默认合成展示名不是磁盘文件路径。
	extensionPath = "<inline>",
	// 成功返回注册记录，失败为拒绝 Promise。
): Promise<Extension> {
	// 先把目录规范成绝对地址。
	const resolvedCwd = resolvePath(cwd);
	// 内联没有独立文件解析地址，两个身份都用 extensionPath，再走相同初始化/清理流程。
	return initializeExtension(factory, extensionPath, extensionPath, resolvedCwd, eventBus, runtime);
}

/**
 * Load extensions from paths.
 */
// 按顺序加载文件列表的公共实现。输入地址列表/cwd/可选共享依赖/缓存开关，返回加载结果。
// 逐个 await，失败记 errors 并继续；成功工厂共享 runtime/总线，顺序决定同名优先规则。warnings 当前仅创建空列表，没有在此生成警告。
async function loadExtensionsInternal(
	// 输入列表顺序就是加载/初始化顺序，未在此排序或去重。
	paths: string[],
	// 有效工作目录，供相对扩展及 API exec 使用。
	cwd: string,
	// 缺省时为本批新建事件总线。
	eventBus?: EventBus,
	// 缺省时为本批新建未绑定 runtime。
	runtime?: ExtensionRuntime,
	// 默认关闭工厂缓存，调用 loadExtensionsCached 才明确开启。
	useCache = false,
	// 返回 extensions/errors/warnings/runtime 的聚合对象。
): Promise<LoadExtensionsResult> {
	// 只加入真正成功初始化的扩展。
	const extensions: Extension[] = [];
	// 保存每个失败来源及文字，不直接打印。
	const errors: Array<{ path: string; error: string }> = [];
	// 当前实现不追加 warning；保留返回字段供上游合并。
	const warnings: Array<{ path: string; warning: string }> = [];
	// 缓存路径才绑定 cwd/token，普通加载不读写工厂缓存。
	const cacheToken = useCache ? useExtensionCacheCwd(cwd) : undefined;
	// 有 token 可复用其规范 cwd，否则自己解析。
	const resolvedCwd = cacheToken?.cwd ?? resolvePath(cwd);
	// 共享总线优先复用调用方，未传则新建。
	const resolvedEventBus = eventBus ?? createEventBus();
	// 共享 runtime 优先复用调用方；新建实例仍只有未初始化动作桩。
	const resolvedRuntime = runtime ?? createExtensionRuntime();

	// 串行遍历，不用 Promise.all 并发工厂，保留注册因果顺序。
	for (const extPath of paths) {
		// 等待当前文件完成，再处理下一个。
		const { extension, error } = await loadExtension(
			// 原扩展地址用于定位和错误归属。
			extPath,
			// 传规范工作目录。
			resolvedCwd,
			// 传本批共享事件总线。
			resolvedEventBus,
			// 传本批共享运行时。
			resolvedRuntime,
			// 可选缓存 token 同批共用，清理/切目录后会失效。
			cacheToken,
		);

		// 返回 error 字串表示本扩展失败。
		if (error) {
			// 把原路径和失败说明加入聚合列表。
			errors.push({ path: extPath, error });
			// 当前失败不阻断后续文件。
			continue;
		}

		// 无错误且确实有 Extension 才收集。
		if (extension) {
			// 保留成功扩展加载顺序。
			extensions.push(extension);
		}
	}

	// 完成全部尝试后返回结构化结果，仍不代表 runner 已绑定。
	return {
		// 成功扩展注册列表。
		extensions,
		// 失败文件列表。
		errors,
		// 此层目前为空的警告列表。
		warnings,
		// 显式把本批实际使用的 runtime 返回，供服务/runner 后续绑定。
		runtime: resolvedRuntime,
	};
}

// 不使用工厂缓存加载文件扩展。输入列表/cwd/可选总线/runtime，返回聚合 Promise。
// 例如 /reload 可先清缓存再调用此入口重新导入；单文件失败记 errors，初始化副作用按内部规则处理。
export async function loadExtensions(
	// 文件或已解析入口路径列表。
	paths: string[],
	// 项目工作目录。
	cwd: string,
	// 可选共用总线。
	eventBus?: EventBus,
	// 可选共用 runtime。
	runtime?: ExtensionRuntime,
	// 结果含成功项与失败项，调用者自行决定是否中止启动。
): Promise<LoadExtensionsResult> {
	// 使用内部默认 useCache=false，不额外改变全局工厂缓存代次。
	return loadExtensionsInternal(paths, cwd, eventBus, runtime);
}

// 带目录/代次工厂缓存加载。输入与 loadExtensions 相同，返回聚合 Promise。
// 同 cwd 重用导入工厂可省重复模块执行，但每次仍重新 factory(api) 创建本批 Extension 与注册状态。
export async function loadExtensionsCached(
	// 地址列表仍按输入顺序加载。
	paths: string[],
	// cwd 变化会使全局工厂缓存失效。
	cwd: string,
	// 可选共享事件总线。
	eventBus?: EventBus,
	// 可选共享运行时，不缓存上次 Extension 对象。
	runtime?: ExtensionRuntime,
	// 异步结果与普通加载保持相同形状。
): Promise<LoadExtensionsResult> {
	// 最后 true 明确选择工厂缓存路径。
	return loadExtensionsInternal(paths, cwd, eventBus, runtime, true);
}

// 判断文件名是否扩展源码候选。输入名称，返回 boolean，无 I/O。
// 只接受小写 .ts/.js 后缀，foo.d.ts 也会匹配，.tsx/.mjs 不在这里接受；并不验证内容是合法扩展。
function isExtensionFile(name: string): boolean {
	// endsWith 是区分大小写的字串判断，不读取文件。
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pi.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
// 解析目录入口。输入目录，返回路径数组或 null，只读清单/存在性。
// 优先 pi.extensions 中存在的路径，再 index.ts/index.js；声明都不存在也可退 index。仅确认存在，不验证文件种类或工厂内容，例如 manifest 指向坏文件由导入阶段报错。
function resolveExtensionEntries(dir: string): string[] | null {
	// Check for package.json with "pi" field first
	// 目录包清单的固定位置。
	const packageJsonPath = path.join(dir, "package.json");
	// 清单不存在就跳过读取，直接考虑 index。
	if (fs.existsSync(packageJsonPath)) {
		// 读取 pi manifest，解析/形状错误返回 null 而非向这里抛。
		const manifest = readPiManifest(packageJsonPath);
		// 只有非空 extensions 列表才按显式入口处理。
		if (manifest?.extensions?.length) {
			// 收集清单里实际存在的入口地址。
			const entries: string[] = [];
			// 遍历清单声明顺序，不做目录递归展开。
			for (const extPath of manifest.extensions) {
				// 以当前扩展包目录解析相对入口。
				const resolvedExtPath = path.resolve(dir, extPath);
				// 不存在条目静默略过，没在此验证 .ts/.js 后缀。
				if (fs.existsSync(resolvedExtPath)) {
					// 把存在地址加入本次入口列表。
					entries.push(resolvedExtPath);
				}
			}
			// 至少有一个有效存在地址才使用清单结果。
			if (entries.length > 0) {
				// 返回整个清单有效入口列表，不再同时自动加载 index。
				return entries;
			}
		}
	}

	// Check for index.ts or index.js
	// 源码目录默认入口候选 index.ts。
	const indexTs = path.join(dir, "index.ts");
	// 构建 JS 默认入口候选 index.js。
	const indexJs = path.join(dir, "index.js");
	// 同时存在时 TypeScript 优先。
	if (fs.existsSync(indexTs)) {
		// 返回单项数组，保证上游可以统一展开。
		return [indexTs];
	}
	// 没有 index.ts 才检查 JS。
	if (fs.existsSync(indexJs)) {
		// 返回 JS 入口。
		return [indexJs];
	}

	// 没有清单有效入口也没有 index，就交上层按普通目录发现或跳过。
	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "pi" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
// 扫描一个目录层级的扩展候选。输入目录，返回路径数组；只做发现，不执行工厂。
// 直接 .ts/.js 文件或链接可入列，子目录只查 manifest/index，不任意递归；读取异常整次返回 []，例如目录无权限时不在此打印错误。
function discoverExtensionsInDir(dir: string): string[] {
	// 目录缺失是正常无发现结果。
	if (!fs.existsSync(dir)) {
		// 提前返回空数组，不调用 readdir。
		return [];
	}

	// 收集当前目录扫描得到的入口。
	const discovered: string[] = [];

	// 存在性到读取之间仍可出错，所以目录扫描在 try 内。
	try {
		// 带 withFileTypes 读取 Dirent，避免为普通文件逐项 stat。
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		// 按文件系统给的顺序遍历，没有额外排序。
		for (const entry of entries) {
			// 把当前目录和条目名拼成候选地址。
			const entryPath = path.join(dir, entry.name);

			// 1. Direct files: *.ts or *.js
			// 直接文件或符号链接且名字后缀匹配就入列；链接目标是否可导入留给加载阶段。
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				// 先保存这条候选，不读源码内容。
				discovered.push(entryPath);
				// 这项已按直接文件处理，不再查其 manifest/index。
				continue;
			}

			// 2 & 3. Subdirectories
			// 目录或剩余符号链接可以按扩展包目录探测。
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				// 解析该子目录的清单/index；这里的 entries 是新块级变量，遮蔽外层目录条目数组。
				const entries = resolveExtensionEntries(entryPath);
				// 非 null 时才展开入口。
				if (entries) {
					// push(...entries) 把各路径逐个加入，不把数组当单个元素。
					discovered.push(...entries);
				}
			}
		}
		// 任何扫描异常走这个失败路径。
	} catch {
		// 整个扫描返回空列表，即使前面已发现部分项也不返回部分结果。
		return [];
	}

	// 扫描成功返回全部候选；没有发现也正常为空。
	return discovered;
}

/**
 * Discover and load extensions from standard locations.
 */
// 从标准目录和显式路径发现并加载。输入配置路径/cwd/可选 agentDir/总线，返回聚合结果。
// 按项目→全局→显式顺序探测并按绝对字串去重，然后普通加载；不是此函数本身执行项目信任决策。显式非目录/不存在路径也入加载列表，后面提供具体导入错误。
export async function discoverAndLoadExtensions(
	// 调用者显式配置的文件或目录来源。
	configuredPaths: string[],
	// 项目相对路径的基准。
	cwd: string,
	// 用户配置根缺省从 config.getAgentDir 取，不是项目目录。
	agentDir: string = getAgentDir(),
	// 可选外部共享总线。
	eventBus?: EventBus,
	// 返回成功扩展、错误列表与新建或共享运行时。
): Promise<LoadExtensionsResult> {
	// 规范项目 cwd 为绝对路径。
	const resolvedCwd = resolvePath(cwd);
	// 同样规范用户配置目录。
	const resolvedAgentDir = resolvePath(agentDir);
	// 按发现先后保存待加载路径。
	const allPaths: string[] = [];
	// 用于重复地址筛除的 Set，不追踪文件 inode 或符号链接目标。
	const seen = new Set<string>();

	// addPaths 回调接一组地址，返回 void；将未见过项依序收集。
	// 例如项目与显式都指定同一绝对文件，仅先发现项保留；去重用 path.resolve 字串，不承诺链接/大小写全等价。
	const addPaths = (paths: string[]) => {
		// 逐个处理本批候选。
		for (const p of paths) {
			// 生成绝对比较字串，未按 realpath 追链接。
			const resolved = path.resolve(p);
			// 只收集第一次出现的绝对字串。
			if (!seen.has(resolved)) {
				// 先标记已见，防止后续重复。
				seen.add(resolved);
				// 加载列表保留输入 p 的地址形式，不用比较键替换展示路径。
				allPaths.push(p);
			}
		}
	};

	// 1. Project-local extensions: cwd/${CONFIG_DIR_NAME}/extensions/
	// 项目固定目录是 cwd/配置目录名/extensions。
	const localExtDir = path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions");
	// 扫描项目入口并先加入列表，影响同名扩展优先级。
	addPaths(discoverExtensionsInDir(localExtDir));

	// 2. Global extensions: agentDir/extensions/
	// 全局目录位于 agentDir/extensions。
	const globalExtDir = path.join(resolvedAgentDir, "extensions");
	// 全局入口随后加入，相同绝对字串不会重复。
	addPaths(discoverExtensionsInDir(globalExtDir));

	// 3. Explicitly configured paths
	// 最后处理用户显式指定路径，列表顺序仍保留。
	for (const p of configuredPaths) {
		// 按项目 cwd 解析，兼容 Unicode 空格规范输入。
		const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
		// 存在且 stat 为目录时先尝试目录入口；stat I/O 异常在此未捕获，会向外拒绝。
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// Check for package.json with pi manifest or index.ts
			// 优先检查目录的 manifest 或 index。
			const entries = resolveExtensionEntries(resolved);
			// 有明确入口就不把目录内所有脚本一并加载。
			if (entries) {
				// 把确定入口按序去重加入。
				addPaths(entries);
				// 这个显式目录已经处理完，进入下个配置值。
				continue;
			}
			// No explicit entries - discover individual files in directory
			// 无显式入口才做一层目录发现，不任意递归更深结构。
			addPaths(discoverExtensionsInDir(resolved));
			// 目录扫描结束，不再把目录自身交 jiti 导入。
			continue;
		}

		// 非目录（包括不存在地址）原样作为单项候选，后面产生可见加载错误。
		addPaths([resolved]);
	}

	// 统一交不缓存工厂的加载入口，工厂实际执行发生在其内部初始化阶段。
	return loadExtensions(allPaths, resolvedCwd, eventBus);
}
