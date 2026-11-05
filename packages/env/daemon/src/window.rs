//! Durable's output window (`ShellExecOptions.window`, `ShellOutputInfo.skipped`): undelivered command output is held
//! and coalesced; text followed by more than the window (by a byte or a line) can never be in the caller's tail and is
//! replaced by counts. Delivery follows the caller's commit pace, and waits while an earlier frame is still unsent.
//!
//! 所属模块：packages/env/daemon/src/window.rs，daemon 的输出窗口（output window）实现。
//! 上游入口：exec.rs 的 ExecRequest::from_json 调用 Window::from_json；命令主循环调用
//! Pending::new / push / is_empty / next_send / take，再把 Event 交给 output_frame 入队发送。
//! 下游依赖：serde_json（解析 window 配置、构造 skipped JSON）和 std::time。
//!
//! 职责边界：本文件只负责命令输出在 daemon 内存中的合并、裁剪和统计，不读管道、不写 EVENT 帧、
//! 不做 UTF-8 解码，也不启动或终止进程；这些分别由 decode.rs、exec.rs、output.rs 完成。
//!
//! 能力清单（按导出项）：
//! - Window：线上 window 配置的类型化形式（字节窗口、行窗口、最小间隔、每秒字节数）。
//! - Window::from_json：把不可信的 JSON 配置解析成 Window；缺字段或类型不对时返回 None。
//! - Event：一次可发送的输出事件（流名、文本、可选的 skipped 统计）。
//! - Pending：命令周期内暂存未发送输出，裁剪不可能出现在尾部的前缀，并按节奏决定发送时间。
//! - Pending::new / is_empty / next_send / push / take：创建、查询、追加和取走输出。
//!
//! 典型调用（示例，真实签名见各函数）：
//!     let window = Window::from_json(&json["window"]).unwrap();
//!     let mut pending = Pending::new(window);
//!     pending.push("stdout", "hello\n".to_string());
//!     if pending.next_send() <= Instant::now() {
//!         for event in pending.take() {
//!             // exec.rs 把 event 转成 EVENT 帧
//!         }
//!     }
//!
//! 建议阅读顺序：先看 Window 和 from_json 的字段含义，再看 Event/Skipped 的线上格式；
//! 然后按 Pending 的字段、new、push、proves/trim、take 阅读；最后看测试如何验证计数守恒。

use serde_json::{Value, json};
use std::time::{Duration, Instant};

// 输出窗口的配置，对应线上 `window { maxBytes, maxLines, minIntervalMs, bytesPerSecond }`。
// Clone + Copy 让配置按值传递：exec.rs 可以把 Window 复制进 Pending，不必共享引用或加锁。
// 四个字段不是“最多保留这么多”，而是“被丢弃的前缀必须能被证明不可能出现在调用方要求的尾部”：
// 剩余文本在字节数或行数上仍超过窗口时，早先被裁掉的内容才安全地不在尾部。
#[derive(Clone, Copy)]
pub struct Window {
    // 调用方允许保留的最大字节数；trim 会至少保留 max_bytes + 1 字节来证明排除。
    pub max_bytes: usize,
    // 调用方允许保留的最大换行数；trim 会至少保留 max_lines + 1 个换行。
    pub max_lines: usize,
    // 两次发送之间的最小时间间隔，由 minIntervalMs 换算；ZERO 表示不额外等待。
    pub min_interval: Duration,
    // 发送限速：每次发送最多按 max_bytes 计费，再除以该值得到最小间隔；下限 1.0 防止除零。
    pub bytes_per_second: f64,
}

