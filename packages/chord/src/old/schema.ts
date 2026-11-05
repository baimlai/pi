/*
 * 文件导读
 * ========
 * 所属：packages/chord/src/old 的 Chord v1 契约/校验辅助层（旧实现）。本文件把 JSON Schema 校验、规范化、
 * 规范化身份和保守结构子类型判断集中在一起，供契约绑定、输入规范化和状态校验共用。
 *
 * 职责边界：
 * - 负责：编译并缓存 schema 校验器；把值规范化为“默认值已填、未知字段已删”的形状；计算稳定哈希与规范化身份；
 *   判断一个 schema 是否结构上覆盖另一个 schema（fits）。
 * - 不负责：定义契约语义、绑定引用、跨进程传输。contract.ts 用 hash64/canonicalJson 生成契约指纹并用 fits 检查
 *   消费者与提供者是否兼容；host.ts 用 normalize/canonicalIdentity 规范化输入并判断对象地址；object.ts/remote.ts
 *   用 cleaned 在调用前裁剪参数；cell.ts/reload.ts 用 assertValid 校验状态迁移。
 *
 * 上游入口：契约定义（contract.ts 的 bind/coverage）、host 的 get/hold 输入处理、对象方法调用与状态写入。
 * 下游依赖：@earendil-works/pi-schema 的 compile（运行时校验器）与 ValidationError；errors.ts 的 invalid
 * （把失败包装成 ChordError，错误码 invalid，reason 由调用方给出：input/args/result/state）。
 * 结果与错误：isValid/deepEqual/fits 返回 boolean；normalize/cleaned 返回新值；assertValid 失败抛 ChordError。
 * schema 可能来自远端对端或应用定义，因此这些函数接受的 unknown 都按信任边界处理，运行时检查不可省略。
 *
 * 能力清单（按导出项）：
 * - `canonicalJson(value)`：对象键排序、丢弃 undefined 成员的规范 JSON 字符串。
 * - `hash64(text)`：非加密 64 位十六进制哈希（两条 FNV-1a 通道），只用于契约指纹。
 * - `deepEqual(a, b)`：先比引用，再比 canonicalJson 的相等判断（面向严格 JSON 值）。
 * - `isValid(schema, value)`：编译并缓存校验器后判断值是否合法。
 * - `assertValid(reason, what, schema, value)`：不合法时抛出 invalid，并带前三个 schema 错误。
 * - `normalize(schema, value, what)`：应用默认值、删除未知字段、再校验，返回新值。
 * - `cleaned(schema, value)`：只做深拷贝和未知字段删除，不填默认值、不校验。
 * - `canonicalIdentity(schema, value)`：去掉“等于 schema 默认值”的字段后的规范 JSON，用作地址身份。
 * - `fits(sub, sup)`：保守结构子类型判断：sub 接受的所有值是否都被 sup 接受。
 *
 * 组合关系与典型顺序：
 *   normalize = cloneData → withDefaults → cleanFrom → assertValid
 *   cleaned   = cloneData → cleanFrom
 *   canonicalIdentity = stripDefaults → canonicalJson
 *   fits 先剥离注解，再按 anyOf/const/enum/约束/type 逐层比较，最后进入 objectFits/arrayFits/functionFits。
 *
 * 示例（真实签名；schema 由 pi-schema 构建器生成）：
 *   const input = obj({ n: int({ default: 1 }) }, { open: true });
 *   normalize(input, {}, "input");                    // { n: 1 }
 *   cleaned(input, { n: 2, extra: true });            // { n: 2 }
 *   assertValid("input", "input", input, { n: "x" }); // 抛 ChordError invalid/input
 *   fits(int(), num());                               // true：整数也是数字
 *   fits(num(), int());                               // false：数字不一定是整数
 * 注意：normalize 的默认值填充和字段清理是两遍独立遍历；cleaned 不保证结果合法。
 *
 * 建议阅读顺序：先读 `canonicalJson`/`deepEqual`/`canonicalIdentity` 建立“稳定表示”的概念，再看
 * `validatorOf`/`isValid`/`assertValid`，然后读 `cloneData`/`cleanFrom`/`withDefaults` 的规范化流程，
 * 最后读 `fits` 与 objectFits/arrayFits/functionFits 的子类型规则。
 */
// pi-schema：compile 把 JSON Schema 编译成运行时 Validator；JsonSchema/ValidationError/Validator 只是类型。
import { compile, type JsonSchema, type ValidationError, type Validator } from "@earendil-works/pi-schema";
// invalid 构造 ChordError（code 固定为 invalid，reason 表明失败发生在 input/args/result/state 哪个阶段）。
import { type ChordErrorReason, invalid } from "./errors.ts";

