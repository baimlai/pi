// A CommonJS module of the app: given to plugins as the host package `@example/legacy`.

// 文件导读
// 所属：Chord 示例 37 的 app/ 目录，示例的 CommonJS 宿主包。
// 演示什么：同一个应用可以同时向插件提供 ES 模块（app/index.ts）和 CommonJS 模块（本文件）。main.ts 用
// `createRequire(import.meta.url)("./app/legacy.cjs")` 加载它，再以说明符 `@example/legacy` 放进 modules 表；
// Report 插件执行 `import legacy from "@example/legacy"` 时，构建保持 external，求值时的 require 返回这里的
// module.exports。宿主包若本来就是 CommonJS 对象，Chord 不再包装，esbuild 的默认导入互操作会直接拿到该对象。
// 扩展名 `.cjs` 强制 Node 按 CommonJS 解析：本仓库的 packages/chord/package.json 是 `"type": "module"`，
// 若用 `.js` 会被当成 ES 模块，`module.exports` 反而不可用。
// 上游：main.ts 的 modules 表；下游：Report 插件调用 legacy.pad("vat", 6)。
// 能力清单：
// - module.exports.pad(text, width)：用 "." 从左侧把文本补齐到 width 位。
// 示例（真实运行时值）：pad("vat", 6) 返回 "...vat"（3 个点加 3 个字母，总长 6）。
// 建议阅读顺序：先看 module.exports 的赋值，再看 pad 里的 padStart。

// CommonJS 的 module 和 exports 由 Node 在加载时注入，不是浏览器意义上的全局变量。
// 给 module.exports 赋一个新对象，等于替换整个模块的导出值；之后 require("@example/legacy") 得到这个对象。
module.exports = {
	// 方法简写：等价于 pad: function (text, width) { ... }。
	// 这是普通 JavaScript，没有类型注解；TypeScript 不做检查，运行时报错与否取决于调用方传入的值。
	pad(text, width) {
		// String(text) 先做显式转换；padStart(width, ".") 在长度不足 width 时反复用 "." 从左侧填充。
		// 若 width 小于等于当前长度，padStart 原样返回，不截断。
		return String(text).padStart(width, ".");
	},
};
