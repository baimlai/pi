// 用三个固定响应演示提示词片段、扩展包装、子会话独立指令和 cwd 变化。
// 脚本只打印记录，不断言完整提示词；顶层异步错误直接向外传播。
// System prompt sections and per-conversation instructions.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/14-system-prompt.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	Harness,
	MemoryStorage,
	SystemEntry,
	section,
	wrapSection,
} from "../../src/index.ts";

// 共享本示例各次读写和等待的操作上下文。
const context = BACKGROUND_CONTEXT;
// 创建只消耗预设回答的假提供方，不发真实模型请求。
const faux = fauxProvider();
// 建立模型集合。
const models = createModels();
// 注册 faux 模型。
models.setProvider(faux.provider);
// 三个输入各消耗一个 Done.；这个队列不检验模型是否遵守提示词。
faux.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("Done."), fauxAssistantMessage("Done.")]);

// Pico stores no prompt state. Before each model request, the sections of the
// conversation's selected extensions render the desired prompt, and only the
// difference to what the model already saw is appended to the transcript as a
// `pi.system` entry.
// 定义 coding 扩展；这里只构造带类型的声明，安装后才参与生成。
const Coding = defineExtension({
	// 用名称标识扩展。
	name: "coding",
	// 按声明顺序提供提示词片段。
	sections: [
		// `tag: false` sends the text as is; by default it is wrapped in <key>...</key>.
		// 固定片段回调忽略输入；tag:false 直接发送文本。
		section("preamble", () => "You are a coding agent.", { tag: false }),
		// Sections see the environment built for this request, here its working directory.
		// 回调从本次环境读取目录；?. 在没有环境时返回 undefined，使片段不产生文本。
		section("cwd", (input) => input.env?.cwd),
	],
});
// 定义模拟 AGENTS.md 内容的扩展；这里没有读取磁盘上的真实文件。
const AgentsMd = defineExtension({
	name: "agents-md",
	// 每次返回相同说明，默认以 agents_md 标签包装。
	sections: [section("agents_md", () => "Run npm run check after changes.")],
});
// Another extension decorates a section by key without replacing it.
// 第三个扩展包装已有片段，不另建相同 key 的片段。
const Terse = defineExtension({
	name: "terse",
	// 声明按 key 应用的包装器。
	wraps: [
		// 输入原 PromptSection，返回一个新片段；箭头后的 ({ 表示直接返回对象。
		wrapSection("preamble", (preamble) => ({
			// 对象展开保留原 key/tag 等字段，再由下面的 render 覆盖渲染函数。
			...preamble,
			// 把原输入与上下文传给原函数，等待结果再接后缀；若原函数抛错，此 async 回调也拒绝。
			render: async (input, renderContext) => `${await preamble.render(input, renderContext)} Be terse.`,
		})),
	],
});

// 建立默认注册表。
const registry = createRegistry();
// 安装原始 coding 片段。
registry.install(Coding);
// 安装模拟仓库要求。
registry.install(AgentsMd);
// 安装 preamble 包装规则。
registry.install(Terse);
// The environment follows each conversation's agent `cwd`.
// 环境工厂输入含可选 cwd 的只读属性类型，缺省用 /；返回真实 Node 文件/进程环境。
// 例如 cwd:"/repo" 只设置路径，并不在这里创建目录或读写文件；readonly 仅为 TypeScript 限制。
const env = ({ cwd = "/" }: { readonly cwd?: string }) => new NodeExecutionEnv({ cwd });
// 打开内存会话，把环境工厂交给每次需要环境的操作。
const harness = await Harness.open(new MemoryStorage(), { models, registry, env }, context);
// 复用同一个模型选择数据。
const model = { provider: "faux", modelId: "faux-1" };
// 首次创建根会话时设置模型与目录，渲染 cwd 片段会用到它。
const root = await harness.root(context, { agent: { model, cwd: "/repo" } });

// A subagent deselects AGENTS.md and gets its own instructions, rendered last
// as the `instructions` section.
// 创建独立会话：ownerless 不属于根的任务树，配置只作用于这份会话。
const subagent = await harness.createConversation(
	{
		// 使用有 kind 判别字段的所有权对象，不把它挂到父任务。
		ownership: { kind: "ownerless" },
		// 给新会话显式指定 agent 字段。
		agent: {
			model,
			cwd: "/repo",
			// 从该会话选择的扩展中移除 AgentsMd，其他已安装扩展仍可选择。
			extensions: { remove: [AgentsMd] },
			// 会话指令由内置 instructions 片段放在后面；它是模型文本要求，不是操作权限隔离。
			instructions: "Only read; never edit files.",
		},
	},
	context,
);

// 读取给定会话最近最多20条记录，返回按时间顺序展开的系统消息数组。
// 只有读取副作用；查询失败原样拒绝。例如 systemEntries(root) 用来观察哪些 pi.system 已实际追加。
async function systemEntries(conversation: Conversation) {
	// 读取一页逆序条目；并未遍历超过20条的历史。
	const page = await conversation.entries({}, 20, undefined, context);
	// 先复制并反转，类型守卫只保留 SystemEntry；空 model 用 []，flatMap 把每条消息数组合成一层。
	return [...page.items].reverse().flatMap((entry) => (SystemEntry.is(entry) ? (entry.model ?? []) : []));
}

// 两层 await 分别等待受理与回答，触发根的提示词渲染。
await (await root.submit({ type: "input", content: "Fix the build." }, context)).wait(context);
// 在独立会话触发自己的提示词渲染。
await (await subagent.submit({ type: "input", content: "Read the logs." }, context)).wait(context);
// 打印根会话已提交的系统消息。
console.log("root system prompt:", await systemEntries(root));
// 打印移除 AgentsMd 后的消息，供人工比较。
console.log("subagent system prompt:", await systemEntries(subagent));

// When a section's output changes, the next request appends only the change.
// 提交新的根 cwd；这一步本身不调用模型。
await root.configure({ cwd: "/repo/packages" }, context);
// 下一次生成使用新环境并按提示词差异追加系统条目。
await (await root.submit({ type: "input", content: "Now the package." }, context)).wait(context);
// 再次读系统记录以展示差异条目；不是把历史系统消息改写成最新值。
console.log("root system entries after cwd change:", await systemEntries(root));

// 结束调度与存储；无 finally，前面抛错会跳过正常关闭。
await harness.close(context);
