// 文件导读
// 所属：仓库根 scripts/ 的脚本测试，被测对象是 preview-packages.mjs。
// 作用：用本地 HTTP 服务器同时扮演 pkg.earendil.com worker 和 GitHub OIDC token 端点，
// 验证 pack 的清单改写/恢复、publish 的上传与 ref 移动、并发更新的处理，以及非 JSON 响应的失败。
// 测试夹具与假实现：
//   startServer() 记录每个请求（方法/URL/Authorization/body），按路径返回 token、上传结果或 ref 结果；
//   writePackage()/writeArtifact() 构造最小工作区与 CI 制品；
//   publish() 用临时服务器 URL 和伪造的 ACTIONS_ID_TOKEN_REQUEST_* 环境启动真实 CLI 子进程。
// 覆盖分组：
//   1. pack 把内部依赖改成 https://pkg.earendil.com/<name>@<sha>，打包后恢复原 package.json；
//   2. publish 上传 tarball、移动 pr-1、在 stdout 生成两种安装命令；
//   3. 更新的运行已拥有 ref 时不输出摘要；
//   4. 上传收到非 JSON 的 2xx 响应时失败，且不再尝试 POST refs。
// 运行命令：node --test scripts/preview-packages.test.mjs
// 前置条件：需要 npm 与 tar（pack 测试会真实执行 npm pack 并用 tar 读取包内容）；不访问外网。
// 阅读顺序：先看 startServer/writeArtifact/publish 三个 helper，再按 test 顺序读。
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// promisify 把 execFile 的回调式接口变成 Promise，await 后得到 {stdout, stderr}。
const run = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), "preview-packages.mjs");
// 两个合法 40 位 sha：sha 用于本次发布，newerSha 模拟更新运行。
const sha = "a".repeat(40);
const newerSha = "b".repeat(40);

