// 定义settings.json的公开规则并从中推导TS类型；schema生成器/测试会用它，SettingsManager读JSON时并不自动完整执行此schema。
// Type.*调用创建描述对象而非验证用户值；default/description/deprecated是元信息，不会在这里填值、显示警告或迁移旧字段。
import { type Static, type TSchemaOptions, Type } from "typebox";
import { ModelThinkingLevelSchema } from "./pi-ai-schemas.ts";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";

// 输入可选默认值选项，返回0到MAX_SAFE_INTEGER的整数schema，无I/O；例如压缩预算允许0，拒绝负数/小数/不安全整数。
// 默认参数{}在省略时创建选项对象，展开把default等选项附入规则；它不检查某个实际预算。
function nonNegativeSafeInteger(options: { default?: number } = {}) {
	// minimum/maximum都是包含边界，...options放最后；类型限制目前只公开default，不允许调用处修改边界。
	return Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, ...options });
}

// 输入可选schema元信息，返回非负数或字面量disabled的规则，用于两种超时字段，无I/O/计时器。
// 例如0、12.5、"disabled"可通过此规则，"30000"数字字符串不可；SettingsManager的实际解析器可接受后者，二者不是同一校验入口。
function timeoutSetting(options?: TSchemaOptions) {
	// Union生成anyOf，options加在整个联合上；这里没有要求整数或最大值。
	return Type.Union([Type.Number({ minimum: 0 }), Type.Literal("disabled")], options);
}

// 单模型压缩覆盖，两预算可分别省略；模型键的语法/存在性不在这个子对象里验证。
const CompactionModelOverrideSchema = Type.Object({
	// Type.Optional不把字段放进对象required列表；提供时仍须满足非负安全整数规则。
	reserveTokens: Type.Optional(nonNegativeSafeInteger()),
	// 近期原文预算可独立覆盖，不会因只改reserveTokens而强制同时提供它。
	keepRecentTokens: Type.Optional(nonNegativeSafeInteger()),
});

// 长会话压缩设置对象，默认值来自共享表；构造规则不实际请求模型总结。
const CompactionSettingsSchema = Type.Object({
	// 可选布尔自动压缩开关，default:true只是schema说明，getter另负责回退。
	enabled: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.compaction.enabled })),
	// 给上下文/输出留空的普通预算，要求非负安全整数。
	reserveTokens: Type.Optional(nonNegativeSafeInteger({ default: SETTINGS_DEFAULTS.compaction.reserveTokens })),
	// 保留近期原文的普通token预算，不是轮数。
	keepRecentTokens: Type.Optional(nonNegativeSafeInteger({ default: SETTINGS_DEFAULTS.compaction.keepRecentTokens })),
	// 每模型覆盖字典可整体缺省，缺某项时getter再逐字段回退普通设置。
	modelOverrides: Type.Optional(
		// Record只要求任意字符串键和值形状，不把键解析成真实已注册provider/model。
		Type.Record(Type.String(), CompactionModelOverrideSchema, {
			// 这是精确键约定的文案，没有额外pattern约束或通配符解析。
			description: 'Per-model overrides keyed by exact "provider/modelId" strings.',
		}),
	),
});

// 切换分支摘要的设置，与常规compaction分开；这里预算只用Number，没有非负/整数上下界。
const BranchSummarySettingsSchema = Type.Object({
	// 可选预留空间，缺省采用共享16384，实际回退由getter完成。
	reserveTokens: Type.Optional(
		Type.Number({
			// 向编辑器说明该预算用于提示与模型摘要回复。
			description: "Tokens reserved for the prompt and LLM response.",
			// default不等于把缺省属性写进用户JSON。
			default: SETTINGS_DEFAULTS.branchSummary.reserveTokens,
		}),
	),
	// 是否跳过询问；true是跳过且默认不摘要，不能误读为自动总结。
	skipPrompt: Type.Optional(
		Type.Boolean({
			// 保留原英语说明供公开schema展示。
			description: 'When true, skips the "Summarize branch?" prompt and defaults to no summary.',
			// false为默认偏好，是否展示交互提示还取决于上层模式。
			default: SETTINGS_DEFAULTS.branchSummary.skipPrompt,
		}),
	),
});

// provider/SDK内部请求重试选项，不等于Agent整次回复重试；以下Number本身不约束非负整数。
const ProviderRetrySettingsSchema = Type.Object({
	// 未设置时可交SDK决定请求超时。
	timeoutMs: Type.Optional(Type.Number({ description: "SDK or provider request timeout in milliseconds." })),
	// 未设置时可交SDK决定内部额外尝试数，schema没有minimum/integer限制。
	maxRetries: Type.Optional(Type.Number({ description: "SDK or provider retry attempts." })),
	// 服务端要求等待的最大允许时长，默认60秒。
	maxRetryDelayMs: Type.Optional(
		Type.Number({
			// 这里给文档语义，真正超出后的失败逻辑在请求层。
			description: "Maximum server-requested delay before failing.",
			// 共用默认元数据，避免公开说明与getter默认漂移。
			default: SETTINGS_DEFAULTS.retry.provider.maxRetryDelayMs,
		}),
	),
});

