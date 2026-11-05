/**
 * 指标记录接口与类型封装：counter累计增量、upDownCounter可增减、histogram记录测量值，由应用适配器决定如何存储/聚合。
 * 例createTypedMetrics(adapter,[schema]).counter("bytes").add(12,{direction:"out"})，TS按schema限制名字/属性，运行时转给adapter。
 * 类型推导/去重仅编译期；不自动验证数值有限性、counter非负、属性合法或桶严格递增，也不自动上传任何后端。
 * 与typed span helper不同，这里运行时会读schema.metrics并保留定义引用供工厂传元数据；实际适配器调用可抛错或有副作用。
 */
// 全组type导入运行时擦除；与index.ts的互引主要是类型，不因此形成同样的运行循环。
import type {
	// ExactTelemetryAttributes让额外键在静态检查中变成never。
	ExactTelemetryAttributes,
	// 按required标志推必填/可选字段的类型工具。
	InferRequiredAndOptionalAttributes,
	// 底层开放属性字典，值类型有限但不约束领域名字。
	SpanAttributes,
	// 显式上下文类型，histogram可将一条测量关联某span作exemplar。
	TelemetryContext,
	// 一份完整span/metric词汇schema的类型契约。
	TelemetrySchemaDefinition,
	// 指标属性沿用开始属性的type/required等定义。
	TelemetryStartAttributeDefinition,
} from "./index.ts";

// 工厂可选元数据，例{description:"响应耗时",unit:"ms"}，不自动做单位换算。
export interface InstrumentOptions {
	// 描述文字，可省略。
	description?: string;
	// 单位标签，例如ms/By，不由这里转换输入数值。
	unit?: string;
}

// histogram在共同元数据上增加桶边界提示；extends是接口继承，不创建运行对象。
export interface HistogramOptions extends InstrumentOptions {
	/** Bucket hints; callers supply finite, strictly increasing values. */
	// readonly数组只限制TS写入；调用方要提供有限且严格递增值，类型本身无法保证，后端也不一定照这些桶实际聚合。
	boundaries?: readonly number[];
}

// 单调counter的记录句柄，例add(5)表示增加5；调用方遵守非负/有限值约定，不在接口自动拦截坏数。
export interface TelemetryCounter {
	// add同步返回void，属性可省；不带上下文参数，不等于自动给当前span关联测量。
	add(value: number, attributes?: SpanAttributes): void;
}

// 可增减的计数句柄，例连接开add(1)、关add(-1)，不是读取“当前值”的getter。
export interface TelemetryUpDownCounter {
	// 同样同步add增量，是否聚合由adapter实现。
	add(value: number, attributes?: SpanAttributes): void;
}

// 直方图句柄记录一条测量，例record(12,{method:"read"},span)关联耗时与span；不是在此生成图表。
export interface TelemetryHistogram {
	// 第三参数可选上下文，仅作可选关联；record不自动创建/结束span。
	record(value: number, attributes?: SpanAttributes, context?: TelemetryContext): void;
}

/**
 * Optional adapter capability with synchronous factories and recording methods.
 * Typed inputs are trusted; callers supply finite measurements and nonnegative counter increments.
 * Malformed input behavior is unspecified.
 */
// 适配器可选的指标能力，三个工厂和记录方法都同步；例context.metrics存在才可记录，未承诺异常吞掉或运行验证输入。
export interface TelemetryMetrics {
	// 按名字/元数据创建counter句柄，创建/缓存策略由adapter决定。
	counter(name: string, options?: InstrumentOptions): TelemetryCounter;
	// 按名字创建可增减counter。
	upDownCounter(name: string, options?: InstrumentOptions): TelemetryUpDownCounter;
	// 按名字/桶提示创建histogram。
	histogram(name: string, options?: HistogramOptions): TelemetryHistogram;
}

// &交叉把属性定义与cardinality?:low合并，只允许声明低基数；没有此元数据也不表示可随意记录无限ID，运行时不靠它过滤。
export type TelemetryMetricAttributeDefinition = TelemetryStartAttributeDefinition & { cardinality?: "low" };

// 指标定义把共同说明/单位/属性与kind标签联合相交，例counter不能正常声明histogram的boundaries。
export type TelemetryMetricDefinition = {
	// 每个定义必需描述。
	description: string;
	// 可选单位标签。
	unit?: string;
	// 属性名→带type/required的属性定义，供静态推导和文档使用。
	attributes: Record<string, TelemetryMetricAttributeDefinition>;
	// counter/upDownCounter的boundaries?:never静态禁止该字段；histogram才可有readonly number[]，这是类型声明而非运行分支。
} & ({ kind: "counter" | "upDownCounter"; boundaries?: never } | { kind: "histogram"; boundaries?: readonly number[] });

