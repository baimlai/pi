// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；复制到扩展目录或 `pi -e ./github-issue-autocomplete.ts` 加载。
// 演示内容：为 TUI 输入提供 #123 形式的 GitHub issue 补全；会话启动时解析远端仓库并预取 open issues，输入 # 时本地过滤。
// 上下游：session_start -> git remote -v 解析 owner/repo -> ctx.ui.addAutocompleteProvider 包装当前 provider；getSuggestions 调用 gh issue list，fuzzyFilter 生成 items；applyCompletion 委托当前 provider。ctx.ui.notify 报错。
// 能力清单：
// - GitHubIssue/RepoResolution：issue 与仓库解析结果的类型。
// - extractIssueToken/parseGitHubRepo/resolveGitHubRepo：识别 #token、解析 github.com 远端。
// - filterIssues/formatIssueItem：数字前缀优先，否则 fuzzyFilter；最多 20 条建议。
// - createIssueAutocompleteProvider：只在 #token 存在时接管，否则交回当前 provider。
// - 默认导出：每个会话解析仓库、预取并注册 provider。
// 典型运行顺序：启动会话 -> git remote -v 找到 GitHub 仓库 -> 后台 gh issue list 预取 -> 输入 #12 -> provider 返回匹配项 -> 选择后由当前 provider 应用补全。
// 示例（真实签名）：
//   git remote -v  # origin git@github.com:owner/repo.git
//   # 输入 "fix #12" 时出现 #123 的标题建议
// 阅读顺序：先看 token/仓库解析，再看 filterIssues 的排序，最后看 provider 包装与 session_start 预取。
// 前置与副作用：需要 git 仓库、github.com 远端、已安装并认证 gh；否则通知并禁用。预取/补全都调用本地 gh，有 5s timeout，但不会把 autocomplete 的 signal 传给进程。结果最多 100 个 open issue、最多 20 条建议；JSON.parse 只检查语法，不验证数组/字段，这是外部输入信任边界。issuesPromise 会缓存失败结果，之后不再重试；gh 失败/解析失败每个会话只通知一次。git remote -v 取任意一个 github.com 远端，不一定是 origin；只支持 github.com，不支持 GitHub Enterprise、ssh:// 或带路径/结尾斜杠的 URL。输入只识别行首或空格/制表符后的 #；await 后检查一次 aborted，但不会中止已在运行的 gh，aborted 时交回当前 provider 而不是返回 null。每次 session_start 注册包装 provider；会话替换后旧 provider/闭包是否继续存在由 UI 生命周期决定。
// Requires GitHub CLI (`gh`) and a GitHub repository checkout.
// Preloads the latest open issues once per session, then filters them locally for fast `#...` completion.

// import type 只引入类型；ExtensionAPI 用于标注入口和 resolveGitHubRepo 的 pi 参数。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// 从 pi-tui 引入补全类型和 fuzzyFilter；fuzzyFilter 是运行值，其余是 type import。
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

// gh issue list --json 输出的字段形状；JSON.parse 后只做类型断言，不验证字段。
type GitHubIssue = {
	number: number;
	title: string;
	state: string;
};

// 仓库解析用可辨识联合：ok 为 true 时一定有 repo，false 时一定有 error。
type RepoResolution = { ok: true; repo: string } | { ok: false; error: string };

// 一次最多拉取 100 个 open issue；不是分页总数。
const MAX_ISSUES = 100;
// 每次补全最多显示 20 条，避免选择器过长。
const MAX_SUGGESTIONS = 20;

// 从光标前的文本提取 #token：要求 # 在行首或空白之后，并一直取到下一个空白/#。
function extractIssueToken(textBeforeCursor: string): string | undefined {
	// [^\s#]* 允许空 token（单独输入 # 时返回空串），此时会展示前 20 个 issue。
	const match = textBeforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
	// match 为 null 时返回 undefined；空串是有效 token，不能用 || 或 ?? 混淆。
	return match?.[1];
}

// 从 git remote URL 解析 GitHub 的 owner/repo；只支持 git@github.com: 和 http(s)://github.com/ 两种形式。
function parseGitHubRepo(remoteUrl: string): string | undefined {
	// SSH scp 形式；非贪婪匹配 + 可选 .git 后缀；owner/repo 中不能有额外斜杠。
	const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
	// 正则已捕获 owner/repo；返回不带 .git 的格式。
	if (sshMatch) {
		return sshMatch[1];
	}

	// HTTPS 形式；允许 http 和 https，不允许凭据、端口或额外路径。
	const httpsMatch = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
	if (httpsMatch) {
		return httpsMatch[1];
	}

	// 不认识的 URL 返回 undefined，调用方继续看下一个 remote。
	return undefined;
}

