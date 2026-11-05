// 检查 ESC 等待配置、Shift+Enter 正规化、键盘/程序状态协商以及标题/进度/尺寸接口。assert.equal 使用宽松比较，deepEqual 递归比较结构；两者都不同于对应 strict API，例如不能单靠 equal 区分数字80与字符串80。
// 纯函数用例只传字符串/环境对象；协商夹具替换 stdout.write/stdin.on，但 cleanup 的真实 stop 仍会 pause stdin、在可用时 setRawMode，不是完全隔离系统终端的假对象。
// 标题/进度用例单独拦截输出；构造 ProcessTerminal 不调用 start，但非空 PI_TUI_WRITE_LOG 会让其字段初始化尝试 stat 日志路径。
import assert from "node:assert";
// describe/it 声明测试组/用例；mock.timers 用虚拟时间同步触发选定的定时器，不能当作真实经过了相应毫秒。
import { describe, it, mock } from "node:test";
// 设置 keys 模块共享协议标志，cleanup 固定设 false，不恢复任意之前的 true 值。
import { setKittyProtocolActive } from "../src/keys.ts";
// 从真实终端实现导入三个纯计算入口及 ProcessTerminal 类；导入/构造不等于 start 接管输入。
import {
	// Apple 兼容包装器把传入的终端布尔标记作为正规化开关，本身不检测本机品牌。
	normalizeAppleTerminalInput,
	// 按“候选回车、开关、外部 Shift 结果”改写字符串，不查询原生修饰键。
	normalizeNativeShiftEnterInput,
	// 实际进程终端类；这些测试会绕过 TS private 调用部分协商方法。
	ProcessTerminal,
	// 从提供的环境对象计算 ESC 等待毫秒数，无需连接 SSH。
	resolveEscapeTimeoutMs,
} from "../src/terminal.ts";

// ESC 超时配置组只检查解析返回值，没有真的等待或更改 process.env；配置优先于 SSH 提示。
describe("resolveEscapeTimeoutMs", () => {
	// 有效80ms配置应直接采用，即使同时存在 SSH 环境线索。
	it("uses PI_TUI_ESC_TIMEOUT when configured", () => {
		// 字符串80转为有限正数80，单位毫秒。
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "80" }), 80);
		// SSH_TTY 只是普通对象字段；明确配置80仍优先，不建立 SSH 连接。
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "80", SSH_TTY: "/dev/pts/1" }), 80);
	});

	// 四种固定无效配置应回退本地10ms；不穷举 NaN/Infinity/小数等所有数值形式。
	it("ignores invalid PI_TUI_ESC_TIMEOUT values", () => {
		// 非数字 abc 转换失败，回退10。
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "abc" }), 10);
		// 0 不满足大于0，回退10。
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "0" }), 10);
		// 负数-5不接受。
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "-5" }), 10);
		// 空串转数字0，仍按无效配置回退。
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "" }), 10);
	});

	// 没有有效显式配置而有任一 SSH 标记时取100ms；标记只做真值判断。
	it("defaults to 100ms over SSH", () => {
		// 仅 SSH_CONNECTION 有值就选择远程等待窗口，内容不要求真是完整连接描述。
		assert.equal(resolveEscapeTimeoutMs({ SSH_CONNECTION: "10.0.0.1 22" }), 100);
		// 仅 SSH_TTY 也可触发100ms。
		assert.equal(resolveEscapeTimeoutMs({ SSH_TTY: "/dev/pts/1" }), 100);
	});

	// 空环境对象没有任何配置/SSH线索，应使用本地10ms。
	it("defaults to 10ms otherwise", () => {
		// 传 {} 而非缺省参数，不读取真实 process.env。
		assert.equal(resolveEscapeTimeoutMs({}), 10);
	});
});

// 通用 Shift+Enter 组：真实函数只使用传入的两个布尔值，不调用 native helper 或向终端输出。
describe("normalizeNativeShiftEnterInput", () => {
	// 开关为真且 Shift 按下，单独 CR 应变成明确的 CSI-u Shift+Enter 字符串。
	it("rewrites Return to CSI-u Shift+Enter when native Shift detection is enabled and Shift is pressed", () => {
		// \r 是回车，13 是回车码点、修饰值2表示 Shift；检查返回串，不发送控制码。
		assert.equal(normalizeNativeShiftEnterInput("\r", true, true), "\x1b[13;2u");
	});

	// 历史 ESC+CR 形式同样可补认，但两种必要条件任一缺失时应原样返回；覆盖 #11559 的字符串形状。
	it("rewrites ESC+CR to CSI-u Shift+Enter when Shift is pressed", () => {
		// #11559
		// 候选 ESC+CR、检测开启、Shift按下，返回同一个标准 CSI-u。
		assert.equal(normalizeNativeShiftEnterInput("\x1b\r", true, true), "\x1b[13;2u");
		// 开关虽开启但 Shift 未按下，不能把 Alt+Enter 误改成 Shift+Enter。
		assert.equal(normalizeNativeShiftEnterInput("\x1b\r", true, false), "\x1b\r");
		// 检测被关闭时，即使外部报告 Shift 按下也不改写。
		assert.equal(normalizeNativeShiftEnterInput("\x1b\r", false, true), "\x1b\r");
	});

	// 开关 false 优先阻止 CR 补认，检查检测关闭路径。
	it("leaves Return unchanged when native Shift detection is disabled", () => {
		// 原 CR 保持原样，不查询键盘当前状态。
		assert.equal(normalizeNativeShiftEnterInput("\r", false, true), "\r");
	});

	// 没有 Shift 时 CR 仍为普通回车，不能只因开关开启就改写。
	it("leaves Return unchanged when Shift is not pressed", () => {
		// true/false 分别代表启用检测和未按 Shift。
		assert.equal(normalizeNativeShiftEnterInput("\r", true, false), "\r");
	});

	// 只处理 CR/ESC+CR 两种候选，已编码 CSI-u 和普通 a 都不能被再次改写。
	it("leaves non-Return input unchanged", () => {
		// 完整 Shift+Enter CSI-u 本来就明确，保持幂等。
		assert.equal(normalizeNativeShiftEnterInput("\x1b[13;2u", true, true), "\x1b[13;2u");
		// 普通字母 a 原样返回，不受 Shift 布尔值影响。
		assert.equal(normalizeNativeShiftEnterInput("a", true, true), "a");
	});
});

