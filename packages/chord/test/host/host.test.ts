// 文件导读
//
// 所属包与功能模块：packages/chord 的 host 层测试（设计 §3 宿主、§4 principal、§6 对象生命周期、§7 引用、§19 presence、
// §21 重载；slice 7b 的重载规范）。host.test.ts 是 createHost() 返回的 Host 的“行为契约”测试：它通过公开 API 与
// 裸链接协议观察宿主，而不是直接调用内部方法。
//
// 本文件解决什么问题：把设计里的时序规则变成可执行断言——load 的启动屏障、get/hold 的等待与失败分类、close 的
// 逆序拆卸、跨宿主启动的依赖模型、principal 身份、注册表、reload 的 staging/commit/各对象 fate。职责边界：对象状态机
// 细节在 object.test.ts，引用绑定在 reference.test.ts，链接编解码在 link/remote 测试；这里只覆盖“宿主编排”。
// 上游入口：应用调用 createHost -> route -> load -> get/hold/registry/root -> reload -> close（见 host.ts 文件头）。
// 下游依赖：host.ts（ChordHost/load/#hold/#place/#reload/close）、staging.ts（插件声明）、object.ts（ChordObject）、
// reference.ts（Binding/Held）、remote（HostLink/RemoteObject/RawPeer 协议）、store（SQLite 后端）。
// 结果与错误流向：同步错误用 expect(...).toThrow / rejection() 捕获；后台错误进入 onError（本文件常收集到 errors 数组）；
// ChordError 用 code/reason 断言，普通 Error 用 message 断言。
//
// 测试夹具/假实现（来自 ../support.ts，除特别说明外都使用真实宿主与内存链接）：
// - loaded(setup, options)：创建一个 host 并 load 一个名为 "@test/app" 的 facet，返回 { host, errors, failed }。
// - linked(setup, options)：server 有地址/principal，client 通过 memoryLinkPair 连接；可指定 child principal。
// - relayed(options)：tab/server/worker 三宿主与路由，用于跨宿主依赖与 reload 顺序。
// - RawPeer：直接发/收链接协议消息的裸对端，绕过 API 以观察 hold/bound/failed 帧。
// - memoryLinkPair/transported/flushed：内存链路与“排空微任务/六跳传输”的同步点。
// - fakeTimers()：在每个用例前后启用/恢复假时钟，只伪造 setTimeout/clearTimeout/Date。
// - faultyStore/memoryStore：注入 COMMIT/BEGIN 失败的存储与内存 SQLite 存储。
// - serveNotes/Notes/PlacedNotes/Session/Server/SERVER_ADDRESS：远程笔记契约与宿主地址。
//
// 覆盖的主要行为分组：
// 1. load：声明校验、重复插件/类型、非法名称、load 前调用 not_ready。
// 2. the start barrier：激活的首次结局、readyTimeout 放弃、局部/远程阻塞者、close 结算。
// 3. startup across hosts：三宿主无死锁启动、发布前到达的 hold、backoff 顺序。
// 4. get / deadlines of gets：契约匹配、参数校验、单 getter 截止时间。
// 5. close 及其顺序/竞态：逆序结束、并发调用失败、挂起 open、后台关闭、依赖先关。
// 6. getters / principals / where a reference goes：取消、principal 身份、跨链接放置、connect 单父链接。
// 7. registry/store/provider 自身检查/load 失败隔离。
// 8. acquiring hold/get：瞬态重试、broken、取消上下文、host.close。
// 9. reload：API 串行/abort、commit 的注册表与 presence、跨宿主顺序、staging 中 abort。
//
// 运行命令（在 packages/chord 目录下）：
//   node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/host/host.test.ts
// 本文件不启动 Node 子进程也不做 esbuild 打包，通常可直接从源码运行；若仓库要求 dist/ 的用例不在本文件。
//
// 典型示例（真实 API，不是额外运行时行为）：
//   const host = createHost({ onError: (e) => errors.push(e) });
//   await host.load([{ name: "@app/info", facet: defineFacet((h) => h.serve(Info, () => ({ title: constant("t") }))) }], context);
//   const ref = await host.get(Info, {}, context);      // 等对象 live
//   ref.release();
//   await host.close(context);                          // 先结算链接/根作用域，再逆序结束对象
//
// 建议阅读顺序：先看本文件顶部的契约定义（Info/Counter/Page/Svc/Core）与 serveGated -> load -> start barrier ->
// get/deadlines -> close（理解生命周期）-> principals/where a reference goes（理解链接与身份）-> acquiring ->
// reload 三组（先 API，再 commit，再跨宿主）-> store 与错误注入用例。遇到 statesOf/failures/rejection 等辅助函数，
// 先回 ../support.ts 确认它们只做形状整理，不改变被测行为。
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal, withCancel } from "../../src/context/index.ts";
import { evolve, hostKind, int, local, method, obj, remote, str } from "../../src/contracts/index.ts";
import { broken } from "../../src/data/index.ts";
import { type Ctx, createHost, defineFacet, type FacetHost, type HostError, type Self } from "../../src/host/index.ts";
import type { ChordHost } from "../../src/host/internal.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import { jsonPart } from "../../src/link/internal.ts";
import { defineRegistry } from "../../src/registries/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { constant } from "../../src/state/index.ts";
import { sqliteBackend } from "../../src/store/backend.ts";
import type { StagedWrite } from "../../src/store/step.ts";
import { type ChordStore, openStore } from "../../src/store/store.ts";
import {
	failures,
	fakeTimers,
	faultyStore,
	flushed,
	forEachCodec,
	linked,
	loaded,
	Notes,
	PlacedNotes,
	partValue,
	RawPeer,
	rejection,
	relayed,
	SERVER_ADDRESS,
	Server,
	Session,
	serveNotes,
	statesOf,
	type TestPrincipal,
	testCodec,
	transported,
} from "../support.ts";

// 五个本地契约（local）：没有 hostAddress，因此只能在服务它们的宿主内部出现，不会跨链接。
// 字段说明（类型来自 contracts 的 DSL，运行时会计算 fingerprint 并在 get/hold 时校验版本/形状）：
// - Info：空参数，一个只读 state title；最常用的最小对象。
// - Counter：空参数，count 状态 + bump 方法；用于 close 期间调用失败的用例。
// - Page：参数 { id }; 成员 id；用于参数校验与多实例。
// - Svc：参数 { id }; 成员 n；用于 open/close 生命周期与重试。
// - Core：空参数；常作为“必然失败/依赖”的对象。
const Info = local("app.info", { version: 1, params: {}, members: { title: str() } });
const Counter = local("app.counter", { version: 1, params: {}, members: { count: int(), bump: method() } });
const Page = local("app.page", { version: 1, params: { id: int() }, members: { id: int() } });
const Svc = local("app.svc", { version: 1, params: { id: int() }, members: { n: int() } });
const Core = local("app.core", { version: 1, params: {}, members: { n: int() } });

// 所有宿主共享一个空 onError：不需要观察后台错误的分组使用它，避免每个用例重复写回调。
// 注意这是模块级对象，但只含函数、无状态，多个宿主复用不会互相影响。
const noErrors = { onError: () => {} };

/** Serves `Svc`: one native whose open waits for `gate` and whose close records its value and reason in `closes`. */
// serveGated：可控制的 Svc 工厂。open 是 native 资源；它会挂起直到测试 resolve gate，用于制造“正在激活/关闭”的窗口。
// 输入：facet host、gate Promise、closes 记录数组；输出：无（副作用是 serve 与向 closes 追加字符串）。
// 错误路径：gate 本身不 reject（测试只用 resolve）；若 open 抛错则对象进入失败分类，由调用用例另行断言。
// 示例：const gate = Promise.withResolvers<void>(); serveGated(h, gate.promise, closes); gate.resolve();
function serveGated(h: FacetHost, gate: Promise<void>, closes: string[]): void {
	// serve(类型, factory)：factory 的参数是校验后的 params 与 self（声明 native/引用/派生的句柄）。
	h.serve(Svc, ({ id }, self) => {
		// self.open(value, close)：value 在 gate 后返回；close 收到最终 value 与结束原因（close/end/reload...）。
		// void 运算符只是丢弃 push 的返回值，明确表示不关心。
		self.open(
			async () => {
				await gate;
				return `svc ${id}`;
			},
			(value, reason) => void closes.push(`${value} ${reason.kind}`),
		);
		// 工厂同步返回对象成员；n 是常量 state，不依赖 native 是否已打开。
		return { n: constant(id) };
	});
}

