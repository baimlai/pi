// 文件导读
// 所属：packages/chord/test/examples/53-app，notes 应用的 worker 进程入口。
// 作用：每个项目（Project 地址）一个独立进程；startWorker 完成握手后，在项目目录打开自己的 store、
// 连回服务器、加载插件的 worker facet。示例 53 的笔记读写就发生在这里。
// 上游：start.ts 的 workers[0].entry 指向本文件，服务器用 Node 子进程启动它，并传入 execArgv。
// 下游：src/node/app/index.ts 的 startWorker；./start.ts 的 API/KINDS（在子进程中重新求值，
// 但名称、版本与模块表一致，契约 token 因此能在两端匹配）。
// 能力清单：
// - startWorker：把当前进程变成应用 worker；返回 void，进程保持运行直到父进程关闭。
// 典型用法（示例）：
//   node --conditions=source --experimental-strip-types test/examples/53-app/worker.ts
// 直接运行不会工作：它等待服务器通过 IPC 发来的启动消息，缺少父进程会超时/报错。
// 阅读顺序：先看本文件三行主体，再看 src/node/app/worker.ts 的 workerMain 流程。
// 运行方式：不单独运行；由 startNotes 的 workers 配置启动。
// 副作用：收紧并创建 <dataDir>/workers/project/<编码 key>/、打开 store.sqlite、建立到服务器的链路。
// 说明：onError 收到 unknown（可能是 HostError 或启动失败错误），这里直接打印；真实应用可记录日志。
//
// The notes app's worker entry: one process per project. `startWorker` opens the project's store in its directory,
// connects to the server and loads the plugins' worker facets.

// worker 侧的 kit 入口；与服务器侧 startServer 属于同一个包。
import { startWorker } from "../../../src/node/app/index.ts";
// 复用启动脚本里的 API 与 facet 种类，保证两端对模块名和版本的理解一致。
import { API, KINDS } from "./start.ts";

// 顶层调用：startWorker 注册 IPC 握手并返回 void；进程由 Node 事件循环保持。
// onError 的错误类型是 unknown，因为错误可能来自任意层；示例直接打印。
startWorker({ api: API, kinds: KINDS, onError: (error) => console.error("worker:", error) });
