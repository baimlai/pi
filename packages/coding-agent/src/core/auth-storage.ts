/**
 * CredentialStore implementation backed by auth.json.
 * Provider auth orchestration belongs to ModelRuntime and pi-ai Models.
 */

// 本文件管理凭证的存取和文件锁；OAuth 登录/刷新流程交给 ModelRuntime 与 pi-ai Models。
// import type 只引入类型：操作选项、凭证内容、不含秘密的元数据、存储接口。
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
// 同步文件操作在当前线程执行；名字中的 Sync 不代表异步 Promise。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
// dirname 取父目录，join 按当前系统规则拼接路径。
import { dirname, join } from "path";
// 第三方库负责跨进程文件锁；所有写者需遵守同一锁协议才能相互协调。
import lockfile from "proper-lockfile";
// as 在 import 中表示重命名；这里把异步定时器 setTimeout 命名为 sleep。
import { setTimeout as sleep } from "timers/promises";
// 统一获取配置目录，不从源码文件位置推测安装路径。
import { getAgentDir } from "../config.ts";
// 允许调用方取消等待一个 Promise；是否中断任务本身还取决于底层是否处理信号。
import { raceWithAbortSignal } from "../utils/abort.ts";
// 文件版本来自元数据，不是内容哈希；normalizePath 处理 ~ 等路径写法。
import { getFileRevision, normalizePath } from "../utils/paths.ts";
// 移除文件开头可能存在的 BOM 字符，再解析 JSON。
import { stripBom } from "../utils/text.ts";
// 配置中的 key 可以是字面量、$变量模板或 !开头的命令；只读存储不会执行命令。
import { isCommandConfigValue, resolveConfigValue } from "./resolve-config-value.ts";

// Record<string, Credential> 是“提供商 ID → 凭证”的字典，如 { openai: 某份凭证 }。
type AuthStorageData = Record<string, Credential>;

// On Windows, a just-removed lock directory can stay "delete pending" while another process
// (antivirus, indexer, another pi checking the lock) still has it open. mkdir then fails with
// EPERM until that handle closes. Retry this briefly so real permission errors still fail fast.
// Windows 上刚删除的锁目录可能暂时仍被其他进程占用；EPERM 只短暂重试，不能无限掩盖权限问题。
const MAX_EPERM_RETRIES = 5;

/** 只把锁占用 ELOCKED，以及 Windows 的短暂 EPERM 识别为可重试；其他错误直接交给上层。 */
function getRetryableLockErrorCode(error: unknown): "ELOCKED" | "EPERM" | undefined {
	// 异常来源不受 TypeScript 保证：先确认 Error 且确有 code 属性，才取错误码。
	const code = error instanceof Error && "code" in error ? error.code : undefined;
	// 字符串字面量联合类型限制返回值只能是这两种错误码或 undefined。
	if (code === "ELOCKED") return code;
	// 同样的 EPERM 在其他系统不当作暂时锁冲突处理。
	if (code === "EPERM" && process.platform === "win32") return code;
	// undefined 表示“不应按锁冲突重试”，不是“没有发生错误”。
	return undefined;
}

// 后端回调的协议：result 返回给调用者，next 可选地指定要写回的整个文件文本。
type LockResult<T> = {
	// T 是泛型占位符，因此后端可以返回任意具体业务结果，不需要 any。
	result: T;
	// 省略 next 表示不写文件；空字符串仍然是一个明确的写入值。
	next?: string;
};

// The mode applies only on creation so administrator-managed modes and ACLs remain intact.
// 0o600 是八进制权限，只用于创建文件时设置所有者读写；已有权限和 ACL 不会因此被重设。
// as const 保留字面量类型，让 encoding 保持 "utf-8" 而不是宽泛的 string。
const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

// 合并并发读取的一轮任务；每位调用者可以独立取消等待。
type AuthFileReload = {
	// 共享读取使用独立取消控制器，不能被某一个读者单独拥有。
	controller: AbortController;
	// Promise 保存将来的整份字典；多个人等的是同一次读取。
	promise: Promise<AuthStorageData>;
	// 记录仍在等待的人数；最后一个退出时才可能取消底层读取。
	readers: number;
};

// 缓存状态与文件绑定，包含最近数据、文件版本和正在进行的读取。
type AuthFileReadState = {
	// 即使读取新文件失败，也可以保留上一份成功解析的快照。
	data: AuthStorageData;
	// ? 表示版本可以尚未确认；不能只因两边都是 undefined 就认为文件没变。
	revision?: string;
	// 没有正在进行的共享读取时，reload 为 undefined。
	reload?: AuthFileReload;
};

// 只保留第一个文件路径的共享缓存；同路径实例复用它，其他路径独立，避免全局表不断增长。
let sharedAuthFileReadState: { authPath: string; readState: AuthFileReadState } | undefined;

