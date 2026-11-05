// 编辑器行为测试：直接给真实Editor输入字符串，检查历史、文字/光标、Unicode折行、删除环、撤销、异步补全和大粘贴标记，共193个it；不把渲染文字检查当作真实终端兼容测试。
// 宿主全部为内存VirtualTerminal；不过requestRender仍可能通过nextTick/定时器运行MainScreen空子树渲染。一个路径补全用例会创建、读取并清理自己的临时目录，其余提供者用内存数据；本文件不启动ProcessTerminal、系统剪贴板或网络。
// assert的条件失败会抛错并使当前测试失败；strictEqual检查值严格相等，deepStrictEqual进一步检查数组/对象结构，不自动说明尚未断言的所有内部状态。
import assert from "node:assert";
// 同步文件系统函数仅供后面的临时目录补全例子使用；导入本身不创建目录或写文件。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// tmpdir读取平台临时目录位置，不是当前用户home目录；后面mkdtemp会在这里生成独立测试目录。
import { tmpdir } from "node:os";
// join按本机平台路径规则连接测试目录与文件名，不在这里访问文件。
import { join } from "node:path";
// describe组织测试组，it注册测试回调；async测试返回的Promise由Node运行器等待，注册回调不等于现在已经跑完断言。
import { describe, it } from "node:test";
// Node自带的stripVTControlCharacters去终端控制序列，供断言比较纯文字，不执行那些控制码。
import { stripVTControlCharacters } from "node:util";
// type AutocompleteProvider只约束提供者形状，运行时擦除；CombinedAutocompleteProvider是真实命令/路径补全类，构造缺省fdPath=null，不会自行寻找fd。
import { type AutocompleteProvider, CombinedAutocompleteProvider } from "../src/autocomplete.ts";
// Editor是被测编辑器，wordWrapLine是同模块导出的真实折行函数；没有用测试镜像算法代替实现。
import { Editor, wordWrapLine } from "../src/components/editor.ts";
// 导入伪光标开始标记和生成函数供字符串检查；type TUI是编译期宿主联合类型，不会在运行时启动两种TUI。
import { FAKE_CURSOR_START, renderFakeCursor, type TUI } from "../src/tui.ts";
// TuiMainScreen提供Editor需要的宿主和排帧方法，下面把真实终端适配器换成内存实现。
import { TuiMainScreen } from "../src/tui-main-screen.ts";
// stripTerminalSequences剥终端序列，visibleWidth按显示格数计宽；它们都不等于string.length这个UTF-16码元数。
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";
// 共享测试主题用明确颜色级别的Chalk包装字符串，不靠真实终端背景/主题查询。
import { defaultEditorTheme } from "./test-themes.ts";
// VirtualTerminal构造headless xterm，所有终端输出进内存缓冲，不接真实stdin/stdout或系统剪贴板。
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Create a TUI with a virtual terminal for testing */
// 创建测试宿主：输入可选列/行数，缺省80×24，返回TUI联合类型中的主屏实例；例如createTestTUI(15)给窄屏编辑器。这里只构造不start，后续Editor请求仍可能排帧。
function createTestTUI(cols = 80, rows = 24): TUI {
	// 先new内存终端，再注入真实主屏TUI返回；嵌套new按内层到外层执行，返回类型TUI并不复制或包装实例。
	return new TuiMainScreen(new VirtualTerminal(cols, rows));
}

/** Standard applyCompletion that replaces prefix with item.value */
// 测试补全应用函数：接原行数组、行号、码元光标、候选value和待替换prefix，返回新数组/光标，不改原数组。例di在列2被dist/替换后列为5；不自动验证prefix真的匹配光标前正文，越界slice仍沿JS规则。
function applyCompletion(
	// lines:string[]声明每个元素是字符串，调用者仍需给正确行号；类型不会限制数组长度或每行实际内容。
	lines: string[],
	// cursorLine:number是0起逻辑行号，和渲染后可能折出的多条屏幕行区分。
	cursorLine: number,
	// cursorCol是当前逻辑行内的UTF-16下标，不是终端显示列，也不在这里额外校验范围。
	cursorCol: number,
	// 结构类型只要求候选含字符串value；有label等额外字段的完整候选仍能传入，本函数只读取value。
	item: { value: string },
	// prefix是原文中准备替换的前缀，其length也按UTF-16码元计数。
	prefix: string,
	// 返回对象类型声明新lines及两个数字坐标，开发时检查字段，运行时不自动生成验证代码。
): { lines: string[]; cursorLine: number; cursorCol: number } {
	// 取当前行，缺失或空串都按空串处理；||基于真值回退，不是只处理undefined。
	const line = lines[cursorLine] || "";
	// 保留光标前扣除prefix长度的部分，例如abcdi光标5、prefix di时保留abc。
	const before = line.slice(0, cursorCol - prefix.length);
	// 保留光标及其后面的原后缀，避免应用候选时无条件丢掉行尾内容。
	const after = line.slice(cursorCol);
	// 数组展开创建浅拷贝容器，其他行字符串原值保留；const禁止重绑newLines，不禁止修改其中元素。
	const newLines = [...lines];
	// 只替换当前行：保留前文、插入候选value、接回后缀；这个赋值改新数组，原lines容器不变。
	newLines[cursorLine] = before + item.value + after;
	// 返回供Editor接管的状态对象，而不是在此直接修改Editor、显示菜单或触发提交。
	return {
		// lines属性明确指向刚创建的新数组。
		lines: newLines,
		// cursorLine属性简写等于cursorLine:cursorLine，仍留在原逻辑行。
		cursorLine,
		// 新列等于旧列减原prefix长度再加候选长度，让光标落在候选之后、原后缀之前。
		cursorCol: cursorCol - prefix.length + item.value.length,
	};
}

// 给常见异步补全链让出执行机会，返回Promise<void>；先过微任务再过一次setImmediate。例如Tab后await它再检查菜单。它不等待任意长IO/定时器，也不是所有后台工作完成的保证。
async function flushAutocomplete(): Promise<void> {
	// await一个已兑现Promise仍暂停本async函数，允许已经排队的Promise回调推进。
	await Promise.resolve();
	// 创建Promise并用setImmediate安排未来兑现；executor现在登记回调，await稍后恢复，不会自行快进20ms补全防抖。
	await new Promise((resolve) => setImmediate(resolve));
}

