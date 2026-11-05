// 统一识别运行/安装方式并解析更新命令、随包资源和用户配置路径；CLI、SDK、工具都从这里取路径，避免依赖当前源码布局。
// 同步文件 API 用于探测路径、读取包信息和检查写权限；调用时可能抛出系统错误。
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "fs";
// createRequire 为 ESM 模块提供包解析入口，后面只用其 resolve 定位 wasm。
import { createRequire } from "module";
// homedir 返回系统用户主目录，用于默认配置和 Bun 全局目录。
import { homedir } from "os";
// 导入路径拆分/拼接/绝对化 API；win32 可在非 Windows 主机按 Windows 规则解析路径。
import { basename, dirname, join, resolve, sep, win32 } from "path";
// 将 ESM 的 file: URL 转成平台文件路径。
import { fileURLToPath } from "url";
// 统一子进程入口兼容平台差异，这里用于查询包管理器输出。
import { spawnProcessSync } from "./utils/child-process.ts";
// 统一处理波浪号、file URL 和 Windows shell 路径等输入形式。
import { normalizePath } from "./utils/paths.ts";
// JSON 解析前移除可选 UTF-8 BOM，避免 JSON.parse 因文件前缀失败。
import { stripBom } from "./utils/text.ts";

// =============================================================================
// Package Detection
// =============================================================================

// import.meta.url 是当前模块 URL；转为路径后才可用 Node 路径 API。
const __filename = fileURLToPath(import.meta.url);
// ESM 没有内置 __dirname，这里由当前文件路径显式计算；其他 coding-agent 模块应使用本文件导出的资源助手。
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
// 导出 Bun 编译产物标记，供所有资源路径函数选择布局。
export const isBunBinary =
	// 通过 Bun 虚拟文件系统 URL 的几种特征判断；这是运行环境启发式识别。
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
// !! 把版本字符串存在与否转成 boolean；bun run 也会为 true，不仅限编译后二进制。
export const isBunRuntime = !!process.versions.bun;

/** Detect the esbuild-bundled Node.js distribution. */
// declare 只告知 TS 构建器可能注入此常量，不会生成 JS 变量定义。
declare const PI_BUNDLED_NODE: boolean;
// typeof 可安全检查尚未定义的构建常量，只有存在且为 true 才识别为 Node bundle。
export const isBundledNode = typeof PI_BUNDLED_NODE !== "undefined" && PI_BUNDLED_NODE;

// =============================================================================
// Install Method Detection
// =============================================================================

// 字符串字面量联合类型约束识别结果；unknown 代表路径特征不足。
export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

// 单步更新的结构：真正执行使用 command/args，display 仅用于展示。
interface SelfUpdateCommandStep {
	// 可执行程序名或路径，例如 npm。
	command: string;
	// 每个数组项是独立 argv 参数，空格不会在这里被 shell 再拆分。
	args: string[];
	// 供用户阅读的命令行文本，不承担通用 shell 转义保证。
	display: string;
}

// 在单步结构上扩展可选多步骤，用于包名迁移时先卸载再安装。
export interface SelfUpdateCommand extends SelfUpdateCommandStep {
	// 有 steps 时执行层应按顺序执行；此处只是数据声明。
	steps?: SelfUpdateCommandStep[];
}

// 目标既可用单个包名字串，也可把逻辑包名和安装版本规格分开，例如 { packageName:'p', installSpec:'p@1.2.3' }。
export type SelfUpdatePackageTarget = string | { packageName: string; installSpec?: string };

// 统一更新目标形状。输入字符串或目标对象；返回必填包名与安装规格，无副作用。
// 字符串同时作两字段；对象缺少 installSpec 时用 packageName。例如 p 变成 {packageName:p,installSpec:p}。
function normalizeSelfUpdatePackageTarget(target: SelfUpdatePackageTarget): {
	// 返回的逻辑包名用于判断是否迁移包名。
	packageName: string;
	// 返回的安装规格直接作为包管理器 argv，例如 p@1.2.3。
	installSpec: string;
	// 花括号结束返回对象类型，后面的函数体开始实际运行。
} {
	// typeof 区分输入联合类型中的字符串分支。
	if (typeof target === "string") {
		// 字符串输入两字段取同一值，不解析其中版本号。
		return { packageName: target, installSpec: target };
	}
	// 对象输入保留包名，?? 只在规格缺失时回退；空字符串不会被替换。
	return { packageName: target.packageName, installSpec: target.installSpec ?? target.packageName };
}

// 组装更新计划。输入安装步和可选卸载步，返回命令对象，不执行包管理器。
// 无卸载直接返回安装步；有卸载时保留两步顺序，例如旧包 A 改成 B 时 display 展示 A 卸载后安装 B。
function makeSelfUpdateCommand(
	// 安装步骤是必选的实际目标操作。
	installStep: SelfUpdateCommandStep,
	// 只有包名迁移等情况才需要先卸载旧包。
	uninstallStep?: SelfUpdateCommandStep,
	// 返回类型兼容单步及带 steps 的多步计划。
): SelfUpdateCommand {
	// 无需卸载就复用原安装对象，不额外复制。
	if (!uninstallStep) return installStep;
	// 需要多步时创建新对象，避免修改传入步骤。
	return {
		// 对象展开保留安装 command/args 等顶层字段。
		...installStep,
		// 仅为展示把两条文本用 && 连接；实际执行仍可使用 steps。
		display: `${uninstallStep.display} && ${installStep.display}`,
		// 先卸载再安装；失败处理由执行层决定。
		steps: [uninstallStep, installStep],
	};
}

