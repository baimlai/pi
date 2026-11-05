// 测截断与多种 Unicode 列宽兼容规则，不写终端/调用网络；各 it 无参数、正常返回 void，断言失败抛错。字符串长度、字素数、显示列数是三种不同单位。
// assert.ok 检条件真，strictEqual 比数值或完整字符串；没有性能计时/复杂度断言。
import assert from "node:assert";
// 注册测试分组及场景回调。
import { describe, it } from "node:test";
// 截断返回显示副本，visibleWidth 估算列数，normalizeTerminalOutput 生成发屏兼容文本；都不修改原逻辑字符串。
import { normalizeTerminalOutput, truncateToWidth, visibleWidth } from "../src/utils.ts";

// 截断组：为省略号预留预算，保留连续完整字素前缀，必要时关闭链接/重置样式。
describe("truncateToWidth", () => {
	// 巨大输入例：只取 40 列以内；验证功能结果，不意味着测试给出运行时或内存上限保证。
	it("keeps output within width for very large unicode input", () => {
		// repeat(100_000) 构造十万组双宽字符，数字下划线只提高可读性，运行时仍为 100000。
		const text = "🙂界".repeat(100_000);
		// 目标 40 列，省略号改用单个省略符；不把源字符串按码元硬切 40。
		const truncated = truncateToWidth(text, 40, "…");

		// 测量结果不得超过 40，允许因完整宽字放不下而少于目标。
		assert.ok(visibleWidth(truncated) <= 40);
		// 结尾应为省略符再 SGR0，防止样式泄漏到后续输出。
		assert.strictEqual(truncated.endsWith("…\x1b[0m"), true);
	});

	// 有颜色大输入例：保留前缀颜色，省略号前后均恢复默认样式。
	it("preserves ANSI styling for kept text and resets before and after ellipsis", () => {
		// 模板组合红色码、1000 组 hello 空格、源末重置；这里只构造文本，没有真正打印。
		const text = `\x1b[31m${"hello ".repeat(1000)}\x1b[0m`;
		// 截到总计最多 20 列，包含省略符预算。
		const truncated = truncateToWidth(text, 20, "…");

		// 再按实际返回控制串测显示列。
		assert.ok(visibleWidth(truncated) <= 20);
		// 保留部分应仍包含原红色前景码；此断言不是逐字检查颜色状态。
		assert.strictEqual(truncated.includes("\x1b[31m"), true);
		// 截后结尾明确是重置→省略符→重置。
		assert.strictEqual(truncated.endsWith("\x1b[0m…\x1b[0m"), true);
	});

	// OSC8 例：截链接标签时应补对应关闭码，让省略号不继续携带该链接，无网络访问。
	it("closes a BEL-terminated OSC 8 link when truncating its label", () => {
		// open 用非空 URL 打开链接，BEL 为终止符。
		const open = "\x1b]8;;https://example.com\x07";
		// close 用空 URL 关闭活动链接，也以 BEL 结束。
		const close = "\x1b]8;;\x07";
		// 链接标签长度超过目标，原文虽有 close，截掉尾部后仍需在保留前缀末补 close。
		const text = `${open}some-longer-label-here${close}`;

		// 默认省略号三点共 3 列，15 列总预算保留 12 列 some-longer-；严格比较完整控制码顺序和文本。
		assert.strictEqual(truncateToWidth(text, 15), `${open}some-longer-${close}\x1b[0m...\x1b[0m`);
	});

	// 异常前缀例：包含未完成/未识别 ANSI 的字符串仍能返回有限宽结果，不安装真实终端输入处理器。
	it("handles malformed ANSI escape prefixes without hanging", () => {
		// ESC 后 not-ansi 不构成这里支持的完整外壳，后面再接大量双宽字符。
		const text = `abc\x1bnot-ansi ${"🙂".repeat(1000)}`;
		// 执行真实截断器，回调内同步返回后才继续断言。
		const truncated = truncateToWidth(text, 20, "…");

		// 只检查输出不超 20；“不挂住”靠测试实际能完成观察，并未设置独立毫秒性能阈值。
		assert.ok(visibleWidth(truncated) <= 20);
	});

	// 宽省略号例：省略号也必须完整放入预算，不能留半个双宽字素。
	it("clips wide ellipsis safely and brackets it with resets", () => {
		// 目标仅 1 列，双宽省略号一个都放不下，正文又超限，结果空串而不是半图形。
		assert.strictEqual(truncateToWidth("abcdef", 1, "🙂"), "");
		// 目标 2 列恰好能放省略号，前后加 SGR0，正文前缀为空。
		assert.strictEqual(truncateToWidth("abcdef", 2, "🙂"), "\x1b[0m🙂\x1b[0m");
		// 再按列宽确认该结果不超过 2。
		assert.ok(visibleWidth(truncateToWidth("abcdef", 2, "🙂")) <= 2);
	});

	// 原文能完整放下例：即使省略号很宽，也不能为预留省略号而误截本来合适的正文。
	it("returns the original text when it already fits even if ellipsis is too wide", () => {
		// a 仅 1 列，2 列容量足够，原样返回。
		assert.strictEqual(truncateToWidth("a", 2, "🙂"), "a");
		// 单个汉字 2 列正好，仍返回原文，不加省略号或重置。
		assert.strictEqual(truncateToWidth("界", 2, "🙂"), "界");
	});

	// 补白例：截后因宽字边界剩下空列时，由第四参 true 补 ASCII 空格到目标。
	it("pads truncated output to requested width", () => {
		// 双宽字符序列截到 8 列、省略符 1 列、pad=true；第四参数不改变源文。
		const truncated = truncateToWidth("🙂界🙂界🙂界", 8, "…", true);
		// 这次必须恰好 8 列，而非只要求 <=8。
		assert.strictEqual(visibleWidth(truncated), 8);
	});

	// 空省略号例：不显示点号但实际截断后仍需关闭样式。
	it("adds a trailing reset when truncating without an ellipsis", () => {
		// 构造未闭合红色的长 hello，省略号传空串，容量 10。
		const truncated = truncateToWidth(`\x1b[31m${"hello".repeat(100)}`, 10, "");
		// 检结果未超 10 列。
		assert.ok(visibleWidth(truncated) <= 10);
		// 即使省略号为空，结尾也应带 SGR0。
		assert.strictEqual(truncated.endsWith("\x1b[0m"), true);
	});

	// 连续前缀例：装不下下一个宽字后，不能跳过它再捡后面的空格或标记。
	it("keeps a contiguous prefix instead of skipping a wide grapheme and resuming later", () => {
		// 原文起始双宽字符 2 列加 tab 3 列共 5；7 列先预留省略符后只余 6，所以后面的汉字放不下，启用 pad。
		const truncated = truncateToWidth("🙂\t界 \x1b_abc\x07", 7, "…", true);
		// 保留原 tab 字符，随后重置、省略符、重置、一个补白；真正发屏前才由正规化工具把可见 tab 展开。
		assert.strictEqual(truncated, "🙂\t\x1b[0m…\x1b[0m ");
	});
});

