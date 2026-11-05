// 文件导读
// 所属：packages/chord/test/examples/59-chat，Chord 示例 59（多 channel 聊天）。
// 作用：chat 应用的启动定义，被 main.ts 与交互终端复用：
//   - `API`：应用 API 名称、版本和三个模块表（共享 v1、服务器 v1/server、worker v1/worker）；
//   - `KINDS`：四种 facet 宿主种类及平台/打包信息；
//   - `page`：/chat 页面模板，注入 web surface 的脚本与样式；
//   - `chatDirectories`：临时数据目录 + 插件副本；
//   - `startChat`：调用 startServer，声明一个 server、每频道一个 worker（Channel kind）、web 与 tui。
// 上游：main.ts 在示例开头调用 chatDirectories + startChat；--serve 模式保留服务器。
// 下游：src/node/app 的 startServer/pageScripts，以及 app/v1.ts 的 Channel/contracts。
// 能力清单：
// - API/KINDS 常量；page/chatDirectories/startChat 三个函数。
// 典型调用（示例）：
//   const { base, dataDir, root } = await chatDirectories();
//   const app = await startChat(dataDir, root, context);
//   const url = new URL(app.ownerLink()).origin;
// 阅读顺序：先看 API/KINDS，再看 startChat 的 workers 与 principal 配置。
// 运行方式：由 main.ts 调用；数据目录是临时目录，示例结束时删除。
// 安全边界：worker 的 authorize 只允许 user/owner 持有频道对象；workers 通过 execArgv 以源码
// 方式运行 TypeScript，这是示例/开发现场的做法，生产环境应使用构建后的入口。
// JSON 清单：plugins/chat/package.json 是聊天插件清单（name @chat/chat、private、type module），
// 由插件发现/构建器读取；本文件与它无直接导入关系，说明写在 plugins/chat/server.ts 文件头。

// The chat's start: one server keeping the channel list and the surfaces, one worker per channel, a web page at `/chat`
// (the sign-in page at `/` comes from the chat plugin) and a terminal client. No harness: the app is its API, two
// plugins and its two client entries.

import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "../../../src/context/index.ts";
import { type App, startServer } from "../../../src/node/app/index.ts";
import { type PageAssets, pageScripts } from "../../../src/node/surfaces/index.ts";
import type { ChatPrincipal } from "./app/principals.ts";
import * as v1server from "./app/v1/server.ts";
import * as v1worker from "./app/v1/worker.ts";
import * as v1 from "./app/v1.ts";

// 模块表同时供服务器插件和 worker 插件解析 import；三个键对应三个子路径。
// `as const` 让 versions 推断成 readonly ["v1"] 而不是 string[]，保留字面量信息。
/** The chat's API, as the server and the channel workers have it. */
export const API = {
	name: "@chat/app",
	versions: ["v1"],
	modules: { "@chat/app/v1": v1, "@chat/app/v1/server": v1server, "@chat/app/v1/worker": v1worker },
};

// facet 种类名必须与插件文件（server.ts/worker.ts/web.ts/tui.ts）和 startServer 的 kinds 键一致。
// 每个平台条目描述构建目标：browser 需要声明插件可导入的包（React 自动运行时）。
/** The chat's facet kinds. */
export const KINDS = {
	server: { platform: "node" },
	worker: { platform: "node" },
	web: { platform: "browser", packages: { react: {}, "react/jsx-runtime": {} } },
	tui: { platform: "node" },
} as const;

// 函数说明：page 返回应用页面 HTML。输入 nonce 与 assets；输出字符串；无副作用。
// pageScripts 注入样式、bootstrap、插件合并文件与 base 脚本，nonce 用于 CSP。
/** The chat page: the app's template around the surface's assets. */
function page(request: { readonly nonce: string }, assets: PageAssets): string {
	// 单行模板字符串：所有标签内联；没有用户输入，因此无需 HTML 转义。
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Chat</title>${pageScripts(assets, request.nonce)}</head><body><div id="root"></div></body></html>`;
}

// 函数说明：chatDirectories 建临时根、插件副本与数据目录。输入无；输出三个路径；副作用是写文件系统。
// 与示例 56 的 boardDirectories 相同，前缀换成 "chat-"。
// 示例：const { base, dataDir, root } = await chatDirectories();
/** A data directory and a copy of the chat's plugins, in a new temporary directory. */
export async function chatDirectories(): Promise<{
	readonly base: string;
	readonly dataDir: string;
	readonly root: string;
}> {
	const base = await mkdtemp(join(tmpdir(), "chat-"));
	const root = join(base, "plugins");
	// 复制 plugins/ 目录（含 chat 插件包与 login.server.ts 单文件插件）。
	await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });
	return { base, dataDir: join(base, "data"), root };
}

// 函数说明：startChat 启动 chat。输入目录与 context；输出 App<ChatPrincipal>。
// 副作用：监听端口、建 server store、按频道 fork worker、构建 web/tui base bundle。
// 失败：startServer 关闭已建资源后拒绝；onError 收到运行时错误。
// 示例：const app = await startChat(dataDir, root, context);
/** Starts the chat on a free loopback port. */
export function startChat(dataDir: string, root: string, context: Context): Promise<App<ChatPrincipal>> {
	return startServer<ChatPrincipal>(
		{
			name: "chat",
			dataDir,
			root,
			listen: { host: "127.0.0.1", port: 0 },
			api: API,
			kinds: KINDS,
			// 服务器身份是 server；worker 身份由地址生成。
			// address.key 是 kind 与参数按声明顺序转义后用 "|" 连接得到的字符串：Channel({id:"general"})
			// 得到 "channel|general"。因此这里写入 principal.channel 的是完整地址键，而不只是频道名；
			// 示例没有读取该字段（authorize 只看 principal.kind），所以不影响行为。
			principal: { server: { kind: "server" }, worker: (address) => ({ kind: "worker", channel: address.key }) },
			// workers 声明“哪些 host kind 由子进程承载”。每个频道地址会按需 fork 一个 worker；
			// 同一地址同时只有一个存活 worker（进程锁）。
			workers: [
				{
					// kind 是契约对象：Channel({ id }) 的地址由它构造。
					kind: v1.Channel,
					// entry 是 worker 进程的入口；fork 后执行 startWorker。
					entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
					// 示例直接运行 TypeScript 源码：conditions=source 选择 package 的源码导出，
					// experimental-strip-types 让 Node 擦除类型；no-warnings 抑制实验特性提示。
					execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
					// start 返回应用自己的启动数据；本示例为空对象。kit 还会附加地址、脚本集等。
					start: () => ({}),
					// 信任边界：是否允许某 principal 持有该 worker 的对象。只有登录用户和 owner 可以。
					// 返回值是布尔；authorize 抛错会被报告并拒绝持有。
					// Anyone signed in may join a channel.
					authorize: (principal) => principal.kind === "user" || principal.kind === "owner",
				},
			],
			// web 页面挂在 /chat；根路径 "/" 由聊天插件的服务器路由提供登录页。
			web: { entry: fileURLToPath(new URL("./web/main.ts", import.meta.url)), page, paths: ["/chat"] },
			// 终端入口由启动器下载并在沙箱中运行。
			tui: { entry: fileURLToPath(new URL("./tui/main.ts", import.meta.url)) },
			onError: (error) => console.error("chat:", error.kind, error.error),
		},
		context,
	);
}
