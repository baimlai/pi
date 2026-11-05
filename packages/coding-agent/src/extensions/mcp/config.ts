// 读写全局/项目信任范围的mcp.json，并给服务器附来源；MCP扩展与pi mcp命令共用。这里不启动服务器、不解析env里的!命令，也不建立网络连接。
/**
 * MCP server configuration.
 *
 * Servers are read from `mcp.json` in the agent directory and, for trusted projects, from
 * `<project>/.pi/mcp.json`. Both use the `mcpServers` shape shared by other MCP clients, so
 * existing configurations can be copied over. Project entries replace global entries with the
 * same name.
 *
 * A project entry without `command`, `url`, or `type` overrides only `enabled`, `exposure`, and
 * `toolExposure` of the global server with the same name, for example to turn it off in one project:
 * `{ "mcpServers": { "internal-tools": { "enabled": false } } }`. The rest of the global entry is kept,
 * including credentials the project could not set itself.
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
 *     "sentry": { "url": "https://mcp.sentry.dev/mcp" }
 *   }
 * }
 * ```
 *
 * HTTP servers without an `Authorization` header use OAuth when they answer 401 (sign in with `/mcp`).
 * `"auth": { "provider": "<provider>" }` sends the token of a `/login` provider instead. Project files
 * cannot use it, so a repository cannot pick where the credential goes.
 *
 * The top-level `autoEnableCodemode` (default true) activates the codemode tool when a server
 * with `codemode` exposure connects. A project value overrides the global one.
 */

// 同步文件API：配置文件小，读取/重写发生在当前线程；写入没有锁或临时文件原子替换。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
// dirname取父目录，join按平台拼路径。
import { dirname, join } from "node:path";
// 统一配置目录名，不硬编码安装资产目录。
import { CONFIG_DIR_NAME } from "../../config.ts";
// 从核心共用配置校验和名字规则，避免CLI/扩展分叉。
import {
	// 暴露策略纯类型，运行时校验在核心函数。
	type McpExposure,
	// 传输配置联合纯类型，不自动验证JSON。
	type McpServerConfig,
	// 将-转_的namespace辅助，用于检测名字碰撞。
	mcpNamespace,
	// 返回配置或错误string的实际边界校验器。
	validateMcpServerConfig,
} from "../../core/mcp-servers.ts";
// 允许UTF-8 BOM，JSON.parse自身不直接处理该开头字符。
import { stripBom } from "../../utils/text.ts";

// 纯类型重导出方便扩展/CLI消费者，不在此重新定义规则。
export type {
	// 四种暴露策略名字。
	McpExposure,
	// HTTP配置类型。
	McpHttpServerConfig,
	// OAuth设置类型。
	McpOAuthConfig,
	// 传输联合类型。
	McpServerConfig,
	// stdio配置类型。
	McpStdioServerConfig,
} from "../../core/mcp-servers.ts";
// 值重导出单工具策略查询，调用时才计算，不在导出时读文件。
export { getMcpToolExposure } from "../../core/mcp-servers.ts";

// 一条已校验服务器及其来源元数据；这里只声明结构，不承诺已连接。
export interface McpServerEntry {
	// 原配置名字，不是规范化namespace。
	name: string;
	// 已通过本层校验的传输/暴露配置，仍可能含未知键。
	config: McpServerConfig;
	/** Config file that defined the entry, or the path of the extension that registered it. */
	// 定义它的配置文件路径，扩展注册时也可为扩展路径。
	source: string;
	/**
	 * The global or the project `mcp.json`, or `extension` for servers registered with
	 * `pi.registerMcpServer()`. Changes to extension servers are not saved.
	 */
	// 可省的来源标签；落盘只处理global/project，extension由上游组装。
	scope?: "global" | "project" | "extension";
	/** Project `mcp.json` with an override of this global server's `enabled`, `exposure`, or `toolExposure`. */
	// 若项目只覆盖全局部分开关，记录这份项目文件，source仍指全局定义。
	override?: string;
}

// 一次加载结果含可用声明和错误列表；有errors不一定阻止其他服务器加载。
export interface LoadedMcpConfig {
	// 包括enabled:false项，供UI再次启用。
	servers: McpServerEntry[];
	/** Activate the codemode tool when `codemode` servers connect. Default: true. */
	// 缺省不在此填true，MCP扩展消费者解释默认值。
	autoEnableCodemode?: boolean;
	// 逐项配置错误文字，未保证秘密已脱敏。
	errors: string[];
	/** The project `mcp.json` when the project is trusted, where `/mcp` saves project overrides. */
	// 仅项目信任时提供项目配置路径，不要求这个文件当下已存在。
	projectConfig?: string;
}

