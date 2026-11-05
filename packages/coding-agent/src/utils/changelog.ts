// 为交互界面读取版本日志、筛出未读版本，并把日志里的仓库链接固定到对应发布标签；不访问GitHub，也不修改原Markdown文件。
import path from "node:path";
import { existsSync, readFileSync } from "fs";

export interface ChangelogEntry {
	// 这里只拆三段数字，不表达预发布/构建元数据；content包含该版本的##标题及正文。
	major: number;
	minor: number;
	patch: number;
	content: string;
}

// 相对链接以coding-agent包目录为基准；历史pi-mono地址统一到现在仓库，标签由日志版本而非当前分支决定。
const GITHUB_REPO = "earendil-works/pi";
const CHANGELOG_LINK_BASE_PATH = "packages/coding-agent";
// (?=\/|$)是前瞻，防止把pi-mono-other也误判为旧仓库；只匹配列出的HTTPS历史地址。
const LEGACY_REPO_RE = /^https:\/\/github\.com\/(?:badlogic|earendil-works)\/pi-mono(?=\/|$)/;
// 识别URL scheme，不限http；例如mailto:也保留，不当仓库相对路径。
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
// g全局处理简单内联链接/图片，三组分别保留前缀、无空白/右括号的目标、剩余标题和闭括号；非完整Markdown解析。
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;

// 输入已解析日志条目，返回三段数字拼成的版本，无副作用；例如{major:1,minor:2,patch:3,...}得到1.2.3。
function entryVersion(entry: ChangelogEntry): string {
	return `${entry.major}.${entry.minor}.${entry.patch}`;
}

// 输入版本字符串或条目，返回带小写v前缀的标签，不验证标签是否实际存在；例如1.2.3→v1.2.3，v1.2.3保持。
function normalizeTag(version: string | ChangelogEntry): string {
	// typeof在string|对象联合中收窄类型，非字符串分支可交给entryVersion。
	const versionString = typeof version === "string" ? version : entryVersion(version);
	// 仅检查首字符，不trim、不解析semver，V1.2.3会得到vV1.2.3。
	return versionString.startsWith("v") ? versionString : `v${versionString}`;
}

// 输入链接目标，分离路径、查询和片段并保留?/#符号，无I/O；例如a.md?q=1#x拆成a.md、?q=1、#x。
// 先切#再切?，因此片段内的?不被当查询；不URL解码，也不验证查询内容。
function splitLocalTarget(target: string): { fragment: string; pathPart: string; query: string } {
	const hashIndex = target.indexOf("#");
	// -1表示不存在，slice起止只取#之前或#及之后。
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");

	// 没有?时直接返回空query，属性简写保留已算好的fragment。
	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" };
	}

	// 对象返回值显式命名三个部分，调用方之后按路径→查询→片段重组。
	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	};
}

// 输入路径文字，把全部反斜杠改成/返回，无文件访问；例如docs\\a.md→docs/a.md，便于统一按POSIX仓库路径处理。
function normalizePathPart(value: string): string {
	return value.replaceAll("\\", "/");
}

// 输入本地链接路径，换算为仓库根内的词法路径，越过仓库根返回undefined；不检查文件/符号链接是否存在。
// 例如../../README.md从coding-agent包退到根README.md；以/开头按仓库根处理，不按本机文件系统绝对路径处理。
function resolveRepositoryPath(targetPath: string): string | undefined {
	const normalizedTarget = normalizePathPart(targetPath);
	// path.posix使Windows宿主也按/处理；normalize折叠.和..，根起始分支先去掉所有前导/。
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(CHANGELOG_LINK_BASE_PATH, normalizedTarget));

	// 拒绝根本身的.及仍需往根外走的..前缀，不对%2e等URL编码作解码判断。
	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

// 输入原路径及归一化仓库路径，用尾部/或末段无点号猜是否目录，返回布尔，无I/O。
// 例如examples/走tree，README.md走blob；无扩展名的LICENSE会被当目录，有点的目录也可能被当文件，不是文件类型保证。
function isDirectoryTarget(originalPath: string, repositoryPath: string): boolean {
	if (originalPath.endsWith("/")) {
		return true;
	}

	// basename只取最后一段，之前目录名是否带点不参与猜测。
	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
}

// 输入单个链接和目标标签，先统一旧仓库/固定main或master引用，再将相对路径转为GitHub blob/tree URL返回。
// 例如README.md配v1.2.3得到该标签的包README；锚点、//URL和带scheme目标原样保留，不判断URL是否安全或资源是否存在。
function normalizeChangelogLinkTarget(target: string, tag: string): string {
	// replace只改匹配的历史HTTPS仓库前缀，不对其他域名做仓库推断。
	let canonicalTarget = target.replace(LEGACY_REPO_RE, `https://github.com/${GITHUB_REPO}`);
	const repoUrl = `https://github.com/${GITHUB_REPO}`;

	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			// 只替换正式仓库这两个浮动分支，已有具体标签/提交引用不改。
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (canonicalTarget.startsWith(floatingRefPrefix)) {
				canonicalTarget = `${repoUrl}/${route}/${tag}/${canonicalTarget.slice(floatingRefPrefix.length)}`;
			}
		}
	}

	// 完成仓库前缀改写后再排除其他URL，因而历史绝对链接也能被固定版本。
	if (canonicalTarget.startsWith("#") || canonicalTarget.startsWith("//") || URL_SCHEME_RE.test(canonicalTarget)) {
		return canonicalTarget;
	}

	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget);
	// 只有查询等而无路径时不凭空添加包目录。
	if (!pathPart) {
		return canonicalTarget;
	}

	const repositoryPath = resolveRepositoryPath(pathPart);
	// 不可归入仓库时保留原目标，而非删除或抛错。
	if (!repositoryPath) {
		return canonicalTarget;
	}

	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob";
	// encodeURI编码路径里的空格等但保留URI保留字符；query/fragment原样拼回，不是逐段encodeURIComponent。
	return `https://github.com/${GITHUB_REPO}/${route}/${tag}/${encodeURI(repositoryPath)}${query}${fragment}`;
}

