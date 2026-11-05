// 按请求选项、请求/进程环境和模型字段解析Azure部署名、根URL及API版本；只处理配置，不连接Azure或验证资源存在。
// type导入共用请求选项及模型形状，编译后擦除。
import type { Api, Model, StreamOptions } from "../types.ts";
// 环境helper优先options.env真值，再process.env与特殊Bun回退。
import { getProviderEnvValue } from "../utils/provider-env.ts";

// 没指定API版本时默认v1，最终交AzureOpenAI SDK的apiVersion配置。
const DEFAULT_AZURE_API_VERSION = "v1";

/** Azure models ship without a baseUrl: one resource per user, resolved per request. */
// extends继承通用StreamOptions，并加Azure专属可选字段；不是运行时类继承。
export interface AzureEndpointOptions extends StreamOptions {
	// 请求可覆盖Azure API版本。
	azureApiVersion?: string;
	// 资源名可用于拼默认域名。
	azureResourceName?: string;
	// 请求可直接给完整根URL，优先于资源名。
	azureBaseUrl?: string;
	// 请求可给实际部署名，区别目录模型id。
	azureDeploymentName?: string;
}

/**
 * 解析逗号分隔model=deployment文字，返回新Map，不修改环境或模型。
 * 例：a=prod,b=test,a=new最终a为new；空条目/缺等号侧值跳过。split只取前两段，多余等号后内容丢弃；a= =x会先取空白部署名，再trim成空值，不做第二次非空检查。
 */
function parseDeploymentNameMap(value: string | undefined): Map<string, string> {
	// Map<string,string>保存模型id到部署名，初始为空。
	const map = new Map<string, string>();
	// 没有映射文字或空串就返回空表。
	if (!value) return map;
	// 按逗号拆每个映射，不实现引号/转义语法。
	for (const entry of value.split(",")) {
		// 去整个条目前后空白。
		const trimmed = entry.trim();
		// 空条目直接跳过。
		if (!trimmed) continue;
		// 解构前两段等号拆分，多余等号后部分丢掉。
		const [modelId, deploymentName] = trimmed.split("=", 2);
		// 在分别trim前检查真值；如a= =x中的空白部署名此刻可通过，随后才变空串。
		if (!modelId || !deploymentName) continue;
		// 两边trim后写Map；后同名键覆盖先前映射。
		map.set(modelId.trim(), deploymentName.trim());
	}
	// 返回结果表，不缓存到模块状态。
	return map;
}

/**
 * 选择部署名，返回字符串；显式真值azureDeploymentName > 环境映射中model.id > 原model.id。
 * Pick只要求模型有id；例：gpt-4o-mini映射到my-deployment后返回后者，不改变模型id或确认部署存在。
 */
export function resolveDeploymentName(model: Pick<Model<Api>, "id">, options?: AzureEndpointOptions): string {
	// 显式部署名只按真值选择，不trim。
	if (options?.azureDeploymentName) {
		// 明确选项直接返回，跳过环境映射。
		return options.azureDeploymentName;
	}
	// 解析本次环境映射并查当前模型id。
	const mappedDeployment = parseDeploymentNameMap(
		// options.env可覆盖同名进程环境值，具体回退依helper。
		getProviderEnvValue("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", options?.env),
		// Map.get精确区分大小写，查不到undefined。
	).get(model.id);
	// 映射空值也回退模型id，因为使用||。
	return mappedDeployment || model.id;
}

/**
 * 解析并规范化Azure根URL，返回字符串，URL无法解析则抛错。
 * 已知Azure域后缀且路径为空、/、/openai或/openai/v1/responses时改/openai/v1并清查询；其他路径/非Azure代理保留查询。例：Azure /openai?x=1转/openai/v1。
 * 只做URL可解析性和后缀/路径规则，不限制HTTPS、不校验域名归属、也不一律清查询/fragment。
 */
