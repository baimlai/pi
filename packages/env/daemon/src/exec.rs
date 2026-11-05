//! `exec`: Durable's `NodeExecutionEnv.exec` semantics (docs/semantics.md), output streamed as `output` events; and what
//! the commands of `exec`, `pty` and `process` share: cancellation, starting, reading pipes and reaping.
//
// 文件导读（packages/env/daemon/src/exec.rs）
// 所属包/模块：packages/env 的 Rust daemon（二进制 pi-env）中的 exec 模块；它同时是 pty.rs 与 process.rs 的
// 进程启动、读管道和回收公共层。
// 解决的问题与职责边界：把一个 exec 请求（shell 字符串或 argv 数组）变成远程机器上的子进程，把 stdout/stderr
// 解码后作为 EVENT 帧流式发给客户端，并在超时、取消、kill、spill 失败或正常退出时给出最终结果。路径解析、
// readFile 的分块策略和错误码到 FileError 的映射由 TypeScript 客户端负责，本文件只返回协议错误码。
// 上游入口：main.rs 的 Server::dispatch 在 op == "exec" 时调用 run；CANCEL 帧先经 Server 找到 Control，再调用
// Control::cancel 进入本模块。
// 下游依赖：sys（平台进程/管道/信号实现）、frame（EVENT 帧常量与 Frame）、output（唯一 stdout 写线程与队列）、
// decode（跨块 WHATWG UTF-8 解码）、window（可选输出窗口的合并与 skipped 计数）。
// 能力清单（按导出项）：
//   - Groups：已启动但尚未回收的进程 id 集合，连接结束时用于统一终止。
//   - Message：读管道线程、等待线程与取消路径发给主循环的事件枚举。
//   - Control：一次请求的取消/终止状态；请求登记早于执行，保证紧随其后的 cancel 不丢失。
//   - ExecRequest 与其 from_json：把线上 JSON 转成有类型的请求；缺 cwd 时返回 EINVAL。
//   - kill_group：按进程组 id 终止整棵进程树（平台差异在 sys）。
//   - Spill：输出超过 afterBytes/afterLines 后，把完整原始输出写入临时文件。
//   - Launch、spawn、start_waiter、spawn_reader：启动程序、在线程上 wait 回收、在线程上读管道。
//   - argv、running：多个命令类型共用的请求字段校验与“按 target id 查找运行中请求”。
//   - run：exec 主循环，汇总上述能力并返回 { exitCode } 或 Failure。
// 组合关系/典型调用顺序：
//   Server::dispatch -> ExecRequest::from_json -> run -> spawn -> spawn_reader + start_waiter
//   -> 循环 receiver.recv_timeout 消费 Message -> output.bulk 发送 EVENT -> 返回 exitCode。
// 示例（真实签名，来自 main.rs 的调用；不是可独立运行的代码块）：
//   exec::run(id, exec::ExecRequest::from_json(json)?, &server.tmpdir, &server.output, control, &server.groups)?;
//   成功值形如 { "exitCode": 0 }；超时返回 code "timeout"，取消返回 "aborted"。
// 建议阅读顺序：先看 Groups/Message/Control 了解跨线程协议，再看 ExecRequest 与 spawn 系列，最后读 run 的状态机。

use crate::decode::StreamDecoder;
use crate::errors::Failure;
use crate::frame::{EVENT, Frame};
use crate::output::Output;
use crate::sys;
use crate::window::{Pending, Window};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

// 进程退出后仍继续收集输出的静默窗口：100ms 内没有新数据就认为残留管道不会再有内容。
const EXIT_STDIO_GRACE: Duration = Duration::from_millis(100);
/// How often a delivery waiting for the link to drain looks again.
// 有窗口输出在等待“上一帧已发出”时，每 20ms 重查一次未发送计数。
const UNSENT_POLL: Duration = Duration::from_millis(20);

/// Commands this daemon started and has not reaped; killed when the connection ends.
// Arc 允许 server、run 与信号处理线程共享同一集合；Mutex 保证并发增删安全；HashSet 存 pid（u32）。
// pid 是进程组 id，因为每个命令都在自己的新会话/进程组中启动。
pub type Groups = Arc<Mutex<HashSet<u32>>>;

// 用 enum 表示“读线程或等待线程告诉主循环发生了什么”；每个变体携带不同的数据，match 时按变体取用。
// 例：stdout 读到 bytes 时发送 Data(0, bytes)；进程退出后等待线程发送 Exit(status)。
pub enum Message {
    // 0=stdout、1=stderr；Vec<u8> 是原始字节，解码在主循环做。
    Data(usize, Vec<u8>),
    // 某个管道已到 EOF；参数是流编号。
    Eof(usize),
    // 子进程已被 wait 回收，携带退出状态。
    Exit(ExitStatus),
    // wait 本身失败（不是非零退出），字符串是诊断文字。
    WaitFailed(String),
    /// Abort: the command settles as `aborted`.
    // 取消：杀进程组，最终以 aborted 错误结束请求。
    Cancel,
    /// Kill without aborting, as `cleanup()` does: the command settles with the killed process's status.
    // 只杀不标记为取消：最终按被杀进程的状态返回 exitCode（通常是 137）。
    Kill,
}

