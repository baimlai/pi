// 测试 Chord v1 向四个客户端发布同一次状态修改时，编码次数和线上的帧内容。
// Entry 8: what a change costs the provider. The diff is computed once per change; each feed (one per connection and
// member) encodes it with its own stateful encoder and its link serializes it.
import assert from "node:assert/strict";
import { arr, obj, str } from "@earendil-works/pi-schema";
import { describe, it, vi } from "vitest";
import type * as delta from "../../src/delta/index.ts";
import { type Ctx, createHost, hostNamed, memoryLinkPair, method, remote } from "../../src/old/index.ts";
import { CountingLink, stateFrames } from "./fixtures/counting.ts";

// hoisted 让计数对象先于模块 mock 初始化；两个字段分别记录创建编码器和调用 encode 的次数。
const counts = vi.hoisted(() => ({ encoders: 0, encodes: 0 }));

// mock 工厂取得原模块，保留其他导出，只包装 encoder；例如一次 encode 会先累加再执行原算法。
// 这里测的是包装点的调用次数，不是 CPU 时间或所有内部 diff 操作的次数。
vi.mock("../../src/delta/index.ts", async (importOriginal) => {
	// typeof delta 让 importOriginal 的结果沿用原模块的开发期类型。
	const original = await importOriginal<typeof delta>();
	// 展开原导出；后面的同名 encoder 覆盖原函数。
	return {
		...original,
		// 每次创建编码流记录一次；inner 仍是真实实现，避免 mock 掩盖编码行为。
		encoder: () => {
			counts.encoders++;
			const inner = original.encoder();
			return {
				// Parameters<F>[0] 提取原 encode 的第一个参数类型，不手写另一份操作类型。
				encode: (ops: Parameters<typeof inner.encode>[0]) => {
					// 记录调用后原样转交操作，返回真实编码结果。
					counts.encodes++;
					return inner.encode(ops);
				},
			};
		},
	};
});

// 等待计时器至少经过 ms 毫秒，返回 Promise；例：sleep(10) 给异步链路处理留出时间，不保证精确耗时。
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// List 位于 server，空输入；main 暴露字符串数组 items 与接收一个字符串、无结果的 add。
const List = remote("t.e8-cost", {
	version: 1,
	input: obj({}, { open: true }),
	host: hostNamed("server"),
	variants: { main: { state: { items: arr(str()) }, methods: { add: method(str()) } } },
});

describe("provider cost", () => {
	// 创建四个身份相同的客户端，记录基线后只改一次 items；结束时关闭服务端。
	it("one change to K clients: K encodes (one per feed), one frame per link, the same ops on every link", async () => {
		// 忽略测试中的后台错误输出；显式断言仍决定本用例成功或失败。
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		// 工厂只声明状态与方法，items 的初始值是空数组。
		server.serve(List, (_input, _principal, self) => {
			const items = self.state("items", arr(str()), []);
			return {
				variant: "main",
				items,
				add: (text: string, ctx: Ctx) => {
					// change 在一次同步草稿事务中追加 text；库负责计算并发布变化。
					items.change(ctx, (draft) => {
						draft.push(text);
					});
				},
			};
		});
		// K 是本用例固定规模，不是在不同客户端数上做性能基准。
		const K = 4;
		// Array.from 的回调为索引 0..3 分别建立客户端和可记录收发帧的链路。
		const clients = Array.from({ length: K }, (_, i) => {
			// 内存链路两端分别接入 server 和客户端，不联网。
			const [down, up] = memoryLinkPair();
			// One principal: every client reaches the same object.
			server.accept(down, { principal: { user: "u" } });
			// CountingLink 包装 up 并保存收到/发送的帧，不改变业务协议。
			const link = new CountingLink(up);
			// 每个客户端名不同，但 server 赋予它们同一 principal，故访问同一对象。
			const host = createHost({
				self: { kind: "host" },
				name: `browser${i}`,
				kind: "client",
				upstream: { link, principal: { kind: "server" } },
				onError: () => {},
			});
			// hold 返回仍可能加载中的引用；稍后统一等待初始快照。
			return { host, link, ref: host.hold(List, {}) };
		});
		// 排除建立引用和初始 hydration 的成本，再开始本次修改的计数。
		await Promise.all(clients.map((client) => client.ref.ready));
		const encoders = counts.encoders;
		const encodes = counts.encodes;
		// 为每条链路保存已有 state 帧数，后面 slice 仅取修改之后的帧。
		const before = clients.map((client) => stateFrames(client.link.received).length);
		// 非空断言 ! 告诉 TypeScript 固定数组中第一个元素存在；运行时不会额外检查。
		await clients[0]!.ref.add("x");
		// 留出异步交付时间；正确性由后面的帧和状态断言检查。
		await sleep(10);
		// 一次修改分别经过四个 feed 的编码器，每个调用一次；不应创建新编码流。
		assert.equal(counts.encodes - encodes, K, "one encode per feed");
		assert.equal(counts.encoders, encoders, "no new streams for a change");
		// 按各自基线截取，避免把初始快照算作修改帧。
		const frames = clients.map((client, i) => stateFrames(client.link.received).slice(before[i]));
		// 每个连接只产生一帧状态更新。
		for (const list of frames) assert.equal(list.length, 1);
		// 将 ops 转成字符串后去重，比较每条链路携带的操作内容。
		const ops = frames.map((list) => JSON.stringify(list[0]?.ops));
		assert.equal(new Set(ops).size, 1, "every link carries the same ops");
		// 还要检查客户端真正应用更新，而不仅是观察到线上的帧。
		for (const client of clients) assert.deepEqual(client.ref.items.value, ["x"]);
		// 关闭服务端结束连接及对象；不对生产环境大规模性能作推断。
		await server.close();
	});
});
