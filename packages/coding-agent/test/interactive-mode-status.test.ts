// 用原型方法、假会话与真实内存组件检验状态合并、扩展对话焦点、补全和资源路径展示；不构造InteractiveMode、不执行模型或包管理器。
// 少数用例确实start/stop注入VirtualTerminal的TuiMainScreen：控制串写入内存xterm，仍涉及帧计时与进程exit监听；不接管宿主TTY。
// 资源路径是夹具文字，homedir仅取系统家目录字符串；实际自动补全查询只走/model与/login参数分支，不扫描这些目录或运行fd。
// 从node:os取系统家目录，用于构造路径格式化样本，不读取家目录下文件。
import { homedir } from "node:os";
// 命名空间path提供宿主平台的join等词法操作；Windows样本字符串也会按被测助手规则单独规范分隔符。
import * as path from "node:path";
// AutocompleteProvider是擦除的接口，CombinedAutocompleteProvider是真实组合器；构造只存候选/基目录/fd，查询是否读盘取决于分支。
import { type AutocompleteProvider, CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
// Vitest注册主题初始化、分组、普通/参数化用例与调用记录器；测试回调在运行器执行时才操作组件。
import { beforeAll, describe, expect, test, vi } from "vitest";
// 从TUI源文件取真实内存容器与仅供TS的组件/焦点/宿主类型，type项目不生成运行值。
import { type Component, Container, type Focusable, type TUI } from "../../tui/src/tui.ts";
// 主屏渲染器会执行真实布局、焦点及浮层逻辑，但其终端由测试注入，不默认创建ProcessTerminal。
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
// VirtualTerminal用headless xterm解析控制序列，不连接真实stdin/stdout、PTY或剪贴板。
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
// 包装工厂类型接旧补全器、返回新补全器；类型声明不会登记工厂或调用补全。
import type { AutocompleteProviderFactory } from "../src/core/extensions/types.ts";
// QuietStartup允许false/true/"header"等设置视图，后面区分保留页头与隐藏资源的规则。
import type { QuietStartup } from "../src/core/settings-manager.ts";
// SourceInfo是路径来源元数据，不代表文件存在、资源已执行或来源已被信任。
import type { SourceInfo } from "../src/core/source-info.ts";
// 登录候选类型允许同Provider以OAuth/API key分别出现，补全会再按ID合并。
import type { AuthSelectorProvider } from "../src/modes/interactive/components/oauth-selector.ts";
// 只借InteractiveMode.prototype调用真实方法，避开其构造器的Git监听、用户设置和终端初始化。
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
// 共享主题dark按需读内置JSON，默认不watch；冷颜色能力可能查tmux，执行测试时可用PI_HYPERLINKS=0短路该探测。
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// 渲染容器最后一个孩子，输入容器和缺省120列宽、返回合并文字，无终端输出；例如Spacer/Text组合只取末项Text。
// 只看最后组件，不拼整个聊天；组件render本身的异常直接向调用方传播。
function renderLastLine(container: Container, width = 120): string {
	// 按children.length-1取最后引用；空数组得到undefined，不会自动制造空组件。
	const last = container.children[container.children.length - 1];
	// 末项缺省就返回空串；这里不把缺项视作测试异常。
	if (!last) return "";
	// 调用该组件render(width)，其多行结果以LF拼接；保留其中ANSI样式与内部空白。
	return last.render(width).join("\n");
}

// 渲染全部直接孩子并按LF连接，输入同样默认120列、返回string；例Spacer也贡献它的空行，不读真实屏幕。
function renderAll(container: Container, width = 120): string {
	// flatMap按孩子顺序展开每份行数组，再join；不会递归调用子组件以外的任意对象，也不主动剥ANSI。
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

// 用最小可聚焦组件记录焦点、输入与编辑文字；implements仅让TS检查接口，不继承真实Editor，也不读取键盘。
// 例如sendInput("x")经TUI分派后会写inputs，而render始终显示构造时label，不显示保存的text。
class TestFocusableComponent implements Component, Focusable {
	// 初始无焦点；TUI在切换焦点时可通过这个公开布尔字段设置状态。
	focused = false;
	// 每个实例自己的字符串数组记录收到的完整输入块；const语义不适用于该可重赋字段，push会改数组。
	inputs: string[] = [];
	// private/readonly仅限制TS可见性与字段重赋；label引用的字符串在构造中初始化，不是运行时#私有字段。
	private readonly label: string;
	// 编辑文字初始空串，独立于label与输入日志；handleInput不会自动把字符追加到它。
	private text = "";

	// 构造组件，输入展示标签、返回实例；例如"OVERLAY"只作为屏幕识别文字，没有终端或文件副作用。
	constructor(label: string) {
		// 把参数保存为本实例字段，局部label与this.label是不同绑定。
		this.label = label;
	}

	// 记录TUI交来的输入块，接string、返回void；例如一次"x"追加一个数组元素，不解析键或执行命令。
	handleInput(data: string): void {
		// push原地追加日志，不改组件text，也不自动请求重绘。
		this.inputs.push(data);
	}

	// 返回当前保存的编辑文字，无输入/副作用；用于showExtensionCustom保存与恢复编辑器内容。
	getText(): string {
		// 直接返回string字段，不拼inputs或读取label。
		return this.text;
	}

	// 覆盖组件保存文字，接string、返回void；例如恢复"abc"只改该字段，不触发onChange或真实编辑器行为。
	setText(text: string): void {
		// 把新字符串赋给字段，旧值不作为撤销记录保存。
		this.text = text;
	}

	// 返回一行构造标签，成功为string[]；方法省略未使用的width形参仍能满足Component接口，不按宽度裁剪。
	render(): string[] {
		// 每次新建单元素数组，但字符串值来自固定label；不会把text或inputs画出来。
		return [this.label];
	}

	// 空invalidate满足组件契约，调用无返回也不清日志/文本；测试组件没有需要失效的渲染缓存。
	invalidate(): void {}
}

// 请求强制TUI帧，再等待微任务及虚拟终端常用渲染屏障，返回Promise<void>；例如挂浮层后用它再检查focus/viewport。
// 不是任意动画或未来异步任务全部完成的保证：waitForRender先nextTick、约20ms定时，再排空已有xterm写入。
async function flushTui(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	// force=true让渲染器重置帧缓存并排绘制，不同步保证此行返回时屏幕已更新。
	tui.requestRender(true);
	// 等待已兑现Promise仍会让当前async函数暂停到微任务继续，为自定义组件工厂的Promise链提供机会。
	await Promise.resolve();
	// 再等虚拟终端的nextTick/20ms/写队列辅助，不等待真实显示器或用户输入。
	await terminal.waitForRender();
}

// 把容器完整渲染文本归一化供断言，缺省220列、返回新串；去有限SGR、反斜杠转正斜杠、裁每行尾空白及整串两端。
// 例如Windows路径显示成/便于跨平台快照；这不是通用ANSI净化器，也不读取路径文件。
function normalizeRenderedOutput(container: Container, width = 220): string {
	// 先调用本文件renderAll，保留组件顺序；后面链式处理均生成文本结果，不修改组件。
	return (
		renderAll(container, width)
			// 全局替换ESC[数字/分号m形式SGR；不覆盖所有ANSI协议或含冒号的样式写法。
			.replace(/\u001b\[[0-9;]*m/g, "")
			// 把所有反斜杠字符换为/，不仅限路径分隔符，不解析转义后的命令行。
			.replace(/\\/g, "/")
			// 按LF拆分为行数组，CR若在行末也可能由下一步空白裁切去掉。
			.split("\n")
			// 逐行删除末尾连续JS正则空白；g不改变这里只需一次尾部匹配的结果，保留行首空格。
			.map((line) => line.replace(/\s+$/g, ""))
			// 用LF重新连接处理后的每行，不改变行的先后。
			.join("\n")
			// 再trim整串首尾空白，去开头Spacer等留白；内部缩进与换行仍保留参与快照。
			.trim()
	);
}

// 扩展夹具只保留路径及可选来源；这不是已经加载并执行过的Extension实例。
type ExtensionFixture = {
	// path是入口路径文字，可完全不存在，不由类型自动验证文件。
	path: string;
	// ?允许无来源信息，后续显示助手必须处理这种裸路径样本。
	sourceInfo?: SourceInfo;
};

// 注册状态合并两例：连续状态复用最后Spacer/Text，中间插入其他组件则新建一对；不检验持久化历史或真实终端帧。
describe("InteractiveMode.showStatus", () => {
	// 本组运行前初始化共享主题，回调无业务结果；没有在组后恢复先前主题。
	beforeAll(() => {
		// showStatus uses the global theme instance
		// 加载dark内置主题供ThemedText取色，默认不启watch；冷能力探测的环境边界见导入说明。
		initTheme("dark");
	});

	// 顺序显示STATUS_ONE再STATUS_TWO，要求组件数仍2且末项只含后者；这是相邻复用，不是按相同文案去重。
	test("coalesces immediately-sequential status messages", () => {
		// 旧any保留原测试的宽松假this写法，绕过私有成员/完整类类型，不构造真实InteractiveMode或补全所有字段。
		const fakeThis: any = {
			// 全新Container保存真实Spacer/ThemedText，初始无孩子。
			chatContainer: new Container(),
			// requestRender仅记录调用，不启动TUI帧或写真实终端。
			ui: { requestRender: vi.fn() },
			// 初始无最近状态Spacer引用，让第一次调用创建新对象。
			lastStatusSpacer: undefined,
			// 初始无最近Text；真实方法还会按需在假this上新增lastStatusMessage字段。
			lastStatusText: undefined,
		};

		// 通过原型方法.call绑定假接收者，同步添加第一对组件，不经过构造器。
		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		// 长度2直接检查Spacer/Text两项的总数，不断言其具体类或终端行高。
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		// 只渲染末项并要求含STATUS_ONE，未限定全部ANSI/留白字符串。
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		// 第二次接同一假this；真实方法比较末两项对象身份后修改共享文案并invalidate旧Text。
		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		// 组件数仍2说明这个样本没有追加新一对，不证明所有未来状态永远复用。
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		// 渲染末项应采用更新后的文案，检查旧缓存已失效并重建显示。
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		// 同一末项不应仍含第一条文字；不检查聊天中其他对象的历史快照语义。
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	// 在两次状态间插入普通组件，要求第二次再追加Spacer/Text形成5项；不把任意组件更新都当作插入。
	test("appends a new status line if something else was added in between", () => {
		// 本例独立假接收者，any只是放宽TS，不继承前例状态。
		const fakeThis: any = {
			// 独立空聊天容器避免复用上一例的孩子列表。
			chatContainer: new Container(),
			// 重绘只用记录器，不实际启动终端。
			ui: { requestRender: vi.fn() },
			// 最近Spacer初始undefined。
			lastStatusSpacer: undefined,
			// 最近Text初始undefined，首条状态需创建完整配对。
			lastStatusText: undefined,
		};

		// 显示第一条状态，真实方法向此容器追加两项。
		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		// 确认首条后的组件总数2，为后面增长提供基线。
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		// 添加真正占一项的简易组件；render返回OTHER，invalidate空函数，不模拟模型消息保存。
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		// 总数3证明中间对象确实加入当前容器，而非仅改变一个已有组件文本。
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		// 第二条状态发现末尾不是上次Spacer/Text配对，进入新建路径。
		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		// 总数5观察到旧2项+普通1项+新2项；没有断言旧状态行以后invalidate时仍保留旧文案。
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		// 只检查新末项含STATUS_TWO，其他内容与重绘次数未在本例断言。
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

// 注册托管工具进度显示一例，消息是手写样本，不实际下载fd/rg或验证工具安装。
describe("InteractiveMode.showManagedToolStatus", () => {
	// 本组首次运行前切共享dark主题，箭头直接返回initTheme的void。
	beforeAll(() => initTheme("dark"));

	// 连续三项工具更新应仅首次留Spacer、每项各有独立文字；归一化后完整比较三行，区别普通showStatus的相邻合并。
	test("renders tool updates as one contiguous group", () => {
		// any假this仅含被测方法要访问的状态，不创建PackageManager或终端。
		const fakeThis: any = {
			// 真实聊天容器初始空。
			chatContainer: new Container(),
			// 重绘记录器不做I/O。
			ui: { requestRender: vi.fn() },
			// 尚未显示工具区，首次进度需要起始空白并把此标志改true。
			managedToolStatusStarted: false,
			// 普通状态的Spacer跟踪初始无值，工具方法会再次清它。
			lastStatusSpacer: undefined,
			// 普通Text跟踪初始无值，不用工具行覆盖普通状态Text。
			lastStatusText: undefined,
		};
		// 取出私有原型方法作为函数值；没有bind，下面每次用.call显式指定接收者。
		const showManagedToolStatus = (InteractiveMode as any).prototype.showManagedToolStatus;

		// 第一条info只显示fd downloading，名称不是要执行的命令。
		showManagedToolStatus.call(fakeThis, { type: "info", message: "fd downloading" });
		// 第二条info独立追加rg downloading，不额外开启另一个工具组Spacer。
		showManagedToolStatus.call(fakeThis, { type: "info", message: "rg downloading" });
		// warning追加Warning前缀并用警告色，不会在这里抛出真实下载异常。
		showManagedToolStatus.call(fakeThis, { type: "warning", message: "rg failed" });

		// 总4项为起始Spacer加3个Text，不意味着渲染后恰4个可见非空行。
		expect(fakeThis.chatContainer.children).toHaveLength(4);
		// 使用本文件归一化后精确比较整个字符串，包括第二/三行保留的水平内边距。
		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toBe(
			// 第一行首空格被整串trim去掉，后两行的行首空格仍参与相等断言；字符串内容保持原样。
			"fd downloading\n rg downloading\n Warning: rg failed",
		);
	});
});

// 注册统一展开动作一例，使用有setExpanded能力的假页头/资源/聊天项，不运行真实工具渲染器。
describe("InteractiveMode.setToolsExpanded", () => {
	// 把全局false改true，要求三处能力收到true并显示状态；没有覆盖同值早返、自定义页头优先或异常分支。
	test("applies expansion state to the active header and chat entries", () => {
		// 页头只提供setExpanded记录器，不需要真实Component.render，原any测试允许最小形状。
		const header = { setExpanded: vi.fn() };
		// 资源直接子项也只记录展开参数，不建立实际资源加载器。
		const loadedResourcesChild = { setExpanded: vi.fn() };
		// 聊天直接子项同样用记录器，展示范围不只“工具”。
		const chatChild = { setExpanded: vi.fn() };
		// 假接收者含真实方法读取的容器和状态能力，any绕过完整实例要求。
		const fakeThis: any = {
			// 起始展开目标false，确保true调用不会因同值门禁直接结束。
			toolOutputExpanded: false,
			// 没有自定义页头，真实方法应回退内置页头。
			customHeader: undefined,
			// 把前面header对象放内置槽，保留其记录器引用供后面断言。
			builtInHeader: header,
			// 资源容器只需children数组，方法不会在这一用例调用其render。
			loadedResourcesContainer: { children: [loadedResourcesChild] },
			// 聊天容器同样只需直接children，不构造普通状态真实组件。
			chatContainer: { children: [chatChild] },
			// 提供重绘记录器，但本例真实setToolsExpanded通过showStatus安排反馈，本地没有断言这个记录器次数。
			ui: { requestRender: vi.fn() },
			// showStatus用假函数截住最终提示，不再进入真实状态合并流程。
			showStatus: vi.fn(),
		};

		// 调用真实展开方法并传布尔true，不是让各子项自己翻转。
		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);

		// 检查全局字段已更新为true，而非仅转发子项调用。
		expect(fakeThis.toolOutputExpanded).toBe(true);
		// 检查活动内置页头收到true；不限制重复调用次数。
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		// 资源子项收到相同目标，证明本样本覆盖资源容器。
		expect(loadedResourcesChild.setExpanded).toHaveBeenCalledWith(true);
		// 聊天子项也收到目标，未检验嵌套子孙递归行为。
		expect(chatChild.setExpanded).toHaveBeenCalledWith(true);
		// 最终反馈文字必须是Tool output: expanded，不真正显示或保存该状态。
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Tool output: expanded");
	});
});

// 注册扩展UI主题名称设置的成功/失败两例；主题控制器与设置管理器均为假函数，不写用户settings.json。
describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	// 成功时名称light应转控制器、保存设置并重绘一次；“persists”在本例仅由setTheme调用与内存变量模拟，不证明磁盘落盘。
	test("persists theme changes to settings manager", () => {
		// 先初始化真实dark共享主题，保证扩展UI使用的Theme类/代理处于有效状态，不启文件watch。
		initTheme("dark");

		// let保存设置替身的当前名称，可由下方setTheme回调改写，不是读取磁盘配置。
		let currentTheme = "dark";
		// 新设置对象包含被测UI适配会读取/调用的两个记录器。
		const settingsManager = {
			// getTheme同步返回此时currentTheme，闭包读取新值而非构造期字符串副本。
			getTheme: vi.fn(() => currentTheme),
			// setTheme记录目标并同步改本地变量，参数string只由TS约束，不调用真实SettingsManager。
			setTheme: vi.fn((theme: string) => {
				// 赋值模拟保存后的有效名称，没有异步flush或文件I/O。
				currentTheme = theme;
			}),
		};
		// any假this供应会话/设置/控制器/UI能力，createExtensionUIContext只建立闭包，不需要完整真实类。
		const fakeThis: any = {
			// 假session挂同一个settingsManager引用，但本次setTheme闭包实际读取外层假this.settingsManager。
			session: { settingsManager },
			// 让直接settingsManager属性与session内引用一致，不深复制记录器。
			settingsManager,
			// 主题控制器是手写假对象，不能据返回success判断真实主题文件可加载。
			themeController: {
				// 实例设置分支也提供成功记录器，但本例传字符串不会使用它。
				setThemeInstance: vi.fn(() => ({ success: true })),
				// 名称分支的记录器模拟成功切换，同时主动请求一次假重绘。
				setThemeName: vi.fn(() => {
					// 此重绘由假控制器自己调用，不是createExtensionUIContext另加的一次真实TUI渲染。
					fakeThis.ui.requestRender();
					// 返回success:true对象使真实UI适配继续比较并保存设置。
					return { success: true };
				}),
			},
			// requestRender记录器供断言次数，无真实终端。
			ui: { requestRender: vi.fn() },
		};

		// 借原型在假this上创建真实ExtensionUIContext对象；创建本身不调用全部UI方法。
		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		// 调用其中setTheme("light")，这是被测试的名称适配路径，不执行真实ThemeController。
		const result = uiContext.setTheme("light");

		// 要求返回控制器的成功结果，不读取磁盘确认。
		expect(result.success).toBe(true);
		// 要求控制器收到完整名称light，未触发Theme实例分支。
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("light");
		// 要求设置记录器被传light，不限制该记录器只能调用一次。
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		// 本地currentTheme确实变light，验证假setTheme回调生效，不等于实际用户配置已写入。
		expect(currentTheme).toBe("light");
		// 重绘累计一次来自假控制器，真实UI适配没有额外再请求一帧。
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	// 假控制器拒绝缺失名称时不得保存设置或请求重绘；不真实读取/创建__missing_theme__文件。
	test("does not persist invalid theme names", () => {
		// 真实共享主题仍初始化dark；下面“无效名称”的拒绝由mock返回，不交真实加载器判定。
		initTheme("dark");

		// 设置替身独立于成功用例，不沿用currentTheme变量。
		const settingsManager = {
			// getTheme恒定dark，若真被调用也不会读文件。
			getTheme: vi.fn(() => "dark"),
			// setTheme仅记录，后面要求它保持零次。
			setTheme: vi.fn(),
		};
		// 本例假接收者使用新的设置/控制器/UI记录器。
		const fakeThis: any = {
			// 会话内保存相同设置引用，未创建真实会话。
			session: { settingsManager },
			// 直接设置属性供适配器使用。
			settingsManager,
			// 假控制器让名称切换固定失败，不依赖宿主目录里的实际主题。
			themeController: {
				// 实例分支提供成功替身，本例仍不会传Theme实例。
				setThemeInstance: vi.fn(() => ({ success: true })),
				// 名称分支返回明确失败和文字，不throw异常；被测方法按success:false早跳保存逻辑。
				setThemeName: vi.fn(() => ({ success: false, error: "Theme not found" })),
			},
			// 重绘记录器不会由此失败假控制器调用。
			ui: { requestRender: vi.fn() },
		};

		// 创建真实UI适配闭包，尚不触发主题切换。
		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		// 用固定缺失名称调用真实setTheme适配，它只把名称交假控制器。
		const result = uiContext.setTheme("__missing_theme__");

		// 要求返回失败标志，不断言完整error文字或真实主题回退。
		expect(result.success).toBe(false);
		// 确认名称完整转给控制器，避免错误路径根本没执行却偶然不保存。
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("__missing_theme__");
		// 设置写记录器应未调用；本例没有真实磁盘保存过程。
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		// 失败控制器不重绘，UI适配也未自行加重绘。
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

// 注册自定义UI焦点恢复回归，共一个普通例和两行参数化例；会启动真实TUI调度，但终端始终是内存VirtualTerminal。
describe("InteractiveMode.showExtensionCustom", () => {
	// 本组开跑前准备共享主题，工厂收到的theme可使用它，不调用真实InteractiveMode.init。
	beforeAll(() => {
		// 加载dark内置主题，默认不建立watch；由执行环境抑制可能的冷tmux能力查询。
		initTheme("dark");
	});

	// Inline custom components go through the extension dialog stack.
	// 无参工厂每次返回全新对话栈状态和真实原型方法；例如每个假this展开一次，彼此不共享extensionDialogs数组。
	// 箭头后的({})表示返回对象，不是函数块；只准备方法引用，不马上压栈或设置焦点。
	const extensionDialogState = () => ({
		// 本次独立的空行内对话栈；后续真实push/remove方法会修改它。
		extensionDialogs: [],
		// 阻塞状态用记录器承接，不建立真实ProgramStatusReporter或改变执行任务。
		programStatus: { setBlocked: vi.fn() },
		// 复用真实压栈实现，后续以假this方法形式调用才能访问此假栈/UI。
		pushExtensionDialog: (InteractiveMode as any).prototype.pushExtensionDialog,
		// 复用按组件身份删除实现，不用测试镜像替代实际栈逻辑。
		removeExtensionDialog: (InteractiveMode as any).prototype.removeExtensionDialog,
		// 复用真实栈顶挂载/焦点方法，用它恢复行内组件和编辑器。
		showTopExtensionDialog: (InteractiveMode as any).prototype.showTopExtensionDialog,
	});

	// 先显示浮层、再开行内替换、关行内后输入x，应回到原浮层；只断言焦点/输入分派，不验证实际用户键盘或任意对话并发。
	test("overlay custom UI reclaims input after non-overlay custom UI closes", async () => {
		// 构造80列24行headless xterm模拟器，不占用宿主TTY。
		const terminal = new VirtualTerminal(80, 24);
		// new主屏注入该模拟器；TUI类型只限制接口视图，不改变真实TuiMainScreen对象。
		const ui: TUI = new TuiMainScreen(terminal);
		// 新建编辑区容器，下面把可编辑假组件加入它。
		const editorContainer = new Container();
		// 原编辑器标签EDITOR，独立inputs/text字段，不是基础Editor实例。
		const editor = new TestFocusableComponent("EDITOR");
		// 普通调色板标签PALETTE，用于让开始焦点故意不在编辑器上。
		const palette = new TestFocusableComponent("PALETTE");
		// 浮层标签OVERLAY，用于后面核收到x的是它。
		const overlay = new TestFocusableComponent("OVERLAY");
		// 行内替换标签REPLACEMENT，关闭后不应继续截获输入。
		const replacement = new TestFocusableComponent("REPLACEMENT");
		// let保存稍后由工厂交出的浮层done；函数类型接string无返回，初始用失败函数避免未赋值调用静默成功。
		let closeOverlay: (value: string) => void = () => {
			// 若测试时序错误导致done尚未取得，明确throw使本例失败，不是业务取消结果。
			throw new Error("closeOverlay was not initialized");
		};
		// 行内done单独存槽，和浮层关闭句柄不是同一函数。
		let closeReplacement: (value: string) => void = () => {
			// 同样把未初始化调用作为测试错误，不实际关闭任何UI。
			throw new Error("closeReplacement was not initialized");
		};
		// 最小假宿主包含当前编辑器、容器、TUI及对话栈，未构造会话运行时。
		const fakeThis = {
			// 属性简写放同一个原编辑器引用，真实custom方法会保存/恢复它的getText内容。
			editor,
			// 同一编辑区容器供真实showExtensionCustom替换children。
			editorContainer,
			// 工厂收到的键位用空对象占位，本例自定义组件不读取键位方法。
			keybindings: {},
			// 真实TUI对象负责浮层/焦点，不是vi.fn渲染器。
			ui,
			// 普通选择器清理用记录器，本例没有活动普通选择器资源可dispose。
			disposeActiveSelector: vi.fn(),
			// 浅展开刚建的新对话栈与方法；展开不会自动执行里面的方法。
			...extensionDialogState(),
		};
		// 本地泛型适配函数接组件工厂与可选overlay，返回Promise<T>；例如T=string使done/完成值按字符串检查。
		// 它只转真实原型方法，仍依赖类型断言，不是运行时校验工厂或完成值。
		const showExtensionCustom = <T>(
			// 工厂接宿主TUI、未知主题/键位及done，返回组件；unknown阻止在此类型视图随意访问主题/键位成员。
			factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
			// ?允许省略选项；overlay:true走浮层，否则走行内栈，不声明本测试没用到的全部真实选项。
			options?: { overlay?: boolean },
			// 箭头返回Promise<T>，下面一条表达式就是函数体，没有另建Promise或调用用户输入。
		): Promise<T> =>
			// .call绑定假宿主，as Promise<T>只给TS视图；不把返回值转成另一个Promise或验证T。
			(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, factory, options) as Promise<T>;

		// 把EDITOR加进编辑区域，提供行内替换之前的实际组件树。
		editorContainer.addChild(editor);
		// 编辑区域接入TUI基础children，参与真实布局和输入焦点恢复。
		ui.addChild(editorContainer);
		// PALETTE作为编辑区域外的另一个基础组件加入主屏。
		ui.addChild(palette);
		// 开始聚焦调色板，制造需要恢复焦点而非默认始终在editor的状态。
		ui.setFocus(palette);
		// 启动注入的虚拟终端、注册本TUI的exit兜底并排首帧；位于try之前，若start自身抛错，下方finally不会接手清理。
		ui.start();
		// 从对话测试流程开始try/finally，保证这部分正常/失败退出时尝试ui.stop，不是全用例资源事务。
		try {
			// 发起浮层custom并保留尚未完成的字符串Promise，后面通过done结算。
			const overlayPromise = showExtensionCustom<string>(
				// 同步工厂不使用前三参数，只保存done并返回预建组件；真实custom把返回结果接到Promise链。
				(_tui, _theme, _keybindings, done) => {
					// 把本轮浮层专属关闭函数存入外部槽，当前不调用。
					closeOverlay = done;
					// 返回OVERLAY对象本身，未复制组件/日志。
					return overlay;
				},
				// 明确选择浮层路径，和后面的缺省行内调用区分。
				{ overlay: true },
			);
			// 让工厂Promise链、TUI排帧和xterm既有写入有执行机会，再观察焦点。
			await flushTui(ui, terminal);
			// 只检查浮层focused字段为true，不要求其他所有组件都处于false或整屏完全稳定。
			expect(overlay.focused).toBe(true);

			// 再开缺省行内custom，Promise独立于先前浮层；它会通过扩展对话栈挂编辑区域。
			const replacementPromise = showExtensionCustom<string>((_tui, _theme, _keybindings, done) => {
				// 保存行内组件自己的done，不覆盖closeOverlay。
				closeReplacement = done;
				// 返回REPLACEMENT作为行内显示/焦点对象，不执行任何外部编辑器。
				return replacement;
			});
			// 等本次行内挂载及虚拟绘制机会，避免立即读工厂尚未挂载的状态。
			await flushTui(ui, terminal);
			// 行内替换应已成为可接收输入的焦点目标，本例不以此证明先前浮层被删除。
			expect(replacement.focused).toBe(true);

			// 主动调用行内done("done")，真实custom关闭该行内对话并尝试恢复编辑区/浮层输入。
			closeReplacement("done");
			// 等行内custom的返回Promise结算；该处没有断言完成字符串一定等done。
			await replacementPromise;
			// 再给真实TUI恢复/排帧机会，之后才模拟按键。
			await flushTui(ui, terminal);
			// 把x同步送入VirtualTerminal保存的TUI输入回调，不经过OS键盘或xterm.stdin。
			terminal.sendInput("x");
			// 等待该输入触发的常见绘制调度及内存输出屏障。
			await flushTui(ui, terminal);

			// 浮层输入日志应恰一项x，直接验证关行内后输入回到浮层。
			expect(overlay.inputs).toEqual(["x"]);
			// 原编辑器不应误收x，本例没有额外检查PALETTE或REPLACEMENT日志。
			expect(editor.inputs).toEqual([]);
			// 浮层仍focused为true，与输入分派断言一起约束恢复结果。
			expect(overlay.focused).toBe(true);

			// 显式关闭浮层并给完成值closed，让这个尚在等待的custom也能结算。
			closeOverlay("closed");
			// 等待浮层Promise完成，未在本例断言它的具体值或最终无浮层状态。
			await overlayPromise;
			// 进入finally时前面的断言/await即使抛错，也会尝试执行下一行stop；并不自动调用尚未执行的done。
		} finally {
			// 停止虚拟TUI并移除本实例exit监听/普通绘制定时器，VirtualTerminal清输入回调；不dispose所有组件或xterm对象。
			ui.stop();
		}
	});

	// Regression test for #10648: closing a lower overlay removed the topmost overlay instead.
	// 为#10648注册两例：较低浮层分别捕获/不捕获输入，关闭它时应移除自己的句柄，不误关最上层。
	// 参数化两行各新建完整虚拟TUI；这是两个用例，不是一个用例里循环两次。
	test.each([
		// lowerKind仅用于测试名，nonCapturing:false让下层在显示时可正常拿焦点。
		{ lowerKind: "capturing", nonCapturing: false },
		// 第二行开启nonCapturing，下层不主动夺焦点；上层仍为普通捕获浮层。
		{ lowerKind: "non-capturing", nonCapturing: true },
	])(
		// $lowerKind由Vitest用本行对象字段替换在名称中，不是执行shell或业务模板。
		"closing a lower $lowerKind overlay custom UI removes its own overlay, not the topmost one",
		// async回调只解构nonCapturing，Vitest等待其Promise；lowerKind没有作为普通局部变量使用。
		async ({ nonCapturing }) => {
			// 每行创建自己的80x24内存终端，输入/输出不串到上一行实例。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏接本行模拟器，构造不自动start。
			const ui: TUI = new TuiMainScreen(terminal);
			// 独立编辑区域容器供行内栈辅助使用。
			const editorContainer = new Container();
			// 本行原编辑器是最终浮层全关后的焦点恢复目标。
			const editor = new TestFocusableComponent("EDITOR");
			// 下层浮层用LOWER标签，后面viewport应不再含它。
			const lower = new TestFocusableComponent("LOWER");
			// 上层用UPPER标签，关下层后仍应显示和接收x。
			const upper = new TestFocusableComponent("UPPER");
			// 下层done先放明确失败占位，稍后由其工厂替换。
			let closeLower: (value: string) => void = () => {
				// 若提前调用未保存的关闭函数就让本例失败，不假装下层已成功关闭。
				throw new Error("closeLower was not initialized");
			};
			// 上层done有独立槽，关闭顺序会先下再上。
			let closeUpper: (value: string) => void = () => {
				// 同样把上层done未初始化视为测试时序错误。
				throw new Error("closeUpper was not initialized");
			};
			// 本行假宿主仅装组件、TUI和栈方法，不带真实AgentSession。
			const fakeThis = {
				// 放原编辑器引用，完成时焦点应回到同一对象。
				editor,
				// 放当前编辑区域容器引用。
				editorContainer,
				// 键位空对象只供接口位置，假组件不调用其中成员。
				keybindings: {},
				// 放真实主屏对象以测试实际浮层栈逻辑。
				ui,
				// 普通选择器清理假函数不操作真实用户界面。
				disposeActiveSelector: vi.fn(),
				// 工厂返回独立对话数组/状态，避免两参数行共享栈。
				...extensionDialogState(),
			};
			// 本地泛型转接函数与前例同用途，这里选项额外允许overlayOptions.nonCapturing。
			// 例如传{overlay:true,overlayOptions:{nonCapturing:true}}只改变浮层焦点政策，不把组件变成真实非交互终端。
			const showExtensionCustom = <T>(
				// 工厂签名要求返回Component并可通过done交T值；主题/键位只保留unknown类型视图。
				factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
				// 外层overlay与内部nonCapturing分别可省略，类型声明不提供运行时默认值或校验。
				options?: { overlay?: boolean; overlayOptions?: { nonCapturing?: boolean } },
				// 返回Promise<T>标注与传入done的T关联，箭头表达式在下一行。
			): Promise<T> =>
				// 用真实原型方法绑定假宿主，as不执行转换或重新创建组件。
				(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, factory, options) as Promise<T>;

			// 把原编辑器加进编辑区域。
			editorContainer.addChild(editor);
			// 编辑区域作为基础根接入主屏。
			ui.addChild(editorContainer);
			// 先给编辑器焦点，为最终恢复断言提供初始状态。
			ui.setFocus(editor);
			// 启动虚拟TUI，真实start位于try外，只有之后的流程受本finally保护。
			ui.start();
			// 本参数行的对话步骤包在try中，断言失败也尝试停虚拟终端。
			try {
				// 先开较低浮层，保存它的返回Promise，稍后验证关闭值。
				const lowerPromise = showExtensionCustom<string>(
					// 工厂只交出done并返回LOWER，不执行额外异步操作。
					(_tui, _theme, _keybindings, done) => {
						// 保存该下层浮层专属done，后面应通过它移除自己的overlay句柄。
						closeLower = done;
						// 返回LOWER同一组件实例。
						return lower;
					},
					// overlay:true走浮层，内部属性简写把本参数行nonCapturing布尔交底层，不传lowerKind显示标签。
					{ overlay: true, overlayOptions: { nonCapturing } },
				);
				// 等下层浮层挂载/初始绘制，再创建上层，稳定两者顺序。
				await flushTui(ui, terminal);
				// 再开上层普通浮层，保留它独立Promise。
				const upperPromise = showExtensionCustom<string>(
					// 上层工厂保存自己的done，闭包不引用下层关闭槽。
					(_tui, _theme, _keybindings, done) => {
						// 用上层done替换占位函数。
						closeUpper = done;
						// 返回UPPER实例，让真实showOverlay登记它。
						return upper;
					},
					// 上层只开overlay:true，未传nonCapturing，因此沿用捕获默认政策。
					{ overlay: true },
				);
				// 等待上层显示和焦点调度完成的常见屏障。
				await flushTui(ui, terminal);
				// 上层当前应focused，确保后面关闭较低项时已有一个活跃上层可被误删。
				expect(upper.focused).toBe(true);

				// 先关闭LOWER而非栈顶，触发本回归关心的按句柄移除路径。
				closeLower("lower closed");
				// resolves会等待并断言下层Promise完成值严格为lower closed，不是只等待函数不抛错。
				await expect(lowerPromise).resolves.toBe("lower closed");
				// 让移除后的画面及焦点状态反映到xterm，再读可见屏。
				await flushTui(ui, terminal);

				// 从模拟器读取当前视口行并以LF拼成文字，不读宿主屏幕/全部滚动历史。
				const viewport = terminal.getViewport().join("\n");
				// 要求视口包含UPPER，未完整比较全部屏幕字符串或组件个数。
				expect(viewport).toContain("UPPER");
				// 要求LOWER不再可见，隐藏/移除的更细内部区别还需后面的浮层状态与输入观测。
				expect(viewport).not.toContain("LOWER");
				// 模拟x，输入应交仍在的上层捕获浮层。
				terminal.sendInput("x");
				// 给输入后更新/模拟器输出排空机会。
				await flushTui(ui, terminal);
				// 上层恰收到一个x，证明它仍能接收输入，而不只是屏幕残留文字。
				expect(upper.inputs).toEqual(["x"]);
				// 下层日志仍空，不应在关闭后继续吃掉x。
				expect(lower.inputs).toEqual([]);

				// 随后关闭上层，允许它自己的custom等待结束。
				closeUpper("upper closed");
				// 断言上层返回值为upper closed，避免关错Promise却仅凭画面通过。
				await expect(upperPromise).resolves.toBe("upper closed");
				// 等待最后浮层撤去后的焦点/屏幕恢复。
				await flushTui(ui, terminal);
				// hasOverlay询问当前可见浮层，false不等于任意场景下连隐藏条目都不存在；本例也没有创建隐藏浮层。
				expect(ui.hasOverlay()).toBe(false);
				// 原编辑器应恢复focused，不检查其文本/光标/撤销栈。
				expect(editor.focused).toBe(true);
				// 正常完成或中途异常都尝试停这行的TUI，不自动保证未调用done的业务Promise也结算。
			} finally {
				// 对注入虚拟适配器stop，清本实例输入/resize回调与普通渲染调度，不访问真实TTY。
				ui.stop();
			}
		},
	);
});

// 注册扩展补全工厂登记一例，测试实际UI适配的push与立即重建通知，不执行补全查询。
describe("InteractiveMode.createExtensionUIContext addAutocompleteProvider", () => {
	// 提供透传工厂并调用addAutocompleteProvider，要求保存同一函数并通知setup一次；未检验实际wrapper执行后的候选。
	test("stores wrapper factories and rebuilds autocomplete immediately", () => {
		// 类型为包装工厂，箭头原样返回current；本用例只保存此函数，setup被mock故不会执行它。
		const wrapper: AutocompleteProviderFactory = (current) => current;
		// 假宿主只放本入口立即读取的两项，其他UI能力闭包虽创建但不调用。
		const fakeThis = {
			// 空数组断言为工厂数组，as只影响TS推断，不验证之后push内容。
			autocompleteProviderWrappers: [] as AutocompleteProviderFactory[],
			// setupAutocompleteProvider仅记录调用，不构造真实组合补全器。
			setupAutocompleteProvider: vi.fn(),
		};

		// 创建真实ExtensionUIContext对象，原型.call提供假this；对象创建不是把所有方法都执行一遍。
		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		// 通过公开UI入口登记工厂，真实方法会先push再调用这个假setup。
		uiContext.addAutocompleteProvider(wrapper);

		// 数组深等[wrapper]，函数项实际按相同引用比较，不是比较函数源码。
		expect(fakeThis.autocompleteProviderWrappers).toEqual([wrapper]);
		// 恰一次重建通知，不代表候选已经查询或编辑器已经渲染补全。
		expect(fakeThis.setupAutocompleteProvider).toHaveBeenCalledTimes(1);
	});
});

// 注册补全链装配两例，使用真实基础组合器与手写包装层；构造不扫描路径，首例实际只调用纯布尔触发门禁。
describe("InteractiveMode.setupAutocompleteProvider", () => {
	// 按wrap1→wrap2依次包装，最外层应为wrap2；要求默认/自定义编辑器收到同一最终对象，门禁调用记录顺序2再1。
	test("stacks wrapper factories over a fresh base provider", () => {
		// 默认编辑器setter只记录配置对象，不是完整编辑器实例。
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		// 自定义编辑器独立setter，便于验证也被立即注入相同对象。
		const customEditor = { setAutocompleteProvider: vi.fn() };
		// 本例字符串日志记录哪些wrapper方法实际执行，不读取真实终端事件。
		const calls: string[] = [];

		// 第一层工厂接current返回新接口对象，显式返回AutocompleteProvider让TS检查三方法契约；下面方法仅在以后查询/应用/门禁时执行。
		const wrap1: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			// 候选方法接行列与取消选项，async返回接续底层Promise；本例并未调用它。
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				// 如果被调用先记wrap1候选查询，日志不表示模型或文件请求成功。
				calls.push("getSuggestions:wrap1");
				// 原样转发参数/结果，return会由async接管底层Promise；不另过滤候选。
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			// 同步应用候选的方法接文字、光标、候选和prefix，返回底层的新文字/光标结构；本例未走此方法。
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				// 若应用候选则记录wrap1身份，不直接改编辑器。
				calls.push("applyCompletion:wrap1");
				// 把所有参数原样传底层applyCompletion，当前wrapper不实现另一套替换规则。
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			// 文件触发门禁是同步布尔函数，不是真正getSuggestions文件扫描。
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				// 先记wrap1门禁调用，供外层先后顺序断言。
				calls.push("shouldTrigger:wrap1");
				// 底层存在可选门禁就调用，结果false被??保留；缺省/nullish才回true，不发fd请求。
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});
		// 第二层与第一层独立对象，接的是先前wrap1结果，之后成为最外层。
		const wrap2: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			// 外层候选查询async接口同样转发，本例未调用，不因声明方法而读目录。
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				// 查询时先记wrap2，这行只是可被调用的代码，不会在工厂装配时立即执行。
				calls.push("getSuggestions:wrap2");
				// 候选请求交current即wrap1，Promise/取消选项原样转发。
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			// 外层同步候选应用方法保留底层返回结构。
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				// 应用时记录wrap2，未在本例实际触发。
				calls.push("applyCompletion:wrap2");
				// 继续交wrap1的applyCompletion，不在此执行shell或保存文件。
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			// 外层门禁接三项光标上下文并返回布尔，本例会实际调用它。
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				// 外层先记shouldTrigger:wrap2，再进入里面的wrap1。
				calls.push("shouldTrigger:wrap2");
				// 可选调用内层门禁，nullish回true、false不被覆盖；不因此触发任何文件枚举。
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});

		// 假宿主提供创建基础器、两个编辑器和有序工厂列表，不构造真实InteractiveMode。
		const fakeThis = {
			// 每次装配新建无命令的真实CombinedAutocompleteProvider；/tmp/project仅保存为基路径，undefined令fd走默认null。
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			// 默认编辑器使用上面setter记录器引用。
			defaultEditor,
			// 当前活动editor明确是另一个customEditor，真实setup应额外调用其setter。
			editor: customEditor,
			// 数组顺序决定先wrap1后wrap2；工厂不是并行执行，结果逐层嵌套。
			autocompleteProviderWrappers: [wrap1, wrap2],
		};

		// 调用真实装配方法，立即构造并套两层，再注入编辑器，尚不查询候选。
		(InteractiveMode as any).prototype.setupAutocompleteProvider.call(fakeThis);

		// 默认setter应恰调用一次，不重复安装中间层。
		expect(defaultEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		// 自定义setter也恰一次，说明与默认editor对象不同的分支被执行。
		expect(customEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		// 从mock首次调用首参数取最终provider；?.可能undefined，as只向TS声明接口，不运行验证或自动补对象。
		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		// toBe检查两个setter收到的严格相同对象引用，不只是形状相等。
		expect(provider).toBe(customEditor.setAutocompleteProvider.mock.calls[0]?.[0]);
		// 实际只调用shouldTriggerFileCompletion，foo光标3应true；这不是getSuggestions，不会列/tmp/project。
		expect(provider.shouldTriggerFileCompletion?.(["foo"], 0, 3)).toBe(true);
		// 日志必须严格为外层wrap2后内层wrap1，候选查询/应用方法没有被执行，因此其日志不存在。
		expect(calls).toEqual(["shouldTrigger:wrap2", "shouldTrigger:wrap1"]);
	});

	// 两工厂各暴露$、!触发字符，装配后最终provider应合并为首次出现顺序数组；未输入这些字符或验证编辑器触发时序。
	test("merges triggerCharacters from wrapper factories", () => {
		// 默认setter是独立记录器，和上一例不共享调用历史。
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		// 活动自定义setter同样独立，不实现其他编辑器功能。
		const customEditor = { setAutocompleteProvider: vi.fn() };
		// 声明柯里化工厂：先给触发数组，再得接旧provider的wrapper；调用passThrough(["$"])只准备工厂，不查询文件。
		// 第一层箭头接string[]返回AutocompleteProviderFactory，数组引用稍后放入包装结果，没有复制/冻结。
		// 第二层接current并返回普通对象，({})避免被解析为函数块。
		const passThrough =
			(triggerCharacters: string[]): AutocompleteProviderFactory =>
			(current) => ({
				// 属性简写把捕获的数组作为当前层triggerCharacters，真实setup收集每层的字段。
				triggerCharacters,
				// 候选回调只转参数，本例仅装配不调用它。
				getSuggestions: (lines, cursorLine, cursorCol, options) =>
					// 返回当前内层getSuggestions的Promise/结果，不添加过滤或新请求。
					current.getSuggestions(lines, cursorLine, cursorCol, options),
				// 同步应用回调也只转发，不在本例执行。
				applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
					// 保留底层applyCompletion返回的文字/光标，不主动应用到setter假对象。
					current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
			});

		// 最小装配宿主，和上例一样用真实基础组合器、假编辑器。
		const fakeThis = {
			// 构造新的无命令基础器并保存假基目录，fd缺省null，不在构造阶段检查路径。
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			// 默认编辑器setter引用供提取最终provider。
			defaultEditor,
			// 当前editor与默认对象不同，所以真实setup需给它同一结果。
			editor: customEditor,
			// 分别创建捕获$、!的两个工厂，数组保持注册顺序，不是两个实际键盘事件。
			autocompleteProviderWrappers: [passThrough(["$"]), passThrough(["!"])],
		};

		// 取真实原型方法并绑定假宿主，完成工厂合并与setter注入。
		// 先as unknown移除原类类型视图，再断言只有下方需要的prototype形状；两个as均无运行时校验。
		// 圆括号包住跨行类型断言表达式，后面继续访问prototype并.call，不是创建新类。
		(
			InteractiveMode as unknown as {
				// 方法类型的this:typeof fakeThis只约束接收者，void是完成值契约；this形参不会占普通实参位置。
				prototype: { setupAutocompleteProvider: (this: typeof fakeThis) => void };
			}
		).prototype.setupAutocompleteProvider.call(fakeThis);

		// 从默认setter首次实参拿最终provider，as不保护缺失调用；若实际没装配，下一行访问会失败。
		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		// 深等[$,!]检查合并后的内容与顺序，未覆盖重复字符去重、基础层已有字符或异常工厂。
		expect(provider.triggerCharacters).toEqual(["$", "!"]);
	});
});

// 注册真实基础补全器两例：模型跨provider/id模糊匹配，以及登录候选按ID合并/按认证标签搜索；不提交/model或/login命令。
describe("InteractiveMode.createBaseAutocompleteProvider", () => {
	// 对/model codexgpt查询两个固定模型，要求排序后的完整provider/id；模型候选来自假快照，不刷新目录或请求供应商。
	test("matches model command arguments across provider/model order", async () => {
		// 局部结构类型只保留搜索要用的id/provider/name，三个字段都是string；不是可发请求的完整Model。
		type TestModel = { id: string; provider: string; name: string };
		// 假宿主类型列出基础补全装配会访问的能力，编译后整个type擦除，不生成运行时对象。
		type FakeInteractiveMode = {
			// session在此只是嵌套字段形状，不要求真实AgentSession的方法全集。
			session: {
				// Array<{model:TestModel}>表示范围包装数组，元素有model字段；空数组运行值将选全量假快照分支。
				scopedModels: Array<{ model: TestModel }>;
				// getAvailableSnapshot声明同步返回TestModel[]，不声明异步目录刷新或认证接口。
				modelRuntime: { getAvailableSnapshot: () => TestModel[] };
				// 空元组类型[]规定本例没有模板，不是任意元素数组的别名。
				promptTemplates: [];
				// 扩展runner只有返回空元组的命令查询，不加载或执行扩展。
				extensionRunner: { getRegisteredCommands: () => [] };
				// 资源加载器只提供空技能字段，嵌套函数类型返回对象而非构造真实加载器。
				resourceLoader: { getSkills: () => { skills: [] } };
			};
			// 设置接口只需布尔技能命令开关，不读取磁盘。
			settingsManager: { getEnableSkillCommands: () => boolean };
			// 真实Map保存技能命令映射，基础装配仍会clear它，即使本例技能被禁。
			skillCommands: Map<string, string>;
			// 管理器仅声明同步cwd字符串访问，不创建会话目录。
			sessionManager: { getCwd: () => string };
			// fdPath类型固定null，禁用fd路径；是否调用同步文件补全另由查询分支决定。
			fdPath: null;
		};

		// 保存未绑定原型方法，下面.call时才提供fakeThis。
		// 先as unknown再收窄为下方最小原型契约，绕过原private类型视图而不改变运行对象。
		// 跨行括号把类型断言和后续prototype访问连成表达式，取函数值但不调用构造器。
		const createBaseAutocompleteProvider = (
			InteractiveMode as unknown as {
				// this:FakeInteractiveMode是类型层接收者，普通参数为空；返回真实AutocompleteProvider接口。
				prototype: { createBaseAutocompleteProvider(this: FakeInteractiveMode): AutocompleteProvider };
			}
		).prototype.createBaseAutocompleteProvider;
		// 本地模型候选数组仅用于检索；const固定数组绑定，不冻结元素。
		const models = [
			// 第一条含provider github-copilot及模型id中的codex，名字也提供搜索文本。
			{ id: "gpt-5.2-codex", provider: "github-copilot", name: "GPT-5.2 Codex" },
			// 第二条把codex放在provider openai-codex中，和第一条形成词序位置不同的匹配样本。
			{ id: "gpt-5.5", provider: "openai-codex", name: "GPT-5.5" },
		];
		// 按局部接口构造假宿主，TS检查必要字段，但没有执行模型schema校验。
		const fakeThis: FakeInteractiveMode = {
			// session普通对象承载这些样本数据与查询替身。
			session: {
				// 空范围让真实补全取getAvailableSnapshot，不表示本例不允许任何模型。
				scopedModels: [],
				// 箭头每次返回同一个models数组引用，没有网络刷新或复制模型。
				modelRuntime: { getAvailableSnapshot: () => models },
				// 无提示模板，避免装配时走需来源说明的模板分支。
				promptTemplates: [],
				// 无扩展命令，不会执行任何扩展handler。
				extensionRunner: { getRegisteredCommands: () => [] },
				// 技能查询返回新对象包空数组，且下方设置关闭技能，这个查询也不会在装配中被执行。
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			// 固定关闭技能命令，不读取真实设置。
			settingsManager: { getEnableSkillCommands: () => false },
			// 新Map可被真实方法清空，初始本来没有项目。
			skillCommands: new Map(),
			// cwd固定/tmp，仅作为组合器基目录文字，本次命令参数查询不枚举它。
			sessionManager: { getCwd: () => "/tmp" },
			// fdPath运行值也明确null，没有本地fd进程可启动。
			fdPath: null,
		};

		// 调用真实基础装配，得到保存命令/参数回调的组合补全器，不查询任何路径。
		const provider = createBaseAutocompleteProvider.call(fakeThis);
		// 整行输入样本/model codexgpt，不会由getSuggestions执行模型切换命令。
		const line = "/model codexgpt";
		// 候选查询取第0行和其末尾UTF-16光标；非force的/命令参数分支会直接调用本地模型搜索回调。
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			// 给一个尚未取消的信号满足接口；该参数补全回调本身不接收signal，也没有待取消HTTP。
			signal: new AbortController().signal,
		});

		// 可选访问后取items的value数组，深等检查完整列表及顺序；null候选会使相等断言失败。
		expect(suggestions?.items.map((item) => item.value)).toEqual([
			// 预期provider含codex的gpt-5.5排第一，使用完整身份避免裸ID歧义。
			"openai-codex/gpt-5.5",
			// 第二个预期仍须包含github-copilot，不按假模型数组原顺序直接返回。
			"github-copilot/gpt-5.2-codex",
		]);
	});

	// 对/login subscription anthrop与/login radius做本地候选查询；要求同ID认证方式合并，OAuth订阅与普通账号标签不同，不执行登录。
	test("matches login command arguments by provider id and name", async () => {
		// 另一局部假宿主类型增加登录候选查询，和上一例同名type只在各自函数作用域内有效。
		type FakeInteractiveMode = {
			// 本例session依旧只是基础装配需要的字段集。
			session: {
				// 空元组范围排除本例出现具体模型范围项。
				scopedModels: [];
				// 模型可用快照返回空列表，本例查询的是/login，不依赖模型目录。
				modelRuntime: { getAvailableSnapshot: () => [] };
				// 模板为空，不提供额外命令。
				promptTemplates: [];
				// 扩展命令查询为空，不加载扩展。
				extensionRunner: { getRegisteredCommands: () => [] };
				// 资源技能字段也为空，符合装配路径需要的最小接口。
				resourceLoader: { getSkills: () => { skills: [] } };
			};
			// 技能开关接口返回布尔；下面固定false。
			settingsManager: { getEnableSkillCommands: () => boolean };
			// Map字段供装配清理技能映射，不是登录状态存储。
			skillCommands: Map<string, string>;
			// cwd只用于构造组合器，不在/login参数分支扫描。
			sessionManager: { getCwd: () => string };
			// fdPath仍固定null，不能凭字段名称假设会安装fd。
			fdPath: null;
			// 额外方法返回AuthSelectorProvider[]，真实补全会按id合并多认证行，不使用真实ModelRuntime。
			getLoginProviderOptions: () => AuthSelectorProvider[];
		};

		// 从真实类原型取得函数值，尚未调用。
		// unknown中转仅绕TS的完整类/私有成员约束。
		// 保存真实私有基础装配函数，跨行类型视图不执行方法。
		const createBaseAutocompleteProvider = (
			InteractiveMode as unknown as {
				// 最小prototype契约仍要求FakeInteractiveMode接收者及AutocompleteProvider结果。
				prototype: { createBaseAutocompleteProvider(this: FakeInteractiveMode): AutocompleteProvider };
			}
		).prototype.createBaseAutocompleteProvider;
		// 按本例接口新建假this，与模型排序例没有共享Map或状态。
		const fakeThis: FakeInteractiveMode = {
			// session假对象字段只服务补全装配，不提供认证登录能力。
			session: {
				// 空范围，不引入模型候选限制。
				scopedModels: [],
				// 可用快照恒空，说明登录候选不来自模型列表。
				modelRuntime: { getAvailableSnapshot: () => [] },
				// 无模板列表。
				promptTemplates: [],
				// 无扩展注册命令，避免命名冲突影响/login内置命令。
				extensionRunner: { getRegisteredCommands: () => [] },
				// 假技能加载器只返回空数组，不访问SKILL.md。
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			// 禁用技能命令装配，查询不读取真实设置。
			settingsManager: { getEnableSkillCommands: () => false },
			// 新建本例技能Map，真实装配clear无外部影响。
			skillCommands: new Map(),
			// 固定/tmp基路径，未进入文件候选代码。
			sessionManager: { getCwd: () => "/tmp" },
			// 明确禁用fd模糊文件路径。
			fdPath: null,
			// 无参箭头每次返回下方四条手写认证候选，不查凭据/套餐/网络。
			getLoginProviderOptions: () => [
				// Anthropic OAuth带subscription:true，补全标签应采用subscription。
				{ id: "anthropic", name: "Anthropic", authType: "oauth", subscription: true },
				// 同ID的API key行应并入同一个Anthropic补全项，不再追加第二个相同ID候选。
				{ id: "anthropic", name: "Anthropic", authType: "api_key", subscription: true },
				// OpenAI只给API key方式，作为不匹配anthrop查询的其他候选。
				{ id: "openai", name: "OpenAI", authType: "api_key" },
				// Radius有OAuth但subscription:false，因此标签为account，不把所有OAuth都称为订阅。
				{ id: "radius", name: "Radius", authType: "oauth", subscription: false },
			],
		};

		// 真实装配建立/login参数回调，并保存这些假查询依赖。
		const provider = createBaseAutocompleteProvider.call(fakeThis);
		// 查询同时包含认证标签subscription与名字片段anthrop，多词模糊匹配应保留Anthropic。
		const line = "/login subscription anthrop";
		// 查询命令参数，不执行handleLoginCommand或登录菜单；await只等候选计算。
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			// 创建未取消信号满足候选接口，无真实认证任务。
			signal: new AbortController().signal,
		});

		// 对完整items数组深等，要求只有下方一条合并候选及完整描述字段。
		expect(suggestions?.items).toEqual([
			// 预期项为显示/补全文字对象，不包含真实Provider能力或秘密。
			{
				// 补全写回值采用供应商ID anthropic。
				value: "anthropic",
				// 主要显示标签也用ID，不用显示名Anthropic。
				label: "anthropic",
				// 描述把显示名和合并后的subscription/API key标签按固定格式连接。
				description: "Anthropic · subscription/API key",
			},
		]);

		// OAuth sign-in without a subscription, such as Radius, is an account.
		// 第二条查询针对Radius，使用同一个已构造provider，但每次回调会重新生成候选数组。
		const radiusLine = "/login radius";
		// 等本地Radius候选结果，不创建OAuth交互。
		const radiusSuggestions = await provider.getSuggestions([radiusLine], 0, radiusLine.length, {
			// 本次也传独立未取消信号，不取消上次查询结果。
			signal: new AbortController().signal,
		});
		// 要求完整单项描述为Radius·account，证明这个固定非订阅OAuth样本不用subscription标签。
		expect(radiusSuggestions?.items).toEqual([{ value: "radius", label: "radius", description: "Radius · account" }]);
	});
});
// 注册23个资源展示样本，使用假resourceLoader和路径文字；主要观察紧凑/展开、路径标签、quiet/verbose门禁，不扫描或执行所列资源。
describe("InteractiveMode.showLoadedResources", () => {
	// 整组用例之前初始化共享主题，不为每个资源创建ThemeController。
	beforeAll(() => {
		// dark内置主题供真实ExpandableText/ThemedText渲染，默认不watch。
		initTheme("dark");
	});

	// 创建资源展示的最小假this，接各类资源/显示开关，返回可变假对象；默认把详细分组/诊断替成固定输出，可选接回真实分组方法。
	// 例如useRealScopeGroups:true会按真实来源排序显示，但所有资源仍来自传入数组；工厂只建内存对象，不读资源正文/文件元数据。
	function createShowLoadedResourcesThis(options: {
		// quietStartup必填，保留false/true/"header"差异，不在此重新验证设置。
		quietStartup: QuietStartup;
		// verbose可省，后面缺省false；它会覆盖安静启动的详情隐藏。
		verbose?: boolean;
		// 可选全局展开标志，影响紧凑标签还是详细路径初始显示。
		toolOutputExpanded?: boolean;
		// 可选cwd字符串只供词法路径相对化，工厂不chdir。
		cwd?: string;
		// 上下文数组可仅有path，content也可省；显示不要求或读取AGENTS正文。
		contextFiles?: Array<{ path: string; content?: string }>;
		// 可选系统提示来源只含path，不是实际systemPrompt内容。
		systemPromptSource?: { path: string };
		// 可追加多条系统提示来源路径，展示时应排在项目上下文前面。
		appendSystemPromptSources?: Array<{ path: string }>;
		// 扩展只需要ExtensionFixture路径/来源，不是被执行的Extension模块。
		extensions?: ExtensionFixture[];
		// 技能只给文件位置和名字，类型没有完整Skill的全部字段；any假this使被测展示可接此样本。
		skills?: Array<{ filePath: string; name: string }>;
		// 诊断数组只枚举三种显示等级与message，当前假formatDiagnostics并不使用这些消息正文。
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
		// 选择是否把分组/详细格式化替身改为真实原型方法，不切真实资源加载器。
		useRealScopeGroups?: boolean;
		// 整个options对象必填；函数没有显式结果类型，下面any变量使返回视图保持宽松，不产生运行时检查。
	}) {
		// any假宿主允许只实现展示会访问的字段，省略真实InteractiveMode构造/运行状态。
		const fakeThis: any = {
			// 只保存verbose显示覆盖，??保留显式false，仅缺省回false。
			options: { verbose: options.verbose ?? false },
			// 展开标志缺省false，后续测试传true覆盖；不修改真实用户设置。
			toolOutputExpanded: options.toolOutputExpanded ?? false,
			// 资源专属真实容器，用例主要渲染/检查它，避免与chat混为一处。
			loadedResourcesContainer: new Container(),
			// 另外提供空聊天容器，真实showLoadedResources不应把普通资源区写进它；本文件并未逐例断言chat不变。
			chatContainer: new Container(),
			// 假设置只暴露安静启动读取方法，不构造SettingsManager。
			settingsManager: {
				// 箭头返回传入选项的当前值；options对象若后续修改，这个读取仍能看到，不冻结配置。
				getQuietStartup: () => options.quietStartup,
			},
			// 假SessionManager只提供cwd访问，不读取或创建会话文件。
			sessionManager: {
				// 缺cwd时用/tmp/project；显式空字符串被??保留，当前样本都给正常路径或省略。
				getCwd: () => options.cwd ?? "/tmp/project",
			},
			// 假session挂资源查询和扩展诊断读取，不启动Agent。
			session: {
				// 模板列表为空，本组没有真实提示模板可执行。
				promptTemplates: [],
				// runner仅提供已收集诊断读取，不加载扩展或触发快捷键。
				extensionRunner: {
					// 命令诊断恒空，本组不检验命令冲突格式化。
					getCommandDiagnostics: () => [],
					// 快捷键诊断恒空，不与命令警告合并真实错误。
					getShortcutDiagnostics: () => [],
				},
				// 资源加载器全是返回手写值的函数，没有实际reload/目录扫描实现。
				resourceLoader: {
					// 每次返回空Map路径元信息；来源由各夹具显式传入，不查磁盘包管理记录。
					getPathMetadata: () => new Map(),
					// 上下文读取返回传入数组或新空数组，只访问options，不打开文件。
					getAgentsFiles: () => ({ agentsFiles: options.contextFiles ?? [] }),
					// 系统提示来源原样返回，可缺省undefined。
					getSystemPromptSource: () => options.systemPromptSource,
					// 追加来源缺省空数组，保留传入顺序。
					getAppendSystemPromptSources: () => options.appendSystemPromptSources ?? [],
					// 技能查询建立含skills/diagnostics的结果对象，便于真实展示分别处理两部分。
					getSkills: () => ({
						// 技能数组取传入引用，缺省为空，不加载SKILL.md。
						skills: options.skills ?? [],
						// 技能诊断取传入数组，缺省空；并非在这里重新运行技能校验。
						diagnostics: options.skillDiagnostics ?? [],
					}),
					// 提示模板资源与诊断都固定空，新对象不代表已扫描真实目录。
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					// 扩展返回夹具列表、空errors和空runtime；runtime只是最低占位，被测展示不执行其中能力。
					getExtensions: () => ({ extensions: options.extensions ?? [], errors: [], runtime: {} }),
					// 主题资源和诊断为空，和共享dark主题用于文字渲染是两套不同数据。
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			// 路径缩家目录时委托真实原型方法；闭包执行时fakeThis已赋值，建立对象时不会马上调用它。
			formatDisplayPath: (p: string) => (InteractiveMode as any).prototype.formatDisplayPath.call(fakeThis, p),
			// 扩展路径格式化箭头保留p参数，实际只是文字显示转换。
			formatExtensionDisplayPath: (p: string) =>
				// 绑定同一假this，使真实方法还能调用其formatDisplayPath；不执行扩展入口文件。
				(InteractiveMode as any).prototype.formatExtensionDisplayPath.call(fakeThis, p),
			// 上下文路径走真实cwd相对化方法，不通过fs.realpath核磁盘位置。
			formatContextPath: (p: string) => (InteractiveMode as any).prototype.formatContextPath.call(fakeThis, p),
			// 初始展开判定接回真实方法，读取假options.verbose与toolOutputExpanded。
			getStartupExpansionState: () => (InteractiveMode as any).prototype.getStartupExpansionState.call(fakeThis),
			// 启动详情门禁也接真实方法，读取假quietStartup，不把所有真值都当同一种策略。
			shouldShowStartupDetails: () => (InteractiveMode as any).prototype.shouldShowStartupDetails.call(fakeThis),
			// 缺省分组替身直接返回空数组；普通技能例只想观察紧凑/展开切换，不测真实来源分组。
			buildScopeGroups: () => [],
			// 缺省详细格式化固定返回resource-list，占位串使展开分支在断言里可被识别，不能当真实资源列表内容。
			formatScopeGroups: () => "resource-list",
			// 包来源判别保留可缺SourceInfo参数，不擅自从路径存在性猜来源。
			isPackageSource: (sourceInfo?: SourceInfo) =>
				// 接回真实来源字符串判别，保留npm/git等规则。
				(InteractiveMode as any).prototype.isPackageSource.call(fakeThis, sourceInfo),
			// 短路径箭头接原路径与可选来源元数据。
			getShortPath: (p: string, sourceInfo?: SourceInfo) =>
				// 真实getShortPath按来源/基目录处理文字，未在此安装包或打开路径。
				(InteractiveMode as any).prototype.getShortPath.call(fakeThis, p, sourceInfo),
			// 紧凑路径标签保留相同参数，供非扩展资源名格式化。
			getCompactPathLabel: (p: string, sourceInfo?: SourceInfo) =>
				// 委托真实标签助手，是否取文件名/短路径由它决定。
				(InteractiveMode as any).prototype.getCompactPathLabel.call(fakeThis, p, sourceInfo),
			// 包来源短名辅助只接可选SourceInfo。
			getCompactPackageSourceLabel: (sourceInfo?: SourceInfo) =>
				// 调用真实npm/git显示标签逻辑，不查询包注册表或Git远端。
				(InteractiveMode as any).prototype.getCompactPackageSourceLabel.call(fakeThis, sourceInfo),
			// 单扩展紧凑标签保留原路径及来源。
			getCompactExtensionLabel: (p: string, sourceInfo?: SourceInfo) =>
				// 真实标签助手可能给包内相对后缀，不因origin=package就执行包。
				(InteractiveMode as any).prototype.getCompactExtensionLabel.call(fakeThis, p, sourceInfo),
			// 显示路径拆段方法只接字符串。
			getCompactDisplayPathSegments: (p: string) =>
				// 真实方法缩家目录、统一分隔符并拆段，用于冲突消歧，不递归读目录。
				(InteractiveMode as any).prototype.getCompactDisplayPathSegments.call(fakeThis, p),
			// 本地转接同名非包扩展消歧助手，三参数与真实实现对应。
			getCompactNonPackageExtensionLabel: (
				// 当前入口路径文字。
				p: string,
				// 当前条目在候选数组中的索引，不是文件系统inode编号。
				index: number,
				// allPaths数组保存每条路径与已拆segments；类型只是TS形状，不验证数组项互异。
				allPaths: Array<{ path: string; segments: string[] }>,
				// 以假this转真实消歧，保留原索引/整组数据，比较的是文字后缀而非真实文件身份。
			) => (InteractiveMode as any).prototype.getCompactNonPackageExtensionLabel.call(fakeThis, p, index, allPaths),
			// 整个扩展列表标签转接，让不同索引文件可一起找最短区分后缀。
			getCompactExtensionLabels: (extensions: ExtensionFixture[]) =>
				// 真实方法返回与输入路径对应的标签结果，不重新加载扩展。
				(InteractiveMode as any).prototype.getCompactExtensionLabels.call(fakeThis, extensions),
			// 诊断格式化固定diagnostics，后面只检查有无警告区，不证明具体warning.message展示准确。
			formatDiagnostics: () => "diagnostics",
			// 内置命令冲突诊断恒空，避免真实runner缺失getRegisteredCommands接口。
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		// 仅选项真值时替换三处假方法；没选时保留空分组/resource-list占位。
		if (options.useRealScopeGroups) {
			// 把scope判别接到真实方法，参数来源仍来自手写夹具。
			fakeThis.getScopeGroup = (sourceInfo?: SourceInfo) =>
				// 真实scope归类只做元数据规则，不核用户/项目文件权限或可信状态。
				(InteractiveMode as any).prototype.getScopeGroup.call(fakeThis, sourceInfo);
			// 分组方法接受路径/可选来源数组，类型注解不构造新资源。
			fakeThis.buildScopeGroups = (items: Array<{ path: string; sourceInfo?: SourceInfo }>) =>
				// 用真实buildScopeGroups形成project/user/path及包分组，改的是这份假对象方法引用。
				(InteractiveMode as any).prototype.buildScopeGroups.call(fakeThis, items);
			// 详细格式化参数用unknown视图占位，any原型调用绕过更精确类型，不给unknown直接读字段。
			fakeThis.formatScopeGroups = (groups: unknown, formatOptions: unknown) =>
				// 真实formatScopeGroups读取分组和格式选项生成文字，当前来源仍全内存。
				(InteractiveMode as any).prototype.formatScopeGroups.call(fakeThis, groups, formatOptions);
		}

		// 返回同一个可变fakeThis对象，字段未冻结；之后原型展示会修改其资源容器。
		return fakeThis;
	}

	// 为夹具建立SourceInfo对象，输入路径和来源选项、返回新对象；例npm包来源只记录元数据，不检查文件/包存在或运行资源。
	// 这个测试辅助与产品同名函数无直接调用关系，刻意省略changelogPath等本例不用字段。
	function createSourceInfo(
		// filePath原文保存为来源记录的path，不做normalize或realpath。
		filePath: string,
		// 必填options对象携带来源维度，下面是参数类型而不是运行时schema。
		options: {
			// source为来源表达式，例如npm:primary-package或local；string不自动解析其语义。
			source: string;
			// scope字面联合仅允许user/project/temporary，不代表trusted布尔值。
			scope: "user" | "project" | "temporary";
			// origin区分包内/顶层入口，与scope是两个独立维度。
			origin: "package" | "top-level";
			// baseDir可缺，供包内相对显示；不在此创建这个目录。
			baseDir?: string;
		},
		// 返回类型SourceInfo让TS检查属性，实际不运行验证器。
	): SourceInfo {
		// 建立新的普通来源对象，字符串按值保存，没有复制资源内容。
		return {
			// 把参数filePath映射到属性path，不硬编码另一路径。
			path: filePath,
			// 来源表达式原样传递，未执行npm/git。
			source: options.source,
			// 保留选项scope供后面分组。
			scope: options.scope,
			// 保留origin，使包资源标签和顶层入口标签采用不同规则。
			origin: options.origin,
			// baseDir即使undefined也会作为属性存在，不影响此处无I/O的构造。
			baseDir: options.baseDir,
		};
	}

	// 生成八条混合扩展路径样本，返回新数组/来源对象，无文件创建；覆盖项目/用户/CLI、普通文件/index与npm/git包内路径。
	// 例如同Git仓库的extensions/index与extensions/subagents/index应显示包名及可区分子路径；这些路径只是显示测试，不会被import。
	function createExtensionFixtures(): ExtensionFixture[] {
		// 按下列顺序构造数组，真实格式化后可能按标签/来源重新排序，快照不是简单复印输入顺序。
		return [
			// 第一条是项目顶层单文件扩展。
			{
				// answer.ts保留文件名后缀，不把普通文件当index目录入口。
				path: "/tmp/project/.pi/extensions/answer.ts",
				// 为该同一路径附项目本地来源，参数值为元数据而非磁盘读取。
				sourceInfo: createSourceInfo("/tmp/project/.pi/extensions/answer.ts", {
					// local表示本地配置来源，不是一个要执行的协议。
					source: "local",
					// project让详细列表归项目组。
					scope: "project",
					// top-level区别于npm/git包内资源。
					origin: "top-level",
					// 项目extensions目录作为来源基准，当前仅文字。
					baseDir: "/tmp/project/.pi/extensions",
				}),
			},
			// 第二条是项目目录型index.ts入口。
			{
				// local-index/index.ts应在紧凑/详细路径里去掉末尾index.ts。
				path: "/tmp/project/.pi/extensions/local-index/index.ts",
				// 来源路径与条目path一致，仍是虚构本地入口。
				sourceInfo: createSourceInfo("/tmp/project/.pi/extensions/local-index/index.ts", {
					// 保留local来源标签。
					source: "local",
					// 同为project组，不因多一层目录改为用户资源。
					scope: "project",
					// 顶层配置引入的目录入口，而非包资源。
					origin: "top-level",
					// 来源基准仍为项目extensions根，不直接设为local-index目录。
					baseDir: "/tmp/project/.pi/extensions",
				}),
			},
			// 第三条改为用户范围目录入口，与上面的项目资源分开归类。
			{
				// 路径用/tmp/agent模拟用户资源位置，不是实际用户agentDir。
				path: "/tmp/agent/extensions/user-index/index.ts",
				// 附user范围来源，不调用真实用户配置读取。
				sourceInfo: createSourceInfo("/tmp/agent/extensions/user-index/index.ts", {
					// 本地来源，不来自npm/git包。
					source: "local",
					// user影响详细分组标题，不改变进程权限。
					scope: "user",
					// 此入口仍为top-level，即直接配置资源。
					origin: "top-level",
					// 用户extensions基准同样只是夹具字符串。
					baseDir: "/tmp/agent/extensions",
				}),
			},
			// 第四条模拟普通npm包中的extensions/index.ts入口。
			{
				// 完整node_modules路径允许真实显示助手识别包内相对部分，不要求该包安装在磁盘。
				path: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				// 来源记录声明此文件属于下面npm包元数据。
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts", {
					// 来源表达式含npm前缀与包名，显示标签可提取pi-markdown-preview。
					source: "npm:pi-markdown-preview",
					// 包在project范围，不与同名user包合为一个scope。
					scope: "project",
					// origin=package开启包资源展示规则，不代表代码已获执行资格。
					origin: "package",
					// baseDir是包根，不是extensions子目录，便于详细列表显示extensions相对路径。
					baseDir: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview",
				}),
			},
			// 第五条模拟带@scope命名空间的npm包。
			{
				// 路径包含@scope/pi-scoped两级包名，不能只按最后文件夹猜完整包身份。
				path: "/tmp/project/.pi/npm/node_modules/@scope/pi-scoped/extensions/index.ts",
				// 附同一作用域包的来源表达式与根路径。
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/@scope/pi-scoped/extensions/index.ts", {
					// npm:@scope/pi-scoped在紧凑标签中应保留命名空间。
					source: "npm:@scope/pi-scoped",
					// 仍归project范围。
					scope: "project",
					// 仍为包内资源，不当本地top-level路径。
					origin: "package",
					// baseDir含完整scope/包名，后面的相对扩展目录位于其下。
					baseDir: "/tmp/project/.pi/npm/node_modules/@scope/pi-scoped",
				}),
			},
			// 第六条模拟Git仓库的默认extensions目录入口。
			{
				// Git缓存样式路径只作为显示样本，不clone仓库或探测Git命令。
				path: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
				// 跨行调用来源工厂，分别传完整入口路径和后面的选项对象。
				sourceInfo: createSourceInfo(
					// 来源path与条目路径相同，保留HazAT目录的大小写。
					"/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
					// 此对象列Git来源的三个维度和包根。
					{
						// git:表达式供纯字符串解析显示HazAT/pi-interactive-subagents，不联网查询该地址。
						source: "git:github.com/HazAT/pi-interactive-subagents",
						// 项目范围的Git包，详细列表归project。
						scope: "project",
						// origin=package使默认extensions子目录可按包内路径显示。
						origin: "package",
						// 包根截止仓库名，extensions位于该根下面。
						baseDir: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			// 第七条与第六条同Git包，但入口位于更深subagents目录，不能被紧凑标签误合成同一项。
			{
				// 子路径extensions/subagents/index.ts，真实助手会去index并保留区分所需后缀。
				path: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
				// 同样用来源工厂建记录，不从路径推断出另一个独立仓库。
				sourceInfo: createSourceInfo(
					// 来源path完整指向这条子入口。
					"/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
					// 下面选项保留同包身份，只有资源path不同。
					{
						// 与上一条完全相同的git来源表达式，所以详细列表应在同一包组列两个相对路径。
						source: "git:github.com/HazAT/pi-interactive-subagents",
						// 范围保持project，包去重键也包含此范围。
						scope: "project",
						// 仍标package，不因为深子目录而变为top-level。
						origin: "package",
						// 与默认入口共享同一仓库根，为相对subagents后缀提供基准。
						baseDir: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			// 第八条模拟命令行显式传入的临时扩展文件。
			{
				// cli-extension.ts的/tmp/temp路径不需要真实存在。
				path: "/tmp/temp/cli-extension.ts",
				// 来源记录显式标cli，真实显示不会打开该文件。
				sourceInfo: createSourceInfo("/tmp/temp/cli-extension.ts", {
					// cli只是引入来源标签，未调用任何命令行程序。
					source: "cli",
					// temporary会显示在path组，不当用户或项目持久配置。
					scope: "temporary",
					// top-level表示直接入口，不按包名合并。
					origin: "top-level",
					// 临时路径父目录作为baseDir，不在此mkdir。
					baseDir: "/tmp/temp",
				}),
			},
		];
	}

	// 默认非安静且未展开时，技能节应只列技能名commit，不出现详细格式化替身resource-list；不打开SKILL.md或运行该技能。
	test("shows a compact resource listing by default", () => {
		// 工厂建本例独立资源容器及最小宿主，其他资源缺省空。
		const fakeThis = createShowLoadedResourcesThis({
			// quietStartup:false允许正常启动详情，不额外开verbose。
			quietStartup: false,
			// 技能只给假文件路径与显示名，正文缺省也不影响本展示。
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		// 直接.call真实showLoadedResources，把内容追加到假宿主的资源容器，不初始化真实交互模式。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// force:false不强制覆盖安静设置；本例quiet本来为false。
			force: false,
		});

		// 渲染整个资源容器为文字，仍可含主题ANSI，下面使用子串断言。
		const output = renderAll(fakeThis.loadedResourcesContainer);
		// 要求技能节标题存在，不精确限制边框/换行等完整画面。
		expect(output).toContain("[Skills]");
		// 紧凑列表应含技能名commit，不检查是否可执行该技能。
		expect(output).toContain("commit");
		// 固定详细输出占位不应出现，区分初始采用紧凑正文而非展开正文。
		expect(output).not.toContain("resource-list");
	});

	// 全局展开true时应采用详细资源正文，要求resource-list而非紧凑名commit；这里详细内容是替身，不是真实路径扫描结果。
	test("shows full resource listing when expanded", () => {
		// 独立宿主使用同类单技能输入，便于与默认紧凑例对照。
		const fakeThis = createShowLoadedResourcesThis({
			// 非安静启动让资源区域正常显示。
			quietStartup: false,
			// 显式展开覆盖默认false，影响ExpandableText的初始expanded状态。
			toolOutputExpanded: true,
			// 同一技能名样本只作紧凑/展开差别观察。
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		// 调用真实资源显示入口，创建主题化的节组件。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// force仍false，展开来自宿主字段而不是强制资源显示标志。
			force: false,
		});

		// 渲染资源区而非chat，读取当前展开态正文。
		const output = renderAll(fakeThis.loadedResourcesContainer);
		// 展开态仍保留Skills标题。
		expect(output).toContain("[Skills]");
		// 要求工厂详细格式化替身的resource-list出现，证明选择了该详细路径。
		expect(output).toContain("resource-list");
		// 紧凑技能名commit不应混入此固定详细结果；不是说真实展开列表必然不显示技能名。
		expect(output).not.toContain("commit");
	});

	// quiet:true且全局折叠时，verbose:true仍应展示详细资源，验证verbose优先；不检验真实CLI参数解析。
	test("shows full resource listing on verbose startup even when tool output is collapsed", () => {
		// 构造同时带冲突显示设置的最小宿主。
		const fakeThis = createShowLoadedResourcesThis({
			// 全安静通常隐藏详情，故意与verbose形成优先级样本。
			quietStartup: true,
			// 明确true的verbose应允许详情并决定展开显示。
			verbose: true,
			// 工具全局仍折叠，避免把详细结果误归因于toolOutputExpanded。
			toolOutputExpanded: false,
			// 一个commit技能提供可观察紧凑/展开差别。
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		// 调用真实显示入口，读取假设置的组合结果。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// force:false排除强制展示造成的通过。
			force: false,
		});

		// 渲染资源区域文字，不读取任何真正资源正文。
		const output = renderAll(fakeThis.loadedResourcesContainer);
		// 要求技能节仍被展示，说明verbose可穿过quiet详情门禁。
		expect(output).toContain("[Skills]");
		// 要求详细格式化占位出现，说明verbose同时使该节展开。
		expect(output).toContain("resource-list");
		// 紧凑commit不出现；此断言只针对工厂固定详细输出，不是完整真实路径行为。
		expect(output).not.toContain("commit");
	});

	// 两条无来源扩展应在紧凑节只显示answer.ts、btw.ts，不带父目录；不证明所有同名路径都无需消歧。
	test("abbreviates extensions in compact listing", () => {
		// 新建宿主，展开标志缺省false。
		const fakeThis = createShowLoadedResourcesThis({
			// 非安静启动允许扩展节。
			quietStartup: false,
			// 两个ExtensionFixture只含path，没有SourceInfo；目录和文件都不要求真实存在。
			extensions: [{ path: "/tmp/extensions/answer.ts" }, { path: "/tmp/extensions/btw.ts" }],
		});

		// 真实入口把裸路径转换成紧凑扩展标签。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// force:false沿正常显示门禁。
			force: false,
		});

		// 渲染扩展资源区全部直接孩子。
		const output = renderAll(fakeThis.loadedResourcesContainer);
		// 要求Extensions标题，不检查其颜色控制串。
		expect(output).toContain("[Extensions]");
		// 要求这两个文件标签按逗号连接，未完整比较整个资源字符串。
		expect(output).toContain("answer.ts, btw.ts");
		// 父路径extensions/answer.ts不应出现在紧凑文字中，不据此断言原SourceInfo被改写。
		expect(output).not.toContain("extensions/answer.ts");
	});

	// 八种混合扩展布局应输出固定紧凑快照，含npm命名空间、Git子入口、用户和CLI；不导入这些入口或安装包。
	test("captures mixed extension layouts in compact output", () => {
		// 独立资源宿主用于本快照。
		const fakeThis = createShowLoadedResourcesThis({
			// 正常非安静，默认折叠。
			quietStartup: false,
			// 调用上面的八条纯数据工厂，每次得到新列表/来源对象。
			extensions: createExtensionFixtures(),
			// 接回真实scope分组与详细格式化；紧凑标签本来就使用真实路径助手。
			useRealScopeGroups: true,
		});

		// 调用真实资源显示，但所有Loader返回值依旧来自夹具。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// force:false不会覆盖quiet门禁，本例本来允许显示。
			force: false,
		});

		// 先归一化ANSI/分隔符/尾空白再比完整内联快照；反引号跨行模板里的换行、引号与缩进都属于期望文字。
		// 快照要求输出排序与八条标签：同Git包默认项和:subagents分开，命名空间npm仍保留@scope；不验证实际文件存在或加载顺序。
		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  @scope/pi-scoped, answer.ts, cli-extension.ts, HazAT/pi-interactive-subagents, HazAT/pi-interactive-subagents:subagents, local-index, pi-markdown-preview, user-index"`);
	});

	// 三个目录都叫one/index.ts，紧凑标签应加足父段区分alpha/one、beta/one、gamma/one；仅比较路径文字，不做磁盘身份去重。
	test("adds more parent folders until local extension labels are unique", () => {
		// 类型注解检查每项路径/可选来源，下面三条对象是独立入口夹具。
		const extensions: ExtensionFixture[] = [
			// 第一条入口根在alpha。
			{
				// 完整路径尾部one/index.ts与其他两条相同，单靠最近目录名one无法区分。
				path: "/tmp/alpha/one/index.ts",
				// 显式来源使其属于临时CLI顶层入口，不按包名归组。
				sourceInfo: createSourceInfo("/tmp/alpha/one/index.ts", {
					// cli来源不执行命令行程序。
					source: "cli",
					// temporary让它归path组。
					scope: "temporary",
					// top-level确保使用非包入口标签规则。
					origin: "top-level",
					// 声明alpha为基准，路径仍保留足够父段供消歧。
					baseDir: "/tmp/alpha",
				}),
			},
			// 第二条只把祖先alpha换为beta，维持冲突后缀。
			{
				// beta/one/index.ts与第一条one目录同名。
				path: "/tmp/beta/one/index.ts",
				// 来源工厂仍只创建记录，不遍历beta目录。
				sourceInfo: createSourceInfo("/tmp/beta/one/index.ts", {
					// 同为cli来源，避免由不同包名直接区分。
					source: "cli",
					// 同为temporary范围。
					scope: "temporary",
					// 仍为非包顶层入口。
					origin: "top-level",
					// beta基准对应第二个样本，不修改进程cwd。
					baseDir: "/tmp/beta",
				}),
			},
			// 第三条用gamma，检验算法可同时处理多于两条冲突项。
			{
				// gamma/one/index.ts需要同样加父段。
				path: "/tmp/gamma/one/index.ts",
				// 为第三条附相同来源政策。
				sourceInfo: createSourceInfo("/tmp/gamma/one/index.ts", {
					// CLI引入元数据。
					source: "cli",
					// 临时范围。
					scope: "temporary",
					// 顶层非包入口。
					origin: "top-level",
					// 以gamma根作为来源baseDir，仅用于显示解释。
					baseDir: "/tmp/gamma",
				}),
			},
		];

		// 把三条冲突夹具交本例宿主，不额外读实际文件。
		const fakeThis = createShowLoadedResourcesThis({
			// 允许正常资源显示。
			quietStartup: false,
			// 属性简写传同一个extensions数组，宿主没有复制这些对象。
			extensions,
			// 启用真实分组实现，使快照路径尽量沿实际来源流程生成。
			useRealScopeGroups: true,
		});

		// 真实showLoadedResources产生紧凑标签列表。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// 不强制显示或展开，采用默认紧凑政策。
			force: false,
		});

		// 完整归一化快照应为alpha/one、beta/one、gamma/one，不保留index.ts；多行模板描述期望显示字符串，不是待执行代码。
		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/one, beta/one, gamma/one"`);
	});

	// 单个本地plan-mode/index.ts应显示plan-mode目录名；测试的是精确index.ts入口，不是任意.ts后缀都去掉。
	test("strips index.ts from local extension label, showing parent dir", () => {
		// 本例列表只含一个入口，故不需要跨项消歧。
		const extensions: ExtensionFixture[] = [
			// 新建此目录入口的普通对象。
			{
				// 路径最后段严格是index.ts，匹配真实助手去入口文件名规则。
				path: "/tmp/extensions/plan-mode/index.ts",
				// 为此路径附本地项目顶层来源，不当npm/git包。
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					// local引入表达式，不执行模块。
					source: "local",
					// project范围供详细分组，紧凑结果仍只看标签。
					scope: "project",
					// 顶层来源使非包目录标签算法接手。
					origin: "top-level",
					// 来源基准在extensions根，plan-mode位于其下。
					baseDir: "/tmp/extensions",
				}),
			},
		];

		// 构造本例资源宿主，并保留默认折叠。
		const fakeThis = createShowLoadedResourcesThis({
			// 非安静启动。
			quietStartup: false,
			// 传上面的单入口数组引用。
			extensions,
			// 真实scope分组/格式化可用，未运行资源加载器扫描。
			useRealScopeGroups: true,
		});

		// 直接执行真实显示方法，不调用InteractiveMode构造器。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// force:false让默认政策决定显示。
			force: false,
		});

		// 对归一化完整文字比plan-mode快照，期望模板内换行/空格同样参与相等比较。
		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	// 与上例同目录但入口后缀index.js，也应显示plan-mode；这是JS入口回归，未读取或执行该JS文件。
	test("strips index.js from local extension label, showing parent dir", () => {
		// 建立单条JS目录入口夹具数组。
		const extensions: ExtensionFixture[] = [
			// 条目为新对象，和TS例不共享来源记录。
			{
				// 尾名严格index.js，不能靠只支持index.ts的实现偶然通过。
				path: "/tmp/extensions/plan-mode/index.js",
				// 来源记录path也使用.js版本。
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.js", {
					// 同为local来源。
					source: "local",
					// 项目范围。
					scope: "project",
					// 顶层入口，不用包目录规则绕过去尾名检查。
					origin: "top-level",
					// 来源根仍在extensions。
					baseDir: "/tmp/extensions",
				}),
			},
		];

		// 构造独立宿主，和TS入口例分开容器/记录。
		const fakeThis = createShowLoadedResourcesThis({
			// 允许显示资源详情。
			quietStartup: false,
			// 传JS入口数组原引用。
			extensions,
			// 开启真实分组支持。
			useRealScopeGroups: true,
		});

		// 真实资源显示入口格式化此JS路径。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// 不强制展开，默认紧凑。
			force: false,
		});

		// 完整快照仍应只有plan-mode标签；多行模板首尾的双引号是Vitest快照表示字符串时的一部分。
		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	// 普通webfetch.ts与目录plan-mode/index.ts混在一组，应分别保留文件名与目录名，不一概剥所有.ts或统一取父目录。
	test("mixed single-file and subdirectory index.ts extensions strip index.ts", () => {
		// 两项数组用来检验同一次标签生成中区别这两种入口形态。
		const extensions: ExtensionFixture[] = [
			// 第一项普通文件扩展。
			{
				// webfetch.ts不是index.ts，紧凑标签应保留后缀。
				path: "/tmp/extensions/webfetch.ts",
				// 附本地项目来源，与目录型项保持同政策。
				sourceInfo: createSourceInfo("/tmp/extensions/webfetch.ts", {
					// 本地引入。
					source: "local",
					// 项目范围。
					scope: "project",
					// 非包顶层文件。
					origin: "top-level",
					// 父目录extensions只是来源基准，不应取代文件标签webfetch.ts。
					baseDir: "/tmp/extensions",
				}),
			},
			// 第二项是目录型扩展入口。
			{
				// plan-mode/index.ts应剥去index.ts，区别第一项。
				path: "/tmp/extensions/plan-mode/index.ts",
				// 来源path与目录型条目一致。
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					// 本地来源，排除包名直接替代目录的影响。
					source: "local",
					// 同project范围。
					scope: "project",
					// 同top-level入口政策。
					origin: "top-level",
					// 来源根为extensions，plan-mode位于根下。
					baseDir: "/tmp/extensions",
				}),
			},
		];

		// 将这对不同形态入口装入独立资源宿主。
		const fakeThis = createShowLoadedResourcesThis({
			// 显示资源，默认折叠。
			quietStartup: false,
			// 传两项extensions引用。
			extensions,
			// 采用真实分组/详细格式化方法。
			useRealScopeGroups: true,
		});

		// 真实资源入口会为同一列表计算完整紧凑标签。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// force:false沿正常门禁。
			force: false,
		});

		// 快照同时要求plan-mode与webfetch.ts，本样本按标签排序使plan-mode在前；不意味着所有目录标签总排在文件标签之前。
		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode, webfetch.ts"`);
	});

	// foo/index.ts和bar/index.ts最近父目录已不同，紧凑标签只需foo/bar，不额外显示extensions等共同祖先。
	test("multiple index.ts with unique parent dirs need no disambiguation", () => {
		// 两项都为目录型入口，差异在最近父段。
		const extensions: ExtensionFixture[] = [
			// 第一项放foo目录。
			{
				// 完整foo/index.ts路径待去入口名。
				path: "/tmp/extensions/foo/index.ts",
				// 同一路径附来源记录。
				sourceInfo: createSourceInfo("/tmp/extensions/foo/index.ts", {
					// local来源，不是包。
					source: "local",
					// project范围。
					scope: "project",
					// 顶层入口。
					origin: "top-level",
					// 共同baseDir为extensions，不是foo自身。
					baseDir: "/tmp/extensions",
				}),
			},
			// 第二项放bar目录，与foo已有最短可区分标签。
			{
				// bar/index.ts尾名仍一样，目录段不同。
				path: "/tmp/extensions/bar/index.ts",
				// 来源记录指向bar入口。
				sourceInfo: createSourceInfo("/tmp/extensions/bar/index.ts", {
					// 保持local来源。
					source: "local",
					// 保持project范围。
					scope: "project",
					// 保持top-level，确保两项走相同规则。
					origin: "top-level",
					// 共同来源根不应多出现在紧凑标签。
					baseDir: "/tmp/extensions",
				}),
			},
		];

		// 独立宿主显示这两条目录型入口。
		const fakeThis = createShowLoadedResourcesThis({
			// 非安静、默认折叠。
			quietStartup: false,
			// 传入foo/bar数组，不在传入前排序。
			extensions,
			// 启用真实分组助手。
			useRealScopeGroups: true,
		});

		// 实际显示计算标签及排序。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// 不额外force展开。
			force: false,
		});

		// 快照要求bar,foo，既检查最近父名足够，也检查最终显示按标签排序而不是输入foo先的顺序。
		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  bar, foo"`);
	});

	// 两个父目录都叫tools，应继续加祖父alpha/beta区分；不因为去掉index.ts后同名就合并丢掉一条。
	test("multiple index.ts with same parent dir name disambiguated with grandparent", () => {
		// 建立两条同tools后缀入口的类型检查数组。
		const extensions: ExtensionFixture[] = [
			// 第一项祖父alpha。
			{
				// alpha/tools/index.ts最近父名tools与下一项冲突。
				path: "/tmp/alpha/tools/index.ts",
				// 创建临时CLI顶层来源记录，使非包标签消歧生效。
				sourceInfo: createSourceInfo("/tmp/alpha/tools/index.ts", {
					// CLI引入，未执行命令。
					source: "cli",
					// 临时范围。
					scope: "temporary",
					// 非包顶层入口。
					origin: "top-level",
					// 来源baseDir为alpha，算法仍可为冲突加入alpha段。
					baseDir: "/tmp/alpha",
				}),
			},
			// 第二项祖父beta。
			{
				// beta/tools/index.ts与第一项只在祖父段不同。
				path: "/tmp/beta/tools/index.ts",
				// 来源记录仍走同一临时CLI政策。
				sourceInfo: createSourceInfo("/tmp/beta/tools/index.ts", {
					// 来源cli。
					source: "cli",
					// 范围temporary。
					scope: "temporary",
					// 形式top-level。
					origin: "top-level",
					// baseDir为beta，对应本条路径。
					baseDir: "/tmp/beta",
				}),
			},
		];

		// 将两条冲突tools标签放同一资源宿主，才有机会彼此消歧。
		const fakeThis = createShowLoadedResourcesThis({
			// 允许正常资源显示。
			quietStartup: false,
			// 保留数组原引用，不提前把路径改成预期标签。
			extensions,
			// 启用真实分组方法，标签也由真实助手生成。
			useRealScopeGroups: true,
		});

		// 真实展示入口处理这两个路径。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// force:false，紧凑状态来自默认展开false。
			force: false,
		});

		// 快照要求alpha/tools、beta/tools，检查新增一层恰足区分，未直接比较内部segments数组。
		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/tools, beta/tools"`);
	});

	// 目录里的main.ts不是特殊index入口，应显示main.ts而非my-ext；这里只核这个固定文件名，不证明所有文件后缀规则。
	test("non-index file in subdirectory stays as filename", () => {
		// 单条非index文件数组，没有跨项冲突。
		const extensions: ExtensionFixture[] = [
			// 为此本地子目录文件创建新入口对象。
			{
				// 路径最后段main.ts，应保留为标签。
				path: "/tmp/extensions/my-ext/main.ts",
				// 同一路径附项目本地来源。
				sourceInfo: createSourceInfo("/tmp/extensions/my-ext/main.ts", {
					// local来源表达式。
					source: "local",
					// project分组范围。
					scope: "project",
					// top-level使它走非包入口标签，不被包名覆盖。
					origin: "top-level",
					// 来源基准extensions，文件额外经过my-ext目录，不应据此一概显示该目录名。
					baseDir: "/tmp/extensions",
				}),
			},
		];

		// 构造本例独立显示宿主。
		const fakeThis = createShowLoadedResourcesThis({
			// 关闭安静隐藏，允许资源节。
			quietStartup: false,
			// 传main.ts入口数组。
			extensions,
			// 接回真实分组方法。
			useRealScopeGroups: true,
		});

		// 调用真实显示，不import虚构main.ts。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// 保持默认紧凑模式。
			force: false,
		});

		// 归一化完整输出应仅main.ts标签，不把其父目录my-ext也列为入口名。
		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  main.ts"`);
	});

	// 包内extensions/index.ts应显示包名pi-markdown-preview，和本地目录入口去index规则一起防回归；不安装该包或执行其代码。
	test("package extensions still strip index.ts correctly (regression guard)", () => {
		// 单条npm包入口的夹具数组，类型仍只约束path/sourceInfo。
		const extensions: ExtensionFixture[] = [
			// 这一对象把入口路径与声明包根关联。
			{
				// 假路径位于node_modules包的extensions下，并非实际仓库已安装文件。
				path: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				// 为同一路径建立包来源记录，使显示助手使用包标签政策。
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts", {
					// 来源表达式npm:pi-markdown-preview决定紧凑包名，不从package.json读取名字。
					source: "npm:pi-markdown-preview",
					// 项目范围，和用户同名包可以不同组。
					scope: "project",
					// package标识包内资源，不是普通top-level入口。
					origin: "package",
					// 包根不含extensions，默认扩展目录在它下面。
					baseDir: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview",
				}),
			},
		];

		// 构造独立资源宿主，仍不创建真实PackageManager或ResourceLoader。
		const fakeThis = createShowLoadedResourcesThis({
			// 非安静显示。
			quietStartup: false,
			// 传入单npm入口数组引用。
			extensions,
			// 开启真实scope分组和详细格式化，标签逻辑同实际入口。
			useRealScopeGroups: true,
		});

		// 调用真实showLoadedResources，不运行包内index.ts。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// 保留默认折叠，force:false只沿正常门禁显示。
			force: false,
		});

		// 完整快照要求包名，而不是index.ts或extensions目录标签；这里仍是本地文字相等断言。
		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  pi-markdown-preview"`);
	});

	// 声明包primary-package引入同级sibling-package入口时，应以声明包为基准显示primary-package:../sibling-package，不能按实际路径另猜来源包。
	// 这里的../是允许的相对显示结果，不是目录安全边界；样本不访问node_modules或执行兄弟包。
	test("labels npm sibling extensions relative to the declaring package", () => {
		// 两入口数组共享同一个声明来源，但入口实际分别位于两个包目录。
		const extensions: ExtensionFixture[] = [
			// 第一项是声明包自己的index.ts。
			{
				// primary-package根入口给紧凑标签提供无额外后缀的对照项。
				path: "/tmp/project/.pi/npm/node_modules/primary-package/index.ts",
				// 来源工厂明确声明它属于primary-package。
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/primary-package/index.ts", {
					// npm:primary-package是声明来源，不读取实际包名清单。
					source: "npm:primary-package",
					// project范围。
					scope: "project",
					// package来源形式。
					origin: "package",
					// 基目录为声明包根，第一条相对路径去index后可简化为包名。
					baseDir: "/tmp/project/.pi/npm/node_modules/primary-package",
				}),
			},
			// 第二项实际在相邻sibling-package目录，仍由同一声明包引入。
			{
				// 入口path换到兄弟目录，用来制造相对路径需要..的样本。
				path: "/tmp/project/.pi/npm/node_modules/sibling-package/index.ts",
				// 来源path记录实际兄弟入口，但下面source/baseDir刻意保持声明包。
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/sibling-package/index.ts", {
					// 来源仍npm:primary-package，不改成sibling-package。
					source: "npm:primary-package",
					// 范围仍project，避免因分组不同而绕过包内显示。
					scope: "project",
					// 形式仍package，使用包根相对化。
					origin: "package",
					// baseDir仍为primary-package，所以兄弟入口的相对部分带../sibling-package。
					baseDir: "/tmp/project/.pi/npm/node_modules/primary-package",
				}),
			},
		];

		// 把两条入口放同一资源宿主，保留声明来源联系。
		const fakeThis = createShowLoadedResourcesThis({
			// 非安静启动，默认紧凑。
			quietStartup: false,
			// 传原数组，不在夹具中提前改成预期标签。
			extensions,
			// 真实scope分组/格式化启用，来源仍是手写元数据。
			useRealScopeGroups: true,
		});

		// 真实显示入口按声明包及相对入口生成两个标签。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// 不强制展开。
			force: false,
		});

		// 归一化完整快照同时要求primary-package及带../的兄弟标签，检查显示不把兄弟项误归另一来源。
		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  primary-package, primary-package:../sibling-package"`);
	});

	// 用Windows驱动器/反斜杠路径复现兄弟包相对标签，要求与前一POSIX样本同显示；这不在Windows上启动进程或访问C盘。
	test("labels Windows npm sibling extensions relative to the declaring package", () => {
		// 字符串中的双反斜杠产生实际单个路径分隔符，属于固定运行时路径数据，不是转义一个要执行的命令。
		const primaryPath = "C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\primary-package\\index.ts";
		// 兄弟包样本共用C:\Users\me前缀，但该地址不是宿主用户目录。
		const siblingPath = "C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\sibling-package\\index.ts";
		// 声明baseDir固定primary-package根，接下来两条SourceInfo共享这个字符串。
		const baseDir = "C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\primary-package";
		// 类型检查入口数组，Windows样式只是path字段值。
		const extensions: ExtensionFixture[] = [
			// 第一条对应声明包自己的入口。
			{
				// 属性path取变量primaryPath，没有做path.resolve变成宿主绝对地址。
				path: primaryPath,
				// 来源工厂收到同一Windows字符串，仍不做I/O。
				sourceInfo: createSourceInfo(primaryPath, {
					// 声明npm包身份primary-package。
					source: "npm:primary-package",
					// 这次改为user范围，检验标签不依赖必须是project范围。
					scope: "user",
					// 包内资源形式保持package。
					origin: "package",
					// baseDir简写采用上面的Windows声明包根，而非重新用宿主path.join。
					baseDir,
				}),
			},
			// 第二条对应实际位于兄弟包的入口。
			{
				// path保存siblingPath，与来源包名不同是本例关键。
				path: siblingPath,
				// 来源path跟实际兄弟入口相同，source/baseDir仍指声明包。
				sourceInfo: createSourceInfo(siblingPath, {
					// 保持npm:primary-package，不把路径最后包目录当新的声明源。
					source: "npm:primary-package",
					// 与第一条同为user范围。
					scope: "user",
					// 保持package形式。
					origin: "package",
					// 共享同一baseDir字符串，真实助手据此得到../sibling-package相对部分。
					baseDir,
				}),
			},
		];

		// 独立宿主渲染这组Windows路径，不修改process.platform。
		const fakeThis = createShowLoadedResourcesThis({
			// 允许资源展示，默认折叠。
			quietStartup: false,
			// 传两项Windows样式扩展数组。
			extensions,
			// 启用真实分组/格式化路径，而非预置resource-list结果。
			useRealScopeGroups: true,
		});

		// 真实显示入口处理Windows分隔符来源元数据，不执行路径文件。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// 保持force:false，未额外改显示策略。
			force: false,
		});

		// 快照要求与POSIX例同样两标签，最终normalizeRenderedOutput也统一反斜杠；断言不是原始Windows字节输出或C盘存在性检查。
		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  primary-package, primary-package:../sibling-package"`);
	});

	// 把八类混合扩展改为展开态，完整快照检查project/user/path组、包来源排序及包内相对路径；不检验真实扩展加载/信任。
	test("captures mixed extension layouts in expanded output", () => {
		// 独立宿主，使用之前八条夹具工厂。
		const fakeThis = createShowLoadedResourcesThis({
			// 非安静启动。
			quietStartup: false,
			// true让资源节初始直接画详细正文，不需要模拟展开快捷键。
			toolOutputExpanded: true,
			// 新八项路径/来源列表，真实磁盘仍没有被扫描。
			extensions: createExtensionFixtures(),
			// 必须用真实分组与详细格式化，不能靠默认resource-list占位通过此快照。
			useRealScopeGroups: true,
		});

		// 真实显示入口把夹具分组并挂成可展开主题组件。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// force:false，详细态来自toolOutputExpanded而非强制显示。
			force: false,
		});

		// 完整归一化快照固定项目组在前、用户组其次、临时path最后；Git同来源包下列extensions与extensions/subagents，npm命名空间保留。
		// 本地目录型入口去index，包内路径相对各baseDir；下方多行快照的缩进表示组/包/入口层级，是相等断言的一部分。
		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  project
    /tmp/project/.pi/extensions/answer.ts
    /tmp/project/.pi/extensions/local-index
    git:github.com/HazAT/pi-interactive-subagents
      extensions
      extensions/subagents
    npm:@scope/pi-scoped
      extensions
    npm:pi-markdown-preview
      extensions
  user
    /tmp/agent/extensions/user-index
  path
    /tmp/temp/cli-extension.ts"`);
	});

	// 紧凑上下文中，cwd内AGENTS应显示相对名，cwd外家目录AGENTS应保留~/前缀；只比较词法路径，不判断文件是否存在或被读取。
	test("shows context paths relative to cwd while preserving full external paths", () => {
		// homedir取系统家目录文字，通常来自环境/系统用户信息，不列举家目录文件。
		const home = homedir();
		// path.join拼一个家目录下Development/pi-mono假项目路径，不mkdir/chdir。
		const cwd = path.join(home, "Development", "pi-mono");
		// 工厂接假cwd与两条上下文来源，只返回内存读取函数。
		const fakeThis = createShowLoadedResourcesThis({
			// 正常显示资源。
			quietStartup: false,
			// 属性简写把拼好的cwd交真实路径格式化逻辑。
			cwd,
			// 外部用户AGENTS与内部项目AGENTS只含path，没有content；测试不会打开真实同名用户文件。
			contextFiles: [{ path: path.join(home, ".pi", "agent", "AGENTS.md") }, { path: path.join(cwd, "AGENTS.md") }],
		});

		// 真实showLoadedResources读取假agentsFiles，不调用资源加载器扫描/读盘。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// 不强制详情覆盖，正常紧凑。
			force: false,
		});

		// 渲染资源区再统一反斜杠，保留其他文字与ANSI；不是规范化原文件系统。
		const output = renderAll(fakeThis.loadedResourcesContainer).replace(/\\/g, "/");
		// Context节应出现，未精确限制整个资源界面。
		expect(output).toContain("[Context]");
		// 要求用户外部路径以~/.pi/agent/AGENTS.md、项目内部以AGENTS.md紧凑连接。
		expect(output).toContain("~/.pi/agent/AGENTS.md, AGENTS.md");
		// 不应出现cwd完整前缀后的项目AGENTS路径，避免内部文件仍显示绝对路径；模板只构造待排除子串。
		expect(output).not.toContain(`${cwd.replace(/\\/g, "/")}/AGENTS.md`);
	});

	// 系统提示来源SYSTEM、追加来源APPEND_SYSTEM应排在普通AGENTS之前，固定紧凑文字顺序，不读取这些Markdown内容。
	test("shows system prompt context paths before project context files", () => {
		// cwd固定/tmp/project，省去对宿主家目录文字的依赖。
		const cwd = "/tmp/project";
		// 独立宿主将三种上下文来源分别传入。
		const fakeThis = createShowLoadedResourcesThis({
			// 显示资源详情。
			quietStartup: false,
			// 使用本例固定cwd字符串。
			cwd,
			// 系统提示源对象仅含path，真实展示会把它列在上下文最前面。
			systemPromptSource: { path: path.join(cwd, ".pi", "SYSTEM.md") },
			// 追加系统来源数组在主系统来源之后、普通AGENTS之前，不在此合并提示词正文。
			appendSystemPromptSources: [{ path: path.join(cwd, ".pi", "APPEND_SYSTEM.md") }],
			// 普通项目上下文只有一条AGENTS路径，未给content。
			contextFiles: [{ path: path.join(cwd, "AGENTS.md") }],
		});

		// 实际显示方法按自身组合顺序读取三种来源，尚不提交模型。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// force:false沿正常紧凑显示。
			force: false,
		});

		// 渲染并统一路径分隔符，不修改原SourceInfo或磁盘。
		const output = renderAll(fakeThis.loadedResourcesContainer).replace(/\\/g, "/");
		// 要求有Context标题。
		expect(output).toContain("[Context]");
		// 连续子串要求SYSTEM→APPEND_SYSTEM→AGENTS这一顺序；不检查所有资源类别的总排序或重复来源去重。
		expect(output).toContain(".pi/SYSTEM.md, .pi/APPEND_SYSTEM.md, AGENTS.md");
	});

	// 同样两条上下文在展开态应各保留完整的家目录缩写路径，不再用紧凑逗号串；这里的“full”仍可含~而非原绝对路径。
	test("shows full context paths when expanded", () => {
		// 取系统home字符串供构造路径，不扫描或写家目录。
		const home = homedir();
		// 构造Development/pi-mono假项目目录，路径存在与否不参与本例。
		const cwd = path.join(home, "Development", "pi-mono");
		// 新宿主提供展开显示和这两条上下文路径。
		const fakeThis = createShowLoadedResourcesThis({
			// 非安静，允许详情。
			quietStartup: false,
			// 全局展开true，真实上下文节使用逐路径详细正文。
			toolOutputExpanded: true,
			// cwd使用家目录下假项目路径，供相对规则对照。
			cwd,
			// 两路径仍只有path、无正文，不读取真实用户AGENTS。
			contextFiles: [{ path: path.join(home, ".pi", "agent", "AGENTS.md") }, { path: path.join(cwd, "AGENTS.md") }],
		});

		// 调用真实资源显示，内容完全来自假Loader。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// force:false排除强制展示差异。
			force: false,
		});

		// 渲染展开态并把反斜杠换/，不调用normalizeRenderedOutput的额外尾空白裁剪。
		const output = renderAll(fakeThis.loadedResourcesContainer).replace(/\\/g, "/");
		// Context标题应保留。
		expect(output).toContain("[Context]");
		// 外部用户上下文以缩家目录的完整路径出现。
		expect(output).toContain("~/.pi/agent/AGENTS.md");
		// 内部项目上下文这次也保留~/Development/pi-mono/AGENTS.md，而非紧凑相对名。
		expect(output).toContain("~/Development/pi-mono/AGENTS.md");
		// 紧凑逗号连接串不应出现，区分详细逐行路径展示；不精确检查全部换行/缩进。
		expect(output).not.toContain("~/.pi/agent/AGENTS.md, AGENTS.md");
	});

	// quiet:true时即便传reload式扩展列表和showDiagnosticsWhenQuiet:true，没诊断也不能显出普通资源详情；不真正执行reload。
	test("does not show verbose listing on quiet startup during reload", () => {
		// 创建有技能但全安静的宿主，diagnostics缺省空。
		const fakeThis = createShowLoadedResourcesThis({
			// true隐藏普通详情与页头，除非其他显式覆盖；本例没有verbose。
			quietStartup: true,
			// 技能存在却仍应隐藏，避免空资源列表偶然让断言通过。
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		// 直接把选项交真实showLoadedResources，模拟reload调用参数而非运行整个会话重载。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// 显式extensions数组提供一个假入口，会覆盖加载器扩展列表，但不代表忽略quiet政策。
			extensions: [{ path: "/tmp/ext/index.ts" }],
			// force:false不强制普通资源展示。
			force: false,
			// 此true仅允许安静时显示诊断，不等于列出全部资源；本例诊断均为空。
			showDiagnosticsWhenQuiet: true,
		});

		// 资源容器必须零children，证明这个样本没有加资源节/警告；不检查真实startup header容器。
		expect(fakeThis.loadedResourcesContainer.children).toHaveLength(0);
	});

	// quiet="header"应隐藏资源但保留页头；这里通过容器长度与两个纯门禁方法结果观察，不构造/渲染实际页头。
	test("hides resource listing but keeps the startup header with header-only quiet startup", () => {
		// 新宿主选择仅保留页头的安静启动模式。
		const fakeThis = createShowLoadedResourcesThis({
			// 字面字符串header与布尔true不同，不能只按真值统一处理。
			quietStartup: "header",
			// 技能非空用于确认资源确被门禁隐藏。
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		// 执行真实资源显示入口，未调用startup init。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// force:false保留quiet="header"行为。
			force: false,
		});

		// 资源区无孩子，不等于整个终端完全无任何输出。
		expect(fakeThis.loadedResourcesContainer.children).toHaveLength(0);
		// 直接调用真实shouldShowStartupHeader，应true；没有核真正header内容或安装顺序。
		expect((InteractiveMode as any).prototype.shouldShowStartupHeader.call(fakeThis)).toBe(true);
		// 详情门禁应false，与保留页头结果同时成立。
		expect((InteractiveMode as any).prototype.shouldShowStartupDetails.call(fakeThis)).toBe(false);
	});

	// 两个固定组合分别核全安静隐藏页头、header模式遇verbose打开详情；没有直接断言verbose对象的页头结果，不扩称全部设置矩阵。
	test("hides the startup header with full quiet startup unless verbose", () => {
		// 只给quiet:true的新宿主，verbose缺省false。
		const quiet = createShowLoadedResourcesThis({ quietStartup: true });
		// 全安静样本的页头门禁应false，无实际页头渲染。
		expect((InteractiveMode as any).prototype.shouldShowStartupHeader.call(quiet)).toBe(false);
		// 另一宿主用header字符串加verbose:true，二者优先级不同于前一对象。
		const verbose = createShowLoadedResourcesThis({ quietStartup: "header", verbose: true });
		// 只断言此verbose样本的详情门禁true，没有调用showLoadedResources生成容器。
		expect((InteractiveMode as any).prototype.shouldShowStartupDetails.call(verbose)).toBe(true);
	});

	// 全安静仍可按请求展示技能诊断区，并隐藏普通Skills资源节；诊断正文在工厂中为固定替身，不核duplicate skill name原文。
	test("still shows diagnostics on quiet startup when requested", () => {
		// 本例资源与诊断都非空，便于区分门禁。
		const fakeThis = createShowLoadedResourcesThis({
			// 全安静通常隐藏普通资源。
			quietStartup: true,
			// 一个commit技能在正常详情中本可显示，但这次不得出现Skills节。
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			// 一条warning诊断触发警告区；message仅是输入样本，实际formatDiagnostics替身不读它。
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		// 直接调用真实资源显示方法，不重新加载或校验技能。
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			// force:false不强制普通详情。
			force: false,
			// 允许安静时专门显示诊断，让warning区域通过门禁。
			showDiagnosticsWhenQuiet: true,
		});

		// 渲染实际追加的资源区域，含警告标题与固定diagnostics文字。
		const output = renderAll(fakeThis.loadedResourcesContainer);
		// 必须有Skill warnings标题，证明诊断分支可显示。
		expect(output).toContain("[Skill warnings]");
		// 不得有普通Skills标题；不核具体诊断message、级别颜色或是否另有其他警告组。
		expect(output).not.toContain("[Skills]");
	});
});
