// 所属：packages/durable/src/tools，Durable 内置工具层的公共前置检查。
// 解决的问题：工具注册和 Harness 是分离的，执行工具时宿主可能没有配置执行环境。各工具都需要同一套
// “从本次调用取环境，没有就报普通错误”的行为，避免悄悄回退到宿主 Node 进程的默认文件系统。
// 职责边界：只读取 ToolExecutionApi.env 并做一次存在性检查；不创建、不包装、不缓存环境，也不读写文件。
// 上游：read/write/edit/bash/powershell 等工具的 execute 回调。下游：ToolExecutionApi 与环境实现 ExecutionEnv
// （env/index.ts），结果和错误返回给工具执行层 ToolTask。
// 能力清单：
// - requireEnv(api)：返回本次调用的 ExecutionEnv；api.env 为 undefined 时抛出普通 Error。
// 组合与流向：工具先 requireEnv(api) 取得环境，再把路径/命令交给环境；抛错由 ToolTask 捕获并转成 isError
// 结果，而不是让宿主进程崩溃。
// 示例（真实签名）：
//   const env = requireEnv(api);
//   const absolute = await resolveToolPath(env, args.path, context);
// 建议阅读顺序：先看 harness/types.ts 中 ToolExecutionApi.env 的注释，再读本函数；随后进入 read.ts/write.ts。
import type { ExecutionEnv } from "../env/index.ts";
import type { ToolExecutionApi } from "../harness/types.ts";

/** The call's execution environment; a tool without one fails with an ordinary error result. */
/**
 * 取出本次工具调用的文件系统和命令执行环境；api 是 Harness 提供的调用接口。
 * 返回已有环境对象，不创建环境、不读写文件。没有配置环境时抛错，由工具执行层记录失败。
 * 例如宿主没有提供 HarnessOptions.env 时，调用 read 会在这里失败，而不是访问当前机器的默认文件系统。
 */
export function requireEnv(api: ToolExecutionApi): ExecutionEnv {
	// env 的类型允许 undefined，因此先检查本次调用是否有宿主授权的执行环境。
	if (api.env === undefined) throw new Error("No execution environment is configured");
	// 上面的分支收窄了类型；这里返回同一个 ExecutionEnv 引用。
	return api.env;
}