// 本文件内部使用的宽松 schema 形状：任何对象都当作 JSON Schema 读取；真正的合法性由 pi-schema 编译时检查。
/** JSON Schema as data: pi-schema builders, or any JSON Schema object (TypeBox's included). */
// 索引签名表示“任意字符串键 -> unknown”；readonly 只限制改写属性，不冻结运行时对象。
type Schema = { readonly [key: string]: unknown };

// asSchema 把 unknown 归一成可遍历的 schema 对象：false（拒绝一切）写成 { not: {} }，其余非对象写成 {}（接受一切）。
// 只在清理/填默认值一侧使用，不参与最终校验；最终校验仍用调用方传入的原始 schema。
const asSchema = (schema: unknown): Schema =>
	// 三元表达式按顺序判断：对象直接断言；严格等于 false 才转成拒绝；true/其它标量都视为空 schema。
	schema !== null && typeof schema === "object" ? (schema as Schema) : schema === false ? { not: {} } : {};

// canonicalJson：为哈希和相等判断提供稳定表示。与 JSON.stringify 的差异是对象键排序、undefined 成员被丢弃。
/** Canonical JSON: sorted object keys, `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
	// 标量/函数/symbol 交给 JSON.stringify；undefined 会得到 undefined，用 ?? "null" 归一为 JSON 的 null。
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	// 数组按顺序递归；元素为 undefined 时同样变成 null，与 JSON.stringify 的行为一致。
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	// Object.keys 只取自有可枚举字符串键；filter 删除值为 undefined 的成员，sort 默认按 UTF-16 码元排序。
	const keys = Object.keys(value)
		// 类型断言是因为 Object.keys 丢失了值的类型；这里只读不写。
		.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
		.sort();
	// 用模板字符串手写 JSON，而不是再 JSON.stringify：保证键顺序和 undefined 处理由本函数统一控制。
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

// hash64 不是密码学哈希：两条 FNV-1a 通道拼成 16 位十六进制。契约是可信输入，碰撞只要求“实际上不撞”。
/** Non-cryptographic 64-bit hash (two FNV-1a lanes). Contracts are trusted, so collisions are not an attack surface. */
export function hash64(text: string): string {
	// 第一条通道的 FNV-1a 初始偏移量。
	let a = 0x811c9dc5;
	// 第二条通道用不同素数混合，降低两条通道同时碰撞的概率；^ 是位异或。
	let b = 0x01000193 ^ 0x5bd1e995;
	// 逐 UTF-16 码元处理；charCodeAt 返回 0..65535 的整数。
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		// Math.imul 做 32 位整数乘法并保留低 32 位，避免 JavaScript 双精度乘法溢出丢失低位。
		a = Math.imul(a ^ code, 0x01000193);
		// 第二条通道额外右移 13 位混合；>>> 是无符号右移。
		b = Math.imul(b ^ code, 0x5bd1e995) ^ (b >>> 13);
	}
	// >>> 0 把结果转回无符号 32 位；toString(16) 后补齐 8 位，两段拼接即 64 位十六进制。
	return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

// deepEqual 面向严格 JSON 值：先走引用相等快路径，再用规范字符串比较；NaN 与 null 等非 JSON 值可能被视为相等。
export function deepEqual(a: unknown, b: unknown): boolean {
	return a === b || canonicalJson(a) === canonicalJson(b);
}

// WeakMap 以 schema 对象身份为键，缓存编译结果；对象被回收时条目自动消失，不会形成模块级强引用。
const validators = new WeakMap<object, Validator>();

// validatorOf：每个 schema 对象只 compile 一次；布尔 schema 不缓存（数量少且没有对象身份可作键）。
/** The compiled validator of `schema`, compiled once per schema object; `format` is an annotation. */
function validatorOf(schema: JsonSchema): Validator {
	// true/false schema 直接编译；compile 会读取整个 schema，之后 schema 再被修改不会反映到已编译校验器。
	if (typeof schema === "boolean") return compile(schema);
	// 先查缓存；get 返回 undefined 既表示未缓存，也可能是缓存值本身为 undefined（compile 不会返回 undefined）。
	let validator = validators.get(schema);
	if (validator === undefined) {
		validator = compile(schema);
		// 首次编译后写入弱缓存；后续同对象直接复用。
		validators.set(schema, validator);
	}
	return validator;
}

// isValid 是纯查询：不抛业务错误，只返回 boolean；schema 不合法时 compile 会抛错。
/** Whether `value` matches `schema`. */
export function isValid(schema: JsonSchema, value: unknown): boolean {
	return validatorOf(schema).check(value);
}