// Agent重试及嵌套provider设置；旧maxDelayMs仍可作为文件输入，迁移后的TS RetrySettings会排除旧字段。
const RetrySettingsSchema = Type.Object({
	// 是否允许Agent自动重试暂时故障。
	enabled: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.retry.enabled })),
	// 最大额外次数默认3，这个schema只限制为number，不在此保证整数。
	maxRetries: Type.Optional(Type.Number({ default: SETTINGS_DEFAULTS.retry.maxRetries })),
	// 指数退避基础毫秒数，默认2000。
	baseDelayMs: Type.Optional(
		Type.Number({
			// 2/4/8秒是共享默认下的示例，不是任何配置都固定这个时间。
			description: "Exponential backoff base delay in milliseconds: 2s, 4s, 8s.",
			// 只附元数据，不启动定时器。
			default: SETTINGS_DEFAULTS.retry.baseDelayMs,
		}),
	),
	// 外层Agent单次退避上限，与provider上限不同。
	maxAgentDelayMs: Type.Optional(Type.Number({ default: SETTINGS_DEFAULTS.retry.maxAgentDelayMs })),
	// SDK/provider子配置的每个字段都允许省略。
	provider: Type.Optional(ProviderRetrySettingsSchema),
	// 兼容输入字段，仅标记deprecated，不在schema构造时自动改名或删除。
	maxDelayMs: Type.Optional(
		Type.Number({
			// SettingsManager迁移把旧值放入provider.maxRetryDelayMs，非maxAgentDelayMs。
			description: "Legacy retry delay setting. Use provider.maxRetryDelayMs instead.",
			// JSON Schema注解提醒编辑器这是旧字段，不等于验证拒绝此字段。
			deprecated: true,
		}),
	),
});

// 终端能力覆盖/图片展示设置，不控制发送给模型的图片是否被阻止。
const TerminalSettingsSchema = Type.Object({
	// 可选终端图片展示开关，默认true，是否支持协议由终端层探测。
	showImages: Type.Optional(
		Type.Boolean({
			// 说明展示的前提，不是本schema执行终端探测。
			description: "Show images when the terminal supports them.",
			// 默认仅作为公开文档元信息。
			default: SETTINGS_DEFAULTS.terminal.showImages,
		}),
	),
	// 首选图片宽度以字符格计；此schema无取整/最小值，运行时getter另处理。
	imageWidthCells: Type.Optional(
		Type.Number({
			// 区别于像素宽度，不是模型图片输入上限。
			description: "Preferred inline image width in terminal cells.",
			// 缺省首选60字符格。
			default: SETTINGS_DEFAULTS.terminal.imageWidthCells,
		}),
	),
	// 内容缩短时清余行的显式布尔偏好；环境变量回退不在schema中表达。
	clearOnShrink: Type.Optional(
		Type.Boolean({
			// 说明显示效果，不在这里清理屏幕。
			description: "Clear empty rows when content shrinks.",
			// getter缺省时还先考虑PI_CLEAR_ON_SHRINK，最后才用此false。
			default: SETTINGS_DEFAULTS.terminal.clearOnShrink,
		}),
	),
	// 是否输出终端OSC进度提示，默认关闭。
	showTerminalProgress: Type.Optional(
		Type.Boolean({
			// 控制序列协议的说明文字，非当前输出。
			description: "Show OSC 9;4 terminal progress indicators.",
			// 共享默认避免文档与getter脱节。
			default: SETTINGS_DEFAULTS.terminal.showTerminalProgress,
		}),
	),
	// 超链接能力支持显式true/false或auto探测，不是所有任意字符串都合法。
	hyperlinks: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
	// 图片协议可指定kitty/iterm2、auto或false禁用；没有true这个schema分支。
	images: Type.Optional(
		Type.Union([Type.Literal("kitty"), Type.Literal("iterm2"), Type.Literal("auto"), Type.Literal(false)]),
	),
	// 真彩色能力也可由布尔值覆盖或auto探测。
	trueColor: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
});

// 向模型发送图片的处理偏好，与terminal.showImages分别配置。
const ImageSettingsSchema = Type.Object({
	// 是否自动缩放输入图片；schema只存偏好，不在这里处理图片字节。
	autoResize: Type.Optional(
		Type.Boolean({
			// 保留原公开说明，具体图片限制还要看实际模型输入处理实现。
			description: "Resize images to 2000x2000 maximum for better model compatibility.",
			// 默认开启，getter读取时回退此值。
			default: SETTINGS_DEFAULTS.images.autoResize,
		}),
	),
	// 是否阻止图片进入发给模型的内容，默认false。
	blockImages: Type.Optional(
		Type.Boolean({
			// 语义由模型上下文转换层落实，不是此声明主动删除历史图片。
			description: "When true, prevents all images from being sent to LLM providers.",
			// 与autoResize可独立设置，开启缩放不等于允许越过阻止开关。
			default: SETTINGS_DEFAULTS.images.blockImages,
		}),
	),
});

