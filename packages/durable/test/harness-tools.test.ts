// 所属包与模块：packages/durable/test，Durable harness 的工具执行集成测试（pi-durable 的 ToolTask 与生成钩子）。
// 解决的问题：验证模型发起的工具调用如何变成 durable task、如何校验/修补参数、运行前后的钩子如何改变结果，
// 以及输出截断、进度上报、取消和重启恢复等边界；同时覆盖内置 coding tools 的真实文件读写与 bash 执行。
// 职责边界：测试只通过公开 API（Harness.open、Conversation.submit、Registry.install）驱动运行时，
// 不直接调用 ToolTask 的内部函数，也不替换调度器，因此断言的是端到端可见结果。
// 上游入口：chatSetup/openChat 构造 faux provider、注册表与根会话；run() 提交一条 "go" 输入并等待完成。
// 下游依赖：pi-durable 的 ToolTask/GenerationTask、pi-ai faux 模型、pi-schema、NodeExecutionEnv 与 MemoryStorage。
// 测试夹具/假实现：
// - chatSetup()：faux 模型 + createModels + 注册表 + 可变的 settings，并收集 reports/infos；
// - openChat()：用 MemoryStorage 打开 Harness，根会话绑定 faux/faux-1 模型；
// - addTool/addHooks/addTask：把工具、钩子或任务扩展安装进注册表，返回卸载句柄；
// - NodeExecutionEnv：真实临时目录中的文件与进程环境，只在 coding tools 分组使用；
// - deferred/aborted：手动控制 Promise 与取消信号，用来安排并发时序。
// 覆盖的主要行为分组（describe）：
// 1. tool round：一轮里的工具调用、结果条目、工具可用性、执行模式与并发顺序；
// 2. tool results：输出/详情/诊断的优先级、截断、异常、耗时，以及 beforeTool/afterTool 链；
// 3. generation hooks：beforeRequest/afterResponse/onYield/beforeProviderRequest 与任务 memo；
// 4. tool execution api：每次调用构建环境，以及 commit/memo/createTask/waitForTask；
// 5. coding tools：bash 失败输出，以及 read/edit/bash 的端到端效果；
// 6. tool progress and lifetime：默认输出限制、进度合并、实现替换/扩展重载与取消。
// 本文件的辅助能力（均不导出，只在测试内使用）：
// - tool(name, execute, extra?)：用同一个 EchoParameters schema 构造 ToolRegistration；
// - calls(...)：构造带若干 toolCall 的 faux 助手消息；
// - DONE：不带工具调用的停止消息；
// - run(setup, responses, prepare?, options?)：设置 faux 响应、打开会话、可选准备、提交并收集条目；
// - results(entries)：只取出 ToolResultEntry 里的 ToolResultMessage；
// - resultText(message)：把文本块与非文本块压成便于断言的字符串。
// 组合与典型调用顺序：chatSetup → addTool/addHooks → run 设置响应并打开会话 → 提交输入 → 等待终态 → 读取条目。
// 示例（使用本文件真实签名）：
//   const setup = chatSetup();
//   addTool(setup.registry, tool("echo", async (args) => ({ output: [{ type: "text", text: args.text ?? "" }] })));
//   const { entries, status } = await run(setup, [calls(["echo", { text: "hi" }, "c1"]), DONE]);
//   // status 为 "done"；entries 依次是 pi.user、pi.system、pi.assistant、pi.tool-result、pi.assistant。
// 运行命令（在仓库根目录或 packages/durable 下）：
//   node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness-tools.test.ts
//   Durable 会导入已构建的 pi-ai utils/*；若 dist 缺失，需要在允许构建的环境执行 npm run build。
// 建议阅读顺序：先看 tool/calls/run 三个夹具，再按 describe 顺序读；每个 it 的断言对应 ToolTask 的一段行为。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Models,
	type SystemMessage,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type Conversation,
	configure,
	defineExtension,
	defineTask,
	defineTool,
	type EntryRecord,
	GenerationTask,
	type Harness,
	hook,
	LiveDoc,
	MemoryStorage,
	type SubmissionId,
	section,
	type ToolRegistration,
	ToolResultEntry,
	ToolTask,
} from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { createBashTool, createEditTool, createReadTool } from "../src/tools/index.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf } from "./chat-support.ts";
import { addHooks, addTask, addTool, type Installed } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";

// 所有测试工具共用的参数 schema：text 是可选字符串；obj/opt/str 由 pi-schema 提供。
// schema 同时供运行时参数校验和 defineTool 的类型推导使用。
const EchoParameters = obj({ text: opt(str()) });
// ToolRegistration 是带 schema 泛型的工具登记类型；typeof 取出 schema 的值类型。
// Echo 固定了本文件的参数形状，避免每个工具重复声明。
type Echo = ToolRegistration<typeof EchoParameters>;
// 索引访问类型：从 Echo 上取出 execute 属性的函数类型，供下面的工具构造函数复用。
// 这样工具实现的参数会自动得到 { text?: string } 的静态类型。
type Execute = Echo["execute"];

// 构造测试工具：统一名称描述与参数 schema，extra 可覆盖 deferred、executionMode、
// outputLimits、prepareArguments 等可选字段。defineTool 只提供类型辅助，返回对象原样包含 execute，
// 此处不会执行工具；spread 放在最后，使 extra 能覆盖前面的默认字段。
function tool(name: string, execute: Execute, extra: Partial<Echo> = {}): Echo {
	return defineTool({ name, description: `The ${name} tool`, parameters: EchoParameters, execute, ...extra });
}

/** A tool-calling answer with one call per `[name, args, id]`. */
// 把 [name, args, id] 列表映射为 fauxToolCall，并显式标记 stopReason:"toolUse"。
// 一次模型响应因此可以携带多个调用；id 用于把后续 ToolResultMessage 关联回调用。
// 参数类型是只读元组数组，解构时 name/args/id 都保持 string/Record/string。
function calls(...list: readonly (readonly [string, Record<string, JsonValue>, string])[]): AssistantMessage {
	return fauxAssistantMessage(
		list.map(([name, args, id]) => fauxToolCall(name, args, { id })),
		{ stopReason: "toolUse" },
	);
}

// 普通的停止响应：没有 toolCall，模型循环收到它后结束本轮生成。
const DONE = fauxAssistantMessage([fauxText("done")]);

// 测试主流程：先设置 faux 响应队列，再用新的 MemoryStorage 打开会话。
// prepare 在提交输入前拿到 harness 与 root，用来动态配置工具/扩展；随后提交 "go" 并等待提交终态。
// submit 返回 Submission，wait 等待终态（两层 await）；status 是终态字符串，entries 由 allEntries 按时间顺序读取。
async function run(
	setup: ChatSetup,
	responses: FauxResponseStep[],
	prepare?: (harness: Harness, root: Conversation) => Promise<void>,
	options: Parameters<typeof openChat>[2] = {},
): Promise<{ harness: Harness; root: Conversation; entries: EntryRecord[]; status: string }> {
	// faux provider 按请求顺序消费响应队列；每次模型请求取一项，队列耗尽会报错。
	setup.faux.setResponses(responses);
	const { harness, root } = await openChat(new MemoryStorage(), setup, options);
	// 可选准备工作：测试用它在第一次生成之前安装工具或调整会话配置。
	// ?. 只在 prepare 有定义时调用；await 兼容同步或异步回调。
	await prepare?.(harness, root);
	const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
	return { harness, root, entries: await allEntries(root), status: settled.status };
}

// 从全部条目中筛出工具结果：ToolResultEntry.is 是类型谓词，过滤后 TS 把 entry 收窄为 ToolResultEntry。
// model![0] 是该条目的 ToolResultMessage；! 断言索引结果非空，测试夹具保证存在。
function results(entries: readonly EntryRecord[]): ToolResultMessage[] {
	return entries.filter((entry) => ToolResultEntry.is(entry)).map((entry) => entry.model![0] as ToolResultMessage);
}

// 把消息内容压成断言字符串：文本块原样拼接，图片等非文本块显示为 [image]；
// join("|") 保留块之间的边界与顺序。Harness 追加的诊断也是文本块，因此会出现在结果末尾。
function resultText(message: ToolResultMessage): string {
	return message.content.map((item) => (item.type === "text" ? item.text : `[${item.type}]`)).join("|");
}

