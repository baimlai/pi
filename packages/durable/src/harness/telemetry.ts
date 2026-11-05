// Durable 的遥测词表：只声明 span、事件和指标的名字与属性形状，不产生任何记录。
// 所属：packages/durable/src/harness，Durable 的遥测 schema 定义。
// 上游：Harness 与 Submissions、Scheduler 用 createTypedSpanStarter(parent, [DURABLE_TELEMETRY_SCHEMA])
// 取得类型安全的 startSpan，TaskGraph 等按这里的名字上报，属性值由调用点提供。
// 下游：pi-telemetry 的适配器（内存、SQLite、NOOP）按名字记录；本文件不接触存储，也不读业务数据。
// 本文件没有运行时行为：defineTelemetrySchema 原样返回同一对象，不复制、不冻结、不做值域校验。
// 能力清单：
// - entry：事件 `pi.durable.entry` 的定义（记录 ID 与种类，不含正文）。
// - reportAttributes / report：事件 `pi.durable.report` 的固定分类属性集与定义。
// - submission：事件 `pi.durable.submission` 的结算定义。
// - DURABLE_TELEMETRY_SCHEMA：版本 1 的 span/事件/指标词表，供 typed starter 与 typed metrics 推导类型。
// 组合与顺序：Submissions 用 `pi.durable.submit` 包住接纳；Scheduler 用 `pi.durable.phase` 包住任务调用，
// 并用指标记录 reports、phase.duration、tasks.active；调用点在 span 回调里 addEvent 触发事件。
// 错误流向：本文件不产生错误；属性不匹配是编译期错误，运行时不拦截；记录失败由适配器处理。
// 示例：createTypedSpanStarter(parent, [DURABLE_TELEMETRY_SCHEMA])("pi.durable.submit", attrs, callback)。
// 建议阅读顺序：先看 entry/report/submission 三个事件常量，再看 schema 的 spans，最后看 metrics；
// 每个 span 先读 description，再读 start/end 属性与 events。
// 测试：schema 本身无运行逻辑；校验它的测试在 packages/durable/test 中按上报/指标断言。
import { defineTelemetrySchema } from "@earendil-works/pi-telemetry";

// 每个常量的 as const 会保留 required: true、type 和 values 的字面量类型，
// 供 defineTelemetrySchema 的 const 泛型推导出“哪些属性必填、允许哪些字符串”的编译期约束。
// 事件 pi.durable.entry：只说明“某条会话记录已提交”，正文仍只在会话记录里，不进入遥测。
// entry.id 标为 high 基数（几乎每条不同，适合定位、不适合做指标标签）；entry.kind 是低基数分类标签。
const entry = {
	description: "A transcript entry was committed; content remains in the transcript.",
	attributes: {
		"entry.id": { type: "number", required: true, description: "Transcript entry ID.", cardinality: "high" },
		"entry.kind": { type: "string", required: true, description: "Entry kind." },
	},
} as const;
// 上报种类是固定的封闭集合；values 供类型与文档使用，适配器不会在运行时拒绝集合外的字符串。
// reason 可选，表示该种类下的固定原因；extension 与 task.id 只在对应上报存在时携带。
const reportAttributes = {
	type: {
		type: "string",
		required: true,
		description: "Report kind (`Report.kind`).",
		values: [
			"storage_failed",
			"task_faulted",
			"task_interrupted",
			"migration_failed",
			"task_outdated",
			"task_error",
			"extension_error",
			"host_error",
			"listener_error",
		],
	},
	reason: {
		type: "string",
		required: false,
		description: "Fixed report reason, when present.",
		values: ["threw", "restart_limit", "interrupted", "missing_task", "task_too_old", "migration_failed"],
	},
	extension: { type: "string", required: false, description: "Registered extension name, when present." },
	"task.id": { type: "number", required: false, description: "Task ID, when present.", cardinality: "high" },
} as const;
// 事件 pi.durable.report 故意不带错误正文：错误可能含路径、凭据或用户内容，只保留分类属性。
const report = {
	description: "A report was raised; no error payload is recorded.",
	attributes: reportAttributes,
} as const;
// 事件 pi.durable.submission：一次提交结算时记录；answer.entry_id 仅当该提交产生了回答记录时存在。
const submission = {
	description: "A submission was settled.",
	attributes: {
		"submission.id": { type: "number", required: true, description: "Submission ID.", cardinality: "high" },
		status: { type: "string", required: true, values: ["done", "unanswered"], description: "Settlement." },
		"answer.entry_id": { type: "number", required: false, description: "Answer entry ID.", cardinality: "high" },
	},
} as const;

/** Durable's content-free span, event, and metric vocabulary. IDs address durable records, never content. */
/**
 * Durable 的全部遥测词汇：2 个 span、若干事件、3 个指标，版本 1。
 * 输入：无；输出：同一个 schema 对象（defineTelemetrySchema 原样返回）。无副作用。
 * 编译期：createTypedSpanStarter/createTypedMetrics 从中推导 span 名、事件名、必填属性和属性值域。
 * 运行时：适配器决定是否记录；本对象不做校验、冻结或迁移，也没有值域检查。
 * 例：createTypedSpanStarter(parent, [DURABLE_TELEMETRY_SCHEMA])("pi.durable.submit", attrs, callback)。
 */
