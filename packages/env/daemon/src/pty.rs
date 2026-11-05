//! `pty`: a program in a pseudo-terminal, for interactive terminals. Unlike `exec`, output is the terminal's raw
//! bytes, and the program reads input: `ptyWrite`, `ptyResize` and `ptyForeground` address the running `pty` request by
//! its id.
//
// 文件导读（packages/env/daemon/src/pty.rs）
// 所属包/模块：packages/env 的 Rust daemon（二进制 pi-env）中的 pty 模块，对应协议操作 pty、ptyWrite、
// ptyResize 与 ptyForeground；仅在 Unix 上真正实现，Windows 返回 ENOTSUP。
// 解决的问题与职责边界：在伪终端（pseudo-terminal，PTY）里运行交互式程序（默认是用户的登录 shell），把终端
// 原始输出字节作为 output 事件发送，并支持向终端写输入、改变窗口大小、查询前台进程组。daemon 不做换行转换、
// 不回显（回显由终端驱动完成）、不合并 stderr（它在 PTY 中与 stdout 是同一个终端）。
// 上游入口：main.rs 的 Server::dispatch 在 op == "pty" 时调用 run；ptyWrite/ptyResize/ptyForeground 由
// serve_frames 在帧读取线程中按到达顺序直接调用 write/resize/foreground。
// 下游依赖：exec.rs（Message、Control、kill_group、start_waiter、running）、sys（仅用于退出码/路径存在性）、
// frame（EVENT）、output（唯一写线程）、libc（Unix 系统调用绑定）。
// 能力清单（按导出项）：
//   - Terminal：一个运行中终端的输入发送端、master 文件与进程 id。
//   - Terminals：以 pty 请求 id 为键的运行表。
//   - PtyRequest 与 from_json：解析 argv/cwd/env/inheritEnv 以及 cols/rows。
//   - write：把客户端字节排入终端输入队列。
//   - resize：用 TIOCSWINSZ 修改终端尺寸（程序收到 SIGWINCH）。
//   - foreground：查询终端当前前台进程组；自己的 shell 在前台时返回 null。
//   - run：启动并监督终端程序（Unix 实现；非 Unix 为返回 ENOTSUP 的桩）。
//   - 私有 unix 子模块：openpty、setsid/TIOCSCTTY、非阻塞读、poll 与顺序写。
// 组合关系/典型调用顺序：
//   Server::dispatch("pty") -> PtyRequest::from_json -> run -> unix::spawn
//   -> 登记 Terminal -> 发送 started -> 读线程/写线程/等待线程并行
//   -> 期间 ptyWrite/ptyResize/ptyForeground 通过 running() 找到 Terminal -> 返回 { exitCode }。
// 示例（真实签名，来自 main.rs 的调用；不是可独立运行的代码块）：
//   pty::run(id, pty::PtyRequest::from_json(json)?, &server.output, control, &server.groups,
//            &server.terminals)?;
//   终端运行时 pty::resize(&server.terminals, &json) 会用新的 cols/rows 调 ioctl。
// 建议阅读顺序：先看 Terminal/PtyRequest 与三个控制函数，再读 Unix run 的事件循环，最后看 unix 子模块的
// spawn/read/write_all 系统调用细节。

use crate::errors::Failure;
use crate::exec::{Control, Groups, running};
#[cfg(unix)]
use crate::exec::{Message, kill_group, start_waiter};
#[cfg(unix)]
use crate::frame::{EVENT, Frame};
use crate::output::Output;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

/// After the program exits, output still arriving is collected until this much silence.
// cfg(unix) 表示该常量只在 Unix 构建中存在；非 Unix 的 run 桩不需要它。
#[cfg(unix)]
const EXIT_GRACE: std::time::Duration = std::time::Duration::from_millis(100);
/// Largest terminal size accepted, in cells.
// 行/列各允许 1..=4096；这是来自线上 JSON 的运行时校验（不是类型系统保证）。
const MAX_CELLS: u64 = 4096;

