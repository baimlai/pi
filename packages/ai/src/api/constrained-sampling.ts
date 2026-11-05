// 工具约束生成的协议适配：按供应商支持选择JSON Schema严格子集或grammar，并把流式grammar文本增量包装为JSON参数；不是本地完整schema/语法验证器。
// 工具声明类型，parameters是schema对象，不是实参值。
import type { Tool } from "../types.ts";

// 内部schema字典视图，仅列转换用到的字段，其余键仍unknown。
interface JsonSchemaObject {
	// 索引签名允许读取任意schema关键词，但不信任其值类型。
	[key: string]: unknown;
	// type字段来自外部schema，必须在使用时判形状。
	type?: unknown;
	// properties若存在应为名字到子schema的字典；undefined子项仍会被运行检查拒绝。
	properties?: Record<string, JsonSchemaObject | undefined>;
	// required未预信任为数组，下面检查。
	required?: unknown;
}

// 专属错误子类，用于区分可降级的不支持schema与其他异常；空类仍有独立运行时构造器。
class UnsupportedStrictJsonSchemaError extends Error {}

/** Returns true when a provider's strict mode rejects this schema keyword with this value. */
// 回调类型：给关键词/值，true表示该供应商额外不支持；本行只声明签名，不执行检查。
export type UnsupportedStrictSchemaKeywordCheck = (key: string, value: unknown) => boolean;

// 本转换器明确不支持的关键词列表，不等同所有JSON Schema标准关键词。
const UNSUPPORTED_STRICT_SCHEMA_KEYS = [
	// 不解析外部/内部$ref引用。
	"$ref",
	// 不处理新版$defs定义集。
	"$defs",
	// 不处理旧版definitions定义集。
	"definitions",
	// 不处理allOf交集组合。
	"allOf",
	// 不处理oneOf排他组合。
	"oneOf",
	// 不处理按属性名正则匹配的schema。
	"patternProperties",
	// 不处理dependentSchemas依赖schema。
	"dependentSchemas",
	// 不处理旧dependencies规则。
	"dependencies",
	// 不处理unevaluatedProperties。
	"unevaluatedProperties",
	// 不处理propertyNames属性名约束。
	"propertyNames",
	// 不处理contains数组包含约束。
	"contains",
	// 不处理prefixItems元组前缀。
	"prefixItems",
	// 不处理not反向约束。
	"not",
	// 不处理条件if。
	"if",
	// 不处理条件then。
	"then",
	// 不处理条件else。
	"else",
	// as const保留字符串字面量与只读元组类型，不冻结数组。
] as const;

/**
 * 判断未知schema节点是否为非null非数组object，返回类型谓词，无修改。
 * 例：{}通过、true不通过；只是拿到可读字段形状，不证明是合法JSON Schema。
 */
function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
	// 检查unknown外部schema容器，value is使TS成功分支可按JsonSchemaObject访问。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 浅识别节点是否含object/array结构线索，返回boolean，不递归验证schema。
 * 例：type=["object","null"]或存在properties/items都判结构化，用于拒绝anyOf里的这类分支；其他关键词不在这里穷尽。
 */
function isStructuredSchema(schema: unknown): boolean {
	// 非对象没有本函数要检测的结构线索。
	if (!isJsonSchemaObject(schema)) return false;
	// type字符串变单元素数组，原数组直接用，其他形状当空列表。
	const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
	// 下面任一线索成立便返回true。
	return (
		// 类型列表含object。
		types.includes("object") ||
		// 或含array。
		types.includes("array") ||
		// 或显式给properties字段，不要求它此刻已合法。
		schema.properties !== undefined ||
		// 或显式给items字段。
		schema.items !== undefined
	);
}

/**
 * 按type、const、enum或anyOf递归识别已有null表示，返回boolean，不修改schema。
 * 例：anyOf中有{type:"null"}会命中；这不是完整逻辑求值，不证明互相矛盾的其他schema约束也一定允许null。
 */