/** 存储后端只负责锁、文本和写回；不解释提供商凭证的具体字段。 */
export interface AuthStorageBackend {
	/** 同步拿锁后把最新文本交给 fn；fn 返回 next 才写回，最终返回 result。 */
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	/** 异步排队拿锁并等待 fn；options 可携带取消信号，返回结果类型仍是 T。 */
	withLockAsync<T>(
		// 回调接收文件全文或 undefined，并异步决定业务结果与新全文。
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		// 认证操作选项被这里复用为存储操作选项，例如取消等待锁。
		options?: AuthOperationOptions,
		// 泛型 T 将回调的 result 类型传递到调用者收到的 Promise。
	): Promise<T>;
}

/** 文件后端：创建目录/文件 → 拿锁 → 读最新文本 → 执行回调 → 按需写回 → 释放锁。 */
export class FileAuthStorageBackend implements AuthStorageBackend {
	// 字段保存归一化路径；这个类也被模型目录存储复用，不限于 auth.json。
	private authPath: string;

	/** 默认指向配置目录中的 auth.json；可传其他路径复用加锁读写机制。 */
	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		// 处理 ~ 等路径写法；这里不承诺所有相对路径都变为绝对路径。
		this.authPath = normalizePath(authPath);
	}

	/** 在父目录缺失时递归创建；不修改已经存在的目录权限。 */
	private ensureParentDir(): void {
		// 例如 /tmp/pi/auth.json 的父目录是 /tmp/pi。
		const dir = dirname(this.authPath);
		// 只有目录不存在时才需要创建。
		if (!existsSync(dir)) {
			// recursive 自动补齐缺失的上级；0o700 为新目录设置所有者读写执行权限。
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	/** 检查到文件不存在时写入空 JSON；检查与写入不原子，并发创建时不保证保留另一进程刚写的内容。 */
	private ensureFileExists(): void {
		// 该检查在拿锁前执行；检查时存在便跳过，但它与下面的默认覆盖写入之间仍有并发窗口。
		if (!existsSync(this.authPath)) {
			// 写的是两个字符 {}，不是 JavaScript 对象；编码与创建权限来自统一选项。
			writeFileSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS);
		}
	}

	/** 同步尝试拿锁，锁冲突时短暂忙等，最多十次；成功返回释放锁的函数。 */
	private acquireLockSyncWithRetry(path: string): () => void {
		// 这里次数包含第一次尝试，不是第一次之后再重试十次。
		const maxAttempts = 10;
		// 每次可重试失败之间阻塞约 20 毫秒，保持原同步接口。
		const delayMs = 20;
		// for 中间条件留空表示持续循环，通过 return 或 throw 退出。
		for (let attempt = 1; ; attempt++) {
			try {
				// realpath: false 避免先解析真实路径；返回函数稍后负责解锁。
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				// 不可重试错误立即抛出；可重试错误到了最后一次也抛出。
				if (!getRetryableLockErrorCode(error) || attempt === maxAttempts) throw error;
				// Date.now() 是毫秒时间戳，用于计算等待时长。
				const start = Date.now();
				// 这是同步忙等，会占用当前线程；不是 await 异步定时器。
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}
	}

	/** 同步读改写：fn 只读时不提供 next；例如返回 { result: 当前文本 } 就只查询。 */
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		// 先准备目录，文件不存在时才能正确创建。
		this.ensureParentDir();
		// 初始化文件之后再尝试拿锁。
		this.ensureFileExists();

		// 函数类型 (() => void) 要加括号，才能与 undefined 组成联合类型。
		let release: (() => void) | undefined;
		try {
			// 拿不到锁会抛错；尚未赋值 release 时 finally 不会尝试解锁。
			release = this.acquireLockSyncWithRetry(this.authPath);
			// 必须在锁内读最新文本；不存在则用 undefined 交给业务回调。
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			// 对象解构同时取出业务结果 result 和可选新文件全文 next。
			const { result, next } = fn(current);
			// 明确比较 undefined，允许把文件写成空字符串。
			if (next !== undefined) {
				// 同步直接写目标文件；这里没有临时文件重命名或失败自动回滚协议。
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
			}
			// 文件写入成功后才把回调结果返回。
			return result;
		} finally {
			// finally 在成功和抛错时都会执行，只释放真正获得过的锁。
			if (release) {
				// 调用锁库提供的释放函数。
				release();
			}
		}
	}

	/** 异步等待文件锁：指数退避加随机延迟，最多等约 30 秒；支持取消并返回异步解锁函数。 */
	private async acquireLockAsync(
		// signal 可以不存在；存在时等待和重试都检查取消。
		signal: AbortSignal | undefined,
		// 锁库发现锁状态异常时通知外层，防止继续信任已经失效的锁。
		onCompromised: (error: Error) => void,
		// 两层函数类型：外层 Promise 等“拿到解锁函数”，内层 Promise 等“解锁完成”。
	): Promise<() => Promise<void>> {
		// 数字中的下划线只是可读性分隔，30_000 与 30000 完全相同。
		const staleMs = 30_000;
		// 随机退避的上限是 2000 毫秒。
		const maxDelayMs = 2_000;
		// 同一个绝对截止时间约束总等待，不能每次重试都重新给三十秒。
		const deadline = Date.now() + staleMs;
		// 退避次数用于指数计算，与 EPERM 单独次数不同。
		let retry = 0;
		// Windows EPERM 次数单独累计，避免把真实权限问题等满三十秒。
		let epermRetries = 0;
		// 循环通过成功 return、取消抛错或不可重试错误结束。
		while (true) {
			// 每次尝试之前先检查取消，不为已取消请求继续争锁。
			signal?.throwIfAborted();
			// 每轮单独保存本轮成功获取的解锁函数。
			let release: (() => Promise<void>) | undefined;
			try {
				// await 暂停本函数等待锁库；其他 JavaScript 异步任务仍可推进。
				release = await lockfile.lock(this.authPath, {
					// 不额外解析真实路径，与同步拿锁保持一致。
					realpath: false,
					// 关闭锁库自带重试，避免和当前可取消的退避循环叠加。
					retries: 0,
					// 超过此阈值未更新的锁可被库视为陈旧锁。
					stale: staleMs,
					// 属性简写，等价于 onCompromised: onCompromised。
					onCompromised,
				});
			} catch (error) {
				// 拿锁失败后优先处理取消，避免继续等到重试结束。
				signal?.throwIfAborted();
				// 判断是否真是本方案允许重试的错误码。
				const code = getRetryableLockErrorCode(error);
				// 距离总截止时间还剩多少毫秒。
				const remainingMs = deadline - Date.now();
				// 非锁冲突或时间耗尽，原错误交给调用者。
				if (!code || remainingMs <= 0) throw error;
				// The 30s deadline is for waiting on another holder; cap EPERM retries separately.
				// 前置 ++ 先累加再比较；第六次 EPERM 将超出允许的五次重试。
				if (code === "EPERM" && ++epermRetries > MAX_EPERM_RETRIES) throw error;
				// ** 是乘方：基础延迟 10、20、40…，最高 1000 毫秒，之后再加随机倍数。
				const baseDelayMs = Math.min(10 * 2 ** retry, maxDelayMs / 2);
				// 本次计算之后增加退避级别，供下一次冲突使用。
				retry++;
				// 乘上 1 到 2 之间的随机数，减少多个进程同时醒来；最终不超过剩余总时间。
				const delayMs = Math.min(Math.round(baseDelayMs * (1 + Math.random())), remainingMs);
				// 带 signal 的异步定时器可在等待期间被取消；undefined 是未使用的定时器返回值。
				if (signal) await sleep(delayMs, undefined, { signal });
				// 没有信号时普通等待这一段退避时间。
				else await sleep(delayMs);
				// 跳过本轮剩余代码，重新尝试拿锁。
				continue;
			}
			// 锁刚拿到时也可能已经取消，不能把一个无人使用的锁留着。
			if (signal?.aborted) {
				// 先释放已得到的锁，再向调用方抛取消原因。
				await release();
				// 这里 signal 已由 if 缩小为存在且已取消的信号。
				signal.throwIfAborted();
			}
			// 成功且未取消，把解锁责任交给外层 withLockAsync。
			return release;
		}
	}

	/** 异步锁内执行读改写；回调前后检查取消与锁失效，最终总会尝试释放已获锁。
	 * 例如更新一个 key 时，回调读最新 JSON 再返回 next 全文；本方法不提供写后回滚。 */
	async withLockAsync<T>(
		// 泛型回调决定业务结果 T，以及是否提供 next 触发文件写入。
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		// 可选参数使调用方能在等待锁、等待回调的阶段发出取消。
		options?: AuthOperationOptions,
		// async 自动把成功值包装成 Promise，把抛出的错误变成拒绝。
	): Promise<T> {
		// 取消发生在准备文件前，就不再创建目录或文件。
		options?.signal?.throwIfAborted();
		// 此处仍使用同步文件系统函数；“异步方法”不代表每一步都是异步 I/O。
		this.ensureParentDir();
		// 确保目标文件存在，随后再竞争锁。
		this.ensureFileExists();

		// 未获得锁前保持 undefined，方便 finally 判断是否需要解锁。
		let release: (() => Promise<void>) | undefined;
		// 记录锁库是否报告失效，不是在校验已有 TypeScript 类型。
		let lockCompromised = false;
		// 保留锁库提供的具体原因，用于后续检查时抛出。
		let lockCompromisedError: Error | undefined;
		// 局部函数捕获外层状态，在多个阶段复用同一失效判断。
		const throwIfCompromised = () => {
			// 锁状态异常就拒绝继续信任这次锁定。
			if (lockCompromised) {
				// ?? 在没有具体错误时构造默认错误；已有错误对象原样保留。
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			// 拿锁可能等待；回调用于记录之后发生的锁失效。
			release = await this.acquireLockAsync(options?.signal, (error) => {
				// 先标记状态，让后续任一检查点都能发现异常。
				lockCompromised = true;
				// 再保存具体错误原因。
				lockCompromisedError = error;
			});

			// 获得锁后确认它仍有效，再读文件。
			throwIfCompromised();
			// 调用者在等锁期间可能取消，拿到锁也不能继续执行业务。
			options?.signal?.throwIfAborted();
			// 锁内读文件最新全文；如果文件已不存在则传 undefined。
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			// await 允许业务回调异步处理，但此期间当前操作仍持有锁。
			const { result, next } = await fn(current);
			// 回调等待期间锁可能失效，写之前必须再次确认。
			throwIfCompromised();
			// 回调完成不等于调用者仍愿意写入，取消则在写前退出。
			options?.signal?.throwIfAborted();
			// next 不存在就是只读；不能使用 if (next)，否则无法写空字符串。
			if (next !== undefined) {
				// 直接写回目标文件；写入成功后再出错也没有自动恢复旧文件的步骤。
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
			}
			// 写后也报告锁失效；因此出现拒绝结果并不必然代表文件完全没被写过。
			throwIfCompromised();
			// 返回回调的业务结果，而不是文件全文。
			return result;
		} finally {
			// 仅在确实获得锁后进入释放步骤。
			if (release) {
				try {
					// 异步释放需要 await，避免方法结束时解锁还未完成。
					await release();
					// 此处沿用原实现：释放错误被忽略，不覆盖更早的业务错误。
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

/** 只读凭证快照：首次读取并校验文件，后续复用内存；不会写文件，也不执行 !命令 key。 */
export class ReadOnlyAuthStorage implements CredentialStore {
	// readonly 只限制路径字段重新赋值。
	private readonly authPath: string;
	// 第一次 load 前没有数据；加载成功后保存整份快照。
	private data: AuthStorageData | undefined;

	/** 设定只读文件位置；构造本身不读文件，第一次 read/list 才加载。 */
	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		// 统一处理路径写法，默认路径从配置目录取得。
		this.authPath = normalizePath(authPath);
	}

	/** 首次读取并校验不受信任的磁盘 JSON；文件不存在视为空，格式或字段错误明确抛出。 */
	private load(): AuthStorageData {
		// 空对象也是 truthy，因此已加载的空文件快照也会复用；不会自动监视文件变化。
		if (this.data) return this.data;

		// JSON 是磁盘输入边界，先用 unknown 表示结构未经确认。
		let parsed: unknown;
		try {
			// 读 UTF-8 文本、去 BOM、解析 JSON；任一步失败都进入 catch。
			parsed = JSON.parse(stripBom(readFileSync(this.authPath, "utf-8")));
		} catch (error) {
			// 这里只把缺文件 ENOENT 当空数据；as 是类型断言，本身不会检查错误结构。
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				// 记住空快照，下次不会再尝试读取。
				this.data = {};
				// 返回同一个内部快照，公开 read 会决定如何复制凭证。
				return this.data;
			}
			// 其他读取或 JSON 解析错误带上可读说明，不静默视为“没登录”。
			throw new Error(`Failed to read auth.json: ${error instanceof Error ? error.message : String(error)}`);
		}

		// 磁盘 JSON 边界校验：必须是非 null、非数组的对象，不能只相信类型断言。
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			// 根结构不对时停止解析，不能继续当作提供商字典。
			throw new Error("Invalid auth.json: expected an object");
		}
		// Object.entries 给出 [键, 值] 对；数组解构分别得到提供商 ID 与凭证。
		for (const [providerId, credential] of Object.entries(parsed)) {
			// 逐条检查磁盘输入的凭证也必须是普通对象形状，不能是 null 或数组。
			if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
				// 只指出哪家配置有问题，不把凭证秘密拼到报错里。
				throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
			}
			// 到这里确认是对象，但字段仍是 unknown，接下来按凭证类型检查。
			const value = credential as Record<string, unknown>;
			// 用 type 区分 API key 和 OAuth 的结构。
			if (value.type === "api_key") {
				// 允许没有 key，例如只配置环境；如果有 key，必须是字符串。
				const validKey = value.key === undefined || typeof value.key === "string";
				// env 同样可省略；如果提供，下面要求它是字符串值的字典。
				const validEnv =
					// 没有 env 直接满足条件，不继续执行右侧检查。
					value.env === undefined ||
					// typeof null 也是 object，因此下面还需排除 null。
					(typeof value.env === "object" &&
						// 排除 null 后，才能安全继续查看对象值。
						value.env !== null &&
						// 数组不是这里所需的环境变量字典。
						!Array.isArray(value.env) &&
						// every 检查每个环境值均为字符串；这是磁盘输入校验，不是重复检查可信的 TS 参数。
						Object.values(value.env).every((entry) => typeof entry === "string"));
				// 这条凭证通过就 continue 检查下一家，跳过本轮底部的报错。
				if (validKey && validEnv) continue;
			} else if (
				// OAuth 分支必须明确声明类型为 oauth。
				value.type === "oauth" &&
				// access 是访问令牌，要求字符串。
				typeof value.access === "string" &&
				// refresh 是刷新令牌，要求字符串。
				typeof value.refresh === "string" &&
				// expires 是数值时间戳；这里先排除非数字类型。
				typeof value.expires === "number" &&
				// 再排除 Infinity 等非有限数，避免无效过期时间进入认证逻辑。
				Number.isFinite(value.expires)
			) {
				// OAuth 基础字段通过，继续检查下一条。
				continue;
			}
			// 既不是合法 API key，也不是合法 OAuth，就报告这一提供商的数据无效。
			throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
		}

		// 完成上面边界校验后，将对象断言为业务类型，并缓存下来。
		this.data = parsed as AuthStorageData;
		// 内部返回缓存；不会在这里执行配置值命令。
		return this.data;
	}

	/** 读取一份凭证：普通 key 可展开环境变量，!命令原样返回，不执行外部程序。 */
	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		// 开始前处理取消信号。
		options?.signal?.throwIfAborted();
		// 首次调用会触发 load，后续从固定快照按提供商取值。
		const credential = this.load()[providerId];
		// 加载之后再确认调用者没有取消。
		options?.signal?.throwIfAborted();
		// 该提供商未配置凭证时返回 undefined。
		if (!credential) return undefined;
		// OAuth、空 key、命令 key 都不在只读层解析；尤其避免 !命令产生外部副作用。
		if (credential.type !== "api_key" || !credential.key || isCommandConfigValue(credential.key)) {
			// 深复制返回，调用方改 OAuth 字段或 env 不会改到只读快照。
			return structuredClone(credential);
		}
		// 普通 key 展开 $变量模板；对象展开是浅复制，env 等其他嵌套值没有在此深复制。
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	/** 列出提供商及凭证类型，省略 key/token 内容，不执行配置命令。 */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		// 即使只查询元数据，也遵守取消约定。
		options?.signal?.throwIfAborted();
		// map 把完整凭证字典转换为不含秘密的元数据数组。
		const credentials = Object.entries(this.load()).map(([providerId, credential]) => ({
			// 属性简写相当于 providerId: providerId。
			providerId,
			// 只保留类型，例如 api_key 或 oauth。
			type: credential.type,
		}));
		// 返回前再次检查取消，避免给已取消的操作交付结果。
		options?.signal?.throwIfAborted();
		// readonly 是调用方的类型限制，不是对数组执行 Object.freeze。
		return credentials;
	}

	/** 只读存储拒绝修改；不会调用传入的更新回调。 */
	async modify(
		// 下划线表示为了满足接口保留参数，但方法中有意不用。
		_providerId: string,
		// 接口要求异步更新函数；只读实现不执行它。
		_fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		// 保留与 CredentialStore 一致的选项签名。
		_options?: AuthOperationOptions,
		// async 抛错会成为 Promise 拒绝，调用方可用 await + try/catch 处理。
	): Promise<Credential | undefined> {
		// 明确拒绝写入，而不是假装成功或静默丢弃修改。
		throw new Error("Read-only credential storage cannot modify auth.json");
	}

	/** 只读存储同样拒绝删除，文件内容完全不由此方法修改。 */
	async delete(_providerId: string, _options?: AuthOperationOptions): Promise<void> {
		// 调用者收到与 modify 相同的只读错误。
		throw new Error("Read-only credential storage cannot modify auth.json");
	}
}

/** 内存文本后端：异步操作按 Promise 链排队；不访问磁盘，适合隔离存储和测试。 */
export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	// 存的是 JSON 文本，不是解析后的凭证对象；因此可复用同一后端接口。
	private value: string | undefined;
	// 已完成的 Promise 是空队列尾；unknown 表示不需要使用前一任务的业务结果。
	private asyncChain: Promise<unknown> = Promise.resolve();

	/** 同步执行回调并按需替换内存文本；不会等待异步队列，因此不与异步任务形成同一把锁。 */
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		// 把当前文本交给回调，解构它返回的业务结果与可选新文本。
		const { result, next } = fn(this.value);
		// 省略 next 保持原值；空字符串依然是有效新文本。
		if (next !== undefined) {
			// 只有明确返回 next 才更新内存。
			this.value = next;
		}
		// 直接返回 T，而不是 Promise<T>。
		return result;
	}

	/** 等上一个异步操作结束再执行读改写；某次失败不会堵死后面的操作。 */
	withLockAsync<T>(
		// 回调可异步计算下一份文本；串行队列覆盖整个回调等待期。
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		// 信号既用于停止等待，也在写回前检查取消。
		options?: AuthOperationOptions,
		// T 贯穿回调 result 与最终 Promise 的类型。
	): Promise<T> {
		// 先捕获当前队尾，随后新任务会挂在它后面。
		const previous = this.asyncChain;
		// 异步立即执行函数表达式：定义后立刻调用，得到本次 operation Promise。
		const operation = (async () => {
			// 上一个任务失败也继续排队；只忽略前一个错误，不会吞掉当前任务错误。
			await previous.catch(() => {});
			// 排队时可能已取消，轮到后先检查，不运行更新回调。
			options?.signal?.throwIfAborted();
			// 拿到当前最新内存文本再调用更新函数。
			const { result, next } = await fn(this.value);
			// 回调等待期间可能取消，写入前再次检查。
			options?.signal?.throwIfAborted();
			// 仅在回调提供新全文时写入。
			if (next !== undefined) {
				// 本次更新成为后续任务读到的当前值。
				this.value = next;
			}
			// 把本次业务结果交给 operation 的等待者。
			return result;
		})();
		// 队尾捕获失败，让后续操作仍可启动；调用者仍等待原 operation，错误不会被这行抹掉。
		this.asyncChain = operation.catch(() => {});
		// 取消可以提前结束调用者等待；已经运行的任意回调不会被 JavaScript 强制终止。
		return raceWithAbortSignal(operation, options?.signal);
	}
}

