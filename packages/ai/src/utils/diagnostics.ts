// 把 API 流异常转成可存入 assistant 消息的诊断数据；既能展示人类文字，也能保留堆栈和错误码。
// 只导入 JsonObject 类型，运行时会擦除；诊断 details 应是可表示为 JSON 的对象。
import type { JsonObject } from "../types.ts";

// 错误的可保存形状；可选字段允许字符串抛出值、无堆栈错误等情况。
export interface DiagnosticErrorInfo {
	// 错误类别名，例如 TypeError；不是所有抛出值都有 name。
	name?: string;
	// 一定提供可读文字，作为最基本的诊断内容。
	message: string;
	// 可选调用堆栈，供定位程序出错位置。
	stack?: string;
	// 错误码可以是供应商字符串或数字；| 是联合类型，不会运行时转换。
	code?: string | number;
}

// 一条诊断记录：描述发生了什么、何时发生，并可带上错误和附加数据。
export interface AssistantMessageDiagnostic {
	// 诊断事件分类，由调用方决定，例如某条传输失败类别。
	type: string;
	// 产生诊断的毫秒时间戳，不是模型 token 数。
	timestamp: number;
	// 规范化后的错误信息；该接口也允许没有错误对象的诊断。
	error?: DiagnosticErrorInfo;
	// 调用方附带的 JSON 详情，避免将任意 SDK 实例直接写进消息。
	details?: JsonObject;
}

// 用途：任意抛出值转文字。例 Error("断线") 得到“断线”，throw 42 得到 "42"；不记录堆栈，也不打印日志。
export function formatThrownValue(value: unknown): string {
	// 外部抛出值的运行时边界：先识别 Error；没有 message 时用 name 兜底。
	if (value instanceof Error) return value.message || value.name;
	// 字符串抛出值直接保留，避免重复序列化加引号。
	if (typeof value === "string") return value;
	// 其他值使用 JavaScript 字符串转换，例如 null 变为 "null"。
	return String(value);
}

// 用途：把任意异常整理成普通数据。例带 code:"ECONNRESET" 的 Error 会保留 code；非 Error 记为 ThrownValue。
export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
	// 先处理不具有 Error 结构的合法抛出值。
	if (!(error instanceof Error)) return { name: "ThrownValue", message: formatThrownValue(error) };
	// as 只让 TS 允许查看可选扩展字段；交叉类型 & 表示“Error 加一个可选 code”，并不验证 code。
	const code = (error as Error & { code?: unknown }).code;
	return {
		// 空 name 归一化为缺失，而不是保存空字符串。
		name: error.name || undefined,
		// 优先保留错误说明，没有说明则用类别名。
		message: error.message || error.name,
		// 保留堆栈原文，不主动重建或解析。
		stack: error.stack,
		// SDK 附加字段是 unknown，运行时只接受字符串/数字；其他对象值不进入诊断 code。
		code: typeof code === "string" || typeof code === "number" ? code : undefined,
	};
}

// 用途：为某个异常创建带分类和当前时间的诊断。例 createAssistantMessageDiagnostic("stream", error, {attempt:1})；只返回数据，不发事件、不写磁盘。
export function createAssistantMessageDiagnostic(
	// 调用方指定分类字符串。
	type: string,
	// 任意外部抛出值，由 extractDiagnosticError 负责规范化。
	error: unknown,
	// 可选附加 JSON 数据，? 表示调用时可以省略。
	details?: JsonObject,
): AssistantMessageDiagnostic {
	// 对象简写保存输入，Date.now() 取得当前毫秒时间，再加入规范化错误。
	return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}

// 用途：向消息追加诊断并修改该消息。T extends 要求对象至少支持可选 diagnostics；例给 assistant 消息补一条断线记录，其他字段保持原样。
export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	// 泛型参数保留调用者原本的消息类型，而非强制换成只有 diagnostics 的对象。
	message: T,
	// 要追加的一条记录，已经是上面定义的规范结构。
	diagnostic: AssistantMessageDiagnostic,
): void {
	// 先展开旧列表再追加新项，并替换消息字段；旧数组本身不 push 修改。
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}
