// 验证图片前缀识别、终端能力、协议字符串、格数/裁剪及组件回退。所有控制码保留在内存断言中，不发送给用户终端。
// fixture 指为测试准备的输入和环境；OSC/APC 是终端控制字符串类别，SGR 是颜色等样式控制，ST/BEL 是这里使用的结束标记。
// 环境 fixture、能力缓存、格像素尺寸和转码器会在测试进程内变化；这不是实际终端兼容性、图片解码或像素显示测试。
/**
 * Tests for terminal image detection and line handling
 */

// Node 断言库：strictEqual 比较值，deepStrictEqual 比较对象/数组结构；失败时抛错使当前用例失败。
import assert from "node:assert";
// 取得本机 home 路径，只用于构造显示路径，不读取图片文件。
import { homedir } from "node:os";
// 按本机路径规则拼接文件名，不访问磁盘。
import { join } from "node:path";
// describe/it 声明测试组与用例；beforeEach/afterEach 为相应组的每项用例设置和清理共享状态。
import { afterEach, beforeEach, describe, it } from "node:test";
// Image 将图片数据变成终端输出行；setImageTranscoder 安装同步内存转换回调，本文件不会调用真实图像解码器。
import { Image, setImageTranscoder } from "../src/components/image.ts";
// 从真实图片模块导入待测函数；命名导入不代表已经检测能力或向终端写入。
import {
	// 把格行裁剪要求换算成 Kitty 源像素区域，改写协议头。
	cropKittyImageLine,
	// 生成删除全部可见图片及数据的 Kitty 命令字符串。
	deleteAllKittyImages,
	// 生成只删除放置、保留上传数据的 Kitty 命令字符串。
	deleteAllKittyPlacements,
	// 生成按 ID 删除图片及数据的命令字符串。
	deleteKittyImage,
	// 依据环境变量和可注入的 tmux 探测回调计算能力，不使用 getCapabilities 的结果缓存。
	detectCapabilities,
	// 把 base64 和显示选项编码成 iTerm2 OSC 1337 字符串。
	encodeITerm2,
	// 把数据编码成 Kitty APC 命令，长载荷会分块。
	encodeKitty,
	// 读取或初始化共享能力缓存，并应用程序覆盖值。
	getCapabilities,
	// 依据 Kitty 头内的图片 ID 读取已登记的原始尺寸和格数。
	getKittyImageMetadata,
	// 从完整上传串提取不含载荷的放置命令及传输成本估算。
	getKittyImagePlacement,
	// 优先读协议头显式行数，没有时才查登记值。
	getKittyImagePlacementRows,
	// 生成 OSC 8 超链接字符串，不会打开链接。
	hyperlink,
	// 生成图片不可显示时的文字说明，可把绝对路径包成 file: 链接。
	imageFallback,
	// 识别字符串中是否含图片协议前缀，不验证图片是否完整或终端是否支持。
	isImageLine,
	// 把图片 ID、像素和格数登记到进程内共享表。
	registerKittyImageMetadata,
	// 按能力和格预算生成图片控制串/行列数，Kitty 显式 ID 还会登记元数据。
	renderImage,
	// 仅清能力结果缓存，不清图片元数据表、覆盖值或单格像素尺寸。
	resetCapabilitiesCache,
	// 直接指定当前能力缓存，避免本组渲染触发真实环境探测。
	setCapabilities,
	// 替换程序级覆盖值并在必要时清能力缓存；空对象表示撤销这些覆盖。
	setCapabilityOverrides,
	// 设置一个终端字符格对应的像素宽高，用于图片尺寸换算。
	setCellDimensions,
} from "../src/terminal-image.ts";
// 计算可见格宽，忽略支持的 ANSI 控制序列；用于验证回退文字没有超出列预算。
import { visibleWidth } from "../src/utils.ts";

// 列出 fixture 会保存、暂时删除、最终恢复的环境键，隔离启动测试时的真实终端线索。
const ENV_KEYS = [
	// 终端类型，例如 xterm、tmux 或 screen。
	"TERM",
	// 终端程序名，例如 Ghostty、Rex、iTerm。
	"TERM_PROGRAM",
	// Orca 明确声明图片协议的变量。
	"ORCA_IMAGE_PROTOCOL",
	// JetBrains 等终端模拟器身份。
	"TERMINAL_EMULATOR",
	// truecolor/24bit 等颜色能力提示。
	"COLORTERM",
	// tmux 会话线索；本文件相关探测均注入回调或由显式覆盖绕过。
	"TMUX",
	// Kitty 窗口标识，有真值即成为能力线索。
	"KITTY_WINDOW_ID",
	// Ghostty 资源路径存在性线索，测试不会读取该路径。
	"GHOSTTY_RESOURCES_DIR",
	// WezTerm pane 标识，字符串 "0" 也有真值。
	"WEZTERM_PANE",
	// iTerm 会话身份。
	"ITERM_SESSION_ID",
	// Windows Terminal 会话身份，测试只伪造变量，不启动 Windows Terminal。
	"WT_SESSION",
	// cmux 工作区身份，用于检查不会错误禁用 Ghostty 图片。
	"CMUX_WORKSPACE_ID",
	// 一种 Warp 会话身份。
	"WARP_SESSION_ID",
	// 另一种 Warp 会话 UUID 变量。
	"WARP_TERMINAL_SESSION_UUID",
	// 用户显式开启/关闭超链接或使用 auto。
	"PI_HYPERLINKS",
	// 用户指定 kitty/iterm2/none/auto 图片策略。
	"PI_IMAGE_PROTOCOL",
	// 用户显式开启/关闭真彩色或使用 auto。
	"PI_TRUE_COLOR",
	// as const 使 TypeScript 保留每个字符串字面量，并把数组视为只读元组；运行时不会自动冻结数组。
] as const;

// 在隔离的环境变量下同步执行 fn，返回它的结果；例如 withEnv({TERM_PROGRAM:"ghostty"}, detectCapabilities)。
// 先保存/清除清单内的键，再应用 overrides，finally 恢复清单；fn 抛错会继续向外传播。只恢复 ENV_KEYS，不能拿它安全覆盖任意额外键。
// <T> 把回调结果类型传递给返回值，Record 表示字符串索引对象；类型本身不校验运行时输入。这里回调均同步，若返回 Promise，环境会在等待 Promise 前恢复。
function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
	// 保存旧值的字典；undefined 表示原先没有该环境键，空字符串则仍是一个实际值。
	const saved: Record<string, string | undefined> = {};
	// for...of 按清单逐项处理键，key 的编译期类型是清单字符串的联合。
	for (const key of ENV_KEYS) {
		// 记住旧环境值，不把 undefined 转成字符串。
		saved[key] = process.env[key];
		// delete 真正移除键，使测试只看到显式提供的终端线索。
		delete process.env[key];
	}
	// 把覆盖和回调放进 try，确保同步抛错也进入 finally。
	try {
		// Object.entries 得到键值对；[k,v] 是数组解构，不是另一次环境查询。
		for (const [k, v] of Object.entries(overrides)) {
			// 覆盖值为 undefined 时明确删除，而不是写入字面字符串 "undefined"。
			if (v === undefined) delete process.env[k];
			// 其他字符串值写进本进程环境，空串也会保留。
			else process.env[k] = v;
		}
		// 执行回调并返回其结果，例如能力对象；不捕获或改写它的异常。
		return fn();
		// finally 在正常返回和同步异常时都会运行。
	} finally {
		// 只遍历保存清单恢复状态，overrides 中清单外的键不在此恢复。
		for (const key of ENV_KEYS) {
			// 原本不存在的变量再次删除。
			if (saved[key] === undefined) delete process.env[key];
			// 原本存在的变量恢复原字符串，包括空字符串。
			else process.env[key] = saved[key];
		}
	}
}