/// What `ptyWrite`, `ptyResize` and `ptyForeground` reach: the terminal of one running `pty` request.
pub struct Terminal {
    // 输入队列：ptyWrite 的字节按到达顺序进入，由 run 创建的写线程消费。
    input: Sender<Vec<u8>>,
    // master 端是 daemon 读写的终端句柄；Arc 让读线程、resize 与 foreground 共享同一文件。
    #[cfg(unix)]
    master: Arc<std::fs::File>,
    /// The program's process id, which is also its process group's (it leads the terminal's session).
    // 因为子进程 setsid 后成为新会话首进程，pid 同时是前台/进程组的比较基准。
    #[cfg(unix)]
    pid: u32,
}

/// Running terminals by the id of their `pty` request.
// 与 Processes 相同：跨线程共享的 id -> Terminal 表。
pub type Terminals = Arc<Mutex<HashMap<u32, Arc<Terminal>>>>;

// cfg_attr 在非 Unix 上给整个结构加 allow(dead_code)，因为桩实现不会读取这些字段。
#[cfg_attr(not(unix), allow(dead_code))]
pub struct PtyRequest {
    // argv=None 表示运行用户 shell 的登录会话；Some 则直接执行。
    argv: Option<Vec<String>>,
    cwd: String,
    env: Map<String, Value>,
    inherit_env: bool,
    // 终端初始尺寸，单位是字符单元（cell），已在 from_json 中校验到 1..=4096。
    cols: u16,
    rows: u16,
}

// 校验并转换一个终端尺寸字段；缺失、非数字或越界都返回 EINVAL。
// 例：size(&json, "cols") 在 cols=80 时返回 Ok(80)；cols=0 时返回 Err(EINVAL)。
fn size(json: &Value, key: &str) -> Result<u16, Failure> {
    // match 带 guard：只有 u64 且落在闭区间内才成功；其他情况走错误分支。
    match json[key].as_u64() {
        Some(value) if (1..=MAX_CELLS).contains(&value) => Ok(value as u16),
        // format! 把字段名与上限写进诊断；code 仍是 EINVAL。
        _ => Err(Failure::new(
            "EINVAL",
            format!("{key} must be between 1 and {MAX_CELLS}"),
        )),
    }
}

impl PtyRequest {
    // 从 JSON 解析 pty 请求；不做 I/O。缺 cwd/cols/rows、尺寸越界或 argv 非法都返回 EINVAL。
    // 例：{"cwd":"/tmp","cols":80,"rows":24} 表示运行默认登录 shell；加 argv 则直接执行该程序。
    pub fn from_json(json: &Value) -> Result<PtyRequest, Failure> {
        Ok(PtyRequest {
            // argv 可选：null/缺失得到 None（运行 shell），否则必须是非空字符串数组。
            argv: crate::exec::argv(json)?,
            cwd: json["cwd"]
                .as_str()
                .ok_or_else(|| Failure::new("EINVAL", "pty needs cwd"))?
                .to_string(),
            env: json["env"].as_object().cloned().unwrap_or_default(),
            inherit_env: json["inheritEnv"].as_bool().unwrap_or(true),
            // 尺寸字段必填，且各自独立校验。
            cols: size(json, "cols")?,
            rows: size(json, "rows")?,
        })
    }
}

// 在运行表中按 target 查找终端；找不到返回 EBADF。封装仅为统一错误里的类型名。
// 例：find(&terminals, &json!({"target":3})) 在 id 3 存在时返回 Arc<Terminal>。
fn find(terminals: &Terminals, json: &Value) -> Result<Arc<Terminal>, Failure> {
    running(terminals, json, "terminal")
}

/// Queue input for the terminal; it is written in the order it arrives, without holding up other requests.
// 只入队、不等待写进终端；target 是 pty 请求 id。终端结束后返回 EBADF。
// 例：write(&terminals, &json!({"target":3}), b"ls\n".to_vec()) 立即返回 {}，输入由写线程顺序写入。
pub fn write(terminals: &Terminals, json: &Value, payload: Vec<u8>) -> Result<Value, Failure> {
    let terminal = find(terminals, json)?;
    terminal
        .input
        .send(payload)
        // 接收端消失说明写线程已退出（终端关闭或程序结束）。
        .map_err(|_| Failure::new("EBADF", "the terminal has ended"))?;
    Ok(json!({}))
}

