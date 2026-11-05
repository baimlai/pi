/*
 * 文件导读
 * ========
 * 所属：packages/chord/src/delta，Chord 共享的 Delta 模块。
 *
 * 职责边界：本文件只检查“不可变副本的一份 revision 是不是严格 JSON”，不做复制、冻结、diff 或应用操作。
 * 它校验的结构规则包括：容器只能是纯对象或数组；数组必须稠密；对象只能有可枚举的自有数据属性；
 * 不允许 symbol 键、访问器、undefined、非有限数字或环。
 *
 * 上游入口：持有副本完整 revision 的消费方可以调用 `validate(value)`。当前 src 中没有调用点，
 * `delta/index.ts` 也没有重新导出它；它是独立工具（bench 把它列为待测源码），不要误以为
 * `applyImmutable` 会自动调用它。Delta 的其他入口默认信任调用方提供的严格 JSON。
 * 下游依赖/结果：只依赖 `../json.ts` 的 `JsonValue` 类型；成功时原样返回同一个值（同引用），
 * 失败时抛 `TypeError`，由调用方决定是丢弃该 revision 还是断开连接。
 *
 * 能力清单：
 * - `JsonRevisionValidator`：带跨 revision 缓存的校验器类。
 *   - `validate<T extends JsonValue>(value: T): T`：校验整棵值并返回原值；每次调用重置“本次路径”状态。
 *   - 私有 `#validate`：递归实现，按容器身份跳过历史已校验部分，并检测环。
 * 文件内辅助（未导出）：
 *   - `isContainer`：运行时的标量/容器类型谓词。
 *   - `assertPrimitive`：拒绝非严格 JSON 标量。
 *   - `assertPlainObject`：要求 Object.prototype 或 null 原型。
 *   - `assertDenseArray`：要求稠密数组且下标都是已定义的数据属性。
 *
 * 组合关系与典型顺序：创建校验器 -> `validate(snapshot)` -> 把返回值交给后续消费逻辑；
 * 下一份 revision 可复用同一校验器，已校验容器会命中 `#validated` 缓存。错误不会缓存失败结果，
 * 同一非法值再次校验仍会重新报错。
 *
 * 示例（描述真实签名）：
 *   const validator = new JsonRevisionValidator();
 *   const revision = JSON.parse('{"rows":[{"id":1}]}') as JsonValue;
 *   const checked: JsonValue = validator.validate(revision); // 返回同一个对象
 *   validator.validate({ rows: checked.rows });              // rows 已校验过，直接跳过
 *   validator.validate({ x: undefined as never });           // TypeError：不是严格 JSON
 *
 * 性能设计：容器按对象身份记入 `#validated` WeakSet，后续 revision 复用同一容器时直接跳过，
 * 校验成本与“新出现的容器数量”相关，而不是每次 revision 整棵树的节点数。这个缓存假设 revision
 * 不可变：若调用方在通过校验后又修改了容器，缓存不会察觉。
 *
 * 建议阅读顺序：先读类注释与 `validate` 的入口流程，再读 `#validate` 的数组/对象两个分支，
 * 最后读三个 assert 辅助函数，它们对应错误消息里的具体规则。
 */
import type { JsonValue } from "../json.ts";

// 这里把“可能是容器的 JSON 值”收窄为数组或普通对象两种类型。
// 注意：`Record<string, JsonValue>` 与数组在 TypeScript 结构类型上可能重叠，编译器接受这个联合；
// 运行时的真正区分靠后面的 `Array.isArray` 和原型检查。
type JsonContainer = JsonValue[] | Record<string, JsonValue>;

// 类型谓词 `value is JsonContainer`：如果函数返回 true，调用方类型收窄为容器。
// 实现只检查 `typeof value === "object" && value !== null`，因此函数、Date 等对象也会通过这里，
// 它们稍后会被 `assertPlainObject` 或 `assertDenseArray` 拒绝。
const isContainer = (value: JsonValue): value is JsonContainer => typeof value === "object" && value !== null;

