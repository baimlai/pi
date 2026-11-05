// 把 Durable 的文件/命令接口接到 pi-env daemon：本客户端负责远端路径规则、分块传输、结果/错误和取消检查点，实际系统调用在 daemon。
// Connection 可经 SSH 或本机管道连接；这里不负责部署、主机认证或沙箱隔离。操作失败不表示远端副作用自动回滚，句柄也不能跨 daemon 重启复用。
// randomUUID 只给临时文件起随机名，不在此生成用户身份或加密文件内容。
import { randomUUID } from "node:crypto";
// type PlatformPath 是路径函数集合的接口；posix/win32 是实际函数，按远端系统选用，不能直接用本机默认规则。
import { type PlatformPath, posix, win32 } from "node:path";
// Node StringDecoder 保留跨块未完成的 UTF-8 字符，用于 readTextFile，开头 BOM 会保留；与下面逐行 reader 的 StreamDecoder 不同。
import { StringDecoder } from "node:string_decoder";
// fileURLToPath 把 file: URL 解成指定系统的路径，支持 {windows} 覆盖本机平台；非法 URL 在 #resolve 内另行处理。
import { fileURLToPath } from "node:url";
// Context 仅作类型导入，提供 abortSignal 等上下文；类型存在不表示当前未取消，也不自动向请求发送取消帧。
import type { Context } from "@earendil-works/chord/context";
// type 成员只用于开发期约束，其他成员是真实运行时值；Result 是 ok 标签的成功/失败联合，不是直接抛错的 Promise 替代品。
import {
	// BinaryReader 契约围绕一个已打开普通文件做定位读取，改路径名字后仍使用同一已打开对象。
	type BinaryReader,
	// DirReader 按文件系统次序分页，和一次收集后排序的 listDir 不同。
	type DirReader,
	// ExecutionEnv 合并文件系统与命令能力，implements 不自动生成实现。
	type ExecutionEnv,
	// ExecutionError 表示命令层错误，非零退出码本身仍可成为成功 Result 的 exitCode。
	ExecutionError,
	// err 将错误包成 {ok:false,error}，不是 throw。
	err,
	// FileChange 是 paths/overflow/failed 标签联合，具体监控生命周期交 RemoteWatcher。
	type FileChange,
	// FileError 统一文件错误码、路径和可选 cause，和远端原始 RemoteError 分开。
	FileError,
	// FileInfo 包含路径、种类、大小及毫秒修改时间，不含文件全文。
	type FileInfo,
	// FileKind 允许 file/directory/symlink，daemon 额外 other 之后会被拒绝或跳过。
	type FileKind,
	// FileListing 表示递归枚举结果和截断标志，不是一个打开目录句柄。
	type FileListing,
	// FileWatcher 提供当前 native/polling 模式及 stop，不代表所有系统都无事件间隙。
	type FileWatcher,
	// LineScan 是行范围的字节边界与解码后长度统计，实际扫描由 daemon 执行。
	type LineScan,
	// ListFilesOptions 的过滤/数量/字节/时间预算由共享 listFilesOver 校验转交。
	type ListFilesOptions,
	// ok 将成功值包成 {ok:true,value}；void 操作成功值通常是 undefined。
	ok,
	// Result<T,E> 泛型分别指定成功值和错误类型，调用者用 .ok 收窄对应字段。
	type Result,
	// ShellExecOptions 声明 cwd/env/timeout/输出回调等；声明不会自己验证数值范围。
	type ShellExecOptions,
	// ShellExecResult 只有退出码及可选 spillPath，不自动收集 stdout 成一个返回字符串。
	type ShellExecResult,
	// ShellOutputInfo 标明流和可选跳过统计，供调用者维护输出尾部。
	type ShellOutputInfo,
	// ShellOutputSkip 以解码文本的 UTF-8 字节、LF 数量等衡量遗漏，不是原始管道字节数。
	type ShellOutputSkip,
	// Durable StreamDecoder 按 WHATWG UTF-8 流解码，只去最开头 BOM，逐行读取使用它。
	StreamDecoder,
	// TextLine 的 text 不带 LF，terminated 区分有无行终止 LF；CR 不自动删掉。
	type TextLine,
	// TextLineReader 一次读取一行，EOF 用成功值 undefined 表示，和失败 Result 区分。
	type TextLineReader,
	// WatchTarget 指定远端路径、递归和排除项，这里先解析路径再交 watcher。
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
// Connection 类型不在此 new；Json 是值为 unknown 的字典，nodePlatform 映平台拼写，RemoteError 包 daemon 错误，RemoteInfo 是 hello 静态结构。
import { type Connection, type Json, nodePlatform, RemoteError, type RemoteInfo } from "./connection.ts";
// abortResult 只读当前取消状态；toFileError 把远端码映成 Durable 码，不重试或撤销系统调用。
import { abortResult, toFileError } from "./errors.ts";
// 共享递归枚举实现会检查 daemon 的 listFiles 能力，不支持时返回 not_supported，是否回退遍历由调用者决定。
import { listFilesOver } from "./list-files.ts";
// RemoteWatcher 承担长 watch 请求、停止和掉线重连，RemoteWatchOptions 是其配置类型。
import { RemoteWatcher, type RemoteWatchOptions } from "./watch.ts";

// 命令 timeout 换算成毫秒后不能超过此值，与 Node 定时器可用上界保持一致。
const MAX_TIMEOUT_MS = 2_147_483_647;
// 公开错误信息中的秒上界按毫秒常量换算，不额外取整。
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** Bytes per `pread` request of a binary reader; several are in flight at once. */
// 普通二进制 reader 每次定位请求最多 256 KiB，长度单位是字节。
const READ_CHUNK = 256 * 1024;
// 保留的读取队列最多八项；短读丢弃旧队列不会取消已发请求，因此不是任何时刻底层总请求数都至多八个的保证。
const READ_DEPTH = 8;
/** Node's `writeFile` writes at most this much per call and checks for an abort before each. */
// 写入每个 payload 最多 512 KiB，字符串先 UTF-8 编码，再按字节分块。
const WRITE_CHUNK = 512 * 1024;
// 后续写块最多保留八个未依序消费的 Promise；daemon 仍按同一句柄的到达顺序串行写，不并行改变文件位置。
const WRITE_DEPTH = 8;
/** Node's `readFile`: chunk of known-size reads, chunk of unknown-size reads, and the largest file it reads. */
// readFile 的已知大小分支使用 512 KiB 请求，和 BinaryReader 的 256 KiB 不同。
const READ_FILE_CHUNK = 512 * 1024;
// 未知大小（也含 stat 为零的普通文件）使用 64 KiB 顺序读取。
const READ_FILE_UNKNOWN_CHUNK = 64 * 1024;
// 2 ** 31 - 1 为已知文件大小拒绝阈值，不是所有未知流的累计大小限制，也不保证并发增长文件形成一致快照。
const READ_FILE_MAX = 2 ** 31 - 1;
/** `NodeTextLineReader`'s read size. */
// 逐行 reader 每次请求 64 KiB，但一行可跨任意多个块，未在此限制最大行长。
const LINE_CHUNK = 64 * 1024;

// 构造环境所需的静态接口；构造只存配置，不立即连接、检查 cwd 或创建远端文件。
export interface RemoteExecutionEnvOptions {
	// 连接由调用者提供并负责最终 close，环境 cleanup 只处理它自己登记的命令。
	connection: Connection;
	/** The file namespace: equal ids see the same files (`FileSystem.id`), e.g. `pi-env:<env name>`. */
	// 文件命名空间 id 由调用者选择，相同 id 按契约应看见同组路径；本实现不探测或强制验证此关系。
	id: string;
	// 环境的远端工作目录，随后可修改；构造器没有把它自动转为绝对路径或验证存在。
	cwd: string;
	// 可选 shell 程序路径只用于字符串命令，真正寻找/启动在 daemon。
	shellPath?: string;
	/** Added to the remote environment of every command that inherits it, like `NodeExecutionEnv`'s `shellEnv`. */
	// 字符串键值字典加入继承环境的命令，单次 options.env 可覆盖；inheritEnv=false 时不会带入此默认字典。
	shellEnv?: Record<string, string>;
	/** How the daemon watches, like `NodeExecutionEnv`'s `watch` option. */
	// 可选监控配置，未给时保存空对象，由 daemon 选择平台默认。
	watch?: RemoteWatchOptions;
}

/** An info record from the daemon. */
// daemon 元信息的类型别名：name 原字段会被 toInfo 忽略；kind 可多出 other，size 为字节，mtimeSec/mtimeNsec 组合成毫秒。此声明不验证 wire 字段。
type RemoteFileInfo = { name: string; kind: FileKind | "other"; size: number; mtimeSec: number; mtimeNsec: number };
// 目录项可能含原始名字字节 raw，或 info/error；? 仅表示可缺省，并未在类型上保证 info 与 error 必有且互斥，实际形状依协议。
type RemoteDirEntry = { name: string; raw?: number[]; info?: RemoteFileInfo; error?: Json };

/** Node's path rules of the remote system. */
// 异步读取 hello 平台并返回 Node 的远端路径规则，不访问目标文件；例：即使客户端在 macOS，远端 windows 也返回 win32。info 可按需连接/失败，本函数未捕获异常。
export async function remotePath(connection: Connection): Promise<PlatformPath> {
	// await 取得平台信息，映成 win32 才选 Windows 规则，其余系统均选 POSIX；不是创建远端 shell。
	return nodePlatform(await connection.info()).platform === "win32" ? win32 : posix;
}

// 把已知路径和 daemon 元信息映成 FileInfo Result，无系统调用；例：1 秒加 500000000 纳秒得到 1500ms，other 返回 invalid。
// name 重新按远端规则从 path 取，字段断言本身不证明 wire 合法；这里只明确排除 other，没有全面类型/范围校验。
function toInfo(path: string, remote: RemoteFileInfo, paths: PlatformPath): Result<FileInfo, FileError> {
	// 只拒绝精确字符串 other；合法三种类型按下面字段构造成功值。
	if (remote.kind === "other") return err(new FileError("invalid", "Unsupported file type", path));
	// 创建新的成功对象，原 remote/path 不变。
	return ok({
		// 使用客户端已解析路径的 basename，覆盖 daemon 原 name 的展示来源。
		name: paths.basename(path),
		// 属性简写保存完整路径，不再次 canonicalPath 跟随符号链接。
		path,
		// 通过上面的 other 判断后，TS 将种类收窄为 FileKind。
		kind: remote.kind,
		// 大小沿用 daemon 数字，不把目录大小理解成递归文件总量。
		size: remote.size,
		// 秒乘千加纳秒除百万，number 运算可能有浮点精度损失，不保留纳秒整数精度。
		mtimeMs: remote.mtimeSec * 1000 + remote.mtimeNsec / 1e6,
	});
}

// 输入有序字节块和调用者已累计总长，返回同顺序的字节数组，无 I/O；例：[ab,cd] 合成 abcd。
// 单块直接复用引用，多块分配并复制，空数组返回长度 total 的新零初始化数组；这里不重算或校验 total，分配/越界写仍可抛错。
function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
	// 只有一块时免复制；! 仅向 TS 断言正常数组首项存在。
	if (chunks.length === 1) return chunks[0]!;
	// 按 total 字节一次分配新 Uint8Array，数量过大或无效可抛异常。
	const bytes = new Uint8Array(total);
	// 跟踪写入结果的字节偏移，不是字符串码元下标。
	let position = 0;
	// 按输入块的顺序依次复制，不按异步完成时间排序。
	for (const chunk of chunks) {
		// set 从当前位置复制块；它复制内容，不把原块子数组接成引用链。
		bytes.set(chunk, position);
		// 推进已复制长度，为下一块定位。
		position += chunk.length;
	}
	// 返回整块结果，原 chunks 与各块不被改写。
	return bytes;
}

/**
 * Read `length` bytes from `offset` as consecutive reads of at most `chunk` bytes, several in flight. Ends early at
 * the end of the file. A short read continues from where it ended, as sequential reads would. `aborted` is checked
 * after each read; `undefined` means aborted.
 */