// 构造一条命令记录。输入可执行程序及 argv；返回数据，不执行命令，也不改参数数组。
// 展示时为含空白的项包双引号，例如路径含空格；该 display 不是完整 shell 转义器。
function makeSelfUpdateCommandStep(command: string, args: string[]): SelfUpdateCommandStep {
	// 返回同时含机器可执行字段和人类展示字段的对象。
	return {
		// 属性简写保存程序名。
		command,
		// 保存 argv 数组引用。
		args,
		// map 对展示项加可读引号，再 join 成空格分隔文本；真实参数仍使用 args 数组。
		display: [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
	};
}

// 识别当前安装方式。无输入，返回 InstallMethod；读取运行时标记和路径，不查询包管理器。
// 先二进制，再按 pnpm/yarn/bun/npm 路径特征匹配，例如含 /.pnpm/ 会返回 pnpm；这还不足以确认全局安装归属。
export function detectInstallMethod(): InstallMethod {
	// Bun 编译产物优先，不能按 node_modules 路径误判。
	if (isBunBinary) {
		// 返回独立二进制安装类别。
		return "bun-binary";
	}

	// 把模块目录与运行时路径用零字符隔开、统一小写和斜线，便于跨平台匹配。
	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

	// pnpm 路径先于宽泛 node_modules 特征判断。
	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
		// 识别为 pnpm 安装布局。
		return "pnpm";
	}
	// 检测 yarn 常见安装目录。
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
		// 识别为 yarn。
		return "yarn";
	}
	// Bun 运行时或 Bun 全局 node_modules 布局使用 bun 方式。
	if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
		// 识别为 Bun 包管理器安装。
		return "bun";
	}
	// 最后才匹配 npm 或一般 node_modules 路径，因此该分支是较宽泛的推断。
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
		// 返回 npm 类别，还需后续归属检查才允许自动更新。
		return "npm";
	}

	// 没有足够特征时不猜安装器。
	return "unknown";
}

// 从 Unix 风格全局 npm 布局推导 root/prefix。无输入，返回候选或 undefined，只读路径。
// 支持有/无 scope 包；例如 /usr/lib/node_modules/@scope/p 的 root 是 node_modules，prefix 是 /usr。Windows 仅凭路径不能证明是全局安装。
function getInferredNpmInstall(): { root: string; prefix: string } | undefined {
	// 取得实际包根，兼容源码、npm 包和指定环境变量。
	const packageDir = getPackageDir();
	// Windows 平台或带反斜线的模拟路径使用 win32 拆分规则。
	const path = process.platform === "win32" || packageDir.includes("\\") ? win32 : { basename, dirname };
	// 取包目录父级，有 scope 时该级为 @scope。
	const parent = path.dirname(packageDir);
	// 暂存可选的 node_modules 根路径。
	let root: string | undefined;
	// 有 scope 且上一级为 node_modules，匹配 scoped npm 包布局。
	if (path.basename(parent).startsWith("@") && path.basename(path.dirname(parent)) === "node_modules") {
		// 跳过 @scope，取 node_modules 目录。
		root = path.dirname(parent);
		// 无 scope 的包直接位于 node_modules 下。
	} else if (path.basename(parent) === "node_modules") {
		// 把包父级视为 root。
		root = parent;
	}
	// 不是上述布局就无法推导。
	if (!root) return undefined;
	// 继续看 node_modules 的上一层。
	const rootParent = path.dirname(root);
	// 只接受 lib/node_modules 这种全局形状，把 lib 的父级作为 prefix。
	if (path.basename(rootParent) === "lib") return { root, prefix: path.dirname(rootParent) };
	// Windows global npm prefixes use `<prefix>\\node_modules`, which is
	// indistinguishable from local project installs by path shape alone. Do not
	// infer unsupported Windows custom prefixes without `npm root -g` evidence.
	// 其他布局不推断全局前缀，交给显式 npm root -g 等证据。
	return undefined;
}

// 按安装方式生成更新命令数据。输入安装器、当前包、可选目标/命令覆盖；返回计划或 undefined，不执行安装。
// 查询全局路径可能同步启动只读包管理器命令；各计划禁用安装脚本，包名改变时先卸载旧包。例如 npm 的目标规格可为 p@版本。
function getSelfUpdateCommandForMethod(
	// 分支选择依据已经识别的安装方式。
	method: InstallMethod,
	// 当前安装包名用于决定是否卸载旧包。
	installedPackageName: string,
	// 默认更新当前同名包，调用者可指定版本规格或新包名。
	updatePackageTarget: SelfUpdatePackageTarget = installedPackageName,
	// 可覆盖 npm 可执行程序与前置参数，例如自定义包装器。
	npmCommand?: string[],
	// 二进制与未知方式没有包管理器更新计划。
): SelfUpdateCommand | undefined {
	// 先把简写目标补成完整包名/规格对象。
	const target = normalizeSelfUpdatePackageTarget(updatePackageTarget);
	// switch 按字面量联合类型分流，各分支最终返回计划。
	switch (method) {
		// Bun 独立二进制不是 Bun 全局 npm 包。
		case "bun-binary":
			// 本函数不为二进制拼安装命令。
			return undefined;
		// pnpm 分支有局部花括号，隔离 match/binDirArgs 变量作用域。
		case "pnpm": {
			// 先尝试查询 pnpm 全局 root，命令成功有输出时无需路径回退。
			const match = readCommandOutput("pnpm", ["root", "-g"])
				? // 有全局查询证据就不使用下面的路径推断。
					undefined
				: // 查询失败时，从当前 .pnpm 全局路径抓取 global/版本目录。
					/^(.*[\\/]global[\\/][^\\/]+)[\\/]\.pnpm[\\/]/.exec(getPackageDir());
			// 若匹配回退布局，需要显式给 pnpm 指定全局 bin 目录。
			const binDirArgs = match
				? // 优先 PNPM_HOME，否则从匹配路径向上两层推导 bin 目录。
					[`--config.global-bin-dir=${process.env.PNPM_HOME || dirname(dirname(match[1]))}`]
				: // 无回退匹配就不附加 bin 参数。
					[];
			// 将安装步和可选迁移卸载步组合成计划。
			return makeSelfUpdateCommand(
				// 构造 pnpm install 的 argv，下面每项都是独立参数。
				makeSelfUpdateCommandStep("pnpm", [
					// 选择安装子命令。
					"install",
					// 选择全局安装范围。
					"-g",
					// 禁止执行包的生命周期脚本。
					"--ignore-scripts",
					// 本次更新关闭 pnpm 最低发布年龄限制，以便立即安装刚发布版本。
					"--config.minimumReleaseAge=0",
					// 展开可能存在的全局 bin 目录参数。
					...binDirArgs,
					// 附上目标包名/版本规格。
					target.installSpec,
				]),
				// 比较逻辑包名，决定是否先卸载旧包。
				target.packageName === installedPackageName
					? // 同名升级无需额外卸载步骤。
						undefined
					: // 更换包名时用同一 bin 参数移除旧全局包。
						makeSelfUpdateCommandStep("pnpm", ["remove", "-g", ...binDirArgs, installedPackageName]),
			);
		}
		// Yarn 全局安装分支。
		case "yarn":
			// 组装 Yarn 更新计划。
			return makeSelfUpdateCommand(
				// 用 global add 安装目标，并禁用生命周期脚本。
				makeSelfUpdateCommandStep("yarn", ["global", "add", "--ignore-scripts", target.installSpec]),
				// 比较新旧逻辑包名。
				target.packageName === installedPackageName
					? // 同名包原地升级，无卸载步。
						undefined
					: // 包名变更先执行 global remove。
						makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]),
			);
		// Bun 包管理器全局安装分支，区别于独立二进制。
		case "bun":
			// 组装 Bun 的安装与可选卸载步骤。
			return makeSelfUpdateCommand(
				// 构造 Bun install 命令记录，不在这里运行。
				makeSelfUpdateCommandStep("bun", [
					// 选择安装操作。
					"install",
					// 作用于全局安装。
					"-g",
					// 禁止包脚本执行。
					"--ignore-scripts",
					// 关闭此更新操作的最低发布年龄限制。
					"--minimum-release-age=0",
					// 目标包安装规格作为最后参数。
					target.installSpec,
				]),
				// 新旧包名相同就不创建卸载步骤。
				target.packageName === installedPackageName
					? // undefined 表示没有前置操作。
						undefined
					: // 迁移包名时先 bun uninstall -g 旧包。
						makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]),
			);
		// npm 分支支持用户提供的包装器 argv。
		case "npm": {
			// 数组解构取首项程序名，其余为前置参数；空数组使用 npm。
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			// 提供非空自定义命令时不再猜原安装的 prefix。
			const inferred = npmCommand?.length ? undefined : getInferredNpmInstall();
			// 合并包装器参数和可选 --prefix，确保更新到推导出的同一全局根。
			const prefixArgs = [...npmArgs, ...(inferred ? ["--prefix", inferred.prefix] : [])];
			// pi.dev advertises releases immediately, so a configured npm age gate would
			// block the update. npm has no per-package age gate, so this also lets new
			// transitive dependency releases through. Managed installs avoid this.
			// 生成 npm 安装步；这里只构造数据，不触发网络下载安装。
			const installStep = makeSelfUpdateCommandStep(command, [
				// 先放包装器参数及可能存在的 prefix。
				...prefixArgs,
				// 使用 npm install。
				"install",
				// 选择全局安装。
				"-g",
				// 禁止安装脚本。
				"--ignore-scripts",
				// 关闭 npm 年龄门槛；也会允许新传递依赖，原英文注释说明了这个取舍。
				"--min-release-age=0",
				// 附上目标包版本规格。
				target.installSpec,
			]);
			// 以下三元表达式决定是否创建卸载步骤。
			const uninstallStep =
				// 逻辑包名相等表示同名升级。
				target.packageName === installedPackageName
					? // 同名升级省略卸载。
						undefined
					: // 新包名不同则用相同 npm 包装器与 prefix 卸载旧包。
						makeSelfUpdateCommandStep(command, [...prefixArgs, "uninstall", "-g", installedPackageName]);
			// 把两个步骤组合成最终数据结构。
			return makeSelfUpdateCommand(installStep, uninstallStep);
		}
		// 无法识别安装方式时不冒险猜更新命令。
		case "unknown":
			// undefined 交给上层显示人工更新说明。
			return undefined;
	}
}

