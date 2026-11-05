// 把daemon的目录枚举协议接到Durable文件接口，并让本机环境复用同样枚举逻辑；本地其他文件/命令能力仍来自NodeExecutionEnv。
// type Context只用于类型，提供取消signal等执行上下文，不因导入就开始任务。
import type { Context } from "@earendil-works/chord/context";
// Durable的公共文件能力契约和Result工具；type成员只留在类型检查，其他成员运行时真实导入。
import {
	// ExecutionEnv约束类具备完整环境接口，implements本身不补任何方法。
	type ExecutionEnv,
	// err把错误包成{ok:false,error}，不是抛异常。
	err,
	// FileError携带可移植错误码/路径/cause，和底层RemoteError区分。
	FileError,
	// FileKind表示文件种类，下面把daemon单字节种类映成它。
	type FileKind,
	// FileListEntry是单条相对路径和种类的结构。
	type FileListEntry,
	// FileListing是entries加truncated的成功值类型。
	type FileListing,
	// ListFilesOptions声明过滤/数量/字节/时间限制，没有运行时代码。
	type ListFilesOptions,
	// ok把成功值包成{ok:true,value}。
	ok,
	// Result是带ok标签的成功/失败联合，后面用ok收窄。
	type Result,
} from "@earendil-works/pi-durable/env";
// 真实继承本机文件/命令环境，只覆盖listFiles，让目录枚举走本机daemon的同套算法。
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
// 连接只作类型使用，不在这里new或部署daemon。
import type { Connection } from "./connection.ts";
// 复用取消检查点和错误映射，避免把所有远端错误抛给文件接口调用者。
import { abortResult, toFileError } from "./errors.ts";

/** Kind bytes of `listFiles` records: `f`, `d`, `l`. */
// ASCII f=102/d=100/l=108，对应文件/目录/符号链接；映射不会跟随链接。
const KINDS: Record<number, FileKind> = { 102: "file", 100: "directory", 108: "symlink" };

/**
 * `listFiles` of an absolute path through the daemon: fails with `not_supported` if the daemon does not list files
 * (a release before `listFiles`), so callers fall back to their own walk.
 */
// 通过daemon枚举绝对目录：先验证限制和取消→查能力→请求→再查取消→解payload→返回Result。例listFilesOver(conn,"/work",{maxEntries:2},ctx)；缺能力只返回not_supported，本函数不自动改用本地遍历，实际IO/过滤/排序在daemon。
export async function listFilesOver(
	// 共享连接可能按需启动/握手，不由本函数负责close。
	connection: Connection,
	// 应为已解析的绝对目录路径；这个函数不调用absolutePath自行修正。
	path: string,
	// undefined采用daemon默认，显式0是允许的预算值，不表示未设置。
	options: ListFilesOptions | undefined,
	// Context传最后以携带取消signal，类型不保证尚未取消。
	context: Context,
	// 异步结果仍包在Result里；可预期错误走ok:false，而不是成功返回空列表冒充。
): Promise<Result<FileListing, FileError>> {
	// as const把三个字符串保为只读字面量元组，key因此可索引限制字段；只验证这三种数值。
	for (const key of ["maxEntries", "maxBytes", "timeoutMs"] as const) {
		// ?.使没options时得到undefined，[]是动态索引，不是调用方法。
		const value = options?.[key];
		// number类型不能保证非负/安全整数，这里检查预算的有效取值；NaN/Infinity/小数/负数都拒绝，0接受。
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
			// 首个非法限制立即返回invalid并带path，先于取消检查，所以非法值和已取消同时存在时本分支优先。
			return err(new FileError("invalid", `${key} must be a non-negative safe integer`, path));
		}
	}
	// 泛型FileListing只让失败Result匹配成功值类型，此检查点不发送远端cancel或保证未来不中止。
	const aborted = abortResult<FileListing>(context.abortSignal, path);
	// 已取消就不握手/枚举，返回同一检查点结果。
	if (aborted) return aborted;
	// 下面连接、字节解析等异常交catch转FileError。
	try {
		// info可能按需建立连接，features缺省也视为不支持；能力存在不等于目录一定可读。
		if (!(await connection.info()).features?.includes("listFiles")) {
			// 旧daemon返回not_supported，外部调用者决定是否退回其他枚举方案。
			return err(new FileError("not_supported", "The pi-env daemon does not list files; update it", path));
		}
		// 解构取JSON元数据和独立payload字节，await等待整个枚举请求结束。
		const { json, payload } = await connection.request(
			// 操作名listFiles，不是打开可翻页的readdir句柄。
			"listFiles",
			// Fields left undefined are not sent; the daemon applies the defaults.
			// 选项在对象里可为undefined；Connection的JSON序列化会省略这些字段，由daemon取默认。
			{
				// 发送根目录路径，payload中随后返回的条目路径则相对此目录。
				path,
				// hidden控制包含隐藏条目，与watch.exclude.hidden的“排除”含义相反；缺省由daemon决定。
				hidden: options?.hidden,
				// gitignore是否遵守Git忽略规则，具体Git目录/父规则处理在daemon端。
				gitignore: options?.gitignore,
				// exclude是整项名字排除列表，不是在本客户端执行glob匹配。
				exclude: options?.exclude,
				// 条目数预算，之前已验证非负安全整数。
				maxEntries: options?.maxEntries,
				// UTF-8记录总字节预算，不是JavaScript字符串长度或文件内容体积。
				maxBytes: options?.maxBytes,
				// 枚举时间预算交daemon执行，不在客户端setTimeout精确截止。
				timeoutMs: options?.timeoutMs,
			},
			// 有signal才加请求选项；后续abort会通知daemon，Connection仍等终态回复。
			context.abortSignal ? { signal: context.abortSignal } : {},
		);
		// 收到成功回复后再看取消，取消可优先于解析/返回已收列表，不代表远端从未遍历。
		const afterAbort = abortResult<FileListing>(context.abortSignal, path);
		// 后置检查已取消就返回aborted，不再花时间解码payload。
		if (afterAbort) return afterAbort;
		// Records of a kind byte, the UTF-8 path, and a NUL.
		// 结果数组每次新建，初始为空，FileListEntry[]是元素类型约束。
		const entries: FileListEntry[] = [];
		// 按原buffer/offset/length建Buffer视图，不额外复制payload，更不会读取磁盘文件。
		const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.length);
		// start是当前记录的字节下标；递增在循环体尾部完成，所以for第三段留空。
		for (let start = 0; start < bytes.length; ) {
			// 每条记录以NUL字节结束，从当前记录起找第一个0。
			const end = bytes.indexOf(0, start);
			// 没有结尾NUL就停止，残尾被忽略，不在此抛“坏记录”或自动置truncated。
			if (end === -1) break;
			// 首字节查种类表，!只是类型断言，不新增运行时检查；未知字节得到undefined。
			const kind = KINDS[bytes[start]!];
			// 仅识别种类才加入，路径从种类后一字节解到NUL前；UTF-8解码可替换坏字节，未额外验证非空相对路径。
			if (kind !== undefined) entries.push({ path: bytes.toString("utf8", start + 1, end), kind });
			// 跨过本条NUL，继续下条；未知种类也会前进，避免卡住同一记录。
			start = end + 1;
		}
		// 只严格true才算截断，数字1/字符串true不接受；本地丢掉残尾/未知种类不会自动把它改为true。
		return ok({ entries, truncated: json.truncated === true });
	} catch (error) {
		// 异常经toFileError保留已知路径/cause与码表，包装失败Result；不重试请求，不把失败变成完整空列表。
		return err(toFileError(error, path));
	}
}

