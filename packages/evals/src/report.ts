/**
 * pi-evals 的报告层：读取每个运行臂的 Vitest JSON，归一化成观测，配对两个变体，计算提升并格式化报告。
 *
 * 所属包与模块：packages/evals/src 的报告/统计层。
 *
 * 解决什么问题：对照评测的每个“运行臂”都是独立容器里的一次 Vitest 测试。容器只留下
 * vitest.json 和 Pi 会话快照；本文件要把它们变成统一结构的 EvalObservation，
 * 再按 (evalSet, caseId, model, runNumber) 把 without_docs（control）与 with_docs（treatment）
 * 配成对，计算通过率差、token/工具调用/耗时/成本的均值差，并标出阻塞、无提升、
 * 负向变化、天花板和抖动等信号。
 *
 * 上下游与信任边界：
 * - 上游：cli.ts 调用 erroredObservation（没有报告时）、readTaskObservation（逐任务读取）、
 *   summarizeEvalObservations（汇总）、formatEvalComparisonReport（文本输出）。
 * - 下游：通过 @vitest-evals/core/node 读取 Vitest JSON 与 report workspace；
 *   通过文件系统持久化会话快照；通过 node:util 的 styleText 输出带颜色的文本。
 * - vitest.json、workspace、harness metadata 都是外部输入，结构必须运行时校验；
 *   TypeScript 类型只帮助编译期阅读，不能保证 JSON 真的符合声明。
 *
 * 本文件的能力清单：
 * - PI_SESSION_SNAPSHOT_ARTIFACT：harness 把 Pi 会话 JSONL 放在 artifacts 里的键名。
 * - EvalRunIdentity / ExpectedEvalRun：一次运行臂的身份字段；计划与观测共用。
 * - EvalObservation：身份 + 可选指标 + 结果判别联合（scored/unscored/skipped/pending/errored）。
 * - PairedMetricSummary / EvalSetComparison / BlockedPair / OperationalMetricTotal /
 *   VariantTotals / EvalComparisonReport：报告 JSON 的结构。
 * - erroredObservation：为没有报告的运行臂构造 errored 观测。
 * - readTaskObservation：读取一个 vitest.json/workspace，校验并归一化单臂观测。
 * - summarizeEvalObservations：分组、配对、计算报告。
 * - formatEvalComparisonReport：把报告变成终端友好的文本。
 *
 * 典型调用示例（示例，不是本文件自动执行的内容）：
 *   const observation = await readTaskObservation(task, "/run/tasks/x/vitest.json", "/run");
 *   const report = summarizeEvalObservations("digest", expectedRuns, [observation]);
 *   console.log(formatEvalComparisonReport(report));
 *
 * 建议阅读顺序：先看 EvalRunIdentity / EvalObservation / EvalComparisonReport 这组类型，
 * 再看 erroredObservation 与 readTaskObservation 的读取校验，接着看分组/配对/统计辅助，
 * 最后看 summarizeEvalObservations 与 formatEvalComparisonReport 的整体组装。
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { styleText } from "node:util";
import type { ReportCase } from "@vitest-evals/core";
import { readReportWorkspace, readVitestJsonReportFile } from "@vitest-evals/core/node";
import type { DocumentationVariant, EvalTask } from "./plan.ts";

// harness 把会话文件内容写入 run.artifacts 时使用这个键；本文件读取它并另存为 session.jsonl。
export const PI_SESSION_SNAPSHOT_ARTIFACT = "piSessionJsonl";

// 报告与计划共享的运行臂身份。variant 区分对照组（without_docs）与实验组（with_docs）。
export type EvalRunIdentity = {
	evalSet: string;
	caseId: string;
	variant: DocumentationVariant;
	model: string;
	runNumber: number;
};

// 计划中期望出现的运行臂与观测身份完全相同；单独取别名是为了在函数签名里表达意图。
export type ExpectedEvalRun = EvalRunIdentity;

// 运行臂可能缺失的指标。全部可选，因为失败、未评分或旧版 harness 不一定报告它们。
// 字段来自外部 JSON，读取时由 optionalMetric 做运行时校验。
type EvalMetrics = {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalTokens?: number;
	toolCalls?: number;
	totalMs?: number;
	estimatedCostUsd?: number;
};

// 观测 = 身份 & 指标 & 结果判别联合。outcome 是判别字段：
// - scored 一定带 score（0 到 1）；
// - 其他四种结果不带 score，表示没有可用于通过率比较的分数。
// 交叉类型让所有分支都自动带上 identity 与 metrics，避免重复声明。
export type EvalObservation = EvalRunIdentity &
	EvalMetrics &
	({ outcome: "scored"; score: number } | { outcome: "unscored" | "skipped" | "pending" | "errored" });

// 配对指标的摘要。两边都有均值时才有 delta；没有可配对样本时三者都是 null。
export type PairedMetricSummary = {
	// 同时提供该指标且两侧都可评分（scored）的配对数。
	eligiblePairs: number;
	// control（without_docs）均值。
	controlMean: number | null;
	// treatment（with_docs）均值。
	treatmentMean: number | null;
	// treatment - control；null 表示无法计算。
	meanDelta: number | null;
};

// 一个评测集的比较结果。flags 是字面量联合数组，取值在 comparisonFlags 中定义。
export type EvalSetComparison = {
	evalSet: string;
	// 计划中的配对总数（含被阻塞的）。
	totalPairs: number;
	// 成功配对且两侧都 scored 的数量。
	eligiblePairs: number;
	// totalPairs - eligiblePairs。
	blockedPairs: number;
	// 仅当没有阻塞配对时才发布通过率；否则为 null。
	controlPassRate: number | null;
	treatmentPassRate: number | null;
	// treatmentPassRate - controlPassRate；同样可能为 null。
	lift: number | null;
	// 供人快速识别的信号，见 comparisonFlags。
	flags: Array<"no-lift" | "negative-delta" | "control-saturated" | "treatment-saturated" | "flaky">;
	// 四项效率指标各自计算配对均值差。
	totalTokens: PairedMetricSummary;
	toolCalls: PairedMetricSummary;
	totalMs: PairedMetricSummary;
	estimatedCostUsd: PairedMetricSummary;
};

// 被阻塞的配对：没有 variant 字段，因为阻塞原因会分别列出两个变体的问题。
export type BlockedPair = Omit<EvalRunIdentity, "variant"> & { reasons: string[] };

// 运营总量：availableRuns 是真正提供该指标的运行数，total 是这些运行的求和。
// 没有可用值时 total 为 null，而不是误当成 0。
export type OperationalMetricTotal = { availableRuns: number; total: number | null };

// 单个变体的运营总量（不配对，按所有观测累加）。
export type VariantTotals = {
	variant: DocumentationVariant;
	runs: number;
	inputTokens: OperationalMetricTotal;
	outputTokens: OperationalMetricTotal;
	cacheReadTokens: OperationalMetricTotal;
	cacheWriteTokens: OperationalMetricTotal;
	totalTokens: OperationalMetricTotal;
	toolCalls: OperationalMetricTotal;
	totalMs: OperationalMetricTotal;
	estimatedCostUsd: OperationalMetricTotal;
};

// 最终报告 JSON。schemaVersion 是字面量 3，消费者可据此拒绝旧格式。
export type EvalComparisonReport = {
	schemaVersion: 3;
	protocolDigest: string;
	control: "without_docs";
	treatment: "with_docs";
	comparisons: EvalSetComparison[];
	blockedPairs: BlockedPair[];
	operationalTotals: VariantTotals[];
};

// 校验一个可选指标。输入来自 JSON 的 unknown；undefined 视为“未提供”。
// 必须是有限非负数，否则抛 TypeError。示例：optionalMetric(0, "tokens") -> 0。
function optionalMetric(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	// typeof 检查排除字符串等；Number.isFinite 排除 NaN/Infinity；负数指标没有业务意义。
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new TypeError(`${name} must be a finite non-negative number.`);
	}
	return value;
}

// 校验评分。null/undefined 表示没有分数；有效分数必须在闭区间 [0, 1]。
// 注意 0 是合法分数，调用方要用 undefined 判断“无分”，不能用假值判断。
function validateScore(value: unknown): number | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new TypeError("Eval score must be between 0 and 1.");
	}
	return value;
}

// 把 Vitest 的用例状态映射成观测结果。failed 记 errored；
// skipped/todo/disabled 统一记 skipped；pending 保留 pending；passed 返回 undefined，
// 表示继续检查 harness 与评分。ReportCase["status"] 是索引访问类型，取联合中的状态字符串。
function classifyCaseStatus(status: ReportCase["status"]): "errored" | "skipped" | "pending" | undefined {
	if (status === "failed") return "errored";
	if (status === "skipped" || status === "todo" || status === "disabled") return "skipped";
	if (status === "pending") return "pending";
	return undefined;
}

// 从 EvalTask 投影出报告身份，丢弃 fullName 与 file 等执行期字段。
// 展开对象而非引用 task，避免报告对象后续被任务修改。
function taskIdentity(task: EvalTask): EvalRunIdentity {
	return {
		evalSet: task.evalSet,
		caseId: task.caseId,
		variant: task.variant,
		model: task.model,
		runNumber: task.runNumber,
	};
}

// 为没有产生报告的运行臂构造 errored 观测。输入任务；返回身份完整的观测，无副作用。
// 示例：erroredObservation(task) -> { evalSet, caseId, variant, model, runNumber, outcome: "errored" }。
export function erroredObservation(task: EvalTask): EvalObservation {
	return { ...taskIdentity(task), outcome: "errored" };
}

// 把 harness 附在单臂结果上的 Pi 会话 JSONL 另存到报告产物目录。
// 输入 caseResult、task 与产物根目录；没有字符串会话时直接返回。
// 副作用：创建 <artifact>/<variant>/sessions/<hash>/session.jsonl，权限 0o700/0o600。
// 写盘或权限错误不会被吞掉，而是沿调用栈向外抛。
async function persistSession(caseResult: ReportCase, task: EvalTask, artifactDirectory: string): Promise<void> {
	// harness?.run?.artifacts 的连续可选链兼容三类缺失：没有 harness、没有 run、没有 artifacts。
	const session = caseResult.harness?.run?.artifacts?.[PI_SESSION_SNAPSHOT_ARTIFACT];
	// 非字符串（undefined、对象等）都不是合法会话快照，静默跳过。
	if (typeof session !== "string") return;
	// 用与任务目录相同的身份字段做哈希，保证同一任务的会话路径稳定且无非法字符。
	const identity = JSON.stringify([task.evalSet, task.caseId, task.variant, task.model, task.runNumber]);
	const directory = join(
		artifactDirectory,
		task.variant,
		"sessions",
		createHash("sha256").update(identity).digest("hex"),
	);
	// mkdir 的 recursive 允许父目录不存在；mode 只影响新建目录且受 umask 影响。
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(join(directory, "session.jsonl"), session, { mode: 0o600 });
}

// 读取一个运行臂的 Vitest JSON 与 workspace，归一化为 EvalObservation。
// 输入 task、报告路径和产物目录；任何缺失、重复、模型不符或校验失败都返回 errored，
// 而不是抛错，因为单臂失败不应中断整批计划。persistSession 的写盘错误不会被吞掉，会向外抛。
// 示例：readTaskObservation(task, "/run/tasks/h/vitest.json", "/run")
//   -> { outcome: "scored", score: 0.5, totalTokens: 15, ... }。
export async function readTaskObservation(
	task: EvalTask,
	reportPath: string,
	artifactDirectory: string,
): Promise<EvalObservation> {
	const identity = taskIdentity(task);
	// 并行读取 workspace（含 harness/eval 元数据）和原始 Vitest JSON；两者任一失败都返回 undefined。
	// .catch(() => undefined) 把解析/读取错误统一降级成“无法读取报告”。
	const loaded = await Promise.all([readReportWorkspace([reportPath]), readVitestJsonReportFile(reportPath)]).catch(
		() => undefined,
	);
	if (!loaded) return { ...identity, outcome: "errored" };
	const [{ workspace }, rawReport] = loaded;
	// Vitest 原始报告的 fullName 由 ancestorTitles 与 title 以空格连接；这里使用同样的拼接方式。
	const reportedFullName = `${task.evalSet} ${task.caseId}`;
	// flatMap 把每个测试文件的 assertionResults 摊平，再只保留名字完全匹配的断言。
	const assertions = rawReport.testResults
		.flatMap(({ assertionResults }) => assertionResults)
		.filter(({ fullName }) => fullName === reportedFullName);
	// 精确名过滤器理论上只应命中一个断言；0 个或重复都说明报告不可信。
	if (assertions.length !== 1) return { ...identity, outcome: "errored" };
	const assertion = assertions[0];
	// 先按 Vitest 状态映射；skipped/pending 不需要 harness 数据即可确定结果。
	const statusOutcome = classifyCaseStatus(assertion.status);
	if (statusOutcome === "skipped" || statusOutcome === "pending") return { ...identity, outcome: statusOutcome };
	// workspace 中的 ReportCase 带解析后的 harness/eval 元数据，同样要求唯一匹配。
	const caseResults = workspace.cases.filter(({ fullName }) => fullName === reportedFullName);
	if (caseResults.length !== 1) return { ...identity, outcome: "errored" };
	const caseResult = caseResults[0];
	// 两份来源的状态必须一致，否则无法判断以哪份为准。
	if (caseResult.status !== assertion.status) return { ...identity, outcome: "errored" };
	const run = caseResult.harness?.run;
	// 通过/失败状态但完全没有 harness run，说明测试不是由预期 harness 执行的。
	if (!run) return { ...identity, outcome: "errored" };
	await persistSession(caseResult, task, artifactDirectory);
	// 实际模型身份必须与计划一致，防止容器环境变量被覆盖后把结果算到错误模型上。
	const actualModel = run.usage.provider && run.usage.model ? `${run.usage.provider}/${run.usage.model}` : undefined;
	if (actualModel !== task.model) return { ...identity, outcome: "errored" };
	let metrics: EvalMetrics = {};
	try {
		// 每个字段都经过 optionalMetric 校验；metadata 是 JSON 记录，嵌套字段同样可能缺失。
		metrics = {
			inputTokens: optionalMetric(run.usage.inputTokens, "inputTokens"),
			outputTokens: optionalMetric(run.usage.outputTokens, "outputTokens"),
			cacheReadTokens: optionalMetric(run.usage.metadata?.cacheReadTokens, "cacheReadTokens"),
			cacheWriteTokens: optionalMetric(run.usage.metadata?.cacheWriteTokens, "cacheWriteTokens"),
			totalTokens: optionalMetric(run.usage.totalTokens, "totalTokens"),
			toolCalls: optionalMetric(run.usage.toolCalls, "toolCalls"),
			totalMs: optionalMetric(run.timings?.totalMs, "totalMs"),
			estimatedCostUsd: optionalMetric(run.usage.metadata?.estimatedCostUsd, "estimatedCostUsd"),
		};
	} catch {
		// 任一指标非法就把整臂记为 errored，避免把部分坏数据混入统计。
		return { ...identity, outcome: "errored" };
	}
	// 测试状态失败或 harness 自己记录了错误：保留已读指标，但结果仍是 errored。
	if (statusOutcome === "errored" || run.errors.length > 0) {
		return { ...identity, ...metrics, outcome: "errored" };
	}
	let score: number | undefined;
	try {
		// avgScore 来自评测 judge；null 表示未评分，非法数值视为报告损坏。
		score = validateScore(caseResult.eval?.avgScore);
	} catch {
		return { ...identity, ...metrics, outcome: "errored" };
	}
	// 没有分数但有完整运行：这是 unscored，不是 0 分，也不是错误。
	if (score === undefined) return { ...identity, ...metrics, outcome: "unscored" };
	return { ...identity, ...metrics, outcome: "scored", score };
}

// control 与 treatment 的固定名字。报告总是以 without_docs 为对照、with_docs 为实验组。
const CONTROL = "without_docs";
const TREATMENT = "with_docs";
// 用 as const 保持元组，使 for...of 时 variant 仍是窄联合而不是 string。
const VARIANTS = [CONTROL, TREATMENT] as const;

// Pair 只接受两侧都 scored 的观测，这样 score 字段一定存在。
type Pair = { control: EvalObservation & { outcome: "scored" }; treatment: EvalObservation & { outcome: "scored" } };
// 分组中间结构：expected 记录计划中每个变体应出现几次（正常是 1），observations 保存实际观测。
// Omit<EvalRunIdentity, "variant"> 去掉变体，因为一个组同时容纳两个变体。
type PairGroup = Omit<EvalRunIdentity, "variant"> & {
	expected: Map<DocumentationVariant, number>;
	observations: Map<DocumentationVariant, EvalObservation[]>;
};

// 算术平均。空数组返回 null，区别于“平均值恰好为 0”。
function mean(values: readonly number[]): number | null {
	return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

// 计算 treatment - control。toPrecision(15) 再转回 number，抹掉双精度运算的末位表示噪声，
// 例如 1.1 - 1 得到 0.10000000000000009，保留 15 位有效数字后回到 0.1。
function difference(treatment: number, control: number): number {
	return Number((treatment - control).toPrecision(15));
}

// 配对键：身份中除 variant 外的四个字段。JSON 数组编码避免字段拼接歧义。
function pairKey(identity: Omit<EvalRunIdentity, "variant">): string {
	return JSON.stringify([identity.evalSet, identity.caseId, identity.model, identity.runNumber]);
}

// 把计划与观测按 pairKey 分组。输入 expectedRuns 与 observations；返回按评测集/用例/模型/轮次排序的组。
// expected 计数允许后续发现“计划要求 1 次却出现 0 次或 2 次”的问题。
function groupPairs(expectedRuns: readonly ExpectedEvalRun[], observations: readonly EvalObservation[]): PairGroup[] {
	const groups = new Map<string, PairGroup>();
	// 内部闭包按需创建组；已存在则直接复用，保证计划和观测落入同一组。
	const getGroup = (identity: EvalRunIdentity): PairGroup => {
		const key = pairKey(identity);
		const existing = groups.get(key);
		if (existing) return existing;
		// 初始化为带两个空 Map 的可变组，后续逐步累加。
		const group = {
			evalSet: identity.evalSet,
			caseId: identity.caseId,
			model: identity.model,
			runNumber: identity.runNumber,
			expected: new Map<DocumentationVariant, number>(),
			observations: new Map<DocumentationVariant, EvalObservation[]>(),
		};
		groups.set(key, group);
		return group;
	};
	// 先登记计划：同一变体每出现一条期望运行就把计数加一。
	for (const expected of expectedRuns) {
		const group = getGroup(expected);
		group.expected.set(expected.variant, (group.expected.get(expected.variant) ?? 0) + 1);
	}
	// 再登记实际观测；同一变体可能有多条，用于检测重复。
	for (const observation of observations) {
		const group = getGroup(observation);
		const runs = group.observations.get(observation.variant) ?? [];
		runs.push(observation);
		group.observations.set(observation.variant, runs);
	}
	// Map 的插入顺序不适合报告；显式按评测集、用例、模型、轮次排序。
	return [...groups.values()].sort(
		(left, right) =>
			left.evalSet.localeCompare(right.evalSet) ||
			left.caseId.localeCompare(right.caseId) ||
			left.model.localeCompare(right.model) ||
			left.runNumber - right.runNumber,
	);
}

// 判断一个组能否形成有效配对。输入组；返回 { pair } 或 { blocked }。
// 阻塞原因逐条累积：计划次数不是 1、观测数与计划数不符、或唯一观测不是 scored。
function resolvePair(group: PairGroup): { pair?: Pair; blocked?: BlockedPair } {
	const reasons: string[] = [];
	for (const variant of VARIANTS) {
		const expected = group.expected.get(variant) ?? 0;
		const observed = group.observations.get(variant) ?? [];
		// 设计上每轮每个变体只跑一次；出现 0 或 2 次说明计划/执行有偏差。
		if (expected !== 1) reasons.push(`${variant}: design expected 1 run, found ${expected}`);
		if (observed.length !== expected) {
			// 三元表达式只负责英文单复数，不改变逻辑。
			reasons.push(
				`${variant}: expected ${expected} observation${expected === 1 ? "" : "s"}, found ${observed.length}`,
			);
		}
		// 数量匹配且只有一条，但结果不是 scored（skipped/pending/unscored/errored）时阻塞。
		if (expected === 1 && observed.length === 1 && observed[0].outcome !== "scored") {
			reasons.push(`${variant}: ${observed[0].outcome}`);
		}
	}
	if (reasons.length > 0) {
		// 阻塞对象不复制整个 group，只保留报告需要的身份字段。
		return {
			blocked: {
				evalSet: group.evalSet,
				caseId: group.caseId,
				model: group.model,
				runNumber: group.runNumber,
				reasons,
			},
		};
	}
	return {
		pair: {
			// 上面的检查已保证两个变体各有一条 scored 观测；非空断言在这里表达该不变量。
			// `as` 进一步把联合类型收窄为带 score 的分支，编译期需要，运行时不产生检查。
			control: group.observations.get(CONTROL)![0] as EvalObservation & { outcome: "scored" },
			treatment: group.observations.get(TREATMENT)![0] as EvalObservation & { outcome: "scored" },
		},
	};
}

// 计算一项指标的配对均值。输入 pairs 与取值函数；只有两侧都提供该指标时才计入。
// 返回 PairedMetricSummary；缺少样本时均值为 null。
function summarizeMetric(
	pairs: readonly Pair[],
	select: (observation: EvalObservation) => number | undefined,
): PairedMetricSummary {
	const control: number[] = [];
	const treatment: number[] = [];
	for (const pair of pairs) {
		const controlValue = select(pair.control);
		const treatmentValue = select(pair.treatment);
		// 任一侧缺失就跳过这一对，保证均值来自同一批配对样本。
		if (controlValue === undefined || treatmentValue === undefined) continue;
		control.push(controlValue);
		treatment.push(treatmentValue);
	}
	const controlMean = mean(control);
	const treatmentMean = mean(treatment);
	return {
		eligiblePairs: control.length,
		controlMean,
		treatmentMean,
		// 只有两边均值都存在时才计算差值。
		meanDelta: controlMean === null || treatmentMean === null ? null : difference(treatmentMean, controlMean),
	};
}

// 计算一个变体在某项指标上的运营总量。输入该变体的所有观测与取值函数。
// flatMap 的返回空数组技巧用来同时过滤 undefined 并保持类型为 number[]。
function operationalTotal(
	runs: readonly EvalObservation[],
	select: (observation: EvalObservation) => number | undefined,
): OperationalMetricTotal {
	const values = runs.flatMap((run) => {
		const value = select(run);
		return value === undefined ? [] : [value];
	});
	return {
		availableRuns: values.length,
		// 没有任何测量值时 total 为 null，不能把“缺失”当成 0 累加。
		total: values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0),
	};
}

// 汇总某个变体的全部运营指标。输入所有观测与目标变体；返回 VariantTotals。
// runs 是观测条数，不等于 availableRuns（后者是提供该项指标的条数）。
function variantTotals(observations: readonly EvalObservation[], variant: DocumentationVariant): VariantTotals {
	// 先按变体过滤，再对每项指标单独统计覆盖数。
	const runs = observations.filter((observation) => observation.variant === variant);
	return {
		variant,
		runs: runs.length,
		// 解构参数加隐式返回，等价于取字段后传给 operationalTotal。
		inputTokens: operationalTotal(runs, ({ inputTokens }) => inputTokens),
		outputTokens: operationalTotal(runs, ({ outputTokens }) => outputTokens),
		cacheReadTokens: operationalTotal(runs, ({ cacheReadTokens }) => cacheReadTokens),
		cacheWriteTokens: operationalTotal(runs, ({ cacheWriteTokens }) => cacheWriteTokens),
		totalTokens: operationalTotal(runs, ({ totalTokens }) => totalTokens),
		toolCalls: operationalTotal(runs, ({ toolCalls }) => toolCalls),
		totalMs: operationalTotal(runs, ({ totalMs }) => totalMs),
		estimatedCostUsd: operationalTotal(runs, ({ estimatedCostUsd }) => estimatedCostUsd),
	};
}

// 根据配对与通过率计算信号标签。
// 输入 pairs、controlPassRate、treatmentPassRate（后两者可能为 null）；
// 返回标签数组，顺序稳定。通过率相等记 no-lift，treatment 更低记 negative-delta，
// 任一侧达到 100% 记饱和；同一用例/变体跨轮次分数一会儿通过一会儿不通过记 flaky。
function comparisonFlags(pairs: readonly Pair[], controlPassRate: number | null, treatmentPassRate: number | null) {
	const flags: Array<"no-lift" | "negative-delta" | "control-saturated" | "treatment-saturated" | "flaky"> = [];
	// 只有两边都有可发布的通过率时才比较；被阻塞时通过率是 null，不能据此下结论。
	if (controlPassRate !== null && treatmentPassRate !== null) {
		if (controlPassRate === treatmentPassRate) flags.push("no-lift");
		if (treatmentPassRate < controlPassRate) flags.push("negative-delta");
		if (controlPassRate === 1) flags.push("control-saturated");
		if (treatmentPassRate === 1) flags.push("treatment-saturated");
	}
	// outcomes 的键是“用例 id + 变体”，值是该组合出现过的通过布尔值集合。
	const outcomes = new Map<string, Set<string>>();
	for (const pair of pairs) {
		// 这里用 control.variant（固定为 without_docs）区分两个变体的历史结果。
		const key = JSON.stringify([pair.control.caseId, pair.control.variant]);
		const control = outcomes.get(key) ?? new Set<string>();
		control.add(String(pair.control.score >= 1));
		outcomes.set(key, control);
		const treatmentKey = JSON.stringify([pair.treatment.caseId, pair.treatment.variant]);
		const treatment = outcomes.get(treatmentKey) ?? new Set<string>();
		treatment.add(String(pair.treatment.score >= 1));
		outcomes.set(treatmentKey, treatment);
	}
	// 某组合同时出现 true/false 即视为跨重复轮次不稳定；单轮无法判断稳定性。
	if ([...outcomes.values()].some((values) => values.size > 1)) flags.push("flaky");
	return flags;
}

// 汇总完整报告。输入协议摘要、计划运行臂与观测；返回 EvalComparisonReport，无副作用。
// 流程：分组 → 逐组配对或记录阻塞 → 按评测集聚合 → 计算通过率/提升/指标 → 加运营总量。
// 示例：summarizeEvalObservations("digest", [controlRun, treatmentRun], observations)
//   -> { schemaVersion: 3, comparisons: [...], blockedPairs: [], operationalTotals: [...] }。
export function summarizeEvalObservations(
	protocolDigest: string,
	expectedRuns: readonly ExpectedEvalRun[],
	observations: readonly EvalObservation[],
): EvalComparisonReport {
	const groups = groupPairs(expectedRuns, observations);
	const blockedPairs: BlockedPair[] = [];
	// 按评测集收集可评分配对；totalsByEvalSet 统计该集所有配对尝试（含阻塞）。
	const pairsByEvalSet = new Map<string, Pair[]>();
	const totalsByEvalSet = new Map<string, number>();
	for (const group of groups) {
		totalsByEvalSet.set(group.evalSet, (totalsByEvalSet.get(group.evalSet) ?? 0) + 1);
		// 每组要么给出 pair，要么给出 blocked，且只可能有一个。
		const { pair, blocked } = resolvePair(group);
		if (blocked) blockedPairs.push(blocked);
		// 展开旧数组再追加，避免原地 push 修改可能来自别处的数组（这里数组由本函数创建）。
		if (pair) pairsByEvalSet.set(group.evalSet, [...(pairsByEvalSet.get(group.evalSet) ?? []), pair]);
	}
	// 按评测集名排序，保证报告输出稳定。
	const comparisons = [...totalsByEvalSet]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([evalSet, totalPairs]) => {
			const pairs = pairsByEvalSet.get(evalSet) ?? [];
			const blockedPairCount = totalPairs - pairs.length;
			// 只要有一个阻塞配对，就不发布整体通过率，避免用不完整的样本下结论。
			const publishHeadline = blockedPairCount === 0 && pairs.length > 0;
			const controlPassRate = publishHeadline
				? pairs.filter(({ control }) => control.score >= 1).length / pairs.length
				: null;
			const treatmentPassRate = publishHeadline
				? pairs.filter(({ treatment }) => treatment.score >= 1).length / pairs.length
				: null;
			return {
				evalSet,
				totalPairs,
				eligiblePairs: pairs.length,
				blockedPairs: blockedPairCount,
				controlPassRate,
				treatmentPassRate,
				// 提升 = treatment 通过率 - control 通过率；统计单位是比例，乘 100 后才是百分点。
				lift:
					controlPassRate === null || treatmentPassRate === null
						? null
						: difference(treatmentPassRate, controlPassRate),
				flags: comparisonFlags(pairs, controlPassRate, treatmentPassRate),
				totalTokens: summarizeMetric(pairs, ({ totalTokens }) => totalTokens),
				toolCalls: summarizeMetric(pairs, ({ toolCalls }) => toolCalls),
				totalMs: summarizeMetric(pairs, ({ totalMs }) => totalMs),
				estimatedCostUsd: summarizeMetric(pairs, ({ estimatedCostUsd }) => estimatedCostUsd),
			};
		});
	return {
		schemaVersion: 3,
		protocolDigest,
		control: CONTROL,
		treatment: TREATMENT,
		comparisons,
		blockedPairs,
		// 运营总量基于全部观测（包括 errored），与“可评分配对”是不同口径。
		operationalTotals: [variantTotals(observations, CONTROL), variantTotals(observations, TREATMENT)],
	};
}

// 把 0 到 1 的比例格式化成百分比；null 显示 unavailable。
function percentage(value: number | null): string {
	return value === null ? "unavailable" : `${(value * 100).toFixed(1)}%`;
}

// 给数值加上显式正号并保留指定小数位；负数自带 "-"，不重复添加。
function signed(value: number, digits: number): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

// 格式化一项配对指标的一行文本。输入标签、指标摘要与单位。
// 缺少均值时返回 unavailable；padStart 对齐标签，保证多行报告易读。
function pairedMetric(label: string, metric: PairedMetricSummary, unit = ""): string {
	if (metric.meanDelta === null || metric.controlMean === null || metric.treatmentMean === null) {
		return `    ${label.padStart(10)}  unavailable`;
	}
	return `    ${label.padStart(10)}  ${signed(metric.meanDelta, 1)}${unit} (with ${metric.treatmentMean.toFixed(1)}${unit}, without ${metric.controlMean.toFixed(1)}${unit}, ${metric.eligiblePairs} pairs)`;
}

// 格式化运营总量。输入指标总计、总运行数与数值格式化函数。
// 没有测量值时显示 0/N measured；部分缺失时附加 (available/total measured) 说明覆盖度。
function operationalMetric(metric: OperationalMetricTotal, runs: number, format: (total: number) => string): string {
	if (metric.total === null) return `unavailable (0/${runs} measured)`;
	const coverage = metric.availableRuns === runs ? "" : ` (${metric.availableRuns}/${runs} measured)`;
	return `${format(metric.total)}${coverage}`;
}

// 把报告渲染为终端文本。输入 EvalComparisonReport；返回多行字符串，无副作用。
// 没有比较项时返回空串；否则依次输出每个评测集的配对/通过率/信号/效率指标，
// 再输出两个变体的运营总量，最后列出被阻塞配对及原因。
// 示例：formatEvalComparisonReport(report).includes("Documentation Eval Comparisons") -> true。
export function formatEvalComparisonReport(report: EvalComparisonReport): string {
	if (report.comparisons.length === 0) return "";
	// styleText("bold", ...) 在支持颜色的终端加粗，管道输出时自动退化为纯文本。
	const lines = [styleText("bold", "Documentation Eval Comparisons")];
	for (const comparison of report.comparisons) {
		lines.push(`  ${comparison.evalSet}`);
		lines.push(`         Pairs  ${comparison.eligiblePairs}/${comparison.totalPairs} eligible`);
		if (comparison.lift === null) {
			// 两种 null 原因要区分：有阻塞配对是“withheld”，没有可配对样本才是“unavailable”。
			lines.push(
				comparison.blockedPairs > 0
					? "     Pass rate  withheld because pairs are blocked"
					: "     Pass rate  unavailable",
			);
		} else {
			// lift 是 0-1 比例，乘 100 后表示百分点（pp）。
			lines.push(
				`     Pass rate  ${signed(comparison.lift * 100, 1)} pp (with ${percentage(comparison.treatmentPassRate)}, without ${percentage(comparison.controlPassRate)})`,
			);
		}
		if (comparison.flags.length > 0) lines.push(`         Flags  ${comparison.flags.join(", ")}`);
		lines.push(pairedMetric("Tokens", comparison.totalTokens));
		lines.push(pairedMetric("Tools", comparison.toolCalls));
		lines.push(pairedMetric("Latency", comparison.totalMs, "ms"));
		const cost = comparison.estimatedCostUsd;
		if (cost.meanDelta === null || cost.controlMean === null || cost.treatmentMean === null) {
			lines.push("     Est. cost  unavailable");
		} else {
			// 成本用美元符号和正负号展示；Math.abs 防止出现 "--$0.0100" 这种双符号。
			lines.push(
				`     Est. cost  ${cost.meanDelta >= 0 ? "+" : "-"}$${Math.abs(cost.meanDelta).toFixed(4)} (with $${cost.treatmentMean.toFixed(4)}, without $${cost.controlMean.toFixed(4)}, ${cost.eligiblePairs} pairs)`,
			);
		}
	}
	lines.push("  Operational totals");
	for (const totals of report.operationalTotals) {
		// 每项指标用对应单位格式化；延迟从毫秒转成秒，成本保留 4 位小数。
		const tokens = operationalMetric(totals.totalTokens, totals.runs, (total) => `${total} tokens`);
		const tools = operationalMetric(totals.toolCalls, totals.runs, (total) => `${total} tools`);
		const latency = operationalMetric(totals.totalMs, totals.runs, (total) => `${(total / 1000).toFixed(2)}s`);
		const cost = operationalMetric(totals.estimatedCostUsd, totals.runs, (total) => `$${total.toFixed(4)} cost`);
		lines.push(`    ${totals.variant}: ${totals.runs} runs, ${tokens}, ${tools}, ${latency}, ${cost}`);
	}
	if (report.blockedPairs.length > 0) {
		lines.push("  Blocked pairs");
		for (const blocked of report.blockedPairs) {
			// 每条原因用分号连接，仍保持单行，方便在 CI 日志中搜索。
			lines.push(
				`    ${blocked.evalSet}/${blocked.caseId}/${blocked.model}/run-${blocked.runNumber}: ${blocked.reasons.join("; ")}`,
			);
		}
	}
	return lines.join("\n");
}
