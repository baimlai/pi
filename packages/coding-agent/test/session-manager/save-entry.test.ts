// 验证扩展私有状态与普通消息共用会话父链，但不进入模型上下文；整个用例只操作内存。
// describe/it 接收无参回调注册测试；expect 真正在测试执行时比较结果，类型检查本身不会运行断言。
import { describe, expect, it } from "vitest";
import { type CustomEntry, SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager.saveCustomEntry", () => {
	// 以 user→custom→assistant 为具体例子，验证条目、父链与可见消息数量；无外部输入、文件或模型副作用。
	// 回调返回 void；任一 expect 不满足会抛出测试失败，不会自行恢复测试状态。
	it("saves custom entries and includes them in tree traversal", () => {
		// 创建独立内存会话，追加仅更新树与索引，不生成会话文件。
		const session = SessionManager.inMemory();

		// Save a message
		// 保存固定用户消息并取得树条目 id；这个 id 用来做父链或标签目标，和会话 id 不同。
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// Save a custom entry
		// 追加扩展私有状态，my_data 是类别，data 保存对象；它会推进叶子，但不变成聊天消息。
		const customId = session.appendCustomEntry("my_data", { foo: "bar" });

		// Save another message
		// 追加人工助手消息为当前叶子的孩子，返回新条目 id。
		const msg2Id = session.appendMessage({
			// 这是手写助手响应，角色决定 content 采用内容块数组；不会调用该供应商。
			role: "assistant",
			// 固定一块文本作为助手正文；数组内的 type 用来区分文本、思考、工具调用等块。
			content: [{ type: "text", text: "hi" }],
			// 记录响应使用的 API 名，测试只保存元数据，不通过此字段发起请求。
			api: "anthropic-messages",
			// 供应商名与 model 一起标识这条人工响应的来源。
			provider: "anthropic",
			// 使用占位模型名，避免把存储测试误读成真实模型调用。
			model: "test",
			// 人工用量对象满足消息类型；以下计数与 cost 是测试数据，不是实际计费结果。
			usage: {
				// 输入 token 数固定为 1。
				input: 1,
				// 输出 token 数固定为 1。
				output: 1,
				// 固定没有读取缓存的 token。
				cacheRead: 0,
				// 固定没有写入缓存的 token。
				cacheWrite: 0,
				// 总数与此夹具的输入、输出相加一致。
				totalTokens: 2,
				// 费用分项全部设零；持久化层只保存这些数值。
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			// 标为正常结束的人工响应，和真实流式请求无关。
			stopReason: "stop",
			// 消息内部时间为毫秒数字，与外层条目的 ISO 时间字符串不同。
			timestamp: 2,
		});

		// Custom entry should be in entries
		// 读取除会话头外的全历史新数组；元素仍引用原条目，包含所有分支和状态。
		const entries = session.getEntries();
		// 全历史必须包含两条消息和一条 custom，头不在 getEntries 的结果里。
		expect(entries).toHaveLength(3);

		// find 的箭头回调按 type 找状态条目；as 只声明预期类型，真正存在性由后面的断言检查。
		const customEntry = entries.find((e) => e.type === "custom") as CustomEntry;
		// 运行时确认找到了条目；TypeScript 的 as 并不能代替这个断言。
		expect(customEntry).toBeDefined();
		// 检查扩展状态的类别名被保留。
		expect(customEntry.customType).toBe("my_data");
		// 深比较状态载荷的字段值；这不证明对象已被深复制。
		expect(customEntry.data).toEqual({ foo: "bar" });
		// 确认查询命中的节点就是 appendCustomEntry 返回的 id。
		expect(customEntry.id).toBe(customId);
		// custom 的父节点应是前一条用户消息。
		expect(customEntry.parentId).toBe(msgId);

		// Tree structure should be correct
		// 按当前叶子沿 parentId 回溯并反转成根到叶子顺序；保留所有条目类型。
		const path = session.getBranch();
		// 原始路径包含状态节点，不能用模型消息数代替树节点数。
		expect(path).toHaveLength(3);
		// 根节点对应用户消息。
		expect(path[0].id).toBe(msgId);
		// 中间节点对应扩展状态。
		expect(path[1].id).toBe(customId);
		// 最后节点对应人工助手消息，也就是当前叶子。
		expect(path[2].id).toBe(msg2Id);

		// buildSessionContext should work (custom entries skipped in messages)
		// 沿当前叶子的父链构建上下文；状态条目可改变设置，但不一定贡献模型消息。
		const ctx = session.buildSessionContext();
		// 上下文只有 user 和 assistant；测试以数量间接验证 custom 被跳过。
		expect(ctx.messages).toHaveLength(2); // only message entries
	});
});