function schemaAllowsNull(schema: unknown): boolean {
	// 非对象无法按这些字段识别null。
	if (!isJsonSchemaObject(schema)) return false;
	// type为null，或类型数组包含null即识别命中。
	if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null"))) return true;
	// const=null或enum含null也识别命中，不计算其他矛盾规则。
	if (schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null))) return true;
	// anyOf为数组时递归看任一分支；其他形式返回false。
	return Array.isArray(schema.anyOf) && schema.anyOf.some((variant) => schemaAllowsNull(variant));
}

/**
 * 在已克隆的schema节点上就地转换严格子集，返回void；遇不支持形式抛专属Error。
 * 先拒绝已知关键词/供应商额外检查，再递归anyOf/items/properties；对象需type精确object、禁止额外属性，原可选且未识别null的字段包成nullable，并把全部属性列required。
 * 例：可选number变anyOf:[number,null]且列required；只检查这套子集规则，不是完整JSON Schema验证，也不验证真实工具实参。外层负责先clone避免改工具定义。
 */
function makeJsonSchemaNodeStrict(schema: unknown, isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck): void {
	// 所有节点先要求非null非数组object。
	if (!isJsonSchemaObject(schema)) {
		// 原错误称boolean schema不支持，实际这条分支也拒绝数字/字符串/null等非对象。
		throw new UnsupportedStrictJsonSchemaError("boolean schemas are unsupported");
	}
	// 按列表逐关键词检查，不递归引用。
	for (const key of UNSUPPORTED_STRICT_SCHEMA_KEYS) {
		// 字段值不为undefined就视为存在，null/false也会命中。
		if (schema[key] !== undefined) {
			// 抛专属错误，prefer模式调用方可据此降级。
			throw new UnsupportedStrictJsonSchemaError(`${key} schemas are unsupported`);
		}
	}
	// 提供供应商额外检查回调时再执行。
	if (isUnsupportedKeyword) {
		// 遍历当前节点所有自有可枚举字符串字段。
		for (const [key, value] of Object.entries(schema)) {
			// 让供应商按键/值判断额外限制。
			if (isUnsupportedKeyword(key, value)) {
				// 命中则专属错误；JSON.stringify值自身失败仍是另一种异常。
				throw new UnsupportedStrictJsonSchemaError(`${key}: ${JSON.stringify(value)} is unsupported`);
			}
		}
	}

	// 存在anyOf字段时需检查其数组形状与分支。
	if (schema.anyOf !== undefined) {
		// 要求非空数组，不接受单对象或空数组。
		if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
			// 抛专属不支持错误。
			throw new UnsupportedStrictJsonSchemaError("anyOf must contain at least one schema");
		}
		// 逐个递归分支，不把它们合并成一个schema。
		for (const variant of schema.anyOf) {
			// 有object/array结构线索的anyOf分支不支持。
			if (isStructuredSchema(variant)) {
				// 拒绝这类结构化联合，不在此自动重写为别的逻辑。
				throw new UnsupportedStrictJsonSchemaError("object and array unions are unsupported");
			}
			// 标量等分支继续检查同样的严格子集规则。
			makeJsonSchemaNodeStrict(variant, isUnsupportedKeyword);
		}
	}

	// 数组items存在则递归处理。
	if (schema.items !== undefined) {
		// items本身是数组代表元组形式，这里拒绝。
		if (Array.isArray(schema.items)) {
			// 不把元组静默当普通同构数组。
			throw new UnsupportedStrictJsonSchemaError("tuple schemas are unsupported");
		}
		// 单一items节点递归转换，不在这里检查每个数组实参。
		makeJsonSchemaNodeStrict(schema.items, isUnsupportedKeyword);
	}

	// 只有type精确等于字符串object才按对象规则处理。
	const isObjectSchema = schema.type === "object";
	// 有properties却不是精确type=object时拒绝。
	if (schema.properties !== undefined && !isObjectSchema) {
		// 要求声明对象类型，不能仅凭properties猜类型。
		throw new UnsupportedStrictJsonSchemaError("properties require type object");
	}
	// 非对象经过前面通用/子节点检查后即可返回，不强制所有叶节点都有type。
	if (!isObjectSchema) return;
	// 对象additionalProperties只能缺省或false；true/子schema/null均拒绝。
	if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
		// 抛专属错误，而非删除调用方明确的额外字段规则。
		throw new UnsupportedStrictJsonSchemaError("schema-valued or true additionalProperties is unsupported");
	}
	// 有properties就要求它本身是非null非数组object字典。
	if (schema.properties !== undefined && !isJsonSchemaObject(schema.properties)) {
		// 非法字段表拒绝，避免Object.entries错误解释。
		throw new UnsupportedStrictJsonSchemaError("object properties must be a schema map");
	}
	// 检查可选required字段。
	if (
		// required缺省允许。
		schema.required !== undefined &&
		// 明确给出时必须为数组且每项字符串；不要求此处非空或去重。
		(!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))
	) {
		// 不合法required抛专属错误。
		throw new UnsupportedStrictJsonSchemaError("object required must be a string array");
	}

	// 没properties时用局部空字典；不会在此自动给schema加properties字段。
	const properties = schema.properties ?? {};
	// 取当前所有自有属性名，后面将全部列为required。
	const propertyNames = Object.keys(properties);
	// 原required用Set便于去重/查是否曾必需，缺省为空。
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	// 原required任何键未出现在properties中就拒绝。
	if ([...required].some((key) => !propertyNames.includes(key))) {
		// 不能制造不存在属性的必需约束。
		throw new UnsupportedStrictJsonSchemaError("required contains an unknown property");
	}
	// 逐属性拿子schema引用，在克隆树上递归。
	for (const [key, property] of Object.entries(properties)) {
		// 先转换原子schema，再考虑可选字段补null。
		makeJsonSchemaNodeStrict(property, isUnsupportedKeyword);
		// 原来可选且尚未识别null表示才包nullable。
		if (!required.has(key) && !schemaAllowsNull(property)) {
			// 就地替properties该项为anyOf，保留转换后的原子schema引用。
			properties[key] = { anyOf: [property, { type: "null" }] };
		}
	}
	// 把全部属性名列required，用null表达原先省略的可选值。
	schema.required = propertyNames;
	// 严格对象禁止额外属性。
	schema.additionalProperties = false;
}

