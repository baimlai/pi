// 文件导读
// 所属：packages/chord/test/examples/50-plugin-imports/words，本地依赖包 @bob/words 的源码。
// 作用：提供 VERSION 常量和 words(text) 计数函数；example 50 把它提交两次（版本 1 和 2），并把依赖钉在第一个提交。
// 上下游：npm 按同目录 package.json 的 exports "." -> ./words.ts 解析；stats 插件构建时把安装版本内联进脚本。
// 能力：VERSION（当前提交的版本字符串）；words（把文本按空白切分并计数）。
// 运行：不单独运行；由 example 50 的 npm install 与构建使用。
// 示例：words("buy milk, call bob") 返回 4。
// 阅读顺序：本文件 -> user/stats/server.ts。
// `@bob/words`: a package in its own git repository (the example commits it twice: this file, then a version 2).

/** The version of this commit. */
// const 声明让 VERSION 推断为字面量类型 "1"；example 50 修改源码文本后提交第二次，版本变为 "2"。
export const VERSION = "1";

/** The words in `text`. */
// 参数和返回值都有类型注解（string -> number），这是编译期约束。
// /\s+/ 匹配一段连续空白；filter(Boolean) 去掉空串（例如首尾空白产生的空段）；length 是词数。
export function words(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}
