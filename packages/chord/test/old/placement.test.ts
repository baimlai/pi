// 测试 Chord v1 由契约和规范化输入确定目标主机，调用方不能把对象搬到任意地址。
import assert from "node:assert/strict";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { describe, it } from "vitest";
import {
	bind,
	createHost,
	type Facet,
	type Frame,
	type Host,
	hostFamily,
	hostNamed,
	isChordError,
	type Link,
	memoryLinkPair,
	method,
	PROTOCOL_VERSION,
	remote,
} from "../../src/old/index.ts";

// 等一次 Node 事件循环调度，返回无值 Promise；例如 await tick() 让内存链路握手继续推进。
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Lives on `session:` + its input's `session`. */
const Note = remote("t.note", {
	// 版本、输入 schema 和 host 都进入契约；S1 的笔记无论 id 是什么都位于 session:S1。
	version: 1,
	input: obj({ session: str(), id: str() }, { open: true }),
	host: hostFamily("session:", "session"),
	variants: { main: { methods: { where: method(undefined, str()) } } },
});

/** Lives on `server`. */
const Catalog = remote("t.catalog", {
	// Catalog 的地址固定为 server，不依赖空输入中的任何字段。
	version: 1,
	input: obj({}, { open: true }),
	host: hostNamed("server"),
	variants: { main: { methods: { where: method(undefined, str()) } } },
});

/** A server with two session hosts as children; every host serves what it may and reports its name. */
// 无参数创建三台内存主机，返回 server、两个 session 主机及异步清理函数；有连接/对象注册副作用。
// 流程是注册 Catalog、建立两个子链路、配置 session: 路由；例：server.hold(Note,{session:"S1",id:"a"}) 会去 S1。
function cluster() {
	// server 自身身份为 host；错误回调置空，只为测试避免后台输出。
	const server = createHost({ name: "server", self: "host", onError: () => {} });
	// 工厂返回 main 变体，where 固定说明自己在 server。
	server.serve(Catalog, () => ({ variant: "main", where: () => "server" }));
	// Map 的泛型限定开发期键/值；保存子主机和 server 端链路，供路由与清理使用。
	const children = new Map<string, Host>();
	const links = new Map<string, Link>();
	// 输入主机名，建立一对子链路并注册 Note，返回主机和下行端；例如 child("session:S1")。
	const child = (name: string) => {
		// down 接 server，up 接新主机；两端只在当前进程中传递帧。
		const [down, up] = memoryLinkPair();
		// 按名称保存 server 端，resolve 后面以此找到已连接子主机。
		links.set(name, down);
		// server 把此链路认作受信的指定主机，而非普通客户端。
		server.accept(down, { kind: "host", name, principal: "server-side" });
		// 子主机将父主机自身发来的请求认作 server。
		const host = createHost({ name, self: "host", upstream: { link: up, principal: "server" }, onError: () => {} });
		// 解构规范化输入中的 id，方法通过闭包返回实际主机名与 id。
		host.serve(Note, ({ id }) => ({ variant: "main", where: () => `${host.name} ${id}` }));
		// 清理函数后面需要遍历所有子主机。
		children.set(name, host);
		// 属性简写等价于 {host:host,down:down}。
		return { host, down };
	};
	// 此夹具固定两个 session；它们名称满足 Note 的 session: 前缀约束。
	const s1 = child("session:S1");
	const s2 = child("session:S2");
	// 清理所有子主机再关闭 server；返回 Promise<void>，调用方必须 await。
	const close = async () => {
		for (const host of children.values()) await host.close();
		await server.close();
	};
	// Relays need a route (where authorization lives); it finds the connected child.
	server.route("session:", {
		// 测试允许所有路由；生产应用的授权应在此做决定。
		authorize: () => true,
		// ! 只消除 TypeScript 的 undefined 分支；本夹具确实只访问已存入的两个名字。
		resolve: async (name) => links.get(name)!,
		// 子主机回调时采用其名称作为身份。
		principal: (name) => name,
	});
	// 暴露调用测试所需的主机，不暴露内部两个 Map。
	return { server, s1: s1.host, s2: s2.host, close };
}