/** Convert a tool schema to the strict subset expected by provider constrained sampling. */
/**
 * 深克隆工具参数schema后转严格子集并要求根type精确object，返回新字典，不改原schema。
 * 例：原可选字段保持不变，返回副本可变为必需但允许null；structuredClone失败等非专属异常仍直接抛出，供应商check回调也可能抛错。
 */
export function makeStrictJsonSchema(
	// 索引访问Tool参数类型，指schema本身。
	schema: Tool["parameters"],
	// 可选供应商关键词检查回调。
	isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
	// 返回普通字典，不保证还保留原schema库的类型/原型。
): Record<string, unknown> {
	// structuredClone深复制，避免递归转换改原工具定义；不可克隆值仍会抛错。
	const cloned: unknown = structuredClone(schema);
	// 根必须先是非null非数组object。
	if (!isJsonSchemaObject(cloned)) {
		// 否则给根对象类型错误。
		throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	}
	// 在副本上递归转换/检查，不在原schema上操作。
	makeJsonSchemaNodeStrict(cloned, isUnsupportedKeyword);
	// 根最终还必须type精确object，标量根不接受。
	if (cloned.type !== "object") {
		// 拒绝错误根类型。
		throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	}
	// 返回改好的克隆字典。
	return cloned;
}

/** Returns true for a tool that asks for strict JSON-schema sampling only when possible (`strict: "prefer"`). */
/**
 * 只判断工具是否明确json_schema+strict:prefer，返回boolean，不验证schema或服务能力。
 * 例：require/false/未配置均false，true只表示偏好，可行性另由resolve函数判断。
 */
export function prefersJsonSchemaStrictSampling(tool: Tool): boolean {
	// 读取可缺省/false的约束配置。
	const config = tool.constrainedSampling;
	// !!归boolean并短路收窄，只有json_schema+prefer命中。
	return !!config && config.type === "json_schema" && config.strict === "prefer";
}

/**
 * Claude rejects (on the Anthropic API and on Bedrock) a request whose strict tools exceed its limits with one of these
 * messages. Observed limits: 20 strict tools, and 16 optional or union-typed parameters across all strict tools.
 */
