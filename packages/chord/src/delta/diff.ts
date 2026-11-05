/*
 * 文件导读
 * ========
 * 所属：packages/chord/src/delta，Chord 共享的 Delta 模块；由 delta/index.ts 再导出为
 * `diffRevisions`。
 *
 * 职责边界：只计算“从旧 revision 到新 revision”的增量 Op，不应用、不编码、不校验输入是否严格 JSON。
 * 它按对象/数组递归比较，对数组依次尝试置换、公共前后缀、子序列、身份锚点、语义 LCS、逐元素递归等
 * 策略；对字符串尝试 append/overlap 压缩；对对象按键增删改生成操作。差异过大时放弃增量，返回根替换。
 *
 * 上游入口：state/derive.ts、documents/address-source.ts、old/cell.ts 等持有旧/新 revision 的调用方；
 * 输入约定是两份不可变、无环、严格 JSON 的值。
 * 下游依赖/结果：返回的 `Op[]` 交给 `apply`、`applyImmutable` 或 `encoder`。正常情况下对 before 按序
 * 应用结果得到深等于 after 的值；溢出或成本不划算时返回单条 `["r", after]`。
 * 错误流向：本文件不主动抛业务错误；输入含环会导致递归无法终止。内部超过操作数上限不是异常，而是
 * 通过 `overflowedBatches` 标记并由 `diffRevisions` 转成根替换。
 *
 * 能力清单：
 * - `diffRevisions(before, after): Op[]`：唯一的导出入口，带操作数/成本兜底。
 * 文件内辅助（未导出，按用途分组）：
 *   - 发射与比较：`emitOperation`、`emitSet`、`equalJson`、`sameValue`、`jsonCost`、`pathCost`、
 *     `operationCost`。
 *   - 字符串：`emitString`。
 *   - 数组匹配：`permutation`、`lcsMatches`、`semanticallyAligned`、`lowerBound`、
 *     `identitySubsequence`、`greedyIdentityAnchors`、`identityAnchors`、`processArrayMatches`、
 *     `diffArrayRegion`、`diffArray`。
 *   - 对象与分派：`diffObject`、`diffValue`。
 *   - 常量：`DEFAULT_OVERLAP_SCAN`、`MAX_DELTA_OPERATIONS`、`MAX_IDENTITY_CANDIDATES`、
 *     `MAX_SEMANTIC_CELLS`。
 *
 * 组合关系与典型顺序：
 *   diffRevisions -> diffValue 按类型分派：字符串 -> emitString；数组 -> diffArray；
 *   对象 -> diffObject；其他 -> emitSet。
 *   diffArray 先尝试整体置换 m，再进入 diffArrayRegion 的“逐级回退梯子”：
 *   去公共前后缀 -> 空区间 splice -> 同长度逐位锚点 -> 子序列 -> 身份 LIS -> 语义 LCS ->
 *   单元素递归 -> 整段 splice。
 *
 * 示例（真实签名）：
 *   const first = { id: 1, n: 1 };
 *   const second = { id: 2, n: 2 };
 *   const before = { rows: [first, second], text: "abc" };
 *   const after  = { rows: [second, first], text: "abcd" };
 *   const ops: Op[] = diffRevisions(before, after);
 *   // 两个元素都按引用复用：rows 得到 ["m", ["rows"], [1,0]]，text 得到 ["a", ["text"], "d"]；
 *   // 若 rows 的元素是新建对象，则引用置换不成立，会继续尝试后续的语义/整段替换分支。
 *
 * 建议阅读顺序：先读 `diffRevisions` 和 `diffValue` 看整体分派，再读 `diffObject`/`emitString`，
 * 然后按 `diffArrayRegion` 里的回退顺序逐个看 `permutation`、`identityAnchors`、`lcsMatches`，
 * 最后读成本函数理解为什么有时退回根替换。
 */
import type { JsonValue } from "../json.ts";
import { type NonEmptyPath, type Op, overlap, ownedSlice, type Path, RESERVED_SEGMENTS, type Seg } from "./index.ts";

// 字符串差异扫描的最大尾部长度：限制 overlap 的成本。
const DEFAULT_OVERLAP_SCAN = 65_536;
// 一批 diff 允许产生的最多操作数；超过后放弃增量，改用根替换。
const MAX_DELTA_OPERATIONS = 4_096;
// 记录已经溢出（超过操作数上限）的批次数组。WeakSet 按数组身份记录，不改数组本身，
// 数组被释放后条目可回收；emitOperation 只拿到 operations 数组，因此用它传递“已放弃”信号。
const overflowedBatches = new WeakSet<Op[]>();

/**
 * 向批次追加一条操作，并执行溢出保护。
 *
 * 输入：目标 operations 数组与待追加 op；输出/副作用：push 或把批次标记为溢出。
 * 一旦溢出，后续 emitOperation 全部变成 no-op；最终 diffRevisions 看到标记就丢弃这批半成品，
 * 返回单条根替换。这样调用方永远拿不到“只应用了一半差异”的结果。
 */
const emitOperation = (operations: Op[], operation: Op): void => {
	if (overflowedBatches.has(operations)) return;
	if (operations.length >= MAX_DELTA_OPERATIONS) {
		overflowedBatches.add(operations);
		return;
	}
	operations.push(operation);
};

