//! What differs between operating systems: error names, positional reads, temporary directories, opening readers,
//! and starting and killing commands. Each implementation follows what Node (libuv) does on that system.
//!
//! 所属模块：packages/env/daemon/src/sys，daemon 的平台抽象层。上层是 main.rs 的协议调度、
//! exec.rs 的命令启动、fs.rs 的文件操作和 watch.rs 的快照扫描；下层是 sys/unix.rs（libc）
//! 和 sys/windows.rs（windows-sys）。上层只写 sys::xxx，平台差异在本层收口。
//!
//! 职责边界：本文件只放平台共用的类型和几个与平台无关的小工具；涉及系统调用的实现
//! （打开文件、读管道、创建进程、错误码翻译等）通过 cfg 条件编译从 unix.rs 或 windows.rs
//! 重新导出。这里不解析协议 JSON，也不构造协议错误；错误由调用方转成 errors::Failure。
//!
//! 能力清单（按导出项）：
//! - ShellConfig：描述字符串命令如何经 shell 运行（程序、前置参数、命令是否走 stdin）。
//! - OpenMode：对应 Node 的 r / w / a / r+ 打开方式，供 fs.rs 和 main.rs 选择。
//! - Synthetic 与 synthetic()：把“系统调用没报、但 libuv 会报”的错误码包装成 io::Error。
//! - error_name()：先识别 Synthetic，再委托各平台的 os_error_name 得到 libuv 风格错误名。
//! - path_exists()：类似 Node 的 access(path, F_OK)，跟随符号链接判断存在。
//! - random_bytes()：为临时文件名生成 16 个随机字节，明确不是密码学随机。
//! - cwd()：daemon 当前工作目录，供 hello 的 cwd 字段和 Node path.resolve 回退使用。
//!
//! 典型调用（示例，真实签名见各函数）：
//!     let file = sys::open(path, sys::OpenMode::Read)?;
//!     let code = sys::error_name(&io_error);
//!
//! 建议阅读顺序：先看 ShellConfig、OpenMode、Synthetic 三个类型，再看顶部的 cfg 导出，
//! 然后按 error_name、path_exists、random_bytes、cwd 阅读；需要具体平台行为时转到
//! unix.rs 或 windows.rs。

// #[cfg(unix)] 是编译期条件：只有目标平台属于 Unix 时才编译这个模块。
// 被排除时，下面的 pub use 也不会存在，因此上层不可能误调用平台不对的函数。
#[cfg(unix)]
mod unix;
// pub use unix::* 把 unix.rs 的公开项重新导出到 sys 命名空间；
// 这样 fs.rs 写 sys::open，而不需要写 sys::unix::open，也不需要 cfg 分支。
#[cfg(unix)]
pub use unix::*;

// Windows 目标同理：只有 Windows 构建才编译这个模块；
// 非 Windows 构建看不到 mod windows，也无法引用它的实现。
#[cfg(windows)]
mod windows;
// 把 windows.rs 的公开项导出到 sys 命名空间。它与 Unix 的导出同名，
// 但两个 cfg 互斥，所以不会在同一次构建里冲突。
#[cfg(windows)]
pub use windows::*;

/// How a string command runs: the shell, its arguments before the command, and whether the command goes to its
/// stdin instead of its arguments (legacy WSL `bash.exe`).
// 字符串命令的执行方式：先启动 program，再传 args，最后决定用户命令放在参数末尾还是写进 stdin。
// 例（Unix）：program="/bin/bash"、args=["-c"]、command_on_stdin=false，
// 于是 "echo hi" 作为 "-c" 的下一个参数；Windows 旧版 WSL 的 bash.exe 则用 -s 加 stdin。
pub struct ShellConfig {
    // 要启动的可执行文件路径或名字；Unix 上可以交给 execvp 搜索 PATH。
    pub program: String,
    // 在用户命令之前传给 shell 的参数，例如 ["-c"] 或 ["-s"]。
    pub args: Vec<String>,
    // true 表示用户命令不在 args 里，而由 exec.rs 写进子进程的 stdin；
    // 这是为了兼容只接受 -s 形式的旧版 WSL bash。
    pub command_on_stdin: bool,
}

/// How Node opens files: `r`, `writeFile` (`w`), `appendFile` (`a`), and `r+` for truncate and fsync.
// Node 的四种打开方式。#[derive(Clone, Copy)] 让小枚举可以按值复制：
// 传参时不会移动所有权，也不需要到处写 &OpenMode。
// 这里只描述意图，映射到 O_* 标志或 CreateFileW 参数由各平台实现完成。
#[derive(Clone, Copy)]
pub enum OpenMode {
    /// Node's `open(path, "r")`: any kind of file, blocking reads.
    // 只读打开，对应 Node 的 open(path, "r")；任何类型的文件都可以打开，读取可能阻塞。
    Read,
    // 写模式：创建（若不存在）并截断已有内容，对应 writeFile 的默认行为。
    Write,
    // 追加模式：创建（若不存在）并把写入放到文件末尾，对应 appendFile。
    Append,
    // 读写模式但不创建也不截断；truncate/fsync 需要这种句柄。
    ReadWrite,
}

