// Vertex供应商的认证交互与配置探测：支持显式key，或ADC文件+项目+地区；这里只准备请求条件，真实Google认证交由延迟适配器/SDK。
// 轻量流工厂，构造时不加载真正的Vertex请求模块。
import { googleVertexApi } from "../api/google-vertex.lazy.ts";
// ApiKeyAuth也容纳没有key、只带供应商环境配置的认证方式，并非所有分支都必须产出apiKey。
import type { ApiKeyAuth } from "../auth/types.ts";
// 构造供应商的值与仅供编译器使用的Provider类型。
import { createProvider, type Provider } from "../models.ts";
// 静态聊天目录为生成产物，本文件只读取。
import { GOOGLE_VERTEX_MODELS } from "./google-vertex.models.ts";

// 默认ADC探测路径；~展开取决于ctx.fileExists的实现，不是普通字符串自动展开。
const VERTEX_ADC_PATH = "~/.config/gcloud/application_default_credentials.json";

/**
 * Vertex accepts an explicit API key or Application Default Credentials
 * (`gcloud auth application-default login`). ADC additionally requires
 * project and location env vars, which the implementation reads itself.
 */
// 认证策略在模块内共享；下面两个回调直到宿主调用login/resolve才执行，不在对象创建时读环境或弹窗。
const vertexAuth: ApiKeyAuth = {
	// 登录方式展示名，不是已成功认证的状态。
	name: "Google Cloud credentials",
	// 用途：输入规范化交互对象，异步返回待保存api_key凭证；可选key、ADC或服务账号文件。例选adc后收集project/location，返回env而非读取文件内容。
	// 流程：检查取消、选方法、再次检查；key分支问secret，其余提示操作再收集配置。仅返回数据，不运行gcloud、不验证文件/凭证、不持久化；后续prompt后没有统一的收尾取消检查。
	login: async (interaction) => {
		// signal由上层规范为必需；已取消就按信号原因抛出，使async方法拒绝。
		interaction.signal.throwIfAborted();
		// 等待宿主选择，约定返回选项id字符串，而不是完整选项对象。
		const method = await interaction.prompt({
			// select要求宿主展示单选输入。
			type: "select",
			// 原提示文字只作为界面数据，不执行其中含义。
			message: "Select Google Vertex AI authentication method:",
			// id用于下方分支，label只供展示；此数组不是TypeScript联合类型定义。
			options: [
				// 直接key输入。
				{ id: "api-key", label: "Google Cloud API key" },
				// 使用默认应用凭证文件。
				{ id: "adc", label: "Application Default Credentials" },
				// 由用户指定服务账号文件路径。
				{ id: "service-account", label: "Service account credentials file" },
			],
		});
		// 选择期间取消时不继续进入后续配置流程。
		interaction.signal.throwIfAborted();
		// 精确匹配key选项，其他字符串不会进入secret分支。
		if (method === "api-key") {
			// 返回凭证对象；本层不把密钥写入任何全局环境。
			return {
				// 判别标签表明存储的类别，区别oauth凭证。
				type: "api_key",
				// await等宿主secret输入；不trim、检查非空或再次显式检查取消，prompt自身可拒绝。
				key: await interaction.prompt({ type: "secret", message: "Enter Google Cloud API key" }),
			};
		}
		// 外部交互返回未知id时显式拒绝，不默认为ADC。
		if (method !== "adc" && method !== "service-account") {
			// 带回实际未知方法值，帮助诊断宿主返回值。
			throw new Error(`Unknown Google Vertex AI auth method: ${method}`);
		}
		// 同步通知只展示下一步，不运行命令；notify自己抛错仍会使login拒绝。
		interaction.notify({
			// 信息通知，不是需要回答的prompt。
			type: "info",
			// 三元表达式按已经确认的两种方法选择提示文字。
			message:
				// ADC分支提示用户在外部运行gcloud，代码不代为执行。
				method === "adc"
					? "Run `gcloud auth application-default login`, then provide the project and location."
					: // 服务账号分支提示准备文件和项目/地区。
						"Provide a service account credentials file, project, and location.",
			// 文档链接交宿主显示，不在此访问URL。
			links: [
				{
					// 文档标题。
					label: "Application Default Credentials",
					// 原链接为配置说明文字。
					url: "https://cloud.google.com/docs/authentication/provide-credentials-adc",
				},
			],
		});
		// 顺序等待项目ID，不在本层确认该项目存在或有权限。
		const project = await interaction.prompt({ type: "text", message: "Enter Google Cloud project ID" });
		// 收集地区，具体支持范围留给后续请求配置/SDK。
		const location = await interaction.prompt({ type: "text", message: "Enter Google Cloud location" });
		// 只有服务账号选项还要用户填写路径，ADC分支不额外询问。
		const credentialsPath =
			// 精确选择决定是否执行后面的异步prompt。
			method === "service-account"
				? await interaction.prompt({ type: "text", message: "Enter service account credentials file path" })
				: // ADC路径不写入此凭证，resolve将按存储/环境/默认路径寻找。
					undefined;
		// 返回供应商作用域env，不含文件内容或访问token。
		return {
			// API key类凭证允许没有key字段而只有环境配置。
			type: "api_key",
			// 这些环境字段随后由Models合并到请求配置，不在此修改process.env。
			env: {
				// 项目ID直接使用用户输入。
				GOOGLE_CLOUD_PROJECT: project,
				// 地区同样原样保留。
				GOOGLE_CLOUD_LOCATION: location,
				// 对象展开仅在路径为真值时添加字段；空串不加入，未检查路径存在。
				...(credentialsPath ? { GOOGLE_APPLICATION_CREDENTIALS: credentialsPath } : {}),
			},
		};
	},
	// 用途：输入宿主环境/文件能力、可选已存凭证和取消信号，异步返回认证结果或undefined；例ADC文件存在且项目/地区有值，得到auth:{}与配置来源。
	// 先选key，再探测ADC路径及项目/地区；有条件不代表文件可解析、Google授权有效或实际请求一定成功。宿主env/fileExists可有I/O或拒绝，本层不吞错。
	resolve: async ({ ctx, credential, signal }) => {
		// 局部读取器：输入变量名、输出可缺省字符串，等待前后检查取消；例env("GOOGLE_CLOUD_PROJECT")只查宿主来源，不自动叠加credential.env。
		const env = async (name: string) => {
			// 已取消时不再调用宿主读取。
			signal.throwIfAborted();
			// env可能异步，也可能由测试提供纯内存实现。
			const value = await ctx.env(name);
			// 读取期间取消则丢弃其结果并拒绝。
			signal.throwIfAborted();
			// 保留空字符串与undefined的区别，外层再决定如何回退。
			return value;
		};
		// ??只在存储key缺省时读环境，已存空串会阻断本次环境key回退，随后因假值继续ADC流程。
		const key = credential?.key ?? (await env("GOOGLE_CLOUD_API_KEY"));
		// 真值key直接成功，不trim或验证，也不返回credential.env；此快路径自身没有额外取消检查。
		if (key) return { auth: { apiKey: key }, source: credential?.key ? "stored credential" : "GOOGLE_CLOUD_API_KEY" };

		// 文件路径同样存储字段优先于环境；空串仍会阻断??回退，不被自动替换成默认路径。
		const adcPath = credential?.env?.GOOGLE_APPLICATION_CREDENTIALS ?? (await env("GOOGLE_APPLICATION_CREDENTIALS"));
		// 探测文件前检查取消。
		signal.throwIfAborted();
		// 仅检查存在性/宿主约定的可访问性；缺省才用默认~路径，不读取或验证凭证JSON。
		const hasCredentials = await ctx.fileExists(adcPath ?? VERTEX_ADC_PATH);
		// 文件探测结束后再次响应取消。
		signal.throwIfAborted();
		// 项目按存储->GOOGLE_CLOUD_PROJECT->GCLOUD_PROJECT逐项缺省回退；空串会阻断后续??选择。
		const project =
			credential?.env?.GOOGLE_CLOUD_PROJECT ?? (await env("GOOGLE_CLOUD_PROJECT")) ?? (await env("GCLOUD_PROJECT"));
		// 地区只用存储或GOOGLE_CLOUD_LOCATION，没有额外默认值。
		const location = credential?.env?.GOOGLE_CLOUD_LOCATION ?? (await env("GOOGLE_CLOUD_LOCATION"));
		// 文件探测为真且项目/地区都为真值才视为具备ADC配置，不证明SDK可以成功换token。
		if (hasCredentials && project && location) {
			// 返回普通认证结果，最终SDK从环境配置/ADC取真正请求凭证。
			return {
				// 不伪造apiKey；空auth表示沿环境认证路径。
				auth: {},
				// 只回传原存储env，不把刚从ctx查出的project/location复制进一个新env表。
				env: credential?.env,
				// 来源按credential对象是否存在选择，不逐字段标出每个值到底来自哪里。
				source: credential ? "stored credential" : "gcloud application default credentials",
			};
		}
		// 配置条件不齐返回未配置；此函数末尾没有再统一检查signal。
		return undefined;
	},
};

// 用途：无参数创建Vertex聊天Provider，返回google-vertex协议对象；装静态目录、共享认证策略和延迟流，不立即运行认证、读文件或发请求。
// 例models.setProvider(googleVertexProvider())后，getAuth("google-vertex")才执行上面的配置解析，stream再由真实适配器/Google SDK处理ADC和请求。
export function googleVertexProvider(): Provider<"google-vertex"> {
	// createProvider构造新对象，模型对象仍引用生成目录值。
	return createProvider({
		// 独立供应商键，与使用Gemini key的google分开。
		id: "google-vertex",
		// 展示名称。
		name: "Google Vertex AI",
		// API key类认证能力也包含ADC/服务账号文件配置。
		auth: { apiKey: vertexAuth },
		// 将生成的聊天目录表变为数组，不包含生成但未在此装配的其他种类目录。
		models: Object.values(GOOGLE_VERTEX_MODELS),
		// 此时只建立延迟流能力，真实实现到流调用时加载。
		api: googleVertexApi(),
	});
}
