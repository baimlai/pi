// Parked attempts (dependency model §3, §7): the dependency check, what an attempt's declared dependencies (`self.get`
// references and `self.registry` values) say at one moment: all live, or what the parked attempt shows while one is not
// (`loading`, `failed { waiting }` naming the nearest blocker and the root cause, or `broken` for a cycle, authority or
// an ended dependency), whether this host's first pass can count it (no blocker here still without its first outcome,
// decision (a)), and its first blocker; and the `parked_long` report of a long parking episode.
// 文件导读
// 所属：packages/chord/src/host（主机层），实现依赖检查与停放诊断。
// 职责：给定 self.get 引用与 self.registry 值，判断全部 live、仍需 parked（含首轮与阻塞者）或 broken。
// 边界：只读状态，不启动重试、不修改绑定；重试由 Attempt 与引用层触发。
// 上游：Attempt.#activate 首次检查、Attempt.#park 每次依赖变化后检查、reload 报告。
// 下游：object.parked/waitsFor 展示；parkedCause 生成 FailureCause；ParkedLong 发 parked_long 报告。
// 错误：broken 携带原始 ChordError；永久失败只由 healsNever 判定，其余都视为可等待。
// 能力清单：
// - Dependency：reference 或 registry 两种依赖。
// - Blocker：停放诊断里的名字与 loading/failed 状态。
// - Check：live/parked/broken 三态结果。
// - checkDependencies：按声明顺序计算 Check。
// - parkedCause：把 parked 转成 reload 需要的 FailureCause。
// - waitingOn：构造等待中的 Failed 展示。
// - ParkedLong：一次停放事件的计时与上报。
// 组合与顺序：#park -> checkDependencies -> parkedCause/blockedBy -> 依赖变化 -> 再次检查。
// 示例：const check = checkDependencies([{ kind: "reference", binding }]);
// 建议阅读顺序：Dependency -> Check -> checkDependencies -> healsNever -> parkedCause/waitingOn -> ParkedLong。

import { ChordError, type FailureCause, isChordError } from "../data/index.ts";
import { asChordError, waitingFor } from "../data/internal.ts";
import type { RegistryValueSource } from "../registries/internal.ts";
import type { ChordObject } from "./object.ts";
import { type Failed, LOADING, type RefState } from "./ref-state.ts";
import type { Binding } from "./reference.ts";

/** One declared dependency: a reference (`self.get`) or a registry's value (`self.registry`). */
// 可辨识联合：kind 区分两种依赖。reference 依赖一条引用绑定的状态；registry 依赖组合值的状态。
// 两者在 checkDependencies 中走不同分支，TypeScript 依据 kind 自动收窄可用字段。
export type Dependency =
	| { readonly kind: "reference"; readonly binding: Binding }
	| { readonly kind: "registry"; readonly value: RegistryValueSource };

/** A blocker as `parked_long` names it: a reference's label or `registry <name>`, and whether it loads or failed. */
// 诊断用阻塞者：label 是给人看的名字；state 只有“加载中”和“失败”两种，表示停放时看到的状态。
export type Blocker = { readonly label: string; readonly state: "loading" | "failed" };

/**
 * What the dependencies say. `live`: every one is live (hydrated: a reference's members have values). `parked`: what
 * the attempt shows (`loading`, or `failed { waiting }` naming its first failed blocker), whether its first pass is
 * over (`firstPass`: no blocker, loading or failed, is an object here still without its first outcome), and its first
 * blocker in declaration order (`parked_long` names it). `broken`: one failed for a cycle (`invalid/cycle`), for
 * authority (`forbidden`) or ended: it never comes back by itself.
 */
// Check 是三态可辨识联合：
// - live：全部就绪，可以继续激活；
// - parked：仍要等，shown 是对外展示的状态，firstPass 决定本机首轮能否算通过，blocker 是声明顺序上的第一个
//   阻塞者，loadingOn 是第一个“仅加载中”的标签（reload 报告用）；
// - broken：某个依赖永久失败（环、授权拒绝、已结束），继续等没有意义。
// firstPass=false 的业务含义：阻塞者来自另一台主机的对象，它的首轮结果尚未到达，本机不能把它当作“首轮已过”。
export type Check =
	| { readonly kind: "live" }
	| {
			readonly kind: "parked";
			readonly shown: RefState;
			readonly firstPass: boolean;
			readonly blocker: Blocker;
			/** The first blocker in declaration order that is only loading (a reload's report names it). */
			readonly loadingOn: string | undefined;
	  }
	| { readonly kind: "broken"; readonly error: ChordError };

