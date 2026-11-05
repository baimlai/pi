// 通过子进程标准输入/输出交换一行一个JSON-RPC消息，给McpClient提供stdio传输；负责启动命令、分行解码、stderr尾部和尽力关闭进程组，不负责工具结果业务校验或模型请求。
// ChildProcess仅作TS类型，spawn是实际函数，此文件只在Windows终止分支用Node spawn运行taskkill。
import { type ChildProcess, spawn } from "node:child_process";
// 读取本机平台、环境及宿主exit事件；不是远端服务器的process信息。
import process from "node:process";
// cross-spawn启动MCP服务命令，补Windows命令/shebang/.cmd包装处理；导入函数本身不立即启动服务。
import crossSpawn from "cross-spawn";
// 消息类型只参与开发期检查；连接异常和parseJsonRpcMessage在实际发送/接收时使用，后者接收的是JSON.parse后的值。
import { type JsonRpcMessage, McpConnectionClosedError, parseJsonRpcMessage } from "../protocol/jsonrpc.ts";
// 复用默认消息字节上限、TS传输接口和事件底座；底座回调同步执行且可抛错，不能假定广播一定成功。
import { DEFAULT_MAX_MESSAGE_BYTES, type McpTransport, TransportEvents } from "./transport.ts";

// 默认保留stderr最近64KiB原始字节供诊断，不是64K字符，也不是限制子进程总日志量。
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
// 发SIGTERM后默认再等2000ms才安排SIGKILL；它不是整个close的固定完成时限。
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
/** How long a server gets to exit on its own after stdin closes, before it is sent SIGTERM. */
// stdin关闭后计划给500ms自行退出宽限，实际使用还会与配置closeTimeoutMs取较小值；宿主计时调度不保证准点。
const STDIN_CLOSE_GRACE_MS = 500;
// 非Windows用独立进程组处理同组后代；这不涵盖已经另建会话/组的所有后代进程。
const USE_PROCESS_GROUPS = process.platform !== "win32";

/** Process groups of running servers, killed if the host exits without closing them. */
// 模块级Set记录已启动服务的进程组编号，供宿主正常exit时尽力发SIGTERM；不等待退出确认，也不是跨宿主持久表。
const liveProcessGroups = new Set<number>();
// 防止同一模块实例重复安装exit钩子；let允许首次安装时改true。
let exitHookInstalled = false;

// 尽力终止服务相关进程：输入子进程引用和信号，Windows有pid时taskkill /T /F，其他平台先负pid进程组再退直接child.kill；无返回值。例：close阶段分别传SIGTERM/SIGKILL。
// 发送信号或启动taskkill不等于确认进程消失；这里不await taskkill，也忽略大部分发送失败，不能保证所有后代都被终止。
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	// 读取可能尚未分配或已经丢失的pid，类型为number | undefined。
	const pid = child.pid;
	// Windows且有pid时走专用taskkill路径，不采用下面POSIX负pid。
	if (process.platform === "win32" && pid !== undefined) {
		// 已记录普通退出码就不再调用taskkill；本条件没单独检查signalCode。
		if (child.exitCode !== null) return;
		// Windows has no graceful signals, and cross-spawn runs `.cmd` shims through cmd.exe; killing only
		// that would leave the server running.
		// 启动taskkill，以字符串pid、/T包含子树、/F强制终止；stdio忽略且隐藏Windows控制台。传入signal在此分支不用，也没有等待命令完成或检查其退出码。
		spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
			// 为taskkill子进程的error事件装处理器，防启动失败成为未处理事件。
			"error",
			// 空回调吞掉该启动错误，不自动回退child.kill。
			() => {},
		);
		// Windows路径到此结束，不再尝试后面的组信号。
		return;
	}
	// 非Windows并有pid时先尝试整个同号进程组。
	if (USE_PROCESS_GROUPS && pid !== undefined) {
		// try只捕获同步发送失败，以便退回直接子进程。
		try {
			// Negative pid: the whole group, so wrappers like `npx` or `uvx` do not leave the server behind.
			// 负pid表示进程组，signal保留调用方选择；成功发出并不等于已等待所有组员退出。
			process.kill(-pid, signal);
			// 组信号发送未抛错就返回，不再单独给直接子进程补一次。
			return;
			// 若进程组不存在/不可发送等导致throw，则继续后面的直接child.kill兜底。
		} catch {
			// The group is gone or was never created; fall back to the direct child.
		}
	}
	// 直接子进程兜底也用try包围，不让同步kill错误中断关闭流程。
	try {
		// 只发送信号，忽略其布尔返回值；异步error事件另由子进程事件处理器负责。
		child.kill(signal);
		// 吞同步失败，不在此生成新的协议响应或重试。
	} catch {}
}