// 类型谓词：判断 JSON 值是否为容器（数组或普通对象）。null 的 typeof 也是 object，所以先排除。
const isContainer = (value: JsonValue): value is JsonValue[] | Record<string, JsonValue> =>
	value !== null && typeof value === "object";

/**
 * 生成“把 path 处设为 value”的操作：空路径只能用根替换 `r`，非空路径用 `s`。
 *
 * 输入：路径、值、目标批次；输出：无；副作用：可能追加一条 op。
 * 类型上 `path as NonEmptyPath` 是对“path.length !== 0”分支的显式断言，编译器无法从运行时判断保留这个信息。
 */
const emitSet = (path: Path, value: JsonValue, operations: Op[]): void => {
	if (path.length === 0) emitOperation(operations, ["r", value]);
	else emitOperation(operations, ["s", path as NonEmptyPath, value]);
};

/**
 * 深度比较两个 JSON 值是否相等。
 *
 * 规则：
 * - 先比较引用/原始值（`===`），相同即相等；
 * - 容器类型必须一致（数组对数组、对象对对象）；
 * - 数组按顺序逐项比较，长度必须相同；
 * - 对象键集合必须相同（键顺序无关），每个键递归比较。
 *
 * 输入：两个 JsonValue；输出：boolean；副作用：无；错误：无（输入假定无环）。
 * 复杂度：最坏 O(两棵子树大小之和)；引用相同的子树会立即返回，因此共享结构很便宜。
 */
const equalJson = (left: JsonValue, right: JsonValue): boolean => {
	if (left === right) return true;
	// 一方是标量、另一方是容器，或数组/对象种类不同，直接不相等。
	if (!isContainer(left) || !isContainer(right) || Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left)) {
		const other = right as JsonValue[];
		if (left.length !== other.length) return false;
		for (let index = 0; index < left.length; index++) {
			if (!equalJson(left[index]!, other[index]!)) return false;
		}
		return true;
	}
	const other = right as Record<string, JsonValue>;
	const keys = Object.keys(left);
	// 键数量不同必然不相等；再逐键检查对方确实有该键（避免只比较左侧键却漏掉右侧新增键）。
	if (keys.length !== Object.keys(other).length) return false;
	for (const key of keys) {
		if (!Object.hasOwn(other, key) || !equalJson(left[key]!, other[key]!)) return false;
	}
	return true;
};

/**
 * 判断 after 是否是 before 的一个“按值/按引用匹配”的置换，并返回置换数组。
 *
 * 返回的 order 满足 `after[i]` 对应 `before[order[i]]`，正是 `m` 操作的语义。
 * 实现：
 * - 长度不同直接返回 undefined；
 * - 用 Map 记录 before 中每个值出现过的下标列表；
 * - 按 after 顺序，为每个值取下一个尚未使用的下标；找不到就说明不是置换。
 *
 * 关键限制：Map 的键对原始值按值比较，对对象/数组按引用比较。因此只有 after 复用 before 的
 * 对象引用（或全是原始值）时才能识别为置换；结构相同但新建的对象不会被当成同一元素。
 *
 * 输入：两个数组；输出：number[] 或 undefined；副作用：无。
 */
const permutation = (before: readonly JsonValue[], after: readonly JsonValue[]): number[] | undefined => {
	if (before.length !== after.length) return undefined;
	// 每个值记录它在 before 中出现的所有下标，以及已经用掉了几个（处理重复值）。
	const positions = new Map<JsonValue, { indices: number[]; used: number }>();
	for (let index = 0; index < before.length; index++) {
		const value = before[index]!;
		const entry = positions.get(value);
		if (entry === undefined) positions.set(value, { indices: [index], used: 0 });
		else entry.indices.push(index);
	}
	const result = new Array<number>(after.length);
	for (let index = 0; index < after.length; index++) {
		const entry = positions.get(after[index]!);
		// 值在 before 中不存在，或该值的所有出现都已被前面的 after 元素占用：不是置换。
		if (entry === undefined || entry.used === entry.indices.length) return undefined;
		// 先取当前下标，再自增 used，保证重复值按顺序一一配对。
		result[index] = entry.indices[entry.used++]!;
	}
	return result;
};

/**
 * 为两个字符串生成最小化到 a/t/s 的操作。
 *
 * 输入：旧串、新串、非空路径（根字符串不能走这里，因为 a/t 路径必须非空）、目标批次。
 * 输出：无；副作用：可能追加一条或多条 op。
 *
 * 决策顺序：
 * 1. 相同：什么都不做；
 * 2. after 以 before 为前缀：一条 `a` 追加新增部分；
 * 3. 否则找最长“before 后缀 = after 前缀”的重叠 shared：
 *    - shared 为 0：一条 `s` 整串替换；
 *    - 否则先 `t` 截断掉 before 末尾多出的部分，再在有剩余时 `a` 追加 after 的后半段。
 *
 * 例子：before="abcdef"、after="cdefgh" 的重叠是 "cdef"（长度 4），生成
 * ["t", path, 2] + ["a", path, "gh"]。
 */