// assertValid：校验失败时把前三个错误拼成摘要，错误详情放在 details，方便日志和测试断言。
/** Throws `invalid` (with `reason`) and the first schema errors when `value` does not match. */
export function assertValid(reason: ChordErrorReason, what: string, schema: JsonSchema, value: unknown): void {
	// 编译/缓存校验器；编译失败属于 schema 定义错误，会直接抛出。
	const validator = validatorOf(schema);
	// 合法则直接返回；这是最常见的快路径。
	if (validator.check(value)) return;
	// errors 只在失败时构建；slice(0, 3) 限制摘要长度，避免巨大对象产生超长错误。
	const errors: ValidationError[] = validator.errors(value).slice(0, 3);
	// error.path 是 JSON Pointer，空串表示根值；空串用 "/" 代替，避免消息以空格开头。
	const summary = errors.map((error) => `${error.path || "/"} ${error.message}`).join("; ");
	// 统一抛 invalid；details 保留完整错误数组（不是截断后的三个）。
	throw invalid(reason, `${what}: ${summary}`, errors);
}

// normalize：输入规范化三步走——先深拷贝，再填默认值，再删未知字段，最后按原 schema 校验。
/** Applies defaults, strips unknown fields, validates. Returns a fresh value. */
export function normalize(schema: JsonSchema, value: unknown, what: string): unknown {
	// value ?? {} 把 null/undefined 当作空对象；asSchema 让布尔 schema 也能被遍历。返回值是全新对象。
	const normalized = cleanFrom(asSchema(schema), withDefaults(asSchema(schema), cloneData(value ?? {})));
	// 注意 reason 固定为 input：normalize 只用于入口输入；失败错误码因此总是 invalid/input。
	assertValid("input", what, schema, normalized);
	return normalized;
}

// cleaned：只裁剪和拷贝，不填默认值、不校验；调用方通常在之后单独 assertValid。
/** A copy of `value` with only what `schema` knows: unknown object fields dropped, recursively (TypeBox's `Clean`). */
export function cleaned(schema: JsonSchema, value: unknown): unknown {
	// cloneData 保证不修改调用方对象；cleanFrom 随后在这个副本上删除未知字段。
	return cleanFrom(asSchema(schema), cloneData(value));
}

// cloneData：只深拷贝纯数据（数组、普通对象、Uint8Array）；Date/Map 等其它对象按引用保留。
/** A deep copy of plain data: arrays, plain objects and bytes are copied, any other value is kept. */
function cloneData(value: unknown): unknown {
	// 数组逐元素递归；map 返回新数组，原数组不变。
	if (Array.isArray(value)) return value.map(cloneData);
	// 字节数组用 slice() 复制，避免共享底层 buffer。
	if (value instanceof Uint8Array) return value.slice();
	// 标量和 null 原样返回。
	if (value === null || typeof value !== "object") return value;
	// 读取原型以区分“普通对象”和类实例；类实例可能带有方法或内部槽，深拷贝会破坏语义。
	const prototype = Object.getPrototypeOf(value);
	// 非 Object.prototype/null 原型的对象按引用保留。
	if (prototype !== Object.prototype && prototype !== null) return value;
	const copy: Record<string, unknown> = {};
	// Object.entries 只遍历自有可枚举字符串键；逐值递归复制。
	for (const [key, item] of Object.entries(value)) copy[key] = cloneData(item);
	// 返回新的普通对象，原型是 Object.prototype。
	return copy;
}

// isPlainObject 是运行时形状判断：排除 null、数组和 Uint8Array，其余对象（包括类实例）仍会通过。
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array);

// isSchemaObject 只判断“非 null、非数组的对象”；schema 的语义合法性由 pi-schema 编译时负责。
const isSchemaObject = (value: unknown): value is Schema =>
	value !== null && typeof value === "object" && !Array.isArray(value);

// mergedAllOf 模拟 TypeBox 的 Evaluate：只有 allOf 的每个分支都带对象 properties 时才合并，否则放弃。
/** The object an `allOf` of object schemas evaluates to (TypeBox's `Evaluate`), or undefined for any other `allOf`. */
function mergedAllOf(schema: Schema): Schema | undefined {
	// 任一分支的 properties 不是对象就返回 undefined，让调用方按原 schema 处理。
	if (!Array.isArray(schema.allOf) || !schema.allOf.every((branch) => isSchemaObject(branch.properties)))
		// merged 只保留 properties/required/additionalProperties 三类信息；其它约束仍由原 schema 校验。
		return undefined;
	// 先收集属性，后面的分支覆盖同名属性（Object.assign 的后者优先）。
	const properties: Record<string, unknown> = {};
	// required 用 Set 去重，最后转回数组。
	const required = new Set<string>();
	// allOf 已确认是数组，这里断言成 Schema[] 以便逐项读取。
	for (const branch of schema.allOf as Schema[]) {
		// 合并属性：同名属性由后出现的分支覆盖；这是“评估后 schema”的近似，不是完整 allOf 求交。
		Object.assign(properties, branch.properties);
		// 每个分支的 required 并集；`as string[] | undefined` 只是读取时的类型断言，不校验内容。
		for (const key of (branch.required as string[] | undefined) ?? []) required.add(key);
	}
	// 返回新的对象 schema：unevaluatedProperties 若存在则映射为 additionalProperties。
	return {
		type: "object",
		properties,
		required: [...required],
		// 展开语法把 additionalProperties 条件性加入；undefined 时不添加该键。
		...(schema.unevaluatedProperties === undefined ? {} : { additionalProperties: schema.unevaluatedProperties }),
	};
}

