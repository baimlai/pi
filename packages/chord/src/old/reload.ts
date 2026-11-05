// Chord v1 的热重载实现：在不停止宿主的前提下加载新插件、重建对象实现、迁移状态，并一次性提交新代码版本。
//
// 所属模块：packages/chord/src/old，Chord v1 宿主运行时。宿主最多保留当前版本与上一版本；重载负责把“当前”推进到
// “待提交”，并在提交后让上一版本退役。单机重载与集群重载（cluster.ts 的 runClusterReload）都走这里的 Reload。
//
// 职责边界：本文件不实现对象创建/资源打开/监听器登记本身（object.ts），也不实现宿主表安装、代码版本存储与退役
// （host.ts）；它编排这些步骤，并决定何时失败、回滚、等待或提交。网络子主机只接收已准备好的报告与代码版本号；
// 真正的子主机提交由 cluster.ts 发送 commit 帧后调用 Reload.commit。
//
// 上游入口：host.reload(plugins, options) → runReload(host, plugins, options)；集群协调端使用 beginReload +
// prepare + summary + commit，并在 rollback 时调用 endReload。应用侧通常只调用 host.reload，不直接使用 Reload 类。
// 下游依赖：cell（Cell 的 schema/版本/迁移）、contract（bind/coverage 检查契约兼容）、errors（ChordError 与
// asChordError）、host（HostImpl 的 current/pending/previous、objects、facets、tables、retire、fail 等）、object
// （Factory/Service/ObjectImpl/RefImpl/资源与监听器阶段化）、publish（holdPublications 同步发布）、schema
// （assertValid/deepEqual）、types（Readable）。
//
// 能力清单：
// - ReloadOptions：移除插件、gate/retire/vote 截止时间、服务器端远程插件映射。
// - ReloadReport：提交结果（新/旧代码版本、变更/移除的类型、已安装对象地址、过 gate 的对象地址、子主机报告）。
// - reloadError：把底层错误包装成“reload aborted: ...”的 ChordError，保留 code/reason/cause/details。
// - runReload：单机便捷流程：beginReload → prepare → commit，finally 结束重载。
// - beginReload/endReload：占用/释放宿主的重载槽，加载插件模块，供集群协调端分阶段使用。
// - Reload：一次重载的状态机，prepare（waitForRetirement/load/checkProviders/prepareAll/checkRefs/buildTables/gate/stage）、
//   summary、commit、rollback 及内部阶段。
//
// 典型顺序（单机）：
//   const report = await host.reload([CounterFacet], { remove: ["old-facet"] });
//   内部：runReload → beginReload（host.resolve 加载模块）→ prepare：
//     waitForRetirement（上一版本退役）→ load（构建候选 services 与 pending 代码版本）→ checkProviders（契约兼容）
//     → prepareAll（对每个受影响对象跑新工厂、开非延迟资源、水合、可能 initCells+dryRun）
//     → 设置 host.gating 并等第二次 prepareAll 收尾在途激活 → checkRefs（所有存活引用能绑定新契约）
//     → buildTables（按候选声明生成注册表）→ gate（停旧任务、等 grandfathered roots、替换独占资源、迁移状态）
//     → stage（提前订阅监听器）
//   → commit（holdPublications 内一次性安装、发布通知、启动任务）。
//   任一步失败：prepare 的 catch 调用 rollback，宿主恢复旧版本；commit 内安装抛错则 host.fail 终止宿主。
//
// 示例（真实签名）：
//   const report = await host.reload([newFacet], { gateDeadline: 2_000 });
//   console.log(report.codeVersion, report.changed, report.gated);
//   这是真实运行时调用；report.prepared 只包含提交时重新安装新工厂的存活对象地址，不含新类型对象（它们由 #publish 的 deferred 启动）。
//
// 建议阅读顺序：先读 ReloadOptions/ReloadReport 明确输入输出；再读 Candidate 与 dryRun/candidateValue 理解“提交前
// 预演”；然后读 runReload/beginReload 看生命周期入口；之后按 prepare 的调用顺序读 load→checkProviders→prepareAll→
// prepareObject→checkRefs→entries→gate→migrate→#stage；最后读 commit/#publish/install 理解安装顺序与失败语义。
import type { Cell } from "./cell.ts";
import { type AnyContract, bind, coverage } from "./contract.ts";
import { asChordError, ChordError, invalid, isChordError } from "./errors.ts";
import type { CodeVersionState, Facet, HostImpl, PluginRef, Serve } from "./host.ts";
import {
	type Factory,
	hostLifetime,
	makeService,
	memberSchemas,
	type ObjectImpl,
	RefImpl,
	type ResourceImpl,
	type Run,
	type ServeOptions,
	type Service,
	type StagedListeners,
} from "./object.ts";
import { holdPublications } from "./publish.ts";
import type { RegistryTable } from "./registry.ts";
import { assertValid, deepEqual } from "./schema.ts";
import type { Readable } from "./types.ts";

// 宿主重载选项。所有字段可选；未给出的值在 Reload 内部取默认值（见各字段与 withDeadline/gate）。
// 这些只是普通对象字段，运行时不校验类型/范围；负数或 NaN 会原样传给 setTimeout（通常立即触发或行为异常）。
export interface ReloadOptions {
	/** Facet names to remove. */
	// 要移除的插件名。load 会把当前 services 中属于这些 facet 的服务排除，并删除对应 host.facets。
	readonly remove?: readonly string[];
	/** Milliseconds the gate waits for grandfathered roots (default 5000). Missed: the reload aborts. */
	// gate 等待“旧代码版本仍存活的 root”结束的时间。超时抛 aborted/reason gate_deadline，prepare 回滚。
	// withDeadline 也用它限制第二次 prepareAll（in-flight 激活）；实际默认 5000。
	readonly gateDeadline?: number;
	/** Milliseconds to wait for the previous code version to retire first (default 5000). Missed: it is retired anyway. */
	// 等待上一代码版本自然退役的时间。超时后强制 abort 其 roots，再给 ABORTED_ROOTS_GRACE 让它们停止，然后 retire。
	readonly retireDeadline?: number;
	/** Server: facet modules for child hosts by host-name prefix (longest wins). Every connected host participates. */
	// 仅服务器/协调端使用：按子主机名前缀指定要加载的插件模块；最长前缀优先。具体解析与投票在 cluster.ts。
	// 本文件只把它放进 options，Reload 本身不读取 remote/remoteRemove/voteDeadline。
	readonly remote?: Readonly<Record<string, readonly string[]>>;
	/** Server: facet names to remove on child hosts, by the same host-name prefix rules. */
	// 仅服务器端：按同样的前缀规则指定子主机要移除的插件名；本文件不消费。
	readonly remoteRemove?: Readonly<Record<string, readonly string[]>>;
	/** Server: milliseconds to wait for every child's vote (default: gate + retire deadlines + 5000). */
	// 仅服务器端：等待所有子主机投票的时限；默认由 gate+retire 期限推算，在 cluster.ts 使用。
	readonly voteDeadline?: number;
}

