//! pi-env: a small daemon that gives a Pi Durable host an execution environment on this machine over stdin/stdout
//! (docs/protocol.md). Started as `pi-env serve --token <hex>`, usually through `ssh`.
//
// 文件导读（packages/env/daemon/src/main.rs）
// 所属包/模块：packages/env 的 Rust daemon（Cargo 包名 pi-env）的可执行入口；它把 stdin/stdout 上的帧协议
// （docs/protocol.md）翻译成本机文件、命令、PTY 与目录遍历操作。
// 解决的问题与职责边界：读取客户端帧、校验并分发 op、管理句柄/取消/运行中的终端与进程、把一个写线程作为唯一
// stdout 出口、检测连接静默并在断连时清理所有进程组。路径解析、错误码映射和部分分块策略在 TypeScript 客户端，
// 本文件只实现协议规定的 daemon 侧语义。
// 上游入口：`ssh` 启动 `pi-env serve --token <hex>`（或本地测试直接启动）；客户端在 stdout 读到
// `PI-ENV <token>` 后开始发送帧。
// 下游依赖：frame（读写帧）、output（唯一写线程与优先级队列）、fs/scan/list（文件操作）、exec/pty/process
// （命令）、watch（文件监控）、sys（平台差异）、errors（协议错误）。
// 能力清单（按导出/主要项）：
//   - 模块声明：把上述子模块编进同一个二进制。
//   - 常量：PROTOCOL、FEATURES、VERSION、PING_INTERVAL、SILENCE_LIMIT_MS、SCAN_CHUNK、WORKERS、MAX_HANDLES、
//     CONTROL_PAYLOAD，分别描述协议版本、能力列表、版本、心跳、静默上限、扫描块、工作线程数、句柄上限和
//     控制帧 payload 阈值。
//   - FileHandle/Serial/DirHandle/Handle：连接内文件与目录句柄；文件分块写按到达顺序串行。
//   - Server：共享状态与 dispatch；每个 op 转调对应模块。
//   - now_ms/field/number/flag：请求字段的运行时校验（wire input 信任边界）。
//   - scan_lines：分块调用 LineScanner，支持取消。
//   - kill_all：连接结束时终止所有已启动进程组。
//   - Seen<R>：包装 stdin，记录最后一次收到字节的时间用于静默检测。
//   - start_workers/respond/run_in_order/serve_frames：线程池、请求回复、按句柄串行化、帧循环。
//   - serve/main：连接生命周期与命令行入口。
// 组合关系/典型调用顺序：
//   main -> serve -> 打印 token -> 启动 Output 写线程与心跳线程 -> serve_frames
//   -> read_frame -> REQUEST -> 登记 Control -> 线程池或独立线程 respond -> dispatch -> 子模块
//   -> output.control/bulk 回复 -> stdin EOF/静默后 kill_all、output.close、join 写线程。
// 示例（真实用法，不是可独立运行的代码块）：
//   pi-env serve --token 0123abcd
//   客户端随后发送 {"op":"hello"}，收到 RESULT 帧，JSON 含 protocol/version/os/features 等字段。
// 建议阅读顺序：先看常量与 Server/Handle 类型，再看 dispatch 的 op 列表，然后 serve_frames 的调度规则，
// 最后 serve/main 的连接生命周期。

// 子模块声明：每个 mod 对应 src 下的一个文件目录项；它们共享同一 crate，可直接互相调用 pub 项。
mod decode;
mod errors;
mod exec;
mod frame;
mod fs;
mod list;
mod output;
mod process;
mod pty;
mod scan;
mod sys;
mod watch;
mod window;

use errors::Failure;
use exec::Control;
use frame::{CANCEL, ERROR, Frame, PING, REQUEST, RESULT};
use output::Output;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::env;
use std::fs::{File, ReadDir};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// 协议版本号；客户端用它判断 daemon 是否兼容。
const PROTOCOL: u64 = 1;
/// Operations added after protocol 1's first release; clients check `hello.features` before using them.
// 老 daemon 不认这两个 op；客户端先看 hello.features 再决定是否调用。
const FEATURES: &[&str] = &["listFiles", "process"];
/// The npm package version this daemon ships with (build.rs).
// env! 是编译期宏：build.rs 把 npm 包版本写进环境变量，运行时字符串已内嵌到二进制。
const VERSION: &str = env!("PI_ENV_VERSION");
// 双向心跳间隔 5 秒；接收方忽略 PING 帧，只用于保持/检测连接。
const PING_INTERVAL: Duration = Duration::from_secs(5);
// 30 秒没有收到任何字节就认为客户端失联，daemon 杀进程并退出。
const SILENCE_LIMIT_MS: u64 = 30_000;
// scanLines 每次从文件读取的块大小；跨块状态保存在 LineScanner。
const SCAN_CHUNK: usize = 64 * 1024;
/// Threads for file operations; commands run on their own threads.
// 固定大小线程池处理普通文件操作；长任务另开线程，避免占满池。
const WORKERS: usize = 16;
/// Open handles per connection, beyond which opening fails with `EMFILE`.
const MAX_HANDLES: usize = 4096;
/// Replies with larger payloads queue behind command output instead of going first.
// 超过 64KiB 的回复不再抢占控制通道，否则大 JSON 会阻塞心跳/取消等小帧。
const CONTROL_PAYLOAD: usize = 64 * 1024;

