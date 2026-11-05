// CLI 启动前的进程设置；只准备环境，不解析用户问题，也不向模型发请求。
// 普通 import 引入运行时值；相对路径的 .ts 后缀配合仓库的 Node TypeScript 运行方式。
import { APP_NAME } from "../config.ts";
// dispatcher 是 HTTP 请求的连接调度器；此函数将其配置为 Pi 需要的 undici 实现。
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";

/**
 * 初始化 CLI 进程，供 cli.ts 在 main() 前调用。
 * 输入：无；返回：void，即没有业务返回值。副作用：修改进程标题、环境变量、warning 处理和全局 HTTP 设置。
 * 流程：设置进程身份 → 禁用默认 warning 输出 → 配置 HTTP dispatcher。
 * 例：运行 pi 后，子进程可从环境中看到 AI_AGENT=pi；这不表示已经调用过模型。
 */
export function setupCli(): void {
	// 进程标题采用发行版配置，进程列表可据此识别它。
	process.title = APP_NAME;
	// 标明当前进程由 coding-agent 启动；环境变量的值是字符串，不是 boolean。
	process.env.PI_CODING_AGENT = "true";
	// 提供通用 Agent 身份标识，子进程默认会继承环境。
	process.env.AI_AGENT = "pi";
	// 用空箭头函数替换 warning 输出；as 只是类型断言，运行时仍是这个空函数。
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// Configure undici before provider SDKs issue requests. Settings are applied
	// once SettingsManager has loaded global/project configuration.
	// 此处采用默认超时；设置加载完成后，主流程还会应用实际的全局/项目网络配置。
	configureHttpDispatcher();
}