// 一次成功重载的报告；同时用于子主机投票（summary）和最终 commit 的返回值。
// 注意 summary 返回的 codeVersion 是 pending 的 id（尚未提交），字段仍是“将要提交”的语义；commit 返回实际安装的 id。
export interface ReloadReport {
	// 新代码版本号；本地重载由 host.nextCodeVersionId 分配，集群由协调端指定。
	readonly codeVersion: number;
	// 被替换的旧代码版本号（提交前的 host.current.id）。
	readonly previous: number;
	// 契约/服务发生变化的类型名集合（顺序为候选 services 的插入顺序）。
	readonly changed: readonly string[];
	// 不再由任何 facet 提供的类型名。
	readonly removed: readonly string[];
	/** Addresses of objects whose new factory was installed. */
	// 在提交时实际安装新工厂的存活对象地址；#publish 过程中对象已不再 live 的不计入。
	readonly prepared: readonly string[];
	/** Addresses of objects that went through the gate. */
	// 在 gate 阶段被判定需要迁移/替换资源且当时仍 live 的对象地址。
	readonly gated: readonly string[];
	/**
	 * Cluster reloads: what each participating child host prepared, by host name (its vote; the child commits it after
	 * the server). Absent for local reloads.
	 */
	// 集群重载时每个参与子主机的 summary（按 host 名）。子主机随后由协调端下发 commit 帧才真正提交。
	// 本地重载不设置该字段；嵌套的 ReloadReport 可继续包含 children。
	readonly children?: Readonly<Record<string, ReloadReport>>;
}

// 一个受影响对象的候选实现。prepare 阶段创建；commit/rollback 都围绕它工作。
// readonly 字段在候选创建后不再替换；derived/staged 在 prepare 过程中填充。
interface Candidate {
	// 正在被重载的本地对象；它的旧 decls/implementations 仍保留到提交。
	readonly object: ObjectImpl;
	// 新服务（类型契约与工厂配置），来自候选 services 表。
	readonly service: Service;
	// 新工厂在“记录模式”下运行的结果：实现、声明、创建的资源/引用/派生、cell 版本与迁移函数。
	readonly run: Run;
	/** Why the object needs the gate (empty: compatible). */
	// 需要 gate 的原因（cell 版本升高、替换独占资源）。空数组表示可直接在提交时安装。
	readonly reasons: string[];
	/** New exclusive resources and their new dependents, opened at the gate. */
	// 延迟到 gate 才打开的新独占资源，以及依赖这些延迟资源的资源。
	readonly atGate: ResourceImpl[];
	/** Old exclusive resources closed at the gate. */
	// 在 gate 时要关闭的旧独占资源；rollback 需要重新打开它们。
	readonly replaced: ResourceImpl[];
	// cell → 迁移后的新值（仅 gate 候选）。提交时用 cell.reset 写入，并更新 schema。
	readonly migrated: Map<Cell<unknown>, unknown>;
	/** Values of the run's derivations over the candidate (migrated) values, validated. */
	// 候选值上预先算出的派生值（含迁移值和其它来源），提交时 Derived.attach 复用，避免重复计算/短暂不一致。
	derived: Map<unknown, unknown>;
	/** Listener subscriptions made at the end of prepare, activated by the commit. */
	// prepare 末尾预先建立但暂不投递的监听器订阅；提交时 activate，回滚时 discard。
	staged: StagedListeners | undefined;
}

/**
 * Computes the new derivation functions over the candidate values and validates every prospective value (migrated
 * cells and derivations) against every schema that will apply after the commit: the cell's new schema and the new
 * implementation's remote state-member schemas. A failure fails prepare; the commit then installs without re-checking.
 */
// 在提交前预演新派生函数与迁移值。输入 candidate 已含 run 与新服务；输出写入 candidate.derived。
// 步骤：
// 1. memberSchemas 找出新实现对外暴露的成员（cell/Derived）对应的 schema 列表；
// 2. 对每个迁移值，逐一验证新 schema（一个来源可能被多个远程成员暴露，因此是 schema 数组）；
// 3. 复制迁移值作为已知值表，按 seq 升序计算派生（seq 保证依赖先算）；每个派生读取已知值或回退到候选来源；
// 4. 派生结果也按暴露 schema 校验，然后写入已知值表供后续派生使用；
// 5. 保存到 candidate.derived，提交时 Derived.attach(precomputed) 直接使用。
// 错误路径：任何 assertValid 失败都会让 prepare 回滚。这里不修改真实 cell，只计算副本。
function dryRun(candidate: Candidate): void {
	const { run, migrated, service, object } = candidate;
	const exposed = memberSchemas(service, run.implementation);
	for (const [cell, value] of migrated) {
		for (const schema of exposed.get(cell) ?? [])
			assertValid("state", `${object.address}: migrated state ${cell.key}`, schema, value);
	}
	const values = new Map<unknown, unknown>(migrated);
	const derives = [...run.decls.derives].sort(([, a], [, b]) => a.seq - b.seq);
	for (const [name, derived] of derives) {
		const value = derived.compute((source) => (values.has(source) ? values.get(source) : candidateValue(source)));
		for (const schema of exposed.get(derived) ?? [])
			assertValid("state", `${object.address}: derivation ${name}`, schema, value);
		values.set(derived, value);
	}
	candidate.derived = values;
}

/**
 * A source's value for a dry run. A reference to a provider this reload upgrades too reads nothing before the commit
 * (its new contract does not bind the old code): the dry run computes without it, the commit with the real value.
 */
// 预演时读取一个来源的值。正常来源直接读；若来源是“同样要被本次重载升级的提供者引用”，提交前它还没有绑定新契约，
// 读会抛 not_ready/not_in_variant，此时按 undefined 继续计算（提交时 Derived.refresh 会用真实值重算）。
// 其它错误（例如用户代码抛错）原样抛出，让 prepare 失败。
// 注意这只是预演近似：依赖未就绪引用的派生值可能按 undefined 计算；提交安装时 Derived.attach 先使用预演值，
// 之后外部源发布（例如引用重新水合）时 Derived.refresh 会用真实值重算。
function candidateValue(source: Readable<unknown>): unknown {
	try {
		return source.value;
	} catch (error) {
		if (isChordError(error, "not_ready") || isChordError(error, "not_in_variant")) return undefined;
		throw error;
	}
}

/** A reload error keeps the underlying code (`contract_mismatch`, `invalid`, ...) and says it aborted the reload. */
// 把任意错误规范化为 ChordError，并在消息前加 "reload aborted: "，便于调用方区分重载失败与普通调用失败。
// asChordError(error, "reload") 会把非 ChordError 包成 code "reload"（或保留已有 code）。
// 去重逻辑：ChordError.message 通常形如 "code/reason: 正文"；先用 /^[^:]*: / 去掉第一个 ": " 之前的前缀，
// 再看是否已以 "reload aborted" 开头，避免 rollback 多层包装出 "reload aborted: reload aborted: ..."。
// 返回的新错误保留原 code/reason/details，并把原错误放进 cause；不改变原错误对象。
export function reloadError(error: unknown): ChordError {
	const cause = asChordError(error, "reload");
	if (/^reload aborted/.test(cause.message.replace(/^[^:]*: /, ""))) return cause;
	return new ChordError(cause.code, `reload aborted: ${cause.message}`, {
		cause,
		reason: cause.reason,
		details: cause.details,
	});
}

