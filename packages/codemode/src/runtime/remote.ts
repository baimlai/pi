/**
 * codemode远端后端分两半：客户端保留工具实现/结果/取消，服务端只运行QuickJS并通过exchange回传调用。
 * 传输由宿主注入，可以是真RPC也可以是进程内对象；这里没有硬编码URL或直接HTTP请求。
 * 输出分批减小交换开销，停止通过交换回复stop协作传递，不保证远程同步计算立即停止。
 */
/**
 * Runs the VM in another isolate, reached over an RPC boundary such as a Cloudflare Durable Object
 * stub, while tools keep running in the caller.
 *
 * Problem: a VM on the calling thread blocks that thread while the script computes. In a Durable
 * Object that serves an agent session, a CPU-heavy script would stall every other request to the
 * session (including the user's abort) for seconds. Measured on Cloudflare (October 2026), a
 * script that computed for 10 seconds delayed the session's other requests by 10 seconds when it
 * ran in the session object or in a Dynamic Worker, but by about 50 ms when it ran in a Durable
 * Object of a separately deployed Worker.
 *
 * Solution: the caller keeps the host role (`RemoteCodemodeSandbox`: tools, call records,
 * deadline, abort) and the remote side only runs the VM (`serveCodemodeRemote`, behind
 * `CodemodeSandboxDurableObject` in `@earendil-works/pi-codemode/cloudflare`).
 *
 * Protocol, one RPC call per execution:
 *
 *     client                                     remote
 *     remote.execute(request, exchange) ───────▶ starts the VM (in-thread, with interrupt budget)
 *                                      ◀─────── exchange([...outputs, call])   one call per tool call
 *     runs the tool, replies with result ──────▶ VM continues
 *                                      ◀─────── exchange([...outputs, done])   terminal, reply ignored
 *     execute() resolves ◀────────────────────── VM disposed
 *
 * `exchange` is a function the client passes in; over Workers RPC it becomes a stub that calls back
 * into the client. Output is buffered on the remote side and sent with the next call or the
 * terminal message, so a script that prints in a loop does not make one RPC per line. Each
 * `exchange` carries at most one call, so concurrent tool calls are concurrent RPCs. Calls on one
 * stub are delivered in order, which keeps output ordered before the call or result that follows.
 *
 * Termination: the client cannot interrupt a remote VM that is computing. When the client finishes
 * first (deadline, abort, `close()`), it answers every pending and later `exchange` with
 * `{ type: "stop" }`, and the remote stops the VM at that point. A script that computes without
 * calling a tool runs until its interrupt budget is used up. The remote reports that as a
 * `failure` message, which the client turns into the same `kind: "timeout"` error an in-thread
 * VM produces.
 *
 * Failure: if the RPC call rejects (the remote isolate crashed, hit its CPU limit, or was
 * redeployed) or returns without a terminal message, the execution fails with `kind: "sandbox"`.
 */
// 共享错误与公共沙箱配置仅作类型，编译后擦除。
import type { CodemodeError, CodemodeSandboxBaseOptions } from "../types.ts";
// 只取WASM模块类型，不引入Node读文件函数。
import type { CodemodeWasmModule } from "../wasm.ts";
// 公共宿主执行器仍在客户端跑工具，VmChannel/Launcher描述后端桥。
import { CodemodeSandboxBase, errorMessage, type VmChannel, type VmLauncher } from "./execution.ts";
// 服务端复用调用线程VM和中断额度，不依赖Node worker。
import { DEFAULT_INTERRUPT_BUDGET, inlineLauncher } from "./inline.ts";
// 运行守卫与擦除的协议类型混合导入。
import {
	// 宿主回答调用的消息。
	type HostToWorkerMessage,
	// 仅识别已知消息type，不深验每个载荷字段。
	isWorkerToHostMessage,
	// 服务端VM启动数据。
	type VmStartData,
	// VM输出/调用/终态/进度消息联合。
	type WorkerToHostMessage,
} from "./protocol.ts";

