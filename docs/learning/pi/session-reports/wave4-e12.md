# 组 e12

状态：完成

## 完成文件

17 个非 JSON 文件均已补全“文件导读”和逐行中文注释；原有英文文档、代码、字符串、默认值与缩进保持不变。`git diff --numstat` 显示 17 个文件全部只有新增行、删除数为 0，`git diff --check` 退出码为 0。

三个示例的最终验证命令（均在 `packages/chord` 下执行）：

```text
node --conditions=source --experimental-strip-types test/examples/38-watch-and-rollout/main.ts
node --conditions=source --experimental-strip-types test/examples/39-browser-build/main.ts
node --conditions=source --experimental-strip-types test/examples/40-http/main.ts
```

### 38-watch-and-rollout

- packages/chord/test/examples/38-watch-and-rollout/app/config.ts：完整。核对了 `PluginsOptions.base` 与 watcher 只置 `base` 而不重启宿主的行为；说明本文件不被 import、不是插件清单，以及它是 `main.ts` 中 `String.replace` 的目标。由 38 第 1、2 步的 `base` 标记覆盖。
- packages/chord/test/examples/38-watch-and-rollout/incoming/extra/server.ts：完整。核对了 `defineFacet`、`host.serve`、`local`、`str`、`constant` 的真实签名，以及 `discoverPlugins`/`pluginAt` 从 `package.json` 读取插件名并校验的规则；说明 `incoming/` 在 roots 之外、运行时复制进 `plugins/`。38 第 3 步输出 `added:["@example/extra"]`。
- packages/chord/test/examples/38-watch-and-rollout/main.ts：完整。核对了 `createPlugins`、`plugins.load`、`plugins.state`、`plugins.build`、`plugins.rollout`、`plugins.step`、`plugins.installDependencies`、`createHost`，以及 `Built`、`PluginsState`、`RolloutStep`、`RolloutHost`、`RolloutResult`、`ReloadReport` 的字段。38 全流程通过：第 3 步构建 extra/notes/tags 并移除 old；第 4 步 edge 拒绝后 worker 未执行、标记保留；第 5 步 notes 失败保持脏、tags 成功；第 6 步第一次发布保留 notes 的脏标记，第二次清除。
- packages/chord/test/examples/38-watch-and-rollout/plugins/contracts/contract.ts：完整。核对 `local`/`str` 声明和 `labelOf(plugin)` 返回的契约；说明契约文件会被复制进每个导入者的构建，因此编辑它会让 notes、old、tags、shared 全部变脏。38 第 2 步实际输出四个插件 dirty。
- packages/chord/test/examples/38-watch-and-rollout/plugins/notes/label.ts：完整。说明两个 facet 在构建时内联该字符串；确认注释没有包含 `notes v1` 至 `notes v5` 等替换目标。38 第 2、4、5、6 步的编辑全部按预期生效。
- packages/chord/test/examples/38-watch-and-rollout/plugins/notes/server.ts：完整。核对 `defineFacet`/`host.serve` 与模板字符串在工厂激活时的求值；说明第 5 步的语法错误实际来自被导入的 label.ts，server/worker 两个构建都失败。38 输出 `failed:["@example/notes"]`。
- packages/chord/test/examples/38-watch-and-rollout/plugins/notes/worker.ts：完整。说明文件名决定 facet kind，以及第 4 步 worker 步骤未执行时 notes 保持脏。与 server.ts 对照验证。
- packages/chord/test/examples/38-watch-and-rollout/plugins/old/server.ts：完整。说明删除整个插件目录后 `built.removed` 与 rollout 报告都会列出 old。38 第 3 步输出 `removed:["@example/old"]`。
- packages/chord/test/examples/38-watch-and-rollout/plugins/tags/server.ts：完整。说明第 5 步编辑后脚本与 digest 变化、tags 出现在 `changed`；确认注释未包含替换目标 `tags on the server`。38 第 5 步输出 `changed:["@example/tags"]`。
- packages/chord/test/examples/38-watch-and-rollout/plugins/tags/worker.ts：完整。说明删除该文件只移除 tags 的 worker facet、不影响 tags 插件本身。38 第 3 步输出 worker `removed:["@example/tags"]`。