// 同步查询外部命令文本。输入程序/参数和是否必须成功；返回去空白 stdout 或 undefined。
// 不成功时默认静默无结果，requireSuccess 为 true 则抛错；例如查询 npm root -g。此函数真的启动进程，会阻塞直到结束。
function readCommandOutput(
	// 要运行的可执行程序。
	command: string,
	// 独立 argv 项，不经这里的 shell 字符串拼接。
	args: string[],
	// 可选对象默认为空；requireSuccess 只改变失败处理方式。
	options: { requireSuccess?: boolean } = {},
	// 返回文本不包含首尾空白，无有效输出则 undefined。
): string | undefined {
	// 执行平台兼容的同步子进程入口。
	const result = spawnProcessSync(command, args, {
		// 把 stdout/stderr 解码成 UTF-8 字符串。
		encoding: "utf-8",
		// 忽略 stdin，捕获标准输出和错误输出。
		stdio: ["ignore", "pipe", "pipe"],
	});
	// 只有退出码 0 才返回 stdout；输出全为空白时仍视为无结果。
	if (result.status === 0) return result.stdout.trim() || undefined;
	// 需要确认成功的显式用户命令不能静默降级。
	if (options.requireSuccess) {
		// 依次取启动错误、stderr 或退出码作为原因，?? 保留数字 0 等非空值。
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		// 抛出带命令及原因的错误；此处只是显示，不再次执行拼出的字符串。
		throw new Error(`Failed to run ${[command, ...args].join(" ")}: ${reason}`);
	}
	// 一般探测失败直接返回 undefined，让上层尝试其他证据。
	return undefined;
}

