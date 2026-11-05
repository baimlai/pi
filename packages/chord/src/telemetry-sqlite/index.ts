// 所属：Chord 的可移植 SQLite telemetry 适配器（@earendil-works/chord/telemetry-sqlite），实现 pi-telemetry 的
// TelemetryContext/TelemetryStore/TelemetryPropagation 接口，不依赖具体服务器或网络传输。
// 职责：把已结束的 span 先缓冲在内存，按秒批量写入 SQLite；把指标按 10 秒区间聚合；查询只读已提交行。
// 边界：记录路径不做 SQL；不关闭传入的数据库；写入失败会永久停止记录，并通过之后的 flush/close 报错。
// 上游：应用在启动时 createSqliteTelemetry(db, options)；下游：sqlite 的迁移/事务和 store.ts 的查询函数。
// 导出清单：SqliteTelemetryOptions 配置保留期与容量；SqliteTelemetry 汇总上下文、存储、指标、传播、丢弃计数、flush/close；
// createSqliteTelemetry 是唯一入口；内部 Recorder 实现记录与写入，Identity/Link/Metric 是缓冲行的形状。
// 组合顺序：迁移建表 → new Recorder → startSpan/metric 缓冲 → 每秒 drain → 单事务写库并清理 → getTrace/findTraces/findMetrics。
// 示例：const telemetry = await createSqliteTelemetry(db, { maxQueuedSpans: 5000 });
//       await telemetry.startSpan({ name: "request" }, (span) => span.addEvent("start"));
// 阅读顺序：Options → SqliteTelemetry → 内部类型/常量 → Recorder 字段/构造 → start/inert → measurement → 查询 → flush/close/drain → 入口。
import {
	type InstrumentOptions,
	NOOP_TELEMETRY_CONTEXT,
	type SpanAttributes,
	type SpanLink,
	type SpanOptions,
	type SpanStatus,
	type TelemetryCarrier,
	type TelemetryContext,
	type TelemetryMetrics,
	type TelemetryPropagation,
	type TelemetrySpan,
	type TelemetryStore,
} from "@earendil-works/pi-telemetry";
import { applySqliteMigrations, type SqliteDatabase, type SqliteValue } from "../sqlite/index.ts";
import { findMetrics, findTraces, getTrace } from "./store.ts";

// createSqliteTelemetry 的选项；两个字段都可省略，省略时使用下面的默认值。
export interface SqliteTelemetryOptions {
	/** Retain seven days by default. Cleanup runs in the flush transaction. */
	// retentionMs：span 和指标保留多久，默认 7 天；过期行在每次 flush 的同一事务里删除。
	readonly retentionMs?: number;
	/** Settled spans awaiting commit, including the in-flight batch. Defaults to 10,000.
	 * Also bounds pending metric interval/series pairs independently. */
	// maxQueuedSpans：等待提交的 span 上限（含正在写的批次），也独立限制待聚合的指标 series 数量。
	// 达到上限后新数据被丢弃并计数，不会阻塞调用方，也不会扩大内存占用。
	readonly maxQueuedSpans?: number;
}

// 对外句柄：既是创建 span/指标的上下文，也是查询存储；应用通常只保存这个类型。
export interface SqliteTelemetry extends TelemetryContext, TelemetryStore {
	// metrics：创建 counter/upDownCounter/histogram 仪器的入口；这里的对象是无状态工厂。
	readonly metrics: TelemetryMetrics;
	// propagation：跨进程注入/提取 span 身份；载体只是两个字符串，不包含完整上下文。
	readonly propagation: TelemetryPropagation;
	// droppedSpans/droppedMeasurements：因容量上限丢弃的数量；只增不减，用于监控记录是否过载。
	readonly droppedSpans: number;
	readonly droppedMeasurements: number;
	/** Persist settled spans and completed ten-second metric intervals. */
	// flush：把已结束 span 和已完成的指标区间写入数据库；写入失败会拒绝并让记录器停止。
	flush(): Promise<void>;
	/** Stop recording and drain, including partial metric intervals. Does not close the database. */
	// close：停止记录并 drain（包含当前未完成的指标区间）；幂等，不关闭数据库本身。
	close(): Promise<void>;
}

