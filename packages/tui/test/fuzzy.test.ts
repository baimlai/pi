// 验证字符串模糊匹配/过滤排序，不调用模型或网络；每个 it 回调无参数、正常返回 undefined，断言失败会抛错由 node:test 记失败。
// assert 默认导入提供严格值比较、结构比较和真值检查；比较什么就只证明什么，不自动检查未断言的副作用。
import assert from "node:assert";
// describe 分组、it 注册用例，回调里的被测函数在测试运行时才执行。
import { describe, it } from "node:test";
// 导入真实匹配函数，分越低越优；这里不是 mock，也不是编辑距离或相似度百分比。
import { fuzzyFilter, fuzzyMatch } from "../src/fuzzy.ts";

// 分组检查单个 query/text 的匹配状态与分数，回调只注册下方用例。
describe("fuzzyMatch", () => {
	// 空查询例：传空串、检查匹配与零分，无外部状态操作。
	it("empty query matches everything with score 0", () => {
		// 空查询对任意候选成功，保存返回结构。
		const result = fuzzyMatch("", "anything");
		// strictEqual 比较 matches 必须恰为 true，真值字符串不能代替。
		assert.strictEqual(result.matches, true);
		// 检查 score 数值恰为 0。
		assert.strictEqual(result.score, 0);
	});

	// 查询长于候选例：验证提前失败，不断言失败占位分数。
	it("query longer than text does not match", () => {
		// longquery 长于 short，按序匹配不可能成立。
		const result = fuzzyMatch("longquery", "short");
		// 只要求 matches 为 false。
		assert.strictEqual(result.matches, false);
	});

	// 精确相同例：验证成功且分数为负，没有绑定具体评分常量。
	it("exact match has good score", () => {
		// 查询与整个候选都为 test。
		const result = fuzzyMatch("test", "test");
		// 先确认确实匹配成功，避免用失败占位分比较优劣。
		assert.strictEqual(result.matches, true);
		// assert.ok 检查表达式为真；负分来自连续/边界奖励及精确匹配奖励，不只英文所说连续奖励。
		assert.ok(result.score < 0); // Should be negative due to consecutive bonuses
	});

	// 有序子序列例：允许字符中间有其他文字，但不能倒序。
	it("characters must appear in order", () => {
		// abc 在 aXbXc 中按顺序出现，无需连续。
		const matchInOrder = fuzzyMatch("abc", "aXbXc");
		// 验证间隔匹配成功。
		assert.strictEqual(matchInOrder.matches, true);

		// cba 不具备 a→b→c 的顺序。
		const matchOutOfOrder = fuzzyMatch("abc", "cba");
		// 验证倒序不能匹配。
		assert.strictEqual(matchOutOfOrder.matches, false);
	});

	// 大小写例：正反两种大小写组合都成功，不扩展为拼音/音调归一化保证。
	it("case insensitive matching", () => {
		// 大写查询对小写候选。
		const result = fuzzyMatch("ABC", "abc");
		// 检查成功。
		assert.strictEqual(result.matches, true);

		// 小写查询对大写候选，覆盖另一个方向。
		const result2 = fuzzyMatch("abc", "ABC");
		// 再检查成功，底层对两者都小写化。
		assert.strictEqual(result2.matches, true);
	});

	// 连续与散落例：两者都能匹配，连续候选分更低；不要求固定分差。
	it("consecutive matches score better than scattered matches", () => {
		// foobar 开头连续包含 foo。
		const consecutive = fuzzyMatch("foo", "foobar");
		// f_o_o_bar 需要跨下划线取得第二第三个字母。
		const scattered = fuzzyMatch("foo", "f_o_o_bar");

		// 连续项必须匹配。
		assert.strictEqual(consecutive.matches, true);
		// 散落项也必须匹配，之后比较才有意义。
		assert.strictEqual(scattered.matches, true);
		// 更低分表示更优，不是“分越大越相似”。
		assert.ok(consecutive.score < scattered.score);
	});

	// 词边界例：比较两个有效匹配的排序倾向，而非要求用户输入自然语言词。
	it("word boundary matches score better", () => {
		// foo-bar 的 b 在连接符之后，评分规则给予边界奖励。
		const atBoundary = fuzzyMatch("fb", "foo-bar");
		// afbx 的 f/b 在普通文字内部。
		const notAtBoundary = fuzzyMatch("fb", "afbx");

		// 确认边界候选成功。
		assert.strictEqual(atBoundary.matches, true);
		// 确认内部候选成功。
		assert.strictEqual(notAtBoundary.matches, true);
		// 边界奖励足以让这组样本得分更低，不推出任何边界项都胜所有其他项。
		assert.ok(atBoundary.score < notAtBoundary.score);
	});

	// #11220: greedy alignment took o, p, u from "openrouter", so the real "opus" scored worst
	// #11220 回归：真正包含连续 opus 的候选应排在只从前缀散取字符的候选前。
	it("scores a contiguous occurrence instead of an earlier scattered alignment", () => {
		// 保留前方 openrouter 干扰，末尾真实模型名含 opus。
		const opus = fuzzyMatch("opus", "openrouter openrouter/anthropic/claude-opus-4.1");
		// sonnet 名称不含 opus，但共享前缀等仍可能提供散落匹配。
		const sonnet = fuzzyMatch("opus", "openrouter openrouter/anthropic/claude-sonnet-4.5");
		// gpt-oss 同样可产生分散字符匹配。
		const gptOss = fuzzyMatch("opus", "openrouter openrouter/openai/gpt-oss-120b");

		// 要求真实 opus 得分优于 sonnet 样本。
		assert.ok(opus.score < sonnet.score);
		// 同样优于 gpt-oss；未在此单独断言另外两项的 matches。
		assert.ok(opus.score < gptOss.score);
	});

	// 多次连续出现例：不能只给第一次连续出现评分，应考虑后面的更好边界位置。
	it("uses the best contiguous occurrence, not the first", () => {
		// 前面 xxopus 是词内出现，后面空格后的 opus 处于更好边界。
		const embeddedFirst = fuzzyMatch("opus", "xxopus opus");
		// 对照项只在相同较晚位置包含边界 opus。
		const boundaryOnly = fuzzyMatch("opus", "xxxxxx opus");

		// 两者最终应得同分，说明早先较差出现没有覆盖更好出现。
		assert.strictEqual(embeddedFirst.score, boundaryOnly.score);
	});

	// 字母数字交换例：正常有序匹配失败时可把 codex52 交换成 52codex 再试，非任意重排。
	it("matches swapped alpha numeric tokens", () => {
		// 候选中 5、2 在 codex 之前且可隔标点，因此交换后可以按序取得。
		const result = fuzzyMatch("codex52", "gpt-5.2-codex");
		// 只验证回退成功，不检查附加 5 分惩罚的具体数值。
		assert.strictEqual(result.matches, true);
	});
});

