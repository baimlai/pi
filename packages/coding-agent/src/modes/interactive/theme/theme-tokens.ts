// 主题颜色字段的统一名册：theme.ts按它分前景/背景并补缺省值，theme-schema.ts按它生成必填/可选规则；本文件不解析颜色或绘制界面。
// 一个token是有名字的颜色位置，例如accent；Descriptor只描述用途/槽位/可选回退，不是颜色值本身。
export interface ThemeTokenDescriptor {
	// 字符串字面量联合只允许两个槽位；同样的空字符串颜色在前景/背景代表不同终端默认值。
	slot: "foreground" | "background";
	// 用途文字被主题schema复用为编辑提示，不在这里限制颜色语法。
	description: string;
	// ?表示字段可省；提供时是另一个token的名字，不是十六进制颜色字符串。
	fallback?: string;
}

// Record表示名字到描述对象的字典，Readonly只禁止TS层面改顶层键，不深冻结描述对象。
export type ThemeTokenDescriptors = Readonly<Record<string, ThemeTokenDescriptor>>;

/**
 * 给名册做两项运行时检查：回退名必须存在，且回退与当前字段属于同一颜色槽。
 * 例：scrollbarTrack回退muted可通过；前景字段回退背景selectedBg会抛错。
 * 返回输入原对象，不补实际颜色、不冻结；也不检测回退环、链顺序或名称自指。
 * const泛型T保留调用处字段名/slot等字面量；extends约束结构，返回T保留具体信息给后面的映射类型。
 */
function defineThemeTokens<const T extends ThemeTokenDescriptors>(tokens: T): T {
	// entries只枚举自有可枚举字符串键，[name,descriptor]用数组解构取当前名字/描述。
	for (const [name, descriptor] of Object.entries(tokens)) {
		// 没有回退的字段不做下面两项检查；continue进入下一项，不返回整个函数。
		if (descriptor.fallback === undefined) continue;
		// 按名字索引描述表；这里是普通属性读取，不额外要求回退名为自有键。
		const fallback = tokens[descriptor.fallback];
		// 类型字典不能保证某个运行时名字存在，因此仍有这一声明约束检查。
		if (fallback === undefined) {
			// 模板插值报告当前字段与坏回退名，导入名册时就可能抛错，不等用户加载主题。
			throw new Error(`Theme token ${name} has unknown fallback ${descriptor.fallback}`);
		}
		// 只比较直接回退的槽位，不沿回退链递归；防把终端前景默认值误当背景默认值。
		if (fallback.slot !== descriptor.slot) {
			// 不自动转换槽位或跳过坏字段，而是拒绝这份描述表。
			throw new Error(`Theme token ${name} has fallback ${descriptor.fallback} in a different color slot`);
		}
	}
	// 原引用原样返回，实际fallback取值由theme.ts后续按名册顺序处理。
	return tokens;
}