// Identity：span 在内存中的 id 与所属 traceId；WeakMap 以 span/context 对象为键，不阻止它们被回收。
type Identity = { id: string; traceId: string };
// Link：写入 links JSON 的链接形状，字段用 snake_case 与数据库列/查询侧一致；attributes 可省略。
type Link = { trace_id: string; span_id: string; attributes?: SpanAttributes };
// Metric：一个 10 秒区间内一个 series 的聚合结果；series 由 name、kind、unit 和排序后的属性共同确定。
type Metric = {
	// interval：区间起点（毫秒时间戳，向下取整到 10 秒）；key 是序列标识，attributes 是规范化后的 JSON 字符串。
	interval: number;
	key: string;
	name: string;
	kind: "counter" | "upDownCounter" | "histogram";
	unit: string | null;
	attributes: string;
	count: number;
	sum: number;
	min: number;
	max: number;
};
// identities：span/context 对象到 Identity 的映射，只在本进程内有效；不会写入数据库，也不会被枚举。
// carrierKey/traceKey：传播载体中的两个字符串字段；intervalMs：指标聚合窗口，固定 10 秒。
const identities = new WeakMap<TelemetryContext, Identity>();
const carrierKey = "pi-sqlite-span";
const traceKey = "pi-sqlite-trace";
const intervalMs = 10_000;

// 复制 span 属性，返回新对象：去掉 undefined，数组值浅拷贝，避免调用方之后修改影响已记录数据。
// 输入可省略；输出始终是对象（空对象表示无属性）。嵌套对象/数组元素不再深拷贝。
// 示例：copyAttributes({ a: [1], b: undefined }) 得到 { a: [1] }。
function copyAttributes(attributes?: SpanAttributes): SpanAttributes {
	return Object.fromEntries(
		Object.entries(attributes ?? {})
			// 解构只取 value；undefined 在 JSON 中会被省略为缺失，主动过滤让属性集合稳定。
			.filter(([, value]) => value !== undefined)
			// Array.isArray 是运行时检查：属性值可能是数组；展开只复制一层，元素仍共享引用。
			.map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
	);
}

// 把 SpanLink 转成可持久化行；链接的 context 必须由本记录器创建，否则返回 undefined 并丢弃。
// 这是跨记录器/跨进程边界的过滤：身份表里没有的对象无法提供给本地 trace 查询。
// 示例：同一次 startSpan 中 addLink({ context: span }) 会保存 traceId/spanId；外部 context 则被忽略。
function copyLink(link: SpanLink): Link | undefined {
	// WeakMap 查找是对象身份匹配，不是比较 id 字符串；context 被回收后链接自然不再可解析。
	const identity = identities.get(link.context);
	return identity
		? { trace_id: identity.traceId, span_id: identity.id, attributes: copyAttributes(link.attributes) }
		: undefined;
}

// 记录器实现：内存缓冲 + 定时批量写。构造后开始每秒检查；startSpan 只做内存工作，从不运行 SQL。
// 输入 db/retention/capacity；输出实现 SqliteTelemetry 的对象；副作用是启动一个 unref 的 interval。
// 错误路径：写入失败会把 failed/stopped 置位、清空缓冲并拒绝当次 drain；之后每次 flush/close 都复用该错误。
// 主要流程：start 收集数据 → finally 入队 → 定时器 drain → 事务写 spans/metrics + 清理过期行。
// 示例：const recorder = new Recorder(db, 86400000, 1000); await recorder.startSpan({ name: "x" }, () => 1);
class Recorder implements SqliteTelemetry, TelemetryPropagation {
	readonly propagation: TelemetryPropagation = this;
	// metrics：把三种仪器调用映射到 measurement，返回的仪器对象只暴露 add/record，不持有其他状态。
	readonly metrics: TelemetryMetrics = {
		counter: (name, options) => ({ add: this.measurement("counter", name, options) }),
		upDownCounter: (name, options) => ({ add: this.measurement("upDownCounter", name, options) }),
		histogram: (name, options) => ({ record: this.measurement("histogram", name, options) }),
	};
	// 丢弃计数是公开可变字段（接口要求 readonly 读取）；记录器内部递增。
	droppedSpans = 0;
	droppedMeasurements = 0;
	// db/retention/capacity：构造时固定；scope 是本次记录器的随机前缀，sequence 生成进程内唯一 span id。
	// spans：已结束 span 的参数数组队列；measurements：pendingKey → 聚合指标；inFlightMeasurements 是正在写的指标数。
	// timer：每秒触发一次；stopped 阻止新数据；failed/failure 保存永久写入错误；writing/closing 串行化 drain。
	private readonly db: SqliteDatabase;
	private readonly retention: number;
	private readonly capacity: number;
	private readonly scope = crypto.randomUUID();
	private sequence = 0;
	private readonly spans: SqliteValue[][] = [];
	private readonly measurements = new Map<string, Metric>();
	private inFlightMeasurements = 0;
	private readonly timer: ReturnType<typeof setInterval>;
	private stopped = false;
	private failed = false;
	private failure: unknown;
	private writing?: Promise<void>;
	private closing?: Promise<void>;

