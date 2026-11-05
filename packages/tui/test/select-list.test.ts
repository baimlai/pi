// 验证选择列表生成的行文字、描述列对齐、自定义截断和翻页通知，不启动 TUI/终端。各 it 回调无参数、正常返回 void，断言失败同步抛错。
// assert 提供结构、相等与真值比较，断言只覆盖明确列出的样本，不代表所有宽字/窄屏布局都已检查。
import assert from "node:assert";
// 注册分组/场景，真正 render 或 handleInput 在各用例执行时运行。
import { describe, it } from "node:test";
// 导入实际列表组件，输入项/主题/布局都是内存对象。
import { SelectList } from "../src/components/select-list.ts";
// 显示列宽工具用于把字符串位置换成终端格数，避免直接把码元下标当显示列。
import { visibleWidth } from "../src/utils.ts";

// 无颜色主题：这些回调只原样返回输入，无 IO/副作用，隔离 ANSI 样式对测试的干扰；保存对象本身不执行函数。
const testTheme = {
	// 选中前缀回调输入 string、返回同串；当前 SelectList 实际未单独调用此字段，保留以满足主题契约。
	selectedPrefix: (text: string) => text,
	// 选中整行样式同样恒等，例箭头/正文不会附额外 ANSI。
	selectedText: (text: string) => text,
	// 普通描述样式直接返回传入的空格和说明。
	description: (text: string) => text,
	// 页码提示样式不加颜色。
	scrollInfo: (text: string) => text,
	// 无匹配提示也原样返回。
	noMatch: (text: string) => text,
};

// 从 line 找 text 首次出现并算其前缀显示列，返回 number、不改输入；例前缀有中文时比 indexOf 更合适。没找到先断言抛错，避免 slice(0,-1) 掩盖问题。
const visibleIndexOf = (line: string, text: string): number => {
	// indexOf 返回 UTF-16 下标，-1 代表未找到，不是终端列数。
	const index = line.indexOf(text);
	// notEqual 确认不是 -1；此处两个操作数都是 number，不涉及字符串数字转换差异。
	assert.notEqual(index, -1);
	// slice 得前缀再 visibleWidth 测列宽，不将 text 本身算进起点。
	return visibleWidth(line.slice(0, index));
};

