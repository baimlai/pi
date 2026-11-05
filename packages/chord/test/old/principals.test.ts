// 测试 Chord v1 如何把应用定义的调用者身份传给工厂、方法、任务和跨主机请求。
import assert from "node:assert/strict";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, it } from "vitest";
import {
	type Ctx,
	createHost,
	defineFacet,
	type FacetApi,
	type Host,
	hostNamed,
	local,
	memoryLinkPair,
	method,
	remote,
} from "../../src/old/index.ts";

/** An app's principals: what TypeScript narrows on. */
type Principal =
	// kind 是联合类型的区分字段；检查 guest 分支后，TypeScript 才允许读取 id。
	| { readonly kind: "owner" }
	| { readonly kind: "guest"; readonly id: string }
	| { readonly kind: "server" }
	| { readonly kind: "host" };

// 把身份转成对象身份键；输入 Principal，返回字符串，无外部副作用。
// 例如 guest/g1 得到 guest:g1；两个不同对象只要生成同一个键，就代表同一个身份。
const principalKey = (principal: Principal): string =>
	principal.kind === "guest" ? `guest:${principal.id}` : principal.kind;

// 本地契约声明无输入字段、一个无参数且返回字符串的 who 方法；obj 的 open 允许额外字段。
const Who = local("t.who", {
	version: 1,
	input: obj({}, { open: true }),
	members: { who: method(undefined, str()) },
});