// load 分组：验证“插件 setup + 发布 + 空参数对象首次结局”这一启动流程的声明校验与幂等性。
// 这些用例大多不启用假时钟，因为它们不等待超时；需要计时的用例会单独 fakeTimers。
describe("load", () => {
	// 第一个用例建立基本事实：setup 只运行一次；空参数类型会被立即激活（factory 被调用），带参数类型不会。
	// vi.fn() 是包装函数，可记录调用次数；factories.page 没有被调用，因为 Page 有必填参数 id，load 不会凭空造参数。
	it("runs every setup and activates the types with empty params before it resolves", async () => {
		const factories = { info: vi.fn(() => ({ title: constant("t") })), page: vi.fn() };
		const facet = defineFacet((host) => {
			host.serve(Info, factories.info);
			host.serve(Page, factories.page);
		});
		const host = createHost(noErrors);
		await host.load([{ name: "@app/info", facet }], context);
		expect(factories.info).toHaveBeenCalledTimes(1);
		expect(factories.page).not.toHaveBeenCalled();
		await host.close(context);
	});

	// 重复名称/重复服务：后出现的插件被排除，报告包含插件名与原始错误消息；load 只能调用一次。
	it("leaves out and reports duplicate plugin names and double serves (the later); refuses a second load", async () => {
		const empty = defineFacet(() => {});
		const info = defineFacet((host) => host.serve(Info, () => ({ title: constant("t") })));
		// 局部辅助函数 loaded：每个场景新建宿主、load、关闭，并把 failed 规整成 [plugin, message] 元组方便断言。
		// facets 的元素类型复用 empty 的 facet 类型；defineFacet 的返回值携带宿主 principal 泛型。
		const loaded = async (facets: { readonly name: string; readonly facet: typeof empty }[]) => {
			const host = createHost(noErrors);
			const { failed } = await host.load(facets, context);
			await host.close(context);
			return failed.map(({ plugin, error }) => [plugin, (error as Error).message]);
		};
		const twice = [
			{ name: "a", facet: empty },
			{ name: "a", facet: empty },
		];
		expect(await loaded(twice)).toEqual([["a", 'plugin "a" is loaded twice']]);
		const throwing = defineFacet(() => {
			throw new Error("first failed");
		});
		// The first one's setup failing does not make the second one's name free (Sol).
		// 关键顺序：先记录“a 的 setup 失败”，仍把第二个 a 判为重复——名称占用发生在 setup 之前。
		const failing = createHost(noErrors);
		const report = await failing.load(
			[
				{ name: "a", facet: throwing },
				{ name: "a", facet: info },
			],
			context,
		);
		// 两条失败按声明顺序出现；第二条的错误由名称检查产生，而不是 setup。
		expect(report.failed.map(({ plugin, error }) => [plugin, (error as Error).message])).toEqual([
			["a", 'plugin "a": first failed'],
			["a", 'plugin "a" is loaded twice'],
		]);
		// 两个 a 都没能发布 Info，所以 hold 得到 failed（等待提供者），而不是抛错。
		expect(failing.hold(Info, {}, context).state.value).toMatchObject({ kind: "failed" });
		await failing.close(context);
		// 不同插件名服务同一类型：后一个（b）被排除，错误里指出先服务它的插件 a。
		const served = [
			{ name: "a", facet: info },
			{ name: "b", facet: info },
		];
		expect(await loaded(served)).toEqual([["b", 'plugin "b": app.info is served twice (plugin "a")']]);
		const host = createHost(noErrors);
		await host.load([], context);
		// load 是一次性操作；第二次调用返回 rejected Promise，消息明确提示每个宿主只 load 一次。
		await expect(host.load([], context)).rejects.toThrow("load runs once per host");
	});

	// 插件名必须是 npm 包名格式（@scope/name 或 name）；非法名在 staging 前同步抛错，保证“失败不改变状态”。
	// 注意 load 的异步签名：名字检查发生在返回 Promise 之前，所以这里用 rejects.toThrow 也能捕获；
	// 对 reload 则用同步 expect(...).toThrow，因为 reload 的同步前置检查直接抛出。
	it("throws for an invalid plugin name before it changes anything; the host loads afterwards (decision (d))", async () => {
		const empty = defineFacet(() => {});
		const info = defineFacet((h) => h.serve(Info, () => ({ title: constant("t") })));
		const host = createHost(noErrors);
		await expect(
			host.load(
				[
					{ name: "@app/info", facet: info },
					{ name: "tui:core", facet: empty },
				],
				context,
			),
		).rejects.toThrow('"tui:core" is not a valid plugin name');
		// Nothing was staged or published: the same host loads the fixed set.
		expect(await host.load([{ name: "@app/info", facet: info }], context)).toEqual({ failed: [] });
		expect(() => host.reload([{ name: "Bad Name", facet: empty }], context)).toThrow(
			'"Bad Name" is not a valid plugin name',
		);
		// The reload changed nothing: the loaded plugin still serves.
		expect((await host.get(Info, {}, context)).title.value).toBe("t");
		await host.close(context);
	});

	// 启动前的 API 屏障：get/registry 返回 rejected Promise（异步 API），hold 同步抛错（它没有 Promise 可拒绝），
	// root 内的 ctx.get 延迟到回调执行时才失败。错误消息统一附带修复建议。
	it("is called first: get, hold, registry and a root's ctx.get throw not_ready before it (decision (a))", async () => {
		// 一个没有任何提供者的注册表；这里只测“load 前”的 not_ready，与是否有提供者无关。
		const Names = defineRegistry<string, readonly string[]>("app.names", { version: 1 });
		const host = createHost(noErrors);
		const fix = "the host has not loaded; call host.load first (a host with nothing to load calls load([]))";
		await expect(host.get(Info, {}, context)).rejects.toMatchObject({
			code: "not_ready",
			message: `app.info: ${fix}`,
		});
		expect(() => host.hold(Info, {}, context)).toThrow(`app.info: ${fix}`);
		await expect(host.registry(Names, context)).rejects.toMatchObject({
			code: "not_ready",
			message: `registry app.names: ${fix}`,
		});
		await expect(host.root((ctx) => ctx.get(Info, {}), context)).rejects.toMatchObject({ code: "not_ready" });
		// A client with nothing to load calls `load([])`: then its requests wait as any does.
		await host.load([], context);
		expect(host.hold(Info, {}, context).state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		await host.close(context);
	});
});

// 启动屏障（design decision (a)）：host.load() 不是“工厂返回即完成”，而是等每个空参数对象的“首次结局”：
// live、因自身原因失败、或因为一个此处仍无结局的阻塞者而 parked。组内统一启用假时钟，因为 backoff/readyTimeout
// 都依赖定时器；vi.advanceTimersByTimeAsync 会推进定时器并排空由此产生的微任务。
describe("the start barrier", () => {
	fakeTimers();

	// 第一次激活瞬时失败（transient），宿主把它报告到 onError，并按 backoff 重试；第二个 get 在推进 1s 后拿到 live。
	// attempts 在工厂内自增，证明对象被重建而不是复用第一次失败的实例。
	it("resolves once every host-lifetime object had its first outcome; a failed one is reported and retried", async () => {
		let attempts = 0;
		const { host, errors } = await loaded((h) => {
			h.serve(Info, () => ({ title: constant("t") }));
			h.serve(Counter, (_, self) => {
				const attempt = ++attempts;
				self.open(
					async () => {
						if (attempt === 1) throw new Error("offline");
						return null;
					},
					() => {},
				);
				return { count: constant(attempt), bump: async () => null };
			});
		});
		expect(failures(errors)).toEqual(["app.counter: transient"]);
		const counter = host.get(Counter, {}, context);
		await vi.advanceTimersByTimeAsync(1000);
		expect((await counter).count.value).toBe(2);
	});

	// 永不 resolve 的 open 不会永久卡住 load：激活尝试在 readyTimeout（这里 100ms）后被放弃，load 结束。
	// 断言用 99ms/1ms 两个边界点，精确验证截止时间，而不是“过一会儿就好了”。
	it("is not held by a hanging open: its attempt is abandoned at readyTimeout", async () => {
		const host = createHost({ ...noErrors, readyTimeout: 100 });
		const facet = defineFacet((h) =>
			h.serve(Info, (_, self) => {
				self.open(
					() => new Promise(() => {}),
					() => {},
				);
				return { title: constant("t") };
			}),
		);
		let done = false;
		void host.load([{ name: "a", facet }], context).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(99);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(done).toBe(true);
	});

	// 局部依赖（CodeMode 在工厂里 self.get(Harness)）会让 CodeMode 进入 waiting；屏障不会把它当作“已有结局”，
	// 而是继续等 Harness 的首次结局。Promise.withResolvers 提供手动控制的 open。
	it("waits for a local blocker's first outcome: a host object parked on another one here (CodeMode → Harness)", async () => {
		const Harness = local("app.harness", { version: 1, params: {}, members: { n: int() } });
		const CodeMode = local("app.codemode", { version: 1, params: {}, members: { n: int() } });
		const opened = Promise.withResolvers<void>();
		const host = createHost(noErrors);
		const facet = defineFacet((h) => {
			h.serve(Harness, (_, self) => {
				self.open(
					() => opened.promise,
					() => {},
				);
				return { n: constant(1) };
			});
			h.serve(CodeMode, (_, self) => ({ n: self.get(Harness, {}).n }));
		});
		let done = false;
		const loading = host.load([{ name: "@app/core", facet }], context).then(() => {
			done = true;
		});
		await flushed();
		expect(done).toBe(false);
		opened.resolve();
		await loading;
		expect(host.hold(CodeMode, {}, context).state.value).toEqual({ kind: "live" });
	});

	// 阻塞者自身失败（transient）也是一种“首次结局”：屏障随之结束，依赖者保持 failed { waiting }，
	// 错误消息串联成 "waiting for app.harness: app.harness: offline"，便于定位根因。
	it("ends its pass at a local blocker's own failure: the dependent parked failed { waiting } has its first outcome", async () => {
		const Harness = local("app.harness", { version: 1, params: {}, members: { n: int() } });
		const CodeMode = local("app.codemode", { version: 1, params: {}, members: { n: int() } });
		const { host, errors } = await loaded((h) => {
			h.serve(Harness, (_, self) => {
				self.open(
					async () => {
						throw new Error("offline");
					},
					() => {},
				);
				return { n: constant(1) };
			});
			h.serve(CodeMode, (_, self) => ({ n: self.get(Harness, {}).n }));
		});
		expect(failures(errors)).toEqual(["app.harness: transient"]);
		expect(host.hold(CodeMode, {}, context).state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { message: "waiting for app.harness: app.harness: offline" } },
		});
	});

	// 远程依赖没有本地首次结局可等：一旦发往父链接的 hold 被发出，屏障就以 loading 作为该对象的首次结局，
	// 避免跨宿主互相等待造成启动死锁。RawPeer 用来确认父链接确实收到了 hold。
	it("ends its pass at a remote blocker: a wait on another host is a first outcome", async () => {
		const CodeMode = local("app.codemode", { version: 1, params: {}, members: { n: int() } });
		const host = createHost<TestPrincipal>(noErrors);
		const [a, b] = memoryLinkPair();
		host.connect(a, { principal: { kind: "server" }, codec: testCodec() }, context);
		const parent = new RawPeer(b);
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(CodeMode, (_, self) => ({ n: self.get(Notes, { session: "S1" }).count })),
		);
		await host.load([{ name: "@app/codemode", facet }], context);
		expect(await parent.next("hold")).toMatchObject({ type: Notes.name });
		expect(host.hold(CodeMode, {}, context).state.value).toEqual({ kind: "loading" });
	});

	// close 与屏障竞态：一个 open 永远不完成的对象在 close 时被结束；“ended”也算首次结局，因此 load 不会悬空。
	it("is settled by host.close: an object of its cohort that ends before its first outcome settles it as ended", async () => {
		const host = createHost(noErrors);
		const facet = defineFacet((h) =>
			h.serve(Info, (_, self) => {
				self.open(
					() => new Promise(() => {}),
					() => {},
				);
				return { title: constant("t") };
			}),
		);
		let done = false;
		const loading = host.load([{ name: "a", facet }], context).then(() => {
			done = true;
		});
		await flushed();
		expect(done).toBe(false);
		await host.close(context);
		await loading;
		expect(done).toBe(true);
	});

	// 传递依赖链：Middle 既等 Missing（永不出现，waiting）也等 Slow（还在首次尝试中）。屏障必须继续等 Slow 的
	// 首次结局，而不是看到 Middle 已 waiting 就提前结束。gate 控制 Slow 的 open。
	it("waits for a local blocker parked failed { waiting } on one still in its first attempt (fix round 1, Sol 4)", async () => {
		const Core = local("app.core", { version: 1, params: {}, members: { n: int() } });
		const Middle = local("app.middle", { version: 1, params: { id: int() }, members: { n: int() } });
		const Slow = local("app.slow", { version: 1, params: { id: int() }, members: { n: int() } });
		const Missing = local("app.missing", { version: 1, params: {}, members: { n: int() } });
		const gate = Promise.withResolvers<void>();
		const host = createHost(noErrors);
		const facet = defineFacet((h) => {
			h.serve(Slow, (_, self) => {
				self.open(
					() => gate.promise,
					() => {},
				);
				return { n: constant(1) };
			});
			h.serve(Middle, ({ id }, self) => {
				const slow = self.get(Slow, { id });
				self.get(Missing, {});
				return { n: slow.n };
			});
			h.serve(Core, (_, self) => ({ n: self.get(Middle, { id: 1 }).n }));
		});
		let done = false;
		const loading = host.load([{ name: "@app/core", facet }], context).then(() => {
			done = true;
		});
		await flushed();
		expect(host.hold(Middle, { id: 1 }, context).state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting" },
		});
		expect(done).toBe(false);
		gate.resolve();
		await loading;
		await host.close(context);
	});

	// 同一依赖图，但声明顺序相反（A 先声明并等 B，B 声明在后）；屏障结果不受声明顺序影响。
	// premature 在释放 gate 前记录，若屏障提前结束就会是 true，从而抓住时序回归。
	it("waits for it whichever it declares first (fix round 1, Astra 3)", async () => {
		const A = local("app.a", { version: 1, params: {}, members: {} });
		const B = local("app.b", { version: 1, params: { id: int() }, members: {} });
		const Slow = local("app.slow", { version: 1, params: { id: int() }, members: {} });
		const Missing = local("app.missing", { version: 1, params: {}, members: {} });
		const gate = Promise.withResolvers<void>();
		const host = createHost(noErrors);
		const facet = defineFacet((h) => {
			h.serve(A, (_, self) => {
				self.get(B, { id: 1 });
				return {};
			});
			h.serve(B, (_, self) => {
				self.get(Missing, {});
				self.get(Slow, { id: 1 });
				return {};
			});
			h.serve(Slow, (_, self) => {
				self.open(
					() => gate.promise,
					() => {},
				);
				return {};
			});
		});
		let done = false;
		const loading = host.load([{ name: "@app/a", facet }], context).then(() => {
			done = true;
		});
		await flushed();
		const premature = done;
		gate.resolve();
		await loading;
		await host.close(context);
		expect(premature).toBe(false);
	});
});