	// 保存配置并启动自动刷新；定时器回调不 await，错误被吞掉，真正的错误留给显式 flush/close 报告。
	// unref?.() 让定时器不阻止 Node 进程退出；可选调用是为了兼容没有 unref 的运行时形状。
	constructor(db: SqliteDatabase, retention: number, capacity: number) {
		this.db = db;
		this.retention = retention;
		this.capacity = capacity;
		this.timer = setInterval(() => {
			// 已有写入时跳过本轮，避免定时器堆积并发事务；void 明确表示故意不等待 Promise。
			if (!this.writing) void this.flush().catch(() => {});
		}, 1000);
		this.timer.unref?.();
	}

	// 创建根 span 并执行 callback，返回 callback 的结果；没有父身份，traceId 由新 span 自己生成。
	// 泛型 T 保留同步或异步返回值；callback 抛错时原样拒绝，同时 span 自动标记 error（除非显式设置了状态）。
	// 示例：const value = await startSpan({ name: "load" }, async (span) => { span.addEvent("go"); return 1; });
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return this.start(undefined, options, callback);
	}

	// 把 context/span 的身份写成载体；不是本记录器创建的 context 返回 undefined（无法传播）。
	// 载体字段名固定为 pi-sqlite-span/pi-sqlite-trace，值是字符串；不做签名或加密。
	inject(context: TelemetryContext): TelemetryCarrier | undefined {
		const identity = identities.get(context);
		return identity ? { [carrierKey]: identity.id, [traceKey]: identity.traceId } : undefined;
	}

	// 从外部载体恢复父上下文；carrier 是信任边界，两个字段都必须是非空字符串，否则返回 this（空上下文）。
	// 恢复出的 parent 只携带 id 和 startSpan；它没有 abortSignal，也不会继承调用方的取消状态。
	// 示例：const parent = telemetry.extract(headers); const child = parent.startSpan(...)。
	extract(carrier: TelemetryCarrier | undefined): TelemetryContext {
		const id = carrier?.[carrierKey];
		const traceId = carrier?.[traceKey];
		// 运行时形状检查在此必要：carrier 来自其他进程/头部，TypeScript 类型不能保证实际值。
		if (typeof id !== "string" || typeof traceId !== "string") return this;
		const identity = { id, traceId };
		const parent: TelemetryContext = {
			metrics: this.metrics,
			propagation: this,
			startSpan: (options, callback) => this.start(identity, options, callback),
		};
		// 注册身份后，inject(parent) 和以它为链接的 copyLink 才能解析；parent 是新建对象，不会与已有 context 冲突。
		identities.set(parent, identity);
		return parent;
	}

	// 记录器停止后的降级路径：仍执行 callback，但 span 不记录；metrics/propagation 仍指向本对象，startSpan 继续 inert。
	// 用 NOOP_TELEMETRY_CONTEXT 生成基础 span，再覆盖三个成员；不会访问数据库，也不会增加计数。
	private inert<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return NOOP_TELEMETRY_CONTEXT.startSpan(options, (noop) =>
			callback({
				...noop,
				metrics: this.metrics,
				propagation: this,
				startSpan: (options, callback) => this.inert(options, callback),
			}),
		);
	}

	// 所有 span 创建的实际实现：先快照属性/链接并分配身份，再构造 span 回调，最后在 finally 入队已结束 span。
	// parent 为 undefined 表示新 trace；否则沿用 parent.traceId，parent.id 作为数据库中的 parent_id。
	// 副作用：读取时钟、写 identities、可能把行放入 spans；错误：callback 的错误原样抛出，入队失败目前不会发生。
	private async start<T>(
		parent: Identity | undefined,
		options: SpanOptions,
		callback: (span: TelemetrySpan) => T | Promise<T>,
	): Promise<T> {
		// 停止后不再分配 id 或写缓冲；inert 保持业务回调可运行，避免 telemetry 关闭导致调用链失败。
		if (this.stopped) return this.inert(options, callback);
		const name = options.name;
		// 属性先复制成局部变量；span.setAttributes 之后整体替换对象，已交给 span 的旧引用不受影响。
		let attributes = copyAttributes(options.attributes);
		// 只保留能解析到本地身份的链接；options.links 是调用方提供的数组，可能包含其他记录器/进程的 context。
		const links: Link[] = [];
		for (const link of options.links ?? []) {
			const copied = copyLink(link);
			if (copied) links.push(copied);
		}
		// id 由记录器随机前缀和进程内递增序号组成；跨重启不保证唯一，但不含时间或用户数据。
		const id = `${this.scope}:${++this.sequence}`;
		const identity = { id, traceId: parent?.traceId ?? id };
		// started 是墙上时钟毫秒，用于查询/保留；clock 是单调时钟，仅用于计算持续时间，避免系统时间回拨。
		const started = Date.now();
		const clock = performance.now();
		const events: { name: string; time_ms: number; attributes: SpanAttributes }[] = [];
		// 默认 ok；explicit 记录调用方是否主动 setStatus，决定抛错时是否覆盖；settled 阻止结束后的修改。
		let status: SpanStatus = { status: "ok" };
		let explicit = false;
		let settled = false;
		// 统一的延迟写入守卫：span 已结束或记录器已停止时，addEvent/addLink/setAttributes/setStatus 静默无效。
		const record = (action: () => void): void => {
			if (!settled && !this.stopped) action();
		};
		const span: TelemetrySpan = {
			metrics: this.metrics,
			propagation: this,
			// 子 span 在父 span 结束后改为 inert；否则沿用父身份，traceId 相同、parent_id 指向本 span。
			startSpan: (options, callback) =>
				settled ? this.inert(options, callback) : this.start(identity, options, callback),
			addLink: (link) =>
				record(() => {
					const copied = copyLink(link);
					if (copied) links.push(copied);
				}),
			// 事件时间用 performance.now 相对 span 起点，单位毫秒；属性同样复制并去掉 undefined。
			addEvent: (name, attrs) =>
				record(() => {
					events.push({ name, time_ms: performance.now() - clock, attributes: copyAttributes(attrs) });
				}),
			setAttributes: (attrs) =>
				record(() => {
					attributes = { ...attributes, ...copyAttributes(attrs) };
				}),
			// 复制 error 对象，避免之后修改影响已记录状态；没有 error 的 error 状态只保留 status。
			setStatus: (value) =>
				record(() => {
					status =
						value.status === "error" && value.error
							? { status: "error", error: { ...value.error } }
							: { status: value.status };
					explicit = true;
				}),
		};
		identities.set(span, identity);
		// callback 可以同步返回值或 Promise；await 统一两种路径，确保 finally 在异步结束后才入队。
		try {
			return await callback(span);
		} catch (error) {
			// 调用方已显式设置状态时不覆盖；否则把抛出的 Error 转成 name/message，非 Error 只记 error 状态。
			if (!explicit)
				status =
					error instanceof Error
						? { status: "error", error: { name: error.name, message: error.message } }
						: { status: "error" };
			throw error;
		} finally {
			settled = true;
			// 结束瞬间若 close 已置 stopped，则不把这条 span 放入缓冲；容量满时只增加 droppedSpans。
			if (!this.stopped) {
				if (this.spans.length >= this.capacity) this.droppedSpans++;
				else
					this.spans.push([
						id,
						identity.traceId,
						parent?.id ?? null,
						name,
						started,
						started + performance.now() - clock,
						// 行参数顺序与 telemetry_spans 表一致：id/trace/parent/name/开始/结束/属性/事件/链接/状态。
						JSON.stringify(attributes),
						JSON.stringify(events),
						JSON.stringify(links),
						JSON.stringify(status),
					]);
			}
		}
	}

	// 生成一个仪器写入函数：每次调用把 value 聚合到当前 10 秒区间的一个 series。
	// 输入 kind/name/options(unit)；输出 (value, attributes) => void；不返回值、不同步写库。
	// 属性先按键排序再 JSON 编码，保证相同属性集合得到相同 series；容量满时丢弃并计数。
	// 示例：const hits = metrics.counter("hits", { unit: "1" }); hits.add(1, { route: "/a" });
	private measurement(
		kind: Metric["kind"],
		name: string,
		options?: InstrumentOptions,
	): (value: number, attributes?: SpanAttributes) => void {
		const unit = options?.unit ?? null;
		return (value, attributes) => {
			if (this.stopped) return;
			const copied = copyAttributes(attributes);
			// Object.keys(...).sort() 固定键顺序；Object.fromEntries 重建对象后编码，避免插入顺序造成不同系列。
			const encoded = JSON.stringify(
				Object.fromEntries(
					Object.keys(copied)
						.sort()
						.map((key) => [key, copied[key]]),
				),
			);
			// series key 把名称、仪器种类、单位和属性快照组合成一个字符串，作为数据库主键的一部分。
			const key = JSON.stringify([name, kind, unit, encoded]);
			// 向下取整到窗口起点；同一窗口内的调用共享一条聚合记录，跨窗口产生新键。
			const interval = Math.floor(Date.now() / intervalMs) * intervalMs;
			const pendingKey = `${interval}:${key}`;
			const previous = this.measurements.get(pendingKey);
			// 只有新 series 才检查容量；已有 series 的更新不增加 Map 大小。inFlight 计入正在提交、尚未删除的指标。
			if (!previous && this.measurements.size + this.inFlightMeasurements >= this.capacity) {
				this.droppedMeasurements++;
				return;
			}
			this.measurements.set(pendingKey, {
				interval,
				key,
				name,
				kind,
				unit,
				attributes: encoded,
				// count/sum/min/max 是全部聚合状态；histogram 也只保存这四个值，不保存分桶或原始样本。
				count: (previous?.count ?? 0) + 1,
				sum: (previous?.sum ?? 0) + value,
				min: Math.min(previous?.min ?? value, value),
				max: Math.max(previous?.max ?? value, value),
			});
		};
	}

	/** Readers use committed rows only; flush first to include newly settled spans. */
	// 查询委托 store.ts；只读已提交行。需要包含刚结束的 span 时，先 await flush()。
	// 索引访问类型 TelemetryStore["getTrace"] 复用接口签名，避免重复声明参数/返回类型。
	readonly getTrace: TelemetryStore["getTrace"] = (traceId) => getTrace(this.db, traceId);
	readonly findTraces: TelemetryStore["findTraces"] = (query) => findTraces(this.db, query);
	readonly findMetrics: TelemetryStore["findMetrics"] = (query) => findMetrics(this.db, query);

	// 若正在 close，则返回同一个 closing Promise；否则发起一次非 partial drain。定时器也走这里。
	flush(): Promise<void> {
		return this.closing ?? this.drain(false);
	}

	// 幂等：第一次停止定时器并开始 drain(true)，后续调用复用同一个 Promise；数据库由调用方关闭。
	// partial=true 表示把当前尚未结束的 10 秒区间也写出，避免关闭时丢失最后一段指标。
	close(): Promise<void> {
		if (!this.closing) {
			this.stopped = true;
			clearInterval(this.timer);
			this.closing = this.drain(true);
		}
		return this.closing;
	}

	// 串行写入：先等已有 writing 完成，检查永久失败，再快照 span 与（视 partial 而定的）指标。
	// 写事务成功后只移除已快照的 span 前缀；写入期间新增的 span 留在队列，下一轮处理。
	// 失败会停止记录、清空所有缓冲并抛出原始错误；finally 清空 writing 状态。
	private async drain(partial: boolean): Promise<void> {
		// 用 while 而不是 if：等待期间理论上可能有新的 writing 被赋值；循环直到没有在途写入。
		while (this.writing) await this.writing;
		if (this.failed) throw this.failure;
		const spans = this.spans.slice();
		const metrics: Metric[] = [];
		// completed 是当前窗口起点；interval 小于它的指标属于已经结束的窗口，非 partial 时才会写出。
		const completed = Math.floor(Date.now() / intervalMs) * intervalMs;
		for (const [key, metric] of this.measurements) {
			if (!partial && metric.interval >= completed) continue;
			metrics.push(metric);
			this.measurements.delete(key);
		}
		// 在事务开始前把指标标记为在途，容量计算会同时考虑 Map 中剩余项和这一批。
		this.inFlightMeasurements = metrics.length;
		this.writing = Promise.resolve()
			.then(() =>
				this.db.transaction(async (tx) => {
					// 逐行 INSERT span；参数数组顺序与建表列一致，JSON 字段已经序列化。
					for (const span of spans)
						await tx.run("INSERT INTO telemetry_spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ...span);
					for (const metric of metrics)
						await tx.run(
							`INSERT INTO telemetry_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(interval_ms, series_key) DO UPDATE SET count = count + excluded.count,
				sum = sum + excluded.sum, min = min(min, excluded.min), max = max(max, excluded.max)`,
							metric.interval,
							metric.key,
							metric.name,
							metric.kind,
							metric.unit,
							metric.attributes,
							metric.count,
							metric.sum,
							metric.min,
							metric.max,
						);
					// 保留清理与写入同事务：查询看到的数据不会处于“新行已写、旧行未删”的中间状态。
					const cutoff = Date.now() - this.retention;
					await tx.run("DELETE FROM telemetry_spans WHERE ended_ms < ?", cutoff);
					await tx.run("DELETE FROM telemetry_metrics WHERE interval_ms < ?", cutoff);
				}),
			)
			.then(() => {
				// 只删除本次成功写入的前缀；splice 长度等于快照长度，不会误删并发追加的新行。
				this.spans.splice(0, spans.length);
			})
			.catch((error: unknown) => {
				this.failed = this.stopped = true;
				this.failure = error;
				// 失败后丢弃缓冲，避免内存持续增长；failed/stopped 使后续记录走 inert，错误由 flush/close 重现。
				this.spans.length = 0;
				this.measurements.clear();
				clearInterval(this.timer);
				throw error;
			})
			.finally(() => {
				// 无论成功失败都清除在途标记；inFlightMeasurements 归零，后续指标可以重新计算容量。
				this.writing = undefined;
				this.inFlightMeasurements = 0;
			});
		await this.writing;
	}
}

