// 用手构造助手诊断和原型方法验证思考丢弃提示，不向Anthropic请求、不恢复思考块或启动真实TUI；提示由真实内存组件渲染。
// AssistantMessage只作类型导入，JS中擦除；它描述消息外壳，diagnostics.details仍是动态JSON数据。
import type { AssistantMessage } from "@earendil-works/pi-ai";
// 实际Container收集聊天组件并按行合并render结果，不写终端。
import { Container } from "@earendil-works/pi-tui";
// Vitest注册两例并断言，test回调执行时才跑主题初始化和被测方法。
import { describe, expect, test } from "vitest";
// 借InteractiveMode.prototype调用真实判断方法，不调用类构造器或建立真实会话。
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
// 初始化共享主题；dark冷加载可读内置JSON，颜色能力冷探测在tmux可能执行只读查询，PI_HYPERLINKS=0可短路；默认不启动主题watch。
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
// 实际stripAnsi只删它正则识别的完整控制串，便于比文字，不等于清除所有控制字符。
import { stripAnsi } from "../src/utils/ansi.ts";

// 模块级固定助手夹具，const不冻结嵌套对象；这份手写数据不是实际服务响应，两个用例复用它但不修改其诊断数组。
const message: AssistantMessage = {
	// 角色assistant让真实方法识别最近助手消息。
	role: "assistant",
	// 幸存的正文文字仅作消息外壳，不是思考块；被测提示不读取或删除它。
	content: [{ type: "text", text: "survived" }],
	// 记录协议身份Messages，不会因此自动发送请求。
	api: "anthropic-messages",
	// 供应商标签anthropic，不等于真的登录该供应商。
	provider: "anthropic",
	// 固定模型标识样本，用例不检查该名字是否在目录中，也不下载模型。
	model: "claude-fable-5-1",
	// 补齐AssistantMessage要求的用量对象；本方法只看diagnostics，这些数字不参与丢块数量计算。
	usage: {
		// 普通输入token样本为1。
		input: 1,
		// 输出token样本为1。
		output: 1,
		// 缓存读取桶为0，不是声明真实请求缓存未命中。
		cacheRead: 0,
		// 缓存写入桶为0。
		cacheWrite: 0,
		// 总token样本为2，与下面3条诊断计数是不同概念。
		totalTokens: 2,
		// 费用各项及合计为0，仅满足夹具结构，不查询真实账单。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	// stop表示正常停止，诊断可附在成功消息上，不必是error。
	stopReason: "stop",
	// 固定消息时间戳1毫秒，后面改成2只区分消息，不影响计数条件。
	timestamp: 1,
	// diagnostics是可选数组字段，此夹具放一条诊断；动态details里的转换项才是被统计的对象。
	diagnostics: [
		// 本诊断普通对象没有error字段也符合诊断接口。
		{
			// 固定类型决定此诊断被countDroppedThinkingBlocks纳入；其他类型会跳过。
			type: "anthropic_input_transformations",
			// 诊断自身时刻与消息时刻分开，测试固定同为1，不参与去重逻辑。
			timestamp: 1,
			// details是JSON详情对象，测试不把它交模型作正文。
			details: {
				// 三条转换记录，用来检验当前总数3的提示；本例没有输入真正thinking内容。
				transformations: [
					// 第一条转换记录。
					{
						// 只有type严格thinking_dropped才计一个，重复记录也按条数计，不解析path。
						type: "thinking_dropped",
						// 服务端风格路径只是诊断文字，这里不会按路径访问或删除历史消息。
						path: "messages.2.content.0",
						// 原因样本说明前缀绑定不匹配，被测计数方法不据reason推断或验证服务端事实。
						reason: "prefix_binding_mismatch",
					},
					// 第二条独立转换对象，和第一条分类相同但路径不同。
					{
						// 第二个thinking_dropped使当前计数再加1。
						type: "thinking_dropped",
						// 第二条的诊断路径；不打开文件或跳会话树。
						path: "messages.5.content.0",
						// 保持同一原因样本，不因相同reason合并。
						reason: "prefix_binding_mismatch",
					},
					// 第三条转换对象。
					{
						// 第三个丢块标记使本条助手总数为3。
						type: "thinking_dropped",
						// 第三条诊断路径，同样不作为运行指令。
						path: "messages.8.content.0",
						// 第三条相同原因，计数仍逐记录而非去重原因。
						reason: "prefix_binding_mismatch",
					},
				],
			},
		},
	],
};

// 最小假this的开发期形状，只提供提示方法会读的三项能力，不创建真实SessionManager。
type NoticeContext = {
	// 真实内存容器保存Spacer和ThemedText，稍后render才计算带色文字。
	chatContainer: Container;
	// getShowCacheMissNotices布尔开关同时控制这类思考提示，不表示这里检测了真实缓存miss。
	settingsManager: { getShowCacheMissNotices(): boolean };
	// getBranch替身返回消息条目数组；接口只声明本例需要的assistant形状，不证明真实树遍历或持久化。
	sessionManager: { getBranch(): Array<{ type: "message"; message: AssistantMessage }> };
};

// Reflect.get取运行时私有原型方法；as只是函数签名视图，不检查函数存在，不把private改成公开API。
const maybeShowThinkingDropNotice = Reflect.get(InteractiveMode.prototype, "maybeShowThinkingDropNotice") as (
	// this参数仅约束.call接收者，运行时不占普通实参位置。
	this: NoticeContext,
	// 唯一普通实参是当前助手消息，方法返回void，不生成新助手回复。
	message: AssistantMessage,
) => void;

// 注册两例，分别检验开关门禁和与最近助手比较的抑制路径，不覆盖所有诊断坏形状或多分支历史。
describe("InteractiveMode assistant diagnostics", () => {
	// 同一条三记录消息：开启时渲染3的提示，关闭时容器应保持空；只核提示文字/组件，不查真实session中的details是否落盘。
	test("shows Anthropic thinking drops when cache miss notices are enabled", () => {
		// 切dark全局主题供真实ThemedText取色；无显式模式时冷能力可能查tmux，不启文件watch，也未在用例末恢复原主题。
		initTheme("dark");
		// 创建开启提示的独立假上下文。
		const enabled = {
			// 新建空容器，和关闭路径不共享children。
			chatContainer: new Container(),
			// 箭头固定true，不读取真实settings.json。
			settingsManager: { getShowCacheMissNotices: () => true },
			// 空分支使上条助手丢块基数为0，不读取历史文件。
			sessionManager: { getBranch: () => [] },
		};
		// .call把enabled作为this，真实方法数出3后添加空行和主题提示；不是调用实际模型。
		maybeShowThinkingDropNotice.call(enabled, message);
		// 按120列生成容器行、LF连接、剥支持的ANSI，再存纯文字；渲染不写stdout或终端。
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		// toContain只要求有这段文字，不限制整屏留白、次数、组件类型或证明真的丢过三块。
		expect(output).toContain("Anthropic dropped 3 thinking blocks (details in session)");

		// 关闭路径另建上下文，避免开启路径的组件污染长度断言。
		const disabled = {
			// 关闭路径的全新空聊天容器。
			chatContainer: new Container(),
			// 固定false应在方法入口早退，不需要回溯历史。
			settingsManager: { getShowCacheMissNotices: () => false },
			// 仍提供空分支契约，本测试没有spy断言它到底调用几次。
			sessionManager: { getBranch: () => [] },
		};
		// 把同一消息交关闭路径，诊断数据本身不随显示开关删除。
		maybeShowThinkingDropNotice.call(disabled, message);
		// 容器长度0说明本例没有追加提示/空行，不证明其他UI或日志完全无输出。
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	// 最近助手已有3条记录，当前仅改时间戳仍是3，不能再次提示；真实规则比较数量非逐条内容去重，本例不测试数量增加/下降。
	test("does not repeat unchanged Anthropic thinking drops", () => {
		// 为本例初始化dark，更新共享主题但不构造InteractiveMode；冷能力IO边界与上例相同。
		initTheme("dark");
		// 最小上下文给真实方法查上条助手并决定不添加组件。
		const context = {
			// 本例自己的空容器。
			chatContainer: new Container(),
			// 提示开关仍开，确保不显示是计数比较结果，而非被设置禁用。
			settingsManager: { getShowCacheMissNotices: () => true },
			// 分支只含上条message，as const把type推成字面量；返回新数组但其中message仍是模块夹具原引用。
			sessionManager: { getBranch: () => [{ type: "message" as const, message }] },
		};

		// 浅展开新消息只覆盖timestamp=2，content/usage/diagnostics仍共享；时间戳变了而丢块总数仍3，不是深拷贝诊断。
		maybeShowThinkingDropNotice.call(context, { ...message, timestamp: 2 });

		// 零children验证计数未增长时不追加；不执行真正事件时序、历史保存或终端重绘。
		expect(context.chatContainer.children).toHaveLength(0);
	});
});
