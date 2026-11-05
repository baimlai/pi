# 组 e13（Chord test/examples 41-45）

状态：完成

## 完成文件

- packages/chord/test/examples/41-workers/main.ts：完整。文件头含所属系列（slice 10）、workers 流程、从 packages/chord 运行的命令、前置条件、预期输出、能力清单与阅读顺序；逐段解释 createPlugins（roots/kinds/hostPackages/onError，且第二个 `_context` 参数当前未被读取，已核对 src/node/plugins/plugins.ts:218）、createHost 的 server 地址与 principal、createWorkers 的全部选项（kind/entry/execArgv/authorize/principal/start/lock/idleMs/plugins/onError）、`server.load([])`、`workers.state.watch` 与 WatchCall 的 `kind !== "value"` 收窄、`server.get` 的远程路由、Watchable 的 `.value`、`release()`、空闲轮询与关闭顺序。修改量 75 增 0 删。
- packages/chord/test/examples/41-workers/worker.ts：完整。说明它是 createWorkers 的 entry、workerMain 与 WorkerStart 字段、先 connect（服务器记录 started）后 plugins.load 的顺序、`onClose(() => host.close(BACKGROUND_CONTEXT))` 的原因、`trusted: true` 只跳过 MESSAGE 结构校验、`return {}` 的 WorkerResult、hostPackages/redact/onError；同目录 package.json 的作用写入文件头。修改量 39 增 0 删。
- packages/chord/test/examples/41-workers/plugins/sessions/contract.ts：完整。解释 hostKind 地址与 `session|S1` key、remote 的 version/params/hostAddress/variants、state 成员变成 Watchable、声明时的运行时校验与 Module 加载时机；package.json 作用写入文件头。修改量 28 增 0 删。
- packages/chord/test/examples/41-workers/plugins/sessions/worker.ts：完整。解释 defineFacet 只做声明、插件入口必须有默认导出、远程工厂签名 `(params, principal, self)`、`constant` 生成不可变 Watchable、返回形状由 TypeScript 检查而运行时不重新校验；package.json 作用写入文件头。修改量 26 增 0 删。
- packages/chord/test/examples/42-worker-crash/main.ts：完整。文件头含崩溃/重试流程、预期输出（worker_exited、worker_failed、failed、Retry 后新 pid）与阅读顺序；解释 `sleep` 的 `Promise<unknown>` 推断、宿主 onError 故意留空、默认 idleMs 5 分钟、`hold` 同步且不 reject、RefState 的 loading/live/failed/ended、`crash(context)` 的调用形式、可选链与 WorkerState 联合收窄、`workers.retry`、清理顺序。修改量 55 增 0 删。
- packages/chord/test/examples/42-worker-crash/worker.ts：完整。对照 41 解释子进程侧同一流程，并说明崩溃不是在这里触发而是由插件的 crash 方法触发。修改量 26 增 0 删。
- packages/chord/test/examples/42-worker-crash/plugins/sessions/contract.ts：完整。解释 Process 远程契约的 `state.pid` 与 `methods.crash: method()`（无参数、结果 null），以及引用上的 `crash(context)` 调用形式；package.json 作用写入文件头。修改量 23 增 0 删。
- packages/chord/test/examples/42-worker-crash/plugins/sessions/worker.ts：完整。解释 `pid: constant(process.pid)`、crash 的 `setTimeout(() => process.exit(13), 10); return null;`、process.exit 不执行 onClose、10ms 延迟只是让示例输出稳定的非可靠时序；package.json 作用写入文件头。修改量 24 增 0 删。
- packages/chord/test/examples/43-rollout/main.ts：完整。文件头含 rollout 流程、实际观察到的输出（包括 `4. still dirty: ["@example/notes"]`）与原因；解释 waitUntil 无超时、`describe` 对 RolloutHost 三种分支的 `in` 收窄、临时目录复制与无 try/finally 的限制、`as const` 保留字面量类型、modules 的两个用途、load、get Banner/Label、覆写 label.ts、等 dirty、`plugins.build`、`rollout([plugins.step("server", server), workers.step("workers")], built, context)`、结果打印、等远程更新、`rm(root, {recursive:true, force:true})`。修改量 70 增 0 删。
- packages/chord/test/examples/43-rollout/worker.ts：完整。说明 worker 侧初始加载与后续 reload 控制消息，worker 自己不构建、不发现文件。修改量 23 增 0 删。
- packages/chord/test/examples/43-rollout/plugins/notes/contract.ts：完整。对比 local Banner（扁平 members、params 空、本地单例）与 remote Label（variants、hostAddress 指向 Session）、version/指纹与声明校验。修改量 24 增 0 删。
- packages/chord/test/examples/43-rollout/plugins/notes/label.ts：完整。说明它是普通模块而非 facet、被 server.ts 与 worker.ts 共享、值在构建打包时读取、`const` 的字面量类型推断。修改量 14 增 0 删。
- packages/chord/test/examples/43-rollout/plugins/notes/server.ts：完整。解释本地工厂返回扁平 members、`constant(`server: ${label}`)`、rollout 重载后重新计算；package.json 作用写入文件头。修改量 19 增 0 删。
- packages/chord/test/examples/43-rollout/plugins/notes/worker.ts：完整。解释远程工厂 `({id}) => ({variant:"main", members:{text: constant(`${id}: ${label}`)}})`、rollout 后同一引用读到新值；package.json 作用写入文件头。修改量 19 增 0 删。
- packages/chord/test/examples/44-http-wraps/main.ts：完整。文件头含 wraps 的 phase 顺序、实际观察到的输出（audit 只记录 /notes，/missing 404 且保留 no-store）、运行命令、能力清单与阅读顺序；解释无 address 的宿主、createHttp 的 listen/onError、modules 同时用于 hostPackages 与求值、core facet `chord.http`、load 前请求 503、listening 解构、fetch 循环、默认 `Cache-Control: no-store` 与 notes wrap 的 `max-age=60`、无匹配路由不运行 wrap、先 http.close 后 server.close 的顺序。修改量 49 增 0 删。
- packages/chord/test/examples/44-http-wraps/plugins/audit/server.ts：完整。文件头说明只贡献 wrap、`scope: "all"`、`phase: "observe"`、对 404 不可见、错误报告为 wrap_failed、package.json 作用；逐行解释 defineFacet、wrap 的 `(request, next, ctx)` 签名、先 await next 再打印、`"status" in response` 的运行时收窄与默认 200、principal 匿名的表示；同目录 package.json 作用写入文件头。修改量 31 增 0 删。
- packages/chord/test/examples/44-http-wraps/plugins/notes/server.ts：完整。文件头说明路由 + 自有 wrap、默认 `scope: "own"`、headers 阶段、与 audit 的组合顺序、package.json 作用；逐行解释模式键与解析规则、`public: true` 的默认拒绝语义、json 响应描述、wrap 的 next/返回约定、`{...response.headers}` 对 undefined 的空操作与对默认头的覆盖、响应形状只有编译期检查（response.ts 明确不做 schema 校验，JSON 序列化失败回答 500）；同目录 package.json 作用写入文件头。修改量 37 增 0 删。
- packages/chord/test/examples/45-plugin-socket/main.ts：完整。文件头含插件套接字流程、从 packages/chord 运行的命令、实际观察到的输出、能力清单、相关测试（test/node/http/upgrades.test.ts 的 plugin sockets 与 close 分组）与阅读顺序；逐行解释 once 的事件参数数组、createHost<Principal>、defineFacet<Principal> 与 Authenticators 贡献、`headers.get` 的 string|null、modules、core facet 顺序、load、listening、升级步骤与 401、`unexpected-response`、ws 的 `headers` 选项、`messages: string[]` 与 Buffer 解码、open 后再 send、轮询、先注册 close 再 http.close、1001 going away、plugins.close。修改量 78 增 1 删：删除的是原有错误注释 `// 1. Without a principal: refused (403)...`，替换为 401（见风险）。
- packages/chord/test/examples/45-plugin-socket/plugins/echo/server.ts：完整。文件头说明 `sockets` 模式、裸函数等价于非 public、匿名在处理器前 401、socket_failed/1011、reload 移除贡献 1012、组件关闭 1001、package.json 作用；逐行解释 `(socket, request, ctx)` 签名、`request.params.room` 的写入时机与 URL 解码、ctx.principal 的类型为 `Principal | undefined` 而运行时由准入保证、`JSON.stringify`、greeting、message 监听器的 Buffer 与 String 解码、未处理背压。修改量 35 增 0 删。