// 只安装一次宿主exit清理钩子，无参数/返回；启动POSIX服务时调用。例：宿主退出会遍历登记组发SIGTERM，不能靠exit回调等待异步清理或覆盖强制杀宿主场景。
function installExitHook(): void {
	// 已有钩子就直接返回，避免每个服务新增一个相同exit监听器。
	if (exitHookInstalled) return;
	// 先置true，后续调用复用已经登记的钩子。
	exitHookInstalled = true;
	// once只在首次exit事件运行回调，回调同步发送信号，不await服务close。
	process.once("exit", () => {
		// 遍历当时仍在Set中的进程组，按插入顺序处理。
		for (const pid of liveProcessGroups) {
			// 每组单独try，使某组发送失败不妨碍后续组。
			try {
				// 尽力向组发SIGTERM，不安排SIGKILL升级，也不验证服务是否真的退出。
				process.kill(-pid, "SIGTERM");
				// 吞该组的同步错误，例如进程组已不存在。
			} catch {}
		}
	});
}

// 启动和缓冲选项的TS接口；字段类型不会对实际配置做数值范围或命令安全验证。
export interface StdioTransportOptions {
	// 要运行的命令名称/路径；start才真正启动，构造器不执行它。
	command: string;
	// 可选只读参数数组；readonly是TS限制，构造器还会浅复制数组，参数不按本模块的shell文本解析。
	args?: readonly string[];
	// 可选子进程工作目录，交cross-spawn/Node处理，不在这里创建目录。
	cwd?: string;
	// 显式环境变量表，默认叠加到process.env；不会自动脱敏或插值。
	env?: Record<string, string>;
	// 只有严格false才不继承宿主环境；缺省或true都会合并，显式env后写覆盖同名键。
	inheritEnv?: boolean;
	// stderr选inherit直接进宿主通道，否则pipe才能缓存并触发onStderr；不是将stderr混入协议stdout。
	stderr?: "pipe" | "inherit";
	// 可选日志回调，输入本次chunk解码文字；分块并非按行/完整UTF-8字符承诺，回调可抛错且此处不兜底。
	onStderr?: (chunk: string) => void;
	// 单行协议输入上限，默认16MiB；不限制发出的JSON大小，配置number也没验证为正整数。
	maxMessageBytes?: number;
	// stderr缓存上限的配置，按字节截尾；正常正整数才符合通常的尾部上限含义，0/负数/小数没有另行规范化。
	maxStderrBytes?: number;
	/** Time to wait for the server to exit after SIGTERM before sending SIGKILL. Default: 2000. */
	// 升级信号之间的等待毫秒数，默认2000；超大/非正等异常值仍交Math.min/setTimeout处理，未运行schema校验。
	closeTimeoutMs?: number;
}

// 继承事件订阅并实现传输接口；send不读取接口选项signal，调用方结束等待并不会让本方法在写入前增加一次取消检查。
export class StdioTransport extends TransportEvents implements McpTransport {
	// 公开只读配置引用，Readonly只限制TS顶层写入；构造器另浅冻结复制对象。
	readonly options: Readonly<StdioTransportOptions>;
	// 当前子进程对象，启动前/收到close事件清理后为undefined。
	private child: ChildProcess | undefined;
	// 协议stdout的未分行字节缓冲，先等完整LF行才解码，避免普通字节chunk截断UTF-8字符。
	private stdoutBuffer = Buffer.alloc(0);
	// stderr尾部字节缓冲，供stderr getter读取，不是完整日志文件。
	private stderrBuffer = Buffer.alloc(0);
	// 一旦开始启动就置true，失败也不重置，因此同一实例不能重新start。
	private started = false;
	// 主动close一开始置true；底层自然close回调本身不设置此字段，只发事件并清child。
	private closed = false;

