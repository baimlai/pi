// The launcher's actions (slice 11 §4; fix rounds 1 to 4: Fable's H1, H2, M1, L4, L6 and Opus's M1, M3, L2, L3, E5,
// E6, E9, E12, R1): what the sandbox may ask of the machine, each confirmed by the user on the launcher's own prompt
// before it touches it. Every line the prompt shows is wrapped to the terminal's width, never cut. Copying writes the
// text to the terminal's clipboard (OSC 52, which the output filter refuses to sandboxed code) and shows it first (up
// to five rows, then how many more characters); text with control characters (a newline and a tab aside) or
// bidirectional controls is refused. Opening a URL (http or https, no user info) names its host first and runs the
// platform's opener without a shell (as the coding agent's `open-browser.ts`). Attaching refuses a path with control,
// format or unusual whitespace characters (and on Windows UNC and device paths), shows the path resolved by its text
// (its name on its own line) without looking at the machine, after the user's yes resolves its links and asks again
// when they lead elsewhere, and reads the very file confirmed (its device and inode), a regular file of at most 16 MiB,
// exactly at the size its open handle has.
//
// 文件导读
// 所属：packages/chord 的 Node 终端启动器模块（node/tui），实现沙箱可请求的机器动作及其用户确认。
// 职责边界：本文件只处理 copy（写剪贴板）、open（打开浏览器）、attach（读本地文件）三种动作的校验、提示与执行；
// 不负责消息路由、不持有 token、不直接读写沙箱管道。上游是 launcher.ts 的 #answer：copy/open 调 act，
// attach 调 attach，并传入自己实现的 PromptTerminal。下游是 Node 的 fs、child_process 和用户真实终端。
// 结果：act 返回是否执行，attach 返回 { name, bytes } 或 null（用户拒绝）；非法输入抛 Error，由 launcher 转成 refused。
// 能力清单：
// - PromptTerminal：提问/写终端的接口类型（列数、ask、write）。
// - promptLines / wrap：把提示文本按终端宽度折行并去除控制字符。
// - act：确认并执行 copy 或 open。
// - MAX_ATTACHMENT：附件大小上限 16 MiB。
// - attach：确认并读取一个本地文件，返回名称与字节。
// - attachable（私有）：路径的纯字符串安全检查（控制字符、Windows UNC/设备名）。
// - fileLines / cannotAttach / visible / openable：提示行、统一错误、字符清洗、URL 白名单辅助。
// - openerCommand / platformOpener：生成平台打开命令并尽力启动。
// 组合与顺序：launcher 收到 request → act/attach → 校验 → ask 确认 → 执行 → 返回/抛错；attach 的顺序是
// 文本检查、展示路径、确认、realpath、必要时二次确认、打开句柄、核对 dev/ino、读取。
// 示例：`const ok = await act({ kind: "copy", text: "hello" }, terminal);` 用户答 y 后写 OSC 52 并返回 true。
// 阅读顺序：先看 PromptTerminal 与 promptLines/wrap，再看 act，然后 attach 及其安全辅助函数。

// spawn 用于打开浏览器；不使用 shell，避免 URL 被 shell 解释。
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { BridgeRequest } from "../../tui/bridge.ts";

/**
 * The launcher's prompt on the real terminal, `columns` wide: `ask` shows `lines` (the question last) and resolves
 * with the user's answer, yes or no; `write` writes to the terminal past the output filter (the launcher's own
 * sequences).
 */
export type PromptTerminal = {
	// 终端总列数，用来计算换行宽度。
	readonly columns: number;
	// 显示若干行（最后一行是问题），等待用户 y/N；返回 true 表示同意。实现方是 launcher.ts 的真实终端。
	ask(lines: readonly string[]): Promise<boolean>;
	// 绕过沙箱输出过滤器，直接写启动器自己的终端序列（例如 OSC 52 剪贴板）。
	write(data: string): void;
};

/** The prompt's rows for `lines` at `columns` wide: control characters removed, each line wrapped, never cut. */
// 把多行提示展开成终端行：每一行先经 visible 去控制字符，再按宽度换行，不截断。
// 输入 readonly string[] 表示不修改调用方数组；返回新数组。
// 例子：columns=80 传入 ["hello"] 返回同样的可见行（可能被拆成多行）。
export function promptLines(lines: readonly string[], columns: number): string[] {
	// flatMap 先映射再摊平：每行 wrap 返回多行，最终得到一个扁平数组。
	return lines.flatMap((line) => wrap(line, promptWidth(columns)));
}

