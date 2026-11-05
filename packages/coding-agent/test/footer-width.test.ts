// 验证页脚目录边界、宽字符/模型路由、累计费用、缓存与订阅标记；只有简化内存替身，不创建真实AgentSession/Git watcher。
// visibleWidth按终端可见列数断言，避免把ANSI和宽字符当普通代码单元。
import { visibleWidth } from "@earendil-works/pi-tui";
// Vitest分组/前置主题初始化/同步断言，没有本文件afterEach恢复先前主题。
import { beforeAll, describe, expect, it } from "vitest";
// 仅导入真实会话类型，下面以双重as强制扮演，不执行其构造或会话存储。
import type { AgentSession } from "../src/core/agent-session.ts";
// 只读提供者接口供结构检查；本例返回的函数都是内存替身，不启动Git探测。
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
// 真实待测页脚组件与~缩路径辅助。
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
// 初始化共享主题供render使用；false只禁主题watch，缺省system模式仍可首次探测TUI能力，可能同步查询tmux。
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
// 去ANSI后做文案包含检查，宽度断言则用原始带码字符串+visibleWidth。
import { stripAnsi } from "../src/utils/ansi.ts";

// 测试需要的最小usage形状，省略真实Usage其他字段，最终as掩盖了这些结构差异。
type AssistantUsage = {
	// 普通输入数。
	input: number;
	// 输出数。
	output: number;
	// 缓存读取数。
	cacheRead: number;
	// 缓存写入数。
	cacheWrite: number;
	// 只保留footer会读取的cost.total，不假造全部成本明细。
	cost: { total: number };
};

