//! Linux, macOS and Android.
//!
//! 所属模块：packages/env/daemon/src/sys/unix.rs，sys 层的 Unix 实现（Linux、macOS、Android）。
//! 上游：sys/mod.rs 用 cfg(unix) 导出本文件；fs.rs、exec.rs、main.rs、process.rs、pty.rs、
//! watch.rs、errors.rs 只调用 sys::...；本文件再调用 libc 与 std::os::unix 的扩展 trait。
//!
//! 职责边界：把 Node/libuv 在 Unix 上的行为逐个落成系统调用：错误码翻译、定位读、临时目录、
//! mkdtemp、按 Node 模式打开文件、可被 stop 打断的管道读写、shell 解析、子进程会话与信号设置、
//! 结束进程组、退出码换算。协议 JSON 解析和 Failure 文案组装不在本文件。
//!
//! 能力清单（按导出项）：
//! - os_error_name：把 errno 翻成 libuv 错误名（ENOENT 等）。
//! - PATH_SEPARATOR：Unix 路径分隔符 "/"。
//! - read_at / mtime / identity：定位读与快照所需的元数据。
//! - tmpdir / home：Node 的 os.tmpdir()/os.homedir() 规则。
//! - mkdtemp：按 mkdtemp(3) 创建临时目录。
//! - open_reader / open：openBinaryReader 与 Node 写模式。
//! - realpath / rename / remove_file / read_dir：文件系统操作。
//! - Pipe / read_pipe、WritePipe / write_pipe：每 100ms 检查 stop 的管道读写。
//! - resolve_program / shell_config / configure / after_spawn：命令解析与启动配置。
//! - on_exit_signal / kill_tree / exit_code：信号、进程组与退出码。
//! - raw_name / drive_cwds / path_identity：目录排序、Windows 专用占位、路径身份。
//!
//! 典型调用（示例）：
//!     let file = sys::open("/tmp/a", sys::OpenMode::Append)?;   // fs.rs 的 appendFile
//!     let config = sys::shell_config(Some("/bin/bash"))?;       // exec.rs 的字符串命令
//!     sys::configure(&mut command, &args, &env, true);          // 启动前设置
//!
//! 建议阅读顺序：先看 os_error_name、open 系列和 read_pipe/write_pipe，理解系统调用边界；
//! 再看 shell_config/configure/on_exit_signal，理解进程启动与信号；最后看 tmpdir 等小工具。

use super::{OpenMode, ShellConfig, path_exists};
use crate::errors::Failure;
use serde_json::{Map, Value};
use std::ffi::{CString, OsStr};
use std::fs::{File, Metadata, OpenOptions};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

/// libuv's name for an OS error.
// 把 io::Error 里的原始 errno 转成 libuv 使用的错误名。
// 输入只读错误值，输出 &'static str，无副作用；没有 raw_os_error（例如 std 自己构造的错误）返回 "UNKNOWN"。
// match 逐个列出 Node 会暴露的 errno；未列出的也归为 "UNKNOWN"，不猜测名称。
// 例：打开不存在的文件得到 "ENOENT"；权限不足得到 "EACCES"。
pub fn os_error_name(error: &io::Error) -> &'static str {
    // let-else：raw_os_error() 返回 Option<i32>，Some 时把值绑定到 errno；
    // None 时执行 else 块提前 return，因此后面的 match 里 errno 一定是 i32。
    let Some(errno) = error.raw_os_error() else {
        return "UNKNOWN";
    };
    match errno {
        libc::EPERM => "EPERM",
        libc::ENOENT => "ENOENT",
        libc::EIO => "EIO",
        libc::EBADF => "EBADF",
        libc::EAGAIN => "EAGAIN",
        libc::ENOMEM => "ENOMEM",
        libc::EACCES => "EACCES",
        libc::EBUSY => "EBUSY",
        libc::EEXIST => "EEXIST",
        libc::EXDEV => "EXDEV",
        libc::ENOTDIR => "ENOTDIR",
        libc::EISDIR => "EISDIR",
        libc::EINVAL => "EINVAL",
        libc::ENFILE => "ENFILE",
        libc::EMFILE => "EMFILE",
        libc::ETXTBSY => "ETXTBSY",
        libc::EFBIG => "EFBIG",
        libc::ENOSPC => "ENOSPC",
        libc::EROFS => "EROFS",
        libc::EMLINK => "EMLINK",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::ELOOP => "ELOOP",
        libc::ENOSYS => "ENOSYS",
        libc::ENOTSUP => "ENOTSUP",
        _ => "UNKNOWN",
    }
}