/// Cancellation of one request, registered before the request runs so a cancel that arrives first is not lost.
// derive(Default) 给原子布尔值 false、Mutex<Option> 为 None；这些字段无需手写初始化。
#[derive(Default)]
pub struct Control {
    // 原子类型可由多个线程无锁读写；aborted 区分“取消”（错误 aborted）与单纯 kill。
    pub aborted: AtomicBool,
    pub killed: AtomicBool,
    // 只有 attach 之后才有发送端；Mutex<Option<...>> 允许先登记请求、后挂上具体命令通道。
    sender: Mutex<Option<Sender<Message>>>,
}

impl Control {
    // 记录取消/终止意图并尽力通知正在运行的主循环；在没有 sender 时只置位，供 run 启动时检查。
    // 例：客户端在 exec 请求后立刻发 CANCEL，run 尚未 attach 时这里先置 aborted，run 启动即返回 aborted。
    pub fn cancel(&self, kill: bool) {
        // 先拿 sender 的锁；锁在此函数结束前一直持有，发送动作很快，不会长期阻塞取消路径。
        let sender = self.sender.lock().unwrap();
        // kill=true 表示 cleanup：只杀进程组，不把结果改写成 aborted。
        if kill {
            self.killed.store(true, Ordering::SeqCst);
        } else {
            self.aborted.store(true, Ordering::SeqCst);
        }
        // as_ref 避免移动 Option；发送失败（接收端已结束）被忽略，因为标志位已经记录意图。
        if let Some(sender) = sender.as_ref() {
            let _ = sender.send(if kill { Message::Kill } else { Message::Cancel });
        }
    }

    // 把当前请求的消息通道登记到 Control；之后到达的 cancel 才能直接唤醒主循环。
    // 例：run 在启动子进程前 attach(sender)，CANCEL 到达时就能发送 Message::Cancel。
    pub fn attach(&self, sender: Sender<Message>) {
        // 解引用 MutexGuard 后赋值；* 作用于 Option，替换旧值（正常只 attach 一次）。
        *self.sender.lock().unwrap() = Some(sender);
    }
}

// exec 请求的已解析形式；字段都是拥有型数据，生命周期不依赖输入 JSON。
pub struct ExecRequest {
    // command 与 argv 二选一：前者交给 shell，后者直接执行。
    pub command: Option<String>,
    pub argv: Option<Vec<String>>,
    pub cwd: String,
    // env 只保留 JSON 对象；值可能是非字符串，实际使用时由 sys 决定如何处理。
    pub env: Map<String, Value>,
    pub inherit_env: bool,
    // 指定 shell；None 时由平台选择（Unix 常见为 bash/sh）。
    pub shell_path: Option<String>,
    // 超时在解析时转换成 Duration；None 表示不设截止时间。
    pub timeout: Option<Duration>,
    // spill 阈值 (afterBytes, afterLines)；两个字段必须同时存在。
    pub spill: Option<(u64, u64)>,
    // window 控制输出合并与限速；None 表示每个数据块都立即入队。
    pub window: Option<Window>,
}

impl ExecRequest {
    // 从线上 JSON 构造请求；只做字段类型/存在性校验，不启动进程、不访问磁盘。
    // 例：{"command":"echo hi","cwd":"/tmp"} 得到 command=Some、argv=None；缺 cwd 返回 EINVAL。
    pub fn from_json(json: &Value) -> Result<ExecRequest, Failure> {
        // 闭包 strings 把任意 JSON 转成 Option<Vec<String>>：任何一项不是字符串就整体返回 None。
        // as_array 用 ? 处理“不是数组”，iter/map/collect 组合把逐项转换收集成 Option<Vec<_>>。
        let strings = |value: &Value| -> Option<Vec<String>> {
            value
                .as_array()?
                .iter()
                .map(|item| item.as_str().map(str::to_string))
                .collect()
        };
        // 结构体字面量逐字段求值；ok_or_else 只在 None 时构造错误，避免无谓分配。
        Ok(ExecRequest {
            command: json["command"].as_str().map(str::to_string),
            // &json["argv"] 是索引表达式的借用；strings 接受 &Value。
            argv: strings(&json["argv"]),
            cwd: json["cwd"]
                .as_str()
                .ok_or_else(|| Failure::new("EINVAL", "exec needs cwd"))?
                .to_string(),
            // as_object 只接受 JSON 对象；cloned 复制一层 Map，unwrap_or_default 在缺失时给空 Map。
            env: json["env"].as_object().cloned().unwrap_or_default(),
            // 未提供 inheritEnv 时默认继承 daemon 环境。
            inherit_env: json["inheritEnv"].as_bool().unwrap_or(true),
            shell_path: json["shellPath"].as_str().map(str::to_string),
            // as_f64 同时接受整数和小数；除以 1000 换成秒，from_secs_f64 构造 Duration。
            timeout: json["timeoutMs"]
                .as_f64()
                .map(|ms| Duration::from_secs_f64(ms / 1000.0)),
            // 只有 afterBytes 和 afterLines 都能解析成 u64 时才启用 spill；任一缺失则整体 None。
            spill: json["spill"].as_object().and_then(|spill| {
                Some((
                    spill.get("afterBytes")?.as_u64()?,
                    spill.get("afterLines")?.as_u64()?,
                ))
            }),
            // window 的解析细节在 window.rs；不合法或缺字段时返回 None。
            window: Window::from_json(&json["window"]),
        })
    }
}

