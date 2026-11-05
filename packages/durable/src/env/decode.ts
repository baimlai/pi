// 文件导读
// 所属：packages/durable/src/env 的字节解码辅助层，服务于行扫描和 shell 输出解码。
// 解决的问题：输入按任意大小的块到达时，解码结果必须与一次性调用 new TextDecoder().decode(全部字节) 相同。
// WHATWG/Node 的流式解码器在开启 BOM 处理时会丢掉块边界之后的 U+FEFF（不只是文件开头那一个），所以这里
// 关闭自动 BOM 处理，再由调用方或 StreamDecoder 只处理“流开头”的那一个 BOM。
// 职责边界：只把字节转成字符串，不读文件、不统计行、不限制内存；字节块必须由调用方按顺序提供。
// 上下游：上游是 index.ts 的 BinaryReader.scanLines 实现（LineScanner 使用 rangeDecoder/startsWithBom）和
// node.ts 的 NodeTextLineReader 与 exec 的 stdout/stderr（使用 StreamDecoder）；下游只有 WHATWG TextDecoder。
// 能力清单：
// - rangeDecoder()：返回保留所有 U+FEFF 的 UTF-8 流式解码器，文件开头的 BOM 由调用方跳过。
// - startsWithBom(firstBytes)：判断字节数组前三个字节是否为 UTF-8 BOM（EF BB BF）。
// - StreamDecoder：有状态的流式解码类；decode(chunk) 增量解码，decode() 结束流，只去掉流开头的一个 U+FEFF。
// 组合顺序：需要自己控制范围的扫描器用 rangeDecoder + startsWithBom；一整条文本流用 StreamDecoder。
// 示例（真实签名）：
//   const decoder = new StreamDecoder();
//   decoder.decode(Uint8Array.of(0xef, 0xbb)); // ""（BOM 字节尚未收齐）
//   decoder.decode(Uint8Array.of(0xbf, 0x41)); // "A"（流开头的 BOM 被去掉）
//   decoder.decode();                         // ""（结束流）
// 建议阅读顺序：先看 rangeDecoder 与 startsWithBom 的契约，再看 StreamDecoder 的两个字段，最后读 decode。
/**
 * Decoding that matches `new TextDecoder().decode(bytes)` of the whole input when the input arrives in pieces. Node's
 * streaming decoder with BOM handling can drop a U+FEFF that follows a chunk boundary, not only a leading byte-order
 * mark, so these decoders turn BOM handling off and drop a leading mark themselves.
 */

/** A streaming decoder for a byte range; callers that start at the beginning of a file skip a leading mark themselves. */
/** 创建保留 BOM 字符的 UTF-8 解码器；不读取文件。调用者负责文件开头的 BOM。
 * 例如连续 decode 两段不完整字节时，配合 stream: true 可等到字符收齐后再输出。
 * InstanceType<typeof TextDecoder> 表示 TextDecoder 构造器产生的实例类型，只参与类型检查。 */
export function rangeDecoder(): InstanceType<typeof TextDecoder> {
	// ignoreBOM: true 的含义是“不把 BOM 当作要自动剥掉的标记”，所以 U+FEFF 会保留在结果中。
	return new TextDecoder("utf-8", { ignoreBOM: true });
}

/** Whether decoding the whole input drops its first three bytes as a byte-order mark. */
/** 检查输入前三个字节是否是 UTF-8 BOM；不修改数组，短数组的缺失下标是 undefined，因此返回 false。
 * 例如 [0xef, 0xbb, 0xbf, 65] 返回 true；这里只比字节，不验证后续 UTF-8 是否有效。 */
export function startsWithBom(firstBytes: Uint8Array): boolean {
	// && 要求三个位置同时匹配；0x 前缀表示十六进制数值。
	return firstBytes[0] === 0xef && firstBytes[1] === 0xbb && firstBytes[2] === 0xbf;
}

/** Decodes one stream chunk by chunk exactly like decoding all of it at once. */
/**
 * 流式 UTF-8 解码器：任意分块方式的拼接结果都等于一次性解码整个字节流，并且只删除流开头的 BOM。
 * 它关闭 TextDecoder 的自动 BOM 处理以保留中途的 U+FEFF，再在第一次产生非空文本时手工删除开头的 U+FEFF。
 * 每个实例只对应一个字节流，状态包括底层解码器和“是否已经开始输出”；不要并发共享同一个实例。
 * 例：new StreamDecoder().decode(Uint8Array.of(0x41)) 返回 "A"。
 */
export class StreamDecoder {
	// # 是 JavaScript 私有字段；每个实例各有自己的解码状态，readonly 只阻止重新赋值这个引用。
	readonly #decoder = rangeDecoder();
	// 空输出可能只是字符尚未收齐，不能据此认定流的首字符已经处理过。
	#started = false;

	/** Text for `bytes`, holding back an incomplete character; without `bytes`, the end of the stream. */
	/** 有 bytes 时增量解码，无参数时冲刷末尾残留字节；返回本次可用文本，更新实例状态。
	 * 例如分两块收到 BOM 和 A，会只返回 A；中途的 BOM 字符仍保留。解码器默认把坏字节替换为 U+FFFD，不使用 fatal 模式抛错。 */
	decode(bytes?: Uint8Array): string {
		// 条件表达式（? :）：undefined 表示结束流，stream: true 表示后面还可能有字节。
		const text = bytes === undefined ? this.#decoder.decode() : this.#decoder.decode(bytes, { stream: true });
		// 已处理过首个非空输出就直接返回；本次为空也先返回，保留“还没开始”的状态。
		if (this.#started || text === "") return text;
		// 第一次真正输出字符时记住这个事实，之后不再删除 U+FEFF。
		this.#started = true;
		// U+FEFF encodes only as EF BB BF, so a leading U+FEFF is exactly a byte-order mark at the stream's start.
		// slice(1) 只去掉首个 UTF-16 码元；这里 BOM 恰好占一个码元，其余文本保持原样。
		return text.startsWith("\ufeff") ? text.slice(1) : text;
	}
}