// Unix 的路径分隔符；watch.rs 和 fs.rs 用它判断父子路径，而不是到处硬编码 '/'。
// 常量类型是 &str，指向程序里的静态字符串，不分配内存。
pub const PATH_SEPARATOR: &str = "/";

// 从文件的绝对偏移 offset 读取最多 buffer.len() 字节，返回实际读到的字节数；不移动文件游标。
// 调用 std::os::unix::fs::FileExt::read_at（pread 的包装），因此多个线程可以安全共用一个句柄。
// 例：read_at(&file, &mut buf, 1024) 读取第 1024 字节起的内容；offset 超过文件尾返回 0。
pub fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    file.read_at(buffer, offset)
}

/// Modification time as seconds and nanoseconds since the epoch.
// 返回文件的修改时间：秒和纳秒两个部分。
// MetadataExt::mtime/mtime_nsec 直接暴露 stat 的字段；watch.rs 用它比较快照，
// 调用方不需要处理 SystemTime 的平台差异。
// 例：修改时间为 1_700_000_000.123456789 秒时，得到 (1700000000, 123456789)。
pub fn mtime(metadata: &Metadata) -> (i64, i64) {
    (metadata.mtime(), metadata.mtime_nsec())
}

/// Device and inode, which identify a file across renames.
// 返回 (dev, ino)：设备号加 inode 号，用来识别“同一个文件”，即使它被重命名。
// watch.rs 把目录和祖先按 identity 比较，因此目录里无关兄弟文件的时间变化不会触发误报。
// 例：同一路径先后指向不同 inode 时，即使大小和时间相同，identity 也不同。
pub fn identity(metadata: &Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

/// Node's `os.tmpdir()`; Termux's Node falls back to `$PREFIX/tmp`.
// 复现 Node 的 os.tmpdir()：依次尝试 TMPDIR、TMP、TEMP，跳过未设置或空字符串的值。
// 都没有时：Android/Termux 用 $PREFIX/tmp（缺省 /data/data/com.termux/files/usr/tmp），
// 其他 Unix 用 /tmp。最后去掉多于一个字符的结尾 '/'，但保留根目录 "/"。
// 例：TMPDIR=/var/tmp/ 得到 "/var/tmp"；未设置时通常是 "/tmp"。
pub fn tmpdir() -> String {
    // 数组的 iter() 依次借用三个名字，find_map 返回第一个 Some 结果：
    // env::var 的 ok() 把缺失环境变量变成 None，filter 再去掉空字符串。
    let configured = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|value| !value.is_empty()));
    // unwrap_or_else 只在 None 时执行闭包；闭包返回平台默认目录。
    // cfg!(...) 是编译期常量判断，但展开成 bool，因此 if/else 两个分支都要通过类型检查。
    let mut path = configured.unwrap_or_else(|| {
        if cfg!(target_os = "android") {
            format!(
                "{}/tmp",
                std::env::var("PREFIX")
                    .unwrap_or_else(|_| "/data/data/com.termux/files/usr".into())
            )
        } else {
            "/tmp".into()
        }
    });
    // 只删一个结尾斜杠；len() > 1 保证根目录 "/" 不会被改成空字符串。
    if path.len() > 1 && path.ends_with('/') {
        path.pop();
    }
    path
}