// 创建只供页脚读取的会话替身，输入必填会话名及可选模型/用量/订阅/路由，返回强制AgentSession视图。
// 流程：按给定usage造数组→构造状态/管理器/getContextUsage等函数→双重as；例usage.cost.total=.5使render显示$0.500。
// 无磁盘/网络/真实认证/分支投影；getEntries返回同一原数组，刻意不同于真实SessionManager的浅拷贝，不能照此push写真实历史。
function createSession(options: {
	// name必须传，空串表示不显示会话名。
	sessionName: string;
	// 模型ID可覆盖默认test-model。
	modelId?: string;
	// provider可覆盖默认test。
	provider?: string;
	// 是否在UI展示思考级别，不是真实模型能力探测。
	reasoning?: boolean;
	// 宽string便于测文案，不等真实ThinkingLevel联合验证。
	thinkingLevel?: string;
	// 可选助手用量。
	usage?: AssistantUsage;
	// 可选分支摘要用量。
	branchUsage?: AssistantUsage;
	// 可选压缩用量。
	compactionUsage?: AssistantUsage;
	// 可选工具结果用量。
	toolUsage?: AssistantUsage;
	// 控制替身isUsingSubscription返回值，不构造真实OAuth凭据。
	usingSubscription?: boolean;
	// 简化物理路由对象只有id/可选级别，不满足真实Model全字段，后面as隐藏缺项。
	routedModel?: { model: { id: string }; thinkingLevel?: string };
	// 返回类型声明不把下面普通对象变成真实类实例。
}): AgentSession {
	// 本地保存可选助手用量引用。
	const usage = options.usage;
	// 新可变条目数组；Record<string,unknown>不限制为真实SessionEntry联合，便于造最小样本。
	const entries: Array<Record<string, unknown>> = [];

	// 显式给usage才造助手记录，undefined不造零记录。
	if (usage !== undefined) {
		// 往同一数组追加对象。
		entries.push({
			// type=message供页脚先收窄种类。
			type: "message",
			// 消息体只含role/usage，不含真实助手正文等必需字段。
			message: {
				// role=assistant进入页脚模型用量分支。
				role: "assistant",
				// 用量引用原样保存，不深复制。
				usage,
			},
		});
	}

	// 可选分支摘要记录单独保存，模拟额外摘要消耗。
	if (options.branchUsage !== undefined) {
		// 追加第二种形状条目。
		entries.push({
			// branch_summary使页脚识别为摘要。
			type: "branch_summary",
			// 采用选项里的摘要usage。
			usage: options.branchUsage,
		});
	}

	// 压缩usage存在则也模拟压缩条目。
	if (options.compactionUsage !== undefined) {
		// 同一entries追加记录。
		entries.push({
			// type=compaction，不执行任何压缩模型。
			type: "compaction",
			// 只给页脚累计所需usage，不造真实摘要正文。
			usage: options.compactionUsage,
		});
	}

	// 工具usage存在才造工具结果。
	if (options.toolUsage !== undefined) {
		// 追加message条目外壳。
		entries.push({
			// 同为message但role决定不是助手分支。
			type: "message",
			// 工具消息体的最小视图。
			message: {
				// role=toolResult使页脚选择工具用量分支。
				role: "toolResult",
				// 引用工具usage，不执行工具。
				usage: options.toolUsage,
			},
		});
	}

	// 普通对象包含footer实际会读的子接口，未new AgentSession。
	const session = {
		// Agent state的最小视图。
		state: {
			// 模型只放在state.model；没有真实session.model getter，双重断言也不会补它。
			model: {
				// ??保留显式空串，只有undefined才用test-model。
				id: options.modelId ?? "test-model",
				// provider同样默认test。
				provider: options.provider ?? "test",
				// 数字分隔符_只为阅读，值是200000。
				contextWindow: 200_000,
				// reasoning默认false，显式false保留。
				reasoning: options.reasoning ?? false,
			},
			// 思考级别默认off，只给UI文案。
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		// 用对象模拟sessionManager，不建文件或索引Map。
		sessionManager: {
			// 返回原数组引用，和生产实现返回浅拷贝不同；下方push回归例因此能改变mock记录。
			getEntries: () => entries,
			// 返回当前数组长度，使mock追加能使缓存键失效。
			getEntryCount: () => entries.length,
			// 固定会话ID，不验证同对象切真实会话的情形。
			getSessionId: () => "test-session",
			// null表示在任何条目之前，本例不建真实父子分支。
			getLeafId: () => null,
			// 读创建时options引用的名称。
			getSessionName: () => options.sessionName,
			// 固定cwd只是展示文字，不在/tmp/project创建文件。
			getCwd: () => "/tmp/project",
		},
		// 固定12.3%与200k窗口，不运行真实当前投影估算，也没补tokens字段。
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		// 保存可选路由引用供UI显示。
		routedModel: options.routedModel,
		// 认证运行时也是最小替身。
		modelRuntime: {
			// 直接按选项布尔返回，不验证真实Provider是否OAuth/显式订阅。
			isUsingSubscription: () => options.usingSubscription ?? false,
		},
	};

	// 先转unknown再转目标类型绕过结构差异，运行对象/原型都不改变。
	return session as unknown as AgentSession;
}

// 创建无I/O页脚数据替身，输入提供商数量、返回结构兼容接口；例2使UI尝试显示provider前缀。
// 固定main与空状态，没有真正Git读取/文件监听；onBranchChange只收而不执行回调，返回空取消函数。
function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	// 本地对象由TS按下面真实属性推断。
	const provider = {
		// 每次直接main，不做首读HEAD或Git命令。
		getGitBranch: () => "main",
		// 每次新空Map，与真实提供者返回共享状态Map不同；此文件不测试第三行扩展状态。
		getExtensionStatuses: () => new Map<string, string>(),
		// 捕获providerCount，不扫描Models注册表。
		getAvailableProviderCount: () => providerCount,
		// 订阅签名接回调但这个替身不建立事件源。
		onBranchChange: (callback: () => void) => {
			// void只忽略变量值，不是调用callback。
			void callback;
			// 返回无操作解除函数，也没有资源要关闭。
			return () => {};
		},
	};

	// 结构满足只读接口即可返回，不需要as补原型。
	return provider;
}

