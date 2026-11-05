// 给编辑器提供命令名、命令参数、普通路径及@附件候选；Editor负责触发、取消请求、丢弃过期结果和应用新文字，这里不显示菜单。
// 普通路径同步列目录，@通过本地fd子进程递归查名字；不读候选文件正文、不调用模型。查询结果与行列下标均使用原字符串UTF-16位置。
// spawn直接启动可执行文件并传参数数组，默认不经过shell；本文件会真正运行本地fd，不只是格式化字符串。
import { spawn } from "child_process";
// 同步列目录及查元数据；会阻塞当前线程，失败在路径候选分支中转为空列表。
import { readdirSync, statSync } from "fs";
// 读取当前用户主目录，供~和~/展开，不支持任意~用户名语法。
import { homedir } from "os";
// 复用平台路径函数取目录/文件名及拼接；显示时再统一为正斜杠。
import { basename, dirname, join } from "path";
// 命令名使用共享子序列模糊筛选，分数越低越优；@文件候选另用本文件的较高分更优规则。
import { fuzzyFilter } from "./fuzzy.ts";
// 共享空白/CJK标点边界，允许“查看，@文件”等写法，不把普通汉字当分隔符。
import { autocompleteBoundaryRegex, autocompleteSeparatorRegex } from "./utils.ts";

// Set存精确分隔字符，包含引号/等号等，has判断成员；const禁止重绑变量，不冻结集合内容。
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
// 把共享边界锚到当前前缀末尾，用于判断路径/附件是否处于一个新token起点；source取正则正文。
const tokenStartRegex = new RegExp(`${autocompleteBoundaryRegex.source}$`, "u");
// Opening wrappers that may precede a path in prose, mapped to their closing counterpart.
// Record<string,string>是编译期字符串映射；记录可能包住正文路径的开符号及对应闭符号，不是完整括号语法解析器。
const PATH_WRAPPERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", "`": "`" };

// 把路径展示中的反斜杠统一成正斜杠，返回新串无文件系统修改；例：src反斜杠a显示为src/a。
function toDisplayPath(value: string): string {
	// 全局替换每个反斜杠，不解析磁盘根、UNC或转义含义。
	return value.replace(/\\/g, "/");
}