// 跨宿主启动（design §6 依赖模型）：多个宿主通过 remote 类型互相等待时，启动屏障必须只依赖“首次结局”，
// 不能等待对方的最终 live，否则环形依赖会死锁。组内启用假时钟但不主动推进，证明正确实现不需要超时兜底。
describe("startup across hosts (dependency model §6)", () => {
	// Timers never advance: nothing here may wait for a deadline.
	// 注释即约束：若某个实现靠定时器“猜”依赖已完成，这个组会因定时器不推进而失败。
	fakeTimers();

	/** On the server, waiting for a worker's `Agent`. */
	const Bootstrap = local("app.bootstrap", { version: 1, params: {}, members: { n: int() } });
	/** On worker S1, waiting for the server's `Catalog`. */
	const Agent = remote("app.agent", {
		version: 1,
		params: { session: str() },
		hostAddress: ({ session }) => Session({ id: session }),
		variants: { v: { state: { n: int() } } },
	});
	const Catalog = remote("app.catalog", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		variants: { v: { state: { n: int() } } },
	});

	// 场景：server 的 Bootstrap 等 worker 的 Agent，worker 的 Agent 等 server 的 Catalog——若双方 load 都要等
	// 对方 live，就会死锁。relayed() 的实际启动顺序由测试框架控制；两次 transported() 排空六跳链路消息后，
	// Bootstrap 必须是 live，且双方 onError 都为空。这是“无环依赖图不需要超时”的回归测试。
	it("starts two hosts that would have deadlocked (Sol's probe): an acyclic graph needs no timeout", async () => {
		const { server, errors } = await relayed({
			server: (h) => {
				h.serve(Bootstrap, (_, self) => ({ n: self.get(Agent, { session: "S1" }).n }));
				h.serve(Catalog, () => ({ variant: "v", members: { n: constant(7) } }));
			},
			worker: (h) => {
				// The worker's own host object waits for the server's catalog during the worker's load.
				h.serve(Agent, (_params, _principal, self) => ({ variant: "v", members: { n: self.get(Catalog, {}).n } }));
			},
		});
		await transported();
		await transported();
		const bootstrap = server.hold(Bootstrap, {}, context);
		expect(bootstrap.state.value).toEqual({ kind: "live" });
		expect(bootstrap.n.value).toBe(7);
		expect([errors.server, errors.worker]).toEqual([[], []]);
	});

	// 发布前到达的 hold：宿主尚未 load，但 hold 明确指向本机地址且类型也由本机插件服务。它必须被暂存在本地，
	// 发布后绑定给子链接，而不能被转发给父链接。child.next("bound") 观察绑定；parent.kinds() 只有 hello，
	// 证明父链接没有收到多余消息。
	it("places a hold arriving before the publication here, not over the parent", async () => {
		const worker = createHost<TestPrincipal>({
			address: Session({ id: "S1" }),
			principal: { kind: "worker", session: "S1" },
			...noErrors,
		});
		const [a, b] = memoryLinkPair();
		worker.connect(a, { principal: { kind: "server" }, codec: testCodec() }, context);
		const parent = new RawPeer(b);
		const [c, d] = memoryLinkPair();
		worker.accept(c, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const child = new RawPeer(d);
		child.send({
			kind: "hold",
			hold: 0,
			type: PlacedNotes.name,
			version: PlacedNotes.version,
			fingerprint: PlacedNotes.fingerprint,
			params: jsonPart({ session: "S1" }),
			address: { kind: "session", params: { id: "S1" } },
		});
		await transported();
		await worker.load(
			[{ name: "@test/w", facet: defineFacet<TestPrincipal>((h) => serveNotes(h, PlacedNotes)) }],
			context,
		);
		expect((await child.next("bound")).holds[0]).toMatchObject({ hold: 0 });
		expect(parent.kinds()).toEqual(["hello"]);
	});

	// 三宿主唤醒链：tab 的 Chat 等 worker，worker 的 Chat 等 server 的 Catalog；Catalog 首次激活失败后按 1s backoff
	// 重试。断言顺序是 catalog 先 live、chat 后 live，且失败原因（offline）逐层传给 tab。唯一的定时器是 Catalog
	// 自己退避窗口的 1s，证明链路本身不引入额外等待。
	it("wakes a parked chain over three hosts in order, its causes passed on (tab → worker → server)", async () => {
		const Chat = remote("app.chat", {
			version: 1,
			params: { session: str() },
			hostAddress: ({ session }) => Session({ id: session }),
			variants: { v: { state: { n: int() } } },
		});
		const order: string[] = [];
		let catalogs = 0;
		const { tab } = await relayed({
			server: (h) =>
				h.serve(Catalog, (_params, _principal, self) => {
					const attempt = ++catalogs;
					self.open(
						async () => {
							if (attempt === 1) throw new Error("offline");
						},
						() => {},
					);
					self.onLive(async () => void order.push("catalog"));
					return { variant: "v", members: { n: constant(attempt) } };
				}),
			worker: (h) =>
				h.serve(Chat, (_params, _principal, self) => {
					const catalog = self.get(Catalog, {});
					self.onLive(async () => void order.push("chat"));
					return { variant: "v", members: { n: catalog.n } };
				}),
		});
		const view = tab.hold(Chat, { session: "S1" }, context);
		for (let round = 0; round < 5; round++) await transported();
		expect(view.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { message: "waiting for app.catalog: app.catalog: offline" } },
			retryAt: undefined,
		});
		// The catalog's own backoff (1 s) is the only timer: it retries, and the chain goes on in order.
		await vi.advanceTimersByTimeAsync(1_000);
		for (let round = 0; round < 5; round++) await transported();
		expect(view.state.value).toEqual({ kind: "live" });
		expect(order).toEqual(["catalog", "chat"]);
		expect(view.n.value).toBe(2);
	});
});

// get 分组：get 在返回引用前等待对象 live；这里覆盖“等不到”的三类原因：未服务（unavailable）、版本/形状不匹配
// （contract_mismatch），以及指纹相同即可复用（Same 声明与已服务类型一致时能拿到对象）。
// quick = { readyTimeout: 5 } 把等待压到 5ms，避免测试真的等默认 60s。
describe("get", () => {
	// 未服务：Page。版本不匹配：InfoV2（version 2）与 Changed（version 1 但 title 类型不同），两者都等满 5ms 后
	// 以 contract_mismatch 拒绝；Same 的声明与服务端指纹一致，能正常取到对象。
	it("waits for an unserved type and a contract mismatch until its readyTimeout, then rejects with the cause", async () => {
		const { host } = await loaded((h) => h.serve(Info, () => ({ title: constant("t") })));
		const quick = { readyTimeout: 5 };
		expect(await rejection(host.get(Page, { id: 1 }, context, quick))).toEqual({
			code: "unavailable",
			message: "app.page is not served here",
		});
		const InfoV2 = local("app.info", { version: 2, params: {}, members: { title: str() } });
		const Changed = local("app.info", { version: 1, params: {}, members: { title: int() } });
		expect(await rejection(host.get(InfoV2, {}, context, quick))).toMatchObject({ code: "contract_mismatch" });
		expect(await rejection(host.get(Changed, {}, context, quick))).toMatchObject({ code: "contract_mismatch" });
		const Same = local("app.info", { version: 1, params: {}, members: { title: str() } });
		expect((await host.get(Same, {}, context)).title.value).toBe("t");
	});

	// 参数在进入工厂前由 L1 校验：类型系统用 @ts-expect-error 断言“这行本来就不该通过编译”，
	// 运行时则必须返回 invalid/params，证明校验不是只存在于类型层。
	it("checks params with L1 (invalid/params)", async () => {
		const { host } = await loaded((h) => h.serve(Page, ({ id }) => ({ id: constant(id) })));
		// 该指令必须紧贴目标行；若未来类型放宽导致没有错误，@ts-expect-error 本身会报错。
		// @ts-expect-error: a string is not an int
		expect(await rejection(host.get(Page, { id: "x" }, context))).toMatchObject({
			code: "invalid",
			reason: "params",
		});
	});
});

// getter 截止时间：get 等待的是“对象变 live”，但每个 getter 有自己的 readyTimeout；这里验证超时错误的消息与
// “只释放自己的引用”的语义。
describe("deadlines of gets", () => {
	fakeTimers();

	// open 永不完成 -> get 在 500ms 后以 unavailable 拒绝，消息包含类型/参数/毫秒数。
	it("reject with unavailable while no attempt has failed (the last failure: see attempt.test.ts)", async () => {
		const gate = Promise.withResolvers<void>();
		const { host } = await loaded((h) => serveGated(h, gate.promise, []));
		const waiting = rejection(host.get(Svc, { id: 1 }, context, { readyTimeout: 500 }));
		await vi.advanceTimersByTimeAsync(500);
		expect(await waiting).toEqual({ code: "unavailable", message: "app.svc(1): did not become live within 500 ms" });
	});

	// 两个 getter 等同一对象：early 在 100ms 超时并释放自己的引用；late 仍等 1000ms，gate 打开后成功。
	// closes 为空证明对象没有因为 early 退出而被关闭——引用计数仍然大于 0。
	it("are per getter: the first to pass releases only its own reference, the attempt goes on for the other", async () => {
		const gate = Promise.withResolvers<void>();
		const closes: string[] = [];
		const { host } = await loaded((h) => serveGated(h, gate.promise, closes), { readyTimeout: 10_000 });
		const early = rejection(host.get(Svc, { id: 1 }, context, { readyTimeout: 100 }));
		const late = host.get(Svc, { id: 1 }, context, { readyTimeout: 1000 });
		await vi.advanceTimersByTimeAsync(100);
		expect(await early).toMatchObject({ code: "unavailable" });
		gate.resolve();
		expect((await late).n.value).toBe(1);
		expect(closes).toEqual([]);
	});
});

