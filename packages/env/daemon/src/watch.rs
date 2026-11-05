//! `watch`: Durable's `NodeFileWatcher` (packages/durable/src/env/node-watch.ts) running next to the files, so a scan
//! costs no round trips. Native events only trigger a debounced rescan; changes are the difference between snapshots
//! plus the event paths. Events go out as `change` events of the request, which lasts until it is cancelled.
//!
//! 所属模块：packages/env/daemon/src/watch.rs，daemon 的 watch 操作实现。
//! 上游入口：main.rs 的 Server::dispatch 在 op == "watch" 时调用 run；CANCEL 帧经请求表找到 Control，
//! 把 aborted 置位，run 在等待循环的检查点返回。
//! 下游依赖：notify（平台原生事件）、sys（路径身份/mtime/分隔符）、output（单写线程，控制帧优先）、
//! frame（EVENT 帧与 MAX_PAYLOAD）、exec::Control（取消标记）、errors::Failure（协议错误）。
//!
//! 职责边界：本文件负责“监视哪些路径、如何得到可靠的变化集合、何时向客户端发事件”。它不解析客户端路径
//! （客户端先解析成绝对路径）、不做资源加载、不跟随递归目标下的符号链接，也不负责连接生命周期。
//! 设计要点：原生事件只是“可能变了”的提示，真正变化来自两次快照相减加上事件路径；新目录先装 watcher
//! 再重扫，因此不依赖操作系统报告的事件类型（编辑器常见的“写临时文件再 rename”也能覆盖）。
//!
//! 能力清单（按导出项）：
//! - run：watch 请求入口；发 ready 后循环，直到取消或出错。
//! - parse_targets、change_event（私有）：线上参数校验与 change 事件构造。
//! - FileWatcher 及其方法（私有）：快照扫描、差异、watcher 增删、原生事件处理、降级轮询。
//! - Mode/Target/Entry/ScanError 等辅助类型：模式、目标、快照记录与错误归类。
//!
//! 典型调用（示例，真实签名）：
//!     let result = watch::run(id, &json, &output, control)?;
//!     // 阻塞到 CANCEL；期间通过 output.control 发送 ready/change/error 事件
//!
//! 建议阅读顺序：常量与 Target/Kind/Entry/Mode/ScanError → FileWatcher 字段 → send/cancelled →
//! scan_directory/scan → diff/reported → sync/reconcile → on_event/flush → run 的事件循环 → 测试。

use crate::errors::Failure;
use crate::exec::Control;
use crate::frame::{EVENT, Frame, MAX_PAYLOAD};
use crate::output::Output;
use crate::sys;
// notify 提供跨平台原生文件事件：macOS 用 FSEvents，Linux/Android 用 inotify，Windows 用
// ReadDirectoryChangesW。这里只把事件当作“可能变了”的触发器；路径是否真的变化仍由快照比较决定。
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fs::{self, Metadata};
use std::hash::Hasher;
use std::io;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant, SystemTime};

// 原生事件去抖窗口：50ms 内的多个事件只触发一次重扫，与 NodeFileWatcher 的 DEBOUNCE_MS 一致。
const DEBOUNCE: Duration = Duration::from_millis(50);
// macOS 上 fs.watch 返回时 FSEvents 流尚未生效；安装 watcher 后 500ms 再补一次重扫，
// 这段时间内发生的变化不会被事件报告，但会被快照差异发现。
/// macOS: FSEvents streams go live after `watch` returns; a rescan this long after installing watchers catches changes
/// made in between.
const FSEVENTS_SETTLE: Duration = Duration::from_millis(500);
// polling 模式的默认快照间隔：2 秒。
const DEFAULT_POLL_MS: u64 = 2000;
// 一次 watch 覆盖的目录预算默认 10 000；建立覆盖时超限失败，运行中增长则发 error 事件后停止。
const DEFAULT_MAX_DIRECTORIES: usize = 10_000;
// polling 模式下，对最近修改且不超过 256 KiB 的普通文件额外计算内容哈希。
/// In polling mode, recently modified small files are also compared by content.
const HASH_MAX_BYTES: u64 = 256 * 1024;
// “最近”定义为 5 秒内修改；文件系统时间戳粒度内的第二次写入可能不改变 size/mtime，哈希用来兜底。
const HASH_RECENT: Duration = Duration::from_secs(5);
// 等待原生事件时必须定期醒来检查取消标记；100ms 是取消延迟的上限。
/// How often a waiting watcher looks for a cancel.
const CANCEL_POLL: Duration = Duration::from_millis(100);

// Linux statfs 的 f_type 魔数：这些文件系统可能接受 watch，但不报告在别处发生的变化，
// 因此 run 默认改用 polling。数组只在 Linux/Android 编译；12 个值与 NodeFileWatcher 保持一致。
/// Linux `statfs` magic numbers of file systems that accept watches but do not report changes made elsewhere.
#[cfg(any(target_os = "linux", target_os = "android"))]
const UNRELIABLE_FILE_SYSTEMS: [u64; 12] = [
    0x6969,     // NFS
    0x517b,     // SMB
    0xff534d42, // CIFS
    0xfe534d42, // SMB2
    0x65735546, // FUSE (sshfs, Android shared storage)
    0x01021997, // 9P (WSL2 Windows drives)
    0x0bd00bd0, // Lustre
    0x47504653, // GPFS
    0x00c36400, // Ceph
    0x5346414f, // OpenAFS
    0x6b414653, // kAFS
    0x5dca2df5, // sdcardfs
];

// 一个已解析的监视目标；路径由客户端解析成绝对路径后传入，daemon 只做字符串前缀比较。
struct Target {
    // 要监视的绝对路径；可以是普通文件、目录或指向它们的符号链接；不存在也允许（等待创建）。
    path: String,
    // true 时递归监视目录后代；非递归只看直接子项。
    recursive: bool,
    // true 时排除名字以 "." 开头的条目（对目标下的任意层级生效）。
    hidden: bool,
    // 精确匹配的排除名集合；用 HashSet 让每个条目 O(1) 判断。
    names: HashSet<String>,
}

// 快照中一个路径的类型；Copy/PartialEq 让 Entry 可以整体比较，Kind 也能直接复制。
// 分类依据是 metadata.file_type()：普通文件、目录、符号链接，其余（socket、FIFO、设备等）归为 Other。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    // 普通文件；内容变化由 size/mtime/可选 hash 判断。
    File,
    // 目录；只比较身份，大小和时间被清零。
    Directory,
    // 符号链接；只可能来自 lstat，递归遍历不会跟随它。
    Symlink,
    // socket、FIFO、设备等其他类型；只比较身份。
    Other,
}

// 快照为每个路径保存的记录。目录和祖先只比较身份（kind/dev/ino），size 和 mtime 置 0：
// 目录的 mtime 会因子项增删而变，祖先目录更会因为任意无关兄弟变化而变，用时间比较会产生大量误报。
// 普通文件额外比较 size/mtime；polling 模式下最近修改的小文件还比较内容哈希。
/// What a snapshot remembers of one path. Directories and ancestors are compared by identity only.
#[derive(Clone, PartialEq, Eq)]
struct Entry {
    // 路径类型；符号链接只在 lstat 记录中出现。
    kind: Kind,
    // 设备号；与 ino 一起标识“同一个对象”，路径被替换后即使内容相同也会变。
    dev: u64,
    // 文件索引（inode/Windows 文件索引）；跨目录重命名或替换会改变它。
    ino: u64,
    // 文件字节数；目录固定为 0（身份比较已足够）。
    size: u64,
    // 秒和纳秒组成的修改时间；目录和祖先固定为 (0, 0)。
    mtime: (i64, i64),
    // polling 模式的内容哈希；None 表示未计算（非 polling、太大、太旧或读取失败）。
    hash: Option<u64>,
}

