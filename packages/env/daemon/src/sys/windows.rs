//! Windows, following libuv (`src/win/error.c`, `src/win/process.c`, `src/win/fs.c`) and Node's `child_process`.
//!
//! 所属模块：packages/env/daemon/src/sys/windows.rs，sys 层的 Windows 实现。
//! 上游与 Unix 相同：sys/mod.rs 用 cfg(windows) 重新导出，fs.rs、exec.rs、main.rs、process.rs、
//! pty.rs、watch.rs 通过 sys::... 调用；本文件依赖 windows-sys 暴露的 Win32 API。
//!
//! 职责边界：尽力复刻 libuv 的 win/error.c、win/fs.c、win/process.c 与 Node child_process：
//! Win32 错误码翻译、按 Node 模式打开文件、定位读、1970 年前的负数 mtime、临时目录、mkdtemp、
//! 重叠 I/O（overlapped）管道、argv 搜索、环境变量构造、引号转义、Job object 与 taskkill。
//! 协议 JSON 与 Failure 文案仍由上层处理。
//!
//! 能力清单（按导出项）：
//! - os_error_name：Win32 错误码 -> libuv 名（ENOENT 等）。
//! - PATH_SEPARATOR：Windows 路径分隔符 "\\"。
//! - read_at / mtime / identity：seek_read、负数时间、创建时间兜底。
//! - tmpdir / home：Node 的 os.tmpdir()/os.homedir() 规则。
//! - mkdtemp / open_reader / open / realpath / rename / remove_file / read_dir：文件系统操作。
//! - Pipe / read_pipe、WritePipe / write_pipe：用 overlapped I/O + CancelIoEx 实现可停止的管道。
//! - resolve_program / shell_config / configure / quote_argument：命令搜索、bash 解析、环境与引号规则。
//! - job / after_spawn / on_exit_signal / kill_tree / exit_code：Job object、进程树与退出码。
//! - raw_name / drive_cwds / path_identity：目录顺序、=C: 工作目录、卷序列号+文件索引。
//!
//! 典型调用（示例）：
//!     let mut command = std::process::Command::new("cmd.exe");
//!     sys::configure(&mut command, &["/c".into(), "echo hi".into()], &env, true);
//!     sys::after_spawn(&child);                 // 放进 Job object
//!
//! 建议阅读顺序：先看 os_error_name、wide、open 理解 Win32 调用约定；再看 Overlapped 与
//! read_pipe/write_pipe 理解可取消的重叠 I/O；随后 resolve_program -> shell_config -> configure；
//! 最后 job/after_spawn/kill_tree 与文件身份函数。

use super::{OpenMode, ShellConfig, path_exists, synthetic};
use crate::errors::Failure;
use serde_json::{Map, Value};
use std::collections::hash_map::RandomState;
use std::ffi::OsStr;
use std::fs::{File, Metadata};
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::FileExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::UNIX_EPOCH;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_IO_PENDING, FALSE, HANDLE, INVALID_HANDLE_VALUE, TRUE, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CREATE_ALWAYS, CreateFileW, FILE_APPEND_DATA,
    FILE_ATTRIBUTE_NORMAL, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_WRITE_DATA, GetFileInformationByHandle, MOVEFILE_REPLACE_EXISTING, MoveFileExW,
    OPEN_ALWAYS, OPEN_EXISTING, ReadFile, WriteFile,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CreateEventW, WaitForSingleObject};
use windows_sys::core::BOOL;

/// libuv's `uv_translate_sys_error` for the errors file and process operations produce.
// 把 Win32 错误码翻译成 libuv 使用的错误名，返回静态字符串，不分配内存。
// 输入没有 raw_os_error（std 自己构造的错误）时返回 "UNKNOWN"。
// 表中的分支刻意按目标错误名分组：同组的 Win32 码在 Node 看来是同一个错误。
// 例：ERROR_FILE_NOT_FOUND(2) 返回 "ENOENT"；ERROR_ACCESS_DENIED(5) 返回 "EPERM"。
pub fn os_error_name(error: &io::Error) -> &'static str {
    // let-else 提前处理没有系统错误码的情况；之后 code 已是 i32，可直接 match。
    let Some(code) = error.raw_os_error() else {
        return "UNKNOWN";
    };
    match code {
        1 => "EISDIR",                             // ERROR_INVALID_FUNCTION
        2 | 3 | 15 | 123 | 161 | 4392 => "ENOENT", // FILE_NOT_FOUND, PATH_NOT_FOUND, INVALID_DRIVE, INVALID_NAME, BAD_PATHNAME, INVALID_REPARSE_DATA
        4 => "EMFILE",                             // ERROR_TOO_MANY_OPEN_FILES
        5 | 1314 => "EPERM",                       // ACCESS_DENIED, PRIVILEGE_NOT_HELD
        6 => "EBADF",                              // ERROR_INVALID_HANDLE
        8 | 14 => "ENOMEM",                        // NOT_ENOUGH_MEMORY, OUTOFMEMORY
        17 => "EXDEV",                             // ERROR_NOT_SAME_DEVICE
        19 => "EROFS",                             // ERROR_WRITE_PROTECT
        32 | 33 => "EBUSY",                        // SHARING_VIOLATION, LOCK_VIOLATION
        39 | 82 | 112 => "ENOSPC",                 // HANDLE_DISK_FULL, CANNOT_MAKE, DISK_FULL
        50 => "ENOTSUP",                           // ERROR_NOT_SUPPORTED
        80 | 183 => "EEXIST",                      // FILE_EXISTS, ALREADY_EXISTS
        13 | 87 | 122 | 131 | 1464 => "EINVAL", // INVALID_DATA, INVALID_PARAMETER, INSUFFICIENT_BUFFER, NEGATIVE_SEEK, SYMLINK_NOT_SUPPORTED
        126 => "ENOENT",                        // ERROR_MOD_NOT_FOUND
        145 => "ENOTEMPTY",                     // ERROR_DIR_NOT_EMPTY
        206 => "ENAMETOOLONG",                  // ERROR_FILENAME_EXCED_RANGE
        267 => "ENOENT",                        // ERROR_DIRECTORY (libuv maps it to ENOENT)
        998 => "EFAULT",                        // ERROR_NOACCESS
        740 | 1920 => "EACCES",                 // ELEVATION_REQUIRED, CANT_ACCESS_FILE
        1921 => "ELOOP",                        // ERROR_CANT_RESOLVE_FILENAME
        _ => "UNKNOWN",
    }
}

