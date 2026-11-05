/**
 * Alternate-screen large-transcript benchmark.
 *
 * Mirrors the fullscreen transcript shape used by the coding agent:
 *
 * ScrollView
 * └── document Container
 *     ├── header Container
 *     ├── resources Container
 *     └── chat Container
 *         └── 2,500 alternating user/assistant Markdown components
 *
 * Measures warm steady frames, one-line scrolling, streaming updates to the
 * final assistant message, and width changes that invalidate Markdown caches.
 *
 * Run from the repository root:
 *   node --experimental-strip-types packages/tui/test/alt-screen-large-transcript-bench.ts
 */

// 大段聊天记录的备用屏渲染基准：构造2500个Markdown组件，用丢弃输出的NullTerminal依次测静态帧、滚动、末条文字变化和列宽变化；这些是性能样本，没有正确性断言或达标阈值。
// 执行本文件会立即建组件、启动TUI并打印计时；没有启动真实ProcessTerminal，但TUI仍有进程exit监听、调度和能力探测等宿主行为，不能仅凭适配器名字就说完全无副作用。
// 单调时钟performance.now提供毫秒计时，适合测时间差；不取会话时间戳或用户当地时区。
import { performance } from "node:perf_hooks";
// Markdown是实际运行时组件；同一import里的type MarkdownTheme只让TS检查主题回调形状，运行时擦除，不创建主题验证器。
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
// ScrollView提供聊天文档的裁剪与滚动状态，不是本机终端自身的历史滚动缓冲。
import { ScrollView } from "../src/components/scroll-view.ts";
// Text用于页头、资源和底部模拟编辑区；这里没有真实可编辑输入框。
import { Text } from "../src/components/text.ts";
// VStack按竖直方向分配终端格高度，组成滚动文档与底部停靠区。
import { VStack } from "../src/components/v-stack.ts";
// import type只引入Terminal接口供开发期检查，不实例化真实终端或加载一个Terminal运行时构造器。
import type { Terminal } from "../src/terminal.ts";
// Container按顺序组合孩子的渲染行，以下document变量是普通组件，不是浏览器DOM的document。
import { Container } from "../src/tui.ts";
// TuiAltScreen是实际备用屏渲染器；传入的适配器决定输出最终被丢弃，而不把渲染算法换成假实现。
import { TuiAltScreen } from "../src/tui-alt-screen.ts";

// 初始终端宽为80格；const禁止重赋这份数值常量，后面的terminal.columns字段仍可变。
const COLUMNS = 80;
// 终端高为50行，包含聊天视口和底部两行模拟区域所分配的空间。
const ROWS = 50;
// 构造2500个Markdown组件；数字中的下划线只是可读性分隔符，数值仍为2500。
const COMPONENT_COUNT = 2_500;
// 正式计时前同步绘制20帧，用于暖机；没有强制垃圾回收或保证所有运行时优化已稳定。
const WARMUP_FRAMES = 20;

// 主题对象逐项提供字符串到字符串的回调，全部原样返回输入；TS按MarkdownTheme检查必需项，不会在运行时检查主题。没有加额外主题色，不代表Markdown渲染器完全不做格式、边框或其他工作。
const theme: MarkdownTheme = {
	// 标题主题回调接收标题文字并原样返回；箭头表达式体省略return，不立即执行回调。
	heading: (text) => text,
	// 链接显示文字的主题回调原样返回，不在这里访问链接地址。
	link: (text) => text,
	// 链接地址文字的主题回调原样返回，与链接标签文字的回调是不同字段。
	linkUrl: (text) => text,
	// 行内代码主题回调不追加颜色控制串。
	code: (text) => text,
	// 代码块主题回调原样返回传入文字，不因此执行代码示例。
	codeBlock: (text) => text,
	// 代码块边框的主题回调原样保留已生成边框文字，不是禁止渲染器生成边框。
	codeBlockBorder: (text) => text,
	// 引用正文主题回调原样返回输入。
	quote: (text) => text,
	// 引用边界主题回调原样返回，仍可显示渲染器生成的引用标记。
	quoteBorder: (text) => text,
	// 水平分隔线主题回调保留输入文字。
	hr: (text) => text,
	// 列表项目符号主题回调不额外着色，不改变有序与无序列表解析。
	listBullet: (text) => text,
	// 粗体主题回调这里不额外包粗体控制串；返回的仍是同一段字符串值。
	bold: (text) => text,
	// 斜体主题回调同样原样返回。
	italic: (text) => text,
	// 删除线主题回调不额外添加删除线样式。
	strikethrough: (text) => text,
	// 下划线主题回调不额外添加下划线样式；这份主题用于降低外观差异，不验证终端的字体支持。
	underline: (text) => text,
};

