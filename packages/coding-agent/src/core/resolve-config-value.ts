/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

// 将 API key/请求头配置从原字符串解析成值，供认证与提供商合成层使用；既有纯模板路径，也有会启动本地命令的路径。
// execSync 交给系统默认 shell；spawnSync 显式选择 shell 和参数，两者都会同步等待。
import { execSync, spawnSync } from "child_process";
// Windows 优先尝试项目选择的 Bash 配置，再按结果决定是否回退系统 shell。
import { getShellConfig } from "../utils/shell.ts";

// Cache for shell command results (persists for process lifetime)
// 缓存键是完整 !命令字符串，值也可以是 undefined；进程内跨调用复用，清缓存后才重新执行缓存路径。
const commandResultCache = new Map<string, string | undefined>();
// 完整变量名规则：字母/下划线开头，后续允许数字；^ 和 $ 要求整串匹配。
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 前缀规则不带结尾 $，用于从 $NAME/rest 中只提取 NAME。
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

// 带标签的联合类型：literal 片段保存 value，env 片段保存 name；判断 type 后 TS 会缩小可访问字段。
type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

// 配置分成 command 与 template 两类；命令保存原串，模板保存已拆好的片段数组。
type ConfigValueReference = { type: "command"; config: string } | { type: "template"; parts: TemplatePart[] };

/** 追加普通文本并合并相邻文字片段；例如先加 "a" 再加 "b"，保留一个 literal("ab")。 */
function appendLiteral(parts: TemplatePart[], value: string): void {
	// 不保存空文字片段，减少无意义数组项。
	if (!value) return;
	// 数组最后一项可能不存在，后面通过可选链检查。
	const previousPart = parts[parts.length - 1];
	// 若上一片也是文字，就直接拼接，不新建另一个片段。
	if (previousPart?.type === "literal") {
		// += 修改已有片段的 value；此 parts 是正在构造的解析结果。
		previousPart.value += value;
		// 合并后提前结束，避免下面重复 push。
		return;
	}
	// type 字面量选中 literal 分支；value 属性简写等价于 value: value。
	parts.push({ type: "literal", value });
}

/** 只拆模板，不读取环境或执行命令；例："Bearer $TOKEN" → literal("Bearer ") + env("TOKEN")。 */
function parseConfigValueTemplate(config: string): TemplatePart[] {
	// 显式数组元素类型防止混入无 type/name/value 约定的对象。
	const parts: TemplatePart[] = [];
	// index 保存已消费位置，按 UTF-16 字符串下标向后推进。
	let index = 0;

	// 循环直到整串处理完；每条分支都推进 index 或退出，避免卡在同一个 $。
	while (index < config.length) {
		// 从 index 起找下一个美元符号，找不到返回 -1。
		const dollarIndex = config.indexOf("$", index);
		// 剩余部分没有变量/转义起点，全是普通文字。
		if (dollarIndex < 0) {
			// slice(index) 把剩余文字一次追加完。
			appendLiteral(parts, config.slice(index));
			// break 结束整个 while，不只跳过当前分支。
			break;
		}

		// 先保存 $ 之前的普通文字；起止相等得到空串，由 appendLiteral 跳过。
		appendLiteral(parts, config.slice(index, dollarIndex));
		// 查看 $ 后面的字符，可能是 $、!、{、变量名或不存在。
		const nextChar = config[dollarIndex + 1];

		// $$ 产生字面 $，$! 产生字面 !；转义后的 ! 不会再次被识别成命令开头。
		if (nextChar === "$" || nextChar === "!") {
			// 只追加转义后的一个字符，不保存第一个 $。
			appendLiteral(parts, nextChar);
			// 原输入消费两个字符，下一轮从其后开始。
			index = dollarIndex + 2;
			// continue 回到 while 条件，跳过变量匹配逻辑。
			continue;
		}

		// ${NAME} 使用带花括号的明确边界。
		if (nextChar === "{") {
			// 寻找对应的下一个 }；这里不支持嵌套 shell 表达式或默认值语法。
			const endIndex = config.indexOf("}", dollarIndex + 2);
			// 缺右括号时不把整个输入当变量。
			if (endIndex < 0) {
				// 当前 $ 按普通字符保留。
				appendLiteral(parts, "$");
				// 只消费 $，让后面的 { 和文字在后续正常处理。
				index = dollarIndex + 1;
				// 继续扫描，因此 "${UNCLOSED" 会保留其原文字面形式。
				continue;
			}

			// 提取花括号内部，不包含 ${ 和 }。
			const name = config.slice(dollarIndex + 2, endIndex);
			// 只接受完整变量名；例如 ${A-B} 不满足这里的命名规则。
			if (ENV_VAR_NAME_RE.test(name)) {
				// 记录 env 片段，稍后才决定值从哪里来。
				parts.push({ type: "env", name });
			} else {
				// 非法名字整段保留原文本，不尝试执行 shell 扩展。
				appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
			}
			// 消费到右括号之后，避免重复处理这一段。
			index = endIndex + 1;
			// 这段已处理完，直接进入下轮。
			continue;
		}

		// 无花括号时，从 $ 后取合法变量名前缀，例如 $A/rest 只取 A。
		const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		// match 为 null 表示后续不能组成变量名。
		if (match) {
			// match[0] 是完整匹配到的变量名，保存 env 片段。
			parts.push({ type: "env", name: match[0] });
			// 消费 $ 加变量名长度，后面的 /rest 留待下轮处理。
			index = dollarIndex + 1 + match[0].length;
			// 跳过兜底文字分支。
			continue;
		}

		// 例如末尾单独一个 $，无法匹配变量时作为文字保存。
		appendLiteral(parts, "$");
		// 推进一个字符，确保循环最终结束。
		index = dollarIndex + 1;
	}

	// 返回解析结构，没有读取 process.env 或执行外部命令。
	return parts;
}

