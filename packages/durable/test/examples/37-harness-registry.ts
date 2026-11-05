// 文件导读
// 所属：packages/durable/test/examples 的 37-harness-registry.ts，Durable 示例系列第 37 个，
// 演示“用 Chord 注册表把扩展与 Harness 接进对象系统”。
// 演示内容：Core 对象从 Extensions 注册表读取扩展并打开 Durable Harness，随后把 Harness 作为 native 贡献给
// Harnesses 注册表；Transcript 对象从该注册表取 Harness，跟随根会话视图并派生 kinds。Harness 的 Session 关闭时，
// 两个对象都失败；Core 重试打开新的 Harness，贡献变化唤醒 Transcript，它继续跟随新 Harness。
// greeter 与 copycat 两个插件声明同名任务，依表序先装的 copycat 生效，后到的 greeter 被拒绝并上报冲突。
// 上游入口：node 直接运行本文件；sqlite 用 :memory:，无网络；模型目录与注册表为空，不运行生成。
// 下游依赖：Chord 的 defineRegistry/createHost/defineFacet/local/method/registry/retryOn/follow/derive/contribute、
// Chord sqlite 的 openNodeSqliteDatabase，Durable 的 Harness/registryReader/store 存储/createRegistry/defineTask。
// 能力清单：两个注册表及各自的 compose；snapshotOf 的冲突处理；Core 的 registry 依赖、native、contribute、自跟随；
// Transcript 的 retryOn、follow、derive；Greet 任务与提交；同名扩展冲突；hold、方法调用、关闭与重试。
// 典型顺序：定义注册表 -> snapshotOf -> 契约 -> core facet -> Greet 与两个扩展 facet -> 打开 store ->
// createHost 并 load 三个 facet -> hold 两个对象 -> greet -> 读 transcript -> 关闭 Harness -> 观察失败 ->
// retry 后观察恢复 -> 关闭 host 与 store。
// 前置条件：Node 内置 sqlite 可用；无需 API key；hold 不等待绑定，所以用短暂延时观察异步激活。
// 预期输出（两行 object_failed 的先后可能互换；非 conflict 的通知后缀为空）：
// onError: registry_conflict Task example.greet of extension greeter is already installed
// onError: activation_failed
// greet: {"status":"completed","result":"hello"}
// transcript: [ 'example.greeted' ]
// onError: object_failed
// onError: object_failed
// close: example.harness: session closed
// transcript after the close: failed
// transcript after the retry: live [ 'example.greeted' ]
// 阅读顺序：先看两个注册表与 snapshotOf；再看 Core 的依赖、打开、贡献与自跟随；随后看 Transcript 的
// retryOn/follow/derive；最后看 Greet、冲突与关闭/重试的输出。
// A Durable harness in Chord objects, p3's pattern (Chord v2 slice 8): the object that opens Durable on the host's store
// takes its extensions from a Chord registry (`registryReader`), so any plugin extends the harness by contributing an
// extension; and it contributes its Harness to a second registry, through which another object follows its views
// (`self.follow`). When that Harness's Session closes, the follower fails and follows the next Harness, woken by its
// contribution (`self.retryOn`).
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/37-harness-registry.ts