// 只为基准提供尺寸和无操作的Terminal实现；implements在TS开发期检查成员兼容性，不在运行时包装类或探测硬件。
// 例如TUI调用write发送一帧时本类直接丢弃字符串，因而计时包含渲染和字符串构造，却不包含真实终端或xterm解析、传输和绘制成本。
class NullTerminal implements Terminal {
	// 公开可变字段columns初始80，resize场景直接修改它来模拟宽度变化；没有自动触发真实resize事件。
	columns = COLUMNS;
	// 公开字段rows初始50，以下场景保持不变。
	rows = ROWS;

	// 启动适配器的空实现：接收输入、尺寸回调但不保存或调用；下划线命名表示参数未使用，void表示不提供有用返回数据，不连接stdin或raw模式。
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	// 停止适配器也为空操作；TUI自身的stop仍会执行其他停止钩子，不能把这个空方法等同整套停止流程。
	stop(): void {}
	// async空实现返回立即兑现为undefined的Promise<void>，表示本适配器无输入可排空；没有真正等待终端安静或移除任何输入监听。
	async drainInput(): Promise<void> {}
	// write接收整段输出字符串后丢弃，不写stdout，也不统计长度；性能日志由后面的console.log单独输出。
	write(_data: string): void {}
	// 只读getter提供Kitty键盘协议状态，读取属性时才执行函数体；不是设置终端图片能力的开关。
	get kittyProtocolActive(): boolean {
		// 固定报告false，不进行Kitty键盘协议协商。
		return false;
	}
	// 接收相对移动行数但不移动任何光标；_lines是普通number参数，不带运行时范围校验。
	moveBy(_lines: number): void {}
	// 隐藏光标请求为空操作，避免实际修改用户终端光标。
	hideCursor(): void {}
	// 显示光标请求也不写控制码；不代表用户终端原本的光标状态得到验证。
	showCursor(): void {}
	// 清除当前行为空操作，不维护一个假的屏幕行缓存。
	clearLine(): void {}
	// 从光标起清除为空操作，输出画面的正确性不靠这个基准验证。
	clearFromCursor(): void {}
	// 清屏为空操作，不清用户当前屏幕。
	clearScreen(): void {}
	// 接收标题但不修改终端窗口标题。
	setTitle(_title: string): void {}
	// 接收进度开关但不显示进度；不影响TUI内部渲染函数是否运行。
	setProgress(_active: boolean): void {}
	// 程序状态上报为空实现；TS允许实现忽略接口调用时多传的实参，运行时不会据此生成真实状态通知。
	setProgramStatus(): void {}
}

// 用户消息样本由数组逐行构造，join用LF拼成Markdown；这些字符串是待展示内容，不是实际给模型发出的请求。
// join不改变原数组元素，用换行连接得到userMarkdown字符串，不会自动在末尾另加换行。
const userMarkdown = [
	// 二级标题样本，供真实Markdown组件解析。
	"## User request",
	// 空字符串与分隔LF共同形成标题后的空行。
	"",
	// 普通用户段落样本，内容只是固定测试文字。
	"Please inspect this implementation carefully and report the relevant behavior.",
	// 再插空行，将下面列表与段落分开。
	"",
	// 第一条无序列表文本，触发Markdown列表布局。
	"- preserve correctness",
	// 第二条无序列表文本，与第一条属于同一段列表。
	"- include concrete evidence",
].join("\n");