// 连接内一个打开的文件句柄；Arc 让多个请求共享，failed/serial 提供并发控制。
struct FileHandle {
    file: File,
    // 用于错误消息中的路径，不用于重新打开文件。
    path: String,
    /// A failed chunk write poisons a write handle, so later chunks cannot leave a gap.
    // 一旦某次 writeChunk 部分/失败，后续块必须失败，否则客户端会误以为文件连续。
    failed: AtomicBool,
    /// Chunk writes run one at a time in arrival order, though the client sends several at once.
    // 客户端可能并发发多个 writeChunk；这里把它们排成队列，由线程池逐个执行。
    serial: Mutex<Serial>,
}

// 串行队列状态：jobs 待执行，running 表示已有线程在清空该队列。
#[derive(Default)]
struct Serial {
    jobs: VecDeque<Job>,
    running: bool,
}

// 打开的目录句柄：ReadDir 是平台目录迭代器；path 用于错误消息。
struct DirHandle {
    entries: ReadDir,
    path: String,
}

// 句柄枚举：文件句柄可被多个请求共享（Arc），目录句柄用 Mutex 保护迭代器（ReadDir 需要 &mut）。
enum Handle {
    File(Arc<FileHandle>),
    Dir(Arc<Mutex<DirHandle>>),
}

// 线程池任务类型：Box<dyn FnOnce() + Send> 表示“只能执行一次、可跨线程移动、返回 ()”的闭包。
type Job = Box<dyn FnOnce() + Send>;

// 所有请求共享的 server 状态；字段各自有锁或原子类型，避免全局一把大锁。
struct Server {
    output: Arc<Output>,
    // 临时目录，用于 spill 文件等；hello 也把它报告给客户端。
    tmpdir: String,
    // 句柄表：id -> Handle；Mutex 保护整个 HashMap。
    handles: Mutex<HashMap<u64, Handle>>,
    // 单调递增的句柄 id；Relaxed 足够，因为唯一性由 fetch_add 保证。
    next_handle: AtomicU64,
    // 进行中请求的取消状态：请求 id -> Control。
    controls: Mutex<HashMap<u32, Arc<Control>>>,
    // 已启动进程组；类型别名来自 exec。
    groups: exec::Groups,
    // 运行中的终端与进程表，分别供 pty/process 的后续请求查找。
    terminals: pty::Terminals,
    processes: process::Processes,
}

// 当前 Unix 毫秒时间戳；系统时间早于 epoch 或不可表示时返回 0（而不是 panic）。
// 例：用于 Seen 记录最后活动时间，以及在心跳线程中与当前时间比较。
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

// 取必填字符串字段；这是 wire input 的运行时校验，类型系统不知道 JSON 内容。
// 例：field(&json!({"path":"/tmp/a"}), "path") 返回 Ok("/tmp/a")；缺字段返回 EINVAL。
fn field<'a>(json: &'a Value, key: &str) -> Result<&'a str, Failure> {
    // 'a 让返回的 &str 借用输入，避免复制；ok_or_else 只失败时构造错误。
    json[key]
        .as_str()
        .ok_or_else(|| Failure::new("EINVAL", format!("missing field {key}")))
}

// 取必填无符号整数字段；缺失、负数/小数或类型错误都返回 EINVAL。
// 例：number(&json!({"size":12}), "size") 返回 Ok(12)；缺失 size 返回 EINVAL。
fn number(json: &Value, key: &str) -> Result<u64, Failure> {
    json[key]
        .as_u64()
        .ok_or_else(|| Failure::new("EINVAL", format!("missing or invalid field {key}")))
}

// 取可选布尔字段；缺失或非布尔按 false 处理（与各 op 的默认值配合使用）。
// 例：flag(&json!({"append":true}), "append") 为 true；字段缺失时为 false。
fn flag(json: &Value, key: &str) -> bool {
    json[key].as_bool().unwrap_or(false)
}

