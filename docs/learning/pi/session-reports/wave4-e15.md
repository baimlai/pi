# 组 e15（Chord test/examples/50-52）

状态：完成

## 完成文件

共注释 21 个 TypeScript 文件。`git diff --shortstat`：21 files changed, 441 insertions(+)，无删除、无重排；8 个 JSON 文件未改动。

### 50-plugin-imports

- packages/chord/test/examples/50-plugin-imports/main.ts：完整。文件头含系列/所属、演示内容、上下游、git/npm 副作用与失败时保留临时目录、运行命令、四组预期输出、按步骤的能力清单、真实签名示例和阅读顺序；逐行解释临时副本、两次提交与钉住的哈希、`git clone --bare`、`JSON.parse` 的编译期断言、createPlugins 配置（required 根、api/kinds/hostPackages、onError）、installDependencies、PluginError/`error.failed`、host.get、BuiltFacet 的 `script` 收窄与 `copied`、清理。核对 `createPlugins`/`Plugins`（src/node/plugins/plugins.ts）、`PluginRoot`/`PluginError`/`BuiltFacet`（src/node/plugins/{discover,build}.ts）、`Field`/`run`/`local`（src/contracts）等真实签名。
- plugins/notes/contract.ts：完整。说明契约是纯数据、不是 facet，供同根相对导入；解释 local 的 name/version/schema、共享契约身份；核对 build.ts 对直接导入 Chord 的拒绝规则。
- plugins/notes/contract.web.ts：完整。说明 `.web.` 按种类文件的可见范围；解释 `as const` 只收窄编译期类型、运行时不冻结。
- plugins/notes/server.ts：完整。说明 package.json 的 name/private/type 三个字段与 discovery 的关系；解释 `constant`/`defineFacet`/`host.serve`；把 package.json 的角色写入文件头。
- plugins/peek/server.ts：完整。说明经 view.ts 间接导入 web 文件遭遇的拒绝及错误链；解释默认导出 facet 与构建失败导致 setup 从未执行；把 package.json 角色写入文件头。
- plugins/peek/view.ts：完整。说明 re-export 仍会被构建器跟随；解释 `export { x } from` 不创建本地绑定。
- plugins/search/server.ts：完整。说明同根跨插件契约复制、`self.get` 依赖与 `self.derive` 纯函数；固定文本按逗号切分得到 hits=3；把 package.json 角色写入文件头。
- plugins/search/web.ts：完整。说明 web facet 合法导入 web 文件、向 Panels 贡献；解释模板字符串与注册表贡献的加载期生命周期。
- user/reach/server.ts：完整。说明跨根相对路径被拒及错误提示（经应用 API 或 dependencies）；把 package.json 角色写入文件头。
- user/stats/env.d.ts：完整。说明 ambient module 只参与编译期、esbuild 不检查也不打包 `.d.ts`；逐项解释 VERSION 与 words 的声明。
- user/stats/server.ts：完整。说明 dependencies 内联规则、安装提交固定为版本 1、`words("buy milk, call bob") === 4`；解释包名导入不进入宿主 modules；把 package.json 的占位 git URL 与替换过程写入文件头。
- words/words.ts：完整。说明该包被提交两次、示例钉在第一个提交；解释字面量类型、`/\s+/` 与 `filter(Boolean)`。

### 51-single-file-plugin

- main.ts：完整。文件头含单文件插件规则、同名文件合成一个插件、转目录后的原位 reload、副作用（只写临时目录）、运行命令、预期输出、三步能力清单、真实签名示例和阅读顺序；逐行解释 `until` 轮询、discovery 的 facets、loaded.failed、目录改造的 `mkdir`/`writeFile`/`rm`、watcher 标记 `set`/`dirty`、build/reload 的报告与可选链读取 layout。
- plugins/bad.server.ts：完整。说明单文件插件只能导入宿主包，构建错误提示改成目录；解释失败后 setup 不执行。
- plugins/clock.server.ts：完整。说明可导入本种类模块 `@acme/app/v3/server`，宿主包求值时由宿主提供而不打进脚本。
- plugins/hello.server.ts：完整。说明 `<name>.<kind>.ts` 的发现规则、与 hello.web.ts 同属插件 hello、契约内联声明。
- plugins/hello.web.ts：完整。说明同首名合并、web 种类模块 Panels 的贡献。
- plugins/helper.ts：完整。说明文件名无 kind 段因而不是插件，单文件插件导入它会被拒。

### 52-test-plugin

