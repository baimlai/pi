/**
 * 遥测公共入口：操作span、属性/事件/状态、显式父上下文、跨进程carrier、查询快照及领域schema的TS推导。
 * 例adapter.startSpan({name:"read"},span=>span.addEvent("cache"))计一段操作；typed starter进一步在编译期限制名字/属性。
 * 接口/条件/映射类型只在开发期检查，defineTelemetrySchema原样返回数据，typed starter也不在运行时验证schema/父政策/敏感标志。
 * 记录实现由NOOP或内存/应用adapter承担，不建立全局current-span；schema描述、实际记录快照和业务持久状态需分清。
 */
// type导入仅给指标能力/定义约束，运行JS不因这条加载metrics模块；后面有显式运行重导出。
import type { TelemetryMetricDefinition, TelemetryMetrics } from "./metrics.ts";

// 属性值限定基础字符串/数字/布尔或同类只读数组，例{tags:["a"]}；不包含任意嵌套对象，readonly不冻结数组，number不保证有限。
export type AttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

// 底层开放属性字典，例{provider:"demo",tokens:12}；字段值可undefined，adapter决定忽略/记录政策。
export interface SpanAttributes {
	// 索引签名允许任意字符串键，非领域schema的名字白名单，不会自动过滤敏感内容。
	[name: string]: AttributeValue | undefined;
}

/** Opaque, JSON-serializable adapter-owned propagation data. */
// Carrier是可JSON传输的字符串键值表，表示adapter自有的追踪身份，不把函数/span句柄跨进程传输，也不作授权凭证。
export type TelemetryCarrier = Record<string, string>;

/** Optional transport capability implemented by the application's telemetry adapter. */
// 可选传播能力；例inject(span)得到carrier，接收方extract(carrier)创建父上下文，方法同步，具体编码/识别由adapter负责。
export interface TelemetryPropagation {
	// 已有上下文可导出carrier，也可undefined表示根/不支持；接口不保证每个TelemetryContext都可注入。
	inject(context: TelemetryContext): TelemetryCarrier | undefined;
	/** Absent or unknown carriers use the root; recognized identifiers are opaque strings. */
	// 缺失/未知carrier按契约回接收adapter根，识别身份为不透明字符串；跨传输的大小/信任边界由调用方处理。
	extract(carrier: TelemetryCarrier | undefined): TelemetryContext;
}

// link描述相关工作而不更改父子树；例后台激活由getter触发但独立做根，可link到getter。
export interface SpanLink {
	// 目标为上下文句柄，可为span或已提取远端父，不是直接填任意字符串id。
	context: TelemetryContext;
	// 可选链接属性，复制/忽略策略由adapter执行。
	attributes?: SpanAttributes;
}

// 开始一次计时操作的低层参数，例{name:"load",attributes:{cached:false}}，不是业务输入schema。
export interface SpanOptions {
	// 操作可读名字。
	name: string;
	// 开始时已有事实，仍是开放属性表。
	attributes?: SpanAttributes;
	// 初始相关链接的只读列表，readonly仅编译期，不自动复制/冻结。
	links?: readonly SpanLink[];
}

// status标签联合让if(status.status==="error")后可读可选error；正常ok不带error字段，异常详情也不是完整Error实例/stack。
export type SpanStatus = { status: "ok" } | { status: "error"; error?: { name: string; message: string } };

/** A settled span snapshot, independent of the recording adapter. Event times are relative to span start. */
// StoredSpan是供查询/渲染的已结束span快照，带时间/id；与下面内存测试用Recorded快照不同。readonly不意味着内部attributes深冻结。
export interface StoredSpan {
	// 存储层全局span id，跨adapter合并时用它去重。
	readonly id: string;
	// 整个追踪id，远端父子可沿用同一traceId。
	readonly traceId: string;
	// 可选父span id，父快照可能未存/过期/在其他存储，不保证本地一定找到。
	readonly parentId?: string;
	// 操作名。
	readonly name: string;
	// epoch毫秒开始时间，不是耗时偏移。
	readonly startedMs: number;
	// epoch毫秒结束边界，内存实现用单调耗时推结束时间，其他adapter按契约提供。
	readonly endedMs: number;
	// 累计属性快照，readonly约束字段重赋但SpanAttributes自身仍可写。
	readonly attributes: SpanAttributes;
	// 事件列表按记录顺序，timeMs为相对span开始的毫秒偏移，不是绝对时间；内部attributes不因外层readonly自动只读。
	readonly events: readonly { readonly name: string; readonly timeMs: number; readonly attributes: SpanAttributes }[];
	// links是目标身份快照，不是可执行上下文对象。
	readonly links: readonly {
		// 目标trace id。
		readonly traceId: string;
		// 目标span id。
		readonly spanId: string;
		// 可选链接属性。
		readonly attributes?: SpanAttributes;
	}[];
	// 结束状态，ok/error按标签读取。
	readonly status: SpanStatus;
}

// StoredTrace聚合本地可取得的同trace spans，不承诺含全部远端/尚未结束父子。
export interface StoredTrace {
	// 追踪id。
	readonly traceId: string;
	// 只读span列表视图，不自动阻止快照字段被JS调用者改写。
	readonly spans: readonly StoredSpan[];
}