// 项目轻量覆盖只允许这三个键；不允许借全局env改执行命令。
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

/** Whether an entry overrides a server defined elsewhere instead of defining one. */
// 判断是不是只覆盖其他定义的条目，返回boolean；例：{enabled:false}是覆盖。只看command/url/type均为undefined，不自行检查其他字段是否允许。
function isOverride(value: Record<string, unknown>): boolean {
	// ===undefined同时包含键缺失和值为undefined，空串command则不是覆盖。
	return value.command === undefined && value.url === undefined && value.type === undefined;
}

// 外部JSON对象边界的粗谓词，例：{}通过、null/数组失败；不检查原型或所有键值。
function isRecord(value: unknown): value is Record<string, unknown> {
	// &&短路先排null，再排数组；value is把结果告诉TS做收窄。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 加载两份文件时共享的临时累加器，不是全局跨会话缓存。
interface McpConfigState {
	// 按名字合并的Map，替换同名不改变原插入位置。
	servers: Map<string, McpServerEntry>;
	// 后读项目boolean可覆盖全局选项，未给则保留原值。
	autoEnableCodemode?: boolean;
	// 所有文件累加到同一错误数组。
	errors: string[];
}

// 读一份配置到state，返回void；例：全局先装，可信项目可覆盖同名或只改开关。文件/JSON失败记errors，继续其他文件；existsSync及后续对象处理异常没有覆盖在解析try里。不写文件，不发请求。
function readConfigFile(path: string, scope: "global" | "project", state: McpConfigState): void {
	// 解构仍共享Map/数组，push/set会改变state里的对象。
	const { servers, errors } = state;
	// 文件不存在直接跳过，不创建空文件。
	if (!existsSync(path)) return;
	// 外部数据先unknown，解析成功不等于形状正确。
	let parsed: unknown;
	// 只捕获读取/BOM/JSON语法错误。
	try {
		// 同步读文本，去开头BOM再JSON解析。
		parsed = JSON.parse(stripBom(readFileSync(path, "utf8")));
		// 任何解析try中的抛出值转换成诊断文字。
	} catch (error) {
		// Error取message，其余String；不在这里统一脱敏。
		errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		// 本文件失败结束，调用方仍可读下一份。
		return;
	}
	// 根须对象；mcpServers可缺，有值则也须对象。
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		// 拒绝数组/null等形状，错误指向文件。
		errors.push(`${path}: expected an object with an "mcpServers" object`);
		// 不尝试遍历无效mcpServers。
		return;
	}
	// 仅boolean覆盖自动codemode选项，false也合法。
	if (typeof parsed.autoEnableCodemode === "boolean") state.autoEnableCodemode = parsed.autoEnableCodemode;
	// 显式其他类型记错，但仍继续读服务器。
	else if (parsed.autoEnableCodemode !== undefined) errors.push(`${path}: autoEnableCodemode must be a boolean`);
	// Object.entries保持JS对象枚举顺序，没mcpServers则空列表。
	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		// 只有项目对象且缺传输入口才按轻量覆盖处理；全局同形条目会走完整校验失败。
		if (scope === "project" && isRecord(value) && isOverride(value)) {
			// 取已加载的同名基础条目。
			const base = servers.get(name);
			// 筛额外键，避免修改command/headers/env等更大能力。
			const extra = Object.keys(value).filter((key) => !OVERRIDE_KEYS.includes(key));
			// 没有基础项不能只凭开关创建服务器。
			if (!base) {
				// 记错，原Map不变。
				errors.push(`${path}: server "${name}" needs "command" or "url", or a global server to override`);
				// 存在任何非允许键就拒绝整个覆盖。
			} else if (extra.length > 0) {
				// 列出允许键，不自动忽略恶意/拼错字段。
				errors.push(`${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`);
			} else {
				// 浅合并基础配置与覆盖，再执行完整核心校验；未逐工具合并toolExposure，后值会整表替换。
				const config = validateMcpServerConfig(name, { ...base.config, ...value });
				// string代表校验错误，只记诊断。
				if (typeof config === "string") errors.push(`${path}: ${config}`);
				// 成功保留原source/scope，替换config并标override项目路径。
				else servers.set(name, { ...base, config, override: path });
			}
			// 轻量覆盖处理完不再当完整定义重复插入。
			continue;
		}
		// 正常条目交核心校验，别名/URL/OAuth等在其中处理。
		const config = validateMcpServerConfig(name, value);
		// 返回string是错误，不是服务器URL。
		if (typeof config === "string") {
			// 给核心错误加配置文件前缀。
			errors.push(`${path}: ${config}`);
			// 此项不加入Map。
			continue;
		}
		// Names that differ only in `-` and `_` would share a namespace.
		// 检查名字不同但规范namespace相同的旧项，例如work-files与work_files。
		const clash = [...servers.keys()].find((other) => other !== name && mcpNamespace(other) === mcpNamespace(name));
		// 找到首个冲突就拒绝新项。
		if (clash) {
			// 错误列出冲突名字。
			errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
			// 保留原声明。
			continue;
		}
		// 项目HTTP项不能指定auth复用Pi供应商凭据，即使项目已信任也拒绝。
		if (scope === "project" && "url" in config && config.auth) {
			// 本文件来源范围校验补足核心校验器不知scope的限制。
			errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);
			// 不允许覆盖全局该项。
			continue;
		}
		// 正常同名完整定义替换旧项，metadata来源改为本文件；仍只是声明。
		servers.set(name, { name, config, source: path, scope });
	}
}