// O(length): comparing two revisions reads both strings, and slicing a rope makes V8 flatten all of it. A writer that
// knows what it appended records it with appendText() instead of diffing.
const emitString = (before: string, after: string, path: NonEmptyPath, operations: Op[]): void => {
	if (before === after) return;
	// 前缀扩展：只需追加后半段。ownedSlice 防止 op 持有整条 after 的底层字符串。
	if (after.length > before.length && after.slice(0, before.length) === before) {
		emitOperation(operations, ["a", path, ownedSlice(after, before.length)]);
		return;
	}
	// 滚动窗口式变化：旧的尾部可能是新的头部。overlap 会限制扫描长度与候选数。
	const shared = overlap(before, after, DEFAULT_OVERLAP_SCAN);
	if (shared === 0) {
		emitOperation(operations, ["s", path, after]);
		return;
	}
	// 先截掉 before 中不属于重叠的部分（保留长度 before.length - shared），
	// 再追加 after 中重叠之后的内容；若 after 恰好只有重叠部分，就不需要追加。
	emitOperation(operations, ["t", path, before.length - shared]);
	if (after.length > shared) emitOperation(operations, ["a", path, ownedSlice(after, shared)]);
};

// 数组匹配对：[before 下标, after 下标]，表示这两个元素被对齐。
type ArrayMatch = readonly [before: number, after: number];

// LIS（最长递增子序列）算法的候选节点：记录匹配位置，以及前驱候选在 candidates 中的下标。
type MatchCandidate = {
	before: number;
	after: number;
	previous: number;
};

// identityAnchors 在候选匹配对超过此数量时改用贪心，避免 O(n log n) 结构上的大内存占用。
const MAX_IDENTITY_CANDIDATES = 200_000;
// 语义 LCS 的最大 DP 单元格数（before.length * after.length）；超过就不做 O(n*m) 比较。
const MAX_SEMANTIC_CELLS = 65_536;

// 判断两个值是否相同：先比引用，引用不同再做深比较。
// 先比引用的好处是共享子树 O(1) 命中；这也是 tracker 结构共享能加速 diff 的原因。
const sameValue = (left: JsonValue, right: JsonValue): boolean => left === right || equalJson(left, right);

/**
 * 用动态规划求两个数组的最长公共子序列（LCS），返回匹配下标对。
 *
 * 输入：before/after 数组、判断两个元素是否“相等”的回调（可以是语义对齐而非严格相等）、
 *      允许的最大 DP 单元格数 maxCells。
 * 输出：匹配数组；输入为空返回 []；单元格数超过上限返回 undefined（表示放弃，调用方走更粗的替换）。
 * 副作用：分配 (before.length + 1) * (after.length + 1) 个 Uint32 的 DP 表；不改输入。
 *
 * 表填充方向是从右下到左上：lengths[left][right] 表示 before[left..] 与 after[right..] 的 LCS 长度。
 * 相等时取右下角 + 1，否则取下方/右方的较大值。随后从左上回溯：
 * 相等且长度正好比右下角多 1，就记入匹配；否则向长度更大的一侧移动。
 *
 * 注意：这里比较的是切片后的数组，返回的下标是切片内相对下标；调用方负责加回起点。
 */
const lcsMatches = (
	before: readonly JsonValue[],
	after: readonly JsonValue[],
	equal: (left: JsonValue, right: JsonValue) => boolean,
	maxCells: number,
): ArrayMatch[] | undefined => {
	if (before.length === 0 || after.length === 0) return [];
	// 成本门控：超过单元格预算就放弃精确 LCS，防止大数组导致内存/时间爆炸。
	if (before.length * after.length > maxCells) return undefined;
	const width = after.length + 1;
	// Uint32Array 长度 (before+1)*(after+1)，初始全 0；用一维数组模拟二维表。
	const lengths = new Uint32Array((before.length + 1) * width);
	for (let left = before.length - 1; left >= 0; left--) {
		for (let right = after.length - 1; right >= 0; right--) {
			const at = left * width + right;
			// 相等：继承右下角结果 +1；不等：取“跳过 before 元素”和“跳过 after 元素”的较大值。
			lengths[at] = equal(before[left]!, after[right]!)
				? lengths[(left + 1) * width + right + 1]! + 1
				: Math.max(lengths[(left + 1) * width + right]!, lengths[left * width + right + 1]!);
		}
	}
	// 从左上前向回溯，构造一组具体匹配。
	const matches: ArrayMatch[] = [];
	let left = 0;
	let right = 0;
	while (left < before.length && right < after.length) {
		if (
			equal(before[left]!, after[right]!) &&
			lengths[left * width + right] === lengths[(left + 1) * width + right + 1]! + 1
		) {
			// 当前元素属于某个最优 LCS：记录并同时前进。
			matches.push([left++, right++]);
		} else if (lengths[(left + 1) * width + right]! >= lengths[left * width + right + 1]!) left += 1;
		else right += 1;
	}
	return matches;
};

/**
 * 判断两个值是否“语义对齐”：不仅严格相等，还允许它们的某个子容器是同一引用。
 *
 * 用途：数组元素通常是带 id 的对象，内容可能大改但 id 子树仍是同一个对象。
 * 用这种较宽的对齐标准做 LCS，可以把同一实体的“修改”识别出来，而不是删掉再插入。
 *
 * 规则：
 * - 严格相等/深相等：是对齐；
 * - 数组对数组：长度相同，且存在同一下标的子容器是同一引用；
 * - 对象对对象：存在同名键，且其值指向同一容器引用。
 *
 * 输入：两个 JsonValue；输出：boolean；副作用：无。
 */
