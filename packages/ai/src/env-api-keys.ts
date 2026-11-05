// 兼容入口的环境认证发现：先列有值的已知变量，再取API key；Vertex/Bedrock可返回环境认证占位符，不发登录/模型请求。
// 导入时Node/Bun会异步装载内置fs/os/path函数，未await就继续；只有Vertex ADC分支会用existsSync探测凭据路径，不读取其JSON内容。
// 变量specifier隔开浏览器打包依赖；typeof import只取类型，不等于运行时立即加载模块。
// NEVER convert to top-level imports - breaks browser/Vite builds
// 可空fs.existsSync函数引用，初始null表示异步模块还没装好；typeof取导出方法类型。
let _existsSync: typeof import("node:fs").existsSync | null = null;
// 可空os.homedir引用，用于稍后拼默认ADC路径，不在声明时查询主目录。
let _homedir: typeof import("node:os").homedir | null = null;
// 可空path.join引用，参数/返回类型沿Node本机定义；let允许回调随后赋值。
let _join: typeof import("node:path").join | null = null;

// 变量模块导入器的函数类型：接specifier，返回未知模块Promise，unknown需要调用方断言后取方法。
type DynamicImport = (specifier: string) => Promise<unknown>;

// 箭头按调用时的变量specifier执行import，返回原Promise；例传node:fs会请求该模块，加载错误由Promise拒绝表示，定义函数本身不加载模块。
const dynamicImport: DynamicImport = (specifier) => import(specifier);
// 用拼接字符串保存fs模块名，保持原来打包器不静态跟进的路径写法，不是文件路径拼接。
const NODE_FS_SPECIFIER = "node:" + "fs";
// 同样构造os模块名。
const NODE_OS_SPECIFIER = "node:" + "os";
// 同样构造path模块名。
const NODE_PATH_SPECIFIER = "node:" + "path";

// Eagerly load in Node.js/Bun environment only
// 宿主边界先typeof防浏览器无process，再检查node/bun版本真值；这不是精确识别所有JS运行环境。
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	// 立即异步请求fs模块，then成功时赋函数；无await/错误catch，调用者可能先于它完成，导入拒绝也不由这里吞掉。
	dynamicImport(NODE_FS_SPECIFIER).then((m) => {
		// 把未知模块断言成Node fs类型再存existsSync，不在此调用它或打开文件。
		_existsSync = (m as typeof import("node:fs")).existsSync;
	});
	// 独立启动os导入，与其他两个完成顺序不固定。
	dynamicImport(NODE_OS_SPECIFIER).then((m) => {
		// 只保存homedir函数引用，不在回调里读取主目录。
		_homedir = (m as typeof import("node:os")).homedir;
	});
	// 独立启动path导入，没有统一等待三者全部就绪的Promise。
	dynamicImport(NODE_PATH_SPECIFIER).then((m) => {
		// 保存join函数供需要ADC探测时使用。
		_join = (m as typeof import("node:path")).join;
	});
}

// 已知供应商与可选请求级环境字典只作类型；KnownProvider重载也不形成运行时白名单。
import type { KnownProvider, ProviderEnv } from "./types.ts";
// 环境取值统一走显式覆盖→process.env→Bun空环境/proc回退；读取可能有该helper的缓存与同步/proc副作用。
import { getProviderEnvValue } from "./utils/provider-env.ts";

// Anthropic Bearer auth token的变量名，发现列表会报告，getEnvApiKey特意不将它当x-api-key材料。
export const ANTHROPIC_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
// Anthropic OAuth token旧兼容变量名，可作为返回的API认证字符串。
export const ANTHROPIC_OAUTH_TOKEN_ENV = "ANTHROPIC_OAUTH_TOKEN";
// 常规Anthropic API key变量名，优先级在OAuth变量后。
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
// 联邦规则ID变量名供其他模块引用，本文件不把它当可单独返回的API key。
export const ANTHROPIC_FEDERATION_RULE_ID_ENV = "ANTHROPIC_FEDERATION_RULE_ID";
// 组织ID配置名，不是秘密key值。
export const ANTHROPIC_ORGANIZATION_ID_ENV = "ANTHROPIC_ORGANIZATION_ID";
// 服务账户ID配置名，在这里仅导出文字常量。
export const ANTHROPIC_SERVICE_ACCOUNT_ID_ENV = "ANTHROPIC_SERVICE_ACCOUNT_ID";
// 身份token文件路径的变量名，本常量不读取该文件。
export const ANTHROPIC_IDENTITY_TOKEN_FILE_ENV = "ANTHROPIC_IDENTITY_TOKEN_FILE";
// 工作区ID配置名，不会因定义常量就执行联邦认证。
export const ANTHROPIC_WORKSPACE_ID_ENV = "ANTHROPIC_WORKSPACE_ID";

