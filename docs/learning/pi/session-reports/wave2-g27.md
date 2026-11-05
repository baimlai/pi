# 组 g27

状态：完成

## 完成文件

- packages/durable/src/env/decode.ts：完整。核对了 WHATWG TextDecoder 的 ignoreBOM/stream 语义、`StreamDecoder` 在 node.ts 的 NodeTextLineReader 与 exec stdout/stderr 中的调用方式，以及 line-scan.ts 对 `rangeDecoder`/`startsWithBom` 的使用；注释为纯新增（40 行）。运行 test/env-line-scan.test.ts 与 test/env-node.test.ts：56 passed，1 skipped。
- packages/durable/src/env/index.ts：完整。核对了 ../types.ts 的 HarnessOptions.env 与 TaskRuntime.env(context)、node.ts 与 node-watch.ts 的实现契约、testing/env-conformance.ts 的校验范围，以及 FileError/ExecutionError/LineScan/FileChange 等类型的实际字段；注释为纯新增（199 行）。运行 test/env-node-conformance.test.ts 与 test/env-node-spill.test.ts：52 passed。
- packages/durable/src/env/line-scan.ts：完整。核对了 NodeBinaryReader.scanLines 的 64 KiB 顺序读取、LineScan 的偏移与解码字节数字段、BOM/坏 UTF-8 的计数规则，以及 read 工具的消费方式；注释为纯新增（85 行）。运行 test/env-line-scan.test.ts：通过。
- packages/durable/src/env/node-watch.ts：完整。核对了 NodeExecutionEnv.watch 的调用路径、fs.watch/lstat/statfs/readFile 的使用、native/polling 切换与 maxDirectories 语义，以及 conformance 中的监视行为断言；注释为纯新增（118 行）。运行 test/env-node-conformance.test.ts：通过。
- packages/durable/src/env/node.ts：完整。核对了 node:fs/promises、node:child_process、decode.ts、line-scan.ts、node-watch.ts 的实际调用，重点验证了 exec 的超时/取消/进程树终止/spill 阈值与背压、两个读取器的定位读取和取消重试、文件方法的错误映射；注释为纯新增（380 行）。运行 test/env-node.test.ts、test/env-node-spill.test.ts、test/env-node-conformance.test.ts：全部通过。

测试命令（从仓库根执行）：

```sh
node /Users/baiml/PycharmProjects/pi/node_modules/vitest/dist/cli.js --run --root /Users/baiml/PycharmProjects/pi/packages/durable test/env-line-scan.test.ts test/env-node.test.ts
node /Users/baiml/PycharmProjects/pi/node_modules/vitest/dist/cli.js --run --root /Users/baiml/PycharmProjects/pi/packages/durable test/env-node-conformance.test.ts test/env-node-spill.test.ts
```

校验：5 个文件共 822 行新增；`git diff -U0` 的删除侧计数为 0，未修改、删除或重排任何原有代码行。

## 未完成或风险

- 无未完成文件。按任务约束未运行 `npm run check`、`npm run build`、全仓格式化、完整 vitest 套件或 `npm test`，也未更新覆盖清单、进度、日志或其他代理报告。
- 首次测试中 1 个既有用例被跳过（env-line-scan/env-node 合计 57 项中的 1 项），未改动测试代码，未进一步追查跳过原因。