function normalizeAzureBaseUrl(baseUrl: string): string {
	// 去两端空白及字符串末尾斜杠，再交URL解析。
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	// 声明URL对象变量，构造成功后赋值。
	let url: URL;
	// URL字符串输入边界：解析可能抛错。
	try {
		// 解析绝对URL，不在这里限定http/https。
		url = new URL(trimmed);
		// 解析错误转换成配置Error。
	} catch {
		// 附原始baseUrl供诊断，不自行脱敏其内容。
		throw new Error(`Invalid Azure OpenAI base URL: ${baseUrl}`);
	}

	// 按hostname后缀判断是否应用特定Azure路径规则。
	const isAzureHost =
		// 匹配Azure OpenAI资源域后缀。
		url.hostname.endsWith(".openai.azure.com") ||
		// 或Cognitive Services后缀。
		url.hostname.endsWith(".cognitiveservices.azure.com") ||
		// 或Foundry ai.azure.com后缀；不验证资源所有权。
		url.hostname.endsWith(".ai.azure.com");
	// 仅供比较去路径尾斜杠，此时尚未修改url.pathname。
	const normalizedPath = url.pathname.replace(/\/+$/, "");

	// Ensure Azure hosts have /openai/v1 as base path so the AzureOpenAI SDK
	// can append /deployments/<model>/... and ?api-version=v1 correctly.
	// 同时满足已知host与特定路径才改写。
	if (
		// 代理等非匹配host跳过这段规则。
		isAzureHost &&
		// 空路径是可重写候选。
		(normalizedPath === "" ||
			// 根斜杠也列为候选，虽然前面去尾斜杠后通常为空。
			normalizedPath === "/" ||
			// 旧/openai基础路径转为v1。
			normalizedPath === "/openai" ||
			// 误给完整responses路径时退回API根路径。
			normalizedPath === "/openai/v1/responses")
	) {
		// 把pathname替换为SDK使用的/openai/v1。
		url.pathname = "/openai/v1";
		// 仅在上述改写分支清空search，避免旧查询干扰版本配置。
		url.search = "";
	}

	// URL标准化序列化后去字符串末尾斜杠；没有一律删除查询和fragment。
	return url.toString().replace(/\/+$/, "");
}

/**
 * 按资源名拼默认HTTPS根URL并返回，不验证资源名、存在性或请求服务。
 * 例：resourceName=team生成https://team.openai.azure.com/openai/v1；完整URL配置优先级更高。
 */
function buildDefaultBaseUrl(resourceName: string): string {
	// 只拼字符串，资源名有效性不在此单独验证。
	return `https://${resourceName}.openai.azure.com/openai/v1`;
}

/**
 * 按完整根URL→资源名生成URL→模型baseUrl选择，然后规范化，返回字符串。
 * 完整URL内部为选项trim后真值优先、再环境；资源名选项优先再环境。例：环境完整URL会优先于显式资源名，全部缺失抛配置错误。
 * 环境helper还可读options.env覆盖，不在此读凭证或更改process.env；资源名不trim，最终选中URL才检查可解析性。
 */
export function resolveAzureBaseUrl(model: Pick<Model<Api>, "baseUrl">, options?: AzureEndpointOptions): string {
	// 先选本次完整根URL候选。
	const baseUrl =
		// 选项URL与环境URL都trim后按真值回退，最后统一undefined。
		options?.azureBaseUrl?.trim() || getProviderEnvValue("AZURE_OPENAI_BASE_URL", options?.env)?.trim() || undefined;
	// 资源名不trim；选项真值优先于同名环境值。
	const resourceName = options?.azureResourceName || getProviderEnvValue("AZURE_OPENAI_RESOURCE_NAME", options?.env);

	// let保存已选URL，后面可由资源名/模型兜底。
	let resolvedBaseUrl = baseUrl;

	// 缺完整URL且有资源名才拼默认地址。
	if (!resolvedBaseUrl && resourceName) {
		// 资源名生成的地址优先于模型baseUrl。
		resolvedBaseUrl = buildDefaultBaseUrl(resourceName);
	}

	// 前两层均没结果，才采用模型声明URL。
	if (!resolvedBaseUrl && model.baseUrl) {
		// 保留模型URL文字，下面再规范化。
		resolvedBaseUrl = model.baseUrl;
	}

	// 所有来源都无真值即配置错误。
	if (!resolvedBaseUrl) {
		// 抛可操作的缺URL错误。
		throw new Error(
			// 提示可用配置入口，不在这里实际写配置。
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
		);
	}

	// 对唯一选中的地址解析/规范化，不回退无法解析的高优先级地址。
	return normalizeAzureBaseUrl(resolvedBaseUrl);
}

/**
 * 返回最终baseUrl和apiVersion对象，无网络；根URL解析错误向外抛。
 * 版本优先非空选项、环境、默认v1，例：options.azureApiVersion="preview"覆盖环境；版本文字不trim也不校验服务端是否支持。
 */
export function resolveAzureConfig(
	// Pick只要求baseUrl字段，调用不需要完整模型能力。
	model: Pick<Model<Api>, "baseUrl">,
	// 可省略请求选项。
	options?: AzureEndpointOptions,
	// 返回内联对象类型含两个字符串。
): { baseUrl: string; apiVersion: string } {
	// 每次调用新建结果对象，不建立SDK实例。
	return {
		// 根地址沿用上述优先级和错误规则。
		baseUrl: resolveAzureBaseUrl(model, options),
		// 版本独立选择，不从根URL里的查询参数读取。
		apiVersion:
			// 版本选项为真值时优先，空白串也是真值。
			options?.azureApiVersion ||
			// 否则读请求/进程环境的Azure专属版本变量。
			getProviderEnvValue("AZURE_OPENAI_API_VERSION", options?.env) ||
			// 均无真值时用v1，不验证远端支持性。
			DEFAULT_AZURE_API_VERSION,
	};
}