// TraceQuery按追踪首个已存span/任意匹配span过滤并分页，例{errors:true,limit:10}；类型不自动校验页大小或cursor格式。
export interface TraceQuery {
	/** Name of the earliest stored span, with span ID breaking timestamp ties. */
	// 名字过滤针对最早已存span，时间相同按span id决定首个，不等同任意孩子名字。
	readonly name?: string;
	/** All equalities must match one span; that span may be anywhere in the trace. */
	// 所有指定标量相等条件要同时落在同一个span，该span可在追踪任意位置；不跨两孩子拼凑条件。
	readonly attributes?: Readonly<Record<string, string | number | boolean>>;
	// 可选字面量true，仅要求存在error；不是boolean开关false必须表达成省略字段。
	readonly errors?: true;
	/** Inclusive bounds on the earliest stored span's start time. */
	// 最早已存span开始时间含端点下界。
	readonly startMin?: number;
	// 含端点上界。
	readonly startMax?: number;
	/** Positive page size; defaults to 20. */
	// 正页大小契约，默认20；number本身不证明正整数，adapter对违反约定输入行为未定义。
	readonly limit?: number;
	/** Opaque continuation from the previous page; retain the same filters. */
	// 前页返回的不透明续页标记，继续时保留相同过滤；不保证跨页快照隔离。
	readonly cursor?: string;
}

// 指标查询按名字、时间区间和标量属性匹配；例{name:"hits",startMin:20000}，具体聚合由存储后端负责。
export interface MetricQuery {
	// 必需指标名，非span名。
	readonly name: string;
	/** Inclusive bounds on interval start time. */
	// 区间开始时间含端点下界，不是原始测量任意时刻。
	readonly startMin?: number;
	// 含端点上界。
	readonly startMax?: number;
	// 一行属性上的所有标量精确相等条件，不把布尔true与数字1混同。
	readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

// StoredMetric是存储查询的统计行，内存adapter每条测量映count=1，SQLite等可按series/interval聚合；不假定一定已全局累计。
export interface StoredMetric {
	// 时间桶开始epoch毫秒；内存实现为10秒桶。
	readonly intervalMs: number;
	// 指标名字。
	readonly name: string;
	// 带标签三种指标，和工厂kind对应。
	readonly kind: "counter" | "upDownCounter" | "histogram";
	// 可选单位标签，不进行自动换算。
	readonly unit?: string;
	// 此行属性快照。
	readonly attributes: SpanAttributes;
	// 该行包含的测量数量。
	readonly count: number;
	// 测量值之和，不总是counter最终当前值。
	readonly sum: number;
	// 最小测量值。
	readonly min: number;
	// 最大测量值。
	readonly max: number;
}

/** Read settled traces without depending on a storage backend. */
// 存储读接口与记录接口分开，方法异步；例findTraces后renderTrace，不依赖具体SQLite/内存API。只返回已结束span，可有不完整本地追踪。
export interface TelemetryStore {
	// 分页返回追踪列表及可选cursor；query可省，Promise不代表此接口自动flush后台记录。
	findTraces(query?: TraceQuery): Promise<{ traces: readonly StoredTrace[]; cursor?: string }>;
	// 按traceId取本地快照，缺失undefined。
	getTrace(traceId: string): Promise<StoredTrace | undefined>;
	// 返回指标行，调用者可再聚合；没有在此返回图表或写入接口。
	findMetrics(query: MetricQuery): Promise<readonly StoredMetric[]>;
}

/** Adapter contract for trusted typed inputs; malformed input behavior is unspecified. */
// TelemetryContext显式决定下一span的父级，startSpan包业务回调；例root.startSpan(...,span=>span.startSpan(...))形成父子，没有全局current-span隐式选择。
export interface TelemetryContext {
	/** Adapter capabilities remain available on child spans and extracted parents. */
	// 可选metrics能力，在孩子/提取父上按契约沿用；缺失时业务可不记录指标。
	readonly metrics?: TelemetryMetrics;
	// 可选传播能力，同样按adapter身份沿用。
	readonly propagation?: TelemetryPropagation;
	// 泛型T关联回调结果与Promise结果；adapter契约要求同步进入回调一次、保留返回/拒绝、返回Promise直至callback完成，不因接口声明就自动实现这些规则。
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}

// span既可写记录也可作为子操作上下文；正常生命周期由startSpan回调结束控制，无公开end方法。
export interface TelemetrySpan extends TelemetryContext {
	// 追加相关链接，不更改父节点；已结束后的记录按契约无效，具体实现负责。
	addLink(link: SpanLink): void;
	// 按顺序追加瞬时事件，事件没有独立持续时长。
	addEvent(name: string, attributes?: SpanAttributes): void;
	// 合并新属性，后定义值覆盖，undefined按契约忽略；更新累计属性，不结束操作。
	setAttributes(attributes: SpanAttributes): void;
	// 显式设置ok/error，重复调用最后一次生效；未显式设状态时抛错/拒绝自动error，已有显式状态必须保留，不改变业务Promise的拒绝。
	setStatus(status: SpanStatus): void;
}

// 整组export type只重导出类型，在执行JS中擦除。
export type {
	// histogram专属桶提示元数据。
	HistogramOptions,
	// 共同描述/单位元数据。
	InstrumentOptions,
	// schema约束的counter静态add签名。
	SchemaTelemetryCounter,
	// schema约束的histogram静态record签名。
	SchemaTelemetryHistogram,
	// 低层counter记录句柄。
	TelemetryCounter,
	// 低层histogram记录句柄。
	TelemetryHistogram,
	// 指标属性定义，cardinality只允许low。
	TelemetryMetricAttributeDefinition,
	// 指标完整元数据及kind标签联合。
	TelemetryMetricDefinition,
	// 适配器可选指标能力。
	TelemetryMetrics,
	// 可增减counter句柄。
	TelemetryUpDownCounter,
	// 按schema限制工厂名字/种类/测量属性的接口。
	TypedTelemetryMetrics,
} from "./metrics.ts";
// 运行值重导出，实际helper运行时读取metrics定义并转发工厂。
export { createTypedMetrics } from "./metrics.ts";
// 运行重导出共享空上下文/指标/传播能力，业务callback仍执行，只有记录丢弃。
export { NOOP_TELEMETRY_CONTEXT, NOOP_TELEMETRY_METRICS, NOOP_TELEMETRY_PROPAGATION } from "./noop.ts";

// 六种属性类型名字联合，字符串"string[]"是schema标签，不是在此分配真实数组。
export type TelemetryAttributeType = "string" | "number" | "boolean" | "string[]" | "number[]" | "boolean[]";

// 描述属性的元数据，供文档/政策使用；敏感/基数标记不自动变成过滤器。
export interface TelemetryAttributeMetadata {
	// 必需可读描述。
	description: string;
	// 可选敏感标志，本包helper不据此自动脱敏值；其他adapter的处理政策由其实现决定。
	sensitive?: boolean;
	// 低/高基数提示，指不同可能取值规模，不是当前数组长度。
	cardinality?: "low" | "high";
}

// 属性定义=共同元数据&按type区分的联合；TS能让values/examples元素类型跟随标签，不提供运行验证。
export type TelemetryAttributeDefinition = TelemetryAttributeMetadata &
	// 括号把下列联合整体与元数据相交。

