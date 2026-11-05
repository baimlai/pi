// 文件导读
// 所属：packages/durable/test/examples 的 22-subagent-background.ts，Durable 示例系列第 22 个，演示“持久后台子代理”。
// 演示内容：一个 subagent 工具管理具名子代理，支持 spawn/send/stop/status；子代理在主代理回答用户时继续工作，
// 回答完成后由后台 reporter 任务作为 follow-up 输入送回主会话；示例在子代理工作中关闭 Harness，用同一 sqlite 文件重开，
// 验证消息只投递一次、回答只上报一次，并最终取回重启前发出的回答。
// 上游入口：node 直接运行本文件；存在 OPENAI_API_KEY 时用真实 OpenAI，否则用按最后一条消息路由的 faux 脚本。
// 下游依赖：Durable 的 Harness/defineTask/defineDoc/defineTool/configure/LiveDoc/AssistantEntry，pi-ai 的模型与 faux/openai provider。
// 能力清单：Subagents 文档；Anchor 与 Reporter 两个任务；subagent 工具四个动作；faux route 脚本；
// sqlite 存储与可重开的 open()；主会话 follow() UI；say/settle/until/working 辅助；重启演示。
// 典型顺序：定义文档与任务 -> 定义工具并打包扩展 -> 选模型 -> 安装扩展 -> 打开 sqlite Harness -> 订阅主会话 ->
// spawn/send/stop/status -> 关闭并重开 -> 等待 reporter 与空闲 -> 清理临时目录。
// 前置条件与费用：无 key 时离线运行，但包含真实定时器和 135 行流式长回答，需等待数秒；有 key 时会产生真实费用。
// 预期输出：主会话的用户行、工具调用行、工具结果行，以及紫色显示的 subagent 上报；重启提示后仍打印上报。
// 阅读顺序：先看 Subagents 文档与任务所有权注释，再看 Reporter 的两阶段流程，然后看工具的 spawn/send 提交，
// 最后看 route 脚本、UI 与重启流程。
// Persistent background subagents. One `subagent` tool lets the main agent start named subagents, message them
// (steer or follow up), stop them mid-answer, and list them. Subagents keep working while the main agent
// answers the user, and each answer is delivered back to the main agent as a new message once it arrives. Everything
// survives a restart: the example closes the Harness while a subagent works and reopens it.
// Uses OpenAI when OPENAI_API_KEY is set, and a scripted faux model otherwise.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/22-subagent-background.ts

// 临时目录保存 sqlite 文件；重开 Harness 时复用同一文件，因此重启后任务与条目仍在。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	Harness,
	LiveDoc,
	type TaskId,
} from "../../src/index.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

// 共享操作上下文；本例所有打开、提交、等待和 watch 都沿用它，不设置取消信号。
const context = BACKGROUND_CONTEXT;

// 以下为示例的“产品代码”：文档、任务、工具与扩展；宿主设置和 UI 在后面的分节。
// ─── Product code ────────────────────────────────────────────────────────────

// Each subagent is its own conversation with its own transcript, so it remembers earlier messages. The main
// conversation keeps a small document that maps subagent names to their conversations. Documents are durable state
// next to a transcript, changed in commits like entries.
// 子代理记录：会话 ID 与已上报的回答条目。输入：由 spawn 写入文档；输出：供 send/status/stop 查找。
// 示例：{ conversationId: "c2", reported: [12] } 表示该子代理的回答条目 12 已经送回主代理。
type Subagent = {
	conversationId: ConversationId;
	/** Answers already reported to the main agent: several messages can end in one answer, reported once. */
	// reported 只用于去重；EntryId 是带 brand 的 ID 类型，编译期防止误用普通数字，运行时仍是数字。
	reported: EntryId[];
};
// 定义主会话自己的登记文档。泛型给出存储形状；defineDoc 在定义时检查 kind/version 等字段，
// 读写时通过类型令牌把 JSON 还原成该形状。agents 按名字存子代理，reporters 按工具任务 ID 存 reporter 任务。
// 示例：tx.doc(Subagents, conversationId) 读取该会话的登记；首次访问用 initial() 创建。
const Subagents = defineDoc<{ agents: Record<string, Subagent>; reporters: Record<string, TaskId> }>({
	// 恒 false 表示普通变更只追加增量，不主动写完整检查点；文档仍随会话提交持久化。
	checkpointWhen: () => false,
	kind: "app.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	// A fork of the main conversation starts without subagents.
	// 主会话分叉时，子会话从空登记开始，不继承其他分支的子代理。
	fork: "initial",
	// 首次读取时生成的初始值；两个 Record 都为空。
	initial: () => ({ agents: {}, reporters: {} }),
});