// 路径 → 记录的快照；HashMap 的迭代顺序不固定，因此发送前必须显式排序。
type Snapshot = HashMap<String, Entry>;

// 监视模式：native 依赖平台事件并去抖；polling 只按固定间隔比较快照，不依赖事件。
// Copy/PartialEq 让模式可以按值比较和传递；运行中可能从 Native 降级为 Polling。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    // 使用平台原生事件（macOS FSEvents、Linux inotify、Windows ReadDirectoryChangesW）。
    Native,
    // 只比较快照；用于 Windows、网络/FUSE 文件系统或原生 watcher 资源不足时。
    Polling,
}

// Mode 的唯一行为是把模式名映射成协议字段的字符串。
impl Mode {
    // 返回 ready/overflow 事件里的 mode 值，必须是固定的 "native" 或 "polling"。
    fn name(self) -> &'static str {
        match self {
            // 原生事件模式。
            Mode::Native => "native",
            // 快照轮询模式。
            Mode::Polling => "polling",
        }
    }
}

// 扫描失败的两种来源：目录预算超限，或具体系统调用失败。
// 同一个错误在“建立覆盖”阶段和“运行中重扫”阶段映射不同：前者是请求错误，后者变成 error 事件。
enum ScanError {
    // 目标覆盖的目录数超过 maxDirectories；保存上限用于错误消息。
    Budget(usize),
    // 系统调用失败；保存 io::Error、系统调用名和路径，用来构造 Node 风格的 FileError。
    Io(io::Error, &'static str, String),
}

// 把扫描错误转换成线上可表达的两种形态。
impl ScanError {
    // 建立覆盖阶段（run 首次 sync）的失败：Budget 映射 EINVAL，Io 交给 Failure::io 翻译 errno。
    // 返回的 Failure 由 main.rs 序列化为请求的 ERROR 帧；此时不会发送 ready。
    /// The error `NodeExecutionEnv.watch` returns when opening fails.
    fn failure(&self) -> Failure {
        match self {
            // 预算错误是客户端参数问题，用 EINVAL 和明确消息。
            ScanError::Budget(max) => {
                Failure::new("EINVAL", format!("Watched paths exceed {max} directories"))
            }
            // Io 保持 Node 的 code/message/syscall/path 细节。
            ScanError::Io(error, syscall, path) => Failure::io(error, syscall, path),
        }
    }

    // 运行中重扫失败的 FileError code：权限问题报 permission_denied，其余一律 invalid。
    // 客户端据此决定提示方式；消息仍来自 failure().message。
    /// The `FileError` code `NodeFileWatcher` reports when a later rescan fails.
    fn code(&self) -> &'static str {
        match self {
            // 只有 PermissionDenied 有专门 code；其余（含预算超限）没有专门的用户提示。
            ScanError::Io(error, ..) if denied(error) => "permission_denied",
            _ => "invalid",
        }
    }
}

// 判断是否权限不足（EACCES/EPERM）；用于区分“目标自身不可读必须失败”和“子目录不可读可跳过”。
fn denied(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
}

// 从 metadata 分类路径类型，不跟随符号链接：调用方传 lstat 结果时能看到 Symlink，
// 传 stat（跟随）结果时符号链接已经被解析成目标类型。
fn kind_of(metadata: &Metadata) -> Kind {
    let file_type = metadata.file_type();
    // 普通文件优先判断；目录、符号链接、其余类型依次归类。
    if file_type.is_file() {
        Kind::File
    } else if file_type.is_dir() {
        Kind::Directory
    } else if file_type.is_symlink() {
        Kind::Symlink
    } else {
        // socket、FIFO、设备等统一归为 Other。
        Kind::Other
    }
}

// 把一个路径的 metadata 转成快照记录。
// follow=true 表示 metadata 来自 stat（目标自身，跟随符号链接），false 表示来自 lstat（祖先或子项）。
// hash 只在 polling 模式由 record 计算；目录的 size/mtime 在这里统一清零，避免误报。
// 例：一个 5 字节普通文件得到 kind=File、size=5、mtime=...、hash 可能为 Some。
/// What a snapshot remembers of `path`, whose `metadata` came from `stat` (`follow`) or `lstat`.
fn entry_of(path: &str, metadata: &Metadata, follow: bool, hash: Option<u64>) -> Entry {
    // 先分类，后面的 size/mtime 规则依赖它。
    let kind = kind_of(metadata);
    // 身份查询负责平台差异：Unix 直接读 metadata，Windows 打开路径取卷序列号/文件索引。
    let (dev, ino) = sys::path_identity(path, metadata, follow);
    // 提前算好布尔值，构造 Entry 时两处复用。
    let directory = kind == Kind::Directory;
    Entry {
        kind,
        dev,
        ino,
        // 目录只比较身份，size 固定 0。
        size: if directory { 0 } else { metadata.len() },
        // 目录和祖先的时间不参与比较，固定 (0, 0)；普通文件使用平台 mtime。
        mtime: if directory {
            (0, 0)
        } else {
            sys::mtime(metadata)
        },
        hash,
    }
}

// 返回 path 的祖先目录，最近的在前，直到根；内部使用 Path::ancestors 并跳过 path 自身。
// 例：/a/b/c → ["/a/b", "/a", "/"]；Windows 盘符根的父级仍是自身，迭代会停止。
// to_string_lossy 把非 UTF-8 路径（Unix）换成替换字符，满足协议字符串要求。
/// Ancestors of `path`, nearest first, up to the root.
fn ancestors(path: &str) -> Vec<String> {
    // Path::ancestors 是纯词法操作，不访问文件系统，也不要求路径存在。
    Path::new(path)
        .ancestors()
        .skip(1)
        .map(|ancestor| ancestor.to_string_lossy().into_owned())
        .collect()
}

// 给目录补上平台分隔符，除非它已经以分隔符结尾（例如根目录 "/" 或 "C:\\"）。
// 用于拼子路径和前缀判断；避免出现 "/a//b" 或把 "/" 变成 "//"。
fn with_separator(directory: &str) -> String {
    // 根目录已经带分隔符，直接复用，避免重复。
    if directory.ends_with(sys::PATH_SEPARATOR) {
        directory.to_string()
    } else {
        format!("{directory}{}", sys::PATH_SEPARATOR)
    }
}

// path 是否等于 ancestor 或位于其下。
// 用“ancestor + 分隔符”做前缀，避免 "/a" 误匹配 "/ab"；字符串比较不访问文件系统，
// 因此符号链接、大小写等由调用方在此之前处理（watched_spelling 负责路径拼写）。
/// Whether `path` is `ancestor` or below it.
fn is_within(path: &str, ancestor: &str) -> bool {
    path == ancestor || path.starts_with(&with_separator(ancestor))
}

// 条目名是否被目标排除：hidden 规则排除 "." 开头的名字，names 规则精确匹配名字。
// 只检查单个路径分量；in_scope 会对相对路径的每个分量分别调用。
fn excluded(target: &Target, name: &str) -> bool {
    (target.hidden && name.starts_with('.')) || target.names.contains(name)
}

