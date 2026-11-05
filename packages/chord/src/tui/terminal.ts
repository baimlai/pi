// The terminal as the app's terminal code sees it inside the sandbox (slice 11 §4): its size, writing frames, and
// input and resizes, all through the bridge; the launcher holds the real terminal. Library-agnostic: an app adapts it
// to its terminal UI library (pi-tui's `Terminal` in a few lines).
// 中文说明：本文件把沙箱通道包装成应用可用的终端对象。上游：startTerminalRuntime 创建 BridgeTerminal；
// 下游：应用把这些方法适配到自己的终端 UI 库。真实终端由启动器持有，这里只转发写入与订阅输入/尺寸。
// 所属：tui 沙箱侧终端适配器，与具体终端 UI 库无关。
// 边界：缓存尺寸、转发写入/订阅，不建连接、不分帧、不解析输入；所有 I/O 经 SandboxChannel。
// 上游：startTerminalRuntime 创建 BridgeTerminal；下游：SandboxChannel 的 write/onInput/onResize。
// 导出清单：BridgeTerminal；columns/rows 读取尺寸，write 输出，onInput/onResize 订阅事件。
// 组合：new BridgeTerminal(channel) → 应用订阅 onResize/onInput → 用 columns/rows 绘制 → write。
// 示例：const terminal = new BridgeTerminal(channel); terminal.write("hi");
// 阅读顺序：字段/构造 → columns/rows → write → onInput → onResize。

import type { SandboxChannel } from "./channel.ts";

/** The bridged terminal. */
// 沙箱侧的终端视图：缓存当前尺寸，写入经 channel 成帧，输入/尺寸订阅直接转给 channel。
export class BridgeTerminal {
	// #channel：桥接通道；#columns/#rows 是最近一次已知尺寸，由构造参数和 resize 消息更新。
	readonly #channel: SandboxChannel;
	#columns: number;
	#rows: number;

	// 读取启动尺寸并登记尺寸监听；该监听先于应用监听注册，因此 Set 顺序保证应用回调看到新值。
	constructor(channel: SandboxChannel) {
		this.#channel = channel;
		this.#columns = channel.start.columns;
		this.#rows = channel.start.rows;
		channel.onResize((columns, rows) => {
			this.#columns = columns;
			this.#rows = rows;
		});
	}

	// 当前列数；getter 只读缓存，不向启动器查询，也不触发 resize。
	get columns(): number {
		return this.#columns;
	}

	get rows(): number {
		return this.#rows;
	}

	/** Writes `data` (text and escape sequences) to the terminal. */
	// 原样交给 channel；分帧、转义序列保护和启动器发送都在那里完成，这里不做缓冲。
	write(data: string): void {
		this.#channel.write(data);
	}

	/** Calls `listener` with each input (keys, pastes, as the terminal sends them) until the returned removal. */
	// 订阅原始输入并返回移除函数；不解析按键，交由应用/终端库解释。
	onInput(listener: (data: string) => void): () => void {
		return this.#channel.onInput(listener);
	}

	/** Calls `listener` after each resize (the new size read from `columns` and `rows`) until the returned removal. */
	// 包装一层无参回调：应用通过 columns/rows 读取最新尺寸；移除函数同样透传。
	onResize(listener: () => void): () => void {
		return this.#channel.onResize(() => listener());
	}
}
