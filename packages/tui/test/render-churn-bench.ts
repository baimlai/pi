/**
 * Alt-screen render churn benchmark.
 *
 * Measures cumulative JS allocation and wall time for repeated TuiAltScreen
 * frames on a layout mirroring pi's fullscreen interactive mode:
 * VStack [ ScrollView(transcript), dock VStack [status, editor, footer] ].
 *
 * Two scenarios:
 * - static: nothing changes between frames (pure recomposite churn)
 * - editor: one character appended to the editor per frame (doc scenario
 *   "30 editor updates")
 *
 * Allocation is estimated with the V8 sampling heap profiler including
 * objects collected by minor/major GC, i.e. it measures churn, not retention.
 *
 * Run from packages/tui: node test/render-churn-bench.ts
 */

// 备用屏渲染分配基准：用真实TuiAltScreen、模拟聊天文档和三行编辑区，对比静态300帧与每帧追加一个ASCII字符的300帧。V8采样给出分配量估计，不是堆保留量、内存泄漏结论或带通过阈值的测试。
// 执行模块会在末尾顶层await启动main；NullTerminal只丢弃画面，TUI进程监听/调度和本进程HeapProfiler会实际运行。下文没有真实ProcessTerminal、浏览器或远端模型调用。
// Session通过Promise接口向当前进程V8 inspector发送命令；单纯session.connect不是开启网络调试监听端口。
import { Session } from "node:inspector/promises";
// performance.now提供单调毫秒时钟，用于测连续渲染循环的耗时，不读取用户当地墙上时间。
import { performance } from "node:perf_hooks";
// ScrollView提供文档滚动、跟随与裁剪，真实参与布局成本。
import { ScrollView } from "../src/components/scroll-view.ts";
// Text创建固定状态、页脚和聊天样本，ANSI控制码保存在字符串里参与真实渲染。
import { Text } from "../src/components/text.ts";
// VStack按竖直方向分配高度，搭建正文和停靠区。
import { VStack } from "../src/components/v-stack.ts";
// Terminal接口只用于编译期检查适配器形状，import type在运行时擦除，不加载真实终端实例。
import type { Terminal } from "../src/terminal.ts";
// Component是擦除的组件接口；Container和CURSOR_MARKER是实际运行值，后者用于把伪编辑区光标位置传给渲染器，不直接等于可见字符。
import { type Component, Container, CURSOR_MARKER } from "../src/tui.ts";
// 引入实际备用屏渲染器，基准没有用一个镜像实现代替它。
import { TuiAltScreen } from "../src/tui-alt-screen.ts";

// 模拟终端固定100列，后面getter返回该常量，不监听实际终端宽度。
const COLUMNS = 100;
// 模拟终端固定30行，渲染全部视口而不依赖用户窗口大小。
const ROWS = 30;
// 正式采样前画20帧暖缓存，不主动强制GC，也不保证即时编译器已经完全稳定。
const WARMUP_FRAMES = 20;
// 每个测量场景同步绘制300帧；原英文提到的30次更新只是背景文档名称，这份代码实际按300次循环。
const FRAMES = 300;
// 采样间隔参数为4096字节，表示分配采样的平均间隔，不是每次准确截取4096字节或给内存设置上限。
const SAMPLING_INTERVAL = 4096;

