// 用真实原型方法测试导入命令的路径提取与UI委托，共六例；实际导入、确认、状态和致命错误处理均用内存替身，不读取样本JSONL文件。
// Vitest提供分组、断言和vi.fn调用记录；测试标题中的文件不存在由手动抛错误模拟，不代表测试访问了真实磁盘。
import { describe, expect, it, vi } from "vitest";
// 导入真正的错误类供instanceof分支识别；new该错误只拼消息并保存路径，不检查文件是否存在。
import { SessionImportFileNotFoundError } from "../src/core/agent-session-runtime.ts";
// 导入真实InteractiveMode以取得prototype；后面不new完整交互模式，不启动终端或真实RuntimeHost。
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// 两个字符串字面量组成联合类型，开发时限制允许的命令；类型本身不解析输入，也不会在运行时验证字符串。
type PathCommand = "/export" | "/import";

// 为私有原型成员声明测试侧视图，不重写实现，也不把最小假上下文当完整InteractiveMode。
type InteractiveModePrototype = {
	// this:unknown是仅供TS检查的接收者参数，不占普通实参；真实路径助手不读this，输入命令文字和命令名后返回首路径或undefined。
	getPathCommandArgument(this: unknown, text: string, command: PathCommand): string | undefined;
	// 导入命令借用下面假上下文作this，接整条文字并返回Promise<void>；await等待包括确认/导入替身的异步链。
	handleImportCommand(this: ImportCommandContext, text: string): Promise<void>;
};

// 列出测试假上下文的字段契约；各签名约束编译期形状，不自动生成真实会话、UI或文件服务。
type ImportCommandContext = {
	// 无参数清状态入口返回void，下面用spy记录是否调用，不销毁真实状态组件。
	clearStatusIndicator: () => void;
	// 假runtimeHost只需导入函数：接路径和可省cwd覆盖，兑现含cancelled布尔的对象；这份接口不包含真实导入实现。
	runtimeHost: { importFromJsonl: (inputPath: string, cwdOverride?: string) => Promise<{ cancelled: boolean }> };
	// 错误反馈接字符串，当前测试只检查调用记录，不渲染错误组件。
	showError: (message: string) => void;
	// 状态反馈也只接文字；成功文案不能代替新会话文件存在性检查。
	showStatus: (message: string) => void;
	// 确认入口接标题和问题，返回Promise<boolean>；本文件固定兑现true，不真的显示对话框。
	showExtensionConfirm: (title: string, message: string) => Promise<boolean>;
	// 保留会话重绑的异步能力以满足测试类型；当前handleImportCommand没有直接调用它，真实RuntimeHost被替换。
	handleRuntimeSessionChange: () => Promise<void>;
	// UI重建入口的同步签名，仅补齐假对象形状，当前用例不证明真实界面重绘。
	renderCurrentSessionState: () => void;
	// unknown允许任意抛出值；Promise<never>表示不会正常兑现一个返回值，async替身靠throw拒绝Promise，不是真的退出进程。
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	// 缺工作目录时可异步返回选定路径或undefined取消；这些测试未制造MissingSessionCwdError，因此不覆盖该重试流程。
	promptForMissingSessionCwd: (error: unknown) => Promise<string | undefined>;
	// 上下文也须提供路径提取函数，后面直接借真实方法；PathCommand只在TS中限制第二个参数。
	getPathCommandArgument: (text: string, command: PathCommand) => string | undefined;
};

// 先as unknown再as测试视图，绕过私有成员的静态访问限制；两次断言不检查成员是否存在、不改变函数或绑定this。
const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