// 分组检查多项过滤与排序，getText 回调从每项取得待比文字。
describe("fuzzyFilter", () => {
	// 空查询例：返回所有项；本断言检结构内容，单靠它不能证明数组引用相同。
	it("empty query returns all items unchanged", () => {
		// 构造固定顺序的水果字符串数组。
		const items = ["apple", "banana", "cherry"];
		// 箭头 x:string=>x 为恒等文本提取器，string 是编译期参数类型；源码空查询路径实际上不调用它。
		const result = fuzzyFilter(items, "", (x: string) => x);
		// deepStrictEqual 比较数组元素和顺序；底层此路径直接返回原数组，但这里没有用 strictEqual 单独测身份。
		assert.deepStrictEqual(result, items);
	});

	// 非匹配过滤例：an 只匹配 banana，检查其余样本不存在。
	it("filters out non-matching items", () => {
		// 创建三个候选。
		const items = ["apple", "banana", "cherry"];
		// 对每个候选取它自己作匹配文本，返回通过项的数组。
		const result = fuzzyFilter(items, "an", (x: string) => x);
		// includes 检查结果包含 banana。
		assert.ok(result.includes("banana"));
		// ! 取反，要求 apple 没留在结果。
		assert.ok(!result.includes("apple"));
		// 同样排除 cherry；这些检查不直接断言数组长度。
		assert.ok(!result.includes("cherry"));
	});

	// 排序例：精确连续的 app 应成为首项，不固定后续两项顺序。
	it("sorts results by match quality", () => {
		// 原数组故意先放较差的 a_p_p，避免输入顺序掩盖排序。
		const items = ["a_p_p", "app", "application"];
		// 执行过滤并按累计得分排序，原始 items 顺序不由此改动。
		const result = fuzzyFilter(items, "app", (x: string) => x);

		// "app" should be first (exact consecutive match at start)
		// strictEqual 检查第 0 项恰为 app。
		assert.strictEqual(result[0], "app");
	});

	// 精确与较长前缀例：原顺序 clone/cl，应输出 cl/clone。
	it("prioritizes exact matches over longer prefix matches", () => {
		// 构造较长候选在前的对照。
		const items = ["clone", "cl"];
		// 两项均匹配 cl，精确项的额外奖励决定顺序。
		const result = fuzzyFilter(items, "cl", (x: string) => x);

		// 结构比较同时要求项内容、数量、顺序。
		assert.deepStrictEqual(result, ["cl", "clone"]);
	});

	// 对象候选例：指定 getText 只按 name 检查，id 仍随原对象返回，不进行运行时 schema 校验。
	it("works with custom getText function", () => {
		// 开始构造对象数组，下面每行分别给 name/id 字段。
		const items = [
			// 名称 foo，标识 1。
			{ name: "foo", id: 1 },
			// 名称 bar，不能匹配 foo。
			{ name: "bar", id: 2 },
			// 名称 foobar，可匹配 foo 前缀。
			{ name: "foobar", id: 3 },
		];
		// 内联对象类型约束回调参数字段，箭头返回 item.name；泛型由 items 推断，底层不克隆对象。
		const result = fuzzyFilter(items, "foo", (item: { name: string; id: number }) => item.name);

		// 要求仅剩两个对象。
		assert.strictEqual(result.length, 2);
		// map 回调提取名称，再 includes 检查 foo 存在；不会改原项。
		assert.ok(result.map((r) => r.name).includes("foo"));
		// 同样检查 foobar 存在，此处不限定两项先后顺序。
		assert.ok(result.map((r) => r.name).includes("foobar"));
	});

	// #11220: "radius radius/gpt" contains a, s, t, r, a in order, so every radius model matched there
	// #11220 排序回归：共享 radius 前缀可能散取 astra，但真实 astra 模型应先。
	it("ranks a model containing the query above models matching a shared provider prefix", () => {
		// 候选文本含 provider、模型 ID 与显示名，以贴近模型选择器实际 getText。
		const items = [
			// 普通 gpt-5.4 候选，没有真实 astra 名称。
			"radius radius/gpt-5.4 radius gpt-5.4 GPT 5.4",
			// agentic 对照项。
			"radius radius/agentic radius agentic Agentic",
			// gpt-6-sol 对照项。
			"radius radius/gpt-6-sol radius gpt-6-sol GPT 6 Sol",
			// 第四项真实包含连续 astra，作为预期首项。
			"radius radius/gpt-6-astra radius gpt-6-astra GPT 6 Astra",
		];
		// 对 astra 执行真实过滤/打分，恒等箭头保留整段候选文字。
		const result = fuzzyFilter(items, "astra", (x: string) => x);

		// 首项应等于原数组下标 3 的字符串，未要求其他项全部过滤掉。
		assert.strictEqual(result[0], items[3]);
	});

	// 斜杠分词例：query 的 provider/model 两块可分别在倒置文本中匹配，不要求跨 token 按原顺序。
	it("matches slash-separated provider/model queries against reordered text", () => {
		// 对象里模型 ID 与 provider 分开保存。
		const item = { id: "gpt-5.5", provider: "openai-codex" };
		// 文本回调按模型再 provider 拼接，查询反过来；模板只生成字符串，不调用远端模型。
		const result = fuzzyFilter([item], "openai-codex/gpt-5.5", (model) => `${model.id} ${model.provider}`);

		// 结果结构应包含原对象；这不是独立的对象引用身份断言。
		assert.deepStrictEqual(result, [item]);
	});
});