import {
	// arr(str()) 是字符串数组 schema；Transcript 的 kinds 状态成员用它声明。
	arr,
	// createHost 建立 Chord 宿主，管理 facet 加载、对象激活、注册表合成与错误上报。
	createHost,
	// facet 在 host.load 时执行 setup；可以 serve 契约、serve 注册表 provider，或直接贡献注册表值。
	defineFacet,
	// defineRegistry 声明注册表 token：C 是贡献类型，V 是合成值类型；name/version 决定共享身份。
	defineRegistry,
	// local 声明同宿主对象；空 params 表示单实例，生命周期跨多次激活尝试。
	local,
	// method() 是无参无结果方法；method(undefined, str()) 是无参、字符串结果的方法。
	method,
	// Native<T> 是 self.open 的句柄类型；它也是 NativeWatchable<T>，但这里作为注册表的贡献值使用。
	type Native,
	// openStore 在 Chord store 后端上打开 store；宿主与 Durable 的提交共用它。
	openStore,
	// RegistryTable<C> 是 compose 看到的只读表，表项按 plugin 名（再按 type）排序。
	type RegistryTable,
	// sqliteBackend 把 sqlite 执行器包成 store 后端；示例用 :memory:。
	sqliteBackend,
	// str() 是字符串 schema，用于 Core 的方法结果与 Transcript 的数组元素。
	str,
} from "@earendil-works/chord";
// BACKGROUND_CONTEXT 是不带取消信号的根上下文；所有加载、调用与关闭都用它。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// Node 内置 sqlite 驱动；:memory: 表示进程内数据库。
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
// 空模型目录够用：示例不运行生成，只创建并执行一个任务。
import { createModels } from "@earendil-works/pi-ai";
import {
	// Durable 的 createRegistry 构造扩展注册表；snapshot() 产出 Harness 可读的 RegistrySnapshot。
	createRegistry,
	// defineExtension 包装扩展名与任务列表；两个 facet 各贡献一个扩展。
	defineExtension,
	// defineTask 声明任务定义：输入、状态、结果类型，以及 initial/phases/abort。
	defineTask,
	// Extension 是注册表的贡献类型 C；Extensions 的合成值 V 是 RegistrySnapshot。
	type Extension,
	// Harness 是 Durable 的会话入口；示例在同一 store 上先后打开两个 Harness 实例。
	Harness,
	// RegistrySnapshot 是 Durable 调度器读取扩展与任务的只读快照，由 registry.snapshot() 生成。
	type RegistrySnapshot,
	// ROOT_CONVERSATION_ID 是根会话的保留 ID；任务条目与 transcript 视图都指向它。
	ROOT_CONVERSATION_ID,
	// registryReader 把 Chord 注册表的合成值适配成 Durable 的 RegistryReader（snapshot + subscribe）。
	registryReader,
} from "../../src/index.ts";
// StoreStorage 让 Durable 的表与文档落在宿主 store 上；Harness 重启后数据仍在。
import { StoreStorage } from "../../src/storage/store/index.ts";

const context = BACKGROUND_CONTEXT;

// 1. The core's registries: extensions in, Durable's registry snapshot out; and the Harness, for other objects.
// Extensions：贡献 Extension，合成一个 Durable RegistrySnapshot。
// provider 由 core facet 的 compose 提供；贡献来自 greeter、copycat 两个 facet。
const Extensions = defineRegistry<Extension, RegistrySnapshot>("example.extensions", { version: 1 });
// Harnesses：贡献 Native<Harness>，合成当前 Harness（无贡献时为 undefined）。
// provider 的 compose 取表项最后一个并读取 native 的当前值。
const Harnesses = defineRegistry<Native<Harness>, Harness | undefined>("example.harnesses", { version: 1 });

// snapshotOf 把 Chord 注册表表项合成为 Durable 快照。
// 输入：table（已按 plugin 名排序的 RegistryEntry<Extension>[]）与 report 回调；
// 输出：RegistrySnapshot；副作用：新建一个 Durable 注册表并逐个 install，冲突时调用 report。
// 流程：createRegistry -> 遍历 {value, plugin} -> install 或 report -> snapshot()。
// 例：copycat 先装，greeter 因同名任务被拒，report({message, plugins:["greeter"]})，快照中只保留 copycat 的扩展。
/** Builds Durable's snapshot without throwing: an extension Durable refuses (a task name taken) is reported, left out. */
function snapshotOf(
	table: RegistryTable<Extension>,
	report: (conflict: { message: string; plugins: string[] }) => void,
) {
	// 每次合成都从空注册表开始，避免上一次合成的扩展残留；Durable 的内置任务由 createRegistry 自带。
	const registry = createRegistry();
	// 表项解构：value 是贡献的 Extension，plugin 是贡献者名；顺序由 Chord 按 plugin 名排序，与加载顺序无关。
	for (const { value, plugin } of table) {
		try {
			// install 校验扩展名替换与任务名唯一性；同名任务在此抛错。
			registry.install(value);
		} catch (error) {
			// catch 参数是 unknown；Durable 的 install 约定抛普通 Error，因此这里断言后读 message。
			// 被拒的扩展不进入快照，其他扩展继续安装。
			report({ message: (error as Error).message, plugins: [plugin] });
		}
	}
	return registry.snapshot();
}

