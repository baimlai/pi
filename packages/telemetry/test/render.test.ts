// 纯内存验证StoredSpan如何变成文本树：先构造可控快照，再比较完整输出与输入未变；不写真实终端、不读取远端trace。
// Vitest以describe登记一组、it登记各例，expect比较文本及输入是否被修改。
import { describe, expect, it } from "vitest";
// StoredSpan只是TS快照接口，import type不把它变成运行时类。
import type { StoredSpan } from "../src/index.ts";
// 导入纯文本树渲染器，不启动终端、模型或遥测后端。
import { renderTrace } from "../src/render.ts";

// 测试数据工厂：给id和可选覆盖项，返回完整StoredSpan；例span("child",{parentId:"root"})。Partial把每字段变可选，默认{}；浅展开保留覆盖引用，无校验/深克隆。
function span(id: string, overrides: Partial<StoredSpan> = {}): StoredSpan {
	// 每次新建外层对象与下面的默认数组/属性表，避免默认容器跨调用共享。
	return {
		// id属性简写来自参数，不自动生成UUID。
		id,
		// 默认同归名为trace的追踪，个别测试再覆盖。
		traceId: "trace",
		// 显示名字默认等于id，后面可覆盖成更友好文字。
		name: id,
		// 默认开始epoch为0，便于得到确定耗时。
		startedMs: 0,
		// 默认结束10，配起点0就是10ms。
		endedMs: 10,
		// 默认没有属性。
		attributes: {},
		// 默认没有事件，每次调用分配新数组。
		events: [],
		// 默认没有跨span关联。
		links: [],
		// 默认成功状态，不会把名字叫failure自动推成error。
		status: { status: "ok" },
		// 后展开overrides覆盖同名默认值；不递归合并attributes，也不会冻结传入对象。
		...overrides,
	};
}

