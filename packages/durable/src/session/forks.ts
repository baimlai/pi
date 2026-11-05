// 文件导读：Durable 会话分叉时的文档复制计划
//
// 所属包与模块：packages/durable/src/session，Durable（@earendil-works/pi-durable）的 Session 内核。
// 本文件解决一个问题：新会话在某个父条目处分叉时，父会话（及其祖先）当时存在的“无定义文档”需要以
// document.copy 的形式带入子会话。这里只读取元数据并准备复制描述，不复制内容、不提交写入；真正的物化由
// Storage 在 commit 处理 document.copy 时完成。
//
// 上游入口：Transaction.#stageConversation（src/session/transaction.ts）在创建分叉会话时调用
// prepareForkDocumentCopies(storage, parent.conversationId, parent.at, childId, context)，把返回的每项转成
// DocumentEntry（target.kind = "fork-copy"），最终在提交计划里变成 StorageWrite 的 document.copy。
// 下游依赖：Storage.entry(parentConversationId, at, context) 检查分叉条目对父会话可见；Storage.scanDocuments
// 按 scope 和时点分页读取文档元数据；Storage.mintId 为新子文档分配新的 incarnation ID。
// 错误流向：条目不可见时抛普通 Error；两个来源给子会话选中同一逻辑地址时抛 Error；Storage 的读取/mint 错误
// 原样向上拒绝。调用方 Transaction 会把错误当作本次事务失败处理。
//
// 能力清单：
//   - ForkDocumentCopy：导出类型，包含新文档的 DocumentCreate（record）和精确源文档（source: id + at）。
//   - prepareForkDocumentCopies：导出入口，返回该分叉要复制的一组文档描述；顺序为 asOf 轮在前、current 轮在后。
//   - SCAN_PAGE_SIZE（文件私有）：每次 scanDocuments 的页大小 256；内容由 Storage 在提交复制时物化。
//   - ForkPolicy（文件私有）：只允许 "asOf" 或 "current" 两种源选择策略；"initial" 文档不在这里复制。
//   - collectCopies（文件私有）：按 scope/时点分页扫描、过滤 policy、铸造新 ID、登记目标地址并防止地址冲突。
//
// 典型调用（示例）：
//   const copies = await prepareForkDocumentCopies(
//     storage, parentConversationId, atEntryId, childConversationId, context,
//   );
//   // copies 的每项形如 { record: DocumentCreate, source: { id: DocumentId, at: Seq | "current" } }；
//   // 将它们交给事务的 document.copy 写入，而不是在这里调用 Storage.commit。
//
// 建议阅读顺序：先读 ForkDocumentCopy 的字段，分清“新文档身份”与“源文档时点”；再读
// prepareForkDocumentCopies 的两轮收集与错误检查；最后读 collectCopies 的分页、策略过滤和地址去重。
//
// ---------------------------------------------------------------------------
// 为新分叉挑选应复制的已存文档；这里只准备document.copy描述，不复制任务或执行实际写入。
import type { Context } from "@earendil-works/chord/context";
import { addressId } from "../documents.ts";
import type {
	ConversationId,
	Cursor,
	DocumentCopySource,
	DocumentCreate,
	DocumentId,
	DocumentPoint,
	DocumentRecord,
	EntryId,
	Storage,
} from "../types.ts";

// 为什么是 256：scanDocuments 是分页接口，页大小限制单次返回的元数据数量，避免一次读取整个 scope。
// 页大小不是文档内容大小；复制的值由 Storage 在解析 document.copy 时读取源版本并写入新 incarnation。
// 每次最多读取256份元数据；真正文档内容由Storage在提交copy时物化。
const SCAN_PAGE_SIZE = 256;

// `ForkPolicy` 是字面量联合类型：编译期限制取值，运行时只是普通字符串；scan 结果里的 `fork` 字段由存储保证。
// asOf 表示子会话复制源在分叉提交时的历史状态；current 表示复制准备时的当前状态；initial 留给孩子首次访问时初始化。
// 字面量联合只允许两种复制策略；initial表示子会话首次访问时初始化，不在这里复制。
type ForkPolicy = "asOf" | "current";

/** One definition-free document copy to create with a forked conversation. */
export type ForkDocumentCopy = {
	// readonly只禁止通过此类型重新赋值；record描述新子文档的身份与策略。
	readonly record: DocumentCreate;
	// source精确指向源文档incarnation和读取时点，避免以后父文档改变影响副本。
	readonly source: DocumentCopySource;
};