/// Change the terminal's size; the program receives `SIGWINCH`.
// 修改终端窗口尺寸；内核向终端的前台进程组发送 SIGWINCH。非 Unix 平台只校验参数后返回成功。
// 例：resize(&terminals, &json!({"target":3,"cols":120,"rows":40})) 成功时返回 {}。
pub fn resize(terminals: &Terminals, json: &Value) -> Result<Value, Failure> {
    let terminal = find(terminals, json)?;
    // 两个 size 校验都成功后才执行 ioctl；元组解构 (cols, rows)。
    let (cols, rows) = (size(json, "cols")?, size(json, "rows")?);
    #[cfg(unix)]
    unix::set_size(&terminal.master, cols, rows)
        .map_err(|error| Failure::io(&error, "ioctl", "pty"))?;
    // 非 Unix 没有 PTY 实现：读取已校验的值，避免未使用变量警告；行为仍返回 {}。
    #[cfg(not(unix))]
    let _ = (terminal, cols, rows);
    Ok(json!({}))
}

/// The process group in the terminal's foreground when it is not the program's own: a job a shell started, such as an
/// editor. `{ foreground: null }` while the program itself is in front (a shell at its prompt).
// 查询终端前台进程组：tcgetpgrp 返回组 id；等于 shell 自己的 pid 或无效时返回 null，否则附进程名。
// 例：shell 提示符处返回 {foreground:null}；正在运行 vim 时返回 {foreground:{pid,name}}。
pub fn foreground(terminals: &Terminals, json: &Value) -> Result<Value, Failure> {
    let terminal = find(terminals, json)?;
    #[cfg(unix)]
    {
        // tcgetpgrp 需要终端 master 描述符；失败映射为协议错误。
        let group = unix::foreground(&terminal.master)
            .map_err(|error| Failure::io(&error, "tcgetpgrp", "pty"))?;
        // group <= 0 表示没有前台组；group == 自己的 pid 表示 shell 正在提示符处。
        if group <= 0 || group as u32 == terminal.pid {
            return Ok(json!({ "foreground": null }));
        }
        // 进程名取不到时 name 可能是 null（例如进程刚退出）。
        let name = unix::process_name(group);
        Ok(json!({ "foreground": { "pid": group, "name": name } }))
    }
    // 非 Unix 平台没有终端，始终报告 null（resize 同样是无操作）。
    #[cfg(not(unix))]
    {
        let _ = terminal;
        Ok(json!({ "foreground": null }))
    }
}

// 非 Unix 的 pty 桩：参数前加下划线表示有意不使用，直接返回 ENOTSUP。
// 例：Windows 上客户端请求 pty 会收到 code="ENOTSUP" 的错误帧。
#[cfg(not(unix))]
pub fn run(
    _id: u32,
    _request: PtyRequest,
    _output: &Arc<Output>,
    _control: &Control,
    _groups: &Groups,
    _terminals: &Terminals,
) -> Result<Value, Failure> {
    Err(Failure::new(
        "ENOTSUP",
        "Terminals are not supported on this system yet",
    ))
}