/** The text width of a prompt row (one column of padding each side). */
// 可用宽度 = 终端列数减去左右各 1 列内边距；下限 10 防止极窄终端算出 0 或负数导致死循环。
function promptWidth(columns: number): number {
	return Math.max(10, columns - 2);
}

/**
 * `line` with control characters removed, in rows of at most `width` columns, counting every character but printable
 * ASCII as two (wide characters never push text past the edge, where the next row would cover it).
 */
// 按终端列宽折行：返回若干行，内容不丢字符（除非是 visible 去掉的控制字符）。
// 宽度按“显示单元格”估算：可打印 ASCII 记 1 列，其余（CJK、emoji 等）保守记 2 列。
// 不切断代理对：for...of 按 Unicode 码点迭代，而不是按 UTF-16 码元，所以 emoji 不会被拆成两半。
// 例子：width=4、line="abcdef" 返回 ["abcd", "ef"]；line="中文" 返回 ["中文"]（两个字符各占 2 列）。
export function wrap(line: string, width: number): string[] {
	const rows: string[] = [];
	// 当前正在拼的行和它已占用的列数。
	let row = "";
	let used = 0;
	// 逐码点处理；visible 先剔除控制/格式字符，避免它们影响宽度或终端行为。
	for (const character of visible(line)) {
		// 三目比较字符串是按码元值比较；" " 到 "~" 即可打印 ASCII。
		const cells = character >= " " && character <= "~" ? 1 : 2;
		// 放不下就先结束当前行（即使 row 为空，宽度极小时也能推进，但 promptWidth 已保证 >= 10）。
		if (used + cells > width) {
			rows.push(row);
			row = "";
			used = 0;
		}
		// 追加字符并累计列数。
		row += character;
		used += cells;
	}
	// 最后一行（可能为空字符串：输入为空时仍返回一个空行，调用方无需特判）。
	rows.push(row);
	return rows;
}

/** How many rows of a copied text the prompt shows before "and N more characters". */
// 复制预览最多显示 5 行，其余只显示“还有多少字符”，避免超长文本淹没确认问题。
const SHOWN_ROWS = 5;

/**
 * Does the sandbox's `request` (`copy`, `open`) once the user confirmed it: whether it was done. Throws (the request
 * refused) for text it will not copy and URLs it will not open. `opener` opens a URL (the platform's by default).
 */
// 执行已获用户确认的 copy 或 open 请求；返回用户是否同意并已执行。
// 输入：窄化后的请求（Extract 从联合中只取 copy/open 两种）、提示终端、可注入的 opener（默认平台实现，便于测试）。
// 副作用：向终端提问、写剪贴板序列、可能启动浏览器进程。错误：含控制字符的文本或非法 URL 直接抛错。
// 例子：用户对 `{kind:"copy",text:"hi"}` 回答 y，函数写 OSC 52 并返回 true；回答 n 返回 false 且不写剪贴板。
export async function act(
	request: Extract<BridgeRequest, { kind: "copy" | "open" }>,
	terminal: PromptTerminal,
	opener: (url: string) => Promise<void> = platformOpener,
): Promise<boolean> {
	// 分支一：复制文本。
	if (request.kind === "copy") {
		// 解构出文本；类型已由请求种类收窄。
		const { text } = request;
		// Control characters (but newlines and tabs) and bidirectional controls could hide what a paste runs.
		// 正则排除：除换行/制表外的 C0 控制符、DEL 与 C1、以及双向控制符（可让显示顺序与真实内容不同）。
		// 这是运行时校验，因为 text 来自沙箱（信任边界）。
		if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(text)) {
			throw new Error("copy: the text holds control characters");
		}
		// 先按换行分行，便于计数和预览。
		const lines = text.split("\n");
		// Wrapped, never cut: a long line's end is where a pasted command would hide (Opus E6).
		// 预览再留 2 列用于行首缩进，保证最长行也不会被终端裁掉。
		const rows = lines.flatMap((line) => wrap(line, promptWidth(terminal.columns) - 2));
		// 第 6 行起的字符数；reduce 累加，初始值 0。
		const hidden = rows.slice(SHOWN_ROWS).reduce((sum, row) => sum + row.length, 0);
		// 问题行包含字符数与行数；单数/复数用三目处理。
		const question = `Copy these ${text.length} characters (${lines.length} line${lines.length === 1 ? "" : "s"})? [y/N]`;
		// 预览行：前 5 行加两格缩进；若还有隐藏内容，再追加提示。展开语法把两个数组合并。
		const shown = [
			...rows.slice(0, SHOWN_ROWS).map((row) => `  ${row}`),
			...(hidden > 0 ? [`  … and ${hidden} more characters`] : []),
		];
		// ask 返回 false（或用户直接回车）就放弃，不触碰剪贴板。
		if (!(await terminal.ask([...shown, question]))) return false;
		// OSC 52 设置剪贴板：内容必须 base64，BEL 结束；沙箱发来的输出无法使用该序列（过滤器会丢弃）。
		terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		return true;
	}
	// 分支二：打开 URL；openable 同时做语法与协议白名单校验。
	const url = openable(request.url);
	// undefined 表示不是 http/https 或带用户名/密码，直接拒绝。
	if (url === undefined) throw new Error("open: only http and https URLs without user info open");
	// 提示中先显示完整 href，再说明将打开的 host；用户拒绝则返回 false。
	if (!(await terminal.ask([`  ${url.href}`, `Open ${url.host} in the browser? [y/N]`]))) return false;
	// 调用平台 opener；它自己吞掉启动错误，因此这里通常不会抛。
	await opener(url.href);
	return true;
}