// ADC路径存在性的一份模块级布尔缓存：null未探测；不是按路径/env分开的Map，也没有公开失效入口。
let cachedVertexAdcCredentialsExists: boolean | null = null;

// 同步粗判Vertex ADC是否有凭据路径，接可选请求env，返回boolean；例显式GOOGLE_APPLICATION_CREDENTIALS指存在文件时true。
// 只测路径存在，不解码凭据/验证权限或实际云认证。显式作用域路径不缓存，其余首次探测缓存布尔；Node导入未就绪先false且不缓存，环境/文件后改不保证重查。
function hasVertexAdcCredentials(env?: ProviderEnv): boolean {
	// 只先读请求env的显式路径，不在这行查process.env或Bun回退。
	const explicitCredentialsPath = env?.GOOGLE_APPLICATION_CREDENTIALS;
	// 真值显式路径优先，不受已有全局布尔缓存限制；空串继续后面普通路径。
	if (explicitCredentialsPath) {
		// fs引用已就绪就每次existsSync此路径，否则false；这支不写cached，也不等另两个模块。
		return _existsSync ? _existsSync(explicitCredentialsPath) : false;
	}

	// 只有尚未缓存才做下面默认/进程环境路径探测；cached false也会直接复用。
	if (cachedVertexAdcCredentialsExists === null) {
		// If node modules haven't loaded yet (async import race at startup),
		// return false WITHOUT caching so the next call retries once they're ready.
		// Only cache false permanently in a browser environment where fs is never available.
		// 默认探测须三个函数全就绪，缺任一个先进入环境判断。
		if (!_existsSync || !_homedir || !_join) {
			// 判断当前是否仍像Node/Bun，结果可能是版本字符串真值而不必是严格boolean。
			const isNode = typeof process !== "undefined" && (process.versions?.node || process.versions?.bun);
			// 不符合Node/Bun标识时认为fs永远不会在当前设定中加载。
			if (!isNode) {
				// Definitively in a browser — safe to cache false permanently
				// 这种非Node/Bun分支把false永久记下来，没有自动环境切换重置。
				cachedVertexAdcCredentialsExists = false;
			}
			// 函数暂时返回false，Node/Bun加载竞态分支没写缓存，下次调用可再试。
			return false;
		}

		// Check GOOGLE_APPLICATION_CREDENTIALS env var first (standard way)
		// 函数就绪后按helper优先级读GAC路径；进程环境路径也会影响接下来那份共享缓存。
		const gacPath = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
		// 有真值路径就查它，不回退默认路径，即使该路径不存在。
		if (gacPath) {
			// 将existsSync的true/false存模块缓存；之后普通调用改变env或文件不会自行使缓存失效。
			cachedVertexAdcCredentialsExists = _existsSync(gacPath);
		} else {
			// Fall back to default ADC path (lazy evaluation)
			// 没配置路径才测默认gcloud ADC位置，只查存在性不读内容。
			cachedVertexAdcCredentialsExists = _existsSync(
				// 真正调用homedir，再按平台拼.config/gcloud/application_default_credentials.json；这不是发gcloud命令。
				_join(_homedir(), ".config", "gcloud", "application_default_credentials.json"),
			);
		}
	}
	// 返回已缓存boolean，显式路径早返与加载未好早返均在前面处理。
	return cachedVertexAdcCredentialsExists;
}