// 助手样本同时包含标题、长段落、链接、有序列表、TS代码围栏和引用，以覆盖多种解析与换行路径；数组内容始终只是字符串。
// 将所有助手样本行用LF拼接，作为2500个组件里助手项复用的文本。
const assistantMarkdown = [
	// 助手二级标题样本。
	"## Analysis",
	// 标题后的空行。
	"",
	// 长段落含粗体标记和example.com链接，用于文字布局；Markdown渲染不是HTTP请求，不会因解析这个链接而访问站点。
	"This response contains representative prose with **inline styles**, a [link](https://example.com), and enough words to wrap across terminal rows at realistic widths. The implementation should preserve all observable behavior while avoiding unnecessary allocation.",
	// 空行将长段落和有序列表分开。
	"",
	// 有序列表第一项样本。
	"1. First item with explanatory text and a concrete example.",
	// 有序列表第二项样本。
	"2. Second item with more explanatory text and another example.",
	// 有序列表第三项样本，确保多项列表参与渲染。
	"3. Third item that ensures list rendering is represented.",
	// 空行将列表和代码块分开。
	"",
	// 代码围栏标注ts语言；后面直到闭围栏都是展示用源码文字，不在此执行或接受本文件的TS类型检查。
	"```ts",
	// 展示一个接width、返回字符串数组的函数声明；引用的变量不需要在本基准运行环境存在，因为它只是一行文本。
	"function render(width: number): string[] {",
	// 示例文字声明空行数组，不是为本基准实际分配该示例变量。
	"  const lines: string[] = [];",
	// 代码样本的孩子遍历开始，帮助覆盖代码块的多行与缩进布局。
	"  for (const child of children) {",
	// 样本文字展示子组件按宽度渲染，并不真的调用示例中的child。
	"    const childLines = child.render(width);",
	// 样本文字展示遍历渲染行并追加，作为TS代码块的一行。
	"    for (const line of childLines) lines.push(line);",
	// 样本内的闭合花括号是字符串内容，必须原样保留。
	"  }",
	// 样本文字展示取总行数。
	"  const height = lines.length;",
	// 样本文字展示把起点约束到不小于0。
	"  const start = Math.max(0, from);",
	// 样本文字展示计算不超过总高度的结束位置。
	"  const end = Math.min(height, start + count);",
	// 样本文字展示slice提取一段行，不是实际裁剪本基准的视口。
	"  const visible = lines.slice(start, end);",
	// 样本文字展示布局更新调用，不会调用本文件中不存在的updateLayout。
	"  updateLayout(height, viewportHeight);",
	// 样本文字展示返回可见行数组。
	"  return visible;",
	// 代码样本函数的闭合括号仍属于字符串。
	"}",
	// 关闭代码围栏，让后续文字恢复普通Markdown解析。
	"```",
	// 空行分隔代码块和引用。
	"",
	// 引用段落样本，用于引用前缀和长文本折行。
	"> A quoted conclusion with enough text to exercise wrapping and inline rendering in the real Markdown component.",
	// 再插空行分开引用与最后段落。
	"",
	// 最后的普通助手段落；提到正确性测试只是样本文案，本文件没有因此执行正确性测试。
	"Final paragraph with a concise recommendation and a note about correctness tests.",
].join("\n");

