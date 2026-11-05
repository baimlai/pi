// 文件导读
// 所属：packages/chord 的根级工具模块，定义“严格 JSON”的值类型、复制函数与运行时判定。
// 职责边界：只处理纯数据（plain data）的 JSON 表示：普通对象、稠密普通数组、有限数字、字符串、布尔、null；
// 不处理 Date、Map、类实例、BigInt、undefined、symbol、循环引用、访问器属性或非枚举属性。上游是各层在把应用数据
// 写入文档/行列或比较之前调用；下游没有其他内部依赖。成功返回调用方独占、无别名的新树（copyJson）或布尔判定
// （isJsonValue）；违反严格 JSON 时抛 TypeError（复制）或返回 false（判定）。
// 能力清单：
// - JsonValue：严格 JSON 的递归联合类型。
// - JsonRepresentation<T>：把应用类型映射为 JSON 表示的条件类型；any/unknown 映射为 JsonValue。
// - CopyJsonOptions：复制选项，目前只有 omitUndefinedProperties。
// - copyJson：深拷贝并校验为严格 JSON，返回无别名的新树。
// - isJsonValue：运行时类型谓词，判断是否为严格 JSON（含环检测）。
// - DATA_DESCRIPTOR / defineData（私有）：复用属性描述符，把值定义为可枚举数据属性。
// - copy / check（私有）：递归实现复制与判定，共享祖先集合检测环。
// 组合与顺序：copyJson → copy（递归，数组与对象分支，finally 清理祖先集合）；isJsonValue → check（同样的遍历规则，
// 但不分配结果）。文档层通常先用 isJsonValue 判定，再用 copyJson 获取独立副本。
// 示例：`copyJson({ a: 1, b: [true, null] })` 返回同样形状的新对象；`copyJson({ n: NaN })` 抛 TypeError。
// 阅读顺序：先看 JsonValue 与 JsonRepresentation，再看 copyJson/copy 的数组与对象分支，最后看 check 与 defineData。

// 严格 JSON 的递归联合：对象分支用索引签名表示“任意字符串键都映射到 JsonValue”。
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// 编译期技巧：判断 T 是否为 any。`1 & any` 得到 any，而 `0 extends any` 为 true；
// 对其他类型 `1 & T` 不会让 0 可赋值。仅用于 JsonRepresentation 的分支选择，运行时不产生代码。
type IsAny<T> = 0 extends 1 & T ? true : false;

/** Strict-JSON representation of an application data type. Unknown payloads become JsonValue. */
// 条件类型（conditional type）逐层判断：
// 1. any 直接退化为 JsonValue，避免 any 在映射类型里扩散；
// 2. unknown 同样退化为 JsonValue（未知负载只能按任意 JSON 处理）；
// 3. 原始 JSON 标量原样保留；
// 4. readonly 数组用 infer TItem 取出元素类型，再递归映射为可变数组（JSON 没有 readonly 概念）；
// 5. 对象用映射类型逐个属性递归；可选属性保持可选，方法等非 JSON 形状会映射为 never 并暴露出来；
// 6. 其余（函数、symbol、bigint、undefined）映射为 never，表示不可表示。
// 只在编译期存在；运行时是否真的是 JSON 由 isJsonValue/copyJson 检查。
export type JsonRepresentation<T> = IsAny<T> extends true
	? JsonValue
	: unknown extends T
		? JsonValue
		: T extends null | boolean | number | string
			? T
			: T extends readonly (infer TItem)[]
				? JsonRepresentation<TItem>[]
				: T extends object
					? { [TKey in keyof T]: JsonRepresentation<T[TKey]> }
					: never;

// 复用的属性描述符模板：defineData 每次写入 value 后调用 defineProperty，再把 value 重置为 undefined。
// 复用避免为每个属性分配新对象；因为 defineProperty 会读取当时的字段值，之后修改模板不影响已定义的属性。
// 这是模块级可变对象，但只在同步的 defineData 中短暂使用，Node 单线程执行下不会交错。
const DATA_DESCRIPTOR: PropertyDescriptor = {
	value: undefined,
	writable: true,
	enumerable: true,
	configurable: true,
};

