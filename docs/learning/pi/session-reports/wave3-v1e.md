# 组 v1e

状态：完成

## 完成文件

- `packages/chord/src/old/manager.ts`：完整。核对了 `node:child_process` 的 `fork`/`ChildProcess`、`node:net` 的 `createServer`/`connect`、`node:fs/promises` 的 `lstat`/`mkdir`/`rm`、`link.ts` 的 `IpcChannel`/`IpcLink`/`ipcLink`、`errors.ts` 的 `ChordError`，以及 `test/old/manager.test.ts` 与 `test/old/fixtures/worker.ts` 的真实用法。文件头写明所属模块、职责边界（只做进程生命周期与控制通道，不实现协议帧）、上下游、按导出项的能力清单、父子进程典型调用顺序、真实签名示例和建议阅读顺序；`ControlMessage`/`Liveness`/`Exit`/`Instance`/`Driver`/`ForkDriverOptions` 的字段含义、`processLock` 的平台地址与 EADDRINUSE 分支、`forkDriver` 的进程组与消息路由、`createHostManager` 的串行队列/ready 竞争/宽限关闭/keepAlive、`childControl` 的 init/lock/ready/fatal/report/onShutdown 均有逐行中文说明。修改量：247 行新增、0 行删除。

- `packages/chord/src/old/contract.ts`：完整。核对了 `@earendil-works/pi-schema` 的 `obj`/`map`/`opt`/`union`/`lit`/`int`/`str`/`Static`，`schema.ts` 的 `canonicalJson`/`fits`/`hash64`/`isValid`，`types.ts` 的 `Ctx`/`Exposed`/`Readable`/`RefBase`/`StateSource`，`object.ts` 的 `viewOf` 中 accepts 适配器执行位置，以及 `test/old/contract.test.ts`。文件头写明职责边界（只声明、描述、比较契约，不创建对象或执行方法）、上下游、按导出项的能力清单、典型绑定顺序、`ctx.get`/`ref.add` 真实签名示例和阅读顺序；方法/不透明值声明、放置方式、描述 schema、指纹、`remote`/`local`、`contractFromDescription`、`coverage`/`bind` 的方向规则，以及 `Ref`/`ImplementationOf`/`Call` 等条件类型均有中文说明。修正了草稿中的三处不准确表述：文件头示例改用已导入的 `int()`；`StringKeys` 说明可选字段因含 `undefined` 通常不通过；`RESERVED_MEMBERS` 的检查位置改为 `describeMember`。修改量：273 行新增、0 行删除。

- `packages/chord/src/old/state.ts`：完整。核对了 `delta` 的 `track`/`Draft`/`Prepared`/`Op`/`Tracker`、`context` 的 `Context`/`BACKGROUND_CONTEXT`，以及 `test/old/replicated-state.test.ts`、`test/old/replicated-state-delivery.test.ts` 中 hydration、重入发布、100 帧溢出、source cursor、onError 隔离的用例。文件头写明可变/附加两种模式的边界、上下游、导出能力清单、典型发布/订阅顺序、`replicatedState` 示例和阅读顺序；`StateSubscriber` 的串行队列与异步等待、`ReplicatedStatePublisher` 的 hydrate 先于 update 与重入发布、两个 Impl 的 change/replace/attach/dispose、cursor 连续性校验、错误归一与默认异步上报均有逐行说明。修正了草稿中将重载当作运行时分派的表述，并明确 `change` 回调返回 Promise 时同步抛 `TypeError`。修改量：213 行新增、0 行删除。

- `packages/chord/src/old/link.ts`：完整。核对了 `wire.ts` 的 `Frame`、`websocket.ts` 对 `webSocketLink` 的选项用法，以及 `test/old/link.test.ts`、`test/old/links-review.test.ts`、`test/old/websocket.test.ts` 对排队、bye、Packed 负载、二进制 WebSocket 消息的覆盖。文件头写明内存/IPC/WebSocket 三种传输的边界、上下游、导出能力清单、发送/接收/关闭顺序、`memoryLinkPair` 示例和阅读顺序；`Link`/`BaseLink` 的接收者与关闭语义、打包阈值与 `Packed`/`unpack`/`packObject`/`packMessage`/`splitMessage`、`MemoryLink`/`IpcLink`/`WebSocketLink` 的 transmit/shutdown 与错误路径均有逐行说明。修正了草稿中关于 WebSocket `binaryType`、CONNECTING 阶段发送、`if/else` 注释位置的表述。修改量：181 行新增、0 行删除。

## 验证

均在 `packages/chord` 下执行，未运行 `npm test`、`npm run check`、`npm run build`、全仓格式化或任何 Git 写操作：

- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/old/link.test.ts test/old/links-review.test.ts test/old/websocket.test.ts`：3 个文件通过，38 个测试通过，约 613ms。
- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/old/contract.test.ts test/old/replicated-state.test.ts test/old/replicated-state-delivery.test.ts`：3 个文件通过，48 个测试通过，约 726ms。
- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/old/manager.test.ts`：1 个文件通过，9 个测试通过，约 1.94s（包含 fork 子进程、进程锁、宽限关闭与 keepAlive 用例）。
- 注释不改语义的验证：对每个文件用 `esbuild --format=esm --minify` 分别压缩 `git show HEAD:<file>` 与工作区版本，四个输出两两 `cmp` 均相同（`IDENTICAL`），说明新增内容只被当作注释擦除，没有进入字符串或改变代码结构。
- `git diff --numstat`：`manager.ts` 247/0、`contract.ts` 273/0、`state.ts` 213/0、`link.ts` 181/0，四个文件均 0 删除；只修改了任务清单内的四个文件，未修改覆盖清单、进度、日志或其他代理报告。

## 未完成或风险

- `link.ts` 的浏览器异步解压分支（`zlib === undefined` 时使用 `Blob`/`DecompressionStream` 的 `inflate`）在 Node 测试环境中不会触发；`inflateMessage` 与压缩发送路径有测试覆盖，但无 zlib 的浏览器分支只按平台 API 语义注释，未在本次运行中执行。
- `manager.ts` 的平台分支受运行环境限制：本次测试在 macOS 上执行，覆盖文件 socket 锁与进程组清理；Windows 命名管道、Linux/Android 抽象 socket 以及旧平台残留文件接管分支未实际运行。
- 未运行 Chord 全量测试和跨包检查：任务禁止 `npm run check`/`npm run build`/`npm test`，且并行代理正在修改同一目录的其他文件，全量验证应由协调者在本轮注释完成后统一执行。
- 四个文件的注释均基于当前 HEAD 的源码与已读测试；若后续上游改动这些文件，需要按学习分支规则重新核对受影响说明。