// 输入可选元信息，返回自定义思考预算对象schema，无I/O；这里只列minimal/low/medium/high，不列xhigh/max。
// 例如{high:10000}允许省略其他档位；预算只用Number，未约束非负/整数，实际请求层再解释。
function thinkingBudgetsSettings(options?: TSchemaOptions) {
	// Type.Object接收属性表与整个对象的options，字段Optional允许部分覆盖。
	return Type.Object(
		{
			// 各字段的数值是对应思考档位token预算，而不是显示开关。
			minimal: Type.Optional(Type.Number()),
			// 低档位可独立省略，不自动继承minimal数值。
			low: Type.Optional(Type.Number()),
			// 中档位同样只声明number类型。
			medium: Type.Optional(Type.Number()),
			// 高档位字段常用于自定义最大思考预算，具体provider是否采用另行决定。
			high: Type.Optional(Type.Number()),
		},
		// 额外description等选项附在整张预算表上。
		options,
	);
}

// 无额外元信息的预算表规则，供下面导出其TS静态接口。
const ThinkingBudgetsSettingsSchema = thinkingBudgetsSettings();

// Markdown渲染偏好，区别于Markdown语法或Mermaid图表内容本身。
const MarkdownSettingsSchema = Type.Object({
	// 代码块缩进是任意文字，schema不强制恰好两个空格。
	codeBlockIndent: Type.Optional(Type.String({ default: SETTINGS_DEFAULTS.markdown.codeBlockIndent })),
	// 图表渲染策略只接受off/final/streaming，不校验图语法。
	mermaid: Type.Optional(
		Type.Union([Type.Literal("off"), Type.Literal("final"), Type.Literal("streaming")], {
			// 默认流式渲染，具体是否成功仍受图内容与渲染器影响。
			default: SETTINGS_DEFAULTS.markdown.mermaid,
		}),
	),
});

// 分类警告开关表，这里声明Anthropic额外用量警告，不自动展示任何通知。
const WarningSettingsSchema = Type.Object({
	// 可选布尔值，缺省展示偏好由共享true提供。
	anthropicExtraUsage: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.warnings.anthropicExtraUsage })),
});

// 输入可选元信息，返回codemode模式联合schema，无I/O；例如on/only通过，不提供off选项。
function codemodeMode(options?: TSchemaOptions) {
	// 字面量联合精确限制两种策略，options是整项描述/default等，不是实际模式值。
	return Type.Union([Type.Literal("on"), Type.Literal("only")], options);
}

// 基础模式规则也供Static推导CodemodeMode类型。
const CodemodeModeSchema = codemodeMode();

// codemode工具声明呈现及内联预算设置；规则对象本身不会执行脚本或工具。
const CodemodeSettingsSchema = Type.Object({
	// 可选模式，显式值需为on/only。
	mode: Type.Optional(
		// 复用模式工厂，补上本字段的描述和默认元信息。
		codemodeMode({
			// 英语正文完整保留：on保留直接工具，only将脚本可调用项列入codemode且不声明活跃直接工具。
			description:
				'How codemode presents tools. "on" keeps direct tools declared and annotates tools callable from scripts; codemode lists only tools without direct exposure. "only" lists every script-callable tool in codemode and does not declare active direct tools.',
			// 默认on不等于所有工具无条件可在脚本里调用，实际声明策略另行构造。
			default: SETTINGS_DEFAULTS.codemode.mode,
		}),
	),
	// 内联工具声明的估算token预算，不是代码运行时间或整次模型上下文限制。
	inlineBudget: Type.Optional(
		Type.Number({
			// 允许0和小数，但不允许负数；此处没有Integer或安全整数上限。
			minimum: 0,
			// 公开说明单位和用途，不实际统计声明token。
			description: "Estimated tokens available for inline codemode tool declarations.",
			// 缺省文档预算为3000。
			default: SETTINGS_DEFAULTS.codemode.inlineBudget,
		}),
	),
});

// 包来源可以是字符串或带过滤规则的对象；此schema不解析npm/git版本、不安装包、不执行扩展。
const PackageSourceSchema = Type.Union(
	[
		// 字符串形式由包管理器按来源处理，schema不限制为某个URL前缀。
		Type.String({ description: "Load all resources from the package." }),
		// 对象形式必填source，其余筛选项可缺省。
		Type.Object({
			// source是任意字符串，非空/格式规则不在这里约束。
			source: Type.String(),
			// autoload=false时从空集合开始，再按显式模式选择资源。
			autoload: Type.Optional(
				Type.Boolean({ description: "When false, start empty and only apply explicit resource patterns." }),
			),
			// 四个资源筛选列表只要求字符串项，glob/启用禁用语义由包管理器解释。
			extensions: Type.Optional(Type.Array(Type.String())),
			// 技能资源筛选不把Markdown正文放入设置。
			skills: Type.Optional(Type.Array(Type.String())),
			// 提示词模板资源筛选，与模板调用参数替换是两层逻辑。
			prompts: Type.Optional(Type.Array(Type.String())),
			// 主题资源筛选，不在此解析主题JSON。
			themes: Type.Optional(Type.Array(Type.String())),
		}),
	],
	{
		// 联合整体的编辑器说明，字符串正文保持原样。
		description:
			"Package source for npm or git packages. Use the string form to load all resources or the object form to filter resources.",
	},
);

