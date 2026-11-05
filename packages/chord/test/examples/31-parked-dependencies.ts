// 文件导读
// 所属：packages/chord/test/examples，Chord v2 示例 31，对应 slice 7a（依赖模型/停放）。
// 演示内容：依赖暂时不存在的对象进入 parked 而不是 failed：状态显示 failed { waiting }，消息指出最近的阻塞者与根因；
// 不为它跑计时器，工厂不会重跑；依赖一旦 live，对象自动继续。示例里 tab 的 Panel 依赖 server 尚未提供的 Notes；
// server 重启并加载 notes 插件、tab 重连后，Panel 无需任何人再次请求就变为 live。Header 依赖本地无人提供的 Theme，
// 同样停放在类型名索引下。get 可以带 readyTimeout 等待，超时后以等待原因拒绝。
// 上游入口：命令行直接运行；两个内存 host 通过 memoryLinkPair 连接，不写文件、不联网。
// 下游调用：hostKind/remote/local/defineState、createHost/defineFacet/hold/get/connect/accept、memoryLinkPair、
// isChordError、Reference 的 state/watch/release。
// 失败行为：无人提供的依赖产生 failed { waiting }（retryAt 为 undefined）；get 超时拒绝但不影响已有的 hold；
// 链接断开后引用先显示 loading，重新连上并绑定后变 live；释放/关闭让引用 ended。
// 能力清单（按演示机制列出，本文件没有导出）：
// - Principal：server/owner 两种身份；Server：hostKind，remote 的放置地址。
// - Notes：remote 契约（宿主地址 Server，一个 editor 变体，state list + 方法 add）。
// - Panel/Theme/Header：本地契约；Panel 依赖 Notes，Header 依赖无人提供的 Theme。
// - List：Notes 服务的状态文档。
// - notesPlugin：Notes 的 server facet。
// - startServer()：用一组插件创建 server host 并接受 tab 的链路。
// - follow()/describe()：把 RefState 的变化打印成一行。
// - 主流程：无笔记服务 → panel/header 停放 → get 超时 → 时间流逝不重跑工厂 → 换带 notes 的 server 重连 → live。
// 典型运行顺序：startServer([]) → tab.connect → tab.hold(Panel) → follow → hold(Header) → get(readyTimeout 200) →
// 等 1.5s → 关闭第一个 server → startServer([notes]) → tab.connect → tab.get(Panel) → tab.get(Notes).add →
// 释放引用并关闭两个 host。
// 示例（真实签名）：
//   const panel = tab.hold(Panel, { id: 1 }, context);      // Held<typeof Panel>，同步返回
//   const state: NativeWatchable<RefState> = panel.state;   // 当前状态与后续变化
//   const live = await tab.get(Panel, { id: 1 }, context);  // 等到 live 才 resolve
// 阅读顺序：先看 Principal/Server/Notes 与三个本地契约，再看 List 与 notesPlugin，
// 然后看 startServer/follow/describe，最后按编号读五个场景。
// 前置条件：Node 支持 --experimental-strip-types。在 packages/chord 下运行：
//   node --conditions=source --experimental-strip-types test/examples/31-parked-dependencies.ts
// 预期输出（本机实测；at() 的秒数随机器速度变化，顺序稳定）：
//   0.0 s: panel: failed { waiting }: waiting for example.notes: example.notes is not served here
//   0.0 s: panel now failed { waiting }: waiting for example.notes: example.notes is not served here
//   0.0 s: header failed { waiting }: waiting for example.theme: example.theme is not served here
//   0.2 s: get gave up after 200 ms: waiting for example.notes: example.notes is not served here
//   1.7 s: still failed, factory runs: 1
//   1.7 s: panel: loading
//   1.7 s: panel: live
//   1.7 s: panel live, count 0, factory runs: 1
//   1.8 s: panel count 1
// 相关文档：packages/chord/docs/slice-7a.md 与 design.md §7（引用状态/停放）；相关测试：test/host/ 的依赖停放用例。
// Parked dependencies (dependency model, slice 7a): a reference is a request that outlives every provider it meets. An
// object whose dependency is not there yet is parked, not failed: it shows `failed { waiting }` naming what it waits
// for (the nearest blocker and the root cause), no timer runs for it, its factory is not run again, and it goes on the
// moment its dependency is live. Here a tab's panel needs `Notes` from a server that does not serve it yet; the server
// restarts with the notes plugin, the tab reconnects, and the panel goes live without anyone asking.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/31-parked-dependencies.ts
// 分组 import：上下文、契约构造器（含 hostKind/remote）、错误判定、状态文档、host 入口、内存链路、watch 类型。
// `type RefState` 与 `NativeWatchable` 是仅类型导入，编译后擦除。
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { arr, hostKind, int, local, method, obj, remote, str } from "../../src/contracts/index.ts";
import { isChordError } from "../../src/data/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type RefState } from "../../src/host/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import type { NativeWatchable } from "../../src/watch.ts";

