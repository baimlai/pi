// 验证 HTTP 默认安全头、nonce 和策略缓存的生命周期；此处不发送请求。
// Tests of the default headers (security baseline (4), "A CSP nonce per response"): the fixed ones, `X-Frame-Options`
// only without framers, the CSP with the response's nonce, the WebSocket origin, the framers (a relay's too) and
// contributed sources; a fresh nonce each time; and headers checked as they are set, several lines for a list.

import { describe, expect, it } from "vitest";
import type { Admitted } from "../../../src/node/http/admission.ts";
import { AnswerHeaders, DefaultHeaders, Nonces } from "../../../src/node/http/headers.ts";
import { composeRouter, type HttpContribution } from "../../../src/node/http/router.ts";
import type { RegistryTable } from "../../../src/registries/index.ts";
import { expectCollected } from "../../support.ts";

/** The router of one contribution. */
// 把单份 HTTP 贡献包装成 @app/a 的注册表，再组合为 Router；输入贡献，返回路由器。
// 例如 routerOf({framers:["https://a.example"]}) 提供 iframe 来源；无网络，冲突回调刻意忽略。
function routerOf(value: HttpContribution) {
	// 泛型限定贡献值类型；这里手工提供一个条目，不测试贡献排序。
	const table: RegistryTable<HttpContribution> = [{ plugin: "@app/a", version: 1, value }];
	// 组合路由器，空 report 不收集冲突；返回值供默认头生成器读取。
	return composeRouter(table, { report: () => {} });
}

/** The default headers of one component. */
// 多个用例共享的默认头构建器，其内部按路由器弱引用缓存 CSP 模板。
const defaults = new DefaultHeaders();

/** `defaults.of`. */
// 转发调用到 defaults.of；Parameters 提取方法参数元组，...args 收集后再展开，不做运行时校验。
// 例如传 LOCAL、router、"N"，得到带 nonce N 的头；会更新 defaults 的策略缓存。
function defaultHeaders(...args: Parameters<DefaultHeaders["of"]>) {
	// 把原参数原样传给同一个构建器。
	return defaults.of(...args);
}

// 人工准入结果：本地 http 来源，没有额外 framer、允许域名或中继。Admitted 由编译期约束。
const LOCAL: Admitted = {
	provenance: { kind: "local" },
	origin: "http://127.0.0.1:8788",
	framer: undefined,
	allowed: undefined,
	relay: undefined,
};