// 复制选项。`readonly` 只约束调用方不能通过该引用改字段；`?` 表示可省略。
export type CopyJsonOptions = {
	/** Omit undefined object properties while preserving strict array semantics. */
	// 为 true 时，对象中值为 undefined 的属性被跳过（而不是报错）；数组元素不受此选项影响，
	// 因为数组的 undefined 会破坏稠密性，仍按严格 JSON 拒绝。
	readonly omitUndefinedProperties?: boolean;
};

/** Copy a value into an alias-free strict-JSON tree owned by the caller. */
// 把任意值复制成调用方独占的严格 JSON 树。输入 unknown，输出 JsonValue；不会与输入共享对象/数组引用。
// 副作用：无（只分配新对象）；错误：任何非严格 JSON 形状抛 TypeError。
// `options?.` 可选链处理未传选项；`=== true` 把 undefined/false 统一为 false。
// 示例：const copy = copyJson(original); 之后修改 copy 不会影响 original。
export function copyJson(value: unknown, options?: CopyJsonOptions): JsonValue {
	return copy(value, undefined, options?.omitUndefinedProperties === true);
}

// 递归复制/校验实现。ancestors 在第一层为 undefined，进入对象/数组后创建并共享同一个 Set 以检测环；
// omitUndefinedProperties 控制对象中 undefined 属性是跳过还是报错。
// 每层 finally 都会把当前值移出祖先集合，因此同一对象可以在不同分支重复出现（DAG 允许），只拒绝真正的环。
function copy(value: unknown, ancestors: Set<object> | undefined, omitUndefinedProperties: boolean): JsonValue {
	// 标量直接返回；null 必须先判断，因为 typeof null === "object"。
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	// 数字只接受有限值；NaN/Infinity 不是合法 JSON。
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		throw new TypeError("Value contains a non-finite number and is not strict JSON");
	}
	// 函数、symbol、undefined、bigint 都在这里被拒绝；模板字符串插入 typeof 说明具体类型。
	if (typeof value !== "object")
		throw new TypeError(`Value contains a non-JSON ${typeof value}; expected strict JSON`);
	// 惰性创建祖先集合：标量路径不会分配 Set。
	const active = ancestors ?? new Set<object>();
	if (active.has(value)) throw new TypeError("Value contains cycles and is not strict JSON");
	active.add(value);
	try {
		if (Array.isArray(value)) {
			// Indices plus `length` only: extra, symbol, and missing keys all change the count.
			// 原型必须是 Array.prototype（排除子类/跨 realm 数组），且自有键数必须正好是 length + 1（索引 + length）；
			// 稀疏数组、额外字符串键、symbol 键都会让数量不符。
			if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
				throw new TypeError("Value must contain strict JSON dense plain arrays");
			}
			// 预分配目标数组；随后逐索引写入，保证结果稠密。
			const result = new Array<JsonValue>(value.length);
			for (let index = 0; index < value.length; index++) {
				// getOwnPropertyDescriptor(value, index) 中数字会被转成字符串键。
				const descriptor = Object.getOwnPropertyDescriptor(value, index);
				// 必须是自有、可枚举、数据属性（"value" in descriptor 排除 getter/setter）。
				if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
					throw new TypeError("Value must contain strict JSON enumerable indexed data properties");
				}
				// 用 defineData 而不是赋值，避免触发原型 setter（数组原型虽无，但保持对象分支一致）。
				defineData(result, String(index), copy(descriptor.value, active, omitUndefinedProperties));
			}
			return result;
		}
		// 对象只接受普通对象：原型是 Object.prototype 或 null（Object.create(null) 也允许）。
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Value must contain strict JSON plain objects or arrays");
		}
		// 保留 null 原型语义；断言为字符串键记录，symbol 键在循环中拒绝。
		const result = Object.create(prototype) as Record<string, JsonValue>;
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key === "symbol") throw new TypeError("Value contains a symbol key and is not strict JSON");
			// 非空断言 `!`：键来自 ownKeys，描述符必定存在。
			const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
			// 访问器属性或不可枚举属性都不属于严格 JSON。
			if (!descriptor.enumerable || !("value" in descriptor)) {
				throw new TypeError("Value must contain strict JSON enumerable data properties");
			}
			// 可选的 undefined 省略：跳过该键（数组分支没有此豁免）。
			if (descriptor.value === undefined && omitUndefinedProperties) continue;
			defineData(result, key, copy(descriptor.value, active, omitUndefinedProperties));
		}
		return result;
	} finally {
		// 离开当前节点：允许兄弟分支再次遇到同一对象，但阻止回到祖先形成环。
		active.delete(value);
	}
}

