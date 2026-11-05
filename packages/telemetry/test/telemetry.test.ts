// 用schema示例讲字面量推导/精确属性/父子starter，并核对空记录上下文的同步callback与返回/拒绝值。坏类型示例只编译不调用，运行与静态检查分开承担验证。
// expect比较运行值，expectTypeOf配合tsc检查静态类型；普通测试运行不能替代根目录的类型检查。
import { describe, expect, expectTypeOf, it } from "vitest";
// 公共入口包含schema helper、内存/空实现及只供TS的类型，一次多行导入。
import {
	// createTypedSpanStarter把上下文和schema类型绑定，实际父子身份依靠callback提供的child starter。
	createTypedSpanStarter,
	// defineTelemetrySchema返回原定义对象，给类型推导提供字面量结构，不运行校验或执行parents政策。
	defineTelemetrySchema,
	// 内存实现用于观察根/孩子身份和返回值。
	InMemoryTelemetryContext,
	// 空上下文照常执行callback，仅丢弃span记录。
	NOOP_TELEMETRY_CONTEXT,
	// 空指标能力以共享冻结对象提供。
	NOOP_TELEMETRY_METRICS,
	// 空传播能力不输出carrier，提取回空上下文。
	NOOP_TELEMETRY_PROPAGATION,
	// SchemaTelemetrySpan按schema名字选择可用事件和结束属性，类型不会自动生成新运行时类。
	type SchemaTelemetrySpan,
	// TelemetrySchemaSpanStartAttributes抽出某个span的开始属性类型，稍后用expectTypeOf验证。
	type TelemetrySchemaSpanStartAttributes,
	// TelemetrySpan是基础句柄接口，用来保存空实现callback的span。
	type TelemetrySpan,
} from "../src/index.ts";

