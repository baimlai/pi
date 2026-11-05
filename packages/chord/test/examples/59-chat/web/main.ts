// 文件导读
// 所属：packages/chord/test/examples/59-chat/web，chat 的页面入口（web base bundle 源码）。
// 作用：用 React 渲染聊天页面：
//   - Chat：持有 Channels 引用，显示频道标签；切换频道时重新挂载 RoomView；
//   - RoomView：持有当前频道 Room，订阅最新 100 条消息，支持分页加载更旧消息、发文字、选文件上传；
//   - upload：把浏览器 File 按 256 KiB 分块 append 到 worker 的 Files，最后 share 成消息；
//   - Message：图片内联显示，其他附件显示为指向 /files/<channel>/<id> 的链接。
// 上游：服务器启动时 esbuild 以 browser 平台构建本文件，CSS 被抽取成 base.<hash>.css；页面加载执行。
// 下游：react/react-dom、src/react 的 HostProvider/useHold/useWatch、src/web 的 startPage、
// app/v1.ts 的 Channels/Room 契约。网络：连接同源 /chord 链路，附件走 HTTP GET。
// 能力清单：upload、Message、RoomView、Chat 四个函数 + 顶层 startPage 调用。
// 典型行为：登录后进入 /chat，默认 #general；发消息即时追加；上传文件后消息里出现图片/链接；
// Load older 每次取当前最早消息之前的一页。
// 阅读顺序：先看 Chat 的频道与 RoomView 挂载，再看 RoomView 的状态合并与 loadOlder，最后看 upload。
// 运行方式：随 startChat 构建；不能单独运行。
// 注意：room 在首轮 render 是 undefined（useHold 在 effect 中才持有），所以所有使用处都做可选判断；
// `void upload(...)`/`void room.post(...)` 是有意不等待，失败不会自动重试或提示。

// The chat's page (the web base bundle): the channels as tabs, the current room's messages (images inline, other files
// as links; older ones a page at a time with "Load older"), a message box and a file picker. A file goes up in chunks
// through the room (into its worker's files).

import * as React from "react";
// 同时导入 createElement（别名 h）与 useState；没有 JSX，组件用 h 调用构建。
import { createElement as h, useState } from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
// Held 是“持有的引用”类型：远程契约的成员加上生命周期方法（release 等）；仅类型导入。
import type { Held } from "../../../../src/index.ts";
import { HostProvider, useHold, useWatch } from "../../../../src/react/index.ts";
import { startPage } from "../../../../src/web/index.ts";
import * as v1 from "../app/v1.ts";
// 导入 CSS 是 esbuild 的约定：样式被抽取进基础包的样式表，页面由 pageScripts 注入 <link>。
import "./style.css";

// 解构重命名：BACKGROUND_CONTEXT 在组件里叫 context，避免与 React context 概念混淆。
const { BACKGROUND_CONTEXT: context, Channels, Room } = v1;

/** The size of one upload chunk. */
// 256 KiB 小于 Files 单次 4 MiB 上限，也接近 HTTP/链路推荐的约 1 MiB；分块让进度/背压可控。
const CHUNK = 256 * 1024;