impl Server {
    // 按请求里的 handle 字段查找文件句柄；目录句柄或未知 id 都返回 EBADF。
    // 例：json 含 {"handle":3} 且 3 是文件句柄时返回 Arc<FileHandle>；3 是目录时返回 EBADF。
    fn file(&self, json: &Value) -> Result<Arc<FileHandle>, Failure> {
        // get 返回 Option<&Handle>；clone Arc 后立即释放锁（match 结束）。
        match self.handles.lock().unwrap().get(&number(json, "handle")?) {
            Some(Handle::File(file)) => Ok(file.clone()),
            Some(Handle::Dir(_)) => Err(Failure::new("EBADF", "not a file handle")),
            None => Err(Failure::new("EBADF", "unknown handle")),
        }
    }

    // 插入新句柄并分配 id；超过 MAX_HANDLES 时返回 EMFILE，防止耗尽文件描述符。
    // 例：第一次成功插入返回 1，下一次返回 2，直到 4096 个句柄后开始报 EMFILE。
    fn insert(&self, handle: Handle) -> Result<u64, Failure> {
        let mut handles = self.handles.lock().unwrap();
        if handles.len() >= MAX_HANDLES {
            return Err(Failure::new("EMFILE", "EMFILE: too many open files"));
        }
        // fetch_add 返回旧值作为本次 id；Relaxed 不用于同步其他内存。
        let id = self.next_handle.fetch_add(1, Ordering::Relaxed);
        handles.insert(id, handle);
        Ok(id)
    }

    // 把已打开文件包装成 FileHandle 并插入句柄表；成功返回 id。
    // 例：write 带 keep=true 时调用 insert_file(file, path)，返回 {handle} 给客户端继续 writeChunk。
    fn insert_file(&self, file: File, path: &str) -> Result<u64, Failure> {
        self.insert(Handle::File(Arc::new(FileHandle {
            file,
            path: path.to_string(),
            failed: AtomicBool::new(false),
            serial: Mutex::new(Serial::default()),
        })))
    }

