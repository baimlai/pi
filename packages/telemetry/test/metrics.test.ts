// 检查类型化指标的名字/种类/属性参数、元数据、span关联与快照隔离。坏类型调用留在不执行的函数内；运行时断言与tsc静态检查各负责一层。
// expect做运行时断言；expectTypeOf配合tsc检查类型。普通Vitest运行不替代tsc，本文件坏调用只放未执行函数体内。
import { describe, expect, expectTypeOf, it } from "vitest";
// 公共入口同时导入真实helper/adapter与type声明，type前缀的名字在运行JS中擦除。
import {
	// 按schema的名字/种类/属性推导指标句柄，运行时委托底层adapter记录。
	createTypedMetrics,
	// defineTelemetrySchema保留输入对象身份并帮助约束声明形状，不是运行时数据校验器。
	defineTelemetrySchema,
	// 内存adapter供观察原始测量与关联span。
	InMemoryTelemetryContext,
	// 空上下文用来演示可选的exemplar关联参数。
	NOOP_TELEMETRY_CONTEXT,
	// 空指标工厂供测试共享且冻结的无记录句柄。
	NOOP_TELEMETRY_METRICS,
	// SpanAttributes给故意修改测试快照的as断言使用。
	type SpanAttributes,
	// TelemetryCarrier是字符串字典类型，不自动验证JSON。
	type TelemetryCarrier,
	// TelemetryMetricDefinition限制指标定义形状与允许的低基数属性。
	type TelemetryMetricDefinition,
} from "../src/index.ts";

// 定义流量词表：两类指标共用一个schema，as const保留名字/选项为字面量；helper不实际创建网络计数器。
const traffic = defineTelemetrySchema({
	// schema版本1是普通可序列化元数据，不会触发自动迁移。
	version: 1,
	// 本schema只定义指标，没有span词条。
	spans: {},
	// 下面按字符串名字组织指标声明。
	metrics: {
		// network.bytes是指标名，带点仍是一个键，不是嵌套对象路径。
		"network.bytes": {
			// counter表示只增量的计数器类型，泛型据此限制counter可选名字。
			kind: "counter",
			// 描述会传给adapter元数据，不是显示给用户的翻译键。
			description: "Encoded bytes",
			// 单位By表示字节，记录器不把数值自动乘除换单位。
			unit: "By",
			// 每次add允许的属性词表，不是此处已经记录的属性值。
			attributes: {
				// 定义名为direction的属性。
				direction: {
					// 值类型为string，不允许用true或1冒充方向。
					type: "string",
					// 闭集只允许in/out；const断言保留联合类型，而非扩大成任意string。
					values: ["in", "out"],
					// required:true使add的属性参数不能省略。
					required: true,
					// 属性的文字描述仍是可序列化数据。
					description: "Direction",
					// low基数表示取值种类少，适合指标维度；不是运行时自动统计/截断唯一值个数。
					cardinality: "low",
				},
			},
		},
		// 活跃连接用upDownCounter，允许+1/-1；空属性声明禁止额外键。
		"network.active": { kind: "upDownCounter", description: "Open links", attributes: {} },
	},
	// as const是类型断言，保留只读字面量/元组类型，不调用Object.freeze。
} as const);
// 第二个schema独立声明延迟直方图，稍后与traffic组合使用。
const latency = defineTelemetrySchema({
	// 此词表版本为1，不要求与其他schema版本联动。
	version: 1,
	// 同样不声明span。
	spans: {},
	// 这次metrics只含一个条目。
	metrics: {
		// call.duration是直方图名字。
		"call.duration": {
			// histogram记录独立测量，不是counter累加接口。
			kind: "histogram",
			// 描述用于元数据。
			description: "Call duration",
			// 单位ms仅声明数值口径，调用者应自己提供毫秒值。
			unit: "ms",
			// 边界提示[1,10,100]会传给adapter；内存实现仅保存提示与原值，不在此完成桶聚合。
			boundaries: [1, 10, 100],
			// method是可选string属性，所以record允许省略整个属性参数，也允许undefined占位再传context。
			attributes: { method: { type: "string", required: false, description: "Method" } },
		},
	},
	// const断言保留histogram/false等字面量，供条件类型推导。
} as const);

