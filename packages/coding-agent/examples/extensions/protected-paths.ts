// 用路径字符串包含关系拦截 write/edit 示例；不解析真实路径或符号链接，因此不是文件系统隔离。

/**
 * Protected Paths Extension
 *
 * Blocks write and edit operations to protected paths.
 * Useful for preventing accidental modifications to sensitive files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 接收扩展 API 并注册一次调用拦截，不返回数据。例：write 的 path 包含 .env 时返回 block；其他错误交宿主处理。
export default function (pi: ExtensionAPI) {
	// 列出要匹配的三个片段；includes 也会匹配名称中含 .env 的普通文件。
	const protectedPaths = [".env", ".git/", "node_modules/"];

	// 异步处理工具调用前事件，ctx 提供当前 UI 能力。
	pi.on("tool_call", async (event, ctx) => {
		// && 要求名称既非 write 又非 edit；符合此条件就放过其他工具。
		if (event.toolName !== "write" && event.toolName !== "edit") {
			// 不拦截，继续宿主工具调用流程。
			return undefined;
		}

		// 取得路径参数；as 是编译期断言，不做运行时字符串校验。
		const path = event.input.path as string;
		// 任一保护片段出现在原始路径文本中就命中；没有大小写或路径分隔符规范化。
		const isProtected = protectedPaths.some((p) => path.includes(p));

		// 命中片段时构造拒绝结果。
		if (isProtected) {
			// 只有有 UI 时才额外发可见提示，拒绝本身不依赖 UI。
			if (ctx.hasUI) {
				// 将原路径插入警告文案，供用户查看。
				ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
			}
			// 返回宿主识别的阻止标记及原因。
			return { block: true, reason: `Path "${path}" is protected` };
		}

		// 不拦截，继续宿主工具调用流程。
		return undefined;
	});
}
