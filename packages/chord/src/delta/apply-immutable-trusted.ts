/*
 * 文件导读
 * ========
 * 所属：packages/chord/src/delta，Chord 共享的 Delta 模块；这是 tracker 的内部快速应用器。
 *
 * 职责边界：把 tracker 自己生成、已经可信的一批 Op 压到旧值上，得到写时复制后的新值。它不校验 payload
 * 是否为严格 JSON，也不解析路径 id/短形式——这些前置条件由 tracker 的输入所有权和 Op 生成过程保证。
 * 它只做“内部不变量”级别的低成本检查（末端必须是容器、p/m 目标必须是数组、字符串 op 目标必须是字符串）。
 *
 * 上游入口：tracker.ts 的 `materializeOperations()`。当一批 op 中没有 `p` 或 `m` 时调用本文件的
 * `applyImmutableTrusted`；含 p/m 时改走 index.ts 的公共 `applyImmutable`（原生 splice/permutation 更快），
 * 因此本文件不实现 p/m 的可变路径解析之外的校验。
 * 下游依赖/结果：只依赖 `../json.ts` 的 `JsonValue` 和 index.ts 的 `Op/Path/Seg` 类型；输出的新值由
 * `materializePrepared()` 放进 `Prepared.value`，`adopt()` 成功后成为 tracker 的新 `#value`。
 * 错误流向：内部不变量被破坏时抛 `TypeError`，由 `prepare()` 捕获并把事务置为 aborted；正常路径不应出现。
 *
 * 能力清单：
 * - `applyImmutableTrusted<T>(target, operations): T`：唯一的导出；顺序应用 r/s/d/a/t/p/m，返回新根。
 * 文件内辅助（未导出）：
 * - `copyPath`：沿路径浅拷贝容器，保证每个容器本次最多拷贝一次。
 * - `shallowCopy`：保留数组/普通对象/null 原型对象形状的浅拷贝。
 * - `read` / `defineData`：只读自有值、用 defineProperty 写数据属性（避开原型 setter）。
 * - `spliceTrusted` / `permuteTrusted`：在已归本次结果所有的数组上原地执行 p/m。
 * - `isContainer`：运行时类型谓词。
 *
 * 组合关系与典型顺序：
 *   tracker 修改草稿 -> prepare() 生成 ops -> materializeOperations()
 *   ->（无 p/m）applyImmutableTrusted(base, ops) -> Prepared.value -> adopt() 指针交换。
 * 同一批内，`owned` 集合让“多次改同一容器”只发生一次浅拷贝，其余容器与 payload 按引用共享。
 *
 * 示例（真实签名）：
 *   const base = { a: { text: "x" }, stable: { n: 1 } };
 *   const value = applyImmutableTrusted(base, [
 *     ["a", ["a", "text"], "y"],
 *     ["s", ["a", "n"], 2],
 *   ]);
 *   // value = { a: { text: "xy", n: 2 }, stable: { n: 1 } }
 *   // value.a 是新对象，value.stable === base.stable，base 完全不变。
 * 外部输入不能直接调用本例：路径安全、payload 严格性和 op 形状都应由公共 `applyImmutable` 负责。
 *
 * 建议阅读顺序：先看 `applyImmutableTrusted` 的主循环和 op 分派，再读 `copyPath`/`shallowCopy` 理解
 * 所有权，最后看 `defineData`、`spliceTrusted`、`permuteTrusted` 这三个原地写入辅助。
 */
import type { JsonValue } from "../json.ts";
import type { Op, Path, Seg } from "./index.ts";

// 容器在这里只可能是数组或普通对象；类型仅供编译期使用。
type JsonContainer = JsonValue[] | Record<string, JsonValue>;
// copyPath 同时返回“可能换了引用的根”和“路径末端、可以原地修改的容器”。
type CopiedPath = { root: JsonValue; target: JsonContainer };

