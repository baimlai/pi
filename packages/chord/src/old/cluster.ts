/*
 * 文件导读
 * ========
 * 所属：packages/chord/src/old 的 Chord v1 集群重载协调层（旧实现）。本文件让一个“服务器”host 把一次热重载
 * 作为分布式事务，与所有已同步的子 host 一起 prepare/commit/abort；同时负责把落后于服务器代码版本的子 host
 * 通过重载追平（reconcile）。
 *
 * 职责边界：
 * - 负责：选出参与者、生成投票 id 与截止时间、发送 prepare/commit/abort 帧、汇总子 host 的 ReloadReport、
 *   在子 host 侧响应 prepare/vote/commit/abort，以及在父链接丢失时回滚。
 * - 不负责：真正加载 facet、准备对象、安装代码版本和迁移状态——这些由 reload.ts 的 beginReload/Reload 完成；
 *   也不负责帧的编解码与传输（wire.ts/connection.ts/link.ts）。
 * - 浏览器等 client 不是重载参与者：它们只会看到 shape/reset 推送或 upgrade_required。
 *
 * 上游入口：
 * - `HostImpl.reload()`（host.ts）在存在子 host 或配置了 remote/remoteRemove 时调用 `runClusterReload`；
 * - `HostImpl.peerHello()` 发现子 host 的 codeVersion 落后时调用 `reconcileChild`；
 * - `HostImpl.onReloadFrame()` 把父进程发来的 prepare/commit/abort 交给 `ChildReloads.handle`。
 * 下游依赖：reload.ts（beginReload/endReload/Reload/ReloadReport/reloadError）、connection.ts（Connection.send、
 * votes、peerCodeVersion、markSynced、open）、wire.ts（Frame、toWireError）、errors.ts（ChordError）。
 * 结果与错误：服务器侧返回聚合后的 ReloadReport（children 字段带每个子 host 的报告）；任何参与者失败都会先向
 * 所有参与者发 abort、回滚本地，再把第一个失败原因抛出。错误保留底层错误码（如 contract_mismatch/invalid），
 * 消息前加上子 host 名称或 "reload aborted"。
 *
 * 能力清单（按导出项）：
 * - `runClusterReload(host, plugins, options)`：服务器侧的集群重载事务，返回含 children 的报告。
 * - `reconcileChild(host, connection)`：把落后的子 host 重载到服务器当前代码版本，成功后标记 synced。
 * - `ChildReloads`：子 host 侧的单槽重载状态机；`handle` 处理 prepare/commit/abort，`parentLost` 处理父链接断开。
 * 文件内辅助：`reloadSeq`（投票 id 计数器）、`modulesFor`（按 host 名前缀选 facet 模块）、`awaitVote`（带超时的
 * 投票 Promise）、`ChildOperation`（子 host 侧一次 prepare 的状态）。
 *
 * 协议顺序（也是阅读顺序）：
 *   server: waitForRetirement → 向每个 synced child 发 prepare → 本地 prepare 与投票并行等待
 *   全部成功 → 本地 commit（安装代码版本）→ 在 commit 的回调里向每个 child 发 commit → 运行新版本任务/回调
 *   任一失败 → 向所有参与者发 abort → 本地 rollback → 抛错
 *   child: 收到 prepare → beginReload → prepare → 回 vote（report 或 error）→ 等 commit 或 abort
 * 链接是 FIFO：服务器在本地 commit 之后再发 commit 帧，保证子 host 先提交，然后才可能收到新代码版本根调用。
 *
 * 示例（真实签名；server 是没有父链接的 host）：
 *   const report = await server.reload([], { remote: { "session:": ["greeter"] } });
 *   report.children?.["session:S1"]?.changed; // 该子 host 本次变化的 facet
 * 注意：`remote` 的键是 host 名前缀，最长匹配者生效；未匹配的 host 收到空模块列表。
 *
 * 建议阅读顺序：先读文件顶部英文协议注释和 `runClusterReload`，再看 `reconcileChild` 的补偿循环，最后读
 * `ChildOperation`/`ChildReloads` 处理异步 abort 与父链接丢失的状态机。
 */
