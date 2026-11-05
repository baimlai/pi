import { describe, expect, it } from "vitest";
import { buildOpenRouterCatalog, type OpenRouterModelListItem } from "../catalog/sources/openrouter.ts";

// 人工 OpenRouter 列表项：只能生成图片，没有 tools 参数，也不声明聊天 text 输出；不从远端读取。
const imageOnly: OpenRouterModelListItem = {
	// id 保留上游形式，name 是用户可见显示名。
	id: "example/image-model",
	name: "Example Image Model",
	// architecture 描述输入/输出模态，数组元素是字符串标签，不是图片内容。
	architecture: {
		// 可输入文字与参考图。
		input_modalities: ["text", "image"],
		// 只输出图片。
		output_modalities: ["image"],
	},
	// 上游单价单位美元/token，字符串换算后应变为美元/百万 token。
	pricing: {
		prompt: "0.000001",
		completion: "0.000002",
	},
};

// 同一 id 既能聊天又能生成图片：会分别出现在两个输入列表中，转换器应生成两个操作种类条目。
const chatWithImages: OpenRouterModelListItem = {
	id: "example/multimodal",
	name: "Example Multimodal",
	// 普通聊天列表只保留带 tools 的模型。
	supported_parameters: ["tools"],
	architecture: {
		// 聊天视觉能力读取 modality 字符串，图片种类读取下面的模态数组，两种来源都提供。
		modality: "text+image->text+image",
		input_modalities: ["text", "image"],
		output_modalities: ["text", "image"],
	},
	// 未提供 top_provider 覆盖时聊天条目采用这个上下文上限。
	context_length: 32000,
};

// 纯文字聊天样本提供 tools，但没有 image 输出。
const chatOnly: OpenRouterModelListItem = {
	id: "example/chat",
	name: "Example Chat",
	supported_parameters: ["tools"],
	architecture: { modality: "text->text", output_modalities: ["text"] },
};

// decisions 输出代表结构化分类模型，非普通聊天；虽然不支持 tools，独立 decisions 列表仍应保留。
const decisionModel: OpenRouterModelListItem = {
	id: "typesafe/jev-1.13",
	name: "TypeSafe: Jev 1.13",
	// 空支持参数用来证明它不是靠聊天 tools 筛选进入目录。
	supported_parameters: [],
	// 该分类样本只接受文字并输出 decisions 标签。
	architecture: { modality: "text->decisions", input_modalities: ["text"], output_modalities: ["decisions"] },
	// 单 token 输入 0.000000042 换算为每百万 0.042；输出费率为零。
	pricing: { prompt: "0.000000042", completion: "0" },
	context_length: 32000,
	top_provider: { context_length: 32000, max_completion_tokens: 28800 },
};

// 以下全部是内存目录转换，无 HTTP、认证或图片生成；断言只证明这些人工列表项的归类与元数据。
describe("OpenRouter catalog parsing", () => {
	// 只给图片列表输入，预期聊天为空而图片包含对应种类/协议/费率；无输入参数和外部副作用。
	it("emits image-only models from the image listing as image models", () => {
		// 三个位置依次为普通聊天、图片、decisions 列表，[] 是空列表而不是未获取错误。
		const catalog = buildOpenRouterCatalog([], [imageOnly], []);
		// 不凭图片生成能力把条目误塞进聊天目录。
		expect(catalog.chat).toEqual([]);
		// objectContaining 只检查列出的字段，允许显示名/baseUrl 等其他字段存在。
		expect(catalog.images).toEqual([
			expect.objectContaining({
				type: "image",
				id: "example/image-model",
				api: "openrouter-images",
				input: ["text", "image"],
				output: ["image"],
				// 这里检查单位换算，不比较未列出的缓存价格。
				cost: expect.objectContaining({ input: 1, output: 2 }),
			}),
		]);
	});

	// 相同多模态 id 分别出现在两类输入，预期各生成一种操作条目；例同名模型可同时供聊天和生图调用。
	it("emits separate chat and image entries for an id that supports both operations", () => {
		// 图文模型共享同一个样本引用，转换器仍按列表用途分别处理。
		const catalog = buildOpenRouterCatalog([chatWithImages, chatOnly], [chatWithImages, imageOnly], []);
		// map 依顺序取 id，验证聊天列表包含两个工具模型。
		expect(catalog.chat.map((model) => model.id)).toEqual(["example/multimodal", "example/chat"]);
		// 转换器给聊天条目明确添加 type:chat。
		expect(catalog.chat.map((model) => model.type)).toEqual(["chat", "chat"]);
		// 图片列表也保留多模态 id，并保持图片输入列表顺序。
		expect(catalog.images.map((model) => model.id)).toEqual(["example/multimodal", "example/image-model"]);
		// every 的谓词全部成立才为 true，逐项确认种类。
		expect(catalog.images.every((model) => model.type === "image")).toBe(true);
		// 输出能力保留各自数组，不把伴随文字的输出能力丢掉。
		expect(catalog.images.map((model) => model.output)).toEqual([["text", "image"], ["image"]]);
	});

	// 分别破坏每类列表的准入能力，预期全部过滤；展开只换顶层字段，不修改共享样本。
	it("ignores listed models that neither support tools nor emit images", () => {
		const catalog = buildOpenRouterCatalog(
			// 普通列表没有 tools，不能成为聊天模型。
			[{ ...chatOnly, supported_parameters: [] }],
			// 即使来自图片专用列表，没有 image 输出也不能成为图片模型。
			[{ ...imageOnly, architecture: { output_modalities: ["text"] } }],
			// decisions 专用列表同样需要输出能力标签，不能只看来源。
			[{ ...decisionModel, architecture: { output_modalities: ["text"] } }],
		);
		// 三类结果都为空，分别断言以定位哪一类误保留。
		expect(catalog.chat).toEqual([]);
		expect(catalog.images).toEqual([]);
		expect(catalog.classifiers).toEqual([]);
	});

	// 给两份相同 decisions id，预期去重为一个 System One 分类条目；例精确比较价格、端点和图片兼容策略。
	it("emits decision models as System One classifier models", () => {
		// 重复同一对象只验证本类别按 id 去重，不验证同 id 冲突时所有字段的合并规则。
		const catalog = buildOpenRouterCatalog([], [], [decisionModel, decisionModel]);
		// 分类模型不应同时成为聊天模型。
		expect(catalog.chat).toEqual([]);
		// toEqual 比较完整分类目录对象，比 objectContaining 更严格。
		expect(catalog.classifiers).toEqual([
			{
				// 种类与 API 指定它由分类入口使用，而不是聊天或图片 API。
				type: "classifier",
				id: "typesafe/jev-1.13",
				name: "TypeSafe: Jev 1.13",
				api: "typesafe-system-one",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				input: ["text"],
				cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32000,
				// 这是目录兼容元数据断言，本用例没有发送图片或请求头。
				compat: { imageInput: "state-image-urls", sendImageOptInHeader: false },
			},
		]);
	});
});