// Windows 的路径分隔符；watch.rs 等用它判断父子路径。字符串字面量里的反斜杠需要转义，
// 所以源码写 "\\" 而运行时值是单个反斜杠。
pub const PATH_SEPARATOR: &str = "\\";

// 从绝对偏移 offset 读取最多 buffer.len() 字节，返回实际字节数；不移动文件游标。
// 调用 std::os::windows::fs::FileExt::seek_read，对应 ReadFile + OVERLAPPED 偏移的同步封装。
// 例：read_at(&file, &mut buf, 0) 读取文件开头；超过文件尾返回 0。
pub fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    file.seek_read(buffer, offset)
}

/// Modification time as seconds and nanoseconds since the epoch; before 1970 the seconds are negative.
// 返回修改时间（秒，纳秒），以 UNIX_EPOCH 为基准；1970 年之前的秒数为负。
// metadata.modified() 失败（文件系统不提供时间）时返回 (0, 0)，调用方仍能比较快照。
// 例：1969-12-31T23:59:59.5Z 返回 (-1, 500_000_000)，而不是 -0.5 秒这种非法组合。
pub fn mtime(metadata: &Metadata) -> (i64, i64) {
    // let-else：Result 的 Ok 分支绑定 time，Err 分支提前返回 (0, 0)。
    let Ok(time) = metadata.modified() else {
        return (0, 0);
    };
    // duration_since 区分“纪元之后”（Ok）与“纪元之前”（Err），
    // 分别转换成 (正秒, 纳秒) 或 (负秒, 非负纳秒)。
    match time.duration_since(UNIX_EPOCH) {
        Ok(after) => (after.as_secs() as i64, i64::from(after.subsec_nanos())),
        // before.duration() 是纪元到该时刻的正时长。
        // 纳秒为 0 时直接取负秒；否则借一秒：(-secs-1, 1e9-nanos)，
        // 这样纳秒字段始终在 0..1e9 内，与 Unix 的 time_t/timespec 表示一致。
        Err(before) => {
            let before = before.duration();
            let nanos = i64::from(before.subsec_nanos());
            if nanos == 0 {
                (-(before.as_secs() as i64), 0)
            } else {
                (-(before.as_secs() as i64) - 1, 1_000_000_000 - nanos)
            }
        }
    }
}

/// File index numbers need a handle per file; the creation time tells a replaced file or directory apart instead.
// 只用创建时间构造一个兜底身份 (0, creation_time)：
// 真正的文件索引需要打开句柄，所以主路径使用下面的 path_identity；
// 这个函数供无法打开路径时回退，也用于 Windows 上不需要打开句柄的简单比较。
pub fn identity(metadata: &Metadata) -> (u64, u64) {
    use std::os::windows::fs::MetadataExt;
    (0, metadata.creation_time())
}

/// Node's `os.tmpdir()` on Windows.
// 复现 Node 的 os.tmpdir()：优先 TEMP，其次 TMP，最后 %SystemRoot%\temp
// （SystemRoot 缺失时再试 windir）。
// 例：TEMP=C:\Users\me\AppData\Local\Temp\ 得到去掉末尾反斜杠的同一路径；
// 但 "C:\" 这种盘根保留原样。
pub fn tmpdir() -> String {
    // 小闭包统一“读取环境变量并过滤空值”的规则，避免重复写 ok/filter。
    let variable = |key: &str| std::env::var(key).ok().filter(|value| !value.is_empty());
    // or_else 只在前面为 None 时尝试下一个变量；都缺失时用 SystemRoot/windir 拼默认目录。
    let mut path = variable("TEMP")
        .or_else(|| variable("TMP"))
        .unwrap_or_else(|| {
            format!(
                "{}\\temp",
                variable("SystemRoot")
                    .or_else(|| variable("windir"))
                    .unwrap_or_default()
            )
        });
    // 去掉一个结尾反斜杠，但 "C:\" 是盘根，不能变成 "C:"；
    // len() > 1 同时避免把单个 "\" 删成空字符串。
    if path.len() > 1 && path.ends_with('\\') && !path.ends_with(":\\") {
        path.pop();
    }
    path
}

/// libuv's `uv_os_homedir`: `USERPROFILE` first.
// Node 的 os.homedir() 在 Windows 上优先 USERPROFILE；未设置时返回空字符串，
// 保证 hello 响应里的 home 字段始终是字符串。
pub fn home() -> String {
    std::env::var("USERPROFILE").unwrap_or_default()
}

/// A NUL-terminated wide path; an embedded NUL fails like the standard library's path conversion (Node rejects such
/// paths before any system call, which the client reports with the same code).
// 把 Rust 字符串转成 Win32 需要的 NUL 结尾 UTF-16 缓冲区。
// 输入含内嵌 NUL 时返回 InvalidInput：系统调用无法表示这种路径，Node 也会在调用前拒绝。
// 例：wide("C:\\tmp") 返回宽字符序列，最后一个元素是 0。
fn wide(text: &str) -> io::Result<Vec<u16>> {
    // contains('\0') 是运行时检查：Rust String 可以包含 NUL，但 C 风格 API 不能。
    if text.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains a NUL byte",
        ));
    }
    // encode_wide 生成 UTF-16 单元；chain(std::iter::once(0)) 在末尾补一个 0；
    // collect 把迭代器收集成 Vec<u16>，交给 CreateFileW 等 API。
    Ok(OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect())
}

/// libuv's `fs__mkdtemp`: `prefix` plus six characters from `[a-zA-Z0-9]`, retried while the name exists.
// libuv 的 fs__mkdtemp：prefix 后接 6 个 [a-zA-Z0-9] 字符，遇到已存在的名字就重试。
// 最多尝试 1000 次；成功返回创建的路径，重试耗尽后返回 EEXIST(80)。
// 例：mkdtemp("C:\\Temp\\pi-") 可能得到 "C:\\Temp\\pi-aB3dE9"。
// 副作用：真实创建目录。
pub fn mkdtemp(prefix: &str) -> io::Result<String> {
    // 字符表是字节切片字面量 b"..."；随机数的模运算保证下标总在表内。
    const CHARACTERS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    // 进程内计数器让同一随机种子下的连续调用也产生不同序列。
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    // RandomState 从系统取得随机种子；用它构造 hasher 生成候选名字。
    let state = RandomState::new();
    // 下划线表示循环变量不使用；固定上限避免目录里名字耗尽时无限循环。
    for _ in 0..1000 {
        let mut hasher = state.build_hasher();
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        // 每次尝试取一个 64 位随机值；下面用连续的 %/除法提取 6 个字符，
        // 相当于以 62 为基数生成 6 位名字。
        let mut random = hasher.finish();
        let mut path = prefix.to_string();
        // 每个字符从当前 random 的低位取出，再把 random 除以 62 继续取下一轮。
        for _ in 0..6 {
            path.push(CHARACTERS[(random % CHARACTERS.len() as u64) as usize] as char);
            random /= CHARACTERS.len() as u64;
        }
        // 只有创建成功才返回；AlreadyExists 表示名字撞车，继续下一轮；
        // 其他错误（权限、路径非法）直接返回，重试也不会改变。
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::from_raw_os_error(80))
}

