# 组 g09

状态：完成

## 完成文件

- /Users/baiml/PycharmProjects/pi/packages/chord/src/remote/calls.ts：完整；核对 CallWindow/QueuedCall 与 ConsumerSide 的调用关系；`test/remote/calls.test.ts` 通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/remote/consumer.ts：完整；核对 ConsumerSide 对 HostLink、CallWindow、RemoteObject、link 消息工具的实际调用；`test/remote/consumer.test.ts` 通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/remote/hold.ts：完整；核对 Host.place/serving、ChordObject 状态、Source 订阅、Delta encoder、ProviderSide 窗口接口；修正 principal! 的来源说明（连接盖章身份，而非放置阶段保证）；`test/remote/hold.test.ts` 通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/remote/host-link.ts：完整；核对 Channel 握手/消息顺序、ProviderSide 按 origin 创建、ConsumerSide.opened；修正 limits 来源（信任级别与配置）与 linkOpened（通知路由）两处不准确说明；`test/remote/host-link.test.ts` 通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/remote/internal.ts：完整；该文件只做再导出，文件头说明导出清单与模块边界，未改动导出；相关测试随 test/remote 通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/remote/path.ts：完整；核对 Path 的 attach/connected/disconnected 与 RemoteObject、RelayedHold 的 attach/dropped 契约；`test/remote/path.test.ts` 通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/remote/provider.ts：完整；核对 Hold/RelayedHold 接口、ack 窗口 WINDOW=2、#sent 发送者队列、flush 与 pendingEntry；保持 reply 条件表达式的原始缩进；`test/remote/provider.test.ts` 通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/remote/relay.ts：完整；核对 RelayedHold 与 ProviderSide.forward、Path、actingFor 的调用；`test/remote/relay.test.ts` 通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/remote/remote-object.ts：完整；核对 Target/Binding 接口、Replica 生命周期、prepareBound 与 prepare 的批次闭包、retry 的 unplaced 路径；`test/remote/remote-object.test.ts` 通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/remote/replica.ts：完整；核对 Source/WatchStart/Batch、Delta decoder/applyImmutable、handedOut 的真实语义（先取用 stack 释放栈帧接收者）；`test/remote/replica.test.ts` 通过。

所有文件的文件头已扩写为详细导读，包含所属模块、职责边界、上下游、错误流向、导出能力清单、组合关系、签名准确的示例与阅读顺序。`git diff --numstat` 显示 10 个文件全部为纯新增（0 删除）。

运行命令与结果：

```
cd packages/chord
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/remote/
```

最终结果：Test Files 9 passed (9)，Tests 406 passed (406)。

## 未完成或风险

- 无 g09 注释缺口。
- 复跑期间曾出现组外回归：/Users/baiml/PycharmProjects/pi/packages/chord/src/watch.ts 在文件头改写时丢失 `import { type Context, withoutAbortSignal } from "./context/index.ts"`，导致 test/state 与 test/remote 报 `ReferenceError: withoutAbortSignal is not defined`。该文件属于 g06，未修改；已通知 g06 代理，导入恢复后 test/remote/ 复跑通过（406/406）。合并前建议在全部代理停止写入后统一复跑。
- 按任务约束未运行 `npm run check`、`npm run build`、全仓格式化、`git add/commit/push` 或 `npm install`。
