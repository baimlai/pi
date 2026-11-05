// 验证注册表 compose 辅助函数：按键选首个贡献，以及带来源的稳定排序。
import { describe, expect, it } from "vitest";
import { keyedEntries, orderedEntries, type RegistryConflict, type RegistryTable } from "../../src/registries/index.ts";

// 定义三项贡献夹具：泛型描述贡献值；readonly 限制开发时写入，? 表示字段可省略。
// Record<string,string> 是字符串键值表；此数组已按插件名排序，辅助函数不会替调用者重新排序表。
const table: RegistryTable<{ readonly routes?: Readonly<Record<string, string>>; readonly items?: readonly string[] }> =
	[
		// 首个 facet 贡献两个路由和两个列表项，用来占据重复键 /x。
		{ plugin: "@a/one", version: 1, value: { routes: { "/x": "one", "/y": "one" }, items: ["late", "first"] } },
		// 第二项来自对象 b.store；重复 /x，并提供另一个同优先级列表项。
		{ plugin: "@b/two", type: "b.store", version: 1, value: { routes: { "/x": "two" }, items: ["second"] } },
		// 第三个贡献不提供 routes/items，检验可选集合缺省时被跳过。
		{ plugin: "@c/three", version: 1, value: {} },
	];

// 登记按键合并测试；下面只调用纯内存辅助函数，不启动 host。
describe("keyedEntries", () => {
	// 用上面的有序贡献表检查路由合并与冲突回调；无输入、无业务返回。
	// 例如 /x 同时出现时保留 one，并把两个插件名记入 conflicts；副作用只在此局部数组。
	it("maps every entry's keys with their plugin; a duplicate is reported and the first by plugin name keeps it", () => {
		// 创建类型受约束的冲突记录数组；后面回调把运行时冲突存入其中。
		const conflicts: RegistryConflict[] = [];
		// 执行合并，返回保留来源信息的只读 Map。
		const map = keyedEntries(
			// 把已排序的贡献表作为第一个实参。
			table,
			// 提取每项可选 routes；undefined 由辅助函数跳过。
			(value) => value.routes,
			// 报告回调接收一次重复键事件并追加记录；push 的返回数字不作为合并结果。
			(conflict) => conflicts.push(conflict),
		);
		// 用展开运算符把 Map 变成有序 [键,值] 数组，深度比较全部合并结果。
		expect([...map]).toEqual([
			// /x 应归第一个贡献者，第二个值 two 不覆盖它。
			["/x", { value: "one", plugin: "@a/one" }],
			// 无冲突的 /y 也必须保留，并携带来源插件。
			["/y", { value: "one", plugin: "@a/one" }],
		]);
		// 确认恰好报告一次冲突，消息含键，插件列表按首次占用者、后来冲突者排列。
		expect(conflicts).toEqual([{ message: '"/x" is contributed twice', plugins: ["@a/one", "@b/two"] }]);
	});
});

// 登记列表展开与排序两种机制。
describe("orderedEntries", () => {
	// 不传排序函数时按表顺序展开列表；无外部副作用。
	// 实际例子 late/first/second 保持原顺序，只有对象贡献带 type。
	it("lists every entry's items in table order, with their plugin and type", () => {
		// 提取 items 并比较全部条目，检验每项携带正确来源。
		expect(orderedEntries(table, (value) => value.items)).toEqual([
			// 首个列表的第一个元素保持第一位。
			{ value: "late", plugin: "@a/one" },
			// 元素名 first 本身不参与默认排序，仍位于 late 后面。
			{ value: "first", plugin: "@a/one" },
			// 对象贡献的条目额外保留 type，方便使用处定位来源对象。
			{ value: "second", plugin: "@b/two", type: "b.store" },
		]);
	});

	// 传数字优先级函数验证稳定排序：first 提前，另两项同分保持表内次序。
	// 回调无输入和返回数据，所有计算在内存完成；结果必须是 first/late/second。
	it("sorts by `orderOf`, table order kept among equals", () => {
		// 排序回调接收字符串，三元表达式让 first 返回 0，其余返回 1；不修改元素。
		const order = (item: string) => (item === "first" ? 0 : 1);
		// 先按优先级排序，再用解构参数只取 value，比较顺序而省略来源字段。
		expect(orderedEntries(table, (value) => value.items, order).map(({ value }) => value)).toEqual([
			// 优先级 0 的元素排在最前。
			"first",
			// late 和 second 同为 1，仍按原表顺序排列。
			"late",
			// 第二个插件的同优先级元素留在 late 后。
			"second",
		]);
	});
});
