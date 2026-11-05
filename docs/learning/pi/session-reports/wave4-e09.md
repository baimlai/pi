# 组 e09

状态：完成

## 完成文件

本组清单共 21 个路径：18 个 TypeScript 示例文件全部补全“文件导读”与逐行中文注释，3 个 `package.json` 按任务要求未修改。所有 TS 文件保持原有英文文档、代码、字符串、类型、默认值与缩进不变；对每个文件执行 `git diff -- <file> | grep '^-[^-]'`，输出均为空，即只有新增注释行、没有删除或改写行。

验证方式：在 `packages/chord` 下逐个运行 `node --conditions=source --experimental-strip-types test/examples/<file>.ts`，18 个 TS 文件退出码均为 0（其中 21-34 在最终修改后整批重跑，35 及其插件文件在最后一次注释修正后重跑），输出与各文件“预期输出”一致。未运行 `npm run check`、`npm run build`、全仓格式化或完整测试套件。

### slice 6a：持久化文档、迁移、keyed、导出/导入

- packages/chord/test/examples/21-persisted-documents.ts：完整。补全 `persist: true`、`checkpointWhen`（每 20 条 delta 存一次 base，Notes 恒为 false）、`openNodeSqliteDatabase`/`sqliteBackend`/`openStore`、`session()` 的 host → store 关闭顺序。实际输出 3 行与导读一致：两个 host 都读到 `[ 'home', 'work' ]`，第二个 host 读到 `standup: demo the store`。
- packages/chord/test/examples/22-migrations.ts：完整。核对 `defineTable` v1、`evolveTable` 的 `rename`/`add`/`rows` 数据步骤/`drop`/`index`、按 100 行分批逐版本迁移、全新 store 直接建最新版。实际输出 v1 三行、v3 四行，`file` 已改名 `path`、`dir` 已 drop，字段顺序与列声明一致。
- packages/chord/test/examples/23-keyed-watches.ts：完整。核对 keyed 文档按 key watch、`handle.at(key)`、缺失 key 读 `initial()`、`retire` 帧为 `initial()` + `retired: true`、`WatchHandle.stop/closed`。实际输出 4 行，包含 `watch of an absent key: undefined` 与两帧 `(retired)`。
- packages/chord/test/examples/24-keyed-members.ts：完整。核对 `keyed(schema)` 成员、工厂内 `ref.member.at(key)` pin、对象外 `get/watch(key, ctx)`、每 key 单一 source、`self.derive` 跟随。实际输出 `Ana (online)` → `Ana (away)` → 缺失 key 为 `undefined`。
- packages/chord/test/examples/25-export-import.ts：完整。核对 `store.export(ctx)` 的 ArchivePart 流与提交队列占用、`encodeJsonl`/`decodeJsonl`、`importStore` 逐部件校验与单事务建库、`pipeline` 写 JSONL。实际输出 `archive: 772 bytes at seq 5`、`imported at seq 5`、`title: Chord - next visit of /: 3`。字节数随归档格式版本变化，导读已注明以 `seq` 与计数为断言。

### slice 6b：持久化作业

- packages/chord/test/examples/28-persisted-jobs.ts：完整。核对 `persist: { resume: "rerun" }`、崩溃计数（连续五次触发 `restart_limit`）、干净关闭写回 `stopped` 且恢复不计数、对象重试、`abort` 的 `"marked"`/`"terminal"`、deferred 状态变更与 `settle()` 时序。实际输出四个编号场景，`from done = 0/1/2`、`finish: done { count: 3 }`、`unsettled runs now: 0`、`abort: marked`、`finish: done { count: 1 }`、两次 `terminal`。导读已注明 abort 与 finish 两行先后依赖微任务调度。

### slice 8：注册表与 host.root

- packages/chord/test/examples/29-registries.ts：完整。核对 `defineRegistry`、`host.serve(Registry, { compose })`、`self.contribute`/`self.writable`、插件名排序与重复键 `registry_conflict`（名字更小者保留）、`keyedEntries`、贡献回调异常在使用点被捕获为 `"500"`、load 前读取的 `not_ready`。实际输出包含冲突提示、三条路由、`/broken -> 500`、挂载后的 `/files -> mounted /files`。
- packages/chord/test/examples/30-host-root.ts：完整。核对 `host.root(fn, ctx, options)` 的 principal 覆盖、`ctx.get`、作用域封口（abortSignal、引用释放、迟到调用 `released`）、未 await 变更的 `transaction_cancelled` 上报、`host.close` 的 `released/closed`。实际输出七个场景共 9 行，与导读逐条一致。

