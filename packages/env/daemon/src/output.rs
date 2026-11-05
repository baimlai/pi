//! The single writer of stdout. Control frames (results, errors, pings, watch events) always go before bulk command
//! output, so a slow link delays output but never a cancel's result or a ping. Bulk output is bounded: readers of
//! commands without an output window wait while too much of it is unsent, which slows the command down like a full
//! pipe would.
//
// 文件导读（packages/env/daemon/src/output.rs）
// 所属包/模块：packages/env 的 Rust daemon（二进制 pi-env）中的 stdout 单写线程模块。
// 解决的问题与职责边界：所有帧只能由一个线程写 stdout，否则字节会交错；本模块提供两个优先级队列（控制帧与
// bulk 输出）、写线程、背压与关闭通知。它不决定帧内容、不做协议解析，也不保证失败后重发。
// 上游入口：main.rs 的 respond 把 RESULT/ERROR 放入 control 或 bulk；exec/pty/process/watch 把 EVENT 放入
// bulk；心跳线程放 PING；serve 结束时调用 close。
// 下游依赖：frame::write_frame 执行实际序列化与写操作；std 的 Mutex/Condvar/VecDeque 提供同步原语。
// 能力清单（按导出项）：
//   - BULK_LIMIT（私有常量）：未发送 bulk 字节超过 4MiB 时，无窗口命令的读取方等待。
//   - Queues（私有）：control/bulk 两个队列、bulk 字节计数与 closed 标记。
//   - Output::control：高优先级入队（结果、错误、心跳、watch 事件）。
//   - Output::bulk：低优先级入队，可携带发送方的未发送帧计数。
//   - Output::wait_for_room：生产者等待队列降到阈值以下，或被 close/stop 打断。
//   - Output::close：置关闭标记并唤醒所有等待者；队列中已有的帧仍会被写完。
//   - Output::run：单写线程循环，先取控制帧，再取 bulk 帧，写失败则关闭。
// 组合关系/典型调用顺序：调用方构造 Frame -> control/bulk 入队并 notify -> run 取帧 -> write_frame ->
// drained.notify_all 唤醒容量等待者；进程结束时 close -> run 清空队列后返回。
// 示例（真实签名，来自 main.rs）：output.control(Frame::new(PING, 0, json!({})))；
// 命令输出则 output.bulk(Frame::with_payload(EVENT, id, json, bytes), Some(unsent_counter))。
// 建议阅读顺序：先看 Queues/BULK_LIMIT 的字段含义，再看 control/bulk 的入队规则，然后 wait_for_room/close 的
// 唤醒条件，最后读 run 的取帧顺序与失败处理。

use crate::frame::{self, Frame};
use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// Unsent bulk bytes above which unwindowed command output waits.
const BULK_LIMIT: usize = 4 * 1024 * 1024;

// Default 创建空队列、零计数与 closed=false；VecDeque 支持从尾入队、从头出队。
#[derive(Default)]
struct Queues {
    control: VecDeque<Frame>,
    // 每个 bulk 帧可携带发送方的共享计数器；它统计帧数，bulk_bytes 统计仍在队列的 payload 字节。
    bulk: VecDeque<(Frame, Option<Arc<AtomicUsize>>)>,
    bulk_bytes: usize,
    closed: bool,
}

// Mutex 保护共享队列；Condvar 让线程睡眠等待状态变化，唤醒后仍须重新检查条件。
#[derive(Default)]
pub struct Output {
    queues: Mutex<Queues>,
    /// Signalled when a frame is queued or the writer stops.
    queued: Condvar,
    /// Signalled when bulk bytes were written.
    drained: Condvar,
}

impl Output {
    // 把控制帧放到高优先队列并唤醒写线程，无返回值；只排队，不在调用线程做 I/O。
    // 例：PING 可越过尚未开始写出的 bulk 帧；无法抢占已经正在执行的 write_frame。
    pub fn control(&self, frame: Frame) {
        // lock 取得可变守卫；unwrap 在互斥锁中毒时 panic，不转为协议错误。
        let mut queues = self.queues.lock().unwrap();
        // 移动帧进入控制队列末尾，保持同类帧的到达顺序。
        queues.control.push_back(frame);
        // 唤醒一个等 queued 的线程，锁在离开函数时释放。
        self.queued.notify_one();
    }