/**
 * Credential storage backed by a JSON file.
 */
/**
 * 按提供商读改删凭证，复用后端锁与缓存；OAuth 流程由上层安排。
 * 例：const store = AuthStorage.inMemory();
 * await store.modify("demo", async () => ({ type: "api_key", key: "example-key" }));
 * await store.read("demo") 得到凭证；modify("demo", async () => undefined) 保留它；delete("demo") 才删除。
 * 文件型存储在锁内用最新全文修改一家，避免不同提供商的并发更新互相覆盖。
 */
export class AuthStorage implements CredentialStore {
	// 后端可以是文件或内存，业务方法不直接依赖某一种存储介质。
	private storage: AuthStorageBackend;
	// 只有文件型构造入口有路径，用它检查外部进程是否改过文件。
	private authPath: string | undefined;
	// 当前数据、元数据版本和共享读取任务放在一起管理。
	private readState: AuthFileReadState;

	/** 私有构造：外部使用 create/fromStorage/inMemory，内部完成缓存复用和首次读取。 */
	private constructor(storage: AuthStorageBackend, authPath?: string) {
		// 保存后端引用；this 指向正在创建的 AuthStorage 实例。
		this.storage = storage;
		// 自定义后端可无文件路径，后续不能采用文件版本快捷路径。
		this.authPath = authPath;
		// 如果与最早记录的文件路径相同，就复用那个共享状态。
		this.readState =
			// && 短路保证先有路径；三元表达式决定共享状态还是新的空状态。
			authPath && sharedAuthFileReadState?.authPath === authPath ? sharedAuthFileReadState.readState : { data: {} };
		// 只为第一个文件路径建立全局共享引用，不永久收集所有自定义文件路径。
		if (authPath && !sharedAuthFileReadState) {
			// 同一对象被多个实例引用，读取更新后大家看见同一份快照。
			sharedAuthFileReadState = { authPath, readState: this.readState };
		}
		// 文件后端可以用元数据确认是否需要重新读。
		if (authPath) {
			// 版本来源是文件系统属性，不会解析整个凭证文件。
			const revision = getFileRevision(authPath);
			// 必须拿到有效版本且与缓存相同，才跳过构造时重读。
			if (revision !== undefined && revision === this.readState.revision) return;
		}
		// 否则同步重新加载；reload 失败会保留之前快照。
		this.reload();
	}

