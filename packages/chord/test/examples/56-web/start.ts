// 文件导读
// 所属：packages/chord/test/examples/56-web，Chord 示例 56（board 应用）；示例 57、58 也复用这里的启动逻辑。
// 作用：把 board 应用交给 app kit 的 `startServer`：声明 API 模块、三种宿主种类（server/web/tui）、
// principal、web 页面入口与模板、终端入口。`startServer` 负责建目录、单实例锁、store、HTTP、
// 插件构建与发布，以及 owner 登录链接。
// 上游：示例入口 main.ts 先 `boardDirectories()` 得到临时数据目录和可编辑的插件副本，再调用
// `startBoard()`；示例 57/58 用同样的两步启动。
// 下游：packages/chord/src/node/app/index.ts 的 `startServer`、packages/chord/src/node/surfaces/
// index.ts 的 `pageScripts`，以及 app/v1.ts 的 API 模块表。副作用：创建临时目录、复制 plugins/、
// 监听回环端口、打开 store；失败通过 Promise 拒绝并打印到 onError。
// 能力清单：
// - `page`：生成 board 页面的 HTML 模板（私有函数，交给 startServer）；
// - `boardDirectories`：新建临时目录，复制一份 plugins/ 供示例修改，返回各路径；
// - `startBoard`：以给定目录启动服务器并返回运行中的 `App<BoardPrincipal>`。
// 典型调用（示例）：
//   const { dataDir, root } = await boardDirectories();
//   const app = await startBoard(dataDir, root, context);
//   console.log(app.ownerLink());
// 阅读顺序：先看 `startBoard` 的选项对象，再看 `page` 与 `boardDirectories`；运行细节在
// src/node/app/app.ts 的 startServer 主流程中。
// 运行方式：由 main.ts 调用；单独运行没有输出。数据目录是临时目录，示例结束时由调用方删除。
// 注意：`port: 0` 让操作系统分配空闲端口，测试可并行；`kinds` 中的 web/tui 名称必须与
// api/facet 种类一致，startServer 会在启动时按名称查找。

// The board app's start: its API, its kinds (the server, the web page, the terminal), its web entry and page template
// and its terminal entry, given to `startServer` (slice 13) with the surfaces of slice 11. Examples 56 to 58 call
// `startBoard` with a copy of `plugins/` they may edit.

// Node 内建模块：cp/mkdtemp 做文件复制与临时目录，tmpdir/join 拼路径，fileURLToPath 把 import.meta.url
// （file: URL）转成操作系统路径。这些导入没有副作用。
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// `import type` 只引入类型，编译/类型剥离后不产生运行时导入。
import type { Context } from "../../../src/context/index.ts";
import { type App, startServer } from "../../../src/node/app/index.ts";
import { type PageAssets, pageScripts } from "../../../src/node/surfaces/index.ts";
import type { BoardPrincipal } from "./app/principals.ts";
import * as v1 from "./app/v1.ts";

// 函数说明：page 生成页面 HTML。输入 request.nonce（CSP 随机数）和 assets（表面构建出的样式/脚本 URL）。
// 输出一个完整 HTML 字符串。无副作用、无 I/O。流程：拼接 doctype、head、pageScripts 注入的标签、
// body 挂载点。`pageScripts` 会给每个 <script> 带上 nonce，满足服务端 CSP。
// 示例：page({ nonce: "abc" }, assets) 返回形如
//   <!doctype html><html lang="en">...<script nonce="abc">...</script>...</html>
// 说明：这是真实运行路径——startServer 把这个函数存为页面模板，处理 GET / 时调用。
/** The board's page: the app's own template, the surface's assets in it. */
function page(request: { readonly nonce: string }, assets: PageAssets): string {
	// 数组元素逐行拼接，最后 join("\n")；模板里只有静态 HTML，不含用户输入，因此不需要转义。
	return [
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Board</title>',
		// 注入样式表、bootstrap 内联脚本和两个 defer 脚本；nonce 同时用于内联脚本的 CSP 校验。
		pageScripts(assets, request.nonce),
		'</head><body><div id="root"></div></body></html>',
	].join("\n");
}

