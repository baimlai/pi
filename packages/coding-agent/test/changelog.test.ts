// 核对版本日志里的链接如何改写；所有 URL 只作文字比较，不请求 GitHub。
import { describe, expect, test } from "vitest";
import { type ChangelogEntry, normalizeChangelogLinks } from "../src/utils/changelog.ts";

// 类型注解在开发时要求三段版本和正文；content 在这组链接测试中并不参与计算。
const entry: ChangelogEntry = {
	// 组成目标标签 v0.79.0 的三个数值。
	major: 0,
	minor: 79,
	patch: 0,
	content: "",
};

// 分组回调注册两例测试，没有文件读写；test 的失败由 expect 抛给 Vitest。
describe("normalizeChangelogLinks", () => {
	// 输入包内相对链接和日志对象，逐段拼期望结果；例：README.md 固定到 v0.79.0，而非 main。
	test("rewrites package-relative changelog links to tag-pinned GitHub source links", () => {
		// 数组每项是一条 Markdown 链接，join 用换行连接，不引入文件系统路径解析。
		const markdown = [
			// 当前包的文件与锚点。
			"[Project Trust](README.md#project-trust)",
			// 子目录文件的下划线锚点应原样保留。
			"[Extensions](docs/extensions.md#project_trust)",
			// 尾部 / 提示目录，因此期望使用 GitHub 的 tree 路由。
			"[Examples](examples/extensions/)",
			// 两次 .. 从 packages/coding-agent 回到仓库根。
			"[Root README](../../README.md#supply-chain-hardening)",
		].join("\n");

		// toBe 比较完整文字，包括顺序、换行、标签和锚点；不验证远端资源存在。
		expect(normalizeChangelogLinks(markdown, entry)).toBe(
			[
				// 文件使用 blob，目录使用 tree；版本由 entry 的数字字段生成。
				"[Project Trust](https://github.com/earendil-works/pi/blob/v0.79.0/packages/coding-agent/README.md#project-trust)",
				"[Extensions](https://github.com/earendil-works/pi/blob/v0.79.0/packages/coding-agent/docs/extensions.md#project_trust)",
				"[Examples](https://github.com/earendil-works/pi/tree/v0.79.0/packages/coding-agent/examples/extensions/)",
				"[Root README](https://github.com/earendil-works/pi/blob/v0.79.0/README.md#supply-chain-hardening)",
			].join("\n"),
		);
	});

	// 输入历史仓库地址、外部链接及页内锚点，检查仅指定仓库路径被改写；版本也可直接用字符串。
	test("canonicalizes old repository URLs without changing external links", () => {
		// 固定五种目标，其中旧仓库的 main 文件链接还要固定到发布标签。
		const markdown = [
			// earendil-works 的旧 pi-mono PR 路径。
			"[#5167](https://github.com/earendil-works/pi-mono/pull/5167)",
			// 更早 badlogic 所有者的 issue 路径。
			"[#4163](https://github.com/badlogic/pi-mono/issues/4163)",
			// 旧仓库浮动 main 文件链接。
			"[Agent README](https://github.com/badlogic/pi-mono/blob/main/packages/agent/README.md)",
			// 非目标域名和页内片段不应被解释成仓库相对路径。
			"[External](https://example.com/docs)",
			"[Local anchor](#settings)",
		].join("\n");

		// 字符串版本同样生成 v0.79.0；没有联网检查重定向。
		expect(normalizeChangelogLinks(markdown, "0.79.0")).toBe(
			[
				// 前两项只统一仓库地址，第三项同时把 main 换成固定标签。
				"[#5167](https://github.com/earendil-works/pi/pull/5167)",
				"[#4163](https://github.com/earendil-works/pi/issues/4163)",
				"[Agent README](https://github.com/earendil-works/pi/blob/v0.79.0/packages/agent/README.md)",
				"[External](https://example.com/docs)",
				"[Local anchor](#settings)",
			].join("\n"),
		);
	});
});
