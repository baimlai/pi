//! `process`: a long-lived program with plain pipes, for programs that speak a protocol on stdin and stdout (an MCP
//! server). Unlike `exec`, the program reads input (`processWrite`, `processCloseStdin`, addressed by the `process`
//! request's id) and output is raw bytes per stream; unlike `pty`, nothing is echoed, translated or merged.
//
// 文件导读（packages/env/daemon/src/process.rs）
// 所属包/模块：packages/env 的 Rust daemon（二进制 pi-env）中的 process 模块，对应协议里的 process、
// processWrite 与 processCloseStdin 三个操作。
// 解决的问题与职责边界：用普通管道（不是 PTY）启动一个长期运行、通过 stdin/stdout 说协议的程序（例如 MCP
// server）。daemon 负责启动进程、把原始字节按流编号作为 output 事件发送、按到达顺序写 stdin、关闭 stdin、
// 处理取消/终止与退出码。它不解析程序内容、不合并 stdout/stderr，也不做换行转换（与 pty 的区别）。
// 上游入口：main.rs 的 Server::dispatch 在 op == "process" 时调用 run；processWrite/processCloseStdin 由
// serve_frames 在帧读取线程中直接调用 write/close_stdin，保证输入顺序与到达顺序一致。
// 下游依赖：exec.rs（Control、Message、spawn、spawn_reader、start_waiter、kill_group、running）、sys（程序解析、
// 管道写入、退出码）、frame（EVENT）、output（唯一写线程）。
// 能力清单（按导出项）：
//   - Process：一个运行中程序的 stdin 发送端，供后续写请求找到它。
//   - Processes：以 process 请求 id 为键的运行表，连接内共享。
//   - ProcessRequest 与 from_json：解析 argv/cwd/env/inheritEnv；argv 必填。
//   - write：把一块 payload 排入 stdin 队列（不等待实际写出）。
//   - close_stdin：在已排队输入之后关闭 stdin。
//   - run：启动并监督进程，发送 started/output 事件，返回 { exitCode } 或 Failure。
// 组合关系/典型调用顺序：
//   Server::dispatch("process") -> ProcessRequest::from_json -> run
//   -> 启动子进程与读线程 -> 登记 Process -> 发送 started -> 循环收 Data/Eof/Exit
//   -> 期间 processWrite/processCloseStdin 通过 running() 找到 Process 并写入 -> 返回退出码。
// 示例（真实签名，来自 main.rs 的调用；不是可独立运行的代码块）：
//   process::run(id, process::ProcessRequest::from_json(json)?, &server.output, control, &server.groups,
//                &server.processes)?;
//   程序中若调用 process::write(&server.processes, &json, payload)?，payload 会按顺序写入其 stdin。
// 建议阅读顺序：先看 Input/Process/ProcessRequest，再看 write/close_stdin 的队列语义，最后读 run 的事件循环。

