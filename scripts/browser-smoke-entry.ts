// 通用浏览器冒烟入口把多包公共值保持可达；用于发现 Node 专属依赖意外进入浏览器构建。
import { createHost, memoryLinkPair } from "@earendil-works/chord";
import { createHost as createOldHost, replicatedState } from "@earendil-works/chord/old";
import { createAssistantMessageEventStream, validateToolArguments } from "@earendil-works/pi-ai";
import { complete, getModel, getProviders, streamSimple } from "@earendil-works/pi-ai/compat";
import { Agent, streamProxy } from "@earendil-works/pi-agent-core";
import { obj, str } from "@earendil-works/pi-schema";

// Keep this entry browser-safe. It is bundled by scripts/check-browser-smoke.mjs
// to catch accidental Node-only runtime imports in browser-facing package exports.
// 兼容层同步取内置 Google 聊天模型；打包器会解析这些导入，但冒烟构建不会执行模型请求。
const model = getModel("google", "gemini-2.5-flash");
// 用运行时 schema 构建器声明 prompt 应为字符串；TypeScript 类型本身不会校验外部 JSON。
const schema = obj({ prompt: str() });
// 保留校验器依赖；如果执行入口，这里按 schema 校验并转换参数，失败会抛错。
const args = validateToolArguments(
	// 工具定义将上面的 schema 作为参数规范。
	{ name: "prompt", description: "", parameters: schema },
	// 故意给数字 prompt，让运行时转换路径进入图；这不是向模型发起工具调用。
	{ type: "toolCall", id: "1", name: "prompt", arguments: { prompt: 1 } },
);
// 创建内存事件队列和最终结果 Promise，不建立网络连接。
const stream = createAssistantMessageEventStream();

// 依赖注入兼容层流函数；只构造 Agent，不执行 prompt。
const agent = new Agent({ initialState: { model }, streamFn: streamSimple });
// 将一条用户消息放进插话队列，零时间戳是夹具数据；单独入队不会启动一轮模型请求。
agent.steer({ role: "user", content: [{ type: "text", text: "queued" }], timestamp: 0 });

// 读取下列值/函数以保留导出；如执行会打印状态，但 check-browser-smoke 仅打包，不运行生成 JS。
console.log(
	// 读取固定模型 id，保留模型查询路径。
	model.id,
	// 枚举兼容层注册供应商数量，不是远端服务健康检查。
	getProviders().length,
	// 只检查导出值的 JavaScript 种类，不调用完整回答接口。
	typeof complete,
	// 读取 schema 的对象类型标签。
	schema.type,
	// 引用经运行时校验/转换后的字段。
	args.prompt,
	// 引用事件流推送方法，不向队列写入事件。
	typeof stream.push,
	// 检查刚排入的消息是否仍在队列中。
	agent.hasQueuedMessages(),
	// 保留代理流入口而不连接代理。
	typeof streamProxy,
	// 保留新版 Chord 工厂，不创建 Host。
	typeof createHost,
	// as 将旧版同名导出改为本地别名，避免两个 createHost 冲突。
	typeof createOldHost,
	// 引用内存链路工厂，此处不建立链路。
	typeof memoryLinkPair,
	// 建立旧版内存副本状态并读布尔值，保留状态实现；没有持久化或跨进程同步。
	replicatedState({ browser: true }).value.browser,
);