// Node 的 os.homedir() 在 Unix 上读 HOME 环境变量。
// 未设置时返回空字符串，保证 hello 响应里的 home 字段始终是字符串，避免客户端处理 null。
pub fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// `mkdtemp(3)` of `prefix`, as libuv calls it: six random characters from `[A-Za-z0-9]`.
// 复刻 mkdtemp(3)：把 "XXXXXX" 拼到 prefix 后面，由 libc 原地替换成 6 个随机字符并创建目录。
// 输入 prefix 是纯前缀，不检查是否已存在；成功返回创建出的完整路径，失败返回 io::Error。
// 副作用：在文件系统里真实创建一个目录。
// 例：mkdtemp("/tmp/pi-") 可能返回 "/tmp/pi-a1B2c3"（字符随机，不要依赖具体值）。
pub fn mkdtemp(prefix: &str) -> io::Result<String> {
    // libc 的 mkdtemp 要一块可写、以 NUL 结尾的内存：先把前缀复制成 Vec<u8>，
    // 再追加六个 'X'，组成 "prefixXXXXXX" 模板。
    let mut template = prefix.as_bytes().to_vec();
    template.extend_from_slice(b"XXXXXX");
    // CString::new 检查中间是否含 NUL；含 NUL 时映射成 EINVAL，因为系统调用无法表示这种路径。
    let template =
        CString::new(template).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
    // into_bytes_with_nul 取得拥有所有权的 Vec<u8>，末尾保留 C 字符串的 0 字节；
    // mut 绑定是因为 mkdtemp 会原地修改这块缓冲区。
    let mut buffer = template.into_bytes_with_nul();
    // SAFETY: `buffer` is a NUL-terminated, writable template that mkdtemp fills in place.
    // unsafe：调用 C 函数。cast() 把 *mut u8 转成 *mut c_char；
    // 安全性由上一行的注释说明：指针指向可写、以 NUL 结尾的模板。
    let created = unsafe { libc::mkdtemp(buffer.as_mut_ptr().cast()) };
    // C 风格 API 失败时返回空指针；用 last_os_error() 取得当前线程的 errno，
    // 转成 io::Error 后交给上层包装。
    if created.is_null() {
        return Err(io::Error::last_os_error());
    }
    // 成功后 buffer 里是带结尾 0 的路径；pop() 去掉这个 0，避免字符串尾部出现 NUL。
    buffer.pop();
    // OsStr::from_bytes 把 Unix 原始字节当作文件名；to_string_lossy 替换非法 UTF-8，
    // into_owned 让结果不再借用 buffer，可直接返回 String。
    Ok(OsStr::from_bytes(&buffer).to_string_lossy().into_owned())
}

/// Open a regular file for positional reads, without blocking on FIFOs and, with `no_follow`, without following a
/// final symbolic link.
// openBinaryReader 的平台部分：打开普通文件用于定位读。
// 关键点：O_NONBLOCK 让 FIFO 不会卡在 open 上；no_follow=true 时再加 O_NOFOLLOW 拒绝最终符号链接。
// 返回 File 或 Failure；链接相关错误（ELOOP/EMLINK）在 no_follow 下转成 SYMLINK，其他错误交给 Failure::io。
// 例：open_reader("/path/fifo", false) 不会阻塞；open_reader("/path/link", true) 若 link 是符号链接则返回 SYMLINK。
// 注意：目录、非常规文件的类别检查由调用方 fs.rs 在取得 metadata 后完成。
pub fn open_reader(path: &str, no_follow: bool) -> Result<File, Failure> {
    // 先放 O_NONBLOCK；它是位掩码，后续用 |= 追加标志。
    let mut flags = libc::O_NONBLOCK;
    // O_NOFOLLOW 只拒绝“最终一段”是符号链接的情况；中间目录仍可包含链接。
    if no_follow {
        flags |= libc::O_NOFOLLOW;
    }
    // custom_flags 把 libc 标志原样传给 open(2)；Rust 的 read(true) 已包含 O_RDONLY，
    // 额外的 O_NONBLOCK/O_NOFOLLOW 由这里补充。
    OpenOptions::new()
        .read(true)
        .custom_flags(flags)
        .open(path)
        .map_err(|error| {
            if no_follow && matches!(error.raw_os_error(), Some(libc::ELOOP) | Some(libc::EMLINK)) {
                Failure::new("SYMLINK", "Refusing to follow a symbolic link").path(path)
            } else {
                Failure::io(&error, "open", path)
            }
        })
}

