import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, local, str } from "../../src/contracts/index.ts";
import { ChordError, type Principal } from "../../src/data/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import type { ChordHost } from "../../src/host/internal.ts";
import { Binding } from "../../src/host/reference.ts";
import { UnboundIndex, type UnboundRequest } from "../../src/host/unbound.ts";
import { UnboundClock } from "../../src/host/unbound-clock.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import { jsonPart } from "../../src/link/internal.ts";
import { Hold } from "../../src/remote/hold.ts";
import { constant } from "../../src/state/index.ts";
import {
	delivered,
	expectCollected,
	instancesOf,
	RawPeer,
	rejection,
	SERVER_ADDRESS,
	Server,
	type TestPrincipal,
	testCodec,
	transported,
} from "../support.ts";

// 拦截 Binding.release，弱引用记录被释放的本地绑定；后面的 GC 断言用它检查是否仍被强引用。
const bindings = instancesOf(Binding, "release");
// 同样记录远端 Hold.release 的实例；测试只保留 WeakRef，不主动阻止垃圾回收。
const holds = instancesOf(Hold, "release");

// 空 params 的本地契约由宿主长期持有；title 是字符串状态，工厂须返回 Watchable。
const Info = local("app.info", { version: 1, params: {}, members: { title: str() } });
// 带整数 id 的契约用于制造无人服务的请求；local 只表示位置在本宿主，并不自动注册提供方。
const Missing = local("app.missing", { version: 1, params: { id: int() }, members: { n: int() } });

/** A request recording its wakes and ends. */
// 创建记录唤醒和结束的假请求；输入可选 principal，返回同时满足请求接口与日志类型的对象。
// 例如 request({kind:"guest"}) 被 revoke 命中后记录 end revoked；它自身不删除索引，真实请求的 end 才会清理。
// ? 允许省略参数；& 为交叉类型；readonly 禁止替换 log 属性，但仍允许向数组 push。
function request(principal?: Principal): UnboundRequest & { readonly log: string[] } {
	// 每个假请求独有的字符串日志，供断言检查回调顺序。
	const log: string[] = [];
	// 返回属性简写 principal/log；wake 无输入并追加 wake，end 接收 ChordError 并记录其消息。
	// 箭头表达式的 push 实际返回数组长度，但请求接口只使用这些方法的副作用。
	return { principal, log, wake: () => log.push("wake"), end: (error) => log.push(`end ${error.message}`) };
}

