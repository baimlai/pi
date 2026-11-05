// 在持久凭证存储上覆盖一层本进程临时 API key，供 ModelRuntime 使用；覆盖值不会自动写进 auth.json。
// 这些都是接口类型，运行时擦除；实际读写由传入的 store 执行。
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** Async credential store overlay for non-persistent runtime API keys. */
export class RuntimeCredentials implements CredentialStore {
	// 底层存储可以是文件或内存实现，本类只依赖 CredentialStore 契约。
	private readonly store: CredentialStore;
	// Map 按 providerId 保存临时 key；readonly 固定 Map 引用，但仍能 set/delete 内容。
	private readonly overrides = new Map<string, string>();

	/** 保存底层凭证存储引用，不读取文件、不请求认证；例：new RuntimeCredentials(AuthStorage.inMemory())。 */
	constructor(store: CredentialStore) {
		// 显式字段赋值符合仓库的可擦除 TypeScript 风格，没有使用构造器参数属性。
		this.store = store;
	}

	/** 设置本进程的供应商临时 key；后续 read 优先采用非空覆盖值，已有 OAuth/文件凭证保持原样。 */
	setRuntimeApiKey(providerId: string, apiKey: string): void {
		// 同一供应商重复 set 会替换旧覆盖，不累积多个 key。
		this.overrides.set(providerId, apiKey);
	}

	/** 移除临时覆盖，使后续读取回到底层存储；不删除 auth.json 中原来的凭证。 */
	removeRuntimeApiKey(providerId: string): void {
		// Map.delete 对不存在的名字也可调用；不执行持久删除。
		this.overrides.delete(providerId);
	}

	/** 查询是否登记过临时覆盖项；has 检查键存在性，因此即使值为空字符串也会返回 true。 */
	hasRuntimeApiKey(providerId: string): boolean {
		// 它与下面 read 按覆盖值真假选择的规则不同，不能把 has=true 当成 key 一定非空。
		return this.overrides.has(providerId);
	}

	/**
	 * 异步读取一个供应商凭证：先响应取消，再查临时 key，非空则返回 api_key，否则交给底层存储。
	 * 例：设置临时 key 后不触碰磁盘即可用于本进程请求；空字符串覆盖会回退到底层。
	 */
	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		// 可选链允许调用方不传取消信号；已取消时立即抛出该信号的原因。
		options?.signal?.throwIfAborted();
		// 不在此打印 key，只有认证调用方取得返回值。
		const override = this.overrides.get(providerId);
		// async 会把直接对象与底层 Promise 统一为 Promise<Credential | undefined>。
		return override ? { type: "api_key", key: override } : this.store.read(providerId, options);
	}

	/**
	 * 返回凭证元信息，不返回秘密值；先读底层，再把临时覆盖的供应商类型标为 api_key。
	 * 例：底层 openai 是 oauth，但存在临时 key 时，列表里该 providerId 只出现一次且类型为 api_key。
	 */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		// 用 Map 按 providerId 去重，并保留底层条目的顺序。
		const entries = new Map((await this.store.list(options)).map((entry) => [entry.providerId, entry]));
		// 等待底层期间也可能取消，返回列表前再确认。
		options?.signal?.throwIfAborted();
		// 遍历临时覆盖的键，不把真实 key 写进列表结果。
		for (const providerId of this.overrides.keys()) {
			// 覆盖同名条目或追加新供应商；这里只携带类型。
			entries.set(providerId, { providerId, type: "api_key" });
		}
		// ... 展开 Map 的值迭代器成为新数组；readonly 是返回类型限制，不执行 Object.freeze。
		return [...entries.values()];
	}

	/** 将凭证变换交给底层存储，临时覆盖仍保留；fn 接旧值异步返回新值，锁/持久化语义由 store 提供。 */
	modify(
		// 要修改的底层供应商记录。
		providerId: string,
		// 回调拿到的 current 可能不存在；本层只转发，不自行调用或改写结果。
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		// 可选的操作取消等配置。
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		// 返回底层 Promise，使错误和返回凭证按原契约传播。
		return this.store.modify(providerId, fn, options);
	}

	/** 先删除底层凭证，成功后清除本进程覆盖；底层失败会抛出，覆盖不会提前丢失。 */
	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		// 调用前已取消时，不开始底层删除。
		options?.signal?.throwIfAborted();
		// 等待底层删除真正完成，不把“开始删除”误作“已经删除”。
		await this.store.delete(providerId, options);
		// 持久删除成功后才移除运行时覆盖。
		this.overrides.delete(providerId);
	}
}