// 四例覆盖schema绑定、必需属性、快照隔离和空指标句柄；类型断言由统一tsc一并检查。
describe("metrics", () => {
	// 综合例子记录6个测量再核对元数据/关联，另构造不执行的错误调用，让编译器证明名字和属性限制。
	it("binds schema names, kinds, metadata, and exact measurement attributes", async () => {
		// 独立内存adapter，日志从空开始。
		const adapter = new InMemoryTelemetryContext();
		// 合并两个schema词表来生成类型化指标入口；此helper保留定义供运行时按名字查元数据。
		const metrics = createTypedMetrics(adapter, [traffic, latency]);
		// 首条128字节向外流量，direction是必需且只允许in/out。
		metrics.counter("network.bytes").add(128, { direction: "out" });
		// 活跃数增量+1，无必需属性可以不传第二参数。
		metrics.upDownCounter("network.active").add(1);
		// 再记录-1，upDownCounter允许负增量；快照保留两行而非显示当前0。
		metrics.upDownCounter("network.active").add(-1);
		// 启动request提供真实span身份，后面可把直方图测量关联到它；await等span结束。
		await adapter.startSpan({ name: "request" }, (span) => {
			// 记录值12、method=read并关联span，第三参数是可选exemplar上下文，不改变span父关系。
			metrics.histogram("call.duration").record(12, { method: "read" }, span);
			// 值13不带属性和context，保持可选参数省略的用法。
			metrics.histogram("call.duration").record(13);
			// 值14用undefined占第二参数位置，第三参数仍传span；不能直接把context挪到属性位置。
			metrics.histogram("call.duration").record(14, undefined, span);
		});
		// 取6条原始测量的独立快照，按调用顺序排列。
		const measurements = adapter.getMetrics();
		// 第0条是network.bytes；toMatchObject只检查列出的字段，不限制额外合法元数据。
		expect(measurements[0]).toMatchObject({
			// 类型标签应为counter。
			kind: "counter",
			// 名字按schema保留。
			name: "network.bytes",
			// 描述来自traffic定义，不由add提供。
			description: "Encoded bytes",
			// 单位也由定义绑定。
			unit: "By",
			// value是本次增量128，不是后台自动累计值。
			value: 128,
			// 记录实际direction=out，不保存整个属性定义对象。
			attributes: { direction: "out" },
		});
		// 第3条是首个直方图，因为前面有counter及两条upDownCounter。
		expect(measurements[3]).toMatchObject({
			// 种类应为histogram。
			kind: "histogram",
			// 保留定义中的边界提示。
			boundaries: [1, 10, 100],
			// 测量关联的carrier应等于request记录身份，不要求是同一个对象引用。
			context: adapter.getSpans()[0]?.context,
		});
		// 第4条省略context，快照用null表示无关联。
		expect(measurements[4]?.context).toBeNull();
		// 第5条显式undefined属性仍能关联request。
		expect(measurements[5]?.context).toEqual(adapter.getSpans()[0]?.context);
		// 仅定义不调用的函数让tsc检查坏例子；如果真的调用其中坏名字，运行时可能抛错，因此不能拿它当业务示范执行。
		const compileTimeFailures = () => {
			// 下一行故意把直方图名传给counter，必须有类型错误；保留指令紧邻目标。
			// @ts-expect-error counter names are restricted to counters
			metrics.counter("call.duration");
			// 下一坏例反过来把counter名传给histogram。
			// @ts-expect-error histogram names are restricted to histograms
			metrics.histogram("network.bytes");
			// unknown没有在任一schema声明，种类工厂也不能接受。
			// @ts-expect-error unknown names are rejected
			metrics.upDownCounter("unknown");
			// network.bytes有必需direction，add不能只给数值。
			// @ts-expect-error required metric attributes cannot be omitted
			metrics.counter("network.bytes").add(1);
			// 方向闭集只含in/out，sideways必须被静态拒绝。
			// @ts-expect-error closed-set metric values are exact
			metrics.counter("network.bytes").add(1, { direction: "sideways" });
			// const对象含合法direction和额外unknown，证明不是只有对象字面量才受精确属性限制。
			const extra = { direction: "in", unknown: true } as const;
			// 下一调用把这个变量交给add，未知键仍应报类型错误。
			// @ts-expect-error variables containing unknown attributes are rejected
			metrics.counter("network.bytes").add(1, extra);
			// network.active的属性schema为空，不意味着允许任意键，而是不能多传unknown。
			// @ts-expect-error an empty attribute schema rejects every attribute
			metrics.upDownCounter("network.active").add(1, { unknown: true });
			// 同一traffic传两遍造成指标名重复，组合词表的类型约束应拒绝。
			// @ts-expect-error duplicate metric names are rejected
			createTypedMetrics(adapter, [traffic, traffic]);
			// 显式TelemetryMetricDefinition变量测试通用声明接口，不依赖createTypedMetrics推导才发现问题。
			const invalid: TelemetryMetricDefinition = {
				// 声明它属于counter。
				kind: "counter",
				// 描述字段符合要求，真正坏点在下面high基数。
				description: "Invalid",
				// 属性定义表，而非一次测量属性值。
				attributes: {
					// 下一属性故意声明high，指标类型不允许高基数；这是静态政策，不是运行时检查样本数量。
					// @ts-expect-error high-cardinality attributes do not belong on metrics
					request: { type: "string", required: false, description: "Request", cardinality: "high" },
				},
			};
			// 函数若执行会返回invalid，但本测试只传函数引用给expectTypeOf，不执行它。
			return invalid;
		};
		// 检查引用是函数类型；函数体错误由tsc与原有指令共同验证，普通运行不逐条触发这些错误。
		expectTypeOf(compileTimeFailures).toBeFunction();
		// JSON序列化普通schema不应抛错；只验证当前定义可序列化，不证明所有可能输入都可序列化。
		expect(() => JSON.stringify(traffic)).not.toThrow();
	});

	// 必需直方图属性例子：合法record带boolean cache，坏省略/字符串/把context冒充属性只做类型检查。
	it("requires histogram attributes when the schema declares them", () => {
		// 建立本例独立schema，方便直观看required:true如何影响参数元组。
		const schema = defineTelemetrySchema({
			// 元数据版本1。
			version: 1,
			// 不定义span。
			spans: {},
			// 声明指标词表。
			metrics: {
				// required在这里是指标名字，不是JS关键字或某个函数参数标志。
				required: {
					// 指标种类是histogram。
					kind: "histogram",
					// 描述指明本例重点为必需标签。
					description: "Required tag",
					// 测量属性词表。
					attributes: {
						// cache既必须提供又必须是boolean，字符串"true"不满足。
						cache: { type: "boolean", required: true, description: "Cache hit" },
					},
				},
			},
			// const断言保留required:true，让条件类型决定参数必需性。
		} as const);
		// 新内存adapter只为本例合法记录服务，不复用前例日志。
		const metrics = createTypedMetrics(new InMemoryTelemetryContext(), [schema]);
		// 合法record(1,{cache:true})实际执行。
		metrics.histogram("required").record(1, { cache: true });
		// 坏例函数只被定义，不调用；不往内存日志真的写入非法参数。
		const compileTimeFailures = () => {
			// 下一行故意省略必需属性，必须产生类型错误。
			// @ts-expect-error histogram attributes are required
			metrics.histogram("required").record(1);
			// 下一行把boolean换成string，类型不应接受隐式转换。
			// @ts-expect-error histogram values match their attribute schema
			metrics.histogram("required").record(1, { cache: "true" });
			// 第二参数应该是属性，不可用可选第三参数的context顶替；即便context合法也不满足cache。
			// @ts-expect-error optional exemplar context does not replace required attributes
			metrics.histogram("required").record(1, NOOP_TELEMETRY_CONTEXT);
		};
		// 对函数引用做类型断言，不执行坏例。
		expectTypeOf(compileTimeFailures).toBeFunction();
	});

	// 快照例子先记录带边界/标签/span关联的一条测量，再改返回的三种引用，最后重新取值检查隔离。
	it("returns detached measurement snapshots including exemplars and boundaries", async () => {
		// 独立内存adapter。
		const telemetry = new InMemoryTelemetryContext();
		// 这次直接用未绑定schema的基础histogram，传边界[1,2]。
		const histogram = telemetry.histogram("duration", { boundaries: [1, 2] });
		// request的callback里记录值1和数组标签，第三参数关联当前span。
		await telemetry.startSpan({ name: "request" }, (span) => histogram.record(1, { tags: ["original"] }, span));
		// 取首条返回快照，不是取得内部测量日志对象。
		const measurement = telemetry.getMetrics()[0];
		// 测试准备若缺测量或context就失败；可选链使缺测量安全读成undefined，if随后收窄为有记录/关联。
		if (!measurement?.context) throw new Error("Expected measurement context");
		// as number[]只撤掉只读数组视图，故意push(3)检查返回边界有没有共享内部数组。
		(measurement.boundaries as number[]).push(3);
		// 同样故意把返回属性tags改成另一数组。
		(measurement.attributes as SpanAttributes).tags = ["mutated"];
		// 再故意改快照carrier里的span身份字段，不调用真实上下文记录方法。
		(measurement.context as TelemetryCarrier)["pi-memory-span"] = "999";
		// 重新取得快照，仅比这三处关键引用字段。
		expect(telemetry.getMetrics()[0]).toMatchObject({
			// 原边界仍[1,2]。
			boundaries: [1, 2],
			// 原标签仍original。
			attributes: { tags: ["original"] },
			// 原关联仍是request真实身份，外部写999没有污染内部。
			context: telemetry.getSpans()[0]?.context,
		});
	});

	// 空实现例子检查不同名字的counter共用一个对象、三个种类句柄冻结，随后调用记录方法不抛错；不要求实际存储数据。
	it("shares frozen no-op instruments", () => {
		// 构造单位元数据，空工厂会忽略它。
		const options = { unit: "By" };
		// 构造一次测量属性，空记录方法会忽略它。
		const attributes = { direction: "out" };
		// 取得空counter句柄，名字bytes不创建独立日志。
		const counter = NOOP_TELEMETRY_METRICS.counter("bytes", options);
		// 取得空upDownCounter句柄，允许后面add负数。
		const active = NOOP_TELEMETRY_METRICS.upDownCounter("active", options);
		// 取得空histogram句柄。
		const histogram = NOOP_TELEMETRY_METRICS.histogram("duration", options);
		// 即使名字other，counter仍是同一个对象引用；不据此声称不同种类也同一个句柄。
		expect(counter).toBe(NOOP_TELEMETRY_METRICS.counter("other"));
		// counter对象实际冻结，不只是readonly类型。
		expect(Object.isFrozen(counter)).toBe(true);
		// upDownCounter同样冻结。
		expect(Object.isFrozen(active)).toBe(true);
		// histogram同样冻结。
		expect(Object.isFrozen(histogram)).toBe(true);
		// 调用空counter仍接受正常参数并返回void，不记录或累加。
		counter.add(1, attributes);
		// 空upDownCounter同理忽略-1。
		active.add(-1, attributes);
		// 空histogram也可接受上下文参数，仍不生成关联记录。
		histogram.record(1, attributes, NOOP_TELEMETRY_CONTEXT);
	});
});