// Connection 只作为类型使用：本文件调用它的 send/votes/open 等成员，不构造连接。
import type { Connection } from "./connection.ts";
// ChordError 用于投票超时、重复重载、转发子 host 失败原因等错误。
import { ChordError } from "./errors.ts";
// HostImpl 与 PluginRef 只作为类型：运行时的 host 由 host.ts 构造并传入。
import type { HostImpl, PluginRef } from "./host.ts";
// 重载实现：beginReload 取得重载槽，Reload.prepare/commit/rollback 完成实际安装与回滚。
import { beginReload, endReload, type Reload, type ReloadOptions, type ReloadReport, reloadError } from "./reload.ts";
// wire.ts 的 Frame 定义 prepare/vote/commit/abort 帧；toWireError 把异常转成可传输的错误对象。
import { type Frame, toWireError } from "./wire.ts";

// 下面这段英文注释是协议总览；各分支的细节在对应函数前解释。
// Cross-host reload, coordinated by the server (the host without a parent):
//   server: prepare itself and send `prepare` to every synced child host; collect votes
//   all ok: the server installs its new code version, sends `commit` to every child, and only then starts what may make
// new-code-version calls (tasks, listener and registry callbacks). Links are FIFO, so a child commits before it
//           can receive any frame of a root started in the new code version.
//   any failure or missed vote deadline: `abort` everywhere; each host rolls back to where it was.
// Clients (browsers) are not participants: they see shape/reset pushes, or `upgrade_required`.
// A child that connects behind the server's code version is fenced and reconciled with the same protocol.

// 进程内单调递增的投票 id：同一个 id 广播给所有子 host，但每个 Connection 的 votes Map 各自独立，
// 因此 id 只需在本进程内唯一，避免旧投票被新 prepare 复用。
let reloadSeq = 0;

// modulesFor 按 host 名前缀选择 facet 模块列表：遍历 remote 配置，取最长匹配前缀；没有匹配则空数组。
const modulesFor = (remote: ReloadOptions["remote"], hostName: string | undefined): string[] => {
	// best 保存当前最优的 [前缀, 模块列表]；readonly string[] 表示不修改配置里的数组。
	let best: [string, readonly string[]] | undefined;
	// remote 可能是 undefined（未配置）；?? {} 让它可遍历。Object.entries 得到 [前缀, 模块列表]。
	for (const entry of Object.entries(remote ?? {})) {
		// hostName?.startsWith 在 hostName undefined 时得到 undefined（假值），因此未命名连接不匹配任何前缀。
		// 更长的前缀优先，实现“最长匹配”。
		if (hostName?.startsWith(entry[0]) && (best === undefined || entry[0].length > best[0].length)) best = entry;
	}
	// 返回数组副本：调用方（发送帧）不应持有并修改 host 保存的配置数组。
	return [...(best?.[1] ?? [])];
};

// awaitVote 注册一个待兑现的投票，并在 deadline 毫秒后拒绝；返回值与 connection.votes 中的条目共享 resolve/reject。
/** A vote, or its rejection after `deadline` milliseconds. */
// 返回 Promise<unknown>，因为子 host 的 vote report 形状由 wire 校验，调用方再按需断言。
function awaitVote(connection: Connection, id: number, deadline: number): Promise<unknown> {
	// timer 声明在 Promise 外部，便于 finally 清理；类型用 ReturnType<typeof setTimeout> 兼容 Node/浏览器。
	let timer: ReturnType<typeof setTimeout> | undefined;
	// 创建未决 Promise；executor 同步执行，因此在返回前就完成注册。
	const vote = new Promise<unknown>((resolve, reject) => {
		// 把 resolve/reject 放进连接的 votes 表；收到 vote 帧时按 id 取出并兑现。
		connection.votes.set(id, { resolve, reject });
		// 超时回调：先删除条目，再以 aborted/vote_deadline 拒绝。
		timer = setTimeout(() => {
			// 删除后即使迟到的 vote 到达也不会再次兑现。
			connection.votes.delete(id);
			// reason 是 ChordErrorReason，用于区分“投票缺失”而不是普通取消。
			reject(new ChordError("aborted", `votes missing after ${deadline} ms`, { reason: "vote_deadline" }));
		}, deadline);
	});
	// finally 在 resolve/reject 后都清理定时器；它返回的新 Promise 保持原完成/拒绝值。
	return vote.finally(() => clearTimeout(timer));
}

