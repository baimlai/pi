// `startTerminalRuntime` (slice 11 §4, decisions "Slice 11, P8" and "P9"): the terminal client inside the sandbox, in
// the app's terminal entry (the base bundle the launcher downloaded). A client host like a page's: the plugin scripts
// the launcher brought, loaded with the app's core facets and the kit's themes; the link to the server relayed by the
// launcher, kept by the same connection loop; `TuiScripts` followed to apply new plugin scripts in place; a new base
// bundle hands over to the launcher, which starts the new one. The app gets the host, the bridged terminal, the theme
// lookup and the launcher's actions.
// 中文说明：本文件是沙箱内终端客户端的启动入口。上游是应用终端入口（基础包）；下游是 startClient、
// 插件脚本、服务器链路和启动器动作。它返回 host、桥接终端、主题与 copy/open/attach/exit。
// 所有 I/O 都经 SandboxChannel/Bridge 转交启动器；这里不直接读文件、开浏览器或联网。
// 所属：tui 沙箱侧启动编排；把 bridge/channel/scripts/client/theme 组合成 TerminalRuntime。
// 边界：不实现终端 I/O、不解析插件代码、不连接网络；takeBridge、插件注册或 startClient 失败会向外 reject。
// 上游：应用终端入口调用 startTerminalRuntime；下游：startClient、SandboxChannel、SandboxScripts、TerminalTheme、followActiveTheme。
// 导出清单：TerminalRuntimeOptions 是启动配置；AttachedFile 是 attach 结果；TerminalRuntime 是对外接口；startTerminalRuntime 是唯一入口。
// 组合顺序：takeBridge → SandboxChannel → SandboxScripts → core facets → startClient → TerminalTheme/followActiveTheme → options.render。
// 示例：const runtime = await startTerminalRuntime({ modules, render: (r) => r.terminal.write("hi") });
// 阅读顺序：TerminalRuntimeOptions → AttachedFile → TerminalRuntime → startTerminalRuntime → takeBridge → TERMINAL_ENVIRONMENT → SandboxScripts。

import { BACKGROUND_CONTEXT } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { PluginFacet } from "../host/index.ts";
import {
	type Client,
	type ClientError,
	type ClientModules,
	type ConnectionState,
	FALLBACK_THEMES,
	type FacetFunction,
	followActiveTheme,
	REGISTER,
	type RegisteredScript,
	startClient,
	TuiScripts,
	themesFacet,
} from "../surfaces/index.ts";
import { BRIDGE, type Bridge } from "./bridge.ts";
import { SandboxChannel } from "./channel.ts";
import { BridgeTerminal } from "./terminal.ts";
import { TerminalTheme } from "./theme.ts";

/** What `startTerminalRuntime` takes. */
// 启动终端运行时所需的配置：插件模块映射、应用自带 facets、连接回调、渲染函数和错误出口。
// P 是应用身份类型，只影响编译期 host/合约检查；运行时不保存 principal。
export type TerminalRuntimeOptions<P extends Principal> = {
	/** The modules the terminal plugins import, by specifier: the app's API modules for the kind, its components. */
	// modules：终端插件 import 的模块表，按说明符映射到应用 API 或组件；插件注册函数的 require 从这里取。
	readonly modules: ClientModules;
	/** The app's own terminal facets. */
	// core：应用自己的终端 facets，和主题 facet 一起在插件脚本之前加载；可选，缺省只装主题。
	readonly core?: readonly PluginFacet<P>[];
	// canRetry：连接失败时询问应用是否继续重试；不传则连接循环按默认退避重试。
	readonly canRetry?: () => Promise<boolean>;
	// onConnection：连接状态变化（连接中/已连接/断开等）的回调，用于界面提示。
	readonly onConnection?: (state: ConnectionState) => void;
	/** Draws the app, once its plugins are loaded. */
	// render：插件加载完成、运行时可用后调用，负责首次绘制；同步调用，其抛错向外传播。
	readonly render: (runtime: TerminalRuntime<P>) => void;
	/** Plugins left out or kept old, a failed update, the host's errors; dropped by default (stderr is the launcher's). */
	// onError：插件被排除/保留旧版、更新失败等客户端错误；默认丢弃，因为 stderr 归启动器所有。
	readonly onError?: (error: ClientError) => void;
};

/** A file the launcher read for the sandbox: its name (the path's last segment) and its bytes. */
// attach 的结果：name 是用户所选路径的最后一段，bytes 是文件内容；文件系统路径不暴露给沙箱。
export type AttachedFile = { readonly name: string; readonly bytes: Uint8Array };