// 注册直接针对 UnboundIndex 的三个同步用例；回调仅定义测试，实际索引操作在各 it 中运行。
describe("the index", () => {
	// 无参数测试：两个名称下加入三个请求、删除 b，再两次全量唤醒；预期只有 a/c 各收到一次 wake。
	it("wakes every request at the publication, out of the index first; a deleted one is not woken", () => {
		// 为本例创建独立索引及诊断时钟；空报告回调忽略诊断，undefined cause 不启动该计时。
		const index = new UnboundIndex(new UnboundClock(() => {}));
		// 数组解构取得三个不同请求，日志互不共享。
		const [a, b, c] = [request(), request(), request()];
		// 把 a 索引到 app.a；第三个参数 undefined 表示尚无失败原因，不开启 5 秒报告。
		index.add("app.a", a, undefined);
		// 同一名称可以同时等待多个请求，这里添加 b。
		index.add("app.a", b, undefined);
		// 把 c 放入另一个名称组，验证全量唤醒会跨名称处理。
		index.add("app.b", c, undefined);
		// 删除 b 的索引位置，之后的 publication 不应再调用它。
		index.delete("app.a", b);
		// 先清空索引并停止相关诊断时钟，再逐个调用 wake；再次调用时已无这些请求。
		index.wakeAll();
		// 逐个比较日志：a/c 被唤醒，b 没有；空数组表示没有回调。
		expect([a.log, b.log, c.log]).toEqual([["wake"], [], ["wake"]]);
		// Out of it: a second publication wakes nobody.
		// 先清空索引并停止相关诊断时钟，再逐个调用 wake；再次调用时已无这些请求。
		index.wakeAll();
		// 第二次唤醒后 a 仍只有一条日志，证明先前请求已移出索引。
		expect(a.log).toEqual(["wake"]);
	});

	// 按名称唤醒用例：只发布 a/c 并包含未知名称；b 应继续等待，后续单独发布 b 才唤醒。
	it("wakes the requests of the names a reload serves only (carry-over: publications wake per name)", () => {
		// 为本例创建独立索引及诊断时钟；空报告回调忽略诊断，undefined cause 不启动该计时。
		const index = new UnboundIndex(new UnboundClock(() => {}));
		// 数组解构取得三个不同请求，日志互不共享。
		const [a, b, c] = [request(), request(), request()];
		// 把 a 索引到 app.a；第三个参数 undefined 表示尚无失败原因，不开启 5 秒报告。
		index.add("app.a", a, undefined);
		// 把 b 放到 app.b，供后面检验未发布名称继续留在索引。
		index.add("app.b", b, undefined);
		// 把 c 放到 app.c，与 a 一起成为本次指定唤醒的目标。
		index.add("app.c", c, undefined);
		// 只提取这些名称下的请求；不存在的 app.unknown 被跳过。
		index.wake(["app.a", "app.c", "app.unknown"]);
		// 逐个比较日志：a/c 被唤醒，b 没有；空数组表示没有回调。
		expect([a.log, b.log, c.log]).toEqual([["wake"], [], ["wake"]]);
		// The others stay indexed until their own names are served.
		// 随后发布 b 的名称，唤醒之前留下的请求。
		index.wake(["app.b"]);
		// 确认 b 此时收到且仅收到一次 wake。
		expect(b.log).toEqual(["wake"]);
		// Woken out of the index: a later publication wakes none of them again.
		// 先清空索引并停止相关诊断时钟，再逐个调用 wake；再次调用时已无这些请求。
		index.wakeAll();
		// 全部移出后再 wakeAll，不应重复通知任何请求。
		expect([a.log, b.log, c.log]).toEqual([["wake"], ["wake"], ["wake"]]);
	});

	// 撤权和关闭用例：只撤销 guest，随后关闭索引；owner 与无 principal 的请求最后都收到 closed。
	it("ends the requests of a revoked principal only, and every request at the host's close", () => {
		// 为本例创建独立索引及诊断时钟；空报告回调忽略诊断，undefined cause 不启动该计时。
		const index = new UnboundIndex(new UnboundClock(() => {}));
		// 构造需要撤权的 guest 请求。
		const guest = request({ kind: "guest" });
		// 构造不被本次撤权命中的 owner 请求。
		const owner = request({ kind: "owner" });
		// 省略 principal，模拟没有调用者身份的请求。
		const own = request();
		// for...of 把三个对象分别加入同一个名称的集合，不复制请求本身。
		for (const each of [guest, owner, own]) index.add("app.a", each, undefined);
		// 构造撤权错误，用 code/reason 区分权限撤销和一般结束。
		const revoked = new ChordError({ code: "forbidden", reason: "revoked", message: "revoked" });
		// 谓词只选中 guest；索引对有 principal 的请求调用谓词，匹配时调用其 end。
		index.revoke((principal) => principal.kind === "guest", revoked);
		// 证明撤权只触及 guest；假请求记录日志但不模拟真实 end 的自删除。
		expect([guest.log, owner.log, own.log]).toEqual([["end revoked"], [], []]);
		// 清空剩余索引并结束其中请求；此假 guest 也仍在其中，但本断言只检查另两者。
		index.close(new ChordError({ code: "released", reason: "closed", message: "closed" }));
		// 检查 owner 和无身份请求都收到关闭通知。
		expect([owner.log, own.log]).toEqual([["end closed"], ["end closed"]]);
	});
});