/// Windows cannot open a directory as a file and has no `O_NOFOLLOW`: check the path first, as `NodeExecutionEnv` does
/// there (not race-free).
// Windows 无法把目录当文件打开，也没有 O_NOFOLLOW，所以先检查路径，再普通打开。
// no_follow=true 时用 symlink_metadata 检查最终组件是否为符号链接，命中返回 SYMLINK；
// 目录返回 EISDIR（与 Node 的 read 一致）；其余错误交给 Failure::io。
// 例：open_reader("C:\\link", true) 对符号链接返回 SYMLINK。
// 注意：检查和打开之间路径可能被替换，因此这不是无竞态的保证，只是与 Node 在 Windows 上的行为对齐。
pub fn open_reader(path: &str, no_follow: bool) -> Result<File, Failure> {
    if no_follow
        && std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(Failure::new("SYMLINK", "Refusing to follow a symbolic link").path(path));
    }
    // metadata 跟随链接；目录会被 Win32 打开为句柄，但 Node 的读取语义要求 EISDIR，
    // 所以这里提前给出与 Unix 一致的错误。
    if std::fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(
            Failure::new("EISDIR", "EISDIR: illegal operation on a directory, read").path(path),
        );
    }
    File::open(path).map_err(|error| Failure::io(&error, "open", path))
}

/// libuv's `fs__open` for Node's write modes: `CreateFileW` with its access, sharing and disposition, always with
/// `FILE_FLAG_BACKUP_SEMANTICS`, so a directory opens and later calls on it fail as in Node; creating a file where a
/// directory exists reports `EISDIR`. (Rust's `File::create` opens with `OPEN_ALWAYS` and truncates afterwards.)
// libuv 的 fs__open：用 CreateFileW 精确控制访问权和 disposition。
// Read/ReadWrite 要求文件已存在（OPEN_EXISTING）；Write 创建或截断（CREATE_ALWAYS）；
// Append 创建或保留内容（OPEN_ALWAYS），并只授予 FILE_APPEND_DATA 而非普通写。
// 固定 FILE_FLAG_BACKUP_SEMANTICS，使目录也能打开，后续操作再按 Node 报错。
// 例：open("C:\\tmp\\x", OpenMode::Write) 创建/清空文件；目录已存在时得到 EISDIR。
pub fn open(path: &str, mode: OpenMode) -> io::Result<File> {
    // 元组解构：每个模式映射成 (访问掩码, disposition) 两个 CreateFileW 参数。
    let (access, disposition) = match mode {
        OpenMode::Read => (FILE_GENERIC_READ, OPEN_EXISTING),
        OpenMode::Write => (FILE_GENERIC_WRITE, CREATE_ALWAYS),
        OpenMode::Append => (
            (FILE_GENERIC_WRITE & !FILE_WRITE_DATA) | FILE_APPEND_DATA,
            OPEN_ALWAYS,
        ),
        OpenMode::ReadWrite => (FILE_GENERIC_READ | FILE_GENERIC_WRITE, OPEN_EXISTING),
    };
    // ? 把字符串转换错误（内嵌 NUL）直接返回；成功得到 NUL 结尾的 UTF-16 缓冲。
    let name = wide(path)?;
    // SAFETY: a NUL-terminated wide path; the returned handle is owned by the File on success.
    // CreateFileW 的参数依次是：宽路径、访问权、共享模式、安全属性、
    // disposition、flags/attributes、模板句柄。共享读写删让其他进程也能访问。
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            disposition,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    // Win32 用 INVALID_HANDLE_VALUE 表示失败；last_os_error 读取 GetLastError。
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        // ERROR_FILE_EXISTS while creating means the path is a directory.
        // ERROR_FILE_EXISTS(80) 在创建模式下通常意味着同名目录已存在；
        // libuv 把它翻译成 EISDIR。matches! 只在两个创建模式下生效，
        // 因为只读/读写模式返回 80 的含义不同。
        if error.raw_os_error() == Some(80) && matches!(mode, OpenMode::Write | OpenMode::Append) {
            return Err(synthetic("EISDIR"));
        }
        return Err(error);
    }
    // SAFETY: `handle` is a valid, owned file handle.
    // from_raw_handle 接管句柄所有权；as _ 把 HANDLE(isize) 转成 RawHandle。
    // 此后 File 的 Drop 会调用 CloseHandle，避免泄漏。
    Ok(unsafe { File::from_raw_handle(handle as _) })
}

/// libuv's `uv_fs_realpath`: the final path without the `\\?\` prefix.
// libuv 的 uv_fs_realpath：canonicalize 后去掉 Win32 的 "\\?\" 前缀，
// 这样返回的路径与 Node 的 fs.realpath 一致。UNC 路径 "\\?\UNC\server\share"
// 会还原成 "\\server\share"。
// 例：canonicalize 得到 "\\?\C:\tmp\x"，返回 "C:\tmp\x"。
pub fn realpath(path: &str) -> io::Result<String> {
    let resolved = std::fs::canonicalize(path)?.to_string_lossy().into_owned();
    Ok(if let Some(unc) = resolved.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        resolved
            .strip_prefix("\\\\?\\")
            .map(str::to_string)
            .unwrap_or(resolved)
    })
}

/// libuv's `fs__rename`: `MoveFileExW` replacing an existing destination.
// libuv 的 fs__rename：MoveFileExW + MOVEFILE_REPLACE_EXISTING。
// 目标存在时会被替换；两个路径都先转成 NUL 结尾宽字符串。
pub fn rename(from: &str, to: &str) -> io::Result<()> {
    let (from, to) = (wide(from)?, wide(to)?);
    // SAFETY: both arguments are NUL-terminated wide strings that outlive the call.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Node's `rm` on Windows: a symbolic link or junction to a directory is removed as a directory entry (libuv's
/// `fs__unlink`), and a read-only file is retried after making it writable.
// 复刻 Node 在 Windows 上的 rm：指向目录的符号链接/junction 用 remove_dir 删除目录项本身；
// 普通文件遇到 PermissionDenied 时，先清掉只读属性再重试一次。
// 例：删除只读文件成功；删除目录 junction 只移除链接，不删除目标内容。
pub fn remove_file(path: &str) -> io::Result<()> {
    use std::os::windows::fs::FileTypeExt;
    // symlink_metadata 不跟随链接；is_symlink_dir 是 Windows 扩展，识别目录符号链接和 junction。
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink_dir()) {
        return std::fs::remove_dir(path);
    }
    match std::fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            let mut permissions = std::fs::metadata(path)?.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            std::fs::set_permissions(path, permissions)?;
            std::fs::remove_file(path)
        }
        other => other,
    }
}

