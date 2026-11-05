// 验证 Anthropic 温度能力的本地请求构建；所有请求在 onPayload 中停止，不调用真实模型。
import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

// interface 只描述本测试要观察的请求字段，编译后擦除，不构造或验证请求。
interface AnthropicTemperaturePayload {
	// ? 允许字段完全缺失；本组区分省略字段与明确传 0。
	temperature?: number;
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

// 建立只有一条用户消息的上下文并返回；无外部副作用，例如 capturePayload 用它触发最小参数构建。
function makeContext(): Context {
	// 返回新建夹具对象；函数本身只组装内存数据，没有模型调用。
	return {
		// 消息数组只有一句 Hello；role 是联合类型标签，Date.now 为本地毫秒时间，不是服务器时间。
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

// 按可选 compat 构造代理模型，返回 Messages 模型，无网络；索引访问 ["compat"] 复用模型字段类型。例 false 禁止发 temperature。
function makeCustomModel(compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	// 返回新建夹具对象；函数本身只组装内存数据，没有模型调用。
	return {
		// 供应商代理使用不同模型 id，说明显式 compat 可控制不完全匹配内置名字的模型。
		id: "vendor--claude-opus-4-7",
		// 仅为夹具展示名，测试实际路由使用 id/api/provider。
		name: "Vendor Proxy Opus 4.7",
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

// 截获 model 与可选 options 构造出的请求并返回 Promise；用假认证与抛错钩子阻止发送。例 temperature:0 可观察到保留还是省略。
async function capturePayload(
	// 参数限定为 Messages 模型，避免静态传入其他 API 的专用模型。
	model: Model<"anthropic-messages">,
	// 可选简单流选项；? 允许省略，reasoning 等会经简单适配层转换。
	options?: SimpleStreamOptions,
	// async 返回 Promise，成功值仅声明含可选 temperature，实际对象还可有其他字段。
): Promise<AnthropicTemperaturePayload> {
	// let 保存稍后回调写入的请求体；联合 undefined 表示回调尚未运行，类型不验证真实网络数据。
	let capturedPayload: AnthropicTemperaturePayload | undefined;

	// 新建模型顶层副本，静态限定 Messages API；下面覆盖地址，不修改内置目录模型对象。
	const payloadCaptureModel: Model<"anthropic-messages"> = {
		// 对象展开浅复制已有字段；嵌套 cost/compat 仍可共用引用，本测试不修改它们。
		...model,
		// 用本地不可用地址作兜底；正常路径在 onPayload 中先抛错，不会靠连接该地址完成断言。
		baseUrl: "http://127.0.0.1:9",
	};

	// 启动简单选项适配路径并取得事件流；内部异步构造参数后调用下方截获钩子。
	const s = streamSimple(payloadCaptureModel, makeContext(), {
		// 先展开调用方选项，再由后面的 fake-key/onPayload 覆盖同名字段。
		...options,
		// 给适配器本地认证前置检查一个假 key，测试不会拿它访问真实服务。
		apiKey: "fake-key",
		// 请求参数构造完成、SDK 创建请求前调用此箭头函数；输入为待发参数，下面先保存后抛错。
		onPayload: (payload) => {
			// as 只把未知参数视作关注的温度字段形状，运行时不筛选、不校验或复制 payload。
			capturedPayload = payload as AnthropicTemperaturePayload;
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

// 注册温度兼容测试组；describe 回调只注册 it，断言发生在各异步测试执行时。
describe("Anthropic temperature compatibility", () => {
	// 无参数异步测试：构造 Opus 4.7 的 temperature:0 请求并检查字段缺失；只证明本地参数形状。
	it("omits temperature for Claude Opus 4.7", async () => {
		// 从内置目录取 Opus 4.7，再等待截获明确温度为 0 的请求体。
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7"), { temperature: 0 });

		// 断言实际属性值为 undefined，说明此构建路径没有可发的 temperature 数字。
		expect(payload.temperature).toBeUndefined();
	});

	// 无参数异步测试：同样检查 Opus 4.8 不发送温度，返回的 Promise 由 Vitest 等待。
	it("omits temperature for Claude Opus 4.8", async () => {
		// 选择 Opus 4.8 的目录兼容设置，捕获同样温度为 0 的请求。
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-8"), { temperature: 0 });

		// 断言实际属性值为 undefined，说明此构建路径没有可发的 temperature 数字。
		expect(payload.temperature).toBeUndefined();
	});

	// 以显式 1 再检查 Opus 4.7 的省略规则，避免把仅过滤 0 的错误实现当通过。
	it("omits default temperature for Claude Opus 4.7", async () => {
		// 显式设置温度 1，验证禁用能力优先于用户填写的数值。
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7"), { temperature: 1 });

		// 断言实际属性值为 undefined，说明此构建路径没有可发的 temperature 数字。
		expect(payload.temperature).toBeUndefined();
	});

	// 用仍支持温度的 Opus 4.6 作对照，输入 0 应保留，不能把假值误当未配置。
	it("keeps temperature for Claude Opus 4.6", async () => {
		// 选择较早 Opus 的能力，并传 0 作为保留假值的边界。
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-6"), { temperature: 0 });

		// 断言数值 0 原样保留，不把 0 当作缺省温度丢弃。
		expect(payload.temperature).toBe(0);
	});

	// 用 Sonnet 4.6 验证能力选择依模型配置，不能把全部 Claude 温度一概删除。
	it("keeps temperature for Claude Sonnet 4.6", async () => {
		// 选择 Sonnet 的能力设置，截获温度为 0 的请求。
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-4-6"), { temperature: 0 });

		// 断言数值 0 原样保留，不把 0 当作缺省温度丢弃。
		expect(payload.temperature).toBe(0);
	});

	// 自定义代理夹具传 supportsTemperature:false，应省略温度；不需要远端认识这个模型 id。
	it("omits temperature for custom models with supportsTemperature disabled", async () => {
		// 构造显式关闭温度支持的自定义模型，再提供 0；检查显式兼容覆盖。
		const payload = await capturePayload(makeCustomModel({ supportsTemperature: false }), { temperature: 0 });

		// 断言实际属性值为 undefined，说明此构建路径没有可发的 temperature 数字。
		expect(payload.temperature).toBeUndefined();
	});
});
