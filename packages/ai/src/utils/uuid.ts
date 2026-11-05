// 生成 UUIDv7 消息/请求标识：时间戳放高位，进程序列配合随机字节；不是持久数据库发号器。
// UUIDv7 时间字段是 48 位无符号毫秒值；十六进制常数表示允许上限。
const MAX_UUID_V7_TIMESTAMP = 0xffffffffffff;
// n 后缀是 BigInt；左移构造 41 位序列上限，不能直接与普通 number 混算。
const MAX_SEQUENCE = (1n << 41n) - 1n;

// 保存未显式指定时间时的上次时间，防止系统时钟回拨让普通新 id 时间倒退。
let lastOrdinaryTimestamp = -1;
// 进程内共享序列，第一次调用才用随机字节初始化。
let sequence: bigint | undefined;

/** Generate a time-ordered UUIDv7. A supplied timestamp is preserved for follower ids. */
// 用途：生成带毫秒时间信息的 UUIDv7。默认当前时间；传入时间可让 follower id 保留来源时间。例 uuidv7(1700000000000) 每次仍用不同序列/随机值；非法时间或序列耗尽抛 RangeError，会推进模块序列。
export function uuidv7(timestampMs?: number): string {
	// 未提供显式时间才读系统时钟；0 是合法显式值，不会被 ?? 丢掉。
	const requestedTimestamp = timestampMs ?? Date.now();
	// 公开输入边界验证整数、非负和48位范围；number 类型并不保证值满足这些约束。
	if (!Number.isInteger(requestedTimestamp) || requestedTimestamp < 0 || requestedTimestamp > MAX_UUID_V7_TIMESTAMP) {
		// 无法编码的时间明确报错，而非悄悄截断成另一个时间。
		throw new RangeError(`UUIDv7 timestamp must be an integer between 0 and ${MAX_UUID_V7_TIMESTAMP}`);
	}

	// 下面区分普通新 id 与刻意沿用历史时间的 follower id。
	const effectiveTimestamp =
		// 普通路径取当前/上次较大值抵御回拨；显式时间严格保留，不做这个矫正。
		timestampMs === undefined ? Math.max(requestedTimestamp, lastOrdinaryTimestamp) : timestampMs;
	// 只普通路径更新记住的时间；历史 follower 不影响之后普通发号。
	if (timestampMs === undefined) lastOrdinaryTimestamp = effectiveTimestamp;

	// UUID 共128位，即16个字节；Uint8Array 每项只存0到255。
	const bytes = new Uint8Array(16);
	// 用运行时密码学随机源填满字节，后面会覆盖时间、版本和序列位。
	globalThis.crypto.getRandomValues(bytes);
	// 第一次调用时初始化序列起点，之后每次递增。
	if (sequence === undefined) {
		// 把随机字节拼成一个初始 BigInt 序列数。
		sequence =
			// 第一个参与序列的字节放到较高位；| 是按位或，用来拼接不重叠的位。
			(BigInt(bytes[1]) << 32n) |
			// 下一个字节向左移24位。
			(BigInt(bytes[2]) << 24n) |
			// 再拼入16位位置的随机字节。
			(BigInt(bytes[3]) << 16n) |
			// 再拼入8位位置的随机字节。
			(BigInt(bytes[4]) << 8n) |
			// 最后一个字节放低位；整个初始值来自五个随机字节。
			BigInt(bytes[5]);
	} else {
		// 达到序列上限就拒绝，不允许绕回造成同进程序列重复。
		if (sequence === MAX_SEQUENCE) throw new RangeError("UUIDv7 generator sequence exhausted");
		// BigInt 自增，每次调用推进一次，不是按毫秒重置。
		sequence++;
	}

	// 把已验证 number 时间转换成 BigInt，后面用位运算拆字节。
	const timestamp = BigInt(effectiveTimestamp);
	// 从第5字节往第0字节填48位时间戳，形成高位在前的字节顺序。
	for (let index = 5; index >= 0; index--) {
		// 按8位分段右移，再 &0xff 只保留最低字节；转回 number 才能放 Uint8Array。
		bytes[index] = Number(timestamp >> BigInt((5 - index) * 8)) & 0xff;
	}
	// 高半字节固定版本7，低半字节填序列最高4位。
	bytes[6] = 0x70 | Number((sequence >> 37n) & 0x0fn);
	// 继续放入序列8位。
	bytes[7] = Number((sequence >> 29n) & 0xffn);
	// 高位固定 UUID 变体10，其余6位继续填序列。
	bytes[8] = 0x80 | Number((sequence >> 23n) & 0x3fn);
	// 继续填下一个序列字节。
	bytes[9] = Number((sequence >> 15n) & 0xffn);
	// 继续填低位序列字节。
	bytes[10] = Number((sequence >> 7n) & 0xffn);
	// 序列剩7位放入字节高7位，最低1位保留原随机值；后面几个字节也保持随机。
	bytes[11] = Number((sequence & 0x7fn) << 1n) | (bytes[11] & 0x01);

	// 每字节转2位十六进制，不足用0补齐，得到16项字符串数组。
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	// 按 UUID 的8-4-4-4-12字符格式分组加连字符；slice 的结束下标不包含在结果中。
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
