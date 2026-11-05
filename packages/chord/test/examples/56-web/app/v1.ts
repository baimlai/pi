// 文件导读
// 所属：packages/chord/test/examples/56-web，Chord 示例 56；本文件是 board 应用的 API v1 桶文件
// （barrel file），通过子路径 `@board/app/v1` 被各插件的 facet 导入。
// 作用：把插件允许使用的 Chord 公共 API 集中再导出，并额外公开 app kit 的 `Themes` 注册表。
// 同一份 v1 API 被 web、TUI、服务端等所有宿主种类共享，避免每个插件各自深入 `src/` 路径。
// 上游：examples 56 到 58 都运行这个 board 应用；插件（plugins/clock、plugins/notes）从
// `@board/app/v1` 导入这里列出的名字。
// 下游：重新导出 packages/chord/src/index.ts 的真实导出，本身不执行逻辑、不产生 I/O。
// 能力清单（再导出项）：
// - `constant`：把普通值包装成只读的 Watchable 状态成员；
// - `defineFacet`：声明一个 facet（插件向宿主贡献能力的最小单元）；
// - `local`：声明只在本宿主内可见的局部契约；
// - `method`：声明方法参数/返回值 schema；
// - `str`：字符串 schema 构造器；
// - `Theme`（类型）：主题描述的形状；
// - `Themes`：app kit 内置的主题注册表。
// 典型用法（示例）：插件里写
//   import { defineFacet, Themes } from "@board/app/v1";
// 阅读顺序：先看再导出列表，再按需跳到 packages/chord/src/index.ts 中对应声明。
// 运行方式：本文件不单独运行；它由示例 56 的 start.ts 启动流程间接加载。
// 注意：`export { ... } from "..."` 只转出名字，不引入本地绑定；`type Theme` 前面的 `type`
// 明确告诉编译器这是仅类型导出，编译后不会留下运行时代码。

// The board app's API, version 1, shared by every host kind (`@board/app/v1`): the part of Chord its plugins use, the
// kit's `Themes` registry (examples 56 to 58 run this app).

// 相对路径从 app/ 上溯四层到 packages/chord/，再进入 src/index.ts；
// 带 `.ts` 扩展名是仓库内 Node 原生类型剥离运行方式的要求。
export {
	constant,
	defineFacet,
	local,
	method,
	str,
	type Theme,
	Themes,
} from "../../../../src/index.ts";
