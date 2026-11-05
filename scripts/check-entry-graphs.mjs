#!/usr/bin/env node
// 文件导读
// 所属：仓库根 scripts/ 的公开入口体积契约检查，npm run check:entry-graphs 的实现，也被 npm run check 串联。
// 职责：读取各包 package.json 的 exports，把每个入口的值导入图（静态 import/export ... from）展开，
//   按 BUDGETS 限定最大文件数与禁止到达的目录，防止一个桶文件把所有实现拖进窄入口。
// 上游：根 package.json → node scripts/check-entry-graphs.mjs；失败会让提交/CI 的 check 失败。
// 下游：只读工作区源码与 package.json，不执行、不编译、不联网。
// 输入：无参数。输出：全部在预算内时 stdout 打印一行；违规时逐条打印到 stderr 并以 1 退出。
// 副作用：无文件写入。限制：用正则扫描源码文本，不是完整 TypeScript 解析器，可能漏掉 dynamic import()、
//   require() 或字符串/注释里的伪 import；type-only 导入按设计不计入运行时图。
// 能力清单：
//   WORKSPACE：包名 → src 根，支持跨包跟随。
//   BUDGETS：包目录 → 入口 → maxFiles/forbid/allow/overrides。
//   resolveSpec：把相对/工作区说明符解析到磁盘文件。
//   walk：从入口做深度优先遍历并去重。
//   sourceFor/expand：把 exports 的 dist 目标映射回 src 的 .ts，并展开通配符。
// 示例：
//   node scripts/check-entry-graphs.mjs
//   # 若 packages/schema 根入口多带上 formats/ 下文件，会打印违规入口与文件列表并退出 1。
// 建议阅读顺序：先读 WORKSPACE 与 BUDGETS 理解契约，再看 resolveSpec/walk，最后看主循环如何计数失败。
/**
 * Entry points are cost contracts.
 *
 * A package's `exports` map is the only place that says which modules are public, and one stray
 * `export *` can silently make a narrow entry drag an entire barrel: importing a 1-file pure
 * function through a barrel costs ~37 MB of evaluated module graph, and nothing fails until someone
 * measures a process. This walks the value-import graph of every declared entry point and enforces a
 * budget per entry, so that regression fails at commit time instead.
 *
 * Only value imports count. `import type` / `export type` are erased before Node sees them.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// 无论从哪个 cwd 调用，都以脚本所在目录的上一级作为仓库根。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace package name -> its source root, so cross-package imports are followed. */
// 只列出需要跨包跟随的公开包；未列出的说明符按“外部依赖”处理，不进入图。

const WORKSPACE = {
	"@earendil-works/chord": "packages/chord/src",
	"@earendil-works/pi-ai": "packages/ai/src",
	"@earendil-works/pi-durable": "packages/durable/src",
	"@earendil-works/pi-agent-core": "packages/agent/src",
	"@earendil-works/pi-codemode": "packages/codemode/src",
	"@earendil-works/pi-telemetry": "packages/telemetry/src",
	"@earendil-works/pi-mcp": "packages/mcp/src",
	"@earendil-works/pi-schema": "packages/schema/src",
	"@earendil-works/pi-tui": "packages/tui/src",
};

/**
 * Budgets are deliberate. Entries with no budget remain unbounded; each listed entry states the
 * graph it is allowed to reach.
 */
