// 验证压缩相关的UI展示、事件分发与排队意图，不在此真正生成摘要或调用模型；六例使用原型方法和内存替身。
// Usage只作类型导入，描述token与费用记录，运行时不会凭类型校验或计费。
import type { Usage } from "@earendil-works/pi-ai";
// Container是实际内存组件容器，只有首例会把提示组件渲染成字符串，不连接真实终端。
import { Container } from "@earendil-works/pi-tui";
// Vitest提供分组/断言/test以及vi.fn调用记录，后者代替会话、UI和异步入口。
import { describe, expect, test, vi } from "vitest";
// SessionEntry是带type标签的持久化条目联合类型；此文件手写数据，不读取JSONL会话。
import type { SessionEntry } from "../src/core/session-manager.ts";
// 取真实类的prototype借用方法；不new InteractiveMode，避免初始化工具、主题/Git观察器或界面。
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
// 首例初始化全局dark主题，默认不watch；颜色能力冷态可能探测tmux，受控命令用PI_HYPERLINKS=0短路。
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
// 去除本地正则可识别的ANSI序列以检查提示文字，不是证明屏幕布局或任意控制字符已安全净化。
import { stripAnsi } from "../src/utils/ansi.ts";

// 注册六条压缩UI回归；describe只定义用例，具体假对象与调用在test回调执行时产生。
describe("InteractiveMode compaction events", () => {
	// 分别添加压缩/分支摘要费用，验证共用设置控制显示及0.125到两位小数的展示；禁用分支只直接测压缩种类。
	test("uses the cache miss notice setting for compaction and branch summary costs", () => {
		// 本例手写用量满足Usage类型；费用显示取cost.total，不能把这些值当真实账单。
		const usage: Usage = {
			// 普通输入token记录；这里只提供计数，不向服务端复核。
			input: 10,
			// 摘要输出token记录，与压缩前整段历史的tokensBefore不同。
			output: 20,
			// 缓存读取token也计入此费用提示的四项总和。
			cacheRead: 30,
			// 缓存写入token同样计入显示总数；不是这段测试真的写入了模型缓存。
			cacheWrite: 40,
			// 保存totalTokens字段，但当前费用提示实际相加四分类数，样本恰与这个总数相等。
			totalTokens: 100,
			// 成本对象保留四项明细与total；提示直接采用total，测试不校验它等于明细之和或真实费率。
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		// Reflect.get按名字取得私有原型方法，as仅声明测试侧函数类型；不校验成员存在或绑定this。
		const addCompactionCostNotice = Reflect.get(InteractiveMode.prototype, "addCompactionCostNotice") as (
			// this伪参数只约束.call的接收对象，不占用普通参数位置；只需聊天容器和设置开关。
			this: { chatContainer: Container; settingsManager: { getShowCacheMissNotices(): boolean } },
			// notice形状表示一次衍生的费用提示，不会作为新的SessionEntry落盘。
			notice: {
				// 固定type字面量区分费用提示与普通消息，不是模型role。
				type: "compaction_cost";
				// kind联合允许压缩与分支摘要两种标签，实际token计算共用逻辑。
				kind: "compaction" | "branch_summary";
				// usage沿用前面的记录引用，不会自动再向供应商查询用量。
				usage: Usage;
			},
			// 函数返回void，添加组件的副作用保留在this.chatContainer中。
		) => void;

		// 准备主题颜色；不是启动完整TUI或实际压缩。
		initTheme("dark");
		// 构造显示开启的最小上下文，实际方法通过.call读取这些字段。
		const enabled = {
			// 每个上下文新建容器，组件只在内存中保存。
			chatContainer: new Container(),
			// 设置回调固定true，允许添加两类费用组件；没有加载真实设置文件。
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		// 用enabled作this传压缩提示，真实方法追加Spacer与ThemedText，不直接写stdout。
		addCompactionCostNotice.call(enabled, { type: "compaction_cost", kind: "compaction", usage });
		// 第二次借用同一真实方法，向相同容器再添加分支摘要费用。
		addCompactionCostNotice.call(enabled, {
			// 这次仍是compaction_cost提示类型。
			type: "compaction_cost",
			// kind改为branch_summary，使显示前缀为Branch summary。
			kind: "branch_summary",
			// 属性简写复用同一usage，便于对照两个标签的格式。
			usage,
		});
		// 按120列内存渲染各组件，再连接行并去ANSI；ThemedText的构建回调会在此实际执行。
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		// toContain只要求文字片段存在；100来自四类token相加，0.13来自cost.total.toFixed(2)，不重新加各项成本。
		expect(output).toContain("Compaction: 100 tokens billed (~$0.13)");
		// 同样检查分支摘要标签；不要求完整输出只有这两行或组件恰出现一次。
		expect(output).toContain("Branch summary: 100 tokens billed (~$0.13)");

		// 另建禁用开关的上下文，确保不沿用已添加内容。
		const disabled = {
			// 从新空容器开始检查禁用分支。
			chatContainer: new Container(),
			// 固定false使真实费用方法立即返回，不创建留白或提示。
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		// 禁用状态下只调用compaction种类；没有在这一分支再调用branch_summary。
		addCompactionCostNotice.call(disabled, { type: "compaction_cost", kind: "compaction", usage });
		// 子组件数为0证明这次没有添加提示/Spacer，未检测真实屏幕或费用是否落盘。
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	// 检查条目转换后的参数顺序与元数据关联；renderSessionItems被替换，因此不是最终屏幕渲染测试。
	test("renders each compaction cost after its summary", () => {
		// 当前压缩样本使用100 token与0.1总费用，后面核费用值与摘要配对；实际沿用usage引用，但这些断言不单独核引用身份。
		const currentUsage: Usage = {
			// 普通输入token记录；这里只提供计数，不向服务端复核。
			input: 10,
			// 摘要输出token记录，与压缩前整段历史的tokensBefore不同。
			output: 20,
			// 缓存读取token也计入此费用提示的四项总和。
			cacheRead: 30,
			// 缓存写入token同样计入显示总数；不是这段测试真的写入了模型缓存。
			cacheWrite: 40,
			// 保存totalTokens字段，但当前费用提示实际相加四分类数，样本恰与这个总数相等。
			totalTokens: 100,
			// 成本对象保留四项明细与total；提示直接采用total，测试不校验它等于明细之和或真实费率。
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};
		// 较旧样本用10 token和0.01费用，方便区分两条摘要的费用归属。
		const previousUsage: Usage = {
			// 普通输入token记录；这里只提供计数，不向服务端复核。
			input: 1,
			// 摘要输出token记录，与压缩前整段历史的tokensBefore不同。
			output: 2,
			// 缓存读取token也计入此费用提示的四项总和。
			cacheRead: 3,
			// 缓存写入token同样计入显示总数；不是这段测试真的写入了模型缓存。
			cacheWrite: 4,
			// 保存totalTokens字段，但当前费用提示实际相加四分类数，样本恰与这个总数相等。
			totalTokens: 10,
			// 成本对象保留四项明细与total；提示直接采用total，测试不校验它等于明细之和或真实费率。
			cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
		};
		// 声明SessionEntry数组并按current、previous顺序放入，真实转换保持此输入顺序，不在这里重走父链或按时间排序。
		const entries: SessionEntry[] = [
			// 第一项是当前压缩条目对象，字段由下面的type标签收窄。
			{
				// compaction标签让转换器包装为压缩摘要消息，并在有usage时追加费用项。
				type: "compaction",
				// 条目id用于后面的消息对象→历史元数据Map，不是toolCallId。
				id: "current",
				// 记录逻辑父条目为previous；本例并不调用树遍历来按父链重排数组。
				parentId: "previous",
				// 持久化时间是ISO文字，后面元数据保留它；摘要消息自己的时间由转换器解析成毫秒。
				timestamp: "2025-01-02T00:00:00Z",
				// 摘要正文是手写current summary，不是本次测试调用模型产物。
				summary: "current summary",
				// 保留边界id为kept；此处转换单项时不解析这个id是否真存在。
				firstKeptEntryId: "kept",
				// 压缩前记录token数为200，与这次摘要请求计费用量不是同一指标。
				tokensBefore: 200,
				// 费用使用当前100 token那份记录，不在转换时重复计费。
				usage: currentUsage,
			},
			// 第二项是旧压缩条目，刻意放在current后，检查转换维持输入顺序。
			{
				// 旧条目也走compaction转换规则。
				type: "compaction",
				// 旧条目的独立id供元数据断言区分。
				id: "previous",
				// null表示这个示例的根父节点，不等于省略字段。
				parentId: null,
				// 旧条目的持久化时间文字，后续检查Map原样关联。
				timestamp: "2025-01-01T00:00:00Z",
				// 旧摘要正文便于断言它没有配上当前费用。
				summary: "previous summary",
				// 旧条目也写kept，但本例未构造保留消息或测试实际裁剪。
				firstKeptEntryId: "kept",
				// 旧压缩前token数是100，不等于旧摘要消耗10 token。
				tokensBefore: 100,
				// 关联较小的previousUsage，便于检查费用项配对。
				usage: previousUsage,
			},
		];
		// 把最终渲染入口替成spy；其余转换逻辑仍来自真实renderSessionEntries。
		const fakeThis = { renderSessionItems: vi.fn() };
		// 按名字借用真实私有转换方法，as只影响TS视图。
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			// typeof fakeThis取变量的静态类型，不在这里调用JS typeof检查对象。
			this: typeof fakeThis,
			// 普通参数是条目数组，省略真实方法可选options以走默认空对象。
			entries: SessionEntry[],
			// 该方法同步调用下游renderSessionItems并返回void，不等待模型或终端。
		) => void;

		// 用假对象作this运行真实转换；缺renderer时instanceof判断为false，不进入备用屏选区重置。
		renderSessionEntries.call(fakeThis, entries);

		// 检查spy至少一次收到下面三个参数；这个匹配不单独要求总调用次数为1。
		expect(fakeThis.renderSessionItems).toHaveBeenCalledWith(
			// 预期items数组顺序必须匹配四项，摘要用部分匹配而费用项用具体对象。
			[
				// objectContaining只要求role和当前摘要正文，允许时间/token等其他字段。
				expect.objectContaining({ role: "compactionSummary", summary: "current summary" }),
				// 当前费用紧跟当前摘要，usage为对应的100 token记录。
				{ type: "compaction_cost", kind: "compaction", usage: currentUsage },
				// 第三项是旧摘要的部分匹配，不强行把它按日期排到前面。
				expect.objectContaining({ role: "compactionSummary", summary: "previous summary" }),
				// 旧费用紧跟旧摘要，使用previousUsage而非currentUsage。
				{ type: "compaction_cost", kind: "compaction", usage: previousUsage },
			],
			// 第二参数须为Map实例；其具体键值由下面断言继续检查。
			expect.any(Map),
			// 第三参数须匹配默认空选项对象，不开启历史回填或页脚更新。
			{},
		);
		// 取首次spy调用的前两个参数，解构和as元组只帮助TS，不运行校验或复制对象。
		const [items, messageMeta] = fakeThis.renderSessionItems.mock.calls[0] as [
			// 第一项声明为unknown数组，保留实际消息引用用于Map查找。
			unknown[],
			// 第二项是对象身份键Map，值有条目id与持久化时间；不是按消息文字作键。
			Map<unknown, { id: string; timestamp: string }>,
		];
		// 用当前摘要对象本身作键取元数据，检查与current条目对应。
		expect(messageMeta.get(items[0])).toEqual({ id: "current", timestamp: "2025-01-02T00:00:00Z" });
		// 用第三项旧摘要对象取元数据，确认previous归属，未检查费用项也在Map中。
		expect(messageMeta.get(items[2])).toEqual({ id: "previous", timestamp: "2025-01-01T00:00:00Z" });
	});

	// 发一个成功的手动压缩结束事件，检查旧保留条目交给重画、新摘要和费用另交追加入口；未实际生成或持久化摘要。
	test("renders retained entries and appends the latest summary cost at the bottom", async () => {
		// 事件费用样本固定100 token、0.125总费用，交给spy时保留同一usage引用。
		const usage: Usage = {
			// 普通输入token记录；这里只提供计数，不向服务端复核。
			input: 10,
			// 摘要输出token记录，与压缩前整段历史的tokensBefore不同。
			output: 20,
			// 缓存读取token也计入此费用提示的四项总和。
			cacheRead: 30,
			// 缓存写入token同样计入显示总数；不是这段测试真的写入了模型缓存。
			cacheWrite: 40,
			// 保存totalTokens字段，但当前费用提示实际相加四分类数，样本恰与这个总数相等。
			totalTokens: 100,
			// 成本对象保留四项明细与total；提示直接采用total，测试不校验它等于明细之和或真实费率。
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		// 构造最新压缩条目，放在buildContextEntries返回数组的第一项，模拟真实模型上下文中摘要前置。
		const latestCompaction: SessionEntry = {
			// type标签让首条目满足handleEvent的compaction检查。
			type: "compaction",
			// 最新条目id只用于示例身份，本例不写会话文件。
			id: "latest",
			// 父id指旧压缩，fake buildContextEntries不会真正沿父链计算。
			parentId: "previous",
			// 持久化时间作为样本；新显示摘要使用事件处理时的当前时间，断言没有比它。
			timestamp: "2025-01-02T00:00:00Z",
			// 手写已生成摘要，事件也传同一文字。
			summary: "summary",
			// 保留边界kept只是示例数据，假buildContextEntries不解析它。
			firstKeptEntryId: "kept",
			// 压缩前token数123用于后面的消息部分匹配。
			tokensBefore: 123,
			// 属性简写关联本例usage费用记录。
			usage,
		};
		// 再放一份旧压缩作为要保留并交给重画入口的条目；本例不构造完整真实历史。
		const previousCompaction: SessionEntry = {
			// 旧条目同样为compaction，不是聊天消息。
			type: "compaction",
			// 旧条目身份previous。
			id: "previous",
			// 示例根的parentId为null。
			parentId: null,
			// 旧持久化时间文字只作为样本字段保存。
			timestamp: "2025-01-01T00:00:00Z",
			// 旧摘要正文与新摘要不同，便于辨认传参。
			summary: "previous summary",
			// 旧保留边界同为kept，本例不验证目标存在。
			firstKeptEntryId: "kept",
			// 旧记录压缩前token数100，不参与本例新事件消息的123断言。
			tokensBefore: 100,
			// 旧记录复用这份usage；这里没有独立模拟旧费用结算。
			usage,
		};
		// 组装仅支持当前成功分支的假this；所有UI/会话动作都替成内存函数，不是完整InteractiveMode。
		const fakeThis = {
			// true绕过handleEvent开头的真实init，避免启动终端、资源或工具。
			isInitialized: true,
			// 页脚invalidate只记调用，不读真实模型或统计。
			footer: { invalidate: vi.fn() },
			// 程序状态事件入口也只记参数，不操作真实终端状态。
			programStatus: { handleEvent: vi.fn() },
			// 带as的undefined保留“函数或undefined”联合类型；本例不恢复旧Escape回调。
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			// 保留原测试的旧loader字段，但当前成功分支实际不读取它，不为注释删除旧字段。
			autoCompactionLoader: undefined,
			// 空编辑器对象足够，因为Escape备份是undefined，恢复分支不访问onEscape。
			defaultEditor: {},
			// 状态容器clear是备用spy；本例真正的状态清理由clearStatusIndicator替身承接。
			statusContainer: { clear: vi.fn() },
			// 聊天clear只记录清空请求，不模拟屏幕或组件树。
			chatContainer: { clear: vi.fn() },
			// 固定返回[最新,旧]上下文顺序，隔离真正SessionManager裁剪逻辑；真实handler会取slice(1)。
			sessionManager: { buildContextEntries: vi.fn().mockReturnValue([latestCompaction, previousCompaction]) },
			// 记录剩余条目的重画参数，不在本例执行完整条目渲染。
			renderSessionEntries: vi.fn(),
			// 记录新摘要的追加，不创建真正的摘要组件。
			addMessageToChat: vi.fn(),
			// 记录费用通知对象，不在本例渲染费用文字。
			addCompactionCostNotice: vi.fn(),
			// 错误显示替身为其他分支准备，本次成功样本不走它。
			showError: vi.fn(),
			// 普通状态提示也是替身，不追加真实组件。
			showStatus: vi.fn(),
			// 状态指示器清理入口用spy，不触发计时器或dispose。
			clearStatusIndicator: vi.fn(),
			// 队列刷新入口立即兑现undefined；真实handler用void调用它，await handler不保证任何真实后台刷新都已完成。
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			// 关终端进度分支，因此这次不要求setProgress(false)；不影响默认的成功摘要路径。
			settingsManager: { getShowTerminalProgress: () => false },
			// 渲染与终端进度均只记调用，不访问TTY。
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		// 借真实事件处理方法，下面函数类型只描述本例要传的compaction_end事件。
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			// 接收者类型取fakeThis，this伪参数不会成为事件实参。
			this: typeof fakeThis,
			// 事件对象类型由下面字段约束，类型声明本身不发事件。
			event: {
				// 固定事件标签选择压缩结束分支，不执行压缩开始或模型调用。
				type: "compaction_end";
				// 原因联合容纳手动、阈值和溢出；本例实际只传manual。
				reason: "manual" | "threshold" | "overflow";
				// result字段在此类型中必有，但值可为undefined；有结果时带摘要与压缩前规模，其中usage?才表示可省字段。
				result: { tokensBefore: number; summary: string; usage?: Usage } | undefined;
				// aborted标记取消结果，本例设false才能进入成功结果路径。
				aborted: boolean;
				// willRetry传给刷新队列，决定后续排队策略，不表示此事件本身已经重试。
				willRetry: boolean;
				// 可选错误文字给失败分支；本例未传。
				errorMessage?: string;
			},
			// async事件处理返回Promise<void>，await只覆盖它自身等待的工作。
		) => Promise<void>;

		// 以fakeThis处理手工事件，等待当前handler完成；不是运行真实压缩生命周期。
		await handleEvent.call(fakeThis, {
			// 事件type选择compaction_end。
			type: "compaction_end",
			// 本例采用手动成功路径。
			reason: "manual",
			// 将已生成结果直接作为输入，不让测试产生摘要模型费用。
			result: {
				// 记录压缩前123 token，与usage摘要计费100 token区分。
				tokensBefore: 123,
				// 事件摘要文字与最新条目相同，测试不验证两者冲突时的行为。
				summary: "summary",
				// 属性简写带入费用记录。
				usage,
			},
			// 显式未取消，不检查取消文案。
			aborted: false,
			// 不待重试，之后要求刷新队列收到false。
			willRetry: false,
		});

		// 要求聊天清空入口恰一次，但fake不真的清屏或回收组件。
		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		// 只把slice(1)的旧条目交重画入口，避免最新摘要在该次重画中重复出现。
		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith([previousCompaction]);
		// 要求新消息追加入口恰调用一次，下面继续检查内容。
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		// 检查追加的摘要至少包含下方三个字段，允许额外时间等信息。
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			// objectContaining是部分匹配，不要求对象只有这三键。
			expect.objectContaining({
				// 摘要是应用层compactionSummary角色，不是原始assistant回答。
				role: "compactionSummary",
				// 保留事件中的压缩前token规模123。
				tokensBefore: 123,
				// 保留事件里的已生成摘要文字。
				summary: "summary",
			}),
		);
		// 费用入口收到完整的衍生通知对象；此条断言本身不核相对调用先后或屏幕位置。
		expect(fakeThis.addCompactionCostNotice).toHaveBeenCalledWith({
			// 通知类型固定compaction_cost。
			type: "compaction_cost",
			// 本例费用种类为compaction。
			kind: "compaction",
			// 带原usage记录，不重新计算或联网计费。
			usage,
		});
		// 检查刷新调用的willRetry为false；因为该入口被替换，未覆盖真实刷新完成、排队或失败恢复。
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	// 连续处理两次turn_start，检查workingVisible开/关对应的指示器动作；未真实运行同一个Agent或压缩恢复。
	test("updates the working state when the same agent run resumes after compaction", async () => {
		// 用新的假上下文收集两个事件的累计调用次数。
		const fakeThis = {
			// 绕过真实初始化，这两事件只处理显示状态。
			isInitialized: true,
			// 每次事件开头会调用页脚失效spy。
			footer: { invalidate: vi.fn() },
			// 每次事件也把事件交给程序状态spy。
			programStatus: { handleEvent: vi.fn() },
			// 当前没有活动working指示器，首次事件应请求显示；spy不会真的把该字段改为working。
			activeStatusIndicator: undefined,
			// 初始允许展示工作状态。
			workingVisible: true,
			// 记录显示指示器请求，不创建Loader或计时器。
			showWorkingStatusIndicator: vi.fn(),
			// 记录清指示器请求，初始不应调用。
			clearStatusIndicator: vi.fn(),
			// 开启终端进度分支，setProgress只由下面spy接收。
			settingsManager: { getShowTerminalProgress: () => true },
			// 渲染与进度都为内存替身，不发送真实终端控制串。
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		// 再按名字借事件方法，用窄事件签名测试turn_start分支。
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			// typeof只取假对象的静态类型作为this约束。
			this: typeof fakeThis,
			// 只有type字段的事件已足够触发这个分支，无需消息正文或会话。
			event: { type: "turn_start" },
			// 返回Promise<void>，外层await等待事件处理自身。
		) => Promise<void>;

		// 首次事件看到workingVisible=true且无working指示器，因此应显示工作状态。
		await handleEvent.call(fakeThis, { type: "turn_start" });

		// 至少一次请求进度true；未核实际终端是否展示或其他调用参数。
		expect(fakeThis.ui.terminal.setProgress).toHaveBeenCalledWith(true);
		// 显示入口恰一次，不代表已经建立真实指示器组件。
		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		// 本轮没有清除指示器。
		expect(fakeThis.clearStatusIndicator).not.toHaveBeenCalled();
		// 本轮请求重绘一次，spy不真的排帧。
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		// 改同一假对象为不展示工作状态，保留之前调用记录。
		fakeThis.workingVisible = false;
		// 第二次事件读取最新false，进入清理而非显示分支。
		await handleEvent.call(fakeThis, { type: "turn_start" });

		// 累计显示次数仍1，证明第二轮没有再次调用显示入口。
		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		// 累计清理次数变1，证明隐藏分支被执行。
		expect(fakeThis.clearStatusIndicator).toHaveBeenCalledTimes(1);
		// 累计重绘次数变2，两个事件各提出一次渲染请求。
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	// Regression test for #9340.
	// 回归#9340：无排队文字也应经Session.abort请求中止；只检查调用入口，不证明真实Agent已停止。
	test("routes interactive response aborts through AgentSession", () => {
		// async空abort替身记录调用并返回兑现Promise；这例不让真实会话取消任务。
		const abort = vi.fn(async () => {});
		// 最小UI假对象满足无队列的早返路径，因此不需要editor。
		const ui = {
			// clearAllQueues固定返回两个空数组，不执行真正清队列或保留模式合并。
			clearAllQueues: () => ({ steering: [], followUp: [] }),
			// 待发显示更新只记调用。
			updatePendingMessagesDisplay: vi.fn(),
			// 属性简写把abort spy放到session上，真实UI方法通过此入口请求取消。
			session: { abort },
		};
		// 借用恢复队列方法；本测试类型只列需要的abort选项，未列真实方法的其他可选字段。
		const restoreQueuedMessagesToEditor = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor") as (
			// this约束指向该ui假对象。
			this: typeof ui,
			// options?与内部abort?都可省略；显式true才在当前样本请求取消。
			options?: { abort?: boolean },
			// 真实方法同步返回恢复条数；此例没有断言应为0，只检查abort调用。
		) => number;

		// 无队列路径先更新显示再void调用abort，不会等待返回的Promise或读editor。
		restoreQueuedMessagesToEditor.call(ui, { abort: true });

		// 只检查abort恰一次，不验证完成时机、消息恢复或真实AgentSession的取消实现。
		expect(abort).toHaveBeenCalledOnce();
	});

	// 刷新一条steer消息时应向prompt保留streamingBehavior；标题称active run，但替身没有真正的运行状态，不证明忙碌Agent集成。
	test("preserves steering behavior when flushing into an active agent run", async () => {
		// 新假上下文仅用于这次非重试、非扩展、单条队列成功路径。
		const fakeThis = {
			// as const让mode保留steer字面量类型，运行时对象仍可改；文字是固定样本。
			compactionQueuedMessages: [{ text: "change direction", mode: "steer" as const }],
			// 会话方法均为spy，不构造AgentSession或模型请求。
			session: {
				// clearQueue供失败恢复路径，当前成功样本不应依赖它完成业务。
				clearQueue: vi.fn(),
				// prompt立即兑现undefined，没有运行真实流；真实刷新方法会给这个Promise挂catch。
				prompt: vi.fn().mockResolvedValue(undefined),
				// steer入口也是假Promise，供其他排队情况，单条首prompt不经这里直接调用。
				steer: vi.fn().mockResolvedValue(undefined),
				// followUp入口是另一种意图替身，本样本未使用。
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			// 固定false令所有检查都视为普通消息，不测试真正扩展命令识别。
			isExtensionCommand: vi.fn().mockReturnValue(false),
			// 记录待发显示刷新，实际不会创建UI组件。
			updatePendingMessagesDisplay: vi.fn(),
			// 记录失败显示，本次成功应未调用。
			showError: vi.fn(),
		};

		// 按名字借真实刷新逻辑，as声明窄测试函数类型，不进行运行参数验证。
		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			// this伪参数要求该假对象形状，不作为普通实参发送给函数。
			this: typeof fakeThis,
			// willRetry?允许省略，此例明确false选择首条prompt分支。
			options?: { willRetry?: boolean },
			// 返回Promise<void>；内部的首promptPromise没有被await到底，不能据此保证全部模型回答完成。
		) => Promise<void>;

		// 等待刷新方法自身完成；它先拍下队列并清空，再发首prompt，不执行真实会话队列。
		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		// 断言prompt至少一次收到原文字与steer选项，未证明真实会话正忙、也未检查后续多条顺序。
		expect(fakeThis.session.prompt).toHaveBeenCalledWith("change direction", { streamingBehavior: "steer" });
		// 深比较队列为空，确认已取走本例的一条；未覆盖拒绝后恢复或并发新提交。
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		// 本例没有调用错误展示入口，不等于所有异步队列失败路径都已验证。
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