// 查询全局包根候选。输入安装器、保留的包名参数及可选 npm 包装器；返回目录数组。
// 会启动只读查询命令；显式包装器失败会抛错。比如 npm 返回全局 node_modules，pnpm 还保留其父目录候选。
function getGlobalPackageRoots(method: InstallMethod, _packageName: string, npmCommand?: string[]): string[] {
	// 按安装器选择各自全局查询接口。
	switch (method) {
		// npm 或被自定义包装器覆盖的查询路径。
		case "npm": {
			// !! 将命令数组是否非空转成布尔值，表示是否由用户明确指定。
			const configured = !!npmCommand?.length;
			// 解构程序和包装器前置参数，空值默认 npm。
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			// 配置为 bun 时使用 Bun 的 bin 查询与布局，而不是假设 npm root 可用。
			if (configured && command === "bun") {
				// 同步查询 Bun 全局可执行文件目录。
				const bunBin = readCommandOutput(command, [...npmArgs, "pm", "bin", "-g"], {
					// 显式指定的命令失败必须报错，不能偷偷切换其他安装器。
					requireSuccess: true,
				});
				// 保留默认 ~/.bun/install/global/node_modules 候选。
				const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
				// 查询有结果时再添加相对该 bin 目录推导的候选。
				if (bunBin) {
					// 从 bin 的父目录补出 Bun 全局包目录布局。
					roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
				}
				// 返回全部候选，后面还会验证实际路径归属。
				return roots;
			}
			// 一般 npm/包装器使用 root -g 查包根。
			const root = readCommandOutput(command, [...npmArgs, "root", "-g"], {
				// 只有显式配置命令才要求本次查询成功。
				requireSuccess: configured,
			});
			// 默认 npm 查询可补充 lib/node_modules 布局推断；显式命令不这样猜。
			const inferred = configured ? undefined : getInferredNpmInstall();
			// 过滤不存在的可选字符串；类型谓词 x is string 让 TS 知道输出不含 undefined。
			return [root, inferred?.root].filter((x): x is string => !!x);
		}
		// pnpm 全局 root 可能存在版本子目录。
		case "pnpm": {
			// 先查询 pnpm root -g。
			const root = readCommandOutput("pnpm", ["root", "-g"]);
			// 查询成功时同时接受 root 与它的父目录为布局候选。
			if (root) return [root, dirname(root)];
			// 失败时从当前包所在 .pnpm 路径提取全局目录。
			const match = /^(.*[\\/]global[\\/][^\\/]+)[\\/]\.pnpm[\\/]/.exec(getPackageDir());
			// 匹配成功返回捕获组，否则返回空数组。
			return match ? [match[1]] : [];
		}
		// Yarn 全局目录查询。
		case "yarn": {
			// 运行 yarn global dir。
			const dir = readCommandOutput("yarn", ["global", "dir"]);
			// Yarn 返回目录本身和其 node_modules 都作为候选。
			return dir ? [dir, join(dir, "node_modules")] : [];
		}
		// Bun 全局目录查询。
		case "bun": {
			// 取得 Bun 的全局 bin 位置。
			const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
			// 先加系统主目录下的标准 Bun 全局包根。
			const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
			// 有自定义/实际 bin 位置时补另一候选。
			if (bunBin) {
				// 按 bin 布局推导对应的 install/global/node_modules。
				roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
			}
			// 返回候选，未在此声明每个路径一定存在。
			return roots;
		}
		// 独立二进制没有全局包管理根。
		case "bun-binary":
		// 未知安装也没有可靠候选。
		case "unknown":
			// 两种情况共同返回空列表。
			return [];
	}
}

// 把已存在路径规范成比较键。输入路径与是否追踪符号链接；返回字符串或 undefined，只读文件系统。
// 先绝对化/查存在，再可选 realpath，Windows 转小写。例如链接路径和真实路径可各生成一种候选。
function normalizeExistingPathForComparison(path: string, resolveSymlinks: boolean): string | undefined {
	// 将相对路径转成绝对路径，不展开此模块外额外的 shell 语义。
	const resolvedPath = resolve(path);
	// 候选不存在就不参与安装归属判断。
	if (!existsSync(resolvedPath)) {
		// 用 undefined 表示无有效比较值。
		return undefined;
	}
	// 默认先使用未解析符号链接的绝对路径。
	let normalizedPath = resolvedPath;
	// 仅在调用者要求时解析符号链接。
	if (resolveSymlinks) {
		// realpath 也可能因为并发删除或权限问题失败。
		try {
			// 将链接地址替换成真实文件系统地址。
			normalizedPath = realpathSync(resolvedPath);
			// 解析失败不继续使用可能误导归属判断的链接结果。
		} catch {
			// 返回无候选，让外层过滤。
			return undefined;
		}
	}
	// Windows 路径比较按通常不区分大小写的规则处理。
	if (process.platform === "win32") {
		// 只改变比较键，不重命名文件或目录。
		normalizedPath = normalizedPath.toLowerCase();
	}
	// 返回可供 startsWith 边界比较的规范路径。
	return normalizedPath;
}

// 为同一路径生成直接/真实两类比较候选。输入路径，返回去重数组，不修改磁盘。
// 例如符号链接可产生两个地址；Set 去重，缺失路径得到空数组。
function getPathComparisonCandidates(path: string): string[] {
	// Array.from 把 Set 可迭代结果转为普通数组。
	return Array.from(
		// Set 删除重复候选，保留插入顺序。
		new Set(
			// 分别计算不追踪和追踪链接的键，然后过滤失败项。
			[normalizeExistingPathForComparison(path, false), normalizeExistingPathForComparison(path, true)].filter(
				// 类型谓词说明保留项都是非空字符串。
				(candidate): candidate is string => !!candidate,
			),
		),
	);
}

// 从进程入口向上找最近包根。无输入，返回包含 package.json 的目录或 undefined，只做存在性检查。
// 例如入口在 package/dist/cli.js 时向上查到 package；没有 argv[1] 则无结果。
function getEntrypointPackageDir(): string | undefined {
	// Node/Bun 通常把主入口脚本放在 argv[1]。
	const entrypoint = process.argv[1];
	// 没有入口地址就停止，避免拿当前目录乱猜。
	if (!entrypoint) return undefined;
	// 从脚本所在目录开始找。
	let dir = dirname(entrypoint);
	// 父目录等于自身表示到达文件系统根，循环结束。
	while (dir !== dirname(dir)) {
		// 检查当前目录是否含包清单，不在这里读取其内容。
		if (existsSync(join(dir, "package.json"))) {
			// 返回找到的最近包根。
			return dir;
		}
		// 没找到就向上移动一层。
		dir = dirname(dir);
	}
	// 一直没有包清单则返回 undefined。
	return undefined;
}

// 检查当前安装及其父目录能否写入。无输入，返回布尔值；只做权限探测，不写文件。
// 例如普通用户无法写 /usr/lib 下的全局包，返回 false；这不是更新期间权限永远不变的保证。
function isSelfUpdatePathWritable(): boolean {
	// 探测统一入口识别的当前包目录。
	const packageDir = getPackageDir();
	// 权限检查失败通过抛错报告，因此在 try 中收敛为 boolean。
	try {
		// 包目录自身需可写，更新器可能替换内部文件。
		accessSync(packageDir, constants.W_OK);
		// 父目录也需可写，更新器可能删除/重建包目录。
		accessSync(dirname(packageDir), constants.W_OK);
		// 两个 accessSync 都成功才允许自动更新。
		return true;
		// 任何检查错误都按不可写处理。
	} catch {
		// 返回 false 供上层改为人工说明。
		return false;
	}
}

