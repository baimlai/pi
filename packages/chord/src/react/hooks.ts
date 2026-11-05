// React bindings (slice 11 §3, decision "Slice 11, P7"; p2's `useObject`, `useReadable`, `useRegistry`): a host in
// context, references held for a component's life, and watchables read with `useSyncExternalStore`. A component
// unmounted by a reload has not left (design §21): its releases are plain releases, presence is the app's. No
// components, no styling.
// 所属：@earendil-works/chord/react 的 React 绑定；可选包，非 React 应用不会加载。
// 职责：HostProvider/useHost；useHold 管理引用生命周期；useWatch/useRegistry 用外部 store 订阅；useRefState。
// 边界：不创建 host、不渲染组件、不保存 principal；Provider 缺失/序列化错误会抛，异步读取失败显示 undefined。
// 上游：应用组件；下游：react、Host.hold/registry、watchStore、canonicalJson。
// 导出：HostProvider、useHost、useHold、useWatch、useRegistry、useRefState；HostContext 是内部常量。
// 组合：HostProvider → useHost → useHold/useRegistry → useWatch → useRefState。
// 示例：const ref = useHold(Notes, { id }); const notes = useWatch(ref?.notes);
// 阅读顺序：HostContext → HostProvider/useHost → useHold → useWatch → useRegistry → useRefState。

