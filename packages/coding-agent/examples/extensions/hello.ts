// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；用 `pi -e ./hello.ts` 加载。
// 演示内容：最小自定义工具 hello，展示 TypeBox 参数 schema、defineTool 包装和 registerTool 注册。
// 上下游：扩展加载时 registerTool；模型调用 execute；返回 content/details。无文件 I/O、无模型请求。
// 能力清单：helloTool 定义、execute 问候、默认导出注册。
// 典型运行顺序：加载 -> 注册 hello -> 模型看到工具 -> 调用 hello({name}) -> 返回 "Hello, <name>!"。
// 示例（真实签名）：
//   pi -e ./examples/extensions/hello.ts
//   // 模型调用 hello({ name: "Ada" }) 得到 "Hello, Ada!"
// 阅读顺序：先看 defineTool 的 schema，再看 execute 的返回形状，最后看 registerTool。
// 前置与副作用：本文件从 @earendil-works/pi-ai 导入 Type，但当前 pi-ai 公共入口没有 Type 导出（packages/ai/src/index.ts 不导出它，dynamic-tools 示例从 "typebox" 导入）；examples/extensions 又被根 tsconfig 排除，npm run check 不会检查这里。若运行时出现 missing export，应改为从 typebox 导入 Type。execute 只拼接字符串，不会失败；注册后工具在整个会话中可用。
/**
 * Hello Tool - Minimal custom tool example
 */

// 注意导入来源：Type 应由 typebox 提供；当前 pi-ai 入口没有该导出。
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
