// 备用屏集成测试：用内存xterm检查滚动、底部区域、搜索、键鼠路由、图片控制串、选择复制与退出顺序，不创建真实ProcessTerminal。70个用例组合真实组件和渲染器，断言范围各自有限，不代表真实终端硬件兼容性。
// 测试仍会改进程内环境、平台描述符、能力缓存和键位，以及注册exit/排帧与提示计时器。能力冷探测在tmux环境可能启动只读查询；离线执行时用PI_HYPERLINKS=0短路该查询。OSC52仅交内存终端，链接/注入复制只记数组。
// Node断言失败会抛错，使当前it失败；不为失败用例自动调用末尾stop，是否有finally要逐例看。
import assert from "node:assert";
// describe注册测试组，it注册单条测试；async回调返回的Promise由Node测试运行器等待，注册本身不等于立即完成测试。
import { describe, it } from "node:test";
// 从同一模块按名称导入搜索组件、缓存索引与匹配算法，分别用于纯字符串断言和真实搜索交互。
import {
	// 搜索栏组件负责输入框、状态和可点击导航按钮，不是浏览器搜索框。
	AltScreenSearchComponent,
	// 索引对象缓存最近查询与已渲染正文的匹配结果，可用引用断言检查复用。
	AltScreenSearchIndex,
	// 纯匹配函数把归一化查询映回终端显示列片段，包含跨行匹配，不把UTF-16下标直接当列。
	findAltScreenSearchMatches,
} from "../src/alt-screen-search.ts";
// Box为图片/文字提供padding与背景，帮助测试裁剪不丢有样式的包装。
import { Box } from "../src/components/box.ts";
// 真实Editor仅在后面的菜单键位测试使用，自动补全提供器是内存替身，不发网络请求。
import { Editor } from "../src/components/editor.ts";
// HStack把两个区域横向布局，检验鼠标命中应按列而非按普通Container纵向回退。
import { HStack } from "../src/components/h-stack.ts";
// Image接内嵌测试数据及显式像素尺寸，生成协议字符串；这些断言不是解码图片正确性的测试。
import { Image } from "../src/components/image.ts";
// MouseRegion用回调处理组件的鼠标事件，处理结果决定是否继续交正文滚动/选择。
import { MouseRegion } from "../src/components/mouse-region.ts";
// ScrollView保存逻辑滚动、跟随和滚动条状态，真正参与布局裁剪。
import { ScrollView } from "../src/components/scroll-view.ts";
// SelectList用于检查列表焦点应优先接分页键，避免错误滚动后面的聊天文档。
import { SelectList } from "../src/components/select-list.ts";
// Text提供测试正文，调用setText只改组件并清缓存，通常还要请求一帧。
import { Text } from "../src/components/text.ts";
// VStack将滚动文档和固定底部区域按高度分配，模拟全屏聊天结构。
import { VStack } from "../src/components/v-stack.ts";
// 键位函数读取/替换进程内共享管理器；KeybindingsManager按TUI动作表建立自定义绑定，测试必须在适当finally恢复原引用。
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
// 以下图像与链接助手主要生成控制串或操作共享元数据；getCapabilities的环境探测是另一条路径，不能因这里传假图就认为整个TUI.start必为纯函数。
import {
	// encodeKitty生成Kitty图像传输字符串，调用本身不写真实终端。
	encodeKitty,
	// hyperlink生成OSC8文字链接，是否点击打开由注入openUrl回调决定。
	hyperlink,
	// 登记图片ID、终端格与像素尺寸，供滚动裁剪和缓存估算，不向终端询问图片是否已上传。
	registerKittyImageMetadata,
	// 清共享能力缓存，让下次访问重新探测；不清Kitty元数据或格尺寸，也不是恢复旧缓存对象。
	resetCapabilitiesCache,
	// 测试直接指定共享能力缓存，以进入iTerm2或Kitty分支；只是模拟能力，不代表本机真支持协议。
	setCapabilities,
} from "../src/terminal-image.ts";
// renderFakeCursor生成内部伪光标标记与样式；type TuiMouseEvent只提供编译期事件形状，不在运行时检查输入。
import { renderFakeCursor, type TuiMouseEvent } from "../src/tui.ts";
// 被测真实TuiAltScreen，输出落到下面的虚拟适配器；不使用镜像实现替代渲染算法。
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
// 剥控制串用于检查纯文字，visibleWidth按显示列测宽；二者都不同于普通string.length。
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";
// 共享编辑器主题把颜色显式包成ANSI字符串，不靠当前宿主终端颜色探测结果。
import { defaultEditorTheme } from "./test-themes.ts";
// VirtualTerminal用headless xterm解析输出、保存输入回调，读屏前需要等待渲染与写队列；它不接真实stdin或系统剪贴板。
import { VirtualTerminal } from "./virtual-terminal.ts";

// OSC133的A标记作为语义提示区起点，ESC右方括号启动OSC、BEL结束；这段常量随后放在正文行首以测试提示区跳转。
const OSC133_ZONE_START = "\x1b]133;A\x07";

// 最小焦点浮层替身：保存收到的原始输入，并渲染固定一行；没有鼠标处理器或capturesViewportInput声明，用来观察默认焦点路由。
class InputOverlay {
	// 公开focused字段初始false，由TUI焦点逻辑修改，不表示这个类自己检测终端焦点。
	focused = false;
	// string[]保存原始输入块，类型注解在运行时擦除；每个实例有自己的新数组。
	inputs: string[] = [];

	// 接一段输入并记录、返回void，不解释按键或发请求。例如收到PageDown控制串就按原样存一项，供后面数组断言。
	handleInput(data: string): void {
		// push修改本实例数组，返回的新长度被忽略；它不复制输入字符串或合并多次调用。
		this.inputs.push(data);
	}

	// 无参数渲染固定一行字符串数组，无IO；例如作为浮层出现时显示overlay，不依据终端宽度自行裁剪。
	render(): string[] {
		// 每次创建一个含overlay文字的新数组，布局/裁剪交给上层。
		return ["overlay"];
	}

	// invalidate为空实现，满足组件接口但没有渲染缓存可清，也不会自动安排一帧。
	invalidate(): void {}
}

// 记录型虚拟终端在继承的xterm能力上额外保存start/write/stop调用顺序；extends复用父类，不改变输出到内存的边界。
class RecordingTerminal extends VirtualTerminal {
	// readonly禁止把events字段重赋新数组，不冻结数组本身。Array泛型内的判别联合用type区分三种事件，只有write分支可读data。
	readonly events: Array<{ type: "write"; data: string } | { type: "start" } | { type: "stop" }> = [];

	// 覆盖start：接输入与resize回调，先记开始事件再委托父类，返回void；override让TS核对父类确有该方法，不保证运行时幂等。父类异常可向外抛，已记事件不会撤销。
	override start(onInput: (data: string) => void, onResize: () => void): void {
		// 将start事件追加到记录数组，不在这一步调用回调。
		this.events.push({ type: "start" });
		// super调用VirtualTerminal.start保存回调、向内存xterm排括号粘贴启用码；那条父类直接xterm.write不经过本类write记录。
		super.start(onInput, onResize);
	}

	// 覆盖write：输入整段终端字符串，先保存记录再交内存xterm，不写宿主stdout；写队列后续解析，返回不保证屏幕快照已更新。
	override write(data: string): void {
		// data属性简写保留本次字符串，type标记为write；记录的是调用边界，不是每个字符一个事件。
		this.events.push({ type: "write", data });
		// 父类write把同一字符串排进xterm；因此既能检查控制码原串，也能等解析后检查画面。
		super.write(data);
	}

	// 覆盖stop：无参数，先记录再让父类清回调并排括号粘贴关闭；不销毁xterm或统一撤销TUI的所有计时器。
	override stop(): void {
		// 保存stop时间顺序，之后可判断鼠标复位在适配器stop前、离备用屏在后。
		this.events.push({ type: "stop" });
		// 委托父类停止输入/resize回调，屏幕缓冲仍可在测试里读取。
		super.stop();
	}
}

