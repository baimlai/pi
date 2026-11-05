// Plain JSONL for archives (slice 6a §13): one part per line, UTF-8. The store yields and takes parts; this is the
// encoding it ships (others, compressed ones, come later without touching the applier).

// 文件导读
// 所属：packages/chord/src/store（store 层，归档 JSONL 编解码）。
// 职责边界：在 ArchivePart 异步流与 UTF-8 JSONL 字节流之间转换；不校验部件结构，不做压缩。
// 上游：store.export 的 parts 交给 encodeJsonl；importStore 把字节流交给 decodeJsonl。下游：归档文件/网络；decodeJsonl 的值进入 importStore 的部件校验。
// 能力清单：
// - CHUNK：输出块阈值，按字符串 UTF-16 length 而非字节；
// - encodeJsonl：逐个部件编码成整行 JSON，按阈值合并为字节块；
// - decodeJsonl：字节块流解码为 unknown 值流，错误带行号。
// 组合顺序：encode 每次追加完整行，达到阈值就 yield；decode 用流式 TextDecoder 拼跨块字符，按换行切分，跳过空白行。
// 示例：for await (const chunk of encodeJsonl(parts)) 得到约 64K 字符以内的字节块；for await (const value of decodeJsonl(bytes)) 得到每个非空行的 JSON 值。
// 建议阅读顺序：CHUNK -> encodeJsonl -> decodeJsonl（先看 parse/decode 闭包，再看主循环）。

import { invalid } from "../data/internal.ts";
import type { ArchivePart } from "./archive.ts";

/** The bytes a chunk of encoded lines collects before it is yielded. */
const CHUNK = 64 * 1024;

// 判断阈值实际使用下面的字符串 length（UTF-16 单元数），所以含中文时输出字节可能多于 64 KiB；超长一行也不会被拆开。

/** `parts` as JSONL bytes, in chunks of whole lines. */
// 将异步归档部件逐个编码为 UTF-8 JSON 行，按完整行累积后 yield 字节块；例如两个小部件可能合在一个块。消费才拉取输入，序列化或输入迭代错误会拒绝下一次迭代，不校验 ArchivePart 的运行时形状。
export async function* encodeJsonl(parts: AsyncIterable<ArchivePart>): AsyncIterable<Uint8Array> {
	// async function* 是异步生成器：yield 多次产出，而不是用 return 一次交付整个归档。
	const encoder = new TextEncoder();
	// 缓冲尚未交出的完整行；let 允许在发出块后重新置为空串。
	let lines = "";
	// for await…of 逐次等待上游部件，避免一次把整个归档收进内存。
	for await (const part of parts) {
		// 每个值先 JSON.stringify，再补一个换行；原字符串内的换行会被 JSON 转义。
		lines += `${JSON.stringify(part)}\n`;
		// 阈值只在追加完整行后检查，因此任何一个部件都不会跨输出块被切开。
		if (lines.length >= CHUNK) {
			// encode 创建这一批的 UTF-8 字节；消费者下一次拉取前，生成器停在 yield。
			yield encoder.encode(lines);
			// 已交付的行不再保留，后续部件开启下一批。
			lines = "";
		}
	}
	// 输入结束时发出不足阈值的尾批；输入为空时不产出空字节块。
	if (lines.length > 0) yield encoder.encode(lines);
}

/**
 * The values of JSONL `bytes`, one per nonempty line, for `importStore` to check (a trust boundary: bytes that are
 * no UTF-8 and a line that is no JSON are `invalid/args`).
 */
// 把任意分块的 UTF-8 JSONL 解成 unknown 值；例如一个 JSON 行跨两个字节块仍能拼回，空白行跳过。只验证编码与 JSON 语法，归档部件结构由 importStore 校验；坏编码或坏 JSON 抛 invalid/args 并带当前行号。
export async function* decodeJsonl(bytes: AsyncIterable<Uint8Array>): AsyncIterable<unknown> {
	// fatal:true 使非法 UTF-8 抛错，而不是静默替换成 U+FFFD；流模式可保留跨块的多字节字符。
	const decoder = new TextDecoder("utf-8", { fatal: true });
	// rest 保留尚未遇到换行的文本；line 统计已经处理的行，空行也计数。
	let rest = "";
	let line = 0;
	// 本地解析闭包返回 unknown：JSON.parse 能解析并不等于数据符合 ArchivePart。
	// 例如 "42" 会先解析成数字，随后才由导入边界决定是否接受；本闭包只转述语法错误。
	const parse = (text: string): unknown => {
		try {
			// 当前 line 由外层在调用前增加；解析成功直接交出原始 JSON 值。
			return JSON.parse(text);
		} catch {
			// 隐去底层解析器细节，统一成带行号的 Chord 参数错误。
			throw invalid("args", `jsonl: line ${line} is not JSON`);
		}
	};
	// chunk? 表示允许省略参数；省略时冲刷解码器尾部，例如最后一块留下半个 UTF-8 字符会在此报错。
	const decode = (chunk?: Uint8Array): string => {
		try {
			// 有块时保留流状态，无块时结束该流；三元表达式只执行选中的分支。
			return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true });
		} catch {
			// line+1 指当前正在收集的下一行；一个块含多行时这是块开始处理前的行号。
			throw invalid("args", `jsonl: line ${line + 1} is not UTF-8`);
		}
	};
	// 从上游异步拉字节块，每块可能包含半行、一行或多行。
	for await (const chunk of bytes) {
		// 解码器先处理跨块字节，再把文字接到尚未完结的行后面。
		rest += decode(chunk);
		// start 指本块缓冲中下一行的起始位置，避免每发现一行就重建整个尾串。
		let start = 0;
		// 找到换行就处理一行；更新式从新的 start 继续搜索，-1 表示没有完整行了。
		for (let end = rest.indexOf("\n"); end >= 0; end = rest.indexOf("\n", start)) {
			// slice 不含换行；CRLF 中的 \r 保留为 JSON 允许的尾部空白。
			const text = rest.slice(start, end);
			// 跳过刚找到的换行，随后搜索不会重复这一行。
			start = end + 1;
			// 即使这一行全是空白，也推进显示用行号。
			line++;
			// trim 只用于判断空白，实际解析仍使用原 text；yield 将值逐个交给导入器。
			if (text.trim().length > 0) yield parse(text);
		}
		// 完整行已经交付，只留下可能跨到下一字节块的半行。
		rest = rest.slice(start);
	}
	// 输入正常结束后冲刷 UTF-8 状态，未完成的字符会在这里被拒绝。
	rest += decode();
	// 没有末尾换行的最后一行也应有行号；空尾串只加计数，不产出值。
	line++;
	if (rest.trim().length > 0) yield parse(rest);
}
