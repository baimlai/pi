// 验证合成输入片段怎样分段、等待超时、保留终端回复和分离括号粘贴；只用内存事件与真实短定时器/模拟时钟，不接管真实stdin或剪贴板。
/**
 * Tests for StdinBuffer
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

// 导入Node断言对象，深比较数组元素与顺序；失败抛出AssertionError，使同步用例失败或async用例拒绝。
import assert from "node:assert";
// beforeEach/afterEach注册每例的准备/清理，describe/it组织测试；注册回调本身不立即处理输入。
import { afterEach, beforeEach, describe, it } from "node:test";
// 少数断言再用matchesKey解释Escape/Alt+Enter/Ctrl+G；StdinBuffer自身主要切原始序列，不负责执行这些动作。
import { matchesKey } from "../src/keys.ts";
// 导入实际缓冲器，继承EventEmitter；process由测试主动喂入，构造不会监听系统stdin。
import { StdinBuffer } from "../src/stdin-buffer.ts";

// 整个文件的测试组，每例先创建独立buffer和记录数组；更内层beforeEach也会按其作用域执行。
describe("StdinBuffer", () => {
	// 声明当前实例引用，TypeScript类型不是运行时初始化；真正赋值在beforeEach，部分用例会替换此引用。
	let buffer: StdinBuffer;
	// 声明data事件记录数组，元素是原始字符串序列而非键盘动作对象。
	let emittedSequences: string[];

	// 每例准备：新建缓冲→清记录→注册同步data监听，无参数/返回值；例喂abc后记录三条，异常交测试运行器。
	beforeEach(() => {
		// 将普通不完整序列timeout设10ms；独立escapeTimeout没有传，仍默认10ms，二者只是本配置恰好相同。
		buffer = new StdinBuffer({ timeout: 10 });

		// Collect emitted sequences
		// 新数组只收本用例的事件，避免复用上一用例记录。
		emittedSequences = [];
		// 注册接收sequence字符串的回调，事件发出时才push，不await监听器返回值。
		buffer.on("data", (sequence) => {
			// 按同步到达顺序记录，每次emit追加一项。
			emittedSequences.push(sequence);
		});
	});

	// 每例后对当前buffer调用destroy清状态/任务，不移除EventEmitter监听或永久禁用实例；被覆盖的旧引用不由此行逐个清理。
	afterEach(() => buffer.destroy());

	// Helper to process data through the buffer
	// 薄转发函数输入string或Node Buffer，同步调用当前实例process，返回void；例半截CSI会留在普通缓冲，监听器抛错沿本调用传播。
	function processInput(data: string | Buffer): void {
		// 读取的是此刻buffer变量，所以替换实例后的用例仍复用同一辅助函数。
		buffer.process(data);
	}

	// Helper to wait for async operations
	// 等待ms毫秒的异步辅助函数，返回Promise<void>，无输入处理副作用；例wait(15)给10ms任务执行机会，事件循环繁忙可更晚，不保证精确时刻。
	async function wait(ms: number): Promise<void> {
		// Promise执行器立即注册setTimeout，resolve之后才完成；async返回会采纳该Promise，并不是阻塞线程睡眠。
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	// 普通字符组检查同步data分发；当前普通文本按UTF-16单元提取，下面BMP汉字样例不能证明所有Unicode字素均为单事件。
	describe("Regular Characters", () => {
		// 喂单个a后立即检查记录，证明普通字符不必等序列超时；不建立真实键盘事件。
		it("should pass through regular characters immediately", () => {
			// 主动输入字符串a。
			processInput("a");
			// 应恰好同步发出一条a。
			assert.deepStrictEqual(emittedSequences, ["a"]);
		});

		// 同批abc拆成三条data事件，精确检查顺序；不是把一次process调用等同一次按键。
		it("should pass through multiple regular characters", () => {
			// 一次传三个普通ASCII字符。
			processInput("abc");
			// 输出应为a、b、c三项，而非单项abc。
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c"]);
		});

		// 包含BMP汉字和空格的普通串也逐单元发出；这里只覆盖这个样例，不检查非BMP代理对或组合字素。
		it("should handle unicode characters", () => {
			// 一次喂hello、空格与两个汉字。
			processInput("hello 世界");
			// 汉字各为一个UTF-16单元，因此这里正好各一项；空格也是独立事件。
			assert.deepStrictEqual(emittedSequences, ["h", "e", "l", "l", "o", " ", "世", "界"]);
		});
	});

	// 完整转义组检查控制串整体保留，不在这里验证终端是否真的产生它或具体按钮/坐标含义。
	describe("Complete Escape Sequences", () => {
		// 完整SGR鼠标串一次到齐，预期一条原样data且无需等待，失败直接抛断言。
		it("should pass through complete mouse SGR sequences", () => {
			// ESC[<按钮;列;行m格式，m为释放形式；StdinBuffer只检查结构/边界。
			const mouseSeq = "\x1b[<35;20;5m";
			// 一次喂完整鼠标串。
			processInput(mouseSeq);
			// 完整控制串必须作为一项保留，不拆成普通字符。
			assert.deepStrictEqual(emittedSequences, [mouseSeq]);
		});

		// 完整上箭头CSI串应原样立即通过，只测分段而非编辑器实际上移。
		it("should pass through complete arrow key sequences", () => {
			// ESC[A是常见上箭头编码。
			const upArrow = "\x1b[A";
			// 一次提交完整序列。
			processInput(upArrow);
			// 记录恰好一条上箭头原串。
			assert.deepStrictEqual(emittedSequences, [upArrow]);
		});

		// 以F1样例检查波浪号终止的CSI也可完整通过，不保证所有功能键编码都相同。
		it("should pass through complete function key sequences", () => {
			// F1的一种传统CSI编码11~。
			const f1 = "\x1b[11~";
			// 输入整条编码。
			processInput(f1);
			// 应保留成单项，不按数字和~拆开。
			assert.deepStrictEqual(emittedSequences, [f1]);
		});

		// 传统Meta/Alt由ESC加字符a构成，完整两单元串立即通过；这里未调用宿主执行Alt+A动作。
		it("should pass through meta key sequences", () => {
			// 字符串转义是ESC后接a，不是可见反斜杠文本。
			const metaA = "\x1ba";
			// 喂两单元传统Meta序列。
			processInput(metaA);
			// 输出仍一项，避免ESC和a分开成为两个动作。
			assert.deepStrictEqual(emittedSequences, [metaA]);
		});

		// SS3的ESCOA作为完整序列通过，检查这种引导形式不被普通文本分割。
		it("should pass through SS3 sequences", () => {
			// O是SS3引导字母，后面的A作为终止单元。
			const ss3 = "\x1bOA";
			// 一次输入完整SS3。
			processInput(ss3);
			// 期望仅一条原串。
			assert.deepStrictEqual(emittedSequences, [ss3]);
		});
	});

	// 分片组检查同一控制串跨process调用拼接，以及孤立ESC与普通半截序列各自超时。
	describe("Partial Escape Sequences", () => {
		// 将鼠标串分三次同步喂入，前两次只缓冲、最后才发完整事件；虽声明async，本例没有await，步骤仍连续同步执行。
		it("should buffer incomplete mouse SGR sequence", async () => {
			// 仅ESC尚不能判断独立Escape还是控制串开头。
			processInput("\x1b");
			// 不能立刻发data。
			assert.deepStrictEqual(emittedSequences, []);
			// getBuffer只读普通未完成尾串，此时应为ESC。
			assert.strictEqual(buffer.getBuffer(), "\x1b");

			// 继续拼入SGR引导与按钮数字，尚无坐标和结尾。
			processInput("[<35");
			// 仍不应分发半条鼠标输入。
			assert.deepStrictEqual(emittedSequences, []);
			// 确认之前ESC没有丢掉，普通缓冲现为完整前缀。
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			// 补齐两段坐标和m终止。
			processInput(";20;5m");
			// 此时一次发出拼好的完整鼠标串。
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;20;5m"]);
			// 已消费全部输入，普通缓冲清空。
			assert.strictEqual(buffer.getBuffer(), "");
		});

		// CSI分三片到达，在终止H前不发事件，补齐后只出一条；无真实定时等待。
		it("should buffer incomplete CSI sequence", () => {
			// ESC[只有引导部分。
			processInput("\x1b[");
			// 记录仍空。
			assert.deepStrictEqual(emittedSequences, []);

			// 加入第一参数和分号，还不是终止单元。
			processInput("1;");
			// 仍保留到普通缓冲。
			assert.deepStrictEqual(emittedSequences, []);

			// 补第二参数和H终止。
			processInput("5H");
			// 检查拼接顺序，参数内容原样保留，不解释成实际光标移动。
			assert.deepStrictEqual(emittedSequences, ["\x1b[1;5H"]);
		});

		// 把一条SGR拆到近乎每字符一片，连续同步调用应最终只出一条；覆盖多次重设等待，不模拟真实网络传输。
		it("should buffer split across many chunks", () => {
			// 先输入ESC。
			processInput("\x1b");
			// 再输入CSI引导的[。
			processInput("[");
			// 加入SGR鼠标标志<。
			processInput("<");
			// 按钮值十位3。
			processInput("3");
			// 按钮值个位5，组合成35。
			processInput("5");
			// 第一分隔符。
			processInput(";");
			// 列号十位2。
			processInput("2");
			// 列号个位0，组合成20。
			processInput("0");
			// 第二分隔符。
			processInput(";");
			// 行号5。
			processInput("5");
			// m结束序列，才可整体发出。
			processInput("m");

			// 对整个事件列表深比较，不能出现多余半片。
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;20;5m"]);
		});

		// 半截鼠标串按配置10ms超时恢复为data，等待15ms后检查；这条输出仍是不完整协议，恢复不等于补齐合法输入。
		it("should flush incomplete sequence after timeout", async () => {
			// 喂尚缺坐标/终止符的前缀。
			processInput("\x1b[<35");
			// 同步阶段先不发出。
			assert.deepStrictEqual(emittedSequences, []);

			// Wait for timeout
			// 真实等待给10ms超时回调机会，不是断言恰好15ms触发。
			await wait(15);

			// 超时直接发原半截串，不把它丢弃或伪造成完整鼠标事件。
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35"]);
		});

		// 孤立ESC等过独立10ms后再来CR，应成为Escape和普通CR两条；matchesKey只确认首项键身份，不实际中断会话。
		it("should flush a lone ESC as Escape when CR arrives after the timeout", async () => {
			// Legacy-mode Alt+Enter is ESC + CR; when the terminal/transport splits
			// the bytes further apart than the timeout, ESC is flushed alone and the
			// host sees Escape (interrupt) instead of Alt+Enter. This locks in the
			// behavior so the configurable timeout in ProcessTerminal stays honest.
			// 先只收到ESC，安排独立Escape等待。
			processInput("\x1b");
			// wait20超过独立10ms；原英文说buffer timeout，本例两选项恰好相同，但决定孤立ESC的是escapeTimeout。
			await wait(20); // buffer timeout is 10ms in beforeEach
			// 超时已发ESC，后来的CR不能再和它合成Alt+Enter。
			processInput("\r");

			// 检查分成两条原始事件。
			assert.deepStrictEqual(emittedSequences, ["\x1b", "\r"]);
			// ??只在缺项时用空串，matchesKey将首项ESC认作escape；assert.equal本身是宽松相等，这里比较boolean。
			assert.equal(matchesKey(emittedSequences[0] ?? "", "escape"), true);
		});

		// 改escapeTimeout100ms，ESC后20ms到CR应拼成Alt+Enter；这是受真实调度影响的短等待样例，并未模拟SSH连接。
		it("should merge ESC + CR split across chunks within a larger timeout", async () => {
			// 替换当前实例，序列timeout缺省50ms、孤立ESC明确100ms；被替换的外层新实例此时尚无待处理输入。
			buffer = new StdinBuffer({ escapeTimeout: 100 });
			// 换新记录数组以匹配新实例。
			emittedSequences = [];
			// 给新实例注册data监听，接字符串无返回需求。
			buffer.on("data", (sequence) => {
				// 把新实例输出追加到当前记录。
				emittedSequences.push(sequence);
			});

			// 喂ESC，按100ms规则等待。
			processInput("\x1b");
			// 目标等待20ms小于100ms；繁忙机器实际延迟可能更长，这不是绝对时序保证。
			await wait(20); // > 10ms default escapeTimeout, < 100ms configured escapeTimeout
			// 在等待窗口内的CR与ESC合并。
			processInput("\r");

			// 检查只出ESC+CR一条。
			assert.deepStrictEqual(emittedSequences, ["\x1b\r"]);
			// 默认非Kitty全局模式下，此传统编码匹配alt+enter，不会实际提交编辑器。
			assert.equal(matchesKey(emittedSequences[0] ?? "", "alt+enter"), true);
		});

		// 只把普通timeout改100ms不应拖长孤立ESC：其escapeTimeout仍默认10ms，20ms后CR仍是独立事件。
		it("does not apply the sequence timeout to a lone ESC", async () => {
			// 新实例只改序列timeout，没有显式改escapeTimeout。
			buffer = new StdinBuffer({ timeout: 100 });
			// 清新实例记录。
			emittedSequences = [];
			// 注册同步记录回调。
			buffer.on("data", (sequence) => {
				// 收到每条原始序列就push。
				emittedSequences.push(sequence);
			});

			// 孤立ESC使用独立10ms规则。
			processInput("\x1b");
			// 给该10ms任务执行机会。
			await wait(20);
			// CR到达时ESC已发出，不能再合并。
			processInput("\r");

			// 精确检查两条，而不是单条ESC+CR。
			assert.deepStrictEqual(emittedSequences, ["\x1b", "\r"]);
			// 再次确认首条是Escape身份，不依赖普通timeout100ms。
			assert.equal(matchesKey(emittedSequences[0] ?? "", "escape"), true);
		});

		// 默认普通序列50ms下，半截CSI等20ms仍应保留，再补SGR鼠标串一次发出；临时实例正常路径显式destroy，失败没有finally。
		it("keeps fragmented mouse sequences buffered across delayed chunks by default", async () => {
			// 新临时实例采用默认50ms序列/10ms孤立ESC策略。
			const delayedBuffer = new StdinBuffer();
			// 临时实例有自己独立的输出数组。
			const delayedSequences: string[] = [];
			// 监听data只push，不访问真实stdin。
			delayedBuffer.on("data", (sequence) => delayedSequences.push(sequence));

			// 喂ESC[，已不是孤立ESC，采用普通50ms等待。
			delayedBuffer.process("\x1b[");
			// 短于50ms的目标等待，为模拟片段延迟；受真实调度影响。
			await wait(20);
			// 此刻不应提前超时发半截。
			assert.deepStrictEqual(delayedSequences, []);
			// 补按钮/坐标/M，取消旧等待并提取完整序列。
			delayedBuffer.process("<65;48;39M");
			// 检查输出只一条完整SGR。
			assert.deepStrictEqual(delayedSequences, ["\x1b[<65;48;39M"]);
			// 清临时实例的状态和待任务，不移除注册监听。
			delayedBuffer.destroy();
		});
	});

	// 终端回复组区分已识别的颜色/状态/版本/Kitty回复头与传统Alt歧义：完整回复头等终止符，不让迟到BEL变成Ctrl+G。
	describe("Terminal Reply Strings", () => {
		// 样例同时给出最小已识别header与完整reply，后面只在header之后切片。
		const replies = [
			// OSC4调色板颜色回复，BEL结束；注释中的Ghostty只是样例来源，测试不启动该终端。
			{ header: "\x1b]4;1;", reply: "\x1b]4;1;rgb:eaea/6c6c/6d6d\x07" }, // Ghostty's Ayu Light palette color 1.
			// OSC10前景颜色回复，以ST结束，载荷颜色值保持原串。
			{ header: "\x1b]10;", reply: "\x1b]10;rgb:ffff/ffff/ffff\x1b\\" },
			// OSC11背景颜色回复，以BEL结束。
			{ header: "\x1b]11;", reply: "\x1b]11;rgb:0000/0000/0000\x07" },
			// 另一条OSC4颜色尾部样例，检验不同十六进制值不影响完整保留。
			{ header: "\x1b]4;1;", reply: "\x1b]4;1;rgb:6464/6464/4d4d\x07" }, // Another reported color-reply tail.
			// DCS XTVersion回复，以ESC反斜杠结束，Ghostty版本文本只是合成数据。
			{ header: "\x1bP>|", reply: "\x1bP>|Ghostty 1.3.1\x1b\\" },
			// APC Kitty图形回复，i=1/OK为控制载荷，不解码图片或确认真实上传。
			{ header: "\x1b_Gi=1;", reply: "\x1b_Gi=1;OK\x1b\\" },
			// OSC7501程序状态支持回复，以ST结束，不代表用户按键。
			{ header: "\x1b]7501;?", reply: "\x1b]7501;?\x1b\\" },
		];

		// 逐样例解构header/reply并注册用例，不修改配置数组。
		for (const { header, reply } of replies) {
			// 测试上下文t提供模拟时钟；遍历已识别header后的每个切点，先等虚拟5秒再补尾和x，要求整条reply+x且没有Ctrl+G；临时buffer用finally清理。
			it(`keeps delayed ${JSON.stringify(reply)} intact at every split after its reply header`, (t) => {
				// 只模拟setTimeout及其clear，tick推进模拟任务，不真实等待5秒；t上下文在用例结束时恢复其mock。
				t.mock.timers.enable({ apis: ["setTimeout"] });
				// 从header末尾到完整reply前一单元枚举切点；不声称测试header完成前的所有分片。
				for (let split = header.length; split < reply.length; split++) {
					// 每个切点新建默认策略实例，避免上一次回复状态影响本次。
					const delayedBuffer = new StdinBuffer();
					// 保存该切点的事件列表。
					const sequences: string[] = [];
					// data回调同步push字符串，返回的数组长度被忽略。
					delayedBuffer.on("data", (sequence) => sequences.push(sequence));
					// 保护后面的喂入/断言，失败也清当前临时实例。
					try {
						// 第一片至少已包含完整可识别回复头。
						delayedBuffer.process(reply.slice(0, split));
						// 推进虚拟5秒仍不该自动冲刷这种已识别回复，不影响系统真实时钟。
						t.mock.timers.tick(5000);
						// 补剩余回复尾和普通x，前者整体data，后者单独data。
						delayedBuffer.process(`${reply.slice(split)}x`);
						// 检查事件中没有任何一条被键位解释器当作ctrl+g。
						assert.equal(
							// some回调只判断每条完整事件键身份；BEL若泄漏成单独事件会命中Ctrl+G。
							sequences.some((sequence) => matchesKey(sequence, "ctrl+g")),
							// 预期false，没有泄漏该控制键事件。
							false,
						);
						// 同时深比较完整列表，不能只靠“不含Ctrl+G”掩盖回复丢失或被拆坏。
						assert.deepStrictEqual(sequences, [reply, "x"]);
						// finally确保本切点断言抛错时也收尾。
					} finally {
						// 清缓冲/等待，不向真实终端发送恢复码。
						delayedBuffer.destroy();
					}
				}
			});
		}

		// 颜色回复分更多片并跨多次虚拟100ms仍不超时，直到BEL才整体发出；覆盖已识别头后的持续等待，不代表任意OSC都无超时。
		it("keeps an OSC reply buffered across multiple expired sequence timeouts", (t) => {
			// 用上下文模拟setTimeout，避免真实等待。
			t.mock.timers.enable({ apis: ["setTimeout"] });
			// 已含OSC4;1;完整头与半段rgb值。
			processInput("\x1b]4;1;rgb:eaea/6c");
			// 推进100ms，大于本组配置的10ms，但回复头使它不安排普通超时。
			t.mock.timers.tick(100);
			// 记录仍空，不能泄漏半条颜色回复。
			assert.deepStrictEqual(emittedSequences, []);
			// 补颜色值尾，尚缺BEL/ST。
			processInput("6c/6d6d");
			// 再推进100ms，也不应强制结束回复。
			t.mock.timers.tick(100);
			// 仍无data事件。
			assert.deepStrictEqual(emittedSequences, []);
			// BEL终止OSC，不该独立发为Ctrl+G。
			processInput("\x07");
			// 完整回复必须等于replies首项的原始字符串。
			assert.deepStrictEqual(emittedSequences, [replies[0].reply]);
		});

		// 只有OSC/DCS/APC两单元引导时仍可能是传统Alt键，模拟10ms后按原串恢复；没有完整回复头不能无限等待。
		it("still times out bare string introducers as Alt keys", (t) => {
			// 模拟超时任务。
			t.mock.timers.enable({ apis: ["setTimeout"] });
			// 依次测试ESC]、ESCP、ESC_三种裸引导，各次处理后及时tick冲刷。
			for (const prefix of ["\x1b]", "\x1bP", "\x1b_"]) {
				// 喂当前裸引导，结构上还不完整。
				processInput(prefix);
				// 推进本组普通timeout10ms，不是孤立ESC路径。
				t.mock.timers.tick(10);
			}
			// 三个结果分别是传统Alt引导原串，未合成回复正文。
			assert.deepStrictEqual(emittedSequences, ["\x1b]", "\x1bP", "\x1b_"]);
		});

		// 下面枚举未被回复头正则完整识别的歧义串，逐个注册独立用例，不把任意标题/控制文本都当作确定回复。
		for (const ambiguous of [
			// OSC引导后字母a，不是已识别数字头。
			"\x1b]a",
			// OSC数字1尚缺0/1与分号。
			"\x1b]1",
			// OSC10还缺分号，未完整识别颜色头。
			"\x1b]10",
			// OSC0标题类不在本实现已识别的回复头列表。
			"\x1b]0;title",
			// OSC4;还缺调色板索引和分号。
			"\x1b]4;",
			// 索引a不是该头要求的十进制数字。
			"\x1b]4;a;",
			// DCS引导后a，不是XTVersion的>|。
			"\x1bPa",
			// DCS的>尚缺|，仍有歧义。
			"\x1bP>",
			// APC后a，不是Kitty图形回复头。
			"\x1b_a",
			// APC_G还没有数字字段与结束分号。
			"\x1b_G",
			// APC_Gi=1缺分号，仍不够完整。
			"\x1b_Gi=1",
		]) {
			// 默认50ms歧义等待在每次process后重计；先20ms再加入x/回车/Ctrl+C/D，49ms仍不发、再1ms恢复Alt前缀+普通尾部，随后输入应正常。
			it(`recovers batched legacy Alt input ${JSON.stringify(ambiguous)} within the sequence timeout`, (t) => {
				// 模拟当前用例的setTimeout与clearTimeout，保持系统真实时间不变。
				t.mock.timers.enable({ apis: ["setTimeout"] });
				// 临时实例用默认序列50ms，不沿用外层buffer的10ms配置。
				const legacyBuffer = new StdinBuffer();
				// 收集该歧义输入的全部data。
				const sequences: string[] = [];
				// data监听只在真正分发时记录。
				legacyBuffer.on("data", (sequence) => sequences.push(sequence));
				// 对临时buffer的处理/断言加finally清理。
				try {
					// 喂本次歧义串，启动有限等待。
					legacyBuffer.process(ambiguous);
					// 先推进20ms，还未到50ms。
					t.mock.timers.tick(20);
					// 同批普通x、CR、ETX、EOT接到歧义串后；它们是数据，不向进程发送信号或退出命令。
					legacyBuffer.process("x\r\x03\x04");
					// 这次process重计50ms，现在只过49ms。
					t.mock.timers.tick(49);
					// 不能提前拆出整条歧义串中的数据。
					assert.deepStrictEqual(sequences, []);
					// 再推进1ms到新等待到期，触发恢复。
					t.mock.timers.tick(1);
					// 深比较恢复顺序，下面不是创建真实终端事件。
					assert.deepStrictEqual(sequences, [
						// 前两单元ESC+引导符保留为一个传统Alt序列。
						ambiguous.slice(0, 2),
						// 展开字符串尾部为单个字符数组元素；这些歧义样例尾部均ASCII，非BMP展开语义不由此例测试。
						...ambiguous.slice(2),
						// 新加入的普通x应保留。
						"x",
						// CR保留为独立输入项，未被吞进标题/回复。
						"\r",
						// ETX作为原始Ctrl+C编码保留，但测试没有执行宿主中断动作。
						"\x03",
						// EOT作为原始Ctrl+D编码保留，不会直接终止本测试进程。
						"\x04",
					]);
					// 恢复后普通缓冲应清空。
					assert.strictEqual(legacyBuffer.getBuffer(), "");

					// 再喂下一批普通y和三种控制输入，验证解析器没有继续卡在旧控制串状态。
					legacyBuffer.process("y\r\x03\x04");
					// 只比较最新4条，前面的恢复记录仍保留在同一数组。
					assert.deepStrictEqual(sequences.slice(-4), ["y", "\r", "\x03", "\x04"]);
					// 无论成功或断言失败都收尾。
				} finally {
					// 清临时缓冲及等待任务；不移除其data监听。
					legacyBuffer.destroy();
				}
			});
		}

		// OSC10回复头分两片但5ms内补齐，应从歧义有限等待转为确认头后的持续等待；虚拟5秒后仍不发，ST补齐才输出。
		it("recognizes a reply header assembled within the ambiguous-input timeout", (t) => {
			// 开启本用例模拟超时。
			t.mock.timers.enable({ apis: ["setTimeout"] });
			// ESC]1尚缺完整头，先按普通超时等待。
			processInput("\x1b]1");
			// 只推进5ms，小于外层配置10ms。
			t.mock.timers.tick(5);
			// 补0;后头变成OSC10;，本次process会取消旧定时器。
			processInput("0;");
			// 推进5秒检验新状态不再超时，不是真实网络延迟。
			t.mock.timers.tick(5000);
			// 尚无结束符，输出为空。
			assert.deepStrictEqual(emittedSequences, []);
			// 补rgb载荷和ST结束。
			processInput("rgb:ffff/ffff/ffff\x1b\\");
			// 与replies中OSC10完整样例精确相同。
			assert.deepStrictEqual(emittedSequences, [replies[1].reply]);
		});

		// 未终止的已识别回复遇到新的非ST转义时应丢弃旧回复并恢复箭头+文字；尾部孤立ESC会先等下一字符区分新序列与ST。
		it("recovers from an unterminated reply when a new escape sequence arrives", (t) => {
			// 用模拟时钟推进等待，不发真实Escape按键。
			t.mock.timers.enable({ apis: ["setTimeout"] });
			// 先保留半条已识别OSC4回复。
			processInput("\x1b]4;1;rgb:eaea/6c");
			// 100ms过去也不按普通超时冲刷。
			t.mock.timers.tick(100);
			// 加入ESC，但还无法区分后接反斜杠ST还是另一控制串。
			processInput("\x1b");
			// 继续等待虚拟100ms，不泄漏旧回复。
			t.mock.timers.tick(100);
			// 下一字符[说明这是新CSI，不是ST；旧回复丢掉，箭头后hello按普通字符处理。
			processInput("[Ahello");
			// 断言只剩完整箭头与五字符，没有旧颜色载荷或多余ESC。
			assert.deepStrictEqual(emittedSequences, ["\x1b[A", "h", "e", "l", "l", "o"]);
		});

		// CAN/SUB取消当前回复后，后面的x仍可正常分发；这是解析状态取消，不是AbortSignal或进程信号。
		it("discards a canceled reply without swallowing subsequent input", () => {
			// 分别测试控制字符0x18与0x1a。
			for (const cancel of ["\x18", "\x1a"]) {
				// 模板在未结束颜色回复后插取消符与x，一次输入完成这次恢复。
				processInput(`\x1b]11;rgb:0000${cancel}x`);
			}
			// 两次各只留下x，回复与取消符都不作为按键泄漏。
			assert.deepStrictEqual(emittedSequences, ["x", "x"]);
		});
	});

	// 混合输入组要求普通字符、完整控制串和未完成尾部按原顺序分流；不会把整批输入粗略当成同一个键。
	describe("Mixed Content", () => {
		// 普通abc后紧接箭头，同一次process应发三字符加一条完整CSI；同步深比较顺序。
		it("should handle characters followed by escape sequence", () => {
			// 一批输入含普通正文和控制序列。
			processInput("abc\x1b[A");
			// a/b/c各一项，箭头整体一项。
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c", "\x1b[A"]);
		});

		// 顺序反过来也应先发箭头再发a/b/c，不因CSI已经完整就吞掉后续文字。
		it("should handle escape sequence followed by characters", () => {
			// 一次提交箭头加abc。
			processInput("\x1b[Aabc");
			// 精确比较事件次序，没有多余空事件。
			assert.deepStrictEqual(emittedSequences, ["\x1b[A", "a", "b", "c"]);
		});

		// 连续三条箭头CSI在同批中分别提取，不拼成一条，也不拆坏各自前缀。
		it("should handle multiple complete sequences", () => {
			// ESC[A/B/C三种完整控制串相邻。
			processInput("\x1b[A\x1b[B\x1b[C");
			// 输出恰三项，依原输入顺序。
			assert.deepStrictEqual(emittedSequences, ["\x1b[A", "\x1b[B", "\x1b[C"]);
		});

		// 普通abc可先发，尾部半条鼠标串需缓冲；补齐后接在同一记录数组末尾，检查正文未丢或重复。
		it("should handle partial sequence with preceding characters", () => {
			// 一批含完整普通部分与不完整尾部。
			processInput("abc\x1b[<35");
			// 先只记录abc三条。
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c"]);
			// 普通缓冲仅保留半条SGR，不包含已经发出的abc。
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			// 继续补坐标和m终止。
			processInput(";20;5m");
			// 最后才加入完整鼠标串，前三条保持不变。
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c", "\x1b[<35;20;5m"]);
		});
	});

	// Kitty组只测CSI-u等原始序列边界和紧邻原始字符去重，不和真实终端协商支持，也不在这里执行按下/松开动作。
	describe("Kitty Keyboard Protocol", () => {
		// 最简CSI-u的a按下编码应完整通过，单个数值码点仍作为原串保存。
		it("should handle Kitty CSI u press events", () => {
			// Press 'a' in Kitty protocol
			// 97是ASCII a码点，无显式修饰/事件字段的编码。
			processInput("\x1b[97u");
			// 仅一条完整CSI-u，不提前发97等载荷字符。
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u"]);
		});

		// 显式Kitty松开事件也完整通过；StdinBuffer不应自行丢松开，宿主是否过滤另决定。
		it("should handle Kitty CSI u release events", () => {
			// Release 'a' in Kitty protocol
			// 97;1:3中1表示无修饰编码、事件子字段3表示release。
			processInput("\x1b[97;1:3u");
			// 要求松开原串原样保留。
			assert.deepStrictEqual(emittedSequences, ["\x1b[97;1:3u"]);
		});

		// 同批a按下和松开应拆两条，覆盖SSH等可能批量送入的形式，但不建立SSH连接。
		it("should handle batched Kitty press and release", () => {
			// Press 'a', release 'a' batched together (common over SSH)
			// 两条CSI-u直接相邻，一次喂入。
			processInput("\x1b[97u\x1b[97;1:3u");
			// 按下/松开均保留且次序不变。
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u", "\x1b[97;1:3u"]);
		});

		// 两键各自按下/松开混批，应拆4项；不把快速输入视为粘贴或去掉所有重复事件。
		it("should handle multiple batched Kitty events", () => {
			// Press 'a', release 'a', press 'b', release 'b'
			// 依次是a按下、a松开、b按下、b松开。
			processInput("\x1b[97u\x1b[97;1:3u\x1b[98u\x1b[98;1:3u");
			// 深比较完整4条列表，未额外解释成字符ab。
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u", "\x1b[97;1:3u", "\x1b[98u", "\x1b[98;1:3u"]);
		});

		// 带事件子字段的箭头CSI同样应完整通过；此处只测字符串结构边界。
		it("should handle Kitty arrow keys with event type", () => {
			// Up arrow press with event type
			// CSI1;1:1A是一种显式箭头press编码。
			processInput("\x1b[1;1:1A");
			// 单条保留冒号/分号与A终止符。
			assert.deepStrictEqual(emittedSequences, ["\x1b[1;1:1A"]);
		});

		// 功能键Delete的显式release编码完整通过，不因为结尾~而与u形式混淆。
		it("should handle Kitty functional keys with event type", () => {
			// Delete key release
			// CSI3;1:3~为本例Delete松开串。
			processInput("\x1b[3;1:3~");
			// 完整编码恰好一项。
			assert.deepStrictEqual(emittedSequences, ["\x1b[3;1:3~"]);
		});

		// WezTerm回归：原始ESC后紧跟以ESC开头的松开CSI，应拆独立Escape和完整松开，而非将双ESC误当Alt+Escape；检查原始分段。
		it("should split ESC+ESC+CSI into standalone ESC and the CSI sequence (WezTerm Escape key regression)", () => {
			// WezTerm with enable_kitty_keyboard sends Escape key press as raw \x1b
			// and the release as a full Kitty CSI-u sequence, concatenated.
			// The buffer must not treat \x1b\x1b as a complete meta-key when the
			// following byte starts a new escape sequence.
			// 双ESC后接[，触发“第二ESC是新CSI开头”的特例；129为携带锁定位的修饰编码。
			processInput("\x1b\x1b[27;129:3u");
			// 第一项只一个ESC，第二项保留整个27;129:3u松开事件。
			assert.deepStrictEqual(emittedSequences, ["\x1b", "\x1b[27;129:3u"]);
		});

		// 同一双ESC特例在没有NumLock位时也应成立，避免只覆盖129这一种修饰值。
		it("should split ESC+ESC+CSI with no modifier (no num_lock)", () => {
			// 修饰编码1替换129，其余仍是Escape松开CSI。
			processInput("\x1b\x1b[27;1:3u");
			// 仍拆成独立ESC和完整CSI两项。
			assert.deepStrictEqual(emittedSequences, ["\x1b", "\x1b[27;1:3u"]);
		});

		// 只有双ESC且后面没有新序列引导时，仍按原有两单元Meta形式完整发出，不应无条件拆成两次Escape。
		it("should still emit ESC+ESC as a single sequence when not followed by a new escape", () => {
			// \x1b\x1b alone (no following CSI) stays as-is — e.g. ctrl+alt+[
			// 没有第三字符，提取器无法用已知引导判断第二个ESC属于新序列。
			processInput("\x1b\x1b");
			// 输出一条双ESC原串，不是两项。
			assert.deepStrictEqual(emittedSequences, ["\x1b\x1b"]);
		});

		// 普通a与Kitty a松开串相邻，前者单字符、后者整体；不因两者都关联a就去重松开事件。
		it("should handle plain characters mixed with Kitty sequences", () => {
			// Plain 'a' followed by Kitty release
			// 原始a在前，带分号的release编码在后。
			processInput("a\x1b[97;1:3u");
			// 保留两项，去重规则不是任意相同键身份去重。
			assert.deepStrictEqual(emittedSequences, ["a", "\x1b[97;1:3u"]);
		});

		// 无显式修饰的Kitty码点224后紧接对应原始à，应只保留CSI-u；此有限去重针对一次紧邻重复，非所有重复打字。
		it("should drop raw duplicate character after matching Kitty printable sequence", () => {
			// 224是à的码点，原始字符是单个UTF-16单元，可与记住码点比较。
			processInput("\x1b[224uà");
			// 原始à被丢一次，完整CSI-u仍发出。
			assert.deepStrictEqual(emittedSequences, ["\x1b[224u"]);
		});

		// 紧邻重复跨两次process调用也应去掉，证明去重候选不局限于同一个输入片段。
		it("should drop raw duplicate character after matching Kitty printable sequence across chunks", () => {
			// 先处理无修饰64u，记住码点64。
			processInput("\x1b[64u");
			// 下一片只有对应@，命中候选并清掉这一次待去重记录。
			processInput("@");
			// 事件列表只有前一条CSI-u。
			assert.deepStrictEqual(emittedSequences, ["\x1b[64u"]);
		});

		// 无修饰a编码后跟不同的b应保留两条；去重必须比码点，不能看见CSI-u就丢后一个普通字符。
		it("should keep non-matching plain character after Kitty printable sequence", () => {
			// 先码点97、后原始b，两者不同。
			processInput("\x1b[97ub");
			// 预期完整CSI-u和b都在。
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u", "b"]);
		});

		// 带显式修饰字段的CSI-u不建立这一简化去重候选，后续@应保留；不等同于验证所有修饰组合。
		it("should keep raw character after modified Kitty printable sequence", () => {
			// 64;3u带Alt修饰编码，尽管主码点是@也不按无修饰分支去重。
			processInput("\x1b[64;3u@");
			// 完整编码与原始@分别发出。
			assert.deepStrictEqual(emittedSequences, ["\x1b[64;3u", "@"]);
		});

		// 以hi快速打字的按下/松开混批样例检查4条分段，所有步骤同步；名称rapid并非性能或真实打字时序测试。
		it("should handle rapid typing simulation with Kitty protocol", () => {
			// Simulates typing "hi" quickly with releases interleaved
			// 104是h、105是i，分别夹各自release。
			processInput("\x1b[104u\x1b[104;1:3u\x1b[105u\x1b[105;1:3u");
			// 完整事件顺序为h按/h松/i按/i松。
			assert.deepStrictEqual(emittedSequences, ["\x1b[104u", "\x1b[104;1:3u", "\x1b[105u", "\x1b[105;1:3u"]);
		});
	});

	// 鼠标组仅检查SGR与旧X10序列边界，不进行坐标命中、点击计数或实际屏幕选择。
	describe("Mouse Events", () => {
		// SGR左键press样例应完整通过，未要求宿主真正聚焦或点击组件。
		it("should handle mouse press event", () => {
			// 0是左键按钮值，M结尾表示按下形式，列10行5只是载荷。
			processInput("\x1b[<0;10;5M");
			// 原串整体作为一项。
			assert.deepStrictEqual(emittedSequences, ["\x1b[<0;10;5M"]);
		});

		// 小写m释放样例也应完整通过，不能把它当普通尾字母。
		it("should handle mouse release event", () => {
			// 与前例相比只换结束符m。
			processInput("\x1b[<0;10;5m");
			// 保留整条释放串。
			assert.deepStrictEqual(emittedSequences, ["\x1b[<0;10;5m"]);
		});

		// SGR带移动位的样例整体通过；本层不把它转成TuiMouseEvent对象。
		it("should handle mouse move event", () => {
			// 35含移动位和无按钮低位，终止m仍按输入原样保存。
			processInput("\x1b[<35;20;5m");
			// 只断言完整原串，不检查真实鼠标是否处于该状态。
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;20;5m"]);
		});

		// SGR数字/分隔符本身也可以跨片，补齐后应为按钮35/列15/行10；中途不因片段结束而提前发出。
		it("should handle split mouse events", () => {
			// 首片含按钮值首位3。
			processInput("\x1b[<3");
			// 补按钮个位5和列号首位1。
			processInput("5;1");
			// 补列号个位5和第二分隔符。
			processInput("5;");
			// 补行号10及释放m。
			processInput("10m");
			// 整条拼接值必须准确，片段边界不进入输出。
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;15;10m"]);
		});

		// 三条SGR在同批中分别提取，不能因为共享前缀就合并或丢掉后两条。
		it("should handle multiple mouse events", () => {
			// 坐标从1,1到2,2再到3,3的三个完整字符串。
			processInput("\x1b[<35;1;1m\x1b[<35;2;2m\x1b[<35;3;3m");
			// 预期三项按原顺序保留。
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;1;1m", "\x1b[<35;2;2m", "\x1b[<35;3;3m"]);
		});

		// 旧X10鼠标前缀ESC[M后固定取3载荷单元，本ASCII样例总6单元；剩余c必须作为普通输入，不测试非ASCII字节解码。
		it("should handle old-style mouse sequence (ESC[M + 3 bytes)", () => {
			// 前缀后是空格、a、b三个载荷，再接普通c。
			processInput("\x1b[M abc");
			// 第一项恰到b，c单独发出。
			assert.deepStrictEqual(emittedSequences, ["\x1b[M ab", "c"]);
		});

		// 旧鼠标串分片到齐前应保留完整前缀和已有载荷，第三载荷b到来后才发完整事件。
		it("should buffer incomplete old-style mouse sequence", () => {
			// 仅ESC[M，尽管M通常可终止CSI，旧鼠标特例仍需后3单元。
			processInput("\x1b[M");
			// 检查前缀尚在普通缓冲。
			assert.strictEqual(buffer.getBuffer(), "\x1b[M");

			// 加入空格与a，还缺第三个载荷单元。
			processInput(" a");
			// 确认没有把这两个载荷提前当普通输入。
			assert.strictEqual(buffer.getBuffer(), "\x1b[M a");

			// 最后载荷b补齐固定长度。
			processInput("b");
			// 整体发出ESC[M+空格+a+b。
			assert.deepStrictEqual(emittedSequences, ["\x1b[M ab"]);
		});
	});

	// 边界组检查空串、孤立ESC、显式flush、Node Buffer和较长CSI；这些样例不代表任意破损编码都有完整恢复保证。
	describe("Edge Cases", () => {
		// 当前普通缓冲为空时喂空串，按实现仍应发一条空data，不把它默默忽略。
		it("should handle empty input", () => {
			// 调用process空字符串，不是缺省参数或undefined。
			processInput("");
			// Empty string emits an empty data event
			// 预期一项空串，与零事件的空数组不同。
			assert.deepStrictEqual(emittedSequences, [""]);
		});

		// 孤立ESC同步不发，真实等待15ms后应按10ms默认发出Escape原串；并未调用matchesKey执行动作。
		it("should handle lone escape character with timeout", async () => {
			// 输入单ESC。
			processInput("\x1b");
			// 立即检查必须还在等待。
			assert.deepStrictEqual(emittedSequences, []);

			// After timeout, should emit
			// 给独立10ms超时执行机会，实际调度可更晚。
			await wait(15);
			// 输出只有一条ESC，没有补造其他字符。
			assert.deepStrictEqual(emittedSequences, ["\x1b"]);
		});

		// 默认普通序列50ms不应拖延独立ESC10ms，临时实例等20ms后检查并正常destroy；失败无finally保护该局部实例。
		it("flushes a lone escape promptly with the longer default sequence timeout", async () => {
			// 完全默认选项的新实例，和外层配置10ms普通超时不同。
			const defaultBuffer = new StdinBuffer();
			// 该实例有自己的记录数组。
			const defaultSequences: string[] = [];
			// 同步data监听，push结果由emit忽略。
			defaultBuffer.on("data", (sequence) => defaultSequences.push(sequence));

			// 单ESC选择独立10ms等待。
			defaultBuffer.process("\x1b");
			// 目标20ms等待小于默认序列50ms，但大于Escape10ms。
			await wait(20);
			// ESC已应发出，不必等到50ms。
			assert.deepStrictEqual(defaultSequences, ["\x1b"]);
			// 正常路径清局部实例等待与状态，非永久禁用。
			defaultBuffer.destroy();
		});

		// 不等超时而显式flush应返回半截ESC数组；flush不自动emit，本例只检查返回值，未额外断言事件数组仍空。
		it("should handle lone escape character with explicit flush", () => {
			// 先缓冲ESC并安排等待。
			processInput("\x1b");
			// 同步还没有data。
			assert.deepStrictEqual(emittedSequences, []);

			// flush取消等待、取出普通缓冲并清空，返回数组给调用者。
			const flushed = buffer.flush();
			// 返回值是含ESC的一项数组，不是直接字符串。
			assert.deepStrictEqual(flushed, ["\x1b"]);
		});

		// 合法ASCII控制串以Node Buffer输入也应解码并整体通过；不证明任意UTF-8跨Buffer边界无损，实际实现逐片toString。
		it("should handle buffer input", () => {
			// Buffer.from默认UTF-8把ASCII箭头序列编码为字节，本例没有拆开多字节字符。
			processInput(Buffer.from("\x1b[A"));
			// 输出与字符串路径相同的一项箭头。
			assert.deepStrictEqual(emittedSequences, ["\x1b[A"]);
		});

		// 包含50组1;参数的较长CSI仍以H终止并整体通过；只覆盖此长度，不证明任意长输入的性能/内存上限。
		it("should handle very long sequences", () => {
			// 模板repeat生成长参数段，不真实执行光标定位。
			const longSeq = `\x1b[${"1;".repeat(50)}H`;
			// 一次输入完整长CSI。
			processInput(longSeq);
			// 要求完整保留为一项，没有内部截断。
			assert.deepStrictEqual(emittedSequences, [longSeq]);
		});
	});

	// flush组区分显式取回普通缓冲与超时回调取回后再emit的路径；flush本身不发data。
	describe("Flush", () => {
		// 半条SGR显式flush返回原余串并清普通缓冲，未要求把它变成合法鼠标动作。
		it("should flush incomplete sequences", () => {
			// 创建尚缺坐标/终止符的普通余串。
			processInput("\x1b[<35");
			// 显式取出并取消等待。
			const flushed = buffer.flush();
			// 返回原半截串，不重新拆为字符。
			assert.deepStrictEqual(flushed, ["\x1b[<35"]);
			// 普通缓冲被清空，后续片段不会继续拼接这条已取回余串。
			assert.strictEqual(buffer.getBuffer(), "");
		});

		// 没有待处理普通内容时flush应返回新空数组，不创造空data；与process空串的行为不同。
		it("should return empty array if nothing to flush", () => {
			// 初始实例没有喂输入，仍可安全调用flush。
			const flushed = buffer.flush();
			// 深比较为空数组，区别于含空字符串的一项数组。
			assert.deepStrictEqual(flushed, []);
		});

		// 超时路径内部先flush再emit，所以半截串等待15ms后会进入data记录；和显式flush仅返回数据的职责不同。
		it("should emit flushed data via timeout", async () => {
			// 喂半截鼠标序列，按外层配置启动10ms普通等待。
			processInput("\x1b[<35");
			// 立即尚无事件。
			assert.deepStrictEqual(emittedSequences, []);

			// Wait for timeout to flush
			// 真实等待给超时处理机会。
			await wait(15);

			// 超时回调已将取回的余串发给data监听器。
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35"]);
		});
	});

	// clear组验证主动放弃普通缓冲时不向监听器补发；实现还复位粘贴/去重状态，但本例只直接断言普通缓冲和事件。
	describe("Clear", () => {
		// 先保留半截串，再clear，要求普通缓冲为空且无data；不测clear后是否可复用或所有内部字段。
		it("should clear buffered content without emitting", () => {
			// 制造有待处理的半截鼠标串。
			processInput("\x1b[<35");
			// 确认测试前提：普通缓冲确有这段内容。
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			// 取消等待并放弃缓冲，清理不会自动通知data。
			buffer.clear();
			// 检查普通缓冲已空。
			assert.strictEqual(buffer.getBuffer(), "");
			// 事件列表仍空，区别于自动超时恢复。
			assert.deepStrictEqual(emittedSequences, []);
		});
	});

	// 括号粘贴组要求开始/结束标记包围的正文整体发paste，正文不逐键发data；它不访问系统剪贴板，也不把文本写入编辑器。
	describe("Bracketed Paste", () => {
		// 专门保存paste事件，初始化空数组，内层beforeEach每例会重新赋值。
		let emittedPaste: string[] = [];

		// 每个粘贴用例在外层准备后再换一份buffer，重新接data/paste监听；旧实例当时尚未喂输入，当前实例由外层afterEach清状态。
		beforeEach(() => {
			// 新实例普通序列10ms，粘贴正文等待本身不使用此普通超时。
			buffer = new StdinBuffer({ timeout: 10 });

			// Collect emitted sequences
			// 清本例普通事件记录。
			emittedSequences = [];
			// 仍监听data，便于证明粘贴正文没有泄漏为普通按键。
			buffer.on("data", (sequence) => {
				// 普通事件逐条追加到独立数组。
				emittedSequences.push(sequence);
			});

			// Collect paste events
			// 清本例粘贴正文记录。
			emittedPaste = [];
			// paste回调接不含标记的完整正文，事件触发时同步执行。
			buffer.on("paste", (data) => {
				// 整段正文只追加一项，不在这里按字符或换行再切分。
				emittedPaste.push(data);
			});
		});

		// 开始/正文/结束同批到达，要求paste只收到hello world且data为空；标记不应进入正文。
		it("should emit paste event for complete bracketed paste", () => {
			// CSI200~是括号粘贴开始，不是用户可见正文。
			const pasteStart = "\x1b[200~";
			// CSI201~是结束标记。
			const pasteEnd = "\x1b[201~";
			// 中间只是普通测试文本，不是从真实剪贴板读取。
			const content = "hello world";

			// 字符串拼接后一次喂入，解析器应在同次调用内发出完整paste。
			processInput(pasteStart + content + pasteEnd);

			// paste数组恰好一项纯正文。
			assert.deepStrictEqual(emittedPaste, ["hello world"]);
			// 粘贴边界与正文都没有成为data事件。
			assert.deepStrictEqual(emittedSequences, []); // No data events during paste
		});

		// 开始、正文前半、正文后半加结束分三片到达，结束之前不发paste，最后一次整体发出；无真实延时。
		it("should handle paste arriving in chunks", () => {
			// 仅开始标记让实例进入pasteMode。
			processInput("\x1b[200~");
			// 没有结束标记还不能提交粘贴正文。
			assert.deepStrictEqual(emittedPaste, []);

			// 加入hello和空格，暂存在pasteBuffer而非普通按键列表。
			processInput("hello ");
			// 仍不提前发出部分正文。
			assert.deepStrictEqual(emittedPaste, []);

			// 补world并紧跟完整结束标记。
			processInput("world\x1b[201~");
			// 合成hello world一条paste。
			assert.deepStrictEqual(emittedPaste, ["hello world"]);
			// 全过程data应仍空。
			assert.deepStrictEqual(emittedSequences, []);
		});

		// 粘贴前后普通a/b仍各自发data，中间pasted单独发paste；证明退出pasteMode后继续正常输入。
		it("should handle paste with input before and after", () => {
			// 粘贴开始前普通a立即发data。
			processInput("a");
			// 完整括号粘贴发paste正文，不发标记。
			processInput("\x1b[200~pasted\x1b[201~");
			// 粘贴结束后的b再次走普通data路径。
			processInput("b");

			// 普通事件列表只含a、b，保持顺序。
			assert.deepStrictEqual(emittedSequences, ["a", "b"]);
			// 粘贴列表只含中间正文。
			assert.deepStrictEqual(emittedPaste, ["pasted"]);
		});

		// 带LF的三行正文必须原样作为一段paste，不能变成三次回车/提交；本例不测试CRLF规范化，缓冲器也不主动trim。
		it("should handle paste with newlines", () => {
			// 把真实LF转义放在完整粘贴标记之间。
			processInput("\x1b[200~line1\nline2\nline3\x1b[201~");

			// 保留正文中的两个换行，没有拆为三条paste。
			assert.deepStrictEqual(emittedPaste, ["line1\nline2\nline3"]);
			// 换行也没有泄漏成data按键。
			assert.deepStrictEqual(emittedSequences, []);
		});

		// 粘贴Unicode正文作为整体保留，包含非BMP字符也不会走普通文本逐码元分发；这不证明任意UTF-8字节分片的解码。
		it("should handle paste with unicode", () => {
			// 直接传已解码的JS字符串，保留原测试中的汉字和非BMP符号，不读取任何外部文本。
			processInput("\x1b[200~Hello 世界 🎉\x1b[201~");

			// 检查整个正文原样成为唯一paste，包括空格与Unicode内容。
			assert.deepStrictEqual(emittedPaste, ["Hello 世界 🎉"]);
			// 正文没有另发data。
			assert.deepStrictEqual(emittedSequences, []);
		});
	});

	// destroy组只验证清普通缓冲与取消当前超时；源码实际委托clear，不移除监听器、不禁止后续process，不能从名字推断永久销毁。
	describe("Destroy", () => {
		// 先确认半截鼠标串存在，再destroy，要求getBuffer为空；不检查粘贴缓冲或重用行为。
		it("should clear buffer on destroy", () => {
			// 制造待处理普通余串。
			processInput("\x1b[<35");
			// 确认销毁前的普通缓冲值。
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			// destroy同步调用clear，放弃当前余串并取消任务。
			buffer.destroy();
			// getBuffer报告普通缓冲为空，不等同证明对象已无法再用。
			assert.strictEqual(buffer.getBuffer(), "");
		});

		// 半截串创建10ms任务后立刻destroy，等15ms也不能再补发data；仅覆盖这一待任务正常取消路径。
		it("should clear pending timeouts on destroy", async () => {
			// 创建普通半截串及其超时句柄。
			processInput("\x1b[<35");
			// 立刻清掉等待任务和状态。
			buffer.destroy();

			// Wait longer than timeout
			// 真实等待超过原10ms时长，检验已取消回调没有随后发出旧内容。
			await wait(15);

			// Should not have emitted anything
			// 仍无任何data事件；监听器本身并未被移除，只是没有输入/超时再触发它。
			assert.deepStrictEqual(emittedSequences, []);
		});
	});
});
