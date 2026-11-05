import type {
	AssistantMessage,
	Message,
	StopReason,
	SystemMessage,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import {
	type AnyTask,
	createRegistry,
	defineExtension,
	defineTool,
	type Extension,
	Harness,
	type HooksOf,
	hook,
	type PromptSection,
	type Registry,
	type Storage,
	section,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { context } from "./session-support.ts";

// 创建空参数、空输出的工具登记，输入名字与可选描述；例如 tool("read") 仅用作注册表夹具。
// defineTool 只提供 TS 类型推断，不执行参数运行时校验；execute 被调用才返回空输出，无实际文件访问。
export function tool(name: string, description = `${name} tool`): ToolRegistration {
	// obj({}) 构造参数 schema；async 回调立即成功，output: [] 表示没有内容块。
	return defineTool({ name, description, parameters: obj({}), execute: async () => ({ output: [] }) });
}

/** Open a Harness with a fresh registry holding the named tools. */
// 在 storage 上打开测试运行器，按 toolNames 安装空工具；返回 Harness 与所用注册表。
// 例如 openHarness(storage, ["read"]) 装入 tools 扩展；可通过 options 复用注册表和接收错误。
// 会修改传入注册表，安装或打开失败向外拒绝，调用者负责关闭；createModels 为空路由。
export async function openHarness(
	storage: Storage,
	toolNames: readonly string[] = [],
	options: { readonly registry?: Registry; readonly onReport?: (error: unknown) => void } = {},
): Promise<{ readonly harness: Harness; readonly registry: Registry }> {
	// 未传注册表才新建，?? 仅在 null/undefined 时取右值。
	const registry = options.registry ?? createRegistry();
	// 没有工具就不安装扩展；下行 map 把每个名字变成独立的空工具。
	if (toolNames.length > 0)
		registry.install(defineExtension({ name: "tools", tools: toolNames.map((name) => tool(name)) }));
	// 等待 Harness 打开已有存储；这里只安装工具，不运行对话。
	const harness = await Harness.open(
		storage,
		{
			// 空模型路由不会自动调用真实供应商。
			models: createModels(),
			// 使用刚才安装过工具的注册表。
			registry,
			// 条件对象展开：仅提供回调时才接报告，并从 report 中取 error 转发。
			// ?. 再次读取可选属性，未定义就跳过调用；报告元信息在这个 helper 中被丢弃。
			...(options.onReport === undefined ? {} : { onReport: (report) => options.onReport?.(report.error) }),
		},
		// 使用不可取消背景上下文。
		context,
	);
	// 交还运行器与注册表引用，便于测试动态安装或卸载。
	return { harness, registry };
}

// 把 text 包成用户消息返回，固定 timestamp=1 使断言稳定；例如 user("hi")。
// 无模型调用、无副作用，UserMessage 仅在开发时检查对象形状。
export function user(text: string): UserMessage {
	// content 采用用户消息允许的字符串形式。
	return { role: "user", content: text, timestamp: 1 };
}

// 构造助手消息夹具，输入文本及可选调用 ID/终止原因，返回完整 AssistantMessage。
// 例如 assistant("", {calls:["a"]}) 默认 stopReason=toolUse；只有文本时默认 stop。
// 用量和费用都固定零，仅构造数据，不执行工具或请求模型。
export function assistant(
	text: string,
	options: { readonly calls?: readonly string[]; readonly stopReason?: StopReason } = {},
): AssistantMessage {
	// 默认无调用；map 为每个 ID 建立工具调用块，名称遵循 tool-<id> 夹具约定。
	const calls: ToolCall[] = (options.calls ?? []).map((id) => ({
		// type 标签让 TS 将此块识别为 ToolCall；id/name/空 arguments 只是测试输入。
		type: "toolCall",
		id,
		name: `tool-${id}`,
		arguments: {},
	}));
	// 返回一条带固定 faux 元数据的消息。
	return {
		role: "assistant",
		// 先放文本块，再展开工具调用，空文本块也保留。
		content: [{ type: "text", text }, ...calls],
		api: "faux",
		provider: "faux",
		model: "faux",
		// 填满 usage 必需字段；这些零是夹具常量，不是实测 token 数。
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		// 显式原因优先；否则依据是否包含调用选择 toolUse 或 stop。
		stopReason: options.stopReason ?? (calls.length > 0 ? "toolUse" : "stop"),
		// 固定时间 2，用于可重复的消息比较。
		timestamp: 2,
	};
}

// 构造工具成功结果，输入调用 ID 与可选文本；例如 toolResult("a") 关联调用 a。
// 默认文本 result a，固定时间 3；不验证对应调用是否存在，也不执行工具。
export function toolResult(id: string, text = `result ${id}`): ToolResultMessage {
	// 构造结果块；toolCallId 供关联，toolName 与 assistant 的命名约定一致。
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: `tool-${id}`,
		content: [{ type: "text", text }],
		// 本辅助函数始终生成成功结果。
		isError: false,
		timestamp: 3,
	};
}

// 构造分节系统消息，输入键到文本或 null 的 Record 映射，返回固定时间 4 的消息。
// 例如 system({rules:"be brief"})；content 为空而 sections 保留原引用，不拼接提示词。
export function system(sections: Record<string, string | null>): SystemMessage {
	// null 可表示一个节的删除/缺失语义，此处只原样保存给被测逻辑。
	return { role: "system", content: "", sections, timestamp: 4 };
}

/** Compact message rendering for assertions. */
// 将 Message 转为断言用的紧凑字符串，不用于生产渲染。
// 例如 user("hi") 得 user:hi；助手/结果只取第一文本块，错误结果固定显示 error。
// 按 role 联合标签分支，无外部副作用；as string 不会把数组转换成字符串。
export function describeMessage(message: Message): string {
	// 穷举消息的四种角色，TS 根据 case 缩窄字段类型。
	switch (message.role) {
		case "user":
			// 用户夹具预期是字符串；as 只是断言，运行时模板插值仍按 JS 转字符串。
			return `user:${message.content as string}`;
		case "assistant": {
			// 取助手内容中第一块文本，工具调用或思考块不参与。
			const text = message.content.find((content) => content.type === "text");
			// 没找到文本时用空串；?. 防止访问 undefined。
			return `assistant:${text?.type === "text" ? text.text : ""}`;
		}
		// 工具结果分支会带上调用 ID，便于区分多个工具响应。
		case "toolResult": {
			const text = message.content.find((content) => content.type === "text");
			// 错误优先显示 error；成功时显示首块文本或空串。
			return `result:${message.toolCallId}:${message.isError ? "error" : text?.type === "text" ? text.text : ""}`;
		}
		case "system":
			// Object.keys 只列节名再以逗号连接，不显示节正文。
			return `system:${Object.keys(message.sections ?? {}).join(",")}`;
	}
}

/** Uninstalls what one of the helpers below installed. */
// 最小卸载接口：dispose() 无返回值；readonly/接口都不会自动管理生命周期。
export type Installed = { dispose(): void };

// 安装一个扩展并返回卸载闭包；泛型 Tool 保持 registry 与 extension 的工具类型一致。
// 例如 installOne(registry, ext).dispose() 按扩展名卸载；安装冲突直接抛出，dispose 无自动调用。
function installOne<Tool extends ToolRegistration>(registry: Registry<Tool>, extension: Extension<Tool>): Installed {
	// 安装会发布注册表新快照，同名扩展可替换。
	registry.install(extension);
	// 闭包保存 extension；卸载由 registry 按名称处理，并非恢复之前的同名版本。
	return { dispose: () => registry.uninstall(extension) };
}

/** Install a one-tool extension named after the tool. */
// 把单个工具包装成扩展并安装，返回 dispose；默认扩展名 tool:<工具名>。
// 例如 addTool(registry, read)；工具不在此执行，安装校验错误向上传播。
export function addTool<Tool extends ToolRegistration>(
	registry: Registry<Tool>,
	tool: Tool,
	name = `tool:${tool.name}`,
): Installed {
	// 工具数组只包含传入对象，defineExtension 是类型辅助，不复制工具。
	return installOne(registry, defineExtension<Tool>({ name, tools: [tool] }));
}

/** Install a one-task extension named after the task. */
// 安装只含一个任务的扩展，返回卸载句柄；例如 addTask(registry, Reminder)。
// 默认名来自 task.definition.name，安装不启动任务，名称冲突错误来自 registry。
export function addTask(registry: Registry, task: AnyTask, name = `task:${task.definition.name}`): Installed {
	// 将任务 token 放入 tasks 数组后复用安装/卸载流程。
	return installOne(registry, defineExtension({ name, tasks: [task] }));
}

// 模块内递增编号让未命名的 hook 扩展通常不互相覆盖。
let hookExtensions = 0;

/** Install an extension with one hook registration for `task`. */
// 为指定任务安装一组钩子并返回卸载句柄；Partial<HooksOf<K>> 允许只提供部分处理器。
// 例如 addHooks(registry, task, { ... })；省略 name 时先递增编号，安装失败也不回退计数。
export function addHooks<K extends AnyTask>(
	registry: Registry,
	task: K,
	handlers: Partial<HooksOf<K>>,
	name = `hooks:${++hookExtensions}`,
): Installed {
	// hook 按任务定义名登记 handlers；安装本身不会调用处理器。
	return installOne(registry, defineExtension({ name, hooks: [hook(task, handlers)] }));
}

/** Install a one-section extension named after the section. */
// 安装单个提示词节并返回卸载句柄，key 为节名、render 为渲染回调。
// 例如 addSection(registry, "rules", () => "brief")；options.tag 控制包裹标签，默认扩展名 section:<key>。
// PromptSection<Tool>["render"] 是索引访问类型，复用真实签名；注册不执行 render，非法节名由 registry 抛错。
export function addSection<Tool extends ToolRegistration = ToolRegistration>(
	registry: Registry<Tool>,
	key: string,
	render: PromptSection<Tool>["render"],
	options?: { readonly tag?: boolean },
	name = `section:${key}`,
): Installed {
	// section 把 key/render/tag 组装为配置，随后统一安装。
	return installOne(registry, defineExtension<Tool>({ name, sections: [section(key, render, options)] }));
}
