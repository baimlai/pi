// The sessions plugin's worker facet: its process id, and `crash`, which ends the process (a bug, an out-of-memory).

// 文件导读
// 所属：packages/chord/test/examples/42-worker-crash/plugins/sessions/worker.ts，插件 @example/sessions 的
//   worker facet；discoverPlugins 把插件目录中的 worker.ts 识别为 kind "worker" 的入口。
// 演示什么：在 worker 进程里服务 Process 契约。pid 是常量状态成员；crash 是远程方法，调用后安排进程退出，
//   模拟 bug 或 OOM 等非正常结束，用于演示 workers 组件“崩溃后不自动重启”。
// 上游/下游：上游是 createWorkers 的启动消息与 workerMain 里的 plugins.load；下游是 defineFacet、host.serve、
//   constant 与 contract.ts 的 Process。工厂在对象激活时运行；crash 处理器在被调用时运行。
// 能力清单：
// - default export：defineFacet 返回的 Facet，作为插件的 worker 种类入口。
// - pid：constant(process.pid)，反映实际子进程。
// - crash：async 方法，返回 null；10ms 后 process.exit(13)。
// 组合关系：main.ts 的 hold(Process) 激活对象 -> 引用读取 pid -> crash(context) 调用远程方法 -> 进程退出 ->
//   服务器记录 worker_exited/worker_failed，地址 failed。
// 示例（示例，不是本文件的额外运行代码）：
//   await session.crash(ctx);   // 返回 null；随后 worker 进程以退出码 13 结束
// 同目录 package.json（JSON，不能加注释）提供插件名 @example/sessions 与 ESM 类型，供发现与报告使用。
// 建议阅读顺序：先看 contract.ts 的 Process 声明，再看 defineFacet 与 host.serve，最后读 crash 的执行时机。
import { constant, defineFacet } from "@earendil-works/chord";
import { Process } from "./contract.ts";

// defineFacet 的回调在每次 load/reload 时执行，只做声明。host.serve 的远程工厂签名是
// (params, principal, self)；本示例不关心参数，返回 variant main 与两个方法成员。
// 工厂返回的对象会由 TypeScript 检查成员名与变体名；运行时不会重新校验形状。
export default defineFacet((host) =>
	host.serve(Process, () => ({
		variant: "main",
		members: {
			// constant(process.pid) 是不可变状态成员：引用方读取 .value 得到当前 worker 的 pid。
			pid: constant(process.pid),
			// crash 是远程方法。method() 声明无参数、结果为 null，所以实现必须返回 null（此处异步返回）。
			crash: async () => {
				// 用定时器把退出推迟 10ms，让当前调用的响应有机会先发回服务器；这不是可靠保证，
				// 只是让示例输出稳定。process.exit 会立刻终止进程，不执行 onClose 中的清理。
				setTimeout(() => process.exit(13), 10);
				return null;
			},
		},
	})),
);