// 按 JavaScript Array.prototype.sort 的默认顺序排序：逐 UTF-16 码元比较。
// Rust 的 str 默认按 UTF-8 字节比较，对基本多文种平面字符结果相同，但对 emoji 等补充平面字符不同：
// 例如 U+10000 的 UTF-16 代理对 D800 DC00 排在 U+E000 之前，而码点顺序相反。
// 客户端用 JS 排序/去重，这里保持一致，避免同一变化集合出现不同顺序。
/// JavaScript's default sort: by UTF-16 code units.
fn sort_like_javascript(paths: &mut [String]) {
    // encode_utf16 生成 u16 迭代器，cmp 按字典序比较，不分配临时字符串。
    paths.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

// 目标路径或其最近的已存在祖先是否位于“接受 watch 但不报告远端变化”的文件系统。
// 只在 Linux/Android 上检查；其他平台没有 statfs 且默认模式已按平台选择。
// 例：路径在 sshfs 挂载点下 → true，run 选择 polling。
/// Whether any path, or its nearest existing ancestor, is on a file system that does not report remote changes.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn any_unreliable(targets: &[Target]) -> bool {
    // CString 提供带 NUL 结尾的 C 字符串；路径含内部 NUL 时 new 失败，直接换下一个目标。
    use std::ffi::CString;
    for target in targets {
        // 先检查路径本身，再逐级向上找最近可 statfs 的祖先；第一次成功就 break，不再继续向上。
        for candidate in std::iter::once(target.path.clone()).chain(ancestors(&target.path)) {
            // NUL 检查失败意味着所有祖先也无法用 C 字符串表示，跳过该目标。
            let Ok(name) = CString::new(candidate) else {
                // 路径含 NUL：连路径本身都无法传给 statfs，直接放弃该目标。
                break;
            };
            // SAFETY: a NUL-terminated path and a zeroed statfs buffer for the call to fill.
            // zeroed 为 statfs 输出缓冲区提供合法初值；POD 类型全零是有效的。
            let mut info: libc::statfs = unsafe { std::mem::zeroed() };
            // 路径不存在/无权限：继续检查更上层祖先。
            if unsafe { libc::statfs(name.as_ptr(), &mut info) } != 0 {
                continue;
            }
            // f_type 在不同 libc 里可能是 i64 或 u32；先转 u64 再取低 32 位，统一成魔数比较。
            #[allow(clippy::unnecessary_cast)]
            let kind = (info.f_type as u64) & 0xffff_ffff;
            // 命中任一已知网络/FUSE 文件系统就足以降级。
            if UNRELIABLE_FILE_SYSTEMS.contains(&kind) {
                return true;
            }
            // 找到最近的可 statfs 祖先并检查完，不再向上。
            break;
        }
    }
    false
}

// 非 Linux/Android：没有 statfs 检查，直接返回 false，由 run 的其他条件选择模式。
#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn any_unreliable(_targets: &[Target]) -> bool {
    false
}

/// One scan: the snapshot, and targets that are symbolic links to files, whose files need their own watchers.
// 一次完整扫描的产物；下一轮 diff 以 snapshot 为基准，其余集合只在本次扫描/协调中使用。
struct Scan {
    // 本轮看到的所有路径及其记录（目标、祖先、递归子项）。
    snapshot: Snapshot,
    // 目标本身是“符号链接 → 普通文件”的路径；文件内容变化不会出现在链接目录的事件里，需要单独 watcher。
    linked_files: HashSet<String>,
    // counted：已计入预算的目录集合；多个目标重叠时同一目录只计一次，超过 maxDirectories 立即失败。
    // traversed：(目标下标, 目录) 集合；同一目录可能因不同目标的递归/排除规则需要分别遍历。
    /// Directories counted against the limit, and directories traversed per target.
    counted: HashSet<String>,
    // 避免同一目标重复进入同一目录（重叠路径或目录环）。
    traversed: HashSet<(usize, String)>,
    // 通过 readdir + lstat 看到的子项类型缓存；让另一个目标的 stat 记录优先于这里的 lstat 记录。
    /// Kinds of listed entries without following links.
    listed: HashMap<String, Kind>,
}

// 已安装的原生 watcher 的元数据；键是安装时的路径，dev/ino 用于识别路径是否被替换。
struct Installed {
    // 安装时对象的身份；身份变了说明原目录已被替换，watcher 必须重建。
    dev: u64,
    // 安装时对象的文件索引，与 dev 一起判断“还是不是同一个目录”。
    ino: u64,
    // 解析符号链接后的路径，仅当它与 watched 路径拼写不同才保存。
    // macOS FSEvents 用 /private/var 报告 /var 下的事件；保存别名用于把事件路径翻回调用方看到的拼写。
    /// The watched path with links resolved, as FSEvents spells event paths (`/private/var` for `/var`).
    canonical: Option<String>,
}

// 一次 watch 请求的运行时状态；run 在栈上创建它，所有方法借用它。
// 字段分成三组：请求配置（id/output/control/targets/mode/间隔/预算）、基线快照与原生 watcher、
// 以及待发送事件和 macOS 补充重扫截止时间。
// 生命周期 'a 让 output/control 的引用只在 run 的作用域内有效，不需要克隆或共享所有权。
struct FileWatcher<'a> {
    // 请求 id；所有 EVENT 帧都用它，客户端据此把事件对应到 watch 请求。
    id: u32,
    // daemon 的唯一写线程队列；事件通过 control 队列发送，优先于命令 bulk 输出。
    output: &'a Output,
    // 取消标记；run 的等待循环定期读取 aborted。
    control: &'a Control,
    // 解析后的目标列表，顺序影响 reported 选择哪个目标。
    targets: Vec<Target>,
    // 当前模式；运行中可能从 Native 降级成 Polling。
    mode: Mode,
    // polling 模式两次扫描的间隔，由 pollIntervalMs 提供。
    poll_interval: Duration,
    // 目录预算；count 每发现一个新目录就检查一次。
    max_directories: usize,
    // 上一次成功扫描的基线，diff 与 reconcile 都以它为准。
    snapshot: Snapshot,
    // 平台原生 watcher；Polling 模式为 None，drop 时会关闭所有已注册监视。
    native: Option<RecommendedWatcher>,
    // 传给 notify 回调的发送端；watcher 存活期间保持通道连接。
    events_sender: Sender<notify::Result<Event>>,
    // 已安装 watcher 的路径 → 安装时身份/规范路径。
    installed: HashMap<String, Installed>,
    // 原生事件累积的待报告路径（已通过 in_scope 和 reported 归一化），flush 时取走。
    events: HashSet<String>,
    // macOS 安装 watcher 后的补充重扫截止时间；到点触发 flush。
    settle_at: Option<Instant>,
}