/** Terminal that discards output; keeps xterm parsing out of the measurement. */
// Terminal的无硬件实现，给渲染器固定尺寸并丢弃画面，不做xterm解析；implements只在TS开发期检查方法兼容性。
// 例如write收到控制码也只累计JS字符串length，所以名为bytesWritten的计数实际是UTF-16码元数，不能直接当UTF-8传输字节。
class NullTerminal implements Terminal {
	// 累积写入计数从0开始，覆盖启动、测量和停止调用发给本适配器的字符串；每个场景另记起点算差值。
	bytesWritten = 0;
	// start接收输入与resize回调但不保存或调用；空方法不连接stdin、raw模式或真实信号，下划线表示参数未使用。
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	// 适配器stop无操作；TUI自身stop仍有清监听和模式钩子的公共流程。
	stop(): void {}
	// 空async方法返回已兑现的Promise<void>，不实际等待排空键盘输入。
	async drainInput(): Promise<void> {}
	// write接字符串并返回void，只记长度，不做终端IO或画面验证。
	write(data: string): void {
		// 以data.length累加UTF-16码元，包括控制序列和Unicode内容；例如画线字符不一定与UTF-8编码字节一一对应。
		this.bytesWritten += data.length;
	}
	// columns是getter，读取尺寸时执行，调用者像读普通属性一样使用它。
	get columns(): number {
		// 始终报告100列，不因真实窗口缩放改变。
		return COLUMNS;
	}
	// rows也是只读访问器，不保存独立可变行数字段。
	get rows(): number {
		// 始终报告30行。
		return ROWS;
	}
	// 查询Kitty键盘协议状态的getter，不是图片协议或终端品牌探测。
	get kittyProtocolActive(): boolean {
		// 固定返回false，不发送键盘协商控制码。
		return false;
	}
	// 相对移动光标行数的空实现，参数被忽略，不维护物理光标坐标。
	moveBy(_lines: number): void {}
	// 隐藏光标为空操作，不改用户终端。
	hideCursor(): void {}
	// 显示光标为空操作，也不确认外部光标状态。
	showCursor(): void {}
	// 清当前行不做任何事，不将屏幕建模成另一个缓存。
	clearLine(): void {}
	// 从光标开始清除也为空操作。
	clearFromCursor(): void {}
	// 清屏不向真实stdout写控制码。
	clearScreen(): void {}
	// 接收窗口标题但不应用标题。
	setTitle(_title: string): void {}
	// 接收进度开关但不发送进度协议。
	setProgress(_active: boolean): void {}
	// 程序状态方法也为空实现；TS允许实现忽略接口调用传入的参数，不由这里上报实际程序状态。
	setProgramStatus(): void {}
}

/** Editor stand-in: caches lines per (text, width), re-renders when text changes. */
// 简化编辑组件，只保留文本与按文本/宽度命中的三行渲染缓存；没有真实Editor的输入、选择、撤销或自动补全流程。Component接口在运行时擦除。
// 例如append追加a后，下一次render看到缓存文本不同便重建；同一文本同一宽度再次render可复用原数组，不复制缓存。
class EditorSim implements Component {
	// private text保存当前模拟输入，初始空串；TS的private限制开发期访问，不是JS #私有字段的运行时隔离。
	private text = "";
	// 可选cachedText初始undefined，用于记录上次生成数组时对应的完整文本；字段名后的问号是可选声明标记，不是三元表达式。
	private cachedText?: string;
	// 可选cachedWidth记录上次宽度，宽度变化也必须重建行。
	private cachedWidth?: number;
	// 可选cachedLines保存字符串数组引用；string[]是元素均为字符串的TS数组类型，不在运行时检查每个元素。
	private cachedLines?: string[];

	// 接收一段字符串并追加到内部文本，返回void；例如append('a')令空串变a，没有在这里排帧或限制长度，参数名char也不强制只能一个字符。
	append(char: string): void {
		// +=把新字符串拼到当前文本后再保存；旧缓存仍保留，但下一次render会用文本比较判断是否过期。
		this.text += char;
	}

	// 让所有渲染缓存失效，返回void；保留已经输入的text，下一次render重新分配边框和三行数组，不自行请求绘制。
	invalidate(): void {
		// 将缓存文本键清为undefined，而不是清空用户输入。
		this.cachedText = undefined;
		// 将宽度键清空。
		this.cachedWidth = undefined;
		// 释放实例对旧行数组的引用；其他调用者若保存该数组，仍可持有它，不保证立即GC。
		this.cachedLines = undefined;
	}

