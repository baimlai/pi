// The JavaScript evaluator of the compiled table vocabulary (slice 6a §6; rule 10): the `tx.get` overlay matches
// `where` nodes and applies `set` nodes with SQL's three-valued `NULL` rules and code point text order, as the SQL
// that `sql.ts` renders from the same nodes does in SQLite.

// 文件导读
// 所属：packages/chord/src/store（store 层，编译后表词汇的 JavaScript 求值器）。
// 职责边界：在内存 overlay 上求值 WhereNode/SetNode，模拟 SQL 三值逻辑与码点文本序；不生成 SQL、不访问数据库。
// 上游：TableChanges 的 get/update/deleteWhere 在事务 overlay 上调用 matches/applySet。下游：expression.ts 的节点类型与 text.ts 的 compareText；结果进入 overlay/StoreWrite。
// 能力清单：
// - EvaluatedRow：求值用的行，缺列即 NULL；
// - Truth（内部）：SQL 三值 true/false/null；
// - matches：WhereNode 是否命中（unknown 不算命中）；
// - compareScalar：与 SQLite 一致的单元格比较；
// - applySet：同时求值所有 set 右侧，得到新行；
// - truth/evaluate/both/either（内部）：递归求值与三值逻辑。
// 组合顺序：overlay 读取调用 matches -> updateWhere 对命中的行 applySet -> evaluate 递归算出新值 -> 写回 overlay；算术越界抛 invalid/args。
// 示例：matches({ eq: ["n", 2] }, { n: 2 }) 为 true；applySet({ a: { col: "b" }, b: { col: "a" } }, { a: 1, b: 2 }, "t") 得到 { a: 2, b: 1 }（同时求值）。
// 建议阅读顺序：EvaluatedRow/Truth -> matches/truth -> compareScalar -> applySet/evaluate。
import { invalid } from "../data/internal.ts";
import type { JsonValue } from "../json.ts";
import type { Comparison, ExprNode, Operation, SetNode, WhereNode } from "./expression.ts";
import type { Scalar } from "./rows.ts";
import { compareText } from "./text.ts";

/** A row as the evaluator reads it: stored cells, an absent column being `NULL`. */
export type EvaluatedRow = { readonly [column: string]: Scalar | JsonValue | undefined };

/** SQL's three-valued truth: `null` is unknown (a comparison with `NULL`). */
type Truth = boolean | null;

/** Whether `row` matches `node` under SQL's rules: unknown (`NULL`) does not match. */
// 判断行是否满足条件；输入编译后的 WhereNode 与行，输出 boolean；无 I/O。
// 示例：matches({ eq: ["n", 2] }, { n: 2 }) 返回 true；与 NULL 比较则返回 false（未知不算命中）。
export function matches(node: WhereNode, row: EvaluatedRow): boolean {
	return truth(node, row) === true;
}

// 递归求值 WhereNode，返回 SQL 三值 true/false/null；无副作用。
// 例如 not(null) 仍是 null，inArray 空数组恒为 false。
function truth(node: WhereNode, row: EvaluatedRow): Truth {
	// and：短路求值；任一 false 立即 false，否则若有 null 得 null。
	if ("and" in node)
		return node.and.reduce<Truth>((all, each) => (all === false ? false : both(all, truth(each, row))), true);
	// or：任一 true 立即 true，否则若有 null 得 null。
	if ("or" in node)
		return node.or.reduce<Truth>((any, each) => (any === true ? true : either(any, truth(each, row))), false);
	// not 保持三值：not(null) 仍为 null。
	if ("not" in node) {
		const inner = truth(node.not, row);
		return inner === null ? null : !inner;
	}
	// isNull 对缺列/NULL 为 true；本求值器用 undefined 表示 NULL。
	if ("isNull" in node) return row[node.isNull] === undefined;
	// The row is checked against the table the condition was compiled for: its columns hold scalars.
	// inArray 先把空数组定为 false（SQLite 语义），再逐个 compareScalar。
	if ("inArray" in node) {
		const [column, values] = node.inArray;
		// SQL: `x IN ()` is false, for a `NULL` x too.
		if (values.length === 0) return false;
		const value = row[column] as Scalar | undefined;
		// NULL 参与 IN 比较得 null；值相等即命中。
		return value === undefined ? null : values.some((each) => compareScalar(value, each) === 0);
	}
	// prefix 作用于已编译为 str 的列；NULL 得 null。
	if ("prefix" in node) {
		const value = row[node.prefix[0]] as string | undefined;
		return value === undefined ? null : value.startsWith(node.prefix[1]);
	}
	// The remaining nodes are the comparisons, one entry each; `Object.entries` loses that.
	// 剩余节点都是比较运算，每节点恰有一个键；解构出运算符与 [列, 右值]。
	const [op, [column, operand]] = Object.entries(node)[0] as [Comparison, readonly [string, Scalar]];
	const value = row[column] as Scalar | undefined;
	// 与 NULL 比较的结果是未知（null）。
	if (value === undefined) return null;
	// 只比较一次，再把顺序映射到六个运算符。
	const order = compareScalar(value, operand);
	// order < 0 / = 0 / > 0 分别对应 lt/lte/eq/ne/gt/gte。
	switch (op) {
		case "eq":
			return order === 0;
		case "ne":
			return order !== 0;
		case "lt":
			return order < 0;
		case "lte":
			return order <= 0;
		case "gt":
			return order > 0;
		case "gte":
			return order >= 0;
	}
}

