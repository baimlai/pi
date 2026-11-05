// `TuiScope` (slice 11 §4, decision "Slice 11, P9"; p2's `TuiScope`): a terminal component's Chord resources, the
// counterpart of the React bindings for terminal UI libraries. It holds references, follows watchables and registries,
// calls one `changed` callback (the app's redraw) on every change, and releases everything at `dispose`. References
// wait and rebind by themselves (no retry loop, unlike p2's); no terminal library dependency.
// 中文说明：本文件是终端组件资源作用域。上游：应用在创建组件时 new TuiScope(host, redraw)；
// 下游：hold 引用对象、watch 数据和注册表，任何变化都调用同一个 changed（通常是终端重绘）。
// dispose 统一释放；dispose 后不会再调用 changed，迟到的异步 watch 也会被中止。
// 所属：tui 沙箱侧组件资源管理；React hooks 在终端 UI 中的对应物，不依赖终端库。
// 边界：只登记/释放 host 资源与 watch，不绘制；读取错误在 reader 中吞成 undefined，dispose 后不再回调。
// 上游：应用组件创建 TuiScope；下游：Host.hold、Host.registry、Watchable.watch、withAbortSignal。
// 导出清单：TuiScope 一个类；hold 持有引用，watch 跟随值，registry 读取注册表，dispose 统一释放。
// 组合：new TuiScope(host, redraw) → hold/watch/registry → dispose；每次变化只调用同一个 changed。
// 示例：const scope = new TuiScope(host, () => draw()); const notes = scope.hold(Notes, { id });
// 阅读顺序：字段/构造 → hold → watch → registry → dispose → #context。

import { BACKGROUND_CONTEXT, withAbortSignal } from "../context/index.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import type { Held, Host } from "../host/index.ts";
import type { Registry } from "../registries/index.ts";
import type { NativeWatchable, Watchable } from "../watch.ts";

/** A component's scope: what it holds and follows, until `dispose`. */
// 组件级作用域：保存 host、重绘回调和 abort 控制器；P 默认 Principal，应用可传更具体身份类型。
export class TuiScope<P extends Principal = Principal> {
	// #host：创建引用和读取注册表的客户端 host；#changed：任意值变化时的重绘回调。
	// #abort：dispose 时中止所有 watch/hold 的上下文；#releases：已持有引用的释放函数，按登记顺序执行。
	readonly #host: Host<P>;
	readonly #changed: () => void;
	readonly #abort = new AbortController();
	readonly #releases: (() => void)[] = [];

	// 只保存引用，不启动任何 watch；首次读值要等 hold/watch/registry 被调用。
	constructor(host: Host<P>, changed: () => void) {
		this.#host = host;
		this.#changed = changed;
	}

	/** A reference to `Type` with `params`, held until `dispose`; its state changes call `changed`. */
	// 持有一个引用对象直到 dispose：host.hold 立即登记，state 的变化触发 changed，返回可读/调用的 Held<C>。
	// 泛型 C 由 Type 推断，ParamsOf<C> 从合约推导参数类型；params 在编译期检查，运行时不重复校验。
	// 例如 scope.hold(Notes, { id }) 返回对象句柄；dispose 时自动 release，无需组件手动配对。
	hold<C extends Contract>(Type: C, params: ParamsOf<C>): Held<C> {
		// 上下文带本 scope 的 abort signal；release 也登记到 #releases，dispose 时统一执行。
		const held = this.#host.hold(Type, params, this.#context());
		this.#releases.push(() => held.release());
		// 引用状态（绑定、重绑、结束）变化时重绘；返回的读取函数这里不用，因为对象由 held 本身提供。
		this.watch(held.state);
		return held;
	}

	/**
	 * Follows `source` (a member, a derive, `ref.state`) until `dispose`: its changes call `changed`. Returns a reader of
	 * its current value (`undefined` while it has none: nothing throws in a redraw).
	 */
	// 跟随任意可观察源直到 dispose；返回读取当前值的函数，无值/已结束/成员缺失时返回 undefined 而不抛错。
	// 例如 const name = scope.watch(ref.state.member("name")); 之后每次变化 scope 的 changed 会被调用一次。
	// watch 异步取得；取得后会补调一次 changed，弥补首次绘制到 watch 建立之间的空档。
	watch<T>(source: Watchable<T> | NativeWatchable<T>): () => T | undefined {
		// then 的成功/失败回调都不直接更新 UI；失败（已被 dispose 或源结束）静默忽略。
		source.watch(this.#context()).then(
			(watch) => {
				// Watchable 与 NativeWatchable 的 start 回调参数类型不同；本作用域不读参数，断言统一成无参异步 listener。
				(watch.start as (listener: () => Promise<void>) => void)(async () => {
					// 每次通知前检查 abort，避免 dispose 后仍重绘；listener 返回 Promise，但这里忽略等待。
					if (!this.#abort.signal.aborted) this.#changed();
				});
				// The value it acquired may be newer than what was drawn (a reference bound since): draw it.
				if (!this.#abort.signal.aborted) this.#changed();
			},
			// Disposed (or the source ended) before the watch started: nothing to follow.
			() => {},
		);
		// 读取函数是同步闭包：调用时读 source.value；读取失败只在这次读取中吞掉，不影响 watch。
		return () => {
			try {
				return source.value;
			} catch {
				return undefined;
			}
		};
	}

	/** Registry `R`'s composed value, followed until `dispose`; a reader, `undefined` until it is usable. */
	// 读取注册表 R 的组合值并跟随变化；返回读取函数，注册表尚未可用时为 undefined。
	// C 是贡献值类型，V 是组合结果类型（如 readonly Theme[]），由 Registry 的类型参数决定。
	// 例如 const themes = scope.registry(Themes); 之后 themes() 得到当前主题数组。
	registry<C, V>(R: Registry<C, V>): () => V | undefined {
		// 先给一个安全的占位读取函数；异步取得组合值后替换成 watch 的读取函数。
		let read: () => V | undefined = () => undefined;
		// 组合值本身也是可观察的；取得后用 watch 跟随，并立即补一次 changed 让界面显示新值。
		this.#host.registry(R, this.#context()).then(
			(value) => {
				read = this.watch(value);
				if (!this.#abort.signal.aborted) this.#changed();
			},
			() => {},
		);
		return () => read();
	}

	/** Releases every reference and ends every watch; `changed` is not called after it. */
	// 先中止上下文（阻止迟到的 watch 回调），再逐个 release 引用；splice(0) 取走并清空数组，重复 dispose 无害。
	dispose(): void {
		this.#abort.abort();
		for (const release of this.#releases.splice(0)) release();
	}

	/** The context of the scope's work: aborted at `dispose`. */
	// 每次操作生成带同一 abort signal 的后台上下文；没有 telemetry/取消之外的额外值。
	#context() {
		return withAbortSignal(this.#abort.signal, BACKGROUND_CONTEXT);
	}
}
