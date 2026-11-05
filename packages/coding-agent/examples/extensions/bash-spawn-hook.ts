// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；用 `pi -e ./bash-spawn-hook.ts` 加载。
// 演示内容：创建一个带 spawnHook 的 bash 工具，并同名注册，保留原工具定义，只改变真正启动子进程前的 command/cwd/env。
// 上下游：createBashTool 来自 @earendil-works/pi-coding-agent，返回带 schema、execute 和提示元数据的工具；pi.registerTool 把它交给宿主。每次模型调用 bash 时，底层 shell 工具在 spawn 前调用钩子，再把命令交给 bash。
// 能力清单：
// - 默认导出 (pi: ExtensionAPI) => void：构造工具并注册，加载时不运行 shell。
// - spawnHook: (context: BashSpawnContext) => BashSpawnContext：同步地把 profile 加载追加到命令前，并注入 PI_SPAWN_HOOK=1。
// - 覆盖的 execute：把调用转交给原工具，演示可在此插入日志/审计；当前没有额外逻辑。
// 典型运行顺序：加载扩展 -> 模型调用 bash -> 底层工具解析 spawn 参数 -> spawnHook 改写 -> bash 执行 `source ~/.profile` 和原命令。
// 示例（真实签名）：
//   pi -e ./examples/extensions/bash-spawn-hook.ts
//   # 模型调用 {command:"echo hi"} 时，实际命令文本为 "source ~/.profile\necho hi"，环境含 PI_SPAWN_HOOK=1
// 阅读顺序：先看 createBashTool 的 options，再看 spawnHook 返回对象，最后看 registerTool 的展开与 execute 转发。
// 前置与副作用：要求 shell 能读取 ~/.profile；profile 可能修改 PATH、打印文字或执行任意命令。钩子按每次 spawn 同步执行，抛错会阻止本次命令启动并由上层转成错误结果；扩展本身不修改工作区。
/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   pi -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";

// 注册同名 bash 工具并在启动前改写命令环境；输入 pi，输出无，加载时不运行 shell。
// 例如模型调用 echo hi 时，执行文本前会先加 source ~/.profile；profile 内容可有自身副作用。
export default function (pi: ExtensionAPI) {
	// 扩展加载时的工作目录；它与会话运行时的 ctx.cwd 可能不同，工具默认目录在构造时固定。
	// process.cwd() 读取扩展加载时的宿主工作目录，随后用它构造工具。
	const cwd = process.cwd();

	// createBashTool 返回现有 bash 工具；这里只替换其 spawnHook 配置。
	const bashTool = createBashTool(cwd, {
		// spawnHook 类型是同步的 (context: BashSpawnContext) => BashSpawnContext；必须返回完整对象，不能返回 Promise。
		// 同步箭头回调解构本次 command/cwd/env，再用括号包住返回对象，避免被解析成函数体。
		spawnHook: ({ command, cwd, env }) => ({
			// 命令字符串前加 profile 加载和换行；source 是要由 bash 解释的语法。
			// 追加 source 会让 profile 中的命令真正执行；如果 profile 失败（非零退出），后面的命令仍会继续执行，因为这里没有 set -e 或用 && 连接。
			command: `source ~/.profile\n${command}`,
			// 对象属性简写保留原工作目录。
			cwd,
			// ...env 浅展开环境后覆盖 PI_SPAWN_HOOK；不修改传入的环境对象。
			env: { ...env, PI_SPAWN_HOOK: "1" },
		}),
	});

	// 同名注册使用这个工具对象，保留它的参数 schema、描述等元数据。
	pi.registerTool({
		// 展开原工具字段，后面的 execute 覆盖原执行入口。
		...bashTool,
		// 执行回调收到调用 ID、schema 推导的参数、取消信号和进度回调；_ctx 表示本例不用会话上下文。
		execute: async (id, params, signal, onUpdate, _ctx) => {
			// 等待并返回原工具结果，同时转交取消与进度；钩子的改写在底层真正启动命令前发生。
			// 这里没有把 _ctx 作为第 5 个参数转发给原 execute，因此原工具拿不到会话上下文；本示例的钩子不依赖它。若需要 ctx，应传 `_ctx`。
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
