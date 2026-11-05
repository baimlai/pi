// 文件导读
// 所属包与模块：packages/chord/src/data 的参数与身份模块（layer-1），服务 Chord 的对象查找与地址识别。
// 职责边界：对 params 与 hostAddress 参数做运行时校验、计算稳定键，并拼接本地/远程对象身份；
// 不打开对象、不访问存储、不注册 hold。
// 上游：document/get 的调用参数、link 解码后的 address、host 的 hold 名称都会进入这里。
// 下游：参数键用于存储查找；身份键用于对象去重；地址交给 host kind 查找。错误以 ChordError 抛出。
// 错误流向：checkParams 失败 invalid/params；checkAddress 失败 invalid/host_address；
// identityKey 不校验参数，只做转义拼接（其输入已由前两步建立）。
// 能力清单：
// - checkParams（函数）：校验一次对象请求参数并返回原对象与参数键。
// - identityKey（函数）：拼接 name|key|principalKey 的进程内身份。
// - checkAddress（函数）：校验 hostAddress 的 kind 参数并返回 Address。
// 组合关系与典型调用顺序：checkParams 得到 key -> identityKey 需要 principalKey 时再拼身份；
// hostAddress 路径直接 checkAddress -> host kind 查找。三者共用 validatorFor/joinKey/addressKey。
// 示例（真实签名）：const { params, key } = checkParams(notesContract, raw, context);
// const id = identityKey(notesContract, key); // local 契约只有两段
// 建议阅读顺序：先 checkParams，再看 identityKey 的条件元组，最后 checkAddress 与 addressKey 的组合。

// Params and identity: the checked params of a get, their key, and the in-process identity of an object.

import type { Context } from "../context/index.ts";
import { type Contract, contractData, type ParamsOf, type ShapeOf } from "../contracts/contract.ts";
import { type Address, addressKey } from "../contracts/host-kind.ts";
import { joinKey, type ParamsData } from "../contracts/params.ts";
import { check, validatorFor } from "./validator.ts";

/**
 * Checks `raw` against the contract's params with one compiled closed-object check (`invalid/params` on failure) and
 * returns the caller's own object with its key: the field values in declared order, each escaped, joined with `|`.
 */
// 核验某契约的一次对象请求参数，返回原 params 对象和身份键；C 保留具体契约类型。
// 流程为取声明→惰性编译并校验→按字段顺序组键；会更新验证器缓存和遥测计数，坏输入抛 invalid/params。
// 例如声明 {session:str()} 后传 {session:"S1"} 得 key="S1"；额外字段不会被悄悄删掉。
export function checkParams<C extends Contract>(
	contract: C,
	raw: unknown,
	context: Context,
): { readonly params: ParamsOf<C>; readonly key: string } {
	// 从真正声明过的契约取参数规则；contractData 的 WeakMap 身份检查会拒绝手工拼出的契约。
	const { params } = contractData(contract);
	// raw 是调用边界的 unknown：先按闭合对象规则验证，失败抛 invalid/params，不补默认值或删除字段。
	check(validatorFor(params, context), raw, "params", context);
	// The check above establishes the params type.
	const checked = raw as ParamsOf<C> & { readonly [field: string]: string | number | boolean };
	// 按声明字段顺序读取标量并转字符串，再由 joinKey 转义分隔符；params 保留原对象引用。
	return { params: checked, key: joinKey(params.fields.map((field) => String(checked[field]))) };
}

/** The in-process identity of an object: `name|key|principalKey`, each part escaped; `local` has no principal. */
// 把契约名、已计算的参数键和远程对象的 principal key 再转义拼接，不访问存储。
// 条件元组让 local 调用在 TS 中不带第三项，remote 必须带；运行时只是展开实参数组，不再验参。
// 例如 local notes、参数键 S1 得 notes|S1；参数键里的 | 会再次转义以保留层级边界。
export function identityKey<C extends Contract>(
	contract: C,
	key: string,
	...principalKey: ShapeOf<C>["kind"] extends "local" ? [] : [principalKey: string]
): string {
	// ... 将剩余参数元组展开为键的后续部分；joinKey 负责反斜杠和竖线转义。
	return joinKey([contract.name, key, ...principalKey]);
}

/**
 * An address from a kind's name and params as a hold names it or a `hostAddress` returned it: the params checked
 * against the kind's with one compiled closed-object check (`invalid/host_address` on failure), the key computed.
 */
// 核验路由边界收到的地址参数，成功返回 kind/原参数/key，失败抛 invalid/host_address。
// 例如 session 的 id 字段声明为字符串时，{id:"S1"} 得 session|S1；不会启动对应主机。
export function checkAddress(kind: string, params: ParamsData, raw: unknown, context: Context): Address {
	// 按主机种类的参数规则检查 unknown 输入，复用 ParamsData 所拥有的编译缓存并计数。
	check(validatorFor(params, context), raw, "host_address", context);
	// The check above establishes a flat record of the kind's scalar fields.
	// 校验成功后才向 TS 声明这是标量字段表；as 不会复制对象，也不执行转换。
	const values = raw as { readonly [field: string]: string | number | boolean };
	// addressKey 按该种类的声明字段顺序组键；这里返回的是地址数据，不是网络连接。
	return { kind, params: values, key: addressKey(kind, params, values) };
}
