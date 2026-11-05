#!/usr/bin/env node

// 文件导读：发布说明工具，负责从 CHANGELOG 提取版本段落并修复 GitHub Release 中的链接。
// 所属：仓库根 scripts/；`npm run release:fix-links` 与 `.github/workflows/build-binaries.yml` 的
//   release payload 步骤调用 extract。
// 作用：两个子命令：
//   - extract：从 packages/coding-agent/CHANGELOG.md 取 `## [x.y.z]` 段落，把段落内的相对链接、
//     legacy 仓库链接、main/master 浮动链接规范化为指向具体 tag 的 GitHub URL，输出到文件或 stdout。
//   - fix-github-releases：列出 GitHub Releases（需要已认证的 `gh`），对不早于 --since-tag 的发布正文做同样规范化，
//     并调用 `gh release edit` 原地更新；--dry-run 只打印将修改的内容。
// 上游：CLI `node scripts/release-notes.mjs <extract|fix-github-releases> [options]`；参数错误/未知命令退出码 1。
// 下游：spawnSync 调用 `gh api` 与 `gh release edit`；写临时 notes 文件；extract 可写 --out 文件。
// 高风险：fix-github-releases 会真实修改已发布的 GitHub Release 正文（不可逆，除非 GitHub 有历史可回滚）；
//   必须先 --dry-run 检查。extract 只读 CHANGELOG，不访问网络。
// 退出码：--help 无命令时退出 1、有命令时 0；成功 0；异常打印 message 后退出 1（临时文件在 finally 删除）。
// 能力清单：
//   - printUsage / parseOptions：命令行帮助与选项解析。
//   - run / listGithubReleases / updateGithubRelease：gh 子进程封装。
//   - normalizeLinkTarget / normalizeReleaseNoteLinks：链接规范化的核心。
//   - extractChangelogSection / extractReleaseNotes：CHANGELOG 段落提取。
//   - fixGithubReleases：批量修复 GitHub Release。
// 典型调用：
//   extract 示例：node scripts/release-notes.mjs extract --version 0.85.0 --tag v0.85.0 --out /tmp/notes.md
//   fix 示例：node scripts/release-notes.mjs fix-github-releases --dry-run --since-tag v0.74.0
//   预期：stdout 列出将更新/已更新的 release 与链接变化。
// 阅读顺序：先看 printUsage 里的参数契约，再看 extractChangelogSection 与 normalizeLinkTarget，
//   最后看 fixGithubReleases 的筛选与写回。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 默认仓库、相对链接基准目录、CHANGELOG 路径与批量修复的最早 tag。
const DEFAULT_REPO = "earendil-works/pi";
const DEFAULT_BASE_PATH = "packages/coding-agent";
const DEFAULT_CHANGELOG = "packages/coding-agent/CHANGELOG.md";
const DEFAULT_FIX_SINCE_TAG = "v0.74.0";
// 旧仓库地址（pi-mono，个人与组织命名空间）需要重写到新仓库；lookahead 防止匹配到 pi-mono-extra 之类前缀。
const LEGACY_REPO_RE = /^https:\/\/github\.com\/(?:badlogic|earendil-works)\/pi-mono(?=\/|$)/;
// URL scheme 形如 https:、mailto:；匹配后不再当相对路径处理。
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
// 匹配 Markdown 内联链接/图片：前缀（含可选 ! 与 ](）、目标、后缀（可含标题与右括号）。
// 目标用 [^\s)]+ 排除空白和右括号，因此不能处理含空格或嵌套括号的 URL。
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;

