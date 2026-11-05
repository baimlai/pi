// 管理SSH目标参数、主机键显式信任、平台探测与daemon内容校验/上传，再为Connection提供按需启动命令；扫描指纹、信任决定和实际连接分开处理。
// spawn启动本机ssh/ssh-keygen程序，参数数组不经本机shell，但远端command仍由目标shell解释。
import { spawn } from "node:child_process";
// createHash算本地二进制内容摘要，randomBytes生成临时文件后缀；摘要不替代主机身份认证。
import { createHash, randomBytes } from "node:crypto";
// existsSync只用于存在性分支，检查与随后读写不是原子操作。
import { existsSync } from "node:fs";
// 异步文件API用于临时扫描目录、known_hosts重写及读取本地daemon；这些调用都可能拒绝Promise。
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
// tmpdir是本机系统临时目录，不是探测出的远端临时路径。
import { tmpdir } from "node:os";
// dirname/join处理本机路径；远端Windows/POSIX路径在后面按目标格式拼接。
import { dirname, join } from "node:path";
// 把模块file URL转本机文件路径，避免把URL编码直接当文件名。
import { fileURLToPath } from "node:url";
// Connection负责daemon帧流/hello/重连；type ConnectionOptions只提供回调类型，不额外加载另一个运行对象。
import { Connection, type ConnectionOptions } from "./connection.ts";

/** A remote system the package ships a daemon for. */
// 探测后使用的静态平台描述，只列本包支持的系统/架构，不表示声明本身会检测远端。
export type RemotePlatform = {
	// 字符串字面量联合限制TS代码能填的系统名；darwin是Node对macOS的拼写。
	platform: "linux" | "android" | "darwin" | "windows";
	// 只支持x64/arm64，探测其他架构会抛，不自动选相近二进制。
	arch: "x64" | "arm64";
	/** The remote home directory, in the remote system's own spelling. */
	// home保留远端拼写，用于部署目录；不是本机HOME，未在此保证非空或已规范化。
	home: string;
	/** Windows: the shell `sshd` runs commands with (`DefaultShell`). */
	// detectPlatform只在Windows结果填shell；?是可省字段，两个值来自后面的echo启发式，不是读取注册表的完整证明。
	shell?: "cmd" | "powershell";
	/** Problems worth telling the owner about, such as Termux without `termux-exec`. */
	// 警告文字供调用者显示，存在警告并不在这里阻止连接或修复Termux环境。
	warnings: string[];
};

/** How to reach a machine with the system `ssh`. */
// SSH目标配置，来自应用；接口只做TS检查，实际部分字段在sshArguments/公钥解析边界检查。
export interface SshTarget {
	/** Host name or `~/.ssh/config` alias. */
	// host可以是主机名或ssh配置别名，不自动做DNS解析/URL拆分。
	host: string;
	// user可省，缺省交系统ssh决定，而不是默认仓库当前用户。
	user?: string;
	// port是number但TS不保证整数/范围，sshArguments会实际检查1..65535。
	port?: number;
	// 本机私钥路径，后面作为IdentityFile选项；本层不读取或校验密钥内容。
	identityFile?: string;
	/** Host keys this application trusts; `acceptHostKey` adds to it. */
	// 应用明确选定的本机信任文件，accept/forget会改它；不默认写用户~/.ssh/known_hosts。
	knownHostsFile: string;
	/** The name keys are stored under, independent of aliases, ports and jump hosts, e.g. `pi-env-<env name>`. */
	// HostKeyAlias把信任记录绑定应用固定名字；不是自动证明host、跳板或DNS的身份。
	hostKeyAlias: string;
	/** The `ssh` program; default `ssh`. */
	// 可选本机ssh程序路径/命令名，缺省ssh；此字段自身不经过checkField或存在性检查。
	ssh?: string;
	/** An `ssh` configuration file instead of `~/.ssh/config` (`-F`). */
	// 可选-F配置文件，作为独立argv直接传给ssh；不会在这里读取其内容或套configPath转义。
	configFile?: string;
}

/** The remote host's key is not in `knownHostsFile`; `scanHostKey` shows it so the owner can accept it. */
// 标记未知/未受信任主机键的错误类；继承Error默认构造，无自定义name/code；主要由runSsh的诊断文字匹配产生，不是密码学验证器。
export class HostKeyUnknownError extends Error {}

/** The remote host's key differs from the one in `knownHostsFile`; it is never accepted automatically. */
// 标记已信任同类键发生变化；只建异常对象，是否删除旧键由应用另行调用forget决定，不会自动接受新键。
export class HostKeyChangedError extends Error {}

/** An `ssh` invocation that failed for another reason, with its exit code and diagnostics. */
// 其他SSH失败的包装，保退出码与原stderr供诊断；构造不启动进程，不脱敏日志。例超时的exitCode为null。
export class SshError extends Error {
	// readonly只限制TS重赋；null表示未取得正常退出码，例如启动失败/超时。
	readonly exitCode: number | null;
	// 原始诊断字符串，可能含控制序列或秘密，不在本类过滤。
	readonly stderr: string;

	// 输入消息、可为null的退出码和诊断，构造SshError；直接存值，无I/O或额外校验，例new SshError("failed",255,"denied")。
	constructor(message: string, exitCode: number | null, stderr: string) {
		// super初始化Error消息，未把name改为SshError。
		super(message);
		// 保留数字或null原值，不推断失败原因。
		this.exitCode = exitCode;
		// 保存原stderr，调用者可区分展示消息与完整诊断。
		this.stderr = stderr;
	}
}

// 以当前src/或dist/模块向上一级定位包目录；这里只算路径，不检查bin文件已安装。
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** No leading `-` (it would be read as an `ssh` option) and no whitespace or control characters. */
// 检查host/user/alias的文字边界，正常返回void，坏值抛Error。例"bad host"拒绝；不联网、不做完整OpenSSH别名/主机语法校验。
function checkField(name: string, value: string): void {
	// 拒空串、开头-、JS空白、C0和DEL；正则无g可反复test。并非验证所有Unicode控制/SSH模式字符都不存在。
	if (value === "" || value.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(value)) {
		// 错误带字段名与JSON转义值，不是从远端取的失败。
		throw new Error(`Invalid ${name}: ${JSON.stringify(value)}`);
	}
}