/** What the app's terminal code gets. */
// 应用终端代码拿到的运行时对象：host 用于合约/注册表，terminal/theme 用于绘制，其余方法转成启动器动作。
export type TerminalRuntime<P extends Principal> = {
	// host：Chord 客户端 host（索引访问类型取 Client<P> 的 host 属性类型）；已加载核心 facets 和插件。
	readonly host: Client<P>["host"];
	readonly terminal: BridgeTerminal;
	readonly theme: TerminalTheme;
	/** Asks the launcher to copy `text` to the machine's clipboard; it asks the user. Whether it was done. */
	// copy：请启动器复制文本；Promise 在用户确认/拒绝后完成，布尔表示是否执行。
	copy(text: string): Promise<boolean>;
	/** Asks the launcher to open `url` (http or https) in a browser; it asks the user. Whether it was done. */
	// open：请启动器打开 http/https URL；同样以布尔表示是否执行。
	open(url: string): Promise<boolean>;
	/**
	 * Asks the launcher for the file at `path` on the machine (at most 16 MiB); it asks the user. Its name and bytes, or
	 * `undefined` when declined.
	 */
	// attach：读取用户指定路径的文件（启动器限制 16 MiB）；用户拒绝返回 undefined，其他读取错误拒绝 Promise。
	attach(path: string): Promise<AttachedFile | undefined>;
	/** Ends the terminal client with `code`. */
	// exit：请求启动器结束终端客户端；同步发送，不等待进程退出。
	exit(code: number): void;
};

/** Starts the terminal client inside the sandbox; resolves with its runtime once rendered. */
/** 启动沙箱内终端客户端：取桥、加载插件、连接服务器、应用主题，最后调用 render 并返回运行时。
 * 输入 options；输出 Promise<TerminalRuntime<P>>。错误：启动器缺失、插件注册失败、初始连接/加载失败会拒绝。
 * 副作用：删除 globalThis 上的桥、执行插件代码、打开链路、订阅主题；成功渲染后仍持续跟随更新。
 * 例如应用入口写 const runtime = await startTerminalRuntime({...}); runtime.terminal.write("hi")。 */
export async function startTerminalRuntime<P extends Principal>(
	options: TerminalRuntimeOptions<P>,
): Promise<TerminalRuntime<P>> {
	// 先取走全局桥（取不到立即抛错），再创建分派通道；之后所有启动器通信都走 channel。
	const channel = new SandboxChannel(takeBridge());
	const { start } = channel;
	// 安装 globalThis.chordFacet，使接下来 evaluate 的脚本能把注册项收进数组。
	const scripts = new SandboxScripts(channel);
	// 主题 facet 固定排第一；options.core 可选，?? 空数组避免展开 undefined。数组元素共享引用，不复制 facet。
	const core: PluginFacet<P>[] = [{ name: "chord.themes", facet: themesFacet<P>() }, ...(options.core ?? [])];
	// 建立客户端 host：先跑 initial 注册项，再按 TuiScripts 集合并经 channel 取脚本；连接也经 channel 中继。
	// startClient 的泛型 P 给定后，返回 host 的合约类型与选项一致；这里 await 到初始加载完成。
	const client = await startClient<P>({
		scripts: TuiScripts,
		base: start.base,
		initial: scripts.run(start.combined),
		modules: options.modules,
		core,
		// open：连接循环每次建链都调用，返回一个 RelayLink；events 用于打开/收帧通知。
		open: (events) => channel.openSocket(events),
		// fetchScript：按 ScriptSet 条目下载单插件脚本，执行后必须找到同名同摘要的注册项，否则视为失败。
		fetchScript: async (entry) => {
			// 断言 value 为 string 只影响编译期；启动器协议保证 fetch 回答是文本，若不合约会在后续执行时报错。
			const text = (await channel.request({ kind: "fetch", path: entry.url })) as string;
			// 先执行整段文本再按 name+digest 查找；脚本可能注册多项，只有与条目匹配的那项才用于加载。
			const registered = scripts
				.run(text)
				.find(({ plugin, digest }) => plugin === entry.name && digest === entry.digest);
			if (registered === undefined) throw new Error(`plugin "${entry.name}": ${entry.url} did not register`);
			return registered;
		},
		// serverBase：询问服务器当前基础包摘要；失败时 resolve undefined，让客户端保持“未知”而不是误判过期。
		serverBase: () =>
			channel.request({ kind: "base" }).then(
				(base) => base as string,
				() => undefined,
			),
		// outdated：客户端确认自身基础包过期时调用，启动器负责换新沙箱。
		outdated: () => channel.outdated(),
		...(options.canRetry === undefined ? {} : { canRetry: options.canRetry }),
		...(options.onConnection === undefined ? {} : { onConnection: options.onConnection }),
		// 终端没有页面唤醒事件；连接退避只靠定时器与网络错误触发。
		environment: TERMINAL_ENVIRONMENT,
		// 默认空函数：沙箱的 stdout/stderr 由启动器统一过滤，不能把诊断直接混入终端画面。
		onError: options.onError ?? (() => {}),
	});
	// 先用内置 fallback 主题渲染，避免等待注册表期间空白；colors 决定真彩或 256 色。
	const theme = new TerminalTheme(FALLBACK_THEMES[start.mode], start.colors);
	// 跟随 Themes 注册表的用户选择：初始选中 start.mode 的条目，变化时 theme.set 并触发重绘；BACKGROUND_CONTEXT 不会中止。
	await followActiveTheme(client.host, start.mode, (active) => theme.set(active), BACKGROUND_CONTEXT);
	// 组装对外运行时：host 来自 startClient，终端包装同一 channel；动作方法把启动器回答转成应用需要的形状。
	const runtime: TerminalRuntime<P> = {
		host: client.host,
		terminal: new BridgeTerminal(channel),
		theme,
		// then(Boolean) 把 unknown 值转成布尔：true 表示执行成功，false/其他假值表示未执行。
		copy: (text) => channel.request({ kind: "copy", text }).then(Boolean),
		open: (url) => channel.request({ kind: "open", url }).then(Boolean),
		// The launcher's reply: its own data, `null` when declined.
		// attach 的回答是 { name, bytes } 或 null；null 转 undefined 表示用户拒绝，不抛错。
		attach: (path) =>
			// 断言只描述协议；?? 把 null/undefined 合并成 undefined，避免调用方区分两种“无文件”。
			channel
				.request({ kind: "attach", path })
				.then((file) => (file as AttachedFile | null) ?? undefined),
		exit: (code) => channel.exit(code),
	};
	// 首次绘制由应用负责；render 抛错会使启动失败并向外传播，已订阅的 watch 随连接/进程结束。
	options.render(runtime);
	return runtime;
}