	// 按width生成或复用三行字符串数组，返回缓存引用；无真实终端写入。上/下边框相同，中间是提示符、全部文本和不可见光标标记。
	// 例如width10时边框重复8个画线字符；这里不把长输入按width折行或裁剪，实际备用屏后面还会处理过宽普通行，不能当完整Editor排版实现。
	render(width: number): string[] {
		// &&逐项短路：必须已有行数组、文本完全相等且宽度完全相等才命中；字符串相等不是按对象引用比较。
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			// 命中直接返回原cachedLines数组，调用者没有拿到防修改副本。
			return this.cachedLines;
		}
		// 模板字符串生成灰色边框并恢复默认前景色；重复次数至少1，width小于2也不生成空边框。Math.max不是全面的有限数或整数校验。
		const border = `\x1b[90m${"─".repeat(Math.max(1, width - 2))}\x1b[39m`;
		// 三行数组为上边框、中间输入行、下边框；光标标记作为字符串附在输入末尾，后续由TUI提取，不在本方法移动硬件光标。
		const lines = [border, ` > ${this.text}${CURSOR_MARKER}`, border];
		// 把当前文本保存为新缓存键。
		this.cachedText = this.text;
		// 保存这次width作为第二个缓存键。
		this.cachedWidth = width;
		// 保存本次新数组供之后相同参数复用。
		this.cachedLines = lines;
		// 把同一个数组交还渲染器；函数本身没有排定异步帧。
		return lines;
	}
}

// 无输入，创建并返回150个Text组件组成的聊天容器，不启动TUI；每三条有一条样式化user，其他两条为普通assistant文字，不是严格一对一交替聊天。
function buildTranscript(): Container {
	// 创建本次独立Container，每次调用都建立新的孩子数组。
	const container = new Container();
	// 索引从0到149，逐项创建，共150个组件而不一定恰好150个渲染行，因为Text可以按宽度折行。
	for (let i = 0; i < 150; i++) {
		// 声明本轮的样本文字，下面多行三元表达式最终只求值一个分支。
		// %求余判断索引是否为3的倍数，从0开始包含0、3、6等。
		// 该分支用SGR构造粗体青色user标签及黄色styled词，再分别关闭样式；字符串只作为终端渲染数据，不执行其中的文字。
		// 其他索引使用含编号的普通助手文字，没有在这一分支增加颜色控制码。
		const styled =
			i % 3 === 0
				? `\x1b[1m\x1b[36muser ${i}\x1b[39m\x1b[22m message with some \x1b[33mstyled\x1b[39m content padding padding`
				: `assistant ${i} plain response line with enough text to be representative of a transcript row`;
		// 新Text横向padding1、纵向0，再追加到容器；布局时按真实文本渲染器计算换行与缓存。
		container.addChild(new Text(styled, 1, 0));
	}
	// 返回完整容器引用，不返回快照或一组预渲染字符串。
	return container;
}

// 采样树节点的本地最小TS接口，只声明求和所需字段；接口在运行时擦除，并不验证inspector的实际返回内容。
interface SamplingNode {
	// selfSize是本节点自身的分配估值，单位字节，不包含孩子；所以后面的递归需另加孩子，不能把它当已含子树的总额。
	selfSize: number;
	// children是同类节点的数组，形成递归类型；这里只作结构约定，不检测任意对象环。
	children: SamplingNode[];
}

// 输入采样树节点，递归累加自身和所有后代selfSize并返回number；不修改采样树或调用GC。例如根10、两个孩子20/30，返回60。假设正常有穷树，深树仍会使用JS递归调用栈。
function sumProfile(node: SamplingNode): number {
	// 局部total从当前节点自身字节估值开始。
	let total = node.selfSize;
	// 逐个递归孩子并累加；这里不是按孩子个数乘平均大小，也不是只统计未回收对象。
	for (const child of node.children) total += sumProfile(child);
	// 返回该节点整棵子树的和，异常或栈过深不会在此被捕获。
	return total;
}

