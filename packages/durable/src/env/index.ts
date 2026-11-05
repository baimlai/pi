// 文件导读
// 所属：packages/durable/src/env 的契约层，定义 Durable 的“执行环境”接口：文件系统 + shell。
// 解决的问题：工具（read/write/edit/bash）、宿主存储和自定义任务需要一套可移植的执行抽象；本地 Node、远端主机
// 或容器各有实现，但调用者只看到 Result 返回值和统一错误码，不需要捕获平台异常。
// 职责边界：这里只声明类型和构造 Result 的小工具，不实现任何 I/O；具体行为由 NodeExecutionEnv（env/node.ts）、
// pi-env 的 RemoteExecutionEnv/LocalExecutionEnv 等提供，并由 testing/env-conformance.ts 的套件校验。
// 上下游：上游是 packages/durable/src/types.ts 的 HarnessOptions.env 与 TaskRuntime.env(context)，以及 tools/*、storage/*、
// codemode；下游是各平台的 ExecutionEnv 实现。平台错误在这个边界被归一化为 FileError/ExecutionError。
// 能力清单（按导出项）：
// - Result/ok/err/getOrThrow/getOrUndefined/toError：把预期失败作为值返回，避免用异常控制流程。
// - FileKind/FileInfo/FileErrorCode/FileError：文件元数据与跨平台文件错误。
// - ExecutionErrorCode/ExecutionError：命令执行错误（含超时、spawn、回调抛错、spill 路径）。
// - TextLine/TextLineReader：逐行读取，并保留“最后一行是否以换行结束”。
// - BinaryReader/LineScan：已打开文件的定位读取与一次扫描得到的行范围。
// - DirReader：目录分页读取。
// - WatchTarget/FileChange/FileWatcher：文件监视契约（native/polling、paths/overflow/failed）。
// - ListFilesOptions/FileListEntry/FileListing：可选的递归列目录能力。
// - FileSystem：文件系统能力集合；ShellSpillOptions/ShellExecResult/ShellExecOptions/ShellOutputWindow/
//   ShellOutputSkip/ShellOutputInfo/Shell：进程执行能力集合。
// - ExecutionEnv：FileSystem & Shell，工具实际拿到的环境。
// - 转导出 rangeDecoder/StreamDecoder/startsWithBom/LineScanner：供 read 工具和测试使用的解码/行扫描实现。
// 组合顺序：宿主构造一个 ExecutionEnv → 工具调用 readTextFile/openBinaryReader/scanLines 或 exec →
// 结果以 Result 返回；实现不抛平台异常，getOrThrow 是调用方主动选择的抛出入口。
// 示例（真实签名）：
//   async function readVersion(env: ExecutionEnv, context: Context): Promise<string> {
//     return getOrThrow(await env.readTextFile("package.json", context)); // 失败时抛出 FileError
//   }
//   const run = await env.exec(["git", "status", "--porcelain"], { timeout: 10 }, context);
//   if (run.ok) console.log(run.value.exitCode); // 非零退出码仍是 ok，只有执行失败才是 err
// 建议阅读顺序：先看 Result 与两个错误类型，再看 FileSystem 的方法分组，然后看 Shell 与输出窗口；
// 最后看 WatchTarget/FileChange/FileWatcher 和底部的转导出。
import type { Context } from "@earendil-works/chord/context";

/** Result of a fallible operation. Expected failures are returned instead of thrown. */
/** 可预期失败的结果：成功是 { ok: true, value }，失败是 { ok: false, error }。
 * 判别字段 ok 让 TypeScript 在 if/switch 中收窄类型；这是编译期联合，运行时没有额外标记或校验。
 * 例：type R = Result<number, FileError>; const r: R = ok(1);
 */
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

/** 构造成功结果；TError 不会出现在成功分支里，通常由赋值的 Result 类型或返回类型推断。
 * 例：const r: Result<string, FileError> = ok("text");
 */
