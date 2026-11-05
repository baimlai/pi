// 文件导读
// 所属：packages/chord/test/examples，Chord v2 示例 33，对应 slice 7b（reload）。
// 演示内容：host.reload(facets, ctx) 把运行中的宿主切换到新插件集。staging 用 recording self 运行每个 setup 与受影响
// 对象的新工厂（不激活）；失败的插件保留旧代码并列入 failed。commit 一次替换服务类型/注册表/贡献，然后每个受影响
// 对象取自己的 fate。示例：纯 notes 对象在旧调用运行中被原地 swap；带 native 的 search 对象等运行中的调用排空后
// restart；被移除的 clock 对象结束，其 holder 不结束而是转为 failed { waiting }，插件再次被服务时自动绑定。
// 上游入口：命令行直接运行；纯内存 host，不写文件、不需要 store。
// 下游调用：local/method、defineState、createHost/defineFacet、constant、self.open（native）、
// host.load/reload/get/hold/close。
// 失败行为：staging 抛错的插件保留旧代码并出现在报告的 failed；实测 reload 仍 resolve，且其余增删照常提交。
// 移除插件的类型让已有对象结束；holder 保留最后值，状态回到 waiting。取消/非法名字有各自的拒绝路径。
// 能力清单（按演示机制列出，本文件没有导出）：
// - Notes：列表/横幅/add；Search：带 native 的搜索对象；Clock：后被移除的插件。
// - List：notes 共享的状态文档。
// - notesPlugin(banner)：可参数化的纯对象 facet（无 native），reload 时 swap。
// - searchPlugin(engine)：每次 reload 都 restart 的 facet（self.open 的 native）。
// - clockPlugin：最小 facet，用于演示移除与再次添加。
// - shown()：RefState 的单行文本。
// - 主流程：load 三个插件 → 纯 swap → native restart → 移除 → 再次服务 → staging 失败。
// 典型运行顺序：load → get(Notes).add → reload（换 notes）→ reload（换 search）→ reload（去掉 clock）→
// reload（加回 clock）→ reload（broken notes）→ close。
// 示例（真实签名）：
//   const report = await host.reload([{ name: "@example/notes", facet: notesV2 }], context);
//   report.plugins.changed;                 // ["@example/notes"]
//   report.objects[0].kind;                 // "swapped" | "restarted" | "ended" | "parked" | "retried"
// 阅读顺序：先看三个契约/List 与两个可参数化插件，再看 swap/restart/removal 的注释，最后看 staging 失败的实际行为。
// 前置条件：Node 支持 --experimental-strip-types。在 packages/chord 下运行：
//   node --conditions=source --experimental-strip-types test/examples/33-reload.ts
// 预期输出（本机实测；JSON 行较长，时间/先后稳定）：
//     search: lucene opened
//   1. loaded: [ 'first (v1)' ] banner v1
//   2. reload: {"plugins":{"added":[],"changed":["@example/notes"],"removed":[]},"failed":[],"objects":[{"object":"example.notes","kind":"swapped"}]}
//      the old call returned 2 ; the new code adds 3
//      list: [ 'first (v1)', 'second (v1)', 'third (v2)' ] banner v2 (same documents, new code)
//     search: reindex on lucene started
//   3. reload: [{"object":"example.search","kind":"restarted"}] - the reference shows loading
//     search: reindex on lucene done
//     search: lucene closed (reload)
//     search: tantivy opened
//      search now live on tantivy
//   4. reload: {"added":[],"changed":[],"removed":["@example/clock"]} - clock holder: failed { waiting }: example.clock is not served here
//      its last value stays readable: UTC
//   5. served again: clock holder live UTC
//     search: tantivy closed (end)
// 第 6 步的原始英文注释称 staging 错误“rejects the reload and changes nothing”；当前实现与实测并非如此：
// reload 以 failed 报告 resolve，notes 保留旧代码；但本次 facet 集合中缺失的 search/clock 仍被移除，
// 因此 try 块没有输出（没有拒绝消息），search 的 native 在移除时以 end 关闭（最后一行），clock holder 再次 waiting。
// 本文件只加注释，未改动原始英文注释；以宿主文档与实测行为为准。
// 相关文档：packages/chord/docs/slice-7b.md 与 design.md §7（reload）；相关测试：test/host/ 的 reload/staging 用例。
// Reload in the kernel (slice 7b): `host.reload(facets, ctx)` switches a running host to a new plugin set. Staging
// runs every setup and every affected object's new factory against a recording `self` (nothing activates; a throw
// rejects the reload and nothing changes), the commit swaps the served types, registries and contributions at once,
// then every object of a changed or removed plugin takes its fate. Here: a pure notes store is swapped in place while
// a call runs on its old code, a search index with a native restarts after its running call drained, and a removed
// plugin's object ends while its holder waits for it to come back.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/33-reload.ts
// `type Context` 仅类型导入：add 的显式参数注解需要它，运行时擦除。
import { BACKGROUND_CONTEXT, type Context } from "../../src/context/index.ts";
import { arr, int, local, method, obj, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type RefState } from "../../src/host/index.ts";
import { constant } from "../../src/state/index.ts";