// schema分组先测可序列化/类型推导，再测组合词表/父子starter/错误原样传播。
describe("telemetry schemas", () => {
	// 首例定义operation与result事件：检查对象身份和JSON可序列化，并在不执行函数中检查坏属性/事件名。
	it("preserves serializable definitions and infers exact attributes", () => {
		// 先存普通定义对象，后面用toBe确认helper没克隆它。
		const definition = {
			// 版本1只是元数据，当前helper不据此迁移数据。
			version: 1,
			// span词表按名字建立。
			spans: {
				// operation是span名称，不是此刻已经创建的操作。
				operation: {
					// 描述当前操作，作为普通可序列化文本保留。
					description: "Test operation",
					// parents.kind:any是声明政策元数据，本helper不在运行时按它验证父级。
					parents: { kind: "any" },
					// 开始属性表只含kind。
					startAttributes: {
						// kind必须是read/write之一且必填；字符串联合由values与const断言推导。
						kind: { type: "string", required: true, values: ["read", "write"], description: "Kind" },
					},
					// 结束属性词表为空，类型化setAttributes不能任意增加unknown键。
					endAttributes: {},
					// 事件词表独立于span属性。
					events: {
						// result是合法事件名字。
						result: {
							// 事件描述保留普通字符串。
							description: "Result",
							// 事件自己有独立属性声明。
							attributes: {
								// outcome必需且只能ok/error；这与span状态的ok/error是两套字段。
								outcome: { type: "string", required: true, values: ["ok", "error"], description: "Outcome" },
							},
						},
					},
					// 状态默认与错误说明是schema元数据，不把errorWhen文字当可执行判断表达式。
					status: { default: "ok", errorWhen: "The operation fails" },
				},
			},
			// as const保留readonly字面量与只读元组类型，不运行Object.freeze或验证输入。
		} as const;
		// 交给defineTelemetrySchema约束并推导类型，返回仍是同一个对象。
		const schema = defineTelemetrySchema(definition);
		// toBe比较对象引用，证明当前helper不克隆或包装该定义。
		expect(schema).toBe(definition);
		// JSON.stringify不应抛错；只证明这个纯数据示例可序列化，不是自动为任意函数/循环对象脱敏。
		expect(() => JSON.stringify(schema)).not.toThrow();
		// typeof schema在类型位置读取变量的静态类型，泛型选operation；toMatchTypeOf检查可赋值方向，不是运行时数据格式校验。
		expectTypeOf<TelemetrySchemaSpanStartAttributes<typeof schema, "operation">>().toMatchTypeOf<{
			// 预期开始属性有必需kind，允许read或write字面量联合。
			kind: "read" | "write";
			// 关闭泛型类型参数并调用断言；类型内容擦除，不构造对应JS对象。
		}>();

		// 函数参数是按operation推导的span；只定义不调用，合法/非法方法调用都让tsc检查，不真的写事件。
		const compileTimeFailures = (span: SchemaTelemetrySpan<typeof schema, "operation">) => {
			// 合法result/outcome:ok示范，可通过静态检查。
			span.addEvent("result", { outcome: "ok" });
			// 下一行故意缺必需outcome，应由编译器拒绝。
			// @ts-expect-error required event attributes cannot be omitted
			span.addEvent("result");
			// 下一行other不在事件闭集，必须报类型错误。
			// @ts-expect-error closed-set event values are exact
			span.addEvent("result", { outcome: "other" });
			// 下一行unknown没有在词表声明，事件名也应限制。
			// @ts-expect-error undeclared events are rejected
			span.addEvent("unknown", {});
			// 下一行向空结束属性表加入unknown，检查精确键限制。
			// @ts-expect-error empty end schemas reject every attribute
			span.setAttributes({ unknown: true });
		};
		// 只把函数引用交给类型断言，不调用其中坏例；原有错误指令与目标保持相邻。
		expectTypeOf(compileTimeFailures).toBeFunction();
	});

	// 组合例子把operation和request两个schema接入同一starter；父callback返回child Promise，使42和拒绝值沿层传出，再检查静态名/参数关联。
	it("combines schema vocabularies and binds child starters to their parent spans", async () => {
		// 第一个schema定义顶层operation。
		const operationSchema = defineTelemetrySchema({
			// 词表版本1。
			version: 1,
			// span声明表。
			spans: {
				// 本表只拥有operation名字。
				operation: {
					// 描述operation。
					description: "Operation",
					// 声明root_or_external父政策；类型化starter当前不运行这份政策校验，后面也演示直接启动request。
					parents: { kind: "root_or_external" },
					// operation开始属性表。
					startAttributes: {
						// 必需kind=read/write，不能把request的provider交到这里冒充。
						kind: { type: "string", required: true, values: ["read", "write"], description: "Kind" },
					},
					// operation不声明结束属性。
					endAttributes: {},
					// 状态说明是元数据，不自动捕捉具体业务条件。
					status: { default: "ok", errorWhen: "The operation fails" },
				},
			},
			// const断言让版本/名字/values保留精确类型。
		} as const);
		// 第二个schema独立定义request，与operation组合成词表。
		const requestSchema = defineTelemetrySchema({
			// 版本3可与版本1并存，helper不要求版本号相等。
			version: 3,
			// 第二表的span定义。
			spans: {
				// request是此schema拥有的名字。
				request: {
					// 描述request。
					description: "Request",
					// parents字段列operation，当前helper不据此限制根starter；实际父级由启动上下文决定。
					parents: { kind: "spans", spans: ["operation"] },
					// request开始属性不是operation的kind。
					startAttributes: {
						// provider为必需任意string，没有声明闭集。
						provider: { type: "string", required: true, description: "Provider" },
					},
					// 结束阶段允许补response字段。
					endAttributes: {
						// response没有required:true，结束属性因此可选；描述文本不改变其string类型。
						response: { type: "string", description: "Response kind" },
					},
					// request状态同样只是schema声明，实际错误处理在adapter。
					status: { default: "ok", errorWhen: "The request fails" },
				},
			},
			// const断言保持各个标记字面量，帮助条件/映射类型推导。
		} as const);
		// 新建内存上下文作为根启动入口，日志从空开始。
		const telemetryContext = new InMemoryTelemetryContext();
		// 组合两个词表得到有类型的startSpan；schema值本身不保留/校验，类型检查保证名字唯一等约束。
		const startSpan = createTypedSpanStarter(telemetryContext, [operationSchema, requestSchema]);

		// 启动operation/read；箭头表达式直接返回下一行child Promise，外层await因此等孩子。_operationSpan表示本回调不使用第一个实参，但仍会收到它。
		const result = await startSpan("operation", { kind: "read" }, (_operationSpan, startChildSpan) =>
			// 第二实参startChildSpan绑定operation真实span，故request将有正确父id；provider是request的必需属性。
			startChildSpan("request", { provider: "example" }, (requestSpan) => {
				// 给request补结束属性response=cached，不等于结束span；真正结束等callback返回。
				requestSpan.setAttributes({ response: "cached" });
				// 孩子业务返回42，父callback直接返回孩子Promise，最终外层result也为42。
				return 42;
			}),
		);

		// 运行时结果必须保持数值42。
		expect(result).toBe(42);
		// tsc还检查推导结果恰是number类型；这不是额外运行时typeof检查。
		expectTypeOf(result).toEqualTypeOf<number>();
		// 从adapter读取当前两条span规范快照。
		const spans = telemetryContext.getSpans();
		// 按名字找到operation，不依赖完成顺序当索引。
		const operationSpan = spans.find((span) => span.name === "operation");
		// 同样找到request。
		const requestSpan = spans.find((span) => span.name === "request");
		// 直接调用根starter的operation没有本地父id，用null表示。
		expect(operationSpan?.parentId).toBeNull();
		// 孩子request.parentId必须等于operation.id；这里比较本地数字身份，不是StoredSpan完整字符串id。
		expect(requestSpan?.parentId).toBe(operationSpan?.id);

		// 用普通对象当同步抛出值，专门验证不会强制包装成新Error。
		const syncError = { kind: "sync" };
		// callback同步throw也应被startSpan返回的Promise承接，不在调用处同步逃逸。
		const syncResult = startSpan("operation", { kind: "write" }, () => {
			// 抛同一个syncError对象，保留引用身份。
			throw syncError;
		});
		// await rejects.toBe验证Promise拒绝且值是同一对象，不是只检查message文字。
		await expect(syncResult).rejects.toBe(syncError);

		// 再用另一个对象做异步拒绝值。
		const asyncError = { kind: "async" };
		// 直接从根starter启动request仍可运行，说明parents元数据没有自动强制父政策；async callback中的throw形成拒绝Promise。
		const asyncResult = startSpan("request", { provider: "example" }, async () => {
			// 抛原asyncError，adapter应继续传播。
			throw asyncError;
		});
		// 异步路径也按对象身份比较，不吞异常或转换成成功结果。
		await expect(asyncResult).rejects.toBe(asyncError);

		// 以下函数只让tsc检查坏调用，不执行它；Math.random也不会在测试运行时真的选择名字。
		const compileTimeFailures = () => {
			// 联合类型名字可能operation也可能request，不能配一份只适合operation的属性而让两者关联丢失。
			const spanName: "operation" | "request" = Math.random() > 0.5 ? "operation" : "request";
			// 下一行联合名尚未收窄，应产生预期类型错误；void只丢弃返回值，不会在运行时阻止调用。
			// @ts-expect-error union-valued names must be narrowed to preserve name and attribute correlation
			void startSpan(spanName, { kind: "read" }, () => {});
			// 变量含合法provider和额外unknown，const断言保留字面量以排除类型扩大干扰。
			const extraRequestAttributes = { provider: "example", unknown: true } as const;
			// 即便属性经变量传入，额外unknown键也应被Exact约束拒绝。
			// @ts-expect-error variables with unknown attributes are rejected
			void startSpan("request", extraRequestAttributes, () => {});
			// unknown名字没有在两个schema的任一个声明，应静态报错。
			// @ts-expect-error unknown span names are rejected across the combined vocabulary
			void startSpan("unknown", {}, () => {});
			// 把operation的kind属性交给request，应按实际拥有schema拒绝。
			// @ts-expect-error attributes are selected from the schema that owns the span
			void startSpan("request", { kind: "read" }, () => {});
			// 重复传operationSchema导致span名字重复，组合类型应拒绝；当前运行helper不自行扫描。
			// @ts-expect-error duplicate span names across schemas are rejected
			void createTypedSpanStarter(telemetryContext, [operationSchema, operationSchema]);
		};
		// 类型断言只接函数引用，绝不调用上述错误参数示例。
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});

// 空实现分组验证同步进入、返回值/异常保持和可调用的记录方法，不把inert误解成延迟执行callback。
describe("NOOP_TELEMETRY_CONTEXT", () => {
	// 同步进入例子在startSpan后尚未await时读admitted，并验证根/孩子复用同一冻结空span与能力对象。
	it("admits callbacks synchronously and reuses one inert span", async () => {
		// 标志初始false，若实现把callback排到稍后执行，下面立即断言就会失败。
		let admitted = false;
		// 外部变量先undefined，由callback同步填空span句柄。
		let firstSpan: TelemetrySpan | undefined;
		// async callback先执行到第一个await，startSpan本身返回Promise供外部稍后等待。
		const result = NOOP_TELEMETRY_CONTEXT.startSpan({ name: "first" }, async (span) => {
			// 立即写admitted，证明业务已进入，而不表示整个async操作已完成。
			admitted = true;
			// 保存空span对象引用，后面检查冻结/能力身份。
			firstSpan = span;
			// 孩子callback直接返回自己的span，await它的返回值；空实现不另分配一个记录句柄。
			const child = await span.startSpan({ name: "child" }, (childSpan) => childSpan);
			// toBe检查孩子和父是同一个共享对象。
			expect(child).toBe(span);
			// 业务返回42，空记录不意味着丢掉业务结果。
			return 42;
		});

		// 尚未await外部result时就必须true，专门验证同步入场。
		expect(admitted).toBe(true);
		// 现在等callback完成，最终业务值仍42。
		expect(await result).toBe(42);
		// 取得的空span对象实际被冻结，不只是readonly声明。
		expect(Object.isFrozen(firstSpan)).toBe(true);
		// 根空上下文复用共享空指标能力。
		expect(NOOP_TELEMETRY_CONTEXT.metrics).toBe(NOOP_TELEMETRY_METRICS);
		// 根空上下文也复用共享空传播能力。
		expect(NOOP_TELEMETRY_CONTEXT.propagation).toBe(NOOP_TELEMETRY_PROPAGATION);
		// 传入callback的空span有同一个空指标对象。
		expect(firstSpan?.metrics).toBe(NOOP_TELEMETRY_METRICS);
		// 其传播对象也相同，根/孩子不各建一套。
		expect(firstSpan?.propagation).toBe(NOOP_TELEMETRY_PROPAGATION);
	});

	// 拒绝值例子分别同步throw和async throw普通对象，检查空实现不吞业务错误或更改拒绝值身份。
	it("preserves synchronous and asynchronous rejection values", async () => {
		// 普通对象可被JS throw，不必是Error实例。
		const syncError = { kind: "sync" };
		// 非async callback直接抛出，空startSpan应以拒绝Promise返回。
		const sync = NOOP_TELEMETRY_CONTEXT.startSpan({ name: "sync" }, () => {
			// 抛原syncError，不创建替代错误。
			throw syncError;
		});
		// await拒绝断言，比较同一引用。
		await expect(sync).rejects.toBe(syncError);

		// 异步路径用另一个对象避免混淆。
		const asyncError = { kind: "async" };
		// async callback形成异步拒绝结果。
		const asyncResult = NOOP_TELEMETRY_CONTEXT.startSpan({ name: "async" }, async () => {
			// 抛原asyncError。
			throw asyncError;
		});
		// 异步拒绝身份也应原样传出。
		await expect(asyncResult).rejects.toBe(asyncError);
	});

	// 空记录方法例子逐个调用event/attributes/status/link，最后返回42；只验证方法可调用并保留业务值，不从此例推断内部存储内容。
	it("ignores typed recording payloads", async () => {
		// 等待空上下文callback完成，多行调用让options和callback分开阅读。
		const result = await NOOP_TELEMETRY_CONTEXT.startSpan(
			// 正常typed参数传操作名/初始属性，空实现不保存它们。
			{ name: "operation", attributes: { kind: "test" } },
			// callback仍得到完整空span接口，方法不缺失。
			(span) => {
				// 追加事件方法忽略payload而返回void。
				span.addEvent("event", { count: 1 });
				// 设置属性方法同样忽略，不修改任何已记录span。
				span.setAttributes({ complete: true });
				// 标error在空实现中无记录效果，也不会使业务Promise自动拒绝。
				span.setStatus({ status: "error", error: { name: "Expected", message: "test" } });
				// 自关联link也被忽略，不造成递归查找。
				span.addLink({ context: span });
				// 业务值仍应42，与遥测开关无关。
				return 42;
			},
		);
		// 比较最终返回值，而非把空实现误当成跳过callback。
		expect(result).toBe(42);
	});
});
