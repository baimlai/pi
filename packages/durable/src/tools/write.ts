// 所属：packages/durable/src/tools，Durable 内置的整文件写入工具。
// 解决的问题：模型需要创建或整体覆盖文件，同时父目录可能不存在。这里把“路径归一化 → 同一文件串行 → 覆盖写”
// 固化成工具，避免并发写互相覆盖，并把执行环境（本地、容器或远端）作为唯一文件系统来源。
// 职责边界：只覆盖写入字符串内容；不追加、不做差异合并（那是 edit）、不读取旧内容，也不决定是否允许写
// （权限与沙箱由 ExecutionEnv 和上层策略负责）。写入后的取消检查只报告取消，不回滚已经写入的内容。
// 上游：Harness 的 ToolTask 调用本工具；模型通过工具调用传入 { path, content }。下游：requireEnv、
// resolveToolPath、withFileMutationQueue、ExecutionEnv.writeFile。
// 能力清单：
// - WriteToolInput：由 writeSchema 推导的编译期参数类型（path、content 都是 string）。
// - createWriteTool()：返回 name 为 "write" 的 ToolRegistration；构造时不写文件。
// 组合与流向：execute 解构参数 → requireEnv → resolveToolPath → 入队 → 检查取消 → env.writeFile →
// 再检查取消 → 返回模型可见的成功文本。
// 示例（真实签名）：
//   const write = createWriteTool();
//   // 模型调用 write({ path: "a.txt", content: "hello" })，执行后 a.txt 为 hello（父目录由环境实现创建）。
// 建议阅读顺序：先看 writeSchema/WriteToolInput，再看 createWriteTool 的 execute 逐步流程。
import { obj, type Static, str } from "@earendil-works/pi-schema";
import { getOrThrow } from "../env/index.ts";
import { defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";
import { requireEnv } from "./env.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";

// schema 在运行时描述参数；open:true 接受额外属性，但 path/content 仍须是字符串。
const writeSchema = obj(
	{
		path: str({ description: "Path to the file to write (relative or absolute)" }),
		content: str({ description: "Content to write to the file" }),
	},
	{ open: true },
);

// typeof 取得 schema 的静态类型，Static 推导输入类型；类型别名本身不会校验模型发来的 JSON。
export type WriteToolInput = Static<typeof writeSchema>;

/**
 * 创建 write 工具定义，无参数；返回可注册的 ToolRegistration，构造时不写文件。
 * 执行时把 args.path 解析为环境绝对路径，排队后覆盖写入 args.content，返回成功文本。
 * 缺少环境、路径解析/写入失败或取消都会抛错。写入后的取消检查不能撤销已经发生的写入。
 * 例如参数 { path: "a.txt", content: "hello" } 会创建或覆盖环境中的 a.txt；父目录创建由环境实现负责。
 */
export function createWriteTool(): ToolRegistration<typeof writeSchema> {
	// defineTool 是保留对象的类型辅助函数，真正调用 execute 的是 Harness。
	return defineTool({
		// name/description/parameters 是给模型和运行时使用的原始工具契约。
		name: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		// args 经 Harness 的 schema 校验；api 给出环境，context 传递取消信号。
		async execute(args, api, context) {
			// 解构得到原始用户路径与完整替换内容，不做增量追加。
			const { path, content } = args;
			// 没有环境就抛错，不回退到当前 Node 进程的文件系统。
			const env = requireEnv(api);
			// 支持统一路径字符整理，再由 env 解析相对路径。
			const absolutePath = await resolveToolPath(env, path, context);
			// 同一文件的 edit/write 串行；参数依次是环境、文件、实际修改回调与上下文。
			return withFileMutationQueue(
				env,
				absolutePath,
				async () => {
					// 可能已在队列中等了很久，因此拿到队位后再检查取消。
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					// 执行完整覆盖写入；失败 Result 由 getOrThrow 转为异常。
					getOrThrow(await env.writeFile(absolutePath, content, context));
					// 写入期间收到取消也报告取消；这一步没有回滚文件的逻辑。
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					// output 是模型可见内容；这里报告原始 path，便于与用户输入对应。
					return { output: [{ type: "text", text: `Successfully wrote to ${path}` }] };
				},
				context,
			);
		},
	});
}