const context = BACKGROUND_CONTEXT;

/** The notes store: a list, its count, and `add` (which can be told to wait, to show a call across a swap). */
// 空 params 单例：load 时激活；纯对象（无 native），所以 reload 可选择原地 swap。
// add 的结果是 int（列表长度）；banner 是 str 状态。
const Notes = local("example.notes", {
	version: 1,
	params: {},
	members: { list: arr(str()), banner: str(), add: method(obj({ text: str() }), int()) },
});

/** A search index over the notes, holding a native (an index file, say). */
// engine 是 str，reindex 无参数也无结果 schema。工厂里 self.open 的 native 让 reload 必须 restart。
const Search = local("example.search", { version: 1, params: {}, members: { engine: str(), reindex: method() } });

/** A clock plugin, removed by the third reload. */
// 最小对象：只有一个常量 zone。用于观察“插件被移除时对象结束、holder 等待、插件回来时自动绑定”。
const Clock = local("example.clock", { version: 1, params: {}, members: { zone: str() } });

// notes 的状态文档：同一 host 内所有 notes 对象共享这一份（单例文档）。
// reload 换的是代码，不是文档；因此 swap 后列表内容保留，只是写入前缀变成新版本。
const List = defineState("example.list", {
	schema: obj({ list: arr(str()) }),
	version: 1,
	initial: () => ({ list: [] }),
});

// slowAdd 是示例的闸门：不为 undefined 时，add 会等它的 promise；用于让旧调用的 add 跨越 reload。
// PromiseWithResolvers<void> 是原生类型，提供 {promise, resolve, reject}。
let slowAdd: PromiseWithResolvers<void> | undefined;

/** The notes plugin, its banner and the text `add` prefixes differing per version: a pure object (no `self.open`). */
// 用途：生成一个版本的 notes facet。输入 banner；输出 Facet（可交给 load/reload）。
// 每次调用返回新的 facet 对象：reload 以对象身份判断“未变化”，所以传入同一个对象才是 untouched。
// 工厂是纯的：没有 self.open 等 native，因此 reload 可把对象原地 swap。
// 示例（真实签名）：const notesV2 = notesPlugin("v2");
function notesPlugin(banner: string) {
	return defineFacet((host) =>
		host.serve(Notes, (_, self) => {
			// 每次激活都取同一个 List 单例文档（同一 host 上）；文档内容跨 reload 保留。
			const list = self.state(List);
			return {
				// list 成员由 derive 提供，读取文档的数组。
				list: self.derive([list], ([value]) => value.list),
				// banner 是常量 watchable（never changes）；新版本激活后就是新 banner。
				banner: constant(banner),
				// 显式注解参数类型：这里演示方法签名；实际类型也可由契约推断，但注解让说明更直接。
				// ctx: Context 是本次调用的上下文；change 的提交与取消都依赖它。
				add: async ({ text }: { text: string }, ctx: Context) => {
					// 旧调用（slowAdd 已设置）在这里暂停；普通调用中 slowAdd 为 undefined，
					// `?.` 短路得到 undefined，await undefined 立即继续。
					await slowAdd?.promise;
					// 提交变更，把当前版本的 banner 写进文本；闭包捕获的是本版本工厂的 banner。
					await list.change((draft) => void draft.list.push(`${text} (${banner})`), ctx);
					// 返回提交后列表长度（结果声明为 int）。
					return list.value.list.length;
				},
			};
		}),
	);
}

// 与 slowAdd 同理：让 reindex 的旧调用在 reload 后仍挂着，观察 restart 先排空再关 native。
let slowReindex: PromiseWithResolvers<void> | undefined;

