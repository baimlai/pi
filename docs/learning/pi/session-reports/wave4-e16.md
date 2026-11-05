# 组 e16

## 状态

完成。18 个受控代码文件均已添加中文学习注释；3 个受控 JSON 文件未修改。示例 53、54、55 实际运行通过；示例 58 的非终端路径通过，终端路径在当前环境未通过（详见风险）。未运行 `npm run check`、`npm run build`、格式化、测试或任何 git/npm 写操作。

## 完成文件

所有文件均先完整阅读，再添加注释；每条注释都按“文件导读 / 函数说明 / 关键行”组织。`git diff --numstat` 显示 18 个文件全部为新增行、0 删除行；逐行扫描新增内容，只有 `//` 注释和空行。

### packages/chord/test/examples/53-app

- `app/principals.ts`：完整。解释 `NotesPrincipal` 四个成员（server/owner/worker/user）的业务含义、`kind` 判别字段和编译期联合类型；核对 `worker.project` 来自项目地址 key。
- `app/v1.ts`：完整。解释 API 模块 `@notes/app/v1` 的组成、`export ... from` 不产生本地绑定、`Project = hostKind("project", { id: str() })` 的地址用法、`Sections` 注册表的贡献/合并类型。核对了 `remote/method/obj/str/arr`、`defineRegistry`、`hostKind` 与 `Files/WorkerInfo/AppInfo` 的真实导出。
- `app/v1/server.ts`：完整。说明该模块只登记给 server kind 的构建，worker 构建的模块表没有 `@notes/app/v1/server`；解释 `Sessions` 与 `Http` 的 re-export 及运行时模块解析。
- `client.ts`：完整。说明 `call(port, method, path, headers, body)` 的 Promise 语义、`node:http.request` 事件、`Buffer.concat`、首个 `set-cookie` 的分割、JSON 解析条件、连接错误拒绝；注明 JSON.parse 在事件回调中抛错不会被 Promise 捕获。核对返回类型 `Answer = {status, cookie, body}`。
- `main.ts`：完整。6 步导读覆盖 owner link（fragment token）、匿名 401、登录、owner link 只能使用一次、GET / 与 notes 读写、worker 目录名百分号编码、CLI 会话和清理。实跑输出与注释一致。
- `plugins/home/server.ts`：完整。导读同时说明同目录 `package.json` 的作用（插件名、private、type module）；解释 `Home` 本地契约、`host.serve(Sections, { compose })`、`home.registry/derive`、`self.contribute(Http, ...)`、`ctx.get(AppInfo/Home)`、`ctx.principal ?? null`。修正了示例 import（`Http` 而不是不存在的 `http`）。
- `plugins/notes/contract.ts`：完整。解释 `remote("notes.notes", ...)` 的版本、`params: { id: str() }` 调用边界校验、`hostAddress` 到项目地址的映射、`variants.main` 的 state/methods；明确写清 Chord 在调用边界校验参数，但方法返回值不做运行时校验（核对 `src/host/attempt.ts`）。
- `plugins/notes/server.ts`：完整。解释 `Sections` 贡献和 `GET/POST /notes/:id`；说明 `request.params.id ?? ""` 是运行期兜底、`String(await request.json())` 是运行期转换；核对响应 `{ kind: "json", value: ... }`。
- `plugins/notes/worker.ts`：完整。解释 `Text` 持久文档、`Store` 本地契约、两个 `host.serve` 工厂、`self.state`、`text.change`、`self.get(Store/WorkerInfo/Files)`、派生 `text/start`、`attach/attachment` 的 TextEncoder/TextDecoder 与 64 KiB 读取；修正 `checkpointWhen` 签名为 `(value, ops, CheckpointInfo)`，`true` 写新 base、`false` 写 delta。
- `start.ts`：完整。解释 `API = {name, versions, modules}`、`KINDS`、`startNotes(dataDir, context)`、`root` 通过 `fileURLToPath(new URL("./plugins/", import.meta.url))` 解析、单 worker kind 的 `entry/execArgv/start/authorize/idleMs`、`principal.worker` 映射和 `onError`；核对 `hostPackagesOf` 只暴露 `<api>/<version>` 与 `<api>/<version>/<kind>`，所以 server 模块不会进入 worker 构建。
- `worker.ts`：完整。解释 `startWorker({ api, kinds, onError })`、每项目一个进程、IPC 握手后的 `{ kit, app }` 启动数据、store/files 位置、返回 void 但进程保持运行；说明单独运行缺少父进程会失败。

