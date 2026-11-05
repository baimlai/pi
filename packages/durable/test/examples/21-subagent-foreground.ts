// 文件导读
// 所属：packages/durable/test/examples 的 21-subagent-foreground.ts，Durable 示例系列第 21 个，演示“前台子代理工具”。
// 演示内容：父模型调用 subagent 工具；工具在自己的调用事务里创建一个由该工具任务拥有的子会话，提交任务并等待回答，
// 再把回答作为工具结果返回给父模型。UI 通过工具运行中的 details.conversationId 找到子会话，并把子会话条目缩进打印在调用下。
// 上游入口：node 直接运行本文件；存在 OPENAI_API_KEY 时使用真实 OpenAI，否则用脚本化 faux 模型离线运行。
// 下游依赖：Durable 的 Harness/defineTool/defineExtension/configure/AssistantEntry，pi-ai 的 createModels 与 faux/openai provider。
// 能力清单：answerText 把助手条目转成文本；Subagent 扩展与 replay-safe 工具；按环境选择模型；print 打印助手条目；
// attach 递归订阅父/子会话并去重；提交与等待；waitForIdle。
// 典型顺序：构造 Subagent 扩展 -> 选择模型 -> 安装扩展并打开 MemoryStorage -> 订阅根会话 -> 提交请求 ->
// 等待回答与空闲 -> 关闭。
// 前置条件与费用：无 key 时完全离线；设置 OPENAI_API_KEY 后会发真实模型请求并产生费用（脚本自动选择）。
// 预期输出：父会话的 assistant/tool 行，以及缩进显示的子代理 assistant 行；本例不打印子代理的工具结果。
// 阅读顺序：先看 Subagent 扩展（事务创建子会话、replay 安全、owned 生命周期），再看 UI 的 attach 递归与主流程。
// A foreground subagent tool: the parent's tool call creates a child conversation it owns, runs one task there, and
// returns the child's answer. Aborting the tool call aborts the child. A UI finds the child through the tool's running
// details and shows its view under the call.
// Uses OpenAI when OPENAI_API_KEY is set, and a scripted faux model otherwise.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/21-subagent-foreground.ts

// import type 只导入类型，编译/擦除阶段后不会产生运行时绑定；下一行的 BACKGROUND_CONTEXT 才是运行时值。
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { obj, str } from "@earendil-works/pi-schema";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	createRegistry,
	defineExtension,
	defineTool,
	type EntryId,
	type EntryRecord,
	type Extension,
	Harness,
	type LiveState,
	MemoryStorage,
	type ToolExecutionApi,
} from "../../src/index.ts";

// 共享操作上下文；工具的提交、子会话等待和 watch 都沿用它，不额外设置取消信号。
const context = BACKGROUND_CONTEXT;

// ─── Product code: the subagent extension ───────────────────────────────────

// 把一条助手条目转换成纯文本。输入：工具 API、回答条目 ID、调用上下文；输出：所有文本块拼接结果。
// 副作用：在 api.commit 中读取条目（读也走事务线）；错误：条目缺失或模型消息不存在时下面会抛错。
// 主流程：事务读取条目 -> 取首条模型消息 -> 过滤文本块并 join。
// 示例：answerText(api, settled.answer, ctx) 对回答 "Hi" 返回 "Hi"。
async function answerText(api: ToolExecutionApi, answer: EntryId, callContext: Context): Promise<string> {
	// api.commit 把回调放进当前工具任务的事务；tx.entry 用类型令牌 AssistantEntry 读取并收窄条目。
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), callContext);
	// ?. 在条目缺失时返回 undefined；[0] 取该条目的首条模型消息；as 只是编译期断言，运行时可能是 undefined。
	const message = entry?.model?.[0] as AssistantMessage;
	// flatMap 对文本块返回单元素数组、对其他块返回空数组，从而过滤并展开；join 合并为一个字符串。
	return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}

