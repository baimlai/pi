// 验证 principal（调用者身份）的规范化 JSON 键、按对象缓存和弱引用回收；不进行身份认证。
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { canonicalJson, principalKey } from "../../src/data/internal.ts";
import { counted, expectCollected } from "../support.ts";

// 分组回调只登记测试；规范化函数接受 JSON 值和记录成本的 Context，返回确定的字符串。
describe("canonicalJson", () => {
	// 无参回调用嵌套对象和 -0 作输入，预期键排序、负零写成 0；例子只涉及 JSON 字符串，没有 I/O。
	it("sorts object keys and writes -0 as 0", () => {
		// 外层 b/a、内层 d/c 都故意逆序，固定期望同时覆盖递归排序。
		expect(canonicalJson({ b: 1, a: [{ d: -0, c: null }] }, BACKGROUND_CONTEXT)).toBe(
			'{"a":[{"c":null,"d":0}],"b":1}',
		);
		// 字符串也要遵守 JSON 引号规则，返回值不是原始的 x。
		expect(canonicalJson("x", BACKGROUND_CONTEXT)).toBe('"x"');
	});

	// async 回调返回 Promise<void>；counted 注入带内存遥测的上下文并读取计数，预期一次规范化计作一次遍历。
	// 例子 {a:[1,2]} 不计编译或参数验证；失败由 Vitest 断言报告。
	it("counts one walk", async () => {
		// 箭头回调收到 counted 提供的 Context，而不是使用全局后台上下文；await 等待计数收集结束。
		expect(await counted((context) => canonicalJson({ a: [1, 2] }, context))).toEqual({
			walks: 1,
			validations: 0,
			compilations: 0,
		});
	});
});

// principalKey 的缓存按 principal 对象身份区分；内容相同的两个对象键相同，但不是同一个缓存项。
describe("principalKey", () => {
	// 无参同步回调比较两个字段顺序相反的身份；预期都得到同一规范化文本，只创建内存对象。
	it("defaults to the canonical JSON, whatever the property order", () => {
		// 默认规则按字段名排序，所以 id 位于 kind 前。
		expect(principalKey({ kind: "user", id: "u1" }, BACKGROUND_CONTEXT)).toBe('{"id":"u1","kind":"user"}');
		// 比较两次调用结果，证明调用者写对象字段的顺序不会拆分身份键。
		expect(principalKey({ id: "u1", kind: "user" }, BACKGROUND_CONTEXT)).toBe(
			principalKey({ kind: "user", id: "u1" }, BACKGROUND_CONTEXT),
		);
	});

	// 无参回调传入自定义键函数，预期 user/u1 得到 user:u1；函数只计算字符串，不认证用户。
	it("uses a custom key function when given", () => {
		// 参数后面的对象类型由 TypeScript 检查；模板字符串拼接 kind 和 id，运行时不再检查这两个字段。
		const byId = (principal: { kind: string; id: string }) => `${principal.kind}:${principal.id}`;
		// 第三参替代默认 canonicalJson 规则。
		expect(principalKey({ kind: "user", id: "u1" }, BACKGROUND_CONTEXT, byId)).toBe("user:u1");
	});

	// 同一个 principal 连续取键，预期第一次遍历、第二次命中缓存；async 回调只等待内存计数器采集。
	it("caches per principal object: no second walk", async () => {
		// 保存对象身份，否则两个相同的字面量会是两个独立缓存键。
		const principal = { kind: "user", id: "u1" };
		// 这次创建默认键并记录一次规范化遍历。
		const first = await counted((context) => principalKey(principal, context));
		// 换一个计数 Context 不影响缓存身份：缓存属于 principal。
		const second = await counted((context) => principalKey(principal, context));
		// 此处只比较 walks，其他计数由 canonicalJson 的专用测试覆盖。
		expect([first.walks, second.walks]).toEqual([1, 0]);
	});

	// 用带计数副作用的函数证明同一函数缓存一次，另一函数和默认规则互不串用；无参回调只修改局部 calls。
	it("caches custom keys per function", () => {
		// 三种键规则都应用在同一对象上。
		const principal = { kind: "user", id: "u1" };
		// let 允许闭包在被调用时更新局部计数。
		let calls = 0;
		// ++calls 先加一再插入字符串；第二次若真的执行会返回 key2。
		const custom = () => `key${++calls}`;
		// 数组里的两次调用应复用 custom 的第一次结果。
		expect([
			principalKey(principal, BACKGROUND_CONTEXT, custom),
			principalKey(principal, BACKGROUND_CONTEXT, custom),
		]).toEqual(["key1", "key1"]);
		// 新的箭头函数具有不同身份，使用自己的缓存与规则。
		expect(principalKey(principal, BACKGROUND_CONTEXT, () => "other")).toBe("other");
		// 不传第三参又回到默认规范化 JSON。
		expect(principalKey(principal, BACKGROUND_CONTEXT)).toBe('{"id":"u1","kind":"user"}');
	});

	// 在 principal 仍可达时丢弃自定义函数，预期弱缓存不把它保活；异步结果依赖测试环境可触发 GC。
	// 立即调用的内层无参函数只返回 WeakRef，例子中的 custom 返回固定 k，无外部副作用。
	it("never retains a dropped custom key function while its principal lives", async () => {
		// 外层在 GC 检查后还会读取 principal，使其继续保持强引用。
		const principal = { kind: "user", id: "u1" };
		// IIFE：定义后立即执行，把 custom 的强引用限制在此作用域。
		const ref = (() => {
			// 创建待测试回收的自定义键函数。
			const custom = () => "k";
			// 先实际使用，确保测试覆盖缓存已建立的情况。
			principalKey(principal, BACKGROUND_CONTEXT, custom);
			// WeakRef 不阻止函数被回收；离开该作用域后不再有 custom 的局部强引用。
			return new WeakRef(custom);
		})();
		// helper 通过测试 GC 设施尝试回收并断言弱引用目标消失，超限会让测试失败。
		await expectCollected(ref);
		// principal 此时仍可用，也仍能按默认规则生成字符串键。
		expect(principalKey(principal, BACKGROUND_CONTEXT)).toBeTypeOf("string");
	});

	// 在小作用域中建立两种缓存后只留下弱引用，预期 principal 可回收；无网络和持久化写入。
	it("does not retain dropped principals", async () => {
		// 内层回调的返回类型由 TS 推断为 WeakRef，不把 principal 本身返回。
		const ref = (() => {
			// 这个对象应在 IIFE 返回后失去局部强引用。
			const principal = { kind: "user", id: "gone" };
			// 覆盖默认 WeakMap 的键路径。
			principalKey(principal, BACKGROUND_CONTEXT);
			// 同时覆盖自定义函数下的第二层 WeakMap。
			principalKey(principal, BACKGROUND_CONTEXT, () => "k");
			// 只留下弱引用供 helper 观察回收。
			return new WeakRef(principal);
		})();
		// 验证这些缓存没有因为保存键而延长 principal 的生命周期。
		await expectCollected(ref);
	});
});
