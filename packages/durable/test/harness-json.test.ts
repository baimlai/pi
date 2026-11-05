// 验证流式 JSON 合并保留 __proto__ 自有字段，同时不污染全局对象原型。
import { type JsonValue, track } from "@earendil-works/chord/delta";
import { describe, expect, it } from "vitest";
import { assignJson } from "../src/harness/json.ts";

// ? 允许 message 尚不存在；JsonValue 限制编译时值域为 JSON 可表示的值。
type Doc = { message?: JsonValue };

// 把 value 写入 tracker 的 message：开启草稿、逐叶合并、准备并接纳改变；返回 void。
// ReturnType<typeof track<Doc>> 从泛型函数提取跟踪器类型，as Doc 只是类型断言。
// 例：先写 args.path=x 再写 xy，会走已有嵌套对象的合并路径；异常直接交给测试。
function assign(tracker: ReturnType<typeof track<Doc>>, value: JsonValue): void {
	// 新建可修改的 change 草稿，此时还没有更新 tracker 的已接纳值。
	const change = tracker.beginChange();
	// 只赋 message 槽位，由 assignJson 决定替换还是递归合并。
	assignJson(change.state as Doc, "message", value);
	// prepare 生成准备好的变化；adopt 把它变成跟踪器当前状态。
	tracker.adopt(change.prepare());
}

// 分组注册安全回归用例；没有外部存储、认证或网络。
describe("assignJson", () => {
	// 无参数；两次写入后检查原型与自有属性。失败由 Vitest 的断言抛出。
	// JSON.parse 是关键：它把 __proto__ 当数据字段，而非对象字面量的特殊语法。
	it("does not merge a new __proto__ member into Object.prototype", () => {
		// 空文档让第一次写入创建 args 容器，第二次才测试合并行为。
		const tracker = track<Doc>({});
		assign(tracker, { args: JSON.parse('{"path":"x"}') });
		// 新数据同时延长 path 并加入恶意字段，覆盖增量更新路径。
		assign(tracker, { args: JSON.parse('{"path":"xy","__proto__":{"polluted":true}}') });

		// Record<string, unknown> 只让 TS 允许读字段；{} 仍是真实的新普通对象。
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		// as 声明本夹具已知形状，不会验证 JSON；从当前状态取出 args。
		const args = (tracker.value.message as { args: object }).args;
		// 检查字段描述符的 value，证明 __proto__ 被保留为自身数据而不是丢弃。
		expect(Object.getOwnPropertyDescriptor(args, "__proto__")?.value).toEqual({ polluted: true });
	});
});
