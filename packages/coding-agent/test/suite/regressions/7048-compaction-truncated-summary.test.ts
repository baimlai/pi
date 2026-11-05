import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// 给传入 Harness 写入一轮可压缩历史，返回 void；只改内存会话、设置和 agent 状态。
// 先降低保留预算，再追加用户/助手并重建模型上下文；例如 compact() 随后能对这轮旧消息生成摘要。
function seedCompactableSession(harness: Harness): void {
	// 只保留极少近期 token，让下面有用量的旧轮次成为压缩候选。
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	// 取当前毫秒时间，用相对偏移让两条旧消息顺序明确；不是固定测试时钟。
	const now = Date.now();
	// 向内存日志追加用户条目，appendMessage 同时维护树父链。
	harness.sessionManager.appendMessage({
		// 消息标签让 TypeScript 和运行时代码都把该对象当用户消息处理。
		role: "user",
		// 用户内容采用文本块数组；type 是块的判别标签。
		content: [{ type: "text", text: "message to compact" }],
		// 这条用户消息比采样时间早 1000ms，随后助手消息再晚 500ms。
		timestamp: now - 1000,
	});
	// 读取当前 faux 模型身份，避免手写与注册模型不一致的 provider/api/id。
	const model = harness.getModel();
	// 显式 AssistantMessage 只提供编译期结构检查，不在运行时验证对象。
	const assistant: AssistantMessage = {
		// 展开假助手消息默认字段，再由下方属性覆盖模型身份和用量；是浅复制。
		...fauxAssistantMessage("assistant response to compact", { timestamp: now - 500 }),
		// 把消息标记为当前模型的 API 协议。
		api: model.api,
		// 记录 faux 供应商名，用于按消息寻找模型与认证。
		provider: model.provider,
		// 记录已注册的模型 id。
		model: model.id,
		// 提供用于压缩预算估算的固定用量，不是实测模型消耗。
		usage: {
			// 输入 token 固定为 100，使待压缩上下文有非零用量。
			input: 100,
			// 本夹具不为助手输出计 token。
			output: 0,
			// 缓存读取量固定为零。
			cacheRead: 0,
			// 缓存写入量固定为零。
			cacheWrite: 0,
			// 总 token 与本例输入量一致。
			totalTokens: 100,
			// 费用全部为零；压缩资格测试不涉及真实账单。
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	// 追加助手历史，完成一轮对话。
	harness.sessionManager.appendMessage(assistant);
	// 从日志树重建当前分支上下文并替换 agent 的消息数组，使两层历史同步。
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

// 注册 #7048 回归：输出因 token 上限截断的摘要不能保存为有效压缩。
describe("#7048 truncated compaction summaries", () => {
	// 联合类型允许测试尚未创建 harness；let 允许后续赋值与清空。
	let harness: Harness | undefined;

	// 每例结束都清理可选 harness；回调无参数、无业务返回值，影响仅是资源释放。
	afterEach(() => {
		// 可选调用只在变量有值时执行 cleanup，创建前失败也不会再抛空引用错误。
		harness?.cleanup();
		// 清除上例引用，避免下一例误复用已释放对象。
		harness = undefined;
	});

	// 异步用例先准备旧历史，再返回 length 终态摘要；断言 compact 拒绝且日志没有压缩条目。
	// 例如 partial summar 不能作为完整摘要持久化，本例只覆盖这一路截断终态。
	it("does not persist a length-limited summary", async () => {
		// 等待本地 faux 会话创建后保存引用，供 afterEach 清理。
		harness = await createHarness();
		// 调用上面的 helper，让 compact 有可处理内容。
		seedCompactableSession(harness);
		// 摘要请求将收到不完整文本及 length 终态，模拟输出长度上限。
		harness.setResponses([fauxAssistantMessage("partial summar", { stopReason: "length" })]);

		// rejects 等待 Promise 拒绝并检查错误文字；遗漏 await 会让异步断言不能可靠收尾。
		await expect(harness.session.compact()).rejects.toThrow("generation hit the token cap");
		// 过滤压缩类型条目后要求零条，验证失败摘要未污染日志。
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});
});
