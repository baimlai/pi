// 文件导读
// 所属：仓库根 scripts/issues/ 的分诊核心，用 pi-durable 为每个 issue 维护一个持久会话。
// 职责：加载分类与提示词，注册 search_issues/read_issue/submit_triage 工具，按并发上限排队运行模型；
//   分诊结果与维护者决策写入 durable 文档，进程重启后恢复未完成任务。
// 能力：打开并恢复持久会话；入队/重分诊与并发限流；注册三个模型工具；读取状态/对话/成本；记录维护者决策。
// 上游：main.ts 构造 Triage 并调用 open/enqueueInbox/retriage/decide/state/transcript/usageCost/close。
// 下游：pi-ai（模型、认证、provider）、pi-durable（Harness、SQLite 存储）、Chord 的 BACKGROUND_CONTEXT、
//   github.ts（Corpus/Issue）；读取 categories/*.md 与 prompt.md，写 data/triage.sqlite。
// 输入：TriageOptions（数据目录、脚本目录、语料、模型、思考级别、并发、收件箱天数）。
// 输出：state/transcript 供 HTTP 层序列化；分诊结果通过工具提交进 durable 文档。
// 副作用：打开 SQLite、调用配置的模型 provider（产生费用/网络请求）、写持久化文档；工具内只读本地语料。
// 失败：模型/存储错误使 run 失败并把 issue 标记 failed；open 失败让 main.ts 启动失败。
// 示例：
//   const triage = new Triage({ dataDir, scriptDir, corpus, model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
//     thinkingLevel: "medium", concurrency: 4, inboxDays: 2 });
//   await triage.open();
// 建议阅读顺序：类型与文档定义 → open（恢复流程）→ 队列与 run → formatIssue → extension 的三个工具。
// Triage agent on pi-durable: one durable conversation per issue. Results and decisions live in a durable document,
// so a restart resumes unfinished triage runs and keeps every decision.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Chord 的后台上下文：让 durable 任务在后台执行而不是绑定某个 HTTP 请求。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// type 修饰符让仅类型导入在运行时被擦除；StringEnum 与 Type 是工具参数的运行时 schema 构造器。
import { type Message, type ModelThinkingLevel, StringEnum, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
// 直接引用 coding-agent 源码的认证存储；run.sh 的 source 条件/钩子保证无需构建即可导入。
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import {
	type ConversationId,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	section,
	type Tx,
} from "../../packages/durable/src/index.ts";
import { openNodeSqliteStorage } from "../../packages/durable/src/storage/sqlite/node.ts";
import { type Corpus, type Issue, inInbox, issueStatus } from "./github.ts";

// 所有 durable 调用共享同一后台上下文对象；它标识任务来源，不携带请求状态。
const context = BACKGROUND_CONTEXT;
/** Labels the issue templates set. Other labels and the issue's state are hidden from the agent: they are maintainer decisions. */
// 只把模板标签传给模型；p0/p1/no-action 等维护者决策标签不暴露，避免模型被既有结论带偏。
const TEMPLATE_LABELS = ["bug", "enhancement", "package-report"];
// as const 保留字面量联合；Priority 从数组元素推导，HTTP 层与工具 schema 都复用它。
export const PRIORITIES = ["p0", "p1", "none"] as const;
export type Priority = (typeof PRIORITIES)[number];

// 分类来自 categories/*.md：name 是文件名，owner 是 frontmatter 的 owner，text 是去掉 frontmatter 的正文。
export interface Category {
	name: string;
	owner: string;
	text: string;
}

// 模型通过 submit_triage 提交的结构；也是持久化文档里 result 的类型。
export type TriageResult = {
	category: string;
	confidence: "high" | "low";
	alternative: string;
	summary: string;
	signals: string[];
	duplicates: { number: number; kind: "duplicate" | "related"; reason: string }[];
	suggestion: Priority;
	reason: string;
};

// 每个 issue 的持久状态：status 是队列/运行/完成/失败；attempt 用于 retriage 的 requestId 去重。
export type IssueState = {
	status: "queued" | "running" | "done" | "failed";
	attempt: number;
	/** 0 until the conversation exists. */
	conversationId: number;
	error: string;
	result: TriageResult | null;
	triagedAt: string;
	/** The maintainer's call. Category is set only when it differs from the agent's. */
	decision: { priority: Priority | null; category: string; at: string } | null;
};

// 整个文档状态：inboxSince 决定哪些 issue 进入 UI/队列；issues 用编号字符串索引。
type TriageState = { inboxSince: string; issues: Record<string, IssueState> };

/** One transcript line for the UI. A tool call carries its result once the result exists. */
// 标签联合：text/thinking/user 是纯文本，tool 带参数与可空结果；UI 按 type 分支渲染。
export type TranscriptItem =
	| { type: "user" | "text" | "thinking"; text: string }
	| { type: "tool"; name: string; args: unknown; output: string | null; isError: boolean };

// durable 文档定义：scope 为 session；每累计 64 个变更操作打一次检查点，控制重放/存储成本。
const StateDoc = defineDoc<TriageState>({
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
	kind: "triage.state",
	version: 1,
	scope: "session",
	initial: () => ({ inboxSince: "", issues: {} }),
});

// 在事务里取出状态文档，确保该 issue 有默认记录，再执行调用方的修改。
// `??=` 只在缺失时写入，保留已有状态；as IssueState 是因为索引签名访问在 TS 中可能是 undefined。
async function mutate(tx: Tx, number: number, change: (issue: IssueState) => void): Promise<void> {
	const state = await tx.doc(StateDoc);
	state.issues[number] ??= {
		status: "queued",
		attempt: 0,
		conversationId: 0,
		error: "",
		result: null,
		triagedAt: "",
		decision: null,
	};
	change(state.issues[number] as IssueState);
}

// 输入：分类目录。输出：按文件名排序的 Category 数组。
// 文件是 Markdown + 可选 frontmatter；owner 从 `owner:` 行提取，正文去掉首尾 frontmatter。
export function loadCategories(dir: string): Category[] {
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => {
			const text = readFileSync(join(dir, file), "utf8");
			// m 让 ^/$ 匹配每一行；[ \t]* 允许冒号后空格；无 frontmatter 时 owner 为空串。
			const owner = /^owner:[ \t]*(.*)$/m.exec(text)?.[1]?.trim() ?? "";
			// slice(0, -3) 去掉 ".md"；正则只删除开头的 ---...--- 块，正文内部的分隔线不受影响。
			return { name: file.slice(0, -3), owner, text: text.replace(/^---[\s\S]*?---\n/, "").trim() };
		});
}