// runClusterReload：服务器侧入口。它先固定参与者快照，再取下一个代码版本号并占用 host 的重载槽。
export async function runClusterReload(
	host: HostImpl,
	plugins: readonly PluginRef[],
	options: ReloadOptions,
): Promise<ReloadReport> {
	// 参与者在事务开始时确定：角色为 downstream、对端是 host、链接仍打开且已经 synced。
	// 落后（fenced）的子 host 不参与，会在之后通过 reconcileChild 追平；重载期间新 hello 的子 host 由 host 延后处理。
	// Participants are the children in step now. Fenced children (behind, being reconciled) reconcile to the new code
	// version afterwards; a child whose hello arrives while the reload runs is synced or reconciled once it ends
	// (`HostImpl.peerHello`).
	// [...host.connections] 复制 Set，避免遍历期间连接增删影响快照。
	const synced = [...host.connections].filter(
		(connection) =>
			// 四个条件缺一不可：子方向、host 对端、打开、已同步。
			connection.role === "downstream" && connection.peer.kind === "host" && connection.open && connection.synced,
	);
	// 先窥视下一个代码版本号（不分配），再把它传给 beginReload，使 pending 与 prepare 帧使用同一个 id。
	const codeVersion = host.peekNextCodeVersion();
	// beginReload 会检查重载槽并加载插件模块；失败会自行释放槽并抛 reloadError。
	const reload = await beginReload(host, plugins, options, codeVersion);
	// try/finally 保证无论成功失败都调用 endReload，释放重载槽并处理延后的 hello。
	try {
		// 先等旧代码版本退役：retire 帧与后续 prepare 帧走同一 FIFO 链接，子 host 不会在仍有旧根时退役旧版本。
		// Retire first: its `retire` frames reach every child before `prepare` (FIFO), so a child never retires a code
		// version this host still runs roots of.
		// 等待期间链接可能关闭，因此参与者要重新过滤 open。
		await reload.waitForRetirement();
		// 重新过滤：已关闭的链接不再发送 prepare，也不等待其投票。
		const participants = synced.filter((connection) => connection.open);
		// 每次集群事务分配一个投票 id；++ 前缀使其先自增再使用。
		const id = ++reloadSeq;
		// 默认票截止时间覆盖“本地 gate + 子 host retire + 额外 5 秒”；显式 voteDeadline 优先。
		const deadline = options.voteDeadline ?? (options.gateDeadline ?? 5000) + (options.retireDeadline ?? 5000) + 5000;
		// 为每个参与者创建 vote Promise 并立即发送 prepare；map 返回的是“等到该子 host 结果”的 Promise。
		const votes = participants.map((connection) => {
			// name 用于错误消息、children 报告的键，也用于按前缀选择模块；未命名时用占位符 child（通常匹配不到带名前缀）。
			const name = connection.name ?? "child";
			// 先注册投票再发送 prepare，避免子 host 的 vote 在注册前到达而被丢弃。
			const vote = awaitVote(connection, id, deadline);
			// prepare 帧携带事务 id、目标代码版本、该子 host 名称匹配到的模块和删除列表。
			connection.send({
				t: "prepare",
				reload: id,
				codeVersion,
				// remote 配置按 host 名前缀筛选；子 host 只加载属于自己的 facet 模块。
				plugins: modulesFor(options.remote, name),
				// options 只转发超时等重载选项，不转发 remote（那是服务器侧配置）。
				options: {
					// remove 同样是按前缀筛选后的 facet 名列表。
					remove: modulesFor(options.remoteRemove, name),
					gateDeadline: options.gateDeadline,
					retireDeadline: options.retireDeadline,
				},
			});
			// vote 成功时返回 [name, report|undefined]；失败时包装成带 host 名前缀的 ChordError。
			// 保留 cause.code/reason，使上层仍能按 contract_mismatch/invalid 等码分支。
			return vote.then(
				// 成功值的类型是只读元组；report 可能为 undefined（子 host 未提供报告）。
				(report) => [name, report as ReloadReport | undefined] as const,
				// 失败回调把子 host 的错误重新包装：消息加名字，cause 指向原错误，code/reason 原样保留。
				(error: unknown) => {
					const cause = reloadError(error);
					// 重新抛出包装后的错误；Promise.allSettled 会把它记为 rejected。
					throw new ChordError(cause.code, `${name}: ${cause.message}`, { cause, reason: cause.reason });
				},
			);
		});
		// local 标记本地 prepare 是否成功，决定失败时是否需要回滚本地。
		let local = false;
		// allSettled 等所有结果，不会因为一个失败提前返回；本地 prepare 与所有投票并行。
		const results = await Promise.allSettled([
			// 本地 prepare 成功后才把 local 置 true；失败时 Reload.prepare 已经自行 rollback。
			reload
				.prepare()
				.then(() => {
					local = true;
				}),
			...votes,
		]);
		// 只取第一个 rejected 作为最终错误：数组顺序是“本地 prepare，然后按参与者顺序”。
		const failed = results.find((result) => result.status === "rejected");
		// 有任一失败：通知所有参与者放弃，并回滚已经准备好的本地状态。
		if (failed !== undefined) {
			// 先清理每个连接的投票表，避免迟到的 vote 被误兑现；再发 abort。
			for (const connection of participants) {
				// 删除投票条目；连接可能已关闭，但 Map 操作无害。
				connection.votes.delete(id);
				// abort 让子 host 回滚并释放自己的重载槽。
				connection.send({ t: "abort", reload: id });
			}
			// 只有本地 prepare 成功时才需要 rollback；否则 prepare 内部已经回滚。
			if (local) await reload.rollback();
			// 抛出第一个失败原因（可能是子 host 包装后的 ChordError）。
			throw failed.reason;
		}
		// 全部成功：commit 在 holdPublications 中安装新代码版本；回调在安装后、启动新任务前执行。
		const report = reload.commit(() => {
			// 在回调里发送 commit 帧：此时服务器已安装但尚未启动可能发起新版本调用的任务，链接 FIFO 保证子 host 先提交。
			for (const connection of participants) {
				connection.send({ t: "commit", reload: id });
				// 乐观记录子 host 的代码版本；后续帧可按新版本处理。
				connection.peerCodeVersion = codeVersion;
			}
		});
		// 记住本次 remote/remoteRemove 的映射，供之后重连或落后子 host 的 reconcile 使用。
		host.rememberRemoteModules(options.remote, options.remoteRemove);
		// children 汇总每个子 host 的 ReloadReport，键是 host 名。
		const children: Record<string, ReloadReport> = {};
		// results[0] 是本地 prepare，跳过；其余是各个投票结果。
		for (const result of results.slice(1)) {
			// 失败结果前面已经统一抛错，这里只处理 fulfilled；类型收窄后 value 可用。
			if (result.status !== "fulfilled") continue;
			// 投票成功值被断言为 [name, report] 元组；report 可能为 undefined。
			const [name, child] = result.value as readonly [string, ReloadReport | undefined];
			// 只有子 host 真的提供了报告才加入 children。
			if (child !== undefined) children[name] = child;
		}
		// 合并本地报告与 children；children 可能为空对象。
		return { ...report, children };
		// 无论成功失败都释放重载槽；deferred hello 会在这里之后被处理。
	} finally {
		endReload(host);
	}
}

