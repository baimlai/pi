/**
 * Custom Model Selection
 *
 * Shows how to select a specific model and thinking level.
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/sdk，SDK 示例系列第 02 个。上游由
 * `node examples/sdk/02-custom-model.ts` 直接运行（需先构建工作区）；下游先读取 ModelRuntime
 * 的模型目录和凭证，再把选中的模型传给 createAgentSession。
 *
 * 演示什么：三种查找模型的途径——按 provider/id 查内置模型、查 models.json 里的自定义模型、
 * 查当前有有效凭证的可用模型——以及如何为会话指定 thinkingLevel。查找模型和检查认证通常只读
 * 本地配置，但某些供应商的认证检查可能执行自己的 I/O（例如查询外部凭证源），不能保证完全不
 * 发网络请求；本示例真正的模型对话只由 prompt 发起，并可能产生费用。若没有可用模型，本示例
 * 不会创建会话，也不会报错，只是静默结束。
 *
 * 能力清单（按调用顺序）：
 * - ModelRuntime.create(options?)：创建模型/认证运行时，默认读取 agentDir 下的 auth.json 与 models.json。
 * - modelRuntime.getModel(providerId, modelId)：按目录查找模型元数据，找不到返回 undefined。
 * - modelRuntime.getAvailable(providerId?)：异步返回当前有可用认证的模型只读数组。
 * - createAgentSession({ model, thinkingLevel, modelRuntime })：用显式模型装配会话。
 * - session.subscribe / session.prompt / session.dispose：流式观察、提问和清理。
 *
 * 典型运行顺序与预期输出：
 *   1. 运行脚本；先打印找到的模型（若存在）与可用模型列表。
 *   2. 若可用列表非空，用第一个模型发起一次问候，文字增量写到 stdout。
 *   3. 若列表为空则没有任何会话请求；脚本以正常状态退出。
 *
 * 示例（真实签名）：
 *   const runtime = await ModelRuntime.create({ authPath, modelsPath });
 *   const model = runtime.getModel("anthropic", "claude-opus-4-5"); // Model<Api> | undefined
 *   const { session } = await createAgentSession({ model, thinkingLevel: "high", modelRuntime: runtime });
 *   只有 model 非 undefined 时才适合直接传入；下面的代码用 if 分支演示了这一点。
 *
 * 建议阅读顺序：先看 ModelRuntime.create 与 getModel 的两种目录查询，再看 getAvailable 的认证
 * 过滤，最后看 createAgentSession 的选项和事件流。
 */

// createAgentSession 是装配工厂；ModelRuntime 是运行时类，既出现在类型位置也在这里被 new/await。
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";

// 创建默认模型/认证运行时：读取全局 agentDir 下的 auth.json 和 models.json。
// 构造期间会加载目录和凭证，但不会向模型提供商发送对话请求。
const modelRuntime = await ModelRuntime.create();

// Option 1: Find a specific built-in model by provider/id
// 按 provider 与 id 在已加载目录中查找；返回值可能是 undefined，因此下面必须检查。
const opus = modelRuntime.getModel("anthropic", "claude-opus-4-5");
if (opus) {
	// Model 对象带 provider/id 等元数据；模板字符串把它们拼成可读标识。
	console.log(`Found model: ${opus.provider}/${opus.id}`);
}

// Option 2: Find model via registry (includes custom models from models.json)
// 自定义模型也注册进同一个运行时，所以查询方式与内置模型相同；my-provider/my-model 只是占位名。
const customModel = modelRuntime.getModel("my-provider", "my-model");
if (customModel) {
	// 找到才打印，避免对 undefined 读取属性。
	console.log(`Found custom model: ${customModel.provider}/${customModel.id}`);
}

// Option 3: Pick from available models (have valid API keys)
// getAvailable 会检查各提供商的认证配置（环境变量、auth.json、OAuth 等），只返回可用的模型。
// 有专用 check 的供应商通常只读配置；没有专用 check 的自定义解析器可能执行自己的 I/O，
// 因此不能把 availability 查询当作绝对纯内存快照。
// 它返回 readonly 数组；后面的 map 生成新的字符串数组，不修改原数组。
const available = await modelRuntime.getAvailable();
console.log(
	"Available models:",
	available.map((m) => `${m.provider}/${m.id}`),
);

if (available.length > 0) {
	// 把运行时和模型一起传入：会话内部复用同一份目录/凭证，不会再创建一个默认运行时。
	const { session } = await createAgentSession({
		// 数组已确认非空；TypeScript 仍把 available[0] 视为 Model 类型（未开启 noUncheckedIndexedAccess 时）。
		model: available[0],
		thinkingLevel: "medium", // off, low, medium, high
		// 显式运行时优先于 createAgentSession 内部按 agentDir 新建的默认实例。
		modelRuntime,
	});

	// 与 01 相同：finally 保证异常时也释放会话。
	try {
		// 只关心文字增量；message_update 的其他子类型（思考、工具参数等）被忽略。
		session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				process.stdout.write(event.assistantMessageEvent.delta);
			}
		});

		// 等待整轮运行结束；thinkingLevel 只是请求值，最终还会按模型能力夹取。
		await session.prompt("Say hello in one sentence.");
		// 补换行，便于终端提示符另起一行。
		console.log();
	} finally {
		// 释放会话资源；没有显式 sessionManager，默认会留下一个持久化会话文件。
		session.dispose();
	}
}