// 从给定字节偏移读取最多 length 字节，返回有序块/总长，取消返回 undefined，读取拒绝向外抛；不负责打开/关闭文件。
// 每次填满至八项保留队列，再按发起顺序 await 首项；例：后块先返回也要等前块，前块短读则从其实际结束位置重发。
// 丢弃预读 Promise 只是不再采用结果，不取消或等待它们；无论 EOF、取消、短读，已发请求仍可能在途，不能把 READ_DEPTH 当绝对在途上限。
async function readRange(
	// read 回调接收定位字节 offset/length，返回异步字节块；它不负责把取消判定自动变成远端 cancel。
	read: (offset: number, length: number) => Promise<Uint8Array>,
	// 本次范围起点，调用者负责验证，不在 helper 重查 safe integer。
	offset: number,
	// 希望读取的总字节数，长度 0 时不会发任何 read。
	length: number,
	// 每次预读最大字节数，预期正数，函数不在这里验证 chunk。
	chunk: number,
	// 无参回调只检查客户端取消状态，调用时点在每个已等待读取之后。
	aborted: () => boolean,
	// 返回对象和 undefined 的联合，Promise 拒绝与这个取消哨兵是两种不同结果。
): Promise<{ chunks: Uint8Array[]; total: number } | undefined> {
	// 按最终采用次序保存字节块，不保存已丢弃的预读结果。
	const chunks: Uint8Array[] = [];
	// 累计真正采用字节数，从 0 开始。
	let total = 0;
	// 下一个待发请求的定位偏移，初始为范围起点。
	let next = offset;
	// 每个队列元素同时保存原请求长度与 Promise，方便判断短读；数组不是只保存完成结果。
	const inFlight: { length: number; bytes: Promise<Uint8Array> }[] = [];
	// 采用字节数达到目标才结束；EOF 可在下面提前 break。
	while (total < length) {
		// 保留队列不足八项且尚有未请求范围时继续预发。
		while (inFlight.length < READ_DEPTH && next < offset + length) {
			// 尾块不能超本次剩余目标范围，普通块不超过 chunk。
			const size = Math.min(offset + length - next, chunk);
			// 立即调用 read 发起请求，暂不 await，使多个定位请求可重叠等待。
			const bytes = read(next, size);
			// 附空 catch 防已发但后面丢弃/尚未 await 的拒绝变成未处理拒绝；原 bytes Promise 仍会拒绝，错误没有被转成成功。
			bytes.catch(() => {});
			// 属性简写记录请求大小和原 Promise。
			inFlight.push({ length: size, bytes });
			// 按请求大小预先推进 next，假设该请求能完整读满；短读后会修正。
			next += size;
		}
		// shift 取最早发起请求，! 依赖队列填充逻辑，不检查实际 EOF。
		const head = inFlight.shift()!;
		// await 依序消费，后请求先完成也不能抢先拼入结果。
		const bytes = await head.bytes;
		// 读取完成后才看取消，命中直接返回 undefined，已得到字节和其他在途请求不回滚/主动取消。
		if (aborted()) return undefined;
		// 零字节表示读到末尾，结束采用结果，不再等待队列尾部。
		if (bytes.length === 0) break;
		// 非空块加进结果序列，块引用保留。
		chunks.push(bytes);
		// 按实际收到长度累计，不按最初 size 假定读满。
		total += bytes.length;
		// 短于本请求的预期长度时，后续预发偏移可能留下缺口，需要重排读取。
		if (bytes.length < head.length) {
			// Reads already in flight assumed a full read; continue right after this one.
			// 只清本地队列引用，旧请求已发仍可能执行/占用资源，空 catch 已安装。
			inFlight.length = 0;
			// 下一轮从当前真实采用末端继续，避免把后面预发块直接拼接而跳过未读字节。
			next = offset + total;
		}
	}
	// 返回采用的块和总字节数，EOF 时可小于 length。
	return { chunks, total };
}

/** A daemon handle: valid only in the session that opened it. */
// 句柄包装绑定 env/数字 id/daemon session/打开时路径；数字 id 在重启后可能复用，session 门禁防止误用新 daemon 的同号句柄。
class Handle {
	// 原环境引用提供同一个连接，不拥有独立连接生命周期。
	readonly env: RemoteExecutionEnv;
	// daemon 给出的句柄号，不是操作请求 id。
	readonly id: number;
	// Connection 的本地 daemon 代号，不是聊天会话 id。
	readonly session: number;
	// 打开时解析后的路径用于错误和公开元信息的路径说明，文件改名后也不刷新；句柄请求不会按此路径重新打开文件。
	readonly path: string;

	// 保存环境、句柄号、会话代号和路径，返回包装对象，不发送请求；例：打开回复 handle=3/session=2 后后续读取都要求 session=2。
	constructor(env: RemoteExecutionEnv, id: number, session: number, path: string) {
		// 保存环境原引用，没有创建或复制连接。
		this.env = env;
		// 保存远端句柄数字，readonly 只限制 TS 再赋值。
		this.id = id;
		// 保存打开它的 daemon session，重连不会把此字段自动刷新。
		this.session = session;
		// 保存原路径字符串，不验证文件还处于这个名字。
		this.path = path;
	}

	// 转发一个句柄操作，返回 Connection.request 的 Promise/拒绝，不包 Result；例：fstat 自动加 handle 和原 session。
	// 后展开字段覆盖调用者同名 handle/session，旧会话句柄会失败而不会让连接自动重启后误读别的文件。
	request(op: string, json: Json = {}, options: { signal?: AbortSignal; payload?: Uint8Array } = {}) {
		// 复制 JSON/选项一层再强制本句柄信息，signal/payload 原引用保留；Connection 校验 session 只准当前匹配 daemon。
		return this.env.connection.request(op, { ...json, handle: this.id }, { ...options, session: this.session });
	}

	// 请求定位或顺序读并只返回 payload，无文本解码；例：offset=10 从第 10 字节开始，undefined 则让 daemon 读当前文件位置。没有传 signal，取消由上层检查点观察。
	async pread(offset: number | undefined, length: number): Promise<Uint8Array> {
		// 条件展开在 undefined 时完全省 offset 字段，length 原样发送；await 等完成后提原始字节。
		return (await this.request("pread", { ...(offset === undefined ? {} : { offset }), length })).payload;
	}

	// 尽力关闭远端句柄并等该关闭请求结算，返回 void；例：断线旧句柄 close 的拒绝被吞，不重连或重试，成功返回不证明断线时远端收到 close。
	async close(): Promise<void> {
		// catch 把请求拒绝转为 undefined，因此 close 的预期网络/daemon 失败不向上抛。
		await this.request("close").catch(() => undefined);
	}
}

// 已打开普通文件的二进制读取器；同一实例保句柄，调用者负责 close，并未为同实例的并发调用提供额外互斥锁。
class RemoteBinaryReader implements BinaryReader {
	// # 是 JS 运行时私有字段，readonly 是 TS 的赋值约束，不冻结 Handle 对象。
	readonly #handle: Handle;
	// 本地关闭门禁，设 true 不等于远端关闭已确认。
	#closed = false;

	// 保存已打开句柄，不在构造时读文件；例：openBinaryReader 成功后只在 read/info/scanLines 时真正发后续请求。
	constructor(handle: Handle) {
		// 保持 Handle 原引用与打开 session。
		this.#handle = handle;
	}

