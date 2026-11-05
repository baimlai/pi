//! Length-prefixed frames: `u32 length | u8 type | u32 id | u32 jsonLength | json | payload` (docs/protocol.md).
//
// 文件导读（packages/env/daemon/src/frame.rs）
// 所属包/模块：packages/env 的 Rust daemon（二进制 pi-env）中的线上帧编解码模块。
// 解决的问题与职责边界：在 stdin/stdout 上定义双向消息的字节布局、长度上限、请求/结果/错误/事件/取消/心跳
// 类型编号，并处理截断、超长、JSON 解析失败等边界。它不解释 op，也不决定何时发送；调度与优先级由 main.rs
// 和 output.rs 负责。
// 上游入口：main.rs 的 serve_frames 用 read_frame 读客户端请求；respond 用 write_frame（经由 output 写线程）
// 发回复。output.rs 的写线程是整个进程唯一的 write_frame 调用方。
// 下游依赖：serde_json::Value 表示头部 JSON；std::io::Read/Write 提供字节流抽象（stdin/stdout 或内存 Vec）。
// 能力清单（按导出项）：
//   - REQUEST/RESULT/ERROR/EVENT/CANCEL/PING：u8 线上类型编号。
//   - MAX_FRAME/MAX_PAYLOAD：单帧总长与响应 payload 的安全上限。
//   - Frame：kind/id/json/payload 的内存表示；new 建空 payload，with_payload 建二进制帧。
//   - read_frame：读一帧；干净 EOF 返回 Ok(None)，帧体截断或字段越界返回 Err。
//   - write_frame：序列化并写出完整帧；写出部分数据后失败无法回滚。
//   - tests：内存 Vec 上的 JSON+二进制往返与空输入。
// 组合关系/典型调用顺序：客户端请求 -> read_frame -> serve_frames 分发；处理结果 -> Frame -> Output ->
// write_frame -> stdout。帧头 9 字节 = type(1)+id(4)+jsonLength(4)，payload 长度由总长推算。
// 示例（真实签名，来自 frame.rs 测试）：write_frame(&mut buffer, &Frame::with_payload(RESULT, 7,
// json!({"a": 1}), vec![0, 255, 10]))?；随后 read_frame(&mut buffer.as_slice())? 得到同一 kind/id/JSON/payload。
// 建议阅读顺序：先看类型常量与 Frame，再看 read_frame 的边界检查，最后看 write_frame 的编码顺序与测试。

use serde_json::Value;
use std::io::{self, Read, Write};

// u8 是无符号单字节数；这六个常量对应请求、结果、错误、事件、取消与心跳的线上编号。
pub const REQUEST: u8 = 1;
pub const RESULT: u8 = 2;
pub const ERROR: u8 = 3;
pub const EVENT: u8 = 4;
pub const CANCEL: u8 = 5;
pub const PING: u8 = 6;

/// Largest frame either side accepts.
// usize 适合内存长度；帧长度限制不包含开头四字节 length。
pub const MAX_FRAME: usize = 16 * 1024 * 1024;
/// Largest payload a response carries, leaving room for its JSON.
// 给响应 JSON 和固定头部留出余量，文件读取等操作据此分块。
pub const MAX_PAYLOAD: usize = MAX_FRAME - 64 * 1024;

// Frame 是内存表示；类型约束不代表 kind 已经是允许的协议类型，调度层再解释它。
pub struct Frame {
    pub kind: u8,
    pub id: u32,
    pub json: Value,
    // Vec<u8> 拥有原始二进制内容；它与 JSON 分开，不要求是合法 UTF-8。
    pub payload: Vec<u8>,
}

impl Frame {
    // 创建无 payload 的帧，消费 JSON、返回 Frame，不写 stdout。例：new(PING, 0, {})。
    pub fn new(kind: u8, id: u32, json: Value) -> Frame {
        // 字段名与变量名相同时可用 Rust 的字段简写。
        Frame {
            kind,
            id,
            json,
            // 空 Vec 表示没有二进制负载。
            payload: Vec::new(),
        }
    }

    // 创建带二进制内容的帧；取得 JSON 和 payload 所有权，不复制负载，不做长度校验。
    // 例：RESULT/7 携带文件内容，实际长度限制在 write_frame 执行。
    pub fn with_payload(kind: u8, id: u32, json: Value, payload: Vec<u8>) -> Frame {
        // 直接组合四个字段，返回内存对象。
        Frame {
            kind,
            id,
            json,
            payload,
        }
    }
}

