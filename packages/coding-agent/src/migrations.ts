// 启动时处理旧认证、会话位置、按键名和扩展目录；main 调 runMigrations 收集结果，交互模式再调用 showDeprecationWarnings。迁移直接读写文件，不是整批事务，也没有本模块的并发锁。
/**
 * One-time migrations that run on startup.
 */

// 终端着色函数只装饰输出；这里不会因为打印文档 URL 就自动打开浏览器。
import chalk from "chalk";
// 同步文件 API 在调用线程中执行，失败通常抛异常；各函数的 catch 范围决定哪些错误被忽略。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
// dirname 取父路径，join 按当前平台拼路径；拼接不等于验证路径来自可信目录。
import { dirname, join } from "path";
// 统一取得应用配置目录名、用户数据根和受管理二进制目录，支持 PI_CODING_AGENT_DIR 等应用配置。
import { CONFIG_DIR_NAME, getAgentDir, getBinDir } from "./config.ts";
// 复用按键名迁移规则：旧名改命名空间名，原配置已有新名时保留新名，最后按标准顺序排列。
import { migrateKeybindingsConfig } from "./core/keybindings.ts";
// 读取 JSON 后只去掉开头 BOM，不顺带清空格、修复 JSON 或验证内容。
import { stripBom } from "./utils/text.ts";

// 迁移提示中展示的指南地址；跨行赋值的下一行仍是同一个字符串表达式。
const MIGRATION_GUIDE_URL =
	"https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
// 扩展说明地址仅作为提示文字，不在模块加载时联网。
const EXTENSIONS_DOC_URL = "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md";

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns Array of provider names that were migrated
 */
