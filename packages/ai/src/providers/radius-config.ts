// Radius网关目录的共享数据/浅检查/转换/HTTP加载入口，供Radius Provider刷新与OAuth凭据兼容读取使用。
// 模型目录是网关返回的账户配置；这里不会调用聊天模型，也不从静态生成文件反推组织允许列表。
// OAuthCredential仅导入类型，不会因此读取用户凭据或执行登录。
import type { OAuthCredential } from "../auth/types.ts";
// Model泛型指定pi-messages协议，ThinkingLevelMap是可选思考级别映射；都是TS开发期约束。
import type { Model, ThinkingLevelMap } from "../types.ts";
// 错误正文裁片段的字符串helper，按UTF-16码元slice，非字节/token裁剪或脱敏。
import { ownedSlice } from "../utils/text.ts";

// 默认公开Radius网关地址，定义常量不发HTTP。
export const DEFAULT_RADIUS_GATEWAY = "https://radius.pi.dev";

// 一条网关目录模型形状，供客户端拼成完整Model；类型比下面实际运行检查更严格，不能混同。
export type RadiusGatewayModel = {
	// 模型唯一标识文字，实际guard只查string，未要求非空。
	id: string;
	// 显示名称，同样未运行检查非空。
	name: string;
	// 是否支持思考的布尔声明，不代表本次请求真的启用。
	reasoning: boolean;
	// 可选思考档映射，实际浅guard不检查其内容。
	thinkingLevelMap?: ThinkingLevelMap;
	// 静态类型只允许text/image数组，运行时guard仅确认数组，不逐元素验证。
	input: ("text" | "image")[];
	// 索引访问类型复用pi-messages模型的cost字段结构；运行检查不验证各成本数值。
	cost: Model<"pi-messages">["cost"];
	// 上下文窗口token数量，guard只查number，未检查有限/正数/整数。
	contextWindow: number;
	// 最大输出token限制，同样无本层数值范围校验。
	maxTokens: number;
};

// 网关配置外壳，由baseUrl和账户允许模型列表组成。
export type RadiusGatewayConfig = {
	// 后续模型请求用的服务基址，不一定与发现目录的gateway字符串完全一样。
	baseUrl: string;
	// 模型数组可为空，空列表可表示组织禁用了所有模型。
	models: RadiusGatewayModel[];
};

// 交叉类型在OAuth凭据上附加可选旧目录缓存；as此类型不自动补运行时校验。
export type RadiusOAuthCredential = OAuthCredential & {
	// 可选旧版gatewayConfig用下面sanitize读取，不保证任意Provider的凭据都含它。
	gatewayConfig?: RadiusGatewayConfig;
};

// 浅判定unknown是否满足本实现检查的模型外壳，返回类型谓词；例其余必查字段齐全时input:[123]仍可通过。
// 逐字段检查对象/基本类型，不验证input元素、cost子项、thinking映射、数值范围，也不移除额外属性。
// 无I/O/修改；is谓词让TS在true分支按完整类型使用，证明强度仍取决于这些实际检查。
function isRadiusGatewayModel(value: unknown): value is RadiusGatewayModel {
	// 外部数据边界：排除原始值/null/数组，保留普通对象或其他非数组对象。
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	// Partial视图让字段按可缺访问，不是把未知数据转换成完整模型。
	const model = value as Partial<RadiusGatewayModel>;
	// 短路与连接各项外壳条件，前一项false不再读取后面。
	return (
		// id必须string，但空串也满足。
		typeof model.id === "string" &&
		// name必须string，不trim。
		typeof model.name === "string" &&
		// reasoning必须真正boolean，不接受文字true。
		typeof model.reasoning === "boolean" &&
		// 只判数组，未检查每个模态名字。
		Array.isArray(model.input) &&
		// cost先要求typeof object，随后两行排除null/数组；没查input/output等子属性。
		typeof model.cost === "object" &&
		// null虽然typeof为object，也要排除。
		model.cost !== null &&
		// cost不能是数组，但仍可有缺少数字子项的对象。
		!Array.isArray(model.cost) &&
		// window为number，NaN/Infinity/负数仍可能通过这个条件。
		typeof model.contextWindow === "number" &&
		// 输出限制同样只查number。
		typeof model.maxTokens === "number"
	);
}

// 从unknown目录取baseUrl与过滤后模型列表，返回新外壳或undefined；例混入坏模型只删坏项，不拒整份目录。
// 只对保留模型浅展开，嵌套cost/input仍共享引用且额外字段保留；baseUrl只确认string，不验证URL。无I/O。
function sanitizeRadiusGatewayConfig(config: unknown): RadiusGatewayConfig | undefined {
	// 未知输入先排原始值/null/数组，不因为形似键名就信任。
	if (typeof config !== "object" || config === null || Array.isArray(config)) return undefined;
	// 把可选字段视图解构出来；as不执行schema或默认填值。
	const { baseUrl, models } = config as Partial<RadiusGatewayConfig>;
	// 外壳必须string基址和数组列表，空串/空列表仍可通过。
	if (typeof baseUrl !== "string" || !Array.isArray(models)) return undefined;
	// 返回新配置对象，原config顶层不被改写。
	return {
		// 保留原baseUrl文字，不在此规范化或建立可信来源。
		baseUrl,
		// filter调用模型guard丢掉坏项，再map浅复制保留项；并非深克隆/字段白名单。
		models: models.filter(isRadiusGatewayModel).map((model) => ({ ...model })),
	};
}

