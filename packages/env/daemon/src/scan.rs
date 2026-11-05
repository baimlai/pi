//! Port of Durable's `LineScanner` (`env/line-scan.ts`): locates lines `[start_line, end_line)` of a file fed in order
//! and measures their decoded UTF-8 size as `new TextDecoder().decode(file)` would produce it.
// 输入是原始字节，行号从 0 开始；返回的偏移是原文件字节位置，计数却是解码后再用 UTF-8 表示的字节数。
//
// 文件导读（packages/env/daemon/src/scan.rs）
// 所属包/模块：packages/env 的 Rust daemon（二进制 pi-env）中的行扫描模块，移植自 Durable 的
// env/line-scan.ts（LineScanner）。
// 解决的问题与职责边界：文件按块流式送入时，定位 [start_line, end_line) 半开区间的原始字节边界，并统计该
// 区间与第一行“按整文件解码后”的 UTF-8 字节数。行只以 LF 分隔，CR 属于行内容；BOM 只在整个文件开头剥离。
// 它不缓存整份文件，不返回行文本，也不决定 readFile 的分块大小（由 main.rs 的 scan_lines 负责）。
// 上游入口：main.rs 的 scan_lines 用 sys::read_at 分块读取，然后 push 到 LineScanner，EOF 时 finish。
// 下游依赖：decode 模块的 decode_into/range_decoder/starts_with_bom，以及 encoding_rs::Decoder 状态。
// 能力清单（按导出项）：
//   - NEWLINE（私有常量）：唯一分行字节 0x0A。
//   - LineScanner：保存目标区间、原始位置、行号、边界、两个解码器与 BOM 状态。
//   - LineScanner::new：创建扫描器；start_line==0 时立即开启选区。
//   - LineScanner::push：按顺序喂入一块字节，必要时先凑齐头三字节判断 BOM。
//   - LineScanner::finish：消费扫描器，补齐 EOF 边界与残缺 UTF-8，返回 LineScan JSON。
//   - 私有辅助：is_last_line、release_head、process、begin、end_first_line、end_selection、feed。
//   - tests：跨 1..5 字节块宽验证 BOM、无效序列、空行、偏移与越界起始行。
// 组合关系/典型调用顺序：new(start, end) -> 多次 push(chunk) -> finish() -> JSON
// {newlines,start,end,firstLineEnd,lastLineStart,selectedBytes,firstLineBytes}。
// 示例（真实签名，来自 main.rs 的 scan_lines）：let mut scanner = scan::LineScanner::new(1, Some(3));
// scanner.push(b"a\nb\n"); scanner.finish() 返回的 start/end 是原始偏移，selectedBytes 是解码后字节数。
// 建议阅读顺序：先看字段与 new，再看 push/release_head 的 BOM 处理，然后 process 的换行与边界推进，最后看
// finish 的 EOF 补齐与测试。

use crate::decode::{decode_into, range_decoder, starts_with_bom};
use encoding_rs::Decoder;
use serde_json::{Value, json};

// 只把 LF 当分行符；CR 本身仍属于该行内容。
const NEWLINE: u8 = 0x0a;

// Option<T> 表示“尚未找到/不设上界”等缺省状态；Decoder 会保存跨块的不完整 UTF-8 序列。
pub struct LineScanner {
    // 目标半开区间 [start_line,end_line)，None 表示一直到文件尾。
    start_line: u64,
    end_line: Option<u64>,
    // 已处理原始字节数、已遇 LF 数、当前行的原始起点。
    position: u64,
    newlines: u64,
    line_start: u64,
    // 选区与第一行/末行的原始字节边界；未遇边界时为 None。
    start: Option<u64>,
    end: Option<u64>,
    first_line_end: Option<u64>,
    last_line_start: Option<u64>,
    // 两个计数器跟踪解码后的 UTF-8 大小；不是字符数，也不是原始输入长度。
    selected_bytes: u64,
    first_line_bytes: u64,
    // 第一行和整个选区单独解码，以便在各自结束时补出不完整序列的替换字符。
    selection: Option<Decoder>,
    first_line: Option<Decoder>,
    // 暂存头三个字节以识别跨块 BOM；释放后设为 None，后续块直接处理。
    head: Option<Vec<u8>>,
    bom: bool,
}

