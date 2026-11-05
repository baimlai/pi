// 检查内存store的时间、原始指标行与结果复制，并挂接公共存储契约。例时钟100→125使结束epoch为1000+25；mock每例恢复，不接外部数据库。
// afterEach清理用例后的mock；vi提供spyOn，不需要真的修改操作系统时间。
import { afterEach, describe, expect, it, vi } from "vitest";
// 运行时导入内存实现，type TelemetrySpan只约束稍后保存的span句柄。
import { InMemoryTelemetryContext, type TelemetrySpan } from "../src/index.ts";
// 复用存储契约登记器，具体断言在store-conformance.ts，本文件提供内存夹具。
import { telemetryStoreConformance } from "./store-conformance.ts";

// 箭头表达式直接返回restoreAllMocks结果；每例结束恢复Date/performance方法，避免污染后续用例。
afterEach(() => vi.restoreAllMocks());

// 登记公共存储用例。async工厂每次新建context，返回store/flush/清理入口；内存无待上传队列。
telemetryStoreConformance("in-memory telemetry store conformance", async () => {
	// 独立记录器同时承担写入与查询。
	const context = new InMemoryTelemetryContext();
	// context和store引用同一实例；空async函数仍返回Promise<void>；计算符号属性让await using有清理入口。
	return { context, store: context, flush: async () => {}, [Symbol.asyncDispose]: async () => {} };
});