// 复用一个描述符对象来定义数据属性：每次写只改 `.value`，避免为每个属性分配新对象。
// 这在 JS 单线程里是安全的；defineData 内部不调用用户代码，不会重入。
const DATA_DESCRIPTOR: PropertyDescriptor = {
	value: undefined,
	writable: true,
	enumerable: true,
	configurable: true,
};

/** Apply self-produced trusted operations while copying each touched container once. */
/**
 * 用 tracker 自产的可信操作构造一个新的不可变值：每个被触碰的容器最多浅拷贝一次。
 *
 * 输入：`target` 是当前 revision 的根；`operations` 是 tracker 生成的 op 数组。
 * 输出：应用完操作后的根（类型仍是 T）。
 * 副作用：不修改 `target` 和 op payload；内部会原地修改自己新建的浅拷贝。
 * 错误：路径不符合内部不变量（末端不是容器、p/m 目标不是数组、字符串 op 目标不是字符串）时抛 TypeError。
 * 主要流程：顺序执行 op；`r` 直接换根；p/m 先沿路径拷贝到目标数组再原地 splice/permute；
 *           s/d/a/t 先拷贝到父容器，再对最后一个 key 写入或删除。
 *
 * 例子（描述行为）：base = { a: { text: "x" } }，ops = [["a", ["a","text"], "y"]]，
 * 返回 { a: { text: "xy" } }；base.a 保持不变，返回值的 a 是新对象。
 */
export function applyImmutableTrusted<T>(target: T, operations: readonly Op[]): T {
	// T 只约束为对象，但运行逻辑按 JsonValue 处理；先经过 unknown 再断言，
	// 因为 TS 不允许直接把泛型 T 断言成另一个无关类型。调用方保证 T 是严格 JSON。
	let root = target as unknown as JsonValue;
	// 记录本批次里已经拷贝过的容器，既用于“只拷贝一次”，也用于判断某节点是不是本次的副本。
	const owned = new WeakSet<object>();
	for (const operation of operations) {
		// `r`：整根替换。payload 的所有权已经转移给结果，不需要拷贝，也不修改它。
		if (operation[0] === "r") {
			root = operation[1];
			continue;
		}
		// p（splice）与 m（permutation）作用于数组本身：copyPath 的长度用 path.length，
		// 表示连目标数组一起拷贝（末端就是数组），而不是像 s/d 那样只拷贝到父容器。
		if (operation[0] === "p" || operation[0] === "m") {
			const copied = copyPath(root, operation[1], operation[1].length, owned);
			root = copied.root;
			// 可信输入里目标一定是数组；这里只防内部不变量被破坏。
			if (!Array.isArray(copied.target)) throw new TypeError("Trusted array operation target is not an array");
			if (operation[0] === "p") spliceTrusted(copied.target, operation[2], operation[3], operation[4]);
			else permuteTrusted(copied.target, operation[2]);
			continue;
		}

		// s/d/a/t 的路径最后一段是要写的 key，前面各段是父路径；因此只拷贝 path.length - 1 层。
		const path = operation[1];
		const copied = copyPath(root, path, path.length - 1, owned);
		root = copied.root;
		// 路径至少有一个元素（NonEmptyPath），所以 `!` 取到的 key 一定存在。
		const key = path[path.length - 1]!;
		switch (operation[0]) {
			case "s":
				// 直接定义自有数据属性，绕过对象原型上的 setter（尤其是 `__proto__`）。
				defineData(copied.target, key, operation[2]);
				break;
			case "d":
				if (Array.isArray(copied.target)) {
					// 数组删除必须用 splice 保持稠密：直接 delete 会留下空洞。
					if (typeof key !== "number") throw new TypeError("Trusted array deletion key is not numeric");
					spliceTrusted(copied.target, key, 1, []);
				} else Reflect.deleteProperty(copied.target, key);
				break;
			case "a": {
				// a：把字符串拼到现有值后面。读取的是拷贝后的父容器，所以不会碰到 base。
				const current = read(copied.target, key);
				if (typeof current !== "string") throw new TypeError("Trusted append target is not a string");
				defineData(copied.target, key, `${current}${operation[2]}`);
				break;
			}
			case "t": {
				// t：从某个下标起截断字符串，保留前 operation[2] 个字符。
				const current = read(copied.target, key);
				if (typeof current !== "string") throw new TypeError("Trusted truncate target is not a string");
				defineData(copied.target, key, current.slice(operation[2]));
				break;
			}
		}
	}
	// 与入口的断言对称，把内部 JsonValue 表示还原成调用方声明的 T。
	return root as unknown as T;
}

