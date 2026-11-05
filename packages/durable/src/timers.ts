// 文件导读
// 所属：packages/durable 的定时器适配层，被 session/session.ts（空闲文档淘汰）与 harness/harness.ts（任务休眠/唤醒）使用。
// 作用：把宿主可选的 HarnessOptions.setTimer 包装成两个明确语义的定时器：foreground（必须触发，否则工作停滞）与
// background（只释放内存，可被拒绝）；没有宿主实现时使用 nativeTimer（setTimeout）。
// 职责边界：不排队任务、不推进时钟、不捕获回调内部错误（回调抛错由调用方/事件循环处理）；只负责 arm、unref 与失败降级。
// 上游：Session/Harness 构造时调用 hostTimers(setTimer, report)；下游：types.ts 的 SetTimer 类型与全局 setTimeout/clearTimeout。
// 能力清单：
// - nativeTimer：默认 SetTimer；支持超过 setTimeout 上限的延时（分段等待），background 定时器 unref，Workers 中拒绝 background。
// - Timers：Session/Harness 使用的两个方法 foreground/background。
// - hostTimers(setTimer, report)：包装宿主实现；foreground 被拒绝/抛错时退回 nativeTimer 并只报告第一次失败；
//   background 被拒绝/抛错时报告并返回 undefined（调用方负责稍后释放）。
// 组合与典型顺序：HarnessOptions.setTimer → hostTimers → Session 的定时淘汰 / TaskRuntime.setTimer / 睡眠恢复。
// 示例（真实签名）：
//   const timers = hostTimers(hostSetTimer, (error) => console.error(error));
//   const disarm = timers.foreground(() => wake(), 1_000); // 一定会触发；返回的函数可取消
//   const idle = timers.background(() => evict(), 60_000);  // 宿主可拒绝，返回 undefined
// 阅读顺序：先看 Timers 的两个方法契约与 SetTimer（types.ts），再看 nativeTimer 的分段/ unref 处理，最后看 hostTimers 的降级规则。
import type { SetTimer } from "./types.ts";

/** Longest delay `setTimeout` supports; a longer one is waited for in several steps. */
// setTimeout 能接受的最大延时（2^31-1 毫秒，约 24.8 天）；更大的延时必须分段等待，否则会被截断或立即触发。
const MAX_TIMER_DELAY = 2_147_483_647;

/**
 * Cloudflare Workers: a pending timer keeps a Durable Object from hibernating or being evicted, even an unreferenced
 * one (`nodejs_compat` gives timers an `unref()` that changes nothing).
 */
// 运行时探测 Cloudflare Workers：Workers 中只要还有 pending 定时器，Durable Object 就无法休眠或被驱逐，
// 即使该定时器没有被任何变量引用（nodejs_compat 提供的 unref() 在这里不改变行为）。因此 background 定时器直接拒绝。
const inWorkers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

/**
 * The default `HarnessOptions.setTimer`: `setTimeout`, waiting out delays beyond its limit in steps. A background timer
 * is unreferenced, so it never keeps the process alive. It is declined in Cloudflare Workers and wherever timers cannot
 * be unreferenced.
 */
// 默认 SetTimer 实现。
// 输入：callback、delayMs、{ background }；输出：取消函数，或在无法满足 background 语义时返回 undefined。
// 副作用：安排 setTimeout、可能多次重新安排；错误：不主动抛错（除非宿主 setTimeout 自身抛错）。
// 主要流程：Workers 拒绝 background → 递归 arm 分段等待超长延时 → background 尝试 unref → 检查 unref 是否存在，
// 不存在则清除并拒绝 → 返回只清除当前 handle 的取消函数。
// 例子：nativeTimer(cb, 10 * 24*60*60*1000, { background: false }) 会先等 24.8 天，再等剩余时间，最后调用 cb。
export const nativeTimer: SetTimer = (callback, delayMs, options) => {
	// Workers 中 pending 定时器阻止休眠，background 语义无法满足，直接拒绝。
	if (options.background && inWorkers) return undefined;
	// 递归安排定时器；remaining 是尚未等待的总毫秒数。
	const arm = (remaining: number): ReturnType<typeof setTimeout> => {
		// 单次最多等 MAX_TIMER_DELAY；Math.min 同时处理正常范围与超长范围。
		const next = setTimeout(
			() => {
				// 还有剩余时间：重新 arm，并把 handle 更新为新定时器，使取消函数始终指向当前等待。
				if (remaining > MAX_TIMER_DELAY) handle = arm(remaining - MAX_TIMER_DELAY);
				// 已经等够：调用用户回调（只调用一次）。
				else callback();
			},
			Math.min(remaining, MAX_TIMER_DELAY),
		);
		// Node 的 Timeout 对象有 unref()；浏览器返回 number，没有该方法，所以用结构化类型断言 + 可选调用。
		if (options.background) (next as { unref?: () => void }).unref?.();
		return next;
	};
	// 负延时按 0 处理；handle 在回调触发/取消时被读取，闭包共享同一个变量。
	let handle = arm(Math.max(0, delayMs));
	// background 必须是 unref 的定时器，否则会阻止进程退出；宿主没有 unref 时撤销并拒绝。
	if (options.background && typeof (handle as { unref?: unknown }).unref !== "function") {
		clearTimeout(handle);
		return undefined;
	}
	// 取消函数只清除“当前” handle；若超长延时已经重新 arm，handle 已被更新。
	return () => clearTimeout(handle);
};