// 工具回合：一次用户输入如何驱动工具调用、结果写入 transcript，以及调用可用性和执行模式。
describe("tool round", () => {
	// 完整回合：用户输入 → 系统准备 → 模型调用工具 → 工具结果 → 模型总结。
	// 断言条目顺序、系统消息里的 toolsAdded、结果条目的 data/byTaskId，以及结束后 pi.live 被清空。
	it("runs input, tool call, tool result, and answer, and settles the input", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("echo", async (args) => ({
				output: [{ type: "text", text: `echo ${args.text}` }],
			})),
		);
		const { harness, root, entries, status } = await run(setup, [calls(["echo", { text: "hi" }, "c1"]), DONE]);
		expect(status).toBe("done");
		// 精确断言 transcript 的条目种类顺序；pi.system 由生成准备阶段写入。
		expect(entries.map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.system",
			"pi.assistant",
			"pi.tool-result",
			"pi.assistant",
		]);
		const system = entries[1]!.model![0] as SystemMessage;
		// toolsAdded 记录本轮新提供给模型的工具；expect.any(Object) 只要求参数 schema 是对象。
		expect(system.toolsAdded).toEqual([
			{ name: "echo", description: "The echo tool", parameters: expect.any(Object) },
		]);
		const [result] = results(entries);
		expect(result).toMatchObject({ toolCallId: "c1", toolName: "echo", isError: false });
		expect(resultText(result!)).toBe("echo hi");
		// 类型谓词与 && 结合：通过 is 后再访问 data，断言本结果没有诊断。
		expect(ToolResultEntry.is(entries[3]) && entries[3].data).toEqual({ diagnostics: [] });
		// byTaskId 记录产生该条目的工具任务；! 绕过索引可能为 undefined 的类型检查。
		expect(entries[3]!.byTaskId).toBeDefined();
		// The second request sees the tool result right after its call.
		expect(setup.faux.state.callCount).toBe(2);
		// 提交完成后实时文档 pi.live 应为空，不残留工具槽位。
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		await harness.close(context);
	});

	// #10395
	// #10395：工具 execute 的 api.models 与 beforeTool 的 api.models 必须是同一个对象，
	// 且包含宿主注册的 provider；避免每次调用各自包装 Models 导致身份或内容不一致。
	it("gives tools and hooks the Harness's models", async () => {
		const setup = chatSetup();
		const seen: unknown[] = [];
		addTool(
			setup.registry,
			// 工具实现拿到第二个参数 api（ToolExecutionApi）；下面记录它的 models 视图。
			tool("echo", async (_args, api) => {
				seen.push(api.models);
				return { output: [] };
			}),
		);
		addHooks(setup.registry, ToolTask, {
			// beforeTool 的第二个参数同样是 api；下划线前缀表示本测试不使用调用信息。
			beforeTool: (_call, api) => {
				seen.push(api.models);
				return undefined;
			},
		});
		const { harness, status } = await run(setup, [calls(["echo", {}, "c1"]), DONE]);
		expect(status).toBe("done");
		// One view of the host's Models that adds the Harness identity, shared by tools and hooks.
		expect(seen).toHaveLength(2);
		// toBe 比较引用身份，而不是结构相等：两者必须是同一个 Models 对象。
		expect(seen[0]).toBe(seen[1]);
		expect((seen[0] as Models).getProviders()).toEqual(setup.models.getProviders());
		await harness.close(context);
	});

	// 模型调用了请求中未提供的工具 ghost：仍生成一条 tool-result 错误，但该任务带 unoffered 标记。
	// 这样 afterTool/control 等通用机制照常作用，同时不解析该工具名（#11043）。
	it("answers calls to tools the request did not offer through a flagged tool task", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("echo", async () => ({ output: [] })),
		);
		const { harness, root, entries, status } = await run(setup, [
			calls(["ghost", {}, "c1"], ["echo", {}, "c2"]),
			DONE,
		]);
		expect(status).toBe("done");
		const [ghost, echo] = results(entries);
		expect(ghost).toMatchObject({ toolCallId: "c1", isError: true });
		// harnessError 的诊断会渲染成 <harness> 文本块追加在结果内容后。
		expect(resultText(ghost!)).toBe("<harness>\n[error] Tool ghost is not available\n</harness>");
		expect(echo).toMatchObject({ toolCallId: "c2", isError: false });
		// 找到 ghost 的结果条目；两个 ! 分别排除 entry 与 model[0] 的 undefined，role 用来确认消息类型。
		const ghostEntry = entries.find((entry) => ToolResultEntry.is(entry) && entry.model![0]!.role === "toolResult");
		expect(ghostEntry?.data).toEqual({
			diagnostics: [{ severity: "error", code: "tool_unavailable", message: "Tool ghost is not available" }],
		});
		// #11043: the unoffered call has its own task, so `afterTool` and `control` apply to it as to any call.
		// scanTasks 在一个只读事务里列出该会话的任务；随后筛出 pi.tool 并检查输入标记。
		const tasks = await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 20), context);
		const inputs = tasks.items.filter((task) => task.kind === "pi.tool").map((task) => task.input);
		expect(inputs).toHaveLength(2);
		expect(inputs).toContainEqual(expect.objectContaining({ callId: "c1", unoffered: true }));
		// 非对称匹配器：另一个调用合法，其输入不应带 unoffered 字段。
		expect(inputs).toContainEqual(expect.not.objectContaining({ unoffered: true }));
		await harness.close(context);
	});

	// #11043
	// #11043：deferred 工具不在本轮的 offer 中；即使 agent 已安装它，也不能执行。
	// ran 保持 0，模型收到 tool_unavailable。
	it("never runs a tool the request did not offer, even when the agent has it", async () => {
		const setup = chatSetup();
		let ran = 0;
		addTool(
			setup.registry,
			tool(
				"hidden",
				async () => {
					ran++;
					return { output: [] };
				},
				// deferred 表示该工具默认隐藏，只有 control.addTools 显式加入后才提供给模型。
				{ deferred: true },
			),
		);
		const { harness, entries, status } = await run(setup, [calls(["hidden", {}, "c1"]), DONE]);
		expect(status).toBe("done");
		expect(ran).toBe(0);
		expect(resultText(results(entries)[0]!)).toBe("<harness>\n[error] Tool hidden is not available\n</harness>");
		await harness.close(context);
	});

	// 模型响应回调在请求准备前把会话工具配置清空；该调用随后解析不到工具。
	// 下一次准备记录 toolsRemoved，说明被移除的是激活集合，而不是删除注册表里的扩展。
	it("answers a call to a tool deactivated after preparation with tool_unavailable", async () => {
		const setup = chatSetup();
		const seen: string[] = [];
		addTool(
			setup.registry,
			tool("echo", async () => {
				seen.push("ran");
				return { output: [] };
			}),
		);
		// 明确赋值断言：root 在 prepare 回调里赋值，而该回调总会在 run 使用它之前执行。
		let root!: Conversation;
		// FauxResponseStep 可以异步执行副作用再返回消息；这里先 configure 清空工具再回答调用。
		const deactivate: FauxResponseStep = async () => {
			// 修改会话存储的 agent 工具选择；空数组表示本轮不提供任何工具。
			await root.configure({ tools: [] }, context);
			return calls(["echo", {}, "c1"]);
		};
		const result = await run(setup, [deactivate, DONE], async (_harness, conversation) => {
			root = conversation;
		});
		expect(seen).toEqual([]);
		expect(resultText(results(result.entries)[0]!)).toBe("<harness>\n[error] Tool echo is not available\n</harness>");
		// The next preparation removes it.
		const systems = result.entries.filter((entry) => entry.kind === "pi.system");
		expect((systems.at(-1)!.model![0] as SystemMessage).toolsRemoved).toEqual([{ name: "echo" }]);
		await result.harness.close(context);
	});

	// 卸载扩展后，已存储的 agent 并不会被重写，只是下一次准备无法解析该工具：
	// 系统消息记录 toolsRemoved，调用得到错误；重新安装后又出现在 toolsAdded 中。
	it("removes unregistered active tools from the offer and adds them back after re-registration", async () => {
		const setup = chatSetup();
		const echo = tool("echo", async () => ({ output: [] }));
		const registration = addTool(setup.registry, echo);
		const first = await run(setup, [DONE]);
		// 卸载后复用同一个会话和 harness 再提交一次；这次输入会触发新一轮准备与生成。
		registration.dispose();
		setup.faux.setResponses([calls(["echo", {}, "c1"]), DONE]);
		const second = await (await first.root.submit({ type: "input", content: "again" }, context)).wait(context);
		expect(second.status).toBe("done");
		let entries = await allEntries(first.root);
		const removal = entries.filter((entry) => entry.kind === "pi.system").at(-1)!.model![0] as SystemMessage;
		expect(removal.toolsRemoved).toEqual([{ name: "echo" }]);
		expect(results(entries)[0]).toMatchObject({ isError: true });
		// The stored agent is not rewritten; the tool is only not resolved.
		// 存储的 agent 仍可选择 echo，但解析后的可用工具为空；这里断言的是解析结果。
		expect((await first.root.agent(context)).tools).toEqual([]);

		addTool(setup.registry, echo);
		setup.faux.setResponses([DONE]);
		await (await first.root.submit({ type: "input", content: "back" }, context)).wait(context);
		entries = await allEntries(first.root);
		const addition = entries.filter((entry) => entry.kind === "pi.system").at(-1)!.model![0] as SystemMessage;
		// 重新安装后，系统消息只记录新增工具的声明名；?. 处理没有 toolsAdded 的情况。
		expect(addition.toolsAdded?.map((declared) => declared.name)).toEqual(["echo"]);
		await first.harness.close(context);
	});

	// 两个调用在同一轮；first 顺序执行，并在执行中卸载 second。
	// second 的任务随后才被调度，解析不到实现，于是 tool_unavailable，而不是运行旧实现。
	it("produces tool_unavailable when the implementation is unregistered before its task runs", async () => {
		const setup = chatSetup();
		// second 的安装句柄在 first 的 execute 闭包里读取；断言赋值保证测试启动前已就绪。
		let second!: Installed;
		addTool(
			setup.registry,
			tool(
				"first",
				async () => {
					// first 声明 executionMode:"sequential"，调度器会等它结束后再启动同轮的 second；
					// 这里在 first 执行期间卸载 second 的扩展，这只影响后续解析，不打断已启动的 first。
					second.dispose();
					return { output: [] };
				},
				{ executionMode: "sequential" },
			),
		);
		second = addTool(
			setup.registry,
			tool("second", async () => ({ output: [{ type: "text", text: "ran" }] })),
		);
		const { harness, entries, status } = await run(setup, [calls(["first", {}, "c1"], ["second", {}, "c2"]), DONE]);
		expect(status).toBe("done");
		const [, late] = results(entries);
		expect(resultText(late!)).toBe("<harness>\n[error] Tool second is not available\n</harness>");
		await harness.close(context);
	});

	// 执行模式在“回合开始”时读取一次：模型请求期间改成 sequential 会作用于本回合；
	// 工具执行开始后再改成 parallel 不影响本回合，因此仍是 a 完成后才 b。
	it("reads the execution mode when a round starts and keeps it for the round", async () => {
		const setup = chatSetup();
		const events: string[] = [];
		const slow =
			(name: string): Execute =>
			async () => {
				events.push(`start ${name}`);
				// Changed after the round started: not seen by this round.
				// 在工具执行中改回 parallel；本轮模式已固定，所以这次修改被忽略。
				setup.settings.toolExecution = "parallel";
				// 下面的 20ms 等待人为延长执行时间，让两个调用如果真并行就会交错 start/end 记录。
				await new Promise((resolve) => setTimeout(resolve, 20));
				events.push(`end ${name}`);
				return { output: [] };
			};
		addTool(setup.registry, tool("a", slow("a")));
		addTool(setup.registry, tool("b", slow("b")));
		// Changed while the model request runs: the round that follows uses it.
		// 在模型请求回调里改配置：这个时点属于回合开始前，因此下一轮会用 sequential。
		const request: FauxResponseStep = () => {
			setup.settings.toolExecution = "sequential";
			return calls(["a", {}, "c1"], ["b", {}, "c2"]);
		};
		const { harness } = await run(setup, [request, DONE]);
		expect(events).toEqual(["start a", "end a", "start b", "end b"]);
		await harness.close(context);
	});

	// 默认并行：两个调用几乎同时 start；配置 sequential 后严格串行；
	// 单个工具声明 executionMode:"sequential"（a）时，b 由同一个 generation 在第一项结束后才创建。
	it("runs a round in parallel by default and sequentially when configured or required by a tool", async () => {
		// 封装重复场景：安装慢工具 a/b，运行一轮，返回事件顺序；prepare 用来调整会话配置。
		const trace = async (setup: ChatSetup, prepare?: (root: Conversation) => Promise<void>): Promise<string[]> => {
			const events: string[] = [];
			const slow =
				(name: string): Execute =>
				async () => {
					events.push(`start ${name}`);
					await new Promise((resolve) => setTimeout(resolve, 20));
					events.push(`end ${name}`);
					return { output: [] };
				};
			// snapshot().extension(name) 按扩展名查找；避免在已安装的 setup 上重复安装同名扩展。
			if (setup.registry.snapshot().extension("tool:a") === undefined) addTool(setup.registry, tool("a", slow("a")));
			if (setup.registry.snapshot().extension("tool:b") === undefined) addTool(setup.registry, tool("b", slow("b")));
			const result = await run(setup, [calls(["a", {}, "c1"], ["b", {}, "c2"]), DONE], (_harness, root) =>
				prepare === undefined ? Promise.resolve() : prepare(root),
			);
			await result.harness.close(context);
			return events;
		};
		// 并行时前两个事件应是两个 start；end 的先后可能受调度影响，所以只取前两项。
		expect((await trace(chatSetup())).slice(0, 2)).toEqual(["start a", "start b"]);
		const configured = chatSetup();
		configured.settings.toolExecution = "sequential";
		const sequential = await trace(configured);
		expect(sequential).toEqual(["start a", "end a", "start b", "end b"]);
		const perTool = chatSetup();
		const events: string[] = [];
		addTool(
			perTool.registry,
			tool(
				"a",
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					events.push("a");
					return { output: [] };
				},
				{ executionMode: "sequential" },
			),
		);
		addTool(
			perTool.registry,
			tool("b", async () => {
				events.push("b");
				return { output: [] };
			}),
		);
		const result = await run(perTool, [calls(["a", {}, "c1"], ["b", {}, "c2"]), DONE]);
		const tasks = await result.harness.commit((tx) => tx.scanTasks({ conversationId: result.root.id }, 20), context);
		// 按任务 id 排序，恢复创建顺序（数字 id 递增）；用于验证 b 是在 a 结束后创建。
		const tools = tasks.items.filter((task) => task.kind === "pi.tool").sort((a, b) => a.id - b.id);
		// The generation owns both tools and creates the second only after the first ended.
		const [generation] = tasks.items.filter((task) => task.kind === "pi.generation");
		// owner 是创建该任务的 generation；两个工具任务都属于同一个 generation。
		expect(tools.map((task) => task.owner)).toEqual([generation!.id, generation!.id]);
		expect(events).toEqual(["a", "b"]);
		await result.harness.close(context);
	});
});

