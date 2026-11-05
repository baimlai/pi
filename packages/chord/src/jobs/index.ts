// Jobs for apps: declaring a job, its handle, its runs, their outcomes and `running`.

// 文件导读（公开出口）
// 所属：packages/chord/src/jobs，Chord v2 的作业（jobs）功能模块，面向插件/应用代码的稳定出口。
// 职责边界：只做再导出，不定义行为；把声明层（definition.ts）、句柄/上下文层（job.ts）、运行查询层（run.ts）
// 和可观察列表层（running.ts）中最适合外部使用的名字集中到这里。内部实现（Job 类、JobRecords、Invocation 等）
// 不从这里暴露，避免插件依赖 Chord 的内部状态。
// 上游入口：插件从 `chord` 的公开模块导入这些名字（具体包入口由 packages/chord/src/index.ts 或对应导出表决定）。
// 下游依赖：所有名字都来自同目录的模块；这里的值导出只有 defineJob，其余均被 `export type` 擦除，运行时不产生绑定。
// 结果与错误流向：defineJob 在声明时直接抛 Error（名字、版本、持久化规则等）；运行期失败通过 `Run.outcome()` 的
// 拒绝或 `Outcome.kind === "failed"` 交给调用方，不经过本文件。
// 能力清单：
// - defineJob：声明作业并做运行期校验，返回 JobDefinition。
// - JobOptions：defineJob 的配置对象（version/args/result/state/concurrency/accepts/persist）。
// - JobAccepts：旧版本 args/result 到当前版本的映射表。
// - JobDefinition：已声明作业的不可变描述（版本、schema 快照、指纹、持久化规则）。
// - JobError：run 抛出、被中止或达到重启上限时的失败形状。
// - Outcome：一次运行结束后的完整结果（id/args/state + done/failed）。
// - JobHandle：`self.job(Job, implementation)` 返回的句柄（start/outcome/abort/running）。
// - JobImplementation：插件提供的 run/finish 实现对象。
// - JobCtx：run/finish 收到的上下文（普通 Ctx 加 jobId 与可选 state）。
// - RunState：作业状态文档的同步读写接口。
// - StartOptions：start 的选项（目前只有去重用的 key）。
// - Run 与 BlockedReason：调用方持有的单次运行句柄，以及运行被冻结的原因。
// - RunningEntry：job.running 列表条目的公开形状。
// 组合关系/典型顺序：defineJob 声明 -> 对象实现里 self.job(Job, { run, finish }) 得到 JobHandle ->
// handle.start(args, ctx, { key }) 得到 Run -> await run.outcome(ctx) 得到 Outcome；期间 handle.running 可被 watch。
// 示例（真实 API 形状，省略 schema 细节）：
//   const Summarize = defineJob("summarize", { version: 1, args: ..., result: ... });
//   const handle = self.job(Summarize, { run: async (args, ctx) => ... });
//   const run = handle.start({ text: "hi" }, ctx);
//   const outcome = await run.outcome(ctx);
// 建议阅读顺序：先 definition.ts 的 JobOptions/Outcome 建立数据形状，再 job.ts 的 JobHandle/JobCtx 看调用面，
// 然后 run.ts 的 Phase/Run 看运行状态机，最后 records.ts（持久化与状态迁移）和 running.ts（观察者视图）。
// 这是 jobs 目录对插件/应用代码公开的出口；上游是外部插件通过 `chord` 的公开模块拿到这些名字；
// 下游是插件用 `defineJob` 声明作业、用 `self.job(Job, ...)` 实现它，并从运行结果/句柄读取状态。
// 这里只做再导出，不产生运行时逻辑：值导出（defineJob）与纯类型导出分开写，是因为类型导出在编译后被抹除，
// 不会在 JS 里留下不存在的绑定。
// `defineJob` 是唯一的运行时导出：它校验声明并返回 JobDefinition。其余是声明里的类型：
// JobOptions 是 defineJob 的第二个参数；JobAccepts 描述跨版本接受旧参数/结果的映射；
// JobError 是运行失败时抛给调用方的错误；Outcome 是一次运行结束后的完整结果记录。
export {
	defineJob,
	type JobAccepts,
	type JobDefinition,
	type JobError,
	type JobOptions,
	type Outcome,
} from "./definition.ts";
// 句柄一侧：JobHandle 是 `self.job` 返回给调用者的接口，JobImplementation 是插件提供的实现；
// JobCtx 是 run/finish 收到的上下文（比普通 Ctx 多 jobId 与 state），RunState 是作业可选运行状态的读写接口，
// StartOptions 是 `start(args, ctx, options)` 的第三个参数（目前只有去重用的 key）。
export type { JobCtx, JobHandle, JobImplementation, RunState, StartOptions } from "./job.ts";
// 运行查询：Run 是“这次开始”的句柄（outcome/abort），BlockedReason 解释一次运行为什么被冻结。
export type { BlockedReason, Run } from "./run.ts";
// `job.running` 可观察列表里每一项的公开形状。
export type { RunningEntry } from "./running.ts";
