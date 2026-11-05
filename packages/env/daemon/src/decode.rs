//! WHATWG UTF-8 decoding that matches Node's `new TextDecoder().decode(bytes)` of a whole input when the input arrives
//! in pieces (Durable `env/decode.ts`): invalid sequences become U+FFFD by the maximal-subpart rule, and only a
//! byte-order mark at the very start is dropped.
//
// 文件导读（packages/env/daemon/src/decode.rs）
// 所属包/模块：packages/env 的 Rust daemon（二进制 pi-env）中的 UTF-8 解码模块，等价于 Durable 的
// env/decode.ts（Node 的 new TextDecoder().decode(bytes)）。
// 解决的问题与职责边界：同一段输入分多块到达时，仍要得到“一次性解码整段输入”的结果：非法字节按
// maximal-subpart 规则只产生一个 U+FFFD，只有整个流最开头的 UTF-8 BOM 被丢弃，跨块的半个字符要暂存。
// 本模块只做字节到 String 的转换，不读文件、不决定行边界，也不识别 UTF-16。
// 上游入口：exec.rs 为 stdout/stderr 各建一个 StreamDecoder；scan.rs 为选区和第一行建 range_decoder。
// 下游依赖：encoding_rs crate 的 Decoder/UTF_8 实现（外部 API，见 Cargo.toml 的精确版本）。
// 能力清单（按导出项）：
//   - StreamDecoder：流首解码器；new 创建状态，decode(bytes, last) 解码一块，last=true 表示流结束。
//   - range_decoder：用于不从输入开头开始的区间，完全不处理 BOM（保留开头的 U+FEFF）。
//   - decode_into：用调用方提供的 Decoder 解码一块，更新状态并返回本次产生的文本。
//   - starts_with_bom：只检查 EF BB BF 前缀，不修改任何状态。
//   - tests：验证跨块 BOM、非流首 U+FEFF、无效序列与末尾残缺序列。
// 组合关系/典型调用顺序：每个流创建一个 StreamDecoder，逐块 decode(..., false)，最后 decode(&[], true) 冲刷；
// scan.rs 则对每个选区创建 range_decoder，再用 decode_into 累计解码后的字节数。
// 示例（真实签名的用法示意，不是固定输入）：let mut decoder = StreamDecoder::new();
// decoder.decode(&[0xE2, 0x82], false) 返回空串，随后 decoder.decode(&[0xAC], true) 返回 "€"。
// 建议阅读顺序：先看 StreamDecoder 的字段与 new，再看 decode_into 的容量/冲刷逻辑，最后用测试确认边界规则。

use encoding_rs::{Decoder, UTF_8};

// Rust 的 struct 类似带字段的对象类型；decoder 保存尚未凑齐的 UTF-8 字节，因此同一流必须复用同一实例。
/// Decodes one stream chunk by chunk, dropping a leading byte-order mark.
pub struct StreamDecoder {
    decoder: Decoder,
}

impl StreamDecoder {
    // 创建流首解码器；无输入，返回独立状态，不读文件。例：分两次收到 EF BB / BF 61，最终只得到 a。
    pub fn new() -> StreamDecoder {
        // Removes a UTF-8 BOM only; plain `new_decoder()` would also sniff UTF-16 BOMs and switch encodings.
        StreamDecoder {
            // 仅识别 UTF-8 的起始 BOM；不根据 FF FE 切换到 UTF-16。
            decoder: UTF_8.new_decoder_with_bom_removal(),
        }
    }

    /// Text for `bytes`, holding back an incomplete character; with `last`, the end of the stream.
    // 借用输入字节并更新 self 的解码状态，返回本块已完整的文字；last=true 会把残缺序列替换为 U+FFFD。
    // 例：先 decode([E2,82], false) 暂无文字，再传 AC 得到 €；这是用法示意，并非函数内固定输入。
    pub fn decode(&mut self, bytes: &[u8], last: bool) -> String {
        // &mut 是独占可变借用；输出 String 自己拥有内存，不借用输入 bytes。
        decode_into(&mut self.decoder, bytes, last)
    }
}

/// A decoder for a byte range that does not start at the beginning of its input: no BOM handling at all.
// 创建非流首区间的解码器；无 I/O，返回 encoding_rs 的状态。例：区间开头 EF BB BF 必须保留为 U+FEFF。
pub fn range_decoder() -> Decoder {
    // 不丢 BOM，也不检测其他编码；调用方负责区间边界。
    UTF_8.new_decoder_without_bom_handling()
}