/**
 * Load global and (when trusted) project MCP configuration. Disabled servers are included with
 * `enabled: false`, so they can be enabled again.
 */
// 顺序读全局与可信项目配置，返回合并列表/错误/可选项目路径；例：不可信项目不会被读，enabled:false仍列出。不连接、不填所有默认值、不做文件监听。
export function loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig {
	// 每次加载新Map/数组，避免不同会话共享可变状态。
	const state: McpConfigState = { servers: new Map(), errors: [] };
	// 先全局，作为项目轻量覆盖的基础。
	readConfigFile(join(options.agentDir, "mcp.json"), "global", state);
	// 三元表达式只在projectTrusted为true时计算项目路径。
	const projectConfig = options.projectTrusted ? join(options.cwd, CONFIG_DIR_NAME, "mcp.json") : undefined;
	// 有路径才读取；缺文件由readConfigFile跳过。
	if (projectConfig) readConfigFile(projectConfig, "project", state);
	// 返回本次结果。
	return {
		// 展开Map.values成数组，保持合并后的顺序，不排序。
		servers: [...state.servers.values()],
		// 仅undefined时省略选项，false显式保留。
		...(state.autoEnableCodemode === undefined ? {} : { autoEnableCodemode: state.autoEnableCodemode }),
		// 直接返回本次错误数组。
		errors: state.errors,
		// 只有可信项目才加路径属性，即使文件还没创建。
		...(projectConfig ? { projectConfig } : {}),
	};
}

/** Settings `/mcp` changes. `enabled: true` and `exposure: "codemode"` are the defaults and remove the key. */
// /mcp写配置的开关补丁，只列enabled/exposure；不表达toolExposure的修改。
export interface McpServerConfigPatch {
	// undefined表示不改，false是明确关闭。
	enabled?: boolean;
	// 可把暴露策略设回默认codemode，由写入路径决定删键或保留。
	exposure?: McpExposure;
}

/**
 * Change one server's settings in the `mcp.json` that defines or overrides it. With `override`, a
 * missing entry is added as an override. Overrides keep default values, since they replace the global
 * server's. Other content is kept; the file is rewritten with its indentation.
 */
// 更新指定文件中的单个服务器开关，返回void，会重写JSON；例：完整定义设enabled=true会删默认键，项目覆盖则保留true以压过全局。缺服务器可选override创建空覆盖；不负责重新校验整台服务器，文件错误可抛。
export function updateMcpServerConfig(
	// 目标配置文件路径。
	path: string,
	// 目标名字，不在这里自动规范化。
	name: string,
	// 已经由UI/调用方给出的类型化补丁。
	patch: McpServerConfigPatch,
	// 默认不创建缺项；= {}在省略/undefined时求值。
	options: { override?: boolean } = {},
): void {
	// 把同步修改回调交统一读改写函数，回调true表示要写盘。
	editMcpServers(path, (servers, parsed) => {
		// 可选链允许根没有mcpServers；普通属性访问，不额外查hasOwn。
		// 例如__proto__可读到对象原型而非自有JSON项；后面改server字段也会沿用该引用，本实现没有特殊键隔离。
		let server = servers?.[name];
		// 缺项且明确允许override时创建。
		if (server === undefined && options.override) {
			// 先建空覆盖对象，后面给它加开关。
			server = {};
			// 浅复制原servers并增加计算属性[name]，保留其他项。
			parsed.mcpServers = { ...servers, [name]: server };
		}
		// 已有/新项必须对象，不给数组/字符串加开关。
		if (!isRecord(server)) throw new Error(`${path} does not define MCP server "${name}"`);
		// 无传输入口的覆盖项须保留默认值，否则删键后会暴露全局旧值。
		const keepDefaults = isOverride(server);
		// patch未给enabled就不改。
		if (patch.enabled !== undefined) {
			// 完整定义启用时删除键，由默认true接管。
			if (patch.enabled && !keepDefaults) delete server.enabled;
			// 覆盖项或false显式保存该值。
			else server.enabled = patch.enabled;
		}
		// 同样只改明确的exposure。
		if (patch.exposure !== undefined) {
			// 完整定义设codemode可删键，因为消费者默认codemode。
			if (patch.exposure === "codemode" && !keepDefaults) delete server.exposure;
			// 项目覆盖或其他策略保留显式值。
			else server.exposure = patch.exposure;
		}
		// 即使值看起来没变也返回true，统一写回。
		return true;
	});
}