/** Theme token metadata in the same order used by theme files and the published JSON Schema. */
// 模块加载时检查这份名册；const仅固定变量绑定，不能阻止运行时修改对象。英文description保留为真实schema编辑提示。
export const THEME_TOKENS = defineThemeTokens({
	// 主强调前景，用于logo/选择项/光标等；这里只登记用途，不预设某个RGB值。
	accent: { slot: "foreground", description: "Primary accent color (logo, selected items, cursor)" },
	// 普通边框的前景颜色。
	border: { slot: "foreground", description: "Normal borders" },
	// 强调边框的前景颜色，与普通border分别配置。
	borderAccent: { slot: "foreground", description: "Highlighted borders" },
	// 较弱边框的前景颜色。
	borderMuted: { slot: "foreground", description: "Subtle borders" },
	// 成功状态前景，不表示它负责判断操作是否成功。
	success: { slot: "foreground", description: "Success states" },
	// 错误状态前景。
	error: { slot: "foreground", description: "Error states" },
	// 警告状态前景。
	warning: { slot: "foreground", description: "Warning states" },
	// 次要文字前景；实际是否附加终端dim样式由Theme实例另外决定。
	muted: { slot: "foreground", description: "Secondary/dimmed text" },
	// 更弱文字的独立前景token，名字dim本身不在这里产生SGR转义。
	dim: { slot: "foreground", description: "Very dimmed text (more subtle than muted)" },
	// 默认正文前景，主题常用空字符串表示终端默认前景；字段自身仍需提供。
	text: { slot: "foreground", description: "Default text color (usually empty string)" },
	// 模型思考块的文字前景，不控制是否显示思考内容。
	thinkingText: { slot: "foreground", description: "Thinking block text color" },
	// 滚动条轨道可省略，兼容没有此字段的旧主题。
	scrollbarTrack: {
		// 轨道字符用前景槽，不能因“轨道”一词误当背景。
		slot: "foreground",
		// 英文说明进入生成schema，只描述缺省回退，不在此执行补值。
		description: "Fullscreen scrollbar track foreground (falls back to muted when omitted)",
		// 缺省时由theme.ts取muted的值，同为前景通过上面的槽位检查。
		fallback: "muted",
	},
	// 滚动条滑块描述，与轨道分别配置。
	scrollbarThumb: {
		// 滑块也是字符前景。
		slot: "foreground",
		// 描述滑块缺省采用正文前景。
		description: "Fullscreen scrollbar thumb foreground (falls back to text when omitted)",
		// 引用text字段，不把字符串"text"当真实颜色值。
		fallback: "text",
	},
	// 选中项目背景，用background槽。
	selectedBg: { slot: "background", description: "Selected item background" },
	// 搜索普通匹配背景；当前匹配的显示还会交换前景/背景，消费方负责绘制。
	searchMatchBg: {
		// 名册把它归到背景，供TS类型和默认颜色含义使用。
		slot: "background",
		// 文案同时提示当前匹配对该色的使用，不让schema自动做颜色交换。
		description: "Transcript search match background and current-match text (falls back to selectedBg when omitted)",
		// 与selectedBg同槽，旧主题可沿用选择背景。
		fallback: "selectedBg",
	},
	// 搜索普通匹配文字前景，当前匹配可把其具体色用于背景。
	searchMatchText: {
		// token归前景；跨槽使用需消费方取得具体颜色，而非改变这里的声明。
		slot: "foreground",
		// 说明普通/当前匹配的用途差异。
		description: "Transcript search match text and current-match background (falls back to text when omitted)",
		// 缺省沿用text，不在本函数中访问任何用户主题文件。
		fallback: "text",
	},
	// 用户消息区域的背景。
	userMessageBg: { slot: "background", description: "User message background" },
	// 用户消息正文的前景。
	userMessageText: { slot: "foreground", description: "User message text color" },
	// 扩展等注入的自定义消息背景。
	customMessageBg: { slot: "background", description: "Custom message background (hook-injected messages)" },
	// 自定义消息正文前景。
	customMessageText: { slot: "foreground", description: "Custom message text color" },
	// 自定义消息类型标签的前景。
	customMessageLabel: { slot: "foreground", description: "Custom message type label color" },
	// 工具执行尚未完成时的框背景，不负责启动工具。
	toolPendingBg: { slot: "background", description: "Tool execution box (pending state)" },
	// 工具成功状态的框背景。
	toolSuccessBg: { slot: "background", description: "Tool execution box (success state)" },
	// 工具错误状态的框背景。
	toolErrorBg: { slot: "background", description: "Tool execution box (error state)" },
	// 工具框标题前景。
	toolTitle: { slot: "foreground", description: "Tool execution box title color" },
	// 工具输出正文前景，与标题分开配置。
	toolOutput: { slot: "foreground", description: "Tool execution box output text color" },
	// Markdown标题文字前景。
	mdHeading: { slot: "foreground", description: "Markdown heading text" },
	// Markdown链接可读文字前景。
	mdLink: { slot: "foreground", description: "Markdown link text" },
	// Markdown链接URL文字前景，不负责打开URL。
	mdLinkUrl: { slot: "foreground", description: "Markdown link URL" },
	// Markdown行内代码文字前景。
	mdCode: { slot: "foreground", description: "Markdown inline code" },
	// Markdown代码块正文基础前景，具体语法高亮另有syntax字段。
	mdCodeBlock: { slot: "foreground", description: "Markdown code block content" },
	// Markdown代码块围栏的前景。
	mdCodeBlockBorder: { slot: "foreground", description: "Markdown code block fences" },
	// Markdown引用正文前景。
	mdQuote: { slot: "foreground", description: "Markdown blockquote text" },
	// Markdown引用边框前景。
	mdQuoteBorder: { slot: "foreground", description: "Markdown blockquote border" },
	// Markdown水平分隔线前景。
	mdHr: { slot: "foreground", description: "Markdown horizontal rule" },
	// Markdown列表的点号/数字前景。
	mdListBullet: { slot: "foreground", description: "Markdown list bullets/numbers" },
	// 工具diff新增行前景，不在这里计算差异。
	toolDiffAdded: { slot: "foreground", description: "Added lines in tool diffs" },
	// 工具diff删除行前景。
	toolDiffRemoved: { slot: "foreground", description: "Removed lines in tool diffs" },
	// 工具diff上下文行前景。
	toolDiffContext: { slot: "foreground", description: "Context lines in tool diffs" },
	// 语法高亮的源码注释前景。
	syntaxComment: { slot: "foreground", description: "Syntax highlighting: comments" },
	// 语法高亮的关键字前景，例如return。
	syntaxKeyword: { slot: "foreground", description: "Syntax highlighting: keywords" },
	// 语法高亮的函数名前景。
	syntaxFunction: { slot: "foreground", description: "Syntax highlighting: function names" },
	// 语法高亮的变量名前景。
	syntaxVariable: { slot: "foreground", description: "Syntax highlighting: variable names" },
	// 语法高亮的字符串字面量前景。
	syntaxString: { slot: "foreground", description: "Syntax highlighting: string literals" },
	// 语法高亮的数字字面量前景。
	syntaxNumber: { slot: "foreground", description: "Syntax highlighting: number literals" },
	// 语法高亮的类型名前景。
	syntaxType: { slot: "foreground", description: "Syntax highlighting: type names" },
	// 语法高亮的运算符前景。
	syntaxOperator: { slot: "foreground", description: "Syntax highlighting: operators" },
	// 语法高亮的标点前景，不等于TS解析器的语法规则。
	syntaxPunctuation: { slot: "foreground", description: "Syntax highlighting: punctuation" },
	// 思考关闭时的边框前景；这些字段只是按级别提供样式，不配置模型推理预算。
	thinkingOff: { slot: "foreground", description: "Thinking level border: off" },
	// minimal级别边框前景。
	thinkingMinimal: { slot: "foreground", description: "Thinking level border: minimal" },
	// low级别边框前景。
	thinkingLow: { slot: "foreground", description: "Thinking level border: low" },
	// medium级别边框前景。
	thinkingMedium: { slot: "foreground", description: "Thinking level border: medium" },
	// high级别边框前景。
	thinkingHigh: { slot: "foreground", description: "Thinking level border: high" },
	// xhigh级别边框前景，也是下方max的兼容回退来源。
	thinkingXhigh: { slot: "foreground", description: "Thinking level border: xhigh" },
	// max级别可省，缺省沿用xhigh颜色，不代表把模型的max请求降成xhigh。
	thinkingMax: {
		// 同为前景槽，才能回退thinkingXhigh。
		slot: "foreground",
		// 描述文字被schema消费，实际补值在Theme构建时。
		description: "Thinking level border: max (falls back to thinkingXhigh when omitted)",
		// 指向上面已经声明的字段。
		fallback: "thinkingXhigh",
	},
	// 输入框处于bash模式时的边框前景，不负责执行shell命令。
	bashMode: { slot: "foreground", description: "Editor border color in bash mode" },
});

