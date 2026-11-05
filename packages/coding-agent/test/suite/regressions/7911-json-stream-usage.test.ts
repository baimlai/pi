import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { createHarness, type Harness } from "../harness.ts";

// 组织 #7911：去掉快照之后，固定字段数量的累计 token/费用用量仍须保留。
describe("regression #7911: JSON message updates retain usage", () => {
	// 联合类型允许初始化前尚无会话。
	let harness: Harness | undefined;

	// 每例后释放会话与临时目录；清理不依赖断言是否通过。
	afterEach(() => {
		// 有值才清理，本回调没有再把变量设回 undefined。
		harness?.cleanup();
	});

	// 创建 faux 会话、收集带非零用量的内部更新、转成传输事件再断言字段。
	// 例如 hello 的更新应保留 usage，删除 message/partial；不请求真实计费模型。
	it("includes cumulative usage without cumulative message snapshots", async () => {
		// 初始化本地 faux 模型和会话，并存入外层变量供 afterEach 使用。
		harness = await createHarness();
		// 给模型预置一条短回复，用量由 faux 生成。
		harness.setResponses([fauxAssistantMessage("hello")]);

		// 等待响应和内部事件记录完成。
		await harness.session.prompt("respond");

		// #7290's delta-only wire projection dropped this fixed-size metadata with the snapshots.
		// 链式调用跨多行：从 harness 获取更新数组，再寻找符合条件的第一项。
		const update = harness
			// 先按事件标签过滤，返回具体更新事件数组。
			.eventsOfType("message_update")
			// && 短路先检查助手标签再读取其 usage，find 未匹配时返回 undefined。
			.find((event) => event.message.role === "assistant" && event.message.usage.totalTokens > 0);
		// 运行时确认查找成功并收窄消息联合，便于后面安全访问助手用量。
		if (!update || update.message.role !== "assistant") {
			// 没有合适样本就明确使测试失败，避免拿空值继续投影。
			throw new Error("Expected an assistant update with populated usage");
		}

		// 将内部更新投影为 JSON/RPC 协议数据，此处不实际 stringify 或发送。
		const wireUpdate = toJsonEvent(update);
		// 深比较累计用量值；此断言不要求二者必须是同一对象引用。
		expect(wireUpdate.usage).toEqual(update.message.usage);
		// 用量被保留不应把整个消息快照一同带回。
		expect(wireUpdate).not.toHaveProperty("message");
		// 增量事件里的另一份累积快照同样不能出现。
		expect(wireUpdate.assistantMessageEvent).not.toHaveProperty("partial");
	});
});
