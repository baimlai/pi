// 在普通终端主屏中绘制组件，保留可滚动历史；TuiBase负责输入、调度和浮层，本文件负责前后帧比较及输出控制序列。
// 一次渲染先生成整份行数组，再选全量或差量输出；“差量”减少终端写入，不表示只运行变化组件的render。
// 这里依赖Terminal接口，真实终端和测试用VirtualTerminal都可接入；日志分支会同步写文件。
// 以命名空间形式导入Node文件系统；后面使用mkdirSync、writeFileSync等同步API。
import * as fs from "node:fs";
// os.tmpdir()用于没有配置日志目录时的崩溃记录位置。
import * as os from "node:os";
// path.join/dirname拼路径，不靠手工拼接目录分隔符。
import * as path from "node:path";
// 删图函数只返回Kitty协议串；isImageLine只识别行内图片前缀，不验证图片有效性。
import { deleteKittyImage, isImageLine } from "./terminal-image.ts";
// type标记的TUI/TuiStopOptions只供TS检查并在运行时擦除；TuiBase是实际继承的类。
import { type TUI, TuiBase, type TuiStopOptions } from "./tui.ts";
// visibleWidth按终端显示列计宽，忽略可识别ANSI控制串；中文、表情宽度不能用string.length代替。
import { visibleWidth } from "./utils.ts";

/** OSC 133 prompt markers at the start of a rendered line. Fullscreen uses them for prompt navigation. */
// 锚点^只匹配行首连续的OSC 133 A/B/C区段，接受BEL或ESC加反斜杠结尾；不移除行中/其他种类OSC。
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

// Kitty图片头以ESC _ G开头；这里的转义字面量是运行时控制字符，不是可见的六个字符。
const KITTY_SEQUENCE_PREFIX = "\x1b_G";
// 每块上限为1048576个UTF-16码元（string.length），不是UTF-8字节数，也不是整个帧大小上限。
const MAX_RENDER_WRITE_CHARS = 1024 * 1024;

/**
 * Streams terminal output in 1 MiB chunks so a full render never forms one string large enough to exceed V8's limit.
 *
 * `append()` fills the current chunk and flushes it when full. Oversized input is split at chunk boundaries, preserving
 * surrogate pairs so each write remains valid UTF-16. Callers append synchronized-output begin/end sequences themselves;
 * the final `flush()` writes any remainder, including the end sequence.
 */
// 逐块收集并调用write输出，避免把整帧拼成一个巨型字符串；本身不识别ANSI序列、不加同步输出开关。
// 例如连续append两个大图片报文，满块时已可能写出，最后flush才发送余量；这不是可回滚的输出事务。
class BoundedTerminalWriter {
	// private限制TS代码从类外访问；buffer只保留尚未发送的当前块。
	private buffer = "";
	// 已经成功返回的write所处理的码元总数；只作统计，不保留已发送的字符串。
	private writtenChars = 0;
	// readonly禁止TS中重新赋值这个回调字段；函数签名表示收字符串、不提供返回值，不意味着不会抛错。
	private readonly write: (data: string) => void;

	// 接收实际写出回调并保存在实例中，没有立即输出，也没有打开终端。
	// 例如new BoundedTerminalWriter(data => terminal.write(data))只是建立后续发送通道。
	constructor(write: (data: string) => void) {
		// 把参数赋给同名实例字段；this.write与局部参数write是两个不同绑定。
		this.write = write;
	}

	/**
	 * Append terminal data, flushing full chunks as needed. Callers must call `flush()` after the final append.
	 * @param value Terminal data to write in order; oversized values are split without splitting surrogate pairs.
	 */
	// 按顺序追加value，必要时先发送满块；返回void，最后不足一块的数据要由调用方flush。
	// 按UTF-16下标切片，遇到同一value内的代理对边界会退一格；不验证输入本来是否含孤立代理码元。
	// 例如块只剩一个位置而下一字符是两个码元的表情，先发已有块，再把表情一起放入新块。write抛错会向外传播。
	append(value: string): void {
		// offset是本次value已消费到的位置；let允许循环中更新，单位是UTF-16码元。
		let offset = 0;
		// 只要还有输入没收进块，就继续；空字符串不会进入循环或触发发送。
		while (offset < value.length) {
			// 上限减去当前块的码元长度，得到本块剩余容量。
			const capacity = MAX_RENDER_WRITE_CHARS - this.buffer.length;
			// 已有块完全装满时，必须先清空它才能继续装数据。
			if (capacity === 0) {
				// flush实际调用外部write；如果抛异常，本次append也立即中断。
				this.flush();
				// 从循环顶部重新计算空块容量，而不是用旧的零容量向下执行。
				continue;
			}

			// 右边界end不包含在slice中；取输入末尾和剩余容量边界中较小的一个。
			let end = Math.min(value.length, offset + capacity);
			// 下面用&&组合所有条件，判断切点是否恰好夹在高/低代理码元之间。
			if (
				// 切点后还有内容才可能把一个代理对拆成两块；切到输入末尾无需退让。
				end < value.length &&
				// charCodeAt读单个16位码元；切点前码元须达到高代理区起点D800。
				value.charCodeAt(end - 1) >= 0xd800 &&
				// 高代理区上界DBFF，与上一行共同限定第一半。
				value.charCodeAt(end - 1) <= 0xdbff &&
				// 切点后的码元须达到低代理区起点DC00。
				value.charCodeAt(end) >= 0xdc00 &&
				// 低代理区上界DFFF，确认下一半；这里不按字素簇切分，组合表情仍可能跨块。
				value.charCodeAt(end) <= 0xdfff
			) {
				// 切点向左退一个码元，留下完整代理对给后续块。
				end--;
			}
			// 若容量只容一个码元且刚才退回起点，本轮一个码元也不能装下。
			if (end === offset) {
				// 先发送已有内容来腾出整块空间；此条件下正常有尚未发送的块。
				this.flush();
				// 重新循环处理尚未消费的同一代理对，避免空切片后无法前进。
				continue;
			}

			// slice取[offset,end)，+=按顺序拼入当前块；ANSI控制序列可以跨write，按连续字符流接收。
			this.buffer += value.slice(offset, end);
			// 记录本次切片已消费到end，下轮从这里继续。
			offset = end;
			// 本块恰好达到上限就立刻发出，不必等整个value结束。
			if (this.buffer.length === MAX_RENDER_WRITE_CHARS) {
				// 发送并在成功返回后把缓冲块置空。
				this.flush();
			}
		}
	}

	/** Write the current chunk, if any, and retain only its character count for debug output. */
	// 发送当前非空块，成功后累计长度并释放该块；空块是无操作，返回void。
	// 例如append("abc")后flush才调用write("abc")；回调抛错时计数/缓冲尚未重置，实际终端可能已收到部分内容。
	flush(): void {
		// 空字符串为假值，直接return，避免无意义的空写入。
		if (!this.buffer) return;
		// 此处才调用注入回调；没有try/catch或失败重试。
		this.write(this.buffer);
		// 回调正常返回才累计本块长度，这个数不表示终端已完成显示。
		this.writtenChars += this.buffer.length;
		// 丢弃已发送块的引用，后续append从空块开始。
		this.buffer = "";
	}

	// getter通过writer.length访问，无参数、无副作用；返回已发送加未发送码元数，例如发3再缓存2得到5。
	get length(): number {
		// 把累计码元数与当前块长度相加；不拼接已发送数据。
		return this.writtenChars + this.buffer.length;
	}
}