// ConstructorParameters取NodeExecutionEnv构造参数元组，[0]取首项，&再要求connection字段；复用本机cwd/shell/watch配置类型，不运行构造器。
export type LocalExecutionEnvOptions = ConstructorParameters<typeof NodeExecutionEnv>[0] & {
	/** A connection to this machine's daemon, `new Connection({ command: [localDaemon()] })`, for `listFiles`. */
	// 外部提供同机daemon连接并管理它的关闭，多个LocalExecutionEnv可共享。
	connection: Connection;
};

/**
 * `NodeExecutionEnv` with `listFiles` through a pi-env daemon on the same machine, so local and remote environments
 * list files with the same code. Everything else is `NodeExecutionEnv`'s. The connection belongs to the caller, who
 * closes it; several environments may share it.
 */
// 本机文件/命令环境加daemon目录枚举，例new LocalExecutionEnv({cwd:"/work",connection:conn})；其余能力继承Node实现，不是把所有操作都发给daemon。
export class LocalExecutionEnv extends NodeExecutionEnv implements ExecutionEnv {
	// JS私有字段保连接引用，readonly只约束TS重赋，不冻结连接。
	readonly #connection: Connection;

	// 拆出connection给子类，其他选项交父构造；只初始化对象状态，不主动握手、读目录或部署daemon。
	constructor(options: LocalExecutionEnvOptions) {
		// 对象解构+rest创建不含connection的node选项对象，字段值本身不深复制。
		const { connection, ...node } = options;
		// 派生类先super(node)，才能访问this；父类设置cwd、shell和watch等本机配置。
		super(node);
		// 保存外部连接原引用，不注册自动关闭。
		this.#connection = connection;
	}

	// 先按本机路径规则转绝对路径，再调用共享枚举函数；例cwd=/work时listFiles("src",undefined,ctx)请求/work/src，结果中的条目仍相对src。
	async listFiles(
		// 可传相对/绝对等父类支持的路径形式，由absolutePath统一处理。
		path: string,
		// 过滤与预算原样交共享函数，不在此重复设置默认值。
		options: ListFilesOptions | undefined,
		// 同一context贯穿路径解析及后续取消检查。
		context: Context,
		// Promise包Result，成功值是目录清单，不是Node的Dir或文件句柄。
	): Promise<Result<FileListing, FileError>> {
		// 继承方法通常按cwd解析并返回ok，也可能被子类覆盖；await后依据Result判断，不凭方法名假设必成功。
		const resolved = await this.absolutePath(path, context);
		// 失败标签分支直接返回原Result；TS按ok收窄，不访问不存在的value。
		if (!resolved.ok) return resolved;
		// 把绝对路径交listFilesOver，原选项/context和共享connection保持不变。
		return listFilesOver(this.#connection, resolved.value, options, context);
	}
}
