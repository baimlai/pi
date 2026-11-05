// Destination (§3, section 1's table; dependency model §1): where a reference made on a host, or a hold arriving on one
// of its links, goes, by address alone: here when the address is this host's (served here or not), else over the
// route of its host address's kind, or over the parent link; and the check that an object served here lives here.
// 文件导读
// 所属：packages/chord/src/host（主机层），实现引用与 hold 的地址判定和首跳选择。
// 职责：按契约 hostAddress 或请求地址判断“here / 哪个 route / 父链路”，并做服务方的 misplaced 检查。
// 边界：不建立引用、不发送消息、不检查对象是否存在；“here”只表示地址属于本机。
// 上游：Host 的 reference/hold 路径调用 reference、placedHere、hold、misplaced。
// 下游：Route.path（校验参数并授权）或 parent Path；失败抛 invalid/host_address、forbidden、unavailable。
// 能力清单：
// - Placed：here 或 path(+address) 的可辨识联合。
// - Destination：保存 address/routes/parent，提供 reference、placedHere、hold、misplaced。
// 组合与顺序：reference -> hostAddressOf -> #isHere -> #pathTo ?? parent；hold -> 请求地址 -> route -> parent。
// 示例：const placed = destination.reference(Counter, { id: "a" }, principal, ctx);
//        if (placed.kind === "path") send(placed.path, placed.address);
// 建议阅读顺序：Placed -> Destination 字段 -> reference -> hold -> misplaced -> hostAddressOf/sameAddress。

import type { Context } from "../context/index.ts";
import type { Address, Contract, ParamsOf } from "../contracts/index.ts";
import { contractData } from "../contracts/internal.ts";
import { ChordError, type Principal } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import type { WireAddress } from "../link/internal.ts";
import type { HoldRequest, HostLink, Path } from "../remote/internal.ts";
import type { Route } from "./route.ts";

/** Where something is placed: here, or over a path (with the host address it was computed or named with). */
// 可辨识联合：kind 为 "here" 时没有额外字段；为 "path" 时带 path（首跳链路与剩余路径）和原始地址。
// 地址随结果一起返回，便于调用方在失败时报告“本来要去哪个地址”，而不是重新计算。
export type Placed =
	| { readonly kind: "here" }
	| { readonly kind: "path"; readonly path: Path; readonly address: WireAddress };

/** A host's destinations: its address, its routes and its parent path, as the host keeps them. */
// 一个主机的寻址器。构造参数：本机地址（客户端可能没有）、按地址种类索引的路由表、父链路路径。
// 三者都由主机持有，这里只读引用；构造不复制 Map，后续主机更新路由表需要重建本对象。
export class Destination {
	// 本机地址；undefined 表示这是没有地址的客户端，因此任何远程地址都不可能“here”。
	readonly #address: Address | undefined;
	// 地址种类（如 "host"、"worker"）到 Route 的映射；没有对应路由时走父链路。
	readonly #routes: ReadonlyMap<string, Route>;
	// 父链路路径；linked 为 false 表示当前没有可用父链接。
	readonly #parent: Path;

	// 保存主机提供的三个只读依赖；不做校验，不需要异步资源。
	// 例：new Destination(host.address, host.routes, host.parent)。
	constructor(address: Address | undefined, routes: ReadonlyMap<string, Route>, parent: Path) {
		this.#address = address;
		this.#routes = routes;
		this.#parent = parent;
	}