// 登记默认头机制测试。
describe("default headers", () => {
	// 此例给空路由器和本地来源，精确比较五个默认头及 CSP；nonce N 是固定示例，不代表随机生成。
	it("refuse caching, sniffing, referrers and framing; the CSP allows scripts by nonce and the WebSocket origin", () => {
		// 为本地响应创建头，空贡献不增加额外来源。
		const headers = defaultHeaders(LOCAL, routerOf({}), "N");
		// lines() 是迭代器；展开成数组比较完整头名、值与顺序。
		expect([...headers.lines()]).toEqual([
			["Cache-Control", "no-store"],
			["X-Content-Type-Options", "nosniff"],
			["Referrer-Policy", "no-referrer"],
			["X-Frame-Options", "DENY"],
			[
				"Content-Security-Policy",
				"default-src 'none'; script-src 'self' 'nonce-N'; connect-src 'self' ws://127.0.0.1:8788; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
			],
		]);
	});

	// 此例添加允许嵌入者和脚本/图片来源，检查 CSP 合并与 https→wss 映射，并去掉冲突的 X-Frame-Options。
	it("name the framers (a relay's included) without X-Frame-Options, and add contributed sources", () => {
		// 构造带 framer、img-src 与 script-src 的路由器贡献。
		const router = routerOf({
			// 允许这个来源嵌入页面，仅作为 CSP 数据。
			framers: ["https://a.example"],
			// 额外允许 data 图片和 CDN 脚本，原有 self/nonce 仍保留。
			csp: { "img-src": ["data:"], "script-src": ["https://cdn.example"] },
		});
		// 浅展开本地样例再覆盖来源与 framer；这个构造只测头合并，不声称经过 admit 中继认证。
		const relayed = { ...LOCAL, origin: "https://me.relay.example", framer: "https://relay.example" };
		// 把路由器贡献和本次请求 framer 一起用于响应头。
		const headers = defaultHeaders(relayed, router, "N");
		// 有 framer 时用 CSP 指定来源，不发送只支持 DENY 等值的 X-Frame-Options。
		expect(headers.has("x-frame-options")).toBe(false);
		// 核对完整策略；读取时头名大小写无关。
		expect(headers.get("content-security-policy")).toBe(
			"default-src 'none'; script-src 'self' 'nonce-N' https://cdn.example; connect-src 'self' wss://me.relay.example; base-uri 'none'; form-action 'self'; frame-ancestors https://a.example https://relay.example; img-src data:",
		);
	});

	// 未准入时只保留 self 连接来源；再抽样生成一千 nonce，检查样本无重复且每个解码为16字节。
	// 随机样本无重复不是绝不碰撞的证明。
	it("before admission: no WebSocket origin; a nonce is 16 fresh random bytes each time", () => {
		// 两项 undefined 代表路由器与准入结果都尚未取得，不应凭空添加 WebSocket 来源。
		expect(defaultHeaders(undefined, undefined, "N").get("content-security-policy")).toContain("connect-src 'self';");
		// 创建独立随机池生成器。
		const nonces = new Nonces();
		// Array.from 回调调用 next 一千次，Set 去掉重复值用于样本检查。
		const made = new Set(Array.from({ length: 1_000 }, () => nonces.next()));
		// 本次抽样的一千值都不同。
		expect(made.size).toBe(1_000);
		// 逐项从 base64 解码，检查原始随机字节长度。
		for (const nonce of made) expect(Buffer.from(nonce, "base64").length).toBe(16);
	});

	// 重复使用一个路由器时策略模板可共享，但每次必须替换 nonce；中继来源由每次输入计算。
	// 本例检查输出策略内容，内部缓存的可回收性由下方 GC 用例检查。
	it("keep the CSP of local and allowed-host requests per router; a relayed one's never", () => {
		// 建立固定空路由器供重复调用使用。
		const router = routerOf({});
		// 保存 nonce A 的第一份策略字符串。
		const first = defaultHeaders(LOCAL, router, "A").get("content-security-policy");
		// 第二次使用同来源/路由器，但必须带新 nonce B。
		expect(defaultHeaders(LOCAL, router, "B").get("content-security-policy")).toBe(
			// 可选链只在 first 非 null/undefined 时替换；预期除 nonce 外文本相同。
			first?.replace("'nonce-A'", "'nonce-B'"),
		);
		// relay 字段非空使生成器走中继分支；verify 是未调用的占位函数。
		const relayed = { ...LOCAL, origin: "https://u1.relay.example", relay: { name: "r", verify: () => undefined } };
		// 当前中继来源必须体现在 WebSocket 策略中。
		expect(defaultHeaders(relayed, router, "C").get("content-security-policy")).toContain("wss://u1.relay.example");
	});

	// 同步用例先送入含换行/空格/NUL 的非法头，预期抛 TypeError；再检查大小写无关覆盖与多个 Set-Cookie。
	it("refuse a header name or value HTTP cannot carry; replace same-named ones; a list is one line per value", () => {
		// 创建空头集合。
		const headers = new AnswerHeaders();
		// 把执行包进箭头函数，让 expect 捕获防头注入的同步异常。
		expect(() => headers.set("X-Split", "a\r\nSet-Cookie: x=1")).toThrow(TypeError);
		// 头名含空格不是合法 HTTP token。
		expect(() => headers.set("X Bad", "1")).toThrow(TypeError);
		// 头值含 NUL 同样被拒绝。
		expect(() => headers.set("X-Nul", "a\0b")).toThrow(TypeError);
		// 列表中的每一项都校验，第二项换行不能混入。
		expect(() => headers.set("Set-Cookie", ["a=1", "b=2\n"])).toThrow(TypeError);
		// 先设小写名字与值 a。
		headers.set("content-security-policy", "a");
		// 同名不同大小写覆盖旧值，并保留最后设置的拼写。
		headers.set("Content-Security-Policy", "b");
		// 合法列表生成两条头行，不合并为单个 cookie 值。
		headers.set("Set-Cookie", ["a=1", "b=2"]);
		// lines() 是迭代器；展开成数组比较完整头名、值与顺序。
		expect([...headers.lines()]).toEqual([
			["Content-Security-Policy", "b"],
			["Set-Cookie", "a=1"],
			["Set-Cookie", "b=2"],
		]);
	});
});

// GC 指垃圾回收；以下检查弱缓存没有使路由器永久存活。
describe("GC", () => {
	// 此异步例创建策略缓存后移除唯一显式强引用，再用 WeakRef 观察对象能否回收；不返回业务数据。
	it("keeps no policy of a router gone", async () => {
		// 单独构建器会在测试末尾仍存活，便于暴露错误的强缓存。
		const own = new DefaultHeaders();
		// ReturnType 提取 routerOf 返回类型；联合 undefined 允许随后清空强引用。
		let router: ReturnType<typeof routerOf> | undefined = routerOf({ framers: ["https://a.example"] });
		// 实际填充路由器对应的 CSP 缓存。
		own.of(LOCAL, router, "N");
		// WeakRef 允许观察，不负责保活对象。
		const ref = new WeakRef(router);
		// 移除测试变量持有的强引用。
		router = undefined;
		// 辅助函数触发/等待回收；若缓存强持有该对象则失败。
		await expectCollected(ref);
	});
});
