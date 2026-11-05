// 处理独立的pi mcp子命令，不启动Agent聊天：add/remove写配置，list实际连接检查，login浏览器授权，logout删本地凭据；返回退出码给外层CLI，不在这里process.exit。
/**
 * `pi mcp`: add, remove, and check MCP servers and sign in to them outside a session. Agents run it
 * through bash to configure servers, verify an `mcp.json` they wrote, and start an OAuth sign-in;
 * the user only approves access in the browser. Running sessions pick up new credentials on their
 * next turn.
 */

// 只用于检查项目配置是否存在，文件真正读写在config helper。
import { existsSync } from "node:fs";
// 按平台拼全局/项目路径，不手写安装资产路径。
import { join } from "node:path";
// Promise版readline用于终端粘贴授权回调URL。
import { createInterface } from "node:readline/promises";
// chalk仅给帮助/提示加ANSI样式，不控制授权。
import chalk from "chalk";
// 名称和配置目录从统一入口读取，支持品牌/安装布局。
import { APP_NAME, CONFIG_DIR_NAME } from "../../config.ts";
// 保存前校验服务器配置，返回错误string或规范对象。
import { validateMcpServerConfig } from "../../core/mcp-servers.ts";
// 查询项目信任，不由mcp list/login自己授信。
import { ProjectTrustStore } from "../../core/trust-manager.ts";
// 缺省授权打开器，实际启动系统浏览器；测试可注入替身。
import { openBrowser } from "../../utils/open-browser.ts";
// 配置读写和逐工具暴露复用同一模块。
import {
	// 添加/替换一项配置，不连接。
	addMcpServerConfig,
	// 查询某工具最终暴露策略供列表展示。
	getMcpToolExposure,
	// 加载结果纯类型。
	type LoadedMcpConfig,
	// 顺序合并全局和可信项目配置。
	loadMcpConfig,
	// 带来源的服务器声明类型。
	type McpServerEntry,
	// 删一项配置，不撤销已运行进程/认证。
	removeMcpServerConfig,
} from "./config.ts";
// runtime层管理实际连接/认证生命周期，不在本模块重写协议。
import {
	// 实际构造stdio或HTTP传输。
	createDefaultTransport,
	// 认证存储类，默认目录来自其内部getAgentDir，而非自动用本options.agentDir。
	McpOAuthCredentialStore,
	// 服务器连接类，构造后仍要getClient才真正连接。
	McpServerConnection,
	// 将服务器通知写日志的对象。
	McpServerLog,
	// 授权取消专用Error类供instanceof分流。
	McpSignInCancelledError,
	// 打开本地回调监听并执行授权流程的函数。
	signInMcpServer,
} from "./runtime.ts";

// 帮助为真实多行模板字符串，包含品牌名和转义后的${NAME}示例；仅在字符串外加注释，避免改变CLI输出。
const HELP = `${chalk.bold("Usage:")}
  ${APP_NAME} mcp add <server> [options] -- <command> [args...]
  ${APP_NAME} mcp add <server> [options] --url <url>
  ${APP_NAME} mcp remove <server> [-l]
  ${APP_NAME} mcp list [--json]
  ${APP_NAME} mcp login <server> [-l] [--timeout <seconds>]
  ${APP_NAME} mcp logout <server> [-l]

Configure and check MCP servers and sign in to OAuth servers without starting a session.
Reads ~/${CONFIG_DIR_NAME}/agent/mcp.json and, in trusted projects, ${CONFIG_DIR_NAME}/mcp.json.

Commands:
  add <server>            Add or replace a server in mcp.json
  remove <server>         Remove a server from mcp.json
  list                    Show state, tools, and errors (exits 1 on failure)
  login <server>          Sign in through the browser
  logout <server>         Delete the stored OAuth credentials

Options for add, remove, login, and logout:
  -l, --local             Use ${CONFIG_DIR_NAME}/mcp.json in the current project instead of the global file

Options for add:
  --url <url>             Streamable HTTP server URL (instead of a command)
  --env <KEY=VALUE>       Environment variable for a stdio server (repeatable)
  --cwd <dir>             Working directory for a stdio server
  --header <KEY=VALUE>    HTTP header (repeatable)
  --bearer-token-env-var <NAME>
                          Send "Authorization: Bearer \${NAME}"
  --oauth-client-id <id>  Pre-registered OAuth client id
  --oauth-client-secret <secret>
                          OAuth client secret (may be \${NAME} or !command)
  --oauth-callback-port <port>
                          Fixed OAuth callback port
  --oauth-client-name <name>
                          Client name sent when registering with the OAuth server
  --oauth-client-registration <mode>
                          auto (default), cimd, or dcr
  --exposure <mode>       codemode (default), deferred, direct, or hidden
  --description <text>    What the server offers, shown in the system prompt

Other options:
  --json                  Print the list as JSON
  --timeout <seconds>     Time limit for the whole sign-in (default: 300)`;

// 固定简短帮助提示，dim只是样式；常量在模块加载时构造。
const HELP_HINT = chalk.dim(`Use "${APP_NAME} mcp --help" for usage.`);

// 授权阶段默认300秒，不是整个命令（含首次连接/重连）的硬截止。
const DEFAULT_LOGIN_TIMEOUT_SECONDS = 300;

// 外层CLI提供的运行目录、存储和显示注入接口；这些类型自己不执行网络或校验值。
export interface McpCommandOptions {
	// MCP服务器运行/项目信任所用cwd，不修改process.cwd。
	cwd: string;
	// 全局mcp.json与mcp.log路径基准；默认凭据类另用getAgentDir。
	agentDir: string;
	/** Defaults to `mcp-auth.json` in the agent directory. */
	// 可注入认证存储；未给时构造默认用户代理目录的存储。
	credentials?: McpOAuthCredentialStore;
	/** Defaults to the platform browser. */
	// 授权URL回调，缺省系统浏览器；显式注入也会关闭下面终端粘贴路径。
	openUrl?: (url: string) => void;
	/** Defaults to console output. */
	// 普通输出回调，默认console.log。
	log?: (line: string) => void;
	// 错误输出回调，默认console.error，不保证异常文字已脱敏。
	error?: (line: string) => void;
}