/** Serialized: a second reload while one runs is rejected. */
// 单机重载入口：先占用重载槽并加载插件（beginReload），然后 prepare + commit。finally 保证无论成功失败都释放槽。
// 输入 host、插件引用列表、选项；输出提交报告。错误：beginReload 的 reload_running、prepare 的回滚错误、
// commit 的安装错误都会原样（或经 reloadError）抛出；此时宿主可能已被回滚或标记失败。
export async function runReload(
	host: HostImpl,
	plugins: readonly PluginRef[],
	options: ReloadOptions,
): Promise<ReloadReport> {
	const reload = await beginReload(host, plugins, options);
	try {
		await reload.prepare();
		return reload.commit();
	} finally {
		endReload(host);
	}
}

/** Takes the host's reload slot and loads the plugin modules. Pair with `endReload`. */
// 占用宿主的重载槽（host.reloading）并异步解析插件模块。输入可选 codeVersion：集群协调端指定；
// 单机不传，由 HostImpl.nextCodeVersionId 在 load 时分配。
// 错误：已有重载在跑 → unavailable/reason reload_running，不改变槽；host.resolve 失败 → 释放槽并抛 reloadError。
// 成功返回 Reload 实例，但此时尚未 load/prepare；调用方必须最终调用 endReload（runReload 的 finally 会做）。
export async function beginReload(
	host: HostImpl,
	plugins: readonly PluginRef[],
	options: ReloadOptions,
	codeVersion?: number,
): Promise<Reload> {
	if (host.reloading) {
		throw new ChordError("unavailable", "a reload is already running", { reason: "reload_running" });
	}
	host.reloading = true;
	try {
		return new Reload(host, await host.resolve(plugins), options, codeVersion);
	} catch (error) {
		host.reloadEnded();
		throw reloadError(error);
	}
}

// 释放重载槽；由 runReload 的 finally 或集群协调端在最后调用。重复调用是安全的（host.reloadEnded 幂等）。
export function endReload(host: HostImpl): void {
	host.reloadEnded();
}

/** Most milliseconds a forced retirement waits for aborted roots to settle before it closes what they used. */
// 强制退役时，在 abort 旧 roots 之后额外等待它们停止的最长时间；与 retireDeadline 取较小值。
const ABORTED_ROOTS_GRACE = 1000;

/** Resolves true once `ready()` holds (checked whenever retirement-relevant state changes), false after `ms`. */
// 轮询式等待：ready() 已为 true 立即成功；否则注册 host.watchRetirement 回调，在“与退役相关的状态变化”时检查，
// 同时设置 ms 定时器。返回 true 表示条件成立，false 表示超时。
// 注意 stop 在定时器回调里被引用，但定时器异步执行，届时 const stop 已初始化；watchRetirement 返回的取消函数
// 同时取消监听，避免成功后仍占用回调。ready() 抛错不会被本函数捕获（这里的 ready 只做简单状态比较，不应抛错）。
function until(host: HostImpl, ready: () => boolean, ms: number): Promise<boolean> {
	if (ready()) return Promise.resolve(true);
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			stop();
			resolve(false);
		}, ms);
		const stop = host.watchRetirement(() => {
			if (!ready()) return;
			clearTimeout(timer);
			stop();
			resolve(true);
		});
	});
}

/** One reload on one host: `prepare` (load, prepare, gate), then `commit` or `rollback`. */
// 一次重载的完整状态机。生命周期约束：
// - 一个宿主同时只能有一个未结束的 Reload（host.reloading 在 beginReload 设置）。
// - prepare 可 await 多次；每个 await 后都用 #alive 检查是否已被回滚（协调端 abort/rollback 可能并发）。
// - commit 是同步发布（holdPublications 内），成功后再调用 beforeStart 和 #starts；commit 抛错意味着宿主进入失败态。
// - prepare 失败自动 rollback；rollback 也用于集群中协调端放弃某个子主机的候选。
// - 字段大多在 load/gate 中填充；commit 后对象仍可读取报告，但不应再次 prepare/commit。
export class Reload {
	// 目标宿主；所有宿主表/对象/代码版本操作都直接读写它。
	readonly host: HostImpl;
	// 本次加载的插件列表（已由 beginReload 解析为 Facet 实例）；用于替换同名服务、记录 facets、检查 uses。
	readonly facets: readonly Facet[];
	readonly options: ReloadOptions;
	/** Code version id to commit (issued by the coordinating server); a local reload allocates one. */
	// 集群协调端指定要提交的代码版本号；undefined 时 load 调用 host.nextCodeVersionId 分配。
	readonly codeVersion: number | undefined;
	// 受影响对象 → 候选实现。只有 changed 类型且与候选 service 不同的 live/activating 对象会进入。
	readonly candidates = new Map<ObjectImpl, Candidate>();
	// 本次 prepare 的取消信号：传资源 open、cell init、ref 打开等；rollback 时 abort。
	readonly abort = new AbortController();
	// gate 中已关闭的旧独占资源及其对象；rollback 用它们恢复。即使 close 抛错也会先入列，确保能尝试恢复。
	readonly closed: [ObjectImpl, ResourceImpl][] = [];
	// 候选服务表：未变服务 + 本次 facets 提供的服务；load 后、commit 前使用。
	services = new Map<string, Service>();
	// 契约/服务发生变化的类型名；gate 用它阻止新对象激活，checkProviders/checkRefs 用它筛选。
	changed = new Set<string>();
	// 不再提供、需要移除的类型名。
	removed = new Set<string>();
	// 候选注册表：host.buildTables(entries()) 生成，提交时 installTables 安装。
	tables = new Map<string, RegistryTable<unknown>>();
	// 需要通过 gate 的候选（reasons 非空且对象仍 live）；commit 报告和回滚恢复都用它。
	gated: Candidate[] = [];
	// 是否已回滚；防止重复回滚，也让 #alive 在并发取消时立即失败。
	rolledBack = false;
	/** Objects of types this reload adds, with their staged listeners: their runtime starts at commit. */
	// 本次新增类型的对象（旧代码版本中不存在）→ 已暂存的监听器。它们不进入 candidates（没有旧实现需要比较），
	// deferredRuntime 为 true，提交前不启动任务/不投递监听；提交时才 activate 并排入 #starts。
	readonly deferred = new Map<ObjectImpl, StagedListeners>();
	/** This reload's run of each facet it loads (`FacetApi.signal`): installed at commit, aborted at rollback. */
	// 每个被加载 facet 的 AbortController：facet.setup 收到其 signal；提交时用它通知 facet 运行版本变化，
	// 回滚时 abort，让 facet 中注册的后台工作停止。key 是 facet 名。
	readonly facetRuns = new Map<string, AbortController>();

	// 构造只保存输入；不加载插件、不创建 pending。真正开始于 prepare/load。
	constructor(host: HostImpl, facets: readonly Facet[], options: ReloadOptions, codeVersion?: number) {
		this.host = host;
		this.facets = facets;
		this.options = options;
		this.codeVersion = codeVersion;
	}

