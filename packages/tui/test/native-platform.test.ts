// 验证平台扩展的三类边界：Linux ARM64预构建ELF的装载段对齐、真实平台剪贴板API、以及用假模块模拟Linux DISPLAY恢复。
// 其中Windows写读用例会替换系统剪贴板，平台直连用例会真正加载原生扩展；它们与最后的内存mock测试副作用不同。
// strict版assert的equal使用严格相等，失败抛错交Node测试器；首例仅读Linux二进制构建产物，不修改、加载或重编译它。
import assert from "node:assert/strict";
// 同步读仓库内预构建文件为Buffer；这一步只取字节，不通过require执行该.node模块。
import { readFileSync } from "node:fs";
// createRequire为ESM取得CommonJS加载器/缓存；Module可构造测试缓存项，构造它本身不会执行原生代码。
import { createRequire, Module } from "node:module";
// test注册名字、选项及测试回调；skip满足时不运行回调，但注册选项表达式仍在模块求值时计算。
import { test } from "node:test";
// 把file: URL转为本机绝对路径，供require.cache按相同模块路径键注入。
import { fileURLToPath } from "node:url";
// 导入的平台模块此刻只创建require与Map；实际get调用才可能加载addon，getText/getImage才可能开始读剪贴板。
import { getNativeClipboard, getNativePlatformHelper } from "../src/native-platform.ts";

// 无参数同步测试：读固定ARM64产物→核ELF魔数→按ELF64小端布局遍历程序头→检查PT_LOAD段64KiB同余/对齐。
// 例虚拟地址减文件偏移须是65536倍数；断言这些静态字段，不在64KiB页Linux上实际加载，也不是完整ELF合法性验证。
test("Linux ARM64 prebuild supports 64 KB system pages", () => {
	// 同步读取Buffer，文件缺失/权限错误直接导致测试失败，没有自动下载/生成/skip。
	const binary = readFileSync(
		// 相对当前测试模块URL定位Linux ARM64产物，与当前操作系统/进程架构无关，macOS也只读其字节。
		new URL("../native/linux/prebuilds/linux-arm64/linux-platform-x11.node", import.meta.url),
	);
	// subarray取前四字节的视图，toString转文本检查0x7f加ELF；未另外验证ELF类/端序/机器型号等字段。
	assert.equal(binary.subarray(0, 4).toString(), "\x7fELF");
	// 按ELF64小端头从字节32读程序头表偏移，bigint经Number转为数值索引；没有另检验是否超安全整数。
	const offset = Number(binary.readBigUInt64LE(32));
	// 从字节54读每个程序头项的字节数，小端无符号16位。
	const entrySize = binary.readUInt16LE(54);
	// 字节56读取程序头项数量；后面按此数量循环，不自行搜索所有文件字节。
	const count = binary.readUInt16LE(56);
	// 累计PT_LOAD可装载段数量，用let因为循环内会递增。
	let loadSegments = 0;
	// index从0到count-1，遍历每个程序头；并非遍历ELF节表。
	for (let index = 0; index < count; index++) {
		// 首偏移加索引乘条目大小，得到当前项文件位置。
		const entry = offset + index * entrySize;
		// 当前项首4字节是p_type，1为PT_LOAD；continue跳过其他程序头，不退出整个测试。
		if (binary.readUInt32LE(entry) !== 1) continue;
		// 命中一个装载段就计数一次。
		loadSegments++;
		// 按ELF64程序头布局在项内偏移8读p_offset，bigint保留64位整数精度。
		const fileOffset = binary.readBigUInt64LE(entry + 8);
		// 项内偏移16读p_vaddr虚拟地址，不是实际在本进程分配/访问内存。
		const address = binary.readBigUInt64LE(entry + 16);
		// 65536n/0n是bigint字面量；地址减偏移对65536取余为0，要求二者在64KiB页内位置相同。
		assert.equal((address - fileOffset) % 65536n, 0n);
		// 项内偏移48读p_align，要求至少65536；不另检查是否为2的幂或执行动态链接。
		assert.ok(binary.readBigUInt64LE(entry + 48) >= 65536n);
	}
	// 至少遇到一个PT_LOAD，防止空表或全非装载条目使循环断言无意义地通过。
	assert.ok(loadSegments > 0);
});

