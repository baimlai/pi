/**
 * schema包公共契约：可编译规则、格式回调、编译选项、转换结果和可读错误。
 * type/interface本身不会校验外部输入；JSON Schema未知字段由Compiler/Resolver读取时处理。
 */
// Public types: the schema accepted by compile(), its options, and the errors a failed value produces.

/**
 * A JSON Schema: `true`, `false` or a schema object. Schemas come from tool definitions, MCP servers and other
 * untrusted sources, so compile() reads every keyword defensively instead of trusting a static shape.
 */
// object是很宽的TS对象类型，甚至可包含非JSON对象；不等于已校验过的schema文档，运行时还会检查使用到的形状。
export type JsonSchema = boolean | object;

/** A format check: whether `value` (a string) has the format. */
/** 格式检查函数，例value=>value.includes("@")；string参数由调用方先收窄，不在此额外parse字符串。回调可抛错，类型不保证纯函数。 */
export type FormatCheck = (value: string) => boolean;

/** Options of compile(). */
/** compile的只读选项视图；readonly仅禁止通过此类型重赋，不深冻结formats/schemas对象或阻止回调副作用。 */
export interface CompileOptions {
	/** The draft whose semantics apply: "2020-12" (default) or "7". */
	// 字面量联合限制正常TS调用；缺失默认2020-12，draft7的$ref/tuple等语义不同。
	readonly draft?: "2020-12" | "7";
	/**
	 * Format name to check. Without it `format` is an annotation, as draft 2020-12 specifies. The standard formats are
	 * in `@earendil-works/pi-schema/formats`.
	 */
	// 键为format名，值为检查函数；不提供相应条目就不把format当断言，也不自动导入标准formats。
	readonly formats?: Readonly<Record<string, FormatCheck>>;
	/** Schema documents by URI, for `$ref`s to other documents. */
	// 预注册URI→schema字典；引用解析只从这些文档/根查，不因为URI长得像HTTP就联网抓取。
	readonly schemas?: Readonly<Record<string, JsonSchema>>;
	/** Add `coerce()` and `parse()` to the validator, for loosely typed input (see the README's Coercion section). */
	// 严格true才构造CoercingValidator，启用coerce/parse；check本身仍只验证，不自动转换输入。
	readonly coerce?: boolean;
	/**
	 * What a `$ref` that names nothing (a missing definition, a document not in `schemas`) does: `"throw"` (default)
	 * makes compile() throw; `"reject"` compiles it as `false`, so only values at that place fail, with the error
	 * "unresolved reference".
	 */
	// 默认throw；reject把无法解析的引用位置编成false，不是无条件忽略此处校验。
	readonly unresolvedRefs?: "throw" | "reject";
}

/** The result of `parse()`: the coerced value when it is valid, else the errors of the coerced value. */
/** parse先转换再验证，按ok收窄；例if(result.ok)取value，否则读errors。失败错误针对转换后值，不保证仍对应原始输入的类型/形状。 */
export type ParseResult<T> =
	// readonly仅限制结果字段重赋，value泛型T内部不因此深只读。
	| { readonly ok: true; readonly value: T }
	// errors数组仍可变，不因外层readonly就变ReadonlyArray。
	| { readonly ok: false; readonly errors: ValidationError[] };

/** One failure of a value: where it is (a JSON Pointer, "" for the value itself), the failing keyword and a message. */
/** 一条错误：位置JSON Pointer+失败关键字+可读原因；多个错误可由errors方法收集，不是所有检查都自动返回错误列表。 */
export interface ValidationError {
	// 例如/path指字段，空串指整个值；JSON Pointer的~和/按转义规则表达。
	readonly path: string;
	// 例如required、type、minimum，程序应优先据字段而不是解析message处理。
	readonly keyword: string;
	// 展示文字，不承诺机器稳定协议、脱敏或本地化。
	readonly message: string;
}

/** A schema object as compile() reads it: any keyword, of any value, checked where it is used. */
// 索引签名允许未知关键字，但其值保持unknown，必须按实际关键字语义读取；readonly不改变运行对象。
export type SchemaObject = { readonly [keyword: string]: unknown };

/** A compiled boolean check. */
/** 已编译布尔检查，例check(unknownValue)返回true/false；没有错误列表或转换副作用的类型承诺，用户format回调异常仍可传播。 */
export type Check = (value: unknown) => boolean;
