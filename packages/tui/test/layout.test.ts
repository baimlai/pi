// 验证布局帧的尺寸分配、裁剪、滚动边界与滚动条样式；只处理内存组件/字符串/图片元数据，不创建真实终端或解码真实图片。
// 默认导入 Node 断言，断言失败会抛出并使所在用例失败。
import assert from "node:assert";
// describe/it 注册测试分组与用例；async 用例的 Promise 由测试运行器等待。
import { describe, it } from "node:test";
// 横排容器把主轴尺寸解释为列宽。
import { HStack } from "../src/components/h-stack.ts";
// 滚动窗口保存内容偏移、跟随状态及滚动条暂显计时器。
import { ScrollView } from "../src/components/scroll-view.ts";
// Text 负责正文折行/补白，本例通常把横纵 padding 都设为0以方便比较。
import { Text } from "../src/components/text.ts";
// 竖排容器把主轴尺寸解释为行高。
import { VStack } from "../src/components/v-stack.ts";
// 布局入口返回盒子树和屏幕行，不直接写终端。
import { renderLayoutFrame } from "../src/layout.ts";
// Kitty编码器只造控制字符串；登记函数改共享元数据表，供裁剪按像素/格数换算。
import { encodeKitty, registerKittyImageMetadata } from "../src/terminal-image.ts";
// 剥离受支持终端控制串，便于断言可见文字；与真实终端渲染器不是同一实现。
import { stripTerminalSequences } from "../src/utils.ts";

// 辅助函数输入一组渲染行，逐条剥控制码再 trimEnd，返回新数组；例带背景的 top 加尾空格变成 top，不改原数组或写终端，工具异常传播。
function visibleLines(lines: string[]): string[] {
	// map 回调处理每条字符串；trimEnd 会去掉实际尾空格，故这些断言有意不比较行末 padding。
	return lines.map((line) => stripTerminalSequences(line).trimEnd());
}

