// 系统剪贴板文字/文件路径适配：原生模块、平台命令和OSC52分流；实际调用函数才操作剪贴板，不把终端发送成功当远端已确认复制。
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { runClipboardCommand } from "./clipboard-command.ts";
import { isWSL } from "./wsl.ts";

// OSC52限制base64编码字符数（全ASCII），不是原文字字符数；超过100000不发序列。
const MAX_OSC52_ENCODED_LENGTH = 100_000;

/**
 * Remote sessions also emit OSC 52 so the client terminal receives the copy. PI_CLIPBOARD_OSC52=1
 * covers remote clients that leave no SSH markers, such as multiplexer attaches (#10114, #10835)
 * or IDE daemons (#10826).
 */
// 输入环境字典，返回是否应额外给远端终端发OSC52，无I/O；例如SSH/MOSH标记非空或PI_CLIPBOARD_OSC52恰好1。
// 只是启发式策略，不探测客户端是否支持/允许OSC52，也不代表系统原生复制必然失败。
function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION || env.PI_CLIPBOARD_OSC52 === "1");
}

// 输入文字，若编码未超预算则往stdout写OSC52并返回true，否则false；会产生终端控制序列副作用。
// 例如中文先UTF8→base64，终端解码写剪贴板；true只表示发起写序列，不等待stdout背压回调或客户端确认，写入异常可传出。
function emitOsc52(text: string): boolean {
	// 不直接把原文字插进控制序列，base64载荷不会引入原文ESC等控制字节。
	const encoded = Buffer.from(text).toString("base64");
	// 严格超出才拒绝，等于100000可发。
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	// c选择系统剪贴板，BEL结束OSC；stdout若被其他层接管，也按当前write实现执行。
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

/**
 * WSL without WSLg has no Linux display, so the Windows clipboard is written through
 * interop. PowerShell reads the text from a file because `clip.exe` and PowerShell stdin
 * decode piped bytes with the console code page, which mangles non-ASCII UTF-8.
 */
// WSL回退写Windows剪贴板：输入文字，返回是否命令成功；写UTF8临时文件→wslpath→PowerShell读文件Set-Clipboard→尽力删文件。
// 例如héllo不用控制台码页从stdin解码，避免非ASCII乱码；常见命令/文件错误转false，不读取用户已有剪贴板内容。
async function copyViaWindowsClipboard(text: string): Promise<boolean> {
	// 随机文件名降低冲突；不是wx排他创建，mode请求600也不是跨平台加密保证。
	const tmpFile = join(tmpdir(), `pi-wsl-clip-${randomUUID()}.txt`);
	try {
		// 同步保存UTF8文字供Windows端读取；包含隐私时权限由系统实际实现决定。
		writeFileSync(tmpFile, text, { encoding: "utf8", mode: 0o600 });
		// 可选链处理命令失败undefined，再把成功路径输出去掉末尾换行。
		const winPath = (await runClipboardCommand("wslpath", ["-w", tmpFile], { timeoutMs: 1000 }))
			?.toString("utf8")
			.trim();
		// 没有可用Windows路径就无法继续，不把空路径插进脚本。
		if (!winPath) return false;
		// PowerShell单引号内部撇号翻倍；文字正文在文件里，不拼进可执行脚本文本。
		const script = `Set-Clipboard -Value ([System.IO.File]::ReadAllText('${winPath.replaceAll("'", "''")}', [System.Text.Encoding]::UTF8))`;
		// 由明确的PowerShell解释这段脚本，NoProfile不等于执行沙箱。
		const result = await runClipboardCommand("powershell.exe", ["-NoProfile", "-Command", script], {
			timeoutMs: 5000,
		});
		// 成功可为空Buffer，不能用result.length判断是否复制成功。
		return result !== undefined;
	} catch {
		// 回退链需要布尔失败，不把普通文件/命令异常直接给用户。
		return false;
	} finally {
		try {
			// 不论保存/命令是否成功都尝试清理临时路径。
			unlinkSync(tmpFile);
		} catch {
			// The file may not have been created.
		}
	}
}

/** Read plain text from the system clipboard. */
// 无输入，按Termux/有显示的Linux命令顺序读取，失败再用原生，返回文字或null；空成功会停止回退以免读到旧后端内容。
// 例如wl-paste成功但空剪贴板直接null，不继续xclip；原生传输异常在此catch为null，与图片/文件路径入口传播错误不同。
export async function readClipboardText(): Promise<string | null> {
	// 元组数组中每项是程序名和argv，暂存候选，不在push时执行。
	const commands: [string, string[]][] = [];
	// Termux reports platform "android", not "linux" (#10391).
	// Termux标记独立于linux判断，支持Android平台报告。
	if (process.env.TERMUX_VERSION) commands.push(["termux-clipboard-get", []]);
	// 仅Linux再添加显示会话命令，顺序Wayland→X11 xclip→xsel。
	if (platform() === "linux") {
		if (process.env.WAYLAND_DISPLAY) commands.push(["wl-paste", ["--no-newline", "--type", "text"]]);
		if (process.env.DISPLAY) {
			commands.push(["xclip", ["-selection", "clipboard", "-out"]], ["xsel", ["--clipboard", "--output"]]);
		}
	}
	// 顺序await，首个成功结果（包含空Buffer）即返回，不并发读取多个剪贴板内容。
	for (const [command, args] of commands) {
		const bytes = await runClipboardCommand(command, args, { timeoutMs: 5000 });
		// undefined才换候选，成功空文字映射null；非空文字不trim，保留空格/换行。
		if (bytes !== undefined) return bytes.toString("utf8") || null;
	}
	try {
		// 命令均失败/无候选时才用原生模块；缺模块与无文字/空串都映射null。
		return (await getNativeClipboard()?.getText()) || null;
	} catch {
		return null;
	}
}

/** Read file paths, such as Finder file copies, from the native clipboard. */
// 无输入，返回原生公布的非空文件路径数组或null，不读文件内容/检查每条路径；例如Finder复制文件后供界面插入路径。
// 可选模块/可选方法缺失则null，原生Promise拒绝不捕获，交粘贴界面显示错误；返回数组没有复制或冻结。
export async function readClipboardFilePaths(): Promise<string[] | null> {
	// 连续可选链区分模块和能力均可缺省，不自行通过命令枚举文件URL。
	const paths = await getNativeClipboard()?.getFilePaths?.();
	return paths?.length ? paths : null;
}

// 输入文字，异步依次尝试系统写入并按远程/headless策略发送OSC52，成功无返回值，全失败抛具体提示。
// 例如本地macOS原生成功就结束；SSH会在本机写入后额外发客户端OSC52，WSL无显示可用PowerShell，WT_SESSION优先OSC52。
// Linux避免原生写入，以命令保持selection所有权；OSC52成功仅代表已发送，无法确认客户端实际复制。实际命令失败不应误称全部路径均已验证。
export async function copyToClipboard(text: string): Promise<void> {
	// os.platform读取真实宿主平台，和图片入口可选options覆盖不同。
	const p = platform();
	// 保存环境对象引用，没有克隆或修改它。
	const env = process.env;
	// 标记至少一条所选策略报告成功，不是对系统剪贴板再读回验证。
	let copied = false;
	// Direct writes precede OSC 52 so the terminal cannot race the native writer.
	// Linux tools retain clipboard selection ownership after this call returns.
	// 非Linux先试可选原生写接口，Linux直接走能保留选择所有权的命令。
	if (p !== "linux") {
		try {
			const clipboard = getNativeClipboard();
			// 读取能力不代表提供setText，需确认这个可选方法存在。
			if (clipboard?.setText) {
				// 等原生完成后再考虑OSC52，避免本机与终端回写相互竞争。
				await clipboard.setText(text);
				copied = true;
			}
		} catch {
			// Try platform commands next.
		}
	}
	// 原生没成功才准备平台命令，不把所有平台程序都盲试一遍。
	if (!copied) {
		const commands: [string, string[]][] = [];
		// macOS pbcopy、Windows clip是各自候选，其余平台按环境挑Termux/Wayland/X11。
		if (p === "darwin") commands.push(["pbcopy", []]);
		else if (p === "win32") commands.push(["clip", []]);
		else {
			if (env.TERMUX_VERSION) commands.push(["termux-clipboard-set", []]);
			if (env.WAYLAND_DISPLAY) commands.push(["wl-copy", []]);
			if (env.DISPLAY) {
				commands.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
			}
		}
		// 顺序尝试写入，空成功Buffer也足以设copied=true。
		for (const [command, args] of commands) {
			if ((await runClipboardCommand(command, args, { input: text, timeoutMs: 5000 })) !== undefined) {
				copied = true;
				break;
			}
		}
	}
	// 防止WSL专用路径已发OSC52后远程分支又发第二次。
	let osc52Emitted = false;
	// 只有Linux本地写都失败且判定WSL时尝试Windows互操作。
	if (!copied && p === "linux" && isWSL(env)) {
		// Windows Terminal supports OSC 52; prefer it over the slower PowerShell round trip.
		// Windows Terminal标记存在时优先短路径；超编码预算会false而继续PowerShell。
		if (env.WT_SESSION) osc52Emitted = emitOsc52(text);
		// ||短路，已发OSC52时不再写临时文件/启动PowerShell。
		copied = osc52Emitted || (await copyViaWindowsClipboard(text));
	}
	// OSC 52 cannot be verified, so a desktop session with a display reports the failure
	// instead (#9618). Without a display the terminal is the only clipboard route (containers,
	// WSL without WSLg), and remote sessions always emit it to reach the client clipboard.
	// headless是本策略的Linux显示变量判断，不完整探测所有图形会话或Android。
	const headless = p === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.TERMUX_VERSION;
	// 仅在需要OSC52却超限时用于更具体报错，原生已成功则不会因此报失败。
	let oversized = false;
	// 远程会话即使本机复制成功也需发客户端；本地则仅无显示且未成功时才退OSC52。
	if (!osc52Emitted && (isRemoteSession(env) || (!copied && headless))) {
		// 未超限时把发送视作策略成功，不代表远端已确认。
		if (emitOsc52(text)) copied = true;
		else oversized = true;
	}
	// 任一策略成功就完成；即使远程OSC52超限，本机已成功也不会抛oversized。
	if (copied) return;
	// 所有策略失败时按超限→Termux→Linux显示后端→通用顺序选报错。
	if (oversized) throw new Error("Clipboard unavailable: text exceeds the OSC 52 size limit");
	if (env.TERMUX_VERSION) {
		throw new Error("Clipboard unavailable: install the Termux:API app and `termux-api` package");
	}
	if (p === "linux") {
		if (env.WAYLAND_DISPLAY) {
			throw new Error("Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access");
		}
		if (env.DISPLAY) {
			throw new Error("Clipboard unavailable: install `xclip` or `xsel`, or check X11 access");
		}
	}
	throw new Error("Clipboard unavailable");
}