### 39-browser-build

- packages/chord/test/examples/39-browser-build/main.ts：完整。核对 `createPlugins` 的 `kinds.web.platform: "browser"`、`publicPath`、`build`、`Built`/`BuiltFacet`/`BuiltScript`、`evaluateFacet`（`src/node/plugins/evaluate.ts` 使用 `Script.runInThisContext` 同进程执行）、`createHost` 的 `load`/`get`/`close`。运行输出：脚本 1392 字节、digest `f38777d3b61d`；CSS `web-2P7ZCVRU.css`；资源 `logo-3IRJDQYU.svg`（111 字节）与 URL `/plugin-assets/logo-3IRJDQYU.svg`；inputs 为 logo.svg、gallery.css、web.ts；`structuredClone` 比较为 true；页面读到同一个 logo URL。
- packages/chord/test/examples/39-browser-build/plugins/bad-web/web.ts：完整。说明浏览器构建在构建期拒绝 Node 内置模块、失败以 `{ kind: "failed", errors }` 返回；失败文本中的行列指向 import 语句。最终运行输出 `web.ts:14:22: "node:path": a Node builtin in a browser build`，文件头已同步为 14:22。
- packages/chord/test/examples/39-browser-build/plugins/gallery/assets.d.ts：完整。说明两个 ambient 模块声明只在 TypeScript 编译期生效，esbuild 不读取 `.d.ts`，也没有任何 import 引用它；未声称运行时校验 URL 形状。
- packages/chord/test/examples/39-browser-build/plugins/gallery/gallery.css：完整。说明 CSS 由 `web.ts` 副作用导入并收集成唯一 CSS 文件，注释会被 esbuild 压缩剥离；运行输出首行为 `.gallery{display:grid;gap:8px}.gallery img{width:64px}`。修正了网格默认单列的说明。
- packages/chord/test/examples/39-browser-build/plugins/gallery/web.ts：完整。核对 CSS 副作用导入、`?url` 资源导入、`local`/`str` 契约与 `constant`；运行输出证明 CSS 名、资源名、URL 和 inputs 与注释一致。文件头补充了同目录 `package.json` 提供 `@example/gallery` 的说明。

### 40-http

- packages/chord/test/examples/40-http/main.ts：完整。核对 `createHost({ principal, onError })`、`createHttp(host, { listen, closeTimeout, onError }, context)`、`http.facet`、`plugins.load(..., { core, modules })`、`http.listening`、`http.close`、`server.close`。运行输出：`/` 200 HTML；`/notes/hello` 200 JSON；下载 Range 请求 206 `text/markdown` 且带 `Content-Disposition: attachment`；缺失文件与未注册路径均 404；`cache-control: no-store`、`x-content-type-options: nosniff`、`x-frame-options: DENY`。
- packages/chord/test/examples/40-http/plugins/notes/server.ts：完整。核对 `self.contribute(Http, { routes })`、`"GET /notes/:name"` 参数解码、`request.nonce`、`pluginFile` 的目录边界、`fileResponse` 的 `download`/`ranges`/MIME 行为；运行输出覆盖页面、JSON、下载、Range、404。文件头补充了同目录 `package.json` 提供 `@example/notes` 的说明。

## 未修改的数据/配置文件

以下 8 个 `package.json` 均未修改（`git diff --stat` 对这些路径为空）。它们是 Chord 的目录插件清单：`src/node/plugins/discover.ts` 的 `manifestOf` 读取文件、`pluginAt` 读取 `name` 并用 `isPluginName` 校验；`dependencies` 的键与 `chord.external` 也在发现阶段读取（这 8 个文件没有这两项）。`private` 与 `type` 不是 Chord 的发现输入：前者用于防止误发布，后者标明源码按 ESM 解释。JSON 不支持注释，任务也禁止改写 JSON，因此其作用写进同目录主代码文件的“文件导读”。

