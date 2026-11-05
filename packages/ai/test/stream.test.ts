// 文件导读
//
// 所属包与功能模块：packages/ai 的端到端（E2E）provider 测试。它不测某个内部函数，而是用真实模型服务验证统一抽象
// 在每家 provider 上的实际行为，因此这里的“被测模块”是 ../src/compat.ts 导出的 getModel()/stream()/complete()，
// 以及它们最终调用的各 provider 适配器（src/providers/ 下对应实现）。
//
// 本文件解决什么问题：同一段应用代码（文本生成、工具调用、流式事件、思考内容、图片输入、多轮工具结果回填）能否在
// Gemini、OpenAI、Anthropic、Bedrock、Ollama 等不同后端上得到一致的事件与消息形状。v1 的 E2E 只做真实调用校验，
// 不构造假 provider；需要确定性的单元测试在别的测试文件里。
// 职责边界：这里只断言公开契约（消息角色/内容块、usage、stopReason、事件序列），不断言各家原始 JSON；唯一例外是
// Bedrock 的 payload 断言，用 onPayload 钩子检查适配器改写请求字段的结果。
// 上游入口：测试运行器加载本文件；凭据环境变量决定哪些 describe 参与运行。
// 下游依赖：compat.ts（统一入口）、types.ts（消息/事件类型）、支持文件 azure-utils.ts、bedrock-utils.ts、
// cloudflare-utils.ts、oauth.ts（分别判断凭据与解析 OAuth token）。
// 结果与错误流向：断言失败抛出 vitest 的 AssertionError，测试失败；真实服务不稳定时通过 it 的 retry 重试。
//
// 能力清单（文件内的辅助函数与分组）：
// - basicTextGeneration：两轮 complete，验证文本、usage、无 errorMessage。
// - handleToolCall：消费 stream 事件，验证 toolcall_start/delta/end 与最终 stopReason === "toolUse"。
// - handleStreaming：验证 text_start/delta/end 事件与最终文本块。
// - handleThinking：验证 thinking_start/delta/end 事件与 stopReason === "stop"。
// - handleImage：读入 test/data/red-circle.png，以 base64 ImageContent 提问，断言回答包含 red 和 circle。
// - multiTurn：最多 5 轮 complete，手动执行 math_operation 工具，验证最终文本包含 714 与 887。
// - 每个 describe 块：一个 provider/model 组合，用 describe.skipIf / it.skipIf 按环境凭据开关。
//
// 组合与典型调用顺序：getModel(provider, id) 取模型元数据 -> complete/stream 发起一次或多次调用 -> 辅助函数断言。
// 所有工具相关用例共用同一个 calculatorTool（名称 math_operation，参数 a、b、operation）。
//
// 示例（真实签名，不是运行时额外行为）：
//   const llm = getModel("google", "gemini-2.5-flash");
//   await basicTextGeneration(llm, { thinking: { enabled: true, budgetTokens: 1024 } });
// 这里的 options 会原样传给 compat.ts 的 complete()，由 provider 适配器解释。
//
// 运行命令（在 packages/ai 目录下）：
//   node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/stream.test.ts
// 注意：没有对应 API key/OAuth token 时，各 describe 会被 skipIf 整组跳过；设置了凭据就会访问真实网络并产生费用。
// 本地 Ollama 分组还要求已安装 ollama 且未设置 PI_NO_LOCAL_LLM。
//
// 建议阅读顺序：先看导入与模块级 OAuth 解析 -> calculatorSchema/calculatorTool -> 六个辅助函数（它们定义了所有断言）
// -> 任意一个 provider 的 describe（例如 Gemini 或 Ollama）-> 特殊用例（OpenAI Completions 的模型重建、Bedrock 的
// payload 断言）-> 最后浏览其余 provider 分组。
import { type ChildProcess, execSync, spawn } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { Type } from "typebox";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { complete, getModel, stream } from "../src/compat.ts";
import type { Api, Context, ImageContent, Model, StreamOptions, Tool, ToolResultMessage } from "../src/types.ts";

// 交叉类型（&）：保留 StreamOptions 的必选字段（如 signal），同时允许传入各 provider 特有的任意键
// （apiKey、azureDeploymentName、project/location、headers、thinking 等）。这些额外键在编译期不做校验，
// 由 provider 适配器在运行时读取；这是测试刻意为“透传选项”留下的入口，不代表库的公开类型允许任意键。
type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { StringEnum } from "../src/utils/string-enum.ts";
import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";
import { hasCloudflareAiGatewayCredentials, hasCloudflareWorkersAICredentials } from "./cloudflare-utils.ts";
import { resolveApiKey } from "./oauth.ts";

// ESM 模块没有 CommonJS 的 __filename/__dirname，这里从 import.meta.url（当前模块的 file: URL）反推。
// 结果用于定位测试图片 test/data/red-circle.png；路径基于本文件，而不是进程的当前工作目录。
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve OAuth tokens at module level (async, runs before tests)
// 顶层 await：模块求值时就并行解析三个 OAuth 凭据（读取 ~/.pi/agent/oauth.json 等），测试开始前完成。
// Promise.all 并行等待，任一 resolveApiKey 返回 undefined（未登录）不会拒绝，只是对应 token 为 undefined，
// 后面的 it.skipIf 会跳过相关用例。
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
// 数组解构：按 Promise.all 的顺序取出三个结果，分别供 Anthropic/GitHub Copilot/OpenAI Codex 分组使用。
// 类型上每项是 string | undefined，it.skipIf 的布尔条件会把 undefined 变成“跳过”。
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

// Calculator tool definition (same as examples)
// Note: Using StringEnum helper because Google's API doesn't support anyOf/const patterns
// that Type.Enum generates. Google requires { type: "string", enum: [...] } format.
// 工具参数 schema，用 TypeBox 描述并同时承担两件事：
// 1. 生成发送给模型的 JSON Schema（providers 需要它来声明函数签名）；
// 2. 给 TypeScript 提供静态类型（typeof calculatorSchema），让下面的 Tool 参数获得 a/b/operation 的类型。
// 注意 schema 本身不会在本地校验模型返回的参数；运行时模型输出仍要由调用方解析和检查。
const calculatorSchema = Type.Object({
	a: Type.Number({ description: "First number" }),
	b: Type.Number({ description: "Second number" }),
	// StringEnum 生成 { type: "string", enum: [...] }，而不是 Type.Enum 的 anyOf/const 形式；
	// 注释说明了原因：Google 的 API 不接受后者。
	operation: StringEnum(["add", "subtract", "multiply", "divide"], {
		description: "The operation to perform. One of 'add', 'subtract', 'multiply', 'divide'.",
	}),
});

// 工具定义：Tool<typeof calculatorSchema> 是泛型用法，参数类型取自 schema。
// 所有工具调用用例都要求模型选择这个名称；这是断言“模型确实调用了工具”的依据。
const calculatorTool: Tool<typeof calculatorSchema> = {
	name: "math_operation",
	description: "Perform basic arithmetic operations",
	parameters: calculatorSchema,
};