/** 每次远端执行的请求包；数据可经RPC传输，宿主工具闭包不在其中。 */
export interface CodemodeRemoteRequest {
	// code、目录、store、内存及可选确定性初值。
	data: VmStartData;
	/** Requested interrupt budget. The remote may lower it, see {@link CodemodeServeOptions}. */
	// 请求的轮询额度，服务端会和自己的上限取min；不是毫秒数。
	interruptBudget?: number;
}

/** What the remote sends to the client: VM messages, or a failure outside the VM bridge. */
// 联合补failure分支，区分VM消息和远端服务/传输层故障。
export type CodemodeRemoteMessage = WorkerToHostMessage | { type: "failure"; error: CodemodeError };

/**
 * The client's answer to an exchange: the result of the call the exchange carried, `null` when it
 * carried no call, or `stop` once the client no longer wants the execution.
 */
// null表示这一批没调用需回答；stop表示客户端已结束，其余是针对该批调用的result。
export type CodemodeRemoteReply = HostToWorkerMessage | { type: "stop" } | null;

/** 反向交换回调：服务端交一批消息，Promise最终给一条回复。工具可并发发起，所以可同时有多份exchange等待。 */
export type CodemodeRemoteExchange = (messages: CodemodeRemoteMessage[]) => Promise<CodemodeRemoteReply>;

/**
 * The remote end, usually a Durable Object stub for `CodemodeSandboxDurableObject`. Anything with
 * this method works, for example an in-process object in tests.
 */
/** 远端能力的最小接口，既可是真Cloudflare RPC stub，也可为进程内对象；不硬编码网络/URL协议。 */
export interface CodemodeRemote {
	/** 服务端接受启动请求并借exchange反向交调用/输出；例如echo调用须回到客户端工具实现，服务端本身无工具闭包。 */
	execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void>;
}

/** 继承公共宿主参数，加远端对象工厂及请求额度；构造只保存工厂，执行时才选远端实例。 */
export interface RemoteCodemodeSandboxOptions extends CodemodeSandboxBaseOptions {
	/**
	 * Returns the remote that runs one execution, called once per `execute()`. For a Durable Object,
	 * pick the instance here, for example `() => env.CODEMODE_SANDBOX.getByName(sessionId)`.
	 */
	// 每次后端启动调用一次，包括execute或start；例如用sessionId选择同一对象。
	remote: () => CodemodeRemote;
	/** Interrupt budget requested from the remote. Default: the remote's default. */
	// 未提供就省略请求字段，让服务端采用自己的默认额度。
	interruptBudget?: number;
}

/** Output buffered on the remote before it is flushed without waiting for a call. */
// 缓冲区累计到1000条时发批；started等消息也可占数组项，不是严格1000条输出才发送。
const FLUSH_ITEMS = 1_000;
// 1<<20为1048576个文本/base64码元；这是flush阈值，不是单批大小硬上限或总输出额度。
const FLUSH_CHARS = 1 << 20;

/** 服务端配置与客户端请求分开，服务端决定自己的WASM和额度上限。 */
export interface CodemodeServeOptions {
	// 编译模块或其Promise，服务端调用线程VM使用它。
	wasm: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	/** Upper bound for a request's interrupt budget, and the budget when a request names none. */
	// 未设采用inline默认；正常数值请求取min，未另检有限/正整数。
	maxInterruptBudget?: number;
	/** Upper bound for a request's VM memory, and the limit when a request names none. */
	// 未设则不在remote服务层额外限堆，底层VM/平台仍可能有限制。
	maxMemoryLimitBytes?: number;
}

/**
 * Remote side of {@link RemoteCodemodeSandbox}: runs one execution's VM on this thread and
 * forwards everything it reports through `exchange`. Resolves once the VM has stopped and the
 * terminal message has been delivered, or the client asked to stop. Never rejects.
 */
