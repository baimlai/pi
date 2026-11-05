# 组 e08

状态：完成

## 完成文件

本组 20 个文件均为 `packages/chord/test/examples` 下的 TypeScript 示例。全部补全“文件导读”与逐行中文注释；原有英文文档、代码、字符串、类型、默认值与缩进保持不变。`git diff --numstat` 显示 20 个文件全部只有新增行、删除数为 0；`git diff --check` 退出码为 0。

最终验证在 `packages/chord` 下执行（等价循环，逐文件运行；全部退出码为 0）：

```text
for f in 01-objects 02-documents 03-derives 04-watches 05-errors \
         06-natives 07-failures 08-remote 09-calls 10-drops \
         11-linger-and-retry 12-routes 13-relay 14-flow-control \
         15-revocation 16-presence-and-activity 17-limits-and-compression \
         18-routines 19-jobs 20-tables; do
  node --conditions=source --experimental-strip-types test/examples/$f.ts
done
```

### 01-05（slice 1）

- packages/chord/test/examples/01-objects.ts：完整。新增文件导读（原有行内中文注释已存在）。核对 `local` 的 `version`/`params`/`members`、`defineFacet`/`host.serve` 的工厂声明、`constant`、`host.get`/`release`、`isChordError`。运行输出与导读一致：Clock 在 load 时创建；Greeter 首次 get 创建；错误参数输出 `refused: args args/name: expected string, got integer`；释放后输出 `example.greeter: released`。
- packages/chord/test/examples/02-documents.ts：完整。核对 `defineState` 单例与 `keyed: true`、`self.state`、`self.tx`/`tx.draft`、`todos.value`、`notes.get`/`keys`、`retire`。运行输出 `todos` 两项、备注正文与清空后的 `{ items: [], next: 1 } (none)` 均符合。
- packages/chord/test/examples/03-derives.ts：完整。核对 `self.derive` 的源数组与同步计算、`mapShared` 的 WeakMap 身份缓存、`self.get` 跨对象依赖。运行输出两次 titles 与三次 `title computed` 行证明惰性与缓存行为。
- packages/chord/test/examples/04-watches.ts：完整。核对 `watchable.watch`/`start`/`closed`、通知的 `value`/`failed` 分支、忙监听器折叠、`withCancel`、`derive_failed` 报告、`release` 结束观察。运行输出包含 `half failed`、恢复后的根替换、`double watch: { kind: 'aborted' }`、`count watch: { kind: 'ended' }`；文件头已注明监听器异步导致行序可能变化。
- packages/chord/test/examples/05-errors.ts：完整。核对 `isChordError`、`HostError` 的 `activation_failed`、`readyTimeout` 选项，以及实际错误代码：`invalid/args`、`invalid/params`、`invalid/cycle`、`unavailable`、`contract_mismatch`、`released`、`released/closed`。运行输出的 13 行与导读逐条一致。

### 06-11（slice 2、3a、3b）

- packages/chord/test/examples/06-natives.ts：完整。核对 `self.open(open, close, options?)`、打开顺序与逆序关闭、`NativeCloseReason`（`end`/`close`/`reload`）、`NativeOptions.closeTimeout`、`not_ready` 与 `AggregateError`。补注释后重跑退出 0，输出不变；对应 test/host/native.test.ts。
- packages/chord/test/examples/07-failures.ts：完整。核对瞬时失败与 `broken(error)`、1s/2s/4s…上限 60s 的退避、host 与单次 get 的 `readyTimeout`、依赖停车（`waiting`）与 `unavailable`。重跑退出 0；对应 backoff.test.ts、attempt.test.ts、parked.test.ts。
- packages/chord/test/examples/08-remote.ts：完整。核对 `hostKind`、`Address`、`remote({ hostAddress, variants })`、`memoryLinkPair`、`accept`/`connect` 与 principal 盖章。重点确认实际 API 是 `hostAddress`，不是 slice 文档早期措辞 `placement`；注释按 src 真实签名书写。重跑退出 0。
- packages/chord/test/examples/09-calls.ts：完整。核对远端方法调用、参数校验、`ctx.principal`、变体选择及调用跨链路的错误传播。重跑退出 0；对应 test/remote/calls.test.ts。
- packages/chord/test/examples/10-drops.ts：完整。核对 `RefState`（`loading`/`live`/`failed {cause, retryAt}`/`ended {error}`）、`ref.state`、re-hold、release 与链路断开后的行为。重跑退出 0；对应 hold.test.ts、replica.test.ts、ref-state.test.ts。
- packages/chord/test/examples/11-linger-and-retry.ts：完整。核对 `ref.retry()`、`host.serve(..., { linger })`、最后引用释放后的保留期与重新获取。重跑退出 0；对应 retry-on.test.ts、ref-state.test.ts、native.test.ts。

### 12-18（slice 4a、4b、5）

