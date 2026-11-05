// 文件导读
// 所属包与模块：packages/chord/src/data 的验证器模块（layer-1），包装 pi-schema。
// 职责边界：按“持有 schema 的对象”编译并弱缓存验证器，执行一次布尔校验，并把失败解释成 ChordError；
// 不定义 schema、不做类型转换/默认值、不校验返回值。
// 上游：args/params/address 的信任边界调用 validatorFor/check。下游：验证器返回布尔，失败时错误带
// JSON Pointer 路径并交给调用方抛出；遥测记录 walks/validations/compilations。
// 错误流向：compile 的非法规则/未解析引用原样传播；check 失败抛 invalid/args|params|host_address。
// 能力清单：
// - validatorFor（函数）：首次使用时编译并缓存某所有者的验证器。
// - check（函数）：执行一次计数校验，失败转成结构化错误。
// - （内部）SchemaOwner/failedCheck/validators：缓存键类型、失败解释与 WeakMap 缓存。
// 组合关系与典型调用顺序：validatorFor(owner, ctx) -> check(validator, raw, reason, ctx) ->
// 失败时 failedCheck -> validator.errors -> invalid。同一 owner 的后续调用复用编译结果。
// 示例（真实签名）：check(validatorFor(params, context), raw, "params", context);
// 建议阅读顺序：先 SchemaOwner 与 validatorFor 的缓存，再看 check 的快速路径，最后 failedCheck 的路径规则。

// Compiled checks: pi-schema validators of Chord-owned schemas, and the `invalid` error of a failed check.

import { compile, type JsonSchema, type Validator } from "@earendil-works/pi-schema";
import type { Context } from "../context/index.ts";
import { type ChordError, invalid } from "./errors.ts";

/** A Chord-owned record holding a schema: a snapshot, or a contract's params. */
// 缓存所有者只需持有 schema；缓存按这个包装对象的身份区分，并非比较 schema 内容。
type SchemaOwner = { readonly schema: JsonSchema };

/** The validator of an owner's schema, compiled on first use (counted) and cached weakly by the owner. */
// 取得所有者的验证器，首次 compile 后弱缓存；输入 Context 用于记录编译次数，返回 Validator。
// 例如同一 ParamsData 连续请求只编译一次；不同包装对象即使规则相等仍各自编译。
// compile 的非法规则/未解析引用错误向外传播；不启用 coerce，因此不转换参数或应用默认值。
export function validatorFor(owner: SchemaOwner, context: Context): Validator {
	// 先按所有者引用查 WeakMap；命中时不再编译。
	let validator = validators.get(owner);
	// 只有缺失的验证器进入冷路径。
	if (validator === undefined) {
		// 在真正执行编译的位置记录一次，不让调用者代计数。
		context.telemetry.metrics?.counter("chord.data.compilations").add(1);
		// `format` is an annotation (decided for the schema switch): no format checks are compiled in.
		// 调用 pi-schema 默认编译选项，format 只保留为注解，不提供格式断言回调。
		validator = compile(owner.schema);
		// 编译成功才缓存，所有者释放后缓存可被垃圾回收。
		validators.set(owner, validator);
	}
	// 返回同一验证器供多次值检查使用。
	return validator;
}

// WeakMap 不因缓存而让所有曾经使用的规则永久存活。
const validators = new WeakMap<SchemaOwner, Validator>();

/** Checks `value` (counted); a failure throws `invalid/<reason>` with the first error's JSON Pointer path. */
// 对边界 unknown 值执行一次布尔校验，成功无返回值，失败生成 invalid/<reason> 错误。
// 例如 args 的未知 extra 字段会在错误路径 /extra 出现；不复制、删字段或转换输入，记录验证次数。
export function check(
	validator: Validator,
	value: unknown,
	reason: "args" | "params" | "host_address",
	context: Context,
): void {
	// 每次进入 check 都算一次校验；错误解释中的额外内部检查不在这里另计。
	context.telemetry.metrics?.counter("chord.data.validations").add(1);
	// 快速路径只取布尔结果；失败才调用较贵的解释器并抛出结构化错误。
	if (!validator.check(value)) throw failedCheck(validator, value, reason, context);
}

/**
 * The error of a failed check: the first error of the validator's explanation (counted: it walks the schema). A
 * missing field is reported at the field ("missing"), an unknown one at its own path ("unknown field"); the value
 * itself at `/`.
 */
// 把已经失败的值转成首条 pi-schema 错误，返回 ChordError 供 check 抛出。
// 例如根错误的空路径改为 /，字段错误保留 JSON Pointer；这里只诊断，不重新修复输入。
// 会记录解释遍历并调用 errors；errors 内还会先跑 check，随后惰性建立解释器。
function failedCheck(
	validator: Validator,
	value: unknown,
	reason: "args" | "params" | "host_address",
	context: Context,
): ChordError {
	// 失败路径才计算错误说明的遍历成本。
	context.telemetry.metrics?.counter("chord.data.walks").add(1);
	// A value that failed the check has at least one error.
	// errors 返回错误数组，这里用已失败的前提取首项；! 不是运行时非空校验。
	const error = validator.errors(value)[0]!;
	// pi-schema 用空字符串表示根位置，Chord 的 details 将它显示为 /。
	const path = error.path || "/";
	// 拼出参数类别、非根路径和解释文字；details 只保存路径，不带整个原始输入。
	return invalid(reason, `${reason}${path === "/" ? "" : path}: ${error.message}`, { path });
}
