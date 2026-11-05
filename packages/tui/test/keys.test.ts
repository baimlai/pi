// 用人工输入串检查键名匹配、协议解析和可打印文本解码；不连接键盘/终端，不向真实进程发送Ctrl+C信号。
// 测试会改模块级Kitty解释标志，部分解析还写最近事件类型；正常路径复位标志，断言失败前并无统一finally复位。
// WT/SSH环境用同步helper临时修改并在finally恢复；这些启发式只解释已给定字符串，不探测真实Windows终端或建立SSH连接。
/**
 * Tests for keyboard input handling
 */

// Node的strictEqual按值严格比较布尔/文字/undefined，失败会抛断言错误。
import assert from "node:assert";
// describe组织分组，it注册同步回调；此文件没有定时等待或异步终端读写。
import { describe, it } from "node:test";
// 从实际键盘模块导入下面的实现和构造键名辅助，不经过宿主终端start。
import {
	// 只解Kitty CSI-u里的可打印字符，函数不要求全局Kitty已激活，控制/未映射功能码等返回undefined。
	decodeKittyPrintable,
	// 先试Kitty文字解码，再试modifyOtherKeys，不等于按快捷键名字解析。
	decodePrintableKey,
	// 按输入中的特定:3片段识别释放，并排除括号粘贴标记；不读取上一次解析结果或查询物理按键是否已松开。
	isKeyRelease,
	// 同样用:2片段识别重复，有限字符串识别不验证整份协议报文。
	isKeyRepeat,
	// Key是生成类型明确键名的对象，例如ctrlSuper("k")得到普通字符串，不发送按键。
	Key,
	// 检查输入与KeyId是否匹配；可读模块标志/环境，Kitty解析路径可更新最近事件类型，不能只凭matches名字当成完全无状态函数。
	matchesKey,
	// 把能识别的输入规范成键名string，否则undefined；修饰键输出有固定顺序，不一定与传入KeyId拼法相同。
	parseKey,
	// 只改模块级布尔解释偏好，不开关终端协议、不发控制串，也不重置所有解析状态。
	setKittyProtocolActive,
} from "../src/keys.ts";

// 临时设置/删除一个环境变量，执行同步fn后恢复原值，返回void；例withEnv("WT_SESSION",undefined,fn)让fn按未设置路径判断。
// try/finally确保fn同步抛错也恢复，错误继续传播；不等待异步fn的Promise，因此不适合包异步任务。
function withEnv(name: string, value: string | undefined, fn: () => void): void {
	// 方括号按name动态读取原值，undefined表示原来没有此变量，空串则作为实际原值保留。
	const previous = process.env[name];
	// 传undefined时删除键，而不是把字面文字"undefined"写进环境。
	if (value === undefined) delete process.env[name];
	// 否则写给定字符串，供后续同步键解析读取；这是测试进程的环境状态变化。
	else process.env[name] = value;
	// 先完成环境修改，再用try保护回调执行与后面的恢复。
	try {
		// 同步调用fn，无await；fn失败会经过finally再向调用方抛出。
		fn();
		// 正常返回或同步抛错都会尝试恢复环境，不在这里吞原错误。
	} finally {
		// 原来缺省就删除测试临时值，恢复“没有设置”而非空字符串。
		if (previous === undefined) delete process.env[name];
		// 原来存在则写回同一原字符串，包括原空串。
		else process.env[name] = previous;
	}
}

// 用嵌套withEnv一次覆盖多项环境，返回void，不改vars对象；全部设置好后调用fn，再按嵌套层从内到外恢复。
// 例同时设WT_SESSION并删除3个SSH线索，模拟本地Windows Terminal；仅同步作用域安全，没有外部会话操作。
function withEnvVars(vars: Record<string, string | undefined>, fn: () => void): void {
	// Object.entries建立键值对数组，按其枚举顺序逐项进入嵌套作用域，value允许undefined表示删除。
	const entries = Object.entries(vars);
	// 局部递归箭头接当前条目下标，捕获entries/fn；每层包一项环境，直到基线才执行目标回调。
	const run = (index: number): void => {
		// 下标到数组末尾说明全部覆盖已安装，不再访问不存在的条目。
		if (index >= entries.length) {
			// 在所有临时环境同时生效时调用目标同步回调。
			fn();
			// 基线结束，随后逐层离开withEnv的finally恢复旧环境。
			return;
		}
		// 解构当前[name,value]；!只让TS接受该下标存在，运行时没有增加边界检查，前面条件维持范围。
		const [name, value] = entries[index]!;
		// 当前环境覆盖的同步回调再进入下一项；不是现在就调用run(index+1)再把其返回值当函数。
		withEnv(name, value, () => run(index + 1));
	};
	// 从第一项开始递归；空对象直接在基线执行fn。
	run(0);
}