export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
	return { ok: true, value };
}

/** 构造失败结果；error 原样保存，不会被包装或转字符串。
 * 例：const r: Result<string, FileError> = err(new FileError("not_found", "missing"));
 */
export function err<TValue, TError>(error: TError): Result<TValue, TError> {
	return { ok: false, error };
}

/** 成功时返回值，失败时抛出保存的错误；不复制、不包装错误对象。
 * 例：const text = getOrThrow(await env.readTextFile("a.txt", context)); // 失败时抛 FileError
 */
export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

/** 成功时返回值，失败时返回 undefined，用于“读取失败等同于缺省”的可选路径。
 * TValue extends object 让 undefined 不会与成功值混淆；这是类型约束，运行时并不检查 value 是不是对象。
 * 例：const info = getOrUndefined(await env.fileInfo("optional.txt", context));
 */
export function getOrUndefined<TValue extends object, TError>(result: Result<TValue, TError>): TValue | undefined {
	return result.ok ? result.value : undefined;
}

/** 把 unknown 转成 Error：Error 原样返回，字符串包一层 Error，其他值尝试 JSON 序列化。
 * JSON.stringify 可能因循环引用或 BigInt 抛错，此时回退到 String(error)；不会丢失原始值。
 * 例：toError("boom").message === "boom"。
 */
export function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	try {
		return new Error(JSON.stringify(error));
	} catch {
		return new Error(String(error));
	}
}

/** 文件系统条目类型：普通文件、目录、符号链接；FIFO、设备等其他类型不满足这个接口。
 * 这是编译期联合，运行时由各实现根据 stat/lstat 结果归类。
 */
export type FileKind = "file" | "directory" | "symlink";

/** 跨平台文件错误码；aborted 来自取消，unknown 是无法映射的底层错误。
 * node.ts 的 toFileError 把 ENOENT/EACCES/ENOTDIR/EISDIR/EINVAL 等 errno 映射到这些值。
 */
export type FileErrorCode =
	| "aborted"
	| "not_found"
	| "permission_denied"
	| "not_directory"
	| "is_directory"
	| "invalid"
	| "not_supported"
	| "unknown";

/** 文件操作的可预期错误；通常作为 Result.error 返回，而不是抛出。
 * code/path 是业务字段，cause 保留底层 Error；name 固定为 "FileError" 便于日志识别。
 */
export class FileError extends Error {
	public code: FileErrorCode;
	public path?: string;

	/** 构造文件错误；message 面向调用者，path 是相关路径，cause 可选地保留底层错误。
	 * 例：new FileError("not_found", "ENOENT: no such file", "/tmp/x");
	 */
	constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "FileError";
		this.code = code;
		this.path = path;
	}
}

/** 命令执行错误码：aborted/timeout 对应取消与超时，shell_unavailable/spawn_error 对应启动失败，
 * callback_error 是 onOutput 回调抛错，unknown 是其他无法归类的错误。
 */
export type ExecutionErrorCode =
	| "aborted"
	| "timeout"
	| "shell_unavailable"
	| "spawn_error"
	| "callback_error"
	| "unknown";

/** 命令执行失败；spillPath 在超时或取消前已触发 spill 时指向完整原始输出文件。
 * message 可能包含命令和平台细节，调用方不应依赖其精确文本。
 */
export class ExecutionError extends Error {
	public code: ExecutionErrorCode;
	/** Spill file of a command that timed out or was aborted after its output crossed the spill thresholds. */
	public spillPath?: string;

	/** 构造执行错误；code 是稳定的业务分类，message 用于展示，cause 可选。
	 * 例：new ExecutionError("timeout", "timeout:0.3");
	 */
	constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ExecutionError";
		this.code = code;
	}
}

/** 文件或目录的元数据；name 是 basename，path 是查询/打开时使用的路径，size/mtimeMs 来自 stat。
 * Node 实现对目录也返回 size/mtimeMs；监视快照对目录只比较身份，不比较这两个字段。
 */
