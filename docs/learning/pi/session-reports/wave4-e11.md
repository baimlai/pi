# 组 e11（Chord test/examples/37-plugin-imports）

状态：完成

## 完成文件

- packages/chord/test/examples/37-plugin-imports/main.ts：完整。文件头含能力清单（7 个执行步骤）、离线运行命令、预期输出（构建错误行号注明随注释变化）、副作用与阅读顺序；逐行解释临时副本、modules 宿主包表、createPlugins 配置、load 失败清单、installDependencies、build 的 inputs/copied、reload 报告与 host.get 读取 Watchable。核对了 `createPlugins` 的真实签名与 `Plugins.load/reload/build/installDependencies`（src/node/plugins/plugins.ts）、`LoadReport`/`PluginFailure`/`ReloadReport`（src/host/host.ts）、`BACKGROUND_CONTEXT`（src/context/index.ts）、`Reference` 成员为 `Watchable`（src/host/reference.ts、src/contracts/contract.ts）。
- packages/chord/test/examples/37-plugin-imports/fake-npm.mjs：完整。说明它是 createPlugins 的 npmCommand 替身、子进程 cwd 为插件目录、install.ts 追加的固定参数、无网络与幂等性；逐行解释 JSON.parse 的类型信任边界、解构默认值、file: 校验和 cpSync。由示例实际执行验证。
- packages/chord/test/examples/37-plugin-imports/app/index.ts：完整。说明它是 `@example/app` 宿主包、ES 模块默认 + 命名导出、Chord 的 `interop` 包装（src/surfaces/registered.ts）；解释对象字面量、模板字符串与 toFixed。
- packages/chord/test/examples/37-plugin-imports/app/legacy.cjs：完整。说明 `.cjs` 在 `"type": "module"` 包中的必要性、createRequire 加载、CommonJS 默认导入互操作；解释 module.exports 与 padStart。
- packages/chord/test/examples/37-plugin-imports/deps/example-greeting/index.js：完整。说明 dependencies 内联规则（src/node/plugins/build.ts 的 dependencies 分支）；把同目录 package.json 的 name/version/private/type/main 作用写入文件头；解释 ES 模块导出与模板字符串。
- packages/chord/test/examples/37-plugin-imports/deps/example-native/index.js：完整。说明 `chord.external` 保持 external、求值时经插件 node_modules 的 createRequire 加载（src/node/plugins/evaluate.ts）；把同目录 package.json 字段作用写入文件头；解释 exports 属性赋值与真实 CJS 的 __filename。
- packages/chord/test/examples/37-plugin-imports/plugins/paths/server.ts：完整。说明 vm 求值无模块身份、build.ts 的 GLOBAL_MARKERS/freeGlobals 静态替换与扫描、pluginFile 的正确替代；把 package.json 作用写入文件头。
- packages/chord/test/examples/37-plugin-imports/plugins/refused/server.ts：完整。说明三类构建期禁止项（离开 root 的相对路径、import.meta、字面量动态 import）及 `void import()` 的含义；把 package.json 作用写入文件头。
- packages/chord/test/examples/37-plugin-imports/plugins/refused/other.ts：完整。说明它只是被拒绝动态导入的目标，从未执行。
- packages/chord/test/examples/37-plugin-imports/plugins/report/server.ts：完整。逐个 import 说明内置模块、Chord API、ESM/CJS 宿主包、dependencies、chord.external、同 root 复制契约；解释 pluginFile 运行时读 rates.json、`as` 断言的边界；把 package.json、data/rates.json、env.d.ts 的作用写入文件头；列出六段 text 的逐项结果。
- packages/chord/test/examples/37-plugin-imports/plugins/report/env.d.ts：完整。说明 ambient module 声明仅参与编译期、esbuild 不检查也不加载 .d.ts、根 tsconfig 的 include 覆盖 test 目录；逐模块对照 report/server.ts 的 import。
- packages/chord/test/examples/37-plugin-imports/plugins/ruler/server.ts：完整。说明同 root 相对路径导入会被复制、复制文件只允许宿主包与自身插件文件；把 package.json 作用写入文件头。
- packages/chord/test/examples/37-plugin-imports/plugins/shapes/contract.ts：完整。说明 contracts-only 插件（无 server facet）、local 契约声明、契约身份由 name + version 决定、schema 只校验方法参数而 state/结果不校验（据此修正了初稿）；把 package.json 作用写入文件头。
- packages/chord/test/examples/37-plugin-imports/plugins/shapes/units.ts：完整。说明普通 npm 包导入与“复制文件”规则的区别，以及 ruler 构建失败的原因；核对 pi-schema 的 `num({ minimum })` 只生成 schema、不做值校验。