// 复用“字符串数组”形状，没有minItems/uniqueItems；空数组和重复项在schema层都允许。
const StringArraySchema = Type.Array(Type.String());
// 文件输入同时接受当前技能路径数组和旧对象格式，迁移后Settings类型仅保留string[]。
const SkillsInputSchema = Type.Union(
	[
		// 当前形式：本地文件/目录路径数组。
		StringArraySchema,
		// 旧形式：两个属性均可省略，deprecated只提醒，不拒绝验证。
		Type.Object(
			{
				// 旧对象把命令开关放在skills里，迁移会按规则提升到顶层。
				enableSkillCommands: Type.Optional(Type.Boolean()),
				// 旧路径列表之后由迁移器取代整项skills。
				customDirectories: Type.Optional(StringArraySchema),
			},
			// 标记旧对象方案弃用，并未在此触发迁移保存。
			{ deprecated: true },
		),
	],
	// 该文案描述最终用途，读取/扫描路径由skills/resource-loader模块执行。
	{ description: "Local skill file paths or directories." },
);

// 完整文件输入规则：所有已知设置可省略，顶层允许扩展自有字段；不会自动验证每次JSON.parse或补全defaults。
// 例如{theme:"dark",extensionSetting:{enabled:true}}允许；实际业务读取仍由SettingsManager及各消费者负责。
export const SettingsSchema = Type.Object(
	{
		// 编辑器schema引用只限定为字符串，不抓取URL、不限定必须指向本项目网址。
		$schema: Type.Optional(Type.String({ description: "JSON Schema reference." })),
		// 最近已读Pi日志版本记录，不在此比较语义版本大小。
		lastChangelogVersion: Type.Optional(Type.String()),
		// 按扩展包身份保存已读日志版本，整张表可缺省。
		extensionChangelogVersions: Type.Optional(
			// 字典键和值都是任意字符串，不要求对应已安装包或可解析版本号。
			Type.Record(Type.String(), Type.String(), {
				// 文案解释值的用途，不执行日志读取。
				description: "Last seen changelog version per extension package.",
			}),
		),
		// 启动默认供应商名字，schema不查供应商目录/凭证。
		defaultProvider: Type.Optional(Type.String()),
		// 启动默认模型id，允许含斜杠/冒号；模型解析层另决定匹配。
		defaultModel: Type.Optional(Type.String()),
		// 模型档位沿用pi-ai的off/minimal/low/medium/high/xhigh/max规则，不验证具体模型支持情况。
		defaultThinkingLevel: Type.Optional(ModelThinkingLevelSchema),
		// 逐模型档位覆盖字典，可独立于全局默认存在。
		modelThinkingLevels: Type.Optional(
			// 任意字符串键映射合法档位；没有在schema中限定provider/id键格式。
			Type.Record(Type.String(), ModelThinkingLevelSchema, {
				// 键格式是业务约定说明，不是额外pattern验证。
				description: 'Per-model default thinking level overrides keyed by "provider/modelId".',
			}),
		),
		// 模型请求传输偏好，按精确字面量校验，不在此建HTTP/WebSocket连接。
		transport: Type.Optional(
			Type.Union(
				// 四个候选任一通过即可；cached是独立允许值，非任意websocket后缀。
				[Type.Literal("auto"), Type.Literal("sse"), Type.Literal("websocket"), Type.Literal("websocket-cached")],
				// auto的选择行为由运行时请求层决定。
				{ default: SETTINGS_DEFAULTS.transport },
			),
		),
		// /share目的地偏好，不在schema构造时上传或创建gist。
		sessionShareDestination: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("gist"), Type.Literal("radius")], {
				// 多行description属性只是一段完整字符串，保留原公开说明。
				description:
					'Destination used by /share. "auto" uses Radius when authenticated and otherwise creates a GitHub gist.',
				// 缺省描述为auto，认证分流由分享模块判断。
				default: SETTINGS_DEFAULTS.sessionShareDestination,
			}),
		),
		// 中途引导消息一次全部交付还是逐条交付，字符串大小写必须一致。
		steeringMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				// 默认逐条，不意味着队列中只能保存一条。
				default: SETTINGS_DEFAULTS.steeringMode,
			}),
		),
		// 后续排队消息的交付策略，与steering独立配置。
		followUpMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				// 默认逐条取用，实际何时取由Agent循环决定。
				default: SETTINGS_DEFAULTS.followUpMode,
			}),
		),
		// 原始主题文字，可由主题层解释单名或light/dark配对，schema不查文件。
		theme: Type.Optional(Type.String()),
		// 复用前面定义的压缩子对象，非负安全整数规则也随之带入。
		compaction: Type.Optional(CompactionSettingsSchema),
		// 分支摘要采用自己的预算/询问子对象。
		branchSummary: Type.Optional(BranchSummarySettingsSchema),
		// 文件输入仍接受旧maxDelayMs，随后由迁移器处理。
		retry: Type.Optional(RetrySettingsSchema),
		// 隐藏界面思考块偏好，不代表从历史或模型上下文删除思考文本。
		hideThinkingBlock: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.hideThinkingBlock })),
		// 缓存成本/恢复提示的显示开关，default:false。
		showCacheMissNotices: Type.Optional(
			Type.Boolean({
				// 供编辑器展示的用途描述。
				description: "Show cache cost and provider recovery notices.",
				// 这里只放默认注解，具体通知仍需触发条件。
				default: SETTINGS_DEFAULTS.showCacheMissNotices,
			}),
		),
		// 外部编辑器命令文字，优先级由getter解释，schema不执行/检查程序存在。
		externalEditor: Type.Optional(
			Type.String({ description: "Command for Ctrl+G external editor; takes precedence over VISUAL and EDITOR." }),
		),
		// 自定义shell路径是文字，~展开/存在性探测由路径与shell模块处理。
		shellPath: Type.Optional(
			Type.String({
				// 例子解释支持的输入，不自动把Cygwin或bash装入系统。
				description: "Custom shell path, for example for Cygwin on Windows, with support for leading ~ expansion.",
			}),
		),
		// 启动静默可设true/false或header，字符串"false"不是布尔false。
		quietStartup: Type.Optional(
			Type.Union([Type.Boolean(), Type.Literal("header")], {
				// true全隐藏，header仅保留头部，false沿用普通启动展示。
				description: 'When true, hide all startup output. When "header", keep only the startup header.',
				// 默认false，由getter读取时回退。
				default: SETTINGS_DEFAULTS.quietStartup,
			}),
		),
		// 默认项目信任策略；“只读全局层”在SettingsManager getter落实，schema本身不区分文件作用域。
		defaultProjectTrust: Type.Optional(
			Type.Union([Type.Literal("ask"), Type.Literal("always"), Type.Literal("never")], {
				// Global只是说明，不是禁止项目JSON包含此键的schema约束。
				description: "Global setting only.",
				// ask也受无受控资源/已有决定/扩展等更高优先级流程影响。
				default: SETTINGS_DEFAULTS.defaultProjectTrust,
			}),
		),
		// bash命令前缀本身是可执行shell正文的配置，schema只要求字符串，不在这里执行。
		shellCommandPrefix: Type.Optional(
			Type.String({ description: "Prefix prepended to every bash command, for example to enable shell aliases." }),
		),
		// npm包装命令为argv数组，不是需要本schema按空格拆分的一整行shell文字。
		npmCommand: Type.Optional(
			Type.Array(Type.String(), {
				// 数组元素语义由包管理执行器解释；这里无minItems，空数组也能过schema。
				description:
					'Command used for npm package lookup and installation, in argv form such as ["mise", "exec", "node@20", "--", "npm"].',
			}),
		),
		// Pi自身更新的argv命令，支持上层替换占位符与环境覆盖，不在此运行更新。
		selfUpdateCommand: Type.Optional(
			Type.Array(Type.String(), {
				// 至少一个元素，但每个字符串没有minLength，schema不保证首项是存在的程序。
				minItems: 1,
				// {packageName}等仅为说明，真正替换和全局层读取在更新模块执行。
				description:
					'Command `pi update` runs to update Pi itself, in argv form such as ["mise", "use", "-g", "npm:{packageName}@{version}"]. Placeholders: {packageName}, {version}, {installSpec}. PI_SELF_UPDATE_COMMAND takes precedence. Global setting only.',
			}),
		),
		// 更新后展示精简日志偏好，不删完整changelog文件。
		collapseChangelog: Type.Optional(
			Type.Boolean({
				// /changelog仍可访问完整日志，此字段只控制默认展示。
				description: "Show the condensed changelog after update; use /changelog for the full changelog.",
				// 默认不折叠。
				default: SETTINGS_DEFAULTS.collapseChangelog,
			}),
		),
		// 安装/更新版本ping偏好，与分析数据分享开关独立。
		enableInstallTelemetry: Type.Optional(
			Type.Boolean({
				// 描述触发场景，这个schema声明不会发送任何ping。
				description: "Send an anonymous version and update ping after changelog-detected updates.",
				// 共享默认true，仅读取设置仍不触发网络行为。
				default: SETTINGS_DEFAULTS.enableInstallTelemetry,
			}),
		),
		// 分析数据分享需用户选择，默认false。
		enableAnalytics: Type.Optional(
			Type.Boolean({
				// schema只说明选项，不在这里征询或记录同意。
				description: "Opt in to analytics data sharing.",
				// default注解不会自行生成trackingId。
				default: SETTINGS_DEFAULTS.enableAnalytics,
			}),
		),
		// 分析追踪标识是普通可选文字，首次启用生成UUID的行为由setter完成。
		trackingId: Type.Optional(
			Type.String({ description: "Analytics tracking identifier, generated when analytics is enabled." }),
		),
		// 包来源数组，元素可为字符串或过滤对象，具体npm/git/本地分类由包管理器执行。
		packages: Type.Optional(
			Type.Array(PackageSourceSchema, {
				// 这是来源用途说明，schema不自行下载缺失依赖。
				description: "npm or git package sources, as strings or objects with resource filtering.",
			}),
		),
		// 本地扩展入口列表，不在校验时import扩展代码。
		extensions: Type.Optional(
			Type.Array(Type.String(), { description: "Local extension file paths or directories." }),
		),
		// 安装稳定ID，getter只读用户层并在需要时生成；schema本身没有UUID format约束。
		deviceId: Type.Optional(
			Type.String({
				// Global only同样只是说明，作用域安全边界由读取器落实。
				description: "Stable installation UUID, generated when authentication first needs it. Global only.",
			}),
		),
		// 接受当前路径数组或待迁移旧对象，别与迁移后Settings.skills:string[]混淆。
		skills: Type.Optional(SkillsInputSchema),
		// 提示词模板本地入口，schema不读Markdown或展开$1。
		prompts: Type.Optional(
			Type.Array(Type.String(), { description: "Local prompt template file paths or directories." }),
		),
		// 主题入口列表，与当前选中主题theme文字是不同设置。
		themes: Type.Optional(Type.Array(Type.String(), { description: "Local theme file paths or directories." })),
		// 是否把技能注册为显式斜杠命令，不等于是否展示自动技能目录。
		enableSkillCommands: Type.Optional(
			Type.Boolean({
				// 具体命令由上层读取已发现技能再注册。
				description: "Register skills as /skill:name commands.",
				// 默认启用注册偏好，空技能集仍没有可注册项。
				default: SETTINGS_DEFAULTS.enableSkillCommands,
			}),
		),
		// 终端展示/能力覆盖子对象。
		terminal: Type.Optional(TerminalSettingsSchema),
		// 发给模型前的图片处理子对象。
		images: Type.Optional(ImageSettingsSchema),
		// 模型轮换模式数组，字符串格式与--models相同但schema不执行匹配。
		enabledModels: Type.Optional(
			Type.Array(Type.String(), {
				// provider前缀、glob、:high等语义在model-resolver解析。
				description: "Model patterns for cycling, in the same format as the --models CLI flag.",
			}),
		),
		// 初始工具选择：字符串数组仅验证元素类型，+/-组合和工具是否存在由运行时解析。
		defaultTools: Type.Optional(
			Type.Array(Type.String(), {
				// 普通名字替换继承选择，纯修饰项增删；不是schema负责合并两层设置。
				description:
					"Initial tool selection. Plain names replace the inherited selection; +name and -name entries add or remove tools.",
			}),
		),
		// 空编辑器双Escape行为，用字面量限制三种选择，不在这里响应真实按键。
		doubleEscapeAction: Type.Optional(
			Type.Union([Type.Literal("fork"), Type.Literal("tree"), Type.Literal("none")], {
				// 空编辑器是业务触发条件，schema只保存动作偏好。
				description: "Action for double-escape with an empty editor.",
				// 默认打开会话树。
				default: SETTINGS_DEFAULTS.doubleEscapeAction,
			}),
		),
		// 会话树默认视图模式，字段值不能是任意自定义筛选名。
		treeFilterMode: Type.Optional(
			Type.Union(
				[
					// 常规视图规则由树界面实现，schema只列允许值。
					Type.Literal("default"),
					// 省略工具类条目的视图选择。
					Type.Literal("no-tools"),
					// 用户条目视图选择，未在本模块执行筛选。
					Type.Literal("user-only"),
					// 带标签条目视图选择。
					Type.Literal("labeled-only"),
					// 全部条目视图选择。
					Type.Literal("all"),
				],
				{
					// 描述该偏好何时被上层消费。
					description: "Default filter when opening /tree.",
					// 默认default字符串，不代表schema返回undefined。
					default: SETTINGS_DEFAULTS.treeFilterMode,
				},
			),
		),
		// 复用预算工厂加用途说明，数字是否适用于具体模型由请求层决定。
		thinkingBudgets: Type.Optional(
			thinkingBudgetsSettings({
				// 单位token但schema没有自动统计/扣预算逻辑。
				description: "Custom token budgets for thinking levels.",
			}),
		),
		// 输入编辑器水平留白；此schema只限number，setter的0..3取整并未写成minimum/maximum。
		editorPaddingX: Type.Optional(
			Type.Number({
				// 描述输入区域，不是对话正文输出的outputPad。
				description: "Horizontal padding for the input editor.",
				// 默认0，验证器不会仅因default存在就修改原对象。
				default: SETTINGS_DEFAULTS.editorPaddingX,
			}),
		),
		// 对话正文水平留白与编辑器分开，精确只允许数字0或1。
		outputPad: Type.Optional(
			Type.Union([Type.Literal(0), Type.Literal(1)], {
				// 不是任意非负整数；字符串"1"也不在联合中。
				description: "Horizontal padding for transcript content.",
				// 默认1，由getter回退时实际采用。
				default: SETTINGS_DEFAULTS.outputPad,
			}),
		),
		// 补全菜单可见数量；schema没有setter的3..20限制，也没有Integer约束。
		autocompleteMaxVisible: Type.Optional(
			Type.Number({
				// 最大可见项不等于补全总候选数。
				description: "Maximum visible items in the autocomplete dropdown.",
				// 默认5项，实际展示/滚动在组件层完成。
				default: SETTINGS_DEFAULTS.autocompleteMaxVisible,
			}),
		),
		// 可选硬件光标开关，缺省的环境变量回退由getter决定，schema不读process.env。
		showHardwareCursor: Type.Optional(
			Type.Boolean({ description: "Show the terminal cursor while still positioning it for IME." }),
		),
		// Markdown渲染子对象，复用缩进/mermaid策略。
		markdown: Type.Optional(MarkdownSettingsSchema),
		// 分类警告显示开关子对象。
		warnings: Type.Optional(WarningSettingsSchema),
		// codemode模式及内联声明预算子对象。
		codemode: Type.Optional(CodemodeSettingsSchema),
		// 自定义会话目录文字，不在schema构造时展开~或创建目录。
		sessionDir: Type.Optional(
			Type.String({
				// 与--session-dir输入形式约定一致，仍需路径模块实际解析。
				description: "Custom session storage directory, in the same format as the --session-dir CLI flag.",
			}),
		),
		// Pi管理HTTP客户端的代理偏好，schema仅限字符串而非验证URL格式/连通性。
		httpProxy: Type.Optional(
			Type.String({ description: "Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Pi-managed HTTP clients." }),
		),
		// HTTP响应头/正文空闲超时，不是整次Agent总运行时长。
		httpIdleTimeoutMs: Type.Optional(
			timeoutSetting({
				// 数字0和disabled都表示禁用；字段未设时的默认在HTTP模块/getter中提供。
				description: 'HTTP header or body idle timeout in milliseconds; 0 or "disabled" disables it.',
			}),
		),
		// 缓存预热策略，用户层限制由getter落实，schema不区分global/project文件。
		cacheWarming: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Literal("streaming"), Type.Literal("idle")], {
				// idle还在运行间隔预热，可能产生成本；这里只记录说明，不实际发请求。
				description:
					'Cache-warming profile. "idle" also warms between agent runs. Global only because each refresh costs money.',
				// 默认streaming描述与运行时共享。
				default: SETTINGS_DEFAULTS.cacheWarming,
			}),
		),
		// WebSocket建连/握手超时，复用非负数或disabled规则，不强行沿用HTTP空闲超时默认。
		websocketConnectTimeoutMs: Type.Optional(
			timeoutSetting({
				// 0也合法；schema不接受数字字符串，实际getter解析器可更宽松。
				description: 'WebSocket connect or open handshake timeout in milliseconds; 0 or "disabled" disables it.',
			}),
		),
		// 普通/全屏终端界面选择，不在这里切换缓冲区或显示UI。
		tuiMode: Type.Optional(
			Type.Union([Type.Literal("regular"), Type.Literal("fullscreen")], {
				// 默认fullscreen，getter对缺省和非regular值也采用共享默认。
				default: SETTINGS_DEFAULTS.tuiMode,
			}),
		),
		// 全屏退出后的保留内容策略，普通界面不会消费该策略。
		fullscreenExitOutput: Type.Optional(
			Type.Union([Type.Literal("transcript"), Type.Literal("resume-hint")], {
				// 这是业务作用范围说明，没有if/then强制检查tuiMode字段。
				description: "No effect in regular TUI mode.",
				// 默认保留对话输出transcript。
				default: SETTINGS_DEFAULTS.fullscreenExitOutput,
			}),
		),
		// 全屏滚动条展示偏好，精确限制auto/always/hidden。
		fullscreenScrollbar: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("always"), Type.Literal("hidden")], {
				// 普通模式无效果由界面消费约定决定，不是schema禁止同时配置。
				description: "No effect in regular TUI mode.",
				// 缺省为自动显示策略。
				default: SETTINGS_DEFAULTS.fullscreenScrollbar,
			}),
		),
		// 全屏选中文本时的复制偏好，schema不调用剪贴板接口。
		fullscreenCopyOnSelect: Type.Optional(
			Type.Boolean({
				// 非全屏界面忽略这一选项。
				description: "No effect in regular TUI mode.",
				// 默认允许选中复制，实际平台支持由界面/剪贴板模块处理。
				default: SETTINGS_DEFAULTS.fullscreenCopyOnSelect,
			}),
		),
		// 滚轮每次行数可为任意number或auto；描述里的1..100钳制由getter/setter做，schema并未设这些边界。
		fullscreenWheelScrollLines: Type.Optional(
			Type.Union([Type.Number(), Type.Literal("auto")], {
				// 原说明描述运行时行为，不能把这段自然语言当数值验证条件。
				description: "Lines scrolled per wheel event in fullscreen mode; numeric values are clamped from 1 to 100.",
				// 默认auto，不把它强制转换为某个固定行数。
				default: SETTINGS_DEFAULTS.fullscreenWheelScrollLines,
			}),
		),
		// 旧队列模式保留为可接受输入，随后迁移为steeringMode。
		queueMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				// 不迁移到followUpMode，避免把两种队列偏好混淆。
				description: "Legacy setting migrated to steeringMode.",
				// 弃用标记不拒绝旧文件，通过迁移维持当前内部结构。
				deprecated: true,
			}),
		),
		// 旧布尔开关会由迁移器在transport缺省时映射为websocket/sse，schema本身不做变换。
		websockets: Type.Optional(
			Type.Boolean({ description: "Legacy setting migrated to transport.", deprecated: true }),
		),
	},
	// 顶层未知字段允许保留供扩展使用；它们没有被这些已知字段规则验证为某个特定形状。
	{ additionalProperties: true },
);

