import { afterEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../src/utils/uuid.ts";

// 正则从 ^ 到 $ 检查整个小写 UUID：版本位固定 7，变体位为 8/9/a/b；不验证时间顺序或随机性。
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// 0x 表示十六进制，选一个 48 位内的固定毫秒值，方便检查编码后的前 12 个十六进制字符。
const TIMESTAMP = 0x0123456789ab;

// 输入 UUID 字符串，去连字符后把前 12 个十六进制数字转回毫秒数，无副作用。
// 例：00000000-0001-7... 的时间字段解析为 1；本辅助函数不检查输入格式，格式由用例另行断言。
function parseTimestamp(uuid: string): number {
	// replaceAll 返回新串，slice 结束下标不包含 12，parseInt 的第二参数 16 指定进制。
	return Number.parseInt(uuid.replaceAll("-", "").slice(0, 12), 16);
}

// 每例运行后恢复计时器和替换过的全局变量，无参数无返回；例如 crypto 替身不会泄漏到下一例。
afterEach(() => {
	// 恢复真实时钟；不会重置 uuid 模块内部的进程序列或上次普通时间。
	vi.useRealTimers();
	// 撤销 vi.stubGlobal 安装的替身。
	vi.unstubAllGlobals();
});

// 注册 UUIDv7 的同步测试组；describe 回调只声明用例，不生成 UUID。
describe("uuidv7", () => {
	// 固定/回拨/推进时钟并生成普通和 follower id，断言本批格式、唯一性与时间字段；失败由 expect 抛出。
	it("generates ordered UUIDv7s while preserving follower timestamps", () => {
		// 使用 Vitest 虚拟时钟，避免实际机器时间影响断言。
		vi.useFakeTimers();
		// 先设为固定毫秒值。
		vi.setSystemTime(TIMESTAMP);

		// 不传时间走普通路径，并推进 uuid 模块共享序列。
		const first = uuidv7();
		// 同毫秒第二个普通 id 仍应不同。
		const second = uuidv7();
		// 模拟系统时间后退 1 毫秒。
		vi.setSystemTime(TIMESTAMP - 1);
		// 普通路径应保留上一次有效时间，不能跟随时钟倒退。
		const afterRollback = uuidv7();
		// 再把时钟推进到初始时间之后 1 毫秒。
		vi.setSystemTime(TIMESTAMP + 1);
		// 这次应使用新的较大时间。
		const afterAdvance = uuidv7();
		// 数组顺序就是本批普通 id 的生成顺序。
		const ordinaryIds = [first, second, afterRollback, afterAdvance];
		// 数字中的 _ 是可读性分隔符，1_000 与 1000 相同。
		const followerTimestamp = TIMESTAMP - 1_000;
		// 显式传旧时间两次：这是保留来源时间的 follower，不走普通时间防回拨规则。
		const followers = [uuidv7(followerTimestamp), uuidv7(followerTimestamp)];

		// ... 展开两组数组，逐个验证版本和变体等字符串格式。
		for (const id of [...ordinaryIds, ...followers]) expect(id).toMatch(UUID_V7_RE);
		// sort 会改数组，所以先展开复制；默认字符串排序应与本批普通 id 的生成顺序相同。
		expect(ordinaryIds).toEqual([...ordinaryIds].sort());
		// Set 去重后大小不变，说明这四个普通 id 没重复，非全局唯一性的数学证明。
		expect(new Set(ordinaryIds)).toHaveLength(ordinaryIds.length);
		// map 把函数作为回调，抽取时间字段，检查回拨被钳住而推进被保留。
		expect(ordinaryIds.map(parseTimestamp)).toEqual([TIMESTAMP, TIMESTAMP, TIMESTAMP, TIMESTAMP + 1]);
		// 显式旧时间不能被普通路径记忆的较新时间覆盖。
		expect(followers.map(parseTimestamp)).toEqual([followerTimestamp, followerTimestamp]);
		// 同一来源时间的两个 follower 也应不重复。
		expect(new Set(followers)).toHaveLength(followers.length);
	});

	// 用可预测随机源替换 crypto，检查每次调用都重新填尾部；这例不评估真实密码学随机源质量。
	it("uses fresh randomness for every UUID tail", () => {
		// 闭包保存调用次数，初值为 0。
		let randomByte = 0;
		// 临时替换全局 crypto；测试结束由 afterEach 恢复。
		vi.stubGlobal("crypto", {
			// 输入可写字节数组，先递增计数再填满并返回原数组；例第一次填 1，第二次填 2。
			getRandomValues(bytes: Uint8Array) {
				// ++ 在前表示先加一，fill 会就地写数组。
				return bytes.fill(++randomByte);
			},
		});

		// slice(-8) 只看最后 8 个十六进制字符，避开前面的时间/序列位。
		expect([uuidv7(TIMESTAMP).slice(-8), uuidv7(TIMESTAMP).slice(-8)]).toEqual(["01010101", "02020202"]);
	});

	// it.each 为数组的两个合法边界各建一例；例如最大值为 48 位全部为 1。
	it.each([0, 2 ** 48 - 1])("accepts timestamp boundary %s", (timestamp) => {
		// 显式生成后解析，确认没有截断边界时间；** 是幂运算。
		expect(parseTimestamp(uuidv7(timestamp))).toBe(timestamp);
	});

	// 表驱动覆盖负值、溢出、小数、NaN 和无穷大；回调的 timestamp 类型仍只是 number。
	it.each([-1, 2 ** 48, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid timestamp %s", (timestamp) => {
		// 传函数给 toThrow 使调用发生在断言内部，验证运行时 RangeError；并不只依赖 TypeScript。
		expect(() => uuidv7(timestamp)).toThrow(RangeError);
	});
});