// 图片行识别组：输入包含/不包含协议前缀的字符串，断言布尔值；只测前缀搜索，不做文件解码或终端能力查询。
describe("isImageLine", () => {
	// iTerm2 组检查前缀在开头、中间、结尾及最短形式；测试载荷只是占位文字。
	describe("iTerm2 image protocol", () => {
		// 输入以 iTerm2 前缀开头的示例，要求识别为图片行；无终端输出。
		it("should detect iTerm2 image escape sequence at start of line", () => {
			// iTerm2 image escape sequence: ESC ]1337;File=...
			// \x1b 是 ESC，\x07 是 BEL；这里字段/载荷只用于前缀识别，不能据此认定合法 iTerm2 图片。
			const iterm2ImageLine = "\x1b]1337;File=size=100,100;inline=1:base64encodeddata==\x07";
			// 严格断言返回 true，覆盖开头快速路径。
			assert.strictEqual(isImageLine(iterm2ImageLine), true);
		});

		// 模拟同一行先有正文再有图片；断言搜索不能只检查字符串开头。
		it("should detect iTerm2 image escape sequence with text before it", () => {
			// Simulating a line that has text then image data (bug scenario)
			// 图片前后都保留普通文字，使目标前缀处于行中。
			const lineWithTextAndImage = "Some text \x1b]1337;File=size=100,100;inline=1:base64data==\x07 more text";
			// 行中包含目标前缀也必须返回 true。
			assert.strictEqual(isImageLine(lineWithTextAndImage), true);
		});

		// 把图片前缀夹在两段文字中，验证拼接后的字符串仍能识别；此项没有结束 BEL，说明识别不要求完整命令。
		it("should detect iTerm2 image escape sequence in middle of long line", () => {
			// Simulate a very long line with image data in the middle
			// 多行写法仍然只是一个 const 初始化表达式。
			const longLineWithImage =
				// 三个字符串用 + 连接成单个输入，前缀不在第一个字符。
				"Text before image..." + "\x1b]1337;File=inline=1:verylongbase64data==" + "...text after";
			// 只检查包含前缀的布尔结果，没有检查命令语法或图像内容。
			assert.strictEqual(isImageLine(longLineWithImage), true);
		});

		// 把带 BEL 的示例放在普通文字后，确认图片位于行尾仍可识别。
		it("should detect iTerm2 image escape sequence at end of line", () => {
			// 行尾图片段从 ESC 开始，以 BEL 结束，前面是普通文字。
			const lineWithImageAtEnd = "Regular text ending with \x1b]1337;File=inline=1:base64data==\x07";
			// 断言行尾位置不会遗漏。
			assert.strictEqual(isImageLine(lineWithImageAtEnd), true);
		});

		// 空字段/空载荷的最小示例仍含完整识别前缀；此测试阐明函数不是完整协议验证器。
		it("should detect minimal iTerm2 image escape sequence", () => {
			// 冒号后没有图片数据，仍构造出需要识别的前缀。
			const minimalImageLine = "\x1b]1337;File=:\x07";
			// 有前缀就为 true，并不证明空图能被真实终端显示。
			assert.strictEqual(isImageLine(minimalImageLine), true);
		});
	});

	// Kitty 组使用 ESC_G 前缀；同样不解码载荷或验证后续控制字段。
	describe("Kitty image protocol", () => {
		// 把 Kitty 示例放在字符串开头，验证对应快速识别路径。
		it("should detect Kitty image escape sequence at start of line", () => {
			// Kitty image escape sequence: ESC _G
			// \x1b_G 开始 APC 图形命令，\x1b\\ 是字符串终止符；示例不是完整有效图片文件。
			const kittyImageLine = "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			// 只要求 Kitty 前缀被识别，不验证两段命令是否合法。
			assert.strictEqual(isImageLine(kittyImageLine), true);
		});

		// 模拟工具输出文字与 Kitty 数据同行，覆盖非开头搜索。
		it("should detect Kitty image escape sequence with text before it", () => {
			// Bug scenario: text + image data in same line
			// Output: 前缀让 Kitty 片段从中间开始。
			const lineWithTextAndKittyImage = "Output: \x1b_Ga=T,f=100;data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			// 正文不会使图片前缀识别失败。
			assert.strictEqual(isImageLine(lineWithTextAndKittyImage), true);
		});

		// 在 Kitty 片段两侧加入空格，验证仍可识别；实际实现直接搜索前缀，无需先 trim。
		it("should detect Kitty image escape sequence with padding", () => {
			// Kitty protocol adds padding to escape sequences
			// 前后各两个空格是测试填充，不是这里额外编码 Kitty 的规则。
			const kittyWithPadding = "  \x1b_Ga=T,f=100...\x1b\\\x1b_Gm=i=1;\x1b\\  ";
			// 有填充仍返回 true。
			assert.strictEqual(isImageLine(kittyWithPadding), true);
		});
	});

	// 回归组针对长行、混合正文和 ANSI 样式；通过这些固定例子不等于所有任意输入都已覆盖。
	describe("Bug regression tests", () => {
		// 构造三十万字符以上的图片行并检查仍可识别，避免依赖昂贵的全行复杂匹配；实际断言只要求长度大于300000。
		it("should detect image sequences in very long lines (304k+ chars)", () => {
			// This simulates the crash scenario: a line with 304,401 chars
			// containing image escape sequences somewhere
			// repeat(100) 得到100个 A，作为类似 base64 的占位段，不是真的图片。
			const base64Char = "A".repeat(100); // 100 chars of base64-like data
			// 图片协议头只放一次，后面接大载荷字符串。
			const imageSequence = "\x1b]1337;File=size=800,600;inline=1:";

			// Build a long line with image sequence
			// 把前缀、图片头、长载荷和后缀连成同一条字符串。
			const longLine =
				// 普通文本位于图片头之前，覆盖中间搜索路径。
				"Text prefix " +
				// 接入 iTerm2 图片前缀。
				imageSequence +
				// 100字符片段重复3000次，生成300000字符的载荷部分。
				base64Char.repeat(3000) + // ~300,000 chars
				// 尾部再有普通文字，整串没有实际发送给终端。
				" suffix";

			// 先验证 fixture 确实达到预期数量级，不精确验证英文注释所述历史长度。
			assert.strictEqual(longLine.length > 300000, true);
			// 大行中仍识别为图片行；这里没有测耗时上限或内存上限。
			assert.strictEqual(isImageLine(longLine), true);
		});

		// 验证含图片前缀的历史混合文本；此用例没有设置“不支持图片”的能力对象，实际断言范围只是字符串识别。
		it("should detect image sequences when terminal doesn't support images", () => {
			// The bug occurred when getImageEscapePrefix() returned null
			// isImageLine should still detect image sequences regardless
			// 工具说明文字后跟 iTerm2 前缀，MIME 文字不是检测依据。
			const lineWithImage = "Read image file [image/jpeg]\x1b]1337;File=inline=1:base64data==\x07";
			// 返回 true；从被测实现可知它不依赖能力缓存，本用例本身没有额外模拟能力。
			assert.strictEqual(isImageLine(lineWithImage), true);
		});

		// 把 SGR 颜色控制放在图片前，检查 ANSI 样式不会遮住后续图片前缀。
		it("should detect image sequences with ANSI codes before them", () => {
			// Text might have ANSI styling before image data
			// ESC[31m 是红色样式，而后面的 ESC]1337 才是本次图片识别目标。
			const lineWithAnsiAndImage = "\x1b[31mError output \x1b]1337;File=inline=1:image==\x07";
			// 断言中间图片段仍被发现，不验证红色是否实际显示。
			assert.strictEqual(isImageLine(lineWithAnsiAndImage), true);
		});

		// 把样式复位控制放在 Kitty 后，确认后缀不会改变识别结果。
		it("should detect image sequences with ANSI codes after them", () => {
			// 图片示例、第二个 Kitty 片段、SGR 复位和文字拼在同一行。
			const lineWithImageAndAnsi = "\x1b_Ga=T,f=100:data...\x1b\\\x1b_Gm=i=1;\x1b\\\x1b[0m reset";
			// 只断言存在目标前缀，不要求该示例控制字段有效。
			assert.strictEqual(isImageLine(lineWithImageAndAnsi), true);
		});
	});

	// 负例组检查普通文本及其他控制码不会仅因“像协议”就成为图片行。
	describe("Negative cases - lines without images", () => {
		// 普通纯文本没有两个图片前缀，结果应为 false。
		it("should not detect images in plain text lines", () => {
			// 提供不含任何 ESC 的普通句子。
			const plainText = "This is just a regular text line without any escape sequences";
			// 验证纯文本不被识别为图片。
			assert.strictEqual(isImageLine(plainText), false);
		});

		// 只有颜色 SGR 的行仍是文字，不能把所有 ANSI 控制都当图片。
		it("should not detect images in lines with only ANSI codes", () => {
			// 红/绿文本含 ESC[...m，但没有 ESC_G 或 ESC]1337;File=。
			const ansiText = "\x1b[31mRed text\x1b[0m and \x1b[32mgreen text\x1b[0m";
			// 颜色控制本身不触发图片识别。
			assert.strictEqual(isImageLine(ansiText), false);
		});

		// 光标移动/清行也不是图片协议，输入这些 CSI 控制要求 false。
		it("should not detect images in lines with cursor movement codes", () => {
			// ESC[1A 上移、ESC[2K 清行只存在于内存测试字符串。
			const cursorCodes = "\x1b[1A\x1b[2KLine cleared and moved up";
			// 断言 CSI 控制不会被错认。
			assert.strictEqual(isImageLine(cursorCodes), false);
		});

		// 只写出可见的 iTerm2 关键词而缺 ESC，必须不匹配。
		it("should not detect images in lines with partial iTerm2 sequences", () => {
			// Similar prefix but missing the complete sequence
			// 缺少真正 ESC 字节，也没有完整 File= 前缀。
			const partialSequence = "Some text with ]1337;File but missing ESC at start";
			// 类似文字不等于协议起始序列。
			assert.strictEqual(isImageLine(partialSequence), false);
		});

		// 只包含 _G 文字而缺 ESC，必须不匹配 Kitty。
		it("should not detect images in lines with partial Kitty sequences", () => {
			// Similar prefix but missing the complete sequence
			// 这是普通字符串中的下划线字母组合。
			const partialSequence = "Some text with _G but missing ESC at start";
			// 要求完整 ESC_G 前缀才可命中。
			assert.strictEqual(isImageLine(partialSequence), false);
		});

		// 空输入直接检查为非图片，不要求非空前置条件。
		it("should not detect images in empty lines", () => {
			// 空字符串没有可匹配的前缀。
			assert.strictEqual(isImageLine(""), false);
		});

		// 分别测试一个和两个换行；换行本身不是图形命令。
		it("should not detect images in lines with newlines only", () => {
			// 一个换行返回 false。
			assert.strictEqual(isImageLine("\n"), false);
			// 两个换行同样返回 false。
			assert.strictEqual(isImageLine("\n\n"), false);
		});
	});

	// 混合内容组检查多个协议/多段图片的“是否存在”，不统计数量或拆解每张图。
	describe("Mixed content scenarios", () => {
		// 一行同时含 Kitty/iTerm2 前缀，只要发现任一即可返回 true。
		it("should detect images when line has both Kitty and iTerm2 sequences", () => {
			// 两种协议示例与标签文字组合，载荷仍为占位内容。
			const mixedLine = "Kitty: \x1b_Ga=T...\x1b\\\x1b_Gm=i=1;\x1b\\ iTerm2: \x1b]1337;File=inline=1:data==\x07";
			// 只断言布尔值，没有断言优先识别哪种协议。
			assert.strictEqual(isImageLine(mixedLine), true);
		});

		// 两张 iTerm2 示例分散在文字间，仍应视作图片行。
		it("should detect image in line with multiple text and image segments", () => {
			// Start/middle/end 把两个图片段隔开。
			const complexLine = "Start \x1b]1337;File=img1==\x07 middle \x1b]1337;File=img2==\x07 end";
			// 无需解析所有片段，只需确认存在图片前缀。
			assert.strictEqual(isImageLine(complexLine), true);
		});

		// 路径中含 File/1337 等字样但无 ESC，检查关键词不会引起误报。
		it("should not falsely detect image in line with file path containing keywords", () => {
			// File path might contain "1337" or "File" but without escape sequences
			// 路径只作普通文本，不读取该图片文件。
			const filePathLine = "/path/to/File_1337_backup/image.jpg";
			// 关键词相似仍返回 false。
			assert.strictEqual(isImageLine(filePathLine), false);
		});
	});
});