/// The daemon's end of a child pipe. The standard library opens it for overlapped I/O, so a blocked read or write can only
/// be cancelled with `CancelIoEx`, not `CancelSynchronousIo`; readers and writers issue their own overlapped operations
/// and wait for them 100 ms at a time instead, like the Unix side's `poll`.
// 读管道需要 AsRawHandle 才能构造 OVERLAPPED 操作；Read 由 std 的 File/ChildStdout 提供，
// 但本文件的 read_pipe 直接用 Win32 ReadFile，所以这里只约束句柄。
pub trait Pipe: AsRawHandle {}
impl<T: AsRawHandle> Pipe for T {}

/// The writing end, as `Pipe`.
// 写管道的对应约束；与 Pipe 一样是空标记 trait，配合 blanket impl 覆盖标准类型。
pub trait WritePipe: AsRawHandle {}
impl<T: AsRawHandle> WritePipe for T {}

/// How long one wait for an overlapped operation lasts before `stop` is looked at again.
// 每次等待 overlapped 操作最多 100ms，然后重新检查 stop；
// 与 Unix 侧 poll 的 100ms 周期保持一致，使取消能在约 100ms 内生效。
const STOP_POLL_MS: u32 = 100;

/// Overlapped operations on one pipe handle, each completed or cancelled by the thread that started it, so nothing is
/// left pending on a buffer that goes away.
// 一个管道上的重叠 I/O 状态：原始句柄 + 手动重置事件。
// 注释（上方英文）说明了为什么不用 CancelSynchronousIo：标准库把管道打开为重叠模式，
// 同步读取无法可靠取消，因此每个操作都自带 OVERLAPPED 和取消路径。
struct Overlapped {
    handle: HANDLE,
    event: OwnedHandle,
}

impl Overlapped {
    // 为管道创建重叠 I/O 所需的事件对象。
    // CreateEventW 参数：安全属性 null、手动重置 TRUE、初值 FALSE、名字 null。
    // 事件句柄立即交给 OwnedHandle，函数返回或出错时自动关闭。
    fn new(pipe: &impl AsRawHandle) -> io::Result<Overlapped> {
        // SAFETY: a manual-reset, unnamed event; ReadFile and WriteFile reset it when they start.
        let event = unsafe { CreateEventW(std::ptr::null(), TRUE, FALSE, std::ptr::null()) };
        if event.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Overlapped {
            handle: pipe.as_raw_handle() as HANDLE,
            // SAFETY: the event created above, owned from here on.
            event: unsafe { OwnedHandle::from_raw_handle(event as _) },
        })
    }

    /// Run one operation `start` begins with the `OVERLAPPED` it is given; the bytes it transferred, or `None` once
    /// `stop` was set while it waited, after cancelling it.
    // 执行一次重叠操作：start 闭包发起 ReadFile/WriteFile，本函数负责等待、取消和取结果。
    // 返回 Ok(Some(bytes)) 表示完成，Ok(None) 表示等待期间 stop 被置位且操作已取消，
    // Err 表示等待失败或操作失败。所有路径都保证操作在返回前完成/取消，缓冲区可以安全释放。
    // 例：read_pipe 用它在 64 KiB 缓冲区上发起 ReadFile，并每 100ms 检查停止标记。
    fn run(
        &self,
        stop: &AtomicBool,
        start: impl FnOnce(*mut OVERLAPPED) -> BOOL,
    ) -> io::Result<Option<u32>> {
        // SAFETY: a zeroed OVERLAPPED is valid; only its event is set.
        // OVERLAPPED 必须先清零，再只填 hEvent；其余字段由系统使用。
        // zeroed 对 POD 结构是安全的，但属于 unsafe，需要程序员保证全零是合法初值。
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = self.event.as_raw_handle() as HANDLE;
        // Win32 返回 FALSE 不一定是失败：ERROR_IO_PENDING 表示操作已排队，
        // 稍后用事件等待完成；其他错误码才是真正失败。
        if start(&mut overlapped) == FALSE {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                return Err(error);
            }
        }
        // 轮询等待事件：每次最多 STOP_POLL_MS，超时就检查 stop 并继续。
        loop {
            // SAFETY: the event outlives the wait.
            // 等待事件被 ReadFile/WriteFile 完成时置位；WAIT_OBJECT_0 表示已完成。
            let waited = unsafe { WaitForSingleObject(overlapped.hEvent, STOP_POLL_MS) };
            // 完成：GetOverlappedResult(..., wait=FALSE) 取传输字节数；
            // 该调用此时不会阻塞，因为事件已经就绪。
            if waited == WAIT_OBJECT_0 {
                return self.result(&overlapped, FALSE).map(Some);
            }
            // 只是超时且没有要求停止：继续等下一轮，不取消操作。
            if waited == WAIT_TIMEOUT && !stop.load(Ordering::SeqCst) {
                continue;
            }
            // 走到这里要么 stop 已置位（超时分支），要么 WaitForSingleObject 出错。
            // then 只在条件为 true 时求值 last_os_error，避免把超时误报成错误；
            // 之后无论哪种情况都要取消操作并等它收尾。
            let failure = (waited != WAIT_TIMEOUT).then(io::Error::last_os_error);
            // SAFETY: cancels only this operation, then waits for it to finish before `overlapped` and the caller's
            // buffer go away.
            // CancelIoEx 只取消这一个 OVERLAPPED，不影响同一句柄上的其他操作；
            // 随后 GetOverlappedResult(..., wait=TRUE) 等待内核真正结束，
            // 确保调用方的缓冲区在函数返回后不会再被写入。
            unsafe { CancelIoEx(self.handle, &overlapped) };
            let _ = self.result(&overlapped, TRUE);
            return failure.map_or(Ok(None), Err);
        }
    }

    // 读取重叠操作的结果：wait=TRUE 时等待操作结束，wait=FALSE 时只取已完成的结果。
    // 失败时把 GetLastError 转成 io::Error；成功返回本次传输的字节数。
    fn result(&self, overlapped: &OVERLAPPED, wait: BOOL) -> io::Result<u32> {
        let mut transferred = 0u32;
        // SAFETY: the OVERLAPPED of an operation started on this handle.
        if unsafe { GetOverlappedResult(self.handle, overlapped, &mut transferred, wait) } == FALSE
        {
            return Err(io::Error::last_os_error());
        }
        Ok(transferred)
    }
}