// 读取 git remote -v 并解析仓库；输入 pi 和 cwd，输出 ok/error 联合。
// 只读、无其他副作用；cwd 不存在/非 git 仓库时返回错误，不抛异常。
async function resolveGitHubRepo(pi: ExtensionAPI, cwd: string): Promise<RepoResolution> {
	// git 命令显式使用 ctx.cwd，并限制 5s；timeout 到期会得到非零结果。
	const result = await pi.exec("git", ["remote", "-v"], { cwd, timeout: 5_000 });
	// 非零退出统一解释为“不是 git 仓库”；权限/损坏等错误也会走同一提示。
	if (result.code !== 0) {
		// error 文本会直接用于 notify；这里只描述 cwd 不是仓库。
		return { ok: false, error: "github-issue-autocomplete: cwd is not a git repository" };
	}

	// 每行形如 "origin\tgit@github.com:owner/repo.git (fetch)"；按任意空白分割。
	for (const line of result.stdout.split("\n")) {
		// columns[1] 是 URL；columns[0] 是 remote 名，但示例不区分 origin。
		const columns = line.trim().split(/\s+/);
		// 没有第二列时跳过；格式异常的行不会报错。
		const remoteUrl = columns[1];
		// 任何能解析出 GitHub 仓库的 remote 都接受，包括非 origin。
		if (!remoteUrl) {
			continue;
		}
		// 解析成功立即返回，后续 remote 不再检查。
		const repo = parseGitHubRepo(remoteUrl);
		if (repo) {
			return { ok: true, repo };
		}
	}

	// 有 remote 但没有 github.com URL 时返回更具体的错误。
	return { ok: false, error: "github-issue-autocomplete: cwd is not a GitHub repository" };
}

// 把 issue 转成补全项：value/label 都是 #N，description 显示状态和标题。
function formatIssueItem(issue: GitHubIssue): AutocompleteItem {
	// state 统一小写，例如 OPEN -> open；标题原样保留。
	return {
		value: `#${issue.number}`,
		label: `#${issue.number}`,
		description: `[${issue.state.toLowerCase()}] ${issue.title}`,
	};
}

// 根据 query 过滤 issue，返回最多 MAX_SUGGESTIONS 个补全项。
// 空 query 返回前 20 个；纯数字优先按编号前缀匹配，没有编号匹配再走 fuzzy。
function filterIssues(issues: GitHubIssue[], query: string): AutocompleteItem[] {
	// 只有空白 query 视为空；单个 # 后的空 token 也走这里。
	if (!query.trim()) {
		// slice 取前 20 个，不排序；顺序沿用 gh 返回顺序。
		return issues.slice(0, MAX_SUGGESTIONS).map(formatIssueItem);
	}

	// 纯数字 query 先按编号 startsWith 匹配，保证 #12 优先命中 #123。
	if (/^\d+$/.test(query)) {
		// filter 保留原顺序；number 转成字符串后用 startsWith 与 query 比较（数字没有大小写问题）。
		const numericMatches = issues
			.filter((issue) => String(issue.number).startsWith(query))
			.slice(0, MAX_SUGGESTIONS)
			.map(formatIssueItem);
		// 有编号匹配就直接返回；没有才继续 fuzzy，避免用户输入数字时被标题噪声干扰。
		if (numericMatches.length > 0) {
			return numericMatches;
		}
	}

	// fuzzyFilter 的搜索文本是“编号 + 标题”；返回结果再截断 20 条。
	return fuzzyFilter(issues, query, (issue) => `${issue.number} ${issue.title}`)
		.slice(0, MAX_SUGGESTIONS)
		.map(formatIssueItem);
}