impl LineScanner {
    /// `end_line`, when given, must be greater than `start_line`.
    // 创建空扫描器，无 I/O；例如 new(1,Some(3)) 选第 2、3 行，尚不消耗输入。
    // 调用方应保证 end_line>start_line，这个约定未在构造函数中运行时校验。
    pub fn new(start_line: u64, end_line: Option<u64>) -> LineScanner {
        // 字段简写 start_line 等价于 start_line:start_line；其余状态都从文件开头初始化。
        let mut scanner = LineScanner {
            start_line,
            end_line,
            position: 0,
            newlines: 0,
            line_start: 0,
            start: None,
            end: None,
            first_line_end: None,
            last_line_start: None,
            selected_bytes: 0,
            first_line_bytes: 0,
            selection: None,
            first_line: None,
            head: Some(Vec::with_capacity(3)),
            bom: false,
        };
        // 第零行从偏移 0 开始，不用等 LF；后续 feed 才会跳过开头 BOM。
        if start_line == 0 {
            scanner.begin(0);
        }
        scanner
    }

    // 判断 line 是否是有界选区的最后一行，不修改状态；例如 end=3 时 line=2 为真。
    fn is_last_line(&self, line: u64) -> bool {
        // is_some_and 只对 Some 执行闭包；None 的无上界区间总返回 false。
        self.end_line.is_some_and(|end| line + 1 == end)
    }

    // 按文件顺序喂一块字节，更新位置/边界/解码计数，没有返回值和磁盘副作用。
    // 例如 BOM 分在三个单字节块里，也要等够三个字节才决定如何计数。
    pub fn push(&mut self, mut chunk: &[u8]) {
        // &mut 借用允许填充头缓存；mut chunk 只会移动当前切片的起点，不改输入字节。
        if let Some(head) = &mut self.head {
            // 只取凑满 3 字节所需部分，避免吞掉本块剩余内容。
            let take = (3 - head.len()).min(chunk.len());
            head.extend_from_slice(&chunk[..take]);
            // 输入头仍不足三个字节时留到下一块；finish 会处理最终不足三个的文件。
            if head.len() < 3 {
                return;
            }
            // 先去掉已进缓存的前缀，再释放缓存、处理当前块余部，顺序不会重复。
            chunk = &chunk[take..];
            self.release_head();
        }
        self.process(chunk);
    }

    // 取走头缓存并仅一次识别 BOM，然后把缓存当正常输入处理；例如短文件在 finish 走这里。
    fn release_head(&mut self) {
        // take 把 Option 留为 None；unwrap_or_default 在无缓存时给空 Vec。
        let head = self.head.take().unwrap_or_default();
        // starts_with_bom 只认 UTF-8 的 EF BB BF，不会切换到 UTF-16。
        self.bom = starts_with_bom(&head);
        self.process(&head);
    }