/// Read `pipe` until it ends, `on_data` returns false, or `stop` is set (looked at every 100 ms, also while no output
/// arrives); the pipe closes when this returns.
// 读取管道直到 EOF、on_data 返回 false，或 stop 被置位；pipe 在返回时关闭。
// 与 Unix 的 read_pipe 语义相同，但用 overlapped ReadFile 实现，使 100ms 的取消检查成为可能。
// 例：read_pipe(stdout, &stop, |bytes| { tx.send(bytes.to_vec()); true }) 转发输出。
pub fn read_pipe(pipe: impl Pipe, stop: &AtomicBool, mut on_data: impl FnMut(&[u8]) -> bool) {
    // 创建事件失败时无法安全读取，直接返回；上层会在命令结束时看到管道关闭。
    let Ok(io) = Overlapped::new(&pipe) else {
        return;
    };
    let mut buffer = vec![0u8; 64 * 1024];
    // 每轮发起一次 ReadFile；停止标记在等待过程中也会被检查（见 Overlapped::run）。
    while !stop.load(Ordering::SeqCst) {
        // 闭包在 unsafe 块里调用 ReadFile：缓冲区是 64 KiB，长度为 u32；
        // hEvent 由 run 填好，ReadFile 完成时置位。
        let read = io.run(stop, |overlapped| {
            // SAFETY: the buffer outlives the operation, which `run` completes or cancels before returning.
            unsafe {
                ReadFile(
                    io.handle,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    std::ptr::null_mut(),
                    overlapped,
                )
            }
        });
        // A broken pipe (every writer closed) is the end, as for the standard library's reads.
        // 成功且读到正数字节才回调；0 表示对端关闭，Ok(None)（取消）和 Err 都直接结束。
        match read {
            Ok(Some(read)) if read > 0 => {
                if !on_data(&buffer[..read as usize]) {
                    return;
                }
            }
            _ => return,
        }
    }
}

/// Write all of `bytes`, waiting while the program does not read; false once the pipe is closed or `stop` is set
/// (looked at every 100 ms, also while the write waits).
// 把 bytes 全部写入管道；返回是否写完。管道关闭或 stop 置位时返回 false。
// 每次 WriteFile 最多表达 u32::MAX 字节，因此先截断长度；短写后移动切片继续。
// 例：write_pipe(&mut stdin, payload, &stop) 把协议数据送进子进程。
pub fn write_pipe(pipe: &mut impl WritePipe, mut bytes: &[u8], stop: &AtomicBool) -> bool {
    let Ok(io) = Overlapped::new(pipe) else {
        return false;
    };
    while !bytes.is_empty() {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        // Win32 的 nNumberOfBytesToWrite 是 u32；min 防止超长切片截断成错误值，
        // as 转换在 min 之后是安全的。
        let length = bytes.len().min(u32::MAX as usize) as u32;
        // 闭包发起 WriteFile；与读一样，操作由 run 等待/取消后才返回。
        let written = io.run(stop, |overlapped| {
            // SAFETY: `bytes` outlives the operation, which `run` completes or cancels before returning.
            unsafe {
                WriteFile(
                    io.handle,
                    bytes.as_ptr(),
                    length,
                    std::ptr::null_mut(),
                    overlapped,
                )
            }
        });
        // 部分写入时移动切片继续；0、取消或错误都视为失败。
        match written {
            Ok(Some(written)) if written > 0 => bytes = &bytes[written as usize..],
            _ => return false,
        }
    }
    true
}

/// libuv's `search_path` for an argv command: a name with a directory is tried as given, otherwise the working
/// directory and then each `PATH` entry; a name without an extension also tries `.com` and `.exe`. Node refuses
/// batch files without a shell.
// libuv 的 search_path：决定 argv[0] 最终启动哪个文件。
// 含目录分隔符或盘符的名字按 cwd 解析；否则先在 cwd、再按 PATH 的每个目录查找。
// 名字没有扩展名时依次尝试 .com、.exe；找到 .bat/.cmd 则拒绝（Node 不允许无 shell 启动批处理）。
// 找不到返回 spawn_error，消息形如 "spawn foo ENOENT"。
// 例：PATH 中有 C:\\Windows\\System32，resolve_program("cmd", cwd, env) 找到 cmd.exe。
pub fn resolve_program(
    program: &str,
    cwd: &str,
    env: &Map<String, Value>,
) -> Result<String, Failure> {
    // 闭包捕获 program，按 Node 的 message 形状构造错误；调用处用 ok_or_else 延迟执行。
    let not_found = || Failure::new("spawn_error", format!("spawn {program} ENOENT"));
    // 有扩展名时只尝试原样文件；没有时才补 .com/.exe。这是 libuv 的规则。
    let has_extension = Path::new(program).extension().is_some();
    // 给定基准路径，生成候选列表：先原样（若有扩展名），再 .com、.exe。
    // PathBuf 拥有自己的字符串，便于在迭代器里返回。
    let candidates = |base: &Path| -> Vec<std::path::PathBuf> {
        let mut names = Vec::new();
        if has_extension {
            names.push(base.to_path_buf());
        }
        for extension in ["com", "exe"] {
            let mut name = base.as_os_str().to_owned();
            name.push(".");
            name.push(extension);
            names.push(name.into());
        }
        names
    };
    // 含反斜杠、正斜杠或冒号（盘符）时按路径处理，直接与 cwd 拼接；
    // 否则按 PATH 搜索。to_path_buf 复制 Path 为拥有型。
    let found = if program.contains(['\\', '/', ':']) {
        candidates(&Path::new(cwd).join(program))
            .into_iter()
            .find(|path| path.is_file())
    } else {
        // 环境对象里的 PATH 大小写不敏感；找不到时退回 daemon 自己的 PATH。
        // unwrap_or_default 保证 split_paths 总能拿到字符串（空串表示没有目录）。
        let path_variable = env
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
            .and_then(|(_, value)| value.as_str().map(str::to_string))
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_default();
        std::iter::once(std::path::PathBuf::from(cwd))
            .chain(std::env::split_paths(&path_variable))
            .flat_map(|directory| candidates(&directory.join(program)))
            .find(|path| path.is_file())
    };
    // Option -> Result：None 时执行 not_found 闭包，Some 时取出路径。
    let found = found.ok_or_else(not_found)?;
    let lower = found.to_string_lossy().to_lowercase();
    // 即使文件存在，批处理也不能直接启动（需要 cmd.exe 解释）；
    // Node 用 EINVAL 表示这种拒绝。
    if lower.ends_with(".bat") || lower.ends_with(".cmd") {
        return Err(Failure::new(
            "spawn_error",
            format!("spawn {program} EINVAL"),
        ));
    }
    Ok(found.to_string_lossy().into_owned())
}

