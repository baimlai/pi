// 文件导读
// 所属：packages/durable/test/examples 的 36-durable-views.ts，Durable 示例系列第 36 个，
// 演示“把 Durable 的视图接入 Chord 源”。
// 演示内容：Chord local 对象 example.chat 用 self.follow 跟随两个 Durable 视图（根会话的 ConversationView 与
// 整个 Session 的 TaskGraph），再用 self.derive 把两者合成一个 summary 状态成员；write 方法每写一条 Durable
// 记录，观察者收到一帧，derive 在同一宿主批次里只计算一次。
// 上游入口：node 直接运行本文件；sqlite 用 :memory:，无网络；模型目录与注册表为空，不运行生成。
// 下游依赖：Chord 的 createHost/defineFacet/local/method/obj/arr/str/int/self.follow/self.derive、
// Chord sqlite 的 openNodeSqliteDatabase，Durable 的 Harness/StoreStorage/ROOT_CONVERSATION_ID。
// 能力清单：summary 状态成员与其 schema；self.follow 跟随 observeConversation/observeTaskGraph；
// self.derive 合并两个源；write 提交；summary.watch 的逐帧 ops；member value 同步读取；关闭顺序。
// 典型顺序：声明契约 -> 定义 facet 与 self.open -> 两个 follow -> derive -> 打开 store/host -> 取对象 ->
// watch 成员 -> 两次 write -> 等投递 -> 读成员值 -> stop/关闭 host 与 store。
// 前置条件：Node 内置 sqlite 可用；无需 API key；:memory: 数据库随 store 关闭丢弃。
// 预期输出（逐字）：
// frame: [ 'example.first' ] [["p",["kinds"],0,0,["example.first"]]]
// frame: [ 'example.first', 'example.second' ] [["p",["kinds"],1,0,["example.second"]]]
// member value: { kinds: [ 'example.first', 'example.second' ], tasks: 0 }
// 阅读顺序：先看 Chat 的 summary 与 write；再看 serve 里 self.open 之后的两个 follow，理解 attach 时机；
// 随后看 derive 的合并规则；最后看 watch 帧与 ops 如何对应两次提交。
// Durable's views as Chord sources: `self.follow(attach)` turns Durable's synchronous observers (the conversation view,
// the task graph) into watchables, members and derive sources of the object that opened Durable. With Durable on the
// host's store, Durable adopts its commits inside the store's commit step, in the host's batch: a derive over two views
// of one commit computes once, and a watcher gets one frame per commit.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/36-durable-views.ts

import {
	// arr(str()) 是字符串数组 schema；summary.kinds 的类型因此是 string[]。
	arr,
	// createHost 建立 Chord 宿主；宿主持有 store 的批次，Durable 的发布因此能并入同一个 commit 批次。
	createHost,
	// facet 在 host.load 时执行 setup，用 host.serve 登记它提供的契约。
	defineFacet,
	// int() 是整数 schema（不是浮点 num）；summary.tasks 声明为整数。
	int,
	// local 声明同宿主对象；空 params 表示单实例，生命周期与宿主一致。
	local,
	// method(str()) 表示一个 string 参数、无结果的方法；write 的返回值因此是 null。
	method,
	// obj({...}) 声明对象 schema，属性默认必填；Static 类型由它推导。
	obj,
	// openStore 在 Chord store 后端上打开 store；宿主随后接管它的提交队列与批次。
	openStore,
	// sqliteBackend 把 sqlite 执行器包成 store 后端；示例用 :memory:，不落盘。
	sqliteBackend,
	// str() 是字符串 schema，用于 kinds 的元素与 write 的参数。
	str,
} from "@earendil-works/chord";
// BACKGROUND_CONTEXT 是不带取消信号的根上下文；watch、提交与关闭都用它。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// Node 内置 sqlite 驱动；:memory: 表示进程内数据库。
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
// 空模型目录够用：示例只写记录，不请求模型。
import { createModels } from "@earendil-works/pi-ai";
// ROOT_CONVERSATION_ID 是根会话的保留 ID；观察与写入都指向它。
import { createRegistry, Harness, ROOT_CONVERSATION_ID } from "../../src/index.ts";
// StoreStorage 把 Durable 的表与文档放到传入的 Chord store 上，使两边的提交共用批次与 seq。
import { StoreStorage } from "../../src/storage/store/index.ts";

const context = BACKGROUND_CONTEXT;

