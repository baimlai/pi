// 文件导读
// 所属：仓库根 scripts/ 下的通用浏览器冒烟入口；由 scripts/check-browser-smoke.mjs 用 esbuild（platform=browser）打包。
// 职责：把多个包的手写公共导出保留在同一张模块图里，验证浏览器构建不会意外拉入 Node 专属运行时依赖。
// 边界：它不启动服务、不连数据库、不发模型请求。脚本只做打包和输入图检查，不执行生成的 JS；
//   因此下面即使有 console.log，也只在有人手工运行产物时才执行。
// 上游：根 package.json 的 npm run check:browser-smoke（npm run check 也会运行）→ scripts/check-browser-smoke.mjs。
// 下游：@earendil-works/chord（含 old 子路径）、@earendil-works/pi-ai（含 compat）、pi-agent-core、pi-schema。
// 能力清单（无导出，演示的机制）：
//   1. 兼容层与根入口的模型查询（getModel/getProviders/complete/streamSimple）。
//   2. 运行时 schema 构建与工具参数校验（obj/str/validateToolArguments）。
//   3. Assistant 消息事件流与 Agent 排队接口（createAssistantMessageEventStream/Agent.steer）。
//   4. Chord v2/v1 的 Host 与内存链路工厂、旧版复制状态。
// 典型运行：node scripts/check-browser-smoke.mjs；成功时进程 0 退出且无输出，失败时写 /tmp/pi-browser-smoke-errors.log。
// 示例（与真实签名一致）：
//   const schema = obj({ prompt: str() });
//   const args = validateToolArguments({ name: "prompt", description: "", parameters: schema }, toolCall);
// 真实运行时行为：上面的 validateToolArguments 会按 schema 转换参数；给数字 prompt 会走错误/转换路径。
// 建议阅读顺序：先看 import 列表，再看模型/schema/流三段，最后看 console.log 如何强制保留每个导出。
// 通用浏览器冒烟入口把多包公共值保持可达；用于发现 Node 专属依赖意外进入浏览器构建。
// Chord v2 根入口：Host 工厂与内存链路对应当前实现，浏览器应能打包它们而不需要 Node 专属模块。
import { createHost, memoryLinkPair } from "@earendil-works/chord";
// 旧版入口同样要能在浏览器打包；as 给同名 createHost 取本地别名，避免与上一行冲突。
import { createHost as createOldHost, replicatedState } from "@earendil-works/chord/old";
// pi-ai 根入口：事件流是纯内存队列；校验器会调用 schema 实现，二者都不应依赖 Node。
import { createAssistantMessageEventStream, validateToolArguments } from "@earendil-works/pi-ai";
// compat 子路径暴露旧版调用方式（complete/getModel/getProviders/streamSimple），要检查它没有拖入 Node 依赖。
import { complete, getModel, getProviders, streamSimple } from "@earendil-works/pi-ai/compat";
// Agent 核心与代理流入口；这里只保留导出，不发起请求。
import { Agent, streamProxy } from "@earendil-works/pi-agent-core";
// pi-schema 提供运行时 schema 构建器，与纯类型声明不同。
import { obj, str } from "@earendil-works/pi-schema";

// Keep this entry browser-safe. It is bundled by scripts/check-browser-smoke.mjs
// to catch accidental Node-only runtime imports in browser-facing package exports.
// 兼容层同步取内置 Google 聊天模型；打包器会解析这些导入，但冒烟构建不会执行模型请求。
// getModel 是同步的静态目录查询，类型为具体 Model；若 id 不存在会抛错，而不是返回 undefined。
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
// 这是一个“生产者 + 消费者”对象：push 写入事件，result() 返回最终 AssistantMessage 的 Promise；这里只保留引用。
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
