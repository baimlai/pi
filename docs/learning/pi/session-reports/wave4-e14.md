# 组 e14

状态：完成

## 完成文件

- `packages/chord/test/examples/46-allowed-hosts/main.ts`：完整。核对 `createHttp`（`HttpOptions.listen/onError`、`listening()`、`close()`）、`createPlugins`/`plugins.load`、`host.get`/`release`、`local`/`method`/`str` 的真实签名。运行 `node --conditions=source --experimental-strip-types test/examples/46-allowed-hosts/main.ts`，exit 0：localhost 200、`notes.example.net` 403、open 后 200 且 origin 为 https、close 后 403。
- `packages/chord/test/examples/46-allowed-hosts/plugins/tunnel/server.ts`：完整。核对 `defineFacet`、`self.contribute(Http, ...)`、`host.serve`、`self.writable<HttpContribution>`、`HttpContribution` 的字段。随 46 运行通过；验证允许主机集合在线增删。
- `packages/chord/test/examples/47-http-own-server/main.ts`：完整。核对无 `listen` 的 `createHttp`、`nodeRequest` 的 `request | refused(400/403/501)` 联合、`http.fetch`（永不抛错）、`http.upgrade`、`createServer`。运行对应命令，exit 0：GET /notes 200 且带 `x-content-type-options: nosniff`、/nowhere 404、TRACE 501、带 userinfo 的 Host 403。
- `packages/chord/test/examples/47-http-own-server/plugins/notes/server.ts`：完整。核对 `Http` 路由键、`public: true`、handler 返回 `HttpResponse` 描述与 `request.origin`。随 47 运行通过。
- `packages/chord/test/examples/48-http-baseline/main.ts`：完整。核对 `cookie`/`readCookie` 的签名与过期/验签行为、`HttpRouteOptions` 的 `public/page/crossSite`、`Authenticators` 贡献顺序。运行对应命令，exit 0：七步输出为 200、200（新增 call mom）、403、401、200（页面显示 ada）、200（webhook anonymous）。
- `packages/chord/test/examples/48-http-baseline/plugins/notes/server.ts`：完整。核对默认保护路由、`page: true`、`crossSite: true`、`request.json()` 的 400/413 错误路径与 `who()` 的 `unknown` 用法。随 48 运行通过。
- `packages/chord/test/examples/49-plugin-api/main.ts`：完整。核对 `createPlugins` 的 `roots`/`AppApi`/`kinds.hostPackages`、`load` 返回 `LoadReport`、`build` 返回 `Built`（`facets/plugins/removed`）、`evaluateFacet` 的 `BuiltScript` 入参、`host.registry` 返回 `RegistryValue`、`PluginFailure.error` 为 `unknown`。运行对应命令，exit 0：两行问候、四条构建拒绝（ancient/direct/mixed/panel）、`server failed, web script`、`panels on the page: word count`。
- `packages/chord/test/examples/49-plugin-api/app/v2.ts`：完整。核对 `Greetings as Hellos` 是同一 token 的改名 re-export；由 49 的 legacy 插件实际执行，输出 `hello from a v2 plugin`。
- `packages/chord/test/examples/49-plugin-api/app/v3.ts`：完整。核对 `defineRegistry<C, V>(name, { version })` 与 re-export 清单；由 49 实际加载并输出 v3 问候。
- `packages/chord/test/examples/49-plugin-api/app/v3/server.ts`：完整。核对 `serverName(): string`；由 hello 插件调用，输出包含 `the acme server`。
- `packages/chord/test/examples/49-plugin-api/app/v3/web.ts`：完整。核对 `Panels` 注册表的贡献类型与读值类型；由 49 的 web facet 求值实际使用。
- `packages/chord/test/examples/49-plugin-api/app/v3/worker.ts`：完整（静态核对）。核对 `Indexers` 的 `defineRegistry` 签名，并核对示例 52 的 import 与 modules 表；49 不加载 worker，未运行 52。
- `packages/chord/test/examples/49-plugin-api/plugins/ancient/env.d.ts`：完整。核对 ambient `declare module "@acme/app/v1"` 的编译期作用；用 esbuild TS loader 解析通过，49 的实际构建错误确认 v1 被拒绝。
- `packages/chord/test/examples/49-plugin-api/plugins/ancient/server.ts`：完整。49 运行输出 `"@acme/app/v1": @acme/app/v1 is not available: this app provides v3, v2`。
- `packages/chord/test/examples/49-plugin-api/plugins/direct/server.ts`：完整。49 运行输出 `plugins import Chord through the app's API ("@acme/app/v3"), never directly`。
- `packages/chord/test/examples/49-plugin-api/plugins/hello/server.ts`：完整。49 运行输出 `hello from a v3 plugin on the acme server`。
- `packages/chord/test/examples/49-plugin-api/plugins/legacy/server.ts`：完整。49 运行输出 `hello from a v2 plugin`。
- `packages/chord/test/examples/49-plugin-api/plugins/mixed/server.ts`：完整。49 运行输出 `one facet imports one version of @acme/app: ...`。
- `packages/chord/test/examples/49-plugin-api/plugins/panel/server.ts`：完整。49 运行输出 `"@acme/app/v3/web": not available to server facets`。
- `packages/chord/test/examples/49-plugin-api/plugins/panel/web.ts`：完整。49 运行输出 `panels on the page: word count`。