// 宽度兼容组：断言项目约定，不是字体实测或承诺所有 Unicode 实现完全一样。
describe("visibleWidth", () => {
	// 混合 tab/颜色例：tab 要计宽、完整颜色控制码不计。
	it("counts tabs inline and skips ANSI inline", () => {
		// tab 3 加汉字 2 为 5，颜色码/重置零宽。
		assert.strictEqual(visibleWidth("\t\x1b[31m界\x1b[0m"), 5);
	});

	// 南亚文字例：Intl 可把多个会占列码点并成一字素，函数仍按终端兼容规则补算相应辅音/标记，不是每个字素一律 1。
	it("counts Indic conjunct spacing code points within grapheme clusters", () => {
		// 本组天城文结合串按项目规则为 2 列。
		assert.strictEqual(visibleWidth("र्क"), 2);
		// 更长天城文样本预期 5，检查组合后的总宽度。
		assert.strictEqual(visibleWidth("नेटवर्क"), 5);
		// 整句多词/空格样本预期 33，检累计结果而非字形像素。
		assert.strictEqual(visibleWidth("सर्वाधिकार सुरक्षित। ऑर्डर पर क्लिक करें"), 33);
		// 孟加拉文结合样本为 2。
		assert.strictEqual(visibleWidth("র্ক"), 2);
		// 古吉拉特文结合样本为 2。
		assert.strictEqual(visibleWidth("ર્ક"), 2);
		// 奥里亚文结合样本为 2。
		assert.strictEqual(visibleWidth("ର୍କ"), 2);
		// 泰卢固文结合样本为 2。
		assert.strictEqual(visibleWidth("ర్క"), 2);
		// 马拉雅拉姆文结合样本为 2，不按其 UTF-16 码元数量机械相加。
		assert.strictEqual(visibleWidth("ര്‍ക"), 2);
	});

	// 普通结合标记例：不能把所有 Unicode Mark 都当独立显示格，要保留这些既有零宽行为。
	it("keeps ordinary combining marks zero-width", () => {
		// e 加 U+0301 重音仍为 1 列，\u 转义在运行时形成实际码点。
		assert.strictEqual(visibleWidth("e\u0301"), 1);
		// 五个带重音拉丁字母各 1，共 5。
		assert.strictEqual(visibleWidth("čřžůú"), 5);
		// 希伯来基础字母加元音/点标记仍为 1。
		assert.strictEqual(visibleWidth("שָׁ"), 1);
		// 阿拉伯基础字母加结合标记仍为 1。
		assert.strictEqual(visibleWidth("بّ"), 1);
		// 藏文结合样本为 1，区别于上面的南亚额外占列规则。
		assert.strictEqual(visibleWidth("རྐ"), 1);
		// 塔加洛字母结合样本为 1。
		assert.strictEqual(visibleWidth("ᜠ᜴"), 1);
		// 韩文基础音节加单点声调标记仍计基础 2 列。
		assert.strictEqual(visibleWidth("가〮"), 2);
		// 双点声调样本也仍为 2，不机械给所有后续码点加 1。
		assert.strictEqual(visibleWidth("가〯"), 2);
	});

	// 中日文例：新增南亚规则不能改变已有 CJK 双宽及日文组合形式计宽。
	it("keeps CJK and Japanese width accounting unchanged", () => {
		// 两汉字各 2，共 4。
		assert.strictEqual(visibleWidth("网络"), 4);
		// 六个片假名各 2，共 12。
		assert.strictEqual(visibleWidth("ネットワーク"), 12);
		// 预组合浊音假名为 2。
		assert.strictEqual(visibleWidth("が"), 2);
		// 分解成基础假名加 U+3099 浊音标记仍为 2，不按两码元算 4。
		assert.strictEqual(visibleWidth("か\u3099"), 2);
	});

	// 缅文标记例：特定终端占列标记会额外占格，另一些组合标记仍零宽；按每个样本结果核对，不概括成所有缅文 Mark 都占 1。
	it("counts Myanmar marks that terminals allocate cells for", () => {
		// 基础字母加本例占列元音记 2。
		assert.strictEqual(visibleWidth("ကာ"), 2);
		// 另一占列元音样本记 2。
		assert.strictEqual(visibleWidth("ကေ"), 2);
		// 基础字母加本例占列标记记 2。
		assert.strictEqual(visibleWidth("က်"), 2);
		// 本例尾随缅文标记按项目占列规则额外计宽，总共 2。
		assert.strictEqual(visibleWidth("ကျ"), 2);
		// 另一相邻标记样本记 2。
		assert.strictEqual(visibleWidth("ကြ"), 2);
		// 本例扩展元音标记计额外 1，共 2。
		assert.strictEqual(visibleWidth("ကဳ"), 2);
		// 另一元音样本同样共 2。
		assert.strictEqual(visibleWidth("ကဴ"), 2);
		// 本例元音符号样本共 2。
		assert.strictEqual(visibleWidth("ကဵ"), 2);
		// 本例尾随占列标记样本共 2。
		assert.strictEqual(visibleWidth("ကး"), 2);
		// 这个元音组合仍为 1，作为不应误加宽的对照。
		assert.strictEqual(visibleWidth("ကို"), 1);
		// 这个结合串也为 1，防止规则扩大到所有标记。
		assert.strictEqual(visibleWidth("က္"), 1);
	});

	// 泰语/老挝语 AM 例：兼容宽度不直接等于 Unicode 码点数，单独元音与前有辅音的组合分别核对。
	it("keeps Thai and Lao AM clusters at their normal cell width", () => {
		// 单独泰语 AM 按 1 列。
		assert.strictEqual(visibleWidth("ำ"), 1);
		// 单独老挝语 AM 也为 1。
		assert.strictEqual(visibleWidth("ຳ"), 1);
		// 前有基础辅音的泰语组合按 2。
		assert.strictEqual(visibleWidth("กำ"), 2);
		// 老挝语相应组合按 2。
		assert.strictEqual(visibleWidth("ກຳ"), 2);
	});

	// 输出正规化例：只返回终端显示用副本，检查指定元音的兼容拆分及拆前拆后的估算宽一致，不改编辑器逻辑值。
	it("normalizes Thai and Lao AM vowels only for terminal output", () => {
		// 泰语 U+0E33 拆成 U+0E4D/U+0E32，两码点不是“两个任意字符替换”。
		assert.strictEqual(normalizeTerminalOutput("ำ"), "ํา");
		// 老挝语 U+0EB3 拆成 U+0ECD/U+0EB2。
		assert.strictEqual(normalizeTerminalOutput("ຳ"), "ໍາ");
		// 加上 abc 后，输出副本与原文估算总宽相同。
		assert.strictEqual(visibleWidth(normalizeTerminalOutput("ำabc")), visibleWidth("ำabc"));
		// 老挝语样本同样保持宽度，不代表所有正规化都保字节或全部 Unicode NFKC。
		assert.strictEqual(visibleWidth(normalizeTerminalOutput("ຳabc")), visibleWidth("ຳabc"));
	});
});
