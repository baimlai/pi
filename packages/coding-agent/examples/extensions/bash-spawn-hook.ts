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
	// process.cwd() 读取扩展加载时的宿主工作目录，随后用它构造工具。
	const cwd = process.cwd();

	// createBashTool 返回现有 bash 工具；这里只替换其 spawnHook 配置。
	const bashTool = createBashTool(cwd, {
		// 同步箭头回调解构本次 command/cwd/env，再用括号包住返回对象，避免被解析成函数体。
		spawnHook: ({ command, cwd, env }) => ({
			// 命令字符串前加 profile 加载和换行；source 是要由 bash 解释的语法。
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
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