// 创建页头容器，此时只分配内存，不启动TUI。
const header = new Container();
// 加入两逻辑行Text，横向与纵向padding都为0，页头仍按渲染器自身换行规则输出。
header.addChild(new Text("pi benchmark\nheader line", 0, 0));
// 单独建立资源信息容器，模拟真实聊天文档的额外区域。
const resources = new Container();
// 资源区加入一行固定文字，两个padding参数同为0。
resources.addChild(new Text("resource", 0, 0));
// 创建聊天容器，用于按加入顺序保存2500个Markdown孩子。
const chat = new Container();
// 联合类型表示尚未确定最后组件时可为undefined；let允许循环内重赋，TS检查不等于运行时自动存在该组件。
let streamingMarkdown: Markdown | undefined;
// 索引从0递增到2499，逐个构造而不是共享同一个Markdown实例。
for (let index = 0; index < COMPONENT_COUNT; index++) {
	// 偶数索引用用户文本、奇数用助手文本；%求余，三元表达式只选一份文本。Markdown横向padding1、纵向padding0并使用上述主题。
	const markdown = new Markdown(index % 2 === 0 ? userMarkdown : assistantMarkdown, 1, 0, theme);
	// 把新组件引用追加到chat.children，后面渲染才会调用组件render。
	chat.addChild(markdown);
	// 最后一次把组件保存在streamingMarkdown；当前2500的末索引2499为助手，但判断本身只检查是否最后一项，不检查角色。
	if (index === COMPONENT_COUNT - 1) streamingMarkdown = markdown;
}
// 没有最后组件则同步抛错终止，例如组件数改为0会走此分支；当前固定数值满足条件，不能因此省略对联合类型的存在性判断。
if (!streamingMarkdown) throw new Error("Benchmark requires at least one assistant Markdown component");

// 创建整份文档的容器，不是浏览器document对象。
const document = new Container();
// 先加入页头，决定整份文档行序的第一部分。
document.addChild(header);
// 资源区接在页头后面。
document.addChild(resources);
// 最后加入聊天容器；文档高度包含这三部分，而不只统计消息。
document.addChild(chat);

// ScrollView包装整份文档：follow:none不自动跟末尾，primary:true标记为主要滚动区；初始布局后会把请求位置约束到实际范围。
const transcript = new ScrollView(document, { follow: "none", primary: true });
// 停靠区用VStack包两行Text，模拟editor和footer文字，不创建可接收输入的Editor。
const dock = new VStack([new Text("editor\nfooter", 0, 0)]);
// 根VStack按终端高度把上面的滚动区和下面的停靠区竖直排放。
const root = new VStack([
	// 聊天区从basis0起步、grow1分余量、minSize1请求至少一行；空间实在不足时实际布局仍受父尺寸和分配规则约束。
	{ component: transcript, basis: 0, grow: 1, minSize: 1 },
	// 底部以内容自然高度为basis:auto并设minSize1；当前固定文字自然为两行，不把它硬编码成所有情况下都恰好两行。
	{ component: dock, basis: "auto", minSize: 1 },
]);
// 实例化前面的NullTerminal，只建立尺寸字段，不连接用户终端。
const terminal = new NullTerminal();
// 构造实际TuiAltScreen，false关闭硬件光标策略并保存日志目录参数；构造本身不进入备用屏，这份NullTerminal丢弃后续控制码。
const tui = new TuiAltScreen(terminal, false, "/tmp/pi-tui-bench");
// 设置显式布局根，之后备用屏按这个VStack渲染，而不是按addChild的隐式聊天文档渲染。该调用会请求后续帧。
tui.setLayoutRoot(root);
// 实际启动TUI，注册自己的exit兜底并调用启动钩子；NullTerminal不连接输入，但能力探测等公共启动路径仍会执行，不能把调用描述成只构造对象。
tui.start();
// 立即同步画一帧，建立尺寸与布局，并消费此前待渲染标志；不是await等待真实终端显示。
tui.renderNow();