/** Portable, buffered SQLite recorder. Recording never performs SQL; flush runs every second.
 * Only settled spans are stored. Metrics aggregate count/sum/min/max per ten-second interval.
 * A write failure permanently stops recording and is reported by flush and close. */
/** 打开（或复用）一个 SQLite 数据库并创建记录器：先应用 v1 迁移，再返回未关闭的 SqliteTelemetry。
 * 输入 db 与可选 options；输出 Promise<SqliteTelemetry>；迁移失败会拒绝，数据库不由本函数关闭。
 * 副作用：建表/索引、启动每秒定时器；不会立即写入业务数据。
 * 例如 const telemetry = await createSqliteTelemetry(db); 之后把它放进请求上下文。 */
export async function createSqliteTelemetry(
	db: SqliteDatabase,
	options: SqliteTelemetryOptions = {},
): Promise<SqliteTelemetry> {
	// 默认保留 7 天（毫秒）；?? 只替换 undefined/null，0 会被保留为“立即过期”。
	const retention = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
	// 默认最多缓冲 10,000 条 span；同一数值也约束指标 series 数量。
	const capacity = options.maxQueuedSpans ?? 10_000;
	await applySqliteMigrations(
		db,
		[
			{
				version: 1,
				statements: [
					// 表结构：span 主键、trace/parent 关系、墙上时钟起止、三个 JSON 文本列（属性/事件/链接）和状态。
					// 索引覆盖保留清理、按 trace 取 span、按开始时间排序；不建外键，允许部分 span 先到或 parent 被保留清理。
					`CREATE TABLE telemetry_spans (id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_id TEXT, name TEXT, started_ms REAL,
			ended_ms REAL NOT NULL, attributes TEXT, events TEXT, links TEXT, status TEXT)`,
					"CREATE INDEX telemetry_spans_ended_ms ON telemetry_spans(ended_ms)",
					"CREATE INDEX telemetry_spans_trace_started ON telemetry_spans(trace_id, started_ms)",
					"CREATE INDEX telemetry_spans_started_ms ON telemetry_spans(started_ms)",
					// 指标表以 (区间起点, series_key) 为主键；UPsert 时累加 count/sum 并合并 min/max，支持跨批次聚合。
					`CREATE TABLE telemetry_metrics (interval_ms INTEGER, series_key TEXT, name TEXT, kind TEXT,
			unit TEXT, attributes TEXT, count INTEGER, sum REAL, min REAL, max REAL, PRIMARY KEY(interval_ms, series_key))`,
				],
			},
		],
		{ table: "telemetry_schema" },
	);
	return new Recorder(db, retention, capacity);
}