// 结果归一化：显式 output/details 优先，否则回退到 api.output 保留的文本与最后一次 details；
// 诊断先 api 后 result，再经过 afterTool、截断和 structuredOutput 校验。
describe("tool results", () => {
	// 工具只报告输出与诊断，不返回 output/details：结果使用保留输出、最后一次 details，
	// 诊断按“api 报告顺序 → 结果自带顺序”排列，最后追加截断诊断。
	it("uses retained output and the last details when the result omits them, with diagnostics in order", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool(
				"log",
				async (_args, api) => {
					api.output("line 1\n");
					// output 同时接受字符串与 Uint8Array；编码后仍按 UTF-8 文本处理。
					api.output(new TextEncoder().encode("line 2\nline 3\n"));
					api.diagnostic({ severity: "info", message: "from api" });
					// 等待每次 details 提交；第二次调用覆盖第一次，最终详情是 { step: 2 }。
					await api.details({ step: 1 }, context);
					await api.details({ step: 2 }, context);
					return { diagnostics: [{ severity: "warn", message: "from result" }] };
				},
				{ outputLimits: { maxLines: 2 } },
			),
		);
		const { harness, entries } = await run(setup, [calls(["log", {}, "c1"]), DONE]);
		const [result] = results(entries);
		expect(result!.details).toEqual({ step: 2 });
		expect(resultText(result!)).toBe(
			// 输出限制 maxLines:2 保留前两行；第三个换行行被丢弃，并追加截断诊断。
			"line 1\nline 2\n|<harness>\n[info] from api\n[warn] from result\n[warn] Output truncated to its beginning: 1 lines, 7 bytes dropped\n</harness>",
		);
		// 下面检查条目 data 中的诊断码：前两个由 api/result 报告，没有 code；第三个是 Harness 生成的 truncated。
		const entry = entries.find((candidate) => ToolResultEntry.is(candidate));
		expect(ToolResultEntry.is(entry) && entry.data.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			undefined,
			undefined,
			"truncated",
		]);
		await harness.close(context);
	});

	// retain:"tail" 时 api.outputWindow 给出尾部窗口参数（250ms 节流、100KB/s），head 模式为 undefined。
	// 第二次 api.output 传入 skipped 统计，表示环境已省略的字节/行数；截断计数把它们也算进去。
	it("offers the tail window with the configured pace, not a head window, and accepts skipped output", async () => {
		// 展开 chatSetup 结果后整体替换 settings，只保留本测试关心的进度节流配置。
		const setup = { ...chatSetup(), settings: { progress: { outputIntervalMs: 250 } } };
		const windows: unknown[] = [];
		addTool(
			setup.registry,
			tool(
				"tailed",
				async (_args, api) => {
					windows.push(api.outputWindow);
					api.output("dropped\n");
					// 第二个参数报告环境跳过（未提供）的 8 字节、1 个换行，并声明文本以换行结束。
					api.output("x\ny\n", { bytes: 8, newlines: 1, endsWithNewline: true });
					return {};
				},
				{ outputLimits: { maxLines: 1, retain: "tail" } },
			),
		);
		addTool(
			setup.registry,
			tool(
				"headed",
				async (_args, api) => {
					windows.push(api.outputWindow);
					return {};
				},
				{ outputLimits: { maxLines: 1 } },
			),
		);
		const { harness, entries } = await run(setup, [calls(["tailed", {}, "c1"], ["headed", {}, "c2"]), DONE]);
		expect(windows).toContainEqual({
			maxBytes: 50 * 1024,
			maxLines: 1,
			minIntervalMs: 250,
			bytesPerSecond: 100 * 1024,
		});
		expect(windows).toContainEqual(undefined);
		// 英文原文说明了计数来源；这里补充：最终文本只保留 y，诊断把写入、跳过和窗口丢弃合并计数。
		// 8 bytes written, 8 skipped, then "x\n" dropped by the window: 3 lines, 18 bytes in all.
		expect(resultText(results(entries).find((result) => result.toolCallId === "c1")!)).toBe(
			"y\n|<harness>\n[warn] Output truncated to its end: 3 lines, 18 bytes dropped\n</harness>",
		);
		await harness.close(context);
	});

	// 显式 output 中的文本按限制截断，但图片等非文本内容保留；限制按文本项合并计算。
	// tail 模式保留最后一个文本项，截断诊断说明丢弃的行数与字节数。
	it("bounds explicit text content and keeps other content", async () => {
		const setup = chatSetup();
		// as const 把 type 与 mimeType 收窄为字面量，满足 ImageContent 的联合类型。
		const image = { type: "image", data: "AAAA", mimeType: "image/png" } as const;
		addTool(
			setup.registry,
			tool(
				"big",
				async () => ({
					output: [{ type: "text", text: "a\nb\n" }, image, { type: "text", text: "c\nd\n" }],
				}),
				{ outputLimits: { maxLines: 2, retain: "tail" } },
			),
		);
		const { harness, entries } = await run(setup, [calls(["big", {}, "c1"]), DONE]);
		expect(resultText(results(entries)[0]!)).toBe(
			"[image]|c\nd\n|<harness>\n[warn] Output truncated to its end: 2 lines, 4 bytes dropped\n</harness>",
		);
		await harness.close(context);
	});

	// execute 抛错：已经 api.output 的部分输出仍保留，错误文本变成 tool_error 诊断。
	// 任务以 failed 结束（取消其拥有的工作），但对话整体仍能继续并完成。
	it("turns a throw into a tool_error result with the partial output", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("fail", async (_args, api) => {
				api.output("partial\n");
				throw new Error("boom");
			}),
		);
		const { harness, entries, status } = await run(setup, [calls(["fail", {}, "c1"]), DONE]);
		expect(status).toBe("done");
		const [result] = results(entries);
		expect(result!.isError).toBe(true);
		// 工具失败不会让整个提交失败；模型仍收到错误结果并完成后续生成。
		expect(resultText(result!)).toBe("partial\n|<harness>\n[error] boom\n</harness>");
		await harness.close(context);
	});

	// #10549
	// #10549：durationMs 只统计 execute() 本身，不包含 beforeTool 的 100ms 等待；
	// 被 block 的调用没有执行，因此没有 durationMs；抛错但执行过的调用仍有耗时。
	it("records how long execute() took, excluding hooks, and nothing for calls that did not run", async () => {
		const setup = chatSetup();
		// 简单的定时 Promise：测试用真实计时来区分工具耗时与钩子耗时。
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		addTool(
			setup.registry,
			tool("slow", async () => {
				await sleep(30);
				return { output: [] };
			}),
		);
		addTool(
			setup.registry,
			tool("thrower", async () => {
				await sleep(30);
				throw new Error("boom");
			}),
		);
		addHooks(setup.registry, ToolTask, {
			// 所有调用都先等 100ms；id 为 blocked 的调用再被阻塞，以此证明钩子时间不计入 durationMs。
			beforeTool: async (call) => {
				await sleep(100);
				return call.id === "blocked" ? { block: "no" } : undefined;
			},
		});
		const { harness, entries } = await run(setup, [
			calls(["slow", {}, "slow"], ["thrower", {}, "thrower"], ["slow", {}, "blocked"]),
			DONE,
		]);
		const byId = new Map(results(entries).map((result) => [result.toolCallId, result]));
		for (const id of ["slow", "thrower"]) {
			// 约 30ms 的 execute 耗时应落在 25 到 100 之间；?. 处理缺失结果。
			expect(byId.get(id)?.durationMs).toBeGreaterThanOrEqual(25);
			expect(byId.get(id)?.durationMs).toBeLessThan(100);
		}
		expect(byId.get("thrower")?.isError).toBe(true);
		// 被阻塞的调用根本没执行，结果对象上不应出现 durationMs 字段。
		expect(byId.get("blocked")).not.toHaveProperty("durationMs");
		await harness.close(context);
	});

	// 参数在 beforeTool 前后各校验一次：pi-ai 会先做类型强制转换（数字 1 → "1"），
	// 钩子可以阻塞、抛错或替换参数；替换后的参数还要通过 schema，非法替换得到 invalid_arguments。
	it("validates arguments before and after beforeTool and applies blocks and replacements", async () => {
		const setup = chatSetup();
		const seen: { text?: string }[] = [];
		addTool(
			setup.registry,
			tool("echo", async (args) => {
				seen.push(args);
				return { output: [] };
			}),
		);
		addHooks(setup.registry, ToolTask, {
			beforeTool: (call) => {
				// 钩子按调用 id 返回不同决策；throw 的异常由 Harness 捕获并转成 block 文本。
				if (call.id === "block") return { block: "not today" };
				if (call.id === "throw") throw new Error("hook failed");
				if (call.id === "bad") return { arguments: { text: { not: "a string" } } };
				return { arguments: { text: `${call.arguments.text}!` } };
			},
		});
		const { harness, entries } = await run(setup, [
			calls(
				// as unknown as string 故意绕过静态类型，模拟线上 JSON 里类型不符的参数。
				["echo", { text: 1 as unknown as string }, "coerced"],
				["echo", { text: { not: "a string" } }, "invalid"],
				["echo", {}, "block"],
				["echo", {}, "throw"],
				["echo", { text: "x" }, "bad"],
				["echo", { text: "x" }, "ok"],
			),
			DONE,
		]);
		// Parallel tools append their results in completion order.
		// 并行工具按完成顺序追加结果，因此用 toolCallId 建 Map，而不是依赖数组位置。
		const byId = new Map(results(entries).map((result) => [result.toolCallId, [result.isError, resultText(result)]]));
		expect(byId.get("block")).toEqual([true, "<harness>\n[error] Tool call blocked: not today\n</harness>"]);
		expect(byId.get("throw")).toEqual([true, "<harness>\n[error] Tool call blocked: hook failed\n</harness>"]);
		expect(byId.get("bad")![0]).toBe(true);
		// 替换后的参数 { text: { not: "a string" } } 未通过 schema；具体错误前缀由校验器提供。
		expect(byId.get("bad")![1]).toContain("Validation failed");
		expect(byId.get("ok")).toEqual([false, ""]);
		expect(byId.get("invalid")![0]).toBe(true);
		expect(byId.get("invalid")![1]).toContain("Validation failed");
		// pi-ai coerces a number to a string before the first validation.
		expect(byId.get("coerced")).toEqual([false, ""]);
		// 只有 coerced 与 ok 真正执行；block、throw、invalid、bad 都没有到达 execute，所以 seen 长度为 2。
		expect(seen).toEqual(expect.arrayContaining([{ text: "1!" }, { text: "x!" }]));
		expect(seen).toHaveLength(2);
		await harness.close(context);
	});

	// prepareArguments 在首次 schema 校验之前修补参数；修补抛错等价于参数非法。
	// 模型原始调用仍保存在助手条目里，修补只影响执行。
	it("repairs arguments with prepareArguments before validation, and a throwing repair is invalid", async () => {
		const setup = chatSetup();
		const seen: { text?: string }[] = [];
		addTool(
			setup.registry,
			tool(
				"echo",
				async (args) => {
					seen.push(args);
					return { output: [] };
				},
				{
					prepareArguments: (args) => {
						const text = (args as { text?: unknown }).text;
						// 修补函数抛出的错误会被 prepare() 捕获，最终作为 invalid_arguments 结果返回。
						if (text === "throw") throw new Error("cannot repair");
						// 这里校验的是未类型化的线上参数，因此 typeof 检查是合法的信任边界校验。
						return typeof text === "number" ? { text: `#${text}` } : (args as { text?: string });
					},
				},
			),
		);
		const { harness, entries } = await run(setup, [
			calls(["echo", { text: 7 as unknown as string }, "fixed"], ["echo", { text: "throw" }, "broken"]),
			DONE,
		]);
		const byId = new Map(results(entries).map((result) => [result.toolCallId, resultText(result)]));
		expect(byId.get("fixed")).toBe("");
		expect(byId.get("broken")).toBe("<harness>\n[error] cannot repair\n</harness>");
		expect(seen).toEqual([{ text: "#7" }]);
		// The stored call keeps what the model sent.
		// 助手条目保存模型原始调用；断言修补后的 "#7" 没有写回 transcript。
		const call = (entries[2]!.model![0] as AssistantMessage).content.find((item) => item.type === "toolCall");
		expect(call?.type === "toolCall" && call.arguments).toEqual({ text: 7 });
		await harness.close(context);
	});

	// 多个 beforeTool 按安装顺序串行；第一个返回 block 后，后续处理器不再调用（block 不可被覆盖）。
	it("lets the first beforeTool block win and skips later handlers", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("echo", async () => ({ output: [] })),
		);
		const asked: string[] = [];
		addHooks(setup.registry, ToolTask, {
			beforeTool: () => {
				asked.push("first");
				return { block: "first says no" };
			},
		});
		addHooks(setup.registry, ToolTask, {
			beforeTool: () => {
				asked.push("second");
				return { block: "second says no" };
			},
		});
		const { harness, entries } = await run(setup, [calls(["echo", {}, "c1"]), DONE]);
		expect(asked).toEqual(["first"]);
		expect(resultText(results(entries)[0]!)).toBe("<harness>\n[error] Tool call blocked: first says no\n</harness>");
		await harness.close(context);
	});

	// afterTool 逐个链式替换结果：第一个把输出改成 first，第二个读到 first 并写 details；
	// afterTools 在整轮结束后收到助手条目 ID 与该轮全部结果条目 ID。
	it("chains afterTool replacements and observes the round with afterTools", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("echo", async () => ({ output: [{ type: "text", text: "raw" }] })),
		);
		addHooks(setup.registry, ToolTask, {
			// 每个 afterTool 返回的新对象成为下一个钩子的输入；展开保证未修改字段保留。
			afterTool: (_call, result) => ({ ...result, output: [{ type: "text", text: "first" }] }),
		});
		addHooks(setup.registry, ToolTask, {
			afterTool: (_call, result) => ({
				...result,
				details: {
					replaced: (result.output ?? []).map((item) => (item.type === "text" ? item.text : "")).join("|"),
				},
			}),
		});
		const observed: unknown[] = [];
		addHooks(setup.registry, GenerationTask, {
			// void 运算符丢弃 push 的返回值，让简写箭头函数返回 undefined，符合观察者钩子签名。
			afterTools: (assistant, entries) => void observed.push(assistant, entries),
		});
		const { harness, entries } = await run(setup, [calls(["echo", {}, "c1"]), DONE]);
		const [result] = results(entries);
		expect(resultText(result!)).toBe("first");
		expect(result!.details).toEqual({ replaced: "first" });
		const resultEntry = entries.find((entry) => ToolResultEntry.is(entry))!;
		expect(observed).toEqual([entries[2]!.id, [resultEntry.id]]);
		await harness.close(context);
	});

	// 只有会话/扩展选择中启用的扩展钩子才运行；task 拥有的子会话复制其 owner 的选择，
	// 而 ownerless 会话没有默认选择，所以 Audit 不运行。
	it("runs the hooks of the selected extensions; a task-owned child copies its owner's selection", async () => {
		const setup = chatSetup();
		const calledIn: number[] = [];
		const Echo = defineExtension({ name: "echo", tools: [tool("echo", async () => ({ output: [] }))] });
		const Audit = defineExtension({
			name: "audit",
			hooks: [hook(ToolTask, { beforeTool: (_call, api) => void calledIn.push(api.conversationId) })],
		});
		setup.registry.install(Echo);
		setup.registry.install(Audit);
		// Audit is installed but not in the default selection.
		// 默认选择只含 Echo；Audit 虽已安装但不会运行。
		setup.settings.extensions = [Echo];
		const first = await run(setup, [DONE]);
		// 给根会话增量添加 Audit，之后的子会话会继承 owner 的选择。
		await first.root.configure({ extensions: { add: [Audit] } }, context);
		// An owner task no registered definition takes stays live and pending.
		// 定义一个永不推进的任务，用作子会话的 owner；泛型依次是输入、状态、结果类型。
		const owner = defineTask<Record<string, never>, { phase: "never" }, null>({
			name: "test.owner",
			version: 1,
			initial: () => ({ phase: "never" }),
			phases: { never: async () => {} },
			abort: async () => {},
		});
		// 在一个事务里创建 owner 任务和归属它的子会话；两者要么一起提交，要么一起失败。
		const childId = await first.harness.commit(async (tx) => {
			const taskId = await tx.createTask(
				owner,
				{},
				{ ownership: { kind: "conversation" }, conversationId: first.root.id },
			);
			return (await tx.createConversation({ ownership: { kind: "task", taskId } })).id;
		}, context);
		const child = (await first.harness.conversation(childId, context))!;
		// 另一个 ownerless 会话，用来对比：没有 owner 就没有可复制的扩展选择。
		const other = await first.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } },
			context,
		);
		for (const conversation of [first.root, child, other]) {
			setup.faux.setResponses([calls(["echo", {}, "c1"]), DONE]);
			await (await conversation.submit({ type: "input", content: "go" }, context)).wait(context);
		}
		expect(calledIn).toEqual([first.root.id, child.id]);
		await first.harness.close(context);
	});

	// control.terminate 只有在“本轮所有结果都请求终止”时才生效：单独 stop 时回合在工具结果后结束；
	// stop+grow 时不终止，模型继续总结。control.addTools 追加到存储的 agent 工具数组并去重。
	it("applies addTools and terminates only when every result of the round asks to", async () => {
		const setup = chatSetup();
		// terminate 放在工具结果里，由 ToolTask 汇总为本轮是否结束。
		const stop = tool("stop", async () => ({ output: [], control: { terminate: true } }));
		// addTools 提议下一轮追加工具；其中 stop 已在选择里，追加时应跳过重复。
		const grow = tool("grow", async () => ({ output: [], control: { addTools: ["extra", "stop"] } }));
		addTool(setup.registry, stop);
		addTool(setup.registry, grow);
		addTool(
			setup.registry,
			tool("extra", async () => ({ output: [] })),
		);
		const first = await run(setup, [calls(["stop", {}, "c1"])], async (_harness, root) => {
			await root.configure({ tools: [stop, grow] }, context);
		});
		expect(first.status).toBe("done");
		// 唯一结果请求 terminate，回合在工具结果处结束，不再请求模型。
		expect(first.entries.at(-1)!.kind).toBe("pi.tool-result");
		const settled = await first.harness.commit((tx) => tx.scanTasks({ conversationId: first.root.id }, 20), context);
		// 所有任务（生成与工具）都进入终态，没有遗留 pending。
		expect(settled.items.every((task) => task.state.status === "terminal")).toBe(true);

		setup.faux.setResponses([calls(["stop", {}, "c1"], ["grow", {}, "c2"]), DONE]);
		const second = await (await first.root.submit({ type: "input", content: "again" }, context)).wait(context);
		expect(second.status).toBe("done");
		expect((await allEntries(first.root)).at(-1)!.kind).toBe("pi.assistant");
		// addTools appends to the stored tool array, skipping names it already holds.
		// addTools 修改的是存储的 agent 工具数组；顺序为原有 stop、grow，再追加 extra。
		expect((await first.harness.snapshot(AgentDoc, first.root.id, context))?.tools).toEqual([
			"stop",
			"grow",
			"extra",
		]);
		await first.harness.close(context);
	});

	// #10858
	// #10858：显式 terminate:false 不终止回合，模型仍收到 DONE 并产生最后一条 assistant 条目。
	it("does not terminate on terminate: false", async () => {
		const setup = chatSetup();
		const keep = tool("keep", async () => ({ output: [], control: { terminate: false } }));
		addTool(setup.registry, keep);
		const { harness, entries, status } = await run(
			setup,
			[calls(["keep", {}, "c1"]), DONE],
			async (_harness, root) => {
				await root.configure({ tools: [keep] }, context);
			},
		);
		expect(status).toBe("done");
		expect(entries.at(-1)!.kind).toBe("pi.assistant");
		await harness.close(context);
	});
});

