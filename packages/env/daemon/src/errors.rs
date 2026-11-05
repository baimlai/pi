//! Errors as Node reports them: a code such as `ENOENT` plus a diagnostic message.
//
// 文件导读（packages/env/daemon/src/errors.rs）
// 所属包/模块：packages/env 的 Rust daemon（二进制 pi-env）中的协议错误模块。
// 解决的问题与职责边界：把 daemon 内部的 io::Error 或自造校验失败整理成客户端契约要求的
// { code, message, syscall?, path?, ...extra }。code 是客户端行为的依据（例如 ENOENT、EBADF、aborted），
// message 只用于诊断；本模块不决定重试、不终止连接，也不访问文件系统。
// 上游入口：fs/exec/pty/process/list/main 的各操作在失败时构造 Failure，最后由 main.rs 的 respond 转成
// ERROR 帧。
// 下游依赖：sys::error_name 负责平台错误码到 libuv 名称的翻译；本文件内的 describe 提供固定文案表。
// 能力清单（按导出项）：
//   - Failure：拥有型错误数据；字段 code/message 公开，details 私有并按需分配。
//   - Failure::new：最简错误，无 syscall/path/extra。
//   - Failure::extra：附加任意 JSON 字段（如 spillPath），支持链式调用。
//   - Failure::io / io_between：把单路径/双路径 I/O 错误转成 Node 风格错误。
//   - Failure::path：附加失败路径。
//   - Failure::to_json：生成发送给客户端的 JSON 值。
//   - describe（私有）：libuv 的 uv_strerror 固定文案表。
// 组合关系/典型调用顺序：op -> Failure::io(&error, "open", path) -> to_json() -> frame::ERROR。
// 示例（真实签名，来自 fs.rs 的用法）：Failure::io(&error, "lstat", path).to_json() 得到
// { "code": "ENOENT", "message": "ENOENT: no such file or directory, lstat '/x'", "syscall": "lstat",
//   "path": "/x" }（具体 code 由平台错误与 sys::error_name 决定）。
// 建议阅读顺序：先看 Failure/Details 字段，再看 new/io/io_between 的构造流程，最后看 to_json 的合并规则与
// describe 文案表。

use serde_json::{Value, json};
use std::io;

/// A failure with a Node-style code; messages are diagnostic only.
// derive(Debug) 自动生成调试打印实现；这里保存的是协议错误数据，不会自动抛异常。
#[derive(Debug)]
pub struct Failure {
    // code 是客户端判断行为的错误码，message 只提供诊断文字。
    pub code: String,
    pub message: String,
    // Option 表示细节可能不存在；Box 将少用字段放到独立堆内存，避免每个错误内联占满空间。
    details: Option<Box<Details>>,
}

// Default 为三个 Option 字段提供 None；Details 仅在需要时创建。
#[derive(Debug, Default)]
struct Details {
    syscall: Option<String>,
    path: Option<String>,
    /// Extra fields for the client, such as `spillPath`.
    extra: Option<Value>,
}

impl Failure {
    // 构造错误值，不做 I/O；输入码和可转为 String 的消息，返回没有附加字段的 Failure。
    // 例：new("EINVAL", "bad argument") 只是生成数据，调用方再将它作为 Err 返回。
    pub fn new(code: &str, message: impl Into<String>) -> Failure {
        Failure {
            // 借用的 &str 转为拥有内存的 String，返回值无需依赖输入寿命。
            code: code.to_string(),
            // impl Into<String> 接受 String 或 &str 等类型，这里执行转换并取得所有权。
            message: message.into(),
            // 最常见的错误无需分配 Details。
            details: None,
        }
    }

    // 取得可变细节；没有时懒创建并返回借用，会修改 self。例：path() 首次调用时才分配 Details。
    fn details(&mut self) -> &mut Details {
        // get_or_insert_with 仅在 None 时调用 Default::default；Box<Details> 可自动解引用到 Details。
        self.details.get_or_insert_with(Default::default)
    }

    /// Add fields to the error JSON, such as `spillPath`.
    // 消费当前错误，保存附加 JSON，再返回自身，支持链式调用；无 I/O。例：failure.extra({spillPath: ...})。
    pub fn extra(mut self, extra: Value) -> Failure {
        // Some 标记存在；这里允许任意 JSON，to_json 只展开其中的对象。
        self.details().extra = Some(extra);
        // 把 self 的所有权交还调用方。
        self
    }

    /// An I/O error of `syscall` on `path`, with libuv's error name as code.
    // 将单路径 I/O 错误转换为协议错误；输入均借用，不访问文件。例：open 缺失文件产生 ENOENT 和 path。
    pub fn io(error: &io::Error, syscall: &str, path: &str) -> Failure {
        // 复用双路径格式化逻辑，None 表示没有目标路径。
        Failure::io_between(error, syscall, path, None)
    }