    // 扫描一块内所有 LF，分段送解码器，更新跨块的绝对偏移；不保存整份文件。
    // 例如 a\nb 的 LF 位置为 1，下一行起点为 2；LF 仅在选区内部两行之间计入选区。
    fn process(&mut self, chunk: &[u8]) {
        // base 固定本块起点；from 是尚未送入的片段起点，index 是找 LF 的搜索起点。
        let base = self.position;
        let mut from = 0;
        let mut index = 0;
        // position 返回子切片内位置，必须加 index 才得到块内 LF 索引。
        while let Some(found) = chunk[index..].iter().position(|byte| *byte == NEWLINE) {
            let newline = index + found;
            // The newline ends line `self.newlines`; it belongs to the selection between selected lines only.
            // 先送 LF 之前的字节，再视边界关闭解码器，这样末行尾 LF 被排除。
            self.feed(chunk, base, from, newline);
            let line = self.newlines;
            // as u64 把内存索引转为文件偏移的整数类型。
            let position = base + newline as u64;
            // 起始行的 LF 同时结束“第一行”计数。
            if line == self.start_line {
                self.end_first_line(position);
            }
            // 若当前是目标最后行，先关闭整个选区，后面那枚 LF 不再被它接收。
            if self.is_last_line(line) {
                self.end_selection(position);
            }
            // 未结束的选区仍接收 LF；first_line 已结束所以不会多算其末尾 LF。
            self.feed(chunk, base, newline, newline + 1);
            from = newline + 1;
            // 更新下一行号和起点；选择从下一行开始时，此处才开启解码器。
            self.newlines += 1;
            self.line_start = position + 1;
            if self.newlines == self.start_line {
                self.begin(self.line_start);
            }
            // 记录有界选区末行起点，即使该行为空也保留这个边界。
            if self.is_last_line(self.newlines) {
                self.last_line_start = Some(self.line_start);
            }
            // 跳过已找到的 LF，避免下一次又找到同一个字节。
            index = newline + 1;
        }
        // 剩余无 LF 尾段仍需解码，最后才累计整个原始块长度。
        self.feed(chunk, base, from, chunk.len());
        self.position += chunk.len() as u64;
    }

    // 消耗扫描器并生成 JSON，补齐 EOF 处的边界与不完整 UTF-8；之后不能继续 push 同一实例。
    // 例如起始行超出文件，start/end 都等于原文件长度，选区计数为 0。
    pub fn finish(mut self) -> Value {
        // 很短的文件可能一直留在 head 中；现在也必须纳入 position 和换行统计。
        if self.head.is_some() {
            self.release_head();
        }
        // 此时 position 是全部原始字节数，可作为未遇到边界时的 EOF。
        let size = self.position;
        // let-else 返回“起始行未到达”的独立结果，不制造解码内容。
        let Some(start) = self.start else {
            return json!({
                "newlines": self.newlines, "start": size, "end": size, "firstLineEnd": size,
                "lastLineStart": size, "selectedBytes": 0, "firstLineBytes": 0,
            });
        };
        // 没有尾 LF 的行也需要 flush 解码器，输出末尾残缺序列的 U+FFFD。
        if self.first_line_end.is_none() {
            self.end_first_line(size);
        }
        // 未到 end_line 或未设上界时，以 EOF 结束选区。
        if self.end.is_none() {
            self.end_selection(size);
        }
        // start 等是原始偏移；selectedBytes/firstLineBytes 是解码后字节大小，两类数字不可混用。
        json!({
            "newlines": self.newlines,
            "start": start,
            "end": self.end.unwrap_or(size),
            "firstLineEnd": self.first_line_end.unwrap_or(size),
            // A selection that reaches past the last line ends with the last line.
            "lastLineStart": self.last_line_start.unwrap_or(self.line_start),
            "selectedBytes": self.selected_bytes,
            "firstLineBytes": self.first_line_bytes,
        })
    }

    // 标记选区起点并开启两个不剥 BOM 的范围解码器；例如第二行开头的 U+FEFF 必须保留。
    fn begin(&mut self, start: u64) {
        self.start = Some(start);
        // 只选一行时起始行也就是末行，末行起点立即确定。
        if self.is_last_line(self.start_line) {
            self.last_line_start = Some(start);
        }
        // 两个 Decoder 独立持有流状态，后续在不同边界结束。
        self.selection = Some(range_decoder());
        self.first_line = Some(range_decoder());
    }

    // 记录第一行结束偏移并 flush 其解码器；例如残缺 E2 82 在此补成一个替换字符。
    fn end_first_line(&mut self, position: u64) {
        self.first_line_end = Some(position);
        // take 同时移走解码器并设 None，确保后续片段不再计入第一行。
        if let Some(mut decoder) = self.first_line.take() {
            self.first_line_bytes += decode_into(&mut decoder, &[], true).len() as u64;
        }
    }