	/** Everything up to the commit. On failure the host is rolled back and the underlying error is thrown. */
	// 准备阶段：按固定顺序完成所有可能失败的工作，成功后宿主处于“可同步提交”的状态。
	// 顺序理由：
	// 1. 先让上一代码版本退役，宿主只保留 current，后续候选基于稳定的 current.services；
	// 2. load 构建候选服务与 pending；
	// 3. checkProviders 先做契约兼容检查，避免白跑工厂；
	// 4. prepareAll 第一次处理当前存活对象；之后设置 host.gating，阻止 changed 类型的新对象在提交前激活
	//    （新 get 得到 upgrade_conflict，可重试），再跑第二次 prepareAll 处理已经在飞行中的激活，直到不动点；
	// 5. checkRefs 确保所有存活引用能绑定新契约；
	// 6. buildTables 生成候选注册表；
	// 7. gate 停旧任务、等旧 roots、替换资源、迁移；
	// 8. #alive 检查期间是否被回滚，然后 stage 监听器。
	// 错误：任一步抛错都会 await rollback() 恢复宿主，再把错误经 reloadError 包装抛出。
	async prepare(): Promise<void> {
		try {
			await this.waitForRetirement();
			this.load();
			this.checkProviders();
			await this.prepareAll();
			// From here new objects of changed types are rejected (upgrade_conflict, retryable) until commit or abort,
			// so the candidate set is final once the activations already in flight have been prepared.
			this.host.gating = this.changed;
			await this.withDeadline(this.prepareAll(), "activations in flight did not finish");
			this.checkRefs();
			this.tables = this.host.buildTables(this.entries());
			await this.gate();
			this.#alive();
			this.#stage();
		} catch (error) {
			await this.rollback();
			throw reloadError(error);
		}
	}

	/** What a successful prepare will commit (a child sends it with its vote). */
	// 返回“如果现在提交会得到什么”的报告，供集群子主机投票。它不执行提交，也不改变宿主状态。
	// prepared 只列当前仍 live 的候选对象；gated 来自 gate 结果。codeVersion 优先用 pending.id，
	// 若 pending 已不存在（例如 prepare 失败后）则退回 current.id。
	summary(): ReloadReport {
		const live = [...this.candidates.values()].filter(({ object }) => object.status === "live");
		return {
			codeVersion: this.host.pending?.id ?? this.host.current.id,
			previous: this.host.current.id,
			changed: [...this.changed],
			removed: [...this.removed],
			prepared: live.map(({ object }) => object.address),
			gated: this.gated.map(({ object }) => object.address),
		};
	}