// 总匹配组覆盖Kitty、modifyOtherKeys和旧编码；结果只说明这些固定输入的解释，不证明终端实际支持协议。
describe("matchesKey", () => {
	// 备用键码组覆盖非拉丁布局回退、移位字符、修饰位和功能键；同一字符串可经物理键/输出字符规则匹配不同允许拼法。
	describe("Kitty protocol with alternate keys (non-Latin layouts)", () => {
		// Kitty protocol flag 4 (Report alternate keys) sends:
		// CSI codepoint:shifted:base ; modifier:event u
		// Where base is the key in standard PC-101 layout

		// 西里尔с配base99应匹配Ctrl+C：设置解释标志→构造串→同步断言→正常复位，没有向真实终端按Ctrl+C。
		it("should match Ctrl+c when pressing Ctrl+С (Cyrillic) with base layout key", () => {
			// 本条使用Kitty解释偏好，其他协议是否能解析仍由各分支决定，不是全局仅许Kitty的开关。
			setKittyProtocolActive(true);
			// Cyrillic 'с' = codepoint 1089, Latin 'c' = codepoint 99
			// Format: CSI 1089::99;5u (codepoint::base;modifier with ctrl=4, +1=5)
			// ESC[为CSI，1089是西里尔с，双冒号留空shifted，base99为c；线上的5减1得到Ctrl位4。
			const cyrillicCtrlC = "\x1b[1089::99;5u";
			// 主码点不是已识别的拉丁字母/符号时允许回退base99，因此键名ctrl+c应匹配。
			assert.strictEqual(matchesKey(cyrillicCtrlC, "ctrl+c"), true);
			// 正常结尾复位false；前面assert抛错时此行不会执行，不恢复进入本条前的任意旧布尔值。
			setKittyProtocolActive(false);
		});

		// 把西里尔в及base100映射到Ctrl+D，流程仅改模块状态/比较字符串，无终端I/O。
		it("should match Ctrl+d when pressing Ctrl+В (Cyrillic) with base layout key", () => {
			// 启用本条的Kitty模式解释。
			setKittyProtocolActive(true);
			// Cyrillic 'в' = codepoint 1074, Latin 'd' = codepoint 100
			// 1074是в，100是d，修饰值5仍对应Ctrl4；shifted字段留空。
			const cyrillicCtrlD = "\x1b[1074::100;5u";
			// 通过base回退匹配ctrl+d，而不是把в硬编码成所有终端里都等于d。
			assert.strictEqual(matchesKey(cyrillicCtrlD, "ctrl+d"), true);
			// 正常后置关闭模块标志。
			setKittyProtocolActive(false);
		});

		// 西里尔я配base122检验Ctrl+Z回退，不发送会让真实进程挂起的控制输入。
		it("should match Ctrl+z when pressing Ctrl+Я (Cyrillic) with base layout key", () => {
			// 先设模块解释标志true。
			setKittyProtocolActive(true);
			// Cyrillic 'я' = codepoint 1103, Latin 'z' = codepoint 122
			// 1103对应я，122对应z，5代表Ctrl位加1的传输形式。
			const cyrillicCtrlZ = "\x1b[1103::122;5u";
			// 断言按base122得到ctrl+z匹配。
			assert.strictEqual(matchesKey(cyrillicCtrlZ, "ctrl+z"), true);
			// 正常完成复位false。
			setKittyProtocolActive(false);
		});

		// 联合Ctrl和Shift仍需保留全部修饰位，西里尔主码点按base112回退为p，最后正常复位。
		it("should match Ctrl+Shift+p with base layout key", () => {
			// 使用Kitty解释偏好，不执行真实协议协商。
			setKittyProtocolActive(true);
			// Cyrillic 'з' = codepoint 1079, Latin 'p' = codepoint 112
			// ctrl=4, shift=1, +1 = 6
			// 6减1为5，即Shift1|Ctrl4；base112是p，shifted仍未报告。
			const cyrillicCtrlShiftP = "\x1b[1079::112;6u";
			// 匹配输入里的Ctrl与Shift以及回退字母p，修饰词输入顺序不要求与parseKey输出顺序相同。
			assert.strictEqual(matchesKey(cyrillicCtrlShiftP, "ctrl+shift+p"), true);
			// 正常回到false，避免后续依赖旧编码解释的用例沿用true。
			setKittyProtocolActive(false);
		});

		// 只报告拉丁主码点99且没有备用字段时也能匹配Ctrl+C，不要求终端必须提供flag4的备用键码。
		it("should still match direct codepoint when no base layout key", () => {
			// 设置本条模式偏好true。
			setKittyProtocolActive(true);
			// Latin ctrl+c without base layout key (terminal doesn't support flag 4)
			// 99直接是c，5减1为Ctrl位，没有冒号备用字段。
			const latinCtrlC = "\x1b[99;5u";
			// 主码点和修饰位直接相同，无需base回退。
			assert.strictEqual(matchesKey(latinCtrlC, "ctrl+c"), true);
			// 正常结尾关闭标志。
			setKittyProtocolActive(false);
		});

		// 同一回调检查Super及组合修饰的匹配/规范名字，包含一个少写Ctrl的反例；只有所有assert成功才执行末尾复位。
		it("should match super-modified Kitty bindings, including combined modifiers", () => {
			// 本组组合键在Kitty模式下解释。
			setKittyProtocolActive(true);
			// 9减1为8即Super，107是k，要求super+k匹配。
			assert.strictEqual(matchesKey("\x1b[107;9u", "super+k"), true);
			// 13是Enter主码点，修饰9同样代表Super。
			assert.strictEqual(matchesKey("\x1b[13;9u", "super+enter"), true);
			// 13减1为Ctrl4|Super8；Key.ctrlSuper返回有类型提示的ctrl+super+k字符串，与手写键名语义相同。
			assert.strictEqual(matchesKey("\x1b[107;13u", Key.ctrlSuper("k")), true);
			// 同一串改用手写键名也必须匹配，覆盖辅助对象和文字两种调用方式。
			assert.strictEqual(matchesKey("\x1b[107;13u", "ctrl+super+k"), true);
			// 14减1为Shift1|Ctrl4|Super8，要求三种修饰都存在。
			assert.strictEqual(matchesKey("\x1b[107;14u", "ctrl+shift+super+k"), true);
			// 输入还带Ctrl时不能只匹配Super，验证不是修饰位的任意子集匹配。
			assert.strictEqual(matchesKey("\x1b[107;13u", "super+k"), false);
			// parseKey将Super8按固定命名顺序输出super+k。
			assert.strictEqual(parseKey("\x1b[107;9u"), "super+k");
			// Enter的Super变体规范为super+enter，不保留数字13。
			assert.strictEqual(parseKey("\x1b[13;9u"), "super+enter");
			// Ctrl+Super规范输出ctrl+super+k。
			assert.strictEqual(parseKey("\x1b[107;13u"), "ctrl+super+k");
			// 解析固定先Shift后Ctrl再Super，所以输出shift+ctrl+super+k，与上面的匹配键名拼法顺序不同也合理。
			assert.strictEqual(parseKey("\x1b[107;14u"), "shift+ctrl+super+k");
			// 正常结束复位false。
			setKittyProtocolActive(false);
		});

		// 数字键和Ctrl数字键应可匹配/解析，另用ctrl+2作反例确认数字身份没有丢失。
		it("should match digit bindings via Kitty CSI-u", () => {
			// 为该回调设置Kitty解释偏好。
			setKittyProtocolActive(true);
			// ASCII49是字符1，省略修饰字段按线路默认1再减1得到无修饰。
			assert.strictEqual(matchesKey("\x1b[49u", "1"), true);
			// 主码点49加线路5表示Ctrl+1。
			assert.strictEqual(matchesKey("\x1b[49;5u", "ctrl+1"), true);
			// 同一输入不是Ctrl+2，要求false防止只检查Ctrl位。
			assert.strictEqual(matchesKey("\x1b[49;5u", "ctrl+2"), false);
			// 无修饰数字解析为文字"1"，不是number1。
			assert.strictEqual(parseKey("\x1b[49u"), "1");
			// 有Ctrl位解析为ctrl+1。
			assert.strictEqual(parseKey("\x1b[49;5u"), "ctrl+1");
			// 正常复位模块状态。
			setKittyProtocolActive(false);
		});

		// Kitty数字小键盘使用私用功能码，先经有限表映射成逻辑数字/符号/导航键；此回调只覆盖列出的若干项。
		it("should normalize Kitty keypad functional keys to logical digits, symbols, and navigation", () => {
			// 启用Kitty模式偏好，不调用原生键盘模块。
			setKittyProtocolActive(true);
			// 57400是小键盘1，归一为ASCII49后匹配字符1。
			assert.strictEqual(matchesKey("\x1b[57400u", "1"), true);
			// 57410是小键盘除号，归一为/。
			assert.strictEqual(matchesKey("\x1b[57410u", "/"), true);
			// 57417归一为内部左箭头标识，匹配left。
			assert.strictEqual(matchesKey("\x1b[57417u", "left"), true);
			// 57426归一为Delete标识，匹配delete，而不是插入这个私用区字形。
			assert.strictEqual(matchesKey("\x1b[57426u", "delete"), true);
			// 57399解析为小键盘数字0的逻辑名字。
			assert.strictEqual(parseKey("\x1b[57399u"), "0");
			// 57409的小键盘小数点映射成句点文字。
			assert.strictEqual(parseKey("\x1b[57409u"), ".");
			// 57413的小键盘加号映射成+，没有额外虚构Shift位。
			assert.strictEqual(parseKey("\x1b[57413u"), "+");
			// 57416分隔符映射成逗号。
			assert.strictEqual(parseKey("\x1b[57416u"), ",");
			// 57417规范为left。
			assert.strictEqual(parseKey("\x1b[57417u"), "left");
			// 57418规范为right，与上一条左右区分。
			assert.strictEqual(parseKey("\x1b[57418u"), "right");
			// 57419规范为up。
			assert.strictEqual(parseKey("\x1b[57419u"), "up");
			// 57420规范为down。
			assert.strictEqual(parseKey("\x1b[57420u"), "down");
			// 57421规范为区分大小写的pageUp文字，U大写是输出约定。
			assert.strictEqual(parseKey("\x1b[57421u"), "pageUp");
			// 57422规范为pageDown。
			assert.strictEqual(parseKey("\x1b[57422u"), "pageDown");
			// 57423规范为home。
			assert.strictEqual(parseKey("\x1b[57423u"), "home");
			// 57424规范为end。
			assert.strictEqual(parseKey("\x1b[57424u"), "end");
			// 57425规范为insert。
			assert.strictEqual(parseKey("\x1b[57425u"), "insert");
			// 57426规范为delete；本条测parseKey，前面另测matchesKey同一码。
			assert.strictEqual(parseKey("\x1b[57426u"), "delete");
			// 所有小键盘断言正常完成后关闭标志。
			setKittyProtocolActive(false);
		});

		// 移位符号可按输出字符+匹配，也能按物理Shift+=匹配；Ctrl组合保留Ctrl并消费生成符号所隐含的Shift。
		it("should match shifted symbols by their produced character", () => {
			// 设置本条Kitty模式。
			setKittyProtocolActive(true);
			// 61是=、shifted43是+，线路2表示Shift；逻辑匹配消费Shift后接受普通+。
			assert.strictEqual(matchesKey("\x1b[61:43;2u", "+"), true);
			// 同一报文的主码点61和Shift位也允许物理拼法shift+=。
			assert.strictEqual(matchesKey("\x1b[61:43;2u", "shift+="), true);
			// 解析优先输出逻辑符号+，不同时返回两种键名。
			assert.strictEqual(parseKey("\x1b[61:43;2u"), "+");
			// 线路6对应Shift|Ctrl，消费用于生成+的Shift后保留Ctrl，ctrl++的最后一个+是基键。
			assert.strictEqual(matchesKey("\x1b[61:43;6u", "ctrl++"), true);
			// 规范输出ctrl++，不是ctrl+shift+=。
			assert.strictEqual(parseKey("\x1b[61:43;6u"), "ctrl++");
			// 正常结尾复位false。
			setKittyProtocolActive(false);
		});

		// 同时给主c、shiftedC、basec，检查Shift+C匹配；备用字段的存在不自动覆盖已识别拉丁主码点。
		it("should handle shifted key in format", () => {
			// 先启用Kitty解释偏好。
			setKittyProtocolActive(true);
			// Format with shifted key: CSI codepoint:shifted:base;modifier u
			// Latin 'c' with shifted 'C' (67) and base 'c' (99)
			// 99/67/99依次是c/C/c，线路2减1为Shift位1；报文的冒号字段与分号字段各有不同职责。
			const shiftedKey = "\x1b[99:67:99;2u"; // shift modifier = 1, +1 = 2
			// 要求shift+c为真，不能把大写C又当额外字母或再增加一次Shift。
			assert.strictEqual(matchesKey(shiftedKey, "shift+c"), true);
			// 正常复位。
			setKittyProtocolActive(false);
		});

		// 释放事件也可匹配其键身份；是否把释放传给组件由更外层决定，matchesKey本身不自动过滤。
		it("should handle event type in format", () => {
			// 启用模式标志，但此处没有启动真正的事件订阅。
			setKittyProtocolActive(true);
			// Format with event type: CSI codepoint::base;modifier:event u
			// Cyrillic ctrl+c release event (event type 3)
			// 5:3分别是Ctrl传输修饰值与release事件类型，base99仍是c。
			const releaseEvent = "\x1b[1089::99;5:3u";
			// 释放报文按键身份仍匹配ctrl+c；这条没调用isKeyRelease来断言事件判断。
			assert.strictEqual(matchesKey(releaseEvent, "ctrl+c"), true);
			// 正常关闭标志。
			setKittyProtocolActive(false);
		});

		// 完整备用格式把西里尔大小写、basec、Ctrl|Shift和repeat放在一起，验证这些字段能组合解析。
		it("should handle full format with shifted key, base key, and event type", () => {
			// 为完整格式设置模式偏好。
			setKittyProtocolActive(true);
			// Full format: CSI codepoint:shifted:base;modifier:event u
			// Cyrillic 'С' (shifted) with base 'c', Ctrl+Shift pressed, repeat event
			// Cyrillic 'с' = 1089, Cyrillic 'С' = 1057, Latin 'c' = 99
			// ctrl=4, shift=1, +1 = 6, repeat event = 2
			// 1089:1057:99表示主с/移位С/basec；6:2表示Ctrl|Shift以及重复事件，不是第2个独立按键。
			const fullFormat = "\x1b[1089:1057:99;6:2u";
			// 要求ctrl+shift+c匹配，重复事件不阻止键身份匹配；解析过程中最近事件状态可被更新。
			assert.strictEqual(matchesKey(fullFormat, "ctrl+shift+c"), true);
			// 正常复位false。
			setKittyProtocolActive(false);
		});

		// Dvorak例中主k已是识别的拉丁字母，应优先主码点，不能因basev又把它匹配成Ctrl+V。
		it("should prefer codepoint for Latin letters even when base layout differs", () => {
			// 启用本条Kitty模式。
			setKittyProtocolActive(true);
			// Dvorak Ctrl+K reports codepoint 'k' (107) and base layout 'v' (118)
			// 107表示k，base118表示v，传输修饰5为Ctrl。
			const dvorakCtrlK = "\x1b[107::118;5u";
			// 权威主键k应匹配Ctrl+K。
			assert.strictEqual(matchesKey(dvorakCtrlK, "ctrl+k"), true);
			// 不同的basev不应形成第二个错误匹配。
			assert.strictEqual(matchesKey(dvorakCtrlK, "ctrl+v"), false);
			// 正常后置复位。
			setKittyProtocolActive(false);
		});

		// 已识别符号/也优先于base[，避免重排键盘布局把Ctrl+/误当成Ctrl+[。
		it("should prefer codepoint for symbol keys even when base layout differs", () => {
			// 启用本条模式解释。
			setKittyProtocolActive(true);
			// Dvorak Ctrl+/ reports codepoint '/' (47) and base layout '[' (91)
			// 47表示/，base91表示[，它们都在已知符号集合，但主码点具有优先权。
			const dvorakCtrlSlash = "\x1b[47::91;5u";
			// 直接符号身份匹配ctrl+/。
			assert.strictEqual(matchesKey(dvorakCtrlSlash, "ctrl+/"), true);
			// 拒绝来自base字段的ctrl+[错误解释。
			assert.strictEqual(matchesKey(dvorakCtrlSlash, "ctrl+["), false);
			// 正常复位模块标志。
			setKittyProtocolActive(false);
		});

		// 非拉丁回退也不能忽略目标键差异，basec不得匹配d；设置、断言后正常复位。
		it("should not match wrong key even with base layout", () => {
			// 先启用Kitty模式。
			setKittyProtocolActive(true);
			// Cyrillic ctrl+с with base 'c' should NOT match ctrl+d
			// 仍构造西里尔с、basec与Ctrl位，反例只更换待匹配目标。
			const cyrillicCtrlC = "\x1b[1089::99;5u";
			// 目标ctrl+d与base99不符，必须false。
			assert.strictEqual(matchesKey(cyrillicCtrlC, "ctrl+d"), false);
			// 正常结束设false。
			setKittyProtocolActive(false);
		});

		// 主/备用键码一致也不能忽略多出的Shift要求，只有Ctrl的输入不得匹配Ctrl+Shift+C。
		it("should not match wrong modifiers even with base layout", () => {
			// 设置本条模式偏好。
			setKittyProtocolActive(true);
			// Cyrillic ctrl+с should NOT match ctrl+shift+c
			// 线路5表示Ctrl4，没有Shift1。
			const cyrillicCtrlC = "\x1b[1089::99;5u";
			// 待匹配目标要求Ctrl|Shift，实际修饰不相同，返回false。
			assert.strictEqual(matchesKey(cyrillicCtrlC, "ctrl+shift+c"), false);
			// 正常复位false。
			setKittyProtocolActive(false);
		});
	});

	// modifyOtherKeys使用CSI27;修饰值;键码~，与Kitty的CSI键码;修饰值u字段顺序不同；关闭Kitty并不禁止兼容CSI-u解析。
	describe("modifyOtherKeys matching", () => {
		// Ctrl+C的xterm格式分别测布尔匹配和规范键名，回调只做同步字符串处理。
		it("should match xterm modifyOtherKeys Ctrl+c", () => {
			// 使用旧模式解释偏好，保留modifyOtherKeys解析能力。
			setKittyProtocolActive(false);
			// 27是该格式固定前缀，5减1为Ctrl位，末项99才是c的键码。
			assert.strictEqual(matchesKey("\x1b[27;5;99~", "ctrl+c"), true);
			// 同一报文解析为ctrl+c，而不是数字27的字符。
			assert.strictEqual(parseKey("\x1b[27;5;99~"), "ctrl+c");
		});

		// Ctrl+D样例换末项为100，匹配与解析都应跟着改变。
		it("should match xterm modifyOtherKeys Ctrl+d", () => {
			// 明确关闭Kitty解释偏好。
			setKittyProtocolActive(false);
			// 键码100代表d，修饰5表示Ctrl，匹配ctrl+d。
			assert.strictEqual(matchesKey("\x1b[27;5;100~", "ctrl+d"), true);
			// 规范输出ctrl+d，大小写和加号是返回文字的一部分。
			assert.strictEqual(parseKey("\x1b[27;5;100~"), "ctrl+d");
		});

		// Ctrl+Z的末项122检验另一控制字母映射，不执行系统挂起。
		it("should match xterm modifyOtherKeys Ctrl+z", () => {
			// 在旧模式偏好下处理此xterm报文。
			setKittyProtocolActive(false);
			// Ctrl修饰与键码122组合匹配ctrl+z。
			assert.strictEqual(matchesKey("\x1b[27;5;122~", "ctrl+z"), true);
			// 同样应解析出ctrl+z。
			assert.strictEqual(parseKey("\x1b[27;5;122~"), "ctrl+z");
		});

		// 同一Enter键码13配不同修饰值，分别验证Ctrl/Shift/Alt匹配与规范名字。
		it("should match xterm modifyOtherKeys Enter variants", () => {
			// 关闭Kitty标志，确保这条不是靠模式相关的换行映射通过。
			setKittyProtocolActive(false);
			// 5减1为Ctrl，13为Enter。
			assert.strictEqual(matchesKey("\x1b[27;5;13~", "ctrl+enter"), true);
			// 2减1为Shift，目标shift+enter。
			assert.strictEqual(matchesKey("\x1b[27;2;13~", "shift+enter"), true);
			// 3减1为Alt，目标alt+enter。
			assert.strictEqual(matchesKey("\x1b[27;3;13~", "alt+enter"), true);
			// 解析Ctrl Enter的规范名字。
			assert.strictEqual(parseKey("\x1b[27;5;13~"), "ctrl+enter");
			// 解析Shift Enter，不把它当普通enter。
			assert.strictEqual(parseKey("\x1b[27;2;13~"), "shift+enter");
			// 解析Alt Enter，和Shift变体区分。
			assert.strictEqual(parseKey("\x1b[27;3;13~"), "alt+enter");
		});

		// Tab键码9配Shift/Ctrl/Alt，各检查匹配和parseKey返回；不在模拟终端中实际切换焦点。
		it("should match xterm modifyOtherKeys Tab variants", () => {
			// 本条明确使用旧模式偏好。
			setKittyProtocolActive(false);
			// 线路2是Shift，键码9为Tab，匹配shift+tab。
			assert.strictEqual(matchesKey("\x1b[27;2;9~", "shift+tab"), true);
			// 线路5是Ctrl，匹配ctrl+tab。
			assert.strictEqual(matchesKey("\x1b[27;5;9~", "ctrl+tab"), true);
			// 线路3是Alt，匹配alt+tab。
			assert.strictEqual(matchesKey("\x1b[27;3;9~", "alt+tab"), true);
			// 解析Shift Tab为shift+tab，不输出原数字报文。
			assert.strictEqual(parseKey("\x1b[27;2;9~"), "shift+tab");
			// 解析Ctrl Tab为ctrl+tab。
			assert.strictEqual(parseKey("\x1b[27;5;9~"), "ctrl+tab");
			// 解析Alt Tab为alt+tab。
			assert.strictEqual(parseKey("\x1b[27;3;9~"), "alt+tab");
		});

		// 显式报文里的键码127和修饰字段可区分普通/Ctrl/Alt退格，不需要猜原始0x08的环境歧义。
		it("should match xterm modifyOtherKeys Backspace variants", () => {
			// 使用旧模式偏好，但此三种都是显式modifyOtherKeys报文。
			setKittyProtocolActive(false);
			// 修饰1减1为0，所以127对应普通backspace。
			assert.strictEqual(matchesKey("\x1b[27;1;127~", "backspace"), true);
			// 修饰5减1为Ctrl，匹配ctrl+backspace。
			assert.strictEqual(matchesKey("\x1b[27;5;127~", "ctrl+backspace"), true);
			// 修饰3减1为Alt，匹配alt+backspace。
			assert.strictEqual(matchesKey("\x1b[27;3;127~", "alt+backspace"), true);
			// 无修饰127解析为backspace。
			assert.strictEqual(parseKey("\x1b[27;1;127~"), "backspace");
			// 有Ctrl的127解析为ctrl+backspace。
			assert.strictEqual(parseKey("\x1b[27;5;127~"), "ctrl+backspace");
			// 有Alt的127解析为alt+backspace。
			assert.strictEqual(parseKey("\x1b[27;3;127~"), "alt+backspace");
		});

		// Escape同样可被包进modifyOtherKeys；匹配/解析这条字符串不触发真实取消动作。
		it("should match xterm modifyOtherKeys Escape", () => {
			// 关闭Kitty解释偏好。
			setKittyProtocolActive(false);
			// 第一个27是格式前缀，最后27才是Escape键码，中间1表示无修饰。
			assert.strictEqual(matchesKey("\x1b[27;1;27~", "escape"), true);
			// 规范键名为escape，不返回esc别名。
			assert.strictEqual(parseKey("\x1b[27;1;27~"), "escape");
		});

		// 空格与Ctrl空格的显式报文通过修饰值区分；同时检查匹配结果与规范名字。
		it("should match xterm modifyOtherKeys Space variants", () => {
			// 按旧模式偏好解释该组。
			setKittyProtocolActive(false);
			// 键码32、修饰1对应普通space。
			assert.strictEqual(matchesKey("\x1b[27;1;32~", "space"), true);
			// 键码32、修饰5对应ctrl+space。
			assert.strictEqual(matchesKey("\x1b[27;5;32~", "ctrl+space"), true);
			// 普通空格的键名是space，不是单个空格字符；文字解码另有API。
			assert.strictEqual(parseKey("\x1b[27;1;32~"), "space");
			// Ctrl变体保留ctrl+前缀。
			assert.strictEqual(parseKey("\x1b[27;5;32~"), "ctrl+space");
		});

		// 符号键覆盖Ctrl+/和生成加号时的隐含Shift消费，输入键码本身是产生后的符号。
		it("should match xterm modifyOtherKeys symbol combos", () => {
			// 旧模式仍可解析modifyOtherKeys符号。
			setKittyProtocolActive(false);
			// 键码47是/、修饰5是Ctrl，要求ctrl+/匹配。
			assert.strictEqual(matchesKey("\x1b[27;5;47~", "ctrl+/"), true);
			// 规范返回ctrl+/，不把斜杠当路径操作。
			assert.strictEqual(parseKey("\x1b[27;5;47~"), "ctrl+/");
			// 43是+、修饰6为Ctrl|Shift；逻辑符号规则消费用于生成+的Shift，保留Ctrl。
			assert.strictEqual(matchesKey("\x1b[27;6;43~", "ctrl++"), true);
			// 输出ctrl++，末尾+是基键，不是缺失另一个修饰词。
			assert.strictEqual(parseKey("\x1b[27;6;43~"), "ctrl++");
		});

		// 数字1的Ctrl/Shift组合保留修饰身份，不把Shift+1猜成当前键盘布局中某个符号。
		it("should match xterm modifyOtherKeys digit combos", () => {
			// 明确旧模式偏好。
			setKittyProtocolActive(false);
			// 末项49代表1，线路5表示Ctrl，匹配ctrl+1。
			assert.strictEqual(matchesKey("\x1b[27;5;49~", "ctrl+1"), true);
			// 末项仍49，线路2表示Shift，匹配shift+1。
			assert.strictEqual(matchesKey("\x1b[27;2;49~", "shift+1"), true);
			// Ctrl数字解析为ctrl+1。
			assert.strictEqual(parseKey("\x1b[27;5;49~"), "ctrl+1");
			// Shift数字解析为shift+1，未把它替换成!。
			assert.strictEqual(parseKey("\x1b[27;2;49~"), "shift+1");
		});

		// 主码点是大写E且有Shift时，键身份先规范为小写e再保留Shift修饰；Ctrl组合也遵循这一规则。
		it("should match xterm modifyOtherKeys shifted uppercase letters", () => {
			// 以旧模式偏好测试xterm格式，不依赖Kitty标志。
			setKittyProtocolActive(false);
			// 69为大写E，线路2为Shift，匹配shift+e而不是要求键名shift+E。
			assert.strictEqual(matchesKey("\x1b[27;2;69~", "shift+e"), true);
			// 线路6含Ctrl|Shift，匹配两种修饰的e。
			assert.strictEqual(matchesKey("\x1b[27;6;69~", "ctrl+shift+e"), true);
			// 解析大写主码点的规范键名仍用小写e。
			assert.strictEqual(parseKey("\x1b[27;2;69~"), "shift+e");
			// 组合修饰固定先shift再ctrl输出，与匹配目标中ctrl先写不矛盾。
			assert.strictEqual(parseKey("\x1b[27;6;69~"), "shift+ctrl+e");
		});

		// Kitty标志为false也接受CSI-u显式报文，防止把这个标志误读为关闭所有Kitty格式解析。
		it("should match Ctrl+Alt+letter via CSI-u when kitty inactive", () => {
			// 关闭的是模式相关旧串解释偏好。
			setKittyProtocolActive(false);
			// CSI-u主码点104为h，线路7减1为Ctrl4|Alt2，要求ctrl+alt+h。
			assert.strictEqual(matchesKey("\x1b[104;7u", "ctrl+alt+h"), true);
			// 同一报文解析为ctrl+alt+h，不因标志false返回undefined。
			assert.strictEqual(parseKey("\x1b[104;7u"), "ctrl+alt+h");
		});

		// 上一条Ctrl+Alt+H改用xterm字段顺序，也应匹配/解析，不依赖ESC加控制字节的旧式回退。
		it("should match Ctrl+Alt+letter via xterm modifyOtherKeys", () => {
			// 明确Kitty标志false，仍保留新式兼容报文解析。
			setKittyProtocolActive(false);
			// 固定27前缀、修饰7、键码104，匹配ctrl+alt+h。
			assert.strictEqual(matchesKey("\x1b[27;7;104~", "ctrl+alt+h"), true);
			// 返回规范键名ctrl+alt+h。
			assert.strictEqual(parseKey("\x1b[27;7;104~"), "ctrl+alt+h");
		});
	});

	// 旧编码组包括原始控制字节、ESC前缀和CSI/SS3/rxvt固定序列；字节作为普通JS字符串参数，不送真实stdin。
	describe("Legacy key matching", () => {
		// 原始ETX字节应匹配Ctrl+C，只比较字符，不给测试进程发中断信号。
		it("should match legacy Ctrl+c", () => {
			// 设false，使用旧串语义。
			setKittyProtocolActive(false);
			// Ctrl+c sends ASCII 3 (ETX)
			// 0x03是ASCII控制字符3，原始Ctrl字母规则对应c。
			assert.strictEqual(matchesKey("\x03", "ctrl+c"), true);
		});

		// 原始EOT字节匹配Ctrl+D，不执行退出/关闭stdin行为。
		it("should match legacy Ctrl+d", () => {
			// 保持旧模式偏好。
			setKittyProtocolActive(false);
			// Ctrl+d sends ASCII 4 (EOT)
			// 0x04对应d的控制码，布尔比较必须true。
			assert.strictEqual(matchesKey("\x04", "ctrl+d"), true);
		});

		// 独立ESC可匹配escape，不需要在本例先改模式，也没有等待下一字节的缓冲器。
		it("should match escape key", () => {
			// 传单个U+001B字符，测试匹配器即时判断，不负责区分稍后才来的Alt前缀。
			assert.strictEqual(matchesKey("\x1b", "escape"), true);
		});

		// Kitty未激活时原始LF采用enter解释，同时测匹配和解析。
		it("should match legacy linefeed as enter", () => {
			// false使LF走旧回退，和下面true场景形成对照。
			setKittyProtocolActive(false);
			// JavaScript\n构造真实LF字符，此模式匹配普通enter。
			assert.strictEqual(matchesKey("\n", "enter"), true);
			// 解析同一LF返回enter，不返回ctrl+j。
			assert.strictEqual(parseKey("\n"), "enter");
		});

		// Kitty激活时LF视为终端自定义Shift+Enter映射，普通Enter不得同时匹配；正常结尾复位。
		it("should treat linefeed as shift+enter when kitty active", () => {
			// true改变这类含糊旧串的解释，而非改变LF本身字节。
			setKittyProtocolActive(true);
			// 要求LF匹配shift+enter。
			assert.strictEqual(matchesKey("\n", "shift+enter"), true);
			// 同一LF不能再匹配无Shift的enter。
			assert.strictEqual(matchesKey("\n", "enter"), false);
			// parseKey也需返回shift+enter，与matchesKey模式规则一致。
			assert.strictEqual(parseKey("\n"), "shift+enter");
			// 断言正常通过后设false，没有finally恢复原标志。
			setKittyProtocolActive(false);
		});

		// 旧式Ctrl+Space是NUL字节，检查匹配与规范名字，不向真实终端插入空字符。
		it("should parse ctrl+space", () => {
			// 设false以允许matchesKey的旧NUL快捷键分支。
			setKittyProtocolActive(false);
			// 0x00在旧模式匹配ctrl+space，而不是普通空格。
			assert.strictEqual(matchesKey("\x00", "ctrl+space"), true);
			// parseKey也把NUL规范成ctrl+space。
			assert.strictEqual(parseKey("\x00"), "ctrl+space");
		});

		// Ctrl+符号的旧编码有重叠：反斜杠/右方括号/下划线和连字符分别覆盖，解析只返回约定的一种规范名字。
		it("should match legacy Ctrl+symbol", () => {
			// 以旧模式偏好解释原始控制字符。
			setKittyProtocolActive(false);
			// Ctrl+\ sends ASCII 28 (File Separator) in legacy terminals
			// 0x1c是十进制28，对应Ctrl反斜杠；键名字符串内双反斜杠转义实际表示一个反斜杠。
			assert.strictEqual(matchesKey("\x1c", "ctrl+\\"), true);
			// 解析输出ctrl+反斜杠的文字，和源码转义记法要区分。
			assert.strictEqual(parseKey("\x1c"), "ctrl+\\");
			// Ctrl+] sends ASCII 29 (Group Separator) in legacy terminals
			// 0x1d十进制29，匹配Ctrl+]。
			assert.strictEqual(matchesKey("\x1d", "ctrl+]"), true);
			// 规范返回ctrl+]。
			assert.strictEqual(parseKey("\x1d"), "ctrl+]");
			// Ctrl+_ sends ASCII 31 (Unit Separator) in legacy terminals
			// Ctrl+- is on the same physical key on US keyboards
			// 0x1f十进制31可匹配Ctrl+_，这是旧编码重叠，不是识别物理键的证明。
			assert.strictEqual(matchesKey("\x1f", "ctrl+_"), true);
			// 同一控制码也允许Ctrl+-，按本实现的连字符别名规则处理。
			assert.strictEqual(matchesKey("\x1f", "ctrl+-"), true);
			// parseKey只选一个规范拼法ctrl+-，不会返回两项候选数组。
			assert.strictEqual(parseKey("\x1f"), "ctrl+-");
		});

		// ESC前缀配Ctrl符号编码解释为Ctrl+Alt组合；一个输入字符串中两个控制字符仍是一次匹配参数。
		it("should match legacy Ctrl+Alt+symbol", () => {
			// 关闭Kitty模式偏好以允许旧ESC前缀回退。
			setKittyProtocolActive(false);
			// Ctrl+Alt+[ sends ESC followed by ESC (Ctrl+[ = ESC)
			// 两个ESC按此旧规则可匹配Ctrl+Alt+[，因为Ctrl+[本身与ESC重叠。
			assert.strictEqual(matchesKey("\x1b\x1b", "ctrl+alt+["), true);
			// 解析双ESC采用ctrl+alt+[，不是两个独立escape键。
			assert.strictEqual(parseKey("\x1b\x1b"), "ctrl+alt+[");
			// Ctrl+Alt+\ sends ESC followed by ASCII 28
			// ESC后跟0x1c，匹配Ctrl+Alt+反斜杠。
			assert.strictEqual(matchesKey("\x1b\x1c", "ctrl+alt+\\"), true);
			// 规范名字保留ctrl和alt两项以及末尾反斜杠。
			assert.strictEqual(parseKey("\x1b\x1c"), "ctrl+alt+\\");
			// Ctrl+Alt+] sends ESC followed by ASCII 29
			// ESC后跟0x1d，匹配Ctrl+Alt+]。
			assert.strictEqual(matchesKey("\x1b\x1d", "ctrl+alt+]"), true);
			// 解析得到ctrl+alt+]。
			assert.strictEqual(parseKey("\x1b\x1d"), "ctrl+alt+]");
			// Ctrl+_ sends ASCII 31 (Unit Separator) in legacy terminals
			// Ctrl+- is on the same physical key on US keyboards
			// ESC后0x1f同样可匹配Ctrl+Alt+_。
			assert.strictEqual(matchesKey("\x1b\x1f", "ctrl+alt+_"), true);
			// 同一输入也可匹配Ctrl+Alt+-这个别名。
			assert.strictEqual(matchesKey("\x1b\x1f", "ctrl+alt+-"), true);
			// 解析固定选择ctrl+alt+-，不保留调用者曾比较过的别名。
			assert.strictEqual(parseKey("\x1b\x1f"), "ctrl+alt+-");
		});

		// 删除WT_SESSION模拟非Windows Terminal环境，检查BS/DEL歧义；fn同步结束/抛错均恢复环境，不要求宿主真在某个OS。
		it("should treat raw 0x08 as plain backspace outside Windows Terminal", () => {
			// 设旧模式偏好，环境仅影响原始BS解释启发式。
			setKittyProtocolActive(false);
			// 临时删除WT_SESSION后执行下面7条断言；未额外修改实际终端类型或SSH连接。
			withEnv("WT_SESSION", undefined, () => {
				// DEL0x7f匹配普通backspace，不需要WT启发式。
				assert.strictEqual(matchesKey("\x7f", "backspace"), true);
				// 同一DEL不带Ctrl身份，ctrl+backspace为false。
				assert.strictEqual(matchesKey("\x7f", "ctrl+backspace"), false);
				// 解析DEL返回普通backspace。
				assert.strictEqual(parseKey("\x7f"), "backspace");
				// 未有WT线索时BS0x08也按普通backspace匹配。
				assert.strictEqual(matchesKey("\x08", "backspace"), true);
				// 此环境不把原始BS认成Ctrl+Backspace。
				assert.strictEqual(matchesKey("\x08", "ctrl+backspace"), false);
				// parseKey同样把BS规范成backspace。
				assert.strictEqual(parseKey("\x08"), "backspace");
				// 但Ctrl+H原始控制码也是0x08，matchesKey仍可匹配ctrl+h；不是“一个字节只可能匹配一个名字”的契约。
				assert.strictEqual(matchesKey("\x08", "ctrl+h"), true);
			});
		});

		// 只靠WT_SESSION真值且无3个SSH线索模拟本地Windows Terminal，BS改认Ctrl+Backspace；这不是检查真实平台或登录状态。
		it("should treat raw 0x08 as ctrl+backspace in local Windows Terminal", () => {
			// 先固定旧模式偏好false。
			setKittyProtocolActive(false);
			// 多变量helper嵌套安装下面环境，回调完成后逐层finally恢复。
			withEnvVars(
				{
					// 任意非空test-session满足WT_SESSION的真值判据，不验证会话id格式。
					WT_SESSION: "test-session",
					// 删除SSH_CONNECTION，避免它阻止本地WT判定。
					SSH_CONNECTION: undefined,
					// 同时删除SSH_CLIENT这一远程线索。
					SSH_CLIENT: undefined,
					// 再删除SSH_TTY，确保3个SSH字段都无真值。
					SSH_TTY: undefined,
				},
				// 所有覆盖生效后同步检查BS四种解释；不会建立Windows Terminal或SSH会话。
				() => {
					// 本地WT启发式使BS匹配ctrl+backspace。
					assert.strictEqual(matchesKey("\x08", "ctrl+backspace"), true);
					// 此时同一BS不再按普通backspace匹配。
					assert.strictEqual(matchesKey("\x08", "backspace"), false);
					// parseKey选择ctrl+backspace这一规范名字。
					assert.strictEqual(parseKey("\x08"), "ctrl+backspace");
					// Ctrl+H原始控制码仍匹配BS，和退格启发式是可重叠的匹配分支。
					assert.strictEqual(matchesKey("\x08", "ctrl+h"), true);
				},
			);
		});

		// WT_SESSION存在但同时给SSH线索时，原始BS退回普通backspace，测试只改环境文字，不执行SSH。
		it("should treat raw 0x08 as plain backspace in Windows Terminal over SSH", () => {
			// 设置旧模式解释偏好。
			setKittyProtocolActive(false);
			// 临时覆盖4项环境，回调后恢复原值/缺省状态。
			withEnvVars(
				{
					// 仍给WT_SESSION真值，让差异来自SSH字段而不是未标WT。
					WT_SESSION: "test-session",
					// 非空SSH_CONNECTION即远程线索之一，不解析里面4个数字是否是真地址。
					SSH_CONNECTION: "1 2 3 4",
					// SSH_CLIENT同为真值线索，不向这个文字所代表的端点发请求。
					SSH_CLIENT: "1 2 3",
					// SSH_TTY是固定路径文字，判定只看真值，不打开设备文件。
					SSH_TTY: "/dev/pts/1",
				},
				// 在覆盖环境下同步做4条断言，之后withEnvVars逐层恢复。
				() => {
					// 远程线索使BS不匹配ctrl+backspace。
					assert.strictEqual(matchesKey("\x08", "ctrl+backspace"), false);
					// 同一BS应重新匹配普通backspace。
					assert.strictEqual(matchesKey("\x08", "backspace"), true);
					// parseKey返回backspace，不沿用本地WT的Ctrl变体。
					assert.strictEqual(parseKey("\x08"), "backspace");
					// Ctrl+H原始编码匹配仍保留，说明该歧义不被全部消除。
					assert.strictEqual(matchesKey("\x08", "ctrl+h"), true);
				},
			);
		});

		// 先在旧模式检查多类ESC前缀，再切Kitty对同类串做反例；Alt退格是明确保留的例外，最后正常复位。
		it("should parse legacy alt-prefixed sequences when kitty inactive", () => {
			// 先关闭Kitty解释偏好，允许含糊的旧Alt前缀。
			setKittyProtocolActive(false);
			// ESC接空格匹配alt+space。
			assert.strictEqual(matchesKey("\x1b ", "alt+space"), true);
			// 解析同一串返回alt+space。
			assert.strictEqual(parseKey("\x1b "), "alt+space");
			// ESC接\b即BS0x08，匹配alt+backspace；这一支不靠WT_SESSION启发式。
			assert.strictEqual(matchesKey("\x1b\b", "alt+backspace"), true);
			// 对应解析为alt+backspace。
			assert.strictEqual(parseKey("\x1b\b"), "alt+backspace");
			// ESC接ETX0x03按旧规则匹配ctrl+alt+c。
			assert.strictEqual(matchesKey("\x1b\x03", "ctrl+alt+c"), true);
			// 解析保留Ctrl与Alt两种修饰。
			assert.strictEqual(parseKey("\x1b\x03"), "ctrl+alt+c");
			// 旧式ESCB是Alt向左的特定映射，不是普通大写B文本。
			assert.strictEqual(matchesKey("\x1bB", "alt+left"), true);
			// 解析ESCB返回alt+left。
			assert.strictEqual(parseKey("\x1bB"), "alt+left");
			// 旧式ESCF是Alt向右的特定映射。
			assert.strictEqual(matchesKey("\x1bF", "alt+right"), true);
			// 解析ESCF返回alt+right。
			assert.strictEqual(parseKey("\x1bF"), "alt+right");
			// ESC接小写a允许普通Alt字母匹配。
			assert.strictEqual(matchesKey("\x1ba", "alt+a"), true);
			// 规范为alt+a。
			assert.strictEqual(parseKey("\x1ba"), "alt+a");
			// ESC接数字1允许Alt数字匹配。
			assert.strictEqual(matchesKey("\x1b1", "alt+1"), true);
			// 规范为alt+1。
			assert.strictEqual(parseKey("\x1b1"), "alt+1");
			// ESC接逗号也属于允许的Alt符号串。
			assert.strictEqual(matchesKey("\x1b,", "alt+,"), true);
			// 规范为alt+,，末尾逗号是基键而非返回值列表分隔。
			assert.strictEqual(parseKey("\x1b,"), "alt+,");
			// ESC接句点匹配alt+.。
			assert.strictEqual(matchesKey("\x1b.", "alt+."), true);
			// 规范名字保留句点。
			assert.strictEqual(parseKey("\x1b."), "alt+.");
			// ESC接y匹配alt+y。
			assert.strictEqual(matchesKey("\x1by", "alt+y"), true);
			// 解析为alt+y。
			assert.strictEqual(parseKey("\x1by"), "alt+y");
			// ESC接z匹配alt+z，只比较字符串，不发送系统信号。
			assert.strictEqual(matchesKey("\x1bz", "alt+z"), true);
			// 解析为alt+z。
			assert.strictEqual(parseKey("\x1bz"), "alt+z");

			// 现在切true，下面沿用同类输入检查模式相关的拒绝边界。
			setKittyProtocolActive(true);
			// Kitty模式不把旧ESC空格映射成alt+space。
			assert.strictEqual(matchesKey("\x1b ", "alt+space"), false);
			// parseKey也返回undefined，没有给未识别输入自动造键名。
			assert.strictEqual(parseKey("\x1b "), undefined);
			// Alt退格的ESC+BS是保留例外，Kitty模式仍可匹配。
			assert.strictEqual(matchesKey("\x1b\b", "alt+backspace"), true);
			// 同样仍解析为alt+backspace，不能笼统说Kitty模式拒绝所有ESC前缀。
			assert.strictEqual(parseKey("\x1b\b"), "alt+backspace");
			// ESC+ETX的旧Ctrl+Alt+C回退在Kitty模式关闭，匹配为false。
			assert.strictEqual(matchesKey("\x1b\x03", "ctrl+alt+c"), false);
			// 对应解析为undefined，不把该控制字节串当普通文字。
			assert.strictEqual(parseKey("\x1b\x03"), undefined);
			// Kitty模式拒绝大写B的旧Alt-left映射。
			assert.strictEqual(matchesKey("\x1bB", "alt+left"), false);
			// ESCB解析也给undefined。
			assert.strictEqual(parseKey("\x1bB"), undefined);
			// 大写F的旧Alt-right映射同样被模式禁用。
			assert.strictEqual(matchesKey("\x1bF", "alt+right"), false);
			// ESCF解析为undefined。
			assert.strictEqual(parseKey("\x1bF"), undefined);
			// 普通ESC+a旧回退在Kitty模式不匹配。
			assert.strictEqual(matchesKey("\x1ba", "alt+a"), false);
			// 解析ESC+a不再得到alt+a。
			assert.strictEqual(parseKey("\x1ba"), undefined);
			// 普通ESC+1旧回退也不匹配。
			assert.strictEqual(matchesKey("\x1b1", "alt+1"), false);
			// 解析ESC+1得到undefined。
			assert.strictEqual(parseKey("\x1b1"), undefined);
			// ESC逗号不再匹配Alt逗号。
			assert.strictEqual(matchesKey("\x1b,", "alt+,"), false);
			// 解析ESC逗号得到undefined。
			assert.strictEqual(parseKey("\x1b,"), undefined);
			// ESC句点不再匹配Alt句点。
			assert.strictEqual(matchesKey("\x1b.", "alt+."), false);
			// 解析ESC句点得到undefined。
			assert.strictEqual(parseKey("\x1b."), undefined);
			// ESC+y在Kitty模式不再匹配Alt字母。
			assert.strictEqual(matchesKey("\x1by", "alt+y"), false);
			// 解析ESC+y得到undefined；这部分未另测前面ESC+z的Kitty反例。
			assert.strictEqual(parseKey("\x1by"), undefined);
			// 正常结束复位false，若中途assert失败不会保证执行到这里。
			setKittyProtocolActive(false);
		});

		// 四个普通CSI方向串分别匹配四个方向键，不在测试中真正移动光标。
		it("should match arrow keys", () => {
			// CSI A匹配up。
			assert.strictEqual(matchesKey("\x1b[A", "up"), true);
			// CSI B匹配down。
			assert.strictEqual(matchesKey("\x1b[B", "down"), true);
			// CSI C匹配right。
			assert.strictEqual(matchesKey("\x1b[C", "right"), true);
			// CSI D匹配left。
			assert.strictEqual(matchesKey("\x1b[D", "left"), true);
		});

		// SS3以ESCO开头，四个方向加Home/End都有固定兼容映射；这里仅测布尔身份。
		it("should match SS3 arrows and home/end", () => {
			// SS3 A匹配up，与前面CSI A是不同输入字节但同一逻辑键。
			assert.strictEqual(matchesKey("\x1bOA", "up"), true);
			// SS3 B匹配down。
			assert.strictEqual(matchesKey("\x1bOB", "down"), true);
			// SS3 C匹配right。
			assert.strictEqual(matchesKey("\x1bOC", "right"), true);
			// SS3 D匹配left。
			assert.strictEqual(matchesKey("\x1bOD", "left"), true);
			// SS3 H匹配home。
			assert.strictEqual(matchesKey("\x1bOH", "home"), true);
			// SS3 F匹配end。
			assert.strictEqual(matchesKey("\x1bOF", "end"), true);
		});

		// Ctrl修饰的Home/End/PageUp/PageDown分别覆盖匹配与规范键名，模拟输入不实际滚动视口。
		it("should match xterm Ctrl-modified viewport navigation", () => {
			// CSI1;5H中修饰5为Ctrl，终结H对应Home。
			assert.strictEqual(matchesKey("\x1b[1;5H", "ctrl+home"), true);
			// 同样的修饰值配F对应Ctrl+End。
			assert.strictEqual(matchesKey("\x1b[1;5F", "ctrl+end"), true);
			// CSI5;5~中第一个5是PageUp编号、第二个5是修饰传输值，二者不能混为同一字段。
			assert.strictEqual(matchesKey("\x1b[5;5~", "ctrl+pageUp"), true);
			// 编号6改为PageDown，修饰5仍是Ctrl，匹配ctrl+pageDown。
			assert.strictEqual(matchesKey("\x1b[6;5~", "ctrl+pageDown"), true);
			// 把Ctrl Home报文规范成ctrl+home文字。
			assert.strictEqual(parseKey("\x1b[1;5H"), "ctrl+home");
			// 把Ctrl End报文规范成ctrl+end。
			assert.strictEqual(parseKey("\x1b[1;5F"), "ctrl+end");
			// PageUp的规范名保留大写U，前面附ctrl+。
			assert.strictEqual(parseKey("\x1b[5;5~"), "ctrl+pageUp");
			// PageDown的规范名保留大写D。
			assert.strictEqual(parseKey("\x1b[6;5~"), "ctrl+pageDown");
		});

		// 抽样检查旧F1、F12与clear键身份；clear是键名，不代表这里会真的清屏。
		it("should match legacy function keys and clear", () => {
			// SS3 P这个旧串匹配f1。
			assert.strictEqual(matchesKey("\x1bOP", "f1"), true);
			// CSI24~编号映射到f12。
			assert.strictEqual(matchesKey("\x1b[24~", "f12"), true);
			// CSI E是clear兼容键串，matcher只返回布尔，不执行终端控制。
			assert.strictEqual(matchesKey("\x1b[E", "clear"), true);
		});

		// 尽管标题提Kitty，这条未显式开启模式，说明这些可识别功能报文不依赖该标志；抽样覆盖F键/修饰/事件并拒绝会与光标位置回复冲突的R格式。
		it("should match Kitty function keys F1-F12 with and without modifiers", () => {
			// CSI P匹配F1，和前一测试SS3 P是不同前缀。
			assert.strictEqual(matchesKey("\x1b[P", "f1"), true);
			// CSI Q匹配F2。
			assert.strictEqual(matchesKey("\x1b[Q", "f2"), true);
			// F3使用CSI13~，避免将某些R结尾位置回复当功能键。
			assert.strictEqual(matchesKey("\x1b[13~", "f3"), true);
			// CSI S匹配F4。
			assert.strictEqual(matchesKey("\x1b[S", "f4"), true);
			// CSI1;5P中的Ctrl位配F1，匹配ctrl+f1。
			assert.strictEqual(matchesKey("\x1b[1;5P", "ctrl+f1"), true);
			// 同一带Ctrl报文不允许退化为无修饰f1。
			assert.strictEqual(matchesKey("\x1b[1;5P", "f1"), false);
			// CSI1;2S的修饰2为Shift，匹配shift+f4。
			assert.strictEqual(matchesKey("\x1b[1;2S", "shift+f4"), true);
			// 编号15是F5，修饰5为Ctrl。
			assert.strictEqual(matchesKey("\x1b[15;5~", "ctrl+f5"), true);
			// 编号24是F12，修饰3为Alt。
			assert.strictEqual(matchesKey("\x1b[24;3~", "alt+f12"), true);
			// 1:2表示无修饰、repeat事件，重复并不妨碍匹配f5身份。
			assert.strictEqual(matchesKey("\x1b[15;1:2~", "f5"), true);
			// 解析CSI P得到f1。
			assert.strictEqual(parseKey("\x1b[P"), "f1");
			// 解析其Ctrl变体得到ctrl+f1。
			assert.strictEqual(parseKey("\x1b[1;5P"), "ctrl+f1");
			// 解析编号13的~格式得到f3。
			assert.strictEqual(parseKey("\x1b[13~"), "f3");
			// 编号21对应F10，修饰2为Shift，输出shift+f10。
			assert.strictEqual(parseKey("\x1b[21;2~"), "shift+f10");
			// CSI1;5R没有被接受为F3，避免与R结尾光标位置回复冲突；测试仅断言undefined，不是在解析完整位置回复。
			assert.strictEqual(parseKey("\x1b[1;5R"), undefined);
			// 字符串含:3P，释放助手给true；它不检查全局Kitty标志，也不是依赖上一条parseKey保存的事件。
			assert.strictEqual(isKeyRelease("\x1b[1;1:3P"), true);
			// 字符串含:2S，重复助手给true；本条仅覆盖该固定有效样例，不能证明对任意畸形串都完整验证。
			assert.strictEqual(isKeyRepeat("\x1b[1;1:2S"), true);
		});

		// 旧ESC+p是特定Alt+Up映射，同一串不应匹配无Alt的Up；不产生真实方向事件。
		it("should match alt+arrows", () => {
			// 要求ESC+p匹配alt+up。
			assert.strictEqual(matchesKey("\x1bp", "alt+up"), true);
			// 明确要求它不能同时匹配普通up。
			assert.strictEqual(matchesKey("\x1bp", "up"), false);
		});

		// rxvt兼容串以不同终结符编码Shift/Ctrl，抽样验证方向、Insert和Home，不依赖真实rxvt进程。
		it("should match rxvt modifier sequences", () => {
			// CSI小写a匹配Shift+Up。
			assert.strictEqual(matchesKey("\x1b[a", "shift+up"), true);
			// SS3小写a匹配Ctrl+Up，和上一条CSI前缀区分。
			assert.strictEqual(matchesKey("\x1bOa", "ctrl+up"), true);
			// CSI2$表示Shift+Insert，$在这里是协议终结字符，不是模板插值。
			assert.strictEqual(matchesKey("\x1b[2$", "shift+insert"), true);
			// CSI2^表示Ctrl+Insert。
			assert.strictEqual(matchesKey("\x1b[2^", "ctrl+insert"), true);
			// CSI7$表示Shift+Home。
			assert.strictEqual(matchesKey("\x1b[7$", "shift+home"), true);
		});
	});
});