// 每个场景返回的TS结果对象形状，在运行时并不新增验证器；三个字段来自不同范围的测量。
interface ScenarioResult {
	// allocatedBytes为采样树selfSize之和，是采样分配量估计，不是精确的所有分配字节或RSS。
	allocatedBytes: number;
	// elapsedMs为300帧同步循环的墙钟耗时差，不包括开始/停止采样的await耗时或树求和时间。
	elapsedMs: number;
	// bytesWritten沿用既有名字，实际为NullTerminal累计UTF-16码元的差值；与allocatedBytes的字节含义不同。
	bytesWritten: number;
}

// 测一轮场景：输入已连接的Session、NullTerminal、TUI和同步每帧回调，返回Promise<ScenarioResult>；启动采样后画300帧，停止采样并汇总，不负责创建或断开Session。
// 例如静态回调不改状态，编辑回调每帧加一字符；采样窗口涵盖循环及一些前后框架开销，计时只涵盖循环。任何post拒绝或回调/渲染抛错都会拒绝返回Promise，没有finally确保停止采样或停TUI。
// async把返回结果包装成Promise，类型参数ScenarioResult说明兑现值的字段，异常变拒绝；不是在独立线程运行循环。
async function runScenario(
	// session参数是调用者已连接的V8命令会话，函数不自动连接或检查连接状态。
	session: Session,
	// terminal为本文件计数适配器，用它读取本轮开始与结束的写入计数。
	terminal: NullTerminal,
	// tui为要测量的真实备用屏渲染实例，不复制它的状态。
	tui: TuiAltScreen,
	// frame接0起索引并声明返回void；函数调用时忽略返回值，不会await一个意外返回的Promise，测量针对同步更新。
	frame: (index: number) => void,
): Promise<ScenarioResult> {
	// 在启动采样之前记录累计写入起点，因此之后按差值排除此前暖机与启动写入。
	const writtenBefore = terminal.bytesWritten;
	// 等待V8启动HeapProfiler采样后才进入计时，实际发送命令；API声明允许发协议参数，不保证运行时V8支持任意参数。
	await session.post("HeapProfiler.startSampling", {
		// 请求平均4096字节一个采样间隔；采样是估计，不能把间隔当作每个对象都完整记账。
		samplingInterval: SAMPLING_INTERVAL,
		// 请求把Major GC已回收对象的采样也纳入，意图测分配周转而非只保留存活对象；具体支持取决于执行本基准的V8协议实现。
		includeObjectsCollectedByMajorGC: true,
		// 同样请求包含Minor GC已回收对象；本机安装的Node声明只列samplingInterval，通用post重载可接受对象，不等于TS已证明这两个扩展字段会生效。
		includeObjectsCollectedByMinorGC: true,
	});
	// 采样命令兑现后再取循环开始时刻；与采样本身的起点并非完全相同。
	const start = performance.now();
	// 连续同步执行300次，循环本身不await计时器或模拟60Hz刷新。
	for (let i = 0; i < FRAMES; i++) {
		// 先运行本帧状态更新回调，回调耗时也计入elapsedMs。
		frame(i);
		// 再同步渲染本帧，NullTerminal记输出码元并丢弃画面；没有真实终端传输与显示开销。
		tui.renderNow();
	}
	// 循环一结束就计算elapsedMs，后面的停止采样、await调度和树遍历都不计进这个时间差。
	const elapsedMs = performance.now() - start;
	// 向V8请求停止采样并等返回profile，解构取这一字段；采样时间范围与前面的循环计时范围不完全重合。
	const { profile } = await session.post("HeapProfiler.stopSampling");
	// 构造本轮新的结果对象，字段值分别在下面求值，不把采样树本体留在结果里。
	return {
		// TS的as断言把profile.head按本地最小接口使用，运行时不转换或验证；sumProfile递归求采样估值，开销发生在计时结束之后。
		allocatedBytes: sumProfile(profile.head as SamplingNode),
		// 属性简写等价于字段elapsedMs取同名局部变量，不是新测一次时间。
		elapsedMs,
		// 当前累计计数减启动采样前起点，得到这段范围写入的UTF-16码元量；包括停止采样等待期间若发生的写入，范围不只由计时循环界定。
		bytesWritten: terminal.bytesWritten - writtenBefore,
	};
}

