// 所属：packages/durable/src/harness，Durable harness 的“流式消息增量写入”模块，服务于 pi.live 的进度提交。
// 解决的问题：Chord 把一次容器赋值记为一个整体 set；若每次节流提交都重写整条助手消息，就会反复比较并发布完整文本。
// 职责边界：只原地修改调用方给的草稿目标，不提交事务、不持久化、不校验 schema、不生成计划（计划由 PartialChanges 生成）。
// 上游：generation.ts 的 streamResponse()/PartialChanges，每次节流提交传入消息副本与 AssignPlan。
// 下游：Chord delta 草稿；字符串可走 appendText 记录追加，其余叶子走普通赋值，错误由外层事务处理。
// 能力清单：
// - AssignPlan：三种写入计划（append 追加文本、keep 交给调用方写、fields 容器成员子计划）；
// - assignJson(target, key, value, plan?)：按计划把 value 写入 target[key]，逐叶合并对象、复用只增长的数组、
//   删除新值中已不存在的成员；无返回值，异常直接抛出。
// 典型顺序：PartialChanges.diff() 产生计划 → assignJson 写入 pi.live 草稿 → position 记录新消息 → 事务提交。
// 示例：assignJson(generation, "message", next, { kind: "fields", fields: new Map([["text", { kind: "append", text: "!" }]]) })
//   其中 generation 是 pi.live.generation 的草稿；在已提交文本加上新增文本的长度吻合时只记录追加，不吻合时退回整体赋值。示例描述调用形状，计划实际由调用方构造。
// 建议阅读顺序：先读 AssignPlan 三个分支的含义，再读 assignJson 的 keep/对象/数组/追加/最终严格赋值五段。
import { appendText, type Draft } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord/json";

// AssignPlan 只描述字符串增量与容器成员；它不描述数值/布尔等标量，标量仍走最后的严格比较赋值。
// 计划在运行时只是普通对象，kind 的判别由本文件的分支检查，TypeScript 不能阻止 JavaScript 调用者伪造 kind。
/** How `assignJson()` writes one value instead of assigning it leaf by leaf. */
// kind 是判别字段：append 提供新增文本，keep 交给别处写，fields 为对象成员或数组下标分别给计划。
// ReadonlyMap 只限制调用者通过该类型修改映射，不会在运行时冻结 Map。
export type AssignPlan =
	/** The string grew by `text` since it was last assigned: append it, when the lengths agree. */
	// append：上次提交后字符串只增长了 text，长度吻合时用 appendText 记录追加；长度不吻合说明上游替换了文本，退回整体赋值。
	| { readonly kind: "append"; readonly text: string }
	/** Leave the value as it is; the caller writes it. */
	// keep：调用方（PartialChanges 的工具参数部分）自行写入该值，assignJson 既不该读取也不该覆盖它。
	| { readonly kind: "keep" }
	/** Plans for some members or items of a container. */
	// fields：对象成员或数组下标的子计划；Map 的键类型允许对象字符串键和数组数字下标。ReadonlyMap 是编译期只读视图。
	| { readonly kind: "fields"; readonly fields: ReadonlyMap<string | number, AssignPlan> };

// assignJson 的典型调用：assignJson(generation, "message", 消息副本, 计划)，target 是 pi.live.generation 的草稿，key 为 "message"。
// 副作用包括：删除新值中已不存在的对象成员、复用数组、追加字符串、调用 appendText；出错时异常交给事务提交方处理。
// 注意它不是 JSON Patch 库：只处理“旧容器 + 新值”的形状，不验证值是否符合某个 schema。
/**
 * Assign `value` at `target[key]` leaf by leaf. Chord records a container assignment as one full set and only emits an
 * append when a string leaf is reassigned with a longer string, so writing the partial whole would store and publish the
 * complete message on every flush. That append costs a compare of the whole string, though; where `plan` says what a
 * string member grew by, and the committed string plus that text has the new string's length, the text is appended
 * with `appendText()` instead.
 */
