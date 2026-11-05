/**
 * 生成可被任意测试框架注册的遥测适配器契约用例，覆盖回调生命周期、父子关系、记录、状态及可选指标/传播能力。
 * span 是一段操作的记录句柄，fixture 是含独立上下文、规范记录读取器和清理方法的测试资源。
 * 例测试框架遍历 createTelemetryAdapterConformance(factory)，把每项 name/run 交给 it；创建列表本身不启动 adapter 或执行断言。
 * 每条 run 用独立 factory 夹具，await using 在作用域结束时等待异步清理；传播多跳用例还会创建两份独立夹具。
 * 比较的是 fixture 交出的规范快照及所列行为，不代表检查了真实后端的采样、网络导出、持久化、隐私或所有输入边界。
 * 未提供可选 metrics/propagation 的相关用例直接 return，测试框架通常把这次正常返回计通过，并没有调用 test.skip。
 */
// Node 断言会抛 AssertionError：deepStrictEqual 比结构，strictEqual 按 Object.is 比值/对象身份，ok 要求真值。
import { deepStrictEqual, fail, ok, strictEqual } from "node:assert/strict";
// NOOP 是真实运行值，其他 type 项编译期擦除；上下文显式传递，不依靠全局 current-span。
import { NOOP_TELEMETRY_CONTEXT, type TelemetryCarrier, type TelemetryContext, type TelemetrySpan } from "../index.ts";
// 快照类型复用内存参考记录器的规范形状，不要求被测适配器内部也用相同结构存储。
import type { RecordedTelemetrySpan } from "../memory.ts";
// 一组接口描述夹具工厂及框架无关 case；接口不会自行保证实例隔离或执行异步释放。
import type {
	TelemetryAdapterConformanceCase,
	TelemetryAdapterFixture,
	TelemetryAdapterFixtureFactory,
} from "./types.ts";

// 单条用例接一个已创建夹具，完成无业务返回值；拒绝 Promise 表示断言/适配器操作失败。
type ConformanceTest = (fixture: TelemetryAdapterFixture) => Promise<void>;

/**
 * 将工厂、分组、名字与测试回调包装为 case；返回对象后由调用者显式 run 才执行。
 * 例 metrics/records... 的 run 先 await factory，再 test，退出时 await fixture[Symbol.asyncDispose]()。
 * 工厂失败时还未登记可清理夹具；成功登记后正常/异常离开均走释放，释放自身失败也会影响 run 的拒绝结果，不在这里吞错。
 */
function createCase(
	// 每次 run 再调用工厂，独立性由工厂遵守，不在此克隆共享实例。
	factory: TelemetryAdapterFixtureFactory,
	// 元数据给框架组织 describe/it，不是实际测试逻辑。
	group: string,
	name: string,
	// 被测行为及断言封装在此异步回调。
	test: ConformanceTest,
): TelemetryAdapterConformanceCase {
	return {
		group,
		name,
		// async 方法返回 Promise<void>，清理也属于其完成之前的步骤。
		async run() {
			// await using 是显式资源管理声明：先等工厂，再为此作用域登记异步释放，不是普通 const。
			await using fixture = await factory();
			// 等待回调完成；即使断言抛错，已登记夹具仍按语言资源管理语义释放。
			await test(fixture);
		},
	};
}

/** 按名字找首条规范 span 快照，存在则返回原快照项，不存在抛断言；例 findSpan(rows,"parent") 供比较父 ID，不检查名字唯一或 span 已结束。 */
function findSpan(spans: readonly RecordedTelemetrySpan[], name: string): RecordedTelemetrySpan {
	// find 首个命中就停；readonly 数组只约束 TS，不在这里冻结/复制后端快照。
	const span = spans.find((candidate) => candidate.name === name);
	// ok 的断言签名也让 TS 知道后续 span 非 undefined。
	ok(span, `Expected recorded span ${name}`);
	// 返回找到的同一记录对象，不对其字段再作 schema 验证。
	return span;
}

