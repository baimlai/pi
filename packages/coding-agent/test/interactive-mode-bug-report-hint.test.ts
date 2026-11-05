// 只借InteractiveMode原型上的提示判断方法测试错误分类，不new交互模式、不启动终端，也不发送问题报告；提示输出由vi.fn记录。
// AssistantMessage是擦除的类型，fauxAssistantMessage是创建内存助手消息夹具的运行时函数，不向faux或真实模型发请求。
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
// test与it同为用例入口，vi提供调用记录替身；断言关注是否触发提示，不测真实UI。
import { describe, expect, test, vi } from "vitest";
// 导入真实提示文本函数和InteractiveMode类；使用prototype只取方法，避开构造器里的配置/终端等初始化。
import { formatCrashExtensionHint, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// 最小this上下文类型只列被测判断方法要调用的两个成员，不是整个交互模式实例。
type BugReportHintContext = {
	// 建议报错的方法无业务返回，测试中用vi.fn替代实际显示。
	suggestBugReport(): void;
	// 安装变化提示返回boolean；真值让被测方法停止继续建议报错。
	maybeShowInstallChangeWarning(): boolean;
};

// Reflect.get按字符串读原型私有方法；TS的private不是JS #字段，运行时仍可这样取到它。
// as仅断言函数签名，不保证读出的值一定可调用；下方测试实际调用才会暴露缺失或不兼容。
const maybeSuggestBugReport = Reflect.get(InteractiveMode.prototype, "maybeSuggestBugReport") as (
	// this参数只给TS约束调用接收者，不占运行时实参位置；用.call(context,message)传this。
	this: BugReportHintContext,
	// message是唯一普通实参，按AssistantMessage类型使用。
	message: AssistantMessage,
) => void;

// 输入错误文字，返回stopReason:error的助手夹具；例如errorMessage('Unexpected internal state')只创建数据。
// 参数与函数同名，在函数体里errorMessage指这段字符串，外层调用处的errorMessage(...)仍指函数；无I/O，辅助构造异常直接传播。
function errorMessage(errorMessage: string): AssistantMessage {
	// 空正文配覆盖字段，属性简写把错误文字写入同名errorMessage字段，不调用提示或模型。
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

// 五例分别检查栈来源提示、可重试错误、取消、意外错误、安装变化优先级。
describe("InteractiveMode bug report hints", () => {
	// 第一例实际跑纯格式化函数，检查单扩展与缺输入两条路径；不证明该扩展确是崩溃根因。
	test("identifies extensions with frames in a crash stack", () => {
		// 传固定来源名并比较完整提示文字，反引号只是输出的一部分。
		expect(formatCrashExtensionHint(["npm:pi-observational-memory"])).toBe(
			// 原文建议用户排查扩展；测试仅比较字符串，不执行pi config或pi -ne。
			"A stack frame came from loaded extension `npm:pi-observational-memory`, which may be involved. Try disabling it with `pi config`, or run `pi -ne` to confirm.",
		);
		// undefined输入应返回undefined，未创建一条无来源提示。
		expect(formatCrashExtensionHint(undefined)).toBeUndefined();
	});

	// 第二例遍历八个固定可重试错误文字，要求它们都不触发建议；不实际重试HTTP。
	test("does not suggest reports for retryable provider failures", () => {
		// 两个全新vi.fn只记录调用，安装变化替身固定false，不读真实安装文件。
		const context = { suggestBugReport: vi.fn(), maybeShowInstallChangeWarning: vi.fn(() => false) };
		// 固定失败文案数组只是待分类输入，不是现场收到的供应商响应。
		const failures = [
			// 服务内部错误文字样本。
			"500 Internal Server Error",
			// 网关错误文字样本。
			"502 Bad Gateway",
			// 服务不可用文字样本。
			"503 Service Unavailable",
			// 网关超时文字样本。
			"504 Gateway Timeout",
			// 限流文字样本，不发出大量请求制造限流。
			"429 Too Many Requests",
			// 过载文字样本。
			"Provider overloaded",
			// 网络断开文字样本，不切断本机网络。
			"Network connection lost",
			// 请求超时文字样本，不启动超时计时器。
			"Request timed out",
		];

		// for...of逐条创建消息，用.call显式绑定当前假context；未new InteractiveMode或调用它的其它生命周期。
		for (const failure of failures) maybeSuggestBugReport.call(context, errorMessage(failure));

		// 只要求suggestBugReport一次都没调用，没有逐项断言每个内部判断的调用次数。
		expect(context.suggestBugReport).not.toHaveBeenCalled();
	});

	// 第三例分别覆盖error文字包含abort/cancel以及stopReason直接aborted，均不弹建议。
	test("does not suggest reports for cancellations", () => {
		// 每例独立创建调用记录，安装判断仍是假false。
		const context = { suggestBugReport: vi.fn(), maybeShowInstallChangeWarning: vi.fn(() => false) };

		// error状态但错误文字含aborted，应由取消文案规则过滤。
		maybeSuggestBugReport.call(context, errorMessage("This operation was aborted"));
		// 另一种cancelled拼写也应过滤。
		maybeSuggestBugReport.call(context, errorMessage("Request cancelled"));
		// 直接aborted状态会在最前面的非error判断返回，不需要靠文字匹配。
		maybeSuggestBugReport.call(context, fauxAssistantMessage("", { stopReason: "aborted" }));

		// 三次调用后建议次数仍为0，未检查真实状态提示UI。
		expect(context.suggestBugReport).not.toHaveBeenCalled();
	});

	// 第四例给非可重试/非取消错误，且无安装变化，要求建议一次。
	test("suggests reports for unexpected errors", () => {
		// 假context的方法都是调用记录器，实际suggestBugReport的单实例去重逻辑不在本例执行。
		const context = { suggestBugReport: vi.fn(), maybeShowInstallChangeWarning: vi.fn(() => false) };

		// 传固定意外状态文字，走真实分类方法。
		maybeSuggestBugReport.call(context, errorMessage("Unexpected internal state"));

		// 断言记录器被调用一次，不等真的上传了报告或显示了终端文字。
		expect(context.suggestBugReport).toHaveBeenCalledOnce();
	});

	// 第五例让安装变化提示返回true，检查它优先于建议报bug；不现场替换安装文件。
	test("shows the install change warning instead of a bug report hint", () => {
		// 安装检查替身固定true，另一方法仍只记录次数。
		const context = { suggestBugReport: vi.fn(), maybeShowInstallChangeWarning: vi.fn(() => true) };

		// 缺模块文字仅为输入样本，测试不加载不存在的worker文件。
		maybeSuggestBugReport.call(context, errorMessage("Cannot find module './worker.js'"));

		// 安装变化检查必须调用一次，确认不是在其它早退条件就跳过。
		expect(context.maybeShowInstallChangeWarning).toHaveBeenCalledOnce();
		// 安装提示接管后不得继续调用bug建议。
		expect(context.suggestBugReport).not.toHaveBeenCalled();
	});
});
