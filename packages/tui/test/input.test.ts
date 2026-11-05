// 验证单行Input的输入/提交、水平窗口、删除记录环与撤销；直接调用内存组件，不启动TUI、真实终端、系统剪贴板或外部编辑器。
// 导入Node断言，strictEqual严格比较值；失败抛出，使所在同步测试失败。
import assert from "node:assert";
// describe/it注册分组和同步用例，本文件没有定时等待或异步系统操作。
import { describe, it } from "node:test";
// 导入真实Input实现；构造创建自己的删除环/撤销栈，按键动作使用共享默认键位管理器。
import { Input } from "../src/components/input.ts";
// 剥控制码和计算终端列宽的字符串工具；列宽不同于UTF-16字符串长度，工具不写终端。
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";

// 每个用例都新建Input，编辑值/光标/删除环/撤销栈彼此独立；这不是完整宿主输入分发测试。
describe("Input component", () => {
	// 逐字输入hello和反斜杠后送CR，要求onSubmit收到完整hello反斜杠；单行组件不把反斜杠+回车当续行，不实际执行命令。
	it("submits value including backslash on Enter", () => {
		// 创建空值/光标0的新实例，未挂载宿主。
		const input = new Input();
		// 提交记录初为undefined，string|undefined是静态联合类型，回调之后才可能有值。
		let submitted: string | undefined;

		// 注册提交回调，输入当前完整字符串、无显式返回；只写局部记录，异常会同步传播，赋值此刻不提交。
		input.onSubmit = (value) => {
			// 保存本次提交值，不清输入框或发模型请求。
			submitted = value;
		};

		// Type hello, then backslash, then Enter
		// 输入h，光标随插入到1，开启连续普通词输入链。
		input.handleInput("h");
		// 插入e，形成he并沿用同一输入链。
		input.handleInput("e");
		// 插入第一个l，形成hel。
		input.handleInput("l");
		// 插入第二个l，形成hell，重复字母不能被丢掉。
		input.handleInput("l");
		// 插入o，形成hello。
		input.handleInput("o");
		// 字符串字面量内连续两个反斜杠表示运行时一个反斜杠，Input将它作为普通文字加入。
		input.handleInput("\\");
		// CR匹配默认提交动作，只调用onSubmit，不追加换行或自动去掉反斜杠。
		input.handleInput("\r");

		// Input is single-line, no backslash+Enter workaround
		// 提交记录必须含最后一个实际反斜杠；预期字面量末尾用两个反斜杠写出一个实际反斜杠。
		assert.strictEqual(submitted, "hello\\");
	});

	// 只输入反斜杠再输入x，要求正文为反斜杠+x；证明它不是运行时字符串转义开关，也不触发快捷命令。
	it("inserts backslash as regular character", () => {
		// 独立空Input，避免沿用上一测试提交回调。
		const input = new Input();

		// 先插入一个反斜杠字符。
		input.handleInput("\\");
		// 再插入x，不将已有反斜杠与x重新解释为JS源码转义。
		input.handleInput("x");

		// getValue返回原始整段值，不是屏幕窗口文本。
		assert.strictEqual(input.getValue(), "\\x");
	});

	// render组检查返回字符串的占位/列宽，所有控制码只作为数据处理，不在真实屏幕上验证光标或颜色。
	describe("render", () => {
		// 去掉默认提示前缀，用dim占位；空时检查样式和可见文字，输入n后占位消失，仅剩n；未单独检查占位回调调用次数。
		it("supports a custom prompt and styled placeholder", () => {
			// 构造选项对象，字段会在Input构造时保存。
			const input = new Input({
				// 空prompt是显式配置，不会因假值回退默认>空格。
				prompt: "",
				// 占位文字只用于空值显示，不写入getValue。
				placeholder: "Find transcript",
				// 样式回调输入片段、返回SGR2弱化强度后SGR22恢复的串，无I/O；构造只存函数，render时才执行。
				placeholderStyle: (text) => `\x1b[2m${text}\x1b[22m`,
			});
			// 设置焦点标志，使渲染输出零宽光标定位标记；不调用系统聚焦API。
			input.focused = true;

			// 数组解构拿唯一行，以20终端列为宽度生成内存结果。
			const [empty] = input.render(20);
			// 可选链缺行得undefined，ok仍会失败；有行时要求包含dim开启码。
			assert.ok(empty?.includes("\x1b[2m"));
			// 剥控制码再去尾padding，比较真实占位文字；??仅在缺行时回退空串。
			assert.strictEqual(stripTerminalSequences(empty ?? "").trimEnd(), "Find transcript");

			// 输入n成为实际值，空值占位分支不应再显示。
			input.handleInput("n");
			// 再次渲染并解构新的唯一行。
			const [populated] = input.render(20);
			// 去控制码/尾空白后仅n，不能混入旧Find transcript。
			assert.strictEqual(stripTerminalSequences(populated ?? "").trimEnd(), "n");
		});

		// 四种宽字符文本分别在起点/右移十字素/末尾状态渲染，要求估计列宽≤93；这里只检查这些样例，不证明任意Unicode/任意宽度都安全。
		it("does not overflow with wide CJK and fullwidth text", () => {
			// 统一93列总宽，包含默认提示前缀，不是93个UTF-16单元。
			const width = 93;
			// 待测文本数组，不访问翻译或网络服务。
			const cases = [
				// 韩文与普通空格混合的长串，典型音节占两列。
				"가나다라마바사아자차카타파하 한글 텍스트가 터미널 너비를 초과하면 크래시가 발생합니다 이것은 재현용 테스트입니다",
				// 日文汉字/假名与标点的长串。
				"これはテスト文章です。日本語のテキストが正しく表示されるかどうかを確認するためのサンプルテキストです。あいうえお",
				// 中文与中文标点长串。
				"这是一段测试文本，用于验证中文字符在终端中的显示宽度是否被正确计算，如果不正确就会导致用户界面崩溃的问题",
				// 全角拉丁字母与数字，不能按ASCII一列估宽。
				"ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ０１２３４５６７８９ａｂｃｄｅｆｇｈｉｊｋｌｍ",
			];
			// 每个定位策略包含诊断标签和真正执行的move回调，随后与每条文本组合测试。
			const cursorPositions = [
				// start回调忽略参数且不移动；之所以在开头，是新实例cursor0经setValue后仍为0，不是setValue自动移末尾。
				{ label: "start", move: (_input: Input) => {} },
				// middle定位策略对象，名字只是标签，不保证移动到全文数学中点。
				{
					// 标签只用于失败信息，实际操作由下一回调决定。
					label: "middle",
					// 接Input并同步右移十次，无返回；只改该实例光标、打断输入链，不写终端。
					move: (input: Input) => {
						// for循环10次，每个右箭头按完整字素前进，不是固定走一个显示列。
						for (let i = 0; i < 10; i++) input.handleInput("\x1b[C");
					},
				},
				// end回调用Ctrl+E移到value.length末尾，指令编码只作为测试数据。
				{ label: "end", move: (input: Input) => input.handleInput("\x05") },
			];

			// 外层逐条取文本，不改cases数组。
			for (const text of cases) {
				// 内层解构标签/回调，每条文本有三种独立定位。
				for (const { label, move } of cursorPositions) {
					// 每种组合新建Input，防止光标位置串到下次组合。
					const input = new Input();
					// 保存文本，初始cursor仍为0；setValue只夹住旧下标上限，不自动移到末尾。
					input.setValue(text);
					// 让渲染包含光标定位标记，不接管真实焦点。
					input.focused = true;
					// 此行才真正调用定位策略，注册策略对象时未执行。
					move(input);

					// 获取单行渲染结果，水平窗口应以当前光标附近为中心或贴边。
					const [line] = input.render(width);
					// 先要求行存在且非空，给下一宽度断言一个有效字符串。
					assert.ok(line);
					// 控制码零宽，visibleWidth含实际提示/正文/光标占位；失败消息带文本与策略标签，不比较完整输出。
					assert.ok(visibleWidth(line) <= width, `rendered line overflowed for ${text} at ${label}`);
				}
			}
		});

		// 韩文长串移到第五字素后渲染20列；原标题说cursor visible，实际只断行存在且不超宽，没有直接断光标标记位置或具体可见片段。
		it("keeps the cursor visible when horizontally scrolling wide text", () => {
			// 独立Input，不复用上面定位组合。
			const input = new Input();
			// 缩小总宽到20列，触发水平窗口。
			const width = 20;
			// 全韩文输入总显示列数超过可用正文宽度。
			const text = "가나다라마바사아자차카타파하";
			// 设置值但保持初始开头光标。
			input.setValue(text);
			// 请求带焦点标记的显示。
			input.focused = true;
			// 显式Ctrl+A归到开头，也打断此前编辑链。
			input.handleInput("\x01");
			// 右移五个字素；韩文字素通常各占两列，不能说右移五列。
			for (let i = 0; i < 5; i++) input.handleInput("\x1b[C");

			// 生成当前水平窗口行。
			const [line] = input.render(width);
			// 确认有返回行。
			assert.ok(line);
			// 仅验证估计宽度≤20，不能单靠这个条件证明光标总可见。
			assert.ok(visibleWidth(line) <= width);
		});
	});

	// 删除记录环kill ring保存成段删掉的文字，yank粘回、yank-pop轮换；全在Input实例内，和系统剪贴板无关。
	describe("Kill ring", () => {
		// 末尾Ctrl+W删baz，行首Ctrl+Y应粘回baz在剩余正文前；用正文结果间接验证删文保存和插入位置，无系统复制。
		it("Ctrl+W saves deleted text to kill ring and Ctrl+Y yanks it", () => {
			// 新实例自带空删除环。
			const input = new Input();

			// 设置三个词，光标仍在初始0。
			input.setValue("foo bar baz");
			// Move cursor to end
			// Ctrl+E明确移末尾，后续Ctrl+W才有左侧词可删。
			input.handleInput("\x05"); // Ctrl+E

			// 向后词边界删baz并存入环，尾前空格保留。
			input.handleInput("\x17"); // Ctrl+W - deletes "baz"
			// 要求留下foo bar及末尾空格。
			assert.strictEqual(input.getValue(), "foo bar ");

			// Move to beginning and yank
			// Ctrl+A移行首，不改变正文或清空删除环。
			input.handleInput("\x01"); // Ctrl+A
			// Ctrl+Y取环尾baz插入当前光标，不自动加空格。
			input.handleInput("\x19"); // Ctrl+Y
			// 得到bazfoo bar，原剩余末空格也保留。
			assert.strictEqual(input.getValue(), "bazfoo bar ");
		});

		// 句点/冒号是ASCII词内边界，末尾向后删词只删bar，不一起吞标点；两段独立输入复用同一实例但显式移动打断kill累积。
		it("Ctrl+W preserves ASCII punctuation boundaries", () => {
			// 创建待测Input。
			const input = new Input();

			// 设置foo.bar，不清空现有撤销/删除记录，本例初始为空。
			input.setValue("foo.bar");
			// 移到bar之后。
			input.handleInput("\x05"); // Ctrl+E
			// Ctrl+W按边界删bar。
			input.handleInput("\x17"); // Ctrl+W - deletes "bar"
			// 句点必须留下。
			assert.strictEqual(input.getValue(), "foo.");

			// 换冒号样例；setValue本身只更新值并夹cursor。
			input.setValue("foo:bar");
			// 再明确移末尾，同时打断上一次kill链。
			input.handleInput("\x05"); // Ctrl+E
			// 向后删除bar，不能跨冒号。
			input.handleInput("\x17"); // Ctrl+W - deletes "bar"
			// 冒号仍在正文末尾。
			assert.strictEqual(input.getValue(), "foo:");
		});

		// 按运行时Intl词分段从右往左删除中文词/标点，逐步检查六次结果；只承诺本例分段，不把Unicode分词说成固定按单字删。
		it("Ctrl+W handles Unicode word boundaries", () => {
			// 独立实例避免前例删除环参与。
			const input = new Input();

			// "你好世界。你好，世界" segments as: 你好|世界|。|你好|，|世界
			// 这段文字按当前Intl分成你好/世界/句号/你好/逗号/世界。
			input.setValue("你好世界。你好，世界");
			// 先把光标移末尾，setValue没有替它完成这一操作。
			input.handleInput("\x05"); // Ctrl+E
			// 删最后的世界。
			input.handleInput("\x17"); // Ctrl+W - deletes "世界"
			// 要求保留末尾逗号。
			assert.strictEqual(input.getValue(), "你好世界。你好，");
			// 下一次向后跨标点段，删逗号。
			input.handleInput("\x17"); // Ctrl+W - deletes "，"
			// 正文末尾现在是你好，前面的你好世界与句号仍保留。
			assert.strictEqual(input.getValue(), "你好世界。你好");
			// 再删这一词段你好。
			input.handleInput("\x17"); // Ctrl+W - deletes "你好"
			// 留下前半句与句号。
			assert.strictEqual(input.getValue(), "你好世界。");
			// 删除句号标点段。
			input.handleInput("\x17"); // Ctrl+W - deletes "。"
			// 留下最前两个词段。
			assert.strictEqual(input.getValue(), "你好世界");
			// 删除世界词段。
			input.handleInput("\x17"); // Ctrl+W - deletes "世界"
			// 剩你好。
			assert.strictEqual(input.getValue(), "你好");
			// 删最后词段你好。
			input.handleInput("\x17"); // Ctrl+W - deletes "你好"
			// 正文应为空，连续kill的累积内容在后续别例另测。
			assert.strictEqual(input.getValue(), "");
		});

		// 把光标放hello空格之后，Ctrl+U删行首六字符，Ctrl+Y在开头粘回，应恢复全文；检查删到行首的范围和环保存。
		it("Ctrl+U saves deleted text to kill ring", () => {
			// 新实例，删除环独立。
			const input = new Input();

			// 预填hello world，不产生撤销点或自动移末尾。
			input.setValue("hello world");
			// Move cursor to after "hello "
			// 归行首，明确下方右移的起点。
			input.handleInput("\x01"); // Ctrl+A
			// 六次右移经过hello五字母加空格，停在world前。
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			// Ctrl+U删除光标前hello空格，光标归0并保存删文。
			input.handleInput("\x15"); // Ctrl+U - deletes "hello "
			// 只剩world。
			assert.strictEqual(input.getValue(), "world");

			// 在新开头粘回环中的hello空格。
			input.handleInput("\x19"); // Ctrl+Y
			// 全文恢复，未额外添加或丢失空格。
			assert.strictEqual(input.getValue(), "hello world");
		});

		// 从行首Ctrl+K删整行，Ctrl+Y再粘回；正文为空和完整恢复两次断言证明当前删文保留。
		it("Ctrl+K saves deleted text to kill ring", () => {
			// 创建独立空环Input。
			const input = new Input();

			// 设置全文，光标仍开头。
			input.setValue("hello world");
			// 显式归开头，避免依赖以后setValue光标策略变化。
			input.handleInput("\x01"); // Ctrl+A
			// Ctrl+K删光标到末尾整段，光标位置保持0。
			input.handleInput("\x0b"); // Ctrl+K - deletes "hello world"

			// 当前输入值应为空。
			assert.strictEqual(input.getValue(), "");

			// 从删除环粘回完整删文。
			input.handleInput("\x19"); // Ctrl+Y
			// 得到原hello world。
			assert.strictEqual(input.getValue(), "hello world");
		});

		// 没有成段删除记录时Ctrl+Y应不改已有test；不读系统剪贴板，系统里有什么都不影响此例。
		it("Ctrl+Y does nothing when kill ring is empty", () => {
			// 新实例保证删除环为空。
			const input = new Input();

			// 直接设置test不会把它加入删除环。
			input.setValue("test");
			// 移到末尾再尝试粘回，确保若错误插入会影响可见值。
			input.handleInput("\x05"); // Ctrl+E
			// 空环yank直接返回，不创建正文变更。
			input.handleInput("\x19"); // Ctrl+Y
			// 仍恰好test。
			assert.strictEqual(input.getValue(), "test");
		});

		// 建立first/second/third三个独立记录，先yank最新third，再Alt+Y轮换到second/first/third；完整检查三次替换与循环顺序。
		it("Alt+Y cycles through kill ring after Ctrl+Y", () => {
			// 新实例有自己的环和lastAction链。
			const input = new Input();

			// Create kill ring with multiple entries
			// 先设置first作为待删文。
			input.setValue("first");
			// 行尾移动会打断之前kill链，确保后面是独立记录。
			input.handleInput("\x05"); // Ctrl+E
			// 删完整first，环尾现在first。
			input.handleInput("\x17"); // Ctrl+W - deletes "first"
			// 设置second但本方法不清环，也不主动重置lastAction。
			input.setValue("second");
			// Ctrl+E打断旧kill累积并移到second末尾。
			input.handleInput("\x05"); // Ctrl+E
			// 删second形成第二条独立记录。
			input.handleInput("\x17"); // Ctrl+W - deletes "second"
			// 再设置third作为第三次删文。
			input.setValue("third");
			// 移末尾并打断上一kill链。
			input.handleInput("\x05"); // Ctrl+E
			// 删third形成第三条独立记录。
			input.handleInput("\x17"); // Ctrl+W - deletes "third"

			// 三次全词删除后正文为空。
			assert.strictEqual(input.getValue(), "");

			// Ctrl+Y取当前环尾third并进入yank链。
			input.handleInput("\x19"); // Ctrl+Y - yanks "third"
			// 正文先为third。
			assert.strictEqual(input.getValue(), "third");

			// Alt+Y删刚粘的third，rotate后插second，不是在末尾追加。
			input.handleInput("\x1by"); // Alt+Y - cycles to "second"
			// 正文替换为second。
			assert.strictEqual(input.getValue(), "second");

			// 下一次轮换到first。
			input.handleInput("\x1by"); // Alt+Y - cycles to "first"
			// 正文仅first，不保留旧second。
			assert.strictEqual(input.getValue(), "first");

			// 第三次轮换绕回third。
			input.handleInput("\x1by"); // Alt+Y - cycles back to "third"
			// 确认完整循环后的值。
			assert.strictEqual(input.getValue(), "third");
		});

		// 虽然环里有test，但未先yank且又输入x时Alt+Y不能改otherx；验证启动轮换的前置动作要求。
		it("Alt+Y does nothing if not preceded by yank", () => {
			// 独立实例先准备删除记录。
			const input = new Input();

			// 设置待删test。
			input.setValue("test");
			// 移末尾建立明确删除范围。
			input.handleInput("\x05"); // Ctrl+E
			// 删test到删除环。
			input.handleInput("\x17"); // Ctrl+W - deletes "test"
			// 换成other但保留环中test。
			input.setValue("other");
			// 移到other末尾并打断kill链。
			input.handleInput("\x05"); // Ctrl+E

			// Type something to break the yank chain
			// 输入x把lastAction设普通词输入，而非yank。
			input.handleInput("x");
			// 检查正文先变otherx。
			assert.strictEqual(input.getValue(), "otherx");

			// Alt+Y没有yank链条件，应无操作。
			input.handleInput("\x1by"); // Alt+Y - should do nothing
			// 值维持otherx。
			assert.strictEqual(input.getValue(), "otherx");
		});

		// 只有一条删除记录时即便刚yank，Alt+Y也无其他项可轮换；检查only不被重复追加或清掉。
		it("Alt+Y does nothing if kill ring has one entry", () => {
			// 新Input保证后面只有一条环记录。
			const input = new Input();

			// 设置only。
			input.setValue("only");
			// 移末尾。
			input.handleInput("\x05"); // Ctrl+E
			// 删only为唯一删除记录。
			input.handleInput("\x17"); // Ctrl+W - deletes "only"

			// 粘回only并进入yank状态。
			input.handleInput("\x19"); // Ctrl+Y - yanks "only"
			// 当前正文恰好only。
			assert.strictEqual(input.getValue(), "only");

			// 环长度≤1，轮换立即返回。
			input.handleInput("\x1by"); // Alt+Y - should do nothing
			// 正文仍only。
			assert.strictEqual(input.getValue(), "only");
		});

		// 连续三次Ctrl+W合并为一个环条目，后删前面的词需前置拼接，Ctrl+Y一次恢复one two three；不直接读取私有环数组。
		it("consecutive Ctrl+W accumulates into one kill ring entry", () => {
			// 新实例无既有条目。
			const input = new Input();

			// 准备三个空格分隔词。
			input.setValue("one two three");
			// 移到three后，确保向后删除有效。
			input.handleInput("\x05"); // Ctrl+E
			// 先删three，建立kill链和第一段记录。
			input.handleInput("\x17"); // Ctrl+W - deletes "three"
			// 继续删two加尾空格，prepend到前次three之前。
			input.handleInput("\x17"); // Ctrl+W - deletes "two "
			// 再删one加空格，仍前置累积保持原文顺序。
			input.handleInput("\x17"); // Ctrl+W - deletes "one "

			// 正文已清空。
			assert.strictEqual(input.getValue(), "");

			// 一次yank应取合并后的完整记录，而不是仅最后删掉的one空格。
			input.handleInput("\x19"); // Ctrl+Y
			// 全文一次恢复，词顺序与空格正确。
			assert.strictEqual(input.getValue(), "one two three");
		});

		// kill后输入x打断累积，再删x应是独立条目；yank先取x，Alt+Y还可取较旧baz，证明没有合并成bazx。
		it("non-delete actions break kill accumulation", () => {
			// 新实例准备两次独立删文。
			const input = new Input();

			// 设置三个词。
			input.setValue("foo bar baz");
			// 移末尾。
			input.handleInput("\x05"); // Ctrl+E
			// 先删baz入环。
			input.handleInput("\x17"); // Ctrl+W - deletes "baz"
			// 正文剩foo bar空格。
			assert.strictEqual(input.getValue(), "foo bar ");

			// 输入x将lastAction从kill改成type-word，打断下一次kill累积。
			input.handleInput("x"); // Typing breaks accumulation
			// 正文先变foo bar x。
			assert.strictEqual(input.getValue(), "foo bar x");

			// 删x应新建环记录，不能追加到之前baz。
			input.handleInput("\x17"); // Ctrl+W - deletes "x" (separate entry)
			// 正文再次回到foo bar空格。
			assert.strictEqual(input.getValue(), "foo bar ");

			// yank最新x，建立可轮换链。
			input.handleInput("\x19"); // Ctrl+Y - most recent is "x"
			// 只恢复x，不是bazx等合并值。
			assert.strictEqual(input.getValue(), "foo bar x");

			// 轮换到旧baz，替换刚yank的x。
			input.handleInput("\x1by"); // Alt+Y - cycle to "baz"
			// 正文变foo bar baz，证明两条记录保持独立。
			assert.strictEqual(input.getValue(), "foo bar baz");
		});

		// 先yank second，再输入x应打断Alt+Y链，后续不能把secondx里的旧片段贸然替换；检查正文保持secondx。
		it("non-yank actions break Alt+Y chain", () => {
			// 新实例准备两个删除条目。
			const input = new Input();

			// first作为第一份删文。
			input.setValue("first");
			// 移末尾打断此前动作链。
			input.handleInput("\x05"); // Ctrl+E
			// 删first入环。
			input.handleInput("\x17"); // Ctrl+W
			// 再设置second。
			input.setValue("second");
			// 移末尾，确保第二次kill独立。
			input.handleInput("\x05"); // Ctrl+E
			// 删second入环。
			input.handleInput("\x17"); // Ctrl+W
			// 显式清正文，不清环；cursor被夹回0。
			input.setValue("");

			// 粘回最新second并设lastAction为yank。
			input.handleInput("\x19"); // Ctrl+Y - yanks "second"
			// 确认当前正文second。
			assert.strictEqual(input.getValue(), "second");

			// 接普通x，将lastAction改为type-word。
			input.handleInput("x"); // Breaks yank chain
			// 正文先变secondx。
			assert.strictEqual(input.getValue(), "secondx");

			// Alt+Y不再满足yank链条件，不应替换其中任何区间。
			input.handleInput("\x1by"); // Alt+Y - should do nothing
			// 正文应维持secondx。
			assert.strictEqual(input.getValue(), "secondx");
		});

		// 轮换会真实改环顺序，打断yank链并清正文后，新yank应取已经轮到环尾的second；不是每次重新从third开始。
		it("kill ring rotation persists after cycling", () => {
			// 新实例准备first/second/third三项。
			const input = new Input();

			// 设置first。
			input.setValue("first");
			// 移末尾打断链。
			input.handleInput("\x05"); // Ctrl+E
			// 删first成环记录。
			input.handleInput("\x17"); // deletes "first"
			// 设置second，旧环保留。
			input.setValue("second");
			// 移末尾确保独立kill。
			input.handleInput("\x05"); // Ctrl+E
			// 删second为新环尾。
			input.handleInput("\x17"); // deletes "second"
			// 设置third。
			input.setValue("third");
			// 移末尾。
			input.handleInput("\x05"); // Ctrl+E
			// 删third为最新环尾。
			input.handleInput("\x17"); // deletes "third"
			// 清正文并夹cursor到0，删除环仍在。
			input.setValue("");

			// 先粘最新third。
			input.handleInput("\x19"); // Ctrl+Y - yanks "third"
			// 轮换使third移环首、second成为当前环尾，并替换正文。
			input.handleInput("\x1by"); // Alt+Y - cycles to "second"
			// 检查正文已为second。
			assert.strictEqual(input.getValue(), "second");

			// Break chain and start fresh
			// 插x打断yank链，但不恢复旧环顺序。
			input.handleInput("x");
			// 清正文，给下一次yank提供空插入位置，不清环。
			input.setValue("");

			// New yank should get "second" (now at end after rotation)
			// 新的Ctrl+Y仍peek当前环尾second。
			input.handleInput("\x19"); // Ctrl+Y
			// 确认轮换顺序持久保留在本Input实例内，不是写磁盘持久化。
			assert.strictEqual(input.getValue(), "second");
		});

		// 原标题同时说前置/后置累积，实际本例只从分隔符前向前删到行末，再yank恢复；没有执行向后删或连续多次kill，不能据此单例证明两方向累积。
		it("backward deletions prepend, forward deletions append during accumulation", () => {
			// 创建Input，下面竖线属于真实正文。
			const input = new Input();

			// prefix|suffix中的|不是测试框架光标标记，而是会被删/恢复的普通字符。
			input.setValue("prefix|suffix");
			// Position cursor at "|"
			// 先归行首，让六次右移的位置确定。
			input.handleInput("\x01"); // Ctrl+A
			// 跨prefix六字母，停在真实|之前，未跳过它。
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C"); // Move right 6

			// Ctrl+K删除|suffix，作为一条向前kill保存，保留prefix。
			input.handleInput("\x0b"); // Ctrl+K - deletes "|suffix" (forward)
			// 确认只留下prefix。
			assert.strictEqual(input.getValue(), "prefix");

			// 在prefix末尾粘回原删文。
			input.handleInput("\x19"); // Ctrl+Y
			// 全文恢复，包含原本的普通竖线。
			assert.strictEqual(input.getValue(), "prefix|suffix");
		});

		// 从开头连续Alt+D删hello再删前导空格+world，向前kill后置合并，yank一次恢复；检查词边界和合并顺序。
		it("Alt+D deletes word forward and saves to kill ring", () => {
			// 新实例准备向前删词。
			const input = new Input();

			// 设置三个词，初始cursor0。
			input.setValue("hello world test");
			// 显式归行首并打断旧动作链。
			input.handleInput("\x01"); // Ctrl+A

			// 删hello，第一次kill不把后续空格一并删掉。
			input.handleInput("\x1bd"); // Alt+D - deletes "hello"
			// 正文剩前导空格+world test。
			assert.strictEqual(input.getValue(), " world test");

			// 再向前先跨空格、再跨world，删文追加到之前hello后。
			input.handleInput("\x1bd"); // Alt+D - deletes " world"
			// 留下前导空格+test。
			assert.strictEqual(input.getValue(), " test");

			// Yank should get accumulated text
			// 一次yank取得合并后的hello world。
			input.handleInput("\x19"); // Ctrl+Y
			// 拼上原有空格test恢复全部正文。
			assert.strictEqual(input.getValue(), "hello world test");
		});

		// 向前词删除需在句点前后分步停住，foo、点、bar依次删除；不把带点ASCII串一律当一个词。
		it("Alt+D preserves ASCII punctuation boundaries", () => {
			// 独立实例测试ASCII标点。
			const input = new Input();

			// 准备foo.bar后还有空格baz的样例。
			input.setValue("foo.bar baz");
			// 行首作为第一删除起点。
			input.handleInput("\x01"); // Ctrl+A
			// 先删foo，不跨句点。
			input.handleInput("\x1bd"); // Alt+D - deletes "foo"
			// 句点仍在正文开头。
			assert.strictEqual(input.getValue(), ".bar baz");
			// 第二次删当前标点段句点。
			input.handleInput("\x1bd"); // Alt+D - deletes "."
			// 留下bar baz。
			assert.strictEqual(input.getValue(), "bar baz");
			// 第三次删bar词段。
			input.handleInput("\x1bd"); // Alt+D - deletes "bar"
			// 前导空格和baz保留。
			assert.strictEqual(input.getValue(), " baz");
		});

		// 按当前Intl分词从前向后删中文词与标点，逐步检查六次结果；不保证所有语言/ICU版本的词段完全相同。
		it("Alt+D handles Unicode word boundaries", () => {
			// 独立实例，不沿用ASCII边界状态。
			const input = new Input();

			// "你好世界。你好，世界" segments as: 你好|世界|。|你好|，|世界
			// 准备与后删测试同一中文输入。
			input.setValue("你好世界。你好，世界");
			// 归开头，向前逐段删除。
			input.handleInput("\x01"); // Ctrl+A
			// 删第一个你好词段。
			input.handleInput("\x1bd"); // Alt+D - deletes "你好"
			// 正文从世界开始。
			assert.strictEqual(input.getValue(), "世界。你好，世界");
			// 删世界。
			input.handleInput("\x1bd"); // Alt+D - deletes "世界"
			// 当前开头变句号。
			assert.strictEqual(input.getValue(), "。你好，世界");
			// 删句号标点段。
			input.handleInput("\x1bd"); // Alt+D - deletes "。"
			// 留下你好逗号世界。
			assert.strictEqual(input.getValue(), "你好，世界");
			// 删下一词段你好。
			input.handleInput("\x1bd"); // Alt+D - deletes "你好"
			// 逗号仍留在当前开头。
			assert.strictEqual(input.getValue(), "，世界");
			// 删逗号。
			input.handleInput("\x1bd"); // Alt+D - deletes "，"
			// 只剩世界。
			assert.strictEqual(input.getValue(), "世界");
			// 删最后世界词段。
			input.handleInput("\x1bd"); // Alt+D - deletes "世界"
			// 正文最终为空。
			assert.strictEqual(input.getValue(), "");
		});

		// 先删word入环，再把光标放hello空格之后yank，要求插入中间且保留两侧；不自动给粘回文本追加空格。
		it("handles yank in middle of text", () => {
			// 新Input准备一个可恢复条目。
			const input = new Input();

			// 把word作为待删文。
			input.setValue("word");
			// 移末尾以便Ctrl+W删完整word。
			input.handleInput("\x05"); // Ctrl+E
			// 删word保存到环。
			input.handleInput("\x17"); // Ctrl+W - deletes "word"
			// 换新正文但保留word记录。
			input.setValue("hello world");
			// Move to middle (after "hello ")
			// 先归行首。
			input.handleInput("\x01"); // Ctrl+A
			// 右移六字素到hello空格之后。
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			// 把word插到此处，光标在插入文末，原world保持在右边。
			input.handleInput("\x19"); // Ctrl+Y
			// 预期hello空格+word+world，两词之间没有自动补的额外空格。
			assert.strictEqual(input.getValue(), "hello wordworld");
		});

		// 中间位置先yank SECOND，再yank-pop换成更短FIRST；要求两侧hello/world不受替换长度变化影响。
		it("handles yank-pop in middle of text", () => {
			// 新实例创建两份独立删除记录。
			const input = new Input();

			// Create two kill ring entries
			// 设置FIRST为第一份删文。
			input.setValue("FIRST");
			// 移末尾。
			input.handleInput("\x05"); // Ctrl+E
			// 删FIRST入环。
			input.handleInput("\x17"); // Ctrl+W - deletes "FIRST"
			// 再设置SECOND，不清已有环。
			input.setValue("SECOND");
			// 移末尾打断kill链，避免和FIRST累积。
			input.handleInput("\x05"); // Ctrl+E
			// 删SECOND为新环尾。
			input.handleInput("\x17"); // Ctrl+W - deletes "SECOND"

			// Set up "hello world" and position cursor after "hello "
			// 换hello world作为最终插入底文。
			input.setValue("hello world");
			// 归开头打断删除链。
			input.handleInput("\x01"); // Ctrl+A
			// 右移六字素，停在world前。
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			// 粘回SECOND，开启yank链。
			input.handleInput("\x19"); // Ctrl+Y - yanks "SECOND"
			// 左右正文都保留，插入片段为六字符SECOND。
			assert.strictEqual(input.getValue(), "hello SECONDworld");

			// Alt+Y只移除光标前刚粘的SECOND，再插五字符FIRST，光标随新长度调整。
			input.handleInput("\x1by"); // Alt+Y - replaces with "FIRST"
			// 结果应恰好hello FIRSTworld，不残留SECOND尾字母。
			assert.strictEqual(input.getValue(), "hello FIRSTworld");
		});
	});

	// 撤销组检查value恢复和输入合并边界；源码快照还含cursor，但这些用例没有直接读取私有光标，也不验证redo或删除环回滚。
	describe("Undo", () => {
		// 空撤销栈上送Ctrl+-应不改变空值，不创建新快照或报错；没有其他先前输入。
		it("does nothing when undo stack is empty", () => {
			// 新实例撤销栈为空。
			const input = new Input();

			// CSI45;5u表示Ctrl+-，经可配置undo动作匹配，不是输入可见连字符。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 空栈撤销后仍空正文。
			assert.strictEqual(input.getValue(), "");
		});

		// 连续hello共享一快照，空格前另建快照后world沿用它；两次undo先去空格world、再去hello，不能逐字撤销。
		it("coalesces consecutive word characters into one undo unit", () => {
			// 独立实例，初始无撤销历史。
			const input = new Input();

			// 第一个h之前保存空值/光标快照，开启普通词输入链。
			input.handleInput("h");
			// 继续e，不重复为同一词逐字建快照。
			input.handleInput("e");
			// 继续首个l，沿用输入链。
			input.handleInput("l");
			// 继续第二个l，保持实际重复字母。
			input.handleInput("l");
			// 继续o，形成hello。
			input.handleInput("o");
			// 空格触发新撤销快照，保存hello；插入后仍标为type-word。
			input.handleInput(" ");
			// w接在空格后，沿用空格开始的同一输入单元。
			input.handleInput("w");
			// 继续o，不为本单元再推快照。
			input.handleInput("o");
			// 继续r。
			input.handleInput("r");
			// 继续l。
			input.handleInput("l");
			// d完成world。
			input.handleInput("d");
			// 确认撤销前正文已完整，防止未成功输入也让恢复断言误通过。
			assert.strictEqual(input.getValue(), "hello world");

			// Undo removes " world"
			// 弹最近快照，回到插空格之前，而非只删最后d。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 结果为hello，空格和world一起消失。
			assert.strictEqual(input.getValue(), "hello");

			// Undo removes "hello"
			// 再弹最初输入h之前的快照。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 整个hello也消失，回到空值。
			assert.strictEqual(input.getValue(), "");
		});

		// 连续两个空格各自触发快照，所以三次undo依次去第二空格、第一空格、整词hello；精确比较尾空格数量。
		it("undoes spaces one at a time", () => {
			// 新实例隔离之前撤销记录。
			const input = new Input();

			// h开启一份普通词输入单元。
			input.handleInput("h");
			// e与h合并同一撤销单元。
			input.handleInput("e");
			// 输入首个l。
			input.handleInput("l");
			// 输入第二个l，仍同一词。
			input.handleInput("l");
			// o完成hello。
			input.handleInput("o");
			// 第一空格前推hello快照。
			input.handleInput(" ");
			// 第二空格也会因自身空白推hello加一空格快照。
			input.handleInput(" ");
			// 撤销前必须保留两个尾空格。
			assert.strictEqual(input.getValue(), "hello  ");

			// 第一次undo恢复到第二空格之前。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes second " "
			// 恰好剩一个尾空格，不能把两个都去掉。
			assert.strictEqual(input.getValue(), "hello ");

			// 第二次undo恢复到第一空格之前。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes first " "
			// 现在只剩hello。
			assert.strictEqual(input.getValue(), "hello");

			// 第三次undo弹掉整词输入单元。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes "hello"
			// 回到空值。
			assert.strictEqual(input.getValue(), "");
		});

		// 输入hello后退格删o，再undo只恢复这次删除，不能把整词输入也一起撤销；此例ASCII字素只有单码元。
		it("undoes backspace", () => {
			// 创建独立撤销栈的Input。
			const input = new Input();

			// 先输入h并存空值快照。
			input.handleInput("h");
			// 继续e。
			input.handleInput("e");
			// 继续首个l。
			input.handleInput("l");
			// 继续第二个l。
			input.handleInput("l");
			// o完成待删hello，光标在末尾。
			input.handleInput("o");
			// DEL编码匹配后删字素动作，另推删除前快照后删o。
			input.handleInput("\x7f"); // Backspace
			// 正文先为hell，验证删除发生。
			assert.strictEqual(input.getValue(), "hell");

			// undo恢复最近删除快照，不是回到初始空值。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// o回来，得到hello。
			assert.strictEqual(input.getValue(), "hello");
		});

		// hello中移到h后用Delete删e，再undo恢复；移动本身只打断输入合并链，快照在实际删除前创建。
		it("undoes forward delete", () => {
			// 创建独立测试实例。
			const input = new Input();

			// 输入h开启普通词单元。
			input.handleInput("h");
			// 继续e。
			input.handleInput("e");
			// 继续首个l。
			input.handleInput("l");
			// 继续第二个l。
			input.handleInput("l");
			// o完成hello，光标自然随插入在末尾。
			input.handleInput("o");
			// Ctrl+A归开头，同时lastAction清空。
			input.handleInput("\x01"); // Ctrl+A - go to start
			// 右移一字素到h后、e前。
			input.handleInput("\x1b[C"); // Right arrow
			// CSI3~匹配向前删除，保存快照后移除e，不移动光标下标。
			input.handleInput("\x1b[3~"); // Delete key
			// 正文变hllo。
			assert.strictEqual(input.getValue(), "hllo");

			// undo消费删除前的hello快照。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 完整hello恢复，虽然本例只断正文而未直接断光标。
			assert.strictEqual(input.getValue(), "hello");
		});

		// hello world末尾Ctrl+W删world，再undo恢复整个删词范围；不要求同时撤销删除环记录，快照只含值/光标。
		it("undoes Ctrl+W (delete word backward)", () => {
			// 独立Input供本例撤销。
			const input = new Input();

			// h开启第一词输入单元。
			input.handleInput("h");
			// 继续e。
			input.handleInput("e");
			// 继续首个l。
			input.handleInput("l");
			// 继续第二个l。
			input.handleInput("l");
			// o完成hello。
			input.handleInput("o");
			// 空格创建下一输入单元的前置快照。
			input.handleInput(" ");
			// w沿用空格开始的输入单元。
			input.handleInput("w");
			// 继续o。
			input.handleInput("o");
			// 继续r。
			input.handleInput("r");
			// 继续l。
			input.handleInput("l");
			// d完成末词world。
			input.handleInput("d");
			// 确认删词前全文。
			assert.strictEqual(input.getValue(), "hello world");

			// Ctrl+W先另存完整value/cursor，再删最后world并写kill ring。
			input.handleInput("\x17"); // Ctrl+W
			// 正文剩hello及分隔空格。
			assert.strictEqual(input.getValue(), "hello ");

			// undo恢复删词前快照，不是把world再作为普通打字输入。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 正文恢复hello world。
			assert.strictEqual(input.getValue(), "hello world");
		});

		// 在hello空格之后Ctrl+K删尾部world，再undo恢复；循环右移与删除范围有因果关系，不是从行首删整行。
		it("undoes Ctrl+K (delete to line end)", () => {
			// 新Input隔离前例状态。
			const input = new Input();

			// 输入h开始构造hello world。
			input.handleInput("h");
			// 继续e，同词输入合并。
			input.handleInput("e");
			// 继续首个l。
			input.handleInput("l");
			// 继续第二个l。
			input.handleInput("l");
			// 继续o，当前hello。
			input.handleInput("o");
			// 输入分隔空格，形成新的输入撤销边界。
			input.handleInput(" ");
			// w开始world，沿用空格的输入链。
			input.handleInput("w");
			// 继续o。
			input.handleInput("o");
			// 继续r。
			input.handleInput("r");
			// 继续l。
			input.handleInput("l");
			// d完成全文，光标到末尾。
			input.handleInput("d");
			// 归开头，明确六次右移的起点。
			input.handleInput("\x01"); // Ctrl+A
			// 经过hello五字母和一空格，停在world前。
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			// Ctrl+K从当前光标删world到末尾，保存删除前快照。
			input.handleInput("\x0b"); // Ctrl+K
			// 删后保留hello和一个尾空格。
			assert.strictEqual(input.getValue(), "hello ");

			// undo恢复这次整段删除。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 从已存快照恢复完整正文，不是重新逐字插入world。
			assert.strictEqual(input.getValue(), "hello world");
		});

		// 同样定位到hello空格之后，改用Ctrl+U删前缀，再undo恢复；检验行首方向的删除快照。
		it("undoes Ctrl+U (delete to line start)", () => {
			// 新实例准备自己的撤销栈。
			const input = new Input();

			// 输入h开启第一词单元。
			input.handleInput("h");
			// 继续e。
			input.handleInput("e");
			// 继续首个l。
			input.handleInput("l");
			// 继续第二个l。
			input.handleInput("l");
			// o完成hello。
			input.handleInput("o");
			// 空格作为独立撤销边界开头。
			input.handleInput(" ");
			// 继续w，沿用空格后的输入单元。
			input.handleInput("w");
			// 继续o。
			input.handleInput("o");
			// 继续r。
			input.handleInput("r");
			// 继续l。
			input.handleInput("l");
			// d完成hello world。
			input.handleInput("d");
			// 归行首，打断普通输入合并链。
			input.handleInput("\x01"); // Ctrl+A
			// 右移六字素到world前。
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			// Ctrl+U保存快照并删除左侧hello空格，光标归0。
			input.handleInput("\x15"); // Ctrl+U
			// 剩余正文必须为world。
			assert.strictEqual(input.getValue(), "world");

			// 撤销最近向后整段删除。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 正文恢复完整hello world；没有直接断言删除环也回到旧状态。
			assert.strictEqual(input.getValue(), "hello world");
		});

		// 先删hello空格入环，再yank回后undo应回到yank前的空值；说明粘回也是独立撤销单元，不读取系统剪贴板。
		it("undoes yank", () => {
			// 创建新Input，环/栈初始为空。
			const input = new Input();

			// h开启普通输入单元。
			input.handleInput("h");
			// 继续e。
			input.handleInput("e");
			// 继续首个l。
			input.handleInput("l");
			// 继续第二个l。
			input.handleInput("l");
			// o完成hello。
			input.handleInput("o");
			// 插空格，文字现在为hello加空格。
			input.handleInput(" ");
			// Ctrl+W先跳尾空白再跨hello，将整段删入环。
			input.handleInput("\x17"); // Ctrl+W - delete "hello "
			// Ctrl+Y推粘回前的空值快照，再插回整个hello空格。
			input.handleInput("\x19"); // Ctrl+Y - yank
			// 检查yank已成功恢复文字。
			assert.strictEqual(input.getValue(), "hello ");

			// undo恢复yank前的空值，不顺带再执行一次kill。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 当前正文应为空，删除环没有随此快照一起回滚。
			assert.strictEqual(input.getValue(), "");
		});

		// 在hello后括号粘贴beep空格boop应当一次撤销整段；断言实际只比较value，原英文注释说entire pre-paste state但没有直接检查cursor。
		it("undoes paste atomically", () => {
			// 独立Input用于粘贴快照。
			const input = new Input();

			// 直接设置底文不创建撤销点，cursor仍0。
			input.setValue("hello world");
			// 显式归开头。
			input.handleInput("\x01"); // Ctrl+A
			// 右移五字素到hello后、原空格前。
			for (let i = 0; i < 5; i++) input.handleInput("\x1b[C");

			// Simulate bracketed paste
			// 一次喂完整开始/正文/结束标记，Input直接缓冲处理并只为整次粘贴推一个快照；不经StdinBuffer也不读系统剪贴板。
			input.handleInput("\x1b[200~beep boop\x1b[201~");
			// 正文在原hello和空格world之间加入beep boop，保留原有空格。
			assert.strictEqual(input.getValue(), "hellobeep boop world");

			// Single undo should restore entire pre-paste state
			// 一次Ctrl+-就应消费完整粘贴前快照，不按两个词逐步撤销。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 底文完整恢复，所有粘贴正文一起消失。
			assert.strictEqual(input.getValue(), "hello world");
		});

		// 行首Alt+D删hello，undo应恢复；覆盖向前删词的独立快照，不直接检查删除环内容。
		it("undoes Alt+D (delete word forward)", () => {
			// 新实例，不用前例粘贴快照。
			const input = new Input();

			// 直接设置hello world，初始光标仍0。
			input.setValue("hello world");
			// 显式归行首并清旧动作链。
			input.handleInput("\x01"); // Ctrl+A

			// 向前删hello词段，保留后面的空格。
			input.handleInput("\x1bd"); // Alt+D - deletes "hello"
			// 确认先留下前导空格world。
			assert.strictEqual(input.getValue(), " world");

			// undo取删除前快照恢复。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 得到原hello world。
			assert.strictEqual(input.getValue(), "hello world");
		});

		// 输入abc后移动开头再回末尾，后续de必须另成撤销单元；移动本身不压快照，是下一次插入看lastAction后才推。
		it("cursor movement starts new undo unit", () => {
			// 新Input创建独立输入链。
			const input = new Input();

			// a之前保存空值快照并开启普通词输入。
			input.handleInput("a");
			// b与a合并。
			input.handleInput("b");
			// c继续同一单元，当前abc。
			input.handleInput("c");
			// Ctrl+A移到开头并打断type-word链，没有新增撤销快照。
			input.handleInput("\x01"); // Ctrl+A - movement breaks coalescing
			// Ctrl+E再移末尾，仍保持链已打断。
			input.handleInput("\x05"); // Ctrl+E
			// 插d时新推abc快照，开启新单元。
			input.handleInput("d");
			// e与d合并同一单元。
			input.handleInput("e");
			// 撤销前文字为abcde。
			assert.strictEqual(input.getValue(), "abcde");

			// Undo removes "de" (typed after movement)
			// 第一次undo弹abc快照，整个de一起消失。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 当前正文abc。
			assert.strictEqual(input.getValue(), "abc");

			// Undo removes "abc"
			// 再undo弹最初空值快照，移光标动作没有夹进额外的相同正文快照。
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			// 最终为空。
			assert.strictEqual(input.getValue(), "");
		});
	});
});