// 共享的 live 结果：该对象没有可变字段，复用可避免每次检查分配。
const LIVE: Check = { kind: "live" };

/** Checks `dependencies` in declaration order (the first failed one is the one the attempt names). */
// 检查一组依赖的当前状态，不修改任何状态，也无异步等待。
// 输入是声明顺序的 Dependency 数组；输出 Check。第一个失败/加载中的依赖决定 blocker 和对外显示的 waiting。
// 例：两个引用，第一个 live、第二个 failed -> parked，shown 指向第二个的 waiting，blocker 也是第二个。
export function checkDependencies(dependencies: readonly Dependency[]): Check {
	// 记录第一个失败依赖的展示状态；??= 保证只取第一个。
	let failed: Failed | undefined;
	// 首轮标志：只要某个依赖的目标对象仍处于阻塞首轮的状态，就置 false。
	let firstPass = true;
	// 声明顺序上的第一个阻塞者（不管是 loading 还是 failed）。
	let blocker: Blocker | undefined;
	// 第一个仅处于 loading 的依赖标签；与 blocker 分开，因为 blocker 可能先是一个失败项。
	let loadingOn: string | undefined;
	for (const dependency of dependencies) {
		// registry 依赖：组合值有 start()/last 两个概念。start() 给出当前可用性。
		if (dependency.kind === "registry") {
			const { value } = dependency;
			const start = value.start();
			// 有值，或至少保留着上一个好值（last），就算可用；注册表的失败不阻塞已有好值的对象。
			if (start.kind === "value" || start.last !== undefined) continue;
			// 标签用于展示和诊断；“registry <name>” 不是运行时标识，只是可读名字。
			const label = `registry ${value.name}`;
			// asChordError 把插件或内部抛出的未知错误收敛为 ChordError；waitingOn 包成 waiting 原因。
			failed ??= waitingOn(label, asChordError(start.error, label));
			blocker ??= { label, state: "failed" };
			continue;
		}
		const { binding } = dependency;
		// refState 是引用绑定的可辨识联合：live / loading / failed / ended。
		const state = binding.refState;
		switch (state.kind) {
			// live 表示引用目标已可调用，继续检查下一个。
			case "live":
				continue;
			// ended 表示目标永久结束：不会自行恢复，整个尝试 broken。
			case "ended":
				return { kind: "broken", error: state.error };
			case "failed": {
				const { error } = state.cause;
				// 环或授权拒绝不会自愈；其余失败（例如暂时性）仍可等待重试。
				if (healsNever(error)) return { kind: "broken", error };
				failed ??= waitingOn(binding.label, error);
				blocker ??= { label: binding.label, state: "failed" };
				// Parked `waiting` on something here still in its first attempt: no first outcome yet (fix round 1).
				// target?. 同时处理“远程引用尚未绑定目标”的情况；blocksFirstPass 为 true 说明对方首轮尚未出结果。
				if (binding.target?.blocksFirstPass === true) firstPass = false;
				continue;
			}
			// loading 表示正在绑定/加载；只记录第一个标签，但 blocker 仍取声明顺序上的第一个。
			case "loading":
				loadingOn ??= binding.label;
				blocker ??= { label: binding.label, state: "loading" };
				if (binding.target?.blocksFirstPass === true) firstPass = false;
		}
	}
	// 没有任何阻塞项：全部可用。
	if (blocker === undefined) return LIVE;
	// 有阻塞但没有任何 failed：shown 用共享的 LOADING；有 failed 则优先展示它（失败比加载更具体）。
	return { kind: "parked", shown: failed ?? LOADING, firstPass, blocker, loadingOn };
}

/**
 * Whether a dependency failed with `error` never heals by itself, so its dependent breaks too: a cycle
 * (`invalid/cycle`: it would wait on a ring) or authority (`forbidden`: an `authorize` that refused, M§3.6; only
 * `retry()` or a reload helps).
 */
