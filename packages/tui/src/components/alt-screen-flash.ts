// 管理全屏模式的短暂提示行：TuiAltScreen 调 flash，再把 render 返回的行叠到屏幕右上方，计时到期后移除提示。
// Component 是编译期接口，真正的绘制与重画调度在宿主中。
import type { Component } from "../tui.ts";
// 按可见终端列截断提示，避免直接按字符串长度切开 ANSI 或宽字符。
import { truncateToWidth } from "../utils.ts";

// 默认显示时长 1000 毫秒，显式时长可以覆盖。
const DEFAULT_DURATION_MS = 1000;

// 一条提示的内部记录；interface 只提供开发时结构约束。
interface FlashEntry {
	// 递增标识，用来让超时回调找到自己对应的提示，不按文案去重。
	id: number;
	// 提示原文，显示时才添加两侧空格和反色样式。
	message: string;
	// Node 超时句柄，dispose 时可取消未触发的定时器。
	timer: NodeJS.Timeout;
}

/** Transient messages composited by the alternate-screen renderer. */
// 组件只返回提示行，不决定最终屏幕坐标；多条提示各自拥有生命周期。
export class AltScreenFlashContainer implements Component {
	// readonly 禁止重新绑定 entries，数组内容仍会追加或删除。
	private readonly entries: FlashEntry[] = [];
	// 下一条记录的标识，后缀 ++ 会先取旧值再增加。
	private nextId = 0;
	// 宿主提供的重画请求函数；保存引用不会立即绘制。
	private readonly requestRender: () => void;

	// 创建提示容器，输入无参重画回调，只保存它，不创建定时器。例：new AltScreenFlashContainer(() => tui.requestRender())；构造没有显式返回语句。
	constructor(requestRender: () => void) {
		// 保存宿主回调，之后添加和超时删除时调用。
		this.requestRender = requestRender;
	}

	// 追加一条提示并安排超时删除，无返回值；每条都有自己的标识/定时器，立即请求重画，到期再请求一次。
	// 例：flash("已复制", 500) 约半秒后移除；0 也通过定时器异步删除，不是同步消失。宿主回调异常向上传播，时长实际遵循 Node 定时器规则。
	flash(message: string, durationMs = DEFAULT_DURATION_MS): void {
		// 取当前标识并将 nextId 自增，相同 message 仍会建立独立记录。
		const id = this.nextId++;
		// 创建超时任务；下面的函数注册后等待事件循环执行，不在注册时立即删除。
		const timer = setTimeout(
			// 到期回调无参数/无返回值：查标识、删除并通知重画；若记录已不存在则跳过，不影响其他提示。
			() => {
				// findIndex 按标识找首个对应记录，没找到为 -1。
				const index = this.entries.findIndex((entry) => entry.id === id);
				// 记录已经不在列表中时直接结束，避免 splice(-1) 删除末项。
				if (index === -1) return;
				// 原地删除一条已到期提示。
				this.entries.splice(index, 1);
				// 通知宿主重画，真正擦除屏幕仍要等后续绘制。
				this.requestRender();
			},
			// 负时长夹到 0；不在这里进一步验证 NaN/Infinity，Node 仍按其定时规则处理。
			Math.max(0, durationMs),
		);
		// unref 让这个定时器本身不阻止 Node 进程退出，不代表任务已经取消。
		timer.unref();
		// 对象属性简写保存标识、消息和句柄；按追加顺序保留记录。
		this.entries.push({ id, message, timer });
		// 新提示需要显示，立即请求宿主重画。
		this.requestRender();
	}

	// 清除全部定时器和提示记录，无参数、无返回值；不主动请求重画，也不永久禁止以后 flash。例：全屏 TUI 停止时 dispose 释放任务。
	dispose(): void {
		// 逐条取消尚未触发的超时，不执行它们的删除回调。
		for (const entry of this.entries) clearTimeout(entry.timer);
		// 清空同一数组容器，保留 readonly 字段绑定。
		this.entries.length = 0;
	}

	// 没有渲染缓存，缓存失效接口为空操作，无参数、无返回值。例：主题刷新时调用不会改变提示的到期时间。
	invalidate(): void {}

	// 按 width 返回当前每条提示的反色行，不写终端、不修改记录；顺序与追加顺序相同。
	// 例："已复制" 两侧各加一空格后截到可用列宽，宿主另行放置位置；不在此将多行消息规范成单行，截断工具异常向上传播。
	render(width: number): string[] {
		// map 创建新的结果数组；下面回调逐条生成字符串，不会更改 entry.message。
		return this.entries.map((entry) => {
			// 先给消息两侧留空格，再按列宽截断；空省略串表示超长直接裁掉，不加 "..."。
			const message = truncateToWidth(` ${entry.message} `, width, "");
			// 模板字符串包上 SGR 7 开反色、SGR 27 关反色，只返回控制序列与文字，尚未写终端。
			return `\x1b[7m${message}\x1b[27m`;
		});
	}
}
