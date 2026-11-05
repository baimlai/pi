// 为npm run check选择原生Biome或WASM逐文件检查；--write会修复/格式化文件，检查不通过仍可能已有写入。这里是ESM JavaScript，解构/展开/闭包等语法也用于TypeScript。
// Runs `biome check --error-on-warnings` for the biome.json in the current directory.
// Native Biome has no Android (Termux) binary. There, fall back to Biome's
// Node WASM bindings, which check one file at a time.
// Usage: node scripts/biome-check.mjs [--write]
// execFileSync用于Git文件清单，spawnSync用于原生CLI；两者都同步等待子进程结果。
import { execFileSync, spawnSync } from "node:child_process";
// 读真实配置/文件，只有传--write且结果不同才覆盖源码；未自动备份或回滚前面已写文件。
import { readFileSync, writeFileSync } from "node:fs";
// ESM里用createRequire取得require.resolve能力，仅解析Biome CLI路径，不用动态import。
import { createRequire } from "node:module";
// matchesGlob按Node路径glob规则匹配，posix.normalize规范化POSIX插件路径，例如去掉./；不把反斜杠转成/。
import { matchesGlob, posix } from "node:path";
// 静态导入WASM绑定，原生分支也先完成模块导入；main/MemoryFileSystem/Workspace仅在下面fallback中显式调用。
import { MemoryFileSystem, main, Workspace } from "@biomejs/wasm-nodejs";

// 命令行只检查是否含--write，未知参数在此不拒绝，也不另传给Biome；const布尔值决定是否写文件。
const write = process.argv.includes("--write");

// Same platform table as @biomejs/biome/bin/biome.
// 这张系统/架构表决定尝试原生CLI，不实际探测二进制是否已安装；原生启动失败也不会自动再走WASM。
const hasNativeBinary = ["win32", "darwin", "linux"].includes(process.platform) && ["x64", "arm64"].includes(process.arch);

// 本机命中表就进入原生路径，Android等其他组合走下面fallback。
if (hasNativeBinary) {
	// 以本脚本位置解析已装Biome的Node启动器；得到路径不等于已运行检查。
	const biomeBin = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
	// 参数数组请求check和warnings视为错误，按write条件展开--write，.仍指调用者当前目录。
	const args = ["check", "--error-on-warnings", ...(write ? ["--write"] : []), "."];
	// 用当前Node执行Biome启动器并等退出，stdio继承显示完整输出；启动器优先BIOME_BINARY，否则按平台/架构及Linux musl选择二进制。
	const result = spawnSync(process.execPath, [biomeBin, ...args], { stdio: "inherit" });
	// 如进程无法启动/同步调用出错就原样throw，不当成检查零错误。
	if (result.error) throw result.error;
	// 复用CLI退出码，status为null时兜底1；立即exit保证不继续执行WASM路径。
	process.exit(result.status ?? 1);
}

// The WASM API has no CLI file scanner. Git supplies tracked and untracked
// files while respecting .gitignore; biome.json supplies the include patterns.
// A negated pattern also excludes everything below a matching directory.
// fallback从cwd读biome.json并JSON.parse；配置不在脚本目录自动搜索，坏配置直接抛。
const configuration = JSON.parse(readFileSync("biome.json", "utf8"));
// ?.容许没files字段，??仅在includes为空值时用["**"]；显式空数组则不包含任何文件。
const patterns = configuration.files?.includes ?? ["**"];
// Git列已跟踪与未跟踪且未忽略路径，不递归node_modules自行扫盘；已跟踪文件即使后来被.gitignore匹配仍可能在清单里。
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
	// 指定UTF-8得到字符串而非Buffer，文件名边界仍依赖下面的NUL分隔。
	encoding: "utf8",
})
	// 用NUL拆路径，文件名里的换行不会被误当多条记录。
	.split("\0")
	// Boolean过滤最后的空项，不在此去重或确认每个文件仍存在。
	.filter(Boolean)
	// 对每个路径执行有顺序的include/exclude判定；这个箭头回调返回boolean而不是改文件。
	.filter((path) => {
		// 初始不包含，必须先命中正模式，后面模式还可改变状态。
		let included = false;
		// 按配置顺序走全部模式，没有命中后立刻break。
		for (const pattern of patterns) {
			// 感叹号前缀表示排除，多个!也进入同一分支，不在此实现Biome所有ignore语义的通用解析。
			if (pattern.startsWith("!")) {
				// 正则移掉开头全部!，余下作为glob交Node匹配。
				const glob = pattern.replace(/^!+/, "");
				// 既匹配路径本身也匹配目录后代就排除；不是仅排除目录这一条名字。
				if (matchesGlob(path, glob) || matchesGlob(path, `${glob}/**`)) included = false;
			// 正模式命中则可重新设为包含，甚至覆盖先前排除，因此模式次序有意义。
			} else if (matchesGlob(path, pattern)) {
				// 把当前路径的included状态设真，不修改配置数组。
				included = true;
			}
		}
		// 最终状态决定filter保留/丢弃路径，不会在筛选阶段执行lint。
		return included;
	});