// 单独按当前宽度渲染整个文档后取数组长度，得到含页头/资源/聊天的逻辑渲染总行数；这一步在正式计时之外，也会暖缓存。
const totalLines = document.render(terminal.columns).length;
// 请求滚到总行数的一半并向下取整，ScrollView按实际范围夹值；目标是接近文档中部，不保证视觉上恰好某条消息居中。
transcript.scrollTo(Math.floor(totalLines / 2));
// 同步画20个暖机帧，没有await事件循环；渲染请求可被每次renderNow消费，不等于等20次屏幕刷新周期。
for (let frame = 0; frame < WARMUP_FRAMES; frame++) tui.renderNow();

// 测量一个场景：接名称、帧数与每帧前的同步回调，返回void并打印每帧平均毫秒。每次先运行回调再真实renderNow，回调或渲染抛错直接传出。
// 例如measure的scroll回调每次请求滚一行，所以平均值包含滚动状态更新和渲染，不是单独测某个内部函数；不校验帧数为正，也不负责finally停止TUI。
function measure(name: string, frames: number, beforeFrame: (frame: number) => void): void {
	// 在循环前读取单调时钟，计时不包含前面创建2500个组件的初始化成本。
	const start = performance.now();
	// 同步执行给定帧数；没有按显示器刷新率主动等待，测的是尽快连续调用的成本。
	for (let frame = 0; frame < frames; frame++) {
		// 先调用传入回调并传0起索引，其返回值被忽略，不会await异步工作。
		beforeFrame(frame);
		// 回调更新后同步渲染一帧，即使画面没变化也走实际渲染器。
		tui.renderNow();
	}
	// 总耗时除帧数得到算术平均毫秒，包含循环及回调开销；不是百分位数、CPU专用时间或通用性能保证。
	const millisecondsPerFrame = (performance.now() - start) / frames;
	// 以三位小数打印平均值与帧数；格式化和这一条console输出发生在前面的计时取值之后。
	console.log(`${name}: ${millisecondsPerFrame.toFixed(3)} ms/frame (${frames} frames)`);
}

// 先打印组件数、已渲染总行数和模拟尺寸，便于解释不同机器测得的样本。
console.log(`components=${COMPONENT_COUNT} lines=${totalLines} viewport=${terminal.columns}x${terminal.rows}`);
// 空回调的200帧静态场景仍会做渲染与输出字符串构造；write被丢弃不等于整帧零分配。
measure("steady", 200, () => {});
// 滚动场景前重新请求中部位置；后续场景没有统一重建全部组件或清空所有缓存。
transcript.scrollTo(Math.floor(totalLines / 2));
// 每帧将ScrollView向下滚一行并绘制，共200次；达到边界时会夹值，不能把请求次数当作必定成功移动200行。
measure("scroll", 200, () => transcript.scrollBy(1));
// 流式样本回调在100帧中逐次改最后组件文字，模拟更新，不启动真实模型流。
measure("streaming", 100, (frame) => {
	// 每次用原助手正文加两个LF和递增长度x串调用setText，清该Markdown的相关渲染缓存；不是在上次完整文本上无限重复拼接，也不自动请求跟随到文档末尾，所以末条变化可能在屏外。
	streamingMarkdown.setText(`${assistantMarkdown}\n\nstream ${"x".repeat(frame + 1)}`);
});
// 列宽变化场景再测10帧，复用已经被流式场景修改过的组件状态。
measure("resize", 10, (frame) => {
	// 把模拟columns在79和80之间交替，下一次renderNow读到不同宽度而重新布局；没有向操作系统发resize或回调真实终端事件。
	terminal.columns = frame % 2 === 0 ? COLUMNS - 1 : COLUMNS;
});

// 仅在前面流程正常走完时停止TUI并解除自己的exit/普通渲染调度；默认停后还会重新渲染完整文档并重放给NullTerminal丢弃，这部分不在场景计时内。没有try/finally，前面异常时不保证走到这里，适配器stop本身为空操作。
tui.stop();