	// 字符串标量，可选闭集合values与示例。
	(
		| { type: "string"; values?: readonly string[]; examples?: readonly string[] }
		// 数值标量，number仍不自动保证有限/安全整数。
		| { type: "number"; values?: readonly number[]; examples?: readonly number[] }
		// 布尔标量，values可限制为某个字面true/false集合。
		| { type: "boolean"; values?: readonly boolean[]; examples?: readonly boolean[] }
		// 字符串数组用elementValues限制元素候选，examples是“若干只读字符串数组”的只读外层数组。
		| { type: "string[]"; elementValues?: readonly string[]; examples?: readonly (readonly string[])[] }
		// 数值数组同理，非嵌套任意结构。
		| { type: "number[]"; elementValues?: readonly number[]; examples?: readonly (readonly number[])[] }
		// 布尔数组同理。
		| { type: "boolean[]"; elementValues?: readonly boolean[]; examples?: readonly (readonly boolean[])[] }
	);

// 开始属性额外明确required:boolean，字面true/false能驱动下面静态必填推导。
export type TelemetryStartAttributeDefinition = TelemetryAttributeDefinition & { required: boolean };
// 事件属性同样单独声明required；和结束属性全部可选不同。
export type TelemetryEventAttributeDefinition = TelemetryAttributeDefinition & { required: boolean };

// 事件定义包含名字所对应的描述与属性表；名字本身是events映射的键，不重复在此字段。
export interface TelemetryEventDefinition {
	// 事件说明。
	description: string;
	// 事件属性名→定义。
	attributes: Record<string, TelemetryEventAttributeDefinition>;
}

// 父级政策的描述型标签联合，不是运行时自动验证父链的规则引擎。
export type TelemetryParentDefinition =
	// any表示根或任意父。
	| { kind: "any" }
	// root_or_external表示根或schema外调用方父。
	| { kind: "root_or_external" }
	// spans列出允许的schema父名字，readonly不冻结列表，内存adapter不据此拦截业务。
	| { kind: "spans"; spans: readonly string[] };

// 一类领域操作的说明数据，例load有必填资源名、可选结束计数、cache事件；不是实际正在运行的span。
export interface TelemetrySpanDefinition {
	// 操作描述。
	description: string;
	// 父政策元数据。
	parents: TelemetryParentDefinition;
	// 开始时传的属性表，各字段自己声明必填/可选。
	startAttributes: Record<string, TelemetryStartAttributeDefinition>;
	// 后续补充属性表，本类型没有required字段，推导为全可选；不是第二个独立存储包。
	endAttributes: Record<string, TelemetryAttributeDefinition>;
	// 可选事件名字表。
	events?: Record<string, TelemetryEventDefinition>;
	// 默认状态及错误时机文字，不解析errorWhen字符串自动判业务返回的{ok:false}。
	status: { default: "ok"; errorWhen: string };
}

// 可序列化领域schema集合，含span词汇及可选metrics词汇，可各模块独立版本组合。
export interface TelemetrySchemaDefinition {
	// schema版本元数据，不在helper自动做迁移/协商。
	version: number;
	// 操作名→定义。
	spans: Record<string, TelemetrySpanDefinition>;
	// 可选指标名→定义，typed metric helper会在运行时读取它。
	metrics?: Record<string, TelemetryMetricDefinition>;
}

/** Typed identity helper for serializable telemetry schema data. */
// defineTelemetrySchema是带const泛型的原样返回函数；例defineTelemetrySchema({version:1,spans:{}})保留字面信息。无复制/冻结/JSON校验/父政策执行，普通对象仍可由JS修改。
export function defineTelemetrySchema<const T extends TelemetrySchemaDefinition>(schema: T): T {
	// 直接返回同一schema引用，const泛型只影响TS推断，不生成Object.freeze。
	return schema;
}

// AttributeDefinitionValue按定义标签/闭集合推TS值类型，例type:string+values:["read","write"]推"read"|"write"，无values推string；只在编译期展开。
type AttributeDefinitionValue<Definition extends TelemetryAttributeDefinition> = Definition extends {
	// 先试字符串且确实有必需values字段的形状。
	type: "string";
	// infer Value extends string提取values每个元素的联合，并限定字符串。
	values: readonly (infer Value extends string)[];
}
	? // 有闭集合时取精确Value联合。
		Value
	: // 否则单纯字符串标签。
		Definition extends { type: "string" }
		? // 给宽string，不凭examples限制合法值。
			string
		: // 数值闭集合相同方式推Value。
			Definition extends { type: "number"; values: readonly (infer Value extends number)[] }
			? // 取数值字面量联合。
				Value
			: // 无闭集合的number标签。
				Definition extends { type: "number" }
				? // 宽number。
					number
				: // 布尔闭集合形状。
					Definition extends { type: "boolean"; values: readonly (infer Value extends boolean)[] }
					? // 取true/false候选联合。
						Value
					: // 无闭集合的boolean。
						Definition extends { type: "boolean" }
						? // 宽boolean。
							boolean
						: // 标量之外开始看数组定义。
							Definition extends {
									// 字符串数组标签。
									type: "string[]";
									// elementValues推每个允许元素的联合。
									elementValues: readonly (infer Value extends string)[];
								}
							? // 返回只读Value数组，不要求每个候选都出现，也不限制长度。
								readonly Value[]
							: // 没有elementValues但标签string[]。
								Definition extends { type: "string[]" }
								? // 给只读string[]。
									readonly string[]
								: // 再看数值数组定义。
									Definition extends {
											// number[]标签。
											type: "number[]";
											// 提取允许的数值元素。
											elementValues: readonly (infer Value extends number)[];
										}
									? // 只读数值候选联合数组。
										readonly Value[]
									: // 无闭集number[]标签。
										Definition extends { type: "number[]" }
										? // 宽readonly number[]。
											readonly number[]
										: // 最后看布尔数组闭集。
											Definition extends {
													// boolean[]标签。
													type: "boolean[]";
													// 推允许布尔元素联合。
													elementValues: readonly (infer Value extends boolean)[];
												}
											? // 只读Value数组。
												readonly Value[]
											: // 既定Definition六种标签剩余boolean[]给宽只读布尔数组；此条件链不是处理任意未知schema的运行校验。
												readonly boolean[];

// RequiredAttributeNames通过映射+索引取required严格true的键联合；例a必填/b可选得到a，-?去映射结果可选修饰，防undefined混入名字。
type RequiredAttributeNames<
	// 开始/事件属性都带required，可共用这份推导。
	Definitions extends Record<string, TelemetryStartAttributeDefinition | TelemetryEventAttributeDefinition>,
	// 下面先对全部键建立映射。
> = {
	// 每键值为它自己或never，不创建运行对象。
	[Name in keyof Definitions]-?: Definitions[Name]["required"] extends true ? Name : never;
	// 再取全部映射值为联合，never项自然消去。
}[keyof Definitions];

// OptionalAttributeNames用全部键排除已求出的必填键；例a|b去a剩b。
type OptionalAttributeNames<
	// 输入仍是属性定义表，不是用户实际属性对象。
	Definitions extends Record<string, TelemetryStartAttributeDefinition | TelemetryEventAttributeDefinition>,
	// Exclude是TS条件工具类型，全在编译期。
> = Exclude<keyof Definitions, RequiredAttributeNames<Definitions>>;

// InferRequiredAndOptionalAttributes把定义表变真实属性值类型，例{a:string required,b:number optional}变{a:string;b?:number}，没有定义则禁止任意字符串键。
export type InferRequiredAndOptionalAttributes<
	// 传入带required的定义表。
	Definitions extends Record<string, TelemetryStartAttributeDefinition | TelemetryEventAttributeDefinition>,
	// keyof为never说明没有已知字段。
> = keyof Definitions extends never
	? // Record<string,never>让任何字符串属性值都不能合法提供，不等同宽{}。
		Record<string, never>
	: // 有字段时分两组映射再相交。
		{
			// 必填键不加?，每值用前面按标签/闭集推导。
			[Name in RequiredAttributeNames<Definitions>]: AttributeDefinitionValue<Definitions[Name]>;
			// &把必填与可选两组结合，非运行对象展开。
		} & {
			// 可选键加?，值类型同样由定义推导。
			[Name in OptionalAttributeNames<Definitions>]?: AttributeDefinitionValue<Definitions[Name]>;
		};

// 开始属性使用上面共同推导，required:true决定必填。
export type InferStartAttributes<Definitions extends Record<string, TelemetryStartAttributeDefinition>> =
	// 类型别名转发，没有运行函数调用。
	InferRequiredAndOptionalAttributes<Definitions>;

// 结束属性都可选，例response?:string；不会在编译期要求业务必须setAttributes一次。
export type InferOptionalAttributes<Definitions extends Record<string, TelemetryAttributeDefinition>> =
	// 先识别空定义表。
	keyof Definitions extends never
		? // 空表用字符串键值never拒额外属性。
			Record<string, never>
		: // 其余每个定义键加?并推值类型。
			{ [Name in keyof Definitions]?: AttributeDefinitionValue<Definitions[Name]> };

// ExactTelemetryAttributes将Actual约束为Expected后，再把多余键变never；例已声明{provider:string}也能拒带unknown键的变量，非只靠对象字面量检查。
export type ExactTelemetryAttributes<Expected, Actual extends Expected> = Actual &
	// keyof差集取额外键，Record把其值设never，&与Actual相交使那些额外属性无法正常提供；绕过TS仍无运行拦截。
	Record<Exclude<keyof Actual, keyof Expected>, never>;

// 事件属性也按required推导，不与结束属性全可选混同。
export type InferEventAttributes<Definitions extends Record<string, TelemetryEventAttributeDefinition>> =
	// 复用共同属性映射。
	InferRequiredAndOptionalAttributes<Definitions>;

// 取schema.spans的字符串键联合，例"load"|"fetch"；&string排除其他键类型。
export type TelemetrySchemaSpanName<Schema extends TelemetrySchemaDefinition> = keyof Schema["spans"] & string;

// SchemaSpan按schema与具体Name取定义，是后面所有关联类型的内部入口。
type SchemaSpan<
	// 完整schema类型。
	Schema extends TelemetrySchemaDefinition,
	// Name必须是该schema声明过的span名。
	Name extends TelemetrySchemaSpanName<Schema>,
	// 两次索引访问，不创建span实例。
> = Schema["spans"][Name];

// 公开某个span开始属性类型，例TelemetrySchemaSpanStartAttributes<typeof S,"load">。
export type TelemetrySchemaSpanStartAttributes<
	// schema类型。
	Schema extends TelemetrySchemaDefinition,
	// 该schema中的具体span名。
	Name extends TelemetrySchemaSpanName<Schema>,
	// 从所选定义取startAttributes并infer表，再限定每项为开始属性定义。
> = SchemaSpan<Schema, Name>["startAttributes"] extends infer Definitions extends Record<
	// Record键为字符串。
	string,
	// 每项带type/required等开始定义。
	TelemetryStartAttributeDefinition
>
	? // 成功取表后推必填/可选值。
		InferStartAttributes<Definitions>
	: // 未匹配定义形状则never，非运行错误对象。
		never;

// 公开某span的结束属性类型，例load的count可选数值；不在此存储结束值。
export type TelemetrySchemaSpanEndAttributes<
	// 完整schema类型。
	Schema extends TelemetrySchemaDefinition,
	// 具体span名。
	Name extends TelemetrySchemaSpanName<Schema>,
	// 从定义取endAttributes并infer表。
> = SchemaSpan<Schema, Name>["endAttributes"] extends infer Definitions extends Record<
	// 字段名字符串。
	string,
	// 结束属性定义没有required约束。
	TelemetryAttributeDefinition
>
	? // 推所有字段可选的值类型。
		InferOptionalAttributes<Definitions>
	: // 异常类型形状退never。
		never;

// SchemaSpanEvents提取可选events表，没声明时无已知事件名字，不在运行时补表。
type SchemaSpanEvents<
	// schema参数。
	Schema extends TelemetrySchemaDefinition,
	// 选择的span名。
	Name extends TelemetrySchemaSpanName<Schema>,
	// 条件形状要求events存在且为事件定义表，infer Events取实际字面类型。
> = SchemaSpan<Schema, Name> extends { events: infer Events extends Record<string, TelemetryEventDefinition> }
	? // 匹配成功返回事件表类型。
		Events
	: // 没有则Record<never,never>，keyof为never，不是运行{}。
		Record<never, never>;

// 公开某span允许的事件字符串名字联合，例"cache"|"retry"。
export type TelemetrySchemaSpanEventName<
	// schema类型。
	Schema extends TelemetrySchemaDefinition,
	// span名。
	Name extends TelemetrySchemaSpanName<Schema>,
	// 事件表键&string，只用于TS参数限制。
> = keyof SchemaSpanEvents<Schema, Name> & string;

// SchemaSpanEvent从某span事件表按EventName取一条定义，保持名字/字段关联。
type SchemaSpanEvent<
	// schema。
	Schema extends TelemetrySchemaDefinition,
	// span名。
	Name extends TelemetrySchemaSpanName<Schema>,
	// EventName限定为这个span的事件名。
	EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
	// 先infer出事件表类型，分支内再按键索引。
> = SchemaSpanEvents<Schema, Name> extends infer Events
	? // 该事件名确属表键才取。
		EventName extends keyof Events
		? // 对应事件定义。
			Events[EventName]
		: // 没有名字退never。
			never
	: // 未匹配表也never。
		never;

// 公开某事件对应的实际属性对象类型；例retry含必填attempt:number，不是描述定义对象本身。
export type TelemetrySchemaSpanEventAttributes<
	// schema。
	Schema extends TelemetrySchemaDefinition,
	// span名。
	Name extends TelemetrySchemaSpanName<Schema>,
	// 事件名。
	EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
	// 先取事件定义，再匹配其attributes表。
> = SchemaSpanEvent<Schema, Name, EventName> extends {
	// infer Definitions并约束表项是事件属性定义。
	attributes: infer Definitions extends Record<string, TelemetryEventAttributeDefinition>;
}
	? // 通过required推必填/可选值类型。
		InferEventAttributes<Definitions>
	: // 不匹配退never。
		never;

// 内部取事件原始属性定义表，而非转换后值类型，给EventArguments判断哪些必填键。
type SchemaSpanEventAttributeDefinitions<
	// schema参数。
	Schema extends TelemetrySchemaDefinition,
	// span名。
	Name extends TelemetrySchemaSpanName<Schema>,
	// 事件名。
	EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
	// 从事件定义匹配属性表。
> = SchemaSpanEvent<Schema, Name, EventName> extends {
	// infer表的实际类型。
	attributes: infer Definitions extends Record<string, TelemetryEventAttributeDefinition>;
}
	? // 返回定义表本身。
		Definitions
	: // 缺表退无已知键映射。
		Record<never, never>;

// EventArguments按是否有必填键决定addEvent的属性参数可省与否；例无属性事件可addEvent("done")，required事件必须传对象。
type EventArguments<
	// 事件属性定义表。
	Definitions extends Record<string, TelemetryEventAttributeDefinition>,
	// 实传Attributes满足推导字段，随后Exact限制额外键。
	Attributes extends InferEventAttributes<Definitions>,
	// 用[T]包住条件整体判是否never，避免必填键联合被分配处理。
> = [RequiredAttributeNames<Definitions>] extends [never]
	? // 无必填键，用带?的单槽元组让实参可省。
		[attributes?: ExactTelemetryAttributes<InferEventAttributes<Definitions>, Attributes>]
	: // 有必填键，该槽不能省，Exact排掉未知属性。
		[attributes: ExactTelemetryAttributes<InferEventAttributes<Definitions>, Attributes>];

// SchemaTelemetrySpan是某领域span的静态视图：保留基础能力，重写addEvent/setAttributes签名限制名字和对应属性；不是新运行类或动态代理。
export type SchemaTelemetrySpan<
	// schema参数。
	Schema extends TelemetrySchemaDefinition,
	// 具体span名。
	Name extends TelemetrySchemaSpanName<Schema>,
	// Omit先去两方法，再&加下面精确签名；startSpan等基础方法仍是原低层接口。
> = Omit<TelemetrySpan, "addEvent" | "setAttributes"> & {
	// addEvent泛型方法，事件名决定属性表。
	addEvent<
		// EventName限当前span已声明事件。
		EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
		// const属性泛型保留实传字面信息，并满足该事件推导值类型。
		const Attributes extends InferEventAttributes<
			// 先取事件原始属性定义表。
			SchemaSpanEventAttributeDefinitions<Schema, Name, EventName>
			// 默认属性泛型为完整推导类型，没有提供额外显式泛型也可推断。
		> = InferEventAttributes<SchemaSpanEventAttributeDefinitions<Schema, Name, EventName>>,
	>(
		// 运行参数为事件名。
		name: EventName,
		// 剩余参数元组控制属性对象是否必须传，不是任意多个事件参数。
		...args: EventArguments<SchemaSpanEventAttributeDefinitions<Schema, Name, EventName>, Attributes>
		// 返回void，不返回事件id。
	): void;
	// setAttributes只允许所选span声明的结束属性，const泛型配Exact检查变量里的额外键。
	setAttributes<const Attributes extends TelemetrySchemaSpanEndAttributes<Schema, Name>>(
		// 实传对象被限制为对应结束字段，业务仍可零次调用此方法。
		attributes: ExactTelemetryAttributes<TelemetrySchemaSpanEndAttributes<Schema, Name>, Attributes>,
		// 静态声明不会替调用方自动记录字段。
	): void;
};

// TelemetrySchemaSpanUnion把每个span名/开始/结束/事件类型聚合为按name判别的联合，供领域工具消费；不是实际StoredSpan快照结构。
export type TelemetrySchemaSpanUnion<Schema extends TelemetrySchemaDefinition> = {
	// 先为每个Name构造一份类型记录。
	[Name in TelemetrySchemaSpanName<Schema>]: {
		// name保留确切字面量。
		name: Name;
		// 该名字的开始属性值类型。
		startAttributes: TelemetrySchemaSpanStartAttributes<Schema, Name>;
		// 该名字的可选结束属性值类型。
		endAttributes: TelemetrySchemaSpanEndAttributes<Schema, Name>;
		// 事件名→该事件属性值映射。
		events: {
			// 逐事件映射并使用公开事件属性推导。
			[EventName in TelemetrySchemaSpanEventName<Schema, Name>]: TelemetrySchemaSpanEventAttributes<
				// schema参数转交。
				Schema,
				// 当前span名转交。
				Name,
				// 当前事件名转交。
				EventName
			>;
		};
	};
	// 最后按全部span名索引，得到各记录联合，而非一个包含所有名字的同时必填对象。
}[TelemetrySchemaSpanName<Schema>];

// 一个或多个schema的只读元组，是typed starter组合词汇的输入；每份schema自身可没有span。
type TelemetrySchemaTuple = readonly [TelemetrySchemaDefinition, ...TelemetrySchemaDefinition[]];

// SpanNameInSchema以裸Schema条件分配联合，避免keyof联合只取公共键而丢不同模块词汇。
type SpanNameInSchema<Schema extends TelemetrySchemaDefinition> = Schema extends TelemetrySchemaDefinition
	? // 每份schema贡献自己的span名字。
		TelemetrySchemaSpanName<Schema>
	: // 其他类型不贡献。
		never;

// Schemas[number]先取各schema联合，再经上面分配获得所有名字。
type SpanNameInSchemas<Schemas extends TelemetrySchemaTuple> = SpanNameInSchema<Schemas[number]>;

// SpanStartAttributesInSchema按Name在联合各schema中找对应开始字段，例只有requestSchema贡献request属性。
type SpanStartAttributesInSchema<
	// 某份schema或联合。
	Schema extends TelemetrySchemaDefinition,
	// 待关联的名字。
	Name extends string,
	// 分配处理每一份schema。
> = Schema extends TelemetrySchemaDefinition
	? // 这份表含Name才采用。
		Name extends TelemetrySchemaSpanName<Schema>
		? // 取对应开始属性值类型。
			TelemetrySchemaSpanStartAttributes<Schema, Name>
		: // 没这名字贡献never。
			never
	: // 非schema也never。
		never;

// SpanInSchema同理按Name找领域span视图，供回调精确addEvent/setAttributes使用。
type SpanInSchema<
	// schema联合。
	Schema extends TelemetrySchemaDefinition,
	// 字符串名字。
	Name extends string,
	// 条件类型分配。
> = Schema extends TelemetrySchemaDefinition
	? // 该表含这个名字才匹配。
		Name extends TelemetrySchemaSpanName<Schema>
		? // 返回对应SchemaTelemetrySpan。
			SchemaTelemetrySpan<Schema, Name>
		: // 无名字贡献never。
			never
	: // 不匹配也never。
		never;

// DuplicateTelemetrySpanNames递归元组找重复span名，例[operation,operation]产生重复字面量供静态诊断，不在运行时维护全局注册表。
type DuplicateTelemetrySpanNames<
	// 尚待检查的schema类型数组。
	Schemas extends readonly TelemetrySchemaDefinition[],
	// Seen初始never，没有已见名。
	Seen extends string = never,
	// 条件元组拆首项与余项。
> = Schemas extends readonly [
	// infer Schema取首个并约束类型。
	infer Schema extends TelemetrySchemaDefinition,
	// ...infer Rest取余项元组。
	...infer Rest extends readonly TelemetrySchemaDefinition[],
]
	? // 以下两种重复来源合成联合。
		// 当前span名与Seen交集。
			| Extract<TelemetrySchemaSpanName<Schema>, Seen>
			// 递归余项，Seen并入当前所有span名。
			| DuplicateTelemetrySpanNames<Rest, Seen | TelemetrySchemaSpanName<Schema>>
	: // 空元组递归结束never。
		never;

// UniqueTelemetrySchemas用整体never检查把重复集合转成可读静态约束，不检查运行数组。
type UniqueTelemetrySchemas<Schemas extends TelemetrySchemaTuple> = [DuplicateTelemetrySpanNames<Schemas>] extends [
	// 与never比较，空集合即没重复。
	never,
]
	? // 没有重复时unknown不增加输入要求。
		unknown
	: // 有重复要求一个带错误名字的额外字段，普通调用无法满足而报类型错，不抛运行异常。
		{ readonly "duplicate telemetry span names": DuplicateTelemetrySpanNames<Schemas> };

// UnionToIntersection把各span函数联合变交叉，形成重载集：先分配包成函数参数，再借逆变位置infer交叉；纯TS技巧，不动态生成函数。
type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
	// infer Intersection在函数参数位置收集候选，得到联合各项的交叉类型。
	value: infer Intersection,
	// 外层匹配的是返回void函数类型。
) => void
	? // 匹配成功取交叉结果。
		Intersection
	: // 否则never。
		never;