// 旧 Apple 入口转发通用逻辑；第二参数由调用方提供“是否 Apple”，本组没有检查 process.platform 或加载原生模块。
describe("normalizeAppleTerminalInput", () => {
	// Apple 标记 true 与 Shift true 时 CR 正规化。
	it("rewrites Apple Terminal Return to CSI-u Shift+Enter when Shift is pressed", () => {
		// 返回标准 CSI-u Shift+Enter，不代表实际查询到用户正按 Shift。
		assert.equal(normalizeAppleTerminalInput("\r", true, true), "\x1b[13;2u");
	});

	// Apple 标记成立但未按 Shift，应保留 CR。
	it("leaves Apple Terminal Return unchanged when Shift is not pressed", () => {
		// 只检查当前固定输入/布尔组合的返回值。
		assert.equal(normalizeAppleTerminalInput("\r", true, false), "\r");
	});

	// 不是 Apple 的调用方标记应关闭该包装器补认，即使 Shift 为真。
	it("leaves non-Apple Terminal Return unchanged when Shift is pressed", () => {
		// false/true 组合仍返回原 CR。
		assert.equal(normalizeAppleTerminalInput("\r", false, true), "\r");
	});

	// 非候选输入在 Apple 包装入口也原样保留，避免二次转换。
	it("leaves non-Return input unchanged", () => {
		// 已有明确 CSI-u 保持不变。
		assert.equal(normalizeAppleTerminalInput("\x1b[13;2u", true, true), "\x1b[13;2u");
		// 普通 a 保持不变。
		assert.equal(normalizeAppleTerminalInput("a", true, true), "a");
	});
});

