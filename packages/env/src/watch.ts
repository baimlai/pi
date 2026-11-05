// 把远端长watch请求变成文件变更回调：等待覆盖、转换事件、停止与掉线重连；真正文件系统观察/扫描在daemon，本客户端负责生命周期和漏事件提示。
// Context仅作类型，stop遵守接口签名；本实现不会读取传入context的取消或deadline。
import type { Context } from "@earendil-works/chord/context";
// FileChange是kind标签联合，FileWatcher/WatchTarget是接口；FileError是真实错误构造器。
import { type FileChange, FileError, type FileWatcher, type WatchTarget } from "@earendil-works/pi-durable/env";
// Connection仅作类型，isConnectionLost按本模块RemoteError的lost标记判断连接故障，不把所有业务失败当掉线。
import { type Connection, isConnectionLost } from "./connection.ts";
// 统一把其他抛值映成Durable文件错误，保留已知码/路径/cause。
import { toFileError } from "./errors.ts";

/** How the daemon watches, like `NodeExecutionEnv`'s `NodeWatchOptions`. */
// 远端观察模式和预算的选项，类似本地NodeWatchOptions；客户端只转发，不在此安装OS watcher。
export interface RemoteWatchOptions {
	/** Force a mode; by default Windows and file systems that do not report remote changes poll. */
	// 可选字面量联合限定native/polling两值，具体平台默认/降级由daemon选择，类型不是运行时校验器。
	mode?: "native" | "polling";
	/** Interval between snapshots in `polling` mode; default 2000 ms. */
	// 轮询快照间隔交daemon，缺省2000ms；不是下面客户端重连的间隔。
	pollIntervalMs?: number;
	/** Most directories one watcher covers; default 10,000. */
	// 远端扫描的目录上限，缺省10000；本文件不按每次事件自己计数。
	maxDirectories?: number;
}

/** The one `overflow` change; it carries nothing else. */
// 共享的overflow标记表示一段时间覆盖不确定，应重扫全部目标，不携带“漏掉了哪些路径”的明细。
const OVERFLOW: FileChange = { kind: "overflow" };

// 每次新重连循环先等1秒，不是掉线后立刻无间隔重试。
const RECONNECT_FIRST_MS = 1000;
// 同一轮连续失败时倍增到最多30秒，无随机抖动或累计次数上限。
const RECONNECT_MAX_MS = 30_000;

/**
 * A watcher running in the daemon (Durable's `NodeFileWatcher` next to the files). When the connection is lost, it is
 * opened again once the connection can be started again, and reports `overflow`: changes in between were not seen.
 */
// 持有daemon上的长watch请求并转换事件。例await RemoteWatcher.open(conn,[{path:"/work",recursive:true}],change=>rescan(change))；首次覆盖失败直接拒绝，成功后连接丢失才自动重试并报overflow，不把间隙说成没有漏事件。
export class RemoteWatcher implements FileWatcher {
	// 同一个连接对象负责重启daemon和发帧，不复制连接或关闭其他请求。
	readonly #connection: Connection;
	// 只读数组类型限制TS修改，实际保存目标数组/对象的原引用，后续重连会重新读取它们。
	readonly #targets: readonly WatchTarget[];
	// 保存同步通知函数；=>void不要求实现没有返回值，也不表示自动await Promise。
	readonly #onChange: (change: FileChange) => void;
	// 原选项对象引用，readonly不深冻结；重连时重新展开当时的配置。
	readonly #options: RemoteWatchOptions;
	// 初始缓存native，等ready报告实际模式；change只能把它设为polling，后续新ready可重新设模式。
	#mode: "native" | "polling" = "native";
	// 本地停止门禁，true后不再开始新的onChange回调，不等于远端已确认资源全部关闭。
	#stopped = false;
	// 当前长watch请求的取消控制器，每次重连新建。
	#controller: AbortController | undefined;
	// 当前request.then派生的结算Promise，成功/预期拒绝分支通常都返回void，供stop等待。
	#request: Promise<void> | undefined;
	// 可选唤醒闭包用于打断重连等待；函数类型外加undefined，不是直接存timer句柄。
	#wake: (() => void) | undefined;

	// 仅保存依赖与状态，不发送watch；private constructor限制TS外部new，调用者用static open等覆盖建立后取实例。
	private constructor(
		// 共享底层连接。
		connection: Connection,
		// 已经解析好的目标路径列表，不在此做absolutePath转换。
		targets: readonly WatchTarget[],
		// 变更回调由交付助手统一处理同步异常和停止门禁。
		onChange: (change: FileChange) => void,
		// 模式/轮询间隔/目录上限参数对象。
		options: RemoteWatchOptions,
	) {
		// 保存连接引用。
		this.#connection = connection;
		// 保存目标原引用，没有构造时深快照。
		this.#targets = targets;
		// 保存回调原引用，尚不调用。
		this.#onChange = onChange;
		// 保存原选项，尚不启动定时器。
		this.#options = options;
	}

