// 文件导读
// 所属：packages/chord/test/examples/56-web，被示例 56 与 58 复用。
// 作用：在没有浏览器的 Node 进程里复现 `startPage` 的客户端引导流程：
//   1) 用 owner token 拉取页面 HTML，解析出 base bundle 哈希与插件合并文件 URL；
//   2) 用 node:vm 执行合并文件，收集它通过全局 `chordFacet` 注册的插件脚本；
//   3) 调用 `startClient` 建立宿主、连接 `/chord` WebSocket 链路，并跟随服务器脚本集合的变化；
//   4) 服务器换脚本时只下载变化的那一个并调用其 register 函数（原地更新）。
// 上游：示例 main.ts 的步骤 3 调用 `headlessPage(...)`；58 也这样做。
// 下游：src/surfaces/client.ts 的 startClient、src/surfaces/scripts.ts 的 WebScripts、
// src/link/websocket.ts 的 webSocketLink；ws 包的 WebSocket 客户端。
// 能力清单：
// - `run`：执行一段已构建的facade脚本，返回其中的注册项；
// - `headlessPage`：打开一个已登录的无头页面，返回运行中的 Client。
// 典型调用（示例）：
//   const page = await headlessPage(origin, token, { "@board/app/v1": v1 }, coreFacets);
//   const panels = await page.host.registry(Panels, context);
//   await page.stop(context);
// 阅读顺序：先看 `headlessPage` 的 startClient 选项，再看 `run` 如何模拟浏览器的注册全局。
// 运行方式：被示例入口导入，不单独运行；需要 Node 的 vm 与 ws 依赖（仓库已安装）。
// 限制：没有 DOM。页面“渲染”的内容不在这里出现，示例改为直接从宿主读取注册表值。
// 注意：正则中的 `!` 是非空断言（TypeScript 语法），表示作者确认匹配一定存在；
// 运行时若页面模板变化导致不匹配，会在这里抛错，而不是静默继续。

// A page without a browser, for examples 56 and 58: what `startPage` does, run in Node. It loads the page's combined
// file and runs its registered scripts (`vm` here; `<script src>` in a browser), connects to `/chord` with the session
// token, and keeps its plugins current with `startClient` (the same code `startPage` runs). No DOM: what the page would
// render is read from its host.

// node:vm 的 Script 编译一段源代码，runInThisContext 在“当前”全局环境执行它。
import { Script } from "node:vm";
// ws 是 Node 常用的 WebSocket 客户端；页面里对应的实现是浏览器原生 WebSocket。
import { WebSocket } from "ws";
import {
	type Client,
	type ClientModules,
	type FacetFunction,
	type PluginFacet,
	REGISTER,
	type RegisteredScript,
	startClient,
	WebScripts,
	type WebSocketLike,
	webSocketLink,
} from "../../../src/index.ts";
import type { BoardPrincipal } from "./app/principals.ts";

// 函数说明：run 执行构建产物中的一段注册脚本。输入 text（脚本文本，内部会调用全局
// `chordFacet(plugin, digest, fn)`）。输出本次执行产生的注册项数组。副作用：安装/覆盖
// globalThis[REGISTER] 这个全局钩子。错误：脚本语法或执行错误会直接抛出。
// 流程：建空数组 → 把全局 chordFacet 指向“push 到数组”的回调 → 编译并执行 → 返回数组。
// 示例：const [registered] = run(scriptText);
// 说明：浏览器里由 base bootstrap 定义 window.chordFacet；这里手工做同样的事，所以页面与
// 无头环境运行的是同一份客户端代码。
/** Runs registered scripts' `text` and returns what registered. */
function run(text: string): RegisteredScript[] {
	// 每个脚本可能注册多个 facet（例如一个 web facet 与一个 styles 贡献），因此用数组收集。
	const registered: RegisteredScript[] = [];
	// REGISTER 的值是字符串 "chordFacet"；先断言 globalThis 为普通可索引对象，再挂函数。
	// 回调参数 plugin/digest/f 与 registeredSource 生成的调用形状一致。
	(globalThis as Record<string, unknown>)[REGISTER] = (plugin: string, digest: string, f: FacetFunction) =>
		registered.push({ plugin, digest, run: f });
	// 编译后立即执行；runInThisContext 共享当前全局对象（能读到刚安装的钩子），但访问不到本函数的局部变量。
	new Script(text).runInThisContext();
	return registered;
}