// 终止一个进程组（含它启动的后代）；具体信号与平台调用由 sys::kill_tree 实现。
// 例：连接结束时 kill_all 对每个已登记 pid 调用 kill_group(pid)。
pub fn kill_group(pid: u32) {
    sys::kill_tree(pid);
}

// 生成 v4 UUID 文本，供 spill 文件名使用；随机源来自 sys::random_bytes（不是加密安全的密钥）。
// 例：得到 "3f2a9c10-4b7e-4d21-8c55-0a1b2c3d4e5f" 这样的 36 字符文本。
fn random_uuid() -> String {
    // 取得 16 个随机字节；数组长度由类型推断。
    let mut bytes = sys::random_bytes();
    // 按 RFC 4122 设置版本位（0110 -> 第 4 版）和变体位（10xx）。
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    // iter + map + collect 把每个字节格式化成两位十六进制，拼成 32 字符 String；{byte:02x} 是格式说明。
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    // 按 8-4-4-4-12 分段插入连字符；&hex[a..b] 是按字节切片（此处都是 ASCII）。
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Spill of the complete raw output, started once it crosses either threshold, like Node's.
// 在阈值到达前先把原始块攒在内存 prefix；一旦开始 spill，就把此前的 prefix 和之后每块都写入文件。
// 注意 spilled 的是原始字节，而不是解码后的文本。
struct Spill {
    after_bytes: u64,
    after_lines: u64,
    // 已观察到的原始字节数与换行数（只在文件尚未创建时累计，用于判断是否越过阈值）。
    seen_bytes: u64,
    seen_newlines: u64,
    // 阈值前暂存的内存块，spill 启动时按顺序写入文件。
    prefix: Vec<Vec<u8>>,
    // start 成功后保存打开的文件与路径；None 表示尚未开始或启动失败。
    file: Option<File>,
    path: Option<String>,
    // 写入失败的文字；一旦设置，本命令会被终止并以 unknown 失败返回。
    failed: Option<String>,
}

impl Spill {
    // 接收一块原始输出；必要时启动 spill 文件并写入，失败只记录在 failed，不直接返回 Result。
    // 例：阈值 afterBytes=10，前两块共 8 字节只进 prefix，第三块到 12 字节时创建文件并补齐。
    fn push(&mut self, chunk: &[u8], tmpdir: &str) {
        // 已失败或空块无需处理；空块不改变字节/行计数。
        if self.failed.is_some() || chunk.is_empty() {
            return;
        }
        // file 为 None 说明尚未跨过阈值，仍处于“先暂存”阶段。
        if self.file.is_none() {
            self.seen_bytes += chunk.len() as u64;
            // filter + count 数出本块中的 LF；**byte 解引用两层引用（迭代器项与闭包参数）。
            self.seen_newlines += chunk.iter().filter(|byte| **byte == b'\n').count() as u64;
            // Node 把不以换行结尾的最后一段也算一行；u64::from(bool) 把 bool 转成 0/1。
            let lines = self.seen_newlines + u64::from(chunk.last() != Some(&b'\n'));
            // 两个阈值都未超过：只暂存，不创建文件。
            if self.seen_bytes <= self.after_bytes && lines <= self.after_lines {
                self.prefix.push(chunk.to_vec());
                return;
            }
            // 越过任一阈值才真正创建临时文件；失败后记录诊断并停止后续写入。
            if let Err(error) = self.start(tmpdir) {
                self.failed = Some(error);
                return;
            }
        }
        // if-let 链（Rust 2024）：file 存在且 write_all 失败时记录错误；成功时什么也不做。
        if let Some(file) = &mut self.file
            && let Err(error) = file.write_all(chunk)
        {
            self.failed = Some(error.to_string());
        }
    }

    /// `createTempFile({ prefix: "pi-output-", suffix: ".log" })`: a fresh `tmp-` directory holding the file.
    // 创建 <tmpdir>/tmp-XXXXXX 目录和 pi-output-<uuid>.log 文件，再把暂存的 prefix 按顺序写入；返回错误文字。
    // 例：tmpdir=/tmp 时可能创建 /tmp/tmp-a1B2c3/pi-output-<uuid>.log，并补写此前缓存的字节。
    fn start(&mut self, tmpdir: &str) -> Result<(), String> {
        // Path::join 生成 <tmpdir>/tmp- 前缀；to_string_lossy 在非法编码时替换字符。
        let prefix = Path::new(tmpdir)
            .join("tmp-")
            .to_string_lossy()
            .into_owned();
        // mkdtemp 在后缀位置填六个随机字符并真实创建目录；map_err 把 io::Error 转成 String。
        let directory = sys::mkdtemp(&prefix).map_err(|error| error.to_string())?;
        // 文件名带随机 UUID，避免并发命令互相覆盖。
        let path = Path::new(&directory)
            .join(format!("pi-output-{}.log", random_uuid()))
            .to_string_lossy()
            .into_owned();
        // OpenOptions 选择追加、创建、只写；create(true) 允许新建文件。
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        // drain(..) 移走 prefix 的全部元素并按原来顺序写入，保证 spill 文件包含完整输出。
        for chunk in self.prefix.drain(..) {
            file.write_all(&chunk).map_err(|error| error.to_string())?;
        }
        // 只有全部成功后才公布 file 与 path；中途失败时调用方只看到 Err。
        self.file = Some(file);
        self.path = Some(path);
        Ok(())
    }
}

/// Where and with which environment a program starts.
// 用生命周期 'a 表示 cwd/env 两个借用至少活到 Launch 使用结束；spawn 不接管它们的所有权。
pub struct Launch<'a> {
    pub cwd: &'a str,
    pub env: &'a Map<String, Value>,
    pub inherit_env: bool,
}

