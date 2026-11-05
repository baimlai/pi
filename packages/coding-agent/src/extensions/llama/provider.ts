// 把 llama.cpp 路由目录转换成 pi 聊天/分类模型，提供URL与可选key认证、缓存恢复、联网刷新及实际请求委托。创建对象不连接服务器，refresh/login/stream/classify才可能启动各自工作。
// index.ts用setCatalog快速同步管理界面的目录；Models通过refreshModels/publish协调缓存和代次，客户端HTTP/目录形状检查在client.ts，聊天与分类请求由pi-ai适配器处理。
// 从pi-ai取得目录/认证/Provider契约及种类判定函数；type修饰的成员在执行JS中擦除。
import {
	// AnyModel是聊天/图片/分类目录联合，用于读取存储中的混合模型。
	type AnyModel,
	// API key凭证也能只保存env里的服务地址，key可缺省。
	type ApiKeyCredential,
	// AuthContext提供可注入的异步环境/文件能力，不直接等于process.env。
	type AuthContext,
	// AuthResult是请求认证材料及解析出的env，不代表远端认证一定成功。
	type AuthResult,
	// ClassifierModel泛型绑定分类协议，区别于普通聊天Model。
	type ClassifierModel,
	// isModelType实际比较种类并向TS提供类型收窄，兼容省略type的旧聊天项。
	isModelType,
	// Model描述聊天能力/预算；这里统一走OpenAI Completions兼容协议。
	type Model,
	// Provider是有状态供应商对象的接口，不在导入时创建实现。
	type Provider,
	// 原始流公共选项允许附加供应商字段，后面用as衔接泛型类型。
	type ProviderStreamOptions,
	// 动态刷新参数包含存储快照、凭证、发布器、联网开关和取消信号。
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
// 工厂只创建延迟分类能力对象，实际classify调用时才导入标签概率实现。
import { llamaCppClassifyApi } from "@earendil-works/pi-ai/api/llama-cpp-classify.lazy";
// 原生决策模型使用System One延迟分类器，和普通聊天模型的标签概率回退不同。
import { typesafeSystemOneApi } from "@earendil-works/pi-ai/api/typesafe-system-one.lazy";
// 聊天转交旧全局分发表，按模型api选择实际流实现；导入compat会安装内置注册，但不因此立即发模型请求。
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
// 管理客户端和URL辅助来自同目录，值与type成员分别用于运行与编译检查。
import {
	// 客户端负责/models、/props等管理请求，不是本地启动llama-server的控制器。
	LlamaClient,
	// 目录条目包含状态、模态、元数据等；实际list仅做其实现中的有限形状检查。
	type LlamaModelInfo,
	// /props结果经客户端筛出models_autoload和chat_template两个可选字段。
	type LlamaServerProps,
	// 推理辅助先规范管理根再追加/v1；单次规范只剥一层末尾/v1，管理地址不保证完全没有/v1路径段。
	llamaInferenceUrl,
	// URL解析仅接受http/https，清查询/片段，单次只剥一层末尾/v1，不验证服务真实可达。
	normalizeLlamaServerUrl,
} from "./client.ts";

// 稳定供应商ID同时用于注册、缓存归属、认证和请求模型字段。
export const LLAMA_PROVIDER_ID = "llama.cpp";
// 交互配置没输入地址且进程环境没提供时的默认值；仅有此常量不会使未配置供应商自动可用。
export const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080";
// 从可缺API key凭证取非空服务地址，返回规范URL或undefined；无网络/存储写入。例env.LLAMA_BASE_URL="http://localhost:8080/v1/"得到无/v1管理地址；非法URL仍会抛错。
function credentialServerUrl(credential: ApiKeyCredential | undefined): string | undefined {
	// ?.逐层短路处理缺凭证/env，读的是供应商作用域配置，不是宿主环境变量。
	const value = credential?.env?.LLAMA_BASE_URL;
	// 保留既有typeof检查；trim只判断非空，规范函数自己再trim/解析；纯空白回undefined，不合法的非空地址不会静默忽略。
	return typeof value === "string" && value.trim() ? normalizeLlamaServerUrl(value) : undefined;
}

// 优先凭证地址，否则异步查ctx环境，返回规范URL/undefined的Promise；例凭证无地址才查LLAMA_BASE_URL。没有连通性检查，ctx.env拒绝或URL非法会向外拒绝。
async function resolveServerUrl(
	// 注入环境查询能力，使调用方可用自己的上下文而不是固定process.env。
	ctx: AuthContext,
	// 参数位置必须提供，但其值允许undefined；区别于credential?可省略参数。
	credential: ApiKeyCredential | undefined,
	// async包装返回值为Promise，联合类型保留未配置状态。
): Promise<string | undefined> {
	// ??只在凭证地址缺失时才await环境查询；环境返回值可选trim，不会逐字段改写原凭证。
	const configured = credentialServerUrl(credential) ?? (await ctx.env("LLAMA_BASE_URL"))?.trim();
	// 有非空配置再规范一次，空值返回undefined；凭证优先但非法凭证地址会先抛错，不回退环境。
	return configured ? normalizeLlamaServerUrl(configured) : undefined;
}

// 按当前目录状态决定是否可路由，输入模型和已探明的autoload布尔，返回boolean，无I/O；例sleeping仍可选，unloaded仅非失败preset且开autoload才可选，不在这里真正加载。
function modelIsSelectable(model: LlamaModelInfo, routerAutoload: boolean): boolean {
	// loaded直接通过，不再检查failed/source字段。
	if (model.status.value === "loaded") return true;
	// llama.cpp reports idle-slept models as "sleeping"; requests wake them automatically.
	// sleeping同样通过，服务约定请求可唤醒；本判定自己不发唤醒请求。
	if (model.status.value === "sleeping") return true;
	// Unloaded presets are routable only when llama.cpp router autoload can load them on first use.
	// &&要求四条件全满足；loading/downloading/普通缓存未加载项均不通过，failed假值才允许preset。
	return routerAutoload && model.status.value === "unloaded" && !model.status.failed && model.source === "preset";
}

// 仅目录含未加载preset时查全局/props的自动加载开关，返回Promise<boolean>；例全是loaded直接false。会有一次HTTP，所有props失败含取消都先吞成false，上游随后另查取消信号。
async function routerAutoloadEnabled(
	// 已经配置好管理URL/key的客户端。
	client: LlamaClient,
	// readonly限制通过此参数改数组的TS操作，不深冻结条目。
	catalog: readonly LlamaModelInfo[],
	// 信号透传HTTP；signal类型本身不会强制调用方检查取消。
	signal: AbortSignal,
): Promise<boolean> {
	// some遇首个unloaded preset就短路；这里不先排failed，因此失败preset也可能触发一次开关查询。
	if (!catalog.some((model) => model.status.value === "unloaded" && model.source === "preset")) return false;
	// try只围住props请求和返回字段判断，不包含上面目录遍历。
	try {
		// 无model参数查路由器全局props，仅严格true才开启，缺省false。
		return (await client.props({ signal })).models_autoload === true;
		// 不保留错误详情，把HTTP/解析/取消等失败一律降级。
	} catch {
		// 返回false让后续筛选保守隐藏未加载preset，已loaded/sleeping不受这个布尔限制。
		return false;
	}
}

// 从目录status.args查第一个有效上下文参数，返回正安全整数或undefined，无I/O；例["--ctx-size","32768"]得32768。不支持--ctx-size=形式，非法命中后继续找后续参数。
function configuredContextWindow(model: LlamaModelInfo): number | undefined {
	// ??缺args才用空数组，原数组只读访问不修改。
	const args = model.status.args ?? [];
	// 只遍历到倒数第二项，确保当前flag后还有一个值；index++是每轮索引加1。
	for (let index = 0; index < args.length - 1; index++) {
		// 取当前参数作为可能的flag，未统一大小写。
		const flag = args[index];
		// 三个精确名字之外continue，只跳当前迭代。
		if (flag !== "--ctx-size" && flag !== "-c" && flag !== "-ctx") continue;
		// 把下一项按JS Number规则转换，十六进制/科学计数等Number可接受的文字也能进入数值判断。
		const contextWindow = Number(args[index + 1]);
		// 要求安全整数且大于0，第一个满足者立即返回，不扫描后续覆盖值。
		if (Number.isSafeInteger(contextWindow) && contextWindow > 0) return contextWindow;
	}
	// 未找到有效参数用undefined，交contextWindowOf继续其他来源。
	return undefined;
}

// 按运行n_ctx→命令参数→旧缓存→训练n_ctx_train→128000选上下文，输入条目和可缺缓存返回number，无I/O；例缓存65536可优先训练128000。除命令参数外仅判真值和正数，不统一检查安全整数/有限性。
function contextWindowOf(model: LlamaModelInfo, cachedContextWindow?: number): number {
	// 可选meta没有时得到undefined，不读取服务器props。
	const runtimeContextWindow = model.meta?.n_ctx;
	// 运行时容量真值且>0直接采用，0/负数跳过，Infinity也没有在此排除。
	if (runtimeContextWindow && runtimeContextWindow > 0) return runtimeContextWindow;
	// 再从status.args取有效正安全整数。
	const configuredContext = configuredContextWindow(model);
	// 找到配置容量就返回，优先于缓存和训练容量。
	if (configuredContext) return configuredContext;
	// 缓存正真值时保留旧有效容量，但不会保留整个旧模型的thinking/其他能力字段。
	if (cachedContextWindow && cachedContextWindow > 0) return cachedContextWindow;
	// 最后尝试训练期标称容量，它不一定就是服务器运行配置。
	const trainingContextWindow = model.meta?.n_ctx_train;
	// 训练容量同样只判正真值，否则给固定128000；这是兜底元数据，不是实测服务上限。
	return trainingContextWindow && trainingContextWindow > 0 ? trainingContextWindow : 128000;
}

// 两种分类协议的字面量联合，运行时没有名为LlamaClassifierApi的值。
type LlamaClassifierApi = "llama-cpp-classify" | "typesafe-system-one";

/**
 * Whether llama.cpp reports a native decision model. Since llama.cpp 0.6.0, `GET /models` lists
 * `decisions` in `architecture.output_modalities` for these models, including unloaded and sleeping ones.
 * Older servers report `["text"]` or omit `architecture`, so their models are treated as chat models.
 */
// 判断目录是否声明原生decisions输出，输入条目返回布尔，无探测请求；例缺architecture为false，含decisions为true。依赖目录报告，不试着执行分类验证能力。
function isDecisionModel(model: LlamaModelInfo): boolean {
	// 两级?.允许缺字段，includes精确匹配字符串，===true把缺失的undefined收成false。
	return model.architecture?.output_modalities?.includes("decisions") === true;
}

/** Decision-only models cannot generate text and are not listed for chat. */
// 判断此项是否列入聊天目录，输入条目返回布尔，无副作用；例仅decisions不列聊天，text+decisions同时列聊天和分类。不是所有已声明模态的严格验证器，非决策项即使没text也通过。
function isChatModel(model: LlamaModelInfo): boolean {
	// 不是决策模型默认按聊天处理；决策模型还必须明确包含text。
	return !isDecisionModel(model) || model.architecture?.output_modalities?.includes("text") === true;
}

/**
 * A llama.cpp model used as a classifier. Decision models answer natively through llama.cpp's
 * System One endpoint (`/v1/systemone`). Chat models fall back to `llama-cpp-classify`, which reads
 * answers from next-token label probabilities.
 */
// 把上游条目投影为新的分类模型，输入管理地址和可缺缓存容量，返回ClassifierModel，无HTTP/写盘；例decisions模型用/v1的typesafe-system-one，普通模型用管理根的llama-cpp-classify。零cost为目录估价，不证明运行无资源开销。
function toPiClassifierModel(
	// 原上游目录条目，只读取不修改。
	model: LlamaModelInfo,
	// 管理根地址，原生推理协议会在下面补/v1。
	serverUrl: string,
	// 可选已保存容量，只影响容量选择。
	cachedContextWindow?: number,
	// 泛型使返回api必须属于前面两个分类协议，不能返回聊天api。
): ClassifierModel<LlamaClassifierApi> {
	// 按目录模态一次判断决策能力，后面api/URL共用这个布尔。
	const decision = isDecisionModel(model);
	// 创建新外层目录对象，不复制上游所有未知字段。
	return {
		// 显式classifier标签让混合目录可区分同ID的聊天与分类投影。
		type: "classifier",
		// 请求模型ID沿用上游id，不生成另一套分类专用ID。
		id: model.id,
		// 展示名也直接用id，没有别名/友好名字优先处理。
		name: model.id,
		// 三元表达式按decisions标记选原生或标签概率协议。
		api: decision ? "typesafe-system-one" : "llama-cpp-classify",
		// 归属固定llama.cpp供应商，和上游id不是同一字段。
		provider: LLAMA_PROVIDER_ID,
		// 原生System One走/v1；回退分类器需要根路径的/tokenize等端点，所以保留serverUrl。
		baseUrl: decision ? llamaInferenceUrl(serverUrl) : serverUrl,
		// 本投影只声明text输入，即使上游目录还能看图，也没在分类目录承诺图片支持。
		input: ["text"],
		// 四种token单价标0，用于pi估价，不对服务运营成本作保证。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// 共用实际/配置/缓存/训练的容量优先级，不请求模型加载。
		contextWindow: contextWindowOf(model, cachedContextWindow),
	};
}

// 判断混合模型是否为本扩展支持的分类协议，返回类型谓词并收窄，无I/O；例classifier+typesafe-system-one通过，chat同api不通过。自身不检查provider归属，恢复时调用方先按provider筛选。
function isLlamaClassifierModel(model: AnyModel): model is ClassifierModel<LlamaClassifierApi> {
	// 多行圆括号包住同一个布尔返回表达式，不创建数组。
	return (
		// 先用种类守卫让TS能访问分类api，再只认两个API名字；不是完整字段schema验证。
		isModelType(model, "classifier") && (model.api === "llama-cpp-classify" || model.api === "typesafe-system-one")
	);
}

// 把可选聊天条目转成OpenAI兼容模型，输入目录/管理根/可缺props与缓存容量，返回新Model，无网络；例props模板含enable_thinking时标记thinking，其余仅凭目录不会开启。相同容量用于contextWindow和maxTokens，属于声明而非实测。
function toPiModel(
	// 上游模型状态/模态/容量数据。
	model: LlamaModelInfo,
	// 管理URL用于计算推理/v1地址。
	serverUrl: string,
	// 只有调用方已经取到模板时才有props；省略不复用旧thinking标志。
	props?: LlamaServerProps,
	// 缓存只供容量兜底，不作为完整旧目录覆盖。
	cachedContextWindow?: number,
	// Model<"openai-completions">保留具体聊天协议，compat因此关联该协议的字段。
): Model<"openai-completions"> {
	// 先统一选容量，避免下面contextWindow/maxTokens各用不同来源。
	const contextWindow = contextWindowOf(model, cachedContextWindow);
	// 只做模板字符串包含判断，不执行/完整解析模板，也不验证模型实际能否正确思考。
	const reasoning = props?.chat_template?.includes("enable_thinking") === true;
	// 构造独立聊天目录对象，省略type按pi约定就是chat。
	return {
		// id作为真实请求模型标识。
		id: model.id,
		// 展示名仍是原id，不用aliases数组。
		name: model.id,
		// 所有聊天项声明OpenAI Chat Completions兼容协议。
		api: "openai-completions",
		// 按llama.cpp供应商注册和认证。
		provider: LLAMA_PROVIDER_ID,
		// 规范管理地址后加/v1，聊天适配器会继续拼具体推理端点。
		baseUrl: llamaInferenceUrl(serverUrl),
		// 属性简写等价reasoning:reasoning，只是能力目录标志，不等于当前请求启用了思考。
		reasoning,
		// 对象展开配合&&：reasoning为true才添加这组映射，false不添加字段，不是数组展开。
		...(reasoning && {
			// off映射关闭、medium映射开启档位，其余null声明不支持；具体请求模板开关由适配器处理。
			thinkingLevelMap: { off: "off", minimal: null, low: null, medium: "medium", high: null, xhigh: null },
		}),
		// 只有上游明确包含image才声明text+image，缺失时按纯text；未检查图片尺寸等能力。
		input: model.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
		// 本地目录估价统一0，实际服务资源使用不在这里计费。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// 写入选定容量，属性简写沿用局部值。
		contextWindow,
		// 最大输出元数据也取同容量，没有额外扣掉输入预算，真正可用量还看请求适配/服务限制。
		maxTokens: contextWindow,
		// compat显式覆盖兼容性推断，告诉下游该发送哪些字段/角色格式。
		compat: {
			// 不发送store字段，不是承诺服务不记日志或不缓存。
			supportsStore: false,
			// 不采用developer角色的兼容路径，系统指令按下游规则转换。
			supportsDeveloperRole: false,
			// 不发标准reasoning_effort；此服务的thinking另走模板参数。
			supportsReasoningEffort: false,
			// 请求流中的usage字段，不保证每次响应/取消场景都能收到用量。
			supportsUsageInStreaming: true,
			// 工具声明不请求OpenAI strict模式，不代表免除本地工具参数验证。
			supportsStrictMode: false,
			// 输出上限采用旧max_tokens字段名而非max_completion_tokens。
			maxTokensField: "max_tokens",
			// 只有识别到thinking模板才声明qwen-chat-template格式，下游据此写enable_thinking/preserve_thinking参数。
			...(reasoning && { thinkingFormat: "qwen-chat-template" }),
		},
	};
}

// 控制器把可注册Provider和管理界面更新入口一起返回；interface只描述结构，不自动注册或联网。
export interface LlamaProviderController {
	// Provider泛型只限定聊天API；getAllModels仍可列自己两个分类协议的模型。
	provider: Provider<"openai-completions">;
	// 同步替换目录，无返回值；例setCatalog(items,url,{routerAutoload:true})允许可自动加载preset，不自己探props/保存缓存；readonly仅限制通过数组视图修改。
	setCatalog(models: readonly LlamaModelInfo[], serverUrl: string, options?: { routerAutoload?: boolean }): void;
}

// 创建独立有状态供应商及setCatalog，无参数，返回控制器；例扩展工厂注册provider，再由刷新填目录。初始列表空，不读凭证/发HTTP，分类工厂只建延迟对象；后续方法的副作用在各自调用时发生。
export function createLlamaProvider(): LlamaProviderController {
	// let允许稍后整体替换列表，readonly只限制数组的TS变更操作，非运行时冻结。
	let models: readonly Model<"openai-completions">[] = [];
	// 分类列表独立保存，同一上游id可同时有聊天和分类两项。
	let classifiers: readonly ClassifierModel<LlamaClassifierApi>[] = [];
	// 创建普通模型标签概率分类器，不在此导入实现或推理。
	const fallbackClassifier = llamaCppClassifyApi();
	// 创建原生System One分类器，实际实现按需加载。
	const decisionClassifier = typesafeSystemOneApi();

	// 接收上游目录/地址/可选autoload，筛可选→聊天投影→分类投影，同步覆盖两个闭包列表；例sleeping可展示但这里没有模板，因此reasoning为false。不持久化/不校验服务可达/不探全局autoload，URL非法可抛错。
	const setCatalog = (
		// 输入目录只读数组视图，filter会新建容器但条目仍是原对象引用。
		catalog: readonly LlamaModelInfo[],
		// 本次目录对应的服务地址，不保存为全局进程环境。
		serverUrl: string,
		// 省略options时用空对象，字段省略等同没开autoload。
		options: { routerAutoload?: boolean } = {},
		// 箭头函数明确void返回，执行效果是改外层models/classifiers。
	): void => {
		// 只有routerAutoload严格true才允许未加载preset，其余状态按辅助规则过滤。
		const selectable = catalog.filter((model) => modelIsSelectable(model, options.routerAutoload === true));
		// 只把可聊天项投影，未传props/缓存，所以不识别thinking且容量不复用旧缓存。
		models = selectable.filter(isChatModel).map((model) => toPiModel(model, serverUrl));
		// 所有可选项都投影成分类器，包含仅decisions模型；失败过程中不提供两列表原子回滚。
		classifiers = selectable.map((model) => toPiClassifierModel(model, serverUrl));
	};

	// 构造符合Provider契约的对象，方法闭包引用刚才的两组可变列表。
	const provider: Provider<"openai-completions"> = {
		// 供应商唯一键。
		id: LLAMA_PROVIDER_ID,
		// 给用户展示的名字。
		name: "llama.cpp",
		// 供应商默认推理地址仍固定8080；实际模型/认证可覆盖，不代表未配置时就自动连接此地址。
		baseUrl: llamaInferenceUrl(DEFAULT_LLAMA_SERVER_URL),
		// 至少提供一种认证语义；本地免key也通过apiKey类保存地址/判断配置。
		auth: {
			// 这是一类认证方法集合，key本身仍可选，不是OAuth登录。
			apiKey: {
				// 登录菜单展示名。
				name: "llama.cpp server",
				// 交互配置流程接宿主prompt/signal，先询URL和可选key，再GET目录验证router形状，成功返回待保存凭证；例空key只存地址。可能HTTP/提示失败，不在本回调写凭证存储，也不保证以后请求持续可用。
				login: async (interaction): Promise<ApiKeyCredential> => {
					// await等用户输入URL，取消按交互契约拒绝；prompt本身不会由类型自动实现。
					const enteredUrl = await interaction.prompt({
						// text类别请求普通文本输入，不是一个已验证URL类型。
						type: "text",
						// 原英文提示保持原样，UI展示后返回用户输入字符串。
						message: "llama.cpp server URL",
						// placeholder用??保留环境空串，仅作为占位展示；并不等于用户真的输入了这个值。
						placeholder: process.env.LLAMA_BASE_URL ?? DEFAULT_LLAMA_SERVER_URL,
					});
					// 真正选值后交URL规范函数，格式非法会拒绝整个async登录。
					const serverUrl = normalizeLlamaServerUrl(
						// 用户trim后非空优先，其次进程环境真值，最后默认8080；这一步使用||，与placeholder的??空串规则不同。
						enteredUrl.trim() || process.env.LLAMA_BASE_URL || DEFAULT_LLAMA_SERVER_URL,
					);
					// 把下一次秘密输入的结果放进括号后统一trim，const局部key仅属本次登录。
					const apiKey =
						// await第二次提示取得文字，不自动验证key格式或远端授权。
						(
							await interaction.prompt({
								// secret要求宿主用秘密输入交互，是否遮显由宿主实现。
								type: "secret",
								// key允许留空的提示，不会自动生成真实服务令牌。
								message: "API key (optional)",
							})
						)
							// 对返回key去两端空白，纯空白变空串。
							.trim();
					// 用配置地址/key查/models并传登录信号；客户端判目录形状，HTTP成功仍不证明实际推理/所有模型权限可用。
					await new LlamaClient(serverUrl, apiKey || undefined).list({ signal: interaction.signal });
					// 查目录正常才返回新凭证对象，持久化由外层Models/宿主负责。
					return {
						// 字面量标签符合ApiKeyCredential类型。
						type: "api_key",
						// 空key记undefined，后续resolve仍可回退LLAMA_API_KEY或local占位。
						key: apiKey || undefined,
						// 把管理地址放供应商env，不写process.env.LLAMA_BASE_URL。
						env: { LLAMA_BASE_URL: serverUrl },
					};
				},
				// 轻量配置检查：解析URL→返回类型/来源或undefined，不连服务器、不输出key；例只有环境URL也算已配置。URL非法仍拒绝，参数解构只取ctx/credential，本实现不使用signal。
				check: async ({ ctx, credential }) => {
					// 按存储配置优先、环境回退解析地址，不探测HTTP。
					const serverUrl = await resolveServerUrl(ctx, credential);
					// 用serverUrl真值决定是否有可用配置元数据。
					return serverUrl
						? // 来源标签只看有没有credential对象，即使URL实际回退环境仍可能标stored credential。
							{ type: "api_key", source: credential ? "stored credential" : "LLAMA_BASE_URL" }
						: // 无地址返回undefined，默认常量本身不会让未配置检查成功。
							undefined;
				},
				// 解析请求认证，输入ctx/可缺凭证，返回AuthResult或undefined的Promise；例有URL没key得到apiKey="local"和/v1。只装配材料不验证远端，不持久化；URL/环境查询错误向外传播，本实现未使用传入signal。
				resolve: async ({ ctx, credential }): Promise<AuthResult | undefined> => {
					// 仍复用同一地址优先级，不把默认8080自动当已配置来源。
					const serverUrl = await resolveServerUrl(ctx, credential);
					// 无非空URL直接未配置，连key环境都不查。
					if (!serverUrl) return undefined;
					// ??按存储key→环境key→local，明确空串key会保留；local为无key本地服务使用的占位，不是认证证书。
					const apiKey = credential?.key ?? (await ctx.env("LLAMA_API_KEY")) ?? "local";
					// 创建本次解析结果，和持久凭证不是同一对象。
					return {
						// 请求材料含key及/v1推理地址，后续Models可覆盖模型baseUrl。
						auth: { apiKey, baseUrl: llamaInferenceUrl(serverUrl) },
						// 浅展开原供应商env，再覆盖规范LLAMA_BASE_URL；不把所有宿主环境复制进结果。
						env: { ...credential?.env, LLAMA_BASE_URL: serverUrl },
						// 来源标签仍只按凭证存在性选，不逐字段说明具体值来自何处。
						source: credential ? "stored credential" : "LLAMA_BASE_URL",
					};
				},
			},
		},
		// 同步返回当前聊天数组原引用，无HTTP/复制；例初始为空，setCatalog后读取新列表，readonly不是运行时冻结。
		getModels: () => models,
		// 同步新建全种类数组：先聊天后分类，条目对象仍共享；例同id的chat和classifier同时可见，不在此按ID去重。
		getAllModels: () => [...models, ...classifiers],
		// 动态刷新先发布已存目录，再按联网/取消/凭证门槛拉/models、探autoload及loaded聊天模板，最后发布并持久化新投影；输入RefreshModelsContext返回Promise<void>。例离线只恢复缓存；失败可已恢复旧缓存。list/逐模型props/publish拒绝向外传播，autoload探测失败则按关闭，不发布半成品新网络目录。
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			// 按上游id缓存容量，聊天和分类共用键，重复id后写覆盖前写。
			const cachedContextWindows = new Map<string, number>();
			// 有存储条目才尝试恢复；没有条目不会先把旧闭包目录清空。
			if (context.stored) {
				// 按固定供应商ID筛混合目录，别家的模型不带入本Provider。
				const stored = context.stored.models.filter((model) => model.provider === LLAMA_PROVIDER_ID);
				// 进一步挑可恢复的聊天项，不重新从上游目录投影它们。
				const restored = stored.filter(
					// model is Model<...>为类型谓词，向filter后续结果提供具体聊天签名。
					(model): model is Model<"openai-completions"> =>
						// 种类必须chat（含缺省type）且api匹配；不按当前状态重新过滤存储项。
						isModelType(model, "chat") && model.api === "openai-completions",
				);
				// 分类项只恢复本扩展两个协议，provider归属已在stored过滤中处理。
				const restoredClassifiers = stored.filter(isLlamaClassifierModel);
				// 先遍历聊天再分类的合并数组，for...of处理同id不同类型容量。
				for (const model of [...restored, ...restoredClassifiers]) {
					// 按id保存容量，某ID分类值会覆盖先前聊天值；不是以id+api分别缓存。
					cachedContextWindows.set(model.id, model.contextWindow);
				}
				// if条件跨行，对await publish返回值取反；false与抛错不是同一流程。
				if (
					// 发布仅内存恢复，不带persist所以不改存储，是否允许更新由外层代次/存储策略协调。
					!(await context.publish({
						// 同步update回调由publish调用，本对象不直接绕开闸门写缓存目录。
						update: () => {
							// 发布允许执行时整体换聊天列表为原存储对象引用。
							models = restored;
							// 同时换分类列表，不把分类项混进getModels。
							classifiers = restoredClassifiers;
						},
					}))
				) {
					// publish返回false时结束本次刷新，不继续联网；publish拒绝则向外拒绝，而非走这条return。
					return;
				}
			}

			// 任一联网门槛不满足即早返：只缓存、信号已取消、没有API key类凭证。这里不另读进程环境或直接解析OAuth。
			if (!context.allowNetwork || context.signal.aborted || context.credential?.type !== "api_key") return;
			// 网络刷新仅从本次有效credential.env取URL，不调用resolveServerUrl环境回退；外层Models可先把解析env包装成有效凭证。
			const serverUrl = credentialServerUrl(context.credential);
			// 缺凭证URL保留已恢复/原内存目录，不用默认地址碰服务。
			if (!serverUrl) return;
			// 新建管理客户端，保存管理根和凭证key，不在构造时发请求。
			const client = new LlamaClient(serverUrl, context.credential.key);
			// GET目录并传共享取消信号；上游返回错误直接拒绝，尚未发布新网络目录。
			const catalog = await client.list({ signal: context.signal });
			// HTTP回来后再检查取消，避免继续发props/发布。
			if (context.signal.aborted) return;
			// 仅有未加载preset时探全局autoload；该辅助吞props失败false。
			const routerAutoload = await routerAutoloadEnabled(client, catalog, context.signal);
			// 即便辅助吞了取消异常，也在这里用signal阻止后续投影。
			if (context.signal.aborted) return;
			// 按真实autoload探测结果筛可选状态，不把loading/downloading直接列入模型目录。
			const selectable = catalog.filter((model) => modelIsSelectable(model, routerAutoload));
			// Only loaded models expose their chat template without side effects. Unloaded autoload presets would
			// need to be loaded, while querying sleeping models may wake them. Those models remain without thinking
			// support until they are loaded and a later catalog refresh discovers it. Decision models need no
			// template, and llama.cpp reports them in the catalog regardless of their status.
			// 并发获取可聊天模型的props并投影，Promise.all按原输入顺序返回；单项失败拒绝并不主动取消其他已启动请求。
			const refreshed = await Promise.all(
				// 先排仅decisions项，async回调每项独立工作，非loaded项直接投影不发props。
				selectable
					.filter(isChatModel)
					.map(async (model) => {
						// 取同id存储容量作备选，未命中undefined继续其他容量来源。
						const cachedContextWindow = cachedContextWindows.get(model.id);
						// sleeping/可自动加载preset不读模板，避免该模板探测可能唤醒/加载；当前新投影因此没有reasoning，哪怕旧缓存曾有thinking。
						if (model.status.value !== "loaded")
							return toPiModel(model, serverUrl, undefined, cachedContextWindow);
						// 仅loaded聊天项查带model及autoload=false的props，服务实际行为仍由其实现决定。
						const props = await client.props({ model: model.id, signal: context.signal });
						// 把读取的chat_template用于thinking判断，同时保留容量优先级。
						return toPiModel(model, serverUrl, props, cachedContextWindow);
					}),
			);
			// 分类投影不额外探测模板/分类端点，只依目录及容量缓存。
			const refreshedClassifiers = selectable.map((model) =>
				// 每个selectable都提供分类能力描述，原生或回退由decisions标记选择。
				toPiClassifierModel(model, serverUrl, cachedContextWindows.get(model.id)),
			);
			// 完成所有投影后再次检查取消，取消则不开始这次新目录发布。
			if (context.signal.aborted) return;
			// 等待外层代次校验/持久动作/同步更新；本处不使用最终boolean，false也正常结束函数，拒绝仍传播。
			await context.publish({
				// 持久全种类数组（先聊天再分类）及当前Unix毫秒checkedAt，不持久原catalog状态/props。
				persist: { models: [...refreshed, ...refreshedClassifiers], checkedAt: Date.now() },
				// 同步回调只在publish准许时运行，新目录在这一步真正替换内存列表。
				update: () => {
					// 替换聊天列表为本次完整结果，没有就地修改旧数组。
					models = refreshed;
					// 同时替换分类列表；外层若持久失败不调用此update，但先前写入不保证能回滚。
					classifiers = refreshedClassifiers;
				},
			});
		},
		// 原始聊天流按api转交compat；参数由Provider推导，as只是编译期视图，不校验/转换options，也不消费或汇总事件。例返回流后由Agent继续读增量，真实HTTP在下游。
		stream: (model, context, options) => stream(model, context, options as ProviderStreamOptions | undefined),
		// 简化聊天选项直接委托streamSimple，返回实际事件流；不在本层做工具执行/自动多轮，思考档位由下游适配。
		streamSimple: (model, context, options) => streamSimple(model, context, options),
		// 分类回调接模型/状态问题/选项，返回下游ClassifierResult的Promise；例原生decisions走System One，其他api值走fallback，本处不完整验证目录能力。
		classify: (model, context, options) =>
			// 仅精确typesafe-system-one选原生实现，其余都转回退分类器；延迟对象在classify调用时导入实现，导入拒绝仍可传播。
			(model.api === "typesafe-system-one" ? decisionClassifier : fallbackClassifier).classify(
				// 原样传模型，认证/装配层可能已覆盖baseUrl，不再在此重建。
				model,
				// 原样传分类上下文，不执行聊天工具循环。
				context,
				// 透传分类选项，token/HTTP/取消策略属于下游实现。
				options,
			),
	};

	// 返回两个闭包入口，新实例之间的列表独立；provider供注册，setCatalog供管理命令立即同步。
	return { provider, setCatalog };
}
