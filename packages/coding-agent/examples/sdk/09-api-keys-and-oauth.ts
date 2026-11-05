/**
 * API Keys and OAuth
 *
 * Configure provider auth through ModelRuntime.
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/sdk，SDK 示例系列第 09 个。上游由
 * `node examples/sdk/09-api-keys-and-oauth.ts` 直接运行（需先构建工作区）；下游通过
 * ModelRuntime.create 选择凭证/模型配置位置，再把运行时传给 createAgentSession。
 *
 * 演示什么：三种认证配置。默认运行时读取 ~/.pi/agent/auth.json 与 models.json；自定义运行时
 * 把这两个路径换到 /tmp/my-app；setRuntimeApiKey 只在当前进程内临时覆盖某个提供商的 key，
 * 不会写回 auth.json。创建运行时可能读取凭证与模型配置，并在 modelsPath 附近维护
 * models-store.json 目录缓存；示例本身不发送模型请求、不登录 OAuth、不产生模型费用。
 * 若没有可用模型/凭证，创建会话可能返回 modelFallbackMessage，但本示例忽略该字段。
 *
 * 能力清单（按调用顺序）：
 * - ModelRuntime.create()：默认凭证/模型目录，加载本地目录恢复。
 * - ModelRuntime.create({ authPath, modelsPath })：自定义文件位置。
 * - setRuntimeApiKey(providerId, apiKey)：进程级临时 key 覆盖，必须 await。
 * - createAgentSession({ modelRuntime, sessionManager })：复用运行时装配内存会话。
 *
 * 典型运行顺序与预期输出：
 *   1. 运行脚本；依次打印三行 “Session with ...”，每次创建后立即 dispose。
 *   2. 自定义路径若不存在的凭证文件，运行时按缺失处理；不会自动生成 key。
 *   3. 临时 key 只影响本进程，脚本退出后失效。
 *
 * 示例（真实签名）：
 *   const runtime = await ModelRuntime.create({ authPath: "/tmp/app/auth.json" });
 *   await runtime.setRuntimeApiKey("anthropic", process.env.MY_KEY!);
 *   const { session } = await createAgentSession({ modelRuntime: runtime, sessionManager: SessionManager.inMemory() });
 *   传给 setRuntimeApiKey 的字符串必须真实；示例里的 sk-my-temp-key 是占位值。
 *
 * 建议阅读顺序：先看默认 create()，再看自定义 authPath/modelsPath 的作用，最后看
 * setRuntimeApiKey 的进程级语义与 await。
 */

// ModelRuntime 是运行时类；createAgentSession 装配会话；SessionManager.inMemory 提供无落盘历史。
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

// 默认运行时：使用全局 agentDir 下的 auth.json/auth 与 models.json，构造时只做本地加载。
const modelRuntime = await ModelRuntime.create();
// 不指定 model，让会话按设置/可用模型选择；这里只验证运行时接入，不发起问答。
const { session: defaultAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	// 复用上面创建的运行时，避免会话内部再建一份。
	modelRuntime,
});
console.log("Session with default model runtime");
// 立即释放；没有 prompt，因此没有真实模型请求。
defaultAuthSession.dispose();

// 自定义凭据与模型配置位置；/tmp/my-app 是占位目录，使用前应确保路径符合部署环境。
const customRuntime = await ModelRuntime.create({
	authPath: "/tmp/my-app/auth.json",
	modelsPath: "/tmp/my-app/models.json",
});
const { session: customAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	modelRuntime: customRuntime,
});
console.log("Session with custom auth and models locations");
customAuthSession.dispose();

// 进程级临时 API key：仅覆盖内存中的 RuntimeCredentials，不写 auth.json；await 等同步完成。
await modelRuntime.setRuntimeApiKey("anthropic", "sk-my-temp-key");
const { session: runtimeKeySession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	// 还是最初的默认运行时，现在带上了临时 key 覆盖。
	modelRuntime,
});
console.log("Session with runtime API key override");
runtimeKeySession.dispose();