const context = BACKGROUND_CONTEXT;
// 记录脚本启动时刻；at() 输出相对秒数（保留一位小数），用于观察停放期间没有计时器、时间仍在流逝。
const started = Date.now();
// 箭头函数返回字符串；toFixed(1) 总是产生一位小数，例如 "0.0 s"。
const at = (): string => `${((Date.now() - started) / 1000).toFixed(1)} s`;

// 与示例 30 相同的身份联合类型：server 用于服务器/链路身份，owner 用于经链路到达的请求。
// 只是类型，不参与运行期校验。
type Principal = { readonly kind: "server" } | { readonly kind: "owner" };

// hostKind 创建“宿主种类”地址工厂：Server() 返回 {kind:"server", params:{}, key}。
// 地址决定远程对象放在哪个宿主，不进入契约指纹；运行期检查 kind 名（"client" 保留）。
// 例：hostAddress: () => Server() 表示 Notes 对象应放在 server 种类的宿主上。
const Server = hostKind("server");

/** The server's notes (the notes plugin), placed on the server. */
// remote 契约：hostAddress 是放置地址（每个 params 组合一个地址）；params 为空表示单一对象。
// variants 是每个 principal 可用的变体声明；这里只有 editor，state 为 list，方法 add 接收 {text}。
// 变体声明会在声明期做成员一致性检查；运行期工厂必须返回其中一个变体名。
// 本契约的历史版本为 1；远程调用跨链路时只传输 JSON 数据与错误。
const Notes = remote("example.notes", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { editor: { state: { list: arr(str()) }, methods: { add: method(obj({ text: str() })) } } },
});

/** A panel in the tab: a local object over the server's notes. */
// 本地契约，params {id} 让每个面板是独立对象；count 是状态成员，实现由 derive 提供。
// 它的工厂里有 self.get(Notes, {})：依赖缺失时对象停放，而不是失败。
const Panel = local("example.panel", { version: 1, params: { id: int() }, members: { count: int() } });

/** A local object the panel's sibling needs, which no plugin of the tab serves. */
// Theme 是本地类型，但 tab 没有插件服务它；Header 依赖它时同样进入 failed { waiting }。
// 这说明“等待”不只发生在远程类型上：任何未绑定的依赖都按同一模型处理。
const Theme = local("example.theme", { version: 1, params: {}, members: { name: str() } });
const Header = local("example.header", { version: 1, params: { id: int() }, members: { title: str() } });

// Notes 的状态文档：内存（无 persist），每个 notes 对象一份，初始空列表。
// schema 与 initial 的返回类型一致；add 的变更在事务里按 schema 校验。
const List = defineState("example.list", {
	schema: obj({ list: arr(str()) }),
	version: 1,
	initial: () => ({ list: [] }),
});

/** The notes plugin's server facet. */
// 远程对象的工厂签名是 (params, principal, self)：每个 principal 一个对象实例。
// 这里 _params/_principal 不用；返回 {variant, members}，variant 必须匹配声明的变体名。
const notesPlugin = defineFacet<Principal>((host) => {
	host.serve(Notes, (_params, _principal, self) => {
		// 每个远程 notes 对象拥有自己的 List 文档。
		const list = self.state(List);
		return {
			variant: "editor",
			members: {
				// derive 把文档的 list 暴露为只读状态成员；变更后自动通知远程读者。
				list: self.derive([list], ([l]) => l.list),
				// 方法实现；ctx 是调用者的 Ctx<Principal>，其封口/取消随远程调用传播。
				add: async ({ text }, ctx) => {
					// `void draft.list.push(text)` 显式丢弃 push 的返回值（number），让回调返回 undefined；
					// 变更本身由事务追踪，不依赖返回值。多行/单行回调行为相同。
					await list.change((draft) => void draft.list.push(text), ctx);
					return null;
				},
			},
		};
	});
});