// 八例分别验证树顺序、显示字段、link、合并去重、稳定序、转义、深树与空输入。
describe("renderTrace", () => {
	// 综合例子故意打乱输入，构造根/两孩子/孙子并带各种属性、事件、link和error，比较完整输出且确认输入不变。
	it("renders an unordered trace with attributes, durations, errors, events, and links", () => {
		// 先造root，覆盖默认时钟与附加字段。
		const root = span("root", {
			// 起点1000。
			startedMs: 1000,
			// 终点1020，因此根显示20ms。
			endedMs: 1020,
			// 下列属性用不同标量/数组类型检查格式化，不是输出时才验证其数据类型。
			attributes: {
				// 带空格字符串应带JSON式引号，不能直接裸拼。
				request: "a b",
				// 数字2按数字输出。
				attempt: 2,
				// 布尔false不应当成“没有属性”而省略。
				cached: false,
				// 字符串数组按JSON显示，保持顺序。
				tags: ["a", "b"],
				// 数值数组同样显示内容。
				sizes: [1, 2],
				// 布尔数组也要保留false成员。
				flags: [true, false],
			},
			// 两个事件按输入顺序显示，在同一span行之后。
			events: [
				// checkpoint含phase属性及相对偏移2ms。
				{ name: "checkpoint", timeMs: 2, attributes: { phase: "tools" } },
				// 第二事件偏移3.5，验证小数毫秒而非强制整数。
				{ name: "tick", timeMs: 3.5, attributes: {} },
			],
			// link只打印目标身份/附加属性，不递归取远端span。
			links: [
				// 第一link同时给远端trace/span与原因。
				{ traceId: "remote-trace", spanId: "remote", attributes: { reason: "steer" } },
				// 第二link不带attributes，渲染器应仍能输出身份。
				{ traceId: "other-trace", spanId: "other" },
			],
		});
		// 第一孩子带详细错误，和第二个仅error状态的情况区分。
		const first = span("first", {
			// parentId确定它属于root，不由数组位置推断。
			parentId: "root",
			// 孩子起点1005。
			startedMs: 1005,
			// 终点1009.5，因此耗时4.5ms。
			endedMs: 1009.5,
			// error详情应显示name和message，渲染不负责自动脱敏。
			status: { status: "error", error: { name: "Error", message: "failed call" } },
		});
		// nested父为first，因此比first再多一层缩进，耗时1ms。
		const nested = span("nested", { parentId: "first", startedMs: 1006, endedMs: 1007 });
		// 第二个孩子开始比first晚，显示顺序应排后。
		const second = span("second", {
			// 同样挂root，不挂前一条输入记录。
			parentId: "root",
			// 开始1010。
			startedMs: 1010,
			// 结束1012，对应2ms。
			endedMs: 1012,
			// 仅error状态无详情时，也要显示error，不读不存在的message。
			status: { status: "error" },
		});
		// Object.freeze浅冻结打乱的输入数组，不深冻每span；不允许渲染器原地sort该数组。
		const spans = Object.freeze([second, nested, first, root]);
		// structuredClone为纯数据建立对照副本，渲染后检查成员也没被改；此API不用于渲染实现内部。
		const before = structuredClone(spans);
		// 完整文本用toBe逐字符比较，验证空格、层次、顺序、数字与换行。
		expect(renderTrace(spans)).toBe(
			// 以下逐行构造期望文本，最后join而非依赖源文件排版换行。
			[
				// 根属性按插入序显示，根无父所以不缩进。
				'root request="a b" attempt=2 cached=false tags=["a","b"] sizes=[1,2] flags=[true,false] (20ms)',
				// checkpoint事件缩进一层，并显示+2ms相对时间。
				'  · checkpoint phase="tools" (+2ms)',
				// tick保留3.5ms小数，无属性不补空对象文字。
				"  · tick (+3.5ms)",
				// 第一link显示原因属性。
				'  → link trace remote-trace span remote reason="steer"',
				// 第二link只显示两个目标id。
				"  → link trace other-trace span other",
				// 第一孩子缩进两空格，并保留错误详情原文。
				"  first (4.5ms) error Error: failed call",
				// 孙子缩进四空格，不与第二孩子放同层。
				"    nested (1ms)",
				// 第二孩子只有通用error后缀。
				"  second (2ms) error",
				// join("\n")只在行之间加换行，没有额外末尾换行。
			].join("\n"),
		);
		// 渲染后输入与渲染前副本结构相同，覆盖冻结未保护的成员对象。
		expect(spans).toEqual(before);
	});

	// 缺父例子让later引用输入中不存在的external；应成为本地根。根/孩子按开始时间排列，link不改变树归属。
	it("treats missing parents as roots and orders roots and children by start time", () => {
		// expect接下面渲染调用的字符串结果。
		expect(
			// 直接传未排序数组，无需调用方先建树。
			renderTrace([
				// later缺实际父记录，因此作为根显示，不被丢弃。
				span("later", { parentId: "external", startedMs: 20, endedMs: 30 }),
				// child可找到later，归它下层，开始25。
				span("child", { parentId: "later", startedMs: 25, endedMs: 30 }),
				// earlier开始10应排前；它link later并不把later当孩子。
				span("earlier", { startedMs: 10, endedMs: 15, links: [{ traceId: "trace", spanId: "later" }] }),
			]),
			// 期望earlier在前，link紧随其后，later再带child，逐字符检查缩进。
		).toBe(["earlier (5ms)", "  → link trace trace span later", "later (10ms)", "  child (5ms)"].join("\n"));
	});

	// link环例子创建两个独立trace互相关联；只打印箭头行，不沿link递归，因此无需把link环当父树环处理。
	it("prints cross-trace links without following them, including cycles", () => {
		// 断言下面结果与完整期望文本相同。
		expect(
			// 数组里是两个根，没有parentId。
			renderTrace([
				// 第一根全局id为server:1，名字稍后单独设。
				span("server:1", {
					// 显示名server不等于完整id文本。
					name: "server",
					// 第一根归server-trace。
					traceId: "server-trace",
					// 它关联worker-trace中的worker:1。
					links: [{ traceId: "worker-trace", spanId: "worker:1" }],
				}),
				// 另一个根id为worker:1。
				span("worker:1", {
					// 显示名worker。
					name: "worker",
					// 第二根归不同trace。
					traceId: "worker-trace",
					// 它反向link server:1，形成关联环；不是父子边环。
					links: [{ traceId: "server-trace", spanId: "server:1" }],
				}),
			]),
			// 下面给出期待四行，无重复跟随目标而造成无限输出。
		).toBe(
			// 期望数组以join产生多行文本。
			[
				// server根默认耗时10ms。
				"server (10ms)",
				// server的link只显示目标身份。
				"  → link trace worker-trace span worker:1",
				// worker作为第二独立根，开始相同则沿输入顺序。
				"worker (10ms)",
				// worker反向link也只显示一行。
				"  → link trace server-trace span server:1",
				// 行间换行，末尾不加额外换行。
			].join("\n"),
		);
	});

	// 去重例子把两个store可能重复提供的root/child副本混进数组，期待按全局id只渲染一次；此例副本内容相同，不测试冲突字段选谁。
	it("deduplicates spans merged from stores by global ID", () => {
		// 根id与显示名分别为server:1与root。
		const root = span("server:1", { name: "root" });
		// 创建工作端child，随后故意再提供它的克隆。
		const child = span("worker:1", {
			// 显示名child。
			name: "child",
			// 父id跨来源指向server:1，靠身份建树，不靠数组相邻。
			parentId: "server:1",
			// child事件只应打印一次，若去重失败就会重复。
			events: [{ name: "done", timeMs: 3, attributes: {} }],
		});
		// grandchild父为worker:1，展示三级结构。
		const grandchild = span("worker:2", { name: "grandchild", parentId: "worker:1" });
		// structuredClone制造不同对象身份但相同id的数据，排除“只按引用去重”也能误通过的情况。
		expect(renderTrace([child, root, grandchild, structuredClone(root), structuredClone(child)])).toBe(
			// 期望根/孩子/事件/孙子各一行，字符串里的\n负责分隔四行。
			"root (10ms)\n  child (10ms)\n    · done (+3ms)\n    grandchild (10ms)",
		);
	});

	// 稳定序例子所有起点都是0，孩子z先a后，两个根root先other后；期望沿输入序，而非按名字字典序。
	it("preserves input order for equal start times without mutating the input", () => {
		// 浅冻结数组阻止原地排序，但每个span对象仍可变。
		const spans = Object.freeze([
			// root先进入输入。
			span("root"),
			// 第一个同起点孩子名字z。
			span("z", { parentId: "root" }),
			// 第二个名字a，按字典序本应在z前，故能区分排序策略。
			span("a", { parentId: "root" }),
			// 另一个根other也与root同起点。
			span("other"),
		]);
		// 输出仍z在a前、root在other前，检查同起点稳定性。
		expect(renderTrace(spans)).toBe("root (10ms)\n  z (10ms)\n  a (10ms)\nother (10ms)");
	});

	// 转义例子给属性含实际换行与引号，期待用反斜线转义而不删除内容；不是敏感数据屏蔽测试。
	it("escapes string attribute values without hiding their contents", () => {
		// 输入字符串里的\n在运行时是真换行，双引号是内容；renderTrace应把它们转成可单行显示形式。
		expect(renderTrace([span("root", { attributes: { text: 'line one\n"line two"' } })])).toBe(
			// 期望源码的双反斜线形成输出里的一个反斜线；引号也被转义，原文字仍完整保留。
			'root text="line one\\n\\"line two\\"" (10ms)',
		);
	});

	// 深树例子构造2000层链，验证输出成功且层数正确；测试本身不直接窥探是否调用递归，迭代实现需结合render.ts阅读。
	it("renders deep trees without recursive calls", () => {
		// Array.from按length生成0..1999，_表示不用数组原值，只用index。
		const spans = Array.from({ length: 2000 }, (_, index) =>
			// 首项无父，后续每项父id是前一个数字字符串；String把数字身份变字符串，形成单链。
			span(String(index), index === 0 ? {} : { parentId: String(index - 1) }),
		);
		// 一次渲染整棵深树，若栈溢出会直接使测试失败。
		const rendered = renderTrace(spans);
		// 无事件/link时每span恰好一行，分割后应与记录数相同。
		expect(rendered.split("\n")).toHaveLength(spans.length);
		// 最后一层1999有1999组双空格缩进；repeat计层，不是JSON层级值的解析。
		expect(rendered.endsWith(`${"  ".repeat(1999)}1999 (10ms)`)).toBe(true);
	});

	// 空输入例子检查边界：返回空串，不抛错也不补标题。
	it("renders an empty input as an empty string", () => {
		// 空数组直接渲染应严格等于""。
		expect(renderTrace([])).toBe("");
	});
});