// TypedSpanStarterForName描述一个确切名字的启动签名；例request要求provider属性，回调收request专用span和已绑定其父级的child starter。
type TypedSpanStarterForName<Schemas extends TelemetrySchemaTuple, Name extends SpanNameInSchemas<Schemas>> = <
	// const Attributes为实际开始属性，受Name所属schema约束。
	const Attributes extends SpanStartAttributesInSchema<Schemas[number], Name>,
	// Result泛型由业务回调返回值推断。
	Result,
>(
	// 名字参数必须这个Name；名字联合通常要先收窄才能选重载。
	name: Name,
	// 开始属性精确到此名字，额外变量键也用never排除。
	attributes: ExactTelemetryAttributes<SpanStartAttributesInSchema<Schemas[number], Name>, Attributes>,
	// 业务回调签名，既可同步T也可Promise<T>。
	callback: (
		// 第1参是当前名字的领域span视图。
		span: SpanInSchema<Schemas[number], Name>,
		// 第2参是绑定当前span的子操作启动器，仍可用整组schema词汇，不自动执行父政策元数据。
		startChildSpan: TypedSpanStarter<Schemas>,
		// 结果类型Result或其Promise，不替业务捕获异常。
	) => Result | Promise<Result>,
	// 启动器对外总返回Promise<Result>，实际Promise行为由adapter执行。
) => Promise<Result>;

