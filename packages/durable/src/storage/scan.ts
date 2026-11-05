// 文件导读
// ========
// 所属：packages/durable/src/storage 的共享分页辅助层，不属于某一个后端，被 MemoryStorage、
// IndexedDbStorage，以及同目录的 sqlite/storage.ts、store/storage.ts 和 JSONL 包装层共同复用。
//
// 解决的问题：Storage 的每个 scan* 方法都接收 query.order、limit 和上一页返回的游标，
// 各后端必须对“从哪开始、朝哪个方向、游标能否继续”给出相同答案，否则同一游标在内存后端
// 与 IndexedDB 后端会翻出不同的页。本文件把这类纯计算集中起来，不做 I/O、不持有状态。
//
// 职责边界：只解释分页参数并生成下一页游标；不校验 ID 是否存在，不检查 limit 正负
// （由各存储的扫描循环处理），也不序列化查询条件。scanStart 对非法输入抛
// StorageRequestError——按 Storage 契约这是请求级错误，只让该次读取失败；nextCursor 不抛错。
//
// 上游入口：各存储实现在打开游标前调用 scanStart(query.order, cursor, 默认方向)，
// 在页满时对末项调用 nextCursor(lastItem.id, order) 生成 Page.next；调用方只把游标原样
// 交回下一次同一扫描，不解析其字段。
//
// 能力清单：
// - ScanStart：解析后的起点，含最终方向 order 与排他位置 after。
// - scanStart(requested, cursor, fallback)：合并显式方向、游标与默认方向；拒绝中途反转方向。
// - nextCursor(id, order)：由上一页末项的品牌 ID 生成可 JSON 序列化的游标。
//
// 组合与典型顺序：调用方用 query.order 和上次游标调用 scanStart 得到起点；后端按键范围取
// limit+1 条判断是否还有下一页；页满时用末项调用 nextCursor 放进 Page.next；下一次调用把
// 该对象作为 cursor 传回 scanStart。
//
// 示例（真实签名）：
//   const start = scanStart("ascending", { after: 8, order: "ascending" }, "descending");
//   // start = { order: "ascending", after: 8 }
//   const next = nextCursor(idFromNumber<EntryId>(12), start.order);
//   // next = { after: 12, order: "ascending" }
//   scanStart("descending", next, "descending"); // 抛 StorageRequestError：方向不能反转
//
// 建议阅读顺序：先读 ScanStart 的两个字段，再读 scanStart 的分支顺序（无游标、旧游标、
// 方向冲突），最后读 nextCursor。readonly 与 Id/ScanOrder 品牌都只在编译期生效，运行时是
// 普通对象和字符串。
//
// 测试：没有独立的 scan.test.ts；行为由 test/memory-storage.test.ts、test/indexeddb-storage.test.ts
// 通过 src/testing/storage-conformance.ts 注册的公共存储契约覆盖（分页续扫、游标携带方向、
// 方向冲突拒绝）。运行：在 packages/durable 下
//   node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/memory-storage.test.ts
//
// 统一内置存储的分页起点；游标只记录位置和方向，不承担查询条件的序列化。
import { StorageRequestError } from "../errors.ts";
import type { Id, ScanOrder } from "../types.ts";

// 扫描起点：order 决定键范围的遍历方向，after 是排他位置（上一页最后一项的 ID）。
/** Where a built-in storage scan starts: its order and the last ID a previous page returned. */
// readonly 只让 TypeScript 禁止经此类型赋值，运行时并不会自动冻结对象。
export type ScanStart = {
	// ascending 按 ID 从小到大，descending 从大到小。
	readonly order: ScanOrder;
	// 上一页最后一项的 ID；undefined 表示第一页。
	readonly after: number | undefined;
};

/**
 * Resolve a scan's order and position. A cursor continues in the order it was created with, whether the query repeats
 * that order or omits it; a different `order` throws. A cursor without an order, written before scans had one,
 * continues in the scan's default order.
 */
// 把请求方向、可选游标和默认方向合为起点，不修改输入；无游标时取请求方向或默认值。
// 有游标则校验其数字位置和方向，并拒绝中途反转方向；这是存储读取参数的运行时边界，
// 不是 TypeScript 类型声明自动提供的保护。返回普通对象，错误以 StorageRequestError 抛给调用者。
// 例：requested 为 undefined、cursor 为 {after: 5, order: "descending"} 时，从 5 之后向小 ID 继续。
// 参数：requested 是本次查询的显式方向，可省略；cursor 是上一页返回的 JSON 记录，可省略；
// fallback 是后端为这类扫描选定的默认方向（会话/任务/提交升序，条目降序）。
export function scanStart(
	requested: ScanOrder | undefined,
	cursor: Readonly<Record<string, unknown>> | undefined,
	fallback: ScanOrder,
): ScanStart {
	// 即使 TS 调用方只能传联合类型，这里仍按存储请求边界检查实际传入值。
	if (requested !== undefined && requested !== "ascending" && requested !== "descending") {
		// String 把错误值显示在消息里；读取错误只应使该次读取失败。
		throw new StorageRequestError(`Invalid scan order: ${String(requested)}`);
	}
	// ?? 只在左边是 null/undefined 时取右边，不把合法方向字符串当作缺省值。
	if (cursor === undefined) return { order: requested ?? fallback, after: undefined };
	// 解构时把游标的 order 重命名为 stored，区分稍后求出的有效方向。
	const { after, order: stored } = cursor;
	// JSON 游标来自调用方；安全整数检查排除小数、NaN、Infinity 和失去精度的数字。
	if (typeof after !== "number" || !Number.isSafeInteger(after))
		throw new StorageRequestError("Invalid storage cursor");
	// 兼容没有 order 字段的旧游标；存在该字段时只接受两个定义过的方向。
	if (stored !== undefined && stored !== "ascending" && stored !== "descending") {
		throw new StorageRequestError("Invalid storage cursor");
	}
	// 旧游标缺少方向时按此扫描的默认方向解释，不按这次 requested 任意改向。
	const order = stored ?? fallback;
	// 查询显式方向必须与游标相同，否则可能跳过或重复历史记录。
	if (requested !== undefined && requested !== order) {
		throw new StorageRequestError(`The cursor continues a ${order} scan; the query asks for ${requested}`);
	}
	// after 在上面的检查后被 TS 收窄为 number；order 也收窄为 ScanOrder。
	return { order, after };
}

/** The continuation of a scan whose last returned item has `id`. */
// 输入上一页末项的带品牌 ID 和方向，返回可 JSON 序列化的下一页游标；不做 I/O 或额外校验。
// Id 的品牌只在编译期区分数字用途，实际 after 仍是数字。例如 ID 8、ascending 得到 {after: 8, order: "ascending"}。
export function nextCursor(id: Id<string>, order: ScanOrder): { readonly after: number; readonly order: ScanOrder } {
	// 将记录 ID 改用游标字段名保存；下次扫描会排除这个已经返回过的 ID。
	return { after: id, order };
}
