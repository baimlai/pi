#!/usr/bin/env node
// Preview builds of pi's packages on pkg.earendil.com, served by the earendil-works/pkg worker.
// Used by .github/workflows/ci.yml (pack) and .github/workflows/preview-packages.yml (publish, delete-ref).
//
//   pack        Point internal dependencies at this commit's builds, then `npm pack` every public package.
//               Runs in the regular CI job after the build.
//   publish     Upload the packed tarballs and move refs (main, pr-1234). Runs in the trusted workflow_run job and
//               authenticates with the job's GitHub OIDC token (`permissions: id-token: write`).
//   delete-ref  Remove a ref, e.g. pr-1234 when the PR closes.
//
// 文件导读
// 所属：仓库根 scripts/，是预览包（preview packages）的打包/上传/清理 CLI。
// 作用：把每次 CI 构建的公开包打成 tarball，上传到 pkg.earendil.com，并把 main 或 pr-<号> 引用移动到该提交，
// 让评审者用 `npm i https://pkg.earendil.com/<包名>@<ref>` 试用未发布版本；PR 关闭时删除对应 ref。
// 上游：.github/workflows/ci.yml 的 pack 步骤；.github/workflows/preview-packages.yml 的 publish 与 cleanup 任务。
// 下游：npm-command.mjs 执行 npm pack；release-packages.mjs 枚举公开包；node:http(s) fetch 调 worker；
//       GitHub OIDC 令牌由 Actions 环境提供。
// 能力清单：
//   pack        改写内部依赖为同提交的 preview URL，执行 npm pack，写 manifest.json，最后恢复原 package.json。
//   publish     校验 CI 制品、上传每个 tarball、移动 refs、输出安装命令摘要。
//   delete-ref  删除一个 ref。
// 环境变量：publish/delete-ref 需要 ACTIONS_ID_TOKEN_REQUEST_URL 与 ACTIONS_ID_TOKEN_REQUEST_TOKEN（GitHub OIDC）；
//           设置 GITHUB_STEP_SUMMARY 时会把 Markdown 摘要追加到该文件，否则只写 stdout。
// 参数：见底部 USAGE；--base-url 仅供测试指向本地服务器。
// 输出与退出码：pack 的 npm 日志写 stderr，最终 manifest 写入 --out；publish 的摘要写 stdout；
//                 参数错误打印 UsageError 文本，其他错误加 "preview-packages:" 前缀，均退出 1；成功退出 0。
// 副作用与信任边界：pack 会临时改写工作区内的 package.json（finally 恢复），因此必须在仓库根运行；
//                 publish 只上传 CI 制品中的 tarball 字节，manifest 仅用于文件名和 sha 对照；
//                 sha/run/event/refs 取自受信任的 workflow_run 事件，上传的包名由 worker 按其配置授权。
// 示例（真实命令行）：
//   node scripts/preview-packages.mjs pack --sha <40位sha> --out preview-packages
//   node scripts/preview-packages.mjs publish --sha <sha> --run 123 --event pull_request --ref pr-42
// 阅读顺序：先看 pack 的清单改写与恢复，再看 publish 的 OIDC/上传/ref，最后看 delete-ref 与顶层分发。

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { execNpmSync } from "./npm-command.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

// 生产 worker 地址；也是 OIDC token 的 audience（即使 --base-url 指向测试服务器）。
const BASE_URL = "https://pkg.earendil.com";
// pack 的 --sha 必须是完整 40 位小写十六进制提交号，短 sha 会产生不明确的 ref。
const FULL_SHA = /^[0-9a-f]{40}$/;
// Its daemon binaries are cross-compiled only by the release workflow; previews would ship without them.
// pi-env 包含需要交叉编译的 daemon 二进制，普通 CI 构建无法产出，因此预览包排除它。
const EXCLUDED = new Set(["@earendil-works/pi-env"]);

// 区分“用户参数写错”和“运行失败”：前者只打印消息，后者带脚本名前缀。
class UsageError extends Error {}

// 校验 --sha；非字符串或格式不符时抛 UsageError。
function assertSha(sha) {
	if (typeof sha !== "string" || !FULL_SHA.test(sha)) {
		throw new UsageError(`--sha must be a full commit SHA, got ${sha}`);
	}
}

