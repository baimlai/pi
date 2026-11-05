// Bedrock供应商装配及认证配置探测：收集bearer token/profile或识别若干AWS环境条件；真正SDK认证与请求在延迟Converse适配器中完成。
// 轻量入口可延迟加载Node专用AWS实现，构造供应商时不访问AWS。
import { bedrockConverseStreamApi } from "../api/bedrock-converse-stream.lazy.ts";
// API key类认证接口也支持profile和环境角色，不要求结果一定有apiKey。
import type { ApiKeyAuth } from "../auth/types.ts";
// createProvider是运行值，Provider是编译期供应商契约。
import { createProvider, type Provider } from "../models.ts";
// 静态聊天目录来自生成包装，此处不修改生成文件或底层data。
import { AMAZON_BEDROCK_MODELS } from "./amazon-bedrock.models.ts";

/**
 * Bedrock accepts a bearer token or the AWS SDK's default credential chain.
 * The login flow can store a token/profile choice; resolve also detects ambient
 * AWS credentials without copying them into pi's credential store.
 */
// 共享认证策略对象；构造对象不执行login或resolve，宿主之后按需调用。
const bedrockAuth: ApiKeyAuth = {
	// 界面展示认证方式，不表示凭证已验证。
	name: "AWS credentials or bearer token",
	// 用途：通过交互收集bearer token、AWS profile或确认已有链，返回待保存api_key凭证。例选aws-profile并填work，返回env:{AWS_PROFILE:"work"}。
	// 先检查取消、选择方法、再次检查，再询问对应内容；只返回配置，不验证token/profile、不运行AWS登录、不写存储。后续prompt没有本函数统一的收尾取消检查。
	login: async (interaction) => {
		// 上层规范化为必需信号；已取消就拒绝，不弹选择框。
		interaction.signal.throwIfAborted();
		// 宿主select返回id字符串，而不是选项对象。
		const method = await interaction.prompt({
			// 选择输入类型。
			type: "select",
			// 界面原文，不执行里面任何动作。
			message: "Select Amazon Bedrock authentication method:",
			// id给分支使用，label仅展示。
			options: [
				// 直接输入Bedrock bearer token。
				{ id: "bearer-token", label: "Bearer token" },
				// 记录用户已配置的AWS profile名。
				{ id: "aws-profile", label: "AWS profile" },
				// 不记录token/profile，依赖外部已有凭证链。
				{ id: "credential-chain", label: "Existing AWS credential chain" },
			],
		});
		// 选择期间取消则不继续执行任何具体分支。
		interaction.signal.throwIfAborted();
		// bearer-token选项直接进入secret输入。
		if (method === "bearer-token") {
			// 返回待保存对象，真正存储由Models/宿主完成。
			return {
				// 这是API key类存储，不是OAuth access/refresh对象。
				type: "api_key",
				// 等待输入但不trim、检查非空或远端有效性；prompt可按自己的契约因取消拒绝。
				key: await interaction.prompt({ type: "secret", message: "Enter Amazon Bedrock bearer token" }),
			};
		}
		// 非bearer分支先展示说明；即便选择值未知，这条通知也发生在后面的未知方法检查之前。
		interaction.notify({
			// 信息通知无用户回答返回值。
			type: "info",
			// 列出支持的外部凭证方式，不在此创建IAM凭证或角色。
			message: "Amazon Bedrock supports AWS profiles, IAM credentials, and role-based credentials.",
			// 文档链接仅交宿主展示，不发HTTP。
			links: [
				{
					// 链接标题。
					label: "AWS credential provider chain",
					// 保留原AWS文档地址。
					url: "https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html",
				},
			],
		});
		// profile分支只收集名字，不读取~/.aws文件验证其存在。
		if (method === "aws-profile") {
			// 返回供应商env，既不修改进程环境也不拷贝实际AWS key。
			return {
				// API key类允许只含配置，没有key字段。
				type: "api_key",
				// 嵌套对象里的await先等答案，原字符串作为profile名保存。
				env: { AWS_PROFILE: await interaction.prompt({ type: "text", message: "Enter AWS profile name" }) },
			};
		}
		// 前两种已返回，剩余必须为credential-chain，否则同步throw被async转成拒绝。
		if (method !== "credential-chain") throw new Error(`Unknown Amazon Bedrock auth method: ${method}`);
		// 等用户确认外部配置完成；并不自动运行AWS CLI或执行凭证探测。
		await interaction.prompt({
			// 普通文字输入，实际返回内容被本分支忽略。
			type: "text",
			// 提示用户自行配置再回车。
			message: "Configure AWS credentials, then press Enter to continue",
		});
		// 只有标签的凭证不会让resolve必然成功；仍需后续环境条件命中。
		return { type: "api_key" };
	},
	// 用途：输入宿主ctx、可选已存API key凭证及signal，顺序探测认证来源，返回AuthResult或undefined。例如AWS_PROFILE=dev得到auth:{}与来源AWS_PROFILE。
	// 优先存储key，再bearer环境、profile、成对静态key、容器URI、web identity文件变量；只看条件真值，不加载或验证完整AWS SDK默认链，不连接元数据端点，也不保证真实授权有效。
	resolve: async ({ ctx, credential, signal }) => {
		// 局部异步读环境助手；输入变量名、返回字符串或undefined，读取前后检查取消，宿主读取副作用/失败向上传播。
		const env = async (name: string) => {
			// 已取消就不再读取宿主环境。
			signal.throwIfAborted();
			// ctx可由宿主或测试提供，不在此直接读process.env。
			const value = await ctx.env(name);
			// 异步读取期间取消则拒绝，不再采用其结果。
			signal.throwIfAborted();
			// 不trim，不把空串自动改成其他来源。
			return value;
		};
		// 存储真值key最优先；该快路径自身没有先检查signal，空key则继续探测环境。
		if (credential?.key) {
			// 同时透传原存储env；token放apiKey字段，实际传输再把它用于bearer认证。
			return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
		}
		// 仅发现环境token存在就返回空auth，交实际适配器从环境取token；不把秘密复制进结果apiKey。
		if (await env("AWS_BEARER_TOKEN_BEDROCK")) return { auth: {}, source: "AWS_BEARER_TOKEN_BEDROCK" };
		// profile字段按??选择：存储空串会挡住环境profile回退，但if仍是假，随后继续其他探测。
		if (credential?.env?.AWS_PROFILE ?? (await env("AWS_PROFILE"))) {
			// 存储或环境profile有真值时声明配置可用，不检查该profile是否实际可解析。
			return {
				// 不在这里加载profile换取密钥。
				auth: {},
				// 只回传原存储env，环境读出的profile不另抄进新对象。
				env: credential?.env,
				// 标签区分存储真值profile和环境profile，不代表已执行SDK认证。
				source: credential?.env?.AWS_PROFILE ? "stored credential" : "AWS_PROFILE",
			};
		}
		// &&短路按顺序读取，必须access和secret都为真值；本处不要求或验证session token。
		if ((await env("AWS_ACCESS_KEY_ID")) && (await env("AWS_SECRET_ACCESS_KEY"))) {
			// 只报告来源，不把环境密钥写入Pi凭证存储或auth字段。
			return { auth: {}, source: "AWS access keys" };
		}
		// 只识别容器相对URI变量存在，不在此访问URI或校验其内容。
		if (await env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")) return { auth: {}, source: "ECS task role" };
		// 完整URI也是存在性条件，实际获取留给后续SDK认证。
		if (await env("AWS_CONTAINER_CREDENTIALS_FULL_URI")) return { auth: {}, source: "ECS task role" };
		// 文件变量只看真值，既不在这里fileExists，也不要求其他角色环境变量同时存在。
		if (await env("AWS_WEB_IDENTITY_TOKEN_FILE")) return { auth: {}, source: "web identity token" };
		// 所列条件都未命中表示本策略未解析到配置；不是证明SDK所有可能凭证来源都不存在。
		return undefined;
	},
};

// 用途：无参数创建Bedrock聊天供应商，返回bedrock-converse-stream协议的Provider；流程只装静态模型、共享认证器和延迟流，无AWS请求或文件读取。
// 例models.setProvider(amazonBedrockProvider())后getAuth才探测上述条件；创建Provider本身不会验证AWS账号，也不会自动刷新目录。
export function amazonBedrockProvider(): Provider<"bedrock-converse-stream"> {
	// 统一工厂创建新的供应商对象。
	return createProvider({
		// 凭证存储/模型归属键。
		id: "amazon-bedrock",
		// 界面展示名称。
		name: "Amazon Bedrock",
		// 此API key类认证器兼容bearer和环境凭证链配置。
		auth: { apiKey: bedrockAuth },
		// 生成聊天表值转数组，模型对象仍共享；不手改这些目录条目。
		models: Object.values(AMAZON_BEDROCK_MODELS),
		// 创建延迟流，真实AWS SDK在实际使用流能力时才加载。
		api: bedrockConverseStreamApi(),
	});
}