// 已观察到的严格工具总量/编译大小错误文案，用于识别而非本地数工具。
const STRICT_TOOL_LIMIT_ERROR_MESSAGES = [
	// 编译grammar规模过大错误线索。
	"The compiled grammar is too large",
	// 严格工具数过多线索，不在本地硬编码20检查。
	"Too many strict tools (",
	// 联合类型参数过多线索，不在本地计算16上限。
	"Schemas contains too many parameters with union types (",
];

/** Returns true when a provider error message says the request's strict tools exceed the provider's limits. */
/**
 * 按已知子串识别严格工具限额错误，返回boolean，无I/O。
 * 例：消息含Too many strict tools (命中；大小写敏感，未命中不能证明失败与严格工具无关，也不在此自动降级重试。
 */
export function isStrictToolLimitErrorMessage(message: string): boolean {
	// some按大小写敏感includes匹配任一已知片段。
	return STRICT_TOOL_LIMIT_ERROR_MESSAGES.some((limitMessage) => message.includes(limitMessage));
}

/**
 * strict严格等于true时生成严格副本，否则返回原tool.parameters引用，无网络。
 * 例：undefined/false不改schema；as Tool["parameters"]只协调返回类型，严格转换抛错会向外传播。
 */
export function getJsonSchemaToolParameters(tool: Tool, strict: boolean | undefined): Tool["parameters"] {
	// true才转换成副本，false/undefined返回原引用；as只协调Tool参数类型。
	return (strict === true ? makeStrictJsonSchema(tool.parameters) : tool.parameters) as Tool["parameters"];
}

// 成功解析的grammar描述，不是已编译的grammar实例。
export interface GrammarConstrainedSampling {
	// 供应商可用格式为lark或regex。
	format: "lark" | "regex";
	// 语法定义原文本。
	definition: string;
	// 承载原始文本的工具参数字段名。
	inputProperty: string;
}

// 一次流式grammar调用的可变累加状态，由调用方按工具调用分别持有。
export interface GrammarToolInputJsonBuffer {
	// 累计原始输入，不是已经转义后的JSON片段。
	input: string;
	// JSON对象/值开头是否已输出。
	started: boolean;
	// 是否已输出结束部分，之后不许追加或改最终值。
	closed: boolean;
}

/**
 * 从工具调用参数字典按inputProperty读取grammar原始文本，返回字符串，非字符串抛错。
 * 例：payload="abc"直接返回，payload=42拒绝；空字符串允许，不在这里验证是否符合Lark/regex或禁止其他参数字段。
 */
export function getGrammarToolInput(
	// 工具名只用于错误诊断。
	toolName: string,
	// 未知实参字典，arguments_避开arguments特殊名字。
	arguments_: Record<string, unknown>,
	// 已推导出的文本承载字段名。
	inputProperty: string,
	// 返回字符串，空串也可成功。
): string {
	// 按字段名读取unknown实参。
	const input = arguments_[inputProperty];
	// 语法工具约定该字段必须字符串，运行时边界检查。
	if (typeof input !== "string") {
		// 不合约定就抛明确工具名/参数名错误。
		throw new Error(`Grammar tool call "${toolName}" requires argument "${inputProperty}" to be a string.`);
	}
	// 保留原始文本，不解析或验证grammar。
	return input;
}

/**
 * Append `inputDelta` to a streaming grammar tool input and return the matching piece of its JSON arguments text, or
 * `undefined` for an empty delta. Costs time linear in the delta, never in the input so far.
 */
/**
 * 把一段grammar原文追加buffer，并返回对应JSON字符串片段，空增量返回undefined。
 * 就地累计input、首次输出JSON键/开引号，后续只转义新增文字；例：先a再引号的片段拼起来仍是一个字符串值。closed时即使传空增量也抛错。
 * 不在每次增量重新JSON.stringify全部历史；调用方需始终为该buffer传同一inputProperty，本结构不另存/核对属性名。
 */
