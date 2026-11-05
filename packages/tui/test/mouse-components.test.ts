// 验证输入框/列表的局部鼠标处理与备用屏的鼠标派发、键盘代理焦点和拖选复制；直接构造事件或喂内存终端，不产生真实鼠标/剪贴板操作。
// 导入Node断言，比较失败会抛出并使对应测试失败。
import assert from "node:assert";
// 注册测试组和用例；async用例返回Promise，测试运行器会等待。
import { describe, it } from "node:test";
// Editor是运行时多行输入组件，type EditorTheme只在编译期核对主题函数。
import { Editor, type EditorTheme } from "../src/components/editor.ts";
// Input是单行输入组件，默认提示前缀占两列。
import { Input } from "../src/components/input.ts";
// 选择列表和主题接口，类型导入不创建运行时验证器。
import { SelectList, type SelectListTheme } from "../src/components/select-list.ts";
// 设置列表会循环枚举值或创建子菜单，主题接口仅是静态契约。
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
// Container纵向组合孩子并转发鼠标；两项type导入声明规范化鼠标结构，不是原始SGR字节。
import { Container, type TuiMouseEvent, type TuiMouseEventType } from "../src/tui.ts";
// 备用屏宿主负责把SGR控制串解析为事件、命中几何并应用焦点/选择。
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
// VirtualTerminal用内存xterm解析输出，并把sendInput原样送给已保存的测试输入回调。
import { VirtualTerminal } from "./virtual-terminal.ts";

// 事件工厂输入种类、局部x/y和可选宽高，返回左键/无修饰事件，无I/O；例press(4,0)由Input扣前缀后定位正文列2。坐标默认也当绝对坐标，嵌套转换另由宿主负责。
function mouse(type: TuiMouseEventType, x: number, y: number, width = 80, height = 10): TuiMouseEvent {
	// 返回新对象，不修改组件状态。
	return {
		// 属性简写采用参数type，字面量联合约束可传种类但不运行校验。
		type,
		// 基础事件固定为左键，个别悬停用例通过对象展开覆盖为none。
		button: "left",
		// 本地列，0基终端格坐标，不是字符串UTF-16下标。
		x,
		// 本地行，同样从0开始。
		y,
		// 这里先令绝对列等于局部列，适合直接调用组件的用例。
		screenX: x,
		// 绝对行同理，真实嵌套派发会保留screenY再重算局部y。
		screenY: y,
		// 传给组件的可用宽度，默认80列。
		width,
		// 组件高度默认10行，不会因此创建终端窗口。
		height,
		// 无Shift修饰。
		shift: false,
		// 无Alt修饰。
		alt: false,
		// 无Ctrl修饰。
		ctrl: false,
		// 条件展开仅在click时加clickCount1；其他种类没有该属性，不是设置成undefined。
		...(type === "click" ? { clickCount: 1 } : {}),
	};
}

// 选择列表主题的所有回调输入文字并原样返回，无着色/副作用；让断言直接比较文本，接口标注不冻结对象。
const selectTheme: SelectListTheme = {
	// 前缀恒等函数；当前SelectList实际将前缀合并到selectedText，仍提供接口要求字段。
	selectedPrefix: (text) => text,
	// 选中正文不加样式。
	selectedText: (text) => text,
	// 说明不加样式。
	description: (text) => text,
	// 页码信息不加样式。
	scrollInfo: (text) => text,
	// 无匹配提示原样显示。
	noMatch: (text) => text,
};

// 设置列表主题：各样式回调恒等，cursor直接是文字，不在此渲染；例选中项可用>前缀被正则识别。
const settingsTheme: SettingsListTheme = {
	// 标签样式不更改文字。
	label: (text) => text,
	// 当前值样式不更改文字。
	value: (text) => text,
	// 说明样式不更改文字。
	description: (text) => text,
	// 选中项前缀是>加空格，宽2列。
	cursor: "> ",
	// 提示行原样返回。
	hint: (text) => text,
};