/** A server with the given plugins, its link to the tab accepted. */
// 用途：创建 server 宿主、加载给定插件、建立内存链路端点对，并接受 tab 侧连接。
// 输入：plugins（名字 + facet）；输出：{server, tabLink, close}，close 关闭 server 这一端的链路。
// 副作用：创建 host 与链路；accept 让经该链路到达的 hold 以 owner 身份行事。
// 错误路径：load/accept 抛错向上传播；onError 故意为空，示例不关心后台错误。
// 主要流程：createHost(address=Server) → load → memoryLinkPair 得到 [up, down] → accept(up) → 返回 down 给 tab。
// 类型说明：facet 的类型写作 typeof notesPlugin，这是示例只加载同一形状插件的捷径；
// 空数组 [] 也满足该类型。真实代码应使用 host.load 的插件描述类型。
// 示例（真实签名）：const first = await startServer([]); tab.connect(first.tabLink, {principal:{kind:"server"}}, context);
async function startServer(plugins: { readonly name: string; readonly facet: typeof notesPlugin }[]) {
	// address 让本宿主成为 Server 种类的目标；principal 是宿主自身身份。
	// onError 为空函数：本示例只观察引用状态，不打印宿主后台错误。
	const server = createHost<Principal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
	// 加载插件；空参数对象此时激活，带 params 的远程对象等待 hold。
	await server.load(plugins, context);
	// memoryLinkPair 返回同一内存链路的两端：[up, down]。server 接受 up，tab 连接 down。
	const [up, down] = memoryLinkPair();
	// accept 是“子链接”：经它到达的请求以 owner 身份执行（示例只演示一种身份）。
	// 第三个参数是该链路上工作的父上下文；这里用脚本的后台上下文。
	server.accept(up, { principal: { kind: "owner" } }, context);
	// close 只关 server 端链路（up），用于模拟链路断开；host 本身稍后才关闭。
	return { server, tabLink: down, close: () => up.close() };
}

// The tab: its panel declares the notes (a dependency); its header a theme nobody serves.
// 模块级计数器：记录 Panel 工厂实际执行次数，用来证明停放不会重跑工厂。
// tab 是普通本地宿主（无 address）：远程类型不在本地服务时经父链路转发。
// onError 打印 ${at()} 与错误 kind；本示例运行中没有后台错误。
let panels = 0;
const tab = createHost<Principal>({ onError: (error) => console.log(`${at()}: reported ${error.kind}`) });
// 只加载一个 facet；Panel/Header 都有 params，因此 load 时不会激活，等 hold 才创建。
// Panel 工厂：先计数，再声明 Notes 依赖（self.get 同步返回引用，不等待绑定），
// 最后用 notes.list 作为 derive 源；依赖未绑定时对象停放，derive 也不会计算。
// 注意 self.get 返回 Reference；notes.list 是 state 成员，本身就是 watchable。
// Header 工厂：self.get(Theme, {}).name 同理；Theme 无人服务，Header 将停放。
await tab.load(
	[
		{
			name: "@example/panel",
			facet: defineFacet<Principal>((host) => {
				host.serve(Panel, (_, self) => {
					panels++;
					const notes = self.get(Notes, {});
					return { count: self.derive([notes.list], ([list]) => list.length) };
				});
				host.serve(Header, (_, self) => ({ title: self.get(Theme, {}).name }));
			}),
		},
	],
	context,
);

/** Prints every state of `state` as it changes. */
// 用途：订阅 ref.state，每次状态变化打印一行；不返回句柄（watch 随引用/宿主结束而结束）。
// 输入：label（前缀）、state（NativeWatchable<RefState>）；输出：Promise<void>，在安装监听后立即兑现。
// 主要流程：await state.watch(context) 取得当前值与订阅 → start 安装唯一监听器（绝不同步调用）。
// 类型说明：call 是 NativeWatchCall<RefState>；kind === "value" 时 value 才是 RefState。
// 示例（真实签名）：await follow("panel:", panel.state);
async function follow(label: string, state: NativeWatchable<RefState>): Promise<void> {
	// state.watch 返回的句柄 .value 是获取时的状态；start 之后只投递后续变化，不补发这个值。
	const watch = await state.watch(context);
	watch.start(async (call) => {
		// 监听器必须 async；非 value 帧（failed）在这里被忽略。
		if (call.kind === "value") console.log(`${at()}: ${label} ${describe(call.value)}`);
	});
}

// 把 RefState 压成一行：非 failed 直接返回 kind（loading/live/ended）；
// failed 时展示 cause.kind 与错误消息。先判断 kind 才能访问 cause，这是可辨识联合的收窄。
// failed 还有 retryAt（停放时为 undefined，表示没有计时器），这里不展示。
// 纯函数，无副作用，不校验运行期形状。
function describe(state: RefState): string {
	if (state.kind !== "failed") return state.kind;
	return `failed { ${state.cause.kind} }: ${state.cause.error.message}`;
}

