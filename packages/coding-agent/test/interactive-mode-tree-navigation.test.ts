// 验证树导航在对话框/取消等待期间重新检查忙碌状态；五例只驱动原型回调，导航/摘要/取消均是假会话方法。
// Container保存内存组件，不连接真实TTY；选择器本身真实构造，测试直接调用其onSelect而不模拟按键。
import { Container } from "@earendil-works/pi-tui";
// 导入每例主题初始化、参数化测试、断言与spy；it.each的两项各算一例。
import { beforeEach, describe, expect, it, vi } from "vitest";
// 使用真实SessionManager.inMemory造两节点历史，不创建或修改会话文件。
import { SessionManager } from "../src/core/session-manager.ts";
// 内存SettingsManager提供真实默认设置读取，不读写用户settings文件。
import { SettingsManager } from "../src/core/settings-manager.ts";
// StatusIndicator仅类型导入，供清理替身的参数签名，JS运行时擦除。
import type { StatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
// TreeSelectorComponent只作类型，实际构造由showTreeSelector里的运行时导入负责。
import type { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
// 借用InteractiveMode.prototype.showTreeSelector，测试不new完整交互模式。
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
// 初始化全局dark供真实选择器取色；默认不watch，冷tmux能力查询由测试命令PI_HYPERLINKS=0短路。
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
// 两个消息助手只构造数据和当前时间，不调用utilities中其他真实认证或模型会话助手。
import { assistantMsg, userMsg } from "./utilities.ts";

// 固定忙碌文案供假navigateTree报错和断言比较，不表示这里开启了实际压缩任务。
const busyMessage = "Wait for the current compaction or tree navigation to finish before navigating the session tree.";

// 创建内存两节点历史、假UI/会话并借真实方法构造树选择器，返回上下文、原Escape、目标id和select入口。
// 例：先将isStreaming设true再select，可观察取消与忙碌二次检查；不实际切换树叶、调用模型或复制剪贴板。
function createTreeUI() {
	// persist=false的内存会话仍生成id/时间和索引，但不会建立会话目录。
	const sessionManager = SessionManager.inMemory();
	// 追加first用户消息并保存它的树条目id，后面选择它而非当前助手叶子。
	const targetId = sessionManager.appendMessage(userMsg("first"));
	// 追加reply助手为当前叶子，确保目标用户条目不同于当前叶子，不走“已在此处”的早返。
	sessionManager.appendMessage(assistantMsg("reply"));
	// let可稍后赋值，联合允许未构造选择器；类型不会在此创建实例。
	let selector: TreeSelectorComponent | undefined;
	// 保存一个原Escape spy，用引用相等断言确认忙碌拒绝没有替换它。
	const onEscape = vi.fn();
	// 假对象只实现当前回调需要的能力，实际会话状态机和TUI都被隔离。
	const ui = {
		// 属性简写保留真实内存SessionManager，用于getTree/getLeafId；navigateTree spy不会改它的叶子。
		sessionManager,
		// 新建真实内存设置，默认仍会询问是否摘要，不扫描项目配置。
		settingsManager: SettingsManager.inMemory(),
		// session是普通对象，忙碌标志由各例主动改，不是真实AgentSession事件。
		session: {
			// 初始不在流式；个别用例设true制造需要取消的状态。
			isStreaming: false,
			// 初始不在压缩/导航忙碌；对话框或abort替身可以再把它改true。
			isCompacting: false,
			// async abort替身只改变内存标志并兑现Promise，不停止真实模型或进程。
			abort: vi.fn(async () => {
				// 把同一ui对象的流式开关改false，供导航spy内部检查先后关系。
				ui.session.isStreaming = false;
			}),
			// 分支摘要取消只记录调用，本文件不会真实创建摘要请求。
			abortBranchSummary: vi.fn(),
			// navigateTree是受控async函数，模拟忙碌拒绝和成功结果，不真正改变SessionManager。
			navigateTree: vi.fn(async () => {
				// 若误走到忙碌导航就抛固定错误；前置门禁测试还会要求它根本未调用，避免仅靠catch掩盖。
				if (ui.session.isCompacting) throw new Error(busyMessage);
				// 未忙时兑现cancelled:false；这是普通对象，不等于已产生真实导航副作用。
				return { cancelled: false };
			}),
		},
		// 保存原onEscape到defaultEditor，后续检查是否被摘要逻辑不当替换。
		defaultEditor: { onEscape },
		// getText固定空串、setText只记调用，不需要真实Editor或提交回调。
		editor: { getText: () => "", setText: vi.fn() },
		// 聊天容器是真实内存组件集合，清空不发送终端命令。
		chatContainer: new Container(),
		// 该标志保留上下文形状；showTreeSelector没有调用真实init来检查或启动界面。
		isInitialized: true,
		// 页脚失效只用spy，不读真实用量或模型目录。
		footer: { invalidate: vi.fn() },
		// 固定24行用于选择器页长，setProgress/requestRender都是记录器，不访问TTY。
		ui: { terminal: { rows: 24, setProgress: vi.fn() }, requestRender: vi.fn() },
		// showSelector替身同步运行组件工厂并保存选择器，不启动真实UI挂载或输入路由。
		showSelector: (
			// 工厂接done关闭回调，返回component和focus；这个类型不负责真的切焦点。
			create: (done: () => void) => { component: TreeSelectorComponent; focus: TreeSelectorComponent },
			// 箭头块在宿主调用showSelector时执行，没有独立异步调度。
		) => {
			// 传空done spy构造真实选择器，仅保存component；focus返回值被这份替身忽略。
			selector = create(vi.fn()).component;
		},
		// 摘要选择默认兑现No summary，测试可覆写它来模拟对话框期间状态变化，不显示真实对话框。
		showExtensionSelector: vi.fn(async () => "No summary"),
		// Dispose newly created indicators so a failing regression cannot leak spinner timers.
		// 若回归意外创建指示器，立刻dispose停止其Loader计时器；这是测试清理，不取消业务。
		showStatusIndicator: vi.fn((indicator: StatusIndicator) => indicator.dispose()),
		// 状态清理本身用spy，便于断言忙碌拒绝没有动另一任务的显示。
		clearStatusIndicator: vi.fn(),
		// 队列回填只记调用，不读取或修改真实编辑器/Session队列。
		restoreQueuedMessagesToEditor: vi.fn(),
		// 重画历史入口是spy，不重新构建完整聊天界面。
		renderInitialMessages: vi.fn(),
		// 状态提示只记调用，成功回调可用，不输出shell。
		showStatus: vi.fn(),
		// 错误提示用于观察固定忙碌拒绝，不依赖真正错误组件。
		showError: vi.fn(),
		// async空队列刷新只返回兑现Promise，真实回调用void发起它，本测试不覆盖后台刷新细节。
		flushCompactionQueue: vi.fn(async () => {}),
	};
	// Reflect.get借私有方法，as函数类型声明this为假对象；不校验形状或修改类访问规则。
	const showTreeSelector = Reflect.get(InteractiveMode.prototype, "showTreeSelector") as (this: typeof ui) => void;
	// .call以ui作this同步构造选择器并安装async onSelect，尚未开始导航。
	showTreeSelector.call(ui);

	// 返回这些已有对象/函数引用，调用方可以改ui标志，不是深拷贝快照。
	return {
		// ui属性简写暴露本次独立的假上下文。
		ui,
		// 暴露原Escape函数引用供后续toBe比较。
		onEscape,
		// 暴露第一条用户消息的树id作为选择目标。
		targetId,
		// async方法模拟选择此目标并等待onSelect实际返回值；回调类型声明void不擦除真实async Promise。
		async select() {
			// 先要求selector非undefined；此断言不在TS中自动把闭包变量永久收窄。
			expect(selector).toBeDefined();
			// 两个!都是TS非空断言，运行时没有校验；真实非空树构造应装好onSelect，否则这里会抛错，不是可选调用。
			await selector!.getTreeList().onSelect!(targetId);
		},
	};
}

// 注册两项参数化忙碌测试和三项普通测试，共五例；不运行真实压缩或生成分支摘要。
describe("InteractiveMode tree navigation availability", () => {
	// 每例准备dark共享主题；首次可读包内资源，不启动主题watch或真实终端。
	beforeEach(() => initTheme("dark"));

	// Regression for #9178 / PR #9179: rejection must not replace the active operation's UI.
	// 两种摘要选择都在对话框内变忙时拒绝，并保留原操作的Escape/状态；%s只是测试名称参数。
	it.each(["Summarize", "No summary"])("preserves operation UI when choosing %s while busy", async (choice) => {
		// 每轮新建独立的两节点历史、选择器和spies，避免上轮标志残留。
		const { ui, onEscape, select } = createTreeUI();
		// 保存原助手叶子id，之后检查这条拒绝路径未改SessionManager叶子。
		const originalLeafId = ui.sessionManager.getLeafId();
		// 覆写摘要对话框替身，在它兑现选择前人为改变忙碌标志。
		ui.showExtensionSelector.mockImplementation(async () => {
			// Compaction or another navigation can start while the dialog is open.
			// 只设置isCompacting=true模拟对话框期间另一个操作开始，不触发真正压缩。
			ui.session.isCompacting = true;
			// 返回本轮Summarize或No summary，两者都应在后面的新状态检查拒绝。
			return choice;
		});

		// 等待真实async选择回调完成，包括对假摘要选择Promise的await。
		await select();

		// 要求忙碌文案至少出现一次，不核所有错误文本或精确次数。
		expect(ui.showError).toHaveBeenCalledWith(busyMessage);
		// 连摘要指示器都不应新建，避免覆盖当前操作的显示。
		expect(ui.showStatusIndicator).not.toHaveBeenCalled();
		// 也不能清掉另一任务已有的状态指示器；这里只观察清理入口未调用。
		expect(ui.clearStatusIndicator).not.toHaveBeenCalled();
		// toBe按对象身份确认Escape仍是原函数，不只是函数名或行为相似。
		expect(ui.defaultEditor.onEscape).toBe(onEscape);
		// 关键是navigateTree完全未调用，不把其内部抛错被catch当作正确前置拒绝。
		expect(ui.session.navigateTree).not.toHaveBeenCalled();
		// 本轮isStreaming初始false，拒绝不应额外请求abort。
		expect(ui.session.abort).not.toHaveBeenCalled();
		// 真实内存叶子id不变；由于导航是spy，这不独立证明真实navigateTree的原子性。
		expect(ui.sessionManager.getLeafId()).toBe(originalLeafId);
	});

	// 对话框打开时忙、选择兑现前变空闲应允许调用导航；入口没有一次性记死最初状态。
	it("allows navigation when compaction finishes while the dialog is open", async () => {
		// 从新上下文取目标用户id和选择入口。
		const { ui, targetId, select } = createTreeUI();
		// 先设压缩中，模拟弹框打开前已有忙碌状态。
		ui.session.isCompacting = true;
		// 在选择回调里模拟那个任务已经结束。
		ui.showExtensionSelector.mockImplementation(async () => {
			// 只把内存isCompacting改false，不实际完成模型或清理压缩资源。
			ui.session.isCompacting = false;
			// 返回No summary，不创建分支摘要指示器或请求摘要。
			return "No summary";
		});

		// 等待真实选择处理按最新false继续到假navigateTree。
		await select();

		// 要求向导航入口传目标id和这份选项；不检查真实叶子被移动。
		expect(ui.session.navigateTree).toHaveBeenCalledWith(targetId, {
			// 无摘要选择应传summarize:false。
			summarize: false,
			// 未给自定义说明，但选项对象明确含值为undefined的customInstructions字段。
			customInstructions: undefined,
		});
		// 当前成功样本未调用showError，不证明所有后台任务都成功。
		expect(ui.showError).not.toHaveBeenCalled();
	});

	// 流式标志为true时，先回填队列并等待abort，再调用导航；用导航spy内断言核到达时状态。
	it("still aborts an active response before navigating", async () => {
		// 创建新上下文，默认摘要选择仍No summary。
		const { ui, select } = createTreeUI();
		// 手动标记正在流式，不真正启动Agent。
		ui.session.isStreaming = true;
		// 覆写导航实现，在被调用的时刻验证先前取消/回填已发生。
		ui.session.navigateTree.mockImplementation(async () => {
			// 到达导航时isStreaming须已由abort替身改false，验证本例的等待顺序而非真实模型停止。
			expect(ui.session.isStreaming).toBe(false);
			// 队列回填入口到这时恰调用一次；它只是spy，没有检查真实待发消息内容。
			expect(ui.restoreQueuedMessagesToEditor).toHaveBeenCalledOnce();
			// 随后兑现假成功结果，不切换实际历史叶子。
			return { cancelled: false };
		});

		// 等待整个本次选择回调，内部会await取消及导航替身。
		await select();

		// 要求取消入口恰一次，未验证真实AgentSession.abort实现。
		expect(ui.session.abort).toHaveBeenCalledOnce();
		// 要求导航入口恰一次；前面的内部断言已约束到达时取消标志。
		expect(ui.session.navigateTree).toHaveBeenCalledOnce();
		// 此成功样本没有showError调用。
		expect(ui.showError).not.toHaveBeenCalled();
	});

	// abort等待期间又变忙时须重新拒绝，不能在取消前检查一次就覆盖别的操作UI。
	it("rechecks availability after the response abort settles", async () => {
		// 新建上下文并保留原Escape引用用于拒绝后的身份比较。
		const { ui, onEscape, select } = createTreeUI();
		// 手动打开流式标志，强制选择处理进入abort等待。
		ui.session.isStreaming = true;
		// 摘要选择固定Summarize；后续拒绝应发生在创建摘要指示器之前。
		ui.showExtensionSelector.mockResolvedValue("Summarize");
		// 重写abort替身，用其async返回Promise边界模拟状态在等待期间变化。
		ui.session.abort.mockImplementation(async () => {
			// 先模拟流式响应已结束。
			ui.session.isStreaming = false;
			// 再模拟另一个压缩/导航任务已开始，不调用真实压缩方法。
			ui.session.isCompacting = true;
		});

		// 等待真实选择回调先await abort再重新读取isCompacting。
		await select();

		// 确认确实经过一次abort，而不是在最初标志处直接拒绝。
		expect(ui.session.abort).toHaveBeenCalledOnce();
		// 新忙碌状态要显示固定拒绝文案。
		expect(ui.showError).toHaveBeenCalledWith(busyMessage);
		// 摘要指示器不能创建，避免替换新任务显示。
		expect(ui.showStatusIndicator).not.toHaveBeenCalled();
		// 也不能清理新任务的指示器；未触发摘要分支的finally清理。
		expect(ui.clearStatusIndicator).not.toHaveBeenCalled();
		// 原Escape函数引用保持不变，不只是其调用次数为0。
		expect(ui.defaultEditor.onEscape).toBe(onEscape);
		// navigateTree完全未被调用，证明此样本在委托之前完成二次忙碌检查。
		expect(ui.session.navigateTree).not.toHaveBeenCalled();
	});
});