// list生成的单服务器快照，不是活的连接对象。
interface ServerReport {
	// 服务器名。
	name: string;
	// 展示来源范围，string没有严格绑定三种字面量。
	scope: string;
	// 定义来源路径。
	source: string;
	/** Project `mcp.json` that overrides `enabled`, `exposure`, or `toolExposure` of this global server. */
	// 可选项目覆盖文件路径。
	override?: string;
	// 只有显式enabled:false才停用。
	enabled: boolean;
	// 服务级展示策略，单工具覆盖另列。
	exposure: string;
	// URL或命令拼接展示文字，不是可安全复制执行的shell转义串。
	transport: string;
	// 连接状态文字，close后仍保留报告构建时的快照。
	state: string;
	// 服务器原工具名数组，未清理成mcp__前缀。
	tools: string[];
	/** Tools whose exposure differs from the server's, from `toolExposure`. */
	// 只列和服务级策略不同的单工具项。
	toolExposure?: Record<string, string>;
	/** Whether the server offers resources. They are not listed: listing every one can take long. */
	// 有资源能力时才出现true，不会枚举每个资源。
	resources?: true;
	// 可选连接错误文字。
	error?: string;
}

// 把任意抛出值转显示字符串，无记录/上传副作用；例：Error取message，抛数字则String。自定义转换仍可能抛，不保证脱敏。
function errorMessage(error: unknown): string {
	// instanceof用于unknown边界区分Error，而非校验已类型保证的值。
	return error instanceof Error ? error.message : String(error);
}

// 生成传输展示文字，返回string；例：stdio命令与args空格相连。不是shell转义，不解析env/!命令，HTTP URL可能含配置中的敏感部分。
function describeTransport(entry: McpServerEntry): string {
	// 解构读取传输配置。
	const { config } = entry;
	// in按url属性存在性收窄；stdio展开缺省空参数数组后join，原参数边界在展示中不可还原。
	return "url" in config ? config.url : [config.command, ...(config.args ?? [])].join(" ");
}

// 创建连接对象、日志对象及惰性认证回调，不主动getClient或读取存储token；例：list随后getClient才连接。构造中的URL/身份计算等错误直接传播，日志位置按options.agentDir。
function createConnection(entry: McpServerEntry, options: McpCommandOptions, credentials: McpOAuthCredentialStore) {
	// new建立一个连接生命周期对象。
	return new McpServerConnection({
		// 原entry共享引用。
		entry,
		// 传选项cwd给stdio/root能力。
		cwd: options.cwd,
		// 真实传输工厂，选择HTTP或子进程。
		createTransport: createDefaultTransport,
		// 传已有凭据存储，不在每个连接重新new。
		credentials,
		// 独立日志对象写到所选agentDir；不是把stderr混进stdout JSON。
		log: new McpServerLog(join(options.agentDir, "mcp.log")),
		// 工具发现回调为空，CLI不把工具注册进Agent。
		onTools: () => {},
	});
}

/** Short spellings of options. `-l`/`--local` match `pi install`. */
// Map只接受-l这个短别名；没有自动展开任意短参数组合。
const OPTION_ALIASES = new Map([["-l", "--local"]]);

// 参数解析结果，三类数据分开以保留重复项顺序。
interface ParsedOptions {
	// 位置参数数组，后段可为子命令原argv。
	positional: string[];
	// 普通flag存true，带值选项存string；两者组成联合。
	values: Map<string, string | true>;
	/** Values of `list` options, in order. */
	// 可重复选项按出现顺序存数组，例如多个--header。
	lists: Map<string, string[]>;
}

/**
 * Parse `--name value` options; returns undefined and reports unknown ones. `--` ends the options,
 * as does reaching `maxPositionals` positional arguments: the remaining arguments are positional,
 * so a command's own options (`add <server> <command> --flag`) are passed through.
 */
// 单次扫描argv解析已知选项，返回分组或undefined并调用error；例：add到第二个位置参数即停止解析，让命令自己的--flag透传。只支持--name value，不拆--name=value；不执行任何命令，输出回调异常会传播。
function parseOptions(
	// 已去掉mcp子命令名字的参数数组，不修改原数组。
	args: string[],
	// Record给选项种类做编译约束，运行时仍是普通对象属性表。
	known: Record<string, "flag" | "value" | "list">,
	// 诊断输出回调，返回void。
	error: (line: string) => void,
	// 默认Infinity永不限位置数，add显式用2。
	maxPositionals = Number.POSITIVE_INFINITY,
): ParsedOptions | undefined {
	// 新位置数组。
	const positional: string[] = [];
	// Map收普通选项，重复同名以后值覆盖。
	const values = new Map<string, string | true>();
	// 另一个Map收可重复选项。
	const lists = new Map<string, string[]>();
	// index可在带值选项里额外++跳过下一项。
	for (let index = 0; index < args.length; index++) {
		// typed保留用户原拼写，便于报错。
		const typed = args[index];
		// 短别名查Map，没别名回原字符串。
		const arg = OPTION_ALIASES.get(typed) ?? typed;
		// 遇--或达到位置数上限就把后续全交目标命令。
		if (arg === "--" || positional.length >= maxPositionals) {
			// --分隔符自身丢掉；达到上限则当前参数也保留，slice生成新数组再展开。
			positional.push(...args.slice(arg === "--" ? index + 1 : index));
			// 停止扫描，后续目标命令的--xxx不再当本CLI选项。
			break;
		}
		// 不以--开始的都当位置项，未识别短参数如-x也属此类。
		if (!arg.startsWith("--")) {
			// 保存规范化过的arg。
			positional.push(arg);
			// 继续下一项，不从后面消费值。
			continue;
		}
		// 去两个开头短横线获得键名。
		const name = arg.slice(2);
		// 普通属性访问，不是hasOwn；沿用known表继承属性行为。
		const kind = known[name];
		// 假值kind视为未知选项。
		if (!kind) {
			// 报错保留用户原typed，包括-l。
			error(`Unknown option ${typed}.\n${HELP_HINT}`);
			// undefined让调用方返回退出码1，不在这里throw。
			return undefined;
		}
		// flag不读取下一项。
		if (kind === "flag") {
			// 统一用true表示出现。
			values.set(name, true);
			// 继续扫描。
			continue;
		}
		// 前置++先移动到下一项再读取；即使下项以--开头也可被当值。
		const value = args[++index];
		// 只有真正缺项才报“需要值”，空串值允许。
		if (value === undefined) {
			// 用规范arg显示缺值。
			error(`${arg} needs a value.`);
			// 结束解析失败。
			return undefined;
		}
		// list选项追加新数组；??允许第一次从空数组开始，不覆盖前值。
		if (kind === "list") lists.set(name, [...(lists.get(name) ?? []), value]);
		// 其余种类按普通单值保存，重复覆盖。
		else values.set(name, value);
	}
	// 对象属性简写返回三组状态。
	return { positional, values, lists };
}