    // 分发一个请求：校验 op 并调用对应模块；返回 (JSON, payload) 或 Failure。
    // 这是所有文件/命令操作的总入口，也是 op 名称与实现之间的映射表。
    // 例：{"op":"hello"} 返回 (含 protocol/version/features 的 JSON, 空 payload)；
    //     {"op":"lstat","path":"/x"} 转调 fs::lstat。
    fn dispatch(
        &self,
        id: u32,
        json: &Value,
        payload: Vec<u8>,
        control: &Control,
    ) -> Result<(Value, Vec<u8>), Failure> {
        // 帧层把无法解析的 JSON 表示为 Value::Null；这里统一回复 EINVAL，而不是结束连接。
        if json.is_null() {
            return Err(Failure::new("EINVAL", "invalid JSON"));
        }
        // op 缺失或不是字符串时得到 ""；下面会落到 unknown operation 分支。
        let op = json["op"].as_str().unwrap_or_default();
        // 闭包把只返回 JSON 的操作统一包装成 (JSON, 空 payload)，减少重复的 Vec::new()。
        let plain = |value: Result<Value, Failure>| value.map(|value| (value, Vec::new()));
        match op {
            "hello" => plain(Ok(json!({
                // 协议版本与 daemon 打包版本。
                "protocol": PROTOCOL,
                "version": VERSION,
                // env::consts 是编译目标信息（linux/macos/windows；x86_64/aarch64）。
                "os": env::consts::OS,
                "arch": env::consts::ARCH,
                // 远程 home、路径分隔符、临时目录、当前目录与 Windows 盘符 cwd 规则。
                "home": sys::home(),
                "separator": sys::PATH_SEPARATOR,
                "tmpdir": self.tmpdir,
                "cwd": sys::cwd(),
                "driveCwds": sys::drive_cwds(),
                "pid": std::process::id(),
                // 能力列表，客户端据此判断 listFiles/process 是否可用。
                "features": FEATURES,
            }))),
            "lstat" => plain(fs::lstat(field(json, "path")?)),
            "realpath" => plain(fs::realpath(field(json, "path")?)),
            "write" => {
                let path = field(json, "path")?;
                // parents 默认 true，与 Node 的递归 mkdir 行为一致；显式 false 才不补父目录。
                let parents = json["parents"].as_bool().unwrap_or(true);
                // append=true 追加，否则截断；payload 是本次要写入的字节。
                let file = fs::write(path, flag(json, "append"), parents, &payload)?;
                // keep=false（默认）写完即关闭；keep=true 保留句柄供 writeChunk 继续写。
                if !flag(json, "keep") {
                    return plain(Ok(json!({})));
                }
                // 插入文件句柄并返回其 id。
                plain(Ok(json!({ "handle": self.insert_file(file, path)? })))
            }
            "writeChunk" => {
                let handle = self.file(json)?;
                // 之前有块写失败时，句柄已被标记 poisoned；后续块一律 EBADF。
                if handle.failed.load(Ordering::SeqCst) {
                    return Err(Failure::new("EBADF", "an earlier write failed"));
                }
                // 直接把 payload 写到句柄；失败时设置 failed 并报告带路径的 write 错误。
                (&handle.file).write_all(&payload).map_err(|error| {
                    handle.failed.store(true, Ordering::SeqCst);
                    Failure::io(&error, "write", &handle.path)
                })?;
                plain(Ok(json!({})))
            }
            "truncate" => plain(fs::truncate(field(json, "path")?, number(json, "size")?)),
            "fsync" => plain(fs::fsync(field(json, "path")?)),
            "rename" => plain(fs::rename(field(json, "path")?, field(json, "to")?)),
            "mkdir" => plain(fs::mkdir(field(json, "path")?, flag(json, "recursive"))),
            "rm" => plain(fs::rm(
                field(json, "path")?,
                flag(json, "recursive"),
                flag(json, "force"),
            )),
            "mkdtemp" => plain(fs::mkdtemp(field(json, "path")?)),
            "open" => {
                let path = field(json, "path")?;
                // mode=="read" 对应 Node 的 open(path,"r")：任意类型文件、阻塞读。
                if json["mode"].as_str() == Some("read") {
                    // Node's `open(path, "r")`: any kind of file, blocking; reads report what the file is.
                    let file = sys::open(path, sys::OpenMode::Read)
                        .map_err(|error| Failure::io(&error, "open", path))?;
                    // stat 失败不使整个 open 失败：结果里带 statError，客户端读文件时再遇错。
                    let stat = match file.metadata() {
                        Ok(metadata) => json!({ "stat": fs::info(path, &metadata) }),
                        Err(error) => {
                            json!({ "statError": Failure::io(&error, "fstat", path).to_json() })
                        }
                    };
                    let mut result = stat;
                    // 句柄用于后续 pread/fstat/scanLines。
                    result["handle"] = json!(self.insert_file(file, path)?);
                    return plain(Ok(result));
                }
                // 默认是 openBinaryReader：非阻塞、只接受普通文件，可拒绝最终符号链接。
                let (file, info) = fs::open_reader(path, flag(json, "noFollow"))?;
                plain(Ok(
                    json!({ "handle": self.insert_file(file, path)?, "info": info }),
                ))
            }
            "pread" => {
                let handle = self.file(json)?;
                // 请求长度不能超过单帧 payload 上限；min 截断而非报错。
                let length = (number(json, "length")? as usize).min(frame::MAX_PAYLOAD);
                // 有 offset 用定位读，不改变共享文件位置；没有则顺序读当前位置。
                let bytes = match json["offset"].as_u64() {
                    Some(offset) => fs::pread(&handle.file, &handle.path, offset, length)?,
                    None => fs::read(&handle.file, &handle.path, length)?,
                };
                // 元数据 JSON 为空对象，二进制内容走 payload。
                Ok((json!({}), bytes))
            }
            "fstat" => {
                let handle = self.file(json)?;
                // 查询已打开句柄的元数据；失败报告 fstat。
                let metadata = handle
                    .file
                    .metadata()
                    .map_err(|error| Failure::io(&error, "fstat", &handle.path))?;
                plain(Ok(fs::info(&handle.path, &metadata)))
            }
            "scanLines" => {
                let handle = self.file(json)?;
                plain(scan_lines(&handle.file, &handle.path, json, control))
            }
            "opendir" => {
                let path = field(json, "path")?;
                // read_dir 返回平台迭代器；错误按 opendir 报告。
                let entries =
                    sys::read_dir(path).map_err(|error| Failure::io(&error, "opendir", path))?;
                // 目录句柄必须用 Mutex，因为 readdir 需要 &mut 迭代器。
                let handle = self.insert(Handle::Dir(Arc::new(Mutex::new(DirHandle {
                    entries,
                    path: path.to_string(),
                }))))?;
                plain(Ok(json!({ "handle": handle })))
            }
            "readdir" => plain(self.read_dir(json)),
            // listFiles 需要取消函数：读取共享的 aborted 标志。
            "listFiles" => list::run(json, &|| control.aborted.load(Ordering::SeqCst)),
            "close" => {
                // remove 丢弃句柄；文件/目录随 Arc 的最后一个引用一起关闭。
                self.handles
                    .lock()
                    .unwrap()
                    .remove(&number(json, "handle")?);
                plain(Ok(json!({})))
            }
            "exec" => plain(exec::run(
                id,
                exec::ExecRequest::from_json(json)?,
                &self.tmpdir,
                &self.output,
                control,
                &self.groups,
            )),
            "watch" => plain(watch::run(id, json, &self.output, control)),
            "pty" => plain(pty::run(
                id,
                pty::PtyRequest::from_json(json)?,
                &self.output,
                control,
                &self.groups,
                &self.terminals,
            )),
            "process" => plain(process::run(
                id,
                process::ProcessRequest::from_json(json)?,
                &self.output,
                control,
                &self.groups,
                &self.processes,
            )),
            // 未知 op：协议错误，但连接继续。
            _ => Err(Failure::new("EINVAL", format!("unknown operation {op}"))),
        }
    }