// reconcileChild：把落后于本 host 当前代码版本的子 host 追平。它不改变服务器自己的代码版本，只让子 host 重载。
/**
 * Brings a child that connected behind this host's code version up to it: a reload of the child's modules (the ones
 * cluster reloads gave its name) to this host's current code version, prepared, voted and committed like a cluster
 * reload. Until then the child is fenced: nothing is routed to it. The child's old code is never relabeled as a newer
 * code version.
 */
// 用无限循环处理“等待期间又发生新重载/代码版本前进”的情况；每次迭代都重新读取 current。
export async function reconcileChild(host: HostImpl, connection: Connection): Promise<void> {
	// for(;;) 是显式无限循环；返回条件在循环体内。
	for (;;) {
		// 链接已关闭就没有可追平的对象；直接返回。
		if (!connection.open) return;
		// 本 host 正在重载时先等待：子 host 不是该重载的参与者，现在提交可能被稍后的 commit 覆盖。
		// Not during a reload of this host: the child is not one of its participants, so whatever it would be synced to
		// now may be superseded by that reload's commit. Recheck once it ended.
		if (host.reloading) {
			// 等重载结束后 continue，回到循环顶部重新判断版本。
			await host.whenReloadEnded();
			continue;
		}
		// 目标版本固定为本 host 当前代码版本；循环中若版本前进会重新读取。
		const codeVersion = host.current.id;
		// 子 host 已经同步：标记 synced（唤醒 whenSynced 等待者）并补发退役信息，然后返回。
		if (connection.peerCodeVersion === codeVersion) {
			// markSynced 设置 peerCodeVersion 并唤醒等待链接可用的调用。
			connection.markSynced(codeVersion);
			// 子 host 可能错过更早的 retire 帧；announceRetired 补发“本 host 已退役到哪个版本”。
			host.announceRetired(connection);
			return;
		}
		// Before `prepare`: the child's prepare first retires its previous code version, which waits for this permission.
		// 在 prepare 之前补发 retire：子 host 的 prepare 会先等旧代码版本退役，这个信息让它知道可以退役。
		host.announceRetired(connection);
		// 每次 reconcile 尝试也使用新的投票 id，避免与上一次残留投票冲突。
		const id = ++reloadSeq;
		// 固定 30 秒等待子 host 的 vote；reconcile 没有暴露截止时间选项。
		const vote = awaitVote(connection, id, 30_000);
		// prepare 的模块来自上次集群重载记录的 remoteModules/remoteRemoved；子 host 按自己的名字取匹配前缀。
		connection.send({
			t: "prepare",
			reload: id,
			codeVersion,
			plugins: modulesFor(host.remoteModules, connection.name),
			// 只发送 remove，不发送超时选项：子 host 使用自己的默认 gate/retire 截止时间。
			options: { remove: modulesFor(host.remoteRemoved, connection.name) },
		});
		// 等待投票；失败会从这里抛出，由 peerHello 的 catch 报告并关闭链接。
		await vote;
		// 等待期间本 host 可能提交了更新的代码版本；旧目标已过时，abort 后重试。
		if (host.current.id !== codeVersion) {
			// This host moved on meanwhile: abort and try again with the newer code version.
			// abort 让子 host 放弃这次 prepare；随后 continue 用新的 current.id 再来一轮。
			connection.send({ t: "abort", reload: id });
			continue;
		}
		// 版本仍然匹配：发送 commit，让子 host 安装并启动新代码。
		connection.send({ t: "commit", reload: id });
		// 记录子 host 的代码版本；下一轮循环会命中“已同步”分支并 markSynced。
		connection.peerCodeVersion = codeVersion;
	}
}