/// Open a file in one of Node's write modes.
// 按 Node 的打开方式构造 OpenOptions：
//   Read -> 只读；Write -> 写+创建+截断；Append -> 追加+创建；ReadWrite -> 读写、不创建。
// 返回 io::Result<File>，错误由调用方（fs.rs、main.rs）转成 Failure；这里不区分路径种类。
// 例：open("/tmp/x", OpenMode::Write) 相当于 writeFile 首次打开；
// ReadWrite 供 truncate/fsync 打开现有文件。
pub fn open(path: &str, mode: OpenMode) -> io::Result<File> {
    // 累加式构造：每个 match 分支只设置需要的布尔选项，返回 &mut Self 的方法链。
    let mut options = OpenOptions::new();
    match mode {
        OpenMode::Read => options.read(true),
        OpenMode::Write => options.write(true).create(true).truncate(true),
        OpenMode::Append => options.append(true).create(true),
        OpenMode::ReadWrite => options.read(true).write(true),
    };
    options.open(path)
}

// 等价于 Node 的 fs.realpath：canonicalize 解析符号链接和相对路径，返回绝对路径。
// 非 UTF-8 字节用替换字符表示；路径不存在或被拒绝时返回 io::Error。
// 例：realpath("./a/../b") 得到 b 的绝对规范路径。
pub fn realpath(path: &str) -> io::Result<String> {
    std::fs::canonicalize(path).map(|resolved| resolved.to_string_lossy().into_owned())
}

// 直接调用 std::fs::rename，遵循 Unix 的替换语义：目标存在时原子替换。
// 跨设备移动会失败（EXDEV），这里不做复制回退；fs.rs 会把 from/to 一起放进错误消息。
pub fn rename(from: &str, to: &str) -> io::Result<()> {
    std::fs::rename(from, to)
}

// 删除单个文件；fs.rs 的 rm 已用 lstat 区分目录，因此这里不处理目录。
// 符号链接只会删除链接本身，不会递归到目标。
pub fn remove_file(path: &str) -> io::Result<()> {
    std::fs::remove_file(path)
}

/// A pipe a reader thread can poll, so that it stops when the command settles.
// 给读管道加一个“可轮询文件描述符”的能力约束：read_pipe 需要 Read 取数据，
// 也需要 AsRawFd 才能 poll。trait 本身没有方法，只用于表达类型约束。
pub trait Pipe: io::Read + std::os::fd::AsRawFd {}
// blanket impl：任何同时实现 Read 和 AsRawFd 的类型都自动是 Pipe。
// 于是 File、UnixStream 等标准类型无需手动实现，调用方也不用适配器。
impl<T: io::Read + std::os::fd::AsRawFd> Pipe for T {}