export interface FileInfo {
	name: string;
	path: string;
	kind: FileKind;
	size: number;
	mtimeMs: number;
}

/** 一行文本；text 不含结尾 LF，terminated 表示该行是否真的以 LF 结束（最后一行可能没有）。
 * CRLF 中的 CR 保留在 text 里，读取层不做换行风格转换。
 */
export interface TextLine {
	text: string;
	terminated: boolean;
}

/** 逐行读取器；readLine 返回 undefined 表示文件结束，close 后继续读取返回 invalid。
 * 所有 I/O 错误以 Result 返回；取消通过 context.abortSignal 生效，已经读出的字节不会回滚。
 */
export interface TextLineReader {
	/** 读取下一行；undefined 表示已到文件末尾。取消返回 aborted，关闭后返回 invalid。 */
	readLine(context: Context): Promise<Result<TextLine | undefined, FileError>>;
	/** 关闭读取器；幂等，关闭后 readLine 返回 invalid。 */
	close(context: Context): Promise<void>;
}

/** 对一个已打开普通文件的定位读取；文件被重命名后仍读取原文件，不会跟随路径指向的新文件。
 */
/** Positional reads from one opened regular file; all calls see the same file even if its path is renamed. */
export interface BinaryReader {
	/** Metadata of the opened file, not of whatever its path names now. */
	/** 返回打开文件的元数据（对文件描述符 stat），不是当前路径现在指向的新文件。 */
	info(context: Context): Promise<Result<FileInfo, FileError>>;
	/** Up to `length` bytes at `offset`; fewer only at end of file. */
	/** 从 offset 读取最多 length 字节；只在文件尾可能少于 length，EOF 后返回空数组。
	 * offset/length 必须是安全非负整数，否则返回 invalid；越界读取返回空而不是错误。 */
	read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>>;
	/**
	 * One pass over the file that locates lines `[startLine, endLine)` (`endLine` absent: to the end), 0-based, where line
	 * `k` starts after the `k`-th newline byte. Decoded sizes are those of the text `new TextDecoder().decode(file)` would
	 * produce for that range, so a byte-order mark at the start of the file is not counted.
	 */
	/** 一次顺序扫描全文件，定位零基行范围 [startLine, endLine)；endLine 省略表示到文件尾。
	 * 返回的偏移是原始字节位置；selectedBytes/firstLineBytes 是解码文本的 UTF-8 长度，文件开头 BOM 不计。
	 * 行号非法（负数、非整数、endLine <= startLine）返回 invalid。 */
	scanLines(options: { startLine: number; endLine?: number }, context: Context): Promise<Result<LineScan, FileError>>;
	/** 关闭读取器；幂等，之后调用 read/info/scanLines 返回 invalid。 */
	close(context: Context): Promise<void>;
}

/** 要监视的文件或目录；路径可以尚不存在，创建它会被报告为变化。
 * 字段在运行时由监视器解析成绝对路径和排除集合。
 */
/** A file or directory to watch. It may be missing; creating it is a change. */
export interface WatchTarget {
	/** 要监视的路径；可以尚不存在，创建它会被报告为变化。 */
	path: string;
	/** Watch everything below a directory, not only its entries. Symbolic links below it are not followed. */
	/** 只对目录有效：是否监视整个子树；子树中的符号链接不会被跟随。 */
	recursive?: boolean;
	/** Entries below `path` that are neither watched nor reported: names starting with `.`, or these names. */
	/** 不监视也不报告的子项名：hidden 为 true 时排除以 "." 开头的名字，names 列出精确名字。 */
	exclude?: { hidden?: boolean; names?: readonly string[] };
}