// 生成钩子围绕每一次模型请求/响应：beforeRequest 可替换请求消息，afterResponse 只观察，
// onYield 决定是否追加一次续跑，beforeProviderRequest 可改写每个 provider 请求体。
describe("generation hooks", () => {
	// beforeRequest 注入的消息只进入本次请求，不写回 transcript；afterResponse 观察两条模型回复；
	// onYield 第一次返回 continue，产生一条新的 user 消息并再请求一次。
	it("replaces request messages, observes responses, and continues on yield", async () => {
		const setup = chatSetup();
		const requests: string[][] = [];
		// faux 响应步骤收到本次请求；这里记录每条消息的 role 与文本，用于断言注入消息的位置。
		const record: FauxResponseStep = (request) => {
			requests.push(request.messages.map((message) => `${message.role}:${textOf(message as never) ?? ""}`));
			return fauxAssistantMessage([fauxText(`answer ${requests.length}`)]);
		};
		addHooks(setup.registry, GenerationTask, {
			beforeRequest: ({ messages }) => ({
				// 展开原消息后追加一条用户消息；返回新数组，不修改调用方传入的 messages。
				messages: [...messages, { role: "user", content: "injected", timestamp: 0 }],
			}),
		});
		const responses: string[] = [];
		addHooks(setup.registry, GenerationTask, {
			afterResponse: (message) => void responses.push(textOf(message) ?? ""),
		});
		let yields = 0;
		addHooks(setup.registry, GenerationTask, {
			// 后置自增先比较旧值：第一次调用返回 continue，之后返回 undefined 结束续跑。
			onYield: () => (yields++ === 0 ? { continue: [{ type: "text", text: "keep going" }] } : undefined),
		});
		const { harness, entries, status } = await run(setup, [record, record]);
		expect(status).toBe("done");
		// 请求末尾是原始输入与注入消息，证明注入发生在请求层。
		expect(requests[0]!.slice(-2)).toEqual(["user:go", "user:injected"]);
		expect(responses).toEqual(["answer 1", "answer 2"]);
		expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant", "pi.user", "pi.assistant"]);
		// The injected message was used for the request only.
		// transcript 中找不到 injected，说明 beforeRequest 的替换没有持久化。
		expect(entries.some((entry) => textOf(entry.model?.[0]) === "injected")).toBe(false);
		await harness.close(context);
	});

	// beforeProviderRequest 在每个 provider 请求体上串行执行，前一个的 payload 是后一个的输入；
	// faux 的 onPayload 被调用两次，模拟 pi-ai 在同一 attempt 内构建并重发请求体。
	it("chains beforeProviderRequest over every provider request body", async () => {
		const setup = chatSetup();
		// 记录每个钩子看到的 provider/model 与当时的 payload；payload 是未知 JSON 形状。
		const seen: { hook: string; model: string; payload: unknown }[] = [];
		addHooks(setup.registry, GenerationTask, {
			beforeProviderRequest: ({ model, payload }) => {
				seen.push({ hook: "first", model: `${model.provider}/${model.id}`, payload });
				// 断言 payload 是对象后展开；替换为新对象，不原地修改上一个钩子的结果。
				return { payload: { ...(payload as object), first: true } };
			},
		});
		addHooks(setup.registry, GenerationTask, {
			beforeProviderRequest: ({ model, payload }) => {
				seen.push({ hook: "keep", model: `${model.provider}/${model.id}`, payload });
				return undefined;
			},
		});
		addHooks(setup.registry, GenerationTask, {
			beforeProviderRequest: ({ payload }) => ({ payload: { ...(payload as object), last: true } }),
		});
		const sent: unknown[] = [];
		// pi-ai builds a body per provider call, and again when it resends within one attempt.
		const respond: FauxResponseStep = async (_context, options, _state, model) => {
			// faux 步骤通过 options.onPayload 触发真实 provider 请求体构建；options 与 onPayload
			// 在 faux 类型里都是可选的，因此用 ! 断言测试配置已提供。
			sent.push(await options!.onPayload!({ body: 1 }, model));
			sent.push(await options!.onPayload!({ body: 2 }, model));
			return DONE;
		};
		const { harness, status } = await run(setup, [respond]);
		expect(status).toBe("done");
		expect(sent).toEqual([
			{ body: 1, first: true, last: true },
			{ body: 2, first: true, last: true },
		]);
		expect(seen).toEqual([
			{ hook: "first", model: "faux/faux-1", payload: { body: 1 } },
			{ hook: "keep", model: "faux/faux-1", payload: { body: 1, first: true } },
			{ hook: "first", model: "faux/faux-1", payload: { body: 2 } },
			{ hook: "keep", model: "faux/faux-1", payload: { body: 2, first: true } },
		]);
		await harness.close(context);
	});

	// 钩子抛错被 Harness 捕获为 extension_error 报告，后续 beforeProviderRequest 仍执行；
	// 因此最终请求体仍带 after:true，运行正常完成。
	it("reports a throwing beforeProviderRequest hook and continues the chain", async () => {
		const setup = chatSetup();
		addHooks(
			setup.registry,
			GenerationTask,
			{
				beforeProviderRequest: () => {
					throw new Error("broken hook");
				},
			},
			"broken",
		);
		addHooks(setup.registry, GenerationTask, {
			beforeProviderRequest: ({ payload }) => ({ payload: { ...(payload as object), after: true } }),
		});
		let sent: unknown;
		const respond: FauxResponseStep = async (_context, options, _state, model) => {
			// 这里同样通过 onPayload 触发 beforeProviderRequest 链；抛错被报告后仍返回改写后的 body。
			sent = await options!.onPayload!({ body: 1 }, model);
			return DONE;
		};
		const { harness, status } = await run(setup, [respond]);
		expect(status).toBe("done");
		expect(sent).toEqual({ body: 1, after: true });
		// infos 收集运行时的信息性报告；扩展名来自 addHooks 的 name 参数 "broken"。
		expect(setup.infos.filter((info) => info.kind === "extension_error")).toEqual([
			expect.objectContaining({ extension: "broken" }),
		]);
		await harness.close(context);
	});

	// onYield 续跑期间，原始 submission 仍处于 placed（未完成），最终 answer 指向第二次助手条目。
	// 这说明一次输入可跨多个模型回合，完成状态只在最终答案后写入。
	it("keeps the run's input open across an onYield continuation and answers it with the final answer", async () => {
		const setup = chatSetup();
		let yields = 0;
		let harness!: Harness;
		let input: SubmissionId | undefined;
		let statusAtSecondRequest: string | undefined;
		addHooks(setup.registry, GenerationTask, {
			onYield: () => (yields++ === 0 ? { continue: "again" } : undefined),
		});
		const second: FauxResponseStep = async () => {
			// 会话 id 是品牌类型；1 as never 是测试里绕过类型检查的显式断言，真实调用应传 root.id。
			input = (await harness.snapshot(LiveDoc, 1 as never, context))!.run!.inputs[0];
			statusAtSecondRequest = (await (await harness.submission(input!, context))!.status(context)).status;
			return fauxAssistantMessage([fauxText("second")]);
		};
		const result = await run(setup, [fauxAssistantMessage([fauxText("first")]), second], async (opened) => {
			harness = opened;
		});
		// 第二次请求时 submission 尚未完成，状态仍是 placed。
		expect(statusAtSecondRequest).toBe("placed");
		const answers = result.entries.filter((entry) => entry.kind === "pi.assistant");
		// 最终状态为 done，answer 指向第二条助手条目（索引 1）。
		expect(await (await harness.submission(input!, context))!.status(context)).toMatchObject({
			status: "done",
			answer: answers[1]!.id,
		});
		await harness.close(context);
	});

	// stream.deferred 让 faux 响应先返回 pending，Harness 轮询后续取得最终答案；
	// afterResponse 仍只观察一次最终 stop 响应，不会把 pending 当终态。
	it("observes responses that arrive by polling a deferred request", async () => {
		// 第一次查询返回 pending，之后每隔 1ms 轮询，直到取得最终响应。
		const setup = chatSetup({ deferred: { pendingFetches: 1, pollAfterMs: 1 } });
		const observed: string[] = [];
		addHooks(setup.registry, GenerationTask, {
			afterResponse: (message) => void observed.push(`${message.stopReason}:${textOf(message) ?? ""}`),
		});
		setup.settings.stream = { deferred: true };
		const result = await run(setup, [fauxAssistantMessage([fauxText("late")])]);
		expect(result.status).toBe("done");
		// The still-deferred results are not terminal.
		// 只记录最终响应的 stopReason 与文本，pending 中间态不触发 afterResponse。
		expect(observed).toEqual(["stop:late"]);
		await result.harness.close(context);
	});

	// 多个 onYield 中第一个返回 continue 的处理器获胜，本轮后续 onYield 跳过；
	// afterResponse 观察者抛错不会中断链，错误报告到 reports，下一个观察者仍执行。
	it("lets the first onYield continuation win and reports throws without stopping later handlers", async () => {
		const setup = chatSetup();
		const called: string[] = [];
		addHooks(setup.registry, GenerationTask, {
			afterResponse: () => {
				called.push("throwing observer");
				// 观察者抛错只应被报告；测试随后断言其他观察者仍收到三次响应。
				throw new Error("observer failed");
			},
		});
		addHooks(setup.registry, GenerationTask, { afterResponse: () => void called.push("next observer") });
		let yields = 0;
		addHooks(setup.registry, GenerationTask, {
			onYield: () => (yields++ === 0 ? { continue: "first" } : undefined),
		});
		addHooks(setup.registry, GenerationTask, {
			onYield: () => {
				called.push("second onYield");
				// 第二次 onYield 只有在第一次被真正调用后才返回 continue；第一轮它被前一个处理器短路。
				return called.filter((name) => name === "second onYield").length === 1 ? { continue: "second" } : undefined;
			},
		});
		const { harness, entries } = await run(setup, [
			fauxAssistantMessage([fauxText("a")]),
			fauxAssistantMessage([fauxText("b")]),
			fauxAssistantMessage([fauxText("c")]),
		]);
		// The first continuation skips the second handler; on the next answer the second handler's continuation wins.
		const users = entries.filter((entry) => entry.kind === "pi.user").map((entry) => textOf(entry.model![0]));
		// 三个用户回合：原始输入、第一条续跑消息、第二条续跑消息。
		expect(users).toEqual(["go", "first", "second"]);
		expect(called.filter((name) => name === "second onYield")).toHaveLength(2);
		expect(called.filter((name) => name === "next observer")).toHaveLength(3);
		// reports 保存未捕获的扩展错误；转成 Error 后检查消息。
		expect(setup.reports.map((error) => (error as Error).message)).toContain("observer failed");
		await harness.close(context);
	});

	// api.memo 把第一个值持久化到任务 memo；同一任务内后续读取即使传入不同默认值也返回已存值。
	// 这为钩子决策提供“只计算一次”的耐久语义。
	it("keeps durable hook decisions in task memos", async () => {
		const setup = chatSetup();
		let asked = 0;
		addTool(
			setup.registry,
			tool("echo", async () => ({ output: [] })),
		);
		addHooks(setup.registry, ToolTask, {
			beforeTool: async (_call, api) => {
				asked++;
				// 第一次读取写入 "approved"；第二个参数只是缺失时的默认值。
				const decision = await api.memo("approval:decision", "approved", context);
				expect(await api.memo("approval:decision", "denied", context)).toBe(decision);
				return undefined;
			},
		});
		const { harness } = await run(setup, [calls(["echo", {}, "c1"]), DONE]);
		// 一次工具调用只触发一次 beforeTool，验证钩子没有被重复执行。
		expect(asked).toBe(1);
		await harness.close(context);
	});
});