// 视口布局测试组，下面每例独立创建布局对象；Kitty用例还会显式修改共享元数据表，结束时未撤销该条记录。
describe("viewport layout", () => {
	// 总高4里固定标题占1，body从basis0按grow取剩余3；先比较几何再比较文字，任何差异抛断言。
	it("allocates vertical grow space deterministically", () => {
		// 传根组件、总宽、总高和后续重画回调，立即计算内存帧。
		const frame = renderLayoutFrame(
			// 根是竖排，两条配置对象分别描述组件和主轴规则。
			new VStack([
				// 标题basis1且shrink0，不能为其他内容主动缩小。
				{ component: new Text("top", 0, 0), basis: 1, shrink: 0 },
				// 正文basis0、grow1取得剩余高度，虽然文字本身只有一行。
				{ component: new Text("body", 0, 0), basis: 0, grow: 1 },
			]),
			// 全帧10列宽。
			10,
			// 全帧4行高，不是终端像素。
			4,
			// 空回调忽略后续重画请求，本例直接检查本次帧，不调度真实渲染。
			() => {},
		);

		// 深比较所有直接孩子的高度数组，验证分配结果而非只看文字。
		assert.deepStrictEqual(
			// map 读取各子盒子的rect.height，返回新数字数组。
			frame.root.children.map((child) => child.rect.height),
			// 预期标题1行、正文3行。
			[1, 3],
		);
		// 可见文字占前两行，分给正文的剩余空间保持空行。
		assert.deepStrictEqual(visibleLines(frame.lines), ["top", "body", "", ""]);
	});

	// 用render计数验证显式basis0的滚动内容不会在Stack测量时额外渲染；最终布局仍需渲染一次，未测耗时或所有嵌套情形。
	it("does not render fixed-basis scroll content during stack measurement", () => {
		// let 计数器允许回调原地累加。
		let renderCount = 0;
		// 把最小Component对象包成滚动窗口。
		const transcript = new ScrollView({
			// 无参render回调记录被调用次数，返回三行测试内容，无 I/O；每次执行都会加计数。
			render: () => {
				// 累加真实调用次数，不是模拟渲染完成通知。
				renderCount += 1;
				// 返回固定三行，给最终绘制提供内容高度。
				return ["one", "two", "three"];
			},
			// 空失效回调满足Component契约，此对象没有派生缓存。
			invalidate: () => {},
		});
		// 竖排让滚动区拿可增长空间，dock按自然高测量。
		const root = new VStack([
			// basis0已明确尺寸起点，测量时不应为了求自然高重复render滚动正文。
			{ component: transcript, basis: 0, grow: 1 },
			// dock用auto，必须从Text实际渲染高度确定尺寸。
			{ component: new Text("dock", 0, 0), basis: "auto" },
		]);
		// 在10列3行中布局，空重画回调不产生外部任务。
		renderLayoutFrame(root, 10, 3, () => {});
		// 整个本次布局只调用正文render一次；这里没有单独调用render绘制另一帧。
		assert.strictEqual(renderCount, 1);
	});

	// 用十亿长度的稀疏数组验证末尾3行可被裁剪绘制，前面的空洞不该被逐项展开；预期文本正确，但不是精确计时/内存基准。
	it("paints only clipped rows from very large scroll content", () => {
		// 数字分隔符_仅让源码易读，运行值是一十亿。
		const lineCount = 1_000_000_000;
		// string[]只静态说明已存在元素应为字符串；JS数组仍允许length范围内有空洞。
		const lines: string[] = [];
		// 仅把length增到十亿，不生成十亿个字符串，也不等于完全没有数组元数据成本。
		lines.length = lineCount;
		// 窗口上方紧邻的一条已赋值行，用来确保它不会混入末尾3行。
		lines[lineCount - 4] = "before";
		// 末三行的第一条实际值。
		lines[lineCount - 3] = "visible 1";
		// 末三行的第二条实际值。
		lines[lineCount - 2] = "visible 2";
		// 数组最后位置实际值，其余绝大部分索引仍为空洞。
		lines[lineCount - 1] = "visible 3";
		// 创建滚动包装器，传组件与follow配置。
		const transcript = new ScrollView(
			// 最小正文Component对象，不继承其他渲染逻辑。
			{
				// render直接返回同一稀疏数组，不map/join遍历全部空洞。
				render: () => lines,
				// 无缓存的失效操作为空。
				invalidate: () => {},
			},
			// 首次布局跟随末尾，最终scrollTop会定位到十亿减3。
			{ follow: "end" },
		);

		// 布局器先看数组长度确定内容高，绘制只读取裁剪到视口的行；不是把整数组传给真实终端。
		const frame = renderLayoutFrame(transcript, 10, 3, () => {});
		// 精确断言输出只有末三条可见文字，不含紧前的before。
		assert.deepStrictEqual(visibleLines(frame.lines), ["visible 1", "visible 2", "visible 3"]);
	});

	// 两组件自然高共6但视口仅4，第一项允许缩到min1、第二项禁止缩；比较高度与最终文字，失败直接抛出。
	it("shrinks entries to their minimum sizes", () => {
		// 生成10列4行的布局帧。
		const frame = renderLayoutFrame(
			// 竖排配置把收缩规则和组件绑定。
			new VStack([
				// 第一项自然3行，可收缩但不能低于1。
				{ component: new Text("a1\na2\na3", 0, 0), shrink: 1, minSize: 1 },
				// 第二项自然3行，shrink0保持完整高度。
				{ component: new Text("b1\nb2\nb3", 0, 0), shrink: 0 },
			]),
			// 横向宽10列足以容纳这些短文本。
			10,
			// 行高预算4，需从第一项减去2行。
			4,
			// 后续重画请求用空函数忽略。
			() => {},
		);

		// 深比较最终子盒子高度。
		assert.deepStrictEqual(
			// 读取根的直接孩子尺寸。
			frame.root.children.map((child) => child.rect.height),
			// 预期1+3恰好4。
			[1, 3],
		);
		// 第一项只画a1，第二项仍画b1/b2/b3，证明几何确实影响可见内容。
		assert.deepStrictEqual(visibleLines(frame.lines), ["a1", "b1", "b2", "b3"]);
	});

	// 嵌套dock自然高必须包含子项minSize带来的留白；总高9给body1和dock8，精确比较行顺序，不只检查总高度。
	it("includes nested minimum sizes in intrinsic stack measurement", () => {
		// 先创建内层竖排dock。
		const dock = new VStack([
			// 第一块标题有3条自然文本行。
			new Text("top1\ntop2\ntop3", 0, 0),
			// selector文字只有一行，但minSize3要求为其分配至少3行。
			{ component: new Text("selector", 0, 0), minSize: 3 },
			// 普通below占一行自然高。
			new Text("below", 0, 0),
			// footer最少一行，和自然高相同。
			{ component: new Text("footer", 0, 0), minSize: 1 },
		]);
		// 创建包含body和dock的外层帧。
		const frame = renderLayoutFrame(
			// 外层也为竖排，孩子的自然/最小高由嵌套规则决定。
			new VStack([
				// body从0开始增长且至少1行。
				{ component: new Text("body", 0, 0), basis: 0, grow: 1, minSize: 1 },
				// dock按auto取嵌套自然高，外层min1不是把内部各项最小高忽略掉。
				{ component: dock, basis: "auto", minSize: 1 },
			]),
			// 总宽10列。
			10,
			// 总高9行，刚好容纳body1+dock8。
			9,
			// 忽略重画通知，只检查同步结果。
			() => {},
		);

		// 逐行深比较，下面每一项对应最终视口中的一行。
		assert.deepStrictEqual(visibleLines(frame.lines), [
			// body占第0行。
			"body",
			// dock标题第1行。
			"top1",
			// dock标题第2行。
			"top2",
			// dock标题第3行。
			"top3",
			// selector分配区的实际文字。
			"selector",
			// selector minSize多出的第一条留白。
			"",
			// selector minSize多出的第二条留白。
			"",
			// selector区域之后才是below。
			"below",
			// 最后一行footer。
			"footer",
		]);
	});

	// 中间项visible返回false时应完全移出布局，仅两个可见项间保留一个gap；调用Stack.render检验自然渲染，不通过真实终端。
	it("omits gaps around invisible entries", () => {
		// 构造竖排容器与公共间距选项。
		const stack = new VStack(
			// 中间配置的零参visible忽略视口并总返回false；不会执行隐藏组件的绘制来占间距。
			[new Text("one", 0, 0), { component: new Text("hidden", 0, 0), visible: () => false }, new Text("two", 0, 0)],
			// 可见相邻项之间留1行空隙。
			{ gap: 1 },
		);
		// 深比较自然渲染后的可见文字。
		assert.deepStrictEqual(
			// render(10)后只trim尾空白；此处没有剥ANSI，当前Text也没自定义着色。
			stack
				.render(10)
				.map((line) => line.trimEnd()),
			// 预期只有one、一个gap、two，隐藏项两侧不会各留一份gap。
			["one", "", "two"],
		);
	});

	// 3格高/100像素的Kitty图片在滚动区底部仅剩1格可见，检查生成裁剪字段y0/h34/r1；只检查协议字符串，不验证PNG有效或终端真的显示。
	it("crops Kitty images at a scroll view's lower boundary", () => {
		// 固定图片ID用于元数据查找，不随机分配。
		const imageId = 124;
		// AAAA只是短base64载荷；声明2列3行且C=1禁协议默认移动，只生成字符串不解码图像。
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		// 登记原图100×100像素和2列3行，修改共享表；本例结束没有撤销这条登记。
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		// 滚动正文由两条普通行、一条图片头和两条占位行构成。
		const transcript = new ScrollView({
			// render返回新5行数组，图片的后两格由空串占位，不包含独立图片数据。
			render: () => ["one", "two", imageLine, "", ""],
			// 最小组件没有缓存，invalidate为空。
			invalidate: () => {},
		});
		// 给图片滚动区和dock分配一帧。
		const frame = renderLayoutFrame(
			// 滚动区basis0/grow1拿前三行，dock自然占最后一行。
			new VStack([{ component: transcript, basis: 0, grow: 1 }, new Text("dock", 0, 0)]),
			// 帧宽20列，不是像素宽。
			20,
			// 帧高4行，滚动区只有3行可用。
			4,
			// 空回调不调度真正输出。
			() => {},
		);

		// 第2行图片头应裁为起始像素0、高ceil(100/3)=34、目标1格；?.防缺行，ok(undefined)仍失败，不证明其余协议字段都正确。
		assert.ok(frame.lines[2]?.includes("y=0,h=34,r=1"));
	});

	// 横排两项各固定6列放进12列，检查left补2空格后接right；尾空白经helper去掉，无真实终端绘制。
	it("composes horizontal children at allocated widths", () => {
		// 生成横向布局帧。
		const frame = renderLayoutFrame(
			// HStack的basis单位是列，和前面VStack的行不同。
			new HStack([
				// 左项占6列且不收缩，left只有4列，剩2列留白。
				{ component: new Text("left", 0, 0), basis: 6, shrink: 0 },
				// 右项同样占6列，right占5列。
				{ component: new Text("right", 0, 0), basis: 6, shrink: 0 },
			]),
			// 总宽12列恰好等于两项basis之和。
			12,
			// 总高1行，足以容纳两个短单行组件。
			1,
			// 忽略后续重画通知。
			() => {},
		);
		// helper去掉最右padding，保留中间属于左区域的两空格。
		assert.deepStrictEqual(visibleLines(frame.lines), ["left  right"]);
	});

	// 首项明确零列且不增长，第二项增长到全宽；输出中不能出现hidden，未检查隐藏项render是否被调用。
	it("does not paint zero-width horizontal children", () => {
		// 生成5列1行帧。
		const frame = renderLayoutFrame(
			// 横排容器按列分配两项。
			new HStack([
				// basis0且grow缺省0，hidden没有可绘制宽度。
				{ component: new Text("hidden", 0, 0), basis: 0, shrink: 0 },
				// shown从0按grow1取得全部剩余列。
				{ component: new Text("shown", 0, 0), basis: 0, grow: 1 },
			]),
			// 可用5列，正好放下shown。
			5,
			// 视口只有一行。
			1,
			// 空重画回调。
			() => {},
		);
		// 最终可见文字只有shown，零宽项不污染合成行。
		assert.deepStrictEqual(visibleLines(frame.lines), ["shown"]);
	});

	// 6行内容/3行视口先跟随末尾，再向上/越界/向下滚，断言偏移、跟随状态和未消耗量；方法仅改内存，不自动把余量传给父窗口。
	it("tracks follow-end state and returns unused scroll delta", () => {
		// 建立6条短行的滚动正文。
		const scrollView = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0), {
			// 配置允许跟随末尾，初始布局后落到底部。
			follow: "end",
			// 标为主要视图，供宿主选择滚动目标；不改变此例scrollBy的计算。
			primary: true,
		});
		// 布局将内容高6、视口高3写回ScrollView，最大scrollTop是3。
		renderLayoutFrame(scrollView, 10, 3, () => {});
		// 初始末尾位置为顶部跳过3行。
		assert.strictEqual(scrollView.scrollTop, 3);
		// 初始动态状态确为跟随末尾。
		assert.strictEqual(scrollView.isFollowingEnd, true);

		// 上滚2行全被本窗口消耗，所以返回0。
		assert.strictEqual(scrollView.scrollBy(-2), 0);
		// 偏移从3变为1。
		assert.strictEqual(scrollView.scrollTop, 1);
		// 离开末尾后暂停动态跟随，但配置能力仍保留。
		assert.strictEqual(scrollView.isFollowingEnd, false);
		// 再请求上滚3行，只能消耗1，剩余-2返回给调用者。
		assert.strictEqual(scrollView.scrollBy(-3), -2);
		// 偏移在顶部0夹住。
		assert.strictEqual(scrollView.scrollTop, 0);
		// 下滚10行只能消耗3，剩余正7。
		assert.strictEqual(scrollView.scrollBy(10), 7);
		// 已达最大偏移3。
		assert.strictEqual(scrollView.scrollTop, 3);
		// 重新到末尾会恢复允许的动态跟随。
		assert.strictEqual(scrollView.isFollowingEnd, true);
	});

	// 用8行/4行窗口验证滚动条比例、活跃符号、10ms暂显后隐藏、跟随增长不触发暂显、always预留列及最小滑块高；仅内存与短计时器，断言失败无finally清理所有实例。
	it("renders a proportional glyph scrollbar with an expanded active thumb", async () => {
		// 第一行带宽2的界，后面用于验证覆盖最后一格时不能保留半个宽字。
		const sourceLines = ["abcd界", "abcde2", "abcde3", "abcde4", "abcde5", "abcde6", "abcde7", "abcde8"];
		// SGR42给正文绿色背景。
		const contentBackground = "\x1b[42m";
		// 256色前景2给轨道着色。
		const trackColor = "\x1b[38;5;2m";
		// 256色前景1给滑块着色，便于检测两类符号位置。
		const thumbColor = "\x1b[38;5;1m";
		// 轨道回调输入符号，返回着色后再恢复默认前景的串，无I/O；例│带trackColor，不清背景。
		const scrollbarTrackStyle = (text: string) => `${trackColor}${text}\x1b[39m`;
		// 滑块回调同理，用另一种前景码，实际调用在绘制时。
		const scrollbarThumbStyle = (text: string) => `${thumbColor}${text}\x1b[39m`;
		// join成多行正文，自定义背景回调给每行加42m/49m，不会直接写终端。
		const content = new Text(sourceLines.join("\n"), 0, 0, (text) => `${contentBackground}${text}\x1b[49m`);
		// 创建自动暂显的滚动区。
		const scrollView = new ScrollView(content, {
			// auto覆盖右侧正文列，不像always固定预留一列。
			scrollbar: "auto",
			// 对象属性简写保存轨道函数引用，此行不执行它。
			scrollbarTrackStyle,
			// 同样保存滑块函数引用。
			scrollbarThumbStyle,
			// 非活跃后10ms隐藏，实际计时取决于事件循环，不是严格实时截止。
			scrollbarHideDelayMs: 10,
		});
		// 无参render闭包同步重建6列4行帧并取lines，空重画回调防止定时器自动开启真实绘制。
		const render = () => renderLayoutFrame(scrollView, 6, 4, () => {}).lines;
		// visible回调剥控制码但不trim，故可检查宽字符被覆盖后留下的空白格。
		const visible = (lines: string[]) => lines.map(stripTerminalSequences);

		// 首次渲染还未发生交互，auto滚动条应隐藏。
		let lines = render();
		// 可见行等于源前4行，没有条符号覆盖。
		assert.deepStrictEqual(visible(lines), sourceLines.slice(0, 4));

		// 下滚2行，更新偏移并触发auto暂显倒计时。
		scrollView.scrollBy(2);
		// 手动重新渲染读取最新条状态。
		lines = render();
		// 轨道覆盖右端字符，4行中间2行是非活跃滑块┃。
		assert.deepStrictEqual(visible(lines), ["abcde│", "abcde┃", "abcde┃", "abcde│"]);
		// 逐行检查轨道颜色码是否出现。
		assert.deepStrictEqual(
			// map对每行做includes，保留行序生成布尔数组。
			lines.map((line) => line.includes(trackColor)),
			// 仅首末轨道行有trackColor。
			[true, false, false, true],
		);
		// 独立验证滑块颜色分布。
		assert.deepStrictEqual(
			// 查每行是否含thumbColor，不解析真实终端最终颜色。
			lines.map((line) => line.includes(thumbColor)),
			// 只有中间两行含滑块色码。
			[false, true, true, false],
		);

		// 进入活跃态会清旧倒计时，保持条可见。
		scrollView.setScrollbarActive(true);
		// 按活跃态重画。
		lines = render();
		// 滑块由┃变成█，位置仍在中间两行。
		assert.deepStrictEqual(visible(lines), ["abcde│", "abcde█", "abcde█", "abcde│"]);
		// 活跃态也应保持滑块着色区域。
		assert.deepStrictEqual(
			// 按行检查thumbColor。
			lines.map((line) => line.includes(thumbColor)),
			// 颜色仍只在中间两行。
			[false, true, true, false],
		);
		// !只是静态非空断言；比较最后一个背景码与滑块码的出现顺序，不能等同完整ANSI状态验证。
		assert.ok(lines[1]!.lastIndexOf(contentBackground) < lines[1]!.lastIndexOf(thumbColor));

		// 离开活跃态，重新安排10ms隐藏任务。
		scrollView.setScrollbarActive(false);
		// Promise执行器现在注册30ms定时器，await稍后继续；给隐藏任务执行机会，不要求精确30ms。
		await new Promise((resolve) => setTimeout(resolve, 30));
		// 隐藏后手动生成新帧。
		lines = render();
		// 完整6列正文恢复，截取源下标2..5，末列不再覆盖。
		assert.deepStrictEqual(visible(lines), sourceLines.slice(2, 6));

		// 滚到末尾会再次暂显滚动条。
		scrollView.scrollToEnd();
		// 读取新位置下的条几何。
		lines = render();
		// 末尾滑块在轨道最后两行。
		assert.deepStrictEqual(visible(lines), ["abcde│", "abcde│", "abcde┃", "abcde┃"]);

		// 滚回开头。
		scrollView.scrollToStart();
		// 生成顶部位置帧。
		lines = render();
		// 界原占第4/5两格，覆盖第5格时先移除整个字素并用一空格补第4格，得到abcd+空格+┃。
		assert.strictEqual(visible(lines)[0], "abcd ┃");

		// 另建可更新Text，避免复用前一个ScrollView的活动状态。
		const followedContent = new Text(sourceLines.join("\n"), 0, 0);
		// 创建跟随末尾的auto滚动区。
		const followed = new ScrollView(followedContent, {
			// 允许新内容追加时保持末尾。
			follow: "end",
			// auto起初仍隐藏，不因配置follow就显示。
			scrollbar: "auto",
			// 复用轨道样式函数引用。
			scrollbarTrackStyle,
			// 复用滑块样式函数引用。
			scrollbarThumbStyle,
		});
		// 8行/4行布局，初始定位末尾。
		renderLayoutFrame(followed, 6, 4, () => {});
		// 初始最大偏移8-4=4。
		assert.strictEqual(followed.scrollTop, 4);
		// Text.setText追加第9行并使自身缓存失效，但不模拟鼠标/显式滚动交互。
		followedContent.setText(`${sourceLines.join("\n")}\nabcde9`);
		// 重新布局让跟随状态吸收新增高度。
		const growthFrame = renderLayoutFrame(followed, 6, 4, () => {});
		// 偏移更新为9-4=5。
		assert.strictEqual(followed.scrollTop, 5);
		// 所有行都不含轨道/细滑块字符，证明跟随增长没有触发auto暂显；这不检查█，本例也未置active。
		assert.ok(growthFrame.lines.every((line) => !/[│┃]/.test(stripTerminalSequences(line))));

		// 只有2行的内容能完全放入4行视口。
		const fittingContent = new Text("1\n2", 0, 0);
		// 另建auto窗口，共享滑块函数但不共享滚动状态。
		const automatic = new ScrollView(fittingContent, { scrollbar: "auto", scrollbarThumbStyle });
		// 布局记录无溢出的尺寸。
		renderLayoutFrame(automatic, 6, 4, () => {});
		// 尝试下滚1行，实际无法移动且不应暂显。
		automatic.scrollBy(1);
		// 对新帧所有行检查没有条符号。
		assert.ok(
			// 先布局再剥ANSI，every返回所有行都不含│/┃才通过。
			renderLayoutFrame(automatic, 6, 4, () => {}).lines.every((line) => !/[│┃]/.test(stripTerminalSequences(line))),
		);

		// always即使内容不溢出也应显示条，并为其预留一列。
		const alwaysFitting = new ScrollView(fittingContent, { scrollbar: "always", scrollbarThumbStyle });
		// 布局2行内容到6列4行。
		const alwaysFittingFrame = renderLayoutFrame(alwaysFitting, 6, 4, () => {});
		// 第一个孩子是滚动正文盒子，宽从6扣成5；?.允许缺失值，strictEqual仍会判失败。
		assert.strictEqual(alwaysFittingFrame.root.children[0]?.rect.width, 5);
		// 全部4条输出行都以┃结束，内容未溢出时滑块覆盖整条轨道。
		assert.ok(visible(alwaysFittingFrame.lines).every((line) => line.endsWith("┃")));

		// 创建有溢出的always窗口，复用8行正文。
		const alwaysOverflowing = new ScrollView(content, {
			// always预留专属右列，不覆盖正文的最后一格。
			scrollbar: "always",
			// 使用轨道色回调。
			scrollbarTrackStyle,
			// 使用滑块色回调。
			scrollbarThumbStyle,
		});
		// 正文装入4行视口；预留列让原本6列宽的各行在5列内继续折行，实际内容高度不再是8行。
		const alwaysOverflowingFrame = renderLayoutFrame(alwaysOverflowing, 6, 4, () => {});
		// 正文盒子只得5列。
		assert.strictEqual(alwaysOverflowingFrame.root.children[0]?.rect.width, 5);
		// 按实际折行高度与4行视口计算，滑块在本例占2行。
		assert.strictEqual(visible(alwaysOverflowingFrame.lines).filter((line) => line.endsWith("┃")).length, 2);
		// 其余2行是轨道。
		assert.strictEqual(visible(alwaysOverflowingFrame.lines).filter((line) => line.endsWith("│")).length, 2);
		// 逐行检查预留列前的样式清理顺序。
		for (const line of alwaysOverflowingFrame.lines) {
			// 找到轨道/滑块色码最后出现位置中的较后者，作为本行条样式位置。
			const scrollbarStyleIndex = Math.max(line.lastIndexOf(trackColor), line.lastIndexOf(thumbColor));
			// 从条样式位置往前找“全面SGR重置+关闭OSC8”，不查后面的码。
			const reservedColumnResetIndex = line.lastIndexOf("\x1b[0m\x1b]8;;\x07", scrollbarStyleIndex);
			// 该重置必须晚于正文背景开启，说明专属列不会继续继承正文背景；比较索引不等同执行ANSI。
			assert.ok(reservedColumnResetIndex > line.lastIndexOf(contentBackground));
		}

		// 辅助闭包输入内容高，创建20行auto视口→布局→下滚显条→数┃行；例40行得10行滑块，返回number，未创建真实终端，工具错误向用例传播。
		const thumbHeightFor = (contentHeight: number) => {
			// 按contentHeight生成实际x行并join；这里输入最多400，不使用前面十亿稀疏技巧。
			const sized = new ScrollView(new Text(Array.from({ length: contentHeight }, () => "x").join("\n"), 0, 0), {
				// auto条要在下面滚动后才可见。
				scrollbar: "auto",
				// 对象简写复用滑块色函数。
				scrollbarThumbStyle,
			});
			// 先记录6列20行的布局边界。
			renderLayoutFrame(sized, 6, 20, () => {});
			// 下滚1行触发auto暂显，相关隐藏timer会unref而非本测试显式dispose。
			sized.scrollBy(1);
			// 再次生成帧，filter只保留文字末尾是细滑块的行。
			return renderLayoutFrame(sized, 6, 20, () => {}).lines.filter(
				(line) =>
					// 剥色后用endsWith识别┃，不是把轨道也算滑块。
					stripTerminalSequences(line).endsWith("┃"),
				// 取过滤数组长度作为滑块高度。
			).length;
		};
		// 20²/21四舍五入约19，预期19行。
		assert.strictEqual(thumbHeightFor(21), 19);
		// 20²/40=10，预期10行。
		assert.strictEqual(thumbHeightFor(40), 10);
		// 20²/100=4，预期4行。
		assert.strictEqual(thumbHeightFor(100), 4);
		// 20²/400=1但最小滑块高2，预期2行。
		assert.strictEqual(thumbHeightFor(400), 2);
	});

	// 正文右端已有红前景边框，auto条覆盖时只继承绿色背景，必须清掉原红前景；深比较字形并检查控制码，不验证真实终端显示。
	it("preserves only the underlying background beneath overlay scrollbar glyphs", () => {
		// 绿色背景码。
		const background = "\x1b[42m";
		// 红色前景码，仅用于原正文的最后一列边框。
		const borderForeground = "\x1b[31m";
		// 定义最小正文Component，其render按给定宽度造8行。
		const content = {
			// width是终端列数，本例全ASCII；回调返回数组并无外部状态写入。
			render: (width: number) =>
				// Array.from依据length建立连续8项，不是稀疏数组。
				Array.from(
					// 生成8条相同样式行。
					{ length: 8 },
					// 每行先绿背景、width-1个x、红边框，最后关前景/背景；每次回调生成相同宽度的一条字符串。
					() => `${background}${"x".repeat(width - 1)}${borderForeground}│\x1b[39m\x1b[49m`,
				),
			// 无缓存的invalidate空操作。
			invalidate: () => {},
		};
		// 创建auto窗口准备让右列覆盖原红色边框。
		const scrollView = new ScrollView(content, {
			// auto叠加不预留列。
			scrollbar: "auto",
			// 轨道样式恒等返回文字，不主动加前景码，暴露原边框色是否漏出。
			scrollbarTrackStyle: (text) => text,
			// 滑块也用恒等回调，便于检查只保留背景的默认合成。
			scrollbarThumbStyle: (text) => text,
		});
		// 先布局建立滚动边界。
		renderLayoutFrame(scrollView, 6, 4, () => {});
		// 滚动1行触发条暂显。
		scrollView.scrollBy(1);
		// 新帧包含轨道/滑块覆盖结果。
		const frame = renderLayoutFrame(scrollView, 6, 4, () => {});

		// 剥ANSI后五个x后接4行轨道/滑块，原红边框字形被对应符号替换。
		assert.deepStrictEqual(frame.lines.map(stripTerminalSequences), ["xxxxx│", "xxxxx┃", "xxxxx┃", "xxxxx│"]);
		// 检查每行底层样式处理。
		for (const line of frame.lines) {
			// 绿色背景码应仍存在。
			assert.ok(line.includes(background));
			// 红前景码完全不应留在合成行里。
			assert.ok(!line.includes(borderForeground));
			// 检查重置SGR并关闭链接之后重新恢复绿背景的相邻控制串，避免连背景也丢掉。
			assert.ok(line.includes(`\x1b[0m\x1b]8;;\x07${background}`));
		}
	});

	// 运行中从always切hidden应让正文收回预留列；检查切换前后的嵌套盒宽及可见状态，方法不写终端。
	it("updates reserved scrollbar layout at runtime", () => {
		// 6字符Text在always的5列正文中会折成两行。
		const scrollView = new ScrollView(new Text("123456", 0, 0), { scrollbar: "always" });
		// 每次render重建横排根与布局帧，align:start以孩子自然高度起顶，不跨帧缓存盒子树。
		const render = () => renderLayoutFrame(new HStack([scrollView], { align: "start" }), 6, 2, () => {});
		// 读取切换前的布局快照。
		const always = render();
		// 5个字符+条为首行，余下6+4空格+条为第二行，helper只删整行最右空白。
		assert.deepStrictEqual(visibleLines(always.lines), ["12345┃", "6    ┃"]);
		// 根的孩子ScrollView占6列总宽。
		assert.strictEqual(always.root.children[0]?.rect.width, 6);
		// 它的正文孩子只有5列。
		assert.strictEqual(always.root.children[0]?.children[0]?.rect.width, 5);

		// 切hidden会取消暂显任务并请求重画；本例重画回调为空，下面主动再布局。
		scrollView.setScrollbar("hidden");
		// 新布局正文宽回到6列，已经不需给条留空间。
		assert.strictEqual(render().root.children[0]?.children[0]?.rect.width, 6);
		// 可见性访问器也报告false，和布局几何一起检查。
		assert.strictEqual(scrollView.isScrollbarVisible, false);
	});

	// 嵌套滚动区内层限定2行，外层内容高度应按内层窗口2+tail1计算，而非用内层全文6；检查外层最多滚1行。
	it("measures nested scroll content from constrained child geometry", () => {
		// 内层有6行正文，自身可滚动。
		const inner = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0));
		// 竖排给内层窗口固定2行，再接1行tail，形成外层3行内容。
		const outer = new ScrollView(new VStack([{ component: inner, basis: 2 }, new Text("tail", 0, 0)]));
		// 外层视口2行，建立两层布局/边界。
		renderLayoutFrame(outer, 10, 2, () => {});

		// 确认内层窗口实际得到2行。
		assert.strictEqual(inner.viewportHeight, 2);
		// 外层请求下滚10只用掉1，所以返回9。
		assert.strictEqual(outer.scrollBy(10), 9);
		// 外层偏移最终夹到1，不会把内层全部6行当成外层可滚高。
		assert.strictEqual(outer.scrollTop, 1);
	});

	// 同一Text内容由1行改3行后重新布局，旧帧仍保留旧行数组，新帧重新建立几何；只检查行数，不要求组件引用改变。
	it("rebuilds geometry after content changes", () => {
		// 创建一行文本组件。
		const text = new Text("one", 0, 0);
		// 放入单项竖排根，之后复用同一个根。
		const root = new VStack([text]);
		// 保存第一次帧对象，而非仅保存当前全局状态。
		const first = renderLayoutFrame(root, 10, 4, () => {});
		// 改正文并清Text渲染缓存，旧帧引用的旧数组不会因此被原地改写。
		text.setText("one\ntwo\nthree");
		// 再次布局得到新帧与新行数组。
		const second = renderLayoutFrame(root, 10, 4, () => {});

		// 旧帧孩子的原lines长度仍是1；?.缺字段会得到undefined并使比较失败。
		assert.strictEqual(first.root.children[0]?.lines?.length, 1);
		// 新帧孩子lines长度应为3。
		assert.strictEqual(second.root.children[0]?.lines?.length, 3);
	});
});
