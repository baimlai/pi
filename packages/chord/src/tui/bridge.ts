// The terminal's bridge (slice 11 §4, decision "Slice 11, P8"): the only way between the sandbox, where the app's
// terminal code and the plugins run, and the trusted launcher outside it. The launcher sends input, resizes and the
// relayed bytes of the Chord link; the sandbox sends frames for the terminal, opens and feeds link sockets through the
// launcher, asks for plugin scripts and the server's base hash, and asks for actions on the machine (copy, open a URL,
// attach a file the user names), which the launcher confirms with the user. Messages are plain data, framed over the
// sandbox's pipes (`src/node/tui/pipe.ts`); requests carry an id their reply has.
// 中文说明：本文件只定义沙箱与启动器之间的消息形状和桥接口，不执行 I/O，也不解释消息内容。
// 上游：node/tui/launcher.ts 与 sandbox.ts 按这些类型编码/解码帧；下游：tui/channel.ts 负责分派，
// runtime.ts 把 Bridge 包装成终端运行时。跨进程字节不可信，真正的字段校验在 pipe.ts 的帧读取器中。
// 所属：@earendil-works/chord 的 tui 模块（沙箱侧终端），是沙箱与启动器共享的消息词汇表。
// 边界：只声明数据形状，不编码帧、不校验 JSON、不持有连接；协议错误由 pipe.ts 和启动器处理。
// 上游：应用经 runtime.ts 间接使用；node/tui/sandbox.ts 的 bootstrap 把 Bridge 挂到 globalThis。
// 下游：channel.ts 分派 LauncherMessage、发送 SandboxMessage；RelayLink 经 socket_* 转发 Chord 链路字节。
// 导出清单：BridgeStart 是启动握手；BridgeRequest 是机器操作请求；SandboxMessage/LauncherMessage 是两个方向的消息；
// Bridge 是运行时桥接口；BRIDGE 是它在 globalThis 上的属性名。
// 组合顺序：launcher 启动沙箱 → bootstrap 注入 Bridge → SandboxChannel 订阅消息 → 业务发送 write/request/socket_*。
// 示例：const message: SandboxMessage = { kind: "write", data: "hi" }; bridge.send(message);
// 阅读顺序：BridgeStart → BridgeRequest → SandboxMessage → LauncherMessage → Bridge → BRIDGE。

/** What the launcher tells the sandbox at its start. */
// 启动握手时固定下发的信息：基础包摘要、初始插件文本和终端能力；除 resize 外，本次沙箱内不再变化。
export type BridgeStart = {
	/** The base bundle's hash (the sandbox runs it). */
	// base：沙箱当前运行代码的内容摘要；与服务器当前摘要不同就说明整个沙箱需要更换。
	readonly base: string;
	/** The text of the combined plugin scripts at start. */
	// combined：启动时插件脚本的合并正文，交给 SandboxScripts.run 执行并收集 chordFacet 注册项。
	readonly combined: string;
	// columns/rows：启动时的终端尺寸；之后由 resize 消息更新，读取方应使用 BridgeTerminal 的 getter。
	readonly columns: number;
	readonly rows: number;
	/** How many colours the terminal shows. */
	// colors：终端颜色能力；决定 TerminalTheme 输出真彩还是最近 256 色 SGR。
	readonly colors: "truecolor" | "256";
	/** The terminal's background: which of the user's two themes applies. */
	// mode：用户当前的深浅模式，用来先选中 dark/light 两套主题中的一套。
	readonly mode: "dark" | "light";
};

/** A request of the sandbox the launcher answers. */
// 沙箱发往启动器的请求。每个请求在 SandboxChannel 中分配数字 id，启动器用 reply/attached/refused 回答同一 id。
// 例如 request({ kind: "copy", text }) 在用户确认后得到 { kind: "reply", value: true }；拒绝则会拒绝 Promise。
export type BridgeRequest =
	// fetch：请启动器代下载服务器资源（例如新插件脚本）；沙箱本身没有网络权限。
	| { readonly kind: "fetch"; readonly path: string }
	// base：询问服务器当前基础包摘要；请求失败由调用方解释为“未知”，不能当作“已过期”。
	| { readonly kind: "base" }
	// copy：把文本写入本机剪贴板；启动器会先向用户确认。
	| { readonly kind: "copy"; readonly text: string }
	// open：在浏览器打开 URL；启动器会先向用户确认，只接受 http/https。
	| { readonly kind: "open"; readonly url: string }
	/** A file of the machine the user names (`path`): its name and bytes once confirmed, else `null`. */
	// attach：读取用户指定路径的文件；确认并读取成功时回 attached，拒绝时回 refused（含大小/路径错误）。
	| { readonly kind: "attach"; readonly path: string };