import {
	createContext,
	createElement,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../context/index.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import { canonicalJson } from "../data/principal.ts";
import type { Held, Host, RefState } from "../host/index.ts";
import type { Registry } from "../registries/index.ts";
import type { NativeWatchable, Watchable } from "../watch.ts";
import { watchStore } from "./stores.ts";

/** The host components use, given by `HostProvider`. */
// createContext 的初值是 undefined，以便 useHost 在 Provider 缺失时明确报错；泛型只提供静态类型。
const HostContext = createContext<Host<Principal> | undefined>(undefined);

/** Gives `host` to the components below. */
/** 将 props.host 放入 React 上下文，返回包住 children 的 Provider 元素；不创建或关闭 host。
 * P 是应用的身份类型；例如 <HostProvider host={client.host}><App /></HostProvider> 让 App 的 hooks 读到它。
 */
export function HostProvider<P extends Principal>(props: { readonly host: Host<P>; readonly children?: ReactNode }) {
	// Components hold for the app's principal type: the context keeps it as the host was given.
	// 两次 as 是跨过不变泛型的静态断言，运行时仍是原 host 对象；createElement 等价于这里的 JSX Provider。
	return createElement(HostContext.Provider, { value: props.host as unknown as Host<Principal> }, props.children);
}

/** The host `HostProvider` gives; throws outside one. */
/** 读取最近 Provider 的 host；不带参数，默认按 Principal 返回，也可由调用方选择 P。
 * 例如组件调用 useHost<MyPrincipal>()；没有上层 Provider 会同步抛错，P 不会在运行时校验身份。
 */
export function useHost<P extends Principal = Principal>(): Host<P> {
	// useContext 同时建立 React 的上下文订阅，Provider 值改变会让组件重渲染。
	const host = useContext(HostContext);
	// 这是 Provider 是否存在的运行时检查，与 P 的类型断言无关。
	if (host === undefined) throw new Error("useHost: no HostProvider above this component");
	// 应用保证同一组件树使用对应身份类型，断言不转换对象。
	return host as unknown as Host<P>;
}

/**
 * A reference to `Type` with `params`, held while the component is mounted and released when it unmounts or its params
 * change (compared by value); `undefined` before its first hold (the first render).
 */
/** 在 effect 中持有 Type/params 的引用，卸载或 host/Type/参数值变化时释放；首轮 render 返回 undefined。
 * 例如每次 render 都传 { id: "a" }，canonicalJson 得到相同 key，effect 不会仅因对象新建而重新 hold。
 * 创建引用不等它 live，调用方可另用 useRefState 显示加载；无 Provider 或参数序列化错误会在 render 抛出。
 */
export function useHold<C extends Contract>(Type: C, params: ParamsOf<C>): Held<C> | undefined {
	// C 连接合同与 ParamsOf<C>/Held<C> 的类型，使参数和成员在开发时对应。
	const host = useHost();
	// canonicalJson 按值生成稳定键；as never 只适配内部 JSON 参数类型，不克隆/校验 params。
	const key = canonicalJson(params as never, BACKGROUND_CONTEXT);
	// 将引用与取得它时的 key 放在一起，避免参数变化后的那次 render 返回旧实例。
	const [held, setHeld] = useState<{ readonly key: string; readonly ref: Held<C> } | undefined>(undefined);
	// effect 创建引用并触发下一次 render；清理函数按 React effect 生命周期释放它。
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `params` by value: an inline object must not re-hold.
	useEffect(() => {
		// hold 立即返回引用，后续状态自行跟随 provider；这里不调用 get 等待激活。
		const ref = host.hold(Type, params, BACKGROUND_CONTEXT);
		// 保存同一 key/ref，React 用更新后的状态再次渲染组件。
		setHeld({ key, ref });
		// 卸载或依赖变化先释放旧引用；释放也结束它拥有的 watches。
		return () => ref.release();
	}, [host, Type, key]);
	// && 短路先排除 undefined；只返回参数值仍匹配的引用。
	return held !== undefined && held.key === key ? held.ref : undefined;
}

/** The current value of `watchable` (a state member, a derive), re-rendering on change; `undefined` while it has none. */
/** 将可观察源变成 React 当前值；源不存在或暂不能读取时返回 undefined，变化会通知 React 重渲染。
 * 例如 useWatch(ref?.notes) 初始无 ref 时可安全调用；useMemo 只在源身份变化时新建适配器。
 */
export function useWatch<T>(watchable: Watchable<T> | NativeWatchable<T> | undefined): T | undefined {
	// watchStore 不在这里立刻订阅；React 随后通过 subscribe 管理订阅与清理。
	const store = useMemo(() => watchStore(watchable), [watchable]);
	// 第三个 snapshot 供服务端渲染读取；三个函数都来自同一个 store。
	return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

/** Registry `R`'s composed value on the component's host, re-rendering on change; `undefined` until it is usable. */
/** 等待注册表 R 可用后订阅其组合值；卸载或换 host/R 会取消本次等待和后续 watch。
 * 例如 useRegistry(Themes) 给出当前主题列表；取得注册表的失败被忽略，未取得前 useWatch 读取 undefined。
 */
export function useRegistry<C, V>(R: Registry<C, V>): V | undefined {
	// C 是贡献项类型、V 是组合结果类型，二者由 Registry 连接而非运行时强制检查。
	const host = useHost();
	// 保存可观察注册表，不是直接保存一次性的组合值。
	const [value, setValue] = useState<NativeWatchable<V> | undefined>(undefined);
	// effect 按 host/R 的引用身份重新执行；state 不在 effect 开始时主动清空。
	useEffect(() => {
		// 本 effect 的控制器仅取消它自己的 registry 等待。
		const abort = new AbortController();
		// then 成功时把源放入 state；失败回调为空，因此本 hook 不向 render 抛异步取得错误。
		host.registry(R, withAbortSignal(abort.signal, BACKGROUND_CONTEXT)).then(setValue, () => {});
		// 结束 effect 时取消等待；useWatch 对已取得源另有订阅清理。
		return () => abort.abort();
	}, [host, R]);
	// 复用同一观察逻辑，注册表之后的值变化也能重渲染。
	return useWatch(value);
}

/** The state of `ref` (loading, live, failed, ended), re-rendering on change; `undefined` without a reference. */
/** 订阅引用的可达状态；例如 ref 从 loading 变 live 会重渲染。可选链让无引用时仍能遵守每次 render 调用 hook 的规则。
 * 返回 RefState 或 undefined，不释放引用；引用生命周期由 useHold 或调用方管理。
 */
export function useRefState(ref: { readonly state: NativeWatchable<RefState> } | undefined): RefState | undefined {
	// 将 ref.state 交给 useWatch，失败是 RefState 数据的一种，源读取失败才会变 undefined。
	return useWatch(ref?.state);
}