// 创建临时目录并在测试结束后递归清理。
function temporaryDirectory(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-preview-packages-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

// 在 <repo>/packages/<directory> 下写 package.json；pack 会从这里枚举公开包。
function writePackage(repo, directory, manifest) {
	mkdirSync(join(repo, "packages", directory), { recursive: true });
	writeFileSync(join(repo, "packages", directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

// 返回 { url, requests }：url 指向 127.0.0.1 的随机端口，requests 按到达顺序记录。
/**
 * Stands in for the pkg.earendil.com worker and GitHub's OIDC token endpoint, recording requests. `refsSha` is what the
 * worker reports each ref resolves to after the update; `uploadBody` overrides the upload response.
 */
async function startServer(t, { refsSha = sha, uploadBody } = {}) {
	const requests = [];
	const server = createServer(async (req, res) => {
		// 逐块读取请求体；上传 tarball 时 body 是原始字节拼成的字符串。
		let body = "";
		for await (const chunk of req) body += chunk;
		requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
		const url = new URL(req.url, "http://localhost");
		// GitHub token 端点：value 里带上 audience，便于断言请求参数。
		if (url.pathname === "/token") return res.end(JSON.stringify({ value: `oidc-for-${url.searchParams.get("audience")}` }));
		if (req.method === "PUT") {
			// 上传路径 /_/upload/<sha>/<encoded name>；slice(4) 去掉空段、_、upload、sha。
			const name = decodeURIComponent(url.pathname.split("/").slice(4).join("/"));
			return res.end(uploadBody ?? JSON.stringify({ name, sha, existing: false }));
		}
		// 其余请求视为 refs 更新：把请求里的 refs 映射到 refsSha。
		const { refs } = JSON.parse(body);
		res.end(JSON.stringify({ refs: refs.map((ref) => ({ ref, sha: refsSha })) }));
	});
	// listen(0) 让操作系统分配空闲端口，避免测试并行时端口冲突。
	await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
	t.after(() => server.close());
	return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

// 构造最小 CI 制品：一个 tarball 文件 + manifest；tarball 内容只需可读。
function writeArtifact(directory) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "scope-a-1.0.0.tgz"), "tarball a");
	const packages = [{ name: "@scope/a", file: "scope-a-1.0.0.tgz" }];
	writeFileSync(join(directory, "manifest.json"), JSON.stringify({ sha, packages }));
}

// 启动真实 publish 子进程；删除 GITHUB_STEP_SUMMARY 以免测试污染外部文件。
function publish(server, dir) {
	const { GITHUB_STEP_SUMMARY: _, ...env } = process.env;
	const args = ["publish", "--sha", sha, "--run", "7", "--event", "pull_request", "--ref", "pr-1", "--dir", dir];
	return run(process.execPath, [script, ...args, "--base-url", server.url], {
		env: { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: `${server.url}/token`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner" },
	});
}

// pack 场景：内部依赖改写为同提交 URL，pi-env 被排除，打包后原文件逐字节恢复。
test("pack points internal dependencies at the commit's builds and restores package.json", async (t) => {
	const repo = temporaryDirectory(t);
	// @scope/a 依赖内部 @scope/b、外部 other，以及（通过排除规则）不应被打包的 private 包。
	writePackage(repo, "a", { name: "@scope/a", version: "1.0.0", dependencies: { "@scope/b": "1.0.0", other: "2.0.0" } });
	writePackage(repo, "b", { name: "@scope/b", version: "1.0.0" });
	// private 包不会被 getPublicWorkspacePackages 返回。
	writePackage(repo, "internal", { name: "@scope/internal", version: "1.0.0", private: true });
	// pi-env 虽公开但被 EXCLUDED 排除。
	writePackage(repo, "env", { name: "@earendil-works/pi-env", version: "1.0.0" });
	const original = readFileSync(join(repo, "packages/a/package.json"), "utf8");

	const out = join(repo, "out");
	// cwd 设为临时仓库，getPublicWorkspacePackages() 默认从 ./packages 枚举。
	await run(process.execPath, [script, "pack", "--sha", sha, "--out", out], { cwd: repo });

	const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
	assert.equal(manifest.sha, sha);
	// 只有公开且未排除的 a、b 进入 manifest。
	assert.deepEqual(manifest.packages.map((pkg) => pkg.name).sort(), ["@scope/a", "@scope/b"]);
	// 输出目录应只有 manifest 和两个 tarball，没有残留临时文件。
	assert.deepEqual(readdirSync(out).sort(), ["manifest.json", ...manifest.packages.map((pkg) => pkg.file)].sort());
	const fileA = manifest.packages.find((pkg) => pkg.name === "@scope/a").file;
	// tar -xOzf 把指定成员解压到 stdout；读取 package/package.json 验证依赖已被改写。
	const packedA = JSON.parse(execFileSync("tar", ["-xOzf", join(out, fileA), "package/package.json"], { encoding: "utf8" }));
	assert.deepEqual(packedA.dependencies, { "@scope/b": `https://pkg.earendil.com/@scope/b@${sha}`, other: "2.0.0" });
	// 打包结束后工作区清单必须恢复原样，不能把 preview URL 留在仓库里。
	assert.equal(readFileSync(join(repo, "packages/a/package.json"), "utf8"), original);
});

// publish 场景：先取 OIDC token，再上传 tarball，最后移动 ref；stdout 含 ref 与 sha 两种安装命令。
test("publish uploads each tarball, moves refs and prints install commands", async (t) => {
	const server = await startServer(t);
	const dir = join(temporaryDirectory(t), "artifact");
	writeArtifact(dir);

	const { stdout } = await publish(server, dir);

	// 请求顺序固定为：token GET、tarball PUT、refs POST。
	const [token, upload, refs] = server.requests;
	assert.equal(token.url, "/token?audience=https%3A%2F%2Fpkg.earendil.com");
	// 包名 @scope/a 必须 URL 编码成 %40scope%2Fa；event 作为查询参数。
	assert.deepEqual(
		{ method: upload.method, url: upload.url, authorization: upload.authorization, body: upload.body },
		{
			method: "PUT",
			url: `/_/upload/${sha}/%40scope%2Fa?event=pull_request`,
			authorization: "Bearer oidc-for-https://pkg.earendil.com",
			body: "tarball a",
		},
	);
	// refs 请求体包含 sha、ref 数组和数字类型的 run。
	assert.deepEqual(JSON.parse(refs.body), { sha, refs: ["pr-1"], run: 7 });
	// 摘要同时给出可移动 ref 和固定到提交的两种安装方式。
	assert.match(stdout, new RegExp(`npm i ${server.url}/@scope/a@pr-1`));
	assert.match(stdout, new RegExp(`npm i ${server.url}/@scope/a@${sha}`));
});

// 并发场景：worker 报告 ref 已指向更新的 sha，本次不应输出摘要覆盖它。
test("publish leaves the summary to a newer run that already owns the ref", async (t) => {
	const server = await startServer(t, { refsSha: newerSha });
	const dir = join(temporaryDirectory(t), "artifact");
	writeArtifact(dir);

	const { stdout, stderr } = await publish(server, dir);
	// 没有摘要输出，只有 stderr 上的说明。
	assert.equal(stdout, "");
	assert.match(stderr, new RegExp(`a newer run already published pr-1 \\(${newerSha}\\)`));
});

// 错误场景：2xx 响应不是 JSON（如代理返回 HTML）时 JSON.parse 抛错，且不会继续 POST refs。
test("publish fails on a successful response that is not JSON", async (t) => {
	// uploadBody 覆盖上传响应，模拟中间代理返回 HTML。
	const server = await startServer(t, { uploadBody: "<html>proxy</html>" });
	const dir = join(temporaryDirectory(t), "artifact");
	writeArtifact(dir);

	// assert.rejects 断言 Promise 拒绝，错误文本包含 "not valid JSON"（JSON.parse 的 SyntaxError）。
	await assert.rejects(publish(server, dir), /not valid JSON/);
	// 上传失败后不应再移动 refs。
	assert.equal(server.requests.filter((request) => request.method === "POST").length, 0);
});