// 编辑器主题复用上方菜单主题，回调均只返回字符串，不读系统配色。
const editorTheme: EditorTheme = {
	// 边框函数不加颜色。
	borderColor: (text) => text,
	// 保存原selectTheme对象引用，非深复制。
	selectList: selectTheme,
};

// 可代理键盘的浮层容器：包含一个Input，鼠标继承Container命中子项，键盘显式转发；用于证明焦点应留在宿主。
class InputOverlay extends Container {
	// 每实例创建一个Input；readonly只禁止重绑字段，输入内容仍可修改。
	readonly input = new Input();

	// 无参构造先初始化父类再挂Input，无I/O、无显式返回；例new InputOverlay()本身还未显示浮层。
	constructor() {
		// 派生类访问this前必须先super。
		super();
		// 把本实例Input挂为子组件，继承的render/鼠标转发才能看到它。
		this.addChild(this.input);
	}

	// 接收原始键串并同步转发给唯一Input，无返回值；例!插入输入框，组件错误直接传播，不自行排帧。
	handleInput(data: string): void {
		// 只转发一次，不把字符同时交其他组件。
		this.input.handleInput(data);
	}
}

/** A settings submenu that routes keys to its nested list, like the coding agent's theme submenu. */
// 设置子菜单宿主也能代理键盘：鼠标实际目标是内部列表，键盘焦点需保留宿主/外层设置列表，关闭菜单后不能留在脱离树的子列表。
class SubmenuHost extends Container {
	// 字段初始化创建本实例专属SelectList，readonly不冻结其选择状态。
	readonly list = new SelectList(
		// 候选数组，两项value用于提交、label用于显示。
		[
			// 第一项作为初始主题值对应候选。
			{ value: "first", label: "First" },
			// 第二项是鼠标点击预期选中的主题值。
			{ value: "second", label: "Second" },
		],
		// 最多显示5个候选，本数组只有2项。
		5,
		// 使用无ANSI样式主题，构造时保存函数而非马上绘制。
		selectTheme,
	);

	// 输入完成回调done，可传字符串提交或无参取消；先父构造→接选择/取消回调→挂列表，无I/O，后续回调异常同步传播。
	constructor(done: (value?: string) => void) {
		// 初始化Container；本类字段随后可用。
		super();
		// 选中时把item.value传给done，done由SettingsList提供，会写设置并关闭子菜单；此行只注册回调。
		this.list.onSelect = (item) => done(item.value);
		// 取消时无参done，只关闭而不提交值。
		this.list.onCancel = () => done();
		// 加入子列表以参加继承的render和鼠标派发。
		this.addChild(this.list);
	}

	// 键盘代理方法输入data，直接同步交子列表，无返回；例回车触发所选项，异常不捕获。
	handleInput(data: string): void {
		// 让子菜单处理上下/确认/取消，而不是重新改外层设置选择。
		this.list.handleInput(data);
	}
}

