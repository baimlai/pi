// 保存远端刷新的模型目录。它缓存“某个提供商有哪些模型”，不负责保存聊天记录或 API 密钥。
import { join } from "node:path";
// import type 只引入类型，执行 JavaScript 时不会加载这些名字。
import type { ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "@earendil-works/pi-ai";
// 配置目录可能来自环境变量或安装方式，因此通过统一入口获取。
import { getAgentDir } from "../config.ts";
// 让某个调用者可以取消等待，同时观察原来的异步任务，避免遗漏拒绝结果。
import { raceWithAbortSignal } from "../utils/abort.ts";
// 文件版本取自文件系统元数据；路径归一化处理 ~ 等写法。
import { getFileRevision, normalizePath } from "../utils/paths.ts";
// 部分文本文件开头有 BOM 标记，需要去掉后再交给 JSON.parse。
import { stripBom } from "../utils/text.ts";
// 复用的是“给 JSON 文件加锁”的底层实现；这里写入的依然是模型目录，不是认证数据。
import { type AuthStorageBackend, FileAuthStorageBackend } from "./auth-storage.ts";

// Record<string, T> 表示按字符串查找 T 的字典，例如 { openai: 某份模型目录 }。
type StoredModels = Record<string, ModelsStoreEntry>;

// 多个读取请求可以等待同一次文件读取。计数记录还有几个人在等，不是文件中有多少模型。
type ModelsFileReload = {
	// 控制这一轮共享读取；只有最后一个等待者退出，才尝试取消它。
	controller: AbortController;
	// Promise<T> 表示将来得到 T，或者以错误结束；不是立即拿到数据。
	promise: Promise<StoredModels>;
	// 例如 A、B 同时读取时是 2，A 取消后是 1，B 仍可以继续等。
	readers: number;
};

// 一个文件对应的内存缓存：已解析的数据、对应文件版本、正在进行的读取。
type ModelsFileReadState = {
	// 按提供商保存的目录快照，最初是空对象。
	data: StoredModels;
	// ? 表示可以不存在；还没有确认文件版本时不能用缓存直接返回。
	revision?: string;
	// 没有正在进行的读取时是 undefined。
	reload?: ModelsFileReload;
};

// Optimize the common path without retaining an unbounded set of custom paths.
// 只记住第一个实例的路径及状态；同路径实例共享它，其他路径各自缓存，避免永久记住无限多条路径。
let sharedModelsFileReadState: { path: string; readState: ModelsFileReadState } | undefined;

/** 仅在内存中保存目录；适合不需要跨进程复用缓存的调用方，进程结束后内容消失。 */
export class InMemoryCodingAgentModelsStore implements ModelsStore {
	// implements 要求满足 ModelsStore 接口；private 限制外部访问，readonly 禁止换掉这个 Map，但仍可增删条目。
	private readonly entries = new Map<string, ModelsStoreEntry>();

	/** 读一个提供商的目录副本；例如 read("openai")，未写入过就得到 undefined。 */
	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		// ?. 只在该值存在时继续访问；已取消则抛错，避免继续这次操作。
		options?.signal?.throwIfAborted();
		// Map.get 找不到键时返回 undefined，不会自动生成条目。
		const entry = this.entries.get(providerId);
		// structuredClone 深复制目录，调用方修改返回值不会改到缓存；三元表达式按条件二选一。
		return entry ? structuredClone(entry) : undefined;
	}

	/** 保存整个提供商目录的副本；同一 providerId 再写一次会替换旧条目。 */
	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		// 虽然没有文件 I/O，也遵守接口的取消约定。
		options?.signal?.throwIfAborted();
		// 写入时也复制：随后修改调用方传进来的 entry，不会间接改掉缓存。
		this.entries.set(providerId, structuredClone(entry));
	}

	/** 删除一个提供商的目录；删除不存在的键也正常结束。 */
	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		// Promise<void> 表示只关心完成或失败，没有业务返回值。
		options?.signal?.throwIfAborted();
		// 这里只移除模型目录，不会删除这个提供商的登录凭证。
		this.entries.delete(providerId);
	}
}

/** Locked JSON-backed storage for dynamically refreshed provider catalogs. */
/**
 * 用带锁 JSON 文件保存目录：读取可复用缓存，写入在锁内重新读取后只改一个提供商。
 * 例：const store = new FileModelsStore("/tmp/demo-models.json");
 * await store.write("demo", { models: [] }); 保存空目录，await store.read("demo") 可读回它。
 * 两个读者同时发现版本变动时共享一次读取；其中一人取消，另一人仍能继续等。
 */
