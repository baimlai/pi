// 文件导读
// 所属：packages/durable/src/storage/jsonl 的 JSONL 存储实现（包导出子路径 ./storage/jsonl）。
// 职责边界：用追加写文件的日志实现 Durable 的 Storage。小记录写进 main.jsonl 的提交标记；大内容（任务
//   检查点、文档 base/delta）写进每任务/每文档的 sidecar 文件，由标记按 (seq, ordinal) 引用。内存中的
//   MemoryStorage 保存已提交状态的运行时副本；本类负责把每个 batch 编码、追加、恢复和回收。
//   它不选择文件系统、不管理目录生命周期（open 创建目录，close 只关内存存储）。
// 上下游：Node 入口在 ./node.ts；跨平台调用者注入 FileSystem。下游是 MemoryStorage 的 prepareCommit/apply、
//   env/index.ts 的 FileSystem 原语。
// 结果与错误：解析/顺序错误抛 JsonlCorruptionError（打开时）；一旦某批已应用到内存而写文件失败，存储进入
//   poisoned 状态，之后所有操作抛 JsonlStoragePoisonedError，必须重开。
// 能力清单：
// - JsonlStorageOptions（类型）：fsync。
// - JsonlCorruptionError / JsonlStoragePoisonedError：损坏与毒化两类错误。
// - JsonlStorage（类）：open/commit/mintId/全部读取方法/close。
// - 内部类型与函数：主标记、sidecar 记录、编码、校验、恢复、回收。
// 组合顺序：JsonlStorage.open -> commit（encodeCommit -> memory.prepareCommit/apply -> append）->
//   读取（等待 writing 后委托 MemoryStorage）-> close。
// 示例：const storage = await openNodeJsonlStorage("./history", context);
//   await storage.commit([[{ type: "entry", value }]], receive, context);
// 阅读顺序：类型与编码格式 -> open/recover -> commit/append -> planReclamations/reclaimSidecars ->
//   读取委托 -> 恢复期辅助（confirmRecord/readLines）。
import type { Context } from "@earendil-works/chord/context";
// Context 用于文件系统调用的取消/追踪；JsonlStorage 自身不持久化取消状态。
import type { JsonValue } from "@earendil-works/chord/json";
// 任务记录统一按 JsonValue 存取，存储层不关心检查点/结果的具体形状。
import type { FileError, FileSystem } from "../../env/index.ts";
// FileSystem 是平台注入的文件原语；FileError 是它的错误形状。
import { StorageRequestError } from "../../errors.ts";
// 请求级读取错误：未知会话/非法游标等，只失败该次读取。
import { idFromNumber, seqFromNumber } from "../../ids.ts";
// 数字与品牌类型转换；日志中保存的是普通数字序号。
import type {
	CommitResult,
	ConversationId,
	ConversationQuery,
	Cursor,
	DocumentAddress,
	DocumentContent,
	DocumentCreate,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	EntryId,
	EntryQuery,
	Id,
	Seq,
	Storage,
	StorageWrite,
	SubmissionId,
	SubmissionQuery,
	TaskId,
	TaskQuery,
	TaskRecord,
} from "../../types.ts";
// MemoryStorage 提供已提交状态、检查逻辑和克隆语义；JSONL 只负责持久化与恢复。
import { MemoryStorage } from "../memory.ts";

// 日志格式版本；读取到其他版本的标记/记录视为损坏。
const FORMAT_VERSION = 1;
// 主日志文件名；提交标记按 seq 顺序追加在这里。
const MAIN_FILE = "main.jsonl";
// 回收 sidecar 时的临时文件后缀；启动时这些文件会被清理。
const RECLAIM_SUFFIX = ".reclaim";
// fatal 模式：完整行中的非法 UTF-8 直接抛错，而不是替换成 U+FFFD 造成静默数据变化。
const textDecoder = new TextDecoder("utf-8", { fatal: true });

// 任务记录别名，减少泛型重复。
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

// 主标记中的一条写操作：小记录直接内联，大内容用 ordinal 指向 sidecar 记录。
// task.sidecar/document.create/document.change 的 ordinal 在同一次提交内唯一。
type MainOperation =
	| Extract<StorageWrite, { readonly type: "conversation" | "entry" | "submission" | "document.retire" }>
	| { readonly type: "task"; readonly value: StoredTask }
	| { readonly type: "task.sidecar"; readonly id: TaskId; readonly ordinal: number }
	| { readonly type: "document.create"; readonly record: DocumentCreate; readonly ordinal: number }
	| { readonly type: "document.change"; readonly id: DocumentId; readonly ordinal: number };

// 一行主标记：格式版本、提交序号和本批操作；它是该批“已提交”的唯一凭据。
type MainMarker = {
	readonly format: typeof FORMAT_VERSION;
	readonly type: "commit";
	readonly seq: Seq;
	readonly writes: readonly MainOperation[];
};

// sidecar 负载：任务记录（非终态）或文档内容；终态任务直接进主标记。
type SidecarPayload =
	| { readonly type: "task"; readonly value: StoredTask }
	| { readonly type: "document"; readonly id: DocumentId; readonly content: DocumentContent };

// 一行 sidecar 记录：由 (seq, ordinal) 唯一定位，payload 是实际内容。
type SidecarRecord = {
	readonly format: typeof FORMAT_VERSION;
	readonly type: "record";
	readonly seq: Seq;
	readonly ordinal: number;
	readonly payload: SidecarPayload;
};

// 解析后的一行：值及该行在文件中的起始字节偏移，用于截断未确认尾部。
type ParsedLine<T> = {
	readonly value: T;
	readonly start: number;
};

// 一个 sidecar 文件的全部完整行；path 在恢复时用于截断。
type ParsedFile<T> = {
	readonly path: string;
	readonly lines: readonly ParsedLine<T>[];
};

// 编码后的提交：主标记文本与各 sidecar 追加文本。
// sidecars 的键是文件名，值是本次要追加的完整行拼接。
type EncodedCommit = {
	readonly marker: string;
	readonly sidecars: ReadonlyMap<string, string>;
};

// 打开选项：fsync=true 时在写主标记前刷新所有受影响的 sidecar（以及主标记），提高崩溃安全性。
// 默认 false：依赖文件系统顺序，速度更快。
export type JsonlStorageOptions = {
	/** Flush every affected sidecar before appending the main marker. Defaults to false. */
	readonly fsync?: boolean;
};

// 日志内容无法解析、顺序非法或已提交状态无法重放时抛出；表示持久化数据不可信。
export class JsonlCorruptionError extends Error {
	constructor(message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "JsonlCorruptionError";
	}
}