/** A per-span overload set bound to one explicit parent context and one or more schemas. */
// 公开TypedSpanStarter是每个span签名的交叉重载集，让名字与属性保持关联；不是把两个不相关联合参数独立放行。
export type TypedSpanStarter<Schemas extends TelemetrySchemaTuple> = UnionToIntersection<
	// 先建立名字→对应启动函数签名映射。
	{
		// 每个名字各有一份精确属性/回调类型。
		[Name in SpanNameInSchemas<Schemas>]: TypedSpanStarterForName<Schemas, Name>;
		// 索引全部名字得到函数联合，再交UnionToIntersection变重载。
	}[SpanNameInSchemas<Schemas>]
>;

// bindTypedSpanStarter把一个实际父上下文包成typed函数；例在parent span的callback内再bind(parent)，之后启动的操作以它为父。只捕获context，不捕获schema对象，不验证声明。
function bindTypedSpanStarter<Schemas extends TelemetrySchemaTuple>(
	// 父上下文可以是根adapter、运行中span或提取的远端父；生命周期由它的实现决定。
	telemetryContext: TelemetryContext,
	// 返回上面精确重载接口，内部用宽签名实现。
): TypedSpanStarter<Schemas> {
	// 箭头函数startSpan在真正被调用时才创建操作，不在bind时启动。
	const startSpan = (
		// 运行名字仍普通string联合，未做schema白名单验证。
		name: SpanNameInSchemas<Schemas>,
		// 内部实现接低层开放属性，外部接口用泛型限制。
		attributes: SpanAttributes,
		// 业务回调内部用对应span联合的宽签名接收。
		callback: (
			// span由adapter提供，不新建另一份运行span。
			span: SpanInSchema<Schemas[number], SpanNameInSchemas<Schemas>>,
			// 子starter在回调开始时绑定该span。
			startChildSpan: TypedSpanStarter<Schemas>,
			// 内部返回unknown，具体Result关联由最终类型断言承诺。
		) => unknown,
		// 箭头表达式直接返回adapter的Promise，不是新加async包装。
	): Promise<unknown> =>
		// 把名字/开始属性交父context.startSpan，callback同步何时进入由adapter按契约保证。
		telemetryContext.startSpan({ name, attributes }, (span) =>
			// adapter回调内立即调用业务callback，两个参数如下。
			callback(
				// as把adapter通用span视为schema领域视图，运行对象完全同一个；不证明真实事件名/属性已验证。
				span as SpanInSchema<Schemas[number], SpanNameInSchemas<Schemas>>,
				// 为当前span新建子启动闭包，之后的名字词汇仍是同一Schemas泛型，真实schema值没有被读/保留。
				bindTypedSpanStarter<Schemas>(span),
			),
		);

	// 把内部宽函数断言成重载集，无运行Proxy或新增错误兜底；adapter异常/回调拒绝仍按原Promise传播。
	return startSpan as TypedSpanStarter<Schemas>;
}