// 本地解析结果的TS结构，不会在运行时自动检查报文；只保留本文件用到的i和r参数。
interface KittyImageHeader {
	// 所有通过整数范围校验的i值；同一头重复i时数组也可能重复。
	ids: number[];
	// 图片声称占用的终端行数，默认1，重复合法r以后面的为准。
	rows: number;
}

// 从line中第一个Kitty前缀提取分号前参数，返回{ids,rows}；没有前缀/分号则undefined。
// 例如ESC_Gi=42,r=3;数据得到ids=[42]、rows=3；它不检查终止符、载荷、动作或同一行后续图片。
// 逐个逗号参数转数字并检查正整数/32位无符号范围；只解析字符串，不输出也不修改行。
function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	// indexOf找第一个前缀，可位于行中；前面的光标控制码不会阻止找到它。
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	// -1表示未找到；联合返回类型允许返回undefined，调用方须处理。
	if (sequenceStart === -1) return undefined;
	// 加上前缀码元长度，定位参数区第一个字符。
	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	// 从参数起点找第一个分号，Kitty协议用它分隔控制参数与载荷。
	const paramsEnd = line.indexOf(";", paramsStart);
	// 没有分号就无法确定头部范围，本函数放弃提取。
	if (paramsEnd === -1) return undefined;

	// 显式number[]让TS检查push值为数字；空数组本身不做运行时校验。
	const ids: number[] = [];
	// 未发现有效r参数时按单行处理。
	let rows = 1;
	// 先截取参数区再按逗号分组；for...of依次得到参数字符串。
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		// 数组解构拿前两个等号分段；split的2是结果个数上限，额外等号后的部分不再保留。
		const [key, value] = param.split("=", 2);
		// 缺少等号后的段时跳过；空字符串与undefined不同，会继续转数字。
		if (value === undefined) continue;
		// Number按JS数字语法转换，可接受十六进制/指数文本；并非只接受十进制数字字符。
		const numberValue = Number(value);
		// 字符串报文边界的运行时验证：拒绝NaN、小数、非正数及超过FFFFFFFF的值，非法参数忽略而非抛错。
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		// i是图片ID参数，将合法数字追加；不去重、不核实图片是否存在。
		if (key === "i") ids.push(numberValue);
		// r是占用行数参数，覆盖默认值或此前r；其他键即使数字合法也忽略。
		else if (key === "r") rows = numberValue;
	}
	// 对象属性简写等价于{ids: ids, rows: rows}；返回新对象引用。
	return { ids, rows };
}

// 从单行提取ID列表；输入任意行、结果可空，例如普通文字得到[]；不写终端，解析规则沿用上方首个头。
function extractKittyImageIds(line: string): number[] {
	// 可选链?.在无头时不读ids，??只在null/undefined时使用新空数组，合法头的空ids原样返回。
	return parseKittyImageHeader(line)?.ids ?? [];
}

// 提取单行图片声称占用的行数，没找到头时返回1；例r=3得到3，最终可用预留行数还需下游检查。
function extractKittyImageRows(line: string): number {
	// 可选链取rows；空缺用1，不是测量图片像素或询问终端。
	return parseKittyImageHeader(line)?.rows ?? 1;
}

// 读取环境标记推测是否处于Termux，返回boolean；例如TERMUX_VERSION="1"为true，无变量/空串为false，无终端探测。
function isTermuxSession(): boolean {
	// Boolean把字符串真值化；"0"也为true，不检查版本格式或真实宿主。
	return Boolean(process.env.TERMUX_VERSION);
}

// 普通屏渲染缓存快照的公开TS接口，供模式切换保存/恢复；不包括终端真实内容、图片数据或整个TuiBase状态。
// export让外部可引用这个编译期结构，interface不会生成运行时验证器。
export interface TuiMainScreenRenderState {
	// 上次最终输出行数组，含ANSI控制串；capture会复制数组，restore会丢弃图片行。
	previousLines: string[];
	// 上次记录的终端列数，用于判断是否需按新宽度重绘。
	previousWidth: number;
	// 上次记录的终端可见行数，用于计算高度变化后的视口。
	previousHeight: number;
	// 内容末尾的逻辑行号（从0开始）；不等于焦点输入处真实光标行。
	cursorRow: number;
	// 维护的真实终端光标对应逻辑行号，供相对移动计算。
	hardwareCursorRow: number;
	// 工作区域曾绘制的最大行数；通常只增长，清屏重绘等路径才重置。
	maxLinesRendered: number;
	// 上帧可见视口第一行的逻辑行号，逻辑行号减它才得到屏内行号。
	previousViewportTop: number;
}

/** TUI implementation that renders into the terminal's main screen and scrollback. */
// 把TuiBase提供的组件/浮层行绘制到主屏和滚动历史；例如聊天追加回复只需写新增末尾，窗口改宽则重新排版整绘。
// extends继承生命周期/输入/调度；implements只让TS核对TUI契约，不额外生成包装对象。
// 本类没有显式构造函数，沿用基类接收Terminal、可选硬件光标开关/日志目录；构造不会立即start。
export class TuiMainScreen extends TuiBase implements TUI {
	// readonly约束TS赋值，as const将类型收窄成字面量"regular"而不是string；运行值仍是普通字符串。
	readonly mode = "regular" as const;
	// 上一帧比较基准，从空数组开始；private不是运行时私有#字段。
	private previousLines: string[] = [];
	// 记录上一帧解析到的Kitty ID，Set去重；强制重绘前可请求终端删除旧图。
	private previousKittyImageIds = new Set<number>();
	// 宽度0是尚未记录尺寸的初始标记，不代表实际终端无列。
	private previousWidth = 0;
	// 高度0同理；resetRenderState使用-1以显式触发尺寸变化判断。
	private previousHeight = 0;
	// 初始内容末行按逻辑第0行估算，之后由渲染路径更新。
	private cursorRow = 0;
	// 真实光标行的本地估计；输出光标移动后更新，并不向终端查询确认。
	private hardwareCursorRow = 0;
	// 历史绘制区域最大高度，用于可选的内容缩短清屏策略。
	private maxLinesRendered = 0;
	// 初始视口从逻辑第0行开始，内容超过终端高度后向下增长。
	private previousViewportTop = 0;

	// 捕获本类的行/尺寸/光标/工作区缓存，返回新快照，不读写终端或文件。
	// 交互模式从主屏切换到全屏前可保存，再切回时交给restore；只复制字符串数组，非整套终端状态备份。
	captureRenderState(): TuiMainScreenRenderState {
		// 构造一个新对象；字段取当前实例的缓存数值。
		return {
			// 展开语法[...]复制数组容器，字符串值不可变，不需要逐字符串深拷贝。
			previousLines: [...this.previousLines],
			// 保存上一帧列数。
			previousWidth: this.previousWidth,
			// 保存上一帧可见行数。
			previousHeight: this.previousHeight,
			// 保存内容末行估计。
			cursorRow: this.cursorRow,
			// 保存光标真实位置的逻辑行估计。
			hardwareCursorRow: this.hardwareCursorRow,
			// 保存曾使用的最大绘制行数。
			maxLinesRendered: this.maxLinesRendered,
			// 保存视口顶端逻辑行，供后续差量定位。
			previousViewportTop: this.previousViewportTop,
		};
	}