/** 先识别命令，否则走模板解析；例："!tool key" 是命令，"$!tool key" 是字面文本。 */
function parseConfigValueReference(config: string): ConfigValueReference {
	// 只认原串第一个字符，不会先 trim；前面有空格的 ! 不算命令起点。
	if (config.startsWith("!")) {
		// 保留包括 ! 的原串，执行时再去掉首字符。
		return { type: "command", config };
	}

	// 普通文本也算模板，只是可能完全没有 env 片段。
	return { type: "template", parts: parseConfigValueTemplate(config) };
}

/** 查一个变量：优先非空显式 env，再查非空进程环境；都无值则 undefined。例：空 env.TOKEN 不会屏蔽进程 TOKEN。 */
function resolveEnvConfigValue(name: string, env?: Record<string, string>): string | undefined {
	// || 按真假回退，因此空字符串也会回退；与只对 null/undefined 回退的 ?? 不同。
	return env?.[name] || process.env[name] || undefined;
}

/** 收集模板引用的变量名并按首次出现去重；例：$A-$B-$A → ["A", "B"]。 */
function getTemplateEnvVarNames(parts: TemplatePart[]): string[] {
	// 只收集名字，完全不查这些变量是否已有值。
	const names: string[] = [];
	// for...of 按片段原顺序遍历。
	for (const part of parts) {
		// 短路条件先排除文字片，再检查重复；TS 此时知道 part 有 name。
		if (part.type !== "env" || names.includes(part.name)) continue;
		// push 原地追加名字，保留首次出现的先后顺序。
		names.push(part.name);
	}
	// 命令中的 $ 不会进这个函数，因为命令未被拆成模板。
	return names;
}

/** 拼接文字并展开变量；任一变量没值则整串失败。例："Bearer $TOKEN" 可得到 "Bearer abc"。 */
function resolveTemplate(parts: TemplatePart[], env?: Record<string, string>): string | undefined {
	// 从空字符串开始累加最终内容；纯空模板可合法解析为 ""。
	let resolved = "";
	// 片段顺序就是原配置顺序。
	for (const part of parts) {
		// type 收窄后该分支可以读取 value。
		if (part.type === "literal") {
			// 普通文本原样拼接，不经过 shell。
			resolved += part.value;
			// 文字已处理完，不再拿它当环境变量。
			continue;
		}
		// 剩余分支已缩小为 env，可以安全读取 name。
		const envValue = resolveEnvConfigValue(part.name, env);
		// 缺一项就返回 undefined，不用空串掩盖缺失的密钥片段。
		if (envValue === undefined) return undefined;
		// 变量存在才拼到最终结果上。
		resolved += envValue;
	}
	// 整个模板都成功时返回拼好的字符串，可能是合法的空串。
	return resolved;
}