// Session 与 Harness 通过宿主的 setTimer 获得的两类定时器。
/** Timers the Session and Harness arm through the host's `setTimer`. */
export type Timers = {
	/** A timer that paces or resumes work; when the host throws or declines it, `setTimeout` arms it instead. */
	// 前台定时器：驱动节流/唤醒等“必须发生”的工作。宿主抛错或返回 undefined 时自动退回 setTimeout；
	// 返回的取消函数保证可用（不会 undefined）。
	foreground(callback: () => void, delayMs: number): () => void;
	/** A timer that only frees memory; `undefined` when the host declines it. */
	// 后台定时器：只用于释放内存（如淘汰空闲文档）。宿主可以返回 undefined 拒绝；拒绝不影响正确性，只影响及时回收。
	background(callback: () => void, delayMs: number): (() => void) | undefined;
};

/**
 * Wrap a host `setTimer`. A foreground timer must fire, or work stalls: one the host throws on or declines is armed
 * with `setTimeout`, and the first such failure is reported. A background one the host throws on is reported and
 * declined.
 */
// 把宿主可选的 SetTimer 包装成 Timers。
// 输入：setTimer（省略时用 nativeTimer）、report（把宿主失败转成 Harness 报告的回调）。
// 输出：foreground/background 两个方法；副作用：可能调用 report、可能安排原生定时器；错误：不向外抛错。
// 主要流程：
//   - foreground 先试宿主；返回 undefined 或抛错时记录第一次失败，并退回 nativeTimer（前台必定成功，故用 `!`）。
//   - background 直接返回宿主结果；抛错时报告并返回 undefined（拒绝），不退回原生定时器。
// 设计：前台失败只在第一次 report，避免每次节流都刷报告；后台失败不缓存，宿主每次抛错都报告。
// 例子：hostTimers(undefined, report).foreground(cb, 100) 等价于 nativeTimer(cb, 100, {background:false})。
export function hostTimers(setTimer: SetTimer | undefined, report: (error: unknown) => void): Timers {
	// 宿主没有提供实现时使用默认实现；`??` 只对 undefined/null 生效。
	const arm = setTimer ?? nativeTimer;
	// 前台降级只报告第一次，防止高频定时器造成报告风暴。
	let reported = false;
	const fallBack = (error: unknown): void => {
		if (reported) return;
		reported = true;
		report(error);
	};
	return {
		foreground: (callback, delayMs) => {
			try {
				// 宿主返回 undefined 表示拒绝；返回函数表示已安排并可取消。
				const disarm = arm(callback, delayMs, { background: false });
				if (disarm !== undefined) return disarm;
				// 宿主静默拒绝：构造说明性错误，仅第一次报告。
				fallBack(new Error("HarnessOptions.setTimer declined a timer that paces work; using setTimeout"));
			} catch (error) {
				// 宿主抛错：同样只报告第一次，然后走统一的原生降级路径。
				fallBack(error);
			}
			// 前台工作必须推进；nativeTimer 对 background:false 不会返回 undefined（Workers 只拒绝 background），
			// 因此用非空断言 `!` 得到 () => void。
			return nativeTimer(callback, delayMs, { background: false })!;
		},
		background: (callback, delayMs) => {
			try {
				// 后台定时器如实转交宿主：undefined 是合法拒绝，调用方会稍后释放内存。
				return arm(callback, delayMs, { background: true });
			} catch (error) {
				// 宿主抛错：报告并拒绝；不退回原生实现，因为宿主可能明确不希望存在后台定时器。
				report(error);
				return undefined;
			}
		},
	};
}