// ID 只指向 Durable 记录，不携带消息、参数或错误正文；这是“content-free”的含义。
export const DURABLE_TELEMETRY_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {
		// 提交接纳 span：submit(draft, context) 连提交一起覆盖；submit(tx, draft) 只覆盖接纳，
		// 结果可能是暂时的——调用方事务之后抛错或存储失败时不会留下提交。
		// input/continue 起根追踪并用链接指回调用方；write 是调用方的子 span；内部接纳只发 phase 事件。
		"pi.durable.submit": {
			description:
				"Public submission admission: with its commit for submit(draft, context); the admission only for submit(tx, draft), whose result is provisional (a later throw or storage failure of the caller's commit leaves no submission) and whose commit events go to the caller's commit context. Inputs and continues start root traces linked to their callers; writes are children. Internal admissions emit phase events only.",
			// 父级政策：any 表示可作根，也可挂在任意父 span 下；它只是元数据，不在运行时拦截。
			parents: { kind: "any" },
			// startAttributes 的 required 参与编译期必填推导；endAttributes 没有 required 字段，全部可选。
			startAttributes: {
				"submission.type": {
					type: "string",
					required: true,
					values: ["input", "write", "continue"],
					description: "Submission type.",
				},
				"conversation.id": { type: "number", required: true, description: "Conversation ID.", cardinality: "high" },
			},
			endAttributes: {
				// 接纳得到的提交 ID 与结果：queued（排队）、placed（已放置）、done（当次完成）。
				"submission.id": { type: "number", description: "Admitted submission ID.", cardinality: "high" },
				result: {
					type: "string",
					values: ["queued", "placed", "done"],
					// 过期的 write 也报告 done：它当次完成了检查，只是没有改动会话（结算为 unanswered/stale）。
					description: "Admission result; stale writes report done.",
				},
			},
			events: { "pi.durable.entry": entry, "pi.durable.submission": submission, "pi.durable.report": report },
			status: { default: "ok", errorWhen: "Admission failed." },
		},
		// 任务相位 span：一次 run/abort 调用连同它的决策提交；等待、睡眠和重启本身不单独成 span。
		"pi.durable.phase": {
			description: "One task phase invocation, including its decision commit, never a wait or restart.",
			parents: { kind: "any" },
			// 开始属性描述“哪个任务的哪个相位”：run 是正常执行，abort 是中止路径；resumed 标记进程内首次装载。
			startAttributes: {
				"task.id": { type: "number", required: true, description: "Task ID.", cardinality: "high" },
				"task.name": { type: "string", required: true, description: "Registered task name." },
				phase: { type: "string", required: true, description: "Invoked checkpoint phase." },
				kind: { type: "string", required: true, values: ["run", "abort"], description: "Invocation kind." },
				attempt: { type: "number", required: false, description: "Checkpoint attempt, when present." },
				resumed: {
					type: "boolean",
					required: true,
					description: "First invocation of a task loaded in this process.",
				},
			},
			endAttributes: {
				// outcome 是调用结束时的去向文本；next=<phase> 表示任务切到下一相位，另有 waiting/sleeping/done 等。
				outcome: { type: "string", description: "next=<phase>, waiting, sleeping, done, faulted, or aborted." },
				"tool.name": { type: "string", description: "Called tool name." },
				"tool.call_id": { type: "string", description: "Transcript tool call ID.", cardinality: "high" },
			},
			// events 的键就是事件名；与 entry/report/submission 共用的定义可被多个 span 复用。
			events: {
				"pi.durable.entry": entry,
				"pi.durable.submission": submission,
				"pi.durable.report": report,
				// 同一次调用中 checkpoint 相位变化（例如 tool 从 call 进入 execute）时发事件，span 本身不结束。
				"pi.durable.checkpoint": {
					description: "The running checkpoint's phase changed while the invocation continued.",
					attributes: { phase: { type: "string", required: true, description: "Committed checkpoint phase." } },
				},
				// 嵌套工具调用没有重新执行，而是从已保存结果重放时记录。
				"pi.durable.replay": {
					description: "A nested tool call was answered from its stored result.",
					attributes: { "tool.name": { type: "string", required: true, description: "Called tool name." } },
				},
			},
			// default/errorWhen 是文档约定：适配器不会解析这段文字自动判定业务结果；
			// 调用点用 span.setStatus 显式设置，未显式设置时抛错/拒绝按适配器契约映射为 error。
			status: {
				default: "ok",
				errorWhen:
					"Faulted, failed, and orphaned outcomes use task_faulted, task_failed, and task_orphaned with a diagnostic capped at 500 characters. Aborted outcomes keep status ok.",
			},
		},
	},
	// 指标与 span 共用版本 1：累计上报数、相位耗时分布、当前活跃任务数。
	metrics: {
		// counter 只增；属性只按固定上报种类分组，不携带错误正文。
		"pi.durable.reports": {
			kind: "counter",
			description: "Reports raised, grouped by their fixed kind.",
			attributes: { type: reportAttributes.type },
		},
		// histogram 记录每次“相位调用 + 决策提交”的耗时，单位毫秒；按任务名、相位、结果分组。
		"pi.durable.phase.duration": {
			kind: "histogram",
			unit: "ms",
			description: "Duration of a phase invocation and its decision commit.",
			attributes: {
				task: { type: "string", required: true, description: "Registered task name." },
				phase: { type: "string", required: true, description: "Invoked checkpoint phase." },
				outcome: { type: "string", required: true, description: "Phase outcome." },
			},
		},
		// upDownCounter 可增可减：任务进入活动集合时加一，终止结算或 Harness 关闭时减一。
		"pi.durable.tasks.active": {
			kind: "upDownCounter",
			description: "Live tasks held by this Harness; decremented at terminal settlement or close.",
			attributes: { task: { type: "string", required: true, description: "Registered task name." } },
		},
	},
});
