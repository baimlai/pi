// 管理项目路径的信任记录和询问选项；project-trust.ts 做策略选择，本文件负责父目录继承与 trust.json 的同步读改写。
// 读取也会创建存储父目录并拿锁；锁协调使用同一路径的调用者，直接写文件仍不是原子替换或回滚事务。
// 同步文件 API 会阻塞当前线程；目录探测、读取和保存都在本进程完成。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
// HOME 为空时用系统用户主目录兜底。
import { homedir } from "node:os";
// dirname 向上找父目录，join 按平台拼接路径。
import { dirname, join } from "node:path";
// 第三方文件锁返回释放函数；这里使用 lockSync 而非异步锁接口。
import lockfile from "proper-lockfile";
// 项目配置目录名来自 config，以便与其他资源加载代码一致。
import { CONFIG_DIR_NAME } from "../config.ts";
// 路径辅助展开/绝对化、尽可能解析真实路径，并按平台处理比较规则。
import { canonicalizePath, pathsEqual, resolvePath } from "../utils/paths.ts";
// 去掉文件开头 BOM 后再交给 JSON.parse。
import { stripBom } from "../utils/text.ts";

// boolean | null 是联合类型：true 同意、false 拒绝、null 表示没有独立决定/删除当前项。
export type ProjectTrustDecision = boolean | null;

// 查询命中的实际存储项；可能来自祖先目录，不一定就是传入 cwd。
export interface ProjectTrustStoreEntry {
	// 命中的 JSON 键名，保留写入文件的路径形式。
	path: string;
	// 命中项一定有布尔决定，null 项会被向上查找跳过。
	decision: boolean;
}

// 一条待应用更新；它与查询命中项的区别是 decision 允许 null。
export interface ProjectTrustUpdate {
	// 要修改的路径，写入时会归一化。
	path: string;
	// null 在 setMany 中表示删除对应目录记录，让祖先决定重新生效。
	decision: ProjectTrustDecision;
}

// UI 选项既携带本次结果，也携带需要保存的批量变更。
export interface ProjectTrustOption {
	// 显示文字，也是 project-trust.ts 查回选择对象的匹配值。
	label: string;
	// 当前选择对本次会话产生的同意/拒绝结果。
	trusted: boolean;
	// 需持久化的更新；空数组表示仅本次，不写信任库。
	updates: ProjectTrustUpdate[];
	// 可选的保存目标提示；父目录选项会指向父目录。
	savedPath?: string;
}

// Record<K,V> 表示字符串键到联合值的字典；undefined 也可能来自查询不存在的键。
type TrustFile = Record<string, boolean | null | undefined>;

// 当前目录 .pi 下出现以下任一入口就需要项目资源信任判定；这里只检查存在，不读取内容。
const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
	// 项目设置入口。
	"settings.json",
	// 项目 MCP 服务器配置入口。
	"mcp.json",
	// 可执行扩展的发现目录。
	"extensions",
	// 技能资源目录。
	"skills",
	// 提示词模板目录。
	"prompts",
	// 主题资源目录。
	"themes",
	// 替代系统提示词文件。
	"SYSTEM.md",
	// 追加系统提示词文件。
	"APPEND_SYSTEM.md",
	// as const 在编译期保留每个字符串字面量及只读元组类型，不执行 Object.freeze。
] as const;

/**
 * 统一信任键的路径形式：先展开 ~ 并解析绝对路径，再尽可能 realpath。
 * 例：存在的软链接目录可落到目标目录键；路径不存在时 canonicalizePath 保留输入路径，不保证文件必须存在。
 */
function normalizeCwd(cwd: string): string {
	// 两个函数从内到外执行；这不是修改传入字符串本身，而是返回新字符串。
	return canonicalizePath(resolvePath(cwd));
}

/** Trust file keys naming `path`. Usually one; several on Windows when saved with different casing. */
/**
 * 找出信任文件中所有指向同一路径的键；不改字典，返回键数组。
 * 例：Windows 不同大小写的两个键可能都被命中，保存时统一清掉；其他平台使用其路径比较规则。
 */
function findTrustFileKeys(data: TrustFile, path: string): string[] {
	// Object.keys 列举自有键，filter 用 pathsEqual 保留平台规则下相等的路径。
	return Object.keys(data).filter((key) => pathsEqual(key, path));
}

/**
 * 从 cwd 开始逐级向根目录查询最近的布尔决定，找不到返回 null。
 * 例：/work=true、/work/app=false，则查询 /work/app/src 得到 app 的 false；app 的 null 不遮蔽 work 的 true。只读 data，不写文件。
 */
