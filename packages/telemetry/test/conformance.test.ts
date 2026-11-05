// 将内存遥测adapter接到公共契约用例，并额外检查打开/结束span的快照隔离。例改返回的tags不应污染下一份快照；全部在内存运行。
// Vitest的describe分组、it登记用例、expect做运行时断言；登记回调与真正跑用例是两步。
import { describe, expect, it } from "vitest";
// 导入实际内存adapter；同一导入中的type SpanAttributes只供TS使用，运行JS擦除。
import { InMemoryTelemetryContext, type SpanAttributes } from "../src/index.ts";
// 公共工厂返回测试描述列表；TelemetryAdapterFixture约定每例如何取能力、快照和清理。
import { createTelemetryAdapterConformance, type TelemetryAdapterFixture } from "../src/testing/index.ts";

// 此零参数工厂在每个公共用例需要时创建独立夹具，不共享已写过的state。先建立用例列表，不在这里直接跑完测试。
const conformance = createTelemetryAdapterConformance(() => {
	// 每次新建记录器，独立UUID/计数与日志，避免不同测试span混在一起。
	const context = new InMemoryTelemetryContext();
	// Promise.resolve<T>把同步对象装成约定的异步夹具；泛型只检查形状，不在运行时验证adapter。
	return Promise.resolve<TelemetryAdapterFixture>({
		// 属性简写context等同context: context，作为启动span的入口。
		context,
		// 内存实例本身实现inject/extract，交给公共传播用例。
		propagation: context,
		// 同一实例也实现counter等指标能力，供公共指标用例使用。
		metrics: context,
		// 箭头回调取得当前测量快照，再装成Promise，符合可异步后端的统一接口。
		getMetrics: () => Promise.resolve(context.getMetrics()),
		// 同理返回span开始顺序的规范快照，包含打开记录。
		getSpans: () => Promise.resolve(context.getSpans()),
		// 方括号是计算属性名，asyncDispose符号供await using退出作用域时调用；内存夹具没有额外资源，返回已完成Promise。
		[Symbol.asyncDispose]: () => Promise.resolve(),
	});
});

// 登记内存adapter测试分组；公共用例的group/name决定报告层级。
describe("InMemoryTelemetryContext conformance", () => {
	// map提取分组名，Set去重且保留首次出现顺序，for...of逐组登记。
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		// 每个字符串group成为一层describe，不影响业务span的父子关系。
		describe(group, () => {
			// filter只挑同组描述，candidate只是数组元素参数，不复制它的run函数实现。
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				// it回调返回run的Promise给Vitest等待；不是void丢弃异步工作。
				it(testCase.name, () => testCase.run());
			}
		});
	}

	// 本例流程：callback内读打开快照→await完成→改结束快照→重新读。验证隔离，不是任意JS对象深复制证明。
	it("returns detached snapshots without exposing mutable recording state", async () => {
		// 此额外用例再新建独立adapter。
		const context = new InMemoryTelemetryContext();
		// let与boolean | undefined允许回调稍后填入打开状态，初始值为undefined。
		let openSettled: boolean | undefined;
		// 结束序号也先未知；显式类型可让测试区分0和真正缺省。
		let openEndSequence: number | undefined;
		// 带初始数组属性启动操作；callback同步进入，外层await等其完成且finally标记结束。
		await context.startSpan({ name: "snapshot", attributes: { tags: ["initial"] } }, (span) => {
			// 在打开阶段追加一个带value的事件。
			span.addEvent("event", { value: 1 });
			// 数组解构取首个快照；这里读到的是独立对象，不是内部MutableSpan句柄。
			const [open] = context.getSpans();
			// ?.表示open缺省时取undefined，不是断言一定存在；若缺记录后面的false断言会失败。
			openSettled = open?.settled;
			// 保存打开时的结束序号，稍后验证尚未赋值。
			openEndSequence = open?.endSequence;
		});

		// 已进入callback的记录必须尚未settled；这也避免“根本没有open所以undefined”误通过。
		expect(openSettled).toBe(false);
		// 结束顺序只在callback完成后赋值，此刻应缺省。
		expect(openEndSequence).toBeUndefined();
		// await已返回，现在重新读取结束快照，不复用callback内那份旧对象。
		const [first] = context.getSpans();
		// await结束后新读快照应settled=true；前面只保存了布尔值，本断言不单独检查旧对象是否会更新。
		expect(first?.settled).toBe(true);
		// 本实例只有一个已结束span，首结束序号为1。
		expect(first?.endSequence).toBe(1);
		// as仅撤掉TS只读视图以故意篡改测试结果；它不复制对象，也不改变adapter内部。测试依赖前面的记录存在断言。
		(first?.attributes as SpanAttributes).tags = ["mutated"];
		// 同样故意改返回的事件属性，覆盖另一个可变引用层。
		(first?.events[0]?.attributes as SpanAttributes).value = 2;

		// 再取一份快照，检查刚才的外部修改是否泄露回内部。
		const [second] = context.getSpans();
		// 初始数组属性仍是initial，toEqual按结构比较而非数组引用。
		expect(second?.attributes).toEqual({ tags: ["initial"] });
		// 事件属性仍是1；此断言不检查StoredSpan的timeMs，那是store.test.ts的职责。
		expect(second?.events).toEqual([{ name: "event", attributes: { value: 1 } }]);
	});
});
