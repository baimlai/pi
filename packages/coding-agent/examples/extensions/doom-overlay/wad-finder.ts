import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

// Get the bundled WAD path (relative to this module)
// import.meta.url 是当前模块的 file URL；先转本机路径再取目录，避免依赖启动时的工作目录。
const __dirname = dirname(fileURLToPath(import.meta.url));
// 下载缓存放在示例模块旁边，不是用户的当前目录。
const BUNDLED_WAD = join(__dirname, "doom1.wad");
// 固定的共享版 WAD gzip 下载地址；此处声明不会联网。
const WAD_URL = "https://www.gamers.org/pub/idgames/idstuff/doom/doom-1.8.wad.gz";

// 按此顺序寻找相对工作目录和家目录中的候选文件。
const DEFAULT_WAD_PATHS = ["./doom1.wad", "./DOOM1.WAD", "~/doom1.wad", "~/.doom/doom1.wad"];

// 只查找文件，不下载；可选 customPath 表示只查这一处，成功返回绝对路径，失败返回 null。
// 先展开开头的 ~，否则先查模块缓存再遍历默认位置；existsSync 只检查存在，不验证 WAD 内容。
// 例：findWadFile("./game.wad") 返回现有文件的绝对路径；显式路径无效时不会再尝试默认文件。
export function findWadFile(customPath?: string): string | null {
	// 非空自定义路径优先；空字符串会走默认查找。
	if (customPath) {
		// replace 的 /^~/ 只替换开头一个波浪号；HOME 不存在时用空串，resolve 再按 cwd 生成绝对路径。
		const resolved = resolve(customPath.replace(/^~/, process.env.HOME || ""));
		// 该路径存在便返回，不区分普通文件与目录。
		if (existsSync(resolved)) return resolved;
		// 指定路径不存在，立即报告找不到。
		return null;
	}

	// Check bundled WAD first
	// 默认模式先命中模块旁缓存，避免后面再扫描。
	if (existsSync(BUNDLED_WAD)) {
		// 返回拼出的模块旁绝对路径。
		return BUNDLED_WAD;
	}

	// Fall back to default paths
	// for...of 按数组顺序逐个取路径字符串。
	for (const p of DEFAULT_WAD_PATHS) {
		// 每个默认候选同样做简单的 ~ 展开及绝对化。
		const resolved = resolve(p.replace(/^~/, process.env.HOME || ""));
		// 第一个存在的候选获胜；全部失败才落到循环后的 null。
		if (existsSync(resolved)) return resolved;
	}

	// 没有命中任何默认位置。
	return null;
}

/** Download the shareware WAD if not present. Returns path or null on failure. */
// 保证默认位置有可用候选：先找现有路径，否则下载、解压、检查前四字节并同步写缓存。
// 无参数，Promise 最终给路径或 null；网络、解压、写入失败在 try 内被吞为 null，查找阶段在 try 外。
// 例：已有 doom1.wad 时直接返回路径；首次缺失可能联网写入本目录，调用者必须 await。
export async function ensureWadFile(): Promise<string | null> {
	// Check if already exists
	// 调用只读查找；这里不检查已存在文件的 IWAD 标头。
	const existing = findWadFile();
	// 找到候选就结束，不下载也不写文件。
	if (existing) return existing;

	// Download to bundled location
	// 将下载、解压、校验和写缓存纳入同一失败边界。
	try {
		// await 等待 HTTP 响应头；fetch 的网络拒绝会进入 catch。
		const response = await fetch(WAD_URL);
		// HTTP 非 2xx 不当作可用压缩包。
		if (!response.ok) {
			// 构造包含 HTTP 状态的异常，随后统一转成 null。
			throw new Error(`HTTP ${response.status}`);
		}
		// 先异步读完整响应体，再创建 Node Buffer 并同步 gzip 解压；会占用整份文件内存。
		const wad = gunzipSync(Buffer.from(await response.arrayBuffer()));
		// 外部下载内容的运行时边界：只核对 IWAD 魔数，不等于验证全部 WAD 结构。
		if (wad.subarray(0, 4).toString("ascii") !== "IWAD") {
			// 标头不符即失败，不写入缓存。
			throw new Error("Downloaded file is not a valid IWAD");
		}
		// 同步覆盖模块旁文件；目录不可写等异常也会被下方 catch 捕获。
		writeFileSync(BUNDLED_WAD, wad);
		// 写入成功才返回缓存路径。
		return BUNDLED_WAD;
		// 不向上传播本 try 的错误，也不额外显示错误信息。
	} catch {
		// 调用者收到 null 后决定怎样提示用户。
		return null;
	}
}