export class FileModelsStore implements ModelsStore {
	// 统一封装文件读取、加锁和写入；该接口也能由其他存储后端实现。
	private readonly storage: AuthStorageBackend;
	// 归一化后的文件位置，同时用于共享缓存和查询文件版本。
	private readonly path: string;
	// readonly 限制重新赋值，readState.data 等内部字段仍然可以更新。
	private readonly readState: ModelsFileReadState;

	/** 默认使用配置目录下的 models-store.json；传自定义路径可隔离不同目录缓存。 */
	constructor(path: string = join(getAgentDir(), "models-store.json")) {
		// 默认参数只有在省略参数或传 undefined 时使用；normalizePath 不等于无条件转成绝对路径。
		this.path = normalizePath(path);
		// 文件后端名字含 Auth，但复用的是加锁机制，不会去改默认 auth.json。
		this.storage = new FileAuthStorageBackend(this.path);
		// 同路径复用第一次创建的状态；不同路径从空缓存开始。
		this.readState =
			sharedModelsFileReadState?.path === this.path ? sharedModelsFileReadState.readState : { data: {} };
		// 只登记一次，不用一个不断增长的全局 Map 保存所有自定义路径。
		if (!sharedModelsFileReadState) {
			// { path: ..., readState: ... } 是对象字面量，保存路径与状态的对应关系。
			sharedModelsFileReadState = { path: this.path, readState: this.readState };
		}
	}

	/** 将文件文本转成目录字典；空文件当作空目录，JSON 格式错误会抛出。 */
	private parse(content: string | undefined): StoredModels {
		// as 是编译期类型断言，不会检查 JSON 的字段结构；这里没有运行时 schema 校验。
		return content ? (JSON.parse(stripBom(content)) as StoredModels) : {};
	}

	/** 同时更新数据与版本；省略版本表示下次读取还需要重新核对文件。 */
	private updateReadState(readState: ModelsFileReadState, data: StoredModels, revision?: string): void {
		// 修改传入状态对象，所以共享这一对象的实例能看到同一份新目录。
		readState.data = data;
		// 写 undefined 会清除旧版本，避免把新数据错误地标为旧文件版本。
		readState.revision = revision;
	}

	/** 拿到文件锁后读取、解析、记录版本；这里只读，不要求后端写回文件。 */
	private reloadFromStorage(
		// 将状态作为参数传入，明确这轮读取最终更新哪份缓存。
		readState: ModelsFileReadState,
		// options 中的 signal 也会传给等待文件锁的过程。
		options?: ModelsStoreOperationOptions,
	): Promise<StoredModels> {
		// async 回调即使没有 await，也会返回 Promise，满足异步后端接口。
		return this.storage.withLockAsync(async (content) => {
			// 必须读锁内拿到的文本，不能用旧内存副本替代。
			const data = this.parse(content);
			// 版本由 dev/ino/大小/时间等元数据组成，不是对文件内容做哈希。
			this.updateReadState(readState, data, getFileRevision(this.path));
			// 后端协议：result 返回给调用者；没有 next，回调不请求重写全文，但后端首次读取仍可能先创建目录和 {} 文件。
			return { result: data };
		}, options);
	}