// Window 的构造入口目前只有 from_json；线上字段名与 Rust 字段名的映射都集中在这里。
impl Window {
    // 从线上 JSON 解析窗口配置；参数类型是 serde_json::Value，因为 window 字段来自不可信输入。
    // 返回 Some(Window) 表示四个字段都存在且数值类型正确；任一缺失或类型错误返回 None，
    // 调用方 exec.rs 把 None 当作“没有窗口”，而不是请求错误。
    // 数值在这里做范围收敛：minIntervalMs 的负数或 NaN 变 0，bytesPerSecond 最小为 1。
    // 例：{"maxBytes":10,"maxLines":2,"minIntervalMs":0,"bytesPerSecond":1000}
    // 得到 max_bytes=10、min_interval=0s、bytes_per_second=1000.0。
    pub fn from_json(json: &Value) -> Option<Window> {
        // as_object 返回 Option：不是 JSON 对象就直接得 None；? 在 Option 上提前返回。
        let object = json.as_object()?;
        // 每个字段都用 ? 取出；get/as_u64/as_f64 是对线上输入的运行时校验，不是多余的类型检查。
        Some(Window {
            // as_u64 保证非负整数；再 as usize 转成本机宽度，64 位平台上不会截断。
            max_bytes: object.get("maxBytes")?.as_u64()? as usize,
            // 行窗口同样只接受非负整数；行数按 '\n' 字节计数，与 Node 的换行口径一致。
            max_lines: object.get("maxLines")?.as_u64()? as usize,
            // minIntervalMs 是毫秒浮点数：max(0.0) 把负值和 NaN 夹到 0，再除以 1000 转成 Duration；
            // 这一步同时避免 from_secs_f64 对非法值 panic。
            min_interval: Duration::from_secs_f64(
                object.get("minIntervalMs")?.as_f64()?.max(0.0) / 1000.0,
            ),
            // max(1.0) 既避免 0 导致除零，也避免负速率；上限不设，调用方自行负责。
            bytes_per_second: object.get("bytesPerSecond")?.as_f64()?.max(1.0),
        })
    }
}

// 尚未发送、已被裁剪掉的前缀统计，最终变成线上 `skipped` 对象；Default 给出全零初值。
// 它只记录丢掉了多少，不保留被丢弃的文本，因此内存占用恒定。
#[derive(Default)]
struct Skipped {
    // 已丢弃的原始输出字节数（UTF-8 编码后的长度）。
    bytes: u64,
    // 已丢弃文本中的 '\n' 个数。
    newlines: u64,
    // 最后一次丢弃的前缀是否以换行结束，帮助调用方判断行边界。
    ends_with_newline: bool,
}

// 一条待发送的输出事件；exec.rs 直接把三个字段塞进 EVENT 帧的 metadata 和 payload。
// skipped 为 None 表示这段文本之前没有丢弃内容；Some(Value) 时携带 bytes/newlines/endsWithNewline。
/// One output event: its stream, text, and the output omitted right before it.
pub struct Event {
    // 协议流名："stdout" 或 "stderr"；skipped 合并多条段后取最后一段的流名。
    pub stream: &'static str,
    // 已解码的 UTF-8 文本，作为帧 payload 发送。
    pub text: String,
    // 之前被窗口裁掉的前缀统计；只有发生裁剪时才存在，格式由 take 构造。
    pub skipped: Option<Value>,
}

// 一条命令周期内“已产生但尚未发送”的输出状态机；exec.rs 每轮循环检查 next_send 与 unsent。
// 设计目标：内存只保留调用方尾部可能需要的部分，并让发送节奏与调用方消费速度匹配。
// 例：窗口 maxBytes=10、maxLines=2；连续 push 500 行后，最早的行被计数进 skipped，
// take() 返回一条带 skipped 的事件，事件文本仍略多于窗口，保证调用方尾部完整。
pub struct Pending {
    // 配置副本；push/trim/take 都按它判断窗口大小和发送节奏。
    window: Window,
    // 按到达顺序保存 (流名, 文本)；相邻同流合并，不同流保持分段，避免把 stderr 误标成 stdout。
    /// Undelivered text in arrival order, by stream.
    segments: Vec<(&'static str, String)>,
    // segments 的总字节数，增量维护，避免每次裁剪都重新遍历。
    bytes: usize,
    // segments 的总换行数，与 bytes 一样是增量维护的缓存。
    newlines: usize,
    // 已裁剪但尚未随任何事件发送的累计统计；take 时取走并清空。
    skipped: Option<Skipped>,
    // 下一次允许发送的时间点；由上次 take 的发送量和 bytes_per_second 决定。
    next_send: Instant,
}

// 统计 UTF-8 文本中的换行字节数；只数 b'\n'，不把 "\r\n" 算成两行，与 Node 的行数口径一致。
// 遍历 bytes() 而不是 chars()：换行是单字节 ASCII，按字节扫描更快，也不会漏掉多字节字符间的换行。
fn newline_count(text: &str) -> usize {
    text.bytes().filter(|byte| *byte == b'\n').count()
}

impl Pending {
    // 创建一条命令的输出窗口状态；参数 window 是已经解析好的配置。
    // 返回的 Pending 为空：segments 无内容、计数为 0、skipped 为 None，
    // next_send 设为当前时刻，因此第一次 take 不受限速等待。
    // 例：Pending::new(window).is_empty() == true，且 next_send() 不晚于 Instant::now()。
    pub fn new(window: Window) -> Pending {
        Pending {
            window,
            segments: Vec::new(),
            bytes: 0,
            newlines: 0,
            skipped: None,
            next_send: Instant::now(),
        }
    }