describe("placement", () => {
	// 从 server 和 S1 发起不同输入，断言契约自动选择本地、子主机或父主机；结束关闭夹具。
	it("a get goes where the contract places the input: here, a child, or the parent, never named by the caller", async () => {
		const { server, s1, close } = cluster();
		// 给异步 hello 握手一次调度机会。
		await tick();
		// 只传 session/id，调用方没有单独填写目标主机的参数。
		assert.equal(await server.hold(Note, { session: "S1", id: "a" }).where(), "session:S1 a");
		assert.equal(await server.hold(Note, { session: "S2", id: "b" }).where(), "session:S2 b");
		// From a session host: its own notes locally, the other session's through the server, the catalog upstream.
		assert.equal(await s1.hold(Note, { session: "S1", id: "c" }).where(), "session:S1 c");
		assert.equal(await s1.hold(Catalog, {}).where(), "server");
		// 显式结束三台主机。
		await close();
	});

	// 在普通 serve 与 reload 两条入口错误放置类型，预期同步异常或拒绝，不允许悄悄异地提供。
	it("serve refuses a type the host is not the place of, also at a reload", async () => {
		// session:S1 不能提供固定在 server 的 Catalog。
		const host = createHost({ name: "session:S1", self: "host", onError: () => {} });
		assert.throws(
			() => host.serve(Catalog, () => ({ variant: "main", where: () => "" })),
			/t\.catalog is declared for server, but session:S1 serves it/,
		);
		// server 同样不满足 Note 的 session: 主机族。
		const server = createHost({ name: "server", self: "host", onError: () => {} });
		assert.throws(
			() => server.serve(Note, () => ({ variant: "main", where: () => "" })),
			/t\.note is declared for session:<session>, but server serves it/,
		);
		// Facet 的 setup 会在 reload 准备阶段调用 serve；用相同错误验证该路径。
		const misplaced: Facet = {
			name: "misplaced",
			setup: (api) => api.serve(Note, () => ({ variant: "main", where: () => "" })),
		};
		// reject 只表明候选插件未被接受，不代表已经发布了一次错误位置变更。
		await assert.rejects(server.reload([misplaced]), /declared for session:<session>, but server serves it/);
		// 两台临时主机均清理。
		await host.close();
		await server.close();
	});

	// 绕过正常 hold API 手工发送协议帧，模拟客户端谎报目标；检查 relay 和 provider 都拒绝位置不匹配。
	it("a host refuses a hold its own contract places elsewhere, and a relay one whose target disagrees", async () => {
		const { server, close } = cluster();
		await tick();
		// 输入目标和未经类型确认的载荷，返回最先收到的 shape/gone；有链路与发送帧副作用。
		// 例如目标 S2 配输入 session:S1 应返回 gone；unknown 保留 wire 输入的信任边界。
		const holds = async (target: string, input: unknown): Promise<Frame | undefined> => {
			// raw 模拟不经过 Chord 客户端 API 的协议发送方。
			const [down, raw] = memoryLinkPair();
			server.accept(down, { principal: "guest" });
			// 保存所有收到的帧，回调 push 的返回值被 receive 忽略。
			const frames: Frame[] = [];
			raw.receive((frame) => frames.push(frame));
			// 先发送客户端 hello，再发送指定 at 的 hold；token 携带 Note 的契约描述。
			raw.send({ t: "hello", protocol: PROTOCOL_VERSION, name: "raw", kind: "client", codeVersion: 0 });
			raw.send({ t: "hold", id: 1, at: target, token: Note.description, input });
			// 最多等待 50 次调度；some 发现绑定 shape 或拒绝 gone 时提早结束。
			for (let i = 0; i < 50 && !frames.some((frame) => frame.t === "shape" || frame.t === "gone"); i++)
				await tick();
			// 没收到这两类帧时返回 undefined，由后面的断言报错，而不是无限等。
			return frames.find((frame) => frame.t === "shape" || frame.t === "gone");
		};
		// A client picks session:S2 for a note of S1: the relay refuses, nothing reaches S2.
		const relayed = await holds("session:S2", { session: "S1", id: "x" });
		// ?. 是可选链；没有收到帧时值为 undefined，也不能通过 gone 断言。
		assert.equal(relayed?.t, "gone");
		// 按 t 收窄联合类型后才能读取 error；另外检查拒绝确实与位置有关。
		assert.match(relayed?.t === "gone" ? relayed.error.message : "", /placement|does not live on session:S2/);
		// The right target is served.
		assert.equal((await holds("session:S1", { session: "S1", id: "x" }))?.t, "shape");
		// Addressed to the server itself, a note is refused by the server's own contract check.
		const direct = await holds("server", { session: "S1", id: "x" });
		assert.equal(direct?.t, "gone");
		await close();
	});

	// 缺少 session 的未类型化输入先应用默认值 S1，再决定位置；空字符串仍非法。
	it("the host comes from the normalized input: unknown fields and defaults do not change it", async () => {
		// str 的 default 是运行时规范化规则，不是 TypeScript 把字段变可选。
		const Doc = remote("t.doc-default", {
			version: 1,
			input: obj({ session: str({ default: "S1" }) }, { open: true }),
			host: hostFamily("session:", "session"),
			variants: { main: { methods: { where: method(undefined, str()) } } },
		});
		// 只在 S1 注册该类型，因此默认值必须把请求路由到 S1 才能成功。
		const { server, s1, close } = cluster();
		s1.serve(Doc, () => ({ variant: "main", where: () => "session:S1" }));
		await tick();
		// An untyped caller leaves the field out: the default places it.
		// as never 故意绕过静态参数检查以模拟 JavaScript 调用者；实际默认值由运行时代码应用。
		assert.equal(await server.hold(Doc, {} as never).where(), "session:S1");
		// 空 session 无法构成主机名，hold 同步抛出位置错误。
		assert.throws(() => server.hold(Note, { session: "", id: "x" }), /input field session names no host/);
		await close();
	});

	// 用同名契约更改位置，分别检查指纹、reload 与 bind；即使有旧版本适配器，也不能跨位置绑定。
	it("placement is part of the contract: a moved type is a breaking change, never bridged by an adapter", async () => {
		// 输入主机名，返回位于该主机的 v1 契约；例：at("server") 不创建实际对象。
		const at = (host: string) =>
			remote("t.moved", {
				version: 1,
				input: obj({}, { open: true }),
				host: hostNamed(host),
				variants: { main: { methods: { ping: method() } } },
			});
		// 名字和版本相同，只有 host 不同，也会得到不同指纹。
		assert.notEqual(at("server").fingerprint, at("session:S1").fingerprint);
		const host = createHost({ name: "server", self: "host", onError: () => {} });
		// 生成候选插件；version/place 控制新契约，accepts[1] 为恒等适配器，仅返回当前实现。
		const facet = (version: number, place: string): Facet => ({
			name: "moved",
			setup: (api) =>
				api.serve(
					remote("t.moved", {
						version,
						input: obj({}, { open: true }),
						host: hostNamed(place),
						variants: { main: { methods: { ping: method() } } },
					}),
					() => ({ variant: "main", ping: () => {} }),
					{ accepts: { 1: (current) => current } },
				),
		});
		// 安装原位契约并激活一个引用，使 reload 面对真实已绑定消费者。
		await host.install(facet(1, "server"));
		await host.get(at("server"), {});
		// Same version, other placement: a forgotten bump.
		await assert.rejects(host.reload([facet(1, "session:S1")]), /declared for session:S1|without a version bump/);
		// A new version that `accepts` version 1 but lives elsewhere: no adapter makes version 1 consumers bind.
		// v2 明确迁往 S1；下面直接调用 bind，隔离测试契约兼容规则。
		const moved = remote("t.moved", {
			version: 2,
			input: obj({}, { open: true }),
			host: hostNamed("session:S1"),
			variants: { main: { methods: { ping: method() } } },
		});
		// 错误码和消息一起确认位置不兼容；恒等适配器不会被当成跨主机迁移方案。
		assert.throws(
			() => bind(moved, { 1: (current) => current }, at("server")),
			(error) => isChordError(error, "contract_mismatch") && /lives on session:S1/.test(error.message),
		);
		await host.close();
	});

	// 这些编译期反例验证 hostFamily 字段约束；缺 host/空前缀另有运行时 throws 断言。
	it("types: the family's field is a required string of the input, and remote contracts need a host", () => {
		// session 必填字符串，count 数字，note 可选字符串；只有 session 可作为主机族键。
		const input = obj({ session: str(), count: num(), note: opt(str()) }, { open: true });
		// 空 main 变体足以声明此类型；本用例不创建对象或调用方法。
		const variants = { main: {} };
		// 这是合法的对照声明；随后的 @ts-expect-error 都必须由 tsc 确认确有错误。
		remote("t.ok", { version: 1, input, host: hostFamily("session:", "session"), variants });
		// @ts-expect-error: no such field
		remote("t.typo", { version: 1, input, host: hostFamily("session:", "sesion"), variants });
		// @ts-expect-error: not a string
		remote("t.number", { version: 1, input, host: hostFamily("session:", "count"), variants });
		// @ts-expect-error: optional
		remote("t.optional", { version: 1, input, host: hostFamily("session:", "note"), variants });
		// @ts-expect-error: a remote contract says where it lives
		assert.throws(() => remote("t.nowhere", { version: 1, input, variants }), /needs `host`/);
		assert.throws(() => hostFamily("", "session"), /prefix/);
	});
});
