// 根据当前消息/图片标记构造Copilot动态请求头；只返回普通对象，调用方负责合并并发送。
// 只导入共用消息联合类型，按role/type收窄字段。
import type { Message } from "../types.ts";

// Copilot expects X-Initiator to indicate whether the request is user-initiated
// or agent-initiated (e.g. follow-up after assistant/tool messages).
/**
 * 仅按最后一条消息角色推断发起者，返回user或agent，无I/O。
 * 例：末条toolResult/assistant/system都判agent，空历史判user；不扫描更早真实用户来源，也不验证调用权限。
 */
export function inferCopilotInitiator(messages: Message[]): "user" | "agent" {
	// 取数组最后一项，空历史得到undefined。
	const last = messages[messages.length - 1];
	// 非空末条且角色非user就判agent，否则user。
	return last && last.role !== "user" ? "agent" : "user";
}

// Copilot requires Copilot-Vision-Request header when sending images
/**
 * 查任一user或toolResult内容数组是否含图片，返回boolean，不修改消息。
 * 例：历史较早用户图也会命中；system/assistant不参与此检测，数组检查沿用原逻辑，不是新增对typed参数的全面校验。
 */
export function hasCopilotVisionInput(messages: Message[]): boolean {
	// some遇首个图片即短路；内部回调检查各条消息。
	return messages.some((msg) => {
		// 只在用户内容为数组时查看块；用户纯字符串跳过。
		if (msg.role === "user" && Array.isArray(msg.content)) {
			// 检查任一块type=image，不解码图片或检查MIME。
			return msg.content.some((c) => c.type === "image");
		}
		// 工具结果也可能含图片，沿用数组分支检查。
		if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			// 按type检查图片块，不把工具输出文字当图。
			return msg.content.some((c) => c.type === "image");
		}
		// 其他角色/纯文本消息不贡献视觉标记。
		return false;
	});
}

/**
 * 构造发起者与conversation-edits意图头，hasImages为真时加视觉请求标记，返回新字典。
 * 例：传hasImages=false即不加视觉头，即便messages里有图；本函数不自动调用hasCopilotVisionInput，调用方负责给正确布尔值。
 */
export function buildCopilotDynamicHeaders(params: {
	// 消息列表用于inferCopilotInitiator，不在此扫描图片。
	messages: Message[];
	// 调用方已经算好的图片标记。
	hasImages: boolean;
	// 返回字符串字典，类型不会自动发送头。
}): Record<string, string> {
	// 新建头对象，与模型/请求头的合并在外层。
	const headers: Record<string, string> = {
		// 发起者来自最后消息角色。
		"X-Initiator": inferCopilotInitiator(params.messages),
		// 固定意图文字，保持供应商约定大小写/拼写。
		"Openai-Intent": "conversation-edits",
	};

	// 只有显式图片标记真才添加视觉头。
	if (params.hasImages) {
		// HTTP头值为字符串true，不是布尔值。
		headers["Copilot-Vision-Request"] = "true";
	}

	// 返回新字典，不就地修改params。
	return headers;
}