/**
 * 服务端的一次执行：夹住请求额度→启动inline VM→缓冲输出→exchange交回调用→递交回复→终态清理。
 * 例脚本await tools.echo(1)：VM发call→exchange到客户端→客户端执行echo→result回服务端→VM继续。
 * 正常协议下等终态交付及当时已有通道的停止请求后resolve；通道晚到则另行停止，终态交付拒绝和stop拒绝被忽略。
 * exchange若同步throw，不由紧接的Promise.catch捕获；异常可能逸出消息回调并使外层Promise悬空，不能把原说明当所有异常都归一的保证。
 * VM在本线程计算，客户端取消只能通过交换回stop或服务端轮询额度响应，不是跨isolate即时强杀。
 */
export function serveCodemodeRemote(
	// 请求仅含启动数据/额度，不含客户端工具实现。
	request: CodemodeRemoteRequest,
	// 服务端通过此回调向客户端发消息，可由平台RPC代理。
	exchange: CodemodeRemoteExchange,
	// 服务端自己的WASM和最大限制，不受客户端任意覆盖。
	options: CodemodeServeOptions,
): Promise<void> {
	// 服务端轮询默认来自inline常量，缺失才填。
	const maxBudget = options.maxInterruptBudget ?? DEFAULT_INTERRUPT_BUDGET;
	// 正常数值时客户端只能请求更少；NaN/负数等并未在此独立拒绝。
	const budget = Math.min(request.interruptBudget ?? maxBudget, maxBudget);
	// 客户端请求的VM堆额度。
	const requestedMemory = request.data.memoryLimitBytes;
	// 服务端配置的最大VM堆额度，可能没设。
	const maxMemory = options.maxMemoryLimitBytes;
	// 分别处理请求缺失和服务端未设上限，不把undefined交Math.min造成NaN。
	const memoryLimitBytes =
		// 客户端没请求，直接用服务端上限。
		requestedMemory === undefined
			? // 也可undefined，交底层默认。
				maxMemory
			: // 客户端有请求但服务端未设上限。
				maxMemory === undefined
				? // 保留请求值。
					requestedMemory
				: // 两边都有时取较小值，不原地修改请求。
					Math.min(requestedMemory, maxMemory);
	// 浅复制启动包，只覆盖上面选定的堆额度，其余code/store/声明原样。
	const data: VmStartData = { ...request.data, memoryLimitBytes };

	// 外层Promise在end完成清理链后resolve，不直接返回inline启动Promise。
	return new Promise<void>((resolve) => {
		// inline创建VM期间通道尚不存在，但可能已发消息。
		let channel: VmChannel | undefined;
		// 第一次end胜出；后来的消息/回复不再推进VM。
		let ended = false;
		// 待发送VM消息，不是宿主工具结果队列。
		let buffered: CodemodeRemoteMessage[] = [];
		// 只累计output的文本/base64长度，非JSON包全部字节。
		let bufferedChars = 0;
		/** Replies that arrived before the launcher returned the channel. */
		// 通道尚未交回时收到的客户端结果暂存。
		const unsent: HostToWorkerMessage[] = [];

		/** 同步取当前数组引用并换空缓冲，重置码元计数；不复制批内对象，无IO。 */
		const takeBuffer = (): CodemodeRemoteMessage[] => {
			// 保存旧数组引用作为即将发出的批。
			const batch = buffered;
			// 后续输出用新数组，不继续追加到正在exchange的批。
			buffered = [];
			// 新批计数从0开始。
			bufferedChars = 0;
			// 把旧批交调用方，不等待网络或RPC。
			return batch;
		};
		/** 第一次结束时带终态发送剩余缓冲，或响应stop直接丢弃缓冲；等交付/停止请求结算再resolve，不等待客户端宿主工具真的结束。 */
		const end = (terminal: CodemodeRemoteMessage | undefined): void => {
			// 防多个done/failure/stop竞争重复清理。
			if (ended) return;
			// 先置位，后面的消息/回复无操作。
			ended = true;
			// 取走当前未发输出；无terminal路径不会再把这些输出发给客户端。
			const batch = takeBuffer();
			// 有终态先附在批尾exchange，拒绝转null；无终态立即完成。同步throw不由这个.catch捕获。
			const delivered = terminal ? exchange([...batch, terminal]).catch(() => null) : Promise.resolve();
			// 不await此链，靠最终resolve完成外层Promise。
			void delivered
				// 等交付后再stop已拿到的inline通道；通道晚到另有清理分支。
				.then(() => channel?.stop())
				// 交付后清理若拒绝，仍不阻止服务端完成。
				.catch(() => undefined)
				// 完成这一服务端执行Promise，没有返回脚本结果对象。
				.then(() => resolve());
		};
		/** 处理一批exchange的客户端回答：null忽略、stop触发结束、result进VM或早到队列。例工具await期间收到result才恢复脚本。 */
		const reply = (message: CodemodeRemoteReply): void => {
			// 已结束的迟到结果不恢复VM；没有调用的批返回null无操作。
			if (ended || message === null) return;
			// 客户端已不需要本执行。
			if (message.type === "stop") {
				// 无终态结束，不再发剩余缓冲。
				end(undefined);
				// 不把stop当工具结果递交。
				return;
			}
			// 通道已就绪就递交回复；普通模式立即应用，start可能先按seq缓冲，补齐缺口后才恢复VM。
			if (channel) channel.post(message);
			// 通道未就绪则暂存，稍后flush。
			else unsent.push(message);
		};
		/** inline VM消息回调，按输出缓冲/进度即时交换/终态分流；来自自有inline驱动，as仅是类型断言，不额外验证每字段。 */
		const onMessage = (message: unknown): void => {
			// end以后忽略消息，不给旧执行继续添缓冲。
			if (ended) return;
			// static断言无运行时转换；真正传输未知数据由客户端公共层识别/解码。
			const typed = message as WorkerToHostMessage;
			// 利用type标签分派。
			switch (typed.type) {
				// 文本或图片输出先进入批缓冲。
				case "output": {
					// 推原消息对象，不深复制。
					buffered.push(typed);
					// 文本length或base64 length；未统计MIME/JSON包壳。
					bufferedChars += typed.item.type === "text" ? typed.item.text.length : typed.item.data.length;
					// 任一阈值满足即flush，一条超大输出可让单批超过阈值。
					if (buffered.length >= FLUSH_ITEMS || bufferedChars >= FLUSH_CHARS) {
						// 发批后立刻继续收消息，不等这份交换完成；没有在这里限制所有在途批的总内存。
						exchange(takeBuffer()).then(reply, () => end(undefined));
					}
					// 本次输出处理完，等待其他消息。
					break;
				}
				// 确定性启动指纹先缓存，通常与后续call/idle一起发。
				case "started":
					// started没有文本码元计数，但占buffered数组条数。
					buffered.push(typed);
					// 不立即为这一条单独做exchange。
					break;
				// Sent at once: a host replaying a script waits for it to see that the script issued no further call.
				// 工具/全局调用必须及时交客户端运行。
				case "call":
				// idle也必须及时交给可重放宿主，不能一直等后续输出。
				case "idle":
					// 先带此前缓冲，再附当前call/idle；每次正常批至多一条call，交换拒绝会结束服务端。
					exchange([...takeBuffer(), typed]).then(reply, () => end(undefined));
					// 多条调用可以有并行exchange，不阻塞其他等待。
					break;
				// done/crash等剩余类型作为终态处理。
				default:
					// 剩余缓冲与终态一起交付，然后清理。
					end(typed);
			}
		};

		// 每次服务端执行建立一个inline启动器，使用夹过的轮询额度。
		const launch = inlineLauncher(options.wasm, budget);
		// 同化同步/异步通道；inlineLauncher本身返回async函数。
		Promise.resolve(
			// 启动本线程VM，可能在通道Promise完成前先报告消息。
			launch(data, {
				// 上面实现的缓冲/交换回调。
				message: onMessage,
				// VM/加载错误转failure终态交客户端，不伪装脚本throw。
				failure: (error) => end({ type: "failure", error }),
			}),
		).then(
			// 启动完成拿到通道。
			(started) => {
				// 先保存便于正常回复/end清理。
				channel = started;
				// 启动中已经end，不能再启动后续业务。
				if (ended) {
					// 对迟到VM请求停止，忽略拒绝，不重开外层Promise。
					void started.stop().catch(() => undefined);
					// 不flush已经结束执行的早到结果。
					return;
				}
				// 依次发出通道建立前收到的工具回答并清空队列。
				for (const message of unsent.splice(0)) started.post(message);
			},
			// 启动失败包装sandbox failure；未知异常转消息，end处理首次终态。
			(error: unknown) => end({ type: "failure", error: { kind: "sandbox", message: errorMessage(error) } }),
		);
	});
}