    // 是否还有未发送的文本；只看 segments，因为 skipped 只会附着在文本事件上发送。
    // exec.rs 用它决定是否调用 take；空窗口不会产生空事件。
    pub fn is_empty(&self) -> bool {
        self.segments.is_empty()
    }

    // 返回下一次允许发送的时刻；exec.rs 把它与 now 比较，并据此缩短等待超时。
    // 这个值只在 take 后推进，push 不会改变它，所以新输出不会打断已经定下的发送节奏。
    /// When the next delivery may happen.
    pub fn next_send(&self) -> Instant {
        self.next_send
    }

    // 追加一段已解码输出；stream 是协议流名，text 是本次解码得到的文本。
    // 空文本直接忽略，避免产生空 segment、空事件和没有意义的节奏更新。
    // 副作用：更新 bytes/newlines 缓存、合并相邻同流文本；累计到约 4 个窗口时调用 trim 裁剪前缀。
    // 例：push("stdout", "a\n") 后 bytes=2、newlines=1；再 push("stdout", "b\n")
    // 会合并成 "a\nb\n"，而不是两个 segment。
    pub fn push(&mut self, stream: &'static str, text: String) {
        // 空块在协议层没有意义；直接返回也保证 segment 永远非空。
        if text.is_empty() {
            return;
        }
        // len() 返回 UTF-8 字节长度，不是字符数；正好符合 maxBytes 的字节口径。
        self.bytes += text.len();
        // newline_count 与 bytes 同步累加，保持两个缓存始终等于 segments 的实际总量。
        self.newlines += newline_count(&text);
        // last_mut 取最后一段的可变引用；guard 同时检查流名相同，决定能否合并。
        match self.segments.last_mut() {
            // 同一流且相邻：直接追加到已有 String，避免每个数据块都新建 segment。
            Some((last, existing)) if *last == stream => existing.push_str(&text),
            // 流切换或还没有段：新开一段以保持到达顺序；take 时会按段分别发送。
            _ => self.segments.push((stream, text)),
        }
        // Trimming costs a pass over the held text; do it once a few windows have accumulated.
        // 裁剪要遍历当前持有的全部文本，不能每个数据块都做；先让未发送量积累到约 4 个窗口。
        // 4 是经验值：既把内存限制在约 4 个窗口，又把裁剪成本摊销到多次 push 上。
        // 用严格大于；max_bytes + 1 避免 maxBytes=0 时阈值为 0 而每次都裁剪。
        // 字节或行任一超过阈值就裁剪，因为两者都是窗口维度。
        if self.bytes > 4 * (self.window.max_bytes + 1)
            || self.newlines > 4 * (self.window.max_lines + 1)
        {
            self.trim();
        }
    }

    /// Whether the text after a cut still proves the cut text is outside the window.
    // 判断“去掉 bytes/newlines 之后，剩余文本是否仍能证明被去掉的部分不在窗口内”。
    // 条件：剩余字节数 > max_bytes 或剩余行数 > max_lines。
    // 只要任一维度仍超过窗口，调用方要求的尾部就不可能包含被去掉的整个前缀，裁剪是安全的。
    // 两个维度用“或”：窗口同时限制字节和行，任一超限都说明尾部已被更晚的内容占满。
    // 例：maxBytes=10、maxLines=2，剩余 11 字节 0 换行 -> true；剩余 5 字节 3 换行 -> true。
    fn proves(&self, bytes: usize, newlines: usize) -> bool {
        bytes > self.window.max_bytes || newlines > self.window.max_lines
    }