/**
 * Bind an explicit parent context to the combined span vocabulary of one or more schemas.
 * Schema values are used only for type inference; no runtime schema validation is performed.
 */
// createTypedSpanStarter以显式context与schema类型建立启动器；例createTypedSpanStarter(adapter,[S])之后start("load",attrs,callback)。schema只用于TS推断，不运行父政策/属性校验，不冻结或保留_schemas值。
export function createTypedSpanStarter<const Schemas extends TelemetrySchemaTuple>(
	// 实际父上下文，后续真正记录靠它的startSpan实现。
	telemetryContext: TelemetryContext,
	// _schemas下划线只是未使用参数约定，仍会接收实参；const推断和Unique约束仅编译时，不运行扫描。
	_schemas: Schemas & UniqueTelemetrySchemas<Schemas>,
): TypedSpanStarter<Schemas> {
	// 只绑定context，schemas值没有被传给内部闭包。
	return bindTypedSpanStarter<Schemas>(telemetryContext);
}

// 整组Recorded快照类型重导出，只用于编译期，不是运行构造器。
export type {
	// 内存/规范测试用事件，不含Stored事件的时间偏移字段。
	RecordedTelemetryEvent,
	// 规范链接含carrier，不是StoredLink的独立trace/span id字段形状。
	RecordedTelemetryLink,
	// 原始单次测量快照，不是StoredMetric聚合行。
	RecordedTelemetryMeasurement,
	// 规范span记录包含settled/endSequence，不等同StoredSpan查询快照。
	RecordedTelemetrySpan,
} from "./memory.ts";
// 运行重导出内存参考adapter，它实现span/metrics/propagation/store；没有自动实例化全局记录器。
export { InMemoryTelemetryContext } from "./memory.ts";
