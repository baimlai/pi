// 验证斜杠命令的技能名称匹配、排序、前导空白保留和参数替换；只执行命令分支，不运行技能或发模型请求。
// 导入 Node 断言，失败会让所在测试拒绝或抛出。
import assert from "node:assert";
// describe 注册分组，it 注册各个独立异步用例。
import { describe, it } from "node:test";
// 导入真实组合补全器；构造只存配置，本例命令分支不会列目录或启动 fd。
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

// 命令名/参数补全的测试组，下面的 commands 是所有用例共用的内存候选数据。
describe("CombinedAutocompleteProvider slash-command filter", () => {
	// 数组元素由 name/description 组成，TypeScript 从字面量推断结构；数组不是实际技能实现。
	const commands = [
		// 裸名 deep-research 没有 i；完整名可从 skill 取 i 再接后面的 d/e/a，所以 idea 在完整名回退轮仍能命中它。
		{ name: "skill:deep-research", description: "Multi-agent deep research" },
		// research-idea 是 idea 查询预期排首位的项。
		{ name: "skill:research-idea", description: "Refine a raw idea into a falsifiable seed" },
		// to-sidecar 用于检查显式 skill: 前缀查询。
		{ name: "skill:to-sidecar", description: "Route work to a sidecar" },
		// brainstorm 用于检验 skbra 这种跨前缀的模糊简写。
		{ name: "skill:brainstorm", description: "Generate ideas" },
		// 普通 model 命令用于确认技能特殊匹配没有破坏一般命令。
		{ name: "model", description: "Select the active model" },
	];

	// 辅助函数：输入不含/的查询前缀，创建补全器→查询整行末尾→断言非空→提取 value；返回 Promise<string[]>，例 idea 得候选名数组，异常沿 Promise 传播。
	async function suggestionsFor(prefix: string): Promise<string[]> {
		// 为每次查询新建提供者；process.cwd() 只取路径字符串，此命令分支不读取该目录内容。
		const provider = new CombinedAutocompleteProvider(commands, process.cwd());
		// 模板字符串给查询加上开头/，模拟编辑器当前一行的文字。
		const line = `/${prefix}`;
		// 行号0、光标在 UTF-16 末尾；await 等待候选结果，不代表等待某个技能运行。
		const result = await provider.getSuggestions([line], 0, line.length, {
			// 提供未取消的信号满足查询接口；命令名分支本身不借此中断计算。
			signal: new AbortController().signal,
		});
		// 断言 result 不为 null，同时为 TypeScript 缩窄类型；第二参数只在失败时解释输入。
		assert.ok(result, `expected suggestions for "/${prefix}"`);
		// map 回调把每个候选转为写回正文用的 value，返回新数组而不修改候选。
		return result.items.map((item) => item.value);
	}

	// 查询 idea，要求裸技能名命中的 research-idea 排在完整名回退命中的 deep-research 前；只证明这组候选的排序，错误会拒绝 async 用例。
	it("ranks skill:research-idea first for query 'idea'", async () => {
		// 等待辅助查询得到命令名字列表。
		const items = await suggestionsFor("idea");
		// equal 使用宽松相等比较，不同于 strictEqual；这里实际值和预期值都是字符串，检查第一项为目标技能名。
		assert.equal(items[0], "skill:research-idea");
		// 比较两个 indexOf 下标；它本身不单独断言 deep-research 存在，但若缺失返回-1就无法大于首项0。
		assert.ok(items.indexOf("skill:deep-research") > items.indexOf("skill:research-idea"));
	});

	// 普通命令回归：查询 mod 后只要求 model 存在，不要求结果仅有一项或固定完整顺序。
	it("keeps ordinary slash commands matching", async () => {
		// 发起内存命令匹配。
		const items = await suggestionsFor("mod");
		// includes 验证原普通命令仍可找到。
		assert.ok(items.includes("model"));
	});

	// 逐个输入空格/Tab缩进的命令，检查查询前缀、唯一候选、应用后正文和光标；失败终止此例，不会修改全局配置。
	it("completes commands after leading whitespace and preserves it", async () => {
		// 只配置一个 model 候选，让后面可以精确断言候选列表。
		const provider = new CombinedAutocompleteProvider([{ name: "model" }], process.cwd());
		// for...of 逐项解构出输入 line 与预期 expected；每对都独立查询。
		for (const [line, expected] of [
			// 单空格加裸/：空命令查询也应保留缩进并补 model 和末尾空格。
			[" /", " /model "],
			// 双空格加部分命令名：替换时不能删除这两个前导空格。
			["  /mod", "  /model "],
			// Tab缩进是原始输入的一部分，应用补全时原样保留而不展开为空格。
			["\t/mod", "\t/model "],
			// as const 将数组静态推断为只读字面量元组，便于解构；运行时不 Object.freeze。
		] as const) {
			// 以本轮行末为光标位置调用查询。
			const result = await provider.getSuggestions([line], 0, line.length, {
				// 每轮新建未取消信号，不启动定时器或外部任务。
				signal: new AbortController().signal,
			});
			// 确认结果存在，后续访问 prefix/items 才能安全通过静态检查。
			assert.ok(result);
			// 提供者返回的替换前缀不含行首空白，与 trimStart 的结果一致。
			assert.equal(result.prefix, line.trimStart());
			// 用深比较检查整个候选值数组，而非只检查包含 model。
			assert.deepStrictEqual(
				// map 每项为写回值，忽略用于展示的 label/description。
				result.items.map((item) => item.value),
				// 预期恰好一个普通命令。
				["model"],
			);
			// ! 是非空断言，仅影响 TS；上面的完整数组断言已检查本例确有第一项，再用原 prefix 做实际替换。
			const applied = provider.applyCompletion([line], 0, line.length, result.items[0]!, result.prefix);
			// 检查更新后的第一行严格保留缩进并添加命令和一个空格。
			assert.equal(applied.lines[0], expected);
			// 新光标应位于替换后字符串末尾；这里比较码元下标，不测屏幕列。
			assert.equal(applied.cursorCol, expected.length);
		}
	});

	// 给 model 配同步参数回调，输入带缩进的 /model son，验证回调收到 son、返回值只替换参数；异步查询仍会 await 同步结果。
	it("completes command arguments after leading whitespace", async () => {
		// 构造提供者，参数分几行写出：候选数组和基目录。
		const provider = new CombinedAutocompleteProvider(
			// 命令配置数组，此例只有一个带参数补全的命令。
			[
				// 命令对象的字段同时描述名称和实际可执行的参数补全回调。
				{
					// 精确命令名称，参数补全先按它查找而非模糊匹配。
					name: "model",
					// 回调输入是第一个命令分隔空格之后的整段参数前缀，返回候选数组；本例无 I/O，若断言失败错误传播到外层 await。
					getArgumentCompletions: (prefix: string) => {
						// 证明前导缩进与 /model 没有混入参数前缀。
						assert.equal(prefix, "son");
						// 返回单个候选，value 用于正文替换、label 用于菜单展示，此处两者相同。
						return [{ value: "sonnet", label: "sonnet" }];
					},
				},
			],
			// 取当前目录字符串满足构造参数，本例不会走普通文件补全。
			process.cwd(),
		);
		// 模拟两空格缩进后的命令和未完成参数。
		const line = "  /model son";
		// 对完整一行的末尾位置请求建议。
		const result = await provider.getSuggestions([line], 0, line.length, {
			// 传入新信号；当前 getArgumentCompletions 接口没有接收此信号。
			signal: new AbortController().signal,
		});
		// 确认有非空参数候选结果。
		assert.ok(result);
		// 参数的替换范围仅是 son，不能覆盖前面的命令和缩进。
		assert.equal(result.prefix, "son");
		// 应用第一个候选到 son 所在后缀，返回新行数组，不修改传入的单行数组。
		const applied = provider.applyCompletion([line], 0, line.length, result.items[0]!, result.prefix);
		// 参数分支不自动追加命令名分支的尾随空格，故预期恰好到 sonnet。
		assert.equal(applied.lines[0], "  /model sonnet");
	});

	// 显式包含 skill: 的查询也应匹配完整技能名；只要求目标存在，不约束完整排序。
	it("keeps explicit skill: queries working", async () => {
		// 查询完整前缀的一部分。
		const items = await suggestionsFor("skill:side");
		// 验证包含 to-sidecar，不会执行 sidecar 路由。
		assert.ok(items.includes("skill:to-sidecar"));
	});

	// Regression test for #9944.
	// 对应原英文 #9944 回归：输入 skill 时应按配置顺序列出所有技能；比较过滤后的完整数组，未约束非技能候选。
	it("lists skills while typing the skill prefix", async () => {
		// 请求正在输入的 skill 前缀，不要求先输冒号。
		const items = await suggestionsFor("skill");
		// 深比较实际技能名字和配置派生出的预期名字。
		assert.deepStrictEqual(
			// filter 只保留技能候选，startsWith 是精确大小写前缀判断。
			items.filter((item) => item.startsWith("skill:")),
			// 预期也从同一配置过滤并 map 名字，验证原顺序而非只验证集合相等。
			commands
				.filter((command) => command.name.startsWith("skill:"))
				.map((command) => command.name),
		);
	});

	// 模糊简写回归：skbra 可跨 skill: 前缀与 brainstorm 字母匹配；仅检查目标存在。
	it("keeps fuzzy skill-prefix shorthand working", async () => {
		// 请求该简写的命令建议。
		const items = await suggestionsFor("skbra");
		// 检查 brainstorm 仍在候选中，未证明任意模糊查询的排序。
		assert.ok(items.includes("skill:brainstorm"));
	});
});
