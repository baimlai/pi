#!/usr/bin/env node
// Build the single-file web version of the module docs and validate source-code routes.
// Usage:
//   node build.mjs                 generate index.html
//   node build.mjs --check         validate links only
//   node build.mjs --fix           fix line numbers from link titles, then generate
//   node build.mjs --serve         generate, then serve index.html with a local IDE opener
//   node build.mjs --serve --port=4918

import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");

const PAGES = [
	{ id: "home", file: "README.md", title: "总览", short: "首页", group: "开始" },
	{ id: "course", file: "COURSE.md", title: "课程地图", short: "课程", group: "开始" },
	{ id: "00-full-chain", file: "00-full-chain/README.md", title: "00 全链路", short: "00", group: "主线" },
	{ id: "traces", file: "traces/README.md", title: "贯穿追踪", short: "追踪", group: "主线" },
	{ id: "01-entry-and-config", file: "01-entry-and-config/README.md", title: "01 入口与装配", short: "01", group: "模块" },
	{ id: "02-agent-loop", file: "02-agent-loop/README.md", title: "02 Agent 循环", short: "02", group: "模块" },
	{ id: "03-session-and-context", file: "03-session-and-context/README.md", title: "03 会话与上下文", short: "03", group: "模块" },
	{ id: "04-model-access", file: "04-model-access/README.md", title: "04 模型访问", short: "04", group: "模块" },
	{ id: "05-modes-and-tui", file: "05-modes-and-tui/README.md", title: "05 模式与 TUI", short: "05", group: "模块" },
	{ id: "glossary", file: "GLOSSARY.md", title: "术语表", short: "术语", group: "速查" },
	{ id: "debug-map", file: "DEBUG_MAP.md", title: "排障地图", short: "排障", group: "速查" },
	{ id: "guide", file: "GUIDE.md", title: "编写指南", short: "G", group: "维护" },
];

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".html", ".css", ".sh", ".bat"]);
const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"((?:[^"\\]|\\.)*)")?\)/g;
const LOG_TAG = "modules-chain";

const args = new Set(process.argv.slice(2));
const mode = args.has("--check") ? "check" : args.has("--fix") ? "fix" : "build";

const IDE_LABELS = { vscode: "VS Code", pycharm: "PyCharm", webstorm: "WebStorm" };
const IDE = (() => {
	const value = process.argv.find((arg) => arg.startsWith("--ide="))?.slice("--ide=".length) ?? "webstorm";
	if (!Object.hasOwn(IDE_LABELS, value)) {
		console.error(`[${LOG_TAG}] unknown IDE: ${value} (use vscode, pycharm or webstorm)`);
		process.exit(1);
	}
	return value;
})();

const PORT = (() => {
	const value = process.argv.find((arg) => arg.startsWith("--port="))?.slice("--port=".length);
	if (value === undefined) return 4917;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error(`[${LOG_TAG}] invalid --port: ${value}`);
		process.exit(1);
	}
	return port;
})();
const OPENER_URL = `http://127.0.0.1:${PORT}`;
const SERVE = args.has("--serve");

function ideUrl(absolutePath, line) {
	if (IDE === "vscode") return `vscode://file${encodeURI(absolutePath)}:${line}`;
	return `${IDE}://open?file=${encodeURIComponent(absolutePath)}&line=${line}`;
}

function readPage(page) {
	return fs.readFileSync(path.join(HERE, page.file), "utf8");
}

function pageByFile(absPath) {
	return PAGES.find((page) => path.join(HERE, page.file) === absPath);
}