	// 把快照写回本类缓存，无返回值；不立即重绘、不移动终端、不验证快照与真实屏幕是否一致。
	// 图片可能已在另一屏被清除，所以图片行替换成空串、ID集合清空；例如原["标题",图片报文]恢复为["标题",""]。
	// state由TS接口约束结构，函数不进行运行时字段校验，也不恢复焦点、浮层或图片载荷。
	restoreRenderState(state: TuiMainScreenRenderState): void {
		// map创建新数组；三元表达式把所有识别出的图片行（含iTerm2前缀）丢弃，普通行原样保留。
		this.previousLines = state.previousLines.map((line) => (isImageLine(line) ? "" : line));
		// 旧图ID缓存清空，不向终端发送删除命令。
		this.previousKittyImageIds = new Set();
		// 恢复列数比较基准。
		this.previousWidth = state.previousWidth;
		// 恢复高度比较基准。
		this.previousHeight = state.previousHeight;
		// 恢复内容末行坐标。
		this.cursorRow = state.cursorRow;
		// 恢复光标坐标估计，假设调用方已处理实际屏幕切换。
		this.hardwareCursorRow = state.hardwareCursorRow;
		// 恢复工作区高水位，不根据恢复后的空图片行重算。
		this.maxLinesRendered = state.maxLinesRendered;
		// 恢复逻辑视口顶部，不从终端读取滚动位置。
		this.previousViewportTop = state.previousViewportTop;
	}

	// 强制下次重绘时重置本类缓存，供基类requestRender(true)/renderNow(true)调用；返回void，无立即输出。
	// 尺寸设为-1而不是初始0，使下次判为变宽并clear整绘；保留旧Kitty ID供该整绘清理图片，不在这里删图。
	// protected表示子类可用、普通外部调用方不可用；override让TS核对确实覆写了基类方法。
	protected override resetRenderState(): void {
		// 丢弃旧行比较基准。
		this.previousLines = [];
		// -1非0且与正常列数不同，下一帧触发widthChanged。
		this.previousWidth = -1;
		// 高度也设为强制变化标记。
		this.previousHeight = -1;
		// 重置内容末行估计。
		this.cursorRow = 0;
		// 重置光标逻辑行估计，整绘会重新建立。
		this.hardwareCursorRow = 0;
		// 清空工作区最大高度计数。
		this.maxLinesRendered = 0;
		// 视口逻辑原点回0，旧图片集合故意不在此清除。
		this.previousViewportTop = 0;
	}

	// 基类stop关闭终端前的钩子，通常把光标送到内容之后并换行，让shell接续输出；可能实际写终端并抛错。
	// preserveScreen为真或没有旧内容时跳过本钩子；例已有3行、硬件光标在第1行时先相对下移再CRLF。
	// 跳过不意味着整个stop不写任何控制码：基类随后仍显示光标、调用terminal.stop等。
	protected override beforeTerminalStop(options: TuiStopOptions): void {
		// ||任一成立就结束；这里只控制下面的补空格/移动/换行。
		if (options.preserveScreen || this.previousLines.length === 0) return;
		// 先写一个空格，可能影响当前位置；不是清整行或清屏。
		this.terminal.write(" ");
		// 行数对应末行下一行的逻辑索引，比如3行时末索引2、目标3。
		const targetRow = this.previousLines.length;
		// 目标逻辑行减光标逻辑行，得到需要移动的带符号行差。
		const lineDiff = targetRow - this.hardwareCursorRow;
		// 正差用CSI n B请求向下移动，实际边界由终端处理。
		if (lineDiff > 0) this.terminal.write(`\x1b[${lineDiff}B`);
		// 负差取相反数，用CSI n A向上移动；零差不发移动码。
		else if (lineDiff < 0) this.terminal.write(`\x1b[${-lineDiff}A`);
		// CR回列0，LF换行，终端底部可能因此滚动。
		this.terminal.write("\r\n");
	}

	// 遍历给定行，收集各行第一个Kitty头的有效ID并去重，返回新Set；不查询或删除真实图片。
	// 例如两行都含i=42，结果只有42，用于下次全屏清理。
	private collectKittyImageIds(lines: string[]): Set<number> {
		// 泛型Set<number>在TS中约束元素为数字，运行时Set负责值去重。
		const ids = new Set<number>();
		// 按行扫描，包括可能夹有光标控制码的图片行。
		for (const line of lines) {
			// 逐个遍历该行首个头解析出的ID，普通文字得到空列表。
			for (const id of extractKittyImageIds(line)) {
				// 加入集合，重复数字不会增加集合大小。
				ids.add(id);
			}
		}
		// 返回集合引用，调用方保存为下一帧的旧图集合。
		return ids;
	}

	// 把可迭代的ID转换成连续Kitty删除命令串，无终端写入；调用方append后才可能真正发出。
	// Iterable<number>允许Set、数组等可供for...of遍历的对象；不是只能传Iterator。例[42]生成释放42数据的删除串。
	private deleteKittyImages(ids: Iterable<number>): string {
		// 空输入返回空字符串，从空命令缓冲开始。
		let buffer = "";
		// 按迭代器顺序取ID；本函数不额外去重或验证范围。
		for (const id of ids) {
			// deleteKittyImage只编码a=d,d=I的命令，+=顺序连接各条命令。
			buffer += deleteKittyImage(id);
		}
		// 返回尚未发送的协议字符串。
		return buffer;
	}

	// 计算index图片行之后可当作图片占位的连续行数；最多到maxIndex（含）和数组结尾，无副作用。
	// 头中r=3且后面两行无可见文字/图片，则返回3；若紧接普通文字则只算图片本行1。
	// 默认参数使用这次lines.length-1；它不是终端测量，不保证图像实际大小与报文声明一致。
	private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
		// 缺少数组元素时用空串解析，未找到r按1；??不把已有空串当成缺失。
		const rows = extractKittyImageRows(lines[index] ?? "");
		// 单行图片/普通行直接返回1，无需扫描后续行。
		if (rows <= 1) return 1;

