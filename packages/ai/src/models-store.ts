// 定义模型目录缓存的接口，并提供内存实现；提供商刷新后可把目录及远端校验信息交给存储。
// type 导入只供编译期使用；AnyModel 是聊天、图片、分类等模型描述的联合类型。
import type { AnyModel } from "./types.ts";

/** 一家提供商的一份目录缓存，包含模型列表及下次检查远端是否更新所需的信息。 */
export interface ModelsStoreEntry {
	/** Persisted models of every type. */
	// readonly 阻止通过此类型增删数组元素，不会在运行时深冻结各个模型对象。
	models: readonly AnyModel[];
	/** Unix timestamp from the remote catalog's Last-Modified header. */
	// 远端目录自报的修改时间；? 表示服务器可能没提供该头，不是本地文件修改时间。
	lastModified?: number;
	/** Unix timestamp of the last completed remote check. */
	// 最近检查完成的 Unix 时间戳；“检查过”不一定代表内容有更新。
	checkedAt?: number;
	/**
	 * Opaque validator from the remote catalog's ETag header, stored verbatim
	 * (quotes included) and echoed back as If-None-Match.
	 */
	// ETag 要原样保存，包括引号；下次放进 If-None-Match，让服务器判断是否可复用目录。
	etag?: string;
}

/** 存储操作的可选配置；signal 允许调用方取消某次读、写或删除。 */
export interface ModelsStoreOperationOptions {
	// 信号本身只表达取消请求，停止位置由具体存储实现决定。
	signal?: AbortSignal;
}

/** Persistent model catalogs keyed by provider ID. */
/** 按提供商 ID 存取整份目录；例如 read("openai")，不存在时返回 undefined。 */
export interface ModelsStore {
	/** 异步读取目录；返回值包含 models 及可选远端版本信息。 */
	read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined>;
	/** 替换这一提供商的目录；Promise<void> 只表示完成或失败，没有业务返回值。 */
	write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void>;
	/** 删除这一提供商的目录缓存；不负责删除认证凭证或聊天记录。 */
	delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void>;
}

/** 仅内存中的 ModelsStore；读写都深复制，调用方修改对象不会连带改掉内部缓存。 */
export class InMemoryModelsStore implements ModelsStore {
	// implements 要求满足接口；private 隐藏字段，readonly 固定 Map 引用，但仍允许 set/delete。
	private readonly entries = new Map<string, ModelsStoreEntry>();

	/** 读取一家的目录副本；例如从未 write 的提供商会得到 undefined。 */
	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		// ?. 允许省略选项或信号；若已取消就在读取前抛出取消原因。
		options?.signal?.throwIfAborted();
		// Map.get 未命中返回 undefined；不会自动插入空目录。
		const entry = this.entries.get(providerId);
		// 三元表达式二选一；structuredClone 深复制，async 会把返回值包装为 Promise。
		return entry ? structuredClone(entry) : undefined;
	}

	/** 保存一份目录副本，同 ID 再写会替换旧缓存；不写磁盘。 */
	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		// 即使没有慢 I/O，也遵守调用者已取消的操作不继续执行这一约定。
		options?.signal?.throwIfAborted();
		// 写时复制，避免调用者之后修改传入 entry 影响存储。
		this.entries.set(providerId, structuredClone(entry));
	}

	/** 删除缓存条目；即使键原来不存在也正常完成。 */
	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		// void 类型表示没有成功值，但失败仍可以通过 Promise 拒绝表达。
		options?.signal?.throwIfAborted();
		// 不用 Map.delete 的布尔返回值，因为接口只要求完成删除。
		this.entries.delete(providerId);
	}
}