// recordOf：把 pi-schema 的 map() 识别成“一个 patternProperties + 无 properties”的记录 schema。
/** The pattern and value schema of a record (`patternProperties` with one pattern). */
function recordOf(schema: Schema): [RegExp, unknown] | undefined {
	// 必须同时满足 patternProperties 是对象、properties 不是对象；否则不是记录形状。
	if (!isSchemaObject(schema.patternProperties) || isSchemaObject(schema.properties)) return undefined;
	// 只取第一条 pattern；多 pattern 的记录不在这里建模，交给调用方按原 schema 处理。
	const [entry] = Object.entries(schema.patternProperties);
	// 没有 pattern 时返回 undefined；RegExp 的 u 标志让 Unicode 码点匹配更符合 JSON 字段名习惯。
	return entry === undefined ? undefined : [new RegExp(entry[0], "u"), entry[1]];
}

// keepsUnknown 判断 additionalProperties 是否允许保留某个未知字段：true 全允许，schema 则再校验该值。
/** Whether `additional` (an object's `additionalProperties`) keeps an unknown field holding `value`. */
// additional === true 是常见快路径；对象 schema 用 isValid 做递归判断。
const keepsUnknown = (additional: unknown, value: unknown): boolean =>
	additional === true || (isSchemaObject(additional) && isValid(additional, value));

// cleanFrom 递归删除 schema 不认识的字段；调用方必须传入可修改的副本（normalize/cleaned 已经 cloneData）。
// Mutates `value` (a fresh copy), as TypeBox's `Clean` does.
function cleanFrom(schema: Schema, value: unknown): unknown {
	// allOf 形状先合并成等价对象 schema，再继续清理；合并失败时 merged 为 undefined。
	const merged = mergedAllOf(schema);
	if (merged !== undefined) return cleanFrom(merged, value);
	// anyOf：逐个分支尝试清理，返回第一个“清理后仍合法”的候选；顺序会影响选中的分支。
	if (Array.isArray(schema.anyOf)) {
		for (const branch of schema.anyOf) {
			// 每个分支都在新副本上试，失败/不合法不会污染原值或其它分支。
			const candidate = cleanFrom(asSchema(branch), cloneData(value));
			// 分支合法才采用；如果所有分支都不合法，退回未清理的原值。
			if (isValid(asSchema(branch), candidate)) return candidate;
		}
		// 没有分支匹配时返回原值；最终合法性仍由调用方的 assertValid 决定。
		return value;
	}
	// 数组：先处理元组（items 数组或 prefixItems），再处理统一 items。
	if (Array.isArray(value)) {
		// Array.isArray(schema.items) 是 draft-7 的元组写法；prefixItems 是 2020-12 写法。
		const prefix = Array.isArray(schema.items)
			? schema.items
			: Array.isArray(schema.prefixItems)
				? schema.prefixItems
				: undefined;
		// 有前缀 schema 时，只清理前 prefix.length 个元素。
		if (prefix !== undefined) {
			// 取两者较短长度，避免访问不存在的 schema 或元素。
			const length = Math.min(value.length, prefix.length);
			// 逐位置递归清理；prefix[index] 可能是 undefined，asSchema 会把它当成空 schema。
			for (let index = 0; index < length; index++) value[index] = cleanFrom(asSchema(prefix[index]), value[index]);
			// 超出元组长度的元素被截断；这是 Clean 的语义：元组 schema 不接受额外元素。
			return value.length > length ? value.slice(0, length) : value;
		}
		// 统一 items：对每个元素应用同一个 schema，返回新数组。
		if (isSchemaObject(schema.items)) return value.map((item) => cleanFrom(schema.items as Schema, item));
		return value;
	}
	// 非普通对象（Date、Map、类实例等）不清理字段，原样返回。
	if (!isPlainObject(value)) return value;
	// 记录 schema（map）：所有匹配 pattern 的键共享一个值 schema。
	const record = recordOf(schema);
	// properties 只接受对象形状；数组/标量视为“没有具名属性”。
	const properties = isSchemaObject(schema.properties) ? schema.properties : undefined;
	// An object schema names its fields, a record its key pattern, a map (pi-schema's) its value schema.
	// 既没有 properties、没有 record、也没有 additionalProperties schema 时，无法判断哪些键“已知”，保留原值。
	if (properties === undefined && record === undefined && !isSchemaObject(schema.additionalProperties)) return value;
	// 遍历自有可枚举键；循环中 delete 当前键是安全的，Object.keys 已经生成快照数组。
	for (const key of Object.keys(value)) {
		// Object.hasOwn 避免把原型链上的同名属性误认为 schema 属性。
		const known = properties !== undefined && Object.hasOwn(properties, key) ? properties[key] : undefined;
		// 优先具名属性；否则尝试记录 pattern；`??` 只在左侧为 undefined/null 时回退。
		const matched = known ?? (record?.[0].test(key) ? record[1] : undefined);
		// 命中已知 schema：递归清理该值。
		if (matched !== undefined) value[key] = cleanFrom(asSchema(matched), value[key]);
		// 否则看 additionalProperties：true 或匹配其 schema 时保留并递归清理。
		else if (keepsUnknown(schema.additionalProperties, value[key]))
			value[key] = cleanFrom(asSchema(schema.additionalProperties), value[key]);
		// 其余未知字段直接删除。
		else delete value[key];
	}
	return value;
}

