/**
 * Built-in MCP integration.
 *
 * Connects the servers from `mcp.json` and the servers extensions register with
 * `pi.registerMcpServer()` when a session starts, and servers registered later right away. A server
 * in `mcp.json` takes precedence over a registered server of the same name. Connections run in the
 * background: the first prompt waits only for servers with `direct` tools, and codemode scripts,
 * `tool_search`, and the resource tools wait for the servers they need when they run. Tools are
 * registered as `mcp__<server>__<tool>`. By default (`"exposure": "codemode"`) the tools are only
 * callable from codemode scripts, which keeps MCP tools out of the model's tool declarations and
 * the codemode description: scripts find the tools with `searchTools()` and the server instructions
 * with `describeNamespace()`. The codemode tool is activated for that unless `autoEnableCodemode` is
 * false. `"deferred"` declares the tools to the model once the `tool_search` tool loads them, and
 * activates `tool_search` instead of codemode.
 * `"exposure": "direct"` declares them to the model right away, and `"hidden"` makes them
 * unreachable. `toolExposure` overrides the exposure of single tools. Servers with resources are
 * reached through Codex's `list_mcp_resources`, `list_mcp_resource_templates`, and
 * `read_mcp_resource` tools (resources.ts).
 *
 * Every call runs through pi's tool pipeline, so `tool_call`/`tool_result` hooks and permission
 * extensions apply to MCP tools the same way they do to built-in tools.
 *
 * Problems found at startup (config errors, failed connections, servers that need a sign-in) are
 * reported once. `/mcp` opens a manager to sign in, reconnect, enable or disable servers, and change
 * their exposure; the last two are saved to the `mcp.json` that defines the server, or apply to the
 * current session for registered servers.
 */

// MCP 扩展的编排入口：会话启动读配置并后台连接，握手后登记工具，调用前等待相关服务器；/mcp 负责管理。实际协议在 runtime.ts，内容转换在 tools.ts/resources.ts，终端组件在 ui.ts。
// 例：配置 docs 为 codemode → 后台握手 → 登记 mcp__docs__search → 脚本调用前 tool_call 等待 ready → runtime 发请求。声明隐藏/延迟方式与是否已连接是两回事。
// join/resolve 拼本地配置和日志路径，不负责读取文件。
import { join, resolve } from "node:path";
// SelectItem 描述UI候选项，import type 编译后擦除。
import type { SelectItem } from "@earendil-works/pi-tui";
// import type 只借用候选项和 schema 的编译期类型，运行时不会据此验证数据。
import type { TSchema } from "typebox";
// 统一 helper 解析 agent 目录，避免猜测源码/安装后的资产位置。
import { getAgentDir } from "../../config.ts";
// 扩展 API、命令/普通上下文、工厂和工具定义都是编译期约定；具体运行行为由宿主提供。
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ToolDefinition,
} from "../../core/extensions/types.ts";
// mcpNamespace 将服务器名规范成工具命名空间，例如 my-server 与 my_server 会得到同一形式。
import { mcpNamespace } from "../../core/mcp-servers.ts";
// ModelRegistry 提供 pi 模型供应商的认证入口；这里只以类型引用，连接实际请求时才取凭证。
import type { ModelRegistry } from "../../core/model-registry.ts";
// 默认浏览器打开器有系统进程副作用，只有显式登录触发 openUrl 才调用。
import { openBrowser } from "../../utils/open-browser.ts";
// 复用可发现其他工具的两个工具名，用来激活脚本/搜索入口。
import { CODEMODE_TOOL_NAME } from "../codemode/tool.ts";
import { TOOL_SEARCH_TOOL_NAME } from "../tool-search/tool.ts";
// 配置层负责加载、验证、来源与文件更新；type 项不会执行这些函数。
import {
	getMcpToolExposure,
	type LoadedMcpConfig,
	loadMcpConfig,
	type McpExposure,
	type McpServerConfigPatch,
	type McpServerEntry,
	updateMcpServerConfig,
} from "./config.ts";
// OAuth 凭证/提示接口只作类型；实际登录实现经 lazy runtime 加载。
import type { McpOAuthCredentialStore, McpSignInPrompt } from "./oauth.ts";
// 三个资源公共工具及名字，执行时再按当前服务器集合路由。
import {
	createMcpResourceToolDefinitions,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	LIST_MCP_RESOURCES_TOOL,
	READ_MCP_RESOURCE_TOOL,
} from "./resources.ts";
// lazy 函数运行时才 import 连接/OAuth 实现；下面 type * as 是整模块的类型命名空间，不另触发运行时加载。
import { loadMcpRuntime } from "./runtime.lazy.ts";
import type * as McpRuntime from "./runtime.ts";
// 连接、日志、工厂类型用于依赖注入；没有在这些类型导入处启动远程服务。
import type { McpServerConnection, McpServerLog, McpTransportFactory } from "./runtime.ts";
// 工具层提供命名、执行适配和渲染器；UI 层负责真正的终端交互。
import { createMcpToolDefinition, createMcpToolName, createMcpToolRenderers, type McpToolDetails } from "./tools.ts";
import { type McpMenu, type McpUi, showMcpManager } from "./ui.ts";

// 只重新导出工厂类型，供外部注入测试或其他传输，不产生 JS 值。
export type { McpTransportFactory } from "./runtime.ts";

// 创建扩展时可注入依赖的选项；? 表示字段可省略，默认策略在工厂内部选，不由 interface 自动填值。
export interface McpExtensionOptions {
	/** Defaults to reading `mcp.json` from the agent directory and the trusted project. */
	// 自定义加载器接会话上下文，返回已解析配置；替换默认实现也意味着调用者负责其信任/校验策略。
	loadConfig?: (ctx: ExtensionContext) => LoadedMcpConfig;
	/** Defaults to stdio and streamable HTTP transports built from the server config. */
	// 注入传输工厂，可用内存连接测试；默认实现可能启动本地命令或发 HTTP。
	createTransport?: McpTransportFactory;
	/** Defaults to `mcp-auth.json` in the agent directory. */
	// 可注入凭证存储，缺省首次用到 runtime 时才创建文件后端对象。
	credentials?: McpOAuthCredentialStore;
	/** File server log messages are appended to. Defaults to `mcp.log` in the agent directory. */
	// 日志目的地可覆盖；真正创建目录/追加发生在日志收到通知时。
	logPath?: string;
	/** Opens the OAuth authorization URL. Defaults to the platform browser. */
	// 同步通知回调，void 不保证浏览器启动成功，也不表示会等待异步回调的完成。
	openUrl?: (url: string) => void;
	/**
	 * Saves `/mcp` changes to the server's config file: its project `override` when set, else its
	 * `source`. Defaults to editing that `mcp.json`.
	 */
	// 配置更新回调接 entry 和浅补丁；扩展登记的服务器在 saveConfig 中跳过落盘，只改变当前对象。
	updateConfig?: (entry: McpServerEntry, patch: McpServerConfigPatch) => void;
	/**
	 * How long the first prompt waits for servers with `direct` tools that are still connecting at
	 * startup, in milliseconds. Their tools become available when they connect. Other servers are
	 * waited for when a script or search needs them. Default: 10000.
	 */
	// 首次请求等待 direct 服务器的毫秒预算，不是网络请求超时；本文件不再对注入数字做范围校验。
	startupWaitMs?: number;
}

// 数字分隔符 10_000 就是10000；只管第一次 before_agent_start 的等待。
const DEFAULT_STARTUP_WAIT_MS = 10_000;

// ReadonlySet 在 TS 层禁用增删方法，不会冻结运行时 Set；这里只保存三个公共资源工具名供调用前识别。
const RESOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
	// 资源列表调用需要等待现有服务器连接准备。
	LIST_MCP_RESOURCES_TOOL,
	// URI 模板列表使用同样等待规则。
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	// 资源读取即使指定 server 也按公共资源工具分支等待所有 readyServers。
	READ_MCP_RESOURCE_TOOL,
]);

/** A configured server. Disabled servers have no connection. */
// 单台服务器的会话内状态，配置条目与网络连接分开；disabled 可保留配置但没有连接。
interface McpServer {
	// 来源、名称和当前配置统一保存在 entry。
	entry: McpServerEntry;
	// 连接可能还没创建、已禁用或移除，不要仅看可选字段判断在线。
	connection?: McpServerConnection;
	/** For servers extensions registered: the config as registered, to detect re-registrations. */
	// 登记时 JSON 快照用于比较替换；序列化顺序不同也可能被认为配置变化。
	registeredConfig?: string;
	/** Result of the last `/mcp` action that failed, shown in the manager. */
	// 菜单操作结果文字，和 connection.error 的协议/连接错误分开。
	message?: string;
	/** Identifies the current connection attempt; disabling or replacing it invalidates earlier work. */
	// 每次 startConnection 用新 Symbol 标识；身份不同就淘汰旧建连的迟到结果/回调，不是取消所有底层工作。
	attempt?: symbol;
	/** Settles when the connection started for the server connected or failed. */
	// 最近一次启动/重连准备的 Promise，通常已把拒绝转为完成；落定不保证连上，要再看 connection.state。
	ready?: Promise<void>;
	/** Cleanup of a detached connection; a replacement waits for it before opening a transport. */
	// 禁用时关闭旧连接/等待旧 ready 的任务；重新启用先等待它，避免传输交叠。
	closing?: Promise<void>;
}

// Record 要求三种非 hidden 暴露值都有文案；Exclude 从联合中去掉 hidden，不做运行时筛选。
const EXPOSURE_DESCRIPTIONS: Record<Exclude<McpExposure, "hidden">, string> = {
	// codemode：不直接向模型声明，经脚本发现/调用。
	codemode: "called from codemode scripts, which find them with searchTools()",
	// deferred：工具搜索选中后再加载到模型声明。
	deferred: "not declared until tool_search loads them, then called directly; no codemode needed",
	// direct：登记后按宿主默认激活规则直接声明。
	direct: "declared to the model like built-in tools",
};

// 把异常转显示文字，无文件/网络副作用。例 Error("断开") 得“断开”；其他抛出值用 String，自定义字符串转换仍可能抛错。
function errorMessage(error: unknown): string {
	// unknown 先用 instanceof 收窄才能取 message；不保留堆栈、不自动脱敏。
	return error instanceof Error ? error.message : String(error);
}

// 取第一段 LF 前文字，无副作用；例 "a\nb" 得 "a"，独立 CR 不被此处分割。
function firstLine(text: string): string {
	// split 的第二参数1限制结果段数，取首项后以 ?? 回退空串。
	return text.split("\n", 1)[0] ?? "";
}

// 检查配置是否启用，Pick 只要求传入带 entry 的结构；例缺 enabled 默认启用，不访问网络。
function isEnabled(server: Pick<McpServer, "entry">): boolean {
	// 只有严格 false 禁用，不是把所有 falsy 值都当禁用。
	return server.entry.config.enabled !== false;
}

// 取服务器默认暴露方式，例未配 exposure 得 codemode；只读当前配置，不修改工具注册。
function exposureOf(entry: McpServerEntry): McpExposure {
	// ?? 只在 null/undefined 回退；正常配置已由加载边界验证。
	return entry.config.exposure ?? "codemode";
}

/** Exposures the server's tools can have, known from its config before it connects. */
// 收集服务器默认与每工具覆盖中出现的暴露值，返回新 Set；例默认 codemode+某项 direct 两者都保留，不证明服务器真的提供那项工具。
function configuredExposures(entry: McpServerEntry): Set<McpExposure> {
	// Object.values 取覆盖值，展开进数组再 Set 去重；缺覆盖表用空对象。
	return new Set([exposureOf(entry), ...Object.values(entry.config.toolExposure ?? {})]);
}

/** Whether some of the server's tools are declared to the model, so the first prompt waits for them. */
// 按配置判断是否“可能有 direct”，供首次等待；例覆盖某个不存在的工具为 direct 也会返回 true，不查握手列表。
function hasDirectTools(entry: McpServerEntry): boolean {
	// Set.has 精确匹配 direct 字面量。
	return configuredExposures(entry).has("direct");
}

/** Whether some of the server's tools are reached through codemode or tool_search. */
// 按配置判断是否含脚本或延迟方式，返回布尔、无副作用；例 hidden 默认但某项 deferred 仍入服务器摘要。
function hasIndirectTools(entry: McpServerEntry): boolean {
	// 先得到配置可能出现的全部方式。
	const exposures = configuredExposures(entry);
	// 任一种间接方式存在就 true，不检查对应入口是否已激活。
	return exposures.has("codemode") || exposures.has("deferred");
}

/** Name of the system prompt section that lists the servers whose tools are not declared. */
// systemPromptOptions.sections 中使用的字段名；这里不是立刻发给模型的正文。
export const MCP_SERVERS_SECTION = "mcp_servers";
/** Characters of a server description in the section, as Codex allows for deferred namespaces. */
// 每台说明最多250个 UTF-16 代码单元，不是token或终端列数。
const MAX_SERVER_DESCRIPTION_CHARS = 250;
/**
 * Characters of the whole section. Descriptions shrink to fit; when the server lines alone do not
 * fit, the last servers are left out and counted in a closing line.
 */
// 服务器段落总预算4096个 UTF-16 代码单元，算法缩说明/尾部条目；不调用模型总结。
export const MAX_SERVERS_SECTION_CHARS = 4096;

/** The section's first line. It explains only the ways of reaching tools that the listed servers use. */
// 按可达入口集合拼说明首行并返回字符串，无外部副作用。例集合仅 codemode 就只附脚本用法；ReadonlySet 不在此被修改。
function serversSectionIntro(reaches: ReadonlySet<string>): string {
	// let 允许逐步追加文案，基础句始终存在。
	let intro = "MCP servers whose tools are not declared to you.";
	// 出现 codemode 才附对应用法，+= 更新局部字符串。
	if (reaches.has("codemode")) intro += " Call the tools of `codemode` servers from codemode scripts.";
	// tool_search 独立判断，两类都出现就都附。
	if (reaches.has("tool_search")) intro += " Load the tools of `tool_search` servers with `tool_search`.";
	// 返回拼好的首行，不读取远端服务器。
	return intro;
}

