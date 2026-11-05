// 演示扩展使用自己 npm 包声明的 ms 依赖，把持续时间文字转为毫秒；注册工具不会立即解析参数。

/**
 * Example extension with its own npm dependencies.
 * Tests that jiti resolves modules from the extension's own node_modules.
 *
 * Requires: npm install in this directory
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// 从依赖导入解析函数；ms@2.1.3 的运行时解析失败可能返回 undefined，空串还可能直接抛错。
import ms from "ms";
// Type 用于构造可在工具输入边界校验的 schema，区别于被擦除的 TypeScript 类型。
import { Type } from "typebox";

// 入口接收 API 并注册 parse_duration 工具，无返回值。例：参数 duration 为 1h 时结果为 3600000 毫秒；错误传播给工具执行链。
export default function (pi: ExtensionAPI) {
	// Register a tool that uses ms
	// 登记工具声明和执行回调，模型调用时才会执行。
	pi.registerTool({
		// 模型使用的工具名。
		name: "parse_duration",
		// 界面显示标签。
		label: "Parse Duration",
		// 向模型描述用途，字符串示例不是此时执行的输入。
		description: "Parse a human-readable duration string (e.g., '2 days', '1h', '5m') to milliseconds",
		// 参数对象 schema；只约束 duration 是字符串，不约束其时间语法。
		parameters: Type.Object({
			// 声明必填字符串字段，并附上模型可读说明。
			duration: Type.String({ description: "Duration string like '2 days', '1h', '5m'" }),
		}),
		// 接收已解析参数；未使用的调用 id 以 _ 开头标明，无实际计时或等待。
		execute: async (_toolCallId, params) => {
			// as 断言让字符串符合依赖的模板字面量类型，不验证格式；真正解析由 ms 完成。
			const result = ms(params.duration as ms.StringValue);
			// 根据 ms 运行时返回值识别无法解析的非空字符串。
			if (result === undefined) {
				// 抛错令此次工具执行失败，保留原始参数便于定位。
				throw new Error(`Invalid duration: "${params.duration}"`);
			}
			// 成功时返回标准工具结果结构。
			return {
				// 文字结果供模型和界面读取，模板插入参数和解析数值。
				content: [{ type: "text", text: `${params.duration} = ${result} milliseconds` }],
				// 本例没有额外结构化结果信息。
				details: {},
			};
		},
	});
}
