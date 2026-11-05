# 组 g14

状态：完成

## 完成文件

- packages/chord/src/host/activity.ts：完整；核对 Host 构造处的 `new Activity(this.batch)`、`Source` 批次发布与 Activity 计数调用点；文件头、类型字段、方法逐行注释齐全；`git diff --numstat` 为 41 行新增、0 删除。
- packages/chord/src/host/adapted.ts：完整；核对 `checkAccepts` 的 accepts 形状、`variantsAt`/`currentVariants`、`Derive.attach` 与键控 members 的 pin/release 流程；含旧版本映射、refuse、共享 key 映射、detach；78 行新增、0 删除。
- packages/chord/src/host/attempt.ts：完整；核对 `Attempt` 的上下游调用（object.ts、host.bind/acquire、members、routines、jobs、native、follow、registry、reload 路径）、`Self`/`StoreSelf`/`Factory` 及各私有方法与字段；覆盖激活、停放、调用、seal/close/reload 交接与全部辅助方法；390 行新增、0 删除。
- packages/chord/src/host/backoff.ts：完整；核对 object.ts 的 `failed`/`delete`/`skip`/`until` 调用与 Host 的 `waiting`/`clear`；覆盖 Entry 字段、翻倍上限与各清理方法；52 行新增、0 删除。
- packages/chord/src/host/ctx.ts：完整；核对 `Attempt.call` 的 CallContext 构造、`host.acquire`、`settle`/`release` 与 `withLinkedAbortSignal` 在 reference.ts/host.ts 的调用；覆盖 `Ctx` 字段、`get` 的错误优先级、信号合并实现；81 行新增、0 删除。
- packages/chord/src/host/deadline.ts：完整；核对 `Attempt.activate` 创建、`#prepareTables`/`#park` 的 pause/resume 与 `clear`；覆盖暂停预算、幂等与永久清理；38 行新增、0 删除。
- packages/chord/src/host/dependencies.ts：完整；核对 `checkDependencies` 在 `#activate`/`#park` 的调用、`RefState`/`FailureCause`/`RegistryValueSource` 类型；覆盖三态 `Check`、firstPass、healsNever、`parkedCause`/`waitingOn` 与 `ParkedLong`；68 行新增、0 删除。
- packages/chord/src/host/destination.ts：完整；核对 `Host` 的 reference/hold 路径、`Route.path` 与父链路语义；覆盖 `Placed`、`reference`/`hold`/`misplaced`、地址浅比较；56 行新增、0 删除。
- packages/chord/src/host/facet.ts：完整；核对 `defineFacet`/`setUp` 的调用方、`checkAccepts` 与 ServedEntry 消费方；覆盖 host/self 声明窗口、重载分派、重复 contribute 检查、幻影 `~principal`；72 行新增、0 删除。
- packages/chord/src/host/follow.ts：完整；核对 `Attempt.follow`/`#ownSteps` 的 attach、`Attempt.detach`、`Source` 批次与 `WatchCall`/`WatchEnd` 类型；覆盖四态状态机、批次内外调用合并、结束帧顺序、派生交付；106 行新增、0 删除。

验证：

- 全部 10 个文件 `git diff --numstat` 均为 0 删除；`git diff --check` 无空白错误。
- 运行 `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/host/activity.test.ts test/host/backoff.test.ts test/host/ctx.test.ts test/host/deadline.test.ts test/host/dependencies.test.ts test/host/facet.test.ts test/host/follow.test.ts`（在 packages/chord 下）：7 个文件、62 个测试通过。
- 运行 `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/host/adapted.test.ts test/host/attempt.test.ts test/host/parked.test.ts`：3 个文件、95 个测试通过。

## 未完成或风险

- 无未完成文件。
- 按要求未运行 `npm run check`、`npm run build`、全仓格式化；因此类型/格式的全局验证需在汇总阶段执行。
- 未修改覆盖清单、进度、日志或其他代理文件。