// 函数说明：headlessPage 打开一个无头页面。输入 url（服务器 origin，如 http://127.0.0.1:1234）、
// token（owner 设备 token）、modules（插件脚本可 import 的模块表）、core（应用自身 facets）。
// 输出运行中的 Client<BoardPrincipal>，其 host 已加载全部插件。副作用：发起 HTTP 请求、建立
// WebSocket、创建宿主并启动连接/更新循环；调用方负责 page.stop()。错误：HTTP/WS/脚本执行/宿主
// 加载失败都会让 Promise 拒绝，或经 onError 打印。
// 流程：拉页面 → 解析 base 与合并脚本 URL → 执行合并脚本 → startClient（连接 + 跟随脚本集）。
// 示例：const page = await headlessPage(link.origin, token, { "@board/app/v1": v1 }, core);
/** Opens a headless page of the app at `url` signed in with `token`. */
export async function headlessPage(
	url: string,
	token: string,
	modules: ClientModules,
	core: readonly PluginFacet<BoardPrincipal>[],
): Promise<Client<BoardPrincipal>> {
	// 请求头复用：页面 HTML、插件脚本、base 查询都带同一个 Bearer token。
	const headers = { authorization: `Bearer ${token}` };
	// get 是便捷函数：解析相对路径、发起 GET、读取文本；类型注解表明返回 Promise<string>。
	const get = async (path: string): Promise<string> => (await fetch(new URL(path, url), { headers })).text();
	// 页面模板由 start.ts 提供，其中内联 bootstrap 会写入 chordPage 配置。
	const html = await get("/");
	// 第一个捕获组是 base bundle 的十六进制内容哈希；非空断言表示模板保证存在这段文本。
	const base = /chordPage=\{base:"([0-9a-f]+)"/.exec(html)![1]!;
	// 第二个正则从 <script src="..."> 中取出插件合并文件（启动时所有插件打成一个文件）。
	const combined = /src="(\/_chord\/web\/plugins\.[0-9a-f]+\.js)"/.exec(html)![1]!;
	// startClient 是页面与终端共用的客户端引导：加载初始脚本、连接服务器、跟随脚本集合变化。
	return startClient<BoardPrincipal>({
		// 本客户端种类使用的脚本契约（web 版）；它定义服务器上保存当前脚本集合的远程对象。
		scripts: WebScripts,
		// 本地运行的基础 bundle 哈希；与服务器不一致时，客户端代码已过期，需要整页重载。
		base,
		// 初始插件脚本来自刚才执行的合并文件；顺序无关，startClient 会按插件名建索引。
		initial: run(await get(combined)),
		// 应用 API 模块：插件脚本中的 import 说明符映射到真实模块对象。
		modules,
		// 应用自己的 facets，和插件一起交给 host.load；插件失败不会影响它们。
		core,
		// open 由平台注入：建立一条到服务器的链路，并把 open/message 事件报告给重连循环。
		open: (events) => {
			// WebSocket 需要 ws:// 或 wss://；replace(/^http/, "ws") 把 http→ws、https→wss 的前缀改掉。
			// new URL("/chord", ...) 解析到服务器的 Chord 链路端点。
			const socket = new WebSocket(new URL("/chord", url.replace(/^http/, "ws")), { headers });
			// ws 包用事件名注册回调：连接建立与收到任意消息都只用于驱动连接状态机。
			socket.on("open", () => events.opened());
			socket.on("message", () => events.received());
			// ws 的 WebSocket 与浏览器 WebSocket 类型不完全一致；Chord 只依赖一个结构化子集，
			// 因此先经 unknown 再断言为 WebSocketLike（一次有意的、局部化的类型桥接）。
			return webSocketLink(socket as unknown as WebSocketLike);
		},
		// 服务器更新脚本集合后，客户端对每个新条目调用 fetchScript：下载并执行，取第一条注册项。
		// 一个脚本文件对应一个插件 facet，所以 [0] 就是该条目；非空断言表示脚本必须注册。
		fetchScript: async (entry) => run(await get(entry.url))[0]!,
		// 每次重连前询问服务器当前 base；返回解析后的 JSON 字符串。
		serverBase: async () => JSON.parse(await get("/_chord/web/base")) as string,
		// base 不一致时调用：真实浏览器会整页刷新；无头示例只打印提示，不重建页面。
		outdated: () => console.log("   (the page would reload: the server has a new base bundle)"),
		// 注入时钟、定时器、在线状态与唤醒源，让 startClient 不直接依赖浏览器全局。
		environment: {
			now: () => Date.now(),
			// after 安排在 ms 毫秒后执行 callback，并返回取消函数（与浏览器的 setTimeout 对齐）。
			after: (ms, callback) => {
				const timer = setTimeout(callback, ms);
				return () => clearTimeout(timer);
			},
			// 无头环境始终在线；onWake 返回一个空的取消函数，表示没有外部唤醒源。
			online: () => true,
			onWake: () => () => {},
		},
		// 所有客户端错误（host/plugins/update_failed）都从这里报告；示例只打印 kind。
		onError: (error) => console.log("   page:", error.kind),
	});
}
