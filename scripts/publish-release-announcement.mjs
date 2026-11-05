#!/usr/bin/env node

// 文件导读：发布公告脚本，把已经发布到 npm 的 Pi 版本登记到对象存储（Cloudflare R2，S3 API）并推进 latest 指针。
// 所属：仓库根 scripts/，发布链路由 `.github/workflows/build-binaries.yml` 的 announce-pi-dev-release 作业调用，
//   必须等 publish-npm 作业成功后运行。
// 作用：确认所有公开工作区包都能从 npm registry 解析到同一版本及其 tarball/integrity，然后写出三类对象：
//   1. `releases/v1/releases/<version>.json`：不可变的版本记录（schemaVersion、sourceCommit、publishedAt、包列表）。
//   2. `installer/v1/releases/<version>/{package.json,package-lock.json,metadata.json}`：安装器产物。
//   3. `installer/v1/latest.json` 与 `releases/v1/latest.json`：可变的“最新版本”指针，用 ETag 条件写避免并发回退。
// 上游：CI 传入 --bucket、--endpoint、--version、--installer-package-json、--installer-package-lock；
//   可选 --source-commit，缺省时执行 `git rev-parse HEAD`。AWS 凭证来自环境变量 AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY。
// 下游：通过 `aws s3api` 子进程写入远端对象；通过 fetch 访问 registry.npmjs.org 和 tarball。
// 高风险与失败状态：
//   - 这是真实发布动作，会写远端存储并改变 pi.dev 对外公布的最新版本；本地运行前必须确认 bucket/endpoint/凭证。
//   - 不可变对象用 `if-none-match: *` 创建；若同版本记录已存在则跳过（幂等），不会覆盖历史内容。
//   - latest 指针最多重试 5 次；若竞争持续，脚本抛错退出码 1，已写入的不可变对象保留。
//   - npm 包未全部可解析时最多等待 10 分钟（每 5 秒重试），超时抛错。
// 能力清单：
//   - parseArgs：解析并校验命令行参数。
//   - resolvePackageFromNpm / verifyPackagesAreAvailable：从 registry 解析 tarball 与 integrity，带超时重试。
//   - runAws / readLatestRelease / putObject / putJson：封装 aws s3api 的读、条件写。
//   - validateInstallerArtifacts：校验安装器 package.json/package-lock 与本版本一致。
//   - compareReleaseVersions：比较三段稳定版本（已导出，供测试使用）。
//   - advanceLatestRelease：条件写 latest 指针，处理竞争（已导出）。
//   - main：按“校验 → 写版本记录 → 写安装器产物 → 推进两个 latest 指针”的顺序执行。
// 典型调用（真实命令，来自 CI）：
//   node scripts/publish-release-announcement.mjs --version 0.85.0 --bucket pi-artifacts \
//     --endpoint "$R2_ENDPOINT" --installer-package-json packages/coding-agent/install-lock/package.json \
//     --installer-package-lock packages/coding-agent/install-lock/package-lock.json
//   成功时 stdout 打印发布/已存在的提示，退出码 0；参数错误、npm 查询失败、AWS 调用失败时退出码 1。
// 阅读顺序：先看常量与 parseArgs，再看 npm 解析与重试，然后看 AWS 条件写封装，最后看 main 的写入顺序。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

// 对象存储中的两个版本化前缀：普通发布记录与安装器产物分开存放。
const RELEASES_PREFIX = "releases/v1";
const INSTALLER_PREFIX = "installer/v1";
// 安装器包的固定名字；validateInstallerArtifacts 会核对 package.json.name。
const INSTALLER_PACKAGE_NAME = "@earendil-works/pi-coding-agent-install";
// 直接查公共 npm registry，而不是走用户配置的镜像或私有源。
const REGISTRY_URL = "https://registry.npmjs.org";
// npm 传播延迟：每 5 秒重试，最多等 10 分钟；这是墙钟时间，不是尝试次数。
const RETRY_DELAY_MS = 5000;
const RETRY_TIMEOUT_MS = 10 * 60 * 1000;
// latest 指针条件写的最多尝试次数；每次失败都重新读取再比较。
const MAX_POINTER_UPDATE_ATTEMPTS = 5;
// 只接受 x.y.z 三段纯数字；预发布/构建后缀被拒绝，因为 latest 指针只推进稳定版本。
const STABLE_SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