    // 分页读取一个目录句柄，最多 max 条；done 表示迭代器已到末尾。
    // 只锁目标目录，不锁整个句柄表，因此慢目录不会阻塞其他请求。
    // 例：{"handle":2,"max":100} 返回 {"entries":[...],"done":false}；下次请求继续从迭代器当前位置读。
    fn read_dir(&self, json: &Value) -> Result<Value, Failure> {
        // max 至少为 1，避免 0 导致调用方误以为还有数据却拿不到。
        let max = number(json, "max")?.max(1) as usize;
        // Lock only this directory, so other requests are not held up by a slow listing.
        // 在句柄表锁内只取出 Arc<Mutex<DirHandle>> 并 clone，随后释放表锁。
        let dir = match self.handles.lock().unwrap().get(&number(json, "handle")?) {
            Some(Handle::Dir(dir)) => dir.clone(),
            _ => return Err(Failure::new("EBADF", "not a directory handle")),
        };
        // 目录锁持续到本页读完；同一目录的并发 readdir 会串行。
        let mut dir = dir.lock().unwrap();
        let mut entries = Vec::new();
        let mut done = false;
        while entries.len() < max {
            match dir.entries.next() {
                // None 表示目录迭代结束。
                None => {
                    done = true;
                    break;
                }
                // 迭代错误（例如读取中目录被删）使整页失败。
                Some(Err(error)) => return Err(Failure::io(&error, "readdir", &dir.path)),
                // 每项转成 {name, raw?, info|error}；不会因单项 lstat 失败而失败整页。
                Some(Ok(entry)) => entries.push(fs::dir_entry(&dir.path, &entry.file_name())),
            }
        }
        Ok(json!({ "entries": entries, "done": done }))
    }
}

// 分块扫描文件的行区间：从 position 开始读 SCAN_CHUNK 字节，喂给 LineScanner，EOF 时 finish。
// 每块前检查取消；读取错误保留 read 系统调用名；成功返回 LineScan JSON。
// 例：{"handle":4,"startLine":10,"endLine":20} 返回该区间及第一行的边界与解码字节数。
fn scan_lines(file: &File, path: &str, json: &Value, control: &Control) -> Result<Value, Failure> {
    let start_line = number(json, "startLine")?;
    // endLine 可选：None 表示扫到文件尾。
    let end_line = json["endLine"].as_u64();
    // 空区间或倒置区间没有意义；end_line==start_line 也拒绝。
    if end_line.is_some_and(|end| end <= start_line) {
        return Err(Failure::new("EINVAL", "Invalid line range"));
    }
    let mut scanner = scan::LineScanner::new(start_line, end_line);
    // 复用同一缓冲，避免每块分配。
    let mut buffer = vec![0u8; SCAN_CHUNK];
    let mut position = 0u64;
    loop {
        // 取消在块之间生效：scanLines 不中断正在进行的单次系统调用。
        if control.aborted.load(Ordering::SeqCst) {
            return Err(Failure::new("aborted", "aborted"));
        }
        // read_at 是定位读，不改变共享文件位置；错误按 read 报告。
        let read = sys::read_at(file, &mut buffer, position)
            .map_err(|error| Failure::io(&error, "read", path))?;
        if read == 0 {
            // EOF：finish 会补齐 BOM/边界状态并返回最终 JSON。
            return Ok(scanner.finish());
        }
        // 只把实际读到的前缀交给扫描器；position 同步推进。
        scanner.push(&buffer[..read]);
        position += read as u64;
    }
}

// 终止所有已登记的进程组；连接结束、静默超时与信号处理都会调用。
// 例：stdin EOF 后 serve 调 kill_all(&server.groups)，仍在运行的 exec/pty/process 全部被杀。
fn kill_all(groups: &exec::Groups) {
    // 只读迭代引用，不在迭代时修改集合；kill 本身不依赖锁外状态。
    for pid in groups.lock().unwrap().iter() {
        exec::kill_group(*pid);
    }
}

/// Stdin that records when bytes last arrived, so a large frame arriving slowly counts as a live client.
// 泛型 R 是任意 Read；Seen 在每次成功读取后更新时间戳，供心跳线程判断客户端是否还活着。
struct Seen<R> {
    inner: R,
    // 与心跳线程共享的毫秒时间戳；AtomicU64 允许无锁写入。
    last_seen: Arc<AtomicU64>,
}