/**
 * What changed, tagged by `kind`:
 * - `paths`: something at or below each path may have changed (a directory path covers its whole subtree). Calls may be
 *   spurious; a change is never missed while the watcher is healthy.
 * - `overflow`: coverage was uncertain for a while (lost events, reconnect); rescan everything that is watched.
 * - `failed`: the watcher stopped with `error`, for example because the watched tree grew past the environment's limit;
 *   no calls follow.
 */
/** 文件变化，用 kind 区分三种情况（这是编译期可判别联合，运行时只看 kind 字符串）。 */
export type FileChange =
	/** 路径本身或子树可能变了；允许虚假通知，但健康时不会漏报。 */
	| { readonly kind: "paths"; readonly paths: string[] }
	/** 覆盖范围一度不可靠（丢事件、重连、原生 watcher 降级），调用方应重扫全部被监视内容。 */
	| { readonly kind: "overflow" }
	/** watcher 已停止并给出错误；此后不会再有回调。 */
	| { readonly kind: "failed"; readonly error: FileError };

export interface FileWatcher {
	/**
	 * `native`: changes are reported within about two seconds. `polling`: the environment compares snapshots, because
	 * the file system does not report changes reliably (network and FUSE file systems); a change undone between two
	 * snapshots can be missed.
	 */
	/** native：变化通常在约两秒内报告；polling：环境比较快照，适合不报告变化的网络/FUSE 文件系统，
	 * 但两次快照之间被撤销的变化可能漏掉。 */
	readonly mode: "native" | "polling";
	/** Stop watching; no `onChange` call starts after this resolves. Idempotent. */
	/** 停止监视；幂等，返回后不会再有新的 onChange 开始。 */
	stop(context: Context): Promise<void>;
}

/** 行扫描结果；所有偏移都是原始文件字节位置，不是解码后的字符下标。 */
/** Where lines of a file are, as `BinaryReader.scanLines` found them. */
export interface LineScan {
	/** 整个文件的 LF 数；文件因此有 newlines + 1 行（末尾换行后还有一个空行）。 */
	/** Newline bytes in the whole file; it has `newlines + 1` lines. */
	newlines: number;
	/**
	 * Byte range of the selected lines: from the start of the first to the end of the last, without the newline that
	 * ends it. A selection past the last line is empty at the end of the file.
	 */
	/** 选中行范围的原始字节偏移；end 不含结束最后一个选中行的 LF，但多行之间作为分隔的 LF 属于范围。
	 * 例：文件 "a\nb\n" 取 [0,1) 时 start=0、end=1；取 [1,2) 时 start=2、end=3。 */
	start: number;
	end: number;
	/** Where the first selected line ends: its newline, or the end of the file. */
	/** 第一条选中行的结束位置：它后面的 LF，或文件末尾。 */
	firstLineEnd: number;
	/** Where the last selected line starts. */
	/** 最后一条选中行的起始位置；选区超出文件时退回到实际最后一行。 */
	lastLineStart: number;
	/** UTF-8 byte length of the decoded selection and of its first line. */
	/** 选中文本和其中第一行解码后的 UTF-8 字节数；坏字节按 U+FFFD 的 3 字节计算。 */
	selectedBytes: number;
	firstLineBytes: number;
}

/** 目录分页读取器；每次 next 返回最多 maxEntries 项，done 表示已到末尾。 */
/** Pages of one directory's entries. */
export interface DirReader {
	/**
	 * Up to `maxEntries` entries in the order the file system returns them, continuing where the previous call stopped.
	 * `done` marks the end; it may come with the last entries or with an empty page. An entry that disappears before its
	 * metadata is read is skipped, as are entries of unsupported kinds. After a failed or aborted call, close the reader.
	 */
	/** 读取下一页；条目可能在枚举后消失而被跳过，不支持的类型也跳过。
	 * 失败或取消后应 close 读取器；close 后继续 next 返回 invalid。 */
	next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>>;
	/** 关闭读取器；幂等，之后继续 next 返回 invalid。 */
	close(context: Context): Promise<void>;
}

