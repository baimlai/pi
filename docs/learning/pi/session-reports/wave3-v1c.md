# 组 v1c

状态：完成

## 完成文件

- `packages/chord/src/old/host.ts`：完整；核对了 `Host`/`HostOptions`/`Serve`/`FacetApi`/`CodeVersionState` 的公开签名，以及被调用方 `object.ts`（`HostCore`、`ObjectImpl`、`RefImpl`、`Factory`、`awaitReady`）、`connection.ts`（`accept`/`connect`/`peerHello`/`rootSent`/`foreignRootEnded`/`relay`）、`remote.ts`（`RemoteBinding`/`RemoteRef`/`bindingIdle`/`forgetBinding`）、`reload.ts`/`cluster.ts`（`runReload`/`runClusterReload`/`ChildReloads`）、`contract.ts`（`bind`/`resolveHost`/`placedOn`）、`schema.ts`（`normalize`/`canonicalIdentity`/`deepEqual`）的实际行为。文件头写明所属模块、职责边界、上游入口/下游依赖、按导出项的能力清单、典型调用顺序、真实签名示例（`createHost` + `serve`/`get`/`hold`/`root`/`reload`/`close`，并注明 `loader` 在 `createHost` 配置）和建议阅读顺序；全部类型字段、`HostImpl` 字段、公开方法与内部辅助函数均有中文说明。修正了草稿中两处不准确表述：`foreignRootEnded` 在根仍在本地运行时实际删除 `#foreign` 标记；`acquire` 的环检测条件是“B 可到达 A”而非相反。修改量：407 行新增、0 行删除。

- `packages/chord/src/old/loader.ts`：完整；核对了 `FacetLoader`/`Facet`/`FacetDefinition` 来自 `host.ts` 的签名、`Host.resolve` 对 loader 返回顺序的依赖、`test/old/loader.test.ts` 与 `test/old/fixtures/loader.ts` 的子进程用法，以及 `node:module` 的 `registerHooks` 同步 resolve 钩子。文件头写明 Node 专用入口（`@earendil-works/chord/old/node`）、职责边界（不做隔离/缓存回收，见原有 `TODO(loader)`）、上下游、`nodeLoader`/`hook`/`toUrl`/`PARAM`/`roots`/`generation` 能力清单、调用顺序、真实签名示例和阅读顺序；`nodeLoader` 内部逐行补充了入口顺序、目录登记、URL 查询参数与 default 校验说明。修改量：31 行新增、0 行删除。

- `packages/chord/src/old/publish.ts`：完整；核对了 `enqueue`/`holdPublications` 的真实调用方 `cell.ts`（状态通知与 `holdPublications`）、`object.ts`（形状/状态/监听通知）、`host.ts`（`installTables` 的注册表通知）、`reload.ts`（提交阶段暂停发布）。文件头写明进程内 FIFO 的职责边界（同步发送、不捕获异常、模块级单例）、上下游、三个能力项、典型顺序、真实签名示例（`holdPublications` 包裹两次 `enqueue`）和阅读顺序；`enqueue`/`holdPublications`/`drain` 及模块级状态均有逐行说明。修改量：29 行新增、0 行删除。

测试命令与结果（均在 `packages/chord` 下执行，未运行 `npm test`、`npm run check`、`npm run build` 或全仓格式化）：

- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/old/host.test.ts test/old/loader.test.ts`：2 个文件通过，27 个测试通过（host 25、loader 2），约 460ms。
- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/old/state.test.ts`：1 个文件通过，7 个测试通过，约 307ms；该文件经由 `cell.ts`/`object.ts` 间接覆盖 `publish.ts` 的排队与发送顺序。

## 未完成或风险

- `packages/chord/src/old/loader.ts`：`loader.test.ts` 只验证了夹具场景（重载取得新模块、跨 facet 相对导入共享），未验证所有 Node 版本的 `module.registerHooks` 可用性、模块顶层异常和缓存泄漏；`TODO(loader)` 明确说明旧模块不会被回收，这是实现现状而非注释遗漏。
- `packages/chord/src/old/publish.ts`：没有独立的 publish 测试文件；队列顺序与暂停行为由 `state.test.ts` 及 host/cluster 相关测试间接覆盖，未单独构造“回调中再次写入”的精确用例。
- `packages/chord/src/old/host.ts`：未运行 Chord 全量测试（任务禁止 `npm test`，且其他文件正由并行代理修改）；本次仅运行上述 3 个离线、快速的测试文件。源码未改动，`git diff --numstat` 三个文件均为纯新增、0 删除；未修改覆盖清单、进度、日志或其他代理报告。