// close 分组：关闭顺序（最后 live 的先关）、结束期间的调用语义、挂起 open 的取消、后台结束的等待、
// 以及依赖者先于被依赖者关闭。watch(...).closed 是观察对象结束的公共手段，ends 数组记录关闭顺序。
describe("close", () => {
	// Outer 依赖 Info，因此 Outer 后 live；close 时 Outer 先结束、Info 后结束。watch 的 closed Promise 在对象
	// 结束时解析，ends 数组因此记录顺序。close 后新的 get 被 released/closed 拒绝；已结束对象的 state 读取抛错。
	it("ends every object, the last to go live first, and rejects new calls", async () => {
		const Outer = local("app.outer", { version: 1, params: {}, members: { title: str() } });
		const { host } = await loaded((h) => {
			h.serve(Info, () => ({ title: constant("info") }));
			h.serve(Outer, (_, self) => ({ title: self.get(Info, {}).title }));
		});
		const ends: string[] = [];
		const outer = await host.get(Outer, {}, context);
		const info = await host.get(Info, {}, context);
		void (await outer.title.watch(context)).closed.then(() => ends.push("outer"));
		void (await info.title.watch(context)).closed.then(() => ends.push("info"));
		await host.close(context);
		expect(ends).toEqual(["outer", "info"]);
		expect(await rejection(host.get(Info, {}, context))).toEqual({
			code: "released",
			reason: "closed",
			message: "the host is closed",
		});
		expect(() => info.title.value).toThrow("app.info: ended");
	});

	// close 的第一步是同步把所有对象标为 ended；在 native 的 close 还没跑完之前，方法调用就已经以 released/ended 失败。
	// closing Promise 让 close 的收尾挂起，从而验证“先拒绝调用，后完成拆卸”。
	it("ends every object at once: calls fail released before any close ran", async () => {
		const closing = Promise.withResolvers<void>();
		const { host } = await loaded((h) =>
			h.serve(Counter, (_, self) => {
				self.open(
					async () => null,
					() => closing.promise,
				);
				return { count: constant(1), bump: async () => null };
			}),
		);
		const counter = await host.get(Counter, {}, context);
		const closed = host.close(context);
		expect(await rejection(counter.bump(context))).toEqual({
			code: "released",
			reason: "ended",
			message: "app.counter: ended",
		});
		closing.resolve();
		await closed;
	});

	// 激活中的 open 被 close 放弃：get 立即以 released/ended 失败；之后 gate 才 resolve 的“迟到 value”仍会被
	// 关闭回调收到，reason 为 close，避免资源泄漏。
	it("aborts a pending open and does not wait for it; its late value is closed with close", async () => {
		const gate = Promise.withResolvers<void>();
		const closes: string[] = [];
		const { host } = await loaded((h) => serveGated(h, gate.promise, closes));
		const got = rejection(host.get(Svc, { id: 1 }, context));
		await flushed();
		await host.close(context);
		expect(await got).toEqual({ code: "released", reason: "ended", message: "app.svc(1): ended" });
		gate.resolve();
		await flushed();
		expect(closes).toEqual(["svc 1 close"]);
	});

	// release() 使对象引用归零后，结束在后台进行；host.close 必须等这个后台拆卸完成，而不是另起一次关闭。
	it("joins an ending running in the background", async () => {
		const closing = Promise.withResolvers<void>();
		const { host } = await loaded((h) =>
			h.serve(Svc, ({ id }, self) => {
				self.open(
					async () => null,
					() => closing.promise,
				);
				return { n: constant(id) };
			}),
		);
		(await host.get(Svc, { id: 1 }, context)).release();
		let closed = false;
		const close = host.close(context).then(() => {
			closed = true;
		});
		await flushed();
		expect(closed).toBe(false);
		closing.resolve();
		await close;
	});

	// 依赖顺序：View(2) 持有 Svc(2)，View(1) 持有 Svc(1)。close 先关较晚 live 的整条链，且每个对象内部
	// 先开始 close、再等一个微任务、最后记录 closed；断言完整事件序列，防止并发关闭打乱顺序。
	it("closes object by object, a dependent before its dependencies", async () => {
		const View = local("app.view", { version: 1, params: { id: int() }, members: { n: int() } });
		const events: string[] = [];
		/** A native whose close records when it starts and, a turn later, when it ends. */
		const open = (self: Self, name: string): void => {
			self.open(
				async () => null,
				async () => {
					events.push(`${name} closing`);
					await flushed();
					events.push(`${name} closed`);
				},
			);
		};
		const { host } = await loaded((h) => {
			h.serve(Svc, ({ id }, self) => {
				open(self, `svc ${id}`);
				return { n: constant(id) };
			});
			h.serve(View, ({ id }, self) => {
				open(self, `view ${id}`);
				return { n: self.get(Svc, { id }).n };
			});
		});
		await host.get(View, { id: 1 }, context);
		await host.get(View, { id: 2 }, context);
		await host.close(context);
		expect(events).toEqual([
			"view 2 closing",
			"view 2 closed",
			"svc 2 closing",
			"svc 2 closed",
			"view 1 closing",
			"view 1 closed",
			"svc 1 closing",
			"svc 1 closed",
		]);
	});
});

// close 的竞态与错误路径：幂等（同一 Promise）、失败依赖者的引用拆卸、onError 抛错、退避窗口中的关闭。
describe("close, its order and its races", () => {
	// close 幂等：第二次调用不重新开始拆卸，而是等待同一个内部 closing Promise。
	it("returns one closing to every caller: a second close waits for the first", async () => {
		const closing = Promise.withResolvers<void>();
		const { host } = await loaded((h) =>
			h.serve(Counter, (_, self) => {
				self.open(
					async () => null,
					() => closing.promise,
				);
				return { count: constant(1), bump: async () => null };
			}),
		);
		const first = host.close(context);
		let second = false;
		void host.close(context).then(() => {
			second = true;
		});
		await flushed();
		expect(second).toBe(false);
		closing.resolve();
		await first;
		await flushed();
		expect(second).toBe(true);
	});

	// Pair 因 Core 失败（派生依赖失败），但它仍持有 Svc(1)。close 必须沿依赖图找到并关闭 Svc，且等待其 close 完成。
	// 先手动 get Svc 再 release，使 Svc 只被失败的 Pair 持有，从而排除“外部引用”解释。
	it("tears down what a failed dependent holds with close, and waits for it", async () => {
		const Pair = local("app.pair", { version: 1, params: { id: int() }, members: { n: int() } });
		const closing = Promise.withResolvers<void>();
		const closes: string[] = [];
		const { host } = await loaded((h) => {
			h.serve(Svc, ({ id }, self) => {
				self.open(
					async () => null,
					async (_value, reason) => {
						closes.push(`svc ${reason.kind}`);
						await closing.promise;
					},
				);
				return { n: constant(id) };
			});
			h.serve(Core, (_, self) => {
				self.open(
					async () => {
						throw new Error("offline");
					},
					() => {},
				);
				return { n: constant(0) };
			});
			h.serve(Pair, ({ id }, self) => ({
				n: self.derive([self.get(Svc, { id }).n, self.get(Core, {}).n], ([n]) => n),
			}));
		});
		// The pair fails on the core (R18) and keeps its references: svc(1), live before the pair, held by it alone.
		const svc = await host.get(Svc, { id: 1 }, context);
		void host.get(Pair, { id: 1 }, context).catch(() => {});
		await flushed();
		svc.release();
		let closed = false;
		const close = host.close(context).then(() => {
			closed = true;
		});
		await flushed();
		expect([closes, closed]).toEqual([["svc close"], false]);
		closing.resolve();
		await close;
	});

	// onError 是应用回调，可能抛错；宿主不能因此中断失败分类或拆卸。这里让 close 回调也抛错，并验证：
	// id=1 的瞬时失败仍会重试成功，id=2 的 broken 仍立即以 unavailable 拒绝（消息取错误原文）。
	it("goes on when onError throws: failures are still classified, teardowns still finish", async () => {
		const host = createHost({
			onError: () => {
				throw new Error("onError threw");
			},
		});
		const facet = defineFacet((h) =>
			h.serve(Svc, ({ id }, self) => {
				self.open(
					async () => {
						if (id === 2) throw broken(new Error("no config"));
						return null;
					},
					() => {
						throw new Error("close threw");
					},
				);
				return { n: constant(id) };
			}),
		);
		await host.load([{ name: "a", facet }], context);
		// The background end reports its throwing close; the next instance waits for that teardown.
		(await host.get(Svc, { id: 1 }, context)).release();
		expect((await host.get(Svc, { id: 1 }, context)).n.value).toBe(1);
		expect(await rejection(host.get(Svc, { id: 2 }, context))).toEqual({
			code: "unavailable",
			message: "app.svc(2): no config",
		});
	});

	// 嵌套 describe 只隔离假时钟配置；内部的用例仍属于 close 的竞态集合。
	describe("with a backoff window running", () => {
		fakeTimers();

		// 对象处于 transient 失败后的退避等待中；close 必须立即结束它（等待中的 get 得到 released/ended），
		// 并清除所有定时器。vi.getTimerCount() === 0 防止退避定时器在宿主关闭后仍触发。
		it("ends an object waiting for its window and clears every timer", async () => {
			const { host } = await loaded((h) =>
				h.serve(Svc, (_, self) => {
					self.open(
						async () => {
							throw new Error("offline");
						},
						() => {},
					);
					return { n: constant(0) };
				}),
			);
			const first = rejection(host.get(Svc, { id: 1 }, context, { readyTimeout: 100 }));
			await vi.advanceTimersByTimeAsync(100);
			await first;
			const waiting = rejection(host.get(Svc, { id: 1 }, context));
			await flushed();
			await host.close(context);
			expect(await waiting).toEqual({ code: "released", reason: "ended", message: "app.svc(1): ended" });
			expect(vi.getTimerCount()).toBe(0);
		});
	});
});

// getter 并发：取消一个 getter 的 context 只影响该 getter；同参数的另一 getter 仍拿到对象，工厂只运行一次。
describe("getters", () => {
	// withCancel 返回可取消的子 context；cancel 在工厂首次执行时调用，制造“激活过程中取消”的时序。
	// Promise.allSettled 同时观察两个 get 的结局（fulfilled/rejected），不因一个拒绝而中断等待另一个。
	it("one cancelled while another waits for the same object: the other gets it, the object lives", async () => {
		const { context: cancellable, cancel } = withCancel(context);
		const factory = vi.fn((_: { id: number }) => {
			cancel(new Error("cancelled"));
			return { id: constant(1) };
		});
		const { host } = await loaded((h) => h.serve(Page, factory));
		const [cancelled, kept] = await Promise.allSettled([
			host.get(Page, { id: 1 }, cancellable),
			host.get(Page, { id: 1 }, context),
		]);
		expect(cancelled).toMatchObject({ status: "rejected", reason: new Error("cancelled") });
		expect(kept.status === "fulfilled" && kept.value.id.value).toBe(1);
		await host.get(Page, { id: 1 }, context);
		expect(factory).toHaveBeenCalledTimes(1);
	});
});

