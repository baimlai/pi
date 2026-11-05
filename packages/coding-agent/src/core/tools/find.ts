// 按 glob 找文件路径，默认启动 fd 并遵守忽略规则，也可注入远程 glob；与 grep 不同，它不搜索文件正文。
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
// 共享工具路径层既处理相对目录/~ 等输入，也提供异步存在性探测。
import { pathExists, resolveToCwd } from "./path-utils.ts";
// 工具调用行和结果如何展示由 find 专属 renderer 负责，不参与实际搜索。
import { findRenderers } from "./renderers/find.ts";
// 完整定义通过 wrapper 转为低层工具，TypeBoxAgentTool 在 TS 中保留模型参数推导。
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";
// 公共输出字节预算和开头裁剪算法，最终列表过大时限量展示。
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

/** Relativize a find result against the search root and normalize it to posix separators. */
/**
 * 把后端给出的绝对/相对路径转为相对搜索根的显示路径，分隔符统一为 /，保留目录尾部斜杠。
 * 例：/project/src/a.ts 相对 /project 得到 src/a.ts；pathModule 参数让测试可显式采用 Windows 规则，纯转换无 I/O。
 */
export function relativizeFindResultPath(
	// 搜索后端返回的一条路径，允许绝对或相对搜索根。
	resultPath: string,
	// 此次搜索根，用于把绝对结果转为稳定相对路径。
	searchPath: string,
	// 默认使用当前平台路径规则；测试可注入 path.win32 或 path.posix 来验证另一平台。
	pathModule: path.PlatformPath = path,
	// 该路径变换函数同步返回展示字符串，不访问磁盘或启动进程。
): string {
	// 记录原始后端路径是否指向以分隔符结尾的目录，转换后需保留这一显示信息。
	const hadTrailingSeparator =
		// 同时兼容 Windows 后端可能输出 / 或 \ 的目录标记。
		resultPath.endsWith(pathModule.sep) || (pathModule.sep === "\\" && resultPath.endsWith("/"));
	// 只有绝对路径需要计算相对搜索根路径，后端已返回相对路径时保持不变。
	const relativePath = pathModule.isAbsolute(resultPath) ? pathModule.relative(searchPath, resultPath) : resultPath;
	// 按平台分隔符拆开再用 / 拼回，模型输出跨平台更一致。
	const posixPath = relativePath.split(pathModule.sep).join("/");
	// 相对化可能丢掉尾斜杠，仅在原来确有目录标记时补回。
	return hadTrailingSeparator && !posixPath.endsWith("/") ? `${posixPath}/` : posixPath;
}

