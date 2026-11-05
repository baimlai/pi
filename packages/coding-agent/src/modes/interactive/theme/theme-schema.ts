// 构建并编译用户主题的JSON Schema，提供validateThemeJson给main安装到theme.ts；单独模块避免只用内置主题时因运行时导入校验器而加载TypeBox依赖图。
// 这里验证字段形状、必需颜色槽及数值范围，不解析变量引用/具体颜色语法，不填主题回退值；生成schemas/theme.schema.json的脚本也复用这些schema，生成文件不在这里手改。
/**
 * Theme JSON validation, kept out of `theme.ts` on purpose.
 *
 * Validating user-authored theme files needs typebox, which costs ~17 MB of module graph to import.
 * Palette lookup does not, so a presentation that only uses built-in themes should never pay for it.
 * `main.ts` installs this validator before runtime resource loading; other consumers can opt in with
 * `setThemeJsonValidator()`. Built-in themes do not need validation.
 */

// Type是运行时schema工厂；Static从schema推导TS类型，TProperties描述字段到子schema的映射，这两个type导入在JS中擦除。
import { type Static, type TProperties, Type } from "typebox";
// Compile把schema变成可复用Validator；后面使用Check和Errors，不调用Convert/Default/Parse去修复数据。
import { Compile } from "typebox/compile";
// 读取唯一主题token表及其类型：名称/描述/是否有fallback决定字段规则，ThemeColorValues把必需和可选token映射为值类型。
import { THEME_TOKENS, type ThemeColorValues, type ThemeTokenDescriptors } from "./theme-tokens.ts";

// 创建一个颜色值schema，输入可选描述，返回TypeBox联合schema；例：colorValue("背景")允许字符串或0..255整数。不验证某个具体值，也不解码/转换颜色，只分配schema对象。
// 字符串分支没有pattern/format，因此"bogus"同样能通过这个值schema；后续theme.ts解析变量、TUI parseColor才可能发现语义错误。
function colorValue(description?: string) {
	// Union生成anyOf规则，后续值满足任一分支即可，不要求同时为文字和数字。
	return Type.Union(
		// 数组按下面顺序提供字符串与整数两个子schema，不是实际主题的颜色数组。
		[
			// 声明任意字符串分支，下面description只作编辑器指引，不限制字符或颜色格式。
			Type.String({
				// description的值写在下一行，作为schema注解保存。
				description:
					// 这段英文列出使用意图：hex/OKLCH/OKHSL、变量引用或终端默认空串；它自身不是可执行校验规则。
					"Hex color (#RGB or #RRGGBB), OKLCH or OKHSL color, variable reference, or empty string for terminal default",
			}),
			// 声明数值须为整数，区别于允许小数的Type.Number；Static仍会把它推成TS number。
			Type.Integer({
				// 运行时schema要求整数至少为0，包含边界。
				minimum: 0,
				// 最大255也包含边界；不能靠TS number本身表达这个范围。
				maximum: 255,
				// 整数分支的说明文字，实际范围由minimum/maximum约束。
				description: "256-color palette index (0-255)",
			}),
		],
		// 真值description才给整个联合另加描述，空字符串走空选项；不改前面两个分支自带的说明。
		description ? { description } : {},
	);
}

// 构造并导出无整体描述的公共颜色值schema，运行时可编译/生成文档复用，而非导出一份实际颜色。
export const ColorValueSchema = colorValue();

// Static<typeof ...>先取得schema的类型再推导值类型，结果为string | number；整数/0..255的运行时限制不能由这个普通TS联合完整表达。
export type ThemeColorValue = Static<typeof ColorValueSchema>;

// 把token描述表转成TypeBox属性表，输入只读描述映射，返回新TProperties对象；例：accent无fallback为必填，scrollbarTrack有fallback为可选。只建立规则，不把fallback颜色填到主题。
// Object.entries只取自有可枚举字符串键；不修改输入，描述读取/schema构造若抛错会向外传播。
function themeTokenProperties(tokens: ThemeTokenDescriptors): TProperties {
	// 创建新属性表；类型注解TProperties让各键的值是schema，但擦掉了编译期对具体token名字的精确推断。
	const properties: TProperties = {};
	// for...of遍历[name,descriptor]键值对，数组解构分别取得名称与描述对象。
	for (const [name, descriptor] of Object.entries(tokens)) {
		// 每个token创建自己的颜色schema，保留描述供编辑器提示。
		const schema = colorValue(descriptor.description);
		// fallback严格为undefined时必需；提供任何非undefined fallback就用Optional标记可省略，既不验证该回退名，也不生成实际默认值，回退名检查在token表构造中。
		properties[name] = descriptor.fallback === undefined ? schema : Type.Optional(schema);
	}
	// 返回新建字段schema映射，不是颜色值对象。
	return properties;
}