// 打印用法与两个子命令的选项；纯输出函数，不读文件。
// 注意：Usage 文本是运行时输出的一部分，保持英文原样。
function printUsage() {
	// 整个模板字符串是一次 console.log 的实参；不改动其中的英文帮助文本。
	console.log(`Usage: node scripts/release-notes.mjs <command> [options]

Commands:
  extract              Extract release notes from the coding-agent changelog
  fix-github-releases  Rewrite existing GitHub release note links in place

extract options:
  --version <x.y.z>    Version to extract
  --tag <vX.Y.Z>       Release tag used for repository links (defaults to v<version>)
  --changelog <path>   Changelog path (default: ${DEFAULT_CHANGELOG})
  --out <path>         Output file (default: stdout)
  --repo <owner/repo>  GitHub repository for generated links (default: ${DEFAULT_REPO})
  --base-path <path>   Base path for relative changelog links (default: ${DEFAULT_BASE_PATH})

fix-github-releases options:
  --repo <owner/repo>     GitHub repository to patch (default: ${DEFAULT_REPO})
  --tag <vX.Y.Z>          Patch only one release tag
  --since-tag <vX.Y.Z>    Oldest release tag to patch (default: ${DEFAULT_FIX_SINCE_TAG})
  --base-path <path>      Base path for relative changelog links (default: ${DEFAULT_BASE_PATH})
  --dry-run               Print releases that would change without updating GitHub
`);
}

// Windows 上 npm/gh 等命令需要 .cmd 后缀；其他平台原样返回。
// 例：commandForPlatform("gh") 在 Windows 返回 "gh.cmd"。
function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

// 同步运行外部命令；默认继承 stdio，capture=true 时捕获 stdout/stderr 并返回 stdout。
// 输入 command/args/options；输出 stdout 字符串；非 0 退出抛错并附带输出。
// 副作用：启动子进程；不重试、不解析具体错误类型。
// 例：run("gh", ["--version"], { capture: true }) 返回版本文本。
function run(command, args, options = {}) {
	// spawnSync 同步等待命令结束；maxBuffer 放大到 20 MiB，因为 gh api 可能返回大量 release 正文。
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
		// capture 时 stdin 继承、stdout/stderr 管道；否则全部继承，进度直接显示。
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		// 两个输出流可能为 null；filter(Boolean) 去掉空值后换行拼接。
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	// 非 capture 时 stdout 为 null；?? 统一成空字符串。
	return result.stdout ?? "";
}

// 解析选项：初始化默认值，逐项消费 `--name value` 与布尔 --dry-run/--help。
// --help 直接打印并退出 0；未知选项或缺值抛错。返回 options 对象。
// 例：["--version","0.85.0","--out","/tmp/n.md"] → {version:"0.85.0", out:"/tmp/n.md", ...默认值}。
function parseOptions(args) {
	const options = {
		basePath: DEFAULT_BASE_PATH,
		changelog: DEFAULT_CHANGELOG,
		dryRun: false,
		out: undefined,
		repo: DEFAULT_REPO,
		sinceTag: DEFAULT_FIX_SINCE_TAG,
		tag: undefined,
		version: undefined,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		// 帮助是成功路径，直接结束进程，不返回。
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		}
		// dry-run 无值；continue 避免落入下面的带值选项检查。
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}

		// 每次循环重建 Set；选项很少，这样写比模块级常量更局部。
		const optionNames = new Set(["--base-path", "--changelog", "--out", "--repo", "--since-tag", "--tag", "--version"]);
		if (!optionNames.has(arg)) {
			throw new Error(`Unknown option: ${arg}`);
		}

		// 前缀自增取下一个参数；缺失时明确报错。
		const value = args[++i];
		if (!value) {
			throw new Error(`${arg} requires a value`);
		}

		// 逐个 if 赋值，而不是动态映射：字段名与校验在这里集中可见。
		if (arg === "--base-path") options.basePath = value;
		if (arg === "--changelog") options.changelog = value;
		if (arg === "--out") options.out = value;
		if (arg === "--repo") options.repo = value;
		if (arg === "--since-tag") options.sinceTag = value;
		if (arg === "--tag") options.tag = value;
		if (arg === "--version") options.version = value;
	}

	return options;
}