const semanticallyAligned = (left: JsonValue, right: JsonValue): boolean => {
	if (sameValue(left, right)) return true;
	// 类型/种类不同则无法对齐。
	if (!isContainer(left) || !isContainer(right) || Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		// `some` 命中一个同引用子容器即可。
		return left.some((value, index) => isContainer(value) && value === right[index]);
	}
	const leftObject = left as Record<string, JsonValue>;
	const rightObject = right as Record<string, JsonValue>;
	for (const key of Object.keys(leftObject)) {
		const value = leftObject[key];
		// 双方都有该键，且值是同一个对象/数组引用。
		if (isContainer(value) && Object.hasOwn(rightObject, key) && value === rightObject[key]) return true;
	}
	return false;
};

/**
 * 在升序数字数组中查找第一个 >= value 的位置（下界）。
 *
 * 输入：有序数组与目标值；输出：插入位置（0..values.length）；副作用：无。
 * `>>> 1` 是无符号右移一位，等价于 Math.floor((low+high)/2)，但避免大数时的符号问题。
 */
const lowerBound = (values: readonly number[], value: number): number => {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (values[middle]! < value) low = middle + 1;
		else high = middle;
	}
	return low;
};

/**
 * 当一方的元素全部按引用出现在另一方且顺序一致时，返回这组匹配。
 *
 * 这是一个“纯删除/纯插入”场景的快速路径：较短的一侧完全包含在较长一侧的子序列中，
 * 可以直接把长侧多出来的元素视为 splice，不必做 LIS/LCS。
 *
 * 输入：两段数组区间；输出：匹配数组，或 undefined 表示不适用。
 * 规则：长度相等时返回 undefined（调用方已用同长度分支处理）；较短的 after 在 before 中找子序列；
 *      较短的 before 在 after 中找子序列。用 `===` 比较（引用/原始值），不做深比较。
 * 错误/副作用：无。
 */
const identitySubsequence = (
	before: readonly JsonValue[],
	beforeStart: number,
	beforeEnd: number,
	after: readonly JsonValue[],
	afterStart: number,
	afterEnd: number,
): ArrayMatch[] | undefined => {
	const beforeCount = beforeEnd - beforeStart;
	const afterCount = afterEnd - afterStart;
	const matches: ArrayMatch[] = [];
	if (afterCount < beforeCount) {
		// after 更短：按 after 顺序在 before 中向前找同名元素；找不齐说明不是子序列。
		let beforeIndex = beforeStart;
		for (let afterIndex = afterStart; afterIndex < afterEnd; afterIndex++) {
			while (beforeIndex < beforeEnd && before[beforeIndex] !== after[afterIndex]) beforeIndex += 1;
			if (beforeIndex === beforeEnd) return undefined;
			matches.push([beforeIndex++, afterIndex]);
		}
		return matches;
	}
	if (beforeCount < afterCount) {
		// before 更短：按 before 顺序在 after 中找；匹配对仍然写成 [before, after]。
		let afterIndex = afterStart;
		for (let beforeIndex = beforeStart; beforeIndex < beforeEnd; beforeIndex++) {
			while (afterIndex < afterEnd && before[beforeIndex] !== after[afterIndex]) afterIndex += 1;
			if (afterIndex === afterEnd) return undefined;
			matches.push([beforeIndex, afterIndex++]);
		}
		return matches;
	}
	return undefined;
};

/**
 * identityAnchors 的降级版本：按 after 顺序贪心地取第一个可用的同引用位置。
 *
 * 输入：before 的值 -> 下标列表、after 数组与区间；输出：单调递增的匹配对。
 * 副作用：无。贪心不保证最长公共子序列，但时间 O(n log n)、内存小，适合重复元素极多的情况。
 */
const greedyIdentityAnchors = (
	positions: ReadonlyMap<JsonValue, readonly number[]>,
	after: readonly JsonValue[],
	afterStart: number,
	afterEnd: number,
): ArrayMatch[] => {
	const matches: ArrayMatch[] = [];
	// previous 是上一个匹配在 before 中的下标；后面的匹配必须更大，才能保持顺序。
	let previous = -1;
	for (let afterIndex = afterStart; afterIndex < afterEnd; afterIndex++) {
		const candidates = positions.get(after[afterIndex]!);
		if (candidates === undefined) continue;
		// 在有序候选下标中找第一个 >= previous + 1 的位置，保证单调递增。
		const at = lowerBound(candidates, previous + 1);
		const beforeIndex = candidates[at];
		if (beforeIndex === undefined) continue;
		matches.push([beforeIndex, afterIndex]);
		previous = beforeIndex;
	}
	return matches;
};