	/** 先看文件版本，再合并并发读取；某一位调用者取消，不会中断仍有人等待的共享读取。 */
	private async readLatest(
		// 既保存上轮快照，也保存这一轮共享读取的引用和人数。
		readState: ModelsFileReadState,
		// 每位调用者有自己的取消信号，共享 I/O 另外使用自己的 controller。
		options?: ModelsStoreOperationOptions,
	): Promise<StoredModels> {
		// 已经取消就不启动新的文件读取。
		options?.signal?.throwIfAborted();
		// 查询元数据比重新读取并解析整个模型目录更便宜。
		const revision = getFileRevision(this.path);
		// 必须成功取得版本且与缓存相同；undefined 与 undefined 不足以证明文件没变。
		if (revision !== undefined && revision === readState.revision) return readState.data;
		// 当前没有人在读，才启动一轮；否则下面直接加入已有任务。
		if (!readState.reload) {
			// 使用独立控制器，不能让第一个读者独自控制所有读者的任务。
			const controller = new AbortController();
			// 显式类型检查三个字段是否齐全；对象中的冒号指定属性值，与变量声明中的类型标注不同。
			const reload: ModelsFileReload = {
				// 同名属性简写，等价于 controller: controller。
				controller,
				// 立即启动读取，保存 Promise 供所有等待者共享。
				promise: this.reloadFromStorage(readState, { signal: controller.signal }),
				// 真正加入等待的人数在下面统一递增。
				readers: 0,
			};
			// 保存引用后，后来的请求就能找到这一轮任务。
			readState.reload = reload;
			// void 表示有意不等待 then 产生的结果；成功与失败都登记清理回调。
			void reload.promise.then(
				() => {
					// 身份比较保护新任务：旧任务完成时不能误清除后来启动的另一轮读取。
					if (readState.reload === reload) readState.reload = undefined;
				},
				() => {
					// 失败同样清除状态，下次可以重试；原错误仍由 await 那条链交给调用者。
					if (readState.reload === reload) readState.reload = undefined;
				},
			);
		}

		// 保存本轮引用；await 期间全局 readState.reload 可能已经变成下一轮。
		const reload = readState.reload;
		// ++ 原地加一；从此这个调用者算一个等待者。
		reload.readers++;
		try {
			// await 等待共享结果，但只让当前这位读者按自己的 signal 结束等待。
			return await raceWithAbortSignal(reload.promise, options?.signal);
		} finally {
			// finally 不论成功、失败还是取消都会执行，避免人数永远偏大。
			reload.readers--;
			// 必须没人等且它仍是当前任务，才能清理并取消底层读取。
			if (reload.readers === 0 && readState.reload === reload) {
				// 先移除引用，让新读者可以启动新任务。
				readState.reload = undefined;
				// abort 发出取消信号，实际停止位置取决于文件后端检查信号的位置。
				reload.controller.abort();
			}
		}
	}

	/** 读取单个提供商；复用文件缓存，但对外返回深副本，找不到时返回 undefined。 */
	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		// 先 await 得到字典，再用 [providerId] 动态属性名取一项。
		const entry = (await this.readLatest(this.readState, options))[providerId];
		// 读取结束后再检查一次，防止在等待完成的交界处把结果交给已取消的调用者。
		options?.signal?.throwIfAborted();
		// 缓存对象留在内部，调用方拿到可以自行使用的副本。
		return entry ? structuredClone(entry) : undefined;
	}

	/** 锁内重新读取 → 替换一个提供商 → 写回 JSON → 更新内存；保留其他提供商条目。 */
	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		// 回调内取得的最新数据稍后还要用于更新缓存，因此在回调外声明。
		let latest: StoredModels | undefined;
		// 加锁让遵守同一锁协议的进程依次读改写，避免两边都拿旧内容覆盖对方。
		await this.storage.withLockAsync(async (content) => {
			// 使用锁内最新文本，绝不能从可能过期的 readState.data 开始写。
			const current = this.parse(content);
			// 只替换目标提供商；深复制使调用者无法在以后改写这份目录。
			current[providerId] = structuredClone(entry);
			// 只有后端写入成功，外层才会继续使用它更新缓存。
			latest = current;
			// next 是要写回的全文；null 表示不指定字段过滤，2 表示用两个空格缩进。
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		}, options);
		// 不复用旧 revision：下一次读取会重新确认文件版本。
		if (latest) this.updateReadState(this.readState, latest);
	}

	/** 锁内删除目标提供商并写回；删除不存在的条目也会正常保存其他内容。 */
	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		// 与 write 一样，先保存准备好的新快照，写入成功后才发布到内存。
		let latest: StoredModels | undefined;
		// 与所有通过此后端操作该路径的读写者协调锁。
		await this.storage.withLockAsync(async (content) => {
			// 删除也先读最新全文，不能误删别的进程刚新增的提供商。
			const current = this.parse(content);
			// delete 是 JavaScript 的对象属性删除操作，不是调用这个类的 delete 方法。
			delete current[providerId];
			// 对象其余属性保留，作为新的内存快照。
			latest = current;
			// 后端负责实际文件写入；这里没有额外承诺临时文件替换等原子写入机制。
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		}, options);
		// 省略 revision 会使下一次读取重新检查文件，而不是信任写入前的版本。
		if (latest) this.updateReadState(this.readState, latest);
	}
}