/**
 * 客户端后端闭包：选远端→提交一次execute(request,exchange)→把回调消息交公共Execution。
 * exchange携call时先登记等待resolver，宿主post再完成对应Promise；没call返回null；stop完成全部等待并让后续交换回stop。
 * 返回通信通道时不等远端脚本结束；整体结果仍由公共Execution决定，工具继续在客户端运行。
 */
function remoteLauncher(remote: () => CodemodeRemote, interruptBudget: number | undefined): VmLauncher {
	// 启动函数同步交出通道，真正远端execute排到Promise微任务。
	return (data, events) => {
		// 客户端停止后不再接受新消息，后续exchange直接回stop。
		let stopped = false;
		// 是否已收到VM终态/failure，区分远端正常回传与无终态消失。
		let settled = false;
		// 调用id→该次exchange的回复完成函数；每个等待项至多完成一次。
		const waiting = new Map<number, (reply: CodemodeRemoteReply) => void>();

		/** 远端反向回调，返回Promise；正常一批call绑定一个等待者，其他输出/idle批不需要工具回复。 */
		const exchange: CodemodeRemoteExchange = (messages) =>
			// 保存resolve等待宿主工具返回，executor同步运行。
			new Promise<CodemodeRemoteReply>((resolve) => {
				// RPC/wire数组边界；已stopped或批不是数组，直接告知远端停止。
				if (stopped || !Array.isArray(messages)) {
					// 以正常回复形式传stop，不向远端throw取消异常。
					resolve({ type: "stop" });
					// 不处理这批迟到/无效消息。
					return;
				}
				// Register the waiter first: the host may answer a call synchronously, for example when the
				// tool throws before returning a promise.
				// 找该批第一条已知call外壳；只处理首条call等待，正常服务端保证一批至多一条。
				const call = messages.find((message) => isWorkerToHostMessage(message) && message.type === "call");
				// 必须先登记，因宿主工具可能同步throw并立即post回复。
				if (call?.type === "call") waiting.set(call.id, resolve);
				// 纯输出/进度/终态批无需等待，立即resolve(null)，仍继续分派消息。
				else resolve(null);
				// 按本批数组顺序交公共层；跨RPC的到达顺序由实际传输和start seq规则决定。
				for (const message of messages) {
					// wire故障外壳单独转events.failure；这里只检查对象/type，error形状没有深验。
					if (typeof message === "object" && message !== null && message.type === "failure") {
						// 标记有终态，防远端execute完成后误报没有结果。
						settled = true;
						// 公共Execution决定首次结果；后续failure不会覆盖已经finished。
						events.failure(message.error);
						// failure不再作为普通VM消息重复发送。
						continue;
					}
					// Malformed messages still go to the host, which fails the execution as a broken bridge.
					// 其余即使格式不完整也交公共层，由已实现解码分支决定处理/失败。
					events.message(message);
					// done/crash已知外壳意味着远端有终态；守卫不保证每字段合法。
					if (isWorkerToHostMessage(message) && (message.type === "done" || message.type === "crash"))
						// 此标志仅用于远端生命周期回调，不是公共Execution.finished。
						settled = true;
				}
			});

		// 本次远端对象/stub。
		let target: CodemodeRemote;
		// remote工厂同步throw要包装成定位远端失败。
		try {
			// 每启动一次调用一次，调用方可按sessionId或随机id选不同实例。
			target = remote();
		} catch (error) {
			// 交公共Execution启动失败路径，归sandbox。
			throw new Error(`Failed to reach the remote sandbox: ${errorMessage(error)}`);
		}
		// 未设置请求额度就完全省字段，保留服务端默认；data浅引用保留。
		const request: CodemodeRemoteRequest = interruptBudget === undefined ? { data } : { data, interruptBudget };
		// 先建立已完成Promise，后续then把远端执行排到微任务并捕获同步throw。
		Promise.resolve()
			// 不等待服务端结束才交宿主通道；整个远端执行完成由下一then监视。
			.then(() => target.execute(request, exchange))
			// 分开处理远端正常返回与拒绝。
			.then(
				// 远端execute的Promise已正常完成。
				() => {
					// 没见终态且客户端也没停止，说明远端无声提前离开。
					if (!settled && !stopped) {
						// 用sandbox错误终止等待，避免宿主永久悬空。
						events.failure({ kind: "sandbox", message: "Remote sandbox returned before the script settled" });
					}
				},
				// 远端RPC/服务可能拒绝，错误不一定是Error。
				(error: unknown) => {
					// 客户端主动停止后不再为迟到拒绝生成新失败。
					if (!stopped)
						// 未主动停时交公共层；已有finished仍由公共层忽略。
						events.failure({ kind: "sandbox", message: `Remote sandbox failed: ${errorMessage(error)}` });
				},
			);

		// 立即交回客户端通道，外部Execution后续用它回答工具/取消。
		return {
			/** 发一条工具结果，完成等待该id的exchange；未知/迟到id直接忽略，不另开RPC。 */
			post: (message) => {
				// 找远端该次call所挂的Promise完成函数。
				const resolve = waiting.get(message.id);
				// 没等待者通常是已结束或已经回复，不再重复发。
				if (!resolve) return;
				// 先移除再resolve，避免同id重复回答。
				waiting.delete(message.id);
				// 远端await exchange得到这条result，继续递交其VM。
				resolve(message);
			},
			/** 请求远端停止：让当前及未来exchange回stop；立即完成，不等远端执行Promise或宿主工具实际退出。 */
			stop: async () => {
				// 后续批在exchange入口直接回stop。
				stopped = true;
				// 当前所有等待工具的交换都收到stop，不等待工具实现自己结束。
				for (const resolve of waiting.values()) resolve({ type: "stop" });
				// 清等待表，迟到工具post无操作；不回滚已经发生的IO。
				waiting.clear();
			},
		};
	};
}

/**
 * Runs each execution's VM on a remote, usually a Cloudflare Durable Object deployed with
 * `CodemodeSandboxDurableObject`, while tools run here. Same API and results as
 * `CodemodeSandbox`, so it can replace it. Differences: a script that computes without calling a
 * tool is limited by the remote's interrupt budget rather than `timeoutMs`, and after a deadline or
 * abort the remote VM keeps computing until it next calls a tool or uses up that budget.
 */
/** 客户端公共API：工具/结果/时限在这里，VM在注入的远端。例new RemoteCodemodeSandbox({remote:()=>stub,tools})；构造不会访问远端。 */
export class RemoteCodemodeSandbox extends CodemodeSandboxBase {
	/** 把公共配置与远端启动闭包交父类；request额度可缺，由服务端决定实际上限。 */
	constructor(options: RemoteCodemodeSandboxOptions) {
		// remoteLauncher此时只生成函数，不调用remote工厂或RPC。
		super(options, remoteLauncher(options.remote, options.interruptBudget));
	}
}