// Triage 的构造参数；main.ts 从环境变量组装，测试可注入临时目录与语料。
export interface TriageOptions {
	dataDir: string;
	scriptDir: string;
	corpus: Corpus;
	model: { provider: string; modelId: string };
	thinkingLevel: ModelThinkingLevel;
	concurrency: number;
	inboxDays: number;
}

// 分诊服务：持有分类、durable Harness、待办队列与 conversation→issue 映射。
export class Triage {
	readonly categories: Category[];
	private options: TriageOptions;
	// 明确赋值断言：open() 之前为 undefined，之后才可用；生命周期由调用方保证。
	private harness!: Harness;
	private queue: number[] = [];
	private active = 0;
	/** Conversation ID to issue number, for the tools. */
	private conversations = new Map<number, number>();

	constructor(options: TriageOptions) {
		this.options = options;
		// 分类在构造时同步读取，open 之前即可供 UI 展示。
		this.categories = loadCategories(join(options.scriptDir, "categories"));
	}

	// 打开持久化存储与 Harness，初始化 inboxSince，恢复 conversation 映射并重新入队未完成 issue。
	async open(): Promise<void> {
		// 认证来自本机 coding-agent 配置；只注册实际支持的两个 provider。
		const models = createModels({ credentials: AuthStorage.create() });
		models.setProvider(openaiCodexProvider());
		models.setProvider(anthropicProvider());
		const registry = createRegistry();
		registry.install(this.extension());
		// SQLite 文件位于数据目录；同目录还有 corpus.json 与 token。
		const storage = await openNodeSqliteStorage(join(this.options.dataDir, "triage.sqlite"));
		this.harness = await Harness.open(
			storage,
			{
				models,
				registry,
				// 模型调用失败最多重试 3 次；工具并行执行，但每个 issue 的会话仍按队列推进。
				settings: { retry: { maxRetries: 3 }, toolExecution: "parallel" },
				onReport: (error) => console.error("durable:", error),
			},
			context,
		);
		// 首次启动没有 inboxSince：按 inboxDays 回溯并持久化，后续重启沿用同一水位。
		await this.harness.commit(async (tx) => {
			const state = await tx.doc(StateDoc);
			if (!state.inboxSince) {
				state.inboxSince = new Date(Date.now() - this.options.inboxDays * 86_400_000).toISOString();
			}
		}, context);
		// Resume runs a previous process left unfinished.
		// 重建 conversation→issue 映射，工具才能在恢复的会话里找到对应 issue。
		const state = await this.state();
		for (const [number, issue] of Object.entries(state.issues)) {
			if (issue.conversationId) this.conversations.set(issue.conversationId, Number(number));
		}
		this.harness.resume();
		// queued/running 都重新排队；running 表示上次进程中断，attempt 不变会复用同一 requestId。
		for (const [number, issue] of Object.entries(state.issues)) {
			if (issue.status === "queued" || issue.status === "running") this.enqueue(Number(number));
		}
	}

