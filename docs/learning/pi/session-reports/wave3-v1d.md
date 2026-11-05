# 组 v1d

状态：完成

## 完成文件

- `packages/chord/src/old/reload.ts`：完整；核对了 `HostImpl.reload`/`retire`/`retirable`/`watchRetirement`/`liveDecls`/`buildTables`/`installTables`/`retireImplementation`/`fail`/`startHostObject`/`facetRunChanged`，`ObjectImpl.run`/`open`/`initCells`/`stageListeners`/`unwind`/`startTasks`/`openGate`，`ResourceImpl.close`/`adopt`/`markUnavailable`，`Derived.attach`/`refresh`/`detach`，`contract.bind`/`coverage`，`publish.holdPublications`，`schema.assertValid`/`deepEqual`，以及 `cluster.ts` 对 `beginReload`/`prepare`/`summary`/`commit`/`rollback`/`endReload` 的实际调用顺序。文件头写明所属模块、职责边界、上下游、按导出项的能力清单、prepare/commit 的完整阶段顺序、真实签名示例（`host.reload`）、报告字段含义和阅读顺序；`ReloadOptions`/`ReloadReport`/`Candidate`/`Reload` 的字段、`dryRun`/`candidateValue`/`reloadError`/`until` 以及 `prepare`/`waitForRetirement`/`load`/`withDeadline`/`checkProviders`/`prepareAll`/`prepareObject`/`checkRefs`/`entries`/`gate`/`migrate`/`rollback`/`commit`/`#publish`/`install` 均有逐行中文说明。复核后修正了草稿中的不准确表述：`liveDecls(true)` 的 `true` 实际是包含 `deferredRuntime` 对象，而非“所有代码版本的存活声明”；`migrate` 只会在版本已升高时处理 schema 差异，版本未变而 schema 不同已在 `prepareObject` 被拒绝；回滚恢复的是 `state === "closed"` 的 replaced 资源，旧任务通过 `startTasks` 恢复；`#publish` 第 6 步只删除 `hostObjects`，facet 删除在第 7 步；补充了 kept resource 的 `adopt` 语义和浏览器引用 bind 失败/成功两条路径。修改量：283 行新增、0 行删除。

- `packages/chord/src/old/remote.ts`：完整；核对了 `HostImpl.#remoteKey`/`#acquireRemote`/`#hold`/`bindingIdle`/`forgetBinding`，`Connection.hold`/`bound`/`state`/`shaped`/`gone`/`detached`/`wantState`/`call`，`object.ts` 的 `REF_BASE`/`CtxImpl`/`notifyStatus`/`raceSignal`/`refsByProxy`/`refOf`/`RefCore`，`cell.ts` 的 `HYDRATION`/`Hydration`，`delta` 的 `decoder`/`applyImmutable`，`contract.takesNoArgs`，`schema.cleaned`，`wire.fromWireError`，以及 `get` 的 `state: false` 选项和链路重连/重发状态帧的协议行为。文件头写明所属模块、职责边界、上下游、六个接口/类的能力清单、共享绑定与视图的典型时序、真实签名示例（`host.get` + 方法调用 + 状态读取 + `onStatus` + `release`）和阅读顺序；`StateIn`/`RemoteChannel`/`RemoteHost`/`deferred`/`MemberState`/`RemoteBinding`/`ViewReadable`/`RemoteRef` 的字段、状态机方法、Proxy、`#caller` 与监听语义均有中文说明。复核后修正了草稿中的不准确表述：`binding.error` 只供 `RemoteBinding.terminalError` 使用，`RemoteRef` 使用自己的 error；`#live` 只在 live → loading 断线时替换，而非每次 hold 建立；`#apply` 与 `hydrated` 的判定对象是 `shape.members` 中属于契约 state 的成员；`events` 的 unseen 监听者若首个事件是 ops 则不投递，之后按已见监听者接收；重新 hold 期间保留旧值、重新订阅后的水合由完整 unit 触发。修改量：288 行新增、0 行删除。

- `packages/chord/src/old/registry.ts`：完整；核对了 `object.ts` 的 `Self.register`（实际签名为 `register(registry, entries: Record<string, V>)`，仅 host 生命周期对象可调用，同一 run 内 registry+key 重复会抛 `invalid/duplicate`）、`Self.#unique`、`HostImpl.registry`/`buildTables`/`checkRegistrations`/`registriesChanged`/`installTables`/`EMPTY_TABLE`，以及 `test/old/reload.test.ts`、`host.test.ts`、`host-objects-reload.test.ts` 等注册表用例。文件头写明所属模块、职责边界、上游入口/下游依赖、按导出项的能力清单、声明与读取顺序、真实签名示例、字段与方法的编译期/运行时区别和阅读顺序；`Registry`/`defineRegistry`/`RegistryTable`/`RegistryView`/`Registration` 均有逐行注释。复核后修正了草稿中的关键错误：`self.register` 的第二个参数是“键 → 值”记录而不是 `(key, value)` 两个参数；`buildTables` 的 conflict 只处理不同对象之间的同键，同一对象的同键先被对象层拒绝；`checkRegistrations` 只试建校验，不保存表。修改量：66 行新增、0 行删除。

测试命令与结果（均在 `packages/chord` 下执行，未运行 `npm test`、`npm run check`、`npm run build` 或全仓格式化）：

- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/old/reload.test.ts test/old/bindings.test.ts test/old/hydration.test.ts test/old/variants.test.ts test/old/host-objects-reload.test.ts test/old/link.test.ts`：6 个文件通过，61 个测试通过，约 437ms。覆盖热重载准备/提交/回滚、远程绑定共享与释放、状态水合、variant 切换、宿主对象重载和链路断开/恢复。

## 未完成或风险

- 三个文件均为 Chord v1 旧实现（`packages/chord/src/old/`），不是 v2；注释中的结论以当前源码和上述被调用方为准。
- 未运行 Chord 全量测试或集群/真实网络场景（任务禁止 `npm test`，且其他代理正在并行修改其他旧实现文件）；本次只运行了与这三个文件直接相关的 6 个离线测试文件。`RemoteBinding` 的链路重排、窗口/urgent、relay 转发等协议细节通过阅读 `connection.ts` 和 `wire.ts` 核对，未单独构造慢链路或真实子主机用例。
- 按任务要求未运行 `npm run check`、`npm run build`、全仓格式化，也未执行 `git add`、`git commit`、`git push`、`npm install`；未修改覆盖清单、进度、日志或其他代理报告。三个目标文件的 `git diff --numstat` 均显示纯新增、0 行删除，新增行均为注释或空行。
