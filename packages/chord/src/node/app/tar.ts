// A minimal ustar (POSIX tar) writer and reader for the kit's address archives (slice 13 §4): regular files and
// directories, paths of at most 255 bytes, nothing else. The reader is a trust boundary: an archive may come from
// anywhere, so it refuses every entry that is no regular file or directory, a path that is absolute, holds `..`, a
// backslash or NUL, or names an empty segment, and a header whose checksum does not hold.

// 所属：packages/chord/src/node/app，app kit 的极简 ustar 读写器（slice 13 §4）。
// 职责边界：只写普通文件和目录并读取/校验 tar；不决定归档内容，不访问目标目录。
// 上游：archive.ts 的 packStore/unpackEntries；下游：Node 的字节流 API。
// 结果与错误：writeTar/readTar 逐块产出；路径非法、类型不支持、校验和错误、截断或长度不符都抛错。
// 能力清单：TarEntry/TarRead 是类型；BLOCK 是块大小；writeTar 写归档；header/field/checkPath 生成并校验头；readTar 读归档；parseHeader/text 解析头；ByteReader 抹平分块边界。
// 组合顺序：writeTar → header → checkPath；readTar → ByteReader → parseHeader → checkPath → data。
// 示例：for await (const entry of readTar(stream)) if (entry.kind === 'file') for await (const chunk of entry.data) use(chunk)。
// 建议阅读顺序：先看 TarEntry/TarRead 与 writeTar/readTar，再看 header/parseHeader/checkPath，最后 ByteReader。
/** One entry to write: its path (`/`-separated, relative) and its bytes, as a size and the chunks that make it up. */
// TarEntry 是写入端的一项：路径以 / 分隔且相对，size 是字节数，data 是异步字节块。
export type TarEntry = { readonly path: string; readonly size: number; readonly data: AsyncIterable<Uint8Array> };

/** One entry read: a regular file (its data, to be consumed before the next entry) or a directory. */
// TarRead 是读取端的标签联合：file 带可消费的数据流，directory 只有路径；kind 让调用方安全收窄。
export type TarRead =
	| { readonly kind: "file"; readonly path: string; readonly size: number; readonly data: AsyncIterable<Uint8Array> }
	| { readonly kind: "directory"; readonly path: string };

// tar 以 512 字节块为单位；常量放在首次使用处上方。
/** A tar block. */
const BLOCK = 512;

// 把条目序列写成 tar 字节块：entries 可以是同步或异步可迭代对象，返回异步生成器，逐块产出。
// 副作用是读取每个 entry.data；若数据长度与 size 不符会抛错，错误信息含路径。
// 例子：writeTar([{ path: 'manifest.json', size: 2, data: ... }]) 先写头部和数据，再写填充，最后两个零块结束归档。
/** The archive of `entries`, as the chunks of its bytes (two zero blocks end it). */
export async function* writeTar(entries: AsyncIterable<TarEntry> | Iterable<TarEntry>): AsyncGenerator<Uint8Array> {
	// for await 同时支持异步和同步 iterable；每次取一项。
	for await (const entry of entries) {
		// 每个文件先写 512 字节头，头里的 size 必须与实际字节数一致。
		yield header(entry.path, entry.size);
		// written 统计实际写入字节数，用来发现数据流与声明的 size 不符。
		let written = 0;
		// 逐块消费 entry.data；块大小任意，不要求 512 对齐。
		for await (const chunk of entry.data) {
			// 先累加再比较，超过声明 size 立即失败，避免写出错位归档。
			written += chunk.length;
			// 超过 size 是写入端错误，不是读取器可以修复的问题。
			if (written > entry.size) throw new Error(`tar: ${entry.path} is larger than its size ${entry.size}`);
			yield chunk;
		}
		// 数据不足同样报错，防止头部与后续条目错位。
		if (written !== entry.size) throw new Error(`tar: ${entry.path} is ${written} bytes, not ${entry.size}`);
		// pad 把文件内容补齐到 512 的整数倍；公式在 size 已对齐时得到 0。
		const pad = (BLOCK - (entry.size % BLOCK)) % BLOCK;
		// 需要时写一个全零填充块，填充不计入文件大小。
		if (pad > 0) yield new Uint8Array(pad);
	}
	// 两个全零块是 tar 的结束标记；读取器遇到第一个全零块就返回。
	yield new Uint8Array(BLOCK * 2);
}