	/** After every await of prepare: a rollback meanwhile (abort from the coordinator) ends it. */
	// prepare 在关键 await 之后调用：若期间已被回滚（例如集群协调端取消），立即抛 aborted/reason aborted，
	// 防止继续在已回滚的宿主上安装候选。它不是取消信号本身，而是对 rolledBack 标志的检查。
	#alive(): void {
		if (this.rolledBack) throw new ChordError("aborted", "reload aborted while preparing", { reason: "aborted" });
	}

	/**
	 * Subscribes every new listener now, buffering its events, so a failing source fails prepare instead of leaving a
	 * half-installed code version. Objects running only the new code (types this reload adds) are staged too.
	 */
	// 提前建立监听器订阅并缓冲事件：
	// - candidates 中仍 live 的对象：用新 run.decls 调用 object.stageListeners，失败会让 prepare 回滚；
	// - 新增类型的对象（deferredRuntime=true）：同样 stage，但它们的运行时要等 commit 才激活。
	// 这样“订阅失败”发生在提交前，避免提交到一半才发现某个来源不可订阅。提交时 activate 才真正投递。
	#stage(): void {
		for (const candidate of this.candidates.values()) {
			if (candidate.object.status === "live")
				candidate.staged = candidate.object.stageListeners(candidate.run.decls);
		}
		for (const object of this.host.objects.values()) {
			if (object.status === "live" && object.deferredRuntime)
				this.deferred.set(object, object.stageListeners(object.decls));
		}
	}

	/**
	 * Retires the previous code version before loading the next one (a host keeps two). Waits until its roots ended and,
	 * on a child host, its parent retired it too (`retire` frame), at most `retireDeadline`. Past the deadline it is
	 * retired anyway: its remaining roots are aborted first and get a short grace to stop, so they see cancellation
	 * before the resources only that code version used are closed; their next call is `superseded`.
	 */
	// 让上一代码版本退役，为新版本腾出“只保留两个版本”的空间。
	// 输入：无（使用 host.previous 与 options.retireDeadline）。
	// 流程：
	// 1. 没有 previous 直接返回；
	// 2. 等待 previous 消失（host.previous 被替换）或 host.retirable()（本地 roots 已结束且父 host 已允许退役）；
	// 3. 超时且仍未消失：abort previous 的 roots（原因 superseded），再短暂等待其 roots 清空（最多 1000ms），
	//    让旧调用在资源关闭前观察到取消；
	// 4. 仍未消失则强制 host.retire()。
	// 副作用：可能 abort 旧 roots、关闭旧实现资源、移除 host.previous。错误：本方法不抛错，超时被设计为继续。
	async waitForRetirement(): Promise<void> {
		const host = this.host;
		const previous = host.previous;
		if (previous === undefined) return;
		const deadline = this.options.retireDeadline ?? 5000;
		const gone = (): boolean => host.previous !== previous;
		if (!(await until(host, () => gone() || host.retirable(), deadline)) && !gone()) {
			previous.abort.abort(new ChordError("superseded", `code version ${previous.id} was retired`));
			await until(host, () => gone() || previous.roots.size === 0, Math.min(deadline, ABORTED_ROOTS_GRACE));
		}
		if (!gone()) host.retire();
	}

	/** Builds the candidate service table: unchanged services plus everything the given facets serve. */
	// 构建候选服务表并创建 pending 代码版本；不修改 current，也不激活任何对象。
	// 步骤：
	// 1. replaced = 本次加载的 facet 名 + options.remove 中的名字；当前 services 中属于这些 facet 的全部排除；
	// 2. 对每个新 facet：创建 AbortController，调用 facet.setup(facetApi(serve, signal))。serve 闭包把
	//    makeService(type, factory, options, facet.name) 写入 this.services；若同名类型重复提供，serveInto 会报冲突；
	// 3. 与 current 比较：服务对象身份不同 → changed；current 有而新表没有 → removed；
	// 4. 创建 host.pending，id 由 nextCodeVersionId(codeVersion) 决定（集群传入的 id 或分配新号）。
	// 副作用：执行 facet.setup（用户插件代码），可能抛错，让 prepare 回滚；此时尚未安装任何新服务。
	// 注意 setup 期间写入的服务只在 this.services，直到 commit 才替换 host.current.services。
	load(): void {
		const replaced = new Set([...this.facets.map((facet) => facet.name), ...(this.options.remove ?? [])]);
		const current = this.host.current.services;
		this.services = new Map([...current].filter(([, service]) => !replaced.has(service.facet)));
		for (const facet of this.facets) {
			const run = new AbortController();
			this.facetRuns.set(facet.name, run);
			facet.setup(
				this.host.facetApi(
					((type: AnyContract, factory: Factory<AnyContract>, options: ServeOptions = {}) =>
						this.host.serveInto(this.services, makeService(type, factory, options, facet.name))) as Serve,
					run.signal,
				),
			);
		}
		for (const [name, service] of this.services) if (current.get(name) !== service) this.changed.add(name);
		for (const name of current.keys()) if (!this.services.has(name)) this.removed.add(name);
		this.host.pending = {
			id: this.host.nextCodeVersionId(this.codeVersion),
			services: this.services,
			tables: new Map(),
			roots: new Map(),
			abort: new AbortController(),
		};
	}

	// 给 Promise 加一个超时竞争。输入 promise 与描述文本 what；输出原 Promise 的结果，或超时后的 rejected Promise。
	// 超时错误：aborted，消息包含 what 与期限，reason 为 deadline（与 gate_deadline 区分）。
	// finally 清除定时器，避免成功路径留下悬挂的 timeout。注意 Promise.race 不会取消原 promise；
	// 调用方（第二次 prepareAll）在超时后仍需 rollback 来中止其资源。
	async withDeadline<T>(promise: Promise<T>, what: string): Promise<T> {
		const deadline = this.options.gateDeadline ?? 5000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new ChordError("aborted", `${what} within ${deadline} ms`, { reason: "deadline" })),
				deadline,
			);
		});
		try {
			return await Promise.race([promise, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Same contract version must cover the old description (forgotten bump); facets' `uses` must bind. */
	// 提交前检查契约兼容性，分两部分：
	// 1. 对 changed 类型：若新旧契约版本号相同，新 description 必须覆盖旧 description（coverage 返回 undefined）；
	//    否则说明作者改了契约却忘记升版本，抛 contract_mismatch。版本号不同则允许不兼容（新版本由调用方显式选择）。
	//    旧类型不存在（old === undefined，即新增类型）直接跳过。
	// 2. 对“重载后仍然存在”的所有 facet（当前 facets + 新 facets - remove）检查 uses：每个依赖 token 必须能
	//    绑定候选服务契约；只有 changed 的类型才需要重新 bind，未变服务沿用原绑定。失败抛出 bind 的契约错误。
	// 副作用：无（只读与校验）；错误：contract_mismatch 或 bind 抛出的错误，导致 prepare 回滚。
	checkProviders(): void {
		for (const name of this.changed) {
			const next = this.services.get(name)!.contract;
			const old = this.host.current.services.get(name)?.contract;
			if (old === undefined || old.version !== next.version) continue;
			const reason = coverage(next.description, old.description);
			if (reason !== undefined) {
				throw new ChordError(
					"contract_mismatch",
					`${name}@${next.version} changed incompatibly without a version bump (${reason})`,
				);
			}
		}
		const facets = new Map(this.host.facets);
		for (const facet of this.facets) facets.set(facet.name, facet);
		for (const name of this.options.remove ?? []) facets.delete(name);
		for (const facet of facets.values()) {
			for (const token of facet.uses ?? []) {
				const service = this.services.get(token.name);
				if (service !== undefined && this.changed.has(token.name))
					bind(service.contract, service.options.accepts, token);
			}
		}
	}

	/**
	 * Prepares every live object of a changed type, including objects that activate meanwhile, to a fixpoint. Objects
	 * already running the new code (types this reload adds) are skipped.
	 */
	// 处理所有 changed 类型的存活对象，直到没有新对象可处理（不动点）。
	// 每轮：
	// 1. 筛选 todo：类型 changed、尚无候选、当前 service 不是候选 service、状态 live 或 activating；
	// 2. 等这些对象 ready（Promise.allSettled，失败也继续；激活失败的对象不会进入下一步）；
	// 3. #alive 检查是否已回滚；
	// 4. 对已 live 且 service 仍不是候选的对象执行 prepareObject（activating 对象可能在上一步失败，跳过）；
	// 5. 循环，因为 prepare 期间可能有新对象激活（第一次 prepareAll 尚未设置 gating），需要再处理。
	// 第二次 prepareAll（设置 gating 后、带 deadline）用于收尾“已在飞行中”的激活；gating 之后不会再新增候选。
	async prepareAll(): Promise<void> {
		for (;;) {
			const todo = [...this.host.objects.values()].filter(
				(object) =>
					this.changed.has(object.typeName) &&
					!this.candidates.has(object) &&
					object.service !== this.services.get(object.typeName) &&
					(object.status === "live" || object.status === "activating"),
			);
			if (todo.length === 0) return;
			await Promise.allSettled(todo.map((object) => object.ready));
			this.#alive();
			for (const object of todo) {
				if (object.status === "live" && object.service !== this.services.get(object.typeName)) {
					await this.prepareObject(object);
					this.#alive();
				}
			}
		}
	}

	/** Runs the new factory in recording mode and opens what can be opened without the gate. */
	// 为一个对象运行新工厂（记录模式，不安装）并打开不需要 gate 的资源。输入 object 是当前 live 对象；
	// 输出无，副作用是写入 this.candidates、创建新资源/引用、可能初始化 cell 并执行 dryRun。
	// 流程：
	// 1. object.run(service, object.decls) 在当前声明背景下运行工厂；工厂内的 serve/register/expose 等被记录到 Run；
	// 2. 构造 Candidate 并加入 candidates；
	// 3. 比较同名既有 cell 的版本：降低 → invalid；升高 → reasons（需要 gate）；不变但 schema 变了 → invalid；
	//    新出现的 cell（旧 decls 中同名不是同一个 cell）不参与比较，由 initCells 初始化；
	// 4. 找出延迟资源：独占资源，或依赖了延迟资源的资源（递归传播由 deps 顺序保证：deps 先于依赖者创建）；
	//    延迟资源加入 atGate；若新独占资源对应旧声明中仍打开的独占资源，加入 replaced（gate 时关闭）；
	// 5. 打开非延迟资源与新引用，等待 run 的远程引用水合；
	// 6. 无 gate 原因时：初始化新 cell 并 dryRun；有原因时迁移与 initCells 留到 gate。
	// 错误：工厂/资源打开/水合/schema 校验失败会抛出，prepare 回滚并清理已打开资源。
	async prepareObject(object: ObjectImpl): Promise<void> {
		const service = this.services.get(object.typeName)!;
		const run = object.run(service, object.decls);
		const candidate: Candidate = {
			object,
			service,
			run,
			reasons: [],
			atGate: [],
			replaced: [],
			migrated: new Map(),
			derived: new Map(),
			staged: undefined,
		};
		this.candidates.set(object, candidate);
		// Each cell carries its own version: a raised one gates and migrates, a schema change without one is refused.
		for (const [name, cell] of run.decls.cells) {
			if (object.decls.cells.get(name) !== cell) continue;
			const from = object.decls.cellVersions.get(name) ?? 1;
			const to = run.decls.cellVersions.get(name) ?? 1;
			if (to < from)
				throw invalid("state", `${object.address}: version of state ${name} lowered from ${from} to ${to}`);
			if (to > from) candidate.reasons.push(`state ${name} version ${from} -> ${to}`);
			else if (!deepEqual(cell.schema, run.decls.cellSchemas.get(name)))
				throw invalid("state", `${object.address}: schema of state ${name} changed without a version bump`);
		}
		const deferred = new Set<ResourceImpl>();
		for (const resource of run.created.resources) {
			if (resource.exclusive || resource.deps.some((dep) => deferred.has(dep as ResourceImpl)))
				deferred.add(resource);
		}
		for (const resource of deferred) {
			candidate.atGate.push(resource);
			const old = object.decls.resources.get(resource.key);
			if (resource.exclusive && old?.exclusive && old.state === "open") candidate.replaced.push(old);
		}
		if (deferred.size > 0) candidate.reasons.push("exclusive resource replaced");
		await object.open(
			run.created.resources.filter((resource) => !deferred.has(resource)),
			run.created.refs,
			this.abort.signal,
		);
		await object.waitHydrated(run);
		// Cells this reload adds read their first value once the new resources are open (gated objects: at the gate);
		// the derivations over them are checked after.
		if (candidate.reasons.length === 0) {
			await object.initCells(run, this.abort.signal);
			dryRun(candidate);
		}
	}

	/**
	 * Every reference that survives into the new code version must bind to the new provider. Browser references don't block a
	 * reload: after the commit they get `upgrade_required` instead.
	 */
	// 检查所有将进入新代码版本的引用能否绑定新提供者契约。
	// 先计算 dropped：候选对象旧声明中的引用，如果新 run 的引用集合不再包含它，说明新工厂不再声明该引用，
	// 提交时会被释放/解绑，因此不需要绑定检查。
	// 然后遍历宿主对象：只看 changed 类型且有候选服务的；对每个 ref：
	// - 跳过宿主自举引用（hostObjects 中的那个），它在 commit 时随提供者契约一起替换；
	// - 跳过 dropped；
	// - 浏览器引用（owner === "client"）不阻塞重载：提交时 bind 失败会改为 upgrade_required；
	// - 其余引用调用 bind(new contract, accepts, ref.contract)，失败即 prepare 失败（服务端引用必须先升级）。
	// 副作用：无持久修改（bind 只校验并返回绑定描述）。
	checkRefs(): void {
		const dropped = new Set<unknown>();
		for (const { object, run } of this.candidates.values()) {
			for (const ref of object.decls.refs.values())
				if (![...run.decls.refs.values()].includes(ref)) dropped.add(ref);
		}
		for (const object of this.host.objects.values()) {
			const service = this.services.get(object.typeName);
			if (service === undefined || !this.changed.has(object.typeName)) continue;
			for (const ref of object.refs) {
				// The host's bootstrap reference follows this provider at commit; it is not an old-code consumer.
				if (ref === this.host.hostObjects.get(object.typeName)) continue;
				if (!dropped.has(ref) && ref.owner !== "client")
					bind(service.contract, service.options.accepts, ref.contract);
			}
		}
	}

	// 生成注册表构建输入：每个存活声明及其对象。排除已移除类型；若对象有候选，用候选 run.decls，否则用当前 decls。
	// liveDecls(true) 的参数 true 表示同时包含 deferredRuntime 对象（本次新增类型、运行时尚未激活）；false 会排除它们。
	// 返回值是新数组，不修改宿主。
	// 提交前 buildTables 用它计算候选表；提交后表的安装是原子的（host.installTables）。
	entries(): [ObjectImpl, Run["decls"]][] {
		return this.host
			.liveDecls(true)
			.filter(([object]) => !this.removed.has(object.typeName))
			.map(([object, decls]) => [object, this.candidates.get(object)?.run.decls ?? decls]);
	}

	/**
	 * Admission cut, wait for grandfathered roots (deadline), replace exclusive resources, migrate into private
	 * copies. Old tasks of gated objects are stopped at the cut; listener events are queued until commit or abort.
	 */
	// 准入切面（admission cut）：对需要迁移的对象停止旧任务、等待仍持有旧实现租约的 roots 结束、替换独占资源、
	// 初始化新 cell，最后迁移状态。输入：this.candidates（prepareObject 已填充）；副作用大，失败必须回滚。
	// 流程：
	// 1. gated = reasons 非空且对象仍 live 的候选；
	// 2. 对每个 gated 对象：记录当前 leases 的 root id 为 grandfathered，设置 object.gate（后续事件排队），
	//    停止后台任务；若没有 grandfathered roots 立即 resolve；
	// 3. 等待全部 drained 或 gateDeadline。超时抛 aborted/reason gate_deadline，details.blocking 列出仍阻塞的 root id；
	// 4. #alive 后逐个对象：先把 replaced 旧独占资源登记到 closed 再关闭（ResourceImpl.close 会先把 state 置为
	//    closed 再调用用户 close，因此即使用户 close 抛错，rollback 仍会尝试重新打开它），
	//    打开 atGate 资源；初始化新 cell；再 #alive；
	// 5. 最后对所有 gated 候选执行 migrate（迁移值 + dryRun）。
	// 注意 gate 只处理“需要迁移/替换资源”的对象；无 reasons 的候选在 prepareObject 已初始化/预演，提交时直接安装。
	async gate(): Promise<void> {
		this.gated = [...this.candidates.values()].filter(
			(candidate) => candidate.reasons.length > 0 && candidate.object.status === "live",
		);
		const drained = this.gated.map(({ object }) => {
			const grandfathered = new Set(object.leases.keys());
			return new Promise<void>((resolve) => {
				object.gate = { grandfathered, queue: [], drained: resolve };
				object.stopTasks();
				if (grandfathered.size === 0) resolve();
			});
		});
		const deadline = this.options.gateDeadline ?? 5000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = await Promise.race([
			Promise.all(drained).then(() => false),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(true), deadline);
			}),
		]);
		clearTimeout(timer);
		if (timedOut) {
			const blocking = this.gated.flatMap(({ object }) => [...(object.gate?.grandfathered ?? [])]);
			throw new ChordError(
				"aborted",
				`gate deadline (${deadline} ms) missed; blocking roots: ${blocking.join(", ")}`,
				{
					reason: "gate_deadline",
					details: { blocking },
				},
			);
		}
		this.#alive();
		for (const candidate of this.gated) {
			const { object } = candidate;
			for (const old of candidate.replaced) {
				// Owned by the rollback before closing: a failing close must still be restored.
				this.closed.push([object, old]);
				await old.close(object.openOrder);
			}
			await object.open(candidate.atGate, [], this.abort.signal);
			this.#alive();
			await object.initCells(candidate.run, this.abort.signal);
			this.#alive();
		}
		for (const candidate of this.gated) this.migrate(candidate);
	}

	// 为一个 gated 候选计算迁移后的 cell 值，并调用 dryRun 校验派生。输入 candidate（run 与旧对象声明）；
	// 输出无，结果写入 candidate.migrated/derived。
	// 对每个新 run 中的 cell：
	// - 只处理旧声明中同名且同一 cell 的（新建 cell 不需要迁移）；
	// - 版本升高且提供了迁移函数：fn(structuredClone(cell.value), from)，旧值先深拷贝，避免迁移函数修改旧状态；
	// - 否则若新旧 schema 不同：只可能是版本已升高但没有迁移函数（版本未变而 schema 不同已在 prepareObject 拒绝），
	//   旧值原样作为结果并按新 schema 校验；
	// - 否则（版本与 schema 都未变，或版本升高但 schema 相同）：不迁移，install 只更新 schema；
	// - 迁移结果按新 schema assertValid，失败则 prepare 回滚。
	// 最后 dryRun 重新计算派生并校验所有对外状态。注意这里的 cell.value 仍是旧实现下的值，尚未 reset。
	migrate(candidate: Candidate): void {
		const { object, run } = candidate;
		for (const [name, cell] of run.decls.cells) {
			if (object.decls.cells.get(name) !== cell) continue;
			const schema = run.decls.cellSchemas.get(name)!;
			const from = object.decls.cellVersions.get(name) ?? 1;
			const fn = run.decls.cellMigrations.get(name);
			let value: unknown;
			if ((run.decls.cellVersions.get(name) ?? 1) > from && fn !== undefined)
				value = fn(structuredClone(cell.value), from);
			else if (!deepEqual(cell.schema, schema)) value = cell.value;
			else continue;
			assertValid("state", `${object.address}: migrated state ${name}`, schema, value);
			candidate.migrated.set(cell, value);
		}
		dryRun(candidate);
	}

	// 回滚 prepare 的所有副作用，把宿主恢复到重载前。可重复调用（rolledBack 防重）。
	// 顺序：
	// 1. 标记 rolledBack、abort 本次资源/激活信号和所有 facet 运行；
	// 2. 丢弃候选与新类型对象已暂存的监听器；
	// 3. 对每个候选：从对象 pending 声明中移除新 run，并 object.unwind(run) 关闭新资源/引用/派生（错误只报告）；
	// 4. 重新打开 gate 中关闭的 replaced 资源（仅 state 仍为 "closed" 的）；打开失败则 markUnavailable 并报告，
	//    绝不静默当作恢复；
	// 5. 对已 gate 的对象打开事件闸门并 startTasks（被暂停的旧任务继续）；
	// 6. 处理“本次新增类型”的对象：当前服务表中没有该类型 → dispose(gone, "reload aborted; type not served")；
	// 7. 清除 host.pending 与 host.gating。
	// 注意不删除 host.current 中已存在对象；它们的旧声明从未被替换（install 只在 commit 调用）。
	async rollback(): Promise<void> {
		if (this.rolledBack) return;
		this.rolledBack = true;
		this.abort.abort(new ChordError("aborted", "reload aborted"));
		for (const run of this.facetRuns.values()) run.abort(new ChordError("aborted", "reload aborted"));
		const report = (error: unknown): void => this.host.report(error);
		for (const candidate of this.candidates.values()) candidate.staged?.discard();
		for (const staged of this.deferred.values()) staged.discard();
		for (const { object, run } of this.candidates.values()) {
			object.pending.delete(run.decls);
			await object.unwind(run).catch(report);
		}
		// Replaced exclusive resources are restored; one that cannot be is marked unavailable, never silently closed.
		for (const [object, resource] of this.closed) {
			if (resource.state !== "closed") continue;
			await resource.open(new AbortController().signal, object.openOrder).catch((error: unknown) => {
				resource.markUnavailable();
				report(
					new ChordError("unavailable", `${object.address}: resource ${resource.key} could not be restored`, {
						cause: error,
					}),
				);
			});
		}
		for (const { object } of this.gated) {
			if (object.gate === undefined) continue;
			object.openGate();
			object.startTasks();
		}
		// Objects of types this reload would have added lose their code.
		const reason = new ChordError("gone", "reload aborted; type not served");
		for (const object of [...this.host.objects.values()]) {
			if (!this.host.current.services.has(object.typeName)) await object.dispose(true, reason).catch(report);
		}
		this.host.pending = undefined;
		this.host.gating = undefined;
	}

	/**
	 * Publishes the new code version in one synchronous step. Everything fallible ran in prepare (factories, opens,
	 * migration and derivation checks against the prospective schemas, listener subscriptions), so this only installs.
	 * Observers (state, shapes, registries, listener roots) are notified after the whole step. If an install still
	 * throws, the code version is half-published: the host fails terminally and admits no more work.
	 */
	// 提交：在 holdPublications 内同步发布新版本。输入可选 beforeStart：在安装完成后、启动新代码前调用，
	// 集群协调端用它先发送 commit 帧，保证子主机不会先于自己的提交消息开始工作。
	// 流程：#publish 安装并收集 #starts；beforeStart；依次执行并清空 #starts（启动任务、宿主对象、facet 信号、
	// 引用释放等）。holdPublications 把状态/形状/注册表/监听器通知推迟到整个同步块之后，避免观察者看到半提交状态。
	// 错误：任何安装异常都会让宿主 host.fail(error) 进入终态（不再接收工作），并把错误包装成 reloadError 抛出。
	// 注意 commit 不做回滚：prepare 已保证所有可能失败的检查完成；若仍失败，说明存在代码缺陷或不可恢复的安装冲突。
	commit(beforeStart?: () => void): ReloadReport {
		try {
			return holdPublications(() => {
				const report = this.#publish();
				// Installed, not yet started: the coordinator queues its commit frames here, so nothing this code version
				// starts (tasks, host object activations, then the held listener/registry/state notifications) can reach a child
				// first.
				beforeStart?.();
				for (const start of this.#starts.splice(0)) start();
				return report;
			});
		} catch (error) {
			this.host.fail(error);
			throw reloadError(error);
		}
	}

	/** Work that may start new-code-version roots, run after installation (and after the coordinator's commit frames). */
	// 安装阶段登记、安装完成后执行的启动动作：object.startTasks、host.startHostObject、host.facetRunChanged、
	// pinned.release 等。用 splice(0) 取出并清空，防止重复执行；动作内部抛错会向上冒泡到 commit 的 catch。
	readonly #starts: (() => void)[] = [];

	// 同步发布核心：切换 current/previous、安装候选、处理新增/非存活对象、注册表、facets、宿主对象生命周期。
	// 输入无（使用 this.candidates/services/tables）；输出 ReloadReport。
	// 关键顺序：
	// 1. 取走 pending（之后 host.pending=undefined），把它登记到 host.codeVersions，previous/current 指针交换；
	// 2. 遍历宿主对象：removed 类型跳过；无候选且存在当前实现的对象，把旧实现复制到新版本号
	//    （代码未变，复用同一实现）；有候选且 live 的对象调用 install，并记入 prepared；非 live 的候选稍后清理；
	// 3. 非 live 候选：丢弃 staged、从 pending 声明移除、unwind 新资源（异步，错误报告）；
	// 4. deferred（新增类型对象）：live 的关闭 deferredRuntime、激活 staged、登记 startTasks；非 live 丢弃 staged；
	// 5. 安装注册表并通知订阅者（第三个参数 true 表示全量安装语义）；
	// 6. 对 removed 类型的对象 dispose(gone, "type no longer served")，并删除对应的 hostObjects 条目；
	// 7. 合并新 facets、删除 remove 中的 facet；登记 facet 运行信号的切换（提交后 abort 旧运行）；
	// 8. 清除 host.gating；对每个候选 service 处理 hostLifetime 变化：需要时提交后启动宿主对象，
	//    从 host 生命周期变为 referenced 时删除 pinned 引用并提交后 release。
	// 副作用：所有安装立即发生；通知被 holdPublications 推迟；部分启动动作排入 #starts。
	#publish(): ReloadReport {
		const host = this.host;
		const previous = host.current;
		const next: CodeVersionState = host.pending!;
		host.pending = undefined;
		host.codeVersions.set(next.id, next);
		host.previous = previous;
		host.current = next;
		const prepared: string[] = [];
		for (const object of [...host.objects.values()]) {
			if (this.removed.has(object.typeName)) continue;
			const candidate = this.candidates.get(object);
			if (candidate === undefined) {
				const installed = object.implementations.get(previous.id);
				if (installed !== undefined) object.implementations.set(next.id, { ...installed, codeVersion: next.id });
				continue;
			}
			if (object.status !== "live") continue;
			this.install(candidate, next.id);
			prepared.push(object.address);
		}
		for (const { object, run, staged } of this.candidates.values()) {
			if (object.status === "live") continue;
			staged?.discard();
			object.pending.delete(run.decls);
			object.unwind(run).catch((error: unknown) => host.report(error));
		}
		// Objects of types this reload adds start their runtime now.
		for (const [object, staged] of this.deferred) {
			if (object.status !== "live") {
				staged.discard();
				continue;
			}
			object.deferredRuntime = false;
			staged.activate();
			this.#starts.push(() => object.startTasks());
		}
		host.installTables(next, this.tables, true);
		const reason = new ChordError("gone", "type no longer served");
		for (const object of [...host.objects.values()]) {
			if (this.removed.has(object.typeName))
				object.dispose(true, reason).catch((error: unknown) => host.report(error));
		}
		for (const name of this.removed) host.hostObjects.delete(name);
		for (const facet of this.facets) host.facets.set(facet.name, facet);
		for (const name of this.options.remove ?? []) host.facets.delete(name);
		// The replaced and removed runs' signals abort after the install, like other observers.
		for (const [name, run] of this.facetRuns) this.#starts.push(() => host.facetRunChanged(name, run));
		for (const name of this.options.remove ?? []) this.#starts.push(() => host.facetRunChanged(name, undefined));
		host.gating = undefined;
		for (const [name, service] of this.services) {
			if (hostLifetime(service) && this.changed.has(name) && host.hostObjects.get(name)?.object?.status !== "live") {
				this.#starts.push(() => host.startHostObject(service));
			}
			// A type whose lifetime became "referenced" lives on only while someone else references its object.
			const pinned = host.hostObjects.get(name);
			if (!hostLifetime(service) && pinned !== undefined) {
				host.hostObjects.delete(name);
				this.#starts.push(() => pinned.release());
			}
		}
		return {
			codeVersion: next.id,
			previous: previous.id,
			changed: [...this.changed],
			removed: [...this.removed],
			prepared,
			gated: this.gated.map(({ object }) => object.address),
		};
	}

	// 把候选实现安装到一个对象上（仅在 commit 的同步发布中调用）。输入 candidate 与目标 codeVersion；
	// 输出无，副作用是替换对象声明/服务/实现、资源 adopt、schema/值更新、派生重算/挂载、监听器激活、
	// 启动任务、打开 gate、替换宿主自举引用、让引用重新绑定。
	// 步骤：
	// 1. 从 pending 声明移除新 run，停止旧任务；
	// 2. gated 对象：detach 旧 run 中不再保留的派生（旧派生不能在新迁移值上继续计算）；
	// 3. 替换 object.decls/service，adopt 保留的资源声明，写入新 implementation（codeVersion 键）；
	// 4. gated 对象：minCodeVersion 提升到新版本，立即退役旧实现（旧代码不能操作迁移后的状态）；
	// 5. 先刷新 schema，再对迁移值 cell.reset（同时更新 schema），未迁移 cell 只赋 schema；
	// 6. 新派生态 attach(candidate.derived) 复用预演值；保留的旧派生态 refresh() 用真实值重算；
	// 7. 激活 staged 监听器，登记 startTasks，打开 gate；
	// 8. 宿主自举引用若契约指纹变化：先创建 replacement 并 addRef，再 release 旧引用（避免对象被 dispose/reopen）；
	// 9. 所有 ref：浏览器引用先尝试 bind，失败则 gone(upgrade_required) 并释放；成功的浏览器引用与其余引用一样
	//    调用 shapeChanged 通知形状变化。
	install(candidate: Candidate, codeVersion: number): void {
		const { object, run, service } = candidate;
		const gated = candidate.reasons.length > 0;
		object.pending.delete(run.decls);
		object.stopTasks();
		if (gated) {
			// Old derivations would compute over migrated values; the old implementation can no longer run anyway.
			const kept = new Set(run.decls.derives.values());
			for (const derived of object.decls.derives.values()) if (!kept.has(derived)) derived.detach();
		}
		object.decls = run.decls;
		object.service = service;
		// Kept resources close with the new code's `close`; replaced ones keep their own (closed at retirement).
		// 保留的资源（同名且声明兼容）沿用新声明：以后关闭时执行新代码的 close；被替换的资源不 adopt，
		// 仍保留旧声明，在退役阶段按旧代码关闭。
		for (const [resource, declaration] of run.decls.adopted) resource.adopt(declaration);
		object.implementations.set(codeVersion, {
			codeVersion,
			service,
			implementation: run.implementation,
			decls: run.decls,
		});
		if (gated) {
			// Old code can never run over migrated state: drop the previous implementation now, not at retirement.
			object.minCodeVersion = codeVersion;
			for (const old of [...object.implementations.keys()])
				if (old !== codeVersion) this.host.retireImplementation(object, old);
		}
		// Schemas first, then the values validated against them in prepare.
		object.refreshSchemas();
		for (const [name, cell] of run.decls.cells) {
			const schema = run.decls.cellSchemas.get(name)!;
			if (candidate.migrated.has(cell)) cell.reset(candidate.migrated.get(cell), schema);
			else cell.schema = schema;
		}
		const created = new Set(run.created.derives);
		for (const derived of run.created.derives) derived.attach(candidate.derived);
		for (const derived of run.decls.derives.values()) if (!created.has(derived)) derived.refresh();
		candidate.staged?.activate();
		this.#starts.push(() => object.startTasks());
		object.openGate();
		const pinned = this.host.hostObjects.get(object.typeName);
		if (pinned?.object === object && pinned.contract.fingerprint !== service.contract.fingerprint) {
			const replacement = new RefImpl(object, service.contract, "host");
			// Acquire first: releasing the only reference must not dispose/reopen the surviving host object.
			object.addRef(replacement);
			this.host.hostObjects.set(object.typeName, replacement);
			pinned.release();
		}
		for (const ref of [...object.refs]) {
			// Browser references whose contract no longer binds are told to reload their code (they never block a reload).
			if (ref.owner === "client") {
				try {
					bind(service.contract, service.options.accepts, ref.contract);
				} catch (error) {
					ref.gone(
						new ChordError("upgrade_required", `${object.typeName} changed; reload the web facets`, {
							cause: error,
						}),
					);
					object.release(ref);
					continue;
				}
			}
			ref.shapeChanged();
		}
	}
}