    /// Node's message for an error of a two-path call: `CODE: description, syscall 'from' -> 'to'`.
    // 按 Node 风格生成双路径错误数据；参数为 OS 错误、系统调用名、源路径和可选目标。
    // 通过平台码表选文案，补 syscall/path；例：rename 失败的消息带 from -> to，但 path 字段仍是源路径。
    pub fn io_between(
        error: &io::Error,
        syscall: &str,
        path: &str,
        destination: Option<&str>,
    ) -> Failure {
        // sys 优先识别人造错误码，再将平台原始码翻译为 libuv 名称。
        let code = crate::sys::error_name(error).to_string();
        // 优先用固定文案；map 转拥有的 String，unwrap_or_else 仅在没有对应码时运行闭包。
        let description = describe(&code).map(str::to_string).unwrap_or_else(|| {
            // Unknown to libuv's table: the OS text without Rust's " (os error N)".
            // 未知码退回 OS 自带文字，而非声称覆盖全部平台错误。
            let text = error.to_string();
            // 以 Rust 附带的错误编号后缀为分界，只取前半段；next 为 None 时保留原文，再转小写。
            text.split(" (os error")
                .next()
                .unwrap_or(&text)
                .to_lowercase()
        });
        // match 穷尽 Option 的有/无两种情况；format! 将路径插入诊断消息。
        let target = match destination {
            Some(destination) => format!("'{path}' -> '{destination}'"),
            None => format!("'{path}'"),
        };
        // 创建基础码与完整文案；这些格式化不会重新执行失败的系统调用。
        let mut failure = Failure::new(&code, format!("{code}: {description}, {syscall} {target}"));
        // 添加发生失败的系统调用名。
        failure.details().syscall = Some(syscall.to_string());
        // 链式补源路径，并作为本函数最终返回值。
        failure.path(path)
    }

    // 消费错误并设置 path，返回更新后的错误，无文件访问；例：Failure::new(...).path("/tmp/x")。
    pub fn path(mut self, path: &str) -> Failure {
        // 把路径复制为 String，避免保存外部借用。
        self.details().path = Some(path.to_string());
        // 末尾表达式返回自身，支持继续调用 extra。
        self
    }

    // 借用错误生成独立 JSON；先输出 code/message，再选填细节，无 I/O。
    // 例：没有 details 时只有两字段；extra 对象可覆盖此前的同名字段，此处不做额外冲突校验。
    pub fn to_json(&self) -> Value {
        // json! 宏把这些字段序列化到 Value；self 仍可继续使用。
        let mut value = json!({ "code": self.code, "message": self.message });
        // let-else 解构 Option；没有细节时提前返回基础对象。
        let Some(details) = &self.details else {
            return value;
        };
        // 仅在 syscall 存在时追加对应字段。
        if let Some(syscall) = &details.syscall {
            value["syscall"] = json!(syscall);
        }
        // 同理，None 的 path 不会生成 null 字段。
        if let Some(path) = &details.path {
            value["path"] = json!(path);
        }
        // 嵌套模式仅匹配 Some(Object)，其他 JSON 类型被忽略。
        if let Some(Value::Object(extra)) = &details.extra {
            // 借用迭代每个扩展字段；clone 复制 Value，原错误数据不被消耗。
            for (key, field) in extra {
                value[key] = field.clone();
            }
        }
        // 返回组装后的拥有型 JSON。
        value
    }
}

/// libuv's `uv_strerror` texts, which Node uses on every system.
// 纯查表函数：输入错误码，返回固定文案或 None，无副作用。例：ENOENT 对应 no such file or directory。
// 返回的 static 字符串来自程序常量，无需分配内存。
fn describe(code: &str) -> Option<&'static str> {
    // match 的每个字符串分支精确匹配错误码；外层 Some 包装成功找到的文本。
    Some(match code {
        "EACCES" => "permission denied",
        "EAGAIN" => "resource temporarily unavailable",
        "EBADF" => "bad file descriptor",
        "EBUSY" => "resource busy or locked",
        "EEXIST" => "file already exists",
        "EFBIG" => "file too large",
        "EINVAL" => "invalid argument",
        "EIO" => "i/o error",
        "EISDIR" => "illegal operation on a directory",
        "ELOOP" => "too many symbolic links encountered",
        "EMFILE" => "too many open files",
        "EMLINK" => "too many links",
        "ENAMETOOLONG" => "name too long",
        "ENFILE" => "file table overflow",
        "ENOENT" => "no such file or directory",
        "ENOMEM" => "not enough memory",
        "ENOSPC" => "no space left on device",
        "ENOSYS" => "function not implemented",
        "ENOTDIR" => "not a directory",
        "ENOTEMPTY" => "directory not empty",
        "ENOTSUP" => "operation not supported on socket",
        "EPERM" => "operation not permitted",
        "EROFS" => "read-only file system",
        "ETXTBSY" => "text file is busy",
        "EXDEV" => "cross-device link not permitted",
        // 通配分支提前返回 None，留给上面的 OS 文本后备逻辑处理。
        _ => return None,
    })
}