// 生成普通文件的 ustar 头：path 先经过 checkPath，size 写成八进制；返回 512 字节块。
// 路径超过 100 字节时拆成 prefix/name；仍放不下或 size 非法时抛错。例子：header('files/a', 3) 只生成头，不读文件内容。
/** The ustar header of a regular file at `path` of `size` bytes. */
function header(path: string, size: number): Uint8Array {
	// 写入前先拒绝读取端也会拒绝的路径，保证自己写的归档能被自己读回。
	checkPath(path);
	// 整个头部是一个零初始化的 512 字节块。
	const block = new Uint8Array(BLOCK);
	// 路径按 UTF-8 编码；ustar 字段是字节而非字符。
	const bytes = new TextEncoder().encode(path);
	// 默认把整个路径放进 name 字段，prefix 为空。
	let name = bytes;
	let prefix = new Uint8Array();
	// ustar 的 name 字段只有 100 字节，超出时尝试拆分。
	if (bytes.length > 100) {
		// Split at a `/` so the name has at most 100 bytes and the prefix at most 155.
		// lastIndexOf 从末尾找最后一个斜杠，把路径分成目录前缀和文件名；at 是字符下标。
		const at = path.lastIndexOf("/", path.length - 1);
		// split 是前缀的 UTF-8 字节长度，用于从 bytes 中切出 prefix。
		const split = new TextEncoder().encode(path.slice(0, at)).length;
		// 没有斜杠、前缀超过 155 字节或文件名超过 100 字节都放不下。
		if (at < 0 || split > 155 || bytes.length - split - 1 > 100) throw new Error(`tar: the path ${path} is too long`);
		// name/prefix 是原字节数组的视图，不复制内容。
		prefix = bytes.subarray(0, split);
		name = bytes.subarray(split + 1);
	}
	// 把文件名写入偏移 0 的 100 字节字段。
	block.set(name, 0);
	// mode/uid/gid 固定为 0644、0、0；这里的 0644 只是头字段，实际私有权限由解包后代码设置。
	field(block, 100, 8, "0000644");
	field(block, 108, 8, "0000000");
	field(block, 116, 8, "0000000");
	// size 写成 11 位八进制加 NUL；padStart 补前导零。
	field(block, 124, 12, size.toString(8).padStart(11, "0"));
	// mtime 用当前秒数写成八进制；多行调用是 field 的参数列表。
	field(
		block,
		136,
		12,
		Math.floor(Date.now() / 1000)
			.toString(8)
			.padStart(11, "0"),
	);
	// 先把校验和字段填成 8 个空格，计算时按空格计入。
	block.fill(0x20, 148, 156);
	// typeflag 为字符 0，表示普通文件。
	block[156] = 0x30;
	// magic 是 ustar 加版本 00；\u0000 是 NUL 的转义写法。
	block.set(new TextEncoder().encode("ustar\u000000"), 257);
	// prefix 放在偏移 345，最大 155 字节。
	block.set(prefix, 345);
	// 校验和是整块所有字节之和，此时校验和字段仍是空格。
	const sum = block.reduce((total, byte) => total + byte, 0);
	// 把六位八进制和 NUL 加空格写回校验和字段；这是 ustar 规定的格式。
	field(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\u0000 `);
	return block;
}

// 把 ASCII 文本写入固定宽度字段；文本过长抛错，剩余字节保持零。输入是块、偏移、长度和文本，无返回值。
/** Writes `text` (ASCII) at `offset` of `block`, NUL-terminated within `length`. */
function field(block: Uint8Array, offset: number, length: number, text: string): void {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length > length) throw new Error(`tar: ${text} does not fit ${length} bytes`);
	block.set(bytes, offset);
}

// 验证归档内路径可安全用作相对文件路径；不合法时抛错，合法时无返回值。
// 拒绝空字符串、反斜杠（Windows 分隔符）、NUL、绝对路径，以及空段、.、.. 段。
// 例子：'files/a' 通过，'../evil' 和 'a//b' 被拒绝；此函数只检查字符串，不访问磁盘。
/** Refuses a path an archive may not hold: absolute, with `..`, `.`, an empty segment, a backslash or a NUL. */
function checkPath(path: string): void {
	// 按 / 切段，供逐段检查。
	const segments = path.split("/");
	// 三个字符串级拒绝：空路径、反斜杠、NUL、前导斜杠；bad 为 true 时后面仍会计算 segments。
	const bad = path === "" || path.includes("\\") || path.includes("\u0000") || path.startsWith("/");
	// some 在找到第一个坏段时短路；空段来自连续斜杠或结尾斜杠。
	if (bad || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		// JSON.stringify 让错误信息中的控制字符可见；错误会终止整个导入。
		throw new Error(`tar: the path ${JSON.stringify(path)} is refused`);
	}
}

// 逐项读取 tar 流：source 是异步字节块，返回异步生成器。每项的数据必须在请求下一项前消费完。
// 读取器是信任边界，任何不合规条目都会抛错；遇到第一个全零块就正常结束。
// 例子：for await (const entry of readTar(stream)) 按 manifest、store、files 的顺序处理。
/**
 * Reads the archive `source` entry by entry (each file's data read fully before the next entry is asked for), refusing
 * what it may not hold (see the file's header).
 */
export async function* readTar(source: AsyncIterable<Uint8Array>): AsyncGenerator<TarRead> {
	// ByteReader 抹平底层分块边界，让头部和数据都按精确长度读取。
	const reader = new ByteReader(source);
	// 无限循环由零块或抛错结束。
	for (;;) {
		// 头部固定 512 字节。
		const block = await reader.read(BLOCK);
		// 不足一个头说明归档被截断。
		if (block.length < BLOCK) throw new Error("tar: the archive ends inside a header");
		// 全零块是归档结束标记；every 对 512 字节做检查。
		if (block.every((byte) => byte === 0)) return;
		// 解析并验证头部；返回的 type 已收窄为 file 或 directory。
		const { path, size, type } = parseHeader(block);
		// 文件数据按 512 字节向上取整，目录也以同样规则占位。
		const padded = Math.ceil(size / BLOCK) * BLOCK;
		// 目录条目没有数据内容。
		if (type === "directory") {
			// 先 yield 目录，再跳过其填充块。
			yield { kind: "directory", path };
			// skip 会从流中丢弃目录的 0 字节数据区（通常是 0 长度）。
			await reader.skip(padded);
			continue;
		}
		// left 跟踪消费者还剩多少字节没读。
		let left = size;
		// 异步生成器只在消费者迭代 data 时拉取；这样大数据不会一次性进内存。
		const data = (async function* () {
			// 每次最多读 64 KiB，直到文件数据读完。
			while (left > 0) {
				// Math.min 防止预读超过本文件的数据区。
				const chunk = await reader.read(Math.min(left, 64 * 1024));
				// 流提前结束说明归档截断，错误里带路径便于定位。
				if (chunk.length === 0) throw new Error(`tar: the archive ends inside ${path}`);
				// 减去本次实际读到的字节数。
				left -= chunk.length;
				// 把数据块交给调用方；这些字节不包含填充。
				yield chunk;
			}
		})();
		// yield 文件条目；调用方可能不消费 data，因此下一行负责跳过剩余部分。
		yield { kind: "file", path, size, data };
		// What the consumer left unread (also when it ended the data's iteration early), then the padding.
		// left 是未读数据，padded - size 是填充；两者一起跳过，读取器才能对齐到下一个头。
		await reader.skip(left + padded - size);
	}
}

// 解析并验证头部：返回路径、size 和类型；校验和不符、类型不支持或路径非法时抛错。
/** A header's path, size and type, its checksum checked; anything but a regular file or a directory refused. */
function parseHeader(block: Uint8Array): {
	readonly path: string;
	readonly size: number;
	readonly type: "file" | "directory";
} {
	// 校验和字段本身是八进制文本；trim 去掉 NUL 和空格。
	const stored = Number.parseInt(text(block, 148, 8).trim(), 8);
	// 按 ustar 规则重新计算整块的字节和。
	let sum = 0;
	// 148 到 155 是校验和字段，计算时按空格 0x20 处理。
	for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
	// 存储值与计算值不等说明头部损坏或被篡改，拒绝整个归档。
	if (stored !== sum) throw new Error("tar: a header's checksum does not hold");
	// typeflag 是单个字节转成的字符。
	const flag = String.fromCharCode(block[156]!);
	// '0' 或 NUL 表示普通文件，'5' 表示目录；其他类型得到 undefined。
	const type = flag === "0" || flag === "\u0000" ? "file" : flag === "5" ? "directory" : undefined;
	// 符号链接、硬链接、设备、FIFO 等一律拒绝，避免导入时跟随到目标路径之外。
	if (type === undefined) throw new Error(`tar: an entry of type ${JSON.stringify(flag)} is refused (files only)`);
	// prefix 和 name 都是 NUL 结尾字段。
	const prefix = text(block, 345, 155);
	const name = text(block, 0, 100);
	// 拼成完整路径并去掉目录条目末尾的斜杠；空 prefix 时只用 name。
	const path = (prefix === "" ? name : `${prefix}/${name}`).replace(/\/$/, "");
	// 对最终路径做与写入端相同的安全检查。
	checkPath(path);
	// size 是八进制文本；空字段按 0 处理。
	const size = Number.parseInt(text(block, 124, 12).trim() || "0", 8);
	// 拒绝负数、非整数或超过安全整数范围的 size，防止分配或跳过计算溢出。
	if (!Number.isSafeInteger(size) || size < 0) throw new Error(`tar: ${path} has no valid size`);
	// 目录的 size 统一按 0 返回；文件保留解析值。
	return { path, size: type === "directory" ? 0 : size, type };
}

// 读取头部字段的 NUL 结尾文本；没有 NUL 时取整个字段。
/** The NUL-terminated text of a header field. */
function text(block: Uint8Array, offset: number, length: number): string {
	// subarray 是原块的视图，不复制。
	const bytes = block.subarray(offset, offset + length);
	// indexOf(0) 找第一个 NUL。
	const end = bytes.indexOf(0);
	// 按 UTF-8 解码为字符串。
	// 截到 NUL 之前；没有 NUL 就用完整字段。
	return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

// 把任意分块的字节流包装成可按长度读取的读取器；内部保留未消费的剩余字节。
/** Reads exactly as many bytes as asked from a stream of chunks (fewer only at its end). */
class ByteReader {
	// source 是底层异步迭代器，buffer 是尚未交出的字节。
	readonly #source: AsyncIterator<Uint8Array>;
	#buffer = new Uint8Array();

	// 构造时取得异步迭代器；之后的 read 都通过 next 拉取块。
	constructor(source: AsyncIterable<Uint8Array>) {
		this.#source = source[Symbol.asyncIterator]();
	}

	// 读取至多 length 字节；流先结束则返回实际可用字节。返回值可能是 next.value 的视图。
	/** Up to `length` bytes: `length` unless the stream ends first. */
	async read(length: number): Promise<Uint8Array> {
		// 持续拉取直到缓冲区够长或流结束。
		while (this.#buffer.length < length) {
			// next() 返回 { value, done }；done 时不再有数据。
			const next = await this.#source.next();
			// 流结束就跳出，返回缓冲区现有内容。
			if (next.done === true) break;
			// 合并旧缓冲与新块；每次扩容分配新数组，读取路径较简单但不适合超大块。
			const joined = new Uint8Array(this.#buffer.length + next.value.length);
			// 先复制旧内容。
			joined.set(this.#buffer);
			// 把新块写在旧内容之后。
			joined.set(next.value, this.#buffer.length);
			// 替换缓冲区引用。
			this.#buffer = joined;
		}
		// 取前 min(length, 可用) 字节；subarray 与缓冲区共享内存。
		const taken = this.#buffer.subarray(0, Math.min(length, this.#buffer.length));
		// 剩下的字节留到下一次读取。
		this.#buffer = this.#buffer.subarray(taken.length);
		// 返回本次取出的视图。
		return taken;
	}

	// 跳过 length 字节；流提前结束抛错。内部循环按 64 KiB 读取并丢弃。
	/** Skips `length` bytes. */
	async skip(length: number): Promise<void> {
		// 剩余待跳过字节数。
		let left = length;
		// 循环直到全部跳过。
		while (left > 0) {
			// 每次最多读 64 KiB，避免大块一次性分配。
			const skipped = await this.read(Math.min(left, 64 * 1024));
			// 读不到任何字节说明归档截断。
			if (skipped.length === 0) throw new Error("tar: the archive ends early");
			// 减去本次跳过的长度。
			left -= skipped.length;
		}
	}
}