	// 返回持久化状态的只读快照；文档不存在时用初始值，调用方不会拿到内部可变对象。
	async state(): Promise<Readonly<TriageState>> {
		return (await this.harness.snapshot(StateDoc, context)) ?? StateDoc.definition.initial();
	}

	/** The issue's triage conversation without the system prompt, or null when it has none yet. */
	// 输入 issue 编号。输出：UI 可直接渲染的消息列表；无会话时 null。
	// 遍历会话上下文里的 model 消息，把 toolCall 与后续 toolResult 合并成一条 tool 项。
	async transcript(number: number): Promise<TranscriptItem[] | null> {
		const id = (await this.state()).issues[number]?.conversationId;
		const conversation = id ? await this.harness.conversation(id as ConversationId, context) : undefined;
		if (!conversation) return null;
		const { entries } = await conversation.context(context);
		const items: TranscriptItem[] = [];
		// toolCallId → 已输出的 tool 项；toolResult 到达后回填 output/isError。
		const calls = new Map<string, Extract<TranscriptItem, { type: "tool" }>>();
		// content 可能是字符串或多模态块数组；非文本块用 [type] 占位。
		const text = (content: Message["content"]) =>
			typeof content === "string"
				? content
				: content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
		for (const message of entries.flatMap((entry) => entry.model ?? [])) {
			if (message.role === "user") items.push({ type: "user", text: text(message.content) });
			else if (message.role === "toolResult") {
				const call = calls.get(message.toolCallId);
				if (call) {
					call.output = text(message.content);
					call.isError = message.isError;
				}
			} else if (message.role === "assistant") {
				for (const block of message.content) {
					// 空白文本/思考块不展示，避免 UI 出现空行。
					if (block.type === "text" && block.text.trim()) items.push({ type: "text", text: block.text });
					else if (block.type === "thinking" && block.thinking.trim()) {
						items.push({ type: "thinking", text: block.thinking });
					} else if (block.type === "toolCall") {
						const call = { type: "tool" as const, name: block.name, args: block.arguments, output: null, isError: false };
						calls.set(block.id, call);
						items.push(call);
					}
				}
			}
		}
		return items;
	}

	// 累计 Harness 记录的所有模型费用；usage.models 按模型分组，cost 可能缺失。
	async usageCost(): Promise<number> {
		const usage = await this.harness.usage(context);
		return Object.values(usage.models).reduce((sum, model) => sum + (model.cost?.total ?? 0), 0);
	}

	// 队列快照：queued 是尚未开始的数量，running 是当前并发中的数量。
	queueSize(): { queued: number; running: number } {
		return { queued: this.queue.length, running: this.active };
	}

	/** Queue every inbox issue that has no result yet. */
	// 把收件箱内、尚无记录或仍为 queued 的 issue 入队；running/done/failed 不重复入队。
	async enqueueInbox(): Promise<void> {
		const state = await this.state();
		for (const issue of this.options.corpus.all()) {
			if (!inInbox(issue, state.inboxSince)) continue;
			const current = state.issues[issue.number];
			if (current === undefined || current.status === "queued") this.enqueue(issue.number);
		}
	}

	// 重新分诊：提升 attempt、清空会话与错误，再入队。
	// attempt 变化会改变 requestId，避免 durable 把新提交当成旧的重复输入。
	async retriage(number: number): Promise<void> {
		await this.update(number, (issue) => {
			issue.status = "queued";
			issue.attempt += 1;
			issue.conversationId = 0;
			issue.error = "";
		});
		this.enqueue(number);
	}

	/** `undefined` keeps a field, `null` clears it. A category equal to the agent's counts as no override. */
	// 合并维护者决策：未提供的字段沿用旧值，null 清空；category 与模型结果相同则视为无覆盖。
	async decide(number: number, change: { priority?: Priority | null; category?: string | null }): Promise<void> {
		await this.update(number, (issue) => {
			const priority = change.priority === undefined ? (issue.decision?.priority ?? null) : change.priority;
			let category = change.category === undefined ? (issue.decision?.category ?? "") : (change.category ?? "");
			if (category === issue.result?.category) category = "";
			// 两项都为空则清空整条决策，而不是保存一个空对象。
			issue.decision = priority === null && !category ? null : { priority, category, at: new Date().toISOString() };
		});
	}