// 输入日志Markdown和版本，返回改写简单内联链接/图片目标后的新字符串，无文件/网络副作用。
// 例如[说明](docs/a.md)固定到当前日志条目的v标签；引用式链接、复杂括号/嵌套标签不由这条正则完整处理，代码块内看似链接的文本也可能命中。
export function normalizeChangelogLinks(markdown: string, version: string | ChangelogEntry): string {
	const tag = normalizeTag(version);
	// replace回调收取三个捕获组，_match表示整个匹配但不使用；保留链接标签、图片!及可选标题，只替换target。
	return markdown.replace(INLINE_MARKDOWN_LINK_RE, (_match, prefix, target, suffix) => {
		return `${prefix}${normalizeChangelogLinkTarget(target, tag)}${suffix}`;
	});
}

/**
 * Parse changelog entries from CHANGELOG.md
 * Scans for ## lines and collects content until next ## or EOF
 */
// 输入CHANGELOG文件路径，同步读文本并按##标题收集三段数字版本条目，保留文件顺序；不存在返回[]，解析/读取异常警告后[]。
// 例如## [1.2.3]之后的### Fixed归该版本，## [Unreleased]重置收集；不是完整Markdown/semver解析，代码围栏中的##也会被当标题。
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	// 存在检查和后续读取分开，文件可在两者之间变化；读取失败由下面catch处理。
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		// 同步读取会阻塞；按\n拆分，最终每条内容trim会清理首尾空白但不统一所有内部\r。
		const content = readFileSync(changelogPath, "utf-8");
		const lines = content.split("\n");
		const entries: ChangelogEntry[] = [];

		// 当前条目的行缓冲及可空版本，null表示尚未遇到可解析版本/正在Unreleased等区段。
		let currentLines: string[] = [];
		let currentVersion: { major: number; minor: number; patch: number } | null = null;

		for (const line of lines) {
			// Check if this is a version header (## [x.y.z] ...)
			// 必须列首是两个#加普通空格，###或前面缩进不走标题分支。
			if (line.startsWith("## ")) {
				// Save previous entry if exists
				if (currentVersion && currentLines.length > 0) {
					entries.push({
						// 展开三段版本字段，再附加含标题的正文；生成新对象而非共享可变缓冲。
						...currentVersion,
						content: currentLines.join("\n").trim(),
					});
				}

				// Try to parse version from this line
				// 方括号可各自省略，表达式也不要求patch数字后立即结束，因此预发布后缀并未单独保存在版本字段中。
				const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
				if (versionMatch) {
					currentVersion = {
						// 捕获数字按十进制转换，不把完整版本字符串交给semver。
						major: Number.parseInt(versionMatch[1], 10),
						minor: Number.parseInt(versionMatch[2], 10),
						patch: Number.parseInt(versionMatch[3], 10),
					};
					// 新条目从标题自身开始，显示时可保留发布标题/链接。
					currentLines = [line];
				} else {
					// Reset if we can't parse version
					// 未识别标题终止上一条；其后正文不误归入上一发布版本。
					currentVersion = null;
					currentLines = [];
				}
			} else if (currentVersion) {
				// Collect lines for current version
				currentLines.push(line);
			}
		}

		// Save last entry
		// EOF不会再来一个标题触发保存，需手动把最后一个版本推入结果。
		if (currentVersion && currentLines.length > 0) {
			entries.push({
				...currentVersion,
				content: currentLines.join("\n").trim(),
			});
		}

		return entries;
	} catch (error) {
		// catch值可以是任意错误，插值作展示；故障时不返回已经解析的一部分条目。
		console.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/**
 * Compare versions. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
// 输入两个三段数字条目，返回首个不同段的差值，只表示正/零/负，无副作用；不比较content或预发布标签。
// 原English用±1概述方向，实际不保证恰好±1：例如major=3对1返回2；可作sort比较器或与0比较。
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	// 优先级major→minor→patch，前一段不同就不再比较后一段。
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

/**
 * Get entries newer than lastVersion
 */
// 输入日志条目与上次版本文字，返回数值更大的条目新数组，保留原顺序和条目对象引用；不排序、不修改输入。
// 例如上次1.2.3筛出1.2.4/2.0.0；split+Number不是semver，缺段/NaN通过||变0，v1.2.3也不会自动去v。
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	// Parse lastVersion
	// map(Number)逐段转换；预发布或其他非数字文本可能成为NaN，而不是严格报无效版本。
	const parts = lastVersion.split(".").map(Number);
	const last: ChangelogEntry = {
		// ||使0、NaN、undefined回退0；content仅为满足条目结构，比较函数不会读它。
		major: parts[0] || 0,
		minor: parts[1] || 0,
		patch: parts[2] || 0,
		content: "",
	};

	// filter使用>0判断比较方向，不依赖比较结果恰好是1。
	return entries.filter((entry) => compareVersions(entry, last) > 0);
}

// Re-export getChangelogPath from paths.ts for convenience
// 实际从统一config导出定位函数（原English的paths.ts是旧说明）；这里只转导出，不在模块加载时读日志。
export { getChangelogPath } from "../config.ts";
