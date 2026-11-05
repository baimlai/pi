/**
 * 进程内遥测参考实现：显式父上下文启动callback span，记录属性/事件/link/状态和原始指标，并提供独立快照/分页查询。
 * 例root.startSpan({name:"load"},async span=>span.startSpan({name:"cache"},()=>42))创建根与孩子，callback返回的Promise结束才锁记录。
 * 记录只在本实例内存无限追加，无后台导出、持久化、默认脱敏或隐式current-span；快照会复制契约允许的数组/对象字段。
 * WeakMap私下关联真实句柄与字符串carrier，便于JSON跨进程继续追踪，但身份仅诊断，不验证权限或任意外部ID格式。
 */
// 导入公开契约仅作类型：运行时不依赖index的重导出，避免和其导出本类形成同样的运行循环。
import type {
	// 指标查询参数类型。
	MetricQuery,
	// 基础值/同类数组属性表。
	SpanAttributes,
	// 相关上下文链接输入。
	SpanLink,
	// span开始的名字/属性/初始links。
	SpanOptions,
	// ok/error标签联合。
	SpanStatus,
	// 存储查询的指标统计行。
	StoredMetric,
	// 带epoch/事件偏移的存储span快照。
	StoredSpan,
	// 按traceId聚合的本地存储快照。
	StoredTrace,
	// 可传输字符串字典，不是可执行context句柄。
	TelemetryCarrier,
	// 显式父上下文契约。
	TelemetryContext,
	// inject/extract同步传播能力。
	TelemetryPropagation,
	// 可记录属性/事件/状态的子上下文。
	TelemetrySpan,
	// 异步查询追踪与指标的读接口。
	TelemetryStore,
	// 追踪筛选/分页参数。
	TraceQuery,
} from "./index.ts";
// 指标工厂/句柄接口，也仅类型导入。
import type {
	// 直方图描述/单位/桶提示。
	HistogramOptions,
	// 共同元数据。
	InstrumentOptions,
	// 单调counter句柄。
	TelemetryCounter,
	// 直方图测量句柄。
	TelemetryHistogram,
	// 三种工厂能力。
	TelemetryMetrics,
	// 可增减counter句柄。
	TelemetryUpDownCounter,
} from "./metrics.ts";
// 已结束父级的后代立即执行callback但不记录span，仍保留本adapter指标/传播能力。
import { NOOP_TELEMETRY_CONTEXT } from "./noop.ts";

// Recorded事件是兼容测试/本地诊断快照，仅名字/属性；内部事件时间只在StoredSpan查询快照暴露。
export interface RecordedTelemetryEvent {
	// 事件名。
	readonly name: string;
	// 只读属性视图，运行快照会复制允许的数组，但类型readonly本身不冻值。
	readonly attributes: Readonly<SpanAttributes>;
}

// Recorded link保留目标carrier和属性，不保留真实context对象引用。
export interface RecordedTelemetryLink {
	// 目标字符串身份快照。
	readonly context: Readonly<TelemetryCarrier>;
	// 链接属性快照。
	readonly attributes: Readonly<SpanAttributes>;
}

// Recorded span是规范记录器快照，含打开/结束状态与完成顺序，不等同StoredSpan的时间查询结构。
export interface RecordedTelemetrySpan {
	// 本实例从1增长的数字id，跨实例不单凭它保证唯一。
	readonly id: number;
	/** Local parent ID, or null for roots and parents owned by another recorder. */
	// 本记录器父数字id，根/其他记录器父用null；外来同scope字符串转number的边界看extract。
	readonly parentId: number | null;
	// 自身carrier的只读视图。
	readonly context: Readonly<TelemetryCarrier>;
	// 父carrier或null，远端父可有carrier但无本地parentId。
	readonly parentContext: Readonly<TelemetryCarrier> | null;
	// 相关links按追加顺序。
	readonly links: readonly RecordedTelemetryLink[];
	// 操作名字。
	readonly name: string;
	// 累计属性快照。
	readonly attributes: Readonly<SpanAttributes>;
	// 有序事件快照，不含内部timeMs。
	readonly events: readonly RecordedTelemetryEvent[];
	// 当前或结束状态。
	readonly status: SpanStatus;
	// callback Promise是否已走finally结束，不说明所有未await后台业务都已停止。
	readonly settled: boolean;
	// 结束时才补的顺序号，按结束先后而非开始id排序。
	readonly endSequence?: number;
}

// Recorded测量是原始追加日志，一次add/record一条，不是已聚合counter或桶；内部intervalMs不从此接口暴露。
export interface RecordedTelemetryMeasurement {
	// 三种指标kind。
	readonly kind: "counter" | "upDownCounter" | "histogram";
	// 指标名。
	readonly name: string;
	// 可选工厂描述。
	readonly description?: string;
	// 可选单位。
	readonly unit?: string;
	// 仅histogram可记录的桶提示快照，不实际据此分桶。
	readonly boundaries?: readonly number[];
	// 这一次测量值，有限/非负等由调用方按契约保证。
	readonly value: number;
	// 复制后的测量属性。
	readonly attributes: Readonly<SpanAttributes>;
	// 可选已知span/提取父的carrier关联，无关联为null。
	readonly context: Readonly<TelemetryCarrier> | null;
}

