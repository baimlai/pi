// 设置读取器与公开JSON Schema共享的默认值；导出普通对象，不自动合并/保存用户设置，也不启动这些功能。
// 具体getter决定何时采用默认、是否校验配置；这里没有默认值的字段可能保持undefined或由环境/调用层另行决定。
import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS } from "@earendil-works/pi-ai/utils/retry";

/** Runtime defaults shared by settings accessors and the published JSON Schema. */
// 例如getCompactionSettings缺省时读下面的reserveTokens；schema中的default则只是文档元信息，单独构造schema不会填配置。
export const SETTINGS_DEFAULTS = {
	// 让请求层自动选择传输方式，而非在此固定HTTP或WebSocket。
	transport: "auto",
	// /share层按认证选择Radius或gist，常量本身不会上传会话。
	sessionShareDestination: "auto",
	// 中途引导消息逐条出队，具体注入时间由Agent循环决定。
	steeringMode: "one-at-a-time",
	// 后续排队消息也默认逐条处理，不与steering队列合并成同一种消息。
	followUpMode: "one-at-a-time",
	// 长会话自动压缩的启动默认；这里记录预算，不在本模块调用模型总结。
	compaction: {
		// 默认允许上层自动触发，显式手动压缩有自己的入口。
		enabled: true,
		// 给提示/回复留出的token预算，与历史保留量分别计算。
		reserveTokens: 16384,
		// 保留最近原文的近似token预算，不是最近20000轮。
		keepRecentTokens: 20000,
	},
	// 切换会话树分支时的摘要偏好，与常规压缩分别配置。
	branchSummary: {
		// 分支摘要请求预留的token预算。
		reserveTokens: 16384,
		// false表示不跳过“是否摘要”询问；true的语义是跳过且默认不摘要。
		skipPrompt: false,
	},
	// Agent整次失败回复的重试，与provider SDK内部单次请求重试分层。
	retry: {
		// 开启外层暂时故障重试，仍由错误分类决定哪些错误值得重试。
		enabled: true,
		// 最多额外重试3次，不含初始请求。
		maxRetries: 3,
		// 外层指数退避起点2秒，随后4秒/8秒等，另受最大等待限制。
		baseDelayMs: 2000,
		// 复用pi-ai外层退避上限，当前常量为60000毫秒，避免两处漂移。
		maxAgentDelayMs: DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
		// SDK/provider级重试单独配置，不把下列值当Agent最大等待。
		provider: {
			// 服务端要求重试的等待上限60秒，超出时的行为由请求层决定。
			maxRetryDelayMs: 60000,
		},
	},
	// 默认不隐藏界面中的思考块，不等于强制所有模型启用思考。
	hideThinkingBlock: false,
	// 默认不展示缓存成本/供应商恢复通知。
	showCacheMissNotices: false,
	// 默认不精简启动输出，也可由设置选择true或header。
	quietStartup: false,
	// 没有更高优先级决定且有受控资源时询问，不是所有目录都会无条件弹窗。
	defaultProjectTrust: "ask",
	// 更新后日志默认不折叠成摘要展示。
	collapseChangelog: false,
	// 安装/更新版本通知的默认偏好；读取常量不发网络数据。
	enableInstallTelemetry: true,
	// 分析数据分享默认关闭，和版本通知是两项设置。
	enableAnalytics: false,
	// 默认注册技能的/skill:name命令，不代表技能正文已经加载到模型上下文。
	enableSkillCommands: true,
	// 终端展示偏好，与发送给模型的图片处理设置images分开。
	terminal: {
		// 支持图片协议的终端可展示图片，协议探测另行负责。
		showImages: true,
		// 内联图片首选宽度60字符格，不是60像素。
		imageWidthCells: 60,
		// 内容变短时默认不额外清空余行；getter还有环境变量回退。
		clearOnShrink: false,
		// 默认不开OSC 9;4进度提示。
		showTerminalProgress: false,
	},
	// 发给模型的图片处理偏好，不直接控制终端是否显示图片。
	images: {
		// 默认允许图片处理层缩放新输入，具体限制也受模型元数据影响。
		autoResize: true,
		// 默认不阻止把图片传给模型。
		blockImages: false,
	},
	// 空编辑器双Escape默认打开会话树。
	doubleEscapeAction: "tree",
	// /tree默认采用default视图模式，实际筛选规则由会话树实现。
	treeFilterMode: "default",
	// 输入编辑器默认左右不加额外水平留白。
	editorPaddingX: 0,
	// 对话正文默认水平留白1，允许的设置值是0或1。
	outputPad: 1,
	// 补全菜单默认最多显示5项，列表仍可包含更多可滚动项。
	autocompleteMaxVisible: 5,
	// Markdown展示选项，不更改原始消息正文。
	markdown: {
		// 代码块缩进文字默认两个空格。
		codeBlockIndent: "  ",
		// Mermaid默认可在流式阶段渲染；这不保证图表语法合法或一定可渲染。
		mermaid: "streaming",
	},
	// 各类警告的默认显示开关。
	warnings: {
		// 默认允许Anthropic额外用量相关提示，实际触发条件由警告消费方判断。
		anthropicExtraUsage: true,
	},
	// codemode工具呈现策略，不在本文件执行脚本。
	codemode: {
		// on保留直接工具声明，并描述可由脚本调用的工具；only模式另由设置选择。
		mode: "on",
		// 内联工具声明估算token预算，不是模型整次请求或脚本运行的总预算。
		inlineBudget: 3000,
	},
	// 默认在流式期间使用预热策略；getter只接受用户层值，因为实际预热可能产生费用。
	cacheWarming: "streaming",
	// 交互界面默认全屏布局，不在这里切换终端缓冲区。
	tuiMode: "fullscreen",
	// 全屏退出默认留下transcript，而非仅恢复提示。
	fullscreenExitOutput: "transcript",
	// 滚动条由界面按auto模式决定显示。
	fullscreenScrollbar: "auto",
	// 全屏选中文本时默认启用复制偏好，实际剪贴板写入由界面执行。
	fullscreenCopyOnSelect: true,
	// 滚轮行数默认自动，数值配置的取整/限制由getter处理。
	fullscreenWheelScrollLines: "auto",
	// as const让TS保留字面量和只读属性类型；它不执行深冻结，运行时仍是普通嵌套对象。
} as const;