use crate::errors::Failure;
use crate::exec::{
    Control, Groups, Launch, Message, kill_group, running, spawn, spawn_reader, start_waiter,
};
use crate::frame::{EVENT, Frame};
use crate::output::Output;
use crate::sys;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::process::{Child, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// After the program exits, output still arriving is collected until this much silence, as for `exec`.
// 进程退出后继续收集输出的静默窗口；与 exec 一致，避免后代短暂持有管道时丢尾部输出。
const EXIT_STDIO_GRACE: Duration = Duration::from_millis(100);

/// Input for a program's stdin, in arrival order.
// 内部队列只放两种动作：写一块字节，或在已排队数据之后关闭 stdin；顺序由 mpsc 通道天然保证。
// 例：先 send(Data(b"hi")) 再 send(Close)，写线程会先写 hi，再关闭 stdin。
enum Input {
    Data(Vec<u8>),
    Close,
}

/// What `processWrite` and `processCloseStdin` reach: the stdin of one running `process` request.
// 只公开 sender：后续请求通过它排队，真正的写入线程在 run 中创建并独占 stdin 句柄。
// 例：processWrite 到达时，write() 从这个 sender 发送 Input::Data。
pub struct Process {
    input: Sender<Input>,
}

/// Running programs by the id of their `process` request.
// Arc<Mutex<HashMap>> 让帧读取线程、worker 线程和主循环共享同一张运行表。
pub type Processes = Arc<Mutex<HashMap<u32, Arc<Process>>>>;

// process 请求的已解析形式；argv 必填，其余字段与 exec 的 argv 模式类似。
pub struct ProcessRequest {
    argv: Vec<String>,
    cwd: String,
    env: Map<String, Value>,
    inherit_env: bool,
}

impl ProcessRequest {
    // 从 JSON 解析请求；不做 I/O。缺 argv、空 argv、缺 cwd 或字段类型错误都返回 EINVAL。
    // 例：{"argv":["npx","server"],"cwd":"/tmp"} -> argv 含两项、inherit_env 默认 true。
    pub fn from_json(json: &Value) -> Result<ProcessRequest, Failure> {
        Ok(ProcessRequest {
            // exec::argv 返回 Option：null/缺失为 None，这里再要求必须有值。
            argv: crate::exec::argv(json)?
                .ok_or_else(|| Failure::new("EINVAL", "process needs argv"))?,
            cwd: json["cwd"]
                .as_str()
                .ok_or_else(|| Failure::new("EINVAL", "process needs cwd"))?
                .to_string(),
            // env 只接受对象；clone 复制一层，避免借用输入 JSON。
            env: json["env"].as_object().cloned().unwrap_or_default(),
            inherit_env: json["inheritEnv"].as_bool().unwrap_or(true),
        })
    }
}

/// Queue input for the program's stdin; it is written in the order it arrives, without holding up other requests.
// target 指向运行中的 process 请求 id；send 只把数据放进通道，不等待真正写进管道。
// 找不到进程或 stdin 已关闭时返回 EBADF。例：write(&processes, &json!({"target":9}), b"x") 立即返回 {}。
pub fn write(processes: &Processes, json: &Value, payload: Vec<u8>) -> Result<Value, Failure> {
    // running 泛型返回 Arc<Process>；? 把 EINVAL/EBADF 直接传给客户端。
    running(processes, json, "process")?
        .input
        .send(Input::Data(payload))
        // 接收端消失说明写线程已退出（通常是 stdin 已关闭或程序结束）：映射为 EBADF。
        .map_err(|_| Failure::new("EBADF", "the program's stdin is closed"))?;
    Ok(json!({}))
}

/// Close the program's stdin once the input queued before has been written.
// Close 与 Data 走同一队列，因此它一定排在此前写入请求之后，不会提前关闭。
// 例：先 write(b"q\n") 再 close_stdin，程序会完整读到 q\n 后才看到 EOF。
pub fn close_stdin(processes: &Processes, json: &Value) -> Result<Value, Failure> {
    running(processes, json, "process")?
        .input
        .send(Input::Close)
        .map_err(|_| Failure::new("EBADF", "the program's stdin is closed"))?;
    Ok(json!({}))
}

/// Run the program, sending a `started` event and then its output, until it exits.
// process 主入口：启动程序、登记可写句柄、发送 started、循环转发原始输出，最终返回 { exitCode } 或 Failure。
// 阻塞函数，由 main.rs 为每个 process 请求单独开线程调用。
// 例：成功返回 Ok(json!({"exitCode": 0}))；进程无法启动时返回 Err(code="spawn_error")。
pub fn run(
    id: u32,
    request: ProcessRequest,
    output: &Arc<Output>,
    control: &Control,
    groups: &Groups,
    processes: &Processes,
) -> Result<Value, Failure> {
    // 多生产者通道：两个读线程、等待线程和 cancel 都向主循环发 Message。
    let (sender, receiver) = mpsc::channel();
    control.attach(sender.clone());
    // 若 cancel 在登记后、启动前到达，直接以 aborted 结束，不启动程序。
    if control.aborted.load(Ordering::SeqCst) {
        return Err(Failure::new("aborted", "aborted"));
    }
    // argv 模式直接执行程序，不经过 shell；resolve_program 处理平台差异。
    // 索引 argv[0] 安全，因为 from_json 已保证非空。
    let program = sys::resolve_program(&request.argv[0], &request.cwd, &request.env)?;
    // 工作目录必须存在；不存在统一报 spawn_error（与 exec 一致）。
    if !Path::new(&request.cwd).exists() {
        return Err(Failure::new(
            "spawn_error",
            format!("Working directory does not exist: {}", request.cwd),
        ));
    }
    // Launch 借用请求字段；spawn 期间 request 不会被移动或改写。
    let launch = Launch {
        cwd: &request.cwd,
        env: &request.env,
        inherit_env: request.inherit_env,
    };
    // stdin 使用 piped，因为后续 processWrite 要写入；stdout/stderr 由 spawn 内部设为 piped。
    let mut child = spawn(&program, &request.argv[1..], &launch, Stdio::piped())
        .map_err(|error| Failure::new("spawn_error", error.to_string()))?;
    let pid = child.id();
    // 登记进程组，连接结束时由 kill_all 统一终止。
    groups.lock().unwrap().insert(pid);
    let stop = Arc::new(AtomicBool::new(false));
    // A thread that cannot start (a task limit) fails the request; the started program is killed and reaped. Threads
    // already running see `stop` within 100 ms.
    // 线程创建失败时统一收尾：停止读线程、杀进程组、直接 kill 并 wait，移除登记，返回 spawn_error。
    let abandon = |mut child: Child, error: std::io::Error| {
        stop.store(true, Ordering::SeqCst);
        kill_group(pid);
        // On Windows the group kill spawns taskkill, which can fail under the same limit; kill the child directly.
        let _ = child.kill();
        let _ = child.wait();
        groups.lock().unwrap().remove(&pid);
        Failure::new("spawn_error", error.to_string())
    };
    // Like a full pipe: a program that writes faster than the link waits.
    // stdout 读线程把原始字节发给主循环；Some(output) 启用 4MiB 背压，模拟满管道。
    let stdout = child.stdout.take().unwrap();
    if let Err(error) = spawn_reader(
        0,
        stdout,
        sender.clone(),
        stop.clone(),
        Some(output.clone()),
    ) {
        return Err(abandon(child, error));
    }
    // stderr 使用流编号 1；与 stdout 完全独立，不合并。
    let stderr = child.stderr.take().unwrap();
    if let Err(error) = spawn_reader(
        1,
        stderr,
        sender.clone(),
        stop.clone(),
        Some(output.clone()),
    ) {
        return Err(abandon(child, error));
    }
    // stdin 的输入队列：通道关闭（所有 Sender 被 drop）时 writer 线程自然结束。
    let (input, inputs) = mpsc::channel::<Input>();
    let mut stdin = child.stdin.take().unwrap();
    // 写线程按通道顺序逐个处理：Data 调用 sys::write_pipe（可因满管道等待），Close 直接 return。
    let started = {
        let stop = stop.clone();
        thread::Builder::new().spawn(move || {
            for input in inputs {
                match input {
                    Input::Data(bytes) => {
                        // write_pipe 返回 false 表示停止标记已置位或管道已坏，写线程退出。
                        if !sys::write_pipe(&mut stdin, &bytes, &stop) {
                            return;
                        }
                    }
                    // Returning drops stdin, which closes it; later input fails with `EBADF`.
                    // return 时 stdin 被 drop，系统调用层关闭管道；之后 send 到已关闭通道会得到 EBADF。
                    Input::Close => return,
                }
            }
        })
    };
    if let Err(error) = started {
        return Err(abandon(child, error));
    }
    // 等待线程负责 wait 回收，避免僵尸进程；失败时 child 被交还以便 abandon。
    if let Err((child, error)) = start_waiter(child, sender.clone()) {
        return Err(abandon(child, error));
    }
    // 主循环不再主动发送；所有发送端结束后 receiver 才会 Disconnected。
    drop(sender);
    // Registered before `started` goes out, so input sent after it always finds the program.
    // 先登记再发 started：客户端收到 started 后立刻 processWrite 时一定能找到这个进程。
    processes
        .lock()
        .unwrap()
        .insert(id, Arc::new(Process { input }));
    // started 是控制帧，优先于后续 bulk 输出发送。
    output.control(Frame::new(
        EVENT,
        id,
        json!({ "kind": "started", "pid": pid }),
    ));

    // 两个流是否 EOF；退出状态；退出后静默截止点；取消/杀标记。
    let names = ["stdout", "stderr"];
    let mut ended = [false, false];
    let mut status: Option<Result<ExitStatus, String>> = None;
    let mut idle_until: Option<Instant> = None;
    let mut aborted = false;
    let mut killed = false;
    // 同一个进程组只杀一次，避免重复 kill 掩盖第一次结果。
    let kill = |killed: &mut bool| {
        if !*killed {
            *killed = true;
            kill_group(pid);
        }
    };
    // attach 前到达的 kill 请求在这里补执行。
    if control.killed.load(Ordering::SeqCst) {
        kill(&mut killed);
    }
    // 事件循环：转发 Data，记录 Eof/Exit，处理取消与静默超时。
    loop {
        // 正常结束：进程已退出且两个管道都关闭。
        if status.is_some() && ended[0] && ended[1] {
            break;
        }
        // 计算本次等待时长：没有 idle 截止点时等一小时；否则等到静默窗口结束或直接跳出。
        let wait = match idle_until {
            Some(idle) => {
                let now = Instant::now();
                if now >= idle {
                    // A descendant may hold the pipes open after the program exited; stop waiting for it.
                    // 后代仍占着管道时不再继续等，保证请求能结束。
                    break;
                }
                idle - now
            }
            None => Duration::from_secs(3600),
        };
        match receiver.recv_timeout(wait) {
            Ok(Message::Data(stream, bytes)) => {
                // 原始字节直接作为 payload，不做 UTF-8 解码或换行处理；stream 对应 stdout/stderr。
                output.bulk(
                    Frame::with_payload(
                        EVENT,
                        id,
                        json!({ "kind": "output", "stream": names[stream] }),
                        bytes,
                    ),
                    None,
                );
                // 进程退出后仍有数据：重新开始 100ms 静默计时。
                if status.is_some() {
                    idle_until = Some(Instant::now() + EXIT_STDIO_GRACE);
                }
            }
            Ok(Message::Eof(stream)) => ended[stream] = true,
            Ok(Message::Exit(exit)) => {
                status = Some(Ok(exit));
                idle_until = Some(Instant::now() + EXIT_STDIO_GRACE);
            }
            Ok(Message::WaitFailed(error)) => {
                // wait 失败没有可报告的退出码；立即结束等待，稍后返回 spawn_error。
                status = Some(Err(error));
                idle_until = Some(Instant::now());
            }
            Ok(Message::Cancel) => {
                // 取消：杀进程组，最终以 aborted 结束（spill 不适用于 process）。
                aborted = true;
                kill(&mut killed);
            }
            Ok(Message::Kill) => kill(&mut killed),
            Err(RecvTimeoutError::Timeout) => {}
            // 所有发送端消失：可能进程异常且没有 Exit 消息，交给后面统一报错。
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    // Readers and the writer stop within 100 ms, also when a descendant still holds a pipe; removing the program
    // drops its input channel, which ends a writer waiting for input.
    // 停止读线程；从运行表移除会 drop Process（连同 input 发送端），写线程的 for 循环随即结束。
    stop.store(true, Ordering::SeqCst);
    processes.lock().unwrap().remove(&id);
    groups.lock().unwrap().remove(&pid);
    if aborted {
        return Err(Failure::new("aborted", "aborted"));
    }
    match status {
        Some(Ok(status)) => Ok(json!({ "exitCode": sys::exit_code(status) })),
        Some(Err(error)) => Err(Failure::new("spawn_error", error)),
        // 没有收到退出状态又不能伪造 exitCode，只能报 spawn_error。
        None => Err(Failure::new(
            "spawn_error",
            "process did not report its exit",
        )),
    }
}
