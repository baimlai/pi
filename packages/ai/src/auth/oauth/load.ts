// 将各OAuth flow与浏览器可见Provider定义隔开；这里只导入共享类型，运行时加载由下面的入口决定。
import type { OAuthAuth } from "../types.ts";

/**
 * Loads an OAuth flow module through a variable specifier so bundlers cannot
 * follow the import into Node-only flow code (`node:http` callback servers,
 * `node:crypto` PKCE). The `.ts`/`.js` rewrite keeps the trick working from
 * both source and built output.
 */
/**
 * 按变量模块名导入OAuth实现，返回未知模块Promise，失败向上传播。
 * 源码运行保留.ts，当前文件为.js时只把spec末尾.ts改为.js；例：构建后的anthropic.js入口能导入同目录anthropic.js，构造模块名不加载认证令牌。
 */
const importOAuthModule = (specifier: string): Promise<unknown> => {
	// import.meta.url反映当前模块文件后缀；正则只改specifier结尾.ts，不全面重写路径内容。
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	// 保留原有变量import以避免打包器静态跟进Node-only flow；Promise中模块结构仍为unknown。
	return import(runtimeSpecifier);
};

// 打包宿主提供的工厂契约，每个供应商都可同步或异步给出认证方法。
type OAuthFlowLoaders = {
	// Anthropic静态加载入口。
	anthropic: () => OAuthAuth | Promise<OAuthAuth>;
	// Codex登录实现工厂，区别于下一项ChatGPT直连令牌流程。
	openaiCodex: () => OAuthAuth | Promise<OAuthAuth>;
	// ChatGPT直连OpenAI的独立flow工厂。
	openaiChatGPT: () => OAuthAuth | Promise<OAuthAuth>;
	// Copilot设备码登录/刷新工厂。
	githubCopilot: () => OAuthAuth | Promise<OAuthAuth>;
	// OpenRouter授权换长期key工厂。
	openrouter: () => OAuthAuth | Promise<OAuthAuth>;
	// Kimi Code设备码工厂。
	kimiCoding: () => OAuthAuth | Promise<OAuthAuth>;
	// Meta设备码及铸key工厂。
	meta: () => OAuthAuth | Promise<OAuthAuth>;
	// xAI设备码工厂。
	xai: () => OAuthAuth | Promise<OAuthAuth>;
	// Radius工厂额外接收显示名和网关URL，不把它们硬编码为唯一实例。
	radius: (options: { name: string; gateway: string }) => OAuthAuth | Promise<OAuthAuth>;
};

// 模块级可选静态表，注册前各load走动态路径；let允许整体替换。
let bundledLoaders: OAuthFlowLoaders | undefined;

/** Registers statically bundled OAuth flows for standalone Bun binaries. */
/**
 * 登记独立二进制中的静态OAuth工厂表，无返回，整体替换模块级表，不马上执行任何登录。
 * 例：打包启动层注入anthropic等工厂后，load函数优先调用它们；类型要求整表，不是按键增量合并，也不做运行时完整性验证。
 */
export function registerBundledOAuthFlowLoaders(loaders: OAuthFlowLoaders): void {
	// 按引用保存新表，不执行工厂、不深复制或冻结。
	bundledLoaders = loaders;
}

/**
 * 加载Anthropic认证方法，返回OAuthAuth Promise，不在此启动login/refresh。
 * 先调用已登记静态工厂，否则导入anthropic.ts取anthropicOAuth；例：lazyOAuth首次调用toAuth时可触发此加载。异常传播，缓存由lazyOAuth/模块系统负责，不在此另建Promise缓存。
 */
export const loadAnthropicOAuth = async (): Promise<OAuthAuth> => {
	// 存在打包表时直接调用anthropic工厂，async会采纳同步对象或Promise；不尝试再回退动态导入。
	if (bundledLoaders) return bundledLoaders.anthropic();
	// 否则await可变路径导入，再按类型断言取anthropicOAuth；as不运行时验证导出结构。
	return ((await importOAuthModule("./anthropic.ts")) as { anthropicOAuth: OAuthAuth }).anthropicOAuth;
};

/**
 * 加载OpenAI Codex认证方法，返回OAuthAuth Promise，不在此启动login/refresh。
 * 先调用已登记静态工厂，否则导入openai-codex.ts取openaiCodexOAuth；例：lazyOAuth首次调用toAuth时可触发此加载。异常传播，缓存由lazyOAuth/模块系统负责，不在此另建Promise缓存。
 */
export const loadOpenAICodexOAuth = async (): Promise<OAuthAuth> => {
	// 存在打包表时直接调用openaiCodex工厂，async会采纳同步对象或Promise；不尝试再回退动态导入。
	if (bundledLoaders) return bundledLoaders.openaiCodex();
	// 否则await可变路径导入，再按类型断言取openaiCodexOAuth；as不运行时验证导出结构。
	return ((await importOAuthModule("./openai-codex.ts")) as { openaiCodexOAuth: OAuthAuth }).openaiCodexOAuth;
};

/**
 * 加载OpenAI ChatGPT认证方法，返回OAuthAuth Promise，不在此启动login/refresh。
 * 先调用已登记静态工厂，否则导入openai-chatgpt.ts取openaiChatGPTOAuth；例：lazyOAuth首次调用toAuth时可触发此加载。异常传播，缓存由lazyOAuth/模块系统负责，不在此另建Promise缓存。
 */
export const loadOpenAIChatGPTOAuth = async (): Promise<OAuthAuth> => {
	// 存在打包表时直接调用openaiChatGPT工厂，async会采纳同步对象或Promise；不尝试再回退动态导入。
	if (bundledLoaders) return bundledLoaders.openaiChatGPT();
	// 否则await可变路径导入，再按类型断言取openaiChatGPTOAuth；as不运行时验证导出结构。
	return ((await importOAuthModule("./openai-chatgpt.ts")) as { openaiChatGPTOAuth: OAuthAuth }).openaiChatGPTOAuth;
};