/** The search plugin: its engine is a native, so every reload of it restarts the object. */
// 用途：生成一个版本的 search facet。输入 engine；输出 Facet。
// self.open(open, close)：open 是异步初始化并返回句柄值；close 在对象结束/重启时按原因调用。
// native 是“必须重启”的对象资源；reload 换代码时不能原地 swap，必须排空调用、关闭旧 native、再用新代码打开。
// 示例（真实签名）：const search = searchPlugin("lucene");
function searchPlugin(engine: string) {
	return defineFacet((host) =>
		host.serve(Search, (_, self) => {
			// open 返回 Native<T>（这里是 string）；关闭时 close 收到句柄值与原因 kind（end/reload/close）。
			// 打开日志与关闭日志让重启顺序可见。
			const index = self.open(
				async () => {
					console.log(`  search: ${engine} opened`);
					return engine;
				},
				(value, reason) => console.log(`  search: ${value} closed (${reason.kind})`),
			);
			return {
				// engine 成员是常量；reindex 通过 index.value 读取 native 句柄值。
				engine: constant(engine),
				reindex: async () => {
					// 闭包捕获本版本的 index 与 engine；旧调用即使在 restart 后完成，日志仍是旧 engine。
					console.log(`  search: reindex on ${index.value} started`);
					await slowReindex?.promise;
					console.log(`  search: reindex on ${index.value} done`);
					// 方法无结果 schema，返回 null。
					return null;
				},
			};
		}),
	);
}

// 最小 facet：不读 self，直接返回成员对象；zone 是常量 UTC。
// 表达式体箭头函数把 host.serve 的返回值（void）作为 defineFacet 回调结果，回调本身不需要返回。
const clockPlugin = defineFacet((host) => host.serve(Clock, () => ({ zone: constant("UTC") })));

/** Shows a reference's state as text. */
// 非 failed 状态（loading/live/ended）直接返回 kind；
// failed 时打印 cause.kind（transient/broken/waiting）与错误消息。先判 kind 才能安全访问 cause。
function shown(state: RefState): string {
	return state.kind === "failed" ? `failed { ${state.cause.kind} }: ${state.cause.error.message}` : state.kind;
}

// 1. A host with three plugins, loaded once. A reload passes the complete set; a facet passed as the very same object
// is an unchanged plugin (untouched), any other value for a loaded name a changed one.
// reload 的参数是“完整插件集”，不是增量：不在集合里的已加载插件会被移除（步骤 4）。
// facet 的对象身份决定未变化：同一对象 → untouched；同名但不同对象 → changed。
// 这里先创建 search、notesV2、searchV2 三个 facet 对象，供后面的 reload 复用。
const host = createHost({ onError: (error) => console.log(`  reported: ${error.kind}`) });
const search = searchPlugin("lucene");
const notesV2 = notesPlugin("v2");
const searchV2 = searchPlugin("tantivy");
// 初始加载：notes 用新创建的 notesPlugin("v1") 对象（与 notesV2 不同），search/clock 复用上面的对象。
// 空 params 对象在 load 时激活并运行工厂：search 的 native 在这里打开。
await host.load(
	[
		{ name: "@example/notes", facet: notesPlugin("v1") },
		{ name: "@example/search", facet: search },
		{ name: "@example/clock", facet: clockPlugin },
	],
	context,
);
// get 等待 notes live；add 写入第一项，banner 为 v1。
// console.log 的多个参数用空格分隔，数组按 Node 宽度决定是否换行。
const notes = await host.get(Notes, {}, context);
await notes.add({ text: "first" }, context);
console.log("1. loaded:", notes.list.value, "banner", notes.banner.value);

// 2. A pure swap while a call runs: the running `add` finishes on the old code, the next call runs on the new one.
// 打开闸门：接下来的 add 会停在 slowAdd.promise；先发起 running，再 reload。
// running 的闭包捕获 v1 工厂的 banner，因此即使 reload 后新代码生效，它仍写 v1。
slowAdd = Promise.withResolvers();
const running = notes.add({ text: "second" }, context);
// reload 的完整集合中：notes 换成 notesV2（changed）；search 与 clock 传同一对象（untouched）。
// 纯对象（无 native）的 fate 是 swapped：原地替换服务代码，不重新激活，也不等待正在运行的调用。
// reload 报告包含 plugins（增/改/删）、failed、objects（每个受影响对象的 fate）。
const swap = await host.reload(
	[
		{ name: "@example/notes", facet: notesV2 },
		{ name: "@example/search", facet: search },
		{ name: "@example/clock", facet: clockPlugin },
	],
	context,
);
// JSON.stringify 把报告压成一行；Error 对象在 failed 里会序列化为 {}，本例 failed 为空。
console.log("2. reload:", JSON.stringify(swap));
// 放行旧调用：它继续在旧代码上完成提交，返回长度 2（first + second）。
slowAdd.resolve();
slowAdd = undefined;
// 新调用走新代码：写入 "third (v2)"，返回 3。两个调用都作用于同一份 List 文档。
console.log(
	"   the old call returned",
	await running,
	"; the new code adds",
	await notes.add({ text: "third" }, context),
);
// 列表保留两版写入；banner 来自新代码的常量 v2。
console.log("   list:", notes.list.value, "banner", notes.banner.value, "(same documents, new code)");

