// 流式工具参数的增量预览解析器：每次只扫新增片段，保留尚未闭合字符串/容器，并按预算复制开放路径生成稳定快照；结束后另做严格完整解析。
/**
 * Incremental, tolerant parsing of JSON text that arrives in pieces, such as streamed tool-call arguments.
 *
 * `StreamingJsonParser.append()` reads each piece once, so a stream costs time and memory linear in its length, and
 * `snapshot()` returns the value of the text read so far. Snapshots are plain JSON values and never change once
 * returned: the parser copies the containers that are still open (the "open path") into every new snapshot and shares
 * completed containers and strings. The rules for incomplete text follow `parseStreamingJson()`:
 *
 * - An unterminated string shows the characters read so far; an unterminated escape is held back until complete.
 * - An unterminated container shows the members and elements read so far.
 * - A member whose key or value has not started is omitted.
 * - An unterminated literal shows its value once it is a prefix of `true`, `false` or `null`; an unterminated number
 *   shows its value when the digits read so far form a number (an exponent without digits is ignored).
 *
 * Malformed text is read leniently, the way `repairJson()` and `parseStreamingJson()` treat it: raw control characters
 * in strings are kept, an invalid escape such as `\d` stays literal text, missing commas and colons are tolerated,
 * values in invalid positions and unknown words are dropped, and text after the root value is ignored. The parser never
 * throws. Callers that need the exact value of the finished text parse it once, e.g. with `parseToolCallArguments()`.
 *
 * Differences from `parseStreamingJson()` on incomplete text: trailing whitespace inside an unterminated string is
 * kept (it was trimmed), a string that contains a raw control character or an invalid escape stays visible while it
 * streams (it was dropped until the document was complete), and `NaN` and `Infinity` words are dropped.
 *
 * `append()` also returns the changes the piece made, for a writer that keeps its own copy of the value and applies
 * them instead of re-assigning snapshots: `set` when a key, an array item or a finished value appears (a new string is
 * set once with its first text, a container empty), `append` when the piece extended an open string. Unterminated
 * numbers and literals are not reported until they end. A container nested more than 32 levels deep is reported as one
 * `set` of its whole value when it closes, so paths stay short.
 *
 * Cost: copying the open path costs its member and element count. Each `append()` earns copy credit proportional to its
 * length plus a constant; `snapshot()` spends it and returns the previous snapshot while the open path costs more than
 * the credit. So a document that keeps a very large container open (thousands of elements) shows a preview that lags
 * a little behind the text, and no input makes the total work grow faster than the text.
 */

// JsonValue是合法JSON值联合类型，ToolCall提供最终工具参数对象类型；这些类型不负责验证远端字符流。
import type { JsonValue, ToolCall } from "../types.ts";
// 调用结束时走严格完整参数解析，不能仅凭本模块容错预览执行工具。
import { parseToolCallArguments } from "./json-parse.ts";

// 容器只包括对象/数组，不包括字符串等标量；索引签名描述任意字符串键对应JSON值。
type JsonContainer = { [key: string]: JsonValue } | JsonValue[];

/** Where a value sits in its parent; absent for a value in an invalid position, which is read but dropped. */
// 一个值在父级中的位置；用kind作为标签，TS可据此知道是根、对象键还是数组下标。
type Slot =
	// 根值没有父容器，直接写解析器的root字段。
	| { readonly kind: "root" }
	// 对象成员位置用字符串key定位，readonly限制开发期改写位置描述。
	| { readonly kind: "member"; readonly key: string }
	// 数组元素位置用从0开始的index定位。
	| { readonly kind: "element"; readonly index: number };

/** A path from the root value: member keys and array indices. */
// 外部增量路径，例如["files",0,"path"]；字符串是对象键、数字是数组下标。
export type JsonPath = readonly (string | number)[];

/** One change a piece of text made to the value; see the module comment. */
// 对调用方报告的不可变约定增量：设置一个值，或给已有字符串追加文本。
export type JsonChange =
	// set可首次建立字段、容器或完整标量；path为空数组代表根。
	| { readonly kind: "set"; readonly path: JsonPath; readonly value: JsonValue }
	// append仅追加字符串片段，不是向JSON数组push。
	| { readonly kind: "append"; readonly path: JsonPath; readonly text: string };

/** A change still being extended by the piece being read. */
// 当前append正在累计的内部变更；在本片段结束前允许继续扩充，输出后不再改它。
type OpenChange =
	// 一个片段内相邻字符串增量可以合并进首次set的value。
	| { kind: "set"; readonly path: JsonPath; value: JsonValue }
	// 已有字符串的后续增量累加text，避免每个字符都发独立变更。
	| { kind: "append"; readonly path: JsonPath; text: string };

/** An open object or array. Its `container` is never handed out while open; snapshots get copies. */
// 一层未关闭容器的工作状态；stack中每项对应一个开放对象/数组，不直接作为未闭合快照交给外部。
type Frame = {
	// 实际工作容器引用，解析过程中会修改它；readonly仅不许换引用，不禁止改其内容。
	readonly container: JsonContainer;
	// 该容器在父级的位置；非法位置的容器会继续读取但结果可被丢弃。
	readonly slot: Slot | undefined;
	/** Where the container sits, when its changes are reported. */
	// 对外报告增量用的路径；太深或非法位置时可无路径。
	readonly path: JsonPath | undefined;
	/** Whether changes inside it are reported; when not, its whole value is reported as it closes. */
	// 是否逐项报告内部变更；深度太大时改为容器关闭后一次报告整体。
	readonly reportsInside: boolean;
	/** Members or elements; what a copy of the container costs. */
	// 已创建的成员/元素个数，用来计算复制开放路径所需工作量。
	size: number;
	/** Objects: the key read last, where the member value goes. */
	// 对象里最新读完的键，等后面的值写入该键。
	key: string | undefined;
	// 对象扫描阶段；联合字符串比多个布尔开关更容易表达当前期待什么。
	phase: "key" | "colon" | "value" | "comma";
};

