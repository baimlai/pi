// 文件导读（Durable ExecutionEnv 契约套件）
//
// 所属模块：packages/durable/src/testing；经 "./testing" 导出，实际使用见
// packages/durable/test/env-node-conformance.test.ts（NodeExecutionEnv 原生/轮询 watch）。
// 上游：registerEnvConformance（runner.ts）或直接 createEnvConformance；下游：ExecutionEnv 接口与
// Result/getOrThrow（src/env/index.ts）、Chord 的 Context/BACKGROUND_CONTEXT。
//
// 职责边界：定义"一个 ExecutionEnv 实现应满足的行为"，只调用公共接口，不关心后端是本地 Node、
// 容器、远程 SSH 还是浏览器。它负责构造临时文件、驱动 watch、执行 shell 并断言；资源清理由
// 调用方提供的 withEnv 完成（每个用例一份全新 cwd）。本文件不注册测试，也不依赖测试框架。
//
// 能力清单：createEnvConformance(options) 返回 EnvConformanceCase[]，覆盖：
// - BinaryReader：范围读取、行扫描、重命名后仍读旧文件、目录/缺失/取消错误；
// - DirReader：分页、结束标记、关闭后拒绝、缺失/非目录错误、枚举中被删除的条目跳过；
// - watch：创建/修改/原子替换/删除、祖先目录创建、递归新目录、父目录改名重建、
//   排除项、递归覆盖、同路径目录替换、停止后不再回调、符号链接目标变化；
// - exec：argv 传递不经过 shell、stdout/stderr 流、cwd/退出码、spawn 错误、
//   window 跳过计数、timeout 与 abort 区分；
// - 可选 listFiles：深度优先排序、gitignore/.git/排除名、边界与 truncated、错误；
// - 可选符号链接：listFiles 不跟随链接、BinaryReader noFollow、watch 跟随链接目标。
// 内部辅助：abortedContext、errorCode、readAll、listed、covers、watching。
//
// 典型调用：
//   registerEnvConformance({ describe, expect, it }, "NodeExecutionEnv conformance", async (use) => {
//     const cwd = mkdtempSync(join(tmpdir(), "pi-durable-env-conformance-"));
//     try { await use(new NodeExecutionEnv({ cwd })); } finally { rmSync(cwd, { recursive: true, force: true }); }
//   });
// 选项：shell 默认 ["sh", "-c"]；symlinks 默认 true；listFiles 默认 false（未实现可选方法时不注册相关用例）。
//
// 建议阅读顺序：先看 createEnvConformance 的选项与局部辅助（execCollect/watchCase），
// 再按 BinaryReader → DirReader → watch → exec → listFiles → symlink 分组阅读用例；
// 每条用例名就是它保证的行为。
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
// 从 ExecutionEnv 模块导入的都是契约类型/工具：Result 是 ok/error 判别联合，
// getOrThrow 把 error 分支转成异常，方便测试在"必须成功"的步骤直接失败。
import {
	type ExecutionEnv,
	type FileChange,
	type FileInfo,
	getOrThrow,
	type ListFilesOptions,
	type Result,
	type ShellOutputInfo,
	type WatchTarget,
} from "../env/index.ts";
// 仅类型导入：本文件只用 EnvConformanceCase/Options 的形状，不构造它们。
import type { EnvConformanceCase, EnvConformanceOptions } from "./types.ts";

// 套件内的所有操作都使用无取消的空上下文；需要测试取消时由 abortedContext() 单独派生。
// decoder/encoder 复用同一个 TextDecoder/TextEncoder：它们是纯转换器，没有状态。
const context = BACKGROUND_CONTEXT;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

// 单条环境用例的测试体：接收 provider 准备好的 ExecutionEnv，返回 Promise。
type EnvTest = (env: ExecutionEnv) => Promise<void>;

// 创建一个已经取消的 Context，用来验证各操作把取消映射为 aborted 错误。
// 每次调用新建 controller，避免用例之间共享同一个 AbortSignal 状态。
function abortedContext(): Context {
	// AbortController 的 signal 在 abort() 后保持已取消状态。
	const controller = new AbortController();
	// 立即取消；随后任何支持取消的 env 操作都应返回 error.code = "aborted"。
	controller.abort();
	// withAbortSignal 从 BACKGROUND_CONTEXT 派生一个带取消信号的新上下文；
	// 不修改原上下文，符合 Context 不可变派生模型。
	return withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
}

// 从 Result 中取出错误码，成功时返回 undefined。
// Result<T,E> 是 { ok: true, value } | { ok: false, error } 的判别联合；
// 访问 result.error 前必须先用 result.ok 收窄，否则 TypeScript 报错。
// 该函数只做类型收窄，不检查 code 内容；错误码由后端定义。
function errorCode(result: Result<unknown, { code: string }>): string | undefined {
	return result.ok ? undefined : result.error.code;
}

// 把目录 reader 读到结束，收集所有页。
// 输入：env、目录 path、每页最多 maxEntries 条。
// 输出：{ pages, done }；done=false 表示触发了 1000 页保护（reader 可能没有正确报告结束）。
// 副作用：打开并关闭 reader；即使中途 getOrThrow 抛错，finally 也会 close。
// 主流程：openDirReader → 循环 next → 收集 entries → 遇到 done 返回 → finally close。
// 例子：const { pages, done } = await readAll(env, ".", 2);
async function readAll(
	env: ExecutionEnv,
	path: string,
	maxEntries: number,
): Promise<{ pages: FileInfo[][]; done: boolean }> {
	// openDirReader 返回 Result；getOrThrow 在失败时抛出 FileError，测试因此直接失败。
	const reader = getOrThrow(await env.openDirReader(path, context));
	// 保存每一页，最后再 flat 成完整列表；保留分页结构可以断言每页大小。
	const pages: FileInfo[][] = [];
	try {
		// 最多循环 1000 次，防止 reader 永远返回 done=false 时测试挂死；
		// 这是测试夹具的自我保护，不是 ExecutionEnv 契约的一部分。
		for (let page = 0; page < 1000; page++) {
			// next(maxEntries) 继续上次的位置；entries 最多 maxEntries 条，done 可能在最后一页或空页出现。
			const next = getOrThrow(await reader.next(maxEntries, context));
			pages.push(next.entries);
			// 读到结束就返回；finally 仍会关闭 reader。
			if (next.done) return { pages, done: true };
		}
		return { pages, done: false };
		// 正常路径和异常路径都会 close；close 本身若失败会覆盖原始错误，
		// 但对契约测试来说这同样是需要暴露的问题。
	} finally {
		await reader.close(context);
	}
}

