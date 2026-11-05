// 终端图片协议、能力/格尺寸缓存、头部尺寸读取与Kitty放置元数据；Image组件/布局/TUI调用它。
// 大部分函数只生成字符串或内存数据，不会画图；能力冷探测的tmux分支例外，会同步运行只读tmux查询。没有读取系统剪贴板。
import { execSync } from "node:child_process";
// homedir只用来缩短回退路径显示。
import { homedir } from "node:os";
// 判断文件名是否绝对路径，不检查文件存在。
import { isAbsolute } from "node:path";
// 绝对文件路径编码为file:URL供超链接。
import { pathToFileURL } from "node:url";
// 只引入颜色输出模式类型，避免运行时颜色模块依赖。
import type { TerminalColorMode } from "./colors.ts";

// 两种已实现的图形协议或null无图片；这不是对所有终端图形协议的全集定义。
export type ImageProtocol = "kitty" | "iterm2" | null;

// 能力结论数据，来自环境启发/显式覆盖，不代表真的发过绘图测试。
export interface TerminalCapabilities {
	// 图片使用哪种协议。
	images: ImageProtocol;
	// 是否按真彩色编码RGB。
	trueColor: boolean;
	// 是否允许使用OSC8超链接。
	hyperlinks: boolean;
}

// 单个字符格的像素大小，不是终端总宽高。
export interface CellDimensions {
	// 每格横向像素数。
	widthPx: number;
	// 每格纵向像素数。
	heightPx: number;
}

// 原图片像素大小，结构恰好相同但语义与单格尺寸不同。
export interface ImageDimensions {
	// 图片横向像素数。
	widthPx: number;
	// 图片纵向像素数。
	heightPx: number;
}

// 渲染预算/协议选项；类型不保证传入数值有限或正数。
export interface ImageRenderOptions {
	// 列数预算，renderImage默认80。
	maxWidthCells?: number;
	// 可选行数预算。
	maxHeightCells?: number;
	// 只在iTerm2分支传给协议；Kitty这里直接按算出的格数放置。
	preserveAspectRatio?: boolean;
	/** Kitty image ID. If provided, reuses/replaces existing image with this ID. */
	// 显式Kitty图像ID；底层renderImage不自动分配。
	imageId?: number;
	/** Whether Kitty should apply its default cursor movement after placement. */
	// false让Kitty发C=1禁止默认光标移动；iTerm2不使用此字段。
	moveCursor?: boolean;
}

// 模块级能力缓存，null表示尚未探测；返回/设置都是同一对象引用。
let cachedCapabilities: TerminalCapabilities | null = null;
// 程序覆盖字段是Partial，可只指定某几项，优先于环境覆盖。
let capabilityOverrides: Partial<TerminalCapabilities> = {};

// Default cell dimensions - updated by TUI when terminal responds to query
// 缺少终端回复时估计每格9×18像素，TUI收到合法尺寸回复后会替换并使组件失效。
let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

// 返回当前单格像素尺寸对象；例：初始9×18。没有克隆或查询终端，外部改返回对象也会影响共享值。
export function getCellDimensions(): CellDimensions {
	// 直接读模块引用。
	return cellDimensions;
}

// 替换共享单格像素尺寸，返回void；例：TUI消费CSI6;20;10t后传10×20。只保存引用，不校验/自动通知组件，重绘由TUI做。
export function setCellDimensions(dims: CellDimensions): void {
	// 整个对象引用替换，不逐字段复制。
	cellDimensions = dims;
}

/**
 * Checks whether the attached tmux client forwards OSC 8 hyperlinks to the
 * outer terminal. tmux only re-emits them when its `client_termfeatures` lists
 * `hyperlinks`, and strips them otherwise. On any error fallbacks `false`.
 */
// 同步问当前tmux客户端是否转发OSC8，返回boolean；例：client_termfeatures列表含hyperlinks即true。
// 会执行tmux只读查询、最多配置250ms超时，失败false；测试通过注入回调或PI_HYPERLINKS绕过，不能把此函数当纯字符串计算。
function probeTmuxHyperlinks(): boolean {
	// 将找不到命令、超时、非零退出等同步异常转false。
	try {
		// execSync执行固定命令读取特性，不传用户拼接命令；这会阻塞当前线程直到完成/失败。
		const termfeatures = execSync("tmux display-message -p '#{client_termfeatures}'", {
			// stdout解码为UTF-8字符串，非Buffer。
			encoding: "utf8",
			// 配置子进程超时250ms，不是异步取消Promise。
			timeout: 250,
			// 忽略stdin/stderr，管道收stdout，不把探测输出印到用户终端。
			stdio: ["ignore", "pipe", "ignore"],
		});
		// 对返回文本执行下面的列表解析。
		return (
			termfeatures
				// 逗号分隔特性名称。
				.split(",")
				// map清各项首尾空白，不改变原字符串。
				.map((feature) => feature.trim())
				// 必须有完整特性名hyperlinks，不能只包含类似子串。
				.includes("hyperlinks")
		);
		// 探测有任何异常都按不支持处理。
	} catch {
		// 保守返回false。
		return false;
	}
}