/** Validates immutable replica revisions while skipping containers validated in earlier revisions. */
/**
 * 校验不可变副本 revision 的严格 JSON 结构，并跳过之前 revision 已经校验过的容器。
 *
 * 用法示例（描述行为，不是文件内实际调用）：
 *   const validator = new JsonRevisionValidator();
 *   const revision = JSON.parse('{"rows":[{"id":1}]}');
 *   const checked = validator.validate(revision); // 返回同一对象；非法输入抛 TypeError
 *   validator.validate({ rows: checked.rows });    // rows 容器已校验过，直接跳过
 *
 * 输入：任意声明为 JsonValue 的值。运行时不信任类型注解，所以会实地检查每个容器。
 * 输出：校验通过的同一个值（不做深拷贝）。
 * 错误：`TypeError`，消息说明违反的规则；不返回错误码。
 * 副作用：把已校验容器记入 `#validated` WeakSet；该缓存不阻止容器被垃圾回收。
 * 主要流程：标量直接检查；容器先查缓存，再检查原型/稠密性，然后递归子值，最后写入缓存。
 */
export class JsonRevisionValidator {
	// `#` 开头的私有字段只在类内部可见；WeakSet 保存对象身份，容器被外部释放后条目可被 GC。
	// 这里的缓存假设 revision 是不可变的：同一个容器在后续 revision 中仍被复用，就无需重复校验。
	readonly #validated = new WeakSet<object>();

	/**
	 * 校验一份完整 revision，返回同一个值。
	 *
	 * 每次调用都新建两个临时集合：
	 * - `ancestors`：记录当前递归路径上的容器，用来发现环；
	 * - `finished`：记录本次调用中已经处理完的容器，用来在共享子树（DAG）上避免重复遍历。
	 * 这两个集合只属于本次调用，不跨调用保存；跨调用的复用由 `#validated` 负责。
	 *
	 * 例子：`validate({ a: { b: 1 } })` 返回原对象；同一个对象再次传入时根节点已在 `#validated` 中，直接返回。
	 */
	validate<T extends JsonValue>(value: T): T {
		// 泛型 `T extends JsonValue` 让调用方保留更具体的类型；`as T` 只是因为内部递归签名统一写成了 JsonValue，
		// 校验不会改变值，所以这个断言是安全的。
		return this.#validate(value, new Set<object>(), new WeakSet<object>()) as T;
	}

	/**
	 * 递归校验单个值。
	 *
	 * 输入：待检查的 `value`，以及本次校验路径集合 `ancestors`、已完成集合 `finished`。
	 * 输出：校验通过时返回原值（标量或容器）。
	 * 错误：含环、非纯对象、稀疏/带额外属性的数组、symbol 键、访问器/不可枚举属性或非严格 JSON 标量时抛 TypeError。
	 * 副作用：把容器写入 `#validated` 与 `finished`；临时修改 `ancestors`，并在 finally 中恢复。
	 */
	#validate(value: JsonValue, ancestors: Set<object>, finished: WeakSet<object>): JsonValue {
		// 标量没有子结构，直接交给 assertPrimitive 检查（有限数字、null、字符串、布尔）。
		// 已经在历史 revision 中校验过的容器也直接返回，跳过整棵子树。
		// 三元表达式的两个分支都返回“原值”，但类型不同：容器走 `value`，标量走断言函数的返回值。
		if (!isContainer(value) || this.#validated.has(value)) return isContainer(value) ? value : assertPrimitive(value);
		// 本次调用中已经处理完的容器（例如两个字段指向同一对象）无需再走一遍；它也可能正处于祖先路径上，
		// 这种情况由下一行的 ancestors 检查单独报错。
		if (finished.has(value)) return value;
		// 如果容器已经在当前递归路径上出现，说明存在环（A 引用 B，B 又引用 A）。
		if (ancestors.has(value)) throw new TypeError("Replicated state cannot contain cycles");
		// 进入容器：先登记到当前路径，确保子值递归时能发现指回自己的引用。
		ancestors.add(value);
		try {
			// 数组与对象分开校验：数组要求稠密且只有下标数据属性，对象要求纯对象且只有可枚举数据属性。
			if (Array.isArray(value)) {
				assertDenseArray(value);
				// 逐个下标递归；`value[index]!` 的非空断言告诉编译器“这里一定存在值”，
				// 稠密性刚由 assertDenseArray 保证，因此运行时不会取到 undefined。
				for (let index = 0; index < value.length; index++) this.#validate(value[index]!, ancestors, finished);
			} else {
				assertPlainObject(value);
				// Reflect.ownKeys 返回所有自有键，包括不可枚举键和 symbol；这与 Object.keys 不同，
				// 正好可以拒绝“藏在不可枚举属性或 symbol 里的状态”。
				for (const key of Reflect.ownKeys(value)) {
					if (typeof key === "symbol") throw new TypeError("Replicated state cannot contain symbol properties");
					// 取属性描述符后检查三点：存在、可枚举、是数据属性（`"value" in descriptor` 排除 getter/setter）。
					const descriptor = Object.getOwnPropertyDescriptor(value, key);
					if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
						throw new TypeError("Replicated state objects must contain enumerable data properties");
					}
					// 描述符经过上面的检查已收窄为数据属性，`descriptor.value` 可以读取；
					// 类型上仍是 unknown，所以断言为 JsonValue 再递归（运行时会继续严格检查）。
					this.#validate(descriptor.value as JsonValue, ancestors, finished);
				}
			}
			// 整棵子树通过后，登记到本次调用与跨调用缓存中；后续 revision 可以直接复用。
			finished.add(value);
			this.#validated.add(value);
			return value;
		} finally {
			// 无论成功还是抛错，都要把当前容器从祖先路径移除，避免把“兄弟子树”误判成环。
			// 注意：抛错时该容器不会写入 #validated，下次调用仍会重新校验它。
			ancestors.delete(value);
		}
	}
}