// 模型参数的运行时 schema，TypeScript 类型稍后从它推导。
const findSchema = Type.Object({
	// 必需的文件路径 glob 模式；不是要在文件正文里找的正则表达式。
	pattern: Type.String({
		// 给模型举例说明 glob：星号匹配文件名，双星号形式可跨目录；这是运行时提示文字，原样保留。
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	// 可选搜索目录，省略时 execute 使用会话工作目录；不是结果路径字段。
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	// 可选结果数量上限，默认 1000；整体字节上限仍可能更早触发。
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

// 供系统提示词列出 find 的能力，实际默认工具是否启用由会话配置决定。
export const findToolSystemPromptContribution = {
	// 提供给 system 提示词的用途摘要：查文件路径，按默认后端规则尊重忽略文件。
	snippet: "Find files by glob pattern (respects .gitignore)",
	// 这份工具没有额外逐项使用建议，但仍保留与其他工具相同的元数据形状。
	guidelines: [],
	// 保留提示词字面量和只读数组类型，运行时仍是普通对象。
} as const;

// schema 推导出的 path/pattern/limit 类型；不单独复制一份接口。
export type FindToolInput = Static<typeof findSchema>;

// 默认最多返回 1000 个文件路径，和默认 50KB 字节预算并行起作用。
const DEFAULT_LIMIT = 1000;

// 数量或字节限制的结构化说明。
export interface FindToolDetails {
	// 可选的字节裁剪细节。
	truncation?: TruncationResult;
	// 触及的结果数量上限，例如 1000。
	resultLimitReached?: number;
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
// 宿主可注入不同文件系统/搜索系统的 exists 与 glob。
export interface FindOperations {
	/** Check if path exists */
	// 允许同步或异步存在性实现，执行器统一 await。
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Find files matching glob pattern. Returns relative or absolute paths. */
	// 返回路径数组，可同步/异步；调用方负责按忽略规则与 limit 执行。
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

// 默认 exists 真查本地；glob 只是占位，默认实际搜索位于 execute 的 fd 分支。
const defaultFindOperations: FindOperations = {
	// 复用异步存在性探测。
	exists: pathExists,
	// This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
	// 不是默认搜索逻辑，不能据这里空数组误以为 find 永远没结果。
	glob: () => [],
};

// 宿主创建工具时的后端配置。
export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem plus fd */
	// 注入后可走远程/自定义 glob；未注入才启动 fd。
	operations?: FindOperations;
}

/**
 * 构造 find 的 schema、执行器与 UI 渲染器，工厂不会启动 fd。
 * 执行流程：解析根路径 → 自定义 glob 或默认 fd → 收集路径 → 相对化 → 数量/字节限制 → 结果；错误/取消拒绝 Promise。
 * 例如 pattern:"*.ts" 按文件名查找 TypeScript 文件，不读取文件里的代码内容。
 */
export function createFindToolDefinition(
	// 默认搜索根目录，执行时 ctx.cwd 可覆盖。
	cwd: string,
	// 可选后端配置，不属于模型参数。
	options?: FindToolOptions,
	// 返回输入 schema 为 findSchema、详情可为空的工具定义；这些泛型描述开发时接口。
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	// 保存宿主注入的后端对象，执行阶段再选择具体操作。
	const customOps = options?.operations;
	// 返回 find 定义，包含模型说明与执行回调；此时不遍历文件系统。
	return {
		// Agent 按 find 查找这份可执行工具。
		name: "find",
		// UI 展示名。
		label: "find",
		// 模型说明包含相对路径格式、忽略规则和双重上限；模板插入的预算与实际执行默认值共用。
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		// 向提示词组装器提供简短能力描述。
		promptSnippet: findToolSystemPromptContribution.snippet,
		// 声明并校验模型调用参数。
		parameters: findSchema,
		/**
		 * 执行一次路径搜索，接收 pattern/path/limit，返回路径列表工具结果，不修改文件。
		 * 默认会启动 fd，工具管理器可能补齐缺失可执行文件；自定义 glob 后端会替代此进程路径。
		 */
		async execute(
			// 统一调用 id 参数，本实现没有使用它；前导下划线表明有意未使用。
			_toolCallId,
			// 从参数对象解构，并把 path 改名 searchDir，避免与导入的 path 模块重名。
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
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
					// Promise 已因预先取消而拒绝，立即停止设置后续监听或搜索后端。
					return;
				}

				// 一个子进程可能触发 error/close 等多个出口，用标志保证只决定一次最终结果。
				let settled = false;
				// 子进程尚未创建时没有停止函数，用联合类型表达这两个状态。
				let stopChild: (() => void) | undefined;
				/**
				 * 统一完成 Promise 并释放取消监听，一次执行的所有出口共用它。
				 * 例如 error 之后仍收到 close，不应重复触发结果处理；settled 标志在调用 fn 前就置位。
				 */
				// 局部收尾函数，参数是这次真正 resolve/reject 的动作；先控制生命周期再执行动作。
				const settle = (fn: () => void) => {
					// 已经收尾就忽略后来的事件，避免重复通知。
					if (settled) return;
					// 先标记已完成，避免清理过程中产生额外事件再次进入。
					settled = true;
					// 不再需要取消回调，移除监听避免保留闭包和结束后继续触发。
					signal?.removeEventListener("abort", onAbort);
					// 结果已完成，清掉子进程停止闭包引用。
					stopChild = undefined;
					// 调用传进来的结束动作；传函数与立即执行函数是不同步骤。
					fn();
				};
				/** 取消时停止默认子进程（若已启动），再经单次出口拒绝；自定义 glob 不接收此信号，只忽略其晚到结果。 */
				const onAbort = () => {
					// 如果默认 fd 已启动则请求停止；没启动或走自定义 glob 时可跳过。
					stopChild?.();
					// 通过单次收尾函数报告取消，避免与晚到的子进程 close 重复完成。
					settle(() => reject(new Error("Operation aborted")));
				};
				// 如果存在信号，监听一次取消；once:true 自动限制此监听触发次数。
				signal?.addEventListener("abort", onAbort, { once: true });

				// 立即执行异步函数，以便在 Promise 的同步构造回调里使用 await。
				(async () => {
					// 异步准备/搜索过程统一捕获，避免被立即执行的 async 回调产生未处理拒绝。
					try {
						// 未给搜索目录则用当前会话目录；resolveToCwd 处理相对路径与 ~ 等输入形式。
						const searchPath = resolveToCwd(searchDir || ".", ctx?.cwd || cwd);
						// 没传 limit 用工具默认值；?? 不会把显式 0 当作缺省。
						const effectiveLimit = limit ?? DEFAULT_LIMIT;
						// find 可整体替换存在性/glob 后端，未注入才用默认本地实现。
						const ops = customOps ?? defaultFindOperations;

						// If custom operations provide glob(), use that instead of fd.
						// find 的自定义 glob 分支确实跳过默认 fd 进程，适合远程文件系统搜索。
						if (customOps?.glob) {
							// 先等待存在性检查；! 把结果取反，路径不在就明确报错。
							if (!(await ops.exists(searchPath))) {
								// 错误包含解析后的搜索根路径，便于模型修正。
								settle(() => reject(new Error(`Path not found: ${searchPath}`)));
								// 根路径无效已报告错误，不继续调用自定义 glob。
								return;
							}
							// 执行前/异步阶段后观察取消；已取消时不应继续报告正常搜索结果。
							if (signal?.aborted) {
								// 通过单次收尾函数报告取消，避免与晚到的子进程 close 重复完成。
								settle(() => reject(new Error("Operation aborted")));
								// 等待存在性期间已取消，停止自定义搜索。
								return;
							}
							// 调用注入的 glob 后端，传查询模式、根路径与忽略/上限要求；返回值可同步或异步，await 都能处理。
							const results = await ops.glob(pattern, searchPath, {
								// 明确要求自定义 glob 排除依赖与 Git 内部目录，实际执行这些规则由注入后端负责。
								ignore: ["**/node_modules/**", "**/.git/**"],
								// 把实际结果数量上限交给 glob 后端。
								limit: effectiveLimit,
							});
							// 执行前/异步阶段后观察取消；已取消时不应继续报告正常搜索结果。
							if (signal?.aborted) {
								// 通过单次收尾函数报告取消，避免与晚到的子进程 close 重复完成。
								settle(() => reject(new Error("Operation aborted")));
								// 自定义 glob 返回期间发生取消，不把晚到结果报告为成功。
								return;
							}
							// 没有可显示条目时给空目录提示；这也包括条目全部 stat 失败的情况。
							if (results.length === 0) {
								// 把具体 resolve/reject 动作延迟交给单次收尾入口，避免 error/close 等并发事件重复决定结果。
								settle(() =>
									// 工具结果通过 Promise 成功值返回，上层随后包装成对应 toolCallId 的 toolResult 消息。
									resolve({
										// 给模型明确的“没有匹配文件”文字。
										content: [{ type: "text", text: "No files found matching pattern" }],
										// 没有截断等额外详情时省略业务详情值。
										details: undefined,
									}),
								);
								// 已返回正常无匹配结果，结束自定义后端分支。
								return;
							}

							// Relativize paths against the search root for stable output.
							// 统一相对搜索根的路径和 / 分隔符，使不同后端输出稳定。
							const relativized = results.map((p) => relativizeFindResultPath(p, searchPath));
							// 命中数达到上限就提示可能还有更多；不证明搜索空间中一定存在额外结果。
							const resultLimitReached = relativized.length >= effectiveLimit;
							// 每个文件路径一行，拼成最终待裁剪文字。
							const rawOutput = relativized.join("\n");
							// 数量上限已经控制结果条数，这里放宽行数、仍保留共同字节上限。
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							// 以裁剪后的正文为基础，再追加可行动的上限提示。
							let resultOutput = truncation.content;
							// 先用空对象收集可选详情；没有任何字段时最终返回 undefined。
							const details: FindToolDetails = {};
							// 收集多条限制说明，最后统一用句点拼接，不把用户输出逐行重复。
							const notices: string[] = [];
							// 达到文件结果数上限时，标明当前 limit 并建议缩小范围或提高上限。
							if (resultLimitReached) {
								// 追加数量限制提示文字，不改变原始搜索结果数组。
								notices.push(`${effectiveLimit} results limit reached`);
								// 给界面记录触及的数量阈值。
								details.resultLimitReached = effectiveLimit;
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
								// 用单独方括号说明段连接多条提示。
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							// 把具体 resolve/reject 动作延迟交给单次收尾入口，避免 error/close 等并发事件重复决定结果。
							settle(() =>
								// 工具结果通过 Promise 成功值返回，上层随后包装成对应 toolCallId 的 toolResult 消息。
								resolve({
									// 模型收到路径列表及可选限制提示，不包含本地函数对象。
									content: [{ type: "text", text: resultOutput }],
									// 三元表达式：确有详情字段才返回对象，否则显式 undefined。
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
							// 自定义 glob 的列表/限制提示已经完成，不再落入默认 fd 分支重复搜索。
							return;
						}

						// Default implementation uses fd.
						// 取得 fd 可执行文件路径，工具管理器可能查本地或按其策略下载；工厂构造时尚不会执行这一步。
						const fdPath = await ensureTool("fd");
						// 执行前/异步阶段后观察取消；已取消时不应继续报告正常搜索结果。
						if (signal?.aborted) {
							// 通过单次收尾函数报告取消，避免与晚到的子进程 close 重复完成。
							settle(() => reject(new Error("Operation aborted")));
							// 取得 fd 期间已取消，停止启动进程。
							return;
						}
						// 默认搜索后端无法取得时，不能继续 spawn 一个不存在的程序。
						if (!fdPath) {
							// 把 fd 不可用作为执行失败，区别于正常无匹配结果。
							settle(() => reject(new Error("fd is not available and could not be downloaded")));
							// 后端不可用已报告错误，不再尝试 spawn。
							return;
						}

						// 使用 fd 的 glob 模式、禁用颜色并包含隐藏文件；忽略规则仍按 fd/Git 语义处理。
						const args: string[] = ["--glob", "--color=never", "--hidden"];

						// fd normally ignores .gitignore outside git repos, so keep --no-require-git
						// there. Inside repos, use fd's default git-aware behavior so parent
						// .gitignore rules stop at nested repo boundaries:
						// https://github.com/earendil-works/pi/issues/5960
						// 准备判断搜索根是否在 Git 仓库内，影响 fd 是否需 --no-require-git。
						let insideGitRepo = false;
						// 从搜索根逐级向父目录查找 .git，第二个 for 条件为空表示靠 break 结束。
						for (let current = searchPath; ; ) {
							// 存在 .git 文件或目录都可标记处在仓库内，兼容常见 worktree 的 .git 文件。
							if (await pathExists(path.join(current, ".git"))) {
								// 记住已找到仓库边界，后面采用 fd 原生 Git-aware 忽略规则。
								insideGitRepo = true;
								// 找到最近 Git 仓库后停止向父目录查找，保留 fd 的仓库边界语义。
								break;
							}
							// 计算父目录，向文件系统根部推进。
							const parent = path.dirname(current);
							// 文件系统根的父路径等于自身，到此停止，避免无限循环。
							if (parent === current) break;
							// 继续查上一层路径。
							current = parent;
						}
						// 仓库外也要遵守 .gitignore 时加此参数；仓库内保留默认边界语义，避免跨嵌套仓库错误继承忽略规则。
						if (!insideGitRepo) args.push("--no-require-git");
						// 把结果数量上限转为命令行字符串参数，不通过 shell 拼接命令。
						args.push("--max-results", String(effectiveLimit));

						// fd --glob matches against the basename unless --full-path is set; in --full-path
						// mode it matches against the absolute candidate path, so a path-containing
						// pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
						// 保留原 glob 模式，必要时为完整路径匹配补前缀。
						let effectivePattern = pattern;
						// 模式包含路径段时不能仅匹配 basename，必须使用 full-path 模式。
						if (pattern.includes("/")) {
							// 要求 fd 按完整候选路径匹配。
							args.push("--full-path");
							// 相对路径模式且没有已有通配前缀时才加 **/，不重复改写绝对/通配模式。
							if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
								// 完整绝对候选路径前还有搜索根目录，用 **/ 兼容这些前缀。
								effectivePattern = `**/${pattern}`;
							}
							// fd matches full paths using native separators on Windows.
							// Windows 原生路径分隔符可能是反斜杠，需要匹配两种分隔形式。
							if (process.platform === "win32")
								// String.raw 保留模板中的反斜杠文本；把路径 / 转为可匹配 / 或反斜杠的 glob 字符组以兼容 Windows。
								effectivePattern = effectivePattern.replaceAll("/", String.raw`[/\\]`);
						}
						// -- 结束 fd 选项解析，避免以 - 开头的模式被当成选项；模式与路径分别传参。
						args.push("--", effectivePattern, searchPath);

						// 真正启动 fd 子进程，不经 shell；忽略 stdin，读取 stdout/stderr 管道。
						const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						// readline 把 stdout 流拆成逐行事件，避免自己处理跨 chunk 的换行。
						const rl = createInterface({ input: child.stdout });
						// 累计诊断输出，进程失败时作为错误说明。
						let stderr = "";
						// 存文件路径行，进程结束后做统一输出格式化。
						const lines: string[] = [];

						// 子进程创建后保存停止回调，供外层 abort 处理复用。
						stopChild = () => {
							// 尚未请求 kill 时才发送停止请求；killed 表示已发信号，不等于已完成进程回收。
							if (!child.killed) {
								// 请求结束搜索进程，真正结束结果仍由 error/close 等后续事件收尾。
								child.kill();
							}
						};

						/** 关闭 fd 的逐行读取器，避免 close/error 后继续收集路径行；不负责返回最终结果。 */
						// 清理搜索读取资源的局部回调。
						const cleanup = () => {
							// 停止 readline 继续发 line 事件，不等于自动杀掉子进程。
							rl.close();
						};

						// 有 stderr 管道时接收诊断字节；?. 避免管道不存在时访问失败。
						child.stderr?.on("data", (chunk) => {
							// 把诊断字节解码追加，便于最后组合错误。
							stderr += chunk.toString();
						});

						// 每行路径到达时保存，不逐行发布新工具结果。
						rl.on("line", (line) => {
							// 追加原始路径行，稍后统一去 CR/空白并相对化。
							lines.push(line);
						});

						// 捕获无法 spawn 等进程错误，区别于 fd 正常运行后的非零退出码。
						child.on("error", (error) => {
							// 移除/关闭读取资源；具体取消监听也由各工具自己的收尾函数负责。
							cleanup();
							// 向模型提供可读的启动失败原因。
							settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
						});

						// 进程结束且管道关闭后再决定最终结果，可以观察完整已收集路径和 stderr。
						child.on("close", (code) => {
							// 移除/关闭读取资源；具体取消监听也由各工具自己的收尾函数负责。
							cleanup();
							// 执行前/异步阶段后观察取消；已取消时不应继续报告正常搜索结果。
							if (signal?.aborted) {
								// 通过单次收尾函数报告取消，避免与晚到的子进程 close 重复完成。
								settle(() => reject(new Error("Operation aborted")));
								// 进程结束前用户已取消，拒绝结果后不再格式化剩余路径。
								return;
							}
							// 此处先用原始行判断是否有部分结果；后面仍会正规化路径。
							const output = lines.join("\n");
							// 搜索程序非零退出时查看诊断；已有部分输出时原实现仍允许返回它。
							if (code !== 0) {
								// 优先采用 stderr，空时用退出码兜底，|| 会对空字符串采用右值。
								const errorMsg = stderr.trim() || `fd exited with code ${code}`;
								// 没有任何输出时，错误码会被报告为失败；正常成功无结果则走无文件提示。
								if (!output) {
									// 通过统一出口拒绝，保证不会重复完成 Promise。
									settle(() => reject(new Error(errorMsg)));
									// 程序失败且没有部分输出，已报告诊断，不当作正常空匹配。
									return;
								}
							}
							// 没有任何输出时，错误码会被报告为失败；正常成功无结果则走无文件提示。
							if (!output) {
								// 把具体 resolve/reject 动作延迟交给单次收尾入口，避免 error/close 等并发事件重复决定结果。
								settle(() =>
									// 工具结果通过 Promise 成功值返回，上层随后包装成对应 toolCallId 的 toolResult 消息。
									resolve({
										// 给模型明确的“没有匹配文件”文字。
										content: [{ type: "text", text: "No files found matching pattern" }],
										// 没有截断等额外详情时省略业务详情值。
										details: undefined,
									}),
								);
								// 正常搜索无文件，已返回成功提示，结束 close 回调。
								return;
							}

							// 准备只含已清理相对路径的新结果数组。
							const relativized: string[] = [];
							// 依次处理 fd 的路径行，保持后端返回顺序。
							for (const rawLine of lines) {
								// 去除 CRLF 留下的 CR 及两端空白，再判断是否为空。
								const line = rawLine.replace(/\r$/, "").trim();
								// 空路径行不放进输出；continue 只跳过本轮循环。
								if (!line) continue;
								// 统一相对搜索目录的路径及分隔符，保留目录尾斜杠。
								relativized.push(relativizeFindResultPath(line, searchPath));
							}

							// 命中数达到上限就提示可能还有更多；不证明搜索空间中一定存在额外结果。
							const resultLimitReached = relativized.length >= effectiveLimit;
							// 每个文件路径一行，拼成最终待裁剪文字。
							const rawOutput = relativized.join("\n");
							// 数量上限已经控制结果条数，这里放宽行数、仍保留共同字节上限。
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							// 以裁剪后的正文为基础，再追加可行动的上限提示。
							let resultOutput = truncation.content;
							// 先用空对象收集可选详情；没有任何字段时最终返回 undefined。
							const details: FindToolDetails = {};
							// 收集多条限制说明，最后统一用句点拼接，不把用户输出逐行重复。
							const notices: string[] = [];
							// 达到文件结果数上限时，标明当前 limit 并建议缩小范围或提高上限。
							if (resultLimitReached) {
								// 给最终文字追加一项可行动的限制说明；完整结果仍取前面已收集的条目/命中。
								notices.push(
									// 说明达到结果数量上限，并给出提高 limit 或缩小 pattern 的方向；不会自动再次搜索。
									`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								// 给界面记录触及的数量阈值。
								details.resultLimitReached = effectiveLimit;
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
								// 用单独方括号说明段连接多条提示。
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							// 把具体 resolve/reject 动作延迟交给单次收尾入口，避免 error/close 等并发事件重复决定结果。
							settle(() =>
								// 工具结果通过 Promise 成功值返回，上层随后包装成对应 toolCallId 的 toolResult 消息。
								resolve({
									// 模型收到路径列表及可选限制提示，不包含本地函数对象。
									content: [{ type: "text", text: resultOutput }],
									// 三元表达式：确有详情字段才返回对象，否则显式 undefined。
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
						// 捕获工具管理器、路径检查或搜索后端准备失败；先优先处理取消，再传播正常错误。
					} catch (e) {
						// 执行前/异步阶段后观察取消；已取消时不应继续报告正常搜索结果。
						if (signal?.aborted) {
							// 通过单次收尾函数报告取消，避免与晚到的子进程 close 重复完成。
							settle(() => reject(new Error("Operation aborted")));
							// 取消错误已经结算，不再同时传播另一个后端异常。
							return;
						}
						// 外部后端可能抛任意值，在错误边界规范为 Error。
						const error = e instanceof Error ? e : new Error(String(e));
						// 将规范化错误交上层 Agent，不把失败伪装成无结果。
						settle(() => reject(error));
					}
				})();
			});
		},
		// 附加终端调用/结果显示；默认执行搜索与 UI 渲染相互独立。
		...findRenderers,
	};
}

/** 给独立 Agent 创建 find 的适配工具，无搜索副作用；以后 execute 才启动后端。 */
export function createFindTool(cwd: string, options?: FindToolOptions): TypeBoxAgentTool<typeof findSchema> {
	// 先建定义再适配 AgentTool，工厂调用本身不搜索磁盘。
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