// withDefaults 模拟 TypeBox 的 Default：缺失值取 schema 默认值；缺失的可选字段不会凭空补默认值。
// Mutates `value` (a fresh copy), as TypeBox's `Default` does: a missing value takes its schema's default, a
// missing optional field never does.
function withDefaults(schema: Schema, value: unknown): unknown {
	// 顶层值缺失且 schema 声明 default 时，深拷贝默认值；cloneData 防止多个结果共享同一默认对象。
	const defaulted = value === undefined && "default" in schema ? cloneData(schema.default) : value;
	// allOf 合并后的属性集合用于继续填默认值。
	const merged = mergedAllOf(schema);
	if (merged !== undefined) return withDefaults(merged, defaulted);
	// anyOf：对每个分支尝试填默认值，返回第一个合法候选；都不合法则保留原值。
	if (Array.isArray(schema.anyOf)) {
		for (const branch of schema.anyOf) {
			const candidate = withDefaults(asSchema(branch), cloneData(defaulted));
			if (isValid(asSchema(branch), candidate)) return candidate;
		}
		return defaulted;
	}
	// 数组：同样优先元组前缀，再处理统一 items。
	if (Array.isArray(defaulted)) {
		const prefix = Array.isArray(schema.items)
			? schema.items
			: Array.isArray(schema.prefixItems)
				? schema.prefixItems
				: undefined;
		if (prefix !== undefined) {
			// 遍历整个 prefix，而不是只遍历已有元素；这样“缺少的必填前缀项”也能拿到默认值。
			for (let index = 0; index < prefix.length; index++) {
				// item 为 undefined 且索引超出原数组长度时，不写入，避免产生 undefined 占位。
				const item = withDefaults(asSchema(prefix[index]), defaulted[index]);
				// 条件含义：仍在原数组内，或该位置确实产生了默认值，才赋值。
				if (index < defaulted.length || item !== undefined) defaulted[index] = item;
			}
			return defaulted;
		}
		// 统一 items：对每个已有元素应用默认值。
		if (isSchemaObject(schema.items)) return defaulted.map((item) => withDefaults(schema.items as Schema, item));
		return defaulted;
	}
	// 非普通对象原样返回；与 cleanFrom 相同的边界。
	if (!isPlainObject(defaulted)) return defaulted;
	// properties 与 record 的识别规则与 cleanFrom 一致。
	const properties = isSchemaObject(schema.properties) ? schema.properties : undefined;
	const record = recordOf(schema);
	// 具名属性：读取 required 列表，只给“必填且有 default”的缺失属性补值。
	if (properties !== undefined) {
		const required = (schema.required as string[] | undefined) ?? [];
		// 属性 schema 可能缺失，asSchema 会当作空对象。
		for (const [key, property] of Object.entries(properties)) {
			// item 为 undefined 时，只有“该字段必填且带 default”才继续；可选字段缺失永远不会被填默认值。
			const item = withDefaults(asSchema(property), defaulted[key]);
			// 写入默认值（或递归处理后的值）。
			if (item === undefined && (!required.includes(key) || !("default" in asSchema(property)))) continue;
			defaulted[key] = item;
		}
		// 记录 schema：只有值 schema 是对象且自带 default 时才处理匹配的键。
	} else if (record !== undefined && isSchemaObject(record[1]) && "default" in record[1]) {
		for (const key of Object.keys(defaulted)) {
			// 只处理匹配 pattern 的键；其它键留给 additionalProperties 逻辑。
			if (record[0].test(key)) defaulted[key] = withDefaults(record[1], defaulted[key]);
		}
	}
	// 若 additionalProperties 不是 schema，就无法继续递归；直接返回当前结果。
	if (!isSchemaObject(schema.additionalProperties)) return defaulted;
	for (const key of Object.keys(defaulted)) {
		// known 判断键是否被 properties 声明；record pattern 命中的键不在这里处理。
		const known = properties !== undefined && Object.hasOwn(properties, key);
		// 只有既非具名属性、也非记录键的未知字段才应用 additionalProperties 的默认值。
		if (!known && !record?.[0].test(key)) defaulted[key] = withDefaults(schema.additionalProperties, defaulted[key]);
	}
	return defaulted;
}