/// Read `pipe` until it ends, `on_data` returns false, or `stop` is set (looked at every 100 ms, also while no output
/// arrives); the pipe closes when this returns.
// 在独立线程里读取管道，直到读到 EOF、on_data 返回 false，或 stop 被置位。
// 输入：任何 Pipe、共享停止标记，以及每收到一块字节就调用的回调；无返回值。
// 副作用：用 fcntl 把 daemon 这一端设为非阻塞，每 100ms 醒来检查一次 stop；函数返回时 pipe 被关闭。
// 主要流程：非阻塞化 -> poll(POLLIN, 100ms) -> 可读则 read -> 回调决定是否继续。
// 例：read_pipe(stdout, &stop, |bytes| { tx.send(bytes.to_vec()); true })
// 会持续转发命令输出。poll 被信号打断则重试；poll 失败或 read 遇到不可恢复错误时直接返回；
// WouldBlock/Interrupted 留到下一轮，读到 0 表示管道结束。
// impl Trait 参数是泛型语法糖：编译器为每个具体类型单态化，静态分发，没有虚表开销。
pub fn read_pipe(mut pipe: impl Pipe, stop: &AtomicBool, mut on_data: impl FnMut(&[u8]) -> bool) {
    // 先取出裸文件描述符；后续 fcntl 和 poll 都直接作用在它上面。
    let fd = pipe.as_raw_fd();
    // F_GETFL 读取原有状态，F_SETFL 在保留其他位的前提下加入 O_NONBLOCK；
    // 这样 read() 在没有数据时返回 WouldBlock，而不是阻塞线程。
    // SAFETY: fcntl on a descriptor this thread owns.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
    // 复用一个 64 KiB 缓冲区，避免每次读取都分配内存。
    let mut buffer = vec![0u8; 64 * 1024];
    // SeqCst 提供顺序一致的原子读取；停止标记由命令结束或取消逻辑写入。
    while !stop.load(Ordering::SeqCst) {
        // pollfd 告诉内核：关注这个 fd 上的 POLLIN（可读）事件；revents 由内核回填。
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one valid pollfd.
        // 最多等待 100ms。poll 返回就绪的 fd 数；0 表示超时，正好用来周期性检查 stop。
        let ready = unsafe { libc::poll(&mut poll, 1, 100) };
        // 超时或 EINTR：没有数据也要回到循环顶部检查 stop，因此直接 continue。
        if ready == 0
            || (ready < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted)
        {
            continue;
        }
        // 其他 poll 错误（如 fd 已关闭）无法继续读取，结束线程。
        if ready < 0 {
            return;
        }
        // 非阻塞读：成功返回字节数，0 是 EOF；WouldBlock/Interrupted 可以安全重试。
        match pipe.read(&mut buffer) {
            Ok(0) => return,
            Ok(read) => {
                if !on_data(&buffer[..read]) {
                    return;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return,
        }
    }
}

/// A pipe a writer thread can poll, so that it stops when the program settles.
// 写管道的能力约束：既要 Write 写数据，也要 AsRawFd 在缓冲区满时 poll(POLLOUT)。
// 与 Pipe 一样是没有方法的标记 trait，配合下面的 blanket impl 自动覆盖标准类型。
pub trait WritePipe: io::Write + std::os::fd::AsRawFd {}
// 与 Pipe 对称的 blanket impl：这里把 Read 换成 Write，满足约束的类型自动成为 WritePipe。
impl<T: io::Write + std::os::fd::AsRawFd> WritePipe for T {}

/// Write all of `bytes`, waiting while the program does not read; false once the pipe is closed or `stop` is set
/// (looked at every 100 ms, also while the write waits).
// 把 bytes 全部写进管道，直到写完、管道关闭或 stop 被置位；返回是否全部写完。
// 写入端被设为非阻塞；遇到 WouldBlock 时用 poll(POLLOUT, 100ms) 等程序来读，期间也检查 stop。
// 例：write_pipe(&mut stdin, command.as_bytes(), &stop) 把 shell 命令送进 stdin；
// 子进程提前退出导致管道关闭时返回 false。
pub fn write_pipe(pipe: &mut impl WritePipe, mut bytes: &[u8], stop: &AtomicBool) -> bool {
    let fd = pipe.as_raw_fd();
    // 与 read_pipe 相同：只在 daemon 持有的这一端设置 O_NONBLOCK，子进程端的行为不受影响。
    // SAFETY: fcntl on a descriptor this thread owns; only the daemon's end of the pipe becomes nonblocking.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
    // 循环直到剩余字节为空；每一轮最多写一次。
    while !bytes.is_empty() {
        // 每次写之前检查取消；如果管道一直可写，这里也能及时退出。
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        // write 可能短写，返回值是本次实际写入的字节数；0 通常表示对端已关闭。
        match pipe.write(bytes) {
            Ok(0) => return false,
            // 切片语法 &bytes[written..] 生成剩余尚未写出的部分，不复制数据，
            // 只是移动切片起点；循环条件据此判断是否写完全部内容。
            Ok(written) => bytes = &bytes[written..],
            // 非阻塞写暂时没有空间：poll(POLLOUT) 等最多 100ms，让子进程有机会读走数据。
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                let mut poll = libc::pollfd {
                    fd,
                    events: libc::POLLOUT,
                    revents: 0,
                };
                // SAFETY: one valid pollfd.
                let ready = unsafe { libc::poll(&mut poll, 1, 100) };
                if ready < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                    return false;
                }
            }
            // 被信号打断不算失败，空分支后重新尝试同一次写。
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return false,
        }
    }
    true
}

