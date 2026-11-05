// 这个模块把 gh API 的 issue 存进本地 JSON，再用词频启发式检索；只有 sync/gh 会启动外部命令，search 只读内存。
// Local copy of the repository's issues (the corpus), synced incrementally with the gh CLI, plus keyword search.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// 所有 GitHub 请求固定指向此仓库；正文上限按 JS 字符串的 UTF-16 长度计，不是 UTF-8 字节数。
export const REPO = "earendil-works/pi";
const MAX_BODY = 16_000;

// Issue 是开发期的对象形状：联合字面量约束 state；JSON.parse 后的 as 断言不会在运行时验证这些字段。
export interface Issue {
	number: number;
	// 标题和正文来自 GitHub；正文可能已在同步时截断。
	title: string;
	body: string;
	state: "open" | "closed";
	// null 表示 API 没有关闭原因；它不同于字段缺失。
	stateReason: string | null;
	// 标签已由 jq 从 GitHub 标签对象变成名称数组。
	labels: string[];
	author: string;
	// association 是 GitHub 的作者关联身份，不能直接当作当前代码权限。
	association: string;
	// 日期保留 ISO 字符串，用于下面的增量查询与字典序比较。
	createdAt: string;
	updatedAt: string;
	comments: number;
}

// Record<string, Issue> 表示用对象键索引 issue；数字编号访问对象时也会转成字符串。
interface CorpusFile {
	syncedAt: string;
	issues: Record<string, Issue>;
}

// Corpus 保存整个语料文件的路径和当前内存快照；private 只是 TypeScript 的访问限制。
export class Corpus {
	private path: string;
	private data: CorpusFile;

	// 构造器输入缓存文件路径与首次回溯天数，无返回；存在则同步读 JSON，否则构造回溯时间和空字典。
	// 例如 initialDays=2 表示首次 since 约为两天前；读取/解析异常会抛出，不在这里联网或写文件。
	constructor(path: string, initialDays: number) {
		// 保存路径供后续临时文件写入与重命名使用。
		this.path = path;
		// 三元表达式按文件是否存在选择加载或初始化，as CorpusFile 只告诉编译器如何看待解析结果。
		this.data = existsSync(path)
			? (JSON.parse(readFileSync(path, "utf8")) as CorpusFile)
			// 一天按 86,400,000 毫秒回溯；toISOString() 生成 UTC 时间，不按本地日历天对齐。
			: { syncedAt: new Date(Date.now() - initialDays * 86_400_000).toISOString(), issues: {} };
	}

	// getter 可像 corpus.syncedAt 读属性；返回已保存的同步水位，不发请求或重新计算时间。
	get syncedAt(): string {
		// 直接读取内存中的 ISO 字符串；例如新实例会返回构造器设定的回溯时间。
		return this.data.syncedAt;
	}

	// 按编号返回本地 issue 或 undefined，没有副作用；例如 get(12) 不会为缺失编号请求 GitHub。
	get(number: number): Issue | undefined {
		// 对象索引可能没有此键，所以返回类型明确包含 undefined。
		return this.data.issues[number];
	}

	// 返回所有 issue 的新数组；数组元素仍是原 Issue 对象，不进行深拷贝或排序。
	all(): Issue[] {
		// Object.values 取字典值；例如两个编号键得到两个 issue，调用者修改元素仍可能影响本地缓存。
		return Object.values(this.data.issues);
	}