describe("principals", () => {
	// 此异步用例创建类型化主机与插件，调用 who 并关闭主机；预期 guest 工厂中的方法仍以宿主身份执行。
	it("factories, methods and contexts see the app's principal type", async () => {
		// <Principal> 限定开发期可接受的身份；principalKey 决定运行期对象身份，泛型本身不做运行时校验。
		const host = createHost<Principal>({ self: { kind: "host" }, principalKey });
		// defineFacet 的泛型把同一个 Principal 传给 setup API、工厂和它们创建的上下文。
		const facet = defineFacet<Principal>((api) => {
			// 把类型化 API 赋给默认身份为 unknown 的通用接口，检查两者可兼容。
			const plain: FacetApi = api;
			// void 仅丢弃表达式结果，不调用 API，也不改变 plain。
			void plain;
			// 工厂接收输入、为其创建对象的身份、对象声明接口；这里忽略空输入。
			api.serve(Who, (_input, principal, self) => {
				// Narrowing on `kind` needs no cast.
				const created = principal.kind === "guest" ? `guest ${principal.id}` : principal.kind;
				// 声明随对象激活启动的后台任务；这里只检查 ctx 的身份类型，不做网络或文件操作。
				self.task(async (ctx) => {
					// 索引访问类型 Principal["kind"] 表示所有合法 kind 字面量的联合。
					const kind: Principal["kind"] = ctx.principal.kind;
					// 避免未使用变量；不会验证具体是哪一种身份。
					void kind;
				});
				// 捕获创建身份，调用时再读取 ctx 的身份，便于同时观察两个阶段。
				return { who: (ctx) => `${created}, called by ${ctx.principal.kind}` };
			});
		});
		// 对象展开把 setup/uses 合入命名插件；install 注册该插件。
		await host.install({ name: "who", ...facet });
		// hold 同步返回引用；此处为 guest/g1 获取对象，而不是改变宿主自己的 self。
		const guest = host.hold(Who, {}, { principal: { kind: "guest", id: "g1" } });
		// root 的入口身份是 guest；Who 内部执行方法时使用宿主身份，故结果中的 called by 是 host。
		assert.equal(
			await host.root((ctx) => guest.who(ctx), { principal: { kind: "guest", id: "g1" } }),
			"guest g1, called by host",
		);
		// A typed host, facet API and context are usable where Chord's untyped ones are expected.
		const untyped: Host = host;
		// 同样只做编译期赋值兼容检查。
		void untyped;
		// 这个 root 没有业务返回值；仅把其上下文赋给通用 Ctx 类型。
		await host.root(async (ctx) => {
			const plain: Ctx = ctx;
			void plain;
		});
		// 下两项故意违反类型规则；@ts-expect-error 必须紧贴目标，tsc 检查预期错误确实存在。
		// @ts-expect-error: not a principal of this app
		host.hold(Who, {}, { principal: { kind: "stranger" } });
		// @ts-expect-error: a pattern names fields of the app's principals
		void host.invalidatePrincipal({ kind: "guest", name: "g1" }).catch(() => {});
		// close 结束对象、任务和引用；本用例没有启动真实外部服务。
		await host.close();
	});

	// 创建两个键相同但对象引用不同的身份，验证只激活一个对象，且失效操作保护宿主自己的对象。
	it("the host's own principal is recognized by key: an equal object reaches the same objects", async () => {
		// self 的键为 host，后面另一个 {kind:"host"} 也会得到同一键。
		const host = createHost<Principal>({ self: { kind: "host" }, principalKey });
		// 用闭包计数工厂实际运行次数，不以引用的个数推断对象个数。
		let created = 0;
		// 此工厂每次激活累加一次，方法固定返回 one。
		host.serve(Who, () => {
			created++;
			return { who: () => "one" };
		});
		// 不传 principal 默认使用 self；第二次传另一个内容相同的对象。
		const own = host.hold(Who, {});
		const equal = host.hold(Who, {}, { principal: { kind: "host" } });
		// 等待两个引用完成激活后，才检查工厂计数，避免读取未完成的异步结果。
		await Promise.all([own.ready, equal.ready]);
		// 一个工厂实例服务两个引用。
		assert.equal(created, 1);
		// Never disposed as a matching principal: it is the host's own.
		await host.invalidatePrincipal({ kind: "host" });
		// 即使模式匹配，宿主身份不会被 invalidatePrincipal 销毁。
		assert.equal(own.status, "live");
		// 清理主机持有的对象。
		await host.close();
	});

	// 建立 server→worker 和 browser→server 两条内存链路，对比父主机直调与转发来客的身份。
	it("a child's parent acts as the principal the child gave `connect`; relayed callers keep theirs", async () => {
		// 远程对象被放在 worker；who 返回创建该对象时收到的 principalKey。
		const Echo = remote("t.echo", {
			version: 1,
			input: obj({}, { open: true }),
			host: hostNamed("worker"),
			variants: { main: { methods: { who: method(undefined, str()) } } },
		});
		// server 自己的 principal 是 host，与 worker 为父链路配置的 server 身份不同。
		const server = createHost<Principal>({ name: "server", self: { kind: "host" }, principalKey });
		// 内存链路对的两端互通，不使用真实 socket。
		const [down, up] = memoryLinkPair();
		// server 信任 down 为 worker 主机链路，并给其回调身份 host。
		server.accept(down, { kind: "host", name: "worker", principal: { kind: "host" } });
		// worker 把来自父主机自身代码的请求认作 server。
		const worker = createHost<Principal>({
			name: "worker",
			self: { kind: "host" },
			principalKey,
			upstream: { link: up, principal: { kind: "server" } },
		});
		// 捕获每个对象的创建身份；方法返回其稳定字符串，便于断言。
		worker.serve(Echo, (_input, principal) => ({ variant: "main", who: () => principalKey(principal) }));
		// 另建浏览器链路；server 为该链路盖上 guest/g1 身份，客户端不能自行选择此身份。
		const [browserDown, browserUp] = memoryLinkPair();
		server.accept(browserDown, { principal: { kind: "guest", id: "g1" } });
		// kind:client 不参与主机代码版本协调；这里仍是内存测试端。
		const browser = createHost<Principal>({
			name: "browser",
			kind: "client",
			self: { kind: "host" },
			upstream: { link: browserUp, principal: { kind: "server" } },
		});
		// 父主机直接访问 worker 时，worker 使用 connect 的 server 身份。
		assert.equal(await server.hold(Echo, {}).who(), "server");
		// 路由允许所有测试身份，解析为已有 down；真实应用需在 authorize 中决定权限。
		server.route("worker", {
			authorize: () => true,
			resolve: async () => down,
			principal: () => ({ kind: "host" }),
		});
		// 转发请求保留 server 认证得到的来客身份，不替换为 server 或 route.principal。
		assert.equal(await browser.hold(Echo, {}).who(), "guest:g1");
		// 按客户端、子主机、父主机顺序关闭，释放内存链路及对象。
		await browser.close();
		await worker.close();
		await server.close();
	});

	// 故意省略必填身份；同时检查 TypeScript 的报错和 JavaScript 入口的运行期拒绝。
	it("refuses a host, a parent link or a route without its principal", () => {
		// @ts-expect-error: `self` is required
		assert.throws(() => createHost({ name: "x" }), /needs `self`/);
		// 合法宿主作为后续两项错误配置的测试夹具。
		const host = createHost({ self: "host" });
		// 省略 down，只取用于 connect/route 的另一端；逗号是数组解构的跳过语法。
		const [, up] = memoryLinkPair();
		// @ts-expect-error: `principal` is required
		assert.throws(() => host.connect(up, {}), /connect needs `principal`/);
		// 路由的 principal 函数也不可省略；authorize/resolve 不能替代它。
		assert.throws(
			// @ts-expect-error: `principal` is required
			() => host.route("w:", { authorize: () => true, resolve: async () => up }),
			/needs `principal`/,
		);
	});
});