- packages/chord/test/examples/38-watch-and-rollout/incoming/extra/package.json：`name` 为 `@example/extra`；该目录运行时被整包复制进 `plugins/`，清单随复制一起进入插件根。读取方：`discoverPlugins`/`pluginAt`。作用已写进同目录 server.ts 文件头。
- packages/chord/test/examples/38-watch-and-rollout/plugins/contracts/package.json：`name` 为 `@example/shared`；没有 facet 文件，发现为 contracts-only 插件，但仍是共享契约文件的所有者，编辑契约文件会让它变脏。读取方同上；作用已写进 contract.ts 文件头。
- packages/chord/test/examples/38-watch-and-rollout/plugins/notes/package.json：`name` 为 `@example/notes`；发现输入。作用已写进 notes/server.ts 文件头。
- packages/chord/test/examples/38-watch-and-rollout/plugins/old/package.json：`name` 为 `@example/old`；第 2 步递归删除目录时一并删除，下一次发现因此移除该插件。作用已写进 old/server.ts 文件头。
- packages/chord/test/examples/38-watch-and-rollout/plugins/tags/package.json：`name` 为 `@example/tags`；`main.ts` 在临时副本中替换其 `"private": true` 来触发 `install` 标记，仓库文件未动。作用已写进 tags/server.ts 文件头。
- packages/chord/test/examples/39-browser-build/plugins/bad-web/package.json：`name` 为 `@example/bad-web`；发现输入。作用已写进 bad-web/web.ts 文件头。
- packages/chord/test/examples/39-browser-build/plugins/gallery/package.json：`name` 为 `@example/gallery`；`39/main.ts` 用这个名字从 `built.plugins` 取构建元数据。作用已写进 gallery/web.ts 文件头。
- packages/chord/test/examples/40-http/plugins/notes/package.json：`name` 为 `@example/notes`；发现输入。作用已写进 notes/server.ts 文件头。

## 未完成或风险

- 未运行 `npm run check`、`npm run build`、全仓格式化、`test.sh` 或完整测试套件：任务明确禁止前三项，且未要求完整套件。因此没有 tsc 类型检查，类型签名是通过阅读 `packages/chord/src` 核对的；三个示例均用 `--experimental-strip-types` 直接运行源码，不做类型检查。
- 38 依赖 `fs.watch` 的事件时序。最终运行第 1 步出现额外的 `dirty:["@example/notes"]` 与 `set:true`，早前一次运行则是空标记；第 2 步删除 old 后也可能短暂出现 `install:["@example/old"]`。示例只等待特定标记并打印，不做断言，文件注释已说明这类额外标记和时序不确定性。
- 38 的 `edit()` 对临时副本执行不区分引号的 `String.replace`。`notes/label.ts`、`tags/server.ts`、`app/config.ts`、`contracts/contract.ts` 的注释不能在这些替换目标之前出现同名连续文本，否则会替换注释而不是代码。当前已用 grep 确认目标各只出现在预期代码行（contract.ts 的目标位于原有英文文档注释，替换它正是示例设计）。
- 39 的打印值随源码文本变化：给 `gallery/web.ts` 增加注释后 digest 变为 `f38777d3b61d`，给 `bad-web/web.ts` 增加一行后错误位置变为 `14:22`；两次都已同步并重跑。示例没有断言，这些值只用于观察。CSS 文件名 `web-2P7ZCVRU.css` 当前稳定，但同样不应被视为永久常量。
- 39 只用 Node 扮演页面并同进程求值脚本，没有在真实浏览器中执行，因此浏览器 API、CSP 与资源实际加载未被验证。
- 40 需要本机回环网络和临时端口；没有覆盖认证、TLS、长时间连接或 `closeTimeout` 的排空边界。HTTP 4xx 是正常响应，不会让示例失败。
- 工作区同时有其他代理在修改大量文件；本组只在上述 17 个非 JSON 文件中新增注释并写下本报告，8 个 `package.json` 和其他文件均未改动，也未执行任何 Git 暂存、提交或推送。