// 判断错误是否“永远不自愈”。isChordError 是运行时错误码检查，因为 error 可能来自插件或网络。
// 例：invalid/cycle 表示对象互相等待成环；forbidden 表示授权拒绝。两者都让依赖方直接 broken。
function healsNever(error: ChordError): boolean {
	return (isChordError(error, "invalid") && error.reason === "cycle") || isChordError(error, "forbidden");
}

/**
 * What a reload reports for a parked attempt (slice 7b §4): its failure's cause, or for a blocker that is only
 * loading a `waiting` cause naming it.
 */
// 把 parked 检查结果转成 reload 报告需要的 FailureCause。Extract<Check, { kind: "parked" }> 从联合中挑出
// parked 成员，保证调用方只能传 parked 状态。
// 例：仅加载中时返回 waiting 原因，消息说明 “<label> is loading”；已失败时直接复用原 cause。
export function parkedCause(check: Extract<Check, { readonly kind: "parked" }>): FailureCause {
	const { shown } = check;
	// shown 为 failed 时已经有完整原因（包含 waiting 链），直接返回。
	if (shown.kind === "failed") return shown.cause;
	// 加载中没有失败原因，合成一个 unavailable 的 waiting；loadingOn 缺失时用通用占位词。
	const label = check.loadingOn ?? "a dependency";
	return waitingFor(label, new ChordError({ code: "unavailable", message: `${label} is loading` }));
}

/** A parked attempt's state for a blocker `label` that failed with `error`. */
// 构造“正在等待某依赖”的展示状态：retryAt 为 undefined 表示不是定时重试，而是等依赖变化。
// 例：waitingOn("User@abc", error) 生成的 Failed 会出现在 parked 的 shown 里。
export function waitingOn(label: string, error: ChordError): Failed {
	return { kind: "failed", cause: waitingFor(label, error), retryAt: undefined };
}

/**
 * The `parked_long` report of one parking episode (dependency model §7, audit A11): once, when the attempt has been
 * parked longer than `readyTimeout`, whatever its blocker (a ring across hosts started at the same moment stays parked
 * so, and so does a long wait; nothing fails or retries). The clock and the report's `since` start when the episode
 * does (its pinned keys' loading included); the report names the blocker of the latest check. Its one timer runs until
 * the report or the episode's end (`stop`).
 */
// 一次停放事件的诊断计时器：构造函数登记一个 readyTimeout 计时器，到时若已有 blocker 就上报 parked_long。
// 输入是宿主对象（取 label、host.report、host.timeouts.ready）；无返回值。副作用：一个计时器与一次上报。
// 注意它不会让对象失败或重试，只报告；stop() 必须在停放结束时调用，避免计时器泄漏。
// 例：某对象停放超过 readyTimeout，报告 waitingFor="User@abc"、state="loading"、since=停放开始时刻。
export class ParkedLong {
	// 记录停放开始的墙上时间，上报时原样带给使用方，避免使用方自己估算。
	readonly #since = Date.now();
	// 一次性计时器句柄；ReturnType<typeof setTimeout> 让类型随运行环境（Node/浏览器）正确推导。
	readonly #timer: ReturnType<typeof setTimeout>;
	/** The blocker the latest check found. */
	// 最新一次检查发现的阻塞者；计时器触发时读取它，因此报告的是“到目前为止”的阻塞项。
	#blocker: Blocker | undefined;

	// 传入宿主对象，立即登记计时器；计时器回调是闭包，捕获 this 与 object。
	constructor(object: ChordObject) {
		this.#timer = setTimeout(() => {
			// 计时器可能在第一次检查前触发；此时没有可报告的阻塞者，静静返回。
			const blocker = this.#blocker;
			if (blocker === undefined) return;
			const { label, state } = blocker;
			// report 是观测副作用，不改变对象状态；字段名与 parked_long 报告契约一致。
			object.host.report({
				kind: "parked_long",
				object: object.label,
				waitingFor: label,
				state,
				since: this.#since,
			});
		}, object.host.timeouts.ready);
	}

	/** What the latest check found blocking. */
	// 更新最新阻塞者（每次检查后由 #park 调用）；不重置 since，也不重新排计时器。
	blockedBy(blocker: Blocker): void {
		this.#blocker = blocker;
	}

	/** The episode ended: no report from now on. */
	// 结束停放：清除计时器；已触发的回调无法撤回，但回调只执行一次。
	stop(): void {
		clearTimeout(this.#timer);
	}
}