/** 仅当整个配置就是一个变量引用时取其名字；例：$TOKEN / ${TOKEN} 得 TOKEN，Bearer $TOKEN 不符合。 */
export function getConfigValueEnvVarName(config: string): string | undefined {
	// 先区分命令与模板，避免把命令里的 $ 错当成配置模板引用。
	const reference = parseConfigValueReference(config);
	// 命令分支没有“唯一模板变量”这一概念。
	if (reference.type !== "template") return undefined;
	// 同时要求只一片且为 env；可选链处理空模板没有第零项。
	return reference.parts.length === 1 && reference.parts[0]?.type === "env" ? reference.parts[0].name : undefined;
}

/** 列出非命令配置中的所有变量名；例：$A-$B-$A → ["A", "B"]，!echo $A → []。 */
export function getConfigValueEnvVarNames(config: string): string[] {
	// 解析本身无执行副作用。
	const reference = parseConfigValueReference(config);
	// 三元表达式按类型选择收集变量名或空列表。
	return reference.type === "template" ? getTemplateEnvVarNames(reference.parts) : [];
}

/** 列出模板中缺少非空值的变量；例如 env 只有 A 时，$A-$B 得 ["B"]。 */
export function getMissingConfigValueEnvVarNames(config: string, env?: Record<string, string>): string[] {
	// filter 只保留解析不到值的名字；普通文字和命令引用返回空列表。
	return getConfigValueEnvVarNames(config).filter((name) => resolveEnvConfigValue(name, env) === undefined);
}

/** 判断是否为 !开头的命令声明；例：!key-helper 为 true，$!key-helper 为 false，不执行它。 */
export function isCommandConfigValue(config: string): boolean {
	// 只看解析出的类别，不尝试判断命令是否存在或能成功。
	return parseConfigValueReference(config).type === "command";
}

