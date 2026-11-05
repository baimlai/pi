// 文件导读
// 所属包与模块：packages/chord/src/data 的身份模块（layer-1），服务 Chord 的对象身份与权限判定。
// 职责边界：把应用提供的 principal 转成稳定字符串键，并做两层弱缓存；不认证身份、不持久化 principal、
// 不做权限检查（上层使用键做判定）。上游：host 收到带身份的调用时调用 principalKey；应用可注册自定义键函数。
// 下游：principalKey 的结果进入 identityKey（见 params.ts），决定对象/文档身份；canonicalJson 用于稳定比较。
// 错误流向：默认路径不抛错；自定义键函数的错误原样传播；若绕过类型传入非 JSON，canonical 行为不保证。
// 能力清单：
// - Principal（类型）：带 kind 的 JSON 字段表，应用身份的最小形状。
// - PrincipalKeyFunction<P>（类型）：把身份映射成字符串的函数契约。
// - principalKey（函数）：按 principal 身份与可选自定义函数缓存并返回键。
// - canonicalJson（函数）：稳定 JSON 序列化（键排序、-0 归一），并计一次 walk。
// 组合关系与典型调用顺序：principalKey -> 命中 WeakMap 或计算 -> 默认 canonicalJson / 自定义函数 ->
// 结果进入 identityKey。缓存分默认与按函数两层，避免活着的 principal 留住已丢弃的函数。
// 示例（真实签名）：const key = principalKey({ kind: "user", id: "u1" }, context);
// const key2 = principalKey(user, context, (p) => `${p.kind}:${p.id}`);
// 建议阅读顺序：先 Principal 与 PrincipalKeyFunction，再看 principalKey 的缓存选择，然后 canonicalJson/canonical，
// 最后两个 WeakMap 与 customKeyCache 的 GC 设计。

// Principals: the app's caller identities, and the keys Chord derives from them.

import type { Context } from "../context/index.ts";
import type { JsonValue } from "../json.ts";

/** An app's principal: plain JSON with a `kind`. Chord never persists it. */
// Principal 是带 kind 的 JSON 字段表；readonly 只限制 TS 赋值，不会冻结运行时对象，身份由上层认证链路提供。
export type Principal = { readonly kind: string; readonly [field: string]: JsonValue };

/** An app's own principal key; it must be the same function on every host. */
// 函数类型把具体身份 P 映成字符串；所有主机应采用相同规则，否则相同用户会被当成不同对象身份。
export type PrincipalKeyFunction<P extends Principal = Principal> = (principal: P) => string;

/**
 * The key of a principal: its canonical JSON, or `customKey(principal)`. Cached per principal object; a custom key's
 * cache is keyed by the function too, so a live principal never retains a dropped function.
 */
// 计算并按身份对象缓存 principal key，输入身份/context/可选自定义函数，返回字符串，无 I/O。
// 默认规范化 JSON；例如两个不同对象 {kind:"owner",id:"1"} 得到同样文字，但各缓存一次。
// 同一对象之后若被违规修改仍会命中旧键；自定义函数的错误直接抛出，首次默认计算会记录遍历计数。
export function principalKey<P extends Principal>(
	principal: P,
	context: Context,
	customKey?: PrincipalKeyFunction<P>,
): string {
	// 省略自定义函数就用默认 WeakMap；有函数则按函数身份选择另一份弱缓存。
	const cache = customKey === undefined ? defaultKeys : customKeyCache(customKey);
	// 按对象引用查找，字段相同但引用不同的 principal 不共用这一条缓存。
	let key = cache.get(principal);
	// 只有未缓存才执行实际计算；空字符串是合法已缓存值，不会误当成缺失。
	if (key === undefined) {
		// 默认走 canonicalJson 并计数；自定义函数直接返回键，不额外验证、转义或规范化。
		key = customKey === undefined ? canonicalJson(principal, context) : customKey(principal);
		// 保存计算结果；弱键不会单独延长 principal 对象的生命。
		cache.set(principal, key);
	}
	// 返回本次计算或缓存命中的键。
	return key;
}

// 默认键缓存只以 principal 为弱键；不强引用所有历史身份对象。
const defaultKeys = new WeakMap<Principal, string>();

// 外层弱键是自定义函数，内层弱键是 principal；never 是函数参数类型兼容所用的静态类型，不会成为运行值。
const customKeys = new WeakMap<PrincipalKeyFunction<never>, WeakMap<Principal, string>>();

// 取得某自定义键函数拥有的 WeakMap，首次分配并记入外层弱缓存。
// 例如 fnA 和 fnB 处理同一 principal 时各自缓存；此函数不调用 fnA/fnB，也不做 I/O。
function customKeyCache(customKey: PrincipalKeyFunction<never>): WeakMap<Principal, string> {
	// 以函数引用查缓存，功能相似的两个箭头函数仍是不同键。
	let cache = customKeys.get(customKey);
	// 该函数首次使用时才需要建立内层缓存。
	if (cache === undefined) {
		// 新建 principal→字符串的弱映射，后续交给 principalKey 填充。
		cache = new WeakMap();
		// 函数被回收时外层记录可一起释放，不因活着的 principal 留住旧函数。
		customKeys.set(customKey, cache);
	}
	// 返回可复用的内层缓存。
	return cache;
}

/** Canonical JSON: sorted object keys, `-0` written as `0`. Counts one walk. */
// 把类型已保证为 JSON 的值写成稳定字符串并记录一次遍历计数，不修改输入。
// 例如 {b:2,a:1} 得 {"a":1,"b":2}，数组保留原次序；不在这里验证任意外来对象。
export function canonicalJson(value: JsonValue, context: Context): string {
	// ?. 表示未提供 metrics 能力就跳过；有适配器时把本次规范化遍历计为一次。
	context.telemetry.metrics?.counter("chord.data.walks").add(1);
	// 递归工作交给 canonical，递归层不重复给整次遍历计数。
	return canonical(value);
}

// 递归序列化已知 JSON：标量用 JSON.stringify，数组依次拼接，对象先排序键再递归值。
// 例如 [-0,{z:null,a:true}] 写成 [0,{"a":true,"z":null}]；只分配结果文字和遍历临时数组。
function canonical(value: JsonValue): string {
	// JSON.stringify writes -0 as 0.
	// null 和非对象标量直接序列化；JSON.stringify 会把 -0 写成 0，类型约定排除了 undefined。
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	// 这里只是在 JsonValue 联合中区分数组分支；map 的递归保留元素顺序，不对数组排序。
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	// 对象仅枚举其 JSON 字段，后续按字段名排序以去掉插入次序差异。
	const fields = Object.keys(value)
		// 默认字符串排序，与原字段加入对象的顺序无关。
		.sort()
		// 每项生成 JSON 字符串键和递归值；! 表示这里枚举到的键有值，只影响 TS 检查。
		.map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`);
	// 将字段用逗号连接并包上对象括号；不改变原对象或冻结字段。
	return `{${fields.join(",")}}`;
}