// The WASM workspace cannot read the disk. GritQL plugins referenced by
// biome.json must be preloaded into its in-memory file system, keyed by the
// configured path relative to the project ("./a.grit" becomes "a.grit").
// 调用WASM包提供的main初始化入口；它不是启动这个JS文件本身，也没有自动把磁盘文件全部扫入。
main();
// 新建WASM可读取的内存文件系统，插件内容随后手动插入。
const fileSystem = new MemoryFileSystem();
// 没plugins时按空数组处理；for...of逐份预加载，不自动下载插件。
for (const plugin of configuration.plugins ?? []) {
	// 内存键把./a.grit规范化为a.grit，内容仍从原配置路径读字节；posix规则独立于本机平台。
	fileSystem.insert(posix.normalize(plugin), readFileSync(plugin));
}
// 让workspace使用已准备的内存FS，后续文件内容通过openFile提供。
const workspace = Workspace.withFileSystem(fileSystem);
// 打开cwd对应项目并允许未初始化项目，解构取projectKey用于后续API调用。
const { projectKey } = workspace.openProject({ path: process.cwd(), openUninitialized: true });
// 把完整配置交workspace，workspaceDirectory设./；没有在此自动验证所有文件能成功格式化。
workspace.updateSettings({ projectKey, configuration, workspaceDirectory: "./" });

// 在workspace临时打开path/content→同步执行run→finally关闭，返回run的原值或抛错。例检查一个TS字符串；只管理内存打开状态，不写磁盘。当前回调都同步，若传Promise也不会等待其结束才close。
function withFile(path, content, run) {
	// 内容以fromClient提交、version为0；openFile位于try前，若打开本身抛错不会进入后面的finally。
	workspace.openFile({ projectKey, path, content: { type: "fromClient", content, version: 0 } });
	// try只包回调部分，确保正常返回或同步throw都进finally。
	try {
		// 直接调用并返回结果，不await、不复制、不自动捕获业务异常。
		return run();
	// finally在return/throw之前清理，清理本身抛错也可能覆盖原结果。
	} finally {
		// 关闭这一文件的workspace状态，不删除磁盘文件或关闭整个项目。
		workspace.closeFile({ projectKey, path });
	}
}

