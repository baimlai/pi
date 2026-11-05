// 将会话当前根到叶的原始分支导出为JSONL，供本地保存/分享元数据使用；不是模型上下文投影，也不是包含所有分支的HTML导出。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionManager } from "./session-manager.ts";

// 可选尾项工厂接收最后节点id及本次导出时间，返回仅加在导出里的对象数组；readonly约束调用方式，不作运行时冻结/结构验证。
type TrailingEntries = (parentId: string | null, timestamp: string) => readonly object[];

/** Serialize the current branch and optional export-only entries as JSONL. */
// 输入会话管理器和可选尾项回调，返回带最终换行的JSONL字符串；不写磁盘、不修改原会话，回调/JSON序列化异常可抛出。
// 例如原树A→B及A→C，当前叶C只输出新头、A、C；条目id保留，parentId按本次顺序重新串起，不应用压缩摘要/上下文编辑投影。
// 新头沿用会话id/cwd但采用当前格式版本和导出时间，不复制原头的所有额外字段；分享器可通过尾项回调附加展示元数据。
export function serializeSessionBranch(
	sessionManager: SessionManager,
	createTrailingEntries?: TrailingEntries,
): string {
	// 一次创建时间，头与可选尾项共用；原分支条目自身timestamp不在这里改写。
	const timestamp = new Date().toISOString();
	// SessionHeader是编译期结构约束，创建的是新头对象，不是修改getHeader返回的原对象。
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		// 会话id标识整段会话，与下面树条目id/parentId不同。
		id: sessionManager.getSessionId(),
		timestamp,
		cwd: sessionManager.getCwd(),
	};
	// object[]允许标准条目和导出专用元数据，不强制它们都属于SessionEntry联合。
	const entries: object[] = [header];
	// 首个导出条目变为根；无分支条目时尾项工厂接收null。
	let parentId: string | null = null;
	for (const entry of sessionManager.getBranch()) {
		// 展开浅复制原条目，再覆盖parentId，使断开的原父链也按实际导出路径重新连接。
		entries.push({ ...entry, parentId });
		// 下一条的父亲取本条原id，不生成新节点id。
		parentId = entry.id;
	}
	// 可选调用仅在提供回调时执行，无回调的undefined由??换成[]；不再给尾项自动补id或parentId，也不复制每个尾项对象。
	entries.push(...(createTrailingEntries?.(parentId, timestamp) ?? []));
	// 一行一个JSON对象，join不加缩进；循环引用/BigInt等序列化错误向上传播，结果固定有尾换行。
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** Write the current session branch and optional export-only entries as JSONL. */
// 输入管理器、可选目标路径/尾项工厂，先解析目标并建缺失父目录，再同步写当前分支，返回绝对解析路径。
// 例如未指定目标时写cwd/session-时间戳.jsonl，冒号和点换成-；文件已存在会覆盖，不做原子替换、排他创建或自动脱敏。
// 目录创建可先发生，序列化/回调若失败则可能留下空目录；I/O错误直接抛，不给原会话追加尾项。
export function exportSessionToJsonl(
	sessionManager: SessionManager,
	outputPath?: string,
	createTrailingEntries?: TrailingEntries,
): string {
	// ??只在undefined/null时采用默认名，显式空字符串仍交给resolvePath处理；同毫秒导出默认名可能相同。
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	// dirname只计算路径；exists与mkdir之间可能变化，recursive允许已存在目录。
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	// 先求值序列化字符串，再打开写文件；无编码选项时字符串按Node默认UTF8写入。
	writeFileSync(filePath, serializeSessionBranch(sessionManager, createTrailingEntries));
	// 这是resolvePath的绝对结果，和HTML导出可能返回相对文件名的行为不同。
	return filePath;
}