/**
 * 沿 path 的前 `length` 段向下拷贝容器，返回新的根和路径末端容器。
 *
 * 输入：`root` 当前根；`path` 操作路径；`length` 要下钻并拷贝的段数；`owned` 本批已拷贝容器集合。
 * 输出：`{ root, target }`，root 可能因根容器被拷贝而换引用。
 * 错误：根或路径中间节点不是容器时抛 TypeError（内部不变量被破坏）。
 * 主要流程：先按需拷贝根，然后逐段读出子容器；子容器若已在 owned 中（之前拷过）就直接复用，
 *          否则浅拷贝并用 defineData 挂回父副本。
 *
 * 注意：重复操作同一容器时，第二次会命中 `owned`，因此不会把第一次的修改覆盖掉，也不会重复拷贝。
 */
function copyPath(root: JsonValue, path: Path, length: number, owned: WeakSet<object>): CopiedPath {
	if (!isContainer(root)) throw new TypeError("Trusted operation root is not a container");
	// 局部变量 copiedRoot 始终指向“新的根”；即使根已经拷过，也要沿路径继续下钻。
	let copiedRoot = root;
	if (!owned.has(root)) {
		copiedRoot = shallowCopy(root);
		owned.add(copiedRoot);
	}
	// destination 是当前已经属于本次结果的容器，后续可以安全地原地修改。
	let destination = copiedRoot as JsonContainer;
	for (let index = 0; index < length; index++) {
		const segment = path[index]!;
		const child = read(destination, segment);
		if (!isContainer(child)) throw new TypeError("Trusted operation path is not a container");
		// 子容器已经拷贝过：说明它属于本次结果，直接作为下一层目标继续。
		if (owned.has(child)) {
			destination = child;
			continue;
		}
		// 子容器仍与 base 共享：浅拷贝它，并把副本挂到父副本的同一个 key 上。
		const copy = shallowCopy(child);
		defineData(destination, segment, copy);
		owned.add(copy);
		destination = copy;
	}
	return { root: copiedRoot, target: destination };
}

/**
 * 浅拷贝一个容器，保留它的原型语义。
 *
 * 数组用 `Array.from`，得到稠密的新数组；对象分两种：
 * - null 原型对象：`Object.assign(Object.create(null), value)`，避免把结果挂到 Object.prototype 上；
 *   目标是 null 原型，所以连 `__proto__` 键也只会创建自有数据属性，不会触发继承来的 setter。
 * - 普通对象：对象展开 `{ ...value }`，用 CreateDataProperty 逐个定义自有可枚举属性，
 *   同样把 `__proto__` 当普通数据键处理。
 *
 * 输入：容器；输出：同类型的新容器；副作用：无；错误：无。
 */
function shallowCopy(value: JsonContainer): JsonContainer {
	if (Array.isArray(value)) return Array.from(value);
	// Spread and `Object.assign()` onto a null-prototype object define own data properties, `__proto__` included, as
	// `defineData()` per key does, at a fraction of its cost.
	return Object.getPrototypeOf(value) === null ? Object.assign(Object.create(null), value) : { ...value };
}

