// 文件导读
// 所属：packages/chord/test/examples/50-plugin-imports/user/stats，stats 插件的环境类型声明。
// 作用：在依赖尚未安装时描述 @bob/words 的类型，让编辑器和 tsc 能检查 stats/server.ts。构建使用 esbuild，不做类型
// 检查，因此本文件不参与运行时，也不会被打进插件脚本。
// 上下游：TypeScript 编译器/IDE 读取；example 50 的运行时流程不读取。依赖安装后，包自身的 exports/types 接管解析。
// 能力：declare module "@bob/words" 声明常量 VERSION 和函数 words(text): number。
// 运行：无独立运行；对示例目录做类型检查时生效。
// 示例：见下方声明；它只提供编译期形状，真实实现来自 words/words.ts。
// 阅读顺序：本文件 -> user/stats/server.ts -> words/words.ts。
// Types of the stats plugin's dependency before it is installed (its own types once installed).

// declare module 声明一个环境模块（ambient module）：这里只有类型，没有可执行代码。
// 模块内的 export 描述该模块被导入时的形状，实际实现由安装后的包提供。
declare module "@bob/words" {
	// 类型注解只约束使用方；运行时值由真实包导出。
	export const VERSION: string;
	// 函数签名：接收 string，返回 number。
	export function words(text: string): number;
}
