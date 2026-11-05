// 文件导读
// 所属：packages/durable/test/examples 的 32-tests-after-edits.ts，Durable 示例系列第 32 个，演示“编辑后自动跑测试”。
// 演示内容：扩展提供 edit 工具和 app.run-tests 任务，并用 GenerationTask 的 afterRun 钩子检查本轮是否出现 edit 工具结果；
// 有编辑就请求 RunTests 子任务；子任务失败时在自身提交里接纳一条 whenBusy=followUp 的修复输入（最多 3 次）。
// 运行回答后会话仍保持忙碌直到测试任务终态；此间用户再提交的问题排在修复输入之前运行。
// 上游入口：node 直接运行本文件；固定 faux 响应，无网络；项目文件用内存 Map 模拟，不执行真实测试命令。
// 下游依赖：Durable 的 Harness/defineExtension/defineTool/defineTask/hook/runEndTask/LiveDoc/ToolResultEntry，
// pi-ai 的 faux provider，pi-schema 的 obj/str。
// 能力清单：内存项目与 runTests；edit 工具；RunTests 任务的 run/abort 相位；afterRun 扫描 edit 结果并请求任务；
// 五个脚本化响应；submission.wait 的结算状态；LiveDoc.run.afterRun；忙碌期排队；按正序打印记录。
// 典型顺序：定义项目/工具/任务/扩展 -> 配置 faux -> 安装并打开 Harness -> 提交“清理” -> 等回答并观察忙碌 ->
// 提交问题排队 -> 等空闲 -> 打印 user/assistant/tests 记录 -> 关闭。
// 前置条件：无需 API key；任务与钩子真实执行，但“测试”只检查源码子串，不启动进程。
// 预期输出：answered: done；busy with after-run tasks: true；第一次测试失败，用户问题回答后修复输入运行，
// 第二次测试通过；记录按 Clean up -> I cleaned up add. -> tests 失败 -> Are the tests green now? ->
// Not yet... -> The tests failed... -> Fixed: add adds now. -> tests 1 passed 的顺序打印。
// 阅读顺序：先看 runTests/edit 与 RunTests 任务，再看 afterRun 如何扫描历史并请求任务，最后看宿主的提交与打印。
// Run the project's tests at the end of every run that edited files, with an `afterRun` hook: the run waits for the
// tests, a failure starts a fix run, and input sent meanwhile waits for them too.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/32-tests-after-edits.ts

// BACKGROUND_CONTEXT 是不带取消信号的根上下文；所有提交、读取与钩子调用都共享它。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import {
	createRegistry,
	defineExtension,
	defineTask,
	defineTool,
	GenerationTask,
	Harness,
	hook,
	LiveDoc,
	MemoryStorage,
	// runEndTask 只把任务定义和输入打包成普通对象；真正的任务由 generation 在 afterRun 返回后统一创建。
	runEndTask,
	// ToolResultEntry.is 是运行时判别函数；用它可以区分工具结果记录与其他记录，而不是看数据形状。
	ToolResultEntry,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// ─── Product code: the project, an edit tool, and the test runner ─────────────

// The project under test, in memory: the tests pass once `add` adds.
// 内存项目：math.ts 故意把加法写成减法；真实项目会读写磁盘，这里只用一个 Map 让副作用可见。
const files = new Map([["math.ts", "export const add = (a, b) => a - b;"]]);
// 同步“测试运行器”：检查 math.ts 是否包含 "a + b"，返回 { passed, output }。
// 输入无；输出是普通对象；副作用只有读 Map，不启动进程、不写文件。
// 例：当前源码是 a - b 时返回 { passed: false, output: "add(1, 2): expected 3, got -1" }。
const runTests = () => {
	// ! 是非空断言：调用方假定 math.ts 一定存在，运行时并不检查；键缺失时这里会抛 TypeError。
	// includes 只是演示用的粗糙判断，不是真正的测试框架。
	const passed = files.get("math.ts")!.includes("a + b");
	// 返回值的两个字段都进入任务结果与日志；失败文本同时用于修复输入，因此要能说明问题。
	return { passed, output: passed ? "1 passed" : "add(1, 2): expected 3, got -1" };
};

