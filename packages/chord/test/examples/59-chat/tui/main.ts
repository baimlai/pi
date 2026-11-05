// 文件导读
// 所属：packages/chord/test/examples/59-chat/tui，chat 的终端页面入口（terminal base bundle，在启动器沙箱内运行）。
// 作用：不依赖终端库，用字符串和 ANSI 转义序列手绘界面：
//   - 第一行频道标签，Tab 循环切换；
//   - 中间是当前频道的最新消息（图片显示占位符，其他附件显示文件名和链接）；
//   - PgUp/PgDn 滚动，PgUp 接近顶部时向 worker 请求更旧的一页；
//   - 最后一行是输入提示，Enter 发送；`/attach <path>` 请求启动器读取本机文件并分块上传；Ctrl-C 退出。
// 上游：服务器把本文件构建为终端基础包；启动器在 Node 沙箱中求值，并通过全局桥提供终端、主题和动作。
// 下游：src/tui 的 startTerminalRuntime/TuiScope、app/v1.ts 的 Channels/Room；上传/读取走频道 worker。
// 能力清单：share（分块上传）、line（消息渲染）、startTerminalRuntime 内的绘制/滚动/发送/输入处理。
// 典型流程：启动 → 持有 Channels 并订阅 → 初始绘制 general → 输入字符只改本地 draft → Enter 调 post →
// 订阅推送触发重绘 → PgUp 加载历史页 → Ctrl-C 退出。
// 阅读顺序：先看 share 与 line，再看 render 内的状态（rooms/channel/draft/scrolled）与 draw，最后看输入分支。
// 运行方式：由示例 59 的 startChat 启动；不能单独执行。
// 说明：状态都在闭包里，变化后主动 draw；scope 的 changed 回调也指向 draw，因此引用/状态更新会自动重绘。
// 错误：post/share/attach 的 Promise 都用 void 丢弃；失败只会成为未处理拒绝，界面不提示。

// The chat in a terminal (the terminal base bundle, run in the launcher's sandbox): the channels (Tab switches), the
// current room's messages (an image as a placeholder, other files as their link; PgUp and PgDn scroll, loading older
// messages a page at a time), and a line to type into. Enter posts; `/attach <path>` asks the launcher for a file of
// this machine (it asks the user) and shares it in chunks; Ctrl-C quits.

// Held：持有中的远程引用类型（含生命周期方法），仅类型导入；AttachedFile 是 attach 的结果 { name, bytes }。
import type { Held } from "../../../../src/index.ts";
import { type AttachedFile, startTerminalRuntime, TuiScope } from "../../../../src/tui/index.ts";
import * as v1 from "../app/v1.ts";

// 与 web 端相同的解构重命名；BACKGROUND_CONTEXT 用于后台调用（不随“用户取消”中止）。
const { BACKGROUND_CONTEXT: context, Channels, Room } = v1;

/** The size of one upload chunk. */
// 256 KiB：在 Files 单次 4 MiB 上限之内；分块 + 顺序 await 形成背压。
const CHUNK = 256 * 1024;

/** Shares `file` in `room`, in chunks. */
// 函数说明：share 把启动器读到的文件分块上传到一个 Room 并发布消息。
// 输入：room（持有的 Room 引用）、file（AttachedFile：name 是路径最后一段，bytes 是文件内容）。
// 输出：Promise<void>，分块全部 append 且 share 后 resolve。副作用：远程 Files 写入与一条消息。
// 流程：按扩展名推断图片 MIME → begin → 按偏移 subarray 切片 → append → share 空文本消息。
// 示例：share(room, { name: "a.png", bytes })
async function share(room: Held<typeof Room>, file: AttachedFile): Promise<void> {
	// 正则只认四种常见图片扩展名（jpe?g 同时匹配 jpg/jpeg）；否则统一按二进制处理。
	// 三元的两个分支都是字符串模板；`pop()!` 非空断言：能匹配正则就一定有扩展名。
	// 注意 jpg 会得到 image/jpg（而非 image/jpeg），示例只依赖 `image/` 前缀决定是否内联。
	const mime = /\.(png|jpe?g|gif|webp)$/i.test(file.name)
		? `image/${file.name.split(".").pop()!.toLowerCase()}`
		: "application/octet-stream";
	const id = await room.begin({ name: file.name, mime }, context);
	// bytes 是 Uint8Array；subarray 返回共享同一底层 buffer 的视图（不复制），序列化时才复制。
	for (let offset = 0; offset < file.bytes.length; offset += CHUNK) {
		await room.append({ upload: id, offset, bytes: file.bytes.subarray(offset, offset + CHUNK) }, context);
	}
	// 与 web 端一致：附件消息文本为空，附件元数据随消息保存。
	await room.share({ upload: id, text: "" }, context);
}

