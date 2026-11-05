# 组 g02

状态：完成

## 完成文件

- packages/chord/src/host/reference-source.ts：完整。核对了 `ReferenceSource` 的状态/订阅/失败/`last` 语义、`DeriveSource`、`Source`/`Constant`、watch 取消与批次断言；文件头含功能导读。测试：`test/host/reference-source.test.ts` 随组批运行通过（197 项批次中的一部分）。
- packages/chord/src/host/reference.ts：完整。核对了 `Target`、`BindingState`/`RefState`/`Failed`/`Ended`/`LOADING`、`ReferenceState`、`ReferenceKeys`、`ParkedCalls`、`withLinkedAbortSignal`、`currentVariants`/`takesNoArgs`、`Keyed`/`Singleton`/`Source`/`Constant`；为全部类型、Binding 方法、三个成员句柄类和 `place`/`resolveKeyed`/`resolveWatchable` 补齐中文注释与行内说明。测试：`test/host/reference.test.ts` 30 项通过；`reference-keys`、`reference-source` 等在批次中通过。
- packages/chord/src/host/retry-on.ts：完整。核对了 `RetryOn` 声明、`Target.retry` 遍历与 DONE 判定；文件头含功能导读。测试：`test/host/retry-on.test.ts` 随组批通过。
- packages/chord/src/host/revocation.ts：完整。核对了撤权 key 的规范 JSON、`RevokedBy`、unbound 索引与引用终止路径；文件头含功能导读。测试：`test/host/revocation.test.ts` 随组批通过。
- packages/chord/src/host/root.ts：完整。核对了 `host.root` 调用作用域、链接式 abort、已释放引用检查；文件头含功能导读。测试：`test/host/root.test.ts` 12 项通过。
- packages/chord/src/host/route.ts：完整。核对了 `RouteOptions`/`RouteHandle`、`Path`/`PathEvent`、`HostLink`、`routeLink`、握手与暂停/重试状态；文件头含功能导读。测试：`test/host/route.test.ts` 随组批通过。
- packages/chord/src/host/routines.ts：完整。核对了 `OnRoutine` 状态机、watch/native watchable、`Routines` 声明与 `Basis` 帧；文件头含功能导读。测试：`test/host/routines.test.ts` 随组批通过。
- packages/chord/src/host/sleep.ts：完整。核对了 `Context.abortSignal`、分段 `setTimeout`、监听器清理与 `MAX_TIMER` 边界；文件头含功能导读。测试：`test/host/sleep.test.ts` 随组批通过。
- packages/chord/src/host/staging.ts：完整。核对了 `StagedPlugin`、`RecordingSelf` 的记录/断言、`INERT` Proxy、`recordFactory` 的 `self` 转换与 `hostLifetime`；文件头含功能导读。测试：`test/host/staging.test.ts` 随组批通过。
- packages/chord/src/host/unbound-clock.ts：完整。核对了重试计时与取消清理；文件头含功能导读。测试：`test/host/unbound-clock.test.ts` 随组批通过。
- packages/chord/src/host/unbound.ts：完整。核对了 unbound 索引、发布门、wake/place/leave 与撤权遍历；文件头含功能导读。测试：`test/host/unbound.test.ts` 随组批通过。
- packages/chord/src/host/uuid.ts：完整。核对了 UUIDv7 位布局、bigint 序列、时间回拨与序列耗尽错误；文件头含功能导读。测试：无同名测试文件，未单独运行；由 `test/host/host.test.ts` 间接导入，该测试 87 项通过。
- packages/chord/src/store/adapter.ts：完整。核对了 `StoreOwnerTables`、`CommitFence` 字面量、`OwnerTable` 的编码/版本 JSON/`prepareFirst` 改写；文件头含功能导读。测试：无同名测试，随 `test/store/table-handle.test.ts` 等间接导入，该测试 8 项通过。
- packages/chord/src/store/allocator.ts：完整。核对了 `FIRST_ID`、`mint`/`raise`/`value` 的饱和与耗尽行为；文件头含功能导读。测试：`test/store/allocator.test.ts` 随组批通过。
- packages/chord/src/store/applier.ts：完整。核对了 `Diverged`、`applyWrite`、行数核对、目录/文档写入与 where 校验；文件头含功能导读。测试：`test/store/applier.test.ts` 随组批通过。
- packages/chord/src/store/apply-batch.ts：完整。核对了 `applyBatch` 信封校验、`replay` 的 seq 连续性、`checkCreated` 与分叉标记；文件头含功能导读。测试：`test/store/apply-batch.test.ts` 随组批通过。
- packages/chord/src/store/archive.ts：完整。核对了 `ARCHIVE_FORMAT`、part/write schema、`checkPart`/`checkWrite` 与 `validatorFor`；文件头含功能导读。测试：`test/store/archive.test.ts` 随组批通过。
- packages/chord/src/store/backend.ts：完整。核对了 `Backend.db` 的所有权转移与 `sqliteBackend` 包装；文件头含功能导读。测试：无同名测试，未单独运行；由 store 测试间接导入。
- packages/chord/src/store/catalog.ts：完整。核对了 `TableRecord`、`readCatalog` 的 JSON 解析、`writeCatalog` 的 OR REPLACE 语义；文件头含功能导读。测试：`test/store/catalog.test.ts` 随组批通过。

测试命令与结果（均在 `packages/chord` 下执行）：

- `node <repo>/node_modules/vitest/dist/cli.js --run test/host/reference.test.ts`：1 文件 / 30 项通过。
- `... --run test/host/host.test.ts`：1 文件 / 87 项通过。
- `... --run test/host/reference-source.test.ts reference-keys route routines staging revocation unbound unbound-clock retry-on sleep`：10 文件 / 197 项通过。
- `... --run test/host/root.test.ts`：1 文件 / 12 项通过。
- `... --run test/store/allocator.test.ts applier apply-batch archive catalog`：5 文件 / 31 项通过。
- `... --run test/store/table-handle.test.ts`：1 文件 / 8 项通过。
- 合计 19 个测试文件、365 项全部通过。

## 自查记录

- `packages/chord/src/store/archive.ts`：注释过程中曾误把 `const INDEX = obj({ kind: lit("index"), ... })` 的 `lit("index")` 写成字符串 `"index"`；已恢复原始代码行。当前 `git diff -U0` 无删除行，新增行过滤后全部为注释或空行，`grep` 确认该行仍为 `kind: lit("index")`。
- `packages/chord/src/host/reference.ts`：曾误把 `KeyedMemberAt` 构造器里的 `this.member = member` 写成 `this.#member = member`，触发未声明私有名的语法/检查错误；已恢复。当前无删除行，新增行全部为注释或空行，`this.member = member` 已还原；`reference.test.ts` 30 项通过。
- 全部 19 个文件 `git diff --numstat` 的删除数均为 0；逐行过滤新增内容后，非注释非空行数量为 0。仅新增 2 个空行，均位于文件头注释与后续声明之间。

## 未完成或风险

- 未运行 `npm run check`、`npm run build` 或全仓格式化：任务明确禁止。
- `backend.ts`、`adapter.ts`、`uuid.ts` 无同名专用测试，未单独运行；仅由已运行的 host/store 测试间接导入，不能据此断言其所有分支均被覆盖。
- 本组测试运行期间其他并行代理正在修改其他 Chord 文件；本次结果只代表运行时的代码状态，不覆盖其未完成改动可能引入的后续问题。
- 注释只描述已核对的当前实现；未对设计文档中尚未实现的 slice 行为作推断。