// 输入场景名称和结果，打印总估算分配、每帧估算分配、平均耗时及写入计数，返回void；没有阈值断言。例如KiB按1024换算，这些数字只代表这次样本。
function report(name: string, result: ScenarioResult): void {
	// 采样分配估值先除300帧再除1024，得平均KiB/帧，不是每帧逐个测出的分位数。
	const perFrameKiB = result.allocatedBytes / FRAMES / 1024;
	// 除1024两次换算为MiB；MiB与十进制MB不同。
	const totalMiB = result.allocatedBytes / 1024 / 1024;
	// 循环总毫秒除300，得平均每帧毫秒。
	const msPerFrame = result.elapsedMs / FRAMES;
	// console.log输出后面拼成的一行；此处发生在两轮实际测量之后，不在该场景elapsedMs中。
	console.log(
		// 场景名向右补到至少8个码元，总MiB保留1位小数后左侧补宽；padEnd和padStart不会截短超宽内容。
		`${name.padEnd(8)} allocated ${totalMiB.toFixed(1).padStart(7)} MiB total  ` +
			// 拼接每帧KiB并保留1位小数，字符串加号只是合并日志，不改变采样结果。
			`${perFrameKiB.toFixed(1).padStart(8)} KiB/frame  ` +
			// 平均毫秒保留3位并补宽，方便逐行比较。
			`${msPerFrame.toFixed(3).padStart(7)} ms/frame  ` +
			// 写入计数按每帧平均、四舍五入到0位小数；原日志仍叫written bytes，但实现实际统计码元，没有在这里重新按UTF-8编码。
			`${(result.bytesWritten / FRAMES).toFixed(0).padStart(6)} written bytes/frame`,
	);
}