    /// Replace the longest prefix whose remainder still proves exclusion by counts.
    // 从暂存文本中裁掉“可证明不在调用方尾部”的最长前缀，并把裁掉的数量累计进 skipped。
    // 返回 ()；副作用是修改 segments/bytes/newlines/skipped，并可能删除空段。
    // 主流程：先整段删除，再在第一个剩余段内按字节和行两个约束取更靠后的切点，
    // 最后把切掉的文本计入 skipped；切点必须落在 UTF-8 字符边界上。
    // 例：窗口 10 字节/2 行，持有 "aaaa\nbbbb\ncccc\n" 时前面整段可删；
    // 最终仍保留比 10 字节或 2 行更多的内容，保证 take 的尾部完整。
    fn trim(&mut self) {
        // removed 收集本次裁掉的全部文本，函数末尾一次性计入 skipped。
        let mut removed = String::new();
        // Whole segments first.
        // 只要还剩不止一段就尝试整段删除；保留最后一段作为尾部候选，避免切点跨段计算。
        while self.segments.len() > 1 {
            // 先记下第一段的长度和换行数；块作用域让不可变借用 first 尽快结束。
            let (bytes, newlines) = {
                let first = &self.segments[0].1;
                (first.len(), newline_count(first))
            };
            // 删掉第一段后剩余量不再能证明排除，说明第一段可能仍在尾部；停止整段删除，改在段内切。
            if !self.proves(self.bytes - bytes, self.newlines - newlines) {
                break;
            }
            // Vec::remove(0) 会把后面的元素前移，成本 O(段数)；段数通常很少且裁剪不频繁。
            let (_, text) = self.segments.remove(0);
            self.bytes -= bytes;
            self.newlines -= newlines;
            // 被删段的文本只用于统计 skipped，不会再发送。
            removed.push_str(&text);
        }
        // Then a prefix of the first remaining segment, at a character boundary.
        // rest_* 是“除第一段外”的总量；下面要在第一段内部切，使整体仍超过窗口。
        let rest_bytes = self.bytes - self.segments[0].1.len();
        let rest_newlines = self.newlines - newline_count(&self.segments[0].1);
        let first = &self.segments[0].1;
        let mut cut = 0;
        // By bytes: keep more than `max_bytes` overall.
        // 为了让剩余字节数超过窗口，第一段至少保留 max_bytes+1-rest_bytes 字节；saturating 防止下溢。
        let keep_bytes = (self.window.max_bytes + 1).saturating_sub(rest_bytes);
        // 只有第一段确实需要切掉前缀时才计算切点。
        if first.len() > keep_bytes {
            let mut index = first.len() - keep_bytes;
            // String 的索引必须落在 UTF-8 字符边界；从目标位置向前退，宁可少切也不产生非法 UTF-8。
            while index > 0 && !first.is_char_boundary(index) {
                index -= 1;
            }
            // 字节约束给出的切点；后面还可能被行约束推得更靠后。
            cut = cut.max(index);
        }
        // By lines: keep more than `max_lines` newlines overall, starting at a newline of this segment.
        // 行约束同理：剩余换行数要超过 max_lines，第一段至少保留 max_lines+1-rest_newlines 个换行。
        let keep_newlines = (self.window.max_lines + 1).saturating_sub(rest_newlines);
        // 若剩余部分已超过行窗口（keep_newlines=0），走 else 把第一段整个删掉。
        if keep_newlines > 0 {
            // 收集第一段中所有换行的字节下标；临时 Vec 只在裁剪时分配。
            let positions: Vec<usize> = first
                .bytes()
                .enumerate()
                .filter(|(_, byte)| *byte == b'\n')
                .map(|(index, _)| index)
                .collect();
            // 第一段内的换行够多，才能从某个换行处切开并保留恰好 keep_newlines 个。
            if positions.len() >= keep_newlines {
                // 从倒数第 keep_newlines 个换行处切；切点取更靠后者，两个维度都不能被破坏。
                cut = cut.max(positions[positions.len() - keep_newlines]);
            }
        // 剩余部分本身已超过行窗口，第一段整段都可丢弃。
        } else {
            // 切点设为段长，等价于删掉整段。
            cut = first.len();
        }
        // 执行实际裁剪：drain(..cut) 取走前缀；drain 要求 cut 在字符边界，前面已保证。
        if cut > 0 {
            let first = &mut self.segments[0].1;
            // 先收集成 String 再扣减计数，因为 drain 之后原字符串长度已经改变。
            let prefix: String = first.drain(..cut).collect();
            self.bytes -= prefix.len();
            self.newlines -= newline_count(&prefix);
            removed.push_str(&prefix);
            // 裁剪后可能只剩空串；删除空段，保持 segments 不含空文本的约定。
            if first.is_empty() {
                self.segments.remove(0);
            }
        }
        // 没有任何文本被裁掉时不创建 skipped，避免线上出现零值 skipped。
        if !removed.is_empty() {
            // 第一次裁剪时才创建累计统计；后续裁剪继续累加。
            let skipped = self.skipped.get_or_insert_with(Skipped::default);
            skipped.bytes += removed.len() as u64;
            skipped.newlines += newline_count(&removed) as u64;
            // removed 是本次（也是目前最后一段）被裁掉的前缀；它的末尾决定整个 skipped 前缀的结尾。
            skipped.ends_with_newline = removed.ends_with('\n');
        }
    }

