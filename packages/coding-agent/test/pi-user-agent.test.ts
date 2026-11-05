// 验证本机运行时信息的 User-Agent 格式，函数只拼字符串，不向 pi.dev 请求。
import { describe, expect, it } from "vitest";
import { getPiUserAgent } from "../src/utils/pi-user-agent.ts";

// 注册格式测试；describe 回调只组织用例，不决定实际运行时版本。
describe("getPiUserAgent", () => {
	// 例：版本传 1.2.3，应得到带平台/运行时/架构的固定格式；失败由 expect 抛给测试器。
	it("formats the user agent expected by pi.dev", () => {
		// 条件运算符优先选择 Bun 版本，否则 Node；模板字符串将实际版本插入文字。
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		// 调用产品函数，用测试版本号生成请求头字符串。
		const userAgent = getPiUserAgent("1.2.3");

		// 严格比较整串，包含本机 platform/arch；没有覆盖其他操作系统上的值。
		expect(userAgent).toBe(`pi/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		// 正则再检查结构：版本不含空白/括号，分号分隔三段环境信息。
		expect(userAgent).toMatch(/^pi\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