function isInsideRoot(absPath) {
	const rel = path.relative(ROOT, absPath);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function unescapeTitle(title) {
	return title.replace(/\\(["\\])/g, "$1");
}

function splitRouteUrl(url) {
	const hashIndex = url.indexOf("#");
	if (hashIndex < 0) return { pathPart: url, anchor: undefined };
	return { pathPart: url.slice(0, hashIndex), anchor: url.slice(hashIndex + 1) };
}

function lineNumberOf(file) {
	try {
		const text = fs.readFileSync(file, "utf8");
		if (text === "") return 0;
		const lines = text.split(/\r?\n/);
		// split 会把结尾换行后的空串也算一项；它不是可跳转的真实行。
		return text.endsWith("\n") ? lines.length - 1 : lines.length;
	} catch {
		return 0;
	}
}

function findTitleLine(file, title, nearLine) {
	const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
	const needle = unescapeTitle(title);
	const matches = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes(needle)) matches.push(i + 1);
	}
	if (matches.length === 0) return { matches, best: undefined };
	let best = matches[0];
	for (const line of matches) {
		if (Math.abs(line - nearLine) < Math.abs(best - nearLine)) best = line;
	}
	return { matches, best };
}

function inlineCodeRanges(line) {
	const ranges = [];
	for (const match of line.matchAll(/`[^`]*`/g)) {
		ranges.push([match.index, match.index + match[0].length]);
	}
	return ranges;
}

function isInsideRanges(ranges, position) {
	return ranges.some(([start, end]) => position >= start && position < end);
}

function forEachLineOutsideFences(text, callback) {
	const lines = text.split(/\r?\n/);
	let inFence = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) callback(line, index);
	}
}

function walkLinksForCheck(page) {
	const filePath = path.join(HERE, page.file);
	const text = fs.readFileSync(filePath, "utf8");
	const issues = [];
	const warnings = [];
	forEachLineOutsideFences(text, (line) => {
		const codeRanges = inlineCodeRanges(line);
		LINK_RE.lastIndex = 0;
		for (let match = LINK_RE.exec(line); match !== null; match = LINK_RE.exec(line)) {
			if (isInsideRanges(codeRanges, match.index)) continue;
			checkOneLink(page, text, filePath, match[1], match[2], match[3], issues, warnings);
		}
	});
	return { issues, warnings };
}

function hasHeadingSlug(text, slug) {
	let inFence = false;
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const heading = line.match(/^#{1,4}\s+(.*)$/);
		if (heading && slugify(heading[1]) === slug) return true;
	}
	return false;
}

function checkOneLink(page, text, filePath, label, url, title, issues, warnings) {
	if (!url || url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:")) return;
	if (url.startsWith("#/")) return;

	if (url.startsWith("#")) {
		const anchor = url.slice(1);
		// 渲染后的标题 id 带页面前缀，原文里不会有；按标题 slug 判断目标是否存在。
		if (anchor && !text.includes(`id="${anchor}"`) && !hasHeadingSlug(text, anchor)) {
			warnings.push(`${page.file}: 同页锚点未找到 id="${anchor}" (${label})`);
		}
		return;
	}

	const scheme = url.match(/^([a-z][a-z0-9+.-]*):/i);
	if (scheme) {
		issues.push(`${page.file}: 不支持的链接协议 ${scheme[1]}: (${label})`);
		return;
	}

	const { pathPart, anchor } = splitRouteUrl(url);
	if (!pathPart) return;
	const target = path.resolve(path.dirname(filePath), pathPart);

	if (!fs.existsSync(target)) {
		issues.push(`${page.file}: 文件不存在 ${pathPart}`);
		return;
	}
	if (!isInsideRoot(target)) {
		issues.push(`${page.file}: 链接指向仓库外 ${pathPart}`);
		return;
	}

	const lineMatch = anchor?.match(/^L(\d+)$/);
	if (lineMatch) {
		const line = Number(lineMatch[1]);
		const count = lineNumberOf(target);
		if (line < 1 || line > count) {
			issues.push(`${page.file}: 行号越界 ${pathPart}#L${line} (文件 ${count} 行)`);
		}
		if (title) {
			const { matches } = findTitleLine(target, title, line);
			if (matches.length === 0) {
				issues.push(`${page.file}: 标题锚点未找到 "${unescapeTitle(title)}" in ${pathPart}`);
			} else if (matches.length > 1) {
				warnings.push(
					`${page.file}: 标题锚点有 ${matches.length} 处匹配 "${unescapeTitle(title)}" in ${pathPart}，--fix 取最近一处`,
				);
			}
		}
		return;
	}

	if (pathPart.endsWith(".md")) {
		const targetPage = pageByFile(target);
		if (anchor && targetPage) {
			const targetText = fs.readFileSync(target, "utf8");
			const anchorOk =
				targetText.includes(`id="${anchor}"`) ||
				targetText
					.split(/\r?\n/)
					.filter((line) => /^#{1,4}\s+/.test(line))
					.some((line) => slugify(line.replace(/^#{1,4}\s+/, "")) === anchor);
			if (!anchorOk) {
				issues.push(`${page.file}: 文档锚点未找到 ${pathPart}#${anchor}`);
			}
		}
	}
}

function checkAll() {
	let issueCount = 0;
	let warningCount = 0;
	for (const page of PAGES) {
		const { issues, warnings } = walkLinksForCheck(page);
		for (const issue of issues) {
			console.error(`[${LOG_TAG}] ERROR ${issue}`);
			issueCount++;
		}
		for (const warning of warnings) {
			console.warn(`[${LOG_TAG}] WARN ${warning}`);
			warningCount++;
		}
	}
	if (issueCount > 0) {
		console.error(`[${LOG_TAG}] ${issueCount} error(s), ${warningCount} warning(s)`);
		return false;
	}
	console.log(`[${LOG_TAG}] links ok, ${warningCount} warning(s)`);
	return true;
}

function fixAll() {
	let changedFiles = 0;
	for (const page of PAGES) {
		const filePath = path.join(HERE, page.file);
		const text = fs.readFileSync(filePath, "utf8");
		let changed = 0;
		const eol = text.includes("\r\n") ? "\r\n" : "\n";
		const lines = text.split(/\r?\n/);
		let inFence = false;
		const nextLines = lines.map((line) => {
			if (/^\s*```/.test(line)) {
				inFence = !inFence;
				return line;
			}
			if (inFence) return line;
			const codeRanges = inlineCodeRanges(line);
			LINK_RE.lastIndex = 0;
			return line.replace(LINK_RE, (full, label, url, title, offset) => {
				if (isInsideRanges(codeRanges, offset)) return full;
				if (!title || !url || url.startsWith("http") || url.startsWith("#")) return full;
				const { pathPart, anchor } = splitRouteUrl(url);
				const lineMatch = anchor?.match(/^L(\d+)$/);
				if (!lineMatch) return full;
				const target = path.resolve(path.dirname(filePath), pathPart);
				if (!fs.existsSync(target) || !isInsideRoot(target)) return full;
				const oldLine = Number(lineMatch[1]);
				const { best } = findTitleLine(target, title, oldLine);
				if (!best || best === oldLine) return full;
				const newUrl = `${pathPart}#L${best}`;
				let newLabel = label;
				if (/:\d+$/.test(label)) newLabel = label.replace(/:\d+$/, `:${best}`);
				changed++;
				return `[${newLabel}](${newUrl} "${title}")`;
			});
		});
		const next = nextLines.join(eol);
		if (changed > 0) {
			fs.writeFileSync(filePath, next);
			console.log(`[${LOG_TAG}] fixed ${changed} line number(s) in ${page.file}`);
			changedFiles++;
		}
	}
	if (changedFiles === 0) console.log(`[${LOG_TAG}] no line numbers to fix`);
}

// ---------- Markdown rendering ----------

function escapeHtml(value) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function slugify(value) {
	return value
		.toLowerCase()
		.replace(/`/g, "")
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.trim()
		.replace(/\s+/g, "-");
}

function isBlockStart(line) {
	if (/^\s*$/.test(line)) return true;
	if (/^```/.test(line)) return true;
	if (/^#{1,4}\s+/.test(line)) return true;
	if (/^\|/.test(line)) return true;
	if (/^\s*([-*]|\d+\.)\s+/.test(line)) return true;
	if (/^>\s?/.test(line)) return true;
	if (/^(-{3,}|\*{3,})$/.test(line.trim())) return true;
	if (/^<a id="[^"]+"><\/a>\s*$/.test(line)) return true;
	return false;
}

function createRenderer(page) {
	const headings = [];
	const usedIds = new Map();

	function uniqueId(text) {
		// 每页都渲染进同一个文档；页面 ID 前缀保证全局唯一，
		// 否则跨页同名标题会让 getElementById 命中隐藏页里的元素。
		const base = `${page.id}--${slugify(text) || "section"}`;
		const count = usedIds.get(base) ?? 0;
		usedIds.set(base, count + 1);
		return count === 0 ? base : `${base}-${count + 1}`;
	}

	function resolveDocLink(url) {
		const { pathPart, anchor } = splitRouteUrl(url);
		if (!pathPart || pathPart.startsWith("http") || pathPart.startsWith("/")) return undefined;
		const target = path.resolve(path.dirname(path.join(HERE, page.file)), pathPart);
		const targetPage = pageByFile(target);
		if (!targetPage) return undefined;
		return { page: targetPage.id, anchor };
	}

	function renderLink(label, url, title) {
		const scheme = url.match(/^([a-z][a-z0-9+.-]*):/i);
		if (scheme && !/^(https?|mailto)$/i.test(scheme[1])) {
			return `<span>${label}</span>`;
		}
		const doc = resolveDocLink(url);
		if (doc) {
			const suffix = doc.anchor ? `@${encodeURIComponent(doc.anchor)}` : "";
			return `<a href="#/${doc.page}${suffix}">${label}</a>`;
		}

		const { pathPart, anchor } = splitRouteUrl(url);
		const lineMatch = anchor?.match(/^L(\d+)$/);
		const extension = path.extname(pathPart).toLowerCase();
		const absolute = pathPart && !pathPart.startsWith("http") && !pathPart.startsWith("/")
			? path.resolve(path.dirname(path.join(HERE, page.file)), pathPart)
			: undefined;
		let localFile = false;
		if (absolute) {
			try {
				localFile = isInsideRoot(absolute) && fs.statSync(absolute).isFile();
			} catch {
				localFile = false;
			}
		}
		const isCodeFile = CODE_EXTENSIONS.has(extension) || Boolean(lineMatch) || localFile;
		if (isCodeFile && absolute) {
			const line = lineMatch ? Number(lineMatch[1]) : 1;
			const file = path.relative(ROOT, absolute).split(path.sep).join("/");
			const hint = `点击在 ${IDE_LABELS[IDE]} 中打开，Alt+点击复制 path:line`;
			const titleAttr = ` title="${escapeHtml(title ? `${unescapeTitle(title)} · ${hint}` : hint)}"`;
			return `<a class="cr" href="${escapeHtml(ideUrl(absolute, line))}" data-file="${escapeHtml(file)}" data-line="${line}"${titleAttr}>${label}</a>`;
		}

		const titleAttr = title ? ` title="${escapeHtml(unescapeTitle(title))}"` : "";
		// 同页锚点也要走 SPA 路由。浏览器原生 #anchor 会触发 hashchange，
		// 被 routeFromHash 当成页面 ID，回退到首页并丢失当前页。
		if (url.startsWith("#") && url.length > 1) {
			return `<a href="#/${page.id}@${encodeURIComponent(url.slice(1))}"${titleAttr}>${label}</a>`;
		}
		return `<a href="${escapeHtml(url)}"${titleAttr}>${label}</a>`;
	}

	function renderInline(text) {
		const tokenRe = /`([^`]+)`|\[([^\]]*)\]\(([^)\s]+)(?:\s+"((?:[^"\\]|\\.)*)")?\)/g;
		let result = "";
		let last = 0;
		for (let match = tokenRe.exec(text); match !== null; match = tokenRe.exec(text)) {
			result += formatPlain(text.slice(last, match.index));
			if (match[1] !== undefined) {
				result += `<code>${escapeHtml(match[1])}</code>`;
			} else {
				const label = renderLabel(match[2] ?? "");
				result += renderLink(label, match[3], match[4]);
			}
			last = match.index + match[0].length;
		}
		result += formatPlain(text.slice(last));
		return result;
	}

	function renderLabel(label) {
		return label
			.split(/(`[^`]+`)/g)
			.map((part) => {
				const codeMatch = part.match(/^`([^`]+)`$/);
				if (codeMatch) return `<code>${escapeHtml(codeMatch[1])}</code>`;
				return formatPlain(part);
			})
			.join("");
	}

	function formatPlain(text) {
		return escapeHtml(text)
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/~~([^~]+)~~/g, "<del>$1</del>");
	}

	function renderCodeBlock(language, code) {
		const langClass = language ? ` class="language-${escapeHtml(language)}"` : "";
		return `<div class="code-block"><button class="copy-code" type="button">复制</button><pre><code${langClass}>${escapeHtml(code.join("\n"))}</code></pre></div>`;
	}

	function renderBlocks(lines, start) {
		let html = "";
		let i = start;
		let paragraph = [];

		function flushParagraph() {
			if (paragraph.length === 0) return;
			html += `<p>${renderInline(paragraph.join(" "))}</p>\n`;
			paragraph = [];
		}

		while (i < lines.length) {
			const line = lines[i];

			if (/^\s*$/.test(line)) {
				flushParagraph();
				i++;
				continue;
			}

			if (/^\s*```/.test(line)) {
				flushParagraph();
				const fenceIndent = line.match(/^\s*/)[0].length;
				const language = line.trim().slice(3).trim();
				const code = [];
				i++;
				while (i < lines.length && !/^\s*```/.test(lines[i])) {
					const body = lines[i];
					const leading = body.match(/^\s*/)[0].length;
					code.push(body.slice(Math.min(fenceIndent, leading)));
					i++;
				}
				i++;
				html += `${renderCodeBlock(language, code)}\n`;
				continue;
			}

			const anchorMatch = line.match(/^<a id="([^"]+)"><\/a>\s*$/);
			if (anchorMatch) {
				flushParagraph();
				html += `<a id="${escapeHtml(anchorMatch[1])}"></a>\n`;
				i++;
				continue;
			}

			const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
			if (headingMatch) {
				flushParagraph();
				const level = headingMatch[1].length;
				const rawText = headingMatch[2].trim();
				const id = uniqueId(rawText.replace(/[`*_]/g, ""));
				const content = renderInline(rawText);
				html += `<h${level} id="${id}"><a class="hlink" href="#/${page.id}@${encodeURIComponent(id)}" aria-label="本节链接">#</a>${content}</h${level}>\n`;
				if (level === 2 || level === 3) {
					headings.push({ level, id, title: rawText.replace(/[`*_]/g, "").trim() });
				}
				i++;
				continue;
			}

			if (line.trim() === "---" || line.trim() === "***") {
				flushParagraph();
				html += "<hr>\n";
				i++;
				continue;
			}

			if (line.startsWith("|") && i + 1 < lines.length && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
				flushParagraph();
				const headerCells = splitTableRow(line);
				i += 2;
				const rows = [];
				while (i < lines.length && lines[i].startsWith("|")) {
					rows.push(splitTableRow(lines[i]));
					i++;
				}
				html += '<div class="table-wrap"><table><thead><tr>';
				for (const cell of headerCells) html += `<th>${renderInline(cell)}</th>`;
				html += "</tr></thead><tbody>";
				for (const row of rows) {
					html += "<tr>";
					for (const cell of row) html += `<td>${renderInline(cell)}</td>`;
					html += "</tr>";
				}
				html += "</tbody></table></div>\n";
				continue;
			}

			if (/^>\s?/.test(line)) {
				flushParagraph();
				const quote = [];
				while (i < lines.length && /^>\s?/.test(lines[i])) {
					quote.push(lines[i].replace(/^>\s?/, ""));
					i++;
				}
				html += `<blockquote>${renderBlocks(quote, 0).html}</blockquote>\n`;
				continue;
			}

			const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
			if (listMatch) {
				flushParagraph();
				const indent = listMatch[1].length;
				const parsed = parseList(lines, i, indent);
				html += parsed.html;
				i = parsed.next;
				continue;
			}

			paragraph.push(line.trim());
			i++;
		}

		flushParagraph();
		return { html, next: i };
	}

	function parseList(lines, start, indent) {
		const first = lines[start].match(/^(\s*)([-*]|\d+\.)\s+/);
		const ordered = /\d+\./.test(first?.[2] ?? "");
		const tag = ordered ? "ol" : "ul";
		let html = `<${tag}>\n`;
		let i = start;

		while (i < lines.length) {
			const match = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
			if (!match) {
				if (/^\s*$/.test(lines[i])) {
					const nextNonBlank = lines.slice(i + 1).find((candidate) => !/^\s*$/.test(candidate));
					const nextMatch = nextNonBlank?.match(/^(\s*)([-*]|\d+\.)\s+/);
					if (nextMatch && nextMatch[1].length >= indent) {
						i++;
						continue;
					}
				}
				break;
			}
			const itemIndent = match[1].length;
			if (itemIndent < indent) break;
			if (itemIndent > indent) {
				const nested = parseList(lines, i, itemIndent);
				html = html.replace(/<\/li>\n?$/, "");
				html += `\n${nested.html}</li>\n`;
				i = nested.next;
				continue;
			}
			const itemText = match[3].trim();
			html += `<li>${renderInline(itemText)}`;
			i++;
			while (i < lines.length) {
				const continuation = lines[i];
				if (/^\s*$/.test(continuation)) break;
				if (/^\s*([-*]|\d+\.)\s+/.test(continuation)) break;
				if (!/^\s+/.test(continuation)) break;
				const trimmed = continuation.trim();
				if (trimmed.startsWith("```")) {
					const fenceIndent = continuation.match(/^\s*/)[0].length;
					const language = trimmed.slice(3).trim();
					const code = [];
					i++;
					while (i < lines.length && !lines[i].trim().startsWith("```")) {
						const body = lines[i];
						const leading = body.match(/^\s*/)[0].length;
						code.push(body.slice(Math.min(fenceIndent, leading)));
						i++;
					}
					i++;
					html += `\n${renderCodeBlock(language, code)}`;
					continue;
				}
				html += ` ${renderInline(trimmed)}`;
				i++;
			}
			html += "</li>\n";
		}

		html += `</${tag}>\n`;
		return { html, next: i };
	}

	return {
		headings,
		render(markdown) {
			const lines = markdown.split(/\r?\n/);
			return renderBlocks(lines, 0).html;
		},
	};
}

function splitTableRow(line) {
	const cells = [];
	let cell = "";
	let inCode = false;
	let inQuote = false;
	const text = line.trim();
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "\\" && text[i + 1] === "|") {
			cell += "|";
			i++;
			continue;
		}
		if (char === "`") {
			inCode = !inCode;
			cell += char;
			continue;
		}
		if (char === '"' && !inCode) {
			inQuote = !inQuote;
			cell += char;
			continue;
		}
		if (char === "|" && !inCode && !inQuote) {
			cells.push(cell.trim());
			cell = "";
			continue;
		}
		cell += char;
	}
	cells.push(cell.trim());
	if (cells[0] === "") cells.shift();
	if (cells[cells.length - 1] === "") cells.pop();
	return cells;
}

function searchText(markdown) {
	return markdown
		.replace(/^\s*<a id="[^"]+"><\/a>\s*$/gm, " ")
		.replace(/```[^\n]*/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, " ")
		.replace(/[|`#>*]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// Split a page by its indexed headings so every section is searchable, not only the page intro.
function buildSearchSections(markdown, headings) {
	const sections = [];
	const intro = [];
	let current = undefined;
	let headingIndex = 0;
	let inFence = false;

	for (const line of markdown.split(/\r?\n/)) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) {
			const match = line.match(/^(#{2,3})\s+(.*)$/);
			if (match) {
				const title = match[2].replace(/[`*_]/g, "").trim();
				const heading = headings[headingIndex];
				if (heading && heading.title === title) {
					current = { anchor: heading.id, title: heading.title, lines: [] };
					sections.push(current);
					headingIndex++;
					continue;
				}
			}
		}
		if (current) current.lines.push(line);
		else intro.push(line);
	}

	if (intro.length > 0 && sections.length > 0) sections[0].lines.unshift(intro.join("\n"));
	return sections.map((section) => ({
		anchor: section.anchor,
		title: section.title,
		text: searchText(section.lines.join("\n")).slice(0, 1000),
	}));
}

const SEARCH_INDEX = [];
const PAGE_HTML = [];

function buildPages() {
	SEARCH_INDEX.length = 0;
	PAGE_HTML.length = 0;
	for (const page of PAGES) {
		const markdown = readPage(page);
		const renderer = createRenderer(page);
		const body = renderer.render(markdown);
		PAGE_HTML.push({ page, body, headings: renderer.headings });

		for (const section of buildSearchSections(markdown, renderer.headings)) {
			SEARCH_INDEX.push({
				page: page.id,
				pageTitle: page.title,
				anchor: section.anchor,
				title: section.title,
				text: section.text,
			});
		}
	}
}

function renderPageSection(entry) {
	const { page, body } = entry;
	const index = PAGES.indexOf(page);
	const prev = PAGES[index - 1];
	const next = PAGES[index + 1];
	const prevLink = prev ? `<a href="#/${prev.id}">← ${escapeHtml(prev.title)}</a>` : "<span></span>";
	const nextLink = next ? `<a href="#/${next.id}">${escapeHtml(next.title)} →</a>` : "<span></span>";
	const mdPath = path.join(HERE, page.file);
	const mdRel = path.relative(ROOT, mdPath).split(path.sep).join("/");
	const mdHint = `点击在 ${IDE_LABELS[IDE]} 中打开，Alt+点击复制 path:line`;
	return `<section class="page" id="page-${page.id}" data-page="${page.id}" hidden>
<div class="page-inner">
<div class="page-tools"><a class="md-link md-open" href="${escapeHtml(ideUrl(mdPath, 1))}" data-file="${escapeHtml(mdRel)}" data-line="1" title="${escapeHtml(mdHint)}">本页 Markdown</a><button class="copy-link" type="button" data-page="${page.id}">复制本页链接</button></div>
${body}
<footer class="page-nav">${prevLink}${nextLink}</footer>
</div>
</section>`;
}

function renderSidebar() {
	let html = "";
	let group = "";
	for (const page of PAGES) {
		if (page.group !== group) {
			group = page.group;
			html += `<div class="side-group">${escapeHtml(group)}</div>`;
		}
		html += `<a class="nav" data-page="${page.id}" href="#/${page.id}"><span class="nav-badge">${escapeHtml(page.short)}</span><span>${escapeHtml(page.title)}</span></a>`;
	}
	return html;
}

function renderOutlines() {
	return PAGE_HTML.map(
		(entry) => `<div class="outline" data-page="${entry.page.id}" hidden>
<div class="side-group">本页目录</div>
${entry.headings
	.map(
		(heading) =>
			`<a class="outline-link level-${heading.level}" href="#/${entry.page.id}@${encodeURIComponent(heading.id)}">${escapeHtml(heading.title)}</a>`,
	)
	.join("\n")}
</div>`,
	).join("\n");
}

function renderHtml() {
	const pageSections = PAGE_HTML.map(renderPageSection).join("\n");
	const searchJson = JSON.stringify(SEARCH_INDEX).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi 学习地图</title>
<style>
:root {
  --bg: #fbfaf7;
  --panel: #ffffff;
  --panel-soft: #f5f2eb;
  --text: #20242b;
  --muted: #66707d;
  --border: #e4dfd5;
  --accent: #2f6feb;
  --accent-soft: #e9f0fe;
  --accent-text: #1d4ed8;
  --code-bg: #f4f1e9;
  --code-border: #e1dccf;
  --shadow: 0 10px 30px rgba(32, 36, 43, 0.12);
  --header-h: 58px;
  --sidebar-w: 286px;
}
:root[data-theme="dark"] {
  --bg: #11151b;
  --panel: #171c24;
  --panel-soft: #1c222c;
  --text: #e6e9ee;
  --muted: #98a2b1;
  --border: #2a313c;
  --accent: #78a7ff;
  --accent-soft: #1c2a45;
  --accent-text: #a9c6ff;
  --code-bg: #141a22;
  --code-border: #2a313c;
  --shadow: 0 12px 34px rgba(0, 0, 0, 0.4);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #11151b;
    --panel: #171c24;
    --panel-soft: #1c222c;
    --text: #e6e9ee;
    --muted: #98a2b1;
    --border: #2a313c;
    --accent: #78a7ff;
    --accent-soft: #1c2a45;
    --accent-text: #a9c6ff;
    --code-bg: #141a22;
    --code-border: #2a313c;
    --shadow: 0 12px 34px rgba(0, 0, 0, 0.4);
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 15px;
  line-height: 1.75;
}
a { color: var(--accent-text); text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.86em;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: 5px;
  padding: 0.08em 0.34em;
  word-break: break-word;
}
header {
  position: sticky;
  top: 0;
  z-index: 40;
  height: var(--header-h);
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 20px;
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: 0.02em; white-space: nowrap; }
.brand-mark { width: 28px; height: 28px; border-radius: 8px; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 13px; font-weight: 800; }
.search-wrap { position: relative; flex: 1; max-width: 560px; margin-left: 6px; }
#search {
  width: 100%;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-soft);
  color: var(--text);
  padding: 0 12px 0 34px;
  font: inherit;
  font-size: 14px;
  outline: none;
}
#search:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.search-icon { position: absolute; left: 11px; top: 8px; color: var(--muted); font-size: 14px; pointer-events: none; }
#search-results {
  position: absolute;
  top: 44px;
  left: 0;
  right: 0;
  max-height: 60vh;
  overflow: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  padding: 6px;
}
#search-results[hidden] { display: none; }
.search-result { display: block; padding: 8px 10px; border-radius: 8px; color: var(--text); }
.search-result:hover, .search-result.active { background: var(--accent-soft); text-decoration: none; }
.search-result .sr-title { font-weight: 600; font-size: 14px; }
.search-result .sr-meta { color: var(--muted); font-size: 12px; }
.search-empty { padding: 12px; color: var(--muted); }
.header-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.icon-btn {
  height: 34px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  border-radius: 8px;
  padding: 0 10px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.icon-btn:hover { background: var(--panel-soft); }
#menu-btn { display: none; }
.layout { display: flex; align-items: flex-start; }
#sidebar {
  position: sticky;
  top: var(--header-h);
  width: var(--sidebar-w);
  flex: 0 0 var(--sidebar-w);
  height: calc(100vh - var(--header-h));
  overflow: auto;
  padding: 18px 12px 40px 18px;
  border-right: 1px solid var(--border);
}
.side-group { margin: 16px 8px 6px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
.side-group:first-child { margin-top: 0; }
.nav { display: flex; align-items: center; gap: 10px; padding: 7px 9px; border-radius: 8px; color: var(--text); font-size: 14px; }
.nav:hover { background: var(--panel-soft); text-decoration: none; }
.nav.active { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }
.nav-badge { width: 25px; height: 22px; display: grid; place-items: center; border-radius: 6px; background: var(--panel-soft); border: 1px solid var(--border); font-size: 11px; font-weight: 700; color: var(--muted); flex: none; }
.nav.active .nav-badge { background: var(--accent); border-color: var(--accent); color: #fff; }
.outline { margin-top: 4px; }
.outline-link { display: block; padding: 4px 9px 4px 12px; color: var(--muted); font-size: 12.5px; line-height: 1.45; border-left: 2px solid transparent; }
.outline-link:hover { color: var(--text); text-decoration: none; }
.outline-link.level-3 { padding-left: 24px; }
main { flex: 1; min-width: 0; }
.page-inner { max-width: 980px; margin: 0 auto; padding: 32px 44px 80px; }
.page[hidden] { display: none; }
h1, h2, h3, h4 { line-height: 1.35; letter-spacing: -0.015em; scroll-margin-top: calc(var(--header-h) + 18px); }
h1 { font-size: 32px; margin: 0 0 18px; }
h2 { font-size: 23px; margin: 40px 0 12px; padding-top: 8px; border-top: 1px solid var(--border); }
h3 { font-size: 18px; margin: 28px 0 8px; }
h4 { font-size: 16px; margin: 22px 0 6px; }
p { margin: 10px 0; }
ul, ol { margin: 10px 0; padding-left: 24px; }
li { margin: 4px 0; }
li > ul, li > ol { margin: 4px 0; }
blockquote { margin: 14px 0; padding: 2px 16px; border-left: 3px solid var(--accent); color: var(--muted); background: var(--panel-soft); border-radius: 0 8px 8px 0; }
hr { border: 0; border-top: 1px solid var(--border); margin: 26px 0; }
.table-wrap { overflow-x: auto; margin: 16px 0; border: 1px solid var(--border); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { padding: 9px 12px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
th { background: var(--panel-soft); font-weight: 650; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
.code-block { position: relative; margin: 16px 0; }
.code-block pre { margin: 0; padding: 16px 18px; overflow: auto; background: var(--code-bg); border: 1px solid var(--code-border); border-radius: 10px; line-height: 1.55; }
.code-block code { border: 0; background: transparent; padding: 0; font-size: 12.8px; white-space: pre; }
.copy-code { position: absolute; right: 10px; top: 8px; opacity: 0; border: 1px solid var(--code-border); background: var(--panel); color: var(--muted); border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer; transition: opacity 0.15s; }
.code-block:hover .copy-code { opacity: 1; }
.cr { display: inline-flex; align-items: center; gap: 3px; padding: 0 5px; border: 1px solid var(--border); border-radius: 5px; background: var(--accent-soft); color: var(--accent-text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82em; line-height: 1.55; cursor: pointer; text-decoration: none; white-space: nowrap; }
.cr::before { content: "↗"; font-size: 0.9em; opacity: 0.7; }
.cr:hover { border-color: var(--accent); text-decoration: none; }
.hlink { float: left; margin-left: -1.1em; padding-right: 0.35em; color: var(--muted); opacity: 0; font-weight: 400; text-decoration: none; }
h2:hover .hlink, h3:hover .hlink, h4:hover .hlink { opacity: 0.55; }
.page-tools { display: flex; justify-content: flex-end; gap: 12px; margin-bottom: 6px; font-size: 12px; }
.page-tools a, .page-tools button { color: var(--muted); background: none; border: 0; padding: 0; font: inherit; cursor: pointer; }
.page-tools a:hover, .page-tools button:hover { color: var(--accent-text); text-decoration: underline; }
.page-nav { display: flex; justify-content: space-between; gap: 16px; margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 14px; }
#toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(10px); max-width: min(680px, calc(100vw - 32px)); background: var(--text); color: var(--bg); padding: 7px 14px; border-radius: 8px; font-size: 13px; line-height: 1.5; text-align: center; overflow-wrap: anywhere; opacity: 0; pointer-events: none; transition: 0.18s; z-index: 90; }
#toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
@media (max-width: 900px) {
  #menu-btn { display: inline-block; }
  #sidebar { position: fixed; left: 0; top: var(--header-h); z-index: 30; background: var(--panel); transform: translateX(-100%); transition: transform 0.18s; box-shadow: var(--shadow); }
  body.sidebar-open #sidebar { transform: translateX(0); }
  .page-inner { padding: 24px 18px 64px; }
  h1 { font-size: 26px; }
  h2 { font-size: 20px; }
  .brand span:last-child { display: none; }
}
@media print {
  header, #sidebar, .page-tools, .page-nav, #toast { display: none !important; }
  .page-inner { max-width: none; padding: 0; }
  .cr { border: 0; background: none; }
}
</style>
</head>
<body>
<header>
  <button id="menu-btn" class="icon-btn" type="button" aria-label="打开目录">目录</button>
  <a class="brand" href="#/home"><span class="brand-mark">π</span><span>pi 学习地图</span></a>
  <div class="search-wrap"><span class="search-icon">⌕</span><input id="search" type="search" placeholder="搜索模块、函数或概念（/）" autocomplete="off"><div id="search-results" hidden></div></div>
  <div class="header-actions"><button id="theme-btn" class="icon-btn" type="button">主题</button></div>
</header>
<div class="layout">
  <aside id="sidebar">${renderSidebar()}
${renderOutlines()}
  </aside>
  <main id="main">${pageSections}</main>
</div>
<div id="toast" role="status"></div>
<script id="search-data" type="application/json">${searchJson}</script>
<script>
const SEARCH = JSON.parse(document.getElementById("search-data").textContent);
const PAGES = ${JSON.stringify(PAGES.map((page) => ({ id: page.id, title: page.title, file: page.file })))};
const docCache = new Map();

function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 1600);
}

async function copyText(text, message = "已复制") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  toast(message);
}

function decodeHash(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function routeFromHash() {
  let raw = location.hash.replace(/^#\\/?/, "");
  if (!raw) return { page: "home", anchor: "" };
  const at = raw.indexOf("@");
  if (at < 0) return { page: raw, anchor: "" };
  return { page: raw.slice(0, at), anchor: decodeHash(raw.slice(at + 1)) };
}

function showPage(pageId, anchor, updateHash) {
  let id = pageId || "home";
  if (!document.getElementById("page-" + id)) id = "home";
  document.querySelectorAll(".page").forEach((section) => {
    section.hidden = section.dataset.page !== id;
  });
  document.querySelectorAll(".nav").forEach((nav) => {
    nav.classList.toggle("active", nav.dataset.page === id);
  });
  document.querySelectorAll(".outline").forEach((outline) => {
    outline.hidden = outline.dataset.page !== id;
  });
  document.body.classList.remove("sidebar-open");
  const page = PAGES.find((candidate) => candidate.id === id) || PAGES[0];
  document.title = id === "home" ? "pi 学习地图" : page.title + " · pi 学习地图";
  if (updateHash) {
    const suffix = anchor ? "@" + encodeURIComponent(anchor) : "";
    const target = "#/" + id + suffix;
    if (location.hash !== target) history.pushState(null, "", target);
  }
  if (anchor) {
    requestAnimationFrame(() => {
      // 显式锚点用原 id；Markdown 标题链接用渲染时的页前缀 id。
      const el = document.getElementById(anchor) || document.getElementById(id + "--" + anchor);
      if (el) el.scrollIntoView({ block: "start" });
      else window.scrollTo({ top: 0 });
    });
  } else {
    window.scrollTo({ top: 0 });
  }
}

document.querySelectorAll("a[href^='#/']").forEach((link) => {
  link.addEventListener("click", (event) => {
    const href = link.getAttribute("href");
    if (!href) return;
    event.preventDefault();
    const raw = href.slice(2);
    const at = raw.indexOf("@");
    const page = at < 0 ? raw : raw.slice(0, at);
    const anchor = at < 0 ? "" : decodeHash(raw.slice(at + 1));
    showPage(page, anchor, true);
  });
});

function syncFromLocation() {
  const route = routeFromHash();
  showPage(route.page, route.anchor, false);
}
window.addEventListener("popstate", syncFromLocation);
window.addEventListener("hashchange", syncFromLocation);

const searchInput = document.getElementById("search");
const searchResults = document.getElementById("search-results");
let activeResult = -1;

function closeSearch() {
  searchResults.hidden = true;
  searchResults.innerHTML = "";
  activeResult = -1;
}

function escapeSearchText(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function searchSnippet(entry, q) {
  const text = entry.text;
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) return text.slice(0, 110) + (text.length > 110 ? "…" : "");
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + q.length + 80);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

function renderSearch(query) {
  const q = query.trim().toLowerCase();
  if (!q) return closeSearch();
  const seen = new Set();
  const scored = [];
  for (const entry of SEARCH) {
    const haystack = (entry.title + " " + entry.text + " " + entry.pageTitle).toLowerCase();
    if (!haystack.includes(q)) continue;
    const key = entry.page + "@" + entry.anchor;
    if (seen.has(key)) continue;
    seen.add(key);
    const titleHit = entry.title.toLowerCase().includes(q) || entry.pageTitle.toLowerCase().includes(q);
    scored.push({ entry: entry, score: titleHit ? 0 : 1, order: scored.length });
  }
  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  const results = scored.slice(0, 14).map((item) => item.entry);
  searchResults.hidden = false;
  if (results.length === 0) {
    searchResults.innerHTML = '<div class="search-empty">没有匹配结果</div>';
    return;
  }
  searchResults.innerHTML = results
    .map(
      (entry) =>
        '<a class="search-result" href="#/' + entry.page + "@" + encodeURIComponent(entry.anchor) + '"><div class="sr-title">' + escapeSearchText(entry.pageTitle) + " · " + escapeSearchText(entry.title) + '</div><div class="sr-meta">' + escapeSearchText(searchSnippet(entry, q)) + "</div></a>",
    )
    .join("");
  activeResult = -1;
}

searchResults.addEventListener("click", (event) => {
  if (event.target.closest(".search-result")) closeSearch();
});

searchInput.addEventListener("input", () => renderSearch(searchInput.value));
searchInput.addEventListener("focus", () => {
  if (searchInput.value.trim()) renderSearch(searchInput.value);
});
searchInput.addEventListener("keydown", (event) => {
  const items = [...searchResults.querySelectorAll(".search-result")];
  if (event.key === "ArrowDown" && items.length) {
    event.preventDefault();
    activeResult = (activeResult + 1) % items.length;
    items.forEach((item, index) => item.classList.toggle("active", index === activeResult));
    items[activeResult].scrollIntoView({ block: "nearest" });
  } else if (event.key === "ArrowUp" && items.length) {
    event.preventDefault();
    activeResult = activeResult <= 0 ? items.length - 1 : activeResult - 1;
    items.forEach((item, index) => item.classList.toggle("active", index === activeResult));
    items[activeResult].scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && items.length) {
    event.preventDefault();
    items[Math.max(activeResult, 0)].click();
    closeSearch();
    searchInput.blur();
  } else if (event.key === "Escape") {
    closeSearch();
    searchInput.blur();
  }
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".search-wrap")) closeSearch();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== searchInput && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    searchInput.focus();
  }
});

document.getElementById("menu-btn").addEventListener("click", () => {
  document.body.classList.toggle("sidebar-open");
});

const themeBtn = document.getElementById("theme-btn");
try {
  const saved = localStorage.getItem("pi-docs-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch {}
themeBtn.addEventListener("click", () => {
  const current = document.documentElement.dataset.theme;
  const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const next = current ? (current === "dark" ? "light" : "dark") : systemDark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("pi-docs-theme", next); } catch {}
});

document.querySelectorAll(".copy-code").forEach((button) => {
  button.addEventListener("click", () => {
    const code = button.parentElement.querySelector("code");
    copyText(code ? code.textContent : "");
  });
});

document.querySelectorAll(".copy-link").forEach((button) => {
  button.addEventListener("click", () => {
    const page = button.dataset.page;
    copyText(location.href.split("#")[0] + "#/" + page);
  });
});

// Route chips carry an IDE URL in href, but JCEF (the IDE's built-in preview) cannot
// hand custom schemes to the OS: it shows ERR_UNKNOWN_URL_SCHEME and replaces the page.
// A plain click therefore goes through the local opener server instead. Without it the
// path is copied, which keeps the docs usable inside the preview.
const OPENER = ${JSON.stringify(OPENER_URL)};
const IDE_LABEL = ${JSON.stringify(IDE_LABELS[IDE])};

async function openInIde(file, line) {
  const response = await fetch(OPENER + "/open?file=" + encodeURIComponent(file) + "&line=" + encodeURIComponent(line), {
    cache: "no-store",
    signal: AbortSignal.timeout(1500),
  });
  // 服务拒绝（403/400）时不能提示成功，交给调用方走复制路径。
  if (!response.ok) throw new Error("opener rejected the request");
}

document.addEventListener("click", (event) => {
  const route = event.target.closest(".cr, .md-open");
  if (!route) return;
  const file = route.dataset.file;
  const line = route.dataset.line || "1";
  if (event.altKey) {
    event.preventDefault();
    copyText(file + ":" + line);
    return;
  }
  if (event.shiftKey) {
    event.preventDefault();
    copyText(file);
    return;
  }
  if (event.button !== 0) return;
  event.preventDefault();
  openInIde(file, line).then(
    () => toast("已在 " + IDE_LABEL + " 中打开 " + file + ":" + line),
    () => copyText(file + ":" + line, "本地打开服务未启动，已复制 " + file + ":" + line),
  );
});

const initial = routeFromHash();
showPage(initial.page, initial.anchor, false);
</script>
</body>
</html>
`;
}

function writeHtml() {
	const html = renderHtml();
	fs.writeFileSync(path.join(HERE, "index.html"), html);
	const bytes = Buffer.byteLength(html);
	console.log(`[${LOG_TAG}] wrote index.html (${(bytes / 1024).toFixed(1)} KiB)`);
}

function resolveRepoFile(file) {
	if (!file || file.includes("\0")) return undefined;
	const absolute = path.resolve(ROOT, file);
	if (!isInsideRoot(absolute)) return undefined;
	try {
		const real = fs.realpathSync(absolute);
		const realRoot = fs.realpathSync(ROOT);
		const rel = path.relative(realRoot, real);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
		if (!fs.statSync(real).isFile()) return undefined;
		return real;
	} catch {
		return undefined;
	}
}

function openInSystem(target) {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	// cmd 把 & 当作命令分隔符；IDE URL 里有 &line=，必须带引号。
	const argv = process.platform === "win32" ? ["/c", "start", "", `"${target}"`] : [target];
	execFile(command, argv, (error) => {
		if (error) console.error(`[${LOG_TAG}] failed to open ${IDE_LABELS[IDE]}: ${error.message}`);
	});
}

// A cross-site page can send a GET to 127.0.0.1 (fetch, <img>, <iframe>).
// Only the docs page (file:// sends Origin: null) or the server's own page may
// trigger an IDE launch; local processes without browser headers still work.
function isAllowedOpenerRequest(request) {
	const origin = request.headers.origin;
	if (origin === undefined) return request.headers["sec-fetch-site"] !== "cross-site";
	if (origin === "null") return true;
	try {
		const url = new URL(origin);
		return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port === String(PORT);
	} catch {
		return false;
	}
}

// The page cannot navigate to an IDE scheme from inside JCEF, so it asks this server
// over HTTP; the server runs the OS-level `open` command instead.
function startOpenerServer() {
	const indexFile = path.join(HERE, "index.html");
	const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

	const server = http.createServer((request, response) => {
		let url;
		try {
			url = new URL(request.url ?? "/", OPENER_URL);
		} catch {
			response.writeHead(400, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
			response.end("bad request");
			return;
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405, cors);
			response.end();
			return;
		}

		if (url.pathname === "/ping") {
			response.writeHead(200, { ...cors, "Content-Type": "application/json; charset=utf-8" });
			response.end(JSON.stringify({ ok: true, ide: IDE }));
			return;
		}

		if (url.pathname === "/open") {
			if (request.method !== "GET") {
				response.writeHead(405, cors);
				response.end();
				return;
			}
			if (!isAllowedOpenerRequest(request)) {
				response.writeHead(403, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
				response.end("forbidden");
				return;
			}
			const file = url.searchParams.get("file") ?? "";
			const requestedLine = Number(url.searchParams.get("line") ?? "1");
			const absolute = resolveRepoFile(file);
			if (!absolute) {
				response.writeHead(400, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
				response.end("unknown file");
				return;
			}
			const line = Number.isInteger(requestedLine) && requestedLine > 0 ? Math.min(requestedLine, Math.max(1, lineNumberOf(absolute))) : 1;
			openInSystem(ideUrl(absolute, line));
			console.log(`[${LOG_TAG}] ${IDE_LABELS[IDE]} <- ${file}:${line}`);
			response.writeHead(204, cors);
			response.end();
			return;
		}

		if (url.pathname === "/" || url.pathname === "/index.html") {
			let html;
			try {
				html = fs.readFileSync(indexFile);
			} catch {
				// 生成物被删除时不能让 readFileSync 的异常打死整个服务。
				response.writeHead(503, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
				response.end("index.html is missing; run node docs/learning/pi/modules-chain/build.mjs");
				return;
			}
			// 页面本身同源加载，不需要 CORS；去掉通配后其他网站无法读取文档内容。
			response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
			response.end(html);
			return;
		}

		response.writeHead(404, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
		response.end("not found");
	});

	server.on("error", (error) => {
		if (error.code === "EADDRINUSE") {
			console.error(`[${LOG_TAG}] port ${PORT} is already in use; pass --port=<port> or stop the other process`);
		} else {
			console.error(`[${LOG_TAG}] server error: ${error.message}`);
		}
		process.exitCode = 1;
	});

	server.listen(PORT, "127.0.0.1", () => {
		console.log(`[${LOG_TAG}] opener listening on ${OPENER_URL} (${IDE_LABELS[IDE]})`);
		console.log(`[${LOG_TAG}] open ${OPENER_URL}/ or keep the IDE preview; Ctrl+C to stop`);
	});
}

if (mode === "check") {
	process.exit(checkAll() ? 0 : 1);
}

if (mode === "fix") {
	fixAll();
}

if (!checkAll()) {
	process.exit(1);
}

buildPages();
writeHtml();

if (SERVE) startOpenerServer();