// 内部按provider查有序环境变量名，返回只读数组类型或undefined，无值读取；例anthropic返回三名且有固定顺序。
// 这是兼容映射表，不含AWS/ADC等环境认证源；普通对象索引也可读继承键，类型不为任意provider字符串提供运行时白名单验证。
function getApiKeyEnvVars(provider: string): readonly string[] | undefined {
	// Copilot单独规则，不采用通用GH_TOKEN/GITHUB_TOKEN作为请求凭据。
	if (provider === "github-copilot") {
		// 只返回专用变量名，没读取其中值。
		return ["COPILOT_GITHUB_TOKEN"];
	}

	// ANTHROPIC_AUTH_TOKEN participates in env discovery/status, but
	// getEnvApiKey() skips it because requests must pass it as Authorization: Bearer.
	// Anthropic单独规则同时报告Bearer与两种API key来源，含Bearer是发现/状态行为，不代表getEnvApiKey返回它。
	if (provider === "anthropic") {
		// 固定有序数组：AUTH_TOKEN→OAUTH_TOKEN→API_KEY；首个key返回逻辑后面会跳过AUTH_TOKEN。
		return [ANTHROPIC_AUTH_TOKEN_ENV, ANTHROPIC_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV];
	}

	// 其余供应商用普通对象映射单一变量名，Record是静态类型，不改变原型或自动创建每个字符串键。
	const envMap: Record<string, string> = {
		// ant-ling使用ANT_LING_API_KEY环境变量。
		"ant-ling": "ANT_LING_API_KEY",
		// qwen-token-plan使用QWEN_TOKEN_PLAN_API_KEY环境变量。
		"qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY",
		// qwen-token-plan-cn使用QWEN_TOKEN_PLAN_CN_API_KEY环境变量。
		"qwen-token-plan-cn": "QWEN_TOKEN_PLAN_CN_API_KEY",
		// qwen-token-plan-individual使用QWEN_TOKEN_PLAN_API_KEY环境变量。
		"qwen-token-plan-individual": "QWEN_TOKEN_PLAN_API_KEY",
		// openai使用OPENAI_API_KEY环境变量。
		openai: "OPENAI_API_KEY",
		// azure使用AZURE_OPENAI_API_KEY环境变量。
		azure: "AZURE_OPENAI_API_KEY",
		// nvidia使用NVIDIA_API_KEY环境变量。
		nvidia: "NVIDIA_API_KEY",
		// deepseek使用DEEPSEEK_API_KEY环境变量。
		deepseek: "DEEPSEEK_API_KEY",
		// google使用GEMINI_API_KEY环境变量。
		google: "GEMINI_API_KEY",
		// google-vertex使用GOOGLE_CLOUD_API_KEY环境变量。
		"google-vertex": "GOOGLE_CLOUD_API_KEY",
		// groq使用GROQ_API_KEY环境变量。
		groq: "GROQ_API_KEY",
		// cerebras使用CEREBRAS_API_KEY环境变量。
		cerebras: "CEREBRAS_API_KEY",
		// xai使用XAI_API_KEY环境变量。
		xai: "XAI_API_KEY",
		// typesafe使用TYPESAFE_API_KEY环境变量。
		typesafe: "TYPESAFE_API_KEY",
		// radius使用RADIUS_API_KEY环境变量。
		radius: "RADIUS_API_KEY",
		// openrouter使用OPENROUTER_API_KEY环境变量。
		openrouter: "OPENROUTER_API_KEY",
		// vercel-ai-gateway使用AI_GATEWAY_API_KEY环境变量。
		"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
		// zai使用ZAI_API_KEY环境变量。
		zai: "ZAI_API_KEY",
		// zai-coding-cn使用ZAI_CODING_CN_API_KEY环境变量。
		"zai-coding-cn": "ZAI_CODING_CN_API_KEY",
		// mistral使用MISTRAL_API_KEY环境变量。
		mistral: "MISTRAL_API_KEY",
		// minimax使用MINIMAX_API_KEY环境变量。
		minimax: "MINIMAX_API_KEY",
		// minimax-cn使用MINIMAX_CN_API_KEY环境变量。
		"minimax-cn": "MINIMAX_CN_API_KEY",
		// moonshotai使用MOONSHOT_API_KEY环境变量。
		moonshotai: "MOONSHOT_API_KEY",
		// moonshotai-cn使用MOONSHOT_API_KEY环境变量。
		"moonshotai-cn": "MOONSHOT_API_KEY",
		// huggingface使用HF_TOKEN环境变量。
		huggingface: "HF_TOKEN",
		// fireworks使用FIREWORKS_API_KEY环境变量。
		fireworks: "FIREWORKS_API_KEY",
		// together使用TOGETHER_API_KEY环境变量。
		together: "TOGETHER_API_KEY",
		// baseten使用BASETEN_API_KEY环境变量。
		baseten: "BASETEN_API_KEY",
		// opencode使用OPENCODE_API_KEY环境变量。
		opencode: "OPENCODE_API_KEY",
		// opencode-go使用OPENCODE_API_KEY环境变量。
		"opencode-go": "OPENCODE_API_KEY",
		// kimi-coding使用KIMI_API_KEY环境变量。
		"kimi-coding": "KIMI_API_KEY",
		// meta使用META_API_KEY环境变量。
		meta: "META_API_KEY",
		// cloudflare-workers-ai使用CLOUDFLARE_API_KEY环境变量。
		"cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
		// cloudflare-ai-gateway使用CLOUDFLARE_API_KEY环境变量。
		"cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
		// xiaomi使用XIAOMI_API_KEY环境变量。
		xiaomi: "XIAOMI_API_KEY",
		// xiaomi-token-plan-cn使用XIAOMI_TOKEN_PLAN_CN_API_KEY环境变量。
		"xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
		// xiaomi-token-plan-ams使用XIAOMI_TOKEN_PLAN_AMS_API_KEY环境变量。
		"xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
		// xiaomi-token-plan-sgp使用XIAOMI_TOKEN_PLAN_SGP_API_KEY环境变量。
		"xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	};

	// 按provider直接索引，常见未登记名为undefined；__proto__/toString等继承键也能被读出，声明string类型不会验证实际值。
	const envVar = envMap[provider];
	// 真值映射包成单项新数组，否则undefined；没有实际env值或认证有效性判断。
	return envVar ? [envVar] : undefined;
}

/**
 * Find configured environment variables that can provide an API key for a provider.
 *
 * This only reports actual API key variables. It intentionally excludes ambient
 * credential sources such as AWS profiles, AWS IAM credentials, and Google
 * Application Default Credentials.
 */
// 公开重载供KnownProvider提示，接provider/可选env，返回当前有真值的变量名列表或undefined；不返回秘密本身。
// 例Anthropic三变量都有值就按表顺序列三名；虽英文概述称API key，实际也包括ANTHROPIC_AUTH_TOKEN的状态发现，不检查远端有效性。
export function findEnvKeys(provider: KnownProvider, env?: ProviderEnv): string[] | undefined;
// 宽string重载允许自定义供应商文字，未在表中通常找不到；两条签名只有一个实现。
export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined;
// 运行实现接string，不按重载另写两套代码，也不会执行TS已擦除类型判断。
export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined {
	// 先取变量名表，没有在这里解析AWS profile/ADC文件。
	const envVars = getApiKeyEnvVars(provider);
	// 无映射早返undefined，不生成空数组。
	if (!envVars) return undefined;

	// filter按名调用helper，!!把真值转boolean；env空串会按helper规则继续回退进程值，而不是显式禁用。
	const found = envVars.filter((envVar) => !!getProviderEnvValue(envVar, env));
	// 有匹配返回按原顺序的新数组，没有就undefined；只返回变量名，不输出读取到的秘密值。
	return found.length > 0 ? found : undefined;
}

/**
 * Get API key for provider from known environment variables, e.g. OPENAI_API_KEY.
 *
 * Will not return API keys for providers that require OAuth tokens.
 */
// 读取兼容API key或环境认证标记，接provider/可选env，返回string或undefined；例openai读取OPENAI_API_KEY。
// 先选变量值，Anthropic跳过Bearer专用名；再测Vertex/Bedrock环境材料，成功只给<authenticated>占位，不是可发HTTP的令牌或真实授权证明。
// Node默认ADC路径可有文件存在性探测，helper还可能Bun/proc回退；不执行OAuth刷新、AWS SDK登录或网络验证，相关同步读取/宿主异常可传播。
export function getEnvApiKey(provider: KnownProvider, env?: ProviderEnv): string | undefined;
// 第二重载放宽任意string，返回类型同上；重载不改变实际查找顺序。
export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined;
// 一个实现处理全部provider，也可返回专用Copilot/Anthropic旧token变量的值，不在这一步执行OAuth流程。
export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined {
	// 按有值变量名先查一遍，不在此就返回数组。
	const envKeys = findEnvKeys(provider, env);
	// 至少存在首个真值名字才选API key来源，可选链容忍undefined。
	if (envKeys?.[0]) {
		// Anthropic用find跳过AUTH_TOKEN，保留OAuth token优先于API key；其他provider取首项。
		const apiKeyEnv = provider === "anthropic" ? envKeys.find((key) => key !== ANTHROPIC_AUTH_TOKEN_ENV) : envKeys[0];
		// 找到可用名就再次helper读值直接返回；不缓存字符串，环境在两次读取间变化仍可能影响结果。
		if (apiKeyEnv) return getProviderEnvValue(apiKeyEnv, env);
	}

	// Vertex AI supports either an explicit API key or Application Default Credentials.
	// Auth is configured via `gcloud auth application-default login`.
	// 只有未从普通key变量早返的google-vertex才尝试ADC环境认证判断。
	if (provider === "google-vertex") {
		// 检查凭据路径存在性，可能同步existsSync或因异步模块未就绪暂false。
		const hasCredentials = hasVertexAdcCredentials(env);
		// 项目ID条件最后转boolean，接受下面任一真值来源。
		const hasProject = !!(
			// GOOGLE_CLOUD_PROJECT优先，缺时GCLOUD_PROJECT；不向云端查项目是否真实存在。
			(getProviderEnvValue("GOOGLE_CLOUD_PROJECT", env) || getProviderEnvValue("GCLOUD_PROJECT", env))
		);
		// 另需真值位置配置；不验证它属于合法区域或与项目一致。
		const hasLocation = !!getProviderEnvValue("GOOGLE_CLOUD_LOCATION", env);

		// 路径存在/项目/位置都真值才认为配置有候选环境认证，非凭据内容或令牌有效性校验。
		if (hasCredentials && hasProject && hasLocation) {
			// 返回固定标记给兼容调用方，实际ADC认证由真正请求实现处理。
			return "<authenticated>";
		}
	}

	// Bedrock没有这里的普通key表项，改按AWS环境材料是否存在作粗判。
	if (provider === "amazon-bedrock") {
		// Amazon Bedrock supports multiple credential sources:
		// 1. AWS_PROFILE - named profile from ~/.aws/credentials
		// 2. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY - standard IAM keys
		// 3. AWS_BEARER_TOKEN_BEDROCK - Bedrock bearer token
		// 4. AWS_CONTAINER_CREDENTIALS_RELATIVE_URI - ECS task roles
		// 5. AWS_CONTAINER_CREDENTIALS_FULL_URI - ECS task roles (full URI)
		// 6. AWS_WEB_IDENTITY_TOKEN_FILE - IRSA (IAM Roles for Service Accounts)
		// 多种候选来源用||短路，任意满足便返回标记；不读profile文件、token文件或容器凭据URL。
		if (
			// profile名字有值即可，不核对该profile文件实际存在。
			getProviderEnvValue("AWS_PROFILE", env) ||
			// 标准IAM需要access ID与secret同时真值，未强制另需session token。
			(getProviderEnvValue("AWS_ACCESS_KEY_ID", env) && getProviderEnvValue("AWS_SECRET_ACCESS_KEY", env)) ||
			// Bearer变量有值即满足，返回的仍是下方占位符，不是它的真实值。
			getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", env) ||
			// ECS相对凭据URI只查文字，不向它请求凭据。
			getProviderEnvValue("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", env) ||
			// ECS完整URI同样只作配置存在性判断，不验证端点可信。
			getProviderEnvValue("AWS_CONTAINER_CREDENTIALS_FULL_URI", env) ||
			// Web identity文件路径有值即可，不在这里existsSync或打开文件。
			getProviderEnvValue("AWS_WEB_IDENTITY_TOKEN_FILE", env)
		) {
			// 统一标记候选AWS环境认证，不保证实际请求可通过或已花费任何模型token。
			return "<authenticated>";
		}
	}

	// 普通变量/环境候选都未满足时返回undefined，不抛“缺key”的业务错误。
	return undefined;
}
