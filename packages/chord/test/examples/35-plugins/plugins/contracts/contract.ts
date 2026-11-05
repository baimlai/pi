// 文件导读
// 所属：packages/chord/test/examples/35-plugins/plugins/contracts/contract.ts，示例 35 的“仅契约”插件（slice 7c）。
// 插件清单：同目录 package.json 只声明 name "@example/contracts"、private 与 type:module；本目录没有任何 server/
// worker facet 文件，因此发现阶段会把它列为插件，却永远不会被装载，只作为相对导入的源码供其他插件打包。
// 演示内容：一份契约声明同时供插件构建脚本与应用代码使用；插件里的 "@earendil-works/chord" 由外层 map 提供，
// 所以这里创建的类型与 app 的 main.ts 中使用的是同一套运行时对象。名字/版本/形状必须一致，否则绑定失败。
// 上游入口：notes/server.ts、notes/worker.ts、clock/server.ts 相对导入本文件；main.ts 也导入它声明引用。
// 下游调用：hostKind 生成 Worker 地址工厂；remote/local 声明契约；int/str/method 描述 schema。
// 失败行为：本文件没有运行时分支；非法名字/版本在模块求值（define 时）抛错，发现/构建阶段会报告。
// 能力清单：
// - Worker：远程 Notes 的宿主种类地址。
// - Notes：远程契约（label/count/add），有 main 变体，放在 Worker()。
// - Index/Clock：server 本地的单例对象契约。
// 示例（真实签名）：
//   const Notes = remote("example.notes", { version: 1, params: {}, hostAddress: () => Worker(),
//     variants: { main: { state: { label: str(), count: int() }, methods: { add: method(undefined, int()) } } } });
//   const Index = local("example.index", { version: 1, params: {}, members: { label: str() } });
// 阅读顺序：先看 Worker，再对比 Notes（remote）与 Index/Clock（local），最后回到 main.ts 看它们怎样被 load 和引用。
// 运行方式：本文件不是可执行入口，无法单独运行；通过 35-plugins/main.ts 的构建/加载间接验证（见该文件文件导读）。
// 预期行为：构建把本文件内联进每个导入它的 facet 脚本；插件与 app 声明的契约同名同版本时引用才能绑定。
// 相关文档：packages/chord/docs/slice-7c.md §2（构建导入规则）与 §4（逐插件装载）。
// The contracts the plugins share: a contracts-only plugin (no facet file). A plugin that imports this file gets its
// own copy built into its script; the app's code declares the same contracts (same names, versions and shapes).

// 从宿主包导入：构建时保持外部，求值时由 main.ts 的 modules 映射提供本进程的 Chord 实例。
// hostKind = 地址种类；remote/local = 两种契约；int/str/method = schema 构造器。
import { hostKind, int, local, method, remote, str } from "@earendil-works/chord";

/** The worker's host kind: `Notes` lives there. */
// 无地址参数的主机种类；Worker() 是地址数据，不会创建主机或子进程。
// 名字 "example.worker" 在运行期由 hostKind 检查（保留名等）；main.ts 的 route 和 worker 的 address 必须使用同一个。
export const Worker = hostKind("example.worker");

/** Notes on the worker: a label, a count and `add`. */
// Notes 是远程契约：server 的引用按 hostAddress 到 Worker 地址取对象；对象身份还包含 params 与 principal key。
// label/count 是状态成员（只读观察值），add 是方法。method(undefined, int()) 的第一个参数 undefined 表示
// 调用不带业务参数 schema；第二个 int() 是结果 schema。声明在加载期检查，方法入参在跨链路调用时按 schema 校验。
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