// 确认当前包由全局包管理器管理。输入安装器、包名、可选命令；返回布尔值，可运行只读全局根查询。
// 同时比较模块包根与进程入口包根，兼容链接/包装器；必须落在候选根的目录边界内才为 true。
function isManagedByGlobalPackageManager(method: InstallMethod, packageName: string, npmCommand?: string[]): boolean {
	// 收集模块与主入口两种包根，过滤未找到项；不是只凭可执行文件名判断。
	const packageDirs = [getPackageDir(), getEntrypointPackageDir()].filter((dir): dir is string => !!dir);
	// flatMap 将每个包根的直接/真实路径候选展开成一层数组。
	const packageDirCandidates = packageDirs.flatMap((dir) => getPathComparisonCandidates(dir));
	// 只要任一安装器全局根包含实际包目录即可。
	return getGlobalPackageRoots(method, packageName, npmCommand).some((root) => {
		// 全局根也生成两类路径，兼容根本身为符号链接。
		return getPathComparisonCandidates(root).some((normalizedRoot) => {
			// 补路径分隔符边界，避免 /global/a 误匹配 /global/abc。
			const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
			// 某个包目录确实位于该根下才视为归属匹配。
			return packageDirCandidates.some((packageDir) => packageDir.startsWith(rootPrefix));
		});
	});
}

// 取得可自动执行的更新计划。输入当前包、可选包装器与目标；返回计划或 undefined，不执行更新。
// 先识别并拼计划，再确认全局归属和写权限；任一条件不满足就拒绝自动计划。例如源码 checkout 通常需要人工 git/npm 操作。
export function getSelfUpdateCommand(
	// 当前安装包名。
	packageName: string,
	// 可选 npm 命令及前置 argv。
	npmCommand?: string[],
	// 缺省更新当前包，也可切换到指定版本/包名。
	updatePackageTarget: SelfUpdatePackageTarget = packageName,
	// 返回 undefined 表示这里无法安全确定自动更新方式。
): SelfUpdateCommand | undefined {
	// 先用运行环境/路径识别安装类型。
	const method = detectInstallMethod();
	// 生成该安装器的目标更新数据。
	const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageTarget, npmCommand);
	// 短路检查：没有计划、非全局归属或不可写任一成立就不提供自动更新。
	if (!command || !isManagedByGlobalPackageManager(method, packageName, npmCommand) || !isSelfUpdatePathWritable()) {
		// 让调用方转用用户配置或人工更新提示。
		return undefined;
	}
	// 仅返回已通过归属和权限探测的命令计划。
	return command;
}

/**
 * The self-update command configured by the user: `PI_SELF_UPDATE_COMMAND` (whitespace-separated
 * argv, no quoting), else the global `selfUpdateCommand` setting. Overrides install-method detection.
 */
// 读取用户明确配置的更新 argv。输入全局设置的可选数组，返回环境变量优先的数组或 undefined。
// 环境变量按空白拆分、不支持 shell 引号；例如 npm -g install {installSpec} 得到 4 项。这里只读取，不执行。
export function getConfiguredSelfUpdateArgv(setting: string[] | undefined): string[] | undefined {
	// 可选链使未设置环境变量时不调用 trim/split；filter(Boolean) 去掉空项。
	const fromEnv = process.env.PI_SELF_UPDATE_COMMAND?.trim().split(/\s+/).filter(Boolean);
	// 环境变量有非空项就覆盖设置值。
	if (fromEnv?.length) return fromEnv;
	// 设置数组非空才返回，且保留原数组引用。
	return setting?.length ? setting : undefined;
}

/** Fill the `{packageName}`, `{version}`, and `{installSpec}` placeholders of a configured self-update command. */
// 展开配置命令占位符。输入 argv 和发布包名/版本，返回命令记录，不执行、不做 shell 解析。
// 逐项替换 packageName/version/installSpec，例如 {installSpec} 变为 p@1.2.3，未识别占位符保持原样。
export function makeConfiguredSelfUpdateCommand(
	// 每个数组项已经是独立参数，空格无需在此重新拆分。
	argv: string[],
	// 发布元数据提供两个必要字符串。
	release: { packageName: string; version: string },
	// 返回单步更新命令的数据结构。
): SelfUpdateCommand {
	// Record<string,string> 表示按字符串键取字符串值的字典。
	const values: Record<string, string> = {
		// 包名占位符对应发布包名。
		packageName: release.packageName,
		// 版本占位符对应发布版本。
		version: release.version,
		// 安装规格由包名、@ 与版本组成。
		installSpec: `${release.packageName}@${release.version}`,
	};
	// map 生成新 argv，再解构第一个为程序名；输入空数组时程序名用空字符串。
	const [command = "", ...args] = argv.map((arg) =>
		// 正则全局匹配三种允许占位符；回调忽略完整匹配 _，用捕获名查字典。
		arg.replace(/\{(packageName|version|installSpec)\}/g, (_, name: string) => values[name]),
	);
	// 复用单步构造器产生 display；不启动命令。
	return makeSelfUpdateCommandStep(command, args);
}

// 生成无法自动更新时的说明。输入当前包、可选包装器与目标；返回文字，可同步查询安装归属，不执行更新。
// 二进制提示下载；全局且不可写提示实际命令；其他布局提示使用原提供方式维护。
export function getSelfUpdateUnavailableInstruction(
	// 当前安装包名，用于区分迁移与原地升级。
	packageName: string,
	// 可选 npm 包装器命令。
	npmCommand?: string[],
	// 要更新到的目标，默认与当前包相同。
	updatePackageTarget: SelfUpdatePackageTarget = packageName,
	// 返回可直接在 CLI 展示的说明字符串。
): string {
	// 按当前安装形态决定说明类型。
	const method = detectInstallMethod();
	// 统一目标结构，以便展示明确安装规格。
	const target = normalizeSelfUpdatePackageTarget(updatePackageTarget);
	// 独立 Bun 二进制需要下载新发布产物。
	if (method === "bun-binary") {
		// 返回发布页地址；此处不打开网页或下载文件。
		return `Download from: https://github.com/earendil-works/pi/releases/latest`;
	}
	// 构造包管理器计划，用来决定能否给出准确人工命令。
	const command = getSelfUpdateCommandForMethod(method, packageName, target, npmCommand);
	// Path-based detection also matches installs that only live under a package manager's directory,
	// such as a wrapper under PNPM_HOME, so name the package manager only when it owns the install.
	// 只有已确认全局归属而且不可写，才把问题明确描述为权限不足。
	if (command && isManagedByGlobalPackageManager(method, packageName, npmCommand) && !isSelfUpdatePathWritable()) {
		// 文字包含安装器和命令展示内容，调用方再打印。
		return `This installation is managed by a global ${method} install, but the install path is not writable. Update it yourself with: ${command.display}`;
	}
	// 无法证明归属时不要求使用猜测的安装器，提醒按原安装方式更新目标规格。
	return `Update ${target.installSpec} using the package manager, wrapper, or source checkout that provides this installation.`;
}