/** Sends `file` to `room` in chunks, then shares it. */
// 函数说明：upload 把浏览器 File 分块传给频道 worker 并发布消息。
// 输入：room（已持有的 Room 引用，可能尚未 live，方法调用会排队）、file（浏览器 File）。
// 输出：Promise<void>，全部分块与 share 完成后 resolve。副作用：多次远程调用、写入 worker 文件。
// 错误：begin/append/share 的拒绝向上传播；调用方用 void 丢弃，因此表现为未处理拒绝（控制台可见）。
// 流程：begin 拿 upload id → 按 offset 切片 → File.slice().arrayBuffer() → Uint8Array → append →
// 最后 share 发一条空文本消息（附件即内容）。
// 示例：void upload(room, fileInput.files[0]);
async function upload(room: Held<typeof Room>, file: File): Promise<void> {
	// file.type 可能为空（浏览器无法识别）；回退到通用二进制 MIME。
	const id = await room.begin({ name: file.name, mime: file.type || "application/octet-stream" }, context);
	// offset 从 0 到 file.size（不含），每次前进 CHUNK；最后一块可能不足 CHUNK。
	for (let offset = 0; offset < file.size; offset += CHUNK) {
		// File.slice 返回 Blob（不复制数据）；arrayBuffer() 异步读取该块，再包成 Uint8Array。
		// bytes() schema 的运行时校验只认 Uint8Array（字节叶子），不会遍历内容。
		const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
		// 偏移必须与服务端已收字节数一致；await 保证上一块落地后再发下一块（背压）。
		await room.append({ upload: id, offset, bytes }, context);
	}
	// finish 在 worker 内部完成；share 把它变成一条消息。空文本允许只有附件。
	await room.share({ upload: id, text: "" }, context);
}

// 函数说明：Message 渲染一条消息。输入 channel（用于拼附件 URL）与 message；输出 React 元素。
// 副作用：无（渲染期间不发请求；图片由浏览器按 src 自行加载）。
// file 可选：无附件时 body 为 null；图片用 <img> 内联（服务器对该 MIME 返回 inline），其他文件用
// <a> 链接并显示字节数。React 会转义 message.text，不能注入 HTML。
function Message({ channel, message }: { channel: string; message: v1.Message }) {
	// 结构类型参数：调用方只需传这两个字段；v1.Message 是 schema 推导出的类型。
	const { file } = message;
	// 空字符串表示“没有 URL”，与 undefined 分开，便于后面统一传给 img/a。
	const url = file === undefined ? "" : `/files/${channel}/${file.id}`;
	// 三元表达式嵌套：无附件 → null；图片 → img；其他 → a。
	// `image/` 前缀与服务端 inline 判断一致，保证浏览器不会把非图片当图片渲染。
	const body =
		file === undefined
			? null
			: file.mime.startsWith("image/")
				? h("img", { src: url, alt: file.name })
				: h("a", { href: url }, `${file.name} (${file.size} bytes)`);
	// <li> 内依次是加粗作者、空格、正文和附件元素；返回单个根节点，列表由父组件提供。
	return h("li", null, h("b", null, message.author), " ", message.text, body);
}