// maxFiles 是值导入图（去重后）的文件数上限；forbid 是按路径子串匹配的禁入片段；
// allow 可对 forbid 做 endsWith 例外；overrides 按通配符展开后的具体入口名覆盖整份预算。
const BUDGETS = {
	"packages/schema": {
		// The format checks (vendored from TypeBox, about 40 KB) load only through ./formats.
		".": { maxFiles: 10, forbid: ["schema/src/formats/"] },
	},
	"packages/ai": {
		"./models": {
			// Request telemetry reaches pi-ai's telemetry.ts and pi-telemetry's root (index, noop, metrics, memory).
			// Request identity reaches utils/identity.ts and its version constant.
			maxFiles: 20,
			forbid: ["providers/", "models.generated.ts", "index.ts", "utils/validation.ts", "utils/string-enum.ts"],
			allow: ["packages/telemetry/src/index.ts"],
		},
		"./utils/*": {
			maxFiles: 3,
			forbid: ["providers/", "api/", "index.ts"],
			overrides: {
				// Tool argument validation runs on pi-schema: its validator, coercion and format checks (the checks TypeBox's
				// validator ran by default). TypeBox, an external package, was not counted before.
				"./utils/validation": { maxFiles: 42, forbid: ["providers/", "api/", "packages/ai/src/index.ts"] },
			},
		},
	},
	"packages/codemode": {
		// Node and Bun users never load the Cloudflare entry, which imports the `cloudflare:workers` built-in.
		".": { maxFiles: 12, forbid: ["codemode/src/cloudflare.ts"] },
		// Runtimes without Node built-ins (Workers, browsers) import these; neither may reach the worker-thread host
		// or the file-based wasm loader.
		"./portable": {
			maxFiles: 8,
			forbid: ["codemode/src/index.ts", "runtime/host.ts", "runtime/worker.ts", "codemode/src/wasm.ts"],
		},
		"./cloudflare": {
			maxFiles: 9,
			forbid: ["codemode/src/index.ts", "runtime/host.ts", "runtime/worker.ts", "codemode/src/wasm.ts"],
		},
	},
	"packages/durable": {
		".": {
			// Tool argument validation reaches pi-schema (validator, coercion and format checks; 39 files that replace
			// TypeBox, which this walk did not count); provider-session creation reaches pi-ai's lean UUID utility; the
			// memory and SQLite storages share scan order and cursor handling. Values from Chord's root (copyJson,
			// replicatedState) reach its host runtime through the root barrel. Chord's context reaches pi-telemetry's root
			// (index, noop, metrics, memory) for its NOOP telemetry default; harness/telemetry.ts is Durable's schema.
			// The Harness's request identity reaches pi-ai's utils/identity.ts and its version constant. Partial commits
			// parse streamed tool-call arguments with pi-ai's utils/streaming-json.ts (and its json-parse.ts) to append what
			// argument strings grew by (harness/partial-changes.ts). Chord's watches fold pending ops with Delta's
			// pending queue (delta/pending.ts). `registryReader` (harness/registry-reader.ts) reads a Chord v2 registry
			// value through type-only imports. The Session caches hot Storage reads (session/cached-storage.ts) and keeps
			// each conversation's newest entry and head marker (session/conversation-tails.ts). Group commit sends batches
			// through `commit()`, or one `commit()` each (storage/commit-batch.ts), from a writer off the Session line
			// (session/writer.ts) that gates reads by the keys of unpublished writes (session/keys.ts).
			maxFiles: 123,
			forbid: [
				"packages/ai/src/index.ts",
				"packages/ai/src/utils/string-enum.ts",
				// Photon (WebAssembly) loads only through `./images`.
				"packages/durable/src/images/",
			],
		},
		// The file tools reach their environment helpers and the Harness definitions they need, not the Harness itself,
		// and pi-schema's root for their schema builders (10 files; its format checks stay out).
		"./tools": { maxFiles: 27, forbid: ["packages/durable/src/images/", "packages/schema/src/formats/"] },
	},
};

// 静态 import/export 的启发式匹配：必须出现在行首（允许缩进），排除 import type/export type，
// 捕获组 2 是模块说明符。g 标志让 matchAll 能遍历全文。
const SPEC = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)([^;]*?\sfrom\s*)?["']([^"']+)["']/g;

// 输入：模块说明符与发起导入的文件路径。输出：磁盘上的 .ts/.js 绝对路径，或 null（内置/外部依赖）。
// 解析顺序模仿 Node：无扩展名文件、.ts、目录 index.ts；跨包只覆盖 WORKSPACE 中的包。
function resolveSpec(spec, fromFile) {
	// node: 内置模块不在工作区图中。
	if (spec.startsWith("node:")) return null;
	if (spec.startsWith(".")) {
		const base = resolve(dirname(fromFile), spec);
		for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
			// statSync 再确认不是目录，避免把同名目录当模块文件。
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		}
		return null;
	}
	for (const [name, src] of Object.entries(WORKSPACE)) {
		// 根入口固定指向 src/index.ts。
		if (spec === name) return resolve(ROOT, src, "index.ts");
		// 只有 name/... 子路径继续；检查作用域包时防止 @scope/a 误匹配 @scope/ab。
		if (!spec.startsWith(`${name}/`)) continue;
		const tail = spec.slice(name.length + 1);
		for (const candidate of [`${tail}.ts`, `${tail}/index.ts`, tail]) {
			const file = resolve(ROOT, src, candidate);
			if (existsSync(file) && statSync(file).isFile()) return file;
		}
	}
	return null; // external dependency: not part of the workspace graph
}

