// Radius有静态公开基线与按账户整体替换的动态聊天目录；Models.refresh提供存储快照、认证和判旧发布器，本文件决定恢复与联网步骤。
// Pi Messages延迟工厂只构造流入口，实际模块在stream调用时加载。
import { piMessagesApi } from "../api/pi-messages.lazy.ts";
// key认证器与OAuth延迟包装分别定义两种认证能力，构造它们不登录或读取凭据。
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
// 加载Radius OAuth方法的入口；下面闭包在首次login/refresh/toAuth操作时才使用，工厂本身不启动浏览器或回调端口。
import { loadRadiusOAuth } from "../auth/oauth/load.ts";
// type Provider只描述返回接口，运行时不会因此创建默认Models集合或持久存储。
import type { Provider } from "../models.ts";
// Model的pi-messages泛型约束聊天协议，不自动校验来自缓存的实际api/type字段。
import type { Model } from "../types.ts";
// 生成的Radius本地聊天目录只用作默认网关尚无账户目录时的基线，不手改生成表或数据JSON。
import { RADIUS_MODELS } from "./radius.models.ts";
// 导入共享配置转换/加载函数；只有loadRadiusGatewayConfig真正调用时才发HTTP，其他方法处理已给数据。
import {
	// 默认网关文字常量，供缺省选项与基线资格比较。
	DEFAULT_RADIUS_GATEWAY,
	// 从旧OAuth凭据的gatewayConfig浅筛并转换模型，不读取认证文件或刷新token。
	getRadiusModels,
	// 把已解析配置映成pi-messages模型并覆盖provider/baseUrl；只转换数据，不请求服务。
	getRadiusModelsFromConfig,
	// GET网关源根/v1/config、解JSON并浅筛模型，失败拒绝Promise；不是请求模型生成回答。
	loadRadiusGatewayConfig,
	// 只补缺省https并去末尾斜杠，不做URL解析、trim或可信域名检查。
	normalizeRadiusGatewayUrl,
} from "./radius-config.ts";

// 可选工厂配置接口，?允许省字段；它不是网关返回配置的运行时schema。
export interface RadiusProviderOptions {
	// 覆盖注册id，缺省radius；空字符串不会被??当成缺省。
	id?: string;
	// 覆盖展示名与OAuth登录名称，缺省Radius，不改变网关地址。
	name?: string;
	// 覆盖网关文字；自定义网关不自动继承公开基线，后续需缓存或刷新取得目录。
	gateway?: string;
}