// 内部可变事件额外保存时间偏移，外部读取会转换快照。
interface MutableRecordedTelemetryEvent {
	// 相对span创建单调clock的毫秒偏移。
	timeMs: number;
	// 事件名。
	name: string;
	// 内部属性已按允许数据复制。
	attributes: SpanAttributes;
}

// 内部正在记录的span状态，不直接向调用方暴露这个对象，字段可在settled前更新。
interface MutableRecordedTelemetrySpan {
	// Date.now的epoch开始值。
	startedMs: number;
	// performance.now的单调起点，用于耗时/事件偏移。
	clock: number;
	// 结束时才存在，单调差值加到epoch开始上。
	endedMs?: number;
	// 本地数字id。
	id: number;
	// 本地父id或null。
	parentId: number | null;
	// 自己的carrier字典。
	context: TelemetryCarrier;
	// 父carrier快照或null。
	parentContext: TelemetryCarrier | null;
	// 已知目标links列表。
	links: RecordedTelemetryLink[];
	// 操作名。
	name: string;
	// 累计可变属性，setAttributes合并。
	attributes: SpanAttributes;
	// 内部带时间事件列表。
	events: MutableRecordedTelemetryEvent[];
	// 当前状态标签/错误详情。
	status: SpanStatus;
	// 是否显式setStatus过，防自动异常状态覆盖用户决定。
	explicitStatus: boolean;
	// callback settle后标true，之后记录方法忽略。
	settled: boolean;
	// 结束顺序号。
	endSequence?: number;
}

// 启动子操作所需父信息，区分直接span与extract得到的父句柄。
interface InMemoryParent {
	// 父身份carrier，不是父操作完整数据。
	context: TelemetryCarrier;
	// 同记录器可用数字id，外部scope为null。
	localId: number | null;
	// 直接span启动孩子时才带内部span，供settled检查；extract父不带这个活动/结束状态引用。
	span?: MutableRecordedTelemetrySpan;
}

// carrierId把scope/span串成存储层id；例本实例UUID与数字1组合。外部不透明字符串不在此转义/认证，不把任意冒号拼串当安全证明。
function carrierId(carrier: Readonly<TelemetryCarrier>): string {
	// 索引读两个格式字段后插值，中间冒号只是此adapter编码约定，不检查是否为自有属性。
	return `${carrier["pi-memory-scope"]}:${carrier["pi-memory-span"]}`;
}

// Identity survives settlement without exposing backend IDs on the generic context contract.
// 模块WeakMap按真实context对象身份关联carrier，结束后身份仍可inject/link；弱键不单独延长context寿命，值是字符串字典而非context反引用。
const contextCarriers = new WeakMap<TelemetryContext, TelemetryCarrier>();

// 每个根adapter独立状态，记录无限追加且无后台exporter/保留窗口，不适合误当持久化业务状态。
interface InMemoryTelemetryState {
	// 本adapter指标能力。
	metrics: TelemetryMetrics;
	// 本adapter传播能力。
	propagation: TelemetryPropagation;
	// 随机记录器scope，跨进程的本地计数可因此区分。
	scope: string;
	// 所有已创建span内部对象，包含打开状态。
	spans: MutableRecordedTelemetrySpan[];
	// 带私有10秒桶开始的原始测量日志。
	measurements: { intervalMs: number; measurement: RecordedTelemetryMeasurement }[];
	// 下一个开始id。
	nextSpanId: number;
	// 下一个结束顺序号，和开始id不必同序。
	nextEndSequence: number;
}

// copyAttributes去undefined并复制允许的一维数组；例{tags:["a"],x:undefined}变独立tags数组且无x。不是任意JS深克隆，读取getter可有副作用/抛错，不做敏感过滤。
function copyAttributes(attributes?: SpanAttributes): SpanAttributes {
	// 键值对列表重建普通对象，调用者不能通过返回属性表直接改同一内部表。
	return Object.fromEntries(
		// 缺属性视空；Object.entries只取自有可枚举字符串键，不含symbol/继承项。
		Object.entries(attributes ?? {})
			// undefined字段忽略，所以setAttributes({count:undefined})不会删除旧count。
			.filter(([, value]) => value !== undefined)
			// 按AttributeValue联合分流，数组浅复制足以隔离契约内基础元素；标量原样，不额外走任意嵌套对象。
			.map(([name, value]) => [name, Array.isArray(value) ? [...value] : value]),
	);
}

