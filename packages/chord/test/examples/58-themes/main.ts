// 文件导读
// 所属：packages/chord/test/examples/58-themes，Chord 示例 58，对应 slice 11 §4b（themes 与 ThemeChoice）。
// 作用：在示例 56 的 board 上演示主题从注册表到页面/终端的完整链路：
//   1) 把本示例的两个主题插件（目录插件 Solarized、单文件插件 Midnight）复制进 board 的插件根并启动；
//   2) 用 headlessPage 建立页面；它必须显式加入 kit 的 themes facet（startPage 会自动加，headlessPage 不会），
//      再跟随当前深色主题；按插件名排序，第一个深色主题是 @board/solarized 的 solarized-dark；
//   3) 通过 ThemeChoice 远程契约选择 midnight，再选回 solarized-dark；选择保存在服务器、按 principal 区分，
//      页面与终端都跟随；
//   4) 若 Node 支持终端沙箱，启动终端客户端，检查它用 truecolor 的 accent 色绘制标题 "Board"；
//   5) 改写主题插件源码里的 accent，等 watcher 标脏后 applyChanges，页面变量与终端画面原地更新，无需刷新。
// 上游：../56-web/start.ts（boardDirectories/startBoard）、../56-web/headless.ts（headlessPage）、
// ../56-web/app/v1 与 v1/web（board 的 API 与 Panels）、src/index.ts 的主题表面、src/node/tui 的终端启动器、
// src/tui 的 TerminalTheme。
// 下游：Themes 注册表（chord.themes）、ThemeChoice（chord.themes.choice，由服务器 core facet 提供）、
// themeVariables/activeTheme、终端 base bundle（../56-web/tui/main.ts）、插件构建与热更新。
// 能力清单（按步骤）：boardDirectories/cp、startBoard、ownerTokenFile、themesFacet、headlessPage、
// followActiveTheme、themeVariables、TerminalTheme、ThemeChoice.get/choose/release、startTerminal/
// requireSandboxNode、plugins.state.dirty、applyChanges。
// 典型运行（示例）：
//   cd packages/chord
//   node --conditions=source --experimental-strip-types test/examples/58-themes/main.ts
// 预期输出形如：
//   1. active (the first dark theme by plugin name): Solarized Dark: --accent #b58900, --bg #002b36, --radius 4px
//      terminal (256 colours): "\u001b[38;5;136mBoard\u001b[39m" "\u001b[38;5;240mmuted\u001b[39m"
//   2. picked: Midnight: --accent #7aa2f7, --bg #1a1b26, --radius -
//   3. the terminal draws the title in Solarized's accent: "\u001b[38;2;181;137;0mBoard"
//   4. after the edit: Solarized Dark: --accent #d33682, --bg #002b36, --radius 4px
//      the terminal redrew in the new accent: "\u001b[38;2;211;54;130mBoard"
//   若 Node 低于 26.5.1，第 3 步改为打印提示，终端相关断言不会执行。
// 阅读顺序：先看第 1-3 步的注册表与选择，再看第 4 步终端、第 5 步热更新；主题数据结构见
// packages/chord/docs/theming/book.md 与 src/surfaces/themes.ts。
// 前置条件：Node 支持 --experimental-strip-types；终端部分额外要求 Node 26.5.1+（沙箱）。
// 副作用：复制插件到临时目录、改写其中的 theme.ts、监听回环端口、可选地启动终端沙箱子进程；
// 结束删除临时目录。示例不是测试，没有断言，靠等待循环与字符串检查体现结果。
//
// Themes (slice 11 §4b, decision "Looks and themes"): a theme is data in the kit's `Themes` registry, contributed by a
// plugin (`plugins/solarized/`: the same theme for pages and terminals). The user picks one dark and one light theme
// (`ThemeChoice`, kept per principal on the server); a page writes the active one as CSS variables on `:root`, a
// terminal looks colours up by role. Editing the theme plugin restyles both live: no reload.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/58-themes/main.ts