/** One message as a line. */
// 函数说明：line 把一条消息渲染成一行文本。输入 message、当前 channel（拼附件链接）、theme（配色）。
// 输出：作者用 accent、正文原样、附件用 muted/accent 的字符串；不含换行，由调用方 join。
// theme 只用其 fg(role, text) 方法，因此这里用结构类型声明，便于脱离具体 TerminalTheme 复用。
function line(message: v1.Message, channel: string, theme: { fg(role: string, text: string): string }): string {
	const { file } = message;
	// 附件片段：无附件为空串；图片显示 `[image: 名称]`（终端无法可靠内联图片）；其他显示名称和 HTTP 路径。
	// 嵌套模板字符串：内层生成 `[image: x]`，外层加前导空格并整体着色。
	const attached =
		file === undefined
			? ""
			: file.mime.startsWith("image/")
				? ` ${theme.fg("muted", `[image: ${file.name}]`)}`
				: ` ${theme.fg("accent", `[${file.name}] /files/${channel}/${file.id}`)}`;
	// 拼成一行：作者着色、正文、附件片段。fg 返回带转义序列的字符串；不含显式复位（由终端/启动器过滤层处理）。
	return `${theme.fg("accent", message.author)} ${message.text}${attached}`;
}

// 启动终端运行时：加载插件、连接服务器（经启动器桥），插件就绪后调用一次 render。
// modules 只需应用 API（TUI 页面不直接用 React）；渲染回调内建立组件级资源作用域。
// `void` 丢弃启动 Promise；失败只会是未处理拒绝（stderr 归启动器，可能不可见）。
void startTerminalRuntime({
	modules: { "@chat/app/v1": v1 },
	render: (runtime) => {
		const { terminal, theme } = runtime;
		// TuiScope 统一管理本界面的持有点与订阅：任何变化调用 changed（这里就是 draw）。
		// 构造只保存 host 与回调，不立即调用；因此这里引用尚未声明的 draw 是安全的（回调稍后才执行）。
		const scope = new TuiScope(runtime.host, () => draw());
		// scope.hold 返回 Held；`.names` 是它的状态成员（Watchable）。scope.watch 返回读取函数，
		// 订阅建立后还会补调一次 changed。读取函数在无值/结束时返回 undefined。
		const channels = scope.watch(scope.hold(Channels, {}).names);
		// Each channel's room held once, on first view, with the older messages loaded so far.
		// Viewed 是每个频道在本地的视图状态：房间引用、实时消息读取函数、已加载的旧消息页（旧→新）。
		// 类型标注是纯编译期检查；运行时不校验对象形状。
		type Viewed = {
			room: Held<typeof Room>;
			live: () => readonly v1.Message[] | undefined;
			older: readonly v1.Message[];
		};
		// rooms 以频道名为键缓存视图；首次访问某频道时才 hold 其 Room（懒加载）。
		const rooms = new Map<string, Viewed>();
		// roomOf 取（或创建）某频道的视图。引用与 watch 都登记在 scope 上，退出时统一释放。
		const roomOf = (id: string): Viewed => {
			let held = rooms.get(id);
			if (held === undefined) {
				const room = scope.hold(Room, { id });
				// scope.watch(room.messages) 返回读取函数；保存函数而不是快照，重绘时总能读到最新值。
				held = { room, live: scope.watch(room.messages), older: [] };
				rooms.set(id, held);
			}
			return held;
		};
		// messagesOf 合并旧页与实时窗口：过滤掉 id 不大于旧页末尾的实时消息，避免两段重叠重复。
		// live() 可能为 undefined（尚未绑定/无值），用 ?? [] 兜底；older.at(-1) 不存在时阈值取 0。
		const messagesOf = ({ live, older }: Viewed): readonly v1.Message[] => [
			...older,
			...(live() ?? []).filter((message) => message.id > (older.at(-1)?.id ?? 0)),
		];
		// 本地界面状态：当前频道、输入行内容、从最新消息向上滚动了多少条（0 表示贴底）。
		let channel = "general";
		let draft = "";
		// How many messages up from the newest the view is scrolled.
		let scrolled = 0;
		// 可视消息行数：总行数减去第一行标签和最后一行提示，再留 1 行余量（输出以 \r\n 结尾）。
		const height = () => terminal.rows - 3;
		// 函数说明：draw 整屏重绘。输入无；输出无；副作用 terminal.write。
		// 流程：渲染标签行 → 取当前频道合并后的消息 → 按 scrolled 计算窗口 → 清屏/回首页后一次写出。
		// 示例：scrolled=0 时显示最新 height() 条；scrolled=height() 时显示再往前一屏。
		const draw = (): void => {
			// 当前频道用 accent 高亮；其余保持默认色。channels() 可能尚未就绪，?? [] 避免报错。
			const tabs = (channels() ?? []).map((name) =>
				name === channel ? theme.fg("accent", `#${name}`) : `#${name}`,
			);
			const messages = messagesOf(roomOf(channel));
			// end 是窗口右侧（不含）；scrolled 超过消息数时 end 可能为负，slice 会安全地得到空数组。
			const end = messages.length - scrolled;
			// Math.max(0, ...) 防止起点为负；先 slice 再逐条渲染，只格式化可见消息。
			const shown = messages.slice(Math.max(0, end - height()), end).map((message) => line(message, channel, theme));
			// `\x1b[2J` 清屏，`\x1b[H` 光标回左上角；之后依次是标签、空行分隔的消息、提示行。
			// 提示行没有换行结尾，下一次整屏重写会覆盖它；输入期间不移动光标，视为追加显示。
			terminal.write(`\x1b[2J\x1b[H${tabs.join(" ")}\r\n${shown.join("\r\n")}\r\n> ${draft}`);
		};
		// PgUp: a screen further back, first loading the page before the oldest message when the screen would pass it.
		// 函数说明：scrollUp 向上滚动一屏。若无更多消息可显示且已接近顶部，先向 worker 取更旧的一页。
		// 输入无；输出 Promise<void>；副作用：history 远程调用、修改 viewed.older 与 scrolled、重绘。
		// 说明：没有“是否还有更旧”的标记；顶部反复 PgUp 会重复请求同一页（返回空页，older 不变）。
		const scrollUp = async (): Promise<void> => {
			const viewed = roomOf(channel);
			const messages = messagesOf(viewed);
			// 再滚一屏就会越过最早一条时预取；messages 为空时不请求（也没有 before 可用）。
			if (scrolled + 2 * height() > messages.length && messages.length > 0) {
				const page = await viewed.room.history({ before: messages[0]!.id }, context);
				// 旧页是旧→新，直接前置；await 期间可能收到新消息，但 id 过滤会消除重叠。
				viewed.older = [...page, ...viewed.older];
			}
			// 先增加一屏，再夹到 [0, 总条数 - 可视行数]；重新计算 messagesOf 以包含刚加载的旧页。
			scrolled = Math.min(scrolled + height(), Math.max(0, messagesOf(viewed).length - height()));
			draw();
		};
		// 函数说明：send 处理一次 Enter。输入 text；无返回；副作用：可能的 attach/上传或 post。
		// `/attach ` 后是路径；runtime.attach 由启动器先征得用户确认，拒绝时返回 undefined，上传被跳过。
		// 普通文本非空时 post；两种情况都不等待结果（失败无提示）。
		const send = (text: string): void => {
			if (text.startsWith("/attach ")) {
				const { room } = roomOf(channel);
				// slice(8) 去掉 "/attach "（8 个字符）；trim 允许路径周围有空格。
				// then 回调返回 undefined 或 share 的 Promise，因此拒绝会继续向上传播为未处理拒绝。
				void runtime
					.attach(text.slice(8).trim())
					.then((file) => (file === undefined ? undefined : share(room, file)));
			} else if (text !== "") void roomOf(channel).room.post(text, context);
		};
		// 原始输入处理：终端发来的是按键/粘贴的字节序列，这里按精确字符串识别少量控制序列。
		// 任何分支处理后都重绘一次；方向键等其他 CSI 序列以 ESC 开头，被最后一个分支忽略。
		terminal.onInput((data) => {
			// Ctrl-C：请求启动器结束终端客户端（进程退出由启动器负责）。
			if (data === "\x03") runtime.exit(0);
			// PgUp（CSI 5~）：异步取历史页；用 void 表示不等它完成。
			else if (data === "\x1b[5~") void scrollUp();
			// PgDn（CSI 6~）：减少 scrolled（向最新方向），下限 0。
			else if (data === "\x1b[6~") scrolled = Math.max(0, scrolled - height());
			else if (data === "\t") {
				// Tab：在频道名数组中循环。name 不在数组时 indexOf 为 -1，+1 后从 0 开始；
				// 数组为空时取模为 NaN，names[NaN] 为 undefined，?? channel 保持原频道。
				const names = channels() ?? [];
				channel = names[(names.indexOf(channel) + 1) % names.length] ?? channel;
				// 切频道后回到最新消息；各频道的 older 仍保留在 rooms 中。
				scrolled = 0;
			} else if (data === "\r") {
				// Enter：发送当前输入并清空。\r 是终端对 Enter 的编码（\n 可能出现在粘贴内容里）。
				send(draft);
				draft = "";
			} else if (data === "\x7f") draft = draft.slice(0, -1);
			// 其他以 ESC 开头的序列（方向键等）忽略；普通文本/粘贴追加到输入行。
			else if (!data.startsWith("\x1b")) draft += data;
			draw();
		});
		// 主题变化（用户切换）时重绘；返回的移除函数未保存，随沙箱生命周期结束。
		theme.onChange(draw);
		// 首次绘制：插件已加载，但 Channels 的 watch 可能仍在建立，channels() 先返回 undefined，随后变化会再重绘。
		draw();
	},
});
