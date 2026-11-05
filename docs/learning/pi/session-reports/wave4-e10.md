# 组 e10（Chord test/examples/36-plugin-failures）

状态：完成

## 完成文件

- packages/chord/test/examples/36-plugin-failures/main.ts：完整。文件头含示例系列与四幕演示、从 packages/chord 运行的命令、预期输出、插件清单与读取方式、能力清单（until/edit/buildDirty/print、六个契约、四幕）、真实签名示例、阅读顺序与相关文档；逐段解释临时副本、edit 的首次替换语义、契约绑定、createPlugins/createHost、load 报告、hold/get、四种坏编辑、staging/闭包规则、dirty 标记、修复后 parked、提交后取消（AbortController、isChordError、details.committed）、后续 reload 不回滚以及无 finally 的清理。核对了 `createPlugins`、`Plugins.build/reload/state/close`、`ship`（src/node/plugins/plugins.ts）、`BuiltFacet` 的 script/failed 标签（src/node/plugins/build.ts）、`createHost/load/hold/get/close`、`LoadReport/ReloadReport/PluginFailure`（src/host/host.ts）、`Held`/引用状态与 `watch`（src/host/attempt.ts、reference.ts）、`BACKGROUND_CONTEXT/withAbortSignal`（src/context/index.ts）、`local/int/str`（src/contracts）、`isChordError`（src/data）与 `mapStack`。
- packages/chord/test/examples/36-plugin-failures/plugins/boot/server.ts：完整。说明它是 @example/boot 的 server facet、被 main 在副本中插入顶层 throw 的求值期失败、package.json 的 name 身份；解释 defineFacet/host.serve/constant 与工厂时机。核对 defineFacet、host.serve、local/str、constant；报告中的映射行号为 boot/server.ts:21:7，文件头已注明该行号随上方注释行数变化。
- packages/chord/test/examples/36-plugin-failures/plugins/cache/server.ts：完整。说明两个对象（带 generation 参数的 Cache 与主机生命周期的 Status）、模拟 native 的 200ms opener、generation 换代、提交后取消；逐行解释 self.open/self.get/derive、参数在请求边界校验。核对 host.serve、ServeSelf.open/get/derive（src/host/attempt.ts）、params 的 checkParams（src/host/attempt.ts:538 附近）。
- packages/chord/test/examples/36-plugin-failures/plugins/counter/server.ts：完整。说明工厂阶段抛错的每插件失败与旧代码保留；解释 constant/int/local 与省略 self 的工厂。核对 defineFacet/host.serve 的真实签名。
- packages/chord/test/examples/36-plugin-failures/plugins/forecast/server.ts：完整。说明跨插件契约复制导入、Weather 未服务导致 failed/waiting；解释 self.get 的同步声明与 derive 的纯计算。核对 buildFacet 的 copied 机制（src/node/plugins/build.ts）与 self.get 的参数校验。
- packages/chord/test/examples/36-plugin-failures/plugins/greeter/label.ts：完整。说明它是被 server.ts 内联的普通模块而非 facet、watcher 把 label.ts 计入 greeter 的 inputs、语法错误与修复流程；解释 const 字面量类型。核对 buildFacet 的输入文件与复制规则。
- packages/chord/test/examples/36-plugin-failures/plugins/greeter/server.ts：完整。说明 Greeting 契约与来自 label.ts 的文本常量、构建失败时 setup 不执行；解释 defineFacet/host.serve/constant。核对真实签名。
- packages/chord/test/examples/36-plugin-failures/plugins/prices/contract.ts：完整。说明 Price 契约版本被 main 从 1 升到 2、summary 内联副本随之变脏；解释 local/int 的 schema 与按名称/版本/指纹绑定。核对 contracts/declare.ts 与 schema 行为。
- packages/chord/test/examples/36-plugin-failures/plugins/prices/server.ts：完整。说明 Price 的无参工厂、构建失败时旧价格继续服务、修复后金额改为 300；解释 constant/defineFacet。核对真实签名。
- packages/chord/test/examples/36-plugin-failures/plugins/summary/server.ts：完整。说明闭包规则与 parked：prices v2 构建失败时 summary 新代码无法绑定、保留旧代码，修复后先 parked 再 live；解释 self.get/derive 与 Price.version 来自构建副本。核对 host.reload 的 staging/commit 逻辑与 ReloadReport 的 objects fate。
- packages/chord/test/examples/36-plugin-failures/plugins/weather/contract.ts：完整。说明 contracts-only 契约文件被 forecast 复制导入、weather 未服务时 forecast 等待；解释 local/int 只声明 schema。核对 buildFacet 的跨插件复制。
- packages/chord/test/examples/36-plugin-failures/plugins/weather/server.ts：完整。说明启动 setup 抛错的每插件失败、其他插件继续、每次 reload 仍报告 weather；解释 string | undefined 的类型收窄（运行时夹具固定 undefined）与 setup 的失败边界。核对 defineFacet/host.serve 与 load/reload 的失败隔离。

