// 编码/识别 OSC 7501 程序状态；terminal.ts 负责能力协商及写 stdout，这里只生成/检查字符串，当前只支持根记录。
/**
 * Program Status Protocol (OSC 7501): a program tells the terminal whether it is idle, working,
 * blocked on the user, done, or failed. Only the root record is supported.
 *
 * Spec: https://www.superlogical.com/rex/docs/build/program-status
 */

// 清连续 C0/C1 控制符，每段替换为一个空格，不是把 ANSI 样式整段解析删除。
import { replaceControlCharacters } from "./utils.ts";

// 编译期状态契约；formatter 不推断程序是否真的忙，也不重新运行时验证 state/kind 联合值。
export interface ProgramStatus {
	/** `clear` removes the status instead of reporting one. */
	// 六个字面量表示闲置、运行、等用户、完成、出错、清除；clear 是清除指令。
	state: "idle" | "working" | "blocked" | "done" | "error" | "clear";
	/** Stable program name, `[A-Za-z0-9_.+-]{1,32}`. Other values are omitted. */
	// 可选程序稳定标识；格式不符就省略，不拒绝整份报告。
	app?: string;
	/** What a blocked program waits for. Omitted for other states. */
	// blocked 时说明等授权/回答/登录；其他状态即使传入也会省略。
	kind?: "permission" | "question" | "auth";
	/** One human-readable line. Control characters become spaces; longer text is cut to the spec limit. */
	// 文字先清控制符/trim，再按 UTF-8 字节截断后 base64，不能拿字符串 length 当字节数。
	message?: string;
}

/** Feature detection query. A supporting terminal replies with the same body. */
// ESC ] 开始 OSC，7501 选协议，? 询问支持性，ESC 反斜杠是 ST 结束符；常量本身不发送。
export const PROGRAM_STATUS_QUERY = "\x1b]7501;?\x1b\\";

/** The reply to {@link PROGRAM_STATUS_QUERY}. Later spec revisions may add pairs after the `?`. */
// 判断整串是否是能力回复，返回 boolean；例：OSC 7501;? 后接 BEL 也通过。
// 只检查标记、无 BEL/ESC 的正文及结束符，不验证后续每个键值对，不保存协商状态。
export function isProgramStatusReply(sequence: string): boolean {
	// ^/$ 无 m 模式约束整串，否定字符组避开提前结束/嵌套 ESC，(?:...) 接受 BEL 或双字节 ST。
	return /^\x1b\]7501;\?[^\x07\x1b]*(?:\x07|\x1b\\)$/.test(sequence);
}

// app 允许指定 ASCII 字符且长度 1..32；无 g 标志，不留下 test 游标。
const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
/** Decoded `msg` limit. Its base64 encoding stays under the 2732-byte encoded limit. */
// 2048 个 UTF-8 字节最多编码成 2732 个 base64 ASCII 字符；限制解码后消息，并非 UTF-16 长度。
const MAX_MESSAGE_BYTES = 2048;

// 按 UTF-8 字节预算保留前缀；例：预算 3 字节最多放一个“中”。
// for...of 按码点迭代，用 UTF-16 长度累计 slice 下标；不切开有效代理对，但不保证组合字符/emoji 字素整体保留。无外部副作用。
function truncateUtf8(text: string, maxBytes: number): string {
	// 已在预算内直接返回原字符串，不再逐个码点计算。
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	// 累计已保留的 UTF-8 字节数。
	let bytes = 0;
	// 累计原字符串中使用的 UTF-16 单元数，供 slice 作截止下标。
	let end = 0;
	// for...of 与 text[index] 不同，会将有效代理对作为一个字符串交给 char。
	for (const char of text) {
		// 本码点 UTF-8 编码可能占 1..4 字节。
		const size = Buffer.byteLength(char, "utf8");
		// 下一个码点放不下就停，不越过它挑后面的短字符。
		if (bytes + size > maxBytes) break;
		// 纳入这一码点的字节预算。
		bytes += size;
		// BMP 长度 1，有效代理对长度 2；slice 接受 UTF-16 下标。
		end += char.length;
	}
	// 返回左闭右开的前缀，不修改原字符串。
	return text.slice(0, end);
}

/** Encode a status report. Terminals discard reports whose text contains control characters, so they are replaced. */
// 输入结构化状态，返回终端 OSC 报文；例：working + app:"pi" 得到 state=working:app=pi。
// 依次编码 state/合法 app/仅 blocked 的 kind/非空 msg；清洗消息后 UTF-8/base64。无发送、不修改 status，不进行支持性协商。
export function formatProgramStatus(status: ProgramStatus): string {
	// 必需 state 先入数组，具体联合值由 TS 契约约束，不在这里重复校验。
	const pairs = [`state=${status.state}`];
	// 显式 app 且正则通过才追加，非法标识不影响其他字段。
	if (status.app !== undefined && APP_PATTERN.test(status.app)) pairs.push(`app=${status.app}`);
	// 仅 blocked 且 kind 非空时追加；合法种类依赖调用者遵守类型。
	if (status.state === "blocked" && status.kind) pairs.push(`kind=${status.kind}`);
	// 缺省转空串，连续控制符变空格，trim 去首尾空白，再按 UTF-8 预算截断。
	const message = truncateUtf8(replaceControlCharacters(status.message ?? "").trim(), MAX_MESSAGE_BYTES);
	// 空消息省略；base64 不含字段分隔冒号或 OSC 结束控制符。
	if (message) pairs.push(`msg=${Buffer.from(message, "utf8").toString("base64")}`);
	// 冒号连接字段，外层包 OSC/ST；没有 id，因此指向根记录。
	return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}
