# 组 g17

状态：完成

## 完成文件

- packages/chord/src/link/binary.ts：完整；文件头含模块、边界、能力清单、调用顺序、真实签名示例与阅读顺序。核对 Message/Codec/Part/DeflatedPart/CAUSE_KINDS/NO_RETIRED、Writer/Reader、values.ts 的 parseJson/readUtf8 与 varint/长度槽/压缩位格式；注释仅新增，未改编码。
- packages/chord/src/link/channel.ts：完整；核对 Link、Codec、checkMessage、PROTOCOL_VERSION、Context 与 ChannelHandler/ChannelState 三态、异步按序队列和心跳路径；修正了 ping 与异步等待关系的表述。
- packages/chord/src/link/errors.ts：完整；核对 ChordError/isChordError/PluginError、chordErrorFromJson、JsonValue 与 message.ts 的 WireError；示例与 PluginError(code, message, details) 签名一致。
- packages/chord/src/link/index.ts：完整；逐项核对再导出集合与来源文件，示例使用 memoryLinkPair + binaryCodec，未编造 API。
- packages/chord/src/link/internal.ts：完整；逐项核对 barrel 导出；文件头注明 Link 从本文件导出、但 ipcLink/webSocketLink/memoryLinkPair 只在 index.ts 导出。
- packages/chord/src/link/ipc.ts：完整；核对 LinkEnd、IpcPort 的 send/on/removeListener/disconnect/connected，以及 send 返回 false 仅表示背压；示例与 fork/process 用法一致。
- packages/chord/src/link/link.ts：完整；核对 memoryLinkPair、LinkEnd.deliver/ended、queueMicrotask 与 MemoryLink 关闭顺序；原有英文文档保留。
- packages/chord/src/link/message.ts：完整；核对了整个 MESSAGE schema、WireMessage/OriginMessage/ProviderMessage/ConsumerMessage/BoundEntry/StateEntry 的推导、NO_RETIRED、CHAIN/RETRY_HOPS/CAUSE_KINDS 与 checkMessage 的 validatorFor/遥测计数；修正了 checkMessage 失败时“抛错而非返回 false”的表述。
- packages/chord/src/link/part.ts：完整；核对 Part/Inflated/DeflatedPart/Compression/PartLimits/Limits、linkLimits、originPart、oversized、openPart、sizeOf、inflateAsync（DecompressionStream、abort、too_large/corrupt）；示例错误构造与 ChordError(too_large/part) 一致。
- packages/chord/src/link/text.ts：完整；核对标签表与 encode/decode、partText/textPart、payload 段长度、fromTuple/fromFields 的 arity 与 origin 包装、CAUSE_KINDS 首字母；修正了 decode 调用顺序中 checkMessage 的归属说明和 rest 变量混淆。
- packages/chord/src/link/values.ts：完整；核对 jsonPart/payloadPart 的 replacer 与 $bytes 保留、parsePart/parsePayload、resolveSegments 的 __proto__ 处理、partText/textPart、STRICT_UTF8、base64；示例与 payloadPart 真实签名一致。
- packages/chord/src/link/websocket.ts：完整；核对 WebSocketLike、webSocketLink、CONNECTING/OPEN、连接期队列、ArrayBuffer 边界检查、close/error 监听器保留策略；示例与 readyState=0 时入队行为一致。

验证：

- `git diff -U0 -- packages/chord/src/link/ | grep '^-' | grep -v '^---'` 无输出：12 个文件仅新增 1087 行注释，无删除或改写原有代码行。
- `grep -rn "【\|中文学习\|学习】\|中文导读\|中文主线" packages/chord/src/link/` 无输出。
- 运行 `cd packages/chord && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/link/channel.test.ts test/link/errors.test.ts test/link/ipc.test.ts test/link/link.test.ts test/link/message.test.ts test/link/part.test.ts test/link/values.test.ts test/link/websocket.test.ts`：最终 8 个测试文件、218 个测试全部通过。
- 用 `node --experimental-strip-types --input-type=module -e 'await import("./src/link/internal.ts")'` 单独确认 link 入口可解析并加载全部导出。

## 未完成或风险

- 未运行 `npm run check`、`npm run build` 或全仓格式化：任务说明明确禁止；因此类型检查与构建结果未验证。
- 本组清单均为 `packages/chord/src/link/` 源码，没有测试文件，故不需要测试文件头（被测模块、夹具、行为分组、运行命令）模板。
- 一次测试运行曾因并行代理正在编辑 `packages/chord/src/host/reference.ts` 而报 `SyntaxError: Private field '#member' must be declared in an enclosing class`（6 个 link 测试文件因此 0 test）；该文件不属于 g17，未做修改，稍后重跑已 218/218 通过。共享工作区中其他代理仍在改动 chord 源码，后续全量检查需在其完成后进行。