// 无输入的async入口：建固定终端、文档、模拟编辑器和布局，暖机后连接本进程inspector，依次测静态与编辑场景，再断开、停TUI、打印结果，返回Promise<void>。
// 两场景复用同一TUI和缓存，不是每轮重建。没有try/finally或catch，任何异常都可跳过后面的disconnect/stop，顶层await让拒绝继续成为模块执行失败。
async function main(): Promise<void> {
	// 创建只计数、无真实画面输出的NullTerminal。
	const terminal = new NullTerminal();
	// 创建TuiAltScreen并保存false硬件光标策略及日志路径；此时只构造状态，没有真正进入备用屏，控制码之后由NullTerminal丢弃。
	const tui = new TuiAltScreen(terminal, false, "/tmp/pi-tui-bench");

	// 建立150个Text的真实文档树，其构造不计入后面的测量。
	const transcript = buildTranscript();
	// 创建简化EditorSim，初始空文本和空缓存。
	const editor = new EditorSim();
	// ScrollView包装聊天文档，下面四项分别控制跟随、主滚动区、余量路由和滚动条。
	const scrollView = new ScrollView(transcript, {
		// follow:end允许保持在输出末端，初次布局按实际内容高度确定偏移。
		follow: "end",
		// primary:true把它标为主要滚动区供根布局与视口交互识别。
		primary: true,
		// overscroll:chain表示滚动到边界后的剩余量可以在路由中继续交给外层；不是创建操作系统滚动或屏蔽其他独立滚动机制。
		overscroll: "chain",
		// scrollbar:auto在需要且相应交互状态满足时显示滚动条，布局和定时隐藏等行为仍按真实ScrollView实现。
		scrollbar: "auto",
	});
	// 状态Text用SGR弱化字样，横向padding1、纵向0；固定idle只是样本，不反映真实Agent忙闲。
	const status = new Text("\x1b[2mstatus: idle\x1b[22m", 1, 0);
	// 页脚Text也是固定样本，路径、分支和token文字不读取实际仓库或模型统计。
	const footer = new Text("\x1b[2m~/workspaces/pi  main  100k tokens\x1b[22m", 1, 0);
	// 底部VStack顺序排列状态、编辑框和页脚，每项下面分别配置收缩与最小高度。
	const dock = new VStack([
		// 状态允许收缩，最小高度0，因此空间紧张时可以不分配可见行。
		{ component: status, shrink: 1, minSize: 0 },
		// 模拟编辑器允许收缩并请求至少3行，与render固定三行相呼应；极小父空间仍受实际布局分配约束。
		{ component: editor, shrink: 1, minSize: 3 },
		// 页脚允许收缩并请求至少1行，不是绝对保证所有终端尺寸都能同时显示全部底部内容。
		{ component: footer, shrink: 1, minSize: 1 },
	]);
	// 根VStack将可伸缩聊天区置上、按内容高度的停靠区置下。
	const root = new VStack([
		// 聊天区basis0、grow1争取剩余空间、shrink1允许缩小、minSize1请求一行；用有限视口容纳可滚动文档，而不是按全部文档高度撑高整个终端。
		{ component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		// 停靠区以自然高度为基础、grow0不主动拿额外高度、shrink1允许压缩、minSize1请求最小空间。
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	// 设置显式布局根并请求后续帧，代替渲染器的默认隐式文档布局。
	tui.setLayoutRoot(root);
	// 真正启动TUI公共路径并注册自己的退出兜底，NullTerminal不会连接stdin但公共能力探测/调度仍存在；不是单纯new实例。
	tui.start();

	// 在开始采样前同步renderNow20次，暖组件与布局缓存；单次仍可能构造临时数组，但这部分分配不属于之后的场景采样。
	for (let i = 0; i < WARMUP_FRAMES; i++) tui.renderNow();

	// 建立当前进程的inspector会话对象，构造本身还不能发采样命令。
	const session = new Session();
	// 连接当前V8 inspector后端，不等于对外开放HTTP或WebSocket端口；失败直接拒绝main，没有自动回退测量方式。
	session.connect();

	// 先等待静态场景完成，空回调不改业务文本；真实TUI仍会合成画面、比较和生成控制码，不能推断为零分配。
	const staticResult = await runScenario(session, terminal, tui, () => {});
	// 再等待编辑场景，复用上一轮后的实例与缓存，回调每帧先追加文字。
	const editorResult = await runScenario(session, terminal, tui, (i) => {
		// 把索引对26取余加97转ASCII小写字母，依次a到z循环；300帧总共追加300个字符，无真实键盘输入或用户剪贴板。
		editor.append(String.fromCharCode(97 + (i % 26)));
	});

	// 正常路径断开Session，失去该会话状态；不在finally中，前面异常可跳过这里。
	session.disconnect();
	// 正常路径停止TUI并走停止钩子，默认还会重新渲染全文并重放给NullTerminal，这些写入已在场景计数取值之后；与Session断开是两步，不能宣称任何失败都会原子清理全部资源。
	tui.stop();

	// 停止后打印帧数、固定视口和文档在100列的渲染行数；这次额外transcript.render在场景采样与计时之外。
	console.log(`frames=${FRAMES} viewport=${COLUMNS}x${ROWS} transcript=${transcript.render(COLUMNS).length} lines`);
	// 格式化并打印静态结果，报告函数不重新运行场景。
	report("static", staticResult);
	// 再打印编辑结果，供人工比较，未自动判断哪个场景合格。
	report("editor", editorResult);
}

// 顶层await实际调用并等待main，不是只导出函数供别人决定何时运行；异常可使模块执行失败，本文件没有捕获后继续或统一finally清理。
await main();
