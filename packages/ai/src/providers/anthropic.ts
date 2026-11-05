// Anthropic供应商装配：静态聊天目录、Messages延迟流、订阅OAuth，以及按优先级解析的key/授权头/工作负载联邦环境配置。
// 先导入轻量工厂，实际Messages模块在流调用时才加载。
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
// OAuth外观先提供展示元数据，首次调用具体认证方法时才加载流程。
import { lazyOAuth } from "../auth/helpers.ts";
// 这里只保存加载函数，导入它不等于开始登录或换token。
import { loadAnthropicOAuth } from "../auth/oauth/load.ts";
// API key类接口也可返回授权头或仅供应商环境配置，不要求每条分支都产出apiKey。
import type { ApiKeyAuth } from "../auth/types.ts";
// 环境变量名集中定义，下面按明确优先级逐项查宿主，不靠API字符串猜变量。
import {
	// 普通API key变量。
	ANTHROPIC_API_KEY_ENV,
	// 独立Bearer授权头变量，区别于会触发OAuth请求形状的key。
	ANTHROPIC_AUTH_TOKEN_ENV,
	// 联邦认证规则标识。
	ANTHROPIC_FEDERATION_RULE_ID_ENV,
	// 身份token文件路径，仅在此作为配置字符串收集。
	ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
	// OAuth形态key变量。
	ANTHROPIC_OAUTH_TOKEN_ENV,
	// 联邦配置必需的组织标识。
	ANTHROPIC_ORGANIZATION_ID_ENV,
	// 联邦可选服务账户标识。
	ANTHROPIC_SERVICE_ACCOUNT_ID_ENV,
	// 联邦可选工作区标识。
	ANTHROPIC_WORKSPACE_ID_ENV,
} from "../env-api-keys.ts";
// 实际构造助手和仅用于编译期约束的Provider类型。
import { createProvider, type Provider } from "../models.ts";
// 字符串字典类型描述请求作用域环境配置，不是进程环境的可写代理。
import type { ProviderEnv } from "../types.ts";
// 只读生成的聊天目录，不编辑生成包装或其data。
import { ANTHROPIC_MODELS } from "./anthropic.models.ts";