// 协商组用捕获的 stdin data 回调手工送回复，检查协议状态/输出顺序；未调用公开 start，但 stop 仍有真实 stdin 暂停/raw 恢复副作用。
// setup 时的输出拦截不是通用流模拟，不实现写回调、背压或完整 EventEmitter 契约，适用于这里固定调用形状。
describe("ProcessTerminal Kitty keyboard protocol negotiation", () => {
	// type 定义夹具返回形状，只供编译期核对，不创建对象或验证字段。
	type NegotiationHarness = {
		// 实际 ProcessTerminal 实例，可读协商状态。
		terminal: ProcessTerminal;
		// 记录每次 stdout.write 的字符串数组，内容可继续追加。
		writes: string[];
		// send 同步把片段交捕获的 dataHandler，不向真实 stdin 写数据。
		send(data: string): void;
		// 读取业务最后收到的一条输入；尚未收到时 undefined，不是全部输入历史。
		getInput(): string | undefined;
		// 清理本实例并恢复拦截函数，返回 void；并非所有真实 stdin 状态都由夹具保存恢复。
		cleanup(): void;
	};

	// 建立一次协商夹具：创建终端→替换输出/订阅→安装业务回调→直接发协商→返回控制接口。
	// 例如 send(ESC[?7u) 驱动真实解析器，getInput 检查回复是否被吞掉；setup 自己未包统一回滚，若返回前抛错，调用方的 try 尚未开始。
	function setupNegotiation(): NegotiationHarness {
		// new 只初始化实例字段；可能按 PI_TUI_WRITE_LOG stat 路径，不调用 start 的 raw/resume/resize/信号逻辑。
		const terminal = new ProcessTerminal();
		// 新数组收本次夹具输出，不写真实 stdout。
		const writes: string[] = [];
		// 最后一条业务输入初始 undefined；后面每次回调覆盖，并非累积。
		let input: string | undefined;
		// 可选函数类型用括号包箭头后再与 undefined 联合，表示处理器尚未被捕获。
		let dataHandler: ((data: string) => void) | undefined;
		// 幂等清理标志，初始尚未清理。
		let cleaned = false;
		// 保存真实 stdout.write 函数引用，稍后恢复。
		const previousWrite = process.stdout.write;
		// 保存真实 stdin.on 引用，不复制其它流方法或监听器状态。
		const previousOn = process.stdin.on;

		// 把 stdout.write 换成只接首参数的箭头；这是赋函数，不是此时就执行输出。
		process.stdout.write = ((chunk: string | Uint8Array) => {
			// String(chunk) 收集文本形态；若真传任意 Uint8Array，这并非通用 Buffer 文本解码保证。
			writes.push(String(chunk));
			// 固定 true 表示不施加背压；没有执行 write 的可选完成回调。
			return true;
			// as typeof process.stdout.write 仅把简化替身视作原方法类型，不会自动实现其全部重载。
		}) as typeof process.stdout.write;
		// 拦截 on 而非真实注册事件；event 可以是 string/symbol，listener 的 rest 参数类型 unknown[] 不预设事件载荷。
		process.stdin.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			// 只保留 data 监听器并断言为收 string 的函数；该类型转换不检查运行时函数签名。
			if (event === "data") dataHandler = listener as (data: string) => void;
			// 返回 stdin 维持链式调用外形，其他事件请求在替身中不会真注册。
			return process.stdin;
			// 同样用类型查询/断言匹配原 on 方法，运行时依旧是简化闭包。
		}) as typeof process.stdin.on;

		// 括号允许把跨行类型断言后的对象当赋值目标；下面仍是一个属性赋值表达式。

		// 经 unknown 越过类的 private 限制，声明测试知道这些内部成员存在，不产生运行时校验。
		(
			terminal as unknown as {
				// 业务输入回调为可选字段，本赋值马上提供它。
				inputHandler?: (data: string) => void;
				// 描述私有协商方法形状，仅供该断言对象使用，不是在类型里执行它。
				queryAndEnableKittyProtocol(): void;
			}
		).inputHandler =
			// 安装收输入的箭头函数；收到被转发的序列时才执行函数体。
			(data) => {
				// 记录最后一次转发值，终端回复若被消费就不会改这个变量。
				input = data;
			};
		// 直接调用私有协商：真实创建 StdinBuffer/增加 DA 欠账并发查询；stdin.on/stdout.write 此时均已被替换。
		(terminal as unknown as { queryAndEnableKittyProtocol(): void }).queryAndEnableKittyProtocol();

		// 返回新对象，字段简写保留实例/记录数组，方法闭包共享上面局部状态。
		return {
			// 暴露同一终端实例，不克隆。
			terminal,
			// 暴露同一写记录数组，cleanup 的协议输出也会继续追加在这里。
			writes,
			// 同步送一块测试数据，返回 void；例如分两次 send 可覆盖分片回复，解析错误会向调用方传播。
			send(data: string): void {
				// 可选调用：尚没捕获 data 处理器时静默跳过，不向系统输入注入数据。
				dataHandler?.(data);
			},
			// 返回最后一次业务输入或 undefined，无状态修改；不能用来推断全部曾转发事件数量。
			getInput(): string | undefined {
				// 直接读取闭包变量。
				return input;
			},
			// 最多尝试一次 stop，然后 finally 恢复两种替身和全局协议 false；stop 抛错仍传播。
			// stop 的 stdin.pause/setRawMode 没有被本夹具替换，wasRaw 也没经公开 start 保存；因此不要把 cleanup 当纯内存清理。
			cleanup(): void {
				// 第二次调用立即返回，支持用例正常段清一次、finally 再清一次。
				if (cleaned) return;
				// 在真正 stop 前先标记已清理，若 stop 失败后续也不会重试。
				cleaned = true;
				// 只对 stop 阶段提供 finally 复原，不覆盖上面的 setup 步骤。
				try {
					// 真实停止会发模式复位（当前被记录）、销毁解析缓存/计时器、卸内部监听，还会暂停实际 stdin 并可能改 raw。
					terminal.stop();
					// 即使 stop 抛错，也尝试恢复下列函数；这些语句不是各自独立 finally。
				} finally {
					// 把 stdout.write 放回保存的函数。
					process.stdout.write = previousWrite;
					// 把 stdin.on 放回保存的函数，未恢复 pause/raw 等流状态。
					process.stdin.on = previousOn;
					// 把共享键解释标志固定清 false，不保存之前标志。
					setKittyProtocolActive(false);
				}
			},
		};
	}

	// 尚无回复时，应先请求 Kitty/状态探测并以 DA1 收尾，不立即开 modifyOtherKeys；断言初始发送串和本地标志。
	it("queries Kitty mode before enabling modifyOtherKeys fallback", () => {
		// 建立夹具，setup 在 try 之前，构造/安装失败不受下面 finally 保护。
		const harness = setupNegotiation();
		// setup 成功后的断言由 cleanup finally 收尾。
		try {
			// 请求7=1|2|4标志，再查当前 Kitty、问OSC7501、最后DA1；这里默认假定 PI_PROGRAM_STATUS 不是强制1/0。
			assert.equal(harness.writes[0], "\x1b[>7u\x1b[?u\x1b]7501;?\x1b\\\x1b[c");
			// 还没任何确认/DA哨兵时不发送后备开启码。
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
			// 发过查询不等于 Kitty 已确认，访问器仍 false。
			assert.equal(harness.terminal.kittyProtocolActive, false);
			// 无论断言结果如何，都尝试清理夹具。
		} finally {
			// 注意该清理包含未 mock 的 stdin.pause/可选 raw 操作。
			harness.cleanup();
		}
	});

	// 收到非零flags7后本地 Kitty 激活，回复不交业务；正常段先清理以检查弹栈恰一次，finally 重复调用应无额外动作。
	it("activates Kitty mode for non-zero negotiated flags", () => {
		// 新夹具的 input 尚未收到数据。
		const harness = setupNegotiation();
		// 用 finally 清理已建夹具。
		try {
			// 手工送完整 Kitty 回复；这是字符串解析，不是终端真正协商的回执。
			harness.send("\x1b[?7u");

			// 协商回复应被本层消费，业务 input 保持 undefined。
			assert.equal(harness.getInput(), undefined);
			// 实例激活标记变 true，代码只要求非零而不验证包含所有期望位。
			assert.equal(harness.terminal.kittyProtocolActive, true);
			// Kitty 已确认，不该开启后备增强。
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
			// 此前从没启用后备，也无需发送后备关闭码。
			assert.equal(harness.writes.includes("\x1b[>4;0m"), false);

			// 主动清理以把 stop 的协议输出也纳入记录。
			harness.cleanup();
			// filter 数出恰好一条 Kitty 弹栈码，不比较它在所有输出中的精确索引。
			assert.equal(harness.writes.filter((write) => write === "\x1b[<u").length, 1);
			// 停止也不应多发从未开启的后备关闭码。
			assert.equal(harness.writes.includes("\x1b[>4;0m"), false);
			// 断言中途失败仍有最后清理机会。
		} finally {
			// 若前面已清过则 cleaned 门禁使本次直接返回。
			harness.cleanup();
		}
	});

	// 零 Kitty 标志意味着未确认增强，应该只开启一次 modifyOtherKeys；清理后再检查恰一次关闭。
	it("falls back to modifyOtherKeys for zero Kitty flags", () => {
		// 建立独立状态的夹具。
		const harness = setupNegotiation();
		// 后续通过 finally 保证尝试收尾。
		try {
			// 完整 flags0 回复触发后备，不是把0当成激活。
			harness.send("\x1b[?0u");

			// 回复不转为用户键盘输入。
			assert.equal(harness.getInput(), undefined);
			// Kitty 激活仍 false。
			assert.equal(harness.terminal.kittyProtocolActive, false);
			// 后备级别2开启码恰出现一次，防重复启用。
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;2m").length, 1);

			// 清理使 stop 关闭已开启的后备。
			harness.cleanup();
			// 关闭码恰好一条；记录检查仍可在 stdout 方法已恢复后读内存数组。
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;0m").length, 1);
			// 无论后面断言成败，再尝试幂等清理。
		} finally {
			// 第二次清理不会重复 stop。
			harness.cleanup();
		}
	});

	// 没有 Kitty flags、先收到 DA1 时启用后备；DA1 作为协商尾部哨兵，不代表其中数字已证明后备级别可用。
	it("falls back to modifyOtherKeys for device attributes without Kitty flags", () => {
		// 新夹具已登记一份 DA1 欠账。
		const harness = setupNegotiation();
		// 受 finally 保护。
		try {
			// 送设备属性回复，数字载荷只作报文示例。
			harness.send("\x1b[?62;4;52c");

			// 属于本协商欠账的 DA1 被吞掉。
			assert.equal(harness.getInput(), undefined);
			// 没有非零 Kitty 确认，仍未激活。
			assert.equal(harness.terminal.kittyProtocolActive, false);
			// 开启一次后备增强，不等待第二种回执。
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;2m").length, 1);
			// 最后尝试清理。
		} finally {
			// 恢复拦截方法及协议标志，同时有真实 stdin 停止副作用。
			harness.cleanup();
		}
	});

	// DA1 只消费键盘查询欠账，后来的同格式回复应交上层颜色查询等处理；检查不是把所有 DA1 都吞掉。
	it("forwards device attributes replies that answer other queries", () => {
		// 建立有一份 DA欠账的夹具。
		const harness = setupNegotiation();
		// try/finally 确保正常建立后清理。
		try {
			// 先确认 Kitty7，使后面 DA1 不触发后备。
			harness.send("\x1b[?7u");
			// 第一条 DA1 抵掉唯一键盘查询欠账。
			harness.send("\x1b[?62;4;52c");
			// 这两条终端回复都不进入业务 input。
			assert.equal(harness.getInput(), undefined);

			// The TUI's color query uses DA1 as its own sentinel.
			// 再送同样 DA1，当前键盘欠账已为0，必须转发而非消费。
			harness.send("\x1b[?62;4;52c");
			// 最后业务输入正是第二条 DA1 原文；不模拟真正颜色查询对象。
			assert.equal(harness.getInput(), "\x1b[?62;4;52c");
			// 始终收尾。
		} finally {
			// 清理夹具，未保存恢复任意之前的 stdin 流动状态。
			harness.cleanup();
		}
	});

	// 等待协商期间普通 a 仍应立即转发，不被启动流程阻塞；Kitty标记仍未确认。
	it("forwards normal input while waiting for Kitty response", () => {
		// 建立等待回复的夹具。
		const harness = setupNegotiation();
		// 用 finally 收尾。
		try {
			// 送普通 ASCII a，不会触发原生 Shift 检测候选。
			harness.send("a");

			// 业务立即得到 a。
			assert.equal(harness.getInput(), "a");
			// 普通文字不能冒充能力确认。
			assert.equal(harness.terminal.kittyProtocolActive, false);
			// 断言后总会尝试清理。
		} finally {
			// 执行夹具清理。
			harness.cleanup();
		}
	});

	// Kitty 回复先到未结束前缀，虚拟前进10ms仍不交业务，再补u后激活；本例没有先超过50ms分段超时，因此主要验证 StdinBuffer 跨输入拼接。
	it("tracks split Kitty confirmation", () => {
		// 只 mock setTimeout（及相应清理），tick 不是真睡眠，也不把 Date 等全部时钟都模拟。
		mock.timers.enable({ apis: ["setTimeout"] });
		// 模拟时钟开启后才建解析器，使其后续 timeout 被该时钟接管；setup 仍在 try 之前。
		const harness = setupNegotiation();
		// 断言阶段由 finally 清理夹具再还原 mock。
		try {
			// 缺u的 CSI 前缀暂存到 StdinBuffer，不是立即被当键。
			harness.send("\x1b[?7");
			// 只虚拟经过10ms，尚未到普通不完整序列50ms超时；不是孤立ESC的10ms路径。
			mock.timers.tick(10);

			// 半截回复尚未转发给业务。
			assert.equal(harness.getInput(), undefined);

			// 补结束u，和此前前缀拼成完整flags7回复。
			harness.send("u");

			// 完整回复现在使本地激活标志为真。
			assert.equal(harness.terminal.kittyProtocolActive, true);
			// 没有走后备开启路径。
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
			// 按顺序清理解析器/协议，再复原全局定时器模拟。
		} finally {
			// stop 会清 StdinBuffer/回复片段计时器，但也保留其真实stdin副作用。
			harness.cleanup();
			// 恢复 mock timers；若上一句 cleanup 自身抛错，这句没有独立 finally 保护。
			mock.timers.reset();
		}
	});

	// #10607
	// OSC7501程序状态子组把支持性回复和 DA1 哨兵按顺序送给同一个真实解析器，检查延迟上报、显式覆盖与重启欠账；不实际询问用户终端。
	describe("program status (OSC 7501)", () => {
		// 预期 working 报文：根状态 working、程序名 pi，以 ST 结束；const 只是保存字符串。
		const working = "\x1b]7501;state=working:app=pi\x1b\\";
		// 预期 clear 报文只含清除状态，stop 在已支持且有保存状态时会发送它。
		const clear = "\x1b]7501;state=clear\x1b\\";

		// 同步临时设置/删除 PI_PROGRAM_STATUS 后运行 fn，finally 恢复旧值，返回 void；例如 undefined 让协商走自动查询。
		// 参数 string|undefined 表达可删除，fn 的 void 不等待异步工作；这里所有回调同步。设置步骤在 try 前，设置本身异常不由下面 finally 覆盖。
		function withOverride(value: string | undefined, fn: () => void): void {
			// 保存原值，区分缺失与空字符串。
			const previous = process.env.PI_PROGRAM_STATUS;
			// undefined 真正删除变量，让代码不视作1或0覆盖。
			if (value === undefined) delete process.env.PI_PROGRAM_STATUS;
			// 其他字符串原样赋值，不在 fixture 里解释支持性。
			else process.env.PI_PROGRAM_STATUS = value;
			// 应用覆盖后才进入受保护的回调范围。
			try {
				// 同步执行回调；不捕获异常为测试成功，finally 后仍传播。
				fn();
				// 正常结束或同步抛错都恢复。
			} finally {
				// 原先不存在就删除。
				if (previous === undefined) delete process.env.PI_PROGRAM_STATUS;
				// 原先有值则恢复原字符串。
				else process.env.PI_PROGRAM_STATUS = previous;
			}
		}

		// 先保存 working，但未确认时不发；在 DA1 前收到支持回复应补发一次，之后 done 立即发。
		it("reports the latest status once the terminal answers the query before DA", () => {
			// 明确无环境覆盖，保证发送状态能力查询。
			withOverride(undefined, () => {
				// 建立新的协商和捕获输出。
				const harness = setupNegotiation();
				// 用 cleanup finally 收尾夹具。
				try {
					// setProgramStatus 保存传入对象引用；未确认支持时不会立即写出。
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					// 记录中此刻没有 working，检验延迟上报。
					assert.equal(harness.writes.includes(working), false);

					// 手工送 ST 结束的支持性回复，尚在 pending 窗口内，应标支持并补发最新状态。
					harness.send("\x1b]7501;?\x1b\\");
					// 支持性回复不应作为业务输入。
					assert.equal(harness.getInput(), undefined);
					// working 恰好发一次，不能因为保存和确认各发一遍。
					assert.equal(harness.writes.filter((write) => write === working).length, 1);
					// 再送对应 DA1 结束协商欠账，不撤销此前已确认的支持标志。
					harness.send("\x1b[?62;4;52c");

					// 确认后设 done，可直接编码发送，不需新查询。
					harness.terminal.setProgramStatus({ state: "done" });
					// .at(-1) 取最后一次 write，要求精确 done 报文；空记录会得 undefined 使断言失败。
					assert.equal(harness.writes.at(-1), "\x1b]7501;state=done\x1b\\");
					// 无论断言成功/异常，都尝试 stop/复原拦截。
				} finally {
					// 清理也可能追加 clear 等输出，此处不再断言它们。
					harness.cleanup();
				}
			});
		});

		// 若唯一 DA1 先到，程序状态 pending 关闭；迟到支持回复仍被吞掉但不提升支持，之后设 working 也不发。
		it("reports nothing when DA arrives first and swallows late replies", () => {
			// 清环境覆盖，进入自动询问模式。
			withOverride(undefined, () => {
				// 建立一份待收 DA欠账。
				const harness = setupNegotiation();
				// 断言范围带清理。
				try {
					// 先送 DA1，抵完欠账，最新状态查询等待结束。
					harness.send("\x1b[?62;4;52c");
					// 支持回复改用 BEL 结束，仍可识别，但已经迟到，不能重开支持窗口。
					harness.send("\x1b]7501;?\x07");
					// 设 working 只保存，不应写出。
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });

					// DA1与迟到支持回复都不交业务输入。
					assert.equal(harness.getInput(), undefined);
					// some 检查是否出现任一实际状态报文，区别于此前发过的 ? 能力查询。
					assert.equal(
						// 只匹配 OSC7501;state= 开头，查询串不属于这个集合。
						harness.writes.some((write) => write.startsWith("\x1b]7501;state=")),
						// 预期 false，即没有任何 working/done/clear 等状态发送发生在这些断言之前。
						false,
					);
					// 收尾夹具。
				} finally {
					// stop 此时未确认状态支持，因此不会为保存的 working 额外发状态 clear。
					harness.cleanup();
				}
			});
		});

		// 只认明确1/0覆盖：两者都跳过状态询问，1直接允许上报，0禁止；英文 set 不能泛化为“只要有任意值就跳过”。
		it("skips the query when PI_PROGRAM_STATUS is set", () => {
			// 先强制支持，不等终端回复。
			withOverride("1", () => {
				// 建立夹具时读取当前覆盖值1。
				const harness = setupNegotiation();
				// 断言后用 finally 清理。
				try {
					// 首串只有 Kitty 请求和 DA1，没有 OSC7501;? 查询。
					assert.equal(harness.writes[0], "\x1b[>7u\x1b[?u\x1b[c");
					// 强制支持下设 working 会立即写。
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					// 最新一次输出为精确 working 报文。
					assert.equal(harness.writes.at(-1), working);
					// 恢复夹具拦截。
				} finally {
					// 这里 stop 会看到支持且保存 working，因此可以追加 clear。
					harness.cleanup();
				}
			});
			// 再用独立环境范围强制禁用，不能继承上一个夹具状态。
			withOverride("0", () => {
				// 新实例读取覆盖0。
				const harness = setupNegotiation();
				// 受 finally 保护。
				try {
					// 禁用状态上报同样不发能力查询，仍发键盘查询及DA1。
					assert.equal(harness.writes[0], "\x1b[>7u\x1b[?u\x1b[c");
					// 设 working 保存在实例内，但不写出。
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					// 整个记录中都不应有 working 状态报文。
					assert.equal(harness.writes.includes(working), false);
					// 始终清理第二个夹具。
				} finally {
					// stop 时无状态支持标记，不发其状态 clear；其它终端模式复位仍可能记录。
					harness.cleanup();
				}
			});
		});

		// 第一次协商没收到DA就停止，再发新查询；旧DA只能抵旧欠账，不能提前结束新轮状态窗口，新的支持回复仍应生效。
		it("does not let a DA reply from before a restart end the new query", () => {
			// 无强制状态覆盖。
			withOverride(undefined, () => {
				// 建立第一次查询，欠账为1。
				const harness = setupNegotiation();
				// 后续重启形状也在同一个 cleanup finally 范围。
				try {
					// 先保存 working，尚未确认不发。
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					// 真实 stop 清支持/输入缓冲等，但 DA欠账和最新状态跨 stop 保留；它也会触实际 stdin.pause/可选raw。
					harness.terminal.stop();
					// 直接再调私有协商，不是公开 start；新建缓冲/捕获监听并把DA欠账加到2，仍保留原 working。
					(harness.terminal as unknown as { queryAndEnableKittyProtocol(): void }).queryAndEnableKittyProtocol();

					// The first start's replies arrive late: its DA, then the second start's reply and DA.
					// 旧一轮 DA 迟到：欠账2→1，不能关闭最新轮 pending。
					harness.send("\x1b[?62;4;52c");
					// 新的状态支持回复在窗口内，确认支持并补发 working。
					harness.send("\x1b]7501;?\x1b\\");
					// 新一轮 DA 抵最后欠账1→0，结束查询但保留支持结果。
					harness.send("\x1b[?62;4;52c");
					// 最新输出仍为 working，说明旧DA没有把新回复判迟到。
					assert.equal(harness.writes.at(-1), working);
					// 三条回复均被协议层消费。
					assert.equal(harness.getInput(), undefined);
					// 最终清理本实例。
				} finally {
					// 先前直接 stop 未改夹具 cleaned 标志，因此这里仍会执行一次 stop 并复原替身。
					harness.cleanup();
				}
			});
		});

		// 支持确认后 stop 应清显示，实例仍记最新状态；停止期间不发，重新协商支持后再次上报。
		// 没有一个独立 stopped 字段门禁控制 setProgramStatus；此处不发是因为 stop 把支持标志重置了。
		it("clears the status on stop and reports it again after restart", () => {
			// 明确自动查询模式。
			withOverride(undefined, () => {
				// 建立夹具。
				const harness = setupNegotiation();
				// 确保最终尝试恢复拦截函数。
				try {
					// 先保存 working。
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					// 支持回复确认后立即补发 working。
					harness.send("\x1b]7501;?\x1b\\");
					// 真实 stop 清状态显示/支持记录及输入资源，但保存 programStatus 对象。
					harness.terminal.stop();
					// 要求记录中出现 clear；未精确检查次数或最后位置。
					assert.ok(harness.writes.includes(clear));

					// Stopped: nothing is written until the restarted terminal confirms support again.
					// 保存已停止时输出条数，作为后面无新写入的基准。
					const writesBeforeRestart = harness.writes.length;
					// 停止后再次设置 working，只更新保存值，因为支持标志 false。
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					// 写入条数保持不变，不表示对象方法在停止时完全不更新内部状态。
					assert.equal(harness.writes.length, writesBeforeRestart);

					// 直接重启私有协商，创建新缓冲并读当前覆盖，等待新的支持确认。
					(harness.terminal as unknown as { queryAndEnableKittyProtocol(): void }).queryAndEnableKittyProtocol();
					// 手工送新的支持性回复，触发重报保存的 working。
					harness.send("\x1b]7501;?\x1b\\");
					// 最新写入应是 working，而不是仅重新查询。
					assert.equal(harness.writes.at(-1), working);
					// 收尾。
				} finally {
					// 夹具清理恢复方法并固定全局协议 false；真实 stdin 状态未完全隔离。
					harness.cleanup();
				}
			});
		});
	});

	// 半截 CSI 先经 StdinBuffer 的50ms序列超时，再由终端协商层额外等150ms；仍没补全就把原前缀交给业务。
	it("replays buffered CSI-prefix input when it is not a Kitty response", () => {
		// 模拟 setTimeout，后面 tick 同步触发到期任务，不真实等待200ms。
		mock.timers.enable({ apis: ["setTimeout"] });
		// 新夹具在虚拟时钟下创建解析器。
		const harness = setupNegotiation();
		// 断言步骤受 finally 保护。
		try {
			// 只送 ESC[，是不完整 CSI，不是单独 ESC。
			harness.send("\x1b[");
			// 虚拟前进50ms，底层冲刷给协商层；协商层认为可能是回复前缀，再安排150ms，尚不交业务。
			mock.timers.tick(50); // StdinBuffer sequence timeout, not the lone-ESC timeout

			// 第一阶段结束后 input 仍 undefined。
			assert.equal(harness.getInput(), undefined);

			// 再虚拟前进150ms，协商缓冲超时应重放原文。
			mock.timers.tick(150);

			// 业务最后得到完整原 ESC[，不是拆成 Escape 与 [ 两次记录。
			assert.equal(harness.getInput(), "\x1b[");
			// 先清夹具再还原时钟。
		} finally {
			// stop 清解析器任务，注意其未模拟的 stdin 副作用。
			harness.cleanup();
			// 还原定时器模拟；cleanup 若同步抛错，本句可能被跳过。
			mock.timers.reset();
		}
	});
});

