// 验证浮层的显示顺序与键盘焦点是两件事：nonCapturing禁止显示时自动抢焦点，显式focus仍能聚焦并提升视觉顺序。
// 全部用例使用内存VirtualTerminal；EDITOR/TIMER等只是简单假组件的显示文字，不创建真实编辑器、业务计时器、剪贴板或网络连接。
// 测试通过focused标志、收到的完整输入数组、重叠格的最终字符观察行为；失败由assert抛错交Node测试器。
import assert from "node:assert";
// describe/it登记分组和异步测试回调；不在注册时完成所有绘制。
import { describe, it } from "node:test";
// type导入Component/Focusable只做TS结构检查，不产生基类或运行时验证。
import type { Component, Focusable } from "../src/tui.ts";
// Container是真正容器类，用children决定挂载树；TUI仅是类型，实际运行对象在下一行导入。
import { Container, type TUI } from "../src/tui.ts";
// 主屏实现负责焦点状态机、帧调度和写入，这里只对接模拟终端。
import { TuiMainScreen } from "../src/tui-main-screen.ts";
// xterm headless适配器在内存解析ANSI；write不保证立即完成，测试通过等待助手再读屏。
import { VirtualTerminal } from "./virtual-terminal.ts";

// 固定行假组件，无focused/handleInput，但TUI仍可把组件引用设为键盘焦点；用于把视觉覆盖与Focusable标志分开。
class StaticOverlay implements Component {
	// private是TS访问限制，保存传入数组引用，不是JS的#私有字段。
	private lines: string[];

	// 构造接收行数组并保存，无渲染/IO；例 new StaticOverlay(["A"]) 之后渲染返回该数组，调用者可修改它。
	constructor(lines: string[]) {
		// 显式字段赋值，不复制lines。
		this.lines = lines;
	}

	// 无参render直接返回固定行数组；方法可以少声明未使用的width参数仍满足Component，不会按预算裁剪。
	render(): string[] {
		// 原数组引用返回，测试应不经返回值修改它；不自动写终端。
		return this.lines;
	}

	// 空失效方法满足接口，因无缓存所以无动作/返回值；例TUI强制失效不会改变文字。
	invalidate(): void {}
}

// 零行基础组件让浮层测试避免背景文字干扰；没有键盘输入处理器或焦点标志。
class EmptyContent implements Component {
	// 无参数render返回新空行数组，无副作用；例主屏有子组件但基础画面高度仍0。
	render(): string[] {
		// []表示零条行，而非包含一个空串的空白行。
		return [];
	}
	// invalidate空实现，仅满足接口；没有缓存可清。
	invalidate(): void {}
}

// 同时满足显示与焦点契约的假组件；记录所有送到handleInput的输入块，本身不解析键位或编辑文本。
class FocusableOverlay implements Component, Focusable {
	// focused初始false由TUI焦点切换时赋值；不是通过构造或添加子组件自动设true。
	focused = false;
	// string[]保存输入顺序，初始独立空数组；后面deepStrictEqual会检查有无误投递。
	inputs: string[] = [];
	// 显示行私有字段，和输入日志是不同状态。
	private lines: string[];

	// 构造保存显示数组，无IO；例 new FocusableOverlay(["EDITOR"]) 的 EDITOR 只是标签，不是项目 Editor 类。
	constructor(lines: string[]) {
		// 保存原数组引用，不拷贝。
		this.lines = lines;
	}

	// 同步输入回调接收一个字符串块，push后返回void；例 handleInput("x") 记录 ["x"]，异常不捕获，也不主动请求重画。
	handleInput(data: string): void {
		// push按接收顺序改inputs数组；原字符串不被解析成字符。
		this.inputs.push(data);
	}

	// 返回固定显示行，不根据focused或inputs改变外观；焦点断言因此须读字段/输入日志。
	render(): string[] {
		// 直接返回原lines数组引用，不进行折行。
		return this.lines;
	}

	// 无渲染缓存，失效回调为空；满足Component契约不代表有缓存行为。
	invalidate(): void {}
}

// 请求一次强制帧并等待常见渲染流程，输入TUI和虚拟终端，返回Promise<void>；例focus后await再查视口。
// requestRender(true)先重置屏幕渲染状态并排帧，再跨nextTick、约20ms与flush；不保证任意未来动画全部结束。
// 直接调用/等待的错误可使本Promise拒绝；独立nextTick渲染回调抛错没有被这里统一转成Promise拒绝。
async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	// true强制重置渲染状态，但实际绘制由调度执行，不在此同步画完。
	tui.requestRender(true);
	// Promise<void>的executor同步注册nextTick，resolve稍后完成；await给已排帧机会运行。
	await new Promise<void>((resolve) => process.nextTick(resolve));
	// 再等待模拟器常见节流帧并排空此前写队列；它不接管真实TTY。
	await terminal.waitForRender();
}