// 1. The first server has no notes plugin. Its answer is `failed { waiting }`: not the panel's fault.
// 第一个 server 不加载任何插件：链路能通，但 Notes 无人服务。
const first = await startServer([]);
// tab 连接父链路：principal 表示父方身份（server）。子方未路由的远程 hold 经此转发。
tab.connect(first.tabLink, { principal: { kind: "server" } }, context);
// hold 同步返回 Held 引用：此时可能还没有 variant；状态通过 panel.state 观察。
// Panel 工厂在这一步执行一次（panels 变为 1），声明 Notes 依赖后对象停放。
const panel = tab.hold(Panel, { id: 1 }, context);
// 订阅状态变化；下一行等待 10ms，让绑定失败（Notes 不在任何可及宿主上）传播为 failed waiting。
await follow("panel:", panel.state);
await new Promise((resolve) => setTimeout(resolve, 10));
// 再读一次当前状态：仍是 failed { waiting }，消息给出最近阻塞者与根因。
// 注意 wait 原因是 queue 内的错误，不是 Panel 自身代码抛错。
console.log(`${at()}: panel now ${describe(panel.state.value)}`);

// 2. A local type nobody serves here is the same answer: the request waits unbound, indexed under the type's name.
// Header 依赖 Theme：本地类型，但 tab 的插件集里没有服务者；请求以类型名登记为 unbound。
// 同一模型：没有计时器、没有重试；有人服务该名字（或链路提供）时才继续。
const header = tab.hold(Header, { id: 1 }, context);
await new Promise((resolve) => setTimeout(resolve, 10));
console.log(`${at()}: header ${describe(header.state.value)}`);

// 3. A getter waits through `waiting` up to its readyTimeout, then rejects with the cause (a hold just shows it).
// get 与 hold 不同：get 等待可用，最多 readyTimeout（这里 200ms），超时后以最后原因拒绝。
// try/catch 捕获拒绝；isChordError 是运行期类型谓词，确认是 ChordError 后才读 message。
// 注意这次 get 失败只结束它自己的等待；panel 的 hold 继续停放，之后仍可绑定。
try {
	await tab.get(Panel, { id: 1 }, context, { readyTimeout: 200 });
} catch (error) {
	if (isChordError(error)) console.log(`${at()}: get gave up after 200 ms: ${error.message}`);
}

// 4. Time passes: no timer runs for the parked panel, its factory is not run again.
// 等 1.5 秒：如果停放依赖轮询/重试，工厂会被重跑；实际 panels 仍为 1，状态仍为 failed。
// 这是“停放无计时器”的直接证据：没有事件时不会有任何工作发生。
await new Promise((resolve) => setTimeout(resolve, 1500));
console.log(`${at()}: still ${panel.state.value.kind}, factory runs: ${panels}`);

// 5. The server restarts with the notes plugin (the link drop shows as loading); the tab reconnects: its request is
// held again and binds, and the parked panel goes on.
// 关闭第一个 server 的链路：tab 侧依赖该链路的引用先回到 loading（原始注释说明），随后可重新连接。
first.close();
await new Promise((resolve) => setTimeout(resolve, 10));
// 第二个 server 加载 notes 插件：从现在起 Server 种类地址上有人服务 Notes。
const second = await startServer([{ name: "@example/notes", facet: notesPlugin }]);
// tab 重新连接新的父链路；parked 的 hold 在新链路上重新发出并绑定。
tab.connect(second.tabLink, { principal: { kind: "server" } }, context);
// get 等待到 live 后返回引用；Panel 的工厂不会再执行（panels 仍为 1），
// 它的 derive 在依赖 live 后计算，count 为 0（列表为空）。
const live = await tab.get(Panel, { id: 1 }, context);
console.log(`${at()}: panel live, count ${live.count.value}, factory runs: ${panels}`);
// The panel's notes are the owner's object on the server (a remote object per principal): the tab adds through its own.
// tab 再取同一个 Notes 远程对象（同一 principal/params 共享实例），通过它 add。
// 该对象在 server 上属于 owner 身份（accept 时指定）；Panel 依赖的也是同一实例。
// 添加后等 10ms，让远程状态变化经链路回传、derive 重算，再读 live.count。
const notes = await tab.get(Notes, {}, context);
await notes.add({ text: "first" }, context);
await new Promise((resolve) => setTimeout(resolve, 10));
console.log(`${at()}: panel count ${live.count.value}`);

// 收尾：释放各个引用（释放后 ref.state 以 ended 结束其 watch），关闭 tab 与两个 server 宿主。
// 第一个 server 的链路已关闭，但其 host 仍在，因此最后仍需 close。
header.release();
panel.release();
live.release();
notes.release();
await tab.close(context);
await second.server.close(context);
await first.server.close(context);