### packages/chord/test/examples/54-app-sessions

- `main.ts`：完整。5 步导读覆盖浏览器登录、`POST /_chord/pair` 的公开路由与 `{code, poll}`、匿名批准 401、owner 确认页 200 并显示设备标签、批准后下一次 poll 返回 `{status:"approved", token}`、再次 poll 404、Bearer 设备请求、`Sessions.list/revoke/release`。修正预期会话列表为启动时 `device: owner token file`、`browser: owner browser`、`device: laptop CLI`；`SessionInfo` 字段为 id/label/kind/principal/created/lastUsed，不含 token/hash。实跑输出一致。

### packages/chord/test/examples/55-app-export

- `main.ts`：完整。4 步导读覆盖重新声明 `notes.notes` 契约（跨进程同 name/version/schema 绑定）、`p1.write/attach`、worker 运行中导出（不停机，tar mode 0600，manifest + store.archive + files）、导入为 p2、p1/p2 隔离、拒绝导入到已有数据的地址。修正导读中的上游路径为 `../53-app/start.ts`。实跑输出一致：导出 4608 bytes、mode 600，p2 读到文本与附件，p1 不变，拒绝信息为 `project|p1 has data (its worker runs)`。

### packages/chord/test/examples/58-themes

- `main.ts`：完整。5 步导读覆盖 board 插件复制（`fs.cp` 合并语义）、`headlessPage` 需要显式加入 `themesFacet`、`followActiveTheme`、`ThemeChoice.choose/release`、可选终端启动、改写主题源码后 `dirty`/`applyChanges` 热更新。注释核对了 `themeVariables`、`TerminalTheme`、`startTerminal`、`requireSandboxNode`、`nearest256` 等真实 API；预期输出写明了 256 色序列 `38;5;136` / `38;5;240` 与 truecolor 序列。
- `plugins/midnight.web.ts`：完整。说明单文件插件命名 `<name>.<kind>.ts`、只允许 import 应用 API、`Themes` 的原始贡献值（不是 `{value,version}` 包装）、7 个基础角色和缺失 `web/tui` 扩展的后果。
- `plugins/solarized/theme.ts`：完整。导读说明同目录 `package.json` 的清单作用、`Theme` 类型在编译期检查、`web` 键不带 `--`、`tui.muted: "240"` 的 256 色索引语义。
- `plugins/solarized/tui.ts`：完整。说明目录插件的 tui facet、`./theme.ts` 共享数据、终端注册表按插件名排序；没有本文件时终端没有可选主题。
- `plugins/solarized/web.ts`：完整。说明 web facet 与 tui facet 的分 kind 加载、同一份 `Theme` 数据、注册表合并不做颜色格式校验。

## 未修改的数据/配置文件

以下文件在受控清单中，但按要求未编辑；其清单作用已写入同目录代码文件的导读：

- `packages/chord/test/examples/53-app/plugins/home/package.json`：`{"name":"@notes/home","private":true,"type":"module"}`。插件发现器读取 `name` 作为插件名（也是贡献排序依据），`type` 决定按 ESM 构建，`private` 防止误发布；本插件只有 `server.ts`，所以是 home 的 server facet。
- `packages/chord/test/examples/53-app/plugins/notes/package.json`：`{"name":"@notes/notes","private":true,"type":"module"}`。整个目录是一个插件，`server.ts`、`worker.ts` 分别作为两种 kind 的 facet，`contract.ts` 被两者共同导入；插件名决定 `notes.notes` 的贡献排序。
- `packages/chord/test/examples/58-themes/plugins/solarized/package.json`：`{"name":"@board/solarized","private":true,"type":"module"}`。目录插件名 `@board/solarized` 排在单文件插件 `midnight` 之前，因此第一个深色主题是 `solarized-dark`；`web.ts`/`tui.ts` 是两个 kind 的 facet，`theme.ts` 是共享数据。

三个文件均未出现在 `git status` 的修改列表中。

## 命令与结果