/**
 * 读取容器上的一个键。
 *
 * 输入：容器与键（字符串或数组下标）；输出：JsonValue；副作用：无。
 * `!` 非空断言表示“可信路径保证这里一定有值”，类型系统无法从 Seg 推断出来。
 * 这里使用普通属性访问，理论上会读到原型链；可信 op 的路径由 tracker 生成，只指向自有数据。
 */
function read(target: JsonContainer, key: Seg): JsonValue {
	return (target as Record<Seg, JsonValue>)[key]!;
}

/**
 * 把 key 定义成自有的可枚举数据属性，覆盖旧值。
 *
 * 输入：目标容器、键、值；输出：无；副作用：修改目标容器。
 * 使用 `Object.defineProperty` 而不是赋值，是因为赋值会触发原型链上的 setter；
 * 例如给普通对象写 `__proto__` 会改变原型而不是创建数据属性。Delta 必须把 `__proto__`
 * 当普通键处理，才能安全地表达任意 JSON 键。
 *
 * 复用的描述符在写完后把 value 重置为 undefined，避免无意中让模块级对象长期持有大对象。
 */
function defineData(target: JsonContainer, key: Seg, value: JsonValue): void {
	DATA_DESCRIPTOR.value = value;
	Object.defineProperty(target, key, DATA_DESCRIPTOR);
	DATA_DESCRIPTOR.value = undefined;
}

/**
 * 在已经归本次结果所有的数组上原地执行 splice(start, remove, ...items)。
 *
 * 输入：目标数组、起始下标、删除个数、插入项。
 * 输出：无；副作用：原地修改数组的长度与元素。
 * 错误：无额外检查；调用方保证 start/remove 在可信范围内。
 * 流程：先算长度差 delta；扩容时先把长度改大，再把尾部元素右移（copyWithin 自动处理重叠）；
 *      缩容时先左移尾部元素，再截短长度。最后把插入项逐个写成数据属性。
 * 这样既保持 O(n) 的移动成本，又不需要分配新数组。
 */
function spliceTrusted(target: JsonValue[], start: number, remove: number, items: readonly JsonValue[]): void {
	const oldLength = target.length;
	const delta = items.length - remove;
	if (delta > 0) {
		// 扩容：先设置新长度（新增位置暂时是 undefined），再把 [start+remove, oldLength) 移到新位置。
		target.length = oldLength + delta;
		target.copyWithin(start + items.length, start + remove, oldLength);
	} else if (delta < 0) {
		// 缩容：先把尾部元素左移到最终位置，再截掉多余长度，避免中间出现空洞。
		target.copyWithin(start + items.length, start + remove, oldLength);
		target.length = oldLength + delta;
	}
	// delta === 0 时长度不变，不需要移动。
	for (let index = 0; index < items.length; index++) defineData(target, start + index, items[index]!);
}

/**
 * 在已经归本次结果所有的数组上原地按 permutation 重排。
 *
 * permutation 的语义是“新数组第 i 项 = 旧数组第 permutation[i] 项”，与 Op 的 `m` 一致。
 * 先 `slice()` 快照旧数组，避免边读边写覆盖尚未读取的元素。
 * 输入：目标数组与等长置换；输出：无；副作用：原地重排。
 * 错误：长度不一致时抛 TypeError（内部不变量被破坏）。
 */
function permuteTrusted(target: JsonValue[], permutation: readonly number[]): void {
	if (target.length !== permutation.length) throw new TypeError("Trusted permutation length mismatch");
	const previous = target.slice();
	for (let index = 0; index < permutation.length; index++) target[index] = previous[permutation[index]!]!;
}

// 运行时类型守卫：同时被用作类型谓词，返回 true 时把 unknown 收窄为 JsonContainer。
// 它只认“非 null 的对象”，不区分数组/普通对象；更细的合法性依赖可信 op 的来源。
function isContainer(value: unknown): value is JsonContainer {
	return value !== null && typeof value === "object";
}