核对的真实签名与语义来源：`packages/chord/docs/slices.md`（示例索引）、`packages/chord/docs/slice-10.md`、`packages/chord/docs/design.md` §23（HTTP 与 Workers）与 §3（links/trusted）；`src/node/workers/index.ts`、`workers.ts`、`main.ts`；`src/node/plugins/index.ts`、`plugins.ts`、`runtime.ts`、`discover.ts`、`watcher.ts`；`src/node/http/index.ts`、`http.ts`、`router.ts`、`request.ts`、`response.ts`、`authenticate.ts`、`upgrades.ts`、`headers.ts`；`src/host/host.ts`、`ctx.ts`、`facet.ts`、`reference.ts`、`ref-state.ts`、`attempt.ts`；`src/contracts/declare.ts`、`host-kind.ts`、`contract.ts`；`src/state/watchable.ts`、`src/watch.ts`、`src/context/index.ts`、`src/data/principal.ts`。

## 验证

- 注释全部完成后，从 packages/chord 依次运行五个示例（Node strip-types + source 条件），五个均正常退出：
  - `node --conditions=source --experimental-strip-types test/examples/41-workers/main.ts`：输出 `1. getting S1's greeting`、`workers: session|S1 starting/running`、greeting 与两个 pid、`3. released; waiting for the idle stop`、`workers: session|S1 stopping`、`workers: none`、`4. stopped`。
  - `node --conditions=source --experimental-strip-types test/examples/42-worker-crash/main.ts`：`reported: worker_exited`、`reported: worker_failed`、`2. crashed: worker exited (code 13)`、`3. a second later: failed, the holder: failed`、`4. after Retry: S1 runs in process <新 pid>`。
  - `node --conditions=source --experimental-strip-types test/examples/43-rollout/main.ts`：`1. server: v1 | S1: v1 | S2: v1`、三行 `changed @example/notes`、`3. server: v2 | S1: v2 | S2: v2`、`4. still dirty: ["@example/notes"]`。
  - `node --conditions=source --experimental-strip-types test/examples/44-http-wraps/main.ts`：`audit: anonymous GET /notes 200`、`-> 200, Cache-Control: max-age=60`、`-> 404, Cache-Control: no-store`（/missing 无 audit 行）。
  - `node --conditions=source --experimental-strip-types test/examples/45-plugin-socket/main.ts`：`1. anonymous: refused 401`、`2. welcome to lobby, {"kind":"user","name":"ada"}`、`2. echo: hello`、`3. closed with 1001`。
