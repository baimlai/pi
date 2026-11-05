// 交互界面的渲染器组装入口：按模式选主屏/备用屏，提供主题/复制/链接回调；再用稳定Proxy把组件的调用转到宿主当前渲染器。
// 终端/滚轮配置只参与类型检查，下面几个类是真正构造器。
import type { Terminal, WheelScrollLines } from "@earendil-works/pi-tui";
// ProcessTerminal适配真实进程I/O；两个Tui类保存并渲染组件，TUI接口只约束可用方法。
import { ProcessTerminal, type TUI, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
// 复制回调触发时才使用系统剪贴板辅助，组装选项时不立即复制。
import { copyToClipboard } from "../../utils/clipboard.ts";
// 浏览器打开函数同样作为回调传入，不因导入/配置openUrl就访问链接。
import { openBrowser } from "../../utils/open-browser.ts";
// 读取当前可配置快捷键的展示文字，供跳到最新消息按钮用，不硬编码按键行为。
import { keyDisplayText } from "./components/keybinding-hints.ts";
// 稳定主题代理在实际样式回调执行时读取当前主题，因此换主题无需重建所有回调。
import { theme } from "./theme/theme.ts";

// 宿主决定模式和显示配置；readonly是TS约束，具体默认值/副作用见组装函数与Tui构造器。
export interface InteractiveTuiOptions {
	// regular使用主屏，fullscreen使用备用屏；这是类型限制，运行代码只单独判断fullscreen。
	readonly tuiMode: "regular" | "fullscreen";
	// 是否显示硬件光标，原样交给Tui类，不在此发光标序列。
	readonly showHardwareCursor: boolean;
	// 供Tui诊断输出使用的目录，本函数不创建它。
	readonly logDirectory: string;
	// 可注入虚拟终端测试；缺省才new ProcessTerminal，仍需宿主另调用start。
	readonly terminal?: Terminal;
	// 可选右键粘贴动作，函数只转交，不在组装时读取剪贴板。
	readonly onRightClickPaste?: () => void;
	// 全屏选中即复制配置，undefined交由TuiAltScreen采用它的默认策略。
	readonly fullscreenCopyOnSelect?: boolean;
	// 全屏滚轮行数或auto；本层缺省auto，实际每次滚动计算在TuiAltScreen。
	readonly fullscreenWheelScrollLines?: WheelScrollLines;
}

/** Composition root shared by coding-agent presentations. */
// 下面三个是重载签名，仅给TS更精确的返回类型；JS运行时只有后面一个函数实现。交叉类型把这一签名的tuiMode收窄为fullscreen。
export function createInteractiveTui(options: InteractiveTuiOptions & { readonly tuiMode: "fullscreen" }): TuiAltScreen;
// 已知regular时调用方得到TuiMainScreen类型，不必自己断言。
export function createInteractiveTui(options: InteractiveTuiOptions & { readonly tuiMode: "regular" }): TuiMainScreen;
// 动态模式变量使用联合返回类型，不能仅凭这个签名访问全屏独有能力。
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen;
// 选终端→按模式造渲染器→全屏额外安装样式/链接/复制回调，返回未start的实例。例注入VirtualTerminal可在内存测试；真实终端start/复制/打开链接的副作用由宿主和后续回调触发，构造/主题回调异常不会统一吞掉。
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen {
	// ??只在缺省时创建真实适配器，不覆盖调用方提供的虚拟终端。
	const terminal = options.terminal ?? new ProcessTerminal();
	// 仅明确fullscreen走备用屏，其他运行值会走下方主屏；本层不做配置schema校验。
	if (options.tuiMode === "fullscreen") {
		// 内层包搜索文字前景，外层包搜索背景；箭头此时只定义，实际调用才读取theme。
		const styleSearchMatch = (text: string) => theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
		// 四个参数分别是终端、硬件光标开关、日志目录、全屏扩展选项；没有在此start。
		return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
			// 普通匹配额外加下划线，保留共享颜色样式。
			searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
			// 当前匹配加反显和粗体，反显交换显示前/背景；不是修改主题token名册。
			searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(styleSearchMatch(text))),
			// 搜索导航按钮仅hover时加下划线，不在此处理鼠标坐标。
			searchNavigationButtonStyle: (text, hovered) => (hovered ? theme.underline(text) : text),
			// 回到底部提示是惰性函数，每次请求提示时读最新快捷键与主题。
			scrollToEndIndicator: () => {
				// 按动作id查当前可配置按键；无绑定时可得到空展示文字。
				const shortcut = keyDisplayText("tui.altScreen.bottom");
				// 模板里的条件插值只在快捷键文字真值时加入分隔点，空格也是实际提示内容，保持原样。
				const label = ` ↓ Jump to latest message${shortcut ? ` · ${shortcut}` : ""} `;
				// 提示用选择背景/默认正文前景，不负责真正滚到底部。
				return theme.bg("selectedBg", theme.fg("text", label));
			},
			// 原函数引用交给渲染器，实际点击时才可能启动外部浏览器。
			openUrl: openBrowser,
			// 可选粘贴回调透传，不在这里构造默认动作。
			onRightClickPaste: options.onRightClickPaste,
			// undefined不被强改false，由TuiAltScreen的构造默认策略解释。
			copyOnSelect: options.fullscreenCopyOnSelect,
			// 滚轮设置缺省采用auto，数字0等显式值不会被??替换。
			wheelScrollLines: options.fullscreenWheelScrollLines ?? "auto",
			// 异步复制回调按Tui约定返回true或错误文字，不是Agent工具结果；会真正调用剪贴板辅助。
			copySelection: async (text) => {
				// try同时包住异步复制及下面成功return，拒绝走catch。
				try {
					// 等剪贴板辅助完成，宿主平台/可用命令会影响成功与失败。
					await copyToClipboard(text);
					// true表示辅助未抛错，不额外查询系统验证粘贴内容。
					return true;
					// Error保留message，其他抛出值转String；自定义字符串转换仍可能再次抛错。
				} catch (error) {
					// 失败作为文字返回给渲染器展示，不在此throw原Error或脱敏。
					return error instanceof Error ? error.message : String(error);
				}
			},
		});
	}
	// 主屏只接共同三个参数，没有装全屏选择/搜索扩展选项；返回实例仍由宿主启动。
	return new TuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);
}

