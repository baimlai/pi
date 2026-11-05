// 验证重放历史思考时空签名的处理与目录兼容设置；所有参数截获后终止，不调用模型。
import { describe, expect, it } from "vitest";
import { getModel, getModels, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

// 本地截获视图只声明 messages 相关字段；interface 无运行时代码，不能据此相信任意 wire 数据。
interface AnthropicPayload {
	// 可选 messages 是对象数组；Array<T> 与 T[] 都表示元素类型，不实际分配数组。
	messages?: Array<{
		// 这里用 string 容纳协议角色，实际测试会查找 assistant。
		role: string;
		// 块的 type 必须是字符串，其余字段可省略；宽视图便于比较文字与思考的两种协议形状。
		content: Array<{ type: string; text?: string; thinking?: string; signature?: string }>;
	}>;
}

// 此错误仅作为截获请求体后的主动停止标记；继承 Error 保留标准错误消息/堆栈，不代表远端拒绝。
class PayloadCaptured extends Error {
	// 构造不接收参数的停止标记，调用父类后改 name；例如 onPayload 抛它会让事件流以错误收尾。
	constructor() {
		// super 调用 Error 的构造函数，初始化错误 message，必须先于访问 this。
		super("payload captured");
		// 改实例的错误名称，便于区分测试主动停止和其他失败。
		this.name = "PayloadCaptured";
	}
}

// 按可选 allowEmptySignature 建立 Xiaomi 风格 Messages 模型，无网络。例省略时用默认 false，true 时保留无签名 thinking。
function makeModel(allowEmptySignature?: boolean): Model<"anthropic-messages"> {
	// 返回新建夹具对象；函数本身只组装内存数据，没有模型调用。
	return {
		// 请求模型 id，与 makeContext 默认历史模型一致，避免跨模型历史转换干扰签名测试。
		id: "mimo-v2.6-pro",
		// 展示名保持原夹具值；路由身份由 id/provider/api 决定。
		name: "MiMo-V2.5-Pro",
		// API 字面量让 TypeScript 把模型与 Anthropic 专用选项匹配，不探测远端协议。
		api: "anthropic-messages",
		// 使用兼容服务身份，验证统一适配器面对非 Anthropic 官方供应商时的签名规则。
		provider: "xiaomi-token-plan-ams",
		// 本地不可用地址仅作兜底，正常路径在 onPayload 主动停止，不连接真实服务。
		baseUrl: "http://127.0.0.1:9/anthropic",
		// 声明模型具有思考能力；是否发 thinking 仍由选项与 compat 决定。
		reasoning: true,
		// 夹具仅声明接受文字输入，不包含图片能力。
		input: ["text"],
		// 零价格夹具满足模型类型，本测试不验证真实费用。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// 夹具容量用于满足模型元数据约定，不实际构造百万 token 上下文。
		contextWindow: 1048576,
		// 夹具默认输出上限，与这里检查历史签名的目标无关。
		maxTokens: 1024,
		// 条件展开只在参数明确给出时添加 compat；false 也会被保留，不用真假判断丢掉 false。
		...(allowEmptySignature === undefined ? {} : { compat: { allowEmptySignature } }),
	};
}

// 把给定签名、思考正文和来源身份包装成 user→assistant→user 历史，返回新上下文；无网络。例签名空串而正文非空测试降级为 text。
function makeContext(
	// 必填历史签名字符串，可故意为空或空格来测兼容边界。
	thinkingSignature: string,
	// 默认参数在省略或 undefined 时提供固定正文，显式空串仍保留。
	thinking = "internal reasoning",
	// 默认历史供应商与夹具模型一致；调用方可改成 fireworks 复用历史构建。
	provider = "xiaomi-token-plan-ams",
	// 默认历史模型 id，避免把无签名处理误与跨模型转换混在一起。
	model = "mimo-v2.6-pro",
	// 返回旧式 Context 形状，streamSimple 后续负责规范化成轨迹。
): Context {
	// 显式类型检查历史回复具有必需字段；对象只是夹具，并非真实模型生成结果。
	const assistant: AssistantMessage = {
		// 判别标签让这条历史按 assistant 分支转换。
		role: "assistant",
		// 属性简写放入输入正文和签名，保留空串/空白的原始差别。
		content: [{ type: "thinking", thinking, thinkingSignature }],
		// 来源供应商使用函数输入，供历史是否同源的判断。
		provider,
		// API 字面量让 TypeScript 把模型与 Anthropic 专用选项匹配，不探测远端协议。
		api: "anthropic-messages",
		// 来源模型使用函数输入，不从展示名推导。
		model,
		// 为历史提供本地毫秒时间，转换测试不比较具体值。
		timestamp: Date.now(),
		// 补齐统一回复要求的用量结构，后面的零数值是夹具，并非计费报告。
		usage: {
			// 普通输入量置零，测试不依赖真实 token 计数。
			input: 0,
			// 输出量置零，不把思考字符串长度当作 token 数。
			output: 0,
			// 缓存读取量置零。
			cacheRead: 0,
			// 缓存写入量置零。
			cacheWrite: 0,
			// 总 token 量置零，满足 AssistantMessage 类型。
			totalTokens: 0,
			// 所有费用为零，夹具仅用于历史回放。
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		// 将历史设为正常完成，避免错误/中断历史过滤影响签名断言。
		stopReason: "stop",
	};
	// 返回新建夹具对象；函数本身只组装内存数据，没有模型调用。
	return {
		// 按时间顺序建立三轮历史数组，不在 helper 内发起模型请求。
		messages: [
			// 首条用户消息为 assistant 思考提供上下文。
			{ role: "user", content: "first", timestamp: Date.now() },
			// 复用刚构造的 assistant 对象，数组没有深复制它。
			assistant,
			// 后续用户消息触发历史 assistant 被重放到下一次请求。
			{ role: "user", content: "second", timestamp: Date.now() },
		],
	};
}

// 输入模型/历史，截获序列化 messages 后主动终止并返回 Promise；例如查 assistant.content 即可检查签名转换，无真实请求。
async function capturePayload(model: Model<"anthropic-messages">, context: Context): Promise<AnthropicPayload> {
	// 先用 undefined 表示没有捕获；回调会给这个闭包变量赋值，不是修改外部会话。
	let capturedPayload: AnthropicPayload | undefined;
	// 走兼容入口完成历史规范化与 Anthropic 参数构建，下方钩子在发送前保存对象。
	const stream = streamSimple(model, context, {
		// 给适配器本地认证前置检查一个假 key，测试不会拿它访问真实服务。
		apiKey: "fake-key",
		// 请求参数构造完成、SDK 创建请求前调用此箭头函数；输入为待发参数，下面先保存后抛错。
		onPayload: (payload) => {
			// 以类型断言读取测试关心的 messages 形状；它不是运行时 schema 验证。
			capturedPayload = payload as AnthropicPayload;
			// 主动停止请求流程；适配器把异常写入流的 error 结果，因此截获本身不依赖真实响应。
			throw new PayloadCaptured();
		},
	});
	// 等待事件流结束以完成截获；这里不检查回复内容，因为请求在发送前已被主动终止。
	await stream.result();
	// 运行时确认 onPayload 确实执行；构造或认证更早失败时抛测试错误，不返回 undefined。
	if (!capturedPayload) throw new Error("Expected payload capture before request");
	// 返回实际截获的同一请求对象，供调用方检查字段；没有发送第二次请求。
	return capturedPayload;
}

// 注册空签名历史回放组，外层回调不执行网络或工具。
describe("Anthropic empty thinking signature compat", () => {
	// 默认不开兼容：非空思考正文配空签名应改成普通文字，验证请求形状而非签名有效性。
	it("converts empty-signature thinking to text by default", async () => {
		// 省略兼容开关，历史签名给空串，等待实际截获结果。
		const payload = await capturePayload(makeModel(), makeContext(""));
		// ?. 允许 messages 缺失；find 回调按角色取首个 assistant，不修改数组，找不到会令下方断言失败。
		const assistant = payload.messages?.find((message) => message.role === "assistant");
		// 深比较完整块列表，确认无签名思考被保留为 text 而非丢失正文。
		expect(assistant?.content).toEqual([{ type: "text", text: "internal reasoning" }]);
	});

	// 有签名但正文空串仍要保留 thinking，回放可能依赖签名，不能仅按正文空白删除。
	it("preserves empty thinking text when the signature is present", async () => {
		// 给非空签名与空正文，隔离签名存在这一条件。
		const payload = await capturePayload(makeModel(), makeContext("signed-thinking", ""));
		// ?. 允许 messages 缺失；find 回调按角色取首个 assistant，不修改数组，找不到会令下方断言失败。
		const assistant = payload.messages?.find((message) => message.role === "assistant");
		// 要求原生 thinking 空正文和签名均保留；这里不执行密码学验签。
		expect(assistant?.content).toEqual([{ type: "thinking", thinking: "", signature: "signed-thinking" }]);
	});

	// 显式兼容开启时，纯空格签名也按无签名处理，但仍发原生 thinking 和规范化空串 signature。
	it("preserves empty-signature thinking when allowEmptySignature is enabled", async () => {
		// 开启兼容并输入单个空格，验证 trim 后无签名的路径。
		const payload = await capturePayload(makeModel(true), makeContext(" "));
		// ?. 允许 messages 缺失；find 回调按角色取首个 assistant，不修改数组，找不到会令下方断言失败。
		const assistant = payload.messages?.find((message) => message.role === "assistant");
		// 要求正文保持 thinking，签名规范为空串，不将输入空格原样发送。
		expect(assistant?.content).toEqual([{ type: "thinking", thinking: "internal reasoning", signature: "" }]);
	});

	// Regression for #9676: Vercel AI Gateway emits unsigned thinking for translated models.
	// 同步遍历内置网关目录：所有模型都应声明此兼容开关，不调用任何模型。
	it("allows empty thinking signatures for every Vercel AI Gateway model", () => {
		// 读取该供应商的内置模型数组，仅在内存中检查元数据。
		const models = getModels("vercel-ai-gateway");
		// 先要求数组非空，防止 every 对空数组为 true 造成虚假通过。
		expect(models.length).toBeGreaterThan(0);
		// every 回调要求每个模型显式 true；可选 compat 缺失也不通过，证明目录配置而非服务端行为。
		expect(models.every((model) => model.compat?.allowEmptySignature === true)).toBe(true);
	});

	// Regression for #9323: Fireworks emits unsigned thinking that must survive replay.
	// 用固定四个 Fireworks id 注册表驱动用例，每项传入下方异步回调，避免只测其中一个型号。
	it.each([
		"accounts/fireworks/models/deepseek-v4p1-flash",
		"accounts/fireworks/models/qwen3p8-max",
		"accounts/fireworks/models/qwen3p8-2p4t-a95b",
		"accounts/fireworks/models/nemotron-3-ultra-nvfp4",
		// as const 保留 id 字面量只读元组类型，不冻结运行时数组；回调输入每个 id，截获后比较无签名思考与文字顺序。
	] as const)("preserves unsigned thinking for Fireworks %s", async (modelId) => {
		// 按表中 id 取内置 Fireworks 模型，不从 makeModel 自行填写兼容值。
		const model = getModel("fireworks", modelId);
		// 先验证目录确实声明允许无签名，避免后面仅巧合转对形状。
		expect(model.compat?.allowEmptySignature).toBe(true);
		// 构造同供应商/同模型历史，签名空串，避免跨模型转换干扰。
		const context = makeContext("", "internal reasoning", "fireworks", modelId);
		// 按 helper 的固定三条布局取得第二条；as 声明已知夹具不变量，不执行角色检查。
		const assistant = context.messages[1] as AssistantMessage;
		// 在该测试私有历史数组末尾追加可见答案，验证思考和答案可同时回放。
		assistant.content.push({ type: "text", text: "answer" });
		// 等待该模型的实际参数构建并截获，发送前就停止。
		const payload = await capturePayload(model, context);
		// 查到协议 assistant 后深比较整组内容，既查思考类型也查块顺序，缺消息会失败。
		expect(payload.messages?.find((message) => message.role === "assistant")?.content).toEqual([
			// 第一块应是保留的无签名思考，不改成 text。
			{ type: "thinking", thinking: "internal reasoning", signature: "" },
			// 第二块仍是普通答案，证明兼容处理没有吞掉相邻文字。
			{ type: "text", text: "answer" },
		]);
	});
});