/**
 * 等待一个应拒绝的 Promise，并断言抛出值与 expected 按 Object.is 相同；例 throw object 必须保留同一对象，reject(undefined) 也能比较。
 * 注意 try 同时包含 await 与 fail：若 operation 居然成功，fail 的 AssertionError 也进入此 catch，再与 expected 比较，并非 catch 只会收到业务拒绝值。
 * 本 helper 不修改适配器，不包装原拒绝为新 Error；失败通过 Node 断言继续抛给上层用例。
 */
async function rejectsWithSameValue(operation: Promise<unknown>, expected: unknown): Promise<void> {
	try {
		// operation 已由调用方创建；await 将其拒绝带入本 catch。
		await operation;
		// 意外成功则主动制造断言失败，这行仍处在 try 中。
		fail("Expected operation to reject");
	} catch (error) {
		// 不是 deepStrictEqual：对象必须同引用，NaN/+0/-0 等按 Object.is 语义比较。
		strictEqual(error, expected);
	}
}

/** Creates runner-independent cases for the callback telemetry adapter contract. */
/**
 * 返回一组新建的测试描述，不运行 factory 或其中回调；输入唯一工厂，输出 readonly case 数组，readonly 不会在运行时冻结数组。
 * 每条用例只在 run 时创建/操作/读取/清理夹具，例回调立即入场且最终结果同引用、显式状态不被自动覆盖。
 * 能力存在性依 fixture 字段选择，metrics/propagation 可早返；这里不负责某测试框架如何统计它们，也不声称所有后端功能都被穷尽验证。
 */