// 声明 local 契约 example.chat：一个状态成员 summary 和一个方法 write。
// summary 不是普通字段，而是 derive 暴露出的 Watchable：实例上可按 .value 读取、按 .watch(ctx) 订阅。
// 例：await chat.summary.watch(context) 得到句柄；chat.write("example.first", context) 写一条记录。
const Chat = local("example.chat", {
	version: 1,
	params: {},
	members: {
		// What a UI shows: the kinds of the transcript's entries and the number of tasks, from two views.
		// summary 声明为状态成员，schema 是 { kinds: string[]; tasks: integer }。
		// obj/arr/int 给出 TypeScript 的 Static 类型，并参与契约指纹与线上编码；同宿主 local 值按 JSON 约定使用，
		// 示例不在每次 derive 计算后做 schema 逐值校验。
		// 工厂返回的 summary 必须解析为 Chord watchable（这里是 derive）。
		summary: obj({ kinds: arr(str()), tasks: int() }),
		// write 接收一个字符串、返回 null；实现里用这个字符串作为条目 kind。
		write: method(str()),
	},
});

// facet 的 setup 只登记 serve；真正的对象 API 在每次激活的工厂里创建。
const facet = defineFacet((host) => {
	// serve 声明本 facet 提供 Chat；第一个参数是空 params 的对象身份，这里用不到。
	host.serve(Chat, (_, self) => {
		// 声明 native 资源：激活时打开 Durable Harness，尝试结束或宿主关闭时关闭。
		// 关键顺序：native 先于 follow 打开，所以下面 follow 的回调里可以安全读取 harness.value。
		const harness = self.open(
			// 形参 open 是激活期 context（可被取消），不是打开函数；它传给 StoreStorage.open 与 Harness.open。
			async (open) => {
				// 在宿主同一个 store 上打开 Durable；StoreStorage 的 owner 与下面的写入、观察共享。
				const opened = await Harness.open(
					// owner 取 Chat.name（example.chat）：Durable 的表与文档命名空间都登记在这个 owner 下。
					await StoreStorage.open(store, Chat.name, open),
					// 空模型与注册表即可：没有生成，也没有扩展任务。
					{ models: createModels(), registry: createRegistry() },
					open,
				);
				// 创建根会话但不写转录条目；follow attach 发生在这之后，因此 view 初始的 entries 是空数组。
				await opened.root(open);
				return opened;
			},
			// 关闭回调：h 是已打开的 Harness，_reason 是 end/close/reload，close 是关闭用 context；
			// 这里统一交给 Harness.close，示例不区分原因。
			(h, _reason, close) => h.close(close),
		);
		// self.follow 把一个外部运行时的同步观察者包装成 Chord 源。
		// attach 在本次尝试的 native 打开之后执行；返回 undefined 或 reject 使激活以 transient 失败；
		// 尝试结束时自动 detach。外部运行时 failed 会让对象失败并重试，ended 则保留最后值、源永久结束。
		// 返回的源可作为状态成员、derive 源或 on 源。
		// 1. Follow two of Durable's views; they attach once the natives opened.
		// 回调输入 Chord 提供的 observer 与上下文；返回 Durable 的 Observation（value + detach），结构上即 FollowAttachment。
		// observer 的 advance 只同步记录，不能 await 或调用 Durable。
		// view：观察根会话的 ConversationView，窗口参数 min=50（max 默认 2*min=100）。
		// 首帧取最新 50 条；之后的提交追加，超过 100 条时一次性裁回 50 条；before 给出窗口前一条的 ID。
		// 示例只有两条记录，因此 v.entries 始终是完整窗口。
		const view = self.follow((observer, ctx) =>
			harness.value.observeConversation(ROOT_CONVERSATION_ID, observer, ctx, { min: 50 }),
		);
		// 观察整个 Session 的 TaskGraph：tasks 以十进制 TaskId 为键；本示例没有生成任务，所以数量为 0。
		const graph = self.follow((observer, ctx) => harness.value.observeTaskGraph(observer, ctx));
		// self.derive 的输入按数组顺序给出，compute 收到同序的值数组。
		// compute 必须同步、无副作用；derive 按需重算，同一批次内至多计算一次。
		// Durable 在 store 的提交步骤里用 host batch 发布两边视图的变化，因此一次提交中的两个 advance
		// 落在同一批次：compute 只跑一次，watch 也只收到一帧。
		// 2. A derive over both: one compute per Durable commit.
		// sources 是 [ConversationView 源, TaskGraph 源]；返回的 Watchable<{kinds,tasks}> 随后作为 summary 成员暴露。
		// 激活期 compute 抛错会使尝试失败，live 后的失败按 derive_failed 逐次上报。
		const summary = self.derive([view, graph], ([v, g]) => ({
			// 把窗口内每条 EntryRecord 的 kind 投影成字符串数组；初始窗口为空时结果是 []。
			kinds: v.entries.map((entry) => entry.kind),
			// 统计任务图中 live 任务的数量；写记录不会创建任务，所以这里保持 0。
			tasks: Object.keys(g.tasks).length,
		}));
		// serve 工厂的返回值：summary 状态成员与 write 方法；成员检查会确认 summary 解析为 watchable。
		return {
			// 把 derive 直接作为状态成员暴露；Chord 用成员名 summary 在 derive 错误报告中指代它。
			summary,
			// 方法实现签名与 method(str()) 对应：一个 string 参数，后面是上下文。
			write: async (kind, ctx) => {
				// 取根会话句柄；conversation 只打开已有会话，不存在时返回 undefined，示例用 ! 断言它已由 root() 创建。
				const root = await harness.value.conversation(ROOT_CONVERSATION_ID, ctx);
				// write 提交只追加条目、不启动 run；接纳与写入在同一次 Durable 提交中完成，占 store 的一个 seq，并触发视图的一帧。
				await root!.submit({ type: "write", entry: { kind } }, ctx);
				// 返回值必须是 JSON；null 与 method(str()) 声明的无结果一致。
				return null;
			},
		};
	});
});