// 给版本/标签补上 v 前缀；空值返回 undefined。例："0.85.0" → "v0.85.0"，"v0.85.0" 不变。
function normalizeTag(tagOrVersion) {
	if (!tagOrVersion) {
		return undefined;
	}
	return tagOrVersion.startsWith("v") ? tagOrVersion : `v${tagOrVersion}`;
}

// 从 tag 去掉 v 前缀；例 "v0.85.0" → "0.85.0"。不校验格式。
function versionFromTag(tag) {
	return tag.startsWith("v") ? tag.slice(1) : tag;
}

// 比较两个 tag/版本的三段数字；返回负数/0/正数。缺失的段按 0 处理（aParts[i] || 0）。
// 不处理预发布后缀；输入格式由调用方保证是发布 tag。
// 例：compareVersions("v0.84.10","v0.84.9") 返回 1。
function compareVersions(a, b) {
	// split(".") 得到字符串数组，map(Number) 转数值；非数字段会得到 NaN，但发布 tag 不会出现。
	const aParts = versionFromTag(a).split(".").map(Number);
	const bParts = versionFromTag(b).split(".").map(Number);

	// 只比较三段；|| 0 同时处理 undefined 与 0 值。
	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

// 转义正则元字符，使任意版本字符串都能安全放进 RegExp 构造函数。
// 例：escapeRegExp("1.0.0") → "1\\.0\\.0"。
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 从 CHANGELOG 文本中取 `## [version]` 标题到下一个 `## [` 之间的内容。
// 命中返回去除首尾空白的正文；没有对应标题返回空字符串。
// 例：extractChangelogSection(text, "0.85.0") 返回该版本条目正文。
function extractChangelogSection(changelog, version) {
	// m 标志让 ^/$ 匹配每行；日期后缀可选，兼容 `## [0.85.0] - 2026-01-01` 与无日期标题。
	// 版本必须转义，否则 0.85.0 的点号会匹配任意字符。
	const headingRe = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, "m");
	const heading = headingRe.exec(changelog);

	if (!heading) {
		return "";
	}

	// index 是匹配起点（行首），加上整段匹配长度得到正文起点。
	const sectionStart = heading.index + heading[0].length;
	const rest = changelog.slice(sectionStart);
	// 找下一个版本标题；search 返回索引或 -1。
	const nextHeading = rest.search(/^## \[/m);
	// -1 表示一直到文件末尾；否则截到下一个标题前。
	const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
	return section.trim();
}

// 把本地链接拆成 path/query/fragment 三部分，便于分别处理再拼回。
// 例："./foo.md?plain=1#L2" → {pathPart:"./foo.md", query:"?plain=1", fragment:"#L2"}。
// fragment 从第一个 # 开始，query 是 path 部分中第一个 ? 起的后缀。
function splitLocalTarget(target) {
	// indexOf 找不到返回 -1；三元分别处理“有/无片段”。
	const hashIndex = target.indexOf("#");
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
	// query 只在 fragment 之前的部分查找，避免把 URL 片段里的 ? 当查询串。
	const queryIndex = beforeHash.indexOf("?");

	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" };
	}

	// 返回对象用属性简写；pathPart 不含 ?，# 保留在 fragment 中。
	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	};
}

// 把 Windows 反斜杠统一成正斜杠，便于用 path.posix 处理。
function normalizePathPart(value) {
	return value.replaceAll("\\", "/");
}

// 规范化基准目录：正斜杠、posix normalize、去掉末尾斜杠；"." 视为空字符串。
// 例：normalizeBasePath("packages\\coding-agent/") → "packages/coding-agent"。
function normalizeBasePath(basePath) {
	const normalized = path.posix.normalize(normalizePathPart(basePath)).replace(/\/+$/, "");
	return normalized === "." ? "" : normalized;
}