/** The largest file the sandbox may be given: 16 MiB. */
export const MAX_ATTACHMENT = 16 * 1024 * 1024;

/**
 * Reads the file at `path` (as the sandbox gave it; `~/` the home directory) for the sandbox once the user confirmed
 * it: its name and bytes, or `null` when declined. Refused at once: a path with control, format or unusual whitespace
 * characters, and on Windows a UNC, device or `//host` path or a reserved device name. Nothing on the machine is looked
 * at before the user's yes (Opus E9: on Windows a lookup of `\\host\share` alone sends the user's credentials): the
 * prompt shows the path resolved by its text (`~`, `.` and `..`); after the yes its links are resolved, and a path
 * that leads elsewhere is asked about again, showing where; what is opened must be the file confirmed (its device and
 * inode as when the last prompt was shown). Then it is opened without blocking (a FIFO waits for no
 * writer: Opus E12) and read only when it is a regular file of at most `MAX_ATTACHMENT` bytes; one refusal for anything
 * else (no hint what is there).
 */
// 读取用户确认过的一个本地文件，交给沙箱作为附件；用户拒绝时返回 null。
// 输入：沙箱给的路径（支持开头的 `~`）、提示终端、平台（默认 process.platform，可注入以便测试 Windows 分支）。
// 输出：`{ name, bytes }`，name 是最终文件的 basename，bytes 是实际读取的字节；拒绝返回 null。
// 副作用：两次可能向用户提问、解析路径、打开并读取文件。错误：路径不可显示、文件不存在/非普通文件/超限都抛统一错误。
// 主流程：先做纯文本校验 → 展示解析后的路径并获得同意 → realpath 解析链接 → 若指向别处再问一次 →
// 以 O_NOFOLLOW/O_NONBLOCK 打开 → 核对 dev/ino 与尺寸 → 精确读取 size 字节。
// 关键点：用户同意之前不访问磁盘（避免 UNC 路径泄露凭据），同意之后读取的必须是用户看到的那个文件。
// 例子：attach("~/notes.txt", terminal, "linux") 可能先问是否附加 /home/u/notes.txt；若是符号链接，会再问一次。
export async function attach(
	path: string,
	terminal: PromptTerminal,
	platform: NodeJS.Platform = process.platform,
): Promise<{ readonly name: string; readonly bytes: Uint8Array } | null> {
	// 第一道门：只做字符串检查，不碰文件系统。
	if (!attachable(path, platform)) throw cannotAttach();
	// 按目标平台选择路径实现，而不是宿主平台；这样 Windows 路径测试可在任意系统运行。
	const paths = platform === "win32" ? win32 : posix;
	// 展开开头的 `~`（单独一个 ~ 或 ~/、~\ 开头）；path.slice(1) 去掉波浪号，再与 home 拼接。
	// 注意 `~user` 形式不展开，保持原样交给 resolve。
	const home = /^~(?:$|[\\/])/.test(path) ? paths.join(homedir(), path.slice(1)) : path;
	// resolve 把相对路径按当前目录变成绝对路径，并规范化 `.` 与 `..`；纯字符串操作，不解析符号链接。
	const named = paths.resolve(home);
	// 第一次确认：显示文件名、目录和问题；拒绝则返回 null（不是错误）。
	if (!(await terminal.ask(fileLines(named, paths, "Attach this file? [y/N]")))) return null;
	// 同意后才访问磁盘。realpath 解析所有符号链接；失败（不存在、权限）时转为 undefined。
	const file = await realpath(named).catch(() => undefined);
	// 解析失败统一报“不能附加”，不区分具体原因，避免泄露文件系统信息。
	if (file === undefined) throw cannotAttach();
	// The file the user confirms, by identity: what is read must be it (Opus R1: a parent directory swapped for a link
	// after the yes would lead elsewhere, past `O_NOFOLLOW`, which guards the last step only).
	// 用 bigint 读取 dev/ino/size，避免大文件或大 inode 号在 Number 中丢精度；失败同样转 undefined。
	const shown = await stat(file, { bigint: true }).catch(() => undefined);
	// 拿不到元数据就无法保证读取的是同一个文件。
	if (shown === undefined) throw cannotAttach();
	// realpath 结果与用户看到的路径不同，说明中间有符号链接；必须展示真实目标并再次确认。
	// 用户拒绝则返回 null，表示“附加被取消”，不抛错。
	if (file !== named && !(await terminal.ask(fileLines(file, paths, "It links here. Attach this file? [y/N]")))) {
		return null;
	}
	// No waiting on a FIFO or device, and no link swapped in at the last step since the user saw the path.
	// O_NONBLOCK：若目标意外是 FIFO，open 不会阻塞等待写端；O_NOFOLLOW：最后一段是链接则失败。
	// `?? 0` 是因为某些平台可能没有这些常量，缺失时退化为不加标志。
	const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
	// 打开失败（权限、链接、设备等）统一转 undefined；句柄在 finally 中关闭。
	const handle = await open(file, flags).catch(() => undefined);
	if (handle === undefined) throw cannotAttach();
	try {
		// 以打开后的句柄再取一次元数据：这是“真正要读的文件”，而不是之前 stat 的路径。
		const info = await handle.stat({ bigint: true });
		// 设备号与 inode 都相同才算同一个文件；防止用户在两次提问之间替换路径。
		if (info.dev !== shown.dev || info.ino !== shown.ino) throw cannotAttach();
		// 只接受普通文件；size 是 bigint，所以阈值也用 BigInt 比较，避免隐式转换。
		if (!info.isFile() || info.size > BigInt(MAX_ATTACHMENT)) throw cannotAttach();
		// Exactly its size now: a file growing meanwhile is read up to what was checked.
		// 按检查时的尺寸分配；即使文件之后继续增长，也只读到这个长度。
		const bytes = new Uint8Array(Number(info.size));
		let read = 0;
		// 循环读取直到填满或遇到 EOF（文件在检查后缩短时可能提前结束）。
		while (read < bytes.length) {
			// read(buffer, offset, length, position)：position 用绝对偏移，不依赖文件指针。
			// 解构出 bytesRead；返回 0 表示 EOF。
			const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
			if (bytesRead === 0) break;
			read += bytesRead;
		}
		// 返回实际读到的前缀（文件缩短时不会带未初始化字节）；name 用真实文件的 basename。
		return { name: paths.basename(file), bytes: bytes.subarray(0, read) };
	} finally {
		// 无论成功、抛错还是提前 return，都关闭句柄，避免泄漏文件描述符。
		await handle.close();
	}
}

