/**
 * 文件导读（doom-overlay 的 WAD 查找与下载）
 *
 * 所属与用途：本文件属于 `doom-overlay` 示例，负责为 DOOM 引擎提供 WAD 数据文件：
 * 优先复用已有文件，找不到时从固定 URL 下载共享版 WAD（gzip），校验 IWAD 魔数后写入
 * 示例目录旁的 `doom1.wad`。它不加载 WASM、不启动游戏。
 *
 * 上游如何进入：`doom-overlay/index.ts` 在用户没有传路径时调用 `ensureWadFile()`；
 * 用户传了路径时绕开本文件。`DoomEngine.init()` 再读取返回的路径。
 *
 * 能力清单：
 * - `findWadFile(customPath?)`：只查找，不下载；返回绝对路径或 null。
 * - `ensureWadFile()`：查找或下载，返回路径或 null。
 * - 常量：`BUNDLED_WAD`（缓存位置）、`WAD_URL`（下载源）、`DEFAULT_WAD_PATHS`（默认候选）。
 *
 * 典型运行顺序：
 *   1. `/doom-overlay` 无参数 -> `ensureWadFile()`；
 *   2. 先查模块旁的 `doom1.wad`，再查 `./doom1.wad`、`./DOOM1.WAD`、`~/doom1.wad`、`~/.doom/doom1.wad`；
 *   3. 都没有则 `fetch` 下载 -> `gunzipSync` 解压 -> 检查前 4 字节为 `IWAD` -> 写入缓存；
 *   4. 任一步失败返回 null，命令 handler 显示下载失败通知。
 *
 * 示例（真实签名，可能联网并写文件）：
 *   const path = await ensureWadFile();
 *   if (!path) console.error("WAD unavailable");
 * 首次成功运行后，模块目录旁会多出 `doom1.wad`（被 `.gitignore` 忽略）。
 *
 * 建议阅读顺序：先看常量与 `findWadFile` 的优先级，再看 `ensureWadFile` 的错误边界。
 *
 * 安全/正确性边界：下载内容只校验魔数，不校验哈希或完整目录结构；`fetch` 没有超时和大小上限；
 * 错误被吞成 null，调用方无法区分网络、解压还是写盘失败。
 */

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

/**
 * 查找可用的 WAD 文件，不下载。
 *
 * 输入：可选 `customPath`。非空时只检查这一处；空或省略时按默认优先级查找。
 * 输出：存在时返回绝对路径，否则返回 null。
 * 副作用：只读文件系统（`existsSync`）；不写文件、不联网。
 * 错误路径：不抛错；权限不足等情况下 `existsSync` 返回 false，最终得到 null。
 * 主要流程：有自定义路径则展开 `~`、绝对化并直接判断 -> 否则先查模块旁缓存
 * -> 再按顺序遍历默认候选（每个同样展开 `~`）。
 * 注意：只判断路径存在，不验证是文件还是目录，也不验证 WAD 内容；显式路径无效时不会回退。
 *
 * 示例：`findWadFile("./game.wad")` 在文件存在时返回其绝对路径；
 * `findWadFile("~/.doom/doom1.wad")` 会先把 `~` 替换为 `process.env.HOME`。
 */
export function findWadFile(customPath?: string): string | null {
	// 非空自定义路径优先；空字符串会走默认查找。
	if (customPath) {
		// replace 的 /^~/ 只替换开头一个波浪号；HOME 不存在时用空串，`~/x` 会变成根路径 `/x`。
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
/**
 * 确保有一个可用 WAD：先查找，缺失时下载并缓存。
 *
 * 输入：无。输出：`Promise<string | null>`，成功为绝对路径，失败为 null。
 * 副作用：可能访问网络（一次 GET）、同步解压、同步写入模块旁的 `doom1.wad`。
 * 错误路径：HTTP 非 2xx、解压失败、魔数不符、写盘失败都在 try 内捕获并返回 null；
 * `findWadFile()` 在 try 外，若它本身抛错（正常不会）会向上传播。
 * 主要流程：先查现有文件 -> fetch -> 检查响应 -> 读完整响应体 -> gunzip -> 校验 `IWAD`
 * -> 写入缓存 -> 返回路径。
 * 注意：没有超时、大小限制或重试；并发调用可能同时下载并互相覆盖同一文件。
 *
 * 示例：`await ensureWadFile()` 首次运行返回 `/.../doom-overlay/doom1.wad` 并写入该文件；
 * 再次运行直接返回同一路径，不联网。
 */
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