// 用给定状态解码一块并返回文字；更新 decoder，不修改 bytes。预留最坏输出空间，末块冲刷残留。
// 例：无效字节 FF 会生成替换字符；本函数不返回“无效 UTF-8”错误。
pub fn decode_into(decoder: &mut Decoder, bytes: &[u8], last: bool) -> String {
    // 最大容量考虑解码器残留；Option::None 时使用宽松后备值。
    let capacity = decoder
        .max_utf8_buffer_length(bytes.len())
        .unwrap_or(bytes.len() * 3 + 16);
    // capacity 只预留内存，字符串长度仍是零。
    let mut text = String::with_capacity(capacity);
    // 元组解构拿出读取数；下划线前缀表示此处有意不使用结果状态和是否发生替换。
    let (_result, read, _replaced) = decoder.decode_to_string(bytes, &mut text, last);
    // 仅 debug 构建检查容量足够消耗整块；这是内部不变量断言，不是面向客户端的错误校验。
    debug_assert_eq!(read, bytes.len());
    // Rust 块末不加分号的表达式就是返回值。
    text
}

/// Whether decoding the whole input drops its first three bytes as a byte-order mark.
// 只检查字节前缀，返回 bool，无状态变化；例：EF BB BF 61 为 true，只有 EF BB 为 false。
pub fn starts_with_bom(bytes: &[u8]) -> bool {
    // &[...] 创建固定数组的共享借用；这里不尝试解码其余数据。
    bytes.starts_with(&[0xef, 0xbb, 0xbf])
}

#[cfg(test)]
mod tests {
    use super::*;

    // 逐字节送入残缺序列、非起点 BOM 和 a；断言只替换残缺序列，保留中途 U+FEFF，无 I/O。
    #[test]
    fn keeps_a_feff_that_does_not_start_the_stream() {
        // 每个测试独立创建状态，避免其他测试留下的解码残留。
        let mut decoder = StreamDecoder::new();
        // E2 82 缺第三字节，后来的 EF 开始新的 BOM 字符。
        let bytes = [0xe2, 0x82, 0xef, 0xbb, 0xbf, 0x61];
        // iter 借用数组；闭包每次借用单字节，再把每块 String 拼成一个 String。
        let text: String = bytes
            .iter()
            .map(|byte| decoder.decode(&[*byte], false))
            .collect::<String>()
            // 最后空块标记输入结束，取出仍然缓存的残留。
            + &decoder.decode(&[], true);
        // 实际验证分块后仍遵守 maximal-subpart 替换规则和只剥离流首 BOM 的约定。
        assert_eq!(text, "\u{fffd}\u{feff}a");
    }

    // 验证跨块 UTF-8 BOM 被丢弃，而 UTF-16 标记不会触发编码切换；仅使用内存字节。
    #[test]
    fn drops_only_a_leading_mark_and_never_sniffs_utf16() {
        let mut decoder = StreamDecoder::new();
        // 前两字节不足以判断完整 BOM，第二块补齐后应得到 a。
        assert_eq!(
            decoder.decode(&[0xef, 0xbb], false) + &decoder.decode(&[0xbf, 0x61], true),
            "a"
        );
        // 重置到新流；FF FE 不是合法 UTF-8，因此分别替换，41 00 仍按 UTF-8 解码。
        let mut decoder = StreamDecoder::new();
        assert_eq!(
            decoder.decode(&[0xff, 0xfe, 0x41, 0x00], true),
            "\u{fffd}\u{fffd}A\u{0}"
        );
    }

    // 验证残缺的三字节序列整体只产生一个替换字符；分别测试被 ASCII 打断和末尾结束。
    #[test]
    fn replaces_an_incomplete_sequence_once() {
        let mut decoder = StreamDecoder::new();
        // 41 不能充当续字节，所以前两字节替换一次，A 继续正常解码。
        assert_eq!(decoder.decode(&[0xe2, 0x82, 0x41], true), "\u{fffd}A");
        let mut decoder = StreamDecoder::new();
        // last=true 在流结束时冲刷 E2 82；不会永久保留等待更多字节。
        assert_eq!(decoder.decode(&[0xe2, 0x82], true), "\u{fffd}");
    }
}