/**
 * 用“同一个对象/原始值引用”作为锚点，求 before 与 after 之间最长的单调匹配（LIS）。
 *
 * 场景：数组重排或局部增删后，未被改动的元素仍是同一个引用；这些锚点把数组切成若干区间，
 * 只需对区间之间的空隙生成 splice，对锚点位置的对象再递归 diff。
 *
 * 算法：
 * 1. 记录 before 中每个值出现的下标列表；
 * 2. 统计 after 各元素在 before 中的候选总数；为 0 直接返回空；超过上限改用贪心；
 * 3. 对 after 从左到右、对候选下标从大到小，用 lowerBound + tails 维护“长度为 L 的递增子序列的最小结尾”；
 *    candidate.previous 指向前驱，最后从 tails 末尾回溯得到匹配；
 * 4. 反转回溯结果，得到按 before/after 都递增的顺序。
 *
 * 输入/输出：数组区间与匹配对；副作用：分配 Map/数组；不改输入。
 */
const identityAnchors = (
	before: readonly JsonValue[],
	beforeStart: number,
	beforeEnd: number,
	after: readonly JsonValue[],
	afterStart: number,
	afterEnd: number,
): ArrayMatch[] => {
	// 建立 before 值 -> 所有出现下标的索引；Map 对对象按引用区分。
	const positions = new Map<JsonValue, number[]>();
	for (let index = beforeStart; index < beforeEnd; index++) {
		const value = before[index]!;
		const existing = positions.get(value);
		if (existing === undefined) positions.set(value, [index]);
		else existing.push(index);
	}
	// 先估算候选数量；重复元素很多时（如大量相同标量），精确 LIS 的候选数组会过大。
	let candidateCount = 0;
	for (let index = afterStart; index < afterEnd; index++) {
		candidateCount += positions.get(after[index]!)?.length ?? 0;
		if (candidateCount > MAX_IDENTITY_CANDIDATES) {
			return greedyIdentityAnchors(positions, after, afterStart, afterEnd);
		}
	}
	if (candidateCount === 0) return [];

	// candidates 保存所有候选节点；tails[l] 是“长度 l+1 的递增子序列”当前结尾候选在 candidates 中的下标；
	// tailValues[l] 是对应的 before 下标，保持升序，供 lowerBound 使用。
	const candidates: MatchCandidate[] = [];
	const tails: number[] = [];
	const tailValues: number[] = [];
	for (let afterIndex = afterStart; afterIndex < afterEnd; afterIndex++) {
		const beforePositions = positions.get(after[afterIndex]!);
		if (beforePositions === undefined) continue;
		// 从大到小遍历候选，避免同一 after 元素在一次迭代中被重复使用。
		for (let index = beforePositions.length - 1; index >= 0; index--) {
			const beforeIndex = beforePositions[index]!;
			const at = lowerBound(tailValues, beforeIndex);
			const candidateIndex = candidates.length;
			// 前驱是长度 at（即以 tails[at-1] 结尾）的路径；at === 0 表示它是新序列起点。
			candidates.push({ before: beforeIndex, after: afterIndex, previous: at === 0 ? -1 : tails[at - 1]! });
			tails[at] = candidateIndex;
			tailValues[at] = beforeIndex;
		}
	}
	// 从最长序列的结尾回溯前驱，得到匹配；再反转为从左到右。
	const matches: ArrayMatch[] = [];
	let candidateIndex = tails[tails.length - 1] ?? -1;
	while (candidateIndex >= 0) {
		const candidate = candidates[candidateIndex]!;
		matches.push([candidate.before, candidate.after]);
		candidateIndex = candidate.previous;
	}
	matches.reverse();
	return matches;
};

/**
 * 按给定的锚点匹配拆分数组差异：锚点之间调用 diffArrayRegion，锚点本身递归 diffValue。
 *
 * 输入：
 * - before/after 数组、当前数组路径、目标批次；
 * - 待处理区间 [beforeStart, beforeEnd) / [afterStart, afterEnd)；
 * - outputStart：这段区间在“结果数组”中的起始下标（前面的插入/删除已经改变了偏移）；
 * - matches：按 before/after 双递增排列的锚点。
 * 输出/副作用：向 operations 追加操作，可能因溢出提前返回。
 *
 * outputAt 的推进方式：先为锚点之前的空隙生成操作，空隙中 after 的元素数量就是输出偏移增量；
 * 锚点本身占一个输出位置；因此 `outputAt += afterMatch - afterAt` 再 `+1`。
 */
const processArrayMatches = (
	before: JsonValue[],
	after: JsonValue[],
	path: Path,
	operations: Op[],
	beforeStart: number,
	beforeEnd: number,
	afterStart: number,
	afterEnd: number,
	outputStart: number,
	matches: readonly ArrayMatch[],
): void => {
	let beforeAt = beforeStart;
	let afterAt = afterStart;
	let outputAt = outputStart;
	for (const [beforeMatch, afterMatch] of matches) {
		if (overflowedBatches.has(operations)) return;
		// 锚点之前的空隙：纯增删，用一条 p 或递归处理。
		diffArrayRegion(before, after, path, operations, beforeAt, beforeMatch, afterAt, afterMatch, outputAt);
		// 空隙里 after 的元素数量就是结果数组当前的长度增量。
		outputAt += afterMatch - afterAt;
		// 锚点元素本身可能内容变了（但引用相同，或语义对齐）；不等则递归 diff。
		if (!sameValue(before[beforeMatch]!, after[afterMatch]!)) {
			diffValue(before[beforeMatch]!, after[afterMatch]!, [...path, outputAt], operations);
		}
		outputAt += 1;
		beforeAt = beforeMatch + 1;
		afterAt = afterMatch + 1;
	}
	// 最后一个锚点之后的尾部区间。
	if (!overflowedBatches.has(operations)) {
		diffArrayRegion(before, after, path, operations, beforeAt, beforeEnd, afterAt, afterEnd, outputAt);
	}
};

