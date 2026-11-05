// Chord v2's client surfaces, the server side (`@earendil-works/chord/surfaces`; slice 11 §1, §4): the web surface
// (base bundle, plugin scripts, `WebScripts`, the page) and the terminal surface.

// 此文件只重导出服务器端客户端资源组件，没有启动副作用：type 导出编译后擦除，值导出供应用显式调用。
// bundle/served 描述内存资源；web/tui 返回待加载的 facet 和 rollout 步骤，应用仍负责 host 与 HTTP 监听器。
// 所属：@earendil-works/chord/surfaces 的服务器侧出口（package exports 指向本目录）。
// 边界：只重导出类型/函数，不构建、不注册；应用需把返回的 facet 加入 host，并自行提供 HTML 模板与 HTTP 监听。
// 上游：应用 import；下游：bundle/served/tui/web 的实现。
// 导出清单：BaseBundle/ServedFile 是资源类型；TUI_PREFIX/TuiStart/TuiSurface/TuiSurfaceOptions/tuiSurface 是终端表面；
// PageAssets/pageScripts/WEB_PREFIX/WebSurface/WebSurfaceOptions/webSurface 是网页表面。
// 组合：webSurface/tuiSurface → facet 加载 → 路由与脚本对象；pageScripts 供应用模板插入标签。
// 示例：import { webSurface, pageScripts } from "@earendil-works/chord/surfaces";
// 阅读顺序：bundle → served → published/current → web/tui。

export type { BaseBundle } from "./bundle.ts";
export type { ServedFile } from "./served.ts";
export { TUI_PREFIX, type TuiStart, type TuiSurface, type TuiSurfaceOptions, tuiSurface } from "./tui.ts";
export {
	type PageAssets,
	pageScripts,
	WEB_PREFIX,
	type WebSurface,
	type WebSurfaceOptions,
	webSurface,
} from "./web.ts";
