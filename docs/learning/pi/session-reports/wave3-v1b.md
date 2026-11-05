# 组 v1b

状态：完成

## 完成文件

- `packages/chord/src/old/connection.ts`：完整。逐段通读全文，并核对上下游类型与实现：`wire.ts` 的 `Frame`/`StateFrame`/`PROTOCOL_VERSION`/`toWireError`/`fromWireError`，`link.ts` 的 `Link`/`Packed`/`unpack`，`contract.ts` 的 `contractFromDescription`/`LOCAL_VARIANT`/`resolveHost`，`object.ts` 的 `RefImpl`/`variantOf`/`CtxImpl`/`ObjectImpl.call`，`host.ts` 的 `acquire`/`root`/`joinRoot`/`rootSent`/`relay`/`peerHello`/`connectionClosed`，`remote.ts` 的 `RemoteBinding`/`RemoteChannel`，以及 `delta` encoder 与 `schema` 的 `assertValid`。文件头写明所属包与模块、职责边界、上游入口与下游依赖、错误流向、按导出项的能力清单、真实签名的典型调用示例和建议阅读顺序；正文覆盖 `LinkOptions`/`AcceptOptions`/`Peer`、`Slot`/`Overflow`/`Feed`/`ServedLocal`、`RelayRef`/`RelayCall`、`Connection` 字段与构造函数、hello/ping/ack、hold/release/call/wantState、`send`/`sendState`/`#flush`/`#drop`/`#reschedule` 的流控、`#receive`/`#dispatch` 与全部 `#onXxx`（hold/release/call/result/state/shape/gone/sub/unsub/resync/ack/hello/ping/pong/bye/root_end/重载控制/vote）、`#closed`，以及文件末尾的 `relayCall`/`validateSnapshot`/`clientError`/`stateKey`/`unitKey`。最终通读修正了若干注释指向与措辞（Slot 字段、`#resetLater`、hold 帧条件展开、resync 的转发方向、root 退役的取消来源、`clientError` 的 `instanceof` 说明等），只改注释。修改量：1042 行新增、0 行删除；最终 2369 行。测试：`cd packages/chord && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/old/flow.test.ts test/old/flow-units.test.ts test/old/types.test.ts test/old/bindings.test.ts test/old/host.test.ts test/old/variants.test.ts test/old/cluster.test.ts test/old/state.test.ts`；结果 8 个文件、73 个测试全部通过（约 592ms）。

- `packages/chord/src/old/types.ts`：完整。逐行读完文件，并对照 `contract.ts` 的 `AnyContract`/`InputOf`/`Ref`、`object.ts` 的 `CtxImpl`/`Readable` 实现、`remote.ts` 与 `host.ts` 的消费方式，核对每个类型声明的语义和运行时边界。文件头写明这是 v1 公共类型层、哪些类型会在编译后擦除、实现分别落在哪些文件、wire 校验不在本文件、按导出项能力清单、`ctx.get`/`subscribe`/`onShape` 的真实签名示例和阅读顺序；正文覆盖 `GetOptions`、`Ctx`、`StateEvent`、`Readable`、`StateSource`、`EXPOSED`/`Exposed`、`RefStatus`、`Shape`、`RefBase`，并区分编译期类型检查与运行时校验（例如 `get` 的 input/placement/契约版本由 host 校验，类型系统不校验）。修改量：78 行新增、0 行删除；最终 192 行。由上述 `test/old/types.test.ts` 及其余 v1 测试的导入链覆盖。

- `packages/chord/src/old/index.ts`：完整。逐行读完聚合入口，核对每个 `export`/`export type` 的源模块与导出名（`../context`、`../delta`、`../json.ts`、`../watch.ts` 及 `./cell`、`./connection`、`./contract`、`./declare`、`./errors`、`./host`、`./link`、`./object`、`./registry`、`./reload`、`./state`、`./types`、`./websocket`、`./wire`）。文件头写明这是 v1 唯一聚合入口、仅重导出而无运行时副作用、导入不会创建宿主或网络、`export type` 与 `type` 说明符在编译后擦除、按导出组的能力清单、`createHost -> defineFacet -> host.load` 的真实调用示例和阅读顺序；正文为 11 个导出组补充了用途与注意事项。修改量：88 行新增、0 行删除；最终 196 行。文件本身无运行时逻辑，由引用该入口的 v1 测试导入链覆盖。

## 验证

- 语法与语义门禁：对三个文件分别用 `node_modules/.bin/esbuild <file> --minify --platform=node --format=esm` 与 `git show HEAD:<file>` 的同样输出比较，三个文件全部 `IDENTICAL`；说明注释没有进入字符串/模板，也没有改变代码结构或运行时行为。
- `git diff --numstat`：`connection.ts` 1042/0、`types.ts` 78/0、`index.ts` 88/0，三个文件均 0 删除行。
- 新增行检查：过滤 `+++` 后，所有新增行均为 `//`/块注释行（或注释块续行），没有非注释代码行。
- `git diff --check` 对三个文件退出码为 0，无空白错误。
- 相关测试：`test/old/flow.test.ts`、`flow-units.test.ts`、`types.test.ts`、`bindings.test.ts`、`host.test.ts`、`variants.test.ts`、`cluster.test.ts`、`state.test.ts`，8 个文件、73 个测试全部通过。
- 按任务要求未运行 `npm run check`、`npm run build`、全仓格式化、`npm install`，也未执行 `git add`/`commit`/`push`。

## 未完成或风险

- 只运行了与这三个文件直接相关的 8 个 v1 测试文件，未运行完整 Chord v1 测试矩阵；其余测试按任务限制未运行。
- 未修改覆盖清单、`STUDY_PROGRESS.md`、`STUDY_LOG.md` 或其他代理报告。
- `connection.ts` 的注释按源码当前行为编写；若上游代码后续变更，注释需要同步复核。