// 注册公开 host API 的集成用例，观察索引对引用状态、释放和关闭的实际影响。
describe("references waiting in the index", () => {
	// 加载只服务 Info 的插件，再 hold Info/Missing；前者 live，后者 waiting，retry 不会凭空产生提供方。
	it("after the publication: a type served binds; one not served waits failed { waiting }", async () => {
		// 创建本例宿主，空 onError 明确忽略诊断；稍后显式关闭宿主清理资源。
		const host = createHost({ onError: () => {} });
		// 等待首次声明发布与启动屏障；数组中的 facet 设置声明提供方，不直接返回业务值。
		await host.load(
			// 名为 @test/a 的插件服务 Info；无参数工厂返回恒定 title="t" 的 watchable，没有额外外部效果。
			[{ name: "@test/a", facet: defineFacet((h) => h.serve(Info, () => ({ title: constant("t") }))) }],
			// 传入不会被本例主动取消的背景上下文，供异步操作与通知使用。
			context,
		);
		// hold 立即返回引用，之后由宿主激活已服务的 Info。
		const info = host.hold(Info, {}, context);
		// Missing 无提供方，请求会留在未绑定索引而不是被自动释放。
		const missing = host.hold(Missing, { id: 1 }, context);
		// 让出任务和微任务，让激活、结束与状态通知完成；没有推进诊断的五秒时限。
		await delivered();
		// 已服务且已激活的引用应可用。
		expect(info.state.value).toEqual({ kind: "live" });
		// 按部分字段比较未绑定引用的状态，下面明确列出失败种类与原因。
		expect(missing.state.value).toMatchObject({
			// 引用处于失败状态，但 cause.kind 才说明其是否等待、可重试或代码损坏。
			kind: "failed",
			// 无人服务属于 waiting：未来发布同名类型可能恢复，不是 broken。
			cause: { kind: "waiting", error: { code: "unavailable", message: "app.missing is not served here" } },
			// waiting 不用退避定时重试，因此没有计划重试时间。
			retryAt: undefined,
		});
		// A retry leaves it waiting: an event wakes it, nothing else.
		// 显式 retry 对此名称索引等待不启动无效轮询；需要提供方发布来唤醒。
		missing.retry();
		// 没有新的声明发布，请求继续等待。
		expect(missing.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		// 关闭宿主，结束引用、链路与尚在索引中的等待。
		await host.close(context);
		// 关闭是最终 ended，区别于可恢复的 waiting。
		expect(missing.state.value).toMatchObject({ kind: "ended", error: { reason: "closed" } });
	});

	// GC 用例：立即释放 hold，令 get 超时退出，再检查已释放 Binding 的弱引用可回收。
	it("leave nothing behind once released (GC)", async () => {
		// 创建本例宿主，空 onError 明确忽略诊断；稍后显式关闭宿主清理资源。
		const host = createHost({ onError: () => {} });
		// 发布空插件集合；此后 Missing 属于确知未服务，而不是等待首次发布。
		await host.load([], context);
		// 马上释放同步取得的引用，触发其索引删除与 Binding.release 记录。
		host.hold(Missing, { id: 2 }, context).release();
		// get 仅等 1 毫秒即放弃并释放；catch 消费预期拒绝，避免未处理 Promise。
		const got = host.get(Missing, { id: 3 }, context, { readyTimeout: 1 }).catch(() => {});
		// 等 get 完成清理后再检查垃圾回收。
		await got;
		// 展开弱引用数组给收集辅助函数；只证明本例被记录对象不再被强引用，不是整个宿主零分配。
		await expectCollected(...bindings);
		// 保留宿主自身存活，排除仅因宿主也被回收才释放 Binding 的情况。
		expect(host).toBeDefined();
	});

	// 制造阻塞 native 关闭的门闩；host.close 未完成时，未绑定 get/hold 就必须先以 closed 结束。
	it("end at the start of the host's close, not after its slow native closes (fix round 1, Sol 6)", async () => {
		// 空参数 Core 在加载时就激活，用它持有需要慢慢关闭的 native。
		const Core = local("app.core", { version: 1, params: {}, members: { n: int() } });
		// 取得一个 Promise 和手动 resolve 函数；<void> 只约束开发期的完成值，不增加运行时校验。
		const closeGate = Promise.withResolvers<void>();
		// 创建本例宿主，空 onError 明确忽略诊断；稍后显式关闭宿主清理资源。
		const host = createHost({ onError: () => {} });
		// 声明本例插件的 setup 回调，下一行只注册 Core 的工厂。
		const facet = defineFacet((h) =>
			// 工厂忽略空 params，使用 self 声明 native 和常量成员，不在工厂直接等待。
			h.serve(Core, (_, self) => {
				// 记录一个 native 的打开/关闭回调，实际打开在激活阶段执行。
				self.open(
					// 打开回调无参数依赖，异步返回数值 1 充当资源。
					async () => 1,
					// 关闭回调返回门闩 Promise，直到测试 resolve 前都不会完成。
					() => closeGate.promise,
				);
				// 工厂返回契约要求的 n watchable；数值 1 只是本例资源无关的状态。
				return { n: constant(1) };
			}),
		);
		// 等待 Core 首次激活结束，确保 native 的关闭回调稍后确实会被调用。
		await host.load([{ name: "@test/a", facet }], context);
		// 用 unknown 保存异步拒绝结果，要求使用方先检查才能按具体类型访问。
		let outcome: unknown;
		// rejection 把预期错误转为可断言值；then 收到该错误并写入观测变量，不阻塞本例继续关闭。
		void rejection(host.get(Missing, { id: 1 }, context)).then((error) => {
			// 将 get 的最终错误保存供后面的关闭时序断言。
			outcome = error;
		});
		// 保留另一个立即返回的等待引用，检查同步状态是否同样先结束。
		const held = host.hold(Missing, { id: 2 }, context);
		// 开始关闭但暂不 await，因为 native 关闭仍被 closeGate 挡住。
		const closing = host.close(context);
		// 让出任务和微任务，让激活、结束与状态通知完成；没有推进诊断的五秒时限。
		await delivered();
		// 即使 native 未关完，get 已经拒绝 closed。
		expect(outcome).toMatchObject({ code: "released", reason: "closed" });
		// hold 也已结束，不能拖到资源清理完成之后。
		expect(held.state.value).toMatchObject({ kind: "ended", error: { reason: "closed" } });
		// 放行 native 的关闭 Promise，使宿主清理可以收尾。
		closeGate.resolve();
		// 收回开始关闭时的 Promise，确保测试退出前清理完毕。
		await closing;
	});
});

// 注册链路上到达的远端 hold 用例：首次发布前也需要被索引和正确清理。
describe("holds waiting in the index", () => {
	/** A server not loaded yet, a raw consumer peer on a child link, and a hold of `app.missing` it sent. */
	// 创建尚未 load 的服务端和发送 Missing hold 的原始客户端；无输入，返回 host/peer/服务端链路。
	// 流程为建内存链路、accept、发送 hold、等待传输；例：early() 后只有 hello，load([]) 才发 failed。
	// 该辅助函数创建宿主和链路，调用者负责关闭；不会连接真实网络。
	async function early() {
		// 泛型限定本测试 principal 联合；Server() 指定可服务远端请求的地址，onError 忽略诊断。
		const host = createHost<TestPrincipal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		// 创建同进程内成对的 Link，a 给宿主，b 给原始消息替身。
		const [a, b] = memoryLinkPair();
		// 把子链路调用者固定为 owner，使用当前测试编码器；接收端不会信任子端自报身份。
		host.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		// 原始对端直接发送协议 Message，省去真实客户端对象，以精确控制首个 hold 的时机。
		const peer = new RawPeer(b);
		// 发送尚未发布时到达的 hold；下面字段是协议数据，不能由注释改变。
		peer.send({
			// 消息标签选择取得对象引用的协议分支。
			kind: "hold",
			// 此对端自行使用 hold 编号 0，回复时用同一编号关联。
			hold: 0,
			// 请求一个此宿主不会服务的类型名。
			type: "app.missing",
			// 声明调用者所持契约版本；本例尚无提供方可匹配。
			version: 1,
			// 提供格式合法的示例契约指纹；它是兼容性标识，不是认证凭证。
			fingerprint: "0123456789abcdef",
			// 把空 params 包成协议 Part；Missing 字符串此时没有服务方契约，不会套用上面的 local token 校验。
			params: jsonPart({}),
			// 目标地址指向本服务端，排除路由转发对等待行为的干扰。
			address: SERVER_ADDRESS,
		});
		// 让内存链路的多跳任务及关闭通知送达，再观察对端或宿主状态。
		await transported();
		// 把测试需要的三个句柄交还；属性 link 明确取服务端这一端 a。
		return { host, peer, link: a };
	}

	// 先用 early 在发布前发送 hold，再发布空集合；预期返回 waiting 且该 hold 仍计为一个引用。
	it("wait for the publication without a word, then are refused failed { waiting } and kept", async () => {
		// 等待原始 hold 到达，解构取得本例的宿主与对端。
		const { host, peer } = await early();
		// 首发声明前不拒绝该 hold；此时对端只收到握手 hello。
		expect(peer.kinds()).toEqual(["hello"]);
		// 发布空插件集合；此后 Missing 属于确知未服务，而不是等待首次发布。
		await host.load([], context);
		// 发布后确认 app.missing 无人服务，回复 failed/waiting，而不是结束 hold。
		expect(await peer.next("failed")).toMatchObject({ hold: 0, cause: { kind: "waiting" } });
		// 未绑定 hold 仍是活跃请求，计数保留到其持有者结束。
		expect(host.activity.value.references).toBe(1);
		// 关闭宿主，结束引用、链路与尚在索引中的等待。
		await host.close(context);
	});

	// 分别在发布前与拒绝后断开链路，验证引用计数归零，记录到的 Hold 均可回收。
	it("leave nothing behind once their link closed, before and after the publication (GC)", async () => {
		// 准备发布前断开的第一组。
		const before = await early();
		// 关闭服务端链路，删除仍在等首次声明的 hold。
		before.link.close();
		// 让内存链路的多跳任务及关闭通知送达，再观察对端或宿主状态。
		await transported();
		// 断开后再发布，不应重新唤醒已清理的请求。
		await before.host.load([], context);
		// 准备先发布再断开的第二组。
		const after = await early();
		// 这次先发布空声明，使请求进入未服务等待状态。
		await after.host.load([], context);
		// 确认拒绝消息已经发出，避免把本例退化为发布前关闭的重复测试。
		await after.peer.next("failed");
		// 关闭链路并等待后续任务清理该已拒绝 hold。
		after.link.close();
		// 让内存链路的多跳任务及关闭通知送达，再观察对端或宿主状态。
		await transported();
		// 两种时机下都没有残留活跃远端请求。
		expect([before.host.activity.value.references, after.host.activity.value.references]).toEqual([0, 0]);
		// 验证 release 记录的 Hold 弱引用可回收；辅助函数需要本机支持显式 GC。
		await expectCollected(...holds);
		// 宿主仍保留在本作用域，避免 GC 结果依赖整个宿主被丢弃。
		expect([before.host, after.host]).toBeDefined();
	});
});

// 注册测试工具使用的未服务名称枚举机制。
describe("what waits unserved (slice 12 §6, testPlugin)", () => {
	// 直接索引先加 b 后加 a，仍返回 a/b；再通过宿主内部接口确认未服务类型名。
	it("lists the index's names sorted, and the host the names no plugin serves", async () => {
		// 为本例创建独立索引及诊断时钟；空报告回调忽略诊断，undefined cause 不启动该计时。
		const index = new UnboundIndex(new UnboundClock(() => {}));
		// 先加入字典序靠后的名称，检验 names 并非仅按插入顺序返回。
		index.add("b", request(), undefined);
		// 再加入靠前名称。
		index.add("a", request(), undefined);
		// names 对名称排序，便于测试报告稳定比较。
		expect(index.names()).toEqual(["a", "b"]);
		// 创建本例宿主，空 onError 明确忽略诊断；稍后显式关闭宿主清理资源。
		const host = createHost({ onError: () => {} });
		// 等待首次声明发布与启动屏障；数组中的 facet 设置声明提供方，不直接返回业务值。
		await host.load(
			// 服务 Info 作为已知对照；常量工厂无 I/O，不服务 Missing。
			[{ name: "info", facet: defineFacet((h) => h.serve(Info, () => ({ title: constant("t") }))) }],
			// 传入不会被本例主动取消的背景上下文，供异步操作与通知使用。
			context,
		);
		// 创建唯一的未服务请求，使内部枚举有一个待等名称。
		const held = host.hold(Missing, { id: 1 }, context);
		// 让出任务和微任务，让激活、结束与状态通知完成；没有推进诊断的五秒时限。
		await delivered();
		// 测试知道运行时对象是 ChordHost，因此经 unknown 转内部类型访问诊断接口；断言本身不转换对象。
		expect((host as unknown as ChordHost).unservedNames()).toEqual(["app.missing"]);
		// 释放本例主动持有的引用，随后关闭宿主。
		held.release();
		// 关闭宿主，结束引用、链路与尚在索引中的等待。
		await host.close(context);
	});
});
