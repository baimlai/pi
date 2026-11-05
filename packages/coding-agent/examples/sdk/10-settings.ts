/**
 * Settings Configuration
 *
 * Override settings using SettingsManager.
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/sdk，SDK 示例系列第 10 个。上游由
 * `node examples/sdk/10-settings.ts` 直接运行（需先构建工作区）；下游通过 SettingsManager
 * 读取/覆盖压缩、重试、思考级别等设置，再把管理器传给 createAgentSession。
 *
 * 演示什么：设置分用户层（agentDir/settings.json）与项目层（<cwd>/.pi/settings.json，项目受信
 * 时读取），合并后形成有效视图。applyOverrides 只在当前有效视图上叠加临时覆盖，不写文件；
 * setter 先改内存并把持久化排入队列，flush 只等待队列结算，保存失败通过 drainErrors 报告而
 * 不是从 flush 抛出。SettingsManager.inMemory 提供无文件 I/O 的测试替身。脚本不发送模型请求。
 *
 * 注意：上方英文注释把 getGlobalSettings() 描述为“合并 global + project”，实际它只返回用户层
 * 的深复制；要读合并后的有效设置应调用 getSettings()。此处保留原英文并补充说明。
 *
 * 能力清单（按调用顺序）：
 * - SettingsManager.create(cwd)：读取用户层与受信项目层设置。
 * - getGlobalSettings()：只读用户层副本（非合并视图）。
 * - applyOverrides(partial)：叠加临时有效值，不持久化。
 * - setDefaultThinkingLevel(level)：同步改内存并排队写入。
 * - flush()：等待已排队写入结算；返回不表示一定保存成功。
 * - drainErrors()：取出并清空设置 I/O 错误队列。
 * - SettingsManager.inMemory(partial)：无文件后端的测试设置。
 *
 * 典型运行顺序与预期输出：
 *   1. 运行脚本；打印当前用户层设置的 JSON。
 *   2. 应用覆盖并创建会话，打印 `Session created with custom settings`。
 *   3. 设置默认思考级别并 flush；若有保存错误，逐条打印警告。
 *   4. 用内存设置再创建一个会话，打印后释放；没有模型请求。
 *
 * 示例（真实签名）：
 *   const settings = SettingsManager.create(process.cwd(), "/custom/agent-dir");
 *   settings.applyOverrides({ compaction: { enabled: false } });
 *   settings.setDefaultThinkingLevel("low");
 *   await settings.flush();
 *   for (const { scope, error } of settings.drainErrors()) console.warn(scope, error.message);
 *
 * 建议阅读顺序：先看 create 与 getGlobalSettings 的层语义，再看 applyOverrides 的临时性，
 * 随后看 setter→flush→drainErrors 的写入链，最后看 inMemory 测试替身。
 */

// createAgentSession 装配会话；SessionManager 提供内存历史；SettingsManager 管理设置层。
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// 项目设置的查找基准；create 默认还会使用全局 agentDir，并按信任开关决定是否读项目层。
const cwd = process.cwd();

// Load current settings (merged global + project)
// 中文说明：这里调用的是 getGlobalSettings()，只返回用户层，不是 global+project 合并视图。
// 返回的是深复制；修改它不会影响管理器内部的全局设置。
const settingsManagerFromDisk = SettingsManager.create(cwd);
console.log("Current settings:", JSON.stringify(settingsManagerFromDisk.getGlobalSettings(), null, 2));

// Override specific settings
// 为演示临时覆盖另建一个管理器，避免上面的只读展示实例与覆盖实例混在一起。
const settingsManager = SettingsManager.create(cwd);
settingsManager.applyOverrides({
	// 关闭压缩；对象会与现有有效设置递归合并。
	compaction: { enabled: false },
	// 开启重试并设置次数与基础退避；字段名需符合 Settings 类型。
	retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
});

// 会话读取覆盖后的有效设置；这些覆盖只存在于内存，不会写回 settings.json。
const { session: customSettingsSession } = await createAgentSession({
	settingsManager,
	sessionManager: SessionManager.inMemory(),
});
console.log("Session created with custom settings");
customSettingsSession.dispose();

// Setters update memory immediately and queue persistence writes.
// Call flush() when you need a durability boundary.
// setter 同步更新内存并排入写队列；不 await 时写入可能尚未完成。
settingsManager.setDefaultThinkingLevel("low");
// flush 等待当前队列结算；它通常不因存储失败而拒绝，失败记录在错误队列。
await settingsManager.flush();

// Surface settings I/O errors at the app layer.
// drainErrors 取出错误并清空队列；解构 scope 表示 global/project，error 是 Error 实例。
const settingsErrors = settingsManager.drainErrors();
if (settingsErrors.length > 0) {
	for (const { scope, error } of settingsErrors) {
		// 只打印作用域与错误信息，不打印设置内容或凭证。
		console.warn(`Warning (${scope} settings): ${error.message}`);
	}
}

// For testing without file I/O:
// 内存设置不创建目录/文件；传入的部分设置会先深复制再走同一合并路径。
const inMemorySettings = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: false },
});

// 用内存设置创建测试会话；仍使用内存历史，避免任何落盘。
const { session: testSession } = await createAgentSession({
	settingsManager: inMemorySettings,
	sessionManager: SessionManager.inMemory(),
});
console.log("Test session created with in-memory settings");
testSession.dispose();