// copyLink只接受WeakMap已识别的上下文句柄，复制carrier/属性，否则undefined；例NOOP/root未注册不能链接，已结束目标仍可。可认识同模块其他内存实例的span，不局限当前state。
function copyLink(link: SpanLink): RecordedTelemetryLink | undefined {
	// 按对象身份查表，不解析link.context上任意形状字段。
	const context = contextCarriers.get(link.context);
	// 有身份就建独立字典/属性，无身份忽略，不自动创建目标记录。
	return context ? { context: { ...context }, attributes: copyAttributes(link.attributes) } : undefined;
}

// copyStatus按标签复制状态及可选name/message，例error详情新对象，不保留原Error/stack/任意附加字段。只信任类型契约，没有schema验证。
function copyStatus(status: SpanStatus): SpanStatus {
	// ok创建简单新对象，不沿用调用方状态引用。
	if (status.status === "ok") return { status: "ok" };
	// error分支可缺错误详情。
	return status.error
		? // 有详情复制两个字符串字段。
			{ status: "error", error: { name: status.error.name, message: status.error.message } }
		: // 没详情保留纯error状态。
			{ status: "error" };
}

// createSpan复制开始数据/已知链接、分配id与两种时钟、生成继承trace身份，返回内部未结束记录。例根1产生trace scope:1，孩子沿父trace。尚未运行callback，属性读取等可抛错。
function createSpan(
	// 实例状态，id从这里取。
	state: InMemoryTelemetryState,
	// 可缺父表示根。
	parent: InMemoryParent | undefined,
	// 开始选项，按可信类型读。
	options: SpanOptions,
): MutableRecordedTelemetrySpan {
	// 取名字原字符串。
	const name = options.name;
	// 开始属性去undefined并复制数组。
	const attributes = copyAttributes(options.attributes);
	// 先建独立links列表。
	const links: RecordedTelemetryLink[] = [];
	// 无初始links按空列表。
	for (const link of options.links ?? []) {
		// 每link只复制可识别身份目标。
		const copy = copyLink(link);
		// 未知目标忽略，不占空条目。
		if (copy) links.push(copy);
	}
	// 后缀++取旧id再递增，本实例新操作按开始次序编号。
	const id = state.nextSpanId++;
	// 返回内部可变记录。
	return {
		// epoch开始时间供跨记录查询排序。
		startedMs: Date.now(),
		// 单调clock供耗时，不能将两种时钟直接混减。
		clock: performance.now(),
		// 存本地id。
		id,
		// 无父或外部localId为null时保存null；0等数值不因??被忽略。
		parentId: parent?.localId ?? null,
		// 建立自己的carrier三字段。
		context: {
			// scope为本实例UUID。
			"pi-memory-scope": state.scope,
			// span id转字符串便于JSON传输。
			"pi-memory-span": String(id),
			// 有父trace字符串就沿用，否则新根为scope:id；不要求最早父记录在本地存在。
			"pi-memory-trace": parent?.context["pi-memory-trace"] ?? `${state.scope}:${id}`,
		},
		// 有父就浅复制其字符串字典，根为null。
		parentContext: parent ? { ...parent.context } : null,
		// 已复制links列表。
		links,
		// 操作名。
		name,
		// 已复制开始属性。
		attributes,
		// 事件初始空。
		events: [],
		// 正常默认ok，业务返回{ok:false}不会自动被识别。
		status: { status: "ok" },
		// 尚无显式状态决策。
		explicitStatus: false,
		// 初始打开，结束由startInMemorySpan的finally负责。
		settled: false,
	};
}

// startInertSpan处理从已结束的直接span启动孩子：不再追加span，但仍执行业务callback并沿用本adapter能力。例迟到孩子返回7，getSpans数量不增；不取消业务/禁用metrics。
function startInertSpan<T>(
	// 沿用同一记录器能力状态，不复制所有记录。
	state: InMemoryTelemetryState,
	// 选项交NOOP，它不读/留数据。
	options: SpanOptions,
	// 业务callback仍可同步返回T或Promise<T>。
	callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	// 借NOOP维持同步进入/Promise结果与异常语义，不自己记录开始结束时间。
	return NOOP_TELEMETRY_CONTEXT.startSpan(options, (noop) =>
		// 给业务一份新的空记录上下文对象，不直接返回共享noop原对象；callback仍立即执行。
		callback({
			// 展开noop记录方法，它们都空操作。
			...noop,
			// 但指标仍是真正本state指标能力，callback中指标可以继续记录。
			metrics: state.metrics,
			// 传播能力同样沿用。
			propagation: state.propagation,
			// 迟到孩子再生孩子也继续立即执行callback而不记录span，泛型Result关联该层返回值。
			startSpan: <Result>(
				// 后代开始选项。
				childOptions: SpanOptions,
				// 后代callback。
				childCallback: (span: TelemetrySpan) => Result | Promise<Result>,
				// 继续startInertSpan，不重新回正常记录路径。
			) => startInertSpan(state, childOptions, childCallback),
		}),
	);
}

