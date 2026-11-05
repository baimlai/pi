// TypeSafe/OpenRouter的System One分类适配入口：配置URL、图片协议和请求外壳，分类校验与HTTP交共享层。
// 仅导入分类函数/选项契约，编译后擦除，不加载供应商SDK。
import type { ClassifierFunction, ClassifierOptions } from "../types.ts";
// 复用未知响应的非null、非数组对象检查，不等于完整响应schema验证。
import { isRecord } from "./classifier-shared.ts";
// classifySystemOne实现共用请求流程，SystemOneTransport仅是差异配置类型。
import { classifySystemOne, type SystemOneTransport } from "./system-one-shared.ts";

/**
 * TypeSafe's native System One protocol. OpenRouter serves the same protocol,
 * so both providers use this API with different base URLs.
 *
 * TypeSafe takes images as `assets`. They are experimental and need the
 * `TypeSafe-Danger-Zone-Images` opt-in header; without it the API answers 400.
 * OpenRouter drops `assets` silently and takes images as `image_url` parts in the state instead.
 * Models behind a proxy that hides both the provider ID and the OpenRouter host must set
 * `compat.imageInput`.
 */
// 定义服务差异对象，不在模块加载时发网络；共享层稍后调用其中函数。
const transport: SystemOneTransport = {
	// 本入口只接受相同API标识的分类模型。
	api: "typesafe-system-one",
	// 服务显示名进入HTTP与业务错误文字。
	label: "System One API",
	// OpenRouter by provider ID, which survives baseUrl overrides, or by host, which covers regional endpoints.
	/**
	 * 从模型provider/baseUrl推导图片默认协议，返回两项compat，无请求/输入修改。
	 * 例provider=openrouter即使用代理URL也默认state-image-urls；这里只做字串启发式，不验证域名归属。共享层实际仅有图片时调用，并允许model.compat逐字段覆盖。
	 */
	// 回调按模型给图片默认兼容值，返回普通对象，无模型修改。
	detectCompat: (model) =>
		// provider精确匹配或baseUrl任意位置含大小写敏感openrouter.ai子串；没有解析URL确认真实域名。
		model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")
			? // 命中时图片放state中的image_url块，缺省不加TypeSafe实验头。
				{ imageInput: "state-image-urls", sendImageOptInHeader: false }
			: // 其他目标用assets及实验头；模型compat还可在共享层逐字段覆盖这两个检测值。
				{ imageInput: "assets", sendImageOptInHeader: true },
	/**
	 * 从模型baseUrl拼System One请求URL，返回URL对象，无网络；例https://api.typesafe.ai/v1/→.../v1/systemone。
	 * 只先去实际末尾斜线，含query/hash的自定义形式按URL规则解析，不能保证任意字符串都按预期补路径，坏URL可抛。
	 */
	// 去末尾斜线再补一个斜线后相对解析systemone；u不使$忽略末尾LF，坏URL可抛，无网络探测。
	url: (model) => new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`),
	/**
	 * 把内部System One请求加model字段，返回新顶层对象，无网络/原对象写入；例state/questions变{model:"jev",state,questions}。
	 * 对象展开是浅复制，后面的request同名字段按JS规则优先，SystemOneWireRequest类型未声明model字段。
	 */
	// 新建顶层{model,...request}，后展开请求字段；内部state/问题对象可仍共享引用，不深拷贝。
	payload: (model, request) => ({ model: model.id, ...request }),
	/**
	 * 接收unknown响应，要求基本对象形状后原样返回给共享解析，无网络/修改。
	 * 例{answers:...}通过，[]拒绝；通过并不证明问题答案齐全或概率有效，这些由后续共享层检查。
	 */
	// 该协议无需剥外壳，回调接unknown并返回对象视图或抛错。
	output: (body) => {
		// 只验证非null非数组对象，answers/usage的具体结构交后续共享解析。
		if (!isRecord(body)) throw new Error("System One API returned an unexpected response");
		// 返回同一body对象，不复制/改字段。
		return body;
	},
};

/** TypeSafe System One classification with public `bool` values mapped to wire-level `noul`. */
/**
 * 通过TypeSafe/OpenRouter System One协议做结构化分类，输入分类模型、state/questions/可选图片与HTTP配置，返回ClassifierResult Promise。
 * 共享层校验API与图片能力，bool→wire noul，包装并请求HTTP，先保存可解析usage再校验答案；例approved的noul=0.8变公共bool probability=0.8。
 * 会联网和调用请求钩子；通常失败返回error/aborted结果，图片协议由检测+compat决定。直接调用本入口不解析环境key，共享HTTP要求options.apiKey。
 */
// 泛型静态约束统一分类签名；箭头表达式直接返回共享层Promise，不是聊天token流。
export const classify: ClassifierFunction<ClassifierOptions> = (model, context, options) =>
	// 全部分类状态、图片能力、认证头/钩子/重试/答案解析由共享层处理，失败通常放结果stopReason里。
	classifySystemOne(transport, model, context, options);