/** An unterminated string. */
// 跨片段尚未闭合的字符串；既可能是对象键，也可能是普通字符串值。
type OpenString = {
	// 键尚未完成前不能创建对象成员；普通值则可边读边预览。
	readonly target: "key" | "value";
	// 当前字符串值在父级的位置；对象键字符串本身还不是一个可写入的成员值。
	readonly slot: Slot | undefined;
	// 已经解码出的字符串内容，尚未完成的转义不会提前塞进来。
	text: string;
	/** Escape read so far: "" for none, otherwise a backslash and up to five more characters. */
	// 未读完的转义暂存：空表示无转义，其他可能是单反斜杠或反斜杠u加部分数字。
	escape: string;
	/** Where a value string sits, when its changes are reported. */
	// 对外报告增量用的路径；太深或非法位置时可无路径。
	readonly path: JsonPath | undefined;
	/** The change this string extends, while it is the newest change of the piece. */
	// 当前输入片段里此字符串最新可扩充的变更，进入新片段时清掉旧引用。
	change: OpenChange | undefined;
};

// Changes are reported at most this deep, so a path costs O(1) to build.
// 外部增量路径最多报告到32层，限制构造路径的成本；更深内容在关闭时整体报告。
const MAX_REPORTED_DEPTH = 32;

// 复用根位置对象，不必每次读根值都重新分配。
const ROOT_SLOT: Slot = { kind: "root" };
// Copy credit per append and per appended character. The floor keeps small documents fresh at every snapshot.
// 每次append固定获得256份复制预算，让小文档可及时产生快照。
const CREDIT_PER_APPEND = 256;
// 每新增字符再获得8份预算，限制重复复制巨大开放容器的总工作量。
const CREDIT_PER_CHARACTER = 8;
// An unterminated number longer than this is not shown until it ends, so `snapshot()` stays cheap.
// 尚未结束的数字/字面量超过64字符时暂不预览，避免snapshot反复解析巨长标量。
const MAX_PENDING_SCALAR_LENGTH = 64;
// 完整JSON数字语法，允许负号、小数和指数；拒绝前导零、不完整小数/指数等。
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
// 专门提取尚未读完指数的尾数，例如1.5e+可先预览1.5；捕获组1保存尾数。
const NUMBER_WITHOUT_EXPONENT_DIGITS = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?)[eE][+-]?$/;
// 字面量文本与实际值的二元组表，readonly限制数组写操作。
const LITERALS: readonly [string, JsonValue][] = [
	// 文本true对应布尔true；不把字符串"true"当最终值。
	["true", true],
	// 文本false对应布尔false。
	["false", false],
	// 文本null对应JSON空值，而undefined用于“尚无值”。
	["null", null],
];

// 双引号的字符编码，用于快速扫描字符串边界。
const QUOTE = 0x22;
// 反斜杠字符编码，用于发现转义序列。
const BACKSLASH = 0x5c;

/** Incremental, tolerant JSON parser; see the module comment for its rules and costs. */
// 用途：供模型适配器逐片追加参数JSON，并取得稳定预览/增量。例先append('{"path":"a')可预览path=a，再append('b"}')得到ab；容错预览不代表最终参数合法。
export class StreamingJsonParser {
	// 已开始的根值；undefined表示尚未得到可见根，JSON的null是另一种明确值。
	#root: JsonValue | undefined = undefined;
	// 根值完全结束后忽略后续文本，防止第二个根污染第一个值。
	#done = false;
	// 开放容器栈，最后一项是当前最内层对象/数组。
	readonly #stack: Frame[] = [];
	// 正在读的字符串状态，没有字符串时为undefined。
	#string: OpenString | undefined = undefined;
	// 正在读的数字/true/false/null等标量原文，遇分隔符才最终判定。
	#scalar = "";
	// 当前标量应写到哪；非法位置仍可扫描但不会写进JSON。
	#scalarSlot: Slot | undefined = undefined;
	/** Sum of `size + 1` over the open path: what a fresh snapshot copies. */
	// 复制全部开放容器的成本：各容器成员数加容器本身之和。
	#pathCost = 0;
	// 随输入增长积累的复制预算；预算不足时snapshot保留上次预览而不昂贵重拷。
	#credit = 0;
	// 工作值是否相比已发布快照有变动，false时直接复用旧快照。
	#dirty = false;
	// 上次对外发布的稳定快照，不随后续工作容器变动而原地改变。
	#snapshot: JsonValue | undefined = undefined;
	/** Changes of the piece being read. */
	// 只存本次append产生的变更，下一次append会换成新数组。
	#changes: OpenChange[] = [];