/** 只检查模板变量是否齐全；命令和纯字面量也返回 true，不代表远端认证成功或命令可执行。 */
export function isConfigValueConfigured(config: string, env?: Record<string, string>): boolean {
	// 无缺失变量就视为配置已具备；没有运行命令验证其输出。
	return getMissingConfigValueEnvVarNames(config, env).length === 0;
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Interpolates "$ENV_VAR" or "${ENV_VAR}" references with the named environment variable
 * - In non-command values, "$$" escapes a literal "$" and "$!" escapes a literal "!"
 * - Otherwise treats the value as a literal
 */
/** 解析配置；!命令使用进程内结果缓存，模板按本次 env 展开。例：resolveConfigValue("Bearer $TOKEN", { TOKEN: "abc" })。 */
export function resolveConfigValue(config: string, env?: Record<string, string>): string | undefined {
	// 根据原串起点选择命令或模板路径。
	const reference = parseConfigValueReference(config);
	// 只有 command 分支才会运行本地程序；传入 env 不会作为此命令的环境覆盖。
	if (reference.type === "command") {
		// 命令沿用进程环境，结果或失败 undefined 都可能被缓存。
		return executeCommand(reference.config);
	}
	// 普通模板不走命令缓存，每次按显式 env 与当前 process.env 取值。
	return resolveTemplate(reference.parts, env);
}

/** 用所选 Bash 执行并返回状态；executed=true 表示已尝试且不应回退，不保证成功或有输出。 */
function executeWithConfiguredShell(command: string): { executed: boolean; value: string | undefined } {
	try {
		// 解构取得 shell 可执行路径、启动参数和命令传输方式。
		const { shell, args, commandTransport } = getShellConfig();
		// 旧 WSL Bash 需要从标准输入接命令，普通 Bash 则经 -c 参数接命令。
		const commandFromStdin = commandTransport === "stdin";
		// spawnSync 同步等待；条件表达式选择只传启动参数，或把命令追加到 argv。
		const result = spawnSync(shell, commandFromStdin ? args : [...args, command], {
			// stdout 按 UTF-8 文字返回，而不是 Buffer。
			encoding: "utf-8",
			// 仅 stdin 传输方式给子进程输入整条命令，其他情况不写 stdin。
			input: commandFromStdin ? command : undefined,
			// 最多等待 10000 毫秒后由 Node 报告超时；不在这里承诺终止全部孙进程。
			timeout: 10000,
			// stdio 三项依次是 stdin/stdout/stderr；捕获输出值，丢弃错误输出。
			stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"],
			// 不让 Node 再套一层 shell；这里显式启动的 Bash 仍会解释命令字符串。
			shell: false,
			// Windows 上隐藏额外控制台窗口，不改变命令内容。
			windowsHide: true,
		});

		// result.error 是启动或等待失败，与子进程正常返回非零状态不同。
		if (result.error) {
			// Node 的进程错误可能带 code，断言用于读取这一字段。
			const error = result.error as NodeJS.ErrnoException;
			// ENOENT 常表示启动目标缺失，可回退默认 shell。
			if (error.code === "ENOENT") {
				// executed=false 告诉外层尝试备用实现，不是返回一个有效空密钥。
				return { executed: false, value: undefined };
			}
			// 其他错误不回退，避免超时/权限等失败后再执行第二遍命令。
			return { executed: true, value: undefined };
		}

		// 命令运行但退出码非零，不认为得到有效值。
		if (result.status !== 0) {
			// 仍标为已尝试，因此不会因业务退出失败就换 shell 再来一次。
			return { executed: true, value: undefined };
		}

		// stdout 缺失按空字符串处理，再去掉首尾空白。
		const value = (result.stdout ?? "").trim();
		// 即使退出成功，空输出也返回 undefined；executed 标志仍为 true。
		return { executed: true, value: value || undefined };
	} catch {
		// getShellConfig 或其他同步步骤抛错时，外层可以考虑默认 shell。
		return { executed: false, value: undefined };
	}
}

/** 用系统默认 shell 执行一次命令并取去空白后的 stdout；例：输出换行会被 trim，失败或空输出得 undefined。 */
function executeWithDefaultShell(command: string): string | undefined {
	try {
		// execSync 会解释 shell 语法；本函数接收的是用户配置命令，不是普通文件路径。
		const output = execSync(command, {
			// 成功输出按字符串解码。
			encoding: "utf-8",
			// 单次执行的超时为十秒，没有额外重试循环。
			timeout: 10000,
			// 忽略 stdin 和 stderr，只捕获 stdout 用作配置值。
			stdio: ["ignore", "pipe", "ignore"],
		});
		// trim 会移除全部首尾空白，不保留用于排版的末尾换行。
		return output.trim() || undefined;
	} catch {
		// 包括非零退出、启动失败、超时等情况，都按解析不到值处理。
		return undefined;
	}
}

/** 不使用缓存执行 !命令；Windows 优先配置 Bash，只有未成功启动所选路径时才考虑默认 shell。 */
function executeCommandUncached(commandConfig: string): string | undefined {
	// slice(1) 去掉标记 !，其余命令原样交给 shell。
	const command = commandConfig.slice(1);
	// 平台分流：Windows 有额外选 Bash 的步骤，Unix 直接默认 shell。
	return process.platform === "win32"
		? // 立即调用的箭头函数表达式，可在三元分支里写多条语句并返回结果。
			(() => {
				// 先尝试项目 shell 解析规则，不在这里额外传 settings.shellPath 参数。
				const configuredResult = executeWithConfiguredShell(command);
				// executed=true 时直接采用结果（包括 undefined），不会因没拿到 key 就执行两遍。
				return configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command);
			})()
		: // 非 Windows 走默认 shell，一次调用完成。
			executeWithDefaultShell(command);
}