// startInMemorySpan创建记录与回调句柄→执行/await业务→按需自动error→finally结束；例同步throw原值拒绝、状态error。只等callback返回的Promise，不等待所有fire-and-forget后代。
async function startInMemorySpan<T>(
	// 实例状态。
	state: InMemoryTelemetryState,
	// 父信息或undefined根。
	parent: InMemoryParent | undefined,
	// 新操作选项。
	options: SpanOptions,
	// 业务callback结果T或Promise<T>。
	callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	// 只有带内部span且已settled的直接父走不记录路径；extract父没有span引用，即使其原span已结束仍可创建新记录孩子。
	if (parent?.span?.settled) return startInertSpan(state, options, callback);

	// 先复制开始数据/分配id，若此处失败，尚未进入下面包callback的try/finally。
	const recordedSpan = createSpan(state, parent, options);
	// 创建后立即入开始序列表，callback内部getSpans可看到未结束记录。
	state.spans.push(recordedSpan);

	// 给callback可操作的公开句柄对象，内部recordedSpan不直接暴露。
	const span: TelemetrySpan = {
		// 子span共享指标能力对象。
		metrics: state.metrics,
		// 共享传播能力对象。
		propagation: state.propagation,
		// 直接子操作startSpan闭包捕获当前记录。
		startSpan: <Result>(
			// 孩子开始选项。
			childOptions: SpanOptions,
			// 孩子callback可能返回新Result。
			childCallback: (child: TelemetrySpan) => Result | Promise<Result>,
		) =>
			// 递归正常记录函数，其开头检查父settled，决定记录span还是只执行callback。
			startInMemorySpan(
				// 仍是本state。
				state,
				// 携带父carrier、本地id及真实内部span状态引用。
				{ context: recordedSpan.context, localId: recordedSpan.id, span: recordedSpan },
				// 孩子选项透传。
				childOptions,
				// 孩子callback透传。
				childCallback,
			),
		// addLink在打开时追加已知目标身份，不改父；例激活与请求另建相关边。
		addLink(link) {
			// 源已结束就忽略，不拷贝或查目标。
			if (recordedSpan.settled) return;
			// 复制目标carrier/属性。
			const copy = copyLink(link);
			// 只有已知目标才入列表，按调用顺序保留。
			if (copy) recordedSpan.links.push(copy);
		},
		// addEvent在打开时记一条相对时间事件，例cache.hit；同步更新内存，不创建子span。
		addEvent(name, attributes) {
			// 结束后直接返回。
			if (recordedSpan.settled) return;
			// 追加内部可变事件数据。
			recordedSpan.events.push({
				// 事件名原样。
				name,
				// 用单调当前时间减起点，而非Date.now减epoch，抵御wall-clock跳变影响耗时。
				timeMs: performance.now() - recordedSpan.clock,
				// 复制属性，避免调用者后改数组影响记录。
				attributes: copyAttributes(attributes),
			});
		},
		// setAttributes合并定义值，例count旧1后设undefined仍保1；写的是同span累计属性，并不结束它。
		setAttributes(attributes) {
			// 结束后不更新。
			if (recordedSpan.settled) return;
			// 旧属性先、新定义属性后展开，新值覆盖；copyAttributes丢undefined，所以不会借undefined删旧键。
			recordedSpan.attributes = { ...recordedSpan.attributes, ...copyAttributes(attributes) };
		},
		// setStatus显式设置并标记已决定，例先setStatus(ok)再throw不会被自动error覆盖；真实callback仍拒绝，不吞失败。
		setStatus(status) {
			// 结束后忽略。
			if (recordedSpan.settled) return;
			// 复制状态/错误详情，不保留外部可变状态对象。
			recordedSpan.status = copyStatus(status);
			// 无论显式ok/error都标true，后面catch尊重最后显式决策。
			recordedSpan.explicitStatus = true;
		},
	};

	// 业务callback调用前注册句柄身份，callback内inject(span)/link/span关联指标可立即识别。
	contextCarriers.set(span, recordedSpan.context);

	// try从业务callback开始，不覆盖之前createSpan/句柄创建/WeakMap登记阶段。
	try {
		// callback在同步栈直接进入，await只等待其结果；必须await后finally才在Promise完成时结束，不能提前return Promise就先关闭。
		return await callback(span);
		// 捕获同步throw/异步reject任意值。
	} catch (error) {
		// 只有没有显式setStatus时才自动设error。
		if (!recordedSpan.explicitStatus)
			// 状态对象按异常是否本realm Error选择详情。
			recordedSpan.status =
				// Error类型可取name/message，不把任意throw当Error假定。
				error instanceof Error
					? // 只复制name/message，不保stack或做脱敏。
						{ status: "error", error: { name: error.name, message: error.message } }
					: // 其他拒绝值也标error，但不String化附详情。
						{ status: "error" };
		// 原样重抛同一值，业务能保持身份判断，哪怕拒绝undefined也不替换成新Error。
		throw error;
		// 成功/失败都会结束；finally不表示清空所有测量/取消业务后代。
	} finally {
		// 先锁settled，之后迟到记录方法忽略。
		recordedSpan.settled = true;
		// epoch起点+单调耗时构造结束epoch边界，通常不受中途Date.now跳变；时钟函数自身异常不在此再保护。
		recordedSpan.endedMs = recordedSpan.startedMs + performance.now() - recordedSpan.clock;
		// 取全实例下一个结束序号，再加1；并发孩子先结束可序号更小。
		recordedSpan.endSequence = state.nextEndSequence++;
	}
}

