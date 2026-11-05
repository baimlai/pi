// 文件导读
// 所属：packages/durable 的 test/examples 系列第 09 个示例，演示通过注册表热替换扩展代码与按名称包装工具。
// 演示内容：安装 files 扩展（read/grep）后打开 Harness；用同名扩展整体替换 files，观察 grep 描述更新而 read 不变；
//   再安装 audit 扩展，用 wrapTool 在解析 agent 时给 read 的描述追加 "(audited)"；最后卸载 audit，描述恢复。
// 上游入口：从 packages/durable 目录直接运行；下游调用 createRegistry、defineExtension、defineTool、wrapTool、
//   Harness.open/root、Conversation.agent。没有模型请求与网络。
// 能力清单（按演示机制）：
// - defineExtension({name, tools, wraps})：扩展可携带工具和包装声明；名字是安装、替换、卸载的键。
// - registry.install(ext)：同名安装原地替换并一次发布新快照；不会出现“旧已删、新未装”的空窗。
// - registry.uninstall(ext)：按名字移除扩展；之后重新安装会追加到末尾。
// - wrapTool(tool, wrapper)：只保存工具名和回调；解析 agent 时，在“包装扩展被选中”的前提下对同名工具应用回调。
// - Conversation.agent()：每次按当前注册表快照重新解析；已开始的 task phase 保留它取到的快照，下一 phase 才用新代码。
// 典型运行顺序：定义工厂/read → 安装 files → open → root() → 打印工具 → 同名重装 files → 安装 audit → 打印 → 卸载 → 打印 → close。
// 示例（真实运行命令）：
//   cd packages/durable
//   node --conditions=source --experimental-strip-types test/examples/09-registry-reload.ts
// 实际输出：
//   after reload: [ 'read: Read a file', 'grep: Search files, faster' ]
//   with audit: [ 'read: Read a file (audited)', 'grep: Search files, faster' ]
//   after uninstall: [ 'read: Read a file', 'grep: Search files, faster' ]
// 阅读顺序：先看 exampleTool 与 tools 两个函数，再看同名 install 的替换语义，随后看 wrapTool 只在 audit 被选中时生效，
//   最后看 uninstall 后包装消失。
// Reload extension code through the registry.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/09-registry-reload.ts

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { obj, str } from "@earendil-works/pi-schema";
// wrapTool 是值导入；它返回包装声明，不立即执行 wrapper。
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, wrapTool } from "../../src/index.ts";

// 不取消任何操作。
const context = BACKGROUND_CONTEXT;

// 构造一个演示工具。输入 name/description，输出 ToolRegistration；execute 只回显 name 与 path。
// 无副作用、无错误路径；返回类型由 defineTool 的泛型从 schema 推导。
// 示例：exampleTool("grep", "Search files") 生成名为 grep 的工具，执行时返回文本 "grep <path>"。
function exampleTool(name: string, description: string) {
	return defineTool({
		name,
		description,
		parameters: obj({ path: str() }),
		execute: async (args) => ({ output: [{ type: "text", text: `${name} ${args.path}` }] }),
	});
}

// read 被后面的包装引用；grep 直接内联创建。
const read = exampleTool("read", "Read a file");
const registry = createRegistry();
// files 扩展包含 read 与 grep；install 立即发布快照。
registry.install(defineExtension({ name: "files", tools: [read, exampleTool("grep", "Search files")] }));
// 打开 Harness 并创建根会话；没有任何显式选择，因此默认使用所有已安装扩展。
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
const root = await harness.root(context);
// tools 是无参 async 函数：每次重新解析 agent，返回 "name: description" 字符串数组。
// 无副作用；用于观察注册表变化而不是缓存结果。示例：await tools() 当前为 ['read: Read a file', 'grep: Search files']。
const tools = async () => (await root.agent(context)).tools.map((tool) => `${tool.name}: ${tool.description}`);

// Reloading is installing a new object with the same name: it replaces the old
// one in place, in one publication, so no conversation ever sees it missing.
// A task phase that already started keeps the snapshot it took; the next phase
// uses the new code.
// 同名重装：新扩展对象替换旧扩展对象，位置不变，只发布一次新快照；read 仍是同一个对象，grep 换成新描述。
registry.install(defineExtension({ name: "files", tools: [read, exampleTool("grep", "Search files, faster")] }));
console.log("after reload:", await tools());

// Another extension may wrap a tool by name. The wrap applies where the
// wrapping extension is selected, and survives reloads of the wrapped tool.
// Audit 只包含包装声明；wrapTool 保存 read.name 与回调，不在此刻调用回调。
// 回调接收当前解析出的工具，返回展开复制并改过 description 的新对象；原工具不被修改。
// 包装只在 audit 被选中时生效；默认选择包含所有已安装扩展，所以安装后立即看到 "(audited)"。
const Audit = defineExtension({
	name: "audit",
	wraps: [wrapTool(read, (tool) => ({ ...tool, description: `${tool.description} (audited)` }))],
});
registry.install(Audit);
console.log("with audit:", await tools());

// Uninstall removes an extension by name; conversations that select it stop
// getting its code.
// uninstall 只移除 audit；files 与其中的 read 保持安装，因此 read 的描述恢复为原值。
registry.uninstall(Audit);
console.log("after uninstall:", await tools());

// 关闭 Harness 与存储；注册表是应用对象，不随之持久化。
await harness.close(context);