	/**
	 * Read the next piece of text; returns the changes it made, in order. Costs time linear in `text.length`.
	 */
	// 用途：扫描新片段并返回本片段增量，修改解析器内部状态。例两次append跨越一个字符串/转义也能接续；每个新增字符只处理有限次，不每次重解析全部旧文本。
	append(text: string): readonly JsonChange[] {
		// 按本次新增长度增加快照复制预算，不按累计全文重复赠送。
		this.#credit += CREDIT_PER_APPEND + CREDIT_PER_CHARACTER * text.length;
		// 本片段使用独立变更数组，避免改动之前已经返回给调用者的列表。
		this.#changes = [];
		// 跨片段的字符串不能再扩写上次已返回的变更对象，所以清掉可合并引用。
		if (this.#string !== undefined) this.#string.change = undefined;
		// 只扫描本次text，旧片段已保存在状态里。
		let index = 0;
		// 还有新字符且根未结束时继续；根结束后其余输入忽略。
		while (index < text.length && !this.#done) {
			// 先观察是否有字符串未结束，字符串中括号/逗号不能当结构符。
			const open = this.#string;
			// 字符串模式一次读到字符串结束或片段末尾，并返回下一位置。
			if (open !== undefined) index = this.#readString(open, text, index);
			// 否则若正在读数字/字面量，就先延续该标量。
			else if (this.#scalar !== "") index = this.#readScalar(text, index);
			// 无未完成值时处理一个结构字符；index++取旧位置后自增，!表达边界已由while保证。
			else this.#structural(text[index++]!);
		}
		// 返回本片段变化序列，调用方可以自行维护副本；这不是完整快照。
		return this.#changes;
	}

	/**
	 * The value of the text read so far: `undefined` before a value starts, otherwise a plain JSON value that never
	 * changes afterwards. Returns the previous snapshot while the text read since did not change the value, or while a
	 * fresh copy of the open path is not yet paid for (see the module comment).
	 */
	// 用途：取得当前可见JSON稳定快照。例开放大数组频繁来一个字时，预算不足会暂时复用旧快照；已完成容器复用引用，开放路径复制后才交给外部。
	snapshot(): JsonValue | undefined {
		// 没变化就复用旧值，不做无意义遍历或分配。
		if (!this.#dirty) return this.#snapshot;
		// 数字/字面量尚未遇到分隔符时，尝试生成一个只用于预览的值。
		const pending = this.#pendingScalar();
		// 开放路径复制成本，加上一个待预览标量的额外成本。
		const cost = this.#pathCost + (pending === undefined ? 0 : 1);
		// 输入增长还不足以支付大拷贝时延迟预览，不让小增量引起反复全量复制。
		if (cost > this.#credit) return this.#snapshot;
		// 确实复制才扣预算，使累计复制工作量受输入规模约束。
		this.#credit -= cost;
		// 这次快照反映当前工作状态，直到之后解析再把它标脏。
		this.#dirty = false;
		// 复制未关闭容器链并注入待完成标量，得到不会被后续原地修改的结果。
		this.#snapshot = this.#copyOpenPath(pending);
		// 返回新快照或同一快照引用，调用方可用引用相等快速判断变化。
		return this.#snapshot;
	}

	/** Read string characters from `start` until the string ends or the text does; returns the next index. */
	// 用途：从本片段start继续读未完成字符串，批量复制普通文字。遇到转义先续转义，遇闭引号结束，读到片段末尾保留状态；返回下次扫描下标。
	#readString(open: OpenString, text: string, start: number): number {
		// 普通字符段的起点，遇到特殊符号才一次性slice该段，避免每字符拼接。
		let runStart = start;
		// 从当前片段的指定位置扫描，不回头读旧片段。
		for (let index = start; index < text.length; index++) {
			// 读取UTF-16码元，与QUOTE/BACKSLASH常量快速比较。
			const code = text.charCodeAt(index);
			// 前一字符/前一片段留下了转义，先确定当前字符是否属于它。
			if (open.escape !== "") {
				// 成功消费进转义则不能再把同一字符当普通内容读。
				if (this.#continueEscape(open, text[index]!)) {
					// 已消费字符之后才是下一段普通文本起点。
					runStart = index + 1;
					// 跳过当前循环剩余步骤；避免转义后的引号误结束字符串。
					continue;
				}
				// Not part of the escape: read it as a normal string character below.
				// 无效转义没消费当前字符，让它重新按普通字符串字符处理。
				runStart = index;
			}
			// 未被转义消费的双引号表示字符串闭合。
			if (code === QUOTE) {
				// 先追加闭引号前的一整段普通内容，不把引号本身放入字符串值。
				if (index > runStart) this.#appendString(open, text.slice(runStart, index));
				// 结束字符串，若为key则写入frame.key，若为值则推进父容器阶段。
				this.#endString(open);
				// 下一次结构扫描从闭引号之后开始。
				return index + 1;
			}
			// 反斜杠开启一段可能跨片段的转义。
			if (code === BACKSLASH) {
				// 先追加闭引号前的一整段普通内容，不把引号本身放入字符串值。
				if (index > runStart) this.#appendString(open, text.slice(runStart, index));
				// 先暂存反斜杠，等下一个字符判断是短转义还是Unicode转义。
				open.escape = "\\";
				// 已消费字符之后才是下一段普通文本起点。
				runStart = index + 1;
			}
		}
		// 没有闭引号但片段结束时，当前已读普通字符仍可在预览中显示。
		if (text.length > runStart) this.#appendString(open, text.slice(runStart));
		// 本片段已消费到末尾，下次append继续复用open状态。
		return text.length;
	}

	/** Read number or literal characters from `start` up to the next delimiter; returns the delimiter's index. */
	// 用途：延续数字/字面量直到结构分隔符；例如片段先来1e、后再来3}，先拼1e3并在}前结束标量，保留}给结构扫描。
	#readScalar(text: string, start: number): number {
		// 记录本段标量字符的末端。
		let end = start;
		// 一直推进到分隔符或片段末尾，分隔符本身不消费。
		while (end < text.length && !isDelimiter(text[end]!)) end++;
		// 确实有新标量字符才拼接，避免空工作。
		if (end > start) {
			// 把当前片段这一段加到跨片段标量原文。
			this.#scalar += text.slice(start, end);
			// 标量有有效位置时可能改变预览；非法位置读过也不应改结果。
			if (this.#scalarSlot !== undefined) this.#dirty = true;
		}
		// 遇到分隔符表示标量完整，可以严格判断值并报告set增量。
		if (end < text.length) this.#endScalar();
		// 返回分隔符位置，让外层下一步再处理括号/逗号等结构。
		return end;
	}

	/** Handle one character outside strings. */
	// 用途：处理不在字符串/标量中的单个结构字符。空白忽略，括号开闭容器，冒号/逗号推进阶段，其他字符开启标量；这是宽容预览语法，不保证完整JSON合法。
	#structural(char: string): void {
		// 用字符分派，某些相邻case共享同一处理语句。
		switch (char) {
			// JSON允许的普通空格，在结构位置无语义。
			case " ":
			// 结构位置制表符也当空白。
			case "\t":
			// 结构位置换行不改变容器状态。
			case "\n":
			// 回车同样忽略。
			case "\r":
				// 当前分支处理完就退出本次字符/值处理，不继续落到后面的分支。
				return;
			// 双引号开始对象键或字符串值，具体由父容器阶段决定。
			case '"':
				// 初始化OpenString，必要时先把空字符串值放入预览。
				this.#startString();
				// 当前分支处理完就退出本次字符/值处理，不继续落到后面的分支。
				return;
			// 左花括号开启对象容器。
			case "{":
			// 左方括号开启数组容器，与上一case共用分支。
			case "[":
				// 三元表达式按开启字符选择空对象或空数组，再压栈。
				this.#openContainer(char === "{" ? {} : []);
				// 当前分支处理完就退出本次字符/值处理，不继续落到后面的分支。
				return;
			// 右花括号结束当前容器；此容错实现不做完整括号类型匹配验证。
			case "}":
			// 右方括号也结束最内层容器，最终合法性留给完整解析。
			case "]":
				// 弹出frame、更新复制成本，深层容器可在此整体报告set。
				this.#closeContainer();
				// 当前分支处理完就退出本次字符/值处理，不继续落到后面的分支。
				return;
			// 冒号只对对象“等冒号”阶段有意义；花括号给该case局部变量作用域。
			case ":": {
				// at(-1)取当前最内层容器；栈空时undefined，多个方法都以它定位父级。
				const frame = this.#stack.at(-1);
				// 只有对象且刚读完键时，冒号才切换到等值阶段。
				if (frame !== undefined && !Array.isArray(frame.container) && frame.phase === "colon")
					// 对象现在等待成员值；冒号本身不成为JSON值。
					frame.phase = "value";
				// 当前分支处理完就退出本次字符/值处理，不继续落到后面的分支。
				return;
			}
			// 逗号表示接下来等数组值或对象新键。
			case ",": {
				// at(-1)取当前最内层容器；栈空时undefined，多个方法都以它定位父级。
				const frame = this.#stack.at(-1);
				// 按容器形状设置阶段；孤立逗号没有父级就忽略。
				if (frame !== undefined) frame.phase = Array.isArray(frame.container) ? "value" : "key";
				// 当前分支处理完就退出本次字符/值处理，不继续落到后面的分支。
				return;
			}
			// 不是上述结构符的字符，作为潜在数字/字面量开头处理。
			default:
				// 记录标量首字符；后续片段由readScalar继续。
				this.#scalar = char;
				// 确定这段标量能否放入当前合法位置。
				this.#scalarSlot = this.#valueSlot();
				// 标量有有效位置时可能改变预览；非法位置读过也不应改结果。
				if (this.#scalarSlot !== undefined) this.#dirty = true;
		}
	}

	/** Where a value starting now goes, or `undefined` when this position takes no value. */
	// 用途：决定“现在开始的值”应放哪里。例数组按当前length给下标，对象在键后即便缺冒号也容错放值；无合适位置返回undefined，后面读过但丢弃。
	#valueSlot(): Slot | undefined {
		// at(-1)取当前最内层容器；栈空时undefined，多个方法都以它定位父级。
		const frame = this.#stack.at(-1);
		// 栈空时只有尚无根值才可写根；已有根不允许再开第二个根值。
		if (frame === undefined) return this.#root === undefined ? ROOT_SLOT : undefined;
		// 数组下一个值位置在末尾，后续预览会更新同一位置而非重复push。
		if (Array.isArray(frame.container)) return { kind: "element", index: frame.container.length };
		// A missing colon is tolerated: `{"a" 1}` reads as `{"a": 1}`.
		// 对象有键且在等值/等冒号时允许值开始；故意兼容缺冒号输入。
		if ((frame.phase === "value" || frame.phase === "colon") && frame.key !== undefined) {
			// 返回明确的对象成员位置，保留键原字符串。
			return { kind: "member", key: frame.key };
		}
		// 当前没有可用位置/路径/预览值，调用方据此忽略或延迟，不伪造JSON字段。
		return undefined;
	}

	// 用途：判断新字符串是对象键还是值，再初始化跨片段状态。例对象刚结束一个值后直接来双引号，即使漏逗号也按新键处理；会修改内部string状态。
	#startString(): void {
		// at(-1)取当前最内层容器；栈空时undefined，多个方法都以它定位父级。
		const frame = this.#stack.at(-1);
		// A missing comma is tolerated: `{"a": 1 "b": 2}` reads the second member.
		// 下面多行条件一起判断当前是否为“对象中即将读键”的位置。
		if (
			// 必须处在一个已打开容器里，根字符串不是键。
			frame !== undefined &&
			// 数组元素字符串永远是值，不是对象键。
			!Array.isArray(frame.container) &&
			// 等key或刚完成上一值时，新字符串均容错当作下一对象键。
			(frame.phase === "key" || frame.phase === "comma")
		) {
			// 键未读完前不创建成员，不发增量；只保存待完成键文字。
			this.#string = { target: "key", slot: undefined, text: "", escape: "", path: undefined, change: undefined };
			// 当前分支处理完就退出本次字符/值处理，不继续落到后面的分支。
			return;
		}
		// 对于字符串值，先决定要写的根/成员/下标；各值开始方法共用该逻辑。
		const slot = this.#valueSlot();
		// 再看该位置是否允许对外报告短路径增量。
		const path = this.#reportedPath(slot);
		// 初始化空字符串预览，后面字符批次持续扩展它。
		this.#string = { target: "value", slot, text: "", escape: "", path, change: undefined };
		// 字符串刚开始也已有空字符串值，但键字符串不会走这里。
		this.#place(slot, "");
		// 可报告位置先发一次set空字符串；本片段后续字可合并到这条变更。
		if (path !== undefined) this.#string.change = this.#report({ kind: "set", path, value: "" });
	}

	/** The path of a value at `slot` in the innermost open container, when its changes are reported. */
	// 用途：为有效位置构造增量路径。根路径[]，成员追加key、元素追加index；父级已停止内部报告时返回undefined，避免无限深路径增长。
	#reportedPath(slot: Slot | undefined): JsonPath | undefined {
		// 非法位置不应被报告成有效外部变更。
		if (slot === undefined) return undefined;
		// 根值位置用空路径，调用方可据此替换整个副本。
		if (slot.kind === "root") return [];
		// 非根slot由当前父frame产生，因此这里依赖已决定的栈非空约束，!只告诉TS。
		const frame = this.#stack.at(-1)!;
		// 过深容器的内部变化延迟到整容器关闭后报告。
		if (!frame.reportsInside) return undefined;
		// 浅复制父路径再加当前段；kind标签帮助TS选择合法字段。
		return [...frame.path!, slot.kind === "member" ? slot.key : slot.index];
	}