impl FileWatcher<'_> {
    // 发送一条 watch 事件帧；json 是事件元数据，payload 为空。
    // 走 Output::control 高优先队列：watch 事件不能被大量命令输出拖在后面。
    // 例：send(json!({"kind":"ready","mode":"native"})) 立即排到待写队列。
    fn send(&self, json: Value) {
        // Frame::new 创建无 payload 的 EVENT 帧；id 是请求 id。
        self.output.control(Frame::new(EVENT, self.id, json));
    }

    // 请求是否已被取消：读取 Control.aborted，普通 CANCEL 会把它置位。
    // SeqCst 保证与 main.rs 的取消写入建立明确的先后关系；清理用的 kill 不在此判断。
    fn cancelled(&self) -> bool {
        self.control.aborted.load(Ordering::SeqCst)
    }

    // 把 path 的 metadata 记入本轮快照；path 是扫描时使用的拼写。
    // polling 模式下，对最近 5 秒内修改且不超过 256 KiB 的普通文件计算内容哈希，
    // 因为文件系统时间戳粒度内的第二次写入可能保持 size 和 mtime 不变。
    // 副作用：向 scan.snapshot 写入 Entry；hash 计算失败时保留 None，仍按 size/mtime 比较。
    fn record(&self, scan: &mut Scan, path: &str, metadata: &Metadata, follow: bool) {
        // 默认不哈希；只有 polling 的小文件条件满足时才填入。
        let mut hash = None;
        // modified() 可能失败；duration_since 对未来时间返回 Err，这里按“最近”处理。
        let recent = metadata
            .modified()
            .map(|modified| {
                SystemTime::now()
                    .duration_since(modified)
                    // 未来时间/时钟偏移视为最近，宁可多读一次文件也不漏变化。
                    .map_or(true, |age| age < HASH_RECENT)
            })
            .unwrap_or(false);
        // 三个条件都满足才读文件：polling、普通文件、大小和年龄在阈值内。
        if self.mode == Mode::Polling
            && metadata.is_file()
            && metadata.len() <= HASH_MAX_BYTES
            && recent
        {
            // fs::read 读取整个小文件；失败时返回 None，不中断扫描。
            hash = fs::read(path).ok().map(|content| {
                // 进程内 64 位内容哈希，足以发现变化；不用于安全或跨进程持久化。
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                hasher.write(&content);
                hasher.finish()
            });
        }
        scan.snapshot
            // 写入记录；entry_of 统一处理身份和目录字段清零。
            .insert(path.to_string(), entry_of(path, metadata, follow, hash));
    }

    // 把目录 path 计入预算；同一目录重复插入不会增加计数。
    // 超过 maxDirectories 时返回 ScanError::Budget，由调用方转成请求错误或 error 事件。
    fn count(&self, scan: &mut Scan, path: &str) -> Result<(), ScanError> {
        // HashSet 去重：重叠目标看到同一目录时预算只扣一次。
        scan.counted.insert(path.to_string());
        // 用严格大于：恰好 maxDirectories 个目录允许，再多一个就失败。
        if scan.counted.len() > self.max_directories {
            return Err(ScanError::Budget(self.max_directories));
        }
        Ok(())
    }

    // 遍历一个目录（按目标 index 的 recursive/exclude 规则），把子项记录进快照并递归子目录。
    // 返回 Err 只用于“无法继续建立覆盖”的错误：目标目录权限不足、预算超限、读目录出现意外错误。
    // 子目录不存在/无权限/不是目录时跳过；顶层目标本身权限不足则必须失败。
    // 例：递归目标下某个子目录在扫描途中被删除，read_dir 返回 NotFound，这里跳过并继续其他目录。
    fn scan_directory(
        &self,
        scan: &mut Scan,
        index: usize,
        directory: &str,
    ) -> Result<(), ScanError> {
        // 取出当前目标的规则；index 与 traversed 的键对应。
        let target = &self.targets[index];
        // 同一目标同一目录只遍历一次，防止符号链接环或重叠路径重复工作。
        if !scan.traversed.insert((index, directory.to_string())) {
            return Ok(());
        }
        // 把 read_dir/entry 错误分成“目标自身必须报错”和“子项可跳过”两类。
        let skip = |error: io::Error| -> Result<(), ScanError> {
            // The watched directory itself must be readable; below it, unreadable directories are skipped.
            // 顶层目标不可读时不能假装覆盖成功。
            if directory == target.path && denied(&error) {
                // 记录 scandir 和路径，最终映射成 permission_denied 错误。
                return Err(ScanError::Io(error, "scandir", directory.to_string()));
            }
            // 其余情况：不存在/无权限/不再是目录都当作已消失，跳过；其他错误向上抛。
            match error.kind() {
                io::ErrorKind::NotFound
                | io::ErrorKind::PermissionDenied
                | io::ErrorKind::NotADirectory => Ok(()),
                _ => Err(ScanError::Io(error, "scandir", directory.to_string())),
            }
        };
        // 先收集名字再遍历，避免同时持有 ReadDir 和修改 scan。
        let mut names = Vec::new();
        // read_dir 本身失败时走同一套跳过规则。
        match fs::read_dir(directory) {
            Err(error) => return skip(error),
            Ok(entries) => {
                for entry in entries {
                    match entry {
                        // file_name 是 OsString；to_string_lossy 与 Node 的 UTF-8 解码替换行为一致。
                        Ok(entry) => names.push(entry.file_name().to_string_lossy().into_owned()),
                        Err(error) => return skip(error),
                    }
                }
            }
        }
        // 目录前缀只计算一次，循环里直接拼接。
        let prefix = with_separator(directory);
        // 逐个处理子项名字；名字已经过 lossy 转换。
        for name in names {
            // hidden/names 排除规则在进入任何 stat 之前生效，省掉无效系统调用。
            if excluded(target, &name) {
                continue;
            }
            // 目标路径都以绝对路径传递，直接用字符串拼接子名。
            let path = format!("{prefix}{name}");
            // 同一路径可能已被另一个目标记录；先查 listed 缓存，避免重复 lstat。
            let kind = match scan.listed.get(&path) {
                Some(kind) => *kind,
                None => {
                    // 条目在 readdir 后消失/不可读：跳过，不终止整个扫描。
                    let Ok(metadata) = fs::symlink_metadata(&path) else {
                        continue;
                    };
                    let kind = kind_of(&metadata);
                    // 缓存类型，供其他目标或后续路径使用。
                    scan.listed.insert(path.clone(), kind);
                    // A target's own entry (following links) wins over its listing by another target.
                    // 目标自身的 stat（跟随链接）记录优先；这里不覆盖它。
                    if !scan.snapshot.contains_key(&path) {
                        self.record(scan, &path, &metadata, false);
                    }
                    kind
                }
            };
            // 只有递归目标且确实是目录才继续向下；符号链接目录不在其中。
            if target.recursive && kind == Kind::Directory {
                // 目录计入预算，超限立即返回错误。
                self.count(scan, &path)?;
                self.scan_directory(scan, index, &path)?;
            }
        }
        Ok(())
    }

    // 扫描所有目标，生成新快照和需要单独监视的符号链接文件集合。
    // 返回 Err 表示无法建立覆盖：目标权限不足或目录预算超限；普通缺失/不可读子项会被跳过。
    // 主流程：每个目标先记录祖先目录（仅身份）→ 跟随符号链接 stat 目标 → 记录目标 →
    // 若目标是目录则计入预算并递归遍历。
    // 例：目标 /work 不存在时，祖先 / 和 /work 的父级仍被记录；run 继续等待它被创建。
    fn scan(&self) -> Result<Scan, ScanError> {
        // 初始化五个集合；snapshot 最终成为 diff 的新基线。
        let mut scan = Scan {
            snapshot: Snapshot::new(),
            linked_files: HashSet::new(),
            counted: HashSet::new(),
            traversed: HashSet::new(),
            listed: HashMap::new(),
        };
        // 按输入顺序处理；同一路径在不同目标下可能产生不同记录，但先到者优先。
        for (index, target) in self.targets.iter().enumerate() {
            // 最近的祖先在前；只记录存在的祖先，用于发现整棵子树被移动/替换。
            for ancestor in ancestors(&target.path) {
                // 多个目标共享祖先时只记录一次。
                if scan.snapshot.contains_key(&ancestor) {
                    continue;
                }
                // Identity only: an ancestor's own timestamps change with every unrelated sibling.
                // 祖先用 lstat：不跟随链接，身份变化才能反映目录本身被替换。
                if let Ok(metadata) = fs::symlink_metadata(&ancestor) {
                    // 先按普通规则构造，再覆盖 size/mtime 为 0；kind/dev/ino 保留。
                    let entry = Entry {
                        size: 0,
                        mtime: (0, 0),
                        ..entry_of(&ancestor, &metadata, false, None)
                    };
                    scan.snapshot.insert(ancestor, entry);
                }
            }
            // The target may be a symbolic link to what is watched; follow it. A missing target is watched for its
            // creation; one that cannot be reached for lack of permission fails.
            // 目标自身跟随符号链接；目标指向哪里就监视哪里。
            let metadata = match fs::metadata(&target.path) {
                Ok(metadata) => metadata,
                // 权限不足说明目标存在但不可达，必须作为请求错误返回。
                Err(error) if denied(&error) => {
                    return Err(ScanError::Io(error, "stat", target.path.clone()));
                }
                // NotFound 等：目标可能尚未创建；祖先 watcher + 空快照会报告创建。
                Err(_) => continue,
            };
            // 目标记录使用 stat 结果并跟随链接。
            self.record(&mut scan, &target.path, &metadata, true);
            // 只有“文件 + 符号链接”的组合需要单独 watcher。
            if metadata.is_file()
                && fs::symlink_metadata(&target.path)
                    .is_ok_and(|link| link.file_type().is_symlink())
            {
                // 文件内容变化发生在链接目标所在目录，不会成为链接目录的事件。
                scan.linked_files.insert(target.path.clone());
            }
            // 普通文件目标不需要递归；目录才计入预算并遍历。
            if metadata.is_dir() {
                // 目标目录本身也占一个预算名额。
                self.count(&mut scan, &target.path)?;
                // 按该目标的递归/排除规则遍历。
                self.scan_directory(&mut scan, index, &target.path)?;
            }
        }
        Ok(scan)
    }

    // 把一个变化的路径映射成对调用方有意义的报告路径。
    // 如果变化发生在某个目标内部（或就是目标），原样报告；
    // 如果变化的是某个目标的祖先（例如父目录被重命名/替换），报告该目标路径，
    // 因为祖先身份变化意味着整棵子树都可能移动了。
    /// An ancestor that changed identity moved every target below it; report those targets.
    fn reported(&self, path: &str) -> String {
        // 目标内部的变化：路径本身就在覆盖范围内。
        if self
            .targets
            .iter()
            .any(|target| is_within(path, &target.path))
        {
            // 直接报告子路径，客户端能定位具体文件。
            return path.to_string();
        }
        // 反过来找“目标位于变化路径之下”的第一个目标。
        self.targets
            .iter()
            // .find 取输入顺序中的第一个；闭包判断 target.path 是否在 path 之下。
            .find(|target| is_within(&target.path, path))
            // 找不到对应目标时退回原路径，保持信息不丢失。
            .map_or_else(|| path.to_string(), |target| target.path.clone())
    }

    // 比较新旧快照，返回所有变化路径（可能重复，flush 会用 HashSet 去重）。
    // 新增、字段变化、消失都算变化；字段比较包含 kind/dev/ino/size/mtime/hash。
    // 例：文件内容改变但 size/mtime 未变时，polling 模式的 hash 仍能发现差异。
    fn diff(&self, previous: &Snapshot, next: &Snapshot) -> Vec<String> {
        let mut changed = Vec::new();
        for (path, entry) in next {
            // Option<&Entry> 与 Some(entry) 比较；缺失也会进入分支。
            if previous.get(path) != Some(entry) {
                // 路径经过归一化，可能是具体路径或目标路径。
                changed.push(self.reported(path));
            }
        }
        for path in previous.keys() {
            // 路径不见了：报告它（或包含它的目标）。
            if !next.contains_key(path) {
                changed.push(self.reported(path));
            }
        }
        changed
    }

    /// Rescan, report differences, and install watchers for new directories, rescanning until none are new.
    // 重扫、报告差异，并为新目录安装 watcher；若安装了新 watcher，再扫一轮，最多 10 轮。
    // report=false 只用于 run 的首次扫描：建立基线但不把启动前的内容当作变化。
    // 返回本轮发现的变化路径集合；错误向上抛，由调用方决定是请求错误还是 error 事件。
    // 例：扫描中发现新目录，reconcile 装上 watcher 后 report 改为 true，下一轮能捕获
    // watcher 安装前写入该目录的内容。
    fn sync(&mut self, mut report: bool) -> Result<HashSet<String>, ScanError> {
        let mut changed = HashSet::new();
        // 轮数上限防止目录不断新增时无限循环；10 轮足够追上正常创建速度。
        for _ in 0..10 {
            // 取消后不再安装 watcher 或扫描；已扫描到的 changed 由调用方丢弃。
            if self.cancelled() {
                break;
            }
            // 本轮快照；? 让预算/权限/意外 I/O 错误直接结束。
            let scan = self.scan()?;
            // 首次扫描 report=false，只更新基线，不向客户端报告历史状态。
            if report {
                changed.extend(self.diff(&self.snapshot, &scan.snapshot));
            }
            // 新快照立即成为下一轮 diff 的基线，也是 reconcile 判断目录的依据。
            self.snapshot = scan.snapshot;
            // polling 不需要 watcher；reconcile 返回 false 表示没有新增，或已降级。
            if self.mode == Mode::Polling || !self.reconcile(&scan.linked_files) {
                break;
            }
            // 每轮有新 watcher 时重置 macOS 补充重扫截止时间。
            if cfg!(target_os = "macos") {
                // 到点后 run 会 flush，捕获 FSEvents 流生效前发生的变化。
                self.settle_at = Some(Instant::now() + FSEVENTS_SETTLE);
            }
            // Something written into a new directory before its watcher existed shows up in the next round.
            // 后续轮次必须报告：新目录在 watcher 安装前可能已有写入。
            report = true;
        }
        Ok(changed)
    }

    // 根据当前快照增删原生 watcher，返回是否新增了 watcher（供 sync 决定是否再扫一轮）。
    // 覆盖对象：每个目标的所有已存在祖先目录、目标目录本身、指向文件的符号链接目标，
    // 以及 Linux/Android 上递归目标下的每个子目录（这些平台没有真正的递归 watcher）。
    // 副作用：删除失效 watcher、安装新 watcher，必要时切换到 polling 并发送 overflow 事件。
    /// Watch every existing ancestor of each target, each target directory, each target that links to a file, and on
    /// Linux each directory below a recursive target (elsewhere one recursive watcher per target). Returns whether a
    /// watcher was added.
    fn reconcile(&mut self, linked_files: &HashSet<String>) -> bool {
        // Linux inotify 需要逐目录监视；macOS/Windows 的递归 watcher 一个就够。
        let per_directory = cfg!(any(target_os = "linux", target_os = "android"));
        // 路径 → 是否需要递归监视；先用 linked_files 初始化，值统一 false。
        let mut wanted: HashMap<String, bool> = linked_files
            .iter()
            .map(|path| (path.clone(), false))
            .collect();
        // 逐个目标收集需要的路径。
        for target in &self.targets {
            // 只监视快照里确实存在且是目录的祖先；缺失的祖先等待下次扫描。
            for ancestor in ancestors(&target.path) {
                if self
                    .snapshot
                    .get(&ancestor)
                    .is_some_and(|entry| entry.kind == Kind::Directory)
                {
                    wanted.entry(ancestor).or_insert(false);
                }
            }
            // 目标本身不是目录（普通文件、链接文件或不存在）时不需要目录 watcher；
            // 文件目标靠祖先的目录事件，链接文件另有自己的 watcher。
            if self
                .snapshot
                .get(&target.path)
                .is_none_or(|entry| entry.kind != Kind::Directory)
            {
                continue;
            }
            // 目标目录；非 Linux 递归目标用一个 Recursive watcher 覆盖整棵子树。
            wanted.insert(target.path.clone(), target.recursive && !per_directory);
            // Linux/Android：把快照里目标下的每个目录都加入 wanted，均为非递归。
            if target.recursive && per_directory {
                // 只收集该目标范围内的目录；排除 target 自身（已添加）。
                for (path, entry) in &self.snapshot {
                    if entry.kind == Kind::Directory
                        && *path != target.path
                        && is_within(path, &target.path)
                    {
                        wanted.insert(path.clone(), false);
                    }
                }
            }
        }
        // Gone, or replaced: a watcher follows the directory it was installed on, not the path.
        // 找出不再需要、已消失或身份变化的 watcher；后者说明路径被替换，旧 watcher 跟着旧对象。
        let stale: Vec<String> = self
            .installed
            .iter()
            .filter(|(path, installed)| {
                // 目标不再需要覆盖。
                !wanted.contains_key(*path)
                    // 路径不存在或已经不是同一个对象：必须重建。
                    || self.snapshot.get(*path).is_none_or(|entry| {
                        entry.dev != installed.dev || entry.ino != installed.ino
                    })
            })
            .map(|(path, _)| path.clone())
            .collect();
        // 先删除记录，再尝试 unwatch；unwatch 失败不影响后续重建。
        for path in stale {
            self.installed.remove(&path);
            if let Some(native) = &mut self.native {
                // 尽力取消；后端可能已经因目录删除而自动移除。
                let _ = native.unwatch(Path::new(&path));
            }
        }
        // 是否有新增，决定 sync 是否再扫一轮。
        let mut added = false;
        // 安装缺失的 watcher。
        for (path, recursive) in wanted {
            // 扫描与协调之间目录消失：跳过，下次扫描再处理。
            let Some(entry) = self.snapshot.get(&path) else {
                continue;
            };
            // 已安装且身份未变，保持不动。
            if self.installed.contains_key(&path) {
                continue;
            }
            // 保存安装时的身份，供下一轮判断替换。
            let (dev, ino) = (entry.dev, entry.ino);
            // 懒创建：只有确实需要原生 watcher 时才创建 RecommendedWatcher。
            if self.native.is_none() {
                // notify 回调可能来自任意线程；发送端克隆进闭包，事件进入 mpsc。
                let sender = self.events_sender.clone();
                // 创建平台 watcher；失败通常意味着资源耗尽或不支持。
                match RecommendedWatcher::new(
                    move |event| drop(sender.send(event)),
                    notify::Config::default(),
                ) {
                    Ok(native) => self.native = Some(native),
                    Err(_) => {
                        // 创建失败无法继续原生覆盖：降级 polling 并告知客户端。
                        self.switch_to_polling();
                        return false;
                    }
                }
            }
            // 递归标志翻译成 notify 的 RecursiveMode。
            let mode = if recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            };
            // 安装单个路径；Ok 记录，Err 分类。
            match self.native.as_mut().unwrap().watch(Path::new(&path), mode) {
                // 安装成功。
                Ok(()) => {
                    // 解析链接别名（macOS FSEvents 用 /private/var 报告 /var）。
                    let canonical = fs::canonicalize(&path)
                        .ok()
                        .map(|canonical| canonical.to_string_lossy().into_owned())
                        // 只有规范路径与监视拼写不同才保存，节省内存并简化事件翻译。
                        .filter(|canonical| *canonical != path);
                    // 记录身份和规范路径。
                    self.installed.insert(
                        path,
                        Installed {
                            dev,
                            ino,
                            canonical,
                        },
                    );
                    // 新增了 watcher，sync 需要再扫一轮捕获安装前写入。
                    added = true;
                }
                Err(error) => {
                    // PathNotFound 或底层 NotFound/PermissionDenied 视为路径暂时消失。
                    let gone = match &error.kind {
                        notify::ErrorKind::PathNotFound => true,
                        notify::ErrorKind::Io(io) => {
                            matches!(
                                io.kind(),
                                io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
                            )
                        }
                        _ => false,
                    };
                    // Out of watches or unsupported: compare snapshots from now on, and say coverage was uncertain.
                    // 资源不足/不支持等错误：降级 polling 并发送 overflow，返回 false 停止本轮协调。
                    if !gone {
                        self.switch_to_polling();
                        return false;
                    }
                }
            }
        }
        added
    }

    // 从原生模式降级为轮询：关闭所有原生 watcher，并立即发送 overflow 事件。
    // overflow + mode polling 告诉客户端“覆盖范围不确定，之后改用快照轮询”，客户端应重新加载。
    // 已处于 polling 时直接返回，因此多个失败点可以重复调用。
    fn switch_to_polling(&mut self) {
        if self.mode == Mode::Polling {
            return;
        }
        // 模式置为 Polling 后，run 的主循环会按 poll_at 定期 flush。
        self.mode = Mode::Polling;
        // drop RecommendedWatcher 会关闭底层监视。
        self.native = None;
        // 记录一并清空，避免之后误以为还在监视。
        self.installed.clear();
        // 立即告知客户端；该事件走控制队列，先于后续 change。
        self.send(json!({ "kind": "change", "overflow": true, "mode": "polling" }));
    }

    // 判断一个事件路径是否落在某个目标的覆盖范围内。
    // 规则：目标祖先（路径是目标的上级）算相关；目标内部按 recursive 和排除规则判断；
    // 非递归目标只看直接子项；路径的任一相对分量被排除则忽略。
    // 例：目标 /a 非递归时，/a/x 相关，/a/x/y 不相关；/a/node_modules 在排除名单中时不相关。
    fn in_scope(&self, path: &str) -> bool {
        for target in &self.targets {
            // 事件发生在目标的祖先上：祖先身份变化可能移动整个目标，必须重扫。
            if is_within(&target.path, path) {
                return true;
            }
            // 路径不在目标下（或就是目标，已在上一分支处理）：换下一个目标。
            if !is_within(path, &target.path) || path == target.path {
                continue;
            }
            // 去掉目标前缀和分隔符，得到相对路径；用字节切片保持原拼写。
            let relative = &path[with_separator(&target.path).len()..];
            // 按平台分隔符拆分；空组件会被保留，但排除规则只按名字匹配。
            let components: Vec<&str> = relative.split(sys::PATH_SEPARATOR).collect();
            // 非递归目标不关心更深层的事件。
            if !target.recursive && components.len() > 1 {
                continue;
            }
            // 相对路径任一分量被排除都不相关（hidden 对任意层级生效）。
            if components.iter().any(|name| excluded(target, name)) {
                continue;
            }
            return true;
        }
        false
    }

    // 把事件路径翻译成“调用方监视时使用的拼写”。
    // macOS FSEvents 可能用解析符号链接后的 /private/var 报告 /var 下的路径；
    // installed 里保存了 canonical→watched 的对应关系，这里找最长的匹配前缀并替换。
    // 例：watched=/var/tmp，canonical=/private/var/tmp，事件 /private/var/tmp/x → /var/tmp/x。
    /// An event path in the spelling of the watched path it is under.
    fn watched_spelling(&self, path: &str) -> String {
        // (watched, canonical) 对；按 canonical 长度选最长匹配，避免短前缀误替换。
        let mut best: Option<(&str, &str)> = None;
        // 只有保存了 canonical（与 watched 拼写不同）的条目才能翻译。
        for (watched, installed) in &self.installed {
            // 事件路径必须位于 canonical 之下。
            if let Some(canonical) = &installed.canonical
                // 用分隔符边界判断前缀，避免 /private/var 匹配 /private/various。
                && is_within(path, canonical)
                // 多个可匹配时取最具体的那个。
                && best.is_none_or(|(_, longest)| canonical.len() > longest.len())
            {
                best = Some((watched, canonical));
            }
        }
        // 命中则保留 watched 前缀，拼上 canonical 之后的路径后缀。
        match best {
            // suffix 为空（路径等于 canonical）或以分隔符开头，不会重复分隔符。
            Some((watched, canonical)) => format!("{watched}{}", &path[canonical.len()..]),
            None => path.to_string(),
        }
    }

    // 处理一个 notify 事件，返回是否需要安排一次重扫/刷新。
    // 原生事件不直接产生 change 路径：它只把相关路径加入 events，并触发去抖 flush。
    // Access 事件（读）被忽略；Rescan/空路径（事件丢失）直接要求重扫。
    /// Note a native event; returns whether it calls for a rescan.
    fn on_event(&mut self, event: notify::Result<Event>) -> bool {
        let event = match event {
            Ok(event) => event,
            Err(error) => {
                // 出错事件通常表示被监视目录消失或后端失败；先删掉相关 installed 记录，
                // 重扫会重新判断路径是否存在并重建 watcher，或在资源不足时降级 polling。
                // A watched directory that disappears or fails: rescan, which also replaces its watcher.
                // 错误携带的路径用 lossy 字符串与 installed 的键比较。
                for path in &error.paths {
                    // 删除记录；对应的原生 watcher 可能已失效，native 对象仍会在 drop/unwatch 时清理。
                    self.installed.remove(&*path.to_string_lossy());
                }
                return true;
            }
        };
        // Reads are not changes (libuv does not ask for them).
        // 读取不会改变文件内容；libuv 也不订阅 access 事件，忽略以免无谓重扫。
        if matches!(event.kind, EventKind::Access(_)) {
            return false;
        }
        // 后端明确要求重扫（事件队列溢出等），或事件没有路径：直接重扫。
        if event.need_rescan() || event.paths.is_empty() {
            return true;
        }
        // 只有至少一个相关路径才需要安排 flush。
        let mut flush = false;
        // 逐个事件路径处理；同一事件可能带多个路径（重命名）。
        for path in &event.paths {
            // 先统一拼写，再做范围判断和报告。
            let path = self.watched_spelling(&path.to_string_lossy());
            // 目标祖先的无关兄弟、被排除的条目都不在范围内，忽略它们。
            // Events about unrelated siblings of an ancestor, or about excluded entries, are ignored.
            // 路径在覆盖范围内。
            if self.in_scope(&path) {
                // 归一化成具体路径或目标路径。
                let reported = self.reported(&path);
                // HashSet 去重；同一路径的多次事件只保留一次。
                self.events.insert(reported);
                // 至少有一个相关路径，调用方需要安排去抖 flush。
                flush = true;
            }
        }
        flush
    }

    // 执行一次重扫并发送变化；返回 watcher 是否继续运行。
    // 成功：把本轮 diff 与之前累积的事件路径合并、按 JS 顺序排序，非空且未取消时发 change 事件。
    // 失败：发 error 事件并返回 false，请求结束（协议规定 error 之后不再有事件）。
    /// Rescan and report what changed; an error ends the watcher.
    fn flush(&mut self) -> bool {
        // 先取走事件集合，sync 期间新到的事件留在通道里，下一轮处理。
        let events = std::mem::take(&mut self.events);
        // 重扫并报告差异；sync 内部可能重装 watcher。
        match self.sync(true) {
            // diff 结果 + 原生事件路径。
            Ok(mut changed) => {
                // HashSet 自动去重；同一路径来自事件和快照只报一次。
                changed.extend(events);
                // 没有变化不发空事件；取消后不再发送。
                if !changed.is_empty() && !self.cancelled() {
                    // HashSet 转 Vec 以便排序。
                    let mut paths: Vec<String> = changed.into_iter().collect();
                    // 统一成客户端 JS 的排序顺序，便于比较。
                    sort_like_javascript(&mut paths);
                    // change_event 处理超大列表的 overflow 回退。
                    self.send(change_event(paths));
                }
                true
            }
            Err(error) => {
                // failure().message 已含 Node 风格的 code/syscall/path 文案。
                let message = error.failure().message;
                // code 区分 permission_denied 与 invalid；message 用于诊断。
                self.send(json!({ "kind": "error", "code": error.code(), "message": message }));
                false
            }
        }
    }
}