/**
 * Whether `path` may be shown and, once confirmed, opened on `platform`: no character that hides or moves what the
 * prompt shows (controls, format characters such as bidirectional and zero-width ones, whitespace but single spaces
 * between words: Opus E5), and on Windows no UNC, device or `//host` path and no reserved device name (Opus E9).
 */
// 判断路径是否可以展示并（经确认后）打开。纯字符串判断，不访问磁盘，因此可安全地在用户同意前调用。
// 返回 true 表示可继续；false 表示拒绝，调用方统一抛 cannotAttach。
// 规则一：拒绝控制字符 Cc、格式字符 Cf（双向、零宽等）、行/段分隔符 Zl/Zp、除单个空格外的所有空白，
//         并拒绝连续两个空格或首尾空格——这些都可能让显示内容与真实路径不一致。
// 规则二（仅 Windows）：拒绝 `\\` 或 `//` 开头的 UNC/设备路径（访问它们可能泄露凭据），
//         并拒绝各路径段是 CON、PRN、AUX、NUL、COM1、LPT1、CONIN$、CONOUT$ 等保留设备名（含带扩展名形式，大小写不敏感）。
// 例子：Linux 上 "/tmp/a b.txt" 返回 true；"/tmp/a\tb" 返回 false；Windows 上 "\\\\host\\share" 返回 false。
function attachable(path: string, platform: NodeJS.Platform): boolean {
	if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|[^\S ]| {2}|^ | $/u.test(path)) return false;
	if (platform !== "win32") return true;
	if (/^[\\/]{2}/.test(path)) return false;
	return !path
		.split(/[\\/]/)
		.some((segment) => /^(?:con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(?:\..*)?$/i.test(segment));
}