/**
 * 对数组的某个区间生成差异，是数组 diff 的“回退梯子”核心。
 *
 * 输入：before/after 数组、当前数组路径、目标批次、待比较区间与结果数组偏移 outputStart。
 * 输出/副作用：把能表示该区间变化的 op 追加到 operations；可能因批次溢出提前返回。
 *
 * 处理顺序（越靠前越精确，越靠后越粗糙）：
 * 1. 去掉相同的前缀与后缀（sameValue），同步推进输出偏移；
 * 2. 一方为空：一条 splice 纯删除/纯插入；
 * 3. 长度相同：先找同位置的相同元素作锚点；有锚点就交给 processArrayMatches；
 * 4. 一方是另一方的引用子序列：按子序列匹配处理；
 * 5. 身份锚点（最长递增匹配，可能处理重排）；
 * 6. 语义 LCS（元素内容变了，但共享某个子对象引用）；
 * 7. 单个对单个：递归 diffValue（可保留字符串追加等更细的操作）；
 * 8. 兜底：一条 splice 整段替换。
 *
 * 例子：before=[1,2,3]、after=[1,9,2,3]：前缀相同 1，后缀相同 2,3；中间 before 为空、after 为 [9]，
 * 生成 ["p", path, 1, 0, [9]]。
 */
function diffArrayRegion(
	before: JsonValue[],
	after: JsonValue[],
	path: Path,
	operations: Op[],
	beforeStart: number,
	beforeEnd: number,
	afterStart: number,
	afterEnd: number,
	outputStart: number,
): void {
	if (overflowedBatches.has(operations)) return;
	// 去公共前缀：这些元素无需操作，但会占据结果数组的前 outputStart 个位置。
	while (beforeStart < beforeEnd && afterStart < afterEnd && sameValue(before[beforeStart]!, after[afterStart]!)) {
		beforeStart += 1;
		afterStart += 1;
		outputStart += 1;
	}
	// 去公共后缀：只收缩两侧区间的末尾，不改变 outputStart。
	while (beforeStart < beforeEnd && afterStart < afterEnd && sameValue(before[beforeEnd - 1]!, after[afterEnd - 1]!)) {
		beforeEnd -= 1;
		afterEnd -= 1;
	}
	const beforeCount = beforeEnd - beforeStart;
	const afterCount = afterEnd - afterStart;
	// 两侧都空：区间完全相同，无操作。
	if (beforeCount === 0 && afterCount === 0) return;
	// 纯删除或纯插入：一条 splice 足以表示，插入项用 slice 取得（共享引用，不深拷贝）。
	if (beforeCount === 0 || afterCount === 0) {
		emitOperation(operations, ["p", path, outputStart, beforeCount, after.slice(afterStart, afterEnd)]);
		return;
	}

	// 长度相同：把同位置仍相同的元素当锚点，锚点之间的空隙再递归/生成 splice。
	// 这对“只改了部分字段”的定长数组很有效。
	if (beforeCount === afterCount) {
		const positional: ArrayMatch[] = [];
		for (let offset = 0; offset < beforeCount; offset++) {
			if (sameValue(before[beforeStart + offset]!, after[afterStart + offset]!)) {
				positional.push([beforeStart + offset, afterStart + offset]);
			}
		}
		if (positional.length > 0) {
			processArrayMatches(
				before,
				after,
				path,
				operations,
				beforeStart,
				beforeEnd,
				afterStart,
				afterEnd,
				outputStart,
				positional,
			);
			return;
		}
	}

	// 纯插入/删除的快速路径：较短一侧整体是较长一侧的引用子序列。
	const subsequence = identitySubsequence(before, beforeStart, beforeEnd, after, afterStart, afterEnd);
	if (subsequence !== undefined && subsequence.length > 0) {
		processArrayMatches(
			before,
			after,
			path,
			operations,
			beforeStart,
			beforeEnd,
			afterStart,
			afterEnd,
			outputStart,
			subsequence,
		);
		return;
	}

	// 重排场景：用同引用元素求最长递增匹配，锚点之间的空隙由 splice 处理。
	const identity = identityAnchors(before, beforeStart, beforeEnd, after, afterStart, afterEnd);
	if (identity.length > 0) {
		processArrayMatches(
			before,
			after,
			path,
			operations,
			beforeStart,
			beforeEnd,
			afterStart,
			afterEnd,
			outputStart,
			identity,
		);
		return;
	}

	// 元素内容变了、引用不再相同，但可能共享某个子容器引用：用语义对齐做 LCS。
	const semantic = lcsMatches(
		before.slice(beforeStart, beforeEnd),
		after.slice(afterStart, afterEnd),
		semanticallyAligned,
		MAX_SEMANTIC_CELLS,
	);
	if (semantic !== undefined && semantic.length > 0) {
		// LCS 返回的是切片内相对下标，这里加回区间起点变成绝对下标。
		const absolute = semantic.map(
			([beforeIndex, afterIndex]) => [beforeStart + beforeIndex, afterStart + afterIndex] as const,
		);
		processArrayMatches(
			before,
			after,
			path,
			operations,
			beforeStart,
			beforeEnd,
			afterStart,
			afterEnd,
			outputStart,
			absolute,
		);
		return;
	}

	// 单个对单个：递归 diff 可能得到比整段替换更小的操作（例如字符串追加）。
	if (beforeCount === 1 && afterCount === 1) {
		diffValue(before[beforeStart]!, after[afterStart]!, [...path, outputStart], operations);
		return;
	}
	// 所有策略都失败：用一条 splice 替换整个区间。
	emitOperation(operations, ["p", path, outputStart, beforeCount, after.slice(afterStart, afterEnd)]);
}