// 显式标注 Extension 便于把扩展对象放进注册表；defineExtension 本身只做结构和名字检查。
const Subagent: Extension = defineExtension({
	name: "subagent",
	tools: [
		// 工具名为 subagent；参数 schema 同时决定 args 的 TypeScript 类型，并由 Harness 在 execute 前运行时校验。
		defineTool({
			name: "subagent",
			// description 会发给模型，帮助它决定何时调用该工具。
			description: "Delegate a self-contained task to a subagent and get its answer back.",
			// obj/str 来自 pi-schema；生成的 JSON Schema 既推导 args.task: string，也在运行时拒绝缺参或类型错误。
			parameters: obj({ task: str({ description: "What the subagent should do" }) }),
			// replay: "safe" 表示进程在调用中崩溃后可以在重开时重跑；下面的 ownership 索引与 requestId 让重跑复用已有子会话和提交。
			// Safe to rerun after a crash: a rerun finds the child it already created and the submission it already made.
			// 非 replay-safe 的工具被崩溃打断后，模型会收到 interrupted 错误结果，而不是自动重跑。
			replay: "safe",
			// execute 收到已校验参数、ToolExecutionApi 与调用上下文；抛出的错误会变成模型的错误工具结果，并中止本调用拥有的子会话。
			execute: async (args, api, callContext) => {
				// 解构出已校验的任务文本；类型由 parameters 推导为 string。
				const { task } = args;
				// The child is owned by this tool call's task, so aborting the call aborts the child, and the call
				// finishes only once the child's work is done.
				// 在工具任务的提交里创建或找回子会话；整个回调与返回的 id 原子落库。
				const child = await api.commit(async (tx) => {
					// Ownership records the child: a rerun of this call finds it instead of creating another.
					// 按拥有者任务扫描会话；重跑时能找回上次创建的子会话，避免创建第二个。返回页的 items 是数组。
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					// 找到就直接复用；undefined 检查把联合类型收窄到存在分支。
					if (existing !== undefined) return existing.id;
					// Starts as a copy of this conversation's agent: model, thinking level, cwd, extensions, tools.
					// 创建一个归本工具任务所有的子会话；它从父会话复制 agent（模型、扩展、cwd 等），因此也带有 subagent 工具。
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					// Without this extension, the child is not offered this tool.
					// configure 的事务重载在同一提交里修改子会话 agent；移除 Subagent 扩展，防止子代理继续递归创建子代理。
					await configure(tx, created.id, { extensions: { remove: [Subagent] } });
					// 提交回调返回新会话 ID；提交成功后外层 await 得到该值。
					return created.id;
				}, callContext);
				// A UI watching the parent sees this and can attach to the child.
				// 把子会话 ID 写进工具运行中的 details；父会话的 watch 能从 pi.live 工具槽位读到它并附着 UI。
				await api.details({ conversationId: child }, callContext);

				// 取得本次调用绑定的会话句柄；! 是非空断言，找不到会话时这里会抛错（调用结束后的句柄操作也会拒绝）。
				const handle = (await api.conversation(child, callContext))!;
				// The request ID makes a rerun get back the submission it made before the crash.
				// as const 保留字面量类型，让 type 收窄为 "input"；固定 requestId 保证工具重跑时拿到同一份提交。
				const request = { type: "input", content: task, requestId: `subagent:${api.taskId}` } as const;
				// 内层 await 等提交被接纳，外层等这份输入结算；取消 callContext 只取消等待，不撤销已接纳的工作。
				const settled = await (await handle.submit(request, callContext)).wait(callContext);
				// 先排除失败或非输入结算；|| 两边的状态检查共同把联合类型收窄到“已答输入”。
				if (settled.status !== "done" || settled.type !== "input") {
					// 抛出后 Harness 把它转成错误工具结果；本工具拥有的子会话也会随调用失败被中止。
					throw new Error(`Subagent failed: ${settled.status}`);
				}
				// 读取子代理回答条目的文本；settled.answer 只有在上一分支的收窄后才存在。
				const text = await answerText(api, settled.answer, callContext);
				// output 是给模型的文本；details 再带一次子会话 ID，UI 在调用结束后仍能关联。
				return { output: [{ type: "text", text }], details: { conversationId: child } };
			},
		}),
	],
});

// ─── Host setup ─────────────────────────────────────────────────────────────

// 宿主模型目录；下面按环境决定安装真实 provider 还是 faux。
const models = createModels();
// let 因为下面可能改成 faux；对象字面量的字段类型被推断为 string，后续赋相同形状的值不报错。
let model = { provider: "openai", modelId: "gpt-6-sol" };
// process.env 的索引结果类型是 string | undefined；与 undefined 比较可同时处理“未设置”。
if (process.env.OPENAI_API_KEY !== undefined) {
	// 真实 OpenAI provider 从环境读取凭据；此分支会产生网络请求和费用。
	models.setProvider(openaiProvider());
} else {
	// The parent delegates, the child answers, and the parent reports.
	// 离线分支：创建脚本化 provider，不访问网络。
	const faux = fauxProvider();
	// 注册 faux provider。
	models.setProvider(faux.provider);
	// 把根会话模型切换到 faux；父、子会话共用这个模型目录。
	model = { provider: "faux", modelId: "faux-1" };
	// 预置父模型的一次 subagent 调用；id 用于把结果与调用对应。
	const delegate = fauxToolCall("subagent", { task: "Name three prime numbers." }, { id: "call-1" });
	// 三步脚本：父调用工具 -> 子代理回答 -> 父模型转述。
	faux.setResponses([
		// stopReason: "toolUse" 告诉 Harness 这一轮要执行工具。
		fauxAssistantMessage([delegate], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("2, 3, and 5.")]),
		fauxAssistantMessage([fauxText("The subagent says: 2, 3, and 5.")]),
		// satisfies 检查数组元素符合 FauxResponseStep，同时保留更具体字面量推断，不会把整个值拓宽成该类型。
	] satisfies FauxResponseStep[]);
}
// 应用自己的注册表；内置任务已存在。
const registry = createRegistry();
// 安装子代理扩展，使根会话默认选中它。
registry.install(Subagent);
// 在内存存储上打开 Harness；子会话、任务和条目都只在本进程内。
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
// 创建根会话并保存模型引用；model 是上面的 let 变量。
const root = await harness.root(context, { agent: { model } });