// ChildOperation 描述子 host 侧收到的一次 prepare；在第一次 await 之前就登记，保证 abort/断链不会丢失。
/** One prepare the child received, registered before its first await so an abort or disconnect is never lost. */
interface ChildOperation {
	// id 与服务器 prepare 帧的 reload 字段一致，commit/abort 必须携带同一个 id。
	readonly id: number;
	// reload 在 beginReload 成功后才有值；undefined 表示还在加载模块，无法回滚。
	reload: Reload | undefined;
	// state 是单槽状态机：loading（加载模块）→ preparing（准备对象）→ prepared（可投票/可提交）。
	state: "loading" | "preparing" | "prepared";
	// cancelled 一旦置真，后续每个 await 之后都检查并中止，避免继续安装/投票。
	cancelled: boolean;
}

// ChildReloads 是子 host 侧的重载控制器：同一时间只允许一个 prepare，commit/abort 必须匹配当前 id。
/**
 * The child side: prepare and vote, then wait for the server's commit or abort. An abort or a lost parent link can
 * arrive at any point: while loading modules, while preparing (pending opens close themselves when they complete),
 * or after the vote. The operation is unwound once its pending work settles, and the reload slot is freed.
 */
export class ChildReloads {
	// #host 用来报告清理错误、调用 reloadEnded 释放重载槽。
	readonly #host: HostImpl;
	// 单槽设计：第二个 prepare 直接投 unavailable/reload_running，不会排队；undefined 表示空闲。
	#operation: ChildOperation | undefined;