// 声明 edit 工具：名称、描述、参数 schema 与执行函数。
// defineTool 只构造声明，不执行；工具在 agent 解析时才注册，模型调用时先按 parameters 做运行时校验。
// 例：模型调用 edit({ path: "math.ts", content: "..." }) 时 execute 收到已校验、已推断类型的 args。
const edit = defineTool({
	name: "edit",
	description: "Replace a file's content",
	// pi-schema 的 obj/str 同时给出运行时参数校验和 TypeScript 参数类型；这是模型输入进入工具前的信任边界。
	parameters: obj({ path: str(), content: str() }),
	// args 的类型由上面的 schema 推断为 { path: string; content: string }，无需再写类型注解。
	execute: async (args) => {
		// 工具的真实副作用：覆盖内存中的文件内容；示例没有路径限制，生产工具应校验允许的目录。
		files.set(args.path, args.content);
		// 工具结果用文本块数组表示；这段文本会进入模型上下文，也决定 afterRun 能用 toolName 找到这次调用。
		return { output: [{ type: "text", text: `wrote ${args.path}` }] };
	},
});

// A durable task: it runs once the run answered, and the run ends after it. A crash resumes it.
// 定义一个持久化任务：泛型依次是输入 { attempt }、状态 { phase: "run" }、结果 boolean。
// name/version 组成任务身份；name 用于注册与钩子匹配，version 用于重开时选择迁移。
// initial 给出新任务的初始状态；phases 的键与状态里的 phase 字面量对应。
const RunTests = defineTask<{ attempt: number }, { phase: "run" }, boolean>({
	name: "app.run-tests",
	version: 1,
	// 初始状态只带判别字段 phase: "run"；这个字面量让 phases.run 成为该状态下的处理器。
	initial: () => ({ phase: "run" }),
	phases: {
		// run 相位处理器：task 是持久任务记录（含 input），runtime 提供会话/提交/睡眠等能力，ctx 是取消上下文。
		// 输出是下一次状态或终止结果；抛错会让任务保留并可被调度器重试，已提交的写入不会丢。
		// 例：这次运行先读测试结果，再在一个提交里写记录并结束任务。
		run: async (task, runtime, ctx) => {
			// 测试运行是同步的普通函数；真实场景可能在任务里启动子进程，但同样要保持幂等，因为任务可能重试。
			const result = runTests();
			// attempt 来自任务输入，而不是任务内部状态；它由 afterRun 在创建任务时决定，便于日志区分第几轮。
			console.log(`  [tests, attempt ${task.input.attempt}] ${result.output}`);
			// The handle is fetched before the commit: inside it, runtime reads would wait for the commit itself.
			// 先取会话句柄再进入提交：在 runtime.commit 回调里做 runtime 读取会等待本次提交自身，形成阻塞。
			// ! 表示任务一定属于一个已存在的会话；运行时若返回 undefined 会在使用处抛错。
			const conversation = (await runtime.conversation(runtime.conversationId, ctx))!;
			// 一个持久提交同时完成三件事：接纳修复输入、追加测试记录、返回终止结果；任一步抛错则全部不生效。
			await runtime.commit(async (tx) => {
				// Admitted with this commit, before its own table writes: placed when the run ends.
				// 只有失败且未到第 3 次才请求修复；这个条件就是示例自己给循环设的上限，避免无限重试。
				if (!result.passed && task.input.attempt < 3) {
					// 在同一个 tx 内接纳一条输入：它必须排在本次提交的第一条表写入之前，否则会抛 ReadAfterWrite。
					await conversation.submit(tx, {
						type: "input",
						content: `The tests failed: ${result.output}. Fix it.`,
						// followUp 表示当前运行忙时排队到下一轮；此任务结束时运行仍处于“等待 afterRun 任务”的忙碌状态。
						whenBusy: "followUp",
						// requestId 是会话内的去重键：任务重试或崩溃恢复后重复接纳同一 attempt 不会产生两条修复输入。
						requestId: `fix-${task.input.attempt}`,
					});
				}
				// 追加一条显示型记录，kind 为 app.tests；它不是模型消息，但会出现在会话记录里供 UI 展示。
				await tx.appendEntry(runtime.conversationId, { kind: "app.tests", data: result });
				// 返回终止状态：completed 带布尔结果，任务到此结束；返回类型必须匹配 defineTask 的 Result。
				return { status: "terminal", outcome: { status: "completed", result: result.passed } };
			}, ctx);
		},
	},
	// abort 处理器在任务被中止时运行；_task 表示这里不需要任务记录，参数名前的下划线只是约定。
	// 中止也走一次持久提交；as const 让 status/outcome 保持字面量类型，满足终止结果的可辨识联合。
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }) as const, ctx),
});