	// 构造传输，输入启动选项，返回实例；初始化事件底座、复制/冻结外层配置及复制args，不启动I/O。例：new StdioTransport({command:"server",args:[]})仍须await start，配置读取/复制异常可抛。
	constructor(options: StdioTransportOptions) {
		// 先调用父类构造器建立各事件Set，派生类访问this前必需。
		super();
		// 外层对象浅冻结，但新args数组和env等嵌套对象不因此深冻结；args真值时复制，缺省保undefined。
		this.options = Object.freeze({ ...options, args: options.args ? [...options.args] : undefined });
	}

	// 读取当前child的pid，无参数/副作用；例：spawn成功后可为数字，尚未启动/close回调后为undefined。该数字不保证进程此刻仍存活。
	get pid(): number | undefined {
		// ?.在没有child时返回undefined，不主动查询操作系统进程表。
		return this.child?.pid;
	}

	// 把当前stderr缓存解码为UTF-8字符串，无参数/外部副作用；每次读取都解码。例：返回最近日志尾部，不是完整历史；截尾切到半个多字节字符时可有替代字符。
	get stderr(): string {
		// 按当前缓存生成字符串，不清空缓存，也不等待更多日志。
		return this.stderrBuffer.toString("utf8");
	}

	// 启动服务：防重复、定环境/stdio、spawn并订事件，再等spawn或启动error；返回Promise<void>。例：command=process.execPath、args=[服务脚本]会真正执行该脚本，不在这里做initialize握手。
	// 启动/回调可失败；started先置true且不回滚。stdout/stderr后续事件在独立调用栈执行，start的await并不兜住所有事件回调异常。
	async start(): Promise<void> {
		// 先查started再查closed，已尝试启动过的实例重启时会优先报already started。
		if (this.started) throw new Error("MCP stdio transport already started");
		// 未start但已close的实例也不能再启动。
		if (this.closed) throw new McpConnectionClosedError();
		// 先占用一次启动机会，后面spawn失败仍保true。
		this.started = true;
		// strict false选择只复制显式env，否则浅合并宿主环境再用显式env覆盖；缺省env展开不增加字段。
		const env = this.options.inheritEnv === false ? { ...this.options.env } : { ...process.env, ...this.options.env };
		// 真正运行命令；cross-spawn在Windows可能为脚本包装成cmd.exe调用，不能把它理解为所有平台都绝不经过shell。
		const child = crossSpawn(this.options.command, this.options.args ?? [], {
			// 工作目录原样交给底层，错误由spawn阶段报告。
			cwd: this.options.cwd,
			// 发送本轮构造的环境对象。
			env,
			// stdin/stdout始终pipe作协议，stderr仅明确inherit时直通宿主，否则单独pipe缓存。
			stdio: ["pipe", "pipe", this.options.stderr === "inherit" ? "inherit" : "pipe"],
			// Windows隐藏子进程控制台窗口，不代表后台任务已经脱离宿主生命周期。
			windowsHide: true,
			// Own process group, so closing the transport can terminate the server's children too.
			// POSIX设置detached形成独立进程组便于负pid信号；没有child.unref，不能因此宣称宿主立即不再等它。
			detached: USE_PROCESS_GROUPS,
		});
		// 保存ChildProcess，供send/pid/close和日志处理使用。
		this.child = child;
		// 取本轮pid，启动失败时可能undefined。
		const pid = child.pid;
		// 仅POSIX且拿到pid才登记进程组与宿主退出钩子。
		if (USE_PROCESS_GROUPS && pid !== undefined) {
			// 确保安装一次宿主exit清理回调。
			installExitHook();
			// 把当前组号加入Set，并非把整棵后代树逐个登记。
			liveProcessGroups.add(pid);
			// 直接子进程exit时删组号；exit与管道close不同步，后代仍活着也不会因此继续留在这个宿主exit表中。
			child.once("exit", () => liveProcessGroups.delete(pid));
		}
		// stdout存在时订data，将原字节/文字chunk交分行处理，不把stderr当协议消息。
		child.stdout?.on("data", (chunk: Buffer | string) => this.handleStdout(chunk));
		// stdout流错误经错误通道同步报告，不在此自动close。
		child.stdout?.on("error", (error) => this.emitError(error));
		// stdin流错误单独订阅，避免写入错误没有处理器。
		child.stdin?.on("error", (error) => {
			// 仅主动close前报告stdin错误，close后吞掉这一路错误；不代表全部其他事件错误也被忽略。
			if (!this.closed) this.emitError(error);
		});
		// 有stderr管道才收data，inherit模式通常没有可供此处消费的stderr流。
		child.stderr?.on("data", (chunk: Buffer | string) => this.handleStderr(chunk));
		// stderr流错误仍报告，未受上面stdin的closed条件保护。
		child.stderr?.on("error", (error) => this.emitError(error));
		// 进程close事件表示进程结束且相关stdio流已关闭；自然退出也执行此清理，与收到exit码不是同一时点。
		child.on("close", () => {
			// 先清当前child引用，pid getter随后不再返回旧pid。
			this.child = undefined;
			// stdout剩余字节解码trim后还有内容，就认为行没完整结束；纯空白尾部忽略，并不是尝试解析无LF的最后一个JSON。
			if (this.stdoutBuffer.toString("utf8").trim()) {
				// 报告不完整消息；错误监听器若抛错可阻止后面的清缓冲/关闭事件广播。
				this.emitError(new Error("MCP stdio server closed with an incomplete JSON-RPC message"));
			}
			// 正常继续时丢掉stdout尾部，不把它补LF当合法消息。
			this.stdoutBuffer = Buffer.alloc(0);
			// 广播关闭事件，底座防重复但不隔离监听器异常；本closed字段在这里没有改true。
			this.emitClose();
		});

		// 把spawn与首次error竞争包装成Promise，start只等到子进程创建成功，不等MCP握手或服务业务就绪。
		await new Promise<void>((resolve, reject) => {
			// spawn成功事件回调：移走启动失败监听，再兑现这次等待。
			const onSpawn = () => {
				// 移除同一onError引用，避免把后续运行期错误当启动Promise失败。
				child.off("error", onError);
				// 完成start等待，后续事件继续由各处理器运行。
				resolve();
			};
			// 启动错误回调，输入Error，清另一路监听并拒绝等待；不在这里清started/重试命令。
			const onError = (error: Error) => {
				// 失败后不再响应尚未发生的spawn事件。
				child.off("spawn", onSpawn);
				// 以原启动Error拒绝，不改为成功或空服务。
				reject(error);
			};
			// 一次性订成功事件，触发后由EventEmitter移除此监听。
			child.once("spawn", onSpawn);
			// 一次性订启动失败事件，与成功回调互相清理。
			child.once("error", onError);
		});
		// 等启动成功后再安装运行期child error监听；与stdout/stderr流错误通道分别存在。
		child.on("error", (error) => {
			// 仅主动关闭前报告运行期进程错误，不直接重启或拒绝所有协议pending。
			if (!this.closed) this.emitError(error);
		});
	}

