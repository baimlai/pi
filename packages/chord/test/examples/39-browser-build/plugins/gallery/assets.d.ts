// 文件导读
// 所属：packages/chord/test/examples/39-browser-build/plugins/gallery，gallery 插件的类型声明文件（不参与运行时）。
// 作用：让 TypeScript 接受两种浏览器构建特有的导入：副作用导入 CSS（构建时收集成唯一的 CSS 文件），以及带
// ?url 后缀的资源导入（构建时替换为 publicPath 下的 URL 字符串）。本文件不被任何 import 引用，esbuild 不会把它
// 当作构建输入；导入的真正含义由构建器实现。
// 上游：gallery/web.ts 的 import 需要这些声明才能通过类型检查；下游：无。没有运行时值、I/O 或输出。
// 能力清单：
// - `declare module "*.css" {}`：通配模块声明，只表示“这个模块存在”，供 `import "./x.css"` 使用。
// - `declare module "*?url"`：通配模块声明，默认导出 string，供 `import logo from "./x.svg?url"` 使用。
// 示例（编译期类型，不是运行时调用）：
//   import "./gallery.css";            // 匹配 "*.css"
//   import logo from "./logo.svg?url"; // logo 的类型是 string
// 建议阅读顺序：先看两个 declare module，再看 gallery/web.ts 的两个 import；注意 .d.ts 本身不会被 esbuild 打包。

// Types for what a browser build imports besides code: a stylesheet (collected into the build's one CSS file) and an
// asset by URL (`./file.svg?url`: the URL the app serves it under, as a string).

// 空模块体足够满足副作用导入；它没有声明任何导出，因此不能用默认导入读取 CSS。
declare module "*.css" {}

// 通配符按说明符文本匹配；默认导出声明为 string，对应构建时生成的 "/plugin-assets/name-hash.svg"。
// 这是编译期承诺，构建器不读取本文件；若构建配置改变，类型仍然是 string，无法在类型层面校验 URL 的形状。
declare module "*?url" {
	const url: string;
	export default url;
}
