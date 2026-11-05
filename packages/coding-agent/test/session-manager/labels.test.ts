// 验证书签标签的追加记录、最新值缓存、树节点显示和单路径派生；所有会话均为内存模式。
// 标签 targetId 指向被标记条目，标签操作自己的 parentId 则接在当前叶子后，两者不是同一关系。
import { describe, expect, it } from "vitest";
import { type LabelEntry, SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager labels", () => {
	// 用 hello 消息为例，从无标签到 checkpoint，再检查独立 label 条目的 id、目标和文字；无文件副作用。
	it("sets and gets labels", () => {
		// 创建独立内存会话，追加仅更新树与索引，不生成会话文件。
		const session = SessionManager.inMemory();

		// 保存固定用户消息并取得树条目 id；这个 id 用来做父链或标签目标，和会话 id 不同。
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// No label initially
		// 检查该目标当前没有有效标签；undefined 既可表示未设置，也可表示已清除。
		expect(session.getLabel(msgId)).toBeUndefined();

		// Set a label
		// 给 msgId 追加 checkpoint 标签，并保留标签操作本身的 id。
		const labelId = session.appendLabelChange(msgId, "checkpoint");
		// 检查按消息 id 查询能读到刚设置的书签文字。
		expect(session.getLabel(msgId)).toBe("checkpoint");

		// Label entry should be in entries
		// 读取除会话头外的全历史新数组；元素仍引用原条目，包含所有分支和状态。
		const entries = session.getEntries();
		// 按 type 找 label 操作；as 只向 TS 声明类型，下一条断言才检查实际存在。
		const labelEntry = entries.find((e) => e.type === "label") as LabelEntry;
		// 确认 find 确实找到标签记录。
		expect(labelEntry).toBeDefined();
		// 标签操作的 id 应与 append 返回值相同。
		expect(labelEntry.id).toBe(labelId);
		// targetId 必须指向被标记消息，而不是标签自身或当前叶子。
		expect(labelEntry.targetId).toBe(msgId);
		// 标签记录保留书签文字。
		expect(labelEntry.label).toBe("checkpoint");
	});

	// 先设置 checkpoint 再传 undefined，确认查询结果变成缺值；测试不会删掉历史标签操作。
	it("clears labels with undefined", () => {
		// 创建独立内存会话，追加仅更新树与索引，不生成会话文件。
		const session = SessionManager.inMemory();

		// 保存固定用户消息并取得树条目 id；这个 id 用来做父链或标签目标，和会话 id 不同。
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// 追加标签操作并更新 msgId 的标签缓存；操作本身也占一个树节点。
		session.appendLabelChange(msgId, "checkpoint");
		// 检查按消息 id 查询能读到刚设置的书签文字。
		expect(session.getLabel(msgId)).toBe("checkpoint");

		// Clear the label
		// 显式传 undefined 追加清除操作，删除缓存中的标签及标签时间。
		session.appendLabelChange(msgId, undefined);
		// 检查该目标当前没有有效标签；undefined 既可表示未设置，也可表示已清除。
		expect(session.getLabel(msgId)).toBeUndefined();
	});

	// 同一消息依次标 first/second/third，最后查询与树时间应来自第三次变化；三次时间可以相等。
	it("last label wins", () => {
		// 创建独立内存会话，追加仅更新树与索引，不生成会话文件。
		const session = SessionManager.inMemory();

		// 保存固定用户消息并取得树条目 id；这个 id 用来做父链或标签目标，和会话 id 不同。
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// 第一次给目标设 first；后续操作应覆盖缓存但保留此记录。
		session.appendLabelChange(msgId, "first");
		// 第二次覆盖成 second，作为验证最后写入规则的中间状态。
		session.appendLabelChange(msgId, "second");
		// 第三次覆盖成 third，并保存本次标签操作 id 供时间比较。
		const lastLabelId = session.appendLabelChange(msgId, "third");

		// 检查查询选择最后一次设置值。
		expect(session.getLabel(msgId)).toBe("third");

		// 读取除会话头外的全历史新数组；元素仍引用原条目，包含所有分支和状态。
		const entries = session.getEntries();
		// 用第三次操作 id 精确找记录；类型断言不验证它是否存在。
		const lastLabelEntry = entries.find((e) => e.id === lastLabelId) as LabelEntry;
		// 把全历史包装为根节点数组；children 才表示父子关系，和追加顺序数组不同。
		const tree = session.getTree();
		// 在根包装数组中定位被标记用户消息，find 无匹配会返回 undefined。
		const msgNode = tree.find((n) => n.entry.id === msgId);
		// ?. 在消息未找到时得到 undefined；断言比较标签时间与最后记录值，未断言时间严格递增。
		expect(msgNode?.labelTimestamp).toBe(lastLabelEntry.timestamp);
	});

	// 构造 user→assistant 并分别标 start/response，验证标签与时间附在目标包装节点上。
	it("labels are included in tree nodes", () => {
		// 创建独立内存会话，追加仅更新树与索引，不生成会话文件。
		const session = SessionManager.inMemory();

		// 追加用户根节点，保存返回 id 以便检查父子关系和标签。
		const msg1Id = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
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

		// 给第一条消息设 start，返回操作 id 用来核对标签时间。
		const msg1LabelId = session.appendLabelChange(msg1Id, "start");
		// 给助手消息设 response；标签操作虽追加在后，显示应仍挂在助手节点。
		const msg2LabelId = session.appendLabelChange(msg2Id, "response");

		// 读取除会话头外的全历史新数组；元素仍引用原条目，包含所有分支和状态。
		const entries = session.getEntries();
		// 精确找到首条消息的标签操作，读取其原始变更时间。
		const msg1LabelEntry = entries.find((e) => e.id === msg1LabelId) as LabelEntry;
		// 找到助手标签操作，供包装节点时间对照。
		const msg2LabelEntry = entries.find((e) => e.id === msg2LabelId) as LabelEntry;
		// 把全历史包装为根节点数组；children 才表示父子关系，和追加顺序数组不同。
		const tree = session.getTree();

		// Find the message nodes (skip label entries)
		// 在根层找用户消息包装节点，标签操作节点仍在整树中。
		const msg1Node = tree.find((n) => n.entry.id === msg1Id);
		// 确认用户包装节点携带 start 书签。
		expect(msg1Node?.label).toBe("start");
		// 标签时间必须沿用原操作时间，派生会话也不能用新头时间代替。
		expect(msg1Node?.labelTimestamp).toBe(msg1LabelEntry.timestamp);

		// msg2 is a child of msg1
		// 先用可选链取得用户孩子，再按 id 找助手；这会区分真正父子关系与平铺顺序。
		const msg2Node = msg1Node?.children.find((n) => n.entry.id === msg2Id);
		// 助手包装节点应携带自己的 response 标签。
		expect(msg2Node?.label).toBe("response");
		// 助手标签时间等于该标签操作的原时间。
		expect(msg2Node?.labelTimestamp).toBe(msg2LabelEntry.timestamp);
	});

	// 提取到助手节点，把原路径上的书签恢复到新会话；检查标签数量和原标签时间保留。
	it("labels are preserved in createBranchedSession", () => {
		// 创建独立内存会话，追加仅更新树与索引，不生成会话文件。
		const session = SessionManager.inMemory();

		// 追加用户根节点，保存返回 id 以便检查父子关系和标签。
		const msg1Id = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
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

		// 首条消息设置 important 书签，稍后检查派生保留。
		const msg1LabelId = session.appendLabelChange(msg1Id, "important");
		// 助手设置 also-important，作为第二个需重建的标签。
		const msg2LabelId = session.appendLabelChange(msg2Id, "also-important");
		// 派生前取得原记录，保留原标签操作时间用于事后比较。
		const originalEntries = session.getEntries();
		// 找到派生前的首个标签操作，而非新生成的标签节点。
		const msg1LabelEntry = originalEntries.find((e) => e.id === msg1LabelId) as LabelEntry;
		// 保留助手标签原始时间。
		const msg2LabelEntry = originalEntries.find((e) => e.id === msg2LabelId) as LabelEntry;

		// Branch from msg2 (in-memory mode returns null, but updates internal state)
		// 把根到 msg2Id 的路径提取成新内存会话，去旧标签节点后重建有效标签；返回 undefined。
		session.createBranchedSession(msg2Id);

		// Labels should be preserved
		// 检查新内存会话仍能按原消息 id 查询首个书签。
		expect(session.getLabel(msg1Id)).toBe("important");
		// 检查助手书签同样恢复。
		expect(session.getLabel(msg2Id)).toBe("also-important");

		// New label entries should exist
		// 读取除会话头外的全历史新数组；元素仍引用原条目，包含所有分支和状态。
		const entries = session.getEntries();
		// filter 收集新历史中的标签操作；as 不修改运行时数组元素。
		const labelEntries = entries.filter((e) => e.type === "label") as LabelEntry[];
		// 应重新生成两条有效标签记录，没有重复保留旧操作。
		expect(labelEntries).toHaveLength(2);

		// 把全历史包装为根节点数组；children 才表示父子关系，和追加顺序数组不同。
		const tree = session.getTree();
		// 在根层找用户消息包装节点，标签操作节点仍在整树中。
		const msg1Node = tree.find((n) => n.entry.id === msg1Id);
		// 先用可选链取得用户孩子，再按 id 找助手；这会区分真正父子关系与平铺顺序。
		const msg2Node = msg1Node?.children.find((n) => n.entry.id === msg2Id);
		// 标签时间必须沿用原操作时间，派生会话也不能用新头时间代替。
		expect(msg1Node?.labelTimestamp).toBe(msg1LabelEntry.timestamp);
		// 助手标签时间等于该标签操作的原时间。
		expect(msg2Node?.labelTimestamp).toBe(msg2LabelEntry.timestamp);
	});

	// 用 user→label→model_change→user 的路径，检查去掉旧标签节点后模型变化改接首条消息。
	it("rewires children of removed labels when forking", () => {
		// 创建独立内存会话，追加仅更新树与索引，不生成会话文件。
		const session = SessionManager.inMemory();

		// 追加用户根节点，保存返回 id 以便检查父子关系和标签。
		const msg1Id = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendLabelChange(msg1Id, "checkpoint");
		// 把模型变化挂在标签操作之后，制造提取时必须重连的父链。
		const modelChangeId = session.appendModelChange("anthropic", "claude-test");
		// 在模型状态之后追加第二条用户输入，检查去标签后它仍有完整祖先链。
		const msg2Id = session.appendMessage({ role: "user", content: "followup", timestamp: 2 });

		// 把根到 msg2Id 的路径提取成新内存会话，去旧标签节点后重建有效标签；返回 undefined。
		session.createBranchedSession(msg2Id);

		// 去旧 label 后模型变化必须直接接第一条消息，避免引用已移除节点。
		expect(session.getEntry(modelChangeId)?.parentId).toBe(msg1Id);
	});

	// 三条消息全设标签，但只提取前两条；第三条及其标签不进入新会话。
	it("labels not on path are not preserved in createBranchedSession", () => {
		// 创建独立内存会话，追加仅更新树与索引，不生成会话文件。
		const session = SessionManager.inMemory();

		// 追加用户根节点，保存返回 id 以便检查父子关系和标签。
		const msg1Id = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
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
		// 添加稍后将被提取范围排除的第三条消息。
		const msg3Id = session.appendMessage({ role: "user", content: "followup", timestamp: 3 });

		// Label all messages
		// 给第一条消息设标签，该消息在提取范围内。
		session.appendLabelChange(msg1Id, "first");
		// 给第二条消息设标签，它也是新会话叶子。
		session.appendLabelChange(msg2Id, "second");
		// 给第三条消息设标签，但它处于随后提取目标之后。
		session.appendLabelChange(msg3Id, "third");

		// Branch from msg2 (excludes msg3)
		// 把根到 msg2Id 的路径提取成新内存会话，去旧标签节点后重建有效标签；返回 undefined。
		session.createBranchedSession(msg2Id);

		// Only labels for msg1 and msg2 should be preserved
		// 首条消息及其标签都应保留。
		expect(session.getLabel(msg1Id)).toBe("first");
		// 目标叶子的标签也应保留。
		expect(session.getLabel(msg2Id)).toBe("second");
		// 提取范围外的第三条消息标签不应留在新缓存。
		expect(session.getLabel(msg3Id)).toBeUndefined();
	});

	// 一条用户消息加一条书签，模型上下文仍只有 user；只证明本例的消息投影。
	it("labels are not included in buildSessionContext", () => {
		// 创建独立内存会话，追加仅更新树与索引，不生成会话文件。
		const session = SessionManager.inMemory();

		// 保存固定用户消息并取得树条目 id；这个 id 用来做父链或标签目标，和会话 id 不同。
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		// 追加标签操作并更新 msgId 的标签缓存；操作本身也占一个树节点。
		session.appendLabelChange(msgId, "checkpoint");

		// 沿当前叶子的父链构建上下文；状态条目可改变设置，但不一定贡献模型消息。
		const ctx = session.buildSessionContext();
		// 书签不贡献模型消息，只有原用户输入一条。
		expect(ctx.messages).toHaveLength(1);
		// 再核对唯一消息的角色，避免只看数量误收标签。
		expect(ctx.messages[0].role).toBe("user");
	});

	// 把不存在的 id 作为标签目标，expect 包裹调用后检查同步抛错；不产生悬空标签。
	it("throws when labeling non-existent entry", () => {
		// 创建独立内存会话，追加仅更新树与索引，不生成会话文件。
		const session = SessionManager.inMemory();

		// 箭头推迟会抛错的调用，让 toThrow 捕获并比较错误文字。
		expect(() => session.appendLabelChange("non-existent", "label")).toThrow("Entry non-existent not found");
	});
});
