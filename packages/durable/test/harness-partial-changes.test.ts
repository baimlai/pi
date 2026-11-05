// 用纯内存的流事件和 Chord 草稿验证增量写入；不连接模型或持久化存储。
import { type Op, track } from "@earendil-works/chord/delta";
import { copyJson } from "@earendil-works/chord/json";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type ToolCall,
	ToolCallArgumentsStream,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { LiveState } from "../src/harness/live.ts";
import { PartialChanges, type PartialMessage } from "../src/harness/partial-changes.ts";

// #9265: partial commits reassigned the growing strings of a streamed answer, and Chord compared each one whole.

// 索引访问 LiveState["generation"] 提取字段类型；NonNullable 去掉可选字段的 undefined，要求测试总有 generation。
type Live = { generation: NonNullable<LiveState["generation"]> };

/**
 * A response streaming one text block (started empty) and then one tool call, as a provider produces it: the partial
 * message it mutates and the events it emits. Partial commits go into a tracked document, as Durable's generation does.
 */
// 构造相互独立的流测试夹具，无参数；返回流事件操作、提交操作和已提交值读取器。
// 每次调用新建消息、JSON 参数解析器和追踪器，副作用仅在这些内存对象中；不捕获实现错误。
// 例：argument('{"n":1}')、commit() 后 committed().arguments 为 {n:1}。
function setup() {
	// 先建立模型流会持续原地修改的消息；类型约束在开发时检查字段，不在运行时验证形状。
	const partial: AssistantMessage = {
		// 一个空文本块占 content[0]，后续工具调用固定放 content[1]。
		role: "assistant",
		content: [{ type: "text", text: "" }],
		// 测试元数据不指向真实供应商；这些常量不会触发 API 访问。
		api: "test",
		provider: "test",
		model: "test",
		// 必填用量和各项费用都设为 0；本测试不检验计费。
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		// pending 表示消息仍在增长；timestamp 用固定 0 消除时钟依赖。
		stopReason: "pending",
		timestamp: 0,
	};
	// 记录观察到的增量；take 会取出待写变化，commit/restore 决定写入或归还。
	const changes = new PartialChanges();
	// track<Live> 建立可开启草稿、准备增量操作并采纳新状态的内存追踪器。
	const tracker = track<Live>({ generation: { attempt: 1 } });
	// 与 PartialChanges 内部解析器独立的参数快照解析器，模拟供应商更新 partial 的行为。
	const args = new ToolCallArgumentsStream();
	// 箭头回调接收判别联合事件，并交给待测对象；这里只观察，不订阅网络流。
	const emit = (event: AssistantMessageEvent) => changes.observe(event);
	// 二维数组逐次保存提交产生的操作列表，供后面精确检查追加而非整串赋值。
	const ops: Op[][] = [];
	// 对象属性简写将闭包中的同一消息、追踪器和操作数组暴露给测试。
	return {
		partial,
		tracker,
		ops,
		// 输入一个文本片段，无返回值；先改消息再发事件。例 text("Hi") 把首块扩成 Hi。
		text(delta: string) {
			// as 只告诉 TypeScript 首块的形状，不做运行检查；+= 在这份供应商快照上增长字符串。
			(partial.content[0] as { text: string }).text += delta;
			// contentIndex 指向首块，delta 是本次新片段，partial 是已被更新的整条消息引用。
			emit({ type: "text_delta", contentIndex: 0, delta, partial });
		},
		// 输入原始 JSON 的一个片段并更新工具参数，无返回值；例先传 {"n": 再传 1}。
		argument(delta: string) {
			// 第一次才创建工具调用并发送开始事件，让待测对象为索引 1 建立解析器。
			if (partial.content[1] === undefined) {
				partial.content.push({ type: "toolCall", id: "c1", name: "write", arguments: {} });
				emit({ type: "toolcall_start", contentIndex: 1, partial });
			}
			// append 返回当前能解析出的对象快照；Record<string, unknown> 表示键是字符串、值尚无具体类型。
			(partial.content[1] as { arguments: Record<string, unknown> }).arguments = args.append(delta);
			// 同时把原始片段交给待测对象自己的解析器，不能只传最新快照。
			emit({ type: "toolcall_delta", contentIndex: 1, delta, partial });
		},
		/** The provider ends both blocks. */
		// 无参数也不返回数据；按当前快照发送两个块结束事件。必须先创建工具块再调用。
		// 结束后 PartialChanges 放弃该块的增量计划，下一次提交以最终值为准。
		endBlocks() {
			// 取首块此刻的完整文本，模拟供应商可能在结束时替换文本。
			emit({ type: "text_end", contentIndex: 0, content: (partial.content[0] as { text: string }).text, partial });
			// 工具结束事件携带完整 ToolCall；as 不校验它，夹具的 argument 保证索引位置。
			emit({ type: "toolcall_end", contentIndex: 1, toolCall: partial.content[1] as ToolCall, partial });
		},
		/** One partial commit, as the generation's throttle makes it; `fail` aborts it like a rejected commit. */
		// 输入是否模拟提交失败（默认 false），无返回值；失败只回滚草稿并恢复参数增量。
		// 例 commit(true) 后 committed() 仍读旧状态；错误未被捕获，会使用例失败。
		commit(fail = false) {
			// As the generation copies it: `copyJson()` returns untyped JSON, here a message's JSON representation.
			// 复制后 take 可改副本中的参数字段，不污染模拟供应商持有的 partial。
			const message = copyJson(partial) as PartialMessage;
			// 取出本轮待写增量和快照；这一步会清空已取出的缓冲。
			const taken = changes.take(message);
			// beginChange 创建可变草稿，尚未改变 tracker.value 的已提交值。
			const change = tracker.beginChange();
			// 将消息以及参数增量应用到草稿的 generation；还没有采纳这份草稿。
			changes.commit(change.state.generation, message, taken);
			// 用失败分支模拟存储拒绝：不准备或采纳草稿。
			if (fail) {
				// 关闭这次草稿变更；已提交状态保留。
				change.abort();
				// 归还取出的工具参数变化，下次提交先应用它们；不假称这里恢复所有文本增量。
				changes.restore(taken);
				// 提前退出，不把失败提交记入 ops。
				return;
			}
			// prepare 生成待采纳状态及其操作，不等于发布状态。
			const prepared = change.prepare();
			// 展开语法复制操作列表用于断言；这里不深复制每条操作。
			ops.push([...prepared.ops]);
			// adopt 才让追踪器的新已提交状态可见。
			tracker.adopt(prepared);
		},
		// 无参数，投影读取已提交文本和参数，方便断言；调用前需至少成功提交一次消息。
		committed() {
			// 只把这个夹具使用到的两个字段告诉 TypeScript，未增加运行校验。
			const message = tracker.value.generation.message as { content: { text?: string; arguments?: unknown }[] };
			// 可选链允许工具块尚未出现，此时 arguments 返回 undefined。
			return { text: message.content[0]?.text, arguments: message.content[1]?.arguments };
		},
	};
}