function findNearestTrustEntry(data: TrustFile, cwd: string): ProjectTrustStoreEntry | null {
	// let 变量稍后会改成父目录；先归一化 cwd。
	let currentDir = normalizeCwd(cwd);
	// 无限循环由命中决定或到达根目录的 return 终止。
	while (true) {
		// 同一路径可能有多个大小写等价键，按文件对象的键顺序检查。
		for (const key of findTrustFileKeys(data, currentDir)) {
			// 索引访问得到 true/false/null 或 undefined。
			const value = data[key];
			// 只让两个布尔字面量成为有效决定；null 和空缺继续向上找。
			if (value === true || value === false) {
				// 对象属性 path:key 表示返回原存储键，并携带找到的布尔值。
				return { path: key, decision: value };
			}
		}

		// dirname 在文件系统根处会返回自身。
		const parentDir = dirname(currentDir);
		// 当前已是根目录时停止，避免永远留在根目录循环。
		if (parentDir === currentDir) {
			// 完整祖先链均无决定，返回 null。
			return null;
		}
		// 没有命中且还有父目录，下一轮在父目录继续找。
		currentDir = parentDir;
	}
}

/**
 * 返回归一化工作目录的直接父目录；根目录没有更高父级，返回 undefined。
 * 例：/work/app → /work，/ → undefined；不查询信任文件。
 */
export function getProjectTrustParentPath(cwd: string): string | undefined {
	// 统一 cwd 后再找父级，避免相对路径影响层级关系。
	const trustPath = normalizeCwd(cwd);
	// 拿到直接父目录，不扫描所有祖先。
	const parentDir = dirname(trustPath);
	// 三元表达式按是否到根选择 undefined 或父路径。
	return parentDir === trustPath ? undefined : parentDir;
}

/**
 * 构造可供 UI 展示的信任选项，返回新数组，不保存决定。
 * 例：includeSessionOnly:true 时额外提供本次同意/拒绝；信任父目录会同时删除当前目录独立记录，以便继承父决定。根目录不提供父级选项。
 */
export function getProjectTrustOptions(cwd: string, options?: { includeSessionOnly?: boolean }): ProjectTrustOption[] {
	// 每个持久化选项都使用相同归一化目录键。
	const trustPath = normalizeCwd(cwd);
	// 显式数组类型确保每项的 label/trusted/updates 形状正确；不做运行时 schema 校验。
	const trustOptions: ProjectTrustOption[] = [
		// 首项同意当前目录，本次 true，保存一条 true，并附保存路径。
		{ label: "Trust", trusted: true, updates: [{ path: trustPath, decision: true }], savedPath: trustPath },
	];
	// 父目录辅助已处理根目录边界。
	const parentPath = getProjectTrustParentPath(cwd);
	// 有直接父级才添加 Trust parent folder。
	if (parentPath !== undefined) {
		// push 修改本次新建数组，不修改外部选项。
		trustOptions.push({
			// 模板字面量将父路径放到选择标签中。
			label: `Trust parent folder (${parentPath})`,
			// 选择父目录信任同样使本次目录可信。
			trusted: true,
			// 一次选项带两条更新，后续由 setMany 在同一锁中处理。
			updates: [
				// 父目录保存 true，使其他未单独覆盖的子目录也能继承。
				{ path: parentPath, decision: true },
				// 当前目录保存动作是删除旧覆盖，不是保存一个拒绝值。
				{ path: trustPath, decision: null },
			],
			// 标注实际保存到父目录，以便调用方展示。
			savedPath: parentPath,
		});
	}
	// ?. 在没有 options 时得到 undefined；只有真值才加本次会话同意。
	if (options?.includeSessionOnly) {
		// 空 updates 不清除旧文件记录，只影响本次选择的返回值。
		trustOptions.push({ label: "Trust (this session only)", trusted: true, updates: [] });
	}
	// 持久化拒绝选项始终提供。
	trustOptions.push({
		// 拒绝选项的显示文字。
		label: "Do not trust",
		// 本次返回 false。
		trusted: false,
		// 保存当前目录 false，遮蔽祖先的 true。
		updates: [{ path: trustPath, decision: false }],
		// 附带当前保存路径。
		savedPath: trustPath,
	});
	// 同一选项开关也控制本次会话拒绝项。
	if (options?.includeSessionOnly) {
		// 空更新意味着拒绝仅由本次调用使用，不更改未来会话记录。
		trustOptions.push({ label: "Do not trust (this session only)", trusted: false, updates: [] });
	}
	// 按构造顺序返回 UI 选项数组。
	return trustOptions;
}