/** 可选 listFiles 的选项；所有上限都可能让结果提前结束并置 truncated。 */
/** What `FileSystem.listFiles` lists. */
export interface ListFilesOptions {
	/**
	 * Include names starting with `.` (on Windows also files with the hidden attribute); default true. Entries named
	 * `.git` are never listed.
	 */
	/** 是否包含以 "." 开头的名字（Windows 上还包括隐藏属性文件）；默认 true；.git 永不列出。 */
	hidden?: boolean;
	/**
	 * Inside a git work tree, skip what git ignores: the `.gitignore` files of the directory, its subdirectories and its
	 * parents, `.git/info/exclude`, and the global excludes file; default true. Unlike `git ls-files`, a tracked file that
	 * matches an ignore rule is skipped too. Outside work trees, `.gitignore` files have no effect.
	 */
	/** 在 git 工作树内是否按 .gitignore 等规则跳过；默认 true。与 git ls-files 不同，被跟踪但匹配忽略规则的文件也会跳过。 */
	gitignore?: boolean;
	/** Names of entries to skip with everything below them, such as `node_modules`. */
	/** 要连同其子树一起跳过的条目名，例如 "node_modules"。 */
	exclude?: readonly string[];
	/** Most entries to list; default 50 000. */
	/** 最多列出的条目数；默认 50 000。 */
	maxEntries?: number;
	/** Most bytes of the listing: each entry's UTF-8 path plus two; default 4 MiB, at most 15.9 MiB. */
	/** 列表的路径字节预算（每项为 UTF-8 路径长度加 2）；默认 4 MiB，最多 15.9 MiB。 */
	maxBytes?: number;
	/** Time after which the listing stops; default 10 000 ms. */
	/** 超时毫秒数；默认 10 000。 */
	timeoutMs?: number;
}

/** FileListing 中的一个条目；路径相对于被列出的目录。 */
/** One entry of a `FileListing`. */
export interface FileListEntry {
	/** 相对于被列出目录的路径，所有系统都使用 "/" 分隔。 */
	/** Relative to the listed directory, with `/` separators on every system. */
	path: string;
	/** 符号链接按 symlink 列出，不跟随其目标。 */
	/** A symbolic link is listed as such and not followed. */
	kind: FileKind;
}

export interface FileListing {
	/** Depth first, parents before their entries, siblings in byte order of their names. */
	/** 深度优先，父项先于子项，同级按名字的字节序排列。 */
	entries: FileListEntry[];
	/** A bound in `ListFilesOptions` ended the listing early. */
	/** 某个上限（条目数、字节数或时间）提前结束了列表。 */
	truncated: boolean;
}

/** 可移植文件系统能力集合；所有操作把预期失败作为 Result 返回，不抛平台异常。
 * 路径解析以 cwd 为基准，具体实现可以支持 ~ 或 file URL。
 */