// 组织组件鼠标测试，既有直接方法单元断言，也有备用屏+虚拟终端链路；后者不证明真实终端发送字节时序。
describe("mouse-aware components", () => {
	// 单行输入先渲染记录窗口，再左键press定位并插X，要求heXllo；只验证此坐标/默认前缀，不覆盖所有宽字符。
	it("positions a single-line input cursor on press", () => {
		// 新建单行Input，未连接宿主。
		const input = new Input();
		// 设置hello，新实例光标仍在开头；后面的press会重新定位。
		input.setValue("hello");
		// 以20列渲染，让Input记录可见文字窗口偏移；返回行数组这里丢弃。
		input.render(20);

		// x4减默认前缀2等于正文列2；?.缺处理结果会是undefined，strictEqual仍失败。
		assert.strictEqual(input.handleMouse(mouse("press", 4, 0, 20, 1))?.handled, true);
		// 从移动后的光标插入X，是直接调用handleInput而非系统按键。
		input.handleInput("X");
		// 检查X插在he后，既验证点击已处理，也验证实际光标位置。
		assert.strictEqual(input.getValue(), "heXllo");
	});

	// 5项列表可见3项，按下第三行选择c、click激活同一项；本例直接传规范化click，不由宿主合成。
	it("selects and activates list rows", () => {
		// 构造真实选择列表。
		const list = new SelectList(
			// 候选对象数组，未绑定任何外部业务。
			[
				// 第0项a/A分别为写回值与标签。
				{ value: "a", label: "A" },
				// 第1项b。
				{ value: "b", label: "B" },
				// 第2项c，是本例点击目标。
				{ value: "c", label: "C" },
				// 第3项d超出初始三行候选区。
				{ value: "d", label: "D" },
				// 第4项e同样暂不可见。
				{ value: "e", label: "E" },
			],
			// 候选可见上限为3，不包含额外页码提示行。
			3,
			// 恒等样式方便后续文本断言。
			selectTheme,
		);
		// string|undefined表示尚未激活时没有结果，let允许回调写入。
		let selected: string | undefined;
		// 激活回调接候选对象并记录value，不调用模型或打开文件。
		list.onSelect = (item) => {
			// 写本地selected，回调无显式return，结果为undefined。
			selected = item.value;
		};

		// 局部y2对应初始范围第2项c，按下只选择并返回处理/焦点意图。
		assert.strictEqual(list.handleMouse(mouse("press", 1, 2, 40, 3))?.handled, true);
		// 检查当前选择确已到c，尚未单独断言回调没触发。
		assert.strictEqual(list.getSelectedItem()?.value, "c");
		// click优先使用按下时记住的项，避免按下导致范围居中后错选。
		assert.strictEqual(list.handleMouse(mouse("click", 1, 2, 40, 3))?.handled, true);
		// 检查onSelect最终回调值是c。
		assert.strictEqual(selected, "c");
	});

	// 设置列表第2行点击third后，值从low循环到high，onChange记录应只有这一项；不写用户真实配置。
	it("activates settings rows", () => {
		// Array<{...}>与对象数组类型等价，编译期约束每条变更的id/value字符串。
		const changes: Array<{ id: string; value: string }> = [];
		// 创建4项设置、可见上限3及两个业务回调。
		const list = new SettingsList(
			// 设置数组对象同时保存当前值和可循环值列表。
			[
				// 第0项mode，当前one。
				{ id: "mode", label: "Mode", currentValue: "one", values: ["one", "two"] },
				// 第1项other，当前off。
				{ id: "other", label: "Other", currentValue: "off", values: ["off", "on"] },
				// 第2项third是点击目标，下一值high。
				{ id: "third", label: "Third", currentValue: "low", values: ["low", "high"] },
				// 第3项fourth在初始候选区之外。
				{ id: "fourth", label: "Fourth", currentValue: "x", values: ["x", "y"] },
			],
			// 最多显示3项，不等于完整组件总高度3。
			3,
			// 传无色设置主题。
			settingsTheme,
			// onChange同步push变更记录；push返回数组长度，但void回调契约不要求运行时返回undefined。
			(id, value) => changes.push({ id, value }),
			// 空退出回调忽略取消，本例不触发它。
			() => {},
		);

		// 未开启搜索时候选从y0开始，按下y2记录third。
		list.handleMouse(mouse("press", 1, 2, 40, 5));
		// click激活按下时的项并循环值。
		list.handleMouse(mouse("click", 1, 2, 40, 5));
		// 比较完整变更数组，要求正好一次third→high。
		assert.deepStrictEqual(changes, [{ id: "third", value: "high" }]);
	});

	// 参数化注册两套边缘行用例：row0与row4，覆盖滚动后可见候选区顶部/底部；不是同时并发点击。
	for (const row of [0, 4]) {
		// 每个row建12项/5行列表，滚轮移到item6→所有hover不动→按下/重绘/click仍激活原来可见项；只检查这两处边界。
		it(`ignores hover and clicks visible select-list row ${row} after scrolling`, () => {
			// 为每个参数行重新创建列表，不共享选择或按下状态。
			const list = new SelectList(
				// Array.from用索引i生成12个实际候选对象；_表示未使用的值参数，模板仅构建名字。
				Array.from({ length: 12 }, (_, i) => ({ value: `item-${i}`, label: `Item ${i}` })),
				// 候选可见5行，中心附近的滚动会改变范围起点。
				5,
				// 使用恒等选择样式。
				selectTheme,
			);
			// 记录选择变化，和最终激活结果分开验证。
			const changes: string[] = [];
			// selected初值undefined，只有onSelect才写入。
			let selected: string | undefined;
			// 选择变化时记录value，返回的push长度由调用方忽略。
			list.onSelectionChange = (item) => changes.push(item.value);
			// 激活时记录所选value，不立即改变外部系统。
			list.onSelect = (item) => {
				// 保存最后一次激活结果。
				selected = item.value;
			};
			// 直接把当前选择设为下标5；此方法本身不触发onSelectionChange。
			list.setSelectedIndex(5);
			// 对象展开复制工厂事件，再补wheelDelta1，下滚一项；只按方向移动，不依靠鼠标y选中。
			list.handleMouse({ ...mouse("wheel", 1, row), wheelDelta: 1 });
			// 选择从item5到item6。
			assert.strictEqual(list.getSelectedItem()?.value, "item-6");
			// 只记录这一次滚轮选择变化。
			assert.deepStrictEqual(changes, ["item-6"]);
			// 保存滚后完整渲染结果作后续hover不变的基线。
			const before = list.render(80);
			// 动态正则末尾$要求对应可见行以Item4或Item8结束，名字数字由4+row得到；无m标志。
			assert.match(before[row], new RegExp(`Item ${4 + row}$`));

			// 依次把指针移过所有可见行，再重复本轮边缘row，检查悬停不会改变居中范围。
			for (const y of [0, 1, 2, 3, 4, row]) {
				// 后写button:none覆盖工厂left，move应返回undefined不处理。
				assert.strictEqual(list.handleMouse({ ...mouse("move", 1, y), button: "none" }), undefined);
				// 每轮重新render深比较，要求包括页码/前缀在内的所有行保持基线。
				assert.deepStrictEqual(list.render(80), before);
			}
			// 所有悬停后当前选择仍item6。
			assert.strictEqual(list.getSelectedItem()?.value, "item-6");
			// 变化回调也没多出记录。
			assert.deepStrictEqual(changes, ["item-6"]);
			// 悬停不能触发激活回调。
			assert.strictEqual(selected, undefined);

			// 按下原可见边缘行，组件记录当时item4或item8并改变选择。
			list.handleMouse(mouse("press", 1, row));
			// 主动render模拟居中后的可见范围变化，防止click重新按新范围选错。
			list.render(80);
			// 同一局部坐标click应沿用按下记录，而不是当前居中范围的另一项。
			list.handleMouse(mouse("click", 1, row));
			// 激活结果应对应原来的4+row。
			assert.strictEqual(selected, `item-${4 + row}`);
			// 完整变化序列为滚轮item6，再按下原可见项；click不重复触发同项选择变化。
			assert.deepStrictEqual(changes, ["item-6", `item-${4 + row}`]);
		});

		// 设置列表同样验证滚动后hover不动和按下/click稳定目标，但开启搜索会多占顶部两行；激活最终将目标off变on。
		it(`ignores hover and clicks visible settings row ${row} after scrolling`, () => {
			// 每个参数行创建独立变更数组，只记录值改变而非光标选择变化。
			const changes: Array<{ id: string; value: string }> = [];
			// 新建支持搜索的设置列表。
			const list = new SettingsList(
				// Array.from逐个生成设置对象，回调表达式用({...})返回对象而不是函数体。
				Array.from({ length: 12 }, (_, i) => ({
					// 设置ID按索引命名，变更记录使用它。
					id: `item-${i}`,
					// 标签供菜单显示。
					label: `Item ${i}`,
					// 每项说明供下方说明区显示，不算候选区域行。
					description: `Description ${i}`,
					// 初始值统一off。
					currentValue: "off",
					// 可循环值顺序off→on→off。
					values: ["off", "on"],
				})),
				// 候选可见数5，完整组件还包含搜索、空行、说明和提示。
				5,
				// 恒等设置主题让选中前缀可直接匹配。
				settingsTheme,
				// 值改变时同步记录id/value，纯内存副作用。
				(id, value) => changes.push({ id, value }),
				// 空退出回调，本例不测试取消。
				() => {},
				// 启用搜索：本地y0搜索框、y1空行，候选从y2开始。
				{ enableSearch: true },
			);
			// 按id把选择定位到item5，不循环值。
			list.selectItem("item-5");
			// 滚轮下移一项，坐标额外加2跳过搜索区；滚轮事件只改选择不触发onChange。
			list.handleMouse({ ...mouse("wheel", 1, row + 2), wheelDelta: 1 });
			// 保存滚后渲染结果。
			const before = list.render(80);
			// item6居中到候选区第2行，即完整组件第4行；^要求选中前缀在字符串开头。
			assert.match(before[4], /^> Item 6/);
			// 顶部/底部边缘候选对应item4或item8，标签后空格区分例如Item4与Item40。
			assert.match(before[row + 2], new RegExp(`Item ${4 + row} `));

			// 依次移动过候选区各行并重复边缘，仍不应改变选择。
			for (const y of [0, 1, 2, 3, 4, row]) {
				// move/button:none应未处理，y+2使用完整组件局部坐标。
				assert.strictEqual(list.handleMouse({ ...mouse("move", 1, y + 2), button: "none" }), undefined);
				// 整个渲染数组保持基线，不仅比较当前值。
				assert.deepStrictEqual(list.render(80), before);
			}
			// hover和滚轮都不改变设置值，所以仍没有onChange记录。
			assert.deepStrictEqual(changes, []);

			// 按下目标候选，记录原下标。
			list.handleMouse(mouse("press", 1, row + 2));
			// 模拟按下选中后重绘，居中范围可以改变。
			list.render(80);
			// click仍激活按下记录，不按新范围重新选。
			list.handleMouse(mouse("click", 1, row + 2));
			// 目标设置准确从off改成on，且只有这一条变更。
			assert.deepStrictEqual(changes, [{ id: `item-${4 + row}`, value: "on" }]);
		});
	}

	// 全链路浮层点击：虚拟SGR按下/释放命中内部Input，再输入!，要求文字变化且键盘焦点保留代理浮层；等常见渲染帧后断言，正常末尾stop，无finally兜底。
	it("keeps a delegating overlay focused when its nested input is clicked", async () => {
		// 创建20列4行内存终端。
		const terminal = new VirtualTerminal(20, 4);
		// 备用屏宿主输出模式码只写到该内存终端。
		const tui = new TuiAltScreen(terminal);
		// 创建代理浮层及其Input。
		const overlay = new InputOverlay();
		// 预填hi，点击位置会落在正文末尾。
		overlay.input.setValue("hi");
		// 启动虚拟输入与备用屏绘制。
		tui.start();
		// 显示左上角宽20列浮层，宿主按其内容计算高度/命中几何。
		tui.showOverlay(overlay, { anchor: "top-left", width: 20 });
		// 等待nextTick、约20ms和xterm写队列，确保最近浮层布局可用于鼠标命中；不是任意任务完全稳定保证。
		await terminal.waitForRender();

		// SGR左键按下在终端1基第5列/第1行；解析后是0基x4/y0。
		terminal.sendInput("\x1b[<0;5;1M");
		// 小写m表示同点释放，宿主可合成click；Input实际在press阶段定位。
		terminal.sendInput("\x1b[<0;5;1m");
		// 普通字符走键盘焦点，浮层handleInput再委托内部Input。
		terminal.sendInput("!");
		// 等待由输入安排的渲染，供异步管线完成本例状态更新。
		await terminal.waitForRender();

		// 文字追加!成功，证明键盘代理链可达输入框。
		assert.strictEqual(overlay.input.getValue(), "hi!");
		// 焦点对象必须是overlay宿主，不能仅因点击子Input就换成子对象。
		assert.strictEqual(tui.getFocusedComponent(), overlay);
		// 正常路径stop清宿主模式/提示与虚拟回调，不销毁整个xterm缓冲。
		tui.stop();
	});

	// 设置子菜单点第二行关闭后，焦点仍外层列表，再用向下+回车改变other，证明后续键没有滞留在脱离的子菜单；正常stop清理，失败无finally。
	it("keeps a settings list focused when a click in its submenu closes the submenu", async () => {
		// 创建30列6行内存终端。
		const terminal = new VirtualTerminal(30, 6);
		// 创建备用屏宿主，不接真实TTY。
		const tui = new TuiAltScreen(terminal);
		// 收集两次预期值改变。
		const changes: Array<{ id: string; value: string }> = [];
		// 主设置列表含一个子菜单项和一个普通循环值项。
		const list = new SettingsList(
			// 配置数组在此创建，不读用户设置文件。
			[
				// theme工厂忽略当前值_value，返回代理SubmenuHost并保存done；这里只注册工厂，按确认后才执行。
				{ id: "theme", label: "Theme", currentValue: "first", submenu: (_value, done) => new SubmenuHost(done) },
				// other用于关闭子菜单后验证键盘重新到达主列表。
				{ id: "other", label: "Other", currentValue: "off", values: ["off", "on"] },
			],
			// 候选可见上限5，实际主列表只有2项。
			5,
			// 使用恒等设置主题。
			settingsTheme,
			// onChange只push记录，不写实际主题设置。
			(id, value) => changes.push({ id, value }),
			// 取消回调为空，本例不触发。
			() => {},
		);
		// 把设置列表挂入备用屏根内容。
		tui.addChild(list);
		// 显式赋键盘焦点给主列表。
		tui.setFocus(list);
		// 启动虚拟终端链路。
		tui.start();
		// 等首帧布局，以便后续输入看到有效屏幕几何。
		await terminal.waitForRender();

		// 回车激活默认第0项theme，创建子菜单。
		terminal.sendInput("\r");
		// 等子菜单显示并记录子容器鼠标布局。
		await terminal.waitForRender();
		// Press and release on the submenu's second row selects it and closes the submenu.
		// 在1基第3列/第2行按下，命中子菜单第二项。
		terminal.sendInput("\x1b[<0;3;2M");
		// 同点释放合成click，子列表onSelect→done(second)→写theme并关闭菜单。
		terminal.sendInput("\x1b[<0;3;2m");
		// 等待菜单关闭后的重绘。
		await terminal.waitForRender();
		// 检查第一次变更准确是theme→second。
		assert.deepStrictEqual(changes, [{ id: "theme", value: "second" }]);
		// 焦点必须留在仍挂载的外层SettingsList，不能留到已关闭的内部列表。
		assert.strictEqual(tui.getFocusedComponent(), list);

		// Keys reach the visible list again instead of the closed submenu.
		// 向下箭头应由主列表处理，选择other。
		terminal.sendInput("\x1b[B");
		// 回车循环other值off→on。
		terminal.sendInput("\r");
		// 等最终重画，回调本身在handleInput中同步发生。
		await terminal.waitForRender();
		// 比较完整两条值变更，确认此前主题变更未丢也无额外重复通知。
		assert.deepStrictEqual(changes, [
			// 第一条来自子菜单确认。
			{ id: "theme", value: "second" },
			// 第二条来自关闭后主列表的键盘确认。
			{ id: "other", value: "on" },
		]);
		// 正常收尾stop，解除虚拟终端处理并取消宿主提示/渲染任务。
		tui.stop();
	});

	// 备用屏对Editor正文同点释放合成click，定位后输入X应得heXllo并聚焦Editor；覆盖真实派发链但只使用内存终端，正常stop。
	it("positions and focuses the multiline editor through alternate-screen dispatch", async () => {
		// 20列6行虚拟页面。
		const terminal = new VirtualTerminal(20, 6);
		// 创建备用屏宿主。
		const tui = new TuiAltScreen(terminal);
		// 给Editor传该宿主和无色主题，构造不调用模型或外部编辑器。
		const editor = new Editor(tui, editorTheme);
		// 预填hello，光标初始在末尾。
		editor.setText("hello");
		// 挂载多行Editor以参与布局和鼠标命中。
		tui.addChild(editor);
		// 启动虚拟渲染和输入回调。
		tui.start();
		// 等待首帧，Editor会记下正文折行几何。
		await terminal.waitForRender();

		// 按下1基第3列/第2行，落到Editor上边框下的正文行；Editor正文press留给宿主选择。
		terminal.sendInput("\x1b[<0;3;2M");
		// 同点释放时宿主合成click，Editor这时按局部列和边距定位光标。
		terminal.sendInput("\x1b[<0;3;2m");
		// 输入X走获得焦点的Editor。
		terminal.sendInput("X");
		// 等待输入后的帧及xterm队列。
		await terminal.waitForRender();

		// 检查X在he后，证明局部坐标最终转为正确码元位置。
		assert.strictEqual(editor.getText(), "heXllo");
		// 确认键盘焦点是这个Editor对象。
		assert.strictEqual(tui.getFocusedComponent(), editor);
		// 正常路径停宿主；没有finally保证断言失败也停。
		tui.stop();
	});

	// 正文拖选应交宿主屏幕选择，释放后复制hello但不移动编辑光标；复制回调只push内存数组并返回true，不调用系统剪贴板，正常stop清提示计时器。
	it("selects and copies editor text on drag instead of moving the cursor", async () => {
		// 20列6行虚拟终端。
		const terminal = new VirtualTerminal(20, 6);
		// 保存宿主提取出的复制文本，用于断言而非实际剪贴板。
		const copied: string[] = [];
		// undefined使中间构造参数取默认，第四项显式注入复制实现。
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			// 异步回调输入选择纯文字，正常push后完成为true；async封装Promise，当前函数不等待系统动作，若函数体抛错仍会拒绝Promise。
			copySelection: async (text) => {
				// 记录实际复制文本，每次调用增加一项。
				copied.push(text);
				// true通知宿主复制成功，之后宿主可显示短暂Copied提示；这是测试模拟的成功。
				return true;
			},
		});
		// 构造同一宿主下Editor。
		const editor = new Editor(tui, editorTheme);
		// 预填hello world，光标在末尾，拖选不应把它挪走。
		editor.setText("hello world");
		// 挂载Editor以便屏幕选择读取其可见文字。
		tui.addChild(editor);
		// 启动虚拟链路。
		tui.start();
		// 等待正文渲染完成，再读取光标基线并开始拖动。
		await terminal.waitForRender();
		// getCursor返回新的逻辑行/码元列对象，保存值不会随Editor状态被原地修改。
		const cursorBefore = editor.getCursor();

		// 从1基列1/行2按下，0基正文列0建立宿主选择锚点。
		terminal.sendInput("\x1b[<0;1;2M");
		// 按钮32是左键带移动位，拖到1基列5/行2，形成包含hello的范围。
		terminal.sendInput("\x1b[<32;5;2M");
		// 释放完成选择并发起异步复制，不合成定位光标的单击。
		terminal.sendInput("\x1b[<0;5;2m");
		// 等常见帧与Promise机会；测试并未直接await私有复制Promise，但断言会检查回调已记录。
		await terminal.waitForRender();

		// 完整数组恰好一项hello，既检验范围内容也检验没有重复复制通知。
		assert.deepStrictEqual(copied, ["hello"]);
		// 光标与拖前对象深相等，证明宿主拖选没有走Editor点击定位分支。
		assert.deepStrictEqual(editor.getCursor(), cursorBefore);
		// 正常stop会dispose宿主flash、停止选区自动滚动及渲染timer；不表示所有组件的任意自建任务都被销毁。
		tui.stop();
	});
});
