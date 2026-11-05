// 文件导读
// 所属：packages/chord/test/examples/39-browser-build/plugins/bad-web，故意无法构建的浏览器 facet（@example/bad-web）。
// 作用：演示浏览器构建拒绝 Node 内置模块。build 不抛错，而是为这个 facet 返回 { kind: "failed", errors }；错误
// 文本来自 esbuild 的定位，形如 web.ts:<行>:<列>: "node:path": a Node builtin in a browser build。
// setup 里的 console.log 永远不会执行：脚本没有通过构建，也就没有可求值的 facet。
// 同目录 package.json 提供插件名 @example/bad-web；发现阶段读取清单的 name 并校验为合法包名，private 与 type 不参与发现。
// 上游：discover/build；下游：node:path 与 @earendil-works/chord。输出：无（构建失败，没有脚本/资源）。
// 能力清单：default export 是一个 setup；它只在构建成功时才会被调用。
// 示例（本文件当前内容运行后的真实失败文本）：web.ts:14:22: "node:path": a Node builtin in a browser build
// 建议阅读顺序：先读 import 为什么在浏览器构建中被拒，再看 39/main.ts 第 2 步打印的 bad.errors。

// The bad-web plugin's web facet: a Node builtin has no place in a browser build (refused at build).

import { join } from "node:path";
import { defineFacet } from "@earendil-works/chord";

// 静态 import 在构建期就能被 esbuild 看到，所以组件无需运行代码即可拒绝；错误中的行列指向 import 语句。
// 若构建成功，setup 会在宿主加载时执行并打印 join 的结果；本示例中它不会到达这一步。
export default defineFacet(() => {
	console.log(join("a", "b"));
});