/** The bridge the bootstrap left on `globalThis`, taken off it (plugin code never finds it there). */
// 从 globalThis 取回 bootstrap 放置的桥并删除；这是明确信任边界：取到即认为是启动器注入。
// 输入无；返回 Bridge；没有桥时抛 Error（例如模块被直接在 Node 中运行）。
// 副作用：delete globalThis.chordBridge，使后续插件代码无法再取得同一入口。
function takeBridge(): Bridge {
	// 把 globalThis 断言成字符串键字典，才能用动态键 BRIDGE 读取；断言不产生运行时检查。
	const scope = globalThis as Record<string, unknown>;
	const bridge = scope[BRIDGE] as Bridge | undefined;
	// 只检查 undefined；错误消息说明调用环境不对，而不是桥损坏（桥结构由 bootstrap 保证）。
	if (bridge === undefined) throw new Error("startTerminalRuntime: not inside the terminal's sandbox (no bridge)");
	delete scope[BRIDGE];
	return bridge;
}

/** A terminal has no page wakes: the loop retries on its backoff alone. */
// 终端连接循环所需的最小环境：时间、一次性定时器、在线状态与“唤醒”订阅。没有页面，所以 online 恒为 true。
const TERMINAL_ENVIRONMENT = {
	// now：毫秒时间戳，用于测量重连间隔和连接陈旧时间。
	now: () => Date.now(),
	// after：安排一次 callback；返回取消函数，循环提前结束时清除定时器。
	after: (ms: number, callback: () => void) => {
		const timer = setTimeout(callback, ms);
		return () => clearTimeout(timer);
	},
	// online：终端不订阅系统网络状态，始终允许尝试；失败由连接错误和退避处理。
	online: () => true,
	// onWake：没有页面唤醒事件，返回空取消函数；重试只靠 after 的退避。
	onWake: () => () => {},
};

/** Runs registered scripts' text in the sandbox and collects what registered (`chordFacet`). */
// 收集当前 evaluate 文本注册的脚本：chordFacet 是全局注册函数，run 前清空数组，避免重复累积。
// 它不执行模块系统或缓存；每次 run 的结果只属于这一次文本。
class SandboxScripts {
	readonly #channel: SandboxChannel;
	/** The scripts the text being run registers. */
	#collected: RegisteredScript[] = [];

	// 接管 globalThis[REGISTER]：插件脚本调用 chordFacet(name, digest, function(...){...}) 时把三元组推入 #collected。
	// 这是运行时入口，与注册脚本的包装格式在 surfaces/registered.ts 中约定；这里不做名字/摘要校验。
	constructor(channel: SandboxChannel) {
		this.#channel = channel;
		(globalThis as Record<string, unknown>)[REGISTER] = (plugin: string, digest: string, run: FacetFunction) => {
			this.#collected.push({ plugin, digest, run });
		};
	}

	/** Runs `text` (one or more registered scripts): what it registered. */
	// 清空上次结果，在沙箱全局上下文执行 text，返回本次全部注册项；evaluate 抛错时直接向外传播。
	// 例如初始合并脚本注册两个插件，run 返回长度 2 的数组；同一 text 重复 run 会重新执行并重新收集。
	run(text: string): RegisteredScript[] {
		this.#collected = [];
		this.#channel.evaluate(text, "chord-plugins.js");
		return this.#collected;
	}
}