// canonicalIdentity：把“等于默认值”的字段视为可省略，再做规范 JSON；用于判断两个输入是否指向同一对象地址。
/** Canonical identity of a normalized value: fields equal to their schema default are omitted. */
export function canonicalIdentity(schema: JsonSchema, value: unknown): string {
	// stripDefaults 不修改 value（对象分支新建 result），随后 canonicalJson 生成稳定字符串。
	return canonicalJson(stripDefaults(asSchema(schema), value));
}

// stripDefaults：递归删除等于 schema default 的对象字段；数组只递归、不删除元素。
function stripDefaults(schema: Schema, value: unknown): unknown {
	// 数组：items 是数组时按位置匹配 schema，否则所有元素共用同一 schema。
	if (Array.isArray(value)) {
		const items = schema.items;
		if (Array.isArray(items)) return value.map((item, index) => stripDefaults(asSchema(items[index]), item));
		return value.map((item) => stripDefaults(asSchema(items), item));
	}
	// 标量和 null 原样返回。
	if (value === null || typeof value !== "object") return value;
	// 缺失 properties 时 asSchema(undefined) 得到 {}；后续按键查找属性 schema 会得到空对象。
	const properties = asSchema(schema.properties);
	// 新对象只包含“不等于默认值”的字段。
	const result: Record<string, unknown> = {};
	// 逐字段读取原值。
	for (const [key, item] of Object.entries(value)) {
		// properties[key] 可能是 undefined（未知字段），asSchema 归一为空 schema。
		const property = asSchema(properties[key]);
		// 属性声明了 default 且当前值深等于默认值时跳过该字段；deepEqual 用规范 JSON 比较。
		if ("default" in property && deepEqual(property.default, item)) continue;
		// 其余字段递归处理；未知字段会保留（其 schema 为空对象）。
		result[key] = stripDefaults(property, item);
	}
	return result;
}

// fits 只对这些关键字做“精确相等”比较；任何一方更强/更弱都不算覆盖，这是保守策略。
// as const 保留每个字符串的字面量类型，同时让数组本身只读。
const CONSTRAINTS = [
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
] as const;

// typesOf 把 type 统一成 string[]：字符串包装成单元素数组，数组原样使用，缺失或其它形状返回 undefined。
const typesOf = (schema: Schema): string[] | undefined =>
	typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? (schema.type as string[]) : undefined;

// KNOWN 是 fits 能推理的关键字集合；出现集合外的校验关键字时，fits 退回“必须完全相同”。
/** Keywords `fits` reasons about. Any other validation keyword in the provider's schema forces exact equality. */
const KNOWN: ReadonlySet<string> = new Set([
	// 展开 CONSTRAINTS，避免重复列出；Set 的查找是 O(1)。
	...CONSTRAINTS,
	"type",
	"properties",
	"required",
	"additionalProperties",
	"patternProperties",
	"items",
	"additionalItems",
	"const",
	"enum",
	"anyOf",
	// function schema 的两个关键字也在这里建模，供 functionFits 使用。
	"parameters",
	"returnType",
]);

// ANNOTATIONS 不影响值的合法性，比较前统一剥离，避免 title/description 等差异造成误判。
/** Annotations: no effect on validity. */
const ANNOTATIONS: ReadonlySet<string> = new Set([
	"title",
	"description",
	"default",
	"examples",
	"$id",
	"$schema",
	"$comment",
	"readOnly",
	"writeOnly",
	"deprecated",
]);

// Object.fromEntries + filter 生成去掉注解的新对象；不修改原 schema。
const withoutAnnotations = (schema: Schema): Schema =>
	Object.fromEntries(Object.entries(schema).filter(([key]) => !ANNOTATIONS.has(key)));

// fits 是保守结构子类型：只证明“sub 合法 ⇒ sup 合法”；不能证明时一律返回 false。
// sub 与 sup 都来自 unknown（可能是远端契约），因此这里每一层都做运行时形状判断。
/**
 * Conservative structural subtyping: true only if every value valid under `sub` is valid under `sup`, where object
 * fields missing from `sub` but optional in `sup` count as fine (unknown fields are stripped at the provider, see
 * `RecordImpl.call`). A provider schema using a keyword this function does not model (`not`, `allOf`, `contains`,
 * `$ref`, ...) or an `additionalProperties` schema only fits an identical consumer schema.
 */
