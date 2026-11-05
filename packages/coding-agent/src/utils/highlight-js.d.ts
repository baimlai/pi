// 给highlight.js的具体子路径补上本仓库用到的最小类型视图；.d.ts只声明，不生成JS/导入库/实际执行高亮。
// 本文件没有顶层import/export，下面普通interface属于声明文件的全局类型范围；不是给库补运行时字段。
interface HighlightJsResult {
	// 仅声明消费方需要的HTML文字；真实库还返回relevance等字段，本地视图并不穷举。
	value: string;
}

// 显式语言高亮的选项，例如{language:'typescript',ignoreIllegals:true}，不是待高亮源码。
interface HighlightJsOptions {
	// 语言名/别名，类型string不证明已登记该语言。
	language: string;
	// ?表示可省；具体默认和异常规则由真实库处理，不由接口补值。
	ignoreIllegals?: boolean;
}

// 本地只需要语言定义的可选显示名；不在此完整描述highlight.js所有语法规则。
interface HighlightJsLanguageDefinition {
	// readonly仅限制TS经此视图重赋值，缺名仍合法，不冻结真实语言对象。
	readonly name?: string;
}

// 语言模块导出的工厂类型，接收库API并返回语法定义；这里只声明签名，registerLanguage在调用时才执行工厂。
type HighlightJsLanguageFactory = (hljs: HighlightJsApi) => HighlightJsLanguageDefinition;

// 项目实际使用的API子集；方法签名没有函数体，不代表增加了一套高亮实现。
interface HighlightJsApi {
	// 指定语言高亮源码，返回HTML的value；例如highlight('const x=1',{language:'javascript'})，不执行这段源码。
	highlight(code: string, options: HighlightJsOptions): HighlightJsResult;
	// 自动识别语言，可选数组限制候选；返回视图仍只暴露value，不证明识别必定正确。
	highlightAuto(code: string, languageSubset?: string[]): HighlightJsResult;
	// 查已注册语言，不存在得undefined；不是去网络下载语法。
	getLanguage(name: string): HighlightJsLanguageDefinition | undefined;
	// 返回已登记语言的名字数组，例如用于限制自动识别范围。
	listLanguages(): string[];
	// 注册一个语言工厂供后续高亮；返回void，不返回高亮结果或自动识别分数。
	registerLanguage(name: string, language: HighlightJsLanguageFactory): void;
}

// 带引号的declare module描述这个精确导入路径；ambient声明会擦除，不是运行时namespace。
declare module "highlight.js/lib/core.js" {
	// const在这里声明模块有一个这样的值，不在声明文件内new或加载它。
	const hljs: HighlightJsApi;
	// 对应import hljs from该路径；export default声明默认导出类型。
	export default hljs;
}

// 全语言入口也给相同最小API视图，不表示core与index在真实运行时加载成本相同。
declare module "highlight.js/lib/index.js" {
	// 模块自己的默认库对象，类型契约与core一致。
	const hljs: HighlightJsApi;
	// 只约束这个路径的默认导入，没有在此注册全部语言。
	export default hljs;
}

// '*'是ambient模块名匹配：如.../languages/typescript.js，导出的应是语言工厂而不是库总对象。
declare module "highlight.js/lib/languages/*.js" {
	// 声明默认值为可供registerLanguage调用的工厂。
	const language: HighlightJsLanguageFactory;
	// 与普通export default运行表达式不同，此处只描述外部JS模块的类型。
	export default language;
}