// 能力检测组临时覆盖环境、调用真实分支并断言返回对象。tmux 相关回调为内存假值，不运行真实 tmux。
describe("detectCapabilities", () => {
	// 清除已知终端线索后检查默认关闭链接/图片；未断言 trueColor，因为其默认还受平台影响。
	it("defaults to hyperlinks: false for unknown terminals", () => {
		// 空 overrides 表示在清单内所有变量均不存在的环境同步执行回调。
		withEnv({}, () => {
			// 重新计算能力而不是从共享缓存读取。
			const caps = detectCapabilities();
			// 未知终端默认不启用超链接。
			assert.strictEqual(caps.hyperlinks, false);
			// 未知终端没有图片协议，null 与 false 的类型含义不同。
			assert.strictEqual(caps.images, null);
		});
	});

	// 用明确的1/0/none变量覆盖自动检测，比较全部三个字段；例如 iTerm 身份也会被 none 关闭图片。
	it("applies environment overrides", () => {
		// 先比较显式开启时的完整能力对象。
		assert.deepStrictEqual(
			// 在同步 fixture 中返回检测结果；三个环境字段强制开启对应能力。
			withEnv({ PI_HYPERLINKS: "1", PI_IMAGE_PROTOCOL: "kitty", PI_TRUE_COLOR: "1" }, () => detectCapabilities()),
			// 预期选择 Kitty、真彩色和链接全部开启。
			{ images: "kitty", trueColor: true, hyperlinks: true },
		);
		// 再比较已知 iTerm 终端被显式禁用后的完整对象。
		assert.deepStrictEqual(
			// 提供 iTerm 身份，但用0/none关闭对应能力；箭头函数的返回表达式续在下一行。
			withEnv({ TERM_PROGRAM: "iterm.app", PI_HYPERLINKS: "0", PI_IMAGE_PROTOCOL: "none", PI_TRUE_COLOR: "0" }, () =>
				// 回调直接返回检测对象，没有额外缓存或 I/O。
				detectCapabilities(),
			),
			// none 对应 images:null；0 对应两个布尔 false。
			{ images: null, trueColor: false, hyperlinks: false },
		);
	});

	// auto 不形成强制覆盖，应保留 Ghostty 的自动判断；比较全部字段。
	it("preserves auto-detection for auto environment overrides", () => {
		// 结构比较实际结果与完整预期对象。
		assert.deepStrictEqual(
			// 在清理真实环境后构造这一组变量。
			withEnv(
				// 以下对象是 fixture 的输入，不是检测输出。
				{
					// 提供 Ghostty 身份以触发已知终端分支。
					TERM_PROGRAM: "ghostty",
					// 超链接 auto 不等于关闭或强制开启。
					PI_HYPERLINKS: "auto",
					// 图片 auto 保留自动协议判断。
					PI_IMAGE_PROTOCOL: "auto",
					// 真彩色 auto 同样不覆盖自动值。
					PI_TRUE_COLOR: "auto",
				},
				// 同步回调执行一次真实环境检测。
				() => detectCapabilities(),
			),
			// Ghostty 自动结果为 Kitty 图像、真彩色、超链接。
			{ images: "kitty", trueColor: true, hyperlinks: true },
		);
	});

	// 检验程序覆盖优先于环境，再撤销覆盖恢复环境结果；finally 清程序状态和能力缓存，错误仍向测试框架传播。
	it("applies and clears programmatic overrides", () => {
		// 环境先声明三个能力均开启，作为被覆盖的基线。
		withEnv({ PI_HYPERLINKS: "1", PI_IMAGE_PROTOCOL: "kitty", PI_TRUE_COLOR: "1" }, () => {
			// 程序覆盖三个字段为禁用状态，并使后续读取使用新覆盖。
			setCapabilityOverrides({ images: null, trueColor: false, hyperlinks: false });
			// 后续断言置于 try，保证失败也执行 finally 清理。
			try {
				// getCapabilities 必须返回程序覆盖后的完整对象。
				assert.deepStrictEqual(getCapabilities(), { images: null, trueColor: false, hyperlinks: false });
				// 用空对象替换覆盖，而不是把空对象与旧覆盖继续合并。
				setCapabilityOverrides({});
				// 重新取得能力，应回到环境强制开启的值。
				assert.deepStrictEqual(getCapabilities(), { images: "kitty", trueColor: true, hyperlinks: true });
				// 无论上面的断言是否通过，都撤销全局程序覆盖。
			} finally {
				// 重复撤销以覆盖断言失败时尚未走到正常清理的情况。
				setCapabilityOverrides({});
				// 清掉本环境计算出的缓存，避免恢复环境后仍读到旧结果。
				resetCapabilitiesCache();
			}
		});
	});

	// 显式链接覆盖应跳过传入的 tmux 探测回调；通过调用标志证明没探测，再检查图片覆盖。
	it("bypasses the tmux probe when hyperlinks are overridden", () => {
		// let 标志允许回调更新，初始表示尚未被调用。
		let probed = false;
		// 保存 fixture 返回的能力对象；退出后环境已恢复。
		const caps = withEnv(
			// 伪造 tmux 线索，同时强制链接开启、图片 Kitty；只是环境字符串，不连接此套接字。
			{ TMUX: "/tmp/tmux-1000/default,1234,0", PI_HYPERLINKS: "1", PI_IMAGE_PROTOCOL: "kitty" },
			// 外层箭头回调返回下一行检测结果。
			() =>
				// 向检测函数注入假探测器；若被错误调用，就会留下可断言的标记。
				detectCapabilities(() => {
					// 记录发生调用，不运行子进程。
					probed = true;
					// 假探测结果故意为 false，与强制 true 相反。
					return false;
				}),
		);
		// 关键断言：假探测器完全未调用。
		assert.strictEqual(probed, false);
		// 显式覆盖仍令链接开启。
		assert.strictEqual(caps.hyperlinks, true);
		// 显式图片覆盖可以把 tmux 默认 null 改为 Kitty。
		assert.strictEqual(caps.images, "kitty");
	});

	// tmux 探测回调返回支持时只启用链接；即使外层身份是 Ghostty，图片仍默认禁用。
	it("enables hyperlinks under tmux when the client forwards them", () => {
		// 伪造 tmux 与 Ghostty 环境，fixture 会在同步结束后恢复。
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			// 注入永远返回 true 的纯回调，替代实际 tmux 命令。
			const caps = detectCapabilities(() => true);
			// 支持链接转发时返回 true。
			assert.strictEqual(caps.hyperlinks, true);
			// 未显式覆盖图片时，tmux 默认无图片协议。
			assert.strictEqual(caps.images, null);
		});
	});

	// tmux 假探测返回不支持时禁用链接及图片，不能沿用外层 Ghostty 的全部能力。
	it("disables hyperlinks under tmux when the client does not forward them", () => {
		// 仍给出 Ghostty 身份以检验 tmux 分支优先。
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			// 纯回调返回 false，不执行外部命令。
			const caps = detectCapabilities(() => false);
			// 无转发能力则关闭链接。
			assert.strictEqual(caps.hyperlinks, false);
			// 图片继续为 null。
			assert.strictEqual(caps.images, null);
		});
	});

	// 没有 TMUX 变量也可由 TERM=tmux... 识别复用器；同一 fixture 内分别模拟探测成功和失败。
	it("checks tmux capability when TERM starts with 'tmux'", () => {
		// 只给 TERM 和外层 iTerm 身份，检验 TERM 前缀足以进入 tmux 分支。
		withEnv({ TERM: "tmux-256color", TERM_PROGRAM: "iterm.app" }, () => {
			// 第一次假探测返回 true。
			const caps = detectCapabilities(() => true);
			// 允许链接。
			assert.strictEqual(caps.hyperlinks, true);
			// 图片仍不继承 iTerm2。
			assert.strictEqual(caps.images, null);

			// 第二次独立检测注入 false，不受上次局部结果影响。
			const caps2 = detectCapabilities(() => false);
			// 本次只断言链接关闭，没有对 caps2 的其他字段作断言。
			assert.strictEqual(caps2.hyperlinks, false);
		});
	});

	// screen 前缀采用保守能力；检查图片和链接关闭，不涉及 tmux 探测器。
	it("forces hyperlinks: false when TERM starts with 'screen'", () => {
		// 仅设置 screen 终端类型。
		withEnv({ TERM: "screen-256color" }, () => {
			// 执行 screen 分支，无真实终端通信。
			const caps = detectCapabilities();
			// screen 默认不提供链接。
			assert.strictEqual(caps.hyperlinks, false);
			// screen 默认无图片协议。
			assert.strictEqual(caps.images, null);
		});
	});

	// #10573
	// Herdr 回归：显式颜色提示下支持 Kitty/链接/真彩色，再检查链接环境覆盖可关闭它。
	it("enables hyperlinks and Kitty images for Herdr", () => {
		// 同时设置 Herdr、颜色提示和 Kitty 身份；不能只靠 KITTY_WINDOW_ID 解释这里三个能力的来源。
		withEnv({ TERM_PROGRAM: "herdr", TERM: "xterm-256color", COLORTERM: "truecolor", KITTY_WINDOW_ID: "1" }, () => {
			// 取得本次环境的能力对象。
			const caps = detectCapabilities();
			// Herdr 链接开启。
			assert.strictEqual(caps.hyperlinks, true);
			// Herdr 图片为 Kitty。
			assert.strictEqual(caps.images, "kitty");
			// 本 fixture 的 COLORTERM 提示使真彩色开启。
			assert.strictEqual(caps.trueColor, true);
		});
		// 另开 fixture，移除之前额外线索，明确关闭超链接。
		withEnv({ TERM_PROGRAM: "herdr", PI_HYPERLINKS: "0" }, () => {
			// PI_HYPERLINKS=0 优先于 Herdr 默认链接能力。
			assert.strictEqual(detectCapabilities().hyperlinks, false);
		});
	});

	// #11131
	// Rex 回归的实际断言要求 Kitty 图片、真彩色和链接；英文标题的 without images 与当前断言不一致，以代码为准。第二部分检查链接可显式关闭。
	it("enables hyperlinks without images for Rex", () => {
		// 给出 Rex 身份及 Kitty 窗口线索，不启动真实终端。
		withEnv({ TERM_PROGRAM: "rex", TERM: "xterm-256color", KITTY_WINDOW_ID: "1" }, () => {
			// 取得 Rex 当前实现返回的能力对象。
			const caps = detectCapabilities();
			// 链接默认开启。
			assert.strictEqual(caps.hyperlinks, true);
			// 实际要求 images 为 kitty，不能把标题解释成关闭图片。
			assert.strictEqual(caps.images, "kitty");
			// 真彩色默认开启。
			assert.strictEqual(caps.trueColor, true);
		});
		// 在独立环境中只保留 Rex 与链接关闭覆盖。
		withEnv({ TERM_PROGRAM: "rex", PI_HYPERLINKS: "0" }, () => {
			// 明确覆盖可以关闭默认链接。
			assert.strictEqual(detectCapabilities().hyperlinks, false);
		});
	});

	// Orca 没有图片协议声明时保持 images:null；本项只检查图片字段。
	it("keeps images disabled for Orca without an image capability signal", () => {
		// 程序名使用大写 O，顺带覆盖实现对名称的小写归一化。
		withEnv({ TERM_PROGRAM: "Orca" }, () => {
			// 读取无图片声明情况下的能力。
			const caps = detectCapabilities();
			// 不能仅凭 Orca 名称就启用图片。
			assert.strictEqual(caps.images, null);
		});
	});

	// Orca 明确声明 kitty 时启用三个能力；与上一项无声明的图片结果形成对照。
	it("enables images and hyperlinks for Orca advertising Kitty support", () => {
		// 伪造 Orca 程序名和确切的 kitty 协议声明。
		withEnv({ TERM_PROGRAM: "Orca", ORCA_IMAGE_PROTOCOL: "kitty" }, () => {
			// 计算这组变量下的能力。
			const caps = detectCapabilities();
			// 声明生效，图片协议为 Kitty。
			assert.strictEqual(caps.images, "kitty");
			// 声明分支同时启用真彩色。
			assert.strictEqual(caps.trueColor, true);
			// 声明分支同时启用链接。
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	// Ghostty 名称触发链接支持；本项只断言 hyperlinks，没有检查图片或真彩色。
	it("enables hyperlinks for Ghostty", () => {
		// 隔离环境中仅保留 Ghostty 名称。
		withEnv({ TERM_PROGRAM: "ghostty" }, () => {
			// 直接检测而不读取共享结果缓存。
			const caps = detectCapabilities();
			// 链接应开启。
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	// Ghostty 与 cmux 工作区变量同时存在时仍支持 Kitty/链接；不模拟真实 cmux 会话。
	it("does not disable Ghostty images solely because cmux is present", () => {
		// 工作区是任意占位字符串，只检查其存在不会导致禁用。
		withEnv({ TERM_PROGRAM: "ghostty", CMUX_WORKSPACE_ID: "workspace" }, () => {
			// 读取两个线索并存时的能力。
			const caps = detectCapabilities();
			// 图片仍选择 Kitty。
			assert.strictEqual(caps.images, "kitty");
			// 链接仍开启；此项不另断言真彩色。
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	// Kitty 窗口变量足以开启链接；不要求 TERM_PROGRAM 同时存在。
	it("enables hyperlinks for Kitty", () => {
		// 只设置一个有真值的窗口 ID 字符串。
		withEnv({ KITTY_WINDOW_ID: "1" }, () => {
			// 让真实检测逻辑按此线索判断。
			const caps = detectCapabilities();
			// 只检查链接字段为 true。
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	// WezTerm pane 标识开启链接，特别检查字符串 "0" 不会被当作数字0的假值。
	it("enables hyperlinks for WezTerm", () => {
		// 环境变量值总是字符串；"0" 在 JavaScript 条件中仍为真。
		withEnv({ WEZTERM_PANE: "0" }, () => {
			// 根据 pane 线索检测能力。
			const caps = detectCapabilities();
			// 链接开启，不对其它字段作断言。
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	// Warp 的 TERM_PROGRAM 身份应启用 Kitty、真彩色和链接；混合大小写名称也应识别。
	it("enables images and hyperlinks for Warp via TERM_PROGRAM", () => {
		// 使用 WarpTerminal 名称，不需要提供会话 ID。
		withEnv({ TERM_PROGRAM: "WarpTerminal" }, () => {
			// 真实实现会归一化程序名并选择 Warp 分支。
			const caps = detectCapabilities();
			// 图片协议为 Kitty。
			assert.strictEqual(caps.images, "kitty");
			// 真彩色开启。
			assert.strictEqual(caps.trueColor, true);
			// 超链接开启。
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	// 只给 WARP_SESSION_ID 也应识别 Warp 的三种能力，独立于 TERM_PROGRAM。
	it("enables images and hyperlinks for Warp via WARP_SESSION_ID", () => {
		// 会话 ID 只是身份线索，不连接任何会话。
		withEnv({ WARP_SESSION_ID: "some-session-id" }, () => {
			// 按此环境重新计算能力。
			const caps = detectCapabilities();
			// 识别到 Kitty 图片支持。
			assert.strictEqual(caps.images, "kitty");
			// 识别到真彩色支持。
			assert.strictEqual(caps.trueColor, true);
			// 识别到超链接支持。
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	// 检查另一种 Warp UUID 变量同样足以启用三种能力；检测只看真值，不验证 UUID 格式。
	it("enables images and hyperlinks for Warp via WARP_TERMINAL_SESSION_UUID", () => {
		// 使用固定 UUID 字符串作为存在性线索。
		withEnv({ WARP_TERMINAL_SESSION_UUID: "d0e1a2e5-7ca7-44cd-9037-ac7222011161" }, () => {
			// 按 UUID 变量选择能力分支。
			const caps = detectCapabilities();
			// 图片为 Kitty。
			assert.strictEqual(caps.images, "kitty");
			// 真彩色为 true。
			assert.strictEqual(caps.trueColor, true);
			// 链接为 true。
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	// Warp 外层身份不能越过 tmux 的图片限制；链接由假探测器单独决定。
	it("disables images for Warp inside tmux", () => {
		// 以多行参数形式设置 fixture 和同步断言回调。
		withEnv(
			// 环境对象同时表达外层 Warp 与内层 tmux。
			{
				// 外层终端名称。
				TERM_PROGRAM: "WarpTerminal",
				// tmux 会话占位值，不访问该套接字路径。
				TMUX: "/tmp/tmux-1000/default,1234,0",
				// TERM 的 tmux 前缀也提供复用器线索。
				TERM: "tmux-256color",
			},
			// 所有断言在临时环境内同步完成，结束后恢复环境。
			() => {
				// 假回调返回链接可转发，替代真实 tmux 命令。
				const caps = detectCapabilities(() => true);
				// 图片被 tmux 默认策略关闭。
				assert.strictEqual(caps.images, null);
				// 链接则按假探测结果开启。
				assert.strictEqual(caps.hyperlinks, true);
			},
		);
	});

	// iTerm 程序身份应开启超链接；本项未断言图片协议。
	it("enables hyperlinks for iTerm2", () => {
		// 仅提供 iTerm 名称。
		withEnv({ TERM_PROGRAM: "iterm.app" }, () => {
			// 计算该身份对应的能力。
			const caps = detectCapabilities();
			// hyperlinks 为 true。
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	// VS Code 集成终端名称应开启链接，验证名称分支而非真实编辑器界面。
	it("enables hyperlinks for VSCode", () => {
		// fixture 中只保留 vscode 身份。
		withEnv({ TERM_PROGRAM: "vscode" }, () => {
			// 检测返回一个普通能力对象。
			const caps = detectCapabilities();
			// 链接字段必须开启。
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	// Zed 使用与 Alacritty 类似的能力组合；完整比较 null/true/true，而非检查其真实终端版本。
	it("enables Alacritty capabilities for Zed", () => {
		// 仅设置 zed 程序名。
		withEnv({ TERM_PROGRAM: "zed" }, () => {
			// 深比较整个能力对象，要求无图片、支持真彩色和链接。
			assert.deepStrictEqual(detectCapabilities(), { images: null, trueColor: true, hyperlinks: true });
		});
	});

	// 没有复用器时，WT_SESSION 线索开启真彩色/链接但不启用图片；不需要把测试进程平台改成 Windows。
	it("enables truecolor and hyperlinks for Windows Terminal outside multiplexers", () => {
		// 提供 Windows Terminal 会话线索和常规 xterm 类型。
		withEnv({ WT_SESSION: "session", TERM: "xterm-256color" }, () => {
			// 检测按环境身份判断，而不是实际启动该终端。
			const caps = detectCapabilities();
			// 真彩色开启。
			assert.strictEqual(caps.trueColor, true);
			// 超链接开启。
			assert.strictEqual(caps.hyperlinks, true);
			// 图片仍为 null。
			assert.strictEqual(caps.images, null);
		});
	});

	// JetBrains-JediTerm 身份开启真彩色、关闭链接和图片，三个字段分别检查。
	it("enables truecolor without hyperlinks for JetBrains terminal", () => {
		// TERM 只是普通 xterm，TERMINAL_EMULATOR 提供专门身份。
		withEnv({ TERMINAL_EMULATOR: "JetBrains-JediTerm", TERM: "xterm-256color" }, () => {
			// 检测 JetBrains 分支。
			const caps = detectCapabilities();
			// 该分支支持真彩色。
			assert.strictEqual(caps.trueColor, true);
			// 该分支不默认启用超链接。
			assert.strictEqual(caps.hyperlinks, false);
			// 该分支无图片协议。
			assert.strictEqual(caps.images, null);
		});
	});

	// tmux 不盲目继承外层 Windows Terminal 的真彩色；没有明确颜色提示且假链接探测失败时三项均关闭。
	it("does not inherit Windows Terminal truecolor through tmux", () => {
		// WT_SESSION 与 tmux 线索并存，检查更早的 tmux 分支优先。
		withEnv({ WT_SESSION: "session", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			// 注入 false 作为 tmux 链接支持，不调用外部进程。
			const caps = detectCapabilities(() => false);
			// 仅有 WT_SESSION 不足以让 tmux 真彩色变 true。
			assert.strictEqual(caps.trueColor, false);
			// 链接按假探测返回 false。
			assert.strictEqual(caps.hyperlinks, false);
			// 图片默认无支持。
			assert.strictEqual(caps.images, null);
		});
	});

	// 显式 COLORTERM 真彩色提示可以穿过 tmux 保留，而链接/图片仍各按 tmux 策略处理。
	it("trusts explicit truecolor hints through tmux", () => {
		// 给出 truecolor 提示及 tmux 线索。
		withEnv({ COLORTERM: "truecolor", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			// 假探测只决定链接，不决定真彩色。
			const caps = detectCapabilities(() => false);
			// 颜色提示使 trueColor 为 true。
			assert.strictEqual(caps.trueColor, true);
			// 假探测失败使链接关闭。
			assert.strictEqual(caps.hyperlinks, false);
			// 无显式图片覆盖仍为 null。
			assert.strictEqual(caps.images, null);
		});
	});

	// TERM 以 -direct 结束时本身就是真彩色提示；本项只检查该字段。
	it("detects truecolor from direct-color TERM values", () => {
		// 不设置 tmux/screen 线索，只有 xterm-direct。
		withEnv({ TERM: "xterm-direct" }, () => {
			// 传入 false 回调不会在这一非 tmux 路径调用；颜色结果来自 TERM 后缀。
			assert.strictEqual(detectCapabilities(() => false).trueColor, true);
		});
	});
});

// iTerm2 编码组只比较返回的 OSC 字符串，不向终端传输或验证图片文件内容。
describe("iTerm2 image encoding", () => {
	// AAAA 的 base64 解码长度为3字节，检查 size 元数据使用字节数而非4字符长度。
	it("includes the decoded payload size in OSC 1337 metadata", () => {
		// 数字 width=2 表示两格，高度传 auto；AAAA 是测试载荷，不是有效完整 PNG。
		const sequence = encodeITerm2("AAAA", { width: 2, height: "auto" });
		// 精确比较默认 inline=1、size=3、宽高字段、载荷及结束 BEL 的顺序。
		assert.strictEqual(sequence, "\x1b]1337;File=inline=1;size=3;width=2;height=auto:AAAA\x07");
	});
});

// Kitty 控制/尺寸组检查 C=1、静默删除、元数据、裁剪和 Image 输出行；命令均只构造在内存。
describe("Kitty image cursor movement", () => {
	// moveCursor:false 应写 C=1 请求终端不要移动光标；这是编码断言，不证明真实终端响应。
	it("can request no terminal-side cursor movement", () => {
		// 指定2列2行和禁止移动，使用短载荷生成单块命令。
		const sequence = encodeKitty("AAAA", { columns: 2, rows: 2, moveCursor: false });
		// startsWith 只验证控制头，未对完整载荷和结束符做精确比较；q=2 用于抑制协议回复。
		assert.ok(sequence.startsWith("\x1b_Ga=T,f=100,q=2,C=1,c=2,r=2;"));
	});

	// 没有 ID 或注册元数据时仍可从显式 r 字段读出行数。
	it("reads explicit placement rows without registered metadata", () => {
		// encodeKitty 只编码，不自动登记元数据；本头明确写 r=3。
		const sequence = encodeKitty("AAAA", { columns: 2, rows: 3, moveCursor: false });
		// 行数读取优先使用头内正 r 值，因此得到3。
		assert.strictEqual(getKittyImagePlacementRows(sequence), 3);
	});

	// 三类删除命令都必须带 q=2 抑制回复；只比较字符串，不执行删除或读取终端状态。
	it("suppresses Kitty replies for delete commands", () => {
		// 大写 I 删除 ID42 的图像数据及相应放置。
		assert.strictEqual(deleteKittyImage(42), "\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
		// 大写 A 删除全部可见图片并释放相应数据。
		assert.strictEqual(deleteAllKittyImages(), "\x1b_Ga=d,d=A,q=2\x1b\\");
		// 小写 a 只删除可见放置，保留上传数据供复用。
		assert.strictEqual(deleteAllKittyPlacements(), "\x1b_Ga=d,d=a,q=2\x1b\\");
	});

	// renderImage 默认不附加 C=1，保留 Kitty 默认光标移动行为；设置缓存/格像素后在 finally 恢复常规状态。
	it("preserves renderImage's default terminal-side cursor movement", () => {
		// 直接设置 Kitty 能力，避免依赖本机环境检测。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// 单格10×10像素，20×20图按2列显示恰占2行。
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		// 保证断言失败也执行清理。
		try {
			// 使用显式源尺寸和宽预算，未传 moveCursor 或 imageId；没有实际像素解码。
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2 });
			// 要求非 null；Node 断言类型也让后续 TypeScript 访问缩窄到实际结果对象。
			assert.ok(result);
			// 只检查 C=1 字段不存在，不实际观察终端光标。
			assert.ok(!result.sequence.includes(",C=1,"));
			// 本次尺寸结果为两行。
			assert.strictEqual(result.rows, 2);
			// 失败和成功均清理，原异常仍向外传播。
		} finally {
			// 清能力缓存，而非恢复调用前任意旧缓存对象。
			resetCapabilitiesCache();
			// 单格尺寸明确恢复为项目常规9×18，不是保存/恢复任意前值。
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	// 显式 moveCursor:false 应在 renderImage 返回串中出现 C=1，行数预算保持两行。
	it("can opt renderImage into no terminal-side cursor movement", () => {
		// 固定 Kitty 能力缓存。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// 用正方形10×10单格消除格纵横比的干扰。
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		// 将渲染和断言纳入 finally 清理范围。
		try {
			// 传入两列上限及禁止光标移动选项，数据仅为占位载荷。
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2, moveCursor: false });
			// 要求确实选择了可用图片协议。
			assert.ok(result);
			// 检查生成的控制头包含 C=1。
			assert.ok(result.sequence.includes(",C=1,"));
			// 光标策略不改变这张图的两行占位。
			assert.strictEqual(result.rows, 2);
			// 不论是否断言成功，都重置测试状态。
		} finally {
			// 清能力结果缓存。
			resetCapabilitiesCache();
			// 格像素回到9×18常规值。
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	// 显式 ID 渲染应登记原尺寸，再把三行图片隐藏前两行，仅保留最后一行；裁剪只是改控制头，不改变像素数据。
	it("registers metadata and crops a partially visible placement", () => {
		// 固定 Kitty 协议和颜色/链接能力。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// 每格10×10像素，便于直接检查方形格数。
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		// 设置成功后所有渲染/断言均在受清理保护的 try 中。
		try {
			// 调用返回串/格数的底层渲染入口。
			const result = renderImage(
				// base64 仍是占位字符串，本项不验证真实 PNG。
				"AAAA",
				// 显式源尺寸100×100像素，元数据必须保留这个原尺寸。
				{ widthPx: 100, heightPx: 100 },
				// 按三列显示、指定 ID42 并请求不动光标；Kitty 分支将登记该 ID。
				{ maxWidthCells: 3, imageId: 42, moveCursor: false },
			);
			// 保证渲染结果非 null 后才能访问 sequence。
			assert.ok(result);
			// 按输出头内 ID 查登记值，深比较五个公开字段，不检查内部传输代次。
			assert.deepStrictEqual(getKittyImageMetadata(result.sequence), {
				// ID 与调用选项一致。
				imageId: 42,
				// 显示宽度为三格。
				columns: 3,
				// 正方形源图和正方形格使显示高度也是三格。
				rows: 3,
				// 原图宽仍为100像素，不是显示30像素。
				widthPx: 100,
				// 原图高仍为100像素，不是裁剪后的片段高。
				heightPx: 100,
			});
			// 隐藏2/3高度：起点 floor(100×2/3)=66，末端100，因此 h=34、r=1；只检查这段字段。
			assert.ok(cropKittyImageLine(result.sequence, 2, 1).includes("y=66,h=34,r=1"));
			// 结束后恢复能力/格像素；登记的 ID42 仍留在进程内表中。
		} finally {
			// 仅重置能力结果，不清图片登记表。
			resetCapabilitiesCache();
			// 恢复常规格像素值9×18。
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	// 把分块上传、裁剪、行前后文字组合，再提取仅放置串；检查传输范围和估算，未证明终端已经上传该 ID。
	it("creates placement-only commands for uploaded and cropped images", () => {
		// 先覆盖登记 ID42 的三行/100×100像素元数据，并产生新的内部代次。
		registerKittyImageMetadata({ imageId: 42, columns: 3, rows: 3, widthPx: 100, heightPx: 100 });
		// 8192个 A 会超过4096字符单块上限，覆盖连续分块提取路径。
		const transmission = encodeKitty("A".repeat(8192), {
			// 完整显示宽为三列。
			columns: 3,
			// 完整显示高为三行，后续裁剪会在协议头改成一行。
			rows: 3,
			// ID 必须能在登记表中查到，否则提取放置信息会失败。
			imageId: 42,
			// 上传命令附 C=1，提取出的放置串也应保留它。
			moveCursor: false,
		});
		// 模板插值把裁剪后的完整传输夹在 left/right 文字之间；没有终端输出。
		const line = `left ${cropKittyImageLine(transmission, 2, 1)} right`;
		// 扫描连续传输块并构造不含图片载荷的新放置信息。
		const placement = getKittyImagePlacement(line);
		// 要求提取成功，随后可访问 placement 字段。
		assert.ok(placement);
		// 显式裁剪 r=1 应优先于原登记三行。
		assert.strictEqual(getKittyImagePlacementRows(line), 1);
		// 传输范围不包括前后正文；此 fixture 全为 ASCII，字符串长度可对应协议字节长度。
		assert.strictEqual(placement.transmissionBytes, line.length - "left ".length - " right".length);
		// 按整张原图100×100×RGBA4估算解码内存，不是实际 PNG 长度或裁剪片段内存。
		assert.strictEqual(placement.estimatedDecodedBytes, 100 * 100 * 4);
		// 提取结构中的放置行数也为一行。
		assert.strictEqual(placement.rows, 1);
		// 精确比较 a=p 仅放置、q=2、C/c/i 和裁剪 y/h/r，后面直接 ST，不含 base64。
		assert.strictEqual(placement.sequence, "\x1b_Ga=p,q=2,C=1,c=3,i=42,y=66,h=34,r=1\x1b\\");
		// 替换行必须保留两侧正文，只用短放置命令替代完整上传段。
		assert.strictEqual(placement.replacementLine, `left ${placement.sequence} right`);
		// 检查替换行不再含重复 A 载荷；不是证明终端已有可复用图片。
		assert.ok(!placement.replacementLine.includes("AAAA"));
	});

	// 最大高度也参与同比缩放，细长图不能仅按十列预算放大到一百行。
	it("honors maxHeightCells by reducing rendered width", () => {
		// 强制走 Kitty 分支。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// 单格10×10像素。
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		// 使用 try/finally 清理本次缓存和格尺寸。
		try {
			// 10×100像素长图，预算10列但最多5行，高约束更紧，最终宽也随之缩小。
			const result = renderImage("AAAA", { widthPx: 10, heightPx: 100 }, { maxWidthCells: 10, maxHeightCells: 5 });
			// 要求有渲染结果。
			assert.ok(result);
			// 高度限制为五行。
			assert.strictEqual(result.rows, 5);
			// 宽至少一列，生成的头中应有 c=1,r=5。
			assert.ok(result.sequence.includes(",c=1,r=5"));
			// 断言失败也执行常规状态重置。
		} finally {
			// 清能力缓存。
			resetCapabilitiesCache();
			// 格尺寸恢复9×18。
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	// Image 默认把可用宽像素换算成高格预算并向上取整，形成近似正方形像素包围盒；本例宽100px、格高20px，因此最多5行。
	it("caps Image component height to a square pixel box by default", () => {
		// 固定 Kitty 能力，组件只构造返回行。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// 每列10px、每行20px，格子本身不是正方形。
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		// 保护组件创建、渲染、断言的后续清理。
		try {
			// 创建组件，不会立即写终端；依次传数据、MIME、主题、选项、显式源尺寸。
			const image = new Image(
				// 占位 base64，尺寸由下面的显式参数提供。
				"AAAA",
				// PNG MIME 使 Kitty 路径无需转码回调。
				"image/png",
				// 主题回调原样返回 value；箭头表达式不添加颜色。
				{ fallbackColor: (value) => value },
				// 组件最大宽为10列，没有显式最大高，使用默认正方形像素盒。
				{ maxWidthCells: 10 },
				// 源图10×100像素，是细长图。
				{ widthPx: 10, heightPx: 100 },
			);
			// render(12) 内部减两列得到10列内容预算，返回字符串数组。
			const lines = image.render(12);
			// 预留恰好五个数组行。
			assert.strictEqual(lines.length, 5);
			// 首行图片头应表达一列、五行，不检查实际终端图像。
			assert.ok(lines[0].includes(",c=1,r=5"));
			// 始终重置本次测试的共享能力/格尺寸。
		} finally {
			// 能力重新变为待检测状态。
			resetCapabilitiesCache();
			// 单格像素恢复9×18。
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	// Kitty Image 把完整协议放在第一行，其余格行用空字符串预留；检查 ID 传播和 C=1，不依赖真实光标行为。
	it("places image sequence on first line with empty padding rows", () => {
		// 设置 Kitty 能力缓存。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// 用10×10像素单格得到简单2×2占位。
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		// 即使断言出错也恢复能力与格尺寸。
		try {
			// 构造一个没有显式 ID 的 Image；组件会持有自己分配的 ID。
			const image = new Image(
				// 使用占位 PNG 数据。
				"AAAA",
				// MIME 为 PNG，不需要安装转码器。
				"image/png",
				// 回退颜色回调原样返回文本，本路径正常不会显示回退。
				{ fallbackColor: (value) => value },
				// 最大内容宽2格。
				{ maxWidthCells: 2 },
				// 显式源图20×20像素，按预算显示两列两行。
				{ widthPx: 20, heightPx: 20 },
			);
			// render(4) 扣两列内边距，内容宽为2。
			const lines = image.render(4);
			// 读取组件本次使用的图片 ID。
			const imageId = image.getImageId();
			// 只断言 ID 的 typeof 为 number；没有检验唯一性、范围或与别的组件是否冲突。
			assert.strictEqual(typeof imageId, "number");
			// 第一行以 Kitty 前缀开头。
			assert.ok(lines[0].startsWith("\x1b_G"));
			// 组件请求终端不移动光标，由 TUI 自己安排占位行。
			assert.ok(lines[0].includes(",C=1,"));
			// 控制头里的 i 必须与组件读出的 ID 一致。
			assert.ok(lines[0].includes(`,i=${imageId}`));
			// 第一行协议以 ST 结束，结束符保存在内存中。
			assert.ok(lines[0].endsWith("\x1b\\"));
			// 除第一行外恰有一个空行，因此总占位两行；slice 的结束下标不包含在结果中。
			assert.deepStrictEqual(lines.slice(1, lines.length), [""]);
			// 清理能力和像素尺寸；图片 ID 元数据不会由这里清除。
		} finally {
			// 清能力结果缓存。
			resetCapabilitiesCache();
			// 恢复9×18格像素。
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	// 不支持图像时，长绝对路径经 home 缩写、主题着色和截断，要求最终一行可见宽不超过40列。
	it("truncates long image fallback lines to render width", () => {
		// 明确禁用图片及链接，保证输出为普通回退文字加颜色控制。
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		// 用 finally 清掉这个强制能力缓存。
		try {
			// 仅构造长路径，不要求文件存在或创建文件。
			const longPath = join(
				// 真实 home 前缀使缩写函数有机会显示 ~。
				homedir(),
				// 固定 images 子目录名。
				"images",
				// repeat(4) 形成足够长的文件名；模板只拼文字，不访问磁盘。
				`${"generated-image-with-a-very-long-absolute-path".repeat(4)}.png`,
			);
			// 目标总渲染宽40列。
			const width = 40;
			// 构造不可显示图片协议下的组件，后续将走文字回退。
			const image = new Image(
				// 图片数据不会在无图片协议时显示。
				"AAAA",
				// MIME 会作为回退说明的一部分。
				"image/png",
				// 把回退文字包进黄色 SGR 和复位；可见宽应忽略这些控制码。
				{ fallbackColor: (value) => `\x1b[33m${value}\x1b[0m` },
				// 把长绝对路径作为 filename，而不是实际读取它。
				{ filename: longPath },
				// 显式提供1280×720原像素尺寸供文字说明使用。
				{ widthPx: 1280, heightPx: 720 },
			);
			// 取得已截断/着色的返回行，没有向终端输出。
			const lines = image.render(width);
			// 文字回退只占一行。
			assert.strictEqual(lines.length, 1);
			// 布尔断言带第二个错误消息参数，只有失败时用于诊断。
			assert.ok(
				// 按可见格宽比较上限，不使用含 SGR 的原始字符串 length。
				visibleWidth(lines[0]) <= width,
				// 失败信息显示预算、测得宽度及 JSON 转义原串，便于看到控制字符；它不是返回值的一部分。
				`fallback line wider than ${width}: visible=${visibleWidth(lines[0])} raw=${JSON.stringify(lines[0])}`,
			);
			// 长路径确实被截断，应包含三点省略标记。
			assert.ok(lines[0].includes("..."), "expected ellipsis when truncating long fallback path");
			// 回退应保留 home 缩写 ~；本项没有精确比较整段文字或颜色字段。
			assert.ok(lines[0].includes("~"), "expected home-shortened path in fallback");
			// 无论断言成功/失败都清本次强制能力。
		} finally {
			// 仅重置能力结果；此项没有改格像素尺寸。
			resetCapabilitiesCache();
		}
	});
});

// #8938: reduce Kitty placement distortion without shrinking iTerm2 reservations.
// 格数回归组：Kitty 可在相邻整数格中选择比例失真更小的一个，iTerm2 则保留上取整的占位。输入是显式像素/格尺寸，不解码实际图像。
describe("image cell sizing", () => {
	// 每个后代用例结束后清能力/恢复格像素；异常断言也由测试框架触发该 hook。
	afterEach(() => {
		// 清除用例中强制设置的能力结果，不清图片元数据注册表。
		resetCapabilitiesCache();
		// 格像素固定回到9×18，而非恢复任意调用前值。
		setCellDimensions({ widthPx: 9, heightPx: 18 });
	});

	// Kitty 子组检查优化后的目标格数、组件占位和裁剪头是否一致。
	describe("Kitty", () => {
		// 每个 Kitty 子用例开始前直接设置能力，不探测真实终端。
		beforeEach(() => {
			// 令 renderImage/Image 选择 Kitty 路径。
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		});

		// 超薄横图即使换算高度不足一格，也必须至少保留一行，防止零行图片。
		it("reserves at least one Kitty row for thin images", () => {
			// 单格宽9px、高18px。
			setCellDimensions({ widthPx: 9, heightPx: 18 });
			// 1200×12图按60列即540px宽缩放，高仅5.4px，算法仍需一行。
			const result = renderImage("AAAA", { widthPx: 1200, heightPx: 12 }, { maxWidthCells: 60 });
			// 要求图片协议返回非 null 结果。
			assert.ok(result);
			// 预留至少一行。
			assert.strictEqual(result.rows, 1);
			// 协议头与结果格数一致，c=60,r=1。
			assert.ok(result.sequence.includes(",c=60,r=1;"));
		});

		// 同一 Image 从60列内容宽变为30列时，应重算协议、返回行和元数据；还检查首次裁剪可按原像素正确换算。
		it("keeps Kitty placement, reserved lines, and cropping metadata consistent across width changes", () => {
			// 使用常规9×18像素格。
			setCellDimensions({ widthPx: 9, heightPx: 18 });
			// 创建带固定 ID 的组件，后续两次 render 复用该实例。
			const image = new Image(
				// 占位 PNG 载荷，图片内容不参与尺寸计算。
				"AAAA",
				// PNG MIME 避免转码路径。
				"image/png",
				// 回退主题回调不加样式。
				{ fallbackColor: (value) => value },
				// 最大宽60列，固定 ID8938 便于比较登记值。
				{ maxWidthCells: 60, imageId: 8938 },
				// 显式原尺寸615×86像素，登记值应保留它而不是缩放尺寸。
				{ widthPx: 615, heightPx: 86 },
			);
			// 总宽62减组件两列余量，得到60列内容；Kitty 比例优化把理想约4.195行选为4。
			const lines = image.render(62);
			// 输出数组占四行。
			assert.strictEqual(lines.length, 4);
			// 首行图片串之后恰有三个空占位行。
			assert.deepStrictEqual(lines.slice(1), ["", "", ""]);
			// 头内列/行/ID 与组件预留一致。
			assert.ok(lines[0].includes(",c=60,r=4,i=8938;"));
			// 读取登记值，完整比较这五个公开字段。
			assert.deepStrictEqual(getKittyImageMetadata(lines[0]), {
				// 登记 ID 为8938。
				imageId: 8938,
				// 登记显示宽为60格。
				columns: 60,
				// 登记显示高为优化后的4格。
				rows: 4,
				// 登记源像素宽615。
				widthPx: 615,
				// 登记源像素高86。
				heightPx: 86,
			});
			// 隐藏第一行，只显示随后两行；裁剪仍依据原登记四行换算像素。
			const cropped = cropKittyImageLine(lines[0], 1, 2);
			// 精确比较提取的仅放置命令，避免只检查某个字段就漏掉坐标/行数。
			assert.strictEqual(
				// 可选链使提取失败时得到 undefined，随后与字符串不相等而使断言失败。
				getKittyImagePlacement(cropped)?.sequence,
				// y=floor(86/4)=21，末端ceil(86×3/4)=65，所以 h=44、r=2，并保留 ID/宽度/C=1。
				"\x1b_Ga=p,q=2,C=1,c=60,i=8938,y=21,h=44,r=2\x1b\\",
			);

			// 同一实例换总宽32，内容宽30；宽度变化使输出行缓存重算。
			const narrowerLines = image.render(32);
			// 缩窄后的占位为两行。
			assert.strictEqual(narrowerLines.length, 2);
			// 协议更新成30列2行，ID 仍为8938。
			assert.ok(narrowerLines[0].includes(",c=30,r=2,i=8938;"));
			// 同 ID 元数据也更新为两行；这里没有再完整比较其它登记字段。
			assert.strictEqual(getKittyImageMetadata(narrowerLines[0])?.rows, 2);
		});

		// 不是一律向下取整：当上取整的比例误差更小时应保留5行，覆盖相邻格候选的比较。
		it("keeps the ceiling placement when rounding down would increase distortion", () => {
			// 使用15×28像素格改变理想高度，宽60列时理想约4.495行。
			setCellDimensions({ widthPx: 15, heightPx: 28 });
			// 显式源尺寸不变，格像素不同会影响整数行数选择。
			const result = renderImage("AAAA", { widthPx: 615, heightPx: 86 }, { maxWidthCells: 60 });
			// 要求成功生成图片结果。
			assert.ok(result);
			// 比较比例失真后保留上取整5行，而不是简单 Math.round 成4行。
			assert.strictEqual(result.rows, 5);
			// 生成头内也必须为60列5行。
			assert.ok(result.sequence.includes(",c=60,r=5;"));
		});

		// 竖图被默认正方形像素高预算限制时，Kitty 应调整列数；检查行预留、注册源尺寸和裁剪，随后再次缩窄。
		it("keeps height-limited Kitty columns, reservations, and crop metadata consistent", () => {
			// 每格宽14px、高28px；30列默认像素高420px，折合15行。
			setCellDimensions({ widthPx: 14, heightPx: 28 });
			// 组件使用固定 ID，可核对同一元数据记录。
			const image = new Image(
				// 载荷仍为内存占位串。
				"AAAA",
				// PNG MIME 不经过转码。
				"image/png",
				// 回退颜色函数原样返回。
				{ fallbackColor: (value) => value },
				// 最大宽30列，ID8938；没有显式高上限，所以使用组件默认正方形像素预算。
				{ maxWidthCells: 30, imageId: 8938 },
				// 源图400×900，比可用包围盒更窄长，因此高约束先达到。
				{ widthPx: 400, heightPx: 900 },
			);
			// 总宽32扣两列后得到30列内容，默认高15行。
			const lines = image.render(32);
			// 预留15行，保持高度预算。
			assert.strictEqual(lines.length, 15);
			// Kitty 在理想约13.333列的相邻候选中选择13列，减少比例失真。
			assert.ok(lines[0].includes(",c=13,r=15,i=8938;"));
			// 登记值必须与本次实际目标格数一致，同时保留原尺寸。
			assert.deepStrictEqual(getKittyImageMetadata(lines[0]), {
				// 固定 ID8938。
				imageId: 8938,
				// 登记优化后的13列，而不是 ceil 得到的14。
				columns: 13,
				// 登记15行。
				rows: 15,
				// 源像素宽仍为400。
				widthPx: 400,
				// 源像素高仍为900。
				heightPx: 900,
			});
			// 比较裁剪后的放置串，而非实际编辑 PNG 像素。
			assert.strictEqual(
				// 在15行中藏一行、显示两行，再提取不带载荷的放置信息；可选链会令提取失败变成断言不等。
				getKittyImagePlacement(cropKittyImageLine(lines[0], 1, 2))?.sequence,
				// 每行原像素高900/15=60，故 y=60、h=120、r=2，列数保留13。
				"\x1b_Ga=p,q=2,C=1,c=13,i=8938,y=60,h=120,r=2\x1b\\",
			);
			// 缩成总宽22，内容20列，对应默认高10行。
			const narrowerLines = image.render(22);
			// 返回数组更新为10行。
			assert.strictEqual(narrowerLines.length, 10);
			// 高度10行时理想宽约8.889列，Kitty 选择9列，保持原 ID。
			assert.ok(narrowerLines[0].includes(",c=9,r=10,i=8938;"));
		});

		// 一组细长图检查比例候选比较和至少一列边界；循环的每一项是“源像素宽、预期列数”。
		it("chooses thin Kitty widths by proportions while keeping at least one column", () => {
			// 每格1×1像素，使10行高约束下理想列数直接等于源宽÷100。
			setCellDimensions({ widthPx: 1, heightPx: 1 });
			// for...of 遍历内层数组，再用解构取 widthPx 与 columns；这里是数字数组表，不是运行时校验器。
			for (const [widthPx, columns] of [
				// 1px宽的图理想0.01列，也必须至少一列。
				[1, 1],
				// 140px宽图理想1.4列，比例误差比较选择1列。
				[140, 1],
				// 149px宽图理想1.49列，比例误差比较选择2列，表明不是简单四舍五入。
				[149, 2],
			]) {
				// 对象字段 widthPx 使用同名简写，源高固定1000px，高预算10行比宽30列更紧。
				const result = renderImage("AAAA", { widthPx, heightPx: 1000 }, { maxWidthCells: 30, maxHeightCells: 10 });
				// 每轮都必须成功选择图片协议。
				assert.ok(result);
				// 本轮返回列数必须等于表中的预期值。
				assert.strictEqual(result.columns, columns);
				// 每张图高度都用满10行。
				assert.strictEqual(result.rows, 10);
				// 协议头列/行与结果对象一致；模板插值只构造断言目标字符串。
				assert.ok(result.sequence.includes(`,c=${columns},r=10;`));
			}
		});
	});

	// iTerm2 子组保持向上取整的占位，不使用 Kitty 的相邻格比例优化。
	describe("iTerm2", () => {
		// 每项 iTerm2 用例前固定能力，组外 afterEach 负责重置。
		beforeEach(() => {
			// 指定 iTerm2 协议与其它布尔能力。
			setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		});

		// 同样400×900源图、高限15行，iTerm2 应保留 ceil 后14列，而不是 Kitty 的13列。
		it("keeps iTerm2's ceiling width when height-limited", () => {
			// 14×28像素的格尺寸与前面高度受限 Kitty 例一致。
			setCellDimensions({ widthPx: 14, heightPx: 28 });
			// 底层显式给宽30列/高15行，按更紧的高约束计算尺寸。
			const result = renderImage("AAAA", { widthPx: 400, heightPx: 900 }, { maxWidthCells: 30, maxHeightCells: 15 });
			// 要求结果不是 null。
			assert.ok(result);
			// 理想约13.333列向上取整为14。
			assert.strictEqual(result.columns, 14);
			// 高度预留为15行。
			assert.strictEqual(result.rows, 15);
			// 精确协议只固定 width=14、height=auto；rows=15 用于本地预留，不作为协议显式高度。
			assert.strictEqual(result.sequence, "\x1b]1337;File=inline=1;size=3;width=14;height=auto:AAAA\x07");
		});

		// iTerm2 组件先用空行预留高度，再在最后一行加上移控制和协议；检查整数组，不向真实终端移动光标。
		it("keeps iTerm2's ceiling-based reserved lines and cursor offset", () => {
			// 常规9×18格令理想高度约4.195行，iTerm2 上取整预留5行。
			setCellDimensions({ widthPx: 9, heightPx: 18 });
			// 创建一个只返回渲染行的 Image 组件。
			const image = new Image(
				// 占位 base64，编码时解码长度为3字节。
				"AAAA",
				// PNG MIME 原样交给 iTerm2 编码。
				"image/png",
				// 回退主题不加颜色。
				{ fallbackColor: (value) => value },
				// 最大内容宽60列。
				{ maxWidthCells: 60 },
				// 显式源图615×86像素。
				{ widthPx: 615, heightPx: 86 },
			);
			// 总宽62得内容60，深比较完整五行数组及末行控制串。
			assert.deepStrictEqual(image.render(62), [
				// 第一行空占位。
				"",
				// 第二行空占位。
				"",
				// 第三行空占位。
				"",
				// 第四行空占位。
				"",
				// 第五行先 ESC[4A 请求上移四行，再发宽60、高auto的 iTerm2 串；该返回值本身没有执行移动。
				"\x1b[4A\x1b]1337;File=inline=1;size=3;width=60;height=auto:AAAA\x07",
			]);
		});
	});
});

// 文字回退组检查 home 缩写、可选 file: 链接及无文件名形式；只构造路径和字符串，不访问文件。
describe("imageFallback", () => {
	// 无链接能力时绝对 home 路径应显示成 ~/...，同时保留 MIME 和原像素尺寸。
	it("shortens home-prefixed absolute paths without hyperlinks", () => {
		// 关闭所有能力，明确走纯文字路径。
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		// finally 确保断言失败也清缓存。
		try {
			// 按本机 home 拼出 .pi/agent/shot.png，不创建文件。
			const abs = join(homedir(), ".pi", "agent", "shot.png");
			// 构造说明文字，1280×720单位是原像素而非终端格。
			const result = imageFallback("image/png", { widthPx: 1280, heightPx: 720 }, abs);
			// 精确比较可见文本及空格/方括号，不含 OSC 链接。
			assert.strictEqual(result, "[Image: ~/.pi/agent/shot.png [image/png] 1280x720]");
			// 退出时清掉本次指定能力。
		} finally {
			// 只清能力缓存。
			resetCapabilitiesCache();
		}
	});

	// 支持链接时绝对路径的可见文字仍缩成 ~，但 OSC 8 目标保持完整 file: URI；只检查字符串，不打开文件。
	it("wraps shortened absolute paths in OSC 8 file links when hyperlinks are enabled", () => {
		// 禁用图片/真彩色但开启链接，单独覆盖超链接路径。
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		// 用 finally 确保清理。
		try {
			// 实际 home 用来得到可缩写的绝对路径。
			const abs = join(homedir(), ".pi", "agent", "shot.png");
			// 用10×10原像素构造说明及链接。
			const result = imageFallback("image/png", { widthPx: 10, heightPx: 10 }, abs);
			// 检查输出含 file:// 的 OSC 8 起始部分，不代表系统已注册或打开该链接。
			assert.ok(result.includes("\x1b]8;;file://"), "expected OSC 8 file link");
			// 再检查目标中保留完整绝对路径；不是完整 URI 编码规范的逐字比较。
			assert.ok(
				// 兼容斜杠归一化形式或原始路径，只做 includes；含空格等特殊路径的编码不由本 fixture 覆盖。
				result.includes(abs.replaceAll("\\", "/")) || result.includes(abs),
				// 断言失败时展示的诊断文字，不是返回字符串内容。
				"file URL should target absolute path",
			);
			// Visible text must use ~/... not the expanded home path.
			// 全局正则移除以 ST 结束的 OSC 8 开/关片段，留下可见文字；这里只用于这个已知格式 fixture。
			const visible = result.replace(/\x1b\]8;;.*?\x1b\\/g, "");
			// 可见文件名仍为 home 缩写，不能显示完整 home 前缀。
			assert.strictEqual(visible, "[Image: ~/.pi/agent/shot.png [image/png] 10x10]");
			// 断言失败也清测试缓存。
		} finally {
			// 能力恢复到下次按环境检测的状态。
			resetCapabilitiesCache();
		}
	});

	// 只有 basename 的相对文件名即使支持链接也不包成 file: 目标；不擅自解析到 cwd。
	it("leaves bare basenames unchanged and does not hyperlink them", () => {
		// 刻意开启链接，才能检验“不是绝对路径”这个拒绝条件。
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		// 进入带清理的断言范围。
		try {
			// 给出无目录的相对文件名与1×1像素说明。
			const result = imageFallback("image/png", { widthPx: 1, heightPx: 1 }, "clankolas.png");
			// 完整返回文本保留 basename。
			assert.strictEqual(result, "[Image: clankolas.png [image/png] 1x1]");
			// 没有任何 OSC 8 开头，不只是可见文字看起来相同。
			assert.ok(!result.includes("\x1b]8;"), "basename must not be hyperlinked");
			// 结束时重置缓存。
		} finally {
			// 不保存或恢复旧缓存对象，仅使缓存失效。
			resetCapabilitiesCache();
		}
	});

	// 不提供 filename 时省略整个文件名段，只显示 MIME 与尺寸，不多出空文件名。
	it("omits filename segment when not provided", () => {
		// 固定无图片/链接能力。
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		// 同步断言后始终清理。
		try {
			// 没有第三参数，精确比较 [Image: [image/png] 8x6] 的格式。
			assert.strictEqual(imageFallback("image/png", { widthPx: 8, heightPx: 6 }), "[Image: [image/png] 8x6]");
			// finally 在断言抛错时同样执行。
		} finally {
			// 清能力结果缓存。
			resetCapabilitiesCache();
		}
	});
});

// Kitty only accepts PNG (f=100); non-PNG images must be transcoded (#10292)
// 本实现 Kitty 编码固定使用 f=100（PNG），因此非 PNG 输入要先转换；这不是说完整 Kitty 协议只有 PNG 格式。
// 本组安装纯内存假转码器，测试成功/失败回退、共享缓存与实例缓存；不运行真正图片库或系统程序。
describe("Image transcoding", () => {
	// 把文字 jpeg 编为 base64，作为稳定测试键；它不是可解码的完整 JPEG。
	const jpeg = Buffer.from("jpeg").toString("base64");
	// Minimal PNG header (signature + IHDR) for a 40x10 image. Enough for getPngDimensions.
	// 24字节的签名/IHDR宽高片段足够当前 getPngDimensions 读出40×10；并非含像素数据、CRC/IEND的完整可显示 PNG。
	const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000280000000a", "hex").toString("base64");
	// 声明字符串数组变量，beforeEach 为每项重新赋值；TS 的类型标注不在运行时创建数组。
	let calls: string[];
	// 便捷渲染回调接收数据/MIME，创建新实例并返回字符串数组；例如 render(jpeg,"image/jpeg")。每次新实例，但转码可命中共享缓存。
	const render = (data: string, mimeType: string) =>
		// 主题回调原样返回；空选项用组件默认值，显式源尺寸20×20，总宽20得18列内容。转换成功后会改用转换 PNG 头的尺寸。
		new Image(data, mimeType, { fallbackColor: (value) => value }, {}, { widthPx: 20, heightPx: 20 }).render(20);
	// 同步假转码器接收数据、记录调用，只有 jpeg 键返回 png，其它返回 null；无 I/O/真正解码。
	// 安装接口可传 MIME，但回调只声明使用第一个参数，这在 TypeScript 的函数兼容规则中允许。
	const transcode = (data: string) => {
		// 把本次输入加入调用记录，便于区分转码执行和缓存命中。
		calls.push(data);
		// 三元表达式：匹配固定 jpeg 返回 PNG 片段，否则报告无法转换。
		return data === jpeg ? png : null;
	};

	// 每项开始重建记录并设置 Kitty/10×10格；本 hook 没有安装转码器，具体用例负责安装，afterEach 负责撤销。
	beforeEach(() => {
		// 新数组避免前一用例的调用计数干扰本例。
		calls = [];
		// 固定走 Kitty，需要时触发非 PNG 转换。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// 单格10×10像素，便于核对转换后比例。
		setCellDimensions({ widthPx: 10, heightPx: 10 });
	});

	// 每项结束撤销转码器、清相关共享转码缓存并恢复能力/格尺寸；不是保存任意旧转码器再还原。
	afterEach(() => {
		// undefined 注销同步转换回调，setter 同时清共享结果缓存，包括失败项。
		setImageTranscoder(undefined);
		// 清本项指定的能力结果。
		resetCapabilitiesCache();
		// 格尺寸回到9×18。
		setCellDimensions({ widthPx: 9, heightPx: 18 });
	});

	// 成功转换后发送 PNG 载荷，尺寸也应来自转换 PNG 而非原20×20显式尺寸；只测编码返回值。
	it("sends converted PNG data sized from the PNG", () => {
		// 安装前面定义的假转换函数，并清共享转换结果缓存。
		setImageTranscoder(transcode);
		// 新建组件渲染 JPEG；实际回调返回40×10 PNG 头片段。
		const lines = render(jpeg, "image/jpeg");
		// && 同时检查固定 PNG 格式字段与转换后载荷/ST，未实际验证终端显示结果。
		assert.ok(lines[0].includes("f=100") && lines[0].includes(`;${png}\x1b\\`));
		// 40x10 PNG at 18 columns: 5 rows, not the 18 rows of the 20x20 source dimensions.
		// 内容宽18格×10px=180px，40×10图同比高45px，优化后5行；原20×20则会占18行。
		assert.strictEqual(lines.length, 5);
	});

	// 没有可用转码器和返回 null 的转码器都走文字回退；换成成功回调并失效组件行缓存后才生成 Kitty 串。
	it("renders a text fallback until a working transcoder is registered", () => {
		// 未给显式尺寸；伪 JPEG 读头失败会使用组件默认尺寸，主题回调原样返回文字。
		const image = new Image(jpeg, "image/jpeg", { fallbackColor: (value) => value });
		// 正则只检查回退开头，未精确比较默认尺寸或整行。
		assert.match(image.render(80)[0], /^\[Image: \[image\/jpeg\]/);
		// 安装永远失败的同步回调；setter 会清共享缓存。
		setImageTranscoder(() => null);
		// 仅清组件的渲染行缓存，使同宽 render 再计算；不是重新创建实例或主动转换。
		image.invalidate();
		// 失败回调仍应得到相同类型的文字回退。
		assert.match(image.render(80)[0], /^\[Image: \[image\/jpeg\]/);
		// 替换为可成功的回调，同时清先前缓存的 null 失败结果。
		setImageTranscoder(transcode);
		// 再次清组件行缓存，否则同宽旧行可直接复用。
		image.invalidate();
		// 只检查新输出首行有 Kitty 前缀，未断言完整格式/载荷。
		assert.ok(image.render(80)[0].includes("\x1b_G"));
	});

	// 原实例成功转换一次；新实例命中共享缓存；插入40种其它键淘汰共享项后，原实例仍保留转换 PNG，不应重调它的 jpeg。
	it("converts each image once", () => {
		// 安装记录调用的假转换器并清共享缓存。
		setImageTranscoder(transcode);
		// 保留一个原始 Image 实例，供共享项被淘汰后再次渲染。
		const image = new Image(jpeg, "image/jpeg", { fallbackColor: (value) => value });
		// 第一次渲染触发 jpeg 成功转换，缓存到共享层及实例字段。
		image.render(80);
		// 辅助函数创建另一个实例，同数据可复用共享成功项；共享缓存实际只以数据为键，不把 MIME 纳入键。
		render(jpeg, "image/jpeg"); // New instance hits the shared cache.
		// 循环40个不同键，for 的 i 从0到39；假回调均返回 null，失败结果也入共享32项缓存，从而淘汰最早 jpeg 项。
		for (let i = 0; i < 40; i++) render(`other-${i}`, "image/jpeg"); // Evicts the shared entry.
		// 只让原组件渲染行失效，已经成功保存的实例 PNG 仍在。
		image.invalidate();
		// 换宽40重新生成行，可直接用原实例 PNG；不需要再请求共享缓存里的旧键。
		image.render(40); // Instance keeps its own PNG.
		// filter 的回调只统计等于 jpeg 的记录，要求恰好一次；其它40次失败转换不计入这个断言。
		assert.strictEqual(calls.filter((data) => data === jpeg).length, 1);
	});

	// 本来 PNG 的 Kitty 输入及 iTerm2 任意原格式都无需转码，检查载荷保留和调用记录为空。
	it("does not convert PNG data or iTerm2 output", () => {
		// 即使安装了转换器，这两类路径也不应调用它。
		setImageTranscoder(transcode);
		// Kitty PNG 输出保留原 PNG 字符串并以 ST 结束。
		assert.ok(render(png, "image/png")[0].includes(`;${png}\x1b\\`));
		// 切到 iTerm2 能力，使 JPEG 可以原样编码而非转 PNG。
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		// .at(-1) 取末行；?. 处理不存在时为 undefined，assert.ok 仍会失败。要求末尾是原 JPEG 载荷及 BEL。
		assert.ok(render(jpeg, "image/jpeg").at(-1)?.endsWith(`:${jpeg}\x07`));
		// 两次操作都没有调用假转码器，而不只是调用次数不多。
		assert.deepStrictEqual(calls, []);
	});
});

// OSC 8 链接组纯粹测试字符串包装，不检查能力、URL有效性、点击行为或打开系统浏览器。
describe("hyperlink", () => {
	// 给文字和 https 地址，要求精确得到开启链接、文字、关闭链接三段。
	it("wraps text in OSC 8 open and close sequences", () => {
		// 函数只生成返回串，不发请求访问 example.com。
		const result = hyperlink("click me", "https://example.com");
		// 两个 OSC 都以 ST 结束，第二个空地址表示关闭链接。
		assert.strictEqual(result, "\x1b]8;;https://example.com\x1b\\click me\x1b]8;;\x1b\\");
	});

	// 带 ANSI 样式的可见文字应原样放入 OSC 链接内部；分别检查开头、内部片段和结尾，不渲染实际颜色。
	it("preserves ANSI styling inside the hyperlink", () => {
		// 下划线/蓝色 SGR 包住 click me，末尾复位。
		const styled = "\x1b[4m\x1b[34mclick me\x1b[0m";
		// 包装时不去掉或重写这段样式。
		const result = hyperlink(styled, "https://example.com");
		// 开头为指向指定 URL 的链接开启控制。
		assert.ok(result.startsWith("\x1b]8;;https://example.com\x1b\\"));
		// 原始 styled 片段完整保留。
		assert.ok(result.includes(styled));
		// 结尾明确关闭链接，避免后续文字继承目标。
		assert.ok(result.endsWith("\x1b]8;;\x1b\\"));
	});

	// 空可见文字也生成成对 OSC 开/关，不省略链接控制。
	it("works with empty text", () => {
		// 传空串，不是 undefined，类型仍满足 string。
		const result = hyperlink("", "https://example.com");
		// 精确结果中两条 OSC 紧挨，没有可见文字。
		assert.strictEqual(result, "\x1b]8;;https://example.com\x1b\\\x1b]8;;\x1b\\");
	});

	// file: URI 与 https 地址一样只是目标字符串；该用例不打开文件、不检查存在性。
	it("works with file:// URIs", () => {
		// README.md 是可见文字，file:///home/user/README.md 是链接目标，路径仅为固定示例。
		const result = hyperlink("README.md", "file:///home/user/README.md");
		// 检查完整 file: 目标保留在输出里。
		assert.ok(result.includes("file:///home/user/README.md"));
		// 只检查包含 README.md；由于目标本身也含此片段，该断言不能单独证明可见标签的位置/完整性。
		assert.ok(result.includes("README.md"));
	});
});
