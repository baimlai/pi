// 使用 ripgrep 搜索文件正文，返回带路径/行号的匹配行与可选上下文；自定义 operations 只替换 stat/readFile，默认搜索进程仍是本地 rg。
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
// 把子进程输出管道按完整行拆事件，避免自己处理跨 chunk 的换行边界。
import { createInterface } from "node:readline";
// 通过可执行文件加独立参数数组创建搜索进程，不把模式/路径拼成 shell 命令。
import { spawn } from "child_process";
// 默认导入 Node 路径工具；用于相对路径、父目录与平台分隔符计算。
import path from "path";
// Type 生成给模型和校验器使用的运行时 schema；Static 只在 TS 中推导输入字段类型。
import { type Static, Type } from "typebox";
// 工具管理器取得 rg/fd 可执行路径，可能在需要时补齐下载，执行工具时才调用。
import { ensureTool } from "../../utils/tools-manager.ts";
// 只导入会话上下文/完整工具定义类型，说明 execute 怎样接当前目录及返回对象。
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
// 使用执行上下文 cwd 解析搜索目录/单文件路径，兼容相对路径与 ~。
import { resolveToCwd } from "./path-utils.ts";
// grep 的终端显示与实际 rg 搜索分开。
import { grepRenderers } from "./renderers/grep.ts";
// 完整定义通过 wrapper 转为低层工具，TypeBoxAgentTool 在 TS 中保留模型参数推导。
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";
// 按具名导入复用整段/单行裁剪规则，避免搜索输出使用与其他工具不同的上限。
import {
	// 公共整段正文预算，路径/上下文多时也可能比匹配数量更早触发。
	DEFAULT_MAX_BYTES,
	// 把预算字节数转换为限制提示里的 KB/MB。
	formatSize,
	// 单行最大显示长度 500 个 JS 字符，独立于整段字节预算。
	GREP_MAX_LINE_LENGTH,
	// 只导入整段裁剪统计类型，不产生运行时值。
	type TruncationResult,
	// 保留结果列表开头，按公共字节预算裁剪整段文本。
	truncateHead,
	// 分别裁剪过长命中/上下文行并标记是否缩短。
	truncateLine,
	// 这些计数/格式化能力全部来自本地 truncate 模块，不请求模型做摘要。
} from "./truncate.ts";