// 函数说明：boardDirectories 准备示例用的隔离目录。输入无；输出 base（临时根）、dataDir（数据目录）、
// root（插件副本根）。副作用：创建临时目录并递归复制 plugins/。失败时 Promise 拒绝，已创建的临时目录
// 由调用方负责清理（示例结束时 rm(base)）。
// 流程：mkdtemp 建唯一目录 → 在 base 下算出 dataDir 与 plugins 路径 → 递归复制。
// 示例：const { base, dataDir, root } = await boardDirectories();
// 说明：复制插件是为了让示例 56 第 4 步能改写 clock/web.ts 而不污染仓库源码。
/** A data directory and a copy of the board's plugins, in a new temporary directory. */
export async function boardDirectories(): Promise<{
	readonly base: string;
	readonly dataDir: string;
	readonly root: string;
}> {
	// `board-` 前缀让临时目录易于识别；join(tmpdir(), ...) 跨平台。
	const base = await mkdtemp(join(tmpdir(), "board-"));
	// 插件根位于临时目录下的 plugins/，startServer 从这里构建内置插件。
	const root = join(base, "plugins");
	// import.meta.url 是当前模块的 file: URL；new URL("./plugins/", ...) 相对于本文件解析；
	// fileURLToPath 再转成本地路径。cp 的 recursive: true 才能复制目录。
	// 注意：仓库内示例用这种方式定位资源，而不是依赖 process.cwd()。
	await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });
	// dataDir 此时可以不存在；startServer 会创建并持有单实例锁。
	return { base, dataDir: join(base, "data"), root };
}

// 函数说明：startBoard 启动 board。输入 dataDir/root（由 boardDirectories 得到）和 context（取消与
// 遥测）。输出运行中的 App<BoardPrincipal>。副作用：监听回环端口、建 store、构建 web/tui base
// bundle、加载插件。失败：startServer 会先关闭已打开资源再拒绝；错误最终由示例进程抛出。
// 流程：组装 AppOptions → startServer 按其固定顺序 openServer/createHost/createHttp/plugins/
// workers/surfaces/load → 返回 App。
// 示例：const app = await startBoard(dataDir, root, ctx);
// 说明：这是真实运行路径；泛型参数 <BoardPrincipal> 让 api/principal/kinds 的身份类型一致。
/** Starts the board on a free loopback port. */
export function startBoard(dataDir: string, root: string, context: Context): Promise<App<BoardPrincipal>> {
	// 返回 Promise 而不是 async 函数：直接把 startServer 的 Promise 透传，少一层包装。
	return startServer<BoardPrincipal>(
		{
			// name 决定默认数据目录、归档字段与进程锁前缀；这里显式给了 dataDir，仍用于命名。
			name: "board",
			dataDir,
			root,
			// 只监听本机回环地址；port 0 表示由操作系统选一个空闲端口。
			listen: { host: "127.0.0.1", port: 0 },
			// api 告诉 kit 插件可导入哪些模块：版本 v1 与模块表。
			// `versions` 决定 web 客户端能请求哪些 API 版本；modules 的键是插件里的 import 说明符。
			api: { name: "@board/app", versions: ["v1"], modules: { "@board/app/v1": v1 } },
			// kinds 为每种 facet 提供平台与打包信息：
			// - server 在 Node 中运行；
			// - web 在浏览器中运行，并允许插件脚本 import react 与 react/jsx-runtime；
			// - tui 在 Node 中运行。
			kinds: {
				server: { platform: "node" },
				web: { platform: "browser", packages: { react: {}, "react/jsx-runtime": {} } },
				tui: { platform: "node" },
			},
			// principal.server 是服务器身份；worker 回调按地址生成身份。本示例没有 worker，
			// 但 kit 的类型要求提供这个函数。
			principal: { server: { kind: "server" }, worker: () => ({ kind: "server" }) },
			// web.entry 是页面基础 bundle 的源码入口（默认导出 start）；page 是上面的 HTML 模板。
			web: { entry: fileURLToPath(new URL("./web/main.ts", import.meta.url)), page },
			// tui.entry 是终端客户端入口；终端会从服务器下载这段代码并在沙箱里运行。
			tui: { entry: fileURLToPath(new URL("./tui/main.ts", import.meta.url)) },
			// onError 是 kit 的统一错误通道：kind 区分 host/http/workers/plugins 等来源。
			onError: (error) => console.error("board:", error.kind, error.error),
		},
		context,
	);
}
