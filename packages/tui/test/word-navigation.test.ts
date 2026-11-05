// 测试编辑器的按词移动边界，输入/返回位置全是 UTF-16 字符串下标，不是显示列；没有真实编辑器或终端操作。
// 断言失败同步抛错交 node:test；每个 it 回调无参数、正常返回 undefined，只检查本用例明确列出的边界。
import assert from "node:assert";
// describe 分组注册场景，it 注册执行回调。
import { describe, it } from "node:test";
// 导入实际前后导航算法；可选分段策略在最后一组用内存 Map 注入。
import { findWordBackward, findWordForward } from "../src/word-navigation.ts";

// 向左组：每次直接给独立 cursor，不是由函数修改某个共享光标。
describe("findWordBackward", () => {
	// 普通空格分词例：从末尾跨 world，再从其开头跳空白和 hello。
	it("basic words: hello world", () => {
		// hello 五个码元、空格一个、world 五个，共 11。
		const text = "hello world";
		// 从下标 11 左移到 world 开头 6。
		assert.strictEqual(findWordBackward(text, 11), 6);
		// 从 6 先跳过左侧空格，再跨 hello 到 0。
		assert.strictEqual(findWordBackward(text, 6), 0);
	});

	// 点号例：词与标点边界分别停靠，不能一次吞整个 foo.bar。
	it("dotted: foo.bar", () => {
		// 构造长度 7 的对照文字。
		const text = "foo.bar";
		// bar 后退到其开头 4，即点号之后。
		assert.strictEqual(findWordBackward(text, 7), 4);
		// 再左移跨点号，停 3，即 foo 之后。
		assert.strictEqual(findWordBackward(text, 4), 3);
		// 最后跨 foo 到字符串起点。
		assert.strictEqual(findWordBackward(text, 3), 0);
	});

	// 冒号例：沿用点号场景，检查另一种 ASCII 标点边界。
	it("colon: foo:bar", () => {
		// 冒号在下标 3，bar 在 4 开始。
		const text = "foo:bar";
		// 从末尾回到 bar 起点 4。
		assert.strictEqual(findWordBackward(text, 7), 4);
		// 从 4 跨冒号回到 3。
		assert.strictEqual(findWordBackward(text, 4), 3);
		// 再跨 foo 到 0。
		assert.strictEqual(findWordBackward(text, 3), 0);
	});

	// 路径例：file、斜杠、to、斜杠、path 逐段回退，不把路径当双击选择算法的连接词规则。
	it("path: path/to/file", () => {
		// 固定路径长度 12。
		const text = "path/to/file";
		// 跨 file 回到 8。
		assert.strictEqual(findWordBackward(text, 12), 8);
		// 跨末尾斜杠回到 7。
		assert.strictEqual(findWordBackward(text, 8), 7);
		// "/to" is one word-like segment with "/" as punctuation boundary
		// 跨 to 回到 5；即使默认词分段把带斜杠的文字并段，算法仍保留 ASCII 标点边界。
		assert.strictEqual(findWordBackward(text, 7), 5);
		// 再跨前一个斜杠回到 4。
		assert.strictEqual(findWordBackward(text, 5), 4);
		// 最后跨 path 回 0。
		assert.strictEqual(findWordBackward(text, 4), 0);
	});

	// 中英文例：检查当前分词规则下的预期位置，不把汉字终端宽度当字符串长度。
	it("CJK mixed", () => {
		// 四个汉字各占一个 UTF-16 码元，空格在 4，test 从 5 开始。
		const text = "你好世界 test";
		// 从全文末尾跨 test，回到下标 5。
		assert.strictEqual(findWordBackward(text, text.length), 5);
		// Intl.Segmenter treats each CJK char as a separate word-like segment
		// 原英文“每个汉字单独一词”并不符合下面预期：此处先跳空格，再跨“世界”到 2；断言按当前 Intl 分段结果写，不应推成任意中文都逐字。
		assert.strictEqual(findWordBackward(text, 5), 2);
		// 再跨“你好”到 0。
		assert.strictEqual(findWordBackward(text, 2), 0);
	});

	// 边缘空白例：一次跳过光标前连续空白，再跨一个词；仅剩空白时可到 0。
	it("whitespace at boundaries", () => {
		// 两侧各两空格，总长度 9。
		const text = "  hello  ";
		// 从末尾先过两空格，再过 hello，停在左留白之后 2。
		assert.strictEqual(findWordBackward(text, 9), 2);
		// 从 2 跳完左留白到 0，没有额外词可跨。
		assert.strictEqual(findWordBackward(text, 2), 0);
	});

	// 连续标点例：三个点作为一组跨越，而不是每次只走一个点。
	it("punctuation run: foo...bar", () => {
		// foo 占 0..2，三个点占 3..5，bar 从 6 起。
		const text = "foo...bar";
		// 跨 bar 到 6。
		assert.strictEqual(findWordBackward(text, 9), 6);
		// 一次跨 ... 到 3。
		assert.strictEqual(findWordBackward(text, 6), 3);
		// 再跨 foo 到 0。
		assert.strictEqual(findWordBackward(text, 3), 0);
	});

	// 左边界例：cursor=0 直接返回 0，不调用分段器。
	it("cursor at 0 returns 0", () => {
		// strictEqual 检查没有产生负下标。
		assert.strictEqual(findWordBackward("hello", 0), 0);
	});
});