	/** Watch `targets` (resolved paths); fails like `NodeFileWatcher.open` if coverage cannot be established. */
	// 异步工厂：建对象→发watch→等ready覆盖确认→返回。例观察/work后收到paths时局部重扫、overflow时全扫；首次无法覆盖就reject，不在此无限重连掩盖配置错误。
	static async open(
		// 传已配置的daemon连接，必要时Connection按需握手。
		connection: Connection,
		// readonly只约束类型，路径应由上游先解析。
		targets: readonly WatchTarget[],
		// 后续通知发生在事件流中，不只发生在open这次调用期间。
		onChange: (change: FileChange) => void,
		// 缺省空对象让daemon决定默认模式和预算；不拷贝调用者显式传入的对象。
		options: RemoteWatchOptions = {},
	): Promise<RemoteWatcher> {
		// 调用私有构造器，只初始化本地包装对象。
		const watcher = new RemoteWatcher(connection, targets, onChange, options);
		// await的是#start的“ready已收到”，不是等长watch请求结束。
		await watcher.#start();
		// 成功时返回同一watcher，调用者负责之后stop。
		return watcher;
	}

	// get访问器让调用者写watcher.mode，读取当前缓存不发网络请求、不等待下次ready。
	get mode(): "native" | "polling" {
		// 返回native/polling其中一个字符串；这只是最近已收到的模式，不实时探测文件系统。
		return this.#mode;
	}