// Core 契约：greet 无参、返回字符串；close 无参、返回 null。
const Core = local("example.harness", {
	version: 1,
	params: {},
	members: { greet: method(undefined, str()), close: method() },
});
// Transcript 契约只有一个状态成员 kinds（string[]）；工厂会用 derive 提供它。
const Transcript = local("example.transcript", { version: 1, params: {}, members: { kinds: arr(str()) } });

// 2. The core facet: the harness object opens Durable on the store with its extensions read from the registry.
// 内存 store 让示例自包含；Core 的 native 与 Transcript 的视图都落在同一个 store 上。
const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
// core facet 的 setup：serve 两个注册表的 provider，再 serve Core 对象。
const core = defineFacet((host) => {
	// serve 注册表 provider：compose 必须纯同步且总有返回值；冲突只通过 report 上报。
	// 表变化且有人读取/跟随时重新合成；抛错记为 registry_failed 并保留上次好值。
	host.serve(Extensions, { compose: (table, { report }) => snapshotOf(table, report) });
	// compose 取表项最后一个（plugin 名最大者）的 Native，再读它的当前值；空表得到 undefined。
	// 其余贡献者被忽略，示例约定只有一个 Core。
	host.serve(Harnesses, { compose: (table) => table.at(-1)?.value.value });
	// Core 的激活工厂；空 params 的对象身份用不到。
	host.serve(Core, (_, self) => {
		// A declared dependency: the object activates (and opens Durable) once the registry has a value.
		// 声明注册表依赖：provider 可用且合成值就绪后对象才继续激活；读取用 extensions.value。
		const extensions = self.registry(Extensions);
		// 声明 native：激活时打开，尝试结束时关闭；open 的 context 在放弃尝试时被取消。
		const harness = self.open(
			// 形参 open 是激活期 context，不是打开函数；它同时传给 StoreStorage.open 与 Harness.open。
			async (open) => {
				// 在宿主 store 上打开 Durable；registry 参数让 Harness 从 Chord 注册表取扩展快照。
				const opened = await Harness.open(
					// owner 用 Core.name（example.harness）：Durable 的表与文档命名空间都登记在这个 owner 下。
					await StoreStorage.open(store, Core.name, open),
					// registryReader 的 snapshot() 每次读当前合成值；subscribe() 跟随变化并只唤醒调度器。
					// 订阅生命周期绑定 open context，尝试结束即解除。
					{ models: createModels(), registry: registryReader(extensions, open) },
					open,
				);
				// 创建根会话；任务条目与 Transcript 的视图都围绕这个会话。
				await opened.root(open);
				return opened;
			},
			// 关闭回调：h 是已打开的 Harness，_reason 是 end/close/reload，close 是关闭用 context。
			(h, _reason, close) => h.close(close),
		);
		// 把 native 句柄贡献给 Harnesses：对象 live 期间存在，结束、失败或重启时撤回。
		// compose 读取 harness.value；贡献变化会重新合成并唤醒读者。
		self.contribute(Harnesses, harness);
		// Following its own task graph, the object fails with its Session (S1), and its retry opens the next Harness.
		// 跟随自己的任务图但不暴露为成员：目的是让本尝试与 Session 同生共死。
		// Session 关闭时观察者收到 failed("session closed")，本对象随尝试失败；重试会打开下一个 Harness。
		self.follow((observer, ctx) => harness.value.observeTaskGraph(observer, ctx));
		return {
			// greet 方法实现：确认任务已安装、在会话上创建任务、唤醒调度器、等待任务终态并打印结果。
			greet: async (ctx) => {
				// The composed snapshot, read at use: is the task's extension installed?
				// 在使用时读取合成快照；task(name) 查已安装任务。若两个扩展都冲突被拒，这里返回说明而不是创建任务。
				if (extensions.value.task(Greet.definition.name) === undefined) return "no greeter installed";
				// 取根会话句柄；root() 已在激活时创建，conversation 只打开已有会话。
				const root = await harness.value.conversation(ROOT_CONVERSATION_ID, ctx);
				// 一个提交内创建任务：输入 undefined，ownership 为 conversation；createTask 返回 TaskId。
				// 提交成功后任务记录与条目才可见。
				const id = await root!.commit(
					(tx) => tx.createTask(Greet, undefined, { ownership: { kind: "conversation" } }),
					ctx,
				);
				// 唤醒调度器，让刚创建的任务开始运行；waitForTask 也会 resume，这里显式调用以展示启动动作。
				harness.value.resume();
				// waitForTask 等到终态并返回 SettledTask；state.outcome 是任务的最终结果记录，序列化后打印。
				return JSON.stringify((await harness.value.waitForTask(id, ctx)).state.outcome);
			},
			// close 方法实现：关闭 Harness 的 Session；调用本身可能因对象随 Session 失败而 reject，由调用方捕获。
			close: async (ctx) => {
				// 关闭 Session 会结束任务图观察：Core 的 follow 收到 failed，尝试失败，native 关闭。
				await harness.value.close(ctx);
				return null;
			},
		};
	});
	// 3. Another object follows the harness's conversation view through the registry.
	// Transcript 的激活工厂：依赖 Harnesses 注册表，跟随当前 Harness 的会话视图。
	host.serve(Transcript, (_, self) => {
		// 声明注册表依赖；首次合成可能还没有贡献者，因此值为 undefined，但依赖本身是可用的。
		const harness = self.registry(Harnesses);
		// 注册表出现新值时重试本对象（包括当前激活失败后再试一次）；源自身失败不会唤醒。
		self.retryOn(harness);
		// 跟随根会话视图；Harness 尚未贡献时 harness.value 为 undefined，可选链返回 undefined，
		// self.follow 把“地址不存在”当作 unavailable，使本次激活 transient 失败（即输出中的 activation_failed）。
		const view = self.follow(async (observer, ctx) =>
			harness.value?.observeConversation(ROOT_CONVERSATION_ID, observer, ctx),
		);
		// kinds 状态成员由 derive 提供：把窗口内条目的 kind 投影成字符串数组；窗口默认最新 50 条、上限 100。
		// 激活期 compute 抛错会使尝试失败；live 后失败按 derive_failed 上报。
		return { kinds: self.derive([view], ([v]) => v.entries.map((entry) => entry.kind)) };
	});
});