/**
 * 比较两个数组并生成操作；先尝试整体置换，再进入区间 diff。
 *
 * 输入：旧/新数组、数组路径、目标批次；输出/副作用：向批次追加 op。
 * 整体置换的触发条件：长度相同且 > 1、首尾元素都变了（典型的重排/旋转），并且 after 确实是 before
 * 的按引用置换。满足时一条 `m` 就能表达，比大量 splice 更小。
 * 若条件不满足或不是置换，交给 diffArrayRegion 从头比较。
 */
const diffArray = (before: JsonValue[], after: JsonValue[], path: Path, operations: Op[]): void => {
	// 同一个数组引用或深相等：没有变化。
	if (before === after || equalJson(before, after)) return;
	if (
		before.length === after.length &&
		before.length > 1 &&
		!sameValue(before[0]!, after[0]!) &&
		!sameValue(before[before.length - 1]!, after[after.length - 1]!)
	) {
		const order = permutation(before, after);
		if (order !== undefined) {
			emitOperation(operations, ["m", path, order]);
			return;
		}
	}
	diffArrayRegion(before, after, path, operations, 0, before.length, 0, after.length, 0);
};

/**
 * 比较两个普通对象：对新增键 emitSet、对变化键递归 diff、对删除键发 `d`。
 *
 * 输入：旧/新对象、对象路径、目标批次；输出/副作用：向批次追加 op；溢出时提前返回。
 *
 * 特殊规则：只要任一侧出现保留键（`__proto__`/`constructor`/`prototype`），就无法安全地生成指向该键的
 * 路径；此时若两对象不深相等，直接在对象本身（根对象则为 `r`）做一次 set，整个替换。
 *
 * 键顺序：本函数按键集合生成差异，不表达对象键的插入顺序变化；JSON 语义上对象键无序，Delta 的
 * tracker 才需要额外处理键顺序（见 tracker.ts 的 emitObjectOperations）。
 */
const diffObject = (
	before: Record<string, JsonValue>,
	after: Record<string, JsonValue>,
	path: Path,
	operations: Op[],
): void => {
	const beforeKeys = Object.keys(before);
	const afterKeys = Object.keys(after);
	// 合并两侧键检查保留键；有危险键时不做逐键路径，直接替换整个对象（或根）。
	if ([...beforeKeys, ...afterKeys].some((key) => RESERVED_SEGMENTS.has(key))) {
		if (!equalJson(before, after)) emitSet(path, after, operations);
		return;
	}
	// 先处理 after 的键：已有键递归比较，新键直接 set。
	for (const key of afterKeys) {
		if (overflowedBatches.has(operations)) return;
		if (Object.hasOwn(before, key)) diffValue(before[key]!, after[key]!, [...path, key], operations);
		else emitSet([...path, key], after[key]!, operations);
	}
	// 再处理删除：before 有而 after 没有的键。
	for (const key of beforeKeys) {
		if (overflowedBatches.has(operations)) return;
		if (!Object.hasOwn(after, key)) emitOperation(operations, ["d", [...path, key] as unknown as NonEmptyPath]);
	}
};

/**
 * 根据值的运行时类型分派到具体的 diff 实现。
 *
 * 输入：旧值、新值、当前路径、目标批次；输出/副作用：向批次追加 op。
 * 顺序：引用相同或批次已溢出 -> 返回；两侧字符串且路径非空 -> emitString（根字符串不能 a/t，
 * 会落到 emitSet）；数组 -> diffArray；普通对象 -> diffObject；其他 -> emitSet。
 * 注意这里的路径是“旧值/新值在根中的位置”，不是父容器；数组递归时来自 processArrayMatches 的 outputAt。
 */
const diffValue = (before: JsonValue, after: JsonValue, path: Path, operations: Op[]): void => {
	// 引用相同表示未修改；根字符串没有非空路径，因此字符串优化只对嵌套字符串生效。
	if (before === after || overflowedBatches.has(operations)) return;
	if (typeof before === "string" && typeof after === "string" && path.length > 0) {
		// `path as NonEmptyPath`：上面的 path.length > 0 已经保证非空，但编译器不会跨条件保留这个事实。
		emitString(before, after, path as NonEmptyPath, operations);
		return;
	}
	if (Array.isArray(before) && Array.isArray(after)) {
		diffArray(before, after, path, operations);
		return;
	}
	// 普通对象：两边都是容器且都不是数组。
	if (isContainer(before) && isContainer(after) && !Array.isArray(before) && !Array.isArray(after)) {
		diffObject(before, after, path, operations);
		return;
	}
	// 类型不同或标量变化：直接 set（根路径会变成 r）。
	emitSet(path, after, operations);
};

