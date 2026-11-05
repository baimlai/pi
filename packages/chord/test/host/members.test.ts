// 验证工厂返回值的运行时成员检查：不接受继承来的方法，并给无效 derive 源标明位置。
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, local, method } from "../../src/contracts/index.ts";
import { loaded } from "../support.ts";

// 注册 Q14 的两个无网络场景；as never 故意绕过开发期类型检查，才能测试坏插件值的运行时错误。
describe("the member check (Q14)", () => {
	// 无参数；声明名为 toString 的方法，却返回空对象，等待 get 以“方法必须是函数”失败。
	// 例：普通 {} 继承 Object.prototype.toString，但那不算插件自己的实现；返回 Promise<void>。
	it("refuses an inherited property for a member", async () => {
		// id 参数使对象按引用存活；method() 表示无参数、无结果的方法。
		const Named = local("app.named", { version: 1, params: { id: int() }, members: { toString: method() } });
		// 工厂刻意漏掉 toString；as never 只作用于类型系统，不会给 {} 增加属性。
		const { host } = await loaded((h) => h.serve(Named, () => ({}) as never));
		// get 触发工厂和成员检查，toThrow 核对诊断同时包含对象身份与成员名。
		await expect(host.get(Named, { id: 1 }, context)).rejects.toThrow(
			"app.named(1): toString: a method is a function",
		);
	});

	// 用两组 n 参数把坏源分别放在暴露的 derive 和内部 derive，确认报错采用成员名或一基序号。
	// 例：n=1 报 label/source 1，n=2 报 derive #1/source 0；两次 get 都应失败，不会返回引用。
	it("names a derive in errors by its member when exposed, else by its position", async () => {
		// label 是声明暴露的整数状态成员，n 只用来选择坏源的位置。
		const Named = local("app.named", { version: 1, params: { n: int() }, members: { label: int() } });
		// 仅有 value 属性不构成 Chord watchable，内部 attach 会识别并拒绝它。
		const bad = { value: 1 };
		// loaded 保存工厂，真正的 derive attach 要到下面 host.get 激活时发生。
		const { host } = await loaded((h) =>
			h.serve(Named, ({ n }, self) => {
				// n=1 时 inner 无依赖；n=2 时它的第零个依赖就是 bad，计算回调本身始终返回 1。
				const inner = self.derive(n === 1 ? [] : [bad as never], () => 1);
				// label 暴露第二个 derive：n=1 的 source 1 故意无效；n=2 只依赖 inner。
				return { label: self.derive(n === 1 ? [inner, bad as never] : [inner], () => 2) };
			}),
		);
		// 已暴露的 derive 用 label 命名，源索引从 0 开始。
		await expect(host.get(Named, { n: 1 }, context)).rejects.toThrow(
			"app.named(1): label: source 1 is not a Chord watchable",
		);
		// 没有暴露的 inner 用声明顺序 derive #1 命名；这里仍检查实际运行时 attach 的错误。
		await expect(host.get(Named, { n: 2 }, context)).rejects.toThrow(
			"app.named(2): derive #1: source 0 is not a Chord watchable",
		);
	});
});
