/**
 * 解析模型交来的“JavaScript正文 + 可选首行配置”，供coding-agent的codemode入口使用。
 * 这里只拆分/校验配置，不编译JS、不执行脚本，也不自动落实输出预算或超时；调用方决定如何采用options。
 * 例如首行 // @options: {"timeout_ms":1000}，下一行 return 1，会得到以换行开头的code及timeoutMs:1000。
 */
/**
 * Codemode source format: JavaScript, optionally preceded by one options line.
 *
 * ```js
 * // @options: {"max_output_tokens": 2000, "timeout_ms": 30000}
 * const text = await tools.read({ path: "package.json" });
 * text(JSON.parse(text).name);
 * ```
 */

// export把常量交给其他模块；字符串中的//是配置标记的一部分，不是这里新开的注释。
export const CODEMODE_OPTIONS_PREFIX = "// @options:";

// as const让数组成为只读字面量元组，元素类型是这两个确切字段名，而不是任意string。
const SUPPORTED_FIELDS = ["max_output_tokens", "timeout_ms"] as const;
// 多处错误共用可支持字段的提示文字。
const SUPPORTED_FIELDS_TEXT = "`max_output_tokens` and `timeout_ms`";
/** Largest delay `setTimeout` supports, which bounds `timeout_ms`. */
// 数字中的_只分组便于读；上限来自setTimeout可接受的有符号32位延时。
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Lark grammar for providers with grammar-constrained tool input. It only fixes the shape of the
 * options line; the options JSON and the code are checked by {@link parseCodemodeSource}.
 */
// String.raw保留反斜杠给Lark解释；模板正文是运行时语法文本，不应当作TS代码修改。
// 语法只规定外形：可选首行+非空正文。SOURCE可含空白；JS语法与安全性均不由它验证。
export const CODEMODE_SOURCE_GRAMMAR = String.raw`
start: options_source | plain_source
options_source: OPTIONS_LINE NEWLINE SOURCE
plain_source: SOURCE

OPTIONS_LINE: /[ \t]*\/\/ @options:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

/** 转成宿主习惯的驼峰字段名；interface只约束编译期，不会自己启动计时或截断。 */
export interface CodemodeSourceOptions {
	/** Token budget for the script's output. */
	// ?表示字段可缺；允许0，实际预算行为交由调用方。
	maxOutputTokens?: number;
	/** Hard deadline for the whole script in milliseconds, including tool calls. */
	// 毫秒数；本解析器只允许正安全整数及定时器上限内的值，调用方的计时范围需另看执行层。
	timeoutMs?: number;
}

/** 解析结果：保留正文行号的脚本和独立配置。 */
export interface ParsedCodemodeSource {
	/** The script with the options line replaced by an empty line, so line numbers are unchanged. */
	// 有配置时从原首个LF处切片，因此第一行变空，后续报错行号仍对应输入。
	code: string;
	// 无配置就是{}，不在这里填默认预算。
	options: CodemodeSourceOptions;
}

/** 配置/空输入错误的专用类别；调用方可区分“输入不合规”和真正的脚本运行失败。 */
export class CodemodeSourceError extends Error {
	/** 接受具体原因，例如未知字段；调用Error构造器保存message，再设置可读name。 */
	constructor(message: string) {
		// 子类构造器先super，初始化Error的message等基础状态。
		super(message);
		// name影响错误显示文字；类的继承关系仍由extends Error决定。
		this.name = "CodemodeSourceError";
	}
}

/** 判断JSON边界来的unknown是否为非负安全整数；例0成立、1.5/字符串"1"不成立。value is number帮助TS在成功分支收窄。 */
function isSafeInteger(value: unknown): value is number {
	// 先确认数字，再检查整数精度范围和非负；&&遇到false即停止后续判断。
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 严格解析配置JSON对象并换字段名；例max_output_tokens:0转maxOutputTokens:0。未知键/错误类型均抛CodemodeSourceError，无IO。 */
function parseOptions(directive: string): CodemodeSourceOptions {
	// 空配置文字和合法空对象{}不同。
	if (directive === "") {
		// 模板插值把支持字段列表带入具体错误。
		throw new CodemodeSourceError(`@options must be a JSON object with supported fields ${SUPPORTED_FIELDS_TEXT}`);
	}
	// JSON.parse的返回值先按unknown持有，验证后才读取字段。
	let value: unknown;
	// try只包JSON解析，不把后面的字段错误误写成JSON语法错误。
	try {
		// JSON要求双引号键；不接受JS对象字面量或JSON注释。
		value = JSON.parse(directive);
		// catch值可能不是Error，下面按实际类别提取原因。
	} catch (error) {
		// 包成统一输入错误，保留JSON解析原因。
		throw new CodemodeSourceError(
			// instanceof检查捕获的外部异常；三元表达式在两个提示来源中选一个。
			`@options must be valid JSON with supported fields ${SUPPORTED_FIELDS_TEXT}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	// JSON信任边界：只接普通对象形状，明确排除null和数组；不对正文代码做类似验证。
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		// 非对象无法作为命名选项容器，直接失败。
		throw new CodemodeSourceError(`@options must be a JSON object with supported fields ${SUPPORTED_FIELDS_TEXT}`);
	}
	// as是编译期断言，不复制/转换对象；Record<string,unknown>表示键可读、值仍需检查。
	const fields = value as Record<string, unknown>;
	// Object.keys只遍历JSON对象自己的可枚举字符串键。
	for (const key of Object.keys(fields)) {
		// 把只读字面量元组临时视为只读string数组，使includes可接收任意待验键。
		if (!(SUPPORTED_FIELDS as readonly string[]).includes(key)) {
			// 不静默忽略拼错的选项，否则用户可能以为超时已生效。
			throw new CodemodeSourceError(`@options only supports ${SUPPORTED_FIELDS_TEXT}; got \`${key}\``);
		}
	}
	// 构造独立输出对象，只写已验证且确实提供的字段。
	const options: CodemodeSourceOptions = {};
	// 解构取原JSON的蛇形命名字段；没有的字段值为undefined。
	const { max_output_tokens, timeout_ms } = fields;
	// 只在提供时检查；显式null会进入检查并被拒绝。
	if (max_output_tokens !== undefined) {
		// 输出预算允许0，但拒绝负数、小数、字符串或不安全的大整数。
		if (!isSafeInteger(max_output_tokens)) {
			// 抛错会终止解析，不会返回一半配置。
			throw new CodemodeSourceError("@options field `max_output_tokens` must be a non-negative safe integer");
		}
		// 控制流已把unknown收窄为number，换成宿主字段名。
		options.maxOutputTokens = max_output_tokens;
	}
	// timeout是独立可选字段，不依赖是否设置输出预算。
	if (timeout_ms !== undefined) {
		// 在非负安全整数基础上排除0，并限制到setTimeout延时上限。
		if (!isSafeInteger(timeout_ms) || timeout_ms === 0 || timeout_ms > MAX_TIMEOUT_MS) {
			// 给出当前支持的最大值。
			throw new CodemodeSourceError(
				// 反引号在模板内转义，用于错误中的字段名格式。
				`@options field \`timeout_ms\` must be a positive integer up to ${MAX_TIMEOUT_MS}`,
			);
		}
		// 保存毫秒数；没有在此创建setTimeout。
		options.timeoutMs = timeout_ms;
	}
	// 仅返回配置，不改调用方的脚本文本。
	return options;
}