// 模块级计数器：每次 afterRun 请求测试就自增；示例靠它给任务输入和 requestId 编号。
let attempts = 0;
// 扩展把工具、任务与钩子打包成一份可选安装的声明；registry.install 后由会话的 settings 决定是否启用。
const TestsAfterEdits = defineExtension({
	name: "tests-after-edits",
	// 工具声明只有 edit；模型能看到的工具名来自这里。
	tools: [edit],
	// 任务声明让 Harness 能按名称找到 app.run-tests，并在重开后继续执行它的相位。
	tasks: [RunTests],
	hooks: [
		hook(GenerationTask, {
			// afterRun 在本轮回答已提交、输入已 done 后调用；返回的任务成为 generation 的子任务，运行保持忙碌直到它们终态。
			// run 给出本轮 first/last 等边界，api 提供条目读取与模型目录，ctx 是取消上下文。
			// 返回 undefined 表示不请求任务；返回 { tasks } 表示请求创建这些子任务。
			afterRun: async (run, api, ctx) => {
				// The run's own entries, from its first input to its answer; a compaction never removes them.
				// 只看本轮自己的条目：first..last 是含端点区间；as const 让 order 保持字面量类型，满足 EntryQuery 的联合。
				const range = { minEntryId: run.first, maxEntryId: run.last, order: "ascending" } as const;
				// api.entries 读取任务所在会话的已提交历史；limit 1000 是示例假设，真实实现应处理分页。
				const { items } = await api.entries(range, 1000, undefined, ctx);
				// some 短路：找到第一条 edit 工具结果就停止扫描；回调返回布尔值。
				const edited = items.some((entry) => {
					// 每条记录可能带模型消息；?.[0] 在 model 缺失时返回 undefined，而不是让下标访问抛错。
					const message = entry.model?.[0];
					// 运行时判别顺序：先确认记录是工具结果，再确认消息角色，最后看工具名；&& 同时完成类型收窄。
					return ToolResultEntry.is(entry) && message?.role === "toolResult" && message.toolName === "edit";
				});
				// Each fix run asks again with a fresh turn budget: the extension caps the loop itself.
				// 有编辑就请求一个测试任务，输入 attempt 用前缀自增；没有编辑返回 undefined，表示该钩子不改变任何东西。
				// 这是“每轮结束跑测试”的核心：任务何时创建由 generation 统一安排，钩子本身不直接创建。
				return edited ? { tasks: [runEndTask(RunTests, { attempt: ++attempts })] } : undefined;
			},
		}),
	],
});

// ─── Host setup ─────────────────────────────────────────────────────────────