	// 关闭 Harness，flush 持久化；由 main.ts 的退出信号调用。
	async close(): Promise<void> {
		await this.harness.close(context);
	}

	// 入队去重；pump 负责在并发额度内启动任务。
	private enqueue(number: number): void {
		if (this.queue.includes(number)) return;
		this.queue.push(number);
		this.pump();
	}

	// 在 active < concurrency 且队列非空时持续取任务；每个任务结束（成功或失败）后释放额度并再次 pump。
	private pump(): void {
		while (this.active < this.options.concurrency && this.queue.length > 0) {
			const number = this.queue.shift()!;
			this.active++;
			this.run(number)
				.catch((error: unknown) => {
					// run 抛错时把 issue 标记 failed；若 failed 状态的写入本身失败，Promise 会再次拒绝。
					console.error(`#${number}:`, error);
					return this.update(number, (issue) => {
						issue.status = "failed";
						issue.error = error instanceof Error ? error.message : String(error);
					});
				})
				.finally(() => {
					this.active--;
					this.pump();
				});
		}
	}

	// 在一个 durable 事务里修改 issue 状态；所有状态写入都经过这里，保证检查点/恢复行为一致。
	private async update(number: number, change: (issue: IssueState) => void): Promise<void> {
		await this.harness.commit((tx) => mutate(tx, number, change), context);
	}

	// 执行单个 issue 的分诊：复用或创建会话 → 提交输入 → 等待工具提交结果。
	// 没有 submit_triage 时根据 submission 状态写入 failed；已有 done 状态则不覆盖。
	private async run(number: number): Promise<void> {
		const issue = this.options.corpus.get(number);
		if (!issue) throw new Error("not in corpus");
		const existing = (await this.state()).issues[number];
		// conversationId 为 0 表示尚未创建；否则从 Harness 取回会话以支持重启恢复。
		let conversation = existing?.conversationId
			? await this.harness.conversation(existing.conversationId as ConversationId, context)
			: undefined;
		if (!conversation) {
			conversation = await this.harness.createConversation(
				{
					// ownerless：后台任务不属于某个客户端连接，不会随请求结束而取消。
					ownership: { kind: "ownerless" },
					agent: { model: this.options.model, thinkingLevel: this.options.thinkingLevel },
				},
				context,
			);
			this.conversations.set(conversation.id, number);
			// 在闭包里用非空断言记录刚创建的 id；此前已确认 conversation 存在。
			await this.update(number, (state) => {
				state.conversationId = conversation!.id;
			});
		}
		await this.update(number, (state) => {
			state.status = "running";
		});
		const attempt = existing?.attempt ?? 0;
		// requestId 带 issue 编号与 attempt：同一 attempt 重复提交可被 durable 去重，retriage 后则视为新请求。
		const submission = await conversation.submit(
			{ type: "input", content: this.formatIssue(issue), requestId: `triage:${number}:${attempt}` },
			context,
		);
		const settled = await submission.wait(context);
		const after = (await this.state()).issues[number];
		// 工具 submit_triage 已把状态置为 done；正常路径在此返回。
		if (after?.status === "done") return;
		// 只有 unanswered 才带 reason/detail；其他状态（如 completed 但未调用工具）保持空串。
		const detail = settled.status === "unanswered" ? `${settled.reason ?? ""} ${settled.detail ?? ""}` : "";
		await this.update(number, (state) => {
			state.status = "failed";
			state.error = `no triage submitted ${detail}`.trim();
		});
	}

	// 把 issue 渲染成模型输入：编号/标题、作者历史、模板标签、创建时间，正文用 XML 式定界符包裹。
	// 只传入模板标签，隐藏 state 与维护者标签（见 TEMPLATE_LABELS 注释）。
	private formatIssue(issue: Issue): string {
		const stats = this.options.corpus.authorStats(issue);
		return [
			`Issue #${issue.number}: ${issue.title}`,
			`Author: @${issue.author} (${issue.association.toLowerCase()}, ${stats.prior} earlier issues, ${stats.actedOn} of them acted on by maintainers)`,
			`Template: ${issue.labels.filter((label) => TEMPLATE_LABELS.includes(label)).join(", ") || "none"}. Created ${issue.createdAt}.`,
			"",
			"<issue_body>",
			issue.body.trim() || "(empty)",
			"</issue_body>",
		].join("\n");
	}

