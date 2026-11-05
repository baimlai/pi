# 组 g10

状态：完成

## 完成文件

所有文件均只插入中文注释，未修改、删除或重排任何原有代码行；每个文件头均已按新标准扩写为“文件导读”（所属模块、职责边界、上下游、结果/错误流向、能力清单、组合顺序、真实签名示例、阅读顺序）。逐文件用 `/tmp/g10/verify.py` 与 `git show HEAD:<path>` 对比，确认原有行按序完整保留；`git diff --check` 无空白错误；11 个文件合计新增 1603 行注释，无删除行。

- `/Users/baiml/PycharmProjects/pi/packages/chord/src/node/plugins/build.ts`：完整。核对了 esbuild 的 BuildFailure/Plugin/onResolve/onLoad/outputFiles、BuiltFacet/AppApi/BuildInput/BuildOptions、ImportRules/Place/Resolution、SCOPE CSS 与 inlineSourceMap；文件头示例使用真实 `buildFacet` 签名。测试：与 discover/evaluate/runtime/stack 一起运行 `cd packages/chord && node <repo>/node_modules/vitest/dist/cli.js --run test/node/plugins/build.test.ts test/node/plugins/discover.test.ts test/node/plugins/evaluate.test.ts test/node/plugins/runtime.test.ts test/node/plugins/stack.test.ts`，5 个文件共 64 个用例通过。
- `/Users/baiml/PycharmProjects/pi/packages/chord/src/node/plugins/css-modules.ts`：完整。核对了 `scopeCssModule` 的前缀哈希、esbuild `local-css` loader、虚拟 `scoped:` 命名空间、vm 读取 classes、SCOPED_CSS/ScopedCss；说明 url()/@import 留给 facet 构建解析。测试：由 build.test.ts 的 CSS module 用例覆盖，随上条通过。
- `/Users/baiml/PycharmProjects/pi/packages/chord/src/node/plugins/discover.ts`：完整。核对了 discoverPlugins/discoverPackage、Plugin/PluginRoot/Discovery/DiscoveryProblem、FACET_EXTENSIONS、sameFiles、packageAt/manifest/glob/单文件插件规则及 ENOENT 错误流。测试：随上述 5 文件核心层命令通过（64 个用例全部通过）。
- `/Users/baiml/PycharmProjects/pi/packages/chord/src/node/plugins/evaluate.ts`：完整。核对了 vm.Script、createRequire/isBuiltin、HostPackages、BuiltScript、interop、pluginFile/fileOf、refusedAtRun/versionOf/packageName，以及成功/抛错两条 registerScript 路径。测试：随上述 5 文件核心层命令通过。
- `/Users/baiml/PycharmProjects/pi/packages/chord/src/node/plugins/index.ts`：完整。逐项核对了所有再导出与来源文件；修正了“仅导入本出口不会加载 esbuild”的错误说法：重导出 `buildFacet` 会加载 build.ts 的顶层 esbuild 导入，纯 worker 求值应使用 `./plugins/runtime` 入口。无独立测试；其导出被 build/discover/evaluate/runtime/stack/testing 测试间接覆盖。
- `/Users/baiml/PycharmProjects/pi/packages/chord/src/node/plugins/install.ts`：完整。核对了 spawn、npm install 参数、--ignore-scripts、git clone/fetch/checkout、tar 解包、mkdtemp/rename/rm 暂存与回滚、targetName/claim、discoverPackage 检查和拒绝选项注入的安全规则。测试未运行，原因见下。
- `/Users/baiml/PycharmProjects/pi/packages/chord/src/node/plugins/plugins.ts`：完整。核对了 createPlugins、Plugins 接口、Batch、PluginWatcher、PluginRuntime、Built/MarkSnapshot WeakMap、ship/builtOf、rollout 的 failed/shipped 规则、#discover/#set/#buildOne 的缓存与并发语义；修正 `used([built])` 的失败构建关联说明。测试未运行，原因见下。
- `/Users/baiml/PycharmProjects/pi/packages/chord/src/node/plugins/runtime.ts`：完整。核对了 createPluginRuntime、setFlagsFromString 关闭 V8 编译缓存、RuntimeLoad/PluginScript、LoadedFacets/SetEntry/Prepared、必选插件 PluginError 的抛出时机、load/reload 完整集合语义。测试：随上述 5 文件核心层命令通过。
- `/Users/baiml/PycharmProjects/pi/packages/chord/src/node/plugins/stack.ts`：完整。核对了 SourceMap、内联 source map 解析、FinalizationRegistry 计数、mapStack 对任意捕获值的降级；说明注册表使用模块级 Map 的原因。测试：随上述 5 文件核心层命令通过。
- `/Users/baiml/PycharmProjects/pi/packages/chord/src/node/plugins/testing.ts`：完整。核对了 testPlugin 的版本化 API 校验、rootOf/kindsNamedIn/pluginIn、buildFacet/evaluateFacet、openStore+sqlite :memory:、createHost/load、collect/settle/olderAs、TestedPlugin 的 contributions/unserved/root/close；修正了失败清理时“原错误一定重抛”的错误说明（关闭本身抛错会取代原错误）。测试：`testing.test.ts`，8/8 通过。
- `/Users/baiml/PycharmProjects/pi/packages/chord/src/node/plugins/watcher.ts`：完整。核对了 fs.watch/lstatSync/readdirSync/realpathSync、Source/Batch/queueMicrotask 合批、inside/sameFiles、PluginsState/MarkSnapshot/DiscoverySnapshot、#markPlugin 各分支、#watchDirs/#changedIn/#unwatchDirs/#failed、链接环处理；修正了单文件 facet 删除、顶层 facet 文件变化、used 关联清理和缺失树不自动重试等表述。测试未全通过，见下。

## 未完成或风险

- `watcher.test.ts` 未全通过。命令：`cd /Users/baiml/PycharmProjects/pi/packages/chord && node <repo>/node_modules/vitest/dist/cli.js --run test/node/plugins/watcher.test.ts`。第一次结果 3 failed / 8 passed / 1 skipped，第二次 4 failed / 7 passed / 1 skipped；失败均为 5 秒超时，集中在真实 fs.watch 事件用例（`marks from real file events`、`watches a directory that appears later`、`survives a link loop`），另有一次同文件的 install 标记用例受超时用例遗留监视器干扰。单独运行该 install 用例（`-t "drops the install mark"`）通过；`PluginWatcher` 在 Vitest 之外的独立 Node 脚本能收到 fs.watch 事件并产生 dirty。由于本次差异只有注释（verify 逐行确认原代码未变），这些失败不是注释改动导致的；但未能在此环境证明该测试文件全绿。
- `install.test.ts` 未运行：用例会启动 npm/git/tar 子进程并创建本地仓库/包，耗时且不属于快速离线验证范围；安装相关注释基于源码与类型核对，未用测试结果背书。
- `plugins.test.ts` 未运行：包含端到端 server/worker 发布、200 次 reload 的 GC 和真实构建流程，超出本组快速离线测试范围；组件层注释基于源码、被调用类型和 core 测试核对完成，未声称该文件测试通过。
- 按任务要求未运行 `npm run check`、`npm run build`、全仓格式化、`git add/commit/push` 或 `npm install`；未修改覆盖清单、进度、日志或其他代理报告。
