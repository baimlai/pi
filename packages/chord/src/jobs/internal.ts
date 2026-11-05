// Jobs for Chord's layers: a job's records on its object and the handle an attempt keeps, and what they need.

// 文件导读（Chord 内部出口）
// 所属：packages/chord/src/jobs，Chord v2 的作业模块，但这是给 Chord 其他层（不是插件）使用的入口。
// 职责边界：只再导出内部构造物，不做逻辑；公开出口 index.ts 看不到 Job 类与 JobRecords，
// 这样插件不会误用“只有 Attempt/Transaction 才能调用”的方法。
// 上游入口：host/attempt.ts 在 `job(definition, implementation)` 时构造 Job/JobRecords；
// documents/transaction.ts 在 `tx.start(job, args)` 时把 JobHandle 断言成 Job 并调用 stage。
// 下游依赖：JobOwner 里的回调由 Attempt 提供（admit/admitRun、documents、signal、token 等），
// JobRecords 再回调对象级的 store、活动计数和 running 列表。
// 结果与错误流向：本文件不产生结果；Job/JobRecords 的错误由宿主层（host/attempt.ts、host/object.ts）捕获并
// 转成对象的失败/运行时错误。
// 能力清单：
// - AnyJobImplementation：擦除泛型后的作业实现（run/finish 的 args/result/state 都是 unknown），
//   供内部表按统一类型存放不同作业。
// - CutReason：运行被切开的原因（"restart" | "reload"），传给 Job.seal 以决定记录写成 stopped 还是终止。
// - Job：单次声明在对象上的作业交给调用的入口，实现公开 JobHandle，并拥有 load/stage/seal/handOver 等内部方法。
// - JobOwner：Attempt 提供给 Job 的所有依赖（host、caller、context、signal、token、documents、admit、admitRun）。
// - JobRecords：一份作业定义在本对象上的运行记录集合，负责启动去重、状态迁移、持久化写入、结算与关闭。
// - RecordsOwner：JobRecords 反向依赖的对象级能力（label、host、context、documents、store、countRuns、held）。
// 组合关系/典型顺序：Attempt 创建 RecordsOwner 与 JobRecords -> 创建 JobOwner 与 Job -> 插件调用 handle.start ->
// Transaction 调用 Job.stage（记录暂存）-> 提交步骤 JobRecords.adopt -> 提交后 JobRecords.committed（真正调用 run）。
// 示例（内部调用形状）：`const job = new Job(owner, definition, implementation)`；Attempt 切开时
// `job.seal(error, "restart")`；对象关闭写回时 `job.writeAtClose(tx)`。
// 建议阅读顺序：先 job.ts 的 JobOwner/Job 看单次声明，再 records.ts 的 RecordsOwner/JobRecords 看记录集合；
// run.ts 与 run-states.ts 是这两个类使用的运行状态与状态文档。
// 这是 jobs 目录对 Chord 内部其他层（host/attempt.ts、documents/transaction.ts）的出口，与 index.ts 的公开出口分开：
// 插件不应该看到 Job 类的内部方法和 JobRecords。上游是对象尝试在声明 `self.job(...)` 时构造这些内部对象；
// 下游是 Attempt 把 seal/close 事件转给 Job，Transaction 把作业启动夹进自己的提交。
// AnyJobImplementation 让内部代码持有“任意参数/结果类型的作业实现”，CutReason 是切开运行时的原因。
export { type AnyJobImplementation, type CutReason, Job, type JobOwner } from "./job.ts";
// JobRecords 是一份作业定义在本对象上的全部运行记录；RecordsOwner 是它反向依赖的对象级回调（存储、活动计数等）。
export { JobRecords, type RecordsOwner } from "./records.ts";