/// Start `program` with piped stdout and stderr, in a process group of its own, as libuv starts commands.
// 构造 Command：设置工作目录、stdin、捕获 stdout/stderr，交给 sys::configure 统一处理参数与环境。
// 返回 Child，调用方负责读管道、wait 回收和错误处理；spawn 失败直接返回 io::Result 的 Err。
// 例：spawn("/bin/bash", &["-c".into(), "echo hi".into()], &launch, Stdio::null())
// 返回一个 stdout/stderr 可由父进程读取的 Child。
pub fn spawn(
    program: &str,
    args: &[String],
    launch: &Launch,
    stdin: Stdio,
) -> std::io::Result<Child> {
    // Command::new 不会立即执行，只是构造配置对象。
    let mut command = Command::new(program);
    command
        .current_dir(launch.cwd)
        .stdin(stdin)
        // piped 让父进程拿到可读的管道端；daemon 在 spawn_reader 中消费。
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // sys 负责 Unix/Windows 差异：argv[0]、环境合并、进程组/Job object 等启动前配置。
    sys::configure(&mut command, args, launch.env, launch.inherit_env);
    // ? 把启动失败向上抛；成功返回 Child。
    let child = command.spawn()?;
    // 启动后的平台动作（如记录进程组）由 sys 完成。
    sys::after_spawn(&child);
    Ok(child)
}

/// Reap `child` on a thread of its own, which sends its exit to `sender`. A thread that cannot start hands the child
/// back with the error, so the caller kills and reaps it.
// 等待线程只做 child.wait()，把 Exit/WaitFailed 发回主循环；返回 Err 时连同 Child 一起交还，避免泄漏。
// 例：start_waiter(child, sender) 成功后，主循环最终会收到 Message::Exit(status)。
pub fn start_waiter(child: Child, sender: Sender<Message>) -> Result<(), (Child, std::io::Error)> {
    // The waiter receives the child once it runs, so a waiter that cannot start leaves the child here to reap.
    // 先建一个一次性通道，把 Child 交给线程自己；若线程创建失败，Child 仍留在本函数手里。
    let (give, take) = mpsc::channel::<Child>();
    // move 把 take 与 sender 移入新线程；Builder 允许设置线程名/栈等，这里只用默认值。
    let started = thread::Builder::new().spawn(move || {
        // let-else：拿不到 Child（发送端已消失）就静默退出。
        let Ok(mut child) = take.recv() else {
            return;
        };
        // wait 阻塞到进程结束；结果转成 Message 发给主循环，发送失败（接收端已关闭）被忽略。
        let _ = sender.send(match child.wait() {
            Ok(status) => Message::Exit(status),
            Err(error) => Message::WaitFailed(error.to_string()),
        });
    });
    match started {
        Ok(_) => {
            // 线程已启动，再把 Child 交过去；join handle 被丢弃，线程自行结束。
            let _ = give.send(child);
            Ok(())
        }
        // 线程没启动成功：give 仍可用，但直接把 Child 原样交还调用方。
        Err(error) => Err((child, error)),
    }
}

