// 问题 #5217：扩展收到的压缩原因和 willRetry 必须区分手动、阈值与溢出；摘要由扩展固定提供，不调用真实摘要模型。
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

// 局部结构类型暴露私有自动压缩方法供测试访问；类型声明本身不会修改会话实例。
type SessionWithCompactionInternals = {
	// 函数字段签名：原因只允许两种字面量、是否续跑是布尔值，异步返回是否应重试；不检查实际模型是否发生过溢出。
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

// interface 描述记录数组元素的静态形状，不产生运行时校验器。
interface RecordedCompactionEvent {
	// 事件名联合类型，区分压缩前与完成后的通知。
	type: "session_before_compact" | "session_compact";
	// 原因字段必须是三个已知字面量之一。
	reason: "manual" | "threshold" | "overflow";
	// 记录压缩调用者是否打算在完成后重试原回合，不等于本测试真的重试。
	willRetry: boolean;
}

// 输入可变事件数组，返回扩展工厂；注册前后两种压缩监听并把观察值追加到同一数组。例：手动压缩记录两个 manual/false 项；摘要在此固定生成。
function recordingExtension(recorded: RecordedCompactionEvent[]): ExtensionFactory {
	// 返回以后由 harness 调用的工厂函数，接收扩展 API；不是现在立刻压缩。
	return (pi) => {
		// 异步压缩前回调接收准备数据，先记录原因，再返回替代摘要，省去模型摘要请求。
		pi.on("session_before_compact", async (event) => {
			// 从事件复制三个待测字段到共享数组，保留回调到达顺序。
			recorded.push({ type: event.type, reason: event.reason, willRetry: event.willRetry });
			// 返回扩展压缩结果；这个对象使会话采用本地摘要，不消费额外 faux 回复。
			return {
				// compaction 字段是完整替代压缩结果，和单纯观察事件不同。
				compaction: {
					// 固定摘要文字只作为测试夹具，不对历史内容做真实总结。
					summary: "summary from extension",
					// 沿用真实准备阶段选出的首个保留条目 id，避免编造不存在的切点。
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					// 沿用准备阶段估算的压缩前 token 数，不在此重新计数。
					tokensBefore: event.preparation.tokensBefore,
					// 提供空详情对象；本测试不关心文件列表等附加内容。
					details: {},
				},
			};
		});
		// 完成通知回调也记录相同字段，不返回替代结果或执行 I/O。
		pi.on("session_compact", async (event) => {
			// 从事件复制三个待测字段到共享数组，保留回调到达顺序。
			recorded.push({ type: event.type, reason: event.reason, willRetry: event.willRetry });
		});
	};
}

// 输入记录数组，异步返回已有两轮历史的测试环境；安装本地摘要扩展、消费 one/two 两项 faux 回复。例：之后 compact 可得到前后两个记录；调用者负责 cleanup。
async function createCompactionHarness(recorded: RecordedCompactionEvent[]): Promise<Harness> {
	// 异步创建配置化测试环境；下面选项决定扩展、工具或重试设置，await 等初始化完成。
	const harness = await createHarness({
		// 保留近期 token 预算设为 1，确保两轮短历史也能准备可压缩范围。
		settings: { compaction: { keepRecentTokens: 1 } },
		// 用传入同一数组构造记录扩展，闭包会在未来通知时修改它。
		extensionFactories: [recordingExtension(recorded)],
	});
	// 只准备建立历史的两条普通回复，不准备真实摘要请求。
	harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	// 完成 first/one 这一轮，形成可压缩历史。
	await harness.session.prompt("first");
	// 再完成 second/two，留下足够历史供三个原因测试共用。
	await harness.session.prompt("second");
	// 把已初始化环境交回；本 helper 不登记或释放它，调用方添加到清理数组。
	return harness;
}

// 注册三种原因的用例；后两例直接调用私有方法，验证事件字段传播，不模拟真正阈值或上下文溢出。
describe("issue #5217 compaction reason on extension events", () => {
	// 保存本组创建的测试环境；Harness[] 是元素类型为 Harness 的数组，清理时逐一释放临时目录和 faux 注册。
	const harnesses: Harness[] = [];

	// 每个用例结束后执行清理回调；无参数、无业务返回值，断言失败时 Vitest 也会安排它运行。
	afterEach(() => {
		// 只要还有测试环境，就从尾部取出一个，避免 faux 供应商和会话订阅泄漏到下一例。
		while (harnesses.length > 0) {
			// pop 取出并移除最后一项；?. 在数组意外为空时跳过，cleanup 释放会话、注销 faux 并删本环境临时目录。
			harnesses.pop()?.cleanup();
		}
	});

	// 无输入异步用例：通过公开 compact 触发手动压缩，要求前后通知均为 manual 且 willRetry=false。
	it("reports manual reason for compact()", async () => {
		// 每例单独收集事件，避免上一例记录导致错误的数组长度或顺序。
		const recorded: RecordedCompactionEvent[] = [];
		// 完成两轮 faux 对话后取得环境，压缩前后监听器已连接。
		const harness = await createCompactionHarness(recorded);
		// 把已创建环境登记到清理数组；这不复制环境对象，后面操作和清理使用同一实例。
		harnesses.push(harness);

		// 等待公开手动压缩路径完成；固定扩展结果代替默认摘要。
		await harness.session.compact();

		// 深比较全部记录，要求恰好按“压缩前、压缩后”顺序，且原因和 willRetry 无丢失。
		expect(recorded).toEqual([
			{ type: "session_before_compact", reason: "manual", willRetry: false },
			{ type: "session_compact", reason: "manual", willRetry: false },
		]);
	});

	// 无输入异步用例：直接以 threshold/false 调私有自动压缩方法，检查传到扩展的字段；不验证阈值触发条件。
	it("reports threshold reason for auto-compaction", async () => {
		// 每例单独收集事件，避免上一例记录导致错误的数组长度或顺序。
		const recorded: RecordedCompactionEvent[] = [];
		// 完成两轮 faux 对话后取得环境，压缩前后监听器已连接。
		const harness = await createCompactionHarness(recorded);
		// 把已创建环境登记到清理数组；这不复制环境对象，后面操作和清理使用同一实例。
		harnesses.push(harness);
		// 双重 as 只绕过 TS 私有访问限制，运行时仍调用原会话方法，没有新增方法或运行时检查。
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		// 直接选择阈值路径并等待其收尾，false 表示完成后不要求续跑。
		await sessionInternals._runAutoCompaction("threshold", false);

		// 深比较全部记录，要求恰好按“压缩前、压缩后”顺序，且原因和 willRetry 无丢失。
		expect(recorded).toEqual([
			{ type: "session_before_compact", reason: "threshold", willRetry: false },
			{ type: "session_compact", reason: "threshold", willRetry: false },
		]);
	});

	// 无输入异步用例：直接传 overflow/true，要求前后事件原样带上原因和续跑意图；不制造真实超窗错误。
	it("reports overflow reason and willRetry for overflow recovery", async () => {
		// 每例单独收集事件，避免上一例记录导致错误的数组长度或顺序。
		const recorded: RecordedCompactionEvent[] = [];
		// 完成两轮 faux 对话后取得环境，压缩前后监听器已连接。
		const harness = await createCompactionHarness(recorded);
		// 把已创建环境登记到清理数组；这不复制环境对象，后面操作和清理使用同一实例。
		harnesses.push(harness);
		// 双重 as 只绕过 TS 私有访问限制，运行时仍调用原会话方法，没有新增方法或运行时检查。
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		// 直接选择溢出路径并携带将重试的意图，测试只检查事件，不执行后续恢复请求。
		await sessionInternals._runAutoCompaction("overflow", true);

		// 深比较全部记录，要求恰好按“压缩前、压缩后”顺序，且原因和 willRetry 无丢失。
		expect(recorded).toEqual([
			{ type: "session_before_compact", reason: "overflow", willRetry: true },
			{ type: "session_compact", reason: "overflow", willRetry: true },
		]);
	});
});
