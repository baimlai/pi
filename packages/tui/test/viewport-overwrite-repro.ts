// 主屏滚动覆盖问题的手工复现程序：按终端高度生成三段定时追加的 ASCII 行，模拟正文、工具等待/输出、随后正文；不运行真实工具或模型。
// 原英文保留问题背景与手工运行方式，不是断言当前版本必然仍有该缺陷。直接运行会启动 ProcessTerminal、输出并等待计时器；本文件没有 node:test 断言。
/**
 * TUI viewport overwrite repro
 *
 * Place this file at: packages/tui/test/viewport-overwrite-repro.ts
 * Run from repo root: node packages/tui/test/viewport-overwrite-repro.ts
 *
 * For reliable repro, run in a small terminal (8-12 rows) or a tmux session:
 *   tmux new-session -d -s tui-bug -x 80 -y 12
 *   tmux send-keys -t tui-bug "node packages/tui/test/viewport-overwrite-repro.ts" Enter
 *   tmux attach -t tui-bug
 *
 * Expected behavior:
 * - PRE-TOOL lines remain visible above tool output.
 * - POST-TOOL lines append after tool output without overwriting earlier content.
 *
 * Actual behavior (bug):
 * - When content exceeds the viewport and new lines arrive after a tool-call pause,
 *   some earlier PRE-TOOL lines near the bottom are overwritten by POST-TOOL lines.
 */

// 真实进程终端适配器，启动后接管当前stdin/stdout，不是内存VirtualTerminal。
import { ProcessTerminal } from "../src/terminal.ts";
// Component/TUI 只提供编译期结构契约，type 导入运行时擦除。
import type { Component, TUI } from "../src/tui.ts";
// 主屏TUI把不断增长的组件行写到真实终端，内容可进入终端滚动历史。
import { TuiMainScreen } from "../src/tui-main-screen.ts";

// 接毫秒数并返回 Promise<void> 的等待函数：executor 立即登记一次 timeout，到时 resolve 让 await 继续；例如 await sleep(300) 请求至少延后到计时器可运行，不阻塞线程，也不保证准点或提供取消。
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// 保存演示行的最小组件；implements 只检查方法形状，不会自动订阅新内容或调用 render。
class Lines implements Component {
	// 每实例持有一个可变字符串数组，初始为空；private 是 TS 访问约束。
	private lines: string[] = [];

	// 整体替换本组件的行引用，接 string[]、返回 void；例如 set(['a']) 后 render 使用它。不复制传入数组、不请求重画，调用方继续修改这个数组也会影响组件。
	set(lines: string[]): void {
		// 直接把参数数组原引用赋给字段，旧数组引用不再由此字段保存。
		this.lines = lines;
	}

	// 把参数各行追加到当前数组，返回 void；例如 append(['b','c']) 在原末尾加两行，不生成文本换行或自动安排渲染。
	append(lines: string[]): void {
		// ... 将输入数组元素展开为 push 参数；push 原地改 this.lines，若 set 时共享了外部数组，也会改同一个容器。
		this.lines.push(...lines);
	}

	// 按给定宽度生成新行数组返回，不写终端；这里只按 UTF-16 length/slice/padEnd 处理，本例 ASCII 合适，不能当完整ANSI/宽字符裁剪器。
	render(width: number): string[] {
		// map 对每条保存文字执行回调，返回新数组，原 lines 的字符串不会被覆盖。
		return this.lines.map((line) => {
			// 原字符串码元数大于 width 就保留前 width 个码元；遇代理对/ANSI时可能截断，但本例固定编号和英文行不含这些结构。
			if (line.length > width) return line.slice(0, width);
			// 否则补普通空格到 width 码元；这不是按真实终端显示格再测宽。
			return line.padEnd(width, " ");
		});
	}

	// 无缓存所以 invalidate 不做事，返回 void；父容器可统一调用，但此方法不会清空已保存的行。
	invalidate(): void {}
}

// 依次追加 count 条带 label 的编号行，每条请求重画并 await 指定间隔，返回完成后的 Promise<void>；会修改 buffer，调用 ui 的渲染调度。
// 例如标签 TOOL OUT、count=3 会追加编号01、02、03三行；最后一行之后也等待一次。任何同步追加/调度错误或 await 拒绝会向 main 传播，没有并行启动所有行或自动取消。
async function streamLines(buffer: Lines, label: string, count: number, delayMs: number, ui: TUI): Promise<void> {
	// 从1循环到包含 count，每次加1；本例传入整数数量，函数本身未运行时验证 count 或 delayMs。
	for (let i = 1; i <= count; i += 1) {
		// 把 i 转十进制字符串并至少补成两位，与标签中间加空格；append 接单元素数组，所以本轮只新增一条逻辑行。
		buffer.append([`${label} ${String(i).padStart(2, "0")}`]);
		// 通知宿主排一帧，不等待它真的把该行画到屏幕。
		ui.requestRender();
		// 等待本轮间隔后再进入下一轮；调度缓慢时实际输出可更晚，不是精确流速保证。
		await sleep(delayMs);
	}
}

