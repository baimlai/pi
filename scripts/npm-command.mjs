// 文件导读
// 所属：仓库根 scripts/，是整个发布/打包脚本共用的一行 npm 启动适配器，不是独立命令行程序。
// 作用：在 Unix 上直接执行 PATH 里的 npm；在 Windows 上 npm 往往只是 .cmd 包装，
// execFileSync("npm", ...) 可能找不到可执行文件，因此改为用当前 Node 进程执行 npm 的 JS 入口。
// 上游调用方：package-artifacts.mjs、local-release.mjs、pack-packages.mjs、preview-packages.mjs、
// publish.mjs、use-local-packages 相关脚本及测试；本文件不读取业务环境变量，只读取 Windows 的 npm_execpath。
// 下游：node:child_process.execFileSync，同步等待子进程结束并把结果/异常交回调用方。
// 能力清单：
//   execNpmSync(args, options) - 同步运行 npm 子命令；返回 execFileSync 的结果，失败时抛异常。
// 典型调用顺序：调用方先拼好参数数组，例如 ["install", "--ignore-scripts"]，再把 cwd/stdio 等
// execFileSync 选项原样传入。函数本身不会写文件、不会重试，也不会把退出码改成布尔值。
// 示例：
//   execNpmSync(["run", "build"], { cwd: repoRoot, stdio: "inherit" });
//   在 Unix 等价于执行 `npm run build`；失败时 execFileSync 抛出带 status/stdout/stderr 的错误。
// 阅读顺序：先看 execNpmSync 的 Windows 分支，再回到调用方了解选项如何被转发。
import { execFileSync } from "node:child_process";
// existsSync 只判断路径是否存在；这里用来提前给出比“ENOENT”更清楚的错误。
import { existsSync } from "node:fs";

/**
 * 同步执行 npm 子命令，跨平台返回子进程结果。
 * 输入：args 是传给 npm 的参数数组（不含 "npm" 本身）；options 是 execFileSync 的选项。
 * 输出：execFileSync 的返回值；若 encoding 为 "utf8" 则是字符串，否则是 Buffer。
 * 副作用：启动一个子进程，可能安装依赖、构建或发布；由 args 决定。
 * 错误：子进程非零退出、被信号终止或 spawn 失败时抛异常；Windows 缺少 npm_execpath 时抛 Error。
 * 例：execNpmSync(["view", "@earendil-works/pi-ai", "version"], { encoding: "utf8" }) 返回版本字符串。
 * 真实运行时行为：不会把 stdout 打印出来，需要调用方设置 stdio: "inherit" 或自行转发。
 */
export function execNpmSync(args, options = {}) {
	// 非 Windows 平台 npm 是可执行文件，直接交给 execFileSync；参数数组避免 shell 拼接。
	if (process.platform !== "win32") return execFileSync("npm", args, options);
	// Windows：npm 由 npm.cmd 提供，直接 spawn 可能失败；npm_execpath 是 npm 自己注入的 JS 入口路径。
	const npmCli = process.env.npm_execpath;
	// 只有通过 npm script 启动时才保证有这个变量；缺失说明用户直接 node 运行了脚本。
	if (!npmCli) throw new Error("Cannot locate npm on Windows. Run this command through its npm script.");
	// 变量存在也可能指向已删除的临时文件，提前检查让错误信息更具体。
	if (!existsSync(npmCli)) throw new Error(`Cannot locate the npm CLI: ${npmCli}`);
	// 用当前 Node 解释器执行 npm-cli.js，再把剩余参数原样传入；Node 路径不受 PATH 影响。
	return execFileSync(process.execPath, [npmCli, ...args], options);
}