/// Run the program in a new terminal, sending a `started` event and then its output, until it exits.
// Unix pty 主入口：创建 PTY、启动程序、登记终端、并行读输出/写输入/等待退出，返回 { exitCode } 或 Failure。
// 阻塞函数，由 main.rs 为每个 pty 请求单独开线程调用。
// 例：默认 shell 正常退出返回 Ok(json!({"exitCode": 0}))；取消返回 Err(code="aborted")。
#[cfg(unix)]
pub fn run(
    id: u32,
    request: PtyRequest,
    output: &Arc<Output>,
    control: &Control,
    groups: &Groups,
    terminals: &Terminals,
) -> Result<Value, Failure> {
    // 这里在函数体内导入 Unix 专用类型，避免非 Unix 构建出现未使用导入；这不是动态导入，只是作用域更小的 use。
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, RecvTimeoutError};
    use std::thread;
    use std::time::{Duration, Instant};

    // 多生产者通道：读线程、等待线程和 cancel 都向主循环发 Message。
    let (sender, receiver) = mpsc::channel();
    control.attach(sender.clone());
    // 取消在登记后、启动前到达时，不创建终端直接返回 aborted。
    if control.aborted.load(Ordering::SeqCst) {
        return Err(Failure::new("aborted", "aborted"));
    }
    // 工作目录必须存在；与 exec/process 一致，失败码为 spawn_error。
    if !std::path::Path::new(&request.cwd).exists() {
        return Err(Failure::new(
            "spawn_error",
            format!("Working directory does not exist: {}", request.cwd),
        ));
    }
    // unix::spawn 创建 PTY 并启动子进程，返回 master 句柄与 Child；失败统一映射为 spawn_error。
    let (master, child) =
        unix::spawn(&request).map_err(|error| Failure::new("spawn_error", error.to_string()))?;
    // Arc 让 master 可同时被读线程、Terminal 和 foreground/resize 使用。
    let master = Arc::new(master);
    let pid = child.id();
    // 进程组登记；连接结束时可统一 kill。
    groups.lock().unwrap().insert(pid);
    // 输入队列；真正的写入线程稍后创建。
    let (input, inputs) = mpsc::channel::<Vec<u8>>();
    // 先登记 Terminal 再发 started，客户端收到 started 后立刻写输入也能找到它。
    terminals.lock().unwrap().insert(
        id,
        Arc::new(Terminal {
            input,
            master: master.clone(),
            pid,
        }),
    );
    // started 是控制帧，优先于 bulk 输出。
    output.control(Frame::new(
        EVENT,
        id,
        json!({ "kind": "started", "pid": pid }),
    ));

    let stop = Arc::new(AtomicBool::new(false));
    // A thread that cannot start (a task limit) fails the terminal; the started program is killed and reaped.
    // 线程创建失败时统一收尾：停止读线程、杀进程组、wait 回收、移除终端与进程组登记。
    let abandon = |mut child: std::process::Child, error: std::io::Error| {
        stop.store(true, Ordering::SeqCst);
        kill_group(pid);
        // 注意：这里没有再 child.kill()，因为 kill_group 已覆盖（Windows 不走此 Unix 路径）。
        let _ = child.wait();
        terminals.lock().unwrap().remove(&id);
        groups.lock().unwrap().remove(&pid);
        Failure::new("spawn_error", error.to_string())
    };
    // 读线程：poll + read master，把原始字节发给主循环；读到错误/EOF 后补发 Eof。
    let started = {
        let master = master.clone();
        let sender = sender.clone();
        let stop = stop.clone();
        let output = output.clone();
        thread::Builder::new().spawn(move || {
            unix::read(&master, &stop, |bytes| {
                // is_ok() 表示主循环仍在接收；否则停止读取。
                let delivered = sender.send(Message::Data(0, bytes.to_vec())).is_ok();
                // Like a full pipe: a program that writes faster than the link waits.
                // 未发送输出超过 4MiB 时暂停读取，模拟满管道。
                output.wait_for_room(&stop);
                delivered
            });
            let _ = sender.send(Message::Eof(0));
        })
    };
    // reader 的 JoinHandle 在收尾时 join，确保读线程不再访问 master。
    let reader = match started {
        Ok(reader) => reader,
        Err(error) => return Err(abandon(child, error)),
    };
    // 写线程：按通道顺序把输入写入 master；终端关闭或 stop 置位时退出。
    let started = {
        let master = master.clone();
        let stop = stop.clone();
        thread::Builder::new().spawn(move || {
            for bytes in inputs {
                if !unix::write_all(&master, &bytes, &stop) {
                    return;
                }
            }
        })
    };
    if let Err(error) = started {
        return Err(abandon(child, error));
    }
    // 等待线程负责 wait 回收；失败时 child 交还以便 abandon。
    if let Err((child, error)) = start_waiter(child, sender.clone()) {
        return Err(abandon(child, error));
    }
    drop(sender);

    // 状态变量：退出状态、读线程是否结束、退出后的静默截止点、取消/杀标记。
    let mut status = None;
    let mut ended = false;
    let mut idle_until: Option<Instant> = None;
    let mut aborted = false;
    let mut killed = false;
    // 只杀一次进程组。
    let kill = |killed: &mut bool| {
        if !*killed {
            *killed = true;
            kill_group(pid);
        }
    };
    // attach 前到达的 kill 在此补执行。
    if control.killed.load(Ordering::SeqCst) {
        kill(&mut killed);
    }
    // 事件循环：转发终端输出、记录退出、处理取消与静默超时。
    loop {
        // 正常结束：进程已退出且终端读端已结束。
        if status.is_some() && ended {
            break;
        }
        // 计算等待时长；静默窗口到期直接结束循环。
        let wait = match idle_until {
            Some(idle) => {
                let now = Instant::now();
                if now >= idle {
                    // A background job may keep the terminal open after the program exited.
                    // 后台任务可能仍持有终端；静默窗口到期后不再等待。
                    break;
                }
                idle - now
            }
            None => Duration::from_secs(3600),
        };
        match receiver.recv_timeout(wait) {
            Ok(Message::Data(_, bytes)) => {
                // 终端输出是原始字节，不按流区分（PTY 只有一个流），JSON 只有 kind。
                output.bulk(
                    Frame::with_payload(EVENT, id, json!({ "kind": "output" }), bytes),
                    None,
                );
                // 程序退出后仍有输出时重置静默计时。
                if status.is_some() {
                    idle_until = Some(Instant::now() + EXIT_GRACE);
                }
            }
            Ok(Message::Eof(_)) => ended = true,
            Ok(Message::Exit(exit)) => {
                status = Some(Ok(exit));
                idle_until = Some(Instant::now() + EXIT_GRACE);
            }
            Ok(Message::WaitFailed(error)) => {
                status = Some(Err(error));
                idle_until = Some(Instant::now());
            }
            Ok(Message::Cancel) => {
                // 取消：杀进程组并最终返回 aborted。
                aborted = true;
                kill(&mut killed);
            }
            Ok(Message::Kill) => kill(&mut killed),
            Err(RecvTimeoutError::Timeout) => {}
            // 所有发送端消失：结束循环，后面按已有状态判定。
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    stop.store(true, Ordering::SeqCst);
    // Ending the input channel ends the writer thread.
    // 从运行表移除 Terminal 会 drop input 发送端，写线程的 for 循环随之结束。
    terminals.lock().unwrap().remove(&id);
    groups.lock().unwrap().remove(&pid);
    // join 读线程，确保它已停止使用 master；join 的错误（线程 panic）在此不影响协议结果。
    let _ = reader.join();
    if aborted {
        return Err(Failure::new("aborted", "aborted"));
    }
    match status {
        Some(Ok(status)) => Ok(json!({ "exitCode": crate::sys::exit_code(status) })),
        Some(Err(error)) => Err(Failure::new("spawn_error", error)),
        // 没有退出状态时不能伪造 exitCode。
        None => Err(Failure::new(
            "spawn_error",
            "process did not report its exit",
        )),
    }
}

// Unix 专用实现：PTY 创建与系统调用。内部函数不导出到 crate 外。
#[cfg(unix)]
mod unix {
    use super::PtyRequest;
    use std::fs::File;
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::Value;

    // libc 函数返回负数表示失败；成功时原样返回非负结果。
    // 例：ioctl 返回 -1 时转成 Err(last_os_error())；返回 0 时得到 Ok(0)。
    fn check(result: libc::c_int) -> io::Result<libc::c_int> {
        if result < 0 {
            // last_os_error 读取 errno 并构造可读的 io::Error。
            Err(io::Error::last_os_error())
        } else {
            Ok(result)
        }
    }

    // 构造内核使用的窗口尺寸结构；像素字段置 0 表示不关心。
    // 例：winsize(80, 24) 得到 ws_col=80、ws_row=24。
    fn winsize(cols: u16, rows: u16) -> libc::winsize {
        libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        }
    }

    // 设置终端窗口大小；ioctl(TIOCSWINSZ) 会让内核向前台进程组发 SIGWINCH。
    // 例：set_size(&master, 120, 40) 成功后，前台程序下次查询尺寸得到 120x40。
    pub fn set_size(master: &File, cols: u16, rows: u16) -> io::Result<()> {
        let size = winsize(cols, rows);
        // SAFETY: TIOCSWINSZ reads one winsize from a valid pointer.
        // unsafe 块表示调用方保证指针与描述符有效；&size 在调用期间有效。
        check(unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ as _, &size) })?;
        Ok(())
    }

    /// The terminal's foreground process group.
    // 返回前台进程组 id；失败时 errno 转 io::Error。
    // 例：shell 在提示符处通常返回 shell 自己的 pid；运行 vim 时返回 vim 的进程组 id。
    pub fn foreground(master: &File) -> io::Result<libc::pid_t> {
        // SAFETY: tcgetpgrp on a descriptor the terminal owns.
        let group = unsafe { libc::tcgetpgrp(master.as_raw_fd()) };
        if group < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(group)
        }
    }

    /// A process's name, if it still runs and the system tells.
    // macOS 用 libproc 的 proc_name；缓冲区 256 字节，返回实际写入长度，0 表示取不到。
    // 例：pid 指向运行中的 vim 时返回 Some("vim")；进程已退出时返回 None。
    #[cfg(target_vendor = "apple")]
    pub fn process_name(pid: libc::pid_t) -> Option<String> {
        let mut buffer = [0u8; 256];
        // SAFETY: proc_name writes at most `buffer.len()` bytes and returns how many.
        // as_mut_ptr().cast() 把 *mut u8 转成 proc_name 需要的指针类型。
        let length =
            unsafe { libc::proc_name(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        // then 只在长度为正时构造 String；from_utf8_lossy 处理非 UTF-8 字节。
        (length > 0).then(|| String::from_utf8_lossy(&buffer[..length as usize]).into_owned())
    }

    // Linux/Android 从 /proc/<pid>/comm 读取进程名；文件不存在或权限不足时返回 None。
    // 例：/proc/123/comm 内容 "vim\n" 时返回 Some("vim")。
    #[cfg(any(target_os = "linux", target_os = "android"))]
    pub fn process_name(pid: libc::pid_t) -> Option<String> {
        let name = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
        // comm 通常带末尾换行；trim_end 去掉，再过滤空名字。
        Some(name.trim_end().to_string()).filter(|name| !name.is_empty())
    }

    // 其他 Unix 系统没有通用查询方式，返回 None（JSON 中 name 为 null）。
    #[cfg(not(any(target_vendor = "apple", target_os = "linux", target_os = "android")))]
    pub fn process_name(_pid: libc::pid_t) -> Option<String> {
        None
    }

    // 设置 close-on-exec：fork 后 exec 其他程序时自动关闭该描述符，避免泄漏给子进程。
    // 例：对 openpty 返回的两个 fd 调用后，子进程 exec 时不会继承 daemon 的额外副本。
    fn cloexec(fd: libc::c_int) -> io::Result<()> {
        // SAFETY: fcntl on a descriptor this function's caller owns.
        unsafe {
            let flags = check(libc::fcntl(fd, libc::F_GETFD))?;
            check(libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC))?;
        }
        Ok(())
    }

    /// The program to run: `argv`, or the user's shell as a login shell (`-` before its name, as `login` does).
    // 构造 Command：有 argv 直接执行；没有则挑一个存在的 SHELL，并以 “-名字” 的 argv[0] 启动登录 shell。
    // 例：argv=["/bin/zsh","-l"] 直接执行；argv=None 且 SHELL=/bin/zsh 时用 arg0="-zsh" 启动。
    fn command(request: &PtyRequest) -> Command {
        match &request.argv {
            Some(argv) => {
                let mut command = Command::new(&argv[0]);
                // &argv[1..] 跳过程序名，其余作为参数。
                command.args(&argv[1..]);
                command
            }
            None => {
                // 依次尝试：请求 env 中的 SHELL、daemon 自己的 SHELL 环境变量、/bin/sh。
                let shell = request
                    .env
                    .get("SHELL")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| std::env::var("SHELL").ok())
                    // 过滤空字符串与不存在的路径，避免启动一个不存在的 shell。
                    .filter(|shell| !shell.is_empty() && crate::sys::path_exists(shell))
                    .unwrap_or_else(|| "/bin/sh".into());
                // 取路径最后一段作为登录名，例如 /bin/zsh -> zsh；rsplit 从右往左找 '/'。
                let name = shell.rsplit('/').next().unwrap_or("sh").to_string();
                let mut command = Command::new(&shell);
                // argv[0] 前加 '-' 是 login shell 的约定，读取登录配置。
                command.arg0(format!("-{name}"));
                command
            }
        }
    }

    // 创建 PTY 对（master/slave），用 slave 作为子进程的 stdin/stdout/stderr，并设置会话、信号与窗口大小。
    // 例：spawn(&request) 返回 (master, child)；之后 daemon 读写 master，child 像在真实终端里一样运行。
    pub fn spawn(request: &PtyRequest) -> io::Result<(File, Child)> {
        // -1 是 openpty 失败时的初值；成功后由系统写入真实描述符。
        let mut master: libc::c_int = -1;
        let mut slave: libc::c_int = -1;
        let mut size = winsize(request.cols, request.rows);
        // SAFETY: openpty writes two descriptors; the name and termios are not requested.
        // &raw mut size 取得裸指针（Rust 2024 语法），传给会写回窗口尺寸的系统调用。
        check(unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &raw mut size,
            )
        })?;
        // SAFETY: openpty returned two new descriptors this function now owns.
        // OwnedFd 负责关闭描述符，避免手工管理导致泄漏。
        let (master, slave) =
            unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        cloexec(master.as_raw_fd())?;
        cloexec(slave.as_raw_fd())?;
        // 转成 File 以便 clone 与读写；slave 稍后用于三次 Stdio::from。
        let slave = File::from(slave);
        let mut command = command(request);
        command
            .current_dir(&request.cwd)
            // try_clone 复制描述符，让 stdin/stdout/stderr 各持一份；原 slave 仍用于 drop 时机控制。
            .stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave.try_clone()?));
        // 不继承 daemon 环境时先清空，再只加请求里的字符串值。
        if !request.inherit_env {
            command.env_clear();
        }
        for (key, value) in &request.env {
            if let Some(value) = value.as_str() {
                command.env(key, value);
            }
        }
        // SAFETY: only async-signal-safe calls between fork and exec.
        // pre_exec 在 fork 之后、exec 之前运行；这里只能调用异步信号安全的系统调用。
        unsafe {
            command.pre_exec(|| {
                // A new session whose controlling terminal is the pty (stdin), so job control and SIGHUP work; default
                // signal handling and an empty mask, as for `exec`.
                // setsid 让子进程成为新会话首进程和进程组首进程，脱离 daemon 的会话。
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                // fd 0 此时已是 slave PTY；TIOCSCTTY 把它设为该会话的控制终端。
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                // 把 1..31 号信号恢复默认处理，但 SIGKILL/SIGSTOP 不可捕获，不能也不需设置。
                for signal in 1..32 {
                    if signal != libc::SIGKILL && signal != libc::SIGSTOP {
                        libc::signal(signal, libc::SIG_DFL);
                    }
                }
                // 清空信号屏蔽字，让新程序从干净状态开始；zeroed 得到全零的 sigset_t。
                let mut mask: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut mask);
                libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut());
                Ok(())
            });
        }
        // 执行 fork/exec；失败时返回 io::Error，由调用方映射为 spawn_error。
        let child = command.spawn()?;
        // Only the program holds the terminal now, so reads end once it and its descendants close it.
        // 父进程丢掉 slave 副本，终端只剩子进程持有；这样 master 读端会在所有持有者关闭后结束。
        drop(slave);
        let master = File::from(master);
        // SAFETY: fcntl on the descriptor owned above; reads and writes poll instead of blocking.
        // 设为非阻塞，配合 poll 实现可被 stop 打断的读/写循环。
        unsafe {
            let flags = check(libc::fcntl(master.as_raw_fd(), libc::F_GETFL))?;
            check(libc::fcntl(
                master.as_raw_fd(),
                libc::F_SETFL,
                flags | libc::O_NONBLOCK,
            ))?;
        }
        Ok((master, child))
    }

    // 等待描述符就绪，最多 100ms；返回 Ok(true) 表示就绪，Ok(false) 表示超时或 EINTR，Err 表示真实错误。
    // 例：poll(fd, POLLIN) 在终端有输入时尽快返回 true；100ms 内没有则返回 false，让外层重查 stop。
    fn poll(fd: libc::c_int, events: libc::c_short) -> io::Result<bool> {
        let mut poll = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        // SAFETY: one valid pollfd.
        let ready = unsafe { libc::poll(&mut poll, 1, 100) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            // 信号中断不是错误，返回 false 让外层继续轮询。
            return if error.kind() == io::ErrorKind::Interrupted {
                Ok(false)
            } else {
                Err(error)
            };
        }
        Ok(ready > 0)
    }

    /// Read until the terminal closes (Linux reports `EIO` once no program holds it), `on_data` returns false, or
    /// `stop` is set.
    // 循环 poll master 再 read；on_data 返回 false 或 stop 置位即停止。
    // 例：read(&master, &stop, |bytes| { tx.send(bytes.to_vec()).is_ok() }) 读到 EOF 或发送失败时返回。
    pub fn read(master: &File, stop: &AtomicBool, mut on_data: impl FnMut(&[u8]) -> bool) {
        // 64KiB 读缓冲；终端输出通常远小于此，单次系统调用可读多块。
        let mut buffer = vec![0u8; 64 * 1024];
        while !stop.load(Ordering::SeqCst) {
            // 先等可读，避免非阻塞 read 立即返回 WouldBlock 造成忙等。
            match poll(master.as_raw_fd(), libc::POLLIN) {
                Ok(false) => continue,
                Ok(true) => {}
                Err(_) => return,
            }
            match (&*master).read(&mut buffer) {
                // 0 是正常 EOF（所有写端关闭）。
                Ok(0) => return,
                Ok(read) => {
                    // 切片只覆盖实际读到的字节；on_data 返回 false 表示上层要求停止。
                    if !on_data(&buffer[..read]) {
                        return;
                    }
                }
                // 非阻塞描述符暂无数据或被信号打断：继续外层轮询。
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                // Linux 在无程序持有终端时会报 EIO，视为结束；其他错误也结束。
                Err(_) => return,
            }
        }
    }

    /// Write all of `bytes`, waiting while the program does not read its input; false once the terminal is gone.
    // 循环写 master：部分写入时推进切片；WouldBlock 时用 poll(POLLOUT) 等待；stop 置位或错误时返回 false。
    // 例：write_all(&master, b"ls\n", &stop) 在终端可写后返回 true；终端已关闭时返回 false。
    pub fn write_all(master: &File, mut bytes: &[u8], stop: &AtomicBool) -> bool {
        while !bytes.is_empty() {
            if stop.load(Ordering::SeqCst) {
                return false;
            }
            match (&*master).write(bytes) {
                // 写入 0 字节在非阻塞写中表示无法继续，按终端已关闭处理。
                Ok(0) => return false,
                // 只丢掉已写入前缀，剩余字节下一轮继续写。
                Ok(written) => bytes = &bytes[written..],
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    // 等待可写；poll 返回 Err 表示描述符有问题，停止。
                    if poll(master.as_raw_fd(), libc::POLLOUT).is_err() {
                        return false;
                    }
                }
                // EINTR：信号打断，直接重试。
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => return false,
            }
        }
        true
    }
}
