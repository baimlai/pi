// 文件导读
// 所属：packages/chord/test/examples/56-web，Chord 示例 56；本文件是 board 应用 API v1 的 web 子路径
// `@board/app/v1/web`。
// 作用：声明页面使用的 `Panels` 注册表。每个插件贡献一个面板（标题 + 文本），页面把所有面板
// 按插件名顺序合并后渲染成卡片。
// 上游：plugins/clock/web.ts、plugins/notes/web.ts 通过 `Panels` 贡献面板；
// web/main.ts 用 React 的 `useRegistry(Panels)` 订阅合并结果。
// 下游：只依赖 packages/chord/src/index.ts 的 `defineRegistry`，不产生 I/O。
// 能力清单：
// - `Panel`：一个面板的形状（title、text 均为只读字符串）；
// - `Panels`：注册表 token，贡献类型 `Panel`，合并值 `readonly Panel[]`。
// 典型用法（示例）：
//   self.contribute(Panels, { value: [{ title: "clock", text: "12:00" }], version: 1 });
// 阅读顺序：先看 `Panel` 类型，再看 `Panels` 泛型参数，最后看 web/main.ts 的渲染。
// 运行方式：随示例 56 的 web 页面客户端代码打包加载。
// 说明：`Panel` 是纯编译期结构类型；运行时只校验注册表名称和 version，不校验每个面板字段。

// The board app's API v1 for web facets (`@board/app/v1/web`): the `Panels` registry the page shows, one panel per
// contributing plugin.

// 路径从 app/v1/ 上溯五层到 packages/chord/。
import { defineRegistry } from "../../../../../src/index.ts";

// 结构类型（structural type）：只要对象形状匹配即可赋值，不需要显式 implements。
// `readonly` 阻止在编译期改写字段，运行时不冻结。
/** A panel on the board page: its title and its text. */
export type Panel = { readonly title: string; readonly text: string };

// 泛型参数：贡献类型是单个 `Panel`，合并类型是只读的 `Panel` 数组。
/** The page's panels, in plugin-name order. */
export const Panels = defineRegistry<Panel, readonly Panel[]>("board.panels", { version: 1 });