// Opt in on a Windows test desktop: this replaces the system clipboard contents.
// 注册真实Windows剪贴板回归，回调为async；正常运行会依次覆盖三次文本并读回，结果为Promise<void>，错误拒绝交测试器。
test(
	// 名称表明使用原生入口，但本例未mock命令执行器；具体无命令回退来自getNativeClipboard实现，而非这里额外拦截断言。
	"writes Windows clipboard text through the native helper without command fallbacks",
	// 只有win32且PI_TEST_NATIVE_CLIPBOARD精确为字符串1才执行；逻辑或任一满足就skip，不询问用户桌面状态。
	{ skip: process.platform !== "win32" || process.env.PI_TEST_NATIVE_CLIPBOARD !== "1" },
	// 异步回调无参数，实际读写系统剪贴板；没有保存/恢复原剪贴板内容。
	async () => {
		// 获取平台原生helper，可能同步加载addon；不是内存假剪贴板。
		const clipboard = getNativeClipboard();
		// 可选链要求helper及可选setText方法存在，assert通过后TS允许后续调用。
		assert.ok(clipboard?.setText);
		// 覆盖Unicode混合文本、清空字符串、第二次写入三种输入；for...of顺序执行。
		for (const text of ["clipboard café 日本語", "", "second write"]) {
			// await真正写系统剪贴板，完成后才继续下一步，不是只把函数登记为回调。
			await clipboard.setText(text);
			// 读回文本并严格等于刚写入值，读取失败作为拒绝使测试失败。
			assert.equal(await clipboard.getText(), text);
			// 写文本后期望读图片为null；null表示无图片，区别于不可用undefined。
			assert.equal(await clipboard.getImage(), null);
		}
	},
);

// 注册macOS/Windows直连对象测试：取得helper→检查三方法形状→检查同一缓存对象身份；不调用它们读写内容。
test(
	// 测试名是接口身份预期，不表示自动创建跨平台统一后备实现。
	"uses the native platform helper directly as the clipboard API",
	// 只有darwin/win32且进程架构arm64/x64才执行；其他平台/架构skip。
	{ skip: !["darwin", "win32"].includes(process.platform) || !["arm64", "x64"].includes(process.arch) },
	// 同步测试回调，真正get可能加载本机原生模块，但下面只检查字段与对象身份。
	() => {
		// getNativeClipboard在非Linux委托getNativePlatformHelper。
		const clipboard = getNativeClipboard();
		// 要求helper存在，没有把未安装扩展当作通过。
		assert.ok(clipboard);
		// typeof只要求getText是函数，不调用、不检查其Promise完成值。
		assert.equal(typeof clipboard.getText, "function");
		// 同样只检查getImage函数形状。
		assert.equal(typeof clipboard.getImage, "function");
		// 这个平台用例要求可选setText在当前helper中确实提供。
		assert.equal(typeof clipboard.setText, "function");
		// strict equal要求剪贴板API直接就是平台helper的同一对象，非包装副本。
		assert.equal(clipboard, getNativePlatformHelper());
		// 再次get还应返回缓存中的同一引用，未证明系统显示连接持续可用。
		assert.equal(clipboard, getNativeClipboard());
	},
);

