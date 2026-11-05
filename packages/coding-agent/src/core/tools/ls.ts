// 列出一个目录的直接条目，忽略大小写排序并给目录加 /；支持可替换文件系统后端，输出受条目数和字节上限限制。
import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
// Node 路径模块改名 nodePath，与模型参数中的 path 字段区分。
import nodePath from "path";
// Type 生成给模型和校验器使用的运行时 schema；Static 只在 TS 中推导输入字段类型。
import { type Static, Type } from "typebox";
// 只导入执行上下文和会话工具定义类型，运行时不会因此执行扩展逻辑。
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
// 共享路径解析和存在性探测，保证默认 cwd/~ 等规则与其他文件工具一致。
import { pathExists, resolveToCwd } from "./path-utils.ts";
// UI 展示函数单独实现，目录查询只返回内容与详情。
import { lsRenderers } from "./renderers/ls.ts";
// 定义工厂可以通过 wrapper 适配独立 Agent，参数 schema 仍保留 TypeBox 类型推导。
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";
// 复用公共字节上限与保留开头裁剪，目录很多时不无限扩大模型上下文。
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

// 运行时参数规则，只含可选目录 path 与数量 limit。
const lsSchema = Type.Object({
	// 可选目录路径，未传则列当前会话工作目录，不是必须提供的文件名。
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	// 可选条目上限，默认 500；输出字节预算仍可能先触发。
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

// 提供系统提示词里的一行 ls 能力说明。
export const lsToolSystemPromptContribution = {
	// 给系统提示词的一行工具用途说明，不会在装配提示时读取目录。
	snippet: "List directory contents",
	// ls 没有额外逐项提示规则，但保持统一工具元数据形状。
	guidelines: [],
	// 保持字面量/只读类型，不会冻结运行时对象。
} as const;

// 从 schema 推导 TS 输入类型，保持调用参数提示一致。
export type LsToolInput = Static<typeof lsSchema>;

// 默认展示不超过 500 个条目，另有共同字节上限。
const DEFAULT_LIMIT = 500;

// 给 UI/日志的裁剪与数量限制详情。
export interface LsToolDetails {
	// 字节裁剪的可选细节。
	truncation?: TruncationResult;
	// 触及条目数量上限时保存该上限值。
	entryLimitReached?: number;
}

/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (for example SSH).
 */
// ls 的文件系统查询适配契约，默认本地，也可换远程实现。
export interface LsOperations {
	/** Check if path exists */
	// 存在性后端可同步或异步，执行器统一 await。
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Get file or directory stats. Throws if not found. */
	// 只要求结果有 isDirectory()，无需依赖完整 Node Stats，方便远程适配。
	stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
	/** Read directory entries */
	// 列出直接条目名字；可同步或异步返回。
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

// 默认委托本机 Node 文件系统查询。
const defaultLsOperations: LsOperations = {
	// 共享存在性辅助把 access 失败折合为 false。
	exists: pathExists,
	// 查文件/目录类型，符号链接按 Node stat 语义跟随目标。
	stat: fsStat,
	// 读取直接条目名，不递归。
	readdir: fsReaddir,
};

// 工具工厂的宿主配置，不向模型暴露后端替换能力。
export interface LsToolOptions {
	/** Custom operations for directory listing. Default: local filesystem */
	// 可省略文件系统适配器。
	operations?: LsOperations;
}

/**
 * 创建 ls 定义，输入 cwd 与可选 exists/stat/readdir，返回 schema、execute、UI 渲染器，无立即 I/O。
 * 执行：确认目录存在且确为目录 → 读直接条目 → 排序 → 查询类型 → 格式化 → 应用字节上限。
 * 例如 ls({path:"src",limit:20}) 返回 src 下最多 20 个可显示条目，不递归到每个子目录。
 */
export function createLsToolDefinition(
	// 默认搜索根目录，执行时 ctx.cwd 可覆盖。
	cwd: string,
	// 创建时可用默认后端，也可显式注入。
	options?: LsToolOptions,
	// 返回输入按 lsSchema 推导、详情可为空的会话工具定义；不等于一次已执行的列表结果。
): ToolDefinition<typeof lsSchema, LsToolDetails | undefined> {
	// ls 所有文件系统动作均通过可替换 operations。
	const ops = options?.operations ?? defaultLsOperations;
	// 返回 ls 定义，保存 execute 供之后调用；创建工具时不列目录。
	return {
		// 模型发出 ls toolCall 时按此名匹配。
		name: "ls",
		// 界面展示名。
		label: "ls",
		// 给模型说明排序、目录尾斜杠、包含点文件和双重上限，模板预算与执行默认值来自同一常量。
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		// 接入 system 提示词摘要。
		promptSnippet: lsToolSystemPromptContribution.snippet,
		// 模型参数 schema，上层 Agent 先校验再执行。
		parameters: lsSchema,
		/**
		 * 执行一次目录查询；模型参数 path/limit 可省略，返回一个异步工具结果，不改变目录或文件。
		 * 取消会拒绝外层 Promise，但底层自定义文件系统方法未接 signal，不保证其 I/O 立即停止。
		 */
		async execute(
			// 统一调用 id 参数，本实现没有使用它；前导下划线表明有意未使用。
			_toolCallId,
			// 解构两个可选字段；TS 的 ? 不会自动为运行时值填默认值。
			{ path, limit }: { path?: string; limit?: number },
			// 可选取消信号，由工具循环传下；具体中止子进程或忽略晚到结果需要本工具实现。
			signal?: AbortSignal,
			// 保留统一部分结果回调位置；搜索工具在这里主要收集完再一次返回。
			_onUpdate?,
			// 上下文提供当前会话 cwd；独立调用没有 ctx 时退回工厂目录。
			ctx?: ExtensionContext,
		) {
			// 把子进程事件和异步文件操作包装为统一工具 Promise：resolve 返回工具结果，reject 报告失败。
			return new Promise((resolve, reject) => {
				// 执行前/异步阶段后观察取消；已取消时不应继续报告正常搜索结果。
				if (signal?.aborted) {
					// 取消作为工具失败传播，Agent 再包装成错误结果。
					reject(new Error("Operation aborted"));
					// 预先取消已拒绝本次 Promise，停止继续挂监听和发起文件查询。
					return;
				}

				/** 收到取消时拒绝本次结果；文件系统查询本身没有显式取消参数，后续工作可能仍完成。 */
				// 局部取消回调通过 Promise 拒绝报告取消，不直接终止 stat/readdir 的底层 I/O。
				const onAbort = () => reject(new Error("Operation aborted"));
				// 如果存在信号，监听一次取消；once:true 自动限制此监听触发次数。
				signal?.addEventListener("abort", onAbort, { once: true });

				// 立即执行异步函数，以便在 Promise 的同步构造回调里使用 await。
				(async () => {
					// 异步目录工作统一捕获，文件系统错误不会成为脱离工具结果的未处理拒绝。
					try {
						// 未提供目录就用当前会话目录，统一解析成绝对路径。
						const dirPath = resolveToCwd(path || ".", ctx?.cwd || cwd);
						// 没传 limit 用工具默认值；?? 不会把显式 0 当作缺省。
						const effectiveLimit = limit ?? DEFAULT_LIMIT;

						// Check if path exists.
						// 目录根找不到时不能继续 readdir；错误保留具体路径。
						if (!(await ops.exists(dirPath))) {
							// 路径缺失或存在性探测失败时报告错误。
							reject(new Error(`Path not found: ${dirPath}`));
							// 根目录无法定位已报告错误，不继续 stat 或 readdir。
							return;
						}

						// Check if path is a directory.
						// 查询根路径属性，不读取文件正文。
						const stat = await ops.stat(dirPath);
						// ls 只列目录；传普通文件应明确报错，不能当空目录。
						if (!stat.isDirectory()) {
							// 目标是普通文件时明确拒绝，而非当作没有条目。
							reject(new Error(`Not a directory: ${dirPath}`));
							// 目标不是目录已报告，停止调用只适用于目录的 readdir。
							return;
						}

						// Read directory entries.
						// 声明稍后异步读取到的目录名数组。
						let entries: string[];
						// 单独捕获读取目录名失败，错误消息包含 Cannot read directory 的具体上下文。
						try {
							// 读取直接子条目名，不递归遍历整棵目录；包括是否隐藏由文件系统返回决定。
							entries = await ops.readdir(dirPath);
							// 存在性/类型成功不保证随后仍可列目录，权限或竞态失败在此明确拒绝。
						} catch (e: any) {
							// 存在性/类型检查成功后仍可能无权限列目录，保留读取失败原因。
							reject(new Error(`Cannot read directory: ${e.message}`));
							// 列目录失败已报告，不再排序或查询条目类型。
							return;
						}

						// Sort alphabetically, case-insensitive.
						// 按忽略大小写的字典顺序原地排序，使输出更稳定。
						entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

						// Format entries with directory indicators.
						// 构造用于展示的名称数组，目录后面会附 /。
						const results: string[] = [];
						// 记录数量是否达到上限，不和输出字节截断混为一谈。
						let entryLimitReached = false;
						// 按排序后的顺序逐个检查条目类型。
						for (const entry of entries) {
							// 结果数量够了就停，不对剩余条目继续 stat。
							if (results.length >= effectiveLimit) {
								// 提示当前目录可能还有未显示的条目。
								entryLimitReached = true;
								// 已达到可显示条目上限，跳出循环，避免继续对剩余条目做 stat。
								break;
							}

							// 把根目录与单个条目名合成待 stat 的路径。
							const fullPath = nodePath.join(dirPath, entry);
							// 普通文件不加后缀；如果确认是目录再改成 /。
							let suffix = "";
							// 每个条目查询单独处理错误，目录在查询期间可能变化。
							try {
								// 单独查该条目属性；从 readdir 到此期间它可能被删除，错误由内层 catch 跳过。
								const entryStat = await ops.stat(fullPath);
								// 目录名附 /，让模型一眼区分文件和子目录。
								if (entryStat.isDirectory()) suffix = "/";
								// 这个条目已经无法 stat 时跳过它，不让一个失效文件使整份目录列表失败。
							} catch {
								// Skip entries we cannot stat.
								// 只跳过当前条目，继续尝试后面的目录名。
								continue;
							}
							// 把确认可访问条目的名称放进结果，不能 stat 的条目不显示。
							results.push(entry + suffix);
						}

						// 不再需要取消回调，移除监听避免保留闭包和结束后继续触发。
						signal?.removeEventListener("abort", onAbort);

						// 没有可显示条目时给空目录提示；这也包括条目全部 stat 失败的情况。
						if (results.length === 0) {
							// 空列表是正常成功结果，没有额外截断详情。
							resolve({ content: [{ type: "text", text: "(empty directory)" }], details: undefined });
							// 正常空列表已返回，结束目录处理，不追加上限提示或多余正文。
							return;
						}

						// 每个条目一行，转换成共同裁剪器的输入正文。
						const rawOutput = results.join("\n");
						// Apply byte truncation. There is no separate line limit because entry count is already capped.
						// 数量上限已经控制结果条数，这里放宽行数、仍保留共同字节上限。
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
						// 采用预算内正文，之后附加数量/字节上限提示。
						let output = truncation.content;
						// 收集可选详情字段，没有字段时最终返回 undefined。
						const details: LsToolDetails = {};
						// Build actionable notices for truncation and entry limits.
						// 收集多条限制说明，最后统一用句点拼接，不把用户输出逐行重复。
						const notices: string[] = [];
						// 数量上限触发时告知如何提高 limit。
						if (entryLimitReached) {
							// 建议把 limit 翻倍以查看更多；只是提示，不自动再次调用工具。
							notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
							// 给 renderer 的结构化条目上限记录。
							details.entryLimitReached = effectiveLimit;
						}
						// 输出字节太大时，即使结果数不多也可能需要截断。
						if (truncation.truncated) {
							// 提示触发共同字节上限，formatSize 转为易读 KB 数。
							notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
							// 把完整截断计数留给 UI/日志。
							details.truncation = truncation;
						}
						// 只有存在限制说明才附加提示段，正常小结果不加无意义尾注。
						if (notices.length > 0) {
							// 限制提示单独占一段，不假装它是原目录内容。
							output += `\n\n[${notices.join(". ")}]`;
						}

						// 通过 Promise 成功值交给 Agent，包含模型正文及可选 UI 详情。
						resolve({
							// 模型看到的是已裁剪条目列表及必要提示。
							content: [{ type: "text", text: output }],
							// 三元表达式：确有详情字段才返回对象，否则显式 undefined。
							details: Object.keys(details).length > 0 ? details : undefined,
						});
						// 其他文件系统/格式化错误到达外层时，移除取消监听并拒绝工具 Promise。
					} catch (e: any) {
						// 不再需要取消回调，移除监听避免保留闭包和结束后继续触发。
						signal?.removeEventListener("abort", onAbort);
						// 把文件系统或其他执行错误传播出去；原文件不受 ls 修改。
						reject(e);
					}
				})();
			});
		},
		// 接上工具行与结果显示函数，不改变目录查询行为。
		...lsRenderers,
	};
}

/** 创建供低层 Agent 使用的 ls 适配器，工厂调用不会访问目录。 */
export function createLsTool(cwd: string, options?: LsToolOptions): TypeBoxAgentTool<typeof lsSchema> {
	// 建 ls 定义再适配成低层工具，这里不实际列目录。
	return wrapToolDefinition(createLsToolDefinition(cwd, options));
}