// 把用户目录中的旧 OAuth/API key 收集为 auth.json，无参数，正常返回收集到的 provider 名称数组；例如 oauth.json 的 anthropic 项会成为 oauth 凭证条目。已有 auth.json 就整项跳过，不与旧文件合并。
// 先读取并改名 oauth.json，再从 settings.json 删除旧 apiKeys，最后写 auth.json；前两步可能已经成功而最后一步失败，没有回滚。返回数组描述内存收集结果，不是每项已成功写盘的证明；最终 mkdir/write 的错误会直接抛出。
export function migrateAuthToAuthJson(): string[] {
	// 每次调用读取当前配置根；测试可把环境变量指向自建临时目录，默认是用户 agent 目录。
	const agentDir = getAgentDir();
	// 新凭证文件的目标路径。
	const authPath = join(agentDir, "auth.json");
	// 旧 OAuth 文件路径，成功读取后会尝试改名为 .migrated。
	const oauthPath = join(agentDir, "oauth.json");
	// 旧 API key 所在的设置文件，迁移时会重写其中的配置。
	const settingsPath = join(agentDir, "settings.json");

	// Skip if auth.json already exists
	// 存在任何可被 existsSync 识别的 auth.json 就返回空数组，不读取/验证其内容，也不继续处理旧文件。
	if (existsSync(authPath)) return [];

	// Record<string, unknown> 在开发时表示字符串键到未知值的字典；运行时仍是普通 {}，不是 schema 校验或无原型 Map。
	const migrated: Record<string, unknown> = {};
	// 用 string[] 累计被收集的 provider 名称；const 禁止把变量换成另一数组，不禁止 push。
	const providers: string[] = [];

	// Migrate oauth.json
	// 旧 OAuth 路径存在才进入；存在性检查与后面的读写不是原子操作。
	if (existsSync(oauthPath)) {
		// 读取、解析、遍历和重命名共用一个 catch；某步失败时已经写进 migrated 的项不会撤回。
		try {
			// 同步读 UTF-8，去 BOM 后 JSON.parse；这里没有把整个解析结果做凭证 schema 校验。
			const oauth = JSON.parse(stripBom(readFileSync(oauthPath, "utf-8")));
			// Object.entries 取自有可枚举项，用数组解构分别接收名称和值；null 等不适合遍历的输入可在此抛错。
			for (const [provider, cred] of Object.entries(oauth)) {
				// 先放 type 再展开旧 cred；as object 仅告诉 TS 按对象展开，不增加运行校验，旧 cred 自带 type 时还能覆盖前面的 oauth。
				migrated[provider] = { type: "oauth", ...(cred as object) };
				// 收集该名称供调用方显示；后续改名或最终写盘失败不自动删除这条记录。
				providers.push(provider);
			}
			// 直接把旧文件改名留存，不删除其内容；目标已存在等情况遵循平台 rename 语义，这里不先检查或加锁。
			renameSync(oauthPath, `${oauthPath}.migrated`);
			// 捕获本次 OAuth 处理的异常并继续后面的设置迁移，不输出诊断，也不回滚已收集项。
		} catch {
			// Skip on error
		}
	}

	// Migrate settings.json apiKeys
	// 只有设置文件存在才尝试提取 apiKeys，和上面的 OAuth 分支相互独立。
	if (existsSync(settingsPath)) {
		// 设置读取、解析、修改和写回在同一 try 内；失败也不会回滚已累积的 migrated/providers。
		try {
			// 取得整份旧设置正文，不做分片或流式读取。
			const content = readFileSync(settingsPath, "utf-8");
			// 解析去 BOM 的 JSON；结果仍未经完整设置结构验证，例如 null 随后访问 apiKeys 会抛错并被捕获。
			const settings = JSON.parse(stripBom(content));
			// 只要求 apiKeys 为真值且 typeof 是 object；数组也会进入，不等于验证成正确的 provider→key 字典。
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				// 遍历该对象的自有可枚举项，key 的实际运行值还要通过下面的字符串判断。
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					// 只有 migrated[provider] 为假且旧 key 是字符串才收集；一般已有 OAuth 项优先，但普通对象的继承属性也会影响这个条件。
					if (!migrated[provider] && typeof key === "string") {
						// 建立 api_key 形状，属性简写 key 等于 key:key；不检查空串、密钥是否有效或是否应解释成环境变量。
						migrated[provider] = { type: "api_key", key };
						// 把本次收集名称追加到返回数组，不触发真实凭证认证。
						providers.push(provider);
					}
				}
				// 从内存设置对象删掉整个 apiKeys，即便其中部分值因类型不合或已存在凭证而未收集。
				delete settings.apiKeys;
				// 用两空格缩进整份重写设置，原排版/BOM 不保留，也没有加尾换行；此时 auth.json 还没写。
				writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
			}
			// 设置处理失败静默继续；若迁移对象已累积，后面仍可能写出 auth.json。
		} catch {
			// Skip on error
		}
	}

	// 只在普通对象存在至少一个自有可枚举键时写新凭证文件；不会为完全空结果创建空 auth.json。
	if (Object.keys(migrated).length > 0) {
		// 递归确保目标父目录存在；这两步不在前面的 catch 中，权限/磁盘错误会传播给调用方。
		mkdirSync(dirname(authPath), { recursive: true });
		// 以 JSON 正文写新文件；0o600 是八进制创建权限，主要在支持该模式的平台约束新文件读写，不是加密，也不保证竞争中已存在文件会被改权限。
		writeFileSync(authPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
	}

	// 返回已收集名称数组的原引用，不复查磁盘或重试前面忽略的失败。
	return providers;
}

/**
 * Migrate sessions from ~/.pi/agent/*.jsonl to proper session directories.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.pi/agent/ instead of
 * ~/.pi/agent/sessions/<encoded-cwd>/. This migration moves them
 * to the correct location based on the cwd in their session header.
 *
 * See: https://github.com/earendil-works/pi-mono/issues/320
 */