// forEachCodec：对 binaryCodec 与 textCodec 各跑一遍整个 describe（在 beforeAll 中切换 currentCodec）。
// 同一组行为必须在两种编码下一致；测试本身不感知当前 codec，只有 support.ts 的链接夹具使用它。
forEachCodec(() => {
	// principal 与引用放置：谁在请求、对象为谁创建、引用走本地/路由/父链接，以及身份如何合并。
	// Who/Outer/Gate 是 remote（hostAddress 指向 Server），Inner/Desk 是 local；两者放置规则不同。
	describe("principals and where a reference goes", () => {
		const Who = remote("app.who", {
			version: 1,
			params: { id: int() },
			hostAddress: () => Server(),
			variants: { v: { state: { who: str() } } },
		});
		const Outer = remote("app.outer", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { v: { state: { who: str() } } },
		});
		const Inner = local("app.inner", { version: 1, params: { id: int() }, members: { who: str() } });
		const Desk = local("app.desk", { version: 1, params: {}, members: { who: method(undefined, str()) } });
		const Gate = remote("app.gate", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { v: { methods: { who: method(undefined, str()) } } },
		});
		type P = TestPrincipal;

		/** Serves every type above: `Who` shows the principal its object is for. */
		// serveAll：一次性声明本组所有类型。factories 记录 Who 的 (id, principal.kind)，用于判断对象为谁创建、
		// 是否复用了同一实例。Outer 内部 self.get(Who)，Inner 用 host 视角 self.get(Who)，Gate 通过 ctx.get 访问。
		function serveAll(h: FacetHost<P>, factories: string[]) {
			h.serve(Who, ({ id }, principal) => {
				factories.push(`${id} ${principal.kind}`);
				return { variant: "v", members: { who: constant(principal.kind) } };
			});
			h.serve(Outer, (_, _principal, self) => ({ variant: "v", members: { who: self.get(Who, { id: 3 }).who } }));
			h.serve(Inner, ({ id }, self) => ({ who: self.get(Who, { id }).who }));
			const who = async (ctx: Ctx<P>) => {
				const ref = await ctx.get(Who, { id: 2 });
				return ref.who.value;
			};
			h.serve(Desk, () => ({ who }));
			h.serve(Gate, () => ({ variant: "v", members: { who } }));
		}

		// host.get 以宿主 principal 行事；没有 principal 的宿主（纯客户端）不能 serve remote 类型，load 时插件被排除。
		it("host.get acts as the host's principal; a host without one (a client) serves no remote type", async () => {
			const factories: string[] = [];
			const { server } = await linked((h) => serveAll(h, factories));
			expect((await server.get(Who, { id: 1 }, context)).who.value).toBe("server");
			const client = createHost<P>({ onError: () => {} });
			const report = await client.load(
				[{ name: "@test/app", facet: defineFacet<P>((h) => serveAll(h, [])) }],
				context,
			);
			expect(report.failed).toEqual([
				{
					plugin: "@test/app",
					error: expect.objectContaining({
						message: 'plugin "@test/app": app.who: a host without a principal serves only local types',
					}),
				},
			]);
			await client.close(context);
		});

		// 与上一条互补：即使有 principal，没有 address 也不能 serve remote 类型（无法判断“放在本机”）。
		it("a host without an address serves no remote type, whatever its principal", async () => {
			const host = createHost<P>({ principal: { kind: "server" }, onError: () => {} });
			const report = await host.load(
				[{ name: "@test/app", facet: defineFacet<P>((h) => serveAll(h, [])) }],
				context,
			);
			expect(report.failed).toEqual([
				{
					plugin: "@test/app",
					error: expect.objectContaining({
						message: 'plugin "@test/app": app.who: a host without an address serves only local types',
					}),
				},
			]);
			await host.close(context);
		});

		// ctx.get 的身份来自 ctx.principal：client（guest）经 Gate 方法访问时看到 guest 视角；
		// server 自己调用本地 Desk 的 handler 时看到 server 视角。who 方法返回 ctx.get(Who).who.value。
		it("ctx.get acts as ctx.principal: a guest's call gets the guest's view; a local handler's acts as the host", async () => {
			const { server, client } = await linked((h) => serveAll(h, []), { child: { kind: "guest", session: "S1" } });
			expect(await (await client.get(Gate, {}, context)).who(context)).toBe("guest");
			expect(await (await server.get(Desk, {}, context)).who(context)).toBe("server");
		});

		// self.get 的身份规则：remote 对象（Outer 由 client 持有）保持其 principal（guest）；
		// local 对象（Inner 在 server 上）按宿主 principal（server）行事。
		it("self.get acts as a remote object's principal, a local object's as the host's", async () => {
			const { server, client } = await linked((h) => serveAll(h, []), { child: { kind: "guest", session: "S1" } });
			expect((await client.get(Outer, {}, context)).who.value).toBe("guest");
			expect((await server.get(Inner, { id: 4 }, context)).who.value).toBe("server");
		});

		// 对象身份 = 类型 + 参数 + principal key。principalKey 只取 kind，因此 guest/S1（宿主自身）与 guest/S2
		// （子链接）共享同一个 Who(1)；owner 的 key 不同，得到第二个对象。factories 的顺序/内容证明复用关系。
		it("identity includes the principal key: equal keys share one object", async () => {
			const factories: string[] = [];
			const host = createHost<P>({
				address: Server(),
				principal: { kind: "guest", session: "S1" },
				principalKey: (principal) => principal.kind,
				onError: () => {},
			});
			await host.load([{ name: "@test/app", facet: defineFacet<P>((h) => serveAll(h, factories)) }], context);
			const [a, b] = memoryLinkPair();
			host.accept(a, { principal: { kind: "guest", session: "S2" }, codec: testCodec() }, context);
			const peer = new RawPeer(b);
			await host.get(Who, { id: 1 }, context);
			peer.send({
				kind: "hold",
				hold: 0,
				type: Who.name,
				version: Who.version,
				fingerprint: Who.fingerprint,
				params: jsonPart({ id: 1 }),
				address: SERVER_ADDRESS,
			});
			await peer.next("bound");
			expect(factories).toEqual(["1 guest"]);
			const [c, d] = memoryLinkPair();
			host.accept(c, { principal: { kind: "owner" }, codec: testCodec() }, context);
			const owner = new RawPeer(d);
			owner.send({
				kind: "hold",
				hold: 0,
				type: Who.name,
				version: Who.version,
				fingerprint: Who.fingerprint,
				params: jsonPart({ id: 1 }),
				address: SERVER_ADDRESS,
			});
			await owner.next("bound");
			expect(factories).toEqual(["1 guest", "1 owner"]);
		});

		// load 只激活“本地、空参数”的类型；remote 空参数对象按需创建。release 后对象结束，再次 get 会重新创建
		// 第二个实例，因此 factories 最终是 ["server", "server"]。
		it("remote objects with empty params are not activated by load; they live while referenced", async () => {
			const factories: string[] = [];
			const Empty = remote("app.empty", {
				version: 1,
				params: {},
				hostAddress: () => Server(),
				variants: { v: { state: { n: int() } } },
			});
			const { server } = await linked((h) =>
				h.serve(Empty, (_, principal) => {
					factories.push(principal.kind);
					return { variant: "v", members: { n: constant(1) } };
				}),
			);
			expect(factories).toEqual([]);
			(await server.get(Empty, {}, context)).release();
			await flushed();
			await server.get(Empty, {}, context);
			expect(factories).toEqual(["server", "server"]);
		});

		// 放置规则：local 类型（Inner）不能在 client 上解析，get 得到 unavailable；remote 类型（Who）在没有父链接时
		// hold 停在 loading（等待未来连接），get 超时得到 unavailable。
		it("a local type never crosses a link; a remote type without a parent link waits for one", async () => {
			const { client } = await linked(() => {});
			expect(client.hold(Inner, { id: 1 }, context).state.value).toMatchObject({
				kind: "failed",
				cause: { kind: "waiting" },
			});
			expect(await rejection(client.get(Inner, { id: 1 }, context, { readyTimeout: 5 }))).toEqual({
				code: "unavailable",
				message: "app.inner is not served here",
			});
			const alone = createHost<P>({ onError: () => {} });
			await alone.load([], context);
			expect(alone.hold(Who, { id: 1 }, context).state.value).toEqual({ kind: "loading" });
			expect(await rejection(alone.get(Who, { id: 1 }, context, { readyTimeout: 10 }))).toEqual({
				code: "unavailable",
				message: "app.who(1): did not become live within 10 ms",
			});
		});

		// 一个宿主同时只能有一条打开的父链接；linked() 已经 connect 过，第二次 connect 同步抛错。
		it("connect takes one open parent link", async () => {
			const { client } = await linked(() => {});
			expect(() =>
				client.connect(memoryLinkPair()[0], { principal: { kind: "server" }, codec: testCodec() }, context),
			).toThrow("connect: this host has an open parent link");
		});

		// close 先关链接：client 的 remote 引用回到 loading（可重连），而不是 ended；它的 watch 仍然打开。
		// Promise.race 用 transported() 作为“下一个微任务边界”，若 watch 已关闭则返回 closed，否则返回 "open"。
		it("close closes the links first: the consumer sees the link drop, no gone", async () => {
			const { server, client } = await linked((h) => serveAll(h, []));
			const who = await client.get(Who, { id: 1 }, context);
			const watch = await who.who.watch(context);
			await server.close(context);
			await transported();
			expect(who.state.value).toEqual({ kind: "loading" });
			expect(who.who.value).toBe("owner");
			expect(await Promise.race([watch.closed, transported().then(() => "open")])).toBe("open");
		});
	});
});

// 注册表等待与 close 的竞态：host.registry 在无提供者时挂起；close 必须让这个等待以 released/closed 结束，
// 而不是等到 60s 的 readyTimeout。这里不启用假时钟，靠 close 直接结算。
describe("host.registry and the host's close (fix round 1)", () => {
	const Absent = defineRegistry<number, number>("app.absent", { version: 1 });

	// outcome 用 then 单独收集，避免 rejection() 在 close 前被 await 而卡住测试；flushed 给后台结算一个微任务边界。
	it("ends a waiting host.registry at the close with released/closed, its deadline timer with it (Sol 5, Astra 5)", async () => {
		const host = createHost(noErrors);
		await host.load([], context);
		let outcome: unknown;
		void rejection(host.registry(Absent, context, { readyTimeout: 60_000 })).then((error) => {
			outcome = error;
		});
		await flushed();
		await host.close(context);
		await flushed();
		expect(outcome).toMatchObject({ code: "released", reason: "closed" });
	});
});

// provider 自身代码抛错/拒绝放置时的归属：错误应算在 provider 的实现上（waiting 且原因 invalid/host_address，
// 或 broken），而不是让消费者永久 loading。shape 复用契约公共字段，as const 固定字面量版本/变体名。
describe("the selected provider's own checks for a request made here (fix round 1)", () => {
	const Here = hostKind("app-here");
	const Elsewhere = hostKind("app-elsewhere");
	const shape = { version: 1, params: {}, variants: { view: { state: { n: int() } } } } as const;

	// Consumer 与 Provider 同名同版本，但 hostAddress 不同：请求落在 Here，而本机 provider 的代码说应去 Elsewhere。
	// 结果不是静默失败，而是 failed { waiting, invalid/host_address }，保留重试/修正的可能。
	it("waits a same-host remote request the provider's code places elsewhere: invalid/host_address (Astra 4)", async () => {
		const Consumer = remote("app.placed", { ...shape, hostAddress: () => Here() });
		const Provider = remote("app.placed", { ...shape, hostAddress: () => Elsewhere() });
		const host = createHost({ address: Here(), principal: { kind: "owner" }, onError: () => {} });
		const facet = defineFacet((h) => h.serve(Provider, () => ({ variant: "view", members: { n: constant(1) } })));
		await host.load([{ name: "@app/provider", facet }], context);
		const ref = host.hold(Consumer, {}, context);
		await flushed();
		expect(ref.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { code: "invalid", reason: "host_address" } },
		});
		ref.release();
		await host.close(context);
	});

	// hostAddress 是 provider 的同步代码；它抛错属于实现 bug，不是暂时不可用，因此引用进入 broken（不重试）。
	// 无论是 client 通过父链接请求，还是 server 在本机直接 hold，结论一致。
	it("fails broken when the provider's hostAddress throws: its own code (Sol 7)", async () => {
		const Consumer = remote("app.remote", { ...shape, hostAddress: () => Server() });
		const Provider = remote("app.remote", {
			...shape,
			hostAddress: () => {
				throw new Error("provider address bug");
			},
		});
		const server = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		const client = createHost({ onError: () => {} });
		const facet = defineFacet((h) => h.serve(Provider, () => ({ variant: "view", members: { n: constant(1) } })));
		await server.load([{ name: "@app/provider", facet }], context);
		await client.load([], context);
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { kind: "server" } }, context);
		client.connect(up, { principal: { kind: "server" } }, context);
		const held = client.hold(Consumer, {}, context);
		await transported();
		expect(held.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "broken", error: { message: "app.remote: provider address bug" } },
		});
		// The same throw for a request made on the provider's host fails it broken too.
		const here = server.hold(Consumer, {}, context);
		expect(here.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
		await client.close(context);
		await server.close(context);
	});
});

// 插件隔离：一个 facet 的 setup 抛错只排除该插件，其他插件照常发布，宿主的链接保持打开（不会因此关闭整个 host）。
describe('a load whose setup throws (decision "Per plugin at startup and reload")', () => {
	// 两个插件：@test/broken 的 setup 抛错，@test/app 正常服务 Info。报告只含前者；父/子 RawPeer 均未关闭；
	// Info 可正常 get；被排除插件本应提供的 Page 保持 failed { waiting }（不会误判为“已服务”）。
	it("leaves that plugin out and reports it; the others publish, the host and its links stay open", async () => {
		const host = createHost<TestPrincipal>({ principal: { kind: "server" }, onError: () => {} });
		const [a, b] = memoryLinkPair();
		const [c, d] = memoryLinkPair();
		host.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		host.connect(c, { principal: { kind: "server" }, codec: testCodec() }, context);
		const child = new RawPeer(b);
		const parent = new RawPeer(d);
		const broken = defineFacet<TestPrincipal>(() => {
			throw new Error("setup threw");
		});
		const report = await host.load(
			[
				{ name: "@test/broken", facet: broken },
				{
					name: "@test/app",
					facet: defineFacet<TestPrincipal>((h) => h.serve(Info, () => ({ title: constant("t") }))),
				},
			],
			context,
		);
		expect(report.failed).toEqual([
			{ plugin: "@test/broken", error: expect.objectContaining({ message: 'plugin "@test/broken": setup threw' }) },
		]);
		await transported();
		expect([child.closed, parent.closed]).toEqual([false, false]);
		expect((await host.get(Info, {}, context)).title.value).toBe("t");
		// What the left-out plugin would have served waits as any missing type does.
		expect(host.hold(Page, { id: 1 }, context).state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting" },
		});
		await host.close(context);
	});
});