export function appendGrammarToolInputJsonDelta(
	// 本次调用独立buffer，会就地改变。
	buffer: GrammarToolInputJsonBuffer,
	// 整个buffer生命周期应使用相同属性名，本函数不另存校验。
	inputProperty: string,
	// 新收到的原始文本片段，不含JSON外壳。
	inputDelta: string,
	// 可能没有需发片段，因而返回undefined。
): string | undefined {
	// 先查closed，后查空串，所以已关闭时空增量也拒绝。
	if (buffer.closed) {
		// 不允许流结束后再改文本。
		throw new Error(`grammar tool input for property "${inputProperty}" changed after it was closed`);
	}
	// 未关闭且空增量不更改input/started。
	if (inputDelta.length === 0) return undefined;
	// 把新增原文追加到buffer，不在此重新序列化全部历史。
	buffer.input += inputDelta;
	// 首次补JSON开头，再只对增量JSON转义并去掉其外层引号。
	return grammarToolInputJsonStart(buffer, inputProperty) + JSON.stringify(inputDelta).slice(1, -1);
}

/**
 * Close a streaming grammar tool input and return the rest of its JSON arguments text. `finalInput` is the complete
 * input when the provider sends one; it must continue the input streamed so far. Closing again with the same input
 * returns `undefined`.
 */
/**
 * 关闭grammar输入并返回剩余JSON尾段，更新buffer.input/closed；相同完成值重复关闭返回undefined。
 * finalInput若给出必须以已累计input为前缀，不允许改旧内容；例：累计ab、最终abcd时仅补cd及结束引号/大括号，未给最终值则只关JSON。
 * 已关闭但给不同最终值或非单调前缀会抛错；这是文本一致性检查，不验证最终文本符合grammar。
 */
export function closeGrammarToolInputJson(
	// 即将关闭的调用buffer。
	buffer: GrammarToolInputJsonBuffer,
	// 用于首次空输入也能生成正确JSON键的属性名。
	inputProperty: string,
	// 服务端可选完整最终文本；undefined表示没有额外补充。
	finalInput: string | undefined,
	// 重复关闭同值时返回undefined，否则返回尾段文字。
): string | undefined {
	// 已经关闭时不重复输出JSON结束。
	if (buffer.closed) {
		// 没给最终值或与累计原文完全相等，视为幂等关闭。
		if (finalInput === undefined || finalInput === buffer.input) return undefined;
		// 已关闭却给不同值报错。
		throw new Error(`grammar tool input for property "${inputProperty}" changed after it was closed`);
	}
	// 未关闭且有最终值时，要求旧input是它的完整前缀。
	if (finalInput !== undefined && !finalInput.startsWith(buffer.input)) {
		// 不能把原来abc修订成abd，不输出撤回片段。
		throw new Error(`grammar tool input for property "${inputProperty}" changed non-monotonically`);
	}
	// 只提最终文本新增后缀；缺省则空后缀。
	const rest = finalInput === undefined ? "" : finalInput.slice(buffer.input.length);
	// 给了最终文本时把buffer.input更新为它。
	if (finalInput !== undefined) buffer.input = finalInput;
	// 先标closed，后面生成尾段。
	buffer.closed = true;
	// 补可能尚未输出的JSON开头、转义后缀与结束引号/大括号；只返回追加片段。
	return `${grammarToolInputJsonStart(buffer, inputProperty)}${JSON.stringify(rest).slice(1, -1)}"}`;
}

/** The opening of the JSON arguments text, once. */
/**
 * 返回JSON对象的键和字符串开头，第一次调用同时置started=true，以后空串，无网络。
 * 例：inputProperty=payload得到对象开括号、转义后的键与值开引号；用JSON.stringify处理键名转义，不输出结束部分。
 */
function grammarToolInputJsonStart(buffer: GrammarToolInputJsonBuffer, inputProperty: string): string {
	// 开头已发过就返回空串，防止重复对象外壳。
	if (buffer.started) return "";
	// 第一次生成时就地记录started。
	buffer.started = true;
	// JSON.stringify转义属性名，拼对象开头和字符串开引号，不输出闭合部分。
	return `{${JSON.stringify(inputProperty)}:"`;
}