	// 用途：把当前片段的一条变更加入列表并返回同一引用，方便同片段字符串扩展时合并；例首次set路径后接字可继续扩充该set。
	#report(change: OpenChange): OpenChange {
		// 按出现顺序保存，调用者按序应用才能保持同样结果。
		this.#changes.push(change);
		// 返回刚加入的对象，不另复制，供内部OpenString.change引用。
		return change;
	}

	/** Continue an escape with `char`; returns false when `char` is not part of it and must be read normally. */
	// 用途：续读字符串转义，true表示当前字符已消费，false表示无效转义后仍要按普通字符再处理。例反斜杠u+四位十六进制才解码，半段跨append保存。
	#continueEscape(open: OpenString, char: string): boolean {
		// 刚读到单个反斜杠，接下来判短转义或Unicode起点。
		if (open.escape === "\\") {
			// 查固定短转义映射，例如n映射为真正换行。
			const decoded = SIMPLE_ESCAPES[char];
			// 有合法短转义就完成这次转义。
			if (decoded !== undefined) {
				// 清空待完成转义，之后可恢复普通字符串扫描。
				open.escape = "";
				// 把解码后的字符追加进键/值，而不是追加反斜杠n原文。
				this.#appendString(open, decoded);
				// 当前字符已经作为转义的一部分消费，外层不能重复处理。
				return true;
			}
			// Unicode转义开头，后面还需四位数字。
			if (char === "u") {
				// 保存前缀，允许后续数字分散在多个片段到达。
				open.escape = "\\u";
				// 当前字符已经作为转义的一部分消费，外层不能重复处理。
				return true;
			}
			// Invalid escape: keep the backslash as text and read the character normally, as repairJson() does.
			// 清空待完成转义，之后可恢复普通字符串扫描。
			open.escape = "";
			// 无效短转义保留字面反斜杠，当前字符则留给外层按普通文字处理。
			this.#appendString(open, "\\");
			// 当前字符没有被转义消费，或条件不成立，需要调用方走普通处理分支。
			return false;
		}
		// 已经处于反斜杠u之后，只接受十六进制字符。
		if (isHexDigit(char)) {
			// 积累已读转义数字，尚未凑齐时不提前显示半个字符。
			open.escape += char;
			// 反斜杠u占两字符，再加四位才凑成完整六字符转义。
			if (open.escape.length < 6) return true;
			// 取四位十六进制转成UTF-16码元；这里不额外验证代理对是否完整。
			const decoded = String.fromCharCode(Number.parseInt(open.escape.slice(2), 16));
			// 清空待完成转义，之后可恢复普通字符串扫描。
			open.escape = "";
			// 把解码后的字符追加进键/值，而不是追加反斜杠n原文。
			this.#appendString(open, decoded);
			// 当前字符已经作为转义的一部分消费，外层不能重复处理。
			return true;
		}
		// `\u` without four hex digits: keep it as text and read the character normally, as repairJson() does.
		// Unicode转义遇到非法字符时，先保住已读前缀文字。
		const literal = open.escape;
		// 清空待完成转义，之后可恢复普通字符串扫描。
		open.escape = "";
		// 将不完整/无效转义前缀作为字面文字显示，当前非法字符由外层再读。
		this.#appendString(open, literal);
		// 当前字符没有被转义消费，或条件不成立，需要调用方走普通处理分支。
		return false;
	}

	// 用途：批量追加一段已解码文字，同时更新工作值与本片段增量。例初次set="a"再来b可合并set="ab"，但中间有别的变更后应另发append。
	#appendString(open: OpenString, text: string): void {
		// 更新完整已读字符串，不是仅保存最新delta。
		open.text += text;
		// 对象键还没结束时只累加键文字，不能提前往对象里写半个键。
		if (open.target !== "value") return;
		// 字符串值的位置固定，多次更新同一槽，工作容器中始终是累计文字。
		this.#place(open.slot, open.text);
		// 非法/过深位置不发内部增量，但内部工作状态仍已更新。
		if (open.path === undefined) return;
		// Extend this string's newest change while nothing came after it; otherwise report an append.
		// 尝试找到本片段可继续合并的最新变更。
		const change = open.change;
		// 只有它仍是列表最后一项才可合并，保证变更相对顺序不被后改打乱。
		if (change !== undefined && this.#changes.at(-1) === change) {
			// 当前set来自这个字符串，已知value为字符串；断言只表达这个不变量，再追加文字。
			if (change.kind === "set") change.value = (change.value as string) + text;
			// 若最新变更原本就是append，继续累计同一段追加文字。
			else change.text += text;
			// 当前分支处理完就退出本次字符/值处理，不继续落到后面的分支。
			return;
		}
		// 不能合并就新建append，并记住它供同片段后续字符继续使用。
		open.change = this.#report({ kind: "append", path: open.path, text });
	}

	// 用途：关闭当前字符串。键结束后保存frame.key并等冒号；值结束后推进父级到等逗号，根字符串则使根读取结束。
	#endString(open: OpenString): void {
		// 先退出字符串模式，后续字符重新按结构/标量扫描。
		this.#string = undefined;
		// at(-1)取当前最内层容器；栈空时undefined，多个方法都以它定位父级。
		const frame = this.#stack.at(-1);
		// 键与字符串值虽然共用扫描器，结束动作不同。
		if (open.target === "key") {
			// 没有父对象时无法安放键；这个容错分支不创建虚构对象。
			if (frame === undefined) return;
			// 直到闭引号后才使用完整键名。
			frame.key = open.text;
			// 对象下一步期望冒号，但容错valueSlot也允许缺冒号直接给值。
			frame.phase = "colon";
			// 当前分支处理完就退出本次字符/值处理，不继续落到后面的分支。
			return;
		}
		// 字符串值完成，更新父容器阶段或根完成标志。
		this.#valueEnded(frame);
	}

	// 用途：标量遇分隔符后做最终值判断。例true变布尔true，未知word被丢弃；完整数字/字面量此时才报告set，不持续报告半段数字。
	#endScalar(): void {
		// 保存完整标量文字以便解析。
		const token = this.#scalar;
		// 保存标量开始时确定的位置，结束时仍写同一位置。
		const slot = this.#scalarSlot;
		// 退出标量模式，后续分隔符可被结构扫描处理。
		this.#scalar = "";
		// 清掉已消费的位置引用。
		this.#scalarSlot = undefined;
		// 只接受完整JSON数字或true/false/null；不认识的词返回undefined。
		const value = scalarValue(token);
		// null/false/0都属于有效JSON值，不能用if(value)判断。
		if (value !== undefined) {
			// 有效值写到工作根/父容器，非法位置内部会被忽略。
			this.#place(slot, value);
			// 再看该位置是否允许对外报告短路径增量。
			const path = this.#reportedPath(slot);
			// 有合法可报告路径时，把已经结束的标量作为set交出去。
			if (path !== undefined) this.#report({ kind: "set", path, value });
		}
		// 无论标量是否有效，结束后推进当前父级；没有父级时检查根是否已形成。
		this.#valueEnded(this.#stack.at(-1));
	}

	/** The value of the unterminated scalar at the end of the text, if it shows. */
	// 用途：给未结束的短标量计算预览，不报告正式增量。例tru预览true，1e+预览1，太长/位置无效就暂不显示；不会完成解析状态。
	#pendingScalar(): { readonly slot: Slot; readonly value: JsonValue } | undefined {
		// 读取这段未完成标量开始时确定的位置，不改变工作容器。
		const slot = this.#scalarSlot;
		// 取得目前到达的标量前缀，它可能还缺指数数字或字面量后半段。
		const token = this.#scalar;
		// 空、非法或过长候选不在每次snapshot重复解析，保护快照成本。
		if (slot === undefined || token === "" || token.length > MAX_PENDING_SCALAR_LENGTH) return undefined;
		// 使用“尚未结束”规则，允许布尔字面量前缀或不完整指数。
		const value = pendingScalarValue(token);
		// 只有能合理预览时返回位置和值，0/false/null也照样保留。
		return value === undefined ? undefined : { slot, value };
	}

	// 用途：在当前槽放新对象/数组并压入工作栈。例{"a":[开出数组后，栈同时记对象和数组；会增加路径复制成本并必要时发空容器set。
	#openContainer(container: JsonContainer): void {
		// 为新容器确定要写的根/成员/下标，与其他值开始时复用同一定位规则。
		const slot = this.#valueSlot();
		// 再看该位置是否允许对外报告短路径增量。
		const path = this.#reportedPath(slot);
		// 父级立即知道新容器的位置，但开放容器工作引用不直接当快照发出。
		this.#place(slot, container);
		// 把这层容器的后续扫描/成本/报告状态保存为frame。
		this.#stack.push({
			// 当前可变工作对象或数组引用。
			container,
			// 容器在父级中的固定位置，用于复制开放路径时重新接回父副本。
			slot,
			// 可报告增量的路径，非法/过深时可能缺失。
			path,
			// 只有路径合法且深度仍小于上限，才逐个报告容器内部变化。
			reportsInside: path !== undefined && path.length < MAX_REPORTED_DEPTH,
			// 新容器还没有成员/元素，后面首次新增才增加成本。
			size: 0,
			// 新对象尚未读到键；数组不依赖这个字段。
			key: undefined,
			// 数组先等值，对象先等键。
			phase: Array.isArray(container) ? "value" : "key",
		});
		// 新开放容器本身也算一份复制成本，即使还没有成员。
		this.#pathCost += 1;
		// 工作值发生变化，后续snapshot需要按预算重新生成。
		this.#dirty = true;
		// A fresh container: the working one keeps changing, and a change never does.
		// 对外报告另一个独立空容器，而非仍会变化的工作容器引用。
		if (path !== undefined) this.#report({ kind: "set", path, value: Array.isArray(container) ? [] : {} });
	}

	// 用途：结束最内层容器并出栈。例深度超上限的对象内部不逐项报告，关闭时发一次完整set；开放路径成本随出栈减少。
	#closeContainer(): void {
		// 取走栈顶frame，后续活动父级变为上一层。
		const frame = this.#stack.pop();
		// A stray closer outside any container is ignored.
		// 栈本来就空表示孤立的闭括号，容错模式忽略它，不创建虚构容器。
		if (frame === undefined) return;
		// 该容器已完成，未来快照可复用它，不必每次复制其所有成员。
		this.#pathCost -= frame.size + 1;
		// 工作值发生变化，后续snapshot需要按预算重新生成。
		this.#dirty = true;
		// Too deep to report inside: the whole value, final now that it is closed.
		// 有可报告位置但不报告内部的深层容器，需要在此整体补一次结果。
		if (frame.path !== undefined && !frame.reportsInside) {
			// 容器已经关闭，工作引用后续不再被本解析器写入，因此可安全作为完成值共享。
			this.#report({ kind: "set", path: frame.path, value: frame.container });
		}
		// 关闭的容器也是一个完成值，推进上一层父级；根容器关闭则结束根读取。
		this.#valueEnded(this.#stack.at(-1));
	}

	/** A value in `frame`, or the root value when there is no frame, has ended. */
	// 用途：标记一个值完成。根存在时结束整个读取；嵌套值完成后父容器改等逗号，不负责验证原始JSON最终合法性。
	#valueEnded(frame: Frame | undefined): void {
		// 没有父容器，当前完成的是根值或无效顶层内容。
		if (frame === undefined) {
			// Text after the root value is ignored, but only once a root value exists.
			// 只有真有根值才停止；无效前缀没有根时仍可继续读后面内容。
			if (this.#root !== undefined) this.#done = true;
			// 当前分支处理完就退出本次字符/值处理，不继续落到后面的分支。
			return;
		}
		// 父容器的一个值结束，接下来正常应是逗号或闭括号。
		frame.phase = "comma";
	}

	/** Set the value at `slot` in the open path; nothing for a value in an invalid position. */
	// 用途：把累计值写进工作根/对象/数组，并只在新增成员时增加复制成本。例同一字符串每来delta更新原槽，不每次增加size；会修改内部工作容器。
	#place(slot: Slot | undefined, value: JsonValue): void {
		// 位置无效时直接丢弃，不将错误位置文本变成虚构字段。
		if (slot === undefined) return;
		// 工作值发生变化，后续snapshot需要按预算重新生成。
		this.#dirty = true;
		// 根值直接保存在解析器字段，不需要找父容器。
		if (slot.kind === "root") {
			// 根可先放空容器/空字符串，后面依工作状态逐步形成内容。
			this.#root = value;
			// 当前分支处理完就退出本次字符/值处理，不继续落到后面的分支。
			return;
		}
		// 非根slot由当前父frame产生，因此这里依赖已决定的栈非空约束，!只告诉TS。
		const frame = this.#stack.at(-1)!;
		// 数组槽分支，TS知道该slot有index字段。
		if (slot.kind === "element") {
			// slot来自数组位置判定，断言表达父容器确实是数组的已定不变量。
			const elements = frame.container as JsonValue[];
			// 恰好写末尾表示新增一个元素；重写已有预览槽不增加元素数。
			if (slot.index === elements.length) {
				// 记录当前开放容器有多少项，供快照复制预算使用。
				frame.size++;
				// 每新增一个项就增加开放路径复制成本；更新已有项不增加。
				this.#pathCost++;
			}
			// 按固定下标写入累计值。
			elements[slot.index] = value;
			// 当前分支处理完就退出本次字符/值处理，不继续落到后面的分支。
			return;
		}
		// 剩余slot是对象成员，对应父容器不变量为对象。
		const members = frame.container as { [key: string]: JsonValue };
		// 仅首次创建自有键增加成本，原型链上同名键不算已经拥有。
		if (!Object.hasOwn(members, slot.key)) {
			// 记录当前开放容器有多少项，供快照复制预算使用。
			frame.size++;
			// 每新增一个项就增加开放路径复制成本；更新已有项不增加。
			this.#pathCost++;
		}
		// 统一写对象键，特殊__proto__由后面的安全定义逻辑处理。
		setMember(members, slot.key, value);
	}

	/** A fresh snapshot: copies of the open containers, innermost first, each holding the copy of its open child. */
	// 用途：从最内层向外复制仍开放的容器，接成新根快照；完成子树共享引用。例开放{a:[...]时只复制对象/数组链，避免改掉已交给UI的旧快照。
	#copyOpenPath(pending: { readonly slot: Slot; readonly value: JsonValue } | undefined): JsonValue | undefined {
		// 没有开放容器时，只需用待完成根标量预览或已完成根值，不必递归复制。
		if (this.#stack.length === 0) return pending?.slot.kind === "root" ? pending.value : this.#root;
		// 保存刚复制好的内层子树，下一层父副本要接回它。
		let child: JsonValue | undefined;
		// 记录这个子副本在父层的位置。
		let childSlot: Slot | undefined;
		// 从栈顶最内层倒着处理，逐层向外重建开放路径。
		for (let depth = this.#stack.length - 1; depth >= 0; depth--) {
			// depth由循环范围保证是有效栈下标。
			const frame = this.#stack[depth]!;
			// 数组用slice、对象用展开做浅复制；内部已完成值不再修改，可共享。
			const copy: JsonContainer = Array.isArray(frame.container) ? frame.container.slice() : { ...frame.container };
			// 只有最内层副本需要注入当前尚未结束的标量预览。
			if (depth === this.#stack.length - 1 && pending !== undefined) setSlot(copy, pending.slot, pending.value);
			// 将刚复制的内层容器接回父副本，替换父副本里原工作引用。
			if (child !== undefined && childSlot !== undefined) setSlot(copy, childSlot, child);
			// 这一层副本成为下一次循环要接回外层的新子树。
			child = copy;
			// 下一层按当前frame在父中的位置接回。
			childSlot = frame.slot;
		}
		// The outermost open container is the root unless it sits in an invalid position.
		// 最外层确实位于根时才返回新链，否则非法位置链不能替换现有根。
		return childSlot?.kind === "root" ? child : this.#root;
	}
}

