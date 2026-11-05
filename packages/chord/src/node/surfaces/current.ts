// The scripts objects a surface serves (slice 11 §1, decision "Slice 11, P5"): on the server, one local object per
// surface holds the published set (a writable, set by each publish), and the surface's scripts object (`WebScripts`,
// `TuiScripts`), made per principal, shows it. A rollout publishes without waiting for clients: each client's hold gets
// one frame, and a reconnect's snapshot brings the set it missed.
// 所属：node/surfaces 的脚本对象发布层，连接 PublishedScripts 数据与 Chord 合约/注册表。
// 职责：为 web/tui 各建一个本地 current 对象（可写 set + publish）和一个按 principal 的远程 scripts 对象。
// 边界：不构建脚本、不服务 HTTP；发布只更新内存状态，不等待客户端；错误来自 host.get/publish。
// 上游：tuiSurface/webSurface 的 facet setup；下游：host.serve/defineFacet、ScriptSet schema、WebScripts/TuiScripts。
// 导出清单：SurfaceName；scriptsFacet 创建声明；publishTo 写入集合；CURRENT/SCRIPTS 是内部映射。
// 组合：scriptsFacet 注册 current 与远程对象 → rollout 调 publishTo → set 变化 → 客户端远程状态收到新 set。
// 示例：await publishTo(host, "web", set, context);
// 阅读顺序：SurfaceName → CURRENT/SCRIPTS → currentContract → scriptsFacet → publishTo。

import type { Context } from "../../context/index.ts";
import { local, method } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet, type Host } from "../../host/index.ts";
import { ScriptSet, type ScriptsContract, TuiScripts, WebScripts } from "../../surfaces/index.ts";

/** A surface: the web (pages) or the terminal. */
// 只有两个表面；字符串字面量联合用于索引下面两个映射，编译期防止传入其他名字。
export type SurfaceName = "web" | "tui";

/** The local object holding a surface's published set, by surface. */
// 每个表面一个本地契约令牌；名称不同（chord.web.current/chord.tui.current），同一 host 中不会混淆。
const CURRENT = {
	web: currentContract("chord.web.current"),
	tui: currentContract("chord.tui.current"),
};

/** The scripts object each surface serves. */
// 每个表面公开的远程脚本对象契约；Record<SurfaceName,...> 要求两个键都存在，值来自 surfaces 包。
const SCRIPTS: Readonly<Record<SurfaceName, ScriptsContract>> = { web: WebScripts, tui: TuiScripts };

/** The contract of a surface's published set: its `set` and `publish`. */
// 声明服务器本地的当前脚本集合契约；name 保留为字符串字面量类型，返回 local 契约令牌。
// const N extends string 是保留字面量的泛型约束；不代表运行时锁住字符串。
// 例如传 chord.web.current 得到 set 状态及 publish(ScriptSet) 方法，声明本身不发布任何客户端文件。
function currentContract<const N extends string>(name: N) {
	// 空 params 的 local 对象随 host 生存；ScriptSet 是运行时 schema，也提供静态推导类型。
	return local(name, { version: 1, params: {}, members: { set: ScriptSet, publish: method(ScriptSet) } });
}

/**
 * The surface's facet serving its published set (starting at `published.set`, the set taken before the load) and its
 * scripts object for every principal that may hold it.
 */
// 为某个界面生成 facet（声明包）：输入界面名及可读 published.set，返回加载时注册对象的 Facet<P>。
// 本函数只创建声明，host 加载它之后才激活本地对象；例如 web 会注册本地 current 和远程 WebScripts。
// P extends Principal 约束应用身份类型；远程对象按身份创建，但这里所有身份看到同一集合。
export function scriptsFacet<P extends Principal>(
	surface: SurfaceName,
	published: { readonly set: ScriptSet },
): Facet<P> {
	// 通过联合类型索引选择 local 契约，避免把 web 和 tui 的集合混在一起。
	const Current = CURRENT[surface];
	// 回调在 facet.setup 时执行；host.serve 声明工厂，不在这里进行文件 I/O。
	return defineFacet<P>((host) => {
		// _params 表示这里不用空参数；self 提供由 Chord 管理生命周期的状态与依赖。
		host.serve(Current, (_params, self) => {
			// The latest set: an attempt after a failure starts at what was published last.
			const set = self.writable<ScriptSet>(published.set);
			// writable 是宿主内的 native watchable；derive 把它转换成可作为契约状态的 JSON watchable。
			return {
				set: self.derive([set], ([value]) => value),
				// publish 接到已按契约校验的参数后替换整个集合；返回 null 是无结果方法的内部形式。
				publish: async (next) => {
					set.set(next);
					return null;
				},
			};
		});
		// 远程包装对象依赖本地 Current，主变体 main 只公开派生后的 set，调用方不能直接 publish。
		host.serve(SCRIPTS[surface], (_params, _principal, self) => {
			// self.get 是工厂声明的依赖，不是 await；激活时 Chord 等待其可用。
			const current = self.get(Current, {});
			// ([value]) 是对来源值数组的解构；该恒等映射把最新集合原样共享给远程状态。
			return { variant: "main", members: { set: self.derive([current.set], ([value]) => value) } };
		});
	});
}

/** Publishes `set` as `surface`'s current set on `host` (loaded with `scriptsFacet`). */
// 将 set 写入 host 上已加载的界面 current 对象；返回的 Promise<void> 只表示方法完成。
// 先取得引用、调用 publish，最后必定释放；获取或调用失败向外拒绝。例如 rollout 调它发布 web 新集合。
// 这里没有等待网页或终端安装完成，发布后它们通过各自的远程状态订阅得知变化。
export async function publishTo<P extends Principal>(
	host: Host<P>,
	surface: SurfaceName,
	set: ScriptSet,
	context: Context,
): Promise<void> {
	// await 等待本地对象可用；引用受 context 取消和 host 的就绪规则约束。
	const current = await host.get(CURRENT[surface], {}, context);
	try {
		// 契约方法调用也接收 context；完成后集合的订阅者由 Chord 状态发布机制通知。
		await current.publish(set, context);
	} finally {
		// finally 在成功和抛错时都会执行，避免外部引用长期持有。
		current.release();
	}
}