/// The program an argv command runs; `Command` searches `PATH` like `execvp`, as libuv does.
// argv 命令在 Unix 上不需要额外解析：Command 启动子进程时由 execvp 按 PATH 搜索，
// 所以原样返回 program。cwd/env 参数目前不用（下划线前缀表示有意忽略），
// 保留签名让 Unix/Windows 两套实现可以互换，exec.rs 无需 cfg。
// 例：resolve_program("git", "/work", &env) 返回 "git"；
// 真正找不到程序时由 spawn 阶段报 spawn_error。
pub fn resolve_program(
    program: &str,
    _cwd: &str,
    _env: &Map<String, Value>,
) -> Result<String, Failure> {
    Ok(program.to_string())
}

// 用 `which bash` 查找 bash，找不到返回 None。
// 只取第一行输出并再次确认路径存在；stdin/stderr 接到 null，避免子进程读终端或污染日志。
// 例：PATH 中只有 /usr/bin/bash 时返回 Some("/usr/bin/bash")。
fn which_bash() -> Option<String> {
    let output = Command::new("which")
        .arg("bash")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // 输出是字节，按 UTF-8 解码并替换非法字节；trim 去掉换行，
    // lines().next() 只取第一行，再复制成拥有所有权的 String。
    let first = String::from_utf8_lossy(&output.stdout)
        .trim()
        .lines()
        .next()?
        .to_string();
    path_exists(&first).then_some(first)
}

/// Node's shell resolution: a configured shell must exist; otherwise `/bin/bash`, `which bash`, then `sh`.
// 复现 Node 的 shell 选择规则：
// 1) 显式 shellPath 必须存在，否则返回 shell_unavailable（错误消息带配置路径）；
// 2) 否则优先 /bin/bash；
// 3) 否则用 which bash 的结果；
// 4) 都没有时退回 "sh"，让后续 spawn 产生真正的 ENOENT。
// 返回 ShellConfig：program、args=["-c"]、command_on_stdin=false；不启动进程。
// 例：shell_config(None) 在常见 Linux 上得到 program="/bin/bash"、args=["-c"]。
pub fn shell_config(shell_path: Option<&str>) -> Result<ShellConfig, Failure> {
    // 小闭包把路径包装成统一配置，避免三处重复写相同的 args；
    // 闭包参数是 &str，返回值拥有自己的 String。
    let shell = |program: &str| ShellConfig {
        program: program.into(),
        args: vec!["-c".into()],
        command_on_stdin: false,
    };
    // Option<&str> 的 if let 解构：只有配置了 shellPath 才进入这个分支。
    if let Some(configured) = shell_path {
        if path_exists(configured) {
            return Ok(shell(configured));
        }
        return Err(Failure::new(
            "shell_unavailable",
            format!("Custom shell path not found: {configured}"),
        ));
    }
    // 与 Node 一样优先固定路径 /bin/bash，之后才搜索 PATH。
    if path_exists("/bin/bash") {
        return Ok(shell("/bin/bash"));
    }
    // unwrap_or_else 在 which_bash 返回 None 时执行闭包；
    // "sh".into() 从 &str 转成 String。若 sh 也不存在，错误会在启动阶段出现。
    Ok(shell(&which_bash().unwrap_or_else(|| "sh".into())))
}

