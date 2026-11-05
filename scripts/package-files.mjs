// 文件导读
// 所属：仓库根 scripts/，是各包 package.json 构建脚本复用的跨平台文件操作小工具（不是 npm 库）。
// 作用：把 clean / copy / executable 三种重复动作集中到一个 Node 脚本，避免依赖 shell 的 rm/cp/chmod，
// 从而在 Windows、macOS、Linux 上行为一致。
// 上游：packages/*/package.json 的 clean、build:offline、copy-assets 等 npm script，例如
//   "clean": "node ../../scripts/package-files.mjs clean dist"
//   "copy-assets": "node scripts/package-files.mjs copy \"src/**/*.json\" dist/..."
// 下游：node:fs 的 rmSync/cpSync/globSync/chmodSync/statSync 与 node:path。
// 能力清单（按第一个位置参数选择）：
//   clean <paths...>                 递归删除给定路径，路径不存在也不报错。
//   copy <sources...> <directory>   展开 glob（globSync），按 basename 复制到目标目录，可覆盖同名文件。
//   executable <files...>           给文件追加可执行位（0o111），保留原有权限。
// 输入/输出：参数来自 process.argv；成功无 stdout，失败靠未捕获异常让 Node 以退出码 1 结束。
// 副作用：clean 删除文件/目录；copy 创建目标目录并写文件；executable 修改文件模式。
// 幂等性：三者都可重复运行；copy 是覆盖而非合并，clean 对缺失路径是 no-op。
// 示例（真实命令行）：
//   node scripts/package-files.mjs clean dist
//   node scripts/package-files.mjs copy "src/modes/interactive/theme/*.json" dist/modes/interactive/theme
//   node scripts/package-files.mjs executable dist/cli.js dist/rpc-entry.js
// 阅读顺序：先看参数解析和 usage，再看 switch 的三个分支。
// Cross-platform file operations for package build scripts, using only Node built-ins.
import { chmodSync, cpSync, globSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

// 取第一个参数作为命令，其余作为路径；slice(2) 跳过 node 可执行文件与脚本路径。
const [command, ...paths] = process.argv.slice(2);
// 统一的用法错误文本；缺少参数和未知命令都复用它。
const usage = "Usage: package-files.mjs clean <paths...> | copy <sources...> <directory> | executable <files...>";

// clean/executable 至少需要一个路径，copy 至少需要来源加目标；这里统一先挡掉空参数。
if (paths.length === 0) throw new Error(usage);

// 按命令分派；每个分支都在失败时直接抛异常，由 Node 打印栈并以非零码退出。
switch (command) {
	// 递归删除多个路径；force 让不存在的路径静默跳过，因此 clean 可以重复执行。
	case "clean":
		for (const path of paths) rmSync(path, { recursive: true, force: true });
		break;
	// copy 把最后一个参数当目标目录，其余参数当 glob 模式。
	case "copy": {
		// pop 会修改 paths，取出的是目标目录；随后 paths 只剩来源模式。
		const destination = paths.pop();
		// 只有目标没有来源，或目标为空时，参数不完整。
		if (!destination || paths.length === 0) throw new Error(usage);
		// 目标目录按需创建，已存在时递归创建不会清空里面原有文件。
		mkdirSync(destination, { recursive: true });
		// 每个模式单独展开；Node 的 globSync 返回相对当前工作目录的匹配路径。
		for (const pattern of paths) {
			// 展开该模式；注意模式本身由调用方加引号，避免 shell 先行展开。
			const sources = globSync(pattern);
			// 一个都没匹配到通常意味着打包漏文件，直接失败比静默生成残缺包更安全。
			if (sources.length === 0) throw new Error(`No files match ${pattern}`);
			// 逐个复制；basename 去掉来源目录，因此不同目录的同名文件会在目标处互相覆盖。
			for (const source of sources) cpSync(source, join(destination, basename(source)), { recursive: true });
		}
		break;
	}
	// executable 给每个文件追加用户/组/其他人的执行位；|= 不会清掉原有读写位。
	case "executable":
		for (const path of paths) chmodSync(path, statSync(path).mode | 0o111);
		break;
	// 未识别命令与参数缺失使用同一份 usage 文本。
	default:
		throw new Error(usage);
}
