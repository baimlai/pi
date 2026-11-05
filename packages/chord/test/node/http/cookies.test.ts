// 用人工 cookie 和虚拟时间验证签名与默认属性；不读浏览器或用户登录状态。
// Tests of cookies (security baseline (5)): the safe defaults, `Secure` on a remote origin, a signature checked when
// read back (a changed value, another name or secret reads nothing), and an expiry signed with it.

import { describe, expect, it, vi } from "vitest";
import type { Provenance } from "../../../src/node/http/admission.ts";
import { cookie, type HttpRequest, readCookie } from "../../../src/node/http/index.ts";

/** A request carrying `header` as its `Cookie`, from `provenance`. */
// 构造 cookie 测试所需的局部请求；输入头文本与可选来源，返回类型被断言为 HttpRequest。
// 例如 requestWith("session=x") 默认是本地请求；只创建 Headers，无网络或真实认证。
function requestWith(header: string, provenance: Provenance = { kind: "local" }): HttpRequest {
	// 把 header 放入 Cookie 头并保留来源；as 只影响类型检查，运行时对象仍只有这两个字段。
	return { headers: new Headers({ cookie: header }), provenance } as HttpRequest;
}

// 登记 cookie 机制的三个独立用例。
describe("cookies", () => {
	// 此同步用例输入人工本地/远程请求，检查生成的 Set-Cookie 字符串；不把 cookie 安装到浏览器。
	// 例如空格编码成 %20，60.5 秒的 Max-Age 向下取整为 60。
	it("are HttpOnly, Path=/, SameSite=Strict by default; Secure on a remote origin; Lax and Max-Age when asked", () => {
		// 创建没有已有 cookie 的本地请求。
		const local = requestWith("");
		// 使用固定测试密钥签名 a b，正则只约束编码、签名形状与安全属性。
		expect(cookie("session", "a b", { secret: "s", request: local })).toMatch(
			/^session=a%20b\.\.[A-Za-z0-9_-]{43}; HttpOnly; Path=\/; SameSite=Strict$/,
		);
		// 标记为 remote；example 域名仅作为数据，不会访问。
		const remote = requestWith("", { kind: "remote", host: "notes.example.com" });
		// 显式选 Lax 和有效期，检查远程来源额外带 Secure。
		expect(cookie("session", "x", { secret: "s", request: remote, sameSite: "Lax", maxAge: 60.5 })).toMatch(
			/; HttpOnly; Path=\/; SameSite=Lax; Secure; Max-Age=60$/,
		);
	});

	// 此用例先签名再读回，然后分别换密钥、改值、改名和去掉签名；预期只有原 cookie 返回 owner:1。
	it("read back only with their signature, name and secret", () => {
		// 用固定测试密钥生成完整 Set-Cookie 值。
		const set = cookie("session", "owner:1", { secret: "s", request: requestWith("") });
		// 只留下 name=value 部分供 Cookie 请求头使用；! 告诉 TypeScript 此处首项存在，不做运行时检查。
		const value = set.split(";")[0]!;
		// 前面夹一个无关 cookie，确认按指定名字取出并验签后解码。
		expect(readCookie(requestWith(`other=1; ${value}`), "session", "s")).toBe("owner:1");
		// 更换密钥，原签名失效。
		expect(readCookie(requestWith(value), "session", "t")).toBeUndefined();
		// 只改明文值而保留签名，应拒绝。
		expect(readCookie(requestWith(value.replace("owner", "admin")), "session", "s")).toBeUndefined();
		// 签名覆盖名字，所以重命名也不能复用。
		expect(readCookie(requestWith(value.replace("session", "sess")), "sess", "s")).toBeUndefined();
		// 缺少签名字段不能读为合法值。
		expect(readCookie(requestWith("session=unsigned"), "session", "s")).toBeUndefined();
		// 没有 cookie 时返回 undefined。
		expect(readCookie(requestWith(""), "session", "s")).toBeUndefined();
	});

	// Opus's recheck R3: a copied cookie stayed valid past its Max-Age.
	// 此用例只替换 Date 的时钟：先验原值，再伪造更晚到期时间，最后推进 61 秒验证过期。
	// try/finally 保证即便断言失败也恢复真实时间，避免影响其他测试。
	it("refuse a cookie past its signed expiry, and one whose expiry was changed", () => {
		// 仅让 Date 受 Vitest 假时间控制，不替换其他计时 API。
		vi.useFakeTimers({ toFake: ["Date"] });
		// 把假时钟期间的断言包住，收尾一定执行。
		try {
			// 值中故意带点，检查从右边分隔有效期和签名的实现。
			const set = cookie("session", "a.b", { secret: "s", request: requestWith(""), maxAge: 60 });
			// 只留下 name=value 部分供 Cookie 请求头使用；! 告诉 TypeScript 此处首项存在，不做运行时检查。
			const value = set.split(";")[0]!;
			// 推进时间前原 cookie 可用，并保留值内的点。
			expect(readCookie(requestWith(value), "session", "s")).toBe("a.b");
			// 数组解构分别接载荷、有效期、签名；默认空串只在对应元素 undefined 时使用。
			// 截到倒数第二个点之前，保留带点的值与 cookie 名称。
			// 倒数第二段是秒单位有效期。
			// 最后一段是原签名。
			const [payload = "", expires = "", signature = ""] = [
				value.slice(0, value.lastIndexOf(".", value.lastIndexOf(".") - 1)),
				value.split(".").at(-2),
				value.split(".").at(-1),
			];
			// 将有效期延长一小时，但故意不重新签名。
			const extended = `${payload}.${Number(expires) + 3600}.${signature}`;
			// 签名覆盖有效期，伪造版本被拒绝。
			expect(readCookie(requestWith(extended), "session", "s")).toBeUndefined();
			// 把测试时钟推进 61 秒，超过原 60 秒有效期。
			vi.advanceTimersByTime(61_000);
			// 原签名仍匹配，但有效期已过，也不能读回。
			expect(readCookie(requestWith(value), "session", "s")).toBeUndefined();
			// 无论上方成功还是抛错，都进入恢复步骤。
		} finally {
			// 移除假 Date，让后续用例使用真实时间。
			vi.useRealTimers();
		}
	});
});