/** The prompt's lines for the file at `file`: its name, its directory, then `question`. */
// 生成附件确认提示的三行：文件名、所在目录、问题。`typeof posix` 表示只需 basename/dirname 等路径函数，
// 传入 win32 或 posix 都满足这个结构类型（编译期检查，运行时不区分）。
// 注意这里只做字符串切割，不调用 fs，所以显示阶段不会触发磁盘访问。
// 例子：file="/home/u/notes.txt"、question="Attach this file? [y/N]" 得到三行文本。
function fileLines(file: string, paths: typeof posix, question: string): string[] {
	return [`File: ${paths.basename(file)}`, `In:   ${paths.dirname(file)}`, question];
}

// 构造统一的附件拒绝错误；所有失败原因共用一个消息，避免向沙箱泄露文件是否存在等信息。
function cannotAttach(): Error {
	return new Error("attach: that file cannot be attached");
}

/** `text` with control and format characters (bidirectional, zero width) removed: sandboxed text in the prompt. */
// 去除控制字符（Cc）和格式字符（Cf，含双向控制、零宽连接符等），返回可安全放进提示的文本。
// 正则的 u 标志让 \p{...} 按 Unicode 属性匹配，g 标志替换所有出现。只影响显示副本，不改变沙箱真实文本。
function visible(text: string): string {
	return text.replace(/[\p{Cc}\p{Cf}]/gu, "");
}

/** `url` when it is an http or https URL without user info; else `undefined`. */
// 解析并校验 URL：只允许 http/https，且不能带 username/password（防止把凭据放进地址展示或传给浏览器）。
// 解析失败（不是合法 URL）时 catch 返回 undefined。返回 URL 对象，调用方可安全使用 href/host。
// 例如 "https://example.com/x" 返回 URL；"file:///etc/passwd"、"https://u:p@host" 返回 undefined。
function openable(url: string): URL | undefined {
	try {
		// URL 构造函数会抛 TypeError（或平台相关错误）表示输入不合法。
		const value = new URL(url);
		// 显式比较带冒号的协议字符串；URL 会把协议规范化为小写。
		const web = value.protocol === "http:" || value.protocol === "https:";
		// 两个条件都满足才返回对象；用户名或密码非空一律拒绝。
		return web && value.username === "" && value.password === "" ? value : undefined;
	} catch {
		// 不使用错误对象；统一按“不可打开”处理。
		return undefined;
	}
}

/**
 * The command and arguments opening `url` on `platform`, as the coding agent opens a browser (`open-browser.ts`): never
 * a shell (on Windows not `cmd /c start`, whose parsing runs what follows a `&`): `rundll32
 * url.dll,FileProtocolHandler <url>` on Windows, `open` on macOS, `xdg-open` elsewhere, the URL one argument.
 */
// 返回打开 URL 的命令与参数（元组类型 [string, string[]]），按平台选择：
// Windows 用 rundll32 的 FileProtocolHandler，macOS 用 open，其他平台用 xdg-open。
// 绝不用 shell（Windows 上也不用 `cmd /c start`），因为 shell 会解释 URL 中的 `&` 等字符，可能执行额外命令。
// URL 始终作为单独一个参数传递。例子：macOS 下返回 ["open", ["https://example.com/"]]。
export function openerCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
	if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
	return [platform === "darwin" ? "open" : "xdg-open", [url]];
}

/** Opens `url` with the platform's opener (`openerCommand`), detached, best effort: a missing opener is no crash. */
// 尽力打开浏览器：启动失败不抛给调用方，也不让子进程拖住启动器退出。
// 副作用：创建子进程。返回的 Promise 在 spawn 调用后立即完成，不等待浏览器退出。
// `stdio: "ignore"` 丢弃输出；`detached: true` 让子进程独立；`cwd: "/"` 避免继承启动器目录（WSL 长路径问题）；
// `shell: false` 明确禁止 shell 解析。`on("error")` 吞掉 ENOENT 等错误，`unref()` 允许父进程先退出。
async function platformOpener(url: string): Promise<void> {
	// 解构元组；类型由 openerCommand 的返回类型保证。
	const [command, args] = openerCommand(url);
	// The root as its directory: no opener needs the launcher's (a WSL path too long for explorer.exe, pi #11592).
	spawn(command, args, { stdio: "ignore", detached: true, cwd: "/", shell: false })
		.on("error", () => {})
		.unref();
}
