// 交互界面页脚：把会话累计用量、当前上下文、目录/Git/会话名和扩展状态拼成2或3行。
// 上游TUI按宽度render；此组件只返回文字，Git监听由footerData提供者管理，不在这里启动watch或写终端。
// path函数按当前平台做文字路径运算，不访问磁盘/展开软链接。
import { isAbsolute, relative, resolve, sep } from "node:path";
// Component只约束render/invalidate接口；另外两个函数按可见终端列宽计量/裁剪，不能拿含ANSI的string.length替代。
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
// AgentSession仅类型导入；真实对象由构造传入，读会话不等启动模型。
import type { AgentSession } from "../../../core/agent-session.ts";
// 每帧可读取PI_EXPERIMENTAL是否精确为1，用于xp标记。
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
// 上下文用量对象允许tokens/percent为null表示压缩后暂未知。
import type { ContextUsage } from "../../../core/extensions/types.ts";
// 只读类型视图允许读Git缓存/扩展Map/提供商计数，不因此冻结原提供者。
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
// 累计器原地相加已有usage/cost，不向供应商查账或重算价格，也不按消息ID去重。
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
// 稳定theme代理在渲染时读取当前实际主题，需调用方先初始化。
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
// 把扩展状态压成单行文字，返回新字符串，无I/O/输入修改；例"a\nb\t c"变"a b c"。
// 实际只把CR/LF/TAB换空格、合并ASCII空格再trim；原英文所称other control characters过宽，ANSI/其他内部控制符不由此全面过滤。
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	// 链式调用每步返回新string，原text保持。
	return (
		text
			// 字符类仅匹配回车/换行/制表，g替换所有匹配。
			.replace(/[\r\n\t]/g, " ")
			// 只压缩连续普通空格，不把所有Unicode空白都在内部合并。
			.replace(/ +/g, " ")
			// trim去两端JS空白，非终端控制码净化器。
			.trim()
	);
}

/**
 * Format token counts for compact footer display.
 */
// 把token数缩成k/M展示字符串，无I/O/校验；例1234→1.2k、9999→10.0k、999999→1000k。
// 按原数所在区间选精度再四舍五入，边界可跨显示档；小数/负数/NaN并未在此被拒绝。
export function formatTokens(count: number): string {
	// 小于1000直接toString，包括原本的负数/小数，不强制整型。
	if (count < 1000) return count.toString();
	// 1000到9999附近除千保留一位小数，toFixed返回string。
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	// 一万到百万前取整k，可能显示1000k而不是改走M分支。
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	// 百万到千万前除百万保留一位小数。
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	// 其余按整数M显示；Infinity/NaN也沿JS格式化规则，不是业务输入校验。
	return `${Math.round(count / 1000000)}M`;
}

// 把确实位于home内的cwd缩成~路径，返回文字；例/home/u/x配/home/u→~/x，/home/u2不缩。
// resolve/relative只做路径文字运算，相对输入按当前进程cwd展开，不识别软链/文件是否存在。缺home或不在其内返回原cwd。
export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	// home为undefined或空串时不处理，不把空值resolve成当前目录。
	if (!home) return cwd;

	// 将cwd标准化为当前平台绝对路径文字。
	const resolvedCwd = resolve(cwd);
	// home同样标准化，便于判断目录边界。
	const resolvedHome = resolve(home);
	// 从home到cwd求相对路径，完全相同为空串。
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	// 后面合成是否位于home本身/子目录的布尔条件。
	const isInsideHome =
		// 空相对路径表示就是home。
		relativeToHome === "" ||
		// 否则拒绝..、../前缀和绝对结果，避免同前缀兄弟目录或Windows另一盘误缩。
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	// 不在home边界内保留输入写法，不强制返回resolvedCwd。
	if (!isInsideHome) return cwd;
	// 同目录用~，子目录用平台sep；Windows可以是反斜杠，不写死/。
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