// Every task and conversation has an owner, and that decides what an abort or an idle wait reaches: aborting a task
// aborts what it owns, and waiting for a conversation to be idle waits for its work. A subagent must outlive the main
// agent's turns, so its conversation is owned by an anchor: a background task that finishes at once. A background task
// is a boundary: the main agent's Esc and idle waits stop there, but `abort({ background: true })` still reaches past
// it, so a host can stop everything.
// Anchor 是“立刻完成的后台任务”，只用来充当子会话的拥有者。三个泛型依次是输入、持久状态、结果类型。
// 输入与结果都是 null；状态只有 phase: "done"。任务创建后第一个阶段立即提交终止，但作为拥有者仍能让子会话
// 不被主会话的 Esc 或空闲等待波及。
const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "app.subagent-anchor",
	version: 1,
	// 任务创建时的初始状态；阶段名与 phases 的键一致。
	initial: () => ({ phase: "done" }),
	phases: {
		// 阶段函数收到任务实例、TaskRuntime 和执行上下文；下划线前缀表示不使用任务实例。
		done: (_anchor, runtime, taskContext) =>
			// 提交一次终止决定；terminal 表示不再进入下一阶段，completed 的 result 与定义的第三个泛型 null 对应。
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext),
	},
	// abort 钩子把任务结算为 aborted；后台锚点被显式中止时也走这里。
	abort: (_anchor, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

// A reporter delivers one message to a subagent and reports the answer to the main agent. It is a background task
// too, so the main agent's Esc and idle waits leave it alone. Tasks are durable: each phase ends with a saved
// checkpoint, and after a restart the task continues from the last one. Request IDs make a repeated submission return
// the first one, so the subagent gets the message once and the main agent gets the report once.
// reporter 的持久输入：目标名字、子会话 ID、消息文本、忙碌时用 follow-up 还是 steer。
// 这些字段写进任务记录，重启后阶段函数仍能读到。
type ReporterInput = { name: string; conversationId: ConversationId; message: string; followUp: boolean };
// 以 phase 区分的联合：deliver 阶段没有额外字段；report 阶段可带要上报的文本（undefined 表示无事可报）。
// 阶段函数里 reporter.state 会按当前阶段收窄。
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };
// Reporter 是后台任务：deliver 把消息交给子代理并等待结算，report 把回答作为 follow-up 输入送回主会话。
// 每个阶段都以提交结束，因此崩溃或关闭后能从最后检查点继续；固定 requestId 让重复提交保持幂等。
const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "app.subagent-reporter",
	version: 1,
	// 新任务从 deliver 开始。
	initial: () => ({ phase: "deliver" }),
	phases: {
		// Send the message, wait for its answer, and decide what to report.
		// deliver 阶段。输入：reporter.input 与任务状态；输出：通过提交进入 report 阶段。
		// 副作用：向子会话提交一条输入并等待结算，再在主会话文档里记录已上报条目。
		// 错误：子会话句柄缺失由 ! 断言暴露；关闭进程不会得到错误，重开后会重跑本阶段，但 requestId 避免重复投递。
		deliver: async (reporter, runtime, taskContext) => {
			// 解构持久输入；类型由泛型 ReporterInput 保证，无需运行时校验。
			const { name, conversationId, message, followUp } = reporter.input;
			// While the subagent is busy, a steer reaches it at its next step and a follow-up after its current answer.
			// runtime.conversation 返回任务可操作的会话句柄或 undefined；! 是编译期非空断言，脚本保证会话存在。
			const subagent = (await runtime.conversation(conversationId, taskContext))!;
			// whenBusy 决定忙碌语义：followUp 等当前回答结束后再处理；steer 在当前工具轮后加入正在进行的 run。
			const request = { type: "input", content: message, whenBusy: followUp ? "followUp" : "steer" } as const;
			// 展开 request 并补固定 requestId；reporter.id 持久不变，因此重跑本阶段拿到的是第一次投递。
			const submission = await subagent.submit({ ...request, requestId: `subagent:${reporter.id}` }, taskContext);
			// 等待这份输入结算；取消 taskContext 只取消等待，已接纳的输入仍会被处理。
			const settled = await submission.wait(taskContext);
			// One commit decides the report and records the answer as delivered, so a restart does not decide again.
			// 用一次提交同时决定报告文本并记录已上报条目；原子性保证重启后不会再次决定同一回答。
			await runtime.commit(async (tx) => {
				// 构造“继续运行”的提交结果，并带 report 阶段的检查点；as const 保留字面量类型，status 不会拓宽成 string。
				const next = (report?: string) => ({ status: "running", checkpoint: { phase: "report", report } }) as const;
				// `aborted`: stopped, or withdrawn while queued. Nothing to report.
				// unanswered 表示被中止、撤回或失败；下面按 reason 区分。此检查把联合类型收窄到带 reason 的分支。
				if (settled.status === "unanswered") {
					// 主动中止没有内容可报；其他失败原因生成一条上报文本。条件表达式的两个分支类型兼容。
					return next(settled.reason === "aborted" ? undefined : `[subagent ${name} failed: ${settled.reason}]`);
				}
				// Always an answered input here; the check tells TypeScript.
				// 本工具只提交 input，因此这里理论上不会命中；该检查用于把类型收窄到回答字段存在的分支。
				if (settled.type !== "input") return next();
				// 在事务里读取主会话的登记；name 是 spawn 时写入的，! 断言该项存在。
				const agent = (await tx.doc(Subagents, runtime.conversationId)).agents[name]!;
				// 已回答过的条目不再上报；这是重跑幂等的第二道保险（第一道是 requestId）。
				if (agent.reported.includes(settled.answer)) return next();
				// 在事务内修改文档值；提交时差异随本次事务落库。
				agent.reported.push(settled.answer);
				// 读取助手回答条目；?. 处理缺失，as 只是编译期断言，真正的形状检查由条目类型与 Harness 的写入路径保证。
				const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage;
				// 上报文本带固定前缀，主会话 UI 的正则据此显示为子代理消息；no reply needed 告诉模型不必再回复。
				return next(`[subagent ${name} answered, no reply needed] ${textOf(answer)}`);
			}, taskContext);
		},
		// Post the report as a follow-up input: it starts a turn when the main agent is idle, or waits for its current
		// answer. If the user presses Esc while it waits in the main agent's queue, it is dropped with the other input; a
		// report that arrives after Esc starts a new turn.
		// report 阶段。输入：上一提交的检查点 report；输出：termination。
		// 副作用：非空报告作为 follow-up 输入提交给主会话；提交后任务终止。错误：主会话句柄缺失由 ! 暴露。
		report: async (reporter, runtime, taskContext) => {
			// 当前阶段是 report，state 的联合已收窄，checkpoint.report 可能是 undefined。
			const report = reporter.state.checkpoint.report;
			if (report !== undefined) {
				// reporter 的 runtime.conversationId 是它所属的主会话；取得句柄用于提交报告。
				const main = (await runtime.conversation(runtime.conversationId, taskContext))!;
				// 报告按 follow-up 提交：主代理空闲时立即开一轮，忙碌时等当前回答结束。
				const input = { type: "input", content: report, whenBusy: "followUp" } as const;
				// 固定 requestId 保证重启后不会重复上报同一条回答；这里不等待结算，提交被接纳即可。
				await main.submit({ ...input, requestId: `subagent-report:${reporter.id}` }, taskContext);
			}
			await runtime.commit(
				// 无论是否有报告，最后都提交终止；之后 reporter 不再被调度。
				() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
				taskContext,
			);
		},
	},
	// reporter 被中止时直接终止；尚未投递的消息或尚未上报的回答不会补做。
	abort: (_reporter, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

// 把一条可能缺失的助手消息转成文本。输入：AssistantMessage 或 undefined；输出：文本块拼接，缺失时为 ""。
// 副作用：无。示例：textOf(answer) 对回答 "Moby Dick." 返回 "Moby Dick."。
function textOf(message: AssistantMessage | undefined): string {
	// ?? 在 content 缺失时给空数组；flatMap 只保留文本块；join 合并。
	return (message?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}

// 一个工具承载四个动作。输入：已校验的 action/name/message/followUp；输出：文本结果与可选 details。
// 错误以文本返回给模型，不抛异常。示例：action: "status" 返回各子代理 working/idle。
const subagentTool = defineTool({
	name: "subagent",
	description:
		"Manage persistent subagents that work in the background. Actions: spawn (name, message), send (name, message; " +
		"followUp: true queues it after the current answer instead of steering), stop (name: aborts its current work), " +
		"status (name, or all subagents without one). Answers are reported back to you when they arrive.",
	// schema 同时生成给模型的 JSON Schema 和 args 的 TypeScript 类型；Harness 在 execute 前运行时校验。
	parameters: obj({
		// oneOf 把 action 限定为四个字面量；后续条件分支可据此收窄。
		action: oneOf(["spawn", "send", "stop", "status"]),
		// opt 表示可省略；name 在 status 时可省略（列出全部），其他动作需要。
		name: opt(str()),
		message: opt(str()),
		followUp: opt(bool()),
	}),
	// 选择 unsafe：崩溃打断的调用不自动重跑，因为重复 stop 可能中止后来启动的新工作；模型会收到 interrupted，可再用 status 检查。
	// A call interrupted by a crash is not rerun: repeating `stop` could stop newer work. The model sees that the call
	// was interrupted and can check with `status`.
	// 非 replay-safe；与第 21 个示例的 replay: "safe" 相对。
	replay: "unsafe",
	// 执行体在工具任务中运行；工具任务属于主会话，但创建的子任务显式标记为 background。
	execute: async (args, api, callContext) => {
		// 解构已校验参数；name/message/followUp 可能为 undefined。
		const { action, name, message, followUp } = args;
		// 构造工具结果。输入：文本与可选子会话 ID；输出：带 content 的对象，只有存在子会话时才有 details。
		// 示例：reply("Started reader.", childId) 让 UI 能附着到该子会话。
		const reply = (text: string, conversationId?: ConversationId) => ({
			content: [{ type: "text" as const, text }],
			// A UI can attach to the subagent's conversation through the call's details.
			// 条件展开：缺任一字段时展开空对象，否则展开 details；运行时条件，类型由两个分支共同推导。
			...(conversationId === undefined || name === undefined ? {} : { details: { name, conversationId } }),
		});
		// 首次调用时文档可能还不存在，snapshot 返回 undefined；?? 回退为空登记。
		const registry = (await api.snapshot(Subagents, api.conversationId, callContext)) ?? {
			agents: {},
			reporters: {},
		};

		// status 分支。name 为空时列出全部；每个子代理读取 LiveDoc 判断是否忙碌。
		if (action === "status") {
			// 两个分支都是 string[]；Object.keys 只枚举自有可枚举键。
			const names = name === undefined ? Object.keys(registry.agents) : [name];
			const lines: string[] = [];
			for (const each of names) {
				// hasOwn 排除原型链键；条件表达式让缺失项变成 undefined，避免直接索引得到 undefined 却无法区分。
				const found = Object.hasOwn(registry.agents, each) ? registry.agents[each] : undefined;
				if (found === undefined) continue;
				// A conversation is busy while it has a run: from an input until its final answer.
				// 会话有 run 即忙碌：从输入被接纳到最终回答之间。
				const busy = (await api.snapshot(LiveDoc, found.conversationId, callContext))?.run !== undefined;
				lines.push(`${each}: ${busy ? "working" : "idle"}`);
			}
			// 没有子代理时给一句话；否则每行一个名字与状态。
			return reply(lines.length === 0 ? "No subagents." : lines.join("\n"));
		}
		// spawn/send/stop 都必须有名字；以工具结果返回校验信息，不抛异常。
		if (name === undefined) return reply(`${action} needs a name.`);
		// 查找已有子代理；spawn 允许不存在，其他动作要求存在。
		const agent = Object.hasOwn(registry.agents, name) ? registry.agents[name] : undefined;
		// send/stop 针对不存在的名字时直接返回错误文本。
		if (action !== "spawn" && agent === undefined) return reply(`No subagent named ${name}.`);

		// stop 分支：中止子代理当前回答与工具，并丢弃排队消息；子代理本身仍可继续 send。
		if (action === "stop") {
			// Aborts the subagent's current answer and tools and drops its queued messages. It stays usable.
			// 内层 await 取得子会话句柄，外层等 abort 完成；两个 ! 都是非空断言，运行时不做兜底。
			await (await api.conversation(agent!.conversationId, callContext))!.abort(callContext);
			return reply(`Stopped ${name}.`, agent!.conversationId);
		}
		// spawn 与 send 都需要消息；stop/status 已在上方返回。
		if (message === undefined) return reply(`${action} needs a message.`);

		// spawn and send: one commit starts a reporter for the message.
		// spawn/send 在一个事务里更新登记并创建 reporter；返回给模型的结果文本也由提交决定。
		const result = await api.commit(async (tx) => {
			// 事务内读取主会话的登记文档；之后的修改与任务创建同属一个提交。
			const state = await tx.doc(Subagents, api.conversationId);
			// Both tasks belong to the main conversation and are background: its Esc and idle waits skip them.
			// 两个任务都归当前会话所有并标记 background：主代理的 Esc 与空闲等待不会等待它们；
			// root.abort 的 background 选项仍可中止。as const 保留字面量类型。
			const background = { ownership: { kind: "conversation" }, background: true } as const;
			// spawn 分支：检查重名，创建锚点与子会话，配置子会话并登记。
			if (action === "spawn") {
				// 重复 spawn 直接返回提示，不创建第二个子会话。
				if (Object.hasOwn(state.agents, name)) return `${name} already exists; use send.`;
				// 创建后台锚点任务；输入是 null。它立即完成，但子会话的拥有关系仍保留。
				const anchor = await tx.createTask(Anchor, null, background);
				// Owned by a task of the main conversation: starts as a copy of the main agent.
				// 子会话归锚点任务所有；创建时从主会话复制 agent（模型、指令、扩展、cwd 等）。
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
				// Subagents cannot start subagents, and know who they are.
				// 事务内配置子会话：移除 subagent-tools 扩展防止递归，并写入身份指令。
				await configure(tx, child.id, {
					extensions: { remove: [SubagentTools] },
					instructions: `You are the subagent "${name}". Answer the main agent's requests.`,
				});
				// 把子会话写入登记；reported 从空数组开始。
				state.agents[name] = { conversationId: child.id, reported: [] };
			}
			// spawn 刚写入、send 已确认存在，因此 ! 断言安全。
			const conversationId = state.agents[name]!.conversationId;
			// spawn 总是 steer（false）；send 只在 followUp 显式为 true 时排队。
			const input = { name, conversationId, message, followUp: action === "send" && followUp === true };
			// 创建 reporter 并按本次工具任务 ID 登记；这个键也用于宿主侧 settle() 等待所有 reporter。
			state.reporters[api.taskId] = await tx.createTask(Reporter, input, background);
			// 提交回调返回的结果文本会作为工具结果内容。
			return action === "send" ? `Sent to ${name}.` : `Started ${name}.`;
		}, callContext);
		// 提交后再读登记，取子会话 ID 放进 details；snapshot 读的是已提交状态。
		const current = (await api.snapshot(Subagents, api.conversationId, callContext))?.agents[name];
		// 组合文本与 details；current 缺失时 details 省略。
		return reply(result, current?.conversationId);
	},
});

// The task definitions come with the extension, so pending reporters resume after a restart once the host installs
// it again.
// 扩展随带任务定义；重启后宿主重装同一扩展，pending reporter 才能按名字和版本恢复并继续。
const SubagentTools = defineExtension({ name: "subagent-tools", tasks: [Anchor, Reporter], tools: [subagentTool] });

// ─── Host setup ─────────────────────────────────────────────────────────────

// 宿主模型目录；下面按环境安装真实或 faux provider。
const models = createModels();
// 默认真实模型；无 key 时改成 faux-1。
let model = { provider: "openai", modelId: "gpt-6-sol" };
if (process.env.OPENAI_API_KEY !== undefined) {
	models.setProvider(openaiProvider());
} else {
	// The main agent and the subagent share one scripted model, which answers each request by its last message.
	// It streams its answers at 50 tokens per second, like a slow real model.
	// 主代理与子代理共用一个脚本化 provider；每秒 50 token 的流式节奏模拟慢模型。
	const faux = fauxProvider({ tokensPerSecond: 50 });
	models.setProvider(faux.provider);
	model = { provider: "faux", modelId: "faux-1" };
	// 构造一次 subagent 工具调用；input 的形状由 route 提供，执行前仍由工具 schema 做运行时校验。
	const call = (input: Record<string, string>) =>
		fauxAssistantMessage([fauxToolCall("subagent", input)], { stopReason: "toolUse" });
	// 构造普通文本助手消息。
	const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
	// 按请求的最后一条非系统消息决定下一步回答。输入：provider 请求；输出：工具调用或文本助手消息。
	// 示例：主代理消息含 "Start a subagent" 时返回 spawn 调用；子代理消息含 "whale called" 时返回 "Moby Dick."。
	// 副作用：无；每次调用按内容重新路由，不依赖外部状态。
	const route: FauxResponseStep = (request) => {
		// System messages carry prompt changes; the request is about the message before them.
		// findLast 是 ES2023 数组方法，取最后一条非 system 消息；系统消息可能追加在末尾，! 断言至少存在一条非系统消息。
		const last = request.messages.findLast((message) => message.role !== "system")!;
		// 消息 content 在运行时可能是字符串或内容块数组；typeof 是这里需要的真实运行时判断。
		const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
		// 从内容块中提取纯文本；非文本块（如图片）被忽略。
		const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		// The main agent repeats what the tool said.
		// 主代理收到工具结果后回一句确认；子代理的请求不会被误判为工具结果。
		if (last.role === "toolResult") return answer(`OK. ${text}`);
		// The main agent.
		// 以下为主代理脚本：用户文本触发 spawn、send、stop、status。
		if (text.includes("Start a subagent")) {
			return call({ action: "spawn", name: "reader", message: "Summarize the plot of Moby Dick." });
		}
		if (text.includes("whale's name"))
			return call({ action: "send", name: "reader", message: "What is the whale called?" });
		// 要求子代理做长回答，随后 stop 会在流式中途中止它。
		if (text.includes("every chapter")) {
			return call({ action: "send", name: "reader", message: "Now go through all chapters in detail." });
		}
		if (text.includes("Stop reader")) return call({ action: "stop", name: "reader" });
		if (text.includes("my subagents")) return call({ action: "status" });
		// 主代理看到上报前缀时只回一句，避免继续触发动作。
		if (text.includes("[subagent")) return answer("Noted.");
		// The subagent: short answers, and a long chapter walk-through that is stopped halfway.
		// 以下为子代理脚本：短问题给短答案。
		if (text.includes("Summarize the plot")) return answer("A whale, a captain, an obsession.");
		if (text.includes("whale called")) return answer("Moby Dick.");
		// 构造 135 行长回答；Array.from 的第二个参数是映射函数，下划线表示不使用元素值。
		const chapters = Array.from({ length: 135 }, (_, index) => `Chapter ${index + 1}: more whaling.`);
		// 默认分支返回长回答；配合 tokensPerSecond，stop 能在流式过程中命中。
		return answer(chapters.join("\n"));
	};
	// More responses than the script needs; each request takes the next one.
	// 预置 40 个相同的路由函数；每次请求消耗一个，足够覆盖脚本步骤。
	faux.setResponses(Array.from({ length: 40 }, () => route));
}
// 创建注册表并安装扩展；内置任务已存在。
const registry = createRegistry();
registry.install(SubagentTools);
// 创建唯一临时目录；sqlite 文件放在其中，示例结束时递归删除。
const directory = await mkdtemp(join(tmpdir(), "pi-durable-subagents-"));
// 打开（或重开）宿主。输入：无，使用闭包中的 directory/models/registry；输出：harness 与 root。
// 副作用：打开同一个 sqlite 文件；第二次调用即模拟进程重启。错误：文件损坏或迁移失败会在这里抛出。
const open = async () => {
	const harness = await Harness.open(
		// Node sqlite 存储；同一路径在重启后仍能看到已提交的任务、文档与条目。
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{ models, registry },
		context,
	);
	const root = await harness.root(context, { agent: { model } });
	return { harness, root };
};

// 以下仅是展示层：把主会话提交投影成终端文本；子代理在自己的会话里工作，不直接打印。
// ─── UI: the main conversation's transcript, as a user would see it ───

// 返回一个上色函数；非 TTY（重定向到文件）时原样返回，避免 ANSI 转义污染输出。
const color = (code: number) => (text: string) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = color(1);
const dim = color(2);
const cyan = color(36);
const yellow = color(33);
const magenta = color(35);

// 把消息 content 统一成文本。输入：字符串或内容块数组；输出：拼接文本。
// 副作用：无。示例：contentText("hi") 返回 "hi"。
function contentText(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string"
		? content
		: content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("");
}

/** Print the main conversation's messages as they are committed. Subagents work in their own conversations. */
// 订阅主会话并打印新增条目。输入：harness 与主会话 ID；输出：无。
// 副作用：创建 watch 并启动回调，不返回停止句柄；Harness 关闭后回调随会话结束。
// 主流程：记录水位 -> 每帧过滤新条目 -> 按 user/assistant/toolResult 分支打印。
async function follow(harness: Harness, id: ConversationId): Promise<void> {
	// 取得会话句柄并附着 watch；内层 await 等句柄，外层等 watch 创建。
	const watch = await (await harness.conversation(id, context))!.watch(context);
	// 初始窗口的最新条目 ID；窗口为空时从 0 开始。
	let newest = watch.value.entries.at(-1)?.id ?? 0;
	// 每个提交触发一帧；一个回调处理该帧里的全部新条目。
	watch.start(async (call) => {
		if (call.kind !== "value") return;
		const { value } = call;
		// 只保留水位之后的条目；窗口是最近的一段，不是完整历史。
		const entries = value.entries.filter((entry) => entry.id > newest);
		newest = value.entries.at(-1)?.id ?? newest;
		for (const entry of entries) {
			// 条目可能没有模型消息；?. 返回 undefined。
			const message = entry.model?.[0];
			// user 角色既可能是用户输入，也可能是 reporter 作为 follow-up 提交的上报。
			if (message?.role === "user") {
				const text = contentText(message.content);
				// Input is either the user or a subagent's report, which arrives whenever the subagent is done.
				// 正则捕获名字、状态短语与正文；s 标志让 . 匹配换行，正文可以跨行。exec 失败返回 null。
				const report = /^\[subagent (\S+) ([^\]]*)\] ?(.*)$/s.exec(text);
				// 普通用户输入用青色提示符；模板字符串只负责拼终端样式。
				if (report === null) console.log(`\n${cyan(bold(">"))} ${bold(text)}`);
				else console.log(`\n${magenta(bold(`> ${report[1]}:`))} ${report[3] || report[2]}`);
				// 助手条目：先打印工具调用，再打印非空文本。
			} else if (message?.role === "assistant") {
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					// toolCall.arguments 是 JSON；断言成字符串映射只影响编译期，运行时字段仍可能缺失或类型不符。
					// 解构时把 message 重命名为 sent，避免遮蔽外层 message。
					const { action, name, message: sent } = part.arguments as Record<string, string | undefined>;
					const quoted = sent === undefined ? "" : ` ${JSON.stringify(sent)}`;
					// 一行显示工具名、动作、可选名字与可选消息；嵌套模板与三元都是展示逻辑。
					console.log(yellow(`  ${part.name} ${action}${name === undefined ? "" : ` ${name}`}${quoted}`));
				}
				// 只打印非空文本；空字符串在终端里没有可读内容。
				if (textOf(message) !== "") console.log(textOf(message));
				// 工具结果用暗色箭头缩进显示。
			} else if (message?.role === "toolResult") {
				console.log(dim(`  → ${contentText(message.content)}`));
			}
		}
	});
}