// ToolExecutionApi 提供给工具实现的能力：环境、模型/注册表、提交、memo、子任务与文档观察。
describe("tool execution api", () => {
	// 工具 api 的端到端：env 每次执行时按会话当前 cwd 构建；commit 返回 change 的结果并带 byTaskId；
	// memo 只记第一次；createTask/waitForTask 创建并等待子任务。第二次调用看到新 cwd "/"。
	it("builds the environment per call from the conversation's cwd and runs commits, memos, and child tasks", async () => {
		const setup = chatSetup();
		const child = defineTask<{ n: number }, { phase: "run" }, number>({
			// 子任务把输入 n 翻倍后以 completed 结束；测试用 21 得到 42。
			name: "test.child",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (task, runtime, callContext) => {
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: task.input.n * 2 } }),
						callContext,
					);
				},
			},
			abort: async () => {},
		});
		addTask(setup.registry, child);
		const seen: unknown[] = [];
		const probe = tool("probe", async (_args, api) => {
			// env 在 execute 前才构建；?. 允许 api.env 尚未定义的情况，但测试期望它存在。
			seen.push(api.env?.cwd);
			seen.push((await api.agent(context)).tools.map((each) => each.name));
			// 工具可以通过 api.registry 查找扩展；probe 由 addTool 以 tool:probe 名称安装。
			seen.push(api.registry.extension("tool:probe") !== undefined);
			// api.commit 在一个事务里执行 change，并返回 change 的结果（这里是新条目）。
			const entry = await api.commit(async (tx) => {
				// The next call runs in the new directory: its environment is built when it executes.
				// 修改会话的 cwd；下一次工具调用构建环境时会读取新值。
				await configure(tx, api.conversationId, { cwd: "/" });
				return tx.appendEntry(api.conversationId, { kind: "test.note", data: api.callId });
			}, context);
			// 同一次工具调用提交的条目应标记产生它的任务 id。
			seen.push(entry.byTaskId === api.taskId);
			// 两次 memo 读取都返回首次写入的 1，默认值 2 不覆盖已存值。
			seen.push(await api.memo("m", 1, context), await api.memo("m", 2, context));
			const id = await api.createTask(child, { n: 21 }, { ownership: { kind: "conversation" } }, context);
			// 等待子任务进入终态；返回的 outcome 应包含 completed 与结果 42。
			const done = await api.waitForTask(id, context);
			seen.push(done.state.outcome);
			return { output: [] };
		});
		addTool(setup.registry, probe);
		setup.faux.setResponses([calls(["probe", {}, "c1"], ["probe", {}, "c2"]), DONE]);
		setup.settings.toolExecution = "sequential";
		const targets: unknown[] = [];
		const { harness, root } = await openChat(new MemoryStorage(), setup, {
			// 自定义 env 工厂：Harness 每次需要环境时调用它，并记录 [conversationId, cwd]。
			env: ({ conversationId, cwd }) => {
				targets.push([conversationId, cwd]);
				// 配置里没有 cwd 时回退到 /tmp；NodeExecutionEnv 提供真实文件与进程能力。
				return new NodeExecutionEnv({ cwd: cwd ?? "/tmp" });
			},
		});
		// 第一次工具调用前的会话 cwd；工具内部再把它改成 "/"。
		await root.configure({ cwd: "/tmp" }, context);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const outcome = { status: "completed", result: 42 };
		// seen 的固定形状：cwd、可用工具名、扩展存在、byTaskId、两次 memo、子任务 outcome。
		const call = (cwd: string) => [cwd, ["probe"], true, true, 1, 1, outcome];
		expect(seen).toEqual([...call("/tmp"), ...call("/")]);
		expect(targets).toContainEqual([root.id, "/tmp"]);
		expect(targets).toContainEqual([root.id, "/"]);
		await harness.close(context);
	});

	// 构建环境抛错时工具没有执行；错误变成 tool_error 结果。
	// 测试期望两处准备阶段各报告一次（英文原文：Each preparation reports the failure），因此共两次。
	it("answers a throwing environment with a tool_error result and reports it once while preparing", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("probe", async () => ({ output: [{ type: "text", text: "ran" }] })),
		);
		const { harness, entries } = await run(setup, [calls(["probe", {}, "c1"]), DONE], undefined, {
			env: () => {
				throw new Error("no sandbox");
			},
		});
		const [result] = results(entries);
		expect(result).toMatchObject({ isError: true });
		expect(resultText(result!)).toBe("<harness>\n[error] no sandbox\n</harness>");
		// Each preparation reports the failure and renders without an environment.
		// 两处准备阶段各自报告环境构建失败；错误文本相同。
		expect(setup.reports.filter((error) => (error as Error).message === "no sandbox").length).toBe(2);
		await harness.close(context);
	});
});

