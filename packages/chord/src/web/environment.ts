/// <reference lib="dom" />
// The page's environment for the connection loop (slice 11 §2, decision "Slice 11, P6"): the clock and timers, and
// the wakes that mean the page may have been away: visible again, back online, restored from the back/forward cache,
// or a network change (Chromium reports it; the old socket then looks fine until it is checked).
// 所属：@earendil-works/chord/web 的浏览器环境适配器；把 DOM 事件包装成 LoopEnvironment。
// 职责：提供 now/after/online/onWake；重新可见、联网、pageshow 持久恢复或网络变化时通知连接循环。
// 边界：不创建连接、不判断服务器健康；online 只是浏览器提示；监听器必须在 stop 时全部移除。
// 上游：startPage 的 environment 选项；下游：keepConnected 的连接循环调用这些函数。
// 导出：pageEnvironment 一个函数；LoopEnvironment 类型来自 surfaces。
// 组合：startPage → pageEnvironment → 连接循环使用 after/onWake；返回的清理函数移除四种监听。
// 示例：const environment = pageEnvironment(); const stop = environment.onWake(() => reconnect());
// 阅读顺序：import → pageEnvironment → now/after/online → onWake → 清理闭包。

import type { LoopEnvironment } from "../surfaces/index.ts";

/** The browser page's loop environment. */
/**
 * 把浏览器的时钟、定时器和恢复事件交给重连循环；无参数，返回 LoopEnvironment，创建时不连接服务器。
 * 例如页面从后台恢复为 visible 时会调用循环注册的 listener；after 返回的函数负责取消那一个定时器。
 */
export function pageEnvironment(): LoopEnvironment {
	// 返回方法集合；箭头函数在调用时才读取当前时间或在线标志。
	return {
		// Date.now 是毫秒时间戳，与重连循环记录的时间相减得到持续时间。
		now: () => Date.now(),
		// ms 和 callback 由重连循环传入；返回清理函数，而不是定时器本身。
		after: (ms, callback) => {
			// setTimeout 安排一次回调；取消后该回调不会由这个定时器触发。
			const timer = setTimeout(callback, ms);
			// 闭包记住 timer，供循环结束尝试或停止时清理。
			return () => clearTimeout(timer);
		},
		// navigator.onLine 只是浏览器的在线判断，不证明服务器能访问。
		online: () => navigator.onLine,
		// listener 是“可能需要重连”的通知；注册完后返回统一移除四种监听的函数。
		onWake: (listener) => {
			// PageTransitionEvent 是 DOM 类型；persisted 表示本次 pageshow 来自往返缓存恢复。
			const restored = (event: PageTransitionEvent): void => {
				// 普通首次打开页面不通过这一路额外唤醒循环。
				if (event.persisted) listener();
			};
			// visibilitychange 在隐藏和显示时都会来，这里只在重新可见时通知。
			const visible = (): void => {
				if (document.visibilityState === "visible") listener();
			};
			// as 只告诉 TypeScript 浏览器可能提供 connection；? 表示这个属性可以不存在。
			const network = (navigator as { readonly connection?: EventTarget }).connection;
			// 四种事件分别覆盖恢复网络、缓存恢复、切回页面与网络设备变化。
			window.addEventListener("online", listener);
			window.addEventListener("pageshow", restored);
			document.addEventListener("visibilitychange", visible);
			// 可选链 ?. 在 connection 不存在时跳过，而不是检测它是否真能联网。
			network?.addEventListener("change", listener);
			// 移除时必须使用注册时同一个函数对象，闭包保留了这些引用。
			return () => {
				window.removeEventListener("online", listener);
				window.removeEventListener("pageshow", restored);
				document.removeEventListener("visibilitychange", visible);
				network?.removeEventListener("change", listener);
			};
		},
	};
}