// 毒化错误：某批已应用到内存后写文件失败，内存与磁盘可能不一致，必须重新打开存储。
export class JsonlStoragePoisonedError extends Error {
	constructor(cause: Error) {
		super("JSONL storage is poisoned and must be reopened", { cause });
		this.name = "JsonlStoragePoisonedError";
	}
}

// 运行时类型守卫：对象且不是 null/数组。日志来自外部文件，解析后必须逐字段校验。
const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

// 安全整数守卫：序号、ordinal、id 都必须是可精确表示的数字。
const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);

// sidecar 文件命名：task-<id>.jsonl 或 doc-<id>.jsonl。
const sidecarFileName = (kind: "doc" | "task", id: DocumentId | TaskId): string => `${kind}-${id}.jsonl`;

// 识别 sidecar 文件名（非负十进制 id）；恢复时只读取这些文件。
const isSidecarFileName = (name: string): boolean => /^(?:doc|task)-(?:0|[1-9]\d*)\.jsonl$/.test(name);

// 识别回收临时文件；启动时直接删除，它们是未完成的替换。
const isReclaimFileName = (name: string): boolean => /^(?:doc|task)-(?:0|[1-9]\d*)\.jsonl\.reclaim$/.test(name);

// latest 历史的文档只保留当前修订；恢复时可安全丢弃更早的 base。
const isCurrentOnly = (record: DocumentCreate): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";

// sidecar 记录在恢复期的唯一键：文件名 + 提交 seq + 批内 ordinal。
const sidecarKey = (file: string, seq: Seq, ordinal: number): string => JSON.stringify([file, seq, ordinal]);

// 序列化成一行 JSON 并补换行；日志按换行分帧。
const jsonLine = (value: MainMarker | SidecarRecord): string => `${JSON.stringify(value)}\n`;

// 把 FileSystem 的 FileError 包装成带操作名的普通 Error；保留 cause 便于诊断。
const errorFromFile = (action: string, error: FileError): Error =>
	new Error(`JSONL ${action} failed: ${error.message}`, { cause: error });

// 解析完整行；任何语法错误都变成 JsonlCorruptionError，并保留原 Error 作为 cause。
const parseJson = (text: string, description: string): unknown => {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new JsonlCorruptionError(`Malformed complete ${description}`, error instanceof Error ? error : undefined);
	}
};

// 校验主标记中的一条操作，按 type 检查必要字段；这是从磁盘读取的信任边界。
// 校验失败抛 JsonlCorruptionError，调用方不会尝试继续重放。
const validateMainOperation = (value: unknown, description: string): MainOperation => {
	if (!isObject(value) || typeof value.type !== "string") {
		throw new JsonlCorruptionError(`Invalid write in ${description}`);
	}
	// 小记录（会话/条目/提交）内联在主标记：至少要求 value 是对象且 id 是安全整数。
	switch (value.type) {
		case "conversation":
		case "entry":
		case "submission":
			if (!isObject(value.value) || !isSafeInteger(value.value.id)) {
				throw new JsonlCorruptionError(`Invalid ${value.type} write in ${description}`);
			}
			return value as MainOperation;
		// 终态任务直接内联；state 必须存在且 status 为 terminal。非终态任务走 sidecar。
		case "task":
			if (
				!isObject(value.value) ||
				!isSafeInteger(value.value.id) ||
				!isObject(value.value.state) ||
				value.value.state.status !== "terminal"
			) {
				throw new JsonlCorruptionError(`Invalid terminal task write in ${description}`);
			}
			return value as MainOperation;
		// 退役文档只需要文档 id。
		case "document.retire":
			if (!isSafeInteger(value.id)) throw new JsonlCorruptionError(`Invalid document retirement in ${description}`);
			return value as MainOperation;
		// 指向任务 sidecar 的引用：id 与 ordinal 必须有效；ordinal 从 0 开始。
		case "task.sidecar":
			if (!isSafeInteger(value.id) || !isSafeInteger(value.ordinal) || value.ordinal < 0) {
				throw new JsonlCorruptionError(`Invalid task sidecar write in ${description}`);
			}
			return value as MainOperation;
		// 文档创建：记录对象、文档 id、ordinal 都必须有效。
		case "document.create":
			if (
				!isObject(value.record) ||
				!isSafeInteger(value.record.id) ||
				!isSafeInteger(value.ordinal) ||
				value.ordinal < 0
			) {
				throw new JsonlCorruptionError(`Invalid document creation in ${description}`);
			}
			return value as MainOperation;
		// 文档变更：只需要文档 id 与 ordinal；内容在 sidecar 中。
		case "document.change":
			if (!isSafeInteger(value.id) || !isSafeInteger(value.ordinal) || value.ordinal < 0) {
				throw new JsonlCorruptionError(`Invalid document change in ${description}`);
			}
			return value as MainOperation;
		// 未知 type 说明文件来自不兼容版本或已损坏。
		default:
			throw new JsonlCorruptionError(`Unknown write type in ${description}`);
	}
};

// 解析并校验一行主标记：格式版本、type=commit、正 seq、writes 数组，再逐条校验操作。
// 返回品牌化 seq 和已校验操作；description 用于错误消息定位行号。
const parseMainMarker = (text: string, line: number): MainMarker => {
	const description = `${MAIN_FILE} line ${line}`;
	const value = parseJson(text, description);
	// 基本形状检查；value.seq 是普通数字，随后转成品牌 Seq。
	if (
		!isObject(value) ||
		value.format !== FORMAT_VERSION ||
		value.type !== "commit" ||
		!isSafeInteger(value.seq) ||
		value.seq < 1 ||
		!Array.isArray(value.writes)
	) {
		throw new JsonlCorruptionError(`Invalid commit marker in ${description}`);
	}
	// 重新构造对象而不是直接返回解析值，确保只保留已知字段且 writes 已逐条校验。
	return {
		format: FORMAT_VERSION,
		type: "commit",
		seq: seqFromNumber(value.seq),
		writes: value.writes.map((write) => validateMainOperation(write, description)),
	};
};

// 校验文档内容：version 为正整数；base 必须有对象 value，delta 必须有 ops 数组。
const validateDocumentContent = (value: unknown, description: string): DocumentContent => {
	if (!isObject(value) || !isSafeInteger(value.version) || value.version < 1) {
		throw new JsonlCorruptionError(`Invalid document content in ${description}`);
	}
	if (value.kind === "base" && isObject(value.value)) return value as DocumentContent;
	if (value.kind === "delta" && Array.isArray(value.ops)) return value as DocumentContent;
	throw new JsonlCorruptionError(`Invalid document content in ${description}`);
};