/** Stable reference for components while InteractiveMode replaces the active renderer. */
// 创建稳定的TUI代理：读属性/调用已取出的方法时取当前渲染器，写/has/原型查询也转发。例先保存const render=ui.requestRender，宿主换renderer后再render()会调用新实例；不复制组件树或自动迁移状态，getter/方法异常照常传播。
export function createInteractiveTuiReference(getTui: () => TUI): TUI {
	// 空目标as TUI仅让TS接受代理类型，实际能力由下面的代理处理函数转发；没有ownKeys枚举处理，枚举代理不等于枚举当前TUI。
	return new Proxy({} as TUI, {
		// 每次属性读取触发get；property可为字符串或symbol，_target未使用。
		get: (_target, property) => {
			// 现取渲染器，宿主可在模式切换时更换该getter返回值。
			const tui = getTui();
			// receiver用真实tui，让getter内的this指向实例，而不是空Proxy目标。
			const value = Reflect.get(tui, property, tui);
			// 普通值直接返回：对象仍是原引用，先前保存的值不会自动变成新实例的值。
			if (typeof value !== "function") return value;
			// 函数属性则记住此次读取时的实例和函数，每次属性读取都会新建下面这份包装，不是跨读取稳定函数身份。
			let methodTui = tui;
			// let允许在后面检测实例换了时更新被调用函数。
			let method = value;
			// 包装箭头接任意参数数组；箭头没有自己的this，真正接收者由Reflect.apply指定。
			return (...args: unknown[]) => {
				// 方法真正调用时再查一次当前实例，支持先取方法后切renderer的情况。
				const currentTui = getTui();
				// 仅实例身份改变才重新读方法，同一实例原地替换该方法不会使这个已取出的包装重新读取。
				if (currentTui !== methodTui) {
					// 从新实例按同一property取方法，receiver仍为新实例，getter可能在此执行/抛错。
					const currentMethod = Reflect.get(currentTui, property, currentTui);
					// renderer切换后同名属性若已非函数，给出明确错误，不试着调用旧实例方法兜底。
					if (typeof currentMethod !== "function") {
						// String允许symbol键出现在说明中，抛TypeError使本次调用失败。
						throw new TypeError(`TUI property ${String(property)} is not callable`);
					}
					// 先更新本包装记住的实例引用。
					methodTui = currentTui;
					// 再记新函数，后面同实例调用可直接复用。
					method = currentMethod;
				}
				// 使用真实实例作this传入原参数，原返回值/Promise/异常透传；不会自动await或统一catch。
				return Reflect.apply(method, methodTui, args);
			};
		},
		// 属性写入时取当前实例；value的隐式类型来自ProxyHandler，不在这里做业务值校验。
		set: (_target, property, value) => {
			// 每次赋值独立查当前实例，与之前缓存的函数包装无关。
			const tui = getTui();
			// receiver用tui，setter的this也指真实实例；返回布尔表示Reflect设置是否成功。
			return Reflect.set(tui, property, value, tui);
		},
		// property in ui转到当前实例/原型链判断，不触发空目标的默认has规则。
		has: (_target, property) => Reflect.has(getTui(), property),
		// Object.getPrototypeOf等查询转到当前实例原型；其他未定义的Proxy操作仍按空目标默认行为。
		getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
	});
}