// 两个路径样本验证home目录边界，输入是POSIX文字，不涵盖所有Windows/软链行为。
describe("formatCwdForFooter", () => {
	// /home/user2仅文字前缀相同，应保留，不能变~2。
	it("does not abbreviate sibling paths that share the home prefix", () => {
		// 比较真实辅助输出与原cwd文字。
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	// home自身与其子目录分别缩成~和~/project。
	it("abbreviates the home directory and descendants", () => {
		// 完全相同路径输出~。
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		// 子目录前加~及当前平台sep；这里预期样本写POSIX分隔符。
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

// 九例UI统计/宽度回归，使用上面最小session/provider替身。
describe("FooterComponent width handling", () => {
	// 本组开始前初始化主题一次，不对每例恢复此前全局Theme。
	beforeAll(() => {
		// undefined取默认system，false不开文件watch；仍是实际配色生成路径。
		initTheme(undefined, false);
	});

	// 长韩文会话名场景检查所有返回行不超93可见列，不要求具体截断字符。
	it("keeps all lines within width for wide session names", () => {
		// 设固定列宽。
		const width = 93;
		// repeat30拼60个韩文字，不是真实历史文件名或用户输入。
		const session = createSession({ sessionName: "한글".repeat(30) });
		// 新footer接内存session和只有一个provider的数据。
		const footer = new FooterComponent(session, createFooterData(1));

		// 真实render生成带ANSI行数组，不实际绘屏。
		const lines = footer.render(width);
		// 逐行验证，不只看统计第二行。
		for (const line of lines) {
			// 允许不足width，未要求每行刚好填满。
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	// 宽模型/提供者+思考/用量场景，同样对所有行检宽。
	it("keeps stats line within width for wide model and provider names", () => {
		// 预算60列比上例窄。
		const width = 60;
		// 准备这个案例独立会话视图。
		const session = createSession({
			// 空会话名减少目录行附加字段。
			sessionName: "",
			// 30个汉字通常各两列，测试按真实visibleWidth处理。
			modelId: "模".repeat(30),
			// 韩文provider文字，用于有空间才显示的前缀。
			provider: "공급자",
			// 允许显示思考级别。
			reasoning: true,
			// 指定high文案，不调用模型思考。
			thinkingLevel: "high",
			// 构造一份累计助手用量。
			usage: {
				// 12345输入用于k缩写。
				input: 12_345,
				// 6789输出用于另一个统计项。
				output: 6_789,
				// 本例无缓存读取。
				cacheRead: 0,
				// 无缓存写入，因而不显示CH。
				cacheWrite: 0,
				// 费用1.234将保留三位小数。
				cost: { total: 1.234 },
			},
		});
		// 两个provider让UI尝试加入前缀，放不下可主动舍弃。
		const footer = new FooterComponent(session, createFooterData(2));

		// 生成60列预算的结果。
		const lines = footer.render(width);
		// 逐行检查实际返回。
		for (const line of lines) {
			// 只断言不超宽，不证明provider一定可见或固定被裁方式。
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	// 验证虚拟模型右侧追加最近物理模型与独立级别，不真的路由模型请求。
	it("shows the physical model a virtual model routed to", () => {
		// 造带routedModel选项的替身。
		const session = createSession({
			// 无会话名。
			sessionName: "",
			// 当前选定模型名auto。
			modelId: "auto",
			// 让当前auto的high级别显示。
			reasoning: true,
			// 虚拟层级为high。
			thinkingLevel: "high",
			// 物理层是另一固定id/medium，缺真实Model其他字段由as绕过。
			routedModel: { model: { id: "gpt-5.6-luna" }, thinkingLevel: "medium" },
		});
		// 单provider避免额外前缀干扰子串。
		const footer = new FooterComponent(session, createFooterData(1));

		// 取第2行，再去ANSI便于检查文案；下标1不代表数组第三行。
		const statsLine = stripAnsi(footer.render(120)[1]);

		// Unicode转义是分隔点/箭头，要求该路由组合子串出现，不比较整行空格。
		expect(statsLine).toContain("auto \u2022 high \u2192 gpt-5.6-luna \u2022 medium");
	});

	// 助手/分支摘要/压缩/工具四类费用相加为1.25，验证页脚不是只统计助手。
	it("includes summary and tool result usage in the total cost", () => {
		// 新会话视图供本例独立累计。
		const session = createSession({
			// 仍不加会话名。
			sessionName: "",
			// 普通助手用量字段。
			usage: {
				// 助手输入100。
				input: 100,
				// 助手输出10。
				output: 10,
				// 助手无缓存读。
				cacheRead: 0,
				// 助手无缓存写。
				cacheWrite: 0,
				// 助手费用0.5。
				cost: { total: 0.5 },
			},
			// 分支摘要用量不是新模型调用，只是fixture记录。
			branchUsage: {
				// 摘要输入20。
				input: 20,
				// 摘要输出5。
				output: 5,
				// 摘要无缓存读。
				cacheRead: 0,
				// 摘要无缓存写。
				cacheWrite: 0,
				// 摘要费用0.25。
				cost: { total: 0.25 },
			},
			// 压缩条目也带usage，不在测试里真的总结上下文。
			compactionUsage: {
				// 压缩输入5。
				input: 5,
				// 压缩输出2。
				output: 2,
				// 压缩无缓存读。
				cacheRead: 0,
				// 压缩无缓存写。
				cacheWrite: 0,
				// 压缩费用0.125。
				cost: { total: 0.125 },
			},
			// 工具结果中额外模型用量。
			toolUsage: {
				// 工具输入15。
				input: 15,
				// 工具输出3。
				output: 3,
				// 工具无缓存读。
				cacheRead: 0,
				// 工具无缓存写。
				cacheWrite: 0,
				// 工具费用0.375，四项和1.25。
				cost: { total: 0.375 },
			},
		});
		// 构造真实Footer但依赖都是内存替身。
		const footer = new FooterComponent(session, createFooterData(1));

		// 宽120让成本文案有空间，去ANSI后取统计行。
		const statsLine = stripAnsi(footer.render(120)[1]);
		// 断言累计三位小数$1.250，不比较全部token数。
		expect(statsLine).toContain("$1.250");
	});

	// 用mock数组追加使计数变化，检查同一footer下一次render重算缓存。
	it("updates cached usage totals after an entry is appended", () => {
		// 一条共享usage费用.5，重复记录即重复计费，不去重。
		const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } };
		// 先包含一份助手记录。
		const session = createSession({ sessionName: "", usage });
		// 同一个Footer被两次渲染。
		const footer = new FooterComponent(session, createFooterData(1));
		// 初次应$0.500。
		expect(stripAnsi(footer.render(120)[1])).toContain("$0.500");

		// as never允许最小条目绕过类型；mock getEntries返原数组才会真的追加，生产getEntries浅拷贝不能照搬push。
		session.sessionManager.getEntries().push({ type: "message", message: { role: "assistant", usage } } as never);
		// mock计数增加让缓存失效，第二次应累计1.000。
		expect(stripAnsi(footer.render(120)[1])).toContain("$1.000");
	});

	// 一个固定assistant的cacheRead50/(input100+read50+write50)=25%，不是50%或全会话平均。
	it("shows the latest cache hit rate when cache usage is present", () => {
		// 新会话只放此用量。
		const session = createSession({
			// 无名称。
			sessionName: "",
			// 助手usage对象。
			usage: {
				// 普通输入100计入分母。
				input: 100,
				// 输出10不进缓存命中率分母。
				output: 10,
				// 缓存读50既进分子也进分母。
				cacheRead: 50,
				// 缓存写50只进分母。
				cacheWrite: 50,
				// 费用只是让费用项也正常显示。
				cost: { total: 0.001 },
			},
		});
		// 新footer确保无旧缓存。
		const footer = new FooterComponent(session, createFooterData(1));

		// 取宽120的统计行文字。
		const statsLine = stripAnsi(footer.render(120)[1]);
		// 期望保留一位小数的CH25.0%。
		expect(statsLine).toContain("CH25.0%");
	});

	// 即使替身订阅标志默认false，kimi-coding这个产品约定仍应加(sub)。
	it("marks Kimi Coding costs as subscription estimates", () => {
		// 创建Kimi提供者视图。
		const session = createSession({
			// 无名称。
			sessionName: "",
			// 精确provider字符串触发Kimi专门分支，不调用真实API key鉴权。
			provider: "kimi-coding",
			// 固定usage样本。
			usage: {
				// 普通输入100。
				input: 100,
				// 输出10。
				output: 10,
				// 无缓存读。
				cacheRead: 0,
				// 无缓存写。
				cacheWrite: 0,
				// 费用1.234。
				cost: { total: 1.234 },
			},
		});
		// providerCount1不增加前缀。
		const footer = new FooterComponent(session, createFooterData(1));

		// 断言成本带订阅标记，未验证真实订阅是否有效。
		expect(stripAnsi(footer.render(120)[1])).toContain("$1.234 (sub)");
	});

	// 显式订阅旗标true即使没有usage也显示零费用与(sub)。
	it("marks explicitly identified subscription auth", () => {
		// 以Anthropic为样本并让mock返回true，不创建OAuth凭据或请求认证。
		const session = createSession({ sessionName: "", provider: "anthropic", usingSubscription: true });
		// 新footer的累计器初始全零。
		const footer = new FooterComponent(session, createFooterData(1));

		// 订阅路径仍显示$0.000 (sub)，而非省掉费用项。
		expect(stripAnsi(footer.render(120)[1])).toContain("$0.000 (sub)");
	});

	// 标题提OAuth，但此fixture只给OpenRouter名称且订阅mock默认false，没有真实OAuth状态；检查不凭名称误加(sub)。
	it("does not mark generic OAuth sign-in as a subscription", () => {
		// 构造非Kimi且未标订阅的会话视图。
		const session = createSession({
			// 无名称。
			sessionName: "",
			// provider文字OpenRouter，不在测试中登录它。
			provider: "openrouter",
			// 普通用量。
			usage: {
				// 输入100。
				input: 100,
				// 输出10。
				output: 10,
				// 无缓存读。
				cacheRead: 0,
				// 无缓存写。
				cacheWrite: 0,
				// 非零费用保证仍有成本文案。
				cost: { total: 1.234 },
			},
		});
		// 单provider背景。
		const footer = new FooterComponent(session, createFooterData(1));
		// 去ANSI后拿统计行，便于两条包含断言。
		const stats = stripAnsi(footer.render(120)[1]);

		// 成本数字仍显示。
		expect(stats).toContain("$1.234");
		// 但不得出现订阅后缀，未覆盖真实OAuth Provider的识别实现。
		expect(stats).not.toContain("(sub)");
	});
});