// 可打印解码组把协议里的功能码与真正能插入正文的字符区分；不生成快捷键事件或改文档。
describe("decodeKittyPrintable", () => {
	// 三个未映射的私用功能码应被丢弃，防F13-F35等控制身份以私用区字形插进输入；只是抽样，不逐个测试全部区间。
	it("ignores unmapped Kitty functional keys such as F13-F35", () => {
		// 57376是未映射功能码，不能因为String.fromCodePoint可构造字符就作为文字返回。
		assert.strictEqual(decodeKittyPrintable("\x1b[57376u"), undefined);
		// 57398加Shift仍未映射，修饰不会把功能码变成正文。
		assert.strictEqual(decodeKittyPrintable("\x1b[57398;2u"), undefined);
		// 公共decodePrintableKey也要拒绝57382，后备modifyOtherKeys解码无法把CSI-u误解成另一格式。
		assert.strictEqual(decodePrintableKey("\x1b[57382u"), undefined);
	});

	// 已映射的小键盘功能码先变成普通字符再通过可打印判断；最后用导航码作反例，避免把所有小键盘码都当文字。
	it("should decode Kitty keypad functional keys to printable characters", () => {
		// 57399小键盘0解为文字"0"，不是number0。
		assert.strictEqual(decodeKittyPrintable("\x1b[57399u"), "0");
		// 57400小键盘1解为文字"1"。
		assert.strictEqual(decodeKittyPrintable("\x1b[57400u"), "1");
		// 57409小数点解为句点。
		assert.strictEqual(decodeKittyPrintable("\x1b[57409u"), ".");
		// 57410除法键解为斜杠。
		assert.strictEqual(decodeKittyPrintable("\x1b[57410u"), "/");
		// 57411乘法键解为星号，不自动替换成Unicode乘号。
		assert.strictEqual(decodeKittyPrintable("\x1b[57411u"), "*");
		// 57412减法键解为普通连字符。
		assert.strictEqual(decodeKittyPrintable("\x1b[57412u"), "-");
		// 57413加法键解为+。
		assert.strictEqual(decodeKittyPrintable("\x1b[57413u"), "+");
		// 57415等号键解为=。
		assert.strictEqual(decodeKittyPrintable("\x1b[57415u"), "=");
		// 57416分隔键解为逗号。
		assert.strictEqual(decodeKittyPrintable("\x1b[57416u"), ",");
		// 57417映射的是内部负数方向身份而不是可打印码点，返回undefined，不能插入left文字当正文。
		assert.strictEqual(decodeKittyPrintable("\x1b[57417u"), undefined);
	});
});