	/** 创建文件型存储；例如 AuthStorage.create("/tmp/auth.json")，默认用用户配置目录。 */
	static create(authPath: string = join(getAgentDir(), "auth.json")): AuthStorage {
		// 统一路径后同时交给后端和缓存判断，避免二者使用不同写法。
		const normalizedAuthPath = normalizePath(authPath);
		// 构造文件后端并初始化业务层；这一步可能创建文件、加锁和读取。
		return new AuthStorage(new FileAuthStorageBackend(normalizedAuthPath), normalizedAuthPath);
	}

	/** 将自定义后端包装为凭证存储，不按磁盘路径做版本缓存。 */
	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		// 省略 authPath，因此会走“无文件路径”的读取方式。
		return new AuthStorage(storage);
	}

	/** 创建内存凭证存储并填入初始数据；例如用于测试，结束后不会生成 auth.json。 */
	static inMemory(data: AuthStorageData = {}): AuthStorage {
		// 先建一个空的内存文本后端。
		const storage = new InMemoryAuthStorageBackend();
		// 同步写入序列化的初始数据，两个空格缩进便于阅读。
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		// 再通过统一包装入口创建 AuthStorage。
		return AuthStorage.fromStorage(storage);
	}

	/** 空文本当空字典，否则去 BOM 后解析；这里的可写存储没有只读类那套逐字段校验。 */
	private parseStorageData(content: string | undefined): AuthStorageData {
		// undefined 和空字符串都当作没有凭证数据。
		if (!content) {
			// 返回新的空对象，而不是复用全局可变字典。
			return {};
		}
		// as 只是类型断言，不会在运行时验证 JSON 各字段；非法 JSON 本身仍会抛错。
		return JSON.parse(stripBom(content)) as AuthStorageData;
	}

	/** 同时发布新的凭证快照及文件版本；省略版本使后续读取重新核对。 */
	private updateReadState(data: AuthStorageData, revision?: string): void {
		// 更新共享状态的数据字段，而不是替换整个 readState 对象。
		this.readState.data = data;
		// revision 可以被明确清成 undefined，不能留下不再匹配的数据版本。
		this.readState.revision = revision;
	}

	/**
	 * Reload credentials from storage.
	 */
	/** 同步重读：锁内取文本和版本 → 解析成功才更新；失败沿用最近一次成功快照。 */
	reload(): void {
		// 回调内读取的全文要在锁外解析，所以先声明外层变量。
		let content: string | undefined;
		// 自定义后端没有文件版本，保持 undefined。
		let revision: string | undefined;
		try {
			// 回调不提供 next，只读不会写回文件。
			this.storage.withLock((current) => {
				// 记录拿锁之后看到的最新内容。
				content = current;
				// 同一读取过程中获取文件版本；没有路径的后端不查文件系统。
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				// result 没有业务值，关键是没有 next，因此后端不写。
				return { result: undefined };
			});
			// 先解析再调用更新；解析失败时不会覆盖原有快照。
			this.updateReadState(this.parseStorageData(content), revision);
			// 这里有意不向调用方抛出读取错误。
		} catch {
			// 首次读取失败时保留初始空对象，已有成功数据时保留那份旧数据。
			// Preserve the last valid in-memory snapshot.
		}
	}

	/** 异步锁内读取并更新快照；本方法本身不吞错误，由调用方决定是否回退旧缓存。 */
	private async reloadFromStorageAsync(options?: AuthOperationOptions): Promise<AuthStorageData> {
		// 等待后端锁，把传入 signal 用于排队与回调前后取消检查。
		return this.storage.withLockAsync(async (content) => {
			// 解析锁内最新文本，不能直接使用旧 readState.data。
			const currentData = this.parseStorageData(content);
			// 文件后端记录版本，其他后端没有元数据版本。
			const revision = this.authPath ? getFileRevision(this.authPath) : undefined;
			// 解析成功后更新数据和对应版本。
			this.updateReadState(currentData, revision);
			// 只返回解析结果，不提供 next，文件不被重写。
			return { result: currentData };
		}, options);
	}

	/** 读最新凭证：版本未变复用；变化时合并并发读取；未提供 signal 的调用可在读失败时退回旧快照。 */
	private async readLatestData(options?: AuthOperationOptions): Promise<AuthStorageData> {
		// 传了取消信号且已经取消，就不启动新的存储访问。
		options?.signal?.throwIfAborted();
		// 无路径的自定义后端不能靠 stat 判断变化，每次通过后端读取。
		if (!this.authPath) {
			// 保存异步读取 Promise，本行已经启动操作。
			const reload = this.reloadFromStorageAsync(options);
			// 有 signal 时传播读取/取消错误；没 signal 时读取失败回退旧快照，两条路径行为不同。
			return options?.signal ? reload : reload.catch(() => this.readState.data);
		}
		// 文件后端先查便宜的元数据版本。
		const revision = getFileRevision(this.authPath);
		// 不能将 undefined 与 undefined 当作“文件没变”的依据。
		if (revision !== undefined && revision === this.readState.revision) return this.readState.data;
		// 已有共享读取则加入等待，不再重复启动锁竞争和 JSON 解析。
		if (!this.readState.reload) {
			// 共享任务拥有独立控制器，单个读者只控制自己的等待。
			const controller = new AbortController();
			// 给共享任务对象明确类型，编译期检查字段和 Promise 结果类型。
			const reload: AuthFileReload = {
				// 同名属性简写，等价于 controller: controller。
				controller,
				// 启动实际读取，信号来自共享控制器。
				promise: this.reloadFromStorageAsync({ signal: controller.signal }),
				// 加入人数在下面统一累计，这里从零开始。
				readers: 0,
			};
			// 发布本轮任务，让之后进入的读者可以复用。
			this.readState.reload = reload;
			// void 表示不等待清理链；同时监听成功和失败，清除已结束的任务引用。
			void reload.promise.then(
				() => {
					// 只清理仍指向本轮的引用，不能让旧任务清掉后来创建的新任务。
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
				() => {
					// 失败也清理，下一次可重新尝试；错误仍由等待原 Promise 的调用方处理。
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
			);
		}

		// 捕获本轮对象，await 期间全局状态可能被更新为另一轮。
		const reload = this.readState.reload;
		// 计数加一：这位调用者正式成为当前任务的等待者。
		reload.readers++;
		try {
			// 这里只让当前读者按自身信号停止等待，不直接取消所有读者共用的读取。
			const result = raceWithAbortSignal(reload.promise, options?.signal);
			// 有 signal 保留失败；没有 signal 时失败退回旧快照。await 保证 finally 在真正等完后才减人数。
			return options?.signal ? await result : await result.catch(() => this.readState.data);
		} finally {
			// 无论成功、失败或取消都会减一，避免永远以为还有人在等。
			reload.readers--;
			// 没人再等且它仍是当前任务，才有权清掉并取消共享任务。
			if (reload.readers === 0 && this.readState.reload === reload) {
				// 先清引用，后来的读者可新建任务。
				this.readState.reload = undefined;
				// 发出底层取消信号，停止点由后端检查信号的位置决定。
				reload.controller.abort();
			}
		}
	}

	/** 按提供商读取凭证；API key 可解析字面量、$环境变量和 !命令，OAuth 字段不在此刷新。 */
	async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		// await 得到最新或回退快照后，动态取 provider 对应条目。
		const credential = (await this.readLatestData(options))[provider];
		// 读取结束后再次检查取消，避免交付给已取消操作。
		options?.signal?.throwIfAborted();
		// 找不到凭证或不是 api_key 时直接返回；OAuth 不会在这里执行刷新。
		if (credential?.type !== "api_key") return credential;
		// API key 凭证也可以省略 key，只带其他配置；保持原对象返回。
		if (credential.key === undefined) return credential;
		// 浅复制并解析 key；!命令结果由配置解析器缓存，普通 $变量按提供的 env 和进程环境展开。
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	/**
	 * 锁内读取最新凭证交给 fn，返回新凭证才写回；fn 返回 undefined 表示不改，并非删除。
	 * 例：A 在更新 openai 时，B 更新另一家需要等锁；B 随后读到 A 的新全文，保留 A 的修改再写自己的。
	 * 回调可等待异步工作，因此应注意此期间仍持锁；后端失败会拒绝，不承诺已经写入的内容自动回滚。
	 */
	async modify(
		// 只修改这一提供商，保留其他提供商的条目。
		provider: string,
		// 回调可异步刷新 token；输入可能不存在，输出 undefined 意味着保留当前值。
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		// signal 交给存储后端，在拿锁和写前等阶段检查。
		options?: AuthOperationOptions,
		// 返回最终这一家的凭证；未改时返回已有值，原来没有则仍为 undefined。
	): Promise<Credential | undefined> {
		// 先保留旧快照，回调中拿到最新数据后再替换此局部引用。
		let latestData = this.readState.data;
		// 只有未写入路径能直接复用当前文件版本；写入后保持 undefined，促使重新检查。
		let revision: string | undefined;
		// 在同一把锁内完成读最新 → 调回调 → 写全文，协调其他遵守该锁的进程。
		const result = await this.storage.withLockAsync(async (content) => {
			// 一定解析锁内文本，不能把旧内存快照写回覆盖外部更新。
			const currentData = this.parseStorageData(content);
			// 把当前提供商的凭证交给业务回调，等待它决定下一份。
			const next = await fn(currentData[provider]);
			// undefined 是“不更新”的约定；真正删除应调用 delete。
			if (next === undefined) {
				// 虽然没写文件，仍同步内存到锁内最新数据。
				latestData = currentData;
				// 没发生写入，可记录这次读到的文件版本。
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				// 不提供 next，后端保持原文件；业务结果是原凭证。
				return { result: currentData[provider] };
			}

			// 对象展开保留所有其他提供商；[provider] 是计算属性名，覆盖当前一家。
			const merged: AuthStorageData = { ...currentData, [provider]: next };
			// 保存准备提交的新快照，等后端成功后再发布。
			latestData = merged;
			// result 返回新凭证，next 是整个字典格式化后的 JSON 文本。
			return { result: next, next: JSON.stringify(merged, null, 2) };
		}, options);
		// 只有后端正常完成才执行；写入路径清空版本，下次读取重新确认。
		this.updateReadState(latestData, revision);
		// 返回新凭证或未修改时的原凭证。
		return result;
	}

	/** 锁内删除一个提供商的凭证并写回；不会自动删除模型目录或环境变量。 */
	async delete(provider: string, options?: AuthOperationOptions): Promise<void> {
		// 保存将要发布的快照，成功之后才更新缓存。
		let latestData = this.readState.data;
		// 删除同样必须在锁内基于最新文本操作。
		await this.storage.withLockAsync(async (content) => {
			// 读其他进程刚保存的完整字典，避免覆盖掉它们。
			const currentData = this.parseStorageData(content);
			// delete 关键字删除对象属性；它不是递归调用当前方法。
			delete currentData[provider];
			// 保存删除后的字典给外层更新缓存。
			latestData = currentData;
			// 写回整个字典，result 无业务值，所以返回 undefined。
			return { result: undefined, next: JSON.stringify(currentData, null, 2) };
		}, options);
		// 不保留写入前的 revision；后续读取会重新检查文件。
		this.updateReadState(latestData);
	}

	/** List credential metadata without resolving configured key values. */
	/** 列凭证元数据：只返回提供商及类型，不解析 key、执行命令或暴露 token。 */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		// 读取最新字典再转成键值对列表。
		const entries = Object.entries(await this.readLatestData(options));
		// 拿到数据后再次检查取消。
		options?.signal?.throwIfAborted();
		// 数组解构取出键和值；map 为每项构造不含秘密的新对象。
		return entries.map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}
}

/**
 * One-off synchronous read of a stored credential from an auth.json file,
 * without instantiating a store or resolving configured key values.
 */
/** 一次性同步读某家原始凭证，不创建存储实例、不加锁、不展开 key；任何读取错误都返回 undefined。 */
export function readStoredCredential(
	// 提供商 ID 用来从 JSON 根字典取一项。
	providerId: string,
	// 默认路径来自统一配置目录，调用者也可指定独立文件。
	authPath: string = join(getAgentDir(), "auth.json"),
	// 联合类型提示调用方：文件缺失、解析失败或该项不存在时都可能没有结果。
): Credential | undefined {
	try {
		// 归一化路径 → 读 UTF-8 → 去 BOM → 解析；as 不校验字段结构。
		const data = JSON.parse(stripBom(readFileSync(normalizePath(authPath), "utf-8"))) as AuthStorageData;
		// 直接返回存储内容，包括尚未展开的 $变量或 !命令字符串。
		return data[providerId];
	} catch {
		// 此便捷入口统一吞掉错误；需要诊断文件格式问题时应使用明确报错的路径。
		return undefined;
	}
}
