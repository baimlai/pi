// Table helpers for `compose` (slice 8 §1, Q8): a map by key (the first by plugin name wins, duplicates reported) and
// an ordered list; both keep each item's plugin, so a use site reports the contributor of an entry that throws.

// 文件导读
// 所属包与模块：packages/chord/src/registries 的表处理辅助模块（slice 8 §1，Q8）。
// 职责边界：把“多个贡献者各自提供的键值表/列表”摊平成 compose 可用的 Map 或数组，并保留来源插件；
// 不做合成决策之外的事：不读取 source、不注册依赖、不抛错（冲突通过 report 回调上报）。
// 上游：定义者插件的 provider.compose 调用 keyedEntries/orderedEntries，table 由 RegistryRecord 传入。
// 下游：返回的 TableItem 被 compose 组装成最终 V；错误报告最终进入 host 的 onError。
// 能力清单：
// - TableItem<I>（类型）：带 value/plugin/type 的条目包装，用于追溯贡献者。
// - keyedEntries（函数）：按键合并为 Map，重复键先到者胜并上报。
// - orderedEntries（函数）：拼接为列表，可按 orderOf 稳定排序。
// 组合关系与典型调用顺序：record 排序表 -> compose 对每个贡献调用 entriesOf/itemsOf -> 辅助函数摊平 ->
// compose 基于结果构造 V。典型用法是 routes（键值）与 middleware（有序列表）。
// 示例（真实签名）：const routes = keyedEntries(table, (c) => c.routes, context.report);
// const steps = orderedEntries(table, (c) => c.steps, (step) => step.phase);
// 建议阅读顺序：先读 TableItem，再看 keyedEntries 的冲突规则，最后 orderedEntries 的稳定排序。

import type { ComposeContext, RegistryTable } from "./registry.ts";

/** An item taken from a table, with the contributor it came from. */
// 表项包装：value 是贡献的具体条目；plugin/type 标明来源，用于错误报告与调试。
// type 可选：facet 贡献没有对象类型。
export type TableItem<I> = { readonly value: I; readonly plugin: string; readonly type?: string };

/**
 * A map of every entry's keyed items (`entriesOf`, e.g. its routes), in table order: a key taken already is reported
 * through `report` (`compose`'s) naming both plugins, and the first by plugin name keeps it.
 */
// 关键规则：表已按插件名排序（record.ts 保证），所以“先到者”就是插件名更小者。
// 输入：table、entriesOf（从贡献值取出键值表，可返回 undefined 表示该贡献不参与）、report。
// 输出 ReadonlyMap：类型层只读，运行时仍是普通 Map。
// 错误路径：重复键不抛错，而是调用 report 并保留先到项。
// 示例：两个插件都提供 "GET /users" 时，report 收到 plugins: [先到插件, 后到插件]。
export function keyedEntries<C, I>(
	table: RegistryTable<C>,
	entriesOf: (value: C) => Readonly<Record<string, I>> | undefined,
	report: ComposeContext["report"],
): ReadonlyMap<string, TableItem<I>> {
	const map = new Map<string, TableItem<I>>();
	// 按表顺序遍历；record 已按 plugin 名、再按 type 排序。
	for (const entry of table) {
		const items = entriesOf(entry.value);
		// undefined 表示该贡献不提供键值项，直接跳过。
		if (items === undefined) continue;
		// Object.entries 只枚举自有可枚举字符串键；返回 [key, value] 元组数组。
		for (const [key, value] of Object.entries(items)) {
			const taken = map.get(key);
			if (taken !== undefined) {
				// 上报冲突但不覆盖先到项；消息中引用键名，plugins 保留双方来源。
				report({ message: `"${key}" is contributed twice`, plugins: [taken.plugin, entry.plugin] });
				continue;
			}
			map.set(key, item(value, entry.plugin, entry.type));
		}
	}
	return map;
}

/**
 * Every entry's items (`itemsOf`) in one list: in table order, or sorted by `orderOf` (a phase's index, for example),
 * table order kept among equals.
 */
// 输入：table、itemsOf（取出该贡献的条目数组，可 undefined）、可选 orderOf。
// 输出：按表顺序拼接的 TableItem 数组；若给 orderOf，则按其数值升序稳定排序。
// 示例：中间件按 phase 排序时，orderOf(item) 返回 phase 索引；相同 phase 保持表顺序（插件名序）。
export function orderedEntries<C, I>(
	table: RegistryTable<C>,
	itemsOf: (value: C) => readonly I[] | undefined,
	orderOf?: (item: I) => number,
): readonly TableItem<I>[] {
	const items: TableItem<I>[] = [];
	for (const entry of table) {
		// ?? [] 处理不提供列表的贡献；展开后逐项包装来源。
		for (const value of itemsOf(entry.value) ?? []) items.push(item(value, entry.plugin, entry.type));
	}
	// `sort` is stable: equal orders keep table order.
	// 稳定排序是 ECMAScript 规范保证的，因此相同 order 的项保持上一步的插入顺序。
	if (orderOf !== undefined) items.sort((a, b) => orderOf(a.value) - orderOf(b.value));
	return items;
}

// 内部小工具：type 为 undefined 时不写该键，使普通贡献者的表项形状更小。
// 只在两个导出函数中使用，不对外导出。
function item<I>(value: I, plugin: string, type: string | undefined): TableItem<I> {
	return type === undefined ? { value, plugin } : { value, plugin, type };
}