// 索引访问类型提取三种kind联合，不生成字符串数组。
type MetricKind = TelemetryMetricDefinition["kind"];
// 只读非空元组，至少一份schema，其余任意多；不同于可为空普通数组类型。
type MetricSchemas = readonly [TelemetrySchemaDefinition, ...TelemetrySchemaDefinition[]];

// MetricsOf条件类型从schema取metrics表，缺失时给无已知键映射，不在运行时补{}。
type MetricsOf<Schema extends TelemetrySchemaDefinition> = Schema extends {
	// infer Metrics extends...在匹配时推断并限定表的形状。
	metrics: infer Metrics extends Record<string, TelemetryMetricDefinition>;
}
	? // 匹配成功取推断表类型。
		Metrics
	: // 无metrics则Record<never,never>，keyof为never。
		Record<never, never>;

// MetricNames按kind筛某schema的名字，例仅counter的名字供counter(name)使用；Schema联合在裸类型参数条件上分配，不执行遍历。
type MetricNames<
	// 参与筛选的schema类型。
	Schema extends TelemetrySchemaDefinition,
	// 需要的kind。
	Kind extends MetricKind,
	// 条件类型按联合schema逐支处理。
> = Schema extends TelemetrySchemaDefinition
	? // 先构造每个名字→名字或never的映射。
		{
			// 匹配kind才保留Name，不匹配变never。
			[Name in keyof MetricsOf<Schema>]: MetricsOf<Schema>[Name] extends { kind: Kind } ? Name : never;
			// 再索引全部key得到名字联合，&接下一行string。
		}[keyof MetricsOf<Schema>] &
			// 只保留字符串键，排symbol/number类型键。
			string
	: // 非schema候选无名字。
		never;

// MetricByName从多schema联合取某个名字的定义，例"duration"得到它的histogram定义；不是运行Map查找。
type MetricByName<
	// schema类型参数。
	Schema extends TelemetrySchemaDefinition,
	// 待查字符串名字类型。
	Name extends string,
	// 同样分配处理schema联合。
> = Schema extends TelemetrySchemaDefinition
	? // 该schema有此键才继续。
		Name extends keyof MetricsOf<Schema>
		? // 索引对应指标定义类型。
			MetricsOf<Schema>[Name]
		: // 没有这个名字贡献never。
			never
	: // 非匹配schema也never。
		never;

// DuplicateMetricNames递归拆schema元组并累计Seen，返回重复名字联合；例[traffic,traffic]产生重复名供静态报错，不添加运行检测。
type DuplicateMetricNames<
	// 待扫描的schema类型数组。
	Schemas extends readonly TelemetrySchemaDefinition[],
	// Seen初始never表示没有见过的名字。
	Seen extends string = never,
	// 通过元组解构条件取首项和余项。
> = Schemas extends readonly [
	// infer首份schema且限定其类型。
	infer Schema extends TelemetrySchemaDefinition,
	// ...infer Rest捕获剩余元组，不是运行数组展开。
	...infer Rest extends readonly TelemetrySchemaDefinition[],
]
	? // 当前键与Seen交集是重复项，再递归余项，把当前全部名字并入Seen。
		Extract<keyof MetricsOf<Schema>, Seen> | DuplicateMetricNames<Rest, Seen | (keyof MetricsOf<Schema> & string)>
	: // 空元组递归终点无重复，返回never。
		never;

// MetricAttributes将定义中的属性表交共同推导，得到必填/可选且值类型正确的测量对象。
type MetricAttributes<Definition extends TelemetryMetricDefinition> = InferRequiredAndOptionalAttributes<
	// 索引attributes类型，不读取真实对象。
	Definition["attributes"]
>;

// MeasurementArguments用元组控制add/record的属性参数是否可省；例至少一个required:true就要求传对象，没有必填项可省。
type MeasurementArguments<
	// 指标定义。
	Definition extends TelemetryMetricDefinition,
	// 实传属性类型必须满足推导字段，随后Exact再排额外键。
	Attributes extends MetricAttributes<Definition>,
	// 下面映射先收集必填键。
> = {
	// required严格true保留名字，否则never。
	[Name in keyof Definition["attributes"]]: Definition["attributes"][Name]["required"] extends true ? Name : never;
	// 索引得到必填键联合，判断是否never；这是编译期，不检查某个运行对象缺键。
}[keyof Definition["attributes"]] extends never
	? // 没有必填键时元组槽标?，可省attributes。
		[attributes?: ExactTelemetryAttributes<MetricAttributes<Definition>, Attributes>]
	: // 存在必填键时attributes必须提供，Exact排掉未知字段。
		[attributes: ExactTelemetryAttributes<MetricAttributes<Definition>, Attributes>];

