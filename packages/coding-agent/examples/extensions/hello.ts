/**
 * Hello Tool - Minimal custom tool example
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// defineTool 原样返回工具定义，并保留由 schema 推导的 params 类型；它本身不注册也不执行。
const helloTool = defineTool({
	// name 是模型调用标识，label 是 UI 标题，description 给模型说明用途。
	name: "hello",
	label: "Hello",
	description: "A simple greeting tool",
	// Type.Object/Type.String 创建运行时参数 schema；正常工具管线据此检查 name，TS 同时推导 name: string。
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),

	// 执行回调把 params.name 组成问候，返回文本与详情；无外部 I/O，不使用 ID、取消、进度和上下文。
	// 例如参数 {name:"Ada"} 得到 Hello, Ada!；async 使结果包装成 Promise。
	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		// content 是模型可读内容，details 是渲染或扩展可用附带数据。
		return {
			// 模板插值把姓名放入文本块；type:"text" 指定内容种类。
			content: [{ type: "text", text: `Hello, ${params.name}!` }],
			// 属性 greeted 保存与问候相同的姓名，不额外校验或持久化。
			details: { greeted: params.name },
		};
	},
});

// 扩展加载入口接收 pi，只把上面的工具登记到宿主；无返回值，不立即问候。
export default function (pi: ExtensionAPI) {
	// 注册后宿主可把该工具提供给模型，真正调用才进入 execute。
	pi.registerTool(helloTool);
}