	// 幂等停止：标记停止→唤醒重连等待→取消当前请求→等其结算；例await watcher.stop(ctx)后不会新开始onChange，但不是等待调用者异步回调全部完成，context本身未使用。
	async stop(_context: Context): Promise<void> {
		// 已停止立即返回；如果先前stop仍在等待，第二次调用也不会共享等待同一Promise。
		if (this.#stopped) return;
		// 先关本地交付门禁，晚到事件不再通知用户。
		this.#stopped = true;
		// ?.只在有等待闭包时唤醒它，让重连循环有机会看到stopped。
		this.#wake?.();
		// 触发当前watch取消，Connection仍等远端终态或失联，不在这行本地立即拒绝。
		this.#controller?.abort();
		// 等待当前派生request，undefined可直接await；不单独await整个#reconnect任务，也不采用context截止时间。
		await this.#request;
	}

	// 交付一条FileChange，停止后忽略，捕获同步回调异常保证监控不因它中断；例overflow触发调用者重扫，不在此真的扫描路径。
	#deliver(change: FileChange): void {
		// 门禁在调用前检查，不取消已经开始执行的用户回调。
		if (this.#stopped) return;
		// try只保护同步函数调用，返回Promise的异步拒绝不在这个catch内。
		try {
			// 交原change引用给用户，不await、不复制或持久化日志。
			this.#onChange(change);
			// 吞同步抛出，继续保持后续监控；没有自动重试这次回调。
		} catch {
			// A throwing callback must not stop watching.
		}
	}

	/** Open the daemon's watcher; resolves once it reports coverage. */
	// 启动一次远端watch，用外层Promise报告ready/首次失败，用#request保留长请求结算；例重连成功后#reconnect另报overflow。首次native降级可能在ready前先报overflow，未知事件忽略，不在此补完整wire schema校验。
	#start(): Promise<void> {
		// Promise执行器同步安装本地请求选项，resolve/reject留给异步事件/终态使用。
		return new Promise((resolve, reject) => {
			// 本次连接是否收过ready，与全局stopped/Connection.live不是同一个状态。
			let ready = false;
			// 每次尝试独立控制器，不能沿用已aborted的signal。
			const controller = new AbortController();
			// 替换当前控制器槽，stop将取消这次watch。
			this.#controller = controller;
			// 发长生命周期watch；在途期间不断EVENT，最终RESULT/ERROR才结算request。
			const request = this.#connection.request(
				// op固定watch，实际native事件与快照扫描都在远端daemon。
				"watch",
				// JSON启动参数按此刻targets/options构造，不发JS回调。
				{
					// map创建可序列化的目标对象数组，没有对原目标排序或路径规范化。
					targets: this.#targets.map((target) => ({
						// 使用上游解析好的路径。
						path: target.path,
						// 只严格true表示递归，缺省false；不沿途追踪目录中的符号链接。
						recursive: target.recursive === true,
						// hidden在这里表示排除隐藏项；names用展开复制一层数组，缺省空数组，不复制字符串内容。
						exclude: { hidden: target.exclude?.hidden === true, names: [...(target.exclude?.names ?? [])] },
					})),
					// 展开观察配置，默认值留daemon取，不在客户端增设扫描interval。
					...this.#options,
				},
				// 本地请求选项独立于JSON，signal/函数不会被发到daemon。
				{
					// stop会abort这个signal，通知daemon结束长watch请求。
					signal: controller.signal,
					// 回调按kind分支解wire元数据，没有读payload或逐字段验证全部事件。
					onEvent: (event) => {
						// ready代表daemon已建立覆盖，而不是长请求完成。
						if (event.kind === "ready") {
							// 后续请求拒绝将按“已ready”路径决定重连或failed。
							ready = true;
							// 仅精确polling映polling，其他值包括未给都当native；不是严格模式枚举验证。
							this.#mode = event.mode === "polling" ? "polling" : "native";
							// 完成本次#start等待，长request仍留着接后续事件。
							resolve();
							// change分支转换为FileChange，和ready/终态失败分开。
						} else if (event.kind === "change") {
							// 降到polling时更新缓存，此类change不会把polling再升回native。
							if (event.mode === "polling") this.#mode = "polling";
							// The daemon's wire format: `{ overflow: true }` or `{ paths }`.
							// 严格overflow:true交共享标记，告诉用户覆盖不确定，不虚构精确变更列表。
							if (event.overflow === true) this.#deliver(OVERFLOW);
							// 否则把paths断言成string[]；as没有实际数组/元素检查，正确形状依wire契约。
							else this.#deliver({ kind: "paths", paths: event.paths as string[] });
							// error事件表示观察中失败，与Connection.request的ERROR帧拒绝是两条路径。
						} else if (event.kind === "error") {
							// 仅权限码保permission_denied，其余统归invalid，不用完整Node码表解此事件。
							const code = event.code === "permission_denied" ? "permission_denied" : "invalid";
							// String把message转文字再建FileError，交付failed；这里没有为它附带路径或RemoteError cause。
							this.#deliver({ kind: "failed", error: new FileError(code, String(event.message)) });
							// failed通知之后标停止，之后#deliver忽略事件；这里不再abort当前请求，依daemon错误事件后的终结规则。
							this.#stopped = true;
						}
					},
				},
			);
			// 给长请求装成功/失败处理，存派生Promise，不把外层ready Promise放到#request槽。
			this.#request = request.then(
				// 正常终态不主动重连，也不主动resolve未收ready的外层Promise；建立覆盖后stop的正常收尾走此分支。
				() => {},
				// unknown是请求拒绝的信任边界，后面按ready/stopped/lost分类。
				(error: unknown) => {
					// 首次ready之前失败直接拒绝#start，静态open也因此失败；重连调用方则自行决定下一步。
					if (!ready) {
						// 保留原错误拒绝，不立即转FileError或在这里重试。
						reject(error);
						// 结束这次拒绝处理，使派生#request通常正常完成。
						return;
					}
					// 已停就不再启动重连或交failed，尤其stop发出的取消不应误报故障。
					if (this.#stopped) return;
					// 只按isConnectionLost真实lost标记进入重试，不把权限/配置业务错误无限重启。
					if (isConnectionLost(error)) {
						// void只表示忽略重连Promise的返回值，不是同步完成或另起OS线程。
						void this.#reconnect();
						// 重连已安排，不再交“最终失败”事件。
						return;
					}
					// 非掉线的后续错误转FileError再交failed，告诉调用者监控结束。
					this.#deliver({ kind: "failed", error: toFileError(error) });
					// 关交付门禁，后续事件不再通知。
					this.#stopped = true;
				},
			);
		});
	}

	// 掉线后延时重试：1/2/4…最多30秒，成功ready后报overflow，非连接故障则failed停下。例断网期间可能漏变更，恢复后应全扫；循环没有最大次数，stop可打断等待和当前请求。
	async #reconnect(): Promise<void> {
		// 每轮先检查stopped，失败continue才进入倍增更新；一次重连成功返回，下次新掉线会重新从1秒起。
		for (let delay = RECONNECT_FIRST_MS; !this.#stopped; delay = Math.min(delay * 2, RECONNECT_MAX_MS)) {
			// 延时包装为Promise，让函数让出事件循环，非阻塞线程睡眠。
			await new Promise<void>((resolve) => {
				// timer到期resolve本轮等待，实际调度可晚于delay。
				const timer = setTimeout(resolve, delay);
				// unref只是不让timer独自保活Node，不等同取消或立即执行。
				timer.unref();
				// 保存闭包供stop唤醒，闭包同时持有本轮timer和resolve。
				this.#wake = () => {
					// 取消尚未触发的计时器，避免多等一个退避间隔。
					clearTimeout(timer);
					// 手动resolve让await恢复；Promise重复resolve没有第二次结算。
					resolve();
				};
			});
			// 恢复后清唤醒槽，不让未来stop反复引用已结束timer。
			this.#wake = undefined;
			// 等待中已停止就不再请求新watch。
			if (this.#stopped) return;
			// try包本次#start覆盖建立过程，不包上面整个等待阶段。
			try {
				// 向Connection发新的watch，必要时它新起daemon；等ready而非等watch结束。
				await this.#start();
				// Changes while disconnected were not seen.
				// 报告断线间隙覆盖不确定；若stop已发生，#deliver门禁会丢此通知。
				this.#deliver(OVERFLOW);
				// 本次重连成功，退出循环，接下来由新长请求的失败处理继续监控。
				return;
			} catch (error) {
				// 建立覆盖时还是连接丢失就继续退避重试，不马上回调failed。
				if (isConnectionLost(error)) continue;
				// 其他建立失败映成FileError交failed，终结重连，不重复错误回调。
				this.#deliver({ kind: "failed", error: toFileError(error) });
				// 标停止阻止未来交付/重连。
				this.#stopped = true;
				// 结束重连函数，不再执行下一轮倍增。
				return;
			}
		}
	}
}