// 把链接目标解析成仓库内路径：绝对路径去掉前导 /，相对路径拼到 basePath 后 normalize。
// 输出 undefined 表示路径逃出仓库根（以 .. 开头或为空），调用方会保留原链接。
// 例：resolveRepositoryPath("./docs/a.md","packages/coding-agent") → "packages/coding-agent/docs/a.md"。
function resolveRepositoryPath(targetPath, basePath) {
	const normalizedTarget = normalizePathPart(targetPath);
	// 以 / 开头视为仓库根绝对路径：去掉所有前导斜杠再 normalize。
	// 否则用 path.posix.join 拼基准目录；join 会处理 ./ 与 ../。
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(normalizeBasePath(basePath), normalizedTarget));

	// 逃出仓库根的链接不安全也不该改写，返回 undefined。
	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

// 猜测链接目标是目录还是文件：以 / 结尾是目录；否则看 basename 是否含点号。
// 这是启发式，不是文件系统检查；例 "docs" 当目录，"a.md" 当文件。
function isDirectoryTarget(originalPath, repositoryPath) {
	if (originalPath.endsWith("/")) {
		return true;
	}

	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
}

// 规范化单个链接目标，options 含 {repo, basePath, tag}；返回新的目标字符串。
// 依次：重写 legacy 仓库 → 把 main/master 浮动链接换成具体 tag → 保留外部/锚点链接 →
// 把仓库内相对路径改写成 `https://github.com/<repo>/<blob|tree>/<tag>/<path>`。
// 无法安全解析的链接原样返回。例："./foo.md#L1" 在 basePath packages/coding-agent 下变成 tag 固定的 blob URL。
function normalizeLinkTarget(target, options) {
	// 先把旧仓库前缀换成新仓库；其余路径保持不变。
	let canonicalTarget = target.replace(LEGACY_REPO_RE, `https://github.com/${options.repo}`);
	const repoUrl = `https://github.com/${options.repo}`;

	// 遍历两种 GitHub 路径类型与两个浮动分支名；命中后把分支段替换成发布 tag。
	// 只做前缀替换，循环继续也不会重复改写（替换后的前缀已不是 main/master）。
	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (canonicalTarget.startsWith(floatingRefPrefix)) {
				canonicalTarget = `${repoUrl}/${route}/${options.tag}/${canonicalTarget.slice(floatingRefPrefix.length)}`;
			}
		}
	}

	// 纯锚点、协议相对 URL（//host）和带 scheme 的外部链接不处理。
	if (canonicalTarget.startsWith("#") || canonicalTarget.startsWith("//") || URL_SCHEME_RE.test(canonicalTarget)) {
		return canonicalTarget;
	}

	// 剩余目标视为仓库内相对路径；拆出 query/fragment 以保留它们。
	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget);
	if (!pathPart) {
		return canonicalTarget;
	}

	// 解析失败（逃出仓库根）时保留原链接，避免生成指向仓库外的错误 URL。
	const repositoryPath = resolveRepositoryPath(pathPart, options.basePath);
	if (!repositoryPath) {
		return canonicalTarget;
	}

	// 目录用 tree，文件用 blob；encodeURI 保留路径分隔符 /，只编码空格等特殊字符。
	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob";
	return `https://github.com/${options.repo}/${route}/${options.tag}/${encodeURI(repositoryPath)}${query}${fragment}`;
}

// 扫描 Markdown 中所有内联链接/图片，逐个规范化；返回 {changes, markdown}。
// changes 记录实际变化的 from/to，用于日志；markdown 是替换后的全文。
// 替换回调不修改原 match 的前缀与后缀，只替换中间目标。
function normalizeReleaseNoteLinks(markdown, options) {
	const changes = [];
	// replace 的回调参数依次是整段匹配、捕获组 1..n；这里忽略 match 本体，用 prefix/target/suffix 重建。
	const normalized = markdown.replace(INLINE_MARKDOWN_LINK_RE, (match, prefix, target, suffix) => {
		const normalizedTarget = normalizeLinkTarget(target, options);
		// 只有真正变化才记录，避免日志里出现大量未改链接。
		if (normalizedTarget !== target) {
			changes.push({ from: target, to: normalizedTarget });
		}
		// 保留链接文字、标题与右括号；只替换目标部分。
		return `${prefix}${normalizedTarget}${suffix}`;
	});

	return { changes, markdown: normalized };
}