	/** Fetch issues updated since the last sync. Returns the number of new or changed issues. */
	// 同步输入来自保存的 since 水位，返回本次收到的 issue 条数；分页调用 gh 后更新内存，再写临时文件并重命名。
	// 例如两页中有3条 issue 就计3，不比较旧内容是否实际变化；API、JSON或磁盘错误会使 Promise 拒绝，失败前内存可能已部分更新。
	async sync(): Promise<number> {
		// 把开始时间往前挪一分钟，给下次同步留重叠窗口；它不是本次请求的 since。
		const startedAt = new Date(Date.now() - 60_000).toISOString();
		// jq 字符串排除 pull request，投影API字段、把空正文变成空串并提取标签名；保留原表达式。
		const jq =
			'.[] | select(.pull_request == null) | {number, title, body: (.body // ""), state, stateReason: .state_reason, labels: [.labels[].name], author: .user.login, association: .author_association, createdAt: .created_at, updatedAt: .updated_at, comments}';
		// await 等待 gh 子进程完成；参数数组不经 shell 拼接。
		const out = await gh([
			"api",
			"-X",
			"GET",
			`repos/${REPO}/issues`,
			// 获取所有开关状态的条目，并从上一次成功保存的水位开始查更新时间。
			"-f",
			"state=all",
			"-f",
			`since=${this.data.syncedAt}`,
			// 每页100条，按更新时间升序，由 --paginate 拉取后续页。
			"-f",
			"per_page=100",
			"-f",
			"sort=updated",
			"-f",
			"direction=asc",
			"--paginate",
			"--jq",
			// 计数从零开始；循环按 jq 输出的一行一个 JSON 对象读取。
			jq,
		]);
		// 跳过只有空白的行，但保留非空 JSON 的原始内容供解析。
		let count = 0;
		// 解析后断言 Issue；没有 schema 校验，所以实际字段仍依赖 gh/jq 的输出。
		for (const line of out.split("\n")) {
			// 超过上限时替换正文并加截断标记，避免在整个语料里保留过大正文。
			if (!line.trim()) continue;
			// 以编号覆盖旧条目；重叠窗口带来的重复更新不会在字典中多存一份。
			const issue = JSON.parse(line) as Issue;
			// 每收到一条就加一，即使内容与旧条目相同也计数。
			if (issue.body.length > MAX_BODY) issue.body = `${issue.body.slice(0, MAX_BODY)}\n[truncated]`;
			this.data.issues[issue.number] = issue;
			// 只有所有输出行成功解析后才推进水位。
			count++;
		// 先把完整内存对象序列化到同目录 .tmp；目录必须已经存在。
		}
		// 用重命名替换目标文件，减少读者看到半个 JSON 的机会；这里没有额外 fsync 持久性保证。
		this.data.syncedAt = startedAt;
		// 返回接收条数，不包含总语料大小。
		writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data));
		renameSync(`${this.path}.tmp`, this.path);
		return count;
	}

// 输入查询、排除编号和最多结果数，返回按得分降序的本地匹配；不写文件、不联网。

// 例如查询 "bash timeout" 会去重分词，标题命中权重是正文的3倍；全语料都含某词时该词权重为0，可能没有结果。

	// 先做英文/标识符式分词，结果包含去重后的有效词。
	/** Keyword search over titles and bodies, ranked by inverse document frequency; title hits weigh more. */
	// 空词集直接返回空数组，避免做无意义的全库扫描。
	search(query: string, exclude: number, limit = 10): Issue[] {
		// 排除当前 issue，防止把自己作为重复候选。
		const terms = tokenize(query);
		// map 生成检索用的小写标题/正文对象，不改原文本。
		if (terms.length === 0) return [];
		// 保留整个小写查询作为短语奖励依据；这里不是分词后重新拼出的句子。
		const issues = this.all().filter((issue) => issue.number !== exclude);
		// 逐词计算权重；回调里的 term 是当前词。
		const docs = issues.map((issue) => ({ issue, title: issue.title.toLowerCase(), body: issue.body.toLowerCase() }));
		// df 是标题或正文中包含该子串的文档数，并非完整单词匹配次数。
		const phrase = query.toLowerCase().trim();
		// 加1平滑后取自然对数；越少文档含此词，权重越高。
		const weights = terms.map((term) => {
			const df = docs.filter((doc) => doc.title.includes(term) || doc.body.includes(term)).length;
			// 从每份文档开始构建得分对象，然后过滤、排序和截断。
			return Math.log((docs.length + 1) / (df + 1));
		});
		// 每篇得分先清零，再把各查询词的贡献累加。
		return docs
			// forEach 的 i 与 weights 同索引，闭包修改当前文档的 score。
			.map((doc) => {
				// 标题命中加三倍权重；! 是开发期非空断言，不是运行时检查。
				let score = 0;
				// 只有标题未命中时才加正文权重，因此同词两处命中也不重复加。
				terms.forEach((term, i) => {
					if (doc.title.includes(term)) score += 3 * weights[i]!;
					// 原查询超过8个 UTF-16 单元且完整短语出现时，把该篇总分翻倍。
					else if (doc.body.includes(term)) score += weights[i]!;
				// 临时对象把原 issue 与分数配对，供后面排序使用。
				});
				if (phrase.length > 8 && (doc.title.includes(phrase) || doc.body.includes(phrase))) score *= 2;
				// 零分和负分文档都丢弃。
				return { issue: doc.issue, score };
			// 比较器 b-a 使高分在前；不另设同分排序规则。
			})
			// 只保留开头 limit 条；slice 的负数等行为仍是原 JS 规则，未额外验证 limit。
			.filter((hit) => hit.score > 0)
			// 去掉内部 score，公开结果仍是原 issue 对象。
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((hit) => hit.issue);
	}

// 按同一作者且编号更小筛出“此前”issue，返回总数及 isActedOn 命中的数目；只读内存。