// 注册三条纯字符串解析测试和三条原型导入委托测试；不调用CLI或真实导入服务。
describe("InteractiveMode /import parsing", () => {
	// 双引号样本：无空格及带空格的路径都应去掉最外侧这对引号；只覆盖双引号，不测试单引号、转义、未闭引号或多参数。
	it("strips quotes from /import path arguments", () => {
		// 直接调用原型路径助手：它不依赖接收者状态；/import后第一普通空格是命令边界，首字符为双引号时取首个同类闭引号前内容。
		expect(interactiveModePrototype.getPathCommandArgument('/import "path/to/session.jsonl"', "/import")).toBe(
			// 预期仅路径正文，不带外层双引号；toBe对字符串作精确值比较，不验证文件格式或路径存在。
			"path/to/session.jsonl",
		);
		// 开始第二次expect，把带内部空格的输入交同一个真实助手。
		expect(
			// 外层单引号是TS字符串语法，里面双引号才是命令实际收到的路径引号；空格保留在路径内，不按shell分词。
			interactiveModePrototype.getPathCommandArgument('/import "path with spaces/session.jsonl"', "/import"),
			// 精确要求路径内部空格保留；助手只剥这对引号，不做变量展开、反斜杠解码或文件访问。
		).toBe("path with spaces/session.jsonl");
	});

	// 未引用的john单引号s路径应原样保留；单引号出现在参数中间，不是首字符，所以不会进入引号包裹分支。
	it("preserves apostrophes in unquoted /import path arguments", () => {
		// 传入普通路径john单引号s/session.jsonl；真实助手只在未引用参数的第一个空白处截断，这里无空白。
		expect(interactiveModePrototype.getPathCommandArgument("/import john's/session.jsonl", "/import")).toBe(
			// 要求内部单引号仍在，防把所有引号字符全局删除；字符串的外层双引号不属于实际路径。
			"john's/session.jsonl",
		);
	});

	// 命令边界样本：/important不能当/import，/exporter不能当/export，真正的/import加空格才可提取路径；只覆盖这三个固定输入。
	it("enforces command token boundaries", () => {
		// 虽然文字以/import这几个字符开头，但紧接的是ant而非普通空格，助手应拒绝这个命令前缀。
		expect(interactiveModePrototype.getPathCommandArgument("/important /tmp/session.jsonl", "/import")).toBe(
			// 预期undefined表示未提取到参数，不是字符串undefined或空路径。
			undefined,
		);
		// 第二条用/exporter对照同样的命令边界规则；不执行HTML导出或创建out.html。
		expect(interactiveModePrototype.getPathCommandArgument("/exporter out.html", "/export")).toBe(undefined);
		// 第三条真正以/import和空格起头，应保留后面的绝对路径文字。
		expect(interactiveModePrototype.getPathCommandArgument("/import /tmp/session.jsonl", "/import")).toBe(
			// 精确期望/tmp/session.jsonl，只证明字符串提取，没有检查该路径存在。
			"/tmp/session.jsonl",
		);
	});

	// 成功委托例：对带引号的路径先确认，再将去引号结果交假importFromJsonl，最终显示成功；不覆盖真实复制、切会话或重绑。
	it("passes unquoted path to runtimeHost.importFromJsonl", async () => {
		// vi.fn记录导入参数；async箭头的括号包住对象表达式，每次兑现cancelled:false，不读取或写入JSONL。
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		// 确认替身总兑现true，跳过真实交互；这例没有测试用户拒绝或取消。
		const showExtensionConfirm = vi.fn(async () => true);
		// 状态spy只记录后面显示的文字，初始无调用。
		const showStatus = vi.fn();
		// 错误spy供断言成功路径没有报告错误。
		const showError = vi.fn();

		// 用显式类型检查假上下文的字段，运行时仍是普通对象，各方法不会自动接到真实UI。
		const context: ImportCommandContext = {
			// 清状态操作用空spy，真实方法可调用它，但本例不单独断言调用次数。
			clearStatusIndicator: vi.fn(),
			// 属性简写把上面的导入spy挂在runtimeHost下，匹配真实this.runtimeHost.importFromJsonl访问。
			runtimeHost: { importFromJsonl },
			// 挂错误spy原引用，方便从外部读取它的调用记录。
			showError,
			// 挂成功状态spy，实际不会输出到终端。
			showStatus,
			// 挂确认spy，真实命令会await它兑现true。
			showExtensionConfirm,
			// 异步空重绑替身正常兑现undefined，不加载资源；当前被测方法不直接调用这个字段。
			handleRuntimeSessionChange: vi.fn(async () => {}),
			// 重画当前会话也用记录器，不创建真实组件或终端。
			renderCurrentSessionState: vi.fn(),
			// 致命处理替身如果意外运行就返回拒绝的Promise；它满足Promise<never>，用于让误入致命路径暴露为测试失败。
			handleFatalRuntimeError: vi.fn(async () => {
				// 在async函数内throw使其Promise拒绝，不触发真实fatal退出或文件清理。
				throw new Error("unexpected fatal error");
			}),
			// 缺cwd提示固定兑现undefined；本样本没有该类错误，未实际询问目录或读取用户配置。
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			// 把真实路径助手原引用放进context，之后this.getPathCommandArgument按同一解析逻辑执行，不用测试镜像。
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		// .call显式以context作this，传带引号命令；await等真实命令及两个受控Promise完成，不执行真正导入服务。
		await interactiveModePrototype.handleImportCommand.call(context, '/import "path/to/session.jsonl"');

		// 检查确认spy至少有一次收到下面这对参数；toHaveBeenCalledWith不单独限定总调用次数。
		expect(showExtensionConfirm).toHaveBeenCalledWith(
			// 标题应是固定Import session，不是路径或模型提示词。
			"Import session",
			// 问题中的路径也必须已去引号；这条只检查确认文案，不证明用户看到真实对话框。
			"Replace current session with path/to/session.jsonl?",
		);
		// 要求导入spy以一个去引号路径参数调用，不传cwd覆盖；不检查实际会话文件或工作目录。
		expect(importFromJsonl).toHaveBeenCalledWith("path/to/session.jsonl");
		// 正常假导入结果没有调用错误入口。
		expect(showError).not.toHaveBeenCalled();
		// 至少一次成功状态含去引号原输入路径；文案不表示真实导入/重绑已执行。
		expect(showStatus).toHaveBeenCalledWith("Session imported from: path/to/session.jsonl");
	});

	// 未引用内部单引号的委托例：john单引号s路径应原样传假导入并显示成功；和前面纯解析例不同，这次经过确认/命令方法。
	it("passes unquoted apostrophe path to runtimeHost.importFromJsonl unchanged", async () => {
		// 本例独立导入spy正常兑现cancelled:false，不沿用上例调用记录，也不打开路径。
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		// 本例确认仍总兑现true，不真实弹框。
		const showExtensionConfirm = vi.fn(async () => true);
		// 独立状态spy记录这次路径文案。
		const showStatus = vi.fn();
		// 独立错误spy应保持未调用。
		const showError = vi.fn();

		// 创建本例假上下文，字段含义与上个样本相同，状态和调用记录互不复用。
		const context: ImportCommandContext = {
			// 清指示器替身只记调用，无动画或定时器需要清理。
			clearStatusIndicator: vi.fn(),
			// 用属性简写挂本例导入spy，不是新建真实RuntimeHost。
			runtimeHost: { importFromJsonl },
			// 挂本例错误记录器。
			showError,
			// 挂本例状态记录器。
			showStatus,
			// 挂固定true的确认函数，真实命令会await该Promise。
			showExtensionConfirm,
			// 异步空会话变化函数仅满足最小上下文形状，当前方法不直接调用它。
			handleRuntimeSessionChange: vi.fn(async () => {}),
			// UI重建为空spy，没有真实聊天组件。
			renderCurrentSessionState: vi.fn(),
			// 意外致命路径用async抛错替身使调用拒绝，避免静默吞掉非预期失败。
			handleFatalRuntimeError: vi.fn(async () => {
				// 这里只创建普通Error并抛出；不会调用进程退出或真实fatal UI清理。
				throw new Error("unexpected fatal error");
			}),
			// 缺cwd选择固定返回undefined，当前成功样本不会走这条分支。
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			// 直接复用真实路径提取函数，内部单引号保持规则来自实际实现。
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		// 借真实导入命令并await，但接收者所有外部操作均是替身；此未引用路径中的单引号不经shell解释。
		await interactiveModePrototype.handleImportCommand.call(context, "/import john's/session.jsonl");

		// 要求至少一次导入参数精确保留john单引号s，未把单引号删除或当参数开引号。
		expect(importFromJsonl).toHaveBeenCalledWith("john's/session.jsonl");
		// 成功样本不应报告错误；未单独断言确认或UI重建次数。
		expect(showError).not.toHaveBeenCalled();
		// 成功提示同样保留内部单引号，不证明磁盘实际存在这个目录或文件。
		expect(showStatus).toHaveBeenCalledWith("Session imported from: john's/session.jsonl");
	});

	// 缺文件错误分类例：假导入手动抛专门错误，真实catch应只显示非致命消息，不能调用致命处理；不检验真正的exists/read行为。
	it("shows a non-fatal error when /import path does not exist", async () => {
		// 创建返回拒绝Promise的导入spy；函数体要等被调用时才创建并抛错误。
		const importFromJsonl = vi.fn(async () => {
			// new专门类只设置错误名、消息和filePath；在async函数中throw成为拒绝，不访问/tmp/missing-session.jsonl。
			throw new SessionImportFileNotFoundError("/tmp/missing-session.jsonl");
		});
		// 确认仍固定true，确保真实命令会进入导入try，而非因用户取消提前结束。
		const showExtensionConfirm = vi.fn(async () => true);
		// 状态spy用来确认此错误未被报成成功或取消。
		const showStatus = vi.fn();
		// 错误spy记录非致命反馈文字。
		const showError = vi.fn();
		// 独立fatal spy若被调用就拒绝；稍后还直接断言未调用，不能把抛错替身当真正退出进程。
		const handleFatalRuntimeError = vi.fn(async () => {
			// 在async回调内throw使返回Promise<never>拒绝，没有一个可正常await取得的返回值。
			throw new Error("unexpected fatal error");
		});

		// 将专门错误导入spy与其余假能力组成接收者，不实例化真实会话运行时。
		const context: ImportCommandContext = {
			// 清状态仍为空spy，本例不检查这一步的具体副作用。
			clearStatusIndicator: vi.fn(),
			// 挂会拒绝的importFromJsonl，让真实catch收到正确错误类实例。
			runtimeHost: { importFromJsonl },
			// 保留错误spy引用，后面比较完整错误文案。
			showError,
			// 保留状态spy供检查没有错误的成功提示。
			showStatus,
			// 确认函数仍接真实标题/问题参数，但仅兑现固定true。
			showExtensionConfirm,
			// 异步空重绑函数不加载资源，当前命令未直接调用。
			handleRuntimeSessionChange: vi.fn(async () => {}),
			// 重建UI为spy，不绘制真实终端。
			renderCurrentSessionState: vi.fn(),
			// 属性简写挂上面单独保存的fatal spy，便于最后验证未进入致命分支。
			handleFatalRuntimeError,
			// 缺cwd提示在此不是专门缺文件错误的处理器，本例不会去询问或验证目录。
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			// 路径解析仍复用真实助手，确保被抛错误的输入来自实际命令提取。
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		// 等待真实命令处理假导入的拒绝；若专门catch正常处理，整个handleImportCommand应正常完成而非把这个错误继续拒绝。
		await interactiveModePrototype.handleImportCommand.call(context, "/import /tmp/missing-session.jsonl");

		// 要求完整非致命错误文字，前缀来自命令、File not found及路径来自错误类；不证明真实文件系统检测正确。
		expect(showError).toHaveBeenCalledWith("Failed to import session: File not found: /tmp/missing-session.jsonl");
		// 任何状态提示都不应调用，包括成功及取消文案，而不只是排除某一个固定成功字符串。
		expect(showStatus).not.toHaveBeenCalled();
		// 直接要求fatal spy完全未调用，证明本样本的专门错误分类未委托致命处理。
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
	});
});