/**
 * 从 path 读取并验证信任 JSON；不存在返回空对象，坏 JSON 或非法值抛带路径错误。
 * 外部文件是不可信数据边界，所以先用 unknown 接住，再验证对象和每项值。例：{"/work":false} 合法，数组或字符串决定非法。
 */
function readTrustFile(path: string): TrustFile {
	// 缺文件是正常首次启动；存在性检查不是原子创建保证。
	if (!existsSync(path)) {
		// 返回新的空字典，不在这里创建 trust.json。
		return {};
	}

	// unknown 要求后面先检查再使用外部 JSON 形状。
	let parsed: unknown;
	// 只包住读取和解析；下方语义校验有各自错误。
	try {
		// 同步读 UTF-8 → 去 BOM → JSON.parse，读取失败也会进入 catch。
		parsed = JSON.parse(stripBom(readFileSync(path, "utf-8")));
		// catch 得到的异常可能不是 Error 实例。
	} catch (error) {
		// 对 Error 用 message，否则 String 转换，保证错误文案可显示。
		const message = error instanceof Error ? error.message : String(error);
		// 把原错误信息和目标路径组合后抛出；不吞掉损坏文件。
		throw new Error(`Failed to read trust store ${path}: ${message}`);
	}

	// typeof null 也是 object，所以需单独排除 null；数组也不能当作路径字典。
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		// 形状不合法直接报错，不用空字典掩盖已有配置损坏。
		throw new Error(`Invalid trust store ${path}: expected an object`);
	}

	// 重新构造只含已校验值的字典。
	const data: TrustFile = {};
	// Object.entries 取键值对；for...of 配合解构一次得到 key 和 value。
	for (const [key, value] of Object.entries(parsed)) {
		// 外部值只能是三个明确字面量，不接受字符串 "true"、0 或嵌套对象。
		if (value !== true && value !== false && value !== null) {
			// 错误用 JSON.stringify 包裹键，避免路径引号让文案含糊。
			throw new Error(`Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`);
		}
		// 通过校验后才把值放入结果字典。
		data[key] = value;
	}
	// 返回已验证字典，后续最近祖先查询不需要重复验证其值形状。
	return data;
}

/**
 * 按路径键排序后保存整份字典；会创建父目录、覆盖文件，失败向上传出。
 * 只写 true/false/null，省略 undefined；JSON 使用两空格缩进并保留末尾换行。此函数自身不加锁，调用者须用 withTrustFileLock；也没有临时文件原子替换。
 */
function writeTrustFile(path: string, data: TrustFile): void {
	// 新对象专门控制序列化键顺序，不改变传入 data 的键顺序。
	const sorted: TrustFile = {};
	// sort 的默认字符串排序使文件 diff 更稳定，不改变查找祖先的路径规则。
	for (const key of Object.keys(data).sort()) {
		// 字典索引得到对应决定。
		const value = data[key];
		// 仅写合法决定；undefined 不会写入文件。
		if (value === true || value === false || value === null) {
			// 按已排序的遍历顺序插入结果。
			sorted[key] = value;
		}
	}
	// recursive:true 允许父目录已存在或多层缺失；仍可能因权限失败。
	mkdirSync(dirname(path), { recursive: true });
	// 同步覆盖 UTF-8 JSON 文件；不能因为上层加锁就认为写入具备断电回滚保证。
	writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf-8");
}

/**
 * 同步获取信任文件对应的锁，成功返回释放函数，失败抛异常。
 * 遇 ELOCKED 最多尝试 10 次，间隔忙等约 20ms；其他错误立即抛。例：另一会话短暂保存时重试，不把锁冲突误当坏 JSON。
 */
