// The current plugin scripts of a client kind (slice 11 §1, decision "Slice 11, P5"): what the server's surface serves
// as a remote object every page and terminal holds. Its state is the set: the base bundle's hash, the combined file of
// every plugin script, and each plugin's script (and stylesheet); a rollout shipping the kind publishes a new set, and
// each client fetches what changed.

//
// 文件导读
// 所属：packages/chord 的 surfaces 层，定义“某一客户端类型的当前脚本集合”契约。
// 职责边界：只描述数据结构与远程对象契约，不下发文件、不实现缓存；服务器 surface 负责把实际 URL/哈希填入状态，
// 客户端通过远程对象读取并在 base 变化时重载。结果流向：server 发布 state → 客户端拿 ScriptSet → 按需 fetch。
// 错误：契约校验失败由 contracts 层抛出；本文件不额外包装。
// 能力清单：
// - Server（私有）：hostKind("server") 的常量，限定远程对象位于服务器的 host 上。
// - ScriptEntry：插件脚本条目的 schema（name/digest/url/可选 css）及其推导类型。
// - ScriptSet：脚本集合 schema（base/combined/plugins）及其推导类型。
// - WebScripts / TuiScripts：web 与终端两种客户端类型的远程对象契约（version 1，state 为 { set }）。
// - scriptsContract（私有）：生成上述远程契约的泛型工厂。
// - ScriptsContract：两种契约的联合类型，供客户端代码泛化处理。
// 组合与顺序：scriptsContract 用 remote 定义对象、用 variants.main.state 声明状态形状；
// WebScripts/TuiScripts 是其实例；服务器发布新 state，客户端比较 base 后重载。
// 示例（值符合 ScriptSet 类型）：`const set = { base: "abc123", combined: "/_chord/web/combined.js",
// plugins: [{ name: "editor", digest: "d1", url: "/_chord/web/plugin/editor.js" }] };`
// 阅读顺序：先看 ScriptEntry/ScriptSet 两个 schema 与推导类型，再看 WebScripts/TuiScripts，最后看 scriptsContract。
import { arr, hostKind, obj, opt, remote, type Static, str } from "../contracts/index.ts";

/** The server's host kind as the surfaces place their objects: the app kit's server is `Server()`. */
// hostKind 是契约 DSL 的构造器，返回一个“host 种类”值；远程对象据此声明自己位于哪类 host。
// 这里只创建一次，scriptsContract 的 hostAddress 回调每次返回它。
const Server = hostKind("server");

/** One plugin's script of the set: its name, its script's digest and URL, its stylesheet's URL when it has one. */
// 运行时 schema：obj 定义对象形状，str() 要求字符串，opt(str()) 表示可选字符串。
// digest 用于判断脚本是否变化；url 是服务器上的地址；css 是可选样式表地址。
const ScriptEntry = obj({ name: str(), digest: str(), url: str(), css: opt(str()) });

/** One plugin's script of a set (see `ScriptEntry`). */
// Static<typeof ...> 是编译期工具类型，把 schema 推导为普通 TS 类型；运行时校验由 schema 自身完成。
export type ScriptEntry = Static<typeof ScriptEntry>;

/**
 * A client kind's current scripts: `base` (the base bundle's hash: a change reloads the client), `combined` (the URL of
 * one file holding every plugin's script, what a fresh client loads), `plugins` (each one's script, in name order).
 */
// 集合 schema：base 是基础 bundle 哈希（变化即重载客户端），combined 是合并所有插件脚本的 URL，
// plugins 是按名称排序的条目数组。arr(ScriptEntry) 表示元素逐个按条目 schema 校验。
export const ScriptSet = obj({ base: str(), combined: str(), plugins: arr(ScriptEntry) });

/** A client kind's current scripts (see `ScriptSet`). */
// 与 schema 同名的类型别名：TypeScript 允许类型和值共享名称（声明空间不同）。
export type ScriptSet = Static<typeof ScriptSet>;

/** The current web scripts (`ScriptSet`), served by the server's web surface to any principal that may load the app. */
// web 客户端类型的远程对象契约实例。
export const WebScripts = scriptsContract("chord.web.scripts");

/** The current terminal scripts (`ScriptSet`), served by the server's terminal surface as `WebScripts` is. */
// 终端（tui）客户端类型的远程对象契约实例。
export const TuiScripts = scriptsContract("chord.tui.scripts");

/** The contract of a client kind's current scripts, named `name`: a remote object on the server, its state the set. */
// 契约工厂：`const N extends string` 让 name 保持字面量类型，便于推导契约名称。
// remote(name, {...}) 定义：版本 1、无参数、地址在 Server host、唯一变体 main 的 state 为 { set: ScriptSet }。
// 返回值的类型包含 name 的字面量，因此两个实例的联合可以区分。
function scriptsContract<const N extends string>(name: N) {
	return remote(name, {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		variants: { main: { state: { set: ScriptSet } } },
	});
}

/** The contract of a client kind's scripts, as clients hold it (`WebScripts`, `TuiScripts`). */
// typeof 取的是值（契约对象）的类型；联合表示“两种之一”，客户端可据此编写通用逻辑。
export type ScriptsContract = typeof WebScripts | typeof TuiScripts;
