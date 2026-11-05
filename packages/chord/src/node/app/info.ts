// The start-data objects (slice 13 §1; decision "The plugin model, points 3, 4, 5 and 8" (8)): base code shrinks to
// the API, the bootstrap and one facet serving process values as core objects plugins `get`. `AppInfo` on the
// server (the data directory, the app's name and its API version), `WorkerInfo` on a worker (its address and the
// app's start data for it).

// 所属：packages/chord/src/node/app，app kit 的启动数据对象（slice 13 §1；decision 点 3/4/5/8）。
// 职责边界：声明 AppInfo/WorkerInfo 两个本地契约，并用 constant 把进程值暴露为 core 对象；不读取磁盘、不启动主机。
// 上游：app.ts 把 appInfoFacet 放进服务器 core；worker.ts 把 workerInfoFacet 放进 worker core；下游：插件用 self.get 读取。
// 结果与错误：facet 创建无 I/O，加载时注册对象；constant 值固定，没有业务错误路径。
// 能力清单：AppInfo 暴露 dataDir/name/version；WorkerInfo 暴露 address/start；appInfoFacet/workerInfoFacet 创建对应 facet。
// 组合顺序：startServer 读取布局和 API 版本 → appInfoFacet；worker 收到 kit/app → workerInfoFacet → plugins.load。
// 示例：const info = await ctx.get(AppInfo, {}); console.log(info.name.value)。
// 建议阅读顺序：先看两个 local 契约，再看两个 facet 函数。
import { local, obj, str, unknown } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import { constant } from "../../state/index.ts";

/** What the server knows of the app: its data directory, its name, its newest API version. */
// AppInfo 是空参数的 local 契约：每个主机至多一个此对象，三个状态成员必须是字符串；声明本身不读取磁盘。
export const AppInfo = local("chord.app.info", {
	version: 1,
	params: {},
	members: { dataDir: str(), name: str(), version: str() },
});

/** What a worker knows of itself: its address (kind, params, key) and the app's start data for it. */
// WorkerInfo 声明 address 与 start 两个状态成员；unknown() 是允许任意 JSON 的 schema，不代表任意 JavaScript 对象。
export const WorkerInfo = local("chord.app.worker-info", {
	version: 1,
	params: {},
	members: {
		address: obj({ kind: str(), key: str(), params: unknown() }),
		start: unknown(),
	},
});

/** The facet serving `AppInfo` with `info`. */
// 把启动脚本给的路径、名称和 API 版本封装为 facet，返回声明函数；调用此函数不启动主机或做 I/O。
// 例如插件通过 self.get(AppInfo,{}) 读取 name；constant 提供固定 watchable 值而不是普通字符串。
// <P extends Principal> 约束主机身份类型，输入对象的 readonly 只影响 TypeScript 赋值。
export function appInfoFacet<P extends Principal>(info: {
	readonly dataDir: string;
	readonly name: string;
	readonly version: string;
}): Facet<P> {
	// 创建 setup 回调，加载该 facet 时才执行 host.serve；箭头表达式的结果是声明调用。
	return defineFacet<P>((host) =>
		// 为 AppInfo 登记工厂；工厂每次创建对象时返回三个固定状态源。
		host.serve(AppInfo, () => ({
			// 路径以状态成员暴露，并不因此授权文件访问或执行目录操作。
			dataDir: constant(info.dataDir),
			// 应用名保持启动参数给定的值。
			name: constant(info.name),
			// 这里的 version 是启动数据中的 API 版本文本，不是 AppInfo 契约自身 version: 1。
			version: constant(info.version),
		})),
	);
}

/** The facet serving `WorkerInfo` with the worker's address and start data. */
// 为 worker 的地址和应用启动数据创建 facet，返回类型匹配 P；无 I/O，随后加载时才注册对象。
// 例如 Project({id:"p"}) 的 worker 可以从 WorkerInfo.address 看到 kind/key/params；start 是应用自定义 JSON。
export function workerInfoFacet<P extends Principal>(info: {
	readonly address: { readonly kind: string; readonly key: string; readonly params: JsonValue };
	readonly start: JsonValue;
}): Facet<P> {
	return defineFacet<P>((host) =>
		// 登记空参数对象，两个 constant 直接持有输入值；并不深拷贝或重新校验类型已保证的 JSON。
		host.serve(WorkerInfo, () => ({ address: constant(info.address), start: constant(info.start) })),
	);
}