/**
 * Split an optional first-line `// @options: {...}` from the script. Throws
 * {@link CodemodeSourceError} for empty input, invalid options, and an options line that is not the
 * first line, which would otherwise be ignored without notice.
 */
/**
 * 入口流程：拒绝空输入→按行找错位配置→识别首行→保留原换行切正文→解析配置。
 * parseCodemodeSource("return 1")原样返回code和{}；配置必须真正在输入第一行，不能前置空行。
 * 注意：错位检测是文本前缀扫描，连多行字符串里以该前缀开头的行也可能被拒绝；这里不是JS词法分析器。
 * 不判断正文是否可编译；例如非空但非法的JS会交给后面的QuickJS处理。
 */
export function parseCodemodeSource(input: string): ParsedCodemodeSource {
	// trim只用于判断，不会把返回的普通正文整体去掉首尾空白。
	if (input.trim() === "") {
		// 空或纯空白输入直接报告缺少脚本。
		throw new CodemodeSourceError(
			// 提示可选首行的写法，字符串本身是错误内容。
			'Expected JavaScript source text (non-empty). Provide JS only, optionally with a first line `// @options: {"max_output_tokens": 1000}`.',
		);
	}
	// 按LF分行；CRLF中的CR稍后仅从首行末尾去掉。
	const lines = input.split("\n");
	// findIndex返回第一条错位标记下标，没找到为-1。
	const misplaced = lines.findIndex(
		// index>0排除首行；trimStart允许缩进，但startsWith仍要求确切前缀。
		(line, index) => index > 0 && line.trimStart().startsWith(CODEMODE_OPTIONS_PREFIX),
	);
	// 后续任何一行命中配置前缀都会拒绝，不会悄悄当普通注释忽略。
	if (misplaced !== -1) {
		// 输入错误的可读行号按1开始。
		throw new CodemodeSourceError(
			// 数组下标从0开始，所以加1。
			`The ${CODEMODE_OPTIONS_PREFIX} line must be the first line of the input; found one on line ${misplaced + 1}`,
		);
	}
	// 记录原文本首个LF位置；只有配置行而没有LF时为-1。
	const newline = input.indexOf("\n");
	// /\r$/仅去掉首行末尾CR，兼容CRLF；没用m标志，不会在其他行末匹配。
	const firstLine = lines[0].replace(/\r$/, "");
	// 只去首行前导空白以识别配置。
	const trimmed = firstLine.trimStart();
	// 没有配置就返回原input，甚至不改换行或缩进。
	if (!trimmed.startsWith(CODEMODE_OPTIONS_PREFIX)) return { code: input, options: {} };
	// 从LF本身开始保留，换成空首行；不是slice(newline+1)，否则后续行号会少1。
	const code = newline === -1 ? "" : input.slice(newline);
	// 配置后必须还有非空白正文；仅一条普通JS注释也算非空白，是否产生效果由VM决定。
	if (code.trim() === "") {
		// 仅配置、只有换行或空白正文都在此失败。
		throw new CodemodeSourceError("The @options line must be followed by JavaScript source on subsequent lines");
	}
	// 切掉确切前缀和两侧空白后解析JSON；对象简写{code}等同code:code。
	return { code, options: parseOptions(trimmed.slice(CODEMODE_OPTIONS_PREFIX.length).trim()) };
}
