// 在恢复磁盘会话前检测其工作目录是否消失，并构造可展示问题/异常；不自动创建目录或切换 cwd。
// 存在性探测不会验证一定是目录，也不验证可写/可执行权限。
import { existsSync } from "node:fs";

// 可供终端/异常/UI共同使用的问题数据，不包含已经采取的回退动作。
export interface SessionCwdIssue {
	// 可选的会话文件路径，展示时缺失则省略该行。
	sessionFile?: string;
	// 会话记录的原工作目录。
	sessionCwd: string;
	// 调用者提供的当前/回退目录，仅记录和展示，不在这里检查它存在。
	fallbackCwd: string;
}

// 用最小结构类型依赖会话管理器，不要求必须是某个具体类实例。
interface SessionCwdSource {
	// 返回会话有效工作目录。
	getCwd(): string;
	// 返回持久化文件路径或undefined；内存会话可没有文件。
	getSessionFile(): string | undefined;
}

/**
 * 检查有磁盘文件的会话所记录cwd是否缺失，返回问题对象或undefined，无目录创建副作用。
 * 例：持久会话cwd=/gone且不存在，返回原目录与fallbackCwd；内存会话无sessionFile直接跳过。只检测existsSync，不证明路径一定是可用目录。
 */
export function getMissingSessionCwdIssue(
	sessionManager: SessionCwdSource,
	fallbackCwd: string,
): SessionCwdIssue | undefined {
	// 先取会话文件，限定需要检测的恢复范围。
	const sessionFile = sessionManager.getSessionFile();
	// 没有文件路径，包括空字符串，就不按磁盘恢复问题处理。
	if (!sessionFile) {
		// 跳过返回undefined，不代表所有内存会话的cwd都已校验。
		return undefined;
	}

	// 有文件才读取对应会话cwd。
	const sessionCwd = sessionManager.getCwd();
	// 空cwd也会跳过；existsSync为true仅表示路径存在。
	if (!sessionCwd || existsSync(sessionCwd)) {
		// 没有需要报告的缺失问题。
		return undefined;
	}

	// 只构造数据，未调用process.chdir。
	return {
		// 属性简写保留持久化文件路径。
		sessionFile,
		// 保留缺失目录供用户定位。
		sessionCwd,
		// 保留调用方建议使用的目录。
		fallbackCwd,
	};
}

/**
 * 把目录问题格式化为异常文字，返回字符串，无输出或目录操作。
 * 例：含sessionFile时附Session file一行；不含时只写缺失cwd和当前cwd。
 */
export function formatMissingSessionCwdError(issue: SessionCwdIssue): string {
	// 三元表达式按文件路径真值决定是否附加那一行。
	const sessionFile = issue.sessionFile ? `\nSession file: ${issue.sessionFile}` : "";
	// 模板串插入三部分信息；\n是实际换行，保留英语提示正文。
	return `Stored session working directory does not exist: ${issue.sessionCwd}${sessionFile}\nCurrent working directory: ${issue.fallbackCwd}`;
}

/**
 * 生成询问“是否在当前cwd继续”的文字，不执行继续决定。
 * 例：原目录/gone、回退/here时，提示并列展示两者，由上层UI收集选择。
 */
export function formatMissingSessionCwdPrompt(issue: SessionCwdIssue): string {
	// 直接插入两个目录，不额外检查或转义终端控制字符。
	return `cwd from session file does not exist\n${issue.sessionCwd}\n\ncontinue in current cwd\n${issue.fallbackCwd}`;
}

// 携带结构化问题的Error子类，使调用方可以识别这类恢复错误并展示选择。
export class MissingSessionCwdError extends Error {
	// readonly只在TypeScript禁止重新赋值；问题对象不被冻结。
	readonly issue: SessionCwdIssue;

	/**
	 * 以同一issue构造错误消息，并保存issue引用；不复制或修复目录。
	 * 例：catch到MissingSessionCwdError后，调用方可用error.issue构造询问界面。
	 */
	constructor(issue: SessionCwdIssue) {
		// super调用Error构造器；子类使用this前必须先调用它。
		super(formatMissingSessionCwdError(issue));
		// 设置错误name便于日志辨认，不改变instanceof继承关系。
		this.name = "MissingSessionCwdError";
		// 保存原对象引用，readonly不等于深度不可变。
		this.issue = issue;
	}
}

/**
 * 检测并在发现缺失cwd时抛MissingSessionCwdError，否则返回void。
 * 例：运行时装配前调用它，可在加载项目资源前中断；它不会自动采用fallbackCwd。
 */
export function assertSessionCwdExists(sessionManager: SessionCwdSource, fallbackCwd: string): void {
	// 复用同一问题检测规则，避免异常与UI版本各自判断。
	const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
	// 问题对象存在才抛错，undefined时正常返回。
	if (issue) {
		// throw中断当前调用链，由上层捕获处理。
		throw new MissingSessionCwdError(issue);
	}
}
