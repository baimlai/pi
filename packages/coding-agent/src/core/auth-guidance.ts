// 集中构造缺模型/缺认证时的用户提示；调用方负责展示，这里只返回字符串，不登录、不探测密钥。
// 按平台规则拼文档文件路径。
import { join } from "node:path";
// 文档根目录走 config 辅助，以适配源码、npm 和独立二进制安装。
import { getDocsPath } from "../config.ts";

// 用于尚不知真实供应商时的约定占位值，不是任意未知字符串都会被替换。
const UNKNOWN_PROVIDER = "unknown";

/**
 * 返回 /login 指引和 providers/models 两份本地文档路径，不读取文档正文。
 * 例：文档目录为 /opt/pi/docs 时，返回文字包含 /opt/pi/docs/providers.md 和 models.md；路径解析错误会传出。
 */
export function getProviderLoginHelp(): string {
	// 先构建逐行文字数组，便于最后统一插入换行。
	return [
		// 第一行说明 OAuth/API key 登录入口；保留实际界面使用的英语。
		"Use /login to log into a provider via OAuth or API key. See:",
		// 模板字面量内调用路径辅助，再插入带两空格缩进的文档位置。
		`  ${join(getDocsPath(), "providers.md")}`,
		// 第二份文档说明模型配置，和供应商登录文档并列。
		`  ${join(getDocsPath(), "models.md")}`,
		// join 把数组元素用换行连接，不在末尾额外增加一个换行。
	].join("\n");
}

/**
 * 返回“没有可用模型”的完整提示并附登录帮助，不执行模型目录查询。
 * 例：调用方已判断可用列表为空后，用此返回值展示操作入口；函数名不代表这里再次检查列表。
 */
export function formatNoModelsAvailableMessage(): string {
	// 嵌套函数调用将共用帮助插入当前提示，返回一个字符串。
	return `No models available. ${getProviderLoginHelp()}`;
}

/**
 * 返回“没有选中模型”的提示、登录帮助和 /model 入口。
 * 例：目录已有模型但会话尚未选择时可使用；这里不替调用方自动选择。
 */
export function formatNoModelSelectedMessage(): string {
	// 两个 \n 表示空一行分隔段落；模板正文保持原样。
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

/**
 * 按供应商名构造缺 API key 提示；不读取凭证文件，也不保证实际一定缺钥匙。
 * 例：provider="unknown" 时显示 the selected model，provider="demo" 时显示 demo；输入由已判断缺认证的调用方提供。
 */
export function formatNoApiKeyFoundMessage(provider: string): string {
	// 三元表达式只对占位值 unknown 替换成易懂文字，其他供应商字符串原样保留。
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	// 将显示名和共用登录帮助拼入返回文字，无 console 或 UI 副作用。
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