// Unsafe<ThemeColorValues<ThemeColorValue>>补上精确的TS必需/可选token映射；动态生成属性表不易自动推断这些键。Unsafe保留传入对象schema的type/properties/required等运行时规则，不是让所有输入跳过检查。
const ThemeColorsSchema = Type.Unsafe<ThemeColorValues<ThemeColorValue>>(
	// 按token表生成对象schema，Type.Object把未标Optional的属性列为required；这一步仍是在定义规则，不检查某份主题。
	Type.Object(themeTokenProperties(THEME_TOKENS), {
		// 颜色集合的总体说明文字在下一行。
		description:
			// 说明可选颜色有兼容回退；实际补回退由theme.ts的withThemeTokenFallbacks完成，不在本schema或Check中。
			"Theme color definitions (scrollbar, thinkingMax, and search highlight colors are optional and use compatible fallbacks)",
		// colors中不允许额外token键，拼错scrollbarThmb会报错，不会默默删除未知键。
		additionalProperties: false,
	}),
);

// 顶层主题对象schema：花括号定义属性，第二组选项给说明/未知字段策略。export供运行时编译与JSON Schema生成器复用，不会因此加载用户文件。
export const ThemeJsonSchema = Type.Object(
	// 下面这一层是主题字段映射，而不是一份具体主题配置。
	{
		// 可选$schema字段只要求字符串；不会按该URL下载或切换另一份校验器，也不验证URI格式。
		$schema: Type.Optional(Type.String({ description: "JSON schema reference" })),
		// 必需name为字符串，下方pattern再限制名字形状。
		name: Type.String({
			// ^和$要求匹配整串，[^/]排除斜杠，+要求至少一个字符；没有限制空白、反斜杠或其他文件名字符，不等于完整文件名/路径安全规则。
			pattern: "^[^/]+$",
			// 名称的额外说明注解写在下一行。
			description:
				// 解释禁用斜杠是为自动light/dark主题配置保留分隔写法；直接校验函数还会优先给这一类错误专用提示。
				"Theme name. Must not contain '/' because it is reserved for automatic light/dark theme settings.",
		}),
		// appearance字段整体可省略，Optional不自动推断或填入light/dark。
		appearance: Type.Optional(
			// Union中的两个Literal只允许精确"dark"或"light"，并非所有字符串。
			Type.Union([Type.Literal("dark"), Type.Literal("light")], {
				// 省略时从颜色判断外观是后续消费方行为；本schema的description不执行检测。
				description: "Background the theme is designed for. Detected from the theme colors when omitted.",
			}),
		),
		// vars整体可省略，表示可重用颜色变量表；不自动创建空对象或检测变量引用环。
		vars: Type.Optional(
			// Record以字符串键schema和值schema构建patternProperties；普通变量名映射到ColorValueSchema。它并不在这里解析引用，底层字符串键pattern也不是变量标识符语法验证器。
			Type.Record(Type.String(), ColorValueSchema, {
				// 变量表说明用于编辑器展示，没有额外变量解析逻辑。
				description: "Reusable color variables",
			}),
		),
		// colors本身必需，内部各token是否必需由前面ThemeColorsSchema决定。
		colors: ThemeColorsSchema,
		// 可选HTML导出颜色区段，与终端主题colors分开描述。
		export: Type.Optional(
			// 导出区段有自己的对象规则，内部字段都可省略。
			Type.Object(
				// 下面三项是已知的导出背景属性，不包含任意额外键。
				{
					// 可选页面背景，仍为字符串或0..255整数，说明不验证颜色语法。
					pageBg: Type.Optional(colorValue("Page background color")),
					// 可选卡片/容器背景，同样复用颜色规则。
					cardBg: Type.Optional(colorValue("Card/container background color")),
					// 可选信息区背景；这里只建立字段schema，不实际渲染HTML。
					infoBg: Type.Optional(colorValue("Info sections background (system prompt, notices)")),
				},
				// 这是export对象本身的选项，区别于顶层对象选项。
				{
					// 说明默认导出色可由userMessageBg推导，但这里没有default值或计算；theme.ts读取显式导出值，core/export-html/index.ts再为缺省项推导背景。
					description: "Optional colors for HTML export (defaults derived from userMessageBg if not specified)",
					// export对象也拒绝额外属性，规则不自动扩展到其他独立对象。
					additionalProperties: false,
				},
			),
		),
	},
	// 第二个参数为顶层schema注解与额外属性策略。
	{
		// 供编辑器/文档展示的schema标题，不是强制要求主题name等于此标题。
		title: "Pi Coding Agent Theme",
		// 顶层schema说明，生成公开配置schema时会保留。
		description: "Theme schema for Pi coding agent",
		// 顶层未知字段不允许；合法字段中vars的动态键按自己的Record规则另查。
		additionalProperties: false,
	},
);

// 模块加载时编译一次并保存Validator，避免每份主题重复编译；它在内存构建检查逻辑，不读取主题文件或发网络请求，编译本身若失败会使模块加载失败。
const compiledThemeSchema = Compile(ThemeJsonSchema);

// 从完整schema推导主题值的TS类型，其中colors的精确键形状来自前面Unsafe泛型；类型不代替运行时检查或变量/颜色语义解析。
export type ValidatedThemeJson = Static<typeof ThemeJsonSchema>;