    // 取走当前全部暂存输出，返回 0..N 条 Event，并按本次发送量更新下一次发送时间。
    // 有 skipped 时只返回一条事件：文本包含跳过之后的所有段，流名取最后一段（与 Durable 一致）；
    // 没有 skipped 时按 segment 分别返回，保留每段的流名和顺序。
    // 副作用：清空 segments/bytes/newlines/skipped，并把 next_send 推进到 now + max(min_interval, pace)。
    // 例：take 返回 [Event{stream:"stdout",text:"hi",skipped:None}] 后，is_empty() 为 true。
    /// Deliver everything held: one event carrying the skip and all text after it, or one event per segment.
    pub fn take(&mut self) -> Vec<Event> {
        // mem::take 用空 Vec 换出 segments，避免复制；旧 Vec 的所有权转给局部变量。
        let segments = std::mem::take(&mut self.segments);
        // 先保存本次待发送字节数用于算节奏；随后计数清零。
        let delivered = self.bytes;
        self.bytes = 0;
        self.newlines = 0;
        // The caller writes at most the window per sample, and paces itself by what it wrote.
        // 一次发送最多按 max_bytes 计费，避免大输出把下一次发送推得过远；除以速率得到秒数。
        let pace = Duration::from_secs_f64(
            delivered.min(self.window.max_bytes) as f64 / self.window.bytes_per_second,
        );
        // 取最小间隔和速率间隔中较大者：既不低于配置的最小间隔，也不超过配置的带宽。
        self.next_send = Instant::now() + self.window.min_interval.max(pace);
        // take 把 skipped 置为 None；Some 表示有前缀被丢弃，需要把所有剩余段合并成一条事件。
        match self.skipped.take() {
            Some(skipped) => {
                // 合并事件的流名取最后一段；没有段时回退 "stdout"（正常流程至少有一段）。
                let stream = segments
                    .last()
                    .map(|(stream, _)| *stream)
                    .unwrap_or("stdout");
                // 把所有剩余段按顺序拼成一个字符串；skip 之前的内容已丢弃，流边界无法再保留。
                let text: String = segments.into_iter().map(|(_, text)| text).collect();
                vec![Event {
                    stream,
                    text,
                    // json! 宏生成 skipped 对象；字段名与线上协议一致，u64/bool 自动序列化。
                    skipped: Some(json!({
                        "bytes": skipped.bytes,
                        "newlines": skipped.newlines,
                        "endsWithNewline": skipped.ends_with_newline,
                    })),
                }]
            }
            // 没有丢弃内容时保留分段，客户端可以按流分别处理。
            None => segments
                .into_iter()
                // 每个 segment 变成一条事件，skipped 均为 None。
                .map(|(stream, text)| Event {
                    stream,
                    text,
                    skipped: None,
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 测试用窗口：参数控制窗口大小；min_interval 为 0、bytes_per_second 极大，
    // 让节奏永不成为测试等待的原因。
    fn window(max_bytes: usize, max_lines: usize) -> Window {
        Window {
            max_bytes,
            max_lines,
            min_interval: Duration::ZERO,
            bytes_per_second: 1e12,
        }
    }

    // 汇总事件：累计发送与跳过的字节/换行，并返回“最后一次 skip 之后的文本”。
    // 用于验证计数守恒（发送 + 跳过 = 原始输出）和尾部完整。
    /// Bytes and newlines delivered or skipped, and the text after the last skip.
    fn total(events: &[Event]) -> (u64, u64, String) {
        let mut bytes = 0;
        let mut newlines = 0;
        let mut after = String::new();
        for event in events {
            // 每遇到 skipped，把丢弃计数加上，并清空 after：只有最后一次 skip 之后的文本才是真实尾部。
            if let Some(skipped) = &event.skipped {
                // 测试里直接 unwrap：JSON 由本模块生成，字段类型已知。
                bytes += skipped["bytes"].as_u64().unwrap();
                newlines += skipped["newlines"].as_u64().unwrap();
                // 之前累积的文本已经属于被跳过的前缀，不能算作尾部。
                after.clear();
            }
            // 事件文本的字节数也计入总量，最终应等于原始输出总字节。
            bytes += event.text.len() as u64;
            newlines += newline_count(&event.text) as u64;
            // 记录最后一段尾部文本，供 full.ends_with(after) 检查。
            after.push_str(&event.text);
        }
        (bytes, newlines, after)
    }

    // 构造 500 行含多字节字符的输出，每 50 行取一次；验证发送+跳过=全部、
    // 尾部不丢，并且确实发生过 skip。
    #[test]
    fn counts_everything_and_keeps_more_than_the_window_after_a_skip() {
        let mut pending = Pending::new(window(10, 2));
        // full 保存原始输出，用于最后对比总量和尾部的后缀关系。
        let mut full = String::new();
        let mut events = Vec::new();
        // 500 条输出足以触发多轮裁剪；文本含 é 和 emoji，专门验证字节计数与字符边界。
        // 用 index 交替流名，覆盖 segment 合并与分段。
        for index in 0..500 {
            let text = format!("line {index} é😀\n");
            full.push_str(&text);
            // 每 7 条切一次流：相邻同流会合并，切换流会新开 segment。
            pending.push(if index % 7 == 0 { "stderr" } else { "stdout" }, text);
            // 每 50 条 take 一次，模拟调用方节奏，并触发多轮裁剪和发送。
            if index % 50 == 49 {
                events.extend(pending.take());
            }
        }
        events.extend(pending.take());
        // 汇总所有事件中的发送量和跳过量。
        let (bytes, newlines, after) = total(&events);
        // 发送字节 + skipped 字节必须等于原始总字节，证明计数没有重复或丢失。
        assert_eq!(bytes, full.len() as u64);
        assert_eq!(newlines, newline_count(&full) as u64);
        // 最后一条 skip 之后的文本必须是原始输出的后缀，证明尾部没有被误裁。
        assert!(full.ends_with(&after));
        // 尾部必须比窗口多一些（字节或行），体现“保留超过窗口”的语义。
        assert!(after.len() > 10 || newline_count(&after) > 2);
        // 500 行远超窗口，必须至少产生一次 skipped；否则测试没有覆盖裁剪路径。
        assert!(events.iter().any(|event| event.skipped.is_some()));
    }

    // 窗口足够大时不应发生裁剪：三次 push 应产生三条按流分段的独立事件。
    #[test]
    fn delivers_streams_apart_without_skips() {
        let mut pending = Pending::new(window(1000, 1000));
        // 依次写 stdout/stderr/stdout，验证相邻同流合并不跨过 stderr。
        pending.push("stdout", "a".into());
        pending.push("stderr", "b".into());
        pending.push("stdout", "c".into());
        // take 后应有 3 条事件，顺序与 push 一致。
        let events = pending.take();
        let streams: Vec<_> = events.iter().map(|event| event.stream).collect();
        // 流名序列必须完整保留，不能被合并成一条混合流事件。
        assert_eq!(streams, ["stdout", "stderr", "stdout"]);
    }
}