/** Run `pi mcp <args>` and return the exit code. */
// 分发pi mcp独立命令并返回退出码Promise；例：add写配置不测试连接，list会并发实际连接。只有选定路径把错误转1，存储/输出等其他异常仍可能拒绝，不保证任意坏配置都只返回数字。
export async function runMcpCommand(args: string[], options: McpCommandOptions): Promise<number> {
	// 注入log优先，否则闭包调用console.log，实际使用时才输出。
	const log = options.log ?? ((line: string) => console.log(line));
	// 同理选择error输出。
	const error = options.error ?? ((line: string) => console.error(line));
	// 数组解构取首命令，其余rest复制成新数组。
	const [command, ...rest] = args;
	// 无命令/help或argv任意位置含--help/-h都直接帮助；包括--后目标程序的同名参数也会触发这个前置判断。
	if (command === undefined || command === "help" || args.includes("--help") || args.includes("-h")) {
		// 只输出已构造帮助。
		log(HELP);
		// 建议退出码0，不运行配置读写/网络。
		return 0;
	}

	// 计算项目配置路径，不意味着已信任项目。
	const projectConfig = join(options.cwd, CONFIG_DIR_NAME, "mcp.json");
	// add/remove先分发，不先读所有配置或凭据。
	if (command === "add" || command === "remove") {
		// 三元表达式选择两个同步辅助结果，async入口会包装它。
		return command === "add"
			? // 添加带当前路径和显示函数。
				add(rest, projectConfig, options, log, error)
			: // 删除带相同环境。
				remove(rest, projectConfig, options, log, error);
	}
	// 信任库必须显式true；不在这里询问或自动改变信任。
	const projectTrusted = new ProjectTrustStore(options.agentDir).get(options.cwd) === true;
	// 根据这份信任结果加载声明及诊断。
	const loaded = loadMcpConfig({ agentDir: options.agentDir, cwd: options.cwd, projectTrusted });
	// 为被忽略项目构造可选说明。
	const untrustedNote =
		// 仅未信任而项目文件存在时给提示。
		!projectTrusted && existsSync(projectConfig)
			? // 提示用户正常启动Pi去授信，此语句不会授信。
				`${projectConfig} is ignored because the project is not trusted. Start ${APP_NAME} in the project to trust it.`
			: // 其他情况不添说明。
				undefined;
	// 缺省凭据存储内部用getAgentDir，并非options.agentDir自动覆写；构造不等于已开始登录。
	const credentials = options.credentials ?? new McpOAuthCredentialStore();

	// 按首命令分支处理。
	switch (command) {
		// list只认json选项。
		case "list": {
			// flag解析器不会把--json后内容当任意过滤条件。
			const parsed = parseOptions(rest, { json: "flag" }, error);
			// 解析失败返回1。
			if (!parsed) return 1;
			// list不允许位置参数。
			if (parsed.positional.length > 0) {
				// 多余参数显示用法。
				error(`Usage: ${APP_NAME} mcp list [--json]\n${HELP_HINT}`);
				// 不建立连接就结束。
				return 1;
			}
			// list返回Promise，async入口自动等待其结果；has(json)检测是否出现flag。
			return list(loaded, parsed.values.has("json"), untrustedNote, options, credentials, log);
		}
		// login/logout共用名字/范围/服务器选择。
		case "login":
		case "logout": {
			// 两者参数规则有一项差别。
			const parsed = parseOptions(
				// 输入rest。
				rest,
				// login还认timeout带值，logout只认local。
				command === "login" ? { local: "flag", timeout: "value" } : { local: "flag" },
				// 共用错误输出。
				error,
			);
			// 参数解析失败返回1。
			if (!parsed) return 1;
			// 取服务器名并收集额外位置参数。
			const [name, ...extra] = parsed.positional;
			// 名字必须非空且不能额外参数。
			if (!name || extra.length > 0) {
				// 该用法文字未列timeout，不代表解析器不接受login timeout。
				error(`Usage: ${APP_NAME} mcp ${command} <server> [-l]\n${HELP_HINT}`);
				// 退出1。
				return 1;
			}
			// 按原名字精确find，不做大小写忽略。
			const entry = loaded.servers.find((server) => server.name === name);
			// 没有所配服务器才尝试拼写建议。
			if (!entry) {
				// 收集所有已加载服务器名，坏配置未进入列表。
				const names = loaded.servers.map((server) => server.name);
				// 取第一个编辑距离<=2者，不保证全列表距离最小。
				const suggestion = names.find((candidate) => editDistance(candidate, name) <= 2);
				// 错误多段模板一次输出。
				error(
					// 可附建议、未信任项目提醒及已配名字，没有自动选择建议服务器。
					`No MCP server named "${name}".${suggestion ? ` Did you mean "${suggestion}"?` : ""}${untrustedNote ? ` ${untrustedNote}` : ""} Configured: ${names.join(", ") || "none"}.`,
				);
				// 未找到就结束。
				return 1;
			}
			// --local只允许entry.scope恰为project，项目覆盖全局仍保留scope=global，因此也会拒绝该过滤。
			if (parsed.values.has("local") && entry.scope !== "project") {
				// 说明定义来源，用户可去掉local。
				error(`MCP server "${name}" is defined in ${entry.source}, not in the project; omit --local.`);
				// 结束，无认证操作。
				return 1;
			}
			// 构造连接能力，尚未getClient。
			const connection = createConnection(entry, options, credentials);
			// oauthUrl只有HTTP且没有Authorization头/auth供应商复用时才可用。
			const url = connection.oauthUrl;
			// 没有OAuth URL就不能用此login/logout。
			if (!url) {
				// 原错误文案简写HTTP无Authorization，实际还排除了auth.provider，由runtime决定。
				error(`MCP server "${name}" does not use OAuth. Only HTTP servers without an Authorization header do.`);
				// 直接返回，不在这条分支显式close构造对象，未主动连接。
				return 1;
			}
			// logout只改本地存储，不去远端撤销授权。
			if (command === "logout") {
				// 按名字+URL移除存储及可接管旧记录，文件/锁错误可直接抛。
				const removed = credentials.remove(name, url);
				// 是否原有凭据只影响提示，不影响退出码。
				log(removed ? `Signed out of MCP server "${name}".` : `No stored credentials for MCP server "${name}".`);
				// 无记录也返回0。
				return 0;
			}
			// 将用户文字转number，缺省300；Number允许小数和指数格式。
			const timeout = Number(parsed.values.get("timeout") ?? DEFAULT_LOGIN_TIMEOUT_SECONDS);
			// 要求有限且>0，没要求整数或计时器可表示的最大值。
			if (!Number.isFinite(timeout) || timeout <= 0) {
				// 报时限非法。
				error("--timeout must be a positive number of seconds.");
				// 不进入授权。
				return 1;
			}
			// 这层finally保证下面login调用完成/抛错后都尝试close。
			try {
				// 秒转毫秒交login，只覆盖它内部授权阶段，不包括首次连接/最终重连。
				return await login(entry, connection, url, timeout * 1000, options, credentials, log, error);
				// 即使login返回1也会执行。
			} finally {
				// 等待关闭实际传输及认证写入；close异常可覆盖原退出码。
				await connection.close();
			}
		}
		// 其他名字返回未知命令。
		default:
			// 输出文字，不抛新的Error。
			error(`Unknown mcp command "${command}".\n${HELP_HINT}`);
			// 建议退出1。
			return 1;
	}
}