// 将 text 按 size 个 UTF-16 码元切成数组，无外部副作用；本文件调用均给正数 size。
// 例 pieces("abc", 2) 得 ["ab", "c"]；不保证按 Unicode 字符边界分割，也不自行校验 size。
function pieces(text: string, size: number): string[] {
	// 收集片段，每轮从 index 截到 index + size（不含结束位置）。
	const result: string[] = [];
	// 步长为 size，最后不足一段时 slice 自动截到字符串末尾。
	for (let index = 0; index < text.length; index += size) result.push(text.slice(index, index + size));
	// 返回新数组，原字符串不变。
	return result;
}

// 参数样本覆盖数字、布尔、转义、Unicode、长字符串、数组与嵌套对象；不是工具参数 schema。
const ARGUMENTS = {
	path: "src/a.ts",
	n: 1234,
	ok: true,
	content: 'line "one"\n\tline \\ two é 😀\n',
	edits: [
		{ oldText: "a", newText: "b\nc" },
		{ oldText: "", newText: "x".repeat(50) },
	],
	nested: { deep: { list: [1, [2, "three"], { four: null }] } },
};

// 每个同步测试回调仅操纵自己的内存夹具；任何差异都由 expect 抛错报告。
describe("PartialChanges", () => {
	// 无输入用例：枚举分片长度与提交频率，最终值必须等于完整 JSON 解析；不证明所有任意输入。
	it("commits tool-call arguments equal to the final parse, at every piece size and commit rhythm", () => {
		// 先生成完整合法 JSON，再人为切碎为供应商流片段。
		const text = JSON.stringify(ARGUMENTS);
		// 六种片段大小分别配三种提交间隔；每一组合独立建夹具。
		for (const size of [1, 2, 3, 5, 7, 16]) {
			for (const every of [1, 3, 10]) {
				const stream = setup();
				// forEach 的 index 从 0 开始；每满 every 片就写一次草稿。
				pieces(text, size).forEach((piece, index) => {
					// 每个片段立即解析并提交，不等待完整 JSON 才更新快照。
					stream.argument(piece);
					if (index % every === every - 1) stream.commit();
				});
				// 写完最后不足 every 片的尾巴，然后比较对象值而非字符串排版。
				stream.commit();
				expect(stream.committed().arguments, `size ${size}, every ${every}`).toEqual(ARGUMENTS);
			}
		}
	});

	// 固定碎片刻意跨数字、转义和 UTF-16 代理对边界；逐片提交，最后检查 n=12、转义字符串和布尔值。
	it("handles a number ending and a string starting in one piece, and escapes split across pieces", () => {
		const stream = setup();
		// 碎片里的反斜杠先按 TypeScript 字符串规则解码，随后才成为 JSON 解析器输入。
		for (const piece of [
			'{"n":1',
			'2,"s":"a',
			"b\\",
			'u00e9\\"',
			"q\\u",
			"00",
			"41",
			'","t":tr',
			"ue,",
			'"u":"\\ud83d',
			'\\ude00"}',
		]) {
			stream.argument(piece);
			stream.commit();
		}
		expect(stream.committed().arguments).toEqual({ n: 12, s: 'abé"qA', t: true, u: "😀" });
	});

	// 从 Hello 和未闭合参数字符串开始增长 20 次，检查后续每轮只产生两个追加操作。
	// 这是固定轨迹的操作断言，不是墙钟性能基准。
	it("appends growing argument and text strings instead of reassigning them", () => {
		const stream = setup();
		// 第一次提交建立消息块，后面才有可追加的已提交字符串。
		stream.text("Hello");
		stream.argument('{"path":"a.ts","content":"x');
		stream.commit();
		// 每轮文本增加 " more"，参数 content 增加 "yz"，并立即提交。
		for (let index = 0; index < 20; index++) {
			stream.text(" more");
			stream.argument("yz");
			stream.commit();
		}
		// 跳过建立消息的首轮；操作码 a 表示向所列路径追加末尾片段。
		for (const ops of stream.ops.slice(1)) {
			expect(ops).toEqual([
				["a", ["generation", "message", "content", 0, "text"], " more"],
				["a", ["generation", "message", "content", 1, "arguments", "content"], "yz"],
			]);
		}
		// repeat 计算应有完整值，补充证明追加操作没有遗漏或重复内容。
		expect(stream.committed()).toEqual({
			text: `Hello${" more".repeat(20)}`,
			arguments: { path: "a.ts", content: `x${"yz".repeat(20)}` },
		});
	});

	// 中间提交失败后继续接收后缀；下一次成功提交必须重放失败批次，最终 a=xy、b=[1,2]、c=z。
	it("applies the changes of a failed commit in the next one", () => {
		const stream = setup();
		stream.argument('{"a":"x');
		stream.commit();
		stream.argument('y","b":[1');
		stream.commit(true);
		stream.argument(',2],"c":"z"}');
		stream.commit();
		expect(stream.committed().arguments).toEqual({ a: "xy", b: [1, 2], c: "z" });
	});

	// 先提交只有文本的消息，再让首次加入工具调用的提交失败，确认恢复时仍能创建参数 a=xy。
	it("re-applies a failed commit's changes even when it would have added the call", () => {
		const stream = setup();
		stream.commit();
		stream.argument('{"a":"x');
		stream.commit(true);
		stream.argument('y"');
		stream.commit();
		expect(stream.committed().arguments).toEqual({ a: "xy" });
	});

	// 模拟另一写入者清空 generation 后继续流：旧增量已用过，必须回退当前参数快照再继续。
	it("falls back to the snapshot when the committed message lost a call whose changes were committed", () => {
		const stream = setup();
		stream.argument('{"a":"x');
		stream.commit();
		// Another writer resets the generation's partial.
		// 单独开启并采纳一份只剩 attempt 的草稿，使已提交消息丢失工具块。
		const change = stream.tracker.beginChange();
		change.state.generation = { attempt: 1 };
		stream.tracker.adopt(change.prepare());
		stream.argument('y"');
		stream.commit();
		expect(stream.committed().arguments).toEqual({ a: "xy" });
		stream.argument(',"b":2}');
		stream.commit();
		expect(stream.committed().arguments).toEqual({ a: "xy", b: 2 });
	});

	// 在结束事件前直接替换快照中的文本/参数；最后提交应为 replaced 和 {a:final}，不能重复追加旧片段。
	it("commits the final arguments after the call ends, and drops text appends when a block ends", () => {
		const stream = setup();
		stream.text("draft");
		stream.argument('{"a":"x');
		stream.commit();
		// Providers may replace a block's text and arguments as it ends; the last commit assigns what they ended with.
		stream.text(" more");
		// 绕过 text() 直接模拟供应商最终修订；这是夹具写入，不是生产对象的运行校验。
		(stream.partial.content[0] as { text: string }).text = "replaced";
		stream.partial.content[1] = { type: "toolCall", id: "c1", name: "write", arguments: { a: "final" } };
		stream.endBlocks();
		stream.commit();
		expect(stream.committed()).toEqual({ text: "replaced", arguments: { a: "final" } });
	});
});