验证：

- 注释前基线运行（packages/chord 目录）：
  `node --conditions=source --experimental-strip-types test/examples/37-plugin-imports/main.ts`
  输出 4 个启动失败插件、安装 2 个包、report 构建（read server.ts + shapes/contract.ts，copied 1）、reload added、最终 report 文本，全部符合预期。
- 注释后再次运行同一命令：流程与结果一致；构建错误行号因新增注释从 8/9/10 等后移（paths 28/30、refused 27/32/35、report 42、units 20），已在文件头注明行号随注释变化。示例用 `--experimental-strip-types` 解析了 main.ts、app/index.ts、contract.ts，并实际执行了 fake-npm.mjs 与 legacy.cjs；esbuild 构建解析了全部插件 TS 文件。
- `git diff --numstat -- packages/chord/test/examples/37-plugin-imports/`：14 个文件均为纯新增（删除行数为 0）；`git diff` 的删除侧为空。
- 未运行 `npm run check`（任务说明禁止）；未运行全仓测试。

## 未修改的数据/配置文件

- packages/chord/test/examples/37-plugin-imports/plugins/report/package.json：report 插件清单；discover.ts 读取 name/type，build.ts 读取 dependencies 与 `chord.external`，plugins.build(["@example/report"]) 使用 name。JSON 不能加注释，字段作用已写入同目录 server.ts 文件头。
- packages/chord/test/examples/37-plugin-imports/plugins/shapes/package.json：shapes 插件清单；discover.ts 读取 name 判定 contracts-only 插件。字段作用写入同目录 contract.ts 文件头。
- packages/chord/test/examples/37-plugin-imports/plugins/paths/package.json：paths 插件清单；discover.ts 读取 name。字段作用写入同目录 server.ts 文件头。
- packages/chord/test/examples/37-plugin-imports/plugins/refused/package.json：refused 插件清单；discover.ts 读取 name。字段作用写入同目录 server.ts 文件头。
- packages/chord/test/examples/37-plugin-imports/plugins/ruler/package.json：ruler 插件清单；discover.ts 读取 name。字段作用写入同目录 server.ts 文件头。
- packages/chord/test/examples/37-plugin-imports/deps/example-greeting/package.json：被当作 npm 依赖的本地包清单；fake-npm.mjs 按 `file:` 复制，build.ts 按 dependencies 内联，Node 按 type/main 解析。字段作用写入同目录 index.js 文件头。
- packages/chord/test/examples/37-plugin-imports/deps/example-native/package.json：chord.external 本地包清单；fake-npm.mjs 复制，evaluate.ts 运行时经 createRequire 加载。字段作用写入同目录 index.js 文件头。
- packages/chord/test/examples/37-plugin-imports/plugins/report/data/rates.json：report facet 运行时经 pluginFile + readFileSync + JSON.parse 读取的数据（`{ "vat": 20 }`）；读取方是 plugins/report/server.ts。JSON 不能加注释，用途已写入同目录 server.ts 文件头。

## 未完成或风险

- 新增中文注释会改变源码行号，示例运行时打印的构建错误行/列与注释前不同；语义不变，文件头已注明“行号随源码注释变化”，未在正文中固化具体行号。
- `env.d.ts` 不在运行时加载路径中，本次只用 Node 语法剥离与 esbuild 构建间接验证；未运行 tsc（任务禁止全仓检查）。
- 其余无。