// Linux惰性加载/重查DISPLAY的异步模拟：保存状态→注册恢复→假装Linux/无DISPLAY→注入Module fake→切换显示/读取结果。
// 只在arm64/x64运行，方法为t.mock.fn，示例:0/:1不连接X服务器；模块内部helpers会保存假对象到该测试进程结束，after仅恢复下面列出的全局状态。
test("Linux loads X11 lazily and rechecks DISPLAY", { skip: !["arm64", "x64"].includes(process.arch) }, async (t) => {
	// 以测试文件为基准创建require，缓存是与被测CommonJS加载器共享的模块缓存。
	const require = createRequire(import.meta.url);
	// 保存process.platform完整属性描述符；非空断言!只消除TS可缺性，不生成运行时检查。
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	// 保存原DISPLAY文本或undefined，恢复时要区别原本不存在和存在空串。
	const display = process.env.DISPLAY;
	// 同样保存Wayland显示环境值。
	const waylandDisplay = process.env.WAYLAND_DISPLAY;
	// 声明精确绝对路径作为缓存键，URL和本机路径不是同一种字符串。
	const modulePath = fileURLToPath(
		// 按process.arch选Linux二进制路径；这里只构造file URL，不执行或编译该产物。
		new URL(`../native/linux/prebuilds/linux-${process.arch}/linux-platform-x11.node`, import.meta.url),
	);
	// 备份同路径旧CommonJS缓存项，便于结束后恢复原有模块引用。
	const previous = require.cache[modulePath];
	// t.after注册本测试结束后的同步恢复，断言失败也由测试器执行；此刻尚未恢复。
	t.after(() => {
		// 用原描述符恢复platform值及writable/configurable等属性。
		Object.defineProperty(process, "platform", platform);
		// 原DISPLAY缺失则删除，不能把undefined赋值变成环境中的字符串。
		if (display === undefined) delete process.env.DISPLAY;
		// 原值存在（含空串）则原样写回。
		else process.env.DISPLAY = display;
		// Wayland原值缺失时删除。
		if (waylandDisplay === undefined) delete process.env.WAYLAND_DISPLAY;
		// 否则还原原Wayland字符串。
		else process.env.WAYLAND_DISPLAY = waylandDisplay;
		// 原缓存项存在就把同一对象放回。
		if (previous) require.cache[modulePath] = previous;
		// 原先没有则删除本例插入项；不清被测模块私有helpers Map中的假对象。
		else delete require.cache[modulePath];
	});
	// 临时把process.platform改成linux走被测分支，不改变宿主内核/真实操作系统。
	Object.defineProperty(process, "platform", { value: "linux" });
	// 先清DISPLAY，应该在任何原生加载之前直接返回undefined。
	delete process.env.DISPLAY;
	// 只给Wayland显示名，证明该X11入口不能仅靠此字段认为可用。
	process.env.WAYLAND_DISPLAY = "wayland-0";
	// 要求无DISPLAY时不可用；英文提wl-paste是上层策略，本函数和本测试没有实际调用该命令。
	assert.equal(getNativeClipboard(), undefined); // Wayland paste uses wl-paste.
	// 闭包变量模拟显示读取可用性，后续修改会被假getText在调用时读取。
	let available = false;
	// 创建满足两个必需读取方法的普通假对象，不提供真实原生连接。
	const helper = {
		// t.mock.fn保留调用统计；async箭头返回Promise，available假时undefined、真时X11，不读系统剪贴板。
		getText: t.mock.fn(async () => (available ? "X11" : undefined)),
		// 假图片读取异步固定返回null表示没有图片，未加载图像。
		getImage: t.mock.fn(async () => null),
	};
	// new Module只创建CommonJS模块记录，参数是该路径标识，不会require二进制。
	const module = new Module(modulePath);
	// 把导出对象直接设为helper，随后require可取得同一引用。
	module.exports = helper;
	// 预先注入精确文件路径缓存，防止被测loader真正执行该.node初始化；此缓存项是可变测试副作用。
	require.cache[modulePath] = module;
	// 显示名:0只使DISPLAY真值检查通过，假模块不连接这个地址。
	process.env.DISPLAY = ":0";
	// 再取入口并用!告诉TS非undefined；运行时是否真有值由后面的身份断言核实。
	const clipboard = getNativeClipboard()!;
	// 要求返回注入的同一helper，若加载其他对象会失败。
	assert.equal(clipboard, helper);
	// 仅获取helper不应主动调用getText，计数必须仍0，证明获取与读取时机分离。
	assert.equal(helper.getText.mock.callCount(), 0);
	// 第一次实际调用的是mock读取，模拟暂不可用返回undefined。
	assert.equal(await clipboard.getText(), undefined);
	// 不换模块，修改闭包状态模拟显示恢复。
	available = true;
	// 同一helper下次读取可返回X11，未把一次读取不可用缓存成永久失败。
	assert.equal(await clipboard.getText(), "X11");
	// 同一假helper图片读取返回null。
	assert.equal(await clipboard.getImage(), null);
	// 撤销DISPLAY，但不删除模块缓存或私有helpers对象。
	delete process.env.DISPLAY;
	// 入口每次先看DISPLAY，因缺失返回undefined而非盲目返回已缓存helper。
	assert.equal(getNativeClipboard(), undefined);
	// 设置另一个显示名:1模拟恢复/切换，未真的连服务器。
	process.env.DISPLAY = ":1";
	// 有DISPLAY后仍返回原模块对象，说明缓存的是加载结果而非某次显示读取是否可用。
	assert.equal(getNativeClipboard(), clipboard);
});