function acquireTrustLockSync(path: string): () => void {
	// 锁的资源目标用信任文件父目录，该目录可在文件尚未创建时存在。
	const trustDir = dirname(path);
	// 拿锁前确保父目录存在；所以纯查询也可能创建存储目录。
	mkdirSync(trustDir, { recursive: true });
	// 最多 10 次尝试包含第一次，不是失败后再重试 10 次。
	const maxAttempts = 10;
	// 两次冲突尝试之间约等待 20 毫秒，不是整个操作的硬超时。
	const delayMs = 20;
	// 保存最近锁异常；unknown 保留可能的非 Error 抛出值。
	let lastError: unknown;

	// 从 1 开始计数，<= 使第 10 次仍执行一次。
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		// 每次尝试独立捕获锁错误以决定能否重试。
		try {
			// 显式 lockfilePath 指向 trust.json.lock；realpath:false 避免库要求资源目标先做真实路径解析。成功立即返回 release。
			return lockfile.lockSync(trustDir, { realpath: false, lockfilePath: `${path}.lock` });
			// 只有加锁操作抛出的错误在这个 catch 里处理。
		} catch (error) {
			// 错误来源是第三方 I/O 边界；下面先安全读取可选 code。
			const code =
				// 检查错误确为非空对象且存在 code 字段，才能按对象使用。
				typeof error === "object" && error !== null && "code" in error
					? // as 仅告知 TypeScript 这个已检查字段可读，不会把异常变成新对象。
						String((error as { code?: unknown }).code)
					: // 没有 code 就不匹配 ELOCKED，走立即抛出的路径。
						undefined;
			// 只有锁占用且尚未到最后一次才等待；其他错误或最后失败立即传出。
			if (code !== "ELOCKED" || attempt === maxAttempts) {
				// 保留原始异常，调用方可继续判断其 code。
				throw error;
			}
			// 记录锁占用异常，供循环后的兜底分支使用。
			lastError = error;
			// 用墙上时间计算短同步等待的起点。
			const start = Date.now();
			// 忙等会占用线程，期间不能处理本进程其他 JS 回调；不是异步 sleep。
			while (Date.now() - start < delayMs) {
				// Sleep synchronously to avoid changing trust store callers to async.
			}
		}
	}

	// 通常失败已在循环中抛出；这是循环外的防漏兜底。
	if (lastError instanceof Error) {
		// 若记录的是 Error，重新抛原错误。
		throw lastError;
	}
	// 没有可用 Error 时抛统一锁失败信息。
	throw new Error("Failed to acquire trust store lock");
}

/**
 * 在同步锁内执行回调，返回其原始结果，并用 finally 释放锁。
 * 泛型 T 把回调返回类型传到外层；例如回调返回 ProjectTrustStoreEntry|null，外层也保持这个联合类型。这里不 await Promise，只适用于当前同步读改写。
 */
function withTrustFileLock<T>(path: string, fn: () => T): T {
	// 成功得到释放函数后才进入 try，拿锁失败不会调用一个不存在的 release。
	const release = acquireTrustLockSync(path);
	// 锁已持有，开始执行同步工作。
	try {
		// 返回 fn() 的结果；若它抛异常仍会先走 finally。
		return fn();
		// 正常返回或抛异常都会执行清理。
	} finally {
		// 释放锁；释放自身若失败也会抛，不能宣称所有锁故障都被吞掉。
		release();
	}
}

/**
 * Returns true when cwd has project-local resources that must be gated by
 * project trust: trust-requiring entries under cwd/.pi, or .agents/skills in
 * cwd or one of its ancestors. Returns false when no such project resources
 * exist. The user/global ~/.agents/skills directory is always treated as a
 * trusted user resource and is ignored here, even when cwd is $HOME.
 */
/**
 * 检测 cwd 是否有受信任开关控制的项目资源，不读取正文、不执行扩展。
 * 先查当前 cwd/.pi 的固定入口，再逐级查 .agents/skills；只排除用户主目录自身那份 .agents/skills。例：父目录的 .agents/skills 会触发检查，父目录 .pi/settings.json 不在此向上扫描。
 */
export function hasTrustRequiringProjectResources(cwd: string): boolean {
	// 优先非空 HOME，否则系统 homedir；路径归一化便于与祖先资源位置比较。
	const homeDir = canonicalizePath(resolvePath(process.env.HOME || homedir()));
	// 用户全局技能目录不作为项目资源要求重新信任。
	const userAgentsSkillsDir = join(homeDir, ".agents", "skills");
	// 当前查找位置从 cwd 开始，后面会逐级改为父目录。
	let currentDir = canonicalizePath(resolvePath(cwd));

	// 项目配置入口只检查当前工作目录，不在所有父目录重复检查。
	const configDir = join(currentDir, CONFIG_DIR_NAME);
	// some 任一入口存在就 true；存在不等于它内容有效或一定是预期文件类型。
	if (TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES.some((entry) => existsSync(join(configDir, entry)))) {
		// 已发现当前 .pi 下受控入口，不必再扫描祖先技能目录。
		return true;
	}

	// 扫描 .agents/skills 的祖先链直到根目录。
	while (true) {
		// 为当前层级拼出候选技能目录。
		const agentsSkillsDir = join(currentDir, ".agents", "skills");
		// 先排除用户全局技能路径，再查候选存在；Windows 比较会按平台规则折叠大小写。
		if (!pathsEqual(agentsSkillsDir, userAgentsSkillsDir) && existsSync(agentsSkillsDir)) {
			// 任意非用户全局候选存在，就需要信任判定。
			return true;
		}

		// 计算下一层父目录。
		const parentDir = dirname(currentDir);
		// 父目录等于自身表示已到根。
		if (parentDir === currentDir) {
			// 两种入口都没发现，返回 false。
			return false;
		}
		// 继续检查上一层的 .agents/skills。
		currentDir = parentDir;
	}
}