// pack：把内部依赖指向同提交的 preview URL，逐个 npm pack，写 manifest。
async function pack(argv) {
	// parseArgs 只解析这个子命令自己的参数；--out 默认 preview-packages。
	const { values } = parseArgs({
		args: argv,
		options: { sha: { type: "string" }, out: { type: "string", default: "preview-packages" } },
	});
	assertSha(values.sha);
	const sha = values.sha;
	// 枚举公开包并排除 pi-env；names 用于识别清单中的内部依赖。
	const packages = getPublicWorkspacePackages().filter((pkg) => !EXCLUDED.has(pkg.name));
	const names = new Set(packages.map((pkg) => pkg.name));
	const outDir = resolve(values.out);
	// 递归创建输出目录；CI 中它位于 RUNNER_TEMP，不会进入仓库。
	await mkdir(outDir, { recursive: true });

	const packed = [];
	for (const pkg of packages) {
		const manifestPath = join(pkg.directory, "package.json");
		// 保存原始文本（不是 JSON 对象），恢复时能保持原格式和尾随换行。
		const original = await readFile(manifestPath, "utf8");
		const manifest = JSON.parse(original);
		// Internal dependencies point at the same commit's builds, so one install resolves a consistent set.
		// 只改写 dependencies/optionalDependencies 中同为公开包的条目；外部依赖保持原版本。
		for (const field of ["dependencies", "optionalDependencies"]) {
			for (const name of Object.keys(manifest[field] ?? {})) {
				if (names.has(name)) manifest[field][name] = `${BASE_URL}/${name}@${sha}`;
			}
		}
		// 临时写回改写后的清单；npm pack 读取的是磁盘文件。
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		try {
			// --json 捕获 pack 结果；--pack-destination 输出到统一目录；--ignore-scripts 禁止生命周期脚本。
			const output = execNpmSync(["pack", "--json", "--ignore-scripts", "--pack-destination", outDir], {
				cwd: pkg.directory,
				encoding: "utf8",
				stdio: ["inherit", "pipe", "inherit"],
				maxBuffer: 64 * 1024 * 1024,
			});
			// npm 10/11 print an array, npm 12 prints an object keyed by package name.
			const parsed = JSON.parse(output);
			const info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
			packed.push({ name: info.name, file: info.filename });
			// 进度写 stderr，stdout 留给后续 CI 输出。
			console.error(`packed ${info.name}@${info.version} -> ${info.filename}`);
		} finally {
			// 无论 pack 成功与否都恢复原清单，避免把 preview URL 提交进仓库。
			await writeFile(manifestPath, original);
		}
	}
	// 制品清单只含 sha 和 tarball 文件名；publish 会以它为唯一入口。
	await writeFile(join(outDir, "manifest.json"), `${JSON.stringify({ sha, packages: packed }, null, "\t")}\n`);
}

// The audience names the production worker, also when --base-url points elsewhere (tests).
// 向 GitHub 请求短期 OIDC token；audience 固定为生产 worker，测试服务器也接受该 token 的值。
async function getOidcToken() {
	// 这两个变量由 Actions 的 id-token: write 权限注入。
	const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
	const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
	if (!url || !token) {
		throw new UsageError("No GitHub OIDC token available; the job needs `permissions: id-token: write`");
	}
	const requestUrl = new URL(url);
	// GitHub 用 audience 参数决定 token 的接收方；worker 会校验它。
	requestUrl.searchParams.set("audience", BASE_URL);
	const response = await fetch(requestUrl, { headers: { authorization: `Bearer ${token}` } });
	if (!response.ok) throw new Error(`Requesting OIDC token failed: ${response.status}`);
	// 响应 JSON 的 value 字段就是 OIDC token 字符串。
	const { value } = await response.json();
	return value;
}

// 通用 worker 调用：带 Bearer token 和可选 body，非 2xx 时把响应文本一起抛出。
async function call(method, url, token, body) {
	const response = await fetch(url, { method, headers: { authorization: `Bearer ${token}` }, body });
	// 先读文本再判断，错误响应也能附上 worker 的解释。
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${url} failed: ${response.status} ${text}`);
	// 成功响应必须是 JSON；代理返回 HTML 等情况会在这里抛 SyntaxError。
	return JSON.parse(text);
}

// 生成 GitHub Job Summary 的 Markdown：最新 ref 的安装命令 + 固定到本次提交的折叠命令。
function renderSummary({ baseUrl, sha, refs, names }) {
	// lines 保存逐行文本，最后统一 join，避免反复字符串拼接。
	const lines = ["### Preview packages", "", `Built from \`${sha.slice(0, 7)}\`.`, ""];
	if (refs.length > 0) {
		// refs[0] 是调用方传入的第一个 ref（main 或 pr-N），会随新推送移动。
		lines.push(`Latest build of \`${refs[0]}\` (updates with new pushes):`, "", "```sh");
		for (const name of names) lines.push(`npm i ${baseUrl}/${name}@${refs[0]}`);
		lines.push("```", "");
	}
	// 折叠区域给出永久指向该 sha 的安装方式，适合复现某个提交。
	lines.push("<details><summary>Pinned to this commit</summary>", "", "```sh");
	for (const name of names) lines.push(`npm i ${baseUrl}/${name}@${sha}`);
	lines.push("```", "", "</details>", "");
	// 私有 preview registry 需要在 .npmrc 配 token；URL.host 去掉协议部分。
	lines.push(`Installs need a token in \`.npmrc\`: \`//${new URL(baseUrl).host}/:_authToken=...\``);
	return `${lines.join("\n")}\n`;
}

