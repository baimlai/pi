// Chord v2's web surface, the browser side (`@earendil-works/chord/web`; slice 11 §2): `startPage` in the app's web
// entry, and the themes it writes. The server side is `/surfaces`.
// 此文件只转出浏览器入口与主题适配器；export type 的类型在 JS 中会被擦除，导入本入口本身不会启动页面。
// 所属：@earendil-works/chord/web 的浏览器侧出口；不包含服务器路由或构建逻辑。
// 边界：只重导出，导入时不启动页面；startPage 必须由应用入口显式调用，pageEnvironment 只是工厂。
// 导出：pageEnvironment；PageOptions/startPage；followThemes。
// 组合：应用入口 → startPage → 内部使用 environment/scripts/themes；服务器侧在 /surfaces。
// 示例：import { startPage } from "@earendil-works/chord/web";
// 阅读顺序：environment → page → scripts → themes。

export { pageEnvironment } from "./environment.ts";
export { type PageOptions, startPage } from "./page.ts";
export { followThemes } from "./themes.ts";
