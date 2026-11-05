// 给扩展等待界面包边框与可选取消动画，session-share/bug-report等宿主挂载并最终dispose。动画不是业务本身；有signal也需任务主动观察才会取消。type TUI编译后擦除。
import { CancellableLoader, Container, Loader, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
// Theme只用于编译期参数检查，实际样式函数由宿主传入主题对象提供。
import type { Theme } from "../theme/theme.ts";
// 显式把border颜色交DynamicBorder，避免跨模块缓存的默认主题不一致；keyHint使用共享主题/键位。
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

/** Loader wrapped with borders for extension UI */
// 继承Container拼子组件，键输入单独转给内部Loader，不自动把signal绑定任意网络请求。
export class BorderedLoader extends Container {
	// 内部实现可能可取消或普通Loader，联合类型不表示普通Loader也有signal/onAbort。
	private loader: CancellableLoader | Loader;
	// 保存构造时的布尔选择，后面方法按这个约定使用类型断言。
	private cancellable: boolean;
	// 不可取消模式仍提供一份自有信号，类中没有abort它的入口；?表示可能缺字段。
	private signalController?: AbortController;

	// 输入宿主、主题、文案和可选cancellable，搭边框→建/启动Loader→附取消提示，返回新实例；默认可取消。例禁用取消时输入无效但仍可读未取消signal；构造回调/组件错误传播，正常结束需dispose停动画。
	constructor(tui: TUI, theme: Theme, message: string, options?: { cancellable?: boolean }) {
		// 先构造父Container，才能添加子组件。
		super();
		// ??保留显式false，缺配置/缺字段才默认true。
		this.cancellable = options?.cancellable ?? true;
		// 局部颜色闭包使用传入theme，render时处理边框文字。
		const borderColor = (s: string) => theme.fg("border", s);
		// 先把上边框加到布局，尚不直接写终端。
		this.addChild(new DynamicBorder(borderColor));
		// 可取消模式使用专用Loader，信号由它持有。
		if (this.cancellable) {
			// 构造会立即更新显示/请求重画/启动默认动画，不是惰性等render才计时。
			this.loader = new CancellableLoader(
				// 内部Loader使用同一TUI宿主。
				tui,
				// 默认动画accent色。
				(s) => theme.fg("accent", s),
				// 消息muted色。
				(s) => theme.fg("muted", s),
				// 消息原文，不在这里拼取消说明。
				message,
			);
		} else {
			// 不可取消模式建自己的控制器，以便signal访问器仍能返回信号；本类不调用它的abort。
			this.signalController = new AbortController();
			// 普通Loader也会启动动画，但没有按键取消处理。
			this.loader = new Loader(
				// 传同一重画宿主。
				tui,
				// 普通模式同样动画accent。
				(s) => theme.fg("accent", s),
				// 普通模式消息muted。
				(s) => theme.fg("muted", s),
				// 文案沿用输入。
				message,
			);
		}
		// 把已构造的内部动画组件接到容器布局。
		this.addChild(this.loader);
		// 只有可取消模式附取消键提示，不代表这里自动处理全局按键。
		if (this.cancellable) {
			// 动画下空一行分开提示。
			this.addChild(new Spacer(1));
			// 使用tui.select.cancel动作的当前键名，Text左右留1列/上下0行。
			this.addChild(new Text(keyHint("tui.select.cancel", "cancel"), 1, 0));
		}
		// 下边框前再留一行，两模式都有。
		this.addChild(new Spacer(1));
		// 下边框使用相同颜色闭包，宽度在render时决定。
		this.addChild(new DynamicBorder(borderColor));
	}

	// 返回供业务监听的信号，读取不取消操作；例fetch接loader.signal后才有协作取消关系。可取消模式复用内部信号，普通模式正常复用自有信号，不会因dispose变为aborted。
	get signal(): AbortSignal {
		// 按构造选择区分两种实现，非instanceof自动收窄。
		if (this.cancellable) {
			// as只让TS允许访问signal，不产生运行时检查；内部构造分支维持该约定。
			return (this.loader as CancellableLoader).signal;
		}
		// 通常返回自有控制器信号；若缺失才临时造新未取消信号，该回退没有保存且不能由本对象再abort。
		return this.signalController?.signal ?? new AbortController().signal;
	}

	// 赋loader.onAbort=fn只在可取消模式透传通知；例外层可在取消键时关闭UI。可设undefined清回调，setter返回void，不检查已经取消就立即补调用。
	set onAbort(fn: (() => void) | undefined) {
		// 普通模式忽略赋值，不另存回调。
		if (this.cancellable) {
			// 把同一函数引用交CancellableLoader；反复按取消键可能反复调用回调，取消信号只首次改变状态。
			(this.loader as CancellableLoader).onAbort = fn;
		}
	}

	// 转发宿主键数据，返回void；例配置取消键触发内部abort/onAbort，其他键由内部忽略。不可取消模式全忽略，不主动关闭界面/停动画，回调错误可向外抛。
	handleInput(data: string): void {
		// 仅构造时选择可取消的实例才转发。
		if (this.cancellable) {
			// 断言不校验对象形状，内部CancellableLoader用当前全局键位匹配取消动作。
			(this.loader as CancellableLoader).handleInput(data);
		}
	}

	// 释放内部动画资源，优先dispose否则stop，返回void；例上传结束后清动画，不会abort业务或清空子布局，也不触发onAbort。方法异常没有catch。
	dispose(): void {
		// 原实现运行时探测dispose存在且可调用；这里保留该分派，不把in当已验证任意外部数据的完整边界。
		if ("dispose" in this.loader && typeof this.loader.dispose === "function") {
			// CancellableLoader.dispose只停动画，保持信号/回调状态。
			this.loader.dispose();
			// 没有dispose才探测stop，普通Loader走这条路。
		} else if ("stop" in this.loader && typeof this.loader.stop === "function") {
			// 停止周期切帧，不清显示文字，也不终止上传/模型请求。
			this.loader.stop();
		}
	}
}
