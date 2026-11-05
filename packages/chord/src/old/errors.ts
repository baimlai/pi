/**
 * Chord v1 的统一错误与清理辅助（packages/chord/src/old/errors.ts）。
 *
 * 所属包与功能模块：packages/chord 的 v1 实现（src/old/），不是 v2。本文件定义跨模块共享的错误码词汇、
 * `ChordError` 类、类型谓词/构造辅助，以及“执行全部清理步骤再汇总错误”的 `runAll`。
 *
 * 职责边界：只负责错误对象的表示、分类和清理聚合；不决定调用方是否重试、不记录日志、不把错误包装成协议帧。
 * `ChordError` 继承原生 Error 并保留 cause；`retryable` 只标记两类“稍后重试可能成功”的错误码。运行时不会
 * 校验错误码与 reason 的搭配，码表是调用者与测试共同遵守的约定。
 *
 * 上游入口：old/index.ts 公开 `ChordError`、`forbidden`、`invalid`、`isChordError` 与错误码类型；object.ts、
 * host.ts、reload.ts、remote.ts、connection.ts、contract.ts、schema.ts、manager.ts 等直接导入本文件。
 * 下游依赖：无项目内依赖；只使用 ECMAScript 的 Error/AggregateError/Set。
 *
 * 能力清单（按导出项）：
 * - `CHORD_ERROR_CODES`：合法错误码的只读元组，供类型推导与运行时枚举。
 * - `ChordErrorCode`：由元组推导出的错误码联合类型。
 * - `ChordErrorReason`：字符串别名，表示码内的细分原因（如 invalid/args、unavailable/unknown_type）。
 * - `ChordError`：带 code、reason、retryable、details 的 Error 子类；message 形如 `code/reason: message`。
 * - `isChordError(error, code?)`：类型谓词；可选地同时要求特定错误码。
 * - `forbidden(message?)`：构造 forbidden 错误，常用于工厂/方法拒绝 principal。
 * - `invalid(reason, message, details?)`：构造 invalid 错误，用于作者错误或实现错误。
 * - `asChordError(error, context)`：保留已有 ChordError；其他异常包装为 unavailable 并保留 cause。
 * - `runAll(steps, message)`：顺序执行全部清理步骤，等待每步完成；只有一个失败时原样抛出，多个失败用
 *   AggregateError 汇总。
 *
 * 错误码含义（速查）：
 * - aborted：操作被取消/上下文过期；superseded：代码版本已退役（可重试）；upgrade_conflict：对象正在升级
 *   或要求更高代码版本（可重试）；upgrade_required：契约/代码需要整体升级。
 * - contract_mismatch：消费者与提供方契约无法绑定/适配；not_in_variant：远程契约当前变体没有该成员。
 * - gone：对象/引用永久消失；released：引用被主动释放；not_ready：资源/状态/引用尚未就绪。
 * - forbidden：权限拒绝；invalid：输入、实现、参数或用法不合法；unavailable：依赖、宿主或激活不可用。
 *
 * 典型调用示例（示例，不表示导入时执行）：
 * ```ts
 * if (!allowed) throw forbidden("owner only");
 * try {
 *   await ref.increment(ctx);
 * } catch (error) {
 *   if (isChordError(error, "superseded")) return retryLater();
 *   throw error;
 * }
 * await runAll([() => a.close(), () => b.close()], "cleanup failed");
 * ```
 *
 * 建议阅读顺序：先看 `CHORD_ERROR_CODES`/`ChordErrorCode` 建立错误词汇；再读 `ChordError` 构造器与
 * `retryable` 集合；然后看 `isChordError`、`forbidden`、`invalid`、`asChordError` 的转换规则；最后读
 * `runAll` 的顺序执行与聚合语义。`object.ts` 的 `admit`/`call`/`#activate` 是这些错误码的主要产生点。
 */
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
