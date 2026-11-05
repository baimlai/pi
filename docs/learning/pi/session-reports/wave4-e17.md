# 组 e17

状态：完成

范围：`/tmp/pi-groups/e17.txt` 列出的 34 条路径。31 个源码文件已加中文学习注释，其中 3 个 `package.json` 按要求不修改，其作用写在同目录 TS 文件头中。改动均为新增注释行，未改动、移动或删除任何既有代码行。

## 完成文件

核对方式：每个文件均通读全文，逐一对照 `packages/chord/src` 中的真实签名与调用方；60-session-sync 另用可运行示例验证行为。表中“核对内容”列出该文件注释依赖的关键 API 或运行时事实。

### 56-web（12 个）

| 文件 | 完整度 | 核对内容 |
| --- | --- | --- |
| `packages/chord/test/examples/56-web/app/principals.ts` | 完整 | `BoardPrincipal` 联合类型；`authorize` 的实际判别字段 |
| `packages/chord/test/examples/56-web/app/v1.ts` | 完整 | app v1 契约方法签名及 web/tui 两侧调用方 |
| `packages/chord/test/examples/56-web/app/v1/tui.ts` | 完整 | `Lines` 注册表类型；`tui/main.ts` 与 `plugins/notes/tui.ts` 的 `serve/compose` |
| `packages/chord/test/examples/56-web/app/v1/web.ts` | 完整 | `Panels` 注册表类型与 web 侧贡献方 |
| `packages/chord/test/examples/56-web/headless.ts` | 完整 | `startClient` 选项、`WebScripts`、`webSocketLink`、`REGISTER`；`vm.Script.runInThisContext` 共享当前全局但看不到局部变量 |
| `packages/chord/test/examples/56-web/main.ts` | 完整 | `startServer`、`app.applyChanges`、`ownerLink`/`ownerTokenFile`、注册表读取 |
| `packages/chord/test/examples/56-web/plugins/clock/web.ts` | 完整 | web facet 形状与 `Panels` 贡献；同目录 manifest 作用 |
| `packages/chord/test/examples/56-web/plugins/notes/tui.ts` | 完整 | tui facet 与 `Lines` 贡献 |
| `packages/chord/test/examples/56-web/plugins/notes/web.ts` | 完整 | web facet 与 `Panels` 贡献；同目录 manifest 作用 |
| `packages/chord/test/examples/56-web/start.ts` | 完整 | app 定义、host kind、web/tui 入口、插件目录扫描 |
| `packages/chord/test/examples/56-web/tui/main.ts` | 完整 | `startTerminalRuntime`、`TuiScope`、`theme.onChange` 返回取消函数且示例未保存 |
| `packages/chord/test/examples/56-web/web/main.ts` | 完整 | web 入口 facet 与页面启动路径 |

### 57-tui（2 个）

| 文件 | 完整度 | 核对内容 |
| --- | --- | --- |
| `packages/chord/test/examples/57-tui/main.ts` | 完整 | `TuiScripts` 远程对象、`startTerminal` 启动参数、PassThrough 输入输出、退出码 |
| `packages/chord/test/examples/57-tui/terminal.ts` | 完整 | `requireSandboxNode`、owner token 文件凭据、终端启动与帧轮询 |

### 59-chat（13 个）

| 文件 | 完整度 | 核对内容 |
| --- | --- | --- |
| `packages/chord/test/examples/59-chat/app/principals.ts` | 完整 | user/worker 身份类型与 `authorize` 判别 |
| `packages/chord/test/examples/59-chat/app/v1.ts` | 完整 | `Room` 契约：`messages`、`post`、`history`、`begin/append/share` |
| `packages/chord/test/examples/59-chat/app/v1/server.ts` | 完整 | server facet、频道列表、登录入口与 HTTP 路由注册 |
| `packages/chord/test/examples/59-chat/app/v1/worker.ts` | 完整 | `Files.begin({ name, mime })`、`append({ upload, offset, bytes })`、4 MiB 分块上限 |
| `packages/chord/test/examples/59-chat/main.ts` | 完整 | ephemeral login、`createHost`/`webSocketLink`、表查询分页、HTTP `/files`、终端沙箱五步流程 |
| `packages/chord/test/examples/59-chat/plugins/chat/server.ts` | 完整 | 插件发现、web/tui facet 合并、频道页面 |
| `packages/chord/test/examples/59-chat/plugins/chat/worker.ts` | 完整 | `Room` 的 worker 端实现、持久化表与实时窗口 |
| `packages/chord/test/examples/59-chat/plugins/login.server.ts` | 完整 | ephemeral login facet 与 schema 校验边界 |
| `packages/chord/test/examples/59-chat/start.ts` | 完整 | `startChat`、`Channel({ id })` host kind、`address.key` 形如 `channel|general`；`principal.channel` 保存完整地址键且示例授权只看 kind |
| `packages/chord/test/examples/59-chat/tui/main.ts` | 完整 | 终端绘制、Tab/PgUp 输入、分块上传交互 |
| `packages/chord/test/examples/59-chat/web/main.ts` | 完整 | 浏览器端连接、窗口渲染与上传 |
| `packages/chord/test/examples/59-chat/web/style.css` | 完整 | 页面样式文件头与选择器分组说明 |
| `packages/chord/test/examples/59-chat/worker.ts` | 完整 | worker 入口、host kind 绑定与 worker store |