/** Validate one theme document, throwing a message that names the offending tokens. */
// 验证一份已解析主题值：先给name中的斜杠专用报错，再Check schema，失败收集诊断并按缺颜色/其他错误组装消息，成功返回原对象。输入label只用于通用报错展示，json为外部unknown。
// 例：用内置dark主题结构但colors:{}会抛Missing required color tokens；name:"a/b"先报名字错误。只验证、不Convert、不补fallback、不深复制，任意颜色字符串仍可能在后续变量/颜色解析失败；特殊getter/库调用异常也会传播。
export function validateThemeJson(label: string, json: unknown): ValidatedThemeJson {
	// 用&&短路检查能安全读取的名字形状，下面并不是完整对象schema检查。
	if (
		// 先要求typeof为object；这本身仍会把null和数组算作object。
		typeof json === "object" &&
		// 单独排除null，避免后续in操作对null抛错。
		json !== null &&
		// in也检查继承name键，这里没有限定自有键或排除数组/类实例。
		"name" in json &&
		// 名字为字符串才调用includes，不把数字等自动转成字符串。
		typeof json.name === "string" &&
		// 字符串只要含一个正斜杠就提前失败，不等schema.Check枚举其他错误。
		json.name.includes("/")
	) {
		// 创建并throw专用Error，本次校验到此结束，不附后面的统一label/错误列表。
		throw new Error(
			// 模板直接插入主题自带name，说明斜杠保留规则；不是label替代值，也不转义显示文字。
			`Invalid theme name "${json.name}": theme names cannot contain "/" because it is reserved for automatic light/dark theme settings.`,
		);
	}

	// Check只返回是否合schema，不调用Parse/Convert/Default修正输入；失败才进入诊断组装分支，成功走最后原值返回。
	if (!compiledThemeSchema.Check(json)) {
		// 本机TypeBox Errors返回诊断数组，Array.from再复制成一个新数组；不是从惰性迭代器逐条拉取的专有流程，也不承诺完整业务语义错误都在这里。
		const errors = Array.from(compiledThemeSchema.Errors(json));
		// Set<string>累计缺失token名称并去重；尖括号只约束TS元素类型。
		const missingColors = new Set<string>();
		// 创建其他错误说明数组，string[]表示文本数组，保留收到的诊断顺序。
		const otherErrors: string[] = [];

		// 遍历库返回的每条错误，不在第一个错误就停止拼消息。
		for (const error of errors) {
			// 只把required且instancePath精确为/colors的错误归为缺颜色；顶层缺colors的required路径不同，仍归其他错误。
			if (error.keyword === "required" && error.instancePath === "/colors") {
				// 把该错误params按预期字段形状作TS断言并读requiredProperties，不运行Array.isArray或新的验证；这个库版本的required错误会聚合缺失键数组。
				const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
				// 有缺失键数组就逐项走，没有/undefined则按空数组处理；??不是把任意非法值都转数组。
				for (const requiredProperty of requiredProperties ?? []) {
					// 添加缺色名称，同名不会重复输出。
					missingColors.add(requiredProperty);
				}
				// 本类错误处理后跳过通用说明；即使params里没有名字，也不会再加入otherErrors。
				continue;
			}

			// JSON Pointer形式的instancePath空串代表根，||在此用/作显示替代；非空路径原样保留。
			const path = error.instancePath || "/";
			// 将路径和库已提供的message合成一行，push改的是本地说明数组，不修改主题或库错误对象。
			otherErrors.push(`  - ${path}: ${error.message}`);
		}

		// 可重新赋值的let累积最终消息，使用调用方label标识哪份文档；模板里的换行是实际错误格式，保留原文字。
		let errorMessage = `Invalid theme "${label}":\n`;
		// 只有聚合到至少一个缺色名称才加这一节，Set.size是去重后的数量。
		if (missingColors.size > 0) {
			// 追加缺必需颜色的英文节标题。
			errorMessage += "\nMissing required color tokens:\n";
			// 将Set复制为数组，下面排序/map/join只作用于这个新数组，不改token表。
			errorMessage += Array.from(missingColors)
				// 默认字符串排序使名称输出稳定，不按token定义顺序或严重程度排序。
				.sort()
				// 箭头回调把每个颜色名变成带缩进的项目文字。
				.map((color) => `  - ${color}`)
				// 用换行连接所有缺色项目，得到一段说明字符串。
				.join("\n");
			// 追加人工修复建议，不在程序里真的给colors插值；引号转义只是构造错误文字。
			errorMessage += '\n\nPlease add these colors to your theme\'s "colors" object.';
			// 建议参照两份内置主题，不在此读取这些JSON文件或选它们当默认主题。
			errorMessage += "\nSee the built-in themes (dark.json, light.json) for reference values.";
		}
		// 其他诊断非空时才追加第二节，缺色/其他错误可以同时展示。
		if (otherErrors.length > 0) {
			// 用换行合并现有其他说明，不额外排序或去重这些诊断。
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}

		// throw统一Error使调用者得到失败；不会返回部分校验/部分填值的主题。
		throw new Error(errorMessage);
	}

	// 成功时仅断言返回类型并交还同一json引用；不冻结、不复制，不解析vars、不补可选颜色或导出默认色。
	return json as ValidatedThemeJson;
}
