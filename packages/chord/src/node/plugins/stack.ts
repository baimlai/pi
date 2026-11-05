// Stack traces of plugin scripts (slice 7c §3, decision Q1 (b)): `vm.Script` maps no positions through a source map, so
// every evaluated script registers its map under its filename while something of its evaluation lives (its facet, or
// the error it threw while evaluated), and `mapStack` rewrites an error's stack through them, for the app's reporters.
// Nothing global: no `Error.prepareStackTrace`, no process-wide source-map switch. The registry is a module-level `Map`
// keyed by filename, not a `WeakMap` keyed by an owner: `mapStack` starts from a stack's text, which names only the
// filename. Its entries go with the last evaluation of their script (a `FinalizationRegistry` counts them down).

// 本文件维护插件脚本的源映射注册表并提供 mapStack。上游有两处：build.ts 把内联 source map 追加到脚本末尾，
// evaluate.ts 在脚本执行前用 registerScript 登记；下游是应用的错误上报代码，它把捕获到的任意值交给 mapStack，
// 得到能指向插件源文件（如 notes/worker.ts:12:3）的堆栈文本。
// 注册表是模块级 Map 而不是 WeakMap，因为 mapStack 只能从堆栈文本里读到文件名，拿不到可作键的所有者对象。
// 文件导读
// 所属模块：packages/chord/src/node/plugins 的堆栈映射部分，服务于 Node 端的插件求值与错误报告。
// 职责边界：保存“已求值脚本的 source map”，并把堆栈里的脚本行列改写回插件源文件；不执行插件、不捕获错误、
// 不改变错误的 message/name，只产出用于日志的字符串。
// 上游入口：evaluate.ts 在脚本执行前后调用 registerScript；应用或宿主在记录插件异常时调用 mapStack。
// 下游依赖：node:module 的 SourceMap（解析映射）、node:path 的 basename/join；注册表本身是模块级状态。
// 结果与错误流向：registerScript 无结果，映射在 owner 存活期间有效；mapStack 返回字符串，非 Error 或无可映射位置时
// 原样退化；inlineSourceMap 对格式错误的映射可能抛错，但 registerScript 只对 esbuild 产物调用它。
// 能力清单：
// - registerScript(filename, source, dir, owner)：登记一次求值的 source map，并按 owner 的存活计数。
// - inlineSourceMap(source)：从脚本末尾解析内联 source map，返回 SourceMap 或 undefined。
// - mapStack(error)：把任意捕获值的堆栈位置改写成“插件目录名/源文件:行:列”。
// - FinalizationRegistry（模块内部常量 collected）：在 owner 被回收时减计数，最后一条求值消失后删除映射。
// 组合与顺序：build 产出内联映射 -> evaluateFacet 先 registerScript 再运行脚本（抛错时也登记）-> 错误最终交给
// mapStack 格式化。多个宿主求值同一脚本会共享一条记录，live 计数保证映射不会提前删除。
// 示例：try { facet = evaluateFacet(built, options); } catch (error) { logger.error(mapStack(error)); }
// mapStack 的真实签名是 (error: unknown) => string，因此可以直接接收 catch 中的未知值。
// 建议阅读顺序：先看 Registered 与 scripts 两个状态，再看 registerScript 的生命周期，然后 inlineSourceMap，
// 最后 mapStack 与 POSITION 正则。
import { SourceMap } from "node:module";
import { basename, join } from "node:path";

// 一条已登记脚本：map 负责行列映射，dir 是插件目录（用于把 originalSource 变成相对路径），
// live 记录当前还有多少个求值实例（facet 或求值时的异常）存活。这些字段只用于运行时记账，没有类型之外的校验。
/** A registered script: how its positions map, its plugin's directory, and how many of its evaluations live. */
type Registered = { readonly map: SourceMap; readonly dir: string; live: number };

// 文件名 -> 已登记脚本。脚本文件名由求值器按“插件、种类、摘要”生成，因此同一脚本的多次求值共享一项。
/** The evaluated scripts by filename, while an evaluation of each lives. */
const scripts = new Map<string, Registered>();

// FinalizationRegistry 的回调不保证何时执行；它只做减计数，最后一个所有者被回收后删除整条记录，
// 这样注册表不会因为脚本被反复重载而无限增长，也不会提前删掉仍在使用中的映射。
/** Counts down an evaluation that was collected; its script's entry goes with the last one. */
const collected = new FinalizationRegistry<string>((filename) => {
	const script = scripts.get(filename);
	if (script !== undefined && --script.live === 0) scripts.delete(filename);
});

/**
 * Registers the script `source` evaluated under `filename` for plugin directory `dir` while `owner` (its facet, or the
 * error its evaluation threw) lives: its inline source map, whose sources are relative to the plugin's directory. Two
 * evaluations of one script (two hosts) share the entry.
 */
