// 用内存xterm模拟器检查浮层选项的布局/合成以及停止后光标调用；不连接真实TTY、剪贴板或链接目标。
// 异步用例通过nextTick、短定时等待和写队列屏障读屏；多条回归只确认流程未抛错/快照存在，不能把测试标题当成完整的尺寸断言。
// Node断言失败会抛错；这些测试正常末尾stop，没有try/finally保证失败路径也停止TUI。
import assert from "node:assert";
// describe分组，it注册同步或async回调；运行器会等待async回调返回的Promise，不在此启动整套测试。
import { describe, it } from "node:test";
// type导入只供TypeScript检查组件和TUI契约，执行JS时擦除，不构造终端。
import type { Component, TUI } from "../src/tui.ts";
// 使用正常主屏实现生成控制序列，但通过下面的VirtualTerminal把全部输出限制在内存模拟器。
import { TuiMainScreen } from "../src/tui-main-screen.ts";
// 共享测试适配器实现Terminal接口，屏幕读取要等写队列解析；它没有继承真实ProcessTerminal的系统输入操作。
import { VirtualTerminal } from "./virtual-terminal.ts";

// 固定行浮层替身：实现组件契约并记录render收到的宽度，故意不自己裁行，便于检验TUI合成层如何处理超宽内容。
class StaticOverlay implements Component {
	// 保存调用方行数组引用；private是TS访问限制，不会复制数组或形成JS的#私有字段。
	private lines: string[];
	// 可省的number记录最近请求宽度；首次render前可undefined，之后用于精确断言布局交给组件的列数。
	requestedWidth?: number;

	// 接收固定行数组和可选初始宽度记录，无显式返回；只保存引用，不读取屏幕。例new StaticOverlay(["abc"])初始未记宽，render(20)后记录20。
	constructor(lines: string[], requestedWidth?: number) {
		// 保存原数组而非克隆；本测试后面不再改该数组。
		this.lines = lines;
		// 即使省略参数也会赋undefined，作为尚无宽度记录的初态。
		this.requestedWidth = requestedWidth;
	}

	// render接分配列数、返回固定行数组，并改requestedWidth；例100个X在width20下仍全数返回，由外层负责保护，不保证组件自身守宽。
	render(width: number): string[] {
		// Store the width we were asked to render at for verification
		// 记录每次render实际收到的width；若一帧调用多次，留下最后一次值，不累计调用次数。
		this.requestedWidth = width;
		// 返回同一个行数组，不按width截断、换行或填充。
		return this.lines;
	}

	// 失效通知的空实现：没有缓存需要清除，返回void，不意味着外层TUI不再重画。
	invalidate(): void {}
}

// 在虚拟终端上增加同步光标调用记录；不借此读取真实终端，也不等待xterm模式位解析完成。
class CursorTrackingTerminal extends VirtualTerminal {
	// 初始记录可见；这是替身自己的布尔值，和异步模拟器内部状态分开。
	cursorVisible = true;

	// 覆写隐藏接口：先同步标false，再调用父实现排队隐藏控制码，无参数/返回；例stop后误调它会立刻被最终断言发现。
	override hideCursor(): void {
		// 记录最近一次请求为隐藏，不表示控制码已经被xterm消费。
		this.cursorVisible = false;
		// super指父类VirtualTerminal，保留其正常的内存控制码写入行为。
		super.hideCursor();
	}

	// 覆写显示接口：同步记true并委托父类排队显示，供stop→hideOverlay回归比较；不会触及用户shell光标。
	override showCursor(): void {
		// 请求显示后立即更新本地记录。
		this.cursorVisible = true;
		// 仍调用父实现，让替身除记录外保持原有模拟写入流程。
		super.showCursor();
	}
}

// 空的基础组件让用例主要观察浮层；implements只检查方法契约，不自动继承任何组件运行逻辑。
class EmptyContent implements Component {
	// render无需使用宽度，可少声明接口里未用的参数；每次返回新的空行数组，表示基础正文没有行。
	render(): string[] {
		// 空数组不等于终端没有视口行，TUI合成浮层时仍可补足屏高。
		return [];
	}
	// 无缓存的失效通知不做事，返回void。
	invalidate(): void {}
}

// 请求强制帧，再给nextTick绘制与xterm写队列完成机会，返回Promise<void>；不返回快照或保证任意未来动画都已稳定。
// 例如await renderAndFlush(tui, terminal)后再getViewport；本函数同步步骤/等待拒绝可使Promise拒绝，另排nextTick里的绘制异常不由此Promise捕获，没有统一catch。
async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	// true先重置主屏渲染状态并排低延迟nextTick绘制，不是在这一行同步画完。
	tui.requestRender(true);
	// 泛型void表示Promise无业务结果；执行器现在注册resolve到nextTick，await让已排绘制有机会先运行。
	await new Promise<void>((resolve) => process.nextTick(resolve));
	// 共享waitForRender还经过nextTick、约20ms的真实timer及flush屏障；只涉及测试进程调度与内存写队列。
	await terminal.waitForRender();
}

