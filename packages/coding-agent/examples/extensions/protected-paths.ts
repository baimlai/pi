// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：在 write/edit 工具执行前检查 path 字符串是否包含 ".env"、".git/"、"node_modules/"，
//   命中则阻止调用；用于演示基于文本匹配的保护路径，不是文件系统隔离。
// 上游：`pi --extension ./examples/extensions/protected-paths.ts` 加载；宿主在每次工具调用前派发 tool_call。
// 下游：命中时 ctx.ui.notify 提醒，并返回 { block: true, reason }；不修改路径、不访问文件系统。
// 能力：
//   protectedPaths     三个路径片段。
//   默认导出函数        注册 tool_call 拦截器。
// 典型顺序：模型请求 write/edit -> 名称过滤 -> 原始路径 includes 检查 -> 提示并阻止或放行。
// 示例：write path="/repo/.env.local" 被阻止；path="/repo/src/index.ts" 放行。
// 阅读顺序：先看三个片段能覆盖/误伤什么，再看名称过滤与返回值。

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
	// 这是子串匹配而非路径归一化：".git/" 只匹配带斜杠的形式，Windows 反斜杠路径不会被命中。
	const protectedPaths = [".env", ".git/", "node_modules/"];

	// 异步处理工具调用前事件，ctx 提供当前 UI 能力。
	// 只拦截 write/edit；bash 仍可绕过这些保护（它不是沙箱）。
	pi.on("tool_call", async (event, ctx) => {
		// && 要求名称既非 write 又非 edit；符合此条件就放过其他工具。
		if (event.toolName !== "write" && event.toolName !== "edit") {
			// 不拦截，继续宿主工具调用流程。
			return undefined;
		}

		// 取得路径参数；as 是编译期断言，不做运行时字符串校验。
		// 收窄后 event.input 已是对应工具的输入类型，path 由工具 schema 声明为 string。
		const path = event.input.path as string;
		// 任一保护片段出现在原始路径文本中就命中；没有大小写或路径分隔符规范化。
		// some 在第一个命中处短路；p 是当前片段。
		const isProtected = protectedPaths.some((p) => path.includes(p));

		// 命中片段时构造拒绝结果。
		if (isProtected) {
			// 只有有 UI 时才额外发可见提示，拒绝本身不依赖 UI。
			if (ctx.hasUI) {
				// 将原路径插入警告文案，供用户查看。
				ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
			}
			// 返回宿主识别的阻止标记及原因。
			// 工具不会执行，模型收到被阻止的结果。
			return { block: true, reason: `Path "${path}" is protected` };
		}

		// 不拦截，继续宿主工具调用流程。
		return undefined;
	});
}
