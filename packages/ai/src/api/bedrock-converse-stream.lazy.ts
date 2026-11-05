// Bedrock的手写延迟入口：变量路径隔开Node专用AWS实现，另支持构建器注册静态模块覆盖；不修改生成模型目录。
// 聊天实现的类型契约，声明流式方法，不在此导入AWS SDK。
import type { ProviderStreams } from "../types.ts";
// 通用延迟流包装器把模块加载失败转为外层流error结果。
import { lazyApi } from "./lazy.ts";

/**
 * Loads the bedrock implementation through a variable specifier so bundlers
 * (browser smoke, Bun compile) cannot follow the import into the Node-only
 * AWS SDK. The `.ts`/`.js` rewrite keeps the trick working from both source
 * and built output.
 */
/**
 * 用变量路径导入Node专用Bedrock实现，输入specifier、返回未知模块Promise，无网络模型请求。
 * 例：源码模块自身URL以.ts结尾时导入./bedrock-converse-stream.ts；构建后的.js入口改用.js。路径解析/加载异常向调用方拒绝。
 */
// specifier是运行时路径字符串，返回Promise<unknown>要求调用方自行协调模块类型；不验证文件来源。
const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	// 本模块URL确实以.js结尾才把末尾.ts替换成.js；源码运行保持.ts，replace只改路径尾部，不搜索安装目录。
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	// 变量路径动态import使打包器无法静态跟进Node专用实现，仍由宿主模块解析/加载，可拒绝。
	return import(runtimeSpecifier);
};

// 模块级可变覆盖引用，未设置时undefined；所有工厂实例共享它，不是每个对象一份。
let bedrockModuleOverride: ProviderStreams | undefined;

/**
 * Overrides the dynamically imported bedrock implementation. Used by the Bun
 * binary build, where the variable-specifier import cannot be bundled; the
 * build registers a statically imported module instead.
 */
/**
 * 设置共享Bedrock实现覆盖，供Bun二进制把静态打包模块接入延迟入口，无返回值。
 * 例：setBedrockProviderModule(module)后新一次流调用优先用module，不再走变量动态导入；不终止旧流、不清宿主模块缓存，类型契约不等于运行时校验。
 */
// 输入为满足ProviderStreams的实现对象，返回void，不在此加载/验证它。
export function setBedrockProviderModule(module: ProviderStreams): void {
	// 保存原引用，后续加载闭包优先读此值；不复制、不销毁旧实现，也不替换已经返回的内部流。
	bedrockModuleOverride = module;
}

/**
 * 创建Bedrock聊天延迟接口，构造时不加载AWS SDK；流方法调用时优先选共享覆盖，否则变量路径导入。
 * 例：const api=bedrockConverseStreamApi()之后再设覆盖，后续api.stream仍读取最新覆盖；不承诺已开始等待的导入会被中途替换。加载/转发失败按lazyApi生成error结果。
 */
// 无参箭头工厂返回聊天能力对象；此时仅构造闭包。
export const bedrockConverseStreamApi = (): ProviderStreams =>
	// 沿用lazyApi同步外层流+异步准备/错误事件机制。
	lazyApi(
		/**
		 * 延迟选择当前覆盖或实际模块，返回Promise<ProviderStreams>。例：覆盖存在即短路，缺省才await导入；不是工厂首次调用时固定一次选择。
		 */
		// 每次流方法调用才运行async加载器，Promise结果由lazyApi等待。
		async () =>
			// ??仅在覆盖值null/undefined时才动态加载；as只是声明模块符合接口，不检查导入结果形状。
			bedrockModuleOverride ?? ((await importNodeOnlyApi("./bedrock-converse-stream.ts")) as ProviderStreams),
	);