// 4. Two plugins contribute extensions with the same task name, which Durable refuses: the first by plugin name
//    (copycat) is installed, the other reported.
// Greet 任务：输入 undefined、状态 {phase:"run"}、结果 string；phases 只有一个 run。
const Greet = defineTask<undefined, { phase: "run" }, string>({
	// 任务名是运行时的唯一身份；两个扩展都用它，因此第二次安装会冲突。
	name: "example.greet",
	version: 1,
	// 任务创建时的初始状态；run 阶段直接使用它。
	initial: () => ({ phase: "run" }),
	phases: {
		// run 阶段：runtime 提供任务内的提交与调用能力，taskContext 是本次运行上下文。
		run: async (_task, runtime, taskContext) => {
			// 任务的一个提交：追加条目与返回终态在同一个事务里，要么都生效要么都不生效。
			await runtime.commit(async (tx) => {
				// 向根会话追加显示条目；条目提交后会推进 Transcript 跟随的会话视图。
				await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "example.greeted", data: {} });
				// 返回终态结果；waitForTask 的 state.outcome 将得到 {status:"completed", result:"hello"}。
				return { status: "terminal", outcome: { status: "completed", result: "hello" } };
			}, taskContext);
		},
	},
	// abort 处理取消请求；示例任务很快完成，这里不做额外清理。
	abort: async () => {},
});
// greeter facet 直接贡献扩展；facet 的贡献在宿主生命周期内有效，无需 serve 对象。
const greeter = defineFacet((_, self) =>
	self.contribute(Extensions, defineExtension({ name: "greeter", tasks: [Greet] })),
);
// copycat 与 greeter 声明同名任务；按表序（plugin 名字典序）copycat 先安装，greeter 被拒。
const copycat = defineFacet((_, self) =>
	self.contribute(Extensions, defineExtension({ name: "copycat", tasks: [Greet] })),
);