// 注册浮层总测试组；所有实例各自创建，finally用于stop，不共用一份真实终端。
describe("TUI overlay non-capturing", () => {
	// 焦点管理先检查字段，再用输入日志区分“看着没聚焦”与“确实没有收到键”。
	describe("focus management", () => {
		// 创建被动浮层不应改变原编辑器焦点；流程设基础焦点→show(nonCapturing)→等待→比较两focused，无参数，返回测试Promise。
		it("non-capturing overlay preserves focus on creation", async () => {
			// 构造80×24内存屏，不改变宿主窗口。
			const terminal = new VirtualTerminal(80, 24);
			// 创建该模拟屏上的主屏TUI，类型注解只检查接口。
			const tui: TUI = new TuiMainScreen(terminal);
			// 创建名为EDITOR的假组件，这里未把它加入基础挂载树。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 浮层也是同类假组件，初始focused=false。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 挂零行基础内容，避免其他视觉输出。
			tui.addChild(new EmptyContent());
			// 显式设编辑器引用为焦点，设置焦点不要求它已挂载。
			tui.setFocus(editor);
			// 启动虚拟输入回调/帧调度，在下面try之前；start若抛错不会进入其finally。
			tui.start();
			// 保护后续show/等待/断言，异常仍需停止已启动TUI。
			try {
				// 被动浮层进入栈、排帧但不自动setFocus。
				tui.showOverlay(overlay, { nonCapturing: true });
				// 等待常见渲染管线，使屏幕与已发生状态变动同步到测试可读时机。
				await renderAndFlush(tui, terminal);
				// 原编辑器标志仍true。
				assert.strictEqual(editor.focused, true);
				// 浮层标志仍false，没有偷偷抢键盘。
				assert.strictEqual(overlay.focused, false);
				// 不论断言成功与否执行清理，finally本身的异常也会传播。
			} finally {
				// 停止本例虚拟TUI及其渲染调度/exit监听，不销毁系统终端。
				tui.stop();
			}
		});

		// nonCapturing只限制自动抢焦点；句柄focus显式转移焦点，例编辑器true→false、浮层false→true并查询句柄身份。
		it("focus() transfers focus to the overlay", async () => {
			// 独立80×24内存终端。
			const terminal = new VirtualTerminal(80, 24);
			// 新主屏TUI，避免前例状态影响。
			const tui: TUI = new TuiMainScreen(terminal);
			// 基础假编辑器。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 待聚焦的假浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 挂空内容。
			tui.addChild(new EmptyContent());
			// 先让编辑器聚焦。
			tui.setFocus(editor);
			// 启动模拟调度。
			tui.start();
			// 后续步骤受finally停止保护。
			try {
				// 保留该条目句柄；创建时仍不自动聚焦。
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				// 现在显式聚焦并提升focusOrder，焦点状态同步改变，绘制随后发生。
				handle.focus();
				// 等待排帧/写队列。
				await renderAndFlush(tui, terminal);
				// 编辑器应已失焦。
				assert.strictEqual(editor.focused, false);
				// 浮层focused应为true。
				assert.strictEqual(overlay.focused, true);
				// 句柄isFocused按当前组件引用比较，也应true。
				assert.strictEqual(handle.isFocused(), true);
				// 进入无条件清理。
			} finally {
				// 停止这份虚拟TUI。
				tui.stop();
			}
		});

		// 先显式聚焦被动浮层再unfocus，当前例无其他捕获浮层，退回show时preFocus编辑器；不移除/隐藏浮层。
		it("unfocus() restores previous focus", async () => {
			// 独立模拟屏。
			const terminal = new VirtualTerminal(80, 24);
			// 新TUI实例。
			const tui: TUI = new TuiMainScreen(terminal);
			// 创建preFocus目标。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 创建被动浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 挂空基础。
			tui.addChild(new EmptyContent());
			// 记录初始编辑器焦点。
			tui.setFocus(editor);
			// 启动TUI。
			tui.start();
			// 对后续操作保证finally stop。
			try {
				// show捕获当时preFocus为editor但不抢焦点。
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				// 显式focus使该浮层具恢复资格。
				handle.focus();
				// unfocus清恢复资格并回退preFocus，视觉条目仍在。
				handle.unfocus();
				// 等待画面更新。
				await renderAndFlush(tui, terminal);
				// 编辑器重新true。
				assert.strictEqual(editor.focused, true);
				// 浮层false。
				assert.strictEqual(overlay.focused, false);
				// 句柄读出的当前焦点也false。
				assert.strictEqual(handle.isFocused(), false);
				// 无条件停止分支。
			} finally {
				// 停止虚拟输入/调度。
				tui.stop();
			}
		});

		// 临时隐藏再显示被动浮层，不能因恢复可见自动聚焦；检查编辑器保持焦点而不是断言具体像素区域。
		it("setHidden(false) on non-capturing overlay does not auto-focus", async () => {
			// 80×24内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 新主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 基础假编辑器。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 被动浮层假组件。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 挂空内容。
			tui.addChild(new EmptyContent());
			// 显式基础焦点。
			tui.setFocus(editor);
			// 开始虚拟TUI。
			tui.start();
			// 保护show及句柄操作。
			try {
				// show被动浮层并保存句柄。
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				// setHidden(true)只暂藏条目，与hide永久移除不同。
				handle.setHidden(true);
				// 恢复显式可见；因nonCapturing不自动聚焦/提升该捕获流程。
				handle.setHidden(false);
				// 等待渲染。
				await renderAndFlush(tui, terminal);
				// 编辑器仍聚焦。
				assert.strictEqual(editor.focused, true);
				// 被动浮层仍未聚焦。
				assert.strictEqual(overlay.focused, false);
				// finally清理。
			} finally {
				// 停止虚拟TUI。
				tui.stop();
			}
		});

		// 移除从未聚焦的被动浮层，不应改变其他组件焦点；这里只检查editor true。
		it("hide() when overlay is not focused does not change focus", async () => {
			// 独立模拟终端。
			const terminal = new VirtualTerminal(80, 24);
			// 新主屏实例。
			const tui: TUI = new TuiMainScreen(terminal);
			// 假编辑器。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 假浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 挂空内容。
			tui.addChild(new EmptyContent());
			// 建立编辑器焦点。
			tui.setFocus(editor);
			// 启动调度。
			tui.start();
			// 保护后续移除/等待。
			try {
				// 注册被动浮层，当前焦点仍editor。
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				// hide从栈中永久移除此条目，不是设置hidden标志。
				handle.hide();
				// 等待浮层从画面去掉。
				await renderAndFlush(tui, terminal);
				// 编辑器焦点保持true。
				assert.strictEqual(editor.focused, true);
				// 清理分支。
			} finally {
				// 停止虚拟TUI。
				tui.stop();
			}
		});

		// 移除当前聚焦的被动浮层时应恢复show前编辑器，并清浮层focused标志；先focus才能走此回退分支。
		it("hide() when focused restores focus correctly", async () => {
			// 80×24内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏调度器。
			const tui: TUI = new TuiMainScreen(terminal);
			// 基础编辑器假组件。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 被动浮层假组件。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 挂空基础。
			tui.addChild(new EmptyContent());
			// 设show前焦点。
			tui.setFocus(editor);
			// 启动TUI。
			tui.start();
			// 保护聚焦与移除。
			try {
				// show被动条目并保存preFocus。
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				// 显式聚焦，让下面hide需要恢复键盘归属。
				handle.focus();
				// 永久移除聚焦条目，当前例回到editor。
				handle.hide();
				// 等帧完成。
				await renderAndFlush(tui, terminal);
				// editor 的焦点标志为 true。
				assert.strictEqual(editor.focused, true);
				// 浮层false，未留悬空焦点。
				assert.strictEqual(overlay.focused, false);
				// 保证停止。
			} finally {
				// 执行虚拟stop。
				tui.stop();
			}
		});

		// 上方捕获浮层关闭时，下方未主动聚焦的被动浮层不能自动抢焦点；回到创建捕获层前的editor。
		it("capturing overlay removed with non-capturing below restores focus to editor", async () => {
			// 独立内存终端。
			const terminal = new VirtualTerminal(80, 24);
			// 新TUI。
			const tui: TUI = new TuiMainScreen(terminal);
			// 基础编辑器。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 下方NC被动假组件。
			const nonCapturing = new FocusableOverlay(["NC"]);
			// 上方CAP捕获假组件。
			const capturing = new FocusableOverlay(["CAP"]);
			// 挂空内容。
			tui.addChild(new EmptyContent());
			// 初始编辑器聚焦。
			tui.setFocus(editor);
			// 启动调度。
			tui.start();
			// 保护浮层堆叠和移除。
			try {
				// 先加被动层，焦点仍editor。
				tui.showOverlay(nonCapturing, { nonCapturing: true });
				// 默认show捕获层，自动聚焦且preFocus为editor。
				const handle = tui.showOverlay(capturing);
				// 先验证捕获层确实得到焦点。
				assert.strictEqual(capturing.focused, true);
				// 移除它，自动候选筛选跳过nonCapturing层。
				handle.hide();
				// 等待刷新。
				await renderAndFlush(tui, terminal);
				// 编辑器重新聚焦。
				assert.strictEqual(editor.focused, true);
				// 下方NC没有自动得到焦点。
				assert.strictEqual(nonCapturing.focused, false);
				// 清理分支。
			} finally {
				// stop虚拟TUI。
				tui.stop();
			}
		});

		// 模拟扩展计时标签+控制浮层：先删被动子层再hideOverlay删后插入控制层，preFocus须绕过已删层并恢复editor输入。
		it("sub-overlay cleanup then hideOverlay restores focus and input to editor", async () => {
			// 独立80×24模拟屏。
			const terminal = new VirtualTerminal(80, 24);
			// 新主屏TUI。
			const tui: TUI = new TuiMainScreen(terminal);
			// 原编辑器假组件。
			const editor = new FocusableOverlay(["EDITOR"]);
			// TIMER只是固定行标签，没有创建setInterval等业务计时器。
			const timer = new FocusableOverlay(["TIMER"]);
			// CTRL为捕获输入控制假组件。
			const controller = new FocusableOverlay(["CTRL"]);
			// 挂空基础画面。
			tui.addChild(new EmptyContent());
			// 初始焦点给editor。
			tui.setFocus(editor);
			// 启动模拟。
			tui.start();
			// finally保护堆叠及测试输入。
			try {
				// 添加被动timer条目，保存句柄供精确移除。
				const timerHandle = tui.showOverlay(timer, { nonCapturing: true });
				// 添加默认捕获controller，当前焦点转给它。
				tui.showOverlay(controller);
				// controller标志true。
				assert.strictEqual(controller.focused, true);
				// editor 的焦点标志为 false。
				assert.strictEqual(editor.focused, false);
				// 先移除timer，其他条目preFocus若指向它需重接，不应留下失效目标。
				timerHandle.hide();
				// hideOverlay删除插入栈末项controller，并非按视觉排序任意删除。
				tui.hideOverlay();
				// 等待关闭后的帧。
				await renderAndFlush(tui, terminal);
				// editor恢复true。
				assert.strictEqual(editor.focused, true);
				// controller已失焦。
				assert.strictEqual(controller.focused, false);
				// timer未被错误聚焦。
				assert.strictEqual(timer.focused, false);
				// sendInput直接同步送虚拟输入回调，无真实键盘。
				terminal.sendInput("x");
				// 等待处理x后的刷新。
				await renderAndFlush(tui, terminal);
				// editor日志完整恰为[x]。
				assert.deepStrictEqual(editor.inputs, ["x"]);
				// controller不应收到关闭后x。
				assert.deepStrictEqual(controller.inputs, []);
				// timer也不应收到。
				assert.deepStrictEqual(timer.inputs, []);
				// 清理分支。
			} finally {
				// 停止虚拟TUI。
				tui.stop();
			}
		});

		// child先显式聚焦，再创建parent使其preFocus指向child；先删除child再parent，回退必须跨已删child到editor。
		// 名称parent/child描述创建前焦点关系，不是嵌套Container树；发送x验证实际键盘路由。
		it("removed focused child overlay does not become parent overlay fallback", async () => {
			// 独立模拟屏。
			const terminal = new VirtualTerminal(80, 24);
			// 新TUI。
			const tui: TUI = new TuiMainScreen(terminal);
			// 最终回退编辑器。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 先创建/聚焦的子层。
			const child = new FocusableOverlay(["CHILD"]);
			// 后创建的捕获层。
			const parent = new FocusableOverlay(["PARENT"]);
			// 挂空内容。
			tui.addChild(new EmptyContent());
			// 初始editor焦点。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护后续两次移除及输入。
			try {
				// child被动show时preFocus是editor。
				const childHandle = tui.showOverlay(child, { nonCapturing: true });
				// 显式聚焦child。
				childHandle.focus();
				// parent默认聚焦，它创建时preFocus是child。
				const parentHandle = tui.showOverlay(parent);
				// 验证parent确实占键盘。
				assert.strictEqual(parent.focused, true);

				// 移除child时retargetOverlayPreFocus把parent的preFocus重接到editor。
				childHandle.hide();
				// 再删parent，不应恢复已移除child。
				parentHandle.hide();
				// 关闭后立即送x，焦点恢复不依赖先绘一帧。
				terminal.sendInput("x");
				// 等待视觉更新后检查日志。
				await renderAndFlush(tui, terminal);

				// x恰送给editor。
				assert.deepStrictEqual(editor.inputs, ["x"]);
				// 已删child日志为空。
				assert.deepStrictEqual(child.inputs, []);
				// parent日志也为空。
				assert.deepStrictEqual(parent.inputs, []);
				// editor焦点标志true。
				assert.strictEqual(editor.focused, true);
				// 最后停止。
			} finally {
				// 执行虚拟stop。
				tui.stop();
			}
		});

		// 异步扩展示例只模拟时机：Promise executor同步show timer，then微任务才show controller；done先清子层再关控制层并resolve。
		// 不调用真实showExtensionCustom、不发Esc键；直接doneFn模拟其清理动作，再送x验证恢复editor。
		it("microtask-deferred sub-overlay pattern (showExtensionCustom simulation) restores focus", async () => {
			// 新内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 新TUI。
			const tui: TUI = new TuiMainScreen(terminal);
			// 基础编辑器。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 被动timer假组件。
			const timer = new FocusableOverlay(["TIMER"]);
			// controller假组件。
			const controller = new FocusableOverlay(["CTRL"]);
			// 挂空内容。
			tui.addChild(new EmptyContent());
			// 初始焦点editor。
			tui.setFocus(editor);
			// 启动调度。
			tui.start();
			// 保护异步流程直到结束stop。
			try {
				// Simulate showExtensionCustom: factory creates timer synchronously,
				// then .then() pushes controller as a microtask
				// ReturnType<typeof tui.showOverlay>在编译期提取句柄返回类型，|null允许executor尚未赋值；typeof这里是类型查询非运行时typeof。
				let timerHandle: ReturnType<typeof tui.showOverlay> | null = null;
				// doneFn声明无参void函数，先存抛错占位器；下面executor同步替换它，未初始化调用才会抛。
				let doneFn: () => void = () => {
					// 固定错误暴露测试准备时机错误，不是用户操作失败回退。
					throw new Error("doneFn was not initialized");
				};

				// Promise<void> executor现在同步执行，只保存未来完成动作，不立即resolve。
				const overlayPromise = new Promise<void>((resolve) => {
					// 替换doneFn为真正清理回调，闭包捕获timerHandle/tui/resolve；此处创建函数不调用它。
					doneFn = () => {
						// 清理发生时要求timerHandle已保存，否则同步throw，后续hide/resolve不执行。
						if (!timerHandle) throw new Error("timerHandle was not initialized");
						// 精确移除timer条目。
						timerHandle.hide();
						// 删除插入栈末尾controller，回退preFocus。
						tui.hideOverlay();
						// 标记外层Promise成功完成，不表示xterm已绘完，所以后面还需等待。
						resolve();
					};
					// executor仍同步阶段注册被动timer并保存句柄。
					timerHandle = tui.showOverlay(timer, { nonCapturing: true });
					// .then() runs as microtask — same as showExtensionCustom
					// Promise.resolve包住controller，then回调在微任务执行，和同步executor创建timer区分。
					Promise.resolve(controller).then((c) => {
						// 微任务收到同一组件引用c，再show默认捕获层；这里才改变controller焦点。
						tui.showOverlay(c);
					});
				});

				// await一个已完成Promise让前面then微任务有机会执行，未等overlayPromise完成（它尚待done）。
				await Promise.resolve();
				// 再等帧/模拟器解析。
				await renderAndFlush(tui, terminal);

				// controller已在微任务中聚焦。
				assert.strictEqual(controller.focused, true);
				// editor失焦。
				assert.strictEqual(editor.focused, false);

				// Simulate Esc: cleanup + close (from inside handleInput)
				// 直接调用清理闭包，模拟关闭动作；没有实际发送Esc。
				doneFn();
				// Now await the promise (simulating showExtensionCustom resolving)
				// 等待前面resolve的完成信号；Promise完成与终端排帧是分开的。
				await overlayPromise;
				// 清理后再等待帧。
				await renderAndFlush(tui, terminal);

				// editor须恢复焦点，错误消息解释期待。
				assert.strictEqual(editor.focused, true, "editor should regain focus");
				// controller失焦。
				assert.strictEqual(controller.focused, false);
				// timer未被错误聚焦。
				assert.strictEqual(timer.focused, false);

				// 再送普通输入x。
				terminal.sendInput("x");
				// 等待刷新。
				await renderAndFlush(tui, terminal);
				// 完整editor日志只有x。
				assert.deepStrictEqual(editor.inputs, ["x"], "editor should receive input after close");
				// controller无关闭后输入。
				assert.deepStrictEqual(controller.inputs, []);
				// 最终清理，不吞此前异常。
			} finally {
				// stop虚拟TUI。
				tui.stop();
			}
		});

		// 当前PRIMARY因visible回调变false，下一次输入前重选可见捕获浮层，跳过被动NC；同一个x要投递FALLBACK。
		it("handleInput redirection skips non-capturing overlays when focused overlay becomes invisible", async () => {
			// 独立模拟终端。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏实例。
			const tui: TUI = new TuiMainScreen(terminal);
			// 基础编辑器。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 仍可见的捕获备用层。
			const fallbackCapturing = new FocusableOverlay(["FALLBACK"]);
			// 被动NC层。
			const nonCapturing = new FocusableOverlay(["NC"]);
			// 主要捕获层。
			const primary = new FocusableOverlay(["PRIMARY"]);
			// let可修改状态，visible闭包每次读取当前值，不是构造时快照。
			let isVisible = true;
			// 挂空内容。
			tui.addChild(new EmptyContent());
			// 设基础焦点。
			tui.setFocus(editor);
			// 启动虚拟调度。
			tui.start();
			// 保护动态可见性/输入。
			try {
				// 先show捕获备用层。
				tui.showOverlay(fallbackCapturing);
				// 再加被动层，不自动改焦点。
				tui.showOverlay(nonCapturing, { nonCapturing: true });
				// show主要层，visible箭头忽略尺寸参数只返回isVisible；登记时可能被同步查询。
				tui.showOverlay(primary, { visible: () => isVisible });
				// 主要层初始可见且聚焦。
				assert.strictEqual(primary.focused, true);
				// 改变闭包状态，不调用setHidden，临时不可见与显式隐藏清恢复资格不同。
				isVisible = false;
				// 立刻送x，输入链自己检查可见性，无需先render。
				terminal.sendInput("x");
				// 等帧后观察。
				await renderAndFlush(tui, terminal);
				// 不可见PRIMARY没收x。
				assert.deepStrictEqual(primary.inputs, []);
				// 被动NC也没收x。
				assert.deepStrictEqual(nonCapturing.inputs, []);
				// 备用捕获层完整日志[x]。
				assert.deepStrictEqual(fallbackCapturing.inputs, ["x"]);
				// 它成为新焦点。
				assert.strictEqual(fallbackCapturing.focused, true);
				// 清理。
			} finally {
				// stop虚拟TUI。
				tui.stop();
			}
		});

		// 浮层b键让基础replacement临时接管，replacement收到回车才返回；关闭输入不能提前被浮层抢走，后续x再回浮层。
		// replacement未挂基础树，所以它尝试setFocus(editor)时blocked恢复规则会立即恢复浮层，并非无条件最终聚焦editor。
		it("active base focus replacement receives close input before overlay restore", async () => {
			// 独立内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 新主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// show前编辑器。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 未挂载的临时替代假组件。
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			// 捕获浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 实例上替换输入方法：接收data记录，只有b请求replacement焦点；回调无返回值、无实际编辑。
			overlay.handleInput = (data: string) => {
				// 手动记原浮层输入日志。
				overlay.inputs.push(data);
				// 固定b是本测试的切换触发，非生产快捷键配置。
				if (data === "b") {
					// 从浮层转到非祖先基础目标，状态机记录blocked替代流程。
					tui.setFocus(replacement);
				}
			};
			// replacement输入回调记录输入，仅回车请求回editor；恢复决策仍由TUI状态机决定。
			replacement.handleInput = (data: string) => {
				// 记录替代者输入，不转发给浮层。
				replacement.inputs.push(data);
				// \r是回车字符，不是换行\n。
				if (data === "\r") {
					// 替代者未挂载，setFocus请求editor会触发恢复原浮层。
					tui.setFocus(editor);
				}
			};
			// 基础仅挂空内容，replacement确实不在挂载树。
			tui.addChild(new EmptyContent());
			// 初始焦点editor。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护模拟按键与断言。
			try {
				// show默认捕获浮层。
				tui.showOverlay(overlay);
				// 先确认它聚焦。
				assert.strictEqual(overlay.focused, true);
				// 同步送b，由浮层处理并切焦点。
				terminal.sendInput("b");
				// 等待刷新。
				await renderAndFlush(tui, terminal);
				// 替代者活跃时应有焦点，下一键不得提前恢复浮层。
				assert.strictEqual(replacement.focused, true);

				// 送回车，该键必须先到replacement。
				terminal.sendInput("\r");
				// 等待它的关闭/恢复过程画出。
				await renderAndFlush(tui, terminal);
				// replacement只收到回车。
				assert.deepStrictEqual(replacement.inputs, ["\r"]);
				// 浮层目前只收到最初b，没有误收关闭回车。
				assert.deepStrictEqual(overlay.inputs, ["b"]);
				// 回车处理后浮层已恢复true。
				assert.strictEqual(overlay.focused, true);

				// 再送x，应给恢复后的浮层。
				terminal.sendInput("x");
				// 等待刷新。
				await renderAndFlush(tui, terminal);
				// 完整浮层输入顺序[b,x]。
				assert.deepStrictEqual(overlay.inputs, ["b", "x"]);
				// 清理。
			} finally {
				// 停止虚拟TUI。
				tui.stop();
			}
		});

		// 另一个被动浮层的preFocus恰为replacement，也不能把它误当成应立即恢复的旧祖先；活跃替代者仍收1/回车。
		it("active replacement still receives input when it is another overlay preFocus", async () => {
			// 独立模拟屏。
			const terminal = new VirtualTerminal(80, 24);
			// 新TUI。
			const tui: TUI = new TuiMainScreen(terminal);
			// 基础编辑器。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 未挂载替代者。
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			// 用于保存replacement为preFocus的PASSIVE条目。
			const passive = new FocusableOverlay(["PASSIVE"]);
			// 后来真正接管键盘的OVERLAY。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 替换浮层输入处理：记录data并在b时临时聚焦replacement。
			overlay.handleInput = (data: string) => {
				// 先记录输入。
				overlay.inputs.push(data);
				// 只在b分支切换。
				if (data === "b") {
					// TUI决定记录blocked替代，不直接操作其他浮层栈。
					tui.setFocus(replacement);
				}
			};
			// 替代者处理任意data先记日志，回车请求回editor；之后状态机恢复浮层。
			replacement.handleInput = (data: string) => {
				// 记录1与回车的顺序。
				replacement.inputs.push(data);
				// 识别回车。
				if (data === "\r") {
					// 请求editor，但替代者未挂载所以恢复逻辑可重定向到OVERLAY。
					tui.setFocus(editor);
				}
			};
			// 基础只挂零行内容。
			tui.addChild(new EmptyContent());
			// 先设editor焦点。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护特殊preFocus准备及输入。
			try {
				// 先把replacement设为当前基础焦点。
				tui.setFocus(replacement);
				// 创建PASSIVE时捕获它为preFocus，但不自动抢走replacement焦点。
				tui.showOverlay(passive, { nonCapturing: true });
				// 切回editor，之后OVERLAY的preFocus应是editor而非replacement。
				tui.setFocus(editor);
				// 添加默认捕获OVERLAY。
				tui.showOverlay(overlay);
				// 发送b切到replacement的blocked流程。
				terminal.sendInput("b");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 替代者获得焦点。
				assert.strictEqual(replacement.focused, true);

				// 普通1要继续给活跃替代者，不能因它是另条目preFocus就被抢走。
				terminal.sendInput("1");
				// 回车也先给替代者，再触发恢复。
				terminal.sendInput("\r");
				// 等待刷新。
				await renderAndFlush(tui, terminal);
				// 完整替代输入按顺序[1,回车]。
				assert.deepStrictEqual(replacement.inputs, ["1", "\r"]);
				// 浮层只收了b，没误收关闭输入。
				assert.deepStrictEqual(overlay.inputs, ["b"]);
				// 关闭后回到OVERLAY焦点。
				assert.strictEqual(overlay.focused, true);
				// 最终清理。
			} finally {
				// stop虚拟TUI。
				tui.stop();
			}
		});

		// 已挂载替代流程可以从FIRST转SECOND而不立刻恢复浮层；SECOND关闭时先移除替代者，再请求editor才恢复浮层。
		// 例输入b→n→2→回车，分别由OVERLAY、FIRST、SECOND接收；挂载树在此决定“内部切换”还是“流程结束”。
		it("blocked replacement can move focus internally before overlay restore", async () => {
			// 新内存终端。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏实例。
			const tui: TUI = new TuiMainScreen(terminal);
			// 真实Container提供TUI可识别的children树，而非只在变量中保存组件。
			const base = new Container();
			// 基础编辑器假组件。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 第一个替代者。
			const firstReplacement = new FocusableOverlay(["FIRST"]);
			// 第二个替代者。
			const secondReplacement = new FocusableOverlay(["SECOND"]);
			// 原捕获浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 浮层输入回调记录并在b时请求FIRST，无显式返回值。
			overlay.handleInput = (data: string) => {
				// 记原浮层输入。
				overlay.inputs.push(data);
				// 单行if仅在b时切焦点，进入blocked状态。
				if (data === "b") tui.setFocus(firstReplacement);
			};
			// FIRST回调接data，n时把替代流程内部焦点转SECOND；仍挂载的FIRST让TUI延续blocked而非恢复。
			firstReplacement.handleInput = (data: string) => {
				// 记FIRST输入。
				firstReplacement.inputs.push(data);
				// 请求SECOND，状态机把blockedBy从FIRST换成SECOND。
				if (data === "n") tui.setFocus(secondReplacement);
			};
			// SECOND回调记录输入，回车时重建基础树只剩editor，再请求焦点；这一顺序决定替代者已卸载。
			secondReplacement.handleInput = (data: string) => {
				// 记SECOND输入。
				secondReplacement.inputs.push(data);
				// 回车才走关闭分支。
				if (data === "\r") {
					// clear只清Container.children，不自动setFocus或dispose组件。
					base.clear();
					// 重新把editor加回基础根子树。
					base.addChild(editor);
					// SECOND已不在挂载树，TUI将此请求重定向恢复原浮层。
					tui.setFocus(editor);
				}
			};
			// 初始树含editor。
			base.addChild(editor);
			// FIRST确实已挂载，内部n切换时不能被当成卸载。
			base.addChild(firstReplacement);
			// SECOND也挂载，供其正常处理2和回车。
			base.addChild(secondReplacement);
			// 把整个Container作为TUI基础子根，isComponentMounted递归它的children。
			tui.addChild(base);
			// 先设editor焦点。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护输入序列及树修改，异常后仍stop。
			try {
				// 显示默认捕获浮层。
				tui.showOverlay(overlay);
				// b给浮层并切到FIRST。
				terminal.sendInput("b");
				// 等待本次帧。
				await renderAndFlush(tui, terminal);
				// n给FIRST，切到仍挂载SECOND。
				terminal.sendInput("n");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 2继续给SECOND，证明内部切换后未被浮层抢回。
				terminal.sendInput("2");
				// 回车给SECOND，移除替代者并恢复浮层。
				terminal.sendInput("\r");
				// 等最终帧。
				await renderAndFlush(tui, terminal);

				// 浮层恰只收b。
				assert.deepStrictEqual(overlay.inputs, ["b"]);
				// FIRST恰只收n。
				assert.deepStrictEqual(firstReplacement.inputs, ["n"]);
				// SECOND恰收2/回车，顺序固定。
				assert.deepStrictEqual(secondReplacement.inputs, ["2", "\r"]);
				// 最终原浮层true。
				assert.strictEqual(overlay.focused, true);
				// 最终清理。
			} finally {
				// stop虚拟TUI。
				tui.stop();
			}
		});

		// 浮层创建前焦点PALETTE与替代关闭请求editor不同，仍应在替代卸载后恢复浮层；不能只靠目标是否等于preFocus决定结束。
		it("removed replacement restores overlay even when overlay preFocus differs from next focus", async () => {
			// 独立内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 新主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// Container提供可识别挂载树。
			const base = new Container();
			// 关闭回调请求的editor。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 浮层创建前焦点palette，故preFocus不同于editor。
			const palette = new FocusableOverlay(["PALETTE"]);
			// 暂时接管键盘的replacement。
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			// 原捕获浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 浮层回调记录b并切replacement，形成blocked。
			overlay.handleInput = (data: string) => {
				// 记录浮层输入块。
				overlay.inputs.push(data);
				// b触发替代，不直接删浮层。
				if (data === "b") tui.setFocus(replacement);
			};
			// 替代者回车时清树只留editor并请求editor；TUI检测自身卸载后仍恢复浮层。
			replacement.handleInput = (data: string) => {
				// 记录替代输入。
				replacement.inputs.push(data);
				// 只对回车关闭。
				if (data === "\r") {
					// 先清挂载树，replacement不再被识别为挂载。
					base.clear();
					// 保留editor作为基础内容。
					base.addChild(editor);
					// 请求editor，但恢复规则可能重定向到浮层。
					tui.setFocus(editor);
				}
			};
			// 初始树加入editor。
			base.addChild(editor);
			// 加入palette。
			base.addChild(palette);
			// replacement初始也在挂载树。
			base.addChild(replacement);
			// 挂base到主屏。
			tui.addChild(base);
			// 从palette创建浮层，建立与editor不同的preFocus。
			tui.setFocus(palette);
			// 启动虚拟调度。
			tui.start();
			// 保护输入和树变化。
			try {
				// show默认捕获浮层。
				tui.showOverlay(overlay);
				// b交它转replacement。
				terminal.sendInput("b");
				// 等待帧。
				await renderAndFlush(tui, terminal);
				// 回车使替代者卸载并触发恢复。
				terminal.sendInput("\r");
				// 随即x无需先等待帧，也应直接给已恢复的浮层。
				terminal.sendInput("x");
				// 等待最后渲染。
				await renderAndFlush(tui, terminal);

				// 浮层完整日志[b,x]。
				assert.deepStrictEqual(overlay.inputs, ["b", "x"]);
				// replacement只收到回车。
				assert.deepStrictEqual(replacement.inputs, ["\r"]);
				// editor虽作为setFocus参数，但不应收到x。
				assert.deepStrictEqual(editor.inputs, []);
				// 最终浮层focused=true。
				assert.strictEqual(overlay.focused, true);
				// 清理分支。
			} finally {
				// stop虚拟TUI。
				tui.stop();
			}
		});

		// blocked期间unfocus({target})只预约替代结束后的目标，不能立刻抢走replacement的关闭回车。
		// 例b切replacement并预约TARGET，回车请求FALLBACK时状态机转TARGET，后续x仅TARGET收到。
		it("unfocus target releases a blocked overlay while replacement remains focused", async () => {
			// 内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏实例。
			const tui: TUI = new TuiMainScreen(terminal);
			// 替代者关闭时原本请求的FALLBACK。
			const fallback = new FocusableOverlay(["FALLBACK"]);
			// unfocus显式预约的TARGET。
			const target = new FocusableOverlay(["TARGET"]);
			// 当前临时替代者。
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			// 原捕获浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 替代输入回调先记data，回车请求fallback；真正结果由已预约resume决定。
			replacement.handleInput = (data: string) => {
				// 记录替代日志。
				replacement.inputs.push(data);
				// 回车时请求fallback，但focus-target预约优先。
				if (data === "\r") tui.setFocus(fallback);
			};
			// 挂零行基础，不挂这些假输入组件。
			tui.addChild(new EmptyContent());
			// 启动。
			tui.start();
			// 保护句柄预约和输入过程。
			try {
				// 保存捕获浮层句柄，供闭包在b后unfocus。
				const overlayHandle = tui.showOverlay(overlay);
				// 覆盖原浮层输入方法，回调捕获上面的句柄。
				overlay.handleInput = (data: string) => {
					// 先记录收到的数据。
					overlay.inputs.push(data);
					// 只在b走替代/预约步骤。
					if (data === "b") {
						// 先转replacement建立blocked状态。
						tui.setFocus(replacement);
						// 属性简写target指定TARGET；此时只改resume不立即聚焦TARGET。
						overlayHandle.unfocus({ target });
					}
				};

				// 同步输入b运行这两步。
				terminal.sendInput("b");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 确认replacement仍聚焦，没有被unfocus立即抢走键盘。
				assert.strictEqual(replacement.focused, true);
				// 回车仍必须送replacement。
				terminal.sendInput("\r");
				// 后续x交预约target，非fallback/原浮层。
				terminal.sendInput("x");
				// 等最终帧。
				await renderAndFlush(tui, terminal);

				// 原浮层只收b。
				assert.deepStrictEqual(overlay.inputs, ["b"]);
				// replacement只收关闭回车。
				assert.deepStrictEqual(replacement.inputs, ["\r"]);
				// fallback未收x。
				assert.deepStrictEqual(fallback.inputs, []);
				// target恰收x，证明预约在替代结束时应用。
				assert.deepStrictEqual(target.inputs, ["x"]);
				// 清理。
			} finally {
				// stop虚拟TUI。
				tui.stop();
			}
		});

		// 可见浮层经历replacement再editor焦点请求后仍能收x；本例replacement未挂载，第二次setFocus已可同步恢复浮层。
		// 因此断言证明最终路由，不单独区分恢复发生在setFocus还是handleInput哪一步。
		it("handleInput restores focus to a visible focused overlay after base focus steal", async () => {
			// 独立模拟终端。
			const terminal = new VirtualTerminal(80, 24);
			// 新主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 基础editor。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 未挂载replacement。
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			// 可见捕获浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 仅挂空内容，replacement确实不在树中。
			tui.addChild(new EmptyContent());
			// 设editor初始焦点。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护临时切焦点和输入。
			try {
				// show自动聚焦浮层并记录恢复资格。
				tui.showOverlay(overlay);
				// 先验证浮层确实聚焦。
				assert.strictEqual(overlay.focused, true);
				// 转replacement使恢复暂blocked。
				tui.setFocus(replacement);
				// replacement未挂载，转editor请求会触发恢复浮层。
				tui.setFocus(editor);
				// x应给当前恢复后的浮层。
				terminal.sendInput("x");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 浮层只收到x。
				assert.deepStrictEqual(overlay.inputs, ["x"]);
				// editor没有输入。
				assert.deepStrictEqual(editor.inputs, []);
				// 浮层最终聚焦。
				assert.strictEqual(overlay.focused, true);
				// 清理。
			} finally {
				// stop模拟TUI。
				tui.stop();
			}
		});

		// 被动SUB显式focus后也获得恢复资格；返回其preFocus祖先editor后，下一次输入前应恢复SUB而非默认controller。
		it("handleInput restores focus to explicitly focused raw sub-overlay after base focus steal", async () => {
			// 独立内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 基础editor。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 先创建捕获controller。
			const controller = new FocusableOverlay(["CONTROLLER"]);
			// 再创建被动SUB。
			const subOverlay = new FocusableOverlay(["SUB"]);
			// 挂空基础。
			tui.addChild(new EmptyContent());
			// editor初始焦点。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护层级与输入。
			try {
				// 先show controller，它的preFocus为editor。
				tui.showOverlay(controller);
				// show被动SUB，它的preFocus为controller。
				const subHandle = tui.showOverlay(subOverlay, { nonCapturing: true });
				// 显式focus SUB使其eligible且视觉前置。
				subHandle.focus();
				// 请求editor沿SUB→controller→editor的preFocus祖先链返回，不建立新blocked替代。
				tui.setFocus(editor);
				// 输入前eligible恢复SUB，所以x不应给editor/controller。
				terminal.sendInput("x");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// SUB收到x。
				assert.deepStrictEqual(subOverlay.inputs, ["x"]);
				// controller没收。
				assert.deepStrictEqual(controller.inputs, []);
				// editor没收。
				assert.deepStrictEqual(editor.inputs, []);
				// 清理。
			} finally {
				// stop虚拟TUI。
				tui.stop();
			}
		});

		// 从未显式聚焦的被动浮层没有恢复资格，普通x仍归editor；与下一例主动focus形成对照。
		it("passive non-capturing overlay does not regain input after base focus", async () => {
			// 内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏实例。
			const tui: TUI = new TuiMainScreen(terminal);
			// editor假组件。
			const editor = new FocusableOverlay(["EDITOR"]);
			// PASSIVE假组件。
			const passive = new FocusableOverlay(["PASSIVE"]);
			// 空基础。
			tui.addChild(new EmptyContent());
			// editor初始聚焦。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护显示/输入。
			try {
				// 被动show不设焦点/eligible。
				tui.showOverlay(passive, { nonCapturing: true });
				// 送x，当前仍editor。
				terminal.sendInput("x");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// editor日志恰[x]。
				assert.deepStrictEqual(editor.inputs, ["x"]);
				// PASSIVE无输入。
				assert.deepStrictEqual(passive.inputs, []);
				// editor仍聚焦。
				assert.strictEqual(editor.focused, true);
				// 清理。
			} finally {
				// 停止。
				tui.stop();
			}
		});

		// 被动层显式focus后，再请求其preFocus editor只暂时让基础获得引用；下一次输入前eligible仍可恢复被动层。
		it("explicitly focused non-capturing overlay regains input after base focus steal", async () => {
			// 模拟屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏实例。
			const tui: TUI = new TuiMainScreen(terminal);
			// editor为原焦点。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 被动NC为可恢复目标。
			const overlay = new FocusableOverlay(["NC"]);
			// 挂空基础。
			tui.addChild(new EmptyContent());
			// 聚焦editor。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护句柄操作。
			try {
				// show被动NC保存preFocus。
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				// 显式focus建立恢复资格。
				handle.focus();
				// 回preFocus editor不会自动清eligible。
				tui.setFocus(editor);
				// x到来时恢复NC并投递。
				terminal.sendInput("x");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// NC收到x。
				assert.deepStrictEqual(overlay.inputs, ["x"]);
				// editor未收到，不能只因setFocus(editor)调用就断言输入给它。
				assert.deepStrictEqual(editor.inputs, []);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// 显式unfocus会清浮层恢复资格，后续可见也不能在输入前抢回；浮层仍可显示。
		it("unfocus() prevents visible overlay from regaining input", async () => {
			// 模拟屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// editor假组件。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 浮层假组件。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 空基础。
			tui.addChild(new EmptyContent());
			// editor初始焦点。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护释放和输入。
			try {
				// show默认捕获浮层。
				const handle = tui.showOverlay(overlay);
				// unfocus清资格并回preFocus editor，不移除条目。
				handle.unfocus();
				// x继续给editor。
				terminal.sendInput("x");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// editor收到x。
				assert.deepStrictEqual(editor.inputs, ["x"]);
				// 浮层日志为空。
				assert.deepStrictEqual(overlay.inputs, []);
				// editor 的焦点标志为 true。
				assert.strictEqual(editor.focused, true);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// 直接从浮层setFocus(null)清焦点和恢复资格，下一输入不应恢复它；与blocked替代者调用null不同。
		it("setFocus(null) explicitly clears visible overlay restore", async () => {
			// 内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 唯一浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 挂空基础无输入处理器。
			tui.addChild(new EmptyContent());
			// 启动时尚无基础焦点。
			tui.start();
			// 保护show和清焦点。
			try {
				// 默认show使浮层聚焦。
				tui.showOverlay(overlay);
				// 普通null路径清eligible，最终焦点为null。
				tui.setFocus(null);
				// 送x无焦点组件可接。
				terminal.sendInput("x");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 浮层无输入。
				assert.deepStrictEqual(overlay.inputs, []);
				// 浮层false。
				assert.strictEqual(overlay.focused, false);
				// 清理。
			} finally {
				// 停止。
				tui.stop();
			}
		});

		// blocked替代者自己setFocus(null)表示替代流程结束，默认resume恢复原浮层而非最终保持null；下一x验证这一优先级。
		it("blocked replacement setFocus(null) resumes the visible overlay", async () => {
			// 内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 替代者。
			const replacement = new FocusableOverlay(["REPLACEMENT"]);
			// 原浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 替代回调接收/记录输入，回车请求null；没有实际关闭外部窗口。
			replacement.handleInput = (data: string) => {
				// 记替代日志。
				replacement.inputs.push(data);
				// 回车分支结束blocked，TUI把null请求重定向回浮层。
				if (data === "\r") tui.setFocus(null);
			};
			// 浮层回调在b时切replacement，其他data仅记录。
			overlay.handleInput = (data: string) => {
				// 记浮层日志。
				overlay.inputs.push(data);
				// b建立blockedBy replacement。
				if (data === "b") tui.setFocus(replacement);
			};
			// 挂空内容。
			tui.addChild(new EmptyContent());
			// 启动。
			tui.start();
			// 保护按键序列。
			try {
				// show默认捕获浮层。
				tui.showOverlay(overlay);
				// b使replacement接管。
				terminal.sendInput("b");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 回车先交replacement，它请求null触发resume。
				terminal.sendInput("\r");
				// 接着x归原浮层。
				terminal.sendInput("x");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 替代者仅收到回车。
				assert.deepStrictEqual(replacement.inputs, ["\r"]);
				// 浮层收到b/x，无关闭回车。
				assert.deepStrictEqual(overlay.inputs, ["b", "x"]);
				// 最终聚焦浮层。
				assert.strictEqual(overlay.focused, true);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// 动态visible暂false不清原eligible，基础收x；恢复true后同一浮层能在下一y前重获焦点。
		// 这里先setFocus(editor)让焦点在基础，再切可见性，检验保存的恢复资格而非显式hidden标志。
		it("temporarily invisible focused overlay falls back without losing restore eligibility", async () => {
			// 内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 新主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 原基础editor。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 动态可见浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 可变visible供闭包实时读取。
			let visible = true;
			// 空内容。
			tui.addChild(new EmptyContent());
			// 初始editor焦点。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护动态状态和输入。
			try {
				// 可见性回调忽略尺寸参数返回visible，初始true使默认show聚焦。
				tui.showOverlay(overlay, { visible: () => visible });
				// 回preFocus editor，保留浮层恢复资格。
				tui.setFocus(editor);
				// 仅改变回调状态，不用setHidden清资格。
				visible = false;
				// x时getVisibleOverlayFocusRestore临时返回inactive，故editor收x。
				terminal.sendInput("x");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// editor已收x。
				assert.deepStrictEqual(editor.inputs, ["x"]);
				// 暂不可见浮层没收x。
				assert.deepStrictEqual(overlay.inputs, []);
				// 恢复回调true，原eligible记录仍在。
				visible = true;
				// 输入y前恢复浮层。
				terminal.sendInput("y");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// editor日志仍只有x，没误收y。
				assert.deepStrictEqual(editor.inputs, ["x"]);
				// 浮层只收y，证明恢复资格保留。
				assert.deepStrictEqual(overlay.inputs, ["y"]);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// preFocus为null的聚焦浮层变不可见后无基础接收者，x丢在无焦点路径；恢复可见后y仍能给原浮层。
		it("temporarily invisible focused overlay with null preFocus restores when visible again", async () => {
			// 独立屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 唯一浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 可变可见性。
			let visible = true;
			// 空内容，不设置基础焦点。
			tui.addChild(new EmptyContent());
			// 启动。
			tui.start();
			// 保护可见性变化。
			try {
				// 默认show时preFocus为null，初始可见且聚焦。
				tui.showOverlay(overlay, { visible: () => visible });
				// 回调改false，但未显式setHidden。
				visible = false;
				// 输入链发现当前浮层不可见，回null时用preserve保留其恢复资格。
				terminal.sendInput("x");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 浮层没收到x。
				assert.deepStrictEqual(overlay.inputs, []);
				// 重新可见。
				visible = true;
				// 输入y触发恢复原eligible。
				terminal.sendInput("y");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 浮层日志恰[y]。
				assert.deepStrictEqual(overlay.inputs, ["y"]);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// 浮层创建前焦点就是自己，preFocus形成自环；setFocus(editor)遍历祖先时visited须终止，再让editor接x而不挂住。
		// 只验证这个自环场景，没有设置性能超时或证明所有任意组件树环都被处理。
		it("cyclic overlay preFocus ancestry does not hang focus changes", async () => {
			// 内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 目标editor。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 用于自环的同一浮层对象。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 空内容。
			tui.addChild(new EmptyContent());
			// 在show前先聚焦overlay，之后entry.preFocus将指向自身组件。
			tui.setFocus(overlay);
			// 启动。
			tui.start();
			// 保护自环操作，正常结束stop。
			try {
				// 被动show不自动改焦点，但保存自引用preFocus。
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				// 显式focus建立eligible。
				handle.focus();
				// 目标editor不是preFocus祖先，祖先查找遇visited自环终止并建立blockedBy editor。
				tui.setFocus(editor);
				// editor仍为当前替代者，x继续给它。
				terminal.sendInput("x");
				// 等帧，此Promise能够完成也表明没有在同步祖先查找中死循环。
				await renderAndFlush(tui, terminal);
				// editor收到x。
				assert.deepStrictEqual(editor.inputs, ["x"]);
				// overlay没有误收。
				assert.deepStrictEqual(overlay.inputs, []);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// LOWER先创建但后来显式focus，成为focusOrder最前；回基础后下一x应恢复LOWER，而非按插入栈末项UPPER恢复。
		it("handleInput restores the focus-order top overlay after base focus steal", async () => {
			// 模拟屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 基础editor。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 先插入LOWER。
			const lower = new FocusableOverlay(["LOWER"]);
			// 后插入UPPER。
			const upper = new FocusableOverlay(["UPPER"]);
			// 空内容。
			tui.addChild(new EmptyContent());
			// editor初始焦点。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护顺序/输入。
			try {
				// 先show LOWER，preFocus editor。
				const lowerHandle = tui.showOverlay(lower);
				// 后show UPPER，初始焦点在UPPER。
				tui.showOverlay(upper);
				// 显式focus LOWER提升视觉序号并更新eligible。
				lowerHandle.focus();
				// 请求LOWER的preFocus editor不会新建blocked替代。
				tui.setFocus(editor);
				// 下一x前恢复最后显式聚焦LOWER。
				terminal.sendInput("x");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// LOWER日志[x]。
				assert.deepStrictEqual(lower.inputs, ["x"]);
				// UPPER无输入。
				assert.deepStrictEqual(upper.inputs, []);
				// editor无输入。
				assert.deepStrictEqual(editor.inputs, []);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// hideOverlay删除插入栈末项NC，即使键盘仍在之前CAP；移除未聚焦被动层不应改CAP焦点。
		it("hideOverlay() does not reassign focus when topmost overlay is non-capturing", async () => {
			// 模拟屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 原editor。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 捕获CAP。
			const capturing = new FocusableOverlay(["CAP"]);
			// 被动NC。
			const nonCapturing = new FocusableOverlay(["NC"]);
			// 空内容。
			tui.addChild(new EmptyContent());
			// 初始editor焦点。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护两层栈操作。
			try {
				// CAP默认show自动聚焦。
				tui.showOverlay(capturing);
				// 再插入NC但不抢CAP。
				tui.showOverlay(nonCapturing, { nonCapturing: true });
				// 先确认CAP true。
				assert.strictEqual(capturing.focused, true);
				// 删除最后插入NC，不按视觉/当前焦点删除CAP。
				tui.hideOverlay();
				// 等待刷新。
				await renderAndFlush(tui, terminal);
				// CAP仍true，未重新分配键盘。
				assert.strictEqual(capturing.focused, true);
				// 清理。
			} finally {
				// stop虚拟TUI。
				tui.stop();
			}
		});

		// 交替C1/N1/C2/N2堆叠，移除捕获C2应跳过被动N层回C1，再删C1回editor；不要求逐层删除所有可见条目。
		it("multiple capturing and non-capturing overlays restore focus through removals", async () => {
			// 80×24内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏实例。
			const tui: TUI = new TuiMainScreen(terminal);
			// 基础editor。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 第一个捕获层C1。
			const c1 = new FocusableOverlay(["C1"]);
			// 第一个被动层N1。
			const n1 = new FocusableOverlay(["N1"]);
			// 第二个捕获层C2。
			const c2 = new FocusableOverlay(["C2"]);
			// 第二个被动层N2。
			const n2 = new FocusableOverlay(["N2"]);
			// 空基础。
			tui.addChild(new EmptyContent());
			// 初始editor焦点。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护堆叠和移除。
			try {
				// show C1并保存句柄，自动聚焦。
				const c1Handle = tui.showOverlay(c1);
				// show N1不抢焦点。
				tui.showOverlay(n1, { nonCapturing: true });
				// show C2自动抢焦点。
				const c2Handle = tui.showOverlay(c2);
				// 最后show N2依旧不抢C2。
				tui.showOverlay(n2, { nonCapturing: true });
				// 确认当前捕获C2聚焦。
				assert.strictEqual(c2.focused, true);
				// 按句柄精确删除C2，自动回退候选跳过N层。
				c2Handle.hide();
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 剩余捕获C1应聚焦。
				assert.strictEqual(c1.focused, true);
				// 再删除C1。
				c1Handle.hide();
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 无捕获候选，回到preFocus editor。
				assert.strictEqual(editor.focused, true);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// 最前捕获浮层自己unfocus不能再次把自己选为回退目标；当前例无其他捕获层，必须退preFocus editor。
		it("capturing overlay unfocus() on topmost capturing overlay falls back to preFocus", async () => {
			// 模拟屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 原基础editor。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 唯一捕获层CAP。
			const capturing = new FocusableOverlay(["CAP"]);
			// 空基础。
			tui.addChild(new EmptyContent());
			// editor初始焦点。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护show/释放。
			try {
				// 默认show CAP自动聚焦。
				const handle = tui.showOverlay(capturing);
				// 验证初始CAP true。
				assert.strictEqual(capturing.focused, true);
				// unfocus清其恢复资格；最前候选若仍是自己则选preFocus，而不是重新聚焦自己。
				handle.unfocus();
				// 等帧。
				await renderAndFlush(tui, terminal);
				// editor恢复true。
				assert.strictEqual(editor.focused, true);
				// CAP false，条目仍保留可见。
				assert.strictEqual(capturing.focused, false);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});
	});

	// 无操作保护组检查失效/隐藏句柄及无焦点分支；这些守卫不等于句柄所有方法都统一验证存活。
	describe("no-op guards", () => {
		// 显式hidden条目的focus应无操作，editor仍聚焦；不在这里调用visible回调或测量边框。
		it("focus() on hidden overlay is a no-op", async () => {
			// 内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// editor假组件。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 浮层假组件。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 空基础。
			tui.addChild(new EmptyContent());
			// editor初始焦点。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护隐藏及focus。
			try {
				// 被动show保存句柄。
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				// 临时hidden，不从栈移除。
				handle.setHidden(true);
				// 可见性守卫阻止聚焦隐藏条目。
				handle.focus();
				// 等帧。
				await renderAndFlush(tui, terminal);
				// editor仍true。
				assert.strictEqual(editor.focused, true);
				// 句柄isFocused为false。
				assert.strictEqual(handle.isFocused(), false);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// hide永久移除后旧句柄focus应无操作，不能把已删组件重新设焦点或重加栈。
		it("focus() after hide() is a no-op", async () => {
			// 内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 创建基础假组件 editor。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 待删除浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 空基础。
			tui.addChild(new EmptyContent());
			// 初始editor。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护旧句柄操作。
			try {
				// 被动show取得句柄。
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				// 永久移除条目。
				handle.hide();
				// focus先检查entry仍在栈，此时跳过。
				handle.focus();
				// 等帧。
				await renderAndFlush(tui, terminal);
				// editor仍聚焦。
				assert.strictEqual(editor.focused, true);
				// 旧句柄不报告焦点。
				assert.strictEqual(handle.isFocused(), false);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// 没有当前焦点也没有待恢复资格的被动浮层unfocus应无操作；不传显式target。
		it("unfocus() when overlay does not have focus is a no-op", async () => {
			// 内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 创建基础假组件 editor。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 被动浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 空基础。
			tui.addChild(new EmptyContent());
			// 初始editor。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护句柄操作。
			try {
				// show nonCapturing，未得到eligible。
				const handle = tui.showOverlay(overlay, { nonCapturing: true });
				// unfocus满足无当前/待恢复双条件守卫，直接返回。
				handle.unfocus();
				// 等帧。
				await renderAndFlush(tui, terminal);
				// editor 的焦点标志为 true。
				assert.strictEqual(editor.focused, true);
				// 浮层false。
				assert.strictEqual(overlay.focused, false);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// 捕获层preFocus=null时unfocus清焦点，后续x不能再通过eligible恢复自己；检查日志/句柄标志。
		it("unfocus() with null preFocus clears focus and does not route input back to overlay", async () => {
			// 内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 唯一浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 空基础，没有先setFocus。
			tui.addChild(new EmptyContent());
			// 启动时焦点为空。
			tui.start();
			// 保护释放流程。
			try {
				// 默认show自动聚焦，保存preFocus null。
				const handle = tui.showOverlay(overlay);
				// 浮层true。
				assert.strictEqual(overlay.focused, true);
				// 无其他候选，释放到null并清恢复状态。
				handle.unfocus();
				// 立即检查false，焦点改变无需等render。
				assert.strictEqual(overlay.focused, false);
				// 发送x时无焦点组件可接。
				terminal.sendInput("x");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 浮层日志为空。
				assert.deepStrictEqual(overlay.inputs, []);
				// 输入后也未恢复浮层，句柄仍false。
				assert.strictEqual(handle.isFocused(), false);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});
	});

	// 焦点循环组区分显式目标、创建前焦点与视觉顺序；不通过改插入栈顺序来实现focus。
	describe("focus cycle prevention", () => {
		// 两个被动层A/B反复focus后释放A，仍须回原editor，不形成互相preFocus循环；实际preFocus在show时保存。
		it("toggle focus between non-capturing overlays then unfocus returns to editor", async () => {
			// 内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 原editor。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 被动A。
			const a = new FocusableOverlay(["A"]);
			// 被动B。
			const b = new FocusableOverlay(["B"]);
			// 空基础。
			tui.addChild(new EmptyContent());
			// 初始editor。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护轮换。
			try {
				// A创建时preFocus editor。
				const aHandle = tui.showOverlay(a, { nonCapturing: true });
				// B也在editor仍聚焦时创建，preFocus同样editor。
				const bHandle = tui.showOverlay(b, { nonCapturing: true });
				// 显式聚焦A。
				aHandle.focus();
				// 再聚焦B，只提升序号/资格，不把show时preFocus改成A。
				bHandle.focus();
				// 再聚焦A。
				aHandle.focus();
				// 释放A回其原preFocus editor，不按刚才焦点历史回B。
				aHandle.unfocus();
				// 等帧。
				await renderAndFlush(tui, terminal);
				// editor 的焦点标志为 true。
				assert.strictEqual(editor.focused, true);
				// A 的焦点标志为 false。
				assert.strictEqual(a.focused, false);
				// B 的焦点标志为 false。
				assert.strictEqual(b.focused, false);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// 三个捕获浮层显式轮换收不同字母，再unfocus指定editor；完整日志检查键盘归属，不靠视觉字符判断焦点。
		it("explicit unfocus target supports cycling between three overlays and editor", async () => {
			// 内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 指定基础目标editor。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 浮层A。
			const a = new FocusableOverlay(["A"]);
			// 浮层B。
			const b = new FocusableOverlay(["B"]);
			// 浮层C。
			const c = new FocusableOverlay(["C"]);
			// 空基础。
			tui.addChild(new EmptyContent());
			// 初始editor。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护整段轮换输入。
			try {
				// 默认show A，preFocus editor。
				const aHandle = tui.showOverlay(a);
				// 默认show B，preFocus A。
				const bHandle = tui.showOverlay(b);
				// 默认show C，preFocus B。
				const cHandle = tui.showOverlay(c);

				// 先显式聚焦A，视觉上也前置。
				aHandle.focus();
				// 送小写a。
				terminal.sendInput("a");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 聚焦B。
				bHandle.focus();
				// 送小写b。
				terminal.sendInput("b");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 聚焦C。
				cHandle.focus();
				// 送小写c。
				terminal.sendInput("c");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 显式target editor优先于捕获候选/preFocus回退，同时清C恢复资格。
				cHandle.unfocus({ target: editor });
				// 送小写e应给editor。
				terminal.sendInput("e");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 重新显式聚焦仍在栈内A。
				aHandle.focus();
				// 送大写A，区分两次路由。
				terminal.sendInput("A");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 释放A并明确目标editor，不走普通回退。
				aHandle.unfocus({ target: editor });
				// 送大写E。
				terminal.sendInput("E");
				// 等最终帧。
				await renderAndFlush(tui, terminal);

				// A恰按先后收到a/A。
				assert.deepStrictEqual(a.inputs, ["a", "A"]);
				// B只收b。
				assert.deepStrictEqual(b.inputs, ["b"]);
				// C只收c。
				assert.deepStrictEqual(c.inputs, ["c"]);
				// editor收e/E。
				assert.deepStrictEqual(editor.inputs, ["e", "E"]);
				// 最后editor true。
				assert.strictEqual(editor.focused, true);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// 显式unfocus({target:null})选择无焦点，不能因仍可见而自动恢复浮层；对象选项区别于完全省略参数。
		it("explicit null unfocus target clears focus without restoring overlays", async () => {
			// 内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 唯一浮层。
			const overlay = new FocusableOverlay(["OVERLAY"]);
			// 空基础。
			tui.addChild(new EmptyContent());
			// 启动。
			tui.start();
			// 保护显式空目标。
			try {
				// show捕获浮层。
				const handle = tui.showOverlay(overlay);
				// target字段明确存在且为null，清焦点/恢复资格。
				handle.unfocus({ target: null });
				// 送x应无组件接收。
				terminal.sendInput("x");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 浮层未收x。
				assert.deepStrictEqual(overlay.inputs, []);
				// 句柄不聚焦。
				assert.strictEqual(handle.isFocused(), false);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// A/B/C先后创建，之后focus A再B，隐藏B应按最新focusOrder回A，不能只按插入索引回C。
		it("hiding focused overlay falls back to next visual-frontmost overlay", async () => {
			// 内存屏。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 基础editor。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 先建A。
			const a = new FocusableOverlay(["A"]);
			// 中间B。
			const b = new FocusableOverlay(["B"]);
			// 最后C。
			const c = new FocusableOverlay(["C"]);
			// 空基础。
			tui.addChild(new EmptyContent());
			// 初始editor。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护顺序变化/隐藏。
			try {
				// 显示默认捕获浮层 A。
				const aHandle = tui.showOverlay(a);
				// 显示默认捕获浮层 B。
				const bHandle = tui.showOverlay(b);
				// show C，此刻C最前。
				tui.showOverlay(c);
				// focus A更新它的序号到C之后。
				aHandle.focus();
				// focus B再前置，视觉次序此刻C/A/B。
				bHandle.focus();
				// 临时隐藏当前B，筛掉自己后最高可见捕获序号是A。
				bHandle.setHidden(true);
				// x交新焦点A。
				terminal.sendInput("x");
				// 等帧。
				await renderAndFlush(tui, terminal);
				// A日志[x]。
				assert.deepStrictEqual(a.inputs, ["x"]);
				// C无输入，说明不是按最后创建者回退。
				assert.deepStrictEqual(c.inputs, []);
				// A 的焦点标志为 true。
				assert.strictEqual(a.focused, true);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});
	});

	// 渲染顺序用相同行列/宽度1重叠字母，直接看虚拟屏左上格；这些静态组件无focused字段仍可作为焦点引用。
	describe("rendering order", () => {
		// A已是键盘焦点后再创建被动C会遮住A，但再次focus A仍应提升它的视觉序号；焦点相同不能直接跳过。
		it("focus() on already-focused overlay bumps visual order", async () => {
			// 20×6小内存屏，左上格用于视觉断言。
			const terminal = new VirtualTerminal(20, 6);
			// 主屏实例。
			const tui: TUI = new TuiMainScreen(terminal);
			// 准备基础editor焦点。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 空内容避免背景干扰。
			tui.addChild(new EmptyContent());
			// 设editor初始焦点。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护重叠顺序。
			try {
				// A静态一字，row/col为零基左上、width1，被动show保存句柄。
				const aHandle = tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				// B同格后插入，初始视觉序号更高。
				tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				// focus A使其获得键盘引用并视觉前置，虽不实现Focusable字段。
				aHandle.focus();
				// 再创建被动C提升自己的初始视觉序号，但不改变A键盘焦点。
				tui.showOverlay(new StaticOverlay(["C"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				// 等待完整合成/模拟器写入。
				await renderAndFlush(tui, terminal);
				// 读取视口首行第一个UTF-16字符，此例ASCII对应第0终端格，要求C覆盖A。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "C");
				// 再次focus已经聚焦的A，仍需增加focusOrder。
				aHandle.focus();
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 同格现在A，证明视觉顺序更新。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "A");
				// 句柄仍报告A是当前焦点，视觉变化并非先失焦再换另一组件。
				assert.strictEqual(aHandle.isFocused(), true);
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// 未发生任何显式focus轮换时，初始focusOrder等于创建先后，后创建B覆盖同位置A；只验证这一重叠格。
		it("default rendering order for overlapping overlays follows creation order", async () => {
			// 20×6内存屏。
			const terminal = new VirtualTerminal(20, 6);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 空基础。
			tui.addChild(new EmptyContent());
			// 启动。
			tui.start();
			// 保护浮层合成。
			try {
				// 先show被动A到左上格。
				tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				// 再show同位置被动B。
				tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 可选链避免缺首行直接TypeError，但strictEqual仍要求结果是B。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "B");
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// 低层A显式focus后应画到后创建B上面；先观察B再观察A，避免只检查最终字符。
		it("focus() on lower overlay renders it on top", async () => {
			// 小内存屏。
			const terminal = new VirtualTerminal(20, 6);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 空内容。
			tui.addChild(new EmptyContent());
			// 启动。
			tui.start();
			// 保护绘制顺序变化。
			try {
				// 先show A保存句柄lower，布局左上1列。
				const lower = tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				// 再show同格B，都是被动层。
				tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 初始B应在前。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "B");
				// 显式focus A提升序号并设键盘引用。
				lower.focus();
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 左上格变A。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "A");
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// 中层B前置再移除，其他A/C相对顺序要保留；例视口变化C→B→C→A，hide不是只暂藏。
		it("focusing middle overlay places it on top while preserving others relative order", async () => {
			// 小内存屏。
			const terminal = new VirtualTerminal(20, 6);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 空基础。
			tui.addChild(new EmptyContent());
			// 启动。
			tui.start();
			// 保护多轮合成。
			try {
				// 最早A，同格宽1。
				tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				// 中间B保存middle句柄。
				const middle = tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				// 最后C保存top句柄；top只是变量名，之后B可被前置。
				const top = tui.showOverlay(new StaticOverlay(["C"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 初始最高C。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "C");
				// focus中层B提升到最高，不改变插入栈其他条目次序。
				middle.focus();
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 当前B覆盖。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "B");
				// 永久删B。
				middle.hide();
				// 等帧。
				await renderAndFlush(tui, terminal);
				// C仍高于A，没有因B提升/移除而翻转。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "C");
				// 再永久删C。
				top.hide();
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 只剩A。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "A");
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// 捕获层B暂藏后出现新被动C，再unhide B会自动聚焦并提升序号，视觉恢复到C之上。
		it("capturing overlay hidden and shown again renders on top after unhide", async () => {
			// 小内存屏。
			const terminal = new VirtualTerminal(20, 6);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 空基础。
			tui.addChild(new EmptyContent());
			// 启动。
			tui.start();
			// 保护隐藏/重显。
			try {
				// 先show被动A。
				tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				// show默认捕获B，静态组件虽无focused字段也会成为焦点引用。
				const capturing = tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1 });
				// 等帧。
				await renderAndFlush(tui, terminal);
				// B覆盖A。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "B");
				// 临时隐藏B，条目保留但清其恢复资格。
				capturing.setHidden(true);
				// 新增同格被动C，其视觉序号高于旧B。
				tui.showOverlay(new StaticOverlay(["C"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				// 等帧。
				await renderAndFlush(tui, terminal);
				// C当前在前。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "C");
				// 捕获B显式重显时更新序号并自动聚焦，非被动层重显的规则。
				capturing.setHidden(false);
				// 等帧。
				await renderAndFlush(tui, terminal);
				// B重新盖在C上。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "B");
				// 清理。
			} finally {
				// 停止本例虚拟 TUI。
				tui.stop();
			}
		});

		// unfocus只改键盘恢复状态，不降低视觉序号；例B→focus A→unfocus A仍A→focus B才B。
		it("unfocus() does not change visual order until another overlay is focused", async () => {
			// 小内存屏。
			const terminal = new VirtualTerminal(20, 6);
			// 主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 基础editor用于释放焦点后的回退，画面未依赖它。
			const editor = new FocusableOverlay(["EDITOR"]);
			// 空基础。
			tui.addChild(new EmptyContent());
			// 初始editor焦点。
			tui.setFocus(editor);
			// 启动。
			tui.start();
			// 保护焦点与视觉分离场景。
			try {
				// 先show被动A，preFocus editor。
				const a = tui.showOverlay(new StaticOverlay(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				// 再show被动B，preFocus仍editor。
				const b = tui.showOverlay(new StaticOverlay(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 初始B覆盖。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "B");
				// focus A同时提升视觉顺序。
				a.focus();
				// 等帧。
				await renderAndFlush(tui, terminal);
				// A覆盖。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "A");
				// 释放A回editor，但没有修改A的focusOrder或移除条目。
				a.unfocus();
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 视觉仍A；此断言检查字母，没有额外读editor.focused。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "A");
				// 显式focus B才再次提升B。
				b.focus();
				// 等帧。
				await renderAndFlush(tui, terminal);
				// 当前B覆盖A。
				assert.strictEqual(terminal.getViewport()[0]?.charAt(0), "B");
				// 清理。
			} finally {
				// stop虚拟TUI。
				tui.stop();
			}
		});
	});
});