// 最近一次统计结果及其缓存键；类型声明不主动计算或验证条目。
interface SessionStats {
	// 缓存所属会话对象身份，换实例即失效。
	session: AgentSession;
	// 会话ID也参与判断，防同对象切文件继续用旧结果。
	sessionId: string;
	// 当前树叶ID，null表示任何条目之前，不是某个实际根条目ID，也不同于undefined。
	leafId: string | null;
	// 条目计数，不是用户轮数或可见消息数。
	entryCount: number;
	// 限制上下文的模型仅按身份比较，unknown表示这里无需读其内部结构。
	limitsModel: unknown;
	// 所有已识别usage条目的累计结果。
	usageTotals: UsageTotals;
	// 文件顺序最近assistant的缓存读占prompt比例，不是全会话平均。
	latestCacheHitRate: number | undefined;
	// 当前投影上下文估计，可未提供；内部percent也可null。
	contextUsage: ContextUsage | undefined;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
// 实现Component的页脚对象：构造接会话/数据提供者，render生成行，setter只改显示状态。
// 例new FooterComponent(session,data).render(80)；累计用量含整个文件各分支，上下文占用则交会话的当前投影估算。
export class FooterComponent implements Component {
	// 初始显示(auto)标记；这是页脚偏好，不会在此调用压缩或改变会话设置。
	private autoCompactEnabled = true;
	// 保存真实会话引用，private是TS访问限制。
	private session: AgentSession;
	// 保存共享数据提供者，Git查询委托给它；首次读取分支仍可能由其间接读文件/执行git。
	private footerData: ReadonlyFooterDataProvider;
	// 统计缓存可尚未建立，?允许undefined。
	private sessionStats?: SessionStats;

	// 只保存两依赖，无文件/网络/监听；例会话切换时宿主也可调用setSession复用组件。
	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		// 保存会话引用，不复制历史。
		this.session = session;
		// 保存提供者引用，生命周期由上层管理。
		this.footerData = footerData;
	}

	// 换正在显示的会话，无返回/刷新；例会话选择后设置，下一帧统计按身份判断重算。
	// 不清提供者、不立即遍历新历史，若仍是同一对象则依赖其他缓存键变化。
	setSession(session: AgentSession): void {
		// 仅替换字段，缓存没有在此显式清空。
		this.session = session;
	}