/// Arguments, environment and process setup as libuv applies them.
// 把参数、环境变量和进程级设置应用到 Command 上，对应 libuv 的 uv_spawn 预处理。
// 输入：待配置的 Command、参数数组、协议里的 env 对象、是否继承 daemon 环境。
// 副作用：写入参数和环境，并注册 pre_exec 回调；不启动进程。
// 例：configure(&mut cmd, &["-lc".into(), "echo hi".into()], &json!({}), true)
// 之后，子进程拥有自己的会话和默认信号处理。
// env 中值不是字符串的项会被跳过；这是来自协议输入的运行时判断，而不是类型保证。
pub fn configure(
    command: &mut Command,
    args: &[String],
    env: &Map<String, Value>,
    inherit_env: bool,
) {
    // 参数按顺序原样传入；Unix 不需要像 Windows 那样自行拼命令行和加引号。
    command.args(args);
    // inheritEnv=false 表示只保留 env 里的变量，因此先清空父进程环境；
    // 默认 true 时保留 daemon 的环境，再用 env 覆盖同名项。
    if !inherit_env {
        command.env_clear();
    }
    // serde_json 的 Map 迭代顺序不是调用方书写顺序；这里只关心最终键值。
    // as_str() 对非字符串值返回 None，于是跳过而非报错。
    for (key, value) in env {
        if let Some(value) = value.as_str() {
            command.env(key, value);
        }
    }
    // pre_exec 在 fork 之后、exec 之前运行，只能调用 async-signal-safe 的函数；
    // setsid、signal、sigprocmask 都属于这类系统调用，不分配内存、不加锁。
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(|| {
            // A new session, so a kill reaches every descendant; default signal handling and an empty mask, as libuv sets.
            // 新建会话并成为会话首进程，同时成为新进程组组长；
            // 这样 kill_tree 用 -pid 就能一次覆盖命令启动的所有后代。
            libc::setsid();
            // 把 1..31 号信号恢复默认处理，跳过 SIGKILL/SIGSTOP（它们本来就不能被捕获/忽略）。
            // 否则父进程忽略某些信号时，子进程也可能意外继承。
            for signal in 1..32 {
                if signal != libc::SIGKILL && signal != libc::SIGSTOP {
                    libc::signal(signal, libc::SIG_DFL);
                }
            }
            // 构造空信号掩码：zeroed 清零结构体，sigemptyset 再按 libc 的要求初始化；
            // SIG_SETMASK 用空掩码替换继承来的阻塞集合。
            let mut mask: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut mask);
            libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut());
            Ok(())
        });
    }
}

// Unix 不需要 spawn 后的额外处理：没有 Windows 的 job object；
// 进程组已经由 pre_exec 里的 setsid 建立。参数用下划线表示有意忽略。
pub fn after_spawn(_child: &Child) {}

/// Run `on_signal` with the signal on its own thread when `SIGTERM`, `SIGINT` or `SIGHUP` arrives, instead of dying
/// at once. Call before starting any other thread: threads inherit the blocked signals, so only this one receives
/// them. Commands reset their signal mask before they run.
// 让 daemon 收到 SIGTERM/SIGINT/SIGHUP 时不立刻死掉，而是回调 on_signal，
// 以便先杀掉子进程组。必须在启动其他线程之前调用。
// 实现：先把三个信号加入当前线程的信号掩码并阻塞；之后新建的线程会继承掩码，
// 所以只有这里专门创建的 sigwait 线程会收到它们。无返回值，回调在独立线程执行。
// 例：main.rs 用它在退出前 kill_all；被启动的命令会在 configure 中用空掩码恢复默认行为。
// FnOnce(i32) + Send + 'static：回调只调用一次，可跨线程发送，且不能借用栈上的临时数据。
pub fn on_exit_signal(on_signal: impl FnOnce(i32) + Send + 'static) {
    // 先把信号加入集合，再用 SIG_BLOCK 把它们加到当前线程的掩码；
    // pthread_sigmask 只影响调用线程，不会阻塞 daemon 里其他已有线程。
    // SAFETY: a zeroed sigset_t initialized by sigemptyset, and plain signal mask calls.
    let set = unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaddset(&mut set, signal);
        }
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        set
    };
    // move 把信号集合复制进新线程；这个线程唯一的任务就是同步等待信号。
    std::thread::spawn(move || {
        let mut signal = 0;
        // SAFETY: waits for one of the signals blocked above.
        // sigwait 返回 0 表示取到了集合中的一个信号，信号编号写入 signal；
        // 非 0 表示调用失败，此时不执行回调。
        if unsafe { libc::sigwait(&set, &mut signal) } == 0 {
            on_signal(signal);
        }
    });
}

