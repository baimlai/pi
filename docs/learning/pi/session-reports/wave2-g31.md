# 组 g31

状态：完成

## 完成文件

- packages/env/daemon/src/decode.rs：完整。核对 encoding_rs 的 Decoder / UTF_8 API（new_decoder_with_bom_removal、new_decoder_without_bom_handling、max_utf8_buffer_length、decode_to_string）与 exec.rs / scan.rs 中的实际调用点；文件头含模块、边界、上下游、能力清单、示例、阅读顺序。验证：`diff -u /tmp/g31-baseline/decode.rs decode.rs` 删除行 0；`git diff --numstat` 为 49 新增 / 0 删除；新增行全部为 `//` 注释或空行。
- packages/env/daemon/src/errors.rs：完整。核对 sys::error_name 的返回类型、fs/exec/pty/process/list/main 中 Failure::new/io/io_between/path/extra/to_json 的调用；补充错误 JSON 形状示例与 describe 文案表说明。验证：删除行 0（基线），git diff 65 新增 / 0 删除。
- packages/env/daemon/src/exec.rs：完整。核对 Control 的 cancel(kill: bool)/attach、Message 枚举、Groups 类型、sys::{resolve_program, read_pipe, kill_tree, after_spawn, configure, shell_config, mkdtemp, random_bytes, exit_code, Pipe}、window::Window 的 used/skipped 语义、output::Output::bulk 的 unsent 计数，以及 Durable 端 env/node.ts 的 spill 阈值行为；文件头与逐行注释覆盖 Spill 启动条件、spawn/spawn_reader/start_waiter、argv、run 状态机。验证：删除行 0（基线），git diff 199 新增 / 0 删除。
- packages/env/daemon/src/frame.rs：完整。核对协议文档中的帧布局、MAX_FRAME/MAX_PAYLOAD 与 main.rs/output.rs 的调用；逐行说明长度头、JSON 长度边界与 payload 划分。验证：删除行 0（基线），git diff 71 新增 / 0 删除。
- packages/env/daemon/src/fs.rs：完整。核对 sys::{open, rename, remove, read_dir, read_at, mtime, identity, error_name} 等实际 callee 与 main.rs 的 dispatch 参数；文件头覆盖 Node 语义差异（递归 mkdir、rm、mkdtemp、open 约束）。验证：删除行 0（基线），git diff 97 新增 / 0 删除。
- packages/env/daemon/src/list.rs：完整。核对 ignore::WalkBuilder 的 hidden/ignore/parents/git_ignore/git_exclude/git_global/require_git/follow_links/current_dir/sort_by_file_name/filter_entry 实际用法，frame::MAX_PAYLOAD 与 main.rs listFiles 调用；测试用例逐一注释。验证：删除行 0（基线），git diff 106 新增 / 0 删除。
- packages/env/daemon/src/main.rs：完整。核对 frame::{read_frame, 常量}、output::{control, bulk, close, run}、各子模块 run/from_json 签名、exec::Control 的 cancel 语义、sys::{on_exit_signal, read_at, open, OpenMode, tmpdir, drive_cwds}；文件头覆盖入口、线程与生命周期、能力清单。验证：删除行 0（基线），git diff 190 新增 / 0 删除；期间曾误改 `})` 为 `});`，已按基线恢复并复查。
- packages/env/daemon/src/output.rs：完整。核对 frame::write_frame、BULK_LIMIT 与 exec/pty/process/main 的调用方式；说明控制队列优先、bulk 字节计数、wait_for_room 与 close/run 的唤醒条件。验证：删除行 0（基线），git diff 63 新增 / 0 删除。
- packages/env/daemon/src/process.rs：完整。核对 exec::{running, spawn, spawn_reader, start_waiter, kill_group, Launch, Control, Groups}、sys::{resolve_program, write_pipe, exit_code} 与 main.rs 的 process/processWrite/processCloseStdin 调用；逐行注释 Input/Processes/事件循环。验证：删除行 0（基线），git diff 80 新增 / 0 删除。
- packages/env/daemon/src/pty.rs：完整。核对 libc 的 openpty/setsid/TIOCSCTTY/TIOCSWINSZ/tcgetpgrp/poll/fcntl 用法、cfg(unix)/cfg(not(unix)) 分支、proc_name 与 /proc/<pid>/comm 差异、exec::{running, kill_group, start_waiter} 与 main.rs 的 pty/ptyWrite/ptyResize/ptyForeground 调用。验证：删除行 0（基线），git diff 160 新增 / 0 删除。
- packages/env/daemon/src/scan.rs：完整。核对 decode::{decode_into, range_decoder, starts_with_bom}、encoding_rs::Decoder 状态与 main.rs scan_lines 的分块读取；逐行注释行边界、BOM、解码字节计数与 EOF 补齐。验证：删除行 0（基线），git diff 90 新增 / 0 删除。

## 未完成或风险

- 全部 11 个文件：未运行 Rust 测试。当前环境没有 cargo/rustc/rustup（`command -v cargo`、`command -v rustc`、`~/.cargo/bin`、Homebrew 路径均无结果），`packages/env/daemon` 的 `cargo test` 无法执行，因此 decode.rs、frame.rs、list.rs、scan.rs 中的单元测试只有静态核对，不能报告为通过。无需安装依赖即可进行的验证为：逐文件全文复读、与 /tmp/g31-baseline 及 git HEAD 的 diff 检查（0 删除行）、新增行均为注释或空行。注释语义来自源码、docs/protocol.md、docs/semantics.md 与 Durable TypeScript 实现的交叉核对。
- 说明：本组文件中的 decode.rs、errors.rs、frame.rs、fs.rs、output.rs、scan.rs 在本次会话开始时工作区已含部分中文注释；这些既有注释被保留，本次在其上补齐详细文件头与缺口，因此 git diff 的新增数小于最终注释总量。diff 验证确认未删除或改写任何原有代码行。