// 包装当前 autocomplete provider：只有识别到 #token 且拿到 issue 时才接管。
// 输入 current 和 getIssues，返回同接口 provider；applyCompletion/shouldTriggerFileCompletion 都委托 current。
function createIssueAutocompleteProvider(
	current: AutocompleteProvider,
	getIssues: () => Promise<GitHubIssue[] | undefined>,
): AutocompleteProvider {
	// 返回新 provider 对象；getSuggestions 是唯一改写的核心方法。
	return {
		// cursorLine/cursorCol 来自编辑器；options.signal 可用于取消，但 gh 进程不会收到它。
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			// cursorLine 越界时用空串；slice 到光标前，忽略光标后的文本。
			const currentLine = lines[cursorLine] ?? "";
			// 只取光标前的内容判断 token；光标后的 # 不影响。
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			// 没有 #token 时完全交回当前 provider。
			const token = extractIssueToken(textBeforeCursor);
			// token 为空串（单独 #）仍是有效 token，不属于 undefined。
			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			// getIssues 首次调用会启动 gh，后续复用同一个 Promise。
			const issues = await getIssues();
			// 等待期间被取消、没有数据或没有 issue 时交回当前 provider。
			if (options.signal.aborted || !issues || issues.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			// 过滤得到补全项；这里不检查 signal，因为过滤是纯本地同步操作。
			const suggestions = filterIssues(issues, token);
			// 没有匹配项时也交回当前 provider，避免吞掉其他补全来源。
			if (suggestions.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			// prefix 是已经输入的 #token；当前 provider 用它替换文本。
			return {
				items: suggestions,
				prefix: `#${token}`,
			};
		},

		// 应用补全交给当前 provider；item.value 已包含 #。
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		// 是否触发文件补全也委托；当前 provider 没实现时默认 true。
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

// 扩展入口：每个会话解析 GitHub 仓库、预取 issue 并注册补全 provider；加载时不调用 gh。
export default function (pi: ExtensionAPI): void {
	// session_start 在启动/恢复/分叉/新会话时触发；旧 provider 的清理由 UI 生命周期处理。
	pi.on("session_start", async (_event, ctx) => {
		// git remote -v 显式使用 ctx.cwd；解析失败就不注册 provider。
		const resolvedRepo = await resolveGitHubRepo(pi, ctx.cwd);
		// 解析失败时通知一次；错误可能是“不是 git 仓库”或“没有 GitHub 远端”。
		if (!resolvedRepo.ok) {
			// 直接 return，不注册补全；会话其余功能不受影响。
			ctx.ui.notify(resolvedRepo.error, "error");
			return;
		}

		// 保存 owner/repo；后续 gh 命令用 --repo 指定它。
		const repo = resolvedRepo.repo;
		// Promise 缓存：首次 getIssues 或预取启动 gh，后续复用；undefined 表示尚未启动。
		let issuesPromise: Promise<GitHubIssue[] | undefined> | undefined;
		// 每个会话最多显示一次加载错误；避免每次按键都弹通知。
		let loadErrorShown = false;

		// 懒加载函数：返回 issue 数组或 undefined；不抛异常给补全 provider。
		const getIssues = async (): Promise<GitHubIssue[] | undefined> => {
			// ||= 只在 issuesPromise 为 falsy 时赋值；Promise 对象总是 truthy。
			issuesPromise ||= (async () => {
				// gh 未安装/未登录/仓库不可访问都会以非零 code 返回，而不是抛错。
				const result = await pi.exec(
					// 参数分开传，避免 shell 拼接；--limit 用字符串化后的 100。
					"gh",
					[
						"issue",
						"list",
						"--repo",
						repo,
						"--state",
						"open",
						"--limit",
						String(MAX_ISSUES),
						"--json",
						"number,title,state",
					],
					// 显式 cwd 和 5s timeout；timeout 到期时 code 非零。
					{ cwd: ctx.cwd, timeout: 5_000 },
				);
				// 失败时记录一次错误通知，然后缓存 undefined。
				if (result.code !== 0) {
					// loadErrorShown 防止重复通知；后续 getSuggestions 只会静默交回当前 provider。
					if (!loadErrorShown) {
						loadErrorShown = true;
						// 优先显示 stderr，为空时用 exit code；stderr 可能包含 gh 的认证提示。
						const details = result.stderr.trim() || `exit code ${result.code}`;
						ctx.ui.notify(`github-issue-autocomplete: failed to load issues: ${details}`, "error");
					}
					return undefined;
				}

				// JSON.parse 只保证语法正确，不保证是 GitHubIssue[]；下面的断言不做运行时校验。
				try {
					// as 断言是信任边界：gh 输出格式变化时，字段可能缺失/类型错误。
					return JSON.parse(result.stdout) as GitHubIssue[];
				} catch {
					// 解析失败时同样只通知一次并返回 undefined。
					if (!loadErrorShown) {
						loadErrorShown = true;
						ctx.ui.notify("github-issue-autocomplete: failed to parse gh issue list output", "error");
					}
					return undefined;
				}
			})();
			return issuesPromise;
		};

		// 预取一次，让首次输入 # 时少等 gh；失败通知会在后台出现。
		void getIssues();
		// 注册 provider 工厂；当前 provider 在每次调用时传入，包装器立即生效。
		ctx.ui.addAutocompleteProvider((current) => createIssueAutocompleteProvider(current, getIssues));
	});
}