		// 三者取最小：声明行数、允许范围剩余行数、数组实际剩余行数，避免跨过差量绘制边界。
		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		// 至少保留图片自身一行；假设index由调用方传入正常行下标，不单独验证索引。
		let reservedRows = 1;
		// 仍可扩展占位区时，向后看下一行。
		while (reservedRows < maxRows) {
			// 用图片起点加已计行数定位下一候选行；异常缺项回退空串。
			const line = lines[index + reservedRows] ?? "";
			// 下一张图片或任何可见文字截断占位区；只有ANSI样式但显示宽0的行可以计入。
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			// 空白占位有效，累计一行后继续检查。
			reservedRows++;
		}
		// 返回这次扫描确认的连续预留行数，而非直接返回头中的r。
		return reservedRows;
	}

	// 把变化区扩展到需要一起重绘的Kitty图片块，输入首/尾变化行及新行数组，返回新的闭区间；不修改行或终端。
	// 例如第0行变化、第5行有图片，即使5超过原lastChanged也会扩展到该图片块，以处理前方行更新对放置的影响。
	// 两轮分别检查旧/新行；条件还覆盖从更早处开始但占位区与原变化区相交的图片。不是只选原区间内图片。
	private expandChangedRangeForKittyImages(
		// 原始变化区起点，0基索引；本方法中用作固定比较基准。
		firstChanged: number,
		// 原始变化区终点（含），同样不随扩展变量更新。
		lastChanged: number,
		// 新一帧行数据，还会另外扫描实例中的上一帧数据。
		newLines: string[],
		// 返回类型是含两个number字段的对象；它只约束TS，不建立运行时区间验证。
	): { firstChanged: number; lastChanged: number } {
		// 扩展起点先等于原起点，之后只能用Math.min向前扩大。
		let expandedFirstChanged = firstChanged;
		// 扩展终点先等于原终点，之后只能用Math.max向后扩大。
		let expandedLastChanged = lastChanged;
		// 局部箭头函数检查一份行数组，通过闭包累积外层两端点，无返回结果/终端副作用。
		// 例如先扫旧帧的消失图片，再扫新帧的新增图片，二者影响合并在同一对变量中。
		const expandForLines = (lines: string[]): void => {
			// 遍历整份数组，不只扫描变化区。
			for (let i = 0; i < lines.length; i++) {
				// 没有可解析有效ID的行跳过，包括不带ID的Kitty图片和iTerm2图片。
				if (extractKittyImageIds(lines[i]).length === 0) continue;
				// 起点加预留行数减1，得到包含占位空行的图片块末索引。
				const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
				// 第一项包含从firstChanged起的所有后续图片；第二项包含起点更早但块末覆盖原起点的图片，比较仍用原区间。
				if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
					// 图片起点若更靠前，扩展首变化行以保证能删除/重绘整个放置。
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					// 图片块末若更靠后，扩展末变化行，连占位行一起处理。
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		// 先纳入旧图片，即使新帧已没有它也要考虑清理。
		expandForLines(this.previousLines);
		// 再纳入新图片，让新增/移动放置也有完整绘制范围。
		expandForLines(newLines);
		// 显式字段映射返回两个扩展值，不回写输入参数。
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
	}

	// 只扫描旧帧给定闭区间中的图片ID，去重后返回删除命令串；无实际终端写入。
	// 例如改动区[1,3]会删除旧1到3行里的图；负起点/倒置区间返回空串，超出旧数组的尾部被夹住。
	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		// 没有合法变化区时无需拼删图命令，直接返回空串。
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		// 用Set使同一旧ID在这次删除串里只出现一次。
		const ids = new Set<number>();
		// 终点不能超过旧帧最后一行；若起点已超旧帧，循环自然不运行。
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		// 遍历旧帧的闭区间，<=包括最后一行。
		for (let i = firstChanged; i <= maxLine; i++) {
			// 解析当前旧行的首个Kitty头；缺项按普通空行。
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				// 去重收集此区间要清除的ID。
				ids.add(id);
			}
		}

		// 委托纯编码助手拼命令，不在这里发送或更新旧图集合。
		return this.deleteKittyImages(ids);
	}

	// 执行一帧绘制：取尺寸→完整render组件/浮层→取光标→比较旧行→选择整绘/删除尾行/差量更新→保存缓存。
	// 无参数/无返回值；基类renderNow或定时调度进入这里，可能写终端、删Kitty图、清滚动历史、同步写日志并抛错。
	// 例["标题","等待"]变成["标题","完成"]通常只重绘第1行；改终端列数则整绘。前后比较包含ANSI字符串，不只可见文字。
	// 输出采用分块/同步输出协议请求减少闪烁，不提供事务回滚；中途write、render、文件操作等失败会直接传播，缓存可能尚未完整更新。
	protected doRender(): void {
		// stop后忽略绘制；基类初始stopped=false，所以尚未start也能被显式renderNow绘制。
		if (this.stopped) return;
		// 从注入Terminal读取当前列数，不在此调用系统终端API。
		const width = this.terminal.columns;
		// 读取可见行数；后面逻辑按终端通常提供的有效正尺寸计算。
		const height = this.terminal.rows;
		// 初始0不算尺寸改变；强制reset的-1则会算改变。&&会短路右侧判断。
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		// 高度变化也排除初始0标记。
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		// 已有旧高度时用旧视口顶部+高度估计逻辑缓冲尾端，否则以当前高度作为起点。
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		// 高度变化时保持估计缓冲尾端，反推新尺寸下旧画面的视口顶部；Math.max不让顶部负数。
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		// 本轮目标视口先与旧视口相同，后面主动滚动时两者相应调整。
		let viewportTop = prevViewportTop;
		// 局部记录当前光标逻辑行；先计算待输出移动，最后才把成功路径坐标写回实例。
		let hardwareCursorRow = this.hardwareCursorRow;
		// 把目标逻辑行转换成相对屏内行差的局部函数，返回正数向下、负数向上。
		// 例如当前逻辑行12、旧顶10、目标逻辑行15、新顶11：屏内2→4，差2。闭包读取当下的视口/光标局部变量。
		const computeLineDiff = (targetRow: number): number => {
			// 真实光标逻辑行减旧视口顶，得到当前屏内坐标。
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			// 目标逻辑行减目标视口顶，得到目标屏内坐标。
			const targetScreenRow = targetRow - viewportTop;
			// 相减得到相对移动量，避免直接把逻辑行号当屏内绝对坐标。
			return targetScreenRow - currentScreenRow;
		};

		// Render all components to get new lines
		// Resolve fake cursors before compositing so overlays and line slicing see plain SGR codes
		// Drop OSC 133 markers: the terminal reads 133;A as a new shell prompt, which ends program status (OSC 7501)
		// render(width)先渲染完整基础组件树；map逐行移除行首OSC133区段，再把伪光标标记解析成反色样式/按设置去除。
		// 箭头回调line => ...返回该行新字符串；没有移除行中OSC133，浮层行也不经过这里的前缀替换。
		let newLines = this.resolveFakeCursors(this.render(width).map((line) => line.replace(OSC133_ZONE_PREFIX, "")));

		// Composite overlays into the rendered lines (before differential compare)
		// 只要浮层栈有条目就进入合成，即使条目当前隐藏；实际可见性由基类compositeOverlays判断。
		if (this.hasOverlayEntries) {
			// 按浮层宽高/位置覆盖基础行，可能补足终端高度；发生在差量比较之前，也先处理浮层伪光标。
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// Extract cursor position before applying line resets (marker must be found first)
		// 基类从底部可见height行由下往上找光标标记，取显示列并移除找到的一个标记；找不到为null。
		const cursorPos = this.extractCursorPosition(newLines, height);

		// 原数组普通行规范化终端输出并补段末重置，图片行跳过；返回同一数组，结果作为比较/绘制基准。
		newLines = this.applyLineResets(newLines);

		// Helper to clear scrollback and viewport and render all new lines
		// 局部整绘函数接收clear开关：true先删旧Kitty图并清屏/滚动历史，false直接写整份新行。
		// 闭包读取本轮尺寸/行/光标并在写出后更新实例缓存，返回void；例如首帧false、窗口变宽true。
		// 它不调用下方差量分支的普通行越宽检测，也不保证终端支持同步输出；write/光标定位失败可中断缓存更新。
		const fullRender = (clear: boolean): void => {
			// 先计一次整绘尝试；若后面输出失败，计数也不会撤回。
			this.fullRedrawCount += 1;
			// 构造分块写入器并注入箭头回调；此时未调用terminal.write，append满块或flush时才实际发送。
			const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
			// 追加CSI ?2026h请求终端同步输出；可能暂存在缓冲，不表示此行已显示。
			output.append("\x1b[?2026h"); // Begin synchronized output
			// clear决定是否清除旧屏，首帧一般不清、强制重绘则清。
			if (clear) {
				// 把上帧ID对应的删除及释放数据命令排在清屏前；本地集合暂时不清空。
				output.append(this.deleteKittyImages(this.previousKittyImageIds));
				// 依次请求擦除可见屏、光标回原点、擦除滚动历史；这会影响用户终端历史，非单纯重画文字。
				output.append("\x1b[2J\x1b[H\x1b[3J"); // Clear screen, home, then clear scrollback
			}
			// 遍历完整新帧，每个数组元素代表一个逻辑终端行。
			for (let i = 0; i < newLines.length; i++) {
				// 首行前不换行，后续行用CRLF归列0并前进一行。
				if (i > 0) output.append("\r\n");
				// 取当前完整字符串，可能含图片/ANSI控制报文。
				const line = newLines[i];
				// 前缀识别允许图片序列出现在行中，返回boolean。
				const isImage = isImageLine(line);
				// 图片行检查后续连续空占位，普通行直接按1处理；?:只执行选中的分支。
				const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i) : 1;
				// 多行图片且预留行数不超过可见高度时，先占出空间再放图片，避免后写空行擦掉放置。
				if (imageReservedRows > 1 && imageReservedRows <= height) {
					// 图片本行之外，还有reservedRows-1行要预留。
					for (let row = 1; row < imageReservedRows; row++) {
						// 先输出空行，必要时让内容滚动，为图像留出足够可见区域。
						output.append("\r\n");
					}
					// 从预留区末尾回到图片起点，CSI n A不改变列。
					output.append(`\x1b[${imageReservedRows - 1}A`);
					// 在起点发送图片行，通常报文要求不自行移动光标。
					output.append(line);
					// 再下移到预留区末端，保持后续行的位置。
					output.append(`\x1b[${imageReservedRows - 1}B`);
					// 手动跳过已预留的占位行，外层for还会再执行一次i++。
					i += imageReservedRows - 1;
					// 不让同一图片/占位行落到普通append路径重复输出。
					continue;
				}
				// 普通行、单行图或比视口更高的图直接发送；此整绘路径没有普通行宽度检查。
				output.append(line);
			}
			// 追加同步输出结束请求，终端可在收齐后展示；只是协议请求，不是JS原子操作。
			output.append("\x1b[?2026l"); // End synchronized output
			// 发送剩余块；前面的满块可能早已发送，flush不等待终端实际绘制确认。
			output.flush();
			// 内容末行逻辑索引为行数减1，空帧按0记录。
			this.cursorRow = Math.max(0, newLines.length - 1);
			// 先假设输出后光标停在内容末尾，下方再按输入标记移动。
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing, otherwise track growth
			// 清屏之后旧工作区已抹掉，可以重置曾绘制的最大行数。
			if (clear) {
				// 直接以这次新行数作为新的高水位。
				this.maxLinesRendered = newLines.length;
			} else {
				// 没有清屏则只扩大高水位，不因内容变短缩小。
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			// 逻辑缓冲至少容纳一整个终端高度，内容更多时按内容行数。
			const bufferLength = Math.max(height, newLines.length);
			// 缓冲尾部减高度得到末尾可见窗口起点。
			this.previousViewportTop = Math.max(0, bufferLength - height);
			// 输出后按提取到的输入位置移动/显示或隐藏硬件光标；此步也会写终端，失败则后续缓存尚未保存。
			this.positionHardwareCursor(cursorPos, newLines.length);
			// 保存这次处理后的行数组引用，下次用来逐行比较。
			this.previousLines = newLines;
			// 收集新行中首头有效Kitty ID供未来清理，不验证实际图片显示成功。
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			// 记录本帧列数，后续检测窗口变宽/变窄。
			this.previousWidth = width;
			// 记录本帧高度，本轮整绘到此完成。
			this.previousHeight = height;
		};

		// 只有PI_TUI_DEBUG_REDRAW精确为"1"才读取配置目录；即使开关打开，未提供目录仍禁用这类日志。
		const redrawLogDirectory = process.env.PI_TUI_DEBUG_REDRAW === "1" ? this.logDirectory : undefined;
		// 局部日志回调按reason追加整绘原因，返回void；只在启用并有目录时同步建目录/写文件。
		// 例如记录“terminal width changed”；构造闭包不写文件，调用时才写，文件错误不被吞掉，会阻止后续整绘。
		const logRedraw = (reason: string): void => {
			// 目录未定义直接跳过；不把此类调试日志回退到临时目录。
			if (redrawLogDirectory === undefined) return;
			// 在指定目录内固定写pi-tui-debug.log，path.join处理路径分隔符。
			const logPath = path.join(redrawLogDirectory, "pi-tui-debug.log");
			// 模板字符串组装时间戳、原因、旧/新行数和高度并加换行；这里读取的是整绘前的缓存。
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			// 同步创建父目录，recursive允许已存在及多级目录。
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			// 追加而非覆盖日志文件，写入失败直接抛出。
			fs.appendFileSync(logPath, msg);
		};

		// First render - just output everything without clearing (assumes clean screen)
		// 没有旧行且未判定尺寸变化时当首帧；也可能是空帧之后再次有内容，不验证实际屏幕是否干净。
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			// 按日志开关记录首帧整绘原因。
			logRedraw("first render");
			// 不先清屏，按“当前适合直接输出”的假设写全部新行。
			fullRender(false);
			// 此帧已处理，跳过下面尺寸/差量分支。
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		// 只要判定列数变化，优先清屏整绘，避免旧折行布局与新宽度混用。
		if (widthChanged) {
			// 记录具体旧/新列数，帮助定位重复整绘。
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			// 删旧图并清可见屏/历史，按新宽度渲染的结果重新输出。
			fullRender(true);
			// 结束本轮，不再做差量计算。
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		// 非Termux的高度改变也整绘；Termux标记为真时跳过这个原因，后续仍可能因其他原因整绘。
		if (heightChanged && !isTermuxSession()) {
			// 记录高度改变原因；模板内表达式读取上帧/当前行数。
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			// 在新的可见高度下重建整幅屏幕和视口缓存。
			fullRender(true);
			// 整绘完成就返回。
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink()
		// 同时满足显式启用缩短清理、行数低于历史最大、浮层栈无任何条目时整绘；隐藏浮层条目也会阻止这个分支。
		if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
			// 写日志说明缩短触发，附上原工作区高水位。
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			// 清旧工作区并把maxLinesRendered重置为新行数。
			fullRender(true);
			// 结束此帧的缩短整绘路径。
			return;
		}

		// Find first and last changed lines
		// -1表示尚未发现变化起点，0是合法第一行不能作“未找到”标记。
		let firstChanged = -1;
		// 末变化行同样先用-1表示没有。
		let lastChanged = -1;
		// 扫描新旧长度较大者，这样新增和删除的尾行都能比较到。
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		// 按0基索引逐行比较整个处理后的新旧帧。
		for (let i = 0; i < maxLines; i++) {
			// 超出旧帧长度时把该旧行看成空字符串。
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			// 超出新帧长度时把该新行看成空字符串，表示已删除。
			const newLine = i < newLines.length ? newLines[i] : "";

			// 字符串严格不等就有变化；相同显示文字但ANSI样式串不同也会重绘。
			if (oldLine !== newLine) {
				// 只有首次变化才设置起点，后续保留较早起点。
				if (firstChanged === -1) {
					// 保存首次不相等的行索引。
					firstChanged = i;
				}
				// 每次变化都更新终点，扫描结束后得到最后一次变化行。
				lastChanged = i;
			}
		}
		// 新增行通过长度比较独立识别，确保追加空字符串也被考虑。
		const appendedLines = newLines.length > this.previousLines.length;
		// 只要新帧更长，就把新增尾部纳入变化区。
		if (appendedLines) {
			// 此前逐行比较可能没发现差异，例如追加空串与缺失旧行都当作空。
			if (firstChanged === -1) {
				// 这种情况下从旧长度处（新增第一行）开始绘制。
				firstChanged = this.previousLines.length;
			}
			// 末变化行至少扩到新帧最后一行。
			lastChanged = newLines.length - 1;
		}
		// 确有变化才计算图片放置相关的扩大区间。
		if (firstChanged !== -1) {
			// 同时参考旧/新帧Kitty图片块扩大范围，后续删旧图和绘制共用此区间。
			const expandedRange = this.expandChangedRangeForKittyImages(firstChanged, lastChanged, newLines);
			// 把可变起点替换为扩大后的值。
			firstChanged = expandedRange.firstChanged;
			// 把可变终点替换为扩大后的值。
			lastChanged = expandedRange.lastChanged;
		}
		// 纯追加路径要求新帧更长、首变化恰为旧末后且旧帧非空；若图片扩展改了起点，就不能按纯追加定位。
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		// 没有行差异时不输出正文，但光标标记可能移动了，仍需处理硬件光标。
		if (firstChanged === -1) {
			// 按本轮cursorPos移动或隐藏光标，不强行重绘相同文字。
			this.positionHardwareCursor(cursorPos, newLines.length);
			// 保存本轮按高度调整过的旧视口顶；此路径不替换previousLines。
			this.previousViewportTop = prevViewportTop;
			// 更新高度，典型场景是Termux只改变高度而内容未变。
			this.previousHeight = height;
			// 无正文差异路径完成。
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		// 首变化已在新帧末尾之后，表示现有新行无需写，只需清理删掉的旧尾行。
		if (firstChanged >= newLines.length) {
			// 实际旧长度更长才执行清理；长度未变等情况不会建立输出器。
			if (this.previousLines.length > newLines.length) {
				// 建立本次尾行清理的分块输出器，回调捕获当前实例；构造不发送。
				const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
				// 缓冲同步输出开始请求。
				output.append("\x1b[?2026h");
				// 缓冲删除受影响旧Kitty ID的命令，排在擦行前。
				output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
				// Move to end of new content (clamp to 0 for empty content)
				// 把定位目标放在新内容最后一行；新内容完全为空时按逻辑0定位。
				const targetRow = Math.max(0, newLines.length - 1);
				// 若目标在旧视口上方，单靠当前可见区域差量擦行无法正确恢复布局。
				if (targetRow < prevViewportTop) {
					// 记录尾部删除导致视口向上移动的原因。
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					// 放弃这一差量方案，清屏整绘；此前append可能已因满块发送部分内容，不能视作撤销。
					fullRender(true);
					// 整绘已更新缓存，结束尾行清理路径。
					return;
				}
				// 通过屏内坐标差计算当前硬件光标到目标行的相对移动量。
				const lineDiff = computeLineDiff(targetRow);
				// 目标在下方时追加向下移动请求。
				if (lineDiff > 0) output.append(`\x1b[${lineDiff}B`);
				// 目标在上方时取正的距离向上移动，零差不发。
				else if (lineDiff < 0) output.append(`\x1b[${-lineDiff}A`);
				// 回到第0列，擦行操作从行首开始。
				output.append("\r");
				// Clear extra lines without scrolling
				// 旧长度减新长度就是待擦除的尾行数。
				const extraLines = this.previousLines.length - newLines.length;
				// 删除数超过可见高度时走整绘，不尝试一次差量处理整个不可见旧区。
				if (extraLines > height) {
					// 记录删除范围过大的退路原因。
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					// 完整清屏并绘制现存新行，可能已发送的差量前缀不会回滚。
					fullRender(true);
					// 整绘之后结束。
					return;
				}
				// 新帧非空需从其末行下一行开始擦；空帧则从目标第0行直接擦。
				const clearStartOffset = newLines.length === 0 ? 0 : 1;
				// 确有额外尾行且需要跳过新末行时，先向下一行。
				if (extraLines > 0 && clearStartOffset > 0) {
					// 追加CSI B，不用LF，避免这一步本身引入滚动。
					output.append(`\x1b[${clearStartOffset}B`);
				}
				// 逐行处理需要清除的旧尾部。
				for (let i = 0; i < extraLines; i++) {
					// CR到行首，CSI 2K擦整行，不用换行码。
					output.append("\r\x1b[2K");
					// 除了最后一个待擦行，每轮只下移一行；终端边界处仍受终端自身限制。
					if (i < extraLines - 1) output.append("\x1b[1B");
				}
				// 计算擦除后需上移多少回到targetRow；多擦extraLines-1行，再加最初起始偏移。
				const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
				// 有正移动量才发回移请求。
				if (moveBack > 0) {
					// 向上回到新内容末行或空帧的第0行。
					output.append(`\x1b[${moveBack}A`);
				}
				// 请求终端结束同步输出。
				output.append("\x1b[?2026l");
				// 发送余下擦除控制串；若write失败，下方坐标缓存不会全部更新。
				output.flush();
				// 尾部清理成功发送后，保存新的内容末行逻辑坐标。
				this.cursorRow = targetRow;
				// 此时硬件光标也估计在同一行，下一步可能按焦点再移动。
				this.hardwareCursorRow = targetRow;
			}
			// 更新焦点光标位置/可见性，即使没有新正文也执行。
			this.positionHardwareCursor(cursorPos, newLines.length);
			// 以缩短后的新行数组替换旧比较基准。
			this.previousLines = newLines;
			// 重建剩余新帧图片ID集合，已经删掉的旧图不再追踪。
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			// 保存本帧宽度。
			this.previousWidth = width;
			// 保存本帧高度。
			this.previousHeight = height;
			// 保存这条路径的视口顶；这里不重置maxLinesRendered，高水位仍保留。
			this.previousViewportTop = prevViewportTop;
			// 尾部删除处理完毕，跳过正文差量绘制。
			return;
		}

		// Differential rendering can only touch what was actually visible.
		// If the first changed line is above the previous viewport, we need a full redraw.
		// 首变化在上次可见窗口上方时，差量光标移动碰不到那段历史，改用整绘。
		if (firstChanged < prevViewportTop) {
			// 记录首变化和旧视口顶以解释为什么没用差量。
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			// 删旧图、清屏/历史后重新输出完整帧。
			fullRender(true);
			// 这一帧不再继续差量。
			return;
		}

		// Render from first changed line to end
		// Keep updates wrapped in synchronized output while writing bounded chunks.
		// 下面只绘变化闭区间；新输出器仍可在append满块时提前发出，并非先全拼好再原子提交。
		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		// 开始同步输出请求，尽量让终端合并展示这些更新。
		output.append("\x1b[?2026h"); // Begin synchronized output
		// 先请求删除区间内旧图，之后再绘新放置，避免旧图残留覆盖文字。
		output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
		// 旧视口的末行逻辑索引=顶部+高度-1。
		const prevViewportBottom = prevViewportTop + height - 1;
		// 纯追加先定位旧末行再CRLF；普通变化直接定位第一变化行。
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		// 要去的位置在旧可见窗口下方时，先把屏幕滚动到能到达它的位置。
		if (moveTargetRow > prevViewportBottom) {
			// 把本地硬件光标估计夹到屏内[0,height-1]，准备移动到屏幕最底行。
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			// 可见末行索引height-1减当前屏内行，得到到达底部的距离。
			const moveToBottom = height - 1 - currentScreenRow;
			// 尚未在底部才需要下移。
			if (moveToBottom > 0) {
				// 追加相对下移控制码，先把终端光标放到底部。
				output.append(`\x1b[${moveToBottom}B`);
			}
			// 目标超出旧视口底部多少行，就需滚动多少行才能让它可见。
			const scroll = moveTargetRow - prevViewportBottom;
			// 重复CRLF在底部推进并触发滚动；repeat创建这段字符串，不是逐次调用write。
			output.append("\r\n".repeat(scroll));
			// 计算中的旧视口顶随主动滚动同步向下。
			prevViewportTop += scroll;
			// 目标视口顶也移动相同行数，此时两套坐标仍对齐。
			viewportTop += scroll;
			// 本地光标估计更新为刚通过滚动到达的目标逻辑行，还未写回实例字段。
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		// 再次按当前两个视口和本地光标计算定位量；刚执行滚动分支时通常为0。
		const lineDiff = computeLineDiff(moveTargetRow);
		// 目标屏内行在下方，发向下移动码。
		if (lineDiff > 0) {
			// 把正行差编码成CSI n B。
			output.append(`\x1b[${lineDiff}B`); // Move down
			// 否则若目标在上方，发向上移动码；等于0则两支都不执行。
		} else if (lineDiff < 0) {
			// 负差取相反数作为CSI n A的正参数。
			output.append(`\x1b[${-lineDiff}A`); // Move up
		}

		// 纯追加从旧末行CRLF进新增首行；其他修改仅CR回本行第0列。
		output.append(appendStart ? "\r\n" : "\r"); // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		// 最多写到新帧最后一行，避免旧帧删除尾部的lastChanged超过新数组；区间内部未变行也会写。
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		// 依次绘首变化到renderEnd（含），不是每个差异单独跳转，也不必写完全部后续未变行。
		for (let i = firstChanged; i <= renderEnd; i++) {
			// 除区间首行外，每行先CRLF移到下一行行首。
			if (i > firstChanged) output.append("\r\n");
			// 读取这一行的最终控制串/文字。
			const line = newLines[i];
			// 判断是否含已知图片协议前缀，图片不走普通文字的宽度约束。
			const isImage = isImageLine(line);
			// 只在本次绘制区间里计算图片后续空白占位，maxIndex传renderEnd防止跳过区间之外的行。
			const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;
			// 至少两行的图要先擦出整个占位区，再放置图片。
			if (imageReservedRows > 1) {
				// 逻辑图片行减本轮视口顶部，转换为屏内起始行。
				const imageStartScreenRow = i - viewportTop;
				// 起点在屏外或图片占位延伸越过屏底时，预先擦行可能造成滚动，不能用本段差量方案。
				if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
					// 记录图片预清理越界原因；下面多行实参共同组成一次日志调用。
					logRedraw(
						// 原因串包含图片屏内起点、预留行数和终端高度，便于重现越界计算。
						`kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`,
					);
					// 转到带清屏的整绘退路；此时输出器中可能有已发送块，整绘并非撤销这些输出。
					fullRender(true);
					// 整绘后结束本轮差量路径，不再发送这个输出器剩余缓冲。
					return;
				}

				// 先清图片起点的整行；此处仍处在行首。
				output.append("\x1b[2K");
				// 依次预清除图片其余占位行。
				for (let row = 1; row < imageReservedRows; row++) {
					// 每前进一行就擦整行；必须发生在新图片报文之前。
					output.append("\r\n\x1b[2K");
				}
				// 预清完成后向上回到图片起点，避免图画在底部占位行。
				output.append(`\x1b[${imageReservedRows - 1}A`);
				// 此时才追加图片报文，之前的擦行不会在图画出后把它抹掉。
				output.append(line);
				// 下移到占位区最后一行，后面的正文从下一行继续。
				output.append(`\x1b[${imageReservedRows - 1}B`);
				// 跳过刚才已预留的空白行，外层for下一步再加1。
				i += imageReservedRows - 1;
				// 该图片处理完，不再进入普通清行/追加分支。
				continue;
			}

			// 普通行及单行图片先清整行，避免较短新文字留下旧尾部。
			output.append("\x1b[2K"); // Clear current line
			// 仅差量路径且非图片行才检查显示列数是否超宽；这里发现的是组件没有遵守render宽度契约。
			if (!isImage && visibleWidth(line) > width) {
				// Log all lines to crash file for debugging
				// ??在日志目录未定义时用OS临时目录，固定文件pi-tui-crash.log；不会默认写用户家目录。
				const crashLogPath = path.join(this.logDirectory ?? os.tmpdir(), "pi-tui-crash.log");
				// 构造崩溃诊断的行数组，包含时间、宽度、出错行和全帧文本；最终join成一个日志字符串。
				const crashData = [
					// 记录诊断生成时间，ISO字符串使用UTC。
					`Crash at ${new Date().toISOString()}`,
					// 记录当帧终端列数。
					`Terminal width: ${width}`,
					// 记录出错逻辑行及重新测得的显示宽度。
					`Line ${i} visible width: ${visibleWidth(line)}`,
					"",
					// 这段固定标题标出后面的完整帧转储。
					"=== All rendered lines ===",
					// map回调按行生成索引/显示宽/原始串，...把这些字符串展开到外层数组，日志可能包含控制码和正文。
					...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
					// 用LF拼接日志行，末尾空串让结果以换行结尾；这是整体日志字符串，未使用分块写入器。
				].join("\n");
				// 确保崩溃日志父目录存在，同步操作错误会先于下面的预期宽度错误抛出。
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				// 覆盖写入完整崩溃日志，没有追加或脱敏步骤。
				fs.writeFileSync(crashLogPath, crashData);

				// Clean up terminal state before throwing
				// 停止渲染并按基类流程恢复光标/终端模式；没有finally，前面文件操作若失败就到不了这里，部分渲染输出也不会回滚。
				this.stop();

				// 组装要抛出的错误文字：具体超宽、组件排查建议、测宽/截断函数及诊断文件位置。
				const errorMsg = [
					// 第一行给出逻辑行号和超宽的实际值/限制值。
					`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
					"",
					// 提示常见原因是自定义组件未把输出截到传入宽度，并非验证了唯一原因。
					"This is likely caused by a custom TUI component not truncating its output.",
					// 提示按显示列测量与截断的现有助手，不是直接用字符串length。
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					// 最后指明刚写出的崩溃日志路径。
					`Debug log written to: ${crashLogPath}`,
					// 把多段错误文本用换行连接，保留段落间空行。
				].join("\n");
				// 构造并抛出Error；当前帧不保存成功缓存，输出器未flush的尾块也不会在此自动发送。
				throw new Error(errorMsg);
			}
			// 未触发超宽错误才把这一行排入输出，图片行不以可见宽度拒绝。
			output.append(line);
		}

		// Track where cursor ended up after rendering
		// 循环结束时估计光标位于最后绘制行；若稍后擦除旧尾行，会调整这个本地记录。
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		// 新帧比旧帧短时，除了绘变化行，还要抹掉旧尾部残余。
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			// 本轮可能只改了中间一行，光标尚未到新内容末尾，先移动过去再清旧尾行。
			if (renderEnd < newLines.length - 1) {
				// 计算当前绘制末行到新内容末行的距离。
				const moveDown = newLines.length - 1 - renderEnd;
				// 追加向下移动，不重绘途中未变的行。
				output.append(`\x1b[${moveDown}B`);
				// 更新光标本地逻辑行估计为新内容末行。
				finalCursorRow = newLines.length - 1;
			}
			// 需要清掉的旧尾行数量。
			const extraLines = this.previousLines.length - newLines.length;
			// 从新长度到旧长度-1逐个处理已经消失的行。
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				// CRLF进入下一旧尾行并擦掉整行；与上面纯删除分支使用CSI B不同，这里可能引起滚动。
				output.append("\r\n\x1b[2K");
			}
			// Move cursor back to end of new content
			// 全部擦完后上移extraLines，回到新内容末行；不把游标留在已删除的区域。
			output.append(`\x1b[${extraLines}A`);
		}

		// 缓冲同步输出结束请求；大帧可能已发送若干满块，此处仍不承诺已完成展示。
		output.append("\x1b[?2026l"); // End synchronized output

		// PI_TUI_DEBUG精确为"1"时启用逐帧差量诊断，这是与PI_TUI_DEBUG_REDRAW分开的开关。
		if (process.env.PI_TUI_DEBUG === "1") {
			// 这类调试固定目录为/tmp/tui，不使用logDirectory；普通禁用分支不会创建它。
			const debugDir = "/tmp/tui";
			// 同步递归建目录，失败会中断尚未完成的这一帧。
			fs.mkdirSync(debugDir, { recursive: true });
			// 文件名用当前毫秒时间和随机base36后缀降低重名机会，不保证绝对唯一。
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			// 收集当前局部计算值、旧缓存和新旧行数据，辅助排查视口/光标错误；字符串数组最后join。
			const debugData = [
				// 记录扩大后的变化区起点。
				`firstChanged: ${firstChanged}`,
				// 记录本轮目标视口顶部，包含主动滚动后的调整。
				`viewportTop: ${viewportTop}`,
				// 记录实例旧内容末行；尚未执行下方成功更新，不是本轮新值。
				`cursorRow: ${this.cursorRow}`,
				// 记录本轮终端可见高度。
				`height: ${height}`,
				// 记录本次初始定位的相对行差。
				`lineDiff: ${lineDiff}`,
				// 记录局部硬件光标起点估计，后续循环结束位置另由finalCursorRow记录。
				`hardwareCursorRow: ${hardwareCursorRow}`,
				// 记录实际正文绘制区间终点，可能比新帧末行更早。
				`renderEnd: ${renderEnd}`,
				// 记录本轮追加/擦尾后的光标逻辑行估计。
				`finalCursorRow: ${finalCursorRow}`,
				// 光标标记坐标用JSON输出，null也保留为文本"null"。
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				// 记录本轮新帧总行数。
				`newLines.length: ${newLines.length}`,
				// 记录比较基准旧帧行数。
				`previousLines.length: ${this.previousLines.length}`,
				"",
				// 标出下面是新帧行数组。
				"=== newLines ===",
				// JSON.stringify第二参数null不做替换，第三参数2用两空格缩进，并把控制字符转义便于查看。
				JSON.stringify(newLines, null, 2),
				"",
				// 标出下面是旧帧行数组。
				"=== previousLines ===",
				// 旧行同样输出可查看的缩进JSON，可能包含完整会话文字。
				JSON.stringify(this.previousLines, null, 2),
				"",
				// 这一标题之后只记录输出长度，不保存整个拼接后的输出流。
				"=== buffer ===",
				// length包含已发码元与当前余量；英文written不是终端已确认显示的字节计数。
				`[${output.length} chars written in bounded chunks]`,
				// 用换行拼整份日志，前面的空字符串分隔各段。
			].join("\n");
			// 同步覆盖写该帧文件；失败无catch，会跳过后面的flush/缓存更新。
			fs.writeFileSync(debugPath, debugData);
		}

		// 发出最终余块；只有这一步正常返回才继续按成功路径保存坐标，先前满块已可能输出。
		output.flush();

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		// 内容末行固定按新帧长度计算，不等于只更新到的renderEnd；空帧保留0。
		this.cursorRow = Math.max(0, newLines.length - 1);
		// 硬件光标暂按绘制/清尾后的finalCursorRow记录，下一步再按焦点光标定位。
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		// 工作区最大行数保持单调不减，此差量路径不因缩短而重置。
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		// 视口顶至少维持已滚动的prevViewportTop，也要足以让输出后的finalCursorRow落在屏内底部。
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		// Position hardware cursor for IME
		// 移动真实光标到输入标记处以支持输入法候选窗口；有无显示由硬件光标配置决定。
		this.positionHardwareCursor(cursorPos, newLines.length);

		// 保存当前最终行数组，后续差量比较基于已经处理的样式/光标标记结果。
		this.previousLines = newLines;
		// 重建本帧ID集合，为未来差量/全量删图保留依据。
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		// 保存当前列数。
		this.previousWidth = width;
		// 保存当前可见行数，完成本轮成功路径。
		this.previousHeight = height;
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	// 把真实硬件光标定位到提取出的逻辑行/显示列，返回void，可能写移动码并显示/隐藏光标。
	// 例如当前在逻辑行5、目标{row:3,col:4}，先向上2行，再用CSI 5G到第5列（协议从1计数）。
	// 无标记/无内容时只隐藏；行夹到内容范围、列只限制非负，没有终端宽度上限或数值运行时验证。
	// 定位是为了输入法等宿主功能，即使配置隐藏硬件光标也会移动；write/显示操作失败向外抛出。
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		// 联合类型允许null；没有位置或没有可绘内容时不计算目标移动。
		if (!cursorPos || totalLines <= 0) {
			// 请求隐藏终端光标，不改变本地hardwareCursorRow。
			this.terminal.hideCursor();
			// 结束，保留此前光标行估计。
			return;
		}

		// Clamp cursor position to valid range
		// 目标逻辑行夹到[0,totalLines-1]，不是夹到屏内[0,height-1]；上游只从可见区域提取标记。
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		// 显示列只夹下界0，超出终端列数时由终端处理，不在此裁剪。
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		// 以已维护的硬件光标逻辑行作基准，相减得到移动量。
		const rowDelta = targetRow - this.hardwareCursorRow;
		// 此处是很短的光标控制串缓冲，不使用大帧分块器。
		let buffer = "";
		// 目标逻辑行在下方时添加下移请求。
		if (rowDelta > 0) {
			// CSI n B相对向下n行。
			buffer += `\x1b[${rowDelta}B`; // Move down
			// 目标逻辑行在上方时添加上移请求。
		} else if (rowDelta < 0) {
			// 取负行差的相反数作为CSI n A参数。
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		// CSI n G使用从1计数的绝对列，所以0基targetCol加1；无论行差是否为0都追加。
		buffer += `\x1b[${targetCol + 1}G`;

		// 只在控制串非空时写；正常经过上面的G码后一定非空，按原实现保留此条件。
		if (buffer) {
			// 把移动行和定位列一起写入终端，不等待终端报告新位置。
			this.terminal.write(buffer);
		}

		// write正常返回后更新真实光标的逻辑行估计。
		this.hardwareCursorRow = targetRow;
		// 读取基类配置；移动光标和让它可见是分开的动作。
		if (this.getShowHardwareCursor()) {
			// 配置显示时请求终端显示硬件光标。
			this.terminal.showCursor();
		} else {
			// 配置隐藏时请求隐藏；组件仍可通过伪光标反色展示当前位置。
			this.terminal.hideCursor();
		}
	}
}
