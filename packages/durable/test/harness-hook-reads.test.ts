// 验证钩子和任务读取的是已提交原始历史，并能按条目 ID 翻页、限定范围。
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTask,
	type EntryRecord,
	GenerationTask,
	hook,
	MemoryStorage,
	UserEntry,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { allEntries, chatSetup, openChat } from "./chat-support.ts";
import { context } from "./session-support.ts";
import { completed } from "./task-support.ts";

// 本组只用 faux 内存应答，不访问模型供应商。
describe("entry reads for hooks and tasks", () => {
	// #11141
	// 无参数；安装一个 onYield 观察器，提交 go，检查它看到 pi.user 而未看到待提交的答案。
	// 例：pi.user 的 ID 可按 UserEntry 取回；用不同 kind 取同一 ID 得到 undefined。
	// 异步 API/断言错误交给 Vitest；结束时显式关闭 Harness。
	it("reads raw history and single entries from a hook", async () => {
		// chatSetup 创建 Models、可变设置、注册表和 faux 提供器。
		const setup = chatSetup();
		// 数组记录观察结果；user? 是可省略属性，[] 表示这样的对象组成的数组。
		const seen: { kinds: string[]; user?: string }[] = [];
		// 安装扩展；默认选择规则会让此普通扩展参与根会话。
		setup.registry.install(
			defineExtension({
				// 名称作为扩展身份，不是向模型发出的指令。
				name: "reader",
				// hook 按 GenerationTask 的类型核对处理器，在运行时按任务名匹配。
				hooks: [
					hook(GenerationTask, {
						// 输入答案未使用；api 提供已提交读取，ctx 传递本次调用的上下文。
						// 返回 undefined 表示不提议修改答案；副作用仅写 seen 与执行断言。
						onYield: async (_answer, api, ctx) => {
							// ascending 为从旧到新，最多 10 条，无游标表示从第一页开始。
							const page = await api.entries({ order: "ascending" }, 10, undefined, ctx);
							// ! 只向 TS 声明本夹具预期至少有用户条目；本身不检查数组非空。
							const first = page.items[0]!;
							// UserEntry token 限定 kind；同一 ID 不属于该 kind 时返回 undefined。
							const user = await api.entry(UserEntry, first.id, ctx);
							// map 抽出 kind，展开语法按读取结果有条件地加入 user 属性。
							seen.push({
								kinds: page.items.map((entry) => entry.kind),
								...(user === undefined ? {} : { user: user.kind }),
							});
							// Another kind: undefined.
							// as never 故意绕过 token 的静态约束，以验证真实运行时 kind 匹配。
							expect(await api.entry(GenerationTask as never, first.id, ctx)).toBeUndefined();
							// 不拦截、不改写生成结果。
							return undefined;
						},
					}),
				],
			}),
		);
		// 预置唯一的内存回答，然后打开内存 Harness 与根会话。
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		// 第一次 await 接纳输入，第二次 wait 等待回答终态。
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		// The answer is not committed yet when `onYield` asks.
		// 只检查钩子发生时的历史；并非声称整个会话永远没有 assistant 条目。
		expect(seen).toEqual([{ kinds: ["pi.user"], user: "pi.user" }]);
		// 释放 Harness 的调度与存储资源。
		await harness.close(context);
	});

	// #11141
	// 无参数；先完成 go/done 对话，再启动 Reader 任务读三页并比较 ID。
	// 泛型依次指定任务输入 null、带 phase 的检查点、完成结果 null；不是 JSON 校验器。
	// 例：第一页用户、游标后第二页助手、ID 上下界相同再取助手；错误令测试失败。
	it("pages a task's conversation history by entry ID range", async () => {
		// 新建独立环境；readonly EntryRecord[] 禁止通过页引用修改数组，外层数组仍能 push。
		const setup = chatSetup();
		const pages: (readonly EntryRecord[])[] = [];
		// defineTask 注册任务定义，创建任务时才运行 initial 和具体 phase。
		const Reader = defineTask<null, { phase: "run" }, null>({
			// kind/version 标识持久任务定义的身份和版本。
			name: "test.reader",
			version: 1,
			// 无输入处理；初始检查点把调度器引向 run，不执行读取。
			initial: () => ({ phase: "run" }),
			phases: {
				// runtime 作用于任务所属会话；按页读取后提交完成态，结果是 null。
				run: async (_task, runtime, ctx) => {
					// 第一页最多一条，升序确保先读到用户。
					const all = await runtime.entries({ order: "ascending" }, 1, undefined, ctx);
					pages.push(all.items);
					// 使用上一页 next 继续，而非从 ID 自行推算游标。
					const rest = await runtime.entries({ order: "ascending" }, 1, all.next, ctx);
					pages.push(rest.items);
					// min/max 都取第二条 ID；范围包含边界，故仍能返回它。
					const bounded = await runtime.entries(
						{ minEntryId: rest.items[0]!.id, maxEntryId: rest.items[0]!.id },
						10,
						undefined,
						ctx,
					);
					// 保存范围页，并在事务中返回 completed(null) 让任务真正终结。
					pages.push(bounded.items);
					await runtime.commit(() => completed(null), ctx);
				},
			},
			// 此夹具无外部副作用可撤销；abort 仅提供空的异步处理器。
			abort: async () => {},
		});
		// 任务定义必须在注册表中，调度器才知道怎样执行已持久化的任务名。
		setup.registry.install(defineExtension({ name: "reader", tasks: [Reader] }));
		// 先形成两条已提交对话历史。
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		// 在根会话事务里创建会话拥有的 Reader；输入为 null，返回新任务 ID。
		const id = await root.commit(
			(tx) => tx.createTask(Reader, null, { ownership: { kind: "conversation" } }),
			context,
		);
		// 等读页完成后才检查 pages，避免观察到半个执行过程。
		await harness.waitForTask(id, context);
		// 另取原始完整历史，用实际 ID 作预期，而不硬编码 ID 分配方式。
		const entries = await allEntries(root);
		expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
		// 双层 map 把每页记录转为 ID，明确证明游标与闭区间的结果。
		expect(pages.map((page) => page.map((entry) => entry.id))).toEqual([
			[entries[0]!.id],
			[entries[1]!.id],
			[entries[1]!.id],
		]);
		// 本用例独享 Harness，测试结束后正常关闭。
		await harness.close(context);
	});
});