/// Node's `isLegacyWslBashPath`: `^[a-z]:\\windows\\(system32|sysnative)\\bash\.exe$`, case-insensitive.
// Node 的 isLegacyWslBashPath：识别 C:\\Windows\\System32\\bash.exe 及 Sysnative 变体
// （旧版 WSL 的 bash 需要 -s 从 stdin 读命令）。
// 先统一斜杠方向并转小写，再检查首字符是盘符、剩余部分精确匹配两种路径。
// 例："C:/Windows/System32/bash.exe" 返回 true。
fn is_legacy_wsl_bash(path: &str) -> bool {
    let normalized = path.replace('/', "\\").to_lowercase();
    let mut characters = normalized.chars();
    characters
        .next()
        .is_some_and(|drive| drive.is_ascii_lowercase())
        && matches!(
            characters.as_str(),
            ":\\windows\\system32\\bash.exe" | ":\\windows\\sysnative\\bash.exe"
        )
}

// 根据 bash 类型选择参数：旧版 WSL 用 ["-s"] 并把命令写入 stdin；
// 其他 bash 用 ["-c"] 并把命令作为参数。
fn bash_config(program: &str) -> ShellConfig {
    if is_legacy_wsl_bash(program) {
        ShellConfig {
            program: program.into(),
            args: vec!["-s".into()],
            command_on_stdin: true,
        }
    } else {
        ShellConfig {
            program: program.into(),
            args: vec!["-c".into()],
            command_on_stdin: false,
        }
    }
}

// 用 `where bash.exe` 在 PATH 中查找 Git Bash/Cygwin/MSYS2 等。
// CREATE_NO_WINDOW 避免弹出控制台窗口；只取第一行并确认路径存在。
// 例：安装了 Git for Windows 且 bin 在 PATH 时返回 bash.exe 的完整路径。
fn where_bash() -> Option<String> {
    let output = Command::new("where")
        .arg("bash.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let first = String::from_utf8_lossy(&output.stdout)
        .trim()
        .lines()
        .next()?
        .trim()
        .to_string();
    path_exists(&first).then_some(first)
}

/// Node's shell resolution on Windows: a configured shell, Git Bash, `where bash.exe`, or `shell_unavailable`.
// Node 在 Windows 上的 shell 选择：显式 shellPath；否则 Git for Windows 的默认安装位置；
// 否则 `where bash.exe`；都找不到时返回 shell_unavailable，并列出搜索过的路径。
// 例：未配置 shellPath、Program Files 下有 Git 时，返回 Git 的 bash.exe 配置。
// 与 Unix 不同，这里没有 /bin/sh 兜底：函数字符串命令必须有 bash。
pub fn shell_config(shell_path: Option<&str>) -> Result<ShellConfig, Failure> {
    if let Some(configured) = shell_path {
        if path_exists(configured) {
            return Ok(bash_config(configured));
        }
        return Err(Failure::new(
            "shell_unavailable",
            format!("Custom shell path not found: {configured}"),
        ));
    }
    let mut candidates = Vec::new();
    // 依次检查 64 位和 32 位 Program Files；环境变量不存在时跳过。
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(directory) = std::env::var(variable) {
            candidates.push(format!("{directory}\\Git\\bin\\bash.exe"));
        }
    }
    if let Some(found) = candidates.iter().find(|candidate| path_exists(candidate)) {
        return Ok(bash_config(found));
    }
    // 固定安装位置都没有时，才调用外部 where，避免不必要的子进程。
    if let Some(found) = where_bash() {
        return Ok(bash_config(&found));
    }
    let searched: String = candidates
        .iter()
        .map(|candidate| format!("  {candidate}\n"))
        .collect();
    Err(Failure::new(
        "shell_unavailable",
        format!(
            "No bash shell found. Options:\n  1. Install Git for Windows: https://git-scm.com/download/win\n  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n  3. Configure an explicit shellPath\n\nSearched Git Bash in:\n{}",
            searched.trim_end()
        ),
    ))
}

/// libuv's `quote_cmd_arg`: how one argument is written into the command line the child splits again.
// libuv 的 quote_cmd_arg：把一个参数写成 Windows 命令行里的形式，供子进程再次拆分。
// 规则：空参数写成 ""；不含空格/制表符/引号时原样；不含引号和反斜杠时整体加引号；
// 否则从右往左处理，把引号前的反斜杠加倍并转义引号。
// 例：quote_argument("a b") 返回 "\"a b\""；quote_argument("say \"hi\"") 返回 "\"say \\\"hi\\\"\""。
// 返回的命令行片段由 CreateProcess 解析，不是给 shell 的。
pub fn quote_argument(argument: &str) -> String {
    // 空参数必须显式写成两个引号，否则会在命令行里消失。
    if argument.is_empty() {
        return "\"\"".into();
    }
    // 没有需要保护的特殊字符，原样返回，保持命令行可读。
    if !argument.contains([' ', '\t', '"']) {
        return argument.into();
    }
    // 只有空白、没有引号和反斜杠：整体加一对引号即可。
    if !argument.contains(['"', '\\']) {
        return format!("\"{argument}\"");
    }
    // Walk backwards: backslashes before a quote (or the closing quote) are doubled, and quotes are escaped.
    // 从右往左扫描并构造字符序列，最后再反转；这样“引号前的反斜杠”已经全部可见，
    // 不必预先统计连续反斜杠的个数。
    let mut reversed = Vec::new();
    // quote_hit 表示当前位置是否紧跟在引号（或字符串末尾的收尾引号）之后；
    // 初值 true 让参数末尾的反斜杠也按“引号前”处理，因为它们会紧邻我们补的收尾引号。
    let mut quote_hit = true;
    // 反转迭代按字符处理，避免在多字节 UTF-8 边界切开；每个反斜杠/引号都可能追加两个字符。
    for character in argument.chars().rev() {
        reversed.push(character);
        if quote_hit && character == '\\' {
            reversed.push('\\');
        } else if character == '"' {
            quote_hit = true;
            reversed.push('\\');
        } else {
            quote_hit = false;
        }
    }
    let mut quoted = String::from("\"");
    quoted.extend(reversed.into_iter().rev());
    quoted.push('"');
    quoted
}