// 为 Seen<R> 实现标准库 Read trait；这样 BufReader 可以透明地包装它。
// 例：read_frame 每读到一段字节，Seen 在返回前更新 last_seen；EOF 的 0 字节不更新。
impl<R: Read> Read for Seen<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        // 先执行真实读取；? 让错误原样传播。
        let read = self.inner.read(buffer)?;
        // 只有读到至少一字节才算“有活动”；EOF 的 0 不更新时间。
        if read > 0 {
            self.last_seen.store(now_ms(), Ordering::Relaxed);
        }
        Ok(read)
    }
}

// 启动固定数量的工作线程，返回生产者端。Receiver 放在 Mutex 中以便多线程共享（mpsc Receiver 不能 clone）。
// 例：serve_frames 启动后调用 start_workers()，之后对每个普通文件操作发送一个 Job。
fn start_workers() -> Sender<Job> {
    let (jobs, queue) = mpsc::channel::<Job>();
    let queue = Arc::new(Mutex::new(queue));
    for _ in 0..WORKERS {
        // 每轮 clone Arc 并 move 进线程；类型标注帮助推断 Receiver<Job>。
        let queue: Arc<Mutex<Receiver<Job>>> = queue.clone();
        thread::spawn(move || {
            loop {
                // recv 阻塞等待任务；锁只包住 recv，job() 在锁外执行，避免串行化所有工作。
                let job = queue.lock().unwrap().recv();
                match job {
                    Ok(job) => job(),
                    // 所有 Sender 被 drop：线程退出。
                    Err(_) => return,
                }
            }
        });
    }
    jobs
}

// 在一个请求线程中执行 dispatch 并发送回复；无论成功失败都先从 controls 移除请求。
// 例：exec 请求完成后，结果帧走 bulk；普通 lstat 结果小于 64KiB，走 control 优先发送。
fn respond(server: &Server, id: u32, request: Frame, control: Arc<Control>) {
    // 命令类请求的结果必须排在它自己的输出之后，因此走 bulk 队列；其余回复优先走控制队列。
    let is_exec = matches!(
        request.json["op"].as_str(),
        Some("exec" | "pty" | "process")
    );
    // dispatch 消费 payload；成功得到 (json, payload)，失败转协议错误 JSON。
    let reply = match server.dispatch(id, &request.json, request.payload, &control) {
        Ok((json, payload)) => Frame::with_payload(RESULT, id, json, payload),
        Err(failure) => Frame::new(ERROR, id, failure.to_json()),
    };
    // 请求已结束，取消状态不再需要；移除后到达的 CANCEL 会被忽略。
    server.controls.lock().unwrap().remove(&id);
    // A command's result follows its output; large payloads do not hold up pings and small replies.
    // 命令结果或大 payload 走 bulk，避免阻塞心跳/取消等小控制帧。
    if is_exec || reply.payload.len() > CONTROL_PAYLOAD {
        server.output.bulk(reply, None);
    } else {
        server.output.control(reply);
    }
}

/// Queue `job` behind the handle's earlier chunk writes; one pool job drains the queue.
// 对同一 FileHandle 的 writeChunk 串行化：第一个任务负责循环清空队列，其余只入队。
// 例：连续到达 block1、block2 两个 writeChunk，线程池只执行一个清空者，按顺序调用两者。
fn run_in_order(jobs: &Sender<Job>, handle: Arc<FileHandle>, job: Job) {
    // 锁住句柄的 Serial，push 当前任务。
    let mut serial = handle.serial.lock().unwrap();
    serial.jobs.push_back(job);
    // 已有线程在清空队列：入队即可返回，顺序由队列保证。
    if serial.running {
        return;
    }
    serial.running = true;
    // 先释放锁再提交线程池任务，避免线程池线程启动后又要拿同一把锁。
    drop(serial);
    // 池任务不断 pop 队首并执行；队列空时把 running 置回 false 并退出。
    let _ = jobs.send(Box::new(move || {
        loop {
            let next = {
                let mut serial = handle.serial.lock().unwrap();
                let next = serial.jobs.pop_front();
                // 队列空是唯一的退出条件；置 false 后新任务会重新提交一个清空者。
                if next.is_none() {
                    serial.running = false;
                }
                next
            };
            match next {
                Some(job) => job(),
                None => return,
            }
        }
    }));
}

