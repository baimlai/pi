// Tests of `running`'s list (§15): each change copies the list, keeps the other entries identical and gives the ops
// of exactly that change (a state change re-pathed under its entry); one frame per batch; derives over it are marked.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { applyImmutable, type Op } from "../../src/delta/index.ts";
import { Running } from "../../src/jobs/running.ts";
import type { JsonValue } from "../../src/json.ts";
import { Batch, Derive } from "../../src/state/internal.ts";
import { delivered, framesOf } from "../support.ts";

// 无参数夹具创建独立发布批次和空任务列表并返回二者；没有外部 I/O。
// 例：running().list.value 最初为 []；空错误回调只用于本文件，真实宿主会把后台错误交给 onError。
function running() {
	// 第一参忽略批次错误，第二参不提供指标适配器；每次调用创建互不共享的批次。
	const batch = new Batch(() => {}, undefined);
	// label 只用于列表结束后的错误消息；{ batch, list } 是对象属性简写。
	return { batch, list: new Running(batch, "app.store job app.echo") };
}

// 注册内存列表测试；ops 是 Delta 的变化指令，描述如何从上一值重建下一值，不是业务代码回调。
describe("running's list", () => {
	// 异步用例按添加/改状态/换阶段/删除发布四批，验证共享引用和可重放指令；无外部 I/O。
	// 例：b.output 从空串追加 x 时，路径应变成列表索引 1 下的 state.output。
	it("copies the list per change, keeps other entries identical, and frames apply to the previous value", async () => {
		// 解构取得同一夹具的批次和列表，后续所有变更必须进入这个批次。
		const { batch, list } = running();
		// 两条普通 JSON 数据作为列表项；Running 不负责校验真实任务记录的完整形状。
		const a = { id: "a", phase: "running", state: { output: "" } };
		const b = { id: "b", phase: "running", state: { output: "" } };
		// watch 原子取得初值并缓冲后续更新；framesOf 启动监听，仅收集 value/ops 帧。
		const watch = await list.watch(context);
		const frames = framesOf(watch);
		// 保留原数组引用用于证明后续添加不会原地修改已发布列表。
		let previous = list.value;
		// 同一同步提交内连续添加两条，监听器最后收到一个包含两条插入指令的帧。
		batch.commit(() => {
			list.add(a);
			list.add(b);
		}, context);
		// 让已排队的监听回调运行；它等待一次零延时定时器，不会额外提交变化。
		await delivered();
		// as 只是把 JsonValue 收窄成测试已知的数组，运行时不转换或验证。
		const added = list.value as JsonValue[];
		expect(added).toEqual([a, b]);
		expect(added).not.toBe(previous);
		// 展开复制 b 顶层并替换 state；a 的引用保持不变。
		const b2 = { ...b, state: { output: "x" } };
		// a 指令表示追加字符串；Running 将状态内部路径扩成 [1,"state","output"]。
		batch.commit(() => list.stateChanged(b, b2, [["a", ["output"], "x"]]), context);
		await delivered();
		// 单独换阶段属于整条记录替换，因此产生 set 指令而非状态内部指令。
		const a2 = { ...a, phase: "finishing" };
		batch.commit(() => list.replace(a, a2), context);
		await delivered();
		// 删除按当前条目引用定位；a 已被 a2 替换，应传 a2。
		batch.commit(() => list.remove(a2), context);
		await delivered();
		// 深比较验证内容，toBe 单独证明未复制剩余条目 b2。
		expect(list.value).toEqual([b2]);
		expect((list.value as JsonValue[])[0]).toBe(b2);
		// 元组解构跳过 value，只取 ops：p 是数组插入/删除，a 是字符串追加，s 是指定路径赋值。
		expect(frames.map(([, ops]) => ops)).toEqual([
			[
				["p", [], 0, 0, [a]],
				["p", [], 1, 0, [b]],
			],
			[["a", [1, "state", "output"], "x"]],
			[["s", [0], a2]],
			[["p", [], 0, 1, []]],
			// satisfies 在开发时检查二维指令数组类型，运行时不增加检查，也不改变这个数组。
		] satisfies Op[][]);
		// Every frame turns the previous value into the next.
		// 从最初空列表逐帧重放，验证发布值与指令一致；不只检查某个最终值。
		previous = [];
		for (const [value, ops] of frames) {
			// applyImmutable 不改 previous；它按这帧的 ops 算出下一个值。
			expect(applyImmutable(previous, ops)).toEqual(value);
			// 下一帧必须以上一帧发布值为基线。
			previous = value;
		}
	});

	// 用人为指令序列检查路径改写，返回 Promise<void>；例：根替换 r 变为 [0,"state"] 上的 s。
	// 此序列用于覆盖指令种类，不断言它们重放后的值与 after 一致。
	it("re-paths every kind of state op under its entry; a replacement becomes a set", async () => {
		const { batch, list } = running();
		// 先加入一条记录，再订阅，因此后续收集的第一帧只有状态变更，没有加入记录的帧。
		const entry = { id: "a", state: { list: [1], text: "", n: 0 } };
		batch.commit(() => list.add(entry), context);
		const frames = framesOf(await list.watch(context));
		// stateChanged 的 after 是调用方提供的新条目，内部不靠 ops 重建它。
		const after = { id: "a", state: { list: [2], text: "t", n: 1 } };
		// Op[] 是带标签元组的联合：r替换根、s设置、p拼接数组、a追加文本、d删除、t截短、m重排。
		const ops: Op[] = [
			["r", { list: [], text: "", n: 0 }],
			["s", ["n"], 1],
			["p", ["list"], 0, 0, [2]],
			["a", ["text"], "t"],
			["d", ["gone"]],
			["t", ["text"], 1],
			["m", ["list"], [0]],
		];
		// 一个提交内改条目并把每条状态指令扩到对应列表项下。
		batch.commit(() => list.stateChanged(entry, after, ops), context);
		await delivered();
		// ! 只告诉 TS 第一帧已存在，不提供运行时保护；[1] 取元组的 ops。
		expect(frames[0]![1]).toEqual([
			["s", [0, "state"], { list: [], text: "", n: 0 }],
			["s", [0, "state", "n"], 1],
			["p", [0, "state", "list"], 0, 0, [2]],
			["a", [0, "state", "text"], "t"],
			["d", [0, "state", "gone"]],
			["t", [0, "state", "text"], 1],
			["m", [0, "state", "list"], [0]],
		]);
	});

	// 同步成本测试注入一遍历就抛错的数组替身；无人订阅时状态更新仍成功，证明此路径未遍历 ops。
	// 它不测毫秒耗时，也不证明所有列表操作都是常数复杂度。
	it("builds no op for a state change while unwatched (cost guard: the ops are not even walked)", () => {
		const { batch, list } = running();
		// 只添加记录，不调用 watch，保持无人订阅状态。
		const entry = { id: "a", state: { output: "" } };
		batch.commit(() => list.add(entry), context);
		// Symbol.iterator 控制 for...of；双重断言只为传入敌意夹具，并不会让此对象真的变成数组。
		const unwalked = {
			[Symbol.iterator]: () => {
				// 只要实现试图遍历就让测试立即失败。
				throw new Error("walked");
			},
		} as unknown as Op[];
		// 条目仍要换成新值；省略的是没人需要的指令构建，不是更新本身。
		const after = { id: "a", state: { output: "x" } };
		batch.commit(() => list.stateChanged(entry, after, unwalked), context);
		expect(list.value).toEqual([after]);
	});

	// 异步用例结束列表后等待 watch 关闭并验证读失败；例：读取错误必须含创建时的任务标签。
	it("keeps nothing once ended: reads throw released", async () => {
		const { batch, list } = running();
		// 无需完整任务记录：Running 测试只关心列表和订阅生命周期。
		batch.commit(() => list.add({ id: "a" }), context);
		const watch = await list.watch(context);
		// end 丢弃内部列表和暂存 ops，并结束全部监听；不代表真实任务执行了 finish。
		list.end();
		expect(await watch.closed).toEqual({ kind: "ended" });
		// getter 包进函数以捕获其同步错误；本例通过消息断言，没有单独匹配 code 字段。
		expect(() => list.value).toThrow("app.store job app.echo: ended");
	});

	// 无 watch 时仍应把派生值标为脏；同步读取触发重算，例如条目数依次为 0、1、2。
	// 返回 void，不计时；是否未遍历 ops 的更直接证据在前一个成本测试中。
	it("records no ops while unwatched, and marks derives over it at every change", () => {
		const { batch, list } = running();
		// 回调解构第一个源值，断言成数组后取 length；回调返回 JSON 数字。
		const count = new Derive([list], ([value]) => (value as JsonValue[]).length, batch);
		// attach 将声明的源解析为 Running，第二个空回调忽略本例不会触发的派生错误报告。
		count.attach(
			(source) => source as Running,
			() => {},
		);
		// 第一次 value 读取计算 0；随后每次提交必须使之前的缓存失效。
		expect(count.value).toBe(0);
		batch.commit(() => list.add({ id: "a" }), context);
		expect(count.value).toBe(1);
		batch.commit(() => list.add({ id: "b" }), context);
		expect(count.value).toBe(2);
	});
});