// 输出内容：有 outPath 时写文件，否则写 stdout。副作用由调用方选择；不追加换行。
function writeOutput(content, outPath) {
	if (outPath) {
		writeFileSync(outPath, content);
		return;
	}

	// stdout.write 不自动换行；内容本身以 \n 结尾。
	process.stdout.write(content);
}

// extract 子命令：确定版本与 tag，读取 CHANGELOG，取对应段落并规范化链接后输出。
// 缺少 --version/--tag 或 changelog 不存在时抛错；不访问网络。
// 例：extractReleaseNotes({version:"0.85.0", tag:undefined, out:"/tmp/n.md", ...})。
function extractReleaseNotes(options) {
	// 版本优先取 --version；否则从 --tag 去掉 v。两者都没有则无法定位段落。
	const version = options.version ?? (options.tag ? versionFromTag(options.tag) : undefined);
	if (!version) {
		throw new Error("extract requires --version or --tag");
	}

	// 文件缺失是明确错误，不输出空说明。
	if (!existsSync(options.changelog)) {
		throw new Error(`Changelog does not exist: ${options.changelog}`);
	}

	// tag 缺省为 v<version>；用于生成指向具体版本的仓库链接。
	const tag = normalizeTag(options.tag ?? version);
	const changelog = readFileSync(options.changelog, "utf8");
	const section = extractChangelogSection(changelog, version);
	// 找不到段落时退回一行 `Release x.y.z`，保证输出非空且可读。
	const rawNotes = section ? `${section}\n` : `Release ${version}\n`;
	// 只取 markdown，不需要 changes 日志。
	const { markdown } = normalizeReleaseNoteLinks(rawNotes, { basePath: options.basePath, repo: options.repo, tag });
	writeOutput(markdown, options.out);
}