// 解析并校验一行 sidecar：格式/seq/ordinal/payload.type，再按任务或文档校验 payload。
const parseSidecarRecord = (text: string, file: string, line: number): SidecarRecord => {
	const description = `${file} line ${line}`;
	const value = parseJson(text, description);
	if (
		!isObject(value) ||
		value.format !== FORMAT_VERSION ||
		value.type !== "record" ||
		!isSafeInteger(value.seq) ||
		value.seq < 1 ||
		!isSafeInteger(value.ordinal) ||
		value.ordinal < 0 ||
		!isObject(value.payload) ||
		typeof value.payload.type !== "string"
	) {
		throw new JsonlCorruptionError(`Invalid sidecar record in ${description}`);
	}
	// 任务 sidecar 只能存非终态记录；终态任务应直接写主标记。
	if (value.payload.type === "task") {
		if (
			!isObject(value.payload.value) ||
			!isSafeInteger(value.payload.value.id) ||
			!isObject(value.payload.value.state) ||
			value.payload.value.state.status === "terminal"
		) {
			throw new JsonlCorruptionError(`Invalid live task record in ${description}`);
		}
		// 文档 sidecar 校验内容形状；id 是安全整数。
	} else if (value.payload.type === "document") {
		if (!isSafeInteger(value.payload.id)) {
			throw new JsonlCorruptionError(`Invalid document record in ${description}`);
		}
		validateDocumentContent(value.payload.content, description);
		// 未知 payload 类型视为损坏。
	} else {
		throw new JsonlCorruptionError(`Unknown sidecar record type in ${description}`);
	}
	return value as SidecarRecord;
};

// 可移植 JSONL 存储：内存状态 + 追加日志 + 启动恢复。
/** Portable JSONL implementation of the storage contract. */
export class JsonlStorage implements Storage {
	// 文件系统与目录在打开后固定；mainPath 是主日志的绝对路径。
	private readonly fs: FileSystem;
	private readonly directory: string;
	private readonly mainPath: string;
	private readonly fsync: boolean;
	// memory 保存已提交状态并复用其检查/克隆逻辑；日志失败时它可能领先于磁盘。
	private readonly memory = new MemoryStorage();
	// currentOnlyDocuments 记录 latest 文档 id，用于决定回收哪些旧 base。
	private readonly currentOnlyDocuments = new Set<DocumentId>();
	// liveTaskSidecars 记录当前有非终态任务 sidecar 的 id，终态时删除文件。
	private readonly liveTaskSidecars = new Set<TaskId>();
	// closed 与 poisonError 共同决定 assertUsable；毒化后即使未 close 也拒绝。
	private closed = false;
	private poisonError: JsonlStoragePoisonedError | undefined;
	// writing 表示一批 sidecar/标记正在追加；读取会等待它，避免读到内存领先但磁盘未落的状态。
	/** Settles once the batch being appended is; its batches are in memory already (`commit()`). */
	private writing: Promise<void> | undefined;

	// 构造函数私有：调用者必须走 open，以便解析绝对路径、创建目录并恢复日志。
	private constructor(fs: FileSystem, directory: string, mainPath: string, options: JsonlStorageOptions) {
		this.fs = fs;
		this.directory = directory;
		this.mainPath = mainPath;
		this.fsync = options.fsync ?? false;
	}

	// 打开或创建日志目录：解析绝对路径、递归创建目录、拼接 main.jsonl，然后恢复。
	// 参数 directory 可为相对路径（由 FileSystem 的 root 解释）；fs 提供全部文件原语；
	// 返回恢复完成的存储。路径/创建/读取失败会拒绝。
	// 例：await JsonlStorage.open("history", fs, context) 会创建 history/ 并读取其中 main.jsonl。
	/** Open or create a JSONL storage directory using the supplied filesystem. */
	static async open(
		directory: string,
		fs: FileSystem,
		context: Context,
		options: JsonlStorageOptions = {},
	): Promise<JsonlStorage> {
		// absolutePath 的结果是 Result：ok=false 时错误是 FileError，包装后抛出。
		const absolute = await fs.absolutePath(directory, context);
		if (!absolute.ok) throw errorFromFile("path resolution", absolute.error);
		// 递归创建目录；已存在不算错误。
		const created = await fs.createDir(absolute.value, { recursive: true }, context);
		if (!created.ok) throw errorFromFile("directory creation", created.error);
		// 拼接路径也返回 Result；这里得到 main.jsonl 的绝对路径。
		const mainPathResult = await fs.joinPath([absolute.value, MAIN_FILE], context);
		if (!mainPathResult.ok) throw errorFromFile("path join", mainPathResult.error);
		// 构造后立即 recover；恢复失败时对象不会返回，调用方看到拒绝。
		const storage = new JsonlStorage(fs, absolute.value, mainPathResult.value, options);
		await storage.recover(context);
		return storage;
	}