// typeof取schema对象的静态类型，Static从规则推导输入形状；类型别名编译后擦除，不执行验证。
type SettingsInput = Static<typeof SettingsSchema>;

// 空接口extends把schema推导结果作为具名接口导出；不是新建运行时对象，两个预算属性仍可选。
export interface CompactionModelOverride extends Static<typeof CompactionModelOverrideSchema> {}
// 包含自动开关、普通预算及逐模型覆盖，沿用schema的可选字段。
export interface CompactionSettings extends Static<typeof CompactionSettingsSchema> {}
// 分支摘要设置接口，Number在TS中统一为number，不表达非负/整数约束。
export interface BranchSummarySettings extends Static<typeof BranchSummarySettingsSchema> {}
// provider级请求/重试设置接口，不等于Agent重试接口。
export interface ProviderRetrySettings extends Static<typeof ProviderRetrySettingsSchema> {}
// Omit去掉旧maxDelayMs键，表示迁移后的内部retry类型不再鼓励访问该旧字段。
export interface RetrySettings extends Omit<Static<typeof RetrySettingsSchema>, "maxDelayMs"> {}
// 终端能力覆盖和展示偏好的可选字段接口。
export interface TerminalSettings extends Static<typeof TerminalSettingsSchema> {}
// 模型图片处理的autoResize/blockImages布尔接口。
export interface ImageSettings extends Static<typeof ImageSettingsSchema> {}
// 当前仅四个思考预算字段的静态接口，不自动补入xhigh/max。
export interface ThinkingBudgetsSettings extends Static<typeof ThinkingBudgetsSettingsSchema> {}
// ["mermaid"]取属性类型，NonNullable去掉可选属性引入的undefined，留下三种模式字符串联合；该工具类型也能排除null。
export type MermaidRenderingMode = NonNullable<Static<typeof MarkdownSettingsSchema>["mermaid"]>;
// Markdown配置对象接口，模式字段本身仍允许缺省。
export interface MarkdownSettings extends Static<typeof MarkdownSettingsSchema> {}
// 分类警告开关接口，没有执行任何警告判定。
export interface WarningSettings extends Static<typeof WarningSettingsSchema> {}
// 从字面量联合规则推导on | only，避免重复手写可选字符串。
export type CodemodeMode = Static<typeof CodemodeModeSchema>;
// codemode对象接口，mode和inlineBudget都可缺省。
export interface CodemodeSettings extends Static<typeof CodemodeSettingsSchema> {}
// 下列NonNullable类型适用于getter/setter的明确选择值；去掉缺省类型不代表运行时已补值。
export type DefaultProjectTrust = NonNullable<SettingsInput["defaultProjectTrust"]>;
// boolean | header，区别于只允许boolean的普通开关。
export type QuietStartup = NonNullable<SettingsInput["quietStartup"]>;
// 四种请求传输偏好的字面量联合。
export type TransportSetting = NonNullable<SettingsInput["transport"]>;
// auto/gist/radius分享目的地联合。
export type SessionShareDestination = NonNullable<SettingsInput["sessionShareDestination"]>;
// 包来源保留字符串或带source/筛选字段对象的联合类型。
export type PackageSource = Static<typeof PackageSourceSchema>;
// 全屏退出保留transcript或resume-hint。
export type FullscreenExitOutput = NonNullable<SettingsInput["fullscreenExitOutput"]>;
// regular/fullscreen界面模式联合。
export type TuiMode = NonNullable<SettingsInput["tuiMode"]>;
// off/streaming/idle缓存预热策略联合。
export type CacheWarmingMode = NonNullable<SettingsInput["cacheWarming"]>;
// 迁移后的内部设置：排除旧顶层queueMode/websockets，并重定义retry/skills；没有在类型定义时执行迁移或校验。
export interface Settings extends Omit<SettingsInput, "queueMode" | "retry" | "skills" | "websockets"> {
	// retry只用移除旧maxDelayMs后的内部类型，整个字段仍可省略。
	retry?: RetrySettings;
	// skills内部统一为路径数组，不再把旧enableSkillCommands/customDirectories对象当当前类型。
	skills?: string[];
}