/// Variables libuv copies from the parent into every child environment that lacks them.
// libuv 会从父进程补进每个子进程环境的变量。类型 [&str; 11] 表示长度固定为 11 的数组，
// 与下面的常量列表长度一致；少写/多写会在编译期报错。
const REQUIRED_VARIABLES: [&str; 11] = [
    "HOMEDRIVE",
    "HOMEPATH",
    "LOGONSERVER",
    "PATH",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
];

/// The child environment as Node builds it on Windows: the variables in object order, sorted by UTF-16 code units,
/// keeping the first of names that differ only in case; then libuv adds required variables the result lacks.
// 按 Node 在 Windows 上构建子进程环境的顺序：
// 先按对象顺序收集继承的父环境，再用协议 env 覆盖同名项；按 UTF-16 码元排序；
// 大小写不敏感地去重，保留排序后的第一个；最后补上父进程中存在、结果里缺失的必需变量。
// 返回 (键, 值) 列表供 Command::env 逐项设置。
// 例：env={"Path": "C:\\x"} 会覆盖父环境里的 PATH（大小写不同视为同名）。
fn child_environment(env: &Map<String, Value>, inherit_env: bool) -> Vec<(String, String)> {
    let mut entries: Vec<(String, String)> = Vec::new();
    // 闭包 set 找不到同名键就追加，找到就覆盖值；用 iter_mut 原地更新，保持插入顺序。
    let mut set =
        |key: String, value: String| match entries.iter_mut().find(|(name, _)| *name == key) {
            Some(entry) => entry.1 = value,
            None => entries.push((key, value)),
        };
    // inheritEnv 默认 true：先放入 daemon 的全部环境变量，协议 env 稍后覆盖。
    if inherit_env {
        for (key, value) in std::env::vars_os() {
            set(
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            );
        }
    }
    // 协议 env 的值必须是字符串；其他 JSON 类型被跳过（调用方无法用它们设置环境变量）。
    for (key, value) in env {
        if let Some(value) = value.as_str() {
            set(key.clone(), value.to_string());
        }
    }
    // Windows 环境块按 UTF-16 排序；Rust 的 String 是 UTF-8，
    // 所以先 encode_utf16 再用迭代器比较，结果与 Node 的 sort 一致。
    entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    // retain 原地过滤：seen.insert 返回 false 表示大小写折叠后已出现，保留第一个。
    let mut seen = std::collections::HashSet::new();
    entries.retain(|(name, _)| seen.insert(name.to_uppercase()));
    // 只补父环境里确实存在的变量；缺失的不会凭空生成。
    for required in REQUIRED_VARIABLES {
        if !entries
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case(required))
            && let Ok(value) = std::env::var(required)
        {
            entries.push((required.to_string(), value));
        }
    }
    entries
}

/// Arguments quoted as libuv quotes them, Node's environment, and a hidden console.
// 按 libuv 在 Windows 上启动子进程的规则配置 Command：
// 每个参数先用 raw_arg + quote_argument 拼成命令行；环境由 child_environment 重建；
// 加 CREATE_NO_WINDOW 隐藏控制台。不启动进程。
// 例：configure(&mut cmd, &["/c".into(), "echo hi".into()], &env, true)
// 之后 spawn 出的进程不会弹窗，环境与 Node 一致。
pub fn configure(
    command: &mut Command,
    args: &[String],
    env: &Map<String, Value>,
    inherit_env: bool,
) {
    // raw_arg 直接提供已经转义好的命令片段；若用 arg()，标准库会再按自己的规则加引号，
    // 导致双重转义。这里必须用 raw_arg 才能精确匹配 libuv。
    for argument in args {
        command.raw_arg(quote_argument(argument));
    }
    command.env_clear();
    for (key, value) in child_environment(env, inherit_env) {
        command.env(key, value);
    }
    // CREATE_NO_WINDOW 让控制台程序在没有窗口的 daemon 里运行；
    // 这是启动标志，不是控制台窗口大小之类的运行时选项。
    command.creation_flags(CREATE_NO_WINDOW);
}

/// libuv puts every child it starts into one job that ends its processes when the daemon exits.
// libuv 把每个子进程放进同一个 Job object，daemon 退出时由内核统一终止它们。
// 句柄用 OnceLock 只创建一次；Option<isize> 表示创建失败时返回 None（后续不再重试）。
// 返回 isize 而不是 HANDLE，是因为 HANDLE 是指针类型，静态存储需要可跨平台的整数类型。
fn job() -> Option<isize> {
    // OnceLock 提供线程安全的惰性初始化；get_or_init 的闭包只执行一次，其他线程等待结果。
    static JOB: OnceLock<Option<isize>> = OnceLock::new();
    *JOB.get_or_init(|| {
        // SAFETY: plain Win32 calls with a zeroed, correctly sized information struct.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            // 限制标志：
            // BREAKAWAY_OK / SILENT_BREAKAWAY_OK 允许子进程主动离开 Job；
            // DIE_ON_UNHANDLED_EXCEPTION 让未处理异常终止进程；
            // KILL_ON_JOB_CLOSE 保证最后一个 Job 句柄关闭（daemon 退出）时杀死成员。
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK
                | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK
                | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
                | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            Some(job as isize)
        }
    })
}

// 把刚启动的子进程加入共享 Job object。
// 调用方必须在 spawn 成功后立即调用；失败被忽略，因为此时进程已经运行，
// 没有安全的回滚方式，进程仍可正常工作，只是失去 daemon 退出时的自动清理。
pub fn after_spawn(child: &Child) {
    if let Some(job) = job() {
        // SAFETY: both handles are valid for the duration of the call.
        unsafe {
            AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
        }
    }
}

