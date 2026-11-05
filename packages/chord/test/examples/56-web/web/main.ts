// 文件导读
// 所属：packages/chord/test/examples/56-web/web，Chord 示例 56 的页面入口；start.ts 把它作为 web.entry。
// 作用：页面基础 bundle（浏览器 IIFE）的源码：
//   1) 声明应用 core facet，作为 Panels 注册表提供者；
//   2) 定义 React 组件 Board，用 `useRegistry` 订阅面板并渲染；
//   3) `startPage` 读取页面 bootstrap、加载插件、连接 /chord，然后把 host 交给 render；
//   4) render 用 React 18 的 createRoot 把 <HostProvider> 挂到 #root。
// 上游：服务器启动时 esbuild 从本文件构建 base.<hash>.js，页面通过 <script> 执行；
// 模块底部主动调用 start()，因此 IIFE 一执行就启动页面，同时保留具名导出供测试/打包器使用。
// 下游：react、react-dom/client、react/jsx-runtime、src/react 的 HostProvider/useRegistry、
// src/web 的 startPage；插件 clock/web.ts 与 notes/web.ts 向 Panels 贡献面板。
// 能力清单：
// - `Board`：读取注册表并渲染 <main> 与若干 <section>；
// - `start`：调用 startPage 并把 React 根挂载到页面。
// 典型行为：页面标题下方出现 "Clock" 与 "Notes" 两张卡片；插件热更新后卡片文本原地变化。
// 阅读顺序：先看 start()，再看 Board 与 useRegistry，最后看 core 的 compose。
// 运行方式：不单独运行；由示例 56 的服务器构建并送达浏览器或无头页面。

// The board app's web entry (the base bundle the server builds at start): `startPage` with the app's web modules and
// React, a core facet serving `Panels`, and a React page showing the panels (`useRegistry`).

// React 用作模块表条目（插件脚本可 import），并取 createElement 的短别名 h 来写无 JSX 的组件。
import * as React from "react";
import { createElement as h } from "react";
// jsx-runtime 是自动 JSX 运行时；插件里的 JSX 编译后 require 它，因此必须放入模块表。
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import * as chord from "../../../../src/index.ts";
// HostProvider 通过 React context 把 Chord 客户端宿主传给 hooks；useRegistry 订阅注册表。
import { HostProvider, useRegistry } from "../../../../src/react/index.ts";
import { startPage } from "../../../../src/web/index.ts";
import * as v1web from "../app/v1/web.ts";
import * as v1 from "../app/v1.ts";

// 应用 facet：服务 Panels 注册表。compose 必须同步且总是返回值；这里把贡献表映射为 Panel 数组。
const core = chord.defineFacet((host) =>
	host.serve(v1web.Panels, { compose: (table) => table.map(({ value }) => value) }),
);

// 函数说明：Board 是页面根组件。输入无（宿主从 React context 取）；输出 React 元素。
// 副作用：订阅 Panels 注册表，变化时组件重渲染；无 I/O。
// 流程：useRegistry 取当前面板数组（初始 undefined 时用空数组）→ 映射 section。
// 示例：在 <HostProvider host={host}> 内部渲染 <Board />。
// 说明：useRegistry 返回 undefined 表示组合值尚未到达；`?? []` 保证首次渲染安全。
// 每个 section 的 key 用 title：在本示例中标题唯一；真实应用应使用稳定 id。
function Board() {
	const panels = useRegistry(v1web.Panels) ?? [];
	// h(标签, props, ...子节点)：没有 JSX 时的等价写法。
	// 展开运算符 ...panels.map(...) 把子元素数组展开成 h 的变参。
	// h2 承载标题，text 作为文本子节点；React 会自动转义文本，避免把插件内容当 HTML。
	return h("main", null, ...panels.map(({ title, text }) => h("section", { key: title }, h("h2", null, title), text)));
}

/** Starts the page (the entry's caller: Chord's package has no side effects for bundlers). */
// 函数说明：start 启动页面客户端。输入无（连接参数从当前 location 读取）；输出 void，
// 内部 Promise 用 void 丢弃。副作用：加载插件、建立 WebSocket、渲染 React 根；启动失败成为
// 未处理拒绝（浏览器控制台可见）。
// 示例：start();  // 页面入口底部调用一次
export function start(): void {
	// startPage 返回 Promise<Client>；`void` 明确表示不在这里等待。
	void startPage({
		// 连接循环每次重连都调用 connect；页面与服务器同源，因此从 location.origin 推导 ws/wss URL。
		// replace(/^http/, "ws") 同时覆盖 http→ws 与 https→wss。
		connect: () => new WebSocket(`${location.origin.replace(/^http/, "ws")}/chord`),
		// 插件脚本可 import 的模块：应用 API、React 与 JSX 运行时（与 start.ts 的 kinds.web.packages 对应）。
		modules: { "@board/app/v1": v1, "@board/app/v1/web": v1web, react: React, "react/jsx-runtime": jsx },
		// 应用 facet；主题 facet 由 startPage 自动加上。
		core: [{ name: "@board/core", facet: core }],
		// render 在插件加载完成后调用一次；document.getElementById 的 `!` 是非空断言，
		// 因为模板保证存在 <div id="root">。createRoot(...).render(...) 挂载 React 树。
		// HostProvider 把 host 放进 context，Board 里的 useRegistry 才能找到它。
		render: (host) => createRoot(document.getElementById("root")!).render(h(HostProvider, { host }, h(Board))),
	});
}

// 入口副作用：作为浏览器 IIFE 运行时立即启动页面；具名导出 start 供其他入口/测试复用。
start();
