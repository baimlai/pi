// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；复制到扩展目录或 `pi -e ./dynamic-tools.ts` 加载。
// 演示内容：会话启动时注册固定的 echo_session，并在运行期通过 /add-echo-tool <name> 注册新的 echo 工具。
// 上下游：pi.registerTool 把工具定义交给宿主工具表；模型调用 execute 时返回 content/details。命令层用 normalizeToolName 校验名字，Set 去重。不读写文件、不调用模型。
// 能力清单：
// - ECHO_PARAMS：TypeBox 参数 schema，message 是必填字符串。
// - normalizeToolName(input)：trim、转小写、字符集校验，返回 string | undefined。
// - registerEchoTool(name, label, prefix)：去重并注册；execute 返回 `${prefix}${message}`。
// - session_start：注册固定的 echo_session。
// - /add-echo-tool：校验参数并注册动态名字。
// 典型运行顺序：启动会话 -> session_start 注册 echo_session -> 模型可调用 -> /add-echo-tool foo -> 注册 foo -> 后续 agent run 可调用 foo。
// 示例（真实签名）：
//   /add-echo-tool foo
//   // 模型调用 foo({ message: "hi" }) 得到 "[foo] hi"
// 阅读顺序：先看 schema 与 normalizeToolName，再看 registerEchoTool 的 execute，最后看 session_start 和命令。
// 前置与副作用：名字只接受小写字母/数字/下划线，且会被强制转小写；数字开头也允许，没有长度上限。所有动态工具共享同一 schema 对象和同一段 promptGuidelines，而 guidelines 固定写 echo_session，注册 foo 后提示仍在说 echo_session。Set 在扩展实例内去重，不会注销旧工具。先占位再 registerTool；如果 registerTool 抛错，名字仍留在 Set 中，重试会被当成重复。动态注册会请求宿主刷新工具表，具体何时对正在进行的 run 生效由宿主 loadout 规则决定。
/**
 * Dynamic Tools Extension
 *
 * Demonstrates registering tools after session initialization.
 *
 * - Registers one tool during session_start
 * - Registers additional tools at runtime via /add-echo-tool <name>
 */

// import type 只引入类型；ExtensionAPI 用于标注入口，编译后擦除。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// TypeBox 的 Type 用来构建 JSON Schema；这里必须从 "typebox" 导入，而不是 pi-ai 的 Type。
import { Type } from "typebox";

// 所有 echo 工具共享同一个参数 schema 对象；message 是必填字符串，description 会进入 schema 的字段说明。
const ECHO_PARAMS = Type.Object({
	message: Type.String({ description: "Message to echo" }),
});

// 规范化用户输入的工具名：去首尾空格、转小写，只保留 a-z0-9_；非法或空返回 undefined。
// 输入 string，输出 string | undefined；无副作用。示例："MyTool" -> "mytool"，"bad-name" -> undefined。
function normalizeToolName(input: string): string | undefined {
	// toLowerCase 让名字大小写不敏感；trim 只去首尾空白，中间空格会留下并导致校验失败。
	const trimmed = input.trim().toLowerCase();
	// 空串直接拒绝；显式返回 undefined，而不是抛错。
	if (!trimmed) return undefined;
	// 正则允许数字开头，也允许下划线；不允许连字符、点号和非 ASCII 字符。
	if (!/^[a-z0-9_]+$/.test(trimmed)) return undefined;
	// 返回小写后的名字；后续 label/prefix 都基于这个值。
	return trimmed;
}

// 扩展入口：创建去重集合、注册固定工具和动态命令；加载时不注册任何工具。
export default function dynamicToolsExtension(pi: ExtensionAPI) {
	// 记录已注册名字，防止重复调用 registerTool；Set 只在扩展实例内共享，不跨进程。
	const registeredToolNames = new Set<string>();

	// 按名字注册一个 echo 工具；已存在时返回 false，否则注册并返回 true。
	// 输入 name/label/prefix；prefix 会拼在返回文本前。唯一副作用是注册工具和修改 Set。
	// 示例：registerEchoTool("foo", "Echo foo", "[foo] ") 之后模型可调用 foo(message)。
	const registerEchoTool = (name: string, label: string, prefix: string): boolean => {
		// 先查重，避免同名 registerTool 覆盖已有定义。
		if (registeredToolNames.has(name)) {
			// 返回 false 让命令层提示“已注册”。
			return false;
		}

		// 先占位再注册；如果 registerTool 抛错，名字仍留在 Set 中，后续重试会被判重。
		registeredToolNames.add(name);
		// registerTool 可在会话运行期间调用；这里在命令处理阶段执行，注册会请求刷新宿主工具表。
		pi.registerTool({
			name,
			label,
			// description 是给模型看的工具说明；prefix 带尾随空格，会被直接插入句子。
			description: `Echo a message with prefix: ${prefix}`,
			// promptSnippet 用 prefix.trim() 去掉尾随空格；它只是提示片段，不参与 schema 校验。
			promptSnippet: `Echo back user-provided text with ${prefix.trim()} prefix`,
			// guidelines 是静态数组，所有动态工具都复用它；文案固定提到 echo_session，这是示例的简化。
			promptGuidelines: ["Use echo_session when the user asks for exact echo output."],
			// parameters 复用顶层 ECHO_PARAMS；TypeBox 对象只在加载时构建一次。
			parameters: ECHO_PARAMS,
			// execute 只接收 toolCallId 和已按 schema 校验的 params；未使用 signal/onUpdate/ctx。
			async execute(_toolCallId, params) {
				return {
					// content 是工具返回给模型的内容；text 直接拼接 prefix 与消息，不做转义。
					content: [{ type: "text", text: `${prefix}${params.message}` }],
					// details 不进入模型正文，供渲染器/日志使用；类型由 execute 返回值推断。
					details: { tool: name, prefix },
				};
			},
		});

		return true;
	};

	// 每次 session_start（启动/恢复/分叉/新会话）都尝试注册；Set 保证同一实例只注册一次。
	pi.on("session_start", (_event, ctx) => {
		// 固定工具名 echo_session；label 是界面显示名，prefix 带尾随空格。
		registerEchoTool("echo_session", "Echo Session", "[session] ");
		// 无条件通知；非 TUI 模式由 UI 适配层决定是否显示。
		ctx.ui.notify("Registered dynamic tool: echo_session", "info");
	});

	pi.registerCommand("add-echo-tool", {
		description: "Register a new echo tool dynamically: /add-echo-tool <tool_name>",
		// args 是 /add-echo-tool 后的原始参数，可能为空或包含多个词。
		handler: async (args, ctx) => {
			// 规范化会截掉首尾空格并转小写；返回 undefined 表示名字非法。
			const toolName = normalizeToolName(args);
			// 非法名字给出用法提示；不注册、不抛错。
			if (!toolName) {
				ctx.ui.notify("Usage: /add-echo-tool <tool_name> (lowercase, numbers, underscores)", "warning");
				return;
			}

			// label 和 prefix 都用规范化后的名字；prefix 形如 "[foo] "。
			const created = registerEchoTool(toolName, `Echo ${toolName}`, `[${toolName}] `);
			// 已存在同名工具时 registerEchoTool 返回 false。
			if (!created) {
				// 提示重复；不会覆盖旧工具。
				ctx.ui.notify(`Tool already registered: ${toolName}`, "warning");
				return;
			}

			// 注册成功后再通知；此时宿主已收到 registerTool 调用。
			ctx.ui.notify(`Registered dynamic tool: ${toolName}`, "info");
		},
	});
}