/** 按原始 !命令串缓存结果；相同命令再次调用不启动进程，连失败 undefined 也会缓存。 */
function executeCommand(commandConfig: string): string | undefined {
	// 必须用 has 而不是 get 的真假值，才能分清“没缓存”和“缓存过失败”。
	if (commandResultCache.has(commandConfig)) {
		// 命中后原样返回成功值或 undefined。
		return commandResultCache.get(commandConfig);
	}

	// 未命中才真正执行一次命令。
	const result = executeCommandUncached(commandConfig);
	// 无论是否拿到字符串都保存，避免失败配置每次请求都反复启动程序。
	commandResultCache.set(commandConfig, result);
	// 把同一结果返回给当前调用者。
	return result;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
/** 与 resolveConfigValue 使用同一语法，但 !命令每次重跑；模板仍按本次 env 展开，不读取命令缓存。 */
export function resolveConfigValueUncached(config: string, env?: Record<string, string>): string | undefined {
	// 先分类，命令路径和纯模板路径分开。
	const reference = parseConfigValueReference(config);
	// command 分支拥有原 !命令串。
	if (reference.type === "command") {
		// 显式绕过 commandResultCache；调用者要承担重复运行配置命令的副作用。
		return executeCommandUncached(reference.config);
	}
	// 模板本来就没有命令结果缓存，行为与缓存版一致。
	return resolveTemplate(reference.parts, env);
}

/** 无缓存解析，失败抛出带说明的错误；例：缺 $TOKEN 会指出变量名，而不是静默返回 undefined。 */
export function resolveConfigValueOrThrow(config: string, description: string, env?: Record<string, string>): string {
	// 这里特意调用 Uncached，不能因为函数名相似就误以为仍使用进程缓存。
	const resolvedValue = resolveConfigValueUncached(config, env);
	// 严格比较 undefined；纯字面空字符串仍被视为成功值。
	if (resolvedValue !== undefined) {
		// 成功就返回字符串，函数返回类型无需再带 undefined。
		return resolvedValue;
	}

	// 解析失败后再分类，用来生成更具体的错误说明。
	const reference = parseConfigValueReference(config);
	// 命令没有有效输出或执行失败时走命令错误。
	if (reference.type === "command") {
		// 原行为会在错误中列命令文本（去掉 !），description 由调用方标注 key/header 位置。
		throw new Error(`Failed to resolve ${description} from shell command: ${reference.config.slice(1)}`);
	}

	// 模板失败时找缺失变量；该判断沿用明确的联合类型分支。
	if (reference.type === "template") {
		// 沿用 env → process.env 的回退规则重新定位缺失项。
		const missingEnvVars = getMissingConfigValueEnvVarNames(config, env);
		// 单个名字用单数格式报错。
		if (missingEnvVars.length === 1) {
			// 模板字符串插入说明和变量名，不把缺失变量当成空值继续请求。
			throw new Error(`Failed to resolve ${description} from environment variable: ${missingEnvVars[0]}`);
		}
		// 多个缺失变量一次列全。
		if (missingEnvVars.length > 1) {
			// join(", ") 合成可读列表。
			throw new Error(`Failed to resolve ${description} from environment variables: ${missingEnvVars.join(", ")}`);
		}
	}

	// 若未匹配上具体分支，仍给一个明确的失败错误，不返回伪造 key。
	throw new Error(`Failed to resolve ${description}`);
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
/** 宽松解析每个请求头，缺值/空值的项丢弃；例：Authorization 引用了缺失变量时不会进入返回字典。 */
export function resolveHeaders(
	// 未配置 headers 和配置了空对象都可能最终得到 undefined。
	headers: Record<string, string> | undefined,
	// 显式 env 只用于模板取值，不改变命令子进程环境。
	env?: Record<string, string>,
): Record<string, string> | undefined {
	// 完全没配置就提前返回，不生成空字典给调用者。
	if (!headers) return undefined;
	// 新建输出字典，保留原配置对象不变。
	const resolved: Record<string, string> = {};
	// 对象键值对解构后，key 是请求头名，value 是原配置表达式。
	for (const [key, value] of Object.entries(headers)) {
		// 这里使用带命令缓存的解析入口。
		const resolvedValue = resolveConfigValue(value, env);
		// 真假判断会同时丢弃 undefined 和空字符串，不只丢弃缺失值。
		if (resolvedValue) {
			// 只有非空结果才写入输出头。
			resolved[key] = resolvedValue;
		}
	}
	// 至少一个有效头才返回对象，否则统一 undefined。
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** 严格解析所有请求头；任一缺值就抛错，!命令不缓存。例：缺 X-Token 对应变量时中止整次解析。 */
export function resolveHeadersOrThrow(
	// 输入省略时直接得到 undefined，不报“没有请求头”的错误。
	headers: Record<string, string> | undefined,
	// description 说明这组头属于哪个模型/提供商，用于定位错误。
	description: string,
	// 环境覆盖仅用于模板路径。
	env?: Record<string, string>,
): Record<string, string> | undefined {
	// 没有整组配置时直接退出。
	if (!headers) return undefined;
	// 输出字典重新创建，不原地覆盖配置中的表达式。
	const resolved: Record<string, string> = {};
	// 保持输入请求头的遍历顺序逐项解析。
	for (const [key, value] of Object.entries(headers)) {
		// OrThrow 使用无命令缓存路径；空字符串也能保留，而失败会打断循环。
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`, env);
	}
	// 无条目时返回 undefined；这里不负责大小写折叠或 Authorization 优先级。
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
/** 清除全部命令结果缓存；例：外部 key-helper 的输出变了，清理后下一次缓存版解析才重新执行。 */
export function clearConfigValueCache(): void {
	// Map.clear 同时丢弃成功和失败缓存，不会修改进程环境或终止已有命令。
	commandResultCache.clear();
}