/// Kill the command's process group, or the process if the group is gone.
// 杀掉命令所在的整个进程组：给 -pid 发 SIGKILL；如果组已消失（返回非 0），
// 再尝试只杀 pid。因为 configure 用 setsid 让命令成为新会话/进程组组长，
// 负 pid 能覆盖它启动的后代。
// 例：kill_tree(1234) 先 kill(-1234, SIGKILL)，失败后 kill(1234, SIGKILL)。
// pid 来自 Child::id()，Unix 的 pid_t 是 i32，这里的 as 转换符合平台约定。
pub fn kill_tree(pid: u32) {
    let pid = pid as i32;
    // SAFETY: plain signal delivery.
    unsafe {
        // kill 成功返回 0；失败通常说明进程组不存在或没有权限，于是退回杀单个进程。
        if libc::kill(-pid, libc::SIGKILL) != 0 {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

/// A process killed by a signal has no exit code; report 128 + the signal, as the shell does.
// 把 ExitStatus 转成协议里的 exitCode。正常退出用 code()；
// 被信号杀死时 Node 报 128+signal，所以用 signal() 补出 137（SIGKILL=9）之类的值；
// 两者都没有时 signal 按 0 处理，得到 128。
// 例：kill -9 结束的命令得到 137；正常退出 0 得到 0。
pub fn exit_code(status: ExitStatus) -> i64 {
    i64::from(
        status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)),
    )
}

/// The bytes of a file name, which libuv sorts directory listings by.
// 返回文件名的原始字节；Unix 文件名本就是字节序列。
// libuv 的 scandir 按字节排序，fs.rs 的 dir_entry 需要它保留非 UTF-8 名字的排序依据。
// 这里总是 Some，因为 Unix 的名字一定能转成字节；Option 是为了与 Windows 的签名保持一致。
// 例：名字 b"caf\xe9" 返回这些字节。
pub fn raw_name(name: &OsStr) -> Option<Vec<u8>> {
    Some(name.as_bytes().to_vec())
}

/// Windows only: the per-drive working directories of the `=C:` variables.
// Windows 专用：Node 的 path.resolve 会读取 =C: 形式的环境变量；
// Unix 没有这种变量，因此返回空 Map。调用方 hello 始终输出该字段，客户端无需分支。
pub fn drive_cwds() -> Map<String, Value> {
    Map::new()
}

// 打开目录并返回 std 的 ReadDir 迭代器；main.rs 的 opendir/readdir 用它分页。
// 错误直接返回，由调用方包装成 Failure::io；这里不预读任何目录项。
pub fn read_dir(path: &str) -> io::Result<std::fs::ReadDir> {
    std::fs::read_dir(path)
}

/// Device and inode of `path`; the metadata already has them.
// 路径身份的统一入口：Unix 的 metadata 已经带 dev/ino，
// follow 参数只影响 Windows 打开句柄的方式；这里忽略 path/follow，直接复用 identity。
// 用下划线命名参数表示它们在本实现里未使用，但签名必须与 Windows 版本一致。
pub fn path_identity(_path: &str, metadata: &Metadata, _follow: bool) -> (u64, u64) {
    identity(metadata)
}
