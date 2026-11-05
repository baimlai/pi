// 文件导读
// 所属：packages/chord/test/examples/59-chat，channel worker 进程的入口；start.ts 的 workers[].entry。
// 作用：worker 子进程启动后执行 `startWorker`，从父进程收到的启动数据里读取地址（哪个频道）、
// 应用启动数据和完整插件脚本集，然后在子进程内建 host、求值插件、连接父进程的链路。
// 上游：app kit 的 workers 组件 fork 本文件并通过 IPC 送来 start 消息；父进程侧是 start.ts。
// 下游：src/node/app/index.ts 的 startWorker（内部使用 workerMain、WorkerPlugins 等）。
// 能力清单：唯一的顶层调用 `startWorker({ api, kinds, onError })`。
// 典型行为：进程不打印正常日志；插件注册失败、宿主错误经 onError 写到 stderr，由父进程收集。
// 阅读顺序：先看 import 的 API/KINDS 来自 start.ts（同一份定义，避免子父进程漂移），再看 startWorker。
// 运行方式：不能单独运行；必须由服务器 fork 并发送启动数据，否则会立即失败。
// 说明：worker 不构建插件，只求值服务器构建好的脚本（Workers never build）；示例的 execArgv 让
// 子进程以源码方式运行 TypeScript，但插件脚本本身仍是服务器构建产物。

// A channel's worker: the kit's `startWorker` with the chat's API.

import { startWorker } from "../../../src/node/app/index.ts";
import { API, KINDS } from "./start.ts";

// api 给插件提供模块表；kinds 决定 worker facet 种类（本示例为 "worker"）；
// startWorker 从启动数据中取得地址、start 数据与 scripts，不在这里重复传。
startWorker({ api: API, kinds: KINDS, onError: (error) => console.error("channel:", error) });
