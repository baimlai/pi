// 文件导读
// 所属：packages/durable 的错误类型与消息格式化模块，被 session/、harness/、storage/ 和测试共同引用。
// 作用：统一 Session 生命周期、事务读写顺序、只读模式、提交准入与非法存储请求的错误类别，让调用方按 instanceof 区分。
// 职责边界：只构造错误或格式化消息；不关闭 Session、不回滚事务、不修改存储。状态转换由抛出方完成。
// 上游/下游：session/writer.ts 与 session/session.ts 抛 SessionFailed；session/session.ts 抛 ReadOnlySession；
// session/transaction.ts、harness/submissions.ts 抛 ReadAfterWrite；harness/submissions.ts 抛 ConversationBusy/ConversationIdle；
// storage/*.ts 抛 StorageRequestError。调用方（例如 harness-read-only.test.ts、store-storage.test.ts）用 instanceof 断言。
// 能力清单：
// - errorMessage(error: unknown): string：安全格式化任意抛出值；格式化过程本身不会抛错。
// - ReadAfterWrite：同一事务先写表、后读表或准入提交时抛出的顺序错误。
// - StorageRequestError：Storage 读取请求非法（未知会话、外来/损坏游标、未保留的历史），没有持久化影响；
//   只有该次读取失败，Session 继续可用，但从 commit() 抛出时仍按致命错误处理。
// - SessionFailed：Session 已失败，后续操作都拒绝；cause 是首个错误，重开 Session 才能恢复。
// - ReadOnlySession：只读 Harness 拒绝写提交或会启动任务的操作，读取仍可用。
// - ConversationBusy / ConversationIdle：whenBusy/whenIdle 为 "reject" 时的提交准入拒绝，携带会话 ID。
// 典型流程：Storage 方法抛错 → Session 记录首个失败并关闭 → 之后的调用抛 SessionFailed；
// 普通非法读取只抛 StorageRequestError，不会杀死 Session。
// 示例：try { await conversation.submit(draft, context); } catch (error) {
//   if (error instanceof ConversationBusy) console.log(error.conversationId);
// }
// 阅读顺序：先 errorMessage，再按发生阶段读 ReadAfterWrite → StorageRequestError → SessionFailed → ReadOnlySession → 两个准入错误。
import type { ConversationId } from "./types.ts";

// 把任意抛出值转成字符串，保证“格式化错误”不会二次失败。
// 输入：error 类型是 unknown，因为 JS 可以 throw 任何值；输出：非空说明字符串（Error 时取 message）。
// 副作用：无；错误路径：String() 可能因自定义转换抛错，此时退回 Object.prototype.toString。
// 注意：最后一个兜底没有再包 try/catch，带恶意 Symbol.toStringTag getter 的值仍可能让这里抛错。
// 例子：errorMessage(new Error("boom")) === "boom"；errorMessage(42) === "42"。
/**
 * The message of a thrown value, without throwing itself: `String()` throws for values such as `Object.create(null)`,
 * and code that formats an error must not fail for the value it formats.
 */
export function errorMessage(error: unknown): string {
	// unknown 允许任意抛出值；instanceof 收窄后才读取 Error.message。
	if (error instanceof Error) return error.message;
	// 普通值先按 String 转换；自定义转换也可能抛错，因此仅包住这个转换步骤。
	try {
		// 例如抛出数字 42 时返回 "42"，不重新抛出原值。
		return String(error);
	} catch {
		// 转换失败则调用对象标签方法，不调用该值自己的 toString 方法。
		// 这里没有再包一层 catch；恶意 Symbol.toStringTag getter 等仍可能让这个最后兜底抛错。
		return Object.prototype.toString.call(error);
	}
}

/**
 * A transaction read a table after its first table write, or admitted a submission (`submit(tx, draft)`) after it. Read
 * every required row, and admit, before writing.
 */
// 事务顺序错误。
// 输入：operation 是触发读取/准入的调用名（如 "Tx.task()"）；输出：带该名称的 Error；副作用：无。
// 抛出方：session/transaction.ts 在首次表写后调用任何表读取方法时抛出；harness/submissions.ts 在表写后调用 submit(tx, draft) 时抛出。
// 关键规则：先把需要的行读完、把提交准入做完，再做表写；Documents 的读写不受这条规则限制。
// 例子：await tx.appendEntry(...); await tx.task(id) 会抛 ReadAfterWrite("Tx.task()")。
export class ReadAfterWrite extends Error {
	/** `operation` names the call, such as `Tx.task()`. */
	// 输入调用名称，生成顺序错误；例 new ReadAfterWrite("Tx.task()")。只构造错误，不自行回滚。
	constructor(operation: string) {
		// super 初始化标准 Error.message，类继承要求先调用它才能使用 this。
		super(`${operation} cannot read tables after the first table write`);
		// name 让日志显示具体错误类别；抛出与处理由调用者完成。
		this.name = "ReadAfterWrite";
	}
}

/**
 * A Storage read rejected an invalid request, such as an unknown conversation or a cursor from another scan, with no
 * durable effect. Unlike any other error a Storage throws, it fails only that read, not the Session; from `commit()` it is
 * fatal like any other.
 */
