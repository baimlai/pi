// Revocation keys (§4, R10, R11): what `revokedBy` says revokes a principal, as canonical JSON, computed once per
// principal object.
// 本文件负责把“哪些值会撤销这个身份”变成可比较的规范化 JSON 字符串，并在宿主保存身份时按身份对象缓存。
// 上游是 host 的撤销检查（链接或请求携带 revocation key）；结果是一个布尔判断，不修改任何状态，只按需填充 WeakMap。
// 所属模块：packages/chord/src/host 的撤权检查。
// 上下游：Host/链接在验证携带 revocation key 的调用时调用 RevocationKeys.revokes；依赖应用给出的 RevokedBy 与 canonicalJson。
// 结果：布尔值；canonicalJson 遇到不可序列化的值会抛错，由调用方处理。缓存存于 WeakMap，不阻止身份对象回收。
// 能力清单：
// - RevokedBy：应用给出的“身份 -> 撤销值数组”函数类型。
// - RevocationKeys：每个 Host 一份的检查器，构造时接收该函数。
// - revokes：把调用方的 key 与身份算出的每个撤销值比较，命中即撤销。
// 组合关系：new RevocationKeys(revokedBy) -> 每次检查 revokes(principal, key, ctx) -> 首次计算并缓存规范化 JSON。
// 示例：const keys = new RevocationKeys((p) => p.revocations); const revoked = keys.revokes(principal, "abc", ctx);
// 阅读顺序：先看 RevokedBy 的业务含义，再看构造与 WeakMap 缓存，最后读 revokes 的比较逻辑。

import type { Context } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import { canonicalJson } from "../data/internal.ts";
import type { JsonValue } from "../json.ts";

/** What revokes a principal: the app's typed values, the same function on every host. */
// 这是一个泛型函数类型：P 是应用的身份类型，R 是撤销值类型；函数接收一个身份，返回只读数组。
// 只描述签名，没有运行时校验；应用必须保证同一个函数在每个宿主上产生相同结果，否则撤销判断会不一致。
export type RevokedBy<P extends Principal, R extends JsonValue> = (principal: P) => readonly R[];

/** A host's revocation keys: each principal's, cached weakly by the principal object. */
// 一个宿主的撤销键缓存。输入是应用提供的 revokedBy（可省略）；没有时 revokes 永远返回 false。
// 缓存用 WeakMap 以身份对象为键：身份对象不再被引用时缓存项可被 GC，不会形成全局强引用。
export class RevocationKeys {
	// `| undefined` 表示宿主可能没有配置撤销规则；readonly 只是开发期约束，不会冻结函数。
	readonly #revokedBy: RevokedBy<Principal, JsonValue> | undefined;
	// ReadonlySet<string> 表示调用者只读集合；WeakMap 的键必须是对象，这里正是 Principal。
	readonly #keys = new WeakMap<Principal, ReadonlySet<string>>();

	// 保存应用给出的撤销函数，不读取身份、不计算键；例如 new RevocationKeys((p) => p.revokedAt ? [p.id] : [])。
	constructor(revokedBy: RevokedBy<Principal, JsonValue> | undefined) {
		this.#revokedBy = revokedBy;
	}

	/**
	 * Whether `key` (a revocation's canonical JSON) is one of `principal`'s revocation keys: the canonical JSON of each
	 * value `revokedBy` returns for it, computed on its first use.
	 */
	// 判断某个撤销键是否属于该身份。输入身份对象、链接上收到的规范化 JSON 字符串和上下文；返回 boolean。
	// 无 I/O；首次查询会调用应用函数并做 canonicalJson，结果缓存在 WeakMap。应用函数或序列化抛错时直接向上传播。
	// 示例：revokes(p, '{"session":"s1"}', ctx) 为 true 表示携带该键的链接应被撤销；示例不表示字符串格式由调用方随意拼装。
	revokes(principal: Principal, key: string, context: Context): boolean {
		const revokedBy = this.#revokedBy;
		// 没有配置规则就是“没有任何值会撤销”，不必创建缓存项。
		if (revokedBy === undefined) return false;
		// 先查缓存；undefined 既可能表示没算过，也可能表示 WeakMap 中没有这个对象。
		let keys = this.#keys.get(principal);
		if (keys === undefined) {
			// revokedBy 返回应用值数组；map 把每个值转成规范化 JSON 字符串，再放进 Set 以便常数时间查找。
			// canonicalJson 负责字段排序，保证不同宿主对同一值得到相同字符串。
			keys = new Set(revokedBy(principal).map((revocation) => canonicalJson(revocation, context)));
			this.#keys.set(principal, keys);
		}
		// Set.has 只做字符串相等比较，不解析 key，也不验证它来自可信来源（信任边界在链接解码处）。
		return keys.has(key);
	}
}