### 60-session-sync（4 个）

| 文件 | 完整度 | 核对内容 |
| --- | --- | --- |
| `packages/chord/test/examples/60-session-sync/session.ts` | 完整 | `defineTable` 键 `["n"]`、`defineState(persist:true)`、`self.table/state/tx`、`withSession` 生命周期；实测首次激活写表定义占 1 个提交 |
| `packages/chord/test/examples/60-session-sync/radius.ts` | 完整 | `applyBatch` 信任边界与整批事务、`outbox.read(floor, 10_000)`/`trim`、epoch 围栏、`importStore`/`decodeJsonl` |
| `packages/chord/test/examples/60-session-sync/sync.ts` | 完整 | 握手/bootstrap/pull、`export` + `encodeJsonl`、`importStore`、split 的 `origin`、`from/to` 取值 |
| `packages/chord/test/examples/60-session-sync/main.ts` | 完整 | 六步预期输出与实测一致；`shown` 穷尽 switch、`copyOf`、`atRadius` |

## 验证命令与结果

1. `git diff --numstat -- $(cat /tmp/pi-groups/e17.txt)`：31 个文件全部为新增/删除 `N/0`，合计新增 1446 行、删除 0 行；`git diff ... | rg '^-[^-]'` 无输出（无真实删除行）。3 个 `package.json` 无 diff。
2. 运行 60-session-sync（注释前后各一次，输出一致，退出码 0）：
   `cd packages/chord && node --conditions=source --experimental-strip-types test/examples/60-session-sync/main.ts`
   关键输出：步骤 1 `lastSeq 4 outbox floor 0`；步骤 2 上传 `1..4`；步骤 3 上传 `5..6` 且两侧 transcript 相同；步骤 4 s2 `lastSeq 3 outbox floor 3`、737 字节归档、随后 `4..4`；步骤 5 epoch 2、陈旧上传被 epoch 拒绝并 split 为 `s1~split@6`、1289 字节归档、log `empty after 7`；步骤 5b 无围栏时 `refused: batch: commit 0 (seq 7): does not follow seq 7` 后静默分叉；步骤 6 epoch 3、pull `7..7`、提交 8、log `1..8`、`same values: true`。
3. 为确认步骤 1 的 `lastSeq 4` 来源，曾用临时探针运行空 store 的首次激活/重命名/发言，确认首次激活会把表定义作为 seq 1 写入；探针文件已删除，未留在仓库。
4. 未运行：`npm run check`、`npm run build`、`npm test`、`./test.sh` 与仓库级格式化。按本组任务说明，这些仓库级检查不在本组执行范围。
5. 未运行 56-web、57-tui、59-chat 示例入口：它们会启动服务器、fork worker、用 esbuild 打包插件并启动终端沙箱，需要已构建的 `dist/` 或长驻进程，且不属于快速离线验证；因此这些文件的注释未经运行时/编译检查，仅经过逐行复核与源码签名对照。

## 未修改的数据/配置文件

- `packages/chord/test/examples/56-web/plugins/clock/package.json`：`{"name":"@board/clock","private":true,"type":"module"}`，作用写入 `plugins/clock/web.ts` 文件头。
- `packages/chord/test/examples/56-web/plugins/notes/package.json`：`{"name":"@board/notes","private":true,"type":"module"}`，作用写入 `plugins/notes/web.ts` 与 `plugins/notes/tui.ts` 文件头。
- `packages/chord/test/examples/59-chat/plugins/chat/package.json`：`{"name":"@chat/chat","private":true,"type":"module"}`，作用写入 `plugins/chat/server.ts` 与 `plugins/chat/worker.ts` 文件头。
- 未修改任何 `tsconfig.json`、锁文件、学习进度/覆盖率数据（`STUDY_PROGRESS.md`、`study-coverage.json`、`STUDY_LOG.md`、`SESSION_PLAN.md`）或其他代理的报告。

## 未完成或风险

- 56-web、57-tui、59-chat 未实际运行，若注释存在语法级问题，只有静态复核保障；60-session-sync 的四份文件已由示例运行覆盖。
- 未运行 `npm run check`，因此未获得类型检查与格式化结果；注释只依赖已核对的源码签名，但若后续上游签名变化，文件头中的签名示例需要同步更新。
- 60-session-sync 的注释固定了当前实现的提交计数（激活写表定义、每次 say/rename 一个提交）与输出数值；实现改动后需重跑示例并更新。
- 59-chat 注释中 `address.key` 含 kind（`channel|general`）、`Files.begin` 参数为 `{name,mime}` 等事实来自当前源码；示例里的 `principal.channel` 字段未被授权逻辑使用，已在注释中说明。