// 帧读取主循环：解析请求类型，登记取消状态，把工作分配给独立线程或线程池；读到 EOF 返回 Ok。
// 例：收到 REQUEST {"op":"lstat"} 时登记 Control 并提交线程池；收到 CANCEL id=5 时找到并取消请求 5。
fn serve_frames(server: &Arc<Server>, input: &mut impl Read) -> io::Result<()> {
    let jobs = start_workers();
    // read_frame 返回 Option：None 是干净 EOF；framing 错误会以 Err 结束连接。
    while let Some(request) = frame::read_frame(input)? {
        match request.kind {
            // 交互输入类请求必须在读取线程中按到达顺序立即处理，不能进线程池，否则两次写入可能乱序。
            REQUEST
                if matches!(
                    request.json["op"].as_str(),
                    Some(
                        "ptyWrite"
                            | "ptyResize"
                            | "ptyForeground"
                            | "processWrite"
                            | "processCloseStdin"
                    )
                ) =>
            {
                // Answered here, in arrival order: through the worker pool, two writes could swap.
                // 逐个匹配 op 并调用对应模块；这些操作都通过 target 找到运行中的终端/进程。
                let reply = match request.json["op"].as_str() {
                    Some("ptyWrite") => {
                        pty::write(&server.terminals, &request.json, request.payload)
                    }
                    Some("ptyResize") => pty::resize(&server.terminals, &request.json),
                    Some("processWrite") => {
                        process::write(&server.processes, &request.json, request.payload)
                    }
                    Some("processCloseStdin") => {
                        process::close_stdin(&server.processes, &request.json)
                    }
                    _ => pty::foreground(&server.terminals, &request.json),
                };
                // 这些回复很小，走控制队列优先发送。
                server.output.control(match reply {
                    Ok(json) => Frame::new(RESULT, request.id, json),
                    Err(failure) => Frame::new(ERROR, request.id, failure.to_json()),
                });
            }
            REQUEST => {
                let id = request.id;
                // Registered before the request runs, so a cancel right behind it is not lost.
                // 先登记 Control 再执行；紧随其后的 CANCEL 帧能命中这个 id。
                let control = Arc::new(Control::default());
                server.controls.lock().unwrap().insert(id, control.clone());
                // Commands and watchers last; they get their own threads (watchers recurse through trees).
                // 长任务使用独立线程和更大栈（16MiB），避免占用固定池或递归遍历时栈溢出。
                if matches!(
                    request.json["op"].as_str(),
                    Some("exec" | "watch" | "pty" | "process")
                ) {
                    let worker = server.clone();
                    let spawned = thread::Builder::new()
                        .stack_size(16 * 1024 * 1024)
                        .spawn(move || respond(&worker, id, request, control));
                    if let Err(error) = spawned {
                        // 线程创建失败：撤销登记并直接回错误帧，不能让客户端无限等待。
                        server.controls.lock().unwrap().remove(&id);
                        let failure = Failure::new("spawn_error", error.to_string());
                        server
                            .output
                            .bulk(Frame::new(ERROR, id, failure.to_json()), None);
                    }
                } else {
                    // 普通文件操作交给线程池；writeChunk 需要按句柄串行。
                    let worker = server.clone();
                    let serial = match request.json["op"].as_str() {
                        Some("writeChunk") => server.file(&request.json).ok(),
                        _ => None,
                    };
                    // Job 是 Box<dyn FnOnce() + Send>；move 闭包捕获 worker/id/request/control。
                    let job: Job = Box::new(move || respond(&worker, id, request, control));
                    match serial {
                        Some(handle) => run_in_order(&jobs, handle, job),
                        None => {
                            // 找不到句柄时仍提交任务，由 respond 里的 dispatch 返回 EBADF。
                            let _ = jobs.send(job);
                        }
                    }
                }
            }
            CANCEL => {
                // 找到对应请求的 Control 并传递取消；找不到说明请求已结束，忽略。
                let control = server.controls.lock().unwrap().get(&request.id).cloned();
                if let Some(control) = control {
                    // mode=="kill" 表示 cleanup（只杀不 abort），否则是取消。
                    control.cancel(request.json["mode"].as_str() == Some("kill"));
                }
            }
            // PING/EVENT/RESULT/ERROR 等客户端不应发送的类型：忽略，保持连接。
            _ => {}
        }
    }
    Ok(())
}