// 分组只注册以下布局与输入用例，不直接写终端。
describe("SelectList", () => {
	// 多行说明例：足够宽时渲染成一行，用空格连接三段，避免一项说明撑破行布局。
	it("normalizes multiline descriptions to single line", () => {
		// 构造单项候选数组，类型由对象字面量推断。
		const items = [
			// 单个对象保存实际值、展示标签和可选说明。
			{
				// value 是逻辑选择值，也用于前缀过滤。
				value: "test",
				// label 是显示文字，本例与 value 一样，不代表所有项目必须相同。
				label: "test",
				// 三段说明用真实换行字符分隔，组件应在渲染前改成空格。
				description: "Line one\nLine two\nLine three",
			},
		];

		// 最大可见项 5、恒等主题，构造只保存配置，不渲染或通知选择。
		const list = new SelectList(items, 5, testTheme);
		// 用 100 列实际渲染，给说明列足够预算，返回字符串数组。
		const rendered = list.render(100);

		// 要求至少有一行，随后才检查首项。
		assert.ok(rendered.length > 0);
		// 首行不许包含 LF；没有单独检查其他控制字符或全部输出行。
		assert.ok(!rendered[0].includes("\n"));
		// 首行应含规范化后完整三段说明，而不是简单丢掉换行后内容。
		assert.ok(rendered[0].includes("Line one Line two Line three"));
	});

	// 长短标签例：较长主文字截断后，两个说明的起始显示列仍一致。
	it("keeps descriptions aligned when the primary text is truncated", () => {
		// 构造两项以比较对齐，原始顺序固定。
		const items = [
			// 短标签项，同时给实际值和说明。
			{ value: "short", label: "short", description: "short description" },
			// 第二项用多行对象语法，各字段仍属于同一个候选。
			{
				// 长逻辑值用于样本，不在测试中执行对应命令。
				value: "very-long-command-name-that-needs-truncation",
				// 长显示标签超过默认主列预算，会触发截断。
				label: "very-long-command-name-that-needs-truncation",
				// 第二条说明作为对齐定位标记。
				description: "long description",
			},
		];

		// 未配置布局，默认主列上下限都为 32。
		const list = new SelectList(items, 5, testTheme);
		// 80 列足够保留两项说明。
		const rendered = list.render(80);

		// 对首条/第二条各定位说明的显示起点，要求相等，不要求截断后的长标签具体文字。
		assert.equal(visibleIndexOf(rendered[0], "short description"), visibleIndexOf(rendered[1], "long description"));
	});

	// 最小主列例：标签很短也至少给主列 12 列，使说明从前缀 2 加主列 12 处开始。
	it("uses the configured minimum primary column width", () => {
		// 两个短项作为对照。
		const items = [
			// 一列标签 a，说明 first。
			{ value: "a", label: "a", description: "first" },
			// 两列标签 bb，说明 second。
			{ value: "bb", label: "bb", description: "second" },
		];

		// 第四参数提供列宽范围，两个项共用它。
		const list = new SelectList(items, 5, testTheme, {
			// 需求虽短，最小主列为 12。
			minPrimaryColumnWidth: 12,
			// 最大主列为 20，不是本例会达到的宽度。
			maxPrimaryColumnWidth: 20,
		});
		// 在 80 列渲染，足够展示说明，不走窄屏单列退路。
		const rendered = list.render(80);

		// 恒等样式下，箭头/空格前缀和本例 ASCII 文字的每个码元都恰占一列，说明起点为 14。
		assert.equal(rendered[0].indexOf("first"), 14);
		// 第二项也必须从下标 14 起；不是对任意 CJK/ANSI 行使用 indexOf 就能得到显示列。
		assert.equal(rendered[1].indexOf("second"), 14);
	});

	// 最大主列例：长标签需要更宽，但目标列被上限 20 夹住，说明从 22 列起。
	it("uses the configured maximum primary column width", () => {
		// 构造长项加短项，使同一计算出的主列宽作用于两者。
		const items = [
			// 长项对象开始。
			{
				// 长实际值用于身份/过滤。
				value: "very-long-command-name-that-needs-truncation",
				// 长标签超过 20 列上限，渲染会截断。
				label: "very-long-command-name-that-needs-truncation",
				// first 是长项的说明定位文字。
				description: "first",
			},
			// 短项保留 second 说明供对齐比较。
			{ value: "short", label: "short", description: "second" },
		];

		// 配置主列 12..20，实际需求较大故取上限。
		const list = new SelectList(items, 5, testTheme, {
			// 主列下限 12。
			minPrimaryColumnWidth: 12,
			// 主列上限 20，不含前面两列箭头/空白前缀。
			maxPrimaryColumnWidth: 20,
		});
		// 用 80 列渲染说明布局。
		const rendered = list.render(80);

		// 长项说明的显示起列为 2+20=22。
		assert.equal(visibleIndexOf(rendered[0], "first"), 22);
		// 短项说明也在 22，主文字短就补更多空格。
		assert.equal(visibleIndexOf(rendered[1], "second"), 22);
	});

	// 自定义截断例：加省略号的同时仍维持两个说明起点一致，回调只修改显示字符串，不改候选值。
	it("allows overriding primary truncation while preserving description alignment", () => {
		// 构造长项和短项对照。
		const items = [
			// 长项的对象字段如下。
			{
				// 长实际选择值不被截断回写。
				value: "very-long-command-name-that-needs-truncation",
				// 长显示标签交给 truncatePrimary。
				label: "very-long-command-name-that-needs-truncation",
				// 长项说明 first。
				description: "first",
			},
			// 短项说明 second，标签通常直接返回。
			{ value: "short", label: "short", description: "second" },
		];

		// 提供固定主列和自定义截断回调，构造时只保存它，render 时才执行。
		const list = new SelectList(items, 5, testTheme, {
			// 最小主列 12。
			minPrimaryColumnWidth: 12,
			// 最大也为 12，固定主列宽度；正文 maxWidth 还会扣掉两列间距。
			maxPrimaryColumnWidth: 12,
			// 解构上下文中的 text/maxWidth，由组件接口推断类型；回调返回显示文字，无副作用，例超长时预留一列放省略号。此样本按码元切，不能照搬为任意宽字正确截断算法。
			truncatePrimary: ({ text, maxWidth }) => {
				// text.length 与 maxWidth 比较在本例 ASCII 标签里成立，不能一般等同于终端列宽。
				if (text.length <= maxWidth) {
					// 未超长就返回原 text，不附省略号。
					return text;
				}

				// 超长时取最多 maxWidth-1 个码元，再加省略号；Math.max 防负切点，组件收到结果后仍再按显示宽限制。
				return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
			},
		});
		// 真正 render 才调用上述回调，内部按同一主列对齐说明。
		const rendered = list.render(80);

		// 长项行应包含省略号；此断言不钉死截后全部字符。
		assert.ok(rendered[0].includes("…"));
		// 比较两个说明的显示起列，确保自定义结果不打乱列布局。
		assert.equal(visibleIndexOf(rendered[0], "first"), visibleIndexOf(rendered[1], "second"));
	});

	// #7629 回归：每次翻页移动最多可见页长，首末夹住且重复到边界不通知；空过滤结果也不发通知。
	it("moves by one visible page with selection page keys (#7629)", () => {
		// Array.from 长度 12，映射回调忽略第一参数 _、使用 index 生成 value/label；括号包对象字面量作为隐式返回，每项为独立对象。
		const items = Array.from({ length: 12 }, (_, index) => ({ value: `item-${index}`, label: `Item ${index}` }));
		// 页长 maxVisible=5，用默认全局键位管理器解析后面的 PageUp/Down。
		const list = new SelectList(items, 5, testTheme);
		// string[] 明确记录通知顺序，初始无记录。
		const selections: string[] = [];
		// 回调接收真实候选 item，把其 value push 进数组；push 返回长度，void 契约允许调用方不使用它，组件实际也不读取此返回值，不是回传新索引。
		list.onSelectionChange = (item) => selections.push(item.value);

		// for...of 依次喂四个 PageDown(ESC[6~) 与一个 PageUp(ESC[5~)，每次同步执行 handleInput；不是输入监听器或真实按键发送。
		for (const key of ["\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[5~"]) list.handleInput(key);

		// 选中从 0 到 5、10、11，再按下仍 11 不通知，最后上页到 6，检查记录恰为四条。
		assert.deepStrictEqual(selections, ["item-5", "item-10", "item-11", "item-6"]);

		// 前缀过滤 no match 得空列表并重置内部下标 0，不自行触发选择变化通知。
		list.setFilter("no match");
		// 空列表再喂 PageDown，虽然翻页辅助可算 0，组件仍应跳过通知。
		list.handleInput("\x1b[6~");
		// 记录与之前完全相同，证明这一步没有追加新通知；不单独检查空列表渲染提示。
		assert.deepStrictEqual(selections, ["item-5", "item-10", "item-11", "item-6"]);
	});
});