// 解析命令行参数：只接受六个带值选项，逐对消费；任何未知参数或缺失值都抛错。
// 输入是 process.argv.slice(2)（不含 node 与脚本路径），输出是字段化 options，不产生副作用。
// 例：["--version","0.85.0",...] → { version:"0.85.0", bucket:undefined, ... }。
// 注意：options 初始字段全为 undefined，随后按 arg 动态赋值；TypeScript 无法约束这个 JS 对象。
function parseArgs(args) {
	const options = {
		bucket: undefined,
		endpoint: undefined,
		installerPackageJson: undefined,
		installerPackageLock: undefined,
		sourceCommit: undefined,
		version: undefined,
	};

	// index 由 0 递增；处理一个选项后下面还会 ++index 跳过它的值，因此循环不会把值当成选项。
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		// 用六个字符串比较做白名单；这里不解析 --x=y 或缩写形式。
		if (
			arg !== "--bucket" &&
			arg !== "--endpoint" &&
			arg !== "--installer-package-json" &&
			arg !== "--installer-package-lock" &&
			arg !== "--source-commit" &&
			arg !== "--version"
		) {
			throw new Error(`Unknown argument: ${arg}`);
		}
		// 前缀自增先取下一个位置的值；若缺失（undefined 或空串）直接失败，避免把选项名当值。
		const value = args[++index];
		if (!value) throw new Error(`${arg} requires a value`);
		// 用对象字面量把 CLI 拼写映射到 camelCase 字段，再动态索引赋值；
		// 这个映射每次迭代都会重建，但选项数量很小，不是性能热点。
		options[
			{
				"--bucket": "bucket",
				"--endpoint": "endpoint",
				"--installer-package-json": "installerPackageJson",
				"--installer-package-lock": "installerPackageLock",
				"--source-commit": "sourceCommit",
				"--version": "version",
			}[arg]
		] = value;
	}

	// 必填项校验：bucket/endpoint 决定写入哪个远端，缺失时绝不能继续。
	if (!options.bucket) throw new Error("--bucket is required");
	if (!options.endpoint) throw new Error("--endpoint is required");
	// 版本必须是稳定三段式；这与 latest 指针只向前推进的规则配套。
	if (!options.version || !STABLE_SEMVER_RE.test(options.version)) {
		throw new Error("--version must be a stable semver version");
	}
	// 两个安装器文件都必须提供，后面会校验内容而不是只看存在性。
	if (!options.installerPackageJson || !options.installerPackageLock) {
		throw new Error("--installer-package-json and --installer-package-lock are required");
	}
	return options;
}