	// 把消息JSON.stringify并加LF写入stdin，返回写回调完成Promise；例：request对象编码为一行，等待协议响应由McpClient处理。无连接/不可写或JSON编码/写入失败会拒绝；没有输出大小预算或send signal检查。
	async send(message: JsonRpcMessage): Promise<void> {
		// 拿当前子进程的标准输入流引用，缺child时undefined。
		const stdin = this.child?.stdin;
		// 须已start、未主动close且stdin.writable；writable只说明流当前可写，不保证远端一定接收/处理成功。
		if (!this.started || this.closed || !stdin?.writable) throw new McpConnectionClosedError();
		// JSON文本后加一个换行分隔消息；字符串里的换行会经JSON编码转义，循环对象/BigInt等可让编码抛错。
		const payload = `${JSON.stringify(message)}\n`;
		// 把一次stream.write回调包装成Promise；不是请求结果Promise，也没有自己按drain事件排发送队列。
		await new Promise<void>((resolve, reject) => {
			// 写回调有error就拒绝，否则兑现；未使用write的背压布尔值，不等于客户端工具执行完成。
			stdin.write(payload, (error) => (error ? reject(error) : resolve()));
		});
	}

	// 主动关闭服务，输入无参数，返回Promise<void>：先置closed，无child立即发close；已知退出只end stdin并返回；仍运行则end stdin、定时升级信号并等child close。例：默认安排500ms宽限后SIGTERM，再约2000ms后SIGKILL，宿主调度仍可延后。
	// 第二次close直接返回，不共享首次关闭Promise；信号发送尽力，若最终close事件不来本次等待可一直挂起，不能把定时器值当确定的关闭上限。
	async close(): Promise<void> {
		// 已经主动closed就返回，不再等待旧的关闭工作。
		if (this.closed) return;
		// 在等待前置true，阻止新send并抑制若干运行错误报告。
		this.closed = true;
		// 局部捕获原child，用于后续事件和定时器，await期间this.child可被清空。
		const child = this.child;
		// 没child时没有进程可等待。
		if (!child) {
			// 直接发关闭事件，正常情况下让McpClient收到掉线。
			this.emitClose();
			// 无child分支结束，不安排任何信号。
			return;
		}
		// 已记录exitCode或signalCode说明进程终止过，但不保证所有stdio close已到；这一路不等child close。
		if (child.exitCode !== null || child.signalCode !== null) {
			// 若stdin存在则请求结束输入，可能尚有流清理待事件完成。
			child.stdin?.end();
			// 直接返回，不能把这个分支的Promise兑现视为所有后代/管道都已退出。
			return;
		}
		// Shutdown per the spec: close stdin and let the server exit, then SIGTERM, then SIGKILL.
		// 配置缺省才用2000ms，0/负数/NaN等不会被??替换，后面交Math/Node计时器处理。
		const closeTimeoutMs = this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
		// 仍运行的child等待close事件兑现，没有显式reject分支或总截止计时器。
		await new Promise<void>((resolve) => {
			// ReturnType提取setTimeout句柄类型，数组保存稍后要取消的升级计时器。
			const timers: ReturnType<typeof setTimeout>[] = [];
			// 一次性close回调，在流/进程关闭后做本次关闭等待的收尾。
			child.once("close", () => {
				// 取消已登记升级计时器，防正常退出后继续对旧pid发送定时信号。
				for (const timer of timers) clearTimeout(timer);
				// Children of the server that ignored stdin closing would otherwise outlive it.
				// 再尽力向组发SIGTERM，以处理直接服务已退但仍在同组的后代；不能保证另开组的后代也被覆盖。
				killProcessTree(child, "SIGTERM");
				// 兑现本次close等待，不等待killProcessTree里的taskkill或组成员确认。
				resolve();
			});
			// 宽限取500和配置的较小值；默认500，配置100时先等100ms就发SIGTERM。
			const grace = Math.min(STDIN_CLOSE_GRACE_MS, closeTimeoutMs);
			// 宽限到期尽力发SIGTERM，并保存定时器句柄。
			timers.push(setTimeout(() => killProcessTree(child, "SIGTERM"), grace));
			// 从现在起grace+closeTimeoutMs再尝试SIGKILL，相当于两次信号之间约配置时长；Windows专用分支仍用同一强制taskkill，不区分这两个信号。
			timers.push(setTimeout(() => killProcessTree(child, "SIGKILL"), grace + closeTimeoutMs));
			// 结束stdin写端，让愿意遵守EOF的服务先自行退出；此前登记事件与计时器防漏掉快速退出。
			child.stdin?.end();
		});
	}