/**
 * 检查标量是否为严格 JSON 值，并原样返回。
 *
 * 输入：unknown，因为调用时可能来自运行时数据。
 * 输出：null | boolean | number | string。
 * 错误：`undefined`、bigint、symbol、函数、非有限数字（NaN/Infinity）等抛 TypeError。
 */
function assertPrimitive(value: unknown): null | boolean | number | string {
	// 第一组：null、字符串、布尔都是合法 JSON 标量，直接返回。
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	// 数字额外要求有限；JSON 不能表示 NaN 或 Infinity。
	if (typeof value === "number" && Number.isFinite(value)) return value;
	// 其余类型（包括 undefined）都不是严格 JSON。
	throw new TypeError("Replicated state values must be strict JSON");
}

/**
 * 要求对象是“纯对象”：原型为 Object.prototype 或 null。
 *
 * 例子：`{}` 和 `Object.create(null)` 通过；`new Date()`、类实例、函数对象的原型不是这两者，会被拒绝。
 * 副作用：无；错误：TypeError。
 */
function assertPlainObject(value: object): void {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("Replicated state containers must be plain objects or arrays");
	}
}

/**
 * 要求数组是稠密数组，且每个下标都是可枚举、已定义值的数据属性。
 *
 * 检查分两步：
 * 1. 自有键数量必须恰好是 `length + 1`（所有下标加 `"length"`），且全是字符串键；
 *    这样能排除稀疏数组（空洞）、symbol 键以及额外挂载的属性（如 `arr.extra = 1`）。
 * 2. 逐个下标取描述符，要求存在、可枚举、是数据属性且值不为 undefined。
 *
 * 输入：readonly unknown[]；输出：无；错误：TypeError。
 */
function assertDenseArray(value: readonly unknown[]): void {
	// Reflect.ownKeys 包含 "length" 本身；对稠密数组而言键集合应正好是 "0"..."length-1" 加 "length"。
	const keys = Reflect.ownKeys(value);
	if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) {
		throw new TypeError("Replicated state arrays must be dense and contain only indexed entries");
	}
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		// 空洞没有描述符；访问器属性没有 value；显式写入的 undefined 也不允许（它无法在 JSON 中表示）。
		if (
			descriptor === undefined ||
			!descriptor.enumerable ||
			!("value" in descriptor) ||
			descriptor.value === undefined
		) {
			throw new TypeError(
				"Replicated state arrays must contain enumerable indexed data properties with defined values",
			);
		}
	}
}