// fauxProvider 创建确定性的假 provider；默认模型 id 是 faux-1，不访问网络。
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
// 按顺序消费的响应脚本：前两条属于首个 run，第三条属于排队的问题，最后两条属于修复 run。
faux.setResponses([
	// The first run edits, wrongly.
	fauxAssistantMessage(fauxToolCall("edit", { path: "math.ts", content: "export const add = (a, b) => a - b + 0;" }), {
		stopReason: "toolUse",
	}),
	fauxAssistantMessage("I cleaned up add."),
	// The user's question, queued first, runs first; it edits nothing, so no tests run after it.
	fauxAssistantMessage("Not yet: add subtracts. The fix is queued next."),
	// The fix run the failed tests started.
	fauxAssistantMessage(fauxToolCall("edit", { path: "math.ts", content: "export const add = (a, b) => a + b;" }), {
		stopReason: "toolUse",
	}),
	fauxAssistantMessage("Fixed: add adds now."),
]);

// 注册表持有可安装的扩展声明；Harness 解析 agent 时从这里取工具、任务与钩子。
const registry = createRegistry();
registry.install(TestsAfterEdits);
// 内存存储让任务、提交与记录都留在进程内；打开 Harness 后调度器按需运行任务。
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
// 根会话显式选择 faux-1；扩展来自 Harness settings 的默认集合，本例没有覆盖 settings，因此使用注册表里的全部扩展。
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

// submit 先完成接纳并返回句柄；真正等待模型回答与后续任务结算要用 wait()。
const submission = await root.submit({ type: "input", content: "Clean up math.ts." }, context);
// Resolves with the answer; the conversation stays busy while the tests run.
// wait 在输入结算后返回结算对象；status 为 done 表示得到回答。此后运行可能仍在等 afterRun 任务，所以接下来查 LiveDoc。
console.log("answered:", (await submission.wait(context)).status);
// 读取 pi.live 的已提交快照；run 存在表示会话忙碌，afterRun 存在表示回答后还在等钩子请求的任务。
const live = await harness.snapshot(LiveDoc, root.id, context);
// 两级可选链：快照或 run 缺失时表达式为 undefined，与 undefined 比较得到 false；预期为 true。
console.log("busy with after-run tasks:", live?.run?.afterRun !== undefined);
// Sent while the tests run: it waits for them. Follow-ups run in queue order, so it runs before the fix run.
// 测试任务运行期间再提交：默认 whenBusy 是 followUp，因此排队等待，不会打断当前运行。
// 它比测试失败后接纳的修复输入更早入队，所以先运行。
await root.submit({ type: "input", content: "Are the tests green now?" }, context);

// 等待普通所有权范围内没有存活任务，且所有提交已结算；这里会跨过测试、用户问题与修复 run。
await root.waitForIdle(context);
// 按 ID 正序读取最多 100 条原始记录；order 是 EntryQuery 的字段，cursor 为 undefined 表示第一页。
const page = await root.entries({ order: "ascending" }, 100, undefined, context);
// 按时间顺序打印三类内容：自定义测试记录、用户输入、助手文本；工具调用等记录被忽略。
for (const entry of page.items) {
	const message = entry.model?.[0];
	// app.tests 是普通记录，不是模型消息；data 的静态类型是 JsonValue，这里的 as 只在编译期收窄，
	// 运行时不校验 output 字段是否存在。
	if (entry.kind === "app.tests") console.log("tests:", (entry.data as { output: string }).output);
	// 用户消息直接打印 content；message 对 app.tests 记录可能为 undefined，因此先用可选链判断。
	else if (message?.role === "user") console.log(">", message.content);
	// 助手消息可能含文本、工具调用与思考块；下面只拼接文本块。
	else if (message?.role === "assistant") {
		// flatMap 把文本块映射为单元素数组、其他块映射为空数组，再 flatten；join 合并为一段文本。
		const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		// 只打印有文本的助手消息；工具调用轮的助手消息文本为空，因此被跳过。
		if (text !== "") console.log("agent:", text);
	}
}
// 关闭 Harness 管理的会话、任务与调度；示例没有 finally，前面的错误会跳过清理。
await harness.close(context);