验证：

- 注释前基线运行过一次；注释完成后从 packages/chord 运行两次：
  `node --conditions=source --experimental-strip-types test/examples/36-plugin-failures/main.ts`
  四幕流程与结果不变：启动 weather 被排除、forecast waiting；第 2 幕 greeter/prices 构建失败、boot 求值抛错、counter 工厂抛错、summary 因闭包规则保留旧代码，running 仍为旧值且 still dirty 列出五个插件；第 3 幕全部应用、summary 先 parked 后变为 "price v2: 300 cents"；第 4 幕 status reference 进入 loading、reload 以 aborted 拒绝且 committed.changed 为 ["@example/cache"]、随后 status 为 "cache v2"，再重载 greeter 后仍为 "cache v2 | greeting: hey"。
- 新增注释使源码行号后移，运行时打印的构建/求值错误行号随之变化：boot/server.ts:21:7、label.ts:16:34、prices/server.ts:21:85。语义未变；boot 文件头已注明当前行号及“随上方注释行数变化”，其余文件头未固化具体行号。仓库中没有测试引用该示例的固定输出（grep 未发现）。
- `git diff --numstat -- packages/chord/test/examples/36-plugin-failures/`：12 个 TS 文件；main.ts 93 增 1 删（删除的是本次早先写错的注释）、summary/server.ts 23 增 1 删（替换旧中文注释），其余均为纯新增。逐行检查新增内容均为注释或空行，删除侧只有注释，未改动任何原始代码、类型、字符串、模板或配置。
- `git status --porcelain -- packages/chord/test/examples/36-plugin-failures/plugins/*/package.json` 无输出，确认 8 个清单未被修改。
- 未运行 `npm run check`、`npm run build` 或全仓测试（任务说明禁止）；示例本身不访问网络、不读取真实凭证、不调用模型，临时副本在末尾递归删除。

## 未修改的数据/配置文件

- packages/chord/test/examples/36-plugin-failures/plugins/boot/package.json：`{"name":"@example/boot","private":true,"type":"module"}`；discoverPlugins 读取 name 作为插件身份，private 防止误发布，type 声明 ESM。JSON 不能加注释，字段作用写入同目录 server.ts 文件头。
- packages/chord/test/examples/36-plugin-failures/plugins/cache/package.json：`@example/cache` 清单，读取方同上；作用写入同目录 server.ts 文件头。
- packages/chord/test/examples/36-plugin-failures/plugins/counter/package.json：`@example/counter` 清单，读取方同上；作用写入同目录 server.ts 文件头。
- packages/chord/test/examples/36-plugin-failures/plugins/forecast/package.json：`@example/forecast` 清单，读取方同上；作用写入同目录 server.ts 文件头。
- packages/chord/test/examples/36-plugin-failures/plugins/greeter/package.json：`@example/greeter` 清单，读取方同上；作用写入同目录 server.ts 与 label.ts 文件头。
- packages/chord/test/examples/36-plugin-failures/plugins/prices/package.json：`@example/prices` 清单，读取方同上；作用写入同目录 server.ts 与 contract.ts 文件头。
- packages/chord/test/examples/36-plugin-failures/plugins/summary/package.json：`@example/summary` 清单，读取方同上；作用写入同目录 server.ts 文件头。
- packages/chord/test/examples/36-plugin-failures/plugins/weather/package.json：`@example/weather` 清单，读取方同上；作用写入同目录 server.ts 与 contract.ts 文件头。

## 未完成或风险

- 注释改变了插件源码行号，示例打印的错误位置与上游不同；这是注释-only 改动的预期副作用，不是行为变化。boot 文件头中的 21:7 与当前注释行数绑定，若以后增删该文件上方注释需同步更新。
- 仅实际运行了该示例（Node strip-types 解析 main.ts，esbuild 构建全部插件）；未运行 tsc/`npm run check`（任务禁止），未运行全仓测试。
- 未接入真实天气服务、凭证或模型；weather 的失败是示例故意设计的夹具。
- 8 个 package.json 按任务要求保持未修改；其字段用途只写在同目录代码文件头与本报告中。