// 生成一般更新提示。输入包名，返回 Run 命令或人工说明，不执行更新。
// 优先按安装方式拼建议，再回退到 unavailable 说明；它不像 getSelfUpdateCommand 那样代表已通过全部自动执行资格检查。
export function getUpdateInstruction(packageName: string): string {
	// 取得安装器类型。
	const method = detectInstallMethod();
	// 按同名包升级生成命令数据。
	const command = getSelfUpdateCommandForMethod(method, packageName);
	// 有适配命令时直接提供可阅读建议。
	if (command) {
		// 仅把 display 放进文字，不启动包管理器。
		return `Run: ${command.display}`;
	}
	// 未知/二进制等情况转用详细人工说明。
	return getSelfUpdateUnavailableInstruction(packageName);
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js: returns the package root containing package.json
 * - Ignores Bun binary metadata copied into dist/ when the package root is available
 */
// 从目录向上找 Node 包根。输入起始目录，返回找到的包根，找不到时返回原值；只查文件存在。
// 额外跳过带 Bun 元数据的 dist，避免把资源路径拼成 dist/dist。例如 src/config.ts 的目录可向上找到 coding-agent。
export function findNodePackageDir(startDir: string): string {
	// 游标从调用者给出的目录开始。
	let dir = startDir;
	// 直到到达文件系统根，避免无限向上。
	while (dir !== dirname(dir)) {
		// 有 package.json 就作为候选包根。
		if (existsSync(join(dir, "package.json"))) {
			// 保存候选父目录，用于识别 dist 元数据例外。
			const parent = dirname(dir);
			// build:binary places Bun's metadata inside dist/. Node still needs the
			// package root so its dist-relative asset paths do not become dist/dist/.
			// 当前叫 dist 且上一级也有清单时，真正 Node 包根应取上一级。
			if (basename(dir) === "dist" && existsSync(join(parent, "package.json"))) {
				// 返回外层包根，后续再按 src/dist 选资源。
				return parent;
			}
			// 普通情况返回最近包含 package.json 的目录。
			return dir;
		}
		// 未命中就向上移动一层。
		dir = dirname(dir);
	}
	// 找不到时保留起点；本函数不抛“未找到包根”异常。
	return startDir;
}

// 取得当前包根。无输入，返回路径；优先环境覆盖，再二进制位置，最后向上找包清单。
// 例如 Nix 设置 PI_PACKAGE_DIR 可绕过布局猜测；只解析/探测，不创建目录。
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	// 读取可覆盖包资产根的环境变量。
	const envDir = process.env.PI_PACKAGE_DIR;
	// 非空环境值具有最高优先级。
	if (envDir) {
		// 规范化波浪号等路径形式；normalizePath 本身不保证绝对或存在。
		return normalizePath(envDir);
	}

	// Bun 编译产物使用可执行文件旁的资源布局。
	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		// execPath 指编译可执行文件，取它所在目录。
		return dirname(process.execPath);
	}
	// 源码或 Node dist 从此模块所在目录向上找包根。
	return findNodePackageDir(__dirname);
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For source (src/): src/modes/interactive/theme/
 */