/**
 * 估算一个 JSON 值序列化后的字符成本，用于判断“发增量”是否比“发整份快照”更划算。
 *
 * 输入：JsonValue；输出：近似字符数；副作用：无。
 * 这不是精确的 JSON.stringify：字符串转义、Unicode 等未计入，数字用 String 长度近似。
 * 规则：null=4、字符串=长度+2（引号）、数字=String 长度、布尔=4/5、数组=方括号+元素+逗号、
 *       对象=花括号+键引号+冒号+值+逗号。
 */
const jsonCost = (value: JsonValue): number => {
	if (value === null) return 4;
	if (typeof value === "string") return value.length + 2;
	if (typeof value === "number") return String(value).length;
	if (typeof value === "boolean") return value ? 4 : 5;
	if (Array.isArray(value)) {
		let cost = 2;
		for (let index = 0; index < value.length; index++) cost += jsonCost(value[index]!) + (index === 0 ? 0 : 1);
		return cost;
	}
	let cost = 2;
	let index = 0;
	for (const key of Object.keys(value)) {
		// 键本身带引号（+2），再加冒号（+1）；非首项加逗号（+1）。
		cost += key.length + 3 + jsonCost(value[key]!) + (index++ === 0 ? 0 : 1);
	}
	return cost;
};

/**
 * 估算一条路径的序列化成本：方括号 2，每个字符串段加引号，数字段用字符串长度，段之间加逗号。
 * 输入：Path；输出：近似字符数；副作用：无。
 */
const pathCost = (path: Path): number => {
	let cost = 2;
	for (let index = 0; index < path.length; index++) {
		const segment: Seg = path[index]!;
		cost += (typeof segment === "string" ? segment.length + 2 : String(segment).length) + (index === 0 ? 0 : 1);
	}
	return cost;
};

/**
 * 估算一条 op 在线格式中的近似成本；常量偏移代表动词、括号、引号、逗号等固定开销。
 *
 * 输入：Op；输出：近似字符数；副作用：无。
 * 各分支与 Op 词汇一一对应：r 加整值成本；s 加路径+值；d 路径；a 路径+文本；t 路径+数字；
 * p 路径+起止下标+插入数组；m 路径+置换数字数组。
 */
const operationCost = (operation: Op): number => {
	switch (operation[0]) {
		case "r":
			return 6 + jsonCost(operation[1]);
		case "s":
			return 7 + pathCost(operation[1]) + jsonCost(operation[2]);
		case "d":
			return 6 + pathCost(operation[1]);
		case "a":
			return 7 + pathCost(operation[1]) + operation[2].length + 2;
		case "t":
			return 7 + pathCost(operation[1]) + String(operation[2]).length;
		case "p":
			return (
				10 +
				pathCost(operation[1]) +
				String(operation[2]).length +
				String(operation[3]).length +
				jsonCost(operation[4])
			);
		case "m":
			return 7 + pathCost(operation[1]) + jsonCost(operation[2]);
	}
};

/**
 * 计算从 `before` 到 `after` 的紧凑操作批次。
 *
 * 输入：两份不可变严格 JSON 值（调用方保证无环、无 undefined）；输出：Op 数组。
 * 副作用：无（只读输入；返回的 op payload 可能与 after 共享引用）。
 * 错误：不主动抛错；输入含环会无限递归。
 *
 * 兜底顺序：
 * 1. diff 过程中操作数超过 MAX_DELTA_OPERATIONS：丢弃半成品，返回 [["r", after]]；
 * 2. 没有操作，或第一条就是 r：原样返回（r 只应出现在首位）；
 * 3. 估算增量总成本 < 65_536：直接返回增量；
 * 4. 增量成本不小于快照成本（jsonCost(after)+6）：返回根替换；否则仍返回增量。
 *
 * 例子：diffRevisions({a:1}, {a:2}) 返回 [["s",["a"],2]]；
 * 差异巨大时返回 [["r", after]]，保证消费方仍能得到正确结果。
 */
/** Compute a compact operation batch from two immutable JSON revisions. */
export function diffRevisions(before: JsonValue, after: JsonValue): Op[] {
	const operations: Op[] = [];
	// 从根路径开始；根上的字符串/数组/对象变化由 diffValue 分派。
	diffValue(before, after, [], operations);
	// 溢出：emitOperation 已停止写入，这里丢弃半批，改用整值替换。
	if (overflowedBatches.has(operations)) return [["r", after]];
	// 空批次或已经是根替换：直接返回；避免对 r 再包一层成本判断。
	if (operations.length === 0 || operations[0]?.[0] === "r") return operations;
	// 估算增量成本：op 成本之和，加上数组本身的 2 个字符和每条 op 的逗号分隔。
	let deltaCost = 2;
	for (const operation of operations) deltaCost += operationCost(operation) + 1;
	// 小增量无条件使用；大增量才有必要和快照比较。
	if (deltaCost < 65_536) return operations;
	const snapshotCost = jsonCost(after) + 6;
	return deltaCost >= snapshotCost ? [["r", after]] : operations;
}