	// 构造只保存 host；不占用重载槽，槽在 beginReload 时才占用。
	constructor(host: HostImpl) {
		this.#host = host;
	}

	// handle 只处理服务器发来的三种重载帧；其他帧不会传到这里。
	// Extract<Frame, {t: ...}> 是联合类型筛选：从 Frame 联合中只取 t 为这三种的分支。
	handle(connection: Connection, frame: Extract<Frame, { t: "prepare" | "commit" | "abort" }>): void {
		// prepare：检查是否有正在进行的操作。
		if (frame.t === "prepare") {
			// 已有操作时立即回 vote 错误；不会加载模块，也不会替换当前操作。
			if (this.#operation !== undefined) {
				// 错误码 unavailable、reason reload_running，让服务器区分“子 host 忙”与真正的 prepare 失败。
				const error = new ChordError("unavailable", "a reload is already running", { reason: "reload_running" });
				// vote 帧带 error 而不是 report；toWireError 保证错误可 JSON 传输。
				connection.send({ t: "vote", reload: frame.reload, error: toWireError(error) });
				return;
			}
			// 新操作先以 loading 状态登记；reload 字段在 beginReload 完成后才有值。
			const operation: ChildOperation = { id: frame.reload, reload: undefined, state: "loading", cancelled: false };
			// 同步写入 #operation，之后才启动异步 #run；因此紧接着到达的 abort/断链能看到这个操作。
			this.#operation = operation;
			// #run 的 Promise 不 await；正常失败由 #run 回 vote，只有未预期的异常才交给 host.report，
			// 避免帧处理函数产生未处理的 Promise 拒绝。
			this.#run(operation, connection, frame).catch((error: unknown) => this.#host.report(error));
			return;
		}
		// commit/abort：必须匹配当前操作的 id，旧事务的迟到帧直接忽略。
		const operation = this.#operation;
		// operation 为空或 id 不同：不是当前事务，忽略。
		if (operation === undefined || operation.id !== frame.reload) return;
		// abort：标记取消并回滚；具体时机由 #cancel 处理。
		if (frame.t === "abort") {
			this.#cancel(operation);
			return;
		}
		// commit 只在 prepared 后有效；loading/preparing 阶段的 commit 是协议错误或过期帧，忽略。
		if (operation.state !== "prepared") return;
		// 先清空槽，再提交；提交过程即使抛错也不会让槽永久占用。
		this.#operation = undefined;
		// try/finally 保证 endReload 一定执行（释放重载槽、处理延后 hello）。
		try {
			// reload 理论上一定存在（state 为 prepared 意味着 beginReload 已成功）；?. 只是类型层面的保守写法。
			operation.reload?.commit();
			// commit 安装新代码版本并运行 #starts；错误会向上抛给帧处理层。
		} finally {
			endReload(this.#host);
		}
	}

	// parentLost：父链接断开后不会再有 commit，因此立即取消当前 prepare 或回滚已准备状态。
	/** The parent link died: nobody will commit, so roll back (now, or once pending work settles). */
	// 没有进行中的操作时无事可做。
	parentLost(): void {
		if (this.#operation !== undefined) this.#cancel(this.#operation);
	}

	// #cancel 分两种情况：尚未 prepared 时让 prepare 在下一个检查点失败；已 prepared 时直接回滚并释放槽。
	#cancel(operation: ChildOperation): void {
		// 先置 cancelled；#run 在每个 await 之后检查它。
		operation.cancelled = true;
		// loading/preparing：不能在这里等待 prepare 结束，先请求 rollback（如果有 Reload），由 #run 收尾。
		if (operation.state !== "prepared") {
			// Loading or preparing: make prepare fail now; #run unwinds when it settles.
			// 不在这里 endReload：槽仍属于正在收尾的 #run，由它的 catch 统一释放。
			// reload 可能还是 undefined（beginReload 未返回）；此时 #run 之后会自行回滚并 endReload。
			operation.reload?.rollback().catch((error: unknown) => this.#host.report(error));
			return;
		}
		// 已 prepared：清空槽，异步 rollback 完成后释放重载槽。
		// 清空后 prepare 帧不再被它阻塞；重载槽仍占用，直到 rollback 完成。
		this.#operation = undefined;
		// rollback 可重复调用（Reload 内部有 rolledBack 守卫）；catch 报告清理错误，finally 保证 endReload。
		operation.reload
			?.rollback()
			.catch((error: unknown) => this.#host.report(error))
			.finally(() => endReload(this.#host));
	}

	// #run 执行子 host 侧的加载与准备，并回 vote；任何失败都会回滚、释放槽并（未取消时）回 vote 错误。
	async #run(
		operation: ChildOperation,
		connection: Connection,
		frame: Extract<Frame, { t: "prepare" }>,
	): Promise<void> {
		// cancelled() 构造统一的 aborted 错误；每次检查点新建实例，保证 cause/堆栈独立。
		const cancelled = (): ChordError =>
			new ChordError("aborted", "reload aborted by the server", { reason: "aborted" });
		// try 覆盖 beginReload → prepare → 发送 vote 的完整流程。
		try {
			// beginReload 占用重载槽并加载插件模块；frame.codeVersion 是服务器指定的目标版本。
			// 如果 beginReload 失败，它已经调用过 host.reloadEnded，因此下面 catch 不会重复释放。
			operation.reload = await beginReload(this.#host, frame.plugins, frame.options, frame.codeVersion);
			// 加载期间可能收到 abort/parentLost；这里检查并抛出统一错误。
			if (operation.cancelled) throw cancelled();
			// 进入 preparing：真正准备对象、迁移状态、订阅监听器。
			operation.state = "preparing";
			// prepare 可能因契约不匹配、校验失败或超时而拒绝；它内部会自行 rollback。
			await operation.reload.prepare();
			// prepare 期间也可能被取消（例如服务器 abort 或父链接断开）。
			if (operation.cancelled) throw cancelled();
			// 准备完成，可以投票；state 变为 prepared 后 commit 才被接受。
			operation.state = "prepared";
			// vote 携带 summary（codeVersion/previous/changed/removed/prepared/gated），供服务器汇总。
			connection.send({ t: "vote", reload: frame.reload, report: operation.reload.summary() });
			// 任意失败：回滚已创建的 Reload，释放重载槽，并清理单槽。
		} catch (error) {
			// reload 存在说明 beginReload 成功过；需要 rollback 并 endReload。
			if (operation.reload !== undefined) {
				// 回滚本身失败时报告，不覆盖原始错误；随后仍然 endReload。
				await operation.reload.rollback().catch((cleanup: unknown) => this.#host.report(cleanup));
				// 释放重载槽；deferred hello 等会在 host.reloadEnded 中继续。
				endReload(this.#host);
			}
			// 只有仍然是当前操作时才清空；避免误删之后开始的新操作。
			if (this.#operation === operation) this.#operation = undefined;
			// 未被服务器取消时回 vote 错误；被取消说明服务器/父链接已经知道失败，不必再投票。
			if (!operation.cancelled) connection.send({ t: "vote", reload: frame.reload, error: toWireError(error) });
		}
	}
}