// 定位内置主题目录。无参数，返回路径，不创建或验证主题文件。
// Bun 为可执行文件旁 theme，其他情况按包内 src 是否存在选择 src/dist，例如源码返回 src/modes/interactive/theme。
export function getThemesDir(): string {
	// 独立二进制资源布局单独处理。
	if (isBunBinary) {
		// 主题资源放在包根旁的 theme 子目录。
		return join(getPackageDir(), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	// Node/source 先取得包根。
	const packageDir = getPackageDir();
	// 存在 src 就优先源码布局，否则使用发布的 dist 布局。
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	// 按平台规则拼出主题目录。
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For source (src/): src/core/export-html/
 */
// 定位 HTML 导出模板。无参数，返回目录，不读模板。
// Bun 用 export-html；Node/source 用选中的 src/dist/core/export-html。后续导出模块负责读取具体模板。
export function getExportTemplateDir(): string {
	// 检测二进制资源布局。
	if (isBunBinary) {
		// 直接使用可执行文件旁的 export-html 目录。
		return join(getPackageDir(), "export-html");
	}
	// 普通运行模式取得包根。
	const packageDir = getPackageDir();
	// 根据源码目录是否存在选择 src 或 dist。
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	// 拼出 HTML 导出模板目录。
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
// 取得 package.json 地址。无参数、只拼路径；例如后面的模块初始化用它读取应用名和版本。
export function getPackageJsonPath(): string {
	// 在统一包根下附加清单文件名，不检查文件内容。
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
// 取得 README 地址。无参数，返回绝对路径，无写入；例如帮助入口可据此读取随包说明。
export function getReadmePath(): string {
	// 先拼包根下 README.md，再 resolve 保证绝对路径。
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
// 取得随包 docs 目录。无参数、返回绝对路径，无写入；例如文档查找可从这里开始。
export function getDocsPath(): string {
	// resolve 将拼接路径绝对化，不创建 docs。
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
// 取得随包 examples 目录。无参数、返回绝对路径；例如扩展示例浏览器可以使用，函数不遍历目录。
export function getExamplesPath(): string {
	// 在包根下拼 examples，并转绝对路径。
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
// 取得 CHANGELOG 地址。无参数、返回绝对文件路径；更新提示的读取操作由调用方执行。
export function getChangelogPath(): string {
	// 拼接固定更新日志文件名后绝对化。
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For source (src/): src/modes/interactive/assets/
 */
// 定位内置交互资产目录。无参数，返回路径，仅检查 src 目录布局。
// Bun 用 assets；其他模式用 src/dist/modes/interactive/assets，例如 UI 图片资源从此目录查找。
export function getInteractiveAssetsDir(): string {
	// 二进制使用旁置 assets 布局。
	if (isBunBinary) {
		// 返回可执行文件目录下 assets。
		return join(getPackageDir(), "assets");
	}
	// 其他模式先解析包根。
	const packageDir = getPackageDir();
	// 源码存在时优先 src，否则 dist。
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	// 拼出普通运行模式的交互资产目录。
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** Get path to a bundled interactive asset */
// 取得某个内置交互资产地址。输入文件名，返回拼接路径，无读取/校验。
// 例如传 badge.png 得到 assets 下对应地址；此函数不检查名称是否越出该目录，调用者传受控资源名。
export function getBundledInteractiveAssetPath(name: string): string {
	// 复用资产目录入口再拼调用者文件名。
	return join(getInteractiveAssetsDir(), name);
}

// 模块级可选缓存：保存已解析/嵌入的 QuickJS wasm 地址，供后续调用复用。
let quickJSWasmPath: string | undefined;

/** Called by the Bun entry with the path of the QuickJS wasm file embedded in the compiled executable. */
// 记录 Bun 编译产物内嵌 wasm 的地址。输入路径，无返回值，只更新模块缓存。
// 二进制入口可在 codemode 使用前调用，避免再从 node_modules 解析。
export function setEmbeddedQuickJSWasmPath(path: string): void {
	// 保存字符串引用，不读取或编译 wasm 文件。
	quickJSWasmPath = path;
}

/**
 * Get path to `quickjs-wasi/quickjs.wasm`, the VM that runs codemode scripts. Resolved once so the
 * compiled module cached per path keeps working after an update removes this install (#10439).
 */
// 定位 QuickJS wasm。无参数，返回路径；首次未缓存时进行包解析，失败向外抛。
// ??= 仅在缓存为空时解析，例如普通 npm 安装从 quickjs-wasi 包中定位 quickjs.wasm；返回路径不等于执行脚本。
export function getQuickJSWasmPath(): string {
	// 建立此模块位置的 require 解析器，只 resolve 包文件，并把结果缓存供后续复用。
	quickJSWasmPath ??= createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
	// 返回嵌入地址或第一次解析结果。
	return quickJSWasmPath;
}

/** Resolve the codemode worker entry for a release runtime. */
// 按发布运行时决定 codemode worker 入口。输入运行时类别与当前模块 URL；返回字符串/URL/undefined，无文件读取。
// Bun 返回原源码相对入口，Node bundle 返回同目录 JS，普通运行交给 pi-codemode 默认处理。
export function resolveCodemodeWorkerSpecifier(
	// 三种运行模式的字面量联合类型，避免随意传字符串。
	runtime: "bun-binary" | "bundled-node" | "unbundled",
	// Node bundle 以它为基址构造 worker URL。
	moduleUrl: string,
	// 返回联合类型由调用方按具体模式处理。
): string | URL | undefined {
	// Bun embeds explicit source entrypoints, but on Windows Bun 1.3 cannot map an absolute
	// B:\~BUN URL back to one. A relative string with the original source extension works on
	// every Bun platform.
	// Bun 嵌入入口保留源码扩展名，避免 Windows 虚拟绝对路径映射问题。
	if (runtime === "bun-binary") return "./src/extensions/codemode/worker.ts";
	// Node bundle 的 worker 构建为独立同目录 JS 文件。
	if (runtime === "bundled-node") return new URL("./codemode-worker.js", moduleUrl);
	// 未打包模式返回 undefined，使用依赖自带 worker。
	return undefined;
}

// 缓存 Node bundle worker 的 data URL，避免自更新删除旧 worker 文件后无法再创建。
let codemodeWorkerDataUrl: URL | undefined;

/**
 * Get the codemode worker entry, or undefined to use the worker that ships next to pi-codemode.
 * The Bun and Node release builds both pass the worker as an extra entrypoint.
 */
// 取得实际 codemode worker 入口。无输入，返回模式对应入口；Node bundle 首次会读 worker 并缓存内存副本。
// 例如另一个终端更新删除旧文件后，同进程仍可用已缓存 data URL；首次读取错误会抛出。
export function getCodemodeWorkerSpecifier(): string | URL | undefined {
	// 嵌套三元表达式依次区分 Bun binary、bundled Node、普通模式。
	const runtime = isBunBinary ? "bun-binary" : isBundledNode ? "bundled-node" : "unbundled";
	// 根据模式和此模块 URL 计算初始入口。
	const specifier = resolveCodemodeWorkerSpecifier(runtime, import.meta.url);
	// 只有 Node bundle 的 URL 需要缓存文件内容；其他情况原样返回。
	if (runtime !== "bundled-node" || !(specifier instanceof URL)) return specifier;
	// Spawn workers from an in-memory copy. An update replaces or deletes the file while this
	// process keeps running (#10439). The bundle build keeps the worker free of relative imports
	// and import.meta, so it runs from a data: URL.
	// 首次同步读 worker，转 Base64 并嵌入 data:text/javascript URL；后续缓存命中不再读磁盘。
	codemodeWorkerDataUrl ??= new URL(`data:text/javascript;base64,${readFileSync(specifier).toString("base64")}`);
	// 返回内存副本入口；构造 URL 本身不创建 worker 线程。
	return codemodeWorkerDataUrl;
}

// 判别联合：updated 必带新 version，removed 没有 version；用 kind 收窄后可安全访问对应字段。
export type InstallChange = { kind: "updated"; version: string } | { kind: "removed" };

/**
 * Detect that the package this process runs from changed on disk, for example after `pi update`
 * in another terminal. Code loaded on demand can then be missing or from another version.
 *
 * Checks the package.json read at startup. Resolving it again would walk up past a deleted install
 * and could find an unrelated package.json, such as one in the home directory.
 */
// 检测当前安装是否被其他进程更新/删除。输入默认取启动时的清单地址，返回更新/移除信息或 undefined。
// 只读原地址，Bun 跳过；例如文件版本从 1 改成 2 返回 updated，JSON 无法解析则静默无结论。
export function detectInstallChange(packageJsonPath = startupPackageJsonPath): InstallChange | undefined {
	// The Bun binary embeds its code, so replacing the executable does not affect this process.
	// 二进制代码已嵌入，或启动时没有清单地址时，不做检测。
	if (isBunBinary || !packageJsonPath) return undefined;
	// 声明读取后清单的 TS 类型，尚未给它赋值。
	let installed: PackageJson;
	// 文件可能被删、不可读或不是有效 JSON，统一捕获。
	try {
		// 同步读取、去 BOM、解析 JSON；as 只声明类型，不验证其完整结构。
		installed = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as PackageJson;
		// 失败时只对文件不存在给出明确 removed 结论。
	} catch (error) {
		// 把异常视为带 code 的系统错误读取 ENOENT；其他错误返回 undefined，而不是判定安装已删除。
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "removed" } : undefined;
	}
	// 版本存在且与本进程启动版本不同，才认为更新。
	return installed.version && installed.version !== VERSION
		? // 返回实际磁盘版本，用于提示重新启动。
			{ kind: "updated", version: installed.version }
		: // 相同版本或没有版本信息就无结论。
			undefined;
}

// =============================================================================
// App Config (from package.json piConfig)
// =============================================================================

// 这里只声明应用需要读取的 package.json 子集，不是完整 npm 清单 schema。
interface PackageJson {
	// 可选 npm 包名，缺省稍后用官方包名。
	name?: string;
	// 可选版本字符串，缺省用 0.0.0。
	version?: string;
	// 可选 Pi 定制配置块。
	piConfig?: {
		// 定制应用名称，也用于环境变量前缀。
		name?: string;
		// 定制配置目录名，缺省 .pi。
		configDir?: string;
	};
}

// 模块初始化的清单数据，文件缺失时保留空对象。
let pkg: PackageJson = {};
/** The package.json this process started from, if one existed. */
// 保存启动时真实读取的清单地址，后面检测安装变化时不再重新向上找。
let startupPackageJsonPath: string | undefined;
// 导入本模块时就执行一次清单加载；不是等函数调用才加载。
try {
	// 使用本模块统一包根定位清单。
	const packageJsonPath = getPackageJsonPath();
	// 读取并去 BOM 后解析；as PackageJson 没有额外运行时 schema 校验。
	pkg = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as PackageJson;
	// 只有成功读取解析后才记录启动地址。
	startupPackageJsonPath = packageJsonPath;
	// unknown 表示 JS 可抛任意值，使用前需在此声明预期形状。
} catch (e: unknown) {
	// 把错误按 Node 文件系统错误读取 code，类型断言不转换原对象。
	const err = e as NodeJS.ErrnoException;
	// 只容忍文件不存在；JSON 错误或权限等其他异常仍向外抛。
	if (err.code !== "ENOENT") throw e;
}

// 可选链读 piConfig.name；不存在时得到 undefined。
const piConfigName: string | undefined = pkg.piConfig?.name;
// 优先清单包名，否则用官方默认包名；|| 也会把空字符串当缺省。
export const PACKAGE_NAME: string = pkg.name || "@earendil-works/pi-coding-agent";
// 应用命令名默认 pi，支持定制打包名称。
export const APP_NAME: string = piConfigName || "pi";
// 自定义名称直接作标题，官方名称的显示标题用 π。
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
// 用户配置目录名默认 .pi。
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
// 导出本进程启动版本；缺失时用开发回退版本 0.0.0。
export const VERSION: string = pkg.version || "0.0.0";

// e.g., PI_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
// 按应用名生成用户配置目录覆盖环境变量名，例如 PI_CODING_AGENT_DIR。
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
// 按应用名生成会话目录覆盖环境变量名，例如 PI_CODING_AGENT_SESSION_DIR。
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;

// 规范化用户输入路径。输入字符串，返回规范化字符串，无磁盘读取。
// 例如 ~/work 展开主目录；实际委托 normalizePath，还处理该助手支持的 Windows/file URL 形式，不只波浪号。
export function expandTildePath(path: string): string {
	// 把具体路径规则统一交给 paths 模块；不保证最终为绝对路径。
	return normalizePath(path);
}

// 默认分享查看器地址，只是 URL 常量，不产生网络请求。
const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/** Get the share viewer URL for a gist ID. */
// 为 gist 构造查看器链接。输入 gist id，返回 URL 文本，无网络请求。
// 优先 PI_SHARE_VIEWER_URL，再在地址后附 #id；例如 abc 得到默认 session/#abc。
export function getShareViewerUrl(gistId: string): string {
	// 非空环境变量可替换查看器基址。
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	// 把 gist id 放入 fragment，不在此校验/编码 id 或上传 gist。
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// User Config Paths (~/.pi/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.pi/agent/) */
// 取得用户配置根目录。无输入，返回路径，不创建目录。
// 先检查按应用名生成的环境变量，再默认主目录/.pi/agent；例如环境设 ~/custom 时会展开主目录。
export function getAgentDir(): string {
	// 方括号按动态环境变量名读取值。
	const envDir = process.env[ENV_AGENT_DIR];
	// 环境值非空时优先使用它。
	if (envDir) {
		// 规范化用户给定目录形式。
		return expandTildePath(envDir);
	}
	// 缺省目录按系统主目录、配置目录名和 agent 拼成。
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get path to user's custom themes directory */
// 取得自定义主题目录。无参数、仅拼地址；例如默认 ~/.pi/agent/themes，不读取或创建。
export function getCustomThemesDir(): string {
	// 以实时 getAgentDir 结果为根，附 themes 子目录。
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
// 取得用户模型配置文件地址。无参数、无读写；例如默认 ~/.pi/agent/models.json，加载由 ModelRuntime 完成。
export function getModelsPath(): string {
	// 在配置根下拼 models.json。
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
// 取得凭证文件地址。无参数、无读写；例如 auth.json 的实际解密/刷新并不发生在这里。
export function getAuthPath(): string {
	// 在配置根下拼 auth.json。
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
// 取得全局设置文件地址。无参数、仅返回路径；SettingsManager 才负责加载/保存。
export function getSettingsPath(): string {
	// 在配置根下拼 settings.json。
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
// 取得用户工具目录。无参数、仅拼路径，不自动加载或执行其中文件。
export function getToolsDir(): string {
	// 在配置根下拼 tools 子目录。
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
// 取得受管理工具二进制目录。无参数、仅返回地址；例如 fd/rg 下载器另行负责安装。
export function getBinDir(): string {
	// 在配置根下拼 bin。
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
// 取得用户提示词模板目录。无参数、无读写；资源加载器可从这个 prompts 路径发现模板。
export function getPromptsDir(): string {
	// 在配置根下拼 prompts。
	return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
// 取得会话根目录。无参数、仅返回地址；具体项目子目录由 SessionManager 再计算。
export function getSessionsDir(): string {
	// 在配置根下拼 sessions。
	return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
// 取得调试日志文件地址。无参数、仅拼路径；例如默认 pi-debug.log，函数不会写日志。
export function getDebugLogPath(): string {
	// 按当前应用名生成日志文件名，再拼到配置目录。
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