// 按 JS 字符串长度截说明并添省略号，无副作用；例 truncate("abcd",3) 得 "ab…"。可能切开代理对，不是按Unicode码点裁剪。
function truncate(text: string, max: number): string {
	// 未超上限原样返回；max=1但正文已足够短也走本分支。
	if (text.length <= max) return text;
	// 超限且预算<=1返回空串，否则留一位省略号，trimEnd 可让结果更短。
	return max <= 1 ? "" : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** What the `mcp_servers` section needs of a server. */
// 渲染段落只需配置和可选服务器说明，不要求整个网络连接实例。
export interface McpServerListing {
	// 配置条目提供名称/暴露方式/本地说明。
	entry: McpServerEntry;
	// 嵌套 ? 允许没有连接，或有连接但没有 instructions；结构类型允许真实连接传入。
	connection?: { instructions?: string };
}

/** First line of the configured description, or of the server instructions once connected. */
// 取配置说明优先、否则服务器 instructions 的第一行，返回trim文字；例空白 description 会回退 instructions，不写回配置。
function serverSummary(server: McpServerListing): string {
	// ?.trim()+|| 把空白配置视为无说明；仅当它为空才选服务器说明。
	const text = server.entry.config.description?.trim() || server.connection?.instructions || "";
	// 取第一行后再次 trim，返回可为空字符串。
	return (text.split("\n", 1)[0] ?? "").trim();
}

/**
 * The `mcp_servers` section: every enabled server with codemode or deferred tools, with how its
 * tools are reached and a one-line summary. The model learns of the servers from it, since neither
 * codemode nor tool_search lists them. Undefined when there are no such servers.
 */
// 生成可达服务器段落：筛启用/间接方式→排序→估算基础行→均分说明预算→拼接；只产文字，不连服务器。例 direct-only 列表返回 undefined；两类间接并存时单台优先标 codemode。
export function renderServersSection(servers: readonly McpServerListing[]): string | undefined {
	// 从传入 readonly 数组开始链式处理；readonly 只是 TS 不允许就地改它。
	const listed = servers
		// filter 创建新数组，所以后面的排序不改变调用方原数组。
		.filter((server) => isEnabled(server) && hasIndirectTools(server.entry))
		// 按名称 localeCompare 排，不保证固定 ASCII 顺序。
		.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
	// 没有候选就不产生段落，由调用方删除旧 sections 字段。
	if (listed.length === 0) return undefined;
	// 为每台推断说明中显示的一种入口。
	const reaches = listed.map((server) =>
		// 只要配置可能含 codemode 就优先它，否则用 tool_search，不检查入口当时是否可用。
		configuredExposures(server.entry).has("codemode") ? "codemode" : "tool_search",
	);
	// 合并整段会用到的入口集合，生成首行。
	const intro = serversSectionIntro(new Set(reaches));
	// 基础行只含规范化命名空间和入口，index 对应排序后的 reaches。
	const heads = listed.map((server, index) => `- ${mcpNamespace(server.entry.name)} (${reaches[index]})`);
	// 省略提示闭包，输入省略数、返回0或1行数组；例2台省略时附统计，不表示已禁用它们。
	const omitted = (count: number) =>
		// 大于0才加提示；这里固定提示 searchTools，即使剩余服务器只走 tool_search 也不改文案。
		count > 0 ? [`- … ${count} more server${count === 1 ? "" : "s"}; find their tools with searchTools()`] : [];
	// Characters of the intro, the first `kept` server lines without descriptions, and the omission line.
	// 计算 kept 台不含说明时的总长度，含首行/换行/省略行；用于循环预算，无输出副作用。
	const size = (kept: number) => [intro, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;
	// 先尝试保留所有候选。
	let kept = listed.length;
	// 基础行超预算就从排序末尾逐台减少，直到容得下或一台都不留。
	while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept--;
	// Each description also takes a ": " separator.
	// 计算每台说明可分得的预算，考虑“冒号+空格”2位。
	const perServer =
		// 一台都不保留时避免除零。
		kept === 0
			? // 此分支说明预算为0。
				0
			: // 否则均分剩余，取整后扣分隔符，并限制单台上限；可能<=0，后面直接不附说明。
				Math.min(MAX_SERVER_DESCRIPTION_CHARS, Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2);
	// 只为保留台数构造最终行，map 的 index 与 heads 对齐。
	const lines = listed.slice(0, kept).map((server, index) => {
		// 有正预算才取/截说明，不够则用空串。
		const summary = perServer > 0 ? truncate(serverSummary(server), perServer) : "";
		// 有非空摘要才附冒号，不为无说明条目浪费分隔符。
		return summary ? `${heads[index]}: ${summary}` : heads[index];
	});
	// LF 合并首行、条目、省略提示，返回最终文字。
	return [intro, ...lines, ...omitted(listed.length - kept)].join("\n");
}

/**
 * Whether a call that reaches `reach` (see `ToolDefinition.reachesTools`) needs the server: it
 * reaches every tool, or one of its words contains the server's namespace.
 */
// 粗略判断一次嵌套调用可能用到哪台服务器；例 "mcp__docs__search" 包含 mcp__docs 即命中。只控制等待，不是授权、精确静态分析或实际执行审计。
function reachesServer(reach: "all" | readonly string[], server: string): boolean {
	// 字面量 all 代表可能触及所有台，立即 true。
	if (reach === "all") return true;
	// 把配置名变成工具使用的规范化 namespace。
	const namespace = mcpNamespace(server);
	// 字符串 includes 可过度匹配，例如 mcp__docs_extra 也包含 mcp__docs；some 命中一词即停止。
	return reach.some((word) => word.includes(namespace));
}

/** Short state for lists and the startup report. `withError` appends the first line of a failure. */
// 把服务器状态转简短文字，无副作用；例 failed+withError=false 只给failed，菜单可单独显示完整error。
function describeState(server: McpServer, withError = true): string {
	// 配置禁用优先于残留连接状态。
	if (!isEnabled(server)) return "disabled";
	// 取当前连接引用，没连接不等于失败。
	const connection = server.connection;
	// 未创建连接显示 starting。
	if (!connection) return "starting";
	// switch 按连接保存的状态分类，不主动探测服务器。
	switch (connection.state) {
		// 需用户认证的状态使用友好文字。
		case "needs-auth":
			// 返回登录提示标签，不执行登录。
			return "needs sign-in";
		// 首次建连等失败的展示分支。
		case "failed":
			// 按 withError 决定附异常第一行；缺error默认unknown error。
			return withError ? `failed: ${firstLine(connection.error ?? "unknown error")}` : "failed";
		// 已连接时同时显示工具数和资源能力。
		case "connected": {
			// 解构只读已缓存发现信息，不列资源内容。
			const { tools, hasResources } = connection;
			// 模板表达式处理英文单复数与可选资源标签。
			return `connected · ${tools.length} tool${tools.length === 1 ? "" : "s"}${hasResources ? " · resources" : ""}`;
		}
		// 正在连接使用省略号文字。
		case "connecting":
			// 这是状态文字，不是等待Promise。
			return "connecting…";
		// 其余联合成员例如 disconnected/closed 原样显示。
		default:
			// 不额外映射其他状态。
			return connection.state;
	}
}

/** Servers that need the user first. */
// 返回菜单排序权重，数字越小越靠前，无副作用；例 needs-auth=0、禁用=5，不代表连接优先级。
function attentionRank(server: McpServer): number {
	// 禁用服务器固定排最后一组。
	if (!isEnabled(server)) return 5;
	// 连接尚无时进入 default；?. 避免读取不存在对象。
	switch (server.connection?.state) {
		// 需登录最先提醒。
		case "needs-auth":
			// 权重0。
			return 0;
		// 失败次之。
		case "failed":
			// 权重1。
			return 1;
		// 已断开排在未开始之前。
		case "disconnected":
			// 权重2。
			return 2;
		// 在线服务器靠后。
		case "connected":
			// 权重4。
			return 4;
		// connecting、无连接和其他状态共用中间权重。
		default:
			// 权重3，随后还按名称排序。
			return 3;
	}
}

// 生成传输配置的展示文字，输入entry返回字符串，不执行命令。例 command/args仅用空格连，丢失shell引号信息，不能当可安全复制执行的脚本。
function describeTransport(entry: McpServerEntry): string {
	// 只取配置引用。
	const { config } = entry;
	// in 收窄HTTP配置，直接显示URL。
	if ("url" in config) return config.url;
	// 本地命令加参数用空格拼接，不解析/展开波浪号或配置环境变量。
	return [config.command, ...(config.args ?? [])].join(" ");
}

// 子命令错误时的固定用法提示，保留真实命令文字。
const MCP_USAGE = "Usage: /mcp, /mcp login [server], /mcp logout [server], /mcp reconnect [server]";

// 创建可注入依赖的扩展工厂；调用本函数不连服务器，返回函数被宿主调用后注册监听/命令。例传内存传输做测试；执行阶段可能写配置/日志/凭证、起进程/HTTP或打开授权页。
export function createMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
	// 返回闭包捕获 options；宿主传 ExtensionAPI，下面状态属于这一工厂执行实例。
	return (pi: ExtensionAPI) => {
		// 当前会话服务器对象列表，可含禁用项。
		let servers: McpServer[] = [];
		/** Servers from `mcp.json`, which take precedence over registered servers of the same name. */
		// 文件配置独立保存，用于覆盖扩展登记的同命名空间服务。
		let configuredEntries: McpServerEntry[] = [];
		// 加载配置时发现的可展示错误，启动/菜单共同使用。
		let configErrors: string[] = [];
		/** The trusted project's `mcp.json`, where `/mcp` saves project overrides of global servers. */
		// 只有信任项目才可能得到可写项目覆盖位置；undefined 不开放该菜单项。
		let projectConfig: string | undefined;
		/** Registered servers that `mcp.json` overrides, shown in `/mcp`. */
		// 保存文件配置遮蔽扩展声明的说明文字，不把两者合并成同一连接。
		let overridden: string[] = [];
		// 是否允许自动启用 codemode，启动时按加载结果更新。
		let autoEnableCodemode = true;
		/** Whether the "codemode tools unreachable" warning was shown since the session started. */
		// 单会话只提醒一次入口不可达；每次session_start重置。
		let warnedUnreachable = false;
		// 启动批量连接的汇总Promise，普通状态命令可等它；不涵盖所有后续后台动作。
		let pending: Promise<unknown> | undefined;
		/** Whether a prompt already waited for the startup connections since the session started. */
		// 第一次prompt开始等待时就设true，即使超时或没有direct台也不重复等。
		let waitedForStartup = false;
		// 注入值优先，缺省10秒；不等于每个MCP请求的超时。
		const startupWaitMs = options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS;
		/** Working directory of the session, for stdio servers. */
		// 初始化为进程cwd，session_start再换成会话cwd。
		let sessionCwd = process.cwd();
		// 注入凭证可立即有引用，但构造扩展不会在此读token。
		let credentials = options.credentials;
		/** The session's model registry, which resolves `auth.provider` tokens. */
		// 会话模型注册表稍后提供，供auth.provider按请求取凭证。
		let modelRegistry: ModelRegistry | undefined;
		// 日志对象按首次创建连接需要延迟建立。
		let serverLog: McpServerLog | undefined;
		// 选择授权URL打开器，保存函数引用，此处不执行。
		const openUrl = options.openUrl ?? openBrowser;
		// 选择保存配置的方法，注入实现优先。
		const updateConfig =
			// ?? 缺省时才建立下面的默认回调。
			options.updateConfig ??
			// 默认回调接条目和补丁，由saveConfig决定哪些来源需要落盘。
			((entry, patch) =>
				// 已有project override优先写它，否则写原source；文件更新异常由调用位置处理。
				updateMcpServerConfig(entry.override ?? entry.source, entry.name, patch, {
					// 明确override时更新器采用“覆盖条目”写法，保留enabled:true等需要覆盖全局值的字段。
					override: entry.override !== undefined,
				}));

		/**
		 * Lifetime of the current session: aborted on session_shutdown, and before the first session_start
		 * (registrations before that are read on session_start). Work captures `session.signal` when it
		 * starts and drops late results once it aborted, for example a runtime load that resolves after
		 * shutdown. Work that outlives the command that started it also stops on the signal and is
		 * registered with `track`, so shutdown can wait for its cleanup.
		 */
		// 会话取消控制器用来让异步任务认出过期会话；不是自动取消任意Promise。
		let session = new AbortController();
		// 首次session_start前先设已取消，忽略加载期动态变更事件，启动时统一读取登记表。
		session.abort();
		/** Work registered with `track`: manager actions opening or closing connections, and sign-ins. */
		// 保存已吸收拒绝的后台任务Promise供shutdown等待，不是自动发现所有异步工作。
		const backgroundActions = new Set<Promise<void>>();
		// 跟踪一个已启动工作并返回原Promise，保留调用方成功值/拒绝；例菜单重连虽不阻塞菜单，关闭仍等清理。这里不启动/取消work。
		const track = <T>(work: Promise<T>): Promise<T> => {
			// 派生一份总会兑现为undefined的任务，只作关闭等待集合。
			const task = work.then(
				// 成功也丢掉返回值。
				() => undefined,
				// 失败同样吸收；原work仍保持失败给原调用方。
				() => undefined,
			);
			// 将等待任务按Promise身份放进Set，尚未完成时供关闭快照读取。
			backgroundActions.add(task);
			// 派生任务完成后删除集合项；void不等待清理链，Set.delete返回值不影响原work。
			void task.finally(() => backgroundActions.delete(task));
			// 泛型T保持原异步结果，不能把“track吞错”误解为调用者拿不到错误。
			return work;
		};
		// 变更订阅集合，每个监听器是无参同步函数。
		const listeners = new Set<() => void>();
		// 同步通知当前监听器，返回void；例服务器连接状态改变触发菜单重建。监听器若抛错就中断此轮，没有异常隔离。
		const emitChange = () => {
			// 遍历Set并调用，直接重入/增删行为依JS Set迭代规则。
			for (const listener of listeners) listener();
		};
		// 加入一个界面监听器，返回取消函数，无网络副作用；例menu完成时调用返回值退订。
		const subscribe = (listener: () => void) => {
			// 同一个函数引用重复add只保留一份。
			listeners.add(listener);
			// 返回闭包捕获listener，后续取消这一份订阅。
			return () => {
				// delete删除此函数引用，不影响其他监听器。
				listeners.delete(listener);
			};
		};

		// 取得现有连接对象的新数组，flatMap用[]略过无连接项；例shutdown据此取快照，不检查connection.state是否在线，也不连服务器。
		const connections = () => servers.flatMap((server) => (server.connection ? [server.connection] : []));
		// 按配置原名精确找首台，返回对象或undefined，无副作用；此处不按namespace模糊匹配。
		const findServer = (name: string) => servers.find((server) => server.entry.name === name);

		/** Servers extensions registered, except names `mcp.json` defines, which take precedence. */
		// 从宿主登记表生成会话服务器和遮蔽报告，不连接；文件配置按规范namespace优先。例文件my-server会遮蔽扩展my_server；JSON序列化异常可传播。
		const registeredServers = (): { servers: McpServer[]; overridden: string[] } => {
			// 累计未被文件配置遮蔽的登记服务器。
			const registered: McpServer[] = [];
			// 累计遮蔽来源说明供菜单显示。
			const overriddenNames: string[] = [];
			// 读取宿主登记快照，解构名称/配置/扩展来源；宿主list提供配置克隆。
			for (const { name, config, extensionPath } of pi.getMcpServers()) {
				// 比较namespace而非仅原名，所以横线/下划线冲突也被文件项覆盖。
				const configured = configuredEntries.find((entry) => mcpNamespace(entry.name) === mcpNamespace(name));
				// 找到文件配置时不再加入登记服务器。
				if (configured) {
					// 报告中保留两份原名及来源，便于定位冲突。
					overriddenNames.push(
						// 模板只拼说明，不访问扩展文件。
						`"${name}" registered by ${extensionPath} is overridden by "${configured.name}" in ${configured.source}`,
					);
					// 跳过本登记，继续下一条。
					continue;
				}
				// 未被遮蔽才创建会话包装对象。
				registered.push({
					// scope=extension告诉保存逻辑不向extensionPath写mcp.json；source在此是扩展来源。
					entry: { name, config, source: extensionPath, scope: "extension" },
					// 保存注册配置序列化快照，之后比较变化；当前菜单改动不更新这份“登记时”快照。
					registeredConfig: JSON.stringify(config),
				});
			}
			// 返回两组新数组，字段servers映射registered局部变量。
			return { servers: registered, overridden: overriddenNames };
		};

		// 取缓存/注入的凭证存储，必要时构造默认对象并返回；例首台OAuth连接创建接口，构造本身不读token。typeof McpRuntime描述传入模块导出值的形状。
		const getCredentials = (runtime: typeof McpRuntime): McpOAuthCredentialStore => {
			// ??=只在缺实例时new，默认目录由存储类处理。
			credentials ??= new runtime.McpOAuthCredentialStore();
			// 返回同一对象供多台按名称/URL分区访问。
			return credentials;
		};

		// 取扩展实例共享的日志对象，默认agent/mcp.log；这里只构造，不创建文件，写通知时才落盘。自定义logPath原样传入。
		const getServerLog = (runtime: typeof McpRuntime): McpServerLog => {
			// 日志路径首次决定后缓存，缺省用统一目录helper。
			serverLog ??= new runtime.McpServerLog(options.logPath ?? join(getAgentDir(), "mcp.log"));
			// 返回缓存实例，不重新读取文件大小。
			return serverLog;
		};

		/** pi tool name to the `<server>\0<tool>` it was assigned to, so names stay unique and stable. */
		// Map把公开工具名映射到原server+NUL+tool归属；用原名避免规范化后冲突，映射在当前扩展实例内保留。
		const toolOwners = new Map<string, string>();
		/** Tool names currently offered by each server. */
		// 每台当前已登记工具名集合，用于新发现结果与旧表做差集。
		const serverTools = new Map<string, Set<string>>();
		/** Last definition registered under each tool name, to re-register withdrawn tools as hidden. */
		// 缓存最近定义供隐藏时重登记；TSchema/McpToolDetails是编译期参数，不在Map赋值时验证工具。
		const definitions = new Map<string, ToolDefinition<TSchema, McpToolDetails>>();

		// A resumed session renders calls to MCP tools before their server connected, if it ever does.
		// 登记历史工具显示兜底：输入toolName/next，优先下游已有渲染器，否则解析MCP名字创建通用渲染；例恢复历史时远端尚未连接也可显示，不调用工具。
		pi.registerToolRenderer((toolName, next) => {
			// 正则捕获两段非空名称，第一段非贪婪；无m，^/$要求整串边界，.不匹配换行。
			const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
			// ??只在next结果缺失时兜底；哈希/规范化工具名无法反推出完整原名，此处只是展示标签。
			return next() ?? (match ? createMcpToolRenderers(`${match[1]}/${match[2]}`) : undefined);
		});

		// 把一次握手/刷新发现的工具登记到宿主：构造namespace→分配稳定名→建定义→隐藏退出工具→同步资源；例a-b与a_b清洗重名时都尝试哈希后缀。回调/注册失败向runtime传播，不是事务式登记。
		const registerTools = (connection: McpServerConnection) => {
			// 从连接引用取配置原名。
			const server = connection.entry.name;
			// 优先当前会话entry，避免改exposure后仍用连接对象持有的旧条目；找不到才退回连接原entry。
			const entry = findServer(server)?.entry ?? connection.entry;
			// 配置description去空白，空串后面不会加入namespace。
			const description = entry.config.description?.trim();
			// 同台工具共享一个namespace描述对象。
			const namespace = {
				// 公开namespace使用统一规范化形式。
				name: mcpNamespace(server),
				// `describeNamespace("docs")` finds `mcp__docs`.
				// 原服务器名作别名，例如可describeNamespace("docs")。
				aliases: [server],
				// 条件展开，仅非空配置说明才附字段。
				...(description ? { description } : {}),
				// 远端instructions存在才附，不替代description，两字段用途不同。
				...(connection.instructions ? { instructions: connection.instructions } : {}),
			};
			// 上一轮工具名集合，未登记过则新空Set。
			const previous = serverTools.get(server) ?? new Set<string>();
			// 本轮从空集合累计实际分配的名字。
			const current = new Set<string>();
			// Like Codex, all tools whose names sanitize to the same name get the hash suffix, so which
			// one would keep the plain name does not depend on the order of the list.
			// 先按远端原名去重，再生成不查碰撞的清洗名数组，找出不同原名清洗成同名的情况。
			const plain = [...new Set(connection.tools.map((tool) => tool.name))].map((tool) =>
				// map把每个原工具名转成候选公开名。
				createMcpToolName(server, tool),
			);
			// 分配工具名并登记归属，返回字符串；输入远端工具名和归属键，闭包记录本轮集合。例清洗名已属于别台/别工具时请求哈希后缀；算法细节见createMcpToolName，不宣称无限碰撞都可消除。
			const assignName = (tool: string, owner: string) => {
				// 把“候选已占用吗”的回调交命名器，函数可能被它多次询问。
				const name = createMcpToolName(server, tool, (candidate) => {
					// 查询历史归属，有相同owner时允许复用。
					const existing = toolOwners.get(candidate);
					// 任一冲突条件成立都视为候选已占用。
					return (
						// 历史已有不同owner，不能复用这个公开名。
						(existing !== undefined && existing !== owner) ||
						// 本轮已经分配过同名，也算冲突。
						current.has(candidate) ||
						// 候选清洗名在plain数组出现多次，代表不依顺序抢占纯名。
						plain.indexOf(candidate) !== plain.lastIndexOf(candidate)
					);
				});
				// 记录最终公开名对应的原归属，后续执行前等待也用它找server。
				toolOwners.set(name, owner);
				// 本轮工具集合加入最终名。
				current.add(name);
				// 把分配好的名字交定义构造。
				return name;
			};
			// 按服务器发现顺序处理每份工具，不在这里再请求远端。
			for (const tool of connection.tools) {
				// 创建Pi工具定义，网络执行推迟到定义的execute。
				const definition = createMcpToolDefinition({
					// 服务器原名用于路由/展示。
					server,
					// 传入整份远端工具schema/说明/annotations。
					tool,
					// NUL字符分隔server/tool，避免普通文字拼接歧义；不是文件路径。
					name: assignName(tool.name, `${server}\0${tool.name}`),
					// 按精确工具名→模式覆盖→默认方式解析exposure，非仅服务器默认。
					exposure: getMcpToolExposure(entry.config, tool.name),
					// 关联共享namespace。
					namespace,
					// 定义保存此轮连接的请求毫秒超时；动态getClient可能后来拿到替换连接，超时值本身仍是构造时值。
					timeoutMs: connection.timeoutMs,
					// 执行时再取当前连接包装对象，不把原connection永远锁进execute；返回Promise，缺失/禁用/撤回工具则拒绝。例如等待期间禁用再启用可用新连接。
					getClient: async () => {
						// A prepared call can outlive this definition's connection while the readiness
						// hook waits for a disable/re-enable. Resolve the replacement at execution time.
						// 重新按原server名定位当前会话对象。
						const current = findServer(server);
						// 已移除或禁用时拒绝，不偷偷重建配置。
						if (!current || !isEnabled(current)) throw new Error(`MCP server "${server}" is disabled.`);
						// 获取当前连接包装，不一定已在线；runtime.callTool可按需重连。
						const client = current.connection;
						// 还没创建包装对象则报告starting，不在此等待；常规等待由tool_call准备钩子完成。
						if (!client) throw new Error(`MCP server "${server}" is still starting.`);
						// 再次核对当前可用性，避免仅凭旧定义继续执行。
						if (
							// 当前配置明确隐藏该工具就拒绝。
							getMcpToolExposure(current.entry.config, tool.name) === "hidden" ||
							// 只有state=connected才用发现表判断已撤回；断线时不凭可能过期工具表拒绝重连。
							(client.state === "connected" && !client.tools.some((offered) => offered.name === tool.name))
						) {
							// 隐藏或已撤回统一给不可用错误。
							throw new Error(`MCP tool "${server}/${tool.name}" is no longer available.`);
						}
						// 返回包装连接，不是裸McpClient；后续工具适配器调用它的callTool。
						return client;
					},
					// 读取资源提示是否可用的动态闭包；只检查当前可达集合，不立即读取资源。
					readableResources: () => resourceServers().some((current) => current.name === server),
				});
				// 缓存最终定义，以后可把旧工具重登记成hidden。
				definitions.set(definition.name, definition);
				// 交宿主登记，普通direct按宿主默认activate规则进入声明；不是此行就执行工具。
				pi.registerTool(definition);
			}
			// 将本轮集合替换为该服务器当前工具表。
			serverTools.set(server, current);
			// Tools cannot be unregistered, so tools the server dropped are re-registered as hidden. When
			// the server offers them again they are registered with their configured exposure above.
			// 遍历上一轮公开名，找出本轮消失的工具。
			for (const name of previous) {
				// 拿到曾登记定义，包含原执行/渲染规则。
				const definition = definitions.get(name);
				// 不在当前集合且仍有定义才重登记hidden；不能真正卸载宿主工具定义。
				if (!current.has(name) && definition) pi.registerTool({ ...definition, exposure: "hidden" });
			}
			// 工具登记后同步公共资源工具暴露级别。
			syncResourceTools();
		};

		/** Make a disabled server's tools unreachable. */
		// 隐藏指定服务器当前工具，清其当前名集合，再同步资源暴露，返回void。例禁用docs仍保留历史渲染定义；这里不关网络、不删除配置，宿主回调异常可传播。
		const hideTools = (server: string) => {
			// 缺当前集合时按空数组迭代。
			for (const name of serverTools.get(server) ?? []) {
				// 从缓存取原定义。
				const definition = definitions.get(name);
				// 浅复制定义并只覆盖exposure=hidden，其他字段/execute仍保留。
				if (definition) pi.registerTool({ ...definition, exposure: "hidden" });
			}
			// 把这台当前集合置为空Set，历史定义/归属Map不清空。
			serverTools.set(server, new Set());
			// 公共资源是否可见由当前servers配置/连接能力重新决定。
			syncResourceTools();
		};

		/** Enabled servers with resources whose exposure is not `hidden`, which the resource tools reach. */
		// 返回启用、声明过资源能力且服务器默认非hidden的条目新数组，不要求此刻state=connected；例断线能力标记保留时仍可列入，执行会重连。
		const serversWithResources = (): McpServer[] =>
			// 筛当前会话列表，不触发网络。
			servers.filter(
				// hasResources是最近握手能力，不按toolExposure算资源可达性，也不检查连接实时在线。
				(server) => server.connection?.hasResources && isEnabled(server) && exposureOf(server.entry) !== "hidden",
			);
		// 把可达资源服务器转成连接包装数组，供资源工具执行动态读取；不缓存构造时列表、不主动重连。
		const resourceServers = (): McpServerConnection[] =>
			// flatMap只保留有connection对象的项，类型推断得到连接数组。
			serversWithResources().flatMap((server) => (server.connection ? [server.connection] : []));

		/** Exposure the resource tools were last registered with; undefined until a server has resources. */
		// 上次公共三资源工具采用的暴露值；undefined表示尚未登记，不是服务器没能力的永恒断言。
		let resourceToolsExposure: McpExposure | undefined;
		/**
		 * Register the resource tools with the widest exposure of the servers they reach: `direct` when
		 * one of them is direct, and so on. They are hidden when no server has resources.
		 */
		// 按可达服务器默认exposure选统一最宽值并登记三工具；例一台direct、一台codemode会让公共工具direct并仍可访问两台。无资源时隐藏；会改宿主注册/active集合，不发resources/list。
		const syncResourceTools = () => {
			// 只汇总serversWithResources筛中的默认exposure，不查看每工具覆盖。
			const exposures = new Set(serversWithResources().map((server) => exposureOf(server.entry)));
			// as const保留字面量元组类型，find按direct→codemode→deferred顺序取第一个存在的方式。
			const exposure = (["direct", "codemode", "deferred"] as const).find((candidate) => exposures.has(candidate));
			// 没有可达资源服务器时用hidden。
			const next = exposure ?? "hidden";
			// 方式没变则不重登记；首次结果hidden时也不先创建不可见公共工具。
			if (next === resourceToolsExposure || (resourceToolsExposure === undefined && next === "hidden")) return;
			// 记住旧方式是否direct，后面决定从active中移除旧声明。
			const wasDirect = resourceToolsExposure === "direct";
			// 先更新缓存，再调用注册；注册抛错不会自动回滚这个字段。
			resourceToolsExposure = next;
			// 创建三工具，servers回调执行时取最新集合，不固定到本轮快照。
			const resourceDefinitions = createMcpResourceToolDefinitions({ exposure: next, servers: resourceServers });
			// 逐份登记到宿主，可改变暴露级别。
			for (const definition of resourceDefinitions) pi.registerTool(definition);
			// 只要上一方式direct就移除旧active项；前面同方式已return，因此这里意味着已转为间接/hidden。
			if (wasDirect) {
				// 构造三资源工具名集合便于过滤。
				const names = new Set(resourceDefinitions.map((definition) => definition.name));
				// 保留其他active工具，只把这三项移出直接声明集合。
				pi.setActiveTools(pi.getActiveTools().filter((name) => !names.has(name)));
			}
		};

		/**
		 * Tools that are not declared to the model are reached through the codemode tool (scripts call
		 * them) or the tool_search tool (it declares them). Either reaches every such tool. Activate the
		 * one the tools' exposure asks for: codemode for `codemode` unless `autoEnableCodemode` is false,
		 * tool_search for `deferred`.
		 */
		// 按配置需要激活codemode/tool_search，并在两者都不可达时提醒一次；输入ctx用于通知，返回void。例codemode自动激活被关闭但已有tool_search活动也视作可达，不保证每个配置入口都同时活动。
		const ensureDiscoveryActive = (ctx: ExtensionContext) => {
			// From the config, so the tool is active before the servers connect. Resource tools share
			// their server's exposure.
			// 收集所有启用服务器可能使用的exposure。
			const exposures = new Set<McpExposure>();
			// 遍历会话服务器，包括尚未握手的台。
			for (const server of servers) {
				// 启用才收集默认/覆盖方式，不等远端真实工具列表。
				if (isEnabled(server)) for (const exposure of configuredExposures(server.entry)) exposures.add(exposure);
			}
			// 是否有配置可能需要脚本入口。
			const needsCodemode = exposures.has("codemode");
			// 是否有配置可能需要延迟搜索入口。
			const needsToolSearch = exposures.has("deferred");
			// 都不需要就无需修改active或报警。
			if (!needsCodemode && !needsToolSearch) return;
			// Only a tool of these names that declares `reachesTools` can reach MCP tools; another
			// extension's tool of the same name without it is never activated.
			// 取宿主目前已注册工具元数据。
			const tools = pi.getAllTools();
			// 检查名字匹配且声明reachesTools的工具，返回some的布尔值；例同名普通工具没reachesTools不会被当作入口。
			const hasReachingTool = (name: string) => tools.some((tool) => tool.name === name && tool.reachesTools);
			// 判断合格codemode是否存在。
			const hasCodemode = hasReachingTool(CODEMODE_TOOL_NAME);
			// 判断合格tool_search是否存在。
			const hasToolSearch = hasReachingTool(TOOL_SEARCH_TOOL_NAME);
			// 取得当前active名称快照。
			const active = pi.getActiveTools();
			// 只累计需要新增的入口名，避免覆盖其他active项。
			const activate: string[] = [];
			// 需要/存在/允许自动启用/尚未active四条件都满足才加codemode。
			if (needsCodemode && hasCodemode && autoEnableCodemode && !active.includes(CODEMODE_TOOL_NAME)) {
				// 加入待激活列表，尚未调用宿主。
				activate.push(CODEMODE_TOOL_NAME);
			}
			// tool_search需要且存在且未active即可，不受autoEnableCodemode开关约束。
			if (needsToolSearch && hasToolSearch && !active.includes(TOOL_SEARCH_TOOL_NAME)) {
				// 加入待激活搜索入口。
				activate.push(TOOL_SEARCH_TOOL_NAME);
			}
			// 有新增项才一次写回合并列表。
			if (activate.length > 0) pi.setActiveTools([...active, ...activate]);
			// 用本地旧active+新增列表判断是否至少一个入口可达。
			const reachable = [...active, ...activate];
			// codemode合格且活动就结束检查。
			if (hasCodemode && reachable.includes(CODEMODE_TOOL_NAME)) return;
			// 否则tool_search合格且活动也可结束，不要求与每台单独配置一一对应。
			if (hasToolSearch && reachable.includes(TOOL_SEARCH_TOOL_NAME)) return;
			// 本会话已经提醒则不重复通知。
			if (warnedUnreachable) return;
			// 先标记已提醒，通知失败也不会自动重置。
			warnedUnreachable = true;
			// 特定情况下说明自动启用关闭，其他原因不附这段。
			const reason = needsCodemode && hasCodemode && !autoEnableCodemode ? " (autoEnableCodemode is false)" : "";
			// 向UI发warning，不抛协议错误或阻止会话。
			ctx.ui.notify(
				// 真实提示只说明两个入口都不活动的情况。
				`MCP tools are only reachable from the codemode or tool_search tool, but neither is active${reason}; they cannot be called.`,
				// 通知级别warning。
				"warning",
			);
		};

		/**
		 * Stored tokens of servers waiting for a sign-in, as they were when the sign-in was needed.
		 * `pi mcp login` in another process (for example run by the agent) changes them.
		 */
		// 按连接对象身份保存“进入needs-auth时”的token序列化快照；只比较内容，不验证令牌真实有效，也不是定时文件监控。
		const tokensAtSignIn = new Map<McpServerConnection, string>();
		// 读取连接对应凭证并序列化为可比较字符串；例另一进程登录后内容变了可触发重连。tokens不迁移旧键，但文件后端读取可初始化文件/加锁，异常可传播。
		const storedTokens = (connection: McpServerConnection): string => {
			// 只有独立MCP OAuth才有url，auth.provider不使用这张token快照表。
			const url = connection.oauthUrl;
			// 存储已创建且有URL才读；缺token用JSON的null文字，不拿此值发请求。
			return url && credentials ? JSON.stringify(credentials.tokens(connection.name, url) ?? null) : "null";
		};
		// 状态回调维护登录等待快照并通知界面，返回void；首次进入needs-auth时记录，继续needs-auth不覆盖，以便发现外部变更。
		const onConnectionChange = (connection: McpServerConnection) => {
			// 离开needs-auth就不再等待外部登录变化。
			if (connection.state !== "needs-auth") tokensAtSignIn.delete(connection);
			// 尚无快照才读取并存，避免每次状态通知刷新比较基线。
			else if (!tokensAtSignIn.has(connection)) tokensAtSignIn.set(connection, storedTokens(connection));
			// 同步通知订阅者，回调异常不隔离。
			emitChange();
		};
		/** Reconnect servers that need a sign-in when their credentials were stored since. */
		// 检查等待登录的连接token是否变化，有变化并发重连后确保发现入口；例外部pi mcp login写新token，下一turn_start发现。allSettled吸收重连失败，后续仍需看状态。
		const reconnectSignedIn = async (ctx: ExtensionContext) => {
			// 展开Map成快照，再逐个重读凭证比JSON字符串；过期时间等不在tokens字段里的变化不触发。
			const signedIn = [...tokensAtSignIn].filter(([connection, tokens]) => storedTokens(connection) !== tokens);
			// 没有变化就不重连也不改active。
			if (signedIn.length === 0) return;
			// 先移除这些基线，重连回调可按新needs-auth状态再建立快照。
			for (const [connection] of signedIn) tokensAtSignIn.delete(connection);
			// 等待所有重连落定，不让单台失败直接拒绝整个并发批次。
			await Promise.allSettled(signedIn.map(([connection]) => connection.reconnect()));
			// 完成后按当前配置确保脚本/搜索入口活动。
			ensureDiscoveryActive(ctx);
		};

		/** Create the server's connection, loading the MCP runtime on first use. */
		// 加载runtime后创建连接包装并接回调，返回实例或过期时undefined；还不调用getClient。例加载模块期间被禁用则丢弃结果；构造凭证/日志对象而不在此读token，加载/回调错误可拒绝。
		const createConnection = async (
			// 要创建的会话服务器对象。
			server: McpServer,
			// 闭包判断本次尝试是否仍属于当前会话/配置。
			isCurrent: () => boolean,
		): Promise<McpServerConnection | undefined> => {
			// 动态模块可能首次加载，也可能复用模块缓存；await会让其他事件先运行。
			const runtime = await loadMcpRuntime();
			// 等待之后再核对身份，避免过期加载结果继续创建连接。
			if (!isCurrent()) return undefined;
			// 创建包装对象，保存配置和认证回调，不在构造内握手。
			const connection = new runtime.McpServerConnection({
				// 传当前entry引用，后续saveConfig可用新对象替换server.entry。
				entry: server.entry,
				// 进程cwd/协议roots使用本会话目录。
				cwd: sessionCwd,
				// 测试可注入工厂，否则用默认HTTP/stdio。
				createTransport: options.createTransport ?? runtime.createDefaultTransport,
				// 按需取得共享凭证存储对象。
				credentials: getCredentials(runtime),
				// 每次认证取令牌时读取当前modelRegistry；可选链允许未配置，调用可能刷新供应商凭证。
				providerToken: async (provider) => modelRegistry?.getApiKeyForProvider(provider),
				// 取得日志写入器引用，文件写入在收到通知后。
				log: getServerLog(runtime),
				// 工具发现回调闭包捕获本次尝试身份，不直接无条件登记。
				onTools: (connection) => {
					// 仍当前才登记，旧连接迟到工具结果不会重新暴露。
					if (isCurrent()) registerTools(connection);
				},
				// 连接状态回调也核对尝试身份。
				onChange: (connection) => {
					// 当前连接状态才更新登录基线/界面。
					if (isCurrent()) onConnectionChange(connection);
					// 旧连接仅删除其登录等待基线，不给当前服务器菜单发变更。
					else tokensAtSignIn.delete(connection);
				},
			});
			// 把包装对象挂到server，实际网络启动在startConnection后面。
			server.connection = connection;
			// 发布“有连接对象了”的更新，state通常仍connecting。
			emitChange();
			// 返回同一包装实例供调用getClient。
			return connection;
		};

		/**
		 * Connect the server in the background. `server.ready` settles when it connected or failed;
		 * failures show in its state. It starts after `after`, unless disabled, replaced, or shut down
		 * meanwhile. The returned promise rejects when the MCP runtime cannot be loaded.
		 */
		// 后台连接入口：换Symbol→等前序清理/模块加载→确认当前→建包装→getClient。返回原ready可拒绝加载错误；server.ready另存吸收失败版，例禁用再启用先等server.closing，避免旧进程未关完就新开。
		const startConnection = (server: McpServer, after?: Promise<unknown>): Promise<void> => {
			// 捕获此时会话signal，后面即使session变量换新也仍认得旧会话。
			const { signal } = session;
			// 每次调用得到独一Symbol，不凭名称/时间推断是否最新。
			const attempt = Symbol();
			// 发布本轮身份，让旧isCurrent回调失效。
			server.attempt = attempt;
			// 无参闭包每次读最新配置/集合，并比较捕获的signal与attempt。
			const isCurrent = () =>
				// 未取消、Symbol仍匹配、配置启用、同一server对象仍在列表，四条件缺一就过期。
				!signal.aborted && server.attempt === attempt && isEnabled(server) && servers.includes(server);
			// 立即调用async箭头启动流程，返回一个Promise，不创建新线程。
			const ready = (async () => {
				// 前序可以是模块预加载或旧连接清理；await undefined也会让出微任务。
				await after;
				// 前序等待后检查过期，避免多余新连接。
				if (!isCurrent()) return;
				// 创建包装本身也有await，再次允许会话变化。
				const connection = await createConnection(server, isCurrent);
				// 未创建或再次过期就停止，不调用getClient。
				if (!connection || !isCurrent()) return;
				// 正式握手/发现；连接失败由runtime记state并抛出，此处吸收，不把失败伪称connected。
				await connection.getClient().catch(() => undefined);
			})();
			// 对外等待准备时不传播ready拒绝，状态/通知另行表达错误。
			server.ready = ready.catch(() => undefined);
			// 调用方拿原Promise，仍可观察模块/构造等未被getClient.catch吸收的失败。
			return ready;
		};

		/** Wait for the latest connection attempts, including ones queued while waiting, or an abort. */
		// 等待指定服务器的最新ready，若等待中同一对象排入新ready就再循环；返回void，不承诺连接成功。例重连尚在关闭旧传输也会等；signal只让本等待提前结束，不取消连接。
		const waitForServers = async (waiting: readonly McpServer[], signal: AbortSignal | undefined) => {
			// 循环用于重新读取变更后的ready引用，不是无限主动重连。
			for (;;) {
				// 为传入waiting列表取当前仍可用的等待快照。
				const ready = waiting.flatMap((server) =>
					// 仅启用、还在会话集合、已有ready的台入列；等待期间新加但不在waiting里的台不自动纳入。
					isEnabled(server) && servers.includes(server) && server.ready ? [{ server, ready: server.ready }] : [],
				);
				// 没有可等任务或调用者已取消就结束。
				if (ready.length === 0 || signal?.aborted) return;
				// 保存取消监听引用，竞速完成后移除。
				let onAbort: (() => void) | undefined;
				// 连接全完成与调用者取消两路竞速，race不会取消输的一路。
				await Promise.race([
					// 等待快照中的全部ready，通常这些Promise已吞连接失败。
					Promise.all(ready.map((attempt) => attempt.ready)),
					// 创建“取消就完成”的Promise，未传signal则这一路一直待定。
					new Promise<void>((resolve) => {
						// abort回调只resolve等待，不向runtime调用close。
						onAbort = () => resolve();
						// 一次性监听；正常完成仍由下面remove解除。
						signal?.addEventListener("abort", onAbort, { once: true });
					}),
				]);
				// 竞速完成后解除本轮监听，避免正常ready结束还留下abort回调。
				if (onAbort) signal?.removeEventListener("abort", onAbort);
				// 决定是否等待了最新一轮，下面任一总条件成立即可返回。
				if (
					// 取消后不再追新ready。
					signal?.aborted ||
					// 否则所有快照项都已经稳定/退出才结束。
					ready.every(
						// 逐项比较原快照里的server和ready。
						(attempt) =>
							// 已禁用不必继续等它。
							!isEnabled(attempt.server) ||
							// 已从当前集合移除也不再等。
							!servers.includes(attempt.server) ||
							// 仍同一ready说明没有在等待期间换成新任务；它落定不表示成功。
							attempt.ready === attempt.server.ready,
					)
				)
					// 条件满足结束；若某项ready变了则自然下一圈重新取快照。
					return;
			}
		};

		/**
		 * One message for everything that needs the user after startup, or only for `only`, servers
		 * that connected later.
		 */
		// 把配置错误和失败/需登录台合成一次通知，返回void；例启动批次结束提醒/mcp。传only时只报告该批服务器，不附全局配置错误；不在本函数去重。
		const reportProblems = (ctx: ExtensionContext, only?: readonly McpServer[]) => {
			// 传only即使空数组也不加配置错误；否则先收集配置错误文字。
			const lines = only ? [] : configErrors.map((error) => `config: ${error}`);
			// 遍历指定子集或全部服务器。
			for (const server of only ?? servers) {
				// 读取当前连接状态，没有连接不会在此算failed。
				const state = server.connection?.state;
				// 仅needs-auth/failed进入报告，不包含disconnected/禁用提示。
				if (state === "needs-auth" || state === "failed")
					// 每行含原名和简短状态，failed默认含error第一行。
					lines.push(`${server.entry.name}: ${describeState(server)}`);
			}
			// 没有问题不打扰UI。
			if (lines.length === 0) return;
			// 通过当前ctx通知，不改变连接/权限。
			ctx.ui.notify(
				// 缩进每行并附/mcp操作入口，没有自动执行修复。
				`MCP servers need attention:\n${lines.map((line) => `  ${line}`).join("\n")}\nRun /mcp to fix.`,
				// 通知级别warning。
				"warning",
			);
		};

		/**
		 * Save a config change; returns an error message when the file could not be updated. Changes to
		 * registered servers only apply to the current session. `inProject` adds a project override.
		 */
		// 保存enabled/exposure等补丁，成功更新会话entry并返回undefined，文件错误转文字；例全局台“在项目禁用”写override。扩展来源只在内存浅合并；保存非跨文件/内存事务，注入回调也可能有副作用。
		const saveConfig = (server: McpServer, patch: McpServerConfigPatch, inProject = false): string | undefined => {
			// 请求项目覆盖时选当前projectConfig，否则沿用已有override。
			const override = inProject ? projectConfig : server.entry.override;
			// 只有truthy覆盖路径才复制entry并附override；没有可用project路径不会凭空创建。
			const entry = override ? { ...server.entry, override } : server.entry;
			// 扩展登记项不调用文件更新器，source是扩展路径而非配置文件。
			if (entry.scope !== "extension") {
				// 只包住文件更新回调，下面内存赋值不在此catch内。
				try {
					// 按source/override写补丁，异常可能来自读取/序列化/写盘或注入实现。
					updateConfig(entry, patch);
					// 把未知错误转可展示文字供菜单，不抛掉整个管理循环。
				} catch (error) {
					// 附实际写入目标方便定位；不脱敏自定义错误。
					return `Could not update ${entry.override ?? entry.source}: ${errorMessage(error)}`;
				}
			}
			// 文件成功或扩展来源时，替换entry和config顶层对象；patch是浅展开，嵌套字段不递归合并。
			server.entry = { ...entry, config: { ...entry.config, ...patch } };
			// undefined约定表示保存未报告错误，不代表远端已连接。
			return undefined;
		};

		/** Sign in, then reconnect. Returns an error message on failure. `cancel` or the session's end stops the sign-in. */
		// 显式OAuth登录后重连，成功undefined，常规失败文字；例用户取消返回“Sign-in cancelled.”。取消协作式，runtime加载在try外、设置解析在登录try内，重连不由cancel信号直接终止，也不把整个函数都登记为track。
		const signIn = async (
			// 目标服务器包装，开始时捕获其connection。
			server: McpServer,
			// 显示授权链接/等待粘贴的宿主交互。
			prompt: McpSignInPrompt,
			// 可选单次操作取消，稍后和会话signal组合。
			cancel?: AbortSignal,
		): Promise<string | undefined> => {
			// 捕获开始时的connection，后面await期间即使server换连接仍使用这份引用。
			const connection = server.connection;
			// 只有独立MCP OAuth连接提供oauthUrl。
			const url = connection?.oauthUrl;
			// 没有对应连接或独立OAuth就给文字，不启动授权。
			if (!connection || !url) return `MCP server "${server.entry.name}" does not use OAuth.`;
			// 加载runtime发生在下方try外，加载失败直接拒绝，不转“Sign-in failed”。
			const runtime = await loadMcpRuntime();
			// 此时读取session.signal并和单次cancel组合；前面加载await前没有先捕获signal。
			const signal = cancel ? AbortSignal.any([session.signal, cancel]) : session.signal;
			try {
				// 跟踪signInMcpServer返回的Promise，让会话关闭等它清理回调端口；参数求值抛错仍由当前try接住。
				await track(
					// 调用OAuth模块显式登录，可能刷新旧grant或需要浏览器授权。
					runtime.signInMcpServer({
						// 目标服务URL用于OAuth发现和状态校验。
						serverUrl: url,
						// 按当前server名/捕获URL取得分区存储，登录会保存token等状态。
						store: getCredentials(runtime).forServer(server.entry.name, url),
						// 此时解析设置/secret，失败由外层catch转成登录失败文字。
						settings: connection.oauthSettings(),
						// 带上最近挑战，尤其增权scope和资源元数据地址。
						challenge: connection.challenge,
						// 宿主负责链接展示与手工回调输入。
						prompt,
						// 组合取消信号传下去，是否终止具体步骤依OAuth实现。
						signal,
					}),
				);
				// 捕获登录及参数求值的异常，不涵盖前面的runtime加载。
			} catch (error) {
				// 专用取消类用固定友好结果，调用方可选info而非error级别。
				if (error instanceof runtime.McpSignInCancelledError) return "Sign-in cancelled.";
				// 其他异常转普通错误文字，保留发生原因但不保留原类。
				return `Sign-in failed: ${errorMessage(error)}`;
			}
			// The challenge that asked for this sign-in (for example for more scope) is answered.
			// 授权流程完成后清掉已应答挑战；未再次核对当前连接身份。
			connection.challenge = undefined;
			// 授权成功和新连接成功分开处理。
			try {
				// 用捕获的包装对象重连以发送最新token；本行未把单次cancel信号作为参数。
				await connection.reconnect();
				// 重连失败不会把已经完成的授权说成没登录。
			} catch (error) {
				// 返回“登录成功但连接失败”的文字。
				return `Signed in, but ${errorMessage(error)}`;
			}
			// 授权和重连都无异常时返回undefined。
			return undefined;
		};

		// 删除本地OAuth状态再断开显示需登录，返回是否删到本地记录；例logout不调用远端revoke。加载/存储/关闭异常可拒绝，不保证与并发刷新/登录互斥。
		const signOut = async (server: McpServer): Promise<boolean> => {
			// 捕获当前连接包装引用。
			const connection = server.connection;
			// 获取独立OAuth目标，供应商auth.provider不在此注销。
			const url = connection?.oauthUrl;
			// 没有独立OAuth连接直接false，也不删除任何凭证。
			if (!connection || !url) return false;
			// 按名称/URL删除一份匹配状态，先加载模块再同步remove；两个新旧键并存只删优先项。
			const removed = getCredentials(await loadMcpRuntime()).remove(server.entry.name, url);
			// 即使removed=false也尝试断开并显示needs-auth。
			await connection.signOut();
			// 返回删除结果，不是远端授权撤销结果。
			return removed;
		};

		// 管理操作重连：排在该台现有ready后，更新server.ready并等待；返回undefined/错误文字。例旧重连还在关传输时新请求可等它；不修改配置，也不产生新attempt身份。
		const reconnect = async (server: McpServer): Promise<string | undefined> => {
			// 捕获当前包装对象，后续等待期间不自动换成替代对象。
			const connection = server.connection;
			// 无对象用disabled提示，即使实际可能仍starting；这是界面文案，不是再次验证enabled。
			if (!connection) return `MCP server "${server.entry.name}" is disabled.`;
			// 保存上一轮ready引用，避免把下面新任务等到自己。
			const previous = server.ready;
			// 立即启动async闭包并保存原Promise。
			const ready = (async () => {
				// 先等该台先前准备落定。
				await previous;
				// 调用runtime重连方法，等旧opening/丢旧连接/新握手。
				await connection.reconnect();
			})();
			// 对其他工具等待者暴露吸收拒绝的ready；实际错误仍由此处原Promise处理。
			server.ready = ready.catch(() => undefined);
			// 把本轮失败转成可显示字符串。
			try {
				// 等待新一轮重连真实结果。
				await ready;
				// 无异常表示本轮重连完成，不另返回工具列表。
				return undefined;
				// 失败进入错误文字路径。
			} catch (error) {
				// Error取message，其他值String化。
				return errorMessage(error);
			}
		};

		/** Returns an error message when the config could not be saved; connection errors show in the state. */
		// 保存启用状态后关闭或启动连接，成功undefined、保存错误文字，其他加载/关闭错误仍可拒绝。例disable→摘连接/失效Symbol→隐藏工具→等关闭；enable先等server.closing。保存成功后失败不回滚配置。
		const setEnabled = async (
			// 会话服务器条目，原对象用于attempt/ready状态。
			server: McpServer,
			// 布尔值只决定此处启用/禁用动作；配置校验不在这里重跑。
			enabled: boolean,
			// true优先请求项目覆盖，菜单仅在有可信项目路径时提供它；此函数不另验信任，缺路径时saveConfig仍可退回原来源。
			inProject = false,
		): Promise<string | undefined> => {
			// 先保存配置及内存补丁，再动连接。
			const failed = saveConfig(server, { enabled }, inProject);
			// 保存失败不继续改变连接，返回失败说明。
			if (failed) return failed;
			// 禁用路径不再创建新连接。
			if (!enabled) {
				// 先保存旧包装，后面从server摘除。
				const connection = server.connection;
				// 让旧startConnection回调的Symbol比较失败。
				server.attempt = undefined;
				// 立刻对外表现没有连接，旧对象仍由本地变量负责关。
				server.connection = undefined;
				// 有旧包装才新建closing任务；否则可以沿用已有closing。
				if (connection) {
					// A reconnect may already have detached its old client while awaiting transport
					// shutdown. Closing the connection alone does not wait for that reconnect.
					// 并行等包装close和旧ready，后者可能包含仍在关旧传输的重连；then统一为void，拒绝不在本行吞。
					server.closing = Promise.all([connection.close(), server.ready]).then(() => undefined);
				}
				// 捕获本次要等的closing引用，避免finally清掉后来替换的任务。
				const closing = server.closing;
				// 先隐藏工具，使等待关闭时也不能继续作为可达工具登记。
				hideTools(server.entry.name);
				// 通知菜单即时刷新成禁用状态。
				emitChange();
				// 等待清理，finally确保在正常/异常后整理引用。
				try {
					// await undefined也可正常完成；关闭拒绝继续向上抛。
					await closing;
				} finally {
					// 仅本次任务仍登记时清空，保护后来创建的closing。
					if (server.closing === closing) server.closing = undefined;
				}
				// 禁用清理结束，不启动新连接。
				return undefined;
			}
			// 启用时启动新attempt，等待尚未完成的旧closing再建传输。
			await startConnection(server, server.closing);
			// 连接协议失败可被startConnection内部吸收并记state；因此undefined不保证在线。
			return undefined;
		};

		// 保存服务器默认暴露方式，在线时重登记工具，调整资源/active并通知，返回undefined或保存错误文字。例direct→codemode移出直接声明；每工具覆盖仍可保留direct，注册异常不会事务回滚。
		const setExposure = (server: McpServer, exposure: McpExposure): string | undefined => {
			// 先写配置和当前entry，不只临时改一份工具定义。
			const failed = saveConfig(server, { exposure });
			// 保存失败就不继续重登记。
			if (failed) return failed;
			// 仅已connected才用当前发现工具表重新构建定义。
			if (server.connection?.state === "connected") registerTools(server.connection);
			// 公共资源暴露也要重算，非工具toolExposure逻辑。
			syncResourceTools();
			// Tools no longer exposed directly leave the declared set; direct tools are activated on registration.
			// 构造当前非direct工具名集合供后面移出active。
			const indirect = new Set(
				// 从宿主API开始链式读取。
				pi
					// 列所有已注册工具，不限MCP。
					.getAllTools()
					// 不是strict direct都入此集合，包括间接/hidden/其他宿主方式。
					.filter((tool) => tool.exposure !== "direct")
					// 转为名称，Set用于后续常数时间成员查询。
					.map((tool) => tool.name),
			);
			// 只对该台当前工具名作active调整，缺表用空Set。
			const tools = serverTools.get(server.entry.name) ?? new Set<string>();
			// 保留别台工具或该台仍direct的工具；只移除同时属于此台与indirect集合的项。
			pi.setActiveTools(pi.getActiveTools().filter((name) => !tools.has(name) || !indirect.has(name)));
			// 同步通知订阅者刷新说明/菜单。
			emitChange();
			// 返回undefined表示没有保存错误；不测模型是否已经收到更新声明。
			return undefined;
		};

		// ---------------------------------------------------------------------------------------
		// Manager (`/mcp` in the TUI)
		// ---------------------------------------------------------------------------------------

		// 收集菜单提醒文字并返回新数组，无文件/网络副作用。例配置错误和被覆盖登记分别加来源标签。
		const notices = () => [
			// 展开配置错误行。
			...configErrors.map((error) => `config: ${error}`),
			// 展开文件配置遮蔽扩展登记的说明。
			...overridden.map((line) => `overridden: ${line}`),
		];

		// 构造服务器总菜单快照，排序需注意的台优先，返回McpMenu不等待输入；例needs-auth排在线前，原servers顺序不变。括号中的对象是箭头函数返回值。
		const serversMenu = (): McpMenu => ({
			// 总菜单标题。
			title: "MCP servers",
			// LF合并提醒，空串用||转undefined隐藏错误区。
			error: notices().join("\n") || undefined,
			// 展开复制数组，避免sort改变会话服务器列表。
			items: [...servers]
				// 先按关注权重差排序，权重相同再按名称地区规则排序。
				.sort((a, b) => attentionRank(a) - attentionRank(b) || a.entry.name.localeCompare(b.entry.name))
				// map把每台转换成SelectItem对象。
				.map((server) => ({
					// 选择后返回服务器原名供manage查找。
					value: server.entry.name,
					// 显示标签同样使用原名。
					label: server.entry.name,
					// 说明包括当前状态/默认暴露/来源；有override时显示global,project override，不另读文件确认。
					description: `${describeState(server)} · ${exposureOf(server.entry)} · ${server.entry.override ? "global, project override" : (server.entry.scope ?? server.entry.source)}`,
				})),
			// 空态展示推荐配置位置，resolve只解析路径，不创建文件。
			empty: `No MCP servers configured. Add them to ${resolve(getAgentDir(), "mcp.json")} or .pi/mcp.json.`,
			// 确认键提示叫manage，实际键位由UI配置匹配。
			confirmLabel: "manage",
			// 取消总菜单意为关闭管理界面。
			cancelLabel: "close",
		});

		// 按原名生成单台动作菜单，不执行动作；例禁用只提供enable，在线可看工具/重连/注销。服务器移除时返回可返回上一层的空态，配置/UI拼接异常可传播。
		const serverMenu = (name: string): McpMenu => {
			// 每次重建读最新会话对象，不永久捕获原server。
			const server = findServer(name);
			// 可能在菜单打开期间被注销/替换，先处理找不到情况。
			if (!server) {
				// 返回正常菜单数据，而不是抛“找不到”。
				return {
					// 保留所选名称作标题。
					title: name,
					// 没有可执行动作。
					items: [],
					// 明确说明已不在配置里。
					empty: "This server is no longer configured.",
					// 无确认动作，不显示有意义的确认说明。
					confirmLabel: "",
					// 取消回到总菜单。
					cancelLabel: "back",
				};
			}
			// 捕获本次快照entry/connection，之后状态变化靠订阅重新构建。
			const { entry, connection } = server;
			// 计算每种动作说明中“保存位置”文字。
			const saved =
				// 扩展登记来源不写配置。
				entry.scope === "extension"
					? // 提示只对当前会话有效。
						"for this session"
					: // 其他来源先看是否有project override。
						entry.override
						? // 已有override提示写项目文件。
							"saved to the project mcp.json"
						: // 没有override再看scope标识。
							entry.scope
							? // 已知global/project显示对应范围。
								`saved to the ${entry.scope} mcp.json`
							: // 没scope时退为通用配置提示。
								"saved to mcp.json";
			// Global servers without an override can be turned on or off for the trusted project alone.
			// 仅全局台、尚无覆盖、且有可信项目路径时开放项目单独启停。
			const inProject = entry.scope === "global" && !entry.override && projectConfig !== undefined;
			// 项目专用动作的保存说明。
			const inProjectSaved = "saved to the project mcp.json";
			// 从空动作列表按状态追加，数组元素用SelectItem类型检查。
			const items: SelectItem[] = [];
			// 配置禁用优先，不看残留连接state。
			if (!isEnabled(server)) {
				// 提供按来源启用操作。
				items.push({ value: "enable", label: "Enable", description: saved });
				// 条件允许才再提供“只在项目启用”。
				if (inProject) {
					// 独立动作名带-project，稍后由runAction解析。
					items.push({ value: "enable-project", label: "Enable in this project", description: inProjectSaved });
				}
			} else {
				// 启用时读取当前连接状态，尚无连接可为undefined。
				const state = connection?.state;
				// 仅needs-auth给登录动作；不在此再核实独立OAuth，signIn会处理不支持情况。
				if (state === "needs-auth")
					// 登录动作描述浏览器用途，不保证平台真的打开成功。
					items.push({ value: "signin", label: "Sign in", description: "opens the browser" });
				// 在线且有包装对象才显示工具表动作。
				if (state === "connected" && connection) {
					// 工具数量取缓存，不重新拉tools/list。
					items.push({ value: "tools", label: "Tools", description: `${connection.tools.length} offered` });
				}
				// 这些非connecting状态允许手工重连。
				if (state === "failed" || state === "disconnected" || state === "connected" || state === "needs-auth") {
					// 重连动作不会在构造菜单时执行。
					items.push({ value: "reconnect", label: "Reconnect" });
				}
				// 只有在线独立OAuth连接给注销动作，auth.provider不在本菜单注销。
				if (state === "connected" && connection?.oauthUrl) {
					// 注销描述指本地凭证删除，不是远端revoke。
					items.push({ value: "signout", label: "Sign out", description: "deletes the stored credentials" });
				}
				// 启用台可调整默认暴露方式。
				items.push({ value: "exposure", label: "Exposure", description: exposureOf(entry) });
				// 也可按原来源禁用。
				items.push({ value: "disable", label: "Disable", description: saved });
				// 可信项目单独禁用的可用条件同上。
				if (inProject) {
					// 项目禁用动作保持不同value供保存规则识别。
					items.push({ value: "disable-project", label: "Disable in this project", description: inProjectSaved });
				}
			}
			// 详情段是多行展示文字数组。
			const details = [
				// 显示配置传输，不执行命令。
				describeTransport(entry),
				// 显示scope与实际来源路径。
				`${entry.scope ?? "config"}: ${entry.source}`,
				// 有override才补一行项目覆盖路径。
				...(entry.override ? [`project override: ${entry.override}`] : []),
				// 状态不在此重复拼失败首行，完整error在独立错误区。
				`State: ${describeState(server, false)}`,
			];
			// 错误区合并上次菜单动作message和非在线时的connection.error；在线不显示旧协议error，但仍可显示message。
			const error = [server.message, connection?.state === "connected" ? undefined : connection?.error]
				// 类型谓词line is string帮助TS知道filter后不含undefined；空串仍保留。
				.filter((line): line is string => line !== undefined)
				// 用LF合并成一段错误文字。
				.join("\n");
			// 输出菜单对象，没有调用网络。
			return {
				// 单台标题包括原名。
				title: `MCP server ${name}`,
				// 详情各行LF合并。
				details: details.join("\n"),
				// 空错误段转undefined，让UI不画它。
				error: error || undefined,
				// 属性简写交出刚才累计动作数组。
				items,
				// 初次选第一个动作，空数组得到undefined；后续UI优先保留自己的选择。
				selected: items[0]?.value,
				// 确认提示为select。
				confirmLabel: "select",
				// 取消回上一层，不关闭整个扩展。
				cancelLabel: "back",
			};
		};

		// 显示该台缓存工具列表并等关闭，不调用工具，返回Promise<void>。例工具覆盖exposure时标在说明前；这里没传subscribe，后台变化不会自动重建这个子菜单。
		const showTools = async (ui: McpUi, server: McpServer) => {
			// 默认暴露在打开时捕获，期间不随菜单重建重新取。
			const exposure = exposureOf(server.entry);
			// 只要覆盖表有键就提示存在覆盖，不保证这些键真匹配了远端工具。
			const overridden = Object.keys(server.entry.config.toolExposure ?? {}).length > 0;
			// build闭包返回工具说明菜单，但未订阅自动更新。
			await ui.menu(() => ({
				// 工具列表标题。
				title: `Tools of ${server.entry.name}`,
				// 默认方式说明+可选覆盖提示，hidden使用固定不可达说明。
				details: `Exposure ${exposure}: ${exposure === "hidden" ? "unreachable" : EXPOSURE_DESCRIPTIONS[exposure]}${overridden ? "\nSome tools override it with toolExposure." : ""}`,
				// 没有连接/工具就空列表；工具顺序沿远端发现列表。
				items: (server.connection?.tools ?? []).map((tool) => {
					// 单工具按当前entry解析实际方式。
					const toolExposure = getMcpToolExposure(server.entry.config, tool.name);
					// 说明只保留LF前一行，缺描述用空串。
					const description = firstLine(tool.description ?? "");
					// 返回工具菜单项，选择它只是退出此列表。
					return {
						// value是远端原工具名，不是公开mcp__名。
						value: tool.name,
						// 显示原工具名。
						label: tool.name,
						// 方式与默认不同才加方括号标记。
						description: toolExposure === exposure ? description : `[${toolExposure}] ${description}`,
					};
				}),
				// 空工具表提示，不把它当连接错误。
				empty: "The server offers no tools.",
				// 确认意为返回，不执行所选工具。
				confirmLabel: "back",
				// 取消同样返回。
				cancelLabel: "back",
			}));
		};

		// 让用户选择三种非hidden默认方式并保存，返回错误文字/undefined；例direct改codemode会重登记。取消或不变不写文件；as断言不验证注入UI返回值，真实UI候选受下表控制。
		const chooseExposure = async (ui: McpUi, server: McpServer): Promise<string | undefined> => {
			// 打开时捕获当前默认方式。
			const current = exposureOf(server.entry);
			// 等待菜单选择，未传订阅器，不自动跟后台配置变化刷新。
			const choice = await ui.menu(() => ({
				// 标题包含服务器名。
				title: `Exposure of ${server.entry.name}`,
				// 展示本次保存目标/范围的说明。
				details:
					// 扩展登记只在内存变化。
					server.entry.scope === "extension"
						? // 显示登记来源与会话范围。
							`Applies to this session; the server is registered by ${server.entry.source}.`
						: // 文件来源优先override路径。
							`Saved to ${server.entry.override ?? server.entry.source}.`,
				// Object.keys结果string[]经keyof typeof断言为三合法键，便于下方索引文案；断言本身不运行验证。
				items: (Object.keys(EXPOSURE_DESCRIPTIONS) as (keyof typeof EXPOSURE_DESCRIPTIONS)[]).map((exposure) => ({
					// 选择返回exposure字符串。
					value: exposure,
					// 当前项显示勾选符，其余用空格对齐；这是已有展示字符串。
					label: `${exposure === current ? "✓ " : "  "}${exposure}`,
					// 按键取对应说明。
					description: EXPOSURE_DESCRIPTIONS[exposure],
				})),
				// UI初始尽量选当前值；当前hidden不在候选内时回到第一项。
				selected: current,
				// 确认提示save。
				confirmLabel: "save",
				// 取消返回上一层。
				cancelLabel: "back",
			}));
			// 没选择或选择未变就返回成功空结果，不写盘。
			if (!choice || choice === current) return undefined;
			// 把候选文字断言为联合类型后交保存逻辑，真实配置修改在setExposure。
			return setExposure(server, choice as McpExposure);
		};

		/** Sign in with the manager view's sign-in screen, which shows the URL with a copy key and cancels with Esc. */
		// 用管理界面实现登录提示并返回signIn结果，可能打开浏览器/写凭证/重连；例浏览器不可达时可粘贴URL。取消信号只协作通知，输入结束后即使取消也先显示Connecting，具体结果由OAuth竞速决定。
		const signInWithUi = (ui: McpUi, server: McpServer): Promise<string | undefined> => {
			// 本次登录标题固定服务器名。
			const title = `Sign in to ${server.entry.name}`;
			// 单次操作控制器独立于会话控制器，后面signIn组合两者。
			const cancel = new AbortController();
			// 状态显示闭包接文字、返回void，同时装取消键回调；例按cancel只abort，不强制Promise结束。
			const status = (message: string) => ui.status(title, message, () => cancel.abort());
			// 先留空URL，SDK生成授权地址后填入。
			let authorizationUrl = "";
			// 先切可取消的联系授权服务器状态页。
			status("Contacting the authorization server…");
			// 返回signIn的Promise，不在此另包一层等待。
			return signIn(
				// 传目标server对象。
				server,
				// 以下对象实现McpSignInPrompt接口。
				{
					// SDK要跳转时回调，输入URL，不返回异步完成凭据。
					showAuthorizationUrl: (url) => {
						// 记href供下一步粘贴页面显示。
						authorizationUrl = url.href;
						// 显式尝试系统浏览器；注入openUrl也可做别的事，失败同步抛出会让登录失败。
						openUrl(url.href);
					},
					// SDK等待回调时调用这个异步输入适配器，signal由其浏览器/取消竞速控制。
					promptForRedirectUrl: async (signal) => {
						// 显示授权链接并等待粘贴或abort/取消。
						const value = await ui.redirectUrl(title, authorizationUrl, signal);
						// 输入Promise落定后改状态文案；不等于此时已经获得合法授权码或真正进入MCP握手。
						status("Connecting…");
						// 原样把可空输入交外层OAuth解析/取消逻辑。
						return value;
					},
				},
				// 传单次取消signal，由signIn再组合会话结束。
				cancel.signal,
			);
		};

		/** Keep the subscribed menu usable while a connection opens or closes. */
		// 后台启动管理动作并跟踪完成，不阻塞订阅菜单；完成只在会话/attempt/对象仍有效时写message。例enable耗时菜单可继续用；operation同步抛错不会进入后面的Promise失败回调。
		const runInBackground = (
			// 上下文用于完成后入口激活/通知。
			ctx: ExtensionContext,
			// 捕获目标会话对象，非仅名称。
			server: McpServer,
			// 操作返回错误文字或undefined的Promise；不在类型层保证不抛异常。
			operation: () => Promise<string | undefined>,
		) => {
			// 先调用操作，让它有机会同步更新attempt，再记录身份；不是下面track才启动。
			const ready = operation();
			// 保存操作开始之后的attempt，供完成回调对比。
			const attempt = server.attempt;
			// 捕获此时会话signal，过滤关闭后的UI写入。
			const { signal } = session;
			// 完成闭包接成功错误文字或异常转成的文字，返回void；例旧enable结果迟到时丢弃，不撤销已发生的网络/文件副作用。
			const finish = (message: string | undefined) => {
				// 会话结束、更新attempt、对象已移出任一条件成立就不更新菜单。
				if (signal.aborted || server.attempt !== attempt || !servers.includes(server)) return;
				// 保存动作结果，undefined会清掉旧message。
				server.message = message;
				// 按完成时当前配置确保发现入口可达。
				ensureDiscoveryActive(ctx);
				// 通知菜单重建，监听器异常可使此完成链拒绝。
				emitChange();
			};
			// 成功/失败都归一到finish，track的等待副本吞拒绝供shutdown；void不向菜单调用者返回后台结果。
			void track(ready.then(finish, (error: unknown) => finish(errorMessage(error))));
		};

		// 按菜单value派发动作，登录/子菜单等待、连接启停后台跑，最后更新提示；例点击reconnect立即回可刷新的菜单。未知动作也走最后清message/通知；未统一catch所有动作异常。
		const runAction = async (ui: McpUi, ctx: ExtensionContext, server: McpServer, action: string) => {
			// 捕获进入动作时会话signal，await后用来避免旧ctx更新。
			const { signal } = session;
			// 缺省undefined表示本轮不报告独立错误文字。
			let message: string | undefined;
			// switch按菜单返回的字符串路由。
			switch (action) {
				// 显式登录路径要等待交互结束。
				case "signin":
					// 保存登录/重连结果文字，取消也可能有友好文字。
					message = await signInWithUi(ui, server);
					// 结束本case，不继续匹配下面动作。
					break;
				// 手工重连不让菜单等整个网络过程。
				case "reconnect":
					// Connection state and error already report failures, including required sign-ins.
					// 启动后台async操作；这里刻意忽略reconnect返回错误文字，因为连接state/error已有展示。
					runInBackground(ctx, server, async () => {
						// 仍等实际reconnect落定，后台track才知道何时清理完成。
						await reconnect(server);
						// 完成不另设message，避免重复报同一连接错误。
						return undefined;
					});
					// 本次派发即可继续菜单循环。
					break;
				// 注销动作当前实现等待删除/断开结束。
				case "signout":
					// 忽略removed布尔值，管理页只显示状态；普通logout子命令另用它给提示。
					await signOut(server);
					// 结束注销分支。
					break;
				// 查看工具只打开只读子列表。
				case "tools":
					// 等用户关闭工具列表，不调用远端工具。
					await showTools(ui, server);
					// 回到单台菜单。
					break;
				// 暴露配置子菜单会等待用户选择。
				case "exposure":
					// 保存可能的配置写入错误文字。
					message = await chooseExposure(ui, server);
					// 结束暴露分支。
					break;
				// 下面四种动作共用启停逻辑。
				case "enable":
				// 普通禁用按原来源保存。
				case "disable":
				// 项目启用使用覆盖文件。
				case "enable-project":
				// 项目禁用同属这个块，块级const只在本case组内有效。
				case "disable-project": {
					// 前缀enable决定布尔启用状态。
					const enable = action.startsWith("enable");
					// 后缀-project决定项目范围，后台保存/关闭/启动，菜单继续可用。
					runInBackground(ctx, server, () => setEnabled(server, enable, action.endsWith("-project")));
					// 结束case组，不在这里等待操作完成。
					break;
				}
			}
			// The session ended meanwhile (for example during a sign-in), which made ctx stale.
			// 旧会话结束后不再使用旧ctx通知/改menu message。
			if (signal.aborted) return;
			// 更新本轮message；后台动作先清旧文字，之后完成回调可再写新结果。
			server.message = message;
			// 动作可能改变间接入口需要，重新检查激活。
			ensureDiscoveryActive(ctx);
			// 让订阅的菜单立即按新状态重建。
			emitChange();
		};
		// 管理双层菜单循环：总列表选服务器→单台列表选动作→执行→再选；Promise在总菜单取消时完成，内部UI/动作异常向showMcpManager传播。例单台back只退一层。
		const manage = async (ui: McpUi, ctx: ExtensionContext) => {
			// 外层持续显示总列表。
			for (;;) {
				// 订阅连接/配置变化，总列表可后台刷新并尽量保留选择。
				const name = await ui.menu(serversMenu, subscribe);
				// 取消或空名字就结束整个manage。
				if (!name) return;
				// 内层持续管理同一个原名，期间每次重新取server对象。
				for (;;) {
					// 闭包按当前名称构造单台菜单，并订阅状态更新。
					const action = await ui.menu(() => serverMenu(name), subscribe);
					// 等用户选完再定位最新对象，避免总用打开时旧对象。
					const server = findServer(name);
					// 取消或服务器已移除就回外层总列表。
					if (!action || !server) break;
					// 等待动作派发；其中后台启停/重连无需等网络全部完成。
					await runAction(ui, ctx, server, action);
				}
			}
		};

		// ---------------------------------------------------------------------------------------
		// Subcommands and plain status (no TUI)
		// ---------------------------------------------------------------------------------------

		// 生成非TUI的多行状态文字，无连接/文件操作；例disconnected说明下一次调用重连，配置错误和遮蔽报告附末尾。状态是本地快照，不是服务器实时健康检查。
		const formatStatus = (): string => {
			// 只有服务器/配置错误/遮蔽提示都空才显示无配置提示。
			if (servers.length === 0 && configErrors.length === 0 && overridden.length === 0) {
				// 返回默认配置位置，resolve不创建文件。
				return `No MCP servers configured. Add them to ${resolve(getAgentDir(), "mcp.json")} or .pi/mcp.json.`;
			}
			// 按servers当前顺序生成每台状态，不按关注权重排序。
			const lines = servers.map((server) => {
				// 取配置原名。
				const { name } = server.entry;
				// 取默认暴露方式，非每个工具实际覆盖。
				const exposure = exposureOf(server.entry);
				// 取当前连接引用。
				const connection = server.connection;
				// needs-auth分支优先，直接给登录指引，不再拼普通错误。
				if (connection?.state === "needs-auth")
					// 生成带确切原名的/mcp login提示，未在此执行命令。
					return `${name}: needs sign-in, run /mcp login ${name} (${exposure})`;
				// 只有connected才附缓存工具数量，否则不展示可能过期数量。
				const tools = connection?.state === "connected" ? `, ${connection.tools.length} tools` : "";
				// 其余情况先按配置启用性选状态。
				const state = !isEnabled(server)
					? // 禁用优先展示disabled。
						"disabled"
					: // 启用且断开时给恢复说明。
						connection?.state === "disconnected"
						? // 说明按需重连，不代表后台重连已经开始。
							"disconnected, reconnects on next call"
						: // 其他state原样显示，没有连接则starting。
							(connection?.state ?? "starting");
				// 计算单独错误后缀。
				const error =
					// 只有非空error且非connected才显示，避免旧错误混在在线状态。
					connection?.error && connection.state !== "connected"
						? // 错误每段LF缩进四空格，不裁剪或脱敏内容。
							`\n    ${connection.error.split("\n").join("\n    ")}`
						: // 没有错误则空串。
							"";
				// 合并服务器名、状态、数量、暴露方式及可选错误。
				return `${name}: ${state}${tools} (${exposure})${error}`;
			});
			// 在服务器行之后追加配置加载错误。
			for (const error of configErrors) lines.push(`config error: ${error}`);
			// 再追加被配置遮蔽的登记项说明。
			for (const line of overridden) lines.push(`overridden: ${line}`);
			// LF连接返回完整状态字符串，不在函数内通知UI。
			return lines.join("\n");
		};

		/** Resolve the server for a subcommand, asking when the name is omitted and ambiguous. */
		// 为子命令挑服务器：显式名先验证，否则合资格候选唯一/偏好唯一时自动选，其余弹选择器。返回对象或undefined，通知/UI异常可拒绝；例两台只有一台needs-auth则登录优先它，不重新检查await后的注册变化。
		const pickServer = async (
			// 可省略的原服务器名；不做模糊补全。
			name: string | undefined,
			// 命令上下文提供选择器/提示。
			ctx: ExtensionCommandContext,
			// eligible筛可操作项，preferred仅在候选中取优先项，none是无人可选的文案；函数类型不保证纯函数。
			options: { eligible: (server: McpServer) => boolean; preferred: (server: McpServer) => boolean; none: string },
		): Promise<McpServer | undefined> => {
			// 有显式非空名就不再弹候选选择。
			if (name) {
				// 查当前集合，按名称精确匹配。
				const server = findServer(name);
				// 不存在提示错误，仍走下方undefined返回。
				if (!server) ctx.ui.notify(`No MCP server named "${name}".`, "error");
				// 存在但不合资格也显示对应错误提示。
				else if (!options.eligible(server)) ctx.ui.notify(options.none, "error");
				// 再调用eligible决定返回；因此显式命中时eligible可能执行两次，应按无副作用谓词使用。
				return server && options.eligible(server) ? server : undefined;
			}
			// 没给名称时筛出合资格候选快照。
			const candidates = servers.filter(options.eligible);
			// 完全没有候选时给信息提示。
			if (candidates.length === 0) {
				// 使用选项传来的none说明，具体原因由调用方定义。
				ctx.ui.notify(options.none, "info");
				// 没有选中对象。
				return undefined;
			}
			// 只在候选中筛偏好，不让不合资格项胜出。
			const preferred = candidates.filter(options.preferred);
			// 总候选唯一就直接返回，即使不符合preferred。
			if (candidates.length === 1) return candidates[0];
			// 总候选多个但偏好唯一，也直接返回该对象。
			if (preferred.length === 1) return preferred[0];
			// 剩余歧义交宿主UI询问，取消可返回undefined。
			const choice = await ctx.ui.select(
				// 选择标题。
				"MCP server",
				// 候选以原名展示，不附状态或namespace。
				candidates.map((server) => server.entry.name),
			);
			// 在原候选快照里按结果名找对象；没选/无匹配为undefined，不在此重查当前servers。
			return candidates.find((server) => server.entry.name === choice);
		};

		// 判断当前连接是否提供独立OAuth URL，返回布尔；例auth.provider返回false。只是读包装getter，不发请求或加载凭证。
		const usesOAuth = (server: McpServer) => server.connection?.oauthUrl !== undefined;
		// 登录/注销复用的筛选策略对象，无立即操作。
		const oauthPick = {
			// 只有usesOAuth的现有连接才是候选。
			eligible: usesOAuth,
			// 优先needs-auth台，但不限定只有该状态才可登录/注销。
			preferred: (server: McpServer) => server.connection?.state === "needs-auth",
			// 实际提示文案；auth.provider同样不走独立OAuth，完整条件见runtime.oauthUrl，不仅这句文案列出的头字段。
			none: "No enabled MCP server uses OAuth. Only HTTP servers without an Authorization header do.",
		};

		// 执行已挑台的交互登录并通知结果，返回Promise<void>；例TUI显示管理页，其他有UI模式用输入对话框。无UI直接提醒，不启动浏览器；await后用会话signal过滤旧ctx，失败文字交UI。
		const loginCommand = async (server: McpServer, ctx: ExtensionCommandContext) => {
			// 捕获开始时名称用于提示。
			const { name } = server.entry;
			// hasUI=false时不尝试需要授权交互的流程。
			if (!ctx.hasUI) {
				// 发错误提示，由具体模式决定呈现方式。
				ctx.ui.notify(`Signing in to MCP server "${name}" requires interactive mode.`, "error");
				// 结束命令，不调用signIn。
				return;
			}
			// 捕获此时会话signal，登录结束后确认上下文仍可用。
			const { signal } = session;
			// 保存登录失败/取消/重连失败文字，undefined表示未报告失败。
			let failure: string | undefined;
			// TUI使用专门管理组件，其他模式用通用UI交互。
			if (ctx.mode === "tui") {
				// 等自定义管理页退出；async闭包的结果由showMcpManager转done。
				await showMcpManager(ctx, async (ui) => {
					// 在组件中跑带状态/粘贴界面的登录。
					failure = await signInWithUi(ui, server);
				});
			} else {
				// 非TUI但有UI时直接提供通用提示适配器。
				failure = await signIn(server, {
					// 授权URL生成后显示并尝试打开浏览器，同步异常沿OAuth路径处理。
					showAuthorizationUrl: (url) => {
						// 通知中展示完整授权URL，可能包含临时参数，不是日志脱敏接口。
						ctx.ui.notify(`Sign in to MCP server "${name}" in your browser:\n${url.href}`, "info");
						// 用配置打开器，未在此等待异步浏览器进程结果。
						openUrl(url.href);
					},
					// 粘贴回调把SDK提供的signal传给宿主输入框，返回其Promise。
					promptForRedirectUrl: (signal) =>
						// 通用输入支持取消，具体由宿主UI实现。
						ctx.ui.input(
							// 提示异机浏览器时粘完整回调地址。
							`Waiting for sign-in to "${name}". If the browser cannot reach this machine, paste the URL it was redirected to.`,
							// 这是占位示意地址，不是可直接访问的真实端口URL。
							"http://127.0.0.1:.../callback?code=...",
							// 信号用于取消输入；Promise是否及时完成依UI实现。
							{ signal },
						),
				});
			}
			// The session ended meanwhile, which cancelled the sign-in and made ctx stale.
			// 会话结束后不再向旧UI发登录结果。
			if (signal.aborted) return;
			// 有失败文字才进入提醒分支。
			if (failure) {
				// 仅固定取消文字用info，其余失败用error。
				ctx.ui.notify(failure, failure === "Sign-in cancelled." ? "info" : "error");
				// 失败后不再发送成功提示。
				return;
			}
			// 成功后确保间接发现入口活动。
			ensureDiscoveryActive(ctx);
			// 显示当前server.connection缓存工具数，缺连接为0；不重新探测或返回token给模型。
			ctx.ui.notify(`Signed in to MCP server "${name}" (${server.connection?.tools.length ?? 0} tools).`, "info");
		};

		// 会话启动监听器：加载配置→合并登记项→重置会话标记→激活入口→后台连接；不等待所有握手才返回。例只有codemode服务器，首prompt可先开始，实际脚本调用再等ready；加载器/同步通知异常不在此统一捕获。
		pi.on("session_start", (_event, ctx) => {
			// 注入加载器优先，否则默认读取全局和可信项目配置；同步执行。
			const loaded = (options.loadConfig ?? defaultLoadConfig)(ctx);
			// 保存配置错误用于报告，不因一个坏条目丢掉所有正确台。
			configErrors = loaded.errors;
			// 保存可信项目覆盖位置，可能undefined。
			projectConfig = loaded.projectConfig;
			// 缺设置时允许自动激活codemode。
			autoEnableCodemode = loaded.autoEnableCodemode ?? true;
			// 本轮会话重置一次性不可达提醒。
			warnedUnreachable = false;
			// 本轮第一次prompt可重新等待direct台。
			waitedForStartup = false;
			// stdio cwd/协议roots采用ctx会话目录。
			sessionCwd = ctx.cwd;
			// 后续auth.provider令牌读取采用此模型注册表。
			modelRegistry = ctx.modelRegistry;
			// 新控制器替换变量；本行不主动abort旧控制器，正常关闭流程另有session_shutdown。
			session = new AbortController();
			// 后续启动回调捕获新会话signal以识别迟到结果。
			const { signal } = session;
			// 先保存文件条目，登记合并才能按namespace判断遮蔽。
			configuredEntries = loaded.servers;
			// 读取当前扩展登记表，过滤被文件条目覆盖者。
			const registered = registeredServers();
			// 菜单/状态保留遮蔽说明。
			overridden = registered.overridden;
			// 文件台各包为{entry}再拼登记台；不复用上一轮网络包装。
			servers = [...loaded.servers.map((entry) => ({ entry })), ...registered.servers];
			// 通知订阅界面当前集合已更新。
			emitChange();
			// Codemode or tool_search is activated from the config: the first prompt does not wait for
			// servers whose tools are not declared to the model, and scripts or searches wait for them.
			// 按配置提前启用发现入口，无需等服务器提供工具列表。
			ensureDiscoveryActive(ctx);
			// 只对启用台启动连接，禁用项仍保留管理配置。
			const enabled = servers.filter(isEnabled);
			// 完全没有启用台就不加载runtime。
			if (enabled.length === 0) {
				// 仍可报告配置错误等需要注意的情况。
				reportProblems(ctx);
				// 同步监听器结束，不创建新pending；变量是否已有旧pending取决于此扩展实例历史。
				return;
			}
			// The MCP client loads only now, so sessions without servers never pay for it. Waiting one
			// event loop turn lets the first render happen before loading and connecting.
			// 先等setImmediate再import运行时，让UI先有机会渲染；Promise不是线程，也不保证某次屏幕帧一定先完成。
			const runtime = new Promise((resolve) => setImmediate(resolve)).then(() => loadMcpRuntime());
			// 为所有启用台立即登记各自ready，实际await同一runtime加载后并发连接；保存汇总pending而不await它。
			pending = Promise.all(enabled.map((server) => startConnection(server, runtime)))
				// 全部启动任务完成后生成一次问题报告。
				.then(() => {
					// 旧会话已取消则不报成功完成后的注意事项。
					if (!signal.aborted) reportProblems(ctx);
				})
				// 加载/构造等拒绝进入这里；普通协议失败已由startConnection记state吸收。
				.catch((error: unknown) => {
					// The session may have been disposed meanwhile, which makes ctx stale.
					// 过期ctx通知可能抛错，所以这里只给通知本身加保护。
					try {
						// 提示“加载失败”，错误也可能来自构造/同步回调，不在此保留异常类。
						ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
						// 空catch让通知失败不留下未处理拒绝，pending因catch正常结束。
					} catch {}
				});
		});

		// The first prompt waits for servers whose tools are declared to the model, so they are declared
		// in its first request, but not indefinitely: a slow or hanging server must not hold up the
		// prompt. Other servers are waited for when a script or search needs them (below).
		// 首prompt对配置可能direct的服务器等待最多startupWaitMs，返回void；例慢台超时后提示仍可继续，连接本身不取消。这里不传ctx.signal，也不追踪等待中新增ready，与tool_call等待策略不同。
		const waitForDirectServers = async (ctx: ExtensionContext) => {
			// 已经等过就跳过，本会话只等一次。
			if (waitedForStartup) return;
			// 先标已等，即使没有台/稍后超时也不重试等待。
			waitedForStartup = true;
			// 从当前服务器取一次ready快照。
			const ready = servers.flatMap((server) =>
				// 启用+配置可能direct+有ready才入列，不看真实工具是否已经发现。
				isEnabled(server) && hasDirectTools(server.entry) && server.ready ? [server.ready] : [],
			);
			// 没有需要等的Promise直接结束。
			if (ready.length === 0) return;
			// 保存定时器句柄，结束时清除；NodeJS.Timeout是类型。
			let timer: NodeJS.Timeout | undefined;
			// 全部ready完成与预算到期竞速。
			const finished = await Promise.race([
				// 全部任务落定映射true，连接失败已吸收的ready也算完成。
				Promise.all(ready).then(() => true),
				// 计时Promise返回boolean，不返回连接对象。
				new Promise<boolean>((resolve) => {
					// 到期resolve(false)，只结束此等待，不调用close或abort。
					timer = setTimeout(() => resolve(false), startupWaitMs);
				}),
			]);
			// 竞速完成就清计时器，避免成功后再无用触发。
			clearTimeout(timer);
			// 预算先结束时才提醒。
			if (!finished) {
				// 信息提示后继续请求准备，不阻止模型运行。
				ctx.ui.notify("MCP servers are still connecting; their tools become available once connected.", "info");
			}
		};

		// Every prompt lists the servers in the `mcp_servers` section as they are when it starts. Pi
		// appends the section to the conversation when it changed, for example after a server connected.
		// 每个用户query启动前更新MCP服务器说明段，返回Promise<void>；例握手后有instructions可补进下一query。修改的是prompt选项sections，未在此直接调用模型或重写磁盘会话。
		pi.on("before_agent_start", async (event, ctx) => {
			// 只有本会话首轮真正等待direct台，其余调用快速返回。
			await waitForDirectServers(ctx);
			// 解构取得同一sections对象引用，后面赋值会影响event中的选项。
			const { sections } = event.systemPromptOptions;
			// 按此刻配置/说明生成间接服务器段落。
			const section = renderServersSection(servers);
			// 有内容则替换命名段，其他section不变。
			if (section) sections[MCP_SERVERS_SECTION] = section;
			// 无内容则删除旧段，避免上一query残留列表。
			else delete sections[MCP_SERVERS_SECTION];
		});

		// A tool that reaches other tools (`reachesTools`) waits for the servers it may reach, so their
		// tools are registered before it runs: a codemode script for the servers it names, or for every
		// server when it searches or enumerates tools, and tool_search for every server. The resource
		// tools reach every server, so they wait for all of them. Direct MCP calls wait only for their
		// own server, including a reconnect still closing its old transport.
		// 执行工具前准备所需服务器：先看reachesTools，否则公共资源等全部，普通MCP按owner等自身；返回Promise<void>不执行工具。例脚本只提mcp__docs则粗匹配docs，取消只结束等待；后续执行器如何处理取消由宿主决定。
		pi.on("tool_call", async (event, ctx) => {
			// 按本次公开名找最新工具元数据，可能与先前准备定义不同。
			const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
			// 没登记的工具不在本扩展等待，执行错误由其他层处理。
			if (!tool) return;
			// Readiness can be pending while the display state is still connected: reconnect first
			// closes the old transport, then opens a new one. Settled promises return immediately.
			// 所有启用且有ready的台都作候选，包括已落定的ready；不能只看state是否connected。
			const readyServers = servers.filter((server) => isEnabled(server) && server.ready);
			// 没有准备任务直接结束钩子。
			if (readyServers.length === 0) return;
			// 初始化这一次要等的服务器列表。
			let waiting: McpServer[] = [];
			// reachesTools函数在此输入本次参数，可能返回all/词列表，也可能抛错；这是准备提示，不是调用审计。
			const reach = tool.reachesTools?.(event.input);
			// 若有reach，优先采用它，包含空词数组时也不会退到下面资源分支。
			if (reach !== undefined) {
				// 按namespace子串粗匹配，可能多等不真正用到的服务器。
				waiting = readyServers.filter((server) => reachesServer(reach, server.entry.name));
				// 没有reach且是公共资源工具才走全台等待。
			} else if (RESOURCE_TOOL_NAMES.has(tool.name)) {
				// 即使read_mcp_resource输入server，此实现仍等待所有候选台。
				waiting = readyServers;
			} else {
				// 普通工具从归属Map取NUL前的server原名；未知归属得到undefined。
				const owner = toolOwners.get(event.toolName)?.split("\0", 1)[0];
				// 只等待归属服务器；非MCP普通工具通常匹配不到，waiting为空。
				waiting = readyServers.filter((server) => server.entry.name === owner);
			}
			// 等最新ready并响应本次调用取消；不因某台连接失败直接判定整工具成功/失败。
			await waitForServers(waiting, ctx.signal);
		});

		// Pick up sign-ins done outside the session, such as `pi mcp login` run by the agent.
		// 每轮Agent turn开始检查外部登录变化，输入事件此处不用，返回Promise<void>；不是文件监听或轮询定时器，也不为所有在线服务器重新登录。
		pi.on("turn_start", async (_event, ctx) => {
			// 只有needs-auth基线集合非空才重读token并尝试重连。
			if (tokensAtSignIn.size > 0) await reconnectSignedIn(ctx);
		});

		// Servers registered or unregistered during the session connect or disconnect right away.
		// 登记表运行时变更监听：比较配置快照→移除旧台/隐藏工具→加入新台→先关旧再开新→报告；不重载mcp.json。例同名扩展改command就替换网络对象，没改注册快照则保留当前菜单覆盖。
		pi.on("mcp_servers_change", async (_event, ctx) => {
			// 捕获变更开始时会话signal。
			const { signal } = session;
			// 启动前/已关闭会话不处理动态事件，下一session_start会读登记表。
			if (signal.aborted) return;
			// 重新取宿主登记表并执行文件配置优先规则。
			const registered = registeredServers();
			// 遮蔽报告更新，不一定伴随真实服务器变化。
			overridden = registered.overridden;
			// 按原名建立当前登记Map，便于与旧会话对象的registeredConfig比较。
			const next = new Map(registered.servers.map((server) => [server.entry.name, server]));
			// Unregistered servers and re-registered ones with a new config are dropped; the latter come back below.
			// 从现有会话台中找出应移除的扩展来源项。
			const removed = servers.filter(
				// 每项执行下面两个条件的合取。
				(server) =>
					// 只对scope=extension比较，文件台不因注册表变化被删除。
					server.entry.scope === "extension" &&
					// 登记消失或JSON快照变化都移除；JSON键顺序差也可能导致变化。
					next.get(server.entry.name)?.registeredConfig !== server.registeredConfig,
			);
			// 先从集合删除，旧isCurrent回调的includes检查因而失效。
			servers = servers.filter((server) => !removed.includes(server));
			// 隐藏旧工具；定义/owner缓存继续保留供历史显示/重用。
			for (const server of removed) hideTools(server.entry.name);
			// 剩余集合里没有同名台才视为新增，变更配置的台也会在这里重新加入。
			const added = registered.servers.filter((server) => !findServer(server.entry.name));
			// 追加新会话对象，尚未建连接。
			servers.push(...added);
			// 通知菜单先显示当前集合。
			emitChange();
			// 新增配置可能要求激活codemode/tool_search。
			ensureDiscoveryActive(ctx);
			// 等待被移除台的包装close；这在下面try外，关闭异常会拒绝整个事件处理。这里没统一等待这些台的所有独立ready/background动作。
			await Promise.all(removed.map((server) => server.connection?.close()));
			// 新台仅启用者需要网络连接。
			const connecting = added.filter(isEnabled);
			// 关闭期间会话结束或无需连接就结束。
			if (signal.aborted || connecting.length === 0) return;
			// 只将新连接启动阶段的异常转UI提示。
			try {
				// 并行startConnection，每台新Symbol过滤旧异步结果；普通协议失败记状态后吸收。
				await Promise.all(connecting.map((server) => startConnection(server)));
				// 等待期间会话可能关闭，需要补清理新建包装。
				if (signal.aborted) {
					// 逐一尽力调用其close，但Promise.all仍会在close拒绝时拒绝。
					await Promise.all(connecting.map((server) => server.connection?.close()));
					// 补清理后不再向旧ctx报告问题。
					return;
				}
				// 加载/构造/上面清理异常进此catch。
			} catch (error) {
				// 直接通知，没有像session_start的catch一样再包通知异常。
				ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
				// 出现该错误后不再reportProblems。
				return;
			}
			// 正常准备结束也先检查旧会话是否已取消。
			if (signal.aborted) return;
			// 只报告本次新增连接的failed/needs-auth，不重复配置错误。
			reportProblems(ctx, connecting);
		});

		// 会话关闭监听：先abort旧signal、摘当前列表并通知，再等已跟踪后台任务和当前连接关闭；返回Promise<void>。例关闭时OAuth刷新会由runtime等落盘，不等于远端revoke或自动取消一切Promise。
		pi.on("session_shutdown", async () => {
			// 通知协作任务/旧isCurrent失效，不会强制停止任意用户回调。
			session.abort();
			// 删除列表前取连接快照，否则后面无法从servers找到它们。
			const closing = connections();
			// 立即清服务器列表，之后旧回调的includes也不通过。
			servers = [];
			// 通知管理菜单变空；监听器抛错会打断后续清理，没有统一隔离。
			emitChange();
			// 并行等待当前快照的后台任务和连接close；后续才加入集合的任务不会自动补入此Promise.all，任一拒绝仍可导致本监听拒绝。
			await Promise.all([...backgroundActions, ...closing.map((connection) => connection.close())]);
		});

		// 登记/mcp命令及补全回调；注册本身不打开界面，命令handler执行才进入管理/状态/登录等流程。
		pi.registerCommand("mcp", {
			// 命令描述用于帮助界面，字符串保留原文。
			description: "Manage MCP servers: sign in, reconnect, enable or disable, and change exposure",
			// 按输入前缀返回补全项数组或null，纯读取当前状态不执行命令；例"lo"补login/logout，server前缀大小写敏感，不支持引号包空格名称。
			getArgumentCompletions: (prefix) => {
				// trimStart保留末尾空白，因此"login "会得到空server前缀并进入服务器补全；rest是剩余参数数组。
				const [action, server, ...rest] = prefix.trimStart().split(/\s+/);
				// 超过动作+服务器两个词就不给补全。
				if (rest.length > 0) return null;
				// 尚未输入第二段则只补动作。
				if (server === undefined) {
					// 可补三个合法子命令。
					return (
						["login", "logout", "reconnect"]
							// 用startsWith做前缀匹配，缺action回空串匹配全部。
							.filter((item) => item.startsWith(action ?? ""))
							// value尾部带空格让下一步输入服务器；label只显示动作。
							.map((item) => ({ value: `${item} `, label: item }))
					);
				}
				// 非法动作没有服务器补全。
				if (action !== "login" && action !== "logout" && action !== "reconnect") return null;
				// 从当前服务器集合计算候选。
				const items = servers
					// 按子命令筛可操作台。
					.filter((candidate) =>
						// reconnect只要有包装，login/logout则要求独立OAuth，不主动验证远端在线。
						action === "reconnect" ? candidate.connection !== undefined : usesOAuth(candidate),
					)
					// 按原服务器名的大小写敏感前缀匹配。
					.filter((candidate) => candidate.entry.name.startsWith(server))
					// 将候选映射为带说明的补全项。
					.map((candidate) => ({
						// value为完整“动作 名字”，不在这里执行。
						value: `${action} ${candidate.entry.name}`,
						// 显示标签仅服务器名。
						label: candidate.entry.name,
						// 说明取本地状态，可能正在connecting。
						description: describeState(candidate),
					}));
				// 无匹配返回null，由宿主决定如何展示无补全。
				return items.length > 0 ? items : null;
			},
			// 执行/mcp参数：空参数开TUI管理页/普通状态，其他分派子命令，返回Promise<void>；例/mcp logout docs删除本地状态。参数按空白拆，不运行shell；配置/关闭等未处理异常由宿主命令层处理。
			handler: async (args, ctx) => {
				// trim+split+filter去掉首尾/多空白，解构action/name/其余；不是带引号的命令行解析器。
				const [action, name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
				// 完全无参数进入总管理/状态路径。
				if (action === undefined) {
					// 仅mode=tui直接开管理界面，不先等全部启动连接，界面订阅可看后台进展。
					if (ctx.mode === "tui") await showMcpManager(ctx, (ui) => manage(ui, ctx));
					else {
						// 其他模式先等启动汇总，可能比首prompt预算更久，未在此设置超时/取消。
						await pending;
						// 将完整状态以info交UI；具体非TUI输出由宿主决定。
						ctx.ui.notify(formatStatus(), "info");
					}
					// 空参数处理完毕，不落到子命令。
					return;
				}
				// 两个以上参数是语法错误。
				if (extra.length > 0) {
					// 只提示用法，不尝试猜用户想指哪台。
					ctx.ui.notify(MCP_USAGE, "warning");
					// 错误参数时结束。
					return;
				}
				// 合法词数下的任意子命令先等启动pending，即使最终动作名非法也会先等。
				await pending;
				// 按动作字符串分派，不将名字当函数动态执行。
				switch (action) {
					// 登录子命令使用OAuth候选策略。
					case "login": {
						// 名字可省略，歧义时让用户选。
						const server = await pickServer(name, ctx, oauthPick);
						// 选中台才进入交互登录，取消选择不登录。
						if (server) await loginCommand(server, ctx);
						// 结束子命令。
						return;
					}
					// 注销也使用独立OAuth候选，不注销pi供应商账户。
					case "logout": {
						// 解析/选择目标台。
						const server = await pickServer(name, ctx, oauthPick);
						// 没有选中就结束。
						if (!server) return;
						// 删本地凭证并断开，返回是否有记录被删。
						const removed = await signOut(server);
						// 根据删除结果通知，而不是根据远端token是否已经失效。
						ctx.ui.notify(
							// removed是存储helper返回的布尔值。
							removed
								? // 删到记录提示已退出。
									`Signed out of MCP server "${server.entry.name}".`
								: // 没删到记录提示原来就没有；前面的signOut仍尝试断开显示needs-auth。
									`No stored credentials for MCP server "${server.entry.name}".`,
							// 两种正常注销结果均info。
							"info",
						);
						// 结束注销子命令。
						return;
					}
					// 手工重连使用另一套候选偏好。
					case "reconnect": {
						// 有原名按名找，没有则唯一/偏好唯一/弹选择器。
						const server = await pickServer(name, ctx, {
							// 有包装对象即可候选，不要求当前connected或enabled字段再次为true。
							eligible: (candidate) => candidate.connection !== undefined,
							// 偏好函数只在合资格候选中筛。
							preferred: (candidate) =>
								// 失败/掉线优先于在线或needs-auth台，但多个偏好仍要选择。
								candidate.connection?.state === "failed" || candidate.connection?.state === "disconnected",
							// 没有候选的实际提示文案。
							none: "No enabled MCP server to reconnect.",
						});
						// 取消/无目标就结束。
						if (!server) return;
						// 排队等待该台前ready后重连，并拿失败文字。
						const failure = await reconnect(server);
						// 失败独立发error。
						if (failure) ctx.ui.notify(failure, "error");
						else {
							// 成功后确保间接入口可用。
							ensureDiscoveryActive(ctx);
							// 通知本次重连完成。
							ctx.ui.notify(
								// 附当前状态/工具数，复用describeState格式。
								`Reconnected to MCP server "${server.entry.name}" (${describeState(server)}).`,
								// 成功通知info。
								"info",
							);
						}
						// 重连分支结束。
						return;
					}
					// 其他子命令名仅显示用法。
					default:
						// warning提示参数不受支持，无网络修复操作。
						ctx.ui.notify(MCP_USAGE, "warning");
				}
			},
		});
	};
}

// 默认加载器读取agent目录和会话cwd下配置，传项目信任判断，返回已解析LoadedMcpConfig；例未信任项目不采纳项目台。这里不建立连接，读取/校验细节由loadMcpConfig负责。
function defaultLoadConfig(ctx: ExtensionContext): LoadedMcpConfig {
	// 先求目录/cwd/信任值再调用配置层；信任来自上下文，不在这里依据路径名猜测。
	return loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
}

// 模块默认导出预建扩展工厂，未传选项使用默认依赖；导入本模块只创建工厂，宿主执行它才登记事件和命令。
export default createMcpExtension();