// 带schema的counter句柄只改变静态签名，底层仍是普通TelemetryCounter；例方向值只能in/out。
export type SchemaTelemetryCounter<Definition extends TelemetryMetricDefinition> = {
	// const泛型尽量保留实传属性字面量，默认类型为推导的完整属性对象，不创建const变量。
	add<const Attributes extends MetricAttributes<Definition> = MetricAttributes<Definition>>(
		// 记录数值本身仍number，类型不表达有限/非负。
		value: number,
		// 剩余参数...args用上述元组决定属性必传/可省，不一定有多个属性对象。
		...args: MeasurementArguments<Definition, Attributes>
		// 同步void返回，不返回累计结果。
	): void;
};

// schema版histogram与counter同样约束属性，另保留末尾可选exemplar context。
export type SchemaTelemetryHistogram<Definition extends TelemetryMetricDefinition> = {
	// const Attributes让精确字段/字面量参与额外键检查。
	record<const Attributes extends MetricAttributes<Definition> = MetricAttributes<Definition>>(
		// 一条测量的值。
		value: number,
		// 变长元组展开属性参数后接可选context；要只给context时通常仍传undefined占attributes位置。
		...args: [...MeasurementArguments<Definition, Attributes>, context?: TelemetryContext]
		// record同步返回void。
	): void;
};

// TypedTelemetryMetrics把每种工厂名字和其定义关联；Schemas[number]取各schema元素联合，非某个运行下标读取。
export interface TypedTelemetryMetrics<Schemas extends MetricSchemas> {
	// counter只接kind为counter的名字。
	counter<Name extends MetricNames<Schemas[number], "counter">>(
		// Name保留字面量，返回属性签名可随名字变化。
		name: Name,
		// 按Name定义给counter句柄类型。
	): SchemaTelemetryCounter<MetricByName<Schemas[number], Name>>;
	// upDownCounter只接对应kind的名字。
	upDownCounter<Name extends MetricNames<Schemas[number], "upDownCounter">>(
		// 同样保留确切名字。
		name: Name,
		// 方法名仍add，所以可复用SchemaTelemetryCounter静态类型。
	): SchemaTelemetryCounter<MetricByName<Schemas[number], Name>>;
	// histogram只接histogram的名字。
	histogram<Name extends MetricNames<Schemas[number], "histogram">>(
		// 字面量名字关联其属性定义。
		name: Name,
		// 返回record与exemplar签名。
	): SchemaTelemetryHistogram<MetricByName<Schemas[number], Name>>;
}

/** Bind instrument names, kinds, metadata, and exact measurement attributes to one or more schemas. */
// createTypedMetrics读取定义→建名字表→返回三种转发工厂；例按"bytes"把schema描述/单位传给adapter。运行时不查重复/属性/kind，若绕过TS，同名定义后写覆盖，未知名字元数据可undefined。
export function createTypedMetrics<const Schemas extends MetricSchemas>(
	// 实际记录能力由传入adapter提供，helper不自建后端。
	metrics: TelemetryMetrics,
	// schemas既保留const非空元组类型，又与下面去重约束相交。
	schemas: Schemas &
		// [T] extends [never]用元组包避免条件类型按联合分配，整体判断是否没有重复名。
		([DuplicateMetricNames<Schemas>] extends [never]
			? // 无重复时与unknown相交不新增字段要求。
				unknown
			: // 有重复时要求一个带可读错误名的字段，普通schema数组无法满足，因此编译报错；无运行throw。
				{ readonly "duplicate telemetry metric names": DuplicateMetricNames<Schemas> }),
): TypedTelemetryMetrics<Schemas> {
	// 运行Map把名字关联原定义引用，不深拷贝/冻结，之后工厂可看到定义对象后续变更。
	const definitions = new Map<string, TelemetryMetricDefinition>();
	// 按schema数组顺序读取。
	for (const schema of schemas) {
		// 没有metrics当空表；Object.entries只读自有可枚举字符串项，同名字最后定义覆盖。
		for (const [name, definition] of Object.entries(schema.metrics ?? {})) definitions.set(name, definition);
	}
	// 返回转发工厂对象，尚未调用adapter工厂，只有用户之后取句柄时才调用。
	return {
		// counter转发名字与定义作为options；定义多出的kind/attributes字段不会在此被过滤。
		counter: (name: string) => metrics.counter(name, definitions.get(name)),
		// 可增减counter同样转发，不自动给值取正或负。
		upDownCounter: (name: string) => metrics.upDownCounter(name, definitions.get(name)),
		// histogram把定义中的boundaries也传给adapter，不在此分桶聚合。
		histogram: (name: string) => metrics.histogram(name, definitions.get(name)),
		// 先as unknown再as目标类型把静态关联签名承诺交TS；没有新增运行验证，adapter异常/副作用正常传播。
	} as unknown as TypedTelemetryMetrics<Schemas>;
}