export function createTelemetryAdapterConformance(
	// 工厂无参数，异步提供规范 reader/上下文/可选能力与 AsyncDisposable 清理方法。
	factory: TelemetryAdapterFixtureFactory,
): readonly TelemetryAdapterConformanceCase[] {
	// 下面 createCase 立即组描述对象，实际适配器操作都封在异步用例回调内。
	return [
		// 能力透传：根、活动 span、子 span、提取的父上下文、已结束 span 的不记录子上下文都应保留同一能力对象。
		createCase(
			factory,
			"capabilities",
			"carries adapter capabilities through contexts and spans",
			async (fixture) => {
				// fixture 显式能力优先，否则从根上下文取预期；比较的是对象身份，不是相似方法。
				const metrics = fixture.metrics ?? fixture.context.metrics;
				const propagation = fixture.propagation ?? fixture.context.propagation;
				// 局部断言助手接任何 TelemetryContext，只比两个 capability 引用。
				const assertCapabilities = (context: TelemetryContext): void => {
					strictEqual(context.metrics, metrics);
					strictEqual(context.propagation, propagation);
				};
				// 根上下文也必须与选出的预期一致。
				assertCapabilities(fixture.context);
				// 保存回调句柄，待父回调结束后再尝试启动不记录的子操作。
				let settled: TelemetrySpan | undefined;
				await fixture.context.startSpan({ name: "capabilities" }, async (span) => {
					// 回调同步入场时捕获 span，下面异步子操作都在该父活动期等待完成。
					settled = span;
					assertCapabilities(span);
					// 子 span 的回调直接复用能力比较函数。
					await span.startSpan({ name: "capabilities.child" }, assertCapabilities);
					// 有传播能力才测试 inject/extract 后上下文能力，不强制所有适配器提供传播。
					if (propagation) {
						const parent = propagation.extract(propagation.inject(span));
						assertCapabilities(parent);
						await parent.startSpan({ name: "capabilities.extracted" }, assertCapabilities);
					}
				});
				// 先用 ok 收窄保存的句柄，父回调已正常结束。
				ok(settled);
				// 已结束源启动的回调仍执行且能力保留；本例仅验能力，是否记录在后面另验。
				await settled.startSpan({ name: "capabilities.inert" }, assertCapabilities);
			},
		),
		// 指标顺序：三种 instrument 产生四条规范测量，并检查 histogram 所带 span exemplar。
		createCase(
			factory,
			"metrics",
			"records ordered measurements and optional histogram exemplars",
			async (fixture) => {
				// 没显式 metrics 就正常早返，不检查 context.metrics 或通知框架 skip。
				if (!fixture.metrics) return;
				// 声明指标能力时必须有规范 reader，ok 同时让 TS 收窄该可选方法。
				ok(fixture.getMetrics, "Metrics fixtures require a normalized measurement reader");
				// counter 工厂接名字/描述/单位，add 接本次增量及属性，链式调用只记一条值 12。
				fixture.metrics
					.counter("bytes", { description: "Encoded bytes", unit: "By" })
					.add(12, { direction: "out" });
				// upDownCounter 允许正负增量，用同一句柄依次记录 +1、-1。
				const active = fixture.metrics.upDownCounter("active");
				active.add(1);
				active.add(-1);
				// boundaries 是桶提示，本用例比较元数据，不检查真实后端如何分桶聚合。
				const histogram = fixture.metrics.histogram("duration", { unit: "ms", boundaries: [1, 10] });
				// 显式传 span 作为第三参数关联测量，不依赖隐式活动 span。
				await fixture.context.startSpan({ name: "measured" }, (span) =>
					histogram.record(5, { method: "read" }, span),
				);
				// reader 可先 flush 再返回规范行，本测试不直接读取后端内部队列。
				const measurements = await fixture.getMetrics();
				// 先将每行投影到 kind/name/value，深比较明确记录次序及数量。
				deepStrictEqual(
					measurements.map((measurement) => [measurement.kind, measurement.name, measurement.value]),
					[
						["counter", "bytes", 12],
						["upDownCounter", "active", 1],
						["upDownCounter", "active", -1],
						["histogram", "duration", 5],
					],
				);
				// ?. 在行缺失时得到 undefined，断言仍会失败，不是静默允许漏记录。
				deepStrictEqual(measurements[0]?.attributes, { direction: "out" });
				strictEqual(measurements[0]?.description, "Encoded bytes");
				strictEqual(measurements[0]?.unit, "By");
				// 第四条必须保留桶提示与 measured span 的传播身份快照。
				deepStrictEqual(measurements[3]?.boundaries, [1, 10]);
				deepStrictEqual(measurements[3]?.context, findSpan(await fixture.getSpans(), "measured").context);
			},
		),
		// 指标快照：工厂元数据及 record 时的数组属性都应按各自时点保存，不能被调用方后续 mutation 改写。
		createCase(factory, "metrics", "copies instrument metadata and measurement attributes", async (fixture) => {
			// 可选能力缺失直接返回成功；提供时要求 reader。
			if (!fixture.metrics) return;
			ok(fixture.getMetrics, "Metrics fixtures require a normalized measurement reader");
			// 保留可变数组与对象，后面故意在 instrument 创建之后修改它们。
			const boundaries = [1, 10];
			const options = { description: "Original", boundaries };
			const histogram = fixture.metrics.histogram("snapshot", options);
			// 此时 instrument 应已捕获原始桶/描述，而不是稍后 record 时重读这两个值。
			boundaries.push(100);
			options.description = "Changed";
			// 测量属性中含数组，用后续 push 验证复制的是数组内容而非仅外层字典。
			const attributes = { tags: ["original"] };
			// histogram 允许负测量；未传第三个 context，规范快照应无 exemplar。
			histogram.record(-1, attributes);
			attributes.tags.push("changed");
			// 只比较 reader 暴露的规范结果，不证明后端所有元数据缓存都采用同样实现。
			const measurements = await fixture.getMetrics();
			strictEqual(measurements.length, 1);
			deepStrictEqual(measurements[0]?.attributes, { tags: ["original"] });
			deepStrictEqual(measurements[0]?.boundaries, [1, 10]);
			strictEqual(measurements[0]?.description, "Original");
			// 规范 reader 用 null 表达无 span 关联，不是空对象或隐式活动 span。
			strictEqual(measurements[0]?.context, null);
		}),
		// link 是关联而非父子关系：初始/后加 link 保留次序，NOOP 无可导出的目标身份不写入 link。
		createCase(factory, "links", "records initial and late links without changing parents", async (fixture) => {
			// 保存第一条已结束的真实 span 句柄供后续链接，身份仍应可使用。
			let target: TelemetrySpan | undefined;
			await fixture.context.startSpan({ name: "target" }, (span) => {
				target = span;
			});
			// 明确验证回调已给句柄，不能用非空断言掩盖未入场问题。
			if (!target) throw new Error("Expected target span");
			// const 捕获收窄后的句柄，供另一个回调稳定使用。
			const targetSpan = target;
			const attributes = { reason: ["initial"] };
			// linked 从根上下文启动，links 只声明关联，不把 target 自动设成 parent。
			await fixture.context.startSpan({ name: "linked", links: [{ context: target, attributes }] }, (span) => {
				// 初始 link 元数据应该已在 span 开始时复制，后续变更不进入快照。
				attributes.reason.push("mutated");
				// 活动源 span 可以追加 link，关联同一个目标但带另一组属性。
				span.addLink({ context: targetSpan, attributes: { reason: "late" } });
				// 共享 NOOP 上下文不具有此适配器可记录的目标身份，期望忽略而非伪造 link。
				span.addLink({ context: NOOP_TELEMETRY_CONTEXT });
			});
			// 读规范结果并确认 linked 仍是根，link 没改变它的 parent。
			const spans = await fixture.getSpans();
			const linked = findSpan(spans, "linked");
			strictEqual(linked.parentId, null);
			strictEqual(linked.parentContext, null);
			// 只保留初始与 late 两条，目标传播上下文与 target 快照一致，顺序不颠倒。
			deepStrictEqual(linked.links, [
				{ context: findSpan(spans, "target").context, attributes: { reason: ["initial"] } },
				{ context: findSpan(spans, "target").context, attributes: { reason: "late" } },
			]);
		}),
		// 已结束的是 link 来源：此后 addLink 不应再修改它，而非禁止链接到已结束的目标。
		createCase(factory, "links", "ignores links added after source settlement", async (fixture) => {
			let source: TelemetrySpan | undefined;
			await fixture.context.startSpan({ name: "link-source" }, (span) => {
				// 在活动回调里只保存句柄，没有添加初始 link。
				source = span;
			});
			// await 已完成才操作，验证 settlement 后不再修改记录的语义。
			if (!source) throw new Error("Expected source span");
			source.addLink({ context: source });
			// 自链接也应该被忽略，最终仍是零 link。
			deepStrictEqual(findSpan(await fixture.getSpans(), "link-source").links, []);
		}),

		// JSON 往返后的传播值必须能还原 parent，extract 不应继续依赖调用方随后会改写的 carrier。
		createCase(
			factory,
			"propagation",
			"roundtrips parent identity through JSON without retaining the carrier",
			async (fixture) => {
				// 仅 fixture 显式声明传播能力时执行，缺失不被测试框架标记 skip。
				if (!fixture.propagation) return;
				const propagation = fixture.propagation;
				await fixture.context.startSpan({ name: "sender" }, async (span) => {
					// 导出 adapter 拥有的不透明字符串字段，必须有可序列化身份。
					const carrier = propagation.inject(span);
					ok(carrier);
					// JSON stringify/parse 模拟跨边界传输；as 仅静态声明，不新增字段校验。
					const wire = JSON.parse(JSON.stringify(carrier)) as TelemetryCarrier;
					const parent = propagation.extract(wire);
					// extract 之后故意破坏传入对象，后续 receiver 仍应引用原 sender 身份。
					for (const key of Object.keys(wire)) wire[key] = "mutated";
					await parent.startSpan({ name: "receiver" }, () => 42);
					// 同时确认修改 wire 没把 sender 原导出/上下文身份污染。
					deepStrictEqual(propagation.inject(span), carrier);
				});
				const spans = await fixture.getSpans();
				// 比传播上下文而非只比本地 parentId，适用于后端自己的 identity 格式。
				deepStrictEqual(findSpan(spans, "receiver").parentContext, findSpan(spans, "sender").context);
			},
		),
		// 无传播数据或不能识别的格式，应回到可记录根上下文，不丢弃后续业务回调/记录。
		createCase(factory, "propagation", "absent and unknown carriers produce recorded roots", async (fixture) => {
			if (!fixture.propagation) return;
			// NOOP 不应被导出成伪造的传播身份。
			strictEqual(fixture.propagation.inject(NOOP_TELEMETRY_CONTEXT), undefined);
			// readonly 数组依次覆盖缺失、空对象、陌生字段格式，不是在穷尽任意畸形 wire 输入。
			const carriers: readonly (TelemetryCarrier | undefined)[] = [undefined, {}, { unknown: "format" }];
			for (const [index, carrier] of carriers.entries()) {
				// entries 同时给序号和值，序号只用于为每次创建不同的测试 span 名。
				const context = fixture.propagation.extract(carrier);
				strictEqual(await context.startSpan({ name: `fallback-${index}` }, () => 42), 42);
			}
			// 这些 fallback 记录都必须没有 parentContext；本例没有另断言 span 总数。
			for (const span of await fixture.getSpans()) strictEqual(span.parentContext, null);
		}),

		// 多跳在独立 adapter 之间传递，避免只验证同一 recorder 内部对象共享可以工作的假象。
		createCase(factory, "propagation", "propagates across fresh adapters and multiple hops", async (fixture) => {
			if (!fixture.propagation) return;
			// 与 createCase 的初始夹具之外，再创建 receiver/worker；退出时按资源声明逆序异步释放。
			await using receiver = await factory();
			await using worker = await factory();
			// 同一 factory 的新实例应也提供传播能力，这里缺失则明确失败，不早返略过。
			if (!receiver.propagation || !worker.propagation) throw new Error("Expected propagation on each fixture");
			// 传播对象可 undefined，等回调注入后用 ok 确认存在。
			let senderCarrier: TelemetryCarrier | undefined;
			await fixture.context.startSpan({ name: "sender" }, (span) => {
				senderCarrier = fixture.propagation?.inject(span);
			});
			ok(senderCarrier);
			let receiverCarrier: TelemetryCarrier | undefined;
			// 第一次跨实例 JSON 往返，receiver 的父由 sender 身份指定。
			await receiver.propagation
				.extract(JSON.parse(JSON.stringify(senderCarrier)) as TelemetryCarrier)
				.startSpan({ name: "receiver" }, (span) => {
					// 第二跳携带 receiver 本身身份，而非继续拿 sender 冒充当前父。
					receiverCarrier = receiver.propagation?.inject(span);
				});
			ok(receiverCarrier);
			// 第二次跨实例传输，worker 是 receiver 的子记录。
			await worker.propagation
				.extract(JSON.parse(JSON.stringify(receiverCarrier)) as TelemetryCarrier)
				.startSpan({ name: "worker" }, () => {});
			// 分别查询两家规范 reader，比较完整传播父身份，不要求跨 recorder 的本地数字 ID 相等。
			deepStrictEqual(findSpan(await receiver.getSpans(), "receiver").parentContext, senderCarrier);
			deepStrictEqual(findSpan(await worker.getSpans(), "worker").parentContext, receiverCarrier);
		}),
		// 回调入场必须同步且一次，最终 Promise 得到回调返回的同一对象，而非经过 JSON 拷贝的新对象。
		createCase(
			factory,
			"callback lifecycle",
			"admits once synchronously and preserves the result",
			async (fixture) => {
				// 标志/计数在 startSpan 返回 Promise 后立即检查，不先 await。
				let admitted = false;
				let calls = 0;
				const expected = { value: 42 };
				const result = fixture.context.startSpan({ name: "success" }, () => {
					// 若 adapter 把回调推到之后的微任务，下面立即断言就会失败。
					admitted = true;
					calls++;
					return expected;
				});

				// 入场立即可见、只调用一次，await 后结果保持身份。
				strictEqual(admitted, true);
				strictEqual(calls, 1);
				strictEqual(await result, expected);
				// 没显式改状态且业务成功，规范记录应为 ok 且已经 settled。
				deepStrictEqual(findSpan(await fixture.getSpans(), "success").status, { status: "ok" });
				strictEqual(findSpan(await fixture.getSpans(), "success").settled, true);
			},
		),

		// 不论同步 throw、async throw 或拒绝 undefined，都应原样成为 startSpan Promise 的拒绝值。
		createCase(
			factory,
			"callback lifecycle",
			"preserves synchronous and asynchronous rejection values",
			async (fixture) => {
				// 构造一个 Error 实例，在同步回调里抛它；startSpan 不应在返回 Promise 前直接抛出。
				const syncError = new Error("sync");
				await rejectsWithSameValue(
					fixture.context.startSpan({ name: "sync-error" }, () => {
						throw syncError;
					}),
					// helper 断言对象身份，不只是 message 相等。
					syncError,
				);

				// 任意对象也可以作为 JS 抛出值，不应强制包装成新 Error。
				const asyncError = { kind: "async" };
				await rejectsWithSameValue(
					fixture.context.startSpan({ name: "async-error" }, async () => {
						throw asyncError;
					}),
					asyncError,
				);

				// undefined 拒绝同样是失败，不能用 truthy 判断把它误当没有异常。
				await rejectsWithSameValue(
					fixture.context.startSpan({ name: "undefined-error" }, () => Promise.reject(undefined)),
					undefined,
				);

				// 三种拒绝均未显式设置 span 状态，自动结算应把记录标 error。
				const spans = await fixture.getSpans();
				for (const name of ["sync-error", "async-error", "undefined-error"]) {
					strictEqual(findSpan(spans, name).status.status, "error");
				}
			},
		),

		// 显式状态独立于业务 Promise 成败：最后一次 setStatus 胜出，自动结束不能覆盖它。
		createCase(factory, "status", "uses last explicit status without automatic overwrite", async (fixture) => {
			await fixture.context.startSpan({ name: "last-status" }, (span) => {
				// 先 error 后 ok，用最终快照验证后写覆盖前写。
				span.setStatus({ status: "error", error: { name: "Expected", message: "first" } });
				span.setStatus({ status: "ok" });
			});

			// 即使之后业务 throw，明确设置过的 ok 状态仍保留，但业务拒绝值照常透出。
			const thrown = new Error("after explicit status");
			await rejectsWithSameValue(
				fixture.context.startSpan({ name: "explicit-before-throw" }, (span) => {
					span.setStatus({ status: "ok" });
					throw thrown;
				}),
				thrown,
			);

			// 异步拒绝同理；显式错误描述与实际拒绝对象可以不同，自动结算不能把它们混写。
			const rejected = new Error("after async explicit status");
			await rejectsWithSameValue(
				fixture.context.startSpan({ name: "explicit-before-rejection" }, (span) => {
					span.setStatus({ status: "error", error: { name: "Expected", message: "async failure" } });
					// 回调返回拒绝 Promise，由 startSpan 等待后原样拒绝。
					return Promise.reject(rejected);
				}),
				rejected,
			);

			// 业务正常返回 {ok:false} 也可显式标 error；adapter 不自动解析领域结果的 ok 字段。
			await fixture.context.startSpan({ name: "expected-failure" }, (span) => {
				span.setStatus({ status: "error", error: { name: "Expected", message: "returned failure" } });
				return { ok: false };
			});

			// 对照四种组合的规范状态，业务 Promise 的拒绝已由前面 helper 验证。
			const spans = await fixture.getSpans();
			deepStrictEqual(findSpan(spans, "last-status").status, { status: "ok" });
			deepStrictEqual(findSpan(spans, "explicit-before-throw").status, { status: "ok" });
			deepStrictEqual(findSpan(spans, "explicit-before-rejection").status, {
				status: "error",
				error: { name: "Expected", message: "async failure" },
			});
			deepStrictEqual(findSpan(spans, "expected-failure").status, {
				status: "error",
				error: { name: "Expected", message: "returned failure" },
			});
		}),

		// 属性按键合并且跳 undefined，事件保持添加次序；不把 undefined 当作删除旧属性的标记。
		createCase(factory, "recording", "merges attributes and records ordered events", async (fixture) => {
			// 初始属性随 span 建立，随后回调覆盖 overwrite 并添加 count。
			await fixture.context.startSpan(
				{
					name: "recording",
					attributes: { start: "value", overwrite: "start", ignored: undefined },
				},
				(span) => {
					// middle 被下一次 end 覆盖，count=1 不被后来的 undefined 清掉。
					span.setAttributes({ count: 1, overwrite: "middle" });
					span.setAttributes({ count: undefined, overwrite: "end" });
					// 每个事件各带属性，undefined 键不应出现在规范快照中。
					span.addEvent("first", { index: 1, ignored: undefined });
					span.addEvent("second", { index: 2 });
				},
			);

			// 只比较这条规范记录的字段和事件，不推断后端持久层采用何种写入方式。
			const span = findSpan(await fixture.getSpans(), "recording");
			deepStrictEqual(span.attributes, { start: "value", overwrite: "end", count: 1 });
			deepStrictEqual(span.events, [
				{ name: "first", attributes: { index: 1 } },
				{ name: "second", attributes: { index: 2 } },
			]);
		}),

		// 结束句柄的后续记录操作应被忽略，但启动子操作仍须同步执行业务回调并保留结果，不能直接丢业务。
		createCase(factory, "recording", "makes calls after settlement inert", async (fixture) => {
			let settledSpan: TelemetrySpan | undefined;
			await fixture.context.startSpan({ name: "settled", attributes: { value: "initial" } }, (span) => {
				// 保存句柄，等 startSpan Promise 完成后才执行下面的 late 操作。
				settledSpan = span;
			});
			// 用 const 固定已经捕获的值，并明确断言回调确实发生。
			const capturedSpan = settledSpan;
			if (!capturedSpan) throw new Error("Expected callback span");

			// 这三次记录请求在 settlement 后都不得修改原记录。
			capturedSpan.setAttributes({ value: "late" });
			capturedSpan.addEvent("late", { value: true });
			capturedSpan.setStatus({ status: "error" });
			// late 子回调仍执行，但不创建第二条可记录 span；本例不要求某种特定句柄实现。
			let childAdmitted = false;
			const childResult = capturedSpan.startSpan({ name: "late-child" }, () => {
				childAdmitted = true;
				return 7;
			});
			// 不先 await 就检查入场；随后拿到业务返回 7。
			strictEqual(childAdmitted, true);
			strictEqual(await childResult, 7);

			// 总数必须仍是 1，原属性/空事件/ok 状态都保持。
			const spans = await fixture.getSpans();
			strictEqual(spans.length, 1);
			deepStrictEqual(spans[0]?.attributes, { value: "initial" });
			deepStrictEqual(spans[0]?.events, []);
			deepStrictEqual(spans[0]?.status, { status: "ok" });
		}),

		// 显式父句柄同时启动两个子操作，控制它们的完成次序来验证父子身份和独立结算顺序。
		createCase(factory, "parentage", "records nested and concurrent child relationships", async (fixture) => {
			// 稍后填入 Promise 的 resolve，不是提前完成的门；类型允许初始 undefined。
			let releaseFirst: (() => void) | undefined;
			const firstGate = new Promise<void>((resolve) => {
				// executor 同步运行，保存放行第一子操作的函数。
				releaseFirst = resolve;
			});

			// parent 的 async 回调自己等待两个孩子；本测试不证明 adapter 会自动等待未 await 的子操作。
			await fixture.context.startSpan({ name: "parent" }, async (parent) => {
				const first = parent.startSpan({ name: "first-child" }, async () => {
					// 第一子操作挂起，留出让第二个先完成的窗口。
					await firstGate;
				});
				// 第二个从同一个 parent 启动，不应错误地变成 first 的子级。
				const second = parent.startSpan({ name: "second-child" }, () => "done");
				strictEqual(await second, "done");
				// 第二个结束后才放行第一个；?. 避免直接调用可能 undefined 的函数类型。
				releaseFirst?.();
				// 第一子操作也结束后父回调才返回，父记录应最后结算。
				await first;
			});

			// 规范 reader 提供本地 parentId 和单调结束序号，分别验证关联与先后，不依赖数组排列当完成顺序。
			const spans = await fixture.getSpans();
			const parent = findSpan(spans, "parent");
			const first = findSpan(spans, "first-child");
			const second = findSpan(spans, "second-child");
			// parent 从根创建，两子记录必须同指 parent.id。
			strictEqual(parent.parentId, null);
			strictEqual(first.parentId, parent.id);
			strictEqual(second.parentId, parent.id);
			// ok 先确认三序号都存在，TS 随后可按 number 比较严格顺序。
			ok(second.endSequence !== undefined && first.endSequence !== undefined && parent.endSequence !== undefined);
			ok(second.endSequence < first.endSequence);
			ok(first.endSequence < parent.endSequence);
		}),
	];
}
