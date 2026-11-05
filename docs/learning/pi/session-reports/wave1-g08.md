# 组 g08

状态：完成

统一验证：

- 19 个分配文件均已完整阅读源码，并在文件头扩写详细“文件导读”（所属模块、职责边界、上下游、能力清单、组合关系、真实签名示例、阅读顺序）。
- `git diff --numstat` 对 19 个文件逐一核对：全部为 `-0`，没有删除或改写任何原有代码行。
- 新增行扫描：所有 `+` 行均为 `//` 注释或空行，没有新增代码。
- `node --experimental-strip-types --check` 逐一检查 19 个文件：0 个失败。
- 未运行 vitest：本次只加注释；workers 相关测试会 fork 子进程并依赖构建后的 `dist/`，需要 `npm run build`，本任务禁止执行；按任务约束也未运行 `npm run check`、全仓格式化和 git 操作。

## 完成文件

- packages/chord/src/contracts/accepts.ts：完整；核对 contract.ts 的 Contract/ContractData/ContractShape/Kind/LOCAL/ShapeOf，declare.ts 的 checkKeys/entriesOf，history.ts 的 Change/ChangesAfter/CurrentStep/MemberNames/MethodAt/OlderVersions/StepAt/VariantShape，以及 data/args.ts 中 bindProvider 对 checkAccepts 的实际调用点；统一验证通过。
- packages/chord/src/contracts/contract.ts：完整；核对 history.ts 的 Change/CurrentStep/History/VariantShape，host-kind.ts 的 Address，params.ts 的 Params/ParamsData，schema.ts 的 Method/NullSchema/Static，snapshot.ts 的 Snapshot，以及 watch.ts 的 Watchable/WatchHandle；统一验证通过。
- packages/chord/src/contracts/declare.ts：完整；核对 contract.ts 的 createContract/Contract/HostAddress/Kind/LOCAL/MemberKind/MethodData/VariantData，fingerprint.ts 的 materialize，history.ts 的 MemberNames/MethodAt/VariantShape，host-kind.ts 的 Address，names.ts 的 checkName，params.ts 的 readParams/RequiredFields，schema.ts 的 KeyedMember/Method/Schema/Static，snapshot.ts 的 snapshotArguments/snapshotSchema；统一验证通过。
- packages/chord/src/contracts/evolve.ts：完整；核对 contract.ts 的 contractData/createContract/ContractData/ContractShape/CurrentVariants/Kind/LOCAL/MemberKind/MethodData/ShapeOf，declare.ts 的 checkMembers/memberPath/readMethod，fingerprint.ts 的 materialize，history.ts 的 Change/CurrentStep/Increment/MemberNames/MethodAt/Variants/VariantsWith，schema.ts 的 Method/Schema，snapshot.ts 的 snapshotArguments/snapshotSchema；统一验证通过。
- packages/chord/src/contracts/fingerprint.ts：完整；核对 contract.ts 的 Kind/LOCAL/VariantData/VersionData，history.ts 的 Change，params.ts 的 ParamsData，json.ts 的 JsonValue；统一验证通过。
- packages/chord/src/contracts/history.ts：完整；核对 schema.ts 的 Method/Schema，并对照 accepts.ts/contract.ts/evolve.ts 对这些类型工具的实际使用；统一验证通过。
- packages/chord/src/contracts/host-kind.ts：完整；核对 names.ts 的 checkName，params.ts 的 joinKey/Params/ParamsData/RequiredFields/readParams，schema.ts 的 Static，以及地址工厂在 remote 的 hostAddress 和 host.route 中的调用方式；统一验证通过。
- packages/chord/src/contracts/index.ts：完整；核对所有公开再导出的实际来源（contract/declare/evolve/host-kind/names/params/schema/snapshot）及公共入口的导出集合；统一验证通过。
- packages/chord/src/contracts/internal.ts：完整；核对所有内部再导出的实际来源（accepts/contract/evolve/fingerprint/history/host-kind/names/params/schema）及其内部调用方；统一验证通过。
- packages/chord/src/contracts/names.ts：完整；核对 NAME 正则、checkName 的声明期信任边界，以及 declare.ts/host-kind.ts 中的调用点；统一验证通过。
- packages/chord/src/contracts/params.ts：完整；核对 schema.ts 的 BooleanSchema/IntegerSchema/LiteralsSchema/Optional/Schema/StringSchema/isOptional，snapshot.ts 的 snapshotSchema，json.ts 的 JsonValue，以及 host-kind/declare 对这些类型的实际使用；统一验证通过。
- packages/chord/src/contracts/schema.ts：完整；核对 @earendil-works/pi-schema 的构造器/类型（str/num/int/bool/nul/obj/arr/bytes/union/unknown/Optional/Schema/Static/StaticObject），以及 Method/KeyedMember 在 declare.ts/evolve.ts 中的 instanceof 分流；统一验证通过。
- packages/chord/src/contracts/snapshot.ts：完整；核对 @earendil-works/pi-schema 的 JsonSchema、json.ts 的 isJsonValue/JsonValue，以及 declare/evolve 对 snapshotSchema/snapshotArguments 的调用；统一验证通过。
- packages/chord/src/node/workers/control.ts：完整；核对 contracts 的 Address、data 的 ChordError/FailureCause/isChordError、data/internal 的 chordErrorFromJson、host 的 ReloadReport、json 的 JsonValue、plugins/runtime 的 PluginScript，以及 process/main/workers 中的收发调用；统一验证通过。
- packages/chord/src/node/workers/index.ts：完整；核对 control/lock/main/workers 的实际导出名称与类型，以及 createWorkers/workerMain/processLock 的真实签名；统一验证通过。
- packages/chord/src/node/workers/lock.ts：完整；核对 node:crypto/fs/net/os/path、context/index 的 Context，以及 main.ts #run 和 workers.ts #start 的锁使用方式；统一验证通过。
- packages/chord/src/node/workers/process.ts：完整；核对 node:child_process、link/index 的 Link/ipcLink、control 的 controlOf/envelope/FromWorker/ToWorker，以及 workers.ts #fork 的事件接线；统一验证通过。
- packages/chord/src/node/workers/main.ts：完整；核对 context/index（BACKGROUND_CONTEXT/withAbortSignal/Context）、contracts 的 Address、data 的 Principal、host 的 Host/LoadReport/PluginFacet/ReloadReport、json 的 JsonValue、link 的 IpcPort/ipcLink/Link、watch 的 Watchable、plugins/evaluate 的 HostPackages、plugins/runtime 的 createPluginRuntime/PluginScript、control 的消息与转换、lock 的 processLock；统一验证通过。
- packages/chord/src/node/workers/workers.ts：完整；核对 context/index、contracts 的 Address/HostKind/KindShape、contracts/internal 的 Params、data 的 ChordError/Principal、host 的 Host/RouteHandle、json 的 JsonValue、state/internal 的 Batch/BatchError/Source、watch 的 Watchable、plugins/plugins 的 Plugins/RolloutHost/RolloutStep、plugins/runtime 的 PluginScript、control 的 CrossedError/CrossedReport/FromWorker/uncrossed/uncrossedReport、process 的 Exit/WorkerProcess；统一验证通过。

## 未完成或风险

- 未运行运行时测试：本次改动仅新增注释；workers 测试需要构建 `dist/`（`npm run build`），本任务明确禁止；契约测试虽可从源码运行，但没有代码行为变化，且任务要求不虚报未执行的验证。
- 未更新覆盖清单、进度、日志或其他代理报告，符合组任务的分工约束。
- 残余风险：仅注释改动不会改变运行行为；已用语法检查和“新增行全为注释”扫描兜底，但最终的类型检查与全仓验证仍应由协调者在所有并行代理完成后统一执行。
