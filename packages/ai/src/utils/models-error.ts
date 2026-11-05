// Models/认证层使用的带类别错误；把底层原因补进 message，便于只显示 message 的调用方仍能看见失败原因。
// 复用任意抛出值转文字的规则，底层 cause 不一定是 Error。
import { formatThrownValue } from "./diagnostics.ts";

// 字符串字面量联合类型限制开发期允许的错误类别，例如 auth；运行时仍只是字符串。
export type ModelsErrorCode = "model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth";

// 继承标准 Error，既可通过 instanceof 识别，也能额外读取 code。
export class ModelsError extends Error {
	// readonly 限制 TS 调用方重新赋值，不会自动冻结运行时对象。
	readonly code: ModelsErrorCode;

	// 用途：构造带类别和可选原因的错误。例 new ModelsError("auth","登录失败",{cause:new Error("过期")}) 的 message 含“过期”；不在构造器里 throw。
	constructor(code: ModelsErrorCode, message: string, options?: { cause?: unknown }) {
		// 先调用父类 Error 构造器，设置合成 message 和标准 cause；子类访问 this 前必须先 super。
		super(withCauseDetail(message, options?.cause), options);
		// 将错误类别名称与普通 Error 区分开，便于日志显示。
		this.name = "ModelsError";
		// 保存结构化错误码，调用者可据此分支，而不只分析自然语言文字。
		this.code = code;
	}
}

/** Callers surface `error.message` only, so keep the underlying reason in it. */
// 用途：将底层原因文字补到主错误后。例“认证失败”加“过期”得到“认证失败: 过期”；已有同样细节时不重复追加，无外部副作用。
function withCauseDetail(message: string, cause: unknown): string {
	// 没有底层原因时保持原文字。
	if (cause === undefined || cause === null) return message;
	// 将任意原因转文字并去掉首尾空白。
	const detail = formatThrownValue(cause).trim();
	// 空细节或主说明已包含该细节时，不增加噪声。
	if (!detail || message.includes(detail)) return message;
	// 模板字符串在 ${...} 位置插入两个变量值。
	return `${message}: ${detail}`;
}