/** Portable filesystem capability. Operations return failures rather than throwing. */
export interface FileSystem {
	/**
	 * The file namespace: equal ids see the same files at the same paths, whatever their `cwd`. Every local Node
	 * environment shares one id; each container or remote host has its own.
	 */
	/** 文件命名空间标识：id 相同的环境在相同路径看到同一批文件，与各自的 cwd 无关。
	 * NodeExecutionEnv 固定为 "node:local"；每个容器或远端主机有自己的 id。运行时只是字符串。 */
	readonly id: string;
	/** 解析相对路径时使用的工作目录；宿主可以在会话之间改变它。 */
	cwd: string;
	/** 把相对路径、~ 或 file URL 解析成绝对路径；Node 实现不要求路径存在。 */
	absolutePath(path: string, context: Context): Promise<Result<string, FileError>>;
	/** 用平台规则拼接路径片段，不访问文件系统；不保证结果是绝对路径。 */
	joinPath(parts: string[], context: Context): Promise<Result<string, FileError>>;
	/** 读取整个文件并解码为 UTF-8 字符串；坏字节替换为 U+FFFD，文件大小不受限制。 */
	readTextFile(path: string, context: Context): Promise<Result<string, FileError>>;
	/** 打开逐行读取器；调用者必须 close，取消通过 context 生效。 */
	openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>>;
	/** 读取至多 maxLines 行（省略则不限制）；内部打开并关闭 reader，返回行文本数组。 */
	readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>>;
	/** 读取整个文件的原始字节；大文件会一次性分配完整数组。 */
	readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>>;
	/**
	 * Open a regular file for bounded positional reads. A directory fails with `is_directory`, other non-regular files
	 * with `invalid`. With `noFollow`, a symbolic link as the final path component fails with `invalid` instead of being
	 * followed; earlier components are still resolved.
	 */
	/** 打开普通文件做定位读取；目录返回 is_directory，其他非普通文件返回 invalid。
	 * noFollow 只拒绝最终路径分量的符号链接，前面的路径分量仍会正常解析。 */
	openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>>;
	/** 创建或覆盖文件，content 可以是字符串或字节；Node 实现会先递归创建父目录，写入不是原子替换。 */
	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
	/** 追加内容，文件不存在时创建；Node 实现会先创建父目录。取消可能发生在写入之后，已追加内容不会回滚。 */
	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
	/** Truncate or extend a file to exactly `size` bytes. */
	/** 把文件截断或扩展到恰好 size 字节；扩展部分用零字节填充，size 非法返回 invalid。 */
	truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>>;
	/** Flush file contents and metadata needed to retrieve them from an open file handle. */
	/** 刷新文件内容和必要元数据，使其可从打开的文件句柄重新读取；不等于保证掉电后仍存在。 */
	flushFile(path: string, context: Context): Promise<Result<void, FileError>>;
	/** 重命名/移动文件；同一文件系统上通常是原子替换，目标已存在会被覆盖。 */
	renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>>;
	/** 查询路径本身的元数据；Node 实现使用 lstat，符号链接不会被跟随。 */
	fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>>;
	/** 列出一个目录的直接子项（不递归）；顺序由文件系统决定。 */
	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>>;
	/**
	 * Optional: the files, directories and symbolic links below a directory, at any depth, for indexes such as file
	 * completion. Symbolic links are not followed; other kinds of files are not listed; entries that cannot be read are
	 * skipped. See `ListFilesOptions` for hidden and ignored files and for the bounds. Fails with `not_supported` when
	 * the environment cannot list right now (an older remote daemon), so callers fall back to their own walk.
	 */
	/** 可选：递归列出目录下的文件、目录和符号链接，供文件补全等索引使用；不跟随符号链接。
	 * 环境暂时不支持时返回 not_supported，调用者应回退到自己的遍历；NodeExecutionEnv 不实现它。 */
	listFiles?(
		path: string,
		options: ListFilesOptions | undefined,
		context: Context,
	): Promise<Result<FileListing, FileError>>;
	/** 打开分页目录读取器；每次 next 返回一页，适合大目录。 */
	openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>>;
	/**
	 * Report changes to files and directories, for hosts that load resources from the environment. When the returned
	 * watcher exists, coverage is established: a host that watches before it loads cannot miss a change made during the
	 * load. See `FileChange` for what is reported and `FileWatcher.mode` for how reliably.
	 */
	/** 监视文件/目录变化。返回 watcher 时覆盖已经建立：先监视再加载资源的宿主不会漏掉加载期间的变化。
	 * 变化可能晚到或合并，健康时不会漏报；实现不可靠时会上报 overflow 让调用方重扫。 */
	watch(
		targets: readonly WatchTarget[],
		onChange: (change: FileChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>>;
	/** 返回解析了符号链接和 . / .. 的规范绝对路径；路径不存在时返回 not_found。 */
	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>>;
	/** 路径是否存在；Node 实现把 not_found 映射为 false，其他错误（如权限不足）仍作为 error 返回。 */
	exists(path: string, context: Context): Promise<Result<boolean, FileError>>;
	/** 创建目录；Node 实现中 recursive 默认 true，已存在且 recursive 为 true 时不报错。 */
	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>>;
	/** 删除文件或目录；Node 实现中 recursive/force 默认 false，非空目录需要 recursive。 */
	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>>;
	/** 创建唯一临时目录并返回绝对路径；Node 实现中 prefix 为空时使用 "tmp-"，调用者负责清理。 */
	createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>>;
	/** 创建唯一空临时文件并返回绝对路径；Node 实现为每个文件新建一个临时目录，可带 prefix/suffix。 */
	createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>>;
	/** 释放环境级资源（如仍在运行的子进程、连接）；用于宿主关闭，不是单次请求的取消入口。 */
	cleanup(context: Context): Promise<void>;
}

/** 当命令输出超过任一阈值时，把完整输出（含触发前的已见部分）写入临时文件，并在结果或错误中给出路径。
 * afterBytes 按原始字节计，afterLines 把最后一段未换行的文本也算作一行；两者都是“超过才触发”。
 */
/** Spill the complete output to a temporary file once it exceeds either threshold. */
export interface ShellSpillOptions {
	/** 原始输出字节数阈值。 */
	afterBytes: number;
	/** Complete or partial lines. */
	/** 行数阈值；完整行或最后一段未换行文本都计入。 */
	afterLines: number;
}

/** 命令执行成功后的结果；非零退出码仍属于 ok，只有超时/取消/spawn/回调失败才返回 err。 */
export interface ShellExecResult {
	/** 进程退出码；被信号杀死时 Node 实现换算成 128 + 信号编号。 */
	exitCode: number;
	/** Temporary file holding the complete raw output, when the spill thresholds were exceeded. */
	/** 输出超过 spill 阈值时，保存完整原始输出的临时文件路径。 */
	spillPath?: string;
}

export interface ShellExecOptions {
	/** 执行命令的工作目录，相对于环境的 cwd 解析；省略时使用环境的 cwd。 */
	cwd?: string;
	/** 追加/覆盖的环境变量；空字符串会遮蔽继承来的同名变量。 */
	env?: Record<string, string>;
	/** 是否继承 process.env；默认 true，false 时只传 env 中的变量。 */
	inheritEnv?: boolean;
	/** 超时秒数；必须是有限正数，超过 2_147_483.647 秒会被拒绝。 */
	timeout?: number;
	/**
	 * Every decoded chunk of stdout and stderr as it arrives, in arrival order, with the stream it came from: raw,
	 * unbounded, and unthrottled. Each stream is decoded separately, so a character split across chunks survives.
	 */
	/** 每收到一块 stdout/stderr 就回调：参数是解码文本、调用 context 和来源流。
	 * 文本是原始解码结果，不裁剪、不脱敏、不限速；两个流各自维护解码器，跨块的多字节字符不会损坏。 */
	onOutput?: (text: string, context: Context, info: ShellOutputInfo) => void;
	/** 输出超过阈值时把完整原始输出写入临时文件。 */
	spill?: ShellSpillOptions;
	/**
	 * The caller keeps only this tail of the output, so the environment may omit output outside it and report the omission
	 * as `info.skipped`. Without it, every chunk is delivered.
	 */
	/** 调用者只保留输出尾部时，环境可以省略调用者反正会丢弃的部分，并通过 info.skipped 报告省略量。
	 * 不传 window 时每个解码块都会送达。 */
	window?: ShellOutputWindow;
}

/**
 * The tail of the combined output a caller keeps, and how often it samples it. An environment that transfers output
 * over a slow link uses it to omit what the caller would drop anyway and to send no faster than the caller commits.
 */
/** 调用者保留的合并输出尾部，以及采样频率；远端环境用它省略最终会被丢弃的内容。 */
export interface ShellOutputWindow {
	/** UTF-8 bytes of decoded text kept at the end of the output. */
	/** 保留在输出末尾的 UTF-8 字节数上限。 */
	maxBytes: number;
	/** Lines kept at the end of the output. */
	/** 保留在输出末尾的行数上限。 */
	maxLines: number;
	/** Minimum pause between the caller's samples of the output. */
	/** 调用者两次采样之间的最小间隔（毫秒）。 */
	minIntervalMs: number;
	/** Each sample also pauses the caller in proportion to its size at this rate. */
	/** 每次采样还按字节数让调用者等待，用于限速；值越大等待越短。 */
	bytesPerSecond: number;
}

/** 环境省略的输出量，按 onOutput 本应收到的解码文本计算：每个 U+FFFD 记为 3 字节，且不做控制字符清理。 */
/**
 * Output an environment omitted, measured on the decoded text `onOutput` would have received: every U+FFFD counts as
 * three bytes, and no sanitizing is applied.
 */
/** The shape of `OutputSkip` from `@earendil-works/chord/output`, which `OutputBuffer.push()` accepts. */
export interface ShellOutputSkip {
	/** UTF-8 byte length of the omitted text. */
	/** 被省略文本的 UTF-8 字节数。 */
	bytes: number;
	/** 被省略文本中的 LF 数。 */
	/** Newlines (U+000A) in the omitted text. */
	newlines: number;
	/** Whether the omitted text ends with a newline. */
	/** 被省略文本是否以换行结束。 */
	endsWithNewline: boolean;
}

/** 一次 onOutput 回调的元数据。 */
export interface ShellOutputInfo {
	/** 本块来自哪个流；当 skipped 跨流时，这里表示本块最后一段所属的流。 */
	stream: "stdout" | "stderr";
	/**
	 * Output omitted immediately before this chunk, only with `window`. The chunk then holds all output after the
	 * omission up to its end, and that is more than the window by at least one byte or one line: more than
	 * `window.maxBytes` bytes or more than `window.maxLines` newlines. So the omitted text can never be in the kept tail.
	 * The omission and such a chunk may span both streams in arrival order; `stream` then names the chunk's last stream.
	 * Callers that need the streams apart do not pass `window`.
	 */
	/** 本块紧邻之前被省略的输出；只有传了 window 才会出现。
	 * 出现 skip 时，本块包含省略之后直到本次输出末尾的全部内容，并且至少比 window 多 1 字节或 1 行，
	 * 因此被省略的文本绝不会落在调用者保留的尾部里。 */
	skipped?: ShellOutputSkip;
}

/** shell 能力：字符串命令经平台 shell 执行，argv 数组直接启动程序。 */
export interface Shell {
	/**
	 * Run a command. A string runs through the environment's shell. An array runs `command[0]` directly with the rest
	 * as its arguments, without a shell, so they reach the program unparsed. Aborting the context or a timeout kills
	 * only this command's processes.
	 */
	/** 运行命令；字符串会交给环境的 shell，数组以 command[0] 为程序、其余为参数，不经过 shell 解析。
	 * 取消 context 或超时只会终止本次命令的进程（Node 实现用进程组/进程树）；非零退出码仍返回 ok。 */
	exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>>;
	/** Kill every command this environment still runs; for its owner's shutdown, never for one request. */
	cleanup(context: Context): Promise<void>;
}

/** 工具实际使用的执行环境：文件系统能力加 shell 能力，没有额外成员。 */
export interface ExecutionEnv extends FileSystem, Shell {}

// 转导出解码器和行扫描器：read 工具用它们解释 scanLines 的偏移，测试直接验证分块解码行为。
// 这些实现是跨平台纯逻辑（不依赖 Node API），放在契约文件旁边统一导出。
export { rangeDecoder, StreamDecoder, startsWithBom } from "./decode.ts";
export { LineScanner } from "./line-scan.ts";