// publish：校验 CI 制品、上传 tarball、移动 refs、输出安装摘要。
async function publish(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			dir: { type: "string", default: "preview-packages" },
			sha: { type: "string" },
			// multiple:true 允许 --ref main --ref pr-1，收集为数组。
			ref: { type: "string", multiple: true, default: [] },
			run: { type: "string" },
			event: { type: "string" },
			"base-url": { type: "string", default: BASE_URL },
		},
	});
	assertSha(values.sha);
	const { sha, ref: refs, event } = values;
	const run = Number(values.run);
	// run 必须是安全整数；先检查原始字符串格式，避免 Number("") 变成 0 等意外。
	if (!/^\d+$/.test(values.run ?? "") || !Number.isSafeInteger(run)) {
		throw new UsageError(`--run must be the CI run ID, got ${values.run}`);
	}
	// 只接受两种来源事件，worker 据此决定授权范围。
	if (event !== "push" && event !== "pull_request") {
		throw new UsageError(`--event must be push or pull_request, got ${event}`);
	}
	const baseUrl = values["base-url"];
	const dir = resolve(values.dir);

	// The artifact comes from an untrusted PR build: only read tarballs from it. The SHA, run, event, and refs
	// come from the trusted workflow_run event; the worker authorizes package names against its config.
	// 这里只信任命令行参数（来自受信任的 workflow_run）；manifest 只用于文件名和 sha 对照。
	const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
	if (manifest.sha !== sha) throw new Error(`Artifact was packed for ${manifest.sha}, expected ${sha}`);
	if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) throw new Error("Artifact has no packages");

	const token = await getOidcToken();
	const names = [];
	for (const { name, file } of manifest.packages) {
		// file 必须是纯文件名（basename 相同）且以 .tgz 结尾，防止 ../ 路径穿越到制品目录外。
		if (typeof file !== "string" || basename(file) !== file || !file.endsWith(".tgz")) {
			throw new Error(`Invalid tarball name in artifact: ${file}`);
		}
		// 包名可能含 / 和 @，必须 URL 编码；event 作为查询参数供 worker 记录来源。
		const url = `${baseUrl}/_/upload/${sha}/${encodeURIComponent(name)}?event=${event}`;
		// 上传原始字节；worker 返回规范化后的 name 与实际是否已存在。
		const result = await call("PUT", url, token, await readFile(join(dir, file)));
		names.push(result.name);
		console.error(`${result.existing ? "exists" : "uploaded"} ${result.name}@${sha}`);
	}
	if (refs.length > 0) {
		// refs 更新是“移动指针”：worker 返回每个 ref 当前指向的 sha，用于检测并发更新的更新运行。
		const result = await call("POST", `${baseUrl}/_/refs`, token, JSON.stringify({ sha, refs, run }));
		const newer = result.refs.filter((ref) => ref.sha !== sha);
		if (newer.length > 0) {
			// A newer run already published these refs; its summary has the current install commands.
			// 已有更新运行拥有该 ref，本次不覆盖摘要，避免用户看到过期安装命令。
			console.error(`a newer run already published ${newer.map((ref) => `${ref.ref} (${ref.sha})`).join(", ")}`);
			return;
		}
		console.error(`moved ${refs.join(", ")} to ${sha}`);
	}

	// names.sort() 原地排序，保证摘要中的包顺序稳定。
	const summary = renderSummary({ baseUrl, sha, refs, names: names.sort() });
	process.stdout.write(summary);
	// GitHub Actions 设置该变量时，把摘要追加到 job 页面。
	if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}

// delete-ref：删除 PR 对应的 preview ref，需要 OIDC token。
async function deleteRef(argv) {
	const { values } = parseArgs({
		args: argv,
		options: { ref: { type: "string" }, "base-url": { type: "string", default: BASE_URL } },
	});
	if (!values.ref) throw new UsageError("delete-ref needs --ref");
	// ref 可能含 /（例如分支名），编码后再拼进路径。
	await call("DELETE", `${values["base-url"]}/_/refs/${encodeURIComponent(values.ref)}`, await getOidcToken());
	console.error(`deleted ${values.ref}`);
}

// 三个子命令的用法文本；直接输出到 stderr 或作为 UsageError 消息。
const USAGE = `Usage:
  node scripts/preview-packages.mjs pack --sha <sha> [--out dir]
  node scripts/preview-packages.mjs publish --sha <sha> --run <CI run id> --event <push|pull_request>
                                            [--dir dir] [--ref name]...
  node scripts/preview-packages.mjs delete-ref --ref <name>`;

// 顶层分发：第一个位置参数是子命令，其余传给子命令的 parseArgs。
const [command, ...argv] = process.argv.slice(2);
const commands = { pack, publish, "delete-ref": deleteRef };
try {
	if (!commands[command]) throw new UsageError(USAGE);
	await commands[command](argv);
} catch (error) {
	// UsageError 只打印消息（用户能直接修正）；其他错误加脚本名前缀并保留原因。
	console.error(error instanceof UsageError ? error.message : `preview-packages: ${error.message}`);
	process.exit(1);
}