// 主流程开始：打开宿主；let 解构是因为重启后要整体替换两个绑定。
let { harness, root } = await open();
await follow(harness, root.id);

/** Say something to the main agent and wait for its answer. */
// 向主代理说一句话并等这份输入结算。输入：文本；输出：无。
// 副作用：提交并等待；不等待子代理或 reporter 的后续工作。
const say = async (text: string): Promise<void> => {
	await (await root.submit({ type: "input", content: text }, context)).wait(context);
};
/** Wait until every message to a subagent was answered and reported, and the main agent has reacted. */
// 等所有已登记的 reporter 终止，再等主会话空闲，最后让出一小段时间给 watch 打印。
// 输入：无；输出：无。副作用：多次等待；不创建任务。
const settle = async (): Promise<void> => {
	// 读取登记文档中的 reporter 映射；文档缺失时按空映射处理。
	const reporters = (await harness.snapshot(Subagents, root.id, context))?.reporters ?? {};
	// 逐个等待 reporter 进入终止状态；已经终止的任务立即返回。串行等待足够，因为数量很少。
	for (const id of Object.values(reporters)) await harness.waitForTask(id, context);
	// 等主会话普通所有权范围内的任务空闲；background 任务不在此范围内，所以前面要单独等 reporter。
	await root.waitForIdle(context);
	// Event callbacks run after their commit; let the last ones print. A slow machine may need longer.
	// watch 回调在提交后异步运行；固定等 50ms 让最后几帧打印完，慢机器可能仍不够。
	await new Promise((resolve) => setTimeout(resolve, 50));
};
/** Poll `check` for up to 10 seconds. */
// 轮询辅助。输入：返回 Promise<boolean> 的检查函数；输出：条件成立或超时后返回。
// 副作用：最多 1000 次、每次间隔 10ms，总计约 10 秒；超时不会抛错，调用方需自行了解。
const until = async (check: () => Promise<boolean>): Promise<void> => {
	// 先检查再等待；循环变量只在条件中使用。
	for (let tries = 0; tries < 1000 && !(await check()); tries++)
		await new Promise((resolve) => setTimeout(resolve, 10));
};
// 判断子代理是否在跑。输入：名字；输出：存在且有 run 时为 true。
// 示例：stop 前用它确认长回答已经开始。
const working = async (name: string): Promise<boolean> => {
	const agent = (await harness.snapshot(Subagents, root.id, context))?.agents[name];
	return agent !== undefined && (await harness.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined;
};

// The main agent answers at once; the subagent's answer is reported back when it arrives.
// 步骤 1：spawn 子代理；主代理立即回答，子代理稍后上报短答案。
await say("Start a subagent named reader that summarizes Moby Dick.");
await settle();

// A long request, stopped while the subagent is still answering.
// 步骤 2：send 一条会触发长回答的消息。
await say("Ask reader to summarize every chapter.");
// 等 reader 真正进入运行态，再发 stop，避免过早中止。
await until(() => working("reader"));
// stop 中止长回答；settle 等 reporter 结算并向主代理上报中止或无内容。
await say("Stop reader.");
await settle();

// 步骤 3：status 列出子代理状态。
await say("What are my subagents doing?");
await settle();

// The process stops while the subagent works on a message; after the restart its answer still arrives.
// 读取当前登记的 reporter 数量，用于检测新 reporter 是否已创建。
const reporters = async () =>
	Object.keys((await harness.snapshot(Subagents, root.id, context))?.reporters ?? {}).length;
// 记录重启演示前的 reporter 数。
const before = await reporters();
// 只提交不等待：reporter 与子代理继续工作，接下来在它们未完成时关闭宿主。
await root.submit({ type: "input", content: "Ask reader for the whale's name." }, context);
// 等新 reporter 已被登记，确保重启后有任务可以恢复。
await until(async () => (await reporters()) > before);
await harness.close(context);
// 上一行已关闭 Harness（sqlite 状态已持久化）；这里模拟进程重启并给出提示。
console.log(dim("\n  (process restarts)"));
// 重开同一 sqlite 文件并重新订阅；括号让以 { 开头的解构赋值被当作表达式。
({ harness, root } = await open());
await follow(harness, root.id);
await settle();

await harness.close(context);
// 示例结束，递归删除临时目录；force 忽略不存在的路径。
await rm(directory, { recursive: true, force: true });