/**
 * 从参数schema推导grammar承载文本的唯一必需属性名，返回字符串，形状不合抛错。
 * 要求根type=object、required恰一字符串且同名properties项type=string；例：required=["payload"]可接受同时还有其他可选字段，不等于schema只准一个属性；不验证全部schema关键词。
 */
function inferGrammarInputProperty(tool: Tool): string {
	// schema类型视图，不在此深复制或执行完整schema验证。
	const schema = tool.parameters as JsonSchemaObject;
	// 根必须明确type=object。
	if (schema.type !== "object") {
		// 不从缺省type或anyOf猜承载对象。
		throw new Error("grammar constrained sampling requires an object parameter schema");
	}
	// required必须恰有一个字符串元素；其他可选属性未在此禁止。
	if (!Array.isArray(schema.required) || schema.required.length !== 1 || typeof schema.required[0] !== "string") {
		// 不符合单一必需文本入口契约就抛错。
		throw new Error("grammar constrained sampling requires exactly one required string property");
	}

	// 唯一required元素就是承载字段名。
	const inputProperty = schema.required[0];
	// properties字典必须真有该名称的真值schema项。
	if (!schema.properties?.[inputProperty]) {
		// 缺对应schema不能推导输入。
		throw new Error(`grammar constrained sampling requires a properties entry for ${inputProperty}`);
	}
	// 该属性type必须精确string，不接受union或隐式字符串。
	if (schema.properties[inputProperty]?.type !== "string") {
		// 不符合字符串承载要求即拒绝。
		throw new Error(`grammar constrained sampling property ${inputProperty} must have type string`);
	}
	// 返回字段名，不检查其他可选字段或additionalProperties规则。
	return inputProperty;
}

/**
 * Decide whether a JSON-schema tool is sent in strict mode. `isUnsupportedKeyword` lets a provider
 * reject extra keywords its strict mode does not accept, so "prefer" tools fall back to non-strict.
 */
/**
 * 决定工具是否启用JSON Schema严格采样，返回true或undefined，失败可能抛错。
 * 未配置/非此模式undefined；服务支持且转换成功true；专属不支持错误遇prefer降级undefined、require抛说明，其他错误原样抛。
 * 例：服务不支持且require立即失败；此函数仅试转换而不返回副本，实际参数生成在getJsonSchemaToolParameters，不发模型请求。
 */
export function resolveJsonSchemaStrictSampling(
	// 工具定义含schema和约束偏好。
	tool: Tool,
	// 适配器提供的支持标记，不在本函数联网探测。
	supportsStrictMode: boolean,
	// 供应商额外拒绝关键词规则。
	isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
	// 实际成功返回true或undefined，没有返回false的分支。
): boolean | undefined {
	// 读取可能缺省/关闭的约束配置。
	const config = tool.constrainedSampling;
	// 不是JSON Schema模式时不干预严格设置。
	if (!config || config.type !== "json_schema") return undefined;

	// 服务支持才尝试生成严格子集。
	if (supportsStrictMode) {
		// 专属不支持错误可以按prefer降级。
		try {
			// 只验证转换能否成功，副本在此丢弃，原工具保持不变。
			makeStrictJsonSchema(tool.parameters, isUnsupportedKeyword);
			// 转换成功表示可以要求严格模式，不证明服务端必接受所有语义。
			return true;
			// 转换失败在这里分类。
		} catch (error) {
			// 只处理本模块专属不支持异常；clone/callback等其他错误原样向外。
			if (!(error instanceof UnsupportedStrictJsonSchemaError)) throw error;
			// 不是require就返回undefined，交适配器走普通声明逻辑。
			if (config.strict !== "require") return undefined;
			// require时附工具名与具体原因重新抛普通Error。
			throw new Error(`Tool "${tool.name}" requires JSON-schema constrained sampling, but ${error.message}.`);
		}
	}
	// 服务不支持但调用方明确require时不能静默降级。
	if (config.strict === "require") {
		// 构造能力不支持的错误。
		throw new Error(
			// 文案带工具名，指出strict tools不可用。
			`Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`,
		);
	}
	// 服务不支持且只是prefer时返回undefined，不试转schema。
	return undefined;
}