// 内置工具不是 mock：它们在临时目录上真实读写文件、启动 shell，验证与 Harness 的集成。
describe("coding tools", () => {
	// 真实 bash 工具在临时目录运行 3000 行脚本并 exit 7：默认保留尾部，诊断依次为完整输出路径、
	// 非零退出码、截断；文本以 line-1001 开头，包含最后一行与错误信息。
	it("answers a failing command with its retained tail and diagnostics in order", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-durable-coding-"));
		try {
			const setup = chatSetup();
			addTool(setup.registry, createBashTool());
			// 每个测试使用独立临时目录，finally 中递归删除；Shell 循环输出 3000 行，
			// 非零退出让 bash 工具返回 isError 与退出码诊断。
			const command = "i=1; while [ $i -le 3000 ]; do echo line-$i; i=$((i + 1)); done; exit 7";
			setup.faux.setResponses([calls(["bash", { command }, "b"]), DONE]);
			const env = new NodeExecutionEnv({ cwd: directory });
			const { harness, root } = await openChat(new MemoryStorage(), setup, { env });
			await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
			const entry = (await allEntries(root)).find((candidate) => ToolResultEntry.is(candidate))!;
			const [result] = results([entry]);
			expect(result!.isError).toBe(true);
			const text = resultText(result!);
			// 默认保留最后 2000 行，因此开头是第 1001 行，前 1000 行被丢弃。
			expect(text.startsWith("line-1001\n")).toBe(true);
			expect(ToolResultEntry.is(entry) && entry.data.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"full_output",
				"exit_code",
				"truncated",
			]);
			// data 中的诊断顺序：full_output 由 bash 工具报告，exit_code 由非零退出产生，
			// truncated 由 Harness 在结果归一化时追加。
			expect(text).toContain("line-3000\n|<harness>\n[info] Full output: ");
			expect(text).toContain(
				"\n[error] Command exited with code 7\n[warn] Output truncated to its end: 1000 lines, ",
			);
			await harness.close(context);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	// 一次 run 内连续 read → edit → bash cat，验证三个内置工具共享同一执行环境与磁盘效果。
	it("reads, edits, and runs a command in one run, then answers", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-durable-coding-"));
		try {
			// 在独立临时目录准备输入文件；测试结束的 finally 会递归删除该目录。
			writeFileSync(join(directory, "notes.txt"), "hello world\n");
			const setup = chatSetup();
			// 把三个工具装进一个扩展；它们共享 NodeExecutionEnv 的 cwd。
			setup.registry.install(
				defineExtension({ name: "coding", tools: [createReadTool(), createEditTool(), createBashTool()] }),
			);
			setup.faux.setResponses([
				calls(["read", { path: "notes.txt" }, "r"]),
				calls(["edit", { path: "notes.txt", edits: [{ oldText: "world", newText: "durable" }] }, "e"]),
				calls(["bash", { command: "cat notes.txt" }, "b"]),
				DONE,
			]);
			const env = new NodeExecutionEnv({ cwd: directory });
			const { harness, root } = await openChat(new MemoryStorage(), setup, { env });
			const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
			expect(settled.status).toBe("done");
			const entries = await allEntries(root);
			// 三个结果按模型请求顺序出现：读取原文、替换成功提示、cat 到新内容。
			expect(results(entries).map((result) => [result.toolName, result.isError, resultText(result)])).toEqual([
				["read", false, "hello world\n"],
				["edit", false, "Successfully replaced 1 block(s) in notes.txt."],
				["bash", false, "hello durable\n"],
			]);
			expect(entries.at(-1)!.kind).toBe("pi.assistant");
			// 直接读磁盘确认 edit 真正写入，而不只是返回成功文本。
			expect(readFileSync(join(directory, "notes.txt"), "utf8")).toBe("hello durable\n");
			await harness.close(context);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

// 输出限制、运行中进度、实现替换/扩展重载以及调用结束后的资源生命周期。
describe("tool progress and lifetime", () => {
	// 没有 outputLimits 时使用默认值：保留前 2000 行；2500 行输入丢弃后 500 行与对应 2500 字节。
	it("applies the default output limits", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("lines", async (_args, api) => {
				// 每行一个数字；后 500 行的字节数正好是 2500，用于验证默认字节限制也被报告。
				for (let index = 1; index <= 2500; index++) api.output(`${index}\n`);
				return {};
			}),
		);
		const { harness, entries } = await run(setup, [calls(["lines", {}, "c1"]), DONE]);
		const text = resultText(results(entries)[0]!);
		expect(text.startsWith("1\n2\n")).toBe(true);
		expect(
			text.endsWith(
				"\n2000\n|<harness>\n[warn] Output truncated to its beginning: 500 lines, 2500 bytes dropped\n</harness>",
			),
		).toBe(true);
		await harness.close(context);
	});

	// 运行中报告的输出会经过 OutputBuffer 清洗：BEL 被去掉、\r\n 归一为 \n；
	// 工具显式返回的 output 内容不被清洗，保持原字节。
	it("sanitizes running output but keeps explicit result content as the tool returned it", async () => {
		const setup = chatSetup();
		let slotOutput: string | undefined;
		addTool(
			setup.registry,
			tool("noisy", async (_args, api) => {
				// \u0007 是 BEL 控制字符；\r\n 会被输出缓冲区规整为单个换行。
				api.output("a\u0007b\r\n");
				await api.details({ ready: true }, context);
				// 读取实时槽位里已提交的运行输出，确认清洗发生在写入槽位之前。
				slotOutput = (await api.snapshot(LiveDoc, api.conversationId, context))?.tools?.[0]?.output;
				return {};
			}),
		);
		addTool(
			setup.registry,
			// 显式 output 里的 ESC 字符应原样出现在最终结果中。
			tool("explicit", async () => ({ output: [{ type: "text", text: "c\u001bd" }] })),
		);
		const { harness, entries } = await run(setup, [calls(["noisy", {}, "c1"], ["explicit", {}, "c2"]), DONE]);
		expect(slotOutput).toBe("ab\n");
		const byId = new Map(results(entries).map((result) => [result.toolCallId, resultText(result)]));
		expect(byId.get("c1")).toBe("ab\n");
		expect(byId.get("c2")).toBe("c\u001bd");
		await harness.close(context);
	});

	// control 中值为 undefined 的键在写入任务结果前被丢弃，不会让严格 JSON 序列化失败。
	// addTools 还会把名字从存储的 {remove:[...]} 过滤器中删除。
	it("drops control keys set to undefined instead of faulting", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			// terminate:undefined 是刻意留下的空洞；ToolTask 用 omitUndefinedProperties 清理它。
			tool("grow", async () => ({ output: [], control: { addTools: ["extra"], terminate: undefined } })),
		);
		const extra = tool("extra", async () => ({ output: [] }));
		addTool(setup.registry, extra);
		const { harness, root, status } = await run(setup, [calls(["grow", {}, "c1"]), DONE], (_harness, conversation) =>
			// 会话工具选择是 {remove:[extra]}；grow 的 addTools 请求把 extra 加回来，因此从移除列表删除。
			conversation.configure({ tools: { remove: [extra] } }, context),
		);
		expect(status).toBe("done");
		// addTools deletes the name from a stored `{ remove }` filter.
		// 过滤器变为空数组，而不是变成包含 extra 的显式添加列表。
		expect((await harness.snapshot(AgentDoc, root.id, context))?.tools).toEqual({ remove: [] });
		await harness.close(context);
	});

	// result.details 显式 null 优先于 api.details 的最后值；null 是合法 JSON 值，表示“没有详情”。
	it("uses explicit null details instead of the last reported value", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("null", async (_args, api) => {
				await api.details({ old: 1 }, context);
				return { output: [], details: null };
			}),
		);
		const { harness, entries } = await run(setup, [calls(["null", {}, "c1"]), DONE]);
		expect(results(entries)[0]!.details).toBeNull();
		await harness.close(context);
	});

	// 一个节流窗口内的多次 details 合并到下一次进度提交；execute 返回后最后一个更新仍等待终止提交。
	// 三个 Promise 按提交顺序 resolve，最终详情是最后一次的 {n:3}。
	it("settles details() promises with coalesced progress commits and the terminal commit", async () => {
		const setup = chatSetup();
		const settled: string[] = [];
		addTool(
			setup.registry,
			tool("details", async (_args, api) => {
				// Three updates in one throttle window coalesce; the last is still pending when execute() returns.
				// then 在对应提交完成后记录顺序；first/second 在同一节流窗口内会一起被刷新。
				const first = api.details({ n: 1 }, context).then(() => settled.push("first"));
				const second = api.details({ n: 2 }, context).then(() => settled.push("second"));
				await first;
				// 工具不等第二个 Promise；void 明确表示有意忽略，避免 lint 的未使用表达式告警。
				void second;
				void api.details({ n: 3 }, context).then(() => settled.push("third"));
				return { output: [] };
			}),
		);
		const { harness, entries } = await run(setup, [calls(["details", {}, "c1"]), DONE]);
		expect(settled).toEqual(["first", "second", "third"]);
		expect(results(entries)[0]!.details).toEqual({ n: 3 });
		await harness.close(context);
	});

	// 调用解析到 v1 后中途卸载并安装同名 v2；正在执行的调用仍使用已解析的 v1 实现，返回 v1。
	it("finishes a call under the implementation it resolved when the tool is replaced mid-call", async () => {
		const setup = chatSetup();
		// 手动 Promise 的 resolve 函数在构造器外赋值，! 表示随后一定初始化。
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			release = resolve;
		});
		let finish!: () => void;
		const finished = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const v1 = tool("work", async () => {
			release();
			await finished;
			return { output: [{ type: "text", text: "v1" }] };
		});
		addTool(setup.registry, v1);
		setup.faux.setResponses([calls(["work", {}, "c1"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await started;
		// The same extension name replaces the old one in place.
		addTool(
			setup.registry,
			// 同名扩展 tool:work 会原位替换旧扩展；新调用才会解析到 v2。
			tool("work", async () => ({ output: [{ type: "text", text: "v2" }] })),
		);
		finish();
		await submission.wait(context);
		expect(resultText(results(await allEntries(root))[0]!)).toBe("v1");
		await harness.close(context);
	});

	// 工具运行中替换 prompt 扩展（section + hook）：本次调用的结果不变，
	// 下一次生成请求使用 v2 的 section 与 beforeRequest 钩子。
	it("uses a section and hook extension reloaded mid-run from the run's next request", async () => {
		const setup = chatSetup();
		const requests: string[] = [];
		const prompt = (version: string) =>
			defineExtension({
				name: "prompt",
				// section 的 render 在每次准备系统提示词时调用，因此会读取当时的 version 闭包。
				sections: [section("mode", () => version)],
				hooks: [hook(GenerationTask, { beforeRequest: () => void requests.push(version) })],
			});
		// 先装 v1；同名扩展后来的 install 会替换它。
		setup.registry.install(prompt("v1"));
		const running = deferred();
		const reloaded = deferred();
		addTool(
			setup.registry,
			tool("work", async () => {
				running.resolve();
				await reloaded.promise;
				return { output: [] };
			}),
		);
		setup.faux.setResponses([calls(["work", {}, "c1"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await running.promise;
		// 工具还在 await reloaded 时替换扩展；当前调用已经解析完工具，不受影响。
		setup.registry.install(prompt("v2"));
		reloaded.resolve();
		await submission.wait(context);
		const sections = (await allEntries(root)).flatMap((entry) => {
			const message = entry.model?.[0];
			return message?.role === "system" && message.sections !== undefined ? [message.sections] : [];
		});
		// 两条系统消息分别来自两次生成请求，说明 section 在请求时重新渲染。
		expect(sections).toEqual([{ mode: "<mode>\nv1\n</mode>" }, { mode: "<mode>\nv2\n</mode>" }]);
		expect(requests).toEqual(["v1", "v2"]);
		await harness.close(context);
	});

	// 工具返回后其 invocation 视为结束：api.waitForTask 创建的等待被拒绝（invocation has ended），
	// api.watchDoc 的 watch 被关闭，避免工具调用结束后仍持有后台等待。
	it("rejects invocation-bound waits and stops watches when the tool's invocation ends", async () => {
		const setup = chatSetup();
		// 未注册的 never 任务永远不会推进，因此 waitForTask 只能等待到 invocation 结束。
		const never = defineTask<Record<string, never>, { phase: "never" }, null>({
			name: "test.never",
			version: 1,
			initial: () => ({ phase: "never" }),
			phases: { never: async () => {} },
			abort: async () => {},
		});
		let wait!: Promise<unknown>;
		let watchClosed!: Promise<unknown>;
		addTool(
			setup.registry,
			tool("detach", async (_args, api) => {
				// The child's definition is not registered, so it stays pending.
				const child = await api.createTask(never, {}, { ownership: { kind: "conversation" } }, context);
				wait = api.waitForTask(child, context);
				// 提前挂上拒绝处理，避免在测试断言之前出现 unhandled rejection。
				wait.catch(() => {});
				const watch = await api.watchDoc(LiveDoc, api.conversationId, context);
				// closed 是 watch 关闭时 resolve 的 Promise；记录它以便在工具返回后等待。
				watchClosed = watch!.closed;
				return { output: [] };
			}),
		);
		const { harness } = await run(setup, [calls(["detach", {}, "c1"]), DONE]);
		// invocation 结束后，绑定此次调用的等待被明确拒绝。
		await expect(wait).rejects.toThrow("invocation has ended");
		await watchClosed;
		await harness.close(context);
	});

	// afterTool 等待取消信号时，外部 abortTask 取消任务；仍在节流窗口中的 details() Promise 被拒绝，
	// 而 abort 处理本身产生的错误结果不会再次等待（避免递归）。
	it("rejects details() still waiting when the call is aborted during afterTool", async () => {
		const setup = chatSetup();
		let pendingDetails!: Promise<void>;
		const inAfterTool = deferred();
		addTool(
			setup.registry,
			tool("slow", async (_args, api) => {
				api.output("first\n");
				// The output commit is in flight, so these details wait for the next throttle window.
				// 前一条输出提交仍在进行，因此这次 details 要等下一个节流窗口，正好留在 pending。
				pendingDetails = api.details({ step: 1 }, context);
				pendingDetails.catch(() => {});
				return {};
			}),
		);
		addHooks(setup.registry, ToolTask, {
			afterTool: async (_call, result, _api, callContext) => {
				// The abort handler's result runs the hooks too (#11043); only the executed call's waits.
				// abort 处理器生成的结果也会走 afterTool（#11043）；只让真正执行过的调用在这里等待。
				if (result.diagnostics?.some((diagnostic) => diagnostic.code === "aborted")) return undefined;
				inAfterTool.resolve();
				// aborted 辅助函数返回一个在信号取消时 reject 的 Promise；! 断言信号存在。
				await aborted(callContext.abortSignal!);
				return undefined;
			},
		});
		setup.faux.setResponses([calls(["slow", {}, "c1"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		// 等到 afterTool 已进入等待；随后测试从实时槽位取得工具任务 id 并调用 abortTask。
		await inAfterTool.promise;
		const taskId = (await harness.snapshot(LiveDoc, root.id, context))!.tools![0]!.taskId!;
		await harness.abortTask(taskId, context);
		await expect(pendingDetails).rejects.toBeDefined();
		await submission.wait(context);
		await harness.close(context);
	});

	// 工具先 durable 提交 "durable\n"，第二个 "buffered\n" 还在缓冲区；取消后结果只包含已提交输出，
	// 缓冲区内容丢弃，并追加 aborted 错误诊断。
	it("answers an aborted tool with only its durable output, discarding buffered output", async () => {
		const setup = chatSetup();
		let reached!: () => void;
		const buffered = new Promise<void>((resolve) => {
			reached = resolve;
		});
		addTool(
			setup.registry,
			tool("slow", async (_args, api, callContext) => {
				api.output("durable\n");
				// 下面的 20ms 等待让第一个输出完成提交，再报告第二个，使它落在缓冲区里。
				// The first output commits at once; this one waits for the next throttle window.
				await new Promise((resolve) => setTimeout(resolve, 20));
				api.output("buffered\n");
				reached();
				// 一直等待，直到 abort 事件触发时以取消原因拒绝，模拟可取消的长时间工具。
				await new Promise((_, reject) =>
					callContext.abortSignal!.addEventListener("abort", () => reject(callContext.abortSignal!.reason)),
				);
				return {};
			}),
		);
		setup.faux.setResponses([calls(["slow", {}, "c1"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		// 第二个输出已进入缓冲区；随后测试从实时槽位取得任务 id 并取消该任务。
		await buffered;
		const taskId = (await harness.snapshot(LiveDoc, root.id, context))!.tools![0]!.taskId!;
		await harness.abortTask(taskId, context);
		await submission.wait(context);
		// 结果只有已提交的 durable 输出与 Harness 的 aborted 诊断，没有 buffered。
		expect(resultText(results(await allEntries(root))[0]!)).toBe(
			"durable\n|<harness>\n[error] Tool slow was aborted\n</harness>",
		);
		await harness.close(context);
	});
});