// 连接生命周期：准备信号清理、打印 token、启动写线程与心跳线程、读取帧、结束后统一清理。
// 例：客户端关闭 stdin 后 serve_frames 返回，serve 杀光命令并关闭 output 写线程，最后进程退出。
fn serve(token: &str) -> io::Result<()> {
    // 所有已启动进程组的共享集合；信号处理与正常路径都引用它。
    let groups: exec::Groups = Arc::new(Mutex::new(Default::default()));
    {
        // A client that stops the daemon (Node's `child.kill()`), or a hangup, leaves nothing running either.
        // 注册 SIGTERM/SIGINT/SIGHUP 等处理：先杀所有进程组，再以 128+signal 退出。
        let groups = groups.clone();
        sys::on_exit_signal(move |signal| {
            kill_all(&groups);
            std::process::exit(128 + signal);
        });
    }
    {
        // 协议同步行：客户端丢弃它之前的所有输出，看到 PI-ENV <token> 后才开始发帧。
        let mut stdout = io::stdout().lock();
        writeln!(stdout, "PI-ENV {token}")?;
        stdout.flush()?;
    }
    // 唯一 stdout 写线程：所有帧经 Output 队列排序后由它写出。
    let output = Arc::new(Output::default());
    let writer = {
        let output = output.clone();
        thread::spawn(move || {
            // BufWriter 1MiB 缓冲减少系统调用；output.run 在队列空且关闭时返回。
            output.run(&mut BufWriter::with_capacity(1 << 20, io::stdout().lock()))
        })
    };
    // 构造共享 Server；句柄从 1 开始（0 可以保留为“无效”语义）。
    let server = Arc::new(Server {
        output: output.clone(),
        tmpdir: sys::tmpdir(),
        handles: Mutex::new(HashMap::new()),
        next_handle: AtomicU64::new(1),
        controls: Mutex::new(HashMap::new()),
        groups,
        terminals: Arc::new(Mutex::new(HashMap::new())),
        processes: Arc::new(Mutex::new(HashMap::new())),
    });
    // 最近一次收到客户端字节的时间；初始化为启动时刻。
    let last_seen = Arc::new(AtomicU64::new(now_ms()));
    {
        // 心跳线程：每 5 秒发 PING；超过 30 秒没收到客户端字节则杀进程并退出。
        let output = output.clone();
        let last_seen = last_seen.clone();
        let groups = server.groups.clone();
        thread::spawn(move || {
            loop {
                thread::sleep(PING_INTERVAL);
                // 控制队列优先，PING 不会被大量 bulk 输出长期压住。
                output.control(Frame::new(PING, 0, json!({})));
                // A client that went silent (a phone that lost its network) leaves nothing running.
                // saturating_sub 防止时间戳为 0/时钟回拨时下溢。
                if now_ms().saturating_sub(last_seen.load(Ordering::Relaxed)) > SILENCE_LIMIT_MS {
                    kill_all(&groups);
                    std::process::exit(0);
                }
            }
        });
    }
    // stdin 用 1MiB 缓冲，并包一层 Seen 记录活动时间；BufReader 让 read_frame 的小读取高效。
    let mut input = BufReader::with_capacity(
        1 << 20,
        Seen {
            inner: io::stdin().lock(),
            last_seen,
        },
    );
    // 阻塞服务直到 stdin EOF 或 framing 错误。
    let result = serve_frames(&server, &mut input);
    // However input ended, the client is gone: stop everything it started.
    // 客户端已断开：终止所有命令，关闭写线程，并等待它把已排队的控制帧写完。
    kill_all(&server.groups);
    output.close();
    let _ = writer.join();
    result
}

// 命令行入口：只支持 `serve --token <hex>` 与 `--version`；其他参数打印用法并以状态码 2 退出。
// 例：pi-env serve --token abc 进入 daemon；pi-env --version 打印 pi-env <版本> 后退出。
fn main() {
    // collect 把迭代器变成 Vec<String>，便于按位置查找 --token。
    let args: Vec<String> = env::args().collect();
    // args.get(1) 返回 Option<&String>，map 转成 &str 再 match；没有子命令时为 None。
    match args.get(1).map(String::as_str) {
        Some("serve") => {
            // position 找到 "--token" 的下标，再取后一个参数作为值。
            let token = args
                .iter()
                .position(|arg| arg == "--token")
                .and_then(|index| args.get(index + 1));
            // let-else：缺少 token 立即打印用法并退出；token 之后在本分支可见。
            let Some(token) = token else {
                eprintln!("usage: pi-env serve --token <hex>");
                std::process::exit(2);
            };
            // serve 返回 io::Result；错误是诊断信息，写 stderr 并以 1 退出。
            if let Err(error) = serve(token) {
                eprintln!("pi-env: {error}");
                std::process::exit(1);
            }
            // Request threads may still be blocked (a FIFO open); nothing is left to answer them.
            // 有些工作线程可能仍阻塞在系统调用（例如打开 FIFO），直接退出进程，不再等待它们。
            std::process::exit(0);
        }
        // 版本信息用于部署校验：daemon 版本必须与 npm 包一致。
        Some("--version") => println!("pi-env {VERSION}"),
        // 未知子命令或缺少子命令。
        _ => {
            eprintln!("usage: pi-env serve --token <hex>");
            std::process::exit(2);
        }
    }
}