- `node --version`：`v26.9.0`。
- `cd packages/chord && node --conditions=source --experimental-strip-types test/examples/53-app/main.ts`：通过。输出包含 data directory 的 `logs, owner-token, plugins, server, workers`、匿名 401、owner link 页面 200、再次使用 403、`GET /` 的 `{"app":"notes v1","you":{"kind":"owner"},"sections":["Notes: /notes/:id"]}`、notes JSON、worker 目录 `project%7Cp1`、CLI JSON、`closed`。
- `cd packages/chord && node --conditions=source --experimental-strip-types test/examples/54-app-sessions/main.ts`：通过。输出与导读中的 pairing code、waiting、401、确认页 200、approved、再次 poll 404、三个会话、吊销后 401 一致。
- `cd packages/chord && node --conditions=source --experimental-strip-types test/examples/55-app-export/main.ts`：通过。输出 `1. exported: 4608 bytes mode 600`、`2. p2: "the plan" "step 1, step 2"`、`p1 unchanged: "the plan"`、`3. refused: importData: project|p1 has data (its worker runs)`。
- 示例 58 的非终端路径：使用一个临时包装脚本（位于 `/tmp`，已删除）把 `process.versions.node` 临时报告为 `22.0.0`，使示例跳过终端步骤；通过。输出依次为 Solarized Dark 的 `--accent #b58900`/`--radius 4px`、256 色 `38;5;136`/`38;5;240`、Midnight 的 `--accent #7aa2f7`/`--radius -`、跳过终端的提示，以及编辑后的 `--accent #d33682`、256 色 `38;5;168`/`38;5;240`。该包装脚本不在仓库中，运行结束后已删除。
- 示例 58 的终端路径：在 Node 26.9.0 上实际运行 `node --conditions=source --experimental-strip-types test/examples/58-themes/main.ts`，180 秒内停在等待终端帧 `\x1b[38;2;181;137;0mBoard` 的循环中，没有输出第 3 步；随后终止进程并清理临时目录。原因未定位到源码注释：终端分支发生在示例第 5 步改写源码之前，而本次只添加注释。可能是当前 macOS + Node 26.9.0 的 sandbox 环境问题；示例的等待循环没有超时，所以表现为挂起。
- 未运行 `npm run check`、`npm run build`、仓库级格式化、`npm test`、`./test.sh`、`git add`、`git commit`、`git push` 或 `npm install`（按任务约束）。

## 发现与修复

添加注释时发现一个会改变示例行为的隐患：示例 58 第 5 步用 `(await readFile(file, "utf8")).replace("#b58900", "#d33682")` 按文本改写临时副本中的 `plugins/solarized/theme.ts`。最初的中文注释在 accent 赋值之前写入了字面量 `#b58900`，导致替换命中注释而不是 `accent`，主题永远不变，示例在 `while (active?.colors.accent !== "#d33682")` 处无限等待。

修复方式：把该注释改写为“58 第 5 步会改写这个 accent 的十六进制值（改成 #d33682，RGB 211,54,130）”，不再包含 `#b58900` 字面量；现在该文件中只有 `accent` 行包含这个字符串。同时在 `58-themes/main.ts` 第 5 步的注释里补充了这一风险说明：文本替换只命中第一处，注释若先写同一字符串会替换错位置。修复后非终端路径实跑通过。该问题也提示其他注释文件：如果示例会对自身源码做文本替换，注释中不要提前出现被替换的字面量。

## 未完成或风险

- 示例 58 的终端步骤未在当前环境验证通过。实际运行在 180 秒内停在终端帧等待循环；未捕获 sandbox 的 stderr（实现中 stderr 被丢弃），因此未能确定具体失败原因。该示例本身没有断言，也没有等待超时；终端路径依赖 Node 26.5.1+ 的权限模型和 56-web 的 tui 入口。
- 58 的终端步骤还依赖 `packages/chord/test/examples/56-web` 的 tui 入口与插件，这些文件可能被并行小组同时修改；本次运行期间它们处于注释修改状态。非终端路径已通过，说明主题注册表、选择、`applyChanges` 的热更新逻辑本身工作正常。
- 按约束没有运行全仓库检查和测试；本次只对受控文件做了 diff 级验证（新增行全部为注释/空行，0 删除行），没有证明整个仓库或其他小组的文件通过检查。
- 三个 `package.json` 未编辑，因此插件发现仍按原始清单运行；其作用只在代码导读和本报告中说明。
- 一个共享临时目录中的 `chord-lock-*.sock` 通配删除曾被执行策略拒绝；随后按精确路径删除了本次运行创建的最新 socket，并确认没有残留的 58 进程或 `board-*`/`chord-tui-*` 临时目录。