// 向右组：返回“跳过当前一个词/符号段”后的字符串下标，空白通常先跳过。
describe("findWordForward", () => {
	// 普通词例：先停 hello 末尾，再跳空格和 world 到全文末尾。
	it("basic words: hello world", () => {
		// 构造同一长度 11 样本。
		const text = "hello world";
		// 从 0 跨 hello 到 5，空格尚未跨。
		assert.strictEqual(findWordForward(text, 0), 5);
		// 从 5 先跨空格，再跨 world 到 11。
		assert.strictEqual(findWordForward(text, 5), 11);
	});

	// 点号向右例：先停标点前，再跨标点，最后跨后面的词。
	it("dotted: foo.bar", () => {
		// 点号在 3 的样本。
		const text = "foo.bar";
		// 跨 foo 停 3，不连带跨点。
		assert.strictEqual(findWordForward(text, 0), 3);
		// 跨点停 4。
		assert.strictEqual(findWordForward(text, 3), 4);
		// 跨 bar 停 7。
		assert.strictEqual(findWordForward(text, 4), 7);
	});

	// 冒号向右例：与点号同样保留标点边界。
	it("colon: foo:bar", () => {
		// 构造冒号样本。
		const text = "foo:bar";
		// 到 foo 后的下标 3。
		assert.strictEqual(findWordForward(text, 0), 3);
		// 跨冒号到 4。
		assert.strictEqual(findWordForward(text, 3), 4);
		// 跨 bar 到 7。
		assert.strictEqual(findWordForward(text, 4), 7);
	});

	// 路径向右例：依次跨 path、斜杠、to、斜杠、file。
	it("path: path/to/file", () => {
		// 构造长度 12 的路径。
		const text = "path/to/file";
		// path 之后下标 4。
		assert.strictEqual(findWordForward(text, 0), 4);
		// 跨首个斜杠到 5。
		assert.strictEqual(findWordForward(text, 4), 5);
		// 跨 to 到 7。
		assert.strictEqual(findWordForward(text, 5), 7);
		// 跨第二斜杠到 8。
		assert.strictEqual(findWordForward(text, 7), 8);
		// 跨 file 到末尾 12。
		assert.strictEqual(findWordForward(text, 8), 12);
	});

	// 中英文向右例：首步只限定落在中文区，并循环验证最终可以到末尾，不钉死首段长度。
	it("CJK mixed", () => {
		// 中文四码元、英文 test 四码元，中间空格。
		const text = "你好世界 test";
		// 从起点算一次词末下标，函数不修改 text。
		const firstEnd = findWordForward(text, 0);
		// 首步必须向右推进。
		assert.ok(firstEnd > 0);
		// 首步不可越过整个中文区域；与 backward 组的具体 2/0 预期强度不同。
		assert.ok(firstEnd <= 4);
		// Walk to end
		// let 让当前游标可以在循环中重新赋值，初始 0。
		let pos = 0;
		// 尚未达到全文长度时继续。
		while (pos < text.length) {
			// 从当前下标计算下一词边界。
			const next = findWordForward(text, pos);
			// 若函数不推进，break 防止测试死循环，随后末尾断言仍会暴露未走到末尾。
			if (next === pos) break;
			// 用返回值更新测试局部游标。
			pos = next;
		}
		// 最终必须恰等于 text.length，而不只是比起点更大。
		assert.strictEqual(pos, text.length);
	});

	// 前导/尾随空白例：先跳前导空白并跨词，剩尾随空白下一步到末尾。
	it("whitespace at boundaries", () => {
		// 两侧各两空格样本。
		const text = "  hello  ";
		// 从 0 先跨两个空格与 hello，到 7。
		assert.strictEqual(findWordForward(text, 0), 7);
		// 再跨末尾两空格，到 9。
		assert.strictEqual(findWordForward(text, 7), 9);
	});

	// 连续标点向右例：... 一次整体跨过。
	it("punctuation run: foo...bar", () => {
		// 构造长度 9 对照。
		const text = "foo...bar";
		// foo 后停 3。
		assert.strictEqual(findWordForward(text, 0), 3);
		// 标点组后停 6。
		assert.strictEqual(findWordForward(text, 3), 6);
		// bar 后停 9。
		assert.strictEqual(findWordForward(text, 6), 9);
	});

	// 右边界例：已经在 text.length 就原位返回，不调用分段回调。
	it("cursor at end returns end", () => {
		// hello 长度 5，结果必须仍为 5。
		assert.strictEqual(findWordForward("hello", 5), 5);
	});
});

