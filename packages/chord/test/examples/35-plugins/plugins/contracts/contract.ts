// The contracts the plugins share: a contracts-only plugin (no facet file). A plugin that imports this file gets its
// own copy built into its script; the app's code declares the same contracts (same names, versions and shapes).

import { hostKind, int, local, method, remote, str } from "@earendil-works/chord";

/** The worker's host kind: `Notes` lives there. */
// 无地址参数的主机种类；Worker() 是地址数据，不会创建主机或子进程。
export const Worker = hostKind("example.worker");

/** Notes on the worker: a label, a count and `add`. */
export const Notes = remote("example.notes", {
	// 契约版本/空身份参数共同描述调用方所持的接口；remote 的对象身份还包含 principal key。
	version: 1,
	params: {},
	// 回调无参数，总把此契约放到 Worker() 地址；这里只计算地址，无网络副作用。
	hostAddress: () => Worker(),
	// main 同时暴露字符串标签、整数计数和无业务参数/返回整数的 add；schema 在运行时检查方法入参。
	variants: { main: { state: { label: str(), count: int() }, methods: { add: method(undefined, int()) } } },
});

/** The notes' label as the server shows it. */
// local 只在本主机使用；空 params 的 local 对象具有主机生命周期，members 是扁平成员表。
export const Index = local("example.index", { version: 1, params: {}, members: { label: str() } });

/** When the clock plugin's script was evaluated: it changes only when the plugin is reloaded. */
// 这里只声明 evaluatedAt 的字符串形状，实际时间值由 clock/server.ts 工厂提供；状态结果不会逐次按 schema 校验。
export const Clock = local("example.clock", { version: 1, params: {}, members: { evaluatedAt: str() } });
