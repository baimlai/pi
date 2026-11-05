// write 工具定义：完整写入/覆盖一个文件，自动建立父目录；由 Agent 工具循环调用，结果交给 write renderer 展示。
// 具名导入并改名：fsMkdir/fsWriteFile 是返回 Promise 的 Node 文件系统 API。
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "fs/promises";
// dirname 取父目录，例如 /project/a/b.txt 的父目录是 /project/a。
import { dirname } from "path";
// Type 运行时构造 JSON schema，Static 只在 TS 编译时从 schema 推导参数类型。
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { writeRenderers } from "./renderers/write.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";

// 运行时参数边界：模型送来的 JSON 需按这份对象 schema 校验，而 TS 类型会在运行前擦除。
const writeSchema = Type.Object({
	// path 必须为字符串，既可绝对路径，也可相对会话目录。
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	// content 是要写入的完整正文；空字符串也合法，可把文件清空。
	content: Type.String({ description: "Content to write to the file" }),
});

// 给 system 提示词拼装器的工具说明，不是运行时权限校验。
export const writeToolSystemPromptContribution = {
	// 一句话说明工具会新建或覆盖文件，直接参与给模型的提示。
	snippet: "Create or overwrite files",
	// 建议模型仅用 write 做新文件或整文件重写；局部替换应使用 edit。
	guidelines: ["Use write only for new files or complete rewrites."],
	// as const 保留字面量与只读类型；它不会冻结运行时对象。
} as const;

// 由同一个 schema 得到 TS 输入类型，避免手写类型和模型参数规则漂移。
export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
// 可替换的文件操作接口；本地实现或 SSH 实现都可遵守同一签名。
export interface WriteOperations {
	/** Write content to a file */
	// 写文件函数：输入绝对路径和全文，异步完成，无业务返回值。
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	// 建目录函数：自定义实现应支持这里所需的父目录创建语义。
	mkdir: (dir: string) => Promise<void>;
}

// 默认采用本机文件系统；注入 operations 才会替换为其他执行位置。
const defaultWriteOperations: WriteOperations = {
	// 箭头函数转发 UTF-8 写入；writeFile 默认会覆盖目标文件。
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	// 递归建立父目录；then 空回调把 mkdir 的额外返回值转为 Promise<void>。
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

// 工具工厂的可选配置类型，不是模型能填写的参数。
export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	// ? 表示可省略，省略时下面采用默认本地操作。
	operations?: WriteOperations;
}

/**
 * 创建 write 的描述、参数规则与执行函数，创建阶段不写文件；cwd 是缺少执行上下文时使用的默认目录。
 * 执行流程：解析路径 → 加同文件写队列 → 建父目录 → 写 UTF-8 全文 → 返回成功文字；失败抛错供 Agent 转成工具错误。
 * 例：write({path:"notes/a.txt", content:"你好"}) 会建立 notes，文件已有内容会被整个覆盖，不是局部插入。
 */
export function createWriteToolDefinition(
	// 工具默认工作目录，用于解析相对路径。
	cwd: string,
	// 可选的宿主配置；与模型传入的 path/content 分开。
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, undefined> {
	// ?. 安全读取可选配置；?? 仅在 null/undefined 时使用默认操作。
	const ops = options?.operations ?? defaultWriteOperations;
	// 返回完整 write 定义，保存 execute 供未来调用；创建定义不会立即写文件。
	return {
		// 运行时按 write 这个名字匹配模型发出的 toolCall。
		name: "write",
		// 界面展示的工具名称。
		label: "write",
		// 下面的英文是发给模型的能力说明，不能为添加中文注释而改变这段提示词。
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		// 将上面的提示词摘要接进工具定义。
		promptSnippet: writeToolSystemPromptContribution.snippet,
		// 数组展开复制规则数组，保留原规则文字。
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		// 供模型声明和 Agent 参数校验共同使用的 schema。
		parameters: writeSchema,
		// 告诉支持的供应商优先用 schema 约束生成参数；仍需实际运行时校验。
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		/**
		 * 执行一次完整文件写入；传入 path/content，返回异步工具结果，副作用是创建目录和覆盖文件。
		 * 取消在每次 await 前后检查，但不会撤销已经完成的写入，也不承诺写入原子性。
		 */
		async execute(
			// 统一工具签名中的调用 id；前导下划线表示本实现没有使用它。
			_toolCallId,
			// 对象解构直接取两项；冒号后的对象只描述 TypeScript 类型。
			{ path, content }: { path: string; content: string },
			// 取消信号可省略；它只能通知这里停止后续步骤，不会自动回滚已写字节。
			signal?: AbortSignal,
			// write 不发布中间结果，保留通用签名位置。
			_onUpdate?,
			// 执行上下文可能提供当前会话目录；可缺省以支持独立工具调用。
			ctx?: ExtensionContext,
		) {
			// 执行上下文 cwd 优先，否则用工厂 cwd，将 path 正规化为绝对路径。
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			// 取目标父目录，建立目录后再写文件。
			const dir = dirname(absolutePath);
			// 把实际操作交给同文件队列；箭头回调会在该文件前一次修改结束后才运行。
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				/**
				 * 检查取消信号的局部闭包；无参数，通过外层捕获 signal，取消就抛错。
				 * 必须等在途 mkdir/writeFile 结束才释放队列，不能收到 abort 就提前让同文件下一写入并发开始。
				 */
				const throwIfAborted = (): void => {
					// signal 已取消就抛错；这是执行状态检查，不是检查一个 TS 已保证的字段类型。
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				// 在阶段边界观察取消；出现于 await 后时，说明在途文件操作已结束才会继续/抛错。
				throwIfAborted();
				// Create parent directories if needed.
				// 异步建立父目录，等待它真正完成才进入写入阶段。
				await ops.mkdir(dir);
				// 在阶段边界观察取消；出现于 await 后时，说明在途文件操作已结束才会继续/抛错。
				throwIfAborted();

				// Write the file contents.
				// 实际覆盖文件内容，等待写入 Promise 结束；此处才产生主要文件副作用。
				await ops.writeFile(absolutePath, content);
				// 在阶段边界观察取消；出现于 await 后时，说明在途文件操作已结束才会继续/抛错。
				throwIfAborted();

				// 写入完成且未观察到取消后，返回标准工具结果，让 Agent 包装为 toolResult 消息。
				return {
					// 返回给模型的成功文字；模板字符串 ${path} 填入调用者提供的路径。
					content: [{ type: "text", text: `Successfully wrote to ${path}` }],
					// 此工具没有额外展示详情，显式给出 undefined。
					details: undefined,
				};
			});
		},
		// 对象展开接上终端渲染函数，执行与显示保持分开。
		...writeRenderers,
	};
}

/**
 * 把完整 ToolDefinition 适配为低层 AgentTool；返回工具对象，不执行 write。
 * 例：createWriteTool("/project") 可放入自定义 Agent 的 tools 数组；会话层也能直接用定义版本装配上下文。
 */
export function createWriteTool(cwd: string, options?: WriteToolOptions): TypeBoxAgentTool<typeof writeSchema> {
	// 先建定义，再用 wrapper 转为 AgentTool；这两步都不会立即写入文件。
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