// 进度组只测试 false 清除接口，拦截 stdout 后不会向真实终端发送控制串，也不启动1秒保活动间隔。
describe("ProcessTerminal progress", () => {
	// 无已有进度也应发一次标准清除 OSC9;4;0+BEL，完整比较记录数组。
	it("writes a valid OSC 9;4 clear sequence", () => {
		// 只构造实例，没有公开 start/stop，非空日志环境仍可能在初始化时 stat。
		const terminal = new ProcessTerminal();
		// 收集输出的独立字符串数组。
		const writes: string[] = [];
		// 保存 stdout.write，finally 原样放回。
		const previousWrite = process.stdout.write;

		// 设置简化写入替身，只接首参数，不实现完成回调或背压；赋值不立即调用。
		process.stdout.write = ((chunk: string | Uint8Array) => {
			// 把收到的一块转换成字符串存入内存。
			writes.push(String(chunk));
			// 固定报告可继续写，不等待 drain。
			return true;
			// 类型断言使简化函数匹配 Node 重载类型，运行时没有补齐原实现。
		}) as typeof process.stdout.write;

		// 实际调用和断言都位于受 finally 保护范围。
		try {
			// false 先取消已有进度间隔（新实例没有），再直接写清除码，不需要先 start。
			terminal.setProgress(false);
			// 数组恰好一条清除串，9;4;0 与协议分隔符/结束 BEL 必须正确。
			assert.deepEqual(writes, ["\x1b]9;4;0\x07"]);
			// 无论断言通过或抛错都恢复输出函数。
		} finally {
			// 不调用 stop，从而不会改真实 stdin 流动/raw 状态。
			process.stdout.write = previousWrite;
		}
	});
});

