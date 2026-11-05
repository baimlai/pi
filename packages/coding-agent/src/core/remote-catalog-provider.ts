// 给内置提供商加远端模型目录：先恢复持久缓存，再按联网策略刷新；这里请求目录元数据，不生成聊天回复。
import {
	// AnyModel 覆盖聊天、图片和分类模型。
	type AnyModel,
	// 读取模型类别，旧目录没有 type 时默认为 chat。
	getModelType,
	// 按类别判断，同时让 TypeScript 收窄模型类型。
	isModelType,
	// 目录缓存包含 models、检查时间与 ETag 等信息。
	type ModelsStoreEntry,
	// ModelType 限制为客户端支持的能力类别。
	type ModelType,
	// Provider 对象提供目录、认证和实际请求能力，包装器只替换其中部分方法。
	type Provider,
	// 刷新上下文包含缓存、联网/强制标记、凭证、取消信号与发布入口。
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
// 程序版本用于目录请求的 User-Agent，不从此处同步修改版本文件。
import { VERSION } from "../config.ts";
// 管理请求的有限重试辅助；它不用于重试聊天模型生成。
import { fetchWithRetry } from "../utils/management-http.ts";
// 统一生成 Pi 的请求身份说明。
import { getPiUserAgent } from "../utils/pi-user-agent.ts";

// 默认目录站点，不是默认聊天模型的推理地址。
const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
// 每次 HTTP 尝试的超时为四秒；helper 默认还可重试，所以不是总计最多四秒。
const REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS = 4_000;
/** 普通目录的自动检查间隔为四小时，单位毫秒；force 可跳过间隔，但不能越过 allowNetwork=false。 */
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
/**
 * Model types this client can consume. Sent as `?types=` so the catalog server
 * returns the full-type shard instead of the chat-only one served to clients
 * that predate model types. A server that ignores the parameter still returns
 * the chat-only shard, which this client handles unchanged.
 */
/** 告诉目录服务需要 chat/image/classifier；readonly 是类型限制，没有对数组做运行时冻结。 */
export const REMOTE_CATALOG_MODEL_TYPES: readonly ModelType[] = ["chat", "image", "classifier"];

/** 筛选远端的已知类别；缺 type 当作旧聊天模型，未知未来类别跳过，不因它让整份目录失败。 */
function isSupportedModelType(model: { type?: unknown }): boolean {
	return (
		// 允许旧格式没有 type；这里不等于验证了整个模型对象。
		model.type === undefined ||
		// 网络输入边界需要检查真实字段；as 只让 includes 接受已判断为 string 的值，不执行转换。
		(typeof model.type === "string" && REMOTE_CATALOG_MODEL_TYPES.includes(model.type as ModelType))
	);
}

/** 合并基线与动态目录；同“类别 + ID”动态项覆盖基线，聊天 a 与图片 a 仍各自保留。 */
function mergeModels<TModel extends AnyModel>(baseline: readonly TModel[], dynamic: readonly TModel[]): TModel[] {
	// Map 的键不包含 provider，因为此包装器处理的是同一家提供商的目录。
	const merged = new Map<string, TModel>();
	// \0 在模板中是空字符分隔，避免类别与 ID 直接拼接产生歧义；后 set 覆盖同键的值但保留首次键顺序。
	for (const model of [...baseline, ...dynamic]) merged.set(`${getModelType(model)}\0${model.id}`, model);
	// 展开 values 为新数组，没有深复制每个模型。
	return [...merged.values()];
}

/** 接受数组、{ models: 数组 } 或按键存模型的对象；只做有限边界筛选，并非完整模型 schema 校验。 */
function parseCatalog(providerId: string, value: unknown): AnyModel[] {
	// response.json 的结果不可信，因此参数是 unknown，先检查实际根结构。
	const entries = Array.isArray(value)
		? // 根本身是数组就直接作为候选项列表。
			value
		: // 根是非 null 对象且 models 是数组时使用它。
			typeof value === "object" && value !== null && "models" in value && Array.isArray(value.models)
			? // 此分支由上面的检查保证 value.models 可作为数组使用。
				value.models
			: // 其他非 null 对象用它的属性值作为候选列表。
				typeof value === "object" && value !== null
				? // 例如 { a: 模型A, b: 模型B } 转为 [模型A, 模型B]。
					Object.values(value)
				: // 字符串、数字、null 等根值没有候选列表。
					undefined;
	// 根结构无法使用时明确抛错；空数组却合法，不会进入这个分支。
	if (!entries) throw new Error(`Invalid model catalog for provider "${providerId}"`);
	// 下面串起筛选与映射，不修改 response.json 的原始根对象。
	return (
		entries
			// 类型谓词告诉 TS 剩下是带 id 的对象；实际上这里只检查 id 存在，没有检查它一定是字符串或其他模型必需字段。
			.filter(
				(entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && "id" in entry,
			)
			// 再丢掉客户端不认识的模型类别。
			.filter(isSupportedModelType)
			// 浅复制并强制标为当前提供商；as AnyModel 是断言，不能替代完整输入校验。
			.map((model) => ({ ...model, provider: providerId }) as AnyModel)
	);
}

/** Read a successful pi.dev catalog response. A missing or invalid Last-Modified header is 0. */
/** 解析成功响应：读 JSON 目录、Last-Modified 和 ETag；时间无法解析时用 0，不会自动重试 JSON 解析。 */
async function readCatalog(
	// 给模型条目统一写入此提供商 ID。
	providerId: string,
	// 调用者已处理 HTTP 状态，本函数负责读取响应内容。
	response: Response,
	// Promise 的结果是对象类型，包含目录、毫秒时间戳和可缺失校验标记。
): Promise<{ models: AnyModel[]; lastModified: number; etag: string | undefined }> {
	// Date.parse 得到毫秒时间戳；缺头时解析空串得到 NaN。
	const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
	return {
		// await 等 JSON 读取，再按有限目录规则筛选；JSON 错误会向上拒绝。
		models: parseCatalog(providerId, await response.json()),
		// Number.isNaN 专门判断非法日期结果，合法的 0 仍保留。
		lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
		// ETag 作为不透明字符串原样保存，包括引号；没有该头就用 undefined。
		etag: response.headers.get("etag") ?? undefined,
	};
}

/** Whether a pi.dev catalog is newer than the model data shipped with pi. */
/** 本地代次未知就允许远端；本地代次已知时，只有明确且更新的 Last-Modified 才胜出。 */
function isNewer(lastModified: number | undefined, localGeneratedAt: number | undefined): boolean {
	// 严格大于才算更新，相同时间不会替换随包目录；例如本地 200、远端 100 返回 false。
	return localGeneratedAt === undefined || (lastModified !== undefined && lastModified > localGeneratedAt);
}

/** 从缓存挑可覆盖本地代次的远端模型；不合条件得空覆盖列表，内置目录仍由包装器保留。 */
function remoteModels(entry: ModelsStoreEntry | undefined, localGeneratedAt: number | undefined): readonly AnyModel[] {
	// entry 不存在时短路；不要把“空覆盖”误解为“提供商没有任何内置模型”。
	return entry && isNewer(entry.lastModified, localGeneratedAt) ? entry.models : [];
}

/** 请求一家提供商的远端目录，可带 ETag；例：types=chat,image,classifier，命中缓存服务器可返回 304。 */
function requestCatalog(
	// 提供商名会进行 URL 路径编码，不能直接拼未编码的任意 ID。
	providerId: string,
	// 允许测试或宿主指定独立目录站点。
	catalogBaseUrl: string,
	// 调用者 signal 同时参与管理请求的每轮重试。
	signal: AbortSignal,
	// validator 通常是上次 ETag；没有已缓存正文时不应依赖 304。
	validator?: string,
	// 返回 Response，由调用者决定 304/404/失败/成功该如何处理。
): Promise<Response> {
	// 路径以 / 开头，从站点根解析，不是在 catalogBaseUrl 的子路径后简单追加。
	const url = new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, catalogBaseUrl);
	// join 把类别数组变成逗号字符串，URL 工具负责查询编码。
	url.searchParams.set("types", REMOTE_CATALOG_MODEL_TYPES.join(","));
	// 管理请求 helper 默认有限即时重试，不是 agent 语义层的重试循环。
	return fetchWithRetry(
		// URL 对象可直接作为 fetch 输入。
		url,
		{
			// 这一组只是目录 HTTP 请求头，不含聊天模型的 API key。
			headers: {
				// 期望目录以 JSON 返回。
				accept: "application/json",
				// 带当前 Pi 版本帮助服务端区分客户端能力。
				"User-Agent": getPiUserAgent(VERSION),
				// 条件对象展开：有非空 validator 才发 If-None-Match。
				...(validator ? { "if-none-match": validator } : {}),
			},
			// 同名属性简写，传递外部取消信号。
			signal,
		},
		// 每次尝试单独限制四秒，总预算未在此额外设置。
		{ attemptTimeoutMs: REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS },
	);
}

/** Replaces the catalog with a credential-specific model list. */
/** 个性化目录回调：用目录和刷新上下文计算当前凭证可见的模型，可异步请求其专属服务。 */
export type PersonalizeCatalog = (
	// 输入数组只读，不承诺每个模型对象已深冻结。
	catalog: readonly AnyModel[],
	// 回调可通过 context 取得当前凭证、信号及发布协议。
	context: RefreshModelsContext,
	// 异步返回整份个性化目录，不是返回给原目录追加的几条差异。
) => Promise<readonly AnyModel[]>;

/** Add a persisted pi.dev catalog overlay to a static built-in provider. */
/** 包装内置提供商，缓存目录作为覆盖层；例：内置有 A/B、远端更新 A 并添加 C，枚举得到更新 A、B、C。 */
export function withRemoteCatalog(
	// 被包装对象继续提供认证和推理能力。
	provider: Provider,
	// 默认访问 pi.dev，传自定义地址可切换目录来源。
	catalogBaseUrl: string = DEFAULT_CATALOG_BASE_URL,
	// 随包模型目录的生成时间，用来避免旧缓存压过新内置数据。
	localGeneratedAt?: number,
	// 返回新的 Provider 外观，构造包装器时还没有发网络请求。
): Provider {
	// 闭包保存当前远端覆盖；let 允许发布成功时换成新数组。
	let dynamicModels: readonly AnyModel[] = [];

	// 对象展开保留未覆盖的字段和方法，下面显式替换目录及 refreshModels。
	return {
		// 这是浅展开，不是深复制 provider，也不会另外调用其原 refreshModels。
		...provider,
		// 聊天目录入口只混入 chat 类型的动态模型。
		getModels: () =>
			// 同键远端项覆盖，内置未匹配项保留。
			mergeModels(
				// 每次枚举都从底层当前聊天目录取基线。
				provider.getModels(),
				// isModelType 既筛选运行时值，也给泛型推导聊天模型类型。
				dynamicModels.filter((model) => isModelType(model, "chat")),
			),
		// 全类型入口优先使用底层 getAllModels，旧提供商没有它才退回聊天目录。
		getAllModels: () => mergeModels(provider.getAllModels?.() ?? provider.getModels(), dynamicModels),
		// 真正刷新发生在这一异步回调，而不是调用 withRemoteCatalog 时。
		refreshModels: async (context) => {
			// stored 是本次刷新开始时读取的持久快照。
			const stored = context.stored;
			// 先按生成时间选缓存，再排除不属于当前 provider 的条目。
			const restored = remoteModels(stored, localGeneratedAt).filter((model) => model.provider === provider.id);
			// 恢复也必须经过 publish，避免过期刷新直接写闭包。
			if (
				// publish 内部检查刷新代次/信号，false 表示此结果没有被当前刷新采纳。
				!(await context.publish({
					// update 是同步发布动作；没有 persist 就不要求重写缓存全文。
					update: () => {
						// 只有发布入口允许执行该回调，才更新同步枚举可见的覆盖列表。
						dynamicModels = restored;
					},
				}))
			) {
				// 恢复发布未被采纳就结束旧任务，不再发远端请求。
				return;
			}
			// 已先尝试经 publish 恢复缓存；该入口本身也检查取消/代次，此处再确认是否允许继续联网。
			if (!context.allowNetwork || context.signal.aborted) return;
			// Skip the request if pi.dev was checked less than REMOTE_CATALOG_REFRESH_INTERVAL_MS ago.
			// An entry without lastModified (saved by an older pi, or after a failed first request) is
			// always refetched: remoteModels() ignores it, so waiting would leave the overlay empty.
			// 以下条件必须同时满足才使用四小时新鲜窗口。
			if (
				// force=true 绕过时间窗口，但上面的 allowNetwork 检查已经执行。
				!context.force &&
				// 必须知道上次完成检查的时间。
				stored?.checkedAt !== undefined &&
				// 必须有 Last-Modified 字段，首次失败且还没有它时不能仅因 checkedAt 新就等待四小时。
				stored.lastModified !== undefined &&
				// 用 Date.now 的毫秒差与四小时间隔比较；不是根据目录模型数量决定。
				Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS
			) {
				// 缓存够新，当前恢复出的覆盖直接继续使用。
				return;
			}

			// Only revalidate when a cached body backs the validator, so a 304 can never
			// leave the overlay empty.
			// 仅缓存正文非空才复用 ETag；这只确认有正文，不保证该正文比当前内置目录更新。
			const validator = stored && stored.models.length > 0 ? stored.etag : undefined;
			// await 请求响应，HTTP 状态留给下面各分支处理。
			const response = await requestCatalog(provider.id, catalogBaseUrl, context.signal, validator);
			// 网络返回后再检查取消，避免过期任务继续解析/发布。
			if (context.signal.aborted) return;
			// 记录这次响应检查的毫秒时间，不与远端 Last-Modified 混为同一个含义。
			const checkedAt = Date.now();
			// Unchanged: dynamicModels already holds the stored overlay, so only the
			// freshness window moves.
			// 304 说明远端认可缓存版本；必须同时确有 stored。
			if (response.status === 304 && stored) {
				// 只推进检查时间，不替换当前 dynamicModels；缓存正文及 ETag 原样保留。
				await context.publish({ persist: { ...stored, checkedAt } });
				// 这一分支不用再读 JSON 正文。
				return;
			}
			// 404/501 表示目录端点不存在或不支持，按本代码的特殊缓存策略处理。
			if (response.status === 404 || response.status === 501) {
				// 只发布持久条目，不在这一分支直接改当前闭包覆盖数组。
				await context.publish({
					// persist 是整个新缓存条目，不是对 JSON 文件做某个字段的原地补丁。
					persist: {
						// 已有正文先保留，没有则存空模型数组。
						...(stored ?? { models: [] }),
						// 把本次检查计入刷新间隔。
						checkedAt,
						// Last-Modified 标为 0，下次恢复时通常不会比有生成时间的内置目录新。
						lastModified: 0,
						// 明确清除 ETag，不沿用已不存在端点的验证标记。
						etag: undefined,
					},
				});
				// 此类状态按已处理返回，不抛 HTTP 错误。
				return;
			}
			// 304/404/501 已先处理，其他非成功状态走错误分支。
			if (!response.ok) {
				// Transient failure: the cached body and its validator stay valid, so keep the
				// etag and let the next refresh revalidate instead of downloading the catalog.
				// 保留已有正文和 ETag，仅记录 checkedAt；首次失败的空条目仍没有 Last-Modified。
				await context.publish({ persist: { ...(stored ?? { models: [] }), checkedAt } });
				// 保存尝试记录之后仍抛错，让刷新调用方看见提供商及 HTTP 状态。
				throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
			}
			// 成功响应才读取目录 JSON 和版本头。
			const catalog = await readCatalog(provider.id, response);
			// 读完响应正文后可能才收到取消，再检查一次。
			if (context.signal.aborted) return;
			// 对象展开把 models/lastModified/etag 与本次 checkedAt 组成完整条目。
			const entry: ModelsStoreEntry = { ...catalog, checkedAt };
			// 远端即使响应成功，也只有比随包目录更新才用于动态覆盖。
			const published = remoteModels(entry, localGeneratedAt);
			// 由发布入口串行化持久写入，并检查代次后再应用同步 update。
			await context.publish({
				// 缓存保存完整响应，不只保存最终有资格覆盖内置的那部分。
				persist: entry,
				// 持久步骤之后且仍有效，才进入此同步更新；不是写入与更新的自动回滚事务。
				update: () => {
					// 下一次枚举从闭包取得新覆盖。
					dynamicModels = published;
				},
			});
		},
	};
}

/**
 * Like `withRemoteCatalog`, but on each network refresh the catalog (built-in models plus a newer
 * pi.dev catalog) is passed through `personalize` and the result is saved. The saved entry holds
 * the personalized list, not the pi.dev catalog, and replaces the catalog, including offline.
 * The refresh interval and etag revalidation are skipped. An empty list (nothing saved yet, or an
 * empty catalog saved by an older pi after a failed or missing pi.dev catalog) falls back to the
 * built-in models.
 */
/** 个性化目录替换模式：允许联网且目录请求/解析通过后调用 personalize，404/501 时以内置候选继续；非空保存结果离线也替代整份基线。 */
export function withPersonalizedCatalog(
	// 原提供商仍负责认证及实际推理。
	provider: Provider,
	// 例如按账户权限过滤候选模型；这个回调的实现决定具体额外操作。
	personalize: PersonalizeCatalog,
	// 仍从可指定的目录站点取得公共候选目录。
	catalogBaseUrl: string = DEFAULT_CATALOG_BASE_URL,
	// 只有比这份内置代次新的公共远端条目才进入候选合并。
	localGeneratedAt?: number,
): Provider {
	// 闭包保存个性化结果，不与上一个普通覆盖包装器共用变量。
	let personalModels: readonly AnyModel[] = [];
	// 每次取内置全类型目录，缺少新入口时兼容旧聊天提供商。
	const builtinModels = (): readonly AnyModel[] => provider.getAllModels?.() ?? provider.getModels();
	// 非空个性化目录是替换整份目录；空结果退回内置，而不是表示当前账号没有任何模型。
	const getAllModels = (): readonly AnyModel[] => (personalModels.length > 0 ? personalModels : builtinModels());

	// 返回另一份 Provider 外观，构造时不发网络请求。
	return {
		// 保留底层未覆盖的字段和推理方法。
		...provider,
		// 聊天入口从最终全类型列表中筛 chat。
		getModels: () => getAllModels().filter((model) => isModelType(model, "chat")),
		// 同名属性简写，使用上面的闭包函数。
		getAllModels,
		// 该模式有独立刷新逻辑，不使用四小时间隔与 ETag 复验。
		refreshModels: async (context) => {
			// 先恢复已保存的个性化结果，仅保留当前提供商条目；不以 Last-Modified 再筛这份结果。
			const restored = (context.stored?.models ?? []).filter((model) => model.provider === provider.id);
			// 恢复也必须经过刷新代次的发布闸门。
			if (
				// await 等待发布决定，false 表示任务已过期而未采纳。
				!(await context.publish({
					// 恢复阶段不要求 persist，只有闭包更新。
					update: () => {
						// 把账户专属目录发布为本实例同步可见值。
						personalModels = restored;
					},
				}))
			) {
				// 未采纳则终止，不让旧任务再执行个性化回调。
				return;
			}
			// 离线时只用恢复结果或内置回退，不执行后面网络与 personalize。
			if (!context.allowNetwork || context.signal.aborted) return;

			// 不传 validator，每次联网都请求目录，不等待普通目录的刷新间隔。
			const response = await requestCatalog(provider.id, catalogBaseUrl, context.signal);
			// 等响应时可能取消，后续步骤前检查。
			if (context.signal.aborted) return;
			// 默认没有远端补充目录。
			let remote: readonly AnyModel[] = [];
			// 目录端点缺失/未实现时仍可用内置候选继续个性化。
			if (response.status !== 404 && response.status !== 501) {
				// 其他 HTTP 错误直接拒绝；这里没有普通模式那条保存 checkedAt 的失败分支。
				if (!response.ok) throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
				// 成功响应读取内容和远端修改时间。
				const catalog = await readCatalog(provider.id, response);
				// 只有远端更新才补进公共候选，否则仍以随包目录为准。
				if (isNewer(catalog.lastModified, localGeneratedAt)) remote = catalog.models;
			}
			// 先合并公共候选，再交给 personalize，实际保存的是它返回的列表。
			const personalized = await personalize(mergeModels(builtinModels(), remote), context);
			// 个性化可能异步耗时，完成后先检查取消。
			if (context.signal.aborted) return;
			// 通过统一发布入口写缓存并更新闭包。
			await context.publish({
				// 这里保存个性化结果及本地检查时间，不保存公共目录的 ETag/Last-Modified。
				persist: { models: personalized, checkedAt: Date.now() },
				// publish 校验后执行同步更新。
				update: () => {
					// 后续枚举使用新个性化结果；空数组依照 getAllModels 规则回退内置。
					personalModels = personalized;
				},
			});
		},
	};
}