// 内存 store 让示例自包含；宿主附着后，Durable 的发布通过 store.batch 并入宿主的提交批次。
const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
// 宿主接管 store 与对象生命周期；onError 只打印 HostError 的 kind，真实应用应记录完整错误。
const host = createHost({ store, onError: (error) => console.log("onError", error.kind) });
// 加载 facet 只执行 setup 并登记契约；对象尚未激活。
await host.load([{ name: "@example/core", facet }], context);
// 首次 get 触发激活：打开 native -> attach 两个 follow -> attach derive -> 成员检查 -> live，全部完成后才返回实例。
const chat = await host.get(Chat, {}, context);

// summary 是 Watchable：watch(context) 返回从获取时值开始的句柄，必须调用 start 才开始投递。
// 监听器串行执行：回调运行期间到达的变化会折叠进下一次调用；context 中止会让 watch 以 aborted 结束。
// 每帧的 ops 是把上一值变成新值的 delta；示例中两次提交各产生一帧。
// 3. Watch the member: one frame per Durable commit, with its ops.
// watch 的 value 是获取瞬间的 derive 值（此时 kinds 为 []）；start 之前不会收到任何回调。
const watch = await chat.summary.watch(context);
// 安装唯一监听器；投递异步且绝不同步内联调用，每次提交后的 await 会先让出微任务，监听器随后执行。
watch.start(async (call) => {
	// value 帧携带完整新值、从上一值到它的 ops，以及 retired 标记；failed 帧表示源暂时无法计算。
	// ops 是 splice 操作 ["p", path, index, deleteCount, inserts]：第一帧在 ["kinds"] 的 0 处插入一项，
	// 第二帧在 1 处再插入一项。调用 kind 用运行时字符串判别，收窄后 call.value 才可读。
	if (call.kind === "value") console.log("frame:", call.value.kinds, JSON.stringify(call.ops));
});
// 第一次 write：一个 Durable 提交同时推进会话视图（entries +1）；同一批次内 derive 只计算一次，watch 收到第一帧。
await chat.write("example.first", context);
// 第二次 write：第二个提交、第二帧；ops 只描述新增的那一项，而不是整体替换。
await chat.write("example.second", context);
// watch 的投递经过微任务队列，监听器还是 async；这里等一小段时间让两帧打印完，再同步读取成员值。
// 生产代码应等待可观察的完成条件（例如 stop/closed），不要依赖固定延时。
await new Promise((resolve) => setTimeout(resolve, 10));
// 同步读取成员当前值：derive 若被标脏会在这里重算；输出完整对象 { kinds, tasks }，而不是 delta。
console.log("member value:", chat.summary.value);

// 关闭顺序：先停 watch，再关 host；store 由应用自己创建，host 不会替应用关闭它。
// 4. Closing the host detaches the observers; the store is the app's.
// stop 幂等，先停止监听器并以 stopped 结束 watch；放在 host.close 之前可避免收到源结束产生的额外帧。
await watch.stop();
// 关闭宿主：detach 两个 follow 的观察者，触发 native 的 close 回调关闭 Harness，并结束 local 对象。
await host.close(context);
// 最后关闭应用自己的 store；:memory: 数据随连接关闭丢弃。
await store.close(context);
