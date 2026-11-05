// 以会话文档映射执行目录：展示每会话环境选择，不把不同目录误认为操作系统级沙箱。
// One sandbox per conversation: the app records each conversation's sandbox in its own document, and the Harness
// environment function looks it up for every tool call. Here a sandbox is a directory; a hosted product would return
// an ExecutionEnv that runs inside the conversation's container.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/28-sandbox-per-conversation.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import { createRegistry, defineDoc, Harness, MemoryStorage } from "../../src/index.ts";
import { CodingTools } from "../../src/tools/index.ts";

// 上下文传给存储/任务操作；此例所谓 sandbox 是不同 cwd 目录，NodeExecutionEnv 不提供容器隔离。
const context = BACKGROUND_CONTEXT;

// Which sandbox a conversation runs in. `fork: "initial"`: a fork gets no sandbox until the app assigns one.
// 泛型中的 path?:string 表示字段可缺省；这是开发期结构，文档令牌本身不校验路径权限。
const Sandbox = defineDoc<{ path?: string }>({
	// 无参数策略回调返回 false，不主动生成检查点。
	checkpointWhen: () => false,
	// 以 app.sandbox 和 version=1 识别会话文档。
	kind: "app.sandbox",
	version: 1,
	// 每个会话独立寻址该文档。
	scope: "conversation",
	// 只需要当前分配，不保留可回退内容历史。
	history: "latest",
	// fork 重建初值，因此不会自动复用父会话目录。
	fork: "initial",
	// 无参数初值回调返回空对象；新会话须由宿主填写 path。
	initial: () => ({}),
});

// 建立本地脚本化假 provider。
const faux = fauxProvider();
// 创建模型目录。
const models = createModels();
// 注册 faux，后面的字符串模型引用才能解析。
models.setProvider(faux.provider);
// 纯消息工厂接收 string，返回调用 write 的助手消息，不在这里写文件。
// 例如 note("from alice") 请求将该字符串写入相对路径 note.txt。
const note = (text: string) =>
	fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: text }), { stopReason: "toolUse" });
// 按顺序安排两次写工具请求及完成回答；真实工具会各写一次临时文件。
faux.setResponses([
	note("from alice"),
	fauxAssistantMessage("Saved."),
	note("from bob"),
	fauxAssistantMessage("Saved."),
]);

// 创建注册表。
const registry = createRegistry();
// 安装内置编码工具，包含 write。
registry.install(CodingTools);
// 在内存存储打开 Harness，传入按会话文档查询路径的异步环境工厂。
const harness = await Harness.open(
	new MemoryStorage(),
	{
		models,
		registry,
		// Committed reads only; a conversation without a sandbox gets no environment, so its tools fail cleanly.
		// 环境回调接收 conversationId、已提交读取器和上下文，返回 Node 环境或 undefined。
		// 读取失败直接传播；没有路径则不创建环境，后续依赖环境的工具通过 requireEnv 报错。
		env: async ({ conversationId, read }, envContext) => {
			// snapshot 只读取已提交文档，不取得可变草稿。
			const sandbox = await read.snapshot(Sandbox, conversationId, envContext);
			// 先检查路径是否缺省；已分配时以该路径为 cwd 创建环境，不自动限制绝对路径访问。
			return sandbox?.path === undefined ? undefined : new NodeExecutionEnv({ cwd: sandbox.path });
		},
	},
	context,
);

// Each user's conversation gets a fresh sandbox in the creating commit.
// 两个会话使用同一假模型引用，彼此状态仍独立。
const model = { provider: "faux", modelId: "faux-1" };
// 异步工厂接收用户名用于临时目录前缀，返回会话句柄与其目录。
// 先创建真实目录，再在会话创建事务 init 中写入分配；例如 alice 会得到自己的 note.txt 所在目录。
// 若创建失败会抛错，本函数没有回滚先建目录；用户名在本例是固定可信值。
async function conversationFor(user: string) {
	// 创建独立目录；模板插值只组成目录前缀。
	const path = await mkdtemp(join(tmpdir(), `pi-durable-sandbox-${user}-`));
	// 创建不归任务所有的会话，并保存假模型配置。
	const conversation = await harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model },
			// 创建事务回调接收 tx 与新会话 id；返回 Promise<void>，异常使该提交失败。
			init: async (tx, id) => {
				// 取该新会话的文档草稿并赋值 path，与创建记录一并提交。
				(await tx.doc(Sandbox, id)).path = path;
			},
		},
		context,
	);
	// 对象简写把两个局部值返回给宿主用于运行和清理。
	return { conversation, path };
}

// 先分配 Alice 的独立会话和目录。
const alice = await conversationFor("alice");
// 再分配 Bob 的独立会话和目录。
const bob = await conversationFor("bob");
// 接纳并等待 Alice 输入；write 使用她的文档路径。
await (await alice.conversation.submit({ type: "input", content: "Leave a note." }, context)).wait(context);
// Alice 完成后再运行 Bob，避免脚本响应顺序发生歧义。
await (await bob.conversation.submit({ type: "input", content: "Leave a note." }, context)).wait(context);
// 真实读取 Alice 的临时文件，按 UTF-8 解码并打印。
console.log("alice's sandbox:", await readFile(join(alice.path, "note.txt"), "utf8"));
// 独立读取 Bob 的临时文件，对照同名文件内容。
console.log("bob's sandbox:", await readFile(join(bob.path, "note.txt"), "utf8"));

// 等待 Harness 关闭后再清理目录。
await harness.close(context);
// 递归删除 Alice 的临时目录；异常路径没有 finally 兜底。
await rm(alice.path, { recursive: true, force: true });
// 删除 Bob 的临时目录。
await rm(bob.path, { recursive: true, force: true });