// 构造 change 事件：正常情况下带 paths 数组；若序列化后的 JSON 超过 MAX_PAYLOAD，
// 改成 overflow 事件，让客户端做全量重扫，而不是发送一个会超过帧上限、可能终止连接的帧。
// MAX_PAYLOAD 已为外层帧头和 JSON 预留 64 KiB；这里的事件 JSON 本身就是帧头 JSON。
/// A `change` event listing `paths`, or an `overflow` one when the list would not fit in a frame: a frame that is too
/// large would end the connection's output.
fn change_event(paths: Vec<String>) -> Value {
    // 先构造完整事件；paths 已由调用方排序。
    let event = json!({ "kind": "change", "paths": paths });
    // 序列化失败也按 overflow 处理（保守），map_or(true, ...) 把 Err 当“太大”。
    if serde_json::to_vec(&event).map_or(true, |json| json.len() > MAX_PAYLOAD) {
        // 不带 paths 和 mode；客户端收到后应重新扫描。
        return json!({ "kind": "change", "overflow": true });
    }
    event
}

// 把线上 `targets` 数组解析成 Target；这是协议输入的信任边界，必须做运行时校验。
// 返回 Err 表示请求缺少 targets 数组或某个目标缺少字符串 path；recursive/hidden/names 缺省为 false/空。
// 例：{"targets":[{"path":"/work","recursive":true,"exclude":{"hidden":true,"names":["tmp"]}}]}
// 得到 1 个递归目标，排除点号开头的名字和名字 tmp。
fn parse_targets(json: &Value) -> Result<Vec<Target>, Failure> {
    // 统一的 EINVAL 构造闭包；零捕获闭包可复制，因此能在多个 ? 处重复使用。
    let invalid = || Failure::new("EINVAL", "watch needs targets");
    // 用索引访问 JSON；缺失得到 Null，as_array 失败即 EINVAL。
    json["targets"]
        .as_array()
        // 非数组直接返回错误；? 提前结束。
        .ok_or_else(invalid)?
        .iter()
        .map(|target| {
            Ok(Target {
                // path 必须是 JSON 字符串；类型不对报 EINVAL。
                path: target["path"].as_str().ok_or_else(invalid)?.to_string(),
                // 缺省 false；类型不对也按 false 处理（宽松解析，与 Node 选项一致）。
                recursive: target["recursive"].as_bool().unwrap_or(false),
                // exclude 或 hidden 缺失时为 false。
                hidden: target["exclude"]["hidden"].as_bool().unwrap_or(false),
                // names 缺失/非数组时为空集合。
                names: target["exclude"]["names"]
                    .as_array()
                    // 数组里非字符串元素被 filter_map 丢掉，而不是让整个请求失败。
                    .map(|names| {
                        names
                            .iter()
                            // 只保留字符串名字。
                            .filter_map(|name| name.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect()
}

// watch 请求入口：解析参数、选择模式、建立首次覆盖，发送 ready 后进入事件循环。
// 参数 id 是请求 id，json 是线上参数，output/control 提供发送与取消；返回 Ok({}) 表示正常结束，
// Err 表示建立覆盖失败（此时还没有 ready）。运行中扫描错误改为发 error 事件，然后同样返回 Ok({})。
// 主循环同时等待：notify 事件、去抖截止、macOS settle 截止、polling 截止、取消检查。
/// Watch until cancelled: a `ready` event once coverage is established, then `change` events, or an `error` event
/// after which nothing follows.
pub fn run(id: u32, json: &Value, output: &Output, control: &Control) -> Result<Value, Failure> {
    let targets = parse_targets(json)?;
    // 模式选择：客户端显式指定 native/polling 时优先采用（便于测试/特殊文件系统）；
    // 否则 Windows（原生 watcher 会阻止父目录重命名）或不可靠文件系统用 polling，其余 native。
    // Windows refuses to rename a directory while a directory below it is open, and native watchers keep watched
    // directories open, so Windows polls, as do file systems that do not report remote changes.
    let mode = match json["mode"].as_str() {
        // 显式强制原生事件模式。
        Some("native") => Mode::Native,
        // 显式强制快照轮询。
        Some("polling") => Mode::Polling,
        // 未指定或未知字符串：按平台/文件系统自动选择。
        _ if cfg!(windows) || any_unreliable(&targets) => Mode::Polling,
        _ => Mode::Native,
    };
    // 标准 mpsc 通道：notify 回调发送，run 线程接收；事件只在本请求内使用。
    let (events_sender, events) = mpsc::channel();
    let mut watcher = FileWatcher {
        id,
        output,
        control,
        targets,
        mode,
        // 毫秒转 Duration；缺省 2000ms。
        poll_interval: Duration::from_millis(
            json["pollIntervalMs"].as_u64().unwrap_or(DEFAULT_POLL_MS),
        ),
        max_directories: json["maxDirectories"]
            .as_u64()
            // u64 → usize；缺省 10000。
            .map_or(DEFAULT_MAX_DIRECTORIES, |max| max as usize),
        snapshot: Snapshot::new(),
        native: None,
        events_sender,
        installed: HashMap::new(),
        events: HashSet::new(),
        settle_at: None,
    };
    // 建立基线并安装 watcher；失败直接返回请求错误，不发 ready。
    watcher.sync(false).map_err(|error| error.failure())?;
    // 覆盖已建立，告诉客户端当前模式；之后才会有 change。
    watcher.send(json!({ "kind": "ready", "mode": watcher.mode.name() }));
    // 原生事件去抖截止；None 表示没有待处理的 flush。
    let mut flush_at: Option<Instant> = None;
    // polling 模式的下一次扫描时间；从建立覆盖后开始计时。
    let mut poll_at = Instant::now() + watcher.poll_interval;
    // 主循环：先检查取消，再在多个截止时间中选择最早的醒来点。
    loop {
        // 取消是轮询检查的，CANCEL 本身不会写入事件通道。
        if watcher.cancelled() {
            // 与 main.rs 约定：取消后请求成功结束（结果空对象）。
            return Ok(json!({}));
        }
        // 以当前时刻为基准计算等待上限，避免用过期时间导致忙等。
        let now = Instant::now();
        // 默认最多睡 100ms 以便发现取消。
        let mut wake = now + CANCEL_POLL;
        // flush/settle 截止时间；flatten 跳过 None。
        for at in [flush_at, watcher.settle_at].into_iter().flatten() {
            // 取最早截止。
            wake = wake.min(at);
        }
        // polling 模式还要考虑下一次快照时间。
        if watcher.mode == Mode::Polling {
            wake = wake.min(poll_at);
        }
        // 等待 notify 事件或任一截止时间；saturating 防止 wake 已过时下溢 panic。
        match events.recv_timeout(wake.saturating_duration_since(now)) {
            // 原生事件：on_event 判断是否相关；只有 native 模式才安排去抖。
            Ok(event) => {
                // 已有 flush 待处理时不重复推迟，保持固定去抖窗口；polling 模式不依赖事件。
                if watcher.on_event(event) && flush_at.is_none() && watcher.mode == Mode::Native {
                    // 50ms 后统一 flush，合并短时间内的事件。
                    flush_at = Some(Instant::now() + DEBOUNCE);
                }
            }
            // 没有事件，继续检查截止时间。
            Err(RecvTimeoutError::Timeout) => {}
            // FileWatcher 自身持有发送端，通道不会在 watcher 存活时断开；断开说明代码不变量被破坏。
            Err(RecvTimeoutError::Disconnected) => unreachable!("the watcher holds a sender"),
        }
        // 等待可能耗时，重新取时间判断截止。
        let now = Instant::now();
        // 截止时间已到；None 视为未安排。
        let due = |at: Option<Instant>| at.is_some_and(|at| at <= now);
        // polling 模式下到达下一次扫描时间。
        let polling_due = watcher.mode == Mode::Polling && poll_at <= now;
        // 任一到点就 flush 一次。
        if due(flush_at) || due(watcher.settle_at) || polling_due {
            // 先清空截止，flush 内可能再次安排新的 settle。
            if due(flush_at) {
                flush_at = None;
            }
            // 同理清除 macOS 补充重扫截止。
            if due(watcher.settle_at) {
                watcher.settle_at = None;
            }
            // 扫描失败已发 error 事件，结束请求。
            if !watcher.flush() {
                return Ok(json!({}));
            }
            // 只有本轮是轮询触发才推进下一次轮询；事件触发的 flush 不顺延轮询时间。
            if polling_due {
                // 从本次 flush 结束时刻重新计时。
                poll_at = Instant::now() + watcher.poll_interval;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 小列表原样序列化，不带 overflow；paths 顺序保持调用方传入的顺序（调用方已排序）。
    #[test]
    fn change_event_lists_paths_that_fit() {
        // 构造事件并直接比较 JSON 值，验证字段名和结构符合协议。
        let event = change_event(vec!["/a".to_string(), "/b".to_string()]);
        assert_eq!(event, json!({ "kind": "change", "paths": ["/a", "/b"] }));
    }

    // 4096 字节的路径重复到序列化长度超过 MAX_PAYLOAD；事件应退化为 overflow，而不是超长帧。
    #[test]
    fn change_event_overflows_when_paths_do_not_fit_in_a_frame() {
        // 单个很长的路径，避免依赖文件系统。
        let path = "x".repeat(4096);
        // 比“刚好超过上限”的条数多 1，确保 to_vec 长度一定超限。
        let count = MAX_PAYLOAD / path.len() + 1;
        // 大量相同路径；change_event 只关心最终 JSON 大小。
        let event = change_event(vec![path; count]);
        // 回退事件不带 paths，客户端应做全量重扫。
        assert_eq!(event, json!({ "kind": "change", "overflow": true }));
    }
}