// 创建宿主并接入 store；onError 收到 HostError（按 kind 判别的联合），这里只在冲突时打印 message。
const host = createHost({
	store,
	onError: (error) => console.log("onError:", error.kind, error.kind === "registry_conflict" ? error.message : ""),
});
// 加载三个 facet：core 提供注册表 provider 与两个对象，greeter/copycat 各贡献一个扩展。
// 加载顺序不影响注册表表序；表序按 plugin 名排序。
await host.load(
	[
		{ name: "@example/core", facet: core },
		{ name: "@example/greeter", facet: greeter },
		{ name: "@example/copycat", facet: copycat },
	],
	context,
);

// 5. The task comes from a contributed extension; the transcript object sees its entry. (It failed once at start, before
//    the harness object contributed its Harness: `activation_failed`, then the contribution woke it.)
// hold 立即返回引用，不等待绑定；activate 在后台进行，方法调用会排队到 live。
// 这样可以在对象尚未就绪（甚至首次激活失败）时先登记引用。
const harness = host.hold(Core, {}, context);
// Transcript 首次激活可能因 Harness 尚未贡献而失败；之后靠 retryOn 被唤醒。
const transcript = host.hold(Transcript, {}, context);
// 调用会等待 Core live 后执行：确认任务、创建任务、等待结果；输出终态 outcome 的 JSON。
console.log("greet:", await harness.greet(context));
// hold 不等待激活；这里给异步激活与 retry 留出时间，随后读取 Transcript 的成员值。
await new Promise((resolve) => setTimeout(resolve, 10));
// 读取状态成员当前值：应包含任务提交的 example.greeted 条目。
console.log("transcript:", transcript.kinds.value);

// 6. The Session closes: both objects fail; a retry of the harness object opens the next Harness (on the same store:
//    the transcript is still there), whose contribution wakes the follower.
// close 方法关闭 Session；Core 的 follow 随之失败，使这次调用以对象失败结束。
// catch 打印错误消息（带对象 label）；回调参数标注 Error 只是类型注解，运行时不做校验。
await harness.close(context).catch((error: Error) => console.log("close:", error.message));
// 等待对象失败状态传播完成，再读取 Transcript 的引用状态。
await new Promise((resolve) => setTimeout(resolve, 10));
// ref.state 是 NativeWatchable<RefState>；kind 为 loading/live/failed/ended，此处预期 failed。
console.log("transcript after the close:", transcript.state.value.kind);
// 对失败的 Core 请求立即重试：重新激活、在同一 store 上打开新 Harness、再次贡献 Harness 注册表。
harness.retry();
// 等待重试的激活链完成：Core live -> 贡献 -> Harnesses 重新合成 -> Transcript 被唤醒并 live。
await new Promise((resolve) => setTimeout(resolve, 50));
// 预期输出 live 与 [ 'example.greeted' ]：新 Harness 读同一 store 的根会话，历史条目仍在。
console.log("transcript after the retry:", transcript.state.value.kind, transcript.kinds.value);

// 关闭宿主：结束两个 local 对象、关闭各自 native，并释放注册表贡献。
await host.close(context);
// 最后关闭应用自己的 store；:memory: 数据随之丢弃。
await store.close(context);