	// 提交：每个 batch 先经 MemoryStorage.prepareCommit 检查/克隆，成功就立即 apply 到内存并编码；
	// 所有 batch 处理完后，sidecar 先追加、主标记最后追加。第一个被检查拒绝的 batch 停止后续，
	// 之前的 batch 已经进入内存并会被写出。
	// 任意一批已应用后写文件失败：毒化存储再拒绝，避免后续读取返回未持久化的状态。
	// receive 在标记落盘后同步调用；随后才做 best-effort sidecar 回收。
	// 例：commit([[a], [b]], receive, ctx)；若 b 被拒绝，返回 { stored: 1, refused } 且只写 a。
	/**
	 * Commit `batches` with one append per affected file: every batch's sidecar records first, then their markers in one
	 * write of `main.jsonl`. Each batch is checked against the state the earlier ones left, so memory applies each one
	 * as it passes, and reads wait until the appends are done; the first batch refused ends the batch. A torn append of
	 * the markers recovers a shorter complete prefix; any failure once a batch applied poisons the storage.
	 */
	async commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		context: Context,
	): Promise<CommitResult> {
		// 关闭/毒化后拒绝；这是所有公开入口的第一步。
		this.assertUsable();
		// seqs 收集已应用批次的序号；encoded 收集待追加的标记/sidecar；reclamations 收集可回收内容。
		const seqs: Seq[] = [];
		const encoded: EncodedCommit[] = [];
		const reclamations = new Map<string, string>();
		let refused: { readonly error: unknown } | undefined;
		// 用 resolvers 建立“本批正在追加”的 Promise；读取会 await 它。
		// finally 中无论成功失败都会清空 writing 并 resolve，避免读取永久等待。
		const writing = Promise.withResolvers<void>();
		this.writing = writing.promise;
		// 逐 batch 处理；prepareCommit 只检查/克隆，不改变可观察状态。
		try {
			for (const writes of batches) {
				let prepared: ReturnType<MemoryStorage["prepareCommit"]>;
				// 检查拒绝：记录错误并停止，不再编码或写入该批。
				try {
					prepared = this.memory.prepareCommit(writes);
				} catch (error) {
					refused = { error };
					break;
				}
				// 编码本批：把大内容分配到 sidecar，把其余操作放进主标记。
				const commit = this.encodeCommit(prepared.seq, prepared.writes);
				// 若更早的 batch 已计划替换同一 sidecar，新内容追加在替换内容之后，保持文件内顺序。
				// A sidecar an earlier batch replaces keeps what the later ones append, unless they replace it again.
				for (const [file, content] of commit.sidecars) {
					const replacement = reclamations.get(file);
					if (replacement !== undefined) reclamations.set(file, replacement + content);
				}
				// planReclamations 根据本批语义决定哪些 sidecar 文件可清空或重写。
				for (const [file, content] of this.planReclamations(prepared.writes, commit))
					reclamations.set(file, content);
				// apply() 把已检查的提交落到内存；返回序号，随后才编码/写盘。
				seqs.push(prepared.apply());
				// 维护 currentOnlyDocuments/liveTaskSidecars 集合，供后续回收判断。
				this.adoptSidecarState(prepared.writes);
				encoded.push(commit);
			}
			// 所有批次都应用到内存后，一次性追加到文件；没有可写的批次则跳过。
			if (encoded.length > 0) await this.append(encoded, context);
			// 写盘失败：若一个批次都没应用，错误原样抛出；否则先毒化，再抛毒化错误。
			// 这样等待追加的读取会失败，而不是读到内存中尚未持久化的状态。
		} catch (error) {
			// Memory runs ahead of the file: once a batch applied, any failure poisons the storage before the reads
			// waiting on the append go on, so none of them returns what is not stored.
			if (seqs.length === 0) throw error;
			// 包成 Error：文件系统/磁盘可能抛出任意值，毒化错误需要 Error cause。
			throw this.poison(error instanceof Error ? error : new Error("JSONL commit failed", { cause: error }));
		} finally {
			// 无论成功失败都结束“正在写”状态，唤醒 readable()。
			this.writing = undefined;
			writing.resolve();
		}
		// 标记已落盘：先发持久化回执，再做可重试的回收维护。
		// The markers are appended: the batches are durable. Reclaiming sidecars comes after the receipts.
		// 回执按批次顺序同步调用；seq 已带品牌。
		for (const [index, seq] of seqs.entries()) receive(index, seq);
		// 回收失败不会毒化存储：标记已持久化，维护可以下次再做。
		await this.reclaimSidecars(reclamations, context);
		return refused === undefined ? { stored: seqs.length } : { stored: seqs.length, refused: refused.error };
	}

	// 追加：把各批次的 sidecar 内容按文件合并，先写 sidecar（可选 fsync），最后一次性写主标记。
	// 主标记最后写保证恢复时不会看到“标记已提交但 sidecar 不完整”的中间状态。
	/** Append the sidecar records of `commits`, flushed with `fsync`, then their markers in one write of `main.jsonl`. */
	private async append(commits: readonly EncodedCommit[], context: Context): Promise<void> {
		// contents 以文件名为键累积文本；同一 sidecar 可能被多个批次追加。
		const contents = new Map<string, string>();
		for (const commit of commits) {
			for (const [file, content] of commit.sidecars) contents.set(file, (contents.get(file) ?? "") + content);
		}
		// 并行解析所有 sidecar 的绝对路径；路径解析失败会使 append 抛错。
		const sidecars = await Promise.all(
			[...contents].map(async ([file, content]) => ({
				file,
				content,
				path: await this.resolveFile(file, context),
			})),
		);
		// 逐文件追加；失败立即毒化，因为内存已经领先。
		for (const sidecar of sidecars) {
			const result = await this.fs.appendFile(sidecar.path, sidecar.content, context);
			if (!result.ok) throw this.poison(errorFromFile(`append to ${sidecar.file}`, result.error));
		}
		// fsync 模式下逐个刷新 sidecar，确保标记写入前内容已落盘。
		if (this.fsync) {
			for (const sidecar of sidecars) {
				const result = await this.fs.flushFile(sidecar.path, context);
				if (!result.ok) throw this.poison(errorFromFile(`flush of ${sidecar.file}`, result.error));
			}
		}
		// 多个标记拼成一次 append；单批次直接复用已编码文本。
		const markers = commits.length === 1 ? commits[0]!.marker : commits.map((commit) => commit.marker).join("");
		// 主标记是提交的唯一凭据；写入失败同样毒化。
		const marker = await this.fs.appendFile(this.mainPath, markers, context);
		if (!marker.ok) throw this.poison(errorFromFile(`append to ${MAIN_FILE}`, marker.error));
	}

	// 分配 id 委托给 MemoryStorage；它维护 nextId 并在关闭时拒绝。
	async mintId<I extends Id<string>>(): Promise<I> {
		return this.store.mintId<I>();
	}

	// 以下读取方法都先 readable()：若正在写盘则等待，然后委托给内存存储。
	// 读取不触碰文件，也没有额外的持久化校验。
	async conversation(id: ConversationId, context: Context) {
		return (await this.readable()).conversation(id, context);
	}

	async scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		return (await this.readable()).scanConversations(query, limit, cursor, context);
	}

	// entry 的两个重载与 SqliteStorage 相同；实现按是否给出 context 分支。
	entry(id: EntryId, context: Context): ReturnType<Storage["entry"]>;
	entry(conversationId: ConversationId, id: EntryId, context: Context): ReturnType<Storage["entry"]>;
	async entry(idOrConversationId: EntryId | ConversationId, idOrContext: EntryId | Context, context?: Context) {
		// 三参重载：idOrContext 是 Context，只按 entry id 读取。
		if (context === undefined)
			return (await this.readable()).entry(idFromNumber<EntryId>(idOrConversationId), idOrContext as Context);
		// 四参重载：第二个参数必须是数字 entry id；否则是请求错误。
		if (typeof idOrContext !== "number") throw new StorageRequestError("Storage.entry() requires an entry ID");
		return (await this.readable()).entry(
			idFromNumber<ConversationId>(idOrConversationId),
			idFromNumber<EntryId>(idOrContext),
			context,
		);
	}

	async findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	) {
		return (await this.readable()).findLatestHeadMarker(conversationId, atOrBeforeEntryId, context);
	}

	async scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		return (await this.readable()).scanEntries(query, limit, cursor, context);
	}

	async task(id: TaskId, context: Context) {
		return (await this.readable()).task(id, context);
	}

	async scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		return (await this.readable()).scanTasks(query, limit, cursor, context);
	}

	async submission(id: SubmissionId, context: Context) {
		return (await this.readable()).submission(id, context);
	}

	async scanSubmissions(query: SubmissionQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		return (await this.readable()).scanSubmissions(query, limit, cursor, context);
	}

	async submissionByRequest(conversationId: ConversationId, requestId: string, context: Context) {
		return (await this.readable()).submissionByRequest(conversationId, requestId, context);
	}

	async findDocument(address: DocumentAddress, at: DocumentPoint, context: Context) {
		return (await this.readable()).findDocument(address, at, context);
	}

	async document(id: DocumentId, at: DocumentPoint, context: Context) {
		return (await this.readable()).document(id, at, context);
	}

	async scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		return (await this.readable()).scanDocuments(query, limit, cursor, context);
	}

	// 关闭：幂等；只关闭内存存储，不关闭文件系统（调用者拥有它）。
	async close(context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.memory.close(context);
	}

	// 编码一次已检查的提交：把 task/document 大内容分流到 sidecar，返回主标记与 sidecar 文本。
	// 同一提交内 ordinal 从 0 递增，保证 (seq, ordinal) 唯一定位 sidecar 记录。
	private encodeCommit(seq: Seq, writes: readonly StorageWrite[]): EncodedCommit {
		// mainWrites 保存主标记中的操作；records 按文件名收集 sidecar 行；nextOrdinal 是批内序号。
		const mainWrites: MainOperation[] = [];
		const records = new Map<string, SidecarRecord[]>();
		let nextOrdinal = 0;
		// addSidecar 分配 ordinal，把记录加入对应文件，并返回 ordinal 供主标记引用。
		const addSidecar = (file: string, payload: SidecarPayload): number => {
			const ordinal = nextOrdinal++;
			let fileRecords = records.get(file);
			if (fileRecords === undefined) {
				fileRecords = [];
				records.set(file, fileRecords);
			}
			// 每条 sidecar 行都带同一 seq 与递增 ordinal。
			fileRecords.push({ format: FORMAT_VERSION, type: "record", seq, ordinal, payload });
			return ordinal;
		};

		// 按写类型分流：小记录内联；非终态任务与文档内容进 sidecar。
		for (const write of writes) {
			switch (write.type) {
				case "conversation":
				case "entry":
				case "submission":
				case "document.retire":
					mainWrites.push(write);
					break;
				// 终态任务不再需要 sidecar，直接内联，恢复后即为最终记录。
				case "task":
					if (write.value.state.status === "terminal") mainWrites.push(write);
					else {
						// 非终态任务：完整记录进 task-<id>.jsonl，主标记只留引用。
						const ordinal = addSidecar(sidecarFileName("task", write.value.id), {
							type: "task",
							value: write.value,
						});
						mainWrites.push({ type: "task.sidecar", id: write.value.id, ordinal });
					}
					break;
				// 文档创建：base 内容进 doc-<id>.jsonl，主标记保留创建记录和 ordinal。
				case "document.create": {
					const ordinal = addSidecar(sidecarFileName("doc", write.record.id), {
						type: "document",
						id: write.record.id,
						content: write.content,
					});
					mainWrites.push({ type: "document.create", record: write.record, ordinal });
					break;
				}
				// 文档变更：内容进 doc sidecar；主标记只留 id 与 ordinal。
				case "document.change": {
					const ordinal = addSidecar(sidecarFileName("doc", write.id), {
						type: "document",
						id: write.id,
						content: write.content,
					});
					mainWrites.push({ type: "document.change", id: write.id, ordinal });
					break;
				}
			}
		}

		// 把每个文件的记录逐行编码并拼接，得到本批要追加的文本。
		const sidecars = new Map<string, string>();
		for (const [file, fileRecords] of records) {
			sidecars.set(file, fileRecords.map((record) => jsonLine(record)).join(""));
		}
		// 主标记包含 seq 与带 ordinal 的 writes；恢复时用它确认 sidecar。
		const marker: MainMarker = {
			format: FORMAT_VERSION,
			type: "commit",
			seq,
			writes: mainWrites,
		};
		return { marker: jsonLine(marker), sidecars };
	}

	// 计划回收：根据本批语义决定哪些 sidecar 可清空/重写。只返回替换内容，不写盘。
	// 规则：latest 文档只保留最新 base；退役的 latest 文档删除文件；终态任务删除 sidecar。
	private planReclamations(writes: readonly StorageWrite[], encoded: EncodedCommit): ReadonlyMap<string, string> {
		// 四个集合分别记录：本批创建的 latest 文档、退役文档、写入 base 的文档、最终任务记录。
		const createdCurrentOnlyDocuments = new Set<DocumentId>();
		const retiredDocuments = new Set<DocumentId>();
		const baseDocuments = new Set<DocumentId>();
		const finalTasks = new Map<TaskId, StoredTask>();
		for (const write of writes) {
			switch (write.type) {
				case "document.create":
					if (isCurrentOnly(write.record)) createdCurrentOnlyDocuments.add(write.record.id);
					break;
				case "document.change":
					if (write.content.kind === "base") baseDocuments.add(write.id);
					break;
				case "document.retire":
					retiredDocuments.add(write.id);
					break;
				case "task":
					finalTasks.set(write.value.id, write.value);
					break;
			}
		}

		// replacements 是“文件名 -> 新内容”；空串表示删除。
		const replacements = new Map<string, string>();
		// 判断 latest 文档：历史集合或本批新创建的都算。
		const isCurrentOnlyDocument = (id: DocumentId): boolean =>
			this.currentOnlyDocuments.has(id) || createdCurrentOnlyDocuments.has(id);
		// 退役的 latest 文档不再需要任何修订，清空其 sidecar。
		for (const id of retiredDocuments) {
			if (isCurrentOnlyDocument(id)) replacements.set(sidecarFileName("doc", id), "");
		}
		// 写入新 base 的 latest 文档只保留这个 base；取本批编码出的内容重写文件。
		for (const id of baseDocuments) {
			if (!isCurrentOnlyDocument(id) || retiredDocuments.has(id)) continue;
			const file = sidecarFileName("doc", id);
			const content = encoded.sidecars.get(file);
			if (content !== undefined) replacements.set(file, content);
		}
		// 终态任务若之前有 sidecar，删除文件；本批内联的终态任务不会新增 sidecar。
		for (const [id, task] of finalTasks) {
			if (
				task.state.status === "terminal" &&
				(this.liveTaskSidecars.has(id) || encoded.sidecars.has(sidecarFileName("task", id)))
			) {
				replacements.set(sidecarFileName("task", id), "");
			}
		}
		return replacements;
	}

	// 提交应用后维护集合：本批创建 latest 文档、任务是否仍有非终态 sidecar。
	private adoptSidecarState(writes: readonly StorageWrite[]): void {
		for (const write of writes) {
			if (write.type === "document.create") {
				if (isCurrentOnly(write.record)) this.currentOnlyDocuments.add(write.record.id);
			} else if (write.type === "task") {
				if (write.value.state.status === "terminal") this.liveTaskSidecars.delete(write.value.id);
				else this.liveTaskSidecars.add(write.value.id);
			}
		}
	}

	// 回收 sidecar：标记已经持久化，因此这是可重试的 best-effort 维护；失败静默返回。
	/** The marker already published this state, so reclamation is retryable best-effort maintenance. */
	private async reclaimSidecars(replacements: ReadonlyMap<string, string>, context: Context): Promise<void> {
		if (replacements.size === 0) return;
		// fsync 模式下先刷新主标记，保证回收不会发生在标记落盘之前。
		if (this.fsync) {
			const flushed = await this.fs.flushFile(this.mainPath, context);
			if (!flushed.ok) return;
		}
		// 逐个替换；replaceSidecar 内部吞掉路径/写入错误。
		for (const [file, content] of replacements) await this.replaceSidecar(file, content, context);
	}

	// 原子替换一个 sidecar：空内容直接删除；否则写 .reclaim 临时文件，刷新（可选）后 rename。
	// 任一步失败都直接返回，调用方把它当作可重试维护失败。
	private async replaceSidecar(file: string, content: string, context: Context): Promise<void> {
		// 拼接 sidecar 路径；失败则放弃本次回收。
		const path = await this.fs.joinPath([this.directory, file], context);
		if (!path.ok) return;
		if (content === "") {
			await this.fs.remove(path.value, { force: true }, context);
			return;
		}
		// 临时文件名固定加 .reclaim；启动时会清理遗留临时文件。
		const temporaryPath = await this.fs.joinPath([this.directory, `${file}${RECLAIM_SUFFIX}`], context);
		if (!temporaryPath.ok) return;
		// 写入完整替换内容；失败放弃。
		const written = await this.fs.writeFile(temporaryPath.value, content, context);
		if (!written.ok) return;
		// fsync 模式下先刷新临时文件，再 rename。
		if (this.fsync) {
			const flushed = await this.fs.flushFile(temporaryPath.value, context);
			if (!flushed.ok) return;
		}
		// rename 是原子的；替换完成。
		await this.fs.renameFile(temporaryPath.value, path.value, context);
	}

	// 恢复：读取主标记和 sidecar，截断未确认尾部，按标记重放内存状态，再回收多余 sidecar。
	// 主标记是提交凭据；只有被某个标记引用的 sidecar 行才算已确认。
	private async recover(context: Context): Promise<void> {
		const fs = this.fs;
		const directory = this.directory;
		const memory = this.memory;
		// 读取 main.jsonl 的所有完整行；不完整的最后一行会被截断。
		const main = await JsonlStorage.readLines(fs, this.mainPath, MAIN_FILE, context, (text, line) =>
			parseMainMarker(text, line),
		);
		let previousSeq = 0;
		// 主标记的 seq 必须严格递增；重复或倒序说明文件损坏。
		for (const marker of main.lines) {
			if (marker.value.seq <= previousSeq) {
				throw new JsonlCorruptionError(`Commit sequence does not strictly increase in ${MAIN_FILE}`);
			}
			previousSeq = marker.value.seq;
		}

		// 列出目录，先清理上次中断留下的 .reclaim 临时文件。
		const listed = await fs.listDir(directory, context);
		if (!listed.ok) throw errorFromFile("directory listing", listed.error);
		for (const info of listed.value) {
			if (info.kind === "file" && isReclaimFileName(info.name)) {
				await fs.remove(info.path, { force: true }, context);
			}
		}
		// 只读取命名合法的 sidecar 文件，排序保证恢复顺序稳定。
		const sidecarFiles = listed.value
			.filter((info) => info.kind === "file" && isSidecarFileName(info.name))
			.map((info) => info.name)
			.sort();
		// parsedFiles 保存每个文件的原始行；recordByKey 用 (file, seq, ordinal) 建索引。
		const parsedFiles = new Map<string, ParsedFile<SidecarRecord>>();
		const recordByKey = new Map<string, ParsedLine<SidecarRecord>>();
		// 逐个解析 sidecar 文件。
		for (const file of sidecarFiles) {
			const pathResult = await fs.joinPath([directory, file], context);
			if (!pathResult.ok) throw errorFromFile("path join", pathResult.error);
			const parsed = await JsonlStorage.readLines(fs, pathResult.value, file, context, (text, line) =>
				parseSidecarRecord(text, file, line),
			);
			parsedFiles.set(file, parsed);
			// 文件内记录必须按 (seq, ordinal) 严格递增；否则无法可靠截断/确认。
			let previous: SidecarRecord | undefined;
			for (const line of parsed.lines) {
				if (
					previous !== undefined &&
					(line.value.seq < previous.seq ||
						(line.value.seq === previous.seq && line.value.ordinal <= previous.ordinal))
				) {
					throw new JsonlCorruptionError(`Sidecar records are out of order in ${file}`);
				}
				previous = line.value;
				recordByKey.set(sidecarKey(file, line.value.seq, line.value.ordinal), line);
			}
		}

		// 先声明第一遍扫描要收集的三类状态：latest 文档、退役文档、任务最终是否 live。
		const currentOnlyDocuments = new Set<DocumentId>();
		const retiredDocuments = new Set<DocumentId>();
		const finalTaskIsLive = new Map<TaskId, boolean>();
		// 第一遍扫描主标记：统计 latest 文档、退役文档，以及每个任务最终是否仍有 sidecar。
		for (const { value: marker } of main.lines) {
			for (const operation of marker.writes) {
				if (operation.type === "document.create") {
					if (isCurrentOnly(operation.record)) currentOnlyDocuments.add(operation.record.id);
				} else if (operation.type === "document.retire") {
					retiredDocuments.add(operation.id);
				} else if (operation.type === "task") {
					// 内联 task 记录表示任务已终态，最终不再 live。
					finalTaskIsLive.set(operation.value.id, false);
					// task.sidecar 引用表示任务仍非终态，最终 live。
				} else if (operation.type === "task.sidecar") {
					finalTaskIsLive.set(operation.id, true);
				}
			}
		}
		// 退役的 latest 文档集合：这些文档的 sidecar 可以整体回收。
		const retiredCurrentOnlyDocuments = new Set([...retiredDocuments].filter((id) => currentOnlyDocuments.has(id)));

		// 第二遍扫描：找出每个 latest 文档被标记引用的最新 base。
		const latestBases = new Map<DocumentId, SidecarRecord>();
		for (const { value: marker } of main.lines) {
			for (const operation of marker.writes) {
				if (operation.type !== "document.create" && operation.type !== "document.change") continue;
				const id = operation.type === "document.create" ? operation.record.id : operation.id;
				// 只看 latest 文档的 document.create/change；其他文档保留历史。
				if (!currentOnlyDocuments.has(id)) continue;
				// 用标记中的 seq/ordinal 精确取对应 sidecar 行。
				const record = recordByKey.get(
					sidecarKey(sidecarFileName("doc", id), marker.seq, operation.ordinal),
				)?.value;
				// 必须是该文档、类型为 document、内容为 base 的记录；delta 不能作为回收边界。
				if (
					record?.payload.type !== "document" ||
					record.payload.id !== id ||
					record.payload.content.kind !== "base"
				) {
					continue;
				}
				// 保留 (seq, ordinal) 最大的 base；更早的 base/修订可丢弃。
				const previous = latestBases.get(id);
				if (
					previous === undefined ||
					record.seq > previous.seq ||
					(record.seq === previous.seq && record.ordinal > previous.ordinal)
				) {
					latestBases.set(id, record);
				}
			}
		}

		// 判断某条 sidecar 是否早于最新 base；早于它的记录回收时可丢弃。
		const isBeforeLatestBase = (id: DocumentId, seq: Seq, ordinal: number): boolean => {
			const base = latestBases.get(id);
			return base !== undefined && (seq < base.seq || (seq === base.seq && ordinal < base.ordinal));
		};
		// 最终不是 live 的任务即终态任务，其 sidecar 在恢复后删除。
		const terminalTasks = new Set([...finalTaskIsLive].filter(([, live]) => !live).map(([id]) => id));
		// confirmed 记录已被某个主标记引用的 sidecar 键，防止重复确认或误截断。
		const confirmed = new Set<string>();
		// 按主标记顺序重放：每个标记对应一次 memory.prepareCommit(writes, marker.seq).apply()。
		for (const line of main.lines) {
			const marker = line.value;
			// writes 是本标记重放出的 StorageWrite；sidecar 引用会按需展开成完整记录/内容。
			const writes: StorageWrite[] = [];
			for (const operation of marker.writes) {
				switch (operation.type) {
					case "conversation":
					case "entry":
					case "submission":
					case "task":
					case "document.retire":
						writes.push(operation);
						break;
					// 非终态任务引用 sidecar；若任务最终终态，该行是可选的（可能已被回收）。
					case "task.sidecar": {
						const optional = terminalTasks.has(operation.id);
						// confirmRecord 校验键唯一并返回对应行；optional 允许终态任务的 sidecar 缺失。
						const record = JsonlStorage.confirmRecord(
							marker,
							operation.ordinal,
							sidecarFileName("task", operation.id),
							recordByKey,
							confirmed,
							optional,
						);
						// 确认到的任务记录必须与引用匹配；否则不允许继续重放。
						if (record !== undefined) {
							if (record.payload.type !== "task" || record.payload.value.id !== operation.id) {
								throw new JsonlCorruptionError(
									`Confirmed task sidecar data does not match commit ${marker.seq}`,
								);
							}
							// 仍非终态的任务把 sidecar 中的完整记录作为写操作重放。
							if (!optional) writes.push({ type: "task", value: record.payload.value });
						}
						break;
					}
					// 文档创建/变更引用 sidecar；若文档已退役或早于最新 base，该行可能已被回收。
					case "document.create":
					case "document.change": {
						const id = operation.type === "document.create" ? operation.record.id : operation.id;
						// reclaimed 表示这条记录允许缺失；否则缺失就是损坏。
						const reclaimed =
							retiredCurrentOnlyDocuments.has(id) || isBeforeLatestBase(id, marker.seq, operation.ordinal);
						const record = JsonlStorage.confirmRecord(
							marker,
							operation.ordinal,
							sidecarFileName("doc", id),
							recordByKey,
							confirmed,
							reclaimed,
						);
						// 缺失且允许回收时 content 保持 undefined；创建会用空 base 占位，变更则跳过。
						let content: DocumentContent | undefined;
						if (record !== undefined) {
							if (record.payload.type !== "document" || record.payload.id !== id) {
								throw new JsonlCorruptionError(
									`Confirmed document sidecar data does not match commit ${marker.seq}`,
								);
							}
							content = record.payload.content;
						}
						// 创建必须最终得到 base；已回收或缺失时写一个空 base 占位。
						// 这保证内存中的文档记录仍存在，但不会恢复已被回收的历史内容。
						if (operation.type === "document.create") {
							if (content !== undefined && content.kind !== "base") {
								throw new JsonlCorruptionError(
									`Document creation lacks a confirmed base in commit ${marker.seq}`,
								);
							}
							writes.push({
								type: "document.create",
								record: operation.record,
								content: reclaimed || content === undefined ? { kind: "base", version: 1, value: {} } : content,
							});
							// 未回收的变更才重放；已回收的旧 delta 不再需要。
						} else if (!reclaimed && content !== undefined) {
							writes.push({ type: "document.change", id, content });
						}
						break;
					}
				}
			}
			// 用标记中的 seq 重放，保持提交序号与历史一致；任何检查失败都视为已提交状态损坏。
			try {
				memory.prepareCommit(writes, marker.seq).apply();
			} catch (error) {
				throw new JsonlCorruptionError(
					`Invalid committed state at sequence ${marker.seq}`,
					error instanceof Error ? error : undefined,
				);
			}
		}

		// 重放完成后回收 sidecar 文件：未确认的尾部截断，再按规则重写/删除文件。
		const reclamations = new Map<string, string>();
		// 检查每个文件的已确认行是否连续：已确认记录之后不能再出现未确认行。
		for (const [file, parsed] of parsedFiles) {
			let unconfirmedAt: number | undefined;
			for (const line of parsed.lines) {
				const key = sidecarKey(file, line.value.seq, line.value.ordinal);
				if (confirmed.has(key)) {
					if (unconfirmedAt !== undefined) {
						throw new JsonlCorruptionError(`Confirmed record follows an unconfirmed tail in ${file}`);
					}
				} else if (unconfirmedAt === undefined) {
					unconfirmedAt = line.start;
				}
			}
			// 从未确认行的起始字节截断文件；这些行属于撕裂/未提交的写入。
			if (unconfirmedAt !== undefined) {
				const truncated = await fs.truncateFile(parsed.path, unconfirmedAt, context);
				if (!truncated.ok) throw errorFromFile(`tail truncation of ${file}`, truncated.error);
			}

			// 从文件名解析数字 id：doc-<id>.jsonl / task-<id>.jsonl。
			const numericId = Number(file.slice(file.indexOf("-") + 1, -".jsonl".length));
			// confirmedLines 只保留被主标记引用的行。
			const confirmedLines = parsed.lines.filter((line) =>
				confirmed.has(sidecarKey(file, line.value.seq, line.value.ordinal)),
			);
			// retainedLines 决定文件最终保留哪些行；undefined 表示不改。
			let retainedLines: readonly ParsedLine<SidecarRecord>[] | undefined;
			// 终态任务：删除整个 sidecar。
			if (file.startsWith("task-") && terminalTasks.has(idFromNumber<TaskId>(numericId))) {
				retainedLines = [];
				// latest 文档：退役则删除；否则只保留最新 base 及其后的 delta。
			} else if (file.startsWith("doc-")) {
				const documentId = idFromNumber<DocumentId>(numericId);
				if (retiredCurrentOnlyDocuments.has(documentId)) {
					retainedLines = [];
					// 早于最新 base 的修订可丢弃；最新 base 与之后内容保留。
				} else if (latestBases.has(documentId)) {
					retainedLines = confirmedLines.filter(
						(line) => !isBeforeLatestBase(documentId, line.value.seq, line.value.ordinal),
					);
				}
			}
			// 只有当确有行需要丢弃时才计划重写（空文件也算需要删除）。
			if (
				retainedLines !== undefined &&
				(retainedLines.length < confirmedLines.length || retainedLines.length === 0)
			) {
				reclamations.set(file, retainedLines.map((line) => jsonLine(line.value)).join(""));
			}
		}
		// 执行恢复期回收；失败静默，因为这些是维护操作且标记已经持久化。
		await this.reclaimSidecars(reclamations, context);

		// 恢复集合状态：latest 文档 id 与非终态任务 id，供后续提交的回收计划使用。
		for (const id of currentOnlyDocuments) this.currentOnlyDocuments.add(id);
		for (const [id, live] of finalTaskIsLive) {
			if (live) this.liveTaskSidecars.add(id);
		}
	}

	// 确认一条 sidecar 引用：同一键不能被两个标记确认；缺失时只有 optional 才允许。
	// 成功时把键加入 confirmed 并返回记录，供重放使用。
	private static confirmRecord(
		marker: MainMarker,
		ordinal: number,
		file: string,
		recordByKey: ReadonlyMap<string, ParsedLine<SidecarRecord>>,
		confirmed: Set<string>,
		optional: boolean,
	): SidecarRecord | undefined {
		// 重复确认说明两个标记引用同一行，日志语义已损坏。
		const key = sidecarKey(file, marker.seq, ordinal);
		if (confirmed.has(key)) throw new JsonlCorruptionError(`Sidecar record is confirmed more than once`);
		const line = recordByKey.get(key);
		// 行不存在：可回收的引用返回 undefined，否则是损坏。
		if (line === undefined) {
			if (optional) return undefined;
			throw new JsonlCorruptionError(`Missing confirmed sidecar record ${file} at sequence ${marker.seq}`);
		}
		confirmed.add(key);
		return line.value;
	}

	// 读取并解析一个 JSONL 文件：不存在视为空文件；最后一行不完整则截断到最后一个换行。
	// 对每个完整行调用 parse（带行号），并记录起始字节偏移供恢复期截断。
	// 非法 UTF-8 抛 JsonlCorruptionError，不静默替换字符。
	private static async readLines<T>(
		fs: FileSystem,
		path: string,
		name: string,
		context: Context,
		parse: (text: string, line: number) => T,
	): Promise<ParsedFile<T>> {
		// readBinaryFile 返回 Result；not_found 表示新存储，返回空行列表。
		const read = await fs.readBinaryFile(path, context);
		if (!read.ok) {
			if (read.error.code === "not_found") return { path, lines: [] };
			throw errorFromFile(`read of ${name}`, read.error);
		}
		// 以字节数组处理，避免先解码再定位换行；0x0a 是换行。
		const bytes = read.value;
		let completeSize = bytes.length;
		// 末尾不是换行说明最后一行被撕裂；lastIndexOf 找最后一个完整换行，截断其后内容。
		if (completeSize > 0 && bytes[completeSize - 1] !== 0x0a) {
			completeSize = bytes.lastIndexOf(0x0a) + 1;
			const truncated = await fs.truncateFile(path, completeSize, context);
			if (!truncated.ok) throw errorFromFile(`torn-line truncation of ${name}`, truncated.error);
		}
		// lines 保存解析结果；start 是当前行起始字节。
		const lines: ParsedLine<T>[] = [];
		let start = 0;
		let lineNumber = 1;
		// 逐字节找换行；只有完整行才解码和解析。
		for (let end = 0; end < completeSize; end++) {
			if (bytes[end] !== 0x0a) continue;
			let text: string;
			// fatal decoder 在非法 UTF-8 时抛错；包装成损坏错误并保留 cause。
			try {
				text = textDecoder.decode(bytes.subarray(start, end));
			} catch (error) {
				throw new JsonlCorruptionError(
					`Invalid UTF-8 in complete ${name} line ${lineNumber}`,
					error instanceof Error ? error : undefined,
				);
			}
			// 记录值与行起始偏移；下一行从 end+1 开始。
			lines.push({ value: parse(text, lineNumber), start });
			start = end + 1;
			lineNumber++;
		}
		return { path, lines };
	}

	// 拼接目录与文件名；Result 失败时包装成带操作名的 Error。
	private async resolveFile(file: string, context: Context): Promise<string> {
		const path = await this.fs.joinPath([this.directory, file], context);
		if (!path.ok) throw errorFromFile("path join", path.error);
		return path.value;
	}

	// store 访问器先 assertUsable，再返回内存存储。
	private get store(): MemoryStorage {
		this.assertUsable();
		return this.memory;
	}

	// readable 等待正在追加的批次完成；内存虽已应用，但磁盘尚未落盘时不应对外读取。
	// 循环处理 readable 等待期间又开始的新写入。
	/** The state to read once no batch is being appended: memory runs ahead of the file while one is. */
	private async readable(): Promise<MemoryStorage> {
		while (this.writing !== undefined) await this.writing;
		return this.store;
	}

	// 记录第一次毒化原因；后续错误都复用同一个 JsonlStoragePoisonedError。
	private poison(cause: Error): JsonlStoragePoisonedError {
		this.poisonError ??= new JsonlStoragePoisonedError(cause);
		return this.poisonError;
	}

	// 可用性检查：已关闭或已毒化都拒绝所有操作。
	private assertUsable(): void {
		if (this.closed) throw new Error("JsonlStorage is closed");
		if (this.poisonError !== undefined) throw this.poisonError;
	}
}
