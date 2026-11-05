# 组 v1f

状态：完成

## 完成文件

- `packages/chord/src/old/cell.ts`：完整。逐行阅读了 `Cell`/`Derived`/`Source`/`Fanout`、`unbox`、`computeDependents`、水合协议与 `sharesStructure`，核对了其调用的 `delta` 的 `track`/`diffRevisions`、`publish.ts` 的 `enqueue`/`holdPublications`、`schema.ts` 的 `assertValid`、`types.ts` 的 `Ctx`/`Readable`/`StateEvent` 以及 `errors.ts` 的 `ChordError`，并对照 `object.ts`/`reload.ts`/`remote.ts`/`state.ts` 的调用场景。文件头覆盖状态层职责边界、上下游、导出能力、典型调用与阅读顺序；每个导出、方法、分支、异步检查、私有字段和 `SourceValues` 等类型工具均有中文说明。修改量：257 行新增、0 行删除。

- `packages/chord/src/old/schema.ts`：完整。核对了 `@earendil-works/pi-schema` 的 `compile`/`ValidationError`/`Validator`/`JsonSchema`，以及 `errors.ts` 的 `invalid`/`ChordErrorReason`；对照 `contract.ts`、`host.ts`、`object.ts`、`remote.ts`、`cell.ts`、`reload.ts` 的实际调用方式。文件头说明规范化管线（`cloneData → withDefaults → cleanFrom → assertValid`）、信任边界、导出能力与阅读顺序；逐段注释了规范 JSON、`hash64`、校验器缓存、默认值与字段清理、`canonicalIdentity` 和 `fits` 的保守子类型规则。修改量：231 行新增、0 行删除。

- `packages/chord/src/old/cluster.ts`：完整。核对了 `reload.ts` 的 `beginReload`/`endReload`/`Reload.prepare/commit/rollback/waitForRetirement/summary` 与 `ReloadReport`、`host.ts` 的 `peerHello`/`reloading`/`whenReloadEnded`/`peekNextCodeVersion`/`announceRetired`/`rememberRemoteModules`、`connection.ts` 的 `votes`/`send`/`markSynced`/`peerCodeVersion`/`open`，以及 `wire.ts` 的帧形状。文件头覆盖服务器侧事务顺序、参与者选择、FIFO 语义、错误聚合和阅读顺序；`runClusterReload`、`reconcileChild`、`modulesFor`、`awaitVote`、`ChildOperation` 与 `ChildReloads` 的每个状态转换、超时、abort、延迟 hello 和父链接丢失路径均有注释。修改量：189 行新增、0 行删除。

- `packages/chord/src/old/wire.ts`：完整。核对了 `connection.ts` 中帧的接收、方向检查与投票处理，`contract.ts` 的 `DescriptionSchema`，`errors.ts` 的 `CHORD_ERROR_CODES`/`ChordError`，以及 `cluster.ts` 对重载帧的构造。文件头说明协议版本、帧方向、单 schema 同时推导类型与运行时校验、payload 的信任边界、导出能力、示例与新增帧时需要同步修改的位置；逐帧注释了字段语义、`List`/`Open` 的类型作用、`isFrame`、`toWireError` 和 `fromWireError` 的前缀处理与信息丢失限制。修改量：150 行新增、0 行删除。

- `packages/chord/src/old/declare.ts`：完整。确认本文件只有类型声明，没有运行时代码；核对了 `object.ts` 的 `Self.resource`/`self.on` 重载、`ResourceImpl`/`ResourceFacade`、`#listenSource`、`stageListeners`，以及 `index.ts` 的重导出范围。文件头说明声明层与 `object.ts` 运行时实现的边界、`version`/`deps`/`exclusive` 的替换规则、`Subscribable`/`Resource`/`ListenerDecl`/`ValueOf`/`EventOf` 的能力和条件类型分支顺序；纠正了四参数 `self.on` 的事件类型来源（来自 `select` 返回类型，而不是 `EventOf`）。修改量：62 行新增、0 行删除。

- `packages/chord/src/old/websocket.ts`：完整。核对了 `connection.ts` 的 `AcceptOptions`、`host.ts` 的 `Host.accept`、`link.ts` 的 `WebSocketLike`/`webSocketLink` 的实现，以及 `packages/chord/test/old/websocket.test.ts` 的认证、冒充 host、拒绝、出站压缩和入站二进制用例。文件头说明结构类型适配、始终按 client 接入、认证的三种正常结果、先建 link 再认证的排队行为、出站压缩与入站拒绝压缩的策略、下游依赖和阅读顺序；函数内逐行说明了认证成功/失败/同步抛错路径与 `Omit` 的作用。修改量：52 行新增、0 行删除。

## 验证

- 已确认上述六个文件均为纯注释插入：`git diff --numstat` 分别为 cell `257/0`、schema `231/0`、cluster `189/0`、wire `150/0`、declare `62/0`、websocket `52/0`；`git diff` 中不存在以 `-` 开头的删除行。

- 测试命令与结果：
  - `cd packages/chord && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/old/cluster.test.ts test/old/websocket.test.ts`：2 个测试文件通过，16 个测试通过，613ms。
  - `cd packages/chord && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/old/state.test.ts test/old/contract.test.ts`：2 个测试文件通过，15 个测试通过，281ms。

## 未完成或风险

- 按任务要求未运行 `npm run check`、`npm run build`、全仓格式化、完整测试套件、`npm install`，也未执行任何 `git add`/`commit`/`push`。因此没有类型检查或构建层面的独立验证；不过所有修改均为注释行，未改动代码、类型、字符串、提示词或配置默认值。
- 只运行了与本组直接相关的定向测试，未覆盖其他 Chord 旧实现测试；`wire.ts` 没有单独的测试文件，其行为由 cluster/websocket 测试间接覆盖。
- `declare.ts` 是纯类型声明文件，没有运行时行为可执行；其注释依据 TypeScript 条件类型和 `object.ts` 的实际实现核对，未通过运行时用例单独验证。
- 未修改覆盖清单、`STUDY_PROGRESS.md`、`STUDY_LOG.md`、`SESSION_PLAN.md` 或其他代理的报告与文件。