/// An error code libuv reports where the system call itself reported another one, such as `ENOTDIR` from a recursive
/// `mkdir` through a file, or `EISDIR` when Windows creates a file where a directory exists.
// 系统调用返回的 errno 与 libuv 对外报的错误码并不总一致：例如用文件挡住递归 mkdir 的父目录时，
// Unix 内核报 EEXIST，而 libuv 报 ENOTDIR。Synthetic 把这种“人造码”塞进 io::Error，
// 让 error_name() 能优先识别它。
// 元组结构体 Synthetic(pub &'static str) 只有一个字段：pub 表示字段可被同 crate 读取；
// &'static str 表示错误名来自程序常量，不需要分配内存，也没有生命周期问题。
// #[derive(Debug)] 自动生成调试输出，便于日志和测试断言。
#[derive(Debug)]
pub struct Synthetic(pub &'static str);

// Display 让 Synthetic 能作为错误消息被打印；这里直接输出错误码，例如 "EISDIR"。
impl std::fmt::Display for Synthetic {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}

// 实现 std::error::Error 是 io::Error::other 的要求：只有真正实现该 trait 的类型
// 才能作为 io::Error 的内部错误保存。这里没有额外方法，空实现即可。
impl std::error::Error for Synthetic {}

// 构造携带人造错误码的 io::Error；参数必须是 'static 字符串，避免错误里保存临时借用。
// io::Error::other 会把 Synthetic 装箱保存，调用方仍可把它当作普通 io::Error 传递。
// 例：synthetic("ENOTDIR") 之后 error_name(&error) 返回 "ENOTDIR"。
pub fn synthetic(code: &'static str) -> std::io::Error {
    std::io::Error::other(Synthetic(code))
}

/// The libuv name of an error: a synthetic code, or the system's code translated per platform.
// 把任意 io::Error 翻成 libuv 的错误名，返回静态字符串，不分配内存。
// 先检查内部是不是 Synthetic：get_ref() 取出内部错误，downcast_ref::<Synthetic>()
// 做运行时类型判断（错误可能来自标准库或系统，这是必要的跨边界检查）。命中就直接返回人造码。
// 否则委托平台的 os_error_name 翻译 raw_os_error。
// 例：读不存在的文件得到 "ENOENT"；未知平台码可能得到 "UNKNOWN"。
pub fn error_name(error: &std::io::Error) -> &'static str {
    if let Some(Synthetic(code)) = error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<Synthetic>())
    {
        return code;
    }
    os_error_name(error)
}

/// Whether a path exists, following symbolic links, like Node's `access(path, F_OK)`.
// 判断路径是否存在，语义接近 Node 的 access(path, F_OK)。
// Path::metadata() 会跟随符号链接：悬空链接返回 false，链接目标存在则返回 true。
// is_ok() 丢弃具体错误，权限不足也当作“不可访问”，调用方（shell 解析、drive 探测）只关心真假。
// 例：path_exists("/tmp") 通常为 true；path_exists("/no/such/file") 为 false。
pub fn path_exists(path: &str) -> bool {
    std::path::Path::new(path).metadata().is_ok()
}

/// Sixteen random bytes for temporary names (not for secrets).
// 生成 16 个“足够随机”的字节，只用于临时文件名，不是密钥材料。
// 做法：用 RandomState 提供随机种子，把进程内自增计数器和当前时间写进 hasher，
// 取两次 64 位结果拼成 16 字节；即使同一纳秒内调用两次，计数器也不同。
// 返回固定长度数组 [u8; 16]，调用方（exec.rs）再把它格式化成 UUID 文本。
// 例：两次调用 random_bytes() 得到不同数组；这里不保证密码学强度。
pub fn random_bytes() -> [u8; 16] {
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    // 函数内 static：整个进程只有一份 COUNTER。AtomicU64 允许并发 fetch_add，
    // Relaxed 只保证原子性，不需要与其他内存操作建立顺序，因为这里只要求值唯一。
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    // RandomState 每次构造都会从操作系统取得随机种子，用它构造 hasher 即可得到不可预测的输出。
    let state = std::collections::hash_map::RandomState::new();
    // 先分配结果数组；[0u8; 16] 是“16 个零字节”的数组字面量，不是 16 号值。
    let mut bytes = [0u8; 16];
    // 循环两次，每次生成 8 字节，填满 16 字节数组。
    for half in 0..2 {
        // 每次新建 hasher，避免两次结果之间产生可预测的延续关系。
        let mut hasher = state.build_hasher();
        // fetch_add 返回加之前的旧值并原子地加一；这个值与时间一起作为哈希输入。
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        // write_u128 把纳秒时间戳整体写入；下面的 duration_since 在系统时间早于 1970 时
        // 返回 Err，map(...).unwrap_or(0) 把它变成 0，避免 panic。
        hasher.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|time| time.as_nanos())
                .unwrap_or(0),
        );
        // 切片范围必须正好 8 字节；to_le_bytes 固定产生 8 字节，不受平台字节序影响。
        // copy_from_slice 做一次内存复制，长度不匹配会 panic，这里长度由类型保证。
        bytes[half * 8..half * 8 + 8].copy_from_slice(&hasher.finish().to_le_bytes());
    }
    bytes
}

/// The daemon's working directory, the `process.cwd()` Node's `path.resolve` falls back to.
// 返回 daemon 的当前工作目录，作为 hello.cwd 和客户端 path.resolve 的回退值。
// current_dir 失败（例如启动目录已被删除）时 unwrap_or_default 返回空字符串，协议仍可继续。
// to_string_lossy 把非 UTF-8 路径换成替换字符，符合协议“路径是 JSON 字符串”的约定。
// 例：在 /tmp 启动 daemon，得到 "/tmp"。
pub fn cwd() -> String {
    std::env::current_dir()
        .map(|cwd| cwd.to_string_lossy().into_owned())
        .unwrap_or_default()
}