/** Radius gateway provider with a persisted, dynamically refreshed catalog. */
// 构造Radius Provider，接可省id/name/gateway对象、返回pi-messages能力；先算默认基线，再用闭包保存账户目录，构造不联网。
// 例：默认实例先列公开模型；自定义http://localhost:8788先列[]。refresh先恢复缓存/旧凭据目录，允许时才抓配置并经publish更新；错误可拒绝，不承诺存储回滚。
export function radiusProvider(options: RadiusProviderOptions = {}): Provider<"pi-messages"> {
	// ??只在null/undefined回退radius，显式空id保留；模型provider后面统一绑定这个id。
	const id = options.id ?? "radius";
	// 名称同样空值回退，显式空字符串仍保留。
	const name = options.name ?? "Radius";
	// 规范网关文字并保存在闭包；这里没有new URL或发请求，非法文字可能到真正加载配置时才失败。
	const gateway = normalizeRadiusGatewayUrl(options.gateway ?? DEFAULT_RADIUS_GATEWAY);
	// 声明基线数组为pi-messages模型，接下来三元决定是否使用本地公开目录。
	// 把网关与同规则规范过的默认地址做严格字符串比较，不比较解析后的origin，也不忽略已有协议的大小写。
	// 默认网关取生成表的值并浅展开每项，只覆盖provider为本实例id；嵌套字段仍共享，模型原baseUrl不改。
	// 网关文字不同则用空基线，避免把公开Radius目录当自定义网关的账户允许列表。
	const baselineModels: Model<"pi-messages">[] =
		gateway === normalizeRadiusGatewayUrl(DEFAULT_RADIUS_GATEWAY)
			? Object.values(RADIUS_MODELS).map((model) => ({ ...model, provider: id }))
			: [];
	// Gateway catalog for this account. Radius org owners can disable models, so once known it replaces
	// the shipped baseline instead of overlaying it. The baseline only covers the time before any catalog exists.
	// undefined表示还不知道动态目录；[]表示已知道该账户没有模型。两者在后面的??回退中不同，空数组也替换全部基线。
	let dynamicModels: Model<"pi-messages">[] | undefined;
	// 每个实例构造独立的延迟流能力对象，此刻不请求Pi Messages。
	const streams = piMessagesApi();

	// 手写返回Provider对象，没有走createProvider的静态/动态叠加算法，也未在对象上暴露baseUrl字段。
	return {
		// 属性简写返回本实例注册id。
		id,
		// 属性简写返回本实例展示name。
		name,
		// 列出两种认证方式，不代表当前环境已经配置任一种凭据。
		auth: {
			// 构造key规则：非空存储key优先，否则查询RADIUS_API_KEY；读取发生在认证resolve时。
			apiKey: envApiKeyAuth("Radius API key", ["RADIUS_API_KEY"]),
			// OAuth外观立即有name，load箭头以后才加载绑定name/gateway的实现；首次加载Promise由lazyOAuth闭包缓存，不在这里执行登录。
			oauth: lazyOAuth({ name, load: () => loadRadiusOAuth({ name, gateway }) }),
		},
		// 同步读当前数组引用；dynamicModels为undefined才用基线，动态[]不会恢复公开模型。这个getter不加载网络或深复制模型。
		getModels: () => dynamicModels ?? baselineModels,
		// 刷新回调接Models给的context，返回Promise<void>；可能读发布存储/请求配置/更新闭包，失败继续拒绝，由外层refresh收集。
		refreshModels: async (context) => {
			// 保存本阶段开始前的持久目录快照，不在这里自行读取磁盘或决定全局存储位置。
			const stored = context.stored;
			// 有缓存外壳即恢复，包括models为空的缓存；不能仅靠列表非空决定是否有账户目录。
			if (stored) {
				// 只按provider精确过滤，再as声明pi-messages聊天数组；未在此验证type/api或所有模型字段，断言不转换缓存内容。
				const restored = stored.models.filter((model) => model.provider === id) as Model<"pi-messages">[];
				// 恢复也必须等待publish接受，不能先改闭包再判断新旧请求。
				if (
					// publish由Models绑定本家代次/信号；这里只给update，不带persist，不重写已存缓存；false或拒绝的意义不同。
					!(await context.publish({
						// 注册同步状态更新函数，构造对象时尚未执行，发布器确认有效后才调用。
						update: () => {
							// 把恢复数组整体设为动态目录，不与基线合并；实际Models发布器先判旧才运行这行。
							dynamicModels = restored;
						},
					}))
				) {
					// publish正常返回false时结束本轮刷新，避免失效请求继续抓网络；若发布Promise拒绝则直接向外传播。
					return;
				}
			}

			// Import catalogs cached by the pre-ModelsStore Radius implementation.
			// 只有没有ModelsStore缓存且有效凭据带oauth标签才兼容旧目录；已有空目录也不走旧凭据回退。
			if (!stored && context.credential?.type === "oauth") {
				// 从凭据的旧gatewayConfig浅筛模型并绑定当前id，不读取用户凭据文件，也不刷新token。
				const legacy = getRadiusModels(id, context.credential);
				// 旧目录必须非空才迁入；空/坏旧配置得到[]时不发布或替换当前动态状态，之前已有的动态目录也保留，这与明确存储的空目录不同。
				if (legacy.length > 0) {
					// 迁移也等待发布接受，下面取反意味着正常false就早退。
					if (
						// 把持久目录动作与同步闭包更新一起交发布器，实际Models先写存储、再判旧、再执行update，非跨两者事务回滚。
						!(await context.publish({
							// 要持久化的是旧模型数组与当前检查毫秒时间；这里不是旧缓存原本生成时间，也不设过期阈值。
							persist: { models: legacy, checkedAt: Date.now() },
							// 同步更新回调仅在发布器允许时执行，不在传对象这一刻调用。
							update: () => {
								// 把旧目录完整设为动态目录，不覆盖生成文件。
								dynamicModels = legacy;
							},
						}))
					) {
						// 旧目录发布返回false时停止，不继续联网；存储/取消等异常可直接拒绝刷新Promise。
						return;
					}
				}
			}

			// 只有恢复/兼容步骤之后才拦住联网：allowNetwork为false或signal已取消均直接返回；缓存发布仍可能在之前发生。
			if (!context.allowNetwork || context.signal.aborted) return;
			// OAuth取access作Bearer key，其他可选凭据取key，无凭据得到undefined；这里不查询环境或调用OAuth刷新。
			const apiKey = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
			// 真正GET网关根/v1/config并等待配置；传信号与上面key，网络/HTTP/解析错误拒绝，先前恢复目录不会因此被清空。
			const config = await loadRadiusGatewayConfig(gateway, apiKey, context.signal);
			// 请求完成后再次检查取消，已取消就不转换或发起最终发布；远端是否停止不由这行保证。
			if (context.signal.aborted) return;
			// 将浅筛后的配置生成新模型对象，api固定pi-messages、provider当前id、baseUrl来自配置，额外/嵌套字段沿helper规则保留。
			const refreshed = getRadiusModelsFromConfig(id, config);
			// 等待最终发布；这里不读取它的boolean结果，返回false后也结束本回调，拒绝仍传播，真正的内存更新须由publish执行update。
			await context.publish({
				// 持久化最新整个目录和当前checkedAt毫秒时间；空models也是有效结果，可清空账户可用列表。
				persist: { models: refreshed, checkedAt: Date.now() },
				// 给发布器同步更新闭包，不能async地把迟到赋值放到发布检查之外。
				update: () => {
					// 发布成功接受后整体替换账户目录，因此组织禁用的静态模型不会通过叠加基线重现。
					dynamicModels = refreshed;
				},
			});
		},
		// 专属参数流入口原样转发model/规范上下文/选项给延迟能力，调用时才触发实现加载；网关模型地址取model.baseUrl，不由这里重写。
		stream: (model, context, streamOptions) => streams.stream(model, context, streamOptions),
		// 统一参数流同样直接代理，不在本层额外做凭据解析或目录刷新；加载/协议错误沿真实适配器流规则处理。
		streamSimple: (model, context, streamOptions) => streams.streamSimple(model, context, streamOptions),
	};
}