// 3. A restart: the search object holds a native. Its running call drains first, then the native closes (reload).
// 取 Search 引用；reindex 是普通方法调用，日志先打印 started，然后等闸门。
const index = await host.get(Search, {}, context);
slowReindex = Promise.withResolvers();
const reindexing = index.reindex(context);
// 等一个宏任务，确保 started 已打印（日志顺序更直观），再触发 reload。
await new Promise((resolve) => setTimeout(resolve, 0));
// 这次 search 换成 searchV2（changed）。因为它有 native，fate 是 restarted：
// 先排空正在运行的调用，再以 reload 原因关闭旧 native，重新激活新代码并打开新 native。
// reload 的 Promise 在 fate 启动后 resolve，不等待排空/重新 live；因此下面的报告先于 reindex done 打印。
const restart = await host.reload(
	[
		{ name: "@example/notes", facet: notesV2 },
		{ name: "@example/search", facet: searchV2 },
		{ name: "@example/clock", facet: clockPlugin },
	],
	context,
);
// `restart.objects` 只打印对象 fate 数组；同一 index 引用在 restart 期间显示 loading。
console.log("3. reload:", JSON.stringify(restart.objects), "- the reference shows", shown(index.state.value));
// 放行旧调用：它在旧 native 上完成，然后 restart 才关闭 lucene、打开 tantivy。
slowReindex.resolve();
// 等旧调用结算；再等 10ms 让新对象激活并绑定引用。
await reindexing;
await new Promise((resolve) => setTimeout(resolve, 10));
// 引用重新 live，engine 成员读到新代码的 tantivy。
console.log("   search now", shown(index.state.value), "on", index.engine.value);

// 4. A removal: the clock plugin is gone. Its object ends; its holder's request is not ended, it waits `not_served`.
// hold 同步取得引用（不会拒绝）；先绑定，再 reload。
// 本次集合不含 clock → 已加载的 clock 被移除：对象结束，但 holder 的等待不结束，
// 引用状态变为 failed { waiting }，消息说明不在此处服务。
const clock = host.hold(Clock, {}, context);
await new Promise((resolve) => setTimeout(resolve, 0));
const removal = await host.reload(
	[
		{ name: "@example/notes", facet: notesV2 },
		{ name: "@example/search", facet: searchV2 },
	],
	context,
);
// removal.plugins 显示 removed: ["@example/clock"]；holder 进入 waiting。
console.log("4. reload:", JSON.stringify(removal.plugins), "- clock holder:", shown(clock.state.value));
// 失败/等待的引用仍保留最后值：zone 可读，虽然对象已结束。
console.log("   its last value stays readable:", clock.zone.value);

// 5. A later reload serves the clock again: the same holder binds again by itself.
// 再次把 clockPlugin 放进集合 → added；发布唤醒同一 holder，无需重新 hold/get。
await host.reload(
	[
		{ name: "@example/notes", facet: notesV2 },
		{ name: "@example/search", facet: searchV2 },
		{ name: "@example/clock", facet: clockPlugin },
	],
	context,
);
// 等发布后的放置完成；引用重新 live，zone 仍是 UTC（新对象的新常量）。
await new Promise((resolve) => setTimeout(resolve, 0));
console.log("5. served again: clock holder", shown(clock.state.value), clock.zone.value);

// 6. A staging error rejects the reload and changes nothing.
// 注意：上面的英文注释是旧描述。当前实现与实测：broken 的工厂在 staging 抛出，
// reload 不会 reject，而是以 failed 报告 resolve；broken 这个 changed 插件保留旧代码（notes 仍是 v2）。
// 但本次集合只含 notes，不在集合里的 search/clock 仍被移除（report.plugins.removed 会列出它们），
// 所以“changes nothing”不成立：search 对象结束（native 以 end 关闭），clock holder 再次 waiting。
// 由于 reload 没有拒绝，catch 不会执行，脚本没有打印任何第 6 步输出。
// 原始英文注释保持不变；这里以实测行为说明。
const broken = defineFacet((h) =>
	h.serve(Notes, () => {
		throw new Error("a typo in the new factory");
	}),
);
try {
	await host.reload([{ name: "@example/notes", facet: broken }], context);
} catch (error) {
	console.log("6. rejected:", (error as Error).message, "- banner still", notes.banner.value);
}

await host.close(context);
