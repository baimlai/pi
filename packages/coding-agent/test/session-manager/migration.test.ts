// 用手写旧版本记录验证磁盘格式迁移：v1 补树 id/parentId，v2 升级角色命名到 v3。这里只原地改数组，不读写文件。
// 原测试的 any 与强制断言用于容纳故意不符合当前接口的旧记录；它们不会在运行时校验字段。
import { describe, expect, it } from "vitest";
import { type FileEntry, migrateSessionEntries } from "../../src/core/session-manager.ts";

describe("migrateSessionEntries", () => {
	// 输入无 version、无树字段的两条旧消息，迁移后检查 v3 头和8位父链；仅覆盖这个线性样本。
	it("should add id/parentId to v1 entries", () => {
		// FileEntry[] 在开发期表示“会话头或条目”的数组；这里通过末尾 as 保留故意缺字段的历史夹具。
		const entries: FileEntry[] = [
			// 无 version 的头按 v1 解释；id 是整份会话身份，不是消息节点 id。
			{ type: "session", id: "sess-1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			// 旧用户消息缺 id/parentId，迁移将原地补齐；内层毫秒时间与外层 ISO 时间分开。
			{ type: "message", timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } },
			{
				// 这是消息条目，message 内再保存具体角色与内容。
				type: "message",
				// 固定第二条记录时间，迁移应专注格式而不重写消息时序。
				timestamp: "2025-01-01T00:00:02Z",
				// 助手消息正文按旧格式手写，下面 test 元数据只是夹具。
				message: {
					// 角色标为助手，测试不会调用模型。
					role: "assistant",
					// 助手正文使用单文本块数组。
					content: [{ type: "text", text: "hello" }],
					// 旧夹具的占位 API 字段通过断言容纳，不作为真实 API 请求使用。
					api: "test",
					// 供应商占位字符串。
					provider: "test",
					// 模型占位字符串。
					model: "test",
					// 旧用量缺少当前类型的 totalTokens/cost，是为迁移测试保留的历史形状；本例不测试补用量。
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					// 人工标记正常停止，仅作存储载荷。
					stopReason: "stop",
					// 固定消息毫秒时间，和外层字符串格式不同。
					timestamp: 2,
				},
			},
			// as 让旧对象按当前联合类型传入，擦除后仍是原普通对象；不会补出缺少字段。
		] as FileEntry[];

		// 原地执行缺少的版本迁移；返回 void，后续直接观察同一数组。
		migrateSessionEntries(entries);

		// Header should have version set (v3 is current after hookMessage->custom migration)
		// 检查会话头最终标为当前 v3；原 any 绕开联合类型字段限制，不执行转换。
		expect((entries[0] as any).version).toBe(3);

		// Entries should have id/parentId
		// 按固定位置取第一条消息，用原 any 读取迁移新添字段。
		const msg1 = entries[1] as any;
		// 取第二条消息，与第一条的 id 比较父子链。
		const msg2 = entries[2] as any;

		// 迁移必须给第一条消息补 id。
		expect(msg1.id).toBeDefined();
		// 检查该次随机生成 id 的长度为8；不证明对所有输入不会发生碰撞。
		expect(msg1.id.length).toBe(8);
		// 第一条消息必须为根，不能以会话头为父节点。
		expect(msg1.parentId).toBeNull();

		// 第二条消息也必须得到 id。
		expect(msg2.id).toBeDefined();
		// 第二条新 id 的长度同样为8。
		expect(msg2.id.length).toBe(8);
		// 迁移把旧线性次序连接成第一条→第二条。
		expect(msg2.parentId).toBe(msg1.id);
	});

	// 输入已有 id/parentId 的 v2 记录，调用一次迁移后检查这些字段保留；本例没有连调两次证明全部幂等性质。
	it("should be idempotent (skip already migrated)", () => {
		// FileEntry[] 在开发期表示“会话头或条目”的数组；这里通过末尾 as 保留故意缺字段的历史夹具。
		const entries: FileEntry[] = [
			// v2 头表示已补完树字段，后续只需要 v2→v3 的迁移。
			{ type: "session", id: "sess-1", version: 2, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				// 这是消息条目，message 内再保存具体角色与内容。
				type: "message",
				// 人为固定第一条消息 id，后面验证迁移没有重新生成它。
				id: "abc12345",
				// null 表示第一条是树根。
				parentId: null,
				// 外层时间用于条目存储，不是消息内部的毫秒时间。
				timestamp: "2025-01-01T00:00:01Z",
				// 手写固定用户消息，没有任何真实用户输入。
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				// 这是消息条目，message 内再保存具体角色与内容。
				type: "message",
				// 人为固定第二条消息 id，便于检查升级后仍相同。
				id: "def67890",
				// 第二条的父 id 指向第一条，表示已迁移的线性链。
				parentId: "abc12345",
				// 固定第二条记录时间，迁移应专注格式而不重写消息时序。
				timestamp: "2025-01-01T00:00:02Z",
				// 助手消息正文按旧格式手写，下面 test 元数据只是夹具。
				message: {
					// 角色标为助手，测试不会调用模型。
					role: "assistant",
					// 助手正文使用单文本块数组。
					content: [{ type: "text", text: "hello" }],
					// 旧夹具的占位 API 字段通过断言容纳，不作为真实 API 请求使用。
					api: "test",
					// 供应商占位字符串。
					provider: "test",
					// 模型占位字符串。
					model: "test",
					// 旧用量缺少当前类型的 totalTokens/cost，是为迁移测试保留的历史形状；本例不测试补用量。
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					// 人工标记正常停止，仅作存储载荷。
					stopReason: "stop",
					// 固定消息毫秒时间，和外层字符串格式不同。
					timestamp: 2,
				},
			},
			// as 让旧对象按当前联合类型传入，擦除后仍是原普通对象；不会补出缺少字段。
		] as FileEntry[];

		// 原地执行缺少的版本迁移；返回 void，后续直接观察同一数组。
		migrateSessionEntries(entries);

		// IDs should be unchanged
		// 升级 v2 时第一条既有 id 不应变化。
		expect((entries[1] as any).id).toBe("abc12345");
		// 第二条既有 id 也应保留。
		expect((entries[2] as any).id).toBe("def67890");
		// 确认父指针仍沿用原来的第一条 id。
		expect((entries[2] as any).parentId).toBe("abc12345");
	});
});