// 把误存于 agent 根的 .jsonl 挪到按会话头 cwd 编码的 sessions 子目录，无参数、返回 void，直接创建目录/重命名文件；例如头里 cwd=/a/b 通常迁到 sessions/--a-b--/原文件名。
// 只扫根目录一层；根列表读失败就结束，每个文件的读取/解析/移动失败则跳过该文件继续。编码公式与当前 SessionManager 相似，但本函数直接使用旧头 cwd，不先 resolvePath；文件名拆分对纯反斜杠路径也不保证正确取 basename。
export function migrateSessionsFromAgentRoot(): void {
	// 定位当前用户数据根，不遍历其他账户或任意项目目录。
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	// let 声明稍后赋值的字符串数组，保存待处理路径；类型不自动把磁盘项验证成普通文件。
	let files: string[];
	// 只把最初列目录/筛选/拼路径放进这个 try，失败直接退出整个函数。
	try {
		// 同步列一层名字，未传 withFileTypes，所以得到字符串而非带文件类型信息的对象。
		files = readdirSync(agentDir)
			// 箭头回调按大小写敏感后缀筛选，目录或链接也可能名字以 .jsonl 结尾；这里还没检查内容。
			.filter((f) => f.endsWith(".jsonl"))
			// map 把每个名字变为 agentDir 下的路径，返回新数组。
			.map((f) => join(agentDir, f));
		// 读目录或上述处理异常时进入，无日志。
	} catch {
		// void 函数用无值 return 结束，不是返回一个空列表。
		return;
	}

	// 没有候选项就避免进入后续循环。
	if (files.length === 0) return;

	// for...of 依次处理路径，单文件异常由内部 catch 隔离。
	for (const file of files) {
		// 读取到重命名都在同一 try 内，部分创建的目录不会因为后面失败而自动删除。
		try {
			// Read first line to get session header
			// 虽然只需要首行，实际仍同步读入整份文件，文件大小会影响内存与耗时。
			const content = readFileSync(file, "utf8");
			// 按 LF 分割后取第一项；不为这条 JSON 去 BOM，也不会跳过开头空白行寻找下一条。
			const firstLine = content.split("\n")[0];
			// 可选链在首项缺失时给 undefined，trim 仅用于判空；continue 跳过当前文件，不终止所有迁移。
			if (!firstLine?.trim()) continue;

			// 直接解析原首行，损坏 JSON 或带未处理 BOM 的输入会失败并在下面忽略。
			const header = JSON.parse(firstLine);
			// 只检查 type 字面值及 cwd 真值；不检查 cwd 真是字符串、是否绝对路径或其他会话字段。
			if (header.type !== "session" || !header.cwd) continue;

			// 标注 string 只影响 TS 开发期；JSON.parse 的宽类型不会因此在运行时变成字符串，错误类型可在 replace 时抛错。
			const cwd: string = header.cwd;

			// Compute the correct session directory (same encoding as session-manager.ts)
			// 先去掉开头一个 / 或反斜杠，再把所有分隔符和冒号换成 -，两边加 --；全局正则 g 会替换所有命中，不是无碰撞哈希或路径规范化。
			const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			// 把编码名称拼进用户 sessions 根，尚未创建目录。
			const correctDir = join(agentDir, "sessions", safePath);

			// Create directory if needed
			// 目标目录尚不存在才 mkdir，检查与创建之间仍可能发生并发变化。
			if (!existsSync(correctDir)) {
				// 递归创建会话目录及缺失父目录，不清理已经存在的其他内容。
				mkdirSync(correctDir, { recursive: true });
			}

			// Move the file
			// 先按 / 取最后一段，只有它是假值才按反斜杠重试；纯 Windows 反斜杠路径第一次通常得到整个非空路径，因此不能承诺这里总取得文件名。
			const fileName = file.split("/").pop() || file.split("\\").pop();
			// fileName! 的非空断言只消除 TS 对 undefined 的担心，不新增运行时检查，也不修正上述拆分结果。
			const newPath = join(correctDir, fileName!);

			// 目标已存在就保留当前源文件并继续下一项；不合并、不对比内容，检查后仍有竞争窗口。
			if (existsSync(newPath)) continue; // Skip if target exists

			// 同步 rename 移走原文件而不是复制；跨设备、权限等失败会进入本文件 catch。
			renameSync(file, newPath);
			// 吞掉本文件异常，继续下一候选项，不撤销刚创建的目标目录。
		} catch {
			// Skip files that can't be migrated
		}
	}
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
// 尝试把 baseDir 下 commands 改名为 prompts，label 只用于提示，正常返回是否走到改名成功后的 true；例如用户目录存在 commands 而无 prompts 时原路径被移动。
// 目录和可访问的符号链接都可进入，rename 操作的是路径项；已存在 prompts 就不合并。错误打印黄色提示后返回 false，但改名成功而打印失败也会进入 catch，因而 false 不能证明源路径没动过。
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	// 拼旧目录路径，不立即读写其子文件。
	const commandsDir = join(baseDir, "commands");
	// 拼新目录路径，和旧目录同级。
	const promptsDir = join(baseDir, "prompts");

	// 两个条件必须同时满足：commands 可被 existsSync 识别而 prompts 不存在；损坏链接等受 existsSync 语义影响。
	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		// 捕获 rename 以及成功提示输出的异常；catch 中警告输出若也抛错则仍会向外传播。
		try {
			// 直接重命名目录/路径项，不逐文件复制，也没有覆盖目标合并策略。
			renameSync(commandsDir, promptsDir);
			// 打印带 label 的成功说明，→ 是原提示字符串中的箭头，不是 TS 运算符。
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			// 只有改名和上面的打印都没有抛错才返回 true。
			return true;
			// 省略错误类型标注，捕获值按 TS catch 规则处理；下面通过 instanceof Error 取 message。
		} catch (err) {
			// 向 stdout 输出警告，不改进程退出码，也不重新抛原错误。
			console.log(
				// 把整条警告交给黄色样式函数，连续括号属于 log(chalk.yellow(...)) 的嵌套调用。
				chalk.yellow(
					// 模板插值显示 label 和错误；三元表达式选择 Error.message 或其他原始抛出值，不做错误脱敏。
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	// 条件不满足或已捕获改名/打印失败时返回 false；调用方当前不使用这个布尔值。
	return false;
}

// 读取用户 keybindings.json，把已识别旧动作名改成新名后写回，无参数、返回 void；例如 expandTools 改 app.tools.expand，新旧同时存在时保留显式新名。
// 只接受非 null、非数组的 JSON 对象，migrated=false 不写盘；名称迁移不等于校验每个按键值。读/解析/迁移/写失败均在 catch 中忽略，不创建缺失文件。
function migrateKeybindingsConfigFile(): void {
	// 目标是当前用户数据根的按键配置，不读取项目级同名文件。
	const configPath = join(getAgentDir(), "keybindings.json");
	// 文件不存在直接结束，避免把默认配置自动写出来。
	if (!existsSync(configPath)) return;

	// 把同步读取到写回放入同一异常边界。
	try {
		// JSON.parse 后用 as unknown 要求下面先缩小类型；断言本身不验证，去 BOM 只处理最前面的标记。
		const parsed = JSON.parse(stripBom(readFileSync(configPath, "utf-8"))) as unknown;
		// 在外部 JSON 边界排除原始值、null 与数组，留下普通对象等可按键遍历的值。
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			// 形状不满足就静默保留原文件。
			return;
		}
		// 把已缩窄对象视作字符串键字典，调用实际迁移并解构 config/migrated；未知名字和值也可保留，辅助函数不在这里写文件。
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		// 只有发生旧名转换/旧名舍弃才写；单纯排序或值可能无效不会使 migrated 自动为 true。
		if (!migrated) return;
		// 两空格 JSON 加一个 LF，以 UTF-8 覆盖原文件；不保留 BOM/原格式，也不采用临时文件交换。
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
		// 解析或写盘等错误都忽略，原英文只提 malformed，但实际 catch 覆盖范围更广。
	} catch {
		// Ignore malformed files during migration
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
// 把用户 tools 内四种 fd/rg 名字移到 bin，无参数、返回 void；例如 tools/rg 存在而 bin/rg 不在时 rename 过去。目标已有同名项就只尝试删除旧项，不比较版本或内容。
// 单个 rename/rm 错误被忽略，但检查和 mkdir、最终成功日志在这些 catch 外仍可能抛出。只认固定名字，不验证这些路径确实是可执行二进制；不下载、不运行工具，也不删除整个 tools 目录。
function migrateToolsToBin(): void {
	// 取得用户配置根，后面所有路径由配置 helper 组成。
	const agentDir = getAgentDir();
	// 旧受管理工具所在的 tools 路径。
	const toolsDir = join(agentDir, "tools");
	// 新 bin 路径由统一 helper 返回，当前也是同一 agentDir 下的 bin。
	const binDir = getBinDir();

	// 没有旧 tools 就无事可做，返回前不创建 bin。
	if (!existsSync(toolsDir)) return;

	// 只遍历四个精确大小写名字，兼顾无扩展名和 Windows .exe 文件；不是扫描所有目录项。
	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	// 记录是否至少一次 rename 成功，单纯清掉重复旧文件不算 movedAny。
	let movedAny = false;

	// 逐个名字同步处理，失败是否影响后续项取决于下面各层 catch。
	for (const bin of binaries) {
		// 当前名字在旧目录下的路径。
		const oldPath = join(toolsDir, bin);
		// 当前名字对应的新路径；join 不读取文件。
		const newPath = join(binDir, bin);

		// 旧项存在才尝试迁移，不在此验证文件类型或内容。
		if (existsSync(oldPath)) {
			// 每次需要时检查新 bin 目录是否存在。
			if (!existsSync(binDir)) {
				// 递归创建新目录；此调用不在 rename 的内部 try 中，失败会中断本函数并传播。
				mkdirSync(binDir, { recursive: true });
			}
			// 新同名项不存在走移动，否则走下面的旧项删除分支；没有锁保证检查后仍不变。
			if (!existsSync(newPath)) {
				// 只围住当前 rename 和布尔赋值。
				try {
					// 把旧路径项重命名到新路径，移动后旧路径不再指向该项。
					renameSync(oldPath, newPath);
					// 至少一次移动成功，稍后打印一次汇总。
					movedAny = true;
					// 本次移动失败就忽略并进入后续名字，不补做复制或下载。
				} catch {
					// Ignore errors
				}
				// 目标已有同名项时不覆盖它，下面只处理旧路径。
			} else {
				// Target exists, just delete the old one
				// 只捕获当前旧项删除失败。
				try {
					// ?. 是可选调用，导入函数存在时调用 rmSync；force 忽略不存在，不代表所有错误都忽略，且这里没 recursive，旧项为目录时通常不能直接删。
					rmSync?.(oldPath, { force: true });
					// 删除失败静默继续，不将 movedAny 置为 true。
				} catch {
					// Ignore
				}
			}
		}
	}

	// 只有实际成功过 rename 才输出迁移汇总。
	if (movedAny) {
		// 绿色提示写 stdout，不等于所有四项都已成功迁移。
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * Check for deprecated hooks/ and tools/ directories.
 * Note: tools/ may contain fd/rg binaries extracted by pi, so only warn if it has other files.
 */
// 检查 baseDir 旧 hooks/tools 名称并返回警告数组，label 用于区分 Global/Project；例如 tools/custom.ts 可触发自定义工具警告。只读一层名字、不执行扩展、不在本函数打印或删除目录。
// hooks 只看路径存在；tools 排除大小写不敏感的 fd/rg 四名以及以 . 开头的隐藏名。并不验证剩余项一定是自定义工具；列目录失败就忽略 tools 警告。
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	// 旧 hooks 路径，仅用于存在性判断。
	const hooksDir = join(baseDir, "hooks");
	// 旧 tools 路径，可能仍残留受管理二进制或自定义文件。
	const toolsDir = join(baseDir, "tools");
	// 初始化本次返回的 string[]，后面 push 不会立即展示到终端。
	const warnings: string[] = [];

	// 只要 hooks 路径可被识别为存在就警告，不要求它非空或确实为目录。
	if (existsSync(hooksDir)) {
		// 把带作用域标签的警告追加，最终由调用方决定是否展示。
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	// tools 存在才读其直属名字，不递归检查子目录内容。
	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		// 这个 try 捕获读目录和筛选/追加警告时的错误，不涵盖上面的 hooks 分支。
		try {
			// 同步读取一层字符串名字，没有检查文件类型。
			const entries = readdirSync(toolsDir);
			// filter 回调返回真才保留，结果是候选自定义项名字数组。
			const customTools = entries.filter((e) => {
				// 仅为比较受管理工具名转小写，不改磁盘名字；隐藏项判断仍用原名字 e。
				const lower = e.toLowerCase();
				// return 后的括号允许跨行写布尔表达式，下面各 && 条件都满足才保留。
				return (
					// 排除 fd/rg/两个 .exe 的任意大小写拼法，同时排除以 . 开头的名字；不读取它们是否真是自动提取的二进制。
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			// 至少有一个未被排除的名字就生成一条 tools 警告，不按文件数量逐条报。
			if (customTools.length > 0) {
				// 将固定说明追加数组，多行调用的下一行是完整提示模板。
				warnings.push(
					// 说明文字只反映名字筛选结果，不表示程序已迁移或运行这些扩展。
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
			// 读目录失败等异常被吞掉，此作用域已有的 hooks 警告仍保留。
		} catch {
			// Ignore read errors
		}
	}

	// 返回数组供更高层聚合，不加去重或排序。
	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
// 处理用户和 cwd 下配置目录的 commands→prompts 改名，再返回两处旧扩展目录警告；输入项目 cwd，返回 string[]，会写目录并可能打印改名结果。
// 例如 cwd=/repo 时项目作用域是 /repo/.pi；这里未检查项目信任，启动调用方直接运行。失败边界由各辅助函数决定，不保证一处失败后全部其他步骤仍执行。
function migrateExtensionSystem(cwd: string): string[] {
	// 用户作用域跟随当前 getAgentDir 环境配置。
	const agentDir = getAgentDir();
	// 项目作用域使用 cwd/CONFIG_DIR_NAME，不取 cwd/agent，也不在此先解析 cwd 为绝对路径。
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// Migrate commands/ to prompts/
	// 先尝试用户 commands 改名；返回布尔被忽略，函数自己可打印结果。
	migrateCommandsToPrompts(agentDir, "Global");
	// 再尝试项目目录改名；这里没有询问确认或检查 trust 状态。
	migrateCommandsToPrompts(projectDir, "Project");

	// Check for deprecated directories
	// 新建聚合数组，展开两次调用返回的警告元素，而不是把两个数组嵌套进去。
	const warnings = [
		// 先加入 Global 范围的警告，... 是数组展开。
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		// 再加入 Project 范围，保持调用顺序，不去重或按路径排序。
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	// 仅返回收集结果，警告等待由 showDeprecationWarnings 另行执行。
	return warnings;
}

/**
 * Print deprecation warnings and wait for keypress.
 */
// 逐条打印传入的弃用警告和指南，然后等 stdin 的第一条 data，返回 Promise<void>；例如交互启动有旧 hooks 警告时暂停到读到输入，不读取 URL。空数组立即完成，不触碰 stdin。
// 有 setRawMode 才调用，但收到任意 data 块而非经过按键解析才结束；EOF/错误没有专门完成分支，可能一直等待。它把 raw 设 false 并 pause，不保存原状态，也没有 finally 保证异常时恢复输入模式。
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	// async 函数的空 return 让 Promise 以 undefined 完成，省掉全部日志与输入操作。
	if (warnings.length === 0) return;

	// 按数组原顺序输出，不修改 warnings、不去重。
	for (const warning of warnings) {
		// 把警告放到黄色样式中写 stdout，不转为 Error 或异常。
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	// 额外打印旧扩展应移动到 extensions 的说明，前导换行用于分隔。
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	// 只展示指南字符串地址，不发 HTTP 请求。
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	// 只展示扩展文档地址。
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	// 弱化显示等待提示；文字写 any key，真正完成条件是下面 data 事件。
	console.log(chalk.dim(`\nPress any key to continue...`));

	// new Promise<void> 的 executor 同步运行，resolve 无返回数据；await 暂停后续执行但不阻塞整个事件循环。executor 同步异常会变为 Promise 拒绝。
	await new Promise<void>((resolve) => {
		// 可选调用避免方法不存在时直接调用；在可用 TTY 上尝试启用 raw 模式，方法本身仍可能抛错。
		process.stdin.setRawMode?.(true);
		// 把 stdin 切到流动读取状态，这会影响进程输入状态，不是只注册一个无副作用的监听器。
		process.stdin.resume();
		// 注册只触发一次的 data 监听器，回调忽略块内容；不是读取回车或识别特定按键。
		process.stdin.once("data", () => {
			// 读到一块输入后尝试关闭 raw，而非恢复之前保存的模式；异步事件回调中的异常不会由 Promise executor 自动捕获。
			process.stdin.setRawMode?.(false);
			// 暂停 stdin 读取，不等于关闭文件描述符，也不恢复调用前流动状态。
			process.stdin.pause();
			// 正常走到这里才把等待 Promise 标为完成；raw/pause 抛错可使它未完成且异常向事件分发传播。
			resolve();
		});
	});
	// await 正常完成后打印空行，分隔后面的启动输出。
	console.log();
}

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
// 按固定顺序运行认证→会话目录→工具二进制→按键配置→扩展目录迁移，输入项目 cwd，返回认证名称和弃用警告，不自动显示等待提示。例：旧 expandTools 配置会写成 app.tools.expand，结果中的认证名称只来自认证迁移。
// “启动一次”由 main 调用位置体现，函数本身没有已运行标记，重复调用会重新检查路径。各步骤直接同步改文件且不做全批回滚，未被局部 catch 消化的错误会中断后续步骤并抛出。
export function runMigrations(cwd: string): {
	// 返回对象中的认证 provider 名称数组；不返回凭证内容，也不保证此前所有旧源清理成功。
	migratedAuthProviders: string[];
	// 返回警告文字数组，交互 main 才可能交给 showDeprecationWarnings 等输入。
	deprecationWarnings: string[];
} {
	// 先迁移认证并接收名称；这里若抛错，后面迁移都不会执行。
	const migratedAuthProviders = migrateAuthToAuthJson();
	// 移动误存于 agent 根的会话文件；单文件失败由该函数忽略。
	migrateSessionsFromAgentRoot();
	// 迁移 fd/rg 路径；并非启动或下载这些命令。
	migrateToolsToBin();
	// 必要时同步重写用户按键名，错误由其内部 catch 忽略。
	migrateKeybindingsConfigFile();
	// 处理用户/项目 prompts 改名并收集旧扩展目录警告，这一步也可能实际重命名项目文件路径。
	const deprecationWarnings = migrateExtensionSystem(cwd);
	// 对象属性简写返回同名数组引用，不额外复制、校验文件结果或打印阻塞式警告。
	return { migratedAuthProviders, deprecationWarnings };
}