// basicTextGeneration：所有 provider 共用的“最小可用”冒烟测试。
// 输入：model 是 getModel 得到的模型元数据；options 原样透传给 provider（如 OAuth 的 apiKey、Vertex 的 project）。
// 输出：无返回值；靠 expect 断言，失败时抛错让当前 it 失败。
// 副作用：发起两次真实网络请求，可能产生费用；不会修改 model/options。
// 主要流程：第一轮要求精确回复 -> 校验角色/内容/usage/错误字段 -> 把回答和第二问追加到同一 Context -> 第二轮验证
// 多轮上下文能被服务接受。这里没有 try/catch：错误作为测试失败上报（it 的 retry 负责重试）。
// 示例：await basicTextGeneration(getModel("google", "gemini-2.5-flash"));
// 真实运行时行为：complete() 是 stream(...).result() 的封装（见 compat.ts），所以它消费完整流后返回聚合消息。
async function basicTextGeneration<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	// 泛型 <TApi extends Api> 让 model 的 api 字段与 Model 的 provider 类型保持关联；options 是可选的。
	// Context 是发送给模型的消息集合：systemPrompt 加 messages；timestamp 是 pi 消息模型要求的字段。
	const context: Context = {
		systemPrompt: "You are a helpful assistant. Be concise.",
		messages: [{ role: "user", content: "Reply with exactly: 'Hello test successful'", timestamp: Date.now() }],
	};
	// await 等到整条流结束并聚合出 AssistantMessage；options 未传时 provider 使用环境变量里的凭据。
	const response = await complete(model, context, options);

	// role 固定为 assistant；content 是内容块数组（text/thinking/toolCall），空数组也算 falsy 之外的 truthy，
	// 下面的文本断言才是“确实有文字”的强校验。
	expect(response.role).toBe("assistant");
	expect(response.content).toBeTruthy();
	// usage.input 与 cacheRead 可能分开计费；两者之和大于 0 说明 prompt 确实被计量。缓存命中的 provider 可能
	// 把输入计入 cacheRead，所以不能只断言 usage.input。
	expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
	expect(response.usage.output).toBeGreaterThan(0);
	// errorMessage 是失败时的可读信息；成功响应必须为空/未定义。
	expect(response.errorMessage).toBeFalsy();
	// map + join：只拼接 text 块，忽略 thinking/toolCall。三元表达式在非 text 块返回空串。
	expect(response.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain("Hello test successful");

	// 把第一轮 assistant 消息原样放回上下文；第二条用户消息验证多轮对话。push 会修改 context.messages，
	// 这是测试刻意构造的会话历史。
	context.messages.push(response);
	context.messages.push({ role: "user", content: "Now say 'Goodbye test successful'", timestamp: Date.now() });

	const secondResponse = await complete(model, context, options);

	// 第二轮重复同样的结构断言；内容断言换成 Goodbye，确认第二轮确实由新问题驱动。
	expect(secondResponse.role).toBe("assistant");
	expect(secondResponse.content).toBeTruthy();
	expect(secondResponse.usage.input + secondResponse.usage.cacheRead).toBeGreaterThan(0);
	expect(secondResponse.usage.output).toBeGreaterThan(0);
	expect(secondResponse.errorMessage).toBeFalsy();
	expect(secondResponse.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain(
		"Goodbye test successful",
	);
}

// handleToolCall：验证流式工具调用事件协议与最终消息。
// 输入：model 与透传 options。输出：无返回值，全部通过 expect 断言。
// 副作用：一次真实网络请求；读取并累积流式 delta。
// 错误路径：若 provider 不产生 toolcall_* 事件，末尾的 hasToolStart/hasToolDelta/hasToolEnd 断言失败；
// 若流结束但 stopReason 不是 toolUse，也会失败。
// 主要流程：发起 stream -> for await 消费事件 -> 在 start/delta/end 三个阶段分别检查 partial.content 对应索引
// 的 toolCall 块 -> 用 s.result() 取聚合消息 -> 确认最终内容里有 toolCall。
// 示例：await handleToolCall(getModel("openai", "gpt-5.4"));
// 说明：partial 是“到目前为止”的助手消息快照，事件里的 contentIndex 指向该快照中正在增长的工具调用块。
async function handleToolCall<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			{
				role: "user",
				content: "Calculate 15 + 27 using the math_operation tool.",
				timestamp: Date.now(),
			},
		],
		tools: [calculatorTool],
	};

	// stream() 返回 AssistantMessageEventStream：它既是异步可迭代对象（逐个事件），也有 result() 取最终消息。
	// 这里先消费事件，再从同一个流对象取结果；两者不冲突，result() 会等流结束。
	const s = await stream(model, context, options);
	// 这几个布尔量记录三种事件是否都出现过；循环结束后统一断言，避免在循环中因 provider 事件顺序不同而过早失败。
	let hasToolStart = false;
	let hasToolDelta = false;
	let hasToolEnd = false;
	// 累积 delta 文本，用于 end 时独立 JSON.parse 一次，证明拼接后的参数是合法 JSON。
	let accumulatedToolArgs = "";
	// 记录 toolcall_start 的 contentIndex；后续 delta/end 必须指向同一个内容块。
	let index = 0;
	// for await...of 自动处理流的结束与背压；每个 event 是判别联合，用 event.type 收窄分支。
	for await (const event of s) {
		if (event.type === "toolcall_start") {
			hasToolStart = true;
			// partial 是当前已聚合的 AssistantMessage；contentIndex 是正在写入的内容块下标。
			const toolCall = event.partial.content[event.contentIndex];
			// 记住下标，后续事件用它做一致性检查。
			index = event.contentIndex;
			expect(toolCall.type).toBe("toolCall");
			// TypeScript 的判别联合收窄：上面断言后仍要显式 if，编译器才会把 toolCall 收窄为 ToolCall 块。
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				expect(toolCall.id).toBeTruthy();
			}
		}
		if (event.type === "toolcall_delta") {
			hasToolDelta = true;
			// 每个 delta 都从 partial 重新取块；块对象可能被增量更新，不能缓存旧引用。
			const toolCall = event.partial.content[event.contentIndex];
			// 同一工具调用的所有分片必须落在同一 contentIndex 上。
			expect(event.contentIndex).toBe(index);
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				// delta 是本次新增的 JSON 文本片段；拼接后才是完整参数。
				accumulatedToolArgs += event.delta;
				// Check that we have a parsed arguments object during streaming
				// 流进行中也要有可用的 arguments 对象（至少是空对象），不能是 undefined/null；
				// 这让调用方可以在 end 之前安全地读取已解析的部分参数。
				expect(toolCall.arguments).toBeDefined();
				expect(typeof toolCall.arguments).toBe("object");
				// The arguments should be partially populated as we stream
				// At minimum it should be an empty object, never undefined
				expect(toolCall.arguments).not.toBeNull();
			}
		}
		if (event.type === "toolcall_end") {
			hasToolEnd = true;
			const toolCall = event.partial.content[event.contentIndex];
			expect(event.contentIndex).toBe(index);
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				// 独立解析一次累积文本；若 provider 发来的分片拼不成合法 JSON，这里会抛错。
				JSON.parse(accumulatedToolArgs);
				// end 事件后参数必须已完整解析。
				expect(toolCall.arguments).not.toBeUndefined();
				// 强转 any 只是为了让测试能访问模型返回的动态参数；真实业务代码应使用 schema 校验后的类型。
				expect((toolCall.arguments as any).a).toBe(15);
				expect((toolCall.arguments as any).b).toBe(27);
				// oneOf 是 vitest 的“属于给定集合”断言，比逐项 toBe 更适合枚举。
				expect((toolCall.arguments as any).operation).oneOf(["add", "subtract", "multiply", "divide"]);
			}
		}
	}

	// 三种事件缺一不可：只有最终消息没有流式过程也算失败。
	expect(hasToolStart).toBe(true);
	expect(hasToolDelta).toBe(true);
	expect(hasToolEnd).toBe(true);

	// result() 返回聚合后的 AssistantMessage；stopReason 为 toolUse 表示模型因工具调用而停止。
	const response = await s.result();
	expect(response.stopReason).toBe("toolUse");
	// some 检查聚合内容中至少有一个工具调用块。
	expect(response.content.some((b) => b.type === "toolCall")).toBeTruthy();
	// find 取第一个工具调用，再做名称/id 断言；找不到时 throw 让失败信息更直接。
	const toolCall = response.content.find((b) => b.type === "toolCall");
	if (toolCall && toolCall.type === "toolCall") {
		expect(toolCall.name).toBe("math_operation");
		expect(toolCall.id).toBeTruthy();
	} else {
		throw new Error("No tool call found in response");
	}
}