    /// Queue bulk output; `unsent` counts this sender's frames until they are written.
    // 把 bulk 帧及可选计数器入队，更新共享统计并通知写线程；消费 frame，无同步 I/O。
    // 例：exec 的窗口输出传 Some(counter)，写线程完成一次写入尝试后会减一。
    pub fn bulk(&self, frame: Frame, unsent: Option<Arc<AtomicUsize>>) {
        // 所有队列与 bulk 字节数在同一把锁下更新，避免并发读写失配。
        let mut queues = self.queues.lock().unwrap();
        // 只算 payload，不算头和 JSON；这不是精确的所有内存占用上限。
        queues.bulk_bytes += frame.payload.len();
        // 借用 Option 以便仍能随后将其移入队列。
        if let Some(counter) = &unsent {
            // SeqCst 提供顺序一致的原子帧计数；入队前先加一。
            counter.fetch_add(1, Ordering::SeqCst);
        }
        // 队列取得帧与 Arc；Arc 可跨线程共享同一个计数器。
        queues.bulk.push_back((frame, unsent));
        // 通知写线程有新工作。
        self.queued.notify_one();
    }

    /// Wait while more than the bulk limit is unsent, unless `stop` is set.
    // 阻塞当前读取线程直到队列字节不超阈值、输出关闭或 stop 置位；无返回数据。
    // 例：未启用窗口的命令输出超过 4 MiB 时暂缓读取，最多每 100ms 重查取消标记。
    pub fn wait_for_room(&self, stop: &AtomicBool) {
        // 先上锁读取共享统计。
        let mut queues = self.queues.lock().unwrap();
        // while 防止虚假唤醒；阈值用 >，等于 4 MiB 不等待，停止/关闭可打断等待。
        while queues.bulk_bytes > BULK_LIMIT && !queues.closed && !stop.load(Ordering::SeqCst) {
            // wait_timeout 等待期间释放锁，返回时重新持有；元组 .0 只取锁守卫，忽略是否超时。
            queues = self
                .drained
                .wait_timeout(queues, Duration::from_millis(100))
                .unwrap()
                .0;
        }
    }

    // 设置关闭标记并唤醒所有等待者，无 I/O、无返回值；例：stdout 写失败时让生产者停止等容量。
    // 队列不在这里清空；run 仍先取已排队的帧，再在空队列时退出。
    pub fn close(&self) {
        // 关闭标记与队列同锁保护。
        let mut queues = self.queues.lock().unwrap();
        // 幂等赋值，重复调用仍是 closed=true。
        queues.closed = true;
        // 唤醒等新帧的写线程。
        self.queued.notify_all();
        // 也唤醒等容量的读线程，使其看见 closed。
        self.drained.notify_all();
    }

    /// Write frames to `writer` until closed or a write fails.
    // 单写线程循环选择控制帧、再选择 bulk 帧，释放锁后执行 write_frame；无返回数据。
    // 输入 writer 可以是真实 stdout，也可以是内存；队列空且关闭时退出，写失败时 close 后退出。
    // 例：控制和 bulk 都已排队时先发控制；控制流持续繁忙时 bulk 可能继续等待。
    pub fn run(&self, writer: &mut impl Write) {
        // 外层循环每次处理一帧，内层只负责等候或选出下一帧。
        loop {
            // 块表达式返回 (Frame, 可选计数器)；块结束后锁守卫释放，慢 I/O 不占队列锁。
            let (frame, unsent) = {
                let mut queues = self.queues.lock().unwrap();
                loop {
                    // pop_front 移出最早控制帧；break 的元组成为内层 loop 的值。
                    if let Some(frame) = queues.control.pop_front() {
                        break (frame, None);
                    }
                    // 没有控制帧才取 bulk，保留它的发送计数器。
                    if let Some((frame, unsent)) = queues.bulk.pop_front() {
                        // 移出队列即扣 payload 字节，尚未完成 I/O，因此统计不含正在写的那一帧。
                        queues.bulk_bytes -= frame.payload.len();
                        break (frame, unsent);
                    }
                    // 两队列都空时才检查关闭，避免正常关闭直接丢弃队列尾部。
                    if queues.closed {
                        return;
                    }
                    // 暂时无帧就释放锁等待；唤醒后回到 loop 再检查，不能假设一定有数据。
                    queues = self.queued.wait(queues).unwrap();
                }
            };
            // write_frame 写头、JSON、payload 并 flush；只记录是否失败，不传播具体 I/O 错误。
            let failed = frame::write_frame(writer, &frame).is_err();
            // 有计数器时无论此次写成功或失败都减一，结束这帧的未发送账目。
            if let Some(counter) = unsent {
                counter.fetch_sub(1, Ordering::SeqCst);
            }
            // 唤醒容量等待者；它们会在锁下重新检查统计。
            self.drained.notify_all();
            // 失败终止整个写循环，close 同时解除生产者等待；这里不尝试重发部分已写出的帧。
            if failed {
                self.close();
                return;
            }
        }
    }
}
