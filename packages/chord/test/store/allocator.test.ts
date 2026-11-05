// Tests of the id allocator (slice 6b D3, §1.2): from 2, raised by explicit ids, saturating at the safe range.

import { describe, expect, it } from "vitest";
import { FIRST_ID, IdAllocator } from "../../src/store/allocator.ts";

// describe 的回调只登记下面的测试；实际分配动作在各 it 回调运行时发生，不写数据库。
describe("the allocator", () => {
	// 用 2、3、100、50 这组输入检查分配和抬高计数器；返回 void，只有局部计数器改变。
	// 例如 raise(100) 后下一次 mint() 是 101，较小的 raise(50) 不会把它降回去。
	it("mints from its value, and an explicit id raises it above itself, never lowering it", () => {
		// FIRST_ID 为 2；1 留给 Durable 的根对话，构造函数保存的是“下一次可分配值”。
		const ids = new IdAllocator(FIRST_ID);
		// 数组元素从左到右求值；两次 mint 都会让内部计数器加一。
		expect([ids.mint(), ids.mint()]).toEqual([2, 3]);
		// 模拟调用方已经显式使用 id=100；raise 将下一次分配移到它后面。
		ids.raise(100);
		// toBe 比较数值；此处 mint 自身还会把下一次值推进到 102。
		expect(ids.mint()).toBe(101);
		// 已使用过的小 id 不应影响现在的高水位。
		ids.raise(50);
		// value 是只读 getter，读取它不会再消耗一个 id。
		expect(ids.value).toBe(102);
	});

	// 从安全整数上限前一位开始，验证饱和后的拒绝；示例中 MAX_SAFE_INTEGER 本身不由 mint 分配。
	// 回调不接收业务参数、不返回业务结果；toThrow 必须接函数，才能捕获调用时同步抛出的错误。
	it("saturates at Number.MAX_SAFE_INTEGER: that id may be written, every later mint is refused", () => {
		// JS 的 number 只能精确表达一定范围内的整数，避免超过上限后出现重复 id。
		const ids = new IdAllocator(Number.MAX_SAFE_INTEGER - 1);
		// 倒数第二个安全整数仍可分配，随后计数器到达上限。
		expect(ids.mint()).toBe(Number.MAX_SAFE_INTEGER - 1);
		// 这里检查 allocator 的错误消息；没有真的执行“写入上限 id”的数据库步骤。
		expect(() => ids.mint()).toThrow("ID space is exhausted");
		// raise 接受显式使用的上限 id，但计数器继续停在上限，不越界。
		ids.raise(Number.MAX_SAFE_INTEGER);
		// 饱和值可以读取，不能再用于 mint。
		expect(ids.value).toBe(Number.MAX_SAFE_INTEGER);
		// 再次调用仍然拒绝，证明前一次失败没有绕过饱和状态。
		expect(() => ids.mint()).toThrow("ID space is exhausted");
	});
});
