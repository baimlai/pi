// 用字符串样本回归图片行识别：含 Kitty/iTerm2 前缀即识别，不依赖当前终端能力。这里只调用判断函数，原文的 Integration/Crash 名称不代表真实运行了 read 工具、Image 组件或整条 TUI 崩溃链。
/**
 * Bug regression test for isImageLine() crash scenario
 *
 * Bug: When isImageLine() used startsWith() and terminal doesn't support images,
 * it would return false for lines containing image escape sequences, causing TUI to
 * crash with "Rendered line exceeds terminal width" error.
 *
 * Fix: Changed to use includes() to detect escape sequences anywhere in the line.
 *
 * This test demonstrates:
 * 1. The bug scenario with the old implementation
 * 2. That the fix works correctly
 */

// node:assert 可作为 assert(condition) 调用，也提供 strictEqual；每个 it 无参数、同步例正常返回 void、async 例返回 Promise，断言/导入失败交测试框架记录。
import assert from "node:assert";
// describe 分组、it 注册场景；没有创建真实终端、执行系统命令或读取图片文件。
import { describe, it } from "node:test";

// 顶层组按旧逻辑重现、新逻辑识别、模拟工具输出、长串与负例组织；作用是证明识别结果，不做完整图片协议合法性校验。
describe("Bug regression: isImageLine() crash with image escape sequences", () => {
	// 终端不支持图片的旧问题组：用 null 作为“不支持”的模拟输入，没有探测真实环境。
	describe("Bug scenario: Terminal without image support", () => {
		// 旧算法例：先在本地实现旧判断，再证明给 null 会漏掉图片串；名字里的 causing crash 是问题背景，此回调并未触发真实 TUI 崩溃。
		it("old implementation would return false, causing crash", () => {
			/**
			 * OLD IMPLEMENTATION (buggy):
			 * ```typescript
			 * export function isImageLine(line: string): boolean {
			 *   const prefix = getImageEscapePrefix();
			 *   return prefix !== null && line.startsWith(prefix);
			 * }
			 * ```
			 *
			 * When terminal doesn't support images:
			 * - getImageEscapePrefix() returns null
			 * - isImageLine() returns false even for lines containing image sequences
			 * - TUI performs width check on line containing 300KB+ of base64 data
			 * - Crash: "Rendered line exceeds terminal width (304401 > 115)"
			 */

			// Simulate old implementation behavior
			// 旧逻辑回调输入 line 和 string|null 前缀、返回 boolean，无外部副作用；例 prefix=null 时短路 false，不会执行 startsWith。此函数只供对照，不是当前生产实现。
			const oldIsImageLine = (line: string, imageEscapePrefix: string | null): boolean => {
				// !==null 保护 startsWith 的字符串参数，&& 短路；就算有正确前缀，只查行首也会漏有正文前缀的行。
				return imageEscapePrefix !== null && line.startsWith(imageEscapePrefix);
			};

			// When terminal doesn't support images, prefix is null
			// null 仅为旧函数参数样本，没有改变进程环境或全局终端能力缓存。
			const terminalWithoutImageSupport = null;

			// Line containing image escape sequence with text before it (common bug scenario)
			// 多行 const 赋值在下一行给出整条模拟输出，不是实际调用 read。
			const lineWithImageSequence =
				// 普通文字后嵌入 iTerm2 File 前缀和伪 base64，尺寸字段也只是样本文字，不读取/解码图片。
				"Read image file [image/jpeg]\x1b]1337;File=size=800,600;inline=1:base64data...\x07";

			// Old implementation would return false (BUG!)
			// 真正调用上面本地旧函数，传入无能力标记 null。
			const oldResult = oldIsImageLine(lineWithImageSequence, terminalWithoutImageSupport);
			// 多行实参属于同一次严格比较。
			assert.strictEqual(
				// 实际值为 oldResult。
				oldResult,
				// 期望严格 false，证明旧检测漏报。
				false,
				// 断言失败说明不会在成功时打印，不是正在产生的崩溃日志。
				"Bug: old implementation returns false for line containing image sequence when terminal has no image support",
			);
		});

		// 当前逻辑例：对同类正文后图片前缀应返回 true；async 只为保留原有模块加载写法，不会发网络请求。
		it("new implementation returns true correctly", async () => {
			// await import 在运行时加载本地模块并等待模块 Promise，解构取得函数；与文件顶部静态 import 的加载写法不同。
			const { isImageLine } = await import("../src/terminal-image.ts");

			// Line containing image escape sequence with text before it
			// 构造同一个问题形状的输出字符串。
			const lineWithImageSequence =
				// 伪 iTerm2 图片串前有说明文字，必须能查行内而不只行首。
				"Read image file [image/jpeg]\x1b]1337;File=size=800,600;inline=1:base64data...\x07";

			// New implementation should return true (FIX!)
			// 当前 isImageLine 查两种前缀，不看终端能力；此处不触发真实图形显示。
			const newResult = isImageLine(lineWithImageSequence);
			// 严格要求 true，只证明识别成功，不证明载荷有效或 TUI 一定无任何其他崩溃。
			assert.strictEqual(newResult, true, "Fix: new implementation returns true for line containing image sequence");
		});

		// Kitty 多位置例：各种文字前/后缀与巨大伪载荷仍应识别；并非全协议解析测试。
		it("new implementation detects Kitty sequences in any position", async () => {
			// 本地动态导入完成后再执行用例主体，异常作为 async 用例的拒绝传播。
			const { isImageLine } = await import("../src/terminal-image.ts");

			// 构造五个 Kitty 前缀样本，字符串本身不写终端。
			const scenarios = [
				// 虽标签写 At start，实际图形前缀前还有字样和空格；当前文件没有用这个样本单独验证真行首快路。
				"At start: \x1b_Ga=T,f=100,data...\x1b\\",
				// 短正文前缀后接 Kitty 控制外壳。
				"Prefix \x1b_Ga=T,data...\x1b\\",
				// 图片前后都有普通文本，仍应识别。
				"Suffix text \x1b_Ga=T,data...\x1b\\ suffix",
				// 另一中间位置样本。
				"Middle \x1b_Ga=T,data...\x1b\\ more text",
				// Very long line (simulating 300KB+ crash scenario)
				// 模板把 300000 个 A 拼入伪载荷，未补完整协议结尾也预期 true，因为识别只查前缀；是码元长度模拟，不是真读取 300KB 图片。
				`Text before \x1b_Ga=T,f=100${"A".repeat(300000)} text after`,
			];

			// for...of 依次检查各字符串，不执行里面的控制序列。
			for (const line of scenarios) {
				// 每项要求 true，失败信息只截前 50 码元避免把巨大样本全部输出。
				assert.strictEqual(isImageLine(line), true, `Should detect Kitty sequence in: ${line.slice(0, 50)}...`);
			}
		});

		// iTerm2 多位置例：File 前缀在行内各处都应识别，不要求完整合法图片参数或 base64。
		it("new implementation detects iTerm2 sequences in any position", async () => {
			// 同样只动态加载本地模块，没有网络 URL 导入。
			const { isImageLine } = await import("../src/terminal-image.ts");

			// 五个 iTerm2 样本组成数组。
			const scenarios = [
				// At start 标签同样占据行首，图片前缀实际在文字之后；不把用例名当精确字节布局。
				"At start: \x1b]1337;File=size=100,100:base64...\x07",
				// 普通前缀后 inline 字段与伪数据。
				"Prefix \x1b]1337;File=inline=1:data==\x07",
				// 图形串后保留后缀文字。
				"Suffix text \x1b]1337;File=inline=1:data==\x07 suffix",
				// 图形串位于更长正文中。
				"Middle \x1b]1337;File=inline=1:data==\x07 more text",
				// Very long line (simulating 304KB crash scenario)
				// repeat 构造 300000 个 B，未补 BEL/ST 仍应识别，仅测试前缀查找，不做载荷合法性保证。
				`Text before \x1b]1337;File=size=800,600;inline=1:${"B".repeat(300000)} text after`,
			];

			// 遍历输入数组的每个场景。
			for (const line of scenarios) {
				// 全部要求识别为 true，失败提示只保留前 50 码元。
				assert.strictEqual(isImageLine(line), true, `Should detect iTerm2 sequence in: ${line.slice(0, 50)}...`);
			}
		});
	});

	// 原组名 Integration：下方其实手写可能的工具/组件输出形状，没有实例化工具、调用 Image.render 或启动会话，不能据此声称全链路集成通过。
	describe("Integration: Tool execution scenario", () => {
		/**
		 * This simulates what happens when the `read` tool reads an image file.
		 * The tool result contains both text and image content:
		 *
		 * ```typescript
		 * {
		 *   content: [
		 *     { type: "text", text: "Read image file [image/jpeg]\n800x600" },
		 *     { type: "image", data: "base64...", mimeType: "image/jpeg" }
		 *   ]
		 * }
		 * ```
		 *
		 * When this is rendered, the image component creates escape sequences.
		 * If isImageLine() doesn't detect them, TUI crashes.
		 */

		// 模拟 read 输出例：人工拼文字和 iTerm2 前缀，验证识别；不读路径、不调用 read 工具回调。
		it("detects image sequences in read tool output", async () => {
			// await import 本地加载并取函数，函数调用发生在后面的断言，不在解构时执行。
			const { isImageLine } = await import("../src/terminal-image.ts");

			// Simulate output when read tool processes an image
			// The line might have text from the read result plus the image escape sequence
			// 这条固定样本文字只模仿工具结果渲染后的行，base64image... 是占位，不是图片文件内容。
			const toolOutputLine = "Read image file [image/jpeg]\x1b]1337;File=size=800,600;inline=1:base64image...\x07";

			// isImageLine 对此文本返回 true；描述里的 tool output 指样本来源形状，不证明工具真正执行。
			assert.strictEqual(isImageLine(toolOutputLine), true, "Should detect image sequence in tool output line");
		});

		// 模拟 Image 的 Kitty 输出例：判断手写控制串中前缀，未创建真实 Image 实例。
		it("detects Kitty sequences from Image component", async () => {
			// 动态加载同一模块，模块系统通常复用缓存实例，不是每次重新初始化整个包。
			const { isImageLine } = await import("../src/terminal-image.ts");

			// Kitty image component creates multi-line output with escape sequences
			// 手写两段 Kitty 风格 APC，含伪参数/数据；检测不校验这些字段的协议正确性。
			const kittyLine = "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\";

			// 即使报文只像示例，包含指定前缀就 true，不保证终端能成功绘图。
			assert.strictEqual(isImageLine(kittyLine), true, "Should detect Kitty image component output");
		});

		// ANSI 前置例：颜色/粗体控制串在图片前也不能影响行内前缀查找。
		it("handles ANSI codes before image sequences", async () => {
			// 本地模块导入的 Promise 由 async 用例等待，导入失败使该用例失败。
			const { isImageLine } = await import("../src/terminal-image.ts");

			// Line might have styling (error, warning, etc.) before image data
			// 三个带样式的模拟行，不先 strip ANSI，直接交图片前缀判断。
			const lines = [
				// 红色 Error、重置、正文后接 iTerm2 前缀。
				"\x1b[31mError\x1b[0m: \x1b]1337;File=inline=1:base64==\x07",
				// 黄色 Warning 后接 Kitty 前缀。
				"\x1b[33mWarning\x1b[0m: \x1b_Ga=T,data...\x1b\\",
				// 粗体文字后 iTerm2 前缀，再带样式重置。
				"\x1b[1mBold\x1b[0m \x1b]1337;File=:base64==\x07\x1b[0m",
			];

			// 逐行检查，原数组不变。
			for (const line of lines) {
				// 开始一次多行 strictEqual 调用。
				assert.strictEqual(
					// 当前行识别结果为实际值。
					isImageLine(line),
					// 期望严格 true。
					true,
					// 失败消息只截前 30 码元，不改变被测整条 line。
					`Should detect image sequence after ANSI codes: ${line.slice(0, 30)}...`,
				);
			}
		});
	});

	// 长串组：用内存构造问题形状并验证识别，不真正执行 TUI 宽度拒绝路径或捕获 Rendered line exceeds 错误。
	describe("Crash scenario simulation", () => {
		// 三十万以上码元例：函数应能识别而不因样本长度丢前缀；不设置运行耗时或分配上限。
		it("does NOT crash on very long lines with image sequences", async () => {
			// 仍为本地动态加载，未读取实际图片/终端。
			const { isImageLine } = await import("../src/terminal-image.ts");

			/**
			 * Simulate the exact crash scenario:
			 * - Line is 304,401 characters (the crash log showed 58649 > 115)
			 * - Contains image escape sequence somewhere in the middle
			 * - Old implementation would return false, causing TUI to do width check
			 * - New implementation returns true, skipping width check (preventing crash)
			 */

			// 先造 100 个 A 作重复块，变量名 base64Char 也不代表已验证的图像 base64。
			const base64Char = "A".repeat(100);
			// iTerm2 图片前缀及尺寸/inline 字段作为字符串常量。
			const iterm2Sequence = "\x1b]1337;File=size=800,600;inline=1:";

			// Build a line that would cause the crash
			// 用四段 + 续行拼长串，下面各行属于同一个赋值。
			const crashLine =
				// 普通文本前缀先出现，避免只测行首图片。
				"Output: " +
				// 随后拼 iTerm2 前缀。
				iterm2Sequence +
				// 100 字符块重复 3040 次，正文伪载荷 304000 个 ASCII 码元；原注释约数不是最终整串精确长度。
				base64Char.repeat(3040) + // ~304,000 chars
				// 最后追加普通文字后缀，没有补完整控制序列结尾，仍属于前缀识别场景。
				" end of output";

			// Verify line is very long
			// assert(condition,message) 检总码元数确实大于 300000，原提示 KB 是背景近似，不是独立字节/解码内存测量。
			assert(crashLine.length > 300000, "Test line should be > 300KB");

			// New implementation should detect it (prevents crash)
			// 对巨大字符串调用真实判断器，只取 boolean。
			const detected = isImageLine(crashLine);
			// 要求 true；这能防此处图片行漏识别，但不覆盖完整 TUI 实际宽度扫描/异常流程。
			assert.strictEqual(detected, true, "Should detect image sequence in very long line, preventing TUI crash");
		});

		// 58649 例：精确构造相同码元长度的长串，只模拟日志数量，不证明其显示列宽也等于这个数字。
		it("handles lines exactly matching crash log dimensions", async () => {
			// 等待本地模块加载并解构 isImageLine，导入失败会让当前异步用例失败。
			const { isImageLine } = await import("../src/terminal-image.ts");

			/**
			 * Crash log showed: line 58649 chars wide, terminal width 115
			 * Let's create a line with similar characteristics
			 */

			// 名为 targetWidth，实际此例用作最终 string.length 目标，不调用 visibleWidth。
			const targetWidth = 58649;
			// 四个 ASCII 码元 Text 作为前缀。
			const prefix = "Text";
			// 不完整 Kitty 风格前缀；无分号数据/结束符仍可识别，说明非完整协议校验。
			const sequence = "\x1b_Ga=T,f=100";
			// 三个 ASCII 码元 End 为后缀。
			const suffix = "End";
			// 目标减三部分码元长，repeat 剩余 A 补到指定长度，输入固定正数未触及非法 repeat 次数。
			const padding = "A".repeat(targetWidth - prefix.length - sequence.length - suffix.length);
			// 模板按前缀、图片序列、补白 A、后缀顺序拼成新串。
			const line = `${prefix}${sequence}${padding}${suffix}`;

			// 检 string.length 恰为 58649，不是测终端格数。
			assert.strictEqual(line.length, 58649);
			// 图片前缀在中间也必须 true。
			assert.strictEqual(isImageLine(line), true, "Should detect image sequence in 58649-char line");
		});
	});

	// 负例组：无指定完整前缀的长文本/普通路径不应误识别；不读取文件系统，也不是穷举所有误报输入。
	describe("Negative cases: Don't false positive", () => {
		// 普通巨大文本例：仅仅很长不能当作图片。
		it("does not detect images in regular long text", async () => {
			// 加载本地模块，未启用真实终端图形能力。
			const { isImageLine } = await import("../src/terminal-image.ts");

			// Very long line WITHOUT image sequences
			// 构造十万个 ASCII A，完全没有 ESC 图形前缀。
			const longText = "A".repeat(100000);

			// 结果必须 false；不把“超过某长度”作为图片启发式。
			assert.strictEqual(isImageLine(longText), false, "Should not detect images in plain long text");
		});

		// 路径例：1337、File、_G 等普通字符相似片段没有 ESC 外壳，均不该识别。
		it("does not detect images in lines with file paths", async () => {
			// 同样只加载本地函数，不 import 任何 URL/图片。
			const { isImageLine } = await import("../src/terminal-image.ts");

			// 固定路径数组只当字符串，不去查这些文件是否存在。
			const filePaths = [
				// 路径含 1337 数字，不等于 ESC]1337;File= 前缀。
				"/path/to/1337/image.jpg",
				// 文件名含 File 字样，不足以匹配协议。
				"/usr/local/bin/File_converter",
				// 另一个 1337File 普通文件名。
				"~/Documents/1337File_backup.png",
				// 含 _G 的文件名也缺真正 ESC_G 图片起点。
				"./_G_test_file.txt",
			];

			// for...of 变量 path 是一条字符串，不是 fs 调用的参数。
			for (const path of filePaths) {
				// 每条必须 false，失败提示插原路径只是为定位样本。
				assert.strictEqual(isImageLine(path), false, `Should not falsely detect image sequence in path: ${path}`);
			}
		});
	});
});
