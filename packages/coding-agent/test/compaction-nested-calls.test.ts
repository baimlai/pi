// 从工具结果上的嵌套调用提取文件清单；这里只统计参数，不实际读写 a.ts 或 b.ts。
// import type 在执行时擦除，ToolResultMessage 仅约束下面夹具的开发期结构。
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "../src/core/compaction/utils.ts";

// 注册一个压缩辅助逻辑测试，不调用模型摘要服务。
describe("compaction file operations", () => {
	// 手工结果含 read/edit 和省略参数的 write；期望仅把有 path 的调用记入对应清单。
	it("include files touched by nested calls recorded on tool results", () => {
		// 类型注解不会执行 schema 校验，字段值完全由此测试提供。
		const result: ToolResultMessage = {
			// role 判别这是一条工具结果，顶层工具为 codemode。
			role: "toolResult",
			// toolCallId 对应外层脚本调用，而非下面每个嵌套调用的 id。
			toolCallId: "codemode-1",
			toolName: "codemode",
			content: [],
			isError: false,
			timestamp: 0,
			// 嵌套调用记录单独携带参数及状态，不从空 content 中恢复。
			nestedCalls: {
				calls: [
					// read 的 path 进入只读集合。
					{ id: "codemode-1/1", name: "read", arguments: { path: "a.ts" }, status: "ok" },
					// edit 即使 edits 为空也按名称和 path 计入修改集合；此函数不验证修改是否真实发生。
					{ id: "codemode-1/2", name: "edit", arguments: { path: "b.ts", edits: [] }, status: "ok" },
					// 只有参数字节数，没有 arguments.path，因而不会凭空出现第三个文件。
					{ id: "codemode-1/3", name: "write", argumentsBytes: 40000, status: "ok" },
				],
				// 标记整份记录不完整；现有提取器仍扫描实际已有的 calls。
				complete: false,
			},
		};
		// 每次创建独立的 read/written/edited 三个 Set。
		const fileOps = createFileOps();
		// void 函数原地更新 fileOps，返回值不是新的清单。
		extractFileOpsFromMessage(result, fileOps);
		// 整理函数合并修改路径并排序；toEqual 深比较这两个数组。
		expect(computeFileLists(fileOps)).toEqual({ readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
	});
});