    // 记录选区结束并 flush 最后残留字节，副作用仅为扫描状态；后续 feed 不再累计选区。
    fn end_selection(&mut self, position: u64) {
        self.end = Some(position);
        // true 表示输入已结束；空字节也可能让 Decoder 产出残缺序列替换字符。
        if let Some(mut decoder) = self.selection.take() {
            self.selected_bytes += decode_into(&mut decoder, &[], true).len() as u64;
        }
    }

    // 将 chunk 的半开区间 [from,to) 喂给仍开启的解码器，累计输出 String 的 UTF-8 长度。
    // 若文件开头确有 BOM，就只跳过其最前 3 个原始字节；后面相同字节不会被剥除。
    fn feed(&mut self, chunk: &[u8], base: u64, mut from: usize, to: usize) {
        // Decoding the whole file drops a leading byte-order mark.
        // base+from 是片段原始绝对位置；min 防止跳到当前片段范围以外。
        if self.bom && base + (from as u64) < 3 {
            from = to.min((3 - base) as usize);
        }
        // 空范围无需解码；最终 flush 由 end_* 负责，而非这里。
        if to <= from {
            return;
        }
        // 切片借用原字节，没有复制；len() 统计 Rust String 的字节数，不是 Unicode 字符数。
        let bytes = &chunk[from..to];
        // false 允许 Decoder 暂存跨片段的 UTF-8 序列，当前只加已经产出的部分。
        if let Some(decoder) = &mut self.selection {
            self.selected_bytes += decode_into(decoder, bytes, false).len() as u64;
        }
        // 第一行关闭后为 None，同一片段不会继续给它计数。
        if let Some(decoder) = &mut self.first_line {
            self.first_line_bytes += decode_into(decoder, bytes, false).len() as u64;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 测试助手：把内存文件按指定块宽依次喂入并 finish，无磁盘操作；chunk=0 也按 1 处理。
    fn scan(file: &[u8], start: u64, end: Option<u64>, chunk: usize) -> Value {
        let mut scanner = LineScanner::new(start, end);
        // chunks 返回借用片段；顺序 push 测试状态是否能跨块连续。
        for piece in file.chunks(chunk.max(1)) {
            scanner.push(piece);
        }
        scanner.finish()
    }

    // 用同一固定字节串和 1..5 的块宽验证 BOM、无效序列、空行及偏移；不是随机或所有编码测试。
    #[test]
    fn locates_and_measures_lines_like_whole_file_decoding() {
        // BOM, "a", invalid sequence, empty line, a later U+FEFF, and no final newline.
        // 字节夹具保留前置 BOM、一个后置 U+FEFF、残缺序列与末尾 é，没有末尾 LF。
        let file = [
            0xef, 0xbb, 0xbf, 0x61, 0x0a, 0xe2, 0x82, 0x0a, 0x0a, 0xef, 0xbb, 0xbf, 0x62, 0x0a,
            0xc3, 0xa9,
        ];
        // Rust 1..6 不包含 6；每轮重建扫描器，避免前轮状态影响。
        for chunk in 1..6 {
            // 全选证明 LF 总数、解码后总字节和第一行字节，原始 BOM 的 3 字节不计输出。
            let all = scan(&file, 0, None, chunk);
            assert_eq!(all["newlines"], 4);
            // "a\n\u{fffd}\n\n\u{feff}b\né" is 1+1+3+1+1+3+1+1+2 = 14 bytes.
            assert_eq!(all["selectedBytes"], 14);
            assert_eq!(all["firstLineBytes"], 1);
            // 中间两行起止原偏移为 5/8，选区内 LF 计入、末行尾 LF 排除。
            let middle = scan(&file, 1, Some(3), chunk);
            assert_eq!(
                (middle["start"].as_u64(), middle["end"].as_u64()),
                (Some(5), Some(8))
            );
            assert_eq!(middle["selectedBytes"], 4);
            assert_eq!(middle["lastLineStart"], 8);
            // 起始行不存在时偏移应落在原文件 EOF=16，而不是输出字符串的 14。
            let past = scan(&file, 9, None, chunk);
            assert_eq!(past["start"], 16);
        }
    }
}