// 执行手工复现主流程，无参数，返回 Promise<void>：构建并启动主屏，读取高度，顺序追加三段文本与模拟等待，最后正常 stop。
// 例如高度12时前段20行、工具段24行、后段6行；会写真实终端并创建真实计时器。没有 try/finally，过程中抛错可能跳过该实例的 stop，外层 catch 的新实例收尾也不能完整代替它。
async function main(): Promise<void> {
	// 先 new ProcessTerminal，再注入 TuiMainScreen；TUI 注解只限制接口，实际仍是主屏对象。
	const ui: TUI = new TuiMainScreen(new ProcessTerminal());
	// 创建空的行组件，尚未有演示正文。
	const buffer = new Lines();
	// 把它加入组件树，addChild 自身不请求绘制。
	ui.addChild(buffer);
	// 实际启动输入/退出钩子、终端模式和协议，并排首帧，不等首帧完成就继续下面流程。
	ui.start();

	// 读取适配器报告的行数快照，来自 stdout.rows 或环境/默认回退，不等待终端返回真实尺寸，也不在后续resize时重算数量。
	const height = ui.terminal.rows;
	// 前段数量为高度加8，配合标题行使输出长于这个初始视口；注释表达复现意图，不是每个终端滚动行为一致的保证。
	const preCount = height + 8; // Ensure content exceeds viewport
	// 工具输出数量再多4行，为高度加12，推动更多旧行进入滚动历史。
	const toolCount = height + 12; // Tool output pushes further into scrollback
	// 最后正文固定追加6行，与检测高度无关。
	const postCount = 6;

	// 一次设置初始五条说明行；set 保存此数组引用，没有在组件内再复制。
	buffer.set([
		// 第一条标题标识当前复现程序。
		"TUI viewport overwrite repro",
		// 模板把刚读到的高度插入提示文字，不在此重新读取窗口。
		`Viewport rows detected: ${height}`,
		// 提示人工可调小窗口；这只是显示字符串，不执行resize或tmux命令。
		"(Resize to ~8-12 rows for best repro)",
		// 初始内容中的空白分隔行。
		"",
		// 前正文阶段的固定分隔标题。
		"=== PRE-TOOL STREAM ===",
	]);
	// 请求首段说明文字重画，可能与 start 排的首帧合并。
	ui.requestRender();
	// 等待300ms让界面有机会显示说明，不验证渲染一定已结束。
	await sleep(300);

	// Phase 1: Stream pre-tool text until viewport is exceeded.
	// 串行等待 preCount 条前正文输出，每条间隔请求30ms；不会与后面的工具输出同时流式运行。
	await streamLines(buffer, "PRE-TOOL LINE", preCount, 30, ui);

	// Phase 2: Simulate tool call pause and tool output.
	// 追加四条工具开始/暂停提示，空串也代表占一行；没有启动 shell 工具或API请求。
	buffer.append(["", "--- TOOL CALL START ---", "(pause...)", ""]);
	// 请求显示工具开始提示。
	ui.requestRender();
	// 模拟700ms工具等待，只是计时器，没有外部工作结果。
	await sleep(700);

	// 追加 toolCount 条 TOOL OUT 编号行，每条20ms，全部等待结束才进入后正文。
	await streamLines(buffer, "TOOL OUT", toolCount, 20, ui);

	// Phase 3: Post-tool streaming. This is where overwrite often appears.
	// 在工具输出末尾增加空行和后正文标题。
	buffer.append(["", "=== POST-TOOL STREAM ==="]);
	// 请求显示这一阶段切换。
	ui.requestRender();
	// 再等待300ms，制造原问题描述中的中断后恢复输出时序。
	await sleep(300);
	// 追加6条 POST-TOOL LINE，每条40ms；代码只输出供人工观察，不自动识别覆盖发生与否。
	await streamLines(buffer, "POST-TOOL LINE", postCount, 40, ui);

	// Leave the output visible briefly, then restore terminal state.
	// 最后等待1500ms，给人查看末尾内容的时间，不是截图或自动断言。
	await sleep(1500);
	// 在正常成功路径停止原ui，尝试复原终端模式与输入连接；前面任何异常都会跳过这一行。
	ui.stop();
}

// 模块顶层立即启动 main 并给它返回的 Promise 注册拒绝回调；它只捕获该异步链错误，无法保证捕获另行排帧回调中抛出的所有异常。
main().catch((error) => {
	// Ensure terminal is restored if something goes wrong.
	// 尝试做一次额外终端收尾，下面错误都被吞掉，不让这段补救覆盖原错误报告。
	try {
		// 这里新建的是另一个主屏/适配器，不是 main 内已经启动的原实例；它不知道原实例的 raw快照、协议激活、输入监听或定时器状态。
		const ui: TUI = new TuiMainScreen(new ProcessTerminal());
		// 对新实例调用 stop 会发送其正常收尾并尝试恢复默认raw状态，但不会解绑原实例保存的监听或取消原实例待处理工作，不能把旧英文 Ensure 理解成完整恢复保证。
		ui.stop();
		// 只捕获这次新实例构造/stop 的同步异常。
	} catch {
		// Ignore restore errors.
	}
	// 把原错误用 String 转文字并写stderr，不保证附完整堆栈；stdout上的TUI内容与stderr诊断可能交错。
	process.stderr.write(`${String(error)}\n`);
	// 设置将来自然退出的码为1，不像 process.exit(1) 那样立即终止；原实例的stdin/任务若仍保持事件循环活跃，进程可能继续存活。
	process.exitCode = 1;
});