// 总组注册浮层各类配置测试；子回调用于声明用例，不会替每个测试自动统一清理TUI。
describe("TUI overlay options", () => {
	// 超宽与样式边界回归组；重点包含若干未抛错检查，具体证明范围以每个assert为准。
	describe("width overflow protection", () => {
		// 让组件返回100列而只分配20列，走合成保护路径；async回调等帧后检查视口条目，未直接断言截后的字符数或可见宽度。
		it("should truncate overlay lines that exceed declared width", async () => {
			// 创建80列24行的内存屏，尺寸只影响模拟器和TUI布局。
			const terminal = new VirtualTerminal(80, 24);
			// 构造主屏并用TUI接口限制本地可访问API；类型注解不会换成另一个运行时对象。
			const tui: TUI = new TuiMainScreen(terminal);
			// Overlay declares width 20 but renders lines much wider
			// repeat构造100个ASCII X，固定组件故意不按后续20列预算自行裁剪。
			const overlay = new StaticOverlay(["X".repeat(100)]);

			// 挂载没有正文的组件，避免基础内容干扰超宽浮层场景。
			tui.addChild(new EmptyContent());
			// 保存浮层及width20配置，稍后合成会按宽度render并截掉超宽行；这里尚未测量最终几何。
			tui.showOverlay(overlay, { width: 20 });
			// 启动连接的是虚拟适配器，注册本实例exit恢复回调并排首帧，不接管真实stdin。
			tui.start();
			// 等强制帧和模拟器解析，再读取快照，避免仅因队列尚未执行而看见空旧屏。
			await renderAndFlush(tui, terminal);

			// Should not crash, and no line should exceed terminal width
			// 取得24行文字快照，末尾空单元会被xterm裁去，ANSI样式不包含在这些字符串里。
			const viewport = terminal.getViewport();
			// 遍历快照各行，没有在循环中计算length或终端可见宽度。
			for (const line of viewport) {
				// visibleWidth not available here, but line length is a rough check
				// The important thing is it didn't crash
				// 这里只断言每行不是undefined，连空字符串也通过；原英文期望“no line should exceed”没有对应宽度断言。
				assert.ok(line !== undefined);
			}
			// 正常完成后取消TUI渲染timer/exit监听、显示模拟光标并停虚拟输入；前面断言抛错时不会自动执行到这里。
			tui.stop();
		});

		// 把真彩SGR和OSC8链接与长正文放进窄浮层；等待合成后只验证快照有行，测试不访问URL，也不逐项核验样式或截宽结果。
		it("should handle overlay with complex ANSI sequences without crashing", async () => {
			// 80×24内存屏承载这条复杂控制序列场景。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏复用实际合成器，终端输出仍全交虚拟适配器。
			const tui: TUI = new TuiMainScreen(terminal);
			// Simulate complex ANSI content like the crash log showed
			// 用字符串加法组成同一行，三段分别提供颜色、链接和超长尾部。
			const complexLine =
				// 第一段开启背景/前景RGB色，写文字后恢复默认前/背景；转义码本身不占可见列。
				"\x1b[48;2;40;50;40m \x1b[38;2;128;128;128mSome styled content\x1b[39m\x1b[49m" +
				// 第二段用OSC8把link文字包装成HTTP链接后关闭；地址仅交模拟器解析，不发HTTP请求。
				"\x1b]8;;http://example.com\x07link\x1b]8;;\x07" +
				// 尾部普通内容重复10次，让整行远超后续60列分配宽度。
				" more content ".repeat(10);
			// 三条相同行组成固定浮层，既覆盖横向裁剪也让合成器处理多行控制序列。
			const overlay = new StaticOverlay([complexLine, complexLine, complexLine]);

			// 基础正文仍为空，只观察复杂浮层的执行流程。
			tui.addChild(new EmptyContent());
			// 声明宽60列，小于输入文字总宽但不限制组件返回原长行。
			tui.showOverlay(overlay, { width: 60 });
			// 连接虚拟屏并排首帧，不启真实终端。
			tui.start();
			// 等待指定帧和模拟器写入后再断言。
			await renderAndFlush(tui, terminal);

			// Should not crash
			// 读取视口数组，不保留原SGR/OSC控制串的原始字节。
			const viewport = terminal.getViewport();
			// 只要求数组非空；24行的空正文视口也能满足，主要由此前await未抛错覆盖原崩溃路径。
			assert.ok(viewport.length > 0);
			// 正常收尾停止本实例，清理渲染调度与虚拟输入回调。
			tui.stop();
		});

		// 在红色粗体基础行上覆盖普通文字，等帧后确认OVERLAY可见；不检查每个单元格颜色是否完全正确。
		it("should handle overlay composited on styled base content", async () => {
			// 独立80×24模拟屏，避免复用上一测试的正文状态。
			const terminal = new VirtualTerminal(80, 24);
			// 新建主屏实现，后续基础内容和浮层都由它合成。
			const tui: TUI = new TuiMainScreen(terminal);

			// Base content with styling
			// 局部组件只为此场景提供有SGR样式的底层行，不导出到公共API。
			class StyledContent implements Component {
				// 接收基础布局宽，返回三条等宽样式行，无其他状态修改；例如width80产生80个X，再包颜色/粗体控制码。
				render(width: number): string[] {
					// 模板插值只重复正文X，外围依次粗体、红前景和SGR0复位；字节长度大于可见列数。
					const styledLine = `\x1b[1m\x1b[38;2;255;0;0m${"X".repeat(width)}\x1b[0m`;
					// 三个数组元素共享不可变的字符串值，不是三次不同颜色计算。
					return [styledLine, styledLine, styledLine];
				}
				// 局部固定组件没有失效缓存，invalidate为空实现。
				invalidate(): void {}
			}

			// 浮层只返回一行OVERLAY文字，长度7，实际覆盖矩形仍按width20处理。
			const overlay = new StaticOverlay(["OVERLAY"]);

			// 将有样式的组件放入基础正文树，不作为另一个浮层。
			tui.addChild(new StyledContent());
			// center锚点使20列、一行浮层在屏内居中，后续按实际返回行数算纵坐标。
			tui.showOverlay(overlay, { width: 20, anchor: "center" });
			// 启动虚拟终端与渲染调度。
			tui.start();
			// 强制整帧并等内存屏解析输出。
			await renderAndFlush(tui, terminal);

			// Should not crash and overlay should be visible
			// 读取可见文字行，颜色控制码已由模拟器解释。
			const viewport = terminal.getViewport();
			// some查任一行是否含OVERLAY；可选调用在行缺失时给undefined，不会在这里核对具体行列。
			const hasOverlay = viewport.some((line) => line?.includes("OVERLAY"));
			// 断言至少出现一处文字，失败时显示自定义说明，不证明周围所有样式都恢复正确。
			assert.ok(hasOverlay, "Overlay should be visible");
			// 停止TUI恢复模拟光标，避免正常路径留下exit监听/渲染timer。
			tui.stop();
		});

		// 混合宽字放进奇数列预算，执行跨宽字边界的保护流程；断言只为视口数组非空，没有验证切口具体保留了哪些字。
		it("should handle wide characters at overlay boundary", async () => {
			// 80×24内存屏按终端格解释宽字位置，不借用用户真实屏幕。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏合成器负责终端列宽，不由固定浮层按字符串length裁剪。
			const tui: TUI = new TuiMainScreen(terminal);
			// Wide chars (each takes 2 columns) at the edge of declared width
			// 正文混合中文、日文、韩文宽字；这些样例字通常占2列，不能把UTF-16长度当终端列数。
			const wideCharLine = "中文日本語한글テスト漢字"; // Mix of CJK chars
			// 固定行组件照原样返回宽字串，不处理15列边界。
			const overlay = new StaticOverlay([wideCharLine]);

			// 无基础正文，以免边界外文字来自底层组件而混淆场景。
			tui.addChild(new EmptyContent());
			// 15为奇数列预算，宽字可能跨最后一列；合成器超宽时用严格列切片，跨边界整字丢弃。
			tui.showOverlay(overlay, { width: 15 }); // Odd width to potentially hit boundary
			// 启动的是模拟输入/输出适配器。
			tui.start();
			// 等强制帧并flush后观察，不把排队尚未处理当作正确裁剪。
			await renderAndFlush(tui, terminal);

			// Should not crash
			// 收集当前视口所有行。
			const viewport = terminal.getViewport();
			// 仅判断数组有行，不检查行宽、剩余字形或边界是否为空格。
			assert.ok(viewport.length > 0);
			// 正常结束后停止本TUI。
			tui.stop();
		});

		// 把超长固定行放在最右20列，回归右边界合成路径；只验证执行到快照检查，无精确列宽断言。
		it("should handle overlay positioned at terminal edge", async () => {
			// 终端总宽80为后面col60+width20提供恰好贴右的几何。
			const terminal = new VirtualTerminal(80, 24);
			// 以接口类型保存具体主屏实例，渲染仍走真实主屏逻辑。
			const tui: TUI = new TuiMainScreen(terminal);
			// Overlay positioned at right edge with content that exceeds declared width
			// 50个X超过声明20列，故意让合成层做截宽保护。
			const overlay = new StaticOverlay(["X".repeat(50)]);

			// 基础行为空，右边界正文只来自浮层。
			tui.addChild(new EmptyContent());
			// Position at col 60 with width 20 - should fit exactly at right edge
			// 绝对起列60、宽20；没有显式行，纵向仍按默认center定位。
			tui.showOverlay(overlay, { col: 60, width: 20 });
			// 连接虚拟终端并请求首帧。
			tui.start();
			// 强制绘制并等队列，实际返回Promise由测试运行器等待。
			await renderAndFlush(tui, terminal);

			// Should not crash
			// 得到视口数组，未按第60列提取字符检查。
			const viewport = terminal.getViewport();
			// 非空数组是很弱的回归断言，不能单独证明刚好画在最右20列。
			assert.ok(viewport.length > 0);
			// 正常路径停掉主屏实例。
			tui.stop();
		});

		// 基础行内有OSC8文件链接，再覆盖居中浮层，回归控制串切片崩溃；不读取该文件、不打开链接，结果只检查视口有行。
		it("should handle overlay on base content with OSC sequences", async () => {
			// 独立80×24内存屏处理链接控制序列。
			const terminal = new VirtualTerminal(80, 24);
			// 实际主屏在模拟适配器上运行。
			const tui: TUI = new TuiMainScreen(terminal);

			// Base content with OSC 8 hyperlinks (like file paths in agent output)
			// 局部链接基础组件提供三条相同测试行，不参与系统文件访问。
			class HyperlinkContent implements Component {
				// 接布局宽生成可见文字/链接/重复尾部并返回三行；本例宽80使repeat(width-30)为50，不检验更小宽度下的负repeat。
				render(width: number): string[] {
					// file URL只是OSC8的固定载荷，显示名为file.ts；模板里没有真实文件读取。
					const link = `\x1b]8;;file:///path/to/file.ts\x07file.ts\x1b]8;;\x07`;
					// 模板插入链接控制串和width-30个X，近似填长基础行，不保证该公式使可见宽恰等width。
					const line = `See ${link} for details ${"X".repeat(width - 30)}`;
					// 三个相同字符串组成基础行数组。
					return [line, line, line];
				}
				// 无局部渲染缓存，失效通知不做事。
				invalidate(): void {}
			}

			// 浮层文字固定OVERLAY-TEXT，不带自己的链接。
			const overlay = new StaticOverlay(["OVERLAY-TEXT"]);

			// 把链接组件作为底层正文，让浮层覆盖其部分显示列。
			tui.addChild(new HyperlinkContent());
			// 浮层分配20列并居中，裁切底层时要保留控制序列语法边界。
			tui.showOverlay(overlay, { anchor: "center", width: 20 });
			// 开启模拟渲染/输入连接。
			tui.start();
			// 等待强制帧和写队列解析，不等待任何网络或文件操作。
			await renderAndFlush(tui, terminal);

			// Should not crash - this was the original bug scenario
			// 只读可见文字，不能用它复原每个OSC8字节或链接状态。
			const viewport = terminal.getViewport();
			// 数组非空配合此前未抛错覆盖崩溃回归，没有断言OVERLAY-TEXT本身一定出现。
			assert.ok(viewport.length > 0);
			// 正常结束后stop本虚拟TUI。
			tui.stop();
		});
	});

	// 宽度百分比组直接检查render参数，精确程度高于前一组的非空快照检查。
	describe("width percentage", () => {
		// 在100列屏中配置50%，等渲染后要求组件收到50列；回调返回Promise供运行器等候。
		it("should render overlay at percentage of terminal width", async () => {
			// 100列让50%换算没有取整歧义，屏高仍24行。
			const terminal = new VirtualTerminal(100, 24);
			// 主屏按终端完整列数换算width百分比。
			const tui: TUI = new TuiMainScreen(terminal);
			// test只有4个可见字符，记录的是分配宽度，不以正文长度推断布局宽。
			const overlay = new StaticOverlay(["test"]);

			// 基础正文空，主要查看浮层的宽度记录。
			tui.addChild(new EmptyContent());
			// width50%以完整终端宽为参考，正常无margin时请求50列。
			tui.showOverlay(overlay, { width: "50%" });
			// 启动虚拟主屏，允许render真正被调用。
			tui.start();
			// 等待绘制后再读requestedWidth，否则可能仍是undefined。
			await renderAndFlush(tui, terminal);

			// 严格比较数字50，不接受字符串"50"；只证明组件收到的宽度，不检查全部像素/单元位置。
			assert.strictEqual(overlay.requestedWidth, 50);
			// 停止TUI正常收尾。
			tui.stop();
		});

		// 100列的10%先得10，再被minWidth30抬高；等帧后精确断言30，没有覆盖屏幕窄于最小宽时的上限冲突。
		it("should respect minWidth when widthPercent results in smaller width", async () => {
			// 总宽100足以容纳minWidth30，避免可用宽上限进一步裁掉请求。
			const terminal = new VirtualTerminal(100, 24);
			// 构造负责实际百分比与最小宽计算的主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 短正文让观察点集中于render参数，不靠长内容撑开宽度。
			const overlay = new StaticOverlay(["test"]);

			// 加入空基础组件，保持与其他浮层测试相同的内容入口。
			tui.addChild(new EmptyContent());
			// 百分比先换算、minWidth再抬高、最后按可用宽夹取；这条无边距，最终30。
			tui.showOverlay(overlay, { width: "10%", minWidth: 30 });
			// 启动虚拟连接并排帧。
			tui.start();
			// 等实际render记录请求值。
			await renderAndFlush(tui, terminal);

			// 严格断言30列，minWidth不表示给正文补30个可见字符。
			assert.strictEqual(overlay.requestedWidth, 30);
			// 正常停本实例。
			tui.stop();
		});
	});

	// 锚点定位组观察视口中的文字位置，坐标从0起；不会据标题自动覆盖所有9种锚点。
	describe("anchor positioning", () => {
		// 左上锚点应使短标签从第一行开头出现；async等待帧后读屏，再停TUI。
		it("should position overlay at top-left", async () => {
			// 80×24模拟屏，左上对应视口行0列0。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏将浮层锚点换算为实际行列。
			const tui: TUI = new TuiMainScreen(terminal);
			// TOP-LEFT为8个ASCII字符，放入后面的10列预算。
			const overlay = new StaticOverlay(["TOP-LEFT"]);

			// 基础正文为空，第一行标签容易定位。
			tui.addChild(new EmptyContent());
			// 锚点top-left、宽10，无margin/offset时应从(0,0)开始。
			tui.showOverlay(overlay, { anchor: "top-left", width: 10 });
			// 启动虚拟适配器并排首帧。
			tui.start();
			// 等待强制整帧和模拟器解析。
			await renderAndFlush(tui, terminal);

			// 取得当时可见行数组，不自动再等待后续绘制。
			const viewport = terminal.getViewport();
			// 可选调用在行缺失时返回undefined，assert.ok会失败；startsWith要求标签就在第一行字符串开头。
			assert.ok(viewport[0]?.startsWith("TOP-LEFT"), `Expected TOP-LEFT at start, got: ${viewport[0]}`);
			// 正常路径stop，清理渲染与输入回调。
			tui.stop();
		});

		// 右下锚点样例检查末行含标签且它位于去尾空白后的文字尾部；并未精确断言标签最后一个字符占终端第79列。
		it("should position overlay at bottom-right", async () => {
			// 24行使最后行索引为23，总宽80用于锚点计算。
			const terminal = new VirtualTerminal(80, 24);
			// 具体主屏按浮层声明矩形定位。
			const tui: TUI = new TuiMainScreen(terminal);
			// BTM-RIGHT为9个ASCII字符，声明宽10，因此矩形贴右不等于最后字也贴最右一格。
			const overlay = new StaticOverlay(["BTM-RIGHT"]);

			// 没有基础正文，快照里不会混入其他末行标签。
			tui.addChild(new EmptyContent());
			// bottom-right按10列宽、一行高计算起点，正常起列70、起行23，短正文后可有填充空格。
			tui.showOverlay(overlay, { anchor: "bottom-right", width: 10 });
			// 启动内存终端。
			tui.start();
			// 等帧后再读最后行。
			await renderAndFlush(tui, terminal);

			// 取24行视口快照。
			const viewport = terminal.getViewport();
			// Should be on last row, ending at last column
			// 索引23选最后一行；这是行数组下标，不是终端协议的1基第24行参数。
			const lastRow = viewport[23];
			// 先证明该行存在且含BTM-RIGHT，失败说明会带当前整行。
			assert.ok(lastRow?.includes("BTM-RIGHT"), `Expected BTM-RIGHT on last row, got: ${lastRow}`);
			// trimEnd先去掉尾空格再判断标签后缀，因此不证明文字抵到最后物理列，原英文注释比实际断言更强。
			assert.ok(lastRow?.trimEnd().endsWith("BTM-RIGHT"), `Expected BTM-RIGHT at end, got: ${lastRow}`);
			// 停止TUI收尾。
			tui.stop();
		});

		// 上方居中锚点只要求第一行含标签，字符起点落在30到40之间；理论起点35是实现推导，断言采用较宽区间。
		it("should position overlay at top-center", async () => {
			// 80列减浮层10列得70，可居中起点35；24行不影响top的纵坐标。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏计算横向锚点，虚拟屏只消费最终控制序列。
			const tui: TUI = new TuiMainScreen(terminal);
			// CENTERED是8个ASCII字符，起点计算仍按声明10列矩形。
			const overlay = new StaticOverlay(["CENTERED"]);

			// 空底层内容让第一行位置易于辨认。
			tui.addChild(new EmptyContent());
			// top-center强制顶行，横向把10列矩形居中。
			tui.showOverlay(overlay, { anchor: "top-center", width: 10 });
			// 启动虚拟TUI。
			tui.start();
			// 等渲染与队列完成机会。
			await renderAndFlush(tui, terminal);

			// 读取当前屏幕文字。
			const viewport = terminal.getViewport();
			// Should be on first row, centered horizontally
			// 只取第一行，不在其他行搜索CENTERED。
			const firstRow = viewport[0];
			// 证明标签在顶行出现，后面另检查横向范围。
			assert.ok(firstRow?.includes("CENTERED"), `Expected CENTERED on first row, got: ${firstRow}`);
			// Check it's roughly centered (col 35 for width 10 in 80 col terminal)
			// indexOf返回UTF-16下标，找不到为-1；本例前缀只有ASCII空格，故该下标可用来代表起列。
			const colIndex = firstRow?.indexOf("CENTERED") ?? -1;
			// &&要求起点同时不小于30且不大于40，不是严格等于35的断言。
			assert.ok(colIndex >= 30 && colIndex <= 40, `Expected centered, got col ${colIndex}`);
			// 正常结束停主屏。
			tui.stop();
		});
	});

	// 边距组覆盖负数夹0、四边同值和逐边对象设置；不是对任意超大/非有限边距的完整校验。
	describe("margin", () => {
		// 负top/left被夹为0，等帧后断言标签从首行开头出现；没有直接读取内部margin对象。
		it("should clamp negative margins to zero", async () => {
			// 80×24模拟屏提供正常范围，不构造边距超过整个屏幕的场景。
			const terminal = new VirtualTerminal(80, 24);
			// 实际主屏负责规范配置负边距。
			const tui: TUI = new TuiMainScreen(terminal);
			// NEG-MARGIN为测试标签，不参与边距计算。
			const overlay = new StaticOverlay(["NEG-MARGIN"]);

			// 空正文提供干净的左上角观察区。
			tui.addChild(new EmptyContent());
			// Negative margins should be treated as 0
			// 配置对象传给showOverlay，由稍后布局读取，不是调用时就同步完成定位。
			tui.showOverlay(overlay, {
				// top-left把起点放在规范后的上/左边距位置。
				anchor: "top-left",
				// 声明12列容纳10字符标签和剩余覆盖空间。
				width: 12,
				// 上-5、左-10将分别夹0，右/下显式0不再缩小可用区。
				margin: { top: -5, left: -10, right: 0, bottom: 0 },
			});
			// 启动虚拟输入输出连接。
			tui.start();
			// 等待布局与模拟写入完成。
			await renderAndFlush(tui, terminal);

			// 读取视口第一行所在的快照数组。
			const viewport = terminal.getViewport();
			// Should be at row 0, col 0 (negative margins clamped to 0)
			// startsWith证明行0列0开始就是标签，间接覆盖负top/left的夹取结果。
			assert.ok(viewport[0]?.startsWith("NEG-MARGIN"), `Expected NEG-MARGIN at start of row 0, got: ${viewport[0]}`);
			// 正常路径停止TUI。
			tui.stop();
		});

		// 单个数字margin5应用四边，等帧后验证标签在行5列5且不在行0/4；没有逐个检查右/下空白。
		it("should respect margin as number", async () => {
			// 80×24给四边5格留白后仍有70列14行可用区。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏用同一个数构造四边margin再算锚点。
			const tui: TUI = new TuiMainScreen(terminal);
			// MARGIN标签6字符，声明矩形仍宽10。
			const overlay = new StaticOverlay(["MARGIN"]);

			// 基础正文空，便于判断标签确切行。
			tui.addChild(new EmptyContent());
			// top-left在四边margin5时从上/左各5格处开始，宽10未碰可用宽上限。
			tui.showOverlay(overlay, { anchor: "top-left", width: 10, margin: 5 });
			// 启动模拟终端。
			tui.start();
			// 等帧后读取文字位置。
			await renderAndFlush(tui, terminal);

			// 读取完整可见行数组。
			const viewport = terminal.getViewport();
			// Should be on row 5 (not 0) due to margin
			// 逻辑非把“不含标签”变成断言条件，确认行0不包含MARGIN；行缺失时也会因!undefined通过此否定检查。
			assert.ok(!viewport[0]?.includes("MARGIN"), "Should not be on row 0");
			// 再排除紧邻目标前一行4，仍是文字包含关系而不是几何对象比较。
			assert.ok(!viewport[4]?.includes("MARGIN"), "Should not be on row 4");
			// 正向要求行5含标签，因此不能靠所有行都缺失来通过这一组检查。
			assert.ok(viewport[5]?.includes("MARGIN"), `Expected MARGIN on row 5, got: ${viewport[5]}`);
			// Should start at col 5 (not 0)
			// 取行5里标签起始ASCII下标，行缺失时??返回-1供后续失败。
			const colIndex = viewport[5]?.indexOf("MARGIN") ?? -1;
			// 严格要求起点5，明确验证水平margin；模板失败说明只用于测试报告。
			assert.strictEqual(colIndex, 5, `Expected col 5, got ${colIndex}`);
			// 停止本实例，避免正常路径继续绘制。
			tui.stop();
		});

		// 边距对象只把上设2、左设3，等帧后验证行2列3；右/下0保持其余可用空间。
		it("should respect margin object", async () => {
			// 80×24内存终端用于本条独立布局。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏解析各边不同的margin配置。
			const tui: TUI = new TuiMainScreen(terminal);
			// 复用固定MARGIN文字，和前一用例没有共享实例状态。
			const overlay = new StaticOverlay(["MARGIN"]);

			// 基础正文不生成行。
			tui.addChild(new EmptyContent());
			// 展开多行对象便于逐项给出锚点、宽度和边距。
			tui.showOverlay(overlay, {
				// top-left锚点使用规范后的顶部和左侧margin作起点。
				anchor: "top-left",
				// 请求宽10，不按标签6字符自动缩窄。
				width: 10,
				// top2/left3分别影响纵/横起点，right0/bottom0不额外收缩对应末端。
				margin: { top: 2, left: 3, right: 0, bottom: 0 },
			});
			// 启动虚拟终端连接。
			tui.start();
			// 等主屏绘制和xterm解析。
			await renderAndFlush(tui, terminal);

			// 读屏取得独立快照，不直接查看内部浮层矩形。
			const viewport = terminal.getViewport();
			// 要求标签确实落在行2，缺行时可选调用令断言失败。
			assert.ok(viewport[2]?.includes("MARGIN"), `Expected MARGIN on row 2, got: ${viewport[2]}`);
			// 找行2内标签起始位置，找不到或缺行最终用-1。
			const colIndex = viewport[2]?.indexOf("MARGIN") ?? -1;
			// 严格要求列3；本标签/前缀为ASCII，因此下标与列数一致。
			assert.strictEqual(colIndex, 3, `Expected col 3, got ${colIndex}`);
			// 停止TUI正常收尾。
			tui.stop();
		});
	});

	// 偏移组把offset加在锚点算出的坐标上，之后仍可被边界夹取；本样例位于安全屏内，没有覆盖夹边界情形。
	describe("offset", () => {
		// 从左上锚点向右10列、向下5行，读屏后分别验证目标行和起列。
		it("should apply offsetX and offsetY from anchor position", async () => {
			// 80×24容纳(10,5)起点及10列宽矩形。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏实际组合锚点和偏移参数。
			const tui: TUI = new TuiMainScreen(terminal);
			// 固定OFFSET标签6字符，数组表示一行浮层。
			const overlay = new StaticOverlay(["OFFSET"]);

			// 空基础内容不会遮挡偏移目标。
			tui.addChild(new EmptyContent());
			// offsetX正10向右，offsetY正5向下；它们不是设置浮层宽高。
			tui.showOverlay(overlay, { anchor: "top-left", width: 10, offsetX: 10, offsetY: 5 });
			// 启动模拟TUI。
			tui.start();
			// 等布局结果实际写入内存屏。
			await renderAndFlush(tui, terminal);

			// 读取可见文字用于定位。
			const viewport = terminal.getViewport();
			// 先要求标签出现在行5，验证纵向偏移。
			assert.ok(viewport[5]?.includes("OFFSET"), `Expected OFFSET on row 5, got: ${viewport[5]}`);
			// 再取该行ASCII文字起点，缺失回退-1。
			const colIndex = viewport[5]?.indexOf("OFFSET") ?? -1;
			// 严格要求列10，验证横向偏移。
			assert.strictEqual(colIndex, 10, `Expected col 10, got ${colIndex}`);
			// 正常路径停止主屏。
			tui.stop();
		});
	});

	// 位置百分比不是宽高百分比：使用扣margin/浮层尺寸后的可移动距离，100%使浮层贴对应边。
	describe("percentage positioning", () => {
		// 同时配置row/col50%模拟居中，但实际只断言找到的行在10..13之间，没有验证水平起列。
		it("should position with rowPercent and colPercent", async () => {
			// 24行屏中一行高浮层的可移动纵距为23行，50%向下取整为11。
			const terminal = new VirtualTerminal(80, 24);
			// 实际主屏按浮层声明宽10计算横向剩余距离。
			const tui: TUI = new TuiMainScreen(terminal);
			// PCT只有3字符，居中计算仍依据10列矩形。
			const overlay = new StaticOverlay(["PCT"]);

			// 空基础组件让全文搜索只找到浮层标签。
			tui.addChild(new EmptyContent());
			// 50% should center both ways
			// row/col字符串是显式百分比坐标，会分别覆盖默认center锚点；宽度10是绝对列数。
			tui.showOverlay(overlay, { width: 10, row: "50%", col: "50%" });
			// 启动内存终端与调度。
			tui.start();
			// 等待浮层完成首帧布局。
			await renderAndFlush(tui, terminal);

			// 取得可见行字符串数组，后面线性查找标签。
			const viewport = terminal.getViewport();
			// Find the row with PCT
			// let允许找到后更新；-1作“尚未找到”哨兵，不是屏内合法行。
			let foundRow = -1;
			// 从行0逐行扫描，i++推进下标，长度是视口行数。
			for (let i = 0; i < viewport.length; i++) {
				// 可选调用只在实际行字符串中查PCT，不检查列数。
				if (viewport[i]?.includes("PCT")) {
					// 记录第一个匹配行的索引。
					foundRow = i;
					// 找到便退出for，避免后面重复文本覆盖首次位置。
					break;
				}
			}
			// Should be roughly centered vertically (row ~11-12 for 24 row terminal)
			// 只要求10到13的宽松纵向区间；未找到的-1会失败，准确11或水平35都不是这条assert的要求。
			assert.ok(foundRow >= 10 && foundRow <= 13, `Expected centered row, got ${foundRow}`);
			// 停止TUI正常收尾。
			tui.stop();
		});

		// row0%把一行浮层定位到可用区顶部，默认无margin时为行0；只断言出现行，不检查横向居中。
		it("rowPercent 0 should position at top", async () => {
			// 独立80×24屏避免上一场景的PCT残留。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏解析字符串百分比坐标。
			const tui: TUI = new TuiMainScreen(terminal);
			// TOP作为三字符定位标签。
			const overlay = new StaticOverlay(["TOP"]);

			// 基础内容空，第一行只需观察浮层文字。
			tui.addChild(new EmptyContent());
			// 给row0%覆盖纵轴，col未设仍按默认center，width10用于横向定位。
			tui.showOverlay(overlay, { width: 10, row: "0%" });
			// 启动虚拟输入与渲染。
			tui.start();
			// 等待首帧和写队列。
			await renderAndFlush(tui, terminal);

			// 读取当前视口。
			const viewport = terminal.getViewport();
			// 要求第0行包含TOP，不保证它位于第0列。
			assert.ok(viewport[0]?.includes("TOP"), `Expected TOP on row 0, got: ${viewport[0]}`);
			// 正常停止本TUI。
			tui.stop();
		});

		// row100%把一行高浮层放到底行23，验证百分比基于可移动距离而非直接把起点放到行24之外。
		it("rowPercent 100 should position at bottom", async () => {
			// 24行内存屏使底行明确为索引23。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏按内容高度计算纵向百分比范围。
			const tui: TUI = new TuiMainScreen(terminal);
			// BOTTOM为一行标签，实际返回高度为1。
			const overlay = new StaticOverlay(["BOTTOM"]);

			// 基础正文为空，不向上撑出额外逻辑行。
			tui.addChild(new EmptyContent());
			// 100%纵坐标配width10，横向未设置仍居中。
			tui.showOverlay(overlay, { width: 10, row: "100%" });
			// 启动模拟终端与首帧。
			tui.start();
			// 等布局和输出解析。
			await renderAndFlush(tui, terminal);

			// 读取24行视口快照。
			const viewport = terminal.getViewport();
			// 只在最后行查BOTTOM，没有对横轴或矩形高度另做断言。
			assert.ok(viewport[23]?.includes("BOTTOM"), `Expected BOTTOM on last row, got: ${viewport[23]}`);
			// 正常收尾stop。
			tui.stop();
		});
	});

	// 最大高度组验证丢弃底部超出行，不实现浮层内部滚动；百分比以整个终端高度为参考。
	describe("maxHeight", () => {
		// 固定5行内容设置maxHeight3，等帧后逐条确认前3行存在、后2行不存在。
		it("should truncate overlay to maxHeight", async () => {
			// 80×24屏高度充足，截断由maxHeight3触发而非屏幕边界。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏合成层在component.render后裁行，再用实际剩余高定位。
			const tui: TUI = new TuiMainScreen(terminal);
			// 固定数组按顺序返回5行文本，每行标签不同，便于识别到底裁了哪几行。
			const overlay = new StaticOverlay(["Line 1", "Line 2", "Line 3", "Line 4", "Line 5"]);

			// 底层正文为空，content查找不会被底层同名行干扰。
			tui.addChild(new EmptyContent());
			// 只给maxHeight3，宽度缺省、位置默认center；并非把内容每3行自动分页。
			tui.showOverlay(overlay, { maxHeight: 3 });
			// 启动模拟TUI。
			tui.start();
			// 等裁高后的合成结果完成写入。
			await renderAndFlush(tui, terminal);

			// 取得当时可见行文字。
			const viewport = terminal.getViewport();
			// join用LF连成单串便于跨全部视口做包含判断，未保持每个标签必须在特定绝对行的断言。
			const content = viewport.join("\n");
			// 确认保留的第一行文字可见。
			assert.ok(content.includes("Line 1"), "Should include Line 1");
			// 确认第二行也保留，不只检查首尾标签。
			assert.ok(content.includes("Line 2"), "Should include Line 2");
			// 第三行为最高允许的最后一行，应仍存在。
			assert.ok(content.includes("Line 3"), "Should include Line 3");
			// 第四行已超过上限，逻辑非要求全文没有该标签。
			assert.ok(!content.includes("Line 4"), "Should NOT include Line 4");
			// 第五行同样应被裁掉；这条样本因此明确检查保留/丢弃集合。
			assert.ok(!content.includes("Line 5"), "Should NOT include Line 5");
			// 停止本实例正常收尾。
			tui.stop();
		});

		// 10行屏设置50%最高得到5行，等帧后检查L1和L5存在、L6不存在；未逐一断言所有其余行。
		it("should truncate overlay to maxHeightPercent", async () => {
			// 屏高改为10，使50%最高准确为5，不涉及百分比取整小数。
			const terminal = new VirtualTerminal(80, 10);
			// 主屏按终端全高而非内容10行或可移动距离计算maxHeight百分比。
			const tui: TUI = new TuiMainScreen(terminal);
			// 10 lines in a 10 row terminal with 50% maxHeight should show 5 lines
			// 十条固定标签模拟完整超高浮层；L1是L10的前缀，单纯includes("L1")本身不能唯一识别第一行。
			const overlay = new StaticOverlay(["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"]);

			// 基础正文不含这些标签。
			tui.addChild(new EmptyContent());
			// maxHeight50%在10行屏内解析为5，component仍先返回全部10行再截前5行。
			tui.showOverlay(overlay, { maxHeight: "50%" });
			// 启动虚拟终端。
			tui.start();
			// 等待限高后的帧和写队列。
			await renderAndFlush(tui, terminal);

			// 读取10行屏的快照数组。
			const viewport = terminal.getViewport();
			// 合为单串查标签，这里没有断言它们确切处于视口第几行。
			const content = viewport.join("\n");
			// 要求含子串L1，不是精确按行相等，因此这条单独无法排除只出现L10的情况。
			assert.ok(content.includes("L1"), "Should include L1");
			// L5作为截断后末项应出现。
			assert.ok(content.includes("L5"), "Should include L5");
			// L6作为下一条被裁掉的行不得出现，未另外检查L7到L10都不存在。
			assert.ok(!content.includes("L6"), "Should NOT include L6");
			// 正常停止TUI。
			tui.stop();
		});
	});

	// 绝对坐标组确认显式row/col分别优先于anchor相应轴，终端格用0基下标。
	describe("absolute positioning", () => {
		// 即使指定右下锚点，也应按绝对行3列5放置，等帧后分别断言行和列。
		it("row and col should override anchor", async () => {
			// 80×24内存屏容纳该绝对矩形，不触边界夹取。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏负责显式坐标优先级，不由StaticOverlay定位自己。
			const tui: TUI = new TuiMainScreen(terminal);
			// ABSOLUTE为8字符标签，放入宽10矩形。
			const overlay = new StaticOverlay(["ABSOLUTE"]);

			// 基础正文空，定位查找无同名干扰。
			tui.addChild(new EmptyContent());
			// Even with bottom-right anchor, row/col should win
			// row3/col5覆盖bottom-right的纵/横锚点，width10只控制横向分配，不改显式起点。
			tui.showOverlay(overlay, { anchor: "bottom-right", row: 3, col: 5, width: 10 });
			// 启动虚拟屏。
			tui.start();
			// 等绘制与模拟器解析完已有输出。
			await renderAndFlush(tui, terminal);

			// 取得视口文字快照。
			const viewport = terminal.getViewport();
			// 确认文字在行3而不是底行23，证明纵轴显式设置生效。
			assert.ok(viewport[3]?.includes("ABSOLUTE"), `Expected ABSOLUTE on row 3, got: ${viewport[3]}`);
			// 取行3内标签ASCII起点，找不到/缺行给-1。
			const colIndex = viewport[3]?.indexOf("ABSOLUTE") ?? -1;
			// 严格要求列5而不是右下锚点原本的列70。
			assert.strictEqual(colIndex, 5, `Expected col 5, got ${colIndex}`);
			// 正常收尾停止主屏。
			tui.stop();
		});
	});

	// 叠放组用默认递增视觉顺序检查覆盖和插入栈移除；没有调用句柄focus重排，因此不能据此推广成永远按插入顺序绘制。
	describe("stacked overlays", () => {
		// 相同左上位置先放宽20的第一层、再放宽10的第二层；只断言第二层标签可见，不验证第一层残余每个字符。
		it("should render multiple overlays with later ones on top", async () => {
			// 80×24虚拟屏容纳两层同位置浮层。
			const terminal = new VirtualTerminal(80, 24);
			// 同一个主屏管理两条独立浮层条目。
			const tui: TUI = new TuiMainScreen(terminal);

			// 基础正文为空，合成背景由TUI补足。
			tui.addChild(new EmptyContent());

			// First overlay at top-left
			// 第一层固定正文FIRST-OVERLAY，字符串实际有13个ASCII字符。
			const overlay1 = new StaticOverlay(["FIRST-OVERLAY"]);
			// 左上20列覆盖矩形先入栈，默认视觉序号较低。
			tui.showOverlay(overlay1, { anchor: "top-left", width: 20 });

			// Second overlay at top-left (should cover part of first)
			// 第二层正文SECOND只有6字符，但覆盖预算不是6而是后面的10列。
			const overlay2 = new StaticOverlay(["SECOND"]);
			// 第二层同位置宽10，默认视觉序号较高，后合成会连同填充区域覆盖先前层的前10列。
			tui.showOverlay(overlay2, { anchor: "top-left", width: 10 });

			// 启动虚拟屏，首帧统一处理两条已登记浮层。
			tui.start();
			// 等待两层完成合成并被模拟器解释。
			await renderAndFlush(tui, terminal);

			// 读取可见文字，不直接读取内部视觉序号。
			const viewport = terminal.getViewport();
			// Second overlay should be visible (on top)
			// 只要求首行出现SECOND，没有检查FIRST-OVERLAY剩下的是哪段；不能按6个正文字符推断10列覆盖之后的残文。
			assert.ok(viewport[0]?.includes("SECOND"), `Expected SECOND on row 0, got: ${viewport[0]}`);
			// Part of first overlay might still be visible after SECOND
			// FIRST-OVERLAY is 13 chars, SECOND is 6 chars, so "OVERLAY" part might show
			// 正常路径stop，前面的英文猜测不是额外执行的断言。
			tui.stop();
		});

		// 两层分别位于左上/右下，等帧后要求两个标签同时出现在目标行；未核验整块背景或全部其他格不受影响。
		it("should handle overlays at different positions without interference", async () => {
			// 独立80×24虚拟屏给两个角各留定位区域。
			const terminal = new VirtualTerminal(80, 24);
			// 同一主屏管理两层浮层。
			const tui: TUI = new TuiMainScreen(terminal);

			// 空基础正文让角落标签来源唯一。
			tui.addChild(new EmptyContent());

			// Overlay at top-left
			// 第一层标签TOP-LEFT。
			const overlay1 = new StaticOverlay(["TOP-LEFT"]);
			// 左上锚点、宽15，第一行起点为0。
			tui.showOverlay(overlay1, { anchor: "top-left", width: 15 });

			// Overlay at bottom-right
			// 第二层独立标签BTM-RIGHT，视觉序号更高但不与第一层位置重叠。
			const overlay2 = new StaticOverlay(["BTM-RIGHT"]);
			// 右下锚点、宽15，使矩形贴屏底/右边；正文比15短，不意味着最后字贴最右列。
			tui.showOverlay(overlay2, { anchor: "bottom-right", width: 15 });

			// 启动虚拟输入输出。
			tui.start();
			// 等待合成两处标签后的画面。
			await renderAndFlush(tui, terminal);

			// 读取视口快照，包含两角所在行。
			const viewport = terminal.getViewport();
			// Both should be visible
			// 只要求首行有左上标签，没有在这里断言其精确起列。
			assert.ok(viewport[0]?.includes("TOP-LEFT"), `Expected TOP-LEFT on row 0, got: ${viewport[0]}`);
			// 同时要求第23行有右下标签，验证两层没有因合成顺序让另一处完全消失。
			assert.ok(viewport[23]?.includes("BTM-RIGHT"), `Expected BTM-RIGHT on row 23, got: ${viewport[23]}`);
			// 正常收尾stop本实例。
			tui.stop();
		});

		// 先后显示FIRST和SECOND，默认后者盖住前者；hideOverlay移除最后插入项后重新等帧，要求FIRST再次可见。
		it("should properly hide overlays in stack order", async () => {
			// 80×24内存屏供同位置覆盖/恢复检查。
			const terminal = new VirtualTerminal(80, 24);
			// 同一主屏的插入栈保存两条浮层条目。
			const tui: TUI = new TuiMainScreen(terminal);

			// 基础内容为空，移除上层后下层文字才是观察点。
			tui.addChild(new EmptyContent());

			// Show two overlays
			// 第一层只有FIRST一行。
			const overlay1 = new StaticOverlay(["FIRST"]);
			// 在左上宽10矩形登记第一层。
			tui.showOverlay(overlay1, { anchor: "top-left", width: 10 });

			// 第二层只有SECOND一行，和第一层有不同识别文字。
			const overlay2 = new StaticOverlay(["SECOND"]);
			// 同位置同宽度登记第二层，默认视觉序号更高，覆盖第一层。
			tui.showOverlay(overlay2, { anchor: "top-left", width: 10 });

			// 启动虚拟终端和首帧。
			tui.start();
			// 等两层合成完再检查初始顶部。
			await renderAndFlush(tui, terminal);

			// Second should be visible
			// let允许移除浮层后把变量重新绑定到新的屏幕快照，旧快照不会自己变。
			let viewport = terminal.getViewport();
			// 先证明第二层确实出现，否则后面的恢复断言无法说明覆盖/移除流程。
			assert.ok(viewport[0]?.includes("SECOND"), "SECOND should be visible initially");

			// Hide top overlay
			// 无参hideOverlay删除插入栈最后一项SECOND；一般不等同于删除focusOrder最高项，此例没有手动重排所以二者恰好一致。
			tui.hideOverlay();
			// 再次强制渲染，让删除反映到屏幕，不能只读旧数组推断已恢复。
			await renderAndFlush(tui, terminal);

			// First should now be visible
			// 重新取得快照并替换本地引用，不修改第一次快照。
			viewport = terminal.getViewport();
			// 要求FIRST重新出现在首行，不额外断言栈大小、焦点或完整行字节。
			assert.ok(viewport[0]?.includes("FIRST"), "FIRST should be visible after hiding SECOND");

			// 正常结束后stop，断开虚拟输入并清渲染timer。
			tui.stop();
		});
	});

	// https://github.com/earendil-works/pi/issues/10026
	// 问题10026回归组：停止后shell应拥有光标；这里只观察替身同步记录，未等xterm模式解析或操作真实shell。
	describe("hiding after stop", () => {
		// 同步复现start→show被动浮层→stop→hideOverlay，要求最后一次光标请求仍是显示；没有读屏等待，因为断言的是同步布尔记录。
		it("hideOverlay() leaves the cursor visible", () => {
			// 光标跟踪子类仍只使用80×24内存xterm，同时记录hide/show方法调用结果。
			const terminal = new CursorTrackingTerminal(80, 24);
			// 实际主屏与这个特殊虚拟适配器组合。
			const tui: TUI = new TuiMainScreen(terminal);
			// start会先请求隐藏模拟光标，并排渲染；本测试还没等帧就继续。
			tui.start();
			// nonCapturing:true不自动抢键盘焦点，但显示浮层仍可请求运行中隐藏光标；不表示完全不参与视觉合成。
			tui.showOverlay(new StaticOverlay(["OVERLAY"]), { nonCapturing: true });

			// stop同步置stopped并调用showCursor，跟踪字段立刻变true；已排nextTick以后还会执行但通常被停止门禁拦下。
			tui.stop();
			// 移除最后插入浮层仍可能排请求，但hideTerminalCursor有stopped门禁，不应重新把记录变false。
			tui.hideOverlay();

			// 精确断言同步记录为true，证明此调用链没有最后再请求隐藏；不证明实际终端当前像素光标已显示。
			assert.strictEqual(terminal.cursorVisible, true);
		});

		// 同样停止后隐藏场景改用返回句柄hide，确保按条目移除的路径也不重新隐藏光标；同步断言失败由运行器记录。
		it("overlay handle hide() leaves the cursor visible", () => {
			// 重新建立光标跟踪虚拟屏，避免复用上一条布尔记录。
			const terminal = new CursorTrackingTerminal(80, 24);
			// 新主屏使用该适配器；没有ProcessTerminal系统行为。
			const tui: TUI = new TuiMainScreen(terminal);
			// 启动后光标隐藏请求先被记录为false。
			tui.start();
			// 保存showOverlay返回的条目句柄；nonCapturing只改变自动焦点规则，不改变此句柄的存在。
			const handle = tui.showOverlay(new StaticOverlay(["OVERLAY"]), { nonCapturing: true });

			// 正常stop先置停止标记再请求显示，记录变true。
			tui.stop();
			// 句柄只移除对应entry，栈清空时也经过停止后的光标门禁，不应再次隐藏。
			handle.hide();

			// 最终true只验证替身调用状态，不等待绘制/模拟模式位；已stop无需再调用第二遍stop。
			assert.strictEqual(terminal.cursorVisible, true);
		});
	});
});
