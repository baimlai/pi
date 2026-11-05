/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是“从扩展请求有序退出”。
 * 上游：宿主加载本文件后，用户可以输入 /quit，或由模型调用 finish_and_exit、
 * deploy_and_exit 两个工具。下游：ctx.shutdown() 请求宿主在安全时机退出；工具还会把
 * 文本结果交回模型。示例不真正部署任何东西，deploy_and_exit 中的部署命令是注释掉的。
 *
 * 能力清单：
 * - /quit 命令：立即请求干净退出（延迟到 Agent 空闲时执行）。
 * - finish_and_exit 工具：无参数，完成“收尾工作”后请求退出，并把说明作为工具结果返回。
 * - deploy_and_exit 工具：接收 environment 参数，演示用 onUpdate 报告进度后再请求退出。
 *
 * 典型运行顺序：加载扩展 -> 输入 /quit 触发退出；或让模型调用 finish_and_exit，模型先
 * 收到 "Shutdown requested..." 文本，然后进程有序退出。
 *
 * 示例（真实签名）：
 *   ctx.shutdown();  // 返回 void，不是等待退出完成的 Promise
 *   真实运行时退出由宿主在合适边界执行，调用返回后仍可能继续执行当前函数剩余语句。
 *
 * 建议阅读顺序：先看 /quit 命令，再看 finish_and_exit 的无参数 execute，最后看
 * deploy_and_exit 的 onUpdate 进度回调与参数 schema。
 *
 * 前置条件：需要能注册命令/工具的普通会话；退出会结束当前进程，未保存的会话内容是否
 * 落盘由宿主决定。不会发起网络请求或产生模型费用（除非模型自己调用了工具）。
 */

/**
 * Shutdown Command Extension
 *
 * Adds a /quit command that allows extensions to trigger clean shutdown.
 * Demonstrates how extensions can use ctx.shutdown() to exit pi cleanly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// 扩展入口：登记一个命令和两个工具，本身不触发退出。
export default function (pi: ExtensionAPI) {
	// Register a /quit command that cleanly exits pi
	// 命令处理器只有退出动作；_args 是命令后参数，本示例忽略。
	pi.registerCommand("quit", {
		description: "Exit pi cleanly",
		handler: async (_args, ctx) => {
			// 请求宿主有序关闭；这是“请求”而非同步完成退出。
			ctx.shutdown();
		},
	});

	// You can also create a tool that shuts down after completing work
	// 无参数工具：schema 为空对象，模型调用时不传字段。
	pi.registerTool({
		name: "finish_and_exit",
		label: "Finish and Exit",
		description: "Complete a task and exit pi",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			// Do any final work here...
			// Request graceful shutdown (deferred until agent is idle)
			// 在工具执行中请求退出，宿主会推迟到 Agent 空闲时执行。
			ctx.shutdown();

			// This return is sent to the LLM before shutdown occurs
			// 返回结构中的 content 是模型可读文本，details 是渲染用附带数据。
			return {
				content: [{ type: "text", text: "Shutdown requested. Exiting after this response." }],
				details: {},
			};
		},
	});

	// You could also create a more complex tool with parameters
	// 带参数工具：environment 由 Type.String 在运行时校验并让 params 推导为 { environment: string }。
	pi.registerTool({
		name: "deploy_and_exit",
		label: "Deploy and Exit",
		description: "Deploy the application and exit pi",
		parameters: Type.Object({
			environment: Type.String({ description: "Target environment (e.g., production, staging)" }),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			// onUpdate 可选：有订阅者时报告部分结果；?. 避免未提供回调时报错。
			onUpdate?.({ content: [{ type: "text", text: `Deploying to ${params.environment}...` }], details: {} });

			// Example deployment logic
			// const result = await pi.exec("npm", ["run", "deploy", params.environment], { signal });

			// On success, request graceful shutdown
			// 第二个进度事件替换界面上的阶段文字，然后才请求退出。
			onUpdate?.({ content: [{ type: "text", text: "Deployment complete, exiting..." }], details: {} });
			ctx.shutdown();

			// 最终结果仍会交给模型；details.environment 保留调用参数便于审计/渲染。
			return {
				content: [{ type: "text", text: "Done! Shutdown requested." }],
				details: { environment: params.environment },
			};
		},
	});
}
