# 组 g13

状态：完成

## 完成文件

全部 27 个文件均已补齐中文学习注释，并按要求扩写文件头（所属模块、职责边界、上下游、导出能力清单、组合顺序、真实签名示例、阅读顺序）。逐个核对了主要 callee/类型；`git diff --numstat` 与 `git diff --unified=0` 检查均为纯新增，共 975 insertions、0 deletions，`git diff --check` 无空白错误。

- packages/chord/src/node/surfaces/bundle.ts：完整；核对 esbuild `build`、`BaseBundle`/`ServedFile`；文件头、类型与构建选项说明已补齐。
- packages/chord/src/node/surfaces/current.ts：完整；核对 `local`/`method`、`ScriptSet`、`WebScripts`/`TuiScripts`、`Host.serve`。
- packages/chord/src/node/surfaces/index.ts：完整；核对全部重导出项；文件头扩写。
- packages/chord/src/node/surfaces/published.ts：完整；核对 `Plugins.scripts/current`、`RolloutStep`、`registeredSource`、`publishTo`。
- packages/chord/src/node/surfaces/served.ts：完整；核对 `HttpResponse` 的 bytes 响应与 `ServedFile`；MIME 常量说明补齐。
- packages/chord/src/node/surfaces/tui.ts：完整；核对 `buildBase`、`PublishedScripts`、`scriptsFacet`、Http 路由。
- packages/chord/src/node/surfaces/web.ts：完整；核对 `webRoutes`/`pageAssets`/`bootstrap`/`pageScripts`、Http CSP 与 scripts 来源。
- packages/chord/src/tui/bridge.ts：完整；核对 bootstrap 注入的 Bridge、`pipe.ts` 帧校验；逐类型/字段与消息分支说明。
- packages/chord/src/tui/channel.ts：完整；核对 `LinkEnd`、`pipe.ts` 沙箱消息校验、调用方 runtime；请求/回复/socket 流程说明。
- packages/chord/src/tui/frames.ts：完整；核对 launcher 64 KiB 丢弃线与 UTF-16/转义序列切分逻辑。
- packages/chord/src/tui/index.ts：完整；核对全部导出项；文件头扩写。
- packages/chord/src/tui/runtime.ts：完整；核对 `startClient`、`TuiScripts`、`SandboxScripts`、`followActiveTheme`、`takeBridge`。
- packages/chord/src/tui/scope.ts：完整；核对 `Held`、`Host.hold/registry`、`Watchable.watch`、`withAbortSignal`。
- packages/chord/src/tui/terminal.ts：完整；核对 `SandboxChannel` 的 write/onInput/onResize 与尺寸更新顺序。
- packages/chord/src/tui/theme.ts：完整；核对 `terminalColor`、`ColorDepth`、`Theme`；SGR 行为说明。
- packages/chord/src/telemetry-sqlite/index.ts：完整；核对 pi-telemetry 接口、sqlite 迁移/事务、store 查询；Recorder 缓冲/批量写入/失败路径逐段说明。
- packages/chord/src/telemetry-sqlite/store.ts：完整；核对 `TraceQuery`/`MetricQuery`、SQLite json_each/json_extract、游标分页。
- packages/chord/src/web/environment.ts：完整；核对 `LoopEnvironment` 与 DOM 事件；文件头扩写。
- packages/chord/src/web/index.ts：完整；文件头扩写并说明导入无启动副作用。
- packages/chord/src/web/page.ts：完整；核对 `PageOptions`、`startClient`、`PageScripts`、`followThemes`、`serverBase`。
- packages/chord/src/web/scripts.ts：完整；核对 `PageBootstrap`、`RegisteredScript`、`ScriptSet`、`REGISTER` 与 DOM 加载流程。
- packages/chord/src/web/themes.ts：完整；核对 `followActiveTheme`、`themeVariables`、`matchMedia` 清理。
- packages/chord/src/react/hooks.ts：完整；核对 React hooks、`canonicalJson`、`Host.hold/registry`、`watchStore`。
- packages/chord/src/react/index.ts：完整；文件头扩写。
- packages/chord/src/react/stores.ts：完整；核对 `useSyncExternalStore` 契约与 `Watchable`/`NativeWatchable`。
- packages/chord/src/context/index.ts：完整；核对 pi-telemetry span、`AbortSignal.any`、`withCancel`/`awaitWithContext`；类型擦除与断言说明。
- packages/chord/src/node/compression.ts：完整；核对 `Compression` 接口、zlib `maxOutputLength` 与 `ERR_BUFFER_TOO_LARGE`。

## 测试

在 `packages/chord` 下运行：

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/tui/frames.test.ts test/tui/scope.test.ts \
  test/node/surfaces/tui.test.ts test/node/surfaces/web.test.ts \
  test/node/react/hooks.test.ts test/node/react/stores.test.ts \
  test/node/web/page.test.ts test/context.test.ts \
  test/telemetry-sqlite.test.ts test/telemetry-sqlite-store.test.ts \
  test/node/compression.test.ts
```

结果：9 个测试文件通过，2 个测试文件跳过；64 个测试通过，3 个测试跳过（67 个）。

- 跳过：`test/node/web/page.test.ts`（2 个）与 `test/node/react/hooks.test.ts`（1 个），原因是 `describe.skipIf(CHROMIUM === undefined)`，本机没有测试所需 Chromium。
- 首次批量运行时 `test/tui/scope.test.ts` 的“holds, follows ...”曾超时失败一次；单独重跑和随后完整重跑均通过。该文件只增加了注释行，之后未再复现，按环境时序抖动记录，不视为通过一次即忽略。

## 未完成或风险

- 按任务约束未运行 `npm run check` / `npm run build` / 全仓格式化，也未暂存、提交或推送。
- 未改 `STUDY_PROGRESS.md`、覆盖清单、日志或其他代理报告。
- Chromium 相关浏览器测试未执行（环境缺 Chromium），只能确认源码测试与 Node 侧 surfaces/telemetry 测试通过。
- 注释只新增，不改变行为；但未做独立语义复读的逐行外部审计，风险主要是注释措辞与未来代码变更不同步。