/**
 * 加载GitHub Copilot认证方法，返回OAuthAuth Promise，不在此启动login/refresh。
 * 先调用已登记静态工厂，否则导入github-copilot.ts取githubCopilotOAuth；例：lazyOAuth首次调用toAuth时可触发此加载。异常传播，缓存由lazyOAuth/模块系统负责，不在此另建Promise缓存。
 */
export const loadGitHubCopilotOAuth = async (): Promise<OAuthAuth> => {
	// 存在打包表时直接调用githubCopilot工厂，async会采纳同步对象或Promise；不尝试再回退动态导入。
	if (bundledLoaders) return bundledLoaders.githubCopilot();
	// 否则await可变路径导入，再按类型断言取githubCopilotOAuth；as不运行时验证导出结构。
	return ((await importOAuthModule("./github-copilot.ts")) as { githubCopilotOAuth: OAuthAuth }).githubCopilotOAuth;
};

/**
 * 加载OpenRouter认证方法，返回OAuthAuth Promise，不在此启动login/refresh。
 * 先调用已登记静态工厂，否则导入openrouter.ts取openRouterOAuth；例：lazyOAuth首次调用toAuth时可触发此加载。异常传播，缓存由lazyOAuth/模块系统负责，不在此另建Promise缓存。
 */
export const loadOpenRouterOAuth = async (): Promise<OAuthAuth> => {
	// 存在打包表时直接调用openrouter工厂，async会采纳同步对象或Promise；不尝试再回退动态导入。
	if (bundledLoaders) return bundledLoaders.openrouter();
	// 否则await可变路径导入，再按类型断言取openRouterOAuth；as不运行时验证导出结构。
	return ((await importOAuthModule("./openrouter.ts")) as { openRouterOAuth: OAuthAuth }).openRouterOAuth;
};

/**
 * 加载Kimi Code认证方法，返回OAuthAuth Promise，不在此启动login/refresh。
 * 先调用已登记静态工厂，否则导入kimi-coding.ts取kimiCodingOAuth；例：lazyOAuth首次调用toAuth时可触发此加载。异常传播，缓存由lazyOAuth/模块系统负责，不在此另建Promise缓存。
 */
export const loadKimiCodingOAuth = async (): Promise<OAuthAuth> => {
	// 存在打包表时直接调用kimiCoding工厂，async会采纳同步对象或Promise；不尝试再回退动态导入。
	if (bundledLoaders) return bundledLoaders.kimiCoding();
	// 否则await可变路径导入，再按类型断言取kimiCodingOAuth；as不运行时验证导出结构。
	return ((await importOAuthModule("./kimi-coding.ts")) as { kimiCodingOAuth: OAuthAuth }).kimiCodingOAuth;
};

/**
 * 加载Meta认证方法，返回OAuthAuth Promise，不在此启动login/refresh。
 * 先调用已登记静态工厂，否则导入meta.ts取metaOAuth；例：lazyOAuth首次调用toAuth时可触发此加载。异常传播，缓存由lazyOAuth/模块系统负责，不在此另建Promise缓存。
 */
export const loadMetaOAuth = async (): Promise<OAuthAuth> => {
	// 存在打包表时直接调用meta工厂，async会采纳同步对象或Promise；不尝试再回退动态导入。
	if (bundledLoaders) return bundledLoaders.meta();
	// 否则await可变路径导入，再按类型断言取metaOAuth；as不运行时验证导出结构。
	return ((await importOAuthModule("./meta.ts")) as { metaOAuth: OAuthAuth }).metaOAuth;
};

/**
 * 加载xAI认证方法，返回OAuthAuth Promise，不在此启动login/refresh。
 * 先调用已登记静态工厂，否则导入xai.ts取xaiOAuth；例：lazyOAuth首次调用toAuth时可触发此加载。异常传播，缓存由lazyOAuth/模块系统负责，不在此另建Promise缓存。
 */
export const loadXaiOAuth = async (): Promise<OAuthAuth> => {
	// 存在打包表时直接调用xai工厂，async会采纳同步对象或Promise；不尝试再回退动态导入。
	if (bundledLoaders) return bundledLoaders.xai();
	// 否则await可变路径导入，再按类型断言取xaiOAuth；as不运行时验证导出结构。
	return ((await importOAuthModule("./xai.ts")) as { xaiOAuth: OAuthAuth }).xaiOAuth;
};

/**
 * 按展示名与网关地址加载/构造Radius OAuth方法，返回Promise，不发发现/登录请求。
 * 静态打包表优先，否则导入createRadiusOAuth后传同一options；例：自定义gateway的Radius Provider可得到对应登录方法，网关规范化在构造器内执行。
 */
export const loadRadiusOAuth = async (options: { name: string; gateway: string }): Promise<OAuthAuth> => {
	// 打包Radius工厂收到完整options，返回值由async统一成Promise。
	if (bundledLoaders) return bundledLoaders.radius(options);
	// 多行return仍是同一个导入后构造表达式，括号只是组织类型断言。
	return (
		// 导入Radius模块，随后断言它包含createRadiusOAuth函数。
		(
			(await importOAuthModule("./radius.ts")) as {
				// 声明工厂的输入/输出类型，不在这里创建函数实现。
				createRadiusOAuth: (input: { name: string; gateway: string }) => OAuthAuth;
			}
		)
			// 真正调用模块导出的构造器，得到绑定此网关的认证对象。
			.createRadiusOAuth(options)
	);
};