// 返回一个在 milliseconds 后完成的 Promise；用于 npm 传播重试之间的等待。
// 例：await sleep(5000) 让出事件循环 5 秒，不阻塞其他 Promise。
function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 从 npm registry 解析一个包的 tarball URL 与 integrity，并 HEAD 检查 tarball 可访问。
// 输入 pkg 只需 {name, version}；输出 {name, version, tarball, integrity}；任何 HTTP 失败或元数据形状不符都抛错。
// 运行时校验针对外部网络输入（trust boundary），不假设 registry 返回类型稳定。
// 例：resolvePackageFromNpm({name:"@earendil-works/pi-ai", version:"2.0.0"}) 返回该版本的 dist 信息。
async function resolvePackageFromNpm(pkg) {
	// 作用域包名里的 "/" 在路径中需要编码；encodeURIComponent 转成 %2F，registry 才能正确路由。
	const packageUrl = `${REGISTRY_URL}/${encodeURIComponent(pkg.name)}/${pkg.version}`;
	// 请求单个精确版本，accept JSON；response.ok 覆盖 2xx。
	const response = await fetch(packageUrl, { headers: { accept: "application/json" } });
	if (!response.ok) {
		throw new Error(`${pkg.name}@${pkg.version}: npm registry returned ${response.status}`);
	}

	// response.json() 的类型是 any/unknown；以下逐字段检查是网络输入边界的运行时校验。
	const data = await response.json();
	// 必须是非 null、非数组的对象，且 version 与请求一致；dist 必须含字符串 tarball 与 integrity。
	// 这些检查防止 registry 返回错误版本或中间代理返回 HTML 形状的数据。
	if (
		typeof data !== "object" ||
		data === null ||
		Array.isArray(data) ||
		data.version !== pkg.version ||
		typeof data.dist !== "object" ||
		data.dist === null ||
		Array.isArray(data.dist) ||
		typeof data.dist.tarball !== "string" ||
		typeof data.dist.integrity !== "string"
	) {
		throw new Error(`${pkg.name}@${pkg.version}: npm registry returned invalid metadata`);
	}

	// 只发 HEAD，不下载体积较大的 tarball；确认对象存在且 CDN 已可访问。
	const tarball = await fetch(data.dist.tarball, { method: "HEAD" });
	if (!tarball.ok) {
		throw new Error(`${pkg.name}@${pkg.version}: tarball returned ${tarball.status}`);
	}

	// 返回后续写进 release.json 的最小元数据；integrity 供安装器与验证方校验 tarball。
	return {
		name: pkg.name,
		version: pkg.version,
		tarball: data.dist.tarball,
		integrity: data.dist.integrity,
	};
}

// 并行检查所有包在 npm 上可见；对暂时性传播延迟做带截止时间的重试。
// 输入是公开工作区包数组；成功返回逐个 resolve 的结果数组，超时抛错。
// 副作用：多次网络请求和 console 日志；不会写任何文件。
// 例：packages 有 5 个包时，5 个请求并发，全部成功后一次返回。
async function verifyPackagesAreAvailable(packages) {
	// deadline 是绝对时间戳，循环条件只比较墙钟，保证总等待不超过 10 分钟。
	const deadline = Date.now() + RETRY_TIMEOUT_MS;
	let attempt = 0;
	// failures 保存上一轮的失败说明；超时时用于错误消息。
	let failures = [];

	do {
		attempt++;
		// Promise.allSettled 等全部请求结束且不会因单个失败提前 reject；结果含 fulfilled/rejected 状态。
		const results = await Promise.allSettled(packages.map(resolvePackageFromNpm));
		// flatMap 把 rejected 结果映射为错误字符串，fulfilled 映射为空数组后展平；
		// packages[index] 与 results 一一对应，因为 map 保持顺序。
		failures = results.flatMap((result, index) =>
			result.status === "rejected" ? [`${packages[index].name}: ${result.reason}`] : [],
		);
		if (failures.length === 0) {
			// 全部 fulfilled 时用 map 取出 value；status 已在上一行排除 rejected，但 JS 不会自动收窄。
			console.log(`All ${packages.length} Pi packages are available from npm (attempt ${attempt}).`);
			return results.map((result) => result.value);
		}

		// 单复数只为日志可读；不改变重试逻辑。
		console.log(`Waiting for ${failures.length} Pi package${failures.length === 1 ? "" : "s"} on npm (attempt ${attempt}):`);
		for (const failure of failures) console.log(`  ${failure}`);
		// 只在还有剩余时间时等待；最后一轮失败后直接退出循环，避免多睡 5 秒。
		if (Date.now() < deadline) await sleep(RETRY_DELAY_MS);
	} while (Date.now() < deadline);

	// 超时错误把所有失败原因附在消息里，方便判断是 404、鉴权还是网络问题。
	throw new Error(`Timed out waiting for Pi packages to become available from npm:\n${failures.map((failure) => `  ${failure}`).join("\n")}`);
}