// 先剥离注解，再转成可遍历对象；布尔 schema 会被 asSchema 归一化。
export function fits(subSchema: unknown, supSchema: unknown): boolean {
	const sub = withoutAnnotations(asSchema(subSchema));
	const sup = withoutAnnotations(asSchema(supSchema));
	// 空 sup（{}）接受一切，因此任何 sub 都覆盖它。
	if (Object.keys(sup).length === 0) return true;
	// 完全相同的 schema 直接通过；deepEqual 基于规范 JSON。
	if (deepEqual(sub, sup)) return true;
	// sup 使用 fits 未建模的校验关键字（not/allOf/contains/$ref 等）时，只有“完全相同”才能保证覆盖。
	if (Object.keys(sup).some((key) => !KNOWN.has(key))) return false;
	// additionalProperties 为对象 schema 时规则复杂，fits 只在完全相同时接受（前面已检查 deepEqual）。
	if (sup.additionalProperties !== undefined && typeof sup.additionalProperties !== "boolean") return false;
	// sub 是 anyOf：每个分支都必须覆盖 sup，才能保证所有可能值都覆盖。
	if (Array.isArray(sub.anyOf)) return sub.anyOf.every((branch) => fits(branch, sup));
	// sup 是 anyOf：只要有一个分支能接住 sub 即可。
	if (Array.isArray(sup.anyOf)) return sup.anyOf.some((branch) => fits(sub, branch));
	// sup 是 const：sub 也必须 const 且值相等，否则 sub 可能产生别的值。
	if ("const" in sup) return "const" in sub && deepEqual(sub.const, sup.const);
	// sup 是 enum：枚举 sub 可能产生的值（const 或 enum），要求全部落在 sup.enum 中。
	if (Array.isArray(sup.enum)) {
		// const 优先于 enum；两者都没有时 values 为 undefined，下面 ?? false 返回 false。
		const values = "const" in sub ? [sub.const] : Array.isArray(sub.enum) ? sub.enum : undefined;
		// every + some 是双重循环：sub 的每个值都要在 sup.enum 中找到相等项。
		return values?.every((item) => (sup.enum as unknown[]).some((allowed) => deepEqual(allowed, item))) ?? false;
	}
	// 约束关键字必须精确相等；即使 sub 更严格（例如更小 maxLength）也拒绝，避免声称未证明的覆盖。
	for (const key of CONSTRAINTS) if (key in sup && !deepEqual(sub[key], sup[key])) return false;
	// 读取双方的 type；没有显式 type 时无法推理，直接返回 false。
	const supTypes = typesOf(sup);
	const subTypes = typesOf(sub);
	// 任一方缺少 type 都拒绝；这比“隐式 any”更保守。
	if (supTypes === undefined || subTypes === undefined) return false;
	// sub 的每种 type 都必须被 sup 接受；integer 是 number 的子集，所以 integer 可以覆盖 number 的要求。
	if (!subTypes.every((type) => supTypes.includes(type) || (type === "integer" && supTypes.includes("number")))) {
		return false;
	}
	// sub 已经限定为单个 const 或有限 enum，且值/约束/type 都已检查过，无需再比较对象/数组结构。
	if ("const" in sub || Array.isArray(sub.enum)) return true;
	// 对象类型进入 objectFits，逐属性比较。
	if (subTypes.includes("object") && !objectFits(sub, sup)) return false;
	// 数组类型进入 arrayFits，按 items 形状比较。
	if (subTypes.includes("array") && !arrayFits(sub, sup)) return false;
	// 函数类型进入 functionFits，参数逆变、返回值协变。
	if (subTypes.includes("function")) return functionFits(sub, sup);
	return true;
}