/// Nothing to do: the daemon cannot catch `TerminateProcess`. When it ends, the job object kills each command's own
/// process; processes those start leave the job (silent breakaway, as in libuv) and keep running.
// Windows 上 daemon 无法捕获 TerminateProcess，因此没有信号处理可安装。
// 退出清理依赖 Job object：daemon 结束时 KILL_ON_JOB_CLOSE 杀死每个命令自己的进程；
// 命令再启动的后代因 silent breakaway 已离开 Job，会继续运行（与 libuv 行为一致）。
// 参数用下划线表示有意忽略，签名仍需与 Unix 版本一致。
pub fn on_exit_signal(_on_signal: impl FnOnce(i32) + Send + 'static) {}

/// Node's `killProcessTree` on Windows: `taskkill /F /T`, not waited for.
// Node 的 killProcessTree 在 Windows 上调用 `taskkill /F /T /PID`，这里同样不等待其完成。
// /T 递归结束子进程树，/F 强制终止；taskkill 通过 SystemRoot 定位，找不到时用 C:\\Windows 兜底。
// 例：kill_tree(1234) 启动 taskkill.exe /F /T /PID 1234，并让它在后台运行。
pub fn kill_tree(pid: u32) {
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let _ = Command::new(format!("{system_root}\\System32\\taskkill.exe"))
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/// Exit codes are unsigned 32-bit values on Windows (an access violation is 3221225477).
// Windows 的退出码是 32 位无符号值（例如访问冲突为 3221225477）。
// code() 返回 i32，先 as u32 再转 i64，避免把高位为 1 的值显示成负数。
// 没有退出码（极少见）时按 1 处理。
pub fn exit_code(status: ExitStatus) -> i64 {
    i64::from(status.code().unwrap_or(1) as u32)
}

/// Windows listings keep the file system's order; nothing sorts by raw names.
// Windows 目录列表保持文件系统返回的顺序，Node 不再按原始名字排序，
// 因此这里返回 None，表示调用方不需要保存额外排序键。
pub fn raw_name(_name: &OsStr) -> Option<Vec<u8>> {
    None
}

/// The per-drive working directories of the `=C:` variables, which Node's `path.resolve` uses for drive-relative paths.
// 收集 Windows 的每盘工作目录变量，形如 "=C:=C:\\work"。
// path.resolve 处理 "C:file" 这类相对盘符路径时需要它。
// 只接受键长度正好 3 且形如 "=X:" 的变量；键 "C" 大写后作为 JSON 字段名。
// 例：环境里有 "=D:=D:\\proj" 时返回 {"D": "D:\\proj"}。
pub fn drive_cwds() -> Map<String, Value> {
    std::env::vars_os()
        .filter_map(|(key, value)| {
            let key = key.to_str()?;
            let bytes = key.as_bytes();
            (bytes.len() == 3
                && bytes[0] == b'='
                && bytes[1].is_ascii_alphabetic()
                && bytes[2] == b':')
                .then(|| {
                    (
                        key[1..].to_ascii_uppercase(),
                        Value::String(value.to_string_lossy().into_owned()),
                    )
                })
        })
        .collect()
}

/// libuv's `scandir` and `opendir` report a file as `ENOTDIR` (elsewhere `ERROR_DIRECTORY` is `ENOENT`).
// 打开目录；libuv 的 scandir/opendir 在 Windows 上把 ERROR_DIRECTORY(267)
// 报成 ENOTDIR（而在其他路径上 267 通常翻成 ENOENT）。
// 这里用 synthetic 覆盖错误码，其余错误保持原样。
pub fn read_dir(path: &str) -> io::Result<std::fs::ReadDir> {
    std::fs::read_dir(path).map_err(|error| {
        if error.raw_os_error() == Some(267) {
            synthetic("ENOTDIR")
        } else {
            error
        }
    })
}

/// Volume serial number and file index of `path`, as libuv's `stat` reports `dev` and `ino`: the creation time is not
/// enough, because NTFS gives a file created under a recently removed name the old one's creation time ("tunneling").
/// Opens a handle, like libuv; falls back to the metadata when the path cannot be opened.
// 返回卷序列号 + 文件索引，作为 libuv stat 的 dev/ino。
// 不能只用创建时间：NTFS 的“隧道”机制会让在最近删除的同名文件后新建的文件继承旧创建时间。
// 实现上像 libuv 一样打开句柄查询；路径无法打开时回退到 identity(metadata)。
// follow=false 时加 FILE_FLAG_OPEN_REPARSE_POINT，查询链接本身而不是目标。
// 例：同一文件重命名后 dev/ino 不变，可被 watch.rs 识别为未替换。
pub fn path_identity(path: &str, metadata: &Metadata, follow: bool) -> (u64, u64) {
    let Ok(name) = wide(path) else {
        return identity(metadata);
    };
    // BACKUP_SEMANTICS 允许打开目录；follow 为 false 时再叠加 OPEN_REPARSE_POINT。
    // 条件表达式产生 0 或标志位，再用 | 合并。
    let flags = FILE_FLAG_BACKUP_SEMANTICS
        | if follow {
            0
        } else {
            FILE_FLAG_OPEN_REPARSE_POINT
        };
    // SAFETY: a NUL-terminated wide path; the handle is closed below.
    // 访问权为 0，只要拿到元数据；共享读写删避免影响其他进程。
    // OPEN_EXISTING 要求路径已经存在；失败时走下面的回退。
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            flags,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return identity(metadata);
    }
    // SAFETY: a valid handle and a zeroed buffer for the call to fill.
    // 系统填充的元数据结构，必须先清零；GetFileInformationByHandle 返回 0 表示失败。
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let found = unsafe { GetFileInformationByHandle(handle, &mut information) } != 0;
    // SAFETY: the handle opened above.
    // 查询完立即关闭句柄，避免路径身份检查泄漏句柄。
    unsafe { CloseHandle(handle) };
    if !found {
        return identity(metadata);
    }
    // 文件索引是 64 位：低 32 位和高 32 位分别存放，必须移位合并；
    // 卷序列号本身只有 32 位，用 u64::from 无损扩展。
    (
        u64::from(information.dwVolumeSerialNumber),
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    )
}

// 测试模块只在 cargo test 构建中编译；下面的用例只验证纯函数 quote_argument，
// 不启动进程，也不访问文件系统。
#[cfg(test)]
mod tests {
    use super::quote_argument;

    // 逐条对照 libuv 的 quote_cmd_arg：空串、普通串、含空格、通配符、引号、
    // 末尾反斜杠和连续反斜杠，确保 Windows 命令行拆分后仍是原参数。
    #[test]
    fn quotes_arguments_like_libuv() {
        assert_eq!(quote_argument(""), "\"\"");
        assert_eq!(quote_argument("plain"), "plain");
        assert_eq!(quote_argument("a b"), "\"a b\"");
        assert_eq!(quote_argument("*.txt"), "*.txt");
        assert_eq!(quote_argument("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(
            quote_argument("C:\\dir with space\\"),
            "\"C:\\dir with space\\\\\""
        );
        assert_eq!(quote_argument("a\\\\b c"), "\"a\\\\b c\"");
    }
}