// createMeasurementRecorder在创建句柄时复制元数据，返回每次记录追加的函数；例histogram带边界[1,10]，后改原数组不影响。只记原始测量，不实际桶聚合/上传/约束数值。
function createMeasurementRecorder(
	// 共享实例state，日志无容量上限。
	state: InMemoryTelemetryState,
	// kind来自三种指标标签联合。
	kind: RecordedTelemetryMeasurement["kind"],
	// 指标名。
	name: string,
	// 共同元数据也可用HistogramOptions形状接，kind决定是否采用boundaries。
	options?: HistogramOptions,
	// 返回同步记录函数，可选属性/上下文；counter公开接口只暴露前两参数。
): (value: number, attributes?: SpanAttributes, context?: TelemetryContext) => void {
	// 复制描述字符串值，不保存options对象。
	const description = options?.description;
	// 复制单位字符串值。
	const unit = options?.unit;
	// 仅histogram且有boundaries才复制数组；只读是类型约束，不验证有限/排序或建立桶计数。
	const boundaries = kind === "histogram" && options?.boundaries !== undefined ? [...options.boundaries] : undefined;
	// 预建一次共同metadata，每条测量后面展开它。
	const metadata = {
		// 标签。
		kind,
		// 名字。
		name,
		// 描述缺失就省字段，不填undefined。
		...(description === undefined ? {} : { description }),
		// 单位缺失同理。
		...(unit === undefined ? {} : { unit }),
		// 边界缺失同理；同句柄内部测量共用这份不可由普通API直接取得的边界数组，getMetrics再复制。
		...(boundaries === undefined ? {} : { boundaries }),
	};
	// 每次add/record执行闭包，真正追加发生在这里，不是工厂创建时。
	return (value, attributes, context) => {
		// 有context才查WeakMap，未知上下文不关联；可认识本模块任何已注册内存span/提取父，不要求当前state同scope。
		const carrier = context === undefined ? undefined : contextCarriers.get(context);
		// 追加一条私有桶时间+公开测量结构。
		state.measurements.push({
			// Date.now按10000毫秒向下取整为10秒区间开始，不等同每隔10秒自动flush/重置。
			intervalMs: Math.floor(Date.now() / 10_000) * 10_000,
			// 原始测量数据。
			measurement: {
				// 共同元数据浅展开。
				...metadata,
				// 这次value原值，不取绝对值/强转/检查finite。
				value,
				// 属性去undefined且数组复制。
				attributes: copyAttributes(attributes),
				// 已知carrier复制为关联快照，否则null；不在此保留真实context对象。
				context: carrier ? { ...carrier } : null,
			},
		});
	};
}

/**
 * Backend-neutral reference implementation that records spans in process memory.
 * Create a fresh instance to isolate tests or independent recording scopes.
 */