/** What the sandbox sends. */
// 沙箱发往启动器的消息。socket_* 系列由 RelayLink 使用：沙箱不直接联网，字节经启动器转发到服务器链路端点。
export type SandboxMessage =
	// write：一段终端输出文本；SandboxChannel 已按 FRAME_UNITS 切好，启动器不再拆分。
	| { readonly kind: "write"; readonly data: string }
	// socket_open：请启动器为这个编号打开到服务器 /chord 的 WebSocket；打开后回 socket_opened。
	| { readonly kind: "socket_open"; readonly socket: number }
	// socket_send：经已打开的 socket 发送一条 Chord 链路字节消息（Uint8Array 是二进制字节数组）。
	| { readonly kind: "socket_send"; readonly socket: number; readonly bytes: Uint8Array }
	// socket_close：关闭该 socket；启动器随后回 socket_closed，双方都结束本地链路。
	| { readonly kind: "socket_close"; readonly socket: number }
	// request：携带 id 的机器操作请求，回答见 LauncherMessage 的 reply/attached/refused。
	| { readonly kind: "request"; readonly id: number; readonly request: BridgeRequest }
	/** The sandbox's code is outdated (a new base bundle): the launcher starts a new one. */
	// outdated：沙箱发现自身基础包过期，请求启动器启动新沙箱；当前进程随后退出。
	| { readonly kind: "outdated" }
	/** The base bundle failed to start (its message; the launcher shows none of the sandbox's own output). */
	// failed：基础包或插件启动失败；启动器只展示这条受控消息，不转发沙箱的任意 stderr。
	| { readonly kind: "failed"; readonly message: string }
	// exit：终端客户端正常结束并给出退出码；启动器据此结束子进程并恢复终端模式。
	| { readonly kind: "exit"; readonly code: number };

/** What the launcher sends. */
// 启动器发往沙箱的消息：用户输入、尺寸变化、链路 socket 的进展，以及请求的回复。
// 这些字段由启动器产生；沙箱按联合类型分派。reply 的 value 是 unknown，使用点必须自行断言或检查。
export type LauncherMessage =
	// input：终端输入的原始文本（按键、粘贴都可能一次到达）。
	| { readonly kind: "input"; readonly data: string }
	// resize：新的终端尺寸；BridgeTerminal 先更新自身字段，再通知应用监听器。
	| { readonly kind: "resize"; readonly columns: number; readonly rows: number }
	// socket_opened：对应 socket 已连接；RelayLink 会把连接期间缓冲的消息补发出去。
	| { readonly kind: "socket_opened"; readonly socket: number }
	// socket_message：服务器发来的一条链路字节消息，转交给对应 RelayLink。
	| { readonly kind: "socket_message"; readonly socket: number; readonly bytes: Uint8Array }
	// socket_closed：socket 已关闭（任一侧）；对应链路随后结束。
	| { readonly kind: "socket_closed"; readonly socket: number }
	// reply：普通请求的回答；value 的具体形状由请求种类决定，数组等结构不做运行时校验。
	| { readonly kind: "reply"; readonly id: number; readonly value: unknown }
	/** An attach request's answer: the file the user confirmed. */
	// attached：attach 请求被确认后的文件名与字节；name 是路径最后一段，不是完整路径。
	| { readonly kind: "attached"; readonly id: number; readonly name: string; readonly bytes: Uint8Array }
	// refused：用户拒绝或操作失败；SandboxChannel 会把 message 转成 rejected Promise。
	| { readonly kind: "refused"; readonly id: number; readonly message: string };

/** The bridge as the sandbox's code gets it from the bootstrap (once: it is taken off `globalThis`). */
// 沙箱代码看到的桥：启动信息、发送/订阅消息，以及在沙箱上下文中执行注册脚本。
// bootstrap 把它挂到 globalThis；startTerminalRuntime 取走后删除，后续插件无法直接触达启动器动作。
export type Bridge = {
	// start：启动器在握手帧里给出的固定信息。
	readonly start: BridgeStart;
	// send：把一条 SandboxMessage 交给启动器；同步返回，不等待对方处理。
	send(message: SandboxMessage): void;
	// onMessage：注册启动器消息监听器；启动器侧只保留一个监听器，重复注册会替换而不是叠加。
	onMessage(listener: (message: LauncherMessage) => void): void;
	/**
	 * Runs `source` (registered plugin scripts) in the sandbox's context, as the bootstrap ran the base bundle: with no
	 * dynamic import callback (`import()` throws).
	 */
	// evaluate：在同一沙箱全局环境中执行插件脚本文本；没有 dynamic import 回调，所以 import() 会抛出。
	evaluate(source: string, filename: string): void;
};

/** The global the sandbox's bootstrap leaves the bridge on, for the base bundle's runtime to take. */
// 全局属性名：bootstrap 写入桥对象，runtime 读取后 delete，减少插件代码直接调用启动器动作的入口。
export const BRIDGE = "chordBridge";
