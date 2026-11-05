// 默认凭证只保存在进程内，Models 可换成应用自己的持久后端；取消辅助把“等结果”和“任务完成”分开。
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
// 凭证/元数据/存储契约均只导入类型，运行时不生成接口对象。
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "./types.ts";

/**
 * Default in-memory credential store. Apps inject persistent stores.
 * Keyed by `Provider.id`, one credential per provider; see `CredentialStore`.
 * Writes are serialized per provider through a promise chain.
 */
// 实现 CredentialStore 契约；本类只在当前进程串行，不提供跨进程锁或落盘。
export class InMemoryCredentialStore implements CredentialStore {
	// 按 provider id 保存原凭证对象；private 是 TS 编译期访问限制，不是 # 字段运行时隔离。
	private credentials = new Map<string, Credential>();
	// 每个供应商一条尾 Promise；unknown 允许不同任务返回不同类型，不需要 any。
	private chains = new Map<string, Promise<unknown>>();

	/** Serialize tasks per provider id without releasing the chain before active work settles. */
	/**
	 * 把任务加入该 provider 的写入链，返回任务结果 Promise，T 保留各调用自己的结果类型。
	 * 同供应商等前一任务结束才运行；旧失败不堵后续。调用者取消可先拒绝等待，实际任务仍被链观察；例：A 刷新未完成时 B 删除先排队，其他供应商不受这条链限制。
	 */
	private enqueue<T>(providerId: string, task: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
		// 使用传入信号或创建未取消信号，后续路径始终有 AbortSignal。
		const signal = operationSignal(options?.signal);
		// 同供应商前一尾部缺省为已完成 Promise；?? 不依真假值选择。
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		// 异步立即调用函数建立本次任务 Promise，真正任务还要等待前项。
		const queued = (async () => {
			// 观察前一失败但继续排队，不让链永久处于 rejected 而拒绝后续工作。
			await previous.catch(() => {});
			// 轮到自己时先检查取消，排队期间已取消就不再执行 task。
			signal.throwIfAborted();
			// 返回 task 的 Promise，async 会采纳其结算，链会等它实际完成。
			return task();
		})();
		// 尾部吞掉任务拒绝仅用于排队/清理；queued 本身仍会把错误交调用者。
		const tail = queued.catch(() => {});
		// 记录最新尾部，下一次同供应商操作从这里接着等。
		this.chains.set(providerId, tail);
		// void 明确不等待清理结果；tail 已捕获拒绝。
		void tail.then(() => {
			// 只删仍等于本次 tail 的项，旧任务结束不能误删后来排入的新尾部。
			if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
		});
		// 取消可使外层先拒绝；不会因此把尚未完成的底层工作从串行链提前移除。
		return raceWithAbortSignal(queued, signal);
	}

	/**
	 * 读取此刻内存里的凭证，返回原对象或 undefined；已取消则拒绝，不读文件、不等待正在排队的写任务。
	 * 例：modify 尚在 await 刷新时 read 仍可能拿到旧 token；返回值没有深复制或冻结。
	 */
	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		// 读取前检查调用者信号；async 方法中的抛错转为 Promise 拒绝。
		options?.signal?.throwIfAborted();
		// Map.get 返回原凭证引用；不存在就是 undefined，没有自动刷新。
		return this.credentials.get(providerId);
	}

	/**
	 * 枚举当前内存的 provider/type 元数据，返回新数组，不暴露 key/access/refresh 字段。
	 * 取消时拒绝，不等待待完成写入；例：某供应商只有 {providerId:"demo",type:"oauth"}，只读返回类型是编译期限制。
	 */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		// 枚举前同样先检查取消。
		options?.signal?.throwIfAborted();
		// 展开 Map 成键值对，解构后仅复制 providerId 与类型，形成不含秘密的新描述对象。
		return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	/**
	 * 串行读取当前凭证、等待 fn、检查取消，再按返回值更新，最终返回写后凭证或原值。
	 * fn 可异步且抛错；undefined 表示不改，删除需另调用 delete。回调收到原对象，原地改它不受此包装器回滚；例：返回新 OAuth 对象替换轮换 token。
	 */
	modify(
		// 目标供应商键，不是具体模型 id。
		providerId: string,
		// fn 接收最新凭证，异步返回新值或 undefined；函数类型本身不保证不产生额外副作用。
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		// 可选取消选项；不另行复制信号。
		options?: AuthOperationOptions,
		// Promise 的最终值仍可能缺省，代表本来就没有凭证且没写入。
	): Promise<Credential | undefined> {
		// 借共同队列执行读改写，避免这里另写第二套锁逻辑。
		return this.enqueue(
			// 只与相同 providerId 的任务串行。
			providerId,
			// 真正取得执行次序后才运行这段异步闭包。
			async () => {
				// 在队列轮到自己时读取，而不是排队时捕获过时凭证。
				const current = this.credentials.get(providerId);
				// 等待使用者转换，回调抛错会让本任务失败，下面 set 不运行。
				const next = await fn(current);
				// 回调完成后再检查取消；取消可阻止这次 set，但不撤销回调自身已发生的副作用。
				options?.signal?.throwIfAborted();
				// 只有明确新值才写 Map；undefined 不会清除已存凭证。
				if (next !== undefined) this.credentials.set(providerId, next);
				// 有新值返回它，否则返回之前 current；引用没有深复制。
				return next ?? current;
			},
			// 把同一取消选项交排队入口，既覆盖等锁也覆盖外层等结果。
			options,
		);
	}

	/**
	 * 把指定供应商的删除排入同一写链，返回 Promise<void>；不存在也成功，无磁盘操作。
	 * 例：等已开始的同供应商 modify 结束后再移除条目，避免普通并行删除插进刷新中间；调用者取消等待与任务链结束不是同一时刻。
	 */
	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		// 删除也排进同一家供应商链，不能绕过进行中的修改。
		return this.enqueue(
			// 同一 providerId 与 modify 共用互斥顺序。
			providerId,
			// 闭包被调度时才执行删除，async 成功没有返回值。
			async () => {
				// Map.delete 忽略其布尔返回值，缺条目也不当错误。
				this.credentials.delete(providerId);
			},
			// 排队等待沿用调用者取消选项。
			options,
		);
	}
}