// cp 复制目录；readFile/writeFile 读写插件源码；rm 清理。
import { cp, readFile, rm, writeFile } from "node:fs/promises";
// 路径拼接。
import { join } from "node:path";
// PassThrough 是可读写的内存流；这里分别当作终端输入与输出。
import { PassThrough } from "node:stream";
// fileURLToPath 把 import.meta.url 转成本地路径。
import { fileURLToPath } from "node:url";
// 示例级后台上下文。
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
// 命名空间导入：chord.defineFacet。
import * as chord from "../../../src/index.ts";
// 主题表面：跟随当前主题、主题类型、用户选择契约、Themes 注册表的 core facet、CSS 变量转换。
import { followActiveTheme, type Theme, ThemeChoice, themesFacet, themeVariables } from "../../../src/index.ts";
// 终端启动器：RunningTerminal 是句柄类型；requireSandboxNode 检查 Node 版本；startTerminal 启动沙箱。
import { type RunningTerminal, requireSandboxNode, startTerminal } from "../../../src/node/tui/index.ts";
// TerminalTheme 把主题颜色转成 ANSI 字符串。
import { TerminalTheme } from "../../../src/tui/index.ts";
// board 的身份类型：core facet 的泛型参数。
import type { BoardPrincipal } from "../56-web/app/principals.ts";
// board 的 Panels 注册表（web API）。
import * as v1web from "../56-web/app/v1/web.ts";
// board 的公共 API 模块，作为客户端模块表的值。
import * as v1 from "../56-web/app/v1.ts";
// 在 Node 中运行页面客户端代码，不启动浏览器。
import { headlessPage } from "../56-web/headless.ts";
// 临时目录与 board 启动函数。
import { boardDirectories, startBoard } from "../56-web/start.ts";

// 1. The board with two theme plugins added to its plugins: Solarized (a directory) and Midnight (a single file).
// 1. 先准备隔离目录：base 是临时根，dataDir 是数据目录，root 是 56 插件副本的根。
const { base, dataDir, root } = await boardDirectories();
// 把 58 的 plugins/ 复制进 root。Node 的 fs.cp 在目标目录已存在时把源内容合并进去，
// 因此 root 中新增 solarized/ 与 midnight.web.ts，而 56 原有的 clock/notes 保留。
await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });
// 启动 board（此时插件根里已有四个插件：clock、notes、solarized、midnight）。
const app = await startBoard(dataDir, root, context);
// owner token 文件（0600）：既给 headless 页面，也给终端启动器做凭据。
const token = (await readFile(app.ownerTokenFile, "utf8")).trim();

// 2. A page (headless here; `startPage` does the same with the kit's themes facet) and the theme it would write.
// 2. headlessPage 用 startClient 直接连服务器，不会像 startPage 那样自动加入主题 facet；
// 所以 core 必须显式提供两个 facet：
// - chord.themes：Kit 的 themesFacet，作为 Themes 注册表的 provider（没有 provider，插件贡献无法合并）；
// - @board/core：board 自己的 Panels 注册表 provider，与示例 56 相同。
const core = [
	{ name: "chord.themes", facet: themesFacet<BoardPrincipal>() },
	{
		name: "@board/core",
		facet: chord.defineFacet<BoardPrincipal>((host) =>
			host.serve(v1web.Panels, { compose: (table) => table.map(({ value }) => value) }),
		),
	},
];
// ownerLink 的 origin 是服务器地址；token 作为 owner 身份；模块表键与 board 的 api.modules 一致；
// core 是上面两个 facet。该方法返回已连接的客户端 Host。
const page = await headlessPage(
	new URL(app.ownerLink()).origin,
	token,
	{ "@board/app/v1": v1, "@board/app/v1/web": v1web },
	core,
);
// 当前生效主题由回调写入；初始 undefined，followActiveTheme 会先同步回调一次（回退主题），
// 注册表到达后再回调第一个深色主题。
let active: Theme | undefined;
// 跟随 page.host 上的深色主题：changed 在开始时与每次注册表/用户选择/模式变化时调用。
// 返回 ThemeFollower（这里不需要 setMode/stop，页面停止时宿主一并结束）。
await followActiveTheme(
	page.host,
	"dark",
	(theme) => {
		active = theme;
	},
	context,
);
// 打印当前主题的 CSS 变量与终端颜色。
// `active!` 是非空断言：TypeScript 无法证明回调已赋值，但 followActiveTheme 在返回前至少回调一次，
// 因此运行时 active 已存在；断言只影响编译期。
const show = (step: string): void => {
	// themeVariables 生成 --accent、--bg 等 CSS 自定义属性；web 额外键（如 --radius）只在主题提供时存在。
	// variables["--radius"] ?? "-" 的兜底是运行期行为：类型上索引是 string，但稀疏对象实际可能没有该键。
	const variables = themeVariables(active!);
	console.log(
		`${step} ${active!.name}: --accent ${variables["--accent"]}, --bg ${variables["--bg"]}, --radius ${variables["--radius"] ?? "-"}`,
	);
	// TerminalTheme(主题, 色深)：按角色取色。"256" 会把真彩色映射到 xterm 256 调色板。
	const terminal = new TerminalTheme(active!, "256");
	// fg("accent","Board") 返回带 SGR 序列的字符串；JSON.stringify 让转义字符可见、便于核对。
	console.log(
		`   terminal (256 colours): ${JSON.stringify(terminal.fg("accent", "Board"))} ${JSON.stringify(terminal.fg("muted", "muted"))}`,
	);
};
// 注册表刚到达时 active 可能还是回退主题；轮询到第一个贡献的深色主题。
// 插件贡献按插件名排序："@board/solarized" 在 "midnight" 之前，所以是 solarized-dark。
while (active?.id !== "solarized-dark") await new Promise((resolve) => setTimeout(resolve, 10));
show("1. active (the first dark theme by plugin name):");