/// The `argv` of a request: `None` when absent, else a non-empty array of strings.
// 供 exec 之外的 pty/process 复用：JSON 缺 argv 或为 null 返回 None；存在但为空/含非字符串则 EINVAL。
// 例：{"argv":["a","b"]} 得到 Some(vec!["a","b"])；{"argv":[]} 得到 EINVAL。
pub fn argv(json: &Value) -> Result<Option<Vec<String>>, Failure> {
    // 对索引结果做 match：Null 表示请求根本没有 argv 字段（或用 null 表示不提供）。
    match &json["argv"] {
        Value::Null => Ok(None),
        value => value
            .as_array()
            .and_then(|items| {
                // 逐项 as_str 后收集成 Option<Vec<String>>；任一项不是字符串则整体 None。
                items
                    .iter()
                    .map(|item| item.as_str().map(str::to_string))
                    .collect::<Option<Vec<String>>>()
            })
            // 过滤空数组：[] 与缺失不同，它声明了 argv 却没有程序可运行。
            .filter(|argv| !argv.is_empty())
            .map(Some)
            .ok_or_else(|| Failure::new("EINVAL", "argv must be a non-empty array of strings")),
    }
}

/// The running request a follow-up request names in `target` (`ptyWrite`, `processWrite`, ...); `what` names its kind
/// in the error.
// 泛型 T 让 pty/process 共用：从 target 字段取 id，在各自的表中找 Arc<T> 并克隆；找不到返回 EBADF。
// 例：{"target":7} 在表中有 id 7 时返回共享的 Arc<T>；没有时返回 EBADF。
pub fn running<T>(
    requests: &Mutex<HashMap<u32, Arc<T>>>,
    json: &Value,
    what: &str,
) -> Result<Arc<T>, Failure> {
    // target 必须是 u64；缺失或类型不对都按 EINVAL 处理。
    let target = json["target"]
        .as_u64()
        .ok_or_else(|| Failure::new("EINVAL", "missing field target"))?;
    // 锁表 -> get -> cloned：克隆 Arc 后即可释放锁，读取方不必持续持有 map 锁。
    requests
        .lock()
        .unwrap()
        .get(&(target as u32))
        .cloned()
        .ok_or_else(|| Failure::new("EBADF", format!("no running {what} with this id")))
}

/// Read one pipe on its own thread until it ends or `stop` is set. With `output`, reading waits while too much output
/// is unsent.
// impl sys::Pipe + Send + 'static 是参数约束：任意实现了 Pipe、可跨线程移动、且不借用栈上数据的类型。
// 返回 JoinHandle，调用方可选择 join；正常读完会发 Eof。
// 例：spawn_reader(0, stdout, sender, stop, None) 会把 stdout 的每块字节发成 Message::Data(0, bytes)。
pub fn spawn_reader(
    stream: usize,
    pipe: impl sys::Pipe + Send + 'static,
    sender: Sender<Message>,
    stop: Arc<AtomicBool>,
    output: Option<Arc<Output>>,
) -> std::io::Result<JoinHandle<()>> {
    thread::Builder::new().spawn(move || {
        // sys::read_pipe 循环读并调用闭包；闭包返回 false 表示停止读取。
        sys::read_pipe(pipe, &stop, |bytes| {
            // to_vec 复制管道缓冲，因为帧随后跨线程入队；send 失败说明主循环已退出。
            let delivered = sender.send(Message::Data(stream, bytes.to_vec())).is_ok();
            // 无窗口命令通过 Output 背压：未发送输出太多时阻塞读取，相当于满管道拖慢命令。
            if let Some(output) = &output {
                output.wait_for_room(&stop);
            }
            // 返回是否继续读；主循环消失后立即停。
            delivered
        });
        // 管道结束或停止后补发 Eof；即使发送失败也无需处理。
        let _ = sender.send(Message::Eof(stream));
    })
}

// 构造一条 output 事件帧：JSON 含 kind/stream（可选 skipped），payload 是已解码文本的 UTF-8 字节。
// 例：output_frame(7, "stdout", "hi".into(), None) 得到 kind=EVENT、id=7、payload=b"hi" 的帧。
fn output_frame(id: u32, stream: &str, text: String, skipped: Option<Value>) -> Frame {
    let mut json = json!({ "kind": "output", "stream": stream });
    // 只有输出窗口确实丢弃过内容时才附加 skipped 字段。
    if let Some(skipped) = skipped {
        json["skipped"] = skipped;
    }
    // into_bytes 无复制地取得 String 的字节缓冲，作为帧 payload。
    Frame::with_payload(EVENT, id, json, text.into_bytes())
}