/**
 * 选可支持的grammar格式、定义与承载属性名，返回描述对象或undefined，无网络。
 * 未配置grammar或供应商不支持则直接undefined；支持时优先非空白Lark，再regex，没有可用文本或schema不合抛带工具名错误。
 * 例：两种都给时选Lark，definition保留原空白，不在此编译/解析语法；不支持时也不会先验证grammar配置再报错。
 */
export function resolveGrammarConstrainedSampling(
	// 工具定义与grammar变体配置。
	tool: Tool,
	// 适配器是否支持OpenAI grammar tools。
	supportsOpenAIGrammarTools: boolean,
	// 返回解析好的描述或缺省，不返回布尔是否远端执行成功。
): GrammarConstrainedSampling | undefined {
	// 先读约束配置。
	const config = tool.constrainedSampling;
	// 缺省/false/其他模式都不处理grammar。
	if (!config || config.type !== "grammar") {
		// 返回undefined让外层继续普通工具路径。
		return undefined;
	}

	// 不支持grammar时直接回退，不验证变体/schema。
	if (!supportsOpenAIGrammarTools) {
		// 返回undefined，不抛能力require错误，因为grammar配置没有require字段。
		return undefined;
	}

	// 读取可选Lark定义。
	const larkDefinition = config.variants.openai_lark;
	// 读取可选regex定义。
	const regexDefinition = config.variants.openai_regex;
	// 非空白字符串才算可用Lark；只检查文本，不编译语法。
	const hasLarkDefinition = typeof larkDefinition === "string" && larkDefinition.trim().length > 0;
	// regex同样只检查是否非空白。
	const hasRegexDefinition = typeof regexDefinition === "string" && regexDefinition.trim().length > 0;
	// 没有任何支持格式就无法选定义。
	if (!hasLarkDefinition && !hasRegexDefinition) {
		// 构造明确的缺变体错误。
		throw new Error(
			// 工具名进入错误文案，不伪造默认grammar。
			`Tool "${tool.name}" cannot use grammar constrained sampling: no supported grammar variant was provided.`,
		);
	}

	// 推导字段失败时统一加工具名语境。
	try {
		// 构造返回描述。
		return {
			// 两种都可用时优先Lark。
			format: hasLarkDefinition ? "lark" : "regex",
			// 保留原定义文本；regex!只是编译期非空断言，不trim定义。
			definition: hasLarkDefinition ? larkDefinition : regexDefinition!,
			// 从参数schema推导唯一必需字符串字段。
			inputProperty: inferGrammarInputProperty(tool),
		};
		// 捕获字段推导或对象建立过程中的异常。
	} catch (error) {
		// Error取message，其他值转字符串。
		const message = error instanceof Error ? error.message : String(error);
		// 补工具名与grammar语境后抛出，不静默降级坏配置。
		throw new Error(`Tool "${tool.name}" cannot use grammar constrained sampling: ${message}.`);
	}
}

/**
 * 遍历可选工具列表，为成功解析grammar的工具建立name→inputProperty新Map并返回。
 * 例：同名工具后项覆盖前项，无工具返回空Map；ReadonlyMap只限制TS接口写入，不运行时冻结，某工具配置失败会抛出而非跳过。
 */
export function createGrammarToolInputProperties(
	// 可缺省工具数组，缺省按空集合。
	tools: Tool[] | undefined,
	// 支持标记统一传给每项解析。
	supportsOpenAIGrammarTools: boolean,
	// 返回ReadonlyMap限制TS写操作，不冻结真实Map。
): ReadonlyMap<string, string> {
	// 创建本次独立name到属性名映射。
	const properties = new Map<string, string>();
	// ??只为undefined/null兜空数组，不修改输入列表。
	for (const tool of tools ?? []) {
		// 逐项解析，失败向外抛，非grammar/不支持返回undefined。
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		// 只有成功grammar描述才列映射。
		if (grammar) {
			// 同名后项覆盖前项，value只记录inputProperty。
			properties.set(tool.name, grammar.inputProperty);
		}
	}
	// 返回Map实例，不执行任何工具或请求模型。
	return properties;
}