// 对网关文字补缺省https并去末尾斜杠，返回string，不发请求或解析URL。
// 例example.test///→https://example.test；已有HTTP大小写前缀保留。空串最终变https:，不是合法网关校验证明。
export function normalizeRadiusGatewayUrl(value: string): string {
	// 正则只认开头http://或https://，i忽略大小写；其他协议也会被前面再加https://。
	const withScheme = /^https?:\/\//iu.test(value) ? value : `https://${value}`;
	// 按文字去所有末尾/，不分辨它属于路径还是查询值；不trim首尾空格，也不解析origin。
	return withScheme.replace(/\/+$/u, "");
}

// 从可选OAuth凭据读旧gatewayConfig并浅筛，返回配置或undefined，无凭据IO/刷新。
// 例凭据没旧字段得到undefined；凭据type本身不在这里重新检查，目录内部走sanitize边界。
export function getRadiusCredentialConfig(credential: OAuthCredential | undefined): RadiusGatewayConfig | undefined {
	// 交叉类型断言允许取额外字段，可选链保护undefined，再交unknown清洗器。
	return sanitizeRadiusGatewayConfig((credential as RadiusOAuthCredential | undefined)?.gatewayConfig);
}

// 把已给配置的每模型变成pi-messages Model新对象，绑定providerId与baseUrl，不请求/修改配置。
// 例providerId="radius-dev"使所有结果provider相同；只信参数类型，不再调用sanitize，嵌套值仍共享。
export function getRadiusModelsFromConfig(providerId: string, config: RadiusGatewayConfig): Model<"pi-messages">[] {
	// map逐项生成新对象，空模型列表得到空数组。
	return config.models.map((model) => ({
		// 先展开原模型，额外字段也带过去。
		...model,
		// 后置api固定覆盖可能存在的同名输入值。
		api: "pi-messages",
		// 绑定调用方providerId，不按网关主机自动取名。
		provider: providerId,
		// 统一使用配置baseUrl，覆盖原项可能额外携带的地址。
		baseUrl: config.baseUrl,
	}));
}

// 从旧凭据目录生成模型数组，缺/坏外壳返回[]，无网络；例OAuth升级过渡期载入缓存。
// 复用浅筛与映射；空数组既可能无配置，也可能配置明确无模型，调用方需理解语义。
export function getRadiusModels(providerId: string, credential: OAuthCredential | undefined): Model<"pi-messages">[] {
	// 先取得通过本地浅检查的旧目录，可undefined。
	const config = getRadiusCredentialConfig(credential);
	// 有配置才绑定provider，否则新空数组；不会fallback静态公开模型列表。
	return config ? getRadiusModelsFromConfig(providerId, config) : [];
}

// 用于HTTP错误的正文预览，输入string、返回trim后至多512码元再加省略号，无I/O/脱敏。
// 例513码元正文留下前512与…，切片可能落在代理对中间；不限制读取响应正文的总大小。
function truncateHttpBody(body: string): string {
	// 先trim两端空白，长度比较针对trim后内容。
	const trimmed = body.trim();
	// 长时ownedSlice取前512并追加…，输出可长513码元；短时直接返回trimmed。
	return trimmed.length > 512 ? `${ownedSlice(trimmed, 0, 512)}…` : trimmed;
}

// GET读取网关/v1/config并浅筛目录，返回Promise配置；输入基址、可选Bearer key与AbortSignal。
// 例gateway="https://example.test/prefix/"仍请求其源下/v1/config，前缀被绝对路径替换；不是字符串末尾直接加/v1/config。
// 非2xx带有限正文预览抛Error；网络/中止/URL/正文读取/JSON解析错误直接拒绝，未设独立超时、重试或手动读前signal早返。
export async function loadRadiusGatewayConfig(
	// 应可作URL基址的网关文字，类型string不保证URL可解析或可信。
	gateway: string,
	// 可省略API key；空串不添加Authorization，不查询环境/凭据存储。
	apiKey?: string,
	// 可选信号透传fetch，取消是请求取消而非远端已停止的证明。
	signal?: AbortSignal,
	// async让同步抛错也变Promise拒绝；成功数据只是本实现浅检查后的配置。
): Promise<RadiusGatewayConfig> {
	// 请求头先声明接受JSON，不要求服务端Content-Type一定正确才尝试解析。
	const headers: Record<string, string> = { accept: "application/json" };
	// key真值才添加Bearer头，沿用原key不trim，不把它打印。
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	// new URL以源根路径定位，fetch默认GET并带headers/signal，真实调用会发网络请求。
	const response = await fetch(new URL("/v1/config", gateway), { headers, signal });
	// response.ok按2xx判成功，其他状态先读错误正文。
	if (!response.ok) {
		// 构造清楚的HTTP配置加载错误。
		throw new Error(
			// await text会先读完整正文再裁512码元；读取失败自身拒绝，不保证一定得到这个拼接错误。
			`Could not load Radius config from ${gateway}: ${response.status}: ${truncateHttpBody(await response.text())}`,
		);
	}
	// 成功响应先JSON解码，再筛外壳/模型；不是完整schema验证。
	const config = sanitizeRadiusGatewayConfig(await response.json());
	// 外壳不满足才报Invalid Radius config；坏模型可已被过滤成空列表而仍算成功。
	if (!config) throw new Error(`Invalid Radius config from ${gateway}`);
	// 返回筛后的新对象，没保留response/headers或缓存时间戳，持久化由Provider上层完成。
	return config;
}