// hold/get 获取语义：hold 同步返回可观察引用（不 reject），get 等待并可能 reject；这里覆盖无效参数、未服务、
// 瞬态失败（带 retryAt）、broken（不重试）、取消 context、host.close。假时钟用于精确控制 backoff。
describe("acquiring: hold and get", () => {
	fakeTimers();

	/** Serves `Svc`, whose open throws `offline` (broken when `failing.broken`) while `failing.left` is above 0. */
	// serveFlaky：可配置前 N 次激活失败的 Svc。failing.left-- <= 0 时返回 undefined（成功）；否则抛普通 Error
	// （transient，可重试）或 broken Error（不可重试）。failing 对象被测试持有，可在中途改变状态。
	function serveFlaky(h: FacetHost, failing: { left: number; broken: boolean }): void {
		h.serve(Svc, ({ id }, self) => {
			self.open(
				async () => {
					if (failing.left-- <= 0) return;
					throw failing.broken ? broken(new Error("offline")) : new Error("offline");
				},
				() => {},
			);
			return { n: constant(id) };
		});
	}

	// 复用的期望错误形状：transient 失败的 get 在超时后以最后一个原因（unavailable + 原始消息）拒绝。
	const offline = { code: "unavailable", message: "app.svc(1): offline" };

	// 参数错误是同步可判定的：hold 立即 throw，get 立即 reject invalid/params（无需等待）。
	// 未服务的本地类型：hold 停在 failed { waiting }（retryAt 未定义，因为不是定时重试），get 在 5ms 后以 unavailable 拒绝。
	it("invalid params at once; a local type not served here: hold waits failed, get rejects at its readyTimeout", async () => {
		const host = createHost<TestPrincipal>({ address: Server(), ...noErrors, principal: { kind: "server" } });
		await host.load([{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => void serveNotes(h)) }], context);
		const params = { code: "invalid", reason: "params" };
		expect(() => host.hold(Notes, { session: 1 } as never, context)).toThrow("params");
		expect(await rejection(host.get(Notes, { session: 1 } as never, context))).toMatchObject(params);
		const unserved = { code: "unavailable", message: "app.info is not served here" };
		expect(host.hold(Info, {}, context).state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: unserved },
			retryAt: undefined,
		});
		const got = rejection(host.get(Info, {}, context, { readyTimeout: 5 }));
		await vi.advanceTimersByTimeAsync(5);
		expect(await got).toEqual(unserved);
	});

	// transient 重试的时间线（假时钟从 0 开始）：t=0 失败 -> retryAt=1000；t=1000 再失败 -> retryAt=3000；
	// t=3000 再失败 -> retryAt=7000。等待窗口依次是 1s、2s、4s（指数退避）。
	// get 的 readyTimeout=1500，在 t=1500 以最后一个原因拒绝并释放自己的引用；hold 不释放，继续跟随对象，
	// 所以 t=4500 时看到的 retryAt 是 7000。精确断言这些数值可抓住退避状态机回归。
	it("through transient failures: hold is failed with retryAt, then loading; get waits, then rejects with the last cause", async () => {
		const { host } = await loaded((h) => serveFlaky(h, { left: 5, broken: false }));
		const held = host.hold(Svc, { id: 1 }, context);
		const got = rejection(host.get(Svc, { id: 1 }, context, { readyTimeout: 1_500 }));
		await flushed();
		expect(held.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "transient", error: offline },
			retryAt: 1_000,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await flushed();
		expect(held.state.value).toMatchObject({ kind: "failed", retryAt: 3_000 });
		await vi.advanceTimersByTimeAsync(500);
		expect(await got).toEqual(offline);
		// The getter released only its own reference: the hold follows the object's retries.
		await vi.advanceTimersByTimeAsync(1_500);
		expect(held.state.value).toMatchObject({ kind: "failed", retryAt: 7_000 });
	});

	// broken 是“不会自愈”的失败：hold 显示 failed 且 retryAt 为 undefined；get 不等待截止时间，立即以原始原因拒绝。
	it("a broken failure: hold is failed without retryAt; get releases its reference and rejects at once", async () => {
		const { host } = await loaded((h) => serveFlaky(h, { left: 1, broken: true }));
		const held = host.hold(Svc, { id: 1 }, context);
		expect(await rejection(host.get(Svc, { id: 1 }, context))).toEqual(offline);
		expect(held.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" }, retryAt: undefined });
	});

	// 取消 context 只终止这次 get：hold 是无等待者的观察句柄，仍会在 gate 打开后变 live；
	// get（id=2）拒绝后释放唯一引用，导致该对象在迟到 value 到达时被以 reason=end 关闭。
	it("a cancelled context: no effect on a hold; a get releases its reference and rejects", async () => {
		const gate = Promise.withResolvers<void>();
		const closes: string[] = [];
		const { host } = await loaded((h) => serveGated(h, gate.promise, closes));
		const { context: cancellable, cancel } = withCancel(context);
		const held = host.hold(Svc, { id: 1 }, cancellable);
		const got = host.get(Svc, { id: 2 }, cancellable);
		cancel(new Error("user cancelled"));
		await expect(got).rejects.toThrow("user cancelled");
		gate.resolve();
		await flushed();
		expect(held.state.value).toEqual({ kind: "live" });
		// The getter's object ended with its only reference: its late value was closed.
		expect(closes).toEqual(["svc 2 end"]);
	});

	// close 竞态：本地与远程各一个引用。close 后排队中的方法调用以 released/closed 拒绝；两个引用的 state 变 ended；
	// 它们的 watch 也以 { kind: "ended" } 关闭，不会永久挂起。
	it("host.close: queued calls reject released, references go released, their watches end (race 10)", async () => {
		const gate = Promise.withResolvers<void>();
		const { host } = await loaded((h) => serveGated(h, gate.promise, []));
		const local = host.hold(Svc, { id: 1 }, context);
		const remoteHost = createHost<TestPrincipal>(noErrors);
		await remoteHost.load([], context);
		const remote = remoteHost.hold(Notes, { session: "S1" }, context);
		const call = remote.wait(context);
		const watches = [await local.state.watch(context), await remote.state.watch(context)];
		await Promise.all([host.close(context), remoteHost.close(context)]);
		expect(await rejection(call)).toEqual({ code: "released", reason: "closed", message: "the host is closed" });
		expect([local.state.value, remote.state.value]).toMatchObject([{ kind: "ended" }, { kind: "ended" }]);
		expect(await Promise.all(watches.map(({ closed }) => closed))).toEqual([{ kind: "ended" }, { kind: "ended" }]);
	});
});

// 父链接掉线后的重连：close() 是异步传播的；在客户端这一端真正看到关闭前，connect 仍应拒绝。
// transported() 排空链路消息，使 remote 引用先进入 loading，然后才允许 connect 下一条链接。
forEachCodec(() => {
	describe("connect after a drop", () => {
		// 第一步只关闭 server 端；client 端要等 transported() 才感知。此前 connect 同步抛错；感知后 remote 引用
		// 进入 loading（可重连），此时 connect 新链接成功。next 是箭头函数，每次调用都新建一条链接。
		it("throws while the previous parent link is open or still closing, and takes the next once it closed (race 4)", async () => {
			const { client, links } = await linked((h) => void serveNotes(h));
			const notes = await client.get(Notes, { session: "S1" }, context);
			const next = (): void =>
				client.connect(memoryLinkPair()[0], { principal: { kind: "server" }, codec: testCodec() }, context);
			// The server's end closes now, the client's a microtask later.
			links[0].close();
			expect(next).toThrow("connect: this host has an open parent link");
			await transported();
			expect(notes.state.value).toEqual({ kind: "loading" });
			expect(next).not.toThrow();
		});
	});
});