/**
 * 同步信任库：每次查询重新读磁盘，保存时锁内读改写，没有长期缓存决定。
 * 例：new ProjectTrustStore(agentDir).set("/work",true) 后查询 /work/app 可继承；set("/work",null) 删除该独立记录。
 */
export class ProjectTrustStore {
	// private 约束 TypeScript 访问权限；这里不是运行时 # 私有字段。
	private trustPath: string;

	/**
	 * 构造时只解析 agentDir 并记录 trust.json 路径；尚不创建目录或读取文件。
	 * 例：agentDir=/tmp/pi-agent，则信任库路径为 /tmp/pi-agent/trust.json。
	 */
	constructor(agentDir: string) {
		// join 生成文件路径；resolvePath 对 ~ 和相对路径做展开/绝对化。
		this.trustPath = join(resolvePath(agentDir), "trust.json");
	}

	/**
	 * 返回当前目录继承得到的 true/false，未找到返回 null；不返回命中祖先路径。
	 * 例：父目录为 false，则子目录 get 也是 false。查询会拿锁，文件/锁错误可抛出。
	 */
	get(cwd: string): ProjectTrustDecision {
		// ?. 在没有命中项时得 undefined；?? 回退 null，不会丢失 false。
		return this.getEntry(cwd)?.decision ?? null;
	}

	/**
	 * 锁内读取文件并返回最近祖先的完整命中项；缺失决定返回 null。
	 * 例：/work=true，查询 /work/app 得到 {path:"/work",decision:true}。读操作也可能创建父目录，但不会为缺文件写空 JSON。
	 */
	getEntry(cwd: string): ProjectTrustStoreEntry | null {
		// 箭头函数捕获 this.trustPath/cwd，在同一同步锁区间执行。
		return withTrustFileLock(this.trustPath, () => {
			// 从磁盘获取本次最新字典，不沿用实例构造时的旧快照。
			const data = readTrustFile(this.trustPath);
			// 查找本目录，再依次查祖先，保留命中路径。
			return findNearestTrustEntry(data, cwd);
		});
	}

	/**
	 * 保存单目录决定；委托批量接口，避免另写一套锁和序列化逻辑。
	 * 例：set(cwd,false) 持久化拒绝，set(cwd,null) 删除本目录决定；I/O 错误向上传出。
	 */
	set(cwd: string, decision: ProjectTrustDecision): void {
		// 把单项更新包成数组；path:cwd 把变量 cwd 放到 path 字段，decision 则是 decision:decision 的属性简写。
		this.setMany([{ path: cwd, decision }]);
	}

	/**
	 * 在一把锁中读文件、按顺序应用多条更新、排序保存；返回 void，失败抛异常。
	 * 例：先父目录 true 再当前目录 null，实现继承父目录。同一归一化路径多次出现时后项最终生效；整次覆盖写入并非可回滚事务。
	 */
	setMany(decisions: ProjectTrustUpdate[]): void {
		// 对整个读改写过程加锁，而不是每条更新单独锁。
		withTrustFileLock(this.trustPath, () => {
			// 先读最新记录，避免覆盖其他遵守此锁的会话已提交内容。
			const data = readTrustFile(this.trustPath);
			// 解构每条更新；path 在本局部作用域表示本条路径，不是存储文件路径。
			for (const { path, decision } of decisions) {
				// 归一化生成本条应使用的持久化键。
				const key = normalizeCwd(path);
				// 找出与归一化新键按平台路径规则相等的已有键；不会替每个旧键再次解析软链接。
				for (const existingKey of findTrustFileKeys(data, key)) {
					// delete 删除对象属性，清掉旧大小写或路径表达，后面最多写一个规范键。
					delete data[existingKey];
				}
				// null 表示只删不加；false 仍须写入。
				if (decision !== null) {
					// 写入归一化键和明确布尔决定。
					data[key] = decision;
				}
			}
			// 所有更新应用完才一次性保存；空更新列表仍会走一次读写，因此 UI 调用方另有空数组保护。
			writeTrustFile(this.trustPath, data);
		});
	}
}
