# 组 g06

状态：完成

## 完成文件

全部 20 个文件均已完整阅读并补齐中文学习注释；每份文件头覆盖所属模块、职责边界与上下游、能力清单、组合与典型顺序、可运行示例、阅读顺序。测试文件（如有）另有被测模块、fixture/fake、覆盖行为分组与运行命令说明。

- packages/chord/src/node/tui/actions.ts：完整；核对 `BridgeRequest`、`act` 的 attach/copy/open 分支、`realpath`/`stat`/`open` 语义；修复重复 import 块（仅保留原有 import 行，注释移到原 import 上方），解码被转义的中文注释。esbuild 解析通过。
- packages/chord/src/node/tui/credentials.ts：完整；核对写入路径、权限与调用方；esbuild 通过。
- packages/chord/src/node/tui/filter.ts：完整；核对 OSC/控制序列过滤逻辑与调用方；esbuild 通过。
- packages/chord/src/node/tui/index.ts：完整；核对导出面与 launcher/sandbox 的关系；esbuild 通过。
- packages/chord/src/node/tui/launcher.ts：完整；核对 `startTerminal`、`#startSandbox`、`#handle`、`#answer`、`#confirm`、`#openSocket`、`#write`、`#prompt`、重连与 Ctrl-C 规则。修复协调者指出的语法错误（`attach` 分支后多出的 `}` 导致 `Expected "finally" but found "else"`），并去除重复 import 块；`git diff` 确认无新增/删除 import 行。esbuild 解析通过。
- packages/chord/src/node/tui/pipe.ts：完整；核对长度前缀帧编解码与沙箱调用方；esbuild 通过。
- packages/chord/src/node/tui/sandbox.ts：完整；核对 `spawn`、临时 bootstrap、vm 执行、内建模块白名单与 fake process；esbuild 通过。
- packages/chord/src/index.ts：完整；核对公共导出面；esbuild 通过。
- packages/chord/src/json.ts：完整；核对 `JsonValue`/`JsonRepresentation` 与严格 JSON 校验边界；恢复被误删的 `export type JsonValue` 原行。esbuild 通过。
- packages/chord/src/output.ts：完整；核对 OutputBuffer 的 head/tail 保留、UTF-8 切片、清洗与 Progress；解码转义中文注释，未改动正则代码行。esbuild 通过。
- packages/chord/src/watch.ts：完整；核对 WatchEnd/WatchCall/NativeWatchCall、WatchHandle 与 WatchLifecycle 串行投递；恢复被误删的 `withoutAbortSignal` import 原行。esbuild 通过。
- packages/chord/src/surfaces/active-theme.ts：完整；核对 `followActiveTheme`、系统模式监听与清理；esbuild 通过。
- packages/chord/src/surfaces/client.ts：完整；核对 `startClient`、`Client`、`connect`、`SharedClose`、`entryOf`、`Updates.follow/stop/#apply` 及失败/中止语义；esbuild 通过。
- packages/chord/src/surfaces/connection.ts：完整；核对退避常量、`keepConnected`、`Attempt`、`Loop.connect/#closed/#schedule/#wake` 的定时器与唤醒分支；esbuild 通过。
- packages/chord/src/surfaces/index.ts：完整；核对导出面；esbuild 通过。
- packages/chord/src/surfaces/loaded.ts：完整；核对 `Prepared`、`SetEntry`、`LoadedFacets.load/reload/#reload/#adopt`、`committedOf` 的 aborted-after-commit 语义；esbuild 通过。
- packages/chord/src/surfaces/registered.ts：完整；核对插件脚本注册契约；esbuild 通过。
- packages/chord/src/surfaces/scripts.ts：完整；核对 `ScriptType` 契约与运行时 schema 校验边界；esbuild 通过。
- packages/chord/src/surfaces/theme-choice.ts：完整；核对 `ThemeChoice`、`Picks`、`PickStore`、`principalKey` 与最近选择淘汰逻辑；esbuild 通过。
- packages/chord/src/surfaces/themes.ts：完整；核对 `BASE_ROLES`、`Theme`、`Themes`、`themesFacet`、`FALLBACK_THEMES`、`activeTheme`、`themeVariables`、`terminalColor`、`parseHex`、`nearest256`；esbuild 通过。

验证：

- `git diff --numstat`：20 个文件全部为新增行、0 删除行；`git diff` 中无新增 import 行，无重复 import。
- 新增内容只包含 `//` 学习注释、新增 JSDoc 注释块与为分隔注释插入的空行；无代码行改动。
- 无 `【中文学习】`/`【学习】`/`中文导读`/`中文主线` 前缀；无残留 `\uXXXX` 转义中文注释。
- 20 个文件逐个通过 `./node_modules/.bin/esbuild <file> --loader:.ts=ts --format=esm` 解析。
- 未运行 `npm run check`、`npm run build`（任务禁止）。

测试：

- `node node_modules/vitest/dist/cli.js --run test/json.test.ts test/output.test.ts test/output-skip.test.ts test/watch.test.ts test/surfaces/client.test.ts test/surfaces/connection.test.ts test/surfaces/themes.test.ts test/surfaces/active-theme.test.ts test/surfaces/registered.test.ts`：9 个文件、100 个测试全部通过。
- `node node_modules/vitest/dist/cli.js --run test/node/tui/filter.test.ts test/node/tui/pipe.test.ts test/node/tui/credentials.test.ts`：3 个文件、9 个测试全部通过。

## 未完成或风险

- packages/chord/src/node/tui/launcher.ts、packages/chord/src/node/tui/sandbox.ts：相关测试未运行。环境无 `node26` 可执行文件，且测试会启动 Node 子进程并需要已构建的 `dist/`；`npm run build` 被任务禁止。注释为纯新增，未改变行为。
- packages/chord/src/node/tui/actions.test.ts：运行后 16 通过、3 失败。失败点为 macOS `/private/var` 与 `/var` 的 realpath 提示文本不一致、FIFO 用例返回 null 而非拒绝；属于本机路径/文件系统差异。该文件注释改动为纯新增、0 删除，未修改逻辑；不宣称这些用例通过。