/**
 * Add a server to an `mcp.json`, creating the file when missing. An existing entry with the same
 * name is replaced. Returns true when an entry was replaced.
 */
// 添加/整项替换服务器，返回原项是否非undefined，会创建缺文件与父目录；例：原args未在新config里就不会保留。调用方先校验，本函数不连接或再次验证name/config，写错抛出。
export function addMcpServerConfig(path: string, name: string, config: McpServerConfig): boolean {
	// 通过闭包把回调里的替换结果传到外层。
	let replaced = false;
	// 统一在读到的根上修改。
	editMcpServers(path, (servers, parsed) => {
		// 根没有服务器表就新建，已有表直接复用解析对象。
		const target = servers ?? {};
		// 非undefined就算替换，使用普通属性访问，沿用对象继承属性语义。
		replaced = target[name] !== undefined;
		// 整份config赋给该名字，不作深层合并。
		// 普通对象的__proto__赋值可能调用原型setter，不产生同名可序列化自有键；这里没有另做特殊键检查。
		target[name] = config;
		// 将目标表挂回根。
		parsed.mcpServers = target;
		// 必须保存。
		return true;
	});
	// 写入成功才返回替换标志；失败会抛，不返回false掩盖。
	return replaced;
}

/** Remove a server from an `mcp.json`. Returns false when the file does not define it. */
// 从一份文件走删除/保存分支时返回true；文件/表缺失或普通属性读取为undefined才返回false。例：空表查toString会命中继承属性，delete后仍返回true并写盘，不能据此证明原有同名自有键。不关闭连接/清认证，I/O/坏JSON错误可抛。
export function removeMcpServerConfig(path: string, name: string): boolean {
	// 缺文件快速返回，不创建文件。
	if (!existsSync(path)) return false;
	// 闭包保存是否走过删除分支，不等于原来确有同名自有键。
	let removed = false;
	// 修改服务器表，无需使用根对象参数。
	editMcpServers(path, (servers) => {
		// 无表/项为undefined不写盘；普通属性访问不是hasOwn。
		if (!servers || servers[name] === undefined) return false;
		// delete只删该对象属性，不清理其他根字段。
		delete servers[name];
		// 记录已执行delete语句；删除不存在的自有键也不会因此抛错。
		removed = true;
		// 请求保存。
		return true;
	});
	// 返回删除标志。
	return removed;
}

/**
 * Read an `mcp.json` (an empty config when missing), let `edit` change its `mcpServers`, and write
 * it back with its indentation when `edit` returns true. Other content is kept.
 */
// 同步读改写配置文件：去BOM/解析/粗校验后执行edit，true才覆盖写回，返回void。例：尽量沿用首个缩进，其余排版/重复JSON键不会保留，带注释的JSON直接解析失败；无锁/无原子替换，失败可抛且不回滚磁盘部分写入。
function editMcpServers(
	// 目标路径，父目录可缺。
	path: string,
	// 回调可修改服务器表及根；boolean选择是否写盘，不表示配置验证成功。
	edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): void {
	// 文件缺失用undefined，已存在就同步读并移BOM。
	const text = existsSync(path) ? stripBom(readFileSync(path, "utf8")) : undefined;
	// 缺文件给空根；空文本不是缺文件，JSON.parse空串会抛。
	const parsed: unknown = text === undefined ? {} : JSON.parse(text);
	// 根及可选服务器表必须非数组对象。
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		// 无效根直接抛，写入回调尚未运行。
		throw new Error(`${path}: expected an object with an "mcpServers" object`);
	}
	// 根无表时传undefined，回调按需要创建；不自动给根填表。
	const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
	// edit同步执行，false则不创建目录/写文件，回调异常直接传出。
	if (!edit(servers, parsed)) return;
	// 带m正则从任意行找首个空白缩进，找不到回退两空格；JSON.stringify原生对缩进长度有截断规则。
	const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
	// 准备父目录，递归允许已经存在。
	mkdirSync(dirname(path), { recursive: true });
	// 按原选缩进重新序列化根并补LF覆盖文件，不是局部文本补丁。
	writeFileSync(path, `${JSON.stringify(parsed, null, indent)}\n`);
}