// 列出仓库的全部 GitHub Releases（分页），每条解析为 {id, tag_name, body}。
// 需要已认证 gh；失败抛错。副作用：执行 gh api 并读取 stdout。
// 例：listGithubReleases("earendil-works/pi") 返回 release 数组。
function listGithubReleases(repo) {
	// --paginate 自动翻页；--jq 让 gh 逐条输出 JSON 行，避免把整个响应解析成大数组。
	const output = run("gh", ["api", `repos/${repo}/releases`, "--paginate", "--jq", ".[] | {id, tag_name, body} | @json"], {
		capture: true,
	});
	// 按行拆分、去空白、去空行，再逐行 JSON.parse；返回数组。
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

// 对 changes 按 from+to 去重，保持第一次出现的顺序；用于日志，不改变实际替换。
// 例：同一坏链接在正文出现多次时只打印一次。
function uniqueChanges(changes) {
	const seen = new Set();
	const unique = [];
	for (const change of changes) {
		// 用换行连接两个字段，避免 "a\nb" 与 "a"+"\nb" 之类拼接歧义。
		const key = `${change.from}\n${change.to}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		unique.push(change);
	}
	return unique;
}

// 用 gh release edit 更新指定 tag 的正文；正文先写临时文件，避免长文本作为命令行参数。
// 副作用：真实修改 GitHub Release；失败抛错；临时目录在 finally 删除。
// 例：updateGithubRelease("earendil-works/pi","v0.85.0","...markdown...")。
function updateGithubRelease(repo, tag, body) {
	// 每次更新独立临时目录，避免并发运行互相覆盖 notes.md。
	const tempDir = mkdtempSync(path.join(tmpdir(), "pi-release-notes-"));
	try {
		const notesPath = path.join(tempDir, "notes.md");
		writeFileSync(notesPath, body);
		// --notes-file 保留多行 Markdown；capture 让我们只关心失败输出。
		run("gh", ["release", "edit", tag, "--repo", repo, "--notes-file", notesPath], { capture: true });
	} finally {
		rmSync(tempDir, { force: true, recursive: true });
	}
}

// fix-github-releases 子命令：列出 releases → 按 tag 过滤 → 从 since-tag 起逐个规范化正文 →
// 非 dry-run 时调用 gh release edit 写回。输出每个变化的链接与总数。
// 失败：指定 tag 不存在抛错；gh 调用失败抛错，前面的更新已生效、不会回滚。
// 例：fixGithubReleases({repo, tag:undefined, sinceTag:"v0.74.0", dryRun:true, basePath:"packages/coding-agent"})。
function fixGithubReleases(options) {
	// tag 过滤是可选的；sinceTag 始终有默认值，因此至少会扫描到 v0.74.0。
	const tagFilter = normalizeTag(options.tag);
	const sinceTag = normalizeTag(options.sinceTag);
	// 先列出全部 release（可能很多），再按精确 tag 过滤。
	const matchingReleases = listGithubReleases(options.repo).filter((release) => !tagFilter || release.tag_name === tagFilter);

	// 明确指定了 tag 却找不到，说明参数或仓库错误，直接失败。
	if (tagFilter && matchingReleases.length === 0) {
		throw new Error(`Release not found: ${tagFilter}`);
	}

	// 只处理版本 >= sinceTag 的 release；compareVersions 忽略 v 前缀。
	const releases = matchingReleases.filter((release) => compareVersions(release.tag_name, sinceTag) >= 0);
	// 指定的 tag 本身早于 sinceTag：没有工作可做，按成功结束。
	if (tagFilter && releases.length === 0) {
		console.log(`Skipping ${tagFilter}: older than ${sinceTag}.`);
		console.log(`${options.dryRun ? "Would update" : "Updated"} 0 releases.`);
		return;
	}

	let changedCount = 0;
	for (const release of releases) {
		const tag = release.tag_name;
		// body 可能为 null（空 release），统一成空串。
		const body = release.body ?? "";
		// 用该 release 的 tag 作为链接目标，确保链接指向对应版本的代码。
		const result = normalizeReleaseNoteLinks(body, { basePath: options.basePath, repo: options.repo, tag });
		// 没有链接变化就不调用 gh，避免无意义的 API 写入。
		if (result.markdown === body) {
			continue;
		}

		changedCount++;
		// 去重只影响日志展示；写回的是完整 markdown。
		const unique = uniqueChanges(result.changes);
		console.log(`${options.dryRun ? "Would update" : "Updating"} ${tag} (${unique.length} link${unique.length === 1 ? "" : "s"})`);
		for (const change of unique) {
			console.log(`  ${change.from}`);
			console.log(`  -> ${change.to}`);
		}

		// dry-run 只打印；真实运行时逐个 release 写回，某个失败会中断后续。
		if (!options.dryRun) {
			updateGithubRelease(options.repo, tag, result.markdown);
		}
	}

	const prefix = options.dryRun ? "Would update" : "Updated";
	console.log(`${prefix} ${changedCount} release${changedCount === 1 ? "" : "s"}.`);
}

// 顶层分发：无命令或 --help 时打印用法；无命令以 1 退出，有 --help 以 0 退出。
// 未知命令抛错，由 catch 统一打印并退出 1。
try {
	// 数组解构：第一个元素是子命令，其余是选项参数。
	const [command, ...args] = process.argv.slice(2);
	if (!command || command === "--help") {
		printUsage();
		// 完全没有命令是用法错误（1）；显式 --help 是成功（0）。
		process.exit(command ? 0 : 1);
	}

	const options = parseOptions(args);
	if (command === "extract") {
		extractReleaseNotes(options);
	} else if (command === "fix-github-releases") {
		fixGithubReleases(options);
	} else {
		throw new Error(`Unknown command: ${command}`);
	}
} catch (error) {
	// catch 参数是 unknown；只打印 Error.message，其他值直接打印。
	console.error(error instanceof Error ? error.message : error);
	// 显式 1，表示命令失败；成功路径自然结束为 0。
	process.exit(1);
}