// 工具运行时 schema，下面的字段决定模型可发送哪些搜索选项。
const grepSchema = Type.Object({
	// 必需搜索模式，默认按正则；literal=true 才改为普通字符串搜索。
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	// 可选搜索目录或单文件，省略时用当前会话目录。
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	// 按文件路径 glob 过滤搜索文件集合；不要与正文 pattern 正则混为一谈。
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	// 显式 true 才忽略大小写，默认遵守 pattern 的大小写要求。
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	// literal 选项决定把正文 pattern 当普通字符串还是正则；可省略。
	literal: Type.Optional(
		// 布尔值 true 对应 rg --fixed-strings，例如点号按点号查找而非匹配任意字符。
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	// 可选每个匹配的前后文行数，增加的是展示行数而不是额外匹配次数。
	context: Type.Optional(
		// 未给时默认 0；执行器把非正数 context 也按 0 处理。
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	// 最多收集的匹配事件数，默认 100，执行时至少夹为 1。
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

// 给系统提示词的 grep 能力摘要，不等于默认必定启用此工具。
export const grepToolSystemPromptContribution = {
	// 提供给 system 提示词的用途摘要：查正文内容，不与 find 的文件名查询混淆。
	snippet: "Search file contents for patterns (respects .gitignore)",
	// 这份工具没有额外逐项使用建议，但仍保留与其他工具相同的元数据形状。
	guidelines: [],
	// 保留提示词字面量和只读数组类型，运行时仍是普通对象。
} as const;

// 由同一参数 schema 推导 TS 输入类型。
export type GrepToolInput = Static<typeof grepSchema>;
// 默认最多收集 100 次匹配，不等于最多展示 100 行，因为每次还可能带上下文。
const DEFAULT_LIMIT = 100;

// 可选记录整体字节裁剪、匹配数量上限与单行裁剪三种情况。
export interface GrepToolDetails {
	// 整体返回正文超过公共预算时的细节。
	truncation?: TruncationResult;
	// 达到匹配数上限时记录实际 limit。
	matchLimitReached?: number;
	// 至少一条展示行超过单行字符预算。
	linesTruncated?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
// 可替换文件元信息/上下文读取；此接口没有搜索方法，因此不替代 rg 后端。
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	// 检查搜索根是目录还是文件，目标缺失时应抛错。
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	// 读取匹配文件上下文为字符串，可同步或异步，执行器统一 await。
	readFile: (absolutePath: string) => Promise<string> | string;
}

// 默认元信息/文本读取都来自本机文件系统。
const defaultGrepOperations: GrepOperations = {
	// 先 await 取得 Stats，再调用 isDirectory，路径不存在会拒绝。
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	// 按 UTF-8 读取上下文文字，不是二进制数据。
	readFile: (p) => fsReadFile(p, "utf-8"),
};

// 宿主构造工具时的可选配置。
export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	// 自定义 stat/readFile 不会让 rg 自动到远程主机执行。
	operations?: GrepOperations;
}

/**
 * 创建 grep 的参数规则、执行器和显示函数，不在构造时搜索。
 * 执行流程：取得 rg → 判断搜索根文件/目录 → 以 JSON 流收集匹配 → 可选异步读取上下文 → 截断单行/整体输出 → 返回结果。
 * 例如 grep({pattern:"TODO",glob:"*.ts",context:2}) 搜索 TS 文件 TODO 并显示每次匹配前后两行，和 find 按文件名匹配不同。
 */
export function createGrepToolDefinition(
	// 默认搜索根目录，执行时 ctx.cwd 可覆盖。
	cwd: string,
	// 不传时用本地元信息/上下文读取。
	options?: GrepToolOptions,
	// 工具定义的输入类型来自 grepSchema，详情可能为空；这里不包含实际结果正文。
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	// 保存宿主注入的后端对象，执行阶段再选择具体操作。
	const customOps = options?.operations;
	// 返回完整 grep 定义；模型之后选择调用它时才运行下方 execute。
	return {
		// 模型通过 grep 名称调用此工具。
		name: "grep",
		// 终端工具名。
		label: "grep",
		// 给模型说明结果带路径/行号、匹配数与整体预算，以及单行字符上限；三个限制共同影响最终可见输出。
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		// 向 system 提示词提供一句话用途。
		promptSnippet: grepToolSystemPromptContribution.snippet,
		// 上层 Agent 据此校验搜索参数，未通过则不会启动子进程。
		parameters: grepSchema,
		/**
		 * 执行一次正文搜索，不改文件；输入支持正则/字面量、大小写、文件 glob、上下文和匹配条数。
		 * 达到匹配上限会主动停止 rg，属于正常有结果路径；用户取消、真正 rg 错误则拒绝 Promise。
		 */
		async execute(
			// 统一调用 id 参数，本实现没有使用它；前导下划线表明有意未使用。
			_toolCallId,
			{
				// 解构本次正文搜索模式，具体按 literal 决定正则或字面量解释。
				pattern,
				// 解构时把 path 改名 searchDir，避免与导入的路径模块重名。
				path: searchDir,
				// 可选文件集合过滤规则。
				glob,
				// 可选忽略大小写开关。
				ignoreCase,
				// 可选字面量搜索开关。
				literal,
				// 可选匹配前后文展示行数。
				context,
				// 可选最大匹配次数。
				limit,
			}: {
				// 内联参数类型说明必需的正文模式是字符串；真正运行时值由 Agent schema 校验。
				pattern: string;
				// 路径类型是可选字符串，缺省目录由 execute 处理，而不是 TS 自动填值。
				path?: string;
				// 可选文件过滤字符串，不是 RegExp 对象。
				glob?: string;
				// 可选布尔值，undefined 和 false 最终都不添加 --ignore-case。
				ignoreCase?: boolean;
				// 可选布尔值，true 才添加 --fixed-strings。
				literal?: boolean;
				// 可选数值，调用执行代码时再处理正数/缺省语义。
				context?: number;
				// 可选匹配数，执行器合并默认值并夹到至少 1。
				limit?: number;
			},
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
					// 调用开始前已取消，Promise 已拒绝，停止设置搜索状态。
					return;
				}
				// 一个子进程可能触发 error/close 等多个出口，用标志保证只决定一次最终结果。
				let settled = false;
				/** 多个子进程事件共用单次完成函数；只首次调用 fn，避免 error 与 close 重复收尾。 */
				// 局部收尾函数，参数是这次真正 resolve/reject 的动作；先控制生命周期再执行动作。
				const settle = (fn: () => void) => {
					// 仅首次进入最终结果出口，后来 error/close 不再重复执行。
					if (!settled) {
						// 先标记已完成，避免清理过程中产生额外事件再次进入。
						settled = true;
						// 调用传进来的结束动作；传函数与立即执行函数是不同步骤。
						fn();
					}
				};

				// 立即执行异步函数，以便在 Promise 的同步构造回调里使用 await。
				(async () => {
					// 所有异步准备步骤统一捕获，防止 async 自执行回调的异常脱离工具 Promise。
					try {
						// 取得 ripgrep 程序，可能由工具管理器查找或下载；此处仍是默认本地搜索。
						const rgPath = await ensureTool("rg");
						// 无法取得后端程序时报告能力不可用，不假装没有匹配。
						if (!rgPath) {
							// 给模型明确的 rg 不可用错误。
							settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
							// 无法取得 rg 后端就结束；不继续做路径查询或启动不存在程序。
							return;
						}

						// 未给搜索目录则用当前会话目录；resolveToCwd 处理相对路径与 ~ 等输入形式。
						const searchPath = resolveToCwd(searchDir || ".", ctx?.cwd || cwd);
						// grep 的可替换部分是 stat/readFile；不同于 find.glob，这里仍会调用本地 rg 做搜索。
						const ops = customOps ?? defaultGrepOperations;
						// 先声明搜索根类型，稍后异步查询决定显示路径方式。
						let isDirectory: boolean;
						// 搜索根类型查询单独捕获，给模型明确路径错误。
						try {
							// 查询是否目录；这个 await 允许自定义后端异步实现。
							isDirectory = await ops.isDirectory(searchPath);
							// 目标缺失或查询失败时返回 Path not found 提示；不进入实际搜索。
						} catch {
							// 错误包含解析后的搜索根路径，便于模型修正。
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							// 路径错误已完成 Promise，停止继续构建 rg 参数。
							return;
						}

						// 只有正数 context 才启用上下文，未传/非正数按 0 处理。
						const contextValue = context && context > 0 ? context : 0;
						// 匹配上限至少 1，未传时默认 100，与 find/ls 不同，这里显式夹到正数。
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
						/**
						 * 把匹配文件变成适合显示的相对路径，搜索单文件或在根外时只显示 basename。
						 * 输入文件绝对路径，输出短路径，纯路径转换，不读取文件。
						 */
						const formatPath = (filePath: string): string => {
							// 搜索根为目录时优先输出相对目录路径，保留子目录层次。
							if (isDirectory) {
								// 计算文件相对搜索根的位置，不访问磁盘。
								const relative = path.relative(searchPath, filePath);
								// 只有根内的非空相对路径才采用，根外路径退到 basename。
								if (relative && !relative.startsWith("..")) {
									// Windows 反斜杠统一为 /，便于模型和跨平台显示。
									return relative.replace(/\\/g, "/");
								}
							}
							// 单文件或不适合相对化的路径只展示最后一段文件名。
							return path.basename(filePath);
						};

						// 本次 execute 专属文件行缓存，不是跨会话永久缓存。
						const fileCache = new Map<string, string[]>();
						/**
						 * 按需异步读取一个匹配文件，正规化 CRLF 后拆行并缓存；同一次搜索的多个命中复用一次读取。
						 * 读取失败缓存空数组，让 formatBlock 返回可读提示；缓存只活在本次 execute 闭包内。
						 */
						const getFileLines = async (filePath: string): Promise<string[]> => {
							// 优先复用已经读取的同文件内容，避免每个命中都重读。
							let lines = fileCache.get(filePath);
							// 只有没有缓存时才实际读取；空数组本身为真值，读失败也不会反复重试同文件。
							if (!lines) {
								// 读取上下文可能因文件消失/权限失败，内部 catch 允许保留命中位置说明。
								try {
									// 取得匹配文件全文，供生成上下文；异步后端也能使用。
									const content = await ops.readFile(filePath);
									// 将 CRLF 正规化为 LF 再拆行，后面用 1 起始行号索引数组。
									lines = content.replace(/\r\n/g, "\n").split("\n");
									// 只把本次上下文读取失败折为空行缓存，不把整个 rg 搜索都判失败。
								} catch {
									// 读取失败时记为空，随后返回“无法读取文件”的上下文说明。
									lines = [];
								}
								// 无论读取成功/失败都缓存本次结果，避免重复 I/O。
								fileCache.set(filePath, lines);
							}
							// 返回可复用的行数组，无需每次复制全部文本。
							return lines;
						};

						// --no-config: the tool contract (literal, glob, limit, ...) must not depend on
						// ambient user config like RIPGREP_CONFIG_PATH. Users can customize via bash or extensions.
						// 禁用外部 rg 配置，固定 JSON 协议、行号、无颜色并包含隐藏文件；避免用户环境配置改变工具契约。
						const args: string[] = ["--no-config", "--json", "--line-number", "--color=never", "--hidden"];
						// 明确开启忽略大小写才加 -i 等效参数。
						if (ignoreCase) args.push("--ignore-case");
						// 字面量模式不把括号、点号等作为正则元字符。
						if (literal) args.push("--fixed-strings");
						// 对搜索文件集合加 glob 过滤，和正文 pattern 分工不同。
						if (glob) args.push("--glob", glob);
						// 选项与搜索模式分开传参，-- 防止模式被当选项，不经 shell 插值。
						args.push("--", pattern, searchPath);

						// 实际启动 rg，读取 stdout JSON 行与 stderr 诊断。
						const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						// readline 把 stdout 流拆成逐行事件，避免自己处理跨 chunk 的换行。
						const rl = createInterface({ input: child.stdout });
						// 累计诊断输出，进程失败时作为错误说明。
						let stderr = "";
						// 累计匹配事件数量，而非统计输出中上下文行数量。
						let matchCount = 0;
						// 后续达到 limit 时设 true，用于提示还有可能未搜索完。
						let matchLimitReached = false;
						// 任何一行裁剪后都保留 true，结果末尾统一提示。
						let linesTruncated = false;
						// 区分用户取消与为达到数量上限主动终止进程。
						let aborted = false;
						// 主动停在 limit 属于成功的有结果路径，不应把信号退出当作 rg 故障。
						let killedDueToLimit = false;
						// 最终格式化后的命中/上下文行，进程结束后填充。
						const outputLines: string[] = [];

						/** 关闭逐行读取器并移除取消监听；子进程完成/错误时统一调用。 */
						// 清理搜索读取资源的局部回调。
						const cleanup = () => {
							// 停止 readline 继续发 line 事件，不等于自动杀掉子进程。
							rl.close();
							// 不再需要取消回调，移除监听避免保留闭包和结束后继续触发。
							signal?.removeEventListener("abort", onAbort);
						};
						/** 请求结束 rg 并区分“正常达到数量上限”与其他停止原因，防止主动停搜索被误报为程序失败。 */
						const stopChild = (dueToLimit = false) => {
							// 尚未请求 kill 时才发送停止请求；killed 表示已发信号，不等于已完成进程回收。
							if (!child.killed) {
								// 记住本次 stopChild 的原因。
								killedDueToLimit = dueToLimit;
								// 请求结束搜索进程，真正结束结果仍由 error/close 等后续事件收尾。
								child.kill();
							}
						};
						/** 标记用户取消并停止子进程；最终 close 回调根据 aborted 报告取消，而不是返回部分正常结果。 */
						const onAbort = () => {
							// 用户取消标志优先于已有部分结果。
							aborted = true;
							// 请求终止进程；真正结算在 close 回调。
							stopChild();
						};
						// 如果存在信号，监听一次取消；once:true 自动限制此监听触发次数。
						signal?.addEventListener("abort", onAbort, { once: true });
						// 有 stderr 管道时接收诊断字节；?. 避免管道不存在时访问失败。
						child.stderr?.on("data", (chunk) => {
							// 把诊断字节解码追加，便于最后组合错误。
							stderr += chunk.toString();
						});

						/**
						 * 异步格式化一次匹配及其前后若干行：读取/复用文件行，给命中行用冒号、上下文行用短横线，过长单行裁剪。
						 * 例如命中第 5 行、context=1，会显示第 4～6 行；文件读取失败返回路径+行号说明。
						 */
						const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
							// 把匹配源路径缩短为稳定显示路径。
							const relativePath = formatPath(filePath);
							// 需要上下文时读取并复用文件行缓存。
							const lines = await getFileLines(filePath);
							// 文件被删/无法读取也保留命中位置说明，不伪造上下文。
							if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
							// 收集这一次匹配周围的显示行。
							const block: string[] = [];
							// 前文起点不能小于第 1 行；context=0 只显示命中行。
							const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
							// 后文终点不超过文件末行。
							const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
							// 按原文件顺序输出这一段，行号范围包含两端。
							for (let current = start; current <= end; current++) {
								// 用户行号从 1 开始，数组下标从 0；缺位置用空串避免 undefined 进入格式化。
								const lineText = lines[current - 1] ?? "";
								// 去 CR 控制符，避免终端游标被回车影响。
								const sanitized = lineText.replace(/\r/g, "");
								// 当前行是不是本次真正命中行，决定冒号与短横线格式。
								const isMatchLine = current === lineNumber;
								// Truncate long lines so grep output stays compact.
								// 解构并改名：截断后的 text 存为 truncatedText，同时取得是否裁剪标志。
								const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
								// 保留跨所有结果的“存在过长行”标志。
								if (wasTruncated) linesTruncated = true;
								// 命中行用 file:line: 格式，便于定位。
								if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
								// 上下文行用短横线表示它不是额外命中。
								else block.push(`${relativePath}-${current}- ${truncatedText}`);
							}
							// 返回本次匹配的整段显示行，后面追加到总结果。
							return block;
						};

						// Collect matches during streaming, then format them after rg exits.
						// 用数组暂存 JSON 匹配事件的必要信息；lineText 有时可直接免读文件。
						const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
						// 每行路径到达时保存，不逐行发布新工具结果。
						rl.on("line", (line) => {
							// 忽略空 JSON 行或已经达到上限之后晚到的输出。
							if (!line.trim() || matchCount >= effectiveLimit) return;
							// 此处原实现把 rg 的外部 JSON 作为动态对象解析，any 不会提供字段类型保证。
							let event: any;
							// rg stdout 属于外部协议边界，每一行 JSON 解析单独捕获。
							try {
								// 解析每一行独立 JSON；无效行在 catch 中忽略，不当作搜索正文。
								event = JSON.parse(line);
								// 无效 JSON 行忽略；它不会作为普通搜索正文显示。
							} catch {
								// 跳过这一条损坏/非 JSON 输出，line 事件之后仍可处理其他行。
								return;
							}
							// rg 还会发 begin/end/summary，只对 match 事件计数。
							if (event.type === "match") {
								// 每收到一个命中事件增加一次数量。
								matchCount++;
								// 可选链读取外部协议字段，字段缺失时得到 undefined。
								const filePath = event.data?.path?.text;
								// 从 rg 协议取得从 1 开始的命中行号。
								const lineNumber = event.data?.line_number;
								// 协议直接提供的命中行文字，可在不需要上下文时省去一次文件读取。
								const lineText = event.data?.lines?.text;
								// 在外部 JSON 边界检查路径存在和行号类型，满足才保存可格式化匹配。
								if (filePath && typeof lineNumber === "number")
									// 保留原事件顺序，把普通对象加入数组。
									matches.push({ filePath, lineNumber, lineText });
								// 达到用户匹配上限后立即停进程，避免继续扫描巨大项目。
								if (matchCount >= effectiveLimit) {
									// 结果尾部将提示修改 limit 或缩小搜索模式。
									matchLimitReached = true;
									// 明确标为上限导致的正常提前终止。
									stopChild(true);
								}
							}
						});

						// 捕获无法 spawn 等进程错误，区别于 fd 正常运行后的非零退出码。
						child.on("error", (error) => {
							// 移除/关闭读取资源；具体取消监听也由各工具自己的收尾函数负责。
							cleanup();
							// 启动失败是工具错误，不能当作零命中成功。
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						// 进程结束后异步格式化，保证自定义 readFile 的 await 不在同步 line 事件里混乱交错。
						child.on("close", async (code) => {
							// 移除/关闭读取资源；具体取消监听也由各工具自己的收尾函数负责。
							cleanup();
							// 用户取消时不返回已经收集的部分成功结果。
							if (aborted) {
								// 通过单次收尾函数报告取消，避免与晚到的子进程 close 重复完成。
								settle(() => reject(new Error("Operation aborted")));
								// 进程关闭时确认用户取消，拒绝后不把部分匹配报告为成功。
								return;
							}
							// rg 0=有命中、1=无命中都属正常；仅在非主动上限停止的其他退出码时报错。
							if (!killedDueToLimit && code !== 0 && code !== 1) {
								// 优先诊断文本，缺省时展示异常退出码。
								const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
								// 通过统一出口拒绝，保证不会重复完成 Promise。
								settle(() => reject(new Error(errorMsg)));
								// 真正的 rg 故障已用 stderr/退出码报告，不继续展示可能不完整结果。
								return;
							}
							// 零命中是正常结果，模型可修改 pattern 或搜索范围。
							if (matchCount === 0) {
								// 把具体 resolve/reject 动作延迟交给单次收尾入口，避免 error/close 等并发事件重复决定结果。
								settle(() =>
									// 零命中正常成功，结果文字明确“没有匹配”，不能和 rg 执行失败混淆。
									resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }),
								);
								// 零匹配已返回成功提示，结束 close 回调。
								return;
							}

							// Format matches after streaming finishes so custom readFile() backends can be async.
							// 进程结束后按收集顺序格式化每次匹配。
							for (const match of matches) {
								// 不需要上下文且 rg 已提供正文时，直接用协议文字，避免多读文件。
								if (contextValue === 0 && match.lineText !== undefined) {
									// 使用同一短路径规则，保证有/无上下文显示一致。
									const relativePath = formatPath(match.filePath);
									// 开始正规化 rg 提供的命中行，移除不适合终端显示的回车与最终换行。
									const sanitized = match.lineText
										// 先统一 CRLF，避免留下额外 CR。
										.replace(/\r\n/g, "\n")
										// 清除剩余单个 CR 控制字符。
										.replace(/\r/g, "")
										// 只去掉末尾一个换行，保持正文中其他内容不变。
										.replace(/\n$/, "");
									// 解构并改名：截断后的 text 存为 truncatedText，同时取得是否裁剪标志。
									const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
									// 保留跨所有结果的“存在过长行”标志。
									if (wasTruncated) linesTruncated = true;
									// 将真实命中行追加到总显示结果。
									outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
									// 需要上下文或协议没提供正文时，改用异步文件读取/缓存生成显示块。
								} else {
									// 需要前后文时，异步读取/复用文件并生成一段。
									const block = await formatBlock(match.filePath, match.lineNumber);
									// 数组展开逐行追加，而不是把整块数组套成一个元素。
									outputLines.push(...block);
								}
							}

							// 所有格式化行拼成最终正文，再应用整体字节预算。
							const rawOutput = outputLines.join("\n");
							// Apply byte truncation. There is no line limit here because the match limit already capped rows.
							// 数量上限已经控制结果条数，这里放宽行数、仍保留共同字节上限。
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							// 采用预算内正文，之后附加数量/字节上限提示。
							let output = truncation.content;
							// 收集本次搜索触及哪些限制。
							const details: GrepToolDetails = {};
							// Build actionable notices for truncation and match limits.
							// 收集多条限制说明，最后统一用句点拼接，不把用户输出逐行重复。
							const notices: string[] = [];
							// 匹配数量达上限时写入提示与详情。
							if (matchLimitReached) {
								// 给最终文字追加一项可行动的限制说明；完整结果仍取前面已收集的条目/命中。
								notices.push(
									// 说明只收集了最多 limit 个命中，可提高上限或缩小模式；它不是对完整匹配总数的精确统计。
									`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								// 结构化记录实际匹配阈值。
								details.matchLimitReached = effectiveLimit;
							}
							// 输出字节太大时，即使结果数不多也可能需要截断。
							if (truncation.truncated) {
								// 提示触发共同字节上限，formatSize 转为易读 KB 数。
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								// 把完整截断计数留给 UI/日志。
								details.truncation = truncation;
							}
							// 单行裁剪与整体输出裁剪分别报告，模型可用 read 重新看完整行。
							if (linesTruncated) {
								// 给最终文字追加一项可行动的限制说明；完整结果仍取前面已收集的条目/命中。
								notices.push(
									// 过长单行缩短时建议 read 看原文，这与整段字节裁剪分别提示。
									`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
								);
								// 让 renderer 知道至少一条显示行不是完整原文。
								details.linesTruncated = true;
							}
							// 把各类限制说明合并到正文末尾；这些说明不是原文件内容。
							if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
							// 把具体 resolve/reject 动作延迟交给单次收尾入口，避免 error/close 等并发事件重复决定结果。
							settle(() =>
								// 工具结果通过 Promise 成功值返回，上层随后包装成对应 toolCallId 的 toolResult 消息。
								resolve({
									// 模型看到的是已裁剪条目列表及必要提示。
									content: [{ type: "text", text: output }],
									// 三元表达式：确有详情字段才返回对象，否则显式 undefined。
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
						// 准备或格式化的外围异常经同一个单次出口拒绝，避免误判成空匹配。
					} catch (err) {
						// 外围执行异常仍经单次出口传播；as 只作类型断言，不会把任意值真正构造成 Error。
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		// 附上终端工具行与搜索结果展示函数，不改变正文搜索逻辑。
		...grepRenderers,
	};
}

/** 返回独立低层 Agent 可用的 grep 工具；创建时不启动 rg，执行时才搜索。 */
export function createGrepTool(cwd: string, options?: GrepToolOptions): TypeBoxAgentTool<typeof grepSchema> {
	// 创建完整定义再适配低层工具，返回时没有搜索副作用。
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
