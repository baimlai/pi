// 把设置管理器积累的错误转换成启动/运行时诊断，再按类型和文字去重；main展示结果，本模块不打印或退出。
import type { AgentSessionRuntimeDiagnostic } from "./agent-session-services.ts";
import type { SettingsManager } from "./settings-manager.ts";

// 输入管理器，返回新的warning数组；drainErrors会清空管理器错误队列，所以它不是无副作用查询。
// 例如坏JSON有路径时提示Invalid settings file /path...，内存/自定义后端无路径时改用global/project范围；不重新读盘验证设置。
export function collectSettingsDiagnostics(settingsManager: SettingsManager): AgentSessionRuntimeDiagnostic[] {
	// 先排空错误队列，map解构每条scope/path/error并产生新诊断对象；异常未在此捕获。
	return settingsManager.drainErrors().map(({ scope, path, error }) => ({
		// 设置错误在此统一降为可供宿主展示的warning，不意味着文件已经修复。
		type: "warning",
		// path按真值判断；有文件路径优先显示路径，否则显示范围。只取Error.message，不展示堆栈。
		message: path ? `Invalid settings file ${path}: ${error.message}` : `Invalid ${scope} settings: ${error.message}`,
	}));
}

/**
 * Remove duplicate type/message diagnostics while preserving their first occurrence.
 * Startup and runtime settings managers can report the same file error.
 */
// 输入只读诊断数组，返回保留首次出现的新数组，不改原数组、不复制每个诊断对象。
// 例如{type:"warning",message:"x"}重复只保留第一个，type:"error"的同文案仍保留；判重不做相似语义或路径规范化。
export function deduplicateDiagnostics(
	// readonly限制通过此参数增删原数组，不是在运行时冻结对象。
	diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): AgentSessionRuntimeDiagnostic[] {
	// 每次调用创建独立集合，不把已展示记录长期缓存到模块中。
	const seen = new Set<string>();
	// filter保持输入顺序，回调true保留当前原对象引用，false跳过。
	return diagnostics.filter((diagnostic) => {
		// NUL分隔固定类型与消息，避免直接拼接边界歧义；\0是一个实际分隔字符。
		const key = `${diagnostic.type}\0${diagnostic.message}`;
		// 已见过完全相同键时丢掉当前重复项。
		if (seen.has(key)) return false;
		// 首次出现先登记，再让filter保留。
		seen.add(key);
		// 布尔值决定保留此项，不表示执行了错误修复。
		return true;
	});
}