// 计数的是未跳过诊断及只读格式差异次数，不是失败文件数或测试数量。
let failures = 0;
// 只统计完成本轮处理的文件，后续异常中断时不会把它算完成。
let checked = 0;
// 循环外try保证进入循环后不管成功/抛错都free workspace；前面的初始化/配置抛错不在这段finally内。
try {
	// 逐文件串行处理，不因为workspace API是WASM就自动多线程并行。
	for (const path of files) {
		// 把磁盘原始UTF-8内容保在original用于比较，读取失败直接抛，未跳过已删除/不可读路径。
		const original = readFileSync(path, "utf8");
		// 三元表达式决定先修复还是保持原文；结果fixed仍只是内存字符串，此处尚不写盘。
		const fixed = write
			// 写模式先临时打开原文跑safeFixes，再由withFile关闭；只读模式完全不调用这一步。
			? withFile(
					// 本轮相同path作为workspace文件键。
					path,
					// 修复输入是磁盘原始内容，不是上一次文件的结果。
					original,
					// 零参箭头延后执行，必须在withFile打开文件后才调用fixFile。
					() =>
						// 使用真实WASM修复API，返回含code的新结果；不把“safe”当额外承诺所有项目行为一定未变。
						workspace.fixFile({
							// 指定当前项目键。
							projectKey,
							// 指定已打开的目标文件键。
							path,
							// 只允许Biome标为安全的修复，不加不安全修复/自动压制选项。
							fixFileMode: "safeFixes",
							// 这一步不格式化，下面会独立检查语法后再格式化。
							shouldFormat: false,
							// 修复分类为语法/lint/action，未在此请求所有可能的规则种类。
							ruleCategories: ["syntax", "lint", "action"],
						// 只取fixFile结果中的code文本，不把修复动作或错误计数作为最终诊断。
						}).code,
				)
			// 不写模式直接复用original，后面仍会算格式结果来比较。
			: original;
		// 再次打开fixed文本执行诊断与格式化，解构取回两个结果，不会在函数名相同处复用前次已关闭文件状态。
		const { diagnostics, formatted } = withFile(path, fixed, () => {
			// 收集syntax/lint/action诊断，API返回diagnostics数组和其他统计，这里只取数组。
			const { diagnostics } = workspace.pullDiagnostics({
				// 当前项目键。
				projectKey,
				// 当前文件路径。
				path,
				// 三类诊断一起取，返回的信息不等同tsc类型检查。
				categories: ["syntax", "lint", "action"],
				// 不请求诊断附带修复/压制的代码框，避免多余code-action内容。
				pullCodeActions: false,
			});
			// Like the CLI with formatWithErrors: false, skip formatting files with syntax errors.
			// 另查syntax分类并取errors数量，用于决定能否安全进入格式化，不用“所有lint都通过”作前提。
			const syntax = workspace.pullDiagnostics({ projectKey, path, categories: ["syntax"], pullCodeActions: false });
			// 语法错误数为0才formatFile取code，否则保留fixed；不在此解析错误严重程度以外的全部语法状态。
			const formatted = syntax.errors === 0 ? workspace.formatFile({ projectKey, path }).code : fixed;
			// 同名属性简写返回diagnostics与formatted，交外层统一输出/写盘。
			return { diagnostics, formatted };
		});
		// 仅write且最终文本变化才写真实磁盘；之后仍可能有诊断失败，没有事务回滚前面已写文件。
		if (write && formatted !== original) writeFileSync(path, formatted);
		// 遍历诊断数组逐条输出，单文件可能产生多项failures。
		for (const diagnostic of diagnostics) {
			// 只忽略severity严格hint，其余级别原则上都计失败，除下面那一个明确配置版本例外。
			if (diagnostic.severity === "hint") continue;
			// Biome's WASM build reports its version as 0.0.0. Keep the real
			// schema URL for editors, but ignore only this spurious mismatch.
			// 下面三条件必须同时满足才忽略WASM自报0.0.0造成的特定schema版本误报。
			if (
				// 路径必须严格biome.json，不是任意含这个名字的其他文件。
				path === "biome.json" &&
				// 分类必须deserialize，别的lint/语法消息不会因此忽略。
				diagnostic.category === "deserialize" &&
				// 描述必须与固定版本误报文字完全相同，不跳过其他配置问题。
				diagnostic.description === "The configuration schema version does not match the CLI version 0.0.0"
			)
				// 命中特例就继续下条诊断，既不输出也不加失败数。
				continue;
			// 诊断写stderr，??仅让缺category显示空串；没有在此对正文脱敏或渲染复杂代码框。
			console.error(`${path}: ${diagnostic.severity} ${diagnostic.category ?? ""}: ${diagnostic.description}`);
			// 每条未忽略诊断加一，warnings也不能静默通过。
			failures++;
		}
		// 只读模式中格式结果和原文不同时额外算失败，即使没有lint诊断；写模式已处理格式差异而不计此项。
		if (!write && formatted !== original) {
			// 告诉使用者加--write，当前只读执行本身不会为他改文件。
			console.error(`${path}: formatting differs (run with --write)`);
			// 一次格式不一致也加一，和同文件已有诊断可以重复累计为不同问题。
			failures++;
		}
		// 该文件完整处理结束才增加checked。
		checked++;
	}
// finally用于释放循环使用的WASM资源，不吞掉上面异常。
} finally {
	// 释放workspace内存资源，不代表回滚磁盘修复，也不是删除所有扫描文件。
	workspace.free();
}
// 正常走完整批才显示WASM汇总，数字分别是完成文件数和问题次数，不是测试通过数。
console.log(`Biome WASM: checked ${checked} files; ${failures} diagnostics.`);
// 有问题设置exitCode=1让Node自然退出；无问题保默认成功，和前面原生分支的立即process.exit不同。
if (failures > 0) process.exitCode = 1;