- packages/chord/test/examples/12-routes.ts：完整。核对 `host.route(kind, { authorize, resolve }, ctx)`、路由后的引用与调用、worker 的 `connect` 与 server 的入口链路。重跑退出 0；对应 test/host/route.test.ts、test/remote/path.test.ts、relay.test.ts。
- packages/chord/test/examples/13-relay.ts：完整。核对 `ipcLink`、`webSocketLink`、中继转发、`describeMessage`/编码与关闭传播。重跑退出 0；对应 test/link/ipc.test.ts、websocket.test.ts、test/remote/relay.test.ts。
- packages/chord/test/examples/14-flow-control.ts：完整。核对窗口 K=2、provider 折叠 pending、ack 释放名额、relay 按 origin 转发并回传 ack、快慢 tab 隔离；确认 `Link` 的 `send`/`onMessage`/`close`/`onClose` 四个方法与 `binaryCodec.decode`。重跑退出 0；对应 provider.test.ts、host-link.test.ts、relay.test.ts、link/message.test.ts。
- packages/chord/test/examples/15-revocation.ts：完整。核对 `createHost<P, Revocation>({ revokedBy })`、`host.revoke`、跨 route 传播、`forbidden/revoked`、调用方 `unavailable`、`host.references` 与“不重放”。重跑退出 0；对应 test/host/revocation.test.ts、test/remote/host-link.test.ts。
- packages/chord/test/examples/16-presence-and-activity.ts：完整。核对 `host.references(Type)` 的每条引用 `{ params, principal, incarnation }`、主键与 principal 共享对象、`host.activity` 的 `references/calls/jobs/lingering` 微任务发布。重跑退出 0；对应 presence.test.ts、activity.test.ts。
- packages/chord/test/examples/17-limits-and-compression.ts：完整。核对 `PartLimits { part, decoded }`、`Compression`、`nodeCompression`、16 KiB 压缩阈值、`too_large/part` 只失败当前 hold/call、客户端上行不压缩、server 子链路拒绝压缩分片。重跑退出 0；对应 test/link/part.test.ts、test/node/compression.test.ts。
- packages/chord/test/examples/18-routines.ts：完整。核对 `self.on(source, fn)` 的 `{ value, ops }`、首次根替换 `[["r", value]]`、`routine_failed`、1s 起翻倍退避、`self.onLive` 与 `sleep(ms, ctx)` 的取消。重跑退出 0；对应 routines.test.ts、sleep.test.ts、follow.test.ts。

### 19-20（slice 5、6a）

- packages/chord/test/examples/19-jobs.ts：完整。核对 `defineJob` 的 `version/args/result/state/concurrency`、`self.job` 的 `run`/`finish` 三段式、`JobHandle.start/abort/running`、`RunningEntry` 的 `running`/`finishing`/`blocked` 形状、`Outcome` 与 `JobError`、`RunState.change(fn, ctx, options?)`、`OutputBuffer({ maxBytes, maxLines, retain })`、`Progress` 的 `mark`/`stop` 与按返回字节数摊开提交。实际输出：重发去重为 true；owner 看到 `output`、guest 看不到；第二次 start 被并发限额拒绝；首次完成后 entries 为 shell 摘要 + notify 结果；abort 后为 `tail -f log: interrupted (aborted), 3 lines kept` + notify；`running now: []`。
- packages/chord/test/examples/20-tables.ts：完整。核对 `defineTable` 的扁平列/默认值/`opt`/主键/索引、`openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), ctx)`、`self.table`、不可变 `query().where().orderBy()`、`tx.put`/`tx.update`/`tx.updateWhere`、`Table.page/get/count` 与不透明游标、`store.close`。实际输出：`hits of e1: 2`；第一页 `[ 'e3' ]`；第二页 `[ 'e1' ]`；`finished: 3`。

## 未修改的数据/配置文件

本组清单只包含 `.ts` 示例文件，没有 JSON、YAML 或其他数据/配置文件需要注释，也没有修改任何此类文件。未改动 `docs/learning/pi/study-coverage.json`、`STUDY_PROGRESS.md`、`STUDY_LOG.md`、`SESSION_PLAN.md` 或其他代理的报告；未触碰清单外的 `packages/chord/test/examples/LEARNING.md`。

## 未完成或风险

- 未运行 `npm run check`、`npm run build`、全仓格式化、`./test.sh` 或完整 vitest 套件：任务明确禁止前几项，也未要求完整套件。因此没有 tsc 类型检查；类型签名通过阅读 `packages/chord/src` 核对，示例用 `--experimental-strip-types` 直接运行源码，不做类型检查。
- 所有示例均已实际运行且退出码为 0；06-18 在补注释后重跑，01-05、19-20 在最终修改后重跑。输出中的时间、UUIDv7 运行 id、incarnation 后缀、压缩字节数/毫秒数与并发监听器行序会随机器调度变化，文件头已注明。
- `remote` 的真实选项是 `hostAddress`，slice 文档早期使用了 `placement` 这一措辞；注释以 src 与可运行代码为准，避免把旧措辞当成 API。
- 19 的 `abortShell` 使用模块级后台 `context` 并 `void` 丢弃 `abort` 结果，因此远程调用在标记完成前就返回；这是示例的选择，注释已说明，不代表 abort 已同步完成。
- 13（IPC）与 17（压缩计时）依赖运行时环境；本机运行通过，但未在 Windows 或浏览器环境验证。20 使用 `:memory:` SQLite，未覆盖文件数据库、迁移或并发提交。
- 工作区同时有其他代理修改文件；本组只在 e08 清单的 20 个示例与这份报告中写入，未执行任何 Git 暂存、提交或推送。