	// 接收stdout字节并提取完整LF行，输入Buffer或string，无返回值；每行先限字节、解码、去尾CR、JSON.parse再消息骨架校验并广播。例：一行JSON拆在两个chunk会先缓冲再解析。
	// 非法行通常报告错误后继续，不会主动重启/关闭；无LF且超限时清整个现有缓冲，并不进入“丢弃直到下个LF”的状态。错误监听器自身异常仍可逸出。
	private handleStdout(chunk: Buffer | string): void {
		// 先把整个新chunk拼进缓冲；因此瞬时分配可大于配置限额，不能把该限额当进程严格内存上限。
		this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
		// 本实例上限缺省才采用16MiB，不验证配置为有限正整数。
		const maxMessageBytes = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		// 循环提取当前缓冲中所有完整行，return在需要等更多数据时退出。
		while (true) {
			// 按字节0x0a找LF，没找到返回-1；多字节UTF-8正文不会被按字符索引拆断。
			const newline = this.stdoutBuffer.indexOf(0x0a);
			// 没有完整行时只处理未完成行的缓冲上限。
			if (newline < 0) {
				// 严格大于限额才超限，恰好等于仍可等后续LF。
				if (this.stdoutBuffer.length > maxMessageBytes) {
					// 清空现有所有未完成字节；未来chunk会重新当新内容，未保留到LF前都丢弃的状态。
					this.stdoutBuffer = Buffer.alloc(0);
					// 报告超限错误，没有输出截断后的部分消息给模型。
					this.emitError(new Error(`MCP stdio message exceeds ${maxMessageBytes} bytes`));
				}
				// 此chunk暂不再处理，等待后续data事件。
				return;
			}
			// 取不含LF的行视图，若CRLF则此时CR仍计入line.length。
			const line = this.stdoutBuffer.subarray(0, newline);
			// 剩余缓冲跳过LF，保留后续行；subarray共享原Buffer底层存储，不保证立即释放原分配。
			this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
			// 完整行也限字节，包含可能的尾CR但不包含LF；超限行不解码解析。
			if (line.length > maxMessageBytes) {
				// 报告这一行超限，错误监听器若正常返回可继续下一行。
				this.emitError(new Error(`MCP stdio message exceeds ${maxMessageBytes} bytes`));
				// 跳过本行，回while继续取后续完整行。
				continue;
			}
			// 按UTF-8解码后仅去掉末尾一个CR，正则$在这里无m标志要求字符串末尾；不会先trim正文再JSON.parse。
			const text = line.toString("utf8").replace(/\r$/, "");
			// trim仅用来判断全空白行，命中就跳过；非空行仍用原text解析。
			if (!text.trim()) continue;
			// try包住JSON解码、骨架校验和消息广播，用户消息监听器的同步异常也会进入这一catch。
			try {
				// 先JSON.parse，再parseJsonRpcMessage验证局部消息形状，最后同步广播；不是完整方法/参数schema校验。
				this.emitMessage(parseJsonRpcMessage(JSON.parse(text)));
				// 捕获解析或广播的同步异常，尝试交错误通道报告。
			} catch (error) {
				// 错误监听器本身抛错不再由此处重试catch，可能逸出stdout事件回调。
				this.emitError(error);
			}
		}
	}