	// JS 私有 get 访问器返回打开路径，无 I/O；例如 this.#path 供所有错误附路径，不需要调用括号。
	get #path(): string {
		// 从已保存句柄取路径，不重新跟随当前同名文件。
		return this.#handle.path;
	}

	// 泛型 T 使关闭失败适配不同成功值类型；关闭返回 invalid Result，未关闭返回 undefined，无 I/O。例：info/read 都可复用，不把 undefined 当成功文件内容。
	#closedResult<T>(): Result<T, FileError> | undefined {
		// 三元表达式按 #closed 创建失败，泛型只影响 TS，不生成运行时转换。
		return this.#closed ? err(new FileError("invalid", "Binary reader is closed", this.#path)) : undefined;
	}

	// 查询已打开文件元信息，返回 FileInfo Result；先取消/关闭门禁，再 fstat，再按远端路径规则转换。
	// 例：路径 a 改名 b 后仍 stat 打开的对象，但返回 path/name 仍按原 a；错误映 FileError，发送 fstat 后没有额外取消检查。
	async info(context: Context): Promise<Result<FileInfo, FileError>> {
		// ?? 使已取消优先于已关闭：已有失败就不继续调用关闭检查。
		const early = abortResult<FileInfo>(context.abortSignal, this.#path) ?? this.#closedResult<FileInfo>();
		// 命中任何前置失败立即返回，不发送 fstat。
		if (early) return early;
		try {
			// fstat 针对句柄，而非对原路径重新 lstat。
			const { json } = await this.#handle.request("fstat");
			// 双重 as 把未知协议字段当 RemoteFileInfo，不做完整 wire 校验；remotePath 的 info 失败也会进 catch。
			return toInfo(this.#path, json as unknown as RemoteFileInfo, await remotePath(this.#handle.env.connection));
		} catch (error) {
			// 读取/转换异常映成文件错误，原打开路径作备用路径。
			return err(toFileError(error, this.#path));
		}
	}

	// 按 offset/length 读取字节范围，返回 Uint8Array Result，不移动远端共享文件当前位置；例：read(3,4) 最多取偏移 3–6 的四字节，偏移从 0 开始，EOF 允许更短。
	// 先取消/关闭，再验证非负安全整数，之后分块预读并拼接；每个依序读取后观察取消，失败不自动关闭 reader，调用者仍须 close。
	async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
		// 取消优先于已关闭，再早于参数范围验证。
		const early = abortResult<Uint8Array>(context.abortSignal, this.#path) ?? this.#closedResult<Uint8Array>();
		// 前置失败直接返回，无新读请求。
		if (early) return early;
		// number 类型不能保证整数/非负/安全范围，这里检查参数数值；未额外检查 offset+length 的和是否仍为安全整数。
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
			// 任一个数值不合要求就给 invalid，不发送请求。
			return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.#path));
		}
		try {
			// 调用共享流水读取 helper，等待有序采用结果，不代表先前丢弃的预读都已结束。
			const read = await readRange(
				// 箭头回调将 helper 的字节位置/大小转成当前文件句柄 pread。
				(at, size) => this.#handle.pread(at, size),
				// 原 offset 是本次范围起点，不是文件全局可变游标。
				offset,
				// length 限制本次希望采用的总字节数。
				length,
				// 使用 256 KiB 的 reader 单请求上限。
				READ_CHUNK,
				// 回调每次读取当时 context.abortSignal 的 aborted，严格 true 才判取消。
				() => context.abortSignal?.aborted === true,
			);
			// undefined 是 helper 的取消哨兵，转换成 FileError aborted，不返回部分成功字节。
			if (read === undefined) return err(new FileError("aborted", "aborted", this.#path));
			// 按实际字节数拼有序块，单块时可直接复用该块引用。
			return ok(concat(read.chunks, read.total));
		} catch (error) {
			// 远端失败或分配/转换异常归 FileError，不把失败当作空文件。
			return err(toFileError(error, this.#path));
		}
	}

	// 让 daemon 单次扫描已打开文件，返回所选 0 基行范围 [startLine,endLine) 的字节/解码长度统计，非返回那些行正文。
	// 例：{startLine:1,endLine:3} 选第 2/3 行；前置验证后传 signal 让扫描可收到 cancel，daemon 分块检查取消。失败返回 FileError，reader 不自动关闭。
	async scanLines(
		// options 的 endLine 可省略表示直到末尾，不是“只选 startLine 这一行”。
		options: { startLine: number; endLine?: number },
		// context 携带检查点和传给协议的取消信号。
		context: Context,
		// LineScan 成功值与 FileError 失败标签由 Result 区分。
	): Promise<Result<LineScan, FileError>> {
		// 取消优先于已关闭，仍未解析选项中的数字。
		const early = abortResult<LineScan>(context.abortSignal, this.#path) ?? this.#closedResult<LineScan>();
		// 命中失败时不发扫描请求。
		if (early) return early;
		// 对象解构取起始/排他终点，两者之后均不改写。
		const { startLine, endLine } = options;
		// 以下组合条件验证有效行范围，换行只是同一 if 语句续行。
		if (
			// 起始行必须安全整数，NaN/Infinity/小数均拒绝。
			!Number.isSafeInteger(startLine) ||
			// 起始行允许 0，负数拒绝。
			startLine < 0 ||
			// endLine 未给可接受，给出则必须安全整数且严格大于起点。
			(endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine <= startLine))
		) {
			// 无效范围返回 invalid，不让坏范围到 daemon。
			return err(new FileError("invalid", "Invalid line range", this.#path));
		}
		try {
			// 通过 Handle 带 session 发扫描，和普通不带 signal 的 pread 不同。
			const { json } = await this.#handle.request(
				// 固定操作名 scanLines，实际遍历在 daemon。
				"scanLines",
				// 终点缺省时完全省字段，显式 0 不因真值判断被省掉，但前面的范围检查通常会拒绝它。
				{ startLine, ...(endLine === undefined ? {} : { endLine }) },
				// 存在 signal 才加选项，Connection 取消只通知并仍等终态，不在这里马上拒绝 Promise。
				context.abortSignal ? { signal: context.abortSignal } : {},
			);
			// 回复 JSON 直接断言 LineScan 并包成功，未逐字段校验或再查本地 signal。
			return ok(json as unknown as LineScan);
		} catch (error) {
			// 扫描/连接异常映为文件错误，保留已知远端 code/path。
			return err(toFileError(error, this.#path));
		}
	}

	// 幂等尽力关闭，无视 _context 取消，返回 Promise<void>；例：取消后仍能 close 释放句柄，第二次 close 直接返回，不共享首次尚未完成的等待。
	async close(_context: Context): Promise<void> {
		// 已在本地标记关闭就立即返回，不再发 close。
		if (this.#closed) return;
		// 先关门禁，之后未先被取消检查拦下的新读取会报 invalid，即使远端 close 尚在途。
		this.#closed = true;
		// 等待 Handle 的尽力关闭，它会吞请求拒绝。
		await this.#handle.close();
	}
}

// 目录分页包装记录 done 和 closed；每页按 daemon 文件系统次序读取，不执行 listDir 的全量 POSIX 字节排序。
class RemoteDirReader implements DirReader {
	// 保留同一目录句柄及打开 session，后续 next 不重新 opendir。
	readonly #handle: Handle;
	// 是否读到目录尾，true 后 next 可直接返回空页。
	#done = false;
	// 本地关闭标志与目录读完分开，读完仍需 close。
	#closed = false;

	// 保存打开目录句柄，没有额外读取；例：构造后的首个 next(10) 才请求目录页。
	constructor(handle: Handle) {
		// 保持句柄引用，不复制目录内容。
		this.#handle = handle;
	}

	// 读取最多 maxEntries 个可支持条目并返回 done，先取消/关闭/参数检查，再循环补满页面；不全量排序。
	// 例：一页中有已消失 ENOENT 或 other，跳过它们继续补可用条目；其他逐项错误使整次失败。失败/取消后目录游标可能已推进，契约要求关闭 reader，不能假定重试原页。
	// 当前实例不额外串行化多个并发 next；本地信号只在入口和每次 readdir 后检查，不传给短 readdir 请求。
	async next(
		// 页长 number 还需下面验证正安全整数。
		maxEntries: number,
		// Context 用于取消检查点，不在这里控制目录排序。
		context: Context,
		// 成功对象里的 entries 和 done 分别表示本页数据与远端尾部状态，最后一页可以带数据且 done=true。
	): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
		// 本次操作的备用错误路径取打开目录路径，不随 cwd 之后修改；具体远端错误自带 path 可优先。
		const path = this.#handle.path;
		// 先观察本地取消状态，泛型指定本页成功结构。
		const aborted = abortResult<{ entries: FileInfo[]; done: boolean }>(context.abortSignal, path);
		// 已取消优先返回，尚不判断 closed/maxEntries。
		if (aborted) return aborted;
		// 关闭后 next 返回 invalid，而非成功空页。
		if (this.#closed) return err(new FileError("invalid", "Directory reader is closed", path));
		// 页长必须 >0 的安全整数，0/负数/小数等拒绝。
		if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
			// 非法页长立即返回文件错误。
			return err(new FileError("invalid", "maxEntries must be a positive safe integer", path));
		}
		// 每次 next 新建结果数组，不把上次页原数组继续交出。
		const entries: FileInfo[] = [];
		try {
			// 取远端路径规则，目录项路径不能按本机平台拼。
			const paths = await remotePath(this.#handle.env.connection);
			// Like `NodeDirReader`, count only entries that are part of the listing.
			// 目录未到底且可用项不足页长便继续请求，跳过项目不占用可用条目数量。
			while (!this.#done && entries.length < maxEntries) {
				// 只请求剩余配额，daemon 的页可含之后被跳过的项目。
				const { json } = await this.#handle.request("readdir", { max: maxEntries - entries.length });
				// 读取已推进远端目录游标，再检查本地取消。
				const loopAbort = abortResult<{ entries: FileInfo[]; done: boolean }>(context.abortSignal, path);
				// 取消时返回失败而不是已积累部分页，不能回滚目录游标。
				if (loopAbort) return loopAbort;
				// as 仅声明协议数组形状，没验证 entries 真为数组或每项具有效元数据。
				for (const entry of json.entries as RemoteDirEntry[]) {
					// 用远端规则将目录和已解码 entry.name 解析成项路径。
					const entryPath = paths.resolve(path, entry.name);
					// error 字段只要不是 undefined 就按条目失败处理，不使用 info。
					if (entry.error !== undefined) {
						// Removed between enumeration and lstat: not part of the listing any more.
						// 枚举到 lstat 之间消失的项目不再属于列表，ENOENT 被跳过并继续填页。
						if (entry.error.code === "ENOENT") continue;
						// 其他条目错误按其路径转换后立即失败，不返回当前已收的部分 entries。
						return err(toFileError(new RemoteError(entry.error), entryPath));
					}
					// info! 依赖协议约定并非实际检查；other 转换为失败值，但下面只挑成功项，所以被跳过。
					const info = toInfo(entryPath, entry.info!, paths);
					// 只有支持的 FileInfo 进入可用列表，不把跳过项计入页长。
					if (info.ok) entries.push(info.value);
				}
				// 只精确布尔 true 表示尾部，字符串 true/数字 1 不接受；这一步发生在页项处理后。
				this.#done = json.done === true;
			}
			// 可能带最后一批数据和 done=true，读完后再 next 返回 entries=[]/done=true。
			return ok({ entries, done: this.#done });
		} catch (error) {
			// 远端/转换异常包 FileError，目录读取器本身没有自动关闭。
			return err(toFileError(error, path));
		}
	}

	// 目录 reader 幂等尽力关闭，忽略传入 Context 的取消；例：next 已失败仍须调用 close，第二次不重新发请求，也不等待首次还在途的 close。
	async close(_context: Context): Promise<void> {
		// 本地已关闭直接完成。
		if (this.#closed) return;
		// 先设关闭标志，再做异步远端释放。
		this.#closed = true;
		// Handle 吞关闭请求失败，所以这里不保证远端明确确认释放。
		await this.#handle.close();
	}
}

/** `NodeTextLineReader`: positional reads of a file opened like `open(path, "r")`. */
// 按 LF 逐行的远端读取器，用定位读和本地流解码；普通文件/设备等以 open(mode:read) 打开，和只允许普通文件的 BinaryReader 不同。
class RemoteTextLineReader implements TextLineReader {
	// 已打开句柄让路径被改名后仍对同一文件读，不重新按路径打开。
	readonly #handle: Handle;
	// 每实例独立 StreamDecoder，跨块保 UTF-8 字符且只去流最前 BOM，不去中途 U+FEFF。
	readonly #decoder = new StreamDecoder();
	// 定位字节偏移，和已解码字符串的码元长度不同。
	#offset = 0;
	// 积累尚未交付的解码文字，单行可非常长，未设长度上限。
	#buffered = "";
	// 只有读到零字节才标 EOF，尾部无 LF 的文字还能作为最后一行返回。
	#ended = false;
	// 关闭标志独立于 EOF，读完并不自动释放句柄。
	#closed = false;

	// 保存 read 模式句柄，构造不立刻请求字节；例：openTextLineReader 成功后首次 readLine 才尝试实际读文件，目录可能到那时才报错。
	constructor(handle: Handle) {
		// 保持句柄原引用，偏移/缓冲等使用字段初值。
		this.#handle = handle;
	}

	// 返回下一行 TextLine，真正 EOF 返回 ok(undefined)，错误返回 FileError；每轮先查缓冲 LF，再查尾部，最后才定位读更多字节。
	// 例：a、CR、LF、b 组成的文本，首行保留 a 后的 CR 且 terminated=true，再返回 b/false，之后 undefined；只去 LF，不自动剥 CR，也不在尾部 LF 后凭空再生成空行。
	// 读后取消发生在推进偏移/解码之前，因此同实例后续用未取消上下文重读该位置不会跳过这些字节；没有并发 readLine 的互斥或快照保证。
	async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		// 保存打开路径供所有错误使用。
		const path = this.#handle.path;
		// 入口先查取消，早于关闭检查或消耗已有缓冲行。
		const aborted = abortResult<TextLine | undefined>(context.abortSignal, path);
		// 已取消返回失败，不从缓冲中拿走下一行。
		if (aborted) return aborted;
		// 已关闭返回 invalid，不把它伪装成正常 EOF。
		if (this.#closed) return err(new FileError("invalid", "Text line reader is closed", path));
		try {
			// 直到产出一行、遇到 EOF 或错误才退出，不为每个 readLine 固定只读一个块。
			while (true) {
				// 在已解码字符串中找 LF，indexOf 给 UTF-16 下标，适合随后的字符串 slice。
				const newline = this.#buffered.indexOf("\n");
				// 有 LF 就可交付一行，不再发送额外读取。
				if (newline !== -1) {
					// 行正文不包含这个 LF，但其前的 CR 仍会保留。
					const text = this.#buffered.slice(0, newline);
					// 缓冲保留 LF 后全部文本，连续 LF 会在下次给出空正文行。
					this.#buffered = this.#buffered.slice(newline + 1);
					// terminated=true 表示实际读到终止 LF，不是是否最后一行。
					return ok({ text, terminated: true });
				}
				// 无 LF 且已知 EOF 时只处理最后剩余文本。
				if (this.#ended) {
					// 缓冲空则正常结束，末尾 LF 之后不再人为多交付一个空行。
					if (this.#buffered.length === 0) return ok(undefined);
					// 保存当前无终止 LF 的尾部正文。
					const text = this.#buffered;
					// 清已交付缓冲，之后调用便返回 EOF。
					this.#buffered = "";
					// 尾部最后一行 terminated=false。
					return ok({ text, terminated: false });
				}
				// 从当前字节位置取 64 KiB，不传 signal；普通文件用定位读，不移动共享文件游标。
				const bytes = await this.#handle.pread(this.#offset, LINE_CHUNK);
				// 读取返回后但偏移/解码状态尚未改变时检查取消。
				const afterReadAbort = abortResult<TextLine | undefined>(context.abortSignal, path);
				// 取消就丢弃本次得到的字节并保偏移/解码状态，稍后可从同偏移重读；远端读取本身仍已发生。
				if (afterReadAbort) return afterReadAbort;
				// 确认可采用后按实际字节数推进，不按请求 64 KiB 假定满块。
				this.#offset += bytes.length;
				// 零字节才进入 EOF 解码收尾，短非零块仍可能继续读。
				if (bytes.length === 0) {
					// 无参数 decode flush 未完成 UTF-8 序列，必要时产生替换字符。
					this.#buffered += this.#decoder.decode();
					// 设 EOF，下一轮会交付尾部或正常结束，不再 pread。
					this.#ended = true;
				} else {
					// 非空块流式解码，可能因字符只到一半暂时不产文字。
					this.#buffered += this.#decoder.decode(bytes);
				}
			}
		} catch (error) {
			// 请求/解码异常映成 FileError，不自动重置缓冲或关闭 reader。
			return err(toFileError(error, path));
		}
	}

	// 幂等尽力关闭并清尚未交付文字，不理会取消 Context；例：取消后 close 仍执行，第二次直接返回，不共享首次等待。
	async close(_context: Context): Promise<void> {
		// 已关闭时不再次清理/发请求。
		if (this.#closed) return;
		// 先设门禁，新 readLine 会返回失败 Result；它不因此抛异常或拒绝 Promise。
		this.#closed = true;
		// 清 buffered 放掉未交付行正文，decoder/offset 没有在这里重建为可复用 reader。
		this.#buffered = "";
		// 请求释放句柄，网络/远端失败由 Handle.close 吞掉。
		await this.#handle.close();
	}
}

/**
 * An `ExecutionEnv` on another machine, reached through a pi-env daemon. Results match `NodeExecutionEnv` running on
 * that machine: the daemon performs the system calls, and this class applies Node's path, error, and result rules.
 */
// 公开远端执行环境，实现 Durable 的文件系统与 Shell 契约；多数文件错误包 Result，连接由调用者持有。
// 构造不部署 daemon，具体系统调用/权限/进程行为由远端实现决定；本层模拟 Node 的分块、路径和检查点，不能把接口名或类型当作快照、事务或沙箱保证。
export class RemoteExecutionEnv implements ExecutionEnv {
	// 文件命名空间 id，readonly 仅限制 TS 再赋值，不验证其他同 id 实例真的连接同一主机。
	readonly id: string;
	// 可修改的工作目录字符串，relative 路径解析和默认 exec cwd 读取它当时的值。
	cwd: string;
	// 外部连接引用，cleanup 不自动 close 它，以免干扰共享此连接的其他环境。
	readonly connection: Connection;
	// JS 私有字段存可选默认 shell 路径，仅请求 exec 时转发。
	readonly #shellPath: string | undefined;
	// 默认 shell 环境字典保原引用，readonly 不会冻结其内容；每次 exec 会再展开当时值。
	readonly #shellEnv: Record<string, string> | undefined;
	// 默认监控选项原引用，RemoteWatcher 可在重连时继续读取。
	readonly #watchOptions: RemoteWatchOptions;
	/** Running commands this environment started, for `cleanup()`. */
	// Map 键是本地请求 id，值是 daemon session，非操作系统 pid；仅记录本环境在 onStart 时登记的在途 exec。
	readonly #running = new Map<number, number>();

	// 从 options 保存身份/目录/连接及默认选项，返回新实例，不发请求或验证目录；例：new RemoteExecutionEnv({connection,id:"pi-env:box",cwd:"/work"}) 后首次文件操作才可能连接。
	constructor(options: RemoteExecutionEnvOptions) {
		// 原样保存命名空间 id，不由主机名自动推导。
		this.id = options.id;
		// 保存传入 cwd，未在此 normalize、realpath 或检查存在性。
		this.cwd = options.cwd;
		// 复用外部 Connection，不新建额外远端会话。
		this.connection = options.connection;
		// 记录默认 shell，未给则 undefined 让 daemon 选择。
		this.#shellPath = options.shellPath;
		// 保环境字典引用，不深复制键值。
		this.#shellEnv = options.shellEnv;
		// watch 仅缺省时取空对象，显式选项对象继续共享。
		this.#watchOptions = options.watch ?? {};
	}

	/** Node's `resolvePath` on the remote system, with its home directory and working directories. */
	// 异步把路径按选定远端平台规则解析成路径字符串，不检查文件存在/权限、不 realpath。
	// 先取 hello，展开 ~ 或 file://，再处理绝对、Windows 跨驱动器相对路径，最后与本实例 cwd 组合；例：POSIX cwd=/work，src/a 得 /work/src/a，~/a 使用远端 home。
	// 允许 .. 离开 cwd，并非沙箱；cwd 本身未验证。Windows 绝对分支直接调用客户端 win32.resolve，不在此把所有缺驱动器情形都改成远端 cwd。
	async #resolve(path: string): Promise<string> {
		// info 可按需启动连接，获取远端 home/系统/每驱动器目录；失败使本函数 Promise 拒绝。
		const info = await this.connection.info();
		// 只映为 win32 才启用 Windows 分支，其他系统走 POSIX。
		const windows = nodePlatform(info).platform === "win32";
		// paths 是一整套路径函数，本机是什么系统不会直接决定选哪套。
		const paths = windows ? win32 : posix;
		// 局部可变字符串用于逐步规范化，不修改传入 path。
		let normalized = path;
		// 只支持恰好 ~ 代表整个 home，不扩展 ~alice 等用户语法。
		if (normalized === "~") {
			// 使用 hello 中远端 home，非客户端 process.env.HOME。
			normalized = info.home;
			// ~/ 两平台支持，反斜杠形式只在 Windows 支持，条件顺序在 URL 转换之前。
		} else if (normalized.startsWith("~/") || (windows && normalized.startsWith("~\\"))) {
			// 去掉开头两个码元后按选定规则 join；这不是远端 shell 的变量展开。
			normalized = paths.join(info.home, normalized.slice(2));
			// 只有精确小写 file:// 前缀才尝试 URL 转换。
		} else if (normalized.startsWith("file://")) {
			try {
				// 显式传 windows，令 URL 解码按选定系统而非本机默认平台。
				normalized = fileURLToPath(normalized, { windows });
				// URL 无效时吞转换异常，normalized 保留原文字，后面当普通路径解析，不返回 URL 解析专用错误。
			} catch {
				// Keep malformed URLs as ordinary paths, as Node does.
			}
		}
		// 绝对分支直接 paths.resolve(normalized)，没有传 this.cwd；尤其 Windows 根相对路径的设备补全仍按该 Node 函数自身规则处理。
		if (paths.isAbsolute(normalized)) return paths.resolve(normalized);
		// 下面只处理未被前一绝对分支返回的 Windows 路径。
		if (windows) {
			// A drive-relative path on another drive: Node on Windows resolves it against that drive's working directory
			// (`=D:`), else its own working directory if on that drive, else the drive's root.
			// 正则捕获盘符加冒号，负向前瞻排除其后斜杠/反斜杠，因此 D:foo 属于驱动器相对路径；?.[1] 取捕获组或 undefined。
			const drive = /^([a-zA-Z]:)(?![\\/])/.exec(normalized)?.[1];
			// 只为与环境 cwd 开头盘符不同的情况启用远端每盘目录表，比较忽略大小写。
			if (drive !== undefined && drive.toLowerCase() !== this.cwd.slice(0, 2).toLowerCase()) {
				// 优先选 driveCwds 对应大写盘符的值，缺省用 daemon cwd；字典字段按协议断言，未在此校验所有值。
				let base = info.driveCwds[drive.toUpperCase()] ?? info.cwd;
				// 基底盘符仍不对且第三码元是反斜杠时改该盘根；这是实际条件，不是无条件对所有异常基底修正。
				if (base.slice(0, 2).toLowerCase() !== drive.toLowerCase() && base[2] === "\\") base = `${drive}\\`;
				// 用远端提供的基底结合驱动器相对路径，例：D:src 可落到远端 D 盘工作目录下。
				return win32.resolve(base, normalized);
			}
		}
		// 其余相对路径与本实例 cwd 结合，.. 可向上走，不检查是否越出工作目录。
		return paths.resolve(this.cwd, normalized);
	}

	// 包装一个文件操作：先解析路径，再前置取消，再 await run，按 check 可再后置取消，最后包 Result；预期异常映 FileError。
	// 例：truncate 用 both，远端已截断后收到取消仍可返回 aborted，不撤销截断；before 模式没有统一后置检查，run 可自行增加检查点。
	// 路径解析先于取消，已取消调用也可能为了 hello 建连接；回调副作用不由此函数事务回滚。
	async #fileOp<T>(
		// 用户给的路径，用于解析失败时的备用错误路径。
		path: string,
		// Context 的 signal 在各检查点读取，不自动塞给每个网络请求。
		context: Context,
		// 泛型 T 表示操作成功值，run 接收解析后的路径，Promise 可拒绝；不是自动生成的文件操作。
		run: (resolved: string) => Promise<T>,
		// 字面量模式默认 before，只做前置；both 在 run 成功后再观察一次取消。
		check: "before" | "both" = "before",
		// 异步返回成功值 T 或 FileError 标签，转换错误本身若因恶意抛值转换失败仍可能拒绝，并非运行时不可抛的保证。
	): Promise<Result<T, FileError>> {
		// resolved 先声明，只有成功解析后才被后续请求使用。
		let resolved: string;
		try {
			// 路径解析可需要连接/hello，未先检查本地 signal。
			resolved = await this.#resolve(path);
		} catch (error) {
			// 解析失败用原 path 作为错误路径兜底，尚未有可靠 resolved。
			return err(toFileError(error, path));
		}
		// 解析完成后前置检查取消，用已经解析的路径标记错误。
		const aborted = abortResult<T>(context.abortSignal, resolved);
		// 已取消就不进入实际 run，但路径解析副作用可能已经发生。
		if (aborted) return aborted;
		try {
			// 等待调用者回调，它可发一个或多个请求或返回嵌套 Result。
			const value = await run(resolved);
			// 仅 both 在成功返回后做统一后置取消；若 run 抛错则直接进入 catch，不被此检查覆盖。
			if (check === "both") {
				// 后置观察这一个时刻 signal 状态，不取消已经执行完的变更。
				const after = abortResult<T>(context.abortSignal, resolved);
				// 取消返回失败而非成功 value，已经得到的值/远端副作用不回滚。
				if (after) return after;
			}
			// 成功包一层 ok；若 T 本身也是 Result，则形成嵌套，由如 fileInfo 的调用方展开。
			return ok(value);
		} catch (error) {
			// 实际操作失败按 resolved 转 FileError，RemoteError 自带 path 可优先于该备用路径。
			return err(toFileError(error, resolved));
		}
	}

	// 用已解析路径打开 daemon 文件并建 Handle，返回句柄加原 JSON，不包 Result、失败直接拒绝。
	// 例：mode:read 允许普通文件/设备等并返回 stat/statError；不带 mode 的 reader 打开规则在 daemon 限定普通文件。调用者负责后续 close。
	async #open(resolved: string, json: Json): Promise<{ handle: Handle; json: Json }> {
		// 对象后展开 json 可覆盖同名 path，当前内部调用只给 mode/noFollow；不把 Json 静态字典当字段白名单。
		const reply = await this.connection.request("open", { path: resolved, ...json });
		// handle 字段 as number 仅断言，保真实回复 session 绑定句柄；json 仍原对象引用，未逐字段验证。
		return { handle: new Handle(this, reply.json.handle as number, reply.session, resolved), json: reply.json };
	}

	// 解析路径并包 Result，_context 未使用，已取消上下文也可成功；例：absolutePath("../a") 只算路径不读文件，但 info 仍可能按需连接，失败映原 path。
	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		try {
			// await 解析成功后包 ok，不做存在性或沙箱边界检查。
			return ok(await this.#resolve(path));
		} catch (error) {
			// 只把解析/连接错误映成 FileError，不把任意输入修成有效文件。
			return err(toFileError(error, path));
		}
	}

	// 按远端平台 join 多段并包字符串 Result，不用 cwd 补成绝对路径、不展开 home/URL；例：POSIX ["a","b"] 得 a/b。忽略 _context 取消，info/路径异常映 FileError。
	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		try {
			// ...parts 将数组各项作为 join 参数，先等待远端路径规则；join 与 resolve 语义不同。
			return ok((await remotePath(this.connection)).join(...parts));
		} catch (error) {
			// 没有单一路径可附时不传 fallbackPath，只保可提取的错误信息。
			return err(toFileError(error));
		}
	}

	/** Node's `readFile`, with or without UTF-8 decoding, over a file opened like `open(path, "r")`. */
	// 读整个文件为文本或字节 Result：解析/前置取消→open(read)→检查 stat→按已知/未知大小读取→finally 尽力关闭。
	// 例：readTextFile 使用 Node UTF-8 解码并保留开头 BOM，readBinaryFile 返回 Buffer；它们与逐行 reader 的 BOM/返回形状不同。
	// 已知大小超阈值先拒绝，未知流没有累计上限；多种分支的取消检查点不同，已发预读不主动取消，返回失败不意味着未读或未打开文件。并发改写/增长不保证一致快照。
	async #readFile(path: string, encoding: boolean, context: Context): Promise<Result<Uint8Array | string, FileError>> {
		// 捕获这次 Context 的 signal 引用，后面闭包反复读其状态。
		const signal = context.abortSignal;
		// 共享包装先解析并检查取消，encoding 分支只是内部选择，本函数真正请求都在回调内。
		return this.#fileOp(path, context, async (resolved) => {
			// mode:read 按普通 open(r) 方式打开，可能阻塞等 FIFO 写端；回复即使 statError 也可能带有效句柄，后面 finally 仍关闭。
			const { handle, json } = await this.#open(resolved, { mode: "read" });
			// 局部无参函数检查信号，未提供 signal 时严格比较的结果是 false，不发远端 cancel。
			const aborted = () => signal?.aborted === true;
			// 局部工厂创建带完整 resolved 路径的 aborted 错误；调用才创建，非立刻 throw。
			const abort = () => new FileError("aborted", "The operation was aborted", resolved);
			try {
				// fstat 错误作为 open 的 JSON 字段返回时，先转 RemoteError 再由外层包装映码。
				if (json.statError !== undefined) throw new RemoteError(json.statError as Json);
				// 打开后检查取消，命中也进入 finally 关句柄。
				if (aborted()) throw abort();
				// 断言 stat 的静态形状，不进行完整字段运行时校验。
				const stat = json.stat as RemoteFileInfo;
				// 只有普通文件采用 stat.size，其他类型按未知大小 0 处理；普通空文件也走未知大小路径。
				const size = stat.kind === "file" ? stat.size : 0;
				// 只检查打开时已知大小是否超过 2^31-1，不在未知流循环累计检查总量。
				if (size > READ_FILE_MAX) {
					// 过大返回 unknown 类文件错误而非 invalid，实际字符串保持原样。
					throw new FileError("unknown", `File size (${size}) is greater than 2 GiB`, resolved);
				}
				// size=0 采用顺序读直到零字节，不把它直接当空文件返回。
				if (size === 0) {
					// Unknown size: sequential reads until the end, as for FIFOs and devices.
					// StringDecoder 跨块保未完成字符，默认 UTF-8，保留 BOM；编码开关关闭时也会创建实例但不写入解码数据。
					const decoder = new StringDecoder("utf8");
					// 所有原字节块都暂存，包括 encoding=true 的未知大小路径，文本模式也可能同时占字节和字符串内存。
					const chunks: Uint8Array[] = [];
					// 累计实际收到字节长度。
					let total = 0;
					// 文本累积从空串开始，字节模式不更新它。
					let text = "";
					// 未知大小只能不断读直到零字节，非零短读不会直接结束。
					while (true) {
						// 每次新读之前观察取消；没有在本循环每次读后立刻统一检查。
						if (aborted()) throw abort();
						// offset undefined 省协议字段，读共享文件当前位置；每次最多 64 KiB，一次只 await 一个请求。
						const bytes = await handle.pread(undefined, READ_FILE_UNKNOWN_CHUNK);
						// 零字节立即退出，因此若取消恰在最后这次零读等待期间发生，本路径没有再观察它的后置检查。
						if (bytes.length === 0) break;
						// 只累计非空结果字节数。
						total += bytes.length;
						// 字节和文本模式都保留块引用，后面按编码分支决定返回形式。
						chunks.push(bytes);
						// 文本模式将本块流式解码，跨块未完成 UTF-8 暂留 decoder 内部。
						if (encoding) text += decoder.write(bytes);
					}
					// 字节模式返回 Buffer 合并，Buffer 是 Uint8Array 子类，不是普通新 Uint8Array 的同一具体构造器。
					if (!encoding) return Buffer.concat(chunks, total);
					// 无字节则空文本；有字节时 flush 未完成序列再拼尾部，BOM 不在这里删除。
					return total === 0 ? "" : text + decoder.end();
				}
				// 已知正大小且不解码时走二进制读取分支。
				if (!encoding) {
					// A single read of the whole size, or reads of 512 KiB until the size or the end of the file.
					// 小文件一次定位读并转 Buffer，读后没有再检查 signal；取消等待期间发生不一定使此分支返回 aborted。
					if (size <= READ_FILE_CHUNK) return Buffer.from(await handle.pread(0, size));
					// 超过 512 KiB 的已知二进制范围走共享流水 helper。
					const read = await readRange(
						// 回调按给定位置和大小对同一打开句柄 pread。
						(at, length) => handle.pread(at, length),
						// 范围从字节 0 开始。
						0,
						// 范围目标上限是打开时 size，不主动跟进后续增长。
						size,
						// readFile 使用 512 KiB 分块，而非普通 BinaryReader 的 256 KiB。
						READ_FILE_CHUNK,
						// helper 每个采用读取后调用此取消检查。
						aborted,
					);
					// helper 报取消时抛局部 FileError，外层 #fileOp 包失败，finally 仍关句柄。
					if (read === undefined) throw abort();
					// 按实际读到的总字节合并，EOF 可比初始 size 更早。
					return Buffer.concat(read.chunks, read.total);
				}
				// Decoding: reads of min(size, 512 KiB) until the size, a short read, or the end of the file.
				// 文本分支每次请求 length=min(size,512KiB)，尾部并不把每次请求再夹到 size-next。
				const length = Math.min(size, READ_FILE_CHUNK);
				// Node StringDecoder 负责文本跨块，开头 BOM 保留。
				const decoder = new StringDecoder("utf8");
				// 已采用的前面完整块解码文字。
				let text = "";
				// 累计采用字节数，用来判断是否恰好达到打开时 size。
				let total = 0;
				// first 区分是否首个采用块，首块就结束时可以直接 Buffer.toString。
				let first = true;
				// 保存预发 Promise，按发起顺序 shift 等待，不按完成顺序消费。
				const inFlight: Promise<Uint8Array>[] = [];
				// 下一个定位请求从 0 开始，之后每次固定加 length。
				let next = 0;
				// 直到下面 EOF/恰好 size/短块条件成立，或异常取消才结束。
				while (true) {
					// 把保留队列补到八项，此循环不检查 next<size，因此可预读 size 之后的偏移。
					while (inFlight.length < READ_DEPTH) {
						// 立即发送定位请求，不等它完成再发下一个。
						const bytes = handle.pread(next, length);
						// 安装空 catch 消费未采用预读的拒绝，原 Promise 仍可能在 await 时抛。
						bytes.catch(() => {});
						// 入队保留原 Promise。
						inFlight.push(bytes);
						// 预发偏移按固定 length 推进，不依后面真实读到的长度。
						next += length;
					}
					// 按原请求顺序等待最早块，! 是静态非空断言。
					const bytes = await inFlight.shift()!;
					// 文本已知大小路径每个采用读取后检查取消，再做解码/计数。
					if (aborted()) throw abort();
					// 按实际返回字节数累计，不按每请求长度猜测。
					total += bytes.length;
					// 零读、累计恰等于 size 或非满块都结束；条件是 === 而非 >=，并发增长时不能理解成绝对不会超过初始 size。
					if (bytes.length === 0 || total === size || bytes.length !== length) {
						// 首块就结束直接 UTF-8 转串；已有前缀时由 decoder.end 接最后块并 flush，不丢跨块字符。
						return first ? Buffer.from(bytes).toString("utf8") : text + decoder.end(Buffer.from(bytes));
					}
					// 还未达到结束条件的完整块流式解码并追加，保存尾部未完成字节供后续。
					text += decoder.write(Buffer.from(bytes));
					// 已采用过首块，下一次结束就要与前缀/decoder 状态合并。
					first = false;
				}
				// 无论返回、取消还是错误，都尝试释放打开句柄。
			} finally {
				// 等待 close 请求的尽力收尾；未逐个 await/cancel 仍在队列里的预读，请求可能尚在执行。
				await handle.close();
			}
		});
	}

	// 按文本模式读整个文件，返回字符串 Result；例：UTF-8 BOM 保留为 U+FEFF，逐行接口则不同。实际 I/O/检查点/关闭交 #readFile，失败不自动变空串。
	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		// true 选文本分支，as 只缩窄静态联合返回类型，不在运行时转换 bytes 为 string。
		return (await this.#readFile(path, true, context)) as Result<string, FileError>;
	}

	// 按字节模式读整个文件，返回 Uint8Array 契约下的 Buffer Result；例：任意二进制字节原样，不应用 UTF-8 解码。关闭/错误处理由 #readFile 负责。
	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		// false 选择字节分支，断言不额外复制或验证结果结构。
		return (await this.#readFile(path, false, context)) as Result<Uint8Array, FileError>;
	}

	// 打开普通文件的定位 reader 并返回 Result，调用者拥有 close 责任；例：noFollow=true 拒绝最终符号链接，但更早路径组件仍可跟链接。
	// 先解析/取消→open→开后取消检查，若开后取消先关新句柄再返回 aborted；真实打开规则由 daemon 执行，失败映 FileError，不承诺通用路径沙箱。
	async openBinaryReader(
		// 支持相对/绝对等路径语法，先由 #fileOp 解析。
		path: string,
		// options 可整个缺省，noFollow 只有精确 true 才启用。
		options: { noFollow?: boolean } | undefined,
		// 上下文用于开前/开后检查，本请求未传 signal 到 open。
		context: Context,
		// 成功返回 BinaryReader 接口，不暴露内部 Handle 类型。
	): Promise<Result<BinaryReader, FileError>> {
		// #fileOp 默认 before，只统一做解析后的前置取消。
		const opened = await this.#fileOp(path, context, async (resolved) => {
			// 没有 mode:read，daemon 的 regular-file reader 打开检查生效；取回复中句柄，未在本层重复 lstat。
			return (await this.#open(resolved, { noFollow: options?.noFollow === true })).handle;
		});
		// 打开失败原 Result 直接返回，不读取不存在的 value。
		if (!opened.ok) return opened;
		// 成功拿到句柄之后再观察取消，避免把无人持有的新句柄泄漏给失败路径。
		const aborted = abortResult<BinaryReader>(context.abortSignal, opened.value.path);
		// 开后取消需要释放已经获得的资源。
		if (aborted) {
			// 尽力关闭同 session 的句柄，失败被吞。
			await opened.value.close();
			// 返回先前捕获的 aborted Result，不返回一个已关闭 reader。
			return aborted;
		}
		// 成功后创建 reader 包装并把 close 责任交给调用者。
		return ok(new RemoteBinaryReader(opened.value));
	}

	// 打开流式逐行 reader，支持 open(r) 能打开的类型而非仅普通文件；例：打开目录可能成功，首次 readLine 才读错。
	// 先 #fileOp 开前检查，开后再查取消，命中先关闭；返回成功后需调用者 close，不在此读第一行或处理 BOM。
	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		// 用共享文件包装解析路径、映错误。
		const opened = await this.#fileOp(path, context, async (resolved) => {
			// 显式 mode:read 选择阻塞 read 打开语义，未给 noFollow 限制。
			return (await this.#open(resolved, { mode: "read" })).handle;
		});
		// 打开失败直接传递 FileError Result。
		if (!opened.ok) return opened;
		// 拿到句柄后再次检查 signal。
		const aborted = abortResult<TextLineReader>(context.abortSignal, opened.value.path);
		// 取消时不能把还开着的资源就这样丢掉。
		if (aborted) {
			// 等待尽力关闭，但不保证网络故障时远端收到关闭。
			await opened.value.close();
			// 返回取消失败，未创建可供使用的 reader。
			return aborted;
		}
		// 新建 reader 内部才初始化 StreamDecoder/偏移/缓冲，返回它的成功包装。
		return ok(new RemoteTextLineReader(opened.value));
	}

	// 读取至 maxLines 行或 EOF，返回仅含各行正文的字符串数组，finally 关闭 reader；例：a LF b 得 [a,b]，不保留 terminated 标记。
	// maxLines<=0 直接成功空数组，甚至跳过路径/取消检查；没有全面校验整数/NaN，正小数会按 while 的比较取得向上达到阈值的项数，NaN 会在打开后零次循环。
	async readTextLines(
		// 原路径交 openTextLineReader 统一处理，不自行重复解析。
		path: string,
		// 可选 maxLines 表示最大采用行数，缺省一直读到 EOF。
		options: { maxLines?: number } | undefined,
		// 同一上下文贯穿打开、每行读取及关闭；关闭实现本身忽略取消。
		context: Context,
		// 成功值是新数组，不是异步迭代器或打开句柄。
	): Promise<Result<string[], FileError>> {
		// 明确提前短路条件，负无穷也满足 <=0；无 maxLines 时不走此分支。
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		// 开 reader 后才建立收集循环，打开也可能失败。
		const opened = await this.openTextLineReader(path, context);
		// 失败直接返回，不进入持有 reader 的 try/finally。
		if (!opened.ok) return opened;
		// 每次调用新建行数组，保留已取得的正文。
		const lines: string[] = [];
		try {
			// 缺上限或当前行数尚小于上限才读下一行；没有对非整数上限做额外归一化。
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				// await 一次只拿一行，底层可为这一行读取多个字节块。
				const line = await opened.value.readLine(context);
				// 失败返回同一 FileError Result，已收部分行不作为成功值交付。
				if (!line.ok) return line;
				// value===undefined 是 EOF，空字符串正文则仍是一条合法空行。
				if (line.value === undefined) break;
				// 只存 text，terminated 是否有 LF 的信息被这个便利方法丢弃。
				lines.push(line.value.text);
			}
			// 达到上限或 EOF 返回成功数组。
			return ok(lines);
			// 任何返回/错误均进入 finally，释放已打开 reader。
		} finally {
			// close 忽略取消并尽力关闭，不把取消后的资源清理直接跳过。
			await opened.value.close(context);
		}
	}

	/**
	 * Node's `writeFile` (abort checked before each 512 KiB write) or `appendFile` (no checks, one after): the first
	 * request creates parents, opens, and writes the first chunk; later chunks go to the same open file.
	 */
	// 把文本/字节分块写入或追加，返回 void Result，可能创建父目录/文件或改已有内容；非事务，也不做原内容回滚。
	// 先 UTF-8 编码、解析/前置取消；首个 write 请求包含建父/打开/首块，超过 512KiB 后用同句柄按到达次序 writeChunk。例：1MiB+1 字节产生首块、第二块和最后一字节。
	// writeFile 后续发块前查取消，appendFile 发块期间不查但成功后再查；两者首请求期间都不把 signal 传给短文件操作，取消可能已有部分/全部写入，失败也不删除新文件。
	async #write(path: string, content: string | Uint8Array, append: boolean, context: Context) {
		// 字符串先变 UTF-8 Buffer，原 Uint8Array 则保引用；这一步在 #fileOp 之前，编码/读取 content 的异常不由该包装 catch。
		const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
		// 追加故意不用发块前的本地取消检查，仍有 #fileOp 的整体前置和成功后置检查。
		const signal = append ? undefined : context.abortSignal;
		// 共享包装负责解析、前置检查和映异常，具体分块由传入 async 回调完成。
		return this.#fileOp(
			// 第一参数保留调用者原路径，方便解析失败错误标识。
			path,
			// 把原 Context 交包装，不因 append 关闭局部 signal 就取消整体门禁。
			context,
			// 回调接收已解析路径，异步完成所有采用的写块及关闭。
			async (resolved) => {
				// subarray 返回首块视图，不复制原 bytes，后续改原数组内容可影响尚未序列化的块。
				const first = bytes.subarray(0, WRITE_CHUNK);
				// 仅总长度大于首块才要求 daemon 保句柄；空内容仍会发 write，以创建/截空或打开追加文件。
				const keep = bytes.length > WRITE_CHUNK;
				// 首请求会创建缺失父目录、按 append 选择打开模式并写首块；没有 signal，也没有在远端建父与写之间插客户端检查点。
				const reply = await this.connection.request("write", { path: resolved, append, keep }, { payload: first });
				// 一块足够时 daemon 不保句柄，本回调直接返回 undefined，writeFile 无统一后置取消。
				if (!keep) return;
				// 后续块用同一打开文件/session，避免重新打开导致截断或写到另一个同名文件。
				const handle = new Handle(this, reply.json.handle as number, reply.session, resolved);
				// 保留后续块 Promise，unknown 表示成功回复内容在这里不使用。
				const inFlight: Promise<unknown>[] = [];
				try {
					// 从第二块起按 512 KiB 偏移循环，末块由 subarray 自动裁到字节尾部。
					for (let offset = WRITE_CHUNK; offset < bytes.length; offset += WRITE_CHUNK) {
						// 仅 writeFile 的局部 signal 可命中，且只在发下一块前检查。
						if (signal?.aborted) {
							// A chunk that failed before this check fails the write, as it would have in sequence.
							// 取消时先等当前保留队列全部结算，再按数组顺序找首个拒绝；这里的首个不是按完成时刻排序。
							const failed = (await Promise.allSettled(inFlight)).find((result) => result.status === "rejected");
							// 已有块失败优先报告该错误，而不是把它盖成取消；未发生失败才用下一句 aborted。
							if (failed !== undefined) throw failed.reason;
							// 取消不是写入事务回滚，已经写出的块保持远端副作用。
							throw new FileError("aborted", "The operation was aborted", resolved);
						}
						// 发一个同句柄后续写请求，尚未 await 允许多个块在传输中重叠等待。
						const written = handle.request(
							// writeChunk 在 daemon 每句柄串行队列处理，客户端并行等待不等于文件偏移并发乱写。
							"writeChunk",
							// 业务 JSON 这里只需 Handle 自动加句柄号，所以显式空字典。
							{},
							// payload 是当前位置至最多一块的原字节视图，不带文本重新编码。
							{ payload: bytes.subarray(offset, offset + WRITE_CHUNK) },
						);
						// 空 catch 只防尚未 await 的拒绝失去处理，原 written Promise 仍保失败状态。
						written.catch(() => {});
						// 把该原 Promise 加到保留队列，稍后按发起顺序等待。
						inFlight.push(written);
						// 达到八个就 shift 等最早一个完成后再发更多；失败直接进入 finally，不继续主动发新块。
						if (inFlight.length >= WRITE_DEPTH) await inFlight.shift();
					}
					// The first failure; later chunks are refused by the daemon, so the file has no gaps.
					// 发送完成后依队列顺序等待剩余块，daemon 首失败会毒化句柄，后续块拒绝，防止跳过失败块后继续写出缺口；此前前缀不回滚。
					for (const written of inFlight) await written;
					// 成功/失败/取消都要等待已发剩余块并关闭句柄。
				} finally {
					// allSettled 不因某块拒绝就提前跳出，观察保留队列里所有终态。
					await Promise.allSettled(inFlight);
					// 最后尽力关同 session 句柄，失败吞掉，不以 close 失败覆盖既有写结果。
					await handle.close();
				}
			},
			// append 用 both，成功写完仍可返回 aborted；write 用 before，是否观察到中途取消依具体发块检查点。
			append ? "both" : "before",
		);
	}

	// 覆盖写文件，字符串按 UTF-8，字节原样；例：原文件 old 写 new 后内容为 new，缺父目录可创建。返回 Result，取消/失败可能保留部分内容，非原子替换。
	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		// false 选择非追加模式，实际打开/分块/关闭交 #write，不在此复制文件备份。
		return this.#write(path, content, false, context);
	}

	// 追加文件，缺文件/父目录时可创建；例：原 a 追加 b 得 ab。发送块时不查取消，整体成功后检查可返回 aborted，此时全部追加可能已发生，不自动回滚。
	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		// true 选择 append，复用同句柄分块避免每块重新打开；返回原 Promise。
		return this.#write(path, content, true, context);
	}

	// 截短或扩展已有文件到 size 字节，返回 void Result；例：10 字节文件 truncate(3) 丢后七字节，扩展部分由系统语义填充。
	// 解析/取消后验证非负安全整数再发远端 truncate，成功后再查取消；已完成变更不会因返回 aborted 撤销，错误映 FileError。
	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		// 共享包装按路径执行并返回 Result。
		return this.#fileOp(
			// 原路径用于解析和错误兜底。
			path,
			// 传上下文供前置及下面 both 的后置检查。
			context,
			// 异步回调只在路径和前置取消检查通过后执行。
			async (resolved) => {
				// size 类型 number 不保证有效文件长度，实际检查非负安全整数。
				if (!Number.isSafeInteger(size) || size < 0) {
					// 无效长度抛 FileError，被外层包装转成失败 Result。
					throw new FileError("invalid", "File size must be a non-negative safe integer", resolved);
				}
				// daemon 打开已有文件 r+ 再 set_len，不在此创建缺文件或补父目录。
				await this.connection.request("truncate", { path: resolved, size });
			},
			// 变更完成后再观察一次取消，不等于回滚。
			"both",
		);
	}

	// 请求 daemon 刷新已有文件数据/所需元数据到存储，返回 void Result；例：已写日志后 flushFile 作为文件同步步骤，不代表目录项/整个应用事务都已持久化。
	// 前后检查取消，远端 fsync 或连接错误映 FileError；远端实际打开/检查/关闭由 daemon 负责，不持有长期 Handle。
	flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		// 用共享文件包装处理路径、异常及检查点。
		return this.#fileOp(
			// 目标原路径，非已有 reader 句柄。
			path,
			// 同一 Context 参与检查点。
			context,
			// async 回调等待远端操作完成，不在客户端调用本机 fsync。
			async (resolved) => {
				// fsync 操作在 daemon 打开已有文件并执行 sync_all，不能据本地成功回调推测其他文件也已同步。
				await this.connection.request("fsync", { path: resolved });
			},
			// both 表示远端成功后仍可能因本地取消返回 aborted，不重做 fsync。
			"both",
		);
	}

	// 解析源/目标后执行远端重命名，返回 void Result；例：a→b 改名字，已打开 reader 仍持原对象。先解析两边，再以目标路径检查取消；远端成功后不再检查 signal，不复制内容或自动建父目录。失败保源路径兜底，不回滚已发生变更。
	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		// 源路径变量等待解析成功后赋值。
		let source: string;
		// 目标路径单独保存，不能把两个参数都按源路径解析结果处理。
		let destination: string;
		try {
			// 先解析源，可能触发 hello，但不读取源文件正文。
			source = await this.#resolve(sourcePath);
			// 再解析目标；这一步失败也归下面 catch。
			destination = await this.#resolve(destinationPath);
		} catch (error) {
			// 两个解析任一步失败都用原 sourcePath 作备用错误路径，未分别切成目标参数。
			return err(toFileError(error, sourcePath));
		}
		// 前置取消错误附解析后的目标路径，与下面 rename 操作失败的源路径兜底不同。
		const aborted = abortResult<void>(context.abortSignal, destination);
		// 已取消则不发送 rename，路径解析可能已发生。
		if (aborted) return aborted;
		try {
			// path 是源，to 是目标，daemon 执行实际重命名/覆盖平台语义。
			await this.connection.request("rename", { path: source, to: destination });
			// 成功直接返回，不做统一后置取消或目录同步。
			return ok(undefined);
		} catch (error) {
			// 操作失败按 source 转文件错误，远端错误自带路径可优先。
			return err(toFileError(error, source));
		}
	}

	// 对路径做远端 lstat 并返回 FileInfo Result，不跟随最终符号链接取得目标元数据；例：link 的 kind 可为 symlink。
	// 共享包装得到的成功值本身也是 toInfo 的 Result，最后去掉一层；前置取消/连接/转换错误映文件错误，没有统一后置取消。
	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		// T 被推断为 Result<FileInfo,FileError>，因此包装层 result 是外层 Result 套内层 Result。
		const result = await this.#fileOp(path, context, async (resolved) => {
			// lstat 根据解析路径查询，不是对某个打开句柄 fstat。
			const { json } = await this.connection.request("lstat", { path: resolved });
			// 双重断言不做协议字段校验，远端路径函数用于 name；other 由 toInfo 变成内层失败。
			return toInfo(resolved, json as unknown as RemoteFileInfo, await remotePath(this.connection));
		});
		// 外层成功取内层 Result，外层失败直接返回，避免向 API 暴露嵌套包装。
		return result.ok ? result.value : result;
	}

	// 一次收集整个目录并返回 FileInfo[]，解析/前置取消后 opendir→分页收全→关闭→按平台排序/转换；失败返回整次 FileError。
	// 例：POSIX 按名字原始字节排序，Windows 保 daemon 文件系统次序；other 跳过，但任何逐项 lstat 错误包括 ENOENT 都失败，和 DirReader 的跳过规则不同。
	// 收页循环本身不查取消、不传 signal，直到转换每项才查；空目录或最后检查后的取消未必观察到，也不提供目录一致快照。
	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		// 默认 before 包装，没有统一后置取消，具体转换循环自行检查。
		return this.#fileOp(path, context, async (resolved) => {
			// 打开远端目录句柄，后续请求绑定同一 session。
			const { handle } = await this.#openDir(resolved);
			// 先存全量协议目录项，排序前尚未转换 FileInfo。
			const entries: RemoteDirEntry[] = [];
			try {
				// for 初始 done=false，更新在循环体内；不使用第三段自增表达式。
				for (let done = false; !done; ) {
					// 每页最多请求 1000 个协议项，和 RemoteDirReader 按可用项补页不同。
					const { json } = await handle.request("readdir", { max: 1000 });
					// 断言 entries 形状后逐项展开追加，未运行完整数组验证。
					entries.push(...(json.entries as RemoteDirEntry[]));
					// 只精确 true 代表目录遍历完毕；最后页可能带数据。
					done = json.done === true;
				}
				// 收集成功或失败都先释放目录句柄，再继续转换或传播错误。
			} finally {
				// 等待尽力关闭，错误吞掉，不把关闭失败盖住原读取错误。
				await handle.close();
			}
			// Node's `readdir` fails on any entry it cannot lstat. libuv sorts names by their bytes on POSIX; on Windows it
			// keeps the file system's order, which the daemon reports.
			// 获取远端平台路径集合，作为排序/路径拼接依据。
			const paths = await remotePath(this.connection);
			// 只有同一个 posix 函数对象时走字节排序，Windows 不进入。
			if (paths === posix) {
				// 局部 key 回调返回排序字节：优先 raw 原始名字字节，否则 UTF-8 编码已解码名字；新 Buffer 用于比较，不读文件。
				const key = (entry: RemoteDirEntry) => Buffer.from(entry.raw ?? Buffer.from(entry.name, "utf8"));
				// sort 就地改本地 entries 数组，Buffer.compare 按字节词典序，非语言/大小写自然排序。
				entries.sort((a, b) => Buffer.compare(key(a), key(b)));
			}
			// 转换出的公开信息另存新数组。
			const infos: FileInfo[] = [];
			// 按已选平台顺序转换每条协议项。
			for (const entry of entries) {
				// 此时才逐项观察取消；远端枚举可能已经完整执行并关闭。
				if (context.abortSignal?.aborted) throw new FileError("aborted", "aborted", resolved);
				// 按远端路径规则生成每项完整路径。
				const entryPath = paths.resolve(resolved, entry.name);
				// 任意 error 字段都使 listDir 失败，不像分页 reader 特别跳过 ENOENT。
				if (entry.error !== undefined) throw toFileError(new RemoteError(entry.error), entryPath);
				// info! 只声明协议应有元数据，other 转换失败不抛，因此下面会跳过。
				const info = toInfo(entryPath, entry.info!, paths);
				// 仅支持的文件/目录/符号链接信息进入公开列表。
				if (info.ok) infos.push(info.value);
			}
			// 返回回调成功值，#fileOp 外层再包 ok。
			return infos;
		});
	}

	/** Through the daemon; `not_supported` with a daemon released before `listFiles`. */
	// 递归列举远端目录树，返回相对路径条目与 truncated；例：listFiles("src",{maxEntries:2},ctx) 先解析 src，再由共享函数限制数量。
	// 这里仅解析路径，预算/取消/能力检查和 payload 解码由 listFilesOver 负责；旧 daemon 返回 not_supported，本方法不自己回退遍历，解析失败先映文件错误。
	async listFiles(
		// 输入可相对环境 cwd，协议要求发送的根目录随后已解析。
		path: string,
		// 过滤和数量/字节/时间预算原样交共享函数，undefined 由 daemon 默认。
		options: ListFilesOptions | undefined,
		// Context 供共享枚举发取消通知并检查结果，不在这里独立设 timer。
		context: Context,
		// 成功值不是目录句柄，不能用 next 翻页。
	): Promise<Result<FileListing, FileError>> {
		// 声明解析后根路径，未成功不调用共享枚举。
		let resolved: string;
		try {
			// 路径解析先于 listFilesOver 的参数预算/取消验证，故异常优先级需要按实际调用顺序理解。
			resolved = await this.#resolve(path);
		} catch (error) {
			// 解析/连接错误用原 path 作兜底路径。
			return err(toFileError(error, path));
		}
		// 返回共享函数的 Promise/Result，那里检查 hello.features 决定是否能列举。
		return listFilesOver(this.connection, resolved, options, context);
	}

	// 对已解析路径发送 opendir，返回绑定 session 的 Handle，失败直接拒绝；例：后续 readdir 都用它，调用者负责 close，本 helper 不包 Result 或读取第一页。
	async #openDir(resolved: string): Promise<{ handle: Handle }> {
		// 请求打开目录，实际目录类型/权限由 daemon 检查。
		const reply = await this.connection.request("opendir", { path: resolved });
		// handle as number 不是运行校验，保存回复 session 防重启后误用同号句柄。
		return { handle: new Handle(this, reply.json.handle as number, reply.session, resolved) };
	}

	// 打开目录分页器并返回 Result，成功后调用者负责 close；例：reader.next(10) 保持目录次序，跳过消失项目继续补页。
	// 路径/前置取消包装后打开，开后再观察取消；命中先关闭新句柄返回 aborted，不把资源留给失败调用者。
	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		// 内联 async 回调只开目录取 Handle，共享包装统一解析/映异常。
		const opened = await this.#fileOp(path, context, async (resolved) => (await this.#openDir(resolved)).handle);
		// 打开失败不读取 value，直接返回。
		if (!opened.ok) return opened;
		// 打开成功后再用已解析句柄路径检查取消。
		const aborted = abortResult<DirReader>(context.abortSignal, opened.value.path);
		// 取消命中先释放已打开资源。
		if (aborted) {
			// 尽力关闭目录句柄，失败吞掉。
			await opened.value.close();
			// 返回原取消结果，不返回一个已关闭 reader。
			return aborted;
		}
		// 成功创建有自己 done/closed 状态的 RemoteDirReader。
		return ok(new RemoteDirReader(opened.value));
	}

	// 请求远端 realpath 返回规范真实路径 Result，可跟随符号链接；例：/work/link 可变成 /data/target，区别于只消除 . 和 .. 的 absolutePath。
	// 共享包装只前置查取消，远端错误映 FileError，不保证路径在调用后仍指同一对象，也不是把目录限制为沙箱。
	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		// 解析用户路径并统一前置取消/异常处理。
		return this.#fileOp(path, context, async (resolved) => {
			// realpath 由远端文件系统执行，客户端不访问本机同名路径。
			const { json } = await this.connection.request("realpath", { path: resolved });
			// JSON path 断言 string，不额外验证字段/重新拼接 cwd。
			return json.path as string;
		});
	}

	// 通过 fileInfo 判断是否存在，返回 boolean Result；例：ENOENT→ok(false)，权限错误仍失败，不误当不存在。使用 lstat，因此悬空符号链接自身通常存在，且判断不保证后续操作时仍存在。
	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		// 复用全部路径解析/取消/错误语义，不额外发 exists 协议操作。
		const result = await this.fileInfo(path, context);
		// 任何支持的 FileInfo 都算存在，不只普通文件。
		if (result.ok) return ok(true);
		// 只有 not_found 映 false，其他失败都不能据此断言不存在。
		if (result.error.code === "not_found") return ok(false);
		// 将其余同一 FileError 重新包失败，不删除 cause/path。
		return err(result.error);
	}

	// 在远端创建目录，返回 void Result；默认递归补父目录，例：a/b 不存在时创建两级，recursive=false 则交系统只创建目标。
	// 共享包装仅前置查取消，实际存在目录/同名文件/权限规则在 daemon，成功不另后置检查，不做回滚。
	createDir(
		// 目录路径先按环境 cwd/平台规则解析。
		path: string,
		// options 可缺，recursive 缺省 true，和 remove 默认 false 不同。
		options: { recursive?: boolean } | undefined,
		// 上下文用于包装的前置取消。
		context: Context,
		// 成功值 void 不包含创建了哪些父目录的清单。
	): Promise<Result<void, FileError>> {
		// 回调只在解析/前置检查通过后执行。
		return this.#fileOp(path, context, async (resolved) => {
			// ?? 保留显式 false，只对 null/undefined 回默认 true；daemon 执行 mkdir。
			await this.connection.request("mkdir", { path: resolved, recursive: options?.recursive ?? true });
		});
	}

	// 删除远端路径，返回 void Result，默认非递归且不 force；例：缺路径默认失败，force=true 才允许缺失成功，目录通常需 recursive=true。
	// 共享包装仅前置检查，真实删除无回收站/事务恢复，本客户端不在取消时撤销删除，系统/协议错误映 FileError。
	remove(
		// 目标路径交共享包装，不把输入当本机路径。
		path: string,
		// 两个选项独立可缺省，force 不等于 recursive。
		options: { recursive?: boolean; force?: boolean } | undefined,
		// Context 只在既定检查点读取，rm 请求未传 signal。
		context: Context,
		// 成功 void 表示协议报告完成，不附被删除的条目副本。
	): Promise<Result<void, FileError>> {
		// 按解析后的完整路径构造远端操作。
		return this.#fileOp(path, context, async (resolved) => {
			// 固定 op=rm，不经 shell 拼接命令。
			await this.connection.request("rm", {
				// path 是 JSON 字符串，不是 shell 引号表达式。
				path: resolved,
				// 默认不递归，显式 false 不被 ?? 改成 true。
				recursive: options?.recursive ?? false,
				// 默认不忽略缺失路径，force=true 的细节由 daemon 实现。
				force: options?.force ?? false,
			});
		});
	}

	// 以远端临时目录为拼接基底，用前缀创建唯一目录，返回路径 Result；例：缺省 tmp- 得 tmp-加随机后缀，不在本机创建目录。
	// 入口查取消后取 hello/路径规则再 mkdtemp，没有后置取消；前缀通过 join 不做名字净化，.. 可影响位置，失败不自动清任何先前副作用。
	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		// 入口即查取消，没有 path 可附，这次与多数先解析路径的方法顺序不同。
		const aborted = abortResult<string>(context.abortSignal);
		// 已取消不连接或创建目录。
		if (aborted) return aborted;
		try {
			// 使用 daemon 报告的 tmpdir，不用客户端 os.tmpdir。
			const { tmpdir } = await this.connection.info();
			// 再次取得远端路径规则，Connection.info 通常复用 hello 结果，不意味每次新建 daemon。
			const paths = await remotePath(this.connection);
			// prefix 只有空值才用 tmp-，显式空串保留；join 后交 mkdtemp，前缀不是限定的单个安全文件名。
			const { json } = await this.connection.request("mkdtemp", { path: paths.join(tmpdir, prefix ?? "tmp-") });
			// 路径字段 as string 不自动验证回复；成功后不再查 signal。
			return ok(json.path as string);
		} catch (error) {
			// 错误映 FileError，不以本机临时目录伪装成功。
			return err(toFileError(error));
		}
	}

	// 先建远端 tmp- 目录，再用可选前缀+UUID+后缀创建空文件，返回路径 Result；例：prefix="log-"、suffix=".txt" 形成随机文件名，不保证任意前缀都只是名字。
	// 没有在建目录后再次检查取消，write 请求禁自动建父；失败不删除刚建目录，cleanup 也不清这些临时文件，调用者负责生命周期。
	async createTempFile(
		// 选项只控制文件路径末段的文字，未限制斜杠、.. 等路径字符。
		options: { prefix?: string; suffix?: string } | undefined,
		// Context 供 createTempDir 入口查取消，后面文件 write 不传 signal。
		context: Context,
		// 返回文件路径，不返回打开句柄或自动删除清理函数。
	): Promise<Result<string, FileError>> {
		// 每次创建新临时目录，不在全局共享一个 temp 子目录。
		const dir = await this.createTempDir("tmp-", context);
		// 建目录失败直接返回，未开始生成文件路径。
		if (!dir.ok) return dir;
		// filePath 初始空串用于后续错误路径兜底，计算前失败时也可能保这个空值。
		let filePath = "";
		try {
			// 路径函数按远端平台选，获取信息失败进 catch。
			const paths = await remotePath(this.connection);
			// 随机 UUID 在客户端生成，prefix/suffix 空值补空串，join 仍按路径规则处理字符串中的分隔符，不检查路径最终是否还在新目录内。
			filePath = paths.join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
			// Node's `writeFile(filePath, "")`, which does not create parents.
			// 直接调用连接 write，而不是会自动补父和查取消的 this.writeFile。
			await this.connection.request(
				// 固定操作名 write，正文通过独立 payload 传空字节。
				"write",
				// append=false 创建/截空目标，parents=false 禁补额外父目录；没有 keep，所以不保长期句柄。
				{ path: filePath, append: false, parents: false },
				// 长度 0 的 Uint8Array 是空文件内容，不是字段省略。
				{ payload: new Uint8Array(0) },
			);
			// 协议成功即返路径，不额外 stat 或后置取消。
			return ok(filePath);
		} catch (error) {
			// 失败按已计算 filePath 映 FileError；已创建目录/可能的文件不自动删除。
			return err(toFileError(error, filePath));
		}
	}

	// 为多个远端路径建立 watcher，返回 FileWatcher Result；先前置查取消，并发解析目标，再等 RemoteWatcher.open 的 ready 覆盖确认，开后取消则 stop。
	// 例：先 watch 配置路径再加载可减少加载期间漏变更；实际模式/快照/事件来自 daemon，掉线重连由 watcher 报 overflow。
	// 调用方负责 stop，环境 cleanup 不停止 watcher；解析/建立失败映 FileError，回调同步异常由 RemoteWatcher 处理，异步返回值不自动等待。
	async watch(
		// readonly 限制 TS 通过此数组类型改列表，不深冻结每个目标对象。
		targets: readonly WatchTarget[],
		// onChange 接收 paths/overflow/failed 联合；此层不复制整个变更事件或执行调用者的重扫逻辑。
		onChange: (change: FileChange) => void,
		// Context 在开前、解析后、建立后三个检查点读取。
		context: Context,
		// 成功值是长期 watcher，不表示长 watch 请求已结束。
	): Promise<Result<FileWatcher, FileError>> {
		// 入口取消先于任何路径解析/连接。
		const aborted = abortResult<FileWatcher>(context.abortSignal);
		// 已取消返回失败，不开始覆盖建立。
		if (aborted) return aborted;
		try {
			// Promise.all 并发解析各目标，返回顺序仍与输入数组一致，任一个拒绝使这次 await 失败。
			const resolved = await Promise.all(
				// 箭头回调浅复制 target 后覆盖 path，exclude 等嵌套引用仍共享，路径解析不修改原目标。
				targets.map(async (target) => ({ ...target, path: await this.#resolve(target.path) })),
			);
			// 所有路径解析完成后再查取消，不因并发解析就自动取消剩余解析 Promise。
			const afterResolve = abortResult<FileWatcher>(context.abortSignal);
			// 解析后取消则不发送 watch，但连接握手可能已经发生。
			if (afterResolve) return afterResolve;
			// RemoteWatcher.open 等收到 ready 才返回，不等长 watch 终态；使用本环境默认监控选项。
			const watcher = await RemoteWatcher.open(this.connection, resolved, onChange, this.#watchOptions);
			// 建立覆盖后再观察上下文，防把取消调用产生的 watcher 直接泄漏。
			const afterOpen = abortResult<FileWatcher>(context.abortSignal);
			// 此时资源已经创建，需要停止后再返回失败。
			if (afterOpen) {
				// stop 发取消并等其当前请求结算，忽略传入 context 的 deadline/取消；可能因连接不回终态而等待，不是立即丢引用。
				await watcher.stop(context);
				// 返回建立后的取消结果，不把已停止 watcher 交出去。
				return afterOpen;
			}
			// 成功时把 stop 责任交调用者，后续取消 Context 不会在本方法外自动永久绑定到 watcher。
			return ok(watcher);
		} catch (error) {
			// 解析/建立/停止中的异常映文件错误，不重试这一整个 watch 调用。
			return err(toFileError(error));
		}
	}

	// 在远端运行 shell 字符串或 argv 程序，返回退出码/可选完整输出日志路径 Result，输出通过回调流式交付，不返回 stdout 全文。
	// 流程：入口取消/timeout校验→确定 cwd/环境→登记取消/请求 id→接已解码输出→终态映码→finally 清本地登记；例：argv [echo,a b] 不经 shell 分词，字符串命令才由 daemon 选 shell。
	// 非零退出码仍可 ok；回调同步失败优先 callback_error 并通知取消，实际超时、杀进程、原始输出日志与窗口裁剪在 daemon，本层不实现精确时间截止或副作用回滚。部分构造/回调异常仍可能逸出，不能把静态 Result 签名理解成永不拒绝。
	async exec(
		// string 分支交 shell，readonly string[] 则复制 argv 发送，空数组未在本客户端单独验证，真实 daemon 会报告失败。
		command: string | readonly string[],
		// 可选 cwd/env/timeout/输出/日志/窗口参数，不设置时使用后面的默认规则。
		options: ShellExecOptions | undefined,
		// 同一 Context 既提供取消，也原样传给 onOutput，不发送到远端 JSON。
		context: Context,
		// 成功返回 ShellExecResult，失败返回命令层 ExecutionError，不和 FileError 混用。
	): Promise<Result<ShellExecResult, ExecutionError>> {
		// 保存原取消 signal 引用，之后监听它并转发给私有控制器。
		const signal = context.abortSignal;
		// 入口已取消最优先，尚不验证 timeout 或发请求。
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		// timeout 单位为秒，undefined 表示不设命令超时，不是用启动连接的 60 秒替代。
		const timeout = options?.timeout;
		// 只要显式提供就验证，0 不当作未设置。
		if (timeout !== undefined) {
			// 必须有限且 >0，小数秒允许，NaN/Infinity/负数等拒绝。
			if (!Number.isFinite(timeout) || timeout <= 0) {
				// 非法 timeout 返回 timeout 类错误，不伪装为已执行后超时。
				return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
			}
			// 换成毫秒后不能超过 Node 定时器上界。
			if (timeout * 1000 > MAX_TIMEOUT_MS) {
				// 错误文案按秒列出最大值，本层未启动计时器或程序。
				return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
			}
		}
		// inheritEnv 缺省 true，显式 false 保留；继承的是远端 daemon 环境，不复制本机 process.env。
		const inheritEnv = options?.inheritEnv ?? true;
		// 声明将要采用的命令工作目录。
		let cwd: string;
		try {
			// options.cwd 真值才解析，空串会回退 this.cwd；默认 this.cwd 原样发送，不自动再规范化或验证存在。
			cwd = options?.cwd ? await this.#resolve(options.cwd) : this.cwd;
		} catch (error) {
			// 路径/连接失败映命令 unknown 错误，不走文件码表；未知抛值 String 转换本身仍可能抛。
			return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
		}
		// 可能 await 路径解析后再查取消，未开始构造/发送 exec。
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		// 构造普通对象字典，不是 null 原型 Map；特殊键仍服从 JS 普通对象属性语义。
		const env: Record<string, string> = {};
		// Object.entries 取得合并对象自有可枚举字符串键值，for...of 解构每对 key/value。
		for (const [key, value] of Object.entries(
			// 继承时先默认 #shellEnv 后单次 options.env，单次覆盖；不继承时只带单次 env，daemon 再决定是否加自身环境。
			inheritEnv ? { ...this.#shellEnv, ...options?.env } : { ...options?.env },
		)) {
			// 跳过 undefined 值，键 toWellFormed 修孤立代理；值原样交 JSON，修字符串值在 Connection 序列化阶段。普通 env 对象的 __proto__ setter 不等同于安全保存任意自有键。
			if (value !== undefined) env[key.toWellFormed()] = value;
		}
		// 记录首次输出回调失败，后续终态优先返回它，避免远端 aborted 覆盖真正回调原因。
		let callbackError: ExecutionError | undefined;
		// 本地结算门禁，finally 才设 true，屏蔽晚到输出；不是进程当前是否已经退出的探测。
		let settled = false;
		// 保存 onStart 分配的请求 id，尚未发起时为 undefined。
		let running: number | undefined;
		// 私有 AbortController 合并用户取消与输出回调失败产生的取消，不让内部错误去调用用户原 controller。
		const controller = new AbortController();
		// 局部无参闭包只 abort 私有控制器，Connection 监听它后发 cancel；不在此直接杀本机 pid。
		const onAbort = () => controller.abort();
		// 给原 signal 安装一次性监听，finally 再移除；已经触发过的 abort 不会靠 addEventListener 重新派发。
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			// 发长执行请求并等最终 RESULT/ERROR，途中通过 onEvent 收输出。
			const { json } = await this.connection.request(
				// 固定 op=exec，不是 process 或 pty 原始字节通道。
				"exec",
				// 这一对象是发到 daemon 的业务字段，不含本地 Context/函数。
				{
					// typeof 在合法联合中选择字符串命令或复制 argv；复制数组不做 shell 引号/转义，参数保持独立字符串。
					...(typeof command === "string" ? { command } : { argv: [...command] }),
					// 发送确定的 cwd，目录存在性由 daemon 启动程序时检查。
					cwd,
					// 发送合并后的额外环境字典，未自动携带本机环境。
					env,
					// 标志告诉 daemon 是否在它自己的环境基础上叠加这些字段。
					inheritEnv,
					// 默认 shellPath 有定义才加字段，显式空串仍被发送；真实 shell 处理在 daemon，不在客户端预查路径。
					...(this.#shellPath === undefined ? {} : { shellPath: this.#shellPath }),
					// timeout 秒转毫秒发给 daemon，未提供则省字段，无本地命令 timer。
					...(timeout === undefined ? {} : { timeoutMs: timeout * 1000 }),
					// 只有定义 spill 才发，原阈值对象未在本函数完整验证；daemon 计原始字节/行阈值并写远端日志。
					...(options?.spill === undefined ? {} : { spill: options.spill }),
					// window 定义才发，daemon 可合并/省略已在保留尾部之外的解码输出并报告 skipped；不是此客户端再截文本。
					...(options?.window === undefined ? {} : { window: options.window }),
				},
				// 下一对象是 Connection 的本地请求选项，不会作为 JSON 发给 daemon。
				{
					// 私有 signal 用于原用户取消和回调失败后的 cancel 通知，Connection 仍等终态后才结算。
					signal: controller.signal,
					// 开始回调接本地请求编号及 daemon session，发生在写 REQUEST 帧之前，不是远端程序已启动的确认。
					onStart: (requestId, session) => {
						// 保 requestId 供 finally 删除登记，不能拿它当远端操作系统 pid。
						running = requestId;
						// 登记本环境命令，cleanup 只根据这些 id/session 发送 kill 模式取消。
						this.#running.set(requestId, session);
					},
					// 输出事件回调同步执行在 Connection 分发路径，未知业务字段仍按协议解释，不作完整事件 schema 验证。
					onEvent: (event, payload) => {
						// 本地已结算、已有回调错误、或非 output 事件都忽略；未知 kind 不当普通文字。
						if (settled || callbackError !== undefined || event.kind !== "output") return;
						// payload 按原 buffer/偏移/长度建立 Buffer 视图再转 UTF-8，daemon 已按流完成解码并以完整 UTF-8 文本帧发送；本客户端不是再用跨事件 StringDecoder 解原管道碎片。
						const text = Buffer.from(payload.buffer, payload.byteOffset, payload.length).toString("utf8");
						// 空文本或未设置输出回调就忽略，单有 skipped 而无文字也不会交付此回调。
						if (text === "" || options?.onOutput === undefined) return;
						// 只有精确 stderr 选 stderr，其他 stream 字段都回退 stdout；这不是严格枚举验证。
						const info: ShellOutputInfo = { stream: event.stream === "stderr" ? "stderr" : "stdout" };
						// skipped 有定义就断言其结构原样引用，未验证字段数值；单位为已解码文本的 UTF-8 字节/LF，不是原始管道字节。
						if (event.skipped !== undefined) info.skipped = event.skipped as ShellOutputSkip;
						try {
							// 同步调用用户输出函数，原 context 和新 info 原样传入，不 await 返回 Promise；异步拒绝不由这个 try/catch 捕获。
							options.onOutput(text, context, info);
						} catch (error) {
							// Error 原对象作为 cause，其余抛值 String 转换再建 Error；转换本身若再抛会逸出此事件回调。
							const cause = error instanceof Error ? error : new Error(String(error));
							// 把普通同步回调失败记为 callback_error，保存 cause/message，不当模型或进程输出成功。
							callbackError = new ExecutionError("callback_error", cause.message, cause);
							// 发私有 abort 促使 Connection 通知 daemon 停该命令，但此行不立刻结算 exec Promise。
							controller.abort();
						}
					},
				},
			);
			// 即使远端成功终态，先前回调错误仍优先返回。
			if (callbackError) return err(callbackError);
			// 无回调错误时按 daemon JSON 构造成功值，不因 exitCode 非 0 自动变失败。
			return ok({
				// as number 只是类型断言，没有实际验证退出码字段是数字或整数。
				exitCode: json.exitCode as number,
				// spillPath 只有运行时为 string 才加入，包括空串；路径位于远端命名空间，不是本机可直接读的日志。
				...(typeof json.spillPath === "string" ? { spillPath: json.spillPath } : {}),
			});
		} catch (error) {
			// 请求拒绝时同样先保回调失败，不让随后的 aborted/timeout 覆盖它。
			if (callbackError) return err(callbackError);
			// 非本模块 RemoteError 不按 daemon 业务码分类，跨 realm 外形相同也可能走 unknown。
			if (!(error instanceof RemoteError)) {
				// 普通 Error 取 message，其余 String 化；没有自动附远端 spillPath 或当作 not_found。
				return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
			}
			// 按明确远端 code 映 ExecutionError，各分支保持命令层分类。
			const failure =
				// timeout 优先匹配为专门超时错误。
				error.code === "timeout"
					? // 错误文案用本次 timeout 秒值，若非本客户端超时设置导致远端 timeout，值也可能 undefined，不凭文案重新计时。
						new ExecutionError("timeout", `timeout:${timeout}`)
					: // aborted 表示远端按取消结束，不根据原本地 signal 再猜原因。
						error.code === "aborted"
						? // 创建固定 aborted 类错误。
							new ExecutionError("aborted", "aborted")
						: // shell_unavailable 和 spawn_error 保留各自码及远端 message。
							error.code === "shell_unavailable" || error.code === "spawn_error"
							? // 这两类表示选 shell 或启动程序失败，不是普通非零退出码。
								new ExecutionError(error.code, error.message)
							: // 其余远端码（含连接丢失 unknown、日志失败等）统一命令 unknown，不自动重试执行。
								new ExecutionError("unknown", error.message);
			// 远端错误携带字符串 spillPath 时附到失败对象，日志仍可能保留；非字符串字段忽略。
			if (typeof error.fields.spillPath === "string") failure.spillPath = error.fields.spillPath;
			// 返回映射后的失败 Result，不回滚已发生命令副作用。
			return err(failure);
			// 请求成功/失败/提前返回回调错误都进 finally 清本地状态。
		} finally {
			// 先设结算门禁，使之后输出事件不再进入用户回调。
			settled = true;
			// 移除原 signal 上本次监听，不改变 signal 本身或影响其他命令监听。
			signal?.removeEventListener("abort", onAbort);
			// 已登记请求才从本环境运行表删除，重复删除不会影响其他 request id。
			if (running !== undefined) this.#running.delete(running);
		}
	}

	// 通知本环境登记的命令全部用 kill 模式终止，清运行表并返回，不关闭共享连接/文件 reader/watcher，不删除临时日志。
	// 例：宿主关机时 await cleanup(ctx) 后已发送通知，但仍未等待远端命令/子孙真正退出；kill 不按用户 abort 结算，命令通常以被杀退出码结束，平台实际范围依 daemon。忽略 _context 取消。
	async cleanup(_context: Context): Promise<void> {
		// Kill without aborting, so the commands settle with their killed status, as `NodeExecutionEnv` does.
		// 逐对读取 request id/session 调 connection.kill，连接不匹配/已失联可静默无操作；这是发送通知而非逐个 await exec 终态。
		for (const [id, session] of this.#running) this.connection.kill(id, session);
		// 清登记表，不等同远端确认停止；各 exec 的 finally 后续删除已无此 id 也无害。
		this.#running.clear();
	}
}

// 只重新导出 RemoteInfo 类型，编译后擦除，不额外发 hello 或包装运行时数据。
export type { RemoteInfo };