// 下列三例验证内存实现特有的快照与原始测量行为，不要求所有后端用相同内部布局。
describe("in-memory store snapshots", () => {
	// 本例固定两个时钟，记录事件后改变单调时钟，断言Stored与规范快照各自应含的字段。
	it("records wall-clock boundaries and relative event times without changing normalized event snapshots", async () => {
		// Date.now固定1000，表示epoch毫秒起点，不是耗时钟。
		vi.spyOn(Date, "now").mockReturnValue(1000);
		// performance.now先固定100；spy句柄clock允许在同一用例中改后续返回值。
		const clock = vi.spyOn(performance, "now").mockReturnValue(100);
		// 新建实例，尚未开始任何span。
		const telemetry = new InMemoryTelemetryContext();
		// let允许callback填入完整span身份；根traceId会与该id相同。
		let id = "";
		// 启动timed，进入callback时实现已取起点1000和单调时钟100；await等待结束记录完成。
		await telemetry.startSpan({ name: "timed" }, (span) => {
			// inject导出carrier；后缀!只向TS断言非空，不增加运行时检查。
			const carrier = telemetry.inject(span)!;
			// 模板字符串用scope:span形成store的全局id，不是仅本地数字序号。
			id = `${carrier["pi-memory-scope"]}:${carrier["pi-memory-span"]}`;
			// 随后时钟读数改110，即距起点10ms。
			clock.mockReturnValue(110);
			// 记录事件，内部timeMs因此为10，事件属性count为1。
			span.addEvent("event", { count: 1 });
			// callback结束前把时钟改125，finally算耗时25ms，不改变Date.now的1000。
			clock.mockReturnValue(125);
		});
		// 按根traceId查存储快照并做完整结构比较；不是对真实数据库的持久化测试。
		expect(await telemetry.getTrace(id)).toEqual({
			// 根traceId恰好就是自己完整id。
			traceId: id,
			// 预期trace只有一个span，数组保留完整快照。
			spans: [
				{
					// 属性简写id沿用外部保存值。
					id,
					// span里的traceId同样沿根身份。
					traceId: id,
					// 名字保留启动时timed。
					name: "timed",
					// 绝对开始时间来自Date.now的1000。
					startedMs: 1000,
					// 结束时间用epoch起点加单调耗时：1000+(125-100)=1025。
					endedMs: 1025,
					// 没有传初始属性，快照为空表。
					attributes: {},
					// Stored事件含相对偏移10，不把它误读为epoch时间。
					events: [{ name: "event", timeMs: 10, attributes: { count: 1 } }],
					// 没有建立link，列表为空。
					links: [],
					// callback正常返回且无显式改状态，结束为ok。
					status: { status: "ok" },
				},
			],
		});
		// getSpans是规范测试快照，事件不带store专用timeMs；?.只处理缺首项，toEqual仍会暴露缺项。
		expect(telemetry.getSpans()[0]?.events).toEqual([{ name: "event", attributes: { count: 1 } }]);
		// 规范span快照不暴露startedMs，和上面的StoredSpan接口不同。
		expect(telemetry.getSpans()[0]).not.toHaveProperty("startedMs");
	});

	// 本例验证两次add保留两条原始count-one行，同时getMetrics不暴露内部桶时间；没有自动求和成一行。
	it("maps raw metric measurements to count-one rows without exposing private timing in getMetrics", async () => {
		// 数字分隔符_只改善可读性，20_001就是20001毫秒，落入20000开始的10秒桶。
		vi.spyOn(Date, "now").mockReturnValue(20_001);
		// 新的日志从空开始。
		const telemetry = new InMemoryTelemetryContext();
		// 追加增量2，创建的counter句柄不是当前总量值。
		telemetry.counter("calls").add(2);
		// 同名counter再追加增量3，仍独立一行。
		telemetry.counter("calls").add(3);
		// expect接收下面查询映射的结果，后面的toEqual比较行序与三字段。
		expect(
			// await查询后map每行成[桶起点,次数,sum]；每条原始测量次数为1。
			(await telemetry.findMetrics({ name: "calls" })).map((row) => [row.intervalMs, row.count, row.sum]),
			// 以下数组是期望的两行，而非合计[20000,2,5]。
		).toEqual([
			// 第一条value2，桶起点20000，次数1。
			[20_000, 1, 2],
			// 第二条value3，同桶但仍单独记录。
			[20_000, 1, 3],
		]);
		// 再次读原始测量快照，比较完整结构，确保没有私有intervalMs字段混入。
		expect(telemetry.getMetrics()).toEqual([
			// 第一条原始counter行不关联span，因此context为null。
			{ kind: "counter", name: "calls", value: 2, attributes: {}, context: null },
			// 第二条保留自己value3，没有累计为5。
			{ kind: "counter", name: "calls", value: 3, attributes: {}, context: null },
		]);
	});

	// 本例创建已结束目标和带link/error的源，再故意篡改查询结果，验证下一次结果仍保留原值。
	it("detaches link attributes and error details", async () => {
		// 每例独立实例，不继承上例指标或span。
		const telemetry = new InMemoryTelemetryContext();
		// 声明处!是明确赋值断言，告诉TS稍后由callback赋值；它不创建默认TelemetrySpan。
		let target!: TelemetrySpan;
		// 先完成target；后续仍可用其身份作为link目标。
		await telemetry.startSpan({ name: "target" }, (span) => {
			// 把真实句柄保存在外部变量，不保存getSpans快照来代替context身份。
			target = span;
		});
		// 再启动source，传入初始link并在callback里设置错误。
		await telemetry.startSpan(
			// target是已结束的真实句柄；link属性tags需要与返回结果隔离。
			{ name: "source", links: [{ context: target, attributes: { tags: ["original"] } }] },
			// 箭头函数接当前source句柄，只操作本次span。
			(span) => {
				// 显式error附name/message；不会抛异常，也不使这次startSpan Promise自动拒绝。
				span.setStatus({ status: "error", error: { name: "Expected", message: "original" } });
			},
		);
		// 按source名字找trace并取首项；!只基于本测试刚创建它的前提，不运行数组非空校验。
		const trace = (await telemetry.findTraces({ name: "source" })).traces[0]!;
		// 本trace只有source一个span，取其存储快照。
		const span = trace.spans[0]!;
		// 故意改返回link的数组属性；两个!都只消除TS的可能undefined。
		span.links[0]!.attributes!.tags = ["changed"];
		// 用status判别字段收窄error分支，再确认有详情后改message；不是修改原始抛出的Error对象。
		if (span.status.status === "error" && span.status.error) span.status.error.message = "changed";
		// 按同traceId重新查，拿独立新快照，括号内!同样不做运行时保护。
		const fresh = (await telemetry.getTrace(trace.traceId))!.spans[0]!;
		// link标签仍original，说明上次改动没有写回内部记录。
		expect(fresh.links[0]?.attributes?.tags).toEqual(["original"]);
		// 错误详情也仍original；toEqual同时检查status、name和message。
		expect(fresh.status).toEqual({ status: "error", error: { name: "Expected", message: "original" } });
	});
});
