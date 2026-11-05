// The app's own code (base code): given to plugins as the host package `@example/app` (an ES module: a default export
// and named ones). A plugin imports it by that name, never by its path.

// 文件导读
// 所属：Chord 示例 37（packages/chord/test/examples/37-plugin-imports）的 app/ 目录，代表“应用基础代码”。
// 演示什么：这段代码不经过插件构建，而是由 main.ts 作为宿主包 `@example/app` 直接交给插件运行时；Report 插件的
// server facet 用 `import app, { currency } from "@example/app"` 引用它。构建时该说明符保持 external，求值时 require
// 返回本文件的 ES 模块命名空间（由 Chord 包一层 __esModule，使默认导入和命名导入都可用）。它同时演示同一个 ES 模块
// 可以同时提供默认导出和命名导出。
// 上游：main.ts 的 `import * as app from "./app/index.ts"`，放进 modules 表；下游：Report 插件打印 app.name、
// app.version 与 currency(1250)。
// 能力清单：
// - 默认导出：应用信息对象 `{ name: "example app", version: 3 }`。
// - currency(cents)：把以“分”为单位的数字格式化成欧元文本。
// 典型结果：Report 对象的 text 为
//   "example app v3 | EUR 12.50 | ...vat | 20% | hello, plugins | node_modules/example-native/index.js"。
// 示例（真实签名）：import app, { currency } from "@example/app";
//   app.name       // "example app"
//   currency(1250) // "EUR 12.50"
// 建议阅读顺序：先看默认导出的对象字面量，再看 currency 的参数类型、模板字符串和 toFixed。

// 默认导出：ES 模块的 default 绑定。对象字面量的字段由 TypeScript 推断为 string 与 number；
// 插件把 version 插进模板字符串时得到 "3"，不是带字母 "v" 的版本号。
/** The app's name and version. */
export default { name: "example app", version: 3 };

// 把“分”换算成欧元文本：先除以 100 换成欧元，再保留两位小数，最后加 "EUR " 前缀。
// 输入：cents（number，仅编译期检查）；输出：string；无副作用，正常情况下不抛错。
// 示例：currency(1250) 返回 "EUR 12.50"；currency(5) 返回 "EUR 0.05"。
// 注意：这里用浮点数演示格式化，真实记账应使用整数或定点数库。
/** Cents as a price. */
export function currency(cents: number): string {
	// 模板字符串中的 ${...} 会先求值括号里的表达式，再与其他文本拼接。
	// 括号必须保留：去掉后 `${cents / 100}.toFixed(2)` 会把数字和字面文本 ".toFixed(2)" 直接拼在一起。
	// toFixed(2) 返回带两位小数的字符串，但它会做二进制浮点舍入，并非精确的十进制货币计算。
	return `EUR ${(cents / 100).toFixed(2)}`;
}