- `git diff --numstat`（19 个 TS 文件）：除 `45-plugin-socket/main.ts` 为 78 增 1 删外，其余均只有新增；删除行检查确认唯一的删除行就是该文件中被替换的旧注释，没有任何原始代码、类型、字符串、模板内容或导入被删除或改写。`git diff --check` 退出码 0。
- `git status --porcelain -- 'packages/chord/test/examples/4[1-5]*/plugins/*/package.json'` 无输出，确认六个清单未被修改。
- 未运行 `npm run check`、`npm run build`、全仓格式化、全仓测试，也未执行 git add/commit/push 或 npm install（任务说明禁止）。

## 未修改的数据/配置文件

- packages/chord/test/examples/41-workers/plugins/sessions/package.json：`{"name":"@example/sessions","private":true,"type":"module"}`；discoverPlugins 读取 name 作为插件身份（出现在报告与 dirty 标记中），private 防止误发布，type 声明 ESM。JSON 不能加注释，作用写入同目录 contract.ts 与 worker.ts 文件头。
- packages/chord/test/examples/42-worker-crash/plugins/sessions/package.json：`@example/sessions` 清单，字段与读取方同上；作用写入插件目录的 contract.ts、worker.ts 以及入口 42-worker-crash/worker.ts 的文件头。
- packages/chord/test/examples/43-rollout/plugins/notes/package.json：`@example/notes` 清单；name 出现在 dirty 标记与 rollout 报告中；作用写入同目录 contract.ts、server.ts、worker.ts 文件头。
- packages/chord/test/examples/44-http-wraps/plugins/audit/package.json：`@example/audit` 清单；name 用于报告与冲突定位；作用写入同目录 server.ts 文件头。
- packages/chord/test/examples/44-http-wraps/plugins/notes/package.json：`@example/notes` 清单；作用写入同目录 server.ts 文件头。
- packages/chord/test/examples/45-plugin-socket/plugins/echo/package.json：`@example/echo` 清单；name 出现在 socket_failed 等报告里；作用写入同目录 server.ts 文件头。

## 未完成或风险

- `45-plugin-socket/main.ts` 的原注释写“refused (403)”，但实际代码 `src/node/http/http.ts` 的升级步骤对非 public 且无 principal 的插件套接字返回 401（第 628 行），运行时输出也是 `refused 401`；`docs/design.md` §23 中“403”的表述与代码不一致。本组按代码与实际运行结果把该注释改为 401。这是唯一一处删除原有行，且只涉及注释，未改代码。
- `43-rollout` 的 `4. still dirty: ["@example/notes"]` 是稳定输出而非偶发：rollout 只清除不晚于构建快照的 watcher 标记（`PluginWatcher.applied` 按 generation 与快照比较），构建开始后到达的文件系统事件会保留 dirty。文件头已说明它表示可以再构建一轮，不是发布失败。
- 注释增加了插件源码行数，理论上会改变构建/求值错误报告中出现的行号；这五个示例没有构建失败，本次运行未观察到任何含行号的输出，仓库中也没有测试引用这些示例的固定行号。
- 按任务约束未运行 `npm run check`，因此没有对注释改动做 tsc 校验；所有改动都是整行注释，示例已由 Node 的 strip-types 实际解析并运行成功。未覆盖真实网络、凭证或模型调用；44/45 只监听 127.0.0.1 回环。