/** Select every persisted conversation document copied by one fork. */
// 输入存储、父/子会话ID、分叉条目at及追踪上下文，返回要随分叉提交的复制命令描述数组。
// 先确认at对父会话可见，再挑at所在会话当时的asOf文档和父会话当前的current文档。
// 会分配新文档ID、读取元数据，但不提交；不可见条目、目标地址冲突或Storage错误会拒绝。
// 示例：在条目8处分叉时，asOf取条目8所在提交的值，current取分叉准备时父会话的当前值。
export async function prepareForkDocumentCopies(
	storage: Storage,
	parentConversationId: ConversationId,
	at: EntryId,
	childConversationId: ConversationId,
	context: Context,
): Promise<readonly ForkDocumentCopy[]> {
	// 带会话ID的重载同时检查祖先链可见性，返回条目与其提交序号。
	const entry = await storage.entry(parentConversationId, at, context);
	// 不可见或不存在不能作为分叉点；这里是运行时业务约束，不是TypeScript类型检查。
	if (entry === undefined) throw new Error(`Entry ${at} is not visible from conversation ${parentConversationId}`);

	// 累积数组由下面两轮扫描填充，Set阻止两来源在子会话占用同一逻辑地址。
	const copies: ForkDocumentCopy[] = [];
	const copiedAddresses = new Set<string>();
	// 第一轮按条目的实际所属会话及commitSeq读取历史asOf文档；条目可能来自父会话的祖先。
	await collectCopies(
		storage,
		{ kind: "conversation", conversationId: entry.entry.conversationId },
		entry.commitSeq,
		"asOf",
		childConversationId,
		copies,
		copiedAddresses,
		context,
	);
	// 第二轮从直接父会话的当前状态挑current文档，与历史轮共用目标地址去重集合。
	await collectCopies(
		storage,
		{ kind: "conversation", conversationId: parentConversationId },
		"current",
		"current",
		childConversationId,
		copies,
		copiedAddresses,
		context,
	);
	// readonly返回类型限制调用方的TS数组操作，并不冻结数组或进行实际Storage提交。
	return copies;
}

// 分页扫描一个会话scope，在指定时点只选匹配policy的文档，向copies与copiedAddresses追加。
// Extract把DocumentScope联合收窄为conversation成员，是编译时约束；每个入选文档会mint一个新ID。
// 例：同一family的key="x"已在前一轮入选，另一源再选中该地址即抛错，避免静默覆盖。
async function collectCopies(
	storage: Storage,
	scope: Extract<DocumentRecord["scope"], { readonly kind: "conversation" }>,
	at: DocumentPoint,
	policy: ForkPolicy,
	childConversationId: ConversationId,
	copies: ForkDocumentCopy[],
	copiedAddresses: Set<string>,
	context: Context,
): Promise<void> {
	// 首轮undefined表示从头扫描，后续回传后端给出的不透明游标。
	let cursor: Cursor | undefined;
	// do/while保证即使没有初始cursor也至少执行一次分页查询。
	do {
		// 查询元数据而非完整内容；at可为提交序号或"current"。
		const page = await storage.scanDocuments({ scope, at }, SCAN_PAGE_SIZE, cursor, context);
		// 依页内顺序处理候选源，每个源只会生成一份描述。
		for (const source of page.items) {
			// 仅会话文档且策略精确匹配才复制，initial和另一轮的策略直接跳过。
			if (source.scope.kind !== "conversation" || source.fork !== policy) continue;
			// DocumentId的泛型品牌仅防止TS混用ID；存储实际分配递增数字。
			const id = await storage.mintId<DocumentId>();
			// 新身份保留kind/key，scope改为子会话；key不存在时不创建值为undefined的字段。
			const identity = {
				id,
				kind: source.kind,
				...(source.key === undefined ? {} : { key: source.key }),
				scope: { kind: "conversation" as const, conversationId: childConversationId },
			};
			// as const保留kind的字面量类型；下面按history构造符合DocumentCreate联合的两种记录。
			const record: DocumentCreate =
				source.history === "latest"
					? { ...identity, history: "latest", fork: source.fork }
					: { ...identity, history: "rewindable", fork: source.fork };
			// addressId使用kind/scope/key组成逻辑地址，新incarnation ID不属于该地址。
			const copyAddress = addressId(record);
			// 同一子地址被两轮/多个源选中属于冲突，不能用数组顺序决定谁胜出。
			if (copiedAddresses.has(copyAddress)) {
				// 只为错误消息构造单例kind或family/key名称。
				const member = record.key === undefined ? record.kind : `${record.kind}/${record.key}`;
				throw new Error(`Fork selects multiple source documents for ${member}`);
			}
			// 先登记地址，再将新记录与精确源时点加入调用方数组。
			copiedAddresses.add(copyAddress);
			copies.push({ record, source: { id: source.id, at } });
		}
		// 游标完全由Storage管理；有下一页就继续，没有则结束并隐式返回undefined。
		cursor = page.next;
	} while (cursor !== undefined);
}