// 标题组检查连续C0/C1控制符被替成空格，剩余可打印文字继续作为OSC0标题载荷，不测试真实窗口标题显示。
describe("ProcessTerminal title", () => {
	// 输入故意含BEL/ESC/CSI控制以模拟标题注入，输出应仅保留安全文本再包OSC0；stdout替身保证不会实际写剪贴板命令。
	it("replaces control characters so the title cannot end the OSC sequence", () => {
		// 创建实例但不启动终端接管。
		const terminal = new ProcessTerminal();
		// 只记录标题方法生成的输出。
		const writes: string[] = [];
		// 保存原 stdout.write。
		const previousWrite = process.stdout.write;

		// 安装仅收首参数的内存记录回调。
		process.stdout.write = ((chunk: string | Uint8Array) => {
			// String 转换并保存，不向系统stdout透传。
			writes.push(String(chunk));
			// 固定 true，不模拟异步完成。
			return true;
			// typeof 用于类型查询，as 不检查所有重载是否真正实现。
		}) as typeof process.stdout.write;

		// 用 finally 保护标题断言。
		try {
			// 标题含 BEL+ESC、看似 OSC52 剪贴板载荷、另一个BEL和C1 CSI；函数只清控制字符，不把可见 ]52... 整段删掉。
			terminal.setTitle("pi - work\x07\x1b]52;c;Zm9v\x07\u009b2J - repo");
			// 期望连续控制符各段变一个空格，外部仅OSC0+最终BEL；这里只比较串，不打开剪贴板或发CSI清屏。
			assert.deepEqual(writes, ["\x1b]0;pi - work ]52;c;Zm9v 2J - repo\x07"]);
			// 抛错也恢复原输出方法。
		} finally {
			// 恢复后没有额外 stop，因此不改真实输入模式。
			process.stdout.write = previousWrite;
		}
	});
});