	/**
	 * Where a reference to `Type` with `params` made as `principal` goes: here for a local type, and for a remote type
	 * whose host address is this host's, served here or not (the check against what is served is the host's); otherwise
	 * over the route of its host address's kind, or over the parent link (the host address decides where an object
	 * lives: a worker reaches another worker's object of a type it serves too). Throws `invalid/host_address` for a host
	 * address whose params do not fit its kind, `forbidden` when the route refuses, and what a `hostAddress` or
	 * `authorize` throws.
	 */
	// 计算一次引用应放在哪里。输入：契约、可由契约推导出的参数、调用方身份、上下文；输出 Placed。
	// 主要流程：本地类型直接 here；远程类型先算宿主地址；地址属于本机则 here；否则查路由，没路由就退回父链路。
	// 副作用来自插件提供的 hostAddress 和路由的 authorize；错误直接向上抛，不在这里转换。
	// 例：Worker 里 get(User, { id: "u1" })：若 hostAddress 返回另一 worker 的地址，则返回该 worker 路由的 path。
	reference(Type: Contract, params: ParamsOf<Contract>, principal: Principal | undefined, context: Context): Placed {
		// 本地对象的“宿主”就是当前主机，参数与身份不影响位置。
		if (Type.kind === "local") return HERE;
		// 远程类型的 hostAddress 决定对象应住在哪台主机；插件返回的形状在后续路由/服务处校验。
		const address = hostAddressOf(Type, params);
		// 地址与本机一致：即使本机没有 serve 这个类型也先判 here，交给绑定阶段报 unbound/not_served。
		if (this.#isHere(address)) return HERE;
		// 优先按地址种类路由；没有该种类路由时走父链路（父链路是否可用由后续发送处判断）。
		return { kind: "path", path: this.#pathTo(address, principal, context) ?? this.#parent, address };
	}

	/**
	 * Whether a reference to `Type` with `params` goes here: a local type, or a remote one whose host address is this
	 * host's. A `hostAddress` that throws, throws.
	 */
	// 只判断“是否本机”，不查路由也不检查是否真的 serve；本地类型恒为 true。
	// 例：判断请求方计算的地址是否就是自己，避免把请求再转发出去。
	placedHere(Type: Contract, params: ParamsOf<Contract>): boolean {
		// || 短路：本地类型无需调用 hostAddress；远程类型用同一地址比较逻辑。
		return Type.kind === "local" || this.#isHere(hostAddressOf(Type, params));
	}

	/**
	 * Where a hold arriving on `link` acting as `principal` goes, by the address it names: here when it is this host's
	 * (a relay never captures a hold for serving the same name); over the route of its kind; else over the parent link
	 * (waiting for it while it is down), unless it came on the parent link or this host never had one (`unavailable`).
	 * Throws as `reference` does.
	 */
	// 计算链路到达的 hold 请求往哪里走。输入：请求（含地址与类型名）、来源链路、身份、上下文；输出 Placed。
	// 与 reference 的差别：请求已经带着地址，不再调用 hostAddress；且要防止从父链路来的请求再绕回父链路。
	// 错误：地址不是本机、无对应路由、来源是父链路或父链路不存在时抛 unavailable。
	// 例：子主机发来的 hold 目标在祖父主机：子主机没有该种类路由时，会经自己的父链路继续向上。
	hold(request: HoldRequest, link: HostLink, principal: Principal | undefined, context: Context): Placed {
		const { address } = request;
		// 地址属于本机：由本机服务方处理；中继不会把同名地址的 hold 截留下来。
		if (this.#isHere(address)) return HERE;
		// 地址种类有专用路由时按路由走。
		const routed = this.#pathTo(address, principal, context);
		if (routed !== undefined) return { kind: "path", path: routed, address };
		// 没有专用路由时只能走父链路；若请求就是父链路发下来的，或本机从未有父链路，就无法继续转发。
		if (link.role === "parent" || !this.#parent.linked) {
			throw new ChordError({ code: "unavailable", message: `${request.type} is not served here` });
		}
		return { kind: "path", path: this.#parent, address };
	}

	/**
	 * The provider's own check of a request placed here for the remote `Type` it serves, with `params` (checked):
	 * `invalid/host_address` when its `hostAddress` puts the object on another host (code skew: the consumer computed
	 * this host), `undefined` when it lives here. A `hostAddress` that throws throws (the provider's own code). The
	 * address a request names only routes it.
	 */
	// 服务方检查：一个已经送到本机的请求，按服务方自己的 hostAddress 是否仍应住在本机。
	// 返回 undefined 表示一致；返回 invalid/host_address 表示两端对地址的算法不一致（版本偏移）。
	// 例：消费者旧版本把对象算到 host A，请求到达 host B；B 重算后发现自己不是 A，就拒绝而不是错误地服务。
	misplaced(Type: Contract, params: ParamsOf<Contract>): ChordError | undefined {
		const address = hostAddressOf(Type, params);
		if (this.#isHere(address)) return undefined;
		// A host serving a remote type has an address (`serve` refuses one without).
		// 能服务远程类型的主机必有地址，因此非空断言 #address! 成立；地址只用于错误消息。
		return invalid("host_address", `${Type.name}: placed on ${address.kind}, this host is ${this.#address!.key}`);
	}

	/**
	 * The path to `address` when this host routes its kind (its params checked, `authorize` run for `principal`);
	 * `undefined` without a route for its kind.
	 */
	// 按地址种类查路由；?. 让没有该种类时返回 undefined。
	// 路由的 path() 内部会校验参数并执行授权，因此“查表”也可能抛 forbidden 等错误。
	#pathTo(address: WireAddress, principal: Principal | undefined, context: Context): Path | undefined {
		return this.#routes.get(address.kind)?.path(address.params, principal, context);
	}

	/** Whether an object whose host address is `address` lives here: this host has that address. */
	// 没有本机地址（客户端）时恒为 false；否则做种类和参数的浅比较。
	#isHere(address: WireAddress): boolean {
		const own = this.#address;
		return own !== undefined && sameAddress(own, address);
	}
}

// 共享的“就在本机”结果；Placed 是只读值，可以安全复用同一个对象。
const HERE: Placed = { kind: "here" };

/** The address a remote `Type`'s `hostAddress` computes for `params`. */
// 调用契约自带的 hostAddress，并把结果收敛成 WireAddress 形状。
// 这是插件代码：运行时只取 kind/params，形状和语义在路由或服务时再校验，因此这里用 as 断言。
function hostAddressOf(Type: Contract, params: ParamsOf<Contract>): WireAddress {
	// Every remote contract has one (declaration policy, `remote`).
	// 声明策略保证远程契约一定有 hostAddress；! 是非空断言，仅表达这个开发期不变量。
	const hostAddress = contractData(Type).hostAddress!;
	// Plugin code: what it returns is checked where it is routed or served.
	const { kind, params: values } = hostAddress(params) as { readonly kind: string; readonly params: unknown };
	// 重新组装只含两个字段的普通对象，丢弃插件可能多返回的字段。
	return { kind, params: values };
}

/** Whether `address` names the host at `own`: the same kind and the same value for each of its params. */
// 地址相等判断。输入 params 来自网络/插件，是运行时数据，因此这里做 typeof/null 检查（信任边界）。
// 比较规则：种类相同、键数量相同、每个键严格相等；地址参数按契约是标量，所以浅比较足够。
function sameAddress(own: Address, address: WireAddress): boolean {
	// 种类不同直接 false；params 必须是对象且非 null，null 的 typeof 也是 "object"，所以两者都要查。
	if (own.kind !== address.kind || typeof address.params !== "object" || address.params === null) return false;
	// 用索引签名把未知对象当作字符串键读取值；这是比较前的类型收窄，不改变运行时对象。
	const values = address.params as { readonly [field: string]: unknown };
	const fields = Object.keys(own.params);
	return Object.keys(values).length === fields.length && fields.every((field) => values[field] === own.params[field]);
}