// InMemoryTelemetryContext是进程内参考adapter，兼有span/传播/指标/查询。例new后startSpan与counter记录到自己的state；每实例独立UUID/数组，模块身份表弱共享，无导出后端或自动持久化。
export class InMemoryTelemetryContext
	// implements仅TS检查类具备四接口，不在运行时注入实现/校验调用者输入。
	implements TelemetryContext, TelemetryPropagation, TelemetryMetrics, TelemetryStore
{
	// metrics能力直接为this，子span/提取父也复用同一能力身份。
	readonly metrics: TelemetryMetrics = this;
	// propagation同样this。
	readonly propagation: TelemetryPropagation = this;
	// 显式字段初始化每实例新状态；readonly只禁字段替换，内部数组/计数仍可变。
	private readonly state: InMemoryTelemetryState = {
		// 内部同一指标能力。
		metrics: this,
		// 内部同一传播能力。
		propagation: this,
		// 随机scope区分记录器实例，非加密认证token/权限。
		scope: crypto.randomUUID(),
		// 开始序记录列表，根和孩子一起追加。
		spans: [],
		// 原始测量日志。
		measurements: [],
		// 首span本地id为1。
		nextSpanId: 1,
		// 首结束顺序号为1。
		nextEndSequence: 1,
	};

	// 根adapter.startSpan总从无父启动，例即使在另一callback里调root.startSpan也仍是新根，只有调callback span的startSpan才沿它父级。
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		// undefined明确无父，不用隐式AsyncLocalStorage寻找当前操作。
		return startInMemorySpan(this.state, undefined, options, callback);
	}

	/** Returns a detached carrier for a known span or extracted parent, including settled spans. */
	// inject按实际context身份返回独立carrier，例span结束后仍可导出；根/NOOP/未知句柄无注册则undefined，不生成新身份，也不限定只能本实例span。
	inject(context: TelemetryContext): TelemetryCarrier | undefined {
		// 查询模块弱表，不读取context上的伪造backend id字段。
		const carrier = contextCarriers.get(context);
		// 复制字符串字典给外部修改，原内部carrier不暴露。
		return carrier ? { ...carrier } : undefined;
	}

	/** Missing or non-string carrier identities fall back to this recorder's root context. */
	// extract处理carrier传输边界：只验三键字符串→复制→定本地父id→返回可启动孩子的父上下文。例外部scope身份沿trace但本地parentId=null；不验证格式/签名或查真实父存在。
	extract(carrier: TelemetryCarrier | undefined): TelemetryContext {
		// 可选链让缺carrier得到undefined。
		const scope = carrier?.["pi-memory-scope"];
		// 读span身份字符串。
		const span = carrier?.["pi-memory-span"];
		// 读trace身份字符串。
		const traceId = carrier?.["pi-memory-trace"];
		// 这是wire carrier识别边界，缺/非字符串回本adapter根；不拒空串/错误数字等仍是字符串的身份。
		if (typeof scope !== "string" || typeof span !== "string" || typeof traceId !== "string") return this;
		// 仅保留三个识别字段，拷贝后不因调用者修改原carrier而变。
		const context = { "pi-memory-scope": scope, "pi-memory-span": span, "pi-memory-trace": traceId };
		// 同scope直接Number(span)，可NaN/小数等，未查id有效性/存在性；别scope用null，身份只作诊断不授权。
		const localId = scope === this.state.scope ? Number(span) : null;
		// 创建接收方拥有的父上下文，不是创建一个已记录span。
		const parent: TelemetryContext = {
			// 沿本adapter指标能力。
			metrics: this,
			// 沿本adapter传播能力。
			propagation: this,
			// 这个父的startSpan绑定carrier/localId，不带原活动span状态。
			startSpan: <T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>) =>
				// 即使身份指向已结束本地span也可再记录孩子；直接用已结束span启动后代则只执行callback而不记录。
				startInMemorySpan(this.state, { context, localId }, options, callback),
		};
		// 注册提取父本身，之后可inject/用作link或exemplar。
		contextCarriers.set(parent, context);
		// 返回父句柄，不立即追加span。
		return parent;
	}

	// counter工厂每次返回新句柄，add追加原始增量；例counter("calls").add(2)一条value2，不自动返回累计2。有限非负约定由调用方遵守。
	counter(name: string, options?: InstrumentOptions): TelemetryCounter {
		// 绑定state/kind/name/options，创建时复制元数据，后面调用add才写记录。
		return { add: createMeasurementRecorder(this.state, "counter", name, options) };
	}

	// upDownCounter允许正负增量，例连接开1关-1；不在此求当前连接总数，也不缓存同名句柄。
	upDownCounter(name: string, options?: InstrumentOptions): TelemetryUpDownCounter {
		// 构建相同记录闭包但kind为upDownCounter。
		return { add: createMeasurementRecorder(this.state, "upDownCounter", name, options) };
	}

	// histogram记录独立值和可选span关联，例record(12,attrs,span)；桶仅提示，不在本adapter分布统计或限制值非负。
	histogram(name: string, options?: HistogramOptions): TelemetryHistogram {
		// 返回record句柄，边界复制发生在创建闭包时。
		return { record: createMeasurementRecorder(this.state, "histogram", name, options) };
	}

	// storedSpans筛settled、生成独立带时间快照、按开始时间/id升序。例运行中父未结束而孩子结束，查询可先仅见孩子；不是强制等整trace全部完成。
	private storedSpans(): StoredSpan[] {
		// 从全部内部span列表读取，不修改原顺序。
		return (
			this.state.spans
				// 只保留已结束记录，打开span不会进入store查询。
				.filter((span) => span.settled)
				// 逐个映成StoredSpan新对象。
				.map((span) => ({
					// 存储id为scope:span。
					id: carrierId(span.context),
					// trace键按创建/提取规则保证存在，!是TS断言不加运行兜底。
					traceId: span.context["pi-memory-trace"]!,
					// 有父carrier就输出parentId完整串，不输出本地数字parentId；根省略字段。
					...(span.parentContext ? { parentId: carrierId(span.parentContext) } : {}),
					// 名字。
					name: span.name,
					// epoch起点。
					startedMs: span.startedMs,
					// settled前提下endedMs已补，!仅静态断言。
					endedMs: span.endedMs!,
					// 重新复制属性/数组，让外部改快照不改内部记录。
					attributes: copyAttributes(span.attributes),
					// 事件也新建数组/条目。
					events: span.events.map((event) => ({
						// 事件名。
						name: event.name,
						// 此接口保留内部相对毫秒偏移。
						timeMs: event.timeMs,
						// 复制事件属性。
						attributes: copyAttributes(event.attributes),
					})),
					// links映为存储查询需要的目标trace/span字符串。
					links: span.links.map((link) => ({
						// 目标trace id。
						traceId: link.context["pi-memory-trace"]!,
						// 目标完整span id。
						spanId: carrierId(link.context),
						// 链接属性再次复制。
						attributes: copyAttributes(link.attributes),
					})),
					// 结束状态/错误详情再次复制。
					status: copyStatus(span.status),
				}))
				// 开始epoch升序，同时间用完整id字符串字典序，不是本地数字id大小比较（例如:10可排:2之前）。
				.sort((a, b) => a.startedMs - b.startedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		);
	}

	// getTrace从本实例已结束记录取指定traceId，返回带时间新快照或undefined；例远端trace可只含接收方局部span，无查其他进程/网络。
	async getTrace(traceId: string): Promise<StoredTrace | undefined> {
		// 先生成全部settled快照再按traceId过滤，每次调用会遍历/复制，不是O(1)查询缓存。
		const spans = this.storedSpans().filter((span) => span.traceId === traceId);
		// 有至少一span就返回，空追踪undefined。
		return spans.length ? { traceId, spans } : undefined;
	}

	// findTraces按首个已存span的名字/开始时间、任意同一span的全部属性条件和任意span错误筛选，再分页：全量settled快照→分trace→过滤→新到旧排序→切页。不是跨请求一致快照，坏cursor可抛错。
	async findTraces(query: TraceQuery = {}): Promise<{ traces: readonly StoredTrace[]; cursor?: string }> {
		// 缺limit默认20，??保留0/负数等违反契约的值；本函数不额外验证正整数。
		const limit = query.limit ?? 20;
		// cursor是内部JSON二元组文本，as只断言形状，不验证解析值；JSON语法错误会拒绝该async方法，非自描述安全token。
		const after = query.cursor === undefined ? undefined : (JSON.parse(query.cursor) as [number, string]);
		// 本次新分组表，不跨查询保留快照。
		const grouped = new Map<string, { traceId: string; spans: StoredSpan[] }>();
		// storedSpans已按开始/id升序，组内push顺序保留此排序。
		for (const span of this.storedSpans()) {
			// 按traceId查组。
			let trace = grouped.get(span.traceId);
			// 首次见trace新建组。
			if (!trace) {
				// 组含traceId与空span数组。
				trace = { traceId: span.traceId, spans: [] };
				// 登记到Map。
				grouped.set(span.traceId, trace);
			}
			// 按升序追加，该trace第0项即最早已结束/已存span，不一定真实根。
			trace.spans.push(span);
		}
		// 取所有组新数组，开始过滤/排序。
		const matches = [...grouped.values()]
			// 过滤条件作用在完整trace分组。
			.filter((trace) => {
				// 每组由至少一个span建立，!基于此约定，不验证非空。
				const first = trace.spans[0]!;
				// 以下&&条件全满足才保留，顺序短路。
				return (
					// name只看组第一个span，不搜索任意孩子名字。
					(query.name === undefined || first.name === query.name) &&
					// 开始时间含下界。
					(query.startMin === undefined || first.startedMs >= query.startMin) &&
					// 开始时间含上界。
					(query.startMax === undefined || first.startedMs <= query.startMax) &&
					// 续页排除之前结果：时间更旧，或相同时间而traceId字典序更后；after按内部可信cursor约定使用。
					(!after || first.startedMs < after[0] || (first.startedMs === after[0] && trace.traceId > after[1])) &&
					// errors为true时至少一个span error，否则不加此筛选。
					(!query.errors || trace.spans.some((span) => span.status.status === "error")) &&
					// 无属性筛选直接通过该条件。
					(!query.attributes ||
						// 有属性时找某一个span能满足全部键，而非各span分别凑条件。
						trace.spans.some((span) =>
							// every严格===匹配所有标量，!基于外层query.attributes存在；空筛选表自然全满足。
							Object.entries(query.attributes!).every(([key, value]) => span.attributes[key] === value),
						))
				);
			})
			// 通过者排序成最终页序。
			.sort(
				// 比较两条追踪。
				(a, b) =>
					// 最早已存span开始时间降序，新先旧后。
					b.spans[0]!.startedMs - a.spans[0]!.startedMs ||
					// 同时间按traceId字符串升序，和cursor下一页条件配套。
					(a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0),
			);
		// 只取前limit，是否正数/整数由调用方契约保证；违反时沿JS slice语义，后面cursor访问也可能出错。
		const traces = matches.slice(0, limit);
		// 末项可undefined，!不加检查；正常有后续页且正limit时才会在下面真正读其字段。
		const last = traces.at(-1)!;
		// 返回新页结构。
		return {
			// 页内仍是完整本地settled span列表，不按span行数拆trace。
			traces,
			// 结果多于limit才带cursor，编码最后一条追踪首span时间/traceId；否则省字段，无实时快照锁。
			...(matches.length > limit ? { cursor: JSON.stringify([last.spans[0]!.startedMs, last.traceId]) } : {}),
		};
	}

	/** Read raw measurements as count-one rows, without changing getMetrics() snapshots. */
	// findMetrics筛名字/桶时间/属性，再把每条原始测量映count1统计行。例同桶hits记录2和3会返回两行，而非直接sum5；不改变getMetrics快照格式。
	async findMetrics(query: MetricQuery): Promise<readonly StoredMetric[]> {
		// 只读本实例追加日志，不查外部存储。
		return (
			this.state.measurements
				// 筛原始测量。
				.filter(
					// 解构私有桶开始与公开测量。
					({ intervalMs, measurement }) =>
						// 名字必须严格相同。
						measurement.name === query.name &&
						// 桶开始时间含下界。
						(query.startMin === undefined || intervalMs >= query.startMin) &&
						// 含上界。
						(query.startMax === undefined || intervalMs <= query.startMax) &&
						// 所有标量属性===，缺筛选按空表全通过，数组不在query属性类型中。
						Object.entries(query.attributes ?? {}).every(([key, value]) => measurement.attributes[key] === value),
				)
				// 逐条建立新的StoredMetric，不执行groupBy聚合。
				.map(({ intervalMs, measurement }) => ({
					// 桶开始epoch毫秒。
					intervalMs,
					// 指标名。
					name: measurement.name,
					// 指标kind。
					kind: measurement.kind,
					// 单位有提供才输出。
					...(measurement.unit === undefined ? {} : { unit: measurement.unit }),
					// 复制属性/一维数组，外部修改不改内部日志。
					attributes: copyAttributes(measurement.attributes),
					// 每次原始测量count固定1。
					count: 1,
					// sum是这一条value。
					sum: measurement.value,
					// min也是这一条value。
					min: measurement.value,
					// max同value，后端/调用者可再聚合多行。
					max: measurement.value,
				}))
		);
	}

	/** Returns detached measurements in recording order, without aggregation. */
	// getMetrics返回按记录顺序的独立原始测量快照，不带内部intervalMs；例更改返回boundaries/tags不改下一次结果，不会清空日志或自动聚合。
	getMetrics(): readonly RecordedTelemetryMeasurement[] {
		// 只取measurement内层，外层私有时间不展开。
		return this.state.measurements.map(({ measurement }) => ({
			// 共同字段先浅展开，随后覆盖需要再次复制的引用字段。
			...measurement,
			// 边界有就再复制数组，无就省新增字段；原measurement无边界字段时保持无。
			...(measurement.boundaries === undefined ? {} : { boundaries: [...measurement.boundaries] }),
			// 属性及允许的数组再复制。
			attributes: copyAttributes(measurement.attributes),
			// 已有关联carrier再复制，无关联null，不暴露真实context句柄。
			context: measurement.context ? { ...measurement.context } : null,
		}));
	}

	/** Returns detached snapshots in span-start order. */
	// getSpans返回全部内部记录的规范快照，包含打开的span，按开始追加顺序而非结束序；例callback内settled=false，结束后补endSequence，没有epoch/事件偏移字段。
	getSpans(): readonly RecordedTelemetrySpan[] {
		// 每条span映成独立对象，不返回内部Mutable记录。
		return this.state.spans.map((span) => ({
			// 本地数字id。
			id: span.id,
			// 本地父数字id或null，不同于storedSpans完整字符串父id。
			parentId: span.parentId,
			// 自身carrier字典复制。
			context: { ...span.context },
			// 父carrier有则复制、根null。
			parentContext: span.parentContext ? { ...span.parentContext } : null,
			// 链接列表也复制。
			links: span.links.map((link) => ({
				// 每个目标carrier复制。
				context: { ...link.context },
				// 链接属性复制。
				attributes: copyAttributes(link.attributes),
			})),
			// 名字原字符串。
			name: span.name,
			// 累计属性复制。
			attributes: copyAttributes(span.attributes),
			// 规范事件列表复制，不读出内部timeMs。
			events: span.events.map((event) => ({
				// 事件名。
				name: event.name,
				// 事件属性复制。
				attributes: copyAttributes(event.attributes),
			})),
			// 状态及可选错误详情复制。
			status: copyStatus(span.status),
			// 当前是否已结束。
			settled: span.settled,
			// 只有结束序号存在才带字段，打开span不写endSequence:undefined。
			...(span.endSequence === undefined ? {} : { endSequence: span.endSequence }),
		}));
	}
}