// handleStreaming：验证纯文本流的事件序列。
// 输入：model、透传 options；输出：无返回值。
// 流程：发起 stream -> 消费事件，分别记录 text_start、累积 text_delta、记录 text_end -> 取最终消息 ->
// 断言三个状态都为 true、最终内容含 text 块。
// 示例：await handleStreaming(model, { apiKey: token });
// 注意：这里不假设 delta 的分片数量或文本内容，只要求“开始过、有增量、结束过”，避免不同 provider 的分片策略
// 造成脆弱断言。
async function handleStreaming<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	// 三个状态量覆盖流的生命周期；textChunks 仅用于证明确实收到过非空文本。
	let textStarted = false;
	let textChunks = "";
	let textCompleted = false;

	const context: Context = {
		messages: [{ role: "user", content: "Count from 1 to 3", timestamp: Date.now() }],
		systemPrompt: "You are a helpful assistant.",
	};

	// 与 handleToolCall 不同，这里不 await stream()：stream() 同步返回可迭代的事件流对象，事件在迭代时产生。
	const s = stream(model, context, options);

	// else-if 链：一个事件只可能是其中一种，按判别联合的 type 分支处理。
	for await (const event of s) {
		if (event.type === "text_start") {
			textStarted = true;
		} else if (event.type === "text_delta") {
			// delta 是字符串片段；拼接不保证最终等于完整文本的某种分词，只用于长度断言。
			textChunks += event.delta;
		} else if (event.type === "text_end") {
			textCompleted = true;
		}
	}

	// 流结束后才能调用 result()；返回聚合消息。
	const response = await s.result();

	// 开始事件、非空增量、结束事件三者都必须出现，且最终消息里确有 text 内容块。
	expect(textStarted).toBe(true);
	expect(textChunks.length).toBeGreaterThan(0);
	expect(textCompleted).toBe(true);
	expect(response.content.some((b) => b.type === "text")).toBeTruthy();
}