// SQL and 的三值表：false 优先，其次 null，最后 true。
function both(a: Truth, b: Truth): Truth {
	if (a === false || b === false) return false;
	return a === null || b === null ? null : true;
}

// SQL or 的三值表：true 优先，其次 null，最后 false。
function either(a: Truth, b: Truth): Truth {
	if (a === true || b === true) return true;
	return a === null || b === null ? null : false;
}

/** Orders two cells of one column as SQLite does: text by code point, booleans as 0 and 1, numbers numerically. */
// 按列类型比较两个标量，返回负数/0/正数；与 SQLite 的排序一致。
// 文本走 compareText（码点序），布尔转 0/1，数字直接相减。
export function compareScalar(a: Scalar, b: Scalar): number {
	// 不用 localeCompare，避免顺序随语言环境变化。
	if (typeof a === "string") return compareText(a, b as string);
	// 布尔在这里变成 0/1；差值符号就是顺序。
	return Number(a) - Number(b);
}

// 安全整数上界；add/sub 结果超出 ±SAFE 视为列 CHECK 失败。
const SAFE = Number.MAX_SAFE_INTEGER;

/**
 * `row` after `set`, every right side evaluated against `row` (simultaneous: `{ a: b, b: a }` swaps); an integer
 * result outside ±(2^53 - 1) throws `invalid/args` (rule 10), as the column's `CHECK` fails the step.
 */
// 对行应用 set：所有右侧都基于原 row 同时求值，返回新对象；不修改输入。
// 示例：set { a: b, b: a } 交换两列；结果为 undefined 表示该列变 NULL。
export function applySet(set: SetNode, row: EvaluatedRow, table: string): EvaluatedRow {
	// 浅拷贝；JSON 值按 same-host 不可变约定不复制。
	const next: { [column: string]: Scalar | JsonValue | undefined } = { ...row };
	// 遍历顺序不影响结果，因为每个右侧只读原 row。
	for (const [column, node] of Object.entries(set)) {
		const value = evaluate(node, row, table);
		// undefined 代表 NULL：overlay 行用缺列表达，delete 与读取约定一致。
		if (value === undefined) delete next[column];
		else next[column] = value;
	}
	return next;
}

// 递归求值 set 右侧表达式；返回标量/JSON/undefined；算术越界抛 invalid/args。
// 例如 add(col(a), 1) 对 { a: 2 } 返回 3；列缺失则返回 undefined。
function evaluate(node: ExprNode, row: EvaluatedRow, table: string): Scalar | JsonValue | undefined {
	// null 节点代表 SQL NULL。
	if (node === null) return undefined;
	// 非对象即标量字面量；类型在编译阶段已检查。
	if (typeof node !== "object") return node;
	// 列引用；缺列或 undefined 即 NULL。
	if ("col" in node) return row[node.col];
	// JSON 字面量原样返回。
	if ("json" in node) return node.json;
	// when(condition,a,b) 只求选中分支，避免另一分支的越界错误。
	if ("when" in node) {
		const [condition, a, b] = node.when;
		return evaluate(matches(condition, row) ? a : b, row, table);
	}
	// coalesce 用 ??：null/undefined 才回退到第二项。
	if ("coalesce" in node) return evaluate(node.coalesce[0], row, table) ?? evaluate(node.coalesce[1], row, table);
	// replacePrefix 只在值以 from 开头时替换；NULL 保持 NULL。
	if ("replacePrefix" in node) {
		const [subject, from, to] = node.replacePrefix;
		const value = evaluate(subject, row, table) as string | undefined;
		return value === undefined || !value.startsWith(from) ? value : to + value.slice(from.length);
	}
	// The remaining nodes are the arithmetic and text operations, one entry each, over scalar operands (compiled so).
	// 剩余是二元运算 concat/max/min/add/sub，每节点一个键。
	const [op, [x, y]] = Object.entries(node)[0] as [Operation, readonly [ExprNode, ExprNode]];
	const a = evaluate(x, row, table) as Scalar | undefined;
	const b = evaluate(y, row, table) as Scalar | undefined;
	// 任一操作数为 NULL，结果就是 NULL（SQL 规则）。
	if (a === undefined || b === undefined) return undefined;
	// max/min 复用 compareScalar；add/sub 单独检查安全整数范围。
	switch (op) {
		case "concat":
			return (a as string) + (b as string);
		case "max":
			return compareScalar(a, b) >= 0 ? a : b;
		case "min":
			return compareScalar(a, b) <= 0 ? a : b;
		default: {
			// as number 依赖编译阶段保证 add/sub 的两侧是数字。
			const result = op === "add" ? (a as number) + (b as number) : (a as number) - (b as number);
			// 越界结果无法精确存储，按 invalid/args 让步骤失败。
			if (result > SAFE || result < -SAFE)
				throw invalid("args", `${table}: ${op} gives ${result}, outside ±(2^53 - 1)`);
			return result;
		}
	}
}
