// 文件导读（Durable 测试工具层：断言适配器）
//
// 所属模块：packages/durable/src/testing。本目录属于 pi-durable 包对外发布的测试辅助入口
// （package.json 的 "./testing" 子路径导出）。上游是各存储后端测试（memory/sqlite/jsonl/
// indexeddb/store）与 ExecutionEnv 测试；下游刻意不依赖 vitest 或 jest 的具体包，只要求调用方
// 传入一个兼容的 expect 函数。
//
// 职责边界：storage-conformance 和 env-conformance 在运行时不 import 任何测试框架，只依赖本文件
// 定义的窄接口 StorageConformanceAssertions。createExpectAssertions 把 Vitest/Jest 风格的 expect
// 适配成该接口，因此同一套契约用例能在不同 runner 中复用。本文件不做断言判断，也不捕获错误；
// 断言失败如何抛出由传入的 expect 实现决定。
//
// 能力清单：
// - ExpectLike：调用方 expect 的最小调用形状（被测值 + 可选消息）。
// - ExpectResult：适配器实际使用的断言方法子集，纯编译期形状，没有运行时校验。
// - createExpectAssertions(expect)：返回实现 StorageConformanceAssertions 的对象。
//
// 组合关系/典型调用：测试文件把 vitest 的 { describe, expect, it } 交给 runner.ts，
// runner 再调用 createExpectAssertions(runner.expect) 生成契约套件需要的断言集合。示例：
//   const assertions = createExpectAssertions(expect);
//   assertions.deepEqual(await storage.conversation(ROOT_CONVERSATION_ID, context), { id: ROOT_CONVERSATION_ID });
// 注意：上面传入的是测试框架的 expect，而不是本文件返回的普通函数；返回值同样可调用。
//
// 建议阅读顺序：先看 types.ts 的 StorageConformanceAssertions → ExpectLike/ExpectResult →
// createExpectAssertions 的映射表；最后的 rejects 分支单独看。
// 仅类型导入：运行时不加载 types.ts，避免测试辅助文件之间形成值依赖。
import type { StorageConformanceAssertions } from "./types.ts";

// 调用方提供的 expect 函数形状。第一个参数是被测值，第二个是可选失败消息；
// 返回类型故意写成 unknown，因为 Vitest 与 Jest 的返回对象细节不同，
// 具体可用的断言方法由下面的 ExpectResult 在内部收窄。
// 这完全是编译期约束：运行时不会检查传入函数是否真的接收 message。
export type ExpectLike = (actual: unknown, message?: string) => unknown;

// 适配器内部使用的断言子集。其中 rejects 是嵌套对象：expect(promise).rejects.toThrow(...)。
// 所有方法返回 unknown，适配器只关心调用是否抛错，不消费返回值。
// 这些字段只在 TypeScript 编译期存在，运行时没有对应对象。
type ExpectResult = {
	toBe(expected: unknown): unknown;
	toBeGreaterThan(expected: number): unknown;
	toEqual(expected: unknown): unknown;
	toMatchObject(expected: unknown): unknown;
	toBeTruthy(): unknown;
	readonly rejects: {
		toThrow(expected?: string | RegExp): unknown;
	};
};

// 把兼容 Vitest/Jest 的 expect 包装成 runner 无关的断言接口。
// 输入：expect —— 测试框架提供的断言函数（例如 vitest 的 expect）。
// 输出：实现 StorageConformanceAssertions 的对象，供存储与环境契约套件调用。
// 副作用：无；只有每次调用断言时才委托给传入的 expect。
// 错误路径：断言失败由底层 expect 抛出，本函数不吞掉也不改写错误。
// 主流程：先做一次类型断言，再把六个契约断言方法映射到底层 expect 的对应方法。
// 例子：createExpectAssertions(expect).strictEqual(2, 2)；失败时由 vitest 的 expect 抛错。
/** Adapts a Vitest/Jest-compatible `expect` function without importing either runner. */
// 参数类型 ExpectLike 保证调用方至少能接收 (actual, message)；
// 返回类型 StorageConformanceAssertions 是结构性接口，下面返回的对象字面量会自动满足它。
export function createExpectAssertions(expect: ExpectLike): StorageConformanceAssertions {
	// result 是一个小包装：接收实际值并可选消息，再断言返回值为 ExpectResult。
	// as ExpectResult 只是告诉 TypeScript 采用这个更具体的形状，编译后完全擦除，
	// 运行时仍是底层 expect 返回的原对象；传入的 expect 若不支持这些方法会在调用时失败。
	const result = (actual: unknown, message?: string): ExpectResult => expect(actual, message) as ExpectResult;
	// 返回对象使用接口方法简写（method shorthand），每个方法对应契约套件的一种断言。
	// TypeScript 按结构检查它是否实现 StorageConformanceAssertions，不需要写 implements。
	return {
		// ok：只要求值为真值。注意 0、空字符串、null 都会失败，它不是严格的布尔 true 检查。
		ok(value, message) {
			// 委托给 toBeTruthy；message 原样传给底层 expect 作为失败信息。
			result(value, message).toBeTruthy();
		},
		// strictEqual：用 toBe 做严格同一性比较；在 Vitest 中采用 Object.is 语义，
		// 因此 NaN 等于 NaN，而 +0 与 -0 不相等。
		strictEqual(actual, expected) {
			// actual 以 unknown 进入适配器；这里不再做类型校验，直接交给底层 expect。
			result(actual).toBe(expected);
		},
		// deepEqual：用 toEqual 做递归结构比较，适合记录对象/数组等 JSON 形状的值。
		deepEqual(actual, expected) {
			result(actual).toEqual(expected);
		},
		// partialDeepEqual：用 toMatchObject 只比较期望对象中出现的字段，
		// 未列出的额外字段不影响通过；用于断言记录的一个子集。
		partialDeepEqual(actual, expected) {
			result(actual).toMatchObject(expected);
		},
		// greaterThan：两个参数在接口上都声明为 number，比较交给 toBeGreaterThan；
		// 这里不处理 NaN 或非数字，因为类型层面已经限定。
		greaterThan(actual, expected) {
			result(actual).toBeGreaterThan(expected);
		},
		// rejects：等待 operation 失败，并检查错误消息包含 messageIncludes。
		// Promise.resolve(actual) 兼容直接传入 Promise 或 thenable 的情况；
		// 如果 operation 正常完成，rejects.toThrow 本身会让这次断言失败。
		// 与普通断言不同，这里必须 await，否则拒绝不会被观察到。
		async rejects(operation, messageIncludes) {
			// toThrow(string) 在 Vitest/Jest 中按错误消息的子串匹配；传入 RegExp 时同样可用，
			// 但本适配器的契约只暴露 string。
			await result(operation).rejects.toThrow(messageIncludes);
		},
	};
}
