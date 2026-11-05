// Fingerprints: the normal form of a contract version and its portable 64-bit hash. Not a security boundary.

// 文件导读
// 所属模块：packages/chord/src/contracts，契约指纹与规范形式。
// 解决的问题：链接两端要快速确认“我们说的是同一份契约版本”，因此把版本快照压成稳定的 JSON 再算 64 位哈希。
// 职责边界：只负责规范化和哈希，不做安全校验（碰撞不是威胁模型）、不保存版本、不解析声明。
// 上游：declare()/evolve() 调用 materialize()；下游：链接绑定比较指纹。结果流向 VersionData.fingerprint；
//   错误只可能来自不可序列化的输入，通常由更早的快照检查拦住。
// 能力清单：
// - NORMAL_FORM_VERSION：规范形式版本号，改动序列化规则时必须提升。
// - materialize()：把变体快照组装成规范形式，算出指纹并返回 VersionData。
// - fingerprintOf()：给规范形式加版本外壳并哈希。
// - variantNormal()：把一个变体的 state/keyed/methods 合并成排序字典。
// - sortedDict()：按 UTF-16 码元排序对象键，消除插入顺序差异。
// - hash64()、hex()：两条 32 位 FNV-1a 车道生成 16 位十六进制指纹。
// 组合关系：Snapshot.normal -> variantNormal -> sortedDict -> fingerprintOf -> hash64；materialize 再与
//   原始 variants/changes 一起组成 VersionData。
// 示例：
//   const fp = hash64("abc");                 // 16 个十六进制字符，跨进程稳定
//   const version = materialize("local", params, 1, variants, []); // 带 fingerprint 的版本数据
// 建议阅读顺序：先看 NORMAL_FORM_VERSION 与 materialize 的输入结构，再看 variantNormal/sortedDict 的规范化，
//   最后看 fingerprintOf/hash64/hex 的编码细节。

import type { JsonValue } from "../json.ts";
import { type Kind, LOCAL, type VariantData, type VersionData } from "./contract.ts";
import type { Change } from "./history.ts";
import type { ParamsData } from "./params.ts";

/** Version of the normal form; changing the normal form changes it and is a link-protocol change. */
// 规范形式自身的版本号；改变序列化规则必须同时提升它，否则旧数据会和新规则算出不同指纹却看不出原因。
// 这也是链路协议的一部分：两端必须用同一版本解释。
export const NORMAL_FORM_VERSION = 2;

/**
 * Materializes a version with its fingerprint: `hash64` of `JSON.stringify({ normalFormVersion, value })` over the
 * normal form `{ kind: "remote", params, variants }` or `{ kind: "local", params, members }`.
 */
// 用途：由变体快照生成 VersionData。输入种类、params 数据、版本号、变体表和编辑列表，输出带指纹的版本数据。
// 无外部副作用。local 与 remote 的规范形式不同：local 用 members，remote 用按名字排序的 variants 字典。
// 例子：v2 的指纹变化而 params/变体相同，说明该版本成员确实被编辑过。
export function materialize(
	kind: Kind,
	params: ParamsData,
	version: number,
	variants: ReadonlyMap<string, VariantData>,
	changes: readonly Change[],
): VersionData {
	const normal: JsonValue =
		kind === "local"
			? { kind, params: params.normal, members: variantNormal(variants.get(LOCAL)!) }
			: {
					kind,
					params: params.normal,
					// 变体名排序后再序列化，避免 Map 插入顺序影响指纹。
					variants: sortedDict([...variants].map(([name, v]) => [name, variantNormal(v)])),
				};
	// variants 原样保存在版本里（运行时快照），normal 只用于计算指纹，不进入返回值。
	return { version, fingerprint: fingerprintOf(normal), variants, changes };
}

/** `hash64` of `JSON.stringify({ normalFormVersion, value: normal })`: the fingerprint of a normal form. */
// 把规范形式包进带版本号的对象再序列化，确保版本升级时输入一定不同；JSON.stringify 的键顺序由对象字面量固定。
export function fingerprintOf(normal: JsonValue): string {
	return hash64(JSON.stringify({ normalFormVersion: NORMAL_FORM_VERSION, value: normal }));
}

/**
 * Members as a sorted dictionary of `{ state }`, `{ args, result }` or `{ keyed }` (slice 6a §12: a node of its own,
 * so contracts without keyed members keep their fingerprints and `NORMAL_FORM_VERSION` stays).
 */
// 一个变体的规范形式：state、keyed、methods 都合并进同一个按键排序的字典，成员值用类型标签区分。
// keyed 单独成一个节点，使没有 keyed 成员的旧契约指纹保持不变，不必提升 NORMAL_FORM_VERSION。
function variantNormal({ state, methods, keyed }: VariantData): JsonValue {
	return sortedDict([
		...[...state].map(([member, schema]) => [member, { state: schema.normal }] as const),
		...[...keyed].map(([member, schema]) => [member, { keyed: schema.normal }] as const),
		...[...methods].map(
			([member, { args, result }]) => [member, { args: args.normal, result: result.normal }] as const,
		),
	]);
}

// 按键的 UTF-16 码元比较排序；用 a < b 而不是 localeCompare，保证跨平台一致。
// Object.fromEntries 生成的普通对象保持插入顺序，随后 JSON.stringify 会按这个顺序输出。
function sortedDict(entries: (readonly [string, JsonValue])[]): JsonValue {
	return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** 16 hex characters from two 32-bit FNV-1a lanes (different offset bases and primes) over the UTF-8 bytes. */
// 两条 32 位 FNV-1a 并行计算，拼成 16 位十六进制。不同 offset/prime 不是密码学强度，只用于稳定标识。
// TextEncoder 先把字符串转成 UTF-8 字节，因此非 ASCII 名字也能得到跨平台一致的结果。
export function hash64(text: string): string {
	let low = 0x811c9dc5;
	let high = 0xcbf29ce4;
	for (const byte of new TextEncoder().encode(text)) {
		// Math.imul 做 32 位有符号整数乘法，等价于 C 的 uint32 溢出行为。
		low = Math.imul(low ^ byte, 0x01000193);
		high = Math.imul(high ^ byte, 0x01000197);
	}
	// 高位在前，低位在后，总共 16 个十六进制字符。
	return hex(high) + hex(low);
}

// >>> 0 把有符号结果转回无符号 32 位；toString(16) 可能不足 8 位，用 padStart 左补零。
function hex(lane: number): string {
	return (lane >>> 0).toString(16).padStart(8, "0");
}
