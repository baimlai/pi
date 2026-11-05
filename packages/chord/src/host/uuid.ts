// UUIDv7 (§3, code copied from pi-ai's `uuidv7`): time-ordered ids, minted for host incarnations.
// 本文件负责生成宿主的 incarnation id：高 48 位是毫秒时间戳，因此后生成的 id 整体更大；同一毫秒内再用 41 位序列区分。
// 上游是建立宿主身份和激活链的代码；返回值是 36 个字符的 UUID 字符串。文件只维护两个模块级计数器，不读写数据库。
// 所属模块：packages/chord/src/host 的宿主身份层（incarnation id 生成）。
// 上下游：宿主创建/激活时进入 uuidv7()；无下游依赖，输出字符串交给宿主状态。错误只有序列耗尽的普通 Error。
// 能力清单：
// - MAX_SEQUENCE：同一毫秒内允许的最大 41 位序列。
// - lastTimestamp / sequence：模块级状态，保证时钟回拨与同毫秒内单调。
// - uuidv7()：唯一导出，返回时间有序的 UUIDv7 字符串。
// 组合关系：一次 uuidv7() = 读取/修正时间戳 -> 初始化或递增序列 -> 写版本与变体位 -> 格式化为十六进制。
// 示例：const incarnation = uuidv7(); // 形如 "018f0c1e-9a3b-7c4d-8e5f-0123456789ab"（仅示意形状）。
// 阅读顺序：先读 MAX_SEQUENCE 与两个状态变量，再读 uuidv7 的时间、序列、位布局三段，最后看格式化。

// 41 位能表示的最大序列。`1n` 是 bigint 字面量（后缀 n），超出 Number 安全整数也能精确移位。
// 到达上限后同一毫秒无法继续保证唯一，所以下一行生成会直接报错，而不会回绕复用编号。
const MAX_SEQUENCE = (1n << 41n) - 1n;

/** The last timestamp used: a clock going backwards keeps the ids ordered. */
// 模块级可变状态（测试中会跨调用保留）。系统时钟回拨时，下一次仍取不小于它的时间，避免新 id 排到旧 id 前面。
let lastTimestamp = -1;

/** A random start, then incremented per id, so ids within one millisecond stay ordered and unique. */
// `bigint | undefined` 是联合类型：首次生成前没有起点，所以是 undefined；第一次调用后才换成具体的 bigint。
// 起点随机，避免不同进程在同一毫秒从相同序列开始而碰撞。
let sequence: bigint | undefined;

/** A time-ordered UUIDv7. */
// 生成一个按时间排序的 UUIDv7 字符串。无输入参数；副作用是推进模块级的 lastTimestamp 和 sequence。
// 正常返回 36 字符的小写十六进制字符串；同一毫秒序列耗尽时抛 RangeError。
// 主要流程：取不倒退的当前时间 → 准备 16 个随机字节 → 首次用随机数作序列、之后自增 → 写入时间、版本位、变体位 → 格式化为 UUID。
// 示例：const a = uuidv7(); const b = uuidv7(); 两次都返回字符串，通常 a < b；示例只说明形状，不保证跨进程唯一。
export function uuidv7(): string {
	// Date.now 返回毫秒数；Math.max 让时钟回拨时不小于上次时间，保证 id 的字典序与生成顺序一致。
	const timestamp = Math.max(Date.now(), lastTimestamp);
	// 立刻记住本次时间，供下一次比较。这两行是模块级状态的唯一写入点。
	lastTimestamp = timestamp;
	// Uint8Array(16) 分配 16 个 0..255 的字节，正好是 UUID 的 128 位；随机数由 Web Crypto 填充。
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	// 只在首次生成时初始化序列：取 5 个随机字节拼成 41 位以内的数。
	// `bytes[1]!` 是 TS 的非空断言：类型上数组下标可能越界，但这里长度固定为 16，! 不产生运行时检查。
	if (sequence === undefined) {
		// BigInt(...) 把字节转成 bigint；`<<` 与 `|` 按位拼装，形成 8+8+8+8+8 位的随机序列。
		sequence =
			(BigInt(bytes[1]!) << 32n) |
			(BigInt(bytes[2]!) << 24n) |
			(BigInt(bytes[3]!) << 16n) |
			(BigInt(bytes[4]!) << 8n) |
			BigInt(bytes[5]!);
	} else {
		// 序列用完必须抛错：继续加一会回绕，可能生成与旧 id 相同的值。
		if (sequence === MAX_SEQUENCE) throw new RangeError("UUIDv7 generator sequence exhausted");
		// 同一毫秒的下一次生成得到下一个序列。
		sequence++;
	}
	// 时间戳转 bigint 后写入前 6 个字节（48 位，大端序：高位在前）。
	const time = BigInt(timestamp);
	// 循环从索引 5 到 0，每次取出时间的一个字节；`& 0xff` 只保留低 8 位，Number 转回普通数字。
	for (let index = 5; index >= 0; index--) bytes[index] = Number(time >> BigInt((5 - index) * 8)) & 0xff;
	// 第 7 个字节的高 4 位固定为 0111，即 UUID 版本 7；低 4 位放序列的最高 4 位。
	bytes[6] = 0x70 | Number((sequence >> 37n) & 0x0fn);
	// 接着 8 位序列。
	bytes[7] = Number((sequence >> 29n) & 0xffn);
	// 第 9 个字节的高 2 位固定为 10（RFC 4122 变体），低 6 位继续放序列。
	bytes[8] = 0x80 | Number((sequence >> 23n) & 0x3fn);
	// 再填两个完整字节。
	bytes[9] = Number((sequence >> 15n) & 0xffn);
	bytes[10] = Number((sequence >> 7n) & 0xffn);
	// 序列剩下 7 位放进下一个字节的高 7 位，最低位保留原来的随机位，避免浪费随机性。
	bytes[11] = Number((sequence & 0x7fn) << 1n) | (bytes[11]! & 0x01);
	// 每个字节转两位十六进制；Array.from 的第二个参数是映射回调，padStart(2, "0") 补前导零。
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	// 按 8-4-4-4-12 分组插入连字符；模板字符串把数组片段拼接为最终 UUID 文本。
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