/** A path for an `ssh` option that expands `%` tokens: quoted, with `%` literal. */
// configPath输入显示用字段名与本机路径，返回SSH配置选项里的带双引号路径文字；例含%转%%。无I/O，非法引号/控制字符抛；这是SSH配置格式，不是通用shell转义。
function configPath(name: string, path: string): string {
	// 拒空路径、双引号、C0/DEL；允许普通空格，不检查文件实际存在或可读。
	if (path === "" || /["\x00-\x1f\x7f]/.test(path)) throw new Error(`Invalid ${name}: ${JSON.stringify(path)}`);
	// 所有%成对以保字面含义，再包一对双引号；输出引号是argv项内部的配置语法。
	return `"${path.replaceAll("%", "%%")}"`;
}

/**
 * Arguments for `ssh` up to the host: no prompts, no forwarding of any kind, no shared connections, no commands from
 * the configuration, no locale forwarding (the remote uses its own), and host keys checked strictly against the
 * application's own file under a fixed alias.
 */
// 组装到host为止的ssh argv，返回新string[]且不执行SSH。例sshArguments({host:"box",hostKeyAlias:"env",knownHostsFile:"/tmp/keys"})默认严格查键；先验部分字段再按选项展开，失败同步抛。
export function sshArguments(
	// 目标配置原引用，只读取不修改。
	target: SshTarget,
	// 默认true用yes；扫描专门传false切accept-new，并非所有调用都禁用严格检查。
	strictHostKeys = true,
	// 默认应用信任文件，扫描可覆盖成新临时文件；缺省参数按本次target读取。
	knownHostsFile = target.knownHostsFile,
): string[] {
	// host在拼argv前过有限文字检查。
	checkField("host", target.host);
	// 固定alias也过同一检查，不会校验其是否含SSH模式语法。
	checkField("host key alias", target.hostKeyAlias);
	// user只在显式提供时检查，空串不能靠缺省逃过。
	if (target.user !== undefined) checkField("user", target.user);
	// number端口仍须做整数与范围检查，缺省不发送-p。
	if (target.port !== undefined && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) {
		// 非法端口同步抛，尚未spawn任何子进程。
		throw new Error(`Invalid port: ${target.port}`);
	}
	// 局部option把一项配置包装为["-o",setting]两项数组；例BatchMode=yes，不把整个argv拼成命令字符串。
	const option = (setting: string) => ["-o", setting];
	// 返回字面数组，...逐项展开子数组，保证每个-o及其值是独立参数。
	return [
		// configFile若提供就加-F与原路径；空格仍在同一个参数里，不经本机shell分词。
		...(target.configFile === undefined ? [] : ["-F", target.configFile]),
		// -T禁分配SSH伪终端，daemon的二进制帧不应经过TTY转换。
		"-T",
		// -a禁agent转发，不是禁止本机SSH用agent作客户端认证。
		"-a",
		// -x禁X11转发。
		"-x",
		// BatchMode关闭密码/口令交互提示，认证失败应由调用者处理。
		...option("BatchMode=yes"),
		// 清除配置中的端口转发，减少连接附带行为。
		...option("ClearAllForwardings=yes"),
		// 再显式禁agent转发。
		...option("ForwardAgent=no"),
		// 再显式禁X11转发。
		...option("ForwardX11=no"),
		// 禁复用一个ControlMaster连接。
		...option("ControlMaster=no"),
		// ControlPath为none，不使用控制socket路径。
		...option("ControlPath=none"),
		// 不执行配置里预设RemoteCommand，后面另传本模块命令。
		...option("RemoteCommand=none"),
		// 不运行配置的LocalCommand，配置文件本身仍由ssh解析。
		...option("PermitLocalCommand=no"),
		// 清SendEnv转发项，不把本机locale等环境按该机制带过去；不表示清空远端全部环境。
		...option("SendEnv=-*"),
		// 请求ssh每15秒发server-alive消息，非本模块60秒操作timer，也非daemon帧PING。
		...option("ServerAliveInterval=15"),
		// 按参数选yes或accept-new；本模块扫描传false并改临时路径，false本身不检查传入路径是否真为临时文件。
		...option(`StrictHostKeyChecking=${strictHostKeys ? "yes" : "accept-new"}`),
		// 指定选定known_hosts路径，并按SSH配置值规则保护空格/%；不加载用户默认信任表作为这个选项值。
		...option(`UserKnownHostsFile=${configPath("known hosts file", knownHostsFile)}`),
		// 不使用全局known_hosts文件。
		...option("GlobalKnownHostsFile=none"),
		// 新记录不做hostname哈希，方便按应用alias文本管理；不等于公钥没有密码学哈希指纹。
		...option("HashKnownHosts=no"),
		// 在固定alias名下查/记键，不直接按host/端口名各建一份信任。
		...option(`HostKeyAlias=${target.hostKeyAlias}`),
		// 提供user才加-l，未提供交SSH配置/默认策略。
		...(target.user === undefined ? [] : ["-l", target.user]),
		// 合法端口转文字后独立跟在-p后。
		...(target.port === undefined ? [] : ["-p", String(target.port)]),
		// 仅指定identityFile时增加以下密钥选项。
		...(target.identityFile === undefined
			? // 未指定就展开空数组，保留SSH自身身份选择逻辑。
				[]
			: // 指定时返回两组-o配置供外层展开，不是嵌套数组作为最终argv项。
				[
					// 身份文件也用configPath处理；本地路径不作为远端shell脚本插值。
					...option(`IdentityFile=${configPath("identity file", target.identityFile)}`),
					// IdentitiesOnly限制SSH采用配置的身份选择，不由本函数解析私钥。
					...option("IdentitiesOnly=yes"),
				]),
		// --终结本次SSH命令的选项解析。
		"--",
		// host是最后一项，具体远端command由runSsh或Connection命令工厂后追加。
		target.host,
	];
}

/** How long a detection, check or upload over `ssh` may take before it is abandoned. */
// 普通探测/校验的60秒目标，由runSsh在spawn后建timer，不是SSH连接能严格准时结束的保证。
const SSH_TIMEOUT_MS = 60_000;
// 上传允许300秒，同样只是拒绝/kill尝试的计时目标。
const UPLOAD_TIMEOUT_MS = 300_000;

/** Run one remote command over `ssh`, optionally feeding stdin; resolves with stdout, rejects on failure. */
// runSsh接目标、远端命令与可选stdin/argv/超时，返回完整stdout文字Promise。会启动本机ssh并进行网络/远端操作；例探测uname。非零/超时/启动错误拒绝，输出无大小上限，发kill不等远端或子进程已退出。
function runSsh(
	// 配置决定本机ssh可执行文件与主机参数。
	target: SshTarget,
	// command作为SSH最后一项交远端shell解释，不因为本机spawn未用shell就免除远端引用要求。
	command: string,
	// 内联对象类型说明三项都可省；stdin是原始字节，args可替换整份SSH参数，timeoutMs是毫秒。
	options: { stdin?: Uint8Array; args?: string[]; timeoutMs?: number } = {},
): Promise<string> {
	// Promise执行器同步设进程/监听，之后由事件结算；执行器内同步抛也成为拒绝，未全面回滚已起资源。
	return new Promise((resolve, reject) => {
		// 有args原样用，否则现算sshArguments；??保留空数组，并不再次检查传入自定义args。
		const args = options.args ?? sshArguments(target);
		// 本机spawn使用独立argv和三pipe，不开本机shell；收集远端命令的stdout/stderr。
		const child = spawn(target.ssh ?? "ssh", [...args, command], { stdio: ["pipe", "pipe", "pipe"] });
		// 操作超时以选项为先，缺省60秒，没有验证任意负数/非有限超时。
		const timeoutMs = options.timeoutMs ?? SSH_TIMEOUT_MS;
		// timer异步触发，调度延迟可晚于目标；它不是Promise自动取消机制。
		const timer = setTimeout(() => {
			// 对直接child发默认SIGTERM，忽略boolean返回值且不等待close，不保证远端程序已停。
			child.kill();
			// 只取此刻已收到的stderr，不等管道排空，也不剥控制序列。
			const diagnostics = Buffer.concat(stderr).toString("utf8");
			// 超时用reject尝试结算，若先前已结算则不会再改变结果。
			reject(
				// 构造保诊断的SSH通用错误，不走主机键文字分类。
				new SshError(
					// 展示消息把毫秒换秒并trim诊断两端，完整stderr仍另存。
					`ssh ${target.host} did not finish within ${timeoutMs / 1000} s: ${diagnostics.trim()}`,
					// 此刻未取得正常退出码，用null。
					null,
					// 保原始诊断文字供上层读取。
					diagnostics,
				),
			);
			// 本机setTimeout按timeoutMs安排，未unref；不是让线程阻塞等待。
		}, timeoutMs);
		// stdout按Buffer块收集到close再拼接，不在每块中解码。
		const stdout: Buffer[] = [];
		// stderr同样积累，未设尾部/字节限制。
		const stderr: Buffer[] = [];
		// data回调只push引用，返回的数组长度被忽略，不结算Promise。
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		// stderr块与stdout分开存，最终不是按跨流总到达顺序合并。
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		// 吞stdin error事件；错误结算仍依进程事件/超时，不把EPIPE逐个暴露。
		child.stdin.on("error", () => {});
		// 进程error例如无法spawn，在此记录；与稍后close可能同时发生。
		child.on("error", (error) => {
			// error到来取消本次timer，避免再发超时拒绝。
			clearTimeout(timer);
			// spawn错误保message，未附这时已收诊断；Promise按首次结算生效。
			reject(new SshError(error.message, null, ""));
		});
		// close表示进程及stdio关闭，监听只接code，未另接signal参数。
		child.on("close", (code) => {
			// 无论成功/失败close都清操作timer。
			clearTimeout(timer);
			// 拼完stdout再统一UTF-8解码，跨块多字节可一起解，坏字节按替换规则。
			const output = Buffer.concat(stdout).toString("utf8");
			// stderr也统一解码，随后通过诊断文字启发式分类。
			const diagnostics = Buffer.concat(stderr).toString("utf8");
			// 严格code===0就成功返回stdout，即便stderr有警告也不按警告拒绝。
			if (code === 0) return resolve(output);
			// 优先识别这个英文主机键变化片段，不保证所有SSH实现/语言诊断都匹配。
			if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(diagnostics)) {
				// 返回reject的undefined只结束该回调，不抛同步异常给EventEmitter。
				return reject(
					// 只提示需处理旧键，不自动删除/接受新键；错误本身不保原SshError诊断字段。
					new HostKeyChangedError(`The host key of ${target.host} changed; remove the old key to continue`),
				);
			}
			// 再识别未知键/验证失败英文片段；某些其他验证失败也可被归到此类，不是从SSH结构化错误码判断。
			if (/Host key verification failed|No .* host key is known/.test(diagnostics)) {
				// 归为HostKeyUnknownError，应用可以另行扫描展示指纹。
				return reject(new HostKeyUnknownError(`The host key of ${target.host} is not trusted yet`));
			}
			// 其他非零/null退出都落SshError通用拒绝。
			reject(
				// message附trim后的诊断，stderr字段保完整原文，code可为null。
				new SshError(`ssh ${target.host} failed with exit code ${code}: ${diagnostics.trim()}`, code, diagnostics),
			);
		});
		// 把可选字节送stdin并end；缺省空字节表示不送正文后EOF，不等待flush，也不自行分块/按背压等待。
		child.stdin.end(options.stdin ?? new Uint8Array(0));
	});
}

/**
 * Connect once with `accept-new` against a temporary known-hosts file to capture the key the host presents, through
 * the same route (`~/.ssh/config`, jump hosts) as real connections. Returns its known-hosts lines and fingerprints.
 * Showing a fingerprint is not authentication: compare it with one obtained out of band before accepting it.
 */
// 扫描目标所呈现的主机键，返回known_hosts文本行和ssh-keygen指纹行。例先scan给所有者核对带外指纹再accept；这里会SSH连接、创建本机临时文件并起keygen，但不写应用最终信任文件，扫描成功不等于认证可信。
export async function scanHostKey(target: SshTarget): Promise<{ lines: string[]; fingerprints: string[] }> {
	// 创建随机临时目录；这一步若失败尚未进入try，无需清理不存在的扫描目录。
	const directory = await mkdtemp(join(tmpdir(), "pi-env-hostkey-"));
	// 后续成功/失败都尝试finally删扫描目录，清理失败也可让函数拒绝。
	try {
		// 临时known_hosts专用于此次扫描，不复用用户或应用已有信任。
		const scanned = join(directory, "known_hosts");
		// Authentication may fail without the key; the key is recorded before authentication.
		// 用同一路由参数但accept-new及临时文件连一次exit 0；用户认证即使失败，SSH可能已先记录服务器公钥。
		await runSsh(target, "exit 0", { args: sshArguments(target, false, scanned) }).catch((error: unknown) => {
			// SshError/Unknown被吞以尝试读已捕获键，网络或认证类SshError也在其中；Changed及其他抛值继续失败。
			if (!(error instanceof SshError) && !(error instanceof HostKeyUnknownError)) throw error;
		});
		// 按临时文件此刻是否存在决定读取，检查与read之间仍可能失败。
		const lines = existsSync(scanned)
			? // 保留所有非空白行，行文字不逐条在这里parse或trim；最终accept才对传入行做边界检查。
				(await readFile(scanned, "utf8"))
					.split("\n")
					.filter((line) => line.trim() !== "")
			: // 无文件用空数组，不伪造一条公钥。
				[];
		// 没有任何捕获行就失败，不返回“已信任”状态。
		if (lines.length === 0) throw new Error(`No host key received from ${target.host}`);
		// 另起Promise收ssh-keygen输出，事件路径由error拒绝，执行器同步异常也会转拒绝；这里未设超时或检查close退出码。
		const fingerprints = await new Promise<string[]>((resolve, reject) => {
			// 本机ssh-keygen -lf读取临时known_hosts显示指纹，stdin忽略、stdout/stderr均pipe；stderr未在这里消费或展示。
			const child = spawn("ssh-keygen", ["-lf", scanned], { stdio: ["ignore", "pipe", "pipe"] });
			// 累计keygen的stdout文字，不收stderr。
			let output = "";
			// 每块Buffer到达后独立解码，未像runSsh那样最后统一解码。
			child.stdout.on("data", (chunk: Buffer) => {
				// 串接本块文字，未逐项验证指纹算法/格式。
				output += chunk.toString("utf8");
			});
			// 程序无法启动等error直接拒绝Promise，保原错误。
			child.on("error", reject);
			// close无论退出码都把非空白stdout行当指纹数组；可为空，不能据此保证每条键都已有有效指纹。
			child.on("close", () => resolve(output.split("\n").filter((line) => line.trim() !== "")));
		});
		// 返回两组原始行，未将扫描数据直接写到应用信任文件。
		return { lines, fingerprints };
		// finally覆盖捕获/读文件/keygen/return路径。
	} finally {
		// 递归强制删此次自建临时目录；不触碰target.knownHostsFile，清理拒绝会覆盖原成功或失败结果。
		await rm(directory, { recursive: true, force: true });
	}
}

/** A known-hosts line for `alias`: `alias type key [comment]`, no markers, patterns or hashed names. */
// 检查一行能否按目标alias/type/base64外形拆分，返回type/key或抛Error；例正常alias ssh-ed25519 AAAA通过文字外形，但未解码/验证真实公钥、算法或所有者身份，无I/O。
function parseHostKeyLine(alias: string, line: string): { type: string; key: string } {
	// trim后按空白拆，取前三字段，后面注释不参与键比较；未逐字校验alias本身是否含模式或hash语法。
	const [host, type, key] = line.trim().split(/\s+/);
	// 以下条件任一成立都拒绝这一行。
	if (
		// host必须严格等于传入alias；应用应给固定普通别名，本函数不做完整OpenSSH主机模式解析。
		host !== alias ||
		// 缺算法字段拒绝。
		type === undefined ||
		// 缺键字段也拒绝。
		key === undefined ||
		// 算法只检查这些前缀/字符集合，不是已支持算法名称的完整白名单；正则无m/g。
		!/^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+)$/.test(type) ||
		// 键只查非空base64字符与末尾最多两个=，不查4字符分组/解码字节或算法对应关系。
		!/^[A-Za-z0-9+/]+={0,2}$/.test(key)
	) {
		// 错误包含alias与原行JSON文字，不脱敏，不为无效行默默修复。
		throw new Error(`Not a host key line for ${alias}: ${JSON.stringify(line)}`);
	}
	// 返回解析出的两个字符串，原行由调用者另存。
	return { type, key };
}

