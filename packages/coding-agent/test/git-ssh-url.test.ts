// 用固定字符串验证包来源解析，只调用解析器，不执行 git、SSH 或网络请求。
import { describe, expect, it } from "vitest";
import { parseGitUrl } from "../src/utils/git.ts";

// describe 把下方用例归组；箭头回调只负责注册用例，断言失败由 Vitest 报告。
describe("Git URL Parsing", () => {
	// 协议地址不需要额外 git: 标签；每例输入地址，比较返回对象的指定字段。
	describe("protocol URLs (accepted without git: prefix)", () => {
		// 例：https 地址应分出主机与仓库路径，保留 clone 地址；无外部副作用。
		it("should parse HTTPS URL", () => {
			// const 保存解析结果，类型可能是 GitSource 或 null；本行不下载仓库。
			const result = parseGitUrl("https://github.com/user/repo");
			// toMatchObject 只检查列出的字段，未断言 type、ref、pinned 等其他属性。
			expect(result).toMatchObject({
				// host 是主机，path 是 user/repo，repo 是后续 clone 可用的地址文字。
				host: "github.com",
				path: "user/repo",
				repo: "https://github.com/user/repo",
			});
		});

		// 例：ssh://git@... 应保留 SSH 地址；这里只验证拆解，不验证服务器可连通。
		it("should parse ssh:// URL", () => {
			// 账号 git 不属于 hostname，解析结果另存 github.com。
			const result = parseGitUrl("ssh://git@github.com/user/repo");
			// 部分对象匹配要求主机、路径和原 SSH 仓库文字一致。
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				repo: "ssh://git@github.com/user/repo",
			});
		});

		// 例：仓库后的 @v1.0.0 作为引用拆出；测试不会验证标签真实存在。
		it("should parse protocol URL with ref", () => {
			// 将带引用的 HTTPS 来源交给解析器，结果同时包含仓库地址和 ref。
			const result = parseGitUrl("https://github.com/user/repo@v1.0.0");
			// 要求 repo 去掉引用后缀，而 ref 单独保留 v1.0.0。
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				ref: "v1.0.0",
				repo: "https://github.com/user/repo",
			});
		});
	});

	// 这一组演示历史简写必须带 git: 来源标签，标签本身不属于克隆地址。
	describe("shorthand URLs (accepted only with git: prefix)", () => {
		// 例：git:git@host:path 可以解析成 SCP 风格地址；没有实际 SSH 进程。
		it("should parse git@host:path with git: prefix", () => {
			// 传入标签加 SCP 地址，冒号后的 user/repo 是仓库路径。
			const result = parseGitUrl("git:git@github.com:user/repo");
			// 比较主机、仓库路径和去标签后的 repo，不额外断言 pinned。
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				repo: "git@github.com:user/repo",
			});
		});

		// 例：带标签的 host/path 简写补成 HTTPS；回调没有参数和返回数据。
		it("should parse host/path shorthand with git: prefix", () => {
			// 解析 github.com/user/repo 的简写，前缀授权按 Git 来源解释。
			const result = parseGitUrl("git:github.com/user/repo");
			// 要求主机和路径不变，并由解析器给 repo 补 https://。
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				repo: "https://github.com/user/repo",
			});
		});

		// 例：SCP 地址末尾 @v1.0.0 作为 ref，而开头 git@ 仍是账号部分。
		it("should parse shorthand with ref and git: prefix", () => {
			// 同时包含两个 @ 的输入用于检验拆引用的位置。
			const result = parseGitUrl("git:git@github.com:user/repo@v1.0.0");
			// 部分匹配要求 ref 与 clone 地址分开，不比较其他字段。
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				ref: "v1.0.0",
				repo: "git@github.com:user/repo",
			});
		});
	});

	// 遍历六种危险路径样本，要求每项返回 null；有限样本不证明所有输入都安全。
	it("should reject unsafe git install path inputs", () => {
		// for...of 依次把数组元素赋给 source，包括上级目录、编码斜杠、坏编码和 NUL。
		for (const source of [
			"git:git@evil.example:../../victim/repo",
			"https://evil.example/..%2F..%2Fvictim/repo",
			"https://evil.example/..%2F..%2Fvictim/repo%",
			"git:git@evil.example:/absolute/repo",
			"git:git@evil.example:user\\repo/name",
			"git:git@evil.example:user/repo\0name",
		]) {
			// 每轮实际调用解析器，再用 toBeNull 检查它拒绝该输入；不会创建安装目录。
			expect(parseGitUrl(source)).toBeNull();
		}
	});

	// 最后一组检查没有标签的简写不会被误认为 Git 来源。
	describe("unsupported without git: prefix", () => {
		// 例：裸 git@host:path 返回 null；该规则与显式 ssh:// 不同。
		it("should reject git@host:path without git: prefix", () => {
			// toBeNull 是对真实解析返回值的运行时断言。
			expect(parseGitUrl("git@github.com:user/repo")).toBeNull();
		});

		// 例：裸 host/path 返回 null，避免把一般包路径当仓库。
		it("should reject host/path shorthand without git: prefix", () => {
			// 域名看起来有效也不足以绕过 git: 标签要求。
			expect(parseGitUrl("github.com/user/repo")).toBeNull();
		});

		// 例：user/repo 不带域名、协议或来源标签，必须拒绝。
		it("should reject user/repo shorthand", () => {
			// 只断言此固定输入返回 null，不执行任何磁盘访问。
			expect(parseGitUrl("user/repo")).toBeNull();
		});
	});
});