### slice 7a：停放依赖与启动屏障

- packages/chord/test/examples/31-parked-dependencies.ts：完整。核对依赖缺失时 `failed { waiting }`（而非 failed + 计时器）、工厂不重跑、依赖 live 后自动继续、`get(..., readyTimeout)` 超时只影响该次等待、链路断开后 `loading` 再重连变 `live`、无人提供的 Theme 停放在类型索引下。实际输出 11 行，包含 `1.7 s: panel: live`、`count 0`、`factory runs: 1`、`panel count 1`。
- packages/chord/test/examples/32-startup.ts：完整。核对 load 先发布声明再启动 host-lifetime 对象、启动请求只等本次发布而非 start barrier、跨 host 无环依赖（Bootstrap → Agent → Catalog）不死锁、`server.load` 在 Bootstrap 停放后即 resolve。实际输出 `server: Bootstrap declares the worker's Agent`、`worker loaded`、`Bootstrap live, it sees 3 models through the worker`。导读已注明毫秒数与相邻行次序随调度变化。

### slice 7b：reload 与版本兼容

- packages/chord/test/examples/33-reload.ts：完整。核对 staging 用 recording self 运行 setup/新工厂、失败插件保留旧代码并入 `failed`、commit 后每个对象的 `swapped`/`restarted`/`ended`/`failed { waiting }`、纯对象原地 swap 保留文档、`self.open` 的 native 在 restart/removal 时的关闭原因、移除后 holder 保留最后值并回到 waiting、再次服务后自动绑定。实际输出 5 个编号步骤与最后一行 `search: tantivy closed (end)`。
- packages/chord/test/examples/34-versions.ts：完整。核对 `evolve(NotesV1, ...)` 追加 v2 与编辑历史、provider 侧 `accepts[1]`（state 为 current→old 分组映射、method args 为 old→current、method result 为 current→old）、watch 重绑时的一帧完整快照与后续映射 diff、job `accepts[1]` 的 args/result 均 old→current、旧运行在旧代码完成、v2 `finish` 收到映射结果、`running` 条目的 `version: 1` 与映射后 args、契约方法名 `start`/`running` 与 `arr(unknown())`。实际输出与导读一致，运行 id 为随机 UUID。

### slice 7c：插件目录、构建与 rollout

- packages/chord/test/examples/35-plugins/main.ts：完整。补全导读：三个插件目录与清单、复制到 `mkdtemp` 临时目录后再改 `label.ts`、`createPlugins({ roots, kinds, onError })`、`plugins.load` 的 LoadReport、`plugins.state` 的 dirty/install/set 标记、`plugins.build` 的普通数据 `Built`、`plugins.step` 捕获主机 kind、`plugins.rollout` 按 server → worker 发布并在拒绝时停止、摘要未变时复用 facet 与对象不重启、末尾清理不是 `finally`。实际输出与导读一致：`notes: v1 count 1 | index: v1` → `v2`，`count` 仍为 1，`clock untouched: true`，rollout 后 dirty 清空。
- packages/chord/test/examples/35-plugins/plugins/contracts/contract.ts：完整。说明仅契约插件没有 facet、发现结果为空 facet 列表、其源码被相对导入并内联进其他插件脚本；核对 `hostKind("example.worker")`、`remote("example.notes", { version, params, hostAddress, variants })` 的 `method(undefined, int())`、`local("example.index"/"example.clock")` 的 members。契约在 app 与插件两侧同名同版本才能绑定。
- packages/chord/test/examples/35-plugins/plugins/clock/server.ts：完整。说明清单名、仅 server facet、模块求值时取一次 `new Date().toISOString()`、`defineFacet((host) => host.serve(Clock, () => ({ evaluatedAt: constant(evaluatedAt) })))`、摘要未变时复用同一 facet 故对象不重启。对应输出 `clock untouched: true`。
- packages/chord/test/examples/35-plugins/plugins/notes/label.ts：完整。说明它是非 facet 共享模块、被 server/worker 两个入口静态导入并各自内联、示例只改临时副本、`const label = "v1"` 的字面量类型是编译期信息。watcher 依据上次构建的文件输入把 `@example/notes` 标脏。
- packages/chord/test/examples/35-plugins/plugins/notes/server.ts：完整。说明同一插件有两个 kind 的 facet、本文件只服务 `Index`、`host.serve(Index, () => ({ label: constant(label) }))`、旧 facet 闭包捕获旧 label、重新构建并 reload 后才变 v2。
- packages/chord/test/examples/35-plugins/plugins/notes/worker.ts：完整。说明 worker facet 服务远程 `Notes`、`defineState("count", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) })` 为非持久化单例文档、`self.state(Count)` 句柄与 `.value` 快照、`count.change` 事务自增、`add` 返回提交后计数。实际输出 `count 1` 在 rollout 前后保持。

