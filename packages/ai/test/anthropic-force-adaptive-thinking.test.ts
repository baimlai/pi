// 验证显式 forceAdaptiveThinking 如何覆盖思考请求形状；截获后停止，全部用例离线。
import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

// 这里只描述截获请求中关心的思考字段；interface 编译后擦除，不验证服务端响应。
interface AnthropicThinkingPayload {
	// thinking 可省略；存在时要求 type 字符串，预算与展示方式仍可省略，宽类型便于断言多种形状。
	thinking?: { type: string; budget_tokens?: number; display?: string };
	// 输出配置及内部 effort 均可省略，测试区分旧预算模式和 adaptive 模式。
	output_config?: { effort?: string };
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

// 返回最小 Hello 用户上下文，无网络；例如 capturePayload 用它触发一次思考参数构造。
function makeContext(): Context {
	// 返回新建夹具对象；函数本身只组装内存数据，没有模型调用。
	return {
		// 消息数组只有一句 Hello；role 是联合类型标签，Date.now 为本地毫秒时间，不是服务器时间。
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

// 用可选兼容设置造一个不匹配内置 adaptive 名称的模型，返回新对象，无网络。例 forceAdaptiveThinking:true 改走 adaptive。
function makeCustomModel(compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	// 返回新建夹具对象；函数本身只组装内存数据，没有模型调用。
	return {
		// Id intentionally does not match any built-in adaptive substring. This
		// mirrors corporate proxy schemes such as `anthropic--claude-opus-latest`.
		// 故意不含内置 adaptive 型号片段，避免测试偷偷依赖模型名猜测。
		id: "vendor--claude-opus-latest",
		// 人类可读名称不参与本测试的 adaptive 能力判断。
		name: "Vendor Proxy Opus Latest",
		// API 字面量让 TypeScript 把模型与 Anthropic 专用选项匹配，不探测远端协议。
		api: "anthropic-messages",
		// 自定义供应商名用于避免借用内置供应商配置。
		provider: "vendor-proxy",
		// 用本地不可用地址作兜底；正常路径在 onPayload 中先抛错，不会靠连接该地址完成断言。
		baseUrl: "http://127.0.0.1:9",
		// 声明模型具有思考能力；是否发 thinking 仍由选项与 compat 决定。
		reasoning: true,
		// 夹具仅声明接受文字输入，不包含图片能力。
		input: ["text"],
		// 零价格夹具满足模型类型，本测试不验证真实费用。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// 声明上下文 token 容量，供简单选项预算换算使用，不实际生成这么多 token。
		contextWindow: 200000,
		// 声明模型最大输出量；本组只检查参数构建，不验证服务端执行上限。
		maxTokens: 32000,
		// 属性简写保留调用方的可选兼容开关，undefined 表示采用适配器/目录默认值。
		compat,
	};
}

// 输入 Messages 模型与简单选项，异步返回截获的思考参数；只改本地捕获变量，在发送前抛错。例 medium 可得到 enabled 或 adaptive。
async function capturePayload(
	// 静态限定模型协议，不能仅凭这个泛型保证远端确实支持思考。
	model: Model<"anthropic-messages">,
	// 可选统一选项，例如 reasoning:"medium"，由 streamSimple 映射成专用字段。
	options?: SimpleStreamOptions,
	// async 结果为 Promise，resolve 值是截获对象，未捕获则显式抛测试错误。
): Promise<AnthropicThinkingPayload> {
	// let 保存稍后回调写入的请求体；联合 undefined 表示回调尚未运行，类型不验证真实网络数据。
	let capturedPayload: AnthropicThinkingPayload | undefined;

	// 新建模型顶层副本，静态限定 Messages API；下面覆盖地址，不修改内置目录模型对象。
	const payloadCaptureModel: Model<"anthropic-messages"> = {
		// 对象展开浅复制已有字段；嵌套 cost/compat 仍可共用引用，本测试不修改它们。
		...model,
		// 用本地不可用地址作兜底；正常路径在 onPayload 中先抛错，不会靠连接该地址完成断言。
		baseUrl: "http://127.0.0.1:9",
	};

	// 开始本地参数构建，事件流供等待终态，钩子会在 SDK 发请求前执行。
	const s = streamSimple(payloadCaptureModel, makeContext(), {
		// 先展开调用方选项，再由后面的 fake-key/onPayload 覆盖同名字段。
		...options,
		// 给适配器本地认证前置检查一个假 key，测试不会拿它访问真实服务。
		apiKey: "fake-key",
		// 请求参数构造完成、SDK 创建请求前调用此箭头函数；输入为待发参数，下面先保存后抛错。
		onPayload: (payload) => {
			// as 只把未知参数视作关注的思考字段形状，运行时不筛选、不校验或复制 payload。
			capturedPayload = payload as AnthropicThinkingPayload;
			// 主动停止请求流程；适配器把异常写入流的 error 结果，因此截获本身不依赖真实响应。
			throw new PayloadCaptured();
		},
	});

	// 等待事件流终态，保证异步 onPayload 已执行；result 返回错误消息对象，也不会因此自动抛出捕获标记。
	await s.result();

	// 检查测试观察点是否真的触发；若构造阶段更早失败，不能误把未捕获当作字段省略。
	if (!capturedPayload) {
		// 未观察到参数时明确令 helper 的 Promise 拒绝，避免测试从空值推断错误结论。
		throw new Error("Expected payload to be captured before request failure");
	}

	// 返回实际截获的同一请求对象，供调用方检查字段；没有发送第二次请求。
	return capturedPayload;
}

// 注册显式 adaptive 能力覆盖测试；外层回调只安排各用例，不访问服务端。
describe("Anthropic forceAdaptiveThinking compat override", () => {
	// 自定义 id 没有覆盖时启用 medium，应回到 enabled 预算模式；例如企业代理不必自动识别为新 Claude。
	it("sends legacy thinking payload for custom model ids by default", async () => {
		// 用缺省 compat 的夹具和 medium 选项捕获请求，作为覆盖前的对照。
		const payload = await capturePayload(makeCustomModel(), { reasoning: "medium" });

		// ?. 在 thinking 缺失时返回 undefined；断言必须为 enabled，证明走旧式预算思考形状。
		expect(payload.thinking?.type).toBe("enabled");
		// 旧式或禁用路径不应附 adaptive 的 output_config；只检查本地字段，不证明模型实际思考过程。
		expect(payload.output_config).toBeUndefined();
	});

	// 显式开启 forceAdaptiveThinking 后，同样 medium 应切换 adaptive 并携带 effort。
	it("sends adaptive thinking payload when compat.forceAdaptiveThinking is true", async () => {
		// 只改变兼容开关，保持推理档位相同，以隔离开关对参数形状的影响。
		const payload = await capturePayload(makeCustomModel({ forceAdaptiveThinking: true }), { reasoning: "medium" });

		// 深比较整个 thinking 对象，要求 adaptive 且使用 summarized 默认展示。
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		// 检查统一 medium 原样映射成 adaptive effort，没有混成 budget_tokens。
		expect(payload.output_config).toEqual({ effort: "medium" });
	});

	// 检查内置 Fable 5 的 xhigh 能力配置；测试只构建请求，不需要服务器提供此模型。
	it("uses adaptive thinking with native xhigh effort for Claude Fable 5", async () => {
		// 读取目录模型并捕获 xhigh 对应的专用请求体。
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"), { reasoning: "xhigh" });

		// 深比较整个 thinking 对象，要求 adaptive 且使用 summarized 默认展示。
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		// 检查该模型支持的 xhigh 原样进入 effort，而不是降成其他档位。
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	// 给内置 adaptive 模型显式 false，应回旧预算模式；这验证 false 不能被默认 true 覆盖。
	it("allows built-in adaptive models to opt out with compat.forceAdaptiveThinking false", async () => {
		// 以类型标注构造目录模型副本，接着仅覆盖顶层 compat 对象。
		const model: Model<"anthropic-messages"> = {
			// 浅展开 Opus 4.8 字段，保留模型能力与价格的既有数据。
			...getModel("anthropic", "claude-opus-4-8"),
			// 用新 compat 对象明确关闭 adaptive；此处替换整个 compat，并非深层合并目录所有开关。
			compat: { forceAdaptiveThinking: false },
		};
		// 在关闭覆盖后仍请求 medium，验证请求变成旧式 enabled。
		const payload = await capturePayload(model, { reasoning: "medium" });

		// ?. 在 thinking 缺失时返回 undefined；断言必须为 enabled，证明走旧式预算思考形状。
		expect(payload.thinking?.type).toBe("enabled");
		// 旧式或禁用路径不应附 adaptive 的 output_config；只检查本地字段，不证明模型实际思考过程。
		expect(payload.output_config).toBeUndefined();
	});

	// 即使强制 adaptive，未要求 reasoning 时仍应 disabled，避免能力开关强迫每次思考。
	it("preserves thinking.type=disabled when reasoning is off regardless of override", async () => {
		// 省略简单选项以表示未开启思考，模型本身仍声明 reasoning 能力。
		const payload = await capturePayload(makeCustomModel({ forceAdaptiveThinking: true }));

		// 深比较显式 disabled 形状；关闭思考与省略 thinking 是两种不同请求。
		expect(payload.thinking).toEqual({ type: "disabled" });
		// 旧式或禁用路径不应附 adaptive 的 output_config；只检查本地字段，不证明模型实际思考过程。
		expect(payload.output_config).toBeUndefined();
	});
});