// 非法存储读取请求。
// 输入：说明文本；输出：带 name="StorageRequestError" 的 Error；副作用：无。
// 使用边界：由 Storage 实现（memory/indexeddb/sqlite/store 的扫描与文档读取）抛出，例如未知会话、格式错误或不属于本次扫描的游标、
// 不保留历史的文档点。类本身不判断请求是否合法，也不阻止持久化；抛出方必须保证该请求尚未产生任何持久化影响。
// 对 Session 的含义：普通读取路径只拒绝这一次调用，Session 仍可用；如果从 Storage.commit() 抛出，则和其他错误一样致命。
// 例子：new StorageRequestError("Unknown conversation: 7") 只描述请求问题，不关闭任何东西。
export class StorageRequestError extends Error {
	// 把无持久化影响的非法读取说明包装成专用错误；例错误游标，Session 读路径据此只拒绝该次调用。
	// 本构造器只设置消息和名称，不判断请求，也不决定 Session 生死；commit 路径仍把它视为致命错误。
	constructor(message: string) {
		// 将原说明交给标准 Error 保存。
		super(message);
		// 保留可识别的错误名称，便于打印与诊断。
		this.name = "StorageRequestError";
	}
}

/**
 * The Session failed, so nothing runs or commits any more. It fails when a Storage method throws, a commit cannot be
 * adopted, or the Harness's own bookkeeping throws (a scheduler commit, an internal commit listener, a registry whose
 * `snapshot()` throws). `cause` is that first error. Reopen the Session; reopening recovers from what was committed.
 */
// Session 终止错误。
// 输入：cause 是首次故障的任意抛出值；输出：message 固定说明需关闭并重开，cause 保存在 Error options 中；副作用：无。
// 触发源：Storage 方法抛错、commit 无法被采纳、Harness 自身的记账失败（scheduler 提交、内部 commit 监听器、snapshot 抛错的注册表）。
// 后续行为：Session 不再运行或提交，后续 API 调用以同类错误拒绝；重开 Session 会从已提交状态恢复。
// 本构造器不执行关闭或重开；它只让调用方看到“首个错误是什么”。例子：new SessionFailed(storageError)。
export class SessionFailed extends Error {
	// 输入首次故障的任意抛出值，返回携带 cause 的错误；例 new SessionFailed(storageError)。
	// 不会在此关闭/重开 Session；调用处负责状态变化，后续 API 用此错误解释为何拒绝服务。
	constructor(cause: unknown) {
		// Error options 的 cause 保存原始值，而不是只保存其字符串说明。
		super("Session failed after a storage error; close and reopen it", { cause });
		// 修改标准 Error 默认的名称。
		this.name = "SessionFailed";
	}
}

/**
 * The Harness was opened read-only (`HarnessOptions.readOnly`): a commit with writes, or a call that would run tasks, was
 * refused. Nothing was written, and the Harness stays usable for reads.
 */
// 只读 Harness 的拒绝错误。
// 输入：what 是被拒绝操作的名称；输出：message 形如 "Read-only Harness: <what> refused"；副作用：无。
// 触发点：session/session.ts 拒绝带写入的 commit；harness/scheduler.ts 拒绝 run/resume 等会启动任务的操作。
// 保证范围：被拒绝的操作不会写入；Harness 仍可用于读取。它不代表存储只读或 Session 已损坏。
// 例子：new ReadOnlySession("a commit with writes")；调用方用 instanceof 区分只读限制与真正的存储故障。
export class ReadOnlySession extends Error {
	// 输入被拒绝操作的名称并构造错误；例 new ReadOnlySession("resume")，不会执行该操作或改会话状态。
	constructor(what: string) {
		// 模板字符串把操作名加入错误消息。
		super(`Read-only Harness: ${what} refused`);
		// 独立名称让宿主区分只读限制与存储故障。
		this.name = "ReadOnlySession";
	}
}

/** A submission reached a busy conversation and was not admitted. */
// 提交到达忙碌会话且未被准入。
// 输入：conversationId；输出：带消息与只读 conversationId 字段的 Error；副作用：无。
// 抛出方：harness/submissions.ts 在 whenBusy:"reject" 的 input、或永远不排队的 continue 遇到忙碌会话时抛出。
// 本类不检测忙碌状态、不撤销提交；抛出前准入逻辑必须保证没有写入。例子：catch 后可直接读取 error.conversationId 重试。
export class ConversationBusy extends Error {
	// readonly 只约束 TypeScript 赋值；会话 ID 的品牌也在运行时擦除。
	readonly conversationId: ConversationId;

	// 输入忙碌会话 ID，保存消息和可程序读取的 ID；例拒绝 busy 策略提交，不在这里检测或清除忙状态。
	constructor(conversationId: ConversationId) {
		// 先初始化父类消息，之后才能访问 this。
		super(`Conversation ${conversationId} is busy`);
		// 名称标明这是提交准入条件失败。
		this.name = "ConversationBusy";
		// 附上原 ID，调用者无需解析消息文本。
		this.conversationId = conversationId;
	}
}

/** An input with `whenIdle: "reject"` reached an idle conversation and was not admitted. */
// 提交到达空闲会话且未被准入。
// 输入：conversationId；输出：带消息与只读 conversationId 字段的 Error；副作用：无。
// 触发条件：input 的 whenIdle:"reject" 且会话空闲；忙碌检查与 whenBusy 相互独立。
// 本类不改变会话状态，也不写入；例子：在需要“仅当忙碌时补充输入”的场景捕获它并放弃提交。
export class ConversationIdle extends Error {
	// 保存遭拒提交所在会话，开发时不允许在构造完成后重赋值。
	readonly conversationId: ConversationId;

	// 输入空闲会话 ID，构造 whenIdle:"reject" 的拒绝信息；只创建错误，例提交控制动作时会话已空闲。
	constructor(conversationId: ConversationId) {
		// 将编号渲染为诊断消息。
		super(`Conversation ${conversationId} is idle`);
		// 与 ConversationBusy 对应，但表示相反的准入条件。
		this.name = "ConversationIdle";
		// 同时保留类型化编号供上层处理。
		this.conversationId = conversationId;
	}
}