// 把 listFiles 的完整结果转换成易比较的字符串列表。
// 输入：env、目录 path、可选 ListFilesOptions。
// 输出：entries 形如 "f path" / "d path" / "l path"，以及 truncated 标志。
// 错误：环境未实现 listFiles 时抛错（调用方应先用 options.listFiles 决定是否注册用例）；
//       listFiles 自身失败由 getOrThrow 抛出 FileError。
// 例子：await listed(env, ".", { hidden: false })
/** A listing as `<kind letter> <path>` lines (`f`, `d`, `l`), with its truncation. */
async function listed(
	env: ExecutionEnv,
	path: string,
	options?: ListFilesOptions,
): Promise<{ entries: string[]; truncated: boolean }> {
	// listFiles 在 FileSystem 接口上是可选方法；这里做运行期检查是因为 TypeScript 的
	// 可选性只在编译期，且调用点确实可能传入未实现它的环境。
	if (env.listFiles === undefined) throw new Error("The environment does not implement listFiles");
	// 直接调用 env.listFiles；options 省略时使用环境默认值（默认包含隐藏文件、应用 gitignore）。
	const listing = getOrThrow(await env.listFiles(path, options, context));
	// 字母映射把 FileKind 转成单字符；as const 保留 "f"/"d"/"l" 字面量类型，
	// 这样 letter[entry.kind] 的索引访问有完整类型检查。
	const letter = { file: "f", directory: "d", symlink: "l" } as const;
	return {
		// 每个条目编码为 "<kind letter> <relative path>"，便于用 deepEqual 比较完整顺序。
		entries: listing.entries.map((entry) => `${letter[entry.kind]} ${entry.path}`),
		truncated: listing.truncated,
	};
}

// 判断一次 FileChange 是否覆盖 path。
// overflow 表示覆盖范围不确定，保守地视为覆盖一切；failed 不是路径报告，返回 false；
// paths 分支需要检查 path 是否等于某个报告路径或位于其下方。
/** Whether a change reports `path`: an overflow, or a reported path at or above it. */
function covers(change: FileChange, path: string): boolean {
	if (change.kind === "overflow") return true;
	if (change.kind !== "paths") return false;
	// 同时接受 / 和 \\ 作为分隔符：Windows 环境可能报告反斜杠路径。
	// startsWith(`${reported}/`) 表示 path 在 reported 目录内部。
	return change.paths.some(
		(reported) => path === reported || path.startsWith(`${reported}/`) || path.startsWith(`${reported}\\`),
	);
}