/** Known-hosts files being changed, so changes to one file happen one at a time. */
// 模块内按file原字符串键串行队列；不做路径规范化/同inode识别，也不是跨进程OS锁。Promise<unknown>只表示不关心前次成功值。
const knownHostsChanges = new Map<string, Promise<unknown>>();

/** Rewrite the known-hosts file one change at a time, atomically. */
// 把known_hosts按文件队列读→change→写同目录独占临时文件→rename替换。输入file和同步转换回调，成功void、错误拒绝；例追加一条键。会创建目录/文件并重写，rename提供替换可见性而非fsync持久化或外部进程互斥保证。
async function changeKnownHosts(file: string, change: (lines: string[]) => string[]): Promise<void> {
	// 取同名文件最后一项，没有则以已成功Promise起队列。
	const previous = knownHostsChanges.get(file) ?? Promise.resolve();
	// 后继链等previous结算后才开始此轮，不阻塞其他不同字符串路径的队列。
	const next = previous
		// 吞前次失败让本轮仍可运行，不把前一个调用者的原Promise改成成功。
		.catch(() => {})
		// then里的async回调执行实际文件变化，任一步抛/拒绝使next失败。
		.then(async () => {
			// 递归创建父目录，mode700仅用于新建及受系统权限/umask规则影响，不强制修复已有目录权限。
			await mkdir(dirname(file), { recursive: true, mode: 0o700 });
			// 若文件存在就读原内容；exists检查不是与读取原子绑定。
			const existing = existsSync(file)
				? // 仅删严格空字符串行，不trim其他行；空白行/注释也可能保留并随后重写。
					(await readFile(file, "utf8"))
						.split("\n")
						.filter((line) => line !== "")
				: // 不存在就从空行列表开始。
					[];
			// 同步change可返回新列表或抛；抛时本轮尚未写临时文件。
			const lines = change(existing);
			// 在同路径后加6随机字节的hex后缀，降低临时名碰撞；不是固定用户密钥文件名。
			const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
			// 非空结果以LF结尾，空结果写空文件；mode600、wx要求新建不覆盖临时同名。写失败没有本函数独立的临时文件清理catch。
			await writeFile(temporary, lines.length === 0 ? "" : `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
			// 临时文件写完后rename到原路径，只为rename拒绝安排下面清理；未调用fsync。
			await rename(temporary, file).catch(async (error: unknown) => {
				// rename失败尝试删临时文件，force不吞所有权限/IO失败；清理失败也可能替代原错误。
				await rm(temporary, { force: true });
				// 清理成功后重抛原rename异常，不把失败当成功。
				throw error;
			});
		});
	// 先登记next，后续同file调用可以排在它后面，即使此刻仍未开始I/O。
	knownHostsChanges.set(file, next);
	// try/finally只管理队列槽释放，不吞next自身失败。
	try {
		// 等完整读改写/rename操作，不只是等排队成功。
		await next;
	} finally {
		// 只有自己仍是该file最新项才删槽，防旧完成项清掉新排队项。
		if (knownHostsChanges.get(file) === next) knownHostsChanges.delete(file);
	}
}

/**
 * Trust host-key lines from `scanHostKey` by adding them to the target's known-hosts file. Only plain lines for the
 * target's alias are accepted. A key that differs from a trusted key of the same type is refused with
 * `HostKeyChangedError`; `forgetHostKey` must remove the old keys first.
 */
// 显式接受这些键行：先解析全部输入，再串行对比已有同alias/算法，重复不加、同算法不同键拒绝。例首次接受后再收同键不重复；会重写指定known_hosts，无网络认证或公钥密码学验证，接受前须由调用者完成信任决定。
export async function acceptHostKey(target: SshTarget, lines: readonly string[]): Promise<void> {
	// 取目标alias原值，不在这里调用sshArguments或再次checkField。
	const alias = target.hostKeyAlias;
	// map先trim原行并扩展type/key，任何解析抛使async函数拒绝且尚未改信任文件；readonly输入数组不被写入。
	const accepted = lines.map((line) => ({ line: line.trim(), ...parseHostKeyLine(alias, line) }));
	// 进入同文件串行重写；回调拿本轮实际读出的列表，防同模块并发接受丢记录。
	await changeKnownHosts(target.knownHostsFile, (existing) => {
		// 按算法名记已信任键，比较的是键文字，不计算指纹。
		const trusted = new Map<string, string>();
		// 扫描现有每行，不将旧文件全部重新通过parseHostKeyLine验证。
		for (const line of existing) {
			// 取原行前三字段，忽略后面注释。
			const [host, type, key] = line.trim().split(/\s+/);
			// 只读同alias且字段齐全行；同算法旧行若重复，Map以后出现的那条为比较值，不清旧重复。
			if (host === alias && type !== undefined && key !== undefined) trusted.set(type, key);
		}
		// 新行暂存数组，完成全批检查后才返回合并结果。
		const added: string[] = [];
		// 解构新输入的原行/type/key，按传入顺序处理。
		for (const { line, type, key } of accepted) {
			// 查此算法当前键，包含这批前面刚加入的键。
			const known = trusted.get(type);
			// 完全相同就跳过，不用新注释替换旧行注释。
			if (known === key) continue;
			// 同算法已有其他键才视变化，不把新增另一算法直接视为冲突。
			if (known !== undefined) {
				// 抛Changed拒绝整轮转换，尚未写临时文件；调用者可显式forget后再接受。
				throw new HostKeyChangedError(`The ${type} host key of ${target.host} changed; forget the old key first`);
			}
			// 把新算法/键放入本轮索引，防同批第二条冲突绕过比较。
			trusted.set(type, key);
			// 保存trim后的整行，允许尾部注释保留。
			added.push(line);
		}
		// 旧行在前新增在后，新数组不直接改existing；即便无新增也会按changeKnownHosts流程重写。
		return [...existing, ...added];
	});
}

/** Stop trusting every key stored for the target's alias, e.g. after the owner confirmed a changed host key. */
// 停止信任目标alias的文本行，成功void、IO错误拒绝；例所有者确认换键后forget再accept。会重写本机指定文件，不撤销已经建立的连接，也不扫描/认证新键。
export async function forgetHostKey(target: SshTarget): Promise<void> {
	// 使用同文件队列读改写，和accept的并发操作按调用链排序。
	await changeKnownHosts(target.knownHostsFile, (existing) =>
		// 只按第一空白字段严格等于alias过滤，不展开别名模式、不解码哈希名称，也不解析一字段里多个主机的语法。
		existing.filter((line) => line.trim().split(/\s+/)[0] !== target.hostKeyAlias),
	);
}

/** POSIX detection, run by the remote login shell; a Windows host answers through PowerShell instead. */
// 远端POSIX探测脚本数据：标记后依次输出system/machine/os/home/tmpdir/preload。JS里的转义保留给远端sh；这行仅建字符串，不在本机执行uname或展开HOME。
// uname -s/-m/-o分别取内核名/机器架构/操作系统名，-o失败时丢stderr并补-；printf逐行输出HOME及TMPDIR/LD_PRELOAD，后两项未设或空时用-占位。
const POSIX_PROBE = `sh -c 'echo PI-ENV-PROBE; uname -s; uname -m; uname -o 2>/dev/null || echo -; printf "%s\\n" "$HOME" "\${TMPDIR:--}" "\${LD_PRELOAD:--}"'`;

// 把PowerShell脚本文字转为EncodedCommand命令字符串；例探测脚本先UTF-16LE再base64，无进程/I/O。编码是传参形式，不是加密或认证。
function powershell(script: string): string {
	// NoProfile/NonInteractive避免读取PowerShell profile或交互，base64由本机Buffer编码；真正执行留给runSsh。
	return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

// Windows探测在模块导入时只生成命令字符串，按与POSIX相同七行布局返回系统/架构/home等。
const WINDOWS_PROBE = powershell(
	// 实际PowerShell脚本原文，三个-是无对应POSIX字段的占位，不代表探测到了真实TMPDIR/LD_PRELOAD。
	"'PI-ENV-PROBE'; 'Windows'; [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); '-'; $HOME; '-'; '-'",
);

// normalizeArch接架构文字返回x64/arm64，否则抛；例AMD64转小写后得x64。无I/O，不把不支持的x86等自动模拟成64位。
function normalizeArch(machine: string): RemotePlatform["arch"] {
	// 只小写化，不trim空白，所以带多余空格的报告不自动修复。
	const lower = machine.toLowerCase();
	// 三种x86-64常见拼写归x64。
	if (lower === "x86_64" || lower === "amd64" || lower === "x64") return "x64";
	// 两种ARM64拼写归arm64。
	if (lower === "aarch64" || lower === "arm64") return "arm64";
	// 其余明确失败，保原文字供诊断。
	throw new Error(`Unsupported remote architecture: ${machine}`);
}

// 解析中间态六字段都为string；不是经过完整运行时schema验证的系统事实。
type Probe = { system: string; machine: string; os: string; home: string; tmpdir: string; preload: string };

// parseProbe从stdout找精确标记行再取后六字段，返回Probe；例前有banner仍能找到标记。无I/O，没标记抛；不校验字段完整/非空或home是否绝对路径。
function parseProbe(target: SshTarget, output: string): Probe {
	// Login shells may print a banner first.
	// 按LF或CRLF拆行，不处理单独CR作为换行。
	const lines = output.split(/\r?\n/);
	// 只接受整行PI-ENV-PROBE，找到首个；不是任意包含该子串的行。
	const start = lines.indexOf("PI-ENV-PROBE");
	// 标记缺失抛Unexpected answer，附trim输出且未脱敏。
	if (start === -1) throw new Error(`Unexpected answer from ${target.host}: ${output.trim()}`);
	// 从标记后取六项，默认值只用于undefined，空字符串不会变默认；多余后续行忽略。
	const [system = "", machine = "", os = "", home = "", tmpdir = "-", preload = "-"] = lines.slice(start + 1);
	// 同名属性简写返回中间结果，不访问远端文件系统。
	return { system, machine, os, home, tmpdir, preload };
}

/** Termux works only with its own `TMPDIR` and with `termux-exec`, which makes `#!/usr/bin/env` shebangs work. */
// 按探测文字生成Termux警告数组；例tmpdir为-则提示配置，preload不含termux-exec则提示。只返回文字，不加载库/改环境/获取wake lock，不证明实际每个脚本一定成败。
function termuxWarnings(probe: Probe): string[] {
	// 每次建独立警告数组。
	const warnings: string[] = [];
	// 只把占位-视作TMPDIR未设，空字符串等其他报告不在此相同处理。
	if (probe.tmpdir === "-") warnings.push("TMPDIR is not set; Termux's sshd normally sets it to $PREFIX/tmp.");
	// 以子串includes判断preload，不查远端共享库是否真实可加载。
	if (!probe.preload.includes("termux-exec")) {
		// 加入shebang行为提示，未执行验证脚本。
		warnings.push("termux-exec is not loaded (LD_PRELOAD); scripts with #!/usr/bin/env shebangs will fail.");
	}
	// Android休眠提示总加入，不依赖前两项是否通过。
	warnings.push("Android may suspend Termux; run termux-wake-lock on the device to keep the connection alive.");
	// 返回当前列表，后面由应用onLog展示。
	return warnings;
}

/** Which system the target runs: `uname` through the login shell, or PowerShell on Windows. */
// 检测平台：先SSH跑POSIX探测/解析，非主机键类失败再试PowerShell，按系统/架构归一并收警告。返回RemotePlatform，例Linux+Android归android；会多次SSH/远端执行，失败拒绝，不是纯本机推断或完整认证过程。
export async function detectPlatform(target: SshTarget): Promise<RemotePlatform> {
	// 暂未赋值的Probe局部，下面成功路径才可使用。
	let probe: Probe;
	// try同时覆盖POSIX命令执行和结果解析，不只覆盖SSH启动。
	try {
		// await实际远端探测，再解析stdout；Windows无sh或banner异常都可能使此步拒绝。
		probe = parseProbe(target, await runSsh(target, POSIX_PROBE));
		// 捕获初次执行/解析抛值，下一行保留主机键错误优先级。
	} catch (error) {
		// cmd.exe or PowerShell as the remote shell: no `sh`, or one that gets the probe's quotes wrong.
		// Unknown/Changed立即重抛，避免切命令绕过信任检查。
		if (error instanceof HostKeyUnknownError || error instanceof HostKeyChangedError) throw error;
		// 其他失败都尝试PowerShell，包括普通认证/网络SshError；此第二次失败直接向外拒绝，不再循环重试。
		probe = parseProbe(target, await runSsh(target, WINDOWS_PROBE));
	}
	// Git Bash as Windows' default SSH shell: ask PowerShell for Windows' own architecture and home spelling.
	// Git Bash/Cygwin类前缀则再用PowerShell拿原生Windows架构/home；这一调用在前述catch之外，失败不再退回。
	if (/^(MINGW|MSYS|CYGWIN)/.test(probe.system)) probe = parseProbe(target, await runSsh(target, WINDOWS_PROBE));
	// 先归一架构，未知架构可在系统分支前抛。
	const arch = normalizeArch(probe.machine);
	// 解构已有报告，不自动trim/校验home。
	const { system, os, home } = probe;
	// 系统名严格Windows才进入此支。
	if (system === "Windows") {
		// cmd.exe expands %OS%; PowerShell prints it as is.
		// 再跑echo %OS%，输出含Windows_NT视cmd，否则PowerShell；这是文本启发式，banner也可能影响判断，不是注册表完整读取。
		const shell = (await runSsh(target, "echo %OS%")).includes("Windows_NT") ? "cmd" : "powershell";
		// Windows返回shell与空警告；表示所选支持路径，非保证任何部署/启动都成功。
		return { platform: "windows", arch, home, shell, warnings: [] };
	}
	// Darwin映darwin，home沿原报告，当前不收额外警告。
	if (system === "Darwin") return { platform: "darwin", arch, home, warnings: [] };
	// Linux再看uname -o的os字段区分Android。
	if (system === "Linux") {
		// 只严格os===Android才选Android，不搜索任意说明里的子串。
		const android = os === "Android";
		// Android追加Termux提示，其他Linux为空；三元表达式实际只调用选中的分支。
		return { platform: android ? "android" : "linux", arch, home, warnings: android ? termuxWarnings(probe) : [] };
	}
	// 未知system拒绝，不选择一个默认daemon凑数。
	throw new Error(`Unsupported remote system: ${system}`);
}

/** The daemon binary this package ships for a remote system. */
// 根据远端支持平台/架构返回包内本机daemon路径；例windows/x64指向bin/pi-env-windows-x64/pi-env.exe。Pick只要求两个静态字段，无I/O、不检查文件存在或执行它。
export function packagedDaemon(remote: Pick<RemotePlatform, "platform" | "arch">): string {
	// 构造打包子目录名，未取远端home作本机路径。
	const name = `pi-env-${remote.platform}-${remote.arch}`;
	// join按本机路径规则接包目录；Windows目标选.exe文件名，其他目标无扩展。
	return join(packageRoot, "bin", name, remote.platform === "windows" ? "pi-env.exe" : "pi-env");
}

/** The daemon this package ships for the machine it runs on, e.g. for terminals of local sessions. */
// 返回本机平台对应的打包daemon路径，例本机darwin/arm64；系统/架构不支持抛，不连接远端、不构建或查文件是否已安装。
export function localDaemon(): string {
	// Node win32改成本包windows，其余process.platform先原样使用。
	const platform = process.platform === "win32" ? "windows" : process.platform;
	// 显式支持四系统，其余不继续猜路径。
	if (platform !== "linux" && platform !== "android" && platform !== "darwin" && platform !== "windows") {
		// 错误保留Node原系统名。
		throw new Error(`No pi-env daemon for ${process.platform}`);
	}
	// 复用架构归一及包路径拼接，process.arch无支持映射仍会抛。
	return packagedDaemon({ platform, arch: normalizeArch(process.arch) });
}

// 给一段文字生成POSIX shell单引号字面量；例包含单引号时先闭引号、以反斜杠表达单引号再重开。返回文字，无执行/I/O，只用于本模块POSIX命令场景。
function quotePosix(text: string): string {
	// 替换所有单引号为shell安全拼接片段，再包外层单引号；不是修改原字符串。
	return `'${text.replaceAll("'", "'\\''")}'`;
}

// 把文字放进PowerShell单引号字面量，内部单引号成双；例路径含撇号仍是字符串。只造表达式，不执行或适配cmd.exe。
function quotePowerShell(text: string): string {
	// replaceAll处理每个单引号，外层模板再包一对。
	return `'${text.replaceAll("'", "''")}'`;
}

/** Where a daemon with this content lives on the remote machine: named by its SHA-256, so versions never collide. */
// 给内容摘要拼远端安装路径；例前32个hex决定pi-env-...名字。仅算文字、无I/O，路径名只截SHA-256前128位，不是完整64个hex字符或绝对无碰撞保证，完整摘要另用于内容检查。
function daemonPath(remote: RemotePlatform, sha256: string): string {
	// slice(0,32)取32个十六进制字符，不是32字节；函数自身不验证传入sha256格式。
	const name = `pi-env-${sha256.slice(0, 32)}`;
	// 按目标系统选择远端分隔符与后缀，不用本机join解析远端路径。
	return remote.platform === "windows"
		? // Windows放home\.pi\mobile\tools并加.exe，未主动规范化home。
			`${remote.home}\\.pi\\mobile\\tools\\${name}.exe`
		: // POSIX用home/.pi/mobile/tools，不在本机创建目录。
			`${remote.home}/.pi/mobile/tools/${name}`;
}

// 远端sh的hash函数脚本，按可用性优先sha256sum→shasum→openssl，无工具输出none。此处只定义字符串；不保证每种外部工具执行必成功或同等诊断。
// command -v只探可执行命令，$1是待哈希文件；前两工具用cut取首个空格字段，openssl用sed去掉“= ”前缀，让调用方比较摘要文字；shasum显式-a 256选择SHA-256。
const POSIX_HASH = `hash() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= //'; else echo none; fi; }`;

/** Whether the remote file has this content: `present`, `missing`, or (POSIX without a hash tool) `nohash`. */
// SSH检查远端file内容是否等于完整sha256，返回状态文字；会执行远端哈希工具，失败可拒绝。Windows按尾部present判断，POSIX取最后一行，不是严格运行时枚举验证，更不等于保证检查后到启动前文件不可变。
async function checkDaemon(target: SshTarget, remote: RemotePlatform, file: string, sha256: string): Promise<string> {
	// Windows用PowerShell的LiteralPath避免通配路径展开。
	if (remote.platform === "windows") {
		// 生成编码后的PowerShell校验命令，不在本机读远端文件。
		const check = powershell(
			// 脚本仅文件存在且SHA256小写摘要相等输出present，否则missing；sha256由本模块本地摘要产生。
			`$f = ${quotePowerShell(file)}; if ((Test-Path -LiteralPath $f) -and ((Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower() -eq '${sha256}')) { 'present' } else { 'missing' }`,
		);
		// trim后只看endsWith("present")，不检查完整行恰为present；命令失败由runSsh先拒绝。
		return (await runSsh(target, check)).trim().endsWith("present") ? "present" : "missing";
	}
	// POSIX脚本：常规文件且摘要相等为present，无工具检测为nohash，其他missing；路径先引用，SHA是已生成hex。
	const check = `${POSIX_HASH}; f=${quotePosix(file)}; if [ -f "$f" ] && [ "$(hash "$f")" = ${sha256} ]; then echo present; elif [ "$(hash /dev/null)" = none ]; then echo nohash; else echo missing; fi`;
	// 通过sh -c执行并取trim后的最后LF行；??只在无项时兜底missing，空输出拆成空串时不会被??替换，不约束任意状态文字。
	return (await runSsh(target, `sh -c ${quotePosix(check)}`)).trim().split("\n").at(-1) ?? "missing";
}

/**
 * Make sure the daemon is on the remote machine, verified by its SHA-256 before it ever runs, and remove daemons of
 * other contents. The upload goes to a new temporary file and is renamed into place only once its hash matches.
 * Returns the remote path of the binary.
 */
// 部署并校验daemon：读本地binary算完整SHA→查远端→缺少/变化才上传临时文件→验hash→改名返回远端路径。例同内容已present直接返回。会读盘、联网、建/替换/清旧远端文件；不自动接受主机键、不保证校验与随后启动间无外部修改，失败拒绝。
export async function deployDaemon(
	// SSH目标决定信任文件/路由与执行程序。
	target: SshTarget,
	// 已探测平台决定远端脚本/目录格式。
	remote: RemotePlatform,
	// 未给binary才从包路径推导本机源文件，不在此下载或构建。
	binary = packagedDaemon(remote),
): Promise<string> {
	// 先检查源文件存在，缺失立即失败；存在检查与实际read仍非原子。
	if (!existsSync(binary)) throw new Error(`No pi-env daemon for ${remote.platform}-${remote.arch} at ${binary}`);
	// 无encoding读取本地文件为Buffer，后面原始字节/编码均基于此快照。
	const bytes = await readFile(binary);
	// 完整内容SHA256转64个hex字符用于验证；不是签名/发行者认证。
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	// 远端目标名只使用摘要前32hex，目录基于remote.home。
	const file = daemonPath(remote, sha256);
	// 实际SSH校验远端对应路径，可能连接/认证/命令失败。
	const state = await checkDaemon(target, remote, file, sha256);
	// present直接复用，不上传也不执行下面清旧daemon脚本；不是每次调用都清整个目录。
	if (state === "present") return file;
	// POSIX报告无哈希工具则拒绝，绝不在这个分支改为不校验启动。
	if (state === "nohash") throw new Error(`${target.host} has no sha256sum, shasum or openssl to verify pi-env`);
	// Windows后续走base64文本上传，POSIX走原始字节。
	if (remote.platform === "windows") {
		// 把数组中的PowerShell步骤拼成一个脚本，再UTF16LE/base64编码成命令；所有原步骤字符串均在远端解释。
		const upload = powershell(
			// 顺序步骤列表，后面join("; ")保持顺序，非并发执行。
			[
				// 远端设置Stop，让可终止错误中断上传；不改变本机PowerShell环境。
				"$ErrorActionPreference = 'Stop'",
				// 远端$f为引用后的最终路径。
				`$f = ${quotePowerShell(file)}`,
				// 从最终路径算父目录。
				"$d = Split-Path -Parent $f",
				// 远端创建/复用目录并丢弃命令对象输出，未设POSIX权限模式。
				"New-Item -ItemType Directory -Force -Path $d | Out-Null",
				// 在同目录以GUID临时名接收新内容，不直接先覆盖最终文件。
				"$t = Join-Path $d ('.pi-env-' + [guid]::NewGuid().ToString() + '.tmp')",
				// PowerShell reads redirected stdin itself, as text lines for `$input`, so the binary comes as base64 lines
				// up to an end marker: Windows' sshd may never pass on the end of stdin.
				// StringBuilder收base64文字，避免指望Windows sshd总转发stdin EOF。
				"$text = New-Object System.Text.StringBuilder",
				// 逐输入行拼接，到精确PI-ENV-END就停，标记不是二进制正文一部分。
				"foreach ($line in $input) { if ($line -eq 'PI-ENV-END') { break }; [void]$text.Append($line) }",
				// PowerShell解base64还原原始字节，坏编码可失败。
				"$bytes = [Convert]::FromBase64String($text.ToString())",
				// CreateNew独占建临时文件、写全部字节再关闭；异常路径没有统一finally保证所有远端临时资源都清理。
				"$out = [IO.File]::Open($t, 'CreateNew', 'Write', 'None'); $out.Write($bytes, 0, $bytes.Length); $out.Close()",
				// 验完整SHA，不符则删临时文件并throw；比较的不是只32hex文件名。
				`if ((Get-FileHash -Algorithm SHA256 -LiteralPath $t).Hash.ToLower() -ne '${sha256}') { Remove-Item -LiteralPath $t; throw 'pi-env upload is corrupt' }`,
				// A running daemon or a virus scanner can hold the old file for a moment.
				// Move-Item替换失败最多到i=20再抛：最多21次尝试、前20次各等250ms。它是处理占用的重试，不保证每个平台操作都成功。
				"for ($i = 0; ; $i++) { try { Move-Item -Force -LiteralPath $t -Destination $f; break } catch { if ($i -ge 20) { throw }; Start-Sleep -Milliseconds 250 } }",
				// Older daemons; one that is running stays until it exits.
				// 尝试删其他pi-env-*.exe并忽略单项删除错误，正在运行/被占用的旧文件可能保留；不主动杀旧daemon。
				"Get-ChildItem -LiteralPath $d -Filter 'pi-env-*.exe' | Where-Object { $_.FullName -ne $f } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -ErrorAction SilentlyContinue }",
				// 脚本末输出deployed，客户端下面只要求SSH成功，不再严格parse此标记。
				"'deployed'",
				// 分号连接完整脚本，注释在字符串外，不成为远端命令内容。
			].join("; "),
		);
		// 本地Buffer先base64，再按每1到76字符插LF；base64正文无换行，得到文本行，不把原始二进制当PowerShell输入对象。
		const lines = bytes.toString("base64").replace(/.{1,76}/g, "$&\n");
		// 加结束标记及LF后作为stdin，允许300秒；await等runSsh结算，超时kill仍非远端清理确认。
		await runSsh(target, upload, { stdin: Buffer.from(`${lines}PI-ENV-END\n`), timeoutMs: UPLOAD_TIMEOUT_MS });
		// SSH上传命令成功即返回最终路径，不再次独立连线校验，也不执行daemon。
		return file;
	}
	// 非Windows构造POSIX上传脚本，后面逐行拼接送sh -c。
	const upload = [
		// set -e让相应失败命令中断，未设置通用trap回收所有失败路径临时文件。
		"set -e",
		// 加入同一hash函数定义，优先顺序与前检一致。
		POSIX_HASH,
		// 引用后的目标路径赋远端f，保路径里的空格/单引号为数据。
		`f=${quotePosix(file)}`,
		// 远端dirname算安装目录。
		'd=$(dirname "$f")',
		// 远端递归建父目录。
		'mkdir -p "$d"',
		// 把安装目录权限改700，已有目录也会被此命令影响。
		'chmod 700 "$d"',
		// 同目录mktemp新临时文件，不先写最终路径。
		't=$(mktemp "$d/.pi-env.XXXXXX")',
		// cat把SSH stdin原始字节读到临时文件，依赖EOF结束。
		'cat > "$t"',
		// 验完整SHA，失败删除临时文件、向stderr报错并退出1，不执行后面替换。
		`if [ "$(hash "$t")" != ${sha256} ]; then rm -f "$t"; echo "pi-env upload is corrupt" >&2; exit 1; fi`,
		// 已验证的临时文件赋700可执行权限。
		'chmod 700 "$t"',
		// mv -f把临时内容放到最终文件，后面才清其他名字；不提供持久化fsync保证。
		'mv -f "$t" "$f"',
		// Older daemons; running ones keep their file open until they exit.
		// 按pi-env-*名字尝试rm其他文件，正在运行进程可继续持有旧文件；不是按版本清单精确删除或杀所有旧进程。
		'for old in "$d"/pi-env-*; do [ "$old" = "$f" ] || rm -f "$old"; done',
		// 末尾报deployed，仅是命令输出，客户端不以此词作额外内容校验。
		"echo deployed",
		// LF拼步骤，整个脚本在远端执行，字符串内部不插中文注释。
	].join("\n");
	// sh -c参数经quotePosix引用，stdin给本地Buffer原字节，300秒上传超时；可能改远端目录/权限/文件。
	await runSsh(target, `sh -c ${quotePosix(upload)}`, { stdin: bytes, timeoutMs: UPLOAD_TIMEOUT_MS });
	// 成功返回远端路径；失败会沿await拒绝，不在此吞掉重新无校验部署。
	return file;
}

/** Options for `sshConnection` and `connectSsh`: the target, plus the binary to deploy (default: the one this package ships). */
// extends继承目标配置并增加部署/启动选项，是TS接口扩展不是运行时拷贝；sshConnection仍保留应用传入对象引用。
export interface SshConnectOptions extends SshTarget {
	// 可选本机binary覆盖包内源路径，不是自定义远端安装名。
	binary?: string;
	/**
	 * POSIX: start the daemon through the user's login shell (`$SHELL -l`), so commands see the environment of
	 * `~/.profile` and similar files. Off by default: `ssh` runs commands without a login shell.
	 */
	// POSIX显式true才经登录shell，缺省/false不额外套登录shell；Windows启动分支不使用该开关。
	loginShell?: boolean;
	// 索引访问类型复用ConnectionOptions的onLog静态契约；回调可能用于warnings和连接诊断，不自动吞异常/脱敏。
	onLog?: ConnectionOptions["onLog"];
}

/** The remote command that starts the daemon at `file`, before the `serve` arguments. */
// launchCommand按远端系统生成启动命令文字，未附serve参数；例POSIX路径用单引号保护，Windows依shell选调用形式。无I/O、不执行程序；loginShell只改变POSIX分支，非通用任意shell转义器。
function launchCommand(remote: RemotePlatform, file: string, loginShell: boolean): string {
	// Windows分支跳过POSIX的$SHELL逻辑。
	if (remote.platform === "windows") {
		// PowerShell runs a quoted path only with the call operator; cmd.exe keeps one pair of quotes around a program.
		// PowerShell需要&调用被引用的路径，字符串单引号由quotePowerShell处理。
		if (remote.shell === "powershell") return `& ${quotePowerShell(file)}`;
		// 其他Windows情况按cmd路径用空格决定是否包双引号；没有对任意引号/元字符做完整cmd转义或验证。
		return file.includes(" ") ? `"${file}"` : file;
	}
	// `$0` is the daemon, `"$@"` its arguments; `$SHELL` is the login shell's own name for itself.
	// POSIX登录模式用exec启动$SHELL -lc；嵌套脚本以$0指daemon、"$@"转参数，真正环境/profile行为依远端shell，不在本机读取profile。
	if (loginShell) return `exec "$SHELL" -lc 'exec "$0" "$@"' ${quotePosix(file)}`;
	// 默认只返回引用过的daemon路径，随后SSH仍会通过目标默认shell解释远端命令。
	return quotePosix(file);
}

/** What an SSH connection learned about its remote system, and the daemon it verified last. */
// 可变内部状态：remote缓存成功探测，verified存刚部署过的路径供下一次命令构造尝试复用；不是永久信任或跨连接全局缓存。
type SshState = { remote?: RemotePlatform; verified?: string };

/** A `Connection` whose every start detects the remote system (once), verifies or deploys the daemon, then starts it. */
// 给状态造Connection：每次真正启动时运行async命令工厂，未知平台才探测，随后验证/部署并生成argv。构造本身不SSH；例第一次info才触发工作。准备失败由Connection包装spawn_error并让后续调用可重试，不自动重放已发业务。
function sshConnectionFor(options: SshConnectOptions, state: SshState): Connection {
	// new Connection只存选项，不调用下面工厂；读取外部options/state引用，不冻结。
	return new Connection({
		// command回调在每次#start时被await；它的探测/上传时间不计入Connection spawn之后的hello60秒timer，但各runSsh有自己的timer。
		command: async () => {
			// 只有remote缺省才重新检测，已经缓存后重连不主动探测系统是否变化。
			if (state.remote === undefined) {
				// 实际SSH检测平台，失败时不赋state.remote。
				const remote = await detectPlatform(options);
				// 逐条warning交onLog加LF，回调同步抛可使工厂失败且尚未缓存remote；返回Promise也未在此等待。
				for (const warning of remote.warnings) options.onLog?.(`${warning}\n`);
				// 展示警告之后才保存成功探测对象，后续remote()可读同一引用。
				state.remote = remote;
			}
			// A deployment that just verified the binary counts for the first start.
			// 取本次要启动的已验证路径，空合并表达式只求值需要的分支。
			const file =
				// connectSsh刚部署后提供的verified只供这一命令构造尝试复用，不再立即重复远端校验。
				state.verified ??
				// 没有verified才部署/检查；自定义binary优先，否则推包路径；校验与后续spawn之间仍可能有外部改动。
				(await deployDaemon(options, state.remote, options.binary ?? packagedDaemon(state.remote)));
			// 在生成argv、真正SSH spawn/hello之前就消费verified；即使后续失败，下次也必须重新deploy/check，不保证首次“成功启动”前永远复用。
			state.verified = undefined;
			// 回调返回整份程序/参数数组交Connection，自己尚未spawn最终daemon连接。
			return [
				// 首项本机SSH程序，??只排除null/undefined，空串仍交spawn报错。
				options.ssh ?? "ssh",
				// 展开严格默认的SSH选项与host，参数验证此时也可能抛。
				...sshArguments(options),
				// 最后放远端启动命令，loginShell仅===true启用；Connection后续另追加serve/--token等参数。
				launchCommand(state.remote, file, options.loginShell === true),
			];
		},
		// 只有onLog未定义才省字段，原回调引用交Connection接收后续诊断。
		...(options.onLog === undefined ? {} : { onLog: options.onLog }),
	});
}

/**
 * A `Connection` to the target that does nothing until its first request. Each start detects the remote system (the
 * first time), verifies the daemon and deploys it if it is missing or changed, then starts it over `ssh`. A failure
 * (no network, an untrusted or changed host key) fails the requests waiting for that start with code `spawn_error`
 * and the `ssh` diagnostics as message; the next request tries again. `remote()` is the detected system, once known.
 */
// 返回惰性connection和读取检测结果的remote函数；例刚调用后remote()为undefined，第一次info/请求才探测部署。此函数无网络/文件部署，后续启动工厂会有副作用；缓存remote不等于连接仍存活，也不认证已扫描指纹。
export function sshConnection(options: SshConnectOptions): {
	// 返回对象的connection字段是Connection实例，不是一个已经握手成功的Promise。
	connection: Connection;
	// remote方法类型可返回undefined，表示尚未缓存成功探测；不是强制远端每次重新检测。
	remote(): RemotePlatform | undefined;
} {
	// 每个包装独立新状态对象，Connection的后续工厂闭包会修改它。
	const state: SshState = {};
	// 生成Connection并返回零参读取函数，remote()同步返回原remote引用；外部改该对象不会被深复制隔离。
	return { connection: sshConnectionFor(options, state), remote: () => state.remote };
}

/**
 * Detect the remote system and deploy the daemon now, then return a `Connection` that starts it over `ssh`, like
 * `sshConnection`. Failures reject here: host keys must already be trusted (`scanHostKey`, `acceptHostKey`), otherwise
 * this rejects with `HostKeyUnknownError`.
 */
// 立即探测+部署后返回remote及惰性Connection；例await connectSsh(options)已做SSH校验/上传，但daemon帧hello仍等首次info/请求。错误在此reject，主机键需应用预先信任；onLog异常也可拒绝，不是只可能HostKeyUnknown。
export async function connectSsh(
	// options包含路由、信任、源binary、登录shell及日志回调，整个对象保留给连接工厂。
	options: SshConnectOptions,
	// async返回Promise，成功携带平台对象和未必已启动的连接。
): Promise<{ connection: Connection; remote: RemotePlatform }> {
	// 先实际探测，未知/变化键会经runSsh分类使这里拒绝。
	const remote = await detectPlatform(options);
	// 立即验证/部署并保路径，后面只为第一次工厂尝试提供verified，非永久跳过哈希。
	const verified = await deployDaemon(options, remote, options.binary ?? packagedDaemon(remote));
	// 逐条警告交同一onLog；同步抛会中断返回，已发生部署副作用不回滚。
	for (const warning of remote.warnings) options.onLog?.(`${warning}\n`);
	// 把成功remote/verified交新连接状态并返回；remote外部与内部共用引用，构造Connection本身不再立即发SSH。
	return { connection: sshConnectionFor(options, { remote, verified }), remote };
}
