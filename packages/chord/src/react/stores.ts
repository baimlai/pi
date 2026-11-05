// External stores over Chord's watchables (slice 11 §3): what React's `useSyncExternalStore` reads. A store's snapshot
// is the watchable's current value (`undefined` while it has none: a reference not bound yet, ended, or a member its
// variant lacks; nothing throws during a render); subscribing starts a watch whose every call notifies React, and the
// unsubscribe ends it.
// 所属：React 外部 store 适配器，把 Watchable/NativeWatchable 接到 useSyncExternalStore。
// 职责：subscribe 创建带 AbortSignal 的 watch 并在每次通知时 changed；snapshot 同步读值，异常转 undefined。
// 边界：不缓存值、不重试、不抛渲染错误；source 可为 undefined（ref 未绑定、已结束或成员缺失）。
// 上游：useWatch/useRegistry；下游：watch.ts、context 的 withAbortSignal。
// 导出：ExternalStore 类型；watchStore 函数。
// 组合：watchStore(source) → useSyncExternalStore(subscribe, snapshot, snapshot)。
// 示例：const store = watchStore(ref?.notes); const notes = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
// 阅读顺序：ExternalStore → watchStore 的 subscribe → snapshot。

import { BACKGROUND_CONTEXT, withAbortSignal } from "../context/index.ts";
import type { NativeWatchable, Watchable } from "../watch.ts";

/** What `useSyncExternalStore` takes: subscribe (returning its unsubscribe) and the current snapshot. */
// 泛型 T 保留值类型；函数类型 () => () => void 表示“订阅后返回取消函数”，不是立即调用两个函数。
export type ExternalStore<T> = {
	// subscribe：React 渲染订阅时调用；返回取消函数，React 卸载时调用它以结束本次 watch。
	readonly subscribe: (changed: () => void) => () => void;
	// snapshot：每次渲染同步读取当前值；必须无副作用，且没有值时返回 undefined 而不是抛错。
	readonly snapshot: () => T | undefined;
};

/** The store of `source` (a state member, a derive, a registry value, `ref.state`); none for `undefined`. */
/** 将 Chord source 包装成 React 外部 store，返回 subscribe/snapshot，不在创建时打开 watch。
 * subscribe 会异步取得 watch 并在值/失败通知时调用 changed，取消函数中止它；snapshot 捕获读取错误。
 * 例如 source 暂未绑定时 snapshot() 返回 undefined，绑定取得 watch 后也会主动 changed 一次，补上竞态间隙。
 */
export function watchStore<T>(source: Watchable<T> | NativeWatchable<T> | undefined): ExternalStore<T> {
	// 两个闭包都保留同一 source；这里不缓存或复制它的值。
	return {
		subscribe: (changed) => {
			// React 即使没有源也可以取得一个可调用的空取消函数。
			if (source === undefined) return () => {};
			// 每次订阅有自己的控制器；取消不会取消其他组件对相同源的订阅。
			const abort = new AbortController();
			const context = withAbortSignal(abort.signal, BACKGROUND_CONTEXT);
			// A watch that cannot start (its source ended, the abort came first) only means no more changes.
			source.watch(context).then(
				(watch) => {
					// 两种 watch 的回调参数不同；这里不读参数，断言统一为无参异步 listener。
					(watch.start as (listener: () => Promise<void>) => void)(async () => {
						// value 和 failed 都触发重新读 snapshot；listener 不直接给 React 塞值。
						changed();
					});
					// A watch starts at the value it acquired, which may be newer than the snapshot React read (a
					// reference's members bind after the first render): its calls bring only later changes.
					changed();
				},
				// 打开 watch 失败时没有后续通知；源的读取错误另由 snapshot 处理。
				() => {},
			);
			// abort 结束观察；已开始的 listener 不会被 stop 强行等待。
			return () => abort.abort();
		},
		snapshot: () => {
			// 源尚未提供时渲染 undefined，调用方可显示占位内容。
			if (source === undefined) return undefined;
			// 读取可能因尚未绑定、已结束或成员缺失抛错；render 路径统一转为 undefined。
			try {
				return source.value;
			} catch {
				// 不区分具体读取错误；此适配器只返回当前可读快照。
				return undefined;
			}
		},
	};
}