/// Run one command, sending output events for request `id`, until it settles.
// exec 主入口：启动程序、收集管道输出与退出状态、处理超时/取消/kill/spill，返回 { exitCode } 或 Failure。
// 这是阻塞函数，由 main.rs 为每个 exec 请求单独开线程调用。
// 例：成功返回 Ok(json!({"exitCode": 0}))；超时返回 Err(code="timeout")，取消返回 Err(code="aborted")。
pub fn run(
    id: u32,
    request: ExecRequest,
    tmpdir: &str,
    output: &Arc<Output>,
    control: &Control,
    groups: &Groups,
) -> Result<Value, Failure> {
    // mpsc::channel 建立多生产者/单消费者队列：读线程、等待线程与 cancel 都能发送。
    let (sender, receiver) = mpsc::channel();
    // 先 attach，再检查 aborted，覆盖“cancel 在请求登记后、命令启动前到达”的窗口。
    control.attach(sender.clone());
    if control.aborted.load(Ordering::SeqCst) {
        return Err(Failure::new("aborted", "aborted"));
    }
    // A string runs through the shell (as its last argument, or on stdin for legacy WSL bash); argv runs directly.
    // 元组解构得到 (程序路径, 程序参数, 可选的标准输入命令文本)。
    let (program, args, stdin_command) = match (&request.command, &request.argv) {
        (Some(command), _) => {
            // shell_config 决定 shell 程序、前置参数和命令是否改走 stdin（旧版 WSL bash）。
            let shell = sys::shell_config(request.shell_path.as_deref())?;
            let mut args = shell.args;
            if shell.command_on_stdin {
                (shell.program, args, Some(command.clone()))
            } else {
                // 常规情况：命令文本作为 shell 的最后一个参数，例如 bash -c "echo hi"。
                args.push(command.clone());
                (shell.program, args, None)
            }
        }
        (None, Some(argv)) => match argv.split_first() {
            // split_first 返回 (首元素, 其余切片)：首元素是程序，其余是参数。
            Some((first, rest)) => (
                // 按平台规则解析程序（Windows 会查 PATH/追加 .exe；Unix 交给 Command）。
                sys::resolve_program(first, &request.cwd, &request.env)?,
                rest.to_vec(),
                None,
            ),
            // Vec 非空已由 argv() 校验，但这里仍防御空切片；空 argv 没有程序可运行。
            None => return Err(Failure::new("spawn_error", "Empty argv: no program to run")),
        },
        (None, None) => return Err(Failure::new("EINVAL", "exec needs command or argv")),
    };
    // 工作目录必须存在；这里只检查存在性，真实启动失败仍由 spawn 报告。
    if !Path::new(&request.cwd).exists() {
        return Err(Failure::new(
            "spawn_error",
            format!(
                "Working directory does not exist: {}\nCannot execute bash commands.",
                request.cwd
            ),
        ));
    }
    // 借用请求中的 cwd/env 构造 Launch；生命周期 'a 保证在 spawn 调用期间有效。
    let launch = Launch {
        cwd: &request.cwd,
        env: &request.env,
        inherit_env: request.inherit_env,
    };
    // 旧版 WSL bash 需要把命令写进 stdin；其余程序不接收输入，用 null 防止误读。
    let stdin = if stdin_command.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    };
    // 启动失败统一映射为协议码 spawn_error，message 保留操作系统诊断。
    let mut child = spawn(&program, &args, &launch, stdin)
        .map_err(|error| Failure::new("spawn_error", error.to_string()))?;
    // 若命令走 stdin，取出管道并写入；写入失败被忽略（与 Node 行为一致，命令随后会自行退出）。
    if let (Some(command), Some(mut stdin)) = (stdin_command, child.stdin.take()) {
        let _ = stdin.write_all(command.as_bytes());
    }
    // pid 同时代表进程组 id；登记到 groups，连接断开时可统一 kill。
    let pid = child.id();
    groups.lock().unwrap().insert(pid);
    // 超时截止点只计算一次；timeout 为 None 时没有任何截止时间。
    let deadline = request.timeout.map(|timeout| Instant::now() + timeout);
    // stop 是所有读线程共享的停止标记；连接结束或命令 settle 时置位。
    let stop = Arc::new(AtomicBool::new(false));
    // Without a window, output is not coalesced; reading then waits for the link.
    // 没有输出窗口时才把 Output 交给 reader 做 4MiB 背压；有窗口时由 Pending 的节奏控制。
    let gate = if request.window.is_none() {
        Some(output.clone())
    } else {
        None
    };
    // A thread that cannot start (a task limit) fails the command; the started child is killed and reaped. Readers
    // already running see `stop` within 100 ms.
    // 线程创建失败时的统一收尾：停止读取、杀进程组、直接杀 child、wait 回收、移除登记，再返回 spawn_error。
    // 闭包捕获 stop、pid 和 groups；调用时消费 child 的所有权。
    let abandon = |mut child: Child, error: std::io::Error| {
        stop.store(true, Ordering::SeqCst);
        kill_group(pid);
        // On Windows the group kill spawns taskkill, which can fail under the same limit; kill the child directly.
        let _ = child.kill();
        let _ = child.wait();
        groups.lock().unwrap().remove(&pid);
        Failure::new("spawn_error", error.to_string())
    };
    // 启动阶段已保证 stdout/stderr 是 piped，take 得到管道端；失败说明代码内部状态被破坏。
    let stdout = child.stdout.take().unwrap();
    // reader 线程按管道读取并发送 Data；失败则走 abandon。
    if let Err(error) = spawn_reader(0, stdout, sender.clone(), stop.clone(), gate.clone()) {
        return Err(abandon(child, error));
    }
    let stderr = child.stderr.take().unwrap();
    // gate 在第一次传入时已被 clone，这里移动最后一个副本给 stderr。
    if let Err(error) = spawn_reader(1, stderr, sender.clone(), stop.clone(), gate) {
        return Err(abandon(child, error));
    }
    // 等待线程接管 child；若不慎失败，child 会随错误交还，仍可 abandon。
    if let Err((child, error)) = start_waiter(child, sender.clone()) {
        return Err(abandon(child, error));
    }
    // 主循环自己不再发送；drop 后当所有读线程/等待线程结束时 receiver 才会 Disconnected。
    drop(sender);

    // 两个流各自维护解码器：UTF-8 多字节字符可能跨块，必须复用同一实例。
    let mut decoders = [StreamDecoder::new(), StreamDecoder::new()];
    // spill 配置存在时构造运行状态；阈值来自请求。
    let mut spill = request.spill.map(|(after_bytes, after_lines)| Spill {
        after_bytes,
        after_lines,
        seen_bytes: 0,
        seen_newlines: 0,
        prefix: Vec::new(),
        file: None,
        path: None,
        failed: None,
    });
    // window 配置存在时用 Pending 合并输出；Pending::new 在 window.rs。
    let mut pending = request.window.map(Pending::new);
    // unsent 记录本命令还有多少 bulk 帧未写出；Output 在写完一帧后减一。
    let unsent = Arc::new(AtomicUsize::new(0));
    // 流编号到协议字段名的映射；下标与 Message::Data 的 stream 对应。
    let names = ["stdout", "stderr"];
    // 发送一段已解码文本：空文本忽略；有窗口则暂存等待节流，无窗口则立即作为 bulk 帧入队。
    let emit = |pending: &mut Option<Pending>, stream: usize, text: String| {
        if text.is_empty() {
            return;
        }
        match pending {
            Some(pending) => pending.push(names[stream], text),
            None => output.bulk(output_frame(id, names[stream], text, None), None),
        }
    };
    // 把窗口暂存的全部事件发出；每个 bulk 帧共享同一 unsent 计数器，写完即减一。
    let deliver = |pending: &mut Pending| {
        for event in pending.take() {
            output.bulk(
                output_frame(id, event.stream, event.text, event.skipped),
                Some(unsent.clone()),
            );
        }
    };
    // 状态机变量：两条管道是否 EOF、退出状态（Ok=有 code，Err=wait 失败）、退出后的静默截止时间。
    let mut ended = [false, false];
    let mut status: Option<Result<ExitStatus, String>> = None;
    let mut idle_until: Option<Instant> = None;
    let mut timed_out = false;
    let mut aborted = false;
    let mut killed = false;
    // 只杀一次进程组：重复 kill 没有意义，也可能掩盖第一次的结果。
    let kill = |killed: &mut bool| {
        if !*killed {
            *killed = true;
            kill_group(pid);
        }
    };
    // 如果 cancel(kill=true) 在 attach 前就到达，这里补一次 kill。
    if control.killed.load(Ordering::SeqCst) {
        kill(&mut killed);
    }
    // 主事件循环：等待 Data/Eof/Exit/Cancel，同时处理超时、窗口节奏与残留管道。
    loop {
        let now = Instant::now();
        // Node's timer stays armed until the command settles, including the grace period after exit.
        // 超时只触发一次；之后 timed_out 让 wait 不再把截止时间算进去。
        if !timed_out && deadline.is_some_and(|deadline| now >= deadline) {
            timed_out = true;
            kill(&mut killed);
        }
        // 正常结束条件：已拿到退出状态且 stdout/stderr 都已 EOF。
        if status.is_some() && ended[0] && ended[1] {
            break;
        }
        // 退出后仍有后代占着管道：等满静默窗口就停止等待，避免永远不返回。
        if idle_until.is_some_and(|idle| now >= idle) {
            // A descendant may hold the pipes open after the process exited; stop waiting for it.
            break;
        }
        // 有窗口时按节奏发送：待发送非空、到达 next_send、且上一帧已写完（unsent==0）。
        if let Some(pending) = &mut pending
            && !pending.is_empty()
            && now >= pending.next_send()
            && unsent.load(Ordering::SeqCst) == 0
        {
            deliver(pending);
        }
        // 默认最多睡一小时，再被最近的 deadline/idle/窗口节奏缩短，避免忙等。
        let mut wait = Duration::from_secs(3600);
        if let Some(deadline) = deadline.filter(|_| !timed_out) {
            // saturating_duration_since 在时刻已过时返回 0，不会 panic。
            wait = wait.min(deadline.saturating_duration_since(now));
        }
        if let Some(idle) = idle_until {
            wait = wait.min(idle.saturating_duration_since(now));
        }
        // 有窗口且待发送内容时：等 capacity 或按发送节奏轮询。
        if let Some(pending) = pending.as_ref().filter(|pending| !pending.is_empty()) {
            wait = wait.min(if unsent.load(Ordering::SeqCst) > 0 {
                UNSENT_POLL
            } else {
                pending.next_send().saturating_duration_since(now)
            });
        }
        // recv_timeout 等待消息；Timeout 只表示该重新检查超时/发送节奏，不是命令失败。
        match receiver.recv_timeout(wait) {
            Ok(Message::Data(stream, bytes)) => {
                // 解码本块；false 表示尚未到流尾，残缺 UTF-8 会留到下一块。
                emit(&mut pending, stream, decoders[stream].decode(&bytes, false));
                // spill 记录原始字节；一旦写入失败，终止命令（最终返回 unknown）。
                if let Some(spill) = &mut spill {
                    spill.push(&bytes, tmpdir);
                    if spill.failed.is_some() {
                        kill(&mut killed);
                    }
                }
                // 进程已退出后仍有输出：重新开始静默计时，给后代一点收尾时间。
                if status.is_some() {
                    idle_until = Some(Instant::now() + EXIT_STDIO_GRACE);
                }
            }
            Ok(Message::Eof(stream)) => ended[stream] = true,
            Ok(Message::Exit(exit)) => {
                status = Some(Ok(exit));
                // 退出后等待剩余管道内容最多 100ms。
                idle_until = Some(Instant::now() + EXIT_STDIO_GRACE);
            }
            Ok(Message::WaitFailed(error)) => {
                // wait 本身失败不会有正常 exitCode；立即结束静默等待，稍后返回 spawn_error。
                status = Some(Err(error));
                idle_until = Some(Instant::now());
            }
            Ok(Message::Cancel) => {
                // 取消语义：杀进程组并最终返回 aborted（除非超时等更高优先级先被判定）。
                aborted = true;
                kill(&mut killed);
            }
            Ok(Message::Kill) => kill(&mut killed),
            Err(RecvTimeoutError::Timeout) => {}
            // 所有发送端都已消失且没有待处理消息：退出循环，由后面统一判定结果。
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    // Like Node destroying its streams: readers stop within 100 ms, so the pipes close even if a descendant still holds
    // them.
    // 通知所有读线程停止；即使后代仍占着管道，daemon 也不再等待。
    stop.store(true, Ordering::SeqCst);
    groups.lock().unwrap().remove(&pid);
    // 用 last=true 冲刷解码器里残留的残缺序列，把最后一个替换字符也发出去。
    emit(&mut pending, 0, decoders[0].decode(&[], true));
    emit(&mut pending, 1, decoders[1].decode(&[], true));
    // 窗口里最后累积的内容在返回前必须全部发出。
    if let Some(pending) = &mut pending
        && !pending.is_empty()
    {
        deliver(pending);
    }
    // spill 已启动时记录路径：失败响应会附加 spillPath，成功结果也会带上它。
    let spill_path = spill.as_ref().and_then(|spill| spill.path.clone());
    let with_spill = |failure: Failure| match &spill_path {
        Some(path) => failure.extra(json!({ "spillPath": path })),
        None => failure,
    };
    // 结果优先级按本实现顺序：超时 > 取消 > spill 失败 > 进程退出状态。
    if timed_out {
        return Err(with_spill(Failure::new("timeout", "timeout")));
    }
    if aborted {
        return Err(with_spill(Failure::new("aborted", "aborted")));
    }
    if let Some(error) = spill.as_ref().and_then(|spill| spill.failed.clone()) {
        return Err(Failure::new(
            "unknown",
            format!("Failed to preserve complete shell output: {error}"),
        ));
    }
    let status = match status {
        Some(Ok(status)) => status,
        Some(Err(error)) => return Err(Failure::new("spawn_error", error)),
        None => {
            // 主循环因 Disconnected 提前退出且没有收到退出状态：无法报告 exitCode。
            return Err(Failure::new(
                "spawn_error",
                "process did not report its exit",
            ));
        }
    };
    // 成功结果至少包含退出码；sys::exit_code 把信号退出转换成 128+signal。
    let mut result = json!({ "exitCode": sys::exit_code(status) });
    if let Some(path) = spill_path {
        result["spillPath"] = json!(path);
    }
    Ok(result)
}