	// 设置是否显示(auto)，无返回；例用户关闭自动压缩后宿主同步false，不在此执行压缩逻辑。
	setAutoCompactEnabled(enabled: boolean): void {
		// 只影响render的文字，未写settings。
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	// 保留组件失效入口但实现无操作，无返回；例如TUI广播invalidate不会清统计缓存/Git缓存。
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	// 本组件dispose无操作，无返回；Git watcher已归提供者负责，不能把调用它当整个会话资源释放。
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	/**
	 * Usage totals and context usage scan the whole session, and the footer renders on every frame.
	 * Entries are append-only and every append moves the leaf, so the results only change with the
	 * session, leaf, entry count, or the model whose context window applies.
	 */
	// 取得/重算统计缓存，返回共享SessionStats；先比会话对象/ID/叶/条目数/限制模型身份，全相同就复用。
	// 未命中才扫描getEntries全部分支累计，再求当前投影上下文；例如追加记录会改条目数，触发下帧重算。
	// 不调用模型/写历史；缓存依赖条目按约定追加且不原地改写，非通用内容哈希或每帧深比较。
	private getSessionStats(): SessionStats {
		// 取会话管理器，读身份/计数比复制所有条目更便宜。
		const sessionManager = this.session.sessionManager;
		// 当前条目数量排除头；计数变动参与缓存键。
		const entryCount = sessionManager.getEntryCount();
		// 会话文件ID可能在同一管理对象上改变。
		const sessionId = sessionManager.getSessionId();
		// 当前叶决定有效分支/投影，切分支也需失效。
		const leafId = sessionManager.getLeafId();
		// 虚拟模型优先最近物理模型，否则当前会话模型；这里只取身份。
		const limitsModel = this.session.routedModel?.model ?? this.session.model;
		// 保存现有缓存引用供本次比较。
		const cached = this.sessionStats;
		// 所有短路条件成立才复用，不只看叶或数组长度。
		if (
			// 先要求真有旧缓存，后面TS可安全读字段。
			cached &&
			// 真实会话实例严格相等。
			cached.session === this.session &&
			// 会话ID也相同。
			cached.sessionId === sessionId &&
			// 树叶指针相同，包括null。
			cached.leafId === leafId &&
			// 条目数相同，避免忽略独立用量等新增记录。
			cached.entryCount === entryCount &&
			// 限制模型引用相同，不按id文字比较。
			cached.limitsModel === limitsModel
		) {
			// 返回缓存对象本身，不扫描会话。
			return cached;
		}

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		// 新建零累计器，不在旧总数上再加一遍。
		const usageTotals = createUsageTotals();
		// 尚无assistant时缓存命中率undefined；后面按文件顺序覆盖。
		let latestCacheHitRate: number | undefined;

		// getEntries复制全文件除头条目，包含其他分支与压缩前消息，不仅模型当前可见消息。
		for (const entry of sessionManager.getEntries()) {
			// 独立usage条目（如预热）直接参与累计。
			if (entry.type === "usage") {
				// add原地改变usageTotals，不改变entry.usage。
				addUsageToTotals(usageTotals, entry.usage);
				// type和role联合收窄，只有assistant进入这条分支。
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				// 累计助手用量，不按stopReason在本页脚额外过滤。
				addUsageToTotals(usageTotals, entry.message.usage);

				// 另算这一助手记录的prompt分母，不用累计输入或总token数。
				const latestPromptTokens =
					// 普通输入+缓存读+缓存写，不把输出/思考再塞入prompt分母。
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				// 覆盖上次比例，所以最终是文件顺序最后assistant，不一定属于当前叶分支。
				latestCacheHitRate =
					// 分母正才用cacheRead/分母×100；全零设undefined，而非保留更早比例。
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
				// 工具结果也可能自带模型用量，有才累计。
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				// 只加保存的工具usage，不重新执行工具或探测账单。
				addUsageToTotals(usageTotals, entry.message.usage);
				// 摘要/压缩条目有usage才统计，其他类型跳过。
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				// 累计摘要消耗；历史仍保留不会因为压缩而从总费用删掉。
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		// 会话方法按当前分支/投影估算占用；压缩后没有有效新回复可能返回percent:null。
		const contextUsage = this.session.getContextUsage();
		// 整体替换缓存对象，同时保存这次用于判定的键。
		this.sessionStats = {
			// 当前会话引用。
			session: this.session,
			// 会话ID属性简写。
			sessionId,
			// 叶ID简写。
			leafId,
			// 计数简写。
			entryCount,
			// 限制模型引用简写。
			limitsModel,
			// 本次新累计器引用。
			usageTotals,
			// 最新助手比例值，允许undefined。
			latestCacheHitRate,
			// 当前投影上下文结果，不是全文件累计量。
			contextUsage,
		};
		// 返回刚保存缓存，后续同键复用。
		return this.sessionStats;
	}

	// 按终端列宽返回目录/统计及可选扩展状态行；读环境和提供者，真实Git getter首次可能间接读HEAD/同步git，不写终端或启动模型。
	// 流程：统计→路径/名字→左用量与右模型→按可见宽裁剪/对齐→状态排序；例80列时尽量保留左统计、放不下再裁右模型。
	// 上下文null显示?，完全undefined却按0.0%显示；this.autoCompactEnabled只显示文字，不开启压缩。错误由依赖/格式器向外传播。
	render(width: number): string[] {
		// 读取当前Agent状态以显示选定模型与思考级别。
		const state = this.session.state;
		// 解构共享统计结果，不在这里再加一次usage。
		const { usageTotals, latestCacheHitRate, contextUsage } = this.getSessionStats();
		// 窗口优先会话估计，其次state模型，最后0；??保留显式0。
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		// 未知null/undefined用0参与阈值判断，不将?按危险比例着色。
		const contextPercentValue = contextUsage?.percent ?? 0;
		// 只有percent精确null显示?；contextUsage缺省时undefined!==null，故显示0.0。
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		// HOME真值优先否则USERPROFILE；只缩路径文字，不访问用户目录。
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		// Add git branch if available
		// 委托提供者取Git分支；未缓存且已定位Git时读HEAD、必要时同步执行git，之后主要读缓存，不能把本调用当始终无IO。
		const branch = this.footerData.getGitBranch();
		// 真值分支名才显示。
		if (branch) {
			// 把分支名追加到路径一行，后面统一按宽度裁剪。
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		// 读会话名称，可能未设置。
		const sessionName = this.session.sessionManager.getSessionName();
		// 真值名称才加分隔符。
		if (sessionName) {
			// 名称原样拼接，不用下面扩展状态的单行净化器。
			pwd = `${pwd} • ${sessionName}`;
		}

		// Build stats line
		// 新数组逐项构造左侧统计，TS据push内容推断字符串元素。
		const statsParts = [];
		// 输入非零才显示↑；不是只接受正数的运行校验。
		if (usageTotals.input) statsParts.push(`↑${formatTokens(usageTotals.input)}`);
		// 输出非零显示↓。
		if (usageTotals.output) statsParts.push(`↓${formatTokens(usageTotals.output)}`);
		// 缓存读非零显示R。
		if (usageTotals.cacheRead) statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
		// 缓存写非零显示W。
		if (usageTotals.cacheWrite) statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
		// 累计曾有缓存读/写且最后助手比例已知才显示CH。
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			// 比例保留一位小数；可能不是全会话累计cacheRead除总prompt。
			statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}

		// Kimi Coding is subscription-backed despite using API-key authentication.
		// 判断成本是否需要订阅标记，有模型才询问认证快照。
		const usingSubscription = state.model
			? // Kimi按产品约定直接视订阅，其他提供商须runtime显式订阅OAuth条件，不把任意OAuth当订阅。
				state.model.provider === "kimi-coding" ||
				this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: // 无模型则false，不询问实际令牌。
				false;
		// 累计费用非零或订阅时显示费用，因此订阅即使0也显示。
		if (usageTotals.cost || usingSubscription) {
			// 美元三位小数并可加(sub)，沿用记录的估计成本，不查询真实账单。
			const costStr = `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			// 把费用项加入左侧统计。
			statsParts.push(costStr);
		}

		// Colorize context percentage based on usage
		// 稍后各分支必须给这个局部字符串赋值，类型声明不会生成默认文字。
		let contextPercentStr: string;
		// auto布尔只映为提示后缀。
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		// 组合占比/窗口文字，格式器将窗口也缩为k/M。
		const contextPercentDisplay =
			// 压缩后明确未知的?走专门样式。
			contextPercent === "?"
				? // 未知占比不显示百分号，但仍给已知窗口及auto标记。
					`?/${formatTokens(contextWindow)}${autoIndicator}`
				: // 已知占比包括0.0，追加百分号和窗口。
					`${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		// 严格大于90才用错误色，正好90仍走下一档。
		if (contextPercentValue > 90) {
			// error是主题颜色名，不因此阻止请求。
			contextPercentStr = theme.fg("error", contextPercentDisplay);
			// 严格大于70到90用warning。
		} else if (contextPercentValue > 70) {
			// 仅套字符串样式，无终端I/O。
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
			// 其余包括0和未知占比不额外加此色。
		} else {
			// 保持原展示串。
			contextPercentStr = contextPercentDisplay;
		}
		// 把上下文项追加到左统计数组。
		statsParts.push(contextPercentStr);
		// 每次读取实验开关，精确PI_EXPERIMENTAL=1才有。
		if (areExperimentalFeaturesEnabled()) {
			// 加dim分隔点和粗体warning的xp，仅界面提示。
			statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		// 用单空格连接各统计项，含ANSI码的string.length不等可见宽度。
		let statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		// 模型id真值优先，缺模型/空id显示no-model。
		const modelName = state.model?.id || "no-model";

		// 计算终端可见列数，跳过ANSI并计宽字符。
		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		// 左侧已超预算先单独裁，优先保存统计而非右模型。
		if (statsLeftWidth > width) {
			// 用...标记裁剪，实际裁剪规则交TUI。
			statsLeft = truncateToWidth(statsLeft, width, "...");
			// 裁完必须重算可见宽，不用裁前长度。
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		// 两侧都能放时至少留2列间隔，不是每种超窄情况都强行留2空格。
		const minPadding = 2;

		// Add thinking level indicator if model supports reasoning
		// 先以模型名作不含provider的右侧内容，let允许后面加思考/路由。
		let rightSideWithoutProvider = modelName;
		// 只有模型声明reasoning才显示选定模型的思考级别。
		if (state.model?.reasoning) {
			// 空/缺级别用off，||按真值而不是仅nullish。
			const thinkingLevel = state.thinkingLevel || "off";
			// 下行三元选择关闭文字或级别名。
			rightSideWithoutProvider =
				// off显式显示thinking off，其他只加级别，不是思考实际token数。
				thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}
		// A virtual model routes each request; show where the latest response went.
		// 取最近一次物理路由记录，和当前选定虚拟模型名字分开。
		const routed = this.session.routedModel;
		// 有路由记录才追加箭头。
		if (routed) {
			// 物理thinkingLevel真值才追加，字面off也是真值，会显示。
			const level = routed.thinkingLevel ? ` • ${routed.thinkingLevel}` : "";
			// 附实际模型id和该路由级别，不触发新一次路由。
			rightSideWithoutProvider += ` → ${routed.model.id}${level}`;
		}

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		// 初始右侧不用provider前缀。
		let rightSide = rightSideWithoutProvider;
		// 提供者数>1且有state模型，才尝试增加provider信息。
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			// !是非空断言，基于上行条件，不新增运行检查。
			rightSide = `(${state.model!.provider}) ${rightSideWithoutProvider}`;
			// 若加provider使最小2列间距超宽，舍弃该前缀。
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				// 恢复无provider版本，不删路由或思考信息。
				rightSide = rightSideWithoutProvider;
			}
		}

		// 最终右侧可见列宽。
		const rightSideWidth = visibleWidth(rightSide);
		// 两边加最小间距的总需求，非UTF-16长度。
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		// statsLine稍后由两种布局分支赋值。
		let statsLine: string;
		// 能完整放下则右对齐模型。
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			// 用剩余列数repeat空格；常规非负整数宽度由TUI传入，本层不验证任意数值。
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			// ANSI串相加不改变两侧文本内容。
			statsLine = statsLeft + padding + rightSide;
			// 总需求超宽时只给右侧剩余空间。
		} else {
			// Need to truncate right side
			// 扣左侧与最小间距算右侧预算，可非正。
			const availableForRight = width - statsLeftWidth - minPadding;
			// 必须还有正列数才尝试显示右侧。
			if (availableForRight > 0) {
				// 无ellipsis裁右侧，以免再多占列。
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				// 裁后重算宽度，因为宽字符不一定恰填预算。
				const truncatedRightWidth = visibleWidth(truncatedRight);
				// 用Math.max避免负空格数，再把剩余空间补满。
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				// 保留左统计，右显示截取后的模型信息。
				statsLine = statsLeft + padding + truncatedRight;
				// 完全没空间则不显示右侧。
			} else {
				// Not enough space for right side at all
				// 仅左统计，无强制空白占位。
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		// 单独给左统计加dim token；其中已有控制码原样保留，不通用修复嵌套ANSI重置。
		const dimStatsLeft = theme.fg("dim", statsLeft);
		// string.slice按代码单元切已知左串长度，拿padding+rightSide；这里不是按可见列切。
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		// 后半另套dim，避免依赖一个跨两段的外层弱化包装。
		const dimRemainder = theme.fg("dim", remainder);

		// 目录整行先dim再按列裁，ellipsis也取dim样式。
		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		// 前两行按顺序返回：目录/分支/名字行，再统计/模型行。
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		// Add extension statuses on a single line, sorted by key alphabetically
		// 读取共享只读Map，不复制/修改提供者保存的状态。
		const extensionStatuses = this.footerData.getExtensionStatuses();
		// 至少一条状态才加第三行，净化后全空也仍可能有一行。
		if (extensionStatuses.size > 0) {
			// entries转新数组，因此排序不改变原Map插入顺序。
			const sortedStatuses = Array.from(extensionStatuses.entries())
				// 解构只取键，按localeCompare升序，不按值排序。
				.sort(([a], [b]) => a.localeCompare(b))
				// 跳过键只取文字，按本文件有限单行规则处理，仍保留内部其他控制码。
				.map(([, text]) => sanitizeStatusText(text));
			// 各状态间一个空格，扩展颜色串不会在此额外统一套dim。
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			// 第三行同样按列裁；只有省略标记明确使用dim色。
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		// 返回行数组供TUI布局，不写stdout。
		return lines;
	}
}