验证方式：`git diff --numstat` 显示以上 20 个 `.ts` 文件均为纯新增（删除 0 行）；用 `node --experimental-strip-types --check` 检查 19 个普通模块全部通过，`env.d.ts` 因是 ambient 声明改用 esbuild `ts` loader 解析通过。未运行 `npm run check`、`npm run build`、全仓格式化或完整测试套件（任务禁止）。

## 未修改的数据/配置文件

- `packages/chord/test/examples/46-allowed-hosts/plugins/tunnel/package.json`：插件发现清单（`name` = `@example/tunnel`，`private`，`type: "module"`），由 `src/node/plugins/discover.ts` 读取以确定插件身份与目录布局；JSON 不允许注释，任务也禁止改写，清单作用已写入同目录 `server.ts` 文件头。
- `packages/chord/test/examples/47-http-own-server/plugins/notes/package.json`：插件发现清单（`@example/notes`），读取方同上；说明写入同目录 `server.ts` 文件头。
- `packages/chord/test/examples/48-http-baseline/plugins/notes/package.json`：插件发现清单（`@example/notes`），读取方同上；说明写入同目录 `server.ts` 文件头。
- `packages/chord/test/examples/49-plugin-api/plugins/ancient/package.json`：插件发现清单（`@acme/ancient`），读取方同上；说明写入同目录 `server.ts` 文件头。
- `packages/chord/test/examples/49-plugin-api/plugins/direct/package.json`：插件发现清单（`@acme/direct`），读取方同上；说明写入同目录 `server.ts` 文件头。
- `packages/chord/test/examples/49-plugin-api/plugins/hello/package.json`：插件发现清单（`@acme/hello`），读取方同上；说明写入同目录 `server.ts` 文件头。
- `packages/chord/test/examples/49-plugin-api/plugins/legacy/package.json`：插件发现清单（`@acme/legacy`），读取方同上；说明写入同目录 `server.ts` 文件头。
- `packages/chord/test/examples/49-plugin-api/plugins/mixed/package.json`：插件发现清单（`@acme/mixed`），读取方同上；说明写入同目录 `server.ts` 文件头。
- `packages/chord/test/examples/49-plugin-api/plugins/panel/package.json`：插件发现清单（`@acme/panel`），读取方同上；说明写入同目录 `server.ts` 文件头。

## 未完成或风险

- 49 的构建错误包含 `server.ts:<行>:<列>`，这些数字会随文件增删注释而变化；文件头只承诺错误形状与规则文本，不承诺固定行号。当前实际值（21:40、19:29、23:24）仅来自本次运行。
- `app/v3/worker.ts` 在本组示例 49 中没有执行路径，只做了签名与示例 52 调用点的静态核对；未运行示例 52。
- 未做仓库级类型检查；本次只验证了注释后的语法解析与四个示例的运行时行为。