// 放置表（design §3 的表）：一个 hold/引用应该去本机、路由、还是父链接；关键判据是“地址”，不是“类型是否在本机服务”。
// RawPeer 让我们直接说协议，不经过客户端 API，从而验证服务端对每帧的处理。
forEachCodec(() => {
	describe("where a reference or an arriving hold goes (section 1's table)", () => {
		/** A worker for session S1 serving `PlacedNotes`, a raw peer as its child, and one as its parent when `parent`. */
		// worker：session S1 的宿主，服务 PlacedNotes（其 hostAddress 是 Session(params.session)）。
		// options.parent=true 时先 connect 一条父链接；errors 收集 onError 供断言。返回 child RawPeer 供发送 hold。
		// 注意 load 发生在 connect 之后、accept 之前，符合真实启动顺序。
		async function worker(options: { readonly parent?: boolean } = {}) {
			const errors: HostError[] = [];
			const host = createHost<TestPrincipal>({
				address: Session({ id: "S1" }),
				principal: { kind: "worker", session: "S1" },
				onError: (error) => errors.push(error),
			});
			let parent: RawPeer | undefined;
			if (options.parent === true) {
				const [a, b] = memoryLinkPair();
				host.connect(a, { principal: { kind: "server" }, codec: testCodec() }, context);
				parent = new RawPeer(b);
			}
			await host.load(
				[{ name: "@test/w", facet: defineFacet<TestPrincipal>((h) => serveNotes(h, PlacedNotes)) }],
				context,
			);
			const [a, b] = memoryLinkPair();
			host.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			return { host, child: new RawPeer(b), parent, errors };
		}

		/** Sends a hold of `PlacedNotes` (or `type`) for `session`, naming the session `address`. */
		// holdOf：手工构造一条 hold 协议消息。params 里的 session 决定“代码认为对象属于谁”；
		// address 决定“这条 hold 送往哪个宿主”。两者不一致正是 code skew 场景。
		// 默认参数（type = PlacedNotes.name, hold = 0）让普通用例只传前三个参数。
		function holdOf(peer: RawPeer, session: string, address: string, type: string = PlacedNotes.name, hold = 0) {
			peer.send({
				kind: "hold",
				hold,
				type,
				version: PlacedNotes.version,
				fingerprint: PlacedNotes.fingerprint,
				params: jsonPart({ session }),
				address: { kind: "session", params: { id: address } },
			});
		}

		const misplaced = {
			code: "invalid",
			reason: "host_address",
			message: "app.placed-notes: placed on session, this host is session|S1",
		};

		// 基线：hold 的 session=S1、address=S1，本机正好是 session S1 且服务该类型 -> 直接 bound。
		it("binds a hold of a type served here that names this host's address", async () => {
			const { child } = await worker();
			holdOf(child, "S1", "S1");
			expect((await child.next("bound")).holds[0]).toMatchObject({ hold: 0 });
		});

		// code skew：发送方认为对象属于 S1（address=S1），但本机服务代码按 params.session=S2 计算 hostAddress，
		// 得出“应去 S2”。hold 不被丢弃，而是 failed { waiting, invalid/host_address }；后续重试保留自己的 hold id。
		it("keeps a hold naming this host whose params the code here places elsewhere waiting: invalid/host_address (code skew, M§1)", async () => {
			const { child } = await worker();
			holdOf(child, "S2", "S1");
			expect(await child.next("failed")).toMatchObject({
				hold: 0,
				cause: { kind: "waiting", error: { kind: "chord", error: misplaced } },
			});
			// A refused hold is kept (a publication or a retry starts it again): the next hold takes the next id.
			holdOf(child, "S2", "S1", PlacedNotes.name, 1);
			expect(await child.next("failed")).toMatchObject({ hold: 1, cause: { kind: "waiting" } });
		});

		// 关键规则：放置看 address 字段，而不是“本机是否服务同名类型”。address=S2 的 hold 即使类型在本机服务，
		// 也会原样转发给父链接（relay 不截获）；第二条 address=S2、hold=1 继续转发，id 保持不变。
		it("places a hold by the address it names, never by the name it serves (a relay never captures it)", async () => {
			const { child, parent } = await worker({ parent: true });
			holdOf(child, "S2", "S2");
			const relayed = await parent!.next("hold");
			expect(relayed).toMatchObject({ type: PlacedNotes.name, address: { kind: "session", params: { id: "S2" } } });
			holdOf(child, "S1", "S2", PlacedNotes.name, 1);
			expect(await parent!.next("hold")).toMatchObject({ hold: 1 });
		});

		// 本机 hold 一个 remote 类型，但 params.session=S2 使 hostAddress 指向别的宿主：引用经父链接发出，
		// 本机仍然是 loading。对照：session=S1 的同类型在本机绑定，variant 为 editor。
		it("sends a reference made here whose host address is another host over the parent link, though it serves the type", async () => {
			const { host, parent } = await worker({ parent: true });
			const elsewhere = host.hold(PlacedNotes, { session: "S2" }, context);
			const hold = await parent!.next("hold");
			expect(hold).toMatchObject({ type: PlacedNotes.name, address: { kind: "session", params: { id: "S2" } } });
			expect(elsewhere.state.value).toEqual({ kind: "loading" });
			expect((await host.get(PlacedNotes, { session: "S1" }, context)).variant).toBe("editor");
		});

		// 未知类型（app.elsewhere）无法在本机解析，也没有路由；它仍应原样经父链接转发。
		// partValue() 从编码后的 params part 还原 JSON，证明转发没有丢失参数。
		it("sends a hold it cannot serve or route over the parent link, unparsed", async () => {
			const { child, parent } = await worker({ parent: true });
			holdOf(child, "S9", "S9", "app.elsewhere");
			const relayed = await parent!.next("hold");
			expect(relayed).toMatchObject({ type: "app.elsewhere" });
			expect(partValue(relayed.params)).toEqual({ session: "S9" });
		});

		// 从父链接到达的 hold 若本机不能服务/路由，不能原路发回父链接（会形成回环）：直接 failed { broken,
		// unavailable }。parent.kinds() 只有 hello，证明没有额外的 hold 帧发回去。
		it("never sends a hold from the parent back to it: unavailable (race 8)", async () => {
			const { parent } = await worker({ parent: true });
			holdOf(parent!, "S9", "S9", "app.elsewhere");
			expect(await parent!.next("failed")).toMatchObject({
				hold: 0,
				cause: {
					kind: "broken",
					error: { kind: "chord", error: { code: "unavailable", message: "app.elsewhere is not served here" } },
				},
			});
			expect(parent!.kinds()).toEqual(["hello"]);
		});

		// 没有父链接可转发时，未知类型的 hold 同样 broken/unavailable，而不是永远 waiting。
		it("refuses a hold it cannot serve or route without a parent link: unavailable", async () => {
			const { child } = await worker();
			holdOf(child, "S9", "S9", "app.elsewhere");
			expect(await child.next("failed")).toMatchObject({
				cause: { kind: "broken", error: { kind: "chord", error: { code: "unavailable" } } },
			});
		});

		// hostAddress 抛错属于契约代码 bug：get 拒绝并带原始消息，hold 同步进入 failed（broken）。
		it("fails a reference broken with what its hostAddress throws", async () => {
			const Throwing = remote("app.throwing", {
				version: 1,
				params: {},
				hostAddress: () => {
					throw new Error("hostAddress threw");
				},
				variants: { v: { state: { n: int() } } },
			});
			const client = createHost<TestPrincipal>(noErrors);
			await client.load([], context);
			expect(await rejection(client.get(Throwing, {}, context))).toMatchObject({
				message: "app.throwing: hostAddress threw",
			});
			expect(client.hold(Throwing, {}, context).state.value).toMatchObject({ kind: "failed" });
		});
	});
});