// 转义正则元字符，返回适合字面匹配的模式正文，无副作用；例：[id]中的方括号不再表示字符组。
function escapeRegex(value: string): string {
	// $&在替换串中表示被匹配原文，前面补反斜杠，让fd搜索按这些字符本身匹配。
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 将路径查询转成fd的正则模式，逐段转义并兼容两种分隔符，返回字符串不运行进程；例：src/[id]会保留目录结构且按字面匹配方括号。
function buildFdPathQuery(query: string): string {
	// 先统一用户写法中的分隔符。
	const normalized = toDisplayPath(query);
	// 没有分隔符时只是单个文件名/子串查询。
	if (!normalized.includes("/")) {
		// 转义后直接返回，正则不会执行查询里的元字符。
		return escapeRegex(normalized);
	}

	// 记录用户是否显式写了目录末尾斜杠，稍后补回模式。
	const hasTrailingSeparator = normalized.endsWith("/");
	// 移除开头/结尾连续斜杠，为非空目录段构造匹配模式。
	const trimmed = normalized.replace(/^\/+|\/+$/g, "");
	// 全是斜杠时没有可转义的目录名。
	if (!trimmed) {
		// 保留原正规化斜杠串，不构造空段匹配。
		return normalized;
	}

	// 字符串转义后形成匹配反斜杠或正斜杠的正则字符组，供fd跨平台路径匹配。
	const separatorPattern = "[\\\\/]";
	// 开始把路径拆成目录名/文件名段的链式转换。
	const segments = trimmed
		// 先按统一后的正斜杠拆开。
		.split("/")
		// 丢弃重复斜杠造成的空段，Boolean作为过滤回调。
		.filter(Boolean)
		// 每段分别转义，避免把目录名里的括号等当正则结构。
		.map((segment) => escapeRegex(segment));

	// 用允许两种路径分隔符的模式连接各段。
	let pattern = segments.join(separatorPattern);
	// 用户末尾写了斜杠时，要求匹配结果中也继续出现路径分隔。
	if (hasTrailingSeparator) {
		// 追加一次分隔符模式，不附加任意通配后缀。
		pattern += separatorPattern;
	}
	// 返回最终fd查询参数，是否按全路径匹配由调用方另设开关。
	return pattern;
}

// 找正文中最后一个路径分隔边界，返回UTF-16下标或-1，不改输入；例：“see src/a”返回see后的空格位置。
function findLastDelimiter(text: string): number {
	// -1表示尚未发现分隔符，调用者据此保留整个token。
	let lastDelimiter = -1;
	// 跟踪码元位置，不能把for...of的码点次数直接当slice下标。
	let index = 0;
	// for...of遍历Unicode码点字符串，辅助平面字符可占2码元。
	for (const character of text) {
		// 按本码点字符串长度推进，保留原UTF-16坐标。
		index += character.length;
		// 精确分隔字符或共享空白/CJK标点都算边界。
		if (PATH_DELIMITERS.has(character) || autocompleteSeparatorRegex.test(character)) {
			// 记录本次分隔符末码元位置；当前分隔集合/标点通常为单码元。
			lastDelimiter = index - 1;
		}
	}
	// 返回最后一次命中，下游从它之后开始取前缀。
	return lastDelimiter;
}

// Strip opening wrappers before a path, e.g. "(~/Dev" -> "~/Dev" or "`src/ma" -> "src/ma".
// Keep a wrapper if the token also contains its closer, e.g. "app/[slug]/pa" or "(group)/pa".
// 剥掉路径前尚未在token里闭合的开包装符，返回新串，无副作用；例：“(src/a”去掉(，“[slug]/a”保留完整目录名。
function stripLeadingWrappers(token: string): string {
	// 从原token开始逐次缩短，原字符串不变。
	let result = token;
	// 还有字符时检查最左端是否像包装符。
	while (result.length > 0) {
		// 查首字符对应闭符号；!是TypeScript非空断言，不做运行时校验。
		const closer = PATH_WRAPPERS[result[0]!];
		// 不是包装符，或后面任何位置已出现其闭符号，就不再剥；不做嵌套配对分析。
		if (!closer || result.includes(closer, 1)) {
			// 到应保留的正文部分停止。
			break;
		}
		// 只去掉一个ASCII包装字符，继续检查多重包装。
		result = result.slice(1);
	}
	// 返回保留后的路径token。
	return result;
}

// 定位尚未闭合的双引号起点，返回下标或null，无修改；例：“see \"my dir”返回引号位置，不支持shell式引号转义/单引号配对。
function findUnclosedQuoteStart(text: string): number | null {
	// 当前是否处于双引号内，初始不在。
	let inQuotes = false;
	// 最近一次从外进入引号时的位置。
	let quoteStart = -1;

	// 逐码元扫描整段光标前正文。
	for (let i = 0; i < text.length; i += 1) {
		// 只识别字面双引号，不检查它前面是否有反斜杠。
		if (text[i] === '"') {
			// 每遇一个引号就切换进入/退出状态。
			inQuotes = !inQuotes;
			// 刚进入时记录新的开启位置。
			if (inQuotes) {
				// 保存这个引号的原字符串下标。
				quoteStart = i;
			}
		}
	}

	// 最终仍在引号内才返回其起点，偶数个引号配完则null。
	return inQuotes ? quoteStart : null;
}

// 判断给定下标是否可作为新路径token起点，无副作用；先越过前置包装符，再检查正文边界，例：空格后(包着的路径可成立。
function isTokenStart(text: string, index: number): boolean {
	// 用局部位置向左看，不改调用方下标。
	let start = index;
	// 只要前一字符是已知包装开符号就继续向左。
	while (start > 0 && PATH_WRAPPERS[text[start - 1]!]) {
		// 越过一层包装符。
		start -= 1;
	}
	// 前一字符是精确分隔符，或其前全文满足末尾边界则成立；??让越过开头后的undefined按空串处理。
	return PATH_DELIMITERS.has(text[start - 1] ?? "") || tokenStartRegex.test(text.slice(0, start));
}

// 提取一个未闭合双引号路径前缀，含可选@，返回原文片段或null，无副作用；例：空格后@双引号my dir保留完整含空格前缀。
function extractQuotedPrefix(text: string): string | null {
	// 先找当前仍未闭合的双引号。
	const quoteStart = findUnclosedQuoteStart(text);
	// null不是下标0，显式判断避免丢掉开头引号。
	if (quoteStart === null) {
		// 没有打开引号就没有引用前缀。
		return null;
	}

	// 引号前若紧挨@，把@作为附件前缀的一部分考虑。
	if (quoteStart > 0 && text[quoteStart - 1] === "@") {
		// @自身仍需位于合法token起点，不能把邮箱内的@误当附件。
		if (!isTokenStart(text, quoteStart - 1)) {
			// 不在边界就忽略这个引用写法。
			return null;
		}
		// 返回从@到光标前的原文，不去掉开启引号。
		return text.slice(quoteStart - 1);
	}

	// 无@时，引号本身也必须是合法token起点。
	if (!isTokenStart(text, quoteStart)) {
		// 嵌在普通词里的引号不是这里的路径前缀。
		return null;
	}

	// 返回带开启双引号的路径原文。
	return text.slice(quoteStart);
}

// 拆路径前缀标记，返回纯路径文本及@/引用两个布尔位，不查磁盘；例：@加双引号目录得到两个true，rawPrefix只剩目录文字。
function parsePathPrefix(prefix: string): { rawPrefix: string; isAtPrefix: boolean; isQuotedPrefix: boolean } {
	// 先匹配同时带@和双引号的形式，避免被后面的单独@分支抢先。
	if (prefix.startsWith('@"')) {
		// 移除两个开头字符，引用是否已闭合由调用上下文决定，不在这里删结尾引号。
		return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
	}
	// 仅双引号前缀是普通引用路径。
	if (prefix.startsWith('"')) {
		// 只去掉一个开启引号，保留原路径内容。
		return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
	}
	// 单独@表示未引用的附件路径。
	if (prefix.startsWith("@")) {
		// 去掉@供文件系统查询，输出候选时再补回。
		return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
	}
	// 普通路径两个标记都是false，原文本直接作为rawPrefix。
	return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

// 把显示路径包成候选value，按@/原引用状态/分隔字符决定加双引号，返回字符串无I/O；例：my folder/会包引号以供继续补全。
// 只包围路径，不转义内部引号或shell特殊字符，不可当通用shell转义；isDirectory在本函数未被读取，目录斜杠由上层先加。
function buildCompletionValue(
	// 已经处理好目录末斜杠的显示路径。
	path: string,
	// 三个布尔字段是编译期契约，实际仅读取isAtPrefix/isQuotedPrefix。
	options: { isDirectory: boolean; isAtPrefix: boolean; isQuotedPrefix: boolean },
	// 返回可写回编辑内容的完整value，不是菜单label。
): string {
	// 原本在引号内，或含空白/CJK标点，都需要继续使用双引号。
	const needsQuotes = options.isQuotedPrefix || autocompleteSeparatorRegex.test(path);
	// 附件候选前加@，普通路径前缀为空。
	const prefix = options.isAtPrefix ? "@" : "";

	// 无需引用的路径直接拼接。
	if (!needsQuotes) {
		// 模板只生成文本，不启动shell或读取该路径。
		return `${prefix}${path}`;
	}

	// 开启引号前可有@。
	const openQuote = `${prefix}"`;
	// 闭合引号固定为一个双引号。
	const closeQuote = '"';
	// 按开启标记、路径、闭引号拼成候选值，光标稍后可放到目录闭引号内侧。
	return `${openQuote}${path}${closeQuote}`;
}

// Use fd to walk directory tree (fast, respects .gitignore)
// 用本地fd查目录树，返回路径/目录标志数组；传基目录、fd路径、查询、结果预算、AbortSignal和可选深度，会真实spawn子进程。
// 例：@src/a可在限定基目录中查名字；已取消/启动错误/非零退出得[]，取消尝试SIGKILL但等error/close才完成，无独立总超时。
async function walkDirectoryWithFd(
	// fd扫描的基目录，不是强制不能离开的安全沙箱，跟随符号链接可能看到外部目录。
	baseDir: string,
	// 调用方提供的fd可执行路径，模块本身不下载或安装它。
	fdPath: string,
	// 待转义的文件名/路径查询。
	query: string,
	// 请求fd最多返回多少项；是进程参数，不在JS额外裁定返回行数。
	maxResults: number,
	// 供取消时杀子进程/丢弃结果，普通同步路径补全不经过本函数。
	signal: AbortSignal,
	// ?允许省略深度，省略时不增加--max-depth。
	maxDepth?: number,
	// Promise中的数组元素是普通对象；类型不验证fd输出是否真实存在或文件类型。
): Promise<Array<{ path: string; isDirectory: boolean }>> {
	// 构造参数数组，spawn不会把它拼成shell脚本。
	const args = [
		// 指定fd扫描根目录的开关。
		"--base-directory",
		// 把基目录作为独立参数传入。
		baseDir,
		// 限制本轮查询结果量的开关。
		"--max-results",
		// 数值转命令行字符串。
		String(maxResults),
		// 第一次--type选择文件。
		"--type",
		// f是fd文件类型参数。
		"f",
		// 再次--type增加另一个允许类别。
		"--type",
		// d表示目录，文件与目录都可补全。
		"d",
		// 允许跟随符号链接目录，候选不保证物理上位于baseDir内。
		"--follow",
		// 包括隐藏文件/目录，fd默认的忽略规则仍由fd负责。
		"--hidden",
		// 开始第一条.git排除模式。
		"--exclude",
		// 排除.git名字，下面两条补充其中内容。
		".git",
		// 追加第二个排除开关。
		"--exclude",
		// 排除.git下一层模式；这是参数字符串，不是JS注释。
		".git/*",
		// 追加第三个排除开关。
		"--exclude",
		// 排除.git递归模式，保留原字面量交fd解释。
		".git/**",
	];

	// 只有明确给深度才加入该参数。
	if (maxDepth !== undefined) {
		// 把深度转字符串传fd，不在这里验证范围。
		args.push("--max-depth", String(maxDepth));
	}

	// 查询含任一风格分隔符时应按路径而非只按文件名匹配。
	if (toDisplayPath(query).includes("/")) {
		// 告诉fd在完整相对路径上匹配模式。
		args.push("--full-path");
	}

	// 空查询不增加模式参数，直接列候选。
	if (query) {
		// 非空查询先转义/规范分隔符再作为独立模式参数。
		args.push(buildFdPathQuery(query));
	}

	// 创建异步结果，executor同步开始进程配置，resolve在事件回调中完成；await不阻塞线程等子进程。
	return await new Promise((resolve) => {
		// 开始前已取消就不spawn。
		if (signal.aborted) {
			// 以空结果完成Promise，不以取消异常拒绝它。
			resolve([]);
			// 本executor直接结束。
			return;
		}

		// 实际启动子进程，默认shell=false；fd负责目录遍历/忽略规则。
		const child = spawn(fdPath, args, {
			// 忽略子进程stdin，stdout/stderr走管道；本实现只消费stdout，未读取stderr正文。
			stdio: ["ignore", "pipe", "pipe"],
		});
		// 累计fd完整stdout文本，没有本地字节上限或流式逐行处理。
		let stdout = "";
		// 标记是否已经完成，防止error和close重复resolve/收尾。
		let resolved = false;

		// 统一完成闭包，接收结果数组并只结算一次、移除abort监听；返回void，resolve不复制数组。
		const finish = (results: Array<{ path: string; isDirectory: boolean }>) => {
			// 重复事件触发不再重复清理。
			if (resolved) return;
			// 先标记已经完成。
			resolved = true;
			// 解除本查询安装的取消回调，避免任务完成后还杀进程。
			signal.removeEventListener("abort", onAbort);
			// 让等待者取得结果，后面的事件即使到来也不再改变Promise值。
			resolve(results);
		};

		// 取消回调无参数/返回值；仍没有退出码时尝试强杀，真正完成结果等close/error，不在这里直接resolve。
		const onAbort = () => {
			// exitCode为null表示还没有数值退出码，并非完整的“当前一定仍运行”证明。
			if (child.exitCode === null) {
				// 请求SIGKILL，返回的成功布尔未检查；不保证马上触发close。
				child.kill("SIGKILL");
			}
		};

		// 注册一次性abort监听，触发一次后自动移除；finish也主动移除未触发监听。
		signal.addEventListener("abort", onAbort, { once: true });
		// fd输出按UTF-8流解码为字符串。
		child.stdout.setEncoding("utf-8");
		// 每收到stdout一块数据就执行此回调，chunk类型由编码/约定保证。
		child.stdout.on("data", (chunk: string) => {
			// 拼入累计文本，不立即产生候选。
			stdout += chunk;
		});
		// 启动失败等子进程error事件回调，错误详情不向上暴露。
		child.on("error", () => {
			// 统一以[]完成，避免进程错误变成未处理的error事件。
			finish([]);
		});
		// 进程及其stdio关闭后处理最终输出，code可能不是数值退出码。
		child.on("close", (code) => {
			// 已取消、非成功退出或完全无输出，均无候选。
			if (signal.aborted || code !== 0 || !stdout) {
				// 统一完成空数组并解除监听。
				finish([]);
				// 不再解析失败输出。
				return;
			}

			// 去首尾空白后按换行分割，再去空行；没有使用NUL分隔，因此不承诺保留带换行文件名或输出首尾的空白字符。
			const lines = stdout.trim().split("\n").filter(Boolean);
			// 累积解析出的路径记录。
			const results: Array<{ path: string; isDirectory: boolean }> = [];

			// 逐行解释fd的列表输出，不读取文件正文。
			for (const line of lines) {
				// 显示分隔符统一成正斜杠。
				const displayLine = toDisplayPath(line);
				// 以末尾斜杠识别目录标志，未逐个stat核对。
				const hasTrailingSeparator = displayLine.endsWith("/");
				// 为.git过滤临时移掉目录末斜杠，结果正文仍保留它。
				const normalizedPath = hasTrailingSeparator ? displayLine.slice(0, -1) : displayLine;
				// 额外过滤根.git、根.git/内容及含/.git/片段，配合fd排除参数；不是通用路径授权校验。
				if (normalizedPath === ".git" || normalizedPath.startsWith(".git/") || normalizedPath.includes("/.git/")) {
					// 这些条目不进入候选。
					continue;
				}

				// 把该输出行转换为路径对象。
				results.push({
					// 保留显示路径及其可能的目录末斜杠。
					path: displayLine,
					// 保存从输出后缀推得的目录布尔值。
					isDirectory: hasTrailingSeparator,
				});
			}

			// 正常完成也走finish，清abort监听并返回结果。
			finish(results);
		});
	});
}

// 补全候选的公开形状，interface只做编译期检查；value用于替换正文，label用于菜单，不一定相同。
export interface AutocompleteItem {
	// 选中时写回的文本，附件可含@和引用符号。
	value: string;
	// 显示名称，目录候选约定末尾带/，applyCompletion也用它判断目录。
	label: string;
	// 可选说明，文件候选常放相对显示路径。
	description?: string;
}

// 泛型联合允许同步T或Promise<T>，await两者都能处理；不是自动创建后台线程。
type Awaitable<T> = T | Promise<T>;

// 斜杠命令描述，可由上层业务/扩展提供，不在这里实际执行命令。
export interface SlashCommand {
	// 命令名，补全时另加开头/。
	name: string;
	// 可选菜单说明。
	description?: string;
	// 可选参数用法提示，与说明拼在一起展示。
	argumentHint?: string;
	// Function to get argument completions for this command
	// Returns null if no argument completion is available
	// 可选参数补全回调，输入为斜杠命令后的原始参数前缀，返回候选数组/null或其Promise；例：/model son查sonnet，不接收本请求AbortSignal。
	getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;
}

// 一组候选及需要替换的原始前缀，返回给Editor显示/应用。
export interface AutocompleteSuggestions {
	// 候选按提供者排序后的列表，空列表通常由实现转成null。
	items: AutocompleteItem[];
	// 原始前缀包含应被替换的@/双引号/命令斜杠等，长度按UTF-16计算。
	prefix: string; // What we're matching against (e.g., "/" or "src/")
}

// 编辑器面向的提供者接口，声明不自动创建UI、监听按键或取消过期结果。
export interface AutocompleteProvider {
	/** Characters that should naturally trigger this provider at token boundaries. */
	// 可选自然触发字符；Editor还会规范/合并自身默认触发字符，Combined类没有单独声明这项字段。
	triggerCharacters?: string[];

	// Get autocomplete suggestions for current text/cursor position
	// Returns null if no suggestions available
	// 异步查询当前文字/光标的候选，返回建议或null；实际读取磁盘/执行外部回调及取消配合由实现决定。
	getSuggestions(
		// 整份编辑文本的行数组。
		lines: string[],
		// 零起始行号。
		cursorLine: number,
		// 该行内UTF-16光标下标，不是终端列。
		cursorCol: number,
		// signal表达取消意图，force区分显式文件补全；类型不保证每个实现都及时停止。
		options: { signal: AbortSignal; force?: boolean },
		// Promise完成不代表结果仍与当前编辑状态一致，Editor会另查请求编号/快照/取消状态。
	): Promise<AutocompleteSuggestions | null>;

	// Apply the selected item
	// Returns the new text and cursor position
	// 同步应用选择，返回新文字和光标，不要求直接修改Editor；例：/mo替换成/model并把光标移到空格后。
	applyCompletion(
		// 待处理的行数组。
		lines: string[],
		// 修改哪一行。
		cursorLine: number,
		// 原行的插入点UTF-16下标。
		cursorCol: number,
		// 选中的候选对象。
		item: AutocompleteItem,
		// 查询时保存的原始替换前缀，需要与光标前内容匹配。
		prefix: string,
		// 返回对象中的三个字段供Editor接管状态，而不是渲染行列表。
	): {
		// 替换后的编辑行数组。
		lines: string[];
		// 新的行号。
		cursorLine: number;
		// 新的UTF-16光标下标。
		cursorCol: number;
	};

	// Check if file completion should trigger for explicit Tab completion
	// 可选显式Tab门槛，输入文字/光标、返回是否允许文件查询；例：正在输入开头命令名时不抢命令补全，本声明不执行它。
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

// Combined provider that handles both slash commands and file paths
// 组合命令/参数/路径的实际提供者；implements仅静态约束，构造保存配置，查询才同步读目录或spawn fd。
// @优先处理；非force再试/命令，最后普通路径。取消fd与Editor丢弃旧结果是两层机制，不应把所有分支都说成可中断。
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	// 命令描述或通用候选联合数组，保存调用者原引用，外部修改会影响后续查询。
	private commands: (SlashCommand | AutocompleteItem)[];
	// 相对路径查询的默认基目录，~及显式绝对路径可另选目录。
	private basePath: string;
	// 可选fd可执行路径；null时禁用@模糊文件查询，不禁同步普通路径。
	private fdPath: string | null;

	// 构造时保存命令、基目录和可选fd，不查文件/不启动子进程；例：只做斜杠命令可不传fd，commands虽有默认但basePath仍须提供。
	constructor(commands: (SlashCommand | AutocompleteItem)[] = [], basePath: string, fdPath: string | null = null) {
		// 直接保存数组引用，不复制候选描述。
		this.commands = commands;
		// 保存路径字符串，不在构造时检查存在性。
		this.basePath = basePath;
		// 保存fd路径或null，未检测是否已安装。
		this.fdPath = fdPath;
	}

	// 查询当前光标前缀并返回候选/null，可能更新外部回调状态或读磁盘，但不修改lines；依次@、非force命令、普通文件路径。
	// 例：@src/a用fd查，/mod用命令模糊筛选，force下src/a列父目录。命令参数回调错误可拒绝Promise；fd/目录错误通常变空候选，旧结果是否可用由Editor判定。
	async getSuggestions(
		// 原编辑行数组，此实现只读取当前行。
		lines: string[],
		// 当前行号。
		cursorLine: number,
		// 行内UTF-16光标下标，slice取它之前的文字。
		cursorCol: number,
		// signal仅传@异步路径，force不跳过@优先级。
		options: { signal: AbortSignal; force?: boolean },
		// 异步函数的return自动成为Promise完成值，return null不表示抛错。
	): Promise<AutocompleteSuggestions | null> {
		// 不存在/空当前行回退空串。
		const currentLine = lines[cursorLine] || "";
		// 只看光标之前的文本，不把后面的闭引号等纳入查询。
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// 先提取合法边界的@附件前缀，可含未闭合双引号。
		const atPrefix = this.extractAtPrefix(textBeforeCursor);
		// @本身也是非空前缀，因而空附件查询也进入此分支。
		if (atPrefix) {
			// 去掉@/开引号，同时保存原引用状态供候选重建。
			const { rawPrefix, isQuotedPrefix } = parsePathPrefix(atPrefix);
			// 等待fd模糊路径建议，暂停本异步函数而非阻塞事件循环。
			const suggestions = await this.getFuzzyFileSuggestions(rawPrefix, {
				// 保留用户已处于双引号内的上下文。
				isQuotedPrefix,
				// 传本轮取消信号给fd路径。
				signal: options.signal,
			});
			// 无结果不再尝试命令/普通路径，直接null。
			if (suggestions.length === 0) return null;

			// 返回完整建议结构，候选已排过序。
			return {
				// items装实际附件候选。
				items: suggestions,
				// prefix保留原@和开引号，供应用时精确替换。
				prefix: atPrefix,
			};
		}

		// 只删除行首空白来识别/命令，真正替换仍保留beforePrefix里的原缩进。
		const commandText = textBeforeCursor.trimStart();
		// 显式force文件补全绕过命令分支；正常触发才把开头/看成命令。
		if (!options.force && commandText.startsWith("/")) {
			// 用第一个ASCII空格分开命令名/参数，不在这里按所有Unicode空白拆命令。
			const spaceIndex = commandText.indexOf(" ");

			// 还没ASCII空格，正在补命令名。
			if (spaceIndex === -1) {
				// 去掉/，用裸查询匹配命令名。
				const prefix = commandText.slice(1);
				// map为每个原命令生成本次临时展示对象，不执行命令回调。
				const commandItems = this.commands.map((cmd) => {
					// in做联合分支：SlashCommand用name，AutocompleteItem用value。
					const name = "name" in cmd ? cmd.name : cmd.value;
					// 有argumentHint字段且非空才取提示，否则undefined。
					const hint = "argumentHint" in cmd && cmd.argumentHint ? cmd.argumentHint : undefined;
					// 缺说明按空串处理，??只对null/undefined回退。
					const desc = cmd.description ?? "";
					// 提示和说明都存在用破折号连接；仅一项存在就单独展示。
					const fullDesc = hint ? (desc ? `${hint} — ${desc}` : hint) : desc;
					// 返回临时命令记录，供后续两轮筛选。
					return {
						// 保存真实命令名。
						name,
						// 此处菜单label统一用命令名，不沿用通用候选原label。
						label: name,
						// 空说明存undefined，不显示空提示。
						description: fullDesc || undefined,
					};
				});

				// 第一轮按裸名字模糊筛选，回调为每项提供待比较文本。
				const bareNameMatches = fuzzyFilter(commandItems, prefix, (item) =>
					// skill:命令暂去掉skill:再匹配，普通命令不变，便于用idea直接找技能。
					item.name.startsWith("skill:") ? item.name.slice("skill:".length) : item.name,
				);
				// 用对象引用Set记录第一轮已有项，避免第二轮把同一项再放入，不按名字去重不同描述。
				const bareNameMatchSet = new Set(bareNameMatches);
				// 第二轮只补“完整skill:名可命中而裸名未命中”的技能。
				const fullNameOnlyMatches = fuzzyFilter(
					// 先过滤skill:且不在首轮Set里的临时对象。
					commandItems.filter((item) => item.name.startsWith("skill:") && !bareNameMatchSet.has(item)),
					// 沿用同一裸查询文本。
					prefix,
					// 本轮用完整含skill:的名字匹配，允许skill前缀简写查询。
					(item) => item.name,
				);
				// 先拼裸名命中再拼额外完整名命中，并转换成公开候选对象。
				const filtered = [...bareNameMatches, ...fullNameOnlyMatches].map((item) => ({
					// 写回命令名，applyCompletion会另加/。
					value: item.name,
					// 显示相同名字。
					label: item.label,
					// 条件对象展开：只有说明真值时才增加description字段，...不是执行别的逻辑。
					...(item.description && { description: item.description }),
				}));

				// 两轮都没有候选就结束，不继续列文件。
				if (filtered.length === 0) return null;

				// 返回命令名建议。
				return {
					// 保留两轮拼接后的候选排序。
					items: filtered,
					// 替换前缀包括/，不含trimStart去掉的行首空白。
					prefix: commandText,
				};
			}

			// 有ASCII空格后，取/与空格间的精确命令名。
			const commandName = commandText.slice(1, spaceIndex);
			// 其后的全部文字是参数前缀，包括额外空格，不只最后一个词。
			const argumentText = commandText.slice(spaceIndex + 1);

			// 按配置顺序find第一个同名命令，不做命令名模糊匹配。
			const command = this.commands.find((cmd) => {
				// 兼容两种命令描述的命名字段。
				const name = "name" in cmd ? cmd.name : cmd.value;
				// 精确比较名字，匹配到即停止find。
				return name === commandName;
			});
			// 找不到或没有可调用参数补全字段，就无建议；这行不回退普通文件补全。
			if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
				// 直接返回null。
				return null;
			}

			// 真正执行外部参数回调并await；未传signal，回调抛错/拒绝会向上传播。
			const argumentSuggestions = await command.getArgumentCompletions(argumentText);
			// 原实现保留数组/非空检查；null或空结果不显示菜单，不把它描述成TS自动提供的验证。
			if (!Array.isArray(argumentSuggestions) || argumentSuggestions.length === 0) {
				// 没有参数候选时返回null。
				return null;
			}

			// 组装参数建议。
			return {
				// 原样返回回调数组，不复制其中对象。
				items: argumentSuggestions,
				// 替换整个argumentText，不含/命令及其第一个空格。
				prefix: argumentText,
			};
		}

		// 非命令场景提取普通路径；force缺省false，强制时允许普通词甚至空前缀。
		const pathMatch = this.extractPathPrefix(textBeforeCursor, options.force ?? false);
		// null表示当前上下文不应自然触发，空字符串则是有效目录查询。
		if (pathMatch === null) {
			// 不触发时直接null。
			return null;
		}

		// 同步列相应目录并过滤文件名，虽然外层async，这行仍会阻塞当前线程。
		const suggestions = this.getFileSuggestions(pathMatch);
		// 空目录/无匹配/读取失败都不显示建议。
		if (suggestions.length === 0) return null;

		// 返回普通文件候选与原替换前缀。
		return {
			// items是目录优先的排序结果。
			items: suggestions,
			// prefix仍包含用户可能输入的开双引号。
			prefix: pathMatch,
		};
	}

	// 把选中候选替换进当前行并返回新行数组/光标，不改原数组；先处理重复闭引号，再区分命令名、@附件、参数/普通路径。
	// 例：目录候选闭引号仍留着，但光标放到它内侧继续补；@文件加空格，命令名加/与空格。调用方需给与光标前内容匹配的prefix，类型不保证这一点。
	applyCompletion(
		// 原编辑行数组，稍后仅浅复制数组容器。
		lines: string[],
		// 当前行号，返回时保持不变。
		cursorLine: number,
		// 当前UTF-16光标下标，不是显示列。
		cursorCol: number,
		// value是写回正文，label末斜杠决定是否目录。
		item: AutocompleteItem,
		// 将要被替换的前缀文本。
		prefix: string,
		// 返回文字和光标数据，Editor之后才更新自身状态/发onChange。
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		// 取当前原行，缺省为空。
		const currentLine = lines[cursorLine] || "";
		// 保留prefix之前的所有文字，含缩进/包装符；没有额外校验prefix是否真的匹配这段后缀。
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		// 光标之后内容原样保存，稍后可能去掉重复的一个闭引号。
		const afterCursor = currentLine.slice(cursorCol);
		// 判断原查询是否已开启普通/附件双引号。
		const isQuotedPrefix = prefix.startsWith('"') || prefix.startsWith('@"');
		// 原文光标之后是否已有闭合双引号。
		const hasLeadingQuoteAfterCursor = afterCursor.startsWith('"');
		// 选中候选是否已经带自己的闭引号。
		const hasTrailingQuoteInItem = item.value.endsWith('"');
		// 准备调整保留的后缀，避免插入后出现两个相邻闭引号。
		const adjustedAfterCursor =
			// 三条件都满足才消费afterCursor开头的一个引号，否则原样保留后缀。
			isQuotedPrefix && hasTrailingQuoteInItem && hasLeadingQuoteAfterCursor ? afterCursor.slice(1) : afterCursor;

		// Check if we're completing a slash command (prefix starts with "/" but NOT a file path)
		// Slash commands are at the start of the line and don't contain path separators after the first /
		// 命令名判据：prefix从/起、之前只有空白、首个/后不再有/；不是完整命令/路径语法分析。
		const isSlashCommand = prefix.startsWith("/") && beforePrefix.trim() === "" && !prefix.slice(1).includes("/");
		// 命令名补全专门加回/和空格。
		if (isSlashCommand) {
			// This is a command name completion
			// 拼回缩进、/、候选名字、一个空格与原后缀；原后缀若已有空格不会在这里合并。
			const newLine = `${beforePrefix}/${item.value} ${adjustedAfterCursor}`;
			// ...浅复制行数组，不修改调用方容器。
			const newLines = [...lines];
			// 只替换当前这一行。
			newLines[cursorLine] = newLine;

			// 返回更新后的三项状态。
			return {
				// 新行数组交给Editor接管。
				lines: newLines,
				// 保持同一行号，属性简写等于cursorLine:cursorLine。
				cursorLine,
				// 光标落在命令名后的新空格之后，+2对应/和空格，仍按UTF-16长度算。
				cursorCol: beforePrefix.length + item.value.length + 2, // +2 for "/" and space
			};
		}

		// Check if we're completing a file attachment (prefix starts with "@")
		// 原前缀以@起则按附件应用，包括@加双引号形式。
		if (prefix.startsWith("@")) {
			// This is a file attachment completion
			// Don't add space after directories so user can continue autocompleting
			// 目录判断看菜单label尾部/，不检查磁盘，也不看value是否以/结尾（它可能还有引号）。
			const isDirectory = item.label.endsWith("/");
			// 目录不加空格以便继续查询子目录；普通附件后加一个空格。
			const suffix = isDirectory ? "" : " ";
			// 拼接替换前文、已含@的候选值、可选空格及调整后的后缀。
			const newLine = `${beforePrefix + item.value}${suffix}${adjustedAfterCursor}`;
			// 浅复制原数组，其他行仍是原字符串值。
			const newLines = [...lines];
			// 将当前行替换成新串。
			newLines[cursorLine] = newLine;

			// 候选尾部若有闭引号，目录光标要留在它前面。
			const hasTrailingQuote = item.value.endsWith('"');
			// 目录且带闭引号时偏移少1，否则光标到候选文字末尾。
			const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

			// 返回附件替换后的状态数据，无菜单/终端输出。
			return {
				// 新行数组。
				lines: newLines,
				// 原行号保持。
				cursorLine,
				// 前文长度加候选内偏移和新空格长度，仍是UTF-16坐标。
				cursorCol: beforePrefix.length + cursorOffset + suffix.length,
			};
		}

		// Check if we're in a slash command context (beforePrefix contains "/command ")
		// 为剩余情况检查光标前的原文字上下文。
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		// 同时出现/和ASCII空格就启发式视作命令参数；这不是验证存在某个已知命令。
		if (textBeforeCursor.includes("/") && textBeforeCursor.includes(" ")) {
			// This is likely a command argument completion
			// 参数补全直接替换前缀，不额外加/或尾空格。
			const newLine = beforePrefix + item.value + adjustedAfterCursor;
			// 准备独立新行数组。
			const newLines = [...lines];
			// 更新当前行。
			newLines[cursorLine] = newLine;

			// 依菜单label的/约定判断目录。
			const isDirectory = item.label.endsWith("/");
			// 检测候选是否有闭引号。
			const hasTrailingQuote = item.value.endsWith('"');
			// 目录的带引号候选让光标停到闭引号内侧，其他候选停末尾。
			const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

			// 返回参数替换后的数组/坐标。
			return {
				// 交回新数组，原数组不变。
				lines: newLines,
				// 保持当前行。
				cursorLine,
				// 按前文长度与候选偏移确定新光标，不增加额外空格。
				cursorCol: beforePrefix.length + cursorOffset,
			};
		}

		// For file paths, complete the path
		// 普通路径最终也以候选值替掉前缀，保留原后文。
		const newLine = beforePrefix + item.value + adjustedAfterCursor;
		// 复制数组容器而非直接覆盖传入lines。
		const newLines = [...lines];
		// 更新该行的新字符串。
		newLines[cursorLine] = newLine;

		// 普通路径同样使用label尾部/约定。
		const isDirectory = item.label.endsWith("/");
		// 检查已生成候选的闭引号。
		const hasTrailingQuote = item.value.endsWith('"');
		// 目录续补时把光标放到引号内，其他情况放候选末尾。
		const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

		// 返回完整应用结果，由编辑器决定何时接收/重绘。
		return {
			// 替换后的行数组。
			lines: newLines,
			// 没有插入换行，返回原行号。
			cursorLine,
			// 新光标是正文前缀长度加候选内部偏移。
			cursorCol: beforePrefix.length + cursorOffset,
		};
	}

	// Extract @ prefix for fuzzy file suggestions
	// 提取光标前合法的@附件前缀，返回原字符串片段或null，无I/O；先试引用形式，再试最后分隔符后的token，例：空格后@src可成立。
	private extractAtPrefix(text: string): string | null {
		// 优先提取未闭合的引用前缀，保留其中空格不被分词。
		const quotedPrefix = extractQuotedPrefix(text);
		// 可选链避免null访问，只有@双引号形式属于此分支。
		if (quotedPrefix?.startsWith('@"')) {
			// 直接保留从@到光标的整段引用前缀。
			return quotedPrefix;
		}

		// 非引用形式从最后路径分隔边界后取token。
		const lastDelimiterIndex = findLastDelimiter(text);
		// 没有分隔符取整串，再剥掉未配对的开包装符，不删正文目录内部已配对括号。
		const token = stripLeadingWrappers(lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1));

		// 剥包装后的token必须从@开头，词内部的邮箱@不会满足。
		if (token.startsWith("@")) {
			// 返回含@的原前缀，后面另解析rawPrefix。
			return token;
		}

		// 没有附件前缀，交上层考虑命令/普通路径。
		return null;
	}

	// Extract a path-like prefix from the text before cursor
	// 提取普通路径前缀，返回字符串（含空也可）或null；引用优先，force时允许任何末token，自然触发需像路径或位于分隔边界。
	// 例：“src/a”自然触发，“abc”需force；“查看，”后空前缀有效，完全空输入自然不触发。只分析文本，不验证路径存在。
	private extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		// 未闭合双引号可把空白/CJK标点保留在路径内。
		const quotedPrefix = extractQuotedPrefix(text);
		// 存在合法引用前缀直接用它。
		if (quotedPrefix) {
			// 返回仍含开双引号的原文供后续解析。
			return quotedPrefix;
		}

		// 查最后一个分隔符位置。
		const lastDelimiterIndex = findLastDelimiter(text);
		// 取得最后token并清前置未闭包装符。
		const pathPrefix = stripLeadingWrappers(lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1));

		// For forced extraction (Tab key), always return something
		// 显式Tab等强制补全，不要求token看起来像路径。
		if (forceExtract) {
			// 连空前缀也作为有效查询返回，让目录列出所有项。
			return pathPrefix;
		}

		// For natural triggers, return if it looks like a path, ends with /, starts with ~/, .
		// Only return empty string if the text looks like it's starting a path context
		// 自然补全只认含/、从.开头或~/开头；这里不以反斜杠本身作为同等触发条件。
		if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
			// 返回该原路径片段，尚未展开主目录。
			return pathPrefix;
		}

		// Return an empty prefix after whitespace or CJK punctuation, but not for empty text.
		// Empty text should not trigger file suggestions - that's for forced Tab completion
		// 正文非空且正停在空白/CJK标点等末边界，可自然查询空前缀。
		if (pathPrefix === "" && text !== "" && tokenStartRegex.test(text)) {
			// 空串不是null，后续会列当前目录。
			return pathPrefix;
		}

		// 其余普通词不自然触发文件建议。
		return null;
	}

	// Expand home directory (~/) to actual home path
	// 将~或~/写法展开到当前主目录，返回路径字符串，不读目录内容；例：~/src拼到homedir，其他~用户名写法原样返回。
	private expandHomePath(path: string): string {
		// ~/前缀才把余下相对部分拼进主目录。
		if (path.startsWith("~/")) {
			// 去掉~/后用平台join做路径规范化。
			const expandedPath = join(homedir(), path.slice(2));
			// Preserve trailing slash if original path had one
			// join可能去掉目录尾斜杠，用户原来有则补回一个/以保留继续列目录的意图。
			return path.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
			// 只有一个~时直接取主目录。
		} else if (path === "~") {
			// 返回系统提供的主目录字符串。
			return homedir();
		}
		// 未匹配的形式不展开，不替用户猜其他用户名。
		return path;
	}

	// 把查询最后斜杠之前的存在目录作为搜索范围，返回基目录/剩余查询/展示前缀，找不到则null；会同步stat，不修改文件。
	// 例：../outside/a若目录存在，就在outside递归找a，显示仍保留../outside/；若目录不存在，上层退回原基目录和整查询做fd全路径匹配。
	private resolveScopedFuzzyQuery(rawQuery: string): { baseDir: string; query: string; displayBase: string } | null {
		// 先统一反斜杠为/用于拆分。
		const normalizedQuery = toDisplayPath(rawQuery);
		// 以最后一个斜杠划分目录范围和文件名查询。
		const slashIndex = normalizedQuery.lastIndexOf("/");
		// 没有目录部分就无法缩小范围。
		if (slashIndex === -1) {
			// 返回null让上层用默认basePath。
			return null;
		}

		// 展示目录前缀包含末尾/，稍后可直接接相对结果。
		const displayBase = normalizedQuery.slice(0, slashIndex + 1);
		// 最后/之后的文字作为fd查询，可能为空。
		const query = normalizedQuery.slice(slashIndex + 1);

		// 声明接下来三分支都会赋值的实际基目录字符串。
		let baseDir: string;
		// ~/范围需要主目录展开。
		if (displayBase.startsWith("~/")) {
			// 调用上面的纯路径展开函数。
			baseDir = this.expandHomePath(displayBase);
			// 以/开头按当前实现的绝对目录分支处理。
		} else if (displayBase.startsWith("/")) {
			// 实际基目录就是该字符串，不与basePath拼接。
			baseDir = displayBase;
			// 其他目录前缀当相对路径。
		} else {
			// 拼到配置基目录，可含../并离开其物理范围，不是安全隔离边界。
			baseDir = join(this.basePath, displayBase);
		}

		// 目录可能不存在或没有权限，检查失败不抛给用户。
		try {
			// stat跟随符号链接，只有最终目标为目录才采用该范围。
			if (!statSync(baseDir).isDirectory()) {
				// 目标不是目录也不能作为扫描根。
				return null;
			}
			// 元数据读取失败时退回上层的一般查询。
		} catch {
			// 返回null，不创建缺少的目录。
			return null;
		}

		// 返回实际扫描位置与原展示形式两个不同概念的数据。
		return { baseDir, query, displayBase };
	}

	// 把范围内fd相对路径拼回用户写法，返回显示串，无I/O；例：../outside/与a.ts得到../outside/a.ts。
	private scopedPathForDisplay(displayBase: string, relativePath: string): string {
		// 统一fd返回的路径分隔符。
		const normalizedRelativePath = toDisplayPath(relativePath);
		// 范围本身是根/时特殊处理，避免额外拼出两条斜杠。
		if (displayBase === "/") {
			// 根斜杠加相对路径。
			return `/${normalizedRelativePath}`;
		}
		// 其他前缀已含末斜杠，直接连接，不用join以免丢掉~/或./展示形式。
		return `${toDisplayPath(displayBase)}${normalizedRelativePath}`;
	}

	// Get file/directory suggestions for a given path prefix
	// 同步列一个目录并按名字前缀过滤，返回目录优先候选或[]；会readdir/stat，不递归、不读取内容，也不应用fd的.gitignore过滤。
	// 例：./sr可补./src/；引用路径会重建引号，符号链接查目标是否目录。整个分支catch错误成[]，不接收/检查AbortSignal，不能中途取消同步扫描。
	private getFileSuggestions(prefix: string): AutocompleteItem[] {
		// 捕获本次目录读取、路径处理及排序等同步异常。
		try {
			// 稍后确定要扫描哪个实际目录。
			let searchDir: string;
			// 在该目录内匹配的文件名开头，空串匹配全部名称。
			let searchPrefix: string;
			// 拆@/引用标志；rawPrefix保留用户输入的路径展示形式。
			const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
			// 实际访问路径可与展示前缀不同，例如主目录展开。
			let expandedPrefix = rawPrefix;

			// Handle home directory expansion
			// ~起头先尝试展开，但expandHomePath仅支持~和~/。
			if (expandedPrefix.startsWith("~")) {
				// 将已支持主目录写法换成实际磁盘路径。
				expandedPrefix = this.expandHomePath(expandedPrefix);
			}

			// 这些特定形式表示直接列指定目录，下面各||是一条判定的续行。
			const isRootPrefix =
				// 空前缀列配置基目录。
				rawPrefix === "" ||
				// ./列基目录自身。
				rawPrefix === "./" ||
				// ../列其父目录。
				rawPrefix === "../" ||
				// ~列当前主目录。
				rawPrefix === "~" ||
				// ~/也列主目录，同时保留尾斜杠展示语义。
				rawPrefix === "~/" ||
				// /列文件系统根目录。
				rawPrefix === "/" ||
				// 保留原实现的附件空前缀判据；前面空串分支已覆盖这一条件。
				(isAtPrefix && rawPrefix === "");

			// 属于这些目录入口时不再把末段当文件名前缀。
			if (isRootPrefix) {
				// Complete from specified position
				// 主目录写法或展开后以/起头时使用已展开位置。
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					// 直接扫描该位置。
					searchDir = expandedPrefix;
					// 其他入口相对于basePath解释。
				} else {
					// 例如../拼到basePath后规范成上层路径。
					searchDir = join(this.basePath, expandedPrefix);
				}
				// 文件名前缀为空，列所有目录项。
				searchPrefix = "";
				// 其他以/结束的路径也表示正在进入目录。
			} else if (rawPrefix.endsWith("/")) {
				// If prefix ends with /, show contents of that directory
				// 同样区分主目录/绝对与相对目录。
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					// 主目录展开或绝对路径直接作扫描根。
					searchDir = expandedPrefix;
					// 相对路径要从配置基目录起算。
				} else {
					// 拼接相对目录。
					searchDir = join(this.basePath, expandedPrefix);
				}
				// 目录内暂无文件名查询，空前缀匹配全部项。
				searchPrefix = "";
				// 非目录末斜杠形式，需要拆父目录和末尾文件名前缀。
			} else {
				// Split into directory and file prefix
				// dirname取实际访问路径的父目录。
				const dir = dirname(expandedPrefix);
				// basename取末尾文件名查询。
				const file = basename(expandedPrefix);
				// 主目录或绝对路径的父目录不再接basePath。
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					// 直接用已拆出的实际目录。
					searchDir = dir;
					// 相对文件查询从basePath下查其父目录。
				} else {
					// 拼出该相对目录的实际位置。
					searchDir = join(this.basePath, dir);
				}
				// 只在这目录里匹配末段文件名。
				searchPrefix = file;
			}

			// withFileTypes使返回项带Dirent类型方法，避免每个普通项都额外stat；调用同步且不读文件正文。
			const entries = readdirSync(searchDir, { withFileTypes: true });
			// 收集匹配的菜单候选，无本地项数上限。
			const suggestions: AutocompleteItem[] = [];

			// 依目录返回顺序检查每个条目，最终再排序。
			for (const entry of entries) {
				// 两边小写后做startsWith，普通路径用名字前缀匹配而非任意子序列搜索。
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
					// 不符合前缀就跳过。
					continue;
				}

				// Check if entry is a directory (or a symlink pointing to a directory)
				// 普通目录由Dirent直接判断。
				let isDirectory = entry.isDirectory();
				// 不是直接目录但为符号链接时，再跟随目标检查。
				if (!isDirectory && entry.isSymbolicLink()) {
					// 断链/权限错误不应让全部建议都失败。
					try {
						// 拼出链接的实际路径。
						const fullPath = join(searchDir, entry.name);
						// stat跟随链接目标，目标目录也可继续补全。
						isDirectory = statSync(fullPath).isDirectory();
						// 检查目标失败时保持初始false，按文件显示该链接。
					} catch {
						// Broken symlink or permission error - treat as file
					}
				}

				// 声明本项写回时使用的路径展示文本，不一定真是相对路径（也可绝对）。
				let relativePath: string;
				// 条目名称本身，不含父目录。
				const name = entry.name;
				// 使用未展开的rawPrefix恢复用户写法，而不是把主目录都改成绝对路径。
				const displayPrefix = rawPrefix;

				// 原展示前缀已经以/结束，可直接追加新名称。
				if (displayPrefix.endsWith("/")) {
					// If prefix ends with /, append entry to the prefix
					// 保持目录展示形式和原先斜杠。
					relativePath = displayPrefix + name;
					// 含路径分隔符的未完成文件名需要替换末段。
				} else if (displayPrefix.includes("/") || displayPrefix.includes("\\")) {
					// Preserve ~/ format for home directory paths
					// ~/形式单独处理，避免join把用户主目录展示写法丢掉。
					if (displayPrefix.startsWith("~/")) {
						// 取去掉~/的相对路径部分。
						const homeRelativeDir = displayPrefix.slice(2); // Remove ~/
						// 获取其中的父目录，末段会被本候选替换。
						const dir = dirname(homeRelativeDir);
						// 父目录为.只显示~/name，否则拼回更深的主目录相对路径。
						relativePath = `~/${dir === "." ? name : join(dir, name)}`;
						// 以/起头的展示路径按绝对形式恢复。
					} else if (displayPrefix.startsWith("/")) {
						// Absolute path - construct properly
						// 取原展示父目录。
						const dir = dirname(displayPrefix);
						// 根目录不能再额外添一个/。
						if (dir === "/") {
							// 直接产生/name。
							relativePath = `/${name}`;
							// 其他绝对父目录后追加斜杠和名字。
						} else {
							// 保留绝对目录前缀。
							relativePath = `${dir}/${name}`;
						}
						// 其他分隔路径按相对形式恢复。
					} else {
						// 用平台join去掉旧末段、接入新名称。
						relativePath = join(dirname(displayPrefix), name);
						// path.join normalizes away ./ prefix, preserve it
						// join会规范掉./，但用户显式输入过则补回。
						if (displayPrefix.startsWith("./") && !relativePath.startsWith("./")) {
							// 只恢复一个./前缀，不影响实际扫描位置。
							relativePath = `./${relativePath}`;
						}
					}
					// 没有分隔符的普通短文件名，不需要恢复父目录。
				} else {
					// For standalone entries, preserve ~/ if original prefix was ~/
					// 以~起头的展示形式按该分支恢复~/，并不证明支持~用户名展开。
					if (displayPrefix.startsWith("~")) {
						// 展示成主目录短写加候选名。
						relativePath = `~/${name}`;
						// 其余情况直接显示候选名称。
					} else {
						// 例如README.md无需加./。
						relativePath = name;
					}
				}

				// 最终显示/写回统一成正斜杠。
				relativePath = toDisplayPath(relativePath);
				// 目录候选末加/，文件不加，之后可能在外层包双引号。
				const pathValue = isDirectory ? `${relativePath}/` : relativePath;
				// 根据路径分隔内容与原前缀标志构造写回value。
				const value = buildCompletionValue(pathValue, {
					// 传目录标志；当前构造函数不读取它，斜杠已经在上一步加入。
					isDirectory,
					// 保留是否附件前缀的标志。
					isAtPrefix,
					// 保留是否处于双引号内的标志。
					isQuotedPrefix,
				});

				// 将候选加入公开列表。
				suggestions.push({
					// 写回的完整路径值，可能含@/引号。
					value,
					// 菜单只显示条目名和目录斜杠，applyCompletion据此判断目录。
					label: name + (isDirectory ? "/" : ""),
				});
			}

			// Sort directories first, then alphabetically
			// 就地排序本次新建数组；比较回调应返回负/0/正来决定顺序。
			suggestions.sort((a, b) => {
				// 第一项是否目录。
				const aIsDir = a.label.endsWith("/");
				// 第二项是否目录。
				const bIsDir = b.label.endsWith("/");
				// 只有第一项是目录则排它前面。
				if (aIsDir && !bIsDir) return -1;
				// 只有第二项是目录则排它前面。
				if (!aIsDir && bIsDir) return 1;
				// 同类按localeCompare的语言环境排序，不是固定字节序。
				return a.label.localeCompare(b.label);
			});

			// 返回所有匹配项，不在本分支裁成20项。
			return suggestions;
			// 任一步同步异常转成空结果，错误对象未使用。
		} catch (_e) {
			// Directory doesn't exist or not accessible
			// 目录不存在/无权限等情形对UI表现为没有候选。
			return [];
		}
	}

	// Score an entry against the query (higher = better match)
	// isDirectory adds bonus to prioritize folders
	// 给fd已找出的单项算排序分，返回数字无修改；文件名精确>开头>包含>全路径包含，目录在正分基础上加10。
	// 例：query=src时目录src可110分、文件src.txt可80分；高分优先，不是fuzzyFilter的低分优先算法，也不能挽回fd没返回的项。
	private scoreEntry(filePath: string, query: string, isDirectory: boolean): number {
		// 从候选路径提文件名，目录末斜杠由平台basename处理。
		const fileName = basename(filePath);
		// 文件名转小写供不区分大小写的评分比较。
		const lowerFileName = fileName.toLowerCase();
		// 查询同样小写；fd本身筛选规则仍由fd决定，不由本评分控制。
		const lowerQuery = query.toLowerCase();

		// 默认0分，完全不包含查询的项后面会被过滤。
		let score = 0;

		// Exact filename match (highest)
		// 文件名完全相同基础分100。
		if (lowerFileName === lowerQuery) score = 100;
		// Filename starts with query
		// 否则文件名以查询开头基础分80。
		else if (lowerFileName.startsWith(lowerQuery)) score = 80;
		// Substring match in filename
		// 否则文件名内部含查询基础分50。
		else if (lowerFileName.includes(lowerQuery)) score = 50;
		// Substring match in full path
		// 否则整条相对路径含查询基础分30。
		else if (filePath.toLowerCase().includes(lowerQuery)) score = 30;

		// Directories get a bonus to appear first
		// 目录只在已经有命中正分时加10，不让完全无关目录凭空进入候选。
		if (isDirectory && score > 0) score += 10;

		// 返回本条目的最终分数，不读取文件内容。
		return score;
	}

	// 取指定目录的直接子项fd候选，返回Promise数组；例：目录下项目优先被保留，避免递归深处大量匹配淹没它们。
	private async getBaseDirSuggestions(
		// 本轮有效扫描根。
		baseDir: string,
		// 在这个范围内匹配的查询字符串。
		query: string,
		// 本轮取消信号。
		signal: AbortSignal,
		// 数组每项包含显示路径和目录后缀判断。
	): Promise<Array<{ path: string; isDirectory: boolean }>> {
		// 没有fd或开始前已取消，就不启动进程。
		if (!this.fdPath || signal.aborted) {
			// 以空数组完成异步函数。
			return [];
		}

		// 请求100项、深度1，不代表再递归所有子目录；await等本地进程完成。
		return await walkDirectoryWithFd(baseDir, this.fdPath, query, 100, signal, 1);
	}

	// Fuzzy file search using fd (fast, respects .gitignore)
	// @模糊文件建议的总流程，返回最多20条排序候选：解析可用目录范围，先查直接子项再递归，去重/评分/排序并重建@与引号。
	// 例：@../outside/a保留../outside展示前缀；会运行两个顺序fd查询并同步stat范围，出错/取消返回[]，不设总耗时上限，Editor负责丢弃迟到旧结果。
	private async getFuzzyFileSuggestions(
		// 已去@/开启引号的路径查询。
		query: string,
		// 保存引用上下文与取消信号，不把signal传进所有同步路径操作。
		options: { isQuotedPrefix: boolean; signal: AbortSignal },
		// 异步返回公开候选数组。
	): Promise<AutocompleteItem[]> {
		// 缺fd不退回readdir；已取消也不启动搜索。
		if (!this.fdPath || options.signal.aborted) {
			// 空数组让上层返回null，不显示附件菜单。
			return [];
		}

		// 捕获范围处理、进程等待之后排序/候选构造等异常，统一无建议。
		try {
			// 尝试把存在目录前缀转为范围，可能同步stat。
			const scopedQuery = this.resolveScopedFuzzyQuery(query);
			// 有效范围用其实际目录，否则用配置basePath。
			const fdBaseDir = scopedQuery?.baseDir ?? this.basePath;
			// 有效范围只匹配最后文件名片段，否则用完整原查询（fd可能按全路径匹配）。
			const fdQuery = scopedQuery?.query ?? query;
			// 先await深度1查询，完成之后才启动下一条，不是并行子进程。
			const baseDirEntries = await this.getBaseDirSuggestions(fdBaseDir, fdQuery, options.signal);
			// 再await不限深度的递归查询，仍请求100项，取消时walker可直接返回[]。
			const recursiveEntries = await walkDirectoryWithFd(fdBaseDir, this.fdPath, fdQuery, 100, options.signal);
			// Set按路径字符串记录第一组已出现项，不按真实路径/同一inode去重。
			const seenPaths = new Set(baseDirEntries.map((entry) => entry.path));
			// 合并时让直接子项排在前，后续统一评分排序。
			const entries = [
				// 先保留所有第一组结果。
				...baseDirEntries,
				// 过滤递归组，把重复显示路径去掉。
				...recursiveEntries.filter((entry) => {
					// 已经出现的精确路径不再加入。
					if (seenPaths.has(entry.path)) return false;
					// 标记新路径，递归组内重复也会去掉。
					seenPaths.add(entry.path);
					// 保留这一个新条目。
					return true;
				}),
			];
			// 即使进程刚正常结束，最后还查取消状态，避免把取消结果送上层。
			if (options.signal.aborted) {
				// 取消后丢弃所有已收集候选。
				return [];
			}

			// 为合并条目建立评分后的新对象数组。
			const scoredEntries = entries
				// map给每项附加分数字段，不改变原条目对象。
				.map((entry) => ({
					// ...复制路径/目录布尔字段。
					...entry,
					// 查询非空才按匹配程度评分，空查询每项给1保证都可候选。
					score: fdQuery ? this.scoreEntry(entry.path, fdQuery, entry.isDirectory) : 1,
				}))
				// 0分及以下直接剔除；fd返回不等于最终必定展示。
				.filter((entry) => entry.score > 0);

			// 先分数降序，再深度/长度升序，最后字典顺序，排序修改新建scoredEntries数组。
			scoredEntries.sort((a, b) => {
				// b-a让较大分在前。
				const scoreDiff = b.score - a.score;
				// 分数不同即可确定顺序。
				if (scoreDiff !== 0) return scoreDiff;

				// 统一分隔后按非空路径段计第一项深度，目录尾斜杠不多算一层。
				const aDepth = toDisplayPath(a.path).split("/").filter(Boolean).length;
				// 同样计算第二项深度。
				const bDepth = toDisplayPath(b.path).split("/").filter(Boolean).length;
				// a-b使较浅路径优先。
				const depthDiff = aDepth - bDepth;
				// 深度不同就不用继续比长度。
				if (depthDiff !== 0) return depthDiff;

				// 按原路径码元长度比较，不是显示列宽。
				const lengthDiff = a.path.length - b.path.length;
				// 较短字符串在前。
				if (lengthDiff !== 0) return lengthDiff;

				// 仍相同则localeCompare稳定给出文字顺序，不按文件修改时间排序。
				return a.path.localeCompare(b.path);
			});
			// 最终只保留前20条，目录优先仅来自相同命中层次的加分，不保证任意目录都压过更高分文件。
			const topEntries = scoredEntries.slice(0, 20);

			// 建立最终公开候选数组，去掉内部score等字段。
			const suggestions: AutocompleteItem[] = [];
			// 解构path并改名entryPath，避免与导入路径函数语义混淆，同时取得目录布尔。
			for (const { path: entryPath, isDirectory } of topEntries) {
				// 目录路径先去fd末斜杠，方便算basename和拼范围；随后再补一个。
				const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
				// 有范围时恢复用户原目录前缀，没范围沿用fd相对结果。
				const displayPath = scopedQuery
					? // 把范围基前缀与相对路径拼成展示路径，不换成实际绝对baseDir。
						this.scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash)
					: // 默认查询直接显示fd结果路径。
						pathWithoutSlash;
				// 菜单短名称取路径末段。
				const entryName = basename(pathWithoutSlash);
				// 目录写回路径需要尾斜杠以继续补全。
				const completionPath = isDirectory ? `${displayPath}/` : displayPath;
				// 生成完整的@候选值并按需要加双引号。
				const value = buildCompletionValue(completionPath, {
					// 保留目录标志，实际加/已在上一行完成。
					isDirectory,
					// 这一方法专为附件，始终加@。
					isAtPrefix: true,
					// 原本在双引号内时，即使最终名字没空白也维持引用形式。
					isQuotedPrefix: options.isQuotedPrefix,
				});

				// 加入菜单候选。
				suggestions.push({
					// value用于替换原前缀。
					value,
					// label只显示文件名及目录/标记。
					label: entryName + (isDirectory ? "/" : ""),
					// description显示较完整的路径，帮助区分同名文件。
					description: displayPath,
				});
			}

			// 返回前20条转换后的候选。
			return suggestions;
			// 异常不向UI暴露，保持附件补全可失败的交互。
		} catch {
			// 以空数组表示无可用结果。
			return [];
		}
	}

	// Check if we should trigger file completion (called on Tab key)
	// 显式Tab是否交文件补全的门槛，输入文字/行列，返回布尔值无I/O；例：开头/model尚无空格时false，让Editor保留命令名补全。
	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		// 只读当前行，缺省空串。
		const currentLine = lines[cursorLine] || "";
		// 只判断光标前文，不受后文影响。
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Don't trigger if we're typing a slash command at the start of the line
		// trim后从/起且不含ASCII空格，就认为还在命令名位置；绝对短路径也可能被这个启发式拦住，force调用本身是另一层选择。
		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			// 拒绝本次显式文件触发，不调用磁盘搜索。
			return false;
		}

		// 其余上下文允许Editor继续发文件补全请求，不代表一定能找到候选。
		return true;
	}
}