// 尺寸组临时覆盖本进程 stdout 的尺寸属性与环境变量，检查优先环境回退；不更改真实终端窗口。
describe("ProcessTerminal dimensions", () => {
	// 把 stdout 尺寸设 undefined 后应采用COLUMNS123/LINES45；本项不另测试默认80/24、非法值或stdout有效值优先。
	it("falls back to COLUMNS and LINES before default dimensions", () => {
		// 保存原 columns 属性描述符，既包含值也可能包含getter及可配置/可写标志；可能原本没有自有属性。
		const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		// 同样保存 rows 描述符。
		const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		// 保存环境列数字符串或 undefined。
		const previousColumns = process.env.COLUMNS;
		// 保存环境行数。
		const previousLines = process.env.LINES;

		// 覆盖/读取与断言整个范围由 finally 恢复；没有真实 resize 调用。
		try {
			// 将 columns 的自有值改 undefined 并允许之后恢复/删除，制造不能从 stdout 取尺寸的情形。
			Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			// rows 同样设为 undefined；不代表用户真实终端已变为零行。
			Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
			// 环境值是字符串123，由 getter 用 Number 转成数字。
			process.env.COLUMNS = "123";
			// 环境行数设45。
			process.env.LINES = "45";

			// 构造终端并读取 getter，不 start，不发送尺寸刷新信号。
			const terminal = new ProcessTerminal();

			// 列数字getter跳过stdout假值，取环境123。
			assert.equal(terminal.columns, 123);
			// 行数字getter独立回退为45。
			assert.equal(terminal.rows, 45);
			// 不论属性覆盖、构造或断言哪步失败，都按保存信息尝试恢复；某恢复步骤抛错不会自动补跑后续步骤。
		} finally {
			// 原本有自有 columns 属性时恢复完整描述符。
			if (previousColumnsDescriptor) {
				// 不会仅恢复数字值而丢失原getter/属性标志。
				Object.defineProperty(process.stdout, "columns", previousColumnsDescriptor);
				// 原本没有自有属性，则移除本项临时创建的属性。
			} else {
				// Reflect.deleteProperty 返回boolean，这里未检查；属性已设 configurable:true 可正常删除。
				Reflect.deleteProperty(process.stdout, "columns");
			}
			// rows 原有自有属性则恢复。
			if (previousRowsDescriptor) {
				// 原样还原其描述符。
				Object.defineProperty(process.stdout, "rows", previousRowsDescriptor);
				// 否则删除临时 rows 自有属性。
			} else {
				// 只改本进程对象，不调整OS窗口。
				Reflect.deleteProperty(process.stdout, "rows");
			}
			// 原环境 COLUMNS 缺失与空串要分开处理。
			if (previousColumns === undefined) {
				// 缺失就删除临时环境值。
				delete process.env.COLUMNS;
				// 存在时恢复原字符串。
			} else {
				// 把旧列环境放回。
				process.env.COLUMNS = previousColumns;
			}
			// 同样检查原 LINES 是否缺失。
			if (previousLines === undefined) {
				// 原本不存在则删除。
				delete process.env.LINES;
				// 原本存在就恢复。
			} else {
				// 把旧行环境放回；本 fixture 不影响父 shell 的环境变量。
				process.env.LINES = previousLines;
			}
		}
	});
});