// 在 watch 打开期间执行 run，并提供等待变更的辅助函数。
// 输入：env、要 watch 的 targets、run 回调。
// 输出：无；run 完成后总是停止 watcher（finally）。
// 副作用：收集所有 FileChange；expectChange 会轮询最多 3 秒。
// 主流程：watch → 构造 helpers → 执行 run → finally stop。
// 例子：await watching(env, [{ path: "AGENTS.md" }], async ({ expectChange }) => { ... });
/** Watch `targets` while `run` changes files, with a helper that waits for a change reporting a path. */
async function watching(
	env: ExecutionEnv,
	targets: readonly WatchTarget[],
	run: (helpers: {
		readonly changes: FileChange[];
		/** Wait up to three seconds for a change, after the call, that reports `path`. */
		expectChange(path: string, change: () => Promise<void>): Promise<void>;
		absolute(path: string): Promise<string>;
	}) => Promise<void>,
): Promise<void> {
	// 变更按到达顺序保存；expectChange 只看调用之后的片段，避免误把旧事件当成本次结果。
	const changes: FileChange[] = [];
	// watch 返回 Result<FileWatcher>；getOrThrow 确保 watcher 成功创建。
	// 回调只做收集，不做断言，避免在环境线程/异步回调里抛出难以归属的错误。
	const watcher = getOrThrow(await env.watch(targets, (change) => changes.push(change), context));
	try {
		// absolute 把相对路径转成环境中的绝对路径；covers 比较的是绝对路径。
		const absolute = async (path: string) => getOrThrow(await env.absolutePath(path, context));
		await run({
			changes,
			absolute,
			// expectChange：执行 change()，然后等待一个覆盖 path 的新变更。
			// 它不要求变更立即到达：文件系统通知有延迟，所以最多轮询 3 秒（20ms 一次）。
			async expectChange(path, change) {
				// 先把目标转成绝对路径；后续报告路径也按绝对路径比较。
				const target = await absolute(path);
				// 记录当前 changes 长度；只考虑这次 change() 之后新增的事件。
				const from = changes.length;
				await change();
				// 每次 expectChange 单独计时，避免多个步骤共享一个总超时。
				const deadline = Date.now() + 3000;
				// changes.slice(from) 只看新增事件；some 命中即通过。
				while (!changes.slice(from).some((entry) => covers(entry, target))) {
					// 超时错误包含期望路径和实际收到的新事件，便于诊断 watch 实现。
					if (Date.now() > deadline) {
						throw new Error(`No change reported ${target}; got ${JSON.stringify(changes.slice(from))}`);
					}
					// 轮询间隔 20ms；这是测试辅助的等待策略，不保证 watcher 的实时性。
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			},
		});
		// 无论 run 成功还是抛错都停止 watcher，避免后台监听泄漏到后续用例。
	} finally {
		await watcher.stop(context);
	}
}

// 创建一个 runner 无关的 ExecutionEnv 契约用例数组。
// 输入：options.assertions（断言实现）、options.withEnv（为每条用例准备/清理环境），
//       以及可选能力开关 shell/symlinks/listFiles。
// 输出：EnvConformanceCase[]；每项有 name、run，watch 用例还可能带 timeoutMs。
// 副作用：无（只构造闭包）；真正执行发生在 runner 调用 run 时。
// 错误：构造阶段不抛错；运行阶段的错误由 run 的 Promise rejection 交给 runner。
// 主流程：解析默认值 → 定义 createCase/watchCase/execCollect → 构造基础用例 →
//          按能力追加 listFiles/symlink 用例 → 返回数组。
// 例子：const cases = createEnvConformance({ assertions, withEnv, listFiles: true });
/**
 * Creates runner-independent cases for an `ExecutionEnv`. `withEnv` must call and await its callback exactly once per
 * case with an environment whose `cwd` is a fresh, empty, writable directory.
 */
export function createEnvConformance(options: EnvConformanceOptions): readonly EnvConformanceCase[] {
	// assert 是窄接口，避免本文件依赖具体测试框架。
	const assert = options.assertions;
	// shell 默认 POSIX sh -c：后续用例把脚本作为最后一个参数传入。
	const shell = options.shell ?? ["sh", "-c"];
	// symlinks 默认 true：大多数环境支持 ln -s；Windows Git Bash 默认不建真链接，调用方会传 false。
	const symlinks = options.symlinks ?? true;
	// 统一的用例构造：把 name/test 包装成 { name, run }。
	// timeoutMs 通过条件展开只在定义时加入，避免生成显式的 undefined 字段；
	// run 忽略参数，改为用 options.withEnv(test) 提供环境。
	const createCase = (name: string, test: EnvTest, timeoutMs?: number): EnvConformanceCase => ({
		name,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		// withEnv 负责创建全新 cwd、调用 test、最后清理；契约要求它对每次 run 调用恰好一次。
		run: () => options.withEnv(test),
	});
	// watch 用例每步最多等 3 秒，给 runner 30 秒超时，避免默认 5 秒限制误报。
	// Watch cases wait up to three seconds per step, longer than test runners allow by default.
	const watchCase = (name: string, test: EnvTest): EnvConformanceCase => createCase(name, test, 30_000);
	// 执行命令并收集 stdout/stderr 文本。
	// 输入：env、command（字符串走 shell，数组走 argv 直接执行）、可选 cwd。
	// 输出：{ result, stdout, stderr }；result 是 Result<ShellExecResult, ExecutionError>。
	// 副作用：真实运行进程；onOutput 可能被调用多次。
	// 错误：命令失败仍返回 result（带退出码/错误码），不在这里 throw；调用方决定如何断言。
	const execCollect = async (env: ExecutionEnv, command: string | readonly string[], cwd?: string) => {
		// Record<ShellOutputInfo["stream"], string> 把键限制为 "stdout" | "stderr"，
		// 两个流分别累积，不能混在一起。
		const output: Record<ShellOutputInfo["stream"], string> = { stdout: "", stderr: "" };
		// 字符串命令由环境自己的 shell 解释；数组命令不经过 shell。
		const result = await env.exec(
			command,
			{
				// cwd 为 undefined 时省略该字段，而不是传 cwd: undefined；
				// 条件展开让 options 在有/无 cwd 时都符合 ShellExecOptions。
				...(cwd === undefined ? {} : { cwd }),
				// info.stream 标识这段文本来自哪个流；按流追加即可还原完整输出。
				onOutput: (text, _context, info) => {
					output[info.stream] += text;
				},
			},
			context,
		);
		// 把 result 与两个字符串合并返回；result 仍保留 ok/error 判别，供 errorCode 使用。
		return { result, ...output };
	};

	// 基础用例（所有环境都必须通过）。下面的注释按组说明每条用例验证的行为。
	const cases: EnvConformanceCase[] = [
		// BinaryReader 精确范围读取：写入 11 字节，读取中间范围、末尾之后、零长度、非法参数和取消。
		createCase("binary reader reads byte ranges of the opened file", async (env) => {
			// writeFile 接受 string 或 Uint8Array；这里用字符串，环境按 UTF-8 编码。
			getOrThrow(await env.writeFile("data.txt", "hello world", context));
			// undefined 表示不启用 noFollow：允许跟随符号链接。
			const reader = getOrThrow(await env.openBinaryReader("data.txt", undefined, context));
			// info() 报告的是已打开文件的元数据，而不是路径当前指向的对象。
			const info = getOrThrow(await reader.info(context));
			// partialDeepEqual 只检查 name/kind/size，忽略 mtimeMs 等环境相关字段。
			assert.partialDeepEqual(info, { name: "data.txt", kind: "file", size: 11 });
			// read(offset, length)：从 offset 起最多 length 字节；解码后比较文本。
			assert.strictEqual(decoder.decode(getOrThrow(await reader.read(0, 5, context))), "hello");
			// 从 6 开始读 100 字节，实际只剩 "world"（5 字节）。
			assert.strictEqual(decoder.decode(getOrThrow(await reader.read(6, 100, context))), "world");
			// offset 等于文件长度：返回空数组。
			assert.strictEqual(getOrThrow(await reader.read(11, 4, context)).length, 0);
			// offset 超过文件长度：同样返回空数组，不报错。
			assert.strictEqual(getOrThrow(await reader.read(50, 1, context)).length, 0);
			// length 为 0：返回空数组，即使 offset 在文件内。
			assert.strictEqual(getOrThrow(await reader.read(3, 0, context)).length, 0);
			// 负 offset 是非法请求，错误码 invalid；这属于运行时校验。
			assert.strictEqual(errorCode(await reader.read(-1, 1, context)), "invalid");
			// 小数长度非法；接口没有在类型上限制整数。
			assert.strictEqual(errorCode(await reader.read(0, 1.5, context)), "invalid");
			// 已取消的上下文应优先返回 aborted。
			assert.strictEqual(errorCode(await reader.read(0, 1, abortedContext())), "aborted");
			// 关闭两次是幂等的；第二次不应抛错。
			await reader.close(context);
			await reader.close(context);
			// 关闭后的 read/info 返回 invalid（reader 已失效）。
			assert.strictEqual(errorCode(await reader.read(0, 1, context)), "invalid");
			assert.strictEqual(errorCode(await reader.info(context)), "invalid");
		}),

		// 行扫描：构造含 BOM、换行前的非法 UTF-8、空行、行中 U+FEFF、且无结尾换行的字节；
		// 逐段比较 scanLines 结果与"整体解码后按 \n 切分"的结果。
		createCase("binary reader scans lines like decoding the whole file", async (env) => {
			// A byte-order mark, an invalid sequence before a newline, an empty line, a later U+FEFF, and no final newline.
			// 字节序列：EF BB BF 是开头 BOM；E2 82 后接换行是不完整序列；
			// 后面的 EF BB BF 出现在第二行中间，不应被当作 BOM 去掉。
			const bytes = Uint8Array.from([
				0xef, 0xbb, 0xbf, 0x61, 0x0a, 0xe2, 0x82, 0x0a, 0x0a, 0xef, 0xbb, 0xbf, 0x62, 0x0a, 0xc3, 0xa9,
			]);
			getOrThrow(await env.writeFile("lines.txt", bytes, context));
			// 基准答案：TextDecoder 会用一个 U+FFFD 替换非法序列，然后按换行切分。
			// 注意最后的 C3 A9 是 é，没有结尾换行。
			const lines = new TextDecoder().decode(bytes).split("\n");
			// 用 BinaryReader 逐段扫描，而不是把整个文件读进内存。
			const reader = getOrThrow(await env.openBinaryReader("lines.txt", undefined, context));
			try {
				// 测试的 [startLine, endLine) 组合：全文件、单行、空区间、从中间到结尾、越界。
				// endLine undefined 表示扫描到文件末尾。
				const ranges: [number, number | undefined][] = [
					[0, undefined],
					[0, 1],
					[1, 3],
					[2, 3],
					[3, undefined],
					[4, 9],
				];
				// 每个组合都用同一份基准答案验证，包括 newlines、字节范围和首行信息。
				for (const [startLine, endLine] of ranges) {
					const scan = getOrThrow(
						// 条件展开：只有 endLine 有定义时才传给 scanLines，符合其 options 类型。
						await reader.scanLines({ startLine, ...(endLine === undefined ? {} : { endLine }) }, context),
					);
					// selected 是被选中的行文本（join 后不带末尾换行）。
					const selected = lines.slice(startLine, endLine);
					// range 解码原始字节区间；ignoreBOM 只在 from=0 时为 false，
					// 以模拟"文件开头的 BOM 被 TextDecoder 去掉、其他位置的 U+FEFF 保留"。
					const range = (from: number, to: number) =>
						new TextDecoder("utf-8", { ignoreBOM: from > 0 }).decode(bytes.subarray(from, to));
					// newlines 是整个文件（不只是选区）的换行字节数；因此总行数是 newlines + 1。
					assert.strictEqual(scan.newlines, lines.length - 1);
					// scan.start/end 是选区的字节范围；解码后应等于选中行用 \n 连接的结果。
					assert.strictEqual(range(scan.start, scan.end), selected.join("\n"));
					// selectedBytes 是解码后文本的 UTF-8 字节长度；与原始字节长度可能不同
					// （非法字节被替换为 U+FFFD）。
					assert.strictEqual(scan.selectedBytes, encoder.encode(selected.join("\n")).length);
					// firstLineEnd 是第一条选中行的结束位置；firstLineBytes 是它的解码字节长度。
					assert.strictEqual(range(scan.start, scan.firstLineEnd), lines[startLine]);
					assert.strictEqual(scan.firstLineBytes, encoder.encode(lines[startLine]).length);
				}
				// 从第 9 行开始扫描：已越过最后一行，返回位于文件末尾的空选区。
				assert.partialDeepEqual(getOrThrow(await reader.scanLines({ startLine: 9 }, context)), {
					start: bytes.length,
					end: bytes.length,
					selectedBytes: 0,
				});
				// endLine 等于 startLine 是空区间，契约规定为 invalid。
				assert.strictEqual(errorCode(await reader.scanLines({ startLine: 2, endLine: 2 }, context)), "invalid");
			} finally {
				await reader.close(context);
			}
		}),

		// 重命名后 reader 仍读打开时的文件：路径 a.txt 被换成新内容也不影响已打开的句柄。
		createCase("binary reader keeps reading the file it opened after a rename", async (env) => {
			getOrThrow(await env.writeFile("a.txt", "one", context));
			const reader = getOrThrow(await env.openBinaryReader("a.txt", undefined, context));
			try {
				getOrThrow(await env.renameFile("a.txt", "b.txt", context));
				getOrThrow(await env.writeFile("a.txt", "two", context));
				assert.strictEqual(decoder.decode(getOrThrow(await reader.read(0, 10, context))), "one");
			} finally {
				await reader.close(context);
			}
		}),

		// 打开失败的分类：目录 is_directory、缺失 not_found、取消 aborted。
		createCase("binary reader refuses directories, missing files and aborted opens", async (env) => {
			getOrThrow(await env.createDir("dir", undefined, context));
			getOrThrow(await env.writeFile("file.txt", "x", context));
			assert.strictEqual(errorCode(await env.openBinaryReader("dir", undefined, context)), "is_directory");
			assert.strictEqual(errorCode(await env.openBinaryReader("missing.txt", undefined, context)), "not_found");
			assert.strictEqual(errorCode(await env.openBinaryReader("file.txt", undefined, abortedContext())), "aborted");
		}),

		// DirReader 分页：写入 5 个文件和一个子目录，每页最多 2 条，要求每条恰好出现一次。
		createCase("directory reader pages every entry exactly once", async (env) => {
			const names = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
			for (const name of names) getOrThrow(await env.writeFile(name, name, context));
			getOrThrow(await env.createDir("sub", undefined, context));
			// readAll 内部会在 finally 关闭 reader；返回的 pages 是各页原始内容。
			const { pages, done } = await readAll(env, ".", 2);
			// done 为 true 表示 reader 主动报告结束，而不是触发 1000 页保护。
			assert.ok(done, "directory reader reached the end");
			// 每页不超过 maxEntries；这是分页契约。
			for (const page of pages) assert.ok(page.length <= 2, "page within maxEntries");
			// 合并后的条目名字集合（排序后）应等于 5 个文件加 sub，不依赖枚举顺序。
			const entries = pages.flat();
			assert.deepEqual(entries.map((entry) => entry.name).sort(), [...names, "sub"].sort());
			// 目录条目的 kind 必须是 directory。
			assert.strictEqual(entries.find((entry) => entry.name === "sub")?.kind, "directory");
			// 文件条目至少报告 kind=file 和正确的 size（a.txt 为 5 字节）。
			assert.partialDeepEqual(
				entries.find((entry) => entry.name === "a.txt"),
				{ kind: "file", size: 5 },
			);
		}),

		// 空目录：第一次 next 就返回 done=true；再次 next 仍返回同样的空结果。
		// next(0) 非法；取消上下文返回 aborted；关闭两次幂等；关闭后 next 返回 invalid。
		createCase("directory reader reports the end and refuses use after close", async (env) => {
			getOrThrow(await env.createDir("empty", undefined, context));
			const reader = getOrThrow(await env.openDirReader("empty", context));
			assert.deepEqual(getOrThrow(await reader.next(10, context)), { entries: [], done: true });
			assert.deepEqual(getOrThrow(await reader.next(10, context)), { entries: [], done: true });
			assert.strictEqual(errorCode(await reader.next(0, context)), "invalid");
			assert.strictEqual(errorCode(await reader.next(1, abortedContext())), "aborted");
			await reader.close(context);
			await reader.close(context);
			assert.strictEqual(errorCode(await reader.next(1, context)), "invalid");
		}),

		// 打开失败分类：缺失目录 not_found、文件不是目录 not_directory、取消 aborted。
		createCase("directory reader refuses missing paths and files", async (env) => {
			getOrThrow(await env.writeFile("file.txt", "x", context));
			assert.strictEqual(errorCode(await env.openDirReader("missing", context)), "not_found");
			const file = await env.openDirReader("file.txt", context);
			assert.strictEqual(errorCode(file), "not_directory");
			assert.strictEqual(errorCode(await env.openDirReader(".", abortedContext())), "aborted");
		}),

		// 枚举过程中删除条目：reader 打开后删除 x/y/z，随后分页读取不应报错，
		// 消失的条目按契约跳过，最终得到空数组。
		createCase("directory reader skips entries removed during enumeration", async (env) => {
			getOrThrow(await env.createDir("dir", undefined, context));
			for (const name of ["x", "y", "z"]) getOrThrow(await env.writeFile(`dir/${name}`, name, context));
			const reader = getOrThrow(await env.openDirReader("dir", context));
			try {
				for (const name of ["x", "y", "z"]) getOrThrow(await env.remove(`dir/${name}`, undefined, context));
				const entries: FileInfo[] = [];
				for (let page = 0; page < 10; page++) {
					const next = getOrThrow(await reader.next(10, context));
					entries.push(...next.entries);
					if (next.done) break;
				}
				assert.deepEqual(entries, []);
			} finally {
				await reader.close(context);
			}
		}),

		// watch 生命周期：目标一开始不存在，依次验证创建、修改、编辑器的临时文件重命名替换、
		// 再次修改和删除都会被报告。
		watchCase("watch reports a missing file's creation, changes, replacement and removal", async (env) => {
			// 非递归 watch 一个文件路径；AGENTS.md 缺失时也可以 watch，创建它即产生变更。
			await watching(env, [{ path: "AGENTS.md" }], async ({ expectChange }) => {
				await expectChange("AGENTS.md", async () => {
					getOrThrow(await env.writeFile("AGENTS.md", "one", context));
				});
				await expectChange("AGENTS.md", async () => {
					getOrThrow(await env.writeFile("AGENTS.md", "two!", context));
				});
				// 编辑器通常写临时文件再 rename 覆盖目标；变更必须归到目标路径。
				// Editors replace a file by renaming a new one over it.
				await expectChange("AGENTS.md", async () => {
					getOrThrow(await env.writeFile("AGENTS.md.tmp", "three", context));
					getOrThrow(await env.renameFile("AGENTS.md.tmp", "AGENTS.md", context));
				});
				await expectChange("AGENTS.md", async () => {
					getOrThrow(await env.writeFile("AGENTS.md", "four", context));
				});
				await expectChange("AGENTS.md", async () => {
					getOrThrow(await env.remove("AGENTS.md", undefined, context));
				});
			});
		}),

		// 目标的祖先目录不存在时也要能收到创建通知；写入 a/b/c/AGENTS.md 会隐式创建目录。
		watchCase("watch reports a missing target whose ancestors are created", async (env) => {
			await watching(env, [{ path: "a/b/c/AGENTS.md" }], async ({ expectChange }) => {
				await expectChange("a/b/c/AGENTS.md", async () => {
					getOrThrow(await env.writeFile("a/b/c/AGENTS.md", "x", context));
				});
			});
		}),

		// 递归 watch 一个已存在的目录；新建子目录及其中的文件发生在 watcher 覆盖新目录之前，
		// 实现仍需报告 skills/a/b/SKILL.md。
		watchCase("watch follows directories created together with their contents", async (env) => {
			getOrThrow(await env.createDir("skills", undefined, context));
			await watching(env, [{ path: "skills", recursive: true }], async ({ expectChange }) => {
				// Written before any watcher on the new directories can exist.
				await expectChange("skills/a/b/SKILL.md", async () => {
					getOrThrow(await env.writeFile("skills/a/b/SKILL.md", "one", context));
				});
				await expectChange("skills/a/b/SKILL.md", async () => {
					getOrThrow(await env.writeFile("skills/a/b/SKILL.md", "two!", context));
				});
				await expectChange("skills/a/b/c/SKILL.md", async () => {
					getOrThrow(await env.writeFile("skills/a/b/c/SKILL.md", "deeper", context));
				});
			});
		}),

		// 父目录被改名后又在原路径重建：watcher 要报告原目标路径的变化，并继续跟踪重建后的目录。
		watchCase("watch keeps watching a path whose parent is renamed and recreated", async (env) => {
			getOrThrow(await env.writeFile("proj/.pi/skills/x.md", "x", context));
			await watching(env, [{ path: "proj/.pi/skills", recursive: true }], async ({ expectChange }) => {
				await expectChange("proj/.pi/skills", async () => {
					getOrThrow(await env.renameFile("proj/.pi", "proj/old", context));
				});
				await expectChange("proj/.pi/skills/y.md", async () => {
					getOrThrow(await env.writeFile("proj/.pi/skills/y.md", "y", context));
				});
				await expectChange("proj/.pi/skills/y.md", async () => {
					getOrThrow(await env.writeFile("proj/.pi/skills/y.md", "yy", context));
				});
			});
		}),

		// exclude 排除隐藏项和 node_modules：这些条目的写入不应出现在变更里；
		// 但从被排除目录 rename 到可见路径时，目标变化必须被报告。
		watchCase("watch skips excluded entries and reports a rename out of them", async (env) => {
			getOrThrow(await env.createDir("skills", undefined, context));
			const targets: WatchTarget[] = [
				{ path: "skills", recursive: true, exclude: { hidden: true, names: ["node_modules"] } },
			];
			// hidden: true 排除以 . 开头的名字；names 额外排除 node_modules。
			await watching(env, targets, async ({ changes, expectChange, absolute }) => {
				getOrThrow(await env.writeFile("skills/node_modules/dep/SKILL.md", "dep", context));
				getOrThrow(await env.writeFile("skills/.SKILL.md.tmp", "draft", context));
				await expectChange("skills/SKILL.md", async () => {
					getOrThrow(await env.renameFile("skills/.SKILL.md.tmp", "skills/SKILL.md", context));
				});
				// 收集被排除路径的绝对形式，随后扫描所有报告的路径，确保没有泄漏。
				const hidden = [await absolute("skills/node_modules"), await absolute("skills/.SKILL.md.tmp")];
				for (const change of changes) {
					if (change.kind !== "paths") continue;
					for (const path of change.paths) {
						assert.ok(
							!hidden.some((excluded) => path === excluded || path.startsWith(excluded)),
							`excluded ${path}`,
						);
					}
				}
			});
		}),

		// 同一路径同时以非递归和递归两个 target 出现时，递归覆盖必须保留（不能互相覆盖）。
		watchCase("watch keeps recursive coverage where a non-recursive target overlaps", async (env) => {
			getOrThrow(await env.writeFile("skills/a/one.md", "one", context));
			const targets: WatchTarget[] = [{ path: "skills" }, { path: "skills", recursive: true }];
			await watching(env, targets, async ({ expectChange }) => {
				await expectChange("skills/a/two.md", async () => {
					getOrThrow(await env.writeFile("skills/a/two.md", "two", context));
				});
			});
		}),

		// 目录被 rename 走并在同一路径重建：watcher 需要报告路径变化并继续跟踪新目录内容。
		watchCase("watch follows a directory replaced at the same path", async (env) => {
			getOrThrow(await env.writeFile("skills/a/x.md", "x", context));
			await watching(env, [{ path: "skills", recursive: true }], async ({ expectChange }) => {
				await expectChange("skills/a", async () => {
					getOrThrow(await env.renameFile("skills/a", "skills-old", context));
					getOrThrow(await env.createDir("skills/a", undefined, context));
				});
				await expectChange("skills/a/y.md", async () => {
					getOrThrow(await env.writeFile("skills/a/y.md", "y", context));
				});
				await expectChange("skills/a/y.md", async () => {
					getOrThrow(await env.writeFile("skills/a/y.md", "yy", context));
				});
			});
		}),

		// 停止后不再回调：watcher.mode 必须是 native 或 polling；stop 幂等；
		// 停止后写文件并等待 300ms，changes 仍应为空。
		watchCase("watch stops reporting once stopped", async (env) => {
			const changes: FileChange[] = [];
			const watcher = getOrThrow(await env.watch([{ path: "file.txt" }], (change) => changes.push(change), context));
			// 运行时检查 mode 值；类型上是 "native" | "polling"，这里验证实现确实报告。
			assert.ok(watcher.mode === "native" || watcher.mode === "polling", "watcher reports its mode");
			await watcher.stop(context);
			await watcher.stop(context);
			getOrThrow(await env.writeFile("file.txt", "x", context));
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.deepEqual(changes, []);
		}),

		// argv 模式不经过 shell：hostile 字符串里的 $()、反引号、*、; 都应作为普通参数
		// 传给 printf，不能创建 pwned 文件。
		createCase("argv exec passes arguments to the program without shell parsing", async (env) => {
			const hostile = "it's $(touch pwned) `touch pwned` *; touch pwned";
			// [...shell, script, "argv0", hostile, "a b"]：sh -c 执行脚本，
			// 脚本的第一个位置参数是 $0（argv0），后面才是 $1/$2。
			const { result, stdout } = await execCollect(env, [
				...shell,
				'printf "%s|%s" "$1" "$2"',
				"argv0",
				hostile,
				"a b",
			]);
			assert.strictEqual(getOrThrow(result).exitCode, 0);
			assert.strictEqual(stdout, `${hostile}|a b`);
			// 若任何 shell 元字符被解释，工作目录会出现 pwned；这里确认不存在。
			assert.strictEqual(getOrThrow(await env.exists("pwned", context)), false);
		}),

		// 输出流：同一脚本同时写 stdout/stderr，字符串命令和 argv 命令两种形式都要正确分流。
		createCase("exec reports the stream of every chunk in both forms", async (env) => {
			const script = "printf out; printf err >&2; printf more";
			// printf out; printf err >&2; printf more：stdout 是 outmore，stderr 是 err。
			const argv = await execCollect(env, [...shell, script]);
			assert.strictEqual(getOrThrow(argv.result).exitCode, 0);
			assert.strictEqual(argv.stdout, "outmore");
			assert.strictEqual(argv.stderr, "err");
			// 字符串形式由环境 shell 解析；两种调用方式的结果应一致。
			const string = await execCollect(env, script);
			assert.strictEqual(getOrThrow(string.result).exitCode, 0);
			assert.strictEqual(string.stdout, "outmore");
			assert.strictEqual(string.stderr, "err");
		}),

		// cwd 与退出码：在 sub 目录中写 made.txt，退出码 3 原样返回，文件应落在 sub 下。
		createCase("argv exec honors cwd and exit codes", async (env) => {
			getOrThrow(await env.createDir("sub", undefined, context));
			const made = await execCollect(env, [...shell, "printf x > made.txt; exit 3"], "sub");
			assert.strictEqual(getOrThrow(made.result).exitCode, 3);
			assert.strictEqual(getOrThrow(await env.readTextFile("sub/made.txt", context)), "x");
		}),

		// 不存在的程序与空 argv 都是 spawn_error，而不是 timeout 或一般 unknown。
		createCase("argv exec reports missing programs and empty argv as spawn errors", async (env) => {
			assert.strictEqual(
				errorCode(await env.exec(["pi-durable-conformance-missing-program"], undefined, context)),
				"spawn_error",
			);
			assert.strictEqual(errorCode(await env.exec([], undefined, context)), "spawn_error");
		}),

		// window 模式：只保留输出尾部；环境可以跳过中间内容，并通过 info.skipped 报告被省略的量。
		// 这里用 2000 行输出、200 字节/5 行的窗口验证总字节/行数仍精确，且最终 tail 正确。
		createCase("windowed exec keeps the exact tail and counts what it skips", async (env) => {
			const lines = 2000;
			// maxBytes/maxLines 是保留的尾部上限；minIntervalMs=0 允许尽快交付；
			// bytesPerSecond 设得很大，避免测试被人为限速拖慢。
			const window = { maxBytes: 200, maxLines: 5, minIntervalMs: 0, bytesPerSecond: 1_000_000_000 };
			// 累计收到的字节、换行数，以及当前保留的尾部文本。
			let bytes = 0;
			let newlines = 0;
			let tail = "";
			const result = await env.exec(
				// POSIX shell 循环输出 line-0..line-1999；$((i+1)) 是 shell 算术展开。
				[...shell, `i=0; while [ $i -lt ${lines} ]; do echo line-$i; i=$((i+1)); done`],
				{
					window,
					// onOutput 每收到一个 chunk 调用一次；info.skipped 只在 window 模式且环境跳过内容时出现。
					onOutput: (text, _context, info) => {
						// 跳过事件：累加被省略的字节/换行，并断言"跳过之后紧跟的 chunk 超过窗口"，
						// 否则被省略的内容仍可能属于需要保留的尾部。
						if (info.skipped !== undefined) {
							bytes += info.skipped.bytes;
							newlines += info.skipped.newlines;
							const after = encoder.encode(text).length;
							const afterNewlines = text.split("\n").length - 1;
							assert.ok(
								after > window.maxBytes || afterNewlines > window.maxLines,
								"a skip is followed by more than the window",
							);
							// 出现跳过事件说明前面的 tail 已被放弃；清空 tail，从当前 chunk 重新累积。
							tail = "";
						}
						// 累计实际交付的字节和换行；tail 不断追加，最终只保留最后部分。
						bytes += encoder.encode(text).length;
						newlines += text.split("\n").length - 1;
						tail += text;
					},
				},
				context,
			);
			// 总字节数应等于所有预期行的拼接长度；换行数正好是 2000。
			assert.strictEqual(getOrThrow(result).exitCode, 0);
			const expected = Array.from({ length: lines }, (_, index) => `line-${index}\n`);
			assert.strictEqual(bytes, expected.join("").length);
			assert.strictEqual(newlines, lines);
			// 最后一个 chunk 可能包含超过窗口的内容，但末尾必须与最后 5 行一致。
			assert.ok(tail.endsWith(expected.slice(-window.maxLines).join("")), "the delivered output ends with the tail");
		}),

		// 超时与取消是不同错误：timeout 来自 options.timeout，aborted 来自 Context 的取消信号。
		createCase("argv exec distinguishes timeout from abort", async (env) => {
			// timeout 单位是秒（0.1 秒）；sleep 2 必然超时。
			const timedOut = await env.exec([...shell, "sleep 2"], { timeout: 0.1 }, context);
			assert.strictEqual(errorCode(timedOut), "timeout");
			// 用 controller 在 100ms 后取消；withAbortSignal 派生的上下文只影响本次调用。
			const controller = new AbortController();
			const running = env.exec([...shell, "sleep 2"], undefined, withAbortSignal(controller.signal, context));
			setTimeout(() => controller.abort(), 100);
			assert.strictEqual(errorCode(await running), "aborted");
		}),
	];

	// listFiles 是可选能力：只有调用方声明实现时才注册以下用例。
	if (options.listFiles) {
		// writeAll 逐个写空文件；listFiles 只关心路径和类型，不需要内容。
		const writeAll = async (env: ExecutionEnv, files: readonly string[]) => {
			for (const file of files) getOrThrow(await env.writeFile(file, "", context));
		};
		cases.push(
			// 深度优先、父目录先于子项、同级按名字字节序；隐藏项默认包含。
			// 期望列表同时验证 d/f 类型、相对路径和排序。
			createCase("listFiles lists files and directories depth first in name order", async (env) => {
				await writeAll(env, ["b.txt", "a/z.txt", "a/b/c.txt", ".hidden/x", "A.txt"]);
				getOrThrow(await env.createDir("empty", undefined, context));
				// 列表本身也是深度优先顺序：.hidden 先出现（名字以 . 开头），其子项紧跟；
				// A.txt 在 a 前（字节序大写字母更小），a/b 目录在 a/z.txt 前。
				assert.deepEqual(await listed(env, "."), {
					entries: [
						"d .hidden",
						"f .hidden/x",
						"f A.txt",
						"d a",
						"d a/b",
						"f a/b/c.txt",
						"f a/z.txt",
						"f b.txt",
						"d empty",
					],
					truncated: false,
				});
				// hidden: false 排除 .hidden 及其子项，其余顺序不变。
				assert.deepEqual((await listed(env, ".", { hidden: false })).entries, [
					"f A.txt",
					"d a",
					"d a/b",
					"f a/b/c.txt",
					"f a/z.txt",
					"f b.txt",
					"d empty",
				]);
				// 列出子目录 a 时，路径相对 a：目录 b、b/c.txt、z.txt；父目录本身不出现。
				const expected = { entries: ["d b", "f b/c.txt", "f z.txt"], truncated: false };
				assert.deepEqual(await listed(env, "a"), expected);
				// 绝对路径与相对路径应得到相同列表。
				assert.deepEqual(await listed(env, getOrThrow(await env.absolutePath("a", context))), expected);
				assert.deepEqual(await listed(env, "empty"), { entries: [], truncated: false });
			}),

			// gitignore 与 .git 规则：先验证非 work tree 时 .gitignore 不生效；
			// 创建 .git 后，out/ 与 *.log 被忽略，.git/info/exclude 排除根 keep.txt，
			// exclude 参数排除 node_modules，.git 本身永不列出。
			createCase("listFiles skips what git ignores in work trees, .git, and excluded names", async (env) => {
				await writeAll(env, ["keep.txt", "out/x.js", "sub/keep.txt", "sub/drop.log", "node_modules/m/i.js"]);
				// 根 .gitignore 忽略 out/ 和所有 *.log；sub/.gitignore 用 !keep.txt 重新包含子目录里的 keep.txt。
				getOrThrow(await env.writeFile(".gitignore", "out/\n*.log\n", context));
				getOrThrow(await env.writeFile("sub/.gitignore", "!keep.txt\n", context));
				// 还没有 .git 目录，不是 git work tree，因此 .gitignore 文件不生效。
				// Not a work tree yet: `.gitignore` files have no effect.
				assert.ok((await listed(env, ".")).entries.includes("f out/x.js"));
				// 写入 .git/HEAD 使该目录成为 work tree；.git/info/exclude 额外排除根 keep.txt。
				getOrThrow(await env.writeFile(".git/HEAD", "ref: refs/heads/main\n", context));
				getOrThrow(await env.writeFile(".git/info/exclude", "keep.txt\n", context));
				// 预期：根 .gitignore 自己仍列出；out/ 被根规则忽略；node_modules 被参数排除；
				// sub/drop.log 被 *.log 忽略；sub/keep.txt 被子目录的 !keep.txt 重新包含。
				assert.deepEqual((await listed(env, ".", { exclude: ["node_modules"] })).entries, [
					"f .gitignore",
					"d sub",
					"f sub/.gitignore",
					"f sub/keep.txt",
				]);
				// 从 work tree 内的子目录列出时，父目录的规则仍然适用；路径相对子目录。
				// A directory inside the work tree applies its parents' rules.
				assert.deepEqual((await listed(env, "sub")).entries, ["f .gitignore", "f keep.txt"]);
				// gitignore: false 关闭所有 ignore 规则，但仍不列出 .git，也不绕过 exclude 参数。
				const all = (await listed(env, ".", { gitignore: false })).entries;
				assert.ok(
					all.includes("f out/x.js") && all.includes("f node_modules/m/i.js") && all.includes("f keep.txt"),
				);
				// 关闭 gitignore 后，被忽略的 out/x.js、node_modules/m/i.js 和根 keep.txt 都应出现；
				// .git 目录及其内容无论如何都不出现在结果中。
				assert.ok(!all.some((entry) => entry.includes(".git/") || entry === "d .git"));
			}),

			// 边界：maxEntries 截断时 truncated=true；恰好等于条目数时不截断。
			// maxBytes 按每个条目的 UTF-8 路径长度 + 2 计算；6 字节只能容纳 a、b 两个条目。
			// maxEntries=0 返回空列表但 truncated=true；负数/小数时间等非法参数返回 invalid。
			createCase("listFiles stops at its bounds and reports truncated", async (env) => {
				await writeAll(env, ["a", "b", "c"]);
				assert.deepEqual(await listed(env, ".", { maxEntries: 2 }), { entries: ["f a", "f b"], truncated: true });
				assert.deepEqual(await listed(env, ".", { maxEntries: 3 }), {
					entries: ["f a", "f b", "f c"],
					truncated: false,
				});
				// 每个条目的字节成本是路径 UTF-8 长度加 2（见 ListFilesOptions.maxBytes 文档）。
				// Each entry counts its path plus two bytes.
				assert.deepEqual(await listed(env, ".", { maxBytes: 6 }), { entries: ["f a", "f b"], truncated: true });
				assert.deepEqual(await listed(env, ".", { maxEntries: 0 }), { entries: [], truncated: true });
				assert.strictEqual(errorCode(await env.listFiles!(".", { maxEntries: -1 }, context)), "invalid");
				assert.strictEqual(errorCode(await env.listFiles!(".", { timeoutMs: 1.5 }, context)), "invalid");
			}),

			// listFiles 的失败分类：缺失 not_found、文件 not_directory、取消 aborted。
			createCase("listFiles fails on missing directories, files, and aborts", async (env) => {
				getOrThrow(await env.writeFile("file.txt", "", context));
				assert.strictEqual(errorCode(await env.listFiles!("missing", undefined, context)), "not_found");
				assert.strictEqual(errorCode(await env.listFiles!("file.txt", undefined, context)), "not_directory");
				assert.strictEqual(errorCode(await env.listFiles!(".", undefined, abortedContext())), "aborted");
			}),
		);
	}

	// 符号链接 + listFiles：只有当环境声明支持符号链接时才注册。
	if (symlinks && options.listFiles) {
		cases.push(
			// 链接以 l 类型列出且不跟随；悬空链接也列出；目录内的 loop 链接指向 .. 也不展开。
			// 对链接目录本身调用 listFiles 时，列出它的内容（entry 仍以 l 报告 loop）。
			createCase("listFiles lists symbolic links without following them", async (env) => {
				getOrThrow(await env.writeFile("dir/inner.txt", "", context));
				const linked = await env.exec(
					[...shell, "ln -s dir link && ln -s missing dangling && ln -s .. dir/loop"],
					undefined,
					context,
				);
				assert.strictEqual(getOrThrow(linked).exitCode, 0);
				assert.deepEqual((await listed(env, ".")).entries, [
					"l dangling",
					"d dir",
					"f dir/inner.txt",
					"l dir/loop",
					"l link",
				]);
				// The listed directory itself may be a link.
				assert.deepEqual((await listed(env, "link")).entries, ["f inner.txt", "l loop"]);
			}),
		);
	}

	// 符号链接 + BinaryReader：验证默认跟随、noFollow 拒绝最后一段、以及中间目录链接仍被解析。
	if (symlinks) {
		cases.push(
			// 默认 openBinaryReader 跟随 link.txt；noFollow 只拒绝最终路径组件是链接的情况，
			// 因此 dirlink/inner.txt 仍可打开（dirlink 是中间组件）。
			createCase("binary reader follows symlinks unless noFollow refuses the final one", async (env) => {
				getOrThrow(await env.writeFile("target.txt", "target", context));
				getOrThrow(await env.createDir("sub", undefined, context));
				getOrThrow(await env.writeFile("sub/inner.txt", "inner", context));
				const linked = await env.exec(
					[...shell, "ln -s target.txt link.txt && ln -s sub dirlink"],
					undefined,
					context,
				);
				assert.strictEqual(getOrThrow(linked).exitCode, 0);

				const followed = getOrThrow(await env.openBinaryReader("link.txt", undefined, context));
				assert.strictEqual(decoder.decode(getOrThrow(await followed.read(0, 10, context))), "target");
				await followed.close(context);

				assert.strictEqual(
					errorCode(await env.openBinaryReader("link.txt", { noFollow: true }, context)),
					"invalid",
				);

				// Only the final component is refused; earlier symlinked directories still resolve.
				const inner = getOrThrow(await env.openBinaryReader("dirlink/inner.txt", { noFollow: true }, context));
				assert.strictEqual(decoder.decode(getOrThrow(await inner.read(0, 10, context))), "inner");
				await inner.close(context);
			}),

			// watch 符号链接目标：watch 的是 config/AGENTS.md（链接），实际写 data/real.md，
			// watcher 应把目标文件的变化报告为被 watch 路径的变化。
			watchCase("watch reports changes to the file a watched symbolic link points to", async (env) => {
				getOrThrow(await env.writeFile("data/real.md", "one", context));
				getOrThrow(await env.createDir("config", undefined, context));
				const linked = await env.exec([...shell, "ln -s ../data/real.md config/AGENTS.md"], undefined, context);
				assert.strictEqual(getOrThrow(linked).exitCode, 0);
				await watching(env, [{ path: "config/AGENTS.md" }], async ({ expectChange }) => {
					await expectChange("config/AGENTS.md", async () => {
						getOrThrow(await env.writeFile("data/real.md", "two!", context));
					});
				});
			}),
		);
	}

	return cases;
}