// 公共可打印解码入口支持两种显式协议；返回字符与parseKey返回规范键名是不同目标。
describe("decodePrintableKey", () => {
	// modifyOtherKeys的Shift字符保留实际大小写/Unicode码点，Enter或Ctrl组合不作为正文；回调只做同步精确断言。
	it("should decode printable xterm modifyOtherKeys sequences", () => {
		// 键码69表示大写E，文字解码返回E，而键名解析会规范成shift+e。
		assert.strictEqual(decodePrintableKey("\x1b[27;2;69~"), "E");
		// 196是Ä的Unicode码点，可打印解码不把输入限制为ASCII字母。
		assert.strictEqual(decodePrintableKey("\x1b[27;2;196~"), "Ä");
		// 32返回真正的单个空格字符，不是键名字串space。
		assert.strictEqual(decodePrintableKey("\x1b[27;2;32~"), " ");
		// 13低于可打印阈值，不把Enter回车字符作为插入文字。
		assert.strictEqual(decodePrintableKey("\x1b[27;2;13~"), undefined);
		// 修饰6含Ctrl|Shift，Ctrl组合被正文解码拒绝，即使码点E本身可打印。
		assert.strictEqual(decodePrintableKey("\x1b[27;6;69~"), undefined);
	});
});

// 规范键名组对比匹配器与解析器的返回契约，string大小写/修饰顺序本身是精确断言的一部分。
describe("parseKey", () => {
	// Kitty备用字段解析组再次验证主键优先与有限base回退，不假设所有有base的输入都必须返回base。
	describe("Kitty protocol with alternate keys", () => {
		// 西里尔主с不在拉丁/已知符号范围时，用basec返回Ctrl+C键名，正常结尾复位标志。
		it("should return Latin key name when base layout key is present", () => {
			// 设置Kitty解释偏好true。
			setKittyProtocolActive(true);
			// Cyrillic ctrl+с with base layout 'c'
			// 主1089、空shifted、base99、Ctrl传输值5组合成测试报文。
			const cyrillicCtrlC = "\x1b[1089::99;5u";
			// 输出规范键名ctrl+c，直接比较文字而不是只测可否匹配。
			assert.strictEqual(parseKey(cyrillicCtrlC), "ctrl+c");
			// 正常结束复位false。
			setKittyProtocolActive(false);
		});

		// 已识别拉丁主k即使basev也返回ctrl+k；主码点优先规则防止重排布局误报。
		it("should prefer codepoint for Latin letters when base layout differs", () => {
			// 启用本条模式偏好。
			setKittyProtocolActive(true);
			// Dvorak Ctrl+K reports codepoint 'k' (107) and base layout 'v' (118)
			// 107为k，118为备用v，修饰5是Ctrl。
			const dvorakCtrlK = "\x1b[107::118;5u";
			// 准确要求ctrl+k，不只断言结果非空。
			assert.strictEqual(parseKey(dvorakCtrlK), "ctrl+k");
			// 正常复位false。
			setKittyProtocolActive(false);
		});

		// 已识别主符号/也优先于base[，测试解析名字而非布尔匹配。
		it("should prefer codepoint for symbol keys when base layout differs", () => {
			// 启用Kitty模式解释偏好。
			setKittyProtocolActive(true);
			// Dvorak Ctrl+/ reports codepoint '/' (47) and base layout '[' (91)
			// 主47是/、base91是[，Ctrl值5不变。
			const dvorakCtrlSlash = "\x1b[47::91;5u";
			// 规范返回ctrl+/，不能被base改写为ctrl+[。
			assert.strictEqual(parseKey(dvorakCtrlSlash), "ctrl+/");
			// 正常复位模块状态。
			setKittyProtocolActive(false);
		});

		// 没有备用字段时直接按主c与Ctrl修饰命名，证明base不是必填条件。
		it("should return key name from codepoint when no base layout", () => {
			// 设置true准备本条场景。
			setKittyProtocolActive(true);
			// 紧凑CSI-u只有99和修饰5，没有shifted/base部分。
			const latinCtrlC = "\x1b[99;5u";
			// 应直接得到ctrl+c。
			assert.strictEqual(parseKey(latinCtrlC), "ctrl+c");
			// 正常收尾置false。
			setKittyProtocolActive(false);
		});

		// 大写E加Shift归一成shift+e，分别核匹配与解析；不同于可打印解码返回真实大写E。
		it("should parse shifted uppercase CSI-u letters as shift+letter", () => {
			// 为该回调设置Kitty解释偏好。
			setKittyProtocolActive(true);
			// 主码点69结合Shift2传输值，匹配以小写e表示的键身份。
			assert.strictEqual(matchesKey("\x1b[69;2u", "shift+e"), true);
			// 解析结果也用小写键名加shift+前缀。
			assert.strictEqual(parseKey("\x1b[69;2u"), "shift+e");
			// 正常结束关闭标志。
			setKittyProtocolActive(false);
		});

		// 不支持的修饰位不得悄悄被丢掉生成近似键名；这个样例只测解析返回undefined。
		it("should ignore Kitty CSI-u with unsupported modifiers", () => {
			// 启用模式偏好，不影响支持位集合本身。
			setKittyProtocolActive(true);
			// 线路17减1得掩码16，该位不在本实现Shift/Alt/Ctrl/Super支持集合，故不能格式化成键名。
			assert.strictEqual(parseKey("\x1b[99;17u"), undefined);
			// 正常复位false。
			setKittyProtocolActive(false);
		});
	});

	// 旧编码规范化组检查控制字节、特殊键、方向与固定功能串；模式相关样例借用前面的false正常复位，不为每条都建隔离状态。
	describe("Legacy key parsing", () => {
		// 旧Ctrl字母用ASCII低控制位反推字母，ETX/EOT分别为c/d，不触发真实信号/退出。
		it("should parse legacy Ctrl+letter", () => {
			// 显式设false作为这组旧编码的起点。
			setKittyProtocolActive(false);
			// 0x03解析为ctrl+c。
			assert.strictEqual(parseKey("\x03"), "ctrl+c");
			// 0x04解析为ctrl+d。
			assert.strictEqual(parseKey("\x04"), "ctrl+d");
		});

		// 合并检查特殊字符与普通数字/符号：键名字串和文字解码有区别，也用matchesKey核普通基键；这条未独立设置Kitty标志。
		it("should parse special keys", () => {
			// 单ESC规范为escape。
			assert.strictEqual(parseKey("\x1b"), "escape");
			// 制表字符\t规范为tab，不返回含Tab控制字符的文字。
			assert.strictEqual(parseKey("\t"), "tab");
			// 回车\r规范为enter。
			assert.strictEqual(parseKey("\r"), "enter");
			// 当前旧模式下LF也规范为enter；Kitty true的相反行为已在前面单测。
			assert.strictEqual(parseKey("\n"), "enter");
			// NUL规范为ctrl+space，不当作普通正文。
			assert.strictEqual(parseKey("\x00"), "ctrl+space");
			// 单个空格的键名为space。
			assert.strictEqual(parseKey(" "), "space");
			// 普通数字1解析成同样的字符串"1"。
			assert.strictEqual(parseKey("1"), "1");
			// 普通数字输入与同名数字KeyId匹配。
			assert.strictEqual(matchesKey("1", "1"), true);
			// 普通+解析成+；解析器允许它作为基键，不误当成残缺修饰连接符。
			assert.strictEqual(parseKey("+"), "+");
			// 同一普通+也可按+基键匹配。
			assert.strictEqual(matchesKey("+", "+"), true);
		});

		// 四个CSI方向串应各返回规范方向名字，回调没有调用任何光标移动接口。
		it("should parse arrow keys", () => {
			// CSI A解析为up。
			assert.strictEqual(parseKey("\x1b[A"), "up");
			// CSI B解析为down。
			assert.strictEqual(parseKey("\x1b[B"), "down");
			// CSI C解析为right。
			assert.strictEqual(parseKey("\x1b[C"), "right");
			// CSI D解析为left。
			assert.strictEqual(parseKey("\x1b[D"), "left");
		});

		// SS3方向与Home/End有固定兼容映射，和前面布尔匹配用例对应。
		it("should parse SS3 arrows and home/end", () => {
			// SS3 A规范为up。
			assert.strictEqual(parseKey("\x1bOA"), "up");
			// SS3 B规范为down。
			assert.strictEqual(parseKey("\x1bOB"), "down");
			// SS3 C规范为right。
			assert.strictEqual(parseKey("\x1bOC"), "right");
			// SS3 D规范为left。
			assert.strictEqual(parseKey("\x1bOD"), "left");
			// SS3 H规范为home。
			assert.strictEqual(parseKey("\x1bOH"), "home");
			// SS3 F规范为end。
			assert.strictEqual(parseKey("\x1bOF"), "end");
		});

		// 混合旧功能/修饰映射抽样验证规范名字，clear/insert/up只是返回文字，没有执行相应UI动作。
		it("should parse legacy function and modifier sequences", () => {
			// SS3 P规范为f1。
			assert.strictEqual(parseKey("\x1bOP"), "f1");
			// CSI24~规范为f12。
			assert.strictEqual(parseKey("\x1b[24~"), "f12");
			// CSI E规范为clear。
			assert.strictEqual(parseKey("\x1b[E"), "clear");
			// rxvt CSI2^规范为ctrl+insert。
			assert.strictEqual(parseKey("\x1b[2^"), "ctrl+insert");
			// ESC+p的特殊旧映射返回alt+up，不是普通Alt+P。
			assert.strictEqual(parseKey("\x1bp"), "alt+up");
		});

		// 双左方括号形式是旧PageUp别名，与通常CSI5~不同，固定表应仍接受。
		it("should parse double bracket pageUp", () => {
			// ESC[[5~整体解析为pageUp，不把额外[当成普通插入字符。
			assert.strictEqual(parseKey("\x1b[[5~"), "pageUp");
		});
	});
});