// 输入可写目标、键、该键对应的 JSON 值和可选增量计划；原地修改目标，无返回值，也不持久化事务。
// 例如旧 { text: "a" } 写入 "ab" 并给 append("b") 可记录追加操作；对象逐叶合并、只增长的数组复用原容器。
// 泛型 K 限制为 T 的字符串/数字键，& JsonValue 要求值是 JSON；运行时仍需分辨 JSON 联合类型的容器分支。
export function assignJson<T extends object, K extends keyof T & (string | number)>(
	target: T,
	key: K,
	value: T[K] & JsonValue,
	plan?: AssignPlan,
): void {
	// keep 表示调用方另有专用写法，连当前值也不读取。
	if (plan?.kind === "keep") return;
	// Every target is a document container: JSON members or items, whatever its declared type names them.
	// as 是编译期断言：把文档草稿当成字符串/数字索引的 JSON 记录；不会创建副本，也不会做运行时类型转换。
	const slots = target as Record<string | number, JsonValue>;
	// A `__proto__` member the target lacks reads through to Object.prototype; merging into that would pollute every
	// object in the process. Other inherited members are functions, which are not merged into.
	const current: JsonValue | undefined = key === "__proto__" && !Object.hasOwn(slots, key) ? undefined : slots[key];
	// 仅 fields 分支提供逐成员计划；?. 在子字段没有计划时让递归走普通比较路径。
	const fields = plan?.kind === "fields" ? plan.fields : undefined;
	// 两边都是非数组对象，保留旧对象身份，删除新值不再有的自有属性，再逐成员递归。
	if (isRecord(current) && isRecord(value)) {
		// Object.keys 只遍历自有可枚举键；hasOwn 防止把原型上的同名字段当作新值的成员。
		for (const name of Object.keys(current)) if (!Object.hasOwn(value, name)) delete current[name];
		// entries 同时得到键和值，递归把对应字段计划传下去。
		for (const [name, child] of Object.entries(value)) assignJson(current, name, child, fields?.get(name));
		// 已原地处理，不能再用整个对象覆盖一次。
		return;
	}
	// 数组只在不缩短时复用；缩短的数组落到末尾整体赋值，避免留下旧尾项。
	// 两个 Array.isArray 都成立才复用；current 缩短时保留旧尾项会破坏语义，所以让末尾整体赋值解决。
	if (Array.isArray(current) && Array.isArray(value) && current.length <= value.length) {
		// current 经数组分支收窄；把元素按 JSON 值处理。
		const items = current as JsonValue[];
		// 每个新下标恰好处理一次；! 告诉 TS 循环边界已保证该项存在，不产生运行时检查。
		for (let index = 0; index < value.length; index++) {
			// 已有位置递归写，新增位置直接 push。
			if (index < items.length) assignJson(items, index, value[index]!, fields?.get(index));
			else items.push(value[index]!);
		}
		return;
	}
	// 仅对象中的字符串字段可用 appendText；长度吻合是使用给定增量计划的条件，不会再比较整个前缀。
	if (
		plan?.kind === "append" &&
		typeof current === "string" &&
		typeof value === "string" &&
		!Array.isArray(target) &&
		current.length + plan.text.length === value.length
	) {
		// 同一行里的 as 把 target 断言为“字符串值对象”的 Draft；前面的 typeof 检查与 target 非数组条件已经保证了实际形状。
		// The cast names what the checks above established: `target[key]` is a string.
		appendText(target as Draft<Record<string, string>>, String(key), plan.text);
		// 追加已完成，避免把完整字符串再设置一遍。
		return;
	}
	// 容器类型不匹配、数组缩短或没有可用计划时，只有严格不相等才赋值；底层 Draft 记录变更。
	// 只有严格不相等才写：JSON 值可能是对象，用 !== 比较引用而不是深比较；不同引用的相等对象仍会写入。
	if (current !== value) slots[key] = value;
}

// 类型谓词 value is Record<string, JsonValue> 让调用方在条件成立后按字符串键访问；运行时只检查 object/null/数组。
// 判断 JSON 联合值是否为非 null、非数组的对象，供递归选择对象分支；例如 {} 为真，null 和 [] 为假。
// value is ... 是类型谓词，运行时执行三个条件，成功后 TypeScript 才允许按字符串键访问。
function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
	// typeof null 也是 object，因此必须单独排除；数组另走下标合并分支。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