// handleThinking：验证“思考/推理”内容以独立事件流和独立内容块暴露。
// 输入：model、控制思考的 options（reasoningEffort、thinking: { enabled, budgetTokens }、effort 等，随 provider 不同）。
// 输出：无返回值。副作用：一次真实请求。
// 流程：提一个需要多想一步的算术题 -> 消费 thinking_start/delta/end 事件 -> result() -> 断言 stopReason 为 stop、
// 三种事件都出现、最终消息含 thinking 块。
// 示例：await handleThinking(model, { thinkingEnabled: true, budgetTokens: 1024 });
// 说明：不同 provider 的思考开关键名不同，测试通过 provider 分组传入各自支持的字段；这里只依赖统一事件协议。
async function handleThinking<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	// 与 handleStreaming 同构的三个状态量，只是事件/内容块类型换成 thinking。
	let thinkingStarted = false;
	let thinkingChunks = "";
	let thinkingCompleted = false;

	const context: Context = {
		messages: [
			{
				role: "user",
				// 提示词要求模型“逐步思考”；${(Math.random() * 255) | 0} 在运行时生成 0-254 的随机整数，
				// | 0 把浮点数截断为 32 位整数。每次题目不同，避免模型直接命中缓存答案而跳过思考过程。
				content: `Think long and hard about ${(Math.random() * 255) | 0} + 27. Think step by step. Then output the result.`,
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	const s = stream(model, context, options);

	// 思考内容通常先于正文到达；这里只收集 thinking_*，正文与工具事件被忽略。
	for await (const event of s) {
		if (event.type === "thinking_start") {
			thinkingStarted = true;
		} else if (event.type === "thinking_delta") {
			thinkingChunks += event.delta;
		} else if (event.type === "thinking_end") {
			thinkingCompleted = true;
		}
	}

	const response = await s.result();

	// 第二个参数是断言失败时的自定义消息，把 provider 的错误信息带出来，便于定位真实服务问题。
	expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
	expect(thinkingStarted).toBe(true);
	expect(thinkingChunks.length).toBeGreaterThan(0);
	expect(thinkingCompleted).toBe(true);
	expect(response.content.some((b) => b.type === "thinking")).toBeTruthy();
}

// handleImage：验证图片输入在支持视觉的模型上的端到端传递。
// 输入：model、options；输出：无返回值（模型不支持图片时打印日志并提前返回，视为跳过而非失败）。
// 副作用：读取磁盘上的 PNG 并转 base64，发起一次含 ImageContent 的请求。
// 错误路径：文件缺失时 readFileSync 抛错；模型回答不含 red/circle 时断言失败。
// 示例：await handleImage(getModel("anthropic", "claude-haiku-4-5"));
// 说明：input 数组是模型元数据里声明支持的模态（"text" | "image"）；这是运行时的能力判断，不是类型收窄。
async function handleImage<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	// Check if the model supports images
	// 不支持图片的模型直接返回，避免必然失败的请求；这会让该 it “通过但没有断言”，是刻意的软跳过。
	if (!model.input.includes("image")) {
		console.log(`Skipping image test - model ${model.id} doesn't support images`);
		return;
	}

	// Read the test image
	// 用模块级 __dirname 拼绝对路径，避免依赖进程 cwd；图片本身是固定夹具（红圆）。
	const imagePath = join(__dirname, "data", "red-circle.png");
	const imageBuffer = readFileSync(imagePath);
	// Buffer.toString("base64") 得到协议要求的 base64 字符串（不带 data: 前缀）。
	const base64Image = imageBuffer.toString("base64");

	// ImageContent 是内容块联合中的图片成员：type 判别字段、data（base64）、mimeType。
	// 这里的类型注解保证字段名拼写正确；运行时 provider 决定如何序列化它。
	const imageContent: ImageContent = {
		type: "image",
		data: base64Image,
		mimeType: "image/png",
	};

	const context: Context = {
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "What do you see in this image? Please describe the shape (circle, rectangle, square, triangle, ...) and color (red, blue, green, ...). You MUST reply in English.",
					},
					imageContent,
				],
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	// 图片作为 user 消息 content 数组的一项，与文本提示并列；provider 适配器会把它转成各自的多模态格式。
	const response = await complete(model, context, options);

	// Check the response mentions red and circle
	expect(response.content.length > 0).toBeTruthy();
	// 取第一个 text 块；思考/工具块被忽略。用 if 收窄类型后再访问 text 字段。
	const textContent = response.content.find((b) => b.type === "text");
	if (textContent && textContent.type === "text") {
		// 不区分大小写，降低模型措辞差异造成的误报。
		const lowerContent = textContent.text.toLowerCase();
		// 同时检查颜色和形状，证明模型确实“看到”了图片而非复述提示词。
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

// multiTurn：验证“模型调用工具 -> 应用执行 -> 工具结果回填 -> 模型继续”的完整多轮循环。
// 输入：model、options；输出：无返回值。
// 副作用：最多 5 次真实 complete 调用；在本地执行加减乘运算并构造 ToolResultMessage。
// 错误路径：若模型返回的 a/b 不是数字则抛错；若 stopReason 为 error 则断言失败；若始终不停止则循环到 maxTurns 后
// 继续执行最终断言（714/887 可能缺失而失败）。
// 主要流程：循环 complete -> 把 assistant 消息入历史 -> 遍历内容块（文本/思考/工具调用）-> 对每个工具调用本地求值
// 并生成 toolResult -> 把结果批量 push 回历史 -> stop 时跳出 -> 断言见过思考或工具、最终文本含两个计算结果。
// 示例：await multiTurn(llm, { reasoningEffort: "medium" });
// 真实运行时行为：工具执行是测试手写的 switch，不是 pi 的自动执行器；这里验证的是协议往返。
async function multiTurn<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant that can use tools to answer questions.",
		messages: [
			{
				role: "user",
				content: "Think about this briefly, then calculate 42 * 17 and 453 + 434 using the math_operation tool.",
				timestamp: Date.now(),
			},
		],
		tools: [calculatorTool],
	};

	// Collect all text content from all assistant responses
	// 跨轮累积的正文、以及“见过思考/工具调用”的标记；maxTurns 防止模型永不 stop 导致测试挂死。
	let allTextContent = "";
	let hasSeenThinking = false;
	let hasSeenToolCalls = false;
	const maxTurns = 5; // Prevent infinite loops

	// 每一轮：发请求、把助手回答写入历史、执行其中所有工具调用、把结果写回历史，直到模型 stop 或用完轮数。
	for (let turn = 0; turn < maxTurns; turn++) {
		const response = await complete(model, context, options);

		// Add the assistant response to context
		// 必须原样保留 assistant 消息（含 toolCall 块），否则下一轮模型看不到自己请求过什么。
		context.messages.push(response);

		// Process content blocks
		// 一条助手消息可能同时含 text、thinking 和多个 toolCall；逐个内容块处理。
		const results: ToolResultMessage[] = [];
		for (const block of response.content) {
			if (block.type === "text") {
				allTextContent += block.text;
			} else if (block.type === "thinking") {
				hasSeenThinking = true;
			} else if (block.type === "toolCall") {
				hasSeenToolCalls = true;

				// Process the tool call
				// arguments 的类型由工具 schema 推导为对象；这里仍做运行时检查，因为模型返回的 JSON 不可信。
				expect(block.name).toBe("math_operation");
				expect(block.id).toBeTruthy();
				expect(block.arguments).toBeTruthy();

				// 解构出参数；operation 被声明为四个字面量之一（来自 StringEnum），switch 可穷举。
				const { a, b, operation } = block.arguments;
				// 显式 typeof 检查不是多余的：LLM 可能返回字符串数字，类型系统看不到真实网络数据。
				if (typeof a !== "number" || typeof b !== "number") throw new Error("Invalid math arguments");
				let result: number;
				// 只实现本题需要的 add/multiply；其他操作回退为 0（会让最终 714/887 断言失败，从而暴露问题）。
				switch (operation) {
					case "add":
						result = a + b;
						break;
					case "multiply":
						result = a * b;
						break;
					default:
						result = 0;
				}

				// Add tool result to context
				// toolResult 通过 toolCallId 与请求配对；content 是文本块数组，isError 表示工具执行失败。
				results.push({
					role: "toolResult",
					toolCallId: block.id,
					toolName: block.name,
					content: [{ type: "text", text: `${result}` }],
					isError: false,
					timestamp: Date.now(),
				});
			}
		}
		// 展开运算符把本轮所有工具结果一次性追加，保持与请求相同的顺序。
		context.messages.push(...results);

		// If we got a stop response with text content, we're likely done
		// 错误停止不重试，直接失败；stop 表示模型本轮不再请求工具，跳出循环。
		expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
		if (response.stopReason === "stop") {
			break;
		}
	}

	// Verify we got either thinking content or tool calls (or both)
	// 至少出现一种“过程性”内容，证明测试覆盖的是多步推理/工具，而不是模型一轮直接报答案。
	expect(hasSeenThinking || hasSeenToolCalls).toBe(true);

	// The accumulated text should reference both calculations
	// 42*17=714、453+434=887；最终自然语言回答必须包含两个结果，证明工具结果确实回填并被模型采用。
	expect(allTextContent).toBeTruthy();
	expect(allTextContent.includes("714")).toBe(true);
	expect(allTextContent.includes("887")).toBe(true);
}