// 注册备用屏整组测试，下面每个it有独立局部对象；模块能力缓存、键位与process.env仍共享，不能把局部const当完整隔离。
describe("TuiAltScreen", () => {
	// 测试初始跟末尾、手动上滚后取消跟随，再追加内容仍保留位置；20列4行里从7–10上滚到6–9，增长到12行也不跳底。async等待的是辅助渲染屏障，不是真实显示器。
	it("renders a terminal-height viewport and preserves manual scroll position", async () => {
		// 建立20列4行的内存终端，不读取宿主窗口尺寸。
		const terminal = new VirtualTerminal(20, 4);
		// 构造实际TUI但尚未start；默认隐式ScrollView跟文档末尾。
		const tui = new TuiAltScreen(terminal);
		// Array.from生成10条编号正文，用LF连接，Text两种padding均0；(_,index)的首参数故意未使用。
		const text = new Text(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		// 把Text挂到默认文档容器，当前还没有绘制。
		tui.addChild(text);
		// 启动TUI的进程监听、模式钩子与排帧；控制串只进虚拟终端，公共能力冷探测仍可能查tmux。
		tui.start();
		// 先给nextTick/约20ms节流帧机会，再flush之前xterm写队列；不保证任意后续动画永远稳定。
		await terminal.waitForRender();

		// 深严格比较实际视口数组与下面四行预期，元素顺序和内容必须一致。
		// 读取4行纯文字后逐行trimEnd，忽略本次断言不关心的末尾JS空白；map返回新数组。
		// 预期只显示10行文档末尾四行7、8、9、10，而非把全部文档撑成10行屏幕。
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 7", "line 8", "line 9", "line 10"],
		);
		// 严格检查动态跟随标记为true，不只是检查构造选项写了follow:end。
		assert.strictEqual(tui.isFollowingOutput, true);

		// SGR鼠标码64表示向上滚轮，坐标1列1行从1起；sendInput同步直接调用保存的输入回调，不来自真实鼠标。
		terminal.sendInput("\x1b[<64;1;1M");
		// 等待滚动后排定的帧进入内存屏幕再读视口。
		await terminal.waitForRender();
		// 检查上滚后的四行，与初始画面相比向前一行。
		// 再读取并去每行末尾空白，确保比较的是最新快照。
		// 预期6到9行，说明只滚动一行而没有回到文档顶部。
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 6", "line 7", "line 8", "line 9"],
		);
		// viewportTop是0起文档偏移5，对应显示文字line6，不是屏幕物理第5行。
		assert.strictEqual(tui.viewportTop, 5);
		// 手动上滚后检查取消跟随输出。
		assert.strictEqual(tui.isFollowingOutput, false);

		// 把正文改为12行；setText改数据并清缓存，不在这里同步画出新内容。
		text.setText(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"));
		// 显式请求后续渲染，让增长后的文档重新布局。
		tui.requestRender();
		// 等待帧和当前写队列处理。
		await terminal.waitForRender();
		// 验证文档增长后保留手动视口，而不显示9–12。
		// 取得更新后的纯文字视口，去末尾空白供比较。
		// 仍应是6到9，展示新输出不抢走用户正在阅读的位置。
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 6", "line 7", "line 8", "line 9"],
		);

		// 正常路径停止TUI；本例无finally，前面断言失败会跳过此行，不应宣称测试始终清理。默认停止还会重渲完整文档给内存终端。
		tui.stop();
	});

	// 测试回到底部提示只在停止跟随后出现，点击标签旁不跳、点击标签才回底；聊天区4行、底部2行，提示覆盖聊天区末行但不覆盖底部编辑文字。
	it("shows a clickable jump-to-end indicator on the transcript's last row while scrolled up", async () => {
		// 模拟30列6行，使聊天和底部区域的行坐标容易分别断言。
		const terminal = new VirtualTerminal(30, 6);
		// 第二、第三个参数显式undefined保留默认光标/日志配置，再给选项对象；此时保存回调，不立即运行。
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			// 提示生成回调返回反色的Jump to end标签，SGR27只关闭反色；不是现在写到真实终端。
			scrollToEndIndicator: () => "\x1b[7m ↓ Jump to end \x1b[27m",
		});
		// 创建主聊天ScrollView，内容和跟随配置分别由下两项提供。
		const transcript = new ScrollView(
			// 8行编号Text无内边距，整个内容高于分得的4行聊天视口。
			new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			// follow:end启末尾跟随，primary标主要滚动区，方便全局回到底部动作找目标。
			{ follow: "end", primary: true },
		);
		// 设置显式根布局，覆盖默认隐式文档布局；会请求帧但不在这行直接等待画完。
		tui.setLayoutRoot(
			// 竖直栈先聊天再底部，将6行空间分给两项。
			new VStack([
				// 聊天basis0、grow1获得底部以外余量，minSize1请求至少一行；本次正常6行视口足够分配。
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				// 底部自然高2行，内容是固定editor/footer文字，不是真正Editor或Footer类。
				{ component: new Text("editor\nfooter", 0, 0), basis: "auto", minSize: 1 },
			]),
		);
		// 启动布局与输入处理，所有输出交虚拟适配器。
		tui.start();
		// 等首帧后才能判断是否已有跳底提示。
		await terminal.waitForRender();
		// some查任一视口行包含标签，前面的!要求完全没有；初始正跟末尾时不应显示。
		assert.ok(!terminal.getViewport().some((line) => line.includes("Jump to end")));

		// 在聊天左上角送向上滚轮，脱离跟末尾状态。
		terminal.sendInput("\x1b[<64;1;1M");
		// 等待上滚与提示合成完成。
		await terminal.waitForRender();
		// 确认已取消末尾跟随，提示出现的前置状态真实成立。
		assert.strictEqual(transcript.isFollowingEnd, false);
		// 索引3是屏幕第4行，应同时含原line7、居中提示和显式末尾空格；此处不trim，检查精确排版。
		assert.strictEqual(terminal.getViewport()[3], "line 7  ↓ Jump to end         ");
		// 索引4的下一行仍是editor，可选链防缺行时抛访问异常，使缺失以断言失败呈现。
		assert.strictEqual(terminal.getViewport()[4]?.trimEnd(), "editor");

		// Pressing next to the label starts a selection instead of jumping.
		// 左键在第2列第4行按下，位于提示文字命中区之外。
		terminal.sendInput("\x1b[<0;2;4M");
		// 同处小写m释放，不产生拖动范围；不是再次执行按下动作。
		terminal.sendInput("\x1b[<0;2;4m");
		// 等点击路由和可能的重画完成。
		await terminal.waitForRender();
		// 点击标签旁后仍不跟末尾，证明不能把整条末行都当跳底按钮。
		assert.strictEqual(transcript.isFollowingEnd, false);

		// 第15列第4行落在提示标签内，模拟左键按下。
		terminal.sendInput("\x1b[<0;15;4M");
		// 在同一点释放，形成无拖动点击。
		terminal.sendInput("\x1b[<0;15;4m");
		// 等待跳底后的画面。
		await terminal.waitForRender();
		// 检查点击标签后重新启用动态末尾跟随。
		assert.strictEqual(transcript.isFollowingEnd, true);
		// 再比较整屏，排除仅改标志却没有真正滚动的情况。
		// 逐行裁末尾空白后比较六行文字。
		// 聊天回到5–8，底部editor/footer两行仍在原位。
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "editor", "footer"],
		);
		// 正常结束停止TUI，前面失败不由本例finally保护。
		tui.stop();
	});

	// 回归#9136：auto滚动条显隐不能使跳底标签横向漂移。记录显示、隐藏、再次出现三种状态的起列，预期全部为0起24。finally覆盖启动之后的测试体，不覆盖此前start自身失败。
	it("keeps the jump-to-end indicator centered as the auto scrollbar hides and reappears", async () => {
		// Regression test for #9136: auto scrollbar visibility must not move the indicator.
		// 建立80列6行内存终端，标签较长但仍可完整放入聊天行。
		const terminal = new VirtualTerminal(80, 6);
		// 保存固定标签原串，indexOf使用同一字符串查画面起点，返回UTF-16下标；本标签在这些位置前全是单列BMP文字，因此本例与显示列数相符。
		const label = " ↓ Jump to latest message · End ";
		// 构造TUI并注入提示文字生成器。
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			// 回调捕获label，调用时原样返回同一文字，不在构造时输出。
			scrollToEndIndicator: () => label,
		});
		// 主ScrollView本次直接占全部6行，没有额外底部dock。
		const transcript = new ScrollView(
			// 正文20行，为滚动条提供真实溢出。
			new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			// 设置跟末尾、主区和auto条，隐藏等待为0仍经计时器调度，不意味着同步立即隐藏。
			{ follow: "end", primary: true, scrollbar: "auto", scrollbarHideDelayMs: 0 },
		);
		// 把主滚动区直接设为布局根。
		tui.setLayoutRoot(transcript);
		// 启动TUI，此行在try之前，若这里失败后面finally尚未进入。
		tui.start();
		// 从此进入try/finally，后续断言或等待失败也会尝试stop；stop若自身抛错仍可能盖过原异常。
		try {
			// 等待初始布局，确保滚动边界和轨道几何已建立。
			await terminal.waitForRender();

			// Scrolling over the track keeps the scrollbar visible until the pointer leaves.
			// 在第80列轨道送向上滚轮，滚动且让条保持活跃显示。
			terminal.sendInput("\x1b[<64;80;1M");
			// 等待标签和滚动条状态更新。
			await terminal.waitForRender();
			// 断言auto条此时可见，确认第一个取样确实属于显示态。
			assert.strictEqual(transcript.isScrollbarVisible, true);
			// 断言已经脱离末尾，保证跳底提示有出现条件。
			assert.strictEqual(transcript.isFollowingEnd, false);
			// 记录手动上滚后的文档偏移，后续悬停不应偷偷改变它。
			const scrollTop = transcript.scrollTop;
			// 从屏幕最后一行找提示起点；indexOf若没找到为-1，最终24断言也会失败。
			const visibleColumn = terminal.getViewport()[5].indexOf(label);

			// Leaving the track lets the auto-hide timer expire without changing the content.
			// 35是无按钮移动，送到第79列即离开最右轨道，不是真实系统鼠标移动。
			terminal.sendInput("\x1b[<35;79;1M");
			// 给0ms隐藏timer与后续渲染机会，再flush读屏。
			await terminal.waitForRender();
			// 检查离开轨道后auto条隐藏。
			assert.strictEqual(transcript.isScrollbarVisible, false);
			// 隐藏只改外观，不得改变刚保存的聊天偏移。
			assert.strictEqual(transcript.scrollTop, scrollTop);
			// 记录隐藏态标签在最后一行的起点。
			const hiddenColumn = terminal.getViewport()[5].indexOf(label);

			// 无按钮移动回第80列，进入隐藏轨道区域，触发再次显示。
			terminal.sendInput("\x1b[<35;80;1M");
			// 等待重显后的帧。
			await terminal.waitForRender();
			// 确认第三个采样点滚动条确已可见。
			assert.strictEqual(transcript.isScrollbarVisible, true);
			// 再次验证进入轨道没有滚动正文。
			assert.strictEqual(transcript.scrollTop, scrollTop);
			// 读取重显态标签起点。
			const revealedColumn = terminal.getViewport()[5].indexOf(label);

			// 三次0起索引必须全为24，直接证明这份80列布局里滚动条显隐不改变标签起列；不是所有宽度的数学普适证明。
			assert.deepStrictEqual([visibleColumn, hiddenColumn, revealedColumn], [24, 24, 24]);
			// finally无论前面是否断言成功都尝试执行停止，不是把错误吞掉。
		} finally {
			// 释放本实例公共监听/调度并正常复位虚拟终端；不销毁底层xterm对象。
			tui.stop();
		}
	});

	// 回归#9136的另一面：30列长标签必须给右侧滚动条留最后一列，并且轨道点击不能被误认成标签跳底。只比较画面和跟随状态，不模拟实际鼠标设备。
	it("leaves the scrollbar visible and clickable when the jump-to-end indicator spans the transcript", async () => {
		// Regression coverage for #9136: centering must not paint or capture clicks over the scrollbar.
		// 建立30列6行的内存终端。
		const terminal = new VirtualTerminal(30, 6);
		// 创建带自定义跳底标签的TUI，保存下面回调。
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			// 生成30个单列向下箭头，故意与终端宽度一样长，迫使渲染器处理和滚动条重叠的边界。
			scrollToEndIndicator: () => "↓".repeat(30),
		});
		// 滚动区包装12行正文，比4行聊天视口长。
		const transcript = new ScrollView(
			// 生成line1到line12的无padding Text。
			new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			// 末尾跟随且滚动条always，最右列始终参与轨道布局而非依悬停时隐时现。
			{ follow: "end", primary: true, scrollbar: "always" },
		);
		// 设置正文加底部两行的显式根。
		tui.setLayoutRoot(
			// VStack按竖向组合聊天和dock。
			new VStack([
				// 聊天分余量，本次占4行。
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				// 底部自然高2行，保留editor/footer测试文本。
				{ component: new Text("editor\nfooter", 0, 0), basis: "auto", minSize: 1 },
			]),
		);
		// 启动并排定首帧，不对宿主终端启鼠标模式。
		tui.start();
		// 等首帧使轨道和内容几何可用于命中。
		await terminal.waitForRender();

		// 上滚一行，制造需要显示跳底提示的状态。
		terminal.sendInput("\x1b[<64;1;1M");
		// 等待上滚后的画面。
		await terminal.waitForRender();
		// 确认已经不跟末尾，后续轨道点击不应把它改回true。
		assert.strictEqual(transcript.isFollowingEnd, false);

		// The indicator must not intercept a press on the scrollbar's last column.
		// 屏幕第4行精确预期29个箭头加滚动条竖线；原30字标签最后一格被保留给轨道。
		assert.strictEqual(terminal.getViewport()[3], `${"↓".repeat(29)}┃`);
		// 左键按在最后一列第4行，是轨道而不是标签的命中区。
		terminal.sendInput("\x1b[<0;30;4M");
		// 同处释放完成点击。
		terminal.sendInput("\x1b[<0;30;4m");
		// 等待轨道路由后的结果。
		await terminal.waitForRender();
		// 跟随仍为false，排除轨道点击错误触发跳底；并未断言具体新的scrollTop数值。
		assert.strictEqual(transcript.isFollowingEnd, false);
		// 正常结束停止；此例没有finally保护前面的失败路径。
		tui.stop();
	});

	// 验证没有follow:end的主滚动区不会仅因提供了标签回调就显示跳底按钮。本例只检查初始3行视口中的状态与文字，没有遍历所有滚动位置。
	it("never shows the jump-to-end indicator for a primary scroll view without follow-end", async () => {
		// 模拟30列3行屏幕，比下面5行正文短。
		const terminal = new VirtualTerminal(30, 3);
		// 给TUI注入提示回调，但并不改变ScrollView的跟随策略。
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			// 普通标签字符串不加额外ANSI样式，只有需要合成提示时才使用。
			scrollToEndIndicator: () => " ↓ Jump to end ",
		});
		// ScrollView仅primary:true，follow缺省为none；内容五行，必须将“有溢出”和“允许末尾跟随”两个概念分开。
		const transcript = new ScrollView(new Text("one\ntwo\nthree\nfour\nfive", 0, 0), { primary: true });
		// 将这个不跟随主区设为显式布局根。
		tui.setLayoutRoot(transcript);
		// 启动实际TUI但输出只交内存终端；没有因主区不跟随就省掉启动钩子。
		tui.start();
		// 等待初始视口解析完成。
		await terminal.waitForRender();

		// 确认该主滚动区没有进入末尾跟随。
		assert.strictEqual(transcript.isFollowingEnd, false);
		// 要求所有可见行都不含跳底标签，检验follow策略而不只是标签回调是否存在。
		assert.ok(!terminal.getViewport().some((line) => line.includes("Jump to end")));
		// 正常停止；前面断言失败不会自动走到这里。
		tui.stop();
	});

	// 验证显式dock不随聊天滚动：滚轮落在底部也回退给主聊天区，随后新增正文保留手动位置，显式scrollToBottom才恢复末尾。整个六行数组同时检查文档区和底部。
	it("keeps an explicit dock fixed while the transcript scrolls", async () => {
		// 建立20列6行内存终端，底部两行留下4行聊天视口。
		const terminal = new VirtualTerminal(20, 6);
		// 创建实际备用屏TUI，默认配置不指定自定义复制或打开链接实现。
		const tui = new TuiAltScreen(terminal);
		// 保存8行正文的Text引用，以便后面直接更新同一组件而非重建根。
		const transcriptText = new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		// 聊天主滚动区初始follow:end，手动上滚时会暂停动态跟随。
		const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
		// 底部用两个独立Text各一行，VStack排成editor、footer；不是聊天文档的一部分。
		const dock = new VStack([new Text("editor", 0, 0), new Text("footer", 0, 0)]);
		// 安装显式根布局，把正文视口和停靠区分开。
		tui.setLayoutRoot(
			// 根VStack把下两项竖向分配。
			new VStack([
				// 正文basis0、grow1拿底部之外的余量，最小请求1行。
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				// 停靠区按自然高度2行分配，不额外设置grow来争取正文空间。
				{ component: dock, basis: "auto", minSize: 1 },
			]),
		);
		// 启动并排首帧，虚拟终端保存输入回调。
		tui.start();
		// 等渲染与xterm解析后再比初始屏幕。
		await terminal.waitForRender();

		// 深比较全部六行，既验证聊天跟末尾又验证底部位置。
		// 逐行trimEnd忽略填充空白，保留正文内的空格与换行边界。
		// 初始聊天5–8在前四行，editor与footer固定在后两行。
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "editor", "footer"],
		);

		// Wheel over the dock falls back to the primary transcript scroll view.
		// 在第1列第6行，也就是footer区域送向上滚轮；那里没有独立ScrollView，所以按路由回退到主聊天区。
		terminal.sendInput("\x1b[<64;1;6M");
		// 等待回退滚动后的画面。
		await terminal.waitForRender();
		// 比较整个视口，避免只看scrollTop漏掉dock一起移动的错误。
		// 读最新六行并裁去末尾空白。
		// 正文变4–7，底部仍是editor/footer，说明只聊天区上滚一行。
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 4", "line 5", "line 6", "line 7", "editor", "footer"],
		);
		// 检查这次手动滚动已暂停末尾跟随。
		assert.strictEqual(transcript.isFollowingEnd, false);

		// 把同一个正文Text更新为10行，原组件引用及根布局不变。
		transcriptText.setText(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
		// Text更新后显式请求帧，安排重新布局。
		tui.requestRender();
		// 等新正文布局完成。
		await terminal.waitForRender();
		// 检查新增行没有强制夺回手动阅读位置。
		// 取渲染后的视口文字，去掉行末填充。
		// 仍是4–7和固定dock，而不是自动显示7–10。
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 4", "line 5", "line 6", "line 7", "editor", "footer"],
		);

		// 调用TUI公开跳底方法，操作主ScrollView并请求后续帧，不是终端自身scrollback滚到底。
		tui.scrollToBottom();
		// 等待显式跳底执行后的画面。
		await terminal.waitForRender();
		// 比较完整六行以确认跳底和底部布局同时正确。
		// 读屏并trimEnd，产生本次独立快照数组。
		// 正文现在显示7–10，dock仍在最后两行。
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 7", "line 8", "line 9", "line 10", "editor", "footer"],
		);
		// 正常停止TUI，默认重渲文档到虚拟主屏；本例没有finally兜底。
		tui.stop();
	});

	// 同步测试显式布局根不会漏掉浮层invalidate：用布尔标记替换浮层方法、挂根和浮层、调用invalidate后直接检查，无需启动或等待真实渲染。
	it("invalidates overlays with an explicit layout root", () => {
		// 构造默认80×24内存终端与TUI，不调用start，所以本例不需要能力冷探测的启动路径。
		const tui = new TuiAltScreen(new VirtualTerminal());
		// 创建浮层Text，下面会在同一实例上替换invalidate方法。
		const overlay = new Text("overlay", 0, 0);
		// let布尔标志初始false，作为这条同步回调是否执行的观测值。
		let invalidated = false;
		// 把实例方法赋为箭头替身，捕获invalidated变量；赋值只保存函数，不立即置true。
		overlay.invalidate = () => {
			// 实际invalidate调用时改标志，返回undefined，不调用原Text失效逻辑。
			invalidated = true;
		};
		// 设显式root，之后本例检查的是公共失效链仍包括额外浮层。
		tui.setLayoutRoot(new Text("root", 0, 0));
		// 把overlay注册到浮层栈，可能安排渲染请求，但这里没有start也不检查画面。
		tui.showOverlay(overlay);

		// 同步失效布局根与浮层，触发上面的标记替身。
		tui.invalidate();

		// 严格true断言证明浮层回调执行过，不证明执行次数为1，也不检查是否已实际重画。
		assert.strictEqual(invalidated, true);
		// 即便未start也调用stop处理实例停止状态和公共收尾，不把它说成执行了一次完整启屏。
		tui.stop();
	});

	// 验证鼠标指向哪个横向滚动区就滚哪个，而不是总选primary：左右各10列、7行内容、4行窗口，右区上滚后左偏移保持3、右变2。
	it("routes wheel input to the scroll view under the pointer", async () => {
		// 建立20列4行内存终端，刚好容纳两个10列区域。
		const terminal = new VirtualTerminal(20, 4);
		// 创建TUI，下面用HStack取代默认布局。
		const tui = new TuiAltScreen(terminal);
		// 左区七行a1到a7，无Text内边距，配置单独放在后面对象里。
		const left = new ScrollView(new Text("a1\na2\na3\na4\na5\na6\na7", 0, 0), {
			// 左区初始跟末尾，7行在4行视口中对应偏移3。
			follow: "end",
			// 左区是primary，作为指针未命中其他滚动区时的主目标，不表示它永远抢先消费所有滚轮。
			primary: true,
		});
		// 右区七行b1到b7，也跟末尾但不是primary，用来检验鼠标局部命中优先。
		const right = new ScrollView(new Text("b1\nb2\nb3\nb4\nb5\nb6\nb7", 0, 0), { follow: "end" });
		// 安装左右并排的显式根。
		tui.setLayoutRoot(
			// HStack按水平方向安排孩子，不使用普通Container的纵向行累计。
			new HStack([
				// 左区基础宽10、shrink0不主动收缩，本次正好有足够宽度。
				{ component: left, basis: 10, shrink: 0 },
				// 右区也固定基础10列，两区合计占20列。
				{ component: right, basis: 10, shrink: 0 },
			]),
		);
		// 启动TUI，让组件建立可用于鼠标命中的布局盒子。
		tui.start();
		// 等首帧，未布局前不能拿这些几何位置作断言。
		await terminal.waitForRender();

		// 在第15列第1行上滚，横向落在右区而不是左侧primary。
		terminal.sendInput("\x1b[<64;15;1M");
		// 等右区滚动后重新合成。
		await terminal.waitForRender();
		// 左区scrollTop仍为0起3，说明未错误滚动primary。
		assert.strictEqual(left.scrollTop, 3);
		// 右区scrollTop从3减到2，恰好上滚一行。
		assert.strictEqual(right.scrollTop, 2);
		// 比较合成四行，确认状态变化确实反映到横向画面。
		// 裁掉每整行最右填充，不去左右区之间用于对齐的内部空格。
		// 左列a4–a7、右列b3–b6，中间空白保留到第11列，验证横向位置而非只比子区文本。
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["a4        b3", "a5        b4", "a6        b5", "a7        b6"],
		);
		// 正常停止，断言异常时本例没有finally。
		tui.stop();
	});

	// 验证Alt滚轮的5倍行数：12行内容在4行视口初始偏移8，一次Alt向上滚后到3。只检这个固定输入，不模拟操作系统修饰键查询。
	it("scrolls faster while Alt is held during wheel input", async () => {
		// 20列4行虚拟尺寸，不依赖用户终端高度。
		const terminal = new VirtualTerminal(20, 4);
		// 创建默认每次滚一行的备用屏实例。
		const tui = new TuiAltScreen(terminal);
		// 生成12条编号正文并用LF拼接，Text不加padding。
		const text = new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		// 加入默认隐式聊天文档。
		tui.addChild(text);
		// 启动输入回调与首帧调度。
		tui.start();
		// 等初始跟末尾布局完成。
		await terminal.waitForRender();
		// 确认偏移8，即12减4，为后面乘数检查建立起点。
		assert.strictEqual(tui.viewportTop, 8);

		// Alt modifier sets bit 8 on the wheel button (72 = 64 + 8).
		// 72=64向上滚轮位加8的Alt位；SGR坐标1,1，整个字符串直接送虚拟输入回调。
		terminal.sendInput("\x1b[<72;1;1M");
		// 等待加速滚动后的画面和状态。
		await terminal.waitForRender();
		// 8减5等于3，断言这次Alt滚轮确实消耗5行，而非默认1行。
		assert.strictEqual(tui.viewportTop, 3);
		// 正常停止实例，不在本例声明任何系统Alt键状态。
		tui.stop();
	});

	// 验证HStack右侧普通文字上的点击不会按纵向Container的回退误发到左侧SelectList。只观察onSelect计数为0，不声称右侧完全没有收到其他鼠标事件。
	it("does not vertically redispatch misses through horizontal layout containers", async () => {
		// 20列2行内存屏，左列表和右文字各占10列。
		const terminal = new VirtualTerminal(20, 2);
		// 创建真实TUI，使用下面的显式横向根。
		const tui = new TuiAltScreen(terminal);
		// 用可变数字统计选择提交次数，初始0。
		let selections = 0;
		// 创建两项选择列表，最大显示数与主题分别在后续参数给出。
		const list = new SelectList(
			// 下面数组是列表数据，不是已经渲染的屏幕行。
			[
				// 第一项内部value为a、可见label为A，区分业务值和展示文字。
				{ value: "a", label: "A" },
				// 第二项value为b、label为B，顺序决定上下排列。
				{ value: "b", label: "B" },
			],
			// 最大显示项数2，这个测试没有菜单溢出滚动。
			2,
			// 主题回调都原样返回文字，让断言不依赖额外颜色包装。
			{
				// 前缀主题函数原样返回输入；当前SelectList实际把前缀与正文合交selectedText，不调用这个兼容字段。
				selectedPrefix: (text) => text,
				// 选中项文字主题恒等，不改变内容。
				selectedText: (text) => text,
				// 描述主题也恒等，本例条目未提供description但接口仍要求字段。
				description: (text) => text,
				// 滚动状态文字主题恒等，没有在这里建立计时器。
				scrollInfo: (text) => text,
				// 无匹配提示主题恒等，本例并不触发无匹配分支。
				noMatch: (text) => text,
			},
		);
		// 注册选择提交回调，赋值本身不触发一次选择。
		list.onSelect = () => {
			// 未来调用onSelect才把计数加1，不记录具体选了a还是b。
			selections += 1;
		};
		// 将横向栈设为根，决定点击坐标应按左右区域分发。
		tui.setLayoutRoot(
			// HStack将列表放左、plain文本放右，而非上下堆叠。
			new HStack([
				// 左列表基础宽10列。
				{ component: list, basis: 10 },
				// 右Text基础宽10列、无内边距，第15列位于它的范围。
				{ component: new Text("plain", 0, 0), basis: 10 },
			]),
		);
		// 启动TUI以便建立横向命中几何。
		tui.start();
		// 等首帧后再点击。
		await terminal.waitForRender();

		// 左键按在第15列第1行，命中右侧普通文字。
		terminal.sendInput("\x1b[<0;15;1M");
		// 同一点释放，形成右侧点击；不拖动跨到列表。
		terminal.sendInput("\x1b[<0;15;1m");
		// 等待可能排定的帧与输入后续处理。
		await terminal.waitForRender();
		// 计数仍0，证明这次未错误提交左列表选择。
		assert.strictEqual(selections, 0);
		// 正常停止，测试无finally自动收尾。
		tui.stop();
	});

	// 验证复用器环境只生成按钮拖动1002而不启全移动1003，普通环境启1003，同时均启SGR编码。只是检查控制串，不启动tmux/Zellij/Screen；能力冷探测仍需运行环境PI_HYPERLINKS=0来避免真实tmux查询。finally恢复四个环境值，但内部TUI的stop仍只在正常分支末尾。
	it("uses button-motion tracking inside terminal multiplexers", () => {
		// as const把四个键推断为只读字面量元组供TS使用，不在运行时冻结数组，也不读取这些环境值。
		const environmentKeys = ["TMUX", "ZELLIJ", "STY", "TERM"] as const;
		// 逐键读取当前字符串或undefined保存进Map，保留不存在与空字符串的区别，供finally精确恢复。
		const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
		// 进入环境修改的try/finally，不是为每个TUI单独建立自动停止保护。
		try {
			// 先删除四个复用器/TERM信号，避免宿主环境影响直接终端样本。
			for (const key of environmentKeys) delete process.env[key];
			// 显式设普通xterm名称，让这次不命中tmux/screen前缀。
			process.env.TERM = "xterm-256color";
			// 记录型内存终端用默认80×24尺寸；未打开真实终端。
			const directTerminal = new RecordingTerminal();
			// 构造直接环境样本的TUI。
			const directTui = new TuiAltScreen(directTerminal);
			// 启动时同步写启屏和鼠标码，记录数组可立即检查，不需等xterm完成解析。
			directTui.start();
			// 从调用记录取本次所有write事件并拼成一个字符串，以检查模式请求。
			const directWrites = directTerminal.events
				// 显式event is类型谓词配合filter，TS据此把结果缩到含data的write分支；运行时真正判断仍只看type。
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				// 每个已缩窄事件提取data字符串。
				.map((event) => event.data)
				// join空分隔直接连接各write，不保留调用边界，也不自动加LF。
				.join("");
			// 普通环境应包含启用1003全指针移动报告的控制串；只说明代码请求，不验证硬件响应。
			assert.ok(directWrites.includes("\x1b[?1003h"));
			// 正常停止直接环境实例；如果前面断言失败，外层finally只恢复环境而不会补跑此行。
			directTui.stop();

			// 五个环境样本分别只设置一类信号，name用于断言失败提示，不用于分支判断。
			const multiplexers = [
				// 假TMUX路径仅是环境文字，不创建或连接对应会话；若没有能力探测短路，实际被测启动代码仍可能执行tmux查询。
				{ name: "tmux environment", environment: { TMUX: "/tmp/tmux/default,1,0" } },
				// 仅TERM的tmux前缀也应进入复用器鼠标模式。
				{ name: "tmux TERM", environment: { TERM: "tmux-256color" } },
				// ZELLIJ值为字符串0仍算已定义，测试不能把它误当布尔false。
				{ name: "Zellij environment", environment: { ZELLIJ: "0" } },
				// 只给STY模拟Screen信号，不启动Screen进程。
				{ name: "Screen environment", environment: { STY: "123.session" } },
				// 只给screen前缀TERM，覆盖没有STY但TERM表明复用器的路径。
				{ name: "Screen TERM", environment: { TERM: "screen-256color" } },
			];
			// for..of逐个解构样本名与环境对象，顺序执行，未创建并发测试。
			for (const { name, environment } of multiplexers) {
				// 每轮先清同四个键，避免上轮环境残留共同影响下一轮。
				for (const key of environmentKeys) delete process.env[key];
				// Object.entries取这轮自有键值，再写process.env；这是测试进程全局状态修改，不只修改局部对象。
				for (const [key, value] of Object.entries(environment)) process.env[key] = value;
				// 每轮新建独立记录型虚拟终端，事件不会混入之前样本的数组。
				const terminal = new RecordingTerminal();
				// 每轮构造对应TUI实例。
				const tui = new TuiAltScreen(terminal);
				// 启动以立即生成进入屏幕和鼠标模式请求。
				tui.start();
				// 只收集本轮终端记录的写入数据。
				const writes = terminal.events
					// 类型谓词让filter后的事件可直接读取data，实际过滤依据type严格为write。
					.filter((event): event is { type: "write"; data: string } => event.type === "write")
					// map取原始控制串，不解释xterm屏幕内容。
					.map((event) => event.data)
					// 无分隔拼接各次write便于includes检查。
					.join("");
				// 每种复用器环境都必须请求1002按钮拖动；模板字符串只构造断言失败文案。
				assert.ok(writes.includes("\x1b[?1002h"), `${name} should enable button-motion tracking`);
				// 同时要求没有1003全移动，避免仅启1002但仍额外启1003的错误实现混过断言。
				assert.ok(!writes.includes("\x1b[?1003h"), `${name} should not enable all-motion tracking`);
				// 还要求1006 SGR鼠标编码，说明降低移动流量没有顺带关闭坐标编码。
				assert.ok(writes.includes("\x1b[?1006h"), `${name} should enable SGR mouse encoding`);
				// 正常结束本轮实例；后续样本再清环境，不复用这个TUI。
				tui.stop();
			}
			// 无论样本断言是否成功都进入环境恢复；恢复过程本身没有逐项catch，也不停止遗漏的TUI。
		} finally {
			// 遍历最初的四个键，恢复与删除分开。
			for (const key of environmentKeys) {
				// Map.get取修改前的字符串或undefined。
				const value = previousEnvironment.get(key);
				// 原本不存在的键必须delete，不把undefined赋成字符串环境值。
				if (value === undefined) delete process.env[key];
				// 原值存在则精确赋回，空字符串也保留。
				else process.env[key] = value;
			}
		}
	});

	// 模拟Windows与Linux平台、VS Code标识，验证右键只在Windows且非VS Code调用注入粘贴回调。回调只是计数，不读剪贴板；修改process.platform仅限当前进程属性，finally尝试恢复原描述符。
	it("invokes the right-click paste handler only on Windows outside VS Code", () => {
		// 保存process.platform完整属性描述符，包含value与属性标志，而不是只存平台字符串。
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		// 保存原TERM_PROGRAM值，区分缺失与空字符串。
		const termProgram = process.env.TERM_PROGRAM;
		// 断言描述符存在，否则后面无法可靠用原描述符恢复；这是测试前置条件，不是运行时平台认证。
		assert.ok(platformDescriptor);
		// 构造默认尺寸内存终端，修改platform不会把它替换成真实Windows适配器。
		const terminal = new VirtualTerminal();
		// 用计数统计注入粘贴处理器被调用次数，不读取实际粘贴内容。
		let pasteCount = 0;
		// 构造TUI并保存下一段提供的右键粘贴回调，构造时不调用它。
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			// 无输入的右键粘贴回调仅供被测路由未来调用，返回void；没有系统剪贴板读取、粘贴命令或文本插入。
			onRightClickPaste: () => {
				// 调用一次便把pasteCount加1，作为平台与宿主条件的观测值。
				pasteCount += 1;
			},
		});
		// 进入全局属性恢复的try/finally；此处尚未真正start。
		try {
			// 重定义当前进程platform为win32并允许再次配置，模拟分支而不改变真实操作系统或加载Windows原生库。
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			// 删除TERM_PROGRAM，避免VS Code条件挡住第一轮右键分支。
			delete process.env.TERM_PROGRAM;
			// 启动同一个虚拟TUI，之后sendInput同步测试右键路由，无需先读屏。
			tui.start();
			// 按钮码2表示右键，在第1列第1行按下。
			terminal.sendInput("\x1b[<2;1;1M");
			// 小写m表示右键释放；这组输入最终只应触发一次粘贴处理。
			terminal.sendInput("\x1b[<2;1;1m");
			// 检查计数恰好1，排除按下与释放各触发一次。
			assert.strictEqual(pasteCount, 1);

			// 在相同win32模拟平台上改成vscode宿主标识。
			process.env.TERM_PROGRAM = "vscode";
			// 只送一次右键按下，检验VS Code环境下被测入口不调用注入处理器。
			terminal.sendInput("\x1b[<2;1;1M");
			// 计数仍1，说明第二轮没有新增调用。
			assert.strictEqual(pasteCount, 1);

			// 把同一进程属性改为linux，检验非Windows路径。
			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			// 清vscode标识，以免Linux未调用只是被VS Code条件挡住。
			delete process.env.TERM_PROGRAM;
			// Linux模拟平台上再送右键按下。
			terminal.sendInput("\x1b[<2;1;1M");
			// 计数仍1，非Windows分支未新增处理器调用。
			assert.strictEqual(pasteCount, 1);
			// finally尝试先停TUI再恢复平台和环境，步骤不是原子的；若stop抛错，后面恢复会被跳过。
		} finally {
			// 停止公共TUI路径，输出仍只写入xterm内存模拟器。
			tui.stop();
			// 恢复最初属性描述符，保留原value及标志，不仅是把value硬写回当前机器名。
			Object.defineProperty(process, "platform", platformDescriptor);
			// 原TERM_PROGRAM不存在则删除。
			if (termProgram === undefined) delete process.env.TERM_PROGRAM;
			// 原值存在则原样赋回，包含空串情况。
			else process.env.TERM_PROGRAM = termProgram;
		}
	});

	// 验证auto条的隐藏轨道仍能被指针发现：移入最右列显示并激活，移出后等20ms隐藏计时再检查消失。40ms等待不是实时准确性保证，本例没有finally停止保护。
	it("reveals an auto scrollbar when the pointer enters its hidden track", async () => {
		// 10列5行的记录型虚拟终端，同时能查屏幕和控制串。
		const terminal = new RecordingTerminal(10, 5);
		// 构造默认TUI，显式根随后提供。
		const tui = new TuiAltScreen(terminal);
		// 滚动区内容与配置分两参数。
		const scrollView = new ScrollView(
			// 20行正文在5行视口溢出，使滚动条有显示意义。
			new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			// primary:true、auto条、20ms隐藏延迟；follow未给所以不自动跟末尾。
			{ primary: true, scrollbar: "auto", scrollbarHideDelayMs: 20 },
		);
		// 滚动区作为整个布局根。
		tui.setLayoutRoot(scrollView);
		// 启动并建立输入回调。
		tui.start();
		// 等待初始布局和内存写队列。
		await terminal.waitForRender();
		// 初始auto条应隐藏，不因文档有溢出就始终显示。
		assert.strictEqual(scrollView.isScrollbarVisible, false);

		// 35为无按钮移动，第10列是最右隐藏轨道、第3行在范围内。
		terminal.sendInput("\x1b[<35;10;3M");
		// 等待进入轨道触发的外观更新。
		await terminal.waitForRender();
		// 状态标记isScrollbarVisible应true。
		assert.strictEqual(scrollView.isScrollbarVisible, true);
		// isScrollbarActive也应true，区别于仅在计时内临时可见。
		assert.strictEqual(scrollView.isScrollbarActive, true);
		// 视口至少有一行包含轨道或滑块字形，除状态值外再核实出现了图形；不要求每行都相同字形。
		assert.ok(terminal.getViewport().some((line) => /[│█]/.test(line)));

		// 移到第9列，离开轨道而没有滚轮或按键动作。
		terminal.sendInput("\x1b[<35;9;3M");
		// 用真实Node timer请求约40ms等待，给20ms隐藏任务机会；调度繁忙可更晚，不保证精确40ms。
		await new Promise((resolve) => setTimeout(resolve, 40));
		// 再等待渲染辅助和xterm解析，使隐藏结果可读。
		await terminal.waitForRender();
		// 离开并过延迟后条应不可见。
		assert.strictEqual(scrollView.isScrollbarVisible, false);
		// 正常停止TUI，若此前失败不会自动执行此行。
		tui.stop();
	});

	// 验证轨道单击直接跳位置后可以继续拖动，并且释放不会误触正文复制。50行内容、10行视口最大偏移40，先点中部到20再拖底到40。
	it("jumps to a scrollbar track position and continues dragging from there", async () => {
		// 10列10行记录型内存终端，轨道位于第10列。
		const terminal = new RecordingTerminal(10, 10);
		// 创建实际TUI，不注入系统剪贴板实现。
		const tui = new TuiAltScreen(terminal);
		// 配置一个整个屏幕的滚动区。
		const scrollView = new ScrollView(
			// 50行编号Text，没有内边距，易于计算最大滚动偏移50减10。
			new Text(Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			// 主滚动区并始终显示滚动条，跟随未指定，初始从顶部。
			{ primary: true, scrollbar: "always" },
		);
		// 把该ScrollView设为显式根。
		tui.setLayoutRoot(scrollView);
		// 启动并请求初帧。
		tui.start();
		// 等轨道和滑块尺寸建立。
		await terminal.waitForRender();
		// 初始scrollTop严格为0，为跳轨道位置建立基准。
		assert.strictEqual(scrollView.scrollTop, 0);

		// 在第10列第6行按左键，命中滑块外的轨道位置。
		terminal.sendInput("\x1b[<0;10;6M");
		// 等待跳转后的布局。
		await terminal.waitForRender();
		// 预期文档偏移20，说明轨道点击已生效，不仅开始一个空拖动。
		assert.strictEqual(scrollView.scrollTop, 20);

		// 按钮码32为按左键移动，继续在最右轨道拖到第10行。
		terminal.sendInput("\x1b[<32;10;10M");
		// 等待拖动新位置显示。
		await terminal.waitForRender();
		// 预期偏移40，等于文档底部最大值。
		assert.strictEqual(scrollView.scrollTop, 40);

		// 在轨道底部释放左键，结束滚动条拖动。
		terminal.sendInput("\x1b[<0;10;10m");
		// 等待释放后的潜在渲染与任务。
		await terminal.waitForRender();
		// every要求任何write都不含OSC52复制前缀，排除把轨道拖动当正文选区复制；只查内存记录，不读取真实剪贴板。
		assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")));
		// 正常停止TUI，未给失败流程统一finally。
		tui.stop();
	});

	// #9758: wheel line counts can change at runtime; Alt keeps its multiplier.
	// 回归#9758：构造每次滚3行，运行时改2行，Alt仍乘5；MouseRegion记录规范化delta，预期依次-3、2、-10，重点检查路由参数而不是文档偏移。
	it("applies runtime wheel line count updates", async () => {
		// 建立20列4行内存终端。
		const terminal = new VirtualTerminal(20, 4);
		// 选项wheelScrollLines设为3，前面undefined仅占可选参数位置。
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 3 });
		// Array<number|undefined>允许记录事件可选wheelDelta原值；实际预期均为数字，类型没有替事件自动补0。
		const deltas: Array<number | undefined> = [];
		// 把可消费滚轮的区域加入默认文档。
		tui.addChild(
			// MouseRegion包装固定文字，回调每次接规范化鼠标事件，返回处理结果给TUI。
			new MouseRegion(new Text("wheel target", 0, 0), (event) => {
				// 非wheel立即undefined，表示这个回调不处理这类事件，不是抛错。
				if (event.type !== "wheel") return undefined;
				// 把实际传来的可选delta追加数组，供后面顺序比较。
				deltas.push(event.wheelDelta);
				// 返回handled:true阻止该滚轮继续滚正文；没有额外请求render:true，不因此要求无变化事件重绘。
				return { handled: true };
			}),
		);
		// 先start再进入try，启动自身若抛错不在下面finally保护内。
		tui.start();
		// 测试体的断言/输入失败时仍尝试停止。
		try {
			// 首帧建立MouseRegion命中盒子。
			await terminal.waitForRender();
			// 64上滚产生当前配置的-3逻辑行。
			terminal.sendInput("\x1b[<64;1;1M");
			// 运行时把同一实例的滚轮策略改为2行，不重建TUI，也不立即滚动。
			tui.setWheelScrollLines(2);
			// 65下滚使用新配置，产生+2。
			terminal.sendInput("\x1b[<65;1;1M");
			// 72是Alt上滚，新2行乘5，产生-10。
			terminal.sendInput("\x1b[<72;1;1M");
			// 深比较三次delta，sendInput同步走回调，因此这里不用再等待新画面即可检查记录。
			assert.deepStrictEqual(deltas, [-3, 2, -10]);
			// 无论测试体是否成功都进入正常停止尝试。
		} finally {
			// 停止本实例；这里不撤销一个全局滚轮配置，因为配置存于本TUI实例。
			tui.stop();
		}
	});

	// 测试嵌套滚动的剩余量链：内区6行、2行窗口最多滚4；每轮请求3，第一轮内滚3外不动，第二轮内只再滚1、余下2交外区。
	it("chains unused wheel delta to an outer scroll view", async () => {
		// 20列4行内存终端。
		const terminal = new VirtualTerminal(20, 4);
		// 默认滚轮步长设3，以一条事件产生可分配的剩余量。
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 3 });
		// 内区六行文字、无跟随选项，从0开始；其显示高度将在外层VStack限定为2。
		const inner = new ScrollView(new Text("i1\ni2\ni3\ni4\ni5\ni6", 0, 0));
		// 外区包装内区和尾部正文，外区本身也有可滚动的完整文档。
		const outer = new ScrollView(
			// 内区basis2请求2行，之后五行tail文字形成外区溢出；普通Text没有再建额外ScrollView。
			new VStack([{ component: inner, basis: 2 }, new Text("tail1\ntail2\ntail3\ntail4\ntail5", 0, 0)]),
			// 外区标primary，内外滚轮链仍先考虑指针下更深层的内区。
			{ primary: true },
		);
		// 外区作为根布局，负责裁剪整个嵌套文档到4行屏幕。
		tui.setLayoutRoot(outer);
		// 启动并排定布局。
		tui.start();
		// 首帧建立内外滚动区的内容高和视口高。
		await terminal.waitForRender();

		// 在第1列第1行向下滚3行，指针位于内区。
		terminal.sendInput("\x1b[<65;1;1M");
		// 等待第一次滚动。
		await terminal.waitForRender();
		// 内区偏移3，说明第一轮完整消费3。
		assert.strictEqual(inner.scrollTop, 3);
		// 外区仍0，不能同时重复消费同一份delta。
		assert.strictEqual(outer.scrollTop, 0);

		// 相同位置再次向下请求3行，内区这次只剩1行空间。
		terminal.sendInput("\x1b[<65;1;1M");
		// 等待剩余量传给外区后的画面。
		await terminal.waitForRender();
		// 内区到最大偏移4，没有被请求量直接推进到6。
		assert.strictEqual(inner.scrollTop, 4);
		// 余下2行交外区，外区偏移2。
		assert.strictEqual(outer.scrollTop, 2);
		// 正常停止；本例没有finally处理前面的失败。
		tui.stop();
	});

	// 验证默认可配置分页动作识别Kitty及另一种编码，并让8行视口翻页保留4行重叠。发送按下与释放后各只翻一次，0–7与4–11两屏互切；此例没有实际改键位表，后面另测自定义绑定。
	it("supports configurable keyboard viewport navigation with four rows of page overlap", async () => {
		// 建立20列8行内存屏。
		const terminal = new VirtualTerminal(20, 8);
		// 构造使用当前共享键位管理器的TUI。
		const tui = new TuiAltScreen(terminal);
		// 加入12行编号正文，初始跟末尾时从第5行开始。
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		// 启动模式与调度。
		tui.start();
		// 等初始布局后再发送分页序列。
		await terminal.waitForRender();

		// Kitty功能键码57421表示PageUp，缺修饰默认无修饰按下。
		terminal.sendInput("\x1b[57421u");
		// 相同键的:3是释放事件，应被消费而不再次翻页。
		terminal.sendInput("\x1b[57421;1:3u");
		// 等待这组按下/释放后的单次翻页结果。
		await terminal.waitForRender();
		// 比较PageUp后的八行画面。
		// 逐行裁末尾空白，不合并屏幕行。
		// 预期1–8，说明由底部起点4向前翻4行到0。
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"],
		);

		// Kitty功能键码57422表示PageDown。
		terminal.sendInput("\x1b[57422u");
		// 对应释放同样不该重复执行分页。
		terminal.sendInput("\x1b[57422;1:3u");
		// 等向下分页结果。
		await terminal.waitForRender();
		// 比较回到底端的八行。
		// 取最新文字快照并trimEnd。
		// 预期5–12，与前页共享5–8四行，体现重叠而不是整8行跳跃。
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12"],
		);

		// 另一种键编码CSI7^同样映射上翻页，走相同动作表。
		terminal.sendInput("\x1b[7^");
		// 等该编码触发的上翻。
		await terminal.waitForRender();
		// 比较备用编码的PageUp行为与Kitty一致。
		// 读取视口并去行末填充。
		// 预期再次1–8。
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"],
		);

		// CSI8^对应下翻页，测试另一方向。
		terminal.sendInput("\x1b[8^");
		// 等下翻页写入解析。
		await terminal.waitForRender();
		// 比较最终八行。
		// 读屏并逐行trimEnd。
		// 预期再次5–12，检查兼容编码没有走焦点组件输入。
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12"],
		);

		// 正常停止本例TUI；断言失败不保证到达。
		tui.stop();
	});

	// 纯字符串测试跨行、不区分大小写的搜索：两行alpha QUICK与brown fox中查quick brown，应映射到第一行6–11和下一行0–5两段，不建TUI或终端。
	it("searches normalized rendered transcript text across rows", () => {
		// 调用真实归一化匹配算法并深比较结果，源行大小写与查询不同，空白连接跨过行边界。
		assert.deepStrictEqual(findAltScreenSearchMatches(["alpha QUICK", "brown fox"], "quick brown"), [
			// 预期数组只含一个匹配对象，不是跨行就分成两个独立匹配。
			{
				// segments记录同一匹配在各行可见文字上的片段，列从0起、endCol为排他端。
				segments: [
					// 第一行QUICK从第6列起占5列，区间6到11。
					{ row: 0, startCol: 6, endCol: 11 },
					// 第二行brown占0到5，后面的空格fox不包含在匹配里。
					{ row: 1, startCol: 0, endCol: 5 },
				],
			},
		]);
	});

	// 纯字符串测试颜色、连续空白、CJK、emoji和组合重音的列映射。查询空白被归一化，但高亮不能把源行中被折叠的两空格误当正文片段，宽字也按终端列计算。
	it("maps normalized ASCII and Unicode search matches back to rendered columns", () => {
		// 源首行有SGR红色与双空格，次行含A、界、双格表情、组合e重音和Z；查询故意用三空格加换行，匹配器不是直接indexOf原串。
		assert.deepStrictEqual(findAltScreenSearchMatches(["\x1b[31mfoo  bar\x1b[0m", "A界🙂éZ"], "oo   bar\nA界🙂é"), [
			// 预期仍为一条跨行匹配。
			{
				// 匹配由三个实际文字片段组成，源空白连接处可不产生高亮段。
				segments: [
					// 首行oo位于显示列1–3，不把前面的ANSI字节算进坐标。
					{ row: 0, startCol: 1, endCol: 3 },
					// bar在源双空格后，实际显示列5–8，未按归一化后偏移错误左移。
					{ row: 0, startCol: 5, endCol: 8 },
					// 次行A一列、界两列、emoji两列、e与组合重音共一列，匹配到排他第6列，不含Z。
					{ row: 1, startCol: 0, endCol: 6 },
				],
			},
		]);
	});

	// 测试索引内容相同即复用匹配数组，改变查询或渲染行才重算；每次传新源数组但内容相同仍可命中，strictEqual检查引用而非深内容相似。
	it("reuses indexed transcript matches until the query or rendered lines change", () => {
		// 创建独立搜索索引实例，初始无已缓存查询。
		const index = new AltScreenSearchIndex();
		// 首次从两行中查needle，获得结果与changed标记。
		const initial = index.search(["alpha needle", "omega"], "needle");
		// 首次计算应标记changed:true。
		assert.strictEqual(initial.changed, true);
		// needle只有一个匹配，不检验具体片段内容。
		assert.strictEqual(initial.matches.length, 1);

		// 再次传同文字的新数组与同查询，检验缓存不是只按数组对象身份决定。
		const cached = index.search(["alpha needle", "omega"], "needle");
		// 内容没变，changed应false。
		assert.strictEqual(cached.changed, false);
		// matches必须与首次结果为同一数组引用，证明复用而不只是重新生成相等内容。
		assert.strictEqual(cached.matches, initial.matches);

		// 源行不变但查询改为omega，必须重新搜索。
		const changedQuery = index.search(["alpha needle", "omega"], "omega");
		// 新查询应changed:true。
		assert.strictEqual(changedQuery.changed, true);
		// 匹配数组不能还是旧needle结果引用。
		assert.notStrictEqual(changedQuery.matches, initial.matches);
		// 新omega命中第二行0–5；可选链缺首项时得到undefined并使深比较失败。
		assert.deepStrictEqual(changedQuery.matches[0]?.segments, [{ row: 1, startCol: 0, endCol: 5 }]);

		// 保持omega查询，却把第二行改为no match，测试渲染文字变化失效缓存。
		const changedLines = index.search(["alpha needle", "no match"], "omega");
		// 渲染行变化应changed:true。
		assert.strictEqual(changedLines.changed, true);
		// 新结果为空数组，不保留旧命中。
		assert.deepStrictEqual(changedLines.matches, []);
	});

	// 同步测试搜索栏48列、三行边框、空输入占位与右下导航命中；再模拟n输入和两条结果，检查1/2状态替代占位。只render组件字符串，不启动TUI。
	it("renders transcript search with a muted placeholder and right-aligned controls", () => {
		// 建立搜索组件，传空变化回调；构造不连接stdin，后续输入变化通知只执行这个无操作回调。
		const component = new AltScreenSearchComponent(() => {});
		// 直接按48列渲染，结果保留ANSI弱化样式。
		const rendered = component.render(48);
		// 另用map剥控制串，保留rendered原数组以单独核对样式。
		const lines = rendered.map((line) => stripTerminalSequences(line));

		// 纯文字结果必须恰好三行。
		assert.strictEqual(lines.length, 3);
		// every要求每行显示宽48列，不用string.length代替终端格宽。
		assert.ok(lines.every((line) => visibleWidth(line) === 48));
		// 第一行正则要求左上角、一个或多个横线、右上角；^与$在此无m按整条字符串边界匹配。
		assert.match(lines[0] ?? "", /^┌─+┐$/);
		// 中行必须是带空格的Find in transcript占位和两侧边框，不接受额外输入文字。
		assert.match(lines[1] ?? "", /^│ Find in transcript +│$/);
		// 原始中行应含SGR2弱化码，去ANSI后的文字比较不能替代这条样式检查。
		assert.ok(rendered[1]?.includes("\x1b[2m"));
		// 底行含上一条/下一条快捷键提示，正则的反斜杠把加号变成字面加号，不是重复量词。
		assert.match(lines[2] ?? "", /^└─+ ↑ Shift\+Enter · ↓ Enter ─┘$/);
		// 保存底行文字，缺行回空串；后面所有命中坐标按这行确定。
		const controls = lines[2] ?? "";
		// 在0起第2行的向上箭头列命中，导航方向应-1。
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("↑")), -1);
		// Shift+Enter文字内部也属于上一条按钮的命中范围，不只箭头可点。
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("Shift+Enter") + 5), -1);
		// 中间分隔点不属于任一导航按钮，应返回undefined。
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("·")), undefined);
		// 向下箭头命中方向+1。
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("↓")), 1);
		// 用lastIndexOf取最后一个Enter，即下一条按钮文字，内部列同样方向+1。
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.lastIndexOf("Enter") + 2), 1);

		// 直接向组件输入n，更新搜索文字而不通过TUI公共协议解析。
		component.handleInput("n");
		// 设置当前匹配0起索引0、总数2，显示逻辑转成人类计数1/2；不实际搜索任何正文。
		component.setResult(0, 2);
		// 以相同48列重新渲染含输入/结果状态的搜索栏。
		const populatedRender = component.render(48);
		// 剥新ANSI结果用于文字检查，不修改原带样式数组。
		const populated = populatedRender.map((line) => stripTerminalSequences(line));
		// 输入行应含n，证明输入已被保留。
		assert.ok(populated[1]?.includes("n"));
		// 同一行应含1/2状态。
		assert.ok(populated[1]?.includes("1/2"));
		// 原带样式行应含弱化的空格1/2空格，再关闭弱化；只看最终文字不足以证明样式。
		assert.ok(populatedRender[1]?.includes("\x1b[2m 1/2 \x1b[22m"));
		// 任何行都不应残留占位Find in transcript，排除有输入却同时显示占位。
		assert.ok(!populated.some((line) => line.includes("Find in transcript")));
	});

	// 120列屏幕中测试搜索导航按钮悬停着色、点击上下项和再次快捷键关闭。回调返回背景控制串，事件只写记录型虚拟终端，不操作系统鼠标。
	it("navigates transcript search with hoverable arrow buttons and toggles it with its shortcut", async () => {
		// 记录型虚拟终端设120列6行，使完整快捷键文案可以显示。
		const terminal = new RecordingTerminal(120, 6);
		// 构造带自定义导航按钮样式的TUI。
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			// 回调接按钮文字和hovered布尔，悬停时品红背景45、未悬停蓝44，末尾49恢复背景；模板只造字符串，不改变真实终端颜色。
			searchNavigationButtonStyle: (text, hovered) => `${hovered ? "\x1b[45m" : "\x1b[44m"}${text}\x1b[49m`,
		});
		// 四行正文包含两次needle，后面用于切1/2与2/2。
		tui.addChild(new Text("needle one\nmiddle\nneedle two\nend", 0, 0));
		// 启动TUI并接虚拟输入。
		tui.start();
		// 等待初始布局。
		await terminal.waitForRender();

		// Kitty码102是f，修饰参数6表示Ctrl+Shift，触发当前默认搜索快捷键；没有调用浏览器查找。
		terminal.sendInput("\x1b[102;6u");
		// 把整段needle作为一个输入块送进已聚焦的搜索栏，不是六次独立按键。
		terminal.sendInput("needle");
		// 等查询匹配与浮层合成。
		await terminal.waitForRender();
		// 保存首份视口，let允许后面重读覆盖。
		let viewport = terminal.getViewport();
		// 任一行应含1/2，确认初始当前匹配为第一个。
		assert.ok(viewport.some((line) => line.includes("1/2")));
		// 还应显示完整上/下导航提示，不只显示匹配计数。
		assert.ok(viewport.some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));

		// findIndex找同时含两个箭头的行，返回0起行索引，未找到为-1。
		let arrowRow = viewport.findIndex((line) => line.includes("↑") && line.includes("↓"));
		// 从该行最后一个Enter求下一条按钮内部列，缺行用-1；本例前缀均单列，字符串索引适用于所测坐标。
		let arrowColumn = viewport[arrowRow]?.lastIndexOf("Enter") ?? -1;
		// 先断言找到合法行列，避免负数加1后误把无效坐标当测试输入。
		assert.ok(arrowRow >= 0 && arrowColumn >= 0);
		// 记录悬停前事件总数，后面只审新写入，排除旧样式字符串误命中。
		const hoverEventCount = terminal.events.length;
		// 0起坐标各加1转SGR协议坐标，按钮码35模拟无按键指针移入下一条按钮。
		terminal.sendInput(`\x1b[<35;${arrowColumn + 1};${arrowRow + 1}M`);
		// 等待hover状态请求的重画。
		await terminal.waitForRender();
		// 要求悬停后的新记录里至少一次包含下一条按钮的品红背景样式。
		assert.ok(
			// 从当前事件数组开始读取，不修改记录。
			terminal.events
				// slice去掉悬停之前事件，建立时间范围。
				.slice(hoverEventCount)
				// some只看write分支并检查精确控制串，普通start/stop事件不能提供data。
				.some((event) => event.type === "write" && event.data.includes("\x1b[45m↓ Enter\x1b[49m")),
		);
		// 在同一按钮内部按左键，搜索导航在按下时即可执行，本例此处不再发送释放。
		terminal.sendInput(`\x1b[<0;${arrowColumn + 1};${arrowRow + 1}M`);
		// 等待下一条匹配被选中。
		await terminal.waitForRender();
		// 重新取屏幕快照，不继续用点击前的旧数组。
		viewport = terminal.getViewport();
		// 新画面应含2/2，确认下一条按钮真的改变当前匹配。
		assert.ok(viewport.some((line) => line.includes("2/2")));
		// 切到下一条后，搜索导航文案仍存在，排除点击误关闭搜索栏。
		assert.ok(viewport.some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));

		// 重新从最新视口找导航行，不能假定重画后其行号永远不变。
		arrowRow = viewport.findIndex((line) => line.includes("↑") && line.includes("↓"));
		// 找Shift+Enter起点再加3，选上一条按钮的文字内部；缺行先取-3再加3得到0，因此还要与arrowRow合法性共同检查。
		arrowColumn = (viewport[arrowRow]?.indexOf("Shift+Enter") ?? -3) + 3;
		// 这里只检查行列非负；若该行没有Shift+Enter，indexOf为-1、加3仍得2，所以此断言未独立排除找不到文字。后面的1/2计数才观察这次点击是否完成上一条导航。
		assert.ok(arrowRow >= 0 && arrowColumn >= 0);
		// 左键按在上一条按钮文字内，行列各加1转为协议坐标。
		terminal.sendInput(`\x1b[<0;${arrowColumn + 1};${arrowRow + 1}M`);
		// 等待返回上一匹配。
		await terminal.waitForRender();
		// 计数应回到1/2，不只检查悬停样式。
		assert.ok(terminal.getViewport().some((line) => line.includes("1/2")));
		// 导航提示仍在，说明搜索保持打开。
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));

		// 再次发送Ctrl+Shift+F，当前搜索已打开时作为切换关闭动作。
		terminal.sendInput("\x1b[102;6u");
		// 等待搜索浮层移除后的画面。
		await terminal.waitForRender();
		// 任一可见行都不应包含完整导航文案，本例以此观察关闭，不直接查询浮层栈内部。
		assert.ok(!terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));
		// 正常停止；本例没有finally保障失败后也停止。
		tui.stop();
	});

	// 防止正文中的画框字符误当搜索导航按钮：正文另画一个└底边，搜索保持1/2时点这条底边应仍1/2，不跳到2/2。实际依据布局命中区而非字符串长得像按钮。
	it("does not treat transcript box drawing as search navigation buttons", async () => {
		// 80列10行的虚拟终端，足够同时展示正文画框和搜索浮层。
		const terminal = new VirtualTerminal(80, 10);
		// 实际备用屏TUI，默认搜索导航样式。
		const tui = new TuiAltScreen(terminal);
		// 把下面一份纯文本正文加入默认文档。
		tui.addChild(
			// Text渲染这份人工画框，不是Box组件创建真正布局节点。
			new Text(
				// 数组逐行准备正文，末尾join用LF拼接；原字符串中的空格和框线属于测试输入，不在里面插注释。
				[
					// 第一条needle命中放在正文最前。
					"needle one",
					// 普通分隔行middle，不含搜索词。
					"middle",
					// 第二条needle命中，用于观察是否错误跳转。
					"needle two",
					// filler拉开命中与画框位置，不参与按钮判定。
					"filler",
					// 画框上边界仅是文字，不是搜索栏组件。
					"┌────────────────────────────────────────┐",
					// 画框中间行含显式空格，确保底边横向范围可用于点击。
					"│ box                                    │",
					// 画框底边以└开头，故意和真实搜索栏边框外观相近。
					"└────────────────────────────────────────┘",
					// 最后end行，保证画框后仍有普通正文。
					"end",
				].join("\n"),
				// Text横向padding0，让画框起始列与原文一致。
				0,
				// 纵向padding0，不在画框前后补额外行。
				0,
			),
		);
		// 启动TUI，在后续查询前先建立正常文档布局。
		tui.start();
		// 等待初始画面。
		await terminal.waitForRender();

		// Ctrl+Shift+F打开搜索栏。
		terminal.sendInput("\x1b[102;6u");
		// 一次输入needle，得到两次匹配。
		terminal.sendInput("needle");
		// 等搜索索引与浮层显示。
		await terminal.waitForRender();
		// 保存搜索打开后的纯文字视口。
		let viewport = terminal.getViewport();
		// 首先确认当前为1/2，避免后面保留状态断言没有起点。
		assert.ok(viewport.some((line) => line.includes("1/2")));
		// 同时明确没有2/2，区分计数文本在其他位置偶然出现。
		assert.ok(!viewport.some((line) => line.includes("2/2")));

		// 找视口里第一条以└开头的行，在当前布置中是正文画框底边；不是直接按搜索栏底边固定行号定位。
		const boxBottomRow = viewport.findIndex((line) => line.startsWith("└"));
		// 要求确实找到这一行，findIndex失败为-1。
		assert.ok(boxBottomRow >= 0);
		// 在该底边第24列按左键，行号转1起；只模拟输入，不在宿主移动鼠标。
		terminal.sendInput(`\x1b[<0;24;${boxBottomRow + 1}M`);
		// 等待这次点击的路由和重画。
		await terminal.waitForRender();

		// 重读视口，不能继续检查点击前数组。
		viewport = terminal.getViewport();
		// 仍看到1/2，当前匹配没有变化。
		assert.ok(viewport.some((line) => line.includes("1/2")));
		// 仍不应看到2/2，证明正文边框没有被误当下一条按钮。
		assert.ok(!viewport.some((line) => line.includes("2/2")));
		// 正常停止，本例没有finally包住上述输入与断言。
		tui.stop();
	});

	// 测试当前与非当前匹配都调用配置样式：当前needle用绿背景42、另一处用红41。检查原始write记录而不是无样式的getViewport文字，不证明真实终端色彩显示。
	it("uses configured styles for current and non-current search matches", async () => {
		// 记录型虚拟终端60列4行，同时观察两个匹配和搜索区域。
		const terminal = new RecordingTerminal(60, 4);
		// 构造TUI，保存下面两种字符串样式回调。
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			// 非当前匹配包SGR41红背景、末尾49恢复背景，不改搜索词文字。
			searchMatchStyle: (text) => `\x1b[41m${text}\x1b[49m`,
			// 当前匹配包SGR42绿背景，刻意和普通匹配不同。
			searchCurrentMatchStyle: (text) => `\x1b[42m${text}\x1b[49m`,
		});
		// 四行正文第一和第三行各含needle，共两条匹配。
		tui.addChild(new Text("needle first\nmiddle\nneedle second\nend", 0, 0));
		// 启动TUI并排首帧。
		tui.start();
		// 等初始文档布局完成。
		await terminal.waitForRender();

		// 发送默认搜索快捷键。
		terminal.sendInput("\x1b[102;6u");
		// 输入查询词needle。
		terminal.sendInput("needle");
		// 等待高亮后的渲染与xterm写队列。
		await terminal.waitForRender();

		// 先检查至少一次原始写入出现当前匹配样式。
		assert.ok(
			// some先判type为write再读data，寻找精确绿色needle控制串；只是字符串包含检查，不核整帧全部颜色状态。
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[42mneedle\x1b[49m")),
		);
		// 再独立检查非当前匹配样式，避免只处理当前项而漏其他命中。
		assert.ok(
			// 要求某次write含红色needle控制串。
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[41mneedle\x1b[49m")),
		);
		// 正常停止实例，前面失败不保证到此。
		tui.stop();
	});

	// 完整搜索焦点流程：编辑区初始聚焦，Ctrl+Shift+F接管needle输入、选择接近当前位置的第二条；允许正文滚动、快捷键循环结果，Escape关闭后x回到编辑区。检查输入数组和渲染文案，不调用真实编辑器或模型。
	it("searches the transcript with Ctrl+Shift+F and restores editor focus on close", async () => {
		// 建立60列8行记录型虚拟终端。
		const terminal = new RecordingTerminal(60, 8);
		// 创建实际TUI，下面以显式布局加模拟编辑器。
		const tui = new TuiAltScreen(terminal);
		// 保存文档Text，内容由12项数组回调生成。
		// 用LF拼成正文，并不把数组项直接当多个独立Text组件。
		const transcriptText = new Text(
			// Array.from回调接0起index，按两处特殊索引加入搜索词。
			Array.from({ length: 12 }, (_, index) => {
				// 索引4即第5行包含needle one。
				if (index === 4) return "line 5 needle one";
				// 索引9即第10行包含needle two，靠近初始文档末尾。
				if (index === 9) return "line 10 needle two";
				// 其他行只返回其1起编号。
				return `line ${index + 1}`;
			}).join("\n"),
			// 横向Text内边距0。
			0,
			// 纵向Text内边距0。
			0,
		);
		// 聊天主区跟末尾，打开搜索时初始位置靠近第二个匹配。
		const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
		// 字符串数组记录模拟编辑器实际收到的输入块，搜索词不应落入这里。
		const editorInputs: string[] = [];
		// 普通对象按结构满足组件/焦点能力，不声明class也可传给TUI。
		const editor = {
			// focused初始false，随后setFocus和搜索开关由TUI修改。
			focused: false,
			// render回调每次返回固定一行editor，没有真实文本编辑行为。
			render: () => ["editor"],
			// 失效回调为空，没有缓存可清，也不主动排帧。
			invalidate: () => {},
			// 输入回调只push原串，表达式返回数组新长度；TUI不使用这个返回值，不把它当是否消费输入的标志。
			handleInput: (data: string) => editorInputs.push(data),
		};
		// 设置聊天加一行编辑区的显式根。
		tui.setLayoutRoot(
			// 用VStack分配8行空间，聊天在上、编辑器在下。
			new VStack([
				// 聊天主区伸缩拿余量，basis0与grow1让它不按全文高度挤走编辑区。
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				// 编辑区basis1且shrink0请求保持一行；不对任意小终端作全局可见保证。
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		// 显式聚焦模拟编辑器，为后面关闭搜索后的恢复提供原目标。
		tui.setFocus(editor);
		// 启动TUI并连接虚拟输入。
		tui.start();
		// 等待初始跟末尾布局。
		await terminal.waitForRender();

		// 发送Ctrl+Shift+F将输入焦点临时交给搜索组件。
		terminal.sendInput("\x1b[102;6u");
		// 整段needle送给搜索输入，不经过模型或系统剪贴板。
		terminal.sendInput("needle");
		// 等待索引、定位和浮层重画。
		await terminal.waitForRender();
		// 搜索定位后主区不再动态跟末尾，允许用户读匹配位置。
		assert.strictEqual(transcript.isFollowingEnd, false);
		// 初始当前匹配应为2/2，不武断认为任何搜索都从第一个结果开始。
		assert.ok(terminal.getViewport().some((line) => line.includes("2/2")));
		// 搜索栏应显示完整导航文案。
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));
		// 正文视口应包含第二条line10 needle two，计数改变不能替代真实滚动定位。
		assert.ok(terminal.getViewport().some((line) => line.includes("line 10 needle two")));
		// 编辑器输入数组仍空，说明needle没有泄漏到原焦点组件。
		assert.deepStrictEqual(editorInputs, []);
		// 再检查默认当前匹配高亮原串。
		assert.ok(
			// 某次write应包含粗体加反色的needle，并在后面分别关闭；只检查生成控制码而不读取真实终端状态。
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[1;7mneedle\x1b[22;27m")),
		);

		// 在正文坐标第1列第4行连续六次上滚，每次输入同步；后面统一等待合并帧，而非要求每次都画一帧。
		for (let index = 0; index < 6; index++) terminal.sendInput("\x1b[<64;1;4M");
		// 等待滚动状态的最终画面。
		await terminal.waitForRender();
		// 六次上滚应达到文档顶部0。
		assert.strictEqual(transcript.scrollTop, 0);
		// 同一可见行仍包含搜索词和2/2状态，说明普通正文滚动没有自动切换当前匹配索引或关闭栏。
		assert.ok(terminal.getViewport().some((line) => line.includes("needle") && line.includes("2/2")));

		// 0x07是Ctrl+G，默认动作searchNext；当前在第二条时再下一条会循环到第一条，不应误注为上一条键。
		terminal.sendInput("\x07");
		// 等待循环到第一匹配的画面。
		await terminal.waitForRender();
		// 计数应变1/2。
		assert.ok(terminal.getViewport().some((line) => line.includes("1/2")));
		// 视口应出现line5 needle one，证明循环也完成正文定位。
		assert.ok(terminal.getViewport().some((line) => line.includes("line 5 needle one")));

		// 码103为g，修饰6为Ctrl+Shift，默认searchPrevious；从第一条向前循环回第二条。
		terminal.sendInput("\x1b[103;6u");
		// 等待上一条循环定位。
		await terminal.waitForRender();
		// 计数回到2/2。
		assert.ok(terminal.getViewport().some((line) => line.includes("2/2")));
		// 第二条匹配正文再次可见。
		assert.ok(terminal.getViewport().some((line) => line.includes("line 10 needle two")));

		// 孤立ESC关闭当前搜索浮层，虚拟输入直送完整块，不等待真实键盘缓冲超时。
		terminal.sendInput("\x1b");
		// 紧接着输入x，应交给恢复的编辑器焦点。
		terminal.sendInput("x");
		// 等待关闭搜索后的画面。
		await terminal.waitForRender();
		// 搜索导航文案应消失，以可见画面检查关闭结果。
		assert.ok(!terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));
		// 编辑器只收到x，没有搜索查询、导航键或Escape，证明该流程的焦点恢复和输入隔离。
		assert.deepStrictEqual(editorInputs, ["x"]);

		// 正常停止TUI，无finally保护前述失败路径。
		tui.stop();
	});

	// 自定义半页键绑定：10行视口半页5行，Ctrl+U从偏移20到15，Ctrl+D回20。临时替换共享管理器并在finally恢复，实际输入不是向shell发送控制命令。
	it("scrolls the transcript by half a page with custom bindings", async () => {
		// 保存当前共享管理器引用，而非只保存某几个字符串，供后面整体恢复。
		const originalKeybindings = getKeybindings();
		// 20列10行的内存终端，半页高度便于计算为5。
		const terminal = new VirtualTerminal(20, 10);
		// 构造TUI，按键处理时读取共享键位管理器。
		const tui = new TuiAltScreen(terminal);
		// 把新管理器安装为模块共享实例，不是只影响这个TUI局部字段。
		setKeybindings(
			// 以TUI动作定义创建管理器并给两项覆盖，其余动作仍按管理器默认规则保留。
			new KeybindingsManager(TUI_KEYBINDINGS, {
				// 将半页向上动作绑定到Ctrl+U。
				"tui.altScreen.halfPageUp": "ctrl+u",
				// 将半页向下动作绑定到Ctrl+D。
				"tui.altScreen.halfPageDown": "ctrl+d",
			}),
		);
		// try包住挂载、启动、输入与断言；finally按顺序stop再恢复管理器，若stop抛错仍可能跳过恢复。
		try {
			// 加入30行无padding正文，10行视口初始跟末尾。
			tui.addChild(new Text(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
			// 启动TUI后使用刚安装的自定义键位。
			tui.start();
			// 等待初始文档布局。
			await terminal.waitForRender();
			// 预期初始偏移20，即30减10。
			assert.strictEqual(tui.viewportTop, 20);

			// 0x15是Ctrl+U，测试自定义上半页动作，不是把输入转给真实shell。
			terminal.sendInput("\x15");
			// 等待上滚5行后的画面。
			await terminal.waitForRender();
			// 20减5等于15。
			assert.strictEqual(tui.viewportTop, 15);

			// 0x04是Ctrl+D，绑定为下半页，不结束测试进程输入流。
			terminal.sendInput("\x04");
			// 等待下滚结果。
			await terminal.waitForRender();
			// 检查下半页动作回到20；20也是底部最大偏移，这条边界断言本身不区分向下步长为5或更大。实际半页实现按floor(10/2)计算5行。
			assert.strictEqual(tui.viewportTop, 20);
			// 无论try是否成功都进入清理尝试，未捕获或吞掉原测试错误。
		} finally {
			// 先停止TUI，取消其普通渲染调度等。
			tui.stop();
			// 再把原共享管理器装回，防后续测试继承Ctrl+U/D覆盖。
			setKeybindings(originalKeybindings);
		}
	});

	// 自定义单行键绑定：Ctrl+Y从20上滚到19，Ctrl+E再回20；区分单行与前一个半页动作。恢复仍分停止和管理器两步，并非原子finally。
	it("scrolls the transcript by one line with custom bindings", async () => {
		// 保存当前管理器，可能不是最初默认值，恢复应回到调用前原对象。
		const originalKeybindings = getKeybindings();
		// 20列10行内存终端。
		const terminal = new VirtualTerminal(20, 10);
		// 创建真实备用屏TUI。
		const tui = new TuiAltScreen(terminal);
		// 替换进程内共享键位管理器。
		setKeybindings(
			// 按TUI动作定义创建新管理器，仅覆盖两项单行动作。
			new KeybindingsManager(TUI_KEYBINDINGS, {
				// 上滚一行绑定Ctrl+Y。
				"tui.altScreen.lineUp": "ctrl+y",
				// 下滚一行绑定Ctrl+E。
				"tui.altScreen.lineDown": "ctrl+e",
			}),
		);
		// 测试体进入try，确保后面正常或失败都尝试恢复。
		try {
			// 30行Text初始跟末尾，视口只有10行。
			tui.addChild(new Text(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
			// 启动并安排首帧。
			tui.start();
			// 等待首帧和虚拟写队列。
			await terminal.waitForRender();
			// 偏移应为20，作为单行移动起点。
			assert.strictEqual(tui.viewportTop, 20);

			// 0x19是Ctrl+Y，触发已配置的lineUp。
			terminal.sendInput("\x19");
			// 等待上滚后的视口。
			await terminal.waitForRender();
			// 20减1到19，而不是前个半页测试的15。
			assert.strictEqual(tui.viewportTop, 19);

			// 0x05是Ctrl+E，触发lineDown。
			terminal.sendInput("\x05");
			// 等待向下移动一行。
			await terminal.waitForRender();
			// 偏移回20，没超最大滚动范围。
			assert.strictEqual(tui.viewportTop, 20);
			// 结束try后执行恢复，即使中间断言抛错也尝试。
		} finally {
			// 先停当前TUI；没有另一个catch保证停失败后仍继续。
			tui.stop();
			// 把原管理器引用恢复到共享模块状态。
			setKeybindings(originalKeybindings);
		}
	});

	// 回归#10314：普通Home/End与Ctrl+PageUp/Down交焦点编辑器，Ctrl+Home/End交聊天；同时测试Kitty Ctrl+Home释放不重复滚动。只是输入路由测试，模拟编辑器只记数组不执行编辑操作。
	it("routes Home and End to the focused component and Ctrl+Home/End to the transcript", async () => {
		// 20列6行内存终端，最后1行留给模拟编辑器。
		const terminal = new VirtualTerminal(20, 6);
		// 实际TUI，默认键位表包含正文跳顶/跳底动作。
		const tui = new TuiAltScreen(terminal);
		// 创建聊天主滚动区。
		const transcript = new ScrollView(
			// 12行编号正文无内边距，5行聊天视口初始偏移为7。
			new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			// 聊天跟末尾并标primary。
			{ follow: "end", primary: true },
		);
		// 记录编辑器收到的原始控制串，顺序后面与输入列表精确比较。
		const editorInputs: string[] = [];
		// 结构化组件对象，无需继承Editor类就能接焦点。
		const editor = {
			// 焦点标记初始false。
			focused: false,
			// 固定渲染一行editor，不按输入改变文字。
			render: () => ["editor"],
			// 失效方法为空，满足组件契约。
			invalidate: () => {},
			// 输入回调push并返回数组长度，该返回值被TUI忽略；不是请求滚动的处理结果。
			handleInput: (data: string) => editorInputs.push(data),
		};
		// 设聊天加编辑器根布局。
		tui.setLayoutRoot(
			// VStack上下排列两区。
			new VStack([
				// 正文分余量并请求至少一行。
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				// 编辑器基础1行且不主动收缩，当前6行空间足够。
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		// 明确聚焦模拟编辑器，不靠addChild自动选焦点。
		tui.setFocus(editor);
		// 启动输入与渲染。
		tui.start();
		// 等布局后取得真实初始底部偏移。
		await terminal.waitForRender();

		// 保存当前scrollTop作为bottom，后面不用硬编码具体7也可检查回到同一底端。
		const bottom = transcript.scrollTop;
		// 先要求确实有正偏移，排除内容根本没溢出使滚动断言失去意义。
		assert.ok(bottom > 0);

		// #10314: unmodified Home/End belong to the editor in every UI mode.
		// 五个应给编辑器的序列：两种普通Home/End、Kitty Home，以及Ctrl+PageUp、Ctrl+PageDown；数组不全是无修饰键，不能笼统注成普通Home/End。
		const editorKeys = ["\x1bOH", "\x1b[F", "\x1b[57423u", "\x1b[5;5~", "\x1b[6;5~"];
		// 依次同步送五个原始输入块，不在每个键后等待一帧。
		for (const input of editorKeys) terminal.sendInput(input);
		// 统一等待本轮可能排定的渲染。
		await terminal.waitForRender();
		// 聊天偏移应没变，不能误消费这些键来滚文档。
		assert.strictEqual(transcript.scrollTop, bottom);
		// 编辑器收到的数组必须与五个输入一一同序，证明不是单纯把键丢弃。
		assert.deepStrictEqual(editorInputs, editorKeys);

		// CSI1;5H是Ctrl+Home，应由聊天跳到顶部。
		terminal.sendInput("\x1b[1;5H");
		// 等待聊天跳顶。
		await terminal.waitForRender();
		// 偏移为0。
		assert.strictEqual(transcript.scrollTop, 0);

		// CSI1;5F是Ctrl+End，应跳正文底部。
		terminal.sendInput("\x1b[1;5F");
		// 等待跳底。
		await terminal.waitForRender();
		// 回到保存的bottom偏移，而不改变文档内容。
		assert.strictEqual(transcript.scrollTop, bottom);
		// 到末尾后动态跟随应恢复true。
		assert.strictEqual(transcript.isFollowingEnd, true);

		// Kitty功能码57423加修饰5是Ctrl+Home按下，验证另一种编码。
		terminal.sendInput("\x1b[57423;5u");
		// 同键:3释放应被消费，不再次滚动或转交编辑器。
		terminal.sendInput("\x1b[57423;5:3u");
		// 等待这组事件后定位。
		await terminal.waitForRender();
		// 再次跳到0，说明Kitty编码也走正文动作。
		assert.strictEqual(transcript.scrollTop, 0);

		// 普通PageDown随后应滚聊天；5行聊天视口扣4行重叠，每次只前进1行。
		terminal.sendInput("\x1b[6~");
		// 等待分页后的布局。
		await terminal.waitForRender();
		// 偏移应为1，不误用整个6行屏幕当聊天视口来计算页量。
		assert.strictEqual(transcript.scrollTop, 1);
		// 编辑器输入仍只有最初五个，Ctrl+Home/End和普通PageDown都没有额外泄漏。
		assert.deepStrictEqual(editorInputs, editorKeys);

		// 正常结束停止TUI，无finally保护。
		tui.stop();
	});

	// 测试OSC133行首提示标记导航：四条消息各两行，3行窗口初始偏移5，Ctrl+Shift+上下依次跳偏移4、2、4再夹到5；Kitty释放不重复跳。测试的是组件文本内的标记，不是读取真实shell语义区。
	it("jumps between OSC 133 semantic prompt markers", async () => {
		// 20列3行的虚拟终端，8行文档无法同时放下。
		const terminal = new VirtualTerminal(20, 3);
		// 创建默认跟文档末尾的备用屏TUI。
		const tui = new TuiAltScreen(terminal);
		// 把带语义标记的文字组件加入默认文档。
		tui.addChild(
			// Text不执行OSC标记对应的shell动作，只把字符串交渲染路径。
			new Text(
				// 四个message编号各flatMap成标记标题和detail两行，再用LF连成8行；flatMap展开一层数组，标记仅放标题行首。
				[1, 2, 3, 4]
					.flatMap((message) => [`${OSC133_ZONE_START}message ${message}`, "detail"])
					.join("\n"),
				// Text横向padding0，标记保持行首。
				0,
				// 纵向padding0，不改变提示起点的行索引。
				0,
			),
		);
		// 启动并排首帧。
		tui.start();
		// 等文档高度与视口建立。
		await terminal.waitForRender();
		// 8行文档减3行视口得底部偏移5，第一条可见行当前是上一条消息的detail。
		assert.strictEqual(tui.viewportTop, 5);

		// Kitty57419为上箭头、修饰6为Ctrl+Shift，触发前一个语义提示标记跳转。
		terminal.sendInput("\x1b[57419;6u");
		// 同键:3释放，只应被消费，不重复跳过一个标记。
		terminal.sendInput("\x1b[57419;6:3u");
		// 等提示区导航后的画面。
		await terminal.waitForRender();
		// 先跳到偏移4，正是message3标题行。
		assert.strictEqual(tui.viewportTop, 4);
		// 屏幕第一行应是message3，OSC前缀不作为可见文本；可选链缺行会令断言失败。
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 3");

		// CSI1;6A为另一种Ctrl+Shift+Up编码，应继续使用相同语义导航动作。
		terminal.sendInput("\x1b[1;6A");
		// 等待再向前跳。
		await terminal.waitForRender();
		// 偏移2对应message2。
		assert.strictEqual(tui.viewportTop, 2);
		// 第一可见行应为message2标题，不是仅把数字偏移改掉。
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 2");

		// Kitty57420加修饰6为Ctrl+Shift+Down，向后一个提示标记导航。
		terminal.sendInput("\x1b[57420;6u");
		// 对应释放不再重复执行。
		terminal.sendInput("\x1b[57420;6:3u");
		// 等向后跳转。
		await terminal.waitForRender();
		// 偏移回到4。
		assert.strictEqual(tui.viewportTop, 4);
		// 第一行再次是message3。
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 3");

		// CSI1;6B为另一种Ctrl+Shift+Down编码，目标message4原文在偏移6。
		terminal.sendInput("\x1b[1;6B");
		// 等跳转并按最大范围夹取。
		await terminal.waitForRender();
		// 最大偏移只有5，所以夹到5而非把文档滚到6造成底部空行。
		assert.strictEqual(tui.viewportTop, 5);
		// message4应出现在视口索引1即第二行，体现夹值后标题不必总在首行。
		assert.strictEqual(terminal.getViewport()[1]?.trimEnd(), "message 4");
		// 抵达末端恢复动态跟随输出。
		assert.strictEqual(tui.isFollowingOutput, true);

		// 正常停止实例，没有finally包住本例。
		tui.stop();
	});

	// 模拟iTerm2能力后，普通Image在备用屏应文字回退，输出与停止重放都不出现Kitty、iTerm2图报文或行首OSC133区标记。仅检查内存记录，不需要真实iTerm2或有效PNG。finally只重置能力缓存，TUI停止位于正常路径。
	it("does not emit Kitty graphics commands or OSC 133 zones in iTerm2", async () => {
		// 直接把共享能力缓存设为iTerm2、真彩和超链接，覆盖自动探测结果；setCapabilities保存对象引用，不模拟硬件握手。
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		// try包住构造、启动与断言，finally负责把能力缓存清空，不是恢复修改前的原对象。
		try {
			// 20列3行记录型虚拟终端，后面所有控制码断言来自它的events。
			const terminal = new RecordingTerminal(20, 3);
			// 构造实际TUI，start时iTerm2分支会临时禁止正常Image协议输出。
			const tui = new TuiAltScreen(terminal);
			// 加入自定义组件，直接给一行带多个OSC133前缀的文本。
			tui.addChild({
				// render每次返回同样一行B、C、A标记再接content，检验连续行首标记清理；没有真正执行shell提示或命令区状态。
				render: () => ["\x1b]133;B\x07\x1b]133;C\x07\x1b]133;A\x07content"],
				// 失效回调为空，保持这个固定输入不变。
				invalidate: () => {},
			});
			// 再加入真实Image组件，区别于上一项手工构造字符串。
			tui.addChild(
				// Image接受base64文字、MIME、主题、选项及预先提供的尺寸，构造并不访问图片路径。
				new Image(
					// AAAA只是测试载荷，不是本例已验证可解码的PNG；依赖显式尺寸避免由图片内容推断几何。
					"AAAA",
					// MIME指定image/png，仅用于组件协议/回退路径，不验证载荷真是PNG。
					"image/png",
					// 回退文字颜色函数原样返回，使屏幕内容断言不依赖额外颜色。
					{ fallbackColor: (value) => value },
					// filename只是供回退说明显示example.png，不打开本地文件。
					{ filename: "example.png" },
					// 显式像素尺寸10×10供布局使用，与20×3终端格不是同一单位。
					{ widthPx: 10, heightPx: 10 },
				),
			);
			// 真正启动iTerm2分支，临时关闭普通图像生成并写模式码到内存终端。
			tui.start();
			// 等首帧与xterm解析。
			await terminal.waitForRender();
			// 先正常stop并重放文档，再检查全部记录，所以断言范围包含启停写入；前面异常仍可能跳过这行。
			tui.stop();
			// every要求任何write都没有Kitty图形前缀，不是实际解码一个Kitty包。
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b_G")));
			// 所有记录写入都不应残留OSC133前缀；这份样本标记都在可剥除的行首，不能证明任意行中标记也被清掉。
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]133;")));
			// 同时没有iTerm2 File图像报文，说明全屏时不是简单改发另一种图片协议。
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]1337;File=")));
			// 至少一次写入应含Image文字回退提示，排除完全没输出图片相关内容也能通过三个否定断言。
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("[Image:")));
			// 最终清缓存，但没有在这里补停一个前面失败时仍活动的TUI。
		} finally {
			// 仅清cachedCapabilities供下次重新探测，不清图片元数据或程序覆盖。
			resetCapabilitiesCache();
		}
	});

	// 模拟手工预编码iTerm2图像离开视口时应发清屏重画。它不同于前例Image自动回退：这里直接render原始图报文，因此能检查旧放置清理分支；不证明真实iTerm2图像实际清掉。
	it("clears stale iTerm2 image placements when they leave the viewport", async () => {
		// 为这例重新设置iTerm2能力缓存。
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		// finally仍只负责清能力缓存，正常stop在try尾部。
		try {
			// 20列3行记录型虚拟终端。
			const terminal = new RecordingTerminal(20, 3);
			// 构造TUI，启动会保存原图像协议。
			const tui = new TuiAltScreen(terminal);
			// 直接准备iTerm2内联图控制串，载荷AAAA与格宽2只是协议文本，不要求本机显示图片。
			const imageLine = "\x1b]1337;File=inline=1;width=2;height=auto:AAAA\x07";
			// 自定义组件返回图锚点、两行占位与三行普通文字。
			tui.addChild({
				// 固定六行文档，初始跟末尾时图在屏外，后面先跳顶让它进入视口。
				render: () => [imageLine, "", "", "after", "more", "end"],
				// 无操作失效回调，没有组件内部缓存。
				invalidate: () => {},
			});
			// 启动输入与备用屏状态。
			tui.start();
			// 等初始末尾画面。
			await terminal.waitForRender();
			// 显式跳文档顶部，使图锚点可见。
			tui.scrollToTop();
			// 等跳顶后的图像帧。
			await terminal.waitForRender();
			// 记录这帧之后的事件起点，后续不把首帧已有清屏码当新清理证据。
			const eventCount = terminal.events.length;

			// 向下滚1行，使图锚点从可见顶部移走。
			tui.scrollBy(1);
			// 等待重画。
			await terminal.waitForRender();
			// 要求新事件里至少一次请求清可见屏。
			// slice限定跳顶后的记录，some只查write中的CSI2J；只证明发送清屏请求，不验证系统图像资源是否释放。
			assert.ok(
				terminal.events.slice(eventCount).some((event) => event.type === "write" && event.data.includes("\x1b[2J")),
			);
			// 正常停止TUI，默认重放完整逻辑文档仍只交虚拟终端。
			tui.stop();
			// 退出try后清共享能力缓存。
		} finally {
			// 下次能力获取重新按环境/程序覆盖推测，不恢复本例开始前的对象。
			resetCapabilitiesCache();
		}
	});

	// 测试3格高、100像素高的Kitty图上部两行在屏外时，只传可见底部：原像素y66、高34，终端占1行。直接生成协议并登记几何，不验证图像载荷或真实终端裁剪。
	it("crops a Kitty image whose first line is above the viewport", async () => {
		// 20列3行的记录型内存终端。
		const terminal = new RecordingTerminal(20, 3);
		// 默认TUI；本例没有直接setCapabilities，测试手工构造图报文的布局裁剪路径。
		const tui = new TuiAltScreen(terminal);
		// 固定图片ID123，在元数据和报文中保持一致。
		const imageId = 123;
		// 生成2列3行图报文；moveCursor:false编码成C=1，要求终端禁止放置后的默认光标移动，编码器本身始终不附移动CSI。调用只返回字符串，不直接上传。
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		// 登记相同ID的终端格2×3与像素100×100供裁剪计算，元数据不是从AAAA解码得来。
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		// 加入固定六行组件，让图片锚点位于文档索引1。
		tui.addChild({
			// before、图锚点、两占位、after、end共六行；初始跟末尾偏移3，所以只有图片覆盖的最后一行可见。
			render: () => ["before", imageLine, "", "", "after", "end"],
			// 无缓存失效操作，不改变这组图像输入。
			invalidate: () => {},
		});
		// 启动TUI并绘制。
		tui.start();
		// 等待裁剪图像控制串被记录与解析。
		await terminal.waitForRender();

		// 检查视口顶部偏移3，为像素裁剪范围提供前置几何条件。
		assert.strictEqual(tui.viewportTop, 3);
		// 检查输出中是否出现指定ID与裁剪参数。
		assert.ok(
			// 遍历全部记录寻找一次满足条件的write。
			terminal.events.some(
				// i123关联此图，y66跳过约三分之二源像素、h34保留底部、r1占一终端行；两个includes只约束同一write含这些片段，不是完整协议解析验证。
				(event) => event.type === "write" && event.data.includes("i=123") && event.data.includes("y=66,h=34,r=1"),
			),
		);

		// 正常停止；本例不额外清理全局Kitty元数据注册表。
		tui.stop();
	});

	// 同样检验顶部裁剪，但图被横向padding1、蓝背景Box包住，避免布局包装或ANSI样式妨碍发现图锚点。预期仍是y66/h34/r1，不把padding当源像素。
	it("crops a Kitty image in a padded, colored box whose first line is above the viewport", async () => {
		// 20列3行记录型虚拟终端。
		const terminal = new RecordingTerminal(20, 3);
		// 构造真实TUI，后面用普通addChild文档结构。
		const tui = new TuiAltScreen(terminal);
		// 图片ID11271对应回归相关编号，但这里仅作为协议/元数据关联键。
		const imageId = 11271;
		// 生成2列3行Kitty图报文，moveCursor:false加入C=1，请求终端禁止放置后的默认光标移动；不是移除编码器附加的CSI。
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		// 登记100×100像素几何，不能把这个登记动作说成读取实际PNG尺寸。
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		// Box横向padding1、纵向0，样式回调包蓝背景44再恢复49；string参数注解只约束开发期。
		const box = new Box(1, 0, (text: string) => `\x1b[44m${text}\x1b[49m`);
		// Box内部三行是图锚点加两占位，render固定返回新数组、invalidate为空，padding由Box实际渲染加入。
		box.addChild({ render: () => [imageLine, "", ""], invalidate: () => {} });
		// 前置单行before组件，将图锚点在整个文档中推到索引1。
		tui.addChild({ render: () => ["before"], invalidate: () => {} });
		// 加入已经包好图像的Box，不复制其内部孩子。
		tui.addChild(box);
		// 后置after/end两行，整份文档六行。
		tui.addChild({ render: () => ["after", "end"], invalidate: () => {} });
		// 启动并排首帧。
		tui.start();
		// 等带背景与padding的图裁剪结果。
		await terminal.waitForRender();

		// 初始偏移仍3，和未包装样本保持相同可见底部。
		assert.strictEqual(tui.viewportTop, 3);
		// 检查记录中该图的裁剪参数。
		assert.ok(
			// some允许任意一次write满足，不要求记录数组只有一项。
			terminal.events.some(
				// 同一write应含图片ID11271和y66/h34/r1；只证明这份包装样本生成了预期报文字段。
				(event) => event.type === "write" && event.data.includes("i=11271") && event.data.includes("y=66,h=34,r=1"),
			),
		);

		// 正常停止TUI，失效/裁剪异常不由本例finally捕获。
		tui.stop();
	});

	// 回归#11271：图占位行里有旁栏文字时，不能因它不是空行就停止向上找屏外图锚点。仍应裁出100像素图的最后34像素、占一行；不要求占位行的文字被当图像数据。
	it("crops a Kitty image whose placeholder rows contain text when its first line is above the viewport", async () => {
		// Regression test for #11271: borders or side-by-side text on placeholder rows stopped the search.
		// 20列3行记录型虚拟终端。
		const terminal = new RecordingTerminal(20, 3);
		// 构造实际备用屏。
		const tui = new TuiAltScreen(terminal);
		// 给本样本独立ID11272，与前面的包装样本分开。
		const imageId = 11272;
		// 生成2列3行图报文，moveCursor:false加入C=1，要求终端禁止放置后的默认光标移动；调用不直接移动或写终端。
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		// 登记源像素100×100供相同裁剪公式使用。
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		// 文档先before和图锚点，后两个占位行写入旁栏文字；固定render与空invalidate仅是数据替身。
		tui.addChild({ render: () => ["before", imageLine, "   | side", "   | side"], invalidate: () => {} });
		// 再加after/end两行，让文档总高6、初始视口从3起。
		tui.addChild({ render: () => ["after", "end"], invalidate: () => {} });
		// 启动并进行实际布局/裁剪。
		tui.start();
		// 等待首帧。
		await terminal.waitForRender();

		// 先确认偏移3，图片头确实在上方屏外。
		assert.strictEqual(tui.viewportTop, 3);
		// 再查裁剪结果，不仅检查文档能显示。
		assert.ok(
			// 对全部记录找满足条件的write。
			terminal.events.some(
				// 本图ID与y66/h34/r1应同处一次write，表示含旁栏的占位行没有破坏这次锚点查找。
				(event) => event.type === "write" && event.data.includes("i=11272") && event.data.includes("y=66,h=34,r=1"),
			),
		);

		// 正常结束停止；全局元数据没有在这里重置。
		tui.stop();
	});

	// 回归#10319：模拟WezTerm，图锚点不变但覆盖行文字变化时，先清放置、写文字、再仅发placement重放，避免覆盖文字擦掉图。检查控制串及索引关系，不运行真正WezTerm。
	it("redraws WezTerm Kitty images after writes to covered rows", async () => {
		// Regression test for #10319: a scrollbar update below an unchanged image anchor erased its cells.
		// 保存原WEZTERM_PANE，区分缺失与空字符串。
		const weztermPane = process.env.WEZTERM_PANE;
		// tui联合undefined让finally在构造尚未完成时也能安全跳过stop；这只是可选实例引用，不是已启动标记。
		let tui: TuiAltScreen | undefined;
		// 临时设环境信号1触发WezTerm相关输出分支，不启动或连接WezTerm进程。
		process.env.WEZTERM_PANE = "1";
		// 显式设置Kitty能力，避免本例依赖自动品牌探测结果。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// try内开始建终端，finally按顺序停TUI、清能力、恢复环境；各步不是原子事务。
		try {
			// 20列4行的记录型虚拟终端。
			const terminal = new RecordingTerminal(20, 4);
			// 图片ID10319给这个回归样本唯一关联键。
			const imageId = 10319;
			// 生成2列3行Kitty图报文，moveCursor:false加入C=1，要求终端禁止放置后的默认光标移动；函数仅返回字符串。
			const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
			// 登记100×100源像素和2×3格放置范围。
			registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
			// let coveredLine初始空，后面重赋并由render闭包读取最新值，不在构造时复制快照。
			let coveredLine = "";
			// 实际构造TUI后把实例保存到外层可选引用，供finally使用。
			tui = new TuiAltScreen(terminal);
			// 显式根为自定义四行组件，图在第一行覆盖前三行。
			tui.setLayoutRoot({
				// 每帧返回图锚点、当前coveredLine、空占位与after；改变第二行应触发覆盖图区域的文字重画。
				render: () => [imageLine, coveredLine, "", "after"],
				// invalidate为空，render直接读外部变量，不需要额外缓存失效。
				invalidate: () => {},
			});
			// 启动并建立初次图像上传状态。
			tui.start();
			// 等待首帧。
			await terminal.waitForRender();
			// 记录后续重画事件起点，不把首次完整上传算进重用结果。
			const eventCount = terminal.events.length;

			// 只改覆盖区第二行文字，imageLine本身保持完全相同。
			coveredLine = "changed";
			// 请求渲染器检测这次文字变化。
			tui.requestRender();
			// 等待图和文字重画记录完成。
			await terminal.waitForRender();
			// 拼接起点之后所有write的数据，以比较多个写入片段里的先后关系。
			const redrawWrites = terminal.events
				// slice只取修改coveredLine后的新事件。
				.slice(eventCount)
				// filter的类型谓词把后续元素缩窄为write事件，运行时按type判断。
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				// map取每次write原串。
				.map((event) => event.data)
				// join空分隔保留字符顺序，但不再保留各次write的边界。
				.join("");
			// 找Kitty仅放置命令a=p的0起索引，未找到为-1。
			const placementIndex = redrawWrites.indexOf("\x1b_Ga=p,q=2");
			// 要求新输出请求删除全部放置d=a，保留图数据用于后续placement，而不是一律重新传载荷。
			assert.ok(redrawWrites.includes("\x1b_Ga=d,d=a,q=2\x1b\\"));
			// 比较placement索引在changed索引之后；indexOf缺失返回-1，这条本身没有独立断言changed确实存在，故不能夸大成完整输出顺序证明。
			assert.ok(placementIndex > redrawWrites.indexOf("changed"));
			// 要求新输出不包含a=T完整上传，验证该样本重用已上传图数据。
			assert.ok(!redrawWrites.includes("\x1b_Ga=T"));
			// finally执行收尾，原断言错误不会被这里自动吞掉。
		} finally {
			// 有实例才stop，可选链跳过undefined；若stop抛错后面的恢复仍可能不执行。
			tui?.stop();
			// 清能力缓存，不清图元数据注册表。
			resetCapabilitiesCache();
			// 原WEZTERM_PANE未定义则delete，避免赋成文字undefined。
			if (weztermPane === undefined) delete process.env.WEZTERM_PANE;
			// 原值存在则还原原字符串。
			else process.env.WEZTERM_PANE = weztermPane;
		}
	});

	// 检验图像位置变化后的placement重用不丢横向兄弟文字：页头从一行增两行使图下移，同时左标签改changed。新写入不得再含a=T、长度小于2000码元，最终文字仍可见；不是完整图片解码或真实终端吞吐基准。
	it("reuses moved Kitty images without dropping HStack siblings", async () => {
		// 强制共享能力为Kitty，真彩与超链接也启用。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// finally只清能力，正常stop仍在try末尾。
		try {
			// 20列6行记录型虚拟终端。
			const terminal = new RecordingTerminal(20, 6);
			// 构造实际备用屏TUI。
			const tui = new TuiAltScreen(terminal);
			// 左侧Text标签初始left，保存引用供稍后修改。
			const label = new Text("left", 0, 0);
			// 创建真实Image组件，参数下面逐项给出。
			const image = new Image(
				// A重复8192构造较大的假base64载荷，使意外完整重传容易超过后面的长度阈值；不是8192字节的有效PNG验证。
				"A".repeat(8192),
				// 图片MIME设PNG，组件不在这行校验文件内容。
				"image/png",
				// 文字回退样式为恒等回调。
				{ fallbackColor: (value) => value },
				// 空选项对象沿用Image默认布局限制，不指定文件名或图片ID。
				{},
				// 显式源像素100×100，让组件无需从假载荷解析尺寸。
				{ widthPx: 100, heightPx: 100 },
			);
			// 页头Text初始一行header，后面增长会改变下面图像行位置。
			const header = new Text("header", 0, 0);
			// HStack左右放标签和图，测试位置重用不能丢同一行的文本兄弟。
			const row = new HStack([
				// 标签基础宽10列。
				{ component: label, basis: 10 },
				// 图片区域基础宽10列，与标签合占20列。
				{ component: image, basis: 10 },
			]);
			// 把页头和横向行安装为显式根。
			tui.setLayoutRoot(
				// VStack先页头、后包含图的横向行。
				new VStack([
					// 页头basis:auto按内容行数，后面变两行会推移下面区域。
					{ component: header, basis: "auto" },
					// 横向图片区基础高度4行；组件内部图的实际格数仍按Image布局计算。
					{ component: row, basis: 4 },
				]),
			);
			// 启动，建立初次上传及放置缓存。
			tui.start();
			// 等待首次渲染完成。
			await terminal.waitForRender();
			// 先确认有a=T完整传输，避免后面无完整重传只是从未上传任何图而造成空通过。
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b_Ga=T")));

			// 保存新一轮重画记录的起点。
			const eventCount = terminal.events.length;
			// 左标签由left改changed，检验图片重放不遮掉它。
			label.setText("changed");
			// 页头增加second一行，让图像位置实际下移。
			header.setText("header\nsecond");
			// 显式请求根重新布局与绘制。
			tui.requestRender();
			// 等图位置变化后的输出。
			await terminal.waitForRender();
			// 收集此次更新之后的控制串。
			const redrawWrites = terminal.events
				// 跳过首次上传等旧事件。
				.slice(eventCount)
				// 类型谓词只保留write，后续可安全按类型读取data。
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				// 提取每段write数据。
				.map((event) => event.data)
				// 无分隔拼接，便于同一连续串比较索引。
				.join("");
			// 寻找仅放置a=p的索引。
			const placementIndex = redrawWrites.indexOf("\x1b_Ga=p,q=2");
			// 应请求删旧放置d=a，保留图数据，准备在新位置重放。
			assert.ok(redrawWrites.includes("\x1b_Ga=d,d=a,q=2\x1b\\"));
			// 比较放置在changed出现位置之后；与前例一样，单个indexOf比较并不独立证明两个片段都存在，下面另有最终屏幕文字断言。
			assert.ok(placementIndex > redrawWrites.indexOf("changed"));
			// 新写入不应再次出现完整图载荷传输a=T。
			assert.ok(!redrawWrites.includes("\x1b_Ga=T"));
			// 额外要求新串length小于2000，length实际为UTF-16码元，原错误信息叫bytes也未在此UTF-8编码；这是固定样本阈值，不是普遍协议开销上限。
			assert.ok(redrawWrites.length < 2000, `expected placement-only redraw, got ${redrawWrites.length} bytes`);
			// 最终视口应有去末尾空白后恰为changed的一行，确认横向兄弟文字没有丢失。
			assert.ok(terminal.getViewport().some((line) => line.trimEnd() === "changed"));
			// 正常停止TUI，本例失败时finally不补跑stop。
			tui.stop();
			// 无论try结果如何，进入能力缓存清理。
		} finally {
			// 清缓存让后续能力访问重探测，不恢复之前缓存对象或清图片元数据。
			resetCapabilitiesCache();
		}
	});

	// 测试最近离屏图仍能从已上传数据仅放置重用：一行视口先看图、滚到after再滚回来，要求a=p、不再a=T，也不删除这个图ID的数据。不验证真实终端是否确实保留载荷。
	it("retains recently offscreen Kitty images for placement-only reuse", async () => {
		// 为此例强制Kitty能力。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// try/finally仅统一清能力缓存，TUI停止仍在正常路径。
		try {
			// 20列1行内存终端，每次只看一行，方便制造图完全离屏再进入。
			const terminal = new RecordingTerminal(20, 1);
			// 构造实际备用屏TUI，本实例的已上传图缓存初始为空。
			const tui = new TuiAltScreen(terminal);
			// 固定图ID321作为元数据与传输的关联。
			const imageId = 321;
			// 生成2列1行Kitty图，moveCursor:false加入C=1，要求终端禁止放置后的默认光标移动；字符串本身不写到任何终端。
			const imageLine = encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			// 登记100×50像素与2×1格几何，并产生新传输代次；不从AAAA载荷解码。
			registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
			// 把下一项ScrollView设置为显式根，以便先从文档顶看图。
			tui.setLayoutRoot(
				// 显式ScrollView默认不跟末尾，区别于TUI内部默认follow:end的隐式区。
				new ScrollView(
					// 被滚动内容用普通结构化组件对象提供。
					{
						// render每次给图锚点和after两行；1行视口一次只能看其中一个。
						render: () => [imageLine, "after"],
						// invalidate空实现，图原串保持不变。
						invalidate: () => {},
					},
					// 标primary，TUI公开scrollBy应操作这个主区。
					{ primary: true },
				),
			);
			// 启动并绘制位于文档顶的图片。
			tui.start();
			// 等首帧建立上传记录。
			await terminal.waitForRender();
			// 先要求某次write含a=T完整传输，排除从未上传的空通过。
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b_Ga=T")));

			// 记录离屏/回屏操作之前的事件起点。
			const eventCount = terminal.events.length;
			// 向下滚一行，图片离开1行视口。
			tui.scrollBy(1);
			// 等待离屏帧完成，给缓存管理机会。
			await terminal.waitForRender();
			// 上滚一行，让同ID同代次图再次可见。
			tui.scrollBy(-1);
			// 等待重新进入的画面。
			await terminal.waitForRender();
			// 收集离屏与回屏整个阶段的所有write，范围包含中间离屏帧而不只最后一帧。
			const reentryWrites = terminal.events
				// slice跳过首次上传等旧事件。
				.slice(eventCount)
				// 类型谓词过滤为write分支。
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				// 提取原data控制串。
				.map((event) => event.data)
				// 无分隔拼接，保持字符先后顺序。
				.join("");
			// 新阶段应出现a=p仅放置请求。
			assert.ok(reentryWrites.includes("\x1b_Ga=p,q=2"));
			// 不得再次包含a=T完整载荷上传。
			assert.ok(!reentryWrites.includes("\x1b_Ga=T"));
			// 不得出现释放ID321图像数据的d=I删除命令；这和删除所有放置但保留载荷是不同协议动作。
			assert.ok(!reentryWrites.includes(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`));
			// 正常stop才退出；失败时finally只做下一条能力缓存清理。
			tui.stop();
			// finally对能力缓存进行收尾，不实现每个产品对象的统一清理。
		} finally {
			// 清能力缓存，让后续重新探测，不清全局Kitty元数据。
			resetCapabilitiesCache();
		}
	});

	// 测试本实例屏外图数量配额：1行窗口依次看18张图，超过允许保留16张屏外图时最早图片应被释放，回顶需要再次完整上传。图元数据共享注册表与本实例已上传缓存不是同一张表。
	it("evicts the least recently visible Kitty image when the cache is full", async () => {
		// 强制Kitty能力，避免依赖实际图形终端。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// try/finally为能力缓存兜底，正常stop在try尾部。
		try {
			// 20列1行内存屏，便于每滚一行只让一张图片可见。
			const terminal = new RecordingTerminal(20, 1);
			// 创建缓存初始为空的TUI实例。
			const tui = new TuiAltScreen(terminal);
			// 首图ID500，后面按索引连续分配到517。
			const firstImageId = 500;
			// Array.from同步生成18条图报文；回调创建元数据并返回相应字符串，不执行18个独立测试。
			const imageLines = Array.from({ length: 18 }, (_, index) => {
				// 当前ID等于首ID加0起索引，保证各图不重名。
				const imageId = firstImageId + index;
				// 每张都登记小图100×50像素、2列1行，使本例主要触及数量配额而不是64MiB解码估算配额。
				registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
				// 用AAAA生成对应ID的2×1格报文，moveCursor:false加入C=1请求终端禁止默认放置光标移动；不校验载荷的PNG内容。
				return encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			});
			// 把全部图行包装成主滚动文档。
			tui.setLayoutRoot(
				// 显式ScrollView缺省不跟末尾，所以首先看到ID500。
				new ScrollView(
					// 组件对象只负责返回下面的完整数组。
					{
						// render直接返回imageLines原数组，没有复制、按宽重排或异步读取。
						render: () => imageLines,
						// 无操作失效回调，报文原值不变。
						invalidate: () => {},
					},
					// primary供TUI公开滚动方法定位主区。
					{ primary: true },
				),
			);
			// 启动，首先传首张图。
			tui.start();
			// 等初始一行画面建立。
			await terminal.waitForRender();
			// 从索引1到17逐次向下滚一行，遍历全部18张图片；每次await让每张真正经历一帧，而不是合并成一次跳17行。
			for (let index = 1; index < imageLines.length; index++) {
				// 下一张图进入视口，上一张转为屏外缓存候选。
				tui.scrollBy(1);
				// 等待这张图的传输/放置字符串被记录。
				await terminal.waitForRender();
			}
			// 要求整个滚动记录曾发释放最早图数据的请求。
			assert.ok(
				// some遍历write事件找删除证据，不读取内部缓存Map。
				terminal.events.some(
					// d=I加首ID500表示释放该图数据，q2安静请求；只证明生成控制串，不证明真实终端已释放资源。
					(event) => event.type === "write" && event.data.includes(`\x1b_Ga=d,d=I,i=${firstImageId},q=2\x1b\\`),
				),
			);

			// 记录回顶前事件起点，区分旧的第一次上传与重进时的新上传。
			const eventCount = terminal.events.length;
			// 跳回文档首行，使被淘汰图重新可见。
			tui.scrollToTop();
			// 等待回顶帧。
			await terminal.waitForRender();
			// 取回顶后的新写入数据。
			const reentryWrites = terminal.events
				// 只保留起点之后事件。
				.slice(eventCount)
				// 过滤write并用类型谓词使data可访问。
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				// 映射为控制串数组。
				.map((event) => event.data)
				// 用空分隔拼接。
				.join("");
			// 要求出现a=T，证明首图已不能仅靠旧载荷放置复用；这里不额外解析上传命令是否仅有一个图。
			assert.ok(reentryWrites.includes("\x1b_Ga=T"));
			// 正常停止TUI；如果此前失败，finally不自动补stop。
			tui.stop();
			// 能力恢复收尾阶段。
		} finally {
			// 清共享能力缓存，不重置已登记18张元数据。
			resetCapabilitiesCache();
		}
	});

	// 测试屏外图解码内存估算配额：4张3840×2160图，每张按RGBA4字节约31.6MiB，三张屏外估算超过64MiB时首图应被淘汰。只是声明尺寸触发估算，不实际解码或分配四张4K图片。
	it("evicts offscreen Kitty images when decoded raster memory exceeds the cache quota", async () => {
		// 强制Kitty能力，控制测试路径。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// try/finally只负责能力缓存，正常TUI stop仍在断言后。
		try {
			// 1行视口只显示一张图，使其余已见图计入屏外配额。
			const terminal = new RecordingTerminal(20, 1);
			// 创建新的TUI缓存，与前个数量配额用例实例分开。
			const tui = new TuiAltScreen(terminal);
			// 首图ID600，后面四张连续分配。
			const firstImageId = 600;
			// 创建4条图报文，少于数量配额阈值，用于区分内存估值预算分支。
			const imageLines = Array.from({ length: 4 }, (_, index) => {
				// 本轮图ID600加索引。
				const imageId = firstImageId + index;
				// 每张登记3840×2160源像素，但终端只放2列1行；缓存估算必须看源像素，不能只按屏幕格数。
				registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 3840, heightPx: 2160 });
				// 实际载荷仍是短AAAA，moveCursor:false加入C=1请求终端禁止默认放置光标移动；本例不解码大图或校验声明尺寸与载荷是否一致。
				return encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			});
			// 把这四行图装入主滚动文档。
			tui.setLayoutRoot(
				// 显式ScrollView从顶部开始。
				new ScrollView(
					// 普通组件对象提供固定图行。
					{
						// render返回imageLines原引用，源数据不随帧变化。
						render: () => imageLines,
						// invalidate为空，无额外缓存操作。
						invalidate: () => {},
					},
					// 标为primary，公开scrollBy操作此区。
					{ primary: true },
				),
			);
			// 启动首图帧。
			tui.start();
			// 等待第一次上传记录。
			await terminal.waitForRender();
			// 依次滚过余下3张，每张之间等待一帧，使最早三张都进入屏外集合。
			for (let index = 1; index < imageLines.length; index++) {
				// 每次下滚一行，下一张成为唯一可见图。
				tui.scrollBy(1);
				// 等该次缓存预算计算与输出完成。
				await terminal.waitForRender();
			}
			// 检查首图被释放的协议请求。
			assert.ok(
				// some只要找到一次对应write即可。
				terminal.events.some(
					// 删除首ID600的数据表示估算配额生效；不检查所有剩余图的淘汰顺序，也不实测进程RSS。
					(event) => event.type === "write" && event.data.includes(`\x1b_Ga=d,d=I,i=${firstImageId},q=2\x1b\\`),
				),
			);
			// 正常停止实例。
			tui.stop();
			// 最终进入能力缓存收尾。
		} finally {
			// 清能力缓存，不清图ID登记表或证明真实显存释放。
			resetCapabilitiesCache();
		}
	});

	// 链接点击流程：支持OSC8的ST与BEL终止形式、普通与通用释放码、宽emoji内任一格命中；拖动选择不应打开URL。openUrl只push数组，不启动浏览器或访问example.com。
	it("opens an OSC 8 hyperlink with specific or generic release codes, but not on drag", async () => {
		// 20列3行记录型虚拟终端，每行放一种链接。
		const terminal = new RecordingTerminal(20, 3);
		// 字符串数组记录回调实际收到的URL，顺序代表点击顺序。
		const openedUrls: string[] = [];
		// 创建TUI并注入自定义打开链接回调。
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			// 回调只把url追加到openedUrls；push返回长度被调用方忽略，没有任何网络或系统open命令。
			openUrl: (url) => openedUrls.push(url),
		});
		// 第一条固定URL含查询参数，只是链接目标文字。
		const url = "https://example.com/path?q=1";
		// 第二条链接使用BEL终止编码，目标与第一条不同。
		const belUrl = "https://example.com/bel";
		// 第三条目标关联可见emoji，便于检查两格宽字的命中。
		const emojiUrl = "https://example.com/emoji";
		// 把三条链接作为一个Text组件加入文档。
		tui.addChild(
			// Text只渲染控制串和文字，TUI鼠标路径另负责解析链接位置。
			new Text(
				// 模板用LF串三行：第一/三行helper以ST结束OSC，第二行手写BEL结束；helper不查询能力也不访问地址，所以PI_HYPERLINKS=0不抹去这些手工构造输入。
				`${hyperlink("link", url)}\n\x1b]8;;${belUrl}\x07link\x1b]8;;\x07\n${hyperlink("🙂", emojiUrl)}`,
				// Text横向padding0，链接起点为每行第1列。
				0,
				// 纵向padding0，三条链接对应屏幕1、2、3行。
				0,
			),
		);
		// 启动TUI并建立文档及链接命中几何。
		tui.start();
		// 等待首帧。
		await terminal.waitForRender();

		// 左键在第一行第2列link文字上按下。
		terminal.sendInput("\x1b[<0;2;1M");
		// 用按钮码3的小写m通用释放，仍应结束先前左键点击。
		terminal.sendInput("\x1b[<3;2;1m");
		// 等待点击处理后的帧。
		await terminal.waitForRender();
		// 只应记录第一条URL一次，不能因通用释放漏开或重复开。
		assert.deepStrictEqual(openedUrls, [url]);

		// 左键按在第二行link文字。
		terminal.sendInput("\x1b[<0;2;2M");
		// 明确左键码0释放，区别于前例通用码3。
		terminal.sendInput("\x1b[<0;2;2m");
		// 等待第二条点击。
		await terminal.waitForRender();
		// 数组新增BEL编码的第二条地址，证明两种OSC终止形式都解析到目标。
		assert.deepStrictEqual(openedUrls, [url, belUrl]);

		// 点击第三行第2列，即两格emoji的后半格，命中应映回同一链接。
		terminal.sendInput("\x1b[<0;2;3M");
		// 同点释放完成点击。
		terminal.sendInput("\x1b[<0;2;3m");
		// 等待宽字链接路由。
		await terminal.waitForRender();
		// 第三条emojiURL应追加到数组。
		assert.deepStrictEqual(openedUrls, [url, belUrl, emojiUrl]);

		// 回到第一行第2列左键按下，再制造拖动而非点击。
		terminal.sendInput("\x1b[<0;2;1M");
		// 按钮码32带左键拖到第4列，位移使手势变为拖动选择。
		terminal.sendInput("\x1b[<32;4;1M");
		// 第4列释放，结束拖动。
		terminal.sendInput("\x1b[<0;4;1m");
		// 等待拖动选择相关处理，默认OSC52若生成也仅进内存终端。
		await terminal.waitForRender();
		// openedUrls仍只有三条，没有因在链接上拖动又打开第一条。
		assert.deepStrictEqual(openedUrls, [url, belUrl, emojiUrl]);

		// 正常停止TUI，无统一finally。
		tui.stop();
	});

	// 模拟跨行鼠标选择并用通用释放结束，检查OSC52包含UTF8的alpha换行beta，还检查内部SGR重置后重新施加反色。Copied提示只说明默认协议写入路径返回，不证明系统剪贴板已更新。
	it("selects visible text with the mouse and copies it with OSC 52 after a generic release", async () => {
		// 20列4行记录型内存终端，四条正文全可见。
		const terminal = new RecordingTerminal(20, 4);
		// 未注入copySelection，因此复制走OSC52写入虚拟终端，不调用本机原生剪贴板。
		const tui = new TuiAltScreen(terminal);
		// 第一行alpha中al先粗体、紧接SGR0重置再写pha；选区高亮必须跨过这个重置继续生效。其余三行是普通文字。
		tui.addChild(new Text("\x1b[1mal\x1b[0mpha\nbeta\ngamma\ndelta", 0, 0));
		// 启动并绘制正文。
		tui.start();
		// 等待首帧。
		await terminal.waitForRender();

		// 左键从第一行第1列按下，选择起点在a。
		terminal.sendInput("\x1b[<0;1;1M");
		// 拖到第二行第4列beta末字母上，跨越两行。
		terminal.sendInput("\x1b[<32;4;2M");
		// 用码3通用释放完成先前左键拖动，不误丢选区。
		terminal.sendInput("\x1b[<3;4;2m");
		// 等待选择高亮、自动复制Promise及提示渲染的常见路径。
		await terminal.waitForRender();

		// Buffer.from默认把alpha换行beta编码UTF8，再转base64放入OSC52剪贴板c选择，BEL结束；此处只是构造预期字符串。
		const expectedClipboardSequence = `\x1b]52;c;${Buffer.from("alpha\nbeta").toString("base64")}\x07`;
		// 筛出记录中带OSC52复制前缀的写入，以便下面断言失败时显示相关数据。
		const clipboardWrites = terminal.events.filter(
			// 运行时只保留write且包含前缀；普通filter在此未声明类型谓词，下面some仍检查事件类型。
			(event) => event.type === "write" && event.data.includes("\x1b]52;c;"),
		);
		// 要求至少一次复制记录包含精确预期控制串。
		assert.ok(
			// some再次缩窄为write后检查data，不要求只有一次复制事件。
			clipboardWrites.some((event) => event.type === "write" && event.data.includes(expectedClipboardSequence)),
			// JSON.stringify相关写记录作为失败诊断文案，不是第二份预期值或日志副作用。
			JSON.stringify(clipboardWrites),
		);
		// 还要求某次输出包含SGR7反色，说明不仅构造复制文本，也画了可见选中样式。
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[7m")));
		// 独立检查选区内部SGR0重置后的样式恢复。
		assert.ok(
			// 要求al后原重置0仍保留，再补反色7后接pha；否则第一行后半选区高亮会丢失。
			terminal.events.some((event) => event.type === "write" && event.data.includes("al\x1b[0m\x1b[7mpha")),
			// 这段英文只在断言失败时作解释，不改变选择逻辑。
			"selection inverse must be reapplied after a reset inside the selection",
		);
		// 画面出现Copied提示，验证默认复制写入后反馈；不是系统复制确认。
		assert.ok(terminal.getViewport().some((line) => line.includes("Copied!")));

		// 正常停止并取消本实例提示栈等，前面失败没有finally。
		tui.stop();
	});

	// 验证伪光标的关闭反色码不应连带终止整个鼠标选区高亮：从>前拖过光标a到d，原串应在27后重新加7再画bcd。只查合成控制串，不验证硬件光标。
	it("keeps the selection highlight after a fake cursor cell", async () => {
		// 20列4行记录型虚拟终端。
		const terminal = new RecordingTerminal(20, 4);
		// 创建默认TUI，虚拟适配器报告Kitty键盘状态，不等于有真实光标设备。
		const tui = new TuiAltScreen(terminal);
		// 正文为>空格、带内部伪光标标记的a及bcd；renderFakeCursor只生成字符串标记，不写屏幕。
		tui.addChild(new Text(`> ${renderFakeCursor("a")}bcd`, 0, 0));
		// 启动TUI，让渲染路径把伪光标标记解析成对应样式。
		tui.start();
		// 等初始文本布局。
		await terminal.waitForRender();

		// 左键在第1列按下，选择起点位于>。
		terminal.sendInput("\x1b[<0;1;1M");
		// 拖到第6列d，跨过a的伪光标格。
		terminal.sendInput("\x1b[<32;6;1M");
		// 通用码3释放，触发选择结束。
		terminal.sendInput("\x1b[<3;6;1m");
		// 等待选区合成与可能的复制反馈。
		await terminal.waitForRender();

		// 要求原始write中伪光标结束后继续恢复选区反色。
		assert.ok(
			// 精确片段27关反色、7重新启反色、后接bcd，防止后半选区丢样式。
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[27m\x1b[7mbcd")),
			// 英文说明作为断言失败文案。
			"selection inverse must be reapplied after the fake cursor ends",
		);

		// 正常停止实例，未清除原始正文字符串。
		tui.stop();
	});

	// 注入复制实现成功时应只调用该实现、不再写OSC52，并显示Copied提示。本测试实现只记数组返回true，所以无真实剪贴板写入。
	it("uses an injected copySelection handler instead of OSC 52 and reports success", async () => {
		// 记录型内存终端20×4。
		const terminal = new RecordingTerminal(20, 4);
		// copied数组记录注入回调接到的纯选择文字。
		const copied: string[] = [];
		// 构造TUI并提供可await的复制回调。
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			// async回调接文本，兑现boolean结果，框架等它完成后反馈；async不自动代表系统复制操作。
			copySelection: async (text) => {
				// 保存text到本地数组，不修改系统剪贴板。
				copied.push(text);
				// 兑现true表示这个测试宿主实现报告成功，TUI据此显示Copied。
				return true;
			},
		});
		// 四行无样式正文，跨行选区便于精确比文字。
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		// 启动并建立布局。
		tui.start();
		// 等待首帧。
		await terminal.waitForRender();

		// 从第一行首列左键按下。
		terminal.sendInput("\x1b[<0;1;1M");
		// 拖到第二行第4列，目标为alpha换行beta。
		terminal.sendInput("\x1b[<32;4;2M");
		// 明确左键释放，完成选择并触发自动复制。
		terminal.sendInput("\x1b[<0;4;2m");
		// 给异步回调和反馈渲染机会，再flush模拟屏幕。
		await terminal.waitForRender();

		// 回调应恰好记一项alpha换行beta，包含行分隔且没有ANSI。
		assert.deepStrictEqual(copied, ["alpha\nbeta"]);
		// 再要求整个写入记录没有协议备用复制。
		assert.ok(
			// every对非write直接通过、对write检查无OSC52前缀，防注入路径成功后又重复走备用协议。
			terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")),
			// 失败时解释注入存在即不应写OSC52，不是运行时文案。
			"must not emit OSC 52 when a copySelection handler is provided",
		);
		// 可见提示Copied说明成功结果被转换成反馈。
		assert.ok(terminal.getViewport().some((line) => line.includes("Copied!")));

		// 正常停止TUI，本例没有finally。
		tui.stop();
	});

	// copyOnSelect:false只关闭释放时自动复制，不关闭鼠标选择或高亮。注入回调用于证明未调用，断言选区仍活跃、原串有反色、屏幕无Copied。
	it("leaves selections visible without copying when copyOnSelect is disabled", async () => {
		// 20×4记录型虚拟终端。
		const terminal = new RecordingTerminal(20, 4);
		// copied用于捕获任何不应发生的自动复制。
		const copied: string[] = [];
		// 构造TUI并同时给关闭开关与复制回调。
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			// 显式false不会被默认值覆盖，只禁自动复制，不禁程序主动copyActiveSelectionToClipboard。
			copyOnSelect: false,
			// 异步测试回调若被调用会记文本并成功，因此数组空才能证明没走复制。
			copySelection: async (text) => {
				// 追加传入文字，不调用原生API。
				copied.push(text);
				// 返回true让意外调用会表现为成功反馈，帮助后面排除。
				return true;
			},
		});
		// 四行正文提供与前例相同的跨行选择。
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		// 启动并排帧。
		tui.start();
		// 等待首帧。
		await terminal.waitForRender();

		// 左键按第一行首列。
		terminal.sendInput("\x1b[<0;1;1M");
		// 拖到第二行第4列，形成非空选择。
		terminal.sendInput("\x1b[<32;4;2M");
		// 释放结束选择，按false配置不应复制。
		terminal.sendInput("\x1b[<0;4;2m");
		// 等待高亮状态和任何意外异步复制显现。
		await terminal.waitForRender();

		// 注入复制数组应仍为空，直接观察关闭自动复制后没有回调调用。
		assert.deepStrictEqual(copied, []);
		// 非空选区仍活跃，false开关没有让鼠标拖动整体失效。
		assert.strictEqual(tui.hasActiveSelection(), true);
		// 原始输出中仍有反色7，确认选区样式实际生成。
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[7m")));
		// 所有可见行都不含Copied反馈，避免偷偷复制并提示的路径混过。
		assert.ok(terminal.getViewport().every((line) => !line.includes("Copied!")));

		// 正常停止，不从数据里删除这段正文。
		tui.stop();
	});

	// 测试公开主动复制API：无选区返回false，有选区可在自动复制后再次主动复制并返回true。注入实现仅记数组；主动复制不清选区，清数组只是隔离本次观察。
	it("copies an active selection programmatically", async () => {
		// 记录型虚拟终端20×4，四条正文同时可见。
		const terminal = new RecordingTerminal(20, 4);
		// copied数组保存宿主复制回调接到的文本。
		const copied: string[] = [];
		// 构造TUI并提供内存复制替身。
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			// async接文本并兑现boolean，TUI会await结果决定反馈。
			copySelection: async (text) => {
				// 只在数组里记录，不读取或写入本机剪贴板。
				copied.push(text);
				// 返回true表示替身报告成功，不证明真实系统复制。
				return true;
			},
		});
		// 加入alpha、beta、gamma、delta四行正文。
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		// 启动实际TUI但IO仅在内存终端中。
		tui.start();
		// 等待初始画面，不先创建任何选区。
		await terminal.waitForRender();

		// 当前应没有活跃非空选择。
		assert.strictEqual(tui.hasActiveSelection(), false);
		// await主动复制API，没选中文本应兑现false；不是抛异常或给回调传空串。
		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), false);

		// 第一行首列左键按下。
		terminal.sendInput("\x1b[<0;1;1M");
		// 拖到第二行第4列。
		terminal.sendInput("\x1b[<32;4;2M");
		// 释放形成alpha换行beta选择，默认自动复制仍启用。
		terminal.sendInput("\x1b[<0;4;2m");
		// 给复制Promise和反馈帧机会。
		await terminal.waitForRender();

		// 先确认释放自动复制已记一项预期文字。
		assert.deepStrictEqual(copied, ["alpha\nbeta"]);
		// 复制后选区仍活跃，供后面主动API重用。
		assert.strictEqual(tui.hasActiveSelection(), true);

		// 把数组length设0原地清记录，const变量本身不重赋；不清TUI选区或系统剪贴板。
		copied.length = 0;
		// 主动复制现有选区应兑现true，依赖注入替身这次也返回true。
		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
		// 等待主动复制后的提示渲染。
		await terminal.waitForRender();

		// 清空后又只有一条预期文本，区分自动复制旧记录和本次主动调用。
		assert.deepStrictEqual(copied, ["alpha\nbeta"]);
		// 画面应有Copied反馈。
		assert.ok(terminal.getViewport().some((line) => line.includes("Copied!")));

		// 正常停止，若API拒绝或断言失败没有finally补停。
		tui.stop();
	});

	// 测试注入复制回调兑现false的失败分支：应显示通用Copy failed，不偷偷回退OSC52。这不是拒绝Promise的异常测试，async false是正常失败结果。
	it("flashes an error when the injected copySelection handler fails", async () => {
		// 20×4记录型虚拟终端。
		const terminal = new RecordingTerminal(20, 4);
		// 创建TUI并注入固定失败结果。
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			// 无参数async箭头兑现false，不执行系统复制，也不主动抛错。
			copySelection: async () => false,
		});
		// 加入四行正文作为跨行选区来源。
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		// 启动并排初帧。
		tui.start();
		// 等初始布局。
		await terminal.waitForRender();

		// 从第一行首列按下。
		terminal.sendInput("\x1b[<0;1;1M");
		// 拖到第二行第4列。
		terminal.sendInput("\x1b[<32;4;2M");
		// 释放触发自动复制，注入实现报告false。
		terminal.sendInput("\x1b[<0;4;2m");
		// 等待失败反馈帧。
		await terminal.waitForRender();

		// 至少一行应含Copy failed通用提示，不检查整个提示框的精确样式。
		assert.ok(terminal.getViewport().some((line) => line.includes("Copy failed")));
		// 同时检查没有协议后备复制。
		assert.ok(
			// 所有write都不得含OSC52前缀，false不意味着忽略宿主决定再试另一条复制路径。
			terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")),
			// 固定英文只作断言失败说明。
			"must not emit OSC 52 when a copySelection handler is provided",
		);

		// 正常停止并清本实例提示等；没有finally兜底。
		tui.stop();
	});

	// 回归#9618：注入复制可返回具体错误字符串，TUI应显示该消息、主动API返回false并传5000ms提示时长。字符串里的安装建议只是测试文案，不执行安装命令；本例不等待5秒验证实际持续时间。
	it("flashes a specific error returned by the injected copySelection handler", async () => {
		// Regression test for #9618.
		// 80列4行内存屏，使较长错误文案能够完整出现在一行。
		const terminal = new RecordingTerminal(80, 4);
		// 创建TUI，配置禁自动复制并注入文字错误结果。
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			// copyOnSelect:false先只形成选择，避免释放时已经反馈一次，后面明确主动触发。
			copyOnSelect: false,
			// async回调兑现固定字符串表示宿主解释的失败，不是throw/reject，也不实际检查wl-clipboard是否安装。
			copySelection: async () => "Clipboard unavailable: install wl-clipboard",
		});
		// 可选number用于记录最近一次传给flash的durationMs，初始undefined；不会自动测量真实毫秒。
		let flashDuration: number | undefined;
		// bind把原flash方法的this固定为当前tui并保存，后面替换实例方法仍能委托原逻辑，不递归调用替身。
		const flash = tui.flash.bind(tui);
		// 在本实例上安装观察包装器，接消息和可选时长，先记再调用原方法；没有修改TuiAltScreen原型或全局所有实例。
		tui.flash = (message, durationMs) => {
			// 记录传入时长，可能被之后调用覆盖；断言检查最后记录值而非完整调用列表。
			flashDuration = durationMs;
			// 委托已bind的原flash，继续创建实际提示与计时器，观察器不是完全无操作替身。
			flash(message, durationMs);
		};
		// 四行正文提供非空跨行选择。
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		// 启动TUI并绘制。
		tui.start();
		// 等待初始布局。
		await terminal.waitForRender();

		// 左键按第一行首列。
		terminal.sendInput("\x1b[<0;1;1M");
		// 拖到第二行第4列。
		terminal.sendInput("\x1b[<32;4;2M");
		// 释放完成选择，因关闭自动复制暂不调用复制替身。
		terminal.sendInput("\x1b[<0;4;2m");
		// 等选择高亮稳定的常见路径。
		await terminal.waitForRender();
		// 主动复制并await，应因字符串错误结果兑现false。
		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), false);
		// 等待具体失败提示被合成进画面。
		await terminal.waitForRender();

		// 可见行应包含宿主原样返回的详细错误，不简化成通用消息。
		assert.ok(terminal.getViewport().some((line) => line.includes("Clipboard unavailable: install wl-clipboard")));
		// 同时要求没有Copy failed，防止同时叠加通用和详细两种错误提示。
		assert.ok(terminal.getViewport().every((line) => !line.includes("Copy failed")));
		// 观察到传给flash的时长5000，验证配置参数而非证明提示在真实时间中精确停留5秒。
		assert.strictEqual(flashDuration, 5000);
		// 正常停止，会取消本实例flash到期计时器；未恢复被替换方法，因为只改这次局部实例。
		tui.stop();
	});

	// 测试双击foo的高亮在词尾立即关闭反色，不把后面的两个空格也染进词选区。第二次按下落在同一词不同字符，尚未发送第二次释放，检查的是双击形成时的样式。
	it("does not append whitespace to double-click word highlighting", async () => {
		// 20列1行记录型虚拟终端。
		const terminal = new RecordingTerminal(20, 1);
		// 默认备用屏TUI，自动复制仍开启但本例主要检查高亮原串。
		const tui = new TuiAltScreen(terminal);
		// foo与bar之间有两个显式空格，区别词边界与空白段。
		tui.addChild(new Text("foo  bar", 0, 0));
		// 启动并绘制。
		tui.start();
		// 等待初始画面。
		await terminal.waitForRender();

		// 第一次在foo首字母处按左键。
		terminal.sendInput("\x1b[<0;1;1M");
		// 释放完成第一次普通点击。
		terminal.sendInput("\x1b[<0;1;1m");
		// 很快在foo第3个字符处第二次按下，应归同一词的双击，不要求两次完全同列。
		terminal.sendInput("\x1b[<0;3;1M");
		// 等待词选区高亮。
		await terminal.waitForRender();

		// 某次write中foo后紧接SGR27关闭反色，表明这份样本高亮没有连带词后空格；只要求出现该片段，不统计所有重画次数。
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("foo\x1b[27m")));
		// 正常停止，即使第二次按下未释放也由停止清当前手势。
		tui.stop();
	});

	// 五个固定样本检查路径/连字符/加号连接段双击合并：在needle词里双击，复制预期是完整无空格line，而非只needle。路径只作文字，不读取本机目录或文件。
	it("coalesces slash and hyphen separated segments for double-click word selection", async () => {
		// for..of逐个解构样本文本和点击锚词；一个it内部循环5次，不是注册5个独立用例。
		for (const { line, needle } of [
			// 斜杠路径带连字符和文件扩展名，点击starline也应合并整行。
			{ line: "extensions/starline/fixed-editor/compositor.ts", needle: "starline" },
			// 组织/包样本文字含连字符和斜杠，点击works不只取这一段。
			{ line: "earendil-works/pi-tui", needle: "works" },
			// 以波浪号起的点目录路径，只作为选择样本，不展开home。
			{ line: "~/.pi/agent/settings.json", needle: "agent" },
			// 字符串转义后的反斜杠路径，点击Documents；不在当前平台访问Windows目录。
			{ line: "~\\Documents\\pi", needle: "Documents" },
			// 加号连接foo与bar，验证不局限于用例标题提到的斜杠/连字符。
			{ line: "foo+bar", needle: "bar" },
		]) {
			// 每轮创建新copied数组，隔离此前样本的复制记录。
			const copied: string[] = [];
			// 80列1行内存终端，让全部这些ASCII样本一行容纳。
			const terminal = new RecordingTerminal(80, 1);
			// 新TUI配注入的内存复制回调，无系统剪贴板访问。
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				// 异步回调接最终选择文字，返回成功结果。
				copySelection: async (text) => {
					// 把传入文本追加数组作断言证据。
					copied.push(text);
					// 兑现true，使本样本复制反馈走成功路径。
					return true;
				},
			});
			// 加入当前line的Text，padding均0，列位置与ASCII字符串索引一致。
			tui.addChild(new Text(line, 0, 0));
			// 启动该轮独立实例。
			tui.start();
			// 等文档布局。
			await terminal.waitForRender();

			// indexOf找needle起点再加1转协议坐标；此五例都是ASCII故索引等于列偏移，不能推广为任意Unicode都这样算。
			const oneBasedClickColumn = line.indexOf(needle) + 1;
			// 第一次在锚词首列按下。
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1M`);
			// 同处释放普通点击。
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1m`);
			// 同处再次按下，形成双击词选择。
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1M`);
			// 第二次释放触发自动复制。
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1m`);
			// 等待回调与提示帧，随后检查数组。
			await terminal.waitForRender();

			// 预期一条且完全等于整个line，不只是锚词needle，保留所有连接符和路径标点。
			assert.deepStrictEqual(copied, [line]);
			// 正常停止本轮；没有单轮finally，前面失败会跳过后续样本。
			tui.stop();
		}
	});

	// 词粒度拖动碰到双空格段时，应把整段空白都高亮。foo到第一格空白的拖动不能只选其中一个空格；这例只检查样式、不发送最终释放复制。
	it("highlights a complete whitespace segment during a word drag", async () => {
		// 20列1行记录型内存终端。
		const terminal = new RecordingTerminal(20, 1);
		// 创建默认TUI。
		const tui = new TuiAltScreen(terminal);
		// 输入foo、两个空格、bar，空白段长度刻意为2。
		tui.addChild(new Text("foo  bar", 0, 0));
		// 启动并画正文。
		tui.start();
		// 等首帧。
		await terminal.waitForRender();

		// 第一次在foo首字符按下。
		terminal.sendInput("\x1b[<0;1;1M");
		// 释放第一次点击。
		terminal.sendInput("\x1b[<0;1;1m");
		// 第二次在同词第2列按下，进入词选择粒度。
		terminal.sendInput("\x1b[<0;2;1M");
		// 带左键拖到第4列，即双空格段的第一格，算法应按整空白段扩展。
		terminal.sendInput("\x1b[<32;4;1M");
		// 等待词拖动高亮。
		await terminal.waitForRender();

		// 要求foo后两个空格之后才出现SGR27关闭反色，区分只选一个空格的错误；不以字符串trimEnd做该断言。
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("foo  \x1b[27m")));
		// 正常停止，并结束仍在拖动的实例内手势。
		tui.stop();
	});

	// 连测双击词、跨行词拖动、三击整行：alpha内不同列仍双击词，beta拖到gamma应取两个完整词，gamma delta上三击应整行。检查三条OSC52原串，全部仅入虚拟终端。
	it("selects whole words on double click, extends word drags, and selects lines on triple click", async () => {
		// 20列2行内存屏，刚好放两条正文。
		const terminal = new RecordingTerminal(20, 2);
		// TUI无注入复制回调，默认发OSC52请求给内存适配器。
		const tui = new TuiAltScreen(terminal);
		// 第一行zero alpha beta、第二行gamma delta，用不同词坐标区分多击场景。
		tui.addChild(new Text("zero alpha beta\ngamma delta", 0, 0));
		// 启动并建立布局。
		tui.start();
		// 等待首帧。
		await terminal.waitForRender();

		// The second click lands on a different character in alpha.
		// 第一次按在第一行第6列，alpha的首字母a。
		terminal.sendInput("\x1b[<0;6;1M");
		// 释放第一次点击。
		terminal.sendInput("\x1b[<0;6;1m");
		// 第二次按在第10列，仍是alpha但位于末字符，验证同词不同列仍可合成双击。
		terminal.sendInput("\x1b[<0;10;1M");
		// 释放词选区并自动复制。
		terminal.sendInput("\x1b[<0;10;1m");
		// 等待复制写入与画面。
		await terminal.waitForRender();
		// 构造仅alpha的UTF8 base64 OSC52预期串，不含相邻空格、zero或beta。
		const alpha = `\x1b]52;c;${Buffer.from("alpha").toString("base64")}\x07`;
		// 至少一次write包含这个精确复制串；不是读取系统剪贴板对比。
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(alpha)));

		// A double-click drag includes each word touched, rather than partial words.
		// 在beta首列12按下开始下一组点击。
		terminal.sendInput("\x1b[<0;12;1M");
		// 释放这次点击。
		terminal.sendInput("\x1b[<0;12;1m");
		// 在beta第14列再按，进入词粒度选择。
		terminal.sendInput("\x1b[<0;14;1M");
		// 拖到第二行第3列，即gamma词内部，应该扩展到完整gamma。
		terminal.sendInput("\x1b[<32;3;2M");
		// 在该处释放结束跨行词拖动。
		terminal.sendInput("\x1b[<0;3;2m");
		// 等待自动复制。
		await terminal.waitForRender();
		// 预期beta换行gamma，不是被触及的几个字符，也不含后面的delta。
		const words = `\x1b]52;c;${Buffer.from("beta\ngamma").toString("base64")}\x07`;
		// 检查原始写记录包含完整词选区的OSC52请求。
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(words)));

		// 第二行第7列位于delta内，发下一组三击的第一次按下。
		terminal.sendInput("\x1b[<0;7;2M");
		// 第一次释放。
		terminal.sendInput("\x1b[<0;7;2m");
		// 同词第9列第二次按下，不要求完全同列。
		terminal.sendInput("\x1b[<0;9;2M");
		// 第二次释放。
		terminal.sendInput("\x1b[<0;9;2m");
		// 同词第11列第三次按下，升级为整行选择。
		terminal.sendInput("\x1b[<0;11;2M");
		// 第三次释放触发整行复制。
		terminal.sendInput("\x1b[<0;11;2m");
		// 等待三击处理和写队列。
		await terminal.waitForRender();
		// 整行预期gamma空格delta，末尾没有另加LF。
		const line = `\x1b]52;c;${Buffer.from("gamma delta").toString("base64")}\x07`;
		// 至少一次write应包含对应OSC52控制串，证明第三次不是仍只复制delta。
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(line)));

		// 正常停止；多击时间阈值依实现与运行调度，本例不建立通用实时保证。
		tui.stop();
	});

	// 测试无选区或只有零宽锚点时失焦不重画，孤立拖动/释放也不能从结束的点击续出复制。还验证1004焦点通知启停码；检查内存write数量，不触真实窗口焦点。
	it("does not repaint idle or zero-width selections on focus loss", async () => {
		// 20×4记录型虚拟终端。
		const terminal = new RecordingTerminal(20, 4);
		// 构造TUI，默认支持自己的正文选择路径。
		const tui = new TuiAltScreen(terminal);
		// 四行无样式正文，方便观察重画和复制前缀。
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		// 启动并请求首帧。
		tui.start();
		// 等首帧后再记写入起点，避免初始化模式码混入闲置比较。
		await terminal.waitForRender();

		// 无输入计数闭包每次重新filter全部events中的write，再返回次数；是调用次数，不是字符量或屏幕行数。
		const writeCount = () => terminal.events.filter((event) => event.type === "write").length;
		// 另一个无输入闭包专数带OSC52前缀的write，结果是写调用数而非完整协议命令数量。
		const clipboardWriteCount = () =>
			// 只计write且包含前缀的事件，依赖短路避免在start/stop分支读取data。
			terminal.events.filter((event) => event.type === "write" && event.data.includes("\x1b]52;c;")).length;

		// 保存闲置时写次数。
		const idleWriteCount = writeCount();
		// CSI O模拟焦点丢失，直接进入输入处理，不改变操作系统窗口焦点。
		terminal.sendInput("\x1b[O");
		// CSI I模拟重新获得焦点。
		terminal.sendInput("\x1b[I");
		// 等可能的排帧，随后检查确无新写。
		await terminal.waitForRender();
		// 写次数必须与闲置起点相同，证明这组焦点事件没触发无意义输出。
		assert.strictEqual(writeCount(), idleWriteCount);

		// A completed click leaves a zero-width anchor, but later orphaned drag/release events must not extend it.
		// 按第一行首格，建立一个尚无宽度的锚点。
		terminal.sendInput("\x1b[<0;1;1M");
		// 同处释放，完成普通点击且不构成非空复制。
		terminal.sendInput("\x1b[<0;1;1m");
		// 之后送孤立左键移动，没有新的有效按下手势。
		terminal.sendInput("\x1b[<32;4;2M");
		// 再送孤立释放，不应该把已完成点击延长成选择。
		terminal.sendInput("\x1b[<0;4;2m");
		// 等待潜在复制任务显现。
		await terminal.waitForRender();
		// 复制写调用仍0，证明孤立事件未从旧锚点续选复制。
		assert.strictEqual(clipboardWriteCount(), 0);

		// Losing focus after a press without a drag cancels the press without repainting.
		// 第三行首列再次按下，暂不拖动或释放。
		terminal.sendInput("\x1b[<0;1;3M");
		// 先等按下状态可能引起的处理结束，再记录写次数。
		await terminal.waitForRender();
		// 保存未拖动按下之后的写次数。
		const pressedWriteCount = writeCount();
		// 在按下手势中模拟失焦，应该取消这一未成选区的手势。
		terminal.sendInput("\x1b[O");
		// 随即模拟得焦，不自动重启旧按下。
		terminal.sendInput("\x1b[I");
		// 等待焦点处理。
		await terminal.waitForRender();
		// 此阶段写次数应不变，零宽选择失焦不必重新绘制正文。
		assert.strictEqual(writeCount(), pressedWriteCount);
		// 失焦取消后再送拖动，属于孤立事件。
		terminal.sendInput("\x1b[<32;4;2M");
		// 孤立释放也不恢复旧手势。
		terminal.sendInput("\x1b[<0;4;2m");
		// 等待可能异步复制。
		await terminal.waitForRender();
		// 复制请求仍0，和前半的已完成点击场景形成两个不同前置状态。
		assert.strictEqual(clipboardWriteCount(), 0);
		// 整个启动记录至少含1004h启焦点通知请求，不表示真实终端确认支持。
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1004h")));

		// 正常停止，后面断言专看停止输出。
		tui.stop();
		// 记录应含1004l关闭通知，不能只验证启动启用而漏退出复位。
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1004l")));
	});

	// 未释放的非空拖动选区在失焦时应清高亮，随后孤立拖动/释放不复制。区分下个用例已经释放完成的选区在焦点变化后保留。
	it("clears an active visible selection on focus loss and ignores orphan events", async () => {
		// 20×4记录型内存终端。
		const terminal = new RecordingTerminal(20, 4);
		// 创建实际TUI。
		const tui = new TuiAltScreen(terminal);
		// 加入四行正文，选区将跨alpha和beta。
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		// 启动并排首帧。
		tui.start();
		// 等待初始画面。
		await terminal.waitForRender();

		// 第一行首列按下。
		terminal.sendInput("\x1b[<0;1;1M");
		// 拖到第二行第4列，此处暂不释放，保持正在进行的选择手势。
		terminal.sendInput("\x1b[<32;4;2M");
		// 等待可见高亮出现后才模拟失焦。
		await terminal.waitForRender();
		// 记录失焦之前事件起点，后面只检查失焦导致的新画面，不混入旧高亮串。
		const focusLossEventCount = terminal.events.length;
		// 发送焦点丢失，取消进行中的选区。
		terminal.sendInput("\x1b[O");
		// 再发送焦点获得，旧手势不应自动恢复。
		terminal.sendInput("\x1b[I");
		// 等待清高亮帧。
		await terminal.waitForRender();
		// 收集失焦起点后write，检查正文重新画而反色消失。
		const focusLossWrites = terminal.events
			// slice只取新事件。
			.slice(focusLossEventCount)
			// 类型谓词缩窄write分支供读取data。
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			// 提取各次实际写入控制串。
			.map((event) => event.data)
			// 空分隔拼接这些写入，供文字与反色检查，不重建xterm画面。
			.join("");
		// 失焦后新写入应包含alpha，证明正文相关区域被重新输出。
		assert.ok(focusLossWrites.includes("alpha"));
		// 也应包含beta，覆盖跨行选区的另一行。
		assert.ok(focusLossWrites.includes("beta"));
		// 新输出不应含反色7，表示进行中的高亮已清；这里未检查所有可能的颜色代码。
		assert.ok(!focusLossWrites.includes("\x1b[7m"));

		// 失焦取消后再次送拖动，缺少有效新按下。
		terminal.sendInput("\x1b[<32;4;2M");
		// 随后释放也不能把旧手势复活。
		terminal.sendInput("\x1b[<0;4;2m");
		// 等待潜在复制或重画。
		await terminal.waitForRender();
		// 全部记录中都不能有OSC52复制请求，证明这组未释放即失焦的选择没有后来误复制。
		assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")));
		// 正常停止TUI，没有finally包整个例子。
		tui.stop();
	});

	// 已经释放完成的非空选择则跨焦点变化保留：失焦/得焦不增write，强制重绘还应带alpha、beta及反色。与前例进行中的拖动失焦清除形成明确区别。
	it("retains a completed visible selection across focus changes", async () => {
		// 20列4行记录型内存终端。
		const terminal = new RecordingTerminal(20, 4);
		// 创建实际TUI，默认自动复制可生成仅给虚拟终端的OSC52。
		const tui = new TuiAltScreen(terminal);
		// 固定四行正文供跨行选择。
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		// 启动并排初帧。
		tui.start();
		// 等待初始布局。
		await terminal.waitForRender();

		// 第一行首格按下。
		terminal.sendInput("\x1b[<0;1;1M");
		// 拖到第二行第4列形成非空选区。
		terminal.sendInput("\x1b[<32;4;2M");
		// 先明确释放，使选区进入已完成状态，再测试焦点变化。
		terminal.sendInput("\x1b[<0;4;2m");
		// 等待复制/提示与高亮帧的常见路径。
		await terminal.waitForRender();
		// 保存此时write调用数，包含此前初始化和选择写入，但不计start/stop事件。
		const completedWriteCount = terminal.events.filter((event) => event.type === "write").length;
		// 模拟焦点丢失。
		terminal.sendInput("\x1b[O");
		// 紧接模拟焦点恢复，选区不应因此丢掉。
		terminal.sendInput("\x1b[I");
		// 等潜在渲染任务后再数write。
		await terminal.waitForRender();
		// write数保持不变，说明这组焦点事件没有多画一帧；这一步本身尚未证明下一次绘制仍保留选区。
		assert.strictEqual(terminal.events.filter((event) => event.type === "write").length, completedWriteCount);

		// 记录强制重绘前的事件起点。
		const redrawEventCount = terminal.events.length;
		// renderNow(true)同步重置渲染器差量状态并画帧，不清选择；无需先等读屏，因为后面只读同步write记录。
		tui.renderNow(true);
		// 收集强制重绘的新write数据。
		const redrawWrites = terminal.events
			// slice排除旧高亮，保证后面找到的是重新生成的样式。
			.slice(redrawEventCount)
			// filter类型谓词保留write并让TS允许访问data。
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			// 取每段原始控制串。
			.map((event) => event.data)
			// 无分隔拼接，便于检查整次重绘输出。
			.join("");
		// 新输出仍含alpha。
		assert.ok(redrawWrites.includes("alpha"));
		// 新输出仍含beta，跨行内容都重画。
		assert.ok(redrawWrites.includes("beta"));
		// 新输出还有反色7，证明已完成选区状态在焦点切换后仍用于合成。
		assert.ok(redrawWrites.includes("\x1b[7m"));
		// 正常停止实例，底层xterm缓冲不会被销毁。
		tui.stop();
	});

	// 测试flash按追加顺序在右上堆叠、较早提示到期后后续提示补位。First请求80ms、Second500ms，额外等100ms后只应剩Second；这些真实计时与调度存在执行环境波动，不证明精确时刻。
	it("stacks flash messages and collapses them as they expire", async () => {
		// 20列4行内存屏，足以同时放两条提示。
		const terminal = new VirtualTerminal(20, 4);
		// 构造实际TUI，使用真实flash容器与到期计时器。
		const tui = new TuiAltScreen(terminal);
		// 四行正文作为提示叠加底图，不因提示显示而修改原Text。
		tui.addChild(new Text("one\ntwo\nthree\nfour", 0, 0));
		// 启动并排首帧。
		tui.start();
		// 等待初始正文。
		await terminal.waitForRender();

		// 添加First提示，请求80ms后过期并安排渲染；不是直接sleep80ms。
		tui.flash("First", 80);
		// 再添加Second提示，请求500ms，到期顺序与First不同。
		tui.flash("Second", 500);
		// 等两条提示一起合成。
		await terminal.waitForRender();
		// 读取当前视口，let允许后面等待后重新赋值。
		let viewport = terminal.getViewport();
		// 第0行应以空格First空格结尾，检查右对齐提示而不是全行都变为First。
		assert.ok(viewport[0]?.endsWith(" First "));
		// 第1行应以Second结尾，说明两条按顺序堆叠。
		assert.ok(viewport[1]?.endsWith(" Second "));

		// 真实Node timer请求等待100ms，期望越过First期限但仍在Second期限内；繁忙调度可延后，不是可靠实时截止证明。
		await new Promise((resolve) => setTimeout(resolve, 100));
		// 再等待到期引发的重画和写队列。
		await terminal.waitForRender();
		// 读取等待后的新快照。
		viewport = terminal.getViewport();
		// Second应补到最上第0行，而不留First占位空洞。
		assert.ok(viewport[0]?.endsWith(" Second "));
		// 任何可见行都不应再含First，说明短提示已到期移除。
		assert.ok(!viewport.some((line) => line.includes("First")));

		// 正常停止，清本实例剩余提示/到期任务；前面失败没有finally保证。
		tui.stop();
	});

	// 测试拖动停在视口上边缘会按计时器自动上滚并延长文档选择。等待130ms后只要求偏移小于6，不假定恰好滚几行；复制预期依据实际观察偏移构造，选到原line9的首字母l。
	it("auto-scrolls and extends a drag selection held at the viewport edge", async () => {
		// 20×4记录型内存终端，十行文档初始底部偏移6。
		const terminal = new RecordingTerminal(20, 4);
		// 默认TUI，自动复制走OSC52内存写入。
		const tui = new TuiAltScreen(terminal);
		// 十行编号Text，零padding，不随选择过程中改变内容。
		tui.addChild(new Text(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		// 启动并首帧跟文档末尾。
		tui.start();
		// 等布局完成。
		await terminal.waitForRender();
		// 初始顶部0起6，屏幕第3行对应文档索引8即line9。
		assert.strictEqual(tui.viewportTop, 6);

		// 从屏幕第3行第1列按下，原文锚点在line9首字母。
		terminal.sendInput("\x1b[<0;1;3M");
		// 带左键拖到屏幕顶行第1列，触发向上边缘自动滚动条件。
		terminal.sendInput("\x1b[<32;1;1M");
		// 等待约130ms，真实interval可运行若干次；本例不拿这个时长断言具体tick次数。
		await new Promise((resolve) => setTimeout(resolve, 130));
		// 再给渲染和xterm解析机会。
		await terminal.waitForRender();

		// 记录自动滚动后实际偏移，后面的复制预期依这个观察值而非写死滚动次数。
		const selectionTop = tui.viewportTop;
		// 只要求小于原偏移6，证明确实向上自动移动；插值文案记录失败时实际值。
		assert.ok(selectionTop < 6, `expected auto-scroll above row 6, got ${selectionTop}`);
		// 顶行首格释放，停止持续拖动并自动复制最终选区。
		terminal.sendInput("\x1b[<0;1;1m");
		// 等待停止滚动、复制及提示的常见异步路径。
		await terminal.waitForRender();

		// 按实际顶部生成完整line(top+1)到line8各行，长度8减selectionTop；这是逆向选择中位于原锚点行之前的完整行。
		const selectedLines = Array.from({ length: 8 - selectionTop }, (_, index) => `line ${selectionTop + index + 1}`);
		// 最后加l，因为原line9锚点只落在首列，不应复制整条line9。
		selectedLines.push("l");
		// 用LF连接预期选择、UTF8转base64，再包OSC52；只构造比较字符串，不执行复制。
		const expectedClipboardSequence = `\x1b]52;c;${Buffer.from(selectedLines.join("\n")).toString("base64")}\x07`;
		// 检查实际复制请求中是否存在对应纯文本。
		assert.ok(
			// some查write包含精确预期控制串，不读取系统剪贴板。
			terminal.events.some((event) => event.type === "write" && event.data.includes(expectedClipboardSequence)),
			// 失败文案只列OSC52相关事件以便诊断，不作为第二项预期。
			JSON.stringify(terminal.events.filter((event) => event.type === "write" && event.data.includes("\x1b]52;c;"))),
		);
		// 正常停止TUI，并取消其边缘自动滚动计时器；前面失败则无finally保证到达。
		tui.stop();
	});

	// 测试宽字和组合字素选择吸附：从界的后半格到表情、反向拖回都得到完整的界与表情；从组合e重音到Z得到完整e重音Z。检查UTF8复制原串，避免半个代理对或组合标记被截开。
	it("snaps mouse selection to CJK, emoji, and combining grapheme boundaries", async () => {
		// 20列2行记录型内存终端，正文只一行。
		const terminal = new RecordingTerminal(20, 2);
		// 默认TUI，未注入系统复制实现。
		const tui = new TuiAltScreen(terminal);
		// 正文A占1列、界2列、表情2列、e加组合重音共1列、Z1列；显示列与JS码元/代码点数量均不同。
		tui.addChild(new Text("A界🙂éZ", 0, 0));
		// 启动并布局这些字素。
		tui.start();
		// 等待首帧。
		await terminal.waitForRender();

		// 构造完整的界加表情的UTF8 base64复制请求作为共享预期。
		const wideSelection = `\x1b]52;c;${Buffer.from("界🙂").toString("base64")}\x07`;
		// 第3列位于界的第二格，按下应吸附到完整字素边界。
		terminal.sendInput("\x1b[<0;3;1M");
		// 拖到第4列emoji第一格，选区应包括完整emoji而非只它的一格。
		terminal.sendInput("\x1b[<32;4;1M");
		// 在该列释放。
		terminal.sendInput("\x1b[<0;4;1m");
		// 等待自动复制。
		await terminal.waitForRender();
		// 严格检查到目前符合宽字复制串的write次数。
		assert.strictEqual(
			// filter按完整预期串计写事件，防第一次没复制或重复复制。
			terminal.events.filter((event) => event.type === "write" && event.data.includes(wideSelection)).length,
			// 本轮累计应恰好1。
			1,
		);

		// 第5列位于emoji后半格，开始反向选择。
		terminal.sendInput("\x1b[<0;5;1M");
		// 向左拖到第2列界的首格，同样应吸附完整宽字。
		terminal.sendInput("\x1b[<32;2;1M");
		// 在第2列释放。
		terminal.sendInput("\x1b[<0;2;1m");
		// 等待反向复制完成。
		await terminal.waitForRender();
		// 再次检查相同宽字预期累计次数。
		assert.strictEqual(
			// 从整个事件数组计数，不只查最近一项。
			terminal.events.filter((event) => event.type === "write" && event.data.includes(wideSelection)).length,
			// 累计2说明反向选择也产生同样的完整界与表情文本。
			2,
		);

		// 预期组合e加重音后接Z，保留原组合编码而不是强制规范化成预组字符。
		const combiningSelection = `\x1b]52;c;${Buffer.from("éZ").toString("base64")}\x07`;
		// 第6列是e与组合重音构成的一个显示字素，按下不把附加重音单独选。
		terminal.sendInput("\x1b[<0;6;1M");
		// 拖到第7列Z。
		terminal.sendInput("\x1b[<32;7;1M");
		// 释放选择。
		terminal.sendInput("\x1b[<0;7;1m");
		// 等待复制写入。
		await terminal.waitForRender();
		// 至少一次write含完整e重音Z的复制串，证明组合标记未丢；本条不额外计次数。
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(combiningSelection)));

		// 正常停止，本例没有finally。
		tui.stop();
	});

	// 水平滚轮66/67不应被当成垂直上/下滚：八行文档在四行视口初始偏移4，两个水平事件后偏移和画面都保持。只模拟协议，不操作实际触控板。
	it("ignores horizontal trackpad wheel events", async () => {
		// 20列4行内存终端。
		const terminal = new VirtualTerminal(20, 4);
		// 实际TUI，默认垂直滚轮策略。
		const tui = new TuiAltScreen(terminal);
		// 八行编号Text初始跟末尾。
		tui.addChild(new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		// 启动并排帧。
		tui.start();
		// 等初始视口。
		await terminal.waitForRender();

		// SGR按钮码66表示水平滚轮一个方向，坐标1,1。
		terminal.sendInput("\x1b[<66;1;1M");
		// 67表示水平另一方向，二者都不应触发纵向文档滚动。
		terminal.sendInput("\x1b[<67;1;1M");
		// 等待可能误触发的帧，再检查状态和画面。
		await terminal.waitForRender();
		// 顶部偏移仍4。
		assert.strictEqual(tui.viewportTop, 4);
		// 深比较四行视口，防状态正确却画面变化。
		// 读屏并去末尾空白，不改变行序。
		// 仍应5–8，与初始跟末尾一致。
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8"],
		);

		// 正常停止TUI。
		tui.stop();
	});

	// MouseRegion只消费合成click，普通点击应回调一次，跨行拖动仍走正文选择而不再合成click，并生成OSC52。此例检验组件点击与默认选择共存，不启动真实鼠标或剪贴板。
	it("dispatches clicks to nested mouse regions without breaking drag selection", async () => {
		// 20列2行记录型虚拟终端。
		const terminal = new RecordingTerminal(20, 2);
		// 实际备用屏TUI。
		const tui = new TuiAltScreen(terminal);
		// 可变计数记录click回调，不统计press/drag/release。
		let clicks = 0;
		// 把包装两行文字的鼠标区域加入默认文档。
		tui.addChild(
			// 回调接规范化鼠标事件，Text首行为clickable、次行为selectable。
			new MouseRegion(new Text("clickable\nselectable", 0, 0), (event) => {
				// 不是click就返回undefined，留给其他默认路由处理，不把所有鼠标事件一概吃掉。
				if (event.type !== "click") return undefined;
				// 真正click才计数加1。
				clicks += 1;
				// 该click返回handled:true，表示组件已消费这次点击。
				return { handled: true };
			}),
		);
		// 启动并建命中几何。
		tui.start();
		// 等待首帧。
		await terminal.waitForRender();

		// 在第一行第2列左键按下。
		terminal.sendInput("\x1b[<0;2;1M");
		// 原地释放，形成无拖动click。
		terminal.sendInput("\x1b[<0;2;1m");
		// 等待点击相关任务。
		await terminal.waitForRender();
		// 计数应1，证明回调并未被默认正文选区完全挡住。
		assert.strictEqual(clicks, 1);

		// 再从第一行首列按下，开始另一手势。
		terminal.sendInput("\x1b[<0;1;1M");
		// 拖到第二行第4列，产生实际跨行选择。
		terminal.sendInput("\x1b[<32;4;2M");
		// 释放拖动，不应合成普通click回调。
		terminal.sendInput("\x1b[<0;4;2m");
		// 等待选择复制。
		await terminal.waitForRender();
		// click数仍1，拖动没有重复点击。
		assert.strictEqual(clicks, 1);
		// 至少一次write含OSC52前缀，证明默认选择复制仍可工作；此条只查前缀，不核具体文本。
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b]52;c;")));
		// 正常停止，没有finally。
		tui.stop();
	});

	// #10769
	// 回归#10769：浮层聚焦并不一概阻断滚轮。这个InputOverlay无鼠标处理器，指针位于它上面时滚轮仍滚正文，且原始序列不被当普通键盘输入送进浮层inputs。
	it("scrolls the transcript on wheel input a focused overlay does not handle", async () => {
		// 20×6虚拟终端。
		const terminal = new VirtualTerminal(20, 6);
		// 创建实际TUI。
		const tui = new TuiAltScreen(terminal);
		// 12行正文比6行视口长，初始跟末尾有可向上滚空间。
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		// 建立只有handleInput、固定render的最小浮层替身。
		const overlay = new InputOverlay();
		// 先启动正文TUI。
		tui.start();
		// 等首帧确定初始偏移。
		await terminal.waitForRender();
		// 保存加浮层前的顶部偏移，后面只要求变小。
		const topBefore = tui.viewportTop;
		// 显示左上角、宽10列的浮层，默认接管焦点；第3列第1行会落在它上面。
		tui.showOverlay(overlay, { anchor: "top-left", width: 10 });
		// 等待浮层布局与焦点更新。
		await terminal.waitForRender();
		// 确认focused确为true，使后面是聚焦浮层的场景而非没拿焦点的空通过。
		assert.strictEqual(overlay.focused, true);

		// 在浮层覆盖坐标上送向上滚轮。
		terminal.sendInput("\x1b[<64;3;1M");
		// 等待正文滚动。
		await terminal.waitForRender();
		// 顶部应小于原偏移，正文确实上滚。
		assert.ok(tui.viewportTop < topBefore);
		// 浮层inputs为空，滚轮没有被错误降级成它的键盘字符串输入。
		assert.deepStrictEqual(overlay.inputs, []);
		// 正常停止，也清本次TUI活动状态；不单独隐藏浮层。
		tui.stop();
	});

	// 组件在press返回capture与focus后，拖到自身范围外仍接drag/release，并获得键盘焦点。检查事件顺序严格为三项，不合成额外click。全部坐标由虚拟SGR输入提供。
	it("focuses and captures drag gestures for mouse-aware components", async () => {
		// 20列2行内存终端，组件只渲染第一行。
		const terminal = new VirtualTerminal(20, 2);
		// 创建实际TUI以运行捕获和焦点逻辑。
		const tui = new TuiAltScreen(terminal);
		// events数组只记事件type，区别于RecordingTerminal的终端调用记录。
		const events: string[] = [];
		// 结构化鼠标组件对象，不继承某个控件类。
		const component = {
			// render固定返回一行control，组件自然高度1。
			render: () => ["control"],
			// invalidate空实现，没有缓存。
			invalidate: () => {},
			// handleMouse显式用TuiMouseEvent约束开发期事件字段，不负责解析原始SGR字节。
			handleMouse: (event: TuiMouseEvent) => {
				// 每次调用先记事件种类，供后面精确比序。
				events.push(event.type);
				// 仅press返回handled、capture、focus三项请求；其他事件仅handled。三元返回的是普通处理结果对象，不会在这里直接给系统窗口抢焦点。
				return event.type === "press" ? { handled: true, capture: true, focus: true } : { handled: true };
			},
		};
		// 把这份组件加入默认文档。
		tui.addChild(component);
		// 启动并布局。
		tui.start();
		// 等首帧让组件命中盒子存在。
		await terminal.waitForRender();

		// 在组件第一行首列按下，触发捕获与焦点请求。
		terminal.sendInput("\x1b[<0;1;1M");
		// 拖到第二行第5列，已在一行高组件范围外，仍应交捕获目标。
		terminal.sendInput("\x1b[<32;5;2M");
		// 在范围外释放，捕获目标仍应收到release收尾。
		terminal.sendInput("\x1b[<0;5;2m");
		// 等待输入后续处理与可能帧。
		await terminal.waitForRender();

		// 事件必须同序press、drag、release，不能因拖出范围漏事件或额外click。
		assert.deepStrictEqual(events, ["press", "drag", "release"]);
		// 焦点组件引用严格等于原component，证明focus请求生效而非只修改内部标记。
		assert.strictEqual(tui.getFocusedComponent(), component);
		// 正常停止实例。
		tui.stop();
	});

	// 组件自有控件的连续点击应带1、2、3次数。press先返回handled使其拥有手势，click再记录可选clickCount；一个it内部送三组按下/释放，不是3个独立测试。
	it("reports consecutive click counts to component-owned controls", async () => {
		// 20列1行内存终端。
		const terminal = new VirtualTerminal(20, 1);
		// 创建TUI运行组件点击合成。
		const tui = new TuiAltScreen(terminal);
		// number[]记录合成clickCount，实际数字在事件处理时产生。
		const clickCounts: number[] = [];
		// 直接加入含render、invalidate、handleMouse的结构化组件。
		tui.addChild({
			// 固定一行control供鼠标命中。
			render: () => ["control"],
			// 无操作失效回调，不影响点击计数。
			invalidate: () => {},
			// 鼠标回调按事件类型分流，返回值决定是否消费。
			handleMouse: (event) => {
				// press返回handled，声明组件处理按下，后面才能按其组件手势合成点击。
				if (event.type === "press") return { handled: true };
				// click分支才记录连续次数，不把press数量直接当次数。
				if (event.type === "click") {
					// clickCount缺失以0记录，??仅对null/undefined回退，真实0也保留；最终断言要求非缺失的1/2/3。
					clickCounts.push(event.clickCount ?? 0);
					// 该click已处理，返回handled:true。
					return { handled: true };
				}
				// 其他事件不处理，返回undefined，不抛异常。
				return undefined;
			},
		});
		// 启动并建立控件区域。
		tui.start();
		// 等首帧。
		await terminal.waitForRender();

		// 紧接循环三次，count只是循环次数控制，不直接传给事件。连续阈值仍由真实TUI实现按时间/位置计算。
		for (let count = 0; count < 3; count++) {
			// 每次在相同首格左键按下。
			terminal.sendInput("\x1b[<0;1;1M");
			// 同处释放，组成三次普通点击而不是拖动。
			terminal.sendInput("\x1b[<0;1;1m");
		}
		// 统一等待后续任务，不强制每次点击都独立重画。
		await terminal.waitForRender();
		// 精确要求回调得到1、2、3，验证不是每次都报1或缺失回退0。
		assert.deepStrictEqual(clickCounts, [1, 2, 3]);
		// 正常停止；测试没有对任意机器调度下多击时间作普遍保证。
		tui.stop();
	});

	// 鼠标移动被组件标handled但没请求render时，不应无条件重绘。比较组件render调用数与终端write次数两项，避免只看画面相同漏掉重复工作。
	it("does not rerender for handled no-op pointer motion", async () => {
		// 记录型内存终端20×2，用于计输出调用。
		const terminal = new RecordingTerminal(20, 2);
		// 创建实际TUI，没有真实输入设备监听。
		const tui = new TuiAltScreen(terminal);
		// 可变计数观察组件render实际调用次数，不是TUI帧计数。
		let renderCount = 0;
		// 加入一个接受无按钮move的结构化组件。
		tui.addChild({
			// render回调每次调用都计数并返回固定行；注册回调本身不加计数。
			render: () => {
				// 本次真正渲染时把计数加1。
				renderCount += 1;
				// 固定hover target文字，未通过移动改变任何业务数据。
				return ["hover target"];
			},
			// invalidate为空，没有依移动而变化的组件缓存。
			invalidate: () => {},
			// 鼠标move只返回handled:true，没有render:true，也不修改状态；其他种类返回undefined，不会自动成为一次点击或滚动。
			handleMouse: (event) => (event.type === "move" ? { handled: true } : undefined),
		});
		// 启动TUI，让组件先至少参与一次真实布局/渲染。
		tui.start();
		// 等待初始化后再记基准，避免把首帧工作当移动造成的变化。
		await terminal.waitForRender();
		// 保存移动前组件render调用计数。
		const renderedBeforeMotion = renderCount;
		// 保存移动前终端write调用数，不统计start/stop记录。
		const writesBeforeMotion = terminal.events.filter((event) => event.type === "write").length;

		// SGR35在第1列第1行模拟无按钮移动，命中这个组件。
		terminal.sendInput("\x1b[<35;1;1M");
		// 等可能安排的重绘任务，避免仅因尚未到时间就误判零重绘。
		await terminal.waitForRender();
		// 组件render调用数不变，未重新计算同一内容。
		assert.strictEqual(renderCount, renderedBeforeMotion);
		// write调用数也不变，未生成无意义终端输出；两项一起覆盖计算和写入两个观察点。
		assert.strictEqual(terminal.events.filter((event) => event.type === "write").length, writesBeforeMotion);
		// 正常停止实例，本例无finally。
		tui.stop();
	});

	// 组件先消费滚轮时，不能再把同一事件滚正文。MouseRegion只对wheel返回handled，预期计数1且viewportTop保持原值；不同于前面的无鼠标处理浮层允许滚动回退。
	it("lets mouse-aware components consume wheel events before viewport scrolling", async () => {
		// 20列3行内存终端，八行文档有明显可滚空间。
		const terminal = new VirtualTerminal(20, 3);
		// 创建真实TUI。
		const tui = new TuiAltScreen(terminal);
		// wheelEvents从0计组件收到并处理的滚轮次数。
		let wheelEvents = 0;
		// 把可消费滚轮的区域加入文档。
		tui.addChild(
			// MouseRegion包装真实Text，用实际布局生成命中范围。
			new MouseRegion(
				// 八行编号正文，零padding，默认跟末尾时仍能向上滚，确保不变偏移不是已到顶的空通过。
				new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
				// 回调接规范化鼠标事件，不解析SGR字节。
				(event) => {
					// 非wheel不处理，返回undefined供默认路径。
					if (event.type !== "wheel") return undefined;
					// wheel命中时计数加1。
					wheelEvents += 1;
					// handled:true消费事件，TUI不应继续把相同delta发到主滚动区。
					return { handled: true };
				},
			),
		);
		// 启动并排首帧。
		tui.start();
		// 等组件命中盒子和主偏移建立。
		await terminal.waitForRender();
		// 保存滚轮输入前的顶部偏移，后面检查严格不变。
		const viewportTop = tui.viewportTop;

		// 第1列第1行发送向上滚轮，落在MouseRegion范围。
		terminal.sendInput("\x1b[<64;1;1M");
		// 等待输入处理后的常见渲染路径。
		await terminal.waitForRender();
		// 组件滚轮处理计数恰好1，证明事件没被简单丢弃。
		assert.strictEqual(wheelEvents, 1);
		// 文档偏移保持，证明没有在组件消费后重复滚动正文。
		assert.strictEqual(tui.viewportTop, viewportTop);
		// 正常停止，无finally保护之前断言。
		tui.stop();
	});

	// 测试进入/退出模式的调用顺序与正常停止的全文重放：进入备用屏在Terminal.start前、关鼠标在Terminal.stop前、离备用屏在stop后且同一恢复write含全部六行。标题提keyboard state，但这个虚拟适配器只提供stop事件，不检真实键盘协议恢复或硬件行为。
	it("restores keyboard state before leaving alt mode and prints the full document", async () => {
		// 20列3行记录型内存终端，只能看六行文档的尾部半屏。
		const terminal = new RecordingTerminal(20, 3);
		// 构造实际TuiAltScreen，使用默认正常退出重放策略。
		const tui = new TuiAltScreen(terminal);
		// 六条英文序数正文，停止时应该全部输出，而不是只重放当前三行视口。
		tui.addChild(new Text("first\nsecond\nthird\nfourth\nfifth\nsixth", 0, 0));
		// 启动，记录启屏write和适配器start先后。
		tui.start();
		// 等待首帧正常绘制。
		await terminal.waitForRender();
		// 正常stop同步生成复位与全文重放write；后面只检查记录，未等待真实终端显示。
		tui.stop();

		// 查记录中第一条start事件的索引，未找到返回-1。
		const startIndex = terminal.events.findIndex((event) => event.type === "start");
		// 查进入备用屏请求所在的write位置。
		const altScreenEnterIndex = terminal.events.findIndex(
			// 寻找CSI?1049h，不把存在此串当作真实终端确认切屏成功。
			(event) => event.type === "write" && event.data.includes("\x1b[?1049h"),
		);
		// 找到适配器stop事件的索引，作为模式恢复顺序分界。
		const stopIndex = terminal.events.findIndex((event) => event.type === "stop");
		// 查关闭SGR鼠标编码的write位置。
		const mouseDisableIndex = terminal.events.findIndex(
			// 1006l为关闭鼠标编码请求，检查发生于Terminal.stop之前。
			(event) => event.type === "write" && event.data.includes("\x1b[?1006l"),
		);
		// 查离开备用屏恢复主屏的write位置。
		const mainScreenRestoreIndex = terminal.events.findIndex(
			// 1049l表示退出备用屏请求，实际窗口由内存xterm解释。
			(event) => event.type === "write" && event.data.includes("\x1b[?1049l"),
		);
		// 要求进入备用屏存在且早于start事件；若start缺失为-1，这个大小比较也会失败。
		assert.ok(altScreenEnterIndex >= 0 && altScreenEnterIndex < startIndex);
		// 要求关鼠标请求存在且早于stop事件。
		assert.ok(mouseDisableIndex >= 0 && mouseDisableIndex < stopIndex);
		// 恢复主屏必须在stop事件之后；前一个断言已要求能找到正确stop顺序，不是单独靠正负索引判断。
		assert.ok(mainScreenRestoreIndex > stopIndex);

		// 取离备用屏的那次事件，后面要求所有正文都在它的同一data里。
		const restoreEvent = terminal.events[mainScreenRestoreIndex];
		// 可选链处理索引缺失时undefined，断言类型为write。
		assert.strictEqual(restoreEvent?.type, "write");
		// 再用实际if缩窄事件联合类型，便于TS允许读data；不是依赖断言语句自动提供完整类型转换。
		if (restoreEvent?.type === "write") {
			// 恢复write包含第一行first，说明没只保留底部视口。
			assert.ok(restoreEvent.data.includes("first"));
			// 也包含第二行second。
			assert.ok(restoreEvent.data.includes("second"));
			// 也包含第三行third。
			assert.ok(restoreEvent.data.includes("third"));
			// 也包含第四行fourth。
			assert.ok(restoreEvent.data.includes("fourth"));
			// 也包含第五行fifth。
			assert.ok(restoreEvent.data.includes("fifth"));
			// 也包含末行sixth，完整样本六行都有输出。
			assert.ok(restoreEvent.data.includes("sixth"));
			// 只额外比较first在sixth之前；中间四行各自存在，但没有逐对断言完整六行顺序或精确换行控制串。
			assert.ok(restoreEvent.data.indexOf("first") < restoreEvent.data.indexOf("sixth"));
		}
	});

	// 聚焦普通浮层时，分页和Home/End原串应交给浮层而非滚正文；hide移除浮层后PageUp才重新滚正文。轮子与键盘路由是不同分支，不能用这例推导浮层消费全部鼠标事件。
	it("gives viewport keys to a focused overlay", async () => {
		// 20×6虚拟终端。
		const terminal = new VirtualTerminal(20, 6);
		// 创建实际TUI。
		const tui = new TuiAltScreen(terminal);
		// 12行正文在6行视口初始跟末尾，可测试向上分页。
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		// 创建保存输入的InputOverlay替身。
		const overlay = new InputOverlay();
		// 先启动正文。
		tui.start();
		// 等待首帧。
		await terminal.waitForRender();
		// 保存初始文档偏移，后面检查浮层接键时不变。
		const topBefore = tui.viewportTop;
		// 显示浮层并保存控制句柄，默认使它获得键盘焦点。
		const handle = tui.showOverlay(overlay);
		// 等浮层画面及焦点建立。
		await terminal.waitForRender();
		// 明确检查浮层focused为true，保证测试前置状态。
		assert.strictEqual(overlay.focused, true);

		// 四个原串依次为PageUp、PageDown、Home、End；数组字符串本身不执行导航。
		const keys = ["\x1b[5~", "\x1b[6~", "\x1bOH", "\x1bOF"];
		// 逐个同步送进TUI输入链，聚焦浮层应收到原串。
		for (const key of keys) terminal.sendInput(key);
		// 等待输入后续渲染。
		await terminal.waitForRender();

		// 浮层inputs与四键同序深相等，证明交给浮层而非丢弃。
		assert.deepStrictEqual(overlay.inputs, keys);
		// 文档偏移保持初值，浮层接键没有同时滚正文。
		assert.strictEqual(tui.viewportTop, topBefore);

		// 句柄hide关闭这个浮层并处理焦点恢复，不是停止整个TUI。
		handle.hide();
		// 等待隐藏后的帧。
		await terminal.waitForRender();
		// 再发送PageUp，现在应交正文视口动作。
		terminal.sendInput("\x1b[5~");
		// 等待文档分页结果。
		await terminal.waitForRender();
		// 偏移变小，证明去掉聚焦浮层后文档重新获得分页行为。
		assert.ok(tui.viewportTop < topBefore);
		// 正常停止，无finally。
		tui.stop();
	});

	// 隐藏、nonCapturing、显式unfocus的浮层都不应把视口键抢走。组合三种状态后送PageUp和滚轮，正文上滚，两份可见但未聚焦浮层都没收到普通输入。不是分别对三种状态各注册独立用例。
	it("keeps viewport scrolling when an overlay is not focused", async () => {
		// 20×6内存终端。
		const terminal = new VirtualTerminal(20, 6);
		// 创建TUI。
		const tui = new TuiAltScreen(terminal);
		// 另建InputOverlay充当原编辑器焦点，不一定需要作为文档子节点渲染。
		const editor = new InputOverlay();
		// 12行正文，初始有向上滚动空间。
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		// 设置原焦点为editor替身，后续浮层unfocus应能交回它。
		tui.setFocus(editor);
		// 启动TUI。
		tui.start();
		// 等初帧。
		await terminal.waitForRender();
		// 保存显示浮层前的文档偏移。
		const topBefore = tui.viewportTop;

		// 先显示一个默认会聚焦的浮层，保存句柄。
		const hidden = tui.showOverlay(new InputOverlay());
		// setHidden(true)把该条目设隐藏状态而非从栈中移除，焦点相应恢复；区别于上一例hide删除。
		hidden.setHidden(true);
		// 创建准备以nonCapturing显示的第二份浮层。
		const nonCapturing = new InputOverlay();
		// nonCapturing:true不主动占键盘焦点，不能据名称说它永远不参与任何鼠标命中。
		tui.showOverlay(nonCapturing, { nonCapturing: true });
		// 创建第三份浮层，先正常显示再显式失焦。
		const unfocused = new InputOverlay();
		// 正常show先按默认焦点规则处理，保存控制句柄。
		const unfocusedHandle = tui.showOverlay(unfocused);
		// unfocus保留浮层条目与画面，但释放它的键盘焦点，不是隐藏或移除。
		unfocusedHandle.unfocus();
		// 等三种状态配置后的布局。
		await terminal.waitForRender();
		// nonCapturing浮层focused应false。
		assert.strictEqual(nonCapturing.focused, false);
		// 显式unfocus的浮层focused也应false。
		assert.strictEqual(unfocused.focused, false);

		// PageUp应交正文而非上述未聚焦浮层。
		terminal.sendInput("\x1b[5~");
		// 再送第10列第3行向上滚轮，测试同一组合状态下鼠标路由。
		terminal.sendInput("\x1b[<64;10;3M");
		// 等待输入合并后的画面。
		await terminal.waitForRender();
		// 顶部偏移小于原值，正文确实能上滚；不逐个断言两次事件各滚多少行。
		assert.ok(tui.viewportTop < topBefore);
		// nonCapturing浮层没收到键盘原串。
		assert.deepStrictEqual(nonCapturing.inputs, []);
		// unfocused浮层同样没收到，不能因条目可见就抢键。
		assert.deepStrictEqual(unfocused.inputs, []);
		// 正常停止TUI，栈内容保留在实例内不意味着仍对宿主注册活动输入。
		tui.stop();
	});

	// 搜索虽用聚焦浮层输入框，仍专门允许正文分页与滚轮；打开搜索后送PageUp和向上滚，要求文档移动且紧凑搜索导航仍可见。与普通聚焦浮层接分页键的规则不同。
	it("keeps viewport scrolling while transcript search is focused", async () => {
		// 20列6行窄屏内存终端，搜索栏使用紧凑箭头提示。
		const terminal = new VirtualTerminal(20, 6);
		// 创建实际TUI。
		const tui = new TuiAltScreen(terminal);
		// 12行编号正文，初始跟末尾偏移有余量。
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		// 启动并排帧。
		tui.start();
		// 等待初始布局。
		await terminal.waitForRender();
		// 保存打开搜索之前的顶部偏移，用于最终比较。
		const topBefore = tui.viewportTop;

		// Ctrl+Shift+F打开搜索，尚未输入查询词。
		terminal.sendInput("\x1b[102;6u");
		// 等待搜索浮层绘制。
		await terminal.waitForRender();
		// 窄屏应至少一行有向上空格向下箭头紧凑提示，不要求此前120列例子的完整快捷键长文案。
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ ↓")));

		// 搜索聚焦时送PageUp，专门的视口路由仍可处理它。
		terminal.sendInput("\x1b[5~");
		// 第1列第4行送向上滚轮，另外覆盖鼠标输入。
		terminal.sendInput("\x1b[<64;1;4M");
		// 等待两种输入后的状态与画面。
		await terminal.waitForRender();
		// 文档偏移变小，证明搜索没有把全部视口导航挡掉。
		assert.ok(tui.viewportTop < topBefore);
		// 搜索紧凑提示仍存在，正文滚动不应顺带关闭搜索。
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ ↓")));
		// 正常停止并关闭搜索相关状态。
		tui.stop();
	});

	// 回归#7629：真正SelectList聚焦时，它的capturesViewportInput阻止全屏视口动作抢键。PageDown应选到item3，之后Ctrl+Home也不把聊天滚顶；列表未实现该Ctrl+Home动作时保持所选项，不应注成它跳列表首项。
	it("defers viewport keys to a focused list instead of scrolling the transcript (#7629)", async () => {
		// 20列6行虚拟终端。
		const terminal = new VirtualTerminal(20, 6);
		// 实际TUI，下面挂正文与真实列表。
		const tui = new TuiAltScreen(terminal);
		// 创建SelectList供焦点优先接分页输入。
		const list = new SelectList(
			// 12个item0到item11对象，value与label相同，Array.from每次创建新项。
			Array.from({ length: 12 }, (_, index) => ({ value: `item-${index}`, label: `item-${index}` })),
			// 最大显示3项，因此PageDown从索引0前进一可见页到3。
			3,
			// 主题全部用恒等函数，避免颜色改变观察结果。
			{
				// 保留selectedPrefix接口字段，当前实现实际合并前缀交selectedText，不在本回调生成额外样式。
				selectedPrefix: (text) => text,
				// 选中项文本原样返回。
				selectedText: (text) => text,
				// 描述文本原样返回，样本没有提供description。
				description: (text) => text,
				// 滚动信息原样返回，不增加ANSI。
				scrollInfo: (text) => text,
				// 无匹配提示原样返回，本例不做过滤。
				noMatch: (text) => text,
			},
		);
		// 先加入12行正文，再加列表，整份文档有滚动空间。
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		// 同一个list实例加入文档，下面setFocus也指向这个引用。
		tui.addChild(list);
		// 把焦点交列表，使其capturesViewportInput真正参与路由。
		tui.setFocus(list);
		// 启动并建布局。
		tui.start();
		// 等待首帧，记录当前聊天偏移。
		await terminal.waitForRender();
		// 保存分页输入前的顶部位置。
		const topBefore = tui.viewportTop;

		// 普通PageDown应由列表处理，一页3项，原英文行尾注释保持。
		terminal.sendInput("\x1b[6~"); // PageDown
		// Ctrl+Home也应先交焦点列表，不能被全屏正文跳顶动作抢走；本列表没有对应跳首动作时会忽略。
		terminal.sendInput("\x1b[1;5H"); // Ctrl+Home
		// 等待输入后续渲染。
		await terminal.waitForRender();
		// 最终选择item3，证明PageDown生效且Ctrl+Home没有把它改成item0；可选链缺项会令断言失败。
		assert.strictEqual(list.getSelectedItem()?.value, "item-3");
		// 聊天偏移严格未变，检验焦点列表不会同时触发正文分页/跳顶。
		assert.strictEqual(tui.viewportTop, topBefore);
		// 正常停止，没把列表从实例children手工移除。
		tui.stop();
	});

	// 回归#7629的编辑补全流程：输入/打开12项菜单，PageDown选择索引5的候选且不滚正文，Enter应用斜杠候选并立即提交，菜单关闭后PageUp重新滚文档。提供器完全内存，不枚举文件、不联网。
	it("gives viewport keys back to the transcript when editor autocomplete closes (#7629)", async () => {
		// 40列8行内存终端，正文30行确保有分页空间。
		const terminal = new VirtualTerminal(40, 8);
		// 创建实际备用屏TUI。
		const tui = new TuiAltScreen(terminal);
		// 用共享测试主题构造真实Editor，默认补全最大可见5项；构造不启动用户终端或外部编辑器。
		const editor = new Editor(tui, defaultEditorTheme);
		// submitted初始空串，用来观察onSubmit收到的结果。
		let submitted = "";
		// 注册提交回调，输入完成值来自Editor，不在赋值时触发提交。
		editor.onSubmit = (text) => {
			// 保存这次提交文本，测试后面只核最后值而非提交调用次数。
			submitted = text;
		};
		// 安装自定义补全提供器对象，函数只保存在Editor中，后面输入/才实际请求建议。
		editor.setAutocompleteProvider({
			// getSuggestions是无等待IO的async箭头，括号包对象作为兑现值；忽略接口传来的参数，固定返回12项，不访问文件系统。
			getSuggestions: async () => ({
				// items用Array.from生成12个候选，索引从0起。
				items: Array.from({ length: 12 }, (_, index) => ({
					// 候选替换值带斜杠，如/command-5。
					value: `/command-${index}`,
					// 可见label不含开头斜杠，如command-5，显示文字与插入值区分。
					label: `command-${index}`,
				})),
				// prefix固定为/，告诉Editor这份建议针对斜杠前缀，也影响Enter确认后的提交路径。
				prefix: "/",
			}),
			// applyCompletion接原行数组、光标行、未使用的码元列和选中项，返回新状态对象；箭头的括号是对象表达式，不是函数块。
			applyCompletion: (lines, cursorLine, _cursorCol, item) => ({
				// map创建新数组，只把当前光标行整体替换为item.value，其余行原串保留；本替身不是通用按prefix切片的文件补全算法。
				lines: lines.map((line, index) => (index === cursorLine ? item.value : line)),
				// cursorLine属性简写保留输入行号，不把光标移到别的行。
				cursorLine,
				// 新cursorCol设为插入值length，单位UTF-16码元；这些候选为ASCII，和终端显示列恰好一致，不能推广到emoji。
				cursorCol: item.value.length,
			}),
		});
		// 把30行Text加入文档，初始跟末尾。
		tui.addChild(new Text(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		// 再把真实Editor放到正文后，菜单打开会影响它的渲染高度。
		tui.addChild(editor);
		// 明确聚焦Editor，只有它接到/才触发建议。
		tui.setFocus(editor);
		// 启动TUI并连接虚拟输入链。
		tui.start();
		// 等待初始文档布局。
		await terminal.waitForRender();

		// 输入一个/，真实Editor插入后触发固定建议提供器，不执行斜杠命令本身。
		terminal.sendInput("/");
		// await一次setImmediate让已安排的异步建议处理推进，不是等待所有未来任务或真实IO结束的通用屏障。
		await new Promise((resolve) => setImmediate(resolve));
		// 再等TUI节流帧和xterm队列。
		await terminal.waitForRender();
		// 补全菜单应真正处于显示状态，不能只停在等待建议阶段。
		assert.strictEqual(editor.isShowingAutocomplete(), true);
		// 保存菜单打开后的顶部偏移；菜单高度可能改变视口，不能拿菜单前的旧偏移比较。
		const topWithMenu = tui.viewportTop;
		// PageDown应分页菜单而非聊天，默认可见5项从首项走到索引5；原行尾英文说明保留。
		terminal.sendInput("\x1b[6~"); // PageDown pages the menu
		// 等待菜单选择变化的画面。
		await terminal.waitForRender();
		// 正文偏移与菜单打开后起点相同，排除同时滚动聊天。
		assert.strictEqual(tui.viewportTop, topWithMenu);

		// 回车确认补全，当前斜杠前缀会先应用选中值，再走提交路径；不是直接把原/提交给宿主。
		terminal.sendInput("\r");
		// 等提交后状态和菜单关闭渲染。
		await terminal.waitForRender();
		// onSubmit保存值应/command-5，说明PageDown选中了索引5的第六个候选，并把value而非label交给提交。
		assert.strictEqual(submitted, "/command-5");
		// 菜单应已关闭，Editor的capturesViewportInput随菜单状态变false。
		assert.strictEqual(editor.isShowingAutocomplete(), false);
		// 重新记录关闭菜单后的偏移，不假设菜单关闭前后文档高度相同。
		const topWithoutMenu = tui.viewportTop;
		// 此时PageUp应重新交正文视口动作，而非已经不存在的补全菜单。
		terminal.sendInput("\x1b[5~"); // PageUp scrolls the transcript again
		// 等待正文分页结果。
		await terminal.waitForRender();
		// 偏移小于刚保存的关闭态起点，证明菜单关闭后视口键路由恢复。
		assert.ok(tui.viewportTop < topWithoutMenu);
		// 正常停止本例TUI；文件到此结束测试注册，没有统一afterEach为前面失败的正常路径stop兜底。
		tui.stop();
	});
});