// 3. The user picks Midnight, then Solarized again: every page and terminal of theirs follows.
// 3. ThemeChoice 是服务器上的远程契约：按 principal 保存 pick，choose 写入后所有同身份客户端都会跟随。
// page.host.get 返回 Reference；页面连接时用 owner token，因此读到 owner 的选择。
const choice = await page.host.get(ThemeChoice, {}, context);
// becomes 轮询直到 active.id 变成目标 id；每次检查间隔 10ms。
// 这是同步等待的简单办法，示例没有超时上限（主题不存在时会一直等）。
const becomes = async (id: string): Promise<void> => {
	while (active?.id !== id) await new Promise((resolve) => setTimeout(resolve, 10));
};
// 选 midnight 作为深色主题，不指定浅色（null 表示用第一个浅色主题）。
// choose 的参数由契约的 Pick schema 校验；服务器写入持久状态，follower 的 pick watch 收到新值。
await choice.choose({ dark: "midnight", light: null }, context);
// 等页面侧生效并打印；Midnight 是单文件 web 插件，没有 web.radius，所以 --radius 显示 "-"。
await becomes("midnight");
show("2. picked:");
// 再选回 solarized-dark；终端侧的主题来自 solarized/tui.ts 的同名主题。
await choice.choose({ dark: "solarized-dark", light: null }, context);
await becomes("solarized-dark");