// 顶层 describe 只是命名空间；真正的开关在每个子 describe 上。
// describe.skipIf(condition)：condition 为 true 时整组跳过（测试报告中显示 skipped），组内的 beforeAll 也不会运行。
// 这里的条件是“缺少凭据”，因此 set 了对应环境变量的开发者会真的访问网络。
// 每个子 describe 都遵循同一模式：取模型 -> 用 { retry: 3 } 包装各辅助函数。retry 只重试失败的 it，
// 用于吸收真实服务的偶发 429/5xx；它不会让逻辑错误通过。
describe("Generate E2E Tests", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Gemini Provider (gemini-2.5-flash)", () => {
		// getModel(provider, modelId) 从静态模型目录取元数据（api 类型、baseUrl、能力、成本等）；
		// 找不到时抛错。它不读取 API key，key 由 compat.ts 在请求时从环境变量补上。
		const llm = getModel("google", "gemini-2.5-flash");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking", { retry: 3 }, async () => {
			await handleThinking(llm, { thinking: { enabled: true, budgetTokens: 1024 } });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { thinking: { enabled: true, budgetTokens: 2048 } });
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	// Vertex 分组没有整组 skipIf，而是逐条 it.skipIf：因为“用项目+区域”和“只用 API key”是两种独立凭据方式，
	// 需要分别判断。isVertexConfigured 是运行时布尔值，不是类型守卫；as const 让 project/location 保持字面量类型，
	// 并阻止后续意外改写（只读推断）。
	describe("Google Vertex Provider (gemini-3-flash-preview)", () => {
		const vertexProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
		const vertexLocation = process.env.GOOGLE_CLOUD_LOCATION;
		const vertexApiKey = process.env.GOOGLE_CLOUD_API_KEY;
		const isVertexConfigured = Boolean(vertexProject && vertexLocation);
		const vertexOptions = { project: vertexProject, location: vertexLocation } as const;
		const llm = getModel("google-vertex", "gemini-3-flash-preview");

		it.skipIf(!isVertexConfigured)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, vertexOptions);
		});

		it.skipIf(!vertexApiKey)("should complete basic text generation with Vertex API key", { retry: 3 }, async () => {
			await basicTextGeneration(llm, { apiKey: vertexApiKey! });
		});

		it.skipIf(!isVertexConfigured)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, vertexOptions);
		});

		it.skipIf(!isVertexConfigured)("should handle thinking", { retry: 3 }, async () => {
			const { ThinkingLevel } = await import("@google/genai");
			await handleThinking(llm, {
				...vertexOptions,
				thinking: { enabled: true, budgetTokens: 1024, level: ThinkingLevel.LOW },
			});
		});

		it.skipIf(!isVertexConfigured)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, vertexOptions);
		});

		it.skipIf(!isVertexConfigured)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			const { ThinkingLevel } = await import("@google/genai");
			await multiTurn(llm, {
				...vertexOptions,
				thinking: { enabled: true, budgetTokens: 1024, level: ThinkingLevel.MEDIUM },
			});
		});

		it.skipIf(!isVertexConfigured)("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, vertexOptions);
		});
	});

	// 特殊分组：目录里的 openai/gpt-4o-mini 默认走 openai-responses API，这里要在同一模型上测试
	// openai-completions 适配器，于是解构掉 compat 字段并覆盖 api。
	// { compat: _compat, ...baseModel } 是“取出并丢弃 compat，其余字段收集到 baseModel”的写法；
	// void _compat 只是显式标记该变量被有意忽略（避免未使用变量告警）。
	// Model<"openai-completions"> 泛型参数是 api 字面量类型，确保覆盖后的对象与适配器匹配；这是编译期约束。
	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider (gpt-4o-mini)", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		void _compat;
		const llm: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	describe.skipIf(!process.env.DEEPSEEK_API_KEY)("DeepSeek Provider (deepseek-flash via OpenAI Completions)", () => {
		const llm = getModel("deepseek", "deepseek-flash");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoningEffort: "high" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoningEffort: "high" });
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider (gpt-5.4)", () => {
		const llm = getModel("openai", "gpt-5.4");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking", { retry: 2 }, async () => {
			await handleThinking(llm, { reasoningEffort: "high" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoningEffort: "high" });
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	// 从这里到 Ant Ling 的各 provider 分组结构完全相同：环境变量开关 -> getModel -> 用同一批辅助函数覆盖
	// 文本/工具/流式/思考/多轮（部分 provider 额外有图片）。差异只在模型 id、选项字段名和支持的能力；
	// 每个 it 的断言逻辑都在上面的辅助函数里，无需重复解释。某组缺少对应能力时，不要添加用例而不是让它必然失败。
	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider (claude-haiku-4-5)", () => {
		const model = getModel("anthropic", "claude-haiku-4-5");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(model, { thinkingEnabled: true });
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(model);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(model);
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(model);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider (gpt-4o-mini)", () => {
		const llm = getModel("azure", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, azureOptions);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, azureOptions);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, azureOptions);
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, azureOptions);
		});
	});

	describe.skipIf(!process.env.XAI_API_KEY)("xAI Provider (grok-4.7 via OpenAI Responses)", () => {
		const llm = getModel("xai", "grok-4.7");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoningEffort: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoningEffort: "medium" });
		});
	});

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq Provider (gpt-oss-20b via OpenAI Completions)", () => {
		const llm = getModel("groq", "openai/gpt-oss-20b");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoningEffort: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoningEffort: "medium" });
		});
	});

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras Provider (gpt-oss-120b via OpenAI Completions)", () => {
		const llm = getModel("cerebras", "gpt-oss-120b");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoningEffort: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoningEffort: "medium" });
		});
	});

	describe.skipIf(!hasCloudflareWorkersAICredentials())(
		"Cloudflare Workers AI Provider (Kimi K2.6 via OpenAI Completions)",
		() => {
			const llm = getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6");

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle thinking mode", { retry: 3 }, async () => {
				await handleThinking(llm, { reasoningEffort: "medium" });
			});

			it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
				await multiTurn(llm, { reasoningEffort: "medium" });
			});
		},
	);

	describe.skipIf(!hasCloudflareAiGatewayCredentials())(
		"Cloudflare AI Gateway → Workers AI (Kimi K2.6 via /compat)",
		() => {
			const llm = getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6");

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle thinking mode", { retry: 3 }, async () => {
				await handleThinking(llm, { reasoningEffort: "medium" });
			});

			it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
				await multiTurn(llm, { reasoningEffort: "medium" });
			});
		},
	);

	describe.skipIf(!hasCloudflareAiGatewayCredentials() || !process.env.OPENAI_API_KEY)(
		"Cloudflare AI Gateway → OpenAI BYOK (gpt-5.1 via /openai responses)",
		() => {
			const llm = getModel("cloudflare-ai-gateway", "gpt-5.1");
			const options = { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } };
			const thinkingOptions = {
				...options,
				thinkingEnabled: true,
				reasoningEffort: "medium",
			} satisfies StreamOptionsWithExtras;

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm, options);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm, options);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm, options);
			});

			it("should handle thinking mode", { retry: 3 }, async () => {
				await handleThinking(llm, thinkingOptions);
			});

			it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
				await multiTurn(llm, thinkingOptions);
			});
		},
	);

	describe.skipIf(!hasCloudflareAiGatewayCredentials() || !process.env.ANTHROPIC_API_KEY)(
		"Cloudflare AI Gateway → Anthropic BYOK (claude-sonnet-4-5 via /anthropic messages)",
		() => {
			const llm = getModel("cloudflare-ai-gateway", "claude-sonnet-4-5");
			const options = { headers: { Authorization: `Bearer ${process.env.ANTHROPIC_API_KEY}` } };
			const thinkingOptions = {
				...options,
				thinkingEnabled: true,
				reasoningEffort: "high",
			} satisfies StreamOptionsWithExtras;

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm, options);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm, options);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm, options);
			});

			it("should handle thinking mode", { retry: 3 }, async () => {
				await handleThinking(llm, thinkingOptions);
			});

			it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
				await multiTurn(llm, thinkingOptions);
			});
		},
	);

	describe.skipIf(!process.env.HF_TOKEN)("Hugging Face Provider (Kimi-K2.5 via OpenAI Completions)", () => {
		const llm = getModel("huggingface", "moonshotai/Kimi-K2.5");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoningEffort: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoningEffort: "medium" });
		});
	});

	describe.skipIf(!process.env.TOGETHER_API_KEY)("Together AI Provider (Kimi-K3 via OpenAI Completions)", () => {
		const llm = getModel("together", "moonshotai/Kimi-K3");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoningEffort: "high" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoningEffort: "high" });
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	describe.skipIf(!process.env.BASETEN_API_KEY)("Baseten Provider (GLM 5.2 via OpenAI Completions)", () => {
		const llm = getModel("baseten", "zai-org/GLM-5.2");
		const options = { reasoningEffort: "high" } satisfies StreamOptionsWithExtras;

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, options);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, options);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, options);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, options);
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, options);
		});
	});

	describe.skipIf(!process.env.NVIDIA_API_KEY)("NVIDIA NIM Provider (Nemotron 3.5 Super VL)", () => {
		const llm = getModel("nvidia", "nvidia/nemotron-3.5-super-vl-120b-a12b");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoningEffort: "high" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoningEffort: "high" });
		});
	});

	describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouter Provider (glm-4.5v via OpenAI Completions)", () => {
		const llm = getModel("openrouter", "z-ai/glm-4.5v");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoningEffort: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 2 }, async () => {
			await multiTurn(llm, { reasoningEffort: "medium" });
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)(
		"Vercel AI Gateway Provider (google/gemini-2.5-flash via Anthropic Messages)",
		() => {
			const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle image input", { retry: 3 }, async () => {
				await handleImage(llm);
			});

			it("should handle multi-turn with tools", { retry: 3 }, async () => {
				await multiTurn(llm);
			});
		},
	);

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)(
		"Vercel AI Gateway Provider (anthropic/claude-opus-4.5 via Anthropic Messages)",
		() => {
			const llm = getModel("vercel-ai-gateway", "anthropic/claude-opus-4.5");

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle image input", { retry: 3 }, async () => {
				await handleImage(llm);
			});

			it("should handle multi-turn with tools", { retry: 3 }, async () => {
				await multiTurn(llm);
			});
		},
	);

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)(
		"Vercel AI Gateway Provider (openai/gpt-5.1-codex-max via Anthropic Messages)",
		() => {
			const llm = getModel("vercel-ai-gateway", "openai/gpt-5.1-codex-max");

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle image input", { retry: 3 }, async () => {
				await handleImage(llm);
			});

			it("should handle multi-turn with tools", { retry: 3 }, async () => {
				await multiTurn(llm);
			});
		},
	);

	describe.skipIf(!process.env.ZAI_API_KEY)("zAI Provider (glm-5.2 via OpenAI Completions)", () => {
		const llm = getModel("zai", "glm-5.2");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoningEffort: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoningEffort: "medium" });
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider (devstral-medium-latest)", () => {
		const llm = getModel("mistral", "devstral-medium-latest");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		// 这两个用例在内层重新声明 const llm，遮蔽（shadow）了外层的 devstral 模型：只有支持推理的
		// mistral-small-2603 才跑思考用例。块级作用域让同名变量互不影响。
		it("should handle thinking mode", { retry: 3 }, async () => {
			const llm = getModel("mistral", "mistral-small-2603");
			await handleThinking(llm, { reasoningEffort: "high" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			const llm = getModel("mistral", "mistral-small-2603");
			await multiTurn(llm, { reasoningEffort: "high" });
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider (pixtral-12b with image support)", () => {
		const llm = getModel("mistral", "pixtral-12b");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax Provider (MiniMax-M2.7 via Anthropic Messages)", () => {
		const llm = getModel("minimax", "MiniMax-M2.7");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
		});
	});

	describe.skipIf(!process.env.KIMI_API_KEY)(
		"Kimi For Coding Provider (kimi-for-coding via OpenAI Completions)",
		() => {
			const llm = getModel("kimi-coding", "kimi-for-coding");

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle thinking mode", { retry: 3 }, async () => {
				await handleThinking(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
			});

			it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
				await multiTurn(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
			});
		},
	);

	describe.skipIf(!process.env.META_API_KEY)("Meta Provider (muse-spark-1.3 via OpenAI Responses)", () => {
		const llm = getModel("meta", "muse-spark-1.3");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
		});
	});

	describe.skipIf(!process.env.XIAOMI_API_KEY)(
		"Xiaomi MiMo (API billing) Provider (Xiaomi MiMo-V2.5-Pro via Anthropic Messages)",
		() => {
			const llm = getModel("xiaomi", "mimo-v2.6-pro");
			const thinkingOptions = {
				thinkingEnabled: true,
				reasoningEffort: "high",
			} satisfies StreamOptionsWithExtras;

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle thinking mode", { retry: 3 }, async () => {
				await handleThinking(llm, thinkingOptions);
			});

			it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
				await multiTurn(llm, thinkingOptions);
			});
		},
	);

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY)(
		"Xiaomi MiMo Token Plan Provider (Xiaomi MiMo-V2.5-Pro via Anthropic Messages, CN region)",
		() => {
			const llm = getModel("xiaomi-token-plan-cn", "mimo-v2.6-pro");
			const thinkingOptions = {
				thinkingEnabled: true,
				reasoningEffort: "high",
			} satisfies StreamOptionsWithExtras;

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle thinking mode", { retry: 3 }, async () => {
				await handleThinking(llm, thinkingOptions);
			});

			it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
				await multiTurn(llm, thinkingOptions);
			});
		},
	);

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY)(
		"Xiaomi MiMo Token Plan Provider (Xiaomi MiMo-V2.5-Pro via Anthropic Messages, AMS region)",
		() => {
			const llm = getModel("xiaomi-token-plan-ams", "mimo-v2.6-pro");
			const thinkingOptions = {
				thinkingEnabled: true,
				reasoningEffort: "high",
			} satisfies StreamOptionsWithExtras;

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle thinking mode", { retry: 3 }, async () => {
				await handleThinking(llm, thinkingOptions);
			});

			it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
				await multiTurn(llm, thinkingOptions);
			});
		},
	);

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY)(
		"Xiaomi MiMo Token Plan Provider (Xiaomi MiMo-V2.5-Pro via Anthropic Messages, SGP region)",
		() => {
			const llm = getModel("xiaomi-token-plan-sgp", "mimo-v2.6-pro");
			const thinkingOptions = {
				thinkingEnabled: true,
				reasoningEffort: "high",
			} satisfies StreamOptionsWithExtras;

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle thinking mode", { retry: 3 }, async () => {
				await handleThinking(llm, thinkingOptions);
			});

			it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
				await multiTurn(llm, thinkingOptions);
			});
		},
	);

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_API_KEY)(
		"Qwen Token Plan Provider (Qwen3.7-Max, international)",
		() => {
			const llm = getModel("qwen-token-plan", "qwen3.7-max");
			const thinkingOptions = {
				thinkingEnabled: true,
				reasoningEffort: "high",
			} satisfies StreamOptionsWithExtras;

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle thinking mode", { retry: 3 }, async () => {
				await handleThinking(llm, thinkingOptions);
			});

			it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
				await multiTurn(llm, thinkingOptions);
			});
		},
	);

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_API_KEY)(
		"Qwen Token Plan Individual Provider (Qwen3.8-Max, international)",
		() => {
			const llm = getModel("qwen-token-plan-individual", "qwen3.8-max");
			const thinkingOptions = {
				thinkingEnabled: true,
				reasoningEffort: "high",
			} satisfies StreamOptionsWithExtras;

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle thinking mode", { retry: 3 }, async () => {
				await handleThinking(llm, thinkingOptions);
			});

			it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
				await multiTurn(llm, thinkingOptions);
			});
		},
	);

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_CN_API_KEY)("Qwen Token Plan Provider (Qwen3.7-Max, CN region)", () => {
		const llm = getModel("qwen-token-plan-cn", "qwen3.7-max");
		const thinkingOptions = {
			thinkingEnabled: true,
			reasoningEffort: "high",
		} satisfies StreamOptionsWithExtras;

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, thinkingOptions);
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, thinkingOptions);
		});
	});

	describe.skipIf(!process.env.ANT_LING_API_KEY)("Ant Ling Provider (Ling 2.6 Flash via OpenAI Completions)", () => {
		const llm = getModel("ant-ling", "Ling-2.6-flash");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		// 思考用例换用同 provider 的 Ring 模型；Ling-2.6-flash 可能不支持推理输出。
		it("should handle thinking mode", { retry: 3 }, async () => {
			const ringModel = getModel("ant-ling", "Ring-2.6-1T");
			await handleThinking(ringModel, { reasoningEffort: "high" });
		});
	});

	// =========================================================================
	// OAuth-based providers (credentials from ~/.pi/agent/oauth.json)
	// Tokens are resolved at module level (see oauthTokens above)
	// =========================================================================
	// 这一组不是按环境变量整组跳过，而是用 it.skipIf(!token) 逐条判断：OAuth 登录状态可能只覆盖部分 provider。
	// token 以 options.apiKey 传入，覆盖 compat.ts 默认的环境变量 key 注入路径。

	describe("Anthropic OAuth Provider (claude-sonnet-4-6)", () => {
		const model = getModel("anthropic", "claude-sonnet-4-6");

		it.skipIf(!anthropicOAuthToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(model, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(model, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(model, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle thinking", { retry: 3 }, async () => {
			await handleThinking(model, { apiKey: anthropicOAuthToken, thinkingEnabled: true });
		});

		it.skipIf(!anthropicOAuthToken)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(model, { apiKey: anthropicOAuthToken, thinkingEnabled: true });
		});

		it.skipIf(!anthropicOAuthToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(model, { apiKey: anthropicOAuthToken });
		});
	});

	describe("Anthropic OAuth Provider (claude-opus-4-6 with adaptive thinking)", () => {
		const model = getModel("anthropic", "claude-opus-4-6");

		it.skipIf(!anthropicOAuthToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(model, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(model, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(model, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle adaptive thinking with effort high", { retry: 3 }, async () => {
			await handleThinking(model, { apiKey: anthropicOAuthToken, thinkingEnabled: true, effort: "high" });
		});

		it.skipIf(!anthropicOAuthToken)("should handle adaptive thinking with effort medium", { retry: 3 }, async () => {
			await handleThinking(model, { apiKey: anthropicOAuthToken, thinkingEnabled: true, effort: "medium" });
		});

		it.skipIf(!anthropicOAuthToken)(
			"should handle multi-turn with adaptive thinking and tools",
			{ retry: 3 },
			async () => {
				await multiTurn(model, { apiKey: anthropicOAuthToken, thinkingEnabled: true, effort: "high" });
			},
		);

		it.skipIf(!anthropicOAuthToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(model, { apiKey: anthropicOAuthToken });
		});
	});

	describe("GitHub Copilot Provider (gpt-6-luna via OpenAI Responses)", () => {
		const llm = getModel("github-copilot", "gpt-6-luna");

		it.skipIf(!githubCopilotToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, { apiKey: githubCopilotToken });
		});

		it.skipIf(!githubCopilotToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, { apiKey: githubCopilotToken });
		});

		it.skipIf(!githubCopilotToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, { apiKey: githubCopilotToken });
		});

		it.skipIf(!githubCopilotToken)("should handle thinking", { retry: 2 }, async () => {
			await handleThinking(llm, { apiKey: githubCopilotToken, reasoningEffort: "high" });
		});

		it.skipIf(!githubCopilotToken)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { apiKey: githubCopilotToken, reasoningEffort: "high" });
		});

		it.skipIf(!githubCopilotToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, { apiKey: githubCopilotToken });
		});
	});

	describe("GitHub Copilot Provider (claude-sonnet-4 via Anthropic Messages)", () => {
		const llm = getModel("github-copilot", "claude-sonnet-4.6");

		it.skipIf(!githubCopilotToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, { apiKey: githubCopilotToken });
		});

		it.skipIf(!githubCopilotToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, { apiKey: githubCopilotToken });
		});

		it.skipIf(!githubCopilotToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, { apiKey: githubCopilotToken });
		});

		it.skipIf(!githubCopilotToken)("should handle thinking", { retry: 2 }, async () => {
			await handleThinking(llm, { apiKey: githubCopilotToken, thinkingEnabled: true });
		});

		it.skipIf(!githubCopilotToken)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { apiKey: githubCopilotToken, thinkingEnabled: true });
		});

		it.skipIf(!githubCopilotToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, { apiKey: githubCopilotToken });
		});
	});

	describe("OpenAI Codex Provider (gpt-6.1-sol)", () => {
		const llm = getModel("openai-codex", "gpt-6.1-sol");

		it.skipIf(!openaiCodexToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, { apiKey: openaiCodexToken });
		});

		it.skipIf(!openaiCodexToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, { apiKey: openaiCodexToken });
		});

		it.skipIf(!openaiCodexToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, { apiKey: openaiCodexToken });
		});

		it.skipIf(!openaiCodexToken)("should handle thinking with reasoningEffort xhigh", { retry: 3 }, async () => {
			await handleThinking(llm, { apiKey: openaiCodexToken, reasoningEffort: "xhigh" });
		});

		it.skipIf(!openaiCodexToken)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { apiKey: openaiCodexToken, reasoningEffort: "xhigh" });
		});

		it.skipIf(!openaiCodexToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, { apiKey: openaiCodexToken });
		});
	});

	// 同一模型的 WebSocket 传输变体：transport: "websocket" 让适配器改用长连接。
	// as const 把 "websocket" 收窄为字面量类型（否则会被推断为 string，无法赋给 transport 的联合类型）。
	// 其余用例复用同一组辅助函数，证明传输层变化不影响事件协议。
	describe("OpenAI Codex Provider (gpt-6.1-sol via WebSocket)", () => {
		const llm = getModel("openai-codex", "gpt-6.1-sol");
		const wsOptions = { apiKey: openaiCodexToken, transport: "websocket" as const };

		it.skipIf(!openaiCodexToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, wsOptions);
		});

		it.skipIf(!openaiCodexToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, wsOptions);
		});

		it.skipIf(!openaiCodexToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, wsOptions);
		});

		it.skipIf(!openaiCodexToken)("should handle thinking with reasoningEffort xhigh", { retry: 3 }, async () => {
			await handleThinking(llm, { ...wsOptions, reasoningEffort: "xhigh" });
		});

		it.skipIf(!openaiCodexToken)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { ...wsOptions, reasoningEffort: "xhigh" });
		});

		it.skipIf(!openaiCodexToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, wsOptions);
		});
	});

	// Bedrock 使用 AWS 凭据链（hasBedrockCredentials 检查环境/共享配置），模型 id 带区域前缀。
	// reasoning 与 interleavedThinking 是 Bedrock 适配器特有的选项名，不同于 Anthropic 直连的 thinkingEnabled。
	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider (claude-sonnet-4-5)", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoning: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoning: "high" });
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider (claude-opus-4-6 interleaved thinking)", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");

		// 该用例不只断言结果，还通过 onPayload 钩子截获适配器最终发给 SDK 的请求体，验证字段映射：
		// reasoning: "xhigh" -> additionalModelRequestFields.output_config.effort = "max"，
		// interleavedThinking: true -> thinking = { type: "adaptive", display: "summarized" }，且不再发送 anthropic_beta。
		// onPayload 是同步回调，在请求发出前调用；capturedPayload 用 unknown 承接，随后显式收窄结构。
		it("should use adaptive thinking without anthropic_beta", { retry: 3 }, async () => {
			let capturedPayload: unknown;
			const response = await complete(
				llm,
				{
					systemPrompt: "You are a helpful assistant that uses tools when asked.",
					messages: [
						{
							role: "user",
							content: "Think first, then calculate 15 + 27 using the math_operation tool.",
							timestamp: Date.now(),
						},
					],
					tools: [calculatorTool],
				},
				{
					reasoning: "xhigh",
					interleavedThinking: true,
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
			expect(capturedPayload).toBeTruthy();

			// 断言后把 unknown 收窄为局部结构类型；这是测试里允许的类型断言，字段路径来自 Bedrock 适配器实现。
			const payload = capturedPayload as {
				additionalModelRequestFields?: {
					thinking?: { type?: string; display?: string };
					output_config?: { effort?: string };
					anthropic_beta?: string[];
				};
			};

			expect(payload.additionalModelRequestFields?.thinking).toEqual({
				type: "adaptive",
				display: "summarized",
			});
			expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "max" });
			expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
		});

		it("should pass requestMetadata to the SDK payload", { retry: 3 }, async () => {
			const llmSonnet = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");
			let capturedPayload: unknown;
			const metadata = { app: "pi-test", env: "ci" };
			const response = await complete(
				llmSonnet,
				{
					messages: [
						{
							role: "user",
							content: "Say hi.",
							timestamp: Date.now(),
						},
					],
				},
				{
					requestMetadata: metadata,
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
			expect(capturedPayload).toBeTruthy();
			expect((capturedPayload as { requestMetadata?: unknown }).requestMetadata).toEqual(metadata);
		});

		it("should omit requestMetadata from payload when not provided", { retry: 3 }, async () => {
			const llmSonnet = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");
			let capturedPayload: unknown;
			const response = await complete(
				llmSonnet,
				{
					messages: [
						{
							role: "user",
							content: "Say hi.",
							timestamp: Date.now(),
						},
					],
				},
				{
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
			expect(capturedPayload).toBeTruthy();
			expect("requestMetadata" in (capturedPayload as object)).toBe(false);
		});
	});

	// Check if ollama is installed and local LLM tests are enabled
	// 本地模型测试的双重开关：PI_NO_LOCAL_LLM 显式禁用（例如 CI 中避免启动常驻进程），以及 which ollama 探测。
	// execSync 抛错表示命令不存在；catch 把结果落为 false，而不是让整个测试文件失败。
	let ollamaInstalled = false;
	if (!process.env.PI_NO_LOCAL_LLM) {
		try {
			execSync("which ollama", { stdio: "ignore" });
			ollamaInstalled = true;
		} catch {
			ollamaInstalled = false;
		}
	}

	// Ollama 分组是唯一有 beforeAll/afterAll 生命周期的：它要确保模型存在、启动服务、等待端口可用，结束后杀进程。
	// skipIf 在收集阶段求值；ollamaInstalled 为 false 时 beforeAll 不会执行。
	describe.skipIf(!ollamaInstalled)("Ollama Provider (gpt-oss-20b via OpenAI Completions)", () => {
		// let 声明但没有初始化：确定赋值断言由 beforeAll 保证（运行前 TS 会提示可能未赋值，这里通过类型上下文接受）。
		let llm: Model<"openai-completions">;
		// 保存子进程句柄，afterAll 负责终止；初始为 null，表示尚未启动。
		let ollamaProcess: ChildProcess | null = null;

		// beforeAll：整组测试开始前执行一次；第二个参数 30000 是超时时间（毫秒），因为拉模型可能很慢。
		beforeAll(async () => {
			// Check if model is available, if not pull it
			// 先查本地是否已有模型；grep -q 只关心退出码，不输出内容。
			try {
				execSync("ollama list | grep -q 'gpt-oss:20b'", { stdio: "ignore" });
			} catch {
				console.log("Pulling gpt-oss:20b model for Ollama tests...");
				try {
					// stdio: "inherit" 让拉取进度直接显示在测试输出里。
					execSync("ollama pull gpt-oss:20b", { stdio: "inherit" });
				} catch (_e) {
					// 拉取失败时只警告并 return：llm 未赋值，后续测试会因连接失败而失败（不是静默通过）。
					// 这里的选择是让失败可见，而不是把环境问题伪装成通过。
					console.warn("Failed to pull gpt-oss:20b model, tests will be skipped");
					return;
				}
			}

			// Start ollama server
			// spawn 启动常驻服务；detached: false 让它与测试进程同组，stdio ignore 避免管道缓冲阻塞。
			ollamaProcess = spawn("ollama", ["serve"], {
				detached: false,
				stdio: "ignore",
			});

			// Wait for server to be ready
			// 轮询 /api/tags 直到返回 ok；没有用固定 sleep，因为模型加载时间不确定。
			// new Promise<void> 手动控制 resolve；递归 setTimeout 500ms 重试。初始延迟 1s 给进程启动时间。
			await new Promise<void>((resolve) => {
				const checkServer = async () => {
					try {
						const response = await fetch("http://localhost:11434/api/tags");
						if (response.ok) {
							resolve();
						} else {
							setTimeout(checkServer, 500);
						}
					} catch {
						// 服务尚未监听时 fetch 抛错，同样重试。
						setTimeout(checkServer, 500);
					}
				};
				setTimeout(checkServer, 1000); // Initial delay
			});

			// 手工构造 Model 元数据，指向本地 OpenAI 兼容端点；apiKey 在测试里任意传 "test"。
			// cost 全 0 表示本地推理不产生费用；input 只有 text，所以该组不跑图片用例。
			llm = {
				id: "gpt-oss:20b",
				api: "openai-completions",
				provider: "ollama",
				baseUrl: "http://localhost:11434/v1",
				reasoning: true,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 16000,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				name: "Ollama GPT-OSS 20B",
			};
		}, 30000); // 30 second timeout for setup

		// afterAll：无论测试成败都尝试终止子进程，避免残留 ollama serve；SIGTERM 让服务自行清理。
		afterAll(() => {
			// Kill ollama server
			if (ollamaProcess) {
				ollamaProcess.kill("SIGTERM");
				ollamaProcess = null;
			}
		});

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, { apiKey: "test" });
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, { apiKey: "test" });
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, { apiKey: "test" });
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { apiKey: "test", reasoningEffort: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { apiKey: "test", reasoningEffort: "medium" });
		});
	});
});