// objectFits：对象子类型规则。缺失但可选的 sup 属性不算问题；未知字段会在 provider 端被裁掉。
function objectFits(sub: Schema, sup: Schema): boolean {
	// asSchema 让缺失的 properties 变成空对象，后续 in/Object.entries 都能安全工作。
	const subProperties = asSchema(sub.properties);
	const supProperties = asSchema(sup.properties);
	// sub 的 required 转成 Set，便于 O(1) 判断。
	const subRequired = new Set((sub.required as string[] | undefined) ?? []);
	// sup 要求的每个字段，sub 也必须要求；否则 sub 可能省略 sup 必需的字段。
	for (const key of (sup.required as string[] | undefined) ?? []) if (!subRequired.has(key)) return false;
	// 逐个检查 sup 声明的属性。
	for (const [key, property] of Object.entries(supProperties)) {
		// sub 显式声明了同名字段：递归比较值 schema。
		if (key in subProperties) {
			// 不覆盖则整个对象不覆盖；fits 是保守判断。
			if (!fits(subProperties[key], property)) return false;
			// sub 没声明该字段，但它的 additionalProperties 是 schema：未知名字可能带这个属性，其值也必须覆盖。
		} else if (typeof sub.additionalProperties === "object" && !fits(sub.additionalProperties, property)) {
			// The consumer may send this name with any value its `additionalProperties` allows. Open consumer objects
			// are fine: unknown names are stripped with the consumer's own schema before the call (`RecordImpl.call`).
			// 因此返回 false。
			return false;
		}
	}
	// sup 关闭了额外字段：sub 也必须关闭，并且不能声明 sup 没有的属性名。
	if (sup.additionalProperties === false) {
		// sub 若开放 additionalProperties，就可能发送 sup 不认识的字段。
		if (sub.additionalProperties !== false) return false;
		// sub 的具名属性也必须全部出现在 sup.properties 中。
		if (Object.keys(subProperties).some((key) => !(key in supProperties))) return false;
	}
	// sup 的 patternProperties：每个匹配模式的值都必须被约束，且 sub 不能任意开放额外名字。
	const supPatterns = asSchema(sup.patternProperties);
	// 只有 sup 真的声明了 pattern 才进入这段复杂规则。
	if (Object.keys(supPatterns).length > 0) {
		// Every value the consumer may put under a matching name must fit, and the consumer must not allow arbitrary
		// extra names (it would then allow any value under a matching one).
		// sub 的 patternProperties；缺失时 asSchema 给空对象。
		const subPatterns = asSchema(sub.patternProperties);
		// sub 既没有关闭 additionalProperties、又没有 pattern，说明它可以放任意额外字段，无法保证匹配 sup 的 pattern。
		if (sub.additionalProperties !== false && Object.keys(subPatterns).length === 0) return false;
		// 逐个 sup pattern 检查。
		for (const [pattern, property] of Object.entries(supPatterns)) {
			// 把 pattern 编译成正则；u 标志与 pi-schema 的匹配语义保持一致。
			const matcher = new RegExp(pattern, "u");
			// 检查 sub 中所有“未被 sup.properties 具名覆盖”且匹配该 pattern 的属性。
			for (const [key, subProperty] of Object.entries(subProperties)) {
				// 这些属性的值 schema 必须覆盖 sup 的 pattern 值 schema。
				if (!(key in supProperties) && matcher.test(key) && !fits(subProperty, property)) return false;
			}
			// 如果 sub 自己也声明了 patternProperties，同名 pattern 必须存在且值 schema 覆盖；
			if (
				// 多个条件用 &&/|| 组合：没有 sub pattern 时跳过；有则要求同名且覆盖。
				Object.keys(subPatterns).length > 0 &&
				(!(pattern in subPatterns) || !fits(subPatterns[pattern], property))
			) {
				return false;
			}
		}
		// sub 多出来的 pattern 在 sup 中不存在：sub 可能产生 sup 未约束的字段，拒绝。
		for (const pattern of Object.keys(subPatterns)) if (!(pattern in supPatterns)) return false;
	}
	return true;
}

// arrayFits：数组/元组的覆盖规则。
function arrayFits(sub: Schema, sup: Schema): boolean {
	// sup 是元组（items 为数组）：sub 也必须是同长度元组，且逐位置覆盖。
	if (Array.isArray(sup.items)) {
		// 长度不同或 sub 不是元组都拒绝；元组位置语义无法用统一 items 表达。
		if (!Array.isArray(sub.items) || sub.items.length !== sup.items.length) return false;
		// every 按索引比较；断言 sup.items 为 unknown[] 只为消除类型收窄后的联合。
		return sub.items.every((item, index) => fits(item, (sup.items as unknown[])[index]));
	}
	// sup 是统一 items，sub 是元组：元组的每个位置都必须覆盖 sup.items。
	if (Array.isArray(sub.items)) return sub.items.every((item) => fits(item, sup.items));
	// 双方都是统一 items（或缺失）：直接比较两个 items schema；undefined 会被 asSchema 当成 {}。
	return fits(sub.items, sup.items);
}

// functionFits：函数覆盖规则，参数逆变、返回值协变。
function functionFits(sub: Schema, sup: Schema): boolean {
	// parameters 缺失视为空数组；类型断言只用于读取数组元素。
	const subParameters = (sub.parameters as unknown[] | undefined) ?? [];
	const supParameters = (sup.parameters as unknown[] | undefined) ?? [];
	// sub 接受的参数不能比 sup 多；sup 可能只传更少的参数。
	// A function accepting fewer parameters is fine; each shared parameter is contravariant.
	// 参数更多时，多出的参数 sub 可能要求必填，而 sup 不会提供，因此拒绝。
	if (subParameters.length > supParameters.length) return false;
	// 逆变：sup 可能传入的参数类型必须能被 sub 接受，所以用 fits(sup 参数, sub 参数)。
	if (!subParameters.every((parameter, index) => fits(supParameters[index], parameter))) return false;
	// 返回值协变：sub 返回的值必须能被 sup 的返回类型接受。
	return fits(sub.returnType, sup.returnType);
}