// 例如编号10的作者还提交过编号8，后者计 prior；这里按编号而非 createdAt 判断先后。

	// 两个条件都成立才保留；不统计当前编号或后来编号。
	/** How many issues the author filed before, and how many of those maintainers acted on. */
	// 第二次 filter 用下面的维护者关注启发式统计，不代表真实维护者操作审计。
	authorStats(issue: Issue): { prior: number; actedOn: number } {
		const prior = this.all().filter((other) => other.author === issue.author && other.number < issue.number);
		return { prior: prior.length, actedOn: prior.filter(isActedOn).length };
	}
}

// 输入 issue 返回布尔值，无副作用；任一条件为真就算 actedOn，例如仍 open 也会返回 true。

/** Open, fixed, or prioritized: a maintainer considered it worth working on. */
// 四个条件用 || 短路连接：打开、completed关闭、p0、p1 之一满足即可。
export function isActedOn(issue: Issue): boolean {
	return (
		issue.state === "open" ||
		issue.stateReason === "completed" ||
		issue.labels.includes("p0") ||
		issue.labels.includes("p1")
	);
}

// 输入 issue 和收件箱起始 ISO 时间，返回是否在收件箱；例如旧 issue 带 untriaged 也入箱，无副作用。

// ISO UTC 字符串按字典序比较创建时间，再用标签兜底；不会检查日期格式。
/** In the inbox: created since the inbox start, or still labeled `untriaged` (auto-closed by the issue gate and not reviewed yet). */
export function inInbox(issue: Issue, inboxSince: string): boolean {
	return issue.createdAt >= inboxSince || issue.labels.includes("untriaged");
// 把状态和四种关注标签组合成展示文字，无副作用；例如 closed/completed+p1 形成 closed:completed p1。
}

// 只留下白名单标签，filter 保留原顺序，不改变 issue.labels。

// 嵌套模板按有无 stateReason 加冒号后缀；open 时不展示关闭原因。
export function issueStatus(issue: Issue): string {
	// 有标签就以逗号连接追加，没有则只返回状态。
	const labels = issue.labels.filter((label) => ["p0", "p1", "no-action", "untriaged"].includes(label));
	const state = issue.state === "open" ? "open" : `closed${issue.stateReason ? `:${issue.stateReason}` : ""}`;
	return labels.length ? `${state} ${labels.join(",")}` : state;
// 停用词 Set 用于去掉常见英语与泛化issue词；只按下方精确小写字符串匹配。
}

const STOPWORDS = new Set(
	"the and for with that this from when not are was but can does doesn have into after before about pi's pi issue bug feature request support add allow should".split(
		" ",
	),
// 输入查询返回去重词数组，无副作用；例如 "The bash/bash error" 保留 bash/bash 与 error。
// 它只保留 ASCII 字母、数字和部分标点，中文查询不会按中文词义分词。
);

// 链式处理中每步返回新值：小写、切分、去首尾标点、过滤短词与停用词。

function tokenize(text: string): string[] {
	const terms = text
		// 允许路径和API常用的 _ . / : - 留在词内部，其他连续字符作为分隔符。
		.toLowerCase()
		// g 表示处理全部首尾标点段，内部标点不删除。
		.split(/[^a-z0-9_./:-]+/)
		// 至少3个 UTF-16 单元，且不在停用词集合内才留下。
		.map((term) => term.replace(/^[./:-]+|[./:-]+$/g, ""))
		// Set 去重，再用展开语法转回数组，保留首次出现顺序。
		.filter((term) => term.length >= 3 && !STOPWORDS.has(term));
	return [...new Set(terms)];
}

// 输入 gh 参数数组，返回完成后的 stdout Promise；会启动本机 gh，并收集全部输出到内存。

// 例如 gh(["api", ...]) 依赖现有 CLI 认证；启动失败或非零退出会拒绝，不在这里重试。

// Promise 的 resolve/reject 分别接到成功文本与错误事件/退出码。
export function gh(args: string[]): Promise<string> {
	// 不提供 stdin；stdout/stderr 用管道，由下面的 data 监听器持续读取。
	return new Promise((resolve, reject) => {
		// Buffer[] 分别累积二进制分块，最后统一按 UTF-8 解码，避免在字节中途切断多字节字符。
		const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		// 收到stdout分块就追加；箭头回调的 push 返回值不用于控制进程。
		const err: Buffer[] = [];
		// 错误流单独保存，成功时不返回 stderr。
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		// 无法启动等进程 error 直接拒绝该 Promise。
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		// close 等到进程退出且管道关闭后处理；code 也可能为 null，此时会进失败分支。
		child.on("error", reject);
		// 退出码0才拼接并解析stdout；成功不保证stdout一定是有效JSON。
		child.on("close", (code) => {
			if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
			// 错误包含前三项参数和去首尾空白的stderr，不附完整参数列表。
			else
				reject(new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${Buffer.concat(err).toString("utf8").trim()}`));
		});
	});
}
