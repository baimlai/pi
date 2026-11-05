// 存放宿主应用提供的默认模型请求函数。Agent/agent-loop 读取它，SDK 可以设置它；本文件不发网络请求。
// import type 只引入编译时类型，生成的 JavaScript 不需要加载这个类型定义。
import type { StreamFn } from "./types.ts";

// 模块级变量：同一模块实例共享一个默认函数；尚未配置时为 undefined。
let defaultStreamFn: StreamFn | undefined;

/**
 * Configure the fallback used by Agent and low-level loops when callers omit streamFn.
 *
 * Hosts that provide a default model runtime can install its stream function here
 * without making pi-agent-core depend on a provider catalog or compatibility layer.
 */
/**
 * 设置或清除兜底的模型请求函数，返回 void（不返回结果）。
 * 输入为符合 StreamFn 的函数，或 undefined；副作用是替换本模块保存的引用，不会立刻调用模型。
 * 例：宿主先 setDefaultStreamFn(myStream)，以后未显式传 streamFn 的 Agent 才会使用它。
 */
export function setDefaultStreamFn(streamFn: StreamFn | undefined): void {
	// 保存函数本身，不加括号，所以这里不会执行 streamFn。
	defaultStreamFn = streamFn;
}

/**
 * 取回已经配置的默认请求函数；没配置就抛错，避免真正运行时才出现“不是函数”。
 * 无输入，成功返回 StreamFn，无状态修改。例：const request = getDefaultStreamFn() 只是取引用。
 */
export function getDefaultStreamFn(): StreamFn {
	// 这是对“宿主是否已完成配置”的运行状态检查；不是对 TS 保证的函数参数重复做类型检查。
	if (!defaultStreamFn) {
		// throw 终止本次取值；调用方可选择显式传 streamFn 或先设置默认值。
		throw new Error("No default stream function configured. Pass streamFn explicitly or call setDefaultStreamFn().");
	}
	// 上面的判断把类型从 StreamFn | undefined 收窄为 StreamFn。
	return defaultStreamFn;
}