	// 收stderr一块日志，输入Buffer/string，无返回值；追加字节、按正常正整数上限保尾部，再把本块完整解码文字给可选回调。例：缓存保最近64KiB但onStderr仍可收到全部各块；不解析为协议消息。
	// 回调同步抛错会传播，分块解码/字节截尾可能产生UTF-8替代字符；该函数不保存日志文件或限制服务总输出。
	private handleStderr(chunk: Buffer | string): void {
		// Buffer直接用原chunk，string按默认UTF-8转成新Buffer。
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		// 缺省才用64KiB，配置0/负数不另作规范化。
		const maxStderrBytes = this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
		// 先拼完整缓存再裁剪，瞬时分配可超过上限。
		this.stderrBuffer = Buffer.concat([this.stderrBuffer, buffer]);
		// 正常正整数时保最后maxStderrBytes字节；subarray是视图可能仍保有较大底层分配。0使负0变0并保全缓冲，不能宣称0表示清空或禁用日志。
		if (this.stderrBuffer.length > maxStderrBytes) this.stderrBuffer = this.stderrBuffer.subarray(-maxStderrBytes);
		// 回调收到当前buffer的文字，而不是裁剪后的缓存；可选调用不吞异常，日志既不脱敏也不按行聚合。
		this.options.onStderr?.(buffer.toString("utf8"));
	}
}