// 输入：入口 .ts 文件。输出：可达的源文件 Set（含入口自身）。队列用 pop 即深度优先，顺序不影响集合。
function walk(entryFile) {
	const seen = new Set();
	const queue = [entryFile];
	while (queue.length > 0) {
		// pop 取数组末端；每个文件只读一次，不会因循环依赖无限递归。
		const file = queue.pop();
		// JSON 模块只是数据，不继续展开；seen 防止重复处理。
		if (seen.has(file) || file.endsWith(".json")) continue;
		seen.add(file);
		// matchAll 返回所有匹配；match[2] 是捕获到的说明符。
		for (const match of readFileSync(file, "utf8").matchAll(SPEC)) {
			const target = resolveSpec(match[2], file);
			if (target) queue.push(target);
		}
	}
	return seen;
}

/** `./dist/harness/context.js` in the exports map is `src/harness/context.ts` on disk. */
// 输入：包目录与 exports 里的 dist 目标。输出：对应 src/.ts 路径；文件不存在返回 undefined。
function sourceFor(pkgDir, distPath) {
	// 去掉开头的 ./dist/ 与结尾 .js，再拼到 src 下；这只适用于编译一一对应的 TypeScript 包。
	const rel = distPath.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts");
	const file = resolve(ROOT, pkgDir, "src", rel);
	return existsSync(file) ? file : undefined;
}

// 输入：包目录、exports 键（可能含 *）、dist 目标（可能含 *）。输出：[具体入口名, 具体 dist 目标] 数组。
// 通配符按 src 目录下实际 .ts 文件展开；目录不存在时返回空数组，不算违规。
function expand(pkgDir, entry, target) {
	if (!entry.includes("*")) return [[entry, target]];
	const dir = resolve(ROOT, pkgDir, "src", dirname(target.replace(/^\.\/dist\//, "")));
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => [entry.replace("*", name.replace(/\.ts$/, "")), target.replace("*", name.replace(/\.ts$/, ""))]);
}

// 主循环：每个包、每个预算入口解析 exports → 映射源码 → 遍历图 → 比较上限与禁入片段。
let failures = 0;
for (const [pkgDir, budgets] of Object.entries(BUDGETS)) {
	// package.json 是输入边界；JSON.parse 失败会直接抛错终止检查，而不是跳过该包。
	const manifest = JSON.parse(readFileSync(resolve(ROOT, pkgDir, "package.json"), "utf8"));
	for (const [entry, budget] of Object.entries(budgets)) {
		const declared = manifest.exports?.[entry];
		// 预算引用了不存在的导出（例如入口改名）也要报错，避免预算悄悄失效。
		if (!declared) {
			console.error(`${pkgDir} declares no export "${entry}" but a budget exists for it`);
			failures += 1;
			continue;
		}
		// exports 可以是字符串，也可以是带 import/types 条件的对象；这里只跟运行时 import 目标。
		const target = typeof declared === "string" ? declared : declared.import;
		for (const [name, distPath] of expand(pkgDir, entry, target)) {
			// A wildcard entry's budget applies to every file it exports, unless `overrides` names that file.
			// 通配入口的每个具体文件共用预算；overrides 用展开后的入口名单独覆盖。
			const limits = budget.overrides?.[name] ?? budget;
			const source = sourceFor(pkgDir, distPath);
			// 导出了没有源码的目标通常意味着构建配置错误；不把它当成图大小为 0 通过。
			if (!source) {
				console.error(`${pkgDir} export "${name}" points at ${distPath}, which has no source file`);
				failures += 1;
				continue;
			}
			// 统一成相对仓库根的正斜杠路径，预算里的 forbid 片段才能跨平台匹配。
			const graph = [...walk(source)].map((file) => relative(ROOT, file).split(sep).join("/"));
			// 先检查文件数上限；错误信息附上完整图，便于判断是哪条导入把文件拖进来。
			if (graph.length > limits.maxFiles) {
				console.error(
					`${pkgDir} export "${name}" reaches ${graph.length} files, budget ${limits.maxFiles}\n` +
						graph.map((file) => `    ${file}`).join("\n"),
				);
				failures += 1;
			}
			// allow 是 forbid 的精确例外：只有文件路径以 allow 条目结尾时才豁免，避免用宽泛子串绕过。
			for (const pattern of limits.forbid ?? []) {
				const hit = graph.filter((file) => file.includes(pattern) && !(limits.allow ?? []).some((allowed) => file.endsWith(allowed)));
				if (hit.length > 0) {
					console.error(`${pkgDir} export "${name}" must not reach ${pattern}:\n${hit.map((f) => `    ${f}`).join("\n")}`);
					failures += 1;
				}
			}
		}
	}
}

// 收集完所有违规再统一退出，调用者一次能看到全部问题，而不是每改一个重启一次。
if (failures > 0) {
	console.error(`\n${failures} entry-point budget violation(s).`);
	process.exit(1);
}
console.log("Entry point graphs are within budget.");