## 未修改的数据/配置文件

- packages/chord/test/examples/35-plugins/plugins/clock/package.json：未改。读取者为 `createPlugins` 的发现逻辑与 Node ESM 解析；内容提供插件身份 `name: "@example/clock"`、`private: true`、`type: "module"`，并决定该目录只有 server facet。用途已写入同目录 `server.ts` 的文件导读。
- packages/chord/test/examples/35-plugins/plugins/contracts/package.json：未改。提供插件身份 `name: "@example/contracts"`、`private: true`、`type: "module"`；目录没有 facet 文件，因此被发现为“仅契约”插件而不会被装载。用途已写入同目录 `contract.ts` 的文件导读。
- packages/chord/test/examples/35-plugins/plugins/notes/package.json：未改。提供插件身份 `name: "@example/notes"`、`private: true`、`type: "module"`；同一清单覆盖 `server.ts` 与 `worker.ts` 两个 facet。用途已写入同目录 `server.ts`、`worker.ts`、`label.ts` 的文件导读。
- 未改动 `docs/learning/pi/study-coverage.json`、`docs/learning/pi/STUDY_PROGRESS.md`、`docs/learning/pi/STUDY_LOG.md`、`docs/learning/pi/SESSION_PLAN.md`，未修改其他代理的报告或本组清单外的文件。

## 未完成或风险

- 未运行 `npm run check`、`npm run build`、全仓格式化、`./test.sh` 或完整 vitest 套件；任务禁止前几项，也未要求完整套件。因此没有 TypeScript 类型检查。示例以 `--experimental-strip-types` 直接运行源码，只验证运行时行为；文中签名通过阅读 `packages/chord/src` 与 `packages/chord/docs/slice-*.md` 核对。
- 33-reload.ts 的原始英文注释称 staging 错误会“rejects the reload and changes nothing”，与当前实现和实测不符：`host.reload` 仍以 failed 报告 resolve，旧代码保留，但本次 facet 集合中缺失的插件仍被移除，native 以 `end` 关闭，holder 回到 waiting。按任务要求未改动原始英文注释，已在文件导读中用中文说明实际行为并指向 host 文档与测试。
- 35-plugins 的 watcher 标记依赖文件事件时序与平台：本机在首次 `load` 前后就收到 clock 目录/清单的事件，因此步骤 2 的 dirty 额外含 clock，`built` 也包含 clock/server。示例真正依赖的是 load 失败为 0、notes/index 变为 v2、count 保持 1、clock 对象未重新求值；文件头与行内注释已注明不要把精确的 dirty/install/set 集合当作协议。曾用临时脚本确认这些标记在 `writeFile` 之前已经出现。
- 25 的 `archive: 772 bytes` 随归档格式版本变化，导读已注明 seq 与计数才是断言；28 的 abort/finish 行序、31/32 的毫秒数与相邻行次序、34 的运行 UUID 均随调度或运行变化，导读已注明。
- 21、22、25、28 依赖 Node 的 `node:sqlite`（Node 22+）；未在旧版 Node、Windows 或浏览器环境验证。29、30、31、32、33、34、35 使用内存链路与进程内宿主，未覆盖真实 IPC/WebSocket/浏览器插件构建。
- 本组只写入了清单内 18 个 TS 文件与这份报告；未执行 `git add/commit/push`、`npm install`，未改动其他代理正在修改的文件。
