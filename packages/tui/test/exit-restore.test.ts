// 进程退出复位回归测试：在两次独立 Node 子进程里运行真实 ProcessTerminal/备用屏启动，捕获控制码，比较未stop直接退出与正常stop后的发送次数和顺序。
// 子进程stdin/stdout/stderr都接管道，控制码不会写到用户终端；它并非 VirtualTerminal 测试，也不证明物理终端已复原。POSIX启动仍会给子进程自身发SIGWINCH；Windows启动还可能调用原生VT输入入口，所以它并不是完全没有系统副作用的纯字符串测试。
// assert 断言失败会抛错并使当前用例失败；原用法 assert.equal 是宽松相等，这些实际比较值都是数值，因此没有混合字符串/数字转换。
import assert from "node:assert";
// spawnSync 启动并等待子进程结束，阻塞当前测试线程，不启动shell；具体执行程序与参数在 runFixture 中固定。
import { spawnSync } from "node:child_process";
// describe/it 注册测试组与用例，不是模块导入时已经完成两次子进程执行。
import { describe, it } from "node:test";
// 把基于import.meta.url解析的file URL转换为当前平台文件系统路径，处理URL百分号转义等，不手工截去file前缀。
import { fileURLToPath } from "node:url";

// 相对当前测试文件定位固定fixture，再转本机路径；不依赖启动测试的cwd来定位子脚本，也没有在这里读取或执行它。
const fixture = fileURLToPath(new URL("./fixtures/exit-without-stop.ts", import.meta.url));

// 运行指定退出路径并返回捕获stdout字符串；mode静态只允许 exit/stop，例如 runFixture('exit') 启动后不调用stop就退出。
// 会同步启动当前Node二进制，继承大部分环境、隔离三路标准流并设超时，然后断言状态0；断言失败时用子进程stderr作说明。联合字面量类型不会在运行时拦截不合法参数，fixture实际只有等于stop才走stop。
function runFixture(mode: "exit" | "stop"): string {
	// process.execPath 指当前Node可执行文件；参数数组依次传固定fixture路径与mode，未启用shell，不把控制码或模式当shell命令解释。
	const result = spawnSync(process.execPath, [fixture, mode], {
		// encoding:utf8 让spawnSync的stdout/stderr返回字符串，本机Node类型据此选择字符串返回重载；它不保证所有字节本来都是有效UTF-8。
		encoding: "utf8",
		// 浅复制当前环境给孩子，再用undefined省掉TMUX/STY/ZELLIJ并固定TERM；不会删除父进程环境，其他环境仍继承，所以日志/图片覆盖应由测试运行命令明确关闭。
		env: { ...process.env, TMUX: undefined, STY: undefined, ZELLIJ: undefined, TERM: "xterm-256color" },
		// 三项分别让子进程stdin、stdout、stderr使用pipe，不继承用户TTY；没有配置input喂入键盘字符串。stdout控制码只进入捕获结果，不会真的切换父终端备用屏。
		stdio: ["pipe", "pipe", "pipe"],
		// 10_000 的下划线只提高数值可读性，实际是10000ms；超时会发送默认终止信号，spawnSync仍等孩子实际退出，不是绝对10秒硬截止。
		timeout: 10_000,
	});
	// 只要求result.status为0；被信号终止或启动失败常得到null而失败。没有另读result.error/signal，错误说明取stderr，不等于每种启动错误都能显示完整诊断。
	assert.equal(result.status, 0, result.stderr);
	// 成功后返回捕获stdout，下面只做字符串检查，不重新向终端播放这些控制码。
	return result.stdout;
}

// 统计一个字面子串的不重叠出现次数，接原串与非空目标串、返回number，无副作用；例如 'aba'.split('a') 有3段，所以a出现2次。本测试所有needle非空，不是通用重叠匹配计数器。
function count(haystack: string, needle: string): number {
	// split把每个匹配处分成多一段，段数减1得到次数；不按正则解释needle里的方括号等符号。
	return haystack.split(needle).length - 1;
}

// Regression for #11170: exit paths that skip stop() left mouse tracking, focus reporting,
// the Kitty keyboard protocol, bracketed paste, and the alternate screen enabled.
// #11170 回归组对比未stop退出和正常stop退出，只验证捕获字节中的复位请求，不模拟终端实际接受状态，也不覆盖SIGKILL/原生abort这种不执行JS退出钩子的情况。
describe("terminal restore on process exit", () => {
	// 第一个用例运行exit模式，要求列出的复位请求各一次、Kitty弹栈先于离备用屏，并检查最终显示光标后缀。
	it("restores terminal modes when the process exits without stop()", () => {
		// 同步运行fixture；它在start后立即process.exit，靠已注册exit钩子执行尽力同步复位，未等待首帧或键盘协商回复。
		const output = runFixture("exit");
		// 逐项检查六个字面序列：关闭SGR鼠标坐标1006、焦点通知1004、全部移动1003、按钮鼠标1000、Kitty弹栈、括号粘贴2004；这些字符串在测试里不直接发送给用户终端。
		for (const sequence of ["\x1b[?1006l", "\x1b[?1004l", "\x1b[?1003l", "\x1b[?1000l", "\x1b[<u", "\x1b[?2004l"]) {
			// 各序列必须恰出现一次；JSON.stringify(sequence) 作为失败说明将ESC转义可读，不是输出控制码本身。
			assert.equal(count(output, sequence), 1, JSON.stringify(sequence));
		}
		// 比较首次出现的位置，要求Kitty弹栈先于退出备用屏，因为键盘标志与当前屏相关。前面的次数检查已确保弹栈存在，下面endsWith确保离屏串存在，避免把-1位置当有效成功证据。
		assert.ok(output.indexOf("\x1b[<u") < output.indexOf("\x1b[?1049l"), "Kitty pop must precede leaving alt screen");
		// 捕获stdout必须精确以退出备用屏1049l加显示光标25h结尾；未直接验证鼠标等每一种物理状态或同步write返回字节数。
		assert.ok(output.endsWith("\x1b[?1049l\x1b[?25h"));
	});

	// 第二个用例先正常stop再process.exit，检查部分复位请求没有被退出兜底重复发送。
	it("does not restore twice after a normal stop()", () => {
		// 同步运行stop模式，fixture传preserveScreen:true，正常停止会离开备用屏但不重放正文。
		const output = runFixture("stop");
		// 检查另一组五条复位序列恰一次，包括退出备用屏；本组没有单独检查1003/1000、最终后缀或全部控制码顺序。
		for (const sequence of ["\x1b[?1006l", "\x1b[?1004l", "\x1b[<u", "\x1b[?2004l", "\x1b[?1049l"]) {
			// 按捕获字符串计数断言一次，观察stop移除本实例exit钩子/置stopped后的去重效果，不把它推广成任意多次stop都幂等。
			assert.equal(count(output, sequence), 1, JSON.stringify(sequence));
		}
	});
});