// ─── UI: the parent's transcript, with each subagent's indented under its call ───

/** Print an assistant entry's text and tool calls. */
// UI 辅助：只打印助手条目的文本与工具调用，并按 indent 缩进子会话内容。
const print = (indent: string, entry: EntryRecord): void => {
	// 条目可能没有模型消息（例如纯数据条目）；?. 在这里返回 undefined。
	const message = entry.model?.[0];
	// 两个条件共同过滤非助手条目；message?.role 同时处理 message 缺失。
	if (entry.kind !== "pi.assistant" || message?.role !== "assistant") return;
	// 前面只检查了 role；as 断言提供 content 的联合类型，运行时不会补全字段。
	for (const block of (message as AssistantMessage).content) {
		// 只打印非空文本块；block.type 检查把联合收窄到 text 分支。
		if (block.type === "text" && block.text !== "") console.log(`${indent}assistant: ${block.text}`);
		// 工具调用块打印名称与参数；JSON.stringify 让参数在一行内可读。
		if (block.type === "toolCall") console.log(`${indent}tool ${block.name}(${JSON.stringify(block.arguments)})`);
	}
};
// 记录已订阅的会话，避免父、子 watch 反复附着同一个子会话；ConversationId 是带 brand 的字符串类型。
const attached = new Set<ConversationId>();
// 订阅一个会话并把新增条目打印在给定缩进下；发现运行中的工具 details 指向新子会话时递归订阅。
// 副作用：创建并启动 watch，本例直到 Harness 关闭才随会话结束。错误：会话不存在时 ! 断言处会抛错。
const attach = async (id: ConversationId, indent: string): Promise<void> => {
	// 先登记，避免递归路径重复订阅。
	attached.add(id);
	// 先取得会话句柄，再 watch；内层 await 等句柄，外层等 watch 附着。
	const watch = await (await harness.conversation(id, context))!.watch(context);
	// 记录附着时最新条目 ID；at(-1) 取末尾，空窗口回退 0，后续只打印更新的条目。
	let newest = watch.value.entries.at(-1)?.id ?? 0;
	// 每次提交触发回调；一个回调处理一帧合并后的视图。
	watch.start(async (call) => {
		// 按 kind 收窄；Durable watch 不会发 failed 帧，提前返回让后面可直接访问 value。
		if (call.kind !== "value") return;
		// 解构出本次视图；entries 是窗口，不是完整历史。
		const { value } = call;
		// 只打印比上次更新且仍在窗口内的条目；若窗口丢弃了旧条目，这里不会补打。
		for (const entry of value.entries) if (entry.id > newest) print(indent, entry);
		// 更新水位；窗口为空时保留旧值。
		newest = value.entries.at(-1)?.id ?? newest;
		// A running subagent call names its child conversation in its details.
		// 遍历运行中的工具槽位；?? [] 处理没有 tools 字段的情况，as 只是编译期断言。
		for (const slot of (value.docs["pi.live"] as LiveState).tools ?? []) {
			// details 是 JSON；断言成可选字段形状后读取 conversationId，运行时不做结构校验。
			const child = (slot.details as { conversationId?: ConversationId } | undefined)?.conversationId;
			// 发现未订阅的子会话就递归；模板字符串追加两个空格作为缩进。
			if (child !== undefined && !attached.has(child)) await attach(child, `${indent}  `);
		}
	});
};
// 从根会话开始订阅；子会话由上面的 details 递归发现。
await attach(root.id, "");

// 提交交给父代理的任务；submit 返回后 run 已在调度。
const submission = await root.submit(
	{ type: "input", content: "Use the subagent tool to find three prime numbers, then tell me what it said." },
	context,
);
// 等父输入结算（子代理回答最终会作为工具结果进入父会话）。
await submission.wait(context);
// 等普通所有权范围内的任务全部空闲；前台子会话归工具调用所有，因此也被包含。
await harness.waitForIdle(context);
// Watch callbacks run after their commit; let the last ones print.
// watch 回调在提交之后异步运行；让出一次事件循环，给最后的打印机会。
await new Promise((resolve) => setTimeout(resolve, 0));
// 关闭 Harness；本例没有 finally，异常路径会跳过清理。
await harness.close(context);