// 登记一次脚本求值。
// 输入：filename 是 vm 执行时使用的文件名；source 是已构建脚本（末尾带内联 source map）；dir 是插件真实目录；
// owner 是这次求值的存活凭证（facet 或它抛出的错误）。
// 输出：无返回值；副作用是写入或复用 scripts 中的记录，并把 owner 登记到 FinalizationRegistry。
// 错误：source 没有内联映射时安静地不登记；映射格式非法时 JSON.parse/new SourceMap 可能抛错。
// 主要流程：第一次见到该文件名时解析映射并建记录，然后给 live 加一并为 owner 登记回收回调。
// 例子：registerScript("/tmp/root/notes/worker-abc.js", built.source, "/tmp/root/notes", facet) 之后，
// 该脚本抛出的错误经 mapStack 就能显示 notes/worker.ts 中的位置。
export function registerScript(filename: string, source: string, dir: string, owner: object): void {
	// 同一脚本可能被两个宿主分别求值：第二条记录复用已有 SourceMap，只增加 live。
	let script = scripts.get(filename);
	// 没有内联映射（例如构建时未开启 sourcemap）就不需要登记，直接返回。
	if (script === undefined) {
		const map = inlineSourceMap(source);
		if (map === undefined) return;
		// live 从 0 开始，下面统一加一；脚本的第一次求值也走这条路径。
		script = { map, dir, live: 0 };
		scripts.set(filename, script);
	}
	script.live++;
	// owner 被垃圾回收时回调收到 filename；这里不持有 owner 本身，避免注册表反而让它无法回收。
	collected.register(owner, filename);
}

/** The inline source map esbuild appended to a built script, if it has one. */
// 解析 esbuild 追加在脚本末尾的内联 source map。
// 输入：完整脚本文本；输出：node:module 的 SourceMap，或 undefined（没有映射）。
// 这里信任映射由 esbuild 生成：只提取 base64 段并 JSON.parse，不校验 version、sources 等字段。
export function inlineSourceMap(source: string): SourceMap | undefined {
	// SOURCE_MAP 的第 1 个捕获组是 base64 文本；exec 无匹配返回 null，因此先判空再取组。
	const inline = SOURCE_MAP.exec(source);
	// inline[1]! 的非空断言只用于类型：上一行已保证匹配成功且该组存在；Buffer 解码后按 UTF-8 解析 JSON。
	return inline === null ? undefined : new SourceMap(JSON.parse(Buffer.from(inline[1]!, "base64").toString("utf8")));
}

/** The inline source map esbuild appends to a script. */
// 只认脚本末尾的 sourceMappingURL：`//# ` 前缀、data:application/json;base64、合法 base64 字符，
// 末尾 \s* 容忍 esbuild 追加的换行；$ 固定在文本结尾，避免误匹配正文里的同一串字符。
const SOURCE_MAP = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/;

/**
 * `error`'s stack with every position in a registered plugin script mapped through its source map to the plugin's file
 * and line (`notes/worker.ts:12:3`: the plugin's directory name and the file's path inside it); other lines as they
 * are. A value that is no error with a stack gives its string.
 */
// 把错误堆栈中落在已登记插件脚本里的位置改写成插件源文件位置。
// 输入：任意捕获值（不保证是 Error）；输出：可直接记录的字符串。
// 副作用：无，只读注册表；错误路径：非 Error 或没有 stack 时退化为 String(error)。
// 主要流程：逐条匹配 stack 中的 filename:line:column，查到脚本后用 SourceMap.findEntry 找回原始位置，
// 得到“插件目录名/相对文件:行:列”；找不到映射的行原样保留。
// 例子：堆栈行 `at setup (/tmp/root/notes/worker-abc.js:3:9)` 会被改成 `at setup (notes/worker.ts:12:3)`。
// 真实运行时只有位置文本变化，函数名和堆栈其余部分不动。
export function mapStack(error: unknown): string {
	// instanceof 是运行时检查：mapStack 的入参来自 catch，TypeScript 的 unknown 不能保证它是 Error。
	const stack = error instanceof Error ? error.stack : undefined;
	if (stack === undefined) return String(error);
	// String.replace 的回调参数依次是整段匹配、三个捕获组；显式标注 filename/line/column 为 string 只是说明类型。
	return stack.replace(POSITION, (whole, filename: string, line: string, column: string) => {
		// 文件名未登记（普通 Node 栈帧）时 script 为 undefined，后面原样返回整段。
		const script = scripts.get(filename);
		// SourceMap 的行列从 0 开始，而堆栈从 1 开始，因此先各减一。
		const entry = script?.map.findEntry(Number(line) - 1, Number(column) - 1);
		// findEntry 可能返回 undefined；`"originalSource" in entry` 是类型守卫，用来区分生成的映射条目里是否有原始源。
		// 两者任一不满足就返回 whole，保留原位置而不是编造一个来源。
		if (script === undefined || entry === undefined || !("originalSource" in entry)) return whole;
		// originalSource 是相对插件目录的路径；拼上目录名合成“插件名/文件”，再把 Windows 的反斜杠统一成正斜杠。
		const file = join(basename(script.dir), entry.originalSource).split("\\").join("/");
		// 映射条目同样从 0 开始计数，输出前加一；模板字符串只在这里生成最终位置文本。
		return `${file}:${entry.originalLine + 1}:${entry.originalColumn + 1}`;
	});
}

/** A position in a stack line: `filename:line:column`, the filename being anything up to it (spaces included). */
// 匹配 `...:line:col`；`[^\s()]+` 避免把函数名前的空格和括号算进文件名，g 使每个栈帧都被处理。
// 它是对堆栈文本的模式识别，不解析 V8 的完整格式，所以普通栈帧只是匹配不到注册表里的文件名而已。
const POSITION = /([^\s()]+):(\d+):(\d+)/g;