// typeof在类型位置取名册对象类型，keyof提取所有字段名的字符串字面量联合，如"accent"|"border"等。
export type ThemeToken = keyof typeof THEME_TOKENS;
// 映射类型先逐token建立中间对象，再在下一行索引所有键，筛出前景名字联合。
export type ThemeColor = {
	// T[K]是索引访问类型；条件类型让前景键留下K，背景键变never（无可取值的类型）。
	[K in ThemeToken]: (typeof THEME_TOKENS)[K]["slot"] extends "foreground" ? K : never;
	// 索引所有属性值形成联合，never在联合中消失；整个过程只在TS检查期发生。
}[ThemeToken];
// Exclude从全部token名字中去掉前景名字，余下得到背景名字，不运行数组过滤。
export type ThemeBg = Exclude<ThemeToken, ThemeColor>;

// 同样用映射/条件类型找出声明了必需fallback:string属性的具体字段，供主题JSON将其设成可选。
type OptionalToken = {
	// 这里检查的是const泛型保留下来的具体字段类型，不是所有Descriptor都带fallback。
	[K in ThemeToken]: (typeof THEME_TOKENS)[K] extends { fallback: string } ? K : never;
	// 取得筛选后的名字联合，例如scrollbarTrack、thinkingMax等。
}[ThemeToken];

// 没有fallback的剩余token必须由主题提供，例如accent和text。
type RequiredToken = Exclude<ThemeToken, OptionalToken>;

// 泛型Value让同一组字段可承载原始string|number或其他颜色表示，而不用重复列名。
export type ThemeColorValues<Value> = {
	// 所有必填token都映射到Value，例如ThemeColorValues<string|number>要求accent等有值。
	[K in RequiredToken]: Value;
	// &交叉类型要求同时满足两块对象结构，不是执行合并对象的...操作。
} & {
	// 可回退的token用?标为可选；缺省时不由TS补值，仍要Theme的运行函数处理。
	[K in OptionalToken]?: Value;
};

// 补完回退后每个token都应有Value，用Record表达完整字典；这个类型本身不执行补值或校验。
export type ResolvedThemeColorValues<Value> = Record<ThemeToken, Value>;