// 读取当前 git HEAD 作为发布来源提交；只在未传 --source-commit 时使用。
// 副作用：启动 git 子进程；失败时 execFileSync 抛错，不吞掉。
function gitSourceCommit() {
	// 参数分开传递，不经 shell；encoding 让返回值是字符串而不是 Buffer。
	return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

// 运行 aws CLI 并返回 stdout；可用选项把“预期内的失败”归一为 undefined。
// 输入 args 是 aws 参数数组；输出成功时为 stdout 字符串，命中允许的失败时 undefined。
// 默认任何非 0 退出、启动错误都抛出。allowNotFound 用于读取可能不存在的对象；
// allowPreconditionFailure 用于条件写，412/409 表示条件未满足（对象已存在或 ETag 变化）。
// 副作用：启动外部进程，可能访问远端存储；不会重试。
function runAws(args, { allowNotFound = false, allowPreconditionFailure = false } = {}) {
	// 第二个参数默认值为空对象，解构得到两个布尔开关。
	const result = spawnSync("aws", args, {
		encoding: "utf8",
		// 展开 process.env 保留凭证；R2 常要求 region=auto，未设置时补上。
		// 禁用 EC2 元数据查询，避免在非 EC2 环境里等待或意外带错凭证。
		env: {
			...process.env,
			AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "auto",
			AWS_EC2_METADATA_DISABLED: "true",
		},
		// stdin 忽略；stdout/stderr 捕获到返回对象，错误消息里再拼接。
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	if (result.status === 0) return result.stdout;

	// CLI 可能把错误写 stdout 或 stderr；统一拼接后做文本匹配，这是对子进程输出的运行时判断。
	const message = `${result.stdout}\n${result.stderr}`.trim();
	if (allowNotFound && /(?:404|NoSuchKey|Not Found)/i.test(message)) return undefined;
	// 412 是 S3 条件写失败的常见状态；ConditionalRequestConflict 是部分兼容实现的写法。
	if (allowPreconditionFailure && /(?:412|PreconditionFailed|ConditionalRequestConflict)/i.test(message)) {
		return undefined;
	}
	// 截取前两个参数（如 s3api head-object）作为命令摘要，避免错误消息过长。
	throw new Error(`aws ${args.slice(0, 2).join(" ")} failed:\n${message}`);
}

// 读取 latest 指针对象：先 HEAD 取 ETag，再 GET 到本地临时文件并解析 version。
// 输入 bucket/endpoint/key/outputPath；对象不存在返回 undefined；ETag 缺失或 version 非法抛错。
// 返回 {etag, version}，etag 用于后续条件写；副作用是写 outputPath 和远端读取。
function readLatestRelease(bucket, endpoint, key, outputPath) {
	// HEAD 只取元数据；对象不存在时 runAws 返回 undefined，代表尚无 latest 指针。
	const head = runAws(
		[
			"s3api",
			"head-object",
			"--bucket",
			bucket,
			"--key",
			key,
			"--endpoint-url",
			endpoint,
		],
		{ allowNotFound: true },
	);
	if (head === undefined) return undefined;

	// aws CLI 以 JSON 输出元数据；ETag 是条件写所需的版本标识，缺失就无法安全更新。
	const metadata = JSON.parse(head);
	if (typeof metadata.ETag !== "string") {
		throw new Error("Latest Pi release marker has no ETag.");
	}
	// GET 把对象内容写到本地临时路径，参数顺序是 bucket/key/endpoint/输出路径。
	runAws([
		"s3api",
		"get-object",
		"--bucket",
		bucket,
		"--key",
		key,
		"--endpoint-url",
		endpoint,
		outputPath,
	]);
	// 远端内容属于外部输入：必须是对象且 version 为稳定三段式，否则拒绝使用。
	const release = JSON.parse(readFileSync(outputPath, "utf8"));
	if (
		typeof release !== "object" ||
		release === null ||
		Array.isArray(release) ||
		typeof release.version !== "string" ||
		!STABLE_SEMVER_RE.test(release.version)
	) {
		throw new Error("Latest Pi release marker has an invalid version.");
	}
	// 只返回需要的两个字段；其他字段保留在远端，不被本脚本改写。
	return { etag: metadata.ETag, version: release.version };
}

// 条件写一个本地文件到 S3 键：condition 为空时普通覆盖；{etag} 用 --if-match；
// {missing:true} 用 --if-none-match "*" 表示仅当对象不存在时创建。
// 返回 true 表示写入成功，false 表示条件未满足（412/409）；其他失败抛错。
// 副作用：真实上传对象；cacheControl 决定 CDN 缓存策略。
function putObject(bucket, endpoint, path, key, cacheControl, condition) {
	// 固定 JSON content-type；这些对象都是给安装器/客户端解析的清单。
	const args = [
		"s3api",
		"put-object",
		"--bucket",
		bucket,
		"--key",
		key,
		"--body",
		path,
		"--endpoint-url",
		endpoint,
		"--content-type",
		"application/json; charset=utf-8",
		"--cache-control",
		cacheControl,
	];
	// 可选链 condition?.etag：condition 为 undefined 时不访问属性。
	// 两种条件互斥使用：更新已有对象用 if-match，创建新对象用 if-none-match。
	if (condition?.etag) args.push("--if-match", condition.etag);
	if (condition?.missing) args.push("--if-none-match", "*");
	// 有条件时把 412 视为“条件未满足”并返回 false；无条件时任何失败都抛出。
	return runAws(args, { allowPreconditionFailure: Boolean(condition) }) !== undefined;
}

// 语义化别名：调用方表达“写 JSON”，实现与 putObject 相同；保留独立名字方便阅读。
function putJson(bucket, endpoint, path, key, cacheControl, condition) {
	return putObject(bucket, endpoint, path, key, cacheControl, condition);
}

// 校验安装器的 package.json 与 package-lock.json 描述的正是本次版本。
// 输入两个文件路径和期望版本；只读文件，不写不改；任何字段不符抛错。
// 运行时校验的是构建产物，属于信任边界：CI 生成的文件可能来自错误分支。
// 例：version="0.85.0" 时，package.json.name 必须是 @earendil-works/pi-coding-agent-install。
function validateInstallerArtifacts(packageJsonPath, packageLockPath, version) {
	// 两个文件都是 JSON；packageLock.packages[""] 是 lockfile v3 中根包的位置。
	const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	const packageLock = JSON.parse(readFileSync(packageLockPath, "utf8"));
	// 可选链避免 packages 缺失时抛 TypeError；根包缺失时 root 为 undefined。
	const root = packageLock.packages?.[""];

	// 安装器自身名字和版本必须精确匹配，否则上传的产物会指向错误发布。
	if (packageJson.name !== INSTALLER_PACKAGE_NAME || packageJson.version !== version) {
		throw new Error(`Installer package.json must describe ${INSTALLER_PACKAGE_NAME}@${version}`);
	}
	// lockfile 必须是 v3；根包版本与依赖的 coding-agent 版本都必须等于本次发布版本。
	// root?.dependencies?.["..."] 用可选链逐层防止中间字段缺失。
	if (
		packageLock.lockfileVersion !== 3 ||
		packageLock.version !== version ||
		root?.version !== version ||
		root.dependencies?.["@earendil-works/pi-coding-agent"] !== version
	) {
		throw new Error(`Installer package-lock.json must describe Pi ${version}`);
	}
}

// 比较两个稳定版本，返回负数/0/正数；只按数字比较三段的 major.minor.patch。
// 任一参数不是稳定三段式就抛错；不解析预发布排序（npm semver 的规则更复杂）。
// 例：compareReleaseVersions("0.84.10","0.84.9") 返回 1，而字符串比较会得到相反结果。
export function compareReleaseVersions(left, right) {
	// exec 返回的数组第 0 项是完整匹配，第 1..3 项是三个捕获组（字符串）。
	const leftMatch = STABLE_SEMVER_RE.exec(left);
	const rightMatch = STABLE_SEMVER_RE.exec(right);
	if (!leftMatch || !rightMatch) throw new Error("Release versions must be stable semver versions.");

	// 依次比较 major、minor、patch；Number 把捕获组转成数值，避免 "10" < "9" 的字符串陷阱。
	for (const index of [1, 2, 3]) {
		const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
		if (difference !== 0) return difference;
	}
	return 0;
}

// 用“读-比较-条件写”循环推进 latest 指针，容忍并发发布。
// 输入目标版本和两个注入的异步函数：readLatest() → 当前标记或 undefined；
// writeLatest(condition) → true 表示写入成功、false 表示条件冲突。
// 返回 {advanced, version}：advanced=true 表示本次写入了目标版本；false 表示线上已是相等或更新版本。
// 达到最大尝试次数仍冲突则抛错。副作用由注入函数决定；本函数不直接访问网络。
// 例：读到的当前版本是 0.85.0、目标是 0.84.0 时立即返回 {advanced:false, version:"0.85.0"}。
export async function advanceLatestRelease(version, readLatest, writeLatest) {
	// 固定上限防止持续竞争导致无限循环；每次迭代都重新读取。
	for (let attempt = 0; attempt < MAX_POINTER_UPDATE_ATTEMPTS; attempt++) {
		// await 让出事件循环，readLatest 可以是网络读取。
		const current = await readLatest();
		// 已有版本 >= 目标版本时不回退；compareReleaseVersions <= 0 的等号对应“同版本已公告”。
		if (current && compareReleaseVersions(version, current.version) <= 0) {
			return { advanced: false, version: current.version };
		}

		// 有旧标记就带它的 ETag 做 if-match；没有就带 missing 做 if-none-match 创建。
		const updated = await writeLatest(current ? { etag: current.etag } : { missing: true });
		if (updated) {
			return { advanced: true, version };
		}
		// 写入失败说明有人并发修改了标记；下一轮重读后再判断，而不是盲目覆盖。
	}
	throw new Error(`Could not advance the Pi release marker to ${version} after ${MAX_POINTER_UPDATE_ATTEMPTS} attempts.`);
}

// 主流程：校验参数与版本 → 等待 npm 可见 → 写不可变发布记录 → 写安装器产物 → 推进两个 latest 指针。
// 输入来自 process.argv；输出是 stdout 日志；失败抛错，由底部入口设置退出码 1。
// 高风险：前两步成功后已经写入远端不可变对象；后续失败不会回滚，重跑依赖幂等跳过。
async function main() {
	// slice(2) 去掉 node 可执行文件与脚本路径，只留用户参数。
	const options = parseArgs(process.argv.slice(2));
	// 从工作区清单读取公开包及其版本；只读，不构建。
	const packages = getPublicWorkspacePackages();
	// 公告版本必须与所有公开包一致；不一致时任何上传都拒绝执行。
	for (const pkg of packages) {
		if (pkg.version !== options.version) {
			throw new Error(`${pkg.name} is ${pkg.version}; expected ${options.version}`);
		}
	}

	// 等 npm 真正可安装后再写公告，避免 pi.dev 指向不存在的 tarball；该调用可能等待数分钟。
	const publishedPackages = await verifyPackagesAreAvailable(packages);
	// 发布记录是 append-only 的版本快照；publishedAt 用 UTC ISO 字符串，便于 CDN/客户端解析。
	const release = {
		schemaVersion: 1,
		version: options.version,
		// ?? 只在 sourceCommit 为 null/undefined 时回退到 git HEAD；空串不会被替换。
		sourceCommit: options.sourceCommit ?? gitSourceCommit(),
		publishedAt: new Date().toISOString(),
		packages: publishedPackages,
	};
	// 临时目录存放待上传的 JSON 与 get-object 的输出；finally 中递归删除。
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-release-announcement-"));
	try {
		// release.json 与 latest.json 内容相同，但缓存策略和键不同；分别写两个临时文件。
		const releasePath = join(temporaryDirectory, "release.json");
		const latestPath = join(temporaryDirectory, "latest.json");
		// 制表符缩进 + 末尾换行，便于人阅读和 diff。
		writeFileSync(releasePath, `${JSON.stringify(release, null, "\t")}\n`);
		// 版本记录是不可变对象：缓存一年，条件为“仅当键不存在时创建”。
		// 返回 false 表示同版本已经公告过，打印提示后继续（幂等重跑）。
		if (
			!putJson(
				options.bucket,
				options.endpoint,
				releasePath,
				`${RELEASES_PREFIX}/releases/${options.version}.json`,
				"public, max-age=31536000, immutable",
				{ missing: true },
			)
		) {
			console.log(`Release record ${options.version} already exists.`);
		}

		// latest.json 也先写到临时文件，随后由 advanceLatestRelease 在满足版本条件时上传。
		writeFileSync(latestPath, `${JSON.stringify(release, null, "\t")}\n`);
		// 写安装器产物前先校验内容；不合法则抛错，此时发布记录可能已写入，但不会推进 latest。
		validateInstallerArtifacts(options.installerPackageJson, options.installerPackageLock, options.version);
		const installerReleasePrefix = `${INSTALLER_PREFIX}/releases/${options.version}`;
		// 三个安装器产物都不可变且按版本路径存放；已存在时 putObject 返回 false，
		// 这里故意不检查返回值：同版本重跑时保留第一次写入的内容。
		putObject(
			options.bucket,
			options.endpoint,
			options.installerPackageJson,
			`${installerReleasePrefix}/package.json`,
			"public, max-age=31536000, immutable",
			{ missing: true },
		);
		putObject(
			options.bucket,
			options.endpoint,
			options.installerPackageLock,
			`${installerReleasePrefix}/package-lock.json`,
			"public, max-age=31536000, immutable",
			{ missing: true },
		);
		putJson(
			options.bucket,
			options.endpoint,
			releasePath,
			`${installerReleasePrefix}/metadata.json`,
			"public, max-age=31536000, immutable",
			{ missing: true },
		);
		// 推进安装器的 latest 指针。readLatest 每次都重新 HEAD+GET；writeLatest 用条件写上传同一个 latestPath。
		const installerLatest = await advanceLatestRelease(
			options.version,
			() =>
				readLatestRelease(
					options.bucket,
					options.endpoint,
					`${INSTALLER_PREFIX}/latest.json`,
					join(temporaryDirectory, "installer-latest-current.json"),
				),
			(condition) =>
				putJson(
					options.bucket,
					options.endpoint,
					latestPath,
					`${INSTALLER_PREFIX}/latest.json`,
					"no-store",
					condition,
				),
		);
		// 三元表达式只决定提示文本；advanced=false 可能是同版本，也可能是线上已有更新版本。
		console.log(
			installerLatest.advanced
				? `Published installer artifacts for Pi ${options.version} through s3://${options.bucket}/${INSTALLER_PREFIX}/latest.json`
				: `Pi ${installerLatest.version} is already the latest installer release.`,
		);

		// 普通发布 latest 指针最后推进；只有到这里，pi.dev 才会把本次版本作为最新公告。
		const result = await advanceLatestRelease(
			options.version,
			() =>
				readLatestRelease(
					options.bucket,
					options.endpoint,
					`${RELEASES_PREFIX}/latest.json`,
					join(temporaryDirectory, "latest-current.json"),
				),
			(condition) =>
				putJson(
					options.bucket,
					options.endpoint,
					latestPath,
					`${RELEASES_PREFIX}/latest.json`,
					"no-store",
					condition,
				),
		);
		// advanced=false 时打印线上保留的版本，而不是本次目标版本。
		console.log(
			result.advanced
				? `Announced Pi ${options.version} through s3://${options.bucket}/${RELEASES_PREFIX}/latest.json`
				: `Pi ${result.version} is already the latest announced release.`,
		);
	} finally {
		// 无论成功还是中途抛错都删除临时目录；远端已写入的对象不会回滚。
		rmSync(temporaryDirectory, { force: true, recursive: true });
	}
}

// 仅当作为主模块直接运行时执行 main；被测试 import 时 import.meta.url 与 argv[1] 不同，不会触发网络写入。
// pathToFileURL 把 argv[1] 的路径转成与 import.meta.url 同格式的 URL 再比较。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	// catch 只打印 message（错误对象本身可能包含较长堆栈）；设置 exitCode 而不立即 process.exit，
	// 让未完成的输出/清理有机会结束；Node 最终以 1 退出。
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