// 最外层测试组注册所有Editor场景；每个测试创建局部实例，但Node定时器与模块共享对象仍在同一测试进程中。
describe("Editor component", () => {
	// 历史导航组用真实Up/Down控制串驱动Editor，观察历史文字和恢复草稿，不写磁盘历史或请求模型。
	describe("Prompt history navigation", () => {
		// 空历史例：新编辑器上按一次Up后文字仍空。只检查这次输入不改变文字，未直接检查所有内部字段或渲染输出。
		it("does nothing on Up arrow when history is empty", () => {
			// 构造空Editor并注入默认尺寸虚拟宿主和测试主题，没有添加任何历史。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 直接给Editor传CSI A上箭头；handleInput同步处理，不来自真实键盘，也不通过VirtualTerminal.sendInput。
			editor.handleInput("\x1b[A"); // Up arrow

			// 读取存储文本，要求仍为空字符串；如果意外插入控制字符或加载内容，严格比较就失败。
			assert.strictEqual(editor.getText(), "");
		});

		// 最近历史例：按顺序加入两条提示，再从空编辑器Up，应看到second prompt。添加历史与编辑当前草稿是两个独立操作。
		it("shows most recent history entry on Up arrow when editor is empty", () => {
			// 新实例隔离前个测试的历史数组，主题对象仍复用共享定义。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 先加入较旧的first prompt，addToHistory会trim首尾空白后把新项放到历史开头。
			editor.addToHistory("first prompt");
			// 再加入second prompt，使它成为最新项；这两行不自动把历史文字放进编辑器。
			editor.addToHistory("second prompt");

			// 空草稿按Up第一次进入历史浏览，实际实现选择最新项。
			editor.handleInput("\x1b[A"); // Up arrow

			// 要求展示第二次加入的文字，验证历史顺序而非仅验证有内容。
			assert.strictEqual(editor.getText(), "second prompt");
		});

		// 连续Up例：三条历史依次从third到second到first，到最旧后保持。标题的cycles不表示循环回最新，最后断言明确检查边界不环绕。
		it("cycles through history entries on repeated Up arrow", () => {
			// 建立本例独立空编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 记录最早的first。
			editor.addToHistory("first");
			// 加入second，它比first新。
			editor.addToHistory("second");
			// 加入third，当前最新位于历史数组下标0。
			editor.addToHistory("third");

			// 第一次Up进入历史最新third。
			editor.handleInput("\x1b[A"); // Up - shows "third"
			// 严格确认当前文字是third，不只是历史数组包含它。
			assert.strictEqual(editor.getText(), "third");

			// 第二次Up向更旧一项移动。
			editor.handleInput("\x1b[A"); // Up - shows "second"
			// 确认第二步加载second。
			assert.strictEqual(editor.getText(), "second");

			// 第三次Up到最旧first。
			editor.handleInput("\x1b[A"); // Up - shows "first"
			// 确认first已展示。
			assert.strictEqual(editor.getText(), "first");

			// 再按Up尝试越过最旧项；实现拒绝越界，不回第三条。
			editor.handleInput("\x1b[A"); // Up - stays at "first" (oldest)
			// 仍是first，直接检查这一最旧边界行为。
			assert.strictEqual(editor.getText(), "first");
		});

		// 非空草稿例：光标在draft中间时Up先跳全文开头、第二次Up才浏览prompt，Down恢复进入浏览时已位于开头的草稿。断言同时检查文字和码元坐标。
		it("jumps to start before entering history from a non-empty draft", () => {
			// 建立独立Editor，不沿用前个测试的历史状态。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 添加一条可供后面浏览的历史prompt，当前编辑内容仍空。
			editor.addToHistory("prompt");
			// 用setText设draft，公共方法将光标放到末尾列5并退出历史浏览。
			editor.setText("draft");
			// 向左一字素，在ASCII草稿中从列5到4。
			editor.handleInput("\x1b[D");
			// 再左移到列3，确保开始Up时不在文档开头。
			editor.handleInput("\x1b[D");

			// 第一次Up位于首显示行但非开头，先把光标移到列0，不立刻替换草稿。
			editor.handleInput("\x1b[A"); // Up - jumps to start before history browsing
			// 文字仍draft，排除第一次Up已经进入prompt历史。
			assert.strictEqual(editor.getText(), "draft");
			// 光标必须是首逻辑行列0；这里col是字符串下标，不是按显示宽度测出的列。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// 第二次Up现在满足开头入口，保存当前草稿状态并加载历史。
			editor.handleInput("\x1b[A"); // Up at start - shows "prompt"
			// 确认历史prompt已取代当前显示文字。
			assert.strictEqual(editor.getText(), "prompt");

			// Down向更新方向越过最新历史，回到保存的草稿位。
			editor.handleInput("\x1b[B"); // Down - restores draft
			// 恢复文字draft，不把历史内容误当原草稿。
			assert.strictEqual(editor.getText(), "draft");
			// 恢复的是进入历史时的列0，不是最初setText后的列5，也不是手动左移后的列3。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		});

		// 向新历史浏览例：先四次Up从draft末尾走到最旧first，再Down到second、third及原draft，验证草稿恢复而非循环。
		it("navigates forward through history with Down arrow", () => {
			// 建立独立实例，局部保存历史与草稿。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 先记录first，作为最旧历史。
			editor.addToHistory("first");
			// 记录第二条second。
			editor.addToHistory("second");
			// 最后记录third，作为最新历史。
			editor.addToHistory("third");
			// 当前草稿设draft，光标在末尾；第一次Up因此要先跳开头。
			editor.setText("draft");

			// Go to oldest
			// 第一次Up仅把非空草稿光标移到开头，尚未加载历史。
			editor.handleInput("\x1b[A"); // start of draft
			// 第二次Up加载最新third。
			editor.handleInput("\x1b[A"); // third
			// 第三次Up加载second。
			editor.handleInput("\x1b[A"); // second
			// 第四次Up加载最旧first，给向新方向的后续断言设起点。
			editor.handleInput("\x1b[A"); // first

			// Navigate back
			// Down向更新一项，应该到second。
			editor.handleInput("\x1b[B"); // second
			// 确认中间历史second。
			assert.strictEqual(editor.getText(), "second");

			// 再次Down向最新third移动。
			editor.handleInput("\x1b[B"); // third
			// 确认最新历史third。
			assert.strictEqual(editor.getText(), "third");

			// 再Down离开历史，恢复保存草稿，不回first。
			editor.handleInput("\x1b[B"); // draft
			// 要求文字draft，证明恢复了浏览前状态。
			assert.strictEqual(editor.getText(), "draft");
		});

		// 在历史项上打字例：加载old prompt时光标在开头，输入x后得到xold prompt。实现也退出历史模式，但本例仅用这一文本结果观察编辑，未再按上下验证后续导航。
		it("exits history mode when typing a character", () => {
			// 创建独立Editor以隔离历史状态。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 加入唯一历史old prompt。
			editor.addToHistory("old prompt");

			// Up加载这条历史并将光标放全文起点。
			editor.handleInput("\x1b[A"); // Up - shows "old prompt"
			// 输入普通字符x，在当前光标处插入并退出历史浏览，保留原历史数组。
			editor.handleInput("x"); // Type a character - exits history mode

			// 要求开头插入的xold prompt，区分追加在末尾或把历史整条替换成x的错误。
			assert.strictEqual(editor.getText(), "xold prompt");
		});

		// 外部setText例：先浏览second，再用setText清空，重新Up仍从最新second开始。证明公共替换重置历史浏览入口，不接着走向first。
		it("exits history mode on setText", () => {
			// 新建独立实例，不含旧测试历史。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 加入较旧first。
			editor.addToHistory("first");
			// 加入最新second。
			editor.addToHistory("second");

			// Up从空草稿加载second。
			editor.handleInput("\x1b[A"); // Up - shows "second"
			// 公共setText清空编辑文字并退出浏览，和历史内部加载方法不一样。
			editor.setText(""); // External clear

			// Up should start fresh from most recent
			// 新的Up应重新开始历史链，而不是沿刚才的游标继续向旧项。
			editor.handleInput("\x1b[A");
			// 检查second，排除仍在浏览而加载first的情况。
			assert.strictEqual(editor.getText(), "second");
		});

		// 过滤空历史例：空串、纯空格都不应留下可浏览项，最后valid应是唯一可访问结果。这里用连续Up与文字断言观察过滤，不直接读取私有数组长度。
		it("does not add empty strings to history", () => {
			// 建立初始历史为空的Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 尝试加入空串，trim后为空应被拒绝。
			editor.addToHistory("");
			// 尝试加入三个空格，trim后同样为空。
			editor.addToHistory("   ");
			// 加入合法非空valid作为有效对照。
			editor.addToHistory("valid");

			// 第一次Up取得最新有效项。
			editor.handleInput("\x1b[A");
			// 要求valid，排除空输入占据最新位置。
			assert.strictEqual(editor.getText(), "valid");

			// Should not have more entries
			// 再次Up尝试浏览更旧项。
			editor.handleInput("\x1b[A");
			// 仍是valid，空白样本没有形成另一个可显示的历史项。
			assert.strictEqual(editor.getText(), "valid");
		});

		// 连续同文去重例：same加入三次后两次Up文字始终same。实际addToHistory会拒绝与最新项相同的文字，但这一文本断言本身不能区分多条完全相同的记录，未直接计数私有历史。
		it("does not add consecutive duplicates to history", () => {
			// 创建新Editor供连续重复场景使用。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 第一次same加入空历史，应成为最新记录。
			editor.addToHistory("same");
			// 第二次相同值按实际实现与最新项比较后跳过。
			editor.addToHistory("same");
			// 第三次仍相同，再次尝试加入，不改变原历史。
			editor.addToHistory("same");

			// Up浏览same。
			editor.handleInput("\x1b[A"); // "same"
			// 确认首次浏览文字为same。
			assert.strictEqual(editor.getText(), "same");

			// 再Up尝试向旧项移动。
			editor.handleInput("\x1b[A"); // stays at "same" (only one entry)
			// 可见文字仍same；仅靠文字不独立证明数组里恰好只有一条，去重规则来自实际实现核对。
			assert.strictEqual(editor.getText(), "same");
		});

		// 非相邻重复例：first、second、first应保留三条，Up能观察first→second→first。它与前个同文样本不同，隔开的second使重复是否保留可从文字序列辨认。
		it("allows non-consecutive duplicates in history", () => {
			// 新实例隔离历史条目。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 加入最旧first。
			editor.addToHistory("first");
			// 加入second，把两次first隔开。
			editor.addToHistory("second");
			// 再次加入first，只与最新second比较，因此这次应保留。
			editor.addToHistory("first"); // Not consecutive, should be added

			// Up加载最新first。
			editor.handleInput("\x1b[A"); // "first"
			// 确认末次加入的first。
			assert.strictEqual(editor.getText(), "first");

			// 再Up向旧一项到second。
			editor.handleInput("\x1b[A"); // "second"
			// 确认中间second仍在。
			assert.strictEqual(editor.getText(), "second");

			// 第三次Up应到第一次加入的first。
			editor.handleInput("\x1b[A"); // "first" (older one)
			// 要求first，说明非连续的重复条目没有被全局去掉。
			assert.strictEqual(editor.getText(), "first");
		});

		// 非空多行草稿例：Up先把末行光标移到前行，随后插X应是line1X换行line2，不能直接用history item替换草稿。当前无render，折行按默认宽度，短行各占一条。
		it("uses cursor movement instead of history when editor has content", () => {
			// 构造独立编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 加入一条历史，若Up错误进入浏览就会出现history item。
			editor.addToHistory("history item");
			// 设两行草稿，光标在第二行末尾列5。
			editor.setText("line1\nline2");

			// Cursor is at end of line2, Up should move to line1
			// Up按编辑器光标导航移到第一行同列，而非进入历史。
			editor.handleInput("\x1b[A"); // Up - cursor movement

			// Insert character to verify cursor position
			// 在移动后的光标处插入X，用插入结果间接验证位置。
			editor.handleInput("X");

			// X should be inserted in line1, not replace with history
			// 要求第一行末尾出现X，第二行保持，排除加载历史或仍在第二行的错误。
			assert.strictEqual(editor.getText(), "line1X\nline2");
		});

		// 历史容量例：加入prompt0到104共105条，再Up100次应到最旧保留prompt5，额外Up仍不越界。固定样本验证容量裁剪结果，不涉及磁盘持久化。
		it("limits history to 100 entries", () => {
			// 新实例给历史容量测试一个空起点。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Add 105 entries
			// let i从0递增到104，共执行105次；for块里每次构造不同提示，避免连续去重影响数量。
			for (let i = 0; i < 105; i++) {
				// 模板字符串插入当前数字，例如prompt104；超过100条时实现从数组尾淘汰最旧项。
				editor.addToHistory(`prompt ${i}`);
			}

			// Navigate to oldest
			// 再循环100次Up，足够从空编辑器走到100条保留历史的最旧端。
			for (let i = 0; i < 100; i++) {
				// 每轮同步调用一次上箭头，不等待终端渲染，因为随后检查的是Editor内部文本。
				editor.handleInput("\x1b[A");
			}

			// Should be at entry 5 (oldest kept), not entry 0
			// 要求prompt5，说明0到4被容量规则淘汰，而非仍保留全部105条。
			assert.strictEqual(editor.getText(), "prompt 5");

			// One more Up should not change anything
			// 再尝试越过现存最旧项。
			editor.handleInput("\x1b[A");
			// 仍是prompt5，边界不循环、不清空。
			assert.strictEqual(editor.getText(), "prompt 5");
		});

		// 向旧历史的光标定位例：Up加载三行历史后应在全文开头，紧接Up可以浏览older entry，不必先穿过三行。两步都检查行0列0。
		it("places cursor at start after browsing history upward", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 先加较旧的单行历史older entry。
			editor.addToHistory("older entry");
			// 再加含两处LF的三行历史，成为最新条目。
			editor.addToHistory("line1\nline2\nline3");

			// Up加载最新三行历史，实际实现向旧方向使用start光标放置。
			editor.handleInput("\x1b[A"); // Up - shows multi-line entry at start
			// 文本仍含三行原内容，未只加载第一行。
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");
			// 光标应在首逻辑行首码元，不能像普通setText那样放末尾。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// 再Up处于历史浏览且在第一显示行，直接到更旧项。
			editor.handleInput("\x1b[A"); // Up again - immediately navigates to older entry
			// 确认older entry已加载，不是只在多行历史内上移。
			assert.strictEqual(editor.getText(), "older entry");
			// 向旧方向加载另一条仍将光标放0,0。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		});

		// 向新历史的光标定位例：先Up到最旧，再Down加载三行条目时光标放末行列5，下一次Down可立即到newer entry。与向旧方向放开头形成对照。
		it("places cursor at end after browsing history downward", () => {
			// 创建独立实例供三条历史的往返使用。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 最先加入older entry，作为最旧端。
			editor.addToHistory("older entry");
			// 加入三行历史作为中间条目，末行line3长度5。
			editor.addToHistory("line1\nline2\nline3");
			// 最后加入newer entry，使它成为最新。
			editor.addToHistory("newer entry");

			// 第一次Up到newer entry。
			editor.handleInput("\x1b[A"); // newer entry
			// 第二次Up到中间三行历史。
			editor.handleInput("\x1b[A"); // multi-line entry
			// 第三次Up到older entry，为向新方向测试准备起点。
			editor.handleInput("\x1b[A"); // older entry

			// Down加载中间三行历史，方向为更新，实际实现使用end放置。
			editor.handleInput("\x1b[B"); // Down - shows multi-line entry at end
			// 确认三行文本完整恢复。
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");
			// 末行索引2、列5，检查末尾光标，不是屏幕第三行第六格的协议坐标。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 });

			// 已在最后显示行，下一次Down可继续到更新的条目。
			editor.handleInput("\x1b[B"); // Down again - immediately navigates to newer entry
			// 确认newer entry，排除仍在三行条目里移动的情况。
			assert.strictEqual(editor.getText(), "newer entry");
		});

		// 历史项内反向光标移动例：Up载三行到开头后Down应移到第二行，再Up回第一行，文本不变。历史浏览不表示所有上下键都只能换条目，入口还看首/末显示行。
		it("allows opposite-direction cursor movement within multi-line history entry", () => {
			// 创建独立编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 添加唯一三行历史，用来区分换历史与在条目内部移动。
			editor.addToHistory("line1\nline2\nline3");

			// Up加载该历史，光标初始在全文开头。
			editor.handleInput("\x1b[A"); // Up - shows entry at start
			// 明确检查行0列0，为后面的Down移动提供起点。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// Down不在最后显示行，因此在当前历史文本内向下一行。
			editor.handleInput("\x1b[B"); // Down - cursor moves to line2
			// 三行文字仍保持，不应离开历史后恢复空草稿。
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");
			// 光标到逻辑行1列0，即第二条line2开头。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			// 从第二行Up回第一行，而非跳过当前文本加载其他历史。
			editor.handleInput("\x1b[A"); // Up - cursor moves back to line1
			// 当前文本仍是同一三行历史。
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");
			// 光标回行0列0，验证这次反向导航结果。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		});
	});

	// 公开读取接口组：检查光标坐标和逻辑行数组副本，读取不发送终端控制码，也不执行补全查询。
	describe("public state accessors", () => {
		// 光标读取例：初始0,0，键入abc后列3，左箭头后列2。此处都是ASCII，码元下标与显示格偏移一致，不代表任意Unicode都相等。
		it("returns cursor position", () => {
			// 新建空编辑器，默认光标位于唯一空逻辑行的开头。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 深比较返回的新坐标对象，line/col两个字段都应为0。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// 插入a，将ASCII光标列由0推进到1。
			editor.handleInput("a");
			// 继续插入b，列推进到2。
			editor.handleInput("b");
			// 再插入c，列推进到3；三次调用是三段输入，不是一次数组赋值。
			editor.handleInput("c");

			// 要求仍在逻辑行0、列3，直接检查读取接口反映编辑状态。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

			// 左移一个字素，当前ASCII场景相当于少一个码元。
			editor.handleInput("\x1b[D"); // Left
			// 确认列2，位于c之前，验证移动后的getCursor不是旧快照值。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
		});

		// 逻辑行副本例：读取a/b两行后改返回数组首项，Editor仍返回a/b。验证数组容器被复制；字符串本身不可变，不需要把它们当可修改对象深拷贝。
		it("returns lines as a defensive copy", () => {
			// 创建独立实例，不复用上个测试的abc内容。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 设两行文字a换行b，Editor按LF拆为两个逻辑行。
			editor.setText("a\nb");

			// 读取并保存getLines返回的新数组，const固定引用但数组元素仍可赋值。
			const lines = editor.getLines();
			// 初始副本应恰为两个元素a、b，LF不作为行内字符保留。
			assert.deepStrictEqual(lines, ["a", "b"]);

			// 只修改调用方持有数组的第0项为mutated，测试是否意外泄漏内部容器。
			lines[0] = "mutated";
			// 再次读取Editor仍是a/b，说明前一赋值没写回内部行数组。
			assert.deepStrictEqual(editor.getLines(), ["a", "b"]);
		});
	});

	// 反斜杠加Enter兼容组：默认提交键为Enter时，光标前紧邻反斜杠会被消费并插LF；不是对整段文本做shell转义分析，也不要求先缓冲反斜杠。
	describe("Backslash+Enter newline workaround", () => {
		// 即时插入例：输入一个反斜杠后立即读取文字应已有它，不等后续键或计时器。本例检查存储文字，不直接检查真实屏幕。
		it("inserts backslash immediately (no buffering)", () => {
			// 构造空编辑器，没有注册提交回调。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 字符串源码用两个反斜杠表示一个字面反斜杠，handleInput收到的只有一个字符。
			editor.handleInput("\\");

			// Backslash should be visible immediately, not buffered
			// 同步读取必须是这个单字符，不能仍空并等待下一次输入。
			assert.strictEqual(editor.getText(), "\\");
		});

		// 单反斜杠换行例：先插反斜杠再Enter，结果仅LF。实际先删光标前一个反斜杠，再拆逻辑行，不是把反斜杠原样提交。
		it("converts standalone backslash to newline on Enter", () => {
			// 新Editor使用默认提交/换行键位。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 先插入一个字面反斜杠，使光标紧接其后。
			editor.handleInput("\\");
			// CR表示默认Enter提交键，这个位置触发反斜杠兼容换行。
			editor.handleInput("\r");

			// 结果为换行字符本身，对应两条空逻辑行；没有残留反斜杠。
			assert.strictEqual(editor.getText(), "\n");
		});

		// 反斜杠后普通字符例：依次输入反斜杠与x，结果保留两者，不把反斜杠当成所有后续键的转义前导。
		it("inserts backslash normally when followed by other characters", () => {
			// 新建空Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 先插反斜杠，文本立即包含它。
			editor.handleInput("\\");
			// 再插普通x，光标此时位于x之后。
			editor.handleInput("x");

			// 严格要求反斜杠加x，排除吞反斜杠或把x变成其他控制行为。
			assert.strictEqual(editor.getText(), "\\x");
		});

		// 反斜杠不紧邻光标的提交例：输入反斜杠x再Enter，应调用onSubmit而非插LF。只观察回调是否发生，不断言此次提交文本或清空后的全文。
		it("does not trigger newline when backslash is not immediately before cursor", () => {
			// 创建新实例，避免前例换行状态影响。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// let布尔标记初始false，后面回调运行时才改true。
			let submitted = false;

			// 注册无参数回调，忽略框架实际传入的提交文字；注册不立即触发提交。
			editor.onSubmit = () => {
				// 提交发生时改局部标记，没有模型调用或外部写入。
				submitted = true;
			};

			// 输入反斜杠。
			editor.handleInput("\\");
			// 输入x，使紧邻光标前字符变为x。
			editor.handleInput("x");
			// Enter不再满足末反斜杠判断，按默认路径提交。
			editor.handleInput("\r");

			// Should submit, not insert newline (backslash not at cursor)
			// 要求回调已把标记设true；没有用延时猜测异步模型是否回复，Editor提交回调在此同步执行。
			assert.strictEqual(submitted, true);
		});

		// 多个反斜杠例：连续三次输入后Enter，只移除最后一个并加LF，前两个保留。实现看相邻字符，不按反斜杠总数奇偶决定。
		it("only removes one backslash when multiple are present", () => {
			// 新实例给三字符输入一个空起点。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 插第一个字面反斜杠。
			editor.handleInput("\\");
			// 插第二个，两个均保留。
			editor.handleInput("\\");
			// 插第三个，让光标紧邻最后一字符。
			editor.handleInput("\\");
			// 源码六个反斜杠转义成三个实际字符，严格检查Enter前没有提前合并或吞字符。
			assert.strictEqual(editor.getText(), "\\\\\\");

			// Enter消费光标前一个反斜杠，再插入一处换行。
			editor.handleInput("\r");
			// Only the last backslash is removed, newline inserted
			// 预期两个字面反斜杠后接LF，区分删除全部与只删除一个。
			assert.strictEqual(editor.getText(), "\\\\\n");
		});
	});

	// 显式键盘文本协议组：把Kitty CSI-u或xterm modifyOtherKeys编码交Editor，检查可插入字符与被拒修饰，不实际协商终端协议。
	describe("Kitty CSI-u handling", () => {
		// 不支持修饰位例：CSI-u的99为c，修饰9减协议偏移1得Super位8，文本解码拒绝这种修饰；要求编辑文字仍空，不说明所有事件处理都无共享状态变化。
		it("ignores printable CSI-u sequences with unsupported modifiers", () => {
			// 构造空Editor；输入解析会读取共享键位与协议模块规则。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 直接发送完整ESC[99;9u字符串；它是协议编码，不是把中括号和数字当普通正文。
			editor.handleInput("\x1b[99;9u");

			// 文本仍空，防止把不支持的Super+c或报文尾部误插入。
			assert.strictEqual(editor.getText(), "");
		});

		// Shift CSI-u例：码点69本身就是大写E，修饰2为Shift，应插E。这里并非传入小写码点后让Editor按Shift自动转大写。
		it("inserts shifted CSI-u letters as text", () => {
			// 新编辑器隔离前例被拒报文。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 发送主码点69与Shift修饰，没有另给shifted/base码点。
			editor.handleInput("\x1b[69;2u");

			// 要求恰是E，证明支持此显式文本编码。
			assert.strictEqual(editor.getText(), "E");
		});

		// modifyOtherKeys例：ESC[27;2;69~也描述Shift+码点E，应该与上一种编码得到同样文本；不需要真实xterm输入设备。
		it("inserts shifted xterm modifyOtherKeys letters as text", () => {
			// 创建新空Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 27为该编码的固定前导字段，2为Shift修饰，69为实际字符码点。
			editor.handleInput("\x1b[27;2;69~");

			// 严格检查插入大写E，排除漏解码或插入报文数字。
			assert.strictEqual(editor.getText(), "E");
		});
	});

	// Unicode编辑组区分码元、字素和显示列：光标/切片用UTF-16，左右/退格按字素，渲染宽度另计。固定样本不能替代对所有Unicode组合的证明。
	describe("Unicode text editing behavior", () => {
		// 混合输入例：按单段输入依次拼ASCII问候、三个变音字母与一个表情，getText应保留字面值。不是文件编码读写测试。
		it("inserts mixed ASCII, umlauts, and emojis as literal text", () => {
			// 新Editor起始为空，输入顺序决定正文顺序。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 输入大写H，开启Hello文本。
			editor.handleInput("H");
			// 输入e，接在H后。
			editor.handleInput("e");
			// 输入第一个l。
			editor.handleInput("l");
			// 输入第二个l，重复字符也正常保留。
			editor.handleInput("l");
			// 输入o，拼成Hello。
			editor.handleInput("o");
			// 插入普通ASCII空格，作为词间分隔，不提交。
			editor.handleInput(" ");
			// 插入预组变音字母ä，此处占一个UTF-16码元。
			editor.handleInput("ä");
			// 继续插入ö，保留原字符编码。
			editor.handleInput("ö");
			// 继续插入ü，未转写成ASCII字母。
			editor.handleInput("ü");
			// 再插空格，隔开后面的表情。
			editor.handleInput(" ");
			// 传一个补充平面表情，它由两个UTF-16码元组成，但这次handleInput收到完整字符串。
			editor.handleInput("😀");

			// 读取并保存当前拼接的全文快照。
			const text = editor.getText();
			// 要求Hello、空格、三个变音字母及表情按输入顺序完整保留。
			assert.strictEqual(text, "Hello äöü 😀");
		});

		// 变音字母退格例：äöü各一字素/一码元，末尾退格一次应只删ü，留下äö。和下个双码元表情例形成对照。
		it("deletes single-code-unit unicode characters (umlauts) with Backspace", () => {
			// 创建独立空实例。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 插入ä作为首字符。
			editor.handleInput("ä");
			// 在其后插入ö。
			editor.handleInput("ö");
			// 插入ü，光标在末尾。
			editor.handleInput("ü");

			// Delete the last character (ü)
			// 0x7f表示Backspace，按实际字素边界删除前一个字素。
			editor.handleInput("\x7f"); // Backspace

			// 获取删除后全文，不读渲染缓存。
			const text = editor.getText();
			// 要求äö，验证只删一个字符且前两个没有乱码。
			assert.strictEqual(text, "äö");
		});

		// 双码元表情退格例：两个表情后按一次退格，第二个应整体消失，不能残留半个UTF-16代理对。实际删除按字素，不能简化成总是删一个或两个码元。
		it("deletes multi-code-unit emojis with single Backspace", () => {
			// 新建Editor，避免前例文本参与。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 插入第一个表情，提供应保留的对照。
			editor.handleInput("😀");
			// 插入第二个表情，作为退格目标。
			editor.handleInput("👍");

			// Delete the last emoji (👍) - single backspace deletes whole grapheme cluster
			// 一次Backspace应跳过第二个完整字素。
			editor.handleInput("\x7f"); // Backspace

			// 读退格后的字符串。
			const text = editor.getText();
			// 预期只剩第一个完整表情，严格字符串比较会发现残留代理单元。
			assert.strictEqual(text, "😀");
		});

		// 变音字符中间插入例：äöü后左移两次应落在ä与ö之间，插x得到äxöü，用全文检查移动边界。
		it("inserts characters at the correct position after cursor movement over umlauts", () => {
			// 建立独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 输入ä。
			editor.handleInput("ä");
			// 输入ö。
			editor.handleInput("ö");
			// 输入ü，光标在末尾列3。
			editor.handleInput("ü");

			// Move cursor left twice
			// 第一次左箭头越过ü，落到它之前。
			editor.handleInput("\x1b[D"); // Left arrow
			// 第二次越过ö，落在ä后。
			editor.handleInput("\x1b[D"); // Left arrow

			// Insert 'x' in the middle
			// 在此位置插x，原右侧öü应保持。
			editor.handleInput("x");

			// 读取插入后的全文。
			const text = editor.getText();
			// 要求äxöü，间接检查光标不是误按字节数移动。
			assert.strictEqual(text, "äxöü");
		});

		// 表情跨越例：三个表情后两次Left各跨一个完整字素，插x落在第一与第二表情之间。不能把一次箭头误当移动一个UTF-16码元。
		it("moves cursor across multi-code-unit emojis with single arrow key", () => {
			// 创建本例独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 插入第一个表情，后面应位于x左侧。
			editor.handleInput("😀");
			// 插入第二个表情，后面应位于x右侧。
			editor.handleInput("👍");
			// 再插第三个表情，初始光标在全部文本末尾。
			editor.handleInput("🎉");

			// Move cursor left over last emoji (🎉) - single arrow moves over whole grapheme
			// 一次Left跨过最后表情两个码元，保留整个字素。
			editor.handleInput("\x1b[D"); // Left arrow

			// Move cursor left over second emoji (👍)
			// 再Left跨过第二个表情，停到第一表情后。
			editor.handleInput("\x1b[D");

			// Insert 'x' between first and second emoji
			// 此处插入ASCII x，不替换任一表情。
			editor.handleInput("x");

			// 读取新的全文快照。
			const text = editor.getText();
			// 严格要求三个表情完整且x插在第一/第二之间，避免半代理对或错位。
			assert.strictEqual(text, "😀x👍🎉");
		});

		// 跨行变音字母例：小写一行、LF换行、大写一行，getText应保留两行大小写与分隔；输入LF直接换行，不是默认CR提交。
		it("preserves umlauts across line breaks", () => {
			// 新Editor初始为空。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 插首行ä。
			editor.handleInput("ä");
			// 接首行ö。
			editor.handleInput("ö");
			// 接首行ü。
			editor.handleInput("ü");
			// 单个LF走换行分支，把后续文字放新逻辑行。
			editor.handleInput("\n"); // new line
			// 插第二行大写Ä。
			editor.handleInput("Ä");
			// 继续第二行Ö。
			editor.handleInput("Ö");
			// 再插Ü，不依赖Caps Lock状态转换。
			editor.handleInput("Ü");

			// 读取含LF的存储全文。
			const text = editor.getText();
			// 要求两组三字符之间恰有一个LF，字符大小写没有变化。
			assert.strictEqual(text, "äöü\nÄÖÜ");
		});

		// 程序整体替换例：setText直接设置一段混合Unicode，读取应完全一致。原英文称paste simulation，但这条实际没有输入括号粘贴起止码，走的是公共setText路径。
		it("replaces the entire document with unicode text via setText (paste simulation)", () => {
			// 创建空Editor供整体替换使用。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Simulate bracketed paste / programmatic replacement
			// 把整段测试串交setText，规范换行/Tab并放光标末尾；本串没有那些需规范的字符，不调用系统粘贴。
			editor.setText("Hällö Wörld! 😀 äöüÄÖÜß");

			// 读取设入后的完整字符串。
			const text = editor.getText();
			// 严格保留变音字母、大小写、锐s及表情，检查程序设置没有损坏Unicode。
			assert.strictEqual(text, "Hällö Wörld! 😀 äöüÄÖÜß");
		});

		// Ctrl+A开头插入例：单行ab按Ctrl+A再x应得xab。实际动作是当前逻辑行首，本例只有一行所以也等于全文起点，不能从标题推广为多行总跳全文开头。
		it("moves cursor to document start on Ctrl+A and inserts at the beginning", () => {
			// 创建本例空Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 插入a。
			editor.handleInput("a");
			// 再插b，光标在单行末尾列2。
			editor.handleInput("b");
			// 0x01为Ctrl+A，默认键位把光标移到本逻辑行开头。
			editor.handleInput("\x01"); // Ctrl+A (move to start)
			// 在开头插x，原ab向右保留。
			editor.handleInput("x"); // Insert at start

			// 读取此次光标移动后的插入结果。
			const text = editor.getText();
			// 要求xab，防止把x追加末尾或替换原文。
			assert.strictEqual(text, "xab");
		});

		// 向后删词组合例：分别检查普通词、尾空白、标点段、点/冒号词边界、多行合并及表情簇，最后用Alt+Backspace验证同一删除动作。每次setText重置文字，但同一Editor删除环仍可保存旧删文，本例只断言当前文本。
		it("deletes words correctly with Ctrl+W and Alt+Backspace", () => {
			// 创建一个Editor反复设置样本文字，不为每组样本重新建实例。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Basic word deletion
			// 设foo bar baz，光标在baz之后。
			editor.setText("foo bar baz");
			// Ctrl+W向后删最后一个词baz，不自动吞掉它前面的分隔空格。
			editor.handleInput("\x17"); // Ctrl+W
			// 要求foo bar后仍有一个尾空格。
			assert.strictEqual(editor.getText(), "foo bar ");

			// Trailing whitespace
			// 改为foo bar后带三个空格，测试先越尾空白再删词的路径。
			editor.setText("foo bar   ");
			// Ctrl+W从末尾删除三个空格连同bar。
			editor.handleInput("\x17");
			// 剩foo加单空格，区分只删尾空白与连前词一起删。
			assert.strictEqual(editor.getText(), "foo ");

			// Punctuation run
			// 设foo bar...，末尾连续句点构成独立标点段。
			editor.setText("foo bar...");
			// Ctrl+W此时只删除连续标点，不同时删除bar。
			editor.handleInput("\x17");
			// 要求foo bar，确认标点与词在本例分开处理。
			assert.strictEqual(editor.getText(), "foo bar");

			// ASCII punctuation inside Intl word-like segments preserves old boundaries
			// 点夹在foo和bar之间，测试即使Intl分词可能视为整体，实现仍保留ASCII标点边界。
			editor.setText("foo.bar");
			// 从末尾Ctrl+W删除bar。
			editor.handleInput("\x17");
			// 保留foo和末尾句点，不能一次把foo.bar全删。
			assert.strictEqual(editor.getText(), "foo.");

			// 换成冒号分隔foo:bar，给另一种ASCII标点对照。
			editor.setText("foo:bar");
			// 向后删末词bar。
			editor.handleInput("\x17");
			// 要求保留foo:，证明该固定冒号样本同样按边界处理。
			assert.strictEqual(editor.getText(), "foo:");

			// Delete across multiple lines
			// 设两行line one/line two，末尾在two之后。
			editor.setText("line one\nline two");
			// Ctrl+W先删除第二行的two，不跨LF把首行也删掉。
			editor.handleInput("\x17");
			// 保留完整首行、LF和第二行line后的空格。
			assert.strictEqual(editor.getText(), "line one\nline ");

			// Delete empty line (merge)
			// 设line one后接LF，末逻辑行为空。
			editor.setText("line one\n");
			// 空行开头Ctrl+W删除前面的换行，实现行合并。
			editor.handleInput("\x17");
			// 结果仅line one，不保留额外空行。
			assert.strictEqual(editor.getText(), "line one");

			// Grapheme safety (emoji as a word)
			// 设foo、空格、两个表情、空格、bar，给字素段删除样本。
			editor.setText("foo 😀😀 bar");
			// 第一次Ctrl+W先删末词bar。
			editor.handleInput("\x17");
			// 要求两个表情仍完整，末尾分隔空格保留。
			assert.strictEqual(editor.getText(), "foo 😀😀 ");
			// 再Ctrl+W删除尾空白和相邻的这组表情段，不能留半个表情。
			editor.handleInput("\x17");
			// 结果foo加空格，检查表情簇已完整删去。
			assert.strictEqual(editor.getText(), "foo ");

			// Alt+Backspace
			// 最后设foo bar供另一种键编码对照。
			editor.setText("foo bar");
			// ESC后接DEL是旧式Alt+Backspace，应命中与Ctrl+W相同的向后删词动作，不是真实系统退格。
			editor.handleInput("\x1b\x7f"); // Alt+Backspace (legacy)
			// 要求foo加空格，验证备用快捷键产生同样文本结果。
			assert.strictEqual(editor.getText(), "foo ");
		});

		// 词导航组合例：foo bar... baz按Ctrl+左右在词和标点边界停下，再测前导空格及foo.bar。所有col是UTF-16下标，ASCII样本恰好也等于显示偏移；移动不删除文字。
		it("navigates words correctly with Ctrl+Left/Right", () => {
			// 创建独立Editor，默认键位将Ctrl+左右映为按词移动。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置foo bar... baz，14个ASCII字符，光标在末尾码元列14。
			editor.setText("foo bar... baz");
			// Cursor at end

			// Move left over baz
			// Ctrl+Left跳到baz起点，越过最后一个词。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			// 要求列11，即baz起点；句点段后还有一个分隔空格，不能把行尾英文after三个点理解成列10。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 }); // after '...'

			// Move left over punctuation
			// 再Ctrl+Left从baz前越过空格及连续句点段。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			// 要求列7，停在bar后、句点段前。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // after 'bar'

			// Move left over bar
			// 再左移一个词，跨过bar到它的起点。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			// 确认列4，即foo和空格之后。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 }); // after 'foo '

			// Move right over bar
			// 从bar开头Ctrl+Right向词尾移动。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			// 要求列7，位于三个句点之前。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // at end of 'bar'

			// Move right over punctuation run
			// 再Ctrl+Right把连续句点作为一个标点段跨越。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			// 要求列10，即句点段之后、后续空格之前。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 }); // after '...'

			// Move right skips space and lands after baz
			// 再次向右，跳过分隔空格及末词baz。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			// 要求列14，到整个14字符样本的末尾。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 14 }); // end of line

			// Test forward from start with leading whitespace
			// 改为三个前导空格后接foo bar，重新从新文本末尾起步。
			editor.setText("   foo bar");
			// Ctrl+A回本逻辑行开头列0，给向右跨空白测试明确起点。
			editor.handleInput("\x01"); // Ctrl+A to go to start
			// Ctrl+Right先越过三个前导空格，再越foo。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			// 要求列6，也就是三个空格加foo的码元长度。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 }); // after 'foo'

			// ASCII punctuation inside Intl word-like segments preserves old boundaries
			// 设foo.bar baz，点位于词内部位置，测试仍把它当独立边界。
			editor.setText("foo.bar baz");
			// 从末尾Ctrl+Left越baz。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left over baz
			// 确认列8，即baz的起点。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });
			// 再左移越bar。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left over bar
			// 确认列4，恰好在句点之后。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 });
			// 再次左移越单个句点。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left over .
			// 确认列3，在foo之后句点之前。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

			// Ctrl+A把起点重新放到行首，不继续从当前列3测试右移。
			editor.handleInput("\x01"); // Ctrl+A
			// Ctrl+Right跨foo。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right over foo
			// 应停列3，不能直接跨foo.bar整体。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
			// 再右移跨句点。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right over .
			// 应到列4，在bar之前。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 });
			// 第三次右移越bar。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right over bar
			// 应到列7，仍未越过后续空格及baz。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 });
		});

		// 回归#4972：你好、中文逗号、世界应形成可分开的词/标点边界，左右移动依次停0/2/3/5。汉字每个通常占两显示格，这里的列仍是码元下标，不能拿5当屏幕格宽。
		it("stops at fullwidth Chinese punctuation (issue #4972)", () => {
			// 建立独立Editor运行中文标点场景。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 你好，世界 = 你好(0-2) ，(2-3) 世界(3-5)
			// 设你好逗号世界，五个BMP字符各一码元，光标在下标5。
			editor.setText("你好，世界");
			// Cursor at end (col 5)

			// Move left over 世界
			// Ctrl+Left先跨世界这个分词段。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			// 要求列3，位于逗号后世界前。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 }); // after ，

			// Move left over ，
			// 再次左移只跨中文逗号。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			// 要求列2，在你好之后逗号之前。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 }); // after 你好

			// Move left over 你好
			// 第三次左移跨你好。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			// 到码元列0，首词开头。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 }); // start

			// Move right over 你好
			// 从开头Ctrl+Right跨你好。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			// 到列2，停在逗号前。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 }); // after 你好

			// Move right over ，
			// 再Ctrl+Right跨逗号。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			// 到列3，停在世界前。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 }); // after ，

			// Move right over 世界
			// 最后跨世界。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			// 到列5，即整个逻辑行字符串末尾，不是渲染宽度5格。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 }); // end
		});

		// 中英混排词导航例：hello、你好、逗号、world、世界没有全靠空格隔开，仍按这些分词边界移动。先逆向再正向检查同一串的位置，不测试文本翻译或网络分词。
		it("handles mixed CJK and ASCII word movement", () => {
			// 创建独立实例，分段由本地Intl与共享词导航规则计算。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// "hello你好，world世界" = hello(0-5) 你好(5-7) ，(7-8) world(8-13) 世界(13-15)
			// 设hello你好逗号world世界，15个UTF-16码元；中英文分界不插额外空格。
			editor.setText("hello你好，world世界");
			// Cursor at end (col 15)

			// Move left over 世界
			// 从末尾左跨世界。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			// 到列13，在world后世界前。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 13 }); // after 'world'

			// Move left over world
			// 再左跨world。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			// 到列8，在中文逗号之后。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 }); // after ，

			// Move left over ，
			// 再左跨逗号。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			// 到列7，在你好之后。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // after 你好

			// Move left over 你好
			// 再左跨你好。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			// 到列5，在hello之后。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 }); // after 'hello'

			// Move left over hello
			// 再左跨hello。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			// 到行首0。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 }); // start

			// Forward from start
			// 正向Ctrl+Right先跨hello。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			// 到列5，未把相连中文一起跳过。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 }); // after 'hello'

			// 下一步跨你好。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			// 到列7，中文词保持完整。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // after 你好

			// 下一步跨中文逗号。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			// 到列8，停在world前。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 }); // after ，

			// 下一步跨world。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			// 到列13，停在世界前。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 13 }); // after 'world'

			// 最后跨世界。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			// 到列15，即完整串末尾，和逆向起点相同。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 15 }); // end
		});
	});

	// 滚动提示组：Editor内部只显示有限正文折行，上下边框显示隐藏数量；render返回字符串数组并更新几何/滚动状态，不直接读取真实终端窗口。
	describe("Scroll indicators", () => {
		// 宽边框居中例：40列、20逻辑行，上移10次后上下提示应分别为9 more和4 more，并在两侧补15条横线。检查完整边框文字，不靠肉眼判断居中。
		it("centers scroll indicators on wide borders", () => {
			// 把组件渲染总宽固定40列。
			const width = 40;
			// 给宿主同样40列、缺省24行，实际正文可见上限floor(24×0.3)=7行，边框另算。
			const editor = new Editor(createTestTUI(width), defaultEditorTheme);
			// 生成line0到line19二十行，用LF连接；每条短于折行预算，因此各占一个正文显示片段。
			editor.setText(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));

			// 先render一次保存折行宽度并让末尾光标可见，后续上下键沿用这个几何。
			editor.render(width);
			// 循环10次Up同步移动光标；无需等TUI排帧，因为下面直接调用Editor.render获取结果。
			for (let index = 0; index < 10; index++) editor.handleInput("\x1b[A");

			// 重新渲染取当前视口与两条边框，保存到lines。
			const lines = editor.render(width);
			// 首行非空断言!只影响TS；剥控制码后要求15横线、上箭头9 more、15横线，验证40列对称。
			assert.strictEqual(stripVTControlCharacters(lines[0]!), `${"─".repeat(15)} ↑ 9 more ${"─".repeat(15)}`);
			// at(-1)取末条边框，剥控制码后要求下箭头4 more同样居中；两条隐藏数量是不同方向。
			assert.strictEqual(stripVTControlCharacters(lines.at(-1)!), `${"─".repeat(15)} ↓ 4 more ${"─".repeat(15)}`);
		});

		// 回归#6962：10列不足放完整滚动提示，仍应截短到10列并完整保留品红边框着色。检查上下箭头前缀、精确样式包裹与所有行宽，非真实终端颜色测试。
		it("keeps truncated scroll indicators within width and preserves their color (issue #6962)", () => {
			// 窄宽度设10，迫使带计数提示截短。
			const width = 10;
			// 定义输入字符串返回SGR35/39包裹的品红函数；类型注解不验证传入值，模板只构造字符串不输出。
			const borderColor = (text: string) => `\x1b[35m${text}\x1b[39m`;
			// 对象展开复制主题字段，再用同名borderColor覆盖边框函数，其余菜单主题仍复用原引用。
			const editor = new Editor(createTestTUI(width), { ...defaultEditorTheme, borderColor });
			// 设置同样20行编号正文，给上下滚动都留内容。
			editor.setText(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));

			// Render once to initialize wrapping, then move the cursor so content remains above and below the viewport.
			// 首轮render初始化宽度/滚动状态。
			editor.render(width);
			// 上移10次，让正文视口上下都存在隐藏行。
			for (let index = 0; index < 10; index++) editor.handleInput("\x1b[A");

			// 再次render获得截短提示样式的实际行数组。
			const lines = editor.render(width);
			// 取首行上边框，!声明此测试预期数组非空，不增加运行时检查。
			const topBorder = lines[0]!;
			// at(-1)取下边框，现代数组负下标从末尾数。
			const bottomBorder = lines.at(-1)!;

			// 正则只要求上边框以三个横线、空格、上箭头开头；不是精确断言完整截短文案。
			assert.match(stripVTControlCharacters(topBorder), /^─── ↑/);
			// 下边框同样应以三个横线和下箭头开头，防方向提示被裁没。
			assert.match(stripVTControlCharacters(bottomBorder), /^─── ↓/);
			// 要求原上边框精确等于其纯文字重新包一次borderColor，确认着色包裹未丢或额外嵌套。
			assert.strictEqual(topBorder, borderColor(stripVTControlCharacters(topBorder)));
			// 下边框也要满足同样单层包裹关系。
			assert.strictEqual(bottomBorder, borderColor(stripVTControlCharacters(bottomBorder)));
			// 遍历每条输出行，包括两边框和可见正文，不只检查刚才取出的两行。
			for (const line of lines) {
				// 每行visibleWidth必须恰等于10，消息里的line exceeds只是诊断；用的是相等检查，也会拒绝意外少列。
				assert.strictEqual(visibleWidth(line), width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
			}
		});
	});

	// 字素感知折行组：用宽图符、汉字、组合文字检查显示列预算；字符数、码元数和终端格宽不同，伪光标标记/ANSI不应贡献可见宽。
	describe("Grapheme-aware text wrapping", () => {
		// 混入双格对勾的短句例：20列render后逐正文行应恰好20格。标题说wraps，但这条不直接断言折为几行或每行具体文本，只检查输出行宽。
		it("wraps lines correctly when text contains wide emojis", () => {
			// 构造空Editor与默认虚拟宿主。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 组件本次总宽20，与宿主默认80列可以不同；Editor按传入render宽度布局。
			const width = 20;

			// ✅ is 2 columns wide, so "Hello ✅ World" is 14 columns
			// 设置含双格对勾的Hello/World短句，完整文本显示宽14，和UTF-16长度不同。
			editor.setText("Hello ✅ World");
			// 调用真实Editor.render返回带边框、伪光标和填充的行数组。
			const lines = editor.render(width);

			// All content lines (between borders) should fit within width
			// 从索引1循环到末行之前，只审两边框之间的正文行。
			for (let i = 1; i < lines.length - 1; i++) {
				// 取当前行并按终端显示格计算宽度，!不生成运行时数组边界检查。
				const lineWidth = visibleWidth(lines[i]!);
				// 要求每条正文恰20格；模板诊断同时给索引和实测值，断言失败才显示。
				assert.strictEqual(lineWidth, width, `Line ${i} has width ${lineWidth}, expected ${width}`);
			}
		});

		// 六个双格对勾的窄宽例：render总宽10，但默认无padding时折行预算9、另留1格光标。原英文把首行描述成5个图符，这条实际断言只遍历现有正文检查总宽，不直接断言分配或行数。
		it("wraps long text with emojis at correct positions", () => {
			// 建立独立Editor，不沿用前个样本文字。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 总渲染宽设10，折行预算由Editor另外扣光标位。
			const width = 10;

			// Each ✅ is 2 columns. "✅✅✅✅✅" = 10 columns, fits exactly
			// "✅✅✅✅✅✅" = 12 columns, needs wrap
			// 设置六个双格图符，总文字显示宽12，必须折行容纳。
			editor.setText("✅✅✅✅✅✅");
			// 取得真实折行结果，正文行还会补空格到完整10列。
			const lines = editor.render(width);

			// Should have 2 content lines (plus 2 border lines)
			// First line: 5 emojis (10 cols), second line: 1 emoji (2 cols) + padding
			// 逐条遍历实际正文，跳过上下边框；循环本身不要求正文恰好两行。
			for (let i = 1; i < lines.length - 1; i++) {
				// 按显示宽计算该输出行，而不是用字符串length数内部标记。
				const lineWidth = visibleWidth(lines[i]!);
				// 各行必须恰10格，防宽字符或光标让输出超宽。
				assert.strictEqual(lineWidth, width, `Line ${i} has width ${lineWidth}, expected ${width}`);
			}
		});

		// 泰/老挝语孤立AM字素例：两个固定字符串分别render8列，所有行都应8格。检查宽度不漂移，不断言字体如何画孤立组合字符或所有复杂文字都兼容。
		it("renders isolated Thai and Lao AM clusters without width drift", () => {
			// for..of遍历两个输入样本，每个都接ASCII abc，仍只是同一个it的两轮断言。
			for (const text of ["ำabc", "ຳabc"]) {
				// 每轮新建Editor，避免前个文本和折行状态影响。
				const editor = new Editor(createTestTUI(), defaultEditorTheme);
				// 固定总宽8列。
				const width = 8;
				// 把当前泰语或老挝语样本设为完整文本。
				editor.setText(text);

				// 直接render并遍历全部结果，包含边框，未过滤正文。
				for (const line of editor.render(width)) {
					// 每行都要求8格，诊断含JSON编码样本文字方便区分两轮；不是输出到真实屏幕。
					assert.strictEqual(visibleWidth(line), width, `line width drift for ${JSON.stringify(text)}: ${line}`);
				}
			}
		});

		// CJK精确分行例：六个日文全角字符共12格，总宽11、预算10，预期正文两行分别五字和一字；同时检查填充后行宽。
		it("wraps CJK characters correctly (each is 2 columns wide)", () => {
			// 新建Editor供汉字/假名折行输入使用。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 10加1为总宽11，最后一格预留行末伪光标，原表达式保留为显式说明。
			const width = 10 + 1; // +1 col reserved for cursor

			// Each CJK char is 2 columns. "日本語テスト" = 6 chars = 12 columns
			// 设日本語テスト六个全角字符，每个按当前宽度规则占2格。
			editor.setText("日本語テスト");
			// 真实render按10格正文预算生成两条显示行。
			const lines = editor.render(width);

			// 循环只检查两边框之间的正文。
			for (let i = 1; i < lines.length - 1; i++) {
				// 测当前整条带填充的正文显示宽。
				const lineWidth = visibleWidth(lines[i]!);
				// 要求总宽11，包括光标和空格，不是只要求可见文字本身填满11格。
				assert.strictEqual(lineWidth, width, `Line ${i} has width ${lineWidth}, expected ${width}`);
			}

			// Verify content split correctly
			// slice去边框，map剥控制/内部标记并trim首尾空白，得到便于精确比较的正文文本；这会故意忽略补白。
			const contentLines = lines.slice(1, -1).map((l) => stripTerminalSequences(l).trim());
			// 直接要求正文有两条，比前面的仅宽度循环增加行数验证。
			assert.strictEqual(contentLines.length, 2);
			// 第一条应五字日本語テス，共10显示格，不把最后ト也塞进来。
			assert.strictEqual(contentLines[0], "日本語テス"); // 5 chars = 10 columns
			// 第二条应仅ト；补白被trim去掉，原渲染行实际仍满足11格。
			assert.strictEqual(contentLines[1], "ト"); // 1 char = 2 columns (+ padding)
		});

		// 混合ASCII与宽字刚好容纳例：Test、对勾、OK、两个汉字总宽15，用16列render的15格预算应只有一条正文，并补光标到16格。
		it("handles mixed ASCII and wide characters in wrapping", () => {
			// 创建本例Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 总宽16由15加1组成，无边距时折行预算15。
			const width = 15 + 1; // +1 col reserved for cursor

			// "Test ✅ OK 日本" = 4 + 1 + 2 + 1 + 2 + 1 + 4 = 15 columns (fits in width-1=15)
			// 设混合短句，普通字符、空格、双格图符及汉字共同计宽。
			editor.setText("Test ✅ OK 日本");
			// 按总宽16生成真实渲染结果。
			const lines = editor.render(width);

			// Should fit in one content line
			// 去掉首末边框，但保留正文ANSI/内部光标和填充，供宽度测量。
			const contentLines = lines.slice(1, -1);
			// 要求正文恰一行，验证没有错误把宽字多算导致折到第二行。
			assert.strictEqual(contentLines.length, 1);

			// 测唯一正文行的显示宽，!表示测试先前已要求存在这一项。
			const lineWidth = visibleWidth(contentLines[0]!);
			// 要求16格，覆盖末尾光标位及补白，而非仅15格文字。
			assert.strictEqual(lineWidth, width);
		});

		// 宽字旁光标例：A、双格对勾、B后render20列，应出现内部伪光标开始标记并保持行宽20。断言并未直接定位标记在B后哪一码元，也不验证硬件光标。
		it("renders cursor correctly on wide characters", () => {
			// 新建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 总宽20，为短文本及光标留充足空间。
			const width = 20;

			// 整体设A加双格对勾加B，setText把光标放文字末尾。
			editor.setText("A✅B");
			// Cursor should be at end (after B)
			// 渲染该状态，末尾伪光标用一个带标记空格承载。
			const lines = editor.render(width);

			// The cursor (reverse video space) should be visible
			// 取第一条正文行，即数组索引1，上方索引0是边框。
			const contentLine = lines[1]!;
			// 要求这一行含FAKE_CURSOR_START，确认生成了内部光标标记；并未直接读取屏幕反色样式。
			assert.ok(contentLine.includes(FAKE_CURSOR_START), "Should have fake cursor");

			// Line should still be correct width
			// 再要求正文显示宽仍20，伪光标标记不应按普通字符多算列。
			assert.strictEqual(visibleWidth(contentLine), width);
		});

		// 宽图符位于折行边界例：十个数字后接双格对勾，总文字12格，render总宽11、预算10。逐正文检查不超宽，不直接比较折行文本或行数。
		it("does not exceed terminal width with emoji at wrap boundary", () => {
			// 新建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 总宽设11列，默认无边距时另留光标位。
			const width = 11;

			// "0123456789✅" = 10 ASCII + 2-wide emoji = 12 columns
			// Should wrap before the emoji since it would exceed width
			// 设置十位 ASCII 数字后接双格对勾，共12格文字；它超过本例10格的折行预算，因此对勾需要进入后续显示片段。
			editor.setText("0123456789✅");
			// 按11列渲染获得输出数组。
			const lines = editor.render(width);

			// 循环仅检查上下边框之间的正文。
			for (let i = 1; i < lines.length - 1; i++) {
				// 测一条带光标/填充的正文显示宽。
				const lineWidth = visibleWidth(lines[i]!);
				// 只要求小于等于11而非严格等于，验证没有越过总宽；错误信息提供该行实测宽。
				assert.ok(lineWidth <= width, `Line ${i} has width ${lineWidth}, exceeds max ${width}`);
			}
		});

		// 光标临界折行例：分别测padding0和1时，9个a仍同一正文行且末尾带光标，再加第10个才折第二行。两种总宽分别10和11，实际折行预算都为9。
		it("shows cursor at end of line before wrap, wraps on next char", () => {
			// 基础宽度固定10，用后面的padding值调整总宽。
			const width = 10;
			// for..of依次取0与1，每轮独立构造Editor，仍是一个it内两个参数样本。
			for (const paddingX of [0, 1]) {
				// 总宽width+paddingX；padding0扣光标1得9，padding1总宽11扣左右2得9，右边距可供光标占用。对象的paddingX是属性简写。
				const editor = new Editor(createTestTUI(width + paddingX), defaultEditorTheme, { paddingX });

				// Type 9 chars → fills layoutWidth exactly, cursor at end on same line
				// for..of按字符输入九个a，ASCII下每次一个码元/字素，正好填9格文字预算。
				for (const ch of "aaaaaaaaa") editor.handleInput(ch);
				// let保存按当前总宽渲染结果，之后追加文字还会重赋。
				let lines = editor.render(width + paddingX);
				// 去掉两条边框，得到当前正文行数组。
				let contentLines = lines.slice(1, -1);
				// 要求正文一行，验证末尾光标不会单独强制新行。
				assert.strictEqual(contentLines.length, 1, "Should be 1 content line before wrap");
				// 第一条正文应以完整伪光标空格标记结尾；生成预期字符串不直接画光标。
				assert.ok(contentLines[0]!.endsWith(renderFakeCursor(" ")), "Cursor should be at end of line");

				// Type 1 more → text wraps to second line
				// 再输入一个a，将文字长度增至10超过布局预算9。
				editor.handleInput("a");
				// 重新按本轮总宽render，不继续检查旧数组。
				lines = editor.render(width + paddingX);
				// 重新去边框，更新contentLines引用。
				contentLines = lines.slice(1, -1);
				// 要求正文变两行，验证临界字符之后才发生折行。
				assert.strictEqual(contentLines.length, 2, "Should wrap to 2 content lines");
			}
		});
	});

	// 词折行组既测完整Editor输出，也直接测wordWrapLine返回片段及原串范围。空白仍保留在原文中，显示行折开与逻辑行LF分隔是不同概念。
	describe("Word wrapping", () => {
		// 英文句子折行例：40列下检查首正文不以连字符结尾、每行末字符属于指定ASCII集合。标题说整词换行，但这些启发式断言不能独立证明每个词绝无中间截断，后面另有精确片段测试。
		it("wraps at word boundaries instead of mid-word", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 总宽40，默认正文预算39，超出时按真实算法找边界。
			const width = 40;

			// 设一段足够长的英文句子，词由普通空格分开。
			editor.setText("Hello world this is a test of word wrapping functionality");
			// render产生可见折行、边框与光标标记。
			const lines = editor.render(width);

			// Get content lines (between borders)
			// slice去边框，map剥终端序列并trim补白，数组元素是此次可见正文的纯文本。
			const contentLines = lines.slice(1, -1).map((l) => stripTerminalSequences(l).trim());

			// Should NOT break mid-word
			// Line 1 should end with a complete word
			// 只排除首条正文末尾是连字符；不核对每个原始词是否完整，不因这条断言就宣称所有词边界正确。
			assert.ok(!contentLines[0]!.endsWith("-"), "Line should not end with hyphen (mid-word break)");

			// Each content line should be complete words
			// 遍历每条纯文字正文，进一步检查行尾字符外形。
			for (const line of contentLines) {
				// Words at end of line should be complete (no partial words)
				// 去末尾空白再slice(-1)取最后一码元；这些ASCII样本不存在半代理对问题。
				const lastChar = line.trimEnd().slice(-1);
				// 允许空串、ASCII字母数字下划线或列出的标点；正则不带u，\w也不是所有Unicode字母，这个有限检查本身不是完整词检测器。
				assert.ok(lastChar === "" || /[\w.,!?;:]/.test(lastChar), `Line ends unexpectedly with: "${lastChar}"`);
			}
		});

		// 词折行前导空白例：Word1至Word6按20列输出后，任何非空正文行不能以空白加非空白开头。只测当前无padding样本，不要求任意有配置边距的正文都无前导空格。
		it("does not start lines with leading whitespace after word wrap", () => {
			// 新Editor默认paddingX为0。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 总宽20，正文折行预算19。
			const width = 20;

			// 设置六个用单空格隔开的词，让部分词进入下一显示行。
			editor.setText("Word1 Word2 Word3 Word4 Word5 Word6");
			// 取得带边框和填充的实际输出。
			const lines = editor.render(width);

			// Get content lines (between borders)
			// 只去边框，保留正文原有空格，避免先trim把待发现的前导空白删掉。
			const contentLines = lines.slice(1, -1);

			// No line should start with whitespace (except for padding at the end)
			// 用下标循环所有正文行，索引可加入失败消息。
			for (let i = 0; i < contentLines.length; i++) {
				// 剥终端控制序列，保留空白正文；!是TS非空断言。
				const line = stripVTControlCharacters(contentLines[i]!);
				// 另算trimStart版本只判断是否存在非空正文，不覆盖line原值。
				const trimmedStart = line.trimStart();
				// The line should either be all padding or start with a word character
				// 纯空白行不要求从词开始，只有确有非空内容时检查下面规则。
				if (trimmedStart.length > 0) {
					// 对只裁尾部后的原line做行首空白检查，若以一段空白紧接非空白则失败；不是匹配原句的具体分词位置。
					assert.ok(!/^\s+\S/.test(line.trimEnd()), `Line ${i} starts with unexpected whitespace before content`);
				}
			}
		});

		// 长URL折行例：30列下所有正文行都应保持总宽30，不能让长无空格片段超宽。URL仅作输入文字，既不请求网站也不打开浏览器；本例不逐字重建完整URL。
		it("breaks long words (URLs) at character level", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 总渲染宽设30，正文预算29。
			const width = 30;

			// 把长地址及前后单词设为正文，长路径本身超过单行预算。
			editor.setText("Check https://example.com/very/long/path/that/exceeds/width here");
			// 调用真实折行渲染路径，不使用浏览器URL换行逻辑。
			const lines = editor.render(width);

			// All lines should fit within width
			// 逐条检查上下边框间的正文输出。
			for (let i = 1; i < lines.length - 1; i++) {
				// 计算含补白/光标后实际显示宽。
				const lineWidth = visibleWidth(lines[i]!);
				// 要求每行严格30格，不仅不超宽，也不能意外少列；失败文案显示索引与数值。
				assert.strictEqual(lineWidth, width, `Line ${i} has width ${lineWidth}, expected ${width}`);
			}
		});

		// 同行多空格例：宽50足够容纳Word1三空格Word2四空格Word3，检查Word1和Word2间三空格仍在。只断言该片段，不独立检查另一段四空格。
		it("preserves multiple spaces within words on same line", () => {
			// 创建新编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 总宽50让这段文字无需因窄宽拆开。
			const width = 50;

			// 输入中故意保留不同长度的连续空格，不能用split后重拼一个空格代替。
			editor.setText("Word1   Word2    Word3");
			// 渲染并保存实际行数组。
			const lines = editor.render(width);

			// 取首正文剥控制码、trim首尾补白，内部空格应原样保留。
			const contentLine = stripVTControlCharacters(lines[1]!).trim();
			// Multiple spaces should be preserved
			// includes检查Word1后三个空格再Word2存在，严格区分三个与一个空格。
			assert.ok(contentLine.includes("Word1   Word2"), "Multiple spaces should be preserved");
		});

		// 空文字渲染例：预期总共三行，即上边框、空内容加光标行、下边框；并非返回空数组。只检查行数，不检查各行完整样式。
		it("handles empty string", () => {
			// 构造独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 总宽40，给空输入使用正常布局。
			const width = 40;

			// 显式setText空串，不添加历史或提交。
			editor.setText("");
			// render空状态仍要生成正文光标载体与边框。
			const lines = editor.render(width);

			// Should have border + empty content + border
			// 要求行数组长度3，防空文本导致组件消失或多空行。
			assert.strictEqual(lines.length, 3);
		});

		// 刚好一词预算例：十个数字在总宽11/预算10下仍只一条正文，光标占预留第11格。检查总行数3及首正文含完整十位数字。
		it("handles single word that fits exactly", () => {
			// 新Editor隔离前例空文本。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 总宽写为10加1，明确十格文字与额外光标格。
			const width = 10 + 1; // +1 col reserved for cursor

			// 设置正好十个ASCII数字，光标在末尾。
			editor.setText("1234567890");
			// 按11列渲染当前状态。
			const lines = editor.render(width);

			// Should have exactly 3 lines (top border, content, bottom border)
			// 要求三行，即没有为行末光标额外折出第二正文行。
			assert.strictEqual(lines.length, 3);
			// 取首正文并剥终端控制码，保留文字与补白。
			const contentLine = stripVTControlCharacters(lines[1]!);
			// 要求十位原词连续存在，排除遗漏部分数字；本条不是整行精确比较。
			assert.ok(contentLine.includes("1234567890"), "Content should contain the word");
		});

		// 直接折行宽11例：hello加空格后剩5格，看似刚好放world，但整串后续还有空格test导致溢出，算法可回退到hello后的边界，预期hello空格/world test两片。整行若本来放得下会走快路，不能推广成所有词一碰边界就前移。
		it("wraps word to next line when it ends exactly at terminal width", () => {
			// "hello " (6) + "world" (5) = 11, but "world" is non-whitespace ending at width.
			// Thus, wrap it to next line. The trailing space stays with "hello" on line 1
			// 调用wordWrapLine，宽度11就是片段文字预算，没有Editor再扣光标位这一层。
			const chunks = wordWrapLine("hello world test", 11);

			// 返回恰两片，不因空格单独产生第三空片。
			assert.strictEqual(chunks.length, 2);
			// 首片精确为hello加一个尾空格，原空白不丢。
			assert.strictEqual(chunks[0]!.text, "hello ");
			// 第二片精确world空格test，后两词合计10格。
			assert.strictEqual(chunks[1]!.text, "world test");
		});

		// 宽12空白边界例：hello world后的空格正好落满12格，允许保留首片，再把test放次片。与前例宽11相比，预算多1使可用软边界变化。
		it("keeps whitespace at terminal width boundary on same line", () => {
			// "hello world " is exactly 12 chars (including trailing space)
			// The space at position 12 should stay on the first line
			// 直接以12格调用同一原句折行，未构造Editor或TUI。
			const chunks = wordWrapLine("hello world test", 12);

			// 要求两片。
			assert.strictEqual(chunks.length, 2);
			// 首片保留hello world末尾空格，精确12个ASCII字符。
			assert.strictEqual(chunks[0]!.text, "hello world ");
			// 次片仅test，不把上个词或空格重复进去。
			assert.strictEqual(chunks[1]!.text, "test");
		});

		// 不可拆词填满宽度例：12个a后接空格与4个a，首段强拆在第12个a后，后续空格仍保留在第二片。直接片段API不承诺所有结果都无前导空白。
		it("handles unbreakable word filling width exactly followed by space", () => {
			// 以12格预算折17字符输入，长首词恰填满预算。
			const chunks = wordWrapLine("aaaaaaaaaaaa aaaa", 12);

			// 要求两片。
			assert.strictEqual(chunks.length, 2);
			// 首片恰12个a，不能提前折成更短片。
			assert.strictEqual(chunks[0]!.text, "aaaaaaaaaaaa");
			// 次片是一个前导空格加4个a，检查原文空格没有被吞或移到上一片。
			assert.strictEqual(chunks[1]!.text, " aaaa");
		});

		// 长词在剩余空间放不下例：六空格之后的12个a本身能填整行，但不能连前导空格一起放同一片，预期六空格/12个a。
		it("wraps word to next line when it fits width but not remaining space", () => {
			// 对六空格加12个a使用预算12，真实算法从空白后的软边界回退。
			const chunks = wordWrapLine("      aaaaaaaaaaaa", 12);

			// 要求两片，不把长词逐字符散到许多行。
			assert.strictEqual(chunks.length, 2);
			// 首片应完整保留六空格，而非返回空串。
			assert.strictEqual(chunks[0]!.text, "      ");
			// 第二片为整条12个a，无前导空格残留。
			assert.strictEqual(chunks[1]!.text, "aaaaaaaaaaaa");
		});

		// 短词加多空格加后词能合放例：30格下Lorem...sit后折，次片保留amet逗号、四空格、consectetur。检查精确片段，防算法在多空格中误截或丢空格。
		it("keeps word with multi-space and following word together when they fit", () => {
			// 以30格调用固定英文样本，输入里的四个连续空格是待保留数据。
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,    consectetur", 30);

			// 预期仅两片。
			assert.strictEqual(chunks.length, 2);
			// 首片精确到sit后的空格，原分隔空白留在前片。
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			// 第二片应保留amet,后四空格再consectetur，未压缩成一空格。
			assert.strictEqual(chunks[1]!.text, "amet,    consectetur");
		});

		// 多空格组合刚好30格例：amet,占5、十四空格、consectetur占11，总计30，仍可完整合成第二片。
		it("keeps word with multi-space and following word when they fill width exactly", () => {
			// 调用固定十四空格样本，预算30；不用trim或重写源字符串去制造预期。
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,              consectetur", 30);

			// 要求两片，刚好装满不应误多出第三片。
			assert.strictEqual(chunks.length, 2);
			// 第一片仍为Lorem ipsum dolor sit后带一个空格。
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			// 第二片精确包含十四空格，长度30，原串空白全部保留。
			assert.strictEqual(chunks[1]!.text, "amet,              consectetur");
		});

		// 多加一格溢出例：十五空格使amet,/空白/consectetur共31，需把consectetur单放第三片，区别刚好预算与超1格。
		it("splits when word plus multi-space plus word exceeds width", () => {
			// 用相同30预算，输入空白由十四增到十五。
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,               consectetur", 30);

			// 这次要求三片。
			assert.strictEqual(chunks.length, 3);
			// 第一片仍到sit后空格，前面的词布局不变。
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			// 第二片保留amet,与全部十五空格，不把多空格丢掉。
			assert.strictEqual(chunks[1]!.text, "amet,               ");
			// 第三片为完整consectetur，不能在词中任意删字符。
			assert.strictEqual(chunks[2]!.text, "consectetur");
		});

		// 长空白恰好填第二片例：amet,后25空格共30格，consectetur放第三片。测试空白本身也占预算，不能按零宽处理。
		it("breaks long whitespace at line boundary", () => {
			// 调用25空格的固定样本，预算30。
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,                         consectetur", 30);

			// 要求三片。
			assert.strictEqual(chunks.length, 3);
			// 第一片依旧是Lorem ipsum dolor sit加尾空格。
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			// 第二片为5字符amet,加25空格，恰30列。
			assert.strictEqual(chunks[1]!.text, "amet,                         ");
			// 第三片只含consectetur，无额外空格。
			assert.strictEqual(chunks[2]!.text, "consectetur");
		});

		// 长空白超第二片1格例：26空格不能全和amet,放一片，第二片保留25格空白，剩余1空格进第三片。检查空白跨片后完整保留。
		it("breaks long whitespace at line boundary 2", () => {
			// 用26空格样本调用预算30。
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,                          consectetur", 30);

			// 结果仍三片，残余一空格可与末词同行。
			assert.strictEqual(chunks.length, 3);
			// 第一片不变。
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			// 第二片仍是amet,加25空格，不超30。
			assert.strictEqual(chunks[1]!.text, "amet,                         ");
			// 第三片明确含一个前导空格再consectetur，验证第26个空格未丢。
			assert.strictEqual(chunks[2]!.text, " consectetur");
		});

		// 更多空白跨片例：37空格中25个填满第二片，余12个与末词进入第三片。精确断言保留空白总量，不是把不可见部分随意trim。
		it("breaks whitespace spanning full lines", () => {
			// 以30预算折带37空格的固定原文。
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,                                     consectetur", 30);

			// 结果为三片，第三片的12空格加11字母仍能放下。
			assert.strictEqual(chunks.length, 3);
			// 第一片仍是相同前文，保留sit后的尾空格。
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			// 第二片为amet,加25空格，共30列。
			assert.strictEqual(chunks[1]!.text, "amet,                         ");
			// 第三片保留剩余12空格后接consectetur，逐字比较空白数量。
			assert.strictEqual(chunks[2]!.text, "            consectetur");
		});

		// 宽字符回退后仍超宽例：空格加186个a再汉字你，共189格，预算187。退到首空格后余188格仍太宽，必须强拆；检查每片不超宽及按范围重建原文，不能只看到没抛错就算正确。
		it("force-breaks when wide char after word boundary wrap still overflows", () => {
			// " " (1) + "a"*186 (186) + "你" (2) = 189 visible width
			// maxWidth = 187: backtracking to the space would leave 186 + 2 = 188 > 187,
			// so the algorithm must force-break before the wide char instead.
			// 模板先拼一空格、186个a和一个双格汉字；repeat构造测试数据，不执行外部命令。
			const line = ` ${"a".repeat(186)}你`;
			// 调用真实wordWrapLine，预算187显示格而非187码元。
			const chunks = wordWrapLine(line, 187);

			// 遍历全部返回片段，强拆后任何一片也不能超预算。
			for (const chunk of chunks) {
				// 多行assert.ok把布尔条件与失败文案分开给出。
				assert.ok(
					// 按片段text测显示宽，要求至多187，宽汉字不能只按一码元计。
					visibleWidth(chunk.text) <= 187,
					// 失败诊断只截片段前20码元并显示实际显示宽，不参与折行算法。
					`chunk "${chunk.text.slice(0, 20)}..." has visible width ${visibleWidth(chunk.text)}, expected <= 187`,
				);
			}
			// Verify no content is lost
			// 按每片startIndex/endIndex从原line切片再join空串重建，用的是UTF-16范围，不直接拼可能已变换的显示文本。
			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			// 要求重建与原line严格相等，防截断、重复或遗漏原始内容。
			assert.strictEqual(reconstructed, line);
		});

		// 预分段超宽原子标记例：把A、完整粘贴标记、B作为三个段，预算10时允许视觉上拆标记，但应保留全部原范围。直接wordWrapLine样本，不建立真正Editor粘贴注册表。
		it("splits oversized atomic segment across multiple chunks", () => {
			// Simulate a paste marker wider than maxWidth by passing pre-segmented data
			// 标记是固定ASCII文字；原行尾英文写21，实际这个带两位行数的标记有20个字符，但仍大于预算10。
			const marker = "[paste #1 +20 lines]"; // 21 chars
			// 在标记两端各加一个ASCII字符，测试拆标记时两侧内容不能丢。
			const line = `A${marker}B`;
			// Intl.SegmentData[]是开发期结构注解，这里手工给segment/index/input，没有实际调用Intl分段器生成这些三项。
			const segments: Intl.SegmentData[] = [
				// 首段A在原line下标0，input引用完整原字符串。
				{ segment: "A", index: 0, input: line },
				// 完整标记作为一个逻辑原子段，从下标1开始；不是逐个方括号/单词提供分段。
				{ segment: marker, index: 1, input: line },
				// B起点等于A的一码元加标记实际长度，不沿用原英文21这个不准确数字。
				{ segment: "B", index: 1 + marker.length, input: line },
			];

			// 第三参传预分段数组，折行函数仍可在超预算原子段内部递归按字素拆视觉片。
			const chunks = wordWrapLine(line, 10, segments);

			// Every chunk must fit within maxWidth
			// 逐一检查所有视觉片，逻辑原子性不等于强行让宽标记溢出屏幕。
			for (const chunk of chunks) {
				// assert.ok条件和失败消息分开列出。
				assert.ok(
					// 要求每片显示宽至多10，允许不足10，不要求补白填满。
					visibleWidth(chunk.text) <= 10,
					// 文案包含片段文字及实际宽，辅助发现拆标记后的具体超宽部分。
					`chunk "${chunk.text}" has visible width ${visibleWidth(chunk.text)}, expected <= 10`,
				);
			}

			// Verify no content is lost
			// 从原line按返回范围取片再拼接，验证范围覆盖整段A/标记/B。
			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			// 重建必须与原文相等，配合宽度断言同时排除丢字符和超宽。
			assert.strictEqual(reconstructed, line);
		});

		// 行首超宽原子段例：标记直接位于原文开头，后接B，预算10仍须拆标记并保留末字母。检查片宽、最后片包含B及按原范围完整重建，不指定每片所有文字。
		it("splits oversized atomic segment at start of line", () => {
			// 固定标记实际20个ASCII字符，原英文21不准确；这里用真实marker.length计算后续下标，避免依赖注释数值。
			const marker = "[paste #1 +20 lines]"; // 21 chars
			// 模板在完整标记之后接B，原文没有前置A。
			const line = `${marker}B`;
			// 手工提供Intl.SegmentData结构数组，类型仅开发期核对segment/index/input三字段。
			const segments: Intl.SegmentData[] = [
				// 标记被合成一个逻辑段，起点为0、input为完整line。
				{ segment: marker, index: 0, input: line },
				// B位于marker.length之后，不硬编码标记长度。
				{ segment: "B", index: marker.length, input: line },
			];

			// 以10格预算及预分段调用真实算法，超宽标记会视觉再分段。
			const chunks = wordWrapLine(line, 10, segments);

			// 遍历所有返回片段，不能只审首/末片。
			for (const chunk of chunks) {
				// 每片显示宽不得超过10，允许未填满预算。
				assert.ok(visibleWidth(chunk.text) <= 10);
			}
			// "B" ends up on the last line (either alone or with the marker tail)
			// 最后一片text必须包含B，但不强制它独占一行或与标记尾同行，两者都满足此断言。
			assert.strictEqual(chunks[chunks.length - 1]!.text.includes("B"), true);

			// 按startIndex/endIndex从原line取各片再拼，重建原范围顺序。
			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			// 重建必须等于标记加B原文，排除视觉拆分时遗漏或重复。
			assert.strictEqual(reconstructed, line);
		});

		// 行尾超宽原子段例：原文A后接标记，预算10时先保留A为独立首片，再拆标记；同时核所有片宽与原范围完整性。
		it("splits oversized atomic segment at end of line", () => {
			// 使用同一个20字符标记形状，原英文21保留但不作为实现长度依据。
			const marker = "[paste #1 +20 lines]"; // 21 chars
			// 模板仅在标记前加A，末尾没有B。
			const line = `A${marker}`;
			// 构造预分段数组，分别描述前置A与整条标记。
			const segments: Intl.SegmentData[] = [
				// A起点0，段文字为单字符A。
				{ segment: "A", index: 0, input: line },
				// 标记起点1，input仍是完整line而非标记子串。
				{ segment: marker, index: 1, input: line },
			];

			// 把两个逻辑段交10格折行，标记仍可在显示层拆开。
			const chunks = wordWrapLine(line, 10, segments);

			// 遍历实际返回的每片。
			for (const chunk of chunks) {
				// 要求每片可见宽至多10，防标记被当不可拆物体直接超宽。
				assert.ok(visibleWidth(chunk.text) <= 10);
			}
			// 首片应精确A，验证处理超宽后续段时未丢掉前面已有内容。
			assert.strictEqual(chunks[0]!.text, "A");

			// 按返回范围从原line切片拼接，检查所有原字符覆盖。
			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			// 要求重建等原line，不仅验证A还验证整条标记没有漏。
			assert.strictEqual(reconstructed, line);
		});

		// 两个连续超宽原子段例：两个不同粘贴标记相邻无空格，预算10要分别正确拆分并保留顺序。检查全部宽与重建，不依赖真实粘贴ID注册表。
		it("splits consecutive oversized atomic segments", () => {
			// 首标记编号1、行数20，实际文字长20，不是原注释说的21。
			const m1 = "[paste #1 +20 lines]"; // 21 chars
			// 次标记编号2、行数30，同样实际长20；两者文字不同，可发现误复用首段。
			const m2 = "[paste #2 +30 lines]"; // 21 chars
			// 把两个标记直接连接，模板没有隐含空格或LF。
			const line = `${m1}${m2}`;
			// 预分段数组只含两个完整原子段，不按其中单词拆。
			const segments: Intl.SegmentData[] = [
				// 第一段m1从原文起点0开始。
				{ segment: m1, index: 0, input: line },
				// 第二段m2起点按m1.length计算，保证衔接精确。
				{ segment: m2, index: m1.length, input: line },
			];

			// 以10格预算处理相邻原子段，递归视觉拆分仍需映回整串下标。
			const chunks = wordWrapLine(line, 10, segments);

			// 逐一审查两段拆出的全部片段。
			for (const chunk of chunks) {
				// 多行assert.ok明确列条件和诊断消息。
				assert.ok(
					// 每片visibleWidth必须不超过10。
					visibleWidth(chunk.text) <= 10,
					// 失败文案含片段原text及实际宽，仅供诊断，不影响分段。
					`chunk "${chunk.text}" has visible width ${visibleWidth(chunk.text)}, expected <= 10`,
				);
			}

			// 按所有片段的原文范围重建两个相邻标记。
			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			// 要求与m1+m2完全一致，能发现第二段错位、缺失或重复。
			assert.strictEqual(reconstructed, line);
		});

		// 超宽标记后恢复普通词折行例：标记后接hello world，预分段把标记合一、后面按ASCII字符提供，预算10下末片应是world。配合片宽/重建防标记拆完后普通文本继续布局失效。
		it("wraps normally after oversized atomic segment", () => {
			// 标记实际20字符；原21字符注释保持原样，后续坐标全部以marker.length为基准。
			const marker = "[paste #1 +20 lines]"; // 21 chars
			// 拼标记、空格、hello、空格、world，不插实际LF。
			const line = `${marker} hello world`;
			// 手工段数组把原子标记和其后每个字符分别标记原串起点。
			const segments: Intl.SegmentData[] = [
				// 标记是起点0的单个逻辑段。
				{ segment: marker, index: 0, input: line },
				// 标记后第一格为空格，起点恰marker.length。
				{ segment: " ", index: marker.length, input: line },
				// h在标记后偏移1。
				{ segment: "h", index: marker.length + 1, input: line },
				// e在标记后偏移2。
				{ segment: "e", index: marker.length + 2, input: line },
				// 第一个l在偏移3。
				{ segment: "l", index: marker.length + 3, input: line },
				// 第二个l在偏移4，重复字符仍有不同原文位置。
				{ segment: "l", index: marker.length + 4, input: line },
				// o在偏移5，至此描述完hello。
				{ segment: "o", index: marker.length + 5, input: line },
				// 偏移6是hello与world之间的空格，供普通软折行边界使用。
				{ segment: " ", index: marker.length + 6, input: line },
				// w在偏移7，开启最后一个词。
				{ segment: "w", index: marker.length + 7, input: line },
				// o在偏移8。
				{ segment: "o", index: marker.length + 8, input: line },
				// r在偏移9。
				{ segment: "r", index: marker.length + 9, input: line },
				// l在偏移10。
				{ segment: "l", index: marker.length + 10, input: line },
				// d在偏移11，原串最终一个字符。
				{ segment: "d", index: marker.length + 11, input: line },
			];

			// 以10格及整套预分段调用真实wordWrapLine，不让测试自己计算预期切分替代实现。
			const chunks = wordWrapLine(line, 10, segments);

			// All chunks must fit
			// 遍历标记子片及后续普通文字形成的全部片段。
			for (const chunk of chunks) {
				// assert.ok用实际宽作为条件，另给可读失败文案。
				assert.ok(
					// 要求每片不超过10格。
					visibleWidth(chunk.text) <= 10,
					// 文案显示失败片段文字和宽度，帮助区分标记尾与普通词的溢出。
					`chunk "${chunk.text}" has visible width ${visibleWidth(chunk.text)}, expected <= 10`,
				);
			}

			// Last chunk should contain "world" (normal wrapping resumes)
			// 最后片必须精确world，不仅包含world，也不能残留hello或前导空格；这条比原英文contain说法更严格。
			assert.strictEqual(chunks[chunks.length - 1]!.text, "world");

			// 按各片原始范围重建整条标记加hello world。
			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			// 严格等于原line，确认拆标记后所有普通字符与两个空格都未丢。
			assert.strictEqual(reconstructed, line);
		});
	});

	// 删除环组：成段删除保存到每个Editor自己的KillRing，Ctrl+Y粘回、Alt+Y轮换。它不是系统剪贴板，没有跨进程复制；连续kill能合并，setText只清连续动作而不清整个环。
	describe("Kill ring", () => {
		// 删词再换位置粘回例：foo bar baz删baz后回行首Ctrl+Y，应得到bazfoo bar，证明删文保留且在当前光标插入，不只支持原位恢复。
		it("Ctrl+W saves deleted text to kill ring and Ctrl+Y yanks it", () => {
			// 创建独立Editor，同时得到独立空删除环。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置三词文字，光标位于baz后。
			editor.setText("foo bar baz");
			// Ctrl+W删除baz并保存环中，原分隔空格保留。
			editor.handleInput("\x17"); // Ctrl+W - deletes "baz"
			// 确认当前全文为foo bar加尾空格。
			assert.strictEqual(editor.getText(), "foo bar ");

			// Move to beginning and yank
			// Ctrl+A回当前逻辑行开头，移动打断删除连续标记但不删除环记录。
			editor.handleInput("\x01"); // Ctrl+A
			// Ctrl+Y读取环尾baz并在行首粘回，不调用系统paste。
			editor.handleInput("\x19"); // Ctrl+Y
			// 要求baz位于foo之前，原尾空格仍保留，验证当前光标插入语义。
			assert.strictEqual(editor.getText(), "bazfoo bar ");
		});

		// 删到行首再粘回例：把光标放hello空格后，Ctrl+U删前缀，Ctrl+Y恢复hello world。实际向右6次，不是首行英文Right5times所写的5次。
		it("Ctrl+U saves deleted text to kill ring", () => {
			// 建立独立Editor及空环。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设hello world，初始光标在末尾。
			editor.setText("hello world");
			// Move cursor to middle
			// Ctrl+A归当前逻辑行首，方便精确定位到前缀之后。
			editor.handleInput("\x01"); // Ctrl+A (start)
			// 第1次Right到列1；虽然行尾英文写5次，此行本身只调用一次。
			editor.handleInput("\x1b[C"); // Right 5 times
			// 第2次Right到列2。
			editor.handleInput("\x1b[C");
			// 第3次Right到列3。
			editor.handleInput("\x1b[C");
			// 第4次Right到列4。
			editor.handleInput("\x1b[C");
			// 第5次Right到列5，位于hello后、空格前。
			editor.handleInput("\x1b[C");
			// 第6次Right到列6，越过空格，目标删区间是hello加空格。
			editor.handleInput("\x1b[C"); // After "hello "

			// Ctrl+U删除行首到光标前的六字符，并以向后方向存删除环。
			editor.handleInput("\x15"); // Ctrl+U - deletes "hello "
			// 当前文字应只剩world，光标回列0。
			assert.strictEqual(editor.getText(), "world");

			// Ctrl+Y在当前列0粘回hello空格。
			editor.handleInput("\x19"); // Ctrl+Y
			// 全文恢复hello world，验证删到行首也会保存环内容。
			assert.strictEqual(editor.getText(), "hello world");
		});

		// 删到行尾保存例：从hello world行首Ctrl+K删整行，再Ctrl+Y恢复，证明前向整段删除和后向删词都能供yank使用。
		it("Ctrl+K saves deleted text to kill ring", () => {
			// 新实例删除环初始为空。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置待删除的单行全文。
			editor.setText("hello world");
			// Ctrl+A回行首，当前全文都在光标右边。
			editor.handleInput("\x01"); // Ctrl+A (start)
			// Ctrl+K删除光标到逻辑行末的整个hello world，并追加到环。
			editor.handleInput("\x0b"); // Ctrl+K - deletes "hello world"

			// 要求当前文本空，确认删除已执行而非仅记录环内容。
			assert.strictEqual(editor.getText(), "");

			// Ctrl+Y粘回当前环尾条目。
			editor.handleInput("\x19"); // Ctrl+Y
			// 要求原始单行文字恢复，空格和词序也保持。
			assert.strictEqual(editor.getText(), "hello world");
		});

		// 空删除环例：只setText test、从未kill，Ctrl+Y应不修改文字。说明读取删除环不等于从系统剪贴板取任意内容。
		it("Ctrl+Y does nothing when kill ring is empty", () => {
			// 新建Editor，删除环初始为空。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置test不会把旧文字自动存进删除环。
			editor.setText("test");
			// Ctrl+Y遇空环直接不插入。
			editor.handleInput("\x19"); // Ctrl+Y
			// 要求仍test，排除空环误粘文本或清空内容。
			assert.strictEqual(editor.getText(), "test");
		});

		// 连续Alt+Y轮换例：用setText间隔三次删除建立first/second/third三条独立环项，Ctrl+Y先取third，再Alt+Y依次second、first、third。轮换替换上次yank区域，而非不断追加。
		it("Alt+Y cycles through kill ring after Ctrl+Y", () => {
			// 创建独立Editor，环最初没有项。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Create kill ring with multiple entries
			// 设first，setText把连续动作标志清掉。
			editor.setText("first");
			// 删first，建立第一条环记录。
			editor.handleInput("\x17"); // Ctrl+W - deletes "first"
			// 设second，打断kill合并但保留first记录。
			editor.setText("second");
			// 删second，成为新独立尾项，不与first拼接。
			editor.handleInput("\x17"); // Ctrl+W - deletes "second"
			// 设third，再次打断连续kill。
			editor.setText("third");
			// 删third，环按加入顺序有三条。
			editor.handleInput("\x17"); // Ctrl+W - deletes "third"

			// Kill ring now has: [first, second, third]
			// 确认当前文本已空，给第一次yank一个明确插入起点；此断言本身未读私有环顺序。
			assert.strictEqual(editor.getText(), "");

			// Ctrl+Y粘回最新尾项third，并标记刚执行yank。
			editor.handleInput("\x19"); // Ctrl+Y - yanks "third" (most recent)
			// 要求third，验证最新项优先。
			assert.strictEqual(editor.getText(), "third");

			// ESC加y表示Alt+Y，删除刚粘的third、旋环、插入新的尾项second。
			editor.handleInput("\x1by"); // Alt+Y - cycles to "second"
			// 应仅为second，不是thirdsecond追加。
			assert.strictEqual(editor.getText(), "second");

			// 再次Alt+Y沿同一yank链继续轮换。
			editor.handleInput("\x1by"); // Alt+Y - cycles to "first"
			// 应仅为first。
			assert.strictEqual(editor.getText(), "first");

			// 第三次Alt+Y跨过最旧项回到third，环轮换是循环的，和历史Up到边界不循环不同。
			editor.handleInput("\x1by"); // Alt+Y - cycles back to "third"
			// 要求third，验证环绕结果。
			assert.strictEqual(editor.getText(), "third");
		});

		// 未紧接yank时Alt+Y不动作例：删test后设other并输入x，最后Alt+Y保持otherx。本例从未Ctrl+Y，测试不能凭环非空就随便替换当前正文。
		it("Alt+Y does nothing if not preceded by yank", () => {
			// 新Editor用于非yank前置状态。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置test作为待保存删文。
			editor.setText("test");
			// Ctrl+W把test存环，当前文变空。
			editor.handleInput("\x17"); // Ctrl+W - deletes "test"
			// 公共setText置other并打断连续动作，没有清test环项。
			editor.setText("other");

			// Type something to break the yank chain
			// 输入x，最近动作是普通打字，不是yank。
			editor.handleInput("x");
			// 先确认otherx，给后面的不变断言设对照。
			assert.strictEqual(editor.getText(), "otherx");

			// Alt+Y should do nothing
			// Alt+Y在lastAction不是yank时早退。
			editor.handleInput("\x1by"); // Alt+Y
			// 仍otherx，不能把此前环里的test替进来。
			assert.strictEqual(editor.getText(), "otherx");
		});

		// 单环项轮换例：删only并Ctrl+Y后Alt+Y不改变文字。标题含小于等于1，本例具体覆盖1项，0项由另一空环场景讨论。
		it("Alt+Y does nothing if kill ring has ≤1 entry", () => {
			// 新实例给单项环场景一个空起点。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设only。
			editor.setText("only");
			// 删词存唯一环项only。
			editor.handleInput("\x17"); // Ctrl+W - deletes "only"

			// Ctrl+Y粘回only并形成yank链。
			editor.handleInput("\x19"); // Ctrl+Y - yanks "only"
			// 确认已粘回，避免后面不变只是从未yank。
			assert.strictEqual(editor.getText(), "only");

			// Alt+Y即使紧接yank，环只有一项也不执行替换。
			editor.handleInput("\x1by"); // Alt+Y - should do nothing (only 1 entry)
			// 文本仍only；从可见文字也不能独立区分内部做了同文替换，所以无操作规则还来自callee核对。
			assert.strictEqual(editor.getText(), "only");
		});

		// 连续删词累积例：one two three连删三次后Ctrl+Y应一次恢复整句，说明向后删的新片段前插到同一环项。不通过私有环length断言，主要观察一次yank返回完整内容。
		it("consecutive Ctrl+W accumulates into one kill ring entry", () => {
			// 创建独立Editor及空环。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设整句，光标在three后。
			editor.setText("one two three");
			// 先删three，环尾为three。
			editor.handleInput("\x17"); // Ctrl+W - deletes "three"
			// 再删two及其后空格，向后删文前置，环尾变two空格three。
			editor.handleInput("\x17"); // Ctrl+W - deletes "two " (prepended)
			// 再删one及空格，继续前置成完整原句。
			editor.handleInput("\x17"); // Ctrl+W - deletes "one " (prepended)

			// 三次后当前文本空，全部词均已删除。
			assert.strictEqual(editor.getText(), "");

			// Should be one combined entry
			// 一次Ctrl+Y取当前累积项，若三次被分开保存只能取最后删的部分。
			editor.handleInput("\x19"); // Ctrl+Y
			// 要求one two three一次完整恢复，顺序不能逆转。
			assert.strictEqual(editor.getText(), "one two three");
		});

		// 跨行Ctrl+U累积例：逐次删line3、LF、line2、LF、line1，最后一次yank恢复三行。换行也是删文，行合并不能从环里漏LF。
		it("Ctrl+U accumulates multiline deletes including newlines", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Start with multiline text, cursor at end
			// 设三行文字，光标在逻辑行2列5。
			editor.setText("line1\nline2\nline3");
			// Cursor is at end of line3 (line 2, col 5)

			// Delete "line3"
			// Ctrl+U先删末行行首到光标前的line3。
			editor.handleInput("\x15"); // Ctrl+U
			// 前两行与末尾LF仍保留，第三行变空。
			assert.strictEqual(editor.getText(), "line1\nline2\n");

			// Delete newline (at start of empty line 2, merges with line1)
			// 空末行列0再次Ctrl+U删除前一LF，并移到line2末尾；原英文merges with line1容易混淆，这里逻辑行1实际是line2。
			editor.handleInput("\x15"); // Ctrl+U
			// 要求line1换行line2，第三条空逻辑行已合并掉。
			assert.strictEqual(editor.getText(), "line1\nline2");

			// Delete "line2"
			// 再Ctrl+U删当前line2全文，并前置到累积删文。
			editor.handleInput("\x15"); // Ctrl+U
			// 只剩line1及一个末尾LF。
			assert.strictEqual(editor.getText(), "line1\n");

			// Delete newline
			// 再删连接首行与空次行的LF。
			editor.handleInput("\x15"); // Ctrl+U
			// 只剩line1，无换行。
			assert.strictEqual(editor.getText(), "line1");

			// Delete "line1"
			// 最后Ctrl+U删line1。
			editor.handleInput("\x15"); // Ctrl+U
			// 当前文本空，五步已删除全部原内容。
			assert.strictEqual(editor.getText(), "");

			// All deletions accumulated into one entry: "line1\nline2\nline3"
			// Ctrl+Y粘回累积包含LF的整段。
			editor.handleInput("\x19"); // Ctrl+Y
			// 要求原三行完整恢复，不能变成无换行的line1line2line3。
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");
		});

		// 前向删后粘回样本：标题说前插/追加累积，但实际光标在竖线前，首个Ctrl+K一次删整个竖线加suffix，第二次已在全文末尾不会再删。此测试实际验证前向后缀可恢复，不能据标题宣称它覆盖了两次不同方向累积。
		it("backward deletions prepend, forward deletions append during accumulation", () => {
			// 创建独立Editor，删除环为空。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置prefix竖线suffix，竖线是普通正文字符，不是光标标记。
			editor.setText("prefix|suffix");
			// Position cursor at |
			// Ctrl+A到行首。
			editor.handleInput("\x01"); // Ctrl+A
			// 循环六次Right越过六字符prefix，停在竖线前列6。
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // Move right 6 times

			// Ctrl+K从当前列6删到行末，实际删的是竖线加suffix；原英文只写suffix并不精确。
			editor.handleInput("\x0b"); // Ctrl+K - deletes "suffix" (forward)
			// 第二次Ctrl+K已在唯一行末，无下一行，不再删除；原英文说删竖线与实际分支不符。
			editor.handleInput("\x0b"); // Ctrl+K - deletes "|" (forward, appended)
			// 文本应仅prefix，与第一次删掉完整后缀相符。
			assert.strictEqual(editor.getText(), "prefix");

			// Ctrl+Y粘回环中的竖线加suffix。
			editor.handleInput("\x19"); // Ctrl+Y
			// 要求prefix竖线suffix恢复，不证明两个kill分别删了不同片段。
			assert.strictEqual(editor.getText(), "prefix|suffix");
		});

		// 普通打字打断kill累积例：先删baz、输入x、再删x，两条环记录应分开，yank取x、Alt+Y换baz。这个不同文本的序列可观察合并标志确已被打断。
		it("non-delete actions break kill accumulation", () => {
			// 新建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Delete "baz", then type "x" to break accumulation, then delete "x"
			// 设foo bar baz。
			editor.setText("foo bar baz");
			// Ctrl+W删baz，第一条环项为baz。
			editor.handleInput("\x17"); // Ctrl+W - deletes "baz"
			// 当前保留foo bar尾空格。
			assert.strictEqual(editor.getText(), "foo bar ");

			// 插x，打断lastAction为kill的连续链。
			editor.handleInput("x"); // Typing breaks accumulation
			// 确认正文变foo bar x。
			assert.strictEqual(editor.getText(), "foo bar x");

			// 再Ctrl+W删x，因此前打字建立新环项而不与baz合并。
			editor.handleInput("\x17"); // Ctrl+W - deletes "x" (separate entry, not accumulated)
			// 正文又回foo bar尾空格。
			assert.strictEqual(editor.getText(), "foo bar ");

			// Yank most recent - should be "x", not "xbaz"
			// Ctrl+Y粘当前最新项x。
			editor.handleInput("\x19"); // Ctrl+Y
			// 要求foo bar x，排除粘回xbaz等误累积结果。
			assert.strictEqual(editor.getText(), "foo bar x");

			// Cycle to previous - should be "baz" (separate entry)
			// 紧接Alt+Y轮换到上一条baz。
			editor.handleInput("\x1by"); // Alt+Y
			// 应为foo bar baz，说明x与baz是独立可轮换项。
			assert.strictEqual(editor.getText(), "foo bar baz");
		});

		// 打字打断yank链例：建立first/second两项，yank second后输入x，再Alt+Y不得替换。保留环记录但禁止再把当前光标前长度误当刚粘区域。
		it("non-yank actions break Alt+Y chain", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设first。
			editor.setText("first");
			// 删first存首项。
			editor.handleInput("\x17"); // Ctrl+W
			// 设second，同时打断kill连续合并。
			editor.setText("second");
			// 删second存第二独立项。
			editor.handleInput("\x17"); // Ctrl+W
			// 显式清空当前编辑文字，删除环仍保留两项。
			editor.setText("");

			// Ctrl+Y粘最新second并标yank。
			editor.handleInput("\x19"); // Ctrl+Y - yanks "second"
			// 确认当前正文second。
			assert.strictEqual(editor.getText(), "second");

			// 再输入x，最近动作改为打字，旧yank链结束。
			editor.handleInput("x"); // Type breaks yank chain
			// 当前正文secondx。
			assert.strictEqual(editor.getText(), "secondx");

			// Alt+Y在非yank动作之后不应再旋环/替换正文。
			editor.handleInput("\x1by"); // Alt+Y - should do nothing
			// 要求secondx不变，防错误替换掉词尾或整个second。
			assert.strictEqual(editor.getText(), "secondx");
		});

		// 环旋转持久到实例后续操作例：third经Alt+Y换second后，打字并清文本，再Ctrl+Y仍取second。这里持久仅指本实例环顺序保留，不写磁盘或跨进程记忆。
		it("kill ring rotation persists after cycling", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设first，准备首项。
			editor.setText("first");
			// 删first入环。
			editor.handleInput("\x17"); // deletes "first"
			// 设second打断累积。
			editor.setText("second");
			// 删second入环。
			editor.handleInput("\x17"); // deletes "second"
			// 设third打断累积。
			editor.setText("third");
			// 删third后环按first/second/third排列。
			editor.handleInput("\x17"); // deletes "third"
			// 清当前文字，不清环数组。
			editor.setText("");

			// Ring: [first, second, third]

			// Ctrl+Y取third。
			editor.handleInput("\x19"); // Ctrl+Y - yanks "third"
			// Alt+Y把third移环首，新的尾项second被粘回。
			editor.handleInput("\x1by"); // Alt+Y - cycles to "second", ring rotates

			// Now ring is: [third, first, second]
			// 正文应是second，对应当前环尾。
			assert.strictEqual(editor.getText(), "second");

			// Do something else
			// 输入x打断yank链，但不会把环顺序恢复到最初。
			editor.handleInput("x");
			// 再setText清当前文，继续保留旋转后的环。
			editor.setText("");

			// New yank should get "second" (now at end after rotation)
			// 新的Ctrl+Y不依赖上次yank链，直接取当前尾项。
			editor.handleInput("\x19"); // Ctrl+Y
			// 要求仍second，证明旋转改变环本身而非只临时游标。
			assert.strictEqual(editor.getText(), "second");
		});

		// 跨行Ctrl+W合并例：按词及换行逐步删掉1/2/3三行，单次yank应完整恢复含LF的原文。与Ctrl+U相似，但这里验证删词路径也保存LF。
		it("consecutive deletions across lines coalesce into one entry", () => {
			// 新建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// "1\n2\n3" with cursor at end, delete everything with Ctrl+W
			// 设三条单字符逻辑行，光标在3之后。
			editor.setText("1\n2\n3");
			// 先Ctrl+W删末词3。
			editor.handleInput("\x17"); // Ctrl+W - deletes "3"
			// 结果保留1换行2换行，即末行空。
			assert.strictEqual(editor.getText(), "1\n2\n");

			// 再Ctrl+W从空行开头删除前一LF，光标回2后。
			editor.handleInput("\x17"); // Ctrl+W - deletes newline (merge with prev line)
			// 结果1换行2。
			assert.strictEqual(editor.getText(), "1\n2");

			// 再次删词2，并前置到累积删文。
			editor.handleInput("\x17"); // Ctrl+W - deletes "2"
			// 只剩1和末尾LF。
			assert.strictEqual(editor.getText(), "1\n");

			// 再删这个LF。
			editor.handleInput("\x17"); // Ctrl+W - deletes newline
			// 只剩1。
			assert.strictEqual(editor.getText(), "1");

			// 最后删首词1。
			editor.handleInput("\x17"); // Ctrl+W - deletes "1"
			// 当前文字空。
			assert.strictEqual(editor.getText(), "");

			// All deletions should have accumulated into one entry
			// 一次Ctrl+Y取含词与LF的累积条目。
			editor.handleInput("\x19"); // Ctrl+Y
			// 要求原三行1/2/3完整恢复，顺序与行分隔均保持。
			assert.strictEqual(editor.getText(), "1\n2\n3");
		});

		// 行末Ctrl+K合并例：ab/cd两行，光标在ab尾，第一次删LF得abcd，第二次删cd，再yank恢复LF加cd。确实覆盖两个不同前向删文片段的连续追加。
		it("Ctrl+K at line end deletes newline and coalesces", () => {
			// 构造本例独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// "ab" on line 1, "cd" on line 2, cursor at end of line 1
			// 先显式清空，后面逐字建立两行文本。
			editor.setText("");
			// 插首行a。
			editor.handleInput("a");
			// 再插b，形成ab。
			editor.handleInput("b");
			// LF新建第二逻辑行，不触发提交。
			editor.handleInput("\n");
			// 插第二行c。
			editor.handleInput("c");
			// 再插d，形成cd，光标在它后面。
			editor.handleInput("d");
			// Move to end of first line
			// Up移动到第一行相应位置。
			editor.handleInput("\x1b[A"); // Up arrow
			// Ctrl+E明确放第一逻辑行末列2，为删除LF设起点。
			editor.handleInput("\x05"); // Ctrl+E - end of line

			// Now at end of "ab", Ctrl+K should delete newline (merge with "cd")
			// Ctrl+K在行末删除连接下一行的LF，并将LF存删除环。
			editor.handleInput("\x0b"); // Ctrl+K - deletes newline
			// 结果abcd，光标仍在ab和cd连接处。
			assert.strictEqual(editor.getText(), "abcd");

			// Continue deleting
			// 紧接Ctrl+K删右侧cd，前向方向把cd追加到已保存LF之后。
			editor.handleInput("\x0b"); // Ctrl+K - deletes "cd"
			// 只剩ab，当前环尾应含LF加cd。
			assert.strictEqual(editor.getText(), "ab");

			// Both deletions should accumulate
			// Ctrl+Y在ab后粘回累积条目。
			editor.handleInput("\x19"); // Ctrl+Y
			// 要求ab换行cd，证明保存与追加顺序正确。
			assert.strictEqual(editor.getText(), "ab\ncd");
		});

		// 行中yank例：先删除word保存在环，再把光标放hello空格后粘回，结果hello wordworld。验证插入不覆盖原右侧world，也不自动加分隔空格。
		it("handles yank in middle of text", () => {
			// 创建独立Editor及空删除环。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置word供删除保存。
			editor.setText("word");
			// Ctrl+W删word，当前文空、环尾为word。
			editor.handleInput("\x17"); // Ctrl+W - deletes "word"
			// setText换hello world，保留删除环但重置最近动作和光标。
			editor.setText("hello world");

			// Move to middle (after "hello ")
			// Ctrl+A回本行开头。
			editor.handleInput("\x01"); // Ctrl+A
			// 六次Right到hello后的空格之后，原world在光标右边。
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C");

			// Ctrl+Y在当前位置插入word，不替换右侧原文。
			editor.handleInput("\x19"); // Ctrl+Y
			// 要求hello wordworld，说明插入值与原world直接相连，yank没有自动补空格。
			assert.strictEqual(editor.getText(), "hello wordworld");
		});

		// 行中yank-pop例：FIRST/SECOND两条删除环记录，先在hello与world间粘SECOND，再Alt+Y只替换刚粘区成FIRST，两侧原文要保持。
		it("handles yank-pop in middle of text", () => {
			// 新Editor隔离删除环。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Create two kill ring entries
			// 设FIRST。
			editor.setText("FIRST");
			// 删FIRST存第一项。
			editor.handleInput("\x17"); // Ctrl+W - deletes "FIRST"
			// 设SECOND，打断kill连续合并。
			editor.setText("SECOND");
			// 删SECOND存第二独立项。
			editor.handleInput("\x17"); // Ctrl+W - deletes "SECOND"

			// Ring: ["FIRST", "SECOND"]

			// Set up "hello world" and position cursor after "hello "
			// 设hello world，删除环仍有两项。
			editor.setText("hello world");
			// Ctrl+A移到行首。
			editor.handleInput("\x01"); // Ctrl+A - go to start of line
			// 六次Right越过hello和空格，定位中间插入点。
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // Move right 6

			// Yank "SECOND" in the middle
			// Ctrl+Y先插当前最新SECOND。
			editor.handleInput("\x19"); // Ctrl+Y
			// 要求hello SECONDworld，确认插入起点与保留右侧正文。
			assert.strictEqual(editor.getText(), "hello SECONDworld");

			// Yank-pop replaces "SECOND" with "FIRST"
			// Alt+Y删去刚粘的SECOND，旋环后插入FIRST。
			editor.handleInput("\x1by"); // Alt+Y
			// 要求hello FIRSTworld，长度变化也不能吞掉原world或重复保留SECOND。
			assert.strictEqual(editor.getText(), "hello FIRSTworld");
		});

		// 多行yank到单行轮换例：环里有SINGLE与A换行B，把多行项插hello/world之间，再Alt+Y改回单行项，原两侧正文应正确重新合行。
		it("multiline yank and yank-pop in middle of text", () => {
			// 新建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Create single-line entry
			// 设单行SINGLE。
			editor.setText("SINGLE");
			// Ctrl+W把SINGLE保存为独立首项。
			editor.handleInput("\x17"); // Ctrl+W - deletes "SINGLE"

			// Create multiline entry via consecutive Ctrl+U
			// setText改为A换行B，同时打断旧kill合并链。
			editor.setText("A\nB");
			// Ctrl+U删末行B。
			editor.handleInput("\x15"); // Ctrl+U - deletes "B"
			// 空末行开头Ctrl+U删LF，累积为LF加B。
			editor.handleInput("\x15"); // Ctrl+U - deletes newline
			// 再Ctrl+U删A并前置，环第二项完整A换行B。
			editor.handleInput("\x15"); // Ctrl+U - deletes "A"
			// Ring: ["SINGLE", "A\nB"]

			// Insert in middle of "hello world"
			// 设置当前正文hello world，不清删除环。
			editor.setText("hello world");
			// Ctrl+A回当前行首。
			editor.handleInput("\x01"); // Ctrl+A
			// 六次Right到hello后空格之后。
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C");

			// Yank multiline "A\nB"
			// Ctrl+Y插入多行A/B，首尾分别与原hello前文及world后文相接。
			editor.handleInput("\x19"); // Ctrl+Y
			// 要求hello A换行Bworld，检查插入多行结构而非仅串接无LF文字。
			assert.strictEqual(editor.getText(), "hello A\nBworld");

			// Yank-pop replaces with "SINGLE"
			// Alt+Y删除刚粘的跨行范围，旋环到SINGLE，再插回同一连接处。
			editor.handleInput("\x1by"); // Alt+Y
			// 结果一行hello SINGLEworld，验证多行删除/合行和不同长度替换都正确。
			assert.strictEqual(editor.getText(), "hello SINGLEworld");
		});

		// 前向删词累积例：从hello world test开头连续Alt+D删hello、空格world，再Ctrl+Y应恢复整句。前向删文追加到同一环项尾，而非后向删除的前置顺序。
		it("Alt+D deletes word forward and saves to kill ring", () => {
			// 建立独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置三词样本。
			editor.setText("hello world test");
			// Ctrl+A回行首，光标前无文，删除目标在右侧。
			editor.handleInput("\x01"); // Ctrl+A - go to start

			// ESC加d为旧式Alt+D，从当前列向前删hello。
			editor.handleInput("\x1bd"); // Alt+D - deletes "hello"
			// 要求前导空格加world test，原词后的分隔空格仍在。
			assert.strictEqual(editor.getText(), " world test");

			// 再Alt+D先越空白再删world，本次删文是一个空格加world。
			editor.handleInput("\x1bd"); // Alt+D - deletes " world" (skips whitespace, then word)
			// 只剩前导空格加test，光标仍在删除起点0。
			assert.strictEqual(editor.getText(), " test");

			// Yank should get accumulated text
			// Ctrl+Y粘回前向连续累积的hello空格world。
			editor.handleInput("\x19"); // Ctrl+Y
			// 要求原hello world test，验证累积顺序没有反向成worldhello。
			assert.strictEqual(editor.getText(), "hello world test");
		});

		// 行末Alt+D删换行例：line1末尾前向删词无本行字符可删，应删LF合成line1line2，再Ctrl+Y恢复LF。不是把下一行整词也一次删掉。
		it("Alt+D at end of line deletes newline", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设两行line1/line2，初始光标在第二行末尾。
			editor.setText("line1\nline2");
			// Move to start of document, then to end of first line
			// Up移第一行相应码元位置。
			editor.handleInput("\x1b[A"); // Up arrow - go to first line
			// Ctrl+E明确到第一逻辑行末尾，不是全文末尾。
			editor.handleInput("\x05"); // Ctrl+E - end of line

			// Alt+D在行末删连接下一行的LF，并记入环。
			editor.handleInput("\x1bd"); // Alt+D - deletes newline (merges lines)
			// 要求两行合成line1line2，正文字符不丢。
			assert.strictEqual(editor.getText(), "line1line2");

			// Ctrl+Y在两段连接处粘回LF，重新形成两逻辑行。
			editor.handleInput("\x19"); // Ctrl+Y
			// 要求line1换行line2，验证换行本身被保存。
			assert.strictEqual(editor.getText(), "line1\nline2");
		});
	});

	// 撤销组：Editor在合适边界保存文字/光标/粘贴注册表快照，UndoStack深复制后进后出；不含redo，也不把删除环、历史列表或异步补全任务整体回滚。
	describe("Undo", () => {
		// 空撤销栈例：全新Editor收到Ctrl+-，当前文字仍空。实际undo会先退出历史浏览，故不能把这条文字断言概括为所有内部状态绝无变化。
		it("does nothing when undo stack is empty", () => {
			// 新建空编辑器，尚无任何文字变更快照。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// CSI-u码45为减号、修饰5为Ctrl，默认映射undo，不插入减号。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 确认当前文本仍空，空栈不凭空恢复或删除内容。
			assert.strictEqual(editor.getText(), "");
		});

		// 连续单词字符合并例：逐字输入hello空格world，第一次undo去掉空格及world，第二次再去hello。空格前保存快照，因此不是每个字符都单独撤销。
		it("coalesces consecutive word characters into one undo unit", () => {
			// 创建独立Editor，undo栈初始空。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 输入h，首个连续打字动作在插入前保存空状态。
			editor.handleInput("h");
			// 输入e，与前一非空白输入共用撤销起点。
			editor.handleInput("e");
			// 输入第一个l，继续同一单元。
			editor.handleInput("l");
			// 输入第二个l，未因重复字母另存一份。
			editor.handleInput("l");
			// 输入o，当前为hello。
			editor.handleInput("o");
			// 输入空格前保存hello快照，空格及后面的连续非空白共享该起点。
			editor.handleInput(" ");
			// 输入w，延续空格之后的打字单元。
			editor.handleInput("w");
			// 继续o。
			editor.handleInput("o");
			// 继续r。
			editor.handleInput("r");
			// 继续l。
			editor.handleInput("l");
			// 最后d，形成world。
			editor.handleInput("d");
			// 先确认整句hello world，避免后面的undo结果建立在错误输入上。
			assert.strictEqual(editor.getText(), "hello world");

			// Undo removes " world" (space captured state before it, so we restore to "hello")
			// 第一次Ctrl+-弹最新快照，也就是空格插入之前的hello。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求hello，说明world与其前空格一起撤销。
			assert.strictEqual(editor.getText(), "hello");

			// Undo removes "hello"
			// 第二次undo弹首个h之前的空状态。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求空串，hello这个连续非空白段被整体撤销。
			assert.strictEqual(editor.getText(), "");
		});

		// 多个空格逐个撤销例：hello后两空格分别建起点，undo依次去第二空格、第一空格、hello。区分连续非空白合并与每空白单独建快照。
		it("undoes spaces one at a time", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 输入h并保存最初空状态。
			editor.handleInput("h");
			// 输入e，继续非空白打字单元。
			editor.handleInput("e");
			// 输入第一个l。
			editor.handleInput("l");
			// 输入第二个l。
			editor.handleInput("l");
			// 输入o，形成hello。
			editor.handleInput("o");
			// 第一个空格在插入前保存hello。
			editor.handleInput(" ");
			// 第二个空格再存hello加一空格，不能与前空白省成一个撤销点。
			editor.handleInput(" ");
			// 要求当前确有两个尾空格，严格比较不trim。
			assert.strictEqual(editor.getText(), "hello  ");

			// 第一次undo回第二空格之前。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes second " "
			// 仅剩一个尾空格，直接检查逐个撤销。
			assert.strictEqual(editor.getText(), "hello ");

			// 第二次undo回第一空格之前。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes first " "
			// 要求hello，无尾空格。
			assert.strictEqual(editor.getText(), "hello");

			// 第三次undo回首个字符之前。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes "hello"
			// 要求空串，单词仍作为一个整体单元。
			assert.strictEqual(editor.getText(), "");
		});

		// 换行分隔撤销例：hello、LF、world应三步分别撤销world、LF、hello；换行显式保存快照并打断打字合并，使新行首字符再建起点。
		it("undoes newlines and signals next word to capture state", () => {
			// 新Editor使用空撤销栈。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 输入h建立首词起点。
			editor.handleInput("h");
			// 继续e。
			editor.handleInput("e");
			// 继续第一个l。
			editor.handleInput("l");
			// 继续第二个l。
			editor.handleInput("l");
			// 继续o，形成首行hello。
			editor.handleInput("o");
			// LF调用新增逻辑行流程，保存换行前hello并清最近动作。
			editor.handleInput("\n");
			// 新行输入w，因为不是连续打字起点，保存hello加LF快照。
			editor.handleInput("w");
			// 输入o，与w共享这一新行单元。
			editor.handleInput("o");
			// 继续r。
			editor.handleInput("r");
			// 继续l。
			editor.handleInput("l");
			// 继续d，形成次行world。
			editor.handleInput("d");
			// 要求hello换行world，确认行结构。
			assert.strictEqual(editor.getText(), "hello\nworld");

			// 第一次undo撤掉world，但保留新行。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求hello后仍有LF，即第二逻辑行空。
			assert.strictEqual(editor.getText(), "hello\n");

			// 第二次undo恢复换行前状态。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求仅hello，LF单独被撤销。
			assert.strictEqual(editor.getText(), "hello");

			// 第三次undo恢复首词之前。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求空文本。
			assert.strictEqual(editor.getText(), "");
		});

		// 退格撤销例：输入hello后删o得hell，undo一次应回hello，不把输入整词也一并撤销。验证删字前独立存快照。
		it("undoes backspace", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 输入h，建立最初打字单元。
			editor.handleInput("h");
			// 接e。
			editor.handleInput("e");
			// 接第一个l。
			editor.handleInput("l");
			// 接第二个l。
			editor.handleInput("l");
			// 接o，光标在末尾。
			editor.handleInput("o");
			// Backspace保存删前快照并删除最后字素o。
			editor.handleInput("\x7f"); // Backspace
			// 确认现在hell，删除确已发生。
			assert.strictEqual(editor.getText(), "hell");

			// Ctrl+-恢复最近的删前状态。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求hello，撤销只作用于这次退格。
			assert.strictEqual(editor.getText(), "hello");
		});

		// 前向Delete撤销例：hello回行首右移一格，删e得hllo，undo恢复hello。验证在文本中间的删除快照，不只测试末尾Backspace。
		it("undoes forward delete", () => {
			// 新Editor使用独立文字和撤销栈。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 输入h。
			editor.handleInput("h");
			// 输入e。
			editor.handleInput("e");
			// 输入第一个l。
			editor.handleInput("l");
			// 输入第二个l。
			editor.handleInput("l");
			// 输入o，组成hello。
			editor.handleInput("o");
			// Ctrl+A回本逻辑行首列0。
			editor.handleInput("\x01"); // Ctrl+A - go to start
			// 一次Right到h之后、e之前列1。
			editor.handleInput("\x1b[C"); // Right arrow
			// CSI3~为Delete，向前删当前位置的e，不是退格删h。
			editor.handleInput("\x1b[3~"); // Delete key
			// 要求hllo，明确删除方向和目标。
			assert.strictEqual(editor.getText(), "hllo");

			// Ctrl+-恢复前向删除前快照。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求hello原文。
			assert.strictEqual(editor.getText(), "hello");
		});

		// Ctrl+W撤销例：输入hello world后删末词得到hello空格，再undo恢复整个world。与删除环yank不同，undo从快照恢复文字与光标，不旋转/清除删除环。
		it("undoes Ctrl+W (delete word backward)", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 输入h，建立首个打字撤销起点。
			editor.handleInput("h");
			// 继续e。
			editor.handleInput("e");
			// 继续第一个l。
			editor.handleInput("l");
			// 继续第二个l。
			editor.handleInput("l");
			// 继续o。
			editor.handleInput("o");
			// 输入空格，另存插入前快照。
			editor.handleInput(" ");
			// 输入w开启第二词正文。
			editor.handleInput("w");
			// 继续o。
			editor.handleInput("o");
			// 继续r。
			editor.handleInput("r");
			// 继续l。
			editor.handleInput("l");
			// 继续d。
			editor.handleInput("d");
			// 确认已输入完整hello world。
			assert.strictEqual(editor.getText(), "hello world");

			// Ctrl+W在删除前单独保存整句状态，再删world并存删除环。
			editor.handleInput("\x17"); // Ctrl+W
			// 要求hello后一个空格，验证末词已删。
			assert.strictEqual(editor.getText(), "hello ");

			// Ctrl+-从快照撤销刚才删词，不调用yank。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求完整hello world恢复。
			assert.strictEqual(editor.getText(), "hello world");
		});

		// Ctrl+K撤销及光标恢复例：hello后空格处删右侧world，undo恢复文字后再插竖线，必须落原删除起点而非末尾。用插入结果同时观察快照的光标恢复。
		it("undoes Ctrl+K (delete to line end)", () => {
			// 创建独立Editor及撤销栈。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 输入h。
			editor.handleInput("h");
			// 接e。
			editor.handleInput("e");
			// 接第一个l。
			editor.handleInput("l");
			// 接第二个l。
			editor.handleInput("l");
			// 接o，形成hello。
			editor.handleInput("o");
			// 输入分隔空格。
			editor.handleInput(" ");
			// 输入w。
			editor.handleInput("w");
			// 接o。
			editor.handleInput("o");
			// 接r。
			editor.handleInput("r");
			// 接l。
			editor.handleInput("l");
			// 接d，形成hello world。
			editor.handleInput("d");
			// Ctrl+A回本逻辑行首。
			editor.handleInput("\x01"); // Ctrl+A - go to start
			// 六次Right到列6，位于world之前。
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // Move right 6 times

			// Ctrl+K在存快照后删除右侧world，当前位置不前移。
			editor.handleInput("\x0b"); // Ctrl+K
			// 要求hello加一个尾空格，确认删除目标。
			assert.strictEqual(editor.getText(), "hello ");

			// Ctrl+-恢复Ctrl+K前的文字与列6光标。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 先确认整句恢复，单凭文本还不能证明光标也恢复。
			assert.strictEqual(editor.getText(), "hello world");

			// 在恢复后当前位置插入普通竖线。
			editor.handleInput("|");
			// 要求hello空格竖线world，说明undo把光标也放回world之前。
			assert.strictEqual(editor.getText(), "hello |world");
		});

		// Ctrl+U撤销例：hello空格后向左删前缀，得到world，再undo恢复整句。这里检查文字恢复，不另插字符验证恢复光标。
		it("undoes Ctrl+U (delete to line start)", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 输入h。
			editor.handleInput("h");
			// 接e。
			editor.handleInput("e");
			// 接第一个l。
			editor.handleInput("l");
			// 接第二个l。
			editor.handleInput("l");
			// 接o。
			editor.handleInput("o");
			// 插分隔空格。
			editor.handleInput(" ");
			// 插w。
			editor.handleInput("w");
			// 接o。
			editor.handleInput("o");
			// 接r。
			editor.handleInput("r");
			// 接l。
			editor.handleInput("l");
			// 接d，完成整句。
			editor.handleInput("d");
			// Ctrl+A回行首。
			editor.handleInput("\x01"); // Ctrl+A - go to start
			// 右移六次，到hello及空格之后。
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // Move right 6 times

			// Ctrl+U删除光标前的hello空格，保存删前快照。
			editor.handleInput("\x15"); // Ctrl+U
			// 要求当前仅world。
			assert.strictEqual(editor.getText(), "world");

			// Ctrl+-恢复最近的删前快照。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求hello world，前缀完整恢复。
			assert.strictEqual(editor.getText(), "hello world");
		});

		// yank可撤销例：hello空格先被Ctrl+W删空，再Ctrl+Y粘回，undo一次应撤掉整次yank回空。删除环仍保留文本，不因undo被整体清掉。
		it("undoes yank", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 输入h。
			editor.handleInput("h");
			// 接e。
			editor.handleInput("e");
			// 接第一个l。
			editor.handleInput("l");
			// 接第二个l。
			editor.handleInput("l");
			// 接o。
			editor.handleInput("o");
			// 插尾空格，之后删词会先越过该空白再删hello。
			editor.handleInput(" ");
			// Ctrl+W删除hello加空格并存删除环，当前文本空。
			editor.handleInput("\x17"); // Ctrl+W - delete "hello "
			// Ctrl+Y在插入前保存空状态快照，再粘回整段。
			editor.handleInput("\x19"); // Ctrl+Y - yank
			// 确认hello和尾空格都恢复。
			assert.strictEqual(editor.getText(), "hello ");

			// Ctrl+-撤销最近一次yank，不再额外执行Ctrl+W。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求空串，说明整次粘回作为一个撤销单元。
			assert.strictEqual(editor.getText(), "");
		});

		// 单行括号粘贴原子撤销例：在hello与空格world之间插beep boop，一次undo恢复整段插入前状态，再插竖线核光标。没有读取系统剪贴板。
		it("undoes single-line paste atomically", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设hello world，公共setText也可能保存其前状态，但这里关注后面的粘贴快照。
			editor.setText("hello world");
			// Ctrl+A回行首。
			editor.handleInput("\x01"); // Ctrl+A - go to start
			// 五次Right到hello后、原空格之前，区别前面六次Right的位置。
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // Move right 5 (after "hello", before space)

			// Simulate bracketed paste of "beep boop"
			// 200~开启、201~结束括号粘贴，完整一段在同次handleInput中提供；正文beep boop内部空格不拆成多个按键动作。
			editor.handleInput("\x1b[200~beep boop\x1b[201~");
			// 要求hellobeep空格boop空格world，保留原后缀与粘贴内部空白。
			assert.strictEqual(editor.getText(), "hellobeep boop world");

			// Single undo should restore entire pre-paste state
			// 一次Ctrl+-恢复整次粘贴之前快照。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求hello world，不能只撤销boop或一个字符。
			assert.strictEqual(editor.getText(), "hello world");

			// 在撤销后光标处插入竖线，检查原插入点也恢复。
			editor.handleInput("|");
			// 要求hello竖线空格world，光标仍在hello后列5。
			assert.strictEqual(editor.getText(), "hello| world");
		});

		// 粘贴不触发补全例：注入只计数返回null的提供者，粘贴含@路径文字后文本保留、调用数0、菜单关闭。路径只是正文，不扫描node_modules文件。此同步检查主要覆盖粘贴路径不立即发请求，未等待任意未来任务。
		it("does not trigger autocomplete during single-line paste", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// let计数初始0，仅实际调用getSuggestions时增加。
			let suggestionCalls = 0;

			// 对象按AutocompleteProvider接口核对两个方法，接口不自动产生运行时校验或文件查询。
			const mockProvider: AutocompleteProvider = {
				// 注册异步建议函数，忽略输入参数，若执行就记数并兑现空建议。
				getSuggestions: async () => {
					// 调用发生才给suggestionCalls加1，不是在构造对象时加。
					suggestionCalls += 1;
					// return null经async包装为兑现null的Promise，不代表异常拒绝。
					return null;
				},
				// applyCompletion属性简写引用文件顶部纯替换函数，不在注册时应用候选。
				applyCompletion,
			};

			// 安装提供者并取消已有补全，当前没有菜单。
			editor.setAutocompleteProvider(mockProvider);
			// 一次括号粘贴整个含@路径句子，内容直接走粘贴插入而不是逐字自然补全触发。
			editor.handleInput("\x1b[200~look at @node_modules/react/index.js please\x1b[201~");

			// 全文应精确包含@node_modules路径，起止控制码不进入存储文本。
			assert.strictEqual(editor.getText(), "look at @node_modules/react/index.js please");
			// 建议函数调用数仍0，证明观察时未执行它。
			assert.strictEqual(suggestionCalls, 0);
			// 菜单也未显示，不能因为文本有@就误打开候选。
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		// 回归#3599的模拟tmux粘贴：正文中的Ctrl+J CSI-u编码应先解成LF，得到三行，而非留下可打印报文尾。测试只提供编码字符串，不连接或启动tmux popup。
		it("decodes CSI-u Ctrl+letter sequences inside bracketed paste (tmux popup)", () => {
			// 创建新Editor用于专用粘贴解码路径。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// tmux popups with extended-keys-format=csi-u re-encode \n in pastes as
			// \x1b[106;5u (Ctrl+J). Without decoding, the per-char filter strips ESC
			// and leaks "[106;5u" between lines. See issue #3599.
			// 括号粘贴正文用两处ESC[106;5u分隔，106是小写j，Ctrl映成控制码10即LF；不是调用普通文本解码器插入j。
			editor.handleInput("\x1b[200~line1\x1b[106;5uline2\x1b[106;5uline3\x1b[201~");
			// 要求line1/line2/line3以两个LF分隔，不出现方括号数字尾串。
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");
		});

		// 多行括号粘贴原子撤销例：hello中间插三行，第一/末插入行分别接原前后文，一次undo还原全文与光标。普通三行未超过大粘贴阈值，因此存实际文字而非短标记。
		it("undoes multi-line paste atomically", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设hello world，光标初始末尾。
			editor.setText("hello world");
			// Ctrl+A到行首。
			editor.handleInput("\x01"); // Ctrl+A - go to start
			// 五次Right到hello之后、空格之前。
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // Move right 5 (after "hello", before space)

			// Simulate bracketed paste of multi-line text
			// 一次送入三行括号粘贴正文，内部两个LF直接作为插入内容而非提交键。
			editor.handleInput("\x1b[200~line1\nline2\nline3\x1b[201~");
			// 要求首行helloline1、中行line2、末行line3空格world，原后缀接末插入行。
			assert.strictEqual(editor.getText(), "helloline1\nline2\nline3 world");

			// Single undo should restore entire pre-paste state
			// 一次undo恢复三行粘贴前快照。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求原hello world，新增两条逻辑行整体撤销。
			assert.strictEqual(editor.getText(), "hello world");

			// 在恢复后插竖线，进一步验证光标。
			editor.handleInput("|");
			// 竖线应在hello与原空格间，说明恢复原列5。
			assert.strictEqual(editor.getText(), "hello| world");
		});

		// 程序插入可原子撤销例：insertTextAtCursor插图片路径样本文字，一次undo回原文，再插竖线核原光标。字符串/tmp/image.png不被打开，也不读取剪贴板或PNG。
		it("undoes insertTextAtCursor atomically", () => {
			// 建立独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设hello world。
			editor.setText("hello world");
			// Ctrl+A回行首。
			editor.handleInput("\x01"); // Ctrl+A - go to start
			// 五次Right到hello后，原空格在右侧。
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // Move right 5 (after "hello", before space)

			// Programmatic insertion (e.g., clipboard image path)
			// 直接调用公开插入API，整段路径作为文本，不执行文件系统访问。它不同于handlePaste，不会因路径起始符自动补可读性空格。
			editor.insertTextAtCursor("/tmp/image.png");
			// 要求hello紧接路径再接原空格world，明确没有自动加前导空格。
			assert.strictEqual(editor.getText(), "hello/tmp/image.png world");

			// Single undo should restore entire pre-insert state
			// Ctrl+-撤销一次程序插入。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求原hello world完整恢复。
			assert.strictEqual(editor.getText(), "hello world");

			// 再插普通竖线检查恢复后的列。
			editor.handleInput("|");
			// 要求hello竖线空格world，证明插入API快照含光标。
			assert.strictEqual(editor.getText(), "hello| world");
		});

		// 程序多行插入例：在hello后插line1/2/3，光标应在最后新增逻辑行的line3后、原后缀前；一次undo恢复。这里直接读取line和col，不仅通过后续插入间接检查。
		it("insertTextAtCursor handles multiline text", () => {
			// 新建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置原单行hello world。
			editor.setText("hello world");
			// Ctrl+A回行首。
			editor.handleInput("\x01"); // Ctrl+A - go to start
			// 右移五次到hello后列5。
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // Move right 5 (after "hello", before space)

			// Insert multiline text
			// 程序API插三行字符串，内部规范换行并直接更新行数组。
			editor.insertTextAtCursor("line1\nline2\nline3");
			// 要求首/末插入行分别接原前/后文，形成三条逻辑行。
			assert.strictEqual(editor.getText(), "helloline1\nline2\nline3 world");

			// Cursor should be at end of inserted text (after "line3", before " world")
			// 获取新光标坐标对象快照。
			const cursor = editor.getCursor();
			// 新光标逻辑行应2，即第三行。
			assert.strictEqual(cursor.line, 2);
			// 列应5，即line3码元末尾，原空格world仍在光标右侧。
			assert.strictEqual(cursor.col, 5); // "line3".length

			// Single undo should restore entire pre-insert state
			// 一次Ctrl+-撤销整次多行插入。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求恢复原单行hello world。
			assert.strictEqual(editor.getText(), "hello world");
		});

		// 换行规范例：程序插入CRLF与孤立CR都变LF，第一次插入还能undo回空。测试文件不按平台换行格式写盘，仅检查Editor存储字符串。
		it("insertTextAtCursor normalizes CRLF and CR line endings", () => {
			// 新建Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 显式清空，给第一次插入一个空基准。
			editor.setText("");

			// Insert text with CRLF
			// 插a/CRLF/b/CRLF/c，两码元CRLF应作为一次换行，不变成双LF。
			editor.insertTextAtCursor("a\r\nb\r\nc");
			// 要求a换行b换行c，统一存LF。
			assert.strictEqual(editor.getText(), "a\nb\nc");

			// Ctrl+-撤销整次首次插入。
			editor.handleInput("\x1b[45;5u"); // Undo
			// 要求回空串，规范化没有拆成多个撤销点。
			assert.strictEqual(editor.getText(), "");

			// Insert text with CR only
			// 再插x/CR/y/CR/z，测试孤立CR也规范成换行。
			editor.insertTextAtCursor("x\ry\rz");
			// 要求x换行y换行z，不保留CR。
			assert.strictEqual(editor.getText(), "x\ny\nz");
		});

		// setText清空也可撤销例：逐字建hello world，再setText空串，undo应恢复全文。公共替换是可撤销操作，不等于清撤销栈的submit。
		it("undoes setText to empty string", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 输入h。
			editor.handleInput("h");
			// 接e。
			editor.handleInput("e");
			// 接第一个l。
			editor.handleInput("l");
			// 接第二个l。
			editor.handleInput("l");
			// 接o。
			editor.handleInput("o");
			// 插分隔空格。
			editor.handleInput(" ");
			// 输入w。
			editor.handleInput("w");
			// 接o。
			editor.handleInput("o");
			// 接r。
			editor.handleInput("r");
			// 接l。
			editor.handleInput("l");
			// 接d。
			editor.handleInput("d");
			// 确认完整hello world。
			assert.strictEqual(editor.getText(), "hello world");

			// 公共setText把文字改空，内容与旧文不同所以先保存快照。
			editor.setText("");
			// 确认清空已执行。
			assert.strictEqual(editor.getText(), "");

			// Ctrl+-恢复刚保存的替换前状态。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求hello world，不只是恢复最后输入的一个词。
			assert.strictEqual(editor.getText(), "hello world");
		});

		// 提交清撤销例：输入hello后Enter同步回调并清文字，再Ctrl+-应仍空，防已提交内容被误undo回当前草稿。提交只把字符串交本地回调，无模型请求。
		it("clears undo stack on submit", () => {
			// 创建新Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// let submitted保存最近提交值，初始空。
			let submitted = "";
			// 注册接文字参数的提交回调，赋函数不等于现在提交。
			editor.onSubmit = (text) => {
				// 回调被调用时保存text，不发网络或文件写入。
				submitted = text;
			};

			// 输入h建立打字快照。
			editor.handleInput("h");
			// 接e。
			editor.handleInput("e");
			// 接第一个l。
			editor.handleInput("l");
			// 接第二个l。
			editor.handleInput("l");
			// 接o，组成hello。
			editor.handleInput("o");
			// CR匹配默认提交，先清状态/undo再调用onSubmit。
			editor.handleInput("\r"); // Enter - submit

			// 回调收到hello，防只清输入却漏通知。
			assert.strictEqual(submitted, "hello");
			// 当前Editor已空，提交结果与草稿状态分离。
			assert.strictEqual(editor.getText(), "");

			// Undo should do nothing - stack was cleared
			// 再Ctrl+-尝试撤销，当前栈已被提交清除。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 仍为空，不能恢复已提交hello。
			assert.strictEqual(editor.getText(), "");
		});

		// 历史浏览与撤销例：world删空后Up载hello，首次进入历史保存空草稿快照；undo先回空，再undo恢复删词前world。两层快照顺序不同，undo也实际退出历史浏览。
		it("exits history browsing mode on undo", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Add "hello" to history
			// 添加hello历史条目，不直接修改当前输入。
			editor.addToHistory("hello");
			// 确认加历史后当前文仍空。
			assert.strictEqual(editor.getText(), "");

			// Type "world"
			// 输入w开始普通草稿。
			editor.handleInput("w");
			// 接o。
			editor.handleInput("o");
			// 接r。
			editor.handleInput("r");
			// 接l。
			editor.handleInput("l");
			// 接d，完成world。
			editor.handleInput("d");
			// 确认当前草稿world，与历史hello不同。
			assert.strictEqual(editor.getText(), "world");

			// Ctrl+W - delete word
			// Ctrl+W先存world快照再删词，当前文空。
			editor.handleInput("\x17"); // Ctrl+W
			// 确认空草稿，供历史进入点使用。
			assert.strictEqual(editor.getText(), "");

			// Press Up - enter history browsing, shows "hello"
			// Up首次进入历史，保存当前空状态快照，再加载hello。
			editor.handleInput("\x1b[A"); // Up arrow
			// 要求当前历史文字hello。
			assert.strictEqual(editor.getText(), "hello");

			// Undo should restore to "" (state before entering history browsing)
			// 第一次Ctrl+-退出历史，弹出进入历史之前的空状态。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求空串，而不是仍hello或直接跳world。
			assert.strictEqual(editor.getText(), "");

			// Undo again should restore to "world" (state before Ctrl+W)
			// 第二次undo弹出Ctrl+W之前快照。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求world恢复，验证快照堆叠顺序。
			assert.strictEqual(editor.getText(), "world");
		});

		// 连续浏览历史只建一个撤销入口例：删current成空后Up经过third/second/first，undo应直接回进入浏览前空状态，再undo才恢复current，不能依次撤销每个历史项。
		it("undo restores to pre-history state even after multiple history navigations", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Add history entries
			// 添加最旧first历史。
			editor.addToHistory("first");
			// 添加中间second历史。
			editor.addToHistory("second");
			// 添加最新third历史，当前编辑文字仍空。
			editor.addToHistory("third");

			// Type something
			// 输入c，建立当前草稿的打字起点。
			editor.handleInput("c");
			// 继续u。
			editor.handleInput("u");
			// 继续第一个r。
			editor.handleInput("r");
			// 继续第二个r。
			editor.handleInput("r");
			// 继续e。
			editor.handleInput("e");
			// 继续n。
			editor.handleInput("n");
			// 继续t，形成current。
			editor.handleInput("t");
			// 确认当前草稿与三条历史都不同。
			assert.strictEqual(editor.getText(), "current");

			// Clear editor
			// Ctrl+W保存current快照后删空，删除环也记录该词，但后面用undo不走yank。
			editor.handleInput("\x17"); // Ctrl+W
			// 确认进入历史前当前文为空。
			assert.strictEqual(editor.getText(), "");

			// Navigate through history multiple times
			// 首次Up进入历史，保存这份空草稿快照并加载third。
			editor.handleInput("\x1b[A"); // Up - "third"
			// 确认最新历史third。
			assert.strictEqual(editor.getText(), "third");
			// 再Up加载second，内部历史切换不再逐次push快照。
			editor.handleInput("\x1b[A"); // Up - "second"
			// 确认second。
			assert.strictEqual(editor.getText(), "second");
			// 再Up加载最旧first。
			editor.handleInput("\x1b[A"); // Up - "first"
			// 确认first，确保确实经过多条记录。
			assert.strictEqual(editor.getText(), "first");

			// Undo should go back to "" (state before we started browsing), not intermediate states
			// 一次undo退出浏览并回进入前保存的空状态，不回second或third。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求空串，直接检验浏览链合并成一个入口快照。
			assert.strictEqual(editor.getText(), "");

			// Another undo goes back to "current"
			// 再undo弹出Ctrl+W前的current状态。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求current，证明浏览没有额外多占撤销层。
			assert.strictEqual(editor.getText(), "current");
		});

		// 移动打断打字撤销合并例：hello world后左移到world前再输入lol，应单独形成新单元；undo只去lol，并恢复其插入点。位置本身不建文字快照，而是让下一次打字重新建起点。
		it("cursor movement starts new undo unit", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 输入h。
			editor.handleInput("h");
			// 继续e。
			editor.handleInput("e");
			// 继续第一个l。
			editor.handleInput("l");
			// 继续第二个l。
			editor.handleInput("l");
			// 继续o。
			editor.handleInput("o");
			// 插空格，记录词间撤销边界。
			editor.handleInput(" ");
			// 输入w。
			editor.handleInput("w");
			// 接o。
			editor.handleInput("o");
			// 接r。
			editor.handleInput("r");
			// 接l。
			editor.handleInput("l");
			// 接d。
			editor.handleInput("d");
			// 确认原句hello world。
			assert.strictEqual(editor.getText(), "hello world");

			// Move cursor left 5 (to after "hello ")
			// 五次Left跨过world到列6，移动方法清lastAction，使下次打字不与刚才world共用快照。
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[D");

			// Type "lol" in the middle
			// 输入l时重新保存当前整句及列6光标快照。
			editor.handleInput("l");
			// 输入o，与新l共享撤销单元。
			editor.handleInput("o");
			// 输入最后l，形成中间插文lol。
			editor.handleInput("l");
			// 要求hello lolworld，原world完整保留在插文右侧。
			assert.strictEqual(editor.getText(), "hello lolworld");

			// Undo should restore to "hello world" (before inserting "lol")
			// Ctrl+-撤销新插入的lol这个单元。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求原hello world，不能把原world也一并删掉。
			assert.strictEqual(editor.getText(), "hello world");

			// 在恢复后的光标处插竖线。
			editor.handleInput("|");
			// 要求hello空格竖线world，证明undo光标恢复到新单元原起点。
			assert.strictEqual(editor.getText(), "hello |world");
		});

		// 无事可删不建快照例：hello被Ctrl+W删空后，再两次Ctrl+W都是起点空操作，一次undo仍应直接回hello，而不是弹出额外空状态。
		it("no-op delete operations do not push undo snapshots", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 输入h。
			editor.handleInput("h");
			// 继续e。
			editor.handleInput("e");
			// 继续第一个l。
			editor.handleInput("l");
			// 继续第二个l。
			editor.handleInput("l");
			// 继续o。
			editor.handleInput("o");
			// 确认hello已输入。
			assert.strictEqual(editor.getText(), "hello");

			// Delete word on empty - multiple times (should be no-ops)
			// 第一次Ctrl+W确实删hello并保存快照，不属于无操作样本。
			editor.handleInput("\x17"); // Ctrl+W - deletes "hello"
			// 确认已空，给后面两次无删除明确前提。
			assert.strictEqual(editor.getText(), "");
			// 第二次Ctrl+W在唯一空行列0，没有前行或词，不应新增撤销点。
			editor.handleInput("\x17"); // Ctrl+W - no-op (nothing to delete)
			// 第三次重复同一无事可删状态。
			editor.handleInput("\x17"); // Ctrl+W - no-op

			// Single undo should restore "hello"
			// 一次undo应仍弹出最初删hello之前状态。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求hello，若空操作错误存快照就会仍空而失败。
			assert.strictEqual(editor.getText(), "hello");
		});

		// 补全撤销例：mock只对前缀di给dist/，显式Tab强制模式唯一项直接应用，一次undo回di。文件夹名字仅候选文字，不读取磁盘dist目录。
		it("undoes autocomplete", async () => {
			// 创建新Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Create a mock autocomplete provider
			// 用AutocompleteProvider接口声明内存提供者对象，包含建议与应用方法。
			const mockProvider: AutocompleteProvider = {
				// 异步回调读取lines和光标列，忽略带下划线的_cursorLine；返回Promise不代表有网络或IO。
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					// 取首逻辑行，缺失/空时回退空串；此替身只面向单行样本。
					const text = lines[0] || "";
					// slice取光标之前前缀，避免把光标后的内容误作查询。
					const prefix = text.slice(0, cursorCol);
					// 仅精确di时提供候选，其余前缀都走后面null。
					if (prefix === "di") {
						// 构造这次建议对象，不直接把它写入Editor。
						return {
							// items只有一项dist/，value与label相同，尾斜杠只是目录样式约定。
							items: [{ value: "dist/", label: "dist/" }],
							// prefix明确di，用于替换两码元原文。
							prefix: "di",
						};
					}
					// 没有di时正常兑现null，不显示菜单，也不抛错。
					return null;
				},
				// 引用顶部标准applyCompletion，按prefix长度在当前行替换。
				applyCompletion,
			};

			// 安装mock并清此前补全状态。
			editor.setAutocompleteProvider(mockProvider);

			// Type "di"
			// 输入d，普通无符号词此时不自然触发文件补全。
			editor.handleInput("d");
			// 再输入i，当前为di。
			editor.handleInput("i");
			// 确认Tab前仍是用户原文。
			assert.strictEqual(editor.getText(), "di");

			// Press Tab to trigger autocomplete
			// Tab显式发force且explicitTab请求，唯一候选满足自动应用条件。
			editor.handleInput("\t");
			// 等待常见Promise/Immediate链推进，不代表任意IO或防抖定时器已完成。
			await flushAutocomplete();
			// 要求实际文字已被dist/替换。
			assert.strictEqual(editor.getText(), "dist/");
			// 菜单不显示，唯一force项直接应用而不是先打开列表等第二次Tab。
			assert.strictEqual(editor.isShowingAutocomplete(), false);

			// Undo should restore to "di"
			// Ctrl+-撤销应用前保存的快照。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求di恢复，不是回输入前空串。
			assert.strictEqual(editor.getText(), "di");
		});
	});

	// 异步补全组覆盖菜单导航、触发边界、防抖/取消、候选应用与真实Combined提供者的有限路径分支。大部分回调为内存替身；其中自建临时目录例才真正读文件系统。
	describe("Autocomplete", () => {
		// 回归#7629：12项菜单每页5项，两次PageDown再PageUp应回索引5，Enter应用斜杠候选并提交。capturesViewportInput随菜单打开变true；这里只直接调用Editor，不检整个TUI正文是否滚动。
		it("moves the autocomplete selection with selection page keys (#7629)", async () => {
			// 创建真实Editor，默认autocompleteMaxVisible为5。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 保存最近提交字符串，初始空。
			let submitted = "";
			// 注册提交回调，不在赋值时执行。
			editor.onSubmit = (text) => {
				// 提交时把text存入局部变量，无外部请求。
				submitted = text;
			};
			// 安装固定返回12项的内存提供者。
			editor.setAutocompleteProvider({
				// async箭头用括号包对象表达式，返回兑现建议，不是函数块里遗漏return。
				getSuggestions: async () => ({
					// Array.from按索引0..11为每项创建新对象。
					items: Array.from({ length: 12 }, (_, index) => ({
						// 候选value带斜杠，例如索引5是/command-5。
						value: `/command-${index}`,
						// label不带斜杠，显示名与实际插入值区分。
						label: `command-${index}`,
					})),
					// prefix为/，影响选择确认后的命令式提交路径。
					prefix: "/",
				}),
				// 采用顶部applyCompletion按前缀做纯文字替换。
				applyCompletion,
			});

			// 菜单未打开时capturesViewportInput应false，等待建议本身也不等于有菜单。
			assert.strictEqual(editor.capturesViewportInput, false);
			// 输入/触发首行开头的自然命令补全。
			editor.handleInput("/");
			// 等待异步建议应用和列表建立。
			await flushAutocomplete();
			// 菜单已开时getter应true，宿主可据此把分页键先交Editor。
			assert.strictEqual(editor.capturesViewportInput, true);

			// 第一次PageDown从索引0前进5项到5。
			editor.handleInput("\x1b[6~");
			// 第二次PageDown再前进5到10，未越过12项末尾。
			editor.handleInput("\x1b[6~");
			// PageUp后退5回索引5。
			editor.handleInput("\x1b[5~");
			// Enter应用当前/command-5，因前缀是/继续走默认提交分支。
			editor.handleInput("\r");

			// 要求提交值/command-5，索引5是第六候选；没有额外断言提交回调恰调用一次。
			assert.strictEqual(submitted, "/command-5");
		});

		// 符号防抖参数组合例：多种CJK标点/空白/开包装符之后输入@/#/$/-，19ms未查、再1ms查；继续re后又按20ms合并重查。所有输入组合在同一it内循环，用fake timer精确推进本地等待，不测试真实20ms响应时限。
		it("triggers and debounces symbol completion after CJK punctuation", async (t) => {
			// 通过测试上下文只mock setTimeout及配套clearTimeout；Node结束本测试会reset，setImmediate和Promise仍真实推进，不手动加速所有异步源。
			t.mock.timers.enable({ apis: ["setTimeout"] });
			// 外层样本数组列出触发符之前的文本，循环结束后再换下一个前文。
			for (const before of [
				// 中文正文接逗号，逗号提供token边界。
				"查看，",
				// Unicode转义U+3000是全角空格，不是六字符反斜杠u文本。
				"\u3000",
				// 字符串展开按Unicode码点逐项放进数组，每个列出的标点独立作before；不是把整串标点作为单一前文。
				..."，．：；！？（）［］｛｝“”‘’…—。、「」『』《》【】",
				// 单独左括号作为开包装符样本。
				"(",
				// 英文see空格后左括号，同时给前文边界和包装符。
				"see (",
				// 单独反引号作为包装样本，不执行shell命令。
				"`",
				// 左方括号作为另一开包装符。
				"[",
			]) {
				// 内层遍历四个触发符，默认@/#加提供者声明$/-，形成前文×触发符的组合。
				for (const trigger of ["@", "#", "$", "-"]) {
					// 每个组合创建独立Editor，避免复用旧菜单或请求计数。
					const editor = new Editor(createTestTUI(), defaultEditorTheme);
					// requests记录实际建议回调看到的完整光标前文本。
					const requests: string[] = [];
					// 安装只记请求、始终无建议的提供者，不显示候选菜单。
					editor.setAutocompleteProvider({
						// 显式追加$/-两个触发符，Editor还保留默认@/#；字段不直接改全局键位。
						triggerCharacters: ["$", "-"],
						// 异步回调接当前行数组、行号及码元列，执行时才读取快照上下文。
						getSuggestions: async (lines, cursorLine, cursorCol) => {
							// 取当前行光标之前原文push进数组，!只让TS忽略缺行，不运行校验。
							requests.push(lines[cursorLine]!.slice(0, cursorCol));
							// 兑现null让此次查询正常结束，不留菜单。
							return null;
						},
						// 应用方法仍给标准纯替换函数，因从不返回候选，本场景不会实际用它。
						applyCompletion,
					});
					// setText放入当前before并将光标放末尾，不自然触发查询。
					editor.setText(before);
					// 输入当前触发符，合法边界下注册20ms防抖计时器。
					editor.handleInput(trigger);
					// 虚拟时钟推进19ms，尚未达到20ms门槛。
					t.mock.timers.tick(19);
					// 再让Promise和Immediate链推进，防止只因微任务未运行而误判没有查询。
					await flushAutocomplete();
					// 请求数组应空，验证门槛前未调用提供者。
					assert.deepStrictEqual(requests, []);
					// 再tick1ms，累计到本次20ms期限，定时回调可启动排队请求。
					t.mock.timers.tick(1);
					// 等待异步串行入口与建议回调兑现。
					await flushAutocomplete();
					// 精确要求一项before加触发符，证明查询收到插入后的上下文。
					assert.deepStrictEqual(requests, [before + trigger]);

					// 接着输入r，会重设自然上下文的防抖。
					editor.handleInput("r");
					// 紧接输入e，取消前一个等待，改查最终re上下文。
					editor.handleInput("e");
					// 推进19ms，还不应发第二轮查询。
					t.mock.timers.tick(19);
					// 让可执行微任务有机会完成。
					await flushAutocomplete();
					// 请求条数仍1，排除r/e各自立即查一次。
					assert.strictEqual(requests.length, 1);
					// 再推进1ms，达到新输入后的20ms期限。
					t.mock.timers.tick(1);
					// 等待实际回调写入记录。
					await flushAutocomplete();
					// 要求两项依次为初始触发上下文和加re上下文；没有中间仅r请求。
					assert.deepStrictEqual(requests, [before + trigger, `${before}${trigger}re`]);
				}
			}
		});

		// 不自然触发参数例：邮箱、CJK字母紧邻@、正文#、未带符号的路径均不应查询。只断言计数始终0，不访问这些文字代表的文件、邮箱或远端地址。
		it("does not auto-trigger after CJK letters or for unprefixed paths", async (t) => {
			// 只mock setTimeout/clearTimeout，测试结束由上下文恢复，不mock setImmediate。
			t.mock.timers.enable({ apis: ["setTimeout"] });
			// 同一Editor反复清空并输入各样本，计数也连续保留以发现任一误触发。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// let requests为数字调用总数，而不是前例的字符串数组。
			let requests = 0;
			// 注册内存计数提供者。
			editor.setAutocompleteProvider({
				// 建议函数忽略参数，实际执行才计数。
				getSuggestions: async () => {
					// 后置++把requests增加1，表达式旧值未被使用。
					requests++;
					// 兑现null，若误调用也不会访问文件系统。
					return null;
				},
				// 给标准应用方法满足接口，本场景不应出现候选供应用。
				applyCompletion,
			});
			// for..of样本覆盖不同文字/标点组合；每轮下面setText清当前文，但不把总requests归0。
			for (const text of [
				// ASCII邮箱样本，@在普通字母后，不作为新token触发符。
				"user@example.com",
				// 中文姓名邮箱样本，规则也不能只保护ASCII邮箱。
				"张三@example.com",
				// 汉字正文直接接@src，没有空白/标点边界。
				"查看@src",
				// 平假名后接@。
				"あ@src",
				// 片假名后接@。
				"カ@src",
				// 韩文音节后接@。
				"한@src",
				// 注音字母后接@。
				"ㄅ@src",
				// 补充平面汉字后接@，该汉字占两个UTF-16码元。
				"𠮷@src",
				// 平假名加组合浊点后接@，测试组合文字边界。
				"か\u3099@src",
				// 汉字加补充平面变体选择符后接@，转义表示真实Unicode字符。
				"禰\u{e0100}@src",
				// 汉字迭代符后接@，不能误当通用标点触发。
				"々@src",
				// 全角拉丁字母后接@，外形像ASCII仍是另一Unicode字符。
				"Ａ@src",
				// 中文目录样本文字中@夹在两组汉字间。
				"文档@备份",
				// 普通英文词直接接#数字，不符合独立符号token起点。
				"prefix#123",
				// foo后直接左括号再@，没有前置合法正文边界；不是所有看到开括号都能触发。
				"foo(@src",
				// 中文正文直接接#数字。
				"问题#123",
				// 中文逗号后绝对路径外形，只输入不Tab，不能自然触发文件查询。
				"查看，/path/",
				// 中文逗号后点斜杠中文路径，同样无自然符号触发。
				"查看，./文档/",
				// 普通src/index.ts仅为输入样本，不查当前项目src。
				"src/index.ts",
				// 点斜杠开头中文路径也不因路径形状自动触发。
				"./文档/说明.md",
				// 不带点斜杠的中文相对路径。
				"文档/说明.md",
				// 中文正文直接连ASCII路径，缺少独立符号触发。
				"查看src/index.ts",
			]) {
				// 每轮清编辑文字并取消旧补全状态，仍保留累积调用计数。
				editor.setText("");
				// for..of按Unicode码点逐段输入，不按UTF-16代理单元拆补充平面字符；组合标记仍可能分成独立码点输入。
				for (const char of text) editor.handleInput(char);
				// 虚拟时钟推进20ms，给任何误排防抖任务执行机会。
				t.mock.timers.tick(20);
				// 等待Promise/Immediate补全链。
				await flushAutocomplete();
				// 总调用数必须仍0；第三参数text是失败文案，指出哪个输入样本触发了异常。
				assert.strictEqual(requests, 0, text);
			}
		});

		// 中文标点后路径仅Tab查询例：输入查看逗号/path/后即便20ms过去也不查，Tab才调用并传force:true。用mock记参数，不真的枚举系统根目录/path。
		it("requests path completion after CJK punctuation only on Tab", async (t) => {
			// 启用本测试上下文的setTimeout模拟，结束后Node负责reset。
			t.mock.timers.enable({ apis: ["setTimeout"] });
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 数组元素类型含text和force；force联合boolean/undefined，表示提供者选项可能没有该属性，不是在运行时补默认false。
			const requests: Array<{ text: string; force: boolean | undefined }> = [];
			// 注册记录请求参数的内存提供者。
			editor.setAutocompleteProvider({
				// 异步函数显式接options，可检查Editor送来的force，不自己猜当前是否Tab触发。
				getSuggestions: async (lines, cursorLine, cursorCol, options) => {
					// 把当前光标前文与options.force保存为普通对象，供后面深比较。
					requests.push({ text: lines[cursorLine]!.slice(0, cursorCol), force: options.force });
					// 兑现null，不产生菜单，也不访问/path目录。
					return null;
				},
				// 提供标准纯应用函数，当前无建议所以不会应用。
				applyCompletion,
			});
			// 固定带中文逗号的路径外形文本，只作查询上下文。
			const text = "查看，/path/";
			// 逐码点输入整段，模拟自然打字而非直接setText。
			for (const char of text) editor.handleInput(char);
			// 推进20ms，允许可能的自然防抖任务运行。
			t.mock.timers.tick(20);
			// 等待常见异步链。
			await flushAutocomplete();
			// 请求数组仍空，说明自然输入路径没有调用提供者。
			assert.deepStrictEqual(requests, []);
			// Tab显式进入文件补全模式，force=true、explicitTab=true。
			editor.handleInput("\t");
			// 等建议回调执行，不需要另外tick20ms，因为显式请求跳过自然防抖。
			await flushAutocomplete();
			// 要求唯一请求精确为当前text及force:true，验证模式参数而不仅是调用次数。
			assert.deepStrictEqual(requests, [{ text, force: true }]);
		});

		// 真实路径补全例：在自建临时树文档/说明.md上，六种空白或中文标点后按Tab先补目录、再补文件并核光标。这个用例真实写盘/列目录，范围限定自己生成的baseDir，不读用户根目录或运行fd。
		it("completes Chinese path prefixes after whitespace or CJK punctuation with Tab", async (t) => {
			// join把平台tmpdir与测试前缀连接，mkdtempSync实际创建唯一临时目录并返回其路径；失败会直接抛错。
			const baseDir = mkdtempSync(join(tmpdir(), "pi-editor-autocomplete-"));
			// 立即注册t.after清理钩子，测试结束时递归删这个baseDir，force容忍已不存在；注册回调此刻不删除，清理失败仍可能报告错误。
			t.after(() => rmSync(baseDir, { recursive: true, force: true }));
			// 同步在自己临时根下创建中文名子目录文档，不开启recursive，因为父目录已由mkdtemp建立。
			mkdirSync(join(baseDir, "文档"));
			// 同步写说明.md内容text，测试补全只需目录项，不读取该正文来生成候选。
			writeFileSync(join(baseDir, "文档", "说明.md"), "text");
			// 创建真实Editor，终端宿主仍为内存适配器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 安装真实Combined提供者，命令数组空、基目录为临时树，第三fdPath省略为null；普通路径补全仍会readdir/stat，不启动fd。
			editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], baseDir));
			// 循环六个分隔符：普通空格、Tab、全角空格、不换行空格、中文逗号和句号；每轮走相同两步目录/文件补全。
			for (const separator of [" ", "\t", "\u3000", "\u00a0", "，", "。"]) {
				// 设置查看加分隔符，setText会把Tab规范为四空格，不能把之后预期始终写成原始separator。
				editor.setText(`查看${separator}`);
				// 从Editor读取规范后的before，供预期保留真实前文；const保存本轮快照。
				const before = editor.getText();
				// 输入文作为目录名前缀，不直接插完整文档。
				editor.handleInput("文");
				// Tab显式强制路径查询，实际扫描临时根下目录项。
				editor.handleInput("\t");
				// 等待同步列目录外层的async请求链及结果应用。
				await flushAutocomplete();
				// 唯一目录候选应自动应用成文档/，保留之前规范后的中文前文和分隔符。
				assert.strictEqual(editor.getText(), `${before}文档/`);
				// 在目录斜杠后输入说，作为文件名前缀。
				editor.handleInput("说");
				// 再Tab显式扫描临时文档目录，不是递归扫描用户整个工程。
				editor.handleInput("\t");
				// 等待候选查询和应用。
				await flushAutocomplete();
				// 要求完整相对路径文档/说明.md接在before之后。
				assert.strictEqual(editor.getText(), `${before}文档/说明.md`);
				// 光标应在逻辑行0的全文码元末尾；此处汉字各一码元但显示占两格，不能把length当显示列。
				assert.deepStrictEqual(editor.getCursor(), { line: 0, col: editor.getText().length });
			}
		});

		// 未引用符号上下文结束例：@/#/$后src打开菜单，再输入空白或中文标点应重查一次得到null关菜单；后续文不应继续旧符号防抖上下文。检查精确请求序列，全部由内存提供者完成。
		it("ends unquoted trigger and debounce contexts at whitespace or CJK punctuation", async (t) => {
			// mock setTimeout及配套clearTimeout，后面tick只推进这些模拟timer；测试上下文结束自动reset。
			t.mock.timers.enable({ apis: ["setTimeout"] });
			// 外层遍历四种token终止分隔符，普通/全角空格和中文逗号/句号。
			for (const separator of [" ", "\u3000", "，", "。"]) {
				// 内层遍历三个触发符，@/#为默认，$由本轮提供者追加。
				for (const trigger of ["@", "#", "$"]) {
					// 每个组合新建Editor，隔离菜单和排队请求。
					const editor = new Editor(createTestTUI(), defaultEditorTheme);
					// 记录每次实际查询看到的光标前文本。
					const requests: string[] = [];
					// 模板生成本轮有效前缀，例如@src或$src。
					const prefix = `${trigger}src`;
					// 安装内存提供者，根据完整prefix精确判断是否给候选。
					editor.setAutocompleteProvider({
						// 只额外声明$触发字符，不把@/#从默认集合中移除。
						triggerCharacters: ["$"],
						// async建议回调接当前逻辑行与码元光标，调用时才执行下列记录。
						getSuggestions: async (lines, cursorLine, cursorCol) => {
							// 取当前行光标前文，!声明正常状态存在这一行。
							const text = lines[cursorLine]!.slice(0, cursorCol);
							// 把本次原文追加请求数组，保留调用顺序。
							requests.push(text);
							// 三元仅在text精确等prefix时返回一条目录样式候选，其余兑现null；候选label尾/表示目录，但这里不访问src目录。
							return text === prefix ? { prefix, items: [{ value: `${prefix}/`, label: "src/" }] } : null;
						},
						// 引用标准applyCompletion，供候选确认时纯文本替换。
						applyCompletion,
					});
					// 直接设触发符加sr，setText自身不启动自然补全。
					editor.setText(`${trigger}sr`);
					// 输入c补成合法符号上下文prefix，触发自然20ms防抖。
					editor.handleInput("c");
					// 推进模拟时钟20ms，使请求具备启动条件。
					t.mock.timers.tick(20);
					// 等待异步串行入口和返回建议处理。
					await flushAutocomplete();
					// 明确要求菜单已开，保证后面分隔符是更新已有菜单而非未触发状态。
					assert.strictEqual(editor.isShowingAutocomplete(), true);
					// 输入本轮分隔符，旧菜单模式下会重查最新文本。
					editor.handleInput(separator);
					// 等待即时重查链，终止符后的上下文不再需要原来的20ms符号防抖。
					await flushAutocomplete();
					// 精确请求应为prefix、prefix加分隔符两次，证明关闭菜单前确实查询过最新输入。
					assert.deepStrictEqual(requests, [prefix, prefix + separator]);
					// 后一请求返回null，菜单应关闭。
					assert.strictEqual(editor.isShowingAutocomplete(), false);
					// 再输入汉字文，已经在新token中，不应延续前面的未引用符号上下文。
					editor.handleInput("文");
					// 推进20ms，让任何误排防抖任务都有机会启动。
					t.mock.timers.tick(20);
					// 等待Promise/Immediate链。
					await flushAutocomplete();
					// 请求数组仍只有原两项，没有因后续文再查旧prefix。
					assert.deepStrictEqual(requests, [prefix, prefix + separator]);
				}
			}
		});

		// 接受目录与删除后重触发例：三种中文目录含普通、空格及逗号，建议由mock固定返回，只有applyCompletion委托真实Combined规则。测试引用光标位置、错字导致菜单关闭及Backspace/Delete恢复建议；不列process.cwd目录。
		it("re-triggers CJK path completion after accepting directories and deleting", async (t) => {
			// 只mock setTimeout及配套清理，供自然符号请求20ms推进。
			t.mock.timers.enable({ apis: ["setTimeout"] });
			// 构造真实Combined仅保存cwd路径、空命令与缺省null fd；本例不调用它的getSuggestions，只用纯应用方法。
			const provider = new CombinedAutocompleteProvider([], process.cwd());
			// 遍历三种目录样本文字，不在本机创建这些目录。
			for (const directory of ["文档", "我的 文档", "资料，归档"]) {
				// 除文档外都使用双引号引用，布尔quoted由样本名比较得到，不读取文件属性。
				const quoted = directory !== "文档";
				// 引用样本初始为@加开引号再取目录前两码元；普通文档样本用@文。三者都是BMP文字，此slice不会拆代理对。
				const initial = quoted ? `@"${directory.slice(0, 2)}` : "@文";
				// 目录候选引用版带闭引号，普通版末尾/；实际apply会把引用目录的光标放闭引号前便于续补。
				const directoryValue = quoted ? `@"${directory}/"` : `@${directory}/`;
				// 完整文件候选由目录/说明.md构成，引用版包双引号，@前缀一并属于候选value。
				const fileValue = quoted ? `@"${directory}/说明.md"` : `@${directory}/说明.md`;
				// 文件查询前缀到说为止，不包含闭引号；光标后的原闭引号由应用逻辑避免重复。
				const filePrefix = quoted ? `@"${directory}/说` : `@${directory}/说`;
				// 每个目录样本创建独立Editor。
				const editor = new Editor(createTestTUI(), defaultEditorTheme);
				// 安装mock查询与真实应用相结合的提供者对象。
				editor.setAutocompleteProvider({
					// async查询函数只检查当前文字，完全不读文件系统。
					getSuggestions: async (lines, cursorLine, cursorCol) => {
						// 截取当前行光标之前的原文，不含光标后可能已有的闭引号。
						const before = lines[cursorLine]!.slice(0, cursorCol);
						// 从第一个@起提取本轮前缀；这些固定样本保证存在@，不把它称为通用安全邮箱解析。
						const prefix = before.slice(before.indexOf("@"));
						// 若前缀等initial，表示还在补目录。
						if (prefix === initial) {
							// 返回单目录候选，label尾/供真实应用函数识别目录，value使用前面构造的引用或普通写法。
							return { prefix, items: [{ value: directoryValue, label: `${directory}/` }] };
						}
						// 其余只在精确filePrefix时返回说明.md候选，输入错字等情况返回null使菜单关闭。
						return prefix === filePrefix ? { prefix, items: [{ value: fileValue, label: "说明.md" }] } : null;
					},
					// 剩余参数...args收集接口调用参数，再展开传给provider.applyCompletion；保持方法调用this为provider，不执行它的目录查询。
					applyCompletion: (...args) => provider.applyCompletion(...args),
				});
				// 在查看中文冒号后设置初始@前缀，构成合法符号边界。
				editor.setText(`查看：${initial}`);
				// Tab显式请求，唯一目录项可自动应用。
				editor.handleInput("\t");
				// 等待建议返回及应用。
				await flushAutocomplete();
				// 要求前文查看冒号后接完整目录值；引用目录闭引号虽然在文本中，光标会停它之前。
				assert.strictEqual(editor.getText(), `查看：${directoryValue}`);
				// 唯一显式项应用后不应留下菜单。
				assert.strictEqual(editor.isShowingAutocomplete(), false);

				// 在目录内部光标处输入说，引用版应插在闭引号前。
				editor.handleInput("说");
				// 推进20ms自然符号防抖。
				t.mock.timers.tick(20);
				// 等待mock文件候选返回。
				await flushAutocomplete();
				// 要求文件补全菜单真正打开，不能只检查请求曾登记。
				assert.strictEqual(editor.isShowingAutocomplete(), true);

				// 依次测试Backspace与Delete两个删除编码，每轮先加错字再恢复正确查询。
				for (const deletion of ["\x7f", "\x1b[3~"]) {
					// 在说后插错，使查询不再等filePrefix。
					editor.handleInput("错");
					// 推进20ms防抖，让无候选结果可处理。
					t.mock.timers.tick(20);
					// 等待异步查询结束。
					await flushAutocomplete();
					// 菜单应因错字前缀返回null关闭。
					assert.strictEqual(editor.isShowingAutocomplete(), false);
					// 如果本轮用前向Delete，先Left让光标位于错字之前；Backspace则保留在错字之后。
					if (deletion === "\x1b[3~") editor.handleInput("\x1b[D");
					// 发送当前删除编码，分别从后或前删除同一个错字。
					editor.handleInput(deletion);
					// 推进20ms，使正确前缀重触发补全。
					t.mock.timers.tick(20);
					// 等待建议重新应用。
					await flushAutocomplete();
					// 要求菜单重新打开，说明删除后仍能识别中文目录中的符号上下文。
					assert.strictEqual(editor.isShowingAutocomplete(), true);
				}

				// 已有菜单时Tab同步应用当前文件候选，不再等待另一轮查询。
				editor.handleInput("\t");
				// 文件附件补全应在fileValue之后加一个空格，引用版避免重复闭引号，前文保持。
				assert.strictEqual(editor.getText(), `查看：${fileValue} `);
				// 最终光标在完整存储串末尾，列按UTF-16 length，包含@/引号/新增空格。
				assert.deepStrictEqual(editor.getCursor(), { line: 0, col: editor.getText().length });
			}
		});

		// 唯一force候选直接应用例：Work按Tab得到Workspace/、无菜单，再undo回Work。提供者只在options.force且前缀精确时给候选，不存在真实Workspace目录读取。
		it("auto-applies single force-file suggestion without showing menu", async () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 声明实现接口的内存提供者。
			const mockProvider: AutocompleteProvider = {
				// 建议函数读取首行、码元光标和模式位，忽略_cursorLine。
				getSuggestions: async (lines, _cursorLine, cursorCol, options) => {
					// 不是force时直接拒绝这份建议，不把所有自然文字都当文件查询。
					if (!options.force) {
						// 正常兑现null，未抛异常。
						return null;
					}
					// 读取首逻辑行，缺失按空串。
					const text = lines[0] || "";
					// 只取光标之前的查询前缀。
					const prefix = text.slice(0, cursorCol);
					// 精确Work才返回单候选，大小写必须一致。
					if (prefix === "Work") {
						// 创建建议对象供Editor后续处理。
						return {
							// 唯一项Workspace/的value与label相同，只是目录样式文字。
							items: [{ value: "Workspace/", label: "Workspace/" }],
							// 替换前缀明确为Work。
							prefix: "Work",
						};
					}
					// 其他前缀返回null，无额外文件枚举回退。
					return null;
				},
				// 使用标准纯替换应用函数。
				applyCompletion,
			};

			// 将mock安装到当前Editor。
			editor.setAutocompleteProvider(mockProvider);

			// Type "Work"
			// 输入W。
			editor.handleInput("W");
			// 接o。
			editor.handleInput("o");
			// 接r。
			editor.handleInput("r");
			// 接k，形成用户前缀Work。
			editor.handleInput("k");
			// Tab之前文字应仍Work，不能提前变成候选。
			assert.strictEqual(editor.getText(), "Work");

			// Press Tab - should auto-apply without showing menu
			// 显式Tab走force与explicitTab，唯一结果可直接应用。
			editor.handleInput("\t");
			// 等待异步请求链推进。
			await flushAutocomplete();
			// 要求文字自动变Workspace/。
			assert.strictEqual(editor.getText(), "Workspace/");
			// 要求菜单关闭，区别先显示列表再等用户确认。
			assert.strictEqual(editor.isShowingAutocomplete(), false);

			// Undo should restore to "Work"
			// Ctrl+-恢复应用前快照。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求原Work，说明唯一项自动应用也可整体撤销。
			assert.strictEqual(editor.getText(), "Work");
		});

		// 多个force候选例：src按Tab返回src/与src.txt应开菜单、保留原文，再Tab才确认首项。与唯一项自动应用形成对照，不读真实src目录。
		it("shows menu when force-file has multiple suggestions", async () => {
			// 新建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 用接口类型声明内存候选提供者。
			const mockProvider: AutocompleteProvider = {
				// async查询接文字/光标和options模式。
				getSuggestions: async (lines, _cursorLine, cursorCol, options) => {
					// 只在force时允许提供下列文件样式候选。
					if (!options.force) {
						// 非force返回null。
						return null;
					}
					// 取首行原文。
					const text = lines[0] || "";
					// 截光标前查询。
					const prefix = text.slice(0, cursorCol);
					// 仅精确src上下文给多项。
					if (prefix === "src") {
						// 创建这次建议对象。
						return {
							// items是按该数组顺序显示的两条候选。
							items: [
								// 第一项src/，后面第二次Tab应默认确认它。
								{ value: "src/", label: "src/" },
								// 第二项src.txt，让候选数大于1，不能走唯一项自动应用。
								{ value: "src.txt", label: "src.txt" },
							],
							// 原替换前缀src。
							prefix: "src",
						};
					}
					// 其他输入返回null。
					return null;
				},
				// 候选应用用标准prefix替换函数。
				applyCompletion,
			};

			// 安装提供者。
			editor.setAutocompleteProvider(mockProvider);

			// Type "src"
			// 输入s。
			editor.handleInput("s");
			// 接r。
			editor.handleInput("r");
			// 接c。
			editor.handleInput("c");
			// 确认完整src前缀。
			assert.strictEqual(editor.getText(), "src");

			// Press Tab - should show menu because there are multiple suggestions
			// 第一次Tab发force查询，不直接选中候选。
			editor.handleInput("\t");
			// 等待结果与列表建立。
			await flushAutocomplete();
			// 原文仍src，多个结果尚未应用。
			assert.strictEqual(editor.getText(), "src");
			// 菜单应显示true，不能只是静默放弃多项结果。
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// Press Tab again to accept first suggestion
			// 第二次Tab在已开菜单路径同步确认当前高亮项。
			editor.handleInput("\t");
			// 默认首项src/应用到正文。
			assert.strictEqual(editor.getText(), "src/");
			// 确认后菜单关闭。
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		// force菜单持续过滤例：空输入Tab列全部固定样本，之后r、e仍沿force模式重查并保留菜单，即使只剩readme.md也不自动应用，最后Tab确认。这些文件名全是内存数组，不枚举cwd。
		it("keeps suggestions open when typing in force mode (Tab-triggered)", async () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 固定候选表由四个对象组成，const禁止重绑数组但没有冻结对象。
			const allFiles = [
				// 文件候选readme.md，后面r/re应仅匹配它。
				{ value: "readme.md", label: "readme.md" },
				// 另一个文件package.json作为初始多项结果。
				{ value: "package.json", label: "package.json" },
				// 目录样式候选src/。
				{ value: "src/", label: "src/" },
				// 目录样式候选dist/。
				{ value: "dist/", label: "dist/" },
			];

			// 内存提供者根据前缀和force标记筛该固定表，不读文件系统。
			const mockProvider: AutocompleteProvider = {
				// async查询接最新文字、码元列和模式options。
				getSuggestions: async (lines, _cursorLine, cursorCol, options) => {
					// 读取首行，空输入以空串参与匹配。
					const text = lines[0] || "";
					// 取光标前前缀。
					const prefix = text.slice(0, cursorCol);
					// force为真、前缀含斜杠或以点开头任一成立就允许匹配；这是本mock的规则，不代表真实Combined所有判据。
					const shouldMatch = options.force || prefix.includes("/") || prefix.startsWith(".");
					// 没有这些模式条件则不提供候选。
					if (!shouldMatch) {
						// 返回null，不打开菜单。
						return null;
					}
					// 按value两边转小写后startsWith筛选，保留原数组顺序，返回新数组且不修改allFiles。
					const filtered = allFiles.filter((f) => f.value.toLowerCase().startsWith(prefix.toLowerCase()));
					// 有至少一项才返回建议。
					if (filtered.length > 0) {
						// items取筛后数组、prefix为属性简写；即使一项，是否自动应用仍由Editor的explicitTab决定。
						return { items: filtered, prefix };
					}
					// 零项返回null，Editor会关闭当前菜单。
					return null;
				},
				// 标准应用函数只负责替换前缀，不自行补空格。
				applyCompletion,
			};

			// 安装此提供者。
			editor.setAutocompleteProvider(mockProvider);

			// Press Tab on empty prompt - should show all files (force mode)
			// 空文本Tab强制请求，空前缀startsWith会匹配四项。
			editor.handleInput("\t");
			// 等待返回与菜单建立。
			await flushAutocomplete();
			// 要求菜单打开，证明不是对空前缀完全不处理。
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// Type "r" - should narrow to "readme.md" (force mode keeps suggestions open)
			// 在force菜单里输入r，触发保留force但explicitTab=false的更新。
			editor.handleInput("r");
			// 等新查询把候选缩为readme.md。
			await flushAutocomplete();
			// 正文仍用户输入r，唯一项更新不应自动把它替换成readme.md。
			assert.strictEqual(editor.getText(), "r");
			// 菜单仍开，保持待用户确认。
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// Type "e" - should still show "readme.md"
			// 再输入e，查询前缀变re。
			editor.handleInput("e");
			// 等本轮重查。
			await flushAutocomplete();
			// 正文仍re，继续不自动应用。
			assert.strictEqual(editor.getText(), "re");
			// 菜单仍开，force状态没有因普通字母输入丢失。
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// Accept with Tab
			// 最后Tab在菜单模式下同步确认选中项。
			editor.handleInput("\t");
			// 要求正文readme.md，标准应用函数不另加尾空格。
			assert.strictEqual(editor.getText(), "readme.md");
			// 确认后菜单关闭，输入链回普通编辑状态。
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		// 真实timer的@防抖例：同步输入@mai后调用数0、菜单关，等约50ms后应合并为1次并开菜单。与fake timer样本不同，实际调度可延后；不测网络或精确20ms实时延迟。
		it("debounces @ autocomplete while typing", async () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// let调用计数初始0。
			let suggestionCalls = 0;

			// 声明内存提供者，文件名仅固定候选文字。
			const mockProvider: AutocompleteProvider = {
				// async函数读取首行和光标列，忽略_cursorLine。
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					// 每次实际查询将计数加1。
					suggestionCalls += 1;
					// 只截取当前光标前文，空首行回退空串。
					const text = (lines[0] || "").slice(0, cursorCol);
					// 返回建议对象，不直接替换用户文本。
					return {
						// 固定候选value含@、label不含@，不打开main.ts文件。
						items: [{ value: "@main.ts", label: "main.ts" }],
						// prefix取本次实际text，供确认时替换完整输入前缀。
						prefix: text,
					};
				},
				// 应用用顶部纯替换函数，当前本例只检查菜单，未按确认。
				applyCompletion,
			};

			// 安装提供者。
			editor.setAutocompleteProvider(mockProvider);

			// 输入@启动合法符号上下文的防抖。
			editor.handleInput("@");
			// 同步接m，取消旧等待并重排。
			editor.handleInput("m");
			// 接a，再次更新待查上下文。
			editor.handleInput("a");
			// 接i，最终本轮输入@mai，期间没有await。
			editor.handleInput("i");

			// 此刻建议函数应尚未执行，计数仍0。
			assert.strictEqual(suggestionCalls, 0);
			// 等待防抖不算菜单已显示，所以应false。
			assert.strictEqual(editor.isShowingAutocomplete(), false);

			// 用真实Node timeout请求等50ms，足以越过通常20ms防抖，但系统繁忙可能更晚恢复，不保证准点。
			await new Promise((resolve) => setTimeout(resolve, 50));
			// 再等待Promise/Immediate链处理返回建议。
			await flushAutocomplete();

			// 要求只查1次，证明同步连打合并而非每键查询。
			assert.strictEqual(suggestionCalls, 1);
			// 要求菜单真正打开，不能只计数却丢掉有效建议。
			assert.strictEqual(editor.isShowingAutocomplete(), true);
		});

		// 回归#5496：/cmd空格的参数菜单出现后Left回命令名，旧repo/message不能继续显示。断言允许替换成命令建议或关闭菜单，不强制某个具体最终菜单样式。
		it("re-queries the autocomplete picker when the cursor moves back into the command name", async () => {
			// Regression for earendil-works/pi#5496: arrowing left out of a slash
			// command's argument region must re-query the picker, not leave the
			// stale argument list showing. Before the fix, moveCursor() never
			// called updateAutocomplete(), so `/cmd ` (argument menu) + Left kept
			// displaying the arguments against a `/cmd` prefix — and a Tab there
			// would concatenate the stale suggestion onto the partial command name.
			// 创建新Editor处理实际光标移动与重查。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 内存提供者按光标前是否含ASCII空格区分命令名/参数，不执行真实cmd命令。
			const mockProvider: AutocompleteProvider = {
				// 异步回调读取最新首行与码元光标，忽略_cursorLine。
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					// 只看光标前的before，光标后的原空格不属于参数上下文判据。
					const before = (lines[0] || "").slice(0, cursorCol);
					// 不是从/起就无建议，避免普通文字误显示这些命令样本。
					if (!before.startsWith("/")) return null;
					// Past the command name (a space before the cursor): offer arguments.
					// 光标前已有空格时按参数上下文返回下面三项。
					if (before.includes(" ")) {
						// 构造参数建议对象。
						return {
							// items是三个固定内存候选，不根据文件系统生成。
							items: [
								// repo候选，后面首先检查它曾显示。
								{ value: "repo", label: "repo" },
								// message候选，后面也要求它在移动后消失。
								{ value: "message", label: "message" },
								// help候选，提供多项列表背景；最终断言没有单独检查help。
								{ value: "help", label: "help" },
							],
							// 参数prefix取第一个空格之后全部前文；/cmd空格时为空串，而不是整个/cmd。
							prefix: before.slice(before.indexOf(" ") + 1),
						};
					}
					// Inside the command name: offer the command name only.
					// 还在命令名时返回cmd单项，prefix保留/cmd等原文；value不带/，此例不实际确认它，所以不把这个mock称通用命令应用实现。
					return { items: [{ value: "cmd", label: "cmd" }], prefix: before };
				},
				// 应用仍引用标准prefix替换函数，本回归主要观察列表不应用候选。
				applyCompletion,
			};

			// 安装提供者。
			editor.setAutocompleteProvider(mockProvider);

			// Type `/cmd ` so the picker ends up showing the argument list.
			// 逐字符输入/cmd加末空格，每一步后都await，因此菜单/请求会经历中间状态，不是一次同步整串输入。
			for (const ch of "/cmd ") {
				// 将本轮ch直接交Editor处理。
				editor.handleInput(ch);
				// 让该字符引发的异步补全推进后再输入下一个，避免只观察最后合并状态。
				await flushAutocomplete();
			}
			// 要求当前文本/cmd加一个尾空格，给参数上下文明确前提。
			assert.strictEqual(editor.getText(), "/cmd ");
			// 参数菜单应已经打开。
			assert.strictEqual(editor.isShowingAutocomplete(), true);
			// 开始把当前Editor渲染结果变成纯文字快照，链式调用按下行顺序执行。
			const atArg = editor
				// 按80列render，返回编辑区和当前菜单的字符串行，不写真实终端。
				.render(80)
				// map逐行剥控制码，便于用可见候选名称检查。
				.map((l) => stripVTControlCharacters(l))
				// 用LF连接行数组作一次查询文本，未修改Editor逻辑行。
				.join("\n");
			// 快照应含repo，证明确实先出现了待清理的参数候选。
			assert.ok(atArg.includes("repo"), "argument menu should be visible at `/cmd `");

			// Arrow Left back into the command name (`/cmd`).
			// 一次Left把光标从末空格后移到它前面，当前光标前变/cmd，整行原文本仍含尾空格。
			editor.handleInput("\x1b[D");
			// 等待光标移动触发的菜单更新/重查。
			await flushAutocomplete();

			// The picker must have re-queried: the stale argument items are gone
			// (replaced by the command-name suggestion, or the picker closed).
			// 重新取移动之后的快照，不复用旧atArg。
			const afterMove = editor
				// 再按80列实际渲染。
				.render(80)
				// 逐行剥控制码。
				.map((l) => stripVTControlCharacters(l))
				// 连接成纯文字串供检查。
				.join("\n");
			// 旧repo不能残留，防旧参数列表继续对着命令名显示。
			assert.ok(!afterMove.includes("repo"), "stale argument menu must not survive the cursor move");
			// 旧message也不能残留；没有要求整个菜单必须关闭或最终cmd项必须存在。
			assert.ok(!afterMove.includes("message"), "stale argument menu must not survive the cursor move");
		});

		// #防抖对照例：同步输入#298，立即不查，等50ms并flush后恰查1次且开菜单。固定#2983候选不读取GitHub议题或发网络请求。
		it("debounces # autocomplete while typing", async () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 实际建议调用计数初始0。
			let suggestionCalls = 0;

			// 内存提供者仅构造固定结果。
			const mockProvider: AutocompleteProvider = {
				// async回调接行数组/光标列，忽略行号。
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					// 被调用时计数加1。
					suggestionCalls += 1;
					// 提取本次首行光标前上下文。
					const text = (lines[0] || "").slice(0, cursorCol);
					// 返回建议对象。
					return {
						// 固定value/label为#2983，数字只是补全文字，不查真实issue。
						items: [{ value: "#2983", label: "#2983" }],
						// prefix保存实际输入text，例如#298。
						prefix: text,
					};
				},
				// 给标准应用函数，供接口完整，本例不确认候选。
				applyCompletion,
			};

			// 安装提供者。
			editor.setAutocompleteProvider(mockProvider);

			// 输入默认符号触发字符#。
			editor.handleInput("#");
			// 接数字2，重设防抖。
			editor.handleInput("2");
			// 接9，继续合并。
			editor.handleInput("9");
			// 接8，最终上下文#298。
			editor.handleInput("8");

			// 同步输入后调用数仍0。
			assert.strictEqual(suggestionCalls, 0);
			// 菜单未提前打开。
			assert.strictEqual(editor.isShowingAutocomplete(), false);

			// 真实timeout等待约50ms，非精确调度保证。
			await new Promise((resolve) => setTimeout(resolve, 50));
			// 让异步查询与结果处理推进。
			await flushAutocomplete();

			// 要求合并后只调用1次。
			assert.strictEqual(suggestionCalls, 1);
			// 有效建议应使菜单显示true。
			assert.strictEqual(editor.isShowingAutocomplete(), true);
		});

		// 自定义$触发符防抖例：提供者声明$，输入$sk也应合并1次并开菜单。$skill-name是普通候选字符串，不进行环境变量展开、技能安装或执行。
		it("debounces custom triggerCharacters autocomplete while typing", async () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 计数初始0。
			let suggestionCalls = 0;

			// 直接传对象安装提供者，不另声明mockProvider变量。
			editor.setAutocompleteProvider({
				// triggerCharacters额外启用$，不会禁用默认@/#。
				triggerCharacters: ["$"],
				// async建议函数读取首行与光标列。
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					// 实际执行时计数加1。
					suggestionCalls += 1;
					// 当前光标前文作为prefix，空行回退空串。
					const prefix = (lines[0] || "").slice(0, cursorCol);
					// 返回固定$skill-name值与不带$的label，prefix属性简写保留本次输入。
					return { items: [{ value: "$skill-name", label: "skill-name" }], prefix };
				},
				// 应用用标准纯替换函数。
				applyCompletion,
			});

			// 输入自定义$，在合法token起点安排防抖。
			editor.handleInput("$");
			// 接s。
			editor.handleInput("s");
			// 接k，最终查询前文$sk。
			editor.handleInput("k");

			// 立即检查计数0，尚未越过自然防抖期限。
			assert.strictEqual(suggestionCalls, 0);
			// 真实timer等待约50ms。
			await new Promise((resolve) => setTimeout(resolve, 50));
			// 再flush常见Promise链。
			await flushAutocomplete();

			// 应只有1次合并查询。
			assert.strictEqual(suggestionCalls, 1);
			// 菜单应显示有效候选。
			assert.strictEqual(editor.isShowingAutocomplete(), true);
		});

		// 更换提供者清自定义触发符例：先装支持$的提供者，再换未声明$的新提供者，输入$s后50ms仍不应查询新提供者。旧$不累计到后续配置，默认@/#不受本例直接验证。
		it("resets custom triggerCharacters when provider changes", async () => {
			// 创建新Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 计数只记录后面第二份提供者的实际查询。
			let suggestionCalls = 0;

			// 先安装有自定义触发符的第一份提供者。
			editor.setAutocompleteProvider({
				// 第一份声明$。
				triggerCharacters: ["$"],
				// 第一份查询函数若运行会返回固定建议；注册时并未执行，且此处没输入文字。
				getSuggestions: async () => ({ items: [{ value: "$skill-name", label: "skill-name" }], prefix: "$" }),
				// 第一份也有标准应用方法。
				applyCompletion,
			});
			// 立即替换为另一提供者，setAutocompleteProvider取消旧请求/UI并重新建立触发字符集合。
			editor.setAutocompleteProvider({
				// 第二份未声明triggerCharacters，默认只有Editor保留的@/#。
				getSuggestions: async () => {
					// 第二份实际被调用才增加计数。
					suggestionCalls += 1;
					// 若意外调用会返回有效候选，方便后面菜单断言暴露误触发。
					return { items: [{ value: "$skill-name", label: "skill-name" }], prefix: "$" };
				},
				// 应用引用标准函数。
				applyCompletion,
			});

			// 输入$，按第二份配置应是普通文字而非自然触发符。
			editor.handleInput("$");
			// 再输入s，也不应延续未登记的$上下文。
			editor.handleInput("s");
			// 等约50ms，让意外防抖任务有机会执行。
			await new Promise((resolve) => setTimeout(resolve, 50));
			// flush异步入口。
			await flushAutocomplete();

			// 新提供者调用数仍0，旧触发配置没有泄漏。
			assert.strictEqual(suggestionCalls, 0);
			// 菜单仍关，防隐式使用旧提供者结果。
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		// 合作取消例：@mai启动一个500ms才兑现的mock查询，等250ms后输入n应触发signal.abort，回调清timer并兑现null，50ms后计数为1。仅证明本mock响应取消；新查询仍可能留500ms定时器到测试结束后，不保证所有任务都已清理。
		it("aborts active @ autocomplete when typing continues", async () => {
			// 创建独立Editor，使用真实串行请求/AbortController逻辑。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// let aborts记录abort事件回调次数，不是请求总数或进程信号次数。
			let aborts = 0;

			// 提供者使用内存Promise和timer模拟较慢工作，没有真实fd或网络。
			const mockProvider: AutocompleteProvider = {
				// 前三参数以_标未使用，只依赖options.signal作合作取消。
				getSuggestions: async (_lines, _cursorLine, _cursorCol, options) => {
					// new Promise的executor现在注册timer与abort监听；return await使提供者等它兑现，不阻塞线程。
					return await new Promise((resolve) => {
						// 设500ms真实timer，若未取消则到时尝试返回固定建议。
						const timeout = setTimeout(() => {
							// 正常完成回调兑现@main.ts建议；resolve只首次有效，不执行文件读取。
							resolve({ items: [{ value: "@main.ts", label: "main.ts" }], prefix: "@main" });
							// 500是等待时长毫秒，实际回调可能因事件循环繁忙更晚。
						}, 500);
						// 给本请求的AbortSignal注册取消监听，不是监听操作系统SIGTERM等信号。
						options.signal.addEventListener(
							// 事件名abort与AbortController.abort对应。
							"abort",
							// 回调只有之后发生取消时才执行，注册不马上计数。
							() => {
								// 记录一次合作取消通知。
								aborts += 1;
								// 清除这个查询尚未触发的500ms timer，避免它稍后再跑正常结果回调。
								clearTimeout(timeout);
								// 用null正常兑现Promise结束工作，不是reject；允许Editor串行队列继续处理后来的请求。
								resolve(null);
							},
							// once:true让这份监听在第一次事件执行后移除，不等于自动替所有查询清timer或监听。
							{ once: true },
						);
					});
				},
				// 候选应用函数引用标准助手，本例不确认菜单。
				applyCompletion,
			};

			// 安装合作取消mock。
			editor.setAutocompleteProvider(mockProvider);

			// 输入@安排自然防抖。
			editor.handleInput("@");
			// 接m，重设等待。
			editor.handleInput("m");
			// 接a。
			editor.handleInput("a");
			// 接i，最终启动上下文@mai。
			editor.handleInput("i");
			// 真实等约250ms，通常足以经过20ms防抖并进入500ms查询；这是时序假设，不是查询开始状态的直接断言。
			await new Promise((resolve) => setTimeout(resolve, 250));
			// 继续输入n使旧查询过期并发abort，mock配合清旧timer/兑现null，再可启动新一轮。
			editor.handleInput("n");
			// 等约50ms给取消和新防抖机会，没有等待新的500ms任务全部完成。
			await new Promise((resolve) => setTimeout(resolve, 50));

			// 只要求已观察1次abort；没有断言最终菜单内容、查询数量或测试尾部无待处理timer。
			assert.strictEqual(aborts, 1);
		});

		// 删空斜杠菜单例：/打开mock命令列表后Backspace删掉/，文本回空且菜单关闭。文件名/命令描述均是固定文字，不执行/model或/help。
		it("hides autocomplete when backspacing slash command to empty", async () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Mock provider with slash commands
			// 声明内存命令候选提供者。
			const mockProvider: AutocompleteProvider = {
				// async读取首行和光标列，忽略行号。
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					// 取首逻辑行或空串。
					const text = lines[0] || "";
					// slice提取光标前prefix。
					const prefix = text.slice(0, cursorCol);
					// Only return slash command suggestions when line starts with /
					// 仅从/起的prefix进入候选构造，删空之后不再满足。
					if (prefix.startsWith("/")) {
						// 固定命令数组，每次符合上下文的查询都会新建这些对象。
						const commands = [
							// 候选/model带label与说明，只供菜单，不真正切模型。
							{ value: "/model", label: "model", description: "Change model" },
							// 候选/help同理，不执行帮助命令。
							{ value: "/help", label: "help", description: "Show help" },
						];
						// 去首/得到query；当前实际输入仅/所以query为空串。
						const query = prefix.slice(1); // Remove leading /
						// 按候选含/的value做startsWith；空query会匹配两项，但本测试不验证输入m等其他前缀时的筛选行为。
						const filtered = commands.filter((c) => c.value.startsWith(query));
						// 至少一项才返回建议。
						if (filtered.length > 0) {
							// items引用filtered、prefix属性简写原查询前缀，交Editor建菜单。
							return { items: filtered, prefix };
						}
					}
					// 非斜杠或无匹配正常返回null。
					return null;
				},
				// 标准应用方法仅供接口完整，本例不确认候选。
				applyCompletion,
			};

			// 安装mock。
			editor.setAutocompleteProvider(mockProvider);

			// Type "/" - should show slash command suggestions
			// 输入/触发自然命令建议。
			editor.handleInput("/");
			// 等待异步结果应用。
			await flushAutocomplete();
			// 正文仍/，开菜单不是自动把首项写入。
			assert.strictEqual(editor.getText(), "/");
			// 明确要求菜单已开，为删除后的关闭断言提供前置状态。
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// Backspace to delete "/" - should hide autocomplete completely
			// Backspace删唯一/并触发已有菜单的更新或关闭路径。
			editor.handleInput("\x7f"); // Backspace
			// 等待补全状态更新。
			await flushAutocomplete();
			// 当前文字应空，没有残留协议控制字节。
			assert.strictEqual(editor.getText(), "");
			// 菜单应关闭，不能让原斜杠列表留在空输入后。
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		// 精确参数Enter保留例：/argtest two返回按two筛后的唯一项two，Enter应用后文字应不变。标题说首项仍高亮，但当前mock过滤后本就只剩two，不能独立证明在one仍首选时强行保留第二项；后面未过滤列表例覆盖选择规则。
		it("applies exact typed slash-argument value on Enter even when first item is highlighted", async () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Mock provider for /argtest command with argument completions
			// 声明固定参数候选mock，不真正注册或运行argtest业务命令。
			const mockProvider: AutocompleteProvider = {
				// 异步读取首行与码元光标，忽略行号。
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					// 首行缺失时用空串。
					const text = lines[0] || "";
					// 只取光标前文，不让右侧文本参与参数匹配。
					const beforeCursor = text.slice(0, cursorCol);

					// Check if we're in argument completion context: "/argtest <prefix>"
					// 正则要求开头/argtest、至少一个空白和一段非空白参数到行末；捕获组1取参数文字，不是执行正则中的命令。
					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					// match为null则跳过候选，存在才读捕获组。
					if (argtestMatch) {
						// 取第1组参数，!只影响TS，不再验证字符串内容。
						const argumentText = argtestMatch[1]!;
						// 固定三个参数对象按one/two/three排列。
						const allArguments = [
							// 第一项one，输入two时会被后面filter排除。
							{ value: "one", label: "one" },
							// 第二项two，是精确输入目标。
							{ value: "two", label: "two" },
							// 第三项three，也不以two开头。
							{ value: "three", label: "three" },
						];
						// Return all arguments that start with the typed prefix
						// startsWith大小写敏感，只保留以用户参数开头的项，原数组不变；two查询后仅剩two。
						const filtered = allArguments.filter((arg) => arg.value.startsWith(argumentText));
						// 有候选才构造建议。
						if (filtered.length > 0) {
							// items用filtered，prefix仅参数argumentText，不包括/argtest和分隔空格。
							return { items: filtered, prefix: argumentText };
						}
					}
					// 无上下文或无匹配正常兑现null。
					return null;
				},
				// 标准applyCompletion用prefix长度替换参数，不执行斜杠命令。
				applyCompletion,
			};

			// 安装mock。
			editor.setAutocompleteProvider(mockProvider);

			// Type "/argtest two"
			// 输入/，可开始自然命令上下文。
			editor.handleInput("/");
			// 接命令名a。
			editor.handleInput("a");
			// 接r。
			editor.handleInput("r");
			// 接g。
			editor.handleInput("g");
			// 接t。
			editor.handleInput("t");
			// 接e。
			editor.handleInput("e");
			// 接s。
			editor.handleInput("s");
			// 接t，形成/argtest。
			editor.handleInput("t");
			// 插空格，进入参数区域。
			editor.handleInput(" ");
			// 输入参数t。
			editor.handleInput("t");
			// 接w。
			editor.handleInput("w");
			// 接o，参数为two。
			editor.handleInput("o");

			// 确认用户原文/argtest two完整。
			assert.strictEqual(editor.getText(), "/argtest two");
			// 等待最后有效补全请求处理；同步中间输入的旧请求可能在排队阶段失效。
			await flushAutocomplete();
			// 要求参数菜单已开。
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// Press Enter - should apply the exact typed value "two", not the first item
			// Enter应用当前参数项；prefix是two而非/开头，所以此次确认后返回，不继续提交清空输入。
			editor.handleInput("\r");

			// The exact typed value "two" should be retained
			// 正文仍/argtest two，未把别的参数替进来；没有直接读取菜单此前高亮下标。
			assert.strictEqual(editor.getText(), "/argtest two");
		});

		// 非精确参数首前缀例：输入t，候选two/three/twelve都匹配，Enter应使用有序表中首匹配two。验证最终应用结果，不调用实际argtest。
		it("selects first prefix match on Enter when typed arg is not exact match", async () => {
			// 创建新Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Mock provider for /argtest command with argument completions
			// 内存提供者仅按参数前缀筛固定表。
			const mockProvider: AutocompleteProvider = {
				// async读取首行和码元列。
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					// 获取首行原文或空串。
					const text = lines[0] || "";
					// 截取光标前上下文。
					const beforeCursor = text.slice(0, cursorCol);

					// Check if we're in argument completion context
					// 匹配/argtest加非空白参数，捕获实际参数串。
					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					// 存在匹配才继续。
					if (argtestMatch) {
						// 取参数捕获组，当前最终t。
						const argumentText = argtestMatch[1]!;
						// 固定表顺序决定无精确命中时的首前缀选项。
						const allArguments = [
							// two排第一，是预期应用项。
							{ value: "two", label: "two" },
							// three同样以t开头，证明不是唯一候选。
							{ value: "three", label: "three" },
							// twelve是第三个同前缀候选。
							{ value: "twelve", label: "twelve" },
						];
						// Return all items that start with the typed prefix
						// filter按value.startsWith参数筛，保留原顺序。
						const filtered = allArguments.filter((arg) => arg.value.startsWith(argumentText));
						// 有结果才返回建议。
						if (filtered.length > 0) {
							// 建议prefix为参数t，应用只改它，不改命令名。
							return { items: filtered, prefix: argumentText };
						}
					}
					// 无匹配或上下文不符返回null。
					return null;
				},
				// 用标准纯文字替换方法。
				applyCompletion,
			};

			// 安装提供者。
			editor.setAutocompleteProvider(mockProvider);

			// Type "/argtest t" - filtered to [two, three, twelve], prefix "t" matches "two" first
			// 输入/。
			editor.handleInput("/");
			// 接a。
			editor.handleInput("a");
			// 接r。
			editor.handleInput("r");
			// 接g。
			editor.handleInput("g");
			// 接t。
			editor.handleInput("t");
			// 接e。
			editor.handleInput("e");
			// 接s。
			editor.handleInput("s");
			// 接t，命令名完整。
			editor.handleInput("t");
			// 插分隔空格。
			editor.handleInput(" ");
			// 输入非精确参数t。
			editor.handleInput("t");

			// 等待补全建立当前列表。
			await flushAutocomplete();
			// 要求菜单已开，不是直接没有结果。
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// Press Enter - "t" prefix matches "two" (first in list), so "two" is applied
			// Enter确认当前最佳高亮，按实际规则无精确匹配则取首前缀two。
			editor.handleInput("\r");
			// 要求最终/argtest two，非精确前缀被补齐。
			assert.strictEqual(editor.getText(), "/argtest two");
		});

		// 未过滤列表的唯一前缀例：提供者总返one/two/three，输入tw后实际Editor选择第二项two，Enter应应用它。用最终文字观察选项，不直接断言Enter前颜色或下标。
		it("highlights unique prefix match as user types (before full exact match)", async () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Mock provider that returns all items unfiltered (like real extensions do)
			// 提供者保留全部候选，让Editor自身的最佳匹配规则接受检验。
			const mockProvider: AutocompleteProvider = {
				// async读取首行与光标列。
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					// 取当前首行或空串。
					const text = lines[0] || "";
					// 只截光标前文字。
					const beforeCursor = text.slice(0, cursorCol);

					// 匹配固定argtest参数上下文。
					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					// 匹配成功才提供参数列表。
					if (argtestMatch) {
						// 取用户参数串，最终为tw。
						const argumentText = argtestMatch[1]!;
						// Return all items - provider does not filter
						// 完整候选数组不会在提供者内filter。
						const allArguments = [
							// 首项one不匹配tw，若Editor始终选0会出错。
							{ value: "one", label: "one" },
							// 第二项two唯一以tw开头。
							{ value: "two", label: "two" },
							// 第三项three以t但不以tw开头。
							{ value: "three", label: "three" },
						];
						// items原表全返回，prefix为用户参数；最佳下标由Editor计算，不是提供者通过数组只留一项实现。
						return { items: allArguments, prefix: argumentText };
					}
					// 其他上下文返回null。
					return null;
				},
				// 标准应用函数替换参数前缀。
				applyCompletion,
			};

			// 安装该未过滤提供者。
			editor.setAutocompleteProvider(mockProvider);

			// Type "/argtest tw" - "tw" is a prefix of only "two"
			// 输入/。
			editor.handleInput("/");
			// 接a。
			editor.handleInput("a");
			// 接r。
			editor.handleInput("r");
			// 接g。
			editor.handleInput("g");
			// 接t。
			editor.handleInput("t");
			// 接e。
			editor.handleInput("e");
			// 接s。
			editor.handleInput("s");
			// 接t。
			editor.handleInput("t");
			// 插参数前空格。
			editor.handleInput(" ");
			// 输入t。
			editor.handleInput("t");
			// 接w，形成tw而非完整two。
			editor.handleInput("w");

			// 确认用户只输入到/argtest tw。
			assert.strictEqual(editor.getText(), "/argtest tw");
			// 等待候选与默认高亮建立。
			await flushAutocomplete();
			// 菜单应显示。
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// Press Enter - "tw" uniquely matches "two", so "two" should be applied
			// Enter应用当前选项；实际getBestAutocompleteMatchIndex选首个startsWith tw的two。
			editor.handleInput("\r");
			// 要求/argtest two，证明不是列表原首项one。
			assert.strictEqual(editor.getText(), "/argtest two");
		});

		// 未过滤列表的多前缀例：one/two/three全返，输入t时two和three都匹配，Editor应优先顺序在前的two而非one或最后three。
		it("selects first prefix match when multiple items match", async () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Mock provider that returns all items unfiltered
			// 提供者返回完整表，不先筛到t开头。
			const mockProvider: AutocompleteProvider = {
				// async读取首行和光标列。
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					// 获取首行原文或空串。
					const text = lines[0] || "";
					// 取光标前上下文。
					const beforeCursor = text.slice(0, cursorCol);

					// 匹配/argtest非空白参数模式。
					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					// 有匹配才构造列表。
					if (argtestMatch) {
						// 取参数捕获组，最终t。
						const argumentText = argtestMatch[1]!;
						// 固定有序候选表。
						const allArguments = [
							// 首项one不匹配t。
							{ value: "one", label: "one" },
							// 第二项two是第一个前缀命中。
							{ value: "two", label: "two" },
							// 第三项three也是前缀命中，但不能盖掉先遇的two。
							{ value: "three", label: "three" },
						];
						// 完整表交Editor，prefix用于默认选中和后续替换。
						return { items: allArguments, prefix: argumentText };
					}
					// 不符上下文返回null。
					return null;
				},
				// 候选应用使用标准纯替换方法。
				applyCompletion,
			};

			// 安装提供者。
			editor.setAutocompleteProvider(mockProvider);

			// Type "/argtest t" - "t" is a prefix of both "two" and "three"
			// 输入/。
			editor.handleInput("/");
			// 接a。
			editor.handleInput("a");
			// 接r。
			editor.handleInput("r");
			// 接g。
			editor.handleInput("g");
			// 接t。
			editor.handleInput("t");
			// 接e。
			editor.handleInput("e");
			// 接s。
			editor.handleInput("s");
			// 接t。
			editor.handleInput("t");
			// 插空格。
			editor.handleInput(" ");
			// 输入参数t。
			editor.handleInput("t");

			// 等待菜单建立。
			await flushAutocomplete();
			// 确认菜单打开。
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// Press Enter - "t" matches "two" first, so "two" is selected
			// Enter应用当前最佳高亮，prefix不以/起所以不提交清空。
			editor.handleInput("\r");
			// 要求/argtest two，观察首前缀优先规则。
			assert.strictEqual(editor.getText(), "/argtest two");
		});

		// 模型名样式参数例：/model后输入gpt-4o-mini并Enter应保留该值。这里只mock三条名字且按前缀过滤，最终已只剩精确项；不加载真实模型目录、切换模型或验证价格/可用性。
		it("works for built-in-style command argument completion path (model-like)", async () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Mock provider for /model command with model completions
			// 声明模型样式字符串候选提供者，不调用模型API。
			const mockProvider: AutocompleteProvider = {
				// async读取首行和光标列。
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					// 获取首行原文。
					const text = lines[0] || "";
					// 取光标前上下文。
					const beforeCursor = text.slice(0, cursorCol);

					// Check if we're in /model argument completion context
					// Use [^ ]+ to match any non-space characters (including hyphens)
					// 正则实际用非空白捕获，可含连字符；原英文提到非ASCII空格字符组只是概括，不把它当实际正则源码。
					const modelMatch = beforeCursor.match(/^\/model\s+(\S+)$/);
					// 有/model参数匹配才继续。
					if (modelMatch) {
						// 取模型名参数，!只作静态非空断言。
						const modelText = modelMatch[1]!;
						// 固定三条测试名字，不查询实时模型列表。
						const allModels = [
							// gpt-4o作较短前缀项，完整gpt-4o-mini查询时会被filter排除。
							{ value: "gpt-4o", label: "gpt-4o" },
							// gpt-4o-mini为当前精确目标。
							{ value: "gpt-4o-mini", label: "gpt-4o-mini" },
							// claude-sonnet作为不同前缀对照项。
							{ value: "claude-sonnet", label: "claude-sonnet" },
						];
						// Return all models that start with the typed prefix
						// 按候选value.startsWith输入modelText过滤，保持原顺序，不做模糊模型搜索。
						const filtered = allModels.filter((m) => m.value.startsWith(modelText));
						// 有至少一项才提供建议。
						if (filtered.length > 0) {
							// prefix只取模型参数，应用时保留/model和空格。
							return { items: filtered, prefix: modelText };
						}
					}
					// 其他上下文或无匹配正常返回null。
					return null;
				},
				// 标准应用函数完成字符串替换。
				applyCompletion,
			};

			// 安装mock。
			editor.setAutocompleteProvider(mockProvider);

			// Type "/model gpt-4o-mini" - exact match for second item in list
			// 输入/。
			editor.handleInput("/");
			// 接m。
			editor.handleInput("m");
			// 接o。
			editor.handleInput("o");
			// 接d。
			editor.handleInput("d");
			// 接e。
			editor.handleInput("e");
			// 接l，形成/model。
			editor.handleInput("l");
			// 插参数前空格。
			editor.handleInput(" ");
			// 输入模型参数g。
			editor.handleInput("g");
			// 接p。
			editor.handleInput("p");
			// 接t。
			editor.handleInput("t");
			// 插普通连字符，不是启动命令行选项解析。
			editor.handleInput("-");
			// 接数字4。
			editor.handleInput("4");
			// 接o。
			editor.handleInput("o");
			// 再插连字符。
			editor.handleInput("-");
			// 接m。
			editor.handleInput("m");
			// 接i。
			editor.handleInput("i");
			// 接n。
			editor.handleInput("n");
			// 接i，完整参数gpt-4o-mini。
			editor.handleInput("i");

			// 确认输入全文正确。
			assert.strictEqual(editor.getText(), "/model gpt-4o-mini");
			// 等最终补全结果应用。
			await flushAutocomplete();
			// 要求参数菜单已开。
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// Press Enter - should retain exact typed value, not apply first highlighted item
			// Enter确认精确参数，当前参数prefix不从/起，不继续默认提交。
			editor.handleInput("\r");

			// The exact typed value should be retained
			// 要求完整/model gpt-4o-mini仍在编辑器；未直接证明原全列表首项保持高亮的情形。
			assert.strictEqual(editor.getText(), "/model gpt-4o-mini");
		});

		// 真实Combined等待异步参数例：自定义load-skills参数回调兑现skill-a，输入s后菜单应显示，Tab应用成完整参数。skill名字仅固定数据，不读取技能目录或运行加载动作。
		it("awaits async slash command argument completions", async () => {
			// 创建真实Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 构造真实Combined，让它负责找到命令并await参数回调，而不是mock整个getSuggestions。
			const provider = new CombinedAutocompleteProvider(
				// 命令表数组只有下面一个SlashCommand描述。
				[
					// 该对象包含name/description/可选参数补全函数，函数在查询时才运行。
					{
						// 命令名load-skills不含开头斜杠。
						name: "load-skills",
						// 说明仅供菜单，不自动执行加载。
						description: "Load skills",
						// async参数回调接原参数前缀，箭头表达式分到下一行；注册时不查询。
						getArgumentCompletions: async (prefix) =>
							// prefix以s开头才兑现一条skill-a，否则null；三元只求值被选分支，不涉及文件或HTTP。
							prefix.startsWith("s") ? [{ value: "skill-a", label: "skill-a" }] : null,
					},
				],
				// process.cwd读取当前工作目录路径作为配置；此斜杠参数分支无需列该目录，未传fd参数也不会启动进程。
				process.cwd(),
			);
			// 把真实提供者安装到Editor。
			editor.setAutocompleteProvider(provider);
			// 直接设/load-skills空格，setText自身不触发建议。
			editor.setText("/load-skills ");

			// 输入s延续首行斜杠参数上下文，启动查询。
			editor.handleInput("s");
			// 等待Combined的async参数回调与Editor串行链。
			await flushAutocomplete();
			// 要求菜单已开，说明Promise结果被等待后采用，而非误把Promise当数组。
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// 已有菜单时Tab同步应用skill-a。
			editor.handleInput("\t");
			// 要求完整/load-skills skill-a，不补多余斜杠或尾空格；Combined参数路径直接替换。
			assert.strictEqual(editor.getText(), "/load-skills skill-a");
			// 应用完成菜单关闭。
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		// 运行时错误参数结果例：故意把返回普通字符串的函数断言成Promise候选接口，Combined实际Array.isArray检查应拒绝它，输入保留且无菜单。as只改静态类型，不会真的变数组或Promise。
		it("ignores invalid slash command argument completion results", async () => {
			// 创建新Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 构造真实Combined验证外部回调结果边界。
			const provider = new CombinedAutocompleteProvider(
				// 命令表仅一项。
				[
					// 定义load-skills描述。
					{
						// 命令name与输入保持相同。
						name: "load-skills",
						// 说明仅展示字段。
						description: "Load skills",
						// 函数运行实际同步返回not-an-array；先as unknown再as函数类型刻意绕过TS不兼容检查，用于制造不可信运行时值。两次断言均不转值。
						getArgumentCompletions: (() => "not-an-array") as unknown as (
							// 目标函数类型声明接受argumentPrefix:string，但真实无参数函数会忽略传入参数。
							argumentPrefix: string,
							// 目标返回类型写Promise候选数组或null；真实字符串仍是字符串，await只得到原值，Combined再用运行时数组检查拒绝，不是TS提供保护。
						) => Promise<{ value: string; label: string }[] | null>,
					},
				],
				// cwd只作为基目录配置，这条参数查询不读目录或起fd。
				process.cwd(),
			);
			// 安装真实提供者。
			editor.setAutocompleteProvider(provider);
			// 设/load-skills后空格，准备输入参数。
			editor.setText("/load-skills ");

			// 输入s触发参数查询，真实回调产生错误形状值。
			editor.handleInput("s");
			// 等待该结果被Combined判无候选并由Editor处理。
			await flushAutocomplete();
			// 要求无菜单，未把字符串当候选数组展示。
			assert.strictEqual(editor.isShowingAutocomplete(), false);
			// 用户原输入/load-skills s保留，错误建议不应破坏文字。
			assert.strictEqual(editor.getText(), "/load-skills s");
		});

		// 无参数补全命令例：真实Combined表里help无参数回调、model有回调，输入/he菜单确认成/help空格后关闭。实际本例只确认命令名后状态，没有再输入help参数强制验证后续所有查询都无建议。
		it("does not show argument completions when command has no argument completer", async () => {
			// 创建新Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 构造真实Combined处理命令名与应用规则。
			const provider = new CombinedAutocompleteProvider(
				// 命令表含一个无参数回调和一个有参数回调的描述。
				[
					// help仅name/description，不含getArgumentCompletions。
					{ name: "help", description: "Show help" },
					// 第二个model对象作为有参数回调对照配置。
					{
						// 命令名model。
						name: "model",
						// 说明Switch model只是固定展示文案。
						description: "Switch model",
						// 同步参数回调返回固定claude-opus数组，接口允许同步或Promise；本例输入help不会执行它。
						getArgumentCompletions: () => [{ value: "claude-opus", label: "claude-opus" }],
					},
				],
				// cwd只存配置，当前命令名查询不列目录，fd省略。
				process.cwd(),
			);
			// 安装提供者。
			editor.setAutocompleteProvider(provider);

			// 输入/启动命令名补全。
			editor.handleInput("/");
			// 接h缩小命令名前缀。
			editor.handleInput("h");
			// 接e，形成/he。
			editor.handleInput("e");
			// 等待命令名候选建立。
			await flushAutocomplete();
			// 要求菜单显示。
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// 已有菜单Tab确认help，真实Combined命令名应用会补开头/和尾空格。
			editor.handleInput("\t");
			// 要求/help后恰一个空格，保留可继续输入参数的位置。
			assert.strictEqual(editor.getText(), "/help ");
			// 确认后菜单关闭；不表示实际help命令已执行。
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});
	});

	// 字符跳转组：Ctrl+]进入向前等待，Ctrl+Alt+]进入向后等待，下一段可打印输入当搜索目标，不插正文。搜索基于原字符串indexOf/lastIndexOf，坐标是码元下标；这里固定ASCII样本，不等于所有字素边界都已验证。
	describe("Character jump (Ctrl+])", () => {
		// 同一行向前首命中例：hello world行首等目标o后，应跳hello里的第一个o下标4，而不是world里的o。只查光标，不自动插入目标字符。
		it("jumps forward to first occurrence of character on same line", () => {
			// 新建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设hello world，默认光标在末尾。
			editor.setText("hello world");
			// Ctrl+A回当前逻辑行首。
			editor.handleInput("\x01"); // Ctrl+A - go to start
			// 明确检查起点0,0。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// 0x1d是旧式Ctrl+]编码，默认动作把jumpMode设向前，尚未执行目标搜索。
			editor.handleInput("\x1d"); // Ctrl+] (legacy sequence for ctrl+])
			// 下一次输入o被当搜索目标，跳转后退出等待，不作为新文字插入。
			editor.handleInput("o"); // Jump to first 'o'

			// 要求行0列4，指向hello的o所在码元。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 }); // 'o' in "hello"
		});

		// 排除当前向前命中例：起点已在hello的o列4，再找o应到world的o列7，不能原地停在同一个o。
		it("jumps forward to next occurrence after cursor", () => {
			// 创建新Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置相同双o文本。
			editor.setText("hello world");
			// 先Ctrl+A到行首。
			editor.handleInput("\x01"); // Ctrl+A - go to start
			// Move cursor to the 'o' in "hello" (col 4)
			// 四次Right跨h/e/l/l，停在首个o之前下标4。
			for (let i = 0; i < 4; i++) editor.handleInput("\x1b[C");
			// 确认起点确在首o上，避免实际只是从行首找首o。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 });

			// Ctrl+]进入向前目标等待。
			editor.handleInput("\x1d"); // Ctrl+]
			// 目标o向当前码元之后搜索，匹配下一处o。
			editor.handleInput("o"); // Jump to next 'o' (in "world")

			// 要求列7，即world里的o，原位置4被跳过。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // 'o' in "world"
		});

		// 跨行向前例：abc/def/ghi从首行开头找g应到第三逻辑行开头。验证不局限当前行，也不以屏幕折行号作为逻辑行号。
		it("jumps forward across multiple lines", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设三条短逻辑行，初始光标在行2列3。
			editor.setText("abc\ndef\nghi");
			// Cursor is at end (line 2, col 3). Move to line 0 via up arrows, then Ctrl+A
			// 第一次Up移到中间逻辑行。
			editor.handleInput("\x1b[A"); // Up
			// 第二次Up移到第一逻辑行。
			editor.handleInput("\x1b[A"); // Up - now on line 0
			// Ctrl+A把本行列归0，排除只移动行但列仍3。
			editor.handleInput("\x01"); // Ctrl+A - go to start of line
			// 确认首行首列起点。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// Ctrl+]准备向前查目标。
			editor.handleInput("\x1d"); // Ctrl+]
			// 输入g作为目标，当前及中间行无g后应继续查后行。
			editor.handleInput("g"); // Jump to 'g' on line 3

			// 要求逻辑行2列0，第三行g起点。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 0 });
		});

		// 同一行向后最近命中例：hello world末尾列11，Ctrl+Alt+]后o应落world的o列7，不是更远的hello o。标题first指反向遍历首先遇到，不是原串最左一个。
		it("jumps backward to first occurrence before cursor on same line", () => {
			// 创建新Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// setText把光标放hello world末尾。
			editor.setText("hello world");
			// Cursor at end (col 11)
			// 明确要求起点行0列11。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 });

			// ESC接0x1d是旧式Ctrl+Alt+]，设置向后目标等待。
			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+] (ESC followed by Ctrl+])
			// 下一输入o向左搜索，不插o到末尾。
			editor.handleInput("o"); // Jump to last 'o' before cursor

			// 要求列7，反向最近的目标。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // 'o' in "world"
		});

		// 跨行向后例：从ghi末尾查a，应越过当前/中间行到abc首位。检查原逻辑行坐标，不操作终端滚动历史。
		it("jumps backward across multiple lines", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置abc/def/ghi三行。
			editor.setText("abc\ndef\nghi");
			// Cursor at end of line 3
			// 确认起点逻辑行2列3，即全文末尾。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 3 });

			// Ctrl+Alt+]进入向后等待。
			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+]
			// 目标a只在首行出现，搜索应跨LF边界。
			editor.handleInput("a"); // Jump to 'a' on line 1

			// 要求行0列0。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		});

		// 向前找不到例：行首hello world里查z，光标仍0,0。标题does nothing只以本例光标断言为限，实际也会退出jumpMode并清lastAction。
		it("does nothing when character is not found (forward)", () => {
			// 新建Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设不含z的固定文本。
			editor.setText("hello world");
			// Ctrl+A回行首。
			editor.handleInput("\x01"); // Ctrl+A - go to start
			// 检查起点0,0。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// 进入向前搜索等待。
			editor.handleInput("\x1d"); // Ctrl+]
			// 输入不存在的z作目标，不应把它当正文插入。
			editor.handleInput("z"); // 'z' doesn't exist

			// 光标仍0,0；此条没有额外断言全文，但callee目标路径不插字。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 }); // Cursor unchanged
		});

		// 向后找不到例：hello world末尾查z，光标保持列11。失败不环绕或回首，仍会结束这次等待。
		it("does nothing when character is not found (backward)", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设hello world。
			editor.setText("hello world");
			// Cursor at end
			// 起点应末尾列11。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 });

			// 进入向后搜索等待。
			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+]
			// 输入不存在的z目标。
			editor.handleInput("z"); // 'z' doesn't exist

			// 位置仍行0列11，未因找不到而清到行首。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 }); // Cursor unchanged
		});

		// 大小写敏感例：Hello World行首查小写h失败，再查大写W到列6。用两次独立跳转验证String搜索不自动转小写，目标不作为正则模式。
		it("is case-sensitive", () => {
			// 创建新Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置首字母分别大写H/W的两词。
			editor.setText("Hello World");
			// Ctrl+A到首行列0。
			editor.handleInput("\x01"); // Ctrl+A - go to start
			// 确认起始坐标。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// Search for lowercase 'h' - should not find it (only 'H' exists)
			// 进入向前跳转等待。
			editor.handleInput("\x1d"); // Ctrl+]
			// 目标小写h与原大写H不同，应找不到。
			editor.handleInput("h");

			// 坐标仍0,0，没把大小写当同一个字符。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 }); // Cursor unchanged

			// Search for uppercase 'W' - should find it
			// 重新Ctrl+]为第二个目标开始新等待，前次失败已退出等待。
			editor.handleInput("\x1d"); // Ctrl+]
			// 输入大写W，与原World首字符相同。
			editor.handleInput("W");

			// 要求列6，正确匹配大写目标。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 }); // 'W' in "World"
		});

		// 重复向前热键取消例：Ctrl+]按两次后o应作为普通输入加到开头，而非继续跳转。用全文变化观察等待状态已结束，不直接读私有jumpMode。
		it("cancels jump mode when Ctrl+] is pressed again", () => {
			// 新Editor隔离前例跳转状态。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设hello world。
			editor.setText("hello world");
			// Ctrl+A回行首。
			editor.handleInput("\x01"); // Ctrl+A - go to start
			// 确认0,0起点。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// 第一次Ctrl+]开启向前目标等待。
			editor.handleInput("\x1d"); // Ctrl+] - enter jump mode
			// 第二次同热键取消等待，本次热键被消费，不插控制字符。
			editor.handleInput("\x1d"); // Ctrl+] again - cancel

			// Type 'o' normally - should insert, not jump
			// 输入o现在走普通插字路径。
			editor.handleInput("o");
			// 要求ohello world，若仍跳转就不会新增这一个o。
			assert.strictEqual(editor.getText(), "ohello world");
		});

		// Escape取消例：等待目标时ESC先取消跳转，再继续普通按键处理；当前Editor没有菜单等ESC动作，所以位置不变，之后o应插正文。并非所有宿主都应吞掉ESC。
		it("cancels jump mode on Escape and processes the Escape", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置hello world。
			editor.setText("hello world");
			// Ctrl+A到首行列0。
			editor.handleInput("\x01"); // Ctrl+A - go to start
			// 确认起点。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// Ctrl+]开启目标等待。
			editor.handleInput("\x1d"); // Ctrl+] - enter jump mode
			// 单独ESC不是可打印目标，因此清等待并落入普通输入流程，不执行跳字符。
			editor.handleInput("\x1b"); // Escape - cancel jump mode

			// Cursor should be unchanged (Escape itself doesn't move cursor in editor)
			// 当前位置仍0,0，当前无其他ESC动作导致移动。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// Type 'o' normally - should insert, not jump
			// 之后o按普通文字插入。
			editor.handleInput("o");
			// 要求ohello world，验证等待没有残留。
			assert.strictEqual(editor.getText(), "ohello world");
		});

		// 重复向后热键取消例：Ctrl+Alt+]按两次后，末尾输入o应追加成hello worldo，不再跳到原文的o。
		it("cancels backward jump mode when Ctrl+Alt+] is pressed again", () => {
			// 创建新Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设hello world并停末尾。
			editor.setText("hello world");
			// Cursor at end
			// 确认列11。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 });

			// 第一次Ctrl+Alt+]开启向后目标等待。
			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+] - enter backward jump mode
			// 第二次同热键取消，本次输入不作为目标或普通正文。
			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+] again - cancel

			// Type 'o' normally - should insert, not jump
			// 下一o恢复普通插入，追加在原末尾。
			editor.handleInput("o");
			// 要求hello worldo，区别向后跳转后未改文字的结果。
			assert.strictEqual(editor.getText(), "hello worldo");
		});

		// 标点目标例：foo(bar) = baz中依次找左括号和等号，应到列3及9。查找按字面字符串，不把左括号当正则开组或执行赋值表达式。
		it("searches for special characters", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置带括号、空格和等号的普通正文。
			editor.setText("foo(bar) = baz;");
			// Ctrl+A回行首。
			editor.handleInput("\x01"); // Ctrl+A - go to start
			// 确认0,0。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// Jump to '('
			// 开启向前等待。
			editor.handleInput("\x1d"); // Ctrl+]
			// 输入左括号作为字面目标。
			editor.handleInput("(");

			// 应跳码元列3，即foo后的左括号。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

			// Jump to '='
			// 重新开启向前等待，起点沿用当前列3。
			editor.handleInput("\x1d"); // Ctrl+]
			// 输入等号字面目标。
			editor.handleInput("=");

			// 应到列9，位于原文等号，不插额外符号。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 9 });
		});

		// 空文本跳转例：空Editor查x无匹配，坐标仍0,0，不抛错。只覆盖这一空输入目标，不泛化任何不合法光标/输入结构都不会报错。
		it("handles empty text gracefully", () => {
			// 创建独立Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 显式清空，保留唯一空逻辑行。
			editor.setText("");
			// 确认当前坐标0,0。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// 进入向前目标等待。
			editor.handleInput("\x1d"); // Ctrl+]
			// 输入x作搜索，空原串中不存在它。
			editor.handleInput("x");

			// 坐标不变，不因为目标x就创建新逻辑行。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 }); // Cursor unchanged
		});

		// 跳转打断撤销合并例：先在hello前插x，跳到o再插Y，undo只去Y并保留x。通过最终文字验证lastAction清理，不直接读私有字段。
		it("resets lastAction when jumping", () => {
			// 创建新Editor。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设hello world。
			editor.setText("hello world");
			// Ctrl+A到开头，为首次插入明确位置。
			editor.handleInput("\x01"); // Ctrl+A - go to start

			// Type to set lastAction to "type-word"
			// 插x，将最近动作设连续打字type-word。
			editor.handleInput("x");
			// 确认xhello world。
			assert.strictEqual(editor.getText(), "xhello world");

			// Jump forward
			// 开启向前目标等待。
			editor.handleInput("\x1d"); // Ctrl+]
			// 找o，实际跳转方法清lastAction并把光标放首o上。
			editor.handleInput("o");

			// Type more - should start a new undo unit (lastAction was reset)
			// 在o之前插Y，因跳转已打断打字链，此次另存快照。
			editor.handleInput("Y");
			// 要求xhellYo world，x仍在开头、Y位于首o前。
			assert.strictEqual(editor.getText(), "xhellYo world");

			// Undo should only undo "Y", not "x" as well
			// 一次undo恢复Y之前状态，不撤掉更早插入的x。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 要求xhello world，证明两次打字没有错误合成一个单元。
			assert.strictEqual(editor.getText(), "xhello world");
		});
	});

	// 集中检查纵向移动的目标位置记忆：例如偏移10经过空行时暂时落到0，再进入长行时回到10。这里 col 和内部 preferredVisualCol 都按 UTF-16 偏移计算；本组 ASCII 例子中才与屏幕列数相同。
	describe("Sticky column", () => {
		// Helper: position cursor at a specific line and column
		// 给本组短 ASCII 文本设置光标位置：传入编辑器、目标逻辑行号和行内偏移，直接发送方向键，不返回值。
		// 先上移20次，再向下到目标行、Ctrl+A回行首、向右到目标位置；20次只足够这里的固定短文本，并不是任意文档的通用定位算法。参数后的 Editor/number 和 : void 只供 TypeScript 检查。
		function positionCursor(editor: Editor, line: number, col: number): void {
			// Go to line 0 first
			// let i 是可递增的循环计数器；连续发送20次上箭头，越过文档顶部的尝试不会继续移动，因此把本组几行文本的光标带到顶部。
			for (let i = 0; i < 20; i++) editor.handleInput("\x1b[A");
			// Go to target line
			// 再发送 line 次下箭头；这里的文本没有发生软换行，所以一次移动正好对应一个逻辑行。
			for (let i = 0; i < line; i++) editor.handleInput("\x1b[B");
			// Go to target col
			// Ctrl+A 把当前位置移到该逻辑行行首，同时清掉先前的目标偏移记忆。
			editor.handleInput("\x01"); // Ctrl+A
			// 发送 col 次右箭头；一次按键移动一个字素，本组全是 ASCII，因此次数恰好等于所需的 UTF-16 偏移。
			for (let i = 0; i < col; i++) editor.handleInput("\x1b[C");
		}

		// 从末行偏移10向上穿过空行，再检查首行是否仍落在10；回调不接收参数，断言失败会让该测试失败。
		it("preserves target column when moving up through a shorter line", () => {
			// 创建使用虚拟终端和固定主题的独立编辑器，避免本例继承其他测试的光标或目标位置。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Line 0: "2222222222x222" (x at col 10)
			// Line 1: "" (empty)
			// Line 2: "1111111111_111111111111" (_ at col 10)
			// 设置三行固定文本，中间为空；setText 把光标放在末行末尾，文本中的换行决定逻辑行号。
			editor.setText("2222222222x222\n\n1111111111_111111111111");

			// Position cursor on _ (line 2, col 10)
			// 先确认末行末尾确实是偏移23，避免后面的定位步骤从错误起点开始。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 23 }); // At end
			// Ctrl+A 返回末行开头，不会直接跳到整篇文本的第一行。
			editor.handleInput("\x01"); // Ctrl+A - go to start of line
			// 连续右移10次，在 ASCII 下到达末行下划线之前的偏移10。
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C"); // Move right to col 10
			// 同时比较逻辑行号2和偏移10，确认测试的起始坐标。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 10 });

			// Press Up - should move to empty line (col clamped to 0)
			// 向上进入空行：当前位置只能落到0，但编辑器仍可记住目标偏移10。
			editor.handleInput("\x1b[A"); // Up arrow
			// 确认空行上的实际坐标为第1行、偏移0。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			// Press Up again - should move to line 0 at col 10 (on 'x')
			// 继续向上进入足够长的首行，触发恢复先前目标位置的分支。
			editor.handleInput("\x1b[A"); // Up arrow
			// 确认恢复为第0行偏移10；这个坐标正好在本例 x 前面。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });
		});

		// 用相反的移动方向检查同一规则：从首行偏移10向下穿过空行，最终落在末行偏移10。
		it("preserves target column when moving down through a shorter line", () => {
			// 使用新的虚拟编辑器，纵向移动记忆从空状态开始。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 安装上下两条长行与中间空行；初始光标在末行末尾。
			editor.setText("1111111111_111\n\n2222222222x222222222222");

			// Position cursor on _ (line 0, col 10)
			// 先上移到中间空行。
			editor.handleInput("\x1b[A"); // Up to line 1
			// 再上移到第一行，为向下测试准备起点。
			editor.handleInput("\x1b[A"); // Up to line 0
			// Ctrl+A 清除刚才上移产生的偏移记忆，并回到首行开头。
			editor.handleInput("\x01"); // Ctrl+A
			// 右移10次，把 ASCII 光标定位到首行偏移10。
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C");
			// 确认定位结果，后面不再依赖 setText 的默认末尾位置。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });

			// Press Down - should move to empty line (col clamped to 0)
			// 第一次向下进入空行，临时夹到该行唯一可用偏移0。
			editor.handleInput("\x1b[B"); // Down arrow
			// 断言这一临时坐标为 { line: 1, col: 0 }。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			// Press Down again - should move to line 2 at col 10 (on 'x')
			// 第二次向下进入长末行，按此前记住的偏移选择位置。
			editor.handleInput("\x1b[B"); // Down arrow
			// 确认末行偏移10恢复，说明本例的空行没有把目标永久改成0。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 10 });
		});

		// 检查左箭头改变当前偏移后，下一段上下移动会以新位置4为目标，而不是沿用原位置5。
		it("resets sticky column on horizontal movement (left arrow)", () => {
			// 创建单独编辑器，隔离本例的移动状态。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置两条长度10的数字行，中间留空，用空行迫使纵向移动夹到0。
			editor.setText("1234567890\n\n1234567890");

			// Start at line 2, col 5
			// 从末行末尾回到末行行首，并清掉旧的目标位置。
			editor.handleInput("\x01"); // Ctrl+A
			// 右移5次，把接下来要保留的初始偏移设为5。
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C");
			// 确认起点是第2行偏移5。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 });

			// Move up through empty line
			// 先向上进入空行，此时实际偏移为0，目标仍可保留5。
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			// 再上移进入首行，恢复到偏移5。
			editor.handleInput("\x1b[A"); // Up - line 0, col 5 (sticky)
			// 检查穿过空行后的首行坐标。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });

			// Move left - resets sticky column
			// 左箭头移到偏移4；水平移动通过设置新光标位置清除纵向目标记忆。
			editor.handleInput("\x1b[D"); // Left
			// 确认左移确实发生，而不是仅仅清理了内部状态。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 });

			// Move down twice
			// 向下经过空行，以当前偏移4开始新的纵向移动。
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			// 继续到末行，观察恢复的是新偏移4。
			editor.handleInput("\x1b[B"); // Down - line 2, col 4 (new sticky from col 4)
			// 用最终坐标确认旧目标5没有影响这轮往返。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 4 });
		});

		// 检查右箭头后的新偏移6是否成为后续纵向移动的目标。
		it("resets sticky column on horizontal movement (right arrow)", () => {
			// 新建编辑器，避免使用上一例已向左调整的状态。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置两条长度10的数字行和中间空行。
			editor.setText("1234567890\n\n1234567890");

			// Start at line 0, col 5
			// 从默认末尾先上移到空行。
			editor.handleInput("\x1b[A"); // Up to line 1
			// 继续上移到首行。
			editor.handleInput("\x1b[A"); // Up to line 0
			// Ctrl+A 回首行开头，重置这段准备动作留下的纵向记忆。
			editor.handleInput("\x01"); // Ctrl+A
			// 在 ASCII 首行上右移5次。
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C");
			// 确认首行偏移5作为起点。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });

			// Move down through empty line
			// 下移到空行，偏移暂时夹为0。
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			// 再下移到末行，恢复偏移5。
			editor.handleInput("\x1b[B"); // Down - line 2, col 5 (sticky)
			// 确认纵向往返后的坐标。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 });

			// Move right - resets sticky column
			// 右箭头把偏移从5改为6，同时清掉原来的纵向目标。
			editor.handleInput("\x1b[C"); // Right
			// 确认新的实际位置是6。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 6 });

			// Move up twice
			// 向上穿过空行，开始记住当前偏移6。
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			// 再上移到首行，恢复这轮的新目标。
			editor.handleInput("\x1b[A"); // Up - line 0, col 6 (new sticky from col 6)
			// 断言首行偏移6，验证后续移动采用了右移后的坐标。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });
		});

		// 检查输入字符后，纵向移动使用插入后的偏移9，而不是插入前的8。
		it("resets sticky column on typing", () => {
			// 为字符输入与目标记忆的交互创建独立编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置数字行、空行、数字行这三个逻辑行。
			editor.setText("1234567890\n\n1234567890");

			// Start at line 2, col 8
			// 回到末行开头，开始准备偏移8。
			editor.handleInput("\x01"); // Ctrl+A
			// 发送8次右箭头，把光标放在末行偏移8。
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");

			// Move up through empty line
			// 上移进入空行，实际位置被夹到0。
			editor.handleInput("\x1b[A"); // Up
			// 继续上移，在首行恢复偏移8。
			editor.handleInput("\x1b[A"); // Up - line 0, col 8
			// 确认输入前的位置。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });

			// Type a character - resets sticky column
			// 在当前位置插入普通字符 X；该编辑动作推进光标并清掉纵向目标记忆。
			editor.handleInput("X");
			// 插入一个 ASCII 字符后偏移增加1，检查现在位于首行偏移9。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 9 });

			// Move down twice
			// 从新位置向下进入空行。
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			// 再进入末行，按新目标9定位。
			editor.handleInput("\x1b[B"); // Down - line 2, col 9 (new sticky from col 9)
			// 确认输入动作后不再恢复到旧偏移8。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 9 });
		});

		// 检查退格删除后，纵向移动采用删除后的偏移7。
		it("resets sticky column on backspace", () => {
			// 创建独立编辑器，删除操作不会改变其他例子的文本。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置上下两条数字行和空中间行。
			editor.setText("1234567890\n\n1234567890");

			// Start at line 2, col 8
			// 将末行光标先移到行首。
			editor.handleInput("\x01"); // Ctrl+A
			// 右移8次，得到删除前的目标偏移8。
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");

			// Move up through empty line
			// 上移经过空行。
			editor.handleInput("\x1b[A"); // Up
			// 再上移到首行，恢复偏移8。
			editor.handleInput("\x1b[A"); // Up - line 0, col 8
			// 核实退格前光标位置。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });

			// Backspace - resets sticky column
			// 发送 DEL 编码的退格键，删除光标左边一个 ASCII 字符，并清除纵向目标。
			editor.handleInput("\x7f"); // Backspace
			// 确认删除后光标左移到偏移7。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 });

			// Move down twice
			// 向下进入空行，此时记录的是删除后的7。
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			// 继续向下到长末行。
			editor.handleInput("\x1b[B"); // Down - line 2, col 7 (new sticky from col 7)
			// 确认纵向移动恢复到7，不会跳回删除前的8。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 7 });
		});

		// 即使空行上的 Ctrl+A 没有可见移动，也应重置原先记住的目标8；通过随后上移是否落到0来观察。
		it("resets sticky column on Ctrl+A (move to line start)", () => {
			// 新建编辑器，准备在空行上执行行首操作。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 装入数字行与空中间行。
			editor.setText("1234567890\n\n1234567890");

			// Start at line 2, col 8
			// 先返回末行开头。
			editor.handleInput("\x01"); // Ctrl+A
			// 右移8次，为进入空行建立一个非零目标。
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");

			// Move up - establishes sticky col 8
			// 上移到空行，实际偏移为0，但此前偏移8仍是纵向移动的目标。
			editor.handleInput("\x1b[A"); // Up - line 1, col 0

			// Ctrl+A - resets sticky column to 0
			// 在空行执行 Ctrl+A；设置行首位置时清除纵向目标，即使当前位置本来就是0。
			editor.handleInput("\x01"); // Ctrl+A
			// 确认 Ctrl+A 之后的实际坐标仍是空行偏移0。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			// Move up
			// 再上移到首行，观察新目标0而非旧目标8。
			editor.handleInput("\x1b[A"); // Up - line 0, col 0 (new sticky from col 0)
			// 确认首行偏移0，区分了可见坐标没变但内部记忆应改变的情况。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		});

		// 检查 Ctrl+E 到行尾后，纵向移动以新的行尾偏移5为目标。
		it("resets sticky column on Ctrl+E (move to line end)", () => {
			// 创建独立编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 首行只有5个字符，末行有10个，中间为空；可区分旧目标3与行尾5。
			editor.setText("12345\n\n1234567890");

			// Start at line 2, col 3
			// 回末行行首，为初始偏移3做准备。
			editor.handleInput("\x01"); // Ctrl+A
			// 右移3次。
			for (let i = 0; i < 3; i++) editor.handleInput("\x1b[C");

			// Move up through empty line - establishes sticky col 3
			// 上移经过空行。
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			// 继续上移到首行，恢复偏移3。
			editor.handleInput("\x1b[A"); // Up - line 0, col 3
			// 确认执行 Ctrl+E 前的首行位置。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

			// Ctrl+E - resets sticky column to end
			// Ctrl+E 设置当前逻辑行末尾，并清除旧的纵向位置记忆。
			editor.handleInput("\x05"); // Ctrl+E
			// 首行长度5，因此行尾坐标为偏移5。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });

			// Move down twice
			// 向下进入空行，使用行尾的新偏移5。
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			// 继续下移到足够长的末行。
			editor.handleInput("\x1b[B"); // Down - line 2, col 5 (new sticky from col 5)
			// 确认末行恢复到5，而不是先前的3。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 });
		});

		// 检查按单词向左移动后，后续纵向移动采用 world 开头的偏移6。
		it("resets sticky column on word movement (Ctrl+Left)", () => {
			// 创建独立编辑器及虚拟宿主。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 上下两行都使用 hello world，长度11，中间为空。
			editor.setText("hello world\n\nhello world");

			// Start at end of line 2 (col 11)
			// setText 默认将光标放在末行末尾，先确认偏移11。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 11 });

			// Move up through empty line - establishes sticky col 11
			// 上移进入空行，暂时夹到0。
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			// 再上移到首行末尾，恢复原目标11。
			editor.handleInput("\x1b[A"); // Up - line 0, col 11
			// 确认单词移动前位于首行末尾。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 });

			// Ctrl+Left - word movement resets sticky column
			// 发送 Ctrl+Left 的修饰方向键序列，按单词向左移到 world 起点，同时清掉纵向目标。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			// 检查结果为首行偏移6；空格位于偏移5。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 }); // Before "world"

			// Move down twice
			// 从新偏移6下移经过空行。
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			// 继续到末行。
			editor.handleInput("\x1b[B"); // Down - line 2, col 6 (new sticky from col 6)
			// 确认按单词移动后的6成为新的纵向目标。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 6 });
		});

		// 检查按单词向右移动后，后续纵向移动采用 hello 末尾的偏移5。
		it("resets sticky column on word movement (Ctrl+Right)", () => {
			// 新建编辑器，隔离单词导航状态。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 安装上下相同的 hello world 与中间空行。
			editor.setText("hello world\n\nhello world");

			// Start at line 0, col 0
			// 上移到空行。
			editor.handleInput("\x1b[A"); // Up
			// 再上移到首行。
			editor.handleInput("\x1b[A"); // Up
			// Ctrl+A 回首行起点，清除准备过程的偏移记忆。
			editor.handleInput("\x01"); // Ctrl+A
			// 确认首行偏移0。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// Move down through empty line - establishes sticky col 0
			// 下移进入空行，当前目标也是0。
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			// 继续下移到末行行首。
			editor.handleInput("\x1b[B"); // Down - line 2, col 0
			// 确认单词移动前的末行坐标。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 0 });

			// Ctrl+Right - word movement resets sticky column
			// Ctrl+Right 跨过 hello，到达本例单词末尾偏移5，并重置纵向目标。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			// 断言目标是 hello 后的位置5，而不是 world 的开头6。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 }); // After "hello"

			// Move up twice
			// 向上经过空行。
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			// 继续进入首行。
			editor.handleInput("\x1b[A"); // Up - line 0, col 5 (new sticky from col 5)
			// 确认恢复到新的偏移5，完成单词右移后的纵向检查。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
		});

		// 检查撤销不仅恢复文字和光标，也清掉编辑后形成的纵向目标9；恢复到偏移8后再上下移动应使用8。
		it("resets sticky column on undo", () => {
			// 创建独立的虚拟编辑器，撤销栈开始为空。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置两条数字行与中间空行，光标默认在末行末尾。
			editor.setText("1234567890\n\n1234567890");

			// Go to line 0, col 8
			// 先上移到空行。
			editor.handleInput("\x1b[A"); // Up to line 1
			// 再上移到首行。
			editor.handleInput("\x1b[A"); // Up to line 0
			// Ctrl+A 回首行开头，清除这段准备动作的目标记忆。
			editor.handleInput("\x01"); // Ctrl+A
			// 向右8次，定位到首行偏移8。
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");
			// 确认定位结果。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });

			// Move down through empty line - establishes sticky col 8
			// 向下穿过空行，暂时夹到0。
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			// 继续下移到末行偏移8。
			editor.handleInput("\x1b[B"); // Down - line 2, col 8 (sticky)
			// 确认插字前末行位置，为之后的撤销快照提供明确坐标。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 8 });

			// Type something to create undo state - this clears sticky and sets col to 9
			// 插入 X；普通输入在更改文字前保存可撤销状态，并将光标推进到9。
			editor.handleInput("X");
			// 确认只有末行在第8个偏移处多了 X，上面的行未变。
			assert.strictEqual(editor.getText(), "1234567890\n\n12345678X90");
			// 检查插入后的光标偏移9。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 9 });

			// Move up - establishes new sticky col 9
			// 从新位置向上进入空行，开始以9为目标。
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			// 继续到首行，恢复偏移9。
			editor.handleInput("\x1b[A"); // Up - line 0, col 9
			// 确认撤销前已形成与快照坐标不同的目标9。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 9 });

			// Undo - resets sticky column and restores cursor to line 2, col 8
			// 发送 Kitty 编码的 Ctrl+- 撤销键，弹出输入 X 之前的编辑快照；不把后来的方向键当作独立撤销条目。
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 确认插入的 X 被撤销，全文恢复原始三行。
			assert.strictEqual(editor.getText(), "1234567890\n\n1234567890");
			// 确认快照恢复的光标是第2行偏移8，而非执行撤销前首行偏移9。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 8 });

			// Move up - should capture new sticky from restored col 8, not old col 9
			// 从恢复位置上移到空行，重新记录目标8。
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			// 继续上移到首行。
			editor.handleInput("\x1b[A"); // Up - line 0, col 8 (new sticky from restored position)
			// 确认结果为8，观察撤销后没有继续沿用编辑后的旧目标9。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });
		});

		// 检查连续经过多条短行时，不会逐次把较长行的目标7缩短成2；再向下往返验证。
		it("handles multiple consecutive up/down movements", () => {
			// 创建独立编辑器，目标记忆不受上一例撤销影响。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 设置首尾长度10、中间三行各长度2的五行文本。
			editor.setText("1234567890\nab\ncd\nef\n1234567890");

			// Start at line 4, col 7
			// Ctrl+A 返回末行开头。
			editor.handleInput("\x01"); // Ctrl+A
			// 在 ASCII 末行右移7次。
			for (let i = 0; i < 7; i++) editor.handleInput("\x1b[C");
			// 确认起点为第4行偏移7。
			assert.deepStrictEqual(editor.getCursor(), { line: 4, col: 7 });

			// Move up multiple times through short lines
			// 向上到 ef，长度仅2，因此实际光标夹到末尾2。
			editor.handleInput("\x1b[A"); // Up - line 3, col 2 (clamped)
			// 继续上移到 cd，仍只能落在2，目标7应继续保留。
			editor.handleInput("\x1b[A"); // Up - line 2, col 2 (clamped)
			// 继续经过 ab 这一短行。
			editor.handleInput("\x1b[A"); // Up - line 1, col 2 (clamped)
			// 最后进入首行，它足够长，可以恢复偏移7。
			editor.handleInput("\x1b[A"); // Up - line 0, col 7 (restored)
			// 断言连续上移最终恢复的坐标。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 });

			// Move down multiple times - sticky should still be 7
			// 反向向下到 ab，重新遇到短行夹取。
			editor.handleInput("\x1b[B"); // Down - line 1, col 2
			// 继续到 cd；本例没有在中间插入水平移动或编辑。
			editor.handleInput("\x1b[B"); // Down - line 2, col 2
			// 继续到 ef。
			editor.handleInput("\x1b[B"); // Down - line 3, col 2
			// 最后进入足够长的末行，恢复到7。
			editor.handleInput("\x1b[B"); // Down - line 4, col 7 (restored)
			// 确认两个方向的连续短行穿越都以同一长行目标收尾。
			assert.deepStrictEqual(editor.getCursor(), { line: 4, col: 7 });
		});

		// 检查上箭头按软换行片段逐步上移，能最终离开长逻辑行，不会停在某个片段循环。
		it("moves correctly through wrapped visual lines without getting stuck", () => {
			// 构建15列、24行的虚拟终端；这里没有改变真实终端大小。
			const tui = createTestTUI(15, 24); // Narrow terminal
			// 编辑器使用这个较窄的虚拟宿主。
			const editor = new Editor(tui, defaultEditorTheme);

			// Line 0: short
			// Line 1: 30 chars = wraps to 3 visual lines at width 10 (after padding)
			// 设置短首行和长度30的数字末行；原英文提到的宽度10不是接下来实际传入的渲染宽度。
			editor.setText("short\n123456789012345678901234567890");
			// render(15) 将编辑布局宽度设为14，30个 ASCII 字符因此分成14、14、2三个显示片段；调用返回字符串数组，也更新编辑器用于导航的布局状态。
			editor.render(15); // This gives 14 layout width

			// Position at end of line 1 (col 30)
			// 确认 setText 后仍在末行末尾偏移30，渲染没有直接改变逻辑光标。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 30 });

			// Move up repeatedly - should traverse all visual lines of the wrapped text
			// and eventually reach line 0
			// 上移到数字行的前一个显示片段，仍属于逻辑行1。
			editor.handleInput("\x1b[A"); // Up - to previous visual line within line 1
			// 这里只检查逻辑行号，没有独立断言这一步的行内偏移。
			assert.strictEqual(editor.getCursor().line, 1);

			// 再上移一个显示片段，仍然在数字行内。
			editor.handleInput("\x1b[A"); // Up - another visual line
			// 再次检查逻辑行号1。
			assert.strictEqual(editor.getCursor().line, 1);

			// 第三次上移才越过这条逻辑行的所有显示片段，到达短首行。
			editor.handleInput("\x1b[A"); // Up - should reach line 0
			// 断言最终行号0；这组断言观察是否能走出长行，不证明每个中间偏移的精确值。
			assert.strictEqual(editor.getCursor().line, 0);
		});

		// 检查 setText 替换全文时重置旧纵向目标：新文本默认末尾偏移10应胜过旧目标8。
		it("handles setText resetting sticky column", () => {
			// 新建虚拟编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 先使用数字行准备一个旧目标8。
			editor.setText("1234567890\n\n1234567890");

			// Establish sticky column
			// 回到末行行首。
			editor.handleInput("\x01"); // Ctrl+A
			// 右移8次。
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");
			// 上移到空行，在当前位置0背后保留目标8。
			editor.handleInput("\x1b[A"); // Up

			// setText should reset sticky column
			// 用新的字母文本替换全部内容；setText 将光标放在新末行末尾并清除目标记忆。
			editor.setText("abcdefghij\n\nabcdefghij");
			// 确认新文本的初始光标为末行偏移10。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 10 }); // At end

			// Move up - should capture new sticky from current position (10)
			// 从新末尾上移到空行。
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			// 再上移到首行，按新目标10恢复。
			editor.handleInput("\x1b[A"); // Up - line 0, col 10
			// 确认没有复用替换文本前的8。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });
		});

		// 检查全文末尾的右箭头：即使无法继续右移，也把纵向目标更新为当前偏移10，从而覆盖此前被夹取的20。
		it("sets preferredVisualCol when pressing right at end of prompt (last line)", () => {
			// 创建独立编辑器，观察末尾按键对后续纵向移动的影响。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Line 0: 20 chars with 'x' at col 10
			// Line 1: empty
			// Line 2: 10 chars ending with '_'
			// 安装长度20的首行、空行和长度10的末行。原英文把 x 说成偏移10，但该字面量中 x 实际位于偏移9；本例最后断言的是偏移10，不单独断言字符。
			editor.setText("111111111x1111111111\n\n333333333_");

			// Go to line 0, press Ctrl+E (end of line) - col 20
			// 先上移到空行。
			editor.handleInput("\x1b[A"); // Up to line 1
			// 继续到首行。
			editor.handleInput("\x1b[A"); // Up to line 0
			// Ctrl+E 定位首行行尾，建立明确的起点20。
			editor.handleInput("\x05"); // Ctrl+E - move to end of line
			// 确认首行末尾偏移20。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 20 });

			// Move down to line 2 - cursor clamped to col 10 (end of line)
			// 下移到空行，实际位置0，目标20被保留。
			editor.handleInput("\x1b[B"); // Down to line 1, col 0
			// 再下移到末行，它只有10个字符，因此仍不能满足目标20。
			editor.handleInput("\x1b[B"); // Down to line 2, col 10 (clamped)
			// 确认末行实际位置夹到10。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 10 });

			// Press Right at end of prompt - nothing visible happens, but sets preferredVisualCol to 10
			// 在全文末尾按右箭头：当前实现不移动光标，但明确设置 preferredVisualCol 为当前位置相对显示片段的偏移10。
			editor.handleInput("\x1b[C"); // Right - can't move, but sets preferredVisualCol
			// 仅检查光标坐标，确认这次按键没有可见位移；内部目标的改变由后续步骤间接观察。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 10 }); // Still at same position

			// Move up twice to line 0 - should use preferredVisualCol (10) to land on 'x'
			// 上移经过空行，使用刚更新的目标10。
			editor.handleInput("\x1b[A"); // Up to line 1, col 0
			// 继续到足够长的首行。
			editor.handleInput("\x1b[A"); // Up to line 0, col 10 (on 'x')
			// 确认落在偏移10；它在此字面量的 x 后面，因此不要把断言解释成验证光标正位于 x 上。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });
		});

		// 检查宽度改变后，导航重新按当前显示片段的相对位置计算；这里只调用 render 模拟布局变化，不发送系统窗口信号。
		it("handles editor resizes when preferredVisualCol is on the same line", () => {
			// Create editor with wider terminal
			// 创建80列虚拟终端，开始时这两条长度20的行都不会软换行。
			const tui = createTestTUI(80, 24);
			// 把编辑器连接到这个虚拟宿主。
			const editor = new Editor(tui, defaultEditorTheme);

			// 设置两条长度20的数字行，中间留空。
			editor.setText("12345678901234567890\n\n12345678901234567890");

			// Start at line 2, col 15
			// 回末行开头。
			editor.handleInput("\x01"); // Ctrl+A
			// 右移15次，准备非零目标15。
			for (let i = 0; i < 15; i++) editor.handleInput("\x1b[C");

			// Move up through empty line - establishes sticky col 15
			// 上移到空行。
			editor.handleInput("\x1b[A"); // Up
			// 继续上移到首行，恢复偏移15。
			editor.handleInput("\x1b[A"); // Up - line 0, col 15
			// 确认缩窄之前的位置。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 15 });

			// Render with narrower width to simulate resize
			// 以宽度12重新渲染，实际内容布局宽度11；原逻辑偏移15现在属于从11开始的第二片，片内偏移为4。虚拟终端对象本身仍是原尺寸。
			editor.render(12); // Width 12

			// Move down - sticky should be clamped to new width
			// 向下到空行，从重排后当前片内偏移4开始处理纵向目标。
			editor.handleInput("\x1b[B"); // Down - line 1
			// 再向下进入末行的第一个显示片段。
			editor.handleInput("\x1b[B"); // Down - line 2, col should be clamped
			// 只断言行内偏移为4，未同时断言逻辑行号；这个4来自15减去当前显示片段起点11。
			assert.equal(editor.getCursor().col, 4);
		});

		// 检查目标偏移15在窄布局下暂时无法容纳时仍保留，恢复宽布局后可再次回到15。
		it("handles editor resizes when preferredVisualCol is on a different line", () => {
			// 以80列虚拟终端开始，不涉及真实窗口缩放。
			const tui = createTestTUI(80, 24);
			// 创建用于往返缩放的编辑器。
			const editor = new Editor(tui, defaultEditorTheme);

			// Create a line that wraps into multiple visual lines at width 10
			// "12345678901234567890" = 20 chars, wraps to 2 visual lines at width 10
			// 设置长度5的首行和长度20的末行；后续 render(10) 实际布局宽度9，因此并非上方英文所说的两个宽10片段。
			editor.setText("short\n12345678901234567890");

			// Go to line 1, col 15
			// Ctrl+A 返回末行开头。
			editor.handleInput("\x01"); // Ctrl+A
			// 右移15次，定位长行内偏移15。
			for (let i = 0; i < 15; i++) editor.handleInput("\x1b[C");
			// 确认长行上的起始坐标。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 15 });

			// Move up to establish sticky col 15
			// 上移到短首行，实际位置夹到5，并记住原目标15。
			editor.handleInput("\x1b[A"); // Up to line 0
			// Line 0 has only 5 chars, so cursor at col 5
			// 确认当前坐标是首行行尾。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });

			// Narrow the editor
			// 把编辑器渲染宽度改为10，内容布局宽度为9。
			editor.render(10);

			// Move down - preferredVisualCol was 15, but width is 10
			// Should land on line 1, clamped to width (visual col 9, which is logical col 9)
			// 下移到长行的首个软换行片段；非末片最大可停偏移为长度9减1，即8，以免落到下一片的起点。
			editor.handleInput("\x1b[B"); // Down to line 1
			// 精确断言第1行偏移8；原英文提9与实际断言及当前实现不同。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 8 });

			// Move up
			// 在窄布局下重新向上进入短首行。
			editor.handleInput("\x1b[A"); // Up - should go to line 0
			// 首行仍只容纳5，因此实际光标回到5，较大的目标15继续保留。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 }); // Line 0 only has 5 chars

			// Restore the original width
			// 恢复80列的编辑器渲染宽度，长行重新成为一个显示片段。
			editor.render(80);

			// Move down - preferredVisualCol was kept at 15
			// 再下移，此时长行能够容纳保存的目标15。
			editor.handleInput("\x1b[B"); // Down to line 1
			// 确认回到长行偏移15，观察目标没有被窄布局的8永久覆盖。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 15 });
		});

		// 检查先缩窄夹取、再放宽时，若当前光标落在重排后的片段中部，后续移动可改用当前偏移8并清掉旧目标。
		it("rewrapped lines: target fits current visual column", () => {
			// 准备80列虚拟宿主。
			const tui = createTestTUI(80, 24);
			// 创建编辑器。
			const editor = new Editor(tui, defaultEditorTheme);
			// 设置两条长度18的 ASCII 行，便于准确计算宽9的两个显示片段。
			editor.setText("abcdefghijklmnopqr\n123456789012345678");

			// 使用本组辅助函数把光标放到首行偏移18，也就是该逻辑行末尾。
			positionCursor(editor, 0, 18);
			// 确认辅助函数确实定位成功。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 18 });

			// Narrow to width 10 (layoutWidth = 9).
			// Line 0 last segment has visual col max 9, line 1 first segment max 8
			// 以宽10渲染得到内容宽9；光标位于首行末片末尾，片内偏移9，而下一逻辑行的非末片最大偏移为8。
			editor.render(10);

			// Move down: cursor clamps to 8
			// 向下进入下一逻辑行的首片，较大的目标9被暂时夹到8。
			editor.handleInput("\x1b[B");
			// 检查夹取后的行号与偏移。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 8 });

			// Widen back. Move up, the current visual col wins
			// 恢复宽80后，当前位置8变成整条长行中部，而不是原来窄片的末端。
			editor.render(80);
			// 此时向上，纵向决策把当前片内偏移8作为依据，而不再恢复旧偏移9。
			editor.handleInput("\x1b[A");
			// 确认首行偏移8。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });

			// Preferred was cleared by the rewrapped branch
			// 再下移一次，观察新目标的持续效果。
			editor.handleInput("\x1b[B");
			// 仍应到达下一行偏移8；行为结果与清掉旧目标相符，没有直接读取私有字段。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 8 });
		});

		// 检查重排后再进入更短行时，目标应由旧偏移9改为当前偏移8，短行只临时夹到2。
		it("rewrapped lines: target shorter than current visual column", () => {
			// 创建80列虚拟宿主。
			const tui = createTestTUI(80, 24);
			// 创建独立编辑器。
			const editor = new Editor(tui, defaultEditorTheme);
			// 设置两条长度18的长行及长度2的末行 ab。
			editor.setText("abcdefghijklmnopqr\n123456789012345678\nab");

			// 定位到首行末尾偏移18。
			positionCursor(editor, 0, 18);
			// 确认缩窄之前的坐标。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 18 });

			// Narrow to width 10 (layoutWidth = 9). Moving down clamps to col 8
			// 用宽10重新渲染，实际内容宽9。
			editor.render(10);
			// 向下从首行末片移动到下一行首片，原片内偏移9被夹到8。
			editor.handleInput("\x1b[B");
			// 确认缩窄后的逻辑坐标。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 8 });

			// Widen the editor
			// 恢复宽80，当前位置8现在处于该逻辑行的显示片段中部。
			editor.render(80);

			// Move down to short line "ab".
			// preferredVisualCol is replaced with current visual col (8), cursor clamps to 2
			// 再下移到 ab，当前偏移8无法容纳；实现记下8并将实际光标夹到短行末尾2。
			editor.handleInput("\x1b[B");
			// 确认短行行号2、偏移2。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 2 });

			// Moving up restores to preferred col 8
			// 上移回长行，它能够容纳新保存的偏移8。
			editor.handleInput("\x1b[A");
			// 确认恢复到8，而不是缩窄时旧目标9或短行实际位置2。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 8 });
		});
	});

	// 检查已登记大粘贴的短标记怎样成为一个编辑单位：方向键整段跨过、删除整段、撤销恢复正文映射、提交时展开。标记形状本身不证明存在对应的粘贴正文。
	describe("Paste marker atomic behavior", () => {
		/** Helper: simulate a large paste that creates a marker */
		// 向传入编辑器模拟一次20行括号粘贴，返回当前存储文字；副作用是插入短标记并登记正文，也会建立撤销点。
		// 例如空编辑器调用后得到 [paste #1 +20 lines]；若编辑器已有前缀，返回的是含前缀的全文，并非仅返回标记。: string 约束返回类型，不负责创建标记。
		function pasteWithMarker(editor: Editor): string {
			// repeat(20) 生成20份 line 加换行，trimEnd 去掉最后的换行；结果恰好20个逻辑行，超过大粘贴的10行阈值。
			const bigContent = "line\n".repeat(20).trimEnd(); // 20 lines
			// 把正文放在括号粘贴开始与结束控制序列之间，一次交给 handleInput；模板插值只构造字符串，不会读取系统剪贴板。
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			// The editor replaces large pastes with a marker like "[paste #1 +20 lines]"
			// getText 返回含短标记的存储文本，真实20行正文保存在编辑器的粘贴注册表里。
			return editor.getText();
		}

		/** Helper: 12-line paste content with a distinguishing tag */
		// 构造带标签的12行正文并返回字符串，不修改编辑器；例如 bigPaste('alpha') 得到 alpha0 到 alpha11，各行用换行分隔，方便区分多个登记项。
		function bigPaste(tag: string): string {
			// Array.from 用 length:12 创建12项，映射回调的 _ 表示未使用的值、i 为从0开始的下标；模板串拼标签与下标，join 用换行连接。12行会触发大粘贴标记。
			return Array.from({ length: 12 }, (_, i) => `${tag}${i}`).join("\n");
		}

		// 检查20行粘贴产生可识别的行数标记；正则只要求全文某处有该形状，没有固定断言 ID 和行数等于1与20。
		it("creates a paste marker for large pastes", () => {
			// 建立空的独立编辑器，首个大粘贴可分配新编号。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 调用辅助函数执行粘贴并保存含标记的存储文本。
			const text = pasteWithMarker(editor);
			// 转义方括号与加号匹配字面字符，两个 \d+ 匹配一位或多位数字；这里没有 ^/$，所以不是要求全文只有标记。
			assert.match(text, /\[paste #\d+ \+\d+ lines\]/);
		});

		// 检查 A、已登记标记、B 这三个编辑单位，只需三次右箭头就能依次跨过。
		it("treats paste marker as single unit for right arrow", () => {
			// 创建独立编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 先输入一个普通 ASCII 前缀 A。
			editor.handleInput("A");
			// 插入20行粘贴的短标记，登记对应正文。
			pasteWithMarker(editor);
			// 在标记之后再输入 B，光标位于整条存储文本末尾。
			editor.handleInput("B");
			// Text: "A[paste #1 +20 lines]B", cursor at end

			// Go to start
			// Ctrl+A 回到这一逻辑行开头。
			editor.handleInput("\x01"); // Ctrl+A
			// 确认起点是第0行偏移0。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// Right arrow: should move past "A"
			// 一次右箭头跨过普通字符 A。
			editor.handleInput("\x1b[C");
			// 确认现在处于标记起点偏移1。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });

			// Right arrow: should skip the entire marker
			// 第二次右箭头按有效标记分段，将整个标记当成一个单位跨过。
			editor.handleInput("\x1b[C");
			// 从全文取首个标记匹配的第0项，即完整匹配串；! 只让 TypeScript 不再视 match 结果为 null，若实际没匹配仍会在运行时报错。
			const marker = editor.getText().match(/\[paste #\d+ \+\d+ lines\]/)![0];
			// 前缀长度1加完整标记的 UTF-16 长度，等于标记后面的插入点；断言光标没有停在标记内部。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 + marker.length });

			// Right arrow: should move past "B"
			// 第三次右箭头跨过普通后缀 B。
			editor.handleInput("\x1b[C");
			// 最终偏移等于 A、标记、B 的长度之和。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 + marker.length + 1 });
		});

		// 用左箭头从行尾反向检查标记的原子移动。
		it("treats paste marker as single unit for left arrow", () => {
			// 创建新的编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 输入前缀 A。
			editor.handleInput("A");
			// 通过真正的粘贴路径建立有效标记及正文映射。
			pasteWithMarker(editor);
			// 输入后缀 B，保持默认行尾光标。
			editor.handleInput("B");
			// Cursor at end

			// Left arrow: past "B"
			// 先向左跨过 B，来到标记后面。
			editor.handleInput("\x1b[D");
			// 读取当前存储文本，供提取标记长度。
			const text = editor.getText();
			// 提取标记全文；非空断言 ! 不会替代运行时匹配检查。
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/)![0];
			// 确认光标在前缀1加标记长度的位置。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 + marker.length });

			// Left arrow: skip the entire marker
			// 再向左一步，跨过整个有效标记。
			editor.handleInput("\x1b[D");
			// 确认现在偏移1，正好是标记起点。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });

			// Left arrow: past "A"
			// 最后向左跨过 A。
			editor.handleInput("\x1b[D");
			// 确认回到逻辑行开头0。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		});

		// 检查标记后面按退格会一次删除整个标记，并将光标放回标记原起点。
		it("treats paste marker as single unit for backspace", () => {
			// 建立独立编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 输入前缀 A。
			editor.handleInput("A");
			// 插入已登记的20行粘贴标记。
			pasteWithMarker(editor);
			// 输入后缀 B，便于确认删除没有吞掉相邻正文。
			editor.handleInput("B");

			// 保存删除前的存储文本。
			const text = editor.getText();
			// 提取完整标记长度，用于准备阶段的坐标断言。
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/)![0];

			// Position cursor right after the marker (before "B")
			// Ctrl+A 回行首。
			editor.handleInput("\x01"); // Ctrl+A
			// Move past "A" and the marker
			// 一次右箭头跨过 A。
			editor.handleInput("\x1b[C"); // past "A"
			// 再一次跨过整个标记，停在 B 前面。
			editor.handleInput("\x1b[C"); // past marker
			// 确认退格的起点确实在标记后边界。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 + marker.length });

			// Backspace: should delete the entire marker at once
			// 退格按有效分段删除左侧整条标记；该路径还删除其正文登记，并调整后续更高 ID。
			editor.handleInput("\x7f");
			// 存储文本只剩 AB，证明没有留下半条标记。
			assert.strictEqual(editor.getText(), "AB");
			// 确认光标回到 A 与 B 之间的偏移1。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });
		});

		// 检查光标在标记前方时，Delete 也把整个有效标记当作一个删除单位；本例只断言文本与坐标，不检查注册表清理。
		it("treats paste marker as single unit for forward delete", () => {
			// 创建独立编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 输入 A。
			editor.handleInput("A");
			// 插入真实登记的标记。
			pasteWithMarker(editor);
			// 输入 B。
			editor.handleInput("B");

			// Position cursor on "A" (col 0) then move right once to be just before marker
			// 回到当前行开头。
			editor.handleInput("\x01"); // Ctrl+A
			// 跨过 A，来到偏移1，也就是标记之前。
			editor.handleInput("\x1b[C"); // past "A", now at col 1 (start of marker)

			// Forward delete: should delete the entire marker at once
			// 发送 Delete 键的 CSI 3~ 序列，删除光标右侧的完整标记单位；不要把退格特有的注册表重编号泛化到此路径。
			editor.handleInput("\x1b[3~"); // Delete key
			// 确认删除后文本为 AB。
			assert.strictEqual(editor.getText(), "AB");
			// 向前删除不会向左移动光标，仍应位于偏移1。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });
		});

		// 检查按单词右移时，有效标记不按内部 paste、数字、lines 等词拆开，而是作为一个整体。
		it("treats paste marker as single unit for word movement", () => {
			// 创建独立编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 输入第一个单词 X。
			editor.handleInput("X");
			// 加一个空格，将普通单词与标记隔开。
			editor.handleInput(" ");
			// 插入有效粘贴标记。
			pasteWithMarker(editor);
			// 在标记后再加空格。
			editor.handleInput(" ");
			// 输入第二个普通单词 Y，形成 X、空格、标记、空格、Y。
			editor.handleInput("Y");
			// Text: "X [paste #1 +20 lines] Y"

			// 读取这一整行的存储文本。
			const text = editor.getText();
			// 提取完整标记，以其长度计算预期边界。
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/)![0];

			// Go to start
			// Ctrl+A 回行首。
			editor.handleInput("\x01"); // Ctrl+A

			// Ctrl+Right: skip "X"
			// 第一次 Ctrl+Right 跨过普通单词 X。
			editor.handleInput("\x1b[1;5C");
			// 确认停在 X 后的偏移1，尚未跨过其后空格。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });

			// Ctrl+Right: skip whitespace + marker (marker treated as single non-ws, non-punct unit)
			// 第二次 Ctrl+Right 跳过前导空白，再把有效标记当作完整的非空白、非标点编辑单位跨过。
			editor.handleInput("\x1b[1;5C");
			// 前缀 X 加空格长度2，再加标记长度，正好是标记后的边界；没有额外跨过 Y。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 + marker.length });
		});

		// 检查退格删除标记后，撤销恢复标记的存储文本；这里不通过提交验证正文，因此正文映射的恢复另由后续测试覆盖。
		it("undo restores marker after backspace deletion", () => {
			// 创建独立编辑器与撤销栈。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 输入 A。
			editor.handleInput("A");
			// 登记20行大粘贴并插入标记。
			pasteWithMarker(editor);
			// 在后面输入 B。
			editor.handleInput("B");

			// 保存删除之前的整条含标记文本，作为撤销后的比较基准。
			const textBefore = editor.getText();

			// Position after marker
			// 回到行首。
			editor.handleInput("\x01");
			// 向右跨过 A。
			editor.handleInput("\x1b[C"); // past A
			// 向右跨过标记，停在其后面。
			editor.handleInput("\x1b[C"); // past marker

			// Delete marker
			// 退格删除整个标记，并记录删除前的可撤销状态。
			editor.handleInput("\x7f");
			// 先确认删除实际发生，只剩 AB。
			assert.strictEqual(editor.getText(), "AB");

			// Undo
			// Ctrl+- 撤销最近这次退格。
			editor.handleInput("\x1b[45;5u");
			// 确认含标记文本与删除前完全一致。
			assert.strictEqual(editor.getText(), textBefore);
		});

		// 进一步检查撤销恢复真实粘贴登记：删除后撤销，再提交，接收的必须是原12行正文而不是标记字面量。
		it("undo after paste marker deletion restores the paste registry", () => {
			// 创建独立编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// let 保存随后提交回调写入的结果；初始空串用于区分回调尚未提供正文的情况。
			let submitted = "";
			// 安装同步提交回调；参数 t 由 onSubmit 类型推断为字符串，返回 void，不发送给模型或网络。
			editor.onSubmit = (t) => {
				// 用提交值覆盖外层变量，供下面断言观察。
				submitted = t;
			};

			// 生成 alpha0 到 alpha11 的12行正文。
			const paste = bigPaste("alpha");
			// 通过括号粘贴插入，让编辑器生成短标记并保存正文。
			editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
			// 光标在标记之后，退格删除标记及对应正文登记。
			editor.handleInput("\x7f"); // delete the marker
			// 撤销恢复文本、光标、粘贴 Map 及编号计数这些快照内容。
			editor.handleInput("\x1b[45;5u"); // undo: restores marker text and registry
			// 回车触发提交：先按登记展开标记，再 trim 并清空编辑状态，最后调用上面的回调。
			editor.handleInput("\r");
			// 本例正文没有首尾空白，因此提交结果应与生成的12行完全相同；这不意味着提交会保留任意首尾空白。
			assert.strictEqual(submitted, paste);
		});

		// 检查删除两条标记中的第一条会重编号第二条，撤销必须一并恢复两份正文映射，提交时仍按文本顺序展开。
		it("undo after deleting the first of two paste markers restores both registry entries", () => {
			// 创建独立编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 保存将来的提交结果。
			let submitted = "";
			// 安装只记录字符串的提交回调，不做外部 I/O。
			editor.onSubmit = (t) => {
				// 将回调参数写入外层变量。
				submitted = t;
			};

			// 生成可区分的 alpha 正文 A。
			const pasteA = bigPaste("alpha");
			// 生成 beta 正文 B。
			const pasteB = bigPaste("beta");
			// 先粘贴 A，登记为 ID 1。
			editor.handleInput(`\x1b[200~${pasteA}\x1b[201~`); // #1 = A
			// 再粘贴 B，登记为 ID 2；文本顺序是标记1紧接标记2。
			editor.handleInput(`\x1b[200~${pasteB}\x1b[201~`); // #2 = B, cursor at end
			// 回到整条存储行开头。
			editor.handleInput("\x01"); // Ctrl+A
			// 一次右移越过第一条标记，定位其后边界。
			editor.handleInput("\x1b[C"); // right over marker #1
			// 退格删除标记1；实际实现还把原登记2及其文字编号降为1。
			editor.handleInput("\x7f"); // delete marker #1, renumbers #2 -> #1
			// 撤销这次删除及重编号，恢复两条标记原来的登记对应关系。
			editor.handleInput("\x1b[45;5u"); // undo
			// 提交时展开恢复的两条标记。
			editor.handleInput("\r");
			// 断言 A 正文直接拼 B 正文，中间没有额外添加换行；每份正文自身含11个分隔换行。
			assert.strictEqual(submitted, pasteA + pasteB);
		});

		// 检查文本顺序为3、2、1时，删除 ID 1 后仍按数值 ID 升序搬移注册项，避免先移动3覆盖尚未保存的2。
		it("renumbers the paste registry in ascending id order when markers are out of order in text", () => {
			// 新建编辑器，初始登记表为空。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 准备记录提交内容。
			let submitted = "";
			// 安装同步记录回调。
			editor.onSubmit = (t) => {
				// 将本次提交字符串写入外层变量。
				submitted = t;
			};

			// 生成 A 的12行 alpha 正文。
			const pasteA = bigPaste("alpha");
			// 生成 B 的12行 beta 正文。
			const pasteB = bigPaste("beta");
			// 生成 C 的12行 gamma 正文。
			const pasteC = bigPaste("gamma");
			// 先插入 A，得到 ID 1。
			editor.handleInput(`\x1b[200~${pasteA}\x1b[201~`); // #1 = A
			// 把光标移到已有标记前面。
			editor.handleInput("\x01"); // Ctrl+A
			// 在前面插入 B，虽然它得到 ID 2，文本顺序却变成2、1。
			editor.handleInput(`\x1b[200~${pasteB}\x1b[201~`); // #2 = B, text: [#2][#1]
			// 再次返回行首，准备第三次前插。
			editor.handleInput("\x01"); // Ctrl+A
			// 插入 C，得到 ID 3，存储顺序为3、2、1。
			editor.handleInput(`\x1b[200~${pasteC}\x1b[201~`); // #3 = C, text: [#3][#2][#1]
			// Ctrl+E 到整个逻辑行末尾，即 ID 1 之后。
			editor.handleInput("\x05"); // Ctrl+E
			// 退格删除尾部 ID 1；注册表先把2移到1再把3移到2，与文本中3在2前面的顺序无关。
			editor.handleInput("\x7f"); // delete marker #1, renumber #3 -> #2 and #2 -> #1
			// 提交剩余两条标记，按文本顺序展开。
			editor.handleInput("\r");
			// 确认收到 C 接 B；若重编号覆盖了正文映射，结果会在这里与预期不同。
			assert.strictEqual(submitted, pasteC + pasteB);
		});

		// 检查 setText 清掉当前粘贴登记之后，撤销还能恢复旧标记及其正文，提交仍能展开。
		it("undo after setText restores paste markers and registry", () => {
			// 创建独立编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 保存提交结果。
			let submitted = "";
			// 安装同步提交记录回调。
			editor.onSubmit = (t) => {
				// 把收到的正文写入外层变量。
				submitted = t;
			};

			// 生成12行 alpha 正文。
			const paste = bigPaste("alpha");
			// 粘贴生成有效标记。
			editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
			// 整体替换为 replacement；内容不同，因此 setText 先保存撤销快照，再清粘贴表并换文。
			editor.setText("replacement");
			// 撤销整体替换，恢复原存储标记及对应注册表。
			editor.handleInput("\x1b[45;5u"); // undo
			// 回车提交展开后的内容。
			editor.handleInput("\r");
			// 检查收到原始 alpha 正文，验证恢复的不只是标记外形。
			assert.strictEqual(submitted, paste);
		});

		// 检查同一行内两条有效标记之间有一个空格时，右箭头分别把两条标记作为各自的原子单位。
		it("handles multiple paste markers in same line", () => {
			// 创建独立编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 插入第一个20行粘贴标记。
			pasteWithMarker(editor);
			// 在两条标记之间插入普通空格。
			editor.handleInput(" ");
			// 插入第二个标记，真实内容单独登记。
			pasteWithMarker(editor);

			// 读取含两条标记的单行存储文本。
			const text = editor.getText();
			// matchAll 需要带 g 的正则，返回各次匹配的迭代器；... 将它展开成数组，每个元素的 [0] 是整条标记。
			const markers = [...text.matchAll(/\[paste #\d+ \+\d+ lines\]/g)];
			// 先确认匹配到两条标记，后面才依据这两项计算位置。
			assert.strictEqual(markers.length, 2);

			// Go to start
			// 回到逻辑行开头。
			editor.handleInput("\x01");

			// Right arrow: should skip first marker atomically
			// 一次右箭头跨过第一条完整标记。
			editor.handleInput("\x1b[C");
			// 确认偏移等于第一条标记长度；! 只消除数组项可能不存在的静态类型，不是这里的运行时保护。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: markers[0]![0].length });

			// Right arrow: past space
			// 再右移一次跨过两标记之间的一个空格。
			editor.handleInput("\x1b[C");
			// 当前位置为首标记长度加1。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: markers[0]![0].length + 1 });

			// Right arrow: should skip second marker atomically
			// 第三次右移跨过第二条完整标记。
			editor.handleInput("\x1b[C");
			// 同时检查逻辑行与完整行内偏移。
			assert.deepStrictEqual(editor.getCursor(), {
				// 所有内容仍处在逻辑行0；标记代表的正文换行没有直接存入此行。
				line: 0,
				// 首标记长度加空格1加次标记长度，就是最终的行内 UTF-16 偏移。
				col: markers[0]![0].length + 1 + markers[1]![0].length,
			});
		});

		// 检查手输的标记外形在 ID 没有登记时保持普通文字，右箭头不会把它整体跳过。
		it("does not treat manually typed marker-like text as atomic (no valid paste ID)", () => {
			// 使用未粘贴过的新编辑器，确保注册表里没有 ID 99。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// Type text that matches the pattern but was typed manually (no paste entry)
			// 固定字面量长得像粘贴标记，但这里只是待输入文本，没有对应正文登记。
			const fakeMarker = "[paste #99 +5 lines]";
			// for...of 依次取字符串码点并输入；此处全为 ASCII，每次输入一个普通字符，不走括号粘贴分支。
			for (const ch of fakeMarker) editor.handleInput(ch);

			// 确认手输结果与原字面量完全一致。
			assert.strictEqual(editor.getText(), fakeMarker);

			// No paste with ID 99 exists, so the marker is NOT treated atomically.
			// Right arrow should move one grapheme at a time.
			// 回到行首。
			editor.handleInput("\x01"); // Ctrl+A
			// 向右移动一个普通字素。
			editor.handleInput("\x1b[C"); // Right
			// 确认仅跨过左方括号到偏移1。此例只覆盖未登记 ID；若同形文字使用已登记 ID，实际分段也可能把它当作有效标记。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 }); // Just past "["
		});

		// 检查标记比编辑器渲染宽度更长时，render 能拆分显示片段，并保证此例各返回行不超过8格。
		it("does not crash when paste marker is wider than terminal width", () => {
			// Reproduce: terminal width 8, paste marker "[paste #1 +47 lines]" (21 chars)
			// 创建默认尺寸的虚拟终端；窄宽度由后续 render(8) 指定，不是真实终端宽度变化。
			const tui = createTestTUI();
			// 建立使用虚拟宿主的编辑器。
			const editor = new Editor(tui, defaultEditorTheme);
			// 构造47行正文，去掉最后换行；会采用行数标记。
			const bigContent = "line\n".repeat(47).trimEnd();
			// 模拟整次括号粘贴。
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);

			// 读取短标记所在的存储文本。
			const text = editor.getText();
			// 尝试提取行数标记，结果可能是匹配数组或 null。
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/);
			// assert.ok 在运行时要求匹配存在，失败立即抛断言错误，也让 TypeScript 在后面把 marker 收窄为非空。
			assert.ok(marker, "paste marker should be created");
			// 确认这个标记本身的可见宽度大于8，确实进入超长原子段的边界情形；上方英文的21字符计数不准确，本例正常 ID 1 标记是20个 ASCII 字符。
			assert.ok(visibleWidth(marker[0]) > 8, "marker should be wider than render width");

			// Render at very narrow width - should not throw
			// 以宽8渲染并收集字符串行；未包 assert.doesNotThrow，调用若抛错同样会直接使测试失败。
			const lines = editor.render(8);
			// Every rendered line must fit within the width (marker is split)
			// 逐条检查 render 返回的内容行、边框等所有字符串，而不是只检查存储文本。
			for (const line of lines) {
				// 对每一条输出执行布尔断言。
				assert.ok(
					// visibleWidth 按项目规则计算终端格宽，忽略样式转义，要求结果不大于8。
					visibleWidth(line) <= 8,
					// 断言说明中附实际宽度与 JSON 转义后的文本；JSON.stringify 仅构造诊断字符串，不向真实终端打印控制码。
					`line exceeds width 8: visible=${visibleWidth(line)} text=${JSON.stringify(line)}`,
				);
			}
		});

		// 复现普通前缀、长粘贴标记、普通后缀合在一行且光标停在标记起点时的宽度边界，逐行检查渲染不超过54格。
		it("does not crash when text + paste marker exceeds terminal width with cursor on marker", () => {
			// Reproduce: terminal width 54, text "b".repeat(35) + "[paste #1 +27 lines]" + "bbbb"
			// Cursor lands on the paste marker after word-wrap, causing the rendered line
			// to be 55 visible chars (1 over the width).
			// 创建虚拟终端；本测试不启动真实终端输入或输出。
			const tui = createTestTUI();
			// 创建编辑器，准备直接调用输入与渲染方法。
			const editor = new Editor(tui, defaultEditorTheme);

			// Type 35 'b' characters
			// 连续输入35个 b，模拟普通打字形成35字符前缀。
			for (let i = 0; i < 35; i++) editor.handleInput("b");

			// Paste 27 lines
			// 生成27行正文并去掉末尾换行。
			const bigContent = "line\n".repeat(27).trimEnd();
			// 括号粘贴会把这段正文登记为行数标记，插入在 b 前缀之后。
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);

			// Type a few more characters
			// 在标记后输入4个 b，形成需要保留的后缀。
			for (let i = 0; i < 4; i++) editor.handleInput("b");

			// Move cursor left to land on the paste marker
			// 向左跨过最后一个 b。
			editor.handleInput("\x1b[D"); // past last 'b'
			// 再跨过倒数第二个 b。
			editor.handleInput("\x1b[D"); // past last 'b'
			// 继续左移跨过第三个后缀字符。
			editor.handleInput("\x1b[D"); // past last 'b'
			// 跨过第四个 b，现在光标位于标记之后。
			editor.handleInput("\x1b[D"); // past last 'b'
			// 再左移一次，按原子单位跨过整条标记，光标来到它的起点。
			editor.handleInput("\x1b[D"); // now on the paste marker

			// Render at width 54 - should not throw
			// 保存本例输出宽度54，供渲染与每行断言共用。
			const renderWidth = 54;
			// 获取宽54的渲染行；在标记起点绘制光标时也必须满足行宽限制，若 render 抛错测试直接失败。
			const lines = editor.render(renderWidth);
			// 遍历全部返回行，包含文字、边框以及可能的空白补齐。
			for (const line of lines) {
				// 对当前行执行宽度断言。
				assert.ok(
					// 要求去除控制样式后的可见宽度不超过54。
					visibleWidth(line) <= renderWidth,
					// 若超宽，诊断同时给出限制、实际宽度及转义后的行内容，便于定位光标或折行导致的额外字符。
					`line exceeds width ${renderWidth}: visible=${visibleWidth(line)} text=${JSON.stringify(line)}`,
				);
			}
		});

		// 通过编辑器渲染间接覆盖 wordWrapLine 的回退折行：先在空格处分行后，剩下的普通字加标记仍超宽，必须继续检查，不能直接输出超宽结果。
		it("wordWrapLine re-checks overflow after backtracking to wrap opportunity", () => {
			// Reproduce crash #2: " " + "b".repeat(35) + atomic_marker(20 chars) + "bbbb"
			// layoutWidth=53. After wrapping at the space, the remaining 35 b's + marker = 55
			// must trigger a second force-break instead of silently overflowing.
			// 创建虚拟宿主，不会真的构造终端窗口。
			const tui = createTestTUI();
			// 创建独立编辑器。
			const editor = new Editor(tui, defaultEditorTheme);

			// Type a space, then 35 b's
			// 先放一个空格，给折行算法提供较早的可回退边界。
			editor.handleInput(" ");
			// 在空格后追加35个 b。
			for (let i = 0; i < 35; i++) editor.handleInput("b");

			// Paste 27 lines to create marker
			// 准备27行大粘贴正文。
			const bigContent = "line\n".repeat(27).trimEnd();
			// 插入实际长度20的正常行数标记；35个 b 加标记共55格，比后续布局宽53更大。
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);

			// Type trailing chars
			// 继续追加4个 b，形成需要再次处理溢出的尾部。
			for (let i = 0; i < 4; i++) editor.handleInput("b");

			// Render at width 54 (contentWidth=54, layoutWidth=53 with paddingX=0)
			// 指定返回行宽54；默认 paddingX=0 时内容宽54，内部为光标预留一格，因此折行布局宽53。
			const renderWidth = 54;
			// 调用真实 Editor.render，间接进入 wordWrapLine；这里没有单独替换折行实现。
			const lines = editor.render(renderWidth);
			// 遍历全部渲染结果。
			for (const line of lines) {
				// 逐行执行布尔断言。
				assert.ok(
					// 要求每行可见宽度最多54；本例通过外部输出观察正确性，不直接读取算法的回溯分支次数。
					visibleWidth(line) <= renderWidth,
					// 超宽时把限制、测得宽度和转义文本放入错误说明。
					`line exceeds width ${renderWidth}: visible=${visibleWidth(line)} text=${JSON.stringify(line)}`,
				);
			}
		});

		// 检查 getExpandedText 展开大粘贴时，正文中的美元替换符号保持字面值，而不是被 String.replace 当作替换模板再解释。
		it("expands large pasted content literally in getExpandedText", () => {
			// 创建独立编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 构造11行正文：前10行是编号文字，末行集中放 $1、$2、$&、$$、反引号与单引号形式的替换符号；数组整体 join 换行，超过10行阈值。
			const pastedText = [
				// 第1条普通编号行，提供确定的正文前缀。
				"line 1",
				// 第2行，与前后行用 join 添加的换行分开。
				"line 2",
				// 第3条编号行。
				"line 3",
				// 第4条编号行。
				"line 4",
				// 第5条编号行。
				"line 5",
				// 第6条编号行。
				"line 6",
				// 第7条编号行。
				"line 7",
				// 第8条编号行。
				"line 8",
				// 第9条编号行。
				"line 9",
				// 第10条编号行；加上后面的特殊符号行后总数才超过10。
				"line 10",
				// 这只是普通双引号字符串，美元符号不会在这里插值；若将它直接作为 replace 的字符串替换参数才可能被解释，因此需要展开回调按原样返回正文。
				"tokens $1 $2 $& $$ $` $' end",
			].join("\n");

			// 以括号粘贴一次输入整段11行正文，内部存储应使用短标记。
			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);

			// 先确认编辑器存储文本含行数标记，排除正文根本没有被折叠的情况。
			assert.match(editor.getText(), /\[paste #\d+ \+\d+ lines\]/);
			// getExpandedText 按登记展开而不 trim；严格比较全部正文，包含美元符号、引号和换行，确认原样恢复。
			assert.strictEqual(editor.getExpandedText(), pastedText);
		});

		// 检查向下移动的目标偏移落在有效标记内部时，光标会吸附到标记起点6，不停在内部也不跳到末尾。
		it("snaps to the paste marker start when navigating down into it", () => {
			// 创建独立编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// Line 0: long enough text to establish a sticky column
			// 设置长度20的首行、空行和带空格的 hello 前缀；光标初始在末行前缀后，偏移6。
			editor.setText("12345678901234567890\n\nhello ");

			// Create a large paste to get a marker
			// 生成2000个 x，虽然只有一行，仍超过1000个 UTF-16 码元的大粘贴阈值。
			const bigContent = "x".repeat(2000);
			// 粘贴后生成字符数形式的标记，真实2000字符保存在登记表。
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			// 用宽80建立布局，这个标记无需跨多个显示片段。
			editor.render(80);

			// 读取含标记的存储文本。
			const text = editor.getText();
			// 提取字符数标记；_marker 变量后面没有使用，匹配与非空断言索引仍会执行，匹配失败仍会抛错。
			const _marker = text.match(/\[paste #\d+ \d+ chars\]/)![0];
			// Line 0: "12345678901234567890"
			// Line 1: "" (empty)
			// Line 2: "hello [paste #1 2000 chars]"
			//         marker starts at col 6

			// Navigate to line 0, col 10
			// 从末行向上到空行。
			editor.handleInput("\x1b[A"); // Up to line 1
			// 继续向上到首行。
			editor.handleInput("\x1b[A"); // Up to line 0
			// Ctrl+A 回首行起点，清除刚才移动的偏移目标。
			editor.handleInput("\x01"); // Ctrl+A (start of line)
			// 右移10次，准备落入末行标记内部的目标10。
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C"); // Right 10
			// 确认起点为第0行偏移10。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });

			// Down to empty line
			// 下移到空行，实际光标夹为0。
			editor.handleInput("\x1b[B");
			// 确认中间空行坐标。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			// Down to paste marker line - sticky col 10 falls inside marker (starts at col 6).
			// Cursor should snap to start of marker (col 6), not end (col 6 + marker.length).
			// 继续下移到标记行，按目标10先算出标记内部的位置，实际移动逻辑再把它吸附到完整标记起点。
			editor.handleInput("\x1b[B");
			// 断言最终为第2行偏移6，也就是 hello 加空格的长度，不是目标10或标记末尾。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 6 });
		});

		// 检查经过整条粘贴标记与空行时，吸附不应丢掉原来的目标10；抵达后面的普通长行后应恢复10。
		it("preserves sticky column when navigating through paste marker line", () => {
			// 创建30列、24行虚拟终端。
			const tui = createTestTUI(30, 24);
			// 建立使用此宿主的编辑器。
			const editor = new Editor(tui, defaultEditorTheme);

			// Build:
			// Line 0: "1234567890123456" (16 chars)
			// Line 1: "" (empty)
			// Line 2: "[paste #1 2000 chars]" (22 chars, paste marker)
			// Line 3: "" (empty)
			// Line 4: "abcdefghijklmnop" (16 chars)
			// 逐字符输入长度16的首行数字，未使用文件或补全功能。
			for (const ch of "1234567890123456") editor.handleInput(ch);
			// 换行进入空的第二逻辑行。
			editor.handleInput("\n");
			// 再换行进入第2行，给中间标记留出独立逻辑行。
			editor.handleInput("\n");
			// 插入2000个 x 的大粘贴标记；正常 ID 1 的字符数标记长度为21，上方英文的22不准确，但在宽29内容布局内仍放得下。
			editor.handleInput(`\x1b[200~${"x".repeat(2000)}\x1b[201~`);
			// 在标记之后换行。
			editor.handleInput("\n");
			// 再换行，留出另一条空行。
			editor.handleInput("\n");
			// 逐字符输入长度16的末行字母；总共形成首行、空行、标记行、空行、末行。
			for (const ch of "abcdefghijklmnop") editor.handleInput(ch);
			// 以宽30渲染，内容布局宽29，标记是一个显示片段，不会在这里拆分。
			editor.render(30);

			// Navigate to line 0, col 10
			// 连续上移4次，从末行经过固定的三个中间逻辑行到首行；本例各逻辑行都只占一显示片段。
			for (let i = 0; i < 4; i++) editor.handleInput("\x1b[A"); // Up to line 0
			// Ctrl+A 回首行开头并清除准备动作留下的目标。
			editor.handleInput("\x01"); // Ctrl+A
			// 右移10次。
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C");
			// 确认目标起点为第0行偏移10。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });

			// Down to empty line - sticky col 10 established
			// 下移到第一个空行，目标10被保留，实际坐标夹到0。
			editor.handleInput("\x1b[B");
			// 检查第1行偏移0。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			// Down to paste marker - cursor snapped to col 0 (start of marker)
			// 再下移到标记行，目标10落在标记内部，光标吸到整条标记的起点0。
			editor.handleInput("\x1b[B");
			// 确认第2行的实际坐标0；实现另外保存吸附前的位置供下一步导航使用。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 0 });

			// Down to empty line
			// 继续下移离开标记行，进入后面的空行。
			editor.handleInput("\x1b[B");
			// 确认位于第3行偏移0。
			assert.deepStrictEqual(editor.getCursor(), { line: 3, col: 0 });

			// Down to last line - should restore sticky col 10
			// 再下移到足够长的普通末行，目标10现在可被容纳。
			editor.handleInput("\x1b[B");
			// 确认最终恢复到第4行偏移10，标记起点0没有覆盖原移动意图。
			assert.deepStrictEqual(editor.getCursor(), { line: 4, col: 10 });
		});

		// 检查一条标记被折成多个显示片段时，目标落在尾片的普通正文上应能正常抵达，并能向上往返，不会反复吸回标记起点。
		it("does not get stuck moving down from a multi-visual-line paste marker", () => {
			// 创建宽20的虚拟终端，内部内容布局宽19。
			const tui = createTestTUI(20, 24);
			// 创建独立编辑器。
			const editor = new Editor(tui, defaultEditorTheme);

			// Build:
			// Logical line 0: "abcdefgh" + marker(21 chars) + "ijklmnopqr"
			// Logical line 1: "123456789012345678"
			//
			// Marker "[paste #1 +100 lines]" (21 chars) is wider than the
			// terminal (20). Word-wrap splits at the space before "lines",
			// producing:
			//   VL1: abcdefgh              (startCol 0,  len 8)
			//   VL2: [paste #1 +100        (startCol 8,  len 15) <- marker head
			//   VL3: lines]ijklmnopqr      (startCol 23, len 16) <- marker tail + content
			//   VL4: 123456789012345678    (line 1)
			//
			// On VL3 the marker tail "lines]" occupies visual cols 0-5.
			// Content ("i") starts at visual col 6 = logical col 29.
			// 逐字输入8字符前缀 abcdefgh。
			for (const ch of "abcdefgh") editor.handleInput(ch);
			// 生成100行正文，得到长度21的正常行数标记，超过当前显示宽度。
			const bigContent = "line\n".repeat(100).trimEnd();
			// 通过括号粘贴登记正文并插入标记。
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			// 在标记后追加10字符 ijklmnopqr，便于测试尾片中的普通正文落点。
			for (const ch of "ijklmnopqr") editor.handleInput(ch);
			// 换行，创建下一条逻辑行。
			editor.handleInput("\n");
			// 逐字输入18个数字，作为后续可导航的普通行。
			for (const ch of "123456789012345678") editor.handleInput(ch);
			// 按宽20生成布局；此固定文本会形成前缀片、标记头片、含标记尾与后缀的片、下一逻辑行片。
			editor.render(20);

			// 读取完整存储文本，里面仍是标记而不是100行正文。
			const text = editor.getText();
			// 匹配行数标记，尾部 ] 在这种正则位置可直接作为字面字符；没有 g，只取首次匹配。
			const markerMatch = text.match(/\[paste #\d+ \+\d+ lines]/);
			// 运行时确认匹配存在，也为后面对匹配数组的访问收窄类型。
			assert.ok(markerMatch, "paste marker should be created");
			// 读取标记实际 UTF-16 长度，本例应为21；这里本身仅赋值，精确边界稍后参与光标断言。
			const markerLen = markerMatch[0].length; // 21
			// 确认标记宽于20，保证确实覆盖跨显示片段的情形；本例标记是纯 ASCII，所以 .length 与可见宽度相同。
			assert.ok(markerLen > 20, "marker should be wider than terminal");
			// 前缀8字符决定标记的起点偏移8。
			const markerStart = 8;
			// 起点加完整标记长度得到排除式末尾29，也是后缀 i 的起点。
			const markerEnd = markerStart + markerLen; // 29

			// Navigate to line 0, col 6 (on "g"). Preferred col 6 is past the
			// marker tail on VL3, so the cursor should land on content ("i" at
			// col 29) without snapping back.
			// 先向上进入逻辑行0的最后显示片段。
			editor.handleInput("\x1b[A"); // Up to line 0
			// Ctrl+A 直接到该逻辑行开头，不只是当前显示片段开头。
			editor.handleInput("\x01"); // Ctrl+A (start of line)
			// 右移6次，定位到前缀 g 的起点偏移6。
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // Right to col 6
			// 确认起点坐标。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });

			// Down: cursor lands on paste marker start
			// 第一次下移进入标记头显示片段，按目标6算出的落点在标记内部，因此吸到完整标记起点8。
			editor.handleInput("\x1b[B");
			// 检查吸附后的坐标仍在逻辑行0，偏移8。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: markerStart });

			// Down again: preferred col 6 lands at VL3 col 29 ("i"), which is
			// past the marker. Cursor stays on line 0.
			// 第二次下移时，保存的吸附前位置恢复片内目标6；尾片从逻辑偏移23开始，23加6为29，正好越过标记落到普通后缀 i。
			editor.handleInput("\x1b[B");
			// 检查仍在逻辑行0，尚未跳到下一逻辑行。
			assert.strictEqual(editor.getCursor().line, 0);
			// 确认偏移为 markerEnd，也就是29，而不是再次吸回8。
			assert.strictEqual(editor.getCursor().col, markerEnd); // col 29 = "i"

			// Up: back to paste marker
			// 向上回到标记头所在片段，目标落在标记内部时再次吸附到其起点。
			editor.handleInput("\x1b[A");
			// 检查坐标为逻辑行0、标记起点8。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: markerStart });

			// Up again: back to col 6 ("g")
			// 继续上移到前缀显示片段。
			editor.handleInput("\x1b[A");
			// 确认恢复起始偏移6，完成这个固定布局的往返检查。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });
		});

		// 换用目标3检查另一分支：它落在标记尾片内部时，向下移动应跳过续片到下一逻辑行，避免吸回标记起点而卡住。
		it("skips marker continuation VLs when preferred col falls in marker tail", () => {
			// 使用20列虚拟终端重建同样的跨片布局。
			const tui = createTestTUI(20, 24);
			// 创建独立编辑器，不继承上一例的吸附记录。
			const editor = new Editor(tui, defaultEditorTheme);

			// Same layout. Start at col 3 ("d"). Preferred col 3 maps to VL3
			// visual col 3 which is inside the "lines]" marker tail.
			// moveToVisualLine detects the continuation VL and skips to VL4
			// (line 1).
			//   VL1: abcdefgh              (startCol 0,  len 8)
			//   VL2: [paste #1 +100        (startCol 8,  len 15) <- marker head
			//   VL3: lines]ijklmnopqr      (startCol 23, len 16) <- marker tail + content
			//   VL4: 123456789012345678    (line 1)
			// 逐字输入8字符前缀。
			for (const ch of "abcdefgh") editor.handleInput(ch);
			// 构造100行正文，产生长度21的标记。
			const bigContent = "line\n".repeat(100).trimEnd();
			// 登记并插入此大粘贴。
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			// 追加普通后缀 ijklmnopqr，标记尾片同时含这些正文。
			for (const ch of "ijklmnopqr") editor.handleInput(ch);
			// 换到下一逻辑行。
			editor.handleInput("\n");
			// 输入18字符数字行，为跨过标记续片提供可用的后继显示片段。
			for (const ch of "123456789012345678") editor.handleInput(ch);
			// 渲染宽20，建立与上例相同的显示片段映射。
			editor.render(20);

			// Navigate to line 0, col 3 (on "d")
			// 先向上进入逻辑行0的最后片段。
			editor.handleInput("\x1b[A"); // Up to line 0
			// Ctrl+A 返回整个逻辑行的开头。
			editor.handleInput("\x01"); // Ctrl+A
			// 右移3次，定位到前缀 d 前面的偏移3。
			for (let i = 0; i < 3; i++) editor.handleInput("\x1b[C");
			// 确认起始逻辑坐标。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

			// Down: marker
			// 下移到标记头片，目标3落在有效标记内部，实际光标吸附到起点8。
			editor.handleInput("\x1b[B");
			// 这里只检查偏移8，没有同时断言行号。
			assert.strictEqual(editor.getCursor().col, 8);

			// Down: skips VL3 (col 3 in marker tail) and lands on line 1
			// 继续向下，目标3会落入从23开始的尾片标记部分；实现检测到正在向下进入续片，跳到整个标记之后的首个可用显示片段，即下一逻辑行。
			editor.handleInput("\x1b[B");
			// 确认抵达第1行偏移3，说明既没有停在标记内部，也没有吸回其起点。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 3 });

			// Round-trip back
			// 向上回到含标记尾的显示片段；向上不会走向下跳过续片的分支，因此吸附到整个标记起点。
			editor.handleInput("\x1b[A");
			// 检查实际偏移8，断言本身没有读取保存的吸附前位置。
			assert.strictEqual(editor.getCursor().col, 8); // marker
			// 再向上从标记起点回到前缀片段。
			editor.handleInput("\x1b[A");
			// 确认最终回到逻辑行0偏移3，证明本例往返能恢复初始位置。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
		});

		// 检查回车提交时也原样展开含美元替换符号的大粘贴；正文无首尾空白，所以提交的 trim 不改变本例预期。
		it("submits large pasted content literally", () => {
			// 创建独立编辑器。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 准备11行正文数组，前10行编号、末行包含 String.replace 的特殊美元写法，最后 join 换行；这个规模触发行数标记。
			const pastedText = [
				// 正文第1行。
				"line 1",
				// 正文第2行。
				"line 2",
				// 正文第3行。
				"line 3",
				// 正文第4行。
				"line 4",
				// 正文第5行。
				"line 5",
				// 正文第6行。
				"line 6",
				// 正文第7行。
				"line 7",
				// 正文第8行。
				"line 8",
				// 正文第9行。
				"line 9",
				// 正文第10行，尚未超过10行阈值，后面的特殊符号行才使总数达到11。
				"line 10",
				// 特殊符号都处在普通字符串中；预期它们在展开与提交之后仍保持字面值，不被替换为捕获组、匹配正文或前后文。
				"tokens $1 $2 $& $$ $` $' end",
			].join("\n");
			// 外层 let 变量保存提交回调结果，初始为空。
			let submitted = "";
			// 安装同步 onSubmit 回调；text 的字符串类型从属性签名推断，回调只记录结果，不会调用模型。
			editor.onSubmit = (text) => {
				// 把收到的提交字符串写入外层变量。
				submitted = text;
			};

			// 通过括号粘贴生成短标记并登记11行正文。
			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);
			// 回车触发展开、trim、清空状态与提交回调；这不是调用外部命令。
			editor.handleInput("\r");

			// 严格比较完整提交结果与原正文，检查换行、美元符号和引号全部正确；此单一例子不证明任意嵌套标记正文都不会级联展开。
			assert.strictEqual(submitted, pastedText);
		});
	});
});