// 原子段组：注入预先准备的词段，让粘贴占位标记作为一个单位；这是导航策略测试，不是在解析真实剪贴板或插入粘贴数据。
describe("atomic segments", () => {
	// marker 含空格/标点但希望一次跨过，字符串长度为 19。
	const marker = "[paste #1 +5 lines]";
	// 模板把 marker 拼到 hello 与 world 之间，总长度 31；这里仅构造测试文本。
	const text = `hello ${marker} world`;
	// 原子判定回调输入 s:string、返回是否恰等于 marker，无副作用；例普通 hello 返回 false，不按任意带方括号就判原子。
	const isAtomic = (s: string) => s === marker;

	// The functions slice text before calling segment(), so we map each expected
	// substring to its pre-split segments.
	// 用 Map<string,Intl.SegmentData[]> 按被测函数实际切出的子串查词段；泛型仅编译期约束，没有运行时分词/校验。
	const segmentMap = new Map<string, Intl.SegmentData[]>([
		// 第一条 Map entry 是二元数组 [子串键,分段数组]，不是任意二维表格。
		[
			// 先放完整 text 作键；后面 slice(0,text.length) 产生同一字符串键，会覆盖本条值，而不是保留两条独立记录。
			text, // full text (not used but for clarity)
			// 此数组的每项描述一个词段：segment 是文字、index 是相对子串的码元偏移、input 是元数据、isWordLike 是词样标记；算法主要按 segment.length 走位。
			[
				// hello 从 0 起，标为词段。
				{ segment: "hello", index: 0, input: text, isWordLike: true },
				// 空格从 5 起，非词段。
				{ segment: " ", index: 5, input: text, isWordLike: false },
				// 整个 marker 从 6 起，词样标记与额外 isAtomic 判定一起配合，不再拆内部空白。
				{ segment: marker, index: 6, input: text, isWordLike: true },
				// marker 后的空格在 25。
				{ segment: " ", index: 25, input: text, isWordLike: false },
				// world 从 26 起。
				{ segment: "world", index: 26, input: text, isWordLike: true },
			],
		],
		// 第二条 entry 也为完整 text，Map 相同键以这次提供的值为准。
		[
			// backward from end: slice(0, 31) = full text
			// slice 不截掉任何内容，所以与前一条 text 键相等；原英文说首条 not used 可结合覆盖理解。
			text.slice(0, text.length),
			// 此完整文本对应的分段列表，供从全文末尾向左调用使用。
			[
				// 完整子串中的 hello，长度 5。
				{ segment: "hello", index: 0, input: text, isWordLike: true },
				// 紧随 hello 的空白段，长度 1。
				{ segment: " ", index: 5, input: text, isWordLike: false },
				// 原子 marker 作为一个 19 码元词段。
				{ segment: marker, index: 6, input: text, isWordLike: true },
				// marker 后一空格。
				{ segment: " ", index: 25, input: text, isWordLike: false },
				// 最后 world，长度 5。
				{ segment: "world", index: 26, input: text, isWordLike: true },
			],
		],
		// 第三条 entry 专供 cursor=26 的左侧子串。
		[
			// backward from 26: slice(0, 26) = "hello [paste #1 +5 lines] "
			// slice(0,26) 包括 marker 后空格，但没有 world。
			text.slice(0, 26),
			// 对这个子串准备四个分段，顺序与原文一致。
			[
				// 首词 hello，在子串下标 0。
				{ segment: "hello", index: 0, input: text, isWordLike: true },
				// 首个空格，在 5。
				{ segment: " ", index: 5, input: text, isWordLike: false },
				// marker 在 6，作为完整段。
				{ segment: marker, index: 6, input: text, isWordLike: true },
				// 末尾空格在 25，向左算法先跳它。
				{ segment: " ", index: 25, input: text, isWordLike: false },
			],
		],
		// 第四条 entry 供 cursor=6 的右侧子串。
		[
			// forward from 6: slice(6) = "[paste #1 +5 lines] world"
			// 从 6 切至全文末尾，子串以 marker 开头，坐标重新从 0 计。
			text.slice(6),
			// 右侧子串的三段列表；这些对象的 input 字段仍写全文 text，当前算法不靠该字段推算坐标，不能视作任意自定义分段都完整验证过。
			[
				// marker 相对子串从 0 起，不是全文的 6。
				{ segment: marker, index: 0, input: text, isWordLike: true },
				// 后空格相对子串在 19。
				{ segment: " ", index: 19, input: text, isWordLike: false },
				// world 相对子串在 20。
				{ segment: "world", index: 20, input: text, isWordLike: true },
			],
		],
	]);

	// 把两种回调组成导航选项；类型由对象字段推断，不改变默认全局分段器。
	const opts = {
		// segment 回调接收被测函数切出的 input，返回 Map 中数组或 ?? 的新空数组；不匹配任何键会返回无段，不自动 fallback 到 Intl。
		segment: (input: string) => segmentMap.get(input) ?? [],
		// 保存上面 isAtomic 函数引用；这里不立即执行判定。
		isAtomicSegment: isAtomic,
	};

	// 从全文末尾左移例：先跨 world，到 26，尚未遇到 marker。
	it("backward skips word then stops before atomic marker", () => {
		// 传 opts 让算法使用预制分段，严格检查返回位置 26。
		assert.strictEqual(findWordBackward(text, text.length, opts), 26);
	});

	// 从 world 前左移例：跳空格再把 marker 一次整体跨过。
	it("backward skips whitespace then atomic marker as one unit", () => {
		// cursor=26，先减空格 1 再减 marker 19，恰到 6，不停在其内部空格。
		assert.strictEqual(findWordBackward(text, 26, opts), 6);
	});

	// 从 marker 起点右移例：一次跨完整原子段。
	it("forward skips atomic marker as one unit", () => {
		// 预期为原下标 6 加 marker.length，而非仅走到 paste 或第一个空格。
		assert.strictEqual(findWordForward(text, 6, opts), 6 + marker.length);
	});
});