	// 构建 durable 扩展：三个工具 + 提示词/分类 section。
	// 工具参数用 Type.Object 生成运行时 schema；模型输出在提交前仍受这里的类型/校验约束。
	private extension() {
		const corpus = this.options.corpus;
		const names = this.categories.map((category) => category.name);
		// 会话 id → issue 编号；-1 表示未知会话（理论上不会发生，工具会拒绝）。
		const issueFor = (conversationId: number) => this.conversations.get(conversationId) ?? -1;
		// 搜索结果的一行摘要：状态、标题、日期与压缩后的正文前 200 字符。
		const line = (issue: Issue) =>
			`#${issue.number} [${issueStatus(issue)}] ${issue.title} (${issue.createdAt.slice(0, 10)})\n    ${issue.body.replace(/\s+/g, " ").slice(0, 200)}`;

		// search_issues：本地关键词检索，排除当前 issue 本身。
		const searchIssues = defineTool({
			name: "search_issues",
			description:
				"Keyword search over the repository's recent issues (open and closed). Returns up to 10 matches with status, title, and the start of the body.",
			parameters: Type.Object({ query: Type.String({ description: "Keywords, an error message, or an API name" }) }),
			// replay: "safe" 表示重放不会产生额外副作用，恢复时可重新执行。
			replay: "safe",
			execute: async (args, api) => {
				const hits = corpus.search(args.query, issueFor(api.conversationId));
				return { output: [{ type: "text", text: hits.length ? hits.map(line).join("\n") : "No matches." }] };
			},
		});

		// read_issue：按编号读取完整 issue（正文截断到 8000 字符）。
		const readIssue = defineTool({
			name: "read_issue",
			description: "Read one issue in full: status, labels, and body.",
			parameters: Type.Object({ number: Type.Number() }),
			replay: "safe",
			execute: async (args) => {
				const issue = corpus.get(args.number);
				if (!issue) return { output: [{ type: "text", text: `#${args.number} is not in the local corpus.` }] };
				const text = `#${issue.number} [${issueStatus(issue)}] ${issue.title}\nLabels: ${issue.labels.join(", ") || "none"}. Created ${issue.createdAt}.\n\n${issue.body.slice(0, 8000)}`;
				return { output: [{ type: "text", text }] };
			},
		});

		// submit_triage：模型提交结果的唯一入口；写入 done 状态并终止会话。
		const submitTriage = defineTool({
			name: "submit_triage",
			description: "Record the triage result. Call exactly once, as the last step.",
			parameters: Type.Object({
				// StringEnum(names) 在运行时约束为具体分类名，同时提供 TypeScript 字符串类型。
				category: StringEnum(names),
				confidence: StringEnum(["high", "low"] as const),
				alternative: Type.String({ description: "Second-best category when confidence is low, else empty" }),
				summary: Type.String({ description: "One plain sentence" }),
				signals: Type.Array(Type.String()),
				duplicates: Type.Array(
					Type.Object({
						number: Type.Number(),
						kind: StringEnum(["duplicate", "related"] as const),
						reason: Type.String({ description: "At most 15 words" }),
					}),
				),
				suggestion: StringEnum([...PRIORITIES]),
				reason: Type.String({ description: "One sentence" }),
			}),
			replay: "safe",
			execute: async (args, api, callContext) => {
				const number = issueFor(api.conversationId);
				// 未知会话返回 isError，模型可据此修正；不会写入任何 issue。
				if (number < 0) return { output: [{ type: "text", text: "Unknown conversation." }], isError: true };
				const result: TriageResult = {
					...args,
					// 去掉自引用重复项，并限制最多 5 条，避免结果膨胀。
					duplicates: args.duplicates.filter((dup) => dup.number !== number).slice(0, 5),
				};
				// 使用工具调用上下文提交事务；写入 result/status/error/triagedAt 后由 durable 持久化。
				await api.commit(
					(tx) =>
						mutate(tx, number, (state) => {
							state.result = result;
							state.status = "done";
							state.error = "";
							state.triagedAt = new Date().toISOString();
						}),
					callContext,
				);
				// terminate 结束会话；run() 随后看到 done 状态直接返回。
				return { output: [{ type: "text", text: "Recorded." }], control: { terminate: true } };
			},
		});

		// 提示词与分类正文来自 scriptDir；tag: false 的 preamble 不包裹 XML 标签。
		const prompt = readFileSync(join(this.options.scriptDir, "prompt.md"), "utf8");
		const categories = this.categories.map((category) => category.text).join("\n\n");
		return defineExtension({
			name: "triage",
			sections: [section("preamble", () => prompt, { tag: false }), section("categories", () => categories)],
			tools: [searchIssues, readIssue, submitTriage],
		});
	}
}