/**
 * The arguments of one streaming tool call: the raw text, for the one full parse when the call ends, and a
 * `StreamingJsonParser` for the partial arguments in between. Providers keep one per call in their own stream state,
 * never on the content block, so the raw text never reaches partial messages or transcripts.
 */
// 一条工具调用的参数流包装器。它同时保存完整原文、增量解析器和对象预览；供应商每个toolCall各建一份，避免并行调用参数串线。
export class ToolCallArgumentsStream {
	// 完整参数原文仅供最终严格解析，不直接放进每个部分消息/历史。
	#text = "";
	// 每条工具调用独享一个增量预览状态机。
	#parser = new StreamingJsonParser();
	// 上次对外发布的稳定快照，不随后续工作容器变动而原地改变。
	#snapshot: JsonValue | undefined = undefined;
	// 对外只暴露对象形状参数；其他JSON根值预览先视为空参数。
	#arguments: ToolCall["arguments"] = {};

	/** The raw argument text received so far. */
	// 用途：读取到目前为止的完整原始参数文本。get访问器让调用方写stream.text；不消费也不清空文字。
	get text(): string {
		// 返回内部累计字符串，调用者拿到的是不可变字符串值。
		return this.#text;
	}

	/** Append a piece of argument text; returns the partial arguments, a new object whenever they changed. */
	// 用途：追加供应商新参数片段并返回当前对象预览。例先{"path":"a再b"}，第二次得到path=ab；会更新原文与解析器，最终仍须finish确认。
	append(delta: string): ToolCall["arguments"] {
		// 完整原文累计供最后一次解析，不能只保留最新片段。
		this.#text += delta;
		// 增量解析器只读这次新片段，不重扫旧全文。
		this.#parser.append(delta);
		// 将JSON快照转换成工具参数对象预览，并尽可能复用未变引用。
		return this.#partial();
	}

