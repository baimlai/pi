// 验证启动早期输入恢复、空闲输入暂存和FIFO取值；只用原型方法与内存替身，不执行真实工具准备或模型。
// 导入Vitest分组、断言及vi.fn，后者记录调用并可提供替身实现。
import { describe, expect, it, vi } from "vitest";
// 导入真实交互类取得原型；这些用例不new它，避开构造/初始化的终端、资源和观察器行为。
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// 正式提交回调所需的最小上下文；type只描述类型，不创建对象或校验运行时数据。
type SubmitContext = {
	// onSubmit?表示安装前可没有回调；声明返回void并不保证具体函数不会实际返回Promise。
	defaultEditor: { onSubmit?: (text: string) => void };
	// 当前editor与defaultEditor分开：前者提供编辑/历史能力，后者保存被安装的提交入口。
	editor: {
		// 历史能力可缺省；真实代码用可选调用，不要求所有扩展编辑器都有这个方法。
		addToHistory?: (text: string) => void;
		// setText是接收文字、返回void的函数属性；此签名不负责清理编辑区。
		setText: (text: string) => void;
	};
	// 会话替身只提供本例会读的忙碌标志和prompt入口，不是AgentSession实例。
	session: {
		// 压缩中会走压缩队列分支；本例会设false选择普通输入路径。
		isCompacting: boolean;
		// 流式忙碌时会走steer路径；本例设false，不触发模型或Session队列。
		isStreaming: boolean;
		// Bash运行标志供叹号命令分支使用；普通early prompt不进入该分支。
		isBashRunning: boolean;
		// prompt返回Promise<void>；options?: unknown不在测试类型里细化选项，也不进行参数验证。
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	// 同步清理待展示Bash组件的入口，此处仅用spy记录普通提交前是否调用。
	flushPendingBashComponents: () => void;
	// 可选单一输入回调代表主循环已在等输入；缺省时提交会放入下面的本地数组。
	onInputCallback?: (text: string) => void;
	// 字符串数组是UI空闲输入FIFO，和Session的steering/follow-up队列不同。
	pendingUserInputs: string[];
};

// getUserInput单独所需的两字段类型；已有输入时不必提供整套编辑器/会话。
type InputContext = {
	// 已有等待回调时字段存函数，未安装时读得undefined；类型不会自动初始化。
	onInputCallback?: (text: string) => void;
	// 待取输入按数组头部shift，测试也会检查这个数组被消费。
	pendingUserInputs: string[];
};

// 启动尚未完成的提交入口只需要编辑区和状态提示，结果不发送到会话。
type StartupSubmitContext = {
	// setText替身用于检查早期提交的原文被放回编辑区，而非丢弃或排队。
	editor: { setText: (text: string) => void };
	// 状态提示替身只记录message，不创建聊天组件或输出到shell。
	showStatus: (message: string) => void;
};

// 给私有/公开原型方法列出本测试使用的签名，避免把假对象当完整InteractiveMode。
type InteractiveModePrivate = {
	// this是仅供类型检查的接收者参数，.call(context,text)中text才是普通实参。
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	// setup本身同步安装提交函数并返回void；不代表被安装的async函数也是同步完成。
	setupEditorSubmitHandler(this: SubmitContext): void;
	// getUserInput返回Promise<string>，即使本地已有输入也通过async返回已兑现的Promise。
	getUserInput(this: InputContext): Promise<string>;
};

// 双重as只让TS接受测试侧的私有方法视图，不复制原型、不绑定this、不提供运行时校验。
const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

// 创建每例独立的空闲提交上下文，返回假对象；例如安装回调后提交普通文字，应该进入pendingUserInputs。
// vi.fn只记录内存调用；prompt的async空实现不调用真实模型，工厂本身也不执行提交。
function createSubmitContext(): SubmitContext {
	// 返回全新对象，下方的编辑器、会话和队列不会沿用上一例状态。
	return {
		// 开始时没有onSubmit，由真实setupEditorSubmitHandler稍后赋值。
		defaultEditor: {},
		// 另建editor能力对象，用于记录历史与文本操作。
		editor: {
			// 无实现的vi.fn记录参数并返回undefined，便于之后检查历史条目。
			addToHistory: vi.fn(),
			// 这里只记录setText调用，不模拟真正编辑器的内容、光标或提交清空。
			setText: vi.fn(),
		},
		// 会话三个忙碌开关都为false，使普通输入进入主循环等待/FIFO逻辑。
		session: {
			// 不在压缩中，因此不需要压缩队列或扩展命令识别能力。
			isCompacting: false,
			// 没有正在运行的流，因此不会调用带steer选项的prompt。
			isStreaming: false,
			// 没有Bash任务；本例文字本身也不带!，不会执行系统命令。
			isBashRunning: false,
			// async空函数返回兑现Promise<void>；这里只作为未使用的会话入口，不代表测试跑过模型。
			prompt: vi.fn(async () => {}),
		},
		// spy用于确认普通输入先刷出待展示Bash组件，实际不会创建或移动组件。
		flushPendingBashComponents: vi.fn(),
		// 从空FIFO开始，也没有onInputCallback字段，之后应走push分支。
		pendingUserInputs: [],
	};
}

// 分组注册三条启动输入回归：早期恢复、无等待者暂存、已有队列优先取值。
describe("InteractiveMode startup input", () => {
	// 直接调用启动保护方法，验证原文回填和固定提示；未实际启动托管工具安装过程。
	it("restores a prompt submitted while managed-tool setup is running", () => {
		// 用显式类型检查本例两个必要能力，仍只创建普通对象。
		const context: StartupSubmitContext = {
			// setText spy收集回填文字，不维护真实编辑器状态。
			editor: { setText: vi.fn() },
			// showStatus spy收集提示，不依赖全局主题或TUI。
			showStatus: vi.fn(),
		};

		// 以.call指定this并传early prompt；方法同步调用上面的两项能力。
		interactiveModePrototype.handleStartupSubmit.call(context, "early prompt");

		// 要求至少一次以原文字调用setText；不是检查最终编辑器字符串或精确一次调用。
		expect(context.editor.setText).toHaveBeenCalledWith("early prompt");
		// 要求显示启动中固定提示；不推断输入已排队或会在启动完成后自动发送。
		expect(context.showStatus).toHaveBeenCalledWith("Startup is still in progress");
	});

	// 安装正式回调后，在无等待者的空闲状态提交带空白文字；检查trim、队列和历史。
	it("queues a normal prompt submitted before the input callback is installed", async () => {
		// 每例创建新上下文，初始pendingUserInputs为空且无onInputCallback。
		const context = createSubmitContext();
		// 同步安装真实async onSubmit；此行只安装，不提交或调用prompt。
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		// ?.只在回调存在时调用；await实际得到的返回值会等真实async回调，void签名不擦除运行时Promise。
		await context.defaultEditor.onSubmit?.(" early prompt ");

		// 深比较整个数组恰为一条去两端空白后的文字；不涉及Session内部的插话队列。
		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		// 要求刷出待Bash组件入口恰调用一次；这个spy本身不执行Bash。
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		// 要求历史收到整理后的文字；本例没有进一步断言prompt的调用次数或真实编辑器是否清空。
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	// 有FIFO条目时应直接返回并消费它，不安装新的等待回调；无需构造完整会话。
	it("returns queued startup input before installing a new input callback", async () => {
		// 最小InputContext只含队列，初始onInputCallback为缺省undefined。
		const context: InputContext = {
			// 放一条固定待取问题；不是从磁盘会话恢复的消息。
			pendingUserInputs: ["queued prompt"],
		};

		// resolves等待Promise兑现再按toBe比较字符串，外层await也等待异步断言完成。
		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		// 确认没有安装新的等待回调，说明已有输入优先于登记等待者。
		expect(context.onInputCallback).toBeUndefined();
		// 深比较空数组，确认shift已消费这一条；不覆盖多等待者、取消或多条顺序情况。
		expect(context.pendingUserInputs).toEqual([]);
	});
});