/** Levenshtein distance, to suggest a configured server name for a mistyped one. */
// 计算两个名字的Levenshtein编辑距离，返回最少增删替换次数；例：docs与doc为1。按UTF-16码元算，用两行数组节省空间，不排序候选或忽略大小写，无I/O。
function editDistance(a: string, b: string): number {
	// 上一行初始为空a到b各前缀的距离0..b.length，回调第二参数index是下标。
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	// 逐个增加a前缀长度。
	for (let i = 1; i <= a.length; i++) {
		// 本行首格是a前缀变空串需要删除i次。
		const current = [i];
		// 扫描b各前缀。
		for (let j = 1; j <= b.length; j++) {
			// 三项分别为删除、插入、相同/替换；取最小作为本格。
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		// 本轮current成为下一轮previous，let允许更换数组引用。
		previous = current;
	}
	// 取最终整串距离，a空串时直接用初始化行。
	return previous[b.length];
}

/** Parse `KEY=VALUE` pairs of a repeatable option into a record. */
// 把重复KEY=VALUE选项转字符串字典，返回对象或undefined并报错；例：B=x=y保留值x=y，重复KEY后者覆盖。只拆首个=，不trim/验证头名环境名，不解析变量/执行命令；输出回调可抛。
function parsePairs(option: string, pairs: string[] | undefined, error: (line: string) => void) {
	// 没传选项返回空对象，传[]也会得到空对象。
	if (!pairs) return {};
	// 普通对象作为结果，不是Map/无原型字典。
	const record: Record<string, string> = {};
	// 按出现顺序处理。
	for (const pair of pairs) {
		// indexOf只找第一处等号，未找到为-1。
		const separator = pair.indexOf("=");
		// 等号必须在首字符之后，拒绝缺=或空名字。
		if (separator <= 0) {
			// 报错原pair可能含敏感文字，不在此脱敏。
			error(`--${option} expects KEY=VALUE, got "${pair}".`);
			// 整组解析失败，不返回已部分积累的对象。
			return undefined;
		}
		// slice取键和完整剩余值，允许空值；计算属性赋值沿用普通对象语义。
		record[pair.slice(0, separator)] = pair.slice(separator + 1);
	}
	// 返回新字典，无I/O。
	return record;
}

// 解析add参数、校验单台声明并写入所选mcp.json，返回退出码；例：add docs --url https://example/mcp仅保存，不测试连接/登录，也不执行npx。文件写入失败转换1，输出/信任查询等其他异常仍可抛。
function add(
	// add后的argv。
	args: string[],
	// 预先计算的项目文件路径。
	projectConfig: string,
	// 目录/显示/认证选项，本路径主要用agentDir/cwd。
	options: McpCommandOptions,
	// 成功提示输出。
	log: (line: string) => void,
	// 参数/写盘错误输出。
	error: (line: string) => void,
): number {
	// 为参数失败构造一段帮助文字，模板里的反斜杠n会在字符串中产生真正的LF换行。
	const usage = `Usage: ${APP_NAME} mcp add <server> [options] (--url <url> | -- <command> [args...])\n${HELP_HINT}`;
	// 使用通用解析器，限制位置项数。
	const parsed = parseOptions(
		// 保留原argv。
		args,
		// 当前子命令支持的选项种类表。
		{
			// local是无值标记。
			local: "flag",
			// url要一个文字值。
			url: "value",
			// env可重复。
			env: "list",
			// cwd只有一个值，重复后者覆盖。
			cwd: "value",
			// header可重复。
			header: "list",
			// 此参数接环境变量名，保存时生成Bearer变量引用。
			"bearer-token-env-var": "value",
			// 预注册OAuth client id。
			"oauth-client-id": "value",
			// client secret可为配置表达式，本函数不执行。
			"oauth-client-secret": "value",
			// 回调端口先是文字，构造配置时Number，核心校验整数范围。
			"oauth-callback-port": "value",
			// 动态注册客户端名。
			"oauth-client-name": "value",
			// 注册策略auto/cimd/dcr由核心验证。
			"oauth-client-registration": "value",
			// 暴露策略由核心验证。
			exposure: "value",
			// 描述文字可空，核心只检查string。
			description: "value",
		},
		// 统一错误回调。
		error,
		// 两个位置项是服务器名与可执行程序；之后其余参数全部透传目标程序。
		2,
	);
	// 解析失败返回1，无写盘。
	if (!parsed) return 1;
	// 解构解析结果，都是本次新集合。
	const { positional, values, lists } = parsed;
	// 第一个位置项为服务器名，其余为目标命令argv。
	const [name, ...command] = positional;
	// url从普通选项Map读，静态联合还含true。
	const url = values.get("url");
	// 要求URL与命令二选一：两者都没给或都给就拒绝；名字还须非空。
	if (!name || (url === undefined) === (command.length === 0)) {
		// 只打印用法，不修改文件。
		error(usage);
		// 退出1。
		return 1;
	}
	// 局部value帮助函数取某个字符串选项；例：缺--cwd返回undefined，不把flag true伪装成字符串。
	const value = (option: string) => {
		// 按名字读联合值。
		const found = values.get(option);
		// 实际缩小string|true|undefined，字符串才返回。
		return typeof found === "string" ? found : undefined;
	};
	// 稍后给两种传输共用暴露字段。
	const exposure = value("exposure");
	// 列出只能用于HTTP的选项，避免误把认证配置塞给stdio。
	const httpOnly = [
		// HTTP请求头。
		"header",
		// Bearer变量引用。
		"bearer-token-env-var",
		// OAuth client id。
		"oauth-client-id",
		// OAuth secret。
		"oauth-client-secret",
		// OAuth回调端口。
		"oauth-callback-port",
		// OAuth客户端名。
		"oauth-client-name",
		// OAuth注册方式。
		"oauth-client-registration",
	];
	// 仅stdio支持env/cwd。
	const stdioOnly = ["env", "cwd"];
	// 按当前是否给url选择“不能用”的另一组字段。
	const misplaced = (url === undefined ? httpOnly : stdioOnly).find(
		// 同时查单值Map和重复值Map，找到首个误用项。
		(option) => values.has(option) || lists.has(option),
	);
	// 发现错误就拒绝，不默默忽略。
	if (misplaced) {
		// 说明该选项适用哪种传输。
		error(`--${misplaced} only applies to ${url === undefined ? "HTTP servers (--url)" : "stdio servers"}.`);
		// 无写盘退出1。
		return 1;
	}

	// 稍后两个分支都赋值同一config变量，使用unknown字典容纳待验证数据。
	let config: Record<string, unknown>;
	// url是字符串才构造HTTP声明，核心再验证协议/可解析。
	if (typeof url === "string") {
		// 重复header先按KEY=VALUE组装。
		const headers = parsePairs("header", lists.get("header"), error);
		// 解析失败结束。
		if (!headers) return 1;
		// 读取Bearer环境变量名文字。
		const bearer = value("bearer-token-env-var");
		// 反斜杠转义模板的${，保存字面Bearer ${NAME}，连接时才展开；不会现在读取该变量，也不校验名字。
		if (bearer !== undefined) headers.Authorization = `Bearer \${${bearer}}`;
		// 回调端口的原文字。
		const port = value("oauth-callback-port");
		// 仅把明确提供的OAuth字段组进对象。
		const oauth = {
			// 缺client id省略键，显式空串仍保留待核心校验。
			...(value("oauth-client-id") === undefined ? {} : { clientId: value("oauth-client-id") }),
			// secret同样按undefined决定是否加入，不在此脱敏改值。
			...(value("oauth-client-secret") === undefined ? {} : { clientSecret: value("oauth-client-secret") }),
			// 端口缺省省略，存在转Number；非法NaN随后会被核心拒绝。
			...(port === undefined ? {} : { callbackPort: Number(port) }),
			// clientName存在时保留原文字，包括空白，校验器稍后拒绝全空白。
			...(value("oauth-client-name") === undefined ? {} : { clientName: value("oauth-client-name") }),
			// 注册策略三元跨多行，仍是一次对象展开。
			...(value("oauth-client-registration") === undefined
				? // 没提供就展开空对象。
					{}
				: // 否则放clientRegistration原文字，让核心判断合法值。
					{ clientRegistration: value("oauth-client-registration") }),
		};
		// 建立HTTP配置对象。
		config = {
			// url属性简写。
			url,
			// 只有非空头字典才加headers，减少默认空字段。
			...(Object.keys(headers).length > 0 ? { headers } : {}),
			// 只有提供OAuth选项才加oauth对象。
			...(Object.keys(oauth).length > 0 ? { oauth } : {}),
		};
		// 没有HTTP url时构造stdio命令声明。
	} else {
		// 重复env同样拆KEY=VALUE。
		const env = parsePairs("env", lists.get("env"), error);
		// env拆分错误返回1。
		if (!env) return 1;
		// 目标命令数组首项为程序，后面所有项仍是独立参数。
		const [executable, ...commandArgs] = command;
		// 建立stdio配置对象。
		config = {
			// 保存可执行程序文字，不启动它。
			command: executable,
			// 非空参数才保存args。
			...(commandArgs.length > 0 ? { args: commandArgs } : {}),
			// 非空环境覆盖才保存env。
			...(Object.keys(env).length > 0 ? { env } : {}),
			// cwd没给就省，显式空串保留。
			...(value("cwd") === undefined ? {} : { cwd: value("cwd") }),
		};
	}
	// exposure只有undefined才省略，非法字符串不在此转换。
	if (exposure !== undefined) config.exposure = exposure;
	// 取共用描述。
	const description = value("description");
	// 描述提供了就保存，包括空串。
	if (description !== undefined) config.description = description;
	// 完整核心校验并归一暴露别名，仍不连接。
	const validated = validateMcpServerConfig(name, config);
	// string返回代表错误。
	if (typeof validated === "string") {
		// 输出核心错误文字。
		error(validated);
		// 不写坏配置。
		return 1;
	}

	// has(local)检测flag是否出现，不读值再转布尔。
	const project = values.has("local");
	// local写项目文件，否则写options.agentDir/mcp.json。
	const path = project ? projectConfig : join(options.agentDir, "mcp.json");
	// scope仅用来提示。
	const scope = project ? "project" : "global";
	// let将写入返回值带到try之后，失败分支提前返回。
	let replaced: boolean;
	// 这里只捕获实际配置添加/覆盖的异常。
	try {
		// 整项替换同名，不深层合并旧args/env。
		replaced = addMcpServerConfig(path, name, validated);
		// 读取/解析/目录/写盘错误统一处理。
	} catch (addError) {
		// 给目标路径和具体错误，未对内容脱敏。
		error(`Could not update ${path}: ${errorMessage(addError)}`);
		// 返回1，不声称磁盘绝对未部分写入。
		return 1;
	}
	// 用replaced状态选择提示，写成功不代表服务器有效可连接。
	log(`${replaced ? "Replaced" : "Added"} ${scope} MCP server "${name}" in ${path}.`);
	// 写项目项允许未信任；成功后提示其目前不会加载，不自动授信。
	if (project && new ProjectTrustStore(options.agentDir).get(options.cwd) !== true) {
		// 此提示只说明忽略规则，不继续启动会话。
		log(`The project is not trusted, so ${path} is ignored until you start ${APP_NAME} in the project and trust it.`);
	}
	// HTTP servers without an Authorization header may use OAuth.
	// 粗提示HTTP无Authorization可能要登录；此处没另外检查auth.provider，不当成完整OAuth资格判断。
	const mayNeedSignIn =
		// 要求HTTP形状含url键。
		"url" in validated &&
		// 请求头名忽略大小写找Authorization；空值头也算明确给了该名字。
		!Object.keys(validated.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
	// 写一条后续检查建议，不在本函数自动运行list或login。
	log(
		// 根据mayNeedSignIn拼可选登录命令。
		`Check it with: ${APP_NAME} mcp list${mayNeedSignIn ? `. If it requires sign-in: ${APP_NAME} mcp login ${name}` : ""}`,
	);
	// 保存成功的建议退出码0。
	return 0;
}

// 解析remove名字/范围并删除配置键，返回退出码；例：只在另一范围存在时提示--local。删配置不终止其他会话连接、不清远端/本地认证。文件读写失败转1，提示阶段其他异常仍可能抛。
function remove(
	// remove后argv。
	args: string[],
	// 已计算项目配置路径。
	projectConfig: string,
	// 命令运行目录等选项。
	options: McpCommandOptions,
	// 成功提示。
	log: (line: string) => void,
	// 错误提示。
	error: (line: string) => void,
): number {
	// 删除只接受local flag，没有名字模式/批量选项。
	const parsed = parseOptions(args, { local: "flag" }, error);
	// 参数错误返回1。
	if (!parsed) return 1;
	// 拿服务器名与额外位置项。
	const [name, ...extra] = parsed.positional;
	// 必须恰好一个非空名字。
	if (!name || extra.length > 0) {
		// 否则展示用法。
		error(`Usage: ${APP_NAME} mcp remove <server> [-l]\n${HELP_HINT}`);
		// 无文件修改退出1。
		return 1;
	}
	// local出现就选项目范围。
	const project = parsed.values.has("local");
	// 全局配置按options.agentDir定位。
	const globalConfig = join(options.agentDir, "mcp.json");
	// 三元选择真正删除路径。
	const path = project ? projectConfig : globalConfig;
	// 范围文字用于提示。
	const scope = project ? "project" : "global";
	// 保存配置helper是否走过delete/写回分支，继承属性也可能使它返回true。
	let removed: boolean;
	// 只包删除文件操作。
	try {
		// helper缺文件/表或属性读取undefined返回false；普通对象继承键与自有键不同，详见helper说明。
		removed = removeMcpServerConfig(path, name);
		// 失败给出文字。
	} catch (removeError) {
		// 包含路径与原错误，不保证秘密已隐藏。
		error(`Could not update ${path}: ${errorMessage(removeError)}`);
		// 建议退出1。
		return 1;
	}
	// helper返回true就输出删除成功，不在本层再核实原来是否有同名自有键。
	if (removed) {
		// 标明改了哪个范围哪份文件，不写“服务器进程已停止”。
		log(`Removed ${scope} MCP server "${name}" from ${path}.`);
		// 正常返回0。
		return 0;
	}
	// 没删到就把两个范围都按trusted=true读一次，仅用于定位另一份定义；这一步不执行服务器命令/获取网络连接。
	const other = loadMcpConfig({ agentDir: options.agentDir, cwd: options.cwd, projectTrusted: true }).servers.find(
		// 找同名但scope不同的首项，未把配置诊断作为这里的返回结果。
		(server) => server.name === name && server.scope !== scope,
	);
	// 统一错误提示。
	error(
		// 如果另一范围有定义则提醒是否加/去local，未自动替用户删除另一份。
		`No ${scope} MCP server named "${name}" in ${path}.${other ? ` It is defined in ${other.source}${other.scope === "project" ? "; use --local" : "; omit --local"}.` : ""}`,
	);
	// 目标项缺失也返回1。
	return 1;
}

// 并发检查已加载声明，汇总状态/工具名后关闭连接，输出JSON或文字并返回退出码；例：enabled:false只展示不连接。可能启动stdio命令/发网络请求，连接失败保留为报告，其他构造/关闭/输出异常可使Promise拒绝；不是纯文件查看命令。
async function list(
	// 已合并配置和错误，不在此重新信任项目。
	loaded: LoadedMcpConfig,
	// json选择输出格式，不改变连接副作用。
	json: boolean,
	// 可选未信任项目说明。
	untrustedNote: string | undefined,
	// cwd/agentDir和其他注入选项。
	options: McpCommandOptions,
	// 本命令共享的认证存储。
	credentials: McpOAuthCredentialStore,
	// 统一输出函数，文本错误汇总同样由log输出。
	log: (line: string) => void,
): Promise<number> {
	// Promise.all让各服务器检查并行开始，返回排列仍按输入声明顺序；一项未捕获拒绝不会自动取消其他检查。
	const reports = await Promise.all(
		// map的async回调为单服务器生成ServerReport。
		loaded.servers.map(async (entry): Promise<ServerReport> => {
			// 先建可展示的基本快照。
			const report: ServerReport = {
				// 原名。
				name: entry.name,
				// scope缺省global，空串等显式值若混入仍保留。
				scope: entry.scope ?? "global",
				// 定义来源。
				source: entry.source,
				// 覆盖路径真值才加入。
				...(entry.override ? { override: entry.override } : {}),
				// 只有显式false禁用，其他类型在上游校验。
				enabled: entry.config.enabled !== false,
				// exposure缺省codemode，不在配置对象里补键。
				exposure: entry.config.exposure ?? "codemode",
				// URL/命令的展示文字，不做shell转义或URL脱敏。
				transport: describeTransport(entry),
				// 初始disabled，启用后再用连接实际state覆盖。
				state: "disabled",
				// 先空工具数组，稍后发现再填。
				tools: [],
			};
			// 禁用即返回，不建连接、不读取工具。
			if (!report.enabled) return report;
			// 为启用项创建连接对象，构造异常不在下面try里。
			const connection = createConnection(entry, options, credentials);
			// 这里只把getClient的失败吸收进连接状态。
			try {
				// 实际初始化传输、MCP握手和工具发现，可有HTTP连接重试；不枚举全部资源。
				await connection.getClient();
				// 连接类记录failed/needs-auth等，继续汇总。
			} catch {
				// The connection records the state and error.
			}
			// 在close前复制连接状态文字，报告不会跟着稍后close变closed。
			report.state = connection.state;
			// 只列服务器原工具名，不注册到Agent。
			report.tools = connection.tools.map((tool) => tool.name);
			// flatMap筛出每工具策略相对服务默认的差异。
			const overrides = connection.tools.flatMap((tool) => {
				// 计算精确覆盖/通配覆盖/默认策略。
				const exposure = getMcpToolExposure(entry.config, tool.name);
				// 相同给[]丢弃，否则给单个元组；as const保持[名字,策略]成只读定长类型。
				return exposure === report.exposure ? [] : [[tool.name, exposure] as const];
			});
			// 非空差异列表才构造字典放报告。
			if (overrides.length > 0) report.toolExposure = Object.fromEntries(overrides);
			// 只记录资源能力true，不调用listResources。
			if (connection.hasResources) report.resources = true;
			// 只有未连上且有非空error才附错误；needs-auth可能没有error文字。
			if (connection.state !== "connected" && connection.error) report.error = connection.error;
			// 等待传输关闭及认证保存；这里没有finally，前面其他汇总异常可跳过close。
			await connection.close();
			// 返回快照，不把连接对象传出去。
			return report;
		}),
	);
	// 任何配置错误或启用服务器没连上就退出失败；禁用不会拖累状态。
	const failed = loaded.errors.length > 0 || reports.some((report) => report.enabled && report.state !== "connected");

	// JSON路径输出一个完整文档，不是逐行流事件。
	if (json) {
		// 共用log接收最终JSON字符串。
		log(
			// 序列化汇总。
			JSON.stringify(
				// 有未信任说明才加note，错误列表始终保留。
				{ servers: reports, errors: loaded.errors, ...(untrustedNote ? { note: untrustedNote } : {}) },
				// null表示不使用replacer过滤，不脱敏已有字段。
				null,
				// 两空格美化。
				2,
			),
		);
		// 错误影响退出码，JSON输出本身仍包含所有完成的报告。
		return failed ? 1 : 0;
	}
	// 没有服务器也没配置错才给配置位置建议。
	if (reports.length === 0 && loaded.errors.length === 0) {
		// 提示可选文件路径，不创建示例文件。
		log(`No MCP servers configured. Add them to ${join(options.agentDir, "mcp.json")} or .pi/mcp.json.`);
	}
	// 文字模式按原报告顺序输出。
	for (const report of reports) {
		// 把状态转成人类短文字。
		const state =
			// connected附工具数。
			report.state === "connected"
				? // 一个tool用单数，其余加s。
					`connected, ${report.tools.length} tool${report.tools.length === 1 ? "" : "s"}`
				: // needs-auth换成needs sign-in。
					report.state === "needs-auth"
					? // 只改展示，不启动登录。
						"needs sign-in"
					: // 其他状态原样显示。
						report.state;
		// 主行含名字、状态、暴露策略、范围。
		log(`${report.name}: ${state} (${report.exposure}, ${report.scope})`);
		// 缩进展示传输信息。
		log(`  ${report.transport}`);
		// 有覆盖文件就额外说明。
		if (report.override) log(`  project override: ${report.override}`);
		// 需要认证时提示独立login命令，不自动打开浏览器。
		if (report.state === "needs-auth") log(`  sign in with: ${APP_NAME} mcp login ${report.name}`);
		// 工具非空才输出工具行。
		if (report.tools.length > 0) {
			// 逐个名字按策略差异加可选标记。
			const tools = report.tools.map((tool) => {
				// 可选链读差异表。
				const exposure = report.toolExposure?.[tool];
				// 有差异就拼[name]样式，否则原名。
				return exposure ? `${tool} [${exposure}]` : tool;
			});
			// 逗号合并工具列表。
			log(`  tools: ${tools.join(", ")}`);
		}
		// 资源能力只给一句offers resources。
		if (report.resources) log("  offers resources");
		// 多行错误再缩进，原错误内容保留。
		if (report.error) log(`  ${report.error.split("\n").join("\n  ")}`);
	}
	// 文件校验错误逐项输出，不因某服务器成功就忽略。
	for (const configError of loaded.errors) log(`config error: ${configError}`);
	// 最后显示不可信项目说明。
	if (untrustedNote) log(untrustedNote);
	// 返回建议退出码，不调用process.exit。
	return failed ? 1 : 0;
}

// 执行某台OAuth服务器登录，先试已有凭据，必要时授权再重连；返回退出码Promise。例：已有有效凭据直接0，无需浏览器。首次连接/最终重连不在授权timeout信号内，远端授权成功也可能重连失败返回1；外层finally负责close。
async function login(
	// 服务器声明及来源。
	entry: McpServerEntry,
	// 由外层构建的连接，共享其challenge状态。
	connection: McpServerConnection,
	// 已确定的OAuth服务器URL。
	url: string,
	// 秒值虽已检有限正数，乘1000后的毫秒仍可能溢出或不符合AbortSignal.timeout的整数/范围要求；创建信号的异常由下面授权catch处理。
	timeoutMs: number,
	// 浏览器与目录等选项。
	options: McpCommandOptions,
	// 将授权结果保存回同一存储。
	credentials: McpOAuthCredentialStore,
	// 普通输出。
	log: (line: string) => void,
	// 错误输出。
	error: (line: string) => void,
): Promise<number> {
	// 只需entry.name展示。
	const { name } = entry;
	// Connecting first answers whether a sign-in is needed and records the server's challenge.
	// 先尝试现成认证，失败才能知道是否需要OAuth挑战。
	try {
		// 该await可能真的连接网络/启动协议握手。
		await connection.getClient();
		// 连接成功就认为已可用，输出工具数，不证明有某种特定远端账号权限。
		log(`Already signed in to MCP server "${name}" (${connection.tools.length} tools).`);
		// 直接0，不开始授权。
		return 0;
		// 连接失败不全都登录。
	} catch {
		// 只有needs-auth进入授权，普通网络/配置错误直接报告。
		if (connection.state !== "needs-auth") {
			// 错误缺省unknown，不统一脱敏。
			error(`MCP server "${name}" failed to connect: ${connection.error ?? "unknown error"}`);
			// 登录未开始，退出1。
			return 1;
		}
	}

	// 选择注入打开器或系统浏览器。
	const openUrl = options.openUrl ?? openBrowser;
	// 仅stdin是真TTY且未注入openUrl时允许终端粘贴，避免自动化宿主被意外读stdin。
	const interactive = process.stdin.isTTY === true && options.openUrl === undefined;
	// 授权函数/参数装配失败在这个try内转成1。
	try {
		// 开始完整OAuth流程，可能起本地回调端口、打开浏览器、换token并保存。
		await signInMcpServer({
			// 服务器URL。
			serverUrl: url,
			// 按名字+URL隔离存储，避免同URL不同声明无意共享当前凭据。
			store: credentials.forServer(name, url),
			// 解析OAuth设置，clientSecret的!表达式可能在此执行/抛错。
			settings: connection.oauthSettings(),
			// 沿用刚才401得到的challenge，辅助发现/额外scope。
			challenge: connection.challenge,
			// 提供两个用户交互回调，不在构造对象时执行它们。
			prompt: {
				// 拿到授权地址时调用的显示/打开回调，返回void。
				showAuthorizationUrl: (authorizationUrl) => {
					// 输出带href的登录提示，URL不当作shell命令拼接。
					log(`Sign in to MCP server "${name}" in your browser:\n${authorizationUrl.href}`);
					// 调用所选打开器，未await；异常由OAuth流程传播到catch。
					openUrl(authorizationUrl.href);
				},
				// 授权流程要求粘贴时转交等待函数；此signal可因已收到浏览器回调而abort，并不只代表总超时。
				promptForRedirectUrl: (signal) => waitForRedirectUrl(signal, interactive),
			},
			// 从此处开始的AbortSignal.timeout，计时到期发取消，不保证强制停止所有底层工作。
			signal: AbortSignal.timeout(timeoutMs),
		});
		// 授权阶段错误分类显示。
	} catch (signInError) {
		// 输出失败/取消说明。
		error(
			// 专用错误类别作为取消判断，不只看message文字。
			signInError instanceof McpSignInCancelledError
				? // 取消或未在时限完成统一说明，秒数四舍五入展示。
					`Sign-in to MCP server "${name}" was cancelled or not completed within ${Math.round(timeoutMs / 1000)} seconds.`
				: // 其他错误转字符串。
					`Sign-in to MCP server "${name}" failed: ${errorMessage(signInError)}`,
		);
		// 建议退出1，可能仍有已保存的中间授权状态，不做全局回滚。
		return 1;
	}
	// 成功授权清掉旧challenge，避免重连沿用过时scope挑战。
	connection.challenge = undefined;
	// 再尝试用新凭据真正连上服务器。
	try {
		// 等待已有opening/drop旧client后重建连接，这里不共享前面的总授权timer。
		await connection.reconnect();
		// 保存了凭据但连接失败也要明确报告。
	} catch (connectError) {
		// 区分Signed in, but后续失败，不伪装整体成功。
		error(`Signed in, but ${errorMessage(connectError)}`);
		// 建议退出1。
		return 1;
	}
	// 最后显示已连接并发现的工具数。
	log(`Signed in to MCP server "${name}" (${connection.tools.length} tools).`);
	// 建议退出0。
	return 0;
}

/**
 * The pasted redirect URL in a terminal; otherwise only the browser callback can finish the sign-in.
 * Resolves to undefined when `signal` aborts: the callback arrived, or the sign-in timed out.
 */
// 等待终端粘贴重定向URL，或非交互模式只等待signal结束后返回undefined；例：浏览器回调先到可取消本等待。只采集文字不校验URL/授权state，验证在OAuth层；交互readline最终关闭。
async function waitForRedirectUrl(signal: AbortSignal, interactive: boolean): Promise<string | undefined> {
	// 自动化或非TTY不读取stdin。
	if (!interactive) {
		// signal已取消就不用挂监听，否则一次性监听直到abort；不主动创建另一个超时器。
		if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
		// 非交互始终没有粘贴结果，只靠浏览器回调完成授权。
		return undefined;
	}
	// 终端问答输入stdin、提示stderr，不污染主stdout协议/输出。
	const readline = createInterface({ input: process.stdin, output: process.stderr });
	// 捕获question的取消/输入错误，但createInterface在try外。
	try {
		// await等待一行文字，结果原样返回，没有trim或URI验证。
		return await readline.question("If the browser cannot reach this machine, paste the URL it was redirected to: ", {
			// signal取消question时会拒绝。
			signal,
		});
		// 输入结束/取消/其他问答错误都返回undefined。
	} catch {
		// 不把失败变成空串URL。
		return undefined;
		// 成功或失败都执行finally。
	} finally {
		// 关闭readline接口，恢复其占用的输入监听。
		readline.close();
	}
}