	/**
	 * Take the provider's complete argument text. When it continues the text so far, returns the missing piece as
	 * `delta`; otherwise starts over with `text`. Either way returns the partial arguments of `text`.
	 */
	// 用途：接收供应商一次给出的完整累计文本。若延续旧前缀就只补差量，否则重置解析器从新文本开始；返回缺失delta表示无法用简单追加表示。
	replace(text: string): { readonly delta: string | undefined; readonly arguments: ToolCall["arguments"] } {
		// 供应商新全文包含旧全文作为前缀，可复用已扫描状态。
		if (text.startsWith(this.#text)) {
			// 只取还没读过的后缀，避免重复添加参数内容。
			const delta = text.slice(this.#text.length);
			// 全文没变就只取现有预览；有新后缀则走正常append。
			return { delta, arguments: delta === "" ? this.#partial() : this.append(delta) };
		}
		// 新全文并非延续，丢弃旧的原文累计基线。
		this.#text = "";
		// 同时丢弃旧解析状态，避免把两份不兼容全文拼起来。
		this.#parser = new StreamingJsonParser();
		// 把新全文从头解析；undefined明确告诉调用方这不是单纯增量追加。
		return { delta: undefined, arguments: this.append(text) };
	}

	/** The final arguments: one full parse of the complete text, which reports malformed arguments. */
	// 用途：工具调用结束时对完整原文做一次严格对象解析。例预览看似有path但JSON未闭合，finish会返回argumentsError；不能因为预览可用就直接执行。
	finish(): Pick<ToolCall, "arguments" | "argumentsError"> {
		// 复用完整JSON修复/顶层对象检查，后面还要由工具schema校验字段。
		return parseToolCallArguments(this.#text);
	}

	// 用途：读取稳定JSON快照，只有普通对象根才作为参数预览。例根数组/数字/null先返回{}；引用未变就复用旧参数对象，减少无效UI更新。
	#partial(): ToolCall["arguments"] {
		// 可能因复制预算不足仍是旧快照，这是预览延迟，不是输入丢失。
		const snapshot = this.#parser.snapshot();
		// 引用未变代表当前可见内容未变，复用原参数对象。
		if (snapshot === this.#snapshot) return this.#arguments;
		// 记住最近一次看过的快照引用。
		this.#snapshot = snapshot;
		// Tool arguments are an object; any other partial value shows as no arguments yet.
		// 根据下面的运行时形状判定决定是否采用新快照。
		this.#arguments =
			// 工具参数必须是对象；JSON根值允许数组/null，但不能把它们当调用参数。
			typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
				? // 顶层已确认对象，断言复用ToolCall参数类型；具体字段合法性仍在schema边界检查。
					(snapshot as ToolCall["arguments"])
				: // 非对象JSON预览统一显示为空参数，最终错误由finish报告。
					{};
		// 返回当前对象预览，不附带内部累计原文和解析器状态。
		return this.#arguments;
	}
}

// JSON短转义映射表；Readonly只限制TS赋值，不额外冻结对象。
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
	// 反斜杠双引号解码成一个双引号字符。
	'"': '"',
	// 双反斜杠解码成单个字面反斜杠。
	"\\": "\\",
	// 转义斜杠解码为普通斜杠。
	"/": "/",
	// 短转义b解码为退格控制字符。
	b: "\b",
	// 短转义f解码为换页。
	f: "\f",
	// 短转义n解码为真正换行。
	n: "\n",
	// 短转义r解码为回车。
	r: "\r",
	// 短转义t解码为制表符。
	t: "\t",
};

// 用途：判断是否结束数字/字面量的结构字符。例逗号、括号、空白、引号都为true，数字字符为false；不用于字符串内部。
function isDelimiter(char: string): boolean {
	return (
		// 空格结束前面的标量。
		char === " " ||
		// 制表符也形成标量边界。
		char === "\t" ||
		// 换行可分隔JSON结构。
		char === "\n" ||
		// 回车同样是空白分隔。
		char === "\r" ||
		// 逗号结束当前数组项或对象值。
		char === "," ||
		// 冒号是对象结构分隔，不属于数字/字面量。
		char === ":" ||
		// 容错情况下新对象开始也截断前一个标量。
		char === "{" ||
		// 闭对象前先结束当前标量，再让结构处理弹栈。
		char === "}" ||
		// 新数组开始是结构边界。
		char === "[" ||
		// 闭数组前同样要先结束标量。
		char === "]" ||
		// 双引号开始字符串，不应继续拼进前一个标量。
		char === '"'
	);
}

// 用途：识别Unicode转义里的单个十六进制字符。例a/F/9为true，G为false；字符串范围比较适用于这些ASCII字符。
function isHexDigit(char: string): boolean {
	// 数字及大小写A到F任一范围成立即可。
	return (char >= "0" && char <= "9") || (char >= "a" && char <= "f") || (char >= "A" && char <= "F");
}

/** The value of a complete number or literal token; `undefined` for anything else, which is dropped. */
// 用途：完整标量文本转JSON值。例true→true、1e3→1000，未知单词/不完整数字→undefined；不接受NaN或Infinity文字。
function scalarValue(token: string): JsonValue | undefined {
	// 遍历字面量二元组，只有完整精确匹配才采用值。
	for (const [literal, value] of LITERALS) if (token === literal) return value;
	// 数字语法完全匹配后转number，否则没有有效标量。
	return NUMBER.test(token) ? Number(token) : undefined;
}

/** The value an unterminated number or literal token shows. */
// 用途：未结束标量的宽容预览。例t/tr/tru先显示true，1e+显示尾数1；仅供UI，最终结束后必须用scalarValue或完整解析判断。
function pendingScalarValue(token: string): JsonValue | undefined {
	// 输入是某个合法字面量的前缀时，暂预览该字面量最终值。
	for (const [literal, value] of LITERALS) if (literal.startsWith(token)) return value;
	// 当前数字已经完整合法时，可立即预览数值。
	if (NUMBER.test(token)) return Number(token);
	// 若只是指数数字未到，提取指数前的有效尾数。
	const mantissa = NUMBER_WITHOUT_EXPONENT_DIGITS.exec(token);
	// 没有合理数字预览就不显示，不能将任意坏文本转NaN给外部。
	return mantissa === null ? undefined : Number(mantissa[1]);
}

// 用途：在快照副本里按数组/对象槽接值。根槽无父级写入所以此函数不处理；例复制开放子数组后接回父对象键，修改的是副本。
function setSlot(container: JsonContainer, slot: Slot, value: JsonValue): void {
	// 数组位置用数字下标写入；断言表达调用处已决定容器与slot匹配。
	if (slot.kind === "element") (container as JsonValue[])[slot.index] = value;
	// 对象位置复用特殊键安全写入逻辑，不直接以原型setter方式写__proto__。
	else if (slot.kind === "member") setMember(container as { [key: string]: JsonValue }, slot.key, value);
}

// 用途：像JSON.parse一样创建对象自有成员，包括特殊键__proto__。例解析{"__proto__":...}不应改变对象原型；会修改给定容器。
function setMember(members: { [key: string]: JsonValue }, key: string, value: JsonValue): void {
	// `__proto__` must become an own member, as in JSON.parse(), not the prototype.
	// 普通obj[key]=value可能触发原型setter，必须把这个名字当真正数据属性。
	if (key === "__proto__") {
		// 显式创建可写/可枚举/可配置自有属性，与普通JSON对象成员性质一致。
		Object.defineProperty(members, key, { value, writable: true, enumerable: true, configurable: true });
	} else {
		// 其他普通键按常规属性赋值，保留输入JSON的键名。
		members[key] = value;
	}
}