// 把 value 定义为 target 上的可枚举数据属性。PropertyKey 是 string | number | symbol 的联合。
// 复用 DATA_DESCRIPTOR 后立即清空 value，避免模板长期持有数据引用；defineProperty 读取的是调用瞬间的值。
function defineData(target: object, key: PropertyKey, value: JsonValue): void {
	DATA_DESCRIPTOR.value = value;
	Object.defineProperty(target, key, DATA_DESCRIPTOR);
	DATA_DESCRIPTOR.value = undefined;
}

/** Return whether a value is finite strict JSON with plain objects and no cycles. */
// 运行时类型谓词 `value is JsonValue`：返回 true 时，调用方的 TypeScript 会把 value 收窄为 JsonValue。
// 这是真正的运行时校验（不是断言）；失败返回 false，不抛错。入口创建祖先集合，交给 check 递归。
// 示例：if (isJsonValue(input)) { /* input 在此分支被当作 JsonValue */ }
export function isJsonValue(value: unknown): value is JsonValue {
	return check(value, new Set<object>());
}

// 与 copy 规则一致但不分配结果：标量/有限数字为 true；数组要求普通原型、稠密、仅有字符串键且无环；
// 对象要求普通/null 原型、仅字符串键、全为可枚举数据属性且无环。
function check(value: unknown, ancestors: Set<object>): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	// 数字必须有限；NaN、±Infinity 返回 false。
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) {
		// 原型检查排除数组子类和跨 realm 数组。
		if (Object.getPrototypeOf(value) !== Array.prototype) return false;
		const keys = Reflect.ownKeys(value);
		// 键数必须等于 length + 1，且全部是字符串（数字索引在 ownKeys 中就是字符串）。
		if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) return false;
		// 先查环再登记；若已在本层祖先中，直接失败。
		if (ancestors.has(value)) return false;
		ancestors.add(value);
		try {
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				// 每个索引必须存在、可枚举、是数据属性，且元素自身也是严格 JSON。
				if (
					descriptor === undefined ||
					!descriptor.enumerable ||
					!("value" in descriptor) ||
					!check(descriptor.value, ancestors)
				) {
					return false;
				}
			}
			return true;
		} finally {
			// 无论成功失败都移出祖先，保证同一对象可出现在不同分支。
			ancestors.delete(value);
		}
	}
	// 到这里只剩对象/函数；typeof null 是 "object"，所以要单独排除 null（已在函数开头处理过标量 null，
	// 这里的检查同时覆盖防御性场景）。
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	// 只接受普通对象或 null 原型，排除 Date、Map、类实例等。
	if (prototype !== Object.prototype && prototype !== null) return false;
	if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		// getOwnPropertyDescriptors 一次取出所有描述符的值；再逐个检查可枚举、数据属性、递归合法。
		for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
			if (!descriptor.enumerable || !("value" in descriptor) || !check(descriptor.value, ancestors)) {
				return false;
			}
		}
		return true;
	} finally {
		ancestors.delete(value);
	}
}