// 按环境优先级推测三项能力，返回新对象；例：tmux优先于外层Kitty变量。
// 读process.env/platform，只在tmux分支调用传入探测函数，其他分支不执行命令；环境可继承/泄漏，结果不是硬件能力保证。
function detectCapabilitiesFromEnvironment(tmuxForwardsHyperlink: () => boolean): TerminalCapabilities {
	// 终端程序名转小写，未定义/空串回空字符串。
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	// 读取另一种模拟器标识，同样转小写。
	const terminalEmulator = process.env.TERMINAL_EMULATOR?.toLowerCase() || "";
	// TERM也转小写用于前缀/包含判断。
	const term = process.env.TERM?.toLowerCase() || "";
	// COLORTERM用于真彩线索。
	const colorTerm = process.env.COLORTERM?.toLowerCase() || "";
	// 只认truecolor、24bit或TERM的-direct后缀，普通256color后缀不说明真彩。
	const hasTrueColorHint = colorTerm === "truecolor" || colorTerm === "24bit" || term.endsWith("-direct");
	// 当前进程平台为Windows的后备依据。
	const isWindowsConsole = process.platform === "win32";

	// Emit OSC 8 hyperlinks only when tmux confirms it forwards.
	// Image protocols are unreliable under tmux, so leave `images: null`.
	// TMUX真值或TERM以tmux开头时优先走复用器，不继承外层窗口变量推断图片。
	if (process.env.TMUX || term.startsWith("tmux")) {
		// 图片默认关，真彩仅看显式线索；超链接由回调决定，可能实际执行tmux查询。
		return { images: null, trueColor: hasTrueColorHint, hyperlinks: tmuxForwardsHyperlink() };
	}

	// screen does not forward OSC 8 hyperlinks, so keep them off there.
	// TERM以screen开头且未被tmux优先分支截获。
	if (term.startsWith("screen")) {
		// 保守禁图/超链接，真彩仍按线索。
		return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
	}

	// Herdr forwards OSC 8 hyperlinks and supports the Kitty graphics protocol. Check it before
	// outer-terminal detection because variables like KITTY_WINDOW_ID can leak into its panes.
	// Herdr专门识别在外层Kitty标记之前。
	if (termProgram === "herdr") {
		// 选Kitty图片/允许链接，但真彩仍依赖线索，不硬写true。
		return { images: "kitty", trueColor: hasTrueColorHint, hyperlinks: true };
	}

	// Rex命中其专用分支。
	if (termProgram === "rex") {
		// 本实现对Rex三项均按支持处理，不发送探测报文。
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	// Orca supports Kitty graphics but only advertises it through ORCA_IMAGE_PROTOCOL. Require
	// both signals so Orca releases predating that advertisement keep the text fallback instead
	// of reserving image rows that nothing renders.
	// Orca需要程序名加大小写精确为kitty的广告变量，两项同时成立才命中。
	if (termProgram === "orca" && process.env.ORCA_IMAGE_PROTOCOL === "kitty") {
		// 满足这两个声明就用Kitty图像并开真彩/链接。
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	// 窗口ID真值或程序名kitty即可触发Kitty推断。
	if (process.env.KITTY_WINDOW_ID || termProgram === "kitty") {
		// 三项按Kitty假设启用。
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	// Ghostty由程序名、TERM包含或资源目录任一信号识别；||短路。
	if (termProgram === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) {
		// 按Ghostty支持的三项声明返回。
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	// WEZTERM_PANE字符串"0"也为真值；或程序名识别。
	if (process.env.WEZTERM_PANE || termProgram === "wezterm") {
		// WezTerm使用Kitty图形协议，而非iTerm2路径。
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	// Warp supports the Kitty graphics protocol and OSC 8 hyperlinks.
	// Warp接受程序名或两个会话变量任一信号。
	if (termProgram === "warpterminal" || process.env.WARP_SESSION_ID || process.env.WARP_TERMINAL_SESSION_UUID) {
		// Warp按Kitty图形/真彩/链接处理。
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	// iTerm会话变量或iterm.app程序名命中。
	if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") {
		// 选iTerm2自身图片协议。
		return { images: "iterm2", trueColor: true, hyperlinks: true };
	}

	// WT_SESSION真值时视作Windows Terminal，即使平台变量不是win32也会先命中。
	if (process.env.WT_SESSION) {
		// 不启图片，启真彩与链接。
		return { images: null, trueColor: true, hyperlinks: true };
	}

	// 三个已知终端程序共用无图/真彩/链接策略。
	if (termProgram === "alacritty" || termProgram === "vscode" || termProgram === "zed") {
		// 返回它们的固定能力假设。
		return { images: null, trueColor: true, hyperlinks: true };
	}

	// JetBrains-JediTerm按另一个标识字段识别。
	if (terminalEmulator === "jetbrains-jediterm") {
		// 真彩开但图片/链接关。
		return { images: null, trueColor: true, hyperlinks: false };
	}

	// Windows Terminal does not always set WT_SESSION, for example when it hosts
	// a cmd.exe launched directly from Win+R. Modern Windows consoles support
	// truecolor; keep hyperlinks off unless we positively detected support above.
	// 前面都没命中且当前进程是Windows。
	if (isWindowsConsole) {
		// 后备只信真彩，不单凭平台推断图片/超链接。
		return { images: null, trueColor: true, hyperlinks: false };
	}

	// Unknown terminal: be conservative. OSC 8 is rendered invisibly as "just
	// text" on terminals that swallow it, which means the URL disappears from
	// the rendered output. Default to the legacy `text (url)` behavior unless we
	// have positively identified a hyperlink-capable terminal above.
	// 未知终端保守禁图/链接，真彩只看环境线索；不改变任何终端设置。
	return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
}

// 把环境覆盖值转true/false/undefined；例："1"开、"0"关、"true"仍undefined自动。纯函数，无trim或大小写转换。
function parseBooleanCapabilityOverride(value: string | undefined): boolean | undefined {
	// 嵌套三元只接受两种精确文本。
	return value === "1" ? true : value === "0" ? false : undefined;
}

// 直接重新探测能力，返回新对象，不读写cachedCapabilities；例：PI_IMAGE_PROTOCOL=none可覆盖已识别Kitty。
// 先读超链接环境覆盖，再环境识别，最后覆盖图像/真彩/链接；缺省tmux回调可能同步执行命令，注入回调可离线测试。
export function detectCapabilities(tmuxForwardsHyperlink: () => boolean = probeTmuxHyperlinks): TerminalCapabilities {
	// 只有精确1/0才得到链接覆盖值。
	const hyperlinks = parseBooleanCapabilityOverride(process.env.PI_HYPERLINKS);
	// 仍执行环境识别，然后再叠加覆盖。
	const detected = detectCapabilitiesFromEnvironment(
		// 链接已有环境覆盖时注入常量闭包，避免真正tmux探测；闭包调用只返回捕获boolean。
		hyperlinks === undefined ? tmuxForwardsHyperlink : () => hyperlinks,
	);
	// 图像协议覆盖先转小写，但不trim。
	const imageProtocol = process.env.PI_IMAGE_PROTOCOL?.toLowerCase();
	// 声明可选覆盖结果，undefined表示保留自动结论。
	const images =
		// 明确支持的两个协议名。
		imageProtocol === "kitty" || imageProtocol === "iterm2"
			? // 直接保留该协议字符串，TS据条件收窄字面量。
				imageProtocol
			: // none或0表示关闭图片。
				imageProtocol === "none" || imageProtocol === "0"
				? // null是真正关闭的值，与undefined的“无覆盖”不同。
					null
				: // 其他值（含auto）不覆盖。
					undefined;
	// 真彩覆盖同样只认精确1/0。
	const trueColor = parseBooleanCapabilityOverride(process.env.PI_TRUE_COLOR);
	// 组装新能力对象。
	return {
		// 先放自动结论。
		...detected,
		// 有图片覆盖才展开字段，null也会覆盖。
		...(images !== undefined ? { images } : {}),
		// 有真彩覆盖才展开，false不会被漏掉。
		...(trueColor !== undefined ? { trueColor } : {}),
		// 有链接覆盖才展开，最后优先级最高。
		...(hyperlinks !== undefined ? { hyperlinks } : {}),
	};
}

// 获取共享能力，首次探测后缓存原对象；例：改环境后需要reset再读取才重新探测。
// 程序覆盖叠在环境结果之后；可能同步tmux查询，无终端写入，返回对象被外部修改也会影响后续调用。
export function getCapabilities(): TerminalCapabilities {
	// null/无缓存才初始化。
	if (!cachedCapabilities) {
		// 先取程序指定链接值，供探测短路使用。
		const hyperlinks = capabilityOverrides.hyperlinks;
		// 新建缓存对象。
		cachedCapabilities = {
			// 程序链接未设则走默认探测；已设则注入返回固定值回调，环境PI_HYPERLINKS仍可先覆盖这个回调的选择。
			...detectCapabilities(hyperlinks === undefined ? undefined : () => hyperlinks),
			// 最终程序字段盖过探测/环境结果；Partial可能显式含undefined，spread也会保留它。
			...capabilityOverrides,
		};
	}
	// 返回缓存原引用，不是冻结快照。
	return cachedCapabilities;
}

// 把能力trueColor映为输出模式，返回字面量；例：false→256color。显式传cap则只读该值，缺省参数才调用getCapabilities并可能探测/缓存。
export function getTerminalColorMode(capabilities: TerminalCapabilities = getCapabilities()): TerminalColorMode {
	// 三元选模式，不重新检查图片/超链接能力。
	return capabilities.trueColor ? "truecolor" : "256color";
}

// 仅清能力缓存，返回void；例：环境变化后下次get重算。不清程序覆盖、格尺寸、图片元数据或PNG缓存。
export function resetCapabilitiesCache(): void {
	// 置null，不立即探测。
	cachedCapabilities = null;
}

/** Override selected auto-detected capabilities. */
// 替换整份程序覆盖，返回void；例：{images:null}禁图，{}恢复自动。浅复制并按三字段比较，变化时清能力缓存，不自动使组件render缓存失效。
export function setCapabilityOverrides(overrides: Partial<TerminalCapabilities>): void {
	// 同三字段都全等就不处理，未设与显式undefined按===视作相同。
	if (
		// 比较图片协议覆盖。
		capabilityOverrides.images === overrides.images &&
		// 比较真彩覆盖。
		capabilityOverrides.trueColor === overrides.trueColor &&
		// 比较链接覆盖。
		capabilityOverrides.hyperlinks === overrides.hyperlinks
	) {
		// 相同则保留当前缓存，不因新对象身份改变就重探测。
		return;
	}
	// 覆盖整体替换而非与旧覆盖合并；未传字段不保留旧值。
	capabilityOverrides = { ...overrides };
	// 让下次getCapabilities重新计算。
	cachedCapabilities = null;
}

/** Override the cached capabilities. Useful in tests to exercise both code paths. */
// 直接设能力缓存对象，返回void；例：测试强制Kitty。保存引用，不复制/验证，不改变程序覆盖；reset后仍会重新探测。
export function setCapabilities(caps: TerminalCapabilities): void {
	// 替换共享引用。
	cachedCapabilities = caps;
}

// Kitty图形报文开头APC ESC _ G，区别于键盘CSI-u。
const KITTY_PREFIX = "\x1b_G";
// iTerm2文件/图片OSC前缀，不涵盖其MultipartFile等其他形式。
const ITERM2_PREFIX = "\x1b]1337;File=";

// 判断行内是否出现这两种图片前缀，返回boolean；例：上移光标码后出现图片也true。只识别前缀，不证明完整有效图片，不查能力/执行终端动作。
export function isImageLine(line: string): boolean {
	// Fast path: sequence at line start (single-row images)
	// 先查行首作快路径。
	if (line.startsWith(KITTY_PREFIX) || line.startsWith(ITERM2_PREFIX)) {
		// 任一前缀在开头就true。
		return true;
	}
	// Slow path: sequence elsewhere (multi-row images have cursor-up prefix)
	// 否则整串includes查任意位置，兼容多行图前的光标控制/文本。
	return line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX);
}

/**
 * Generate a random image ID for Kitty graphics protocol.
 * Uses random IDs to avoid collisions between different module instances
 * (e.g., main app vs extensions).
 */
// 随机返回Kitty图片ID，例：组件未传ID时首次图片渲染调用。使用Math.random，不登记已用ID，也不保证多实例绝不碰撞。
export function allocateImageId(): number {
	// Use random ID in range [1, 0xffffffff] to avoid collisions
	// 实际范围1..0xfffffffe（包含两端），与原英文上界有一之差；floor去小数再加1排除0。
	return Math.floor(Math.random() * 0xfffffffe) + 1;
}

// 将PNG base64编码成Kitty发送并放置的控制串，长载荷按4096字符分块；例：短图一条APC，长图首块m=1末块m=0。
// 只生成字符串，不转PNG/验证base64/分配ID/查询终端；本实现固定f=100，协议本身还可有RGB/RGBA格式。
export function encodeKitty(
	// 原PNG的base64载荷，不是文件路径。
	base64Data: string,
	// 匿名选项对象类型，字段都可省。
	options: {
		// 目标列数c，以终端格为单位。
		columns?: number;
		// 目标行数r，同样是格而非像素。
		rows?: number;
		// 可选图片ID，0在下面truthy条件中会被省掉。
		imageId?: number;
		/** Whether Kitty should apply its default cursor movement after placement. Default: true. */
		// false才加C=1；true/undefined沿终端协议默认光标移动。
		moveCursor?: boolean;
		// 缺省空选项对象，不在这里填行列默认值。
	} = {},
	// 返回一个包含全部分块的字符串。
): string {
	// 每块最多4096个base64字符，通常ASCII故字节数相同；不是4096解码后像素字节。
	const CHUNK_SIZE = 4096;

	// a=T发送并显示，f=100声明PNG，q=2让终端不回成功/错误报告；不代表操作已成功。
	const params: string[] = ["a=T", "f=100", "q=2"];

	// 明确false才要求终端禁止默认光标移动。
	if (options.moveCursor === false) params.push("C=1");
	// 列数用truthy判断，0省略；没有额外整数/正数验证。
	if (options.columns) params.push(`c=${options.columns}`);
	// 行数同样truthy才编码。
	if (options.rows) params.push(`r=${options.rows}`);
	// ID真值才编码，0不出现于控制串。
	if (options.imageId) params.push(`i=${options.imageId}`);

	// 载荷不超过一块（含空串）走单条形式。
	if (base64Data.length <= CHUNK_SIZE) {
		// 逗号拼控制字段，分号后载荷，ESC反斜杠结束APC；不写stdout。
		return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
	}

	// 收集每个完整控制串，最后一次join。
	const chunks: string[] = [];
	// 当前base64字符偏移从0开始。
	let offset = 0;
	// 记录是否首块，首块需要完整控制字段。
	let isFirst = true;

	// 按字符遍历直到载荷全部切完。
	while (offset < base64Data.length) {
		// slice取最多4096字符，保持输入不变。
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		// 计算本块是否覆盖到字符串末尾。
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		// 首块优先处理；此分支外已确保整体大于4096，所以首块必还有后续。
		if (isFirst) {
			// 首块带完整参数和m=1表示未完。
			chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
			// 后续块不再重复完整参数。
			isFirst = false;
			// 非首块且最后一块。
		} else if (isLast) {
			// m=0终止分块传输，不重复ID等首块参数。
			chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
			// 其余是中间块。
		} else {
			// 中间块只带m=1续传。
			chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
		}

		// 偏移向前4096，最后一块也按同样步长推进。
		offset += CHUNK_SIZE;
	}

	// 直接连接所有APC，不插换行或空格。
	return chunks.join("");
}

/**
 * Delete a Kitty graphics image by ID.
 * Uses uppercase 'I' to also free the image data.
 */
// 生成删除指定Kitty ID及其数据的控制串；例：TUI淘汰42时请求删除。只返回字符串，不查本地表/终端、不清注册元数据。
export function deleteKittyImage(imageId: number): string {
	// a=d删除，d=I大写表示还释放对应数据，i选ID，q=2静默；本函数不验证ID。
	return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}

/**
 * Delete all visible Kitty graphics images.
 * Uses uppercase 'A' to also free the image data.
 */
// 生成删除所有可见Kitty放置及相关数据的控制串，无输入；例：AltScreen清屏前拼入输出。只生成，不执行或清内存表。
export function deleteAllKittyImages(): string {
	// 大写A与下一函数小写a的“是否释放数据”不同，q=2静默。
	return "\x1b_Ga=d,d=A,q=2\x1b\\";
}

/** Delete all visible Kitty placements while retaining their uploaded image data. */
// 生成删除可见Kitty放置但保留上传数据的串；例：屏幕重排后可按ID重新放置。无直接终端/注册表副作用。
export function deleteAllKittyPlacements(): string {
	// d=a小写保留图像数据，不是把本地metadata清空。
	return "\x1b_Ga=d,d=a,q=2\x1b\\";
}

// 将base64编码为iTerm2 File控制串，返回string；例：宽2格、高auto会生成width=2;height=auto。
// 只构造串，默认inline=1，不切块/检查图像格式，任意宽高字符串原样插入，调用方负责合适选项；无终端直接输出。
export function encodeITerm2(
	// 原文件base64，不在这里转PNG。
	base64Data: string,
	// 协议参数对象类型。
	options: {
		// 数字通常表示格数，字符串可表达auto/px/百分比；本函数不解析/验证这些语法。
		width?: number | string;
		// 高度同理，renderImage固定传auto。
		height?: number | string;
		// 可选展示文件名，写入前会base64编码。
		name?: string;
		// false时关闭保持比例；其他值不显式发字段。
		preserveAspectRatio?: boolean;
		// false才作为文件传输而非内联展示。
		inline?: boolean;
		// 缺省空对象。
	} = {},
	// 返回完整OSC字符串。
): string {
	// 局部参数数组预放两个必需描述字段。
	const params: string[] = [
		// 默认inline=1，明确false为0；不是真的已经显示到终端。
		`inline=${options.inline !== false ? 1 : 0}`,
		// size用base64解码后的字节计数，不是字符串长度，也非完整base64校验。
		`size=${Buffer.byteLength(base64Data, "base64")}`,
	];

	// width只要非undefined就原样插入，0也会编码。
	if (options.width !== undefined) params.push(`width=${options.width}`);
	// height规则同样不使用truthy。
	if (options.height !== undefined) params.push(`height=${options.height}`);
	// name有真值才写，空名省略。
	if (options.name) {
		// 按默认UTF-8把文件名编码成base64，避免分隔符破坏name字段。
		const nameBase64 = Buffer.from(options.name).toString("base64");
		// 加入编码后name。
		params.push(`name=${nameBase64}`);
	}
	// 明确关闭比例时才产生额外参数。
	if (options.preserveAspectRatio === false) {
		// 协议值0表示不保持原纵横比。
		params.push("preserveAspectRatio=0");
	}

	// 参数用分号连，冒号后base64，BEL结束；不含发送操作。
	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

// 输出占用的字符格数，不是源图尺寸。
export interface ImageCellSize {
	// 列数。
	columns: number;
	// 行数。
	rows: number;
}

// 注册元数据把占位格数与原始像素尺寸连起来，便于按滚动行裁图。
export interface KittyImageMetadata extends ImageCellSize {
	// 图片ID索引键。
	imageId: number;
	// 原图片像素宽。
	widthPx: number;
	// 原图片像素高。
	heightPx: number;
}

// 内部记录加上传代次，公开元数据查询会去掉这一额外字段。
interface RegisteredKittyImageMetadata extends KittyImageMetadata {
	// 每次登记递增，用来区分同ID图片/大小重新传输。
	transmissionGeneration: number;
}

// 一段图片行可重用为“仅放置”的信息，供AltScreen上传缓存使用，不是终端回执。
export interface KittyImagePlacement {
	// 对应登记ID。
	imageId: number;
	// 登记时的代次，只有代次相同才可复用旧上传。
	transmissionGeneration: number;
	// 原传输段占字符串长度；对正常ASCII协议/base64即字节数，不是PNG解码大小。
	transmissionBytes: number;
	// 按像素宽×高×4估计RGBA解码内存，不是实际终端内存查询。
	estimatedDecodedBytes: number;
	// 本次放置覆盖行数，可被裁剪后的显式r覆盖。
	rows: number;
	// 仅放置命令，不带原base64载荷。
	sequence: string;
	// 保留原行前后文字，替换掉整段图片传输的新行。
	replacementLine: string;
}

// 共享注册表，最多1000条；由renderImage显式ID分支写入，低层encodeKitty不自动登记。
const kittyImageMetadata = new Map<number, RegisteredKittyImageMetadata>();
// 共享代次数，从0起每次登记加1，不随能力缓存重置。
let kittyTransmissionGeneration = 0;
// Tallest registered image. Bounds backward searches for image lines above a
// viewport: no image line further up than this can reach into it.
// 历史最高行数只增不减，即使表淘汰/同ID改小仍保留；给layout向上回查提供保守上界。
let maxKittyImageRows = 0;

// 登记图片像素/格数并产生新代次，返回void；例：ID42按3行显示供layout裁剪。
// 浅复制新记录，同ID先删再插到末尾，超1000条删最早登记者；会改共享内存，不发送/验证/删除终端图片。
export function registerKittyImageMetadata(metadata: KittyImageMetadata): void {
	// 每次登记都递增，即使相同ID/尺寸也视为新传输代次。
	kittyTransmissionGeneration += 1;
	// 记录历史最高行数，不在淘汰时回算。
	maxKittyImageRows = Math.max(maxKittyImageRows, metadata.rows);
	// 同ID旧记录删掉以更新Map插入顺序。
	kittyImageMetadata.delete(metadata.imageId);
	// 浅展开metadata并覆盖内部代次，不保留调用方对象本身。
	kittyImageMetadata.set(metadata.imageId, { ...metadata, transmissionGeneration: kittyTransmissionGeneration });
	// 超上限淘汰一个最早登记项，不是按每次查询更新的LRU。
	if (kittyImageMetadata.size > 1000) {
		// Map迭代顺序取得最早键，.value可能undefined。
		const oldestImageId = kittyImageMetadata.keys().next().value;
		// 确有键才删除；不下发Kitty删除命令。
		if (oldestImageId !== undefined) kittyImageMetadata.delete(oldestImageId);
	}
}

/** Return the row height of the tallest Kitty image registered so far. */
// 返回历史注册最大行高，例：layout按此限制视口上方搜索距离。只读数字，不扫描当前表或重算下降值。
export function getMaxKittyImageRows(): number {
	// 直接返回单调累计的最大值。
	return maxKittyImageRows;
}

// 从控制字段取首个数字i并查共享表，返回内部原记录或undefined；例：c=3,i=42,r=2取42。无修改，不严格验证全部控制字段。
function getRegisteredKittyImageMetadataFromControls(controls: string): RegisteredKittyImageMetadata | undefined {
	// 逗号/首尾边界避免误匹配其他字段，?.[1]取捕获数字字符串。
	const imageId = /(?:^|,)i=(\d+)(?:,|$)/.exec(controls)?.[1];
	// 缺ID不查表；有ID转十进制，返回原对象引用。
	return imageId === undefined ? undefined : kittyImageMetadata.get(Number.parseInt(imageId, 10));
}

// 从行里第一段Kitty控制头查内部元数据；例：光标前缀后也能找到。只查头，不读/解码载荷，无修改。
function getRegisteredKittyImageMetadata(line: string): RegisteredKittyImageMetadata | undefined {
	// 非锚定正则找首个ESC_G到分号间控制段，后续图片不在此次查找范围。
	const controls = /\x1b_G([^;]*);/.exec(line)?.[1];
	// 没有控制段则undefined，否则复用i查表。
	return controls === undefined ? undefined : getRegisteredKittyImageMetadataFromControls(controls);
}

// 读控制段首个数字r，仅值>0才返回行数，否则undefined；例：首个r=0不采用，也不再寻找后一个r。无修改，不保证任意超长数字有限。
function getExplicitKittyImageRows(controls: string): number | undefined {
	// 捕获逗号边界内的十进制行数。
	const value = /(?:^|,)r=(\d+)(?:,|$)/.exec(controls)?.[1];
	// 没字段直接undefined。
	if (value === undefined) return undefined;
	// 转十进制，可能因极长文本溢出Infinity，后面仅检查>0。
	const rows = Number.parseInt(value, 10);
	// 正值才返回，0不当有效显式行数。
	return rows > 0 ? rows : undefined;
}

// 优先正显式r，否则使用提供的fallbackRows；例：裁剪串r=1覆盖原3行。纯查值，不改数据，也不校验回退数。
function getKittyImageRowsFromControls(controls: string, fallbackRows: number): number {
	// ??只在undefined时回退，正数原样保留。
	return getExplicitKittyImageRows(controls) ?? fallbackRows;
}

// 从行内首个Kitty头查公开元数据，返回新对象或undefined；例：i=42只有已登记才能得到像素尺寸。无I/O/注册表修改，不以头里的c/r覆写原登记尺寸。
export function getKittyImageMetadata(line: string): KittyImageMetadata | undefined {
	// 取内部原记录，含登记代次。
	const metadata = getRegisteredKittyImageMetadata(line);
	// 表中没有就不靠协议字段猜像素尺寸。
	if (!metadata) return undefined;
	// 显式创建只含公开字段的新对象，不泄露内部原记录引用。
	return {
		// 复制图片ID。
		imageId: metadata.imageId,
		// 复制原登记列数，裁剪后头中c/r不改变这份元数据。
		columns: metadata.columns,
		// 复制原登记总行数。
		rows: metadata.rows,
		// 复制原图像素宽。
		widthPx: metadata.widthPx,
		// 复制原图像素高，不返回transmissionGeneration。
		heightPx: metadata.heightPx,
	};
}

// 仅放置命令保留的控制键白名单；传输格式/压缩/续块等字段会被过滤掉。这里只判断键名，不验证键值。
const KITTY_PLACEMENT_CONTROL_KEYS = new Set([
	// i是图片ID。
	"i",
	// p是同一图片的具体放置ID。
	"p",
	// x是源像素矩形左边界。
	"x",
	// y是源像素矩形上边界。
	"y",
	// w是源矩形像素宽。
	"w",
	// h是源矩形像素高。
	"h",
	// 大写X是目标起始格内横向像素偏移。
	"X",
	// 大写Y是目标格内纵向像素偏移。
	"Y",
	// c是目标列数。
	"c",
	// r是目标行数。
	"r",
	// 大写C保留光标移动策略，C=1不移动。
	"C",
	// U保留Unicode占位对应的虚拟放置开关，不是在这里生成占位文字。
	"U",
	// z保留图像叠放层级。
	"z",
	// P保留相对放置所依赖的父图片ID。
	"P",
	// Q保留父图片中的放置ID。
	"Q",
	// H保留相对父放置的横向格偏移。
	"H",
	// V保留相对父放置的纵向格偏移。
	"V",
]);

/** Read the number of rows covered by an image placement without scanning its payload. */
// 只读控制头获取这次放置覆盖行数，返回number/undefined；例：裁剪r=1优先于登记3行。无载荷解码/状态修改，缺显式r时才查注册表。
export function getKittyImagePlacementRows(line: string): number | undefined {
	// 找首个Kitty控制段，非整串严格验证。
	const controls = /\x1b_G([^;]*);/.exec(line)?.[1];
	// 找不到头就无结果。
	if (controls === undefined) return undefined;
	// 尝试正显式r。
	const explicitRows = getExplicitKittyImageRows(controls);
	// 已有显式r立即返回，即使未登记ID也可读取。
	if (explicitRows !== undefined) return explicitRows;
	// 否则按i查注册原记录的rows，可选链处理未登记。
	return getRegisteredKittyImageMetadataFromControls(controls)?.rows;
}

/** Build a placement-only command for an image line emitted by {@link renderImage}. */
// 将本实现传输图片行提取成仅放置信息，返回结构或undefined；例：已上传同ID/代次时AltScreen可换成小串避免重传。
// 先查元数据，再逐块寻找传输结束，过滤放置字段并保留行前后内容；无终端写入/表修改，不证明远端已上传。只处理首段图像，非通用Kitty语法校验。
export function getKittyImagePlacement(line: string): KittyImagePlacement | undefined {
	// 找到首个APC头及其位置/控制字段。
	const match = /\x1b_G([^;]*);/.exec(line);
	// 没头则undefined。
	if (!match) return undefined;
	// 只有已登记的i才有尺寸与代次可用。
	const metadata = getRegisteredKittyImageMetadataFromControls(match[1]);
	// 缺元数据就不生成仅放置替换。
	if (!metadata) return undefined;

	// 当前APC在字符串中的起点，随后可推进到下块。
	let commandStart = match.index;
	// 当前块控制字段，首块是完整参数。
	let commandControls = match[1];
	// 结束下标稍后在循环内赋值，指向最终ST之后。
	let transmissionEnd: number;
	// 按m=1续块标志遍历，首个不续传块使循环结束。
	while (true) {
		// 在本块前缀后找ESC反斜杠结束符；只是查串，不扫描/解码base64内容格式。
		const terminator = line.indexOf("\x1b\\", commandStart + KITTY_PREFIX.length);
		// 缺结束符就不替换，避免截错传输范围。
		if (terminator === -1) return undefined;
		// 结束符两UTF-16单元也计入传输段。
		transmissionEnd = terminator + 2;
		// 没m=1就视作传输末块，不额外要求明确m=0。
		if (!/(?:^|,)m=1(?:,|$)/.test(commandControls)) break;
		// 续块必须紧挨上一结束符，推进当前起点。
		commandStart = transmissionEnd;
		// 下一位置没有Kitty前缀就认为块链不完整。
		if (!line.startsWith(KITTY_PREFIX, commandStart)) return undefined;
		// 找续块控制头与载荷间分号。
		const controlsEnd = line.indexOf(";", commandStart + KITTY_PREFIX.length);
		// 缺分号则不能继续读控制段。
		if (controlsEnd === -1) return undefined;
		// 更新当前控制字段，下一轮根据它决定还要不要续块。
		commandControls = line.slice(commandStart + KITTY_PREFIX.length, controlsEnd);
	}

	// 只从首块控制字段提取放置属性。
	const controls = match[1]
		// 按逗号拆key=value列表。
		.split(",")
		// filter回调只留白名单键；split("=",1)取键，保留字段原文/顺序，不检查重复键或值。
		.filter((control) => KITTY_PLACEMENT_CONTROL_KEYS.has(control.split("=", 1)[0] ?? ""));
	// a=p只放置，不再附base64；q=2静默。保留i等字段，直接以ST结束。
	const sequence = `\x1b_Ga=p,q=2,${controls.join(",")}\x1b\\`;
	// 组装供TUI上传缓存和替换使用的信息。
	return {
		// 登记ID。
		imageId: metadata.imageId,
		// 当前登记代次，不能当终端确认代次。
		transmissionGeneration: metadata.transmissionGeneration,
		// 整段传输字符长度；正常本函数输出协议为ASCII，所以可作字节估算。
		transmissionBytes: transmissionEnd - match.index,
		// 宽×高×4按RGBA估解码成本，不解析PNG压缩率或实际native内存。
		estimatedDecodedBytes: metadata.widthPx * metadata.heightPx * 4,
		// 显式放置r可覆盖登记总行数，裁剪行不再按原高度预留。
		rows: getKittyImageRowsFromControls(match[1], metadata.rows),
		// 新的仅放置串，属性简写。
		sequence,
		// 保留首图前文本及传输末块后的内容，不替换行里所有图片。
		replacementLine: `${line.slice(0, match.index)}${sequence}${line.slice(transmissionEnd)}`,
	};
}

// 根据隐藏/可见格行生成源图片裁剪控制串，返回新行或原行；例：100px高/3行藏2行显示1行→y=66,h=34,r=1。
// 只重写首个APC的y/h/r，保留PNG/base64与其余分块，未改图像像素或注册原尺寸；依赖登记元数据和合理行数，非所有数值的完整验证。
export function cropKittyImageLine(line: string, hiddenRows: number, visibleRows: number): string {
	// 读原登记的总行数/像素高。
	const metadata = getKittyImageMetadata(line);
	// 独立取首个APC头供重写。
	const match = /\x1b_G([^;]*);/.exec(line);
	// 缺元数据/头、隐藏越界或可见数不正时原样返回；没有验证整数/有限性。
	if (!metadata || !match || hiddenRows < 0 || hiddenRows >= metadata.rows || visibleRows <= 0) return line;
	// 可见行不超过原图剩余行。
	const croppedRows = Math.min(visibleRows, metadata.rows - hiddenRows);
	// 整图本来已完全可见则不改字符串。
	if (hiddenRows === 0 && croppedRows === metadata.rows) return line;
	// 隐藏格行占原像素高的比例，起始像素向下取整避免丢边缘。
	const sourceY = Math.floor((metadata.heightPx * hiddenRows) / metadata.rows);
	// 可见末端像素向上取整，防止因舍入少显示。
	const sourceEnd = Math.ceil((metadata.heightPx * (hiddenRows + croppedRows)) / metadata.rows);
	// 末端先不超原图，再减起始，至少保留1像素高。
	const sourceHeight = Math.max(1, Math.min(metadata.heightPx, sourceEnd) - sourceY);
	// 只过滤小写y/h/r旧字段，不删x/w或大写Y等其他控制。
	const controls = match[1].split(",").filter((control) => !/^[yhr]=/.test(control));
	// 追加新的源y、源像素高h、目标格行r。
	controls.push(`y=${sourceY}`, `h=${sourceHeight}`, `r=${croppedRows}`);
	// 拼原前缀+新头+原分号后的全部载荷/续块/后缀；不重新编码图片。
	return `${line.slice(0, match.index)}\x1b_G${controls.join(",")};${line.slice(match.index + match[0].length)}`;
}

// 在向上取整格数与少一格之间选比例失真更小者；例：上限2格时，理想1.4可选1，理想1.5可选2。
// 只比较这两个候选，平手保留上取整；依赖idealCount为正常正数，无修改，不搜索所有宽高组合。
function chooseLessDistortedCellCount(upperCount: number, idealCount: number): number {
	// 已经最多1格就保持，避免减成0。
	if (upperCount <= 1) return upperCount;

	// 另一候选只少1格。
	const lowerCount = upperCount - 1;
	// 大/小两个比值取max，作为上取整相对理想值的比例误差。
	const upperDistortion = Math.max(upperCount / idealCount, idealCount / upperCount);
	// 对少一格算同样误差。
	const lowerDistortion = Math.max(lowerCount / idealCount, idealCount / lowerCount);
	// 严格更小才选下候选，平手保留upper。
	return lowerDistortion < upperDistortion ? lowerCount : upperCount;
}

// 把源像素尺寸缩放到格数包围盒，返回{columns,rows}；例：100×100像素、10×20px格、限10列→10列5行。
// 按宽/高预算选择更小缩放，再对格数上取整；可选择少一格减小Kitty比例失真。会放大小图，不只缩小；无外部修改，不完整验证NaN/Infinity或单格尺寸。
export function calculateImageCellSize(
	// 原图像素尺寸。
	imageDimensions: ImageDimensions,
	// 最大目标列数。
	maxWidthCells: number,
	// 可选最大行数，省略就只按宽限制。
	maxHeightCells?: number,
	// 默认9×18px是本函数独立缺省值；不会自动读取模块cellDimensions，调用方需显式传共享值。
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
	// true只在非限制轴上比较相邻格数的失真；默认false维持上取整预留。
	optimizeAspectRatio = false,
	// 返回占用格数对象，不含图片字节。
): ImageCellSize {
	// 宽预算先floor取整数再至少1。
	const maxWidth = Math.max(1, Math.floor(maxWidthCells));
	// 高度显式给定才floor/至少1，否则保持undefined。
	const maxHeight = maxHeightCells === undefined ? undefined : Math.max(1, Math.floor(maxHeightCells));
	// 源宽至少当作1，防正常0/负值分母；并非finite检查。
	const imageWidth = Math.max(1, imageDimensions.widthPx);
	// 源高同样至少1。
	const imageHeight = Math.max(1, imageDimensions.heightPx);

	// 宽格预算×每格像素宽÷源宽，得到按宽撑满的比例。
	const widthScale = (maxWidth * cellDimensions.widthPx) / imageWidth;
	// 有高预算则独立算按高比例，否则不额外约束，沿用宽比例。
	const heightScale = maxHeight === undefined ? widthScale : (maxHeight * cellDimensions.heightPx) / imageHeight;
	// 取更小比例，保证正常正数条件下同时不超两个预算。
	const scale = Math.min(widthScale, heightScale);

	// 缩放后像素宽。
	const scaledWidthPx = imageWidth * scale;
	// 缩放后像素高，保持源纵横比。
	const scaledHeightPx = imageHeight * scale;
	// 像素宽除格宽并ceil，钳到1..最大列；let允许后面优化减1。
	let columns = Math.max(1, Math.min(maxWidth, Math.ceil(scaledWidthPx / cellDimensions.widthPx)));
	// 高度先保留浮点格数作为计算中间值。
	const heightRows = scaledHeightPx / cellDimensions.heightPx;
	// 向上取整且至少1行。
	let rows = Math.max(1, Math.ceil(heightRows));
	// 有明确高预算再钳行数。
	if (maxHeight !== undefined) {
		// 避免上取整越过行预算。
		rows = Math.min(maxHeight, rows);
	}

	// 不优化比例时，按上取整结果直接返回。
	if (!optimizeAspectRatio) {
		// 只返回格数。
		return { columns, rows };
	}

	// 宽约束更紧或平手时保留列数、优化行数。
	if (widthScale <= heightScale) {
		// 按当前整数列和源比例算理论理想行数。
		const idealRows = (columns * cellDimensions.widthPx * imageHeight) / (imageWidth * cellDimensions.heightPx);
		// 比较现有行数和少一行，减少格对齐失真。
		rows = chooseLessDistortedCellCount(rows, idealRows);
		// 高约束更紧时反过来保留行数、优化列。
	} else {
		// 按当前整数行数算理想列数。
		const idealColumns = (rows * cellDimensions.heightPx * imageWidth) / (imageHeight * cellDimensions.widthPx);
		// 比较现有列数与少一列，至少1列规则在辅助函数处理。
		columns = chooseLessDistortedCellCount(columns, idealColumns);
	}

	// 输出可能减过一格的最终格数。
	return { columns, rows };
}

// 只需按目标列宽算占用行数的简便入口；例：正方形图配9×18格，60列约30行。无修改，使用本函数传入/独立默认格尺寸，不读共享缓存。
export function calculateImageRows(
	// 源像素尺寸。
	imageDimensions: ImageDimensions,
	// 目标列预算。
	targetWidthCells: number,
	// 每格像素尺寸默认9×18。
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
	// 结果只有行数number。
): number {
	// 不传最大高、不开比例优化，复用格数算法取rows。
	return calculateImageCellSize(imageDimensions, targetWidthCells, undefined, cellDimensions).rows;
}

// 从base64的PNG头读像素宽高，失败null；例：IHDR宽40高10返回40×10。只读内存字节，不解码像素/验证完整PNG、CRC或非零尺寸，无I/O。
export function getPngDimensions(base64Data: string): ImageDimensions | null {
	// 捕获base64/读缓冲等异常并转null。
	try {
		// Node Buffer.from解码base64容忍部分非规范输入，不等同严格验证。
		const buffer = Buffer.from(base64Data, "base64");

		// 至少要24字节才能读取固定宽高字段。
		if (buffer.length < 24) {
			// 长度不足返回null。
			return null;
		}

		// 这里只查PNG签名前4字节，不查完整8字节签名/IHDR类型。
		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			// 前缀不符则null。
			return null;
		}

		// 偏移16的大端32位宽。
		const width = buffer.readUInt32BE(16);
		// 偏移20的大端32位高。
		const height = buffer.readUInt32BE(20);

		// 返回尺寸对象；即使0也原样返回。
		return { widthPx: width, heightPx: height };
		// 解析步骤异常同样视为无法取得尺寸。
	} catch {
		// 失败null。
		return null;
	}
}

// 从JPEG有限SOF标记读存储像素尺寸，失败null；例：SOF0中宽高字段可返回尺寸。
// 只认标记C0..C2，不是所有JPEG变体，未解释EXIF旋转，不解码像素/完整验证，仅读内存。
export function getJpegDimensions(base64Data: string): ImageDimensions | null {
	// 缓冲/偏移读取异常转null。
	try {
		// base64解码为缓冲，非严格图片有效性检查。
		const buffer = Buffer.from(base64Data, "base64");

		// 至少需要起始标记两个字节。
		if (buffer.length < 2) {
			// 过短null。
			return null;
		}

		// FF D8是SOI开头；仅此不足以证明完整JPEG。
		if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
			// 起始不符null。
			return null;
		}

		// 从SOI后偏移2开始扫描。
		let offset = 2;
		// 保留足够后续字节给标记及尺寸；边界不满足就退出扫描。
		while (offset < buffer.length - 9) {
			// 不是标记起始FF就按字节继续找。
			if (buffer[offset] !== 0xff) {
				// 前进1个字节。
				offset++;
				// 本轮不尝试读段长度。
				continue;
			}

			// FF后一个字节是当前标记号。
			const marker = buffer[offset + 1];

			// 只在C0、C1、C2标记取宽高，不认整个SOF家族。
			if (marker >= 0xc0 && marker <= 0xc2) {
				// 标记起点+5读大端16位存储高。
				const height = buffer.readUInt16BE(offset + 5);
				// +7读存储宽；未按EXIF方向交换。
				const width = buffer.readUInt16BE(offset + 7);
				// 找到尺寸立即返回，不继续完整检查文件。
				return { widthPx: width, heightPx: height };
			}

			// 其他段要先有两字节段长度。
			if (offset + 3 >= buffer.length) {
				// 不够则null。
				return null;
			}
			// 按大端16位读取段长度，长度自身包含两个长度字节。
			const length = buffer.readUInt16BE(offset + 2);
			// 段长小于2是无效推进长度。
			if (length < 2) {
				// 直接失败。
				return null;
			}
			// 跳过标记2字节及该段长度，下一轮继续；这不是完整JPEG解码状态机。
			offset += 2 + length;
		}

		// 没有找到支持SOF则null。
		return null;
		// 读取越界等异常也收敛到null。
	} catch {
		// 失败结果。
		return null;
	}
}

// 从GIF逻辑屏幕描述头取宽高，失败null；例：GIF89a头后的两16位值。只检查签名/长度，不检查全部帧、调色板/解码内容，无I/O。
export function getGifDimensions(base64Data: string): ImageDimensions | null {
	// 局部捕获解析异常。
	try {
		// base64转内存缓冲。
		const buffer = Buffer.from(base64Data, "base64");

		// 签名6字节+宽高4字节至少10字节。
		if (buffer.length < 10) {
			// 过短null。
			return null;
		}

		// 首6字节按ASCII读取版本签名。
		const sig = buffer.slice(0, 6).toString("ascii");
		// 只允许GIF87a或GIF89a。
		if (sig !== "GIF87a" && sig !== "GIF89a") {
			// 版本不符null。
			return null;
		}

		// 偏移6读小端16位宽。
		const width = buffer.readUInt16LE(6);
		// 偏移8读小端16位高。
		const height = buffer.readUInt16LE(8);

		// 返回逻辑屏幕尺寸，不是每一动画帧的独立矩形尺寸。
		return { widthPx: width, heightPx: height };
		// 解码/读取异常转失败。
	} catch {
		// 返回null。
		return null;
	}
}

// 按WebP首块类型读画布/帧尺寸，失败null；例：VP8X的24位值加1成为宽高。
// 只看固定偏移与首块，不完整校验RIFF长度/位流；入口统一要求30字节，所以不足30的VP8L即使局部分支要求25也不会进入。无I/O。
export function getWebpDimensions(base64Data: string): ImageDimensions | null {
	// 捕获读缓冲异常。
	try {
		// base64解码，不解压像素。
		const buffer = Buffer.from(base64Data, "base64");

		// 统一最低30字节，比某些分支的局部最低值更严格。
		if (buffer.length < 30) {
			// 过短就null。
			return null;
		}

		// 首4字节需RIFF容器标签。
		const riff = buffer.slice(0, 4).toString("ascii");
		// 偏移8的格式标签需WEBP。
		const webp = buffer.slice(8, 12).toString("ascii");
		// 两个标志都符合才继续。
		if (riff !== "RIFF" || webp !== "WEBP") {
			// 容器/格式不符null。
			return null;
		}

		// 偏移12读取首块FourCC类型，不遍历后续块。
		const chunk = buffer.slice(12, 16).toString("ascii");
		// 有损VP8格式，末尾空格也是类型字符串的一部分。
		if (chunk === "VP8 ") {
			// 再次检查30字节；此处通常已由入口保证，保留原逻辑。
			if (buffer.length < 30) return null;
			// 小端16位宽只取低14位，清其余缩放位。
			const width = buffer.readUInt16LE(26) & 0x3fff;
			// 高同样取低14位。
			const height = buffer.readUInt16LE(28) & 0x3fff;
			// 返回有损VP8头尺寸。
			return { widthPx: width, heightPx: height };
			// 无损VP8L首块分支。
		} else if (chunk === "VP8L") {
			// 局部需要25字节，但入口已要求30，不能说25字节载荷一定可通过。
			if (buffer.length < 25) return null;
			// 偏移21读打包的32位小端尺寸字段。
			const bits = buffer.readUInt32LE(21);
			// 低14位存width−1，故再加1。
			const width = (bits & 0x3fff) + 1;
			// 右移14再取14位存height−1；&去掉高位符号/标志影响。
			const height = ((bits >> 14) & 0x3fff) + 1;
			// 返回解包后的尺寸。
			return { widthPx: width, heightPx: height };
			// 扩展VP8X首块分支。
		} else if (chunk === "VP8X") {
			// 确保可读到29偏移；通常入口已保证。
			if (buffer.length < 30) return null;
			// 三个字节按小端24位组合，再加1得到画布宽。
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			// 另一组三字节同理得到画布高。
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			// 返回扩展画布尺寸，不遍历动画实际帧。
			return { widthPx: width, heightPx: height };
		}

		// 其他首块类型不支持，返回null。
		return null;
		// 底层读取异常也是失败，不向外抛。
	} catch {
		// 返回null。
		return null;
	}
}

// 按精确MIME派发四种头部尺寸解析，返回尺寸/null；例：image/jpeg选JPEG，image/jpg不被别名识别。无文件I/O/完整图像验证，不根据字节嗅探其他格式。
export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null {
	// 精确PNG MIME分支。
	if (mimeType === "image/png") {
		// 调用PNG头读取。
		return getPngDimensions(base64Data);
	}
	// 精确JPEG MIME。
	if (mimeType === "image/jpeg") {
		// 调用JPEG有限SOF读取，不处理方向。
		return getJpegDimensions(base64Data);
	}
	// 精确GIF MIME。
	if (mimeType === "image/gif") {
		// 读GIF逻辑屏幕。
		return getGifDimensions(base64Data);
	}
	// 精确WebP MIME。
	if (mimeType === "image/webp") {
		// 读支持的WebP首块。
		return getWebpDimensions(base64Data);
	}
	// MIME未知、大小写不同或带参数则不在此解析。
	return null;
}

// 按共享能力及预算生成图片控制串和占位格数，返回结构/null；例：Kitty返回APC及rows，iTerm2返回OSC1337。
// 先算像素到格数，再编码相应协议；Kitty只有显式ID才登记元数据，没有自动分配/转PNG。函数不直接画图，但冷能力获取可能执行tmux探测，会修改Kitty注册表。
export function renderImage(
	// 待编码base64；Kitty路径假设已PNG，本函数没有MIME参数确认。
	base64Data: string,
	// 源像素尺寸，通常由组件读头或调用方提供。
	imageDimensions: ImageDimensions,
	// 预算/比例/ID/光标选项，缺省空对象。
	options: ImageRenderOptions = {},
	// 结果含协议串和格数，可选ID；null表示没有可用图像协议。
): { sequence: string; columns: number; rows: number; imageId?: number } | null {
	// 读/冷初始化能力缓存。
	const caps = getCapabilities();

	// 无图片协议就不算尺寸/生成串。
	if (!caps.images) {
		// 返回null供组件文字回退。
		return null;
	}

	// 底层默认宽预算80，与Image组件的默认60不同；??不将0当缺省。
	const maxWidth = options.maxWidthCells ?? 80;
	// Reduce Kitty's cell-aligned distortion without shrinking iTerm2 reservations.
	// 复用尺寸算法，不在这里改图片像素。
	const size = calculateImageCellSize(
		// 传源宽高。
		imageDimensions,
		// 传最大列预算。
		maxWidth,
		// 传可选最大行预算。
		options.maxHeightCells,
		// 这次显式传共享格像素尺寸，不用计算函数独立默认值。
		getCellDimensions(),
		// 只对Kitty开启相邻格数比例优化，iTerm2保持上取整预留。
		caps.images === "kitty",
	);

	// Kitty编码分支。
	if (caps.images === "kitty") {
		// ID非undefined就登记，0也登记；后续encodeKitty的truthy编码会省0，两者条件不同。
		if (options.imageId !== undefined) {
			// 更新本地元数据/代次，即使控制串尚未写到终端。
			registerKittyImageMetadata({
				// 登记调用者给的ID。
				imageId: options.imageId,
				// 实际目标列数。
				columns: size.columns,
				// 实际预留行数。
				rows: size.rows,
				// 源图像素宽。
				widthPx: imageDimensions.widthPx,
				// 源图像素高，供后续裁剪换算。
				heightPx: imageDimensions.heightPx,
			});
		}
		// 生成完整PNG传输/放置串，可能多APC分块。
		const sequence = encodeKitty(base64Data, {
			// 编码目标列。
			columns: size.columns,
			// 编码目标行。
			rows: size.rows,
			// 原样传可选ID，不在此生成随机ID。
			imageId: options.imageId,
			// 原样传光标移动选择，缺省允许默认移动。
			moveCursor: options.moveCursor,
		});
		// 返回协议串、同一格数与原传入ID；此刻不代表终端已经收图。
		return { sequence, columns: size.columns, rows: size.rows, imageId: options.imageId };
	}

	// iTerm2图片协议分支。
	if (caps.images === "iterm2") {
		// 不转格式，原数据直接编码成File协议。
		const sequence = encodeITerm2(base64Data, {
			// 只固定计算后的目标宽度，数字单位是格。
			width: size.columns,
			// 协议高度传auto而非size.rows；rows主要用于TUI预留，实际显示由终端比例规则决定。
			height: "auto",
			// 保持比例缺省true，false显式禁用；这与本地尺寸预算计算是两层规则。
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		// iTerm2不返回Kitty ID，格数仍用于TUI占位。
		return { sequence, columns: size.columns, rows: size.rows };
	}

	// 类型契约之外的其他images值也会走null后备，不代表运行时完整校验能力对象。
	return null;
}

/**
 * Wrap text in an OSC 8 hyperlink sequence.
 * The text is rendered as a clickable hyperlink in terminals that support OSC 8
 * (Ghostty, Kitty, WezTerm, iTerm2, VSCode, and others).
 * In terminals that do not support OSC 8, the escape sequences are ignored
 * and only the plain text is displayed.
 *
 * @param text - The visible text to display
 * @param url - The URL to link to
 */
// 为text包OSC8链接串并返回，例：文字“文档”关联https地址。仅拼串、不查能力/合法URL、不清控制符、不打开链接；调用方应传合适文字/地址。
export function hyperlink(text: string, url: string): string {
	// 开链接→原文字→空地址关闭链接，ESC反斜杠结束每个OSC；不转义嵌入的url/text。
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** Shorten home-prefixed absolute paths to ~/... for compact display. */
// 将本用户home前缀缩为~展示，返回字符串；例：/home/u/a→~/a。只读homedir，不查文件/解析软链接，不改原输入。
function shortenImagePath(filename: string): string {
	// 读取当前用户home路径。
	const home = homedir();
	// 必须恰等home或紧接斜杠/反斜杠，避免把/home/user2误判为/home/user的孩子；比较区分大小写。
	if (home && (filename === home || filename.startsWith(`${home}/`) || filename.startsWith(`${home}\\`))) {
		// 保留home后的所有内容，仅替换显示前缀。
		return `~${filename.slice(home.length)}`;
	}
	// 未命中原样返回，相对路径也不展开。
	return filename;
}

/**
 * Text fallback when the terminal cannot render inline images.
 * Absolute paths are shown shortened (~/...) and, when OSC 8 hyperlinks are
 * available, linked to file:// so the full path remains openable.
 */
// 生成图片文字回退，例：[Image: shot.png [image/png] 800x600]。有绝对文件名且支持链接时生成指向原全路径的file:链接。
// 不检查文件存在、不转义MIME/文件名/控制符、不截显示宽；有文件名会获取能力，冷tmux路径可能执行只读探测。截断/着色由Image组件做。
export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	// 依次收集可选文件名、必需MIME、可选像素尺寸。
	const parts: string[] = [];
	// 仅真值文件名才显示，空串省略。
	if (filename) {
		// 先做home缩写，只改可见文本。
		const display = shortenImagePath(filename);
		// 先读取链接能力，再判断绝对路径；即使相对文件名，左侧getCapabilities也已运行。
		if (getCapabilities().hyperlinks && isAbsolute(filename)) {
			// 链接目标用未缩写原路径编码，显示文字用缩写；无文件打开或系统剪贴板操作。
			parts.push(hyperlink(display, pathToFileURL(filename).href));
			// 不支持链接或非绝对路径时只显示文字。
		} else {
			// 直接加入显示路径，不加普通(url)后备段。
			parts.push(display);
		}
	}
	// MIME用方括号展示，字符串原样插入。
	parts.push(`[${mimeType}]`);
	// 有尺寸对象就追加宽x高，单位原像素，不是格。
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	// 片段以空格连接，外包Image说明；无尺寸时省略该段。
	return `[Image: ${parts.join(" ")}]`;
}
