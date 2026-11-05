// 生成前集中读取所有上游目录；只有调用 loadCatalogSources 才联网，import本文件不会触发抓取。
import {
	DEFAULT_RADIUS_GATEWAY,
	getRadiusModelsFromConfig,
	loadRadiusGatewayConfig,
} from "../../src/providers/radius-config.ts";
import type { Model } from "../../src/types.ts";
import {
	MODELS_DEV_DECISIONS_URL,
	MODELS_DEV_URL,
	type ModelsDevDecisionMetadata,
	type ModelsDevV2Catalog,
} from "./models-dev.ts";
import { fetchOpenRouterCatalog, type OpenRouterCatalog } from "./openrouter.ts";
import { type AiGatewayCatalog, fetchAiGatewayCatalog } from "./vercel-ai-gateway.ts";

// NVIDIA 推理服务根，也是其公开 /models 列表所在位置。
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

/** Everything fetched from upstream before the catalog is built. */
export interface CatalogSources {
	// models.dev v2模型数据与v1 decision元数据分别使用，不混为一份完整schema。
	modelsDev: ModelsDevV2Catalog;
	modelsDevDecisions: Record<string, ModelsDevDecisionMetadata>;
	// 独立来源已转换成 Pi 模型，后续供应商通常克隆后修正。
	openRouter: OpenRouterCatalog;
	aiGateway: AiGatewayCatalog;
	/** Live NVIDIA NIM ids, keyed by both the raw and the normalized id. */
	nvidiaModelIds: Map<string, string>;
	// Radius公开配置转换的聊天模型，不读取用户账户登录态。
	radius: Model<"pi-messages">[];
}

// 对给定URL发GET并解析JSON，返回Promise<T>；非2xx/网络/解析失败拒绝，无重试或超时配置。
// 例 fetchJson<{data:string[]}>(url,label) 的泛型只是静态断言，远端返回 {wrong:1} 不会自动被拒绝。
async function fetchJson<T>(url: string, label: string): Promise<T> {
	// await暂停本异步函数直到响应头可用，fetch 默认GET。
	const response = await fetch(url);
	// ok按HTTP状态2xx判定，不检查内容类型或响应体schema。
	if (!response.ok) throw new Error(`${label} returned ${response.status}`);
	// JSON解码可能抛；as T 不执行结构验证。
	return (await response.json()) as T;
}

// 为匹配NIM目录把id转小写并把所有下划线换成点，返回新字符串，无I/O；例 Vendor/Model_1→vendor/model.1。
export function normalizeNvidiaModelId(modelId: string): string {
	// 不处理其他分隔符，也不保证不同原id不会归一到同一个键。
	return modelId.toLowerCase().replaceAll("_", ".");
}

// 读取NIM /models，返回原id/规范id→服务实际id的Map；例A_B以A_B和a.b两键指向A_B。
// 缺data按空列表，同键后项覆盖前项；fetch/JSON/字段异常向上抛，无完整条目校验。
async function fetchNvidiaModelIds(): Promise<Map<string, string>> {
	// fetchJson泛型描述预期响应，不是校验器。
	const data = await fetchJson<{ data?: { id: string }[] }>(`${NVIDIA_BASE_URL}/models`, "NVIDIA NIM API");
	// 本次抓取专用Map，不跨次缓存。
	const modelIds = new Map<string, string>();
	// data缺失才用[]，每条同时注册两个键。
	for (const model of data.data ?? []) {
		modelIds.set(model.id, model.id);
		// 后续供应商以规范键找回NIM真正接受的大小写和标点。
		modelIds.set(normalizeNvidiaModelId(model.id), model.id);
	}
	// 返回可变Map，调用方在本构建里只读它。
	return modelIds;
}

// 从默认公开Radius网关配置产生Pi模型列表，返回Promise；不传API key、不查询凭据。
// 空列表被视为生成来源异常而抛错，供外层strict策略处理；这不代表Radius运行时不允许空账户目录。
async function fetchRadiusModels(): Promise<Model<"pi-messages">[]> {
	// 实际GET /v1/config，callee只做其明确实现的配置/条目浅检查。
	const config = await loadRadiusGatewayConfig(DEFAULT_RADIUS_GATEWAY);
	// 转为provider="radius"、协议pi-messages的聊天元数据。
	const models = getRadiusModelsFromConfig("radius", config);
	// 生成时要求至少一模型；HTTP或转换失败同样向外传播。
	if (models.length === 0) throw new Error("Radius API returned no models");
	return models;
}

/**
 * Fetch every upstream source. In strict mode any failure aborts generation;
 * otherwise a failed source contributes nothing.
 */
// 依次读取models.dev两份目录、可选NIM、OpenRouter、Vercel、Radius，返回全部来源；调用会联网并打印抓取日志。
// strict=true时任何抓取失败拒绝；false时记录错误并用空来源继续，可能产出较少模型，不代表来源完整。
// 例models.dev没有nvidia.models时根本不请求NIM；strict且OpenRouter无可用图片模型也会报错。
export async function loadCatalogSources(strict: boolean): Promise<CatalogSources> {
	// 包装一个抓取函数：成功返回T，失败按外层strict决定抛出或返回传入fallback，fallback不克隆。
	async function load<T>(label: string, fetcher: () => Promise<T>, fallback: T): Promise<T> {
		try {
			// label只用于日志，真正URL由fetcher闭包确定。
			console.log(`Fetching ${label}...`);
			// await保证异步拒绝也落入这里的catch。
			return await fetcher();
		} catch (error) {
			// 保留原异常日志；strict时重抛原值，没有替换成另一种Error。
			console.error(`Failed to fetch ${label}:`, error);
			if (strict) throw error;
			// 宽松模式只让该来源为空，其他来源仍继续读取。
			return fallback;
		}
	}

	// 每个await完成后才开始下一项；顶层来源并不是Promise.all并行抓取。
	const modelsDev = await load(
		"models.dev catalog",
		() => fetchJson<ModelsDevV2Catalog>(MODELS_DEV_URL, "models.dev API"),
		{},
	);
	// v1接口补decision元数据，缺失时宽松回退空字典。
	const modelsDevDecisions = await load(
		"models.dev decision models",
		() => fetchJson<Record<string, ModelsDevDecisionMetadata>>(MODELS_DEV_DECISIONS_URL, "models.dev decision API"),
		{},
	);
	// 只有v2目录出现NVIDIA模型节点才请求其现场id列表。
	const nvidiaModelIds = modelsDev.nvidia?.models
		? await load("NVIDIA NIM models", fetchNvidiaModelIds, new Map<string, string>())
		: new Map<string, string>();
	// OpenRouter helper内部才并行请求聊天/图片/decision三个列表；它们任一失败会让整个来源回退。
	const openRouter = await load("OpenRouter models", fetchOpenRouterCatalog, {
		chat: [],
		images: [],
		classifiers: [],
	});
	// 成功HTTP也可能没有可用图片条目；strict对此另有完整性要求。
	if (strict && openRouter.images.length === 0) throw new Error("OpenRouter API returned no usable image models");
	// 两个独立目录各有空回退形状，符合各自返回类型。
	const aiGateway = await load("Vercel AI Gateway models", fetchAiGatewayCatalog, { chat: [], classifiers: [] });
	const radius = await load("Radius models", fetchRadiusModels, []);

	// 属性简写把六个已加载结果装成统一上下文输入。
	return { modelsDev, modelsDevDecisions, openRouter, aiGateway, nvidiaModelIds, radius };
}