// 函数说明：RoomView 显示一个频道。输入 channel 名；输出 React 元素。
// 副作用：持有 Room 引用、订阅 messages、按需调用 history/post/upload；卸载时 useHold/useWatch 自动释放。
// 状态：older（已加载的历史页，旧→新）、more（是否可能还有更旧）、text（输入框）。
// 流程：useHold 取得引用 → useWatch 订阅实时窗口 → 合并历史与实时 → 渲染按钮/列表/表单。
// 示例：h(RoomView, { key: "general", channel: "general" })
function RoomView({ channel }: { channel: string }) {
	// useHold 在首轮 render 返回 undefined（effect 中才真正 hold），后续每次 render 返回同一引用；
	// 参数按值比较，因此内联对象不会导致反复重持有。
	const room = useHold(Room, { id: channel });
	// room?.messages 是 state 成员 Watchable；useWatch 返回当前值，首帧或无引用时为 undefined。
	const live = useWatch(room?.messages) ?? [];
	// Pages of history before the live window, and whether there may be more.
	// older 保存比实时窗口更旧的消息；more 由上一页是否满页推断（满页说明可能还有）。
	const [older, setOlder] = useState<readonly v1.Message[]>([]);
	const [more, setMore] = useState(true);
	// 合并时过滤掉 id 不大于 older 末尾的实时消息，避免历史页与实时窗口重叠导致重复。
	// `older.at(-1)?.id ?? 0`：没有历史时阈值是 0（所有合法 id 都更大）。
	const messages = [...older, ...live.filter((message) => message.id > (older.at(-1)?.id ?? 0))];
	// loadOlder：以当前最早消息为 before 取一页；返回页是旧→新，直接前置到 older。
	const loadOlder = async () => {
		// 引用尚未就绪或列表为空时无事可做。
		if (room === undefined || messages.length === 0) return;
		// messages[0] 非空断言：上一行已检查 length。history 返回最多 100 条、旧→新。
		const page = await room.history({ before: messages[0]!.id }, context);
		setOlder([...page, ...older]);
		// 100 是 worker 的 PAGE；这里不导入（它不在 API 中），少于一页即认为到底。
		setMore(page.length === 100);
	};
	// 输入框受控状态：每次按键更新 text，表单提交时读取。
	const [text, setText] = useState("");
	// 事件类型用手写结构类型描述，避免依赖 DOM 的 FormEvent 泛型；只需要 preventDefault。
	const send = (event: { preventDefault(): void }) => {
		event.preventDefault();
		if (room === undefined || text === "") return;
		// 不等待 post：立即清空输入框（乐观更新）；失败不会回滚文本，也不会提示。
		void room.post(text, context);
		setText("");
	};
	// 整个视图：可选的历史按钮、消息列表、输入表单。
	// 只有实时窗口满 100 条时才显示 Load older（否则服务端也不会返回更旧的页）。
	return h(
		"section",
		null,
		more && live.length === 100
			? h("button", { type: "button", onClick: () => void loadOlder() }, "Load older")
			: null,
		// ul 的 children 用展开传入；key 必须是稳定 id（消息编号）。
		h("ul", null, ...messages.map((message) => h(Message, { key: message.id, channel, message }))),
		h(
			"form",
			{ onSubmit: send },
			// 受控 input：value 来自 state，onChange 的结构类型只需 target.value。
			h("input", { value: text, onChange: (event: { target: { value: string } }) => setText(event.target.value) }),
			// 文件选择器：files 可能为 null；所选文件交给 upload（不等待）。
			h("input", {
				type: "file",
				onChange: (event: { target: { files: FileList | null } }) => {
					const file = event.target.files?.[0];
					if (room !== undefined && file !== undefined) void upload(room, file);
				},
			}),
		),
	);
}

// 函数说明：Chat 是页面根组件。无输入；输出 React 元素。
// 副作用：持有 Channels 引用并订阅频道名列表；切换 channel 状态会卸载/重挂 RoomView。
// 示例：在 HostProvider 内渲染 h(Chat)。
function Chat() {
	// 先 hold 服务器上的 Channels 对象，再 watch 它的 names 状态；两者都可能首帧为 undefined。
	const channels = useWatch(useHold(Channels, {})?.names) ?? [];
	// 当前频道；默认 general。channels 到达前也可渲染。
	const [channel, setChannel] = useState("general");
	return h(
		"main",
		null,
		// nav 中的按钮来自服务器状态；aria-pressed 反映当前选择，供样式与无障碍使用。
		h(
			"nav",
			null,
			...channels.map((name) =>
				h(
					"button",
					{ key: name, type: "button", onClick: () => setChannel(name), "aria-pressed": name === channel },
					`#${name}`,
				),
			),
		),
		// key={channel}：频道变化时 React 重新挂载 RoomView，从而释放旧 Room 引用并重置历史状态。
		h(RoomView, { key: channel, channel }),
	);
}

// 页面启动：与示例 56 相同，startPage 读取页面 bootstrap、加载插件并连接 /chord。
// 模块表必须包含页面插件可能 import 的三个说明符（与 start.ts 的 kinds.web.packages 对应）。
// `void` 丢弃 Promise；启动失败只会在浏览器控制台出现未处理拒绝。
void startPage({
	connect: () => new WebSocket(`${location.origin.replace(/^http/, "ws")}/chord`),
	modules: { "@chat/app/v1": v1, react: React, "react/jsx-runtime": jsx },
	// 插件加载完成后调用一次；#root 由 start.ts 的页面模板提供，`!` 是非空断言。
	render: (host) => createRoot(document.getElementById("root")!).render(h(HostProvider, { host }, h(Chat))),
});