// 存储归属：一个 Store 同时只能附加一个打开的宿主；后端失败只报告一次 storage_failed，并让宿主自行关闭，
// 但 Store 本身仍由应用关闭（宿主不越权）。
describe("the host's store", () => {
	/** A store on `:memory:`, as Chord's layers see it. */
	// memoryStore：打开内存 SQLite 后端并包成 ChordStore。第二个参数 context 是存储操作的父上下文。
	// 返回类型断言为 ChordStore；openStore 的返回类型更宽，这里需要宿主的存储接口。
	async function memoryStore(): Promise<ChordStore> {
		return (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ChordStore;
	}

	// 规则 7：同一 Store 上第二个 createHost 同步抛错；第一个关闭后，同一个 Store 可以再附加新宿主。
	it("belongs to one open host at a time (rule 7)", async () => {
		const store = await memoryStore();
		const first = createHost({ store, onError: () => {} });
		expect(() => createHost({ store, onError: () => {} })).toThrow("store: already attached to an open host");
		await first.close(context);
		await createHost({ store, onError: () => {} }).close(context);
		await store.close(context);
	});

	// 注入 COMMIT 失败（结果未知，D4）：两次 commit 都以 storage_failed 拒绝，但 onError 只收到一次；
	// 宿主把自己置为 closing，host.close() 加入这次关闭；最后应用调用 store.close() 完成资源释放。
	it("reports storage_failed once and closes the host; the app still closes the store", async () => {
		const { store, fail } = await faultyStore();
		const errors: HostError[] = [];
		const host = createHost({ store, onError: (error) => errors.push(error) });
		await host.load([], context);
		const write: StagedWrite = { order: "write", apply: async () => [] };
		const fence = { admit: () => true, adopt: () => {} };
		// A failed `COMMIT`: an unknown outcome (D4).
		fail("COMMIT");
		await expect(store.commit([write], fence, context)).rejects.toMatchObject({ reason: "storage_failed" });
		await expect(store.commit([write], fence, context)).rejects.toMatchObject({ reason: "storage_failed" });
		// The host closed itself; the app's own close returns that closing.
		expect((host as ChordHost).closing).toBe(true);
		await host.close(context);
		expect(errors.map(({ kind }) => kind)).toEqual(["storage_failed"]);
		await store.close(context);
	});
});

/** A plugin's facet serving `Info` with the title `title` (a new facet value each call: a changed plugin). */
// infoFacet：每次调用都返回新的 facet 对象，因此 reload 会把它判为“changed”（facet 身份是变化判定依据）。
// reload 的“unchanged”必须传入同一个 facet 对象（见 API 分组里的 kept）。
function infoFacet(title: string) {
	return defineFacet((h) => h.serve(Info, () => ({ title: constant(title) })));
}

// reload API（slice 7b §1）：调用时机、插件分类、串行化、abort 语义、失败保留旧代码。
describe("reload: the API (slice 7b §1)", () => {
	// 时机检查：load 完成前 reload 同步抛错；close 之后 reload 返回 rejected（released/closed）。
	it("throws before load resolved and rejects released/closed after close", async () => {
		const host = createHost(noErrors);
		expect(() => host.reload([], context)).toThrow("reload runs after load");
		await host.load([], context);
		await host.close(context);
		expect(await rejection(host.reload([], context))).toMatchObject({ code: "released", reason: "closed" });
	});

	// 分类规则：新名字 = added，新 facet 对象 = changed，缺席 = removed。kept 传入同一对象 -> unchanged，
	// 它服务的 Counter 引用保持 live，证明未受影响的插件不被重启。removed 的 Info 对象 fate 为 ended。
	it("reports plugins added, changed and removed; the same facet object is unchanged and untouched", async () => {
		const core = infoFacet("core");
		const host = createHost(noErrors);
		const kept = defineFacet((h) => h.serve(Counter, () => ({ count: constant(1), bump: async () => null })));
		await host.load(
			[
				{ name: "@app/core", facet: kept },
				{ name: "@app/info", facet: core },
			],
			context,
		);
		const counter = await host.get(Counter, {}, context);
		const report = await host.reload(
			[
				{ name: "@app/core", facet: kept },
				{ name: "@app/page", facet: defineFacet((h) => h.serve(Page, ({ id }) => ({ id: constant(id) }))) },
			],
			context,
		);
		expect(report.plugins).toEqual({ added: ["@app/page"], changed: [], removed: ["@app/info"] });
		expect(report.objects).toEqual([{ object: "app.info", kind: "ended" }]);
		// Untouched: the same reference stays live on the same object.
		expect(counter.state.value).toEqual({ kind: "live" });
		expect((await host.get(Page, { id: 3 }, context)).id.value).toBe(3);
		await host.close(context);
	});

	// 串行化：第二个 reload 不等第一个完成绝不开始 staging/commit；order 顺序与最终 title 都证明这一点。
	it("runs reloads one after another", async () => {
		const host = createHost(noErrors);
		await host.load([{ name: "@app/info", facet: infoFacet("a") }], context);
		const order: string[] = [];
		const first = host.reload([{ name: "@app/info", facet: infoFacet("b") }], context).then(() => order.push("b"));
		const second = host.reload([{ name: "@app/info", facet: infoFacet("c") }], context).then(() => order.push("c"));
		await Promise.all([first, second]);
		expect(order).toEqual(["b", "c"]);
		expect((await host.get(Info, {}, context)).title.value).toBe("c");
		await host.close(context);
	});

	// 提交前 abort：reload 拒绝 aborted，旧代码继续服务（title 仍为 "a"）。这里在调用前就 cancel，
	// 因此 staging 阶段即可观察到已取消。
	it("an abort before the commit rejects aborted and changes nothing", async () => {
		const host = createHost(noErrors);
		await host.load([{ name: "@app/info", facet: infoFacet("a") }], context);
		const { context: aborted, cancel } = withCancel(context);
		cancel(new Error("stop"));
		expect(await rejection(host.reload([{ name: "@app/info", facet: infoFacet("b") }], aborted))).toMatchObject({
			code: "aborted",
		});
		expect((await host.get(Info, {}, context)).title.value).toBe("a");
		await host.close(context);
	});

	// 提交后 abort：commit 已经生效，不能回滚；reload 只结束“等待报告”，错误 details.committed 记录本次应用了
	// 哪些 added/changed/removed。vi.spyOn 包住 batch.commit，在真实提交后对 aborting context 调用 cancel，
	// 精确制造“提交刚结束就取消”的窗口；hook.mockRestore 恢复原方法，避免影响后续用例。
	it("an abort after the commit rejects aborted naming what the commit applied, which stands", async () => {
		const host = createHost(noErrors);
		await host.load(
			[
				{ name: "@app/info", facet: infoFacet("a") },
				{ name: "@app/gone", facet: defineFacet(() => {}) },
			],
			context,
		);
		const info = await host.get(Info, {}, context);
		const { context: aborting, cancel } = withCancel(context);
		// The abort lands right after the commit (its publication batch), while the reload waits for its report.
		const { batch } = host as ChordHost;
		const commit = batch.commit.bind(batch);
		const hook = vi.spyOn(batch, "commit").mockImplementation((adopt, ctx) => {
			commit(adopt, ctx);
			if (ctx === aborting) cancel(new Error("stop"));
		});
		const reloading = host.reload(
			[
				{ name: "@app/info", facet: infoFacet("b") },
				{ name: "@app/new", facet: defineFacet(() => {}) },
			],
			aborting,
		);
		const error = await rejection(reloading);
		hook.mockRestore();
		expect(error).toMatchObject({
			code: "aborted",
			details: { committed: { added: ["@app/new"], changed: ["@app/info"], removed: ["@app/gone"], failed: [] } },
		});
		expect(info.title.value).toBe("b");
		await host.close(context);
	});

	// 新代码失败时保留旧代码：setup 抛错、厂函数抛错都归入 report.failed（消息带插件名，工厂错误还带类型名）。
	// 随后一次 reload 中两个插件都想服务 Info，后一个（@app/other）因重复被排除；前一个仍成功更新到 "b"。
	// 已持有的 info 引用继续指向同一对象并变为 live，证明 changed 的插件走“原地换代码”而非重建引用。
	it("reports a setup's or a factory's throw as failed, naming the plugin, which stays on its old code", async () => {
		const host = createHost(noErrors);
		await host.load([{ name: "@app/info", facet: infoFacet("a") }], context);
		const info = await host.get(Info, {}, context);
		const throwing = defineFacet(() => {
			throw new Error("setup threw");
		});
		const failedOf = async (facets: { readonly name: string; readonly facet: typeof throwing }[]) => {
			const report = await host.reload(facets, context);
			return report.failed.map(({ plugin, error }) => [plugin, (error as Error).message]);
		};
		expect(await failedOf([{ name: "@app/info", facet: throwing }])).toEqual([
			["@app/info", 'plugin "@app/info": setup threw'],
		]);
		const factoryThrows = defineFacet((h) =>
			h.serve(Info, () => {
				throw new Error("factory threw");
			}),
		);
		expect(await failedOf([{ name: "@app/info", facet: factoryThrows }])).toEqual([
			["@app/info", 'plugin "@app/info", app.info: factory threw'],
		]);
		// A type another plugin serves already fails the plugin with new code; an added one is left out.
		const twice = [
			{ name: "@app/info", facet: infoFacet("b") },
			{ name: "@app/other", facet: infoFacet("c") },
		];
		const report = await host.reload(twice, context);
		expect(report.plugins).toEqual({ added: [], changed: ["@app/info"], removed: [] });
		expect(report.failed.map(({ plugin, error }) => [plugin, (error as Error).message])).toEqual([
			["@app/other", 'plugin "@app/other": app.info is served twice (plugin "@app/info")'],
		]);
		expect(info.title.value).toBe("b");
		expect(info.state.value).toEqual({ kind: "live" });
		await host.close(context);
	});
});

// reload 的提交（slice 7b §3）：新类型开始可服务、被移除类型的 presence 列表身份变化、等待者按“名字”被唤醒。
// 未被本次提交服务的名字（Core）不应被重新检查；references(Info) 在移除后返回新列表对象。
describe("reload: the commit (slice 7b §3)", () => {
	// page 与 other 是发布前发起的两个 hold。reload 加入 Page 后，page 被唤醒并 live；other（Core）不是本次提交
	// 服务的名字，保持 waiting 且其 state watch 没有新状态（otherStates 为空）。Info 被移除后 references(Info)
	// 返回新的列表对象（身份变化，旧列表不再代表当前引用）。
	it("serves added types, drops removed ones and their presence lists, and wakes requests per name", async () => {
		const host = createHost(noErrors) as unknown as ChordHost;
		await host.load([{ name: "@app/info", facet: infoFacet("a") }], context);
		const page = host.hold(Page, { id: 1 }, context);
		const other = host.hold(Core, {}, context);
		await flushed();
		expect(page.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		const presence = host.references(Info);
		const otherStates = statesOf(await other.state.watch(context));
		await host.reload(
			[
				{ name: "@app/info", facet: infoFacet("a") },
				{ name: "@app/page", facet: defineFacet((h) => h.serve(Page, ({ id }) => ({ id: constant(id) }))) },
			],
			context,
		);
		await flushed();
		expect(page.state.value).toEqual({ kind: "live" });
		expect(page.id.value).toBe(1);
		// Not a name the reload serves: still waiting, not checked again.
		expect(other.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect(otherStates).toEqual([]);
		await host.reload(
			[{ name: "@app/page", facet: defineFacet((h) => h.serve(Page, ({ id }) => ({ id: constant(id) }))) }],
			context,
		);
		expect(host.references(Info)).not.toBe(presence);
		await host.close(context);
	});

	// 注册表组合随 reload 变化：provider 的分隔符从 "," 变 "+"，贡献者 x 变为 y，已持有的 RegistryValue 就地更新为
	// "own+y"；移除 provider 后读取抛 "no plugin serves it here"；重新加回后用 ";" 组合出 "own;z"。
	// 这验证的是“组合值”对象在提交时重算，而不是返回新句柄。
	it("replaces a reloaded registry's provider and its plugin's contributions; a removed provider's readers wait", async () => {
		const Names = defineRegistry<string, string>("app.names", { version: 1 });
		const provider = (separator: string) =>
			defineFacet((h, self) => {
				h.serve(Names, { compose: (table) => table.map(({ value }) => value).join(separator) });
				self.contribute(Names, "own");
			});
		const contributor = (name: string) => defineFacet((_h, self) => self.contribute(Names, name));
		const host = createHost(noErrors);
		await host.load(
			[
				{ name: "@app/names", facet: provider(",") },
				{ name: "@app/x", facet: contributor("x") },
			],
			context,
		);
		const names = await host.registry(Names, context);
		expect(names.value).toBe("own,x");
		await host.reload(
			[
				{ name: "@app/names", facet: provider("+") },
				{ name: "@app/x", facet: contributor("y") },
			],
			context,
		);
		expect(names.value).toBe("own+y");
		await host.reload([{ name: "@app/x", facet: contributor("z") }], context);
		expect(() => names.value).toThrow("no plugin serves it here");
		await host.reload(
			[
				{ name: "@app/names", facet: provider(";") },
				{ name: "@app/x", facet: contributor("z") },
			],
			context,
		);
		expect(names.value).toBe("own;z");
		await host.close(context);
	});
});

/** A worker's title per session (v1: a string). */
const Title = remote("app.title", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { v: { state: { title: str() } } },
});

/** `Title` v2: an object; v1 consumers map back through `accepts`. */
const TitleV2 = evolve(Title, (e) => e.state("v", "title", obj({ text: str() })));

// 注册表版本演化：v1 读者通过新 provider 的 accepts[1].value 映射继续读取；provider 不再声明 accepts 1 时，
// 旧读者读到 "version 1 is not served here"。这验证 accepts 是运行时适配器，而不仅是类型声明。
describe("reload: registries' older readers (slice 7b §3)", () => {
	// old 是加载时从 NamesV1 取得的 RegistryValue，之后 provider 换成 v2。accepts[1].value 把 v2 的 string[] 映射回
	// string，因此 old.value 依次为 "a"、"a!"；第三次 reload 去掉 accepts，读取立刻抛出版本未服务。
	it("a reader of an older version follows the new provider's accepts[old].value; one it no longer serves waits", async () => {
		const NamesV1 = defineRegistry<string, string>("app.names", { version: 1 });
		const NamesV2 = defineRegistry<string, string[]>("app.names", { version: 2 });
		const provider = (map: ((names: string[]) => string) | undefined) =>
			defineFacet((h, self) => {
				h.serve(NamesV2, {
					compose: (table) => table.map(({ value }) => value),
					...(map === undefined ? {} : { accepts: { 1: { value: map } } }),
				});
				self.contribute(NamesV2, "a");
			});
		const host = createHost(noErrors);
		await host.load([{ name: "@app/names", facet: provider((names) => names.join(",")) }], context);
		const old = await host.registry(NamesV1, context);
		expect(old.value).toBe("a");
		await host.reload([{ name: "@app/names", facet: provider((names) => `${names.join("+")}!`) }], context);
		expect(old.value).toBe("a!");
		await host.reload([{ name: "@app/names", facet: provider(undefined) }], context);
		expect(() => old.value).toThrow("version 1 is not served here");
		await host.close(context);
	});
});

// 跨宿主 reload 的应用顺序：先 server，再 worker，最后 tab。旧 tab 的 v1 引用在 worker 安装带 accepts 的 v2 时被
// 映射为 live；worker 去掉 accepts 后，旧 tab 变 failed { waiting, contract_mismatch }；tab 自己 reload 到 v2 后
// 新引用绑定，旧引用 release。relayed() 的 workers Map 以 "session|S1" 为键取 worker 宿主。
describe("reload across hosts, in the app's order (slice 7b §11)", () => {
	// Title v1 的 title 是 string，TitleV2 改成 obj({ text })；serveV2 的 accept 参数决定是否声明 accepts 1。
	// old 是 tab 对 v1 的引用：worker 换 v2+accepts 后它仍 live（映射为 "two"）；去掉 accepts 后 waiting；
	// tab 改持 v2 的 fresh 引用后拿到 { text: "three" }。全程 server 本身不需要变化。
	it("server, then worker, then tab: an old tab is mapped, then waits for its version, then reloads its own code", async () => {
		const serveV1 = (h: FacetHost<TestPrincipal>) =>
			h.serve(Title, () => ({ variant: "v", members: { title: constant("one") } }));
		const serveV2 = (text: string, accept: boolean) => (h: FacetHost<TestPrincipal>) =>
			h.serve(
				TitleV2,
				() => ({ variant: "v", members: { title: constant({ text }) } }),
				accept ? { accepts: { 1: { state: { v: { title: (current) => current.text } } } } } : {},
			);
		const workerSet = (setup: (h: FacetHost<TestPrincipal>) => void) => [
			{
				name: "@test/worker",
				facet: defineFacet<TestPrincipal>((h) => {
					serveNotes(h, PlacedNotes);
					setup(h);
				}),
			},
		];
		const { tab, server, workers } = await relayed({ worker: serveV1 });
		const old = tab.hold(Title, { session: "S1" }, context);
		await transported();
		expect(old.title.value).toBe("one");
		const worker = workers.get("session|S1")!;
		// The server installs first: nothing of Title changes there.
		await server.reload([{ name: "@test/server", facet: defineFacet<TestPrincipal>(() => {}) }], context);
		// The worker installs v2 accepting v1: the old tab is mapped.
		await worker.reload(workerSet(serveV2("two", true)), context);
		await transported();
		expect(old.state.value).toEqual({ kind: "live" });
		expect(old.title.value).toBe("two");
		// A worker install without the adapter: the old tab waits for its version (a remote failure is its reads' error).
		await worker.reload(workerSet(serveV2("three", false)), context);
		await transported();
		expect(old.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { code: "contract_mismatch" } },
		});
		// The tab reloads its own code: its new hold (v2) binds; the old one is released.
		const fresh = tab.hold(TitleV2, { session: "S1" }, context);
		old.release();
		await transported();
		expect(fresh.title.value).toEqual({ text: "three" });
		await server.close(context);
	});
});

// staging 期间的同步 abort：新 facet 的 setup 在执行时调用 abort.abort()。reload 必须拒绝（这里用 .catch 吞掉
// 错误只观察结果），并且不提交——引用读到的仍是旧值 1 而不是新值 2。
describe("reload: an abort while staging (fix round 1)", () => {
	// abort 在 changed 的 setup 内同步触发；reload 的 Promise 被 .catch 吞掉（这里只关心状态）。
	// ref 在 reload 前后都读 n=1，证明 commit 未发生；withAbortSignal 把 AbortSignal 包成 Chord Context。
	it("does not commit when the context is aborted by the synchronous setup", async () => {
		const T = local("astra.cancel", { version: 1, params: {}, members: { n: int() } });
		const host = createHost({ onError: () => {} });
		const original = defineFacet((h) => h.serve(T, () => ({ n: constant(1) })));
		await host.load([{ name: "@astra/cancel", facet: original }], context);
		const ref = await host.get(T, {}, context);
		const abort = new AbortController();
		const changed = defineFacet((h) => {
			abort.abort();
			h.serve(T, () => ({ n: constant(2) }));
		});
		await host
			.reload([{ name: "@astra/cancel", facet: changed }], withAbortSignal(abort.signal, context))
			.catch(() => {});
		await flushed();
		const actual = ref.n.value;
		ref.release();
		await host.close(context);
		expect(actual).toBe(1);
	});
});