// 4. A terminal client, when this Node can sandbox it: its frames are drawn in the same theme (true colour here).
// 4. 终端客户端只在 Node 支持沙箱时运行；sandboxAvailable 内部 try/catch 调用 requireSandboxNode。
const frames: string[] = [];
let terminal: RunningTerminal | undefined;
if (sandboxAvailable()) {
	// PassThrough 是内存双工流；用 Object.assign 附加 columns/rows，匹配 startTerminal 对输出流的类型。
	// 启动器用它们决定桥接终端尺寸（缺省 80x24）。
	const output = Object.assign(new PassThrough(), { columns: 60, rows: 10 });
	// 收集输出块；toString() 默认 UTF-8，ANSI 转义序列会原样保留。
	output.on("data", (chunk: Buffer) => frames.push(chunk.toString()));
	// 凭据来自 owner token 文件；`as const` 把 kind 收窄成字面量 "file"，以匹配 TerminalCredentials 联合。
	// 运行时 tokenOf 会重新读取文件（文件权限 0600）。
	const credentials = { kind: "file", path: app.ownerTokenFile } as const;
	// 启动终端：先下载 base bundle，再在沙箱子进程中运行 56 的 tui 入口；
	// input 是一个没有数据的 PassThrough（本示例不发送按键），colors 强制 truecolor。
	// 返回 RunningTerminal：exited 是退出码 Promise，stop 请求终止。
	terminal = await startTerminal({
		url: new URL(app.ownerLink()).origin,
		credentials,
		input: new PassThrough(),
		output,
		colors: "truecolor",
	});
	// 等待终端绘出标题 "Board"。`\x1b[38;2;181;137;0m` 是 24 位前景色 #b58900（181,137,0），
	// 即 Solarized Dark 的 accent；tui/main.ts 用 theme.fg("accent","Board") 绘制标题。
	// frames.join("") 每轮重新拼接，便于跨 chunk 的序列也能匹配。
	while (!frames.join("").includes("\x1b[38;2;181;137;0mBoard"))
		await new Promise((resolve) => setTimeout(resolve, 10));
	console.log("3. the terminal draws the title in Solarized's accent:", JSON.stringify("\x1b[38;2;181;137;0mBoard"));
} else console.log("3. (a terminal client needs Node 26.5.1 or later: see example 57)");

// 5. Edit the theme plugin and apply: the page's variables change in place, and the terminal redraws.
// 5. 改写临时插件副本（不是仓库源码）中的 theme.ts：把第一个 "#b58900" 换成 "#d33682"（洋红）。
// 替换只命中第一处文本；如果 theme.ts 的注释先写了同一个字符串，替换会落在注释上而不是 accent。
const file = join(root, "solarized", "theme.ts");
await writeFile(file, (await readFile(file, "utf8")).replace("#b58900", "#d33682"));
// 插件 watcher 发现文件变化后把插件名放入 dirty；轮询其只读状态。
while (!app.plugins.state.value.dirty.includes("@board/solarized"))
	await new Promise((resolve) => setTimeout(resolve, 10));
// applyChanges 只重建 dirty 插件，并按 server → workers → surfaces 的顺序发布；
// web 与 tui 两个 surface 都会拿到新的 solarized 主题贡献，页面/终端无需刷新。
await app.applyChanges(context);
// 等页面侧的主题注册表更新；ThemeChoice 没变，但注册表变化会让 follower 重新计算 active。
while (active?.colors.accent !== "#d33682") await new Promise((resolve) => setTimeout(resolve, 10));
show("4. after the edit:");
// 终端侧：tui/main.ts 的 theme.onChange 触发重绘；等新的 accent 出现在帧里。
// #d33682 的 24 位 RGB 是 211,54,130。
if (terminal !== undefined) {
	while (!frames.join("").includes("\x1b[38;2;211;54;130mBoard"))
		await new Promise((resolve) => setTimeout(resolve, 10));
	console.log("   the terminal redrew in the new accent:", JSON.stringify("\x1b[38;2;211;54;130mBoard"));
	// 停止沙箱子进程；不等待 exited，示例随后直接关闭服务器。
	await terminal.stop();
}

// 清理：先释放 ThemeChoice 引用，再停止页面宿主、关闭应用、删除临时目录。
// 顺序与示例 56 一致：客户端先于服务器关闭。
choice.release();
await page.stop(context);
await app.close(context);
await rm(base, { recursive: true, force: true });

// 函数说明：sandboxAvailable 判断当前 Node 能否运行终端沙箱。
// 输入无；输出 boolean。副作用：无（requireSandboxNode 只比较版本号，版本不足时抛错）。
// 示例：Node 26.5.1 返回 true；Node 22 返回 false。
// 说明：startTerminal 内部也会调用 requireSandboxNode；这里提前判断是为了在旧 Node 上跳过整个终端步骤。
/** Whether this Node can run the terminal's sandbox. */
function sandboxAvailable(): boolean {
	try {
		// 版本检查通过则什么也不返回，函数继续到 return true。
		requireSandboxNode();
		return true;
	} catch {
		// 任意异常都视为“不可用”；这里只关心版本门槛，不打印错误，避免干扰示例输出。
		return false;
	}
}
