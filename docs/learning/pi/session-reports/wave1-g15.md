# 组 g15

状态：完成

## 完成文件

- packages/chord/src/jobs/definition.ts：完整；核对 `defineJob` 的声明期检查、`args.normal`/`result.normal`/`state.fingerprint` 输入与 `hash64` 指纹计算，以及 `JobOptions`/`JobPersistence`/`JobAccepts`/`Outcome`/`JobError`/`JobDefinition` 字段和构造器；文件头导读、逐字段与逐检查注释齐全；110 行新增、0 删除。
- packages/chord/src/jobs/index.ts：完整；核对全部对外导出（`defineJob`/`JobOptions`/`JobAccepts`/`JobDefinition`/`JobError`/`Outcome`/`JobHandle`/`JobImplementation`/`JobCtx`/`RunState`/`StartOptions`/`Run`/`BlockedReason`/`RunningEntry`）；补文件导读与逐导出说明；44 行新增、0 删除。
- packages/chord/src/jobs/internal.ts：完整；核对内部导出（`AnyJobImplementation`/`CutReason`/`Job`/`JobOwner`/`JobRecords`/`RecordsOwner`）及 host/attempt.ts 的消费方；补文件导读与逐导出说明；29 行新增、0 删除。
- packages/chord/src/jobs/job.ts：完整；核对 `JobRecords` 的 stage/reserve/settled/change/cut/detach/requeue/argsOf/outcomeOf/stateOf/progressed、`Documents.tx`、`CallContext`、`withAbortSignal`/`withoutAbortSignal`、`sleep`/`nextDelay`、`Invocation`/`JobRun` 后，注释覆盖 `JobHandle`/`StartOptions`/`JobImplementation`/`JobCtx`/`RunState`/`JobOwner`/`CutReason`/`AnyJobImplementation`、`Job` 全部字段与方法（含 `seal`/`handOver`/`invoke`/`#start`/`finish`/`#failed`/`#settled`/`#finish`/`#stateOf`）及 `IMMEDIATE`/`checkedPersistence`/`internal`/`JobContext`；146 行新增、0 删除。
- packages/chord/src/jobs/persisted.ts：完整；核对 `Persistence.at/read/keys/find`、store 的 `createDocument`/`changeDocument`/`retireDocument`、`StagedWrite` 与 `recordOf` 后，注释覆盖 `LoadedRecord`、`KEYS_PAGE`、`PersistedRuns` 的 stage/stageRetire/findBlockedState/forgetBlockedState/load/drop 及分页循环；59 行新增、0 删除。
- packages/chord/src/jobs/records.ts：完整；核对 `Documents.tx/stage/own/fence/retireSlot/stageStore`、`PersistedRuns`、`RunStates`、`Running`、`JobRun`、`storedRun`/`outcomeOf` 后，注释覆盖 `RecordsOwner`/`Settled`/`RunFields`/`Restored`/`RecordChange`/`Adopted`/`Staging`、`RESTART`/`RELOAD`/`ABORTED`/`RESTART_LIMIT`、`JobRecords` 全部字段与方法（声明检查与 reload、stage/change/staging、load/#restored、attach/detach/#need/#dispatch、#adopt/#committed、close writer、end/drop）以及 `runAll`/`recordFields`；204 行新增、0 删除。
- packages/chord/src/jobs/run-states.ts：完整；核对 `RunStates` 的 stage/adopt/stageCreate/stageHeld/heldOps、`SlotDefinition`、`CommitPersistence` 与事务 `draftSlot` 后，注释覆盖 `HeldState`/`RunStatesOwner`/`DEFAULT_WITHIN_MS`/`RunStates` 全部字段与方法及延迟持久化路径；103 行新增、0 删除。
- packages/chord/src/jobs/run.ts：完整；核对 `JobRun`/`Invocation`/`Waiters`/`Joins`、`Promise.withResolvers`、`AbortController` 与 token 围栏后，注释覆盖 `Run`/`AnyOutcome`/`Phase`/`BlockedReason`/`Answer`/`Waiter`/`JobRun`/`Invocation`/`Waiters`/`Joins` 及全部方法；98 行新增、0 删除。
- packages/chord/src/jobs/running.ts：完整；核对 `Source`/`Batch`、delta `Op`、`JsonValue` 与 `BlockedReason` 后，注释覆盖 `RunningEntry`、`Running` 的 add/replace/stateChanged/remove/deliver/end/#current/#replaced/#mark 以及 `under` 的 op 重写；59 行新增、0 删除。
- packages/chord/src/jobs/stored.ts：完整；核对 wire error 格式、`StoredRun`/`StoredFields`/`StoredOutcome`/`StoredJobError`、`storedRun`/`outcomeOf`/`recordOf`/`RUN_RECORD` 后，注释覆盖全部类型、常量与函数；80 行新增、0 删除。

验证：

- 全部 10 个文件 `git diff --numstat` 均为 0 删除；`git diff --check` 无空白错误。
- 在 packages/chord 下运行 `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/jobs/definition.test.ts test/jobs/job.test.ts test/jobs/persisted.test.ts test/jobs/records.test.ts test/jobs/run.test.ts test/jobs/running.test.ts`：6 个文件、113 个测试通过。
- 每个文件头均包含所属模块、职责边界与上下游、按导出项的能力清单、组合关系/调用顺序、真实签名示例、建议阅读顺序（已用脚本逐项核对 8 个标记）。

## 未完成或风险

- 无未完成文件。
- 按要求未运行 `npm run check`、`npm run build`、全仓格式化；类型与格式的全局验证需在汇总阶段执行。
- 未修改覆盖清单、进度、日志或其他代理报告。
