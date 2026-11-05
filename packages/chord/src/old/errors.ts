// Chord v1 的统一错误对象及清理辅助函数；这里创建错误，不负责替调用者决定重试。
/** Error codes callers see (guide table). A refused or aborted reload keeps the code of its cause. */
export const CHORD_ERROR_CODES = [
	"aborted",
	"contract_mismatch",
	"forbidden",
	"gone",
	"invalid",
	"not_in_variant",
	"not_ready",
	"released",
	"superseded",
	"unavailable",
	"upgrade_conflict",
	"upgrade_required",
] as const;
// as const 保留每个字符串的字面量类型；[number] 取元组中任意一项，得到允许的错误码联合类型。
export type ChordErrorCode = (typeof CHORD_ERROR_CODES)[number];

/**
 * Finer cause inside a code, for logs and tests: e.g. `invalid` + `args`, `result`, `state`, `input`, `implementation`,
 * `duplicate`, `cycle`, `read_only`, `not_host_lifetime`, `registry_conflict`; `unavailable` + `unknown_type`.
 */
export type ChordErrorReason = string;

// 只有旧代码版本已退役、或升级暂时挡住旧调用这两类错误标为可重试；是否真正重试由上层决定。
const RETRYABLE: ReadonlySet<ChordErrorCode> = new Set(["superseded", "upgrade_conflict"]);

// readonly 限制 TypeScript 调用方重新赋值，并不在运行时冻结 Error 对象。unknown 保留任意原始详情。
export class ChordError extends Error {
	readonly code: ChordErrorCode;
	readonly reason: ChordErrorReason | undefined;
	readonly retryable: boolean;
	readonly details: unknown;
	/**
	 * 用错误码、文字和可选原因构造错误；返回新实例，不会在构造时抛出它。
	 * 先交给 Error 保存 message/cause，再保存供调用方分支判断的字段。例如传 invalid、"bad" 和 reason: "args"
	 * 会得到 message 为 "invalid/args: bad" 的错误；这是格式示例，不表示此处正在校验参数。
	 */
	constructor(
		code: ChordErrorCode,
		message: string,
		options?: { cause?: unknown; details?: unknown; reason?: ChordErrorReason },
	) {
		// 可选链 ?. 在 options 不存在时给出 undefined；有非空 reason 才把它拼到错误码后。
		super(`${code}${options?.reason ? `/${options.reason}` : ""}: ${message}`, {
			// Error 的 cause 保存原始异常，便于在多层调用之间保留失败来源。
			cause: options?.cause,
		});
		// 覆盖原生 Error 的名字，使日志能辨认 ChordError。
		this.name = "ChordError";
		// 分类码、细分原因和详情原样保存；构造器不对这些详情做结构校验。
		this.code = code;
		this.reason = options?.reason;
		// Set.has 只查询预先定义的可重试码集合。
		this.retryable = RETRYABLE.has(code);
		this.details = options?.details;
	}
}

/** 检查未知异常是否为本模块的 ChordError，并可限定错误码；无副作用。例如 catch 后判断 isChordError(e, "gone")。 */
// 返回类型 error is ChordError 是类型谓词：true 分支内 TS 允许读取 code；运行时仍由 instanceof 和码比较决定。
export const isChordError = (error: unknown, code?: ChordErrorCode): error is ChordError =>
	error instanceof ChordError && (code === undefined || error.code === code);

/** For factories and methods refusing a principal: `throw forbidden()`. */
/** 创建 forbidden 错误，文字默认是 forbidden；调用本身不抛出，工厂可写 throw forbidden("owner only") 拒绝访问。 */
export const forbidden = (message = "forbidden"): ChordError => new ChordError("forbidden", message);

/** 按 reason、message 和可选详情创建 invalid 错误；只封装数据。例如 invalid("input", "missing id")。 */
export const invalid = (reason: ChordErrorReason, message: string, details?: unknown): ChordError =>
	new ChordError("invalid", message, { reason, details });

/** Keeps a ChordError's code; anything else becomes `unavailable` with the original as cause. */
/**
 * 把未知异常转为 ChordError：已有实例原样返回，其余包装为 unavailable，并将 context 加到消息前。
 * 不抛异常、不复制已有 ChordError。例如 asChordError(new Error("offline"), "open") 的消息为 unavailable: open: offline。
 */
export const asChordError = (error: unknown, context: string): ChordError =>
	// instanceof 是未知异常的运行时分类；非 Error 值用 String 转成可显示文字，同时保留原值为 cause。
	error instanceof ChordError
		? error
		: new ChordError("unavailable", `${context}: ${error instanceof Error ? error.message : String(error)}`, {
				cause: error,
			});

/** Runs every step, then throws one error, or an AggregateError when several failed. */
/**
 * 按顺序执行所有清理步骤并等待异步返回；输入是无参数函数数组，成功时 Promise<void> 完成。
 * 某步失败仍继续后续步骤；最终一个错误原样抛出，多个错误用 message 汇总。例如两项关闭操作都失败时两项都会尝试。
 */
export async function runAll(steps: readonly (() => unknown)[], message: string): Promise<void> {
	// unknown[] 能保存 Error、字符串或其他被 throw 的值，不假定异常一定是 Error。
	const errors: unknown[] = [];
	// for...of 保持输入顺序；不是并行执行。
	for (const step of steps) {
		try {
			// await 同时支持同步返回和 Promise；只有当前步骤完成或失败后才进入下一项。
			await step();
		} catch (error) {
			// 暂存异常，避免提前退出而漏掉其他清理工作。
			errors.push(error);
		}
	}
	// 只有一个失败时保留原异常身份；没有失败时两个条件都不成立，正常结束。
	if (errors.length === 1) throw errors[0];
	// AggregateError.errors 保存全部失败，message 说明是哪一组清理。
	if (errors.length > 1) throw new AggregateError(errors, message);
}
