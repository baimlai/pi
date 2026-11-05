// Secrets of the app kit (slice 13 §2): tokens from `crypto.randomBytes`, kept only as their SHA-256 hashes and
// compared in constant time, and secret files (the cookie key, the owner token file) created with mode 0600 in one
// step, so no other OS user and no half-written file ever reads them.

// 所属：packages/chord/src/node/app，app kit 的凭据与密钥文件工具（slice 13 §2）。
// 职责边界：生成随机 token、计算和比较摘要、原子读写 0600 密钥文件；不决定会话内容或权限策略。
// 上游：sessions/owner/pairing/invite/app 调用；下游：node:crypto 与 node:fs/promises。
// 结果与错误：newToken/hashToken/matchesHash/secretFile/readSecret/writeSecret 返回文本或布尔值；文件 I/O、ENOENT 以外的读取错误和过长字段会抛错。
// 能力清单：newToken 生成 base64url；hashToken 生成 SHA-256 hex；matchesHash 恒定时间比较；secretFile 读或创建；readSecret 读取并 trim；writeSecret 以 create/replace 原子发布。
// 组合顺序：secretFile → readSecret → newToken → writeSecret；会话侧 newToken → hashToken → matchesHash。
// 示例：const token = newToken(12); const hash = hashToken(token); matchesHash(token, hash) === true。
// 建议阅读顺序：先看 newToken/hashToken/matchesHash，再看 secretFile/readSecret，最后 writeSecret 的临时文件、链接和重命名流程。
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { link, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A fresh random token of `bytes` bytes, base64url. */
// 生成不可预测的随机凭据文本，bytes 默认 32，返回 base64url；例如 bytes: 12 产生 12 个随机字节的编码。
// 调用加密随机源并分配 Buffer；随机源异常直接传播，函数不会保存凭据。
export function newToken(bytes = 32): string {
	// randomBytes 同步取得指定数量的字节，toString 转成无加号、斜杠或填充等号的 base64url 文本。
	return randomBytes(bytes).toString("base64url");
}

/** The hash a token is kept as (SHA-256, hex): what leaks from a store is no credential. */
// 对 token 做 SHA-256，返回十六进制摘要，不保存或修改输入；例如同一 token 每次得到同一摘要。
// 摘要不是加密，验证时重新计算并比较，随机 token 的不可猜测性来自 newToken。
export function hashToken(token: string): string {
	// 链式调用建立散列、写入 token 的 UTF-8 文本、输出 hex 字符串。
	return createHash("sha256").update(token).digest("hex");
}

/** Whether `token` hashes to `hash`, compared in constant time. */
// 验证 token 是否对应已保存的摘要；返回布尔值，无 I/O。例：正确 token 为 true，错误 token 为 false。
// 固定长度摘要使用 timingSafeEqual，长度不同先返回 false，避免该 API 抛出长度错误。
export function matchesHash(token: string, hash: string): boolean {
	// 先计算候选 token 摘要，再按 hex 解码为字节；不是比较明文凭据。
	const given = Buffer.from(hashToken(token), "hex");
	// 将保存的 hex 摘要解码到同样形式。
	const kept = Buffer.from(hash, "hex");
	// && 短路保证只有等长 Buffer 才调用恒定时间比较。
	return given.length === kept.length && timingSafeEqual(given, kept);
}

/** The secret in the file at `path`, created (mode 0600, in one step) with a fresh token when it does not exist yet. */
// 取得持久密钥文件；存在就复用，不存在则生成并尝试独占创建。返回密钥文本，文件错误向上传播。
// 例如两个启动者同时创建时，失败者读取先写入的内容；此函数不会主动调整已有文件权限。
export async function secretFile(path: string): Promise<string> {
	// 等待读取现有文本，ENOENT 在 readSecret 中转成 undefined。
	const existing = await readSecret(path);
	// 已有密钥直接返回，保持重启后的 cookie 签名一致。
	if (existing !== undefined) return existing;
	// 没有文件才消耗随机数产生新密钥。
	const secret = newToken();
	// create 使用硬链接发布，不覆盖并发创建者的文件。
	const written = await writeSecret(path, secret, "create");
	// 若发布时已经存在，重新读取赢家的密钥；意外读取不到时回退为本次生成值。
	return written === "exists" ? ((await readSecret(path)) ?? secret) : secret;
}

/** The text of the secret file at `path`, or `undefined` when it does not exist. */
// 读取 UTF-8 文件并去掉首尾空白；找不到返回 undefined，其他错误抛给调用者。
// 例如文件内容 token 后跟换行，结果只含 token；这里只读本机文件，不验证凭据身份。
export async function readSecret(path: string): Promise<string | undefined> {
	// 捕获异步 readFile 的拒绝；类型断言仅让 TypeScript 读取 Node 错误码。
	try {
		// await 等到整个文件读完，再 trim；这会去掉换行及其他首尾空白。
		return (await readFile(path, "utf8")).trim();
	} catch (error) {
		// 只吞掉文件不存在的错误，权限、I/O 等失败继续抛出。
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Writes `text` to `path` with mode 0600 in one step: a temporary file of the same directory (made exclusively, 0600)
 * linked into place (`create`: refused when `path` exists, `"exists"` returned) or renamed over it (`replace`).
 */
// 把 text 加换行写入同目录临时文件，再按 mode 发布；create 保留旧文件，replace 通过 rename 覆盖。
// 返回 written 或 exists；例如 owner token 失效时用 replace 换新。写入和发布涉及磁盘，失败通常向上传播。
export async function writeSecret(
	path: string,
	text: string,
	mode: "create" | "replace",
): Promise<"written" | "exists"> {
	// 随机临时名放在目标目录，便于 link/rename 在同一文件系统发布。
	const temporary = join(dirname(path), `.${newToken(9)}.tmp`);
	// wx 要求新建且目标不存在，0o600 是仅当前用户可读写的八进制权限。
	const handle = await open(temporary, "wx", 0o600);
	try {
		// 先写完整文本和换行，再 sync 请求落盘；写入阶段异常仍会执行下面的 close。
		await handle.writeFile(`${text}\n`);
		// 等待文件内容同步；不等于额外同步父目录。
		await handle.sync();
	} finally {
		// finally 中关闭临时文件描述符；此阶段失败不会进入后面的发布和 unlink 块。
		await handle.close();
	}
	try {
		// replace 分支把完整临时文件重命名到目标；成功后原临时名消失。
		if (mode === "replace") {
			// 等待原子名字替换；此处不先删除旧目标。
			await rename(temporary, path);
			return "written";
		}
		// create 分支建立目标硬链接；目标已存在会抛 EEXIST，不能覆盖它。
		await link(temporary, path);
		return "written";
	} catch (error) {
		// 发布遇到 EEXIST 转成 exists；其他错误保留。
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
		throw error;
	} finally {
		// 发布块无论结果都尝试删临时名；rename 后已不存在也忽略清理错误。
		await unlink(temporary).catch(() => {});
	}
}