// 用途：无参数创建Anthropic的API key类认证策略，返回login/resolve对象；构造不弹窗、不读环境，也不发请求。
// 例宿主提供ANTHROPIC_AUTH_TOKEN时，resolve返回Bearer头而非apiKey；没有key/头时才尝试联邦配置。登录只收集待保存凭证，实际存储由Models/宿主负责。
function anthropicApiKeyAuth(): ApiKeyAuth {
	// 每次调用创建新策略对象，回调等宿主实际操作时才运行。
	return {
		// 登录方式的展示名称。
		name: "Anthropic API key",
		// 用途：输入带信号和prompt的规范交互对象，问一次secret并返回api_key凭证；例如输入abc得到{type:"api_key",key:"abc"}，不现场验证或保存。
		// 提示前后均检查取消，prompt/信号异常使Promise拒绝；原字符串不trim或检查非空。
		login: async (interaction) => {
			// 已取消时不启动输入框。
			interaction.signal.throwIfAborted();
			// 异步等宿主返回秘密输入，不在此输出密钥到日志。
			const key = await interaction.prompt({ type: "secret", message: "Enter Anthropic API key" });
			// 输入期间取消，即便已有答案也拒绝返回凭证。
			interaction.signal.throwIfAborted();
			// key属性简写复用输入值；这里只创建凭证数据。
			return { type: "api_key", key };
		},
		// 用途：输入宿主ctx、可选存储凭证及signal，异步返回请求认证/环境来源或undefined；例有Bearer环境token时返回Authorization头。
		// 顺序为存储真值key→authToken头→OAuth环境key→普通环境key→联邦三项必需/两项可选配置。只探测字符串真值，不验证授权、不读身份文件、不进行联邦交换；ctx可有I/O或拒绝，异常不在此吞掉。
		resolve: async ({ ctx, credential, signal }) => {
			// 一开始就检查取消，存储key快路径也不会绕过它。
			signal.throwIfAborted();
			// 存储key优先；空串是假值，继续查环境，空白串为真值且不trim。
			if (credential?.key) {
				// 同时透传存储env，不在这里把key推断成Bearer或OAuth模式。
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			}

			// 探测独立Bearer token环境来源，先于OAuth和普通key。
			const authToken = await ctx.env(ANTHROPIC_AUTH_TOKEN_ENV);
			// 每次异步环境读取后响应取消。
			signal.throwIfAborted();
			// 真值token就使用，不在此检查token格式或远端有效性。
			if (authToken) {
				// 明确放到HTTP头，避免把此变量当作会自动走OAuth请求形状的apiKey。
				return {
					// 模板字符串仅拼Bearer文本，不请求认证服务。
					auth: { headers: { Authorization: `Bearer ${authToken}` } },
					// 来源用变量名，不把秘密token当展示标签。
					source: ANTHROPIC_AUTH_TOKEN_ENV,
				};
			}

			// 顺序探测两种key来源，先OAuth环境token，再普通API key；首个真值直接返回。
			for (const envVar of [ANTHROPIC_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV]) {
				// 每轮只读当前变量，不并发查询后面的备用来源。
				const apiKey = await ctx.env(envVar);
				// 等待期间取消则不使用刚得到的值。
				signal.throwIfAborted();
				// 仍统一放apiKey字段，实际适配器再按真实key内容等条件准备认证和请求形状。
				if (apiKey) return { auth: { apiKey }, source: envVar };
			}

			// Workload identity federation: the Anthropic SDK exchanges the identity
			// token for a short-lived access token and refreshes it itself. Last in
			// line so keys and ANTHROPIC_AUTH_TOKEN keep winning, as in the SDK. The
			// ids are provider config rather than auth, so they travel in `env`.
			// 前述来源都缺失才收集联邦环境；ProviderEnv仅静态要求字符串值，不自动写process.env。
			const federation: ProviderEnv = {};
			// 三项必需配置逐一读取，某项缺少立即返回未配置，不继续凑齐部分对象。
			for (const envVar of [
				// 哪条联邦规则用于交换。
				ANTHROPIC_FEDERATION_RULE_ID_ENV,
				// 组织身份配置。
				ANTHROPIC_ORGANIZATION_ID_ENV,
				// 身份token文件路径，不在本函数读文件或验证JWT。
				ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
			]) {
				// 查询宿主来源，未自动叠加credential.env字段。
				const value = await ctx.env(envVar);
				// 读取后检查取消，与前面的key探测一致。
				signal.throwIfAborted();
				// 假值表示必需配置不足；不trim，因此空白字符串仍可通过条件。
				if (!value) return undefined;
				// 动态方括号以变量名作键，把值写入本次新建配置字典。
				federation[envVar] = value;
			}
			// 服务账户和工作区是可选项；缺少不使联邦配置判为未配置。
			for (const envVar of [ANTHROPIC_SERVICE_ACCOUNT_ID_ENV, ANTHROPIC_WORKSPACE_ID_ENV]) {
				// 逐项取可选字段，不调用身份服务。
				const value = await ctx.env(envVar);
				// 异步读取结束再响应取消。
				signal.throwIfAborted();
				// 仅真值加入配置，缺省或空串不产生对应键。
				if (value) federation[envVar] = value;
			}
			// 空auth表示由环境配置承担认证；实际Messages适配器把env转成SDK联邦配置，SDK后续读取文件、交换及刷新token。
			return { auth: {}, env: federation, source: "workload identity federation" };
		},
	};
}

// 用途：无参数创建Anthropic聊天供应商，返回anthropic-messages协议Provider；装目录、两类认证和延迟流，不登录、换token或刷新远端。
// 例models.setProvider(anthropicProvider())后getAuth才按认证策略取材料，models.streamSimple再交真实Messages实现；直接Provider流不会自动执行Models的凭证解析。
export function anthropicProvider(): Provider<"anthropic-messages"> {
	// 每次创建新供应商对象和该对象的认证器，生成模型项仍共享原引用。
	return createProvider({
		// 稳定供应商/凭证键。
		id: "anthropic",
		// 展示名称。
		name: "Anthropic",
		// 端点元数据，不在构造时连接该地址。
		baseUrl: "https://api.anthropic.com",
		// 同时提供普通/环境认证与订阅OAuth，由上层选择和编排。
		auth: {
			// 创建本文件的自定义策略，支持Bearer与联邦等非普通key路径。
			apiKey: anthropicApiKeyAuth(),
			// 延迟外观只先暴露登录方式信息。
			oauth: lazyOAuth({
				// OAuth流程展示名。
				name: "Anthropic (Claude Pro/Max)",
				// 声明订阅流程，不代表构造时已经核验套餐权益。
				isSubscription: true,
				// 保存加载器引用，到认证方法真正调用时才加载具体flow。
				load: loadAnthropicOAuth,
			}),
		},
		// 把生成聊天表取值成新数组，不克隆每个模型对象。
		models: Object.values(ANTHROPIC_MODELS),
		// 创建延迟流能力，模块及SDK到实际流调用时才加载。
		api: anthropicMessagesApi(),
	});
}
