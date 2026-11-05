// 验证远端状态副本：批量采用更新、可恢复失败、退休标记以及持有结束后的读取和观察行为。
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { ChordError } from "../../src/data/index.ts";
import { Replica } from "../../src/remote/replica.ts";
import { Batch, Derive } from "../../src/state/internal.ts";
import { changesOf, delivered, framesOf } from "../support.ts";

/** A replica of `{ n }` on a fresh batch, with a derive over it attached. */
// 无参数；创建初值 { n: 1 } 的副本和计算 n*2 的派生值，返回二者及共享批次。
// attach 安装派生依赖，因此后续副本更新会使 double 重新计算；本函数不使用真实链接。
// 例如在 batch 内采用 { n: 2 } 后，double 为 4。类型断言描述测试已知的值形状，不验证网络数据。
function replica() {
	// 空错误回调忽略本夹具的后台报告，undefined 表示没有遥测计数器。
	const batch = new Batch(() => {}, undefined);
	// kind 是状态分支标签；value 分支携带第一个已知的好值。
	const source = new Replica(batch, { kind: "value", value: { n: 1 } });
	// 数组解构取唯一依赖值；as 只让编译器允许读 n，不在运行时检查 n。
	const double = new Derive([source], ([value]) => (value as { n: number }).n * 2, batch);
	double.attach(
		// 本例声明的源就是 Replica，解析器直接返回它。
		(declared) => declared as Replica,
		// 夹具不需要额外的依赖登记副作用。
		() => {},
	);
	// 属性简写返回原对象供用例控制，不复制副本中的状态。
	return { batch, source, double };
}

// describe 注册机制；async 用例会等观察回调送达后再检查数组。
describe("replicas", () => {
	// 在一个批次内采用 {n:2} 及其 set 操作；检查副本帧和 double 的重算帧。
	it("adopt a value and its ops inside a batch: one frame, derives recomputed", async () => {
		// 解构取出本例的独立夹具。
		const { batch, source, double } = replica();
		// openWatch 同步取得初值；framesOf 启动监听，仅收集后续 value 调用的 [值, ops]。
		const frames = framesOf(source.openWatch(context));
		const doubles = framesOf(double.openWatch(context));
		// s 表示设值，路径 ["n"]；false 表示本次没有退休。adopt 不做 schema 验证。
		batch.commit(() => source.adopt({ n: 2 }, [["s", ["n"], 2]], false), context);
		// 让排队的异步观察回调实际运行。
		await delivered();
		// 副本保留传入的细粒度 ops，派生值改变则用根替换 r 表达。
		expect(frames).toEqual([[{ n: 2 }, [["s", ["n"], 2]]]]);
		expect(doubles).toEqual([[4, [["r", 4]]]]);
	});

	// 先让副本失败，再尝试非法增量、合法根替换；检查失败不会关闭观察，恢复也恢复派生值。
	it("fail: reads throw the error, watches and derives over it get one failure call and recover with a root replacement", async () => {
		const { batch, source, double } = replica();
		// changesOf 收集所有调用，包括 failed；因此可验证一次失败和后续恢复。
		const calls = changesOf(source.openWatch(context));
		const derived = changesOf(double.openWatch(context));
		const error = new Error("member failed");
		// 在批次内失败使依赖脏掉，批次发布失败调用。
		batch.commit(() => source.fail(error), context);
		await delivered();
		expect(calls).toEqual([{ kind: "failed", error }]);
		expect(derived).toEqual([{ kind: "failed", error }]);
		// 必须把可能抛错的读取包在函数中，toThrow 才能捕获它。
		expect(() => source.value).toThrow("member failed");
		// A non-root op cannot apply to a failed member; its recovery is a root replacement.
		// 失败状态不能依赖旧值继续套增量；decode 在此协议边界拒绝非根替换。
		expect(() => source.decode([["s", ["n"], 2]])).toThrow("root replacement");
		// decode 校验并计算新值，但尚未采用；解构取 value 和已解码 ops。
		const { value, ops } = source.decode([["r", { n: 3 }]]);
		// 真正采用必须在批次内，才能把依赖变化一起发布。
		batch.commit(() => source.adopt(value, ops, false), context);
		await delivered();
		// at(-1) 只看恢复后的最后调用；退休标志在本例为 false。
		expect(calls.at(-1)).toEqual({ kind: "value", value: { n: 3 }, ops: [["r", { n: 3 }]], retired: false });
		expect(derived.at(-1)).toEqual({ kind: "value", value: 6, ops: [["r", 6]], retired: false });
	});

	// 连续两次失败只报告这一失败阶段的首次错误；失败期间收到的退休标记附到恢复值上。
	it("fail once per episode: a second failure while failed gives no call; a retirement meanwhile waits for the value", async () => {
		const { batch, source } = replica();
		const calls = changesOf(source.openWatch(context));
		// 保留 first 的对象身份，后面的深比较确认没有发布 second 替代它。
		const first = new Error("first");
		batch.commit(() => source.fail(first), context);
		batch.commit(() => source.fail(new Error("second")), context);
		await delivered();
		// A retirement alone while failed: the value is not read, the flag waits.
		// retireAlone 只记待发布标记，不读取会抛错的 source.value。
		batch.commit(() => source.retireAlone(), context);
		// 根替换恢复 n=5；传入 false 仍会与此前待发的退休标记合并为 true。
		const { value, ops } = source.decode([["r", { n: 5 }]]);
		batch.commit(() => source.adopt(value, ops, false), context);
		await delivered();
		// 精确两次调用：一次失败，一次带退休标志的好值。
		expect(calls).toEqual([
			{ kind: "failed", error: first },
			{ kind: "value", value: { n: 5 }, ops: [["r", { n: 5 }]], retired: true },
		]);
	});

	// 已有好值的副本失败后仍可开观察，以旧值初始化并先收到失败；从未有值的副本开观察会抛错。
	it("open a new watch while failed at the last value, the failure first; with no value yet, reject it", async () => {
		const { batch, source } = replica();
		const error = new Error("member failed");
		batch.commit(() => source.fail(error), context);
		// 失败状态下新 watch 的初值来自副本保留的 last，并非读取 source.value。
		const watch = source.openWatch(context);
		expect(watch.value).toEqual({ n: 1 });
		// 启动后先送出尚未报告给这个新观察者的失败。
		const calls = changesOf(watch);
		await delivered();
		expect(calls).toEqual([{ kind: "failed", error }]);
		// Failed since its binding: there is no value to start at.
		// 从 failed 分支创建，last 为 undefined，没有合法初值可交给新 watch。
		const unborn = new Replica(batch, { kind: "failed", error });
		expect(() => unborn.openWatch(context)).toThrow(error);
	});

	// end 是永久结束：用指定 released 错误结束副本，观察结束为 ended，之后读取抛同一原因。
	it("end with their hold: reads throw its error, watches end", async () => {
		const { source } = replica();
		const watch = source.openWatch(context);
		// end 在批次外可直接调用；与可恢复 fail 的行为不同。
		source.end(new ChordError({ code: "released", message: "app.notes: ended" }));
		// closed Promise 给出永久结束标签，不会再接收恢复值。
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(() => source.value).toThrow("app.notes: ended");
	});
});
