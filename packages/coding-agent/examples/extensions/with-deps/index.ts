// 演示扩展使用自己 npm 包声明的 ms 依赖，把持续时间文字转为毫秒；注册工具不会立即解析参数。

/**
 * Example extension with its own npm dependencies.
 * Tests that jiti resolves modules from the extension's own node_modules.
 *
 * Requires: npm install in this directory
 */

/**
 * 文件导读（with-deps 扩展示例入口）
 *
 * 所属与用途：本文件是 `packages/coding-agent/examples/extensions/with-deps` 扩展包的入口，
 * 演示扩展如何声明并使用自己的 npm 依赖：注册一个 `parse_duration` 工具，用 `ms` 把
 * `"1h"`、`"2 days"` 等字符串转成毫秒数。它不访问网络、不写文件。
 *
 * 上游如何进入：同目录 `package.json` 是扩展清单：
 *   - `private: true` 防止误发布；
 *   - `pi.extensions: ["./index.ts"]` 告诉加载器入口文件；
 *   - dependencies 声明 `ms@2.1.3`，devDependencies 声明 `@types/ms`。
 * 运行时用 `pi --extension <此目录>` 加载；jiti 从本目录的 `node_modules` 解析 `ms`，
 * 因此必须先在示例目录安装依赖（项目规则建议 `npm install --ignore-scripts`）。
 *
 * 下游调用：宿主把 `registerTool` 的工具定义交给模型；模型按 schema 生成参数后，
 * 宿主校验参数并调用 `execute`。`ms` 负责实际解析，TypeBox schema 负责输入边界。
 *
 * 能力清单：
 * - 默认导出：调用 `pi.registerTool` 注册 `parse_duration`。
 * - `parameters`：只约束 `duration` 是字符串，不校验时间格式。
 * - `execute`：调用 `ms`，成功返回文本结果与空 details，失败抛错。
 *
 * 典型运行顺序与示例：
 *   1. `cd .../with-deps && npm install --ignore-scripts`
 *   2. `pi --extension .../with-deps`
 *   3. 让模型调用 `parse_duration`，例如 `{ "duration": "1h" }`；
 *   4. 工具返回 `1h = 3600000 milliseconds`。
 *
 * 失败行为：`ms` 对非空但无法解析的字符串返回 `undefined`，本工具抛
 * `Invalid duration: "..."`；空字符串会让 `ms` 自己抛错，同样使工具执行失败。
 * 这两类错误都由工具执行链报告给模型，而不是在注册时发生。
 *
 * 建议阅读顺序：先看注册对象字段，再看 TypeBox schema，最后看 `execute` 的类型断言与错误分支。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// 从依赖导入解析函数；ms@2.1.3 的运行时解析失败可能返回 undefined，空串还可能直接抛错。
import ms from "ms";
// Type 用于构造可在工具输入边界校验的 schema，区别于被擦除的 TypeScript 类型。
import { Type } from "typebox";

/**
 * 扩展默认导出：注册 `parse_duration` 工具。
 *
 * 输入：`pi` 扩展 API。输出：无返回值；注册立即发生，但 `execute` 只在模型调用工具时运行。
 * 副作用：修改宿主内存中的工具表；导入 `ms` 本身不解析任何输入。
 * 错误路径：注册阶段不抛错；`execute` 内的错误由工具执行链捕获并反馈给模型。
 * 主要流程：声明名称/标签/描述/schema -> 提供异步 execute -> 调用 ms -> 返回标准结果。
 *
 * 示例：加载后模型调用 `parse_duration({ duration: "1h" })`，execute 返回
 * `{ content: [{ type: "text", text: "1h = 3600000 milliseconds" }], details: {} }`。
 */
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
		/**
		 * 工具执行回调：解析 duration 并返回毫秒数。
		 *
		 * 输入：`_toolCallId`（未使用）与 `params`，其中 `duration` 已由 schema 保证是字符串。
		 * 输出：`{ content: [{ type: "text", text }], details: {} }`。
		 * 副作用：无 I/O，只做内存计算。
		 * 错误路径：`ms` 对无法解析的非空字符串返回 undefined，这里抛 `Invalid duration`；空字符串
		 * 由 `ms` 自己抛错。两者都会让工具执行失败。
		 * 流程：调用 ms -> 检查 undefined -> 构造文本结果。
		 * 示例：`duration="1h"` 返回文本 `1h = 3600000 milliseconds`。
		 */
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