- main.ts：完整。文件头含 testPlugin 的生产级构建、真实 API 模块、内存宿主、stubs、contributions/unserved、principal、副作用与必须 close、运行命令、预期输出、六步能力清单、真实签名示例和阅读顺序；逐行解释三个契约的重新声明、Principal 可辨识联合、`defineFacet<Principal>` 桩、testPlugin 配置、host.get、contributions、hold + RefState、unserved、t.root 的两种身份、`as const`。
- plugins/notes/contract.ts：完整。说明该目录只含契约、运行时由 main.ts 的桩提供；解释参数/成员 schema 的检查时机；把 package.json 角色写入文件头。
- plugins/stats/worker.ts：完整。说明 Indexers 贡献、Stats 对 Notes 的依赖与派生、TagLine 对无人服务的 Tags 的等待；解释同根相对导入复制、`self.contribute`/`self.get`/`self.derive`、模板字符串在 derive 计算时求值；把 package.json 角色写入文件头。

验证：

- packages/chord 目录下实际运行（均为注释后最终状态）：
  - `node --conditions=source --experimental-strip-types test/examples/50-plugin-imports/main.ts`：通过。输出依赖钉住的本地裸仓库哈希、PluginError（peek 的 web 文件跨种类链、reach 的跨根相对路径）、`search hits: 3`、`stats: 4 words (@bob/words 1)`，以及 search server/web 两个 facet 各自的 copied 文件。临时目录内的 git 提交与 npm install 均实际执行。
  - `node --conditions=source --experimental-strip-types test/examples/51-single-file-plugin/main.ts`：通过。三个单文件插件的发现与 bad 的拒绝信息、两个对象的文本、watcher 标记（set=true，dirty 含 bad/hello）、reload changed=[hello] 且文本变为目录版、layout=directory，均与文件头预期一致。
  - `node --conditions=source --experimental-strip-types test/examples/52-test-plugin/main.ts`：通过。`words in p1: 7`、Indexers 贡献 `word count (@acme/stats)`、unserved 为 `acme.tags` 且 tag line 为 failed、两种 principal 的输出，均与文件头预期一致。
- `git diff --numstat` 检查：21 个文件删除行数均为 0；8 个 package.json 未出现在 diff 中。
- 按任务说明未运行 `npm run check`、`npm run build`、全仓格式化或完整测试套件；未执行 git add/commit/push。

## 未修改的数据/配置文件

以下 JSON 均不能加注释；字段作用已写入同目录主代码文件的文件头。

- packages/chord/test/examples/50-plugin-imports/plugins/notes/package.json：notes 插件清单；discover 读取 name 作为插件身份，private 防止误发布，type=module 决定模块解析。读者是 discover/install/build；说明写入 notes/server.ts 文件头。
- packages/chord/test/examples/50-plugin-imports/plugins/peek/package.json：peek 插件清单；作用同上，说明写入 peek/server.ts。
- packages/chord/test/examples/50-plugin-imports/plugins/search/package.json：search 插件清单；作用同上，说明写入 search/server.ts。
- packages/chord/test/examples/50-plugin-imports/user/reach/package.json：用户根中的 reach 插件清单；discover 读取 name，说明写入 user/reach/server.ts。
- packages/chord/test/examples/50-plugin-imports/user/stats/package.json：Bob 的 stats 插件清单；dependencies 中的 @bob/words 是占位 git URL，main.ts 第 1 步会替换为本地裸仓库与第一个提交哈希，npm 与 build 读取该字段；说明写入 user/stats/server.ts。
- packages/chord/test/examples/50-plugin-imports/words/package.json：本地依赖包 @bob/words 的清单；npm 按 exports 解析 ./words.ts，build 按安装版本内联；说明写入 words/words.ts。
- packages/chord/test/examples/52-test-plugin/plugins/notes/package.json：notes 契约目录的清单；testPlugin 的发现读取 name，说明写入 plugins/notes/contract.ts。
- packages/chord/test/examples/52-test-plugin/plugins/stats/package.json：被测 stats 插件清单；testPlugin 构建时读取 name，说明写入 plugins/stats/worker.ts。

## 未完成或风险

- 中文注释改变了源码行号，示例打印的构建错误行列与注释前可能不同；文件头未固化具体行列号。
- 示例 50 依赖本机 git、npm 与 `--experimental-strip-types`；示例 52 依赖 Node 的内存 SQLite 支持。本次环境满足并全部运行通过，换环境时可能因缺少这些前提失败。
- env.d.ts 只参与 TypeScript 编译期，不在示例运行时路径中；本次通过示例运行间接验证插件可构建，未运行 tsc（任务禁止全仓检查）。
- 其余无。