// 把协议格式错误封装为标准 I/O 错误，不执行 I/O；例：长度不足九字节是 InvalidData。
fn invalid(message: &str) -> io::Error {
    // 复制消息让错误拥有文本，不依赖 message 的借用寿命。
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

/// Read one frame; `None` at a clean end of input.
// 从实现 Read 的输入读取一帧，返回 Result<Option<Frame>>；会消耗输入字节。
// 先读取长度再读完整帧，边界错则 Err；长度头遇 UnexpectedEof 返回 None（包括只读到部分头），帧体截断则 Err。
// 例：空输入得到 Ok(None)，合法帧得到 Ok(Some(...))；JSON 解析错误单独保留帧以便回复 EINVAL。
pub fn read_frame(input: &mut impl Read) -> io::Result<Option<Frame>> {
    // [0u8; 4] 是四个零字节的固定数组，专门承载大端长度。
    let mut length = [0u8; 4];
    // read_exact 要么填满四字节，要么报错；match guard 的 if 对特定错误做分流。
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    // from_be_bytes 按网络大端序转为 u32，再转为内存长度 usize。
    let length = u32::from_be_bytes(length) as usize;
    // 9..=MAX_FRAME 是含两端范围；这是来自线上字节的运行时校验，保护后续索引与分配。
    if !(9..=MAX_FRAME).contains(&length) {
        return Err(invalid("frame length out of range"));
    }
    // 通过上限检查后分配帧体；此处还未解析字段。
    let mut body = vec![0u8; length];
    // ? 遇 Err 立即向上传播，完整帧体不会像长度头那样吞掉截断错误。
    input.read_exact(&mut body)?;
    // 第零字节是类型，接下来两组四字节是请求 ID 与 JSON 字节长度。
    let kind = body[0];
    let id = u32::from_be_bytes([body[1], body[2], body[3], body[4]]);
    let json_length = u32::from_be_bytes([body[5], body[6], body[7], body[8]]) as usize;
    // 保证 JSON 不越过帧体末尾，否则不能安全切片。
    if 9 + json_length > length {
        return Err(invalid("JSON length out of range"));
    }
    // Unparseable JSON leaves the framing intact: the frame arrives with `Value::Null` and gets an error reply.
    // 零长度 JSON 按空对象处理；非零长度只解析对应区间，不把 payload 误当 JSON。
    let json = if json_length == 0 {
        Value::Object(Default::default())
    } else {
        // Value::Null 是解析失败的标记；这里不把它作为 framing 错误，dispatch 会回复请求错误。
        serde_json::from_slice(&body[9..9 + json_length]).unwrap_or(Value::Null)
    };
    // 复制剩余字节为 payload，使结果不再借用临时 body。
    let payload = body[9 + json_length..].to_vec();
    // 双层包装分别表示读取成功与确实读到了一帧。
    Ok(Some(Frame {
        kind,
        id,
        json,
        payload,
    }))
}

// 序列化并写出一帧，成功返回 ()，长度或 I/O 失败返回 Err；会写入并 flush 输出。
// 例：一个 RESULT 帧按 length/type/id/jsonLength/JSON/payload 顺序发送，已写出的部分无法在错误时撤回。
pub fn write_frame(output: &mut impl Write, frame: &Frame) -> io::Result<()> {
    // JSON 先编码成 UTF-8 字节；map_err 转统一的 InvalidData，? 向上传播。
    let json = serde_json::to_vec(&frame.json).map_err(|_| invalid("unserializable JSON"))?;
    // 固定帧体头九字节加 JSON 与 payload；不含长度字段本身。
    let length = 9 + json.len() + frame.payload.len();
    // 本地构造的帧也需校验上限，避免发送对端必拒绝的长度。
    if length > MAX_FRAME {
        return Err(invalid("frame too large"));
    }
    // 13 字节 = 四字节 length + 九字节固定帧体头；with_capacity 预留容量，不填数据。
    let mut header = Vec::with_capacity(13);
    // 将长度转成四个大端字节追加；此前限制保证可装入 u32。
    header.extend_from_slice(&(length as u32).to_be_bytes());
    // 类型占一个字节，不作额外编码。
    header.push(frame.kind);
    // ID 和 JSON 长度也分别用四字节大端序。
    header.extend_from_slice(&frame.id.to_be_bytes());
    header.extend_from_slice(&(json.len() as u32).to_be_bytes());
    // write_all 会循环直至这一段全部写完或报错；? 不忽略部分写入后的错误。
    output.write_all(&header)?;
    // 头之后是 JSON，最后是原始 payload。
    output.write_all(&json)?;
    output.write_all(&frame.payload)?;
    // flush 推出缓冲内容，其结果直接作为函数返回；不代表远端已处理该帧。
    output.flush()
}

// cfg(test) 让整个测试模块只在测试构建中参与编译；super::* 引入父模块成员。
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // 用内存 Vec 验证 JSON/二进制往返及空输入，不启动 daemon；无参数和返回值，断言失败会 panic。
    // 例子中的 255 是二进制字节，证明 payload 无需作为 UTF-8 文本处理。
    #[test]
    fn round_trips_json_and_payload() {
        // Vec 实现 Write，可充当纯内存输出。
        let mut buffer = Vec::new();
        // 写入 RESULT/7；借用临时 Frame，unwrap 将意外写入失败视为测试失败。
        write_frame(
            &mut buffer,
            &Frame::with_payload(RESULT, 7, json!({ "a": 1 }), vec![0, 255, 10]),
        )
        .unwrap();
        // as_slice 转为 Read 可消费的字节片；两次 unwrap 分别解开 Result 与 Option。
        let frame = read_frame(&mut buffer.as_slice()).unwrap().unwrap();
        // 只核对该例的帧类型与 ID，而非穷尽所有类型值。
        assert_eq!((frame.kind, frame.id), (RESULT, 7));
        // 比较解析后的 JSON 结构，不依赖字段序列化的字节顺序。
        assert_eq!(frame.json, json!({ "a": 1 }));
        // 原始 payload 的每字节必须保留。
        assert_eq!(frame.payload, vec![0, 255, 10]);
        // 空字节片应成功结束输入，没有下一帧；此测试未覆盖半截长度头或恶意长度。
        assert!(read_frame(&mut &[][..]).unwrap().is_none());
    }
}
