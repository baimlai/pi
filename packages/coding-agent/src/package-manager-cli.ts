// 处理包管理与配置子命令，并协调模型目录刷新、普通自更新和托管安装切换；本文件包含真实网络、进程及文件副作用。
// 导入同步文件 API，托管更新会用它们真实创建、写入、重命名与删除目录/文件。
import {
	// existsSync 用于路径存在性分支，检查与后续操作并非一个原子动作。
	existsSync,
	// mkdirSync 创建目录，recursive:true 时可补齐父级。
	mkdirSync,
	// mkdtempSync 按前缀生成新的临时目录，避免自己猜唯一后缀。
	mkdtempSync,
	// readdirSync 读取一层目录项名字，不递归扫描。
	readdirSync,
	// readFileSync 同步读取标记文件正文，会阻塞且可能抛系统错误。
	readFileSync,
	// renameSync 用于版本目录就位及活动指针替换。
	renameSync,
	// rmSync 可递归删除发布/暂存目录，参数由各调用处决定。
	rmSync,
	// writeFileSync 写清单和版本指针，不等于自动 fsync 或事务。
	writeFileSync,
} from "node:fs";
// join 拼路径，resolve 将相对根变绝对路径；二者不会执行安装。
import { join, resolve } from "node:path";
// Markdown 是实际渲染组件，type MarkdownTheme 仅是样式回调结构的静态类型。
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
// chalk 生成终端颜色/样式文字，不处理安装状态或异常。
import chalk from "chalk";
// proper-lockfile 提供同步/异步文件锁，这里协调启动清理和显式托管更新。
import lockfile from "proper-lockfile";
// 资源选择 TUI 的入口；真正调用时才启动终端交互。
import { selectConfig } from "./cli/config-selector.ts";
// 把 CLI 模式、设置与选择框适配成项目信任上下文。
import { createProjectTrustContext } from "./cli/project-trust.ts";
// 统一从 config 模块获取包身份、资产路径和自更新计划助手。
import {
	// 应用显示名和可执行入口名，通常为 pi。
	APP_NAME,
	// 项目配置目录名，通常为 .pi，用在帮助和项目路径中。
	CONFIG_DIR_NAME,
	// 只读检查当前进程启动包的磁盘版本是否发生变化。
	detectInstallChange,
	// 根据运行时和安装路径特征识别安装器，不直接执行更新。
	detectInstallMethod,
	// 解析当前用户配置根，尊重应用对应的目录环境覆盖。
	getAgentDir,
	// 读取环境变量优先的用户自定义更新 argv，不在读取时运行。
	getConfiguredSelfUpdateArgv,
	// 定位当前包资产根，兼容源码、安装包和指定覆盖路径。
	getPackageDir,
	// 生成可自动执行的更新计划；内部可运行只读全局安装根探测。
	getSelfUpdateCommand,
	// 生成当前安装无法自动更新的说明，也可能查询全局安装归属。
	getSelfUpdateUnavailableInstruction,
	// 把发布信息替换进用户配置 argv 的三个占位符，生成命令记录。
	makeConfiguredSelfUpdateCommand,
	// 当前运行包的逻辑 npm 名，用于判断包名迁移和构造默认目标。
	PACKAGE_NAME,
	// 只导入命令/argv/display/可选 steps 的类型，不创建命令。
	type SelfUpdateCommand,
	// 目标允许包名字串或显式 packageName/installSpec 对象的类型。
	type SelfUpdatePackageTarget,
	// 当前运行代码的版本，不是在每次读磁盘后自动改变的变量。
	VERSION,
} from "./config.ts";
// 内联扩展工厂/带名称对象的联合类型，运行时注入项用它描述。
import type { InlineExtension } from "./core/extensions/types.ts";
// 模型运行时实际类，update --models 会创建它并请求目录刷新。
import { ModelRuntime } from "./core/model-runtime.ts";
// 包管理器负责具体安装/删除/资源解析；离线辅助函数仅识别自身约定的 PI_OFFLINE 真值。
import { DefaultPackageManager, isOfflineModeEnabled } from "./core/package-manager.ts";
// AppMode 是类型，resolveProjectTrusted 才实际合并信任来源并可能询问扩展/UI。
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
// 资源引导器可能执行扩展；另外两个助手格式化失败提示及识别内置工厂对象。
import { DefaultResourceLoader, formatPackageInstallWarning, isBuiltinExtension } from "./core/resource-loader.ts";
// 设置管理器按信任状态加载两层设置，并把 setter 保存动作排队。
import { SettingsManager } from "./core/settings-manager.ts";
// 检测受控项目资源及读取/保存目录信任决定的存储类。
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
// 共用跨平台子进程封装，分别用于启动、同步等待及异步退出/管道收尾。
import { spawnProcess, spawnProcessSync, waitForChildProcess } from "./utils/child-process.ts";
// canonicalizePath 尝试真实路径，getCwdRelativePath 做目录边界内的词法包含判断。
import { canonicalizePath, getCwdRelativePath } from "./utils/paths.ts";
// 为管理请求构造含当前版本的 User-Agent。
import { getPiUserAgent } from "./utils/pi-user-agent.ts";
// 移除 JSON 正文最开头的 BOM，避免合法文件前缀使 JSON.parse 失败。
import { stripBom } from "./utils/text.ts";
// 版本查询/错误格式化/比较助手；查询可联网，比较对非法版本采用文字不同的降级规则。
import { formatVersionCheckError, getLatestPiRelease, isNewerPackageVersion } from "./utils/version-check.ts";
// 导入 Windows npm 自更新时处理已加载原生库的文件操作助手。
import {
	// 尽力删除旧原生库隔离根；不是停止所有旧进程。
	cleanupWindowsSelfUpdateQuarantine,
	// 把本进程包内已加载共享库移到隔离处再复制回来，不卸载库且不回滚中途失败。
	quarantineWindowsNativeDependencies,
} from "./utils/windows-self-update.ts";

// 导出的字符串字面量联合只允许四种规范命令；uninstall 在解析时归一为 remove，不是第五种运行时枚举值。
export type PackageCommand = "install" | "remove" | "update" | "list";

// 以 type 字段区分更新目标；只有 extensions 分支可含可选 source。联合类型只约束 TS 调用，不自行验证 argv。
type UpdateTarget = { type: "all" } | { type: "self" } | { type: "extensions"; source?: string } | { type: "models" };

// 托管版本安装文件的默认远端基址，调用更新时可由 PI_INSTALLER_API_BASE 覆盖。
const DEFAULT_INSTALLER_API_BASE = "https://pi.dev/api/installer/releases";
// 托管安装标记文件名；它的约定字段在下面读取时检查。
const MANAGED_INSTALL_MARKER = "managed-install.json";
// 版本目录名白名单：三段数字、可选预发布与构建部分，整串匹配且不带 m；末尾换行不会被忽略。这不是完整 semver 规范验证，例数字前导零仍可匹配。
const MANAGED_RELEASE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// 识别本次进程是否真的运行在托管安装的 releases 树中。无输入，读取环境、包路径及标记 JSON，返回托管根或 undefined；例如子进程继承 PI_MANAGED_INSTALL_ROOT，但自身是源码 checkout，就返回 undefined。
// 只有路径落入 releases 后才读取标记；标记缺失、读取/解析失败或三个约定字段不匹配会抛统一错误。路径包含检查不等于完整验证安装内容。
function getActiveManagedInstallRoot(): string | undefined {
	// 读取环境指定根并 trim；可选链让未设置时保持 undefined，不自动展开 ~。
	const configuredRoot = process.env.PI_MANAGED_INSTALL_ROOT?.trim();
	// 没有非空配置就不是这条托管安装路径，直接返回 undefined。
	if (!configuredRoot) return undefined;

	// 以当前 cwd 把环境根解析为绝对路径，只处理路径词法，不创建目录。
	const managedRoot = resolve(configuredRoot);
	// 拼出 releases 并尝试 realpath；解析失败回退原路径，不能由此保证目录存在。
	const releasesDir = canonicalizePath(join(managedRoot, "releases"));
	// The launcher environment is inherited by child processes. Do not classify a
	// source checkout or another Pi installation launched from managed Pi as managed.
	// 把当前包根也 canonicalize 后检查是否在 releases 内；继承环境但实际运行别处时返回 undefined，不据环境值一项就判为托管。
	if (getCwdRelativePath(canonicalizePath(getPackageDir()), releasesDir) === undefined) return undefined;

	// 标记放在托管根，不是某一个版本 release 内。
	const markerPath = join(managedRoot, MANAGED_INSTALL_MARKER);
	// 捕获标记的读取、解析及约定字段检查错误，统一给调用方可读消息。
	try {
		// 同步读 UTF-8、去开头 BOM 再 JSON.parse；as 只描述待检查字段，不校验 JSON 为对象。
		const marker = JSON.parse(stripBom(readFileSync(markerPath, "utf8"))) as {
			// 标记种类先当 unknown，后面与唯一允许值比较。
			kind?: unknown;
			// 布局字段也是外部 JSON 的未知值。
			layout?: unknown;
			// schemaVersion 暂为 unknown，类型断言不把任意数据自动变成数值 1。
			schemaVersion?: unknown;
		};
		// 三个约定字段必须同时匹配；|| 任一失败即进入拒绝，额外字段不在这里被禁止。
		if (marker.kind !== "pi-managed-install" || marker.schemaVersion !== 1 || marker.layout !== "releases-v1") {
			// 用空 Error 触发外层统一标记错误，不把内部解析细节逐个暴露。
			throw new Error();
		}
		// 读取/解析/字段错误都走此分支，未绑定错误变量说明不保留原 cause。
	} catch {
		// 抛出包含实际标记地址的统一异常，调用方决定静默跳过还是显示。
		throw new Error(`Managed install marker is missing or invalid: ${markerPath}`);
	}

	// 通过路径与标记检查后返回托管根字符串，尚未拿更新锁。
	return managedRoot;
}

// 下载一份托管安装器文件，输入 URL 与错误展示用 label，返回正文字符串。例 label=package-lock.json；只检查 HTTP ok，不在此解析 JSON、验证签名或重试。fetch/读正文异常直接拒绝，无本函数超时或取消信号。
async function fetchInstallerArtifact(url: string, label: string): Promise<string> {
	// 实际发 fetch，并附本 Pi 版本 User-Agent；本函数未传 signal 或 timeout。
	const response = await fetch(url, { headers: { "User-Agent": getPiUserAgent(VERSION) } });
	// fetch 对 HTTP 错误也常正常返回 Response，因此单独检查 ok。
	if (!response.ok) {
		// 非成功 HTTP 状态转为带 URL/label/状态码的错误；不会继续读取正文。
		throw new Error(`Could not download managed installer ${label} from ${url}: HTTP ${response.status}`);
	}
	// 等待并返回全部文字正文，错误可直接使 Promise 拒绝，不在此 JSON.parse。
	return await response.text();
}

// 在暂存目录执行固定 npm ci，等待退出及输出收尾，返回 Promise<void>。例 stageDir=/tmp/install/staging/update-abc；会真实下载/写依赖，但 --ignore-scripts 禁用 npm 生命周期脚本。
// 非零或 null 退出码报错，启动失败也拒绝；这里不使用用户 npmCommand 设置，也不主动修复 lockfile。
async function runManagedNpmCi(stageDir: string): Promise<void> {
	// No age-gate override: the release lockfile pins every package, so npm never
	// resolves versions and a configured min-release-age does not apply.
	// 固定 npm 参数数组，每项是独立 argv，不拼成 shell 安装脚本。
	const args = [
		// ci 按锁文件安装依赖，而非 install 的一般版本解析流程。
		"ci",
		// 禁用 npm 生命周期脚本；不等于 npm 本身无网络或无文件副作用。
		"--ignore-scripts",
		// 不安装开发依赖。
		"--omit=dev",
		// 显式包含可选依赖，兼容不同平台所需原生包。
		"--include=optional",
		// 关闭捐助提示，不影响依赖内容。
		"--no-fund",
		// 关闭 npm audit 网络审计步骤，不表示依赖已经过安全审计。
		"--no-audit",
		// 把 npm 日志级别设为 error。
		"--loglevel=error",
		// 关闭 npm 进度条，避免冗余终端输出。
		"--progress=false",
	];
	// 在 stageDir 真实启动 PATH 中的 npm，继承终端 IO，并等待退出/输出收尾；不设置本函数超时。
	const code = await waitForChildProcess(spawnProcess("npm", args, { cwd: stageDir, stdio: "inherit" }));
	// 只有退出码恰为 0 才成功；null 等情况显示 unknown，?? 不把数值 0 当空值。
	if (code !== 0) throw new Error(`npm ${args.join(" ")} exited with code ${code ?? "unknown"}`);
}

// 同步运行候选 release 中的 pi --version 并与期望版本逐字比较，无返回值。例期望 1.2.3 而 stdout 为 1.2.2 时抛错；会启动真实程序，这只是退出码/版本输出检查，不验证全部功能。
function verifyManagedRelease(releaseDir: string, expectedVersion: string): void {
	// 按 release 的 node_modules/.bin 布局组装待运行入口，最后一项按平台选后缀。
	const binPath = join(
		// 以候选版本目录为入口查找基准，不使用当前进程的包根。
		releaseDir,
		// 进入候选安装依赖目录。
		"node_modules",
		// 使用依赖管理器创建的命令入口目录。
		".bin",
		// Windows 调用应用名.cmd，其他平台使用无后缀命令名。
		process.platform === "win32" ? `${APP_NAME}.cmd` : APP_NAME,
	);
	// 同步启动该候选入口并传 --version，阻塞等待结果，不接收用户输入。
	const result = spawnProcessSync(binPath, ["--version"], {
		// 要求把输出按 UTF-8 解码成字符串。
		encoding: "utf8",
		// 忽略标准输入，分别捕获 stdout/stderr 供版本与失败原因检查。
		stdio: ["ignore", "pipe", "pipe"],
	});
	// 启动 error 或退出码非零/null 都视为版本探测失败。
	if (result.error || result.status !== 0) {
		// 依次选启动错误消息、非空 stderr 或退出码说明；这里不检查 stdout 的格式。
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		// 把候选版本与具体失败原因写进异常，交更新流程停止激活。
		throw new Error(`Could not verify managed Pi ${expectedVersion}: ${reason}`);
	}
	// 去掉 stdout 首尾空白后作为版本文字，不提取某个子串或验证 semver。
	const installedVersion = result.stdout.trim();
	// 候选输出必须与目标版本完全相同；合法但不同版本也不通过。
	if (installedVersion !== expectedVersion) {
		// 报告 stdout 中的版本文字与期望值不符；这里只检查输出，不能据此识别全部安装内容。
		throw new Error(`Managed Pi smoke test returned version ${installedVersion}; expected ${expectedVersion}.`);
	}
}

// 激活给定托管版本：先把版本文字写到同目录临时文件，再 rename 覆盖 current-version，无返回。例 version=1.2.3 后启动器可读取新指针。
// finally 尝试删临时路径；写、重命名或清理失败均可抛错，不把整段更新变成可回滚事务，也不在此保证断电持久性。
function activateManagedRelease(managedRoot: string, version: string): void {
	// 启动器读取的活动版本指针文件路径。
	const currentPath = join(managedRoot, "current-version");
	// 为临时指针名附进程号和当前毫秒；这是降低碰撞的命名，不是排他创建。
	const temporaryPath = join(managedRoot, `current-version.tmp.${process.pid}-${Date.now()}`);
	// 将指针写入/切换包在 try，随后无论成功失败都进入临时文件清理。
	try {
		// 先完整写版本加 LF 到临时文件，不直接截断当前指针。
		writeFileSync(temporaryPath, `${version}\n`);
		// 用同目录 rename 替换活动指针；它不回滚此前安装或验证操作。
		renameSync(temporaryPath, currentPath);
		// 清理分支也在成功 return 或异常向上传播之前执行。
	} finally {
		// force:true 允许临时路径已不存在，但此处没有 catch：权限等删除错误仍会抛出。
		rmSync(temporaryPath, { force: true });
	}
}

// Keep the active release and the one running this update, which other open
// sessions likely still use and which allows rolling back by editing current-version.
// 清理托管 releases 目录，保留刚激活版本和本进程编译进来的 VERSION。输入托管根/活动版本，无返回；例如当前进程 1.2.3 更新到 1.2.4，会保留这两个名字。
// 只删除名字匹配版本正则的其他项；读取目录失败就返回，单项删除失败则跳过，不保证所有其他运行会话使用的旧版本都保留。
function pruneManagedReleases(managedRoot: string, activeVersion: string): void {
	// 定位全部托管发布目录。
	const releasesRoot = join(managedRoot, "releases");
	// 声明稍后将读到的目录项字符串数组，let 允许在 try 内赋值。
	let entries: string[];
	// 只把 readdir 放在这个 try 内，读取失败就放弃本次裁剪。
	try {
		// 同步列出一层名字，未在此确认每个名字都对应目录。
		entries = readdirSync(releasesRoot);
		// 读取失败直接结束函数，不把它当整次更新失败。
	} catch {
		// 本次无法取得目录列表就直接返回 void，不重试读取。
		return;
	}
	// 遍历刚读取的每个名字，后续每项删除有独立 catch。
	for (const entry of entries) {
		// 保留活动版本、本进程 VERSION 及不符合版本名字正则的项；不按发布时间排序。
		if (entry === activeVersion || entry === VERSION || !MANAGED_RELEASE_VERSION_RE.test(entry)) continue;
		// 删除单项失败不阻断其他项，避免占用文件让整段裁剪停止。
		try {
			// 递归删掉该版本名字下的内容；force 容许目标已缺失，但其他错误仍进 catch。
			rmSync(join(releasesRoot, entry), { force: true, recursive: true });
			// 吞掉本项删除错误，继续下一个名字。
		} catch {
			// Files may be in use (e.g. loaded native modules on Windows); retry on the next update.
		}
	}
}

// 尽力清理托管 staging 中名字以 update- 开头的项目，无返回。输入托管根；例如 update-abandoned 会被递归删除。整个扫描共用一个 catch，首个读取/删除错误可让后面项目不再处理；函数自身不拿锁。
function cleanupManagedStaging(managedRoot: string): void {
	// staging 存放尚未激活的下载/安装中间目录。
	const stagingRoot = join(managedRoot, "staging");
	// 整个扫描和所有删除共用这个 try，不是每项独立容错。
	try {
		// 读取暂存根下的一层项目名。
		for (const entry of readdirSync(stagingRoot)) {
			// 只按 update- 前缀选择候选，不额外验证创建时间或文件类型。
			if (entry.startsWith("update-")) {
				// 删除匹配项及其后代，失败会退出整个 try 到后面的 catch。
				rmSync(join(stagingRoot, entry), { force: true, recursive: true });
			}
		}
		// 捕获目录不存在、读取或删除失败，剩余项不会在本轮重试。
	} catch {
		// The staging directory does not exist yet or is not writable.
	}
}

// 启动阶段尝试清理托管安装暂存。无输入/返回，先识别活动根，再尝试同步更新锁，持锁调用清理器；无托管根、识别/锁/清理错误都安静结束。
// 例如另一个更新正在占锁时本次不强行删除 staging；不是清空 releases，也不执行安装。锁机制依赖使用同一锁约定的进程。
export function cleanupManagedInstall(): void {
	// 先声明可能不存在的托管根，识别时可产生异常。
	let managedRoot: string | undefined;
	// 把托管识别错误当启动清理不可用，区别于明确自更新时显示失败。
	try {
		// 读取环境/包路径/标记，可能同步访问文件系统。
		managedRoot = getActiveManagedInstallRoot();
		// 任何识别错误都结束清理，不打断普通启动。
	} catch {
		// 空返回表示本次不做暂存清理。
		return;
	}
	// 非托管安装无需拿锁或访问 staging。
	if (!managedRoot) return;

	// 锁获取、持锁清理及释放的异常都由这一层捕获。
	try {
		// 同步取得 update 对应的 .lock 锁，realpath:false 不要求 update 实体文件存在；默认不重试抢锁。
		const releaseLock = lockfile.lockSync(join(managedRoot, "update"), { realpath: false });
		// 取得锁后用内部 try/finally 安排释放。
		try {
			// 持锁清理旧暂存，不触及当前已激活发布目录。
			cleanupManagedStaging(managedRoot);
			// 即使内部清理抛错也尝试释放这把锁。
		} finally {
			// 调用同步释放函数；锁释放本身也可能抛错，外层会吞掉。
			releaseLock();
		}
		// 占锁或其他清理失败都不影响普通启动，不代表一定是另一个更新正在运行。
	} catch {
		// A live update owns the staging directory, or cleanup is unavailable.
	}
}

// 执行托管自更新，输入托管根和目标版本，返回 Promise<void>。流程为版本名字检查→拿锁→清旧暂存→复用已存在版本或下载两份清单→npm ci→版本输出检查→移入 releases→切指针→删旧版本。
// 例 1.2.3→1.2.4 会先安装到 staging/update-*，通过检查后才激活；会联网、启动进程及创建/删除文件。已存在目标仅检查版本输出后复用，不重装。
// ELOCKED 改成友好错误，其他异常保留。finally 先同步删暂存再 await 释放锁，删除抛错时不会走到释放调用；激活后的清理也可能失败，因此拒绝不保证指针未切换。
async function runManagedSelfUpdate(managedRoot: string, version: string): Promise<void> {
	// 版本必须满足目录名白名单才可拼入 staging/releases，失败时尚未拿锁。
	if (!MANAGED_RELEASE_VERSION_RE.test(version)) {
		// 拒绝不符合约定的版本字符串；不是把远端数据经 as 当作可信版本。
		throw new Error(`Invalid managed release version: ${version}`);
	}

	// 声明异步释放函数的类型，实际获取成功后才赋值。
	let releaseLock: () => Promise<void>;
	// 单独处理拿锁错误，后面的 finally 只在已成功拿锁时建立。
	try {
		// 异步拿同一 update 锁并取得释放函数；realpath:false 不先解析目标文件实体。
		releaseLock = await lockfile.lock(join(managedRoot, "update"), { realpath: false });
		// unknown 是异常边界，接下来先收窄才能读 code。
	} catch (error: unknown) {
		// 只把 Error 且带 ELOCKED 的情况转为并发更新提示。
		if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
			// 把锁冲突改成用户可读错误，不进入安装阶段。
			throw new Error("Another managed Pi update is already running.");
		}
		// 其他拿锁失败原样抛出，不误报为已在更新。
		throw error;
	}

	// 记录本次实际创建的临时目录；复用已存在发布时仍是 undefined。
	let stageDir: string | undefined;
	// 拿到锁后的主要流程用 finally 安排临时清理与释放。
	try {
		// 在当前持锁状态下先清理旧 update-* 暂存。
		cleanupManagedStaging(managedRoot);
		// 非空环境 API 基址优先，否则默认；下面 replace 只去掉末尾连续斜线。
		const installerApiBase = (process.env.PI_INSTALLER_API_BASE?.trim() || DEFAULT_INSTALLER_API_BASE).replace(
			// 正则 /\/+$/ 匹配真正字符串末尾的一个或多个斜线，不增加 m。
			/\/+$/,
			// 替换为空字符串，让后续按 /版本 拼 URL 时避免重复末尾斜线。
			"",
		);
		// 把版本编码为单个 URL 路径段，和经过处理的 API 基址组合。
		const releaseUrl = `${installerApiBase}/${encodeURIComponent(version)}`;
		// 定位安装中间目录根。
		const stagingRoot = join(managedRoot, "staging");
		// 定位稳定发布目录根。
		const releasesRoot = join(managedRoot, "releases");
		// 递归确保发布目录存在，会真实创建目录。
		mkdirSync(releasesRoot, { recursive: true });
		// 以版本名字定位该发布的固定目录。
		const releaseDir = join(releasesRoot, version);
		// 目标已经存在时复用，不重新下载/安装。
		if (existsSync(releaseDir)) {
			// 先同步运行目标入口 --version，检查 stdout 报告的文字恰为期望版本。
			verifyManagedRelease(releaseDir, version);
			// 检查通过后替换 current-version 指针。
			activateManagedRelease(managedRoot, version);
			// 激活后尝试裁剪其他旧版本；不保留所有历史版本。
			pruneManagedReleases(managedRoot, version);
			// 结束复用分支，但仍会执行外层 finally 释放锁。
			return;
		}

		// 为新发布确保暂存父目录存在。
		mkdirSync(stagingRoot, { recursive: true });
		// 用 mkdtemp 以 update- 为前缀创建新的独立暂存目录。
		stageDir = mkdtempSync(join(stagingRoot, "update-"));
		// 并发下载两份文本；Promise.all 一项失败会拒绝，但不自动取消另一项请求。
		const [packageJsonContent, packageLockContent] = await Promise.all([
			// 获取该版本安装 package.json 的原始正文。
			fetchInstallerArtifact(`${releaseUrl}/package.json`, "package.json"),
			// 获取配套锁文件正文，不在此重新解析生成依赖树。
			fetchInstallerArtifact(`${releaseUrl}/package-lock.json`, "package-lock.json"),
		]);
		// 把原始清单文本写入本次暂存目录。
		writeFileSync(join(stageDir, "package.json"), packageJsonContent);
		// 把原始锁文件文本写入暂存目录，随后由 npm ci 使用。
		writeFileSync(join(stageDir, "package-lock.json"), packageLockContent);

		// 等待暂存目录中的真实 npm ci 安装完成。
		await runManagedNpmCi(stageDir);
		// 再运行暂存版本 --version，检查成功后才移动到 releases。
		verifyManagedRelease(stageDir, version);
		// 把已安装暂存目录重命名为固定版本目录；失败会直接进入 finally。
		renameSync(stageDir, releaseDir);
		// 固定版本就位后再切换活动指针。
		activateManagedRelease(managedRoot, version);
		// 切换后清理其他匹配版本目录；它不属于可回滚的激活事务。
		pruneManagedReleases(managedRoot, version);
		// 无论流程成功、早返或抛错都会进入这里；清理自己也可能抛错。
	} finally {
		// 若曾创建 stageDir 就删该路径；rename 成功时旧路径已不存在，force 容许这一情况。删除若抛错，下一行释放锁不会执行。
		if (stageDir) rmSync(stageDir, { force: true, recursive: true });
		// 等待异步释放更新锁；只要前一行清理没有抛错就会执行，释放异常仍向外传播。
		await releaseLock();
	}
}

// 给发布提示的终端 Markdown 渲染器提供样式回调；这些函数只接收文字并返回着色字符串，不在声明时渲染。
const SELF_UPDATE_NOTE_MARKDOWN_THEME: MarkdownTheme = {
	// 标题回调把文字先着黄再加粗，调用时返回终端样式字符串。
	heading: (text) => chalk.bold(chalk.yellow(text)),
	// 链接文字用青色，不在此自动打开链接。
	link: (text) => chalk.cyan(text),
	// 链接 URL 显示为弱化样式，不改变其地址。
	linkUrl: (text) => chalk.dim(text),
	// 行内代码用黄色，不执行代码。
	code: (text) => chalk.yellow(text),
	// 代码块正文采用弱化样式，仅用于渲染。
	codeBlock: (text) => chalk.dim(text),
	// 代码块边界同样弱化，和正文样式单独配置。
	codeBlockBorder: (text) => chalk.dim(text),
	// 引用正文采用弱化样式。
	quote: (text) => chalk.dim(text),
	// 引用边框的文字单独着弱化样式。
	quoteBorder: (text) => chalk.dim(text),
	// 水平分隔线采用弱化样式。
	hr: (text) => chalk.dim(text),
	// 列表项目符号用黄色，保持实际列表内容不变。
	listBullet: (text) => chalk.yellow(text),
	// 粗体标记映射成 chalk.bold 回调，不在对象创建时调用。
	bold: (text) => chalk.bold(text),
	// 斜体标记映射为终端斜体。
	italic: (text) => chalk.italic(text),
	// 删除线标记映射为终端删除线样式。
	strikethrough: (text) => chalk.strikethrough(text),
	// 下划线标记映射为终端下划线。
	underline: (text) => chalk.underline(text),
};

// 解析后参数快照：业务目标、布尔开关与可选错误字段分开保存；这不是对外部 JSON 的 schema。
interface PackageCommandOptions {
	// 规范命令名，已经把 uninstall 别名归一化。
	command: PackageCommand;
	// 可选的位置来源；update --extension 的来源另保存在 updateTarget 中。
	source?: string;
	// 仅 update 使用的判别目标；? 说明其他命令可没有这个字段值。
	updateTarget?: UpdateTarget;
	// 默认 update 时显示未更新扩展的提醒，不代表实际更新结果。
	showExtensionsSkippedNote: boolean;
	// 是否请求项目层安装/删除；update/list 不接受该开关。
	local: boolean;
	// 强制自更新开关；只有包含自身的更新分支使用，托管安装会拒绝。
	force: boolean;
	// 项目可信覆盖，true/false 均有意义，undefined 表示走普通判定。
	projectTrustOverride?: boolean;
	// 是否要求帮助；入口优先于记录的参数错误处理它。
	help: boolean;
	// 第一个不支持的选项，未发现则 undefined。
	invalidOption?: string;
	// 第一个多余位置参数，不把它当第二个安装来源。
	invalidArgument?: string;
	// 缺值的选项名，当前用于 --extension。
	missingOptionValue?: string;
	// 记录首个冲突说明，解析器不在此直接输出或抛错。
	conflictingOptions?: string;
}

// 取出并清空设置管理器累积错误，逐条向 stderr 打印范围、消息与可选堆栈，无返回。输入管理器及展示上下文，例 package command/global；不重试写盘，也不包含此后才产生的保存错误。
function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	// 一次性取走并清空管理器已经记录的错误，未等待新写队列完成。
	const errors = settingsManager.drainErrors();
	// for...of 遍历错误，解构其设置范围和 Error 对象。
	for (const { scope, error } of errors) {
		// 向 stderr 打印带操作上下文及 global/project 范围的黄色警告。
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		// 仅错误对象带非空堆栈时额外输出。
		if (error.stack) {
			// 以弱化样式原样展示堆栈，不做敏感信息筛除。
			console.error(chalk.dim(error.stack));
		}
	}
}

// 按受限命令名返回用法字符串，无 IO。输入例如 install，输出含 <source> 与局部/信任选项；这里只生成文本，不解析参数。switch 由 PackageCommand 联合覆盖四条分支。
function getPackageCommandUsage(command: PackageCommand): string {
	// 按四种规范命令选择一条用法文本，switch 不执行包操作。
	switch (command) {
		// install 的用法分支。
		case "install":
			// 返回必填来源与局部/信任开关的简要说明。
			return `${APP_NAME} install <source> [-l] [--approve|--no-approve]`;
		// remove 的用法分支，uninstall 已在解析器归一。
		case "remove":
			// 返回删除来源的用法文字，不在此删除任何内容。
			return `${APP_NAME} remove <source> [-l] [--approve|--no-approve]`;
		// update 的用法分支，目标可来自位置参数或专门开关。
		case "update":
			// 列出自身、包、模型目录等目标及强制重装选项。
			return `${APP_NAME} update [source|self|pi] [--self|--extensions|--models|--all] [--extension <source>] [--approve|--no-approve] [--force]`;
		// list 的用法分支。
		case "list":
			// 列表仅接受信任覆盖，不需要包来源参数。
			return `${APP_NAME} list [--approve|--no-approve]`;
	}
}

// config 的简要用法常量，显示默认范围和信任覆盖开关，不执行配置界面。
const CONFIG_COMMAND_USAGE = `${APP_NAME} config [-l] [--approve|--no-approve]`;

// 向 stdout 打印 config 帮助，无输入/返回，不打开界面或写设置。例 pi config --help 会介绍 -l 和批准选项；整段英文模板是实际 CLI 输出。
function printConfigCommandHelp(): void {
	// 向 stdout 一次打印整段英文帮助；模板插值仅填应用名和目录名。
	console.log(`${chalk.bold("Usage:")}
  ${CONFIG_COMMAND_USAGE}

Open the resource configuration TUI to enable or disable package resources.
Without -l, starts in global settings (~/${CONFIG_DIR_NAME}/agent/settings.json).
Press Tab in the TUI to switch between global and project-local modes.

Options:
  -l, --local       Edit project overrides (${CONFIG_DIR_NAME}/settings.json)
  -a, --approve     Trust project-local files for this command with -l
  -na, --no-approve Ignore project-local files for this command with -l
`);
}

// 按包命令打印对应帮助，无额外业务结果，不安装或更新。输入 install/remove/update/list；例如 remove 帮助介绍 uninstall 别名，update 帮助列出 self/extensions/models/all 目标。每个 case 打印后返回。
function printPackageCommandHelp(command: PackageCommand): void {
	// 选择要打印哪一个包子命令的帮助。
	switch (command) {
		// 为 install 打印功能、选项与 npm/git/本地来源例子。
		case "install":
			// 整段模板直接用于真实帮助输出，保留换行与例子原文。
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  -l, --local       Install project-locally (${CONFIG_DIR_NAME}/settings.json)
  -a, --approve     Trust project-local files for this command
  -na, --no-approve Ignore project-local files for this command

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			// 帮助已打印，结束函数，避免进入后续 case。
			return;

		// remove 分支还说明 uninstall 别名。
		case "remove":
			// 打印删除命令的固定英文用法与示例，不执行示例中的命令。
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.
Alias: ${APP_NAME} uninstall <source> [-l]

Options:
  -l, --local       Remove from project settings (${CONFIG_DIR_NAME}/settings.json)
  -a, --approve     Trust project-local files for this command
  -na, --no-approve Ignore project-local files for this command

Examples:
  ${APP_NAME} remove npm:@foo/bar
  ${APP_NAME} uninstall npm:@foo/bar
`);
			// 结束删除帮助分支。
			return;

		// update 帮助介绍四类更新范围及常见组合。
		case "update":
			// 打印完整更新说明，实际参数合法性仍由下面解析器决定。
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update pi, installed packages, or model catalogs.

Options:
  --self                  Update pi only (default when no target is given)
  --extensions            Update installed packages only
  --models                Refresh model catalogs only
  --all                   Update pi and installed packages
  --extension <source>    Update one package only
  -a, --approve           Trust project-local files for this command
  -na, --no-approve       Ignore project-local files for this command
  --force                 Reinstall pi even if the current version is latest

Short forms:
  ${APP_NAME} update                Update pi only
  ${APP_NAME} update --all          Update pi and all extensions
  ${APP_NAME} update --models       Refresh model catalogs only
  ${APP_NAME} update <source>       Update one package
  ${APP_NAME} update pi             Update pi only (self works as alias to pi)
`);
			// 结束更新帮助分支。
			return;

		// 打印已配置包列表命令的帮助。
		case "list":
			// 固定模板描述 user/project 列表与信任覆盖开关。
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.

Options:
  -a, --approve      Trust project-local files for this command
  -na, --no-approve  Ignore project-local files for this command
`);
			// 打印完列表帮助即结束函数。
			return;
	}
}

// 解析包命令 argv，返回带命令、目标、开关及首项错误的对象；首词不是本组命令时返回 undefined，无 IO。例 uninstall x→remove，update 默认只更新自身，update --self --extensions→all。
// 先逐项识别选项/位置来源，再按优先级组装更新目标；冲突会记录但仍构造对象，由入口决定报错。重复 approve/no-approve 后值覆盖前值，--extension 只能一次；不支持 -- 终止符或 --extension=值。
// 帮助标记与错误可同时存在，调用入口优先展示帮助。这里只处理 argv，不验证包是否存在、版本是否合法或信任是否允许。
function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	// 数组解构取首词 rawCommand，其余 argv 用 ...rest 收到新数组，不修改原 args。
	const [rawCommand, ...rest] = args;
	// 规范命令初始可缺失；后面识别成功才赋值。
	let command: PackageCommand | undefined;
	// 把 uninstall 作为 remove 的输入别名。
	if (rawCommand === "uninstall") {
		// 别名在返回快照中只保留规范 remove。
		command = "remove";
		// 只有这四个首词属于本模块，其他首词留给主 CLI 继续处理。
	} else if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		// 直接保存已收窄的规范命令，TS 此时知道它属于 PackageCommand。
		command = rawCommand;
	}
	// 未匹配到包命令就不解析后续参数。
	if (!command) {
		// undefined 告诉 handlePackageCommand 返回 false，而不是报告本组参数错误。
		return undefined;
	}

	// 默认不请求项目局部安装/删除。
	let local = false;
	// 默认不强制重装自身。
	let force = false;
	// 信任覆盖未提供时为 undefined，与明确拒绝 false 区分。
	let projectTrustOverride: boolean | undefined;
	// 默认不是帮助请求。
	let help = false;
	// 为首个未知选项保留槽位。
	let invalidOption: string | undefined;
	// 为首个多余位置参数保留槽位。
	let invalidArgument: string | undefined;
	// 为首个缺失选项值保留槽位。
	let missingOptionValue: string | undefined;
	// 冲突说明初始缺失，之后用 ?? 保留第一个。
	let conflictingOptions: string | undefined;
	// 位置来源尚未设置，install/remove 后面会要求它非空。
	let source: string | undefined;
	// 是否显式出现 --self，暂不马上生成更新目标。
	let selfFlag = false;
	// 是否显式出现 --extensions。
	let extensionsFlag = false;
	// 是否显式出现 --models。
	let modelsFlag = false;
	// 是否显式出现 --all。
	let allFlag = false;
	// --extension 选项后面的单个包来源，与位置来源分开记录。
	let extensionFlagSource: string | undefined;

	// 按下标扫描其余 argv；需要吃掉 --extension 的值时可额外 index++。
	for (let index = 0; index < rest.length; index++) {
		// 取当前位置的字符串，下面按开关种类处理。
		const arg = rest[index];
		// 短长帮助标记都只设置 help，不立刻结束解析。
		if (arg === "-h" || arg === "--help") {
			// 保留帮助请求；即使另有非法项，入口也会优先显示帮助。
			help = true;
			// 当前选项已处理，跳到下一个 argv，避免再当来源。
			continue;
		}

		// 识别项目作用域开关的短/长写法。
		if (arg === "-l" || arg === "--local") {
			// 仅安装和删除允许局部范围，update/list 则记录非法选项。
			if (command === "install" || command === "remove") {
				// 把后续安装/删除写作用域改为 project。
				local = true;
				// 当前命令不接受 -l/--local，走错误记录而非静默忽略。
			} else {
				// 把当前未知选项记录下来；?? 只在尚未有错误时采用它，因此保留首个未知项。
				invalidOption = invalidOption ?? arg;
			}
			// 该 argv 已处理完，继续 for 的下一项，不再落到位置来源判断。
			continue;
		}

		// 识别自身更新范围开关。
		if (arg === "--self") {
			// 只有 update 才可接受此范围选项。
			if (command === "update") {
				// 记录显式要求 Pi 自身，后面还可与 extensions 合成 all。
				selfFlag = true;
				// 非 update 传 --self 属于未知选项。
			} else {
				// 把当前未知选项记录下来；?? 只在尚未有错误时采用它，因此保留首个未知项。
				invalidOption = invalidOption ?? arg;
			}
			// 该 argv 已处理完，继续 for 的下一项，不再落到位置来源判断。
			continue;
		}

		// 识别所有配置包更新范围。
		if (arg === "--extensions") {
			// 包范围开关只适用于 update。
			if (command === "update") {
				// 记录显式 extensions 目标，不在此调用包管理器。
				extensionsFlag = true;
				// 其他命令不接受 --extensions。
			} else {
				// 把当前未知选项记录下来；?? 只在尚未有错误时采用它，因此保留首个未知项。
				invalidOption = invalidOption ?? arg;
			}
			// 该 argv 已处理完，继续 for 的下一项，不再落到位置来源判断。
			continue;
		}

		// 识别模型目录刷新目标，与资源包/自身升级分别处理。
		if (arg === "--models") {
			// --models 仅在 update 子命令合法。
			if (command === "update") {
				// 记录刷新模型目录的请求，组合冲突在扫描完后检查。
				modelsFlag = true;
				// 非 update 使用 --models 时记录未知选项。
			} else {
				// 把当前未知选项记录下来；?? 只在尚未有错误时采用它，因此保留首个未知项。
				invalidOption = invalidOption ?? arg;
			}
			// 该 argv 已处理完，继续 for 的下一项，不再落到位置来源判断。
			continue;
		}

		// 识别自身加扩展包的全范围更新开关。
		if (arg === "--all") {
			// --all 只允许 update 命令。
			if (command === "update") {
				// 记录 all，不马上执行，仍需排除互斥组合。
				allFlag = true;
				// 其他命令不能用 --all。
			} else {
				// 把当前未知选项记录下来；?? 只在尚未有错误时采用它，因此保留首个未知项。
				invalidOption = invalidOption ?? arg;
			}
			// 该 argv 已处理完，继续 for 的下一项，不再落到位置来源判断。
			continue;
		}

		// 批准信任覆盖的两种写法均可出现于本组命令。
		if (arg === "--approve" || arg === "-a") {
			// 明确覆盖为 true；后续 --no-approve 仍可改写，参数按出现顺序生效。
			projectTrustOverride = true;
			// 信任覆盖已识别，不进入来源判断。
			continue;
		}

		// 识别明确拒绝信任的覆盖开关。
		if (arg === "--no-approve" || arg === "-na") {
			// 保存 false，不能用 || 默认值把这个明确拒绝丢掉。
			projectTrustOverride = false;
			// 当前拒绝标记处理完毕，继续扫描。
			continue;
		}

		// 识别强制自身更新开关。
		if (arg === "--force") {
			// 只有 update 接受 --force；是否真正用于自身在后面目标分支判断。
			if (command === "update") {
				// 标记强制重装请求，尚未检查托管安装是否支持。
				force = true;
				// 非 update 命令传 --force 属于未知选项。
			} else {
				// 把当前未知选项记录下来；?? 只在尚未有错误时采用它，因此保留首个未知项。
				invalidOption = invalidOption ?? arg;
			}
			// 该 argv 已处理完，继续 for 的下一项，不再落到位置来源判断。
			continue;
		}

		// --extension 后必须额外提供一个包来源值。
		if (arg === "--extension") {
			// 非 update 不接受这个带值选项；此分支不额外消费其后位置值。
			if (command !== "update") {
				// 把当前未知选项记录下来；?? 只在尚未有错误时采用它，因此保留首个未知项。
				invalidOption = invalidOption ?? arg;
				// 已记录错误就处理下一个 argv，不继续读取 --extension 的值。
				continue;
			}

			// 先预读下一个参数但不立即推进下标。
			const value = rest[index + 1];
			// 值缺失、为空或以 - 开头都当缺值；不把下一开关吞成来源。
			if (!value || value.startsWith("-")) {
				// 仅保留首个缺值选项名。
				missingOptionValue = missingOptionValue ?? arg;
				// 此前已记录过 --extension 值时，第二次出现属于冲突。
			} else if (extensionFlagSource) {
				// 记录重复来源选项的错误，保持最早冲突说明。
				conflictingOptions = conflictingOptions ?? "--extension can only be provided once";
				// 即使重复仍吃掉这次值，避免误当位置来源。
				index++;
				// 第一次且带合法非空非选项值时才保存。
			} else {
				// 把单个包来源保留到专门目标字段中。
				extensionFlagSource = value;
				// 跳过已经消费的值，for 自己还会再递增一次。
				index++;
			}
			// --extension 这一项处理结束，继续扫描剩余参数。
			continue;
		}

		// 其余以 - 开头的项都视作未知选项，包括单独 --，没有终止选项解析语法。
		if (arg.startsWith("-")) {
			// 把当前未知选项记录下来；?? 只在尚未有错误时采用它，因此保留首个未知项。
			invalidOption = invalidOption ?? arg;
			// 未知选项不再被当作包来源。
			continue;
		}

		// 尚未有非空位置来源时收下当前普通参数。
		if (!source) {
			// 保存唯一位置来源；这里不验证 npm/git/本地路径格式。
			source = arg;
			// 已有来源时，额外普通参数属于错误而非第二个包。
		} else {
			// 保留第一个多余位置参数，之后还有多余项也不覆盖。
			invalidArgument = invalidArgument ?? arg;
		}
	}

	// 扫描结束后再构造更新目标，非 update 保持 undefined。
	let updateTarget: UpdateTarget | undefined;
	// 默认不提示跳过扩展，只有无目标的 update 才打开提醒。
	let showExtensionsSkippedNote = false;
	// 只有规范命令为 update 才解释范围标记。
	if (command === "update") {
		// 显式 --all 不能再混其他范围或单包来源选项。
		if (allFlag && (selfFlag || extensionsFlag || modelsFlag || extensionFlagSource)) {
			// 准备记录冲突；下一行用 ?? 保留之前已发现的冲突。
			conflictingOptions =
				// all 与其他范围互斥，记录固定可读错误文本。
				conflictingOptions ?? "--all cannot be combined with --self, --extensions, --models, or --extension";
		}
		// --all 和任何位置来源也互斥，包括位置 self/pi。
		if (allFlag && source) {
			// 记录 all/位置来源冲突，不在此抛异常。
			conflictingOptions = conflictingOptions ?? "--all cannot be combined with a positional source";
		}

		// 模型目录标记优先进入此分支，但有其他范围仍先记录冲突。
		if (modelsFlag) {
			// models 不能与自身、扩展、all 或指定扩展混用。
			if (selfFlag || extensionsFlag || allFlag || extensionFlagSource) {
				// 为 models 的互斥组合准备首个错误说明。
				conflictingOptions =
					// 保留首个冲突，避免后续组合覆盖更早问题。
					conflictingOptions ?? "--models cannot be combined with --self, --extensions, --all, or --extension";
			}
			// models 同样不接受位置来源。
			if (source) {
				// 记录模型目录与位置来源的冲突。
				conflictingOptions = conflictingOptions ?? "--models cannot be combined with a positional source";
			}
			// 构造 models 目标，即便有错误也交入口先拦截再使用。
			updateTarget = { type: "models" };
			// 没有 models 才考虑 --extension 的单包来源。
		} else if (extensionFlagSource) {
			// 显式单包选项不能和 self/extensions/all 一起出现。
			if (selfFlag || extensionsFlag || allFlag) {
				// 准备记录 --extension 的范围冲突。
				conflictingOptions =
					// 只保留已有错误或此固定冲突说明。
					conflictingOptions ?? "--extension cannot be combined with --self, --extensions, or --all";
			}
			// --extension 的来源和位置来源不能同时给。
			if (source) {
				// 记录双重来源错误，不自行猜用户想选哪一个。
				conflictingOptions = conflictingOptions ?? "--extension cannot be combined with a positional source";
			}
			// 单包更新仍是 extensions 分支，通过 source 把范围缩为一个配置包。
			updateTarget = { type: "extensions", source: extensionFlagSource };
			// 没有专门单包选项时解释普通位置来源。
		} else if (source) {
			// 精确匹配两个自身别名，不把类似 pi-tools 也当自己。
			const sourceIsSelf = source === "self" || source === "pi";
			// 位置 self/pi 走自身升级分支。
			if (sourceIsSelf) {
				// 位置 self/pi 加 --extensions 合并为 all，否则只自身；前面的 all 冲突仍保留。
				updateTarget = extensionsFlag ? { type: "all" } : { type: "self" };
				// 其余位置来源都按单个资源包更新理解。
			} else {
				// 普通包来源不能再混范围开关；--force 在这里没有被列为冲突。
				if (extensionsFlag || selfFlag || allFlag) {
					// 准备报告普通来源与范围标记不能混用。
					conflictingOptions =
						// ?? 保持最早冲突，不因这条新增检查覆盖它。
						conflictingOptions ??
						// 具体提示不接受和 --self/--extensions/--all 合并。
						"positional update targets cannot be combined with --self, --extensions, or --all";
				}
				// 把普通位置来源放到 extensions 单包目标，属性简写 source 保存原字符串。
				updateTarget = { type: "extensions", source };
			}
			// 没有来源但有 --all 时更新自身和资源包。
		} else if (allFlag) {
			// 用 all 判别值表示这两个范围。
			updateTarget = { type: "all" };
			// 同时显式给 self 与 extensions 的组合也等价于 all。
		} else if (selfFlag && extensionsFlag) {
			// 合成同一 all 目标，不会分别发起两个独立 CLI 命令。
			updateTarget = { type: "all" };
			// 只有 self 标记就仅更新自身。
		} else if (selfFlag) {
			// 记录自身目标。
			updateTarget = { type: "self" };
			// 只有 extensions 标记就只更新已配置资源包。
		} else if (extensionsFlag) {
			// 不附 source，表示更新全部符合管理器策略的配置包。
			updateTarget = { type: "extensions" };
			// 完全没指定目标时，选择默认自身更新。
		} else {
			// 默认不是 all，而是 self。
			updateTarget = { type: "self" };
			// 另行提示扩展包被跳过，用户可主动选择 --extensions。
			showExtensionsSkippedNote = true;
		}
	}

	// 将解析结果与错误记录一起返回，不做任何安装或打印。
	return {
		// 属性简写，返回已经规范化的命令名。
		command,
		// 保留可选的位置来源，后续安装/删除需要它。
		source,
		// 返回已经按标记优先级构造的更新目标。
		updateTarget,
		// 告诉入口是否需要显示默认跳过扩展的提醒。
		showExtensionsSkippedNote,
		// 记录 local 作用域请求，不在解析器改项目设置。
		local,
		// 记录强制更新开关，交自身升级分支解释。
		force,
		// 保留 true/false/undefined 三种信任覆盖状态。
		projectTrustOverride,
		// 返回帮助请求标记，入口会优先处理。
		help,
		// 返回首个未知选项，未发现时为 undefined。
		invalidOption,
		// 返回首个多余位置参数。
		invalidArgument,
		// 返回首个缺失参数值的选项名。
		missingOptionValue,
		// 返回首个组合冲突文字，未发现则 undefined。
		conflictingOptions,
	};
}

// 判断更新目标是否包含 Pi 自身。输入判别联合，返回布尔且无副作用；例 all/self 为 true，extensions/models 为 false。
function updateTargetIncludesSelf(target: UpdateTarget): boolean {
	// 只有 all/self 包含自身，|| 不会把 extensions/models 误判成 true。
	return target.type === "all" || target.type === "self";
}

// 判断更新目标是否包含资源包更新。输入目标，返回布尔且无副作用；例 all/extensions 为 true，self/models 为 false。这里的 extensions 包含管理器所管理的资源包，不限于单个 TS 扩展文件。
function updateTargetIncludesExtensions(target: UpdateTarget): boolean {
	// 只有 all/extensions 包含资源包；单包 source 是否存在不改变这里的范围判断。
	return target.type === "all" || target.type === "extensions";
}

// 刷新模型目录并打印结果，输入用户配置根，返回 Promise<void>。先以 allowModelNetwork:false 创建运行时，关闭创建时目录联网刷新，再显式 allowNetwork:true/force:true 刷新；例如 pi update --models 不进入包安装/自身升级分支。
// 15 秒计时器只发取消信号，不是强行停止所有底层工作或硬性返回期限；aborted 或非空 errors Map 转为异常，finally 清计时器。成功提示依赖返回结果，不独立检查 runtime.getError 中的全量可用性错误。
async function refreshModelCatalogs(agentDir: string): Promise<void> {
	// 为本次模型目录创建取消控制器，创建本身不会开始联网。
	const controller = new AbortController();
	// 约 15 秒后触发 abort；数字分隔符 _ 仅增强可读性，值仍为 15000 毫秒。底层必须配合信号才会停止。
	const timeout = setTimeout(() => controller.abort(), 15_000);
	// 把创建与刷新包在 try/finally 中，确保结束时撤销计时器。
	try {
		// 等待创建模型运行时，初始化可能读配置/凭证/缓存；下面明确关闭创建时联网刷新。
		const modelRuntime = await ModelRuntime.create({
			// 凭证存储使用本次 agentDir/auth.json，不是请求中直接传明文 key。
			authPath: join(agentDir, "auth.json"),
			// 指定用户模型配置路径，运行时还可能使用同目录模型缓存。
			modelsPath: join(agentDir, "models.json"),
			// 禁止初始化阶段的模型目录联网，后面显式 refresh 是另一步。
			allowModelNetwork: false,
			// 创建阶段也传同一取消信号，但并非所有同步配置读取都可被它抢占。
			signal: controller.signal,
		});
		// 创建后再强制请求模型目录刷新；这是管理目录，不发送聊天问题。
		const result = await modelRuntime.refresh({
			// 显式允许这次刷新联网，可覆盖运行时创建时的默认网络许可。
			allowNetwork: true,
			// 要求强制刷新目录，具体 Provider 缓存/请求细节由运行时负责。
			force: true,
			// 把同一信号交给刷新，不在两阶段间重置 15 秒计时。
			signal: controller.signal,
		});
		// 运行时报告已取消时，本入口把它解释为本次目录刷新超时。
		if (result.aborted) {
			// 抛出超时文字，交外层命令处理器打印并设失败码。
			throw new Error("Model catalog refresh timed out.");
		}
		// 只要返回的供应商错误 Map 非空，就不显示刷新成功。
		if (result.errors.size > 0) {
			// Array.from 的映射回调解构 Map 条目，组装 provider:error 文本，再用分号连成一个原因。
			const details = Array.from(result.errors, ([provider, error]) => `${provider}: ${error.message}`).join("; ");
			// 把返回集合中的目录错误统一报告；这不额外查询 runtime.getError 的其他状态。
			throw new Error(`Could not refresh model catalogs: ${details}`);
		}
		// 无论上面成功、抛错还是取消，都进行计时器清理。
	} finally {
		// 撤销尚未执行的超时回调，不能撤销已经发出的取消或回滚已刷新目录。
		clearTimeout(timeout);
	}
	// 只有未抛错才输出绿色目录刷新完成提示。
	console.log(chalk.green("Model catalogs refreshed"));
}

// 打印无法自动更新时的说明，无返回。输入可选 npm 包装器及目标，例源码 checkout 会显示原安装方式维护提示与当前入口位置。下层说明生成器可能运行只读包管理器查询，本函数不执行更新。
function printSelfUpdateUnavailable(
	// 可选 npm 包装器 argv，仅用于生成准确人工说明。
	npmCommand?: string[],
	// 默认目标为当前包名；允许显式不同逻辑包名和版本规格。
	updatePackageTarget: SelfUpdatePackageTarget = PACKAGE_NAME,
	// 函数返回 void，错误说明通过 stderr 展示而不是返回值。
): void {
	// 先明确本安装无法采用自动自更新路径。
	console.error(`error: ${APP_NAME} cannot self-update this installation.`);
	// 调用统一安装归属/权限说明生成器并打印，生成过程可能同步运行只读根目录探测。
	console.error(getSelfUpdateUnavailableInstruction(PACKAGE_NAME, npmCommand, updatePackageTarget));
	// 接着给出用户自定义命令的配置入口，不在这里修改设置。
	console.error(
		// 文字里的反引号经过模板转义，只用于提示命令名和设置项。
		`To make \`${APP_NAME} update\` run your own update command, set PI_SELF_UPDATE_COMMAND or the selfUpdateCommand setting.`,
	);

	// argv[1] 通常是本进程脚本入口，可能缺失；不是自动解析到的 PATH 新版本。
	const entrypoint = process.argv[1];
	// 有入口信息才额外打印位置。
	if (entrypoint) {
		// 在提示段之间输出一个空行。
		console.error("");
		// 原样展示当前入口路径，不提供路径存在或可写保证。
		console.error(`Location of ${APP_NAME} executable: ${entrypoint}`);
	}
}

// 把已生成的更新命令展示为手工重试建议，无返回、不执行命令。输入命令对象，例 command.display=npm install ...；display 是可读文字，不提供通用 shell 转义保证。
function printSelfUpdateFallback(command: SelfUpdateCommand): void {
	// 把 display 作为手动重试建议写 stderr，不执行或重新解析这条展示字符串。
	console.error(chalk.dim(`If this keeps failing, run this command yourself: ${command.display}`));
}

// 向 stderr 打印 pnpm 元数据缓存故障的排查建议，无输入/返回；例失败后建议 pnpm store prune，但这里只输出文字，不运行 prune。
function printPnpmSelfUpdateMetadataHint(): void {
	// 提示一种 pnpm 失败可能原因，措辞为 may，并不认定本次必然是缓存问题。
	console.error(chalk.yellow("If pnpm reports missing package versions, its cached registry metadata may be stale."));
	// 建议用户手工 prune 再重试；该行只输出，不调用包管理器。
	console.error(chalk.yellow(`Run \`pnpm store prune\` and retry \`${APP_NAME} update --self\`.`));
}

// 显示远端发布提示，输入 Markdown 文字，无返回。先 trim，空白直接返回；非空显示标题，再按终端列宽渲染，失败回退原文。例 **注意** 会按终端主题加样式，不在此提供敏感信息过滤保证。
function printSelfUpdateNote(note: string): void {
	// 去掉发布说明首尾空白，后续空白检测和渲染都用这个新字符串。
	const trimmedNote = note.trim();
	// 纯空白提示不输出标题或正文。
	if (!trimmedNote) {
		// 没有需要展示的内容就结束函数。
		return;
	}

	// 非空说明前先分隔一个空行。
	console.log();
	// 用粗黄标题标记更新提示。
	console.log(chalk.bold(chalk.yellow("Update note")));
	// 渲染与渲染结果打印放在同一 try；其中任一抛错均走纯文字回退。
	try {
		// 终端列宽缺失用 80，再至少取 20；?? 不把显式 0 当缺失，外层 Math.max 才钳最小值。
		const width = Math.max(20, process.stdout.columns ?? 80);
		// 构造零 padding 的 Markdown 组件并传固定样式回调，尚未写终端。
		const renderedLines = new Markdown(trimmedNote, 0, 0, SELF_UPDATE_NOTE_MARKDOWN_THEME)
			// 按计算宽度得到终端行字符串数组，可能含 ANSI 样式。
			.render(width)
			// 逐行移除末尾空白，不去颜色序列，也不做安全过滤。
			.map((line) => line.trimEnd());
		// 把渲染行用 LF 连接，一次交给 console.log。
		console.log(renderedLines.join("\n"));
		// 渲染或上面打印异常时尝试输出未经 Markdown 渲染的说明。
	} catch {
		// 回退使用 trim 后正文，不重新请求远端，也不保证这次 console.log 不再抛错。
		console.log(trimmedNote);
	}
	// 说明之后再输出空行，与后续 CLI 输出分隔。
	console.log();
}

// 自更新计划的数据结构，决定是否执行与具体目标文字；并不证明安装已成功。
interface SelfUpdatePlan {
	// 发布活动包的逻辑 npm 名，用于包名迁移判断。
	packageName: string;
	// 具体安装规格，例如 @scope/pi@1.2.3；是字符串，不是已执行命令。
	installSpec: string;
	// 目标版本文字，不在类型层保证合法 semver。
	version: string;
	// 是否需要真正启动更新动作，false 表示当前计划无需执行。
	shouldRun: boolean;
	// 可选发布提示，稍后作为终端 Markdown 文字展示。
	note?: string;
}

// 查询并计算 Pi 自更新计划，输入 force 布尔，返回包名、规格、版本、是否执行及可选提示。例最新 1.2.4 高于当前 1.2.3 时 shouldRun:true；force 或包名迁移也会要求执行。
// 查询允许有限重试，失败包装 cause，没结果抛错；只是计算计划，不安装。无更新时打印已最新并返回 shouldRun:false 的计划；无效 semver 采用下层文字比较规则，不在这里额外验证所有发布字段。
async function getSelfUpdatePlan(force: boolean): Promise<SelfUpdatePlan> {
	// ReturnType 取查询函数返回类型，Awaited 去掉 Promise 包装；仅静态类型提取，不在此调用函数。
	let latestRelease: Awaited<ReturnType<typeof getLatestPiRelease>>;
	// 只围绕发布查询包装错误，下面比较与打印不在这个 catch 范围。
	try {
		// 显式允许最多额外两次管理请求重试；PI_SKIP_VERSION_CHECK 不拦此入口，PI_OFFLINE 的非空值会让下层无结果。
		latestRelease = await getLatestPiRelease(VERSION, { retry: true });
		// 查询可抛任意值，unknown 要先由错误格式化助手处理。
	} catch (error: unknown) {
		// 新建包含可读版本查询原因的错误，不吞掉失败假装已最新。
		throw new Error(`Could not determine latest ${APP_NAME} version: ${formatVersionCheckError(error)}`, {
			// 保留原始异常为 Error.cause，便于后续诊断。
			cause: error,
		});
	}
	// HTTP 非成功、离线跳过或无有效版本等都可能得到 undefined。
	if (!latestRelease) {
		// 没得到发布计划依据就明确失败，不继续猜版本安装。
		throw new Error(`Could not determine latest ${APP_NAME} version.`);
	}

	// 远端有活动包名则采用，否则使用当前包名；?? 只处理 null/undefined。
	const packageName = latestRelease.packageName ?? PACKAGE_NAME;
	// 拼成 包名@版本 的 argv 规格，不在此启动 npm。
	const installSpec = `${packageName}@${latestRelease.version}`;
	// 强制、包名改变、或下层版本比较认为更新任一成立就需要执行；包名迁移不要求版本更大。
	if (force || packageName !== PACKAGE_NAME || isNewerPackageVersion(latestRelease.version, VERSION)) {
		// 返回可执行计划对象，后面的 CLI 分支再选择具体更新方式。
		return {
			// 属性简写保留发布活动包名。
			packageName,
			// 保留刚拼出的明确版本安装规格。
			installSpec,
			// 目标版本来自查询结果，与本进程 VERSION 区分。
			version: latestRelease.version,
			// 有非空 note 才添加该键；对象展开不会执行说明文字。
			...(latestRelease.note ? { note: latestRelease.note } : {}),
			// 要求后续执行，不代表已经安装成功。
			shouldRun: true,
		};
	}

	// 没有更新条件时打印当前已最新；若候选版本更旧也会走这个文案。
	console.log(chalk.green(`${APP_NAME} is already up to date (v${VERSION})`));
	// 仍返回查询到的目标字段，但 shouldRun:false 使入口提前结束。
	return { packageName, installSpec, version: latestRelease.version, shouldRun: false };
}

// 按顺序真实执行更新命令或其 steps，返回 Promise<void>。输入如卸载旧名再安装新名的两步计划；每步继承 stdio，收到 close 且 code=0 才进入下一步。
// 启动 error、信号终止、非零/null 码使 Promise 拒绝，后续步骤不执行；没有超时、取消或已完成步骤回滚。退出成功仅说明命令成功，不自动证明版本更新。
async function runSelfUpdate(command: SelfUpdateCommand): Promise<void> {
	// 真实运行前先显示可读命令，不使用 display 作为执行输入。
	console.log(chalk.dim(`Updating ${APP_NAME} with ${command.display}...`));
	// 有 steps 用它，否则把单步 command 包成数组；空 steps 会零次循环而不回退到单步。
	for (const step of command.steps ?? [command]) {
		// 每步构造 Promise<void>，执行器同步启动进程并注册完成/失败回调，await 后才进入下一步。
		await new Promise<void>((resolve, reject) => {
			// 按程序名与独立 argv 启动真实进程，平台包装可为 Windows 命令选择 shell。
			const child = spawnProcess(step.command, step.args, {
				// 输入输出继承父进程，用户能看到包管理器日志，也可能收到其交互。
				stdio: "inherit",
			});
			// 启动 error 事件使当前步骤失败；回调返回值不会作为子进程退出码。
			child.on("error", (error) => {
				// 把原启动错误交给 Promise 的拒绝通道，后续 close 再结算不会改变首个结果。
				reject(error);
			});
			// 等 close 取得退出码与可选信号，和仅收到 exit 不同；本函数不设输出空闲兜底。
			child.on("close", (code, signal) => {
				// 只有数字 0 作为命令步骤成功。
				if (code === 0) {
					// 完成当前 Promise<void>，不返回版本文字或其他数据。
					resolve();
					// 非零/无退出码且带信号时，按信号终止说明报错。
				} else if (signal) {
					// 拒绝原因包含显示命令与信号，不自动重新执行或回滚上一步。
					reject(new Error(`${step.display} terminated by signal ${signal}`));
					// 没有信号时使用退出码说明，null 也属于失败。
				} else {
					// ?? 把 null 显示为 unknown；这个异常在事件回调里通过 reject 交回 await。
					reject(new Error(`${step.display} exited with code ${code ?? "unknown"}`));
				}
			});
		});
	}
}

/** Run the user-configured self-update command, then report the version installed on disk. */
// 运行用户明确配置的自更新 argv，再探测磁盘/PATH 的版本。输入 argv/发布计划，返回 Promise<void>；例包装器把新版本装到别处，就改查 PATH 上的 pi --version。
// 真实执行命令及同步版本探测；命令失败打印错误、设 exitCode=1 后返回。命令成功但未观测到目标版本只打印警告，不在这里设失败码；计划/探测阶段未被局部 catch 包住的异常仍可向外传播。
async function runConfiguredSelfUpdate(argv: string[], plan: SelfUpdatePlan): Promise<void> {
	// 替换用户 argv 的 packageName/version/installSpec 占位符，生成命令数据，不在此处执行。
	const command = makeConfiguredSelfUpdateCommand(argv, plan);
	// 计划附提示时先展示，展示异常不在下面的执行 catch 内。
	if (plan.note) {
		// 把发布说明交 Markdown/纯文字回退展示器。
		printSelfUpdateNote(plan.note);
	}
	// 只捕获 runSelfUpdate 执行错误，后续版本探测在 try 外。
	try {
		// 等待用户命令的各步骤结束，可能真实改安装目录或其他外部状态。
		await runSelfUpdate(command);
		// 命令失败进入此处，先把 unknown 规范为可展示消息。
	} catch (error: unknown) {
		// 仅 Error 使用其 message；非 Error 用固定回退文字，不 String 任意对象。
		const message = error instanceof Error ? error.message : "Unknown self-update command error";
		// 向 stderr 打印命令失败，未删除已经产生的外部副作用。
		console.error(chalk.red(`Error: ${message}`));
		// 设置进程失败码但不立即退出，交调用链收尾。
		process.exitCode = 1;
		// 结束此配置更新分支，避免继续展示版本成功。
		return;
	}
	// Exit code 0 does not prove an update. Wrappers such as mise or Nix install each version into a
	// new directory and leave this installation untouched, so fall back to the pi on PATH.
	// 只读探测启动时那份安装是否变版/被删，不能仅以命令退出码 0 作结论。
	const change = detectInstallChange();
	// 准备按磁盘变化或 PATH 查询选择观测版本。
	const installedVersion =
		// 只有检测到 updated 且恰为目标版本才直接使用；其他情况同步调用 PATH 上 pi --version。
		change?.kind === "updated" && change.version === plan.version ? change.version : readVersionOnPath();
	// 观测到版本文字逐字等于目标才打印明确更新成功。
	if (installedVersion === plan.version) {
		// 显示本进程旧 VERSION 与观测到的计划目标；不更新内存中的 VERSION。
		console.log(chalk.green(`Updated ${APP_NAME} from ${VERSION} to ${plan.version}`));
		// 版本符合计划，结束函数，不再打印警告。
		return;
	}
	// 命令成功但没观测到目标版本时输出警告，而非在此设 exitCode=1。
	console.log(
		// 给未达到目标的说明加黄色，和明确错误分开。
		chalk.yellow(
			// 有观测值就显示它，无值显示 no version；这不表示一定完全没安装其他位置。
			`Ran ${command.display}, but \`${APP_NAME} --version\` reports ${installedVersion ?? "no version"}, not ${plan.version}.`,
		),
	);
}

/** Version printed by `pi --version` as resolved from PATH, the pi the user runs next. */
// 同步查询 PATH 上 pi --version，返回去空白版本或 undefined。无输入；例如配置命令通过新目录切换版本后，用它观察用户下次会运行的 pi。
// 子进程环境只去掉 PI_PACKAGE_DIR，保留其他环境；不设 cwd/超时，非零退出无结果，返回字符串不验证 semver，也不改父进程环境。
function readVersionOnPath(): string | undefined {
	// PI_PACKAGE_DIR points at this installation and would make the new pi report the old version.
	// 对象解构把 PI_PACKAGE_DIR 取走丢到 _，剩余环境浅复制为新 env，不删除父进程变量。
	const { PI_PACKAGE_DIR: _, ...env } = process.env;
	// 同步运行 PATH 上的 APP_NAME --version，并把下面的环境副本传入。
	const result = spawnProcessSync(APP_NAME, ["--version"], {
		// 捕获 UTF-8 文本输出。
		encoding: "utf-8",
		// 忽略 stdin，分别捕获 stdout/stderr，但返回逻辑只使用 status/stdout。
		stdio: ["ignore", "pipe", "pipe"],
		// 传去掉包根覆盖的环境副本，避免新 pi 仍按旧安装报告版本。
		env,
	});
	// status=0 才取 trim 后非空 stdout，否则 undefined；不检查版本语义，spawn 的同步异常仍可传出。
	return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

// 仅 Windows 为 npm 自更新准备原生库路径，无输入/返回。先清旧隔离文件，再对本进程已加载的包内共享库做移走/复制；其他平台直接返回。
// 例如已加载 addon.node 旧实体保留在隔离目录，原位置放副本供后续替换；不卸载运行中的库，不启动 npm，文件处理失败可抛错且不回滚。
function prepareWindowsNpmSelfUpdate(): void {
	// 平台不是 Windows 时不做隔离目录或共享库操作。
	if (process.platform !== "win32") {
		// 非 Windows 分支立即返回 void。
		return;
	}

	// 通过 config 的统一助手解析包资产根，兼容安装与源码布局。
	const packageDir = getPackageDir();
	// 先尽力删旧隔离根；它自身吞删除错误，不等待旧进程退出。
	cleanupWindowsSelfUpdateQuarantine(packageDir);
	// 筛出并搬移当前加载共享库再复制回原路径；这一步的文件错误会抛出且不回滚。
	quarantineWindowsNativeDependencies(packageDir);
}

// CLI 的运行时注入项，不是 argv 中可直接填写的 JSON。
export interface PackageCommandRuntimeOptions {
	// 可选内联扩展列表，包含普通工厂与具名内置项，运行时注入而非 argv 文本。
	extensionFactories?: InlineExtension[];
}

// 设置构造阶段返回管理器及单独累积的项目信任警告。
interface CommandSettingsResult {
	// 返回刚构造并应用信任状态的设置管理器。
	settingsManager: SettingsManager;
	// 独立警告数组，包含加载/信任扩展错误，不等于 SettingsManager 的存储错误队列。
	projectTrustWarnings: string[];
}

// 依据 stdin 与 stdout 是否同时为 TTY 选择信任交互模式。无输入，返回 interactive 或 print；例管道输出即为 print，不在这里创建终端或读取用户选择。
function getCommandAppMode(): AppMode {
	// 两端 TTY 真值都满足才启用 interactive，否则 print；&& 短路后由三元表达式返回模式字符串。
	return process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "print";
}

// 逐条把项目信任阶段警告写到 stderr，无返回、不保存或改变信任。输入 readonly 字符串数组，例扩展初始化失败会显示其路径/错误；readonly 是编译期约束。
function reportProjectTrustWarnings(warnings: readonly string[]): void {
	// 遍历只读警告数组，不修改其内容或改变信任存储。
	for (const warning of warnings) {
		// 逐条向 stderr 输出黄色 Warning 文案。
		console.error(chalk.yellow(`Warning: ${warning}`));
	}
}

// 为一次 CLI 命令构造设置及项目信任状态，返回设置管理器和警告数组。输入目录、可选覆盖、是否只读已存决定及内联工厂；初始 projectTrusted:false 先不读取项目设置。
// update 的 useSavedProjectTrustOnly 分支只认已存 true 或明确覆盖，不套默认 always、扩展或 UI；普通分支可引导执行全局/内联扩展，再按覆盖/扩展/已存/默认/UI 规则决定项目可读性。
// 例 --no-approve 直接保持不可信；有受控项目资源时，默认 ask 在无 UI 且无其他决定时拒绝；没有受控资源且无已存拒绝则默认信任。信任开关不是扩展执行沙箱，已收集的扩展错误作为警告返回；构造、读锁、选择及其他未被下层捕获的异常仍可使 Promise 拒绝。
async function createCommandSettingsManager(options: {
	// 工作目录决定项目设置、资源及信任判定范围。
	cwd: string;
	// 用户配置根用于 settings.json/trust.json 等，不限于默认主目录。
	agentDir: string;
	// 可选的命令行信任覆盖，明确 false 不能当未提供。
	projectTrustOverride?: boolean;
	// update 用此开关跳过扩展/UI/默认策略，仅查已有信任记录。
	useSavedProjectTrustOnly?: boolean;
	// 引导阶段可用的内联扩展工厂；是否执行还看后续条件和加载器。
	extensionFactories?: InlineExtension[];
	// Promise 结果含管理器及警告，不返回单独的授权字符串。
}): Promise<CommandSettingsResult> {
	// 先仅加载全局设置，项目层关闭，避免未决定信任就读取项目配置。
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
	// 本地收集引导/信任处理错误文字，稍后由入口报告。
	const projectTrustWarnings: string[] = [];
	// 记录 trust.json 的位置；构造器不立刻读，get 会拿锁读取且可能创建父目录。
	const trustStore = new ProjectTrustStore(options.agentDir);
	// 只用保存决定的分支优先，绕过下面普通信任流程。
	if (options.useSavedProjectTrustOnly) {
		// 只有已存/继承结果恰为 true 才信任；无记录 null 和已拒绝 false 均变为 false。
		const savedProjectTrusted = trustStore.get(options.cwd) === true;
		// 明确覆盖优先于保存结果；?? 保留 false，设为 true 时管理器才加载项目设置。
		settingsManager.setProjectTrusted(options.projectTrustOverride ?? savedProjectTrusted);
		// 更新命令信任分支到这里结束，警告数组没有执行下面的扩展收集。
		return { settingsManager, projectTrustWarnings };
	}

	// 为普通命令按当前终端能力选择 interactive/print 信任上下文。
	const appMode = getCommandAppMode();
	// 准备有条件的信任引导加载结果，不是直接加载项目自己的扩展。
	const extensionsResult =
		// 没有明确覆盖且检测到受控项目资源时，才先执行可用的信任引导扩展。
		options.projectTrustOverride === undefined && hasTrustRequiringProjectResources(options.cwd)
			? // 创建临时资源加载器并等待引导；它会执行允许的全局/普通内联扩展初始化，不只是列路径。
				await new DefaultResourceLoader({
					// 把当前项目目录作为资源搜索基准，项目层此时仍不可信。
					cwd: options.cwd,
					// 传用户资源/设置根，用于可信全局资源发现。
					agentDir: options.agentDir,
					// 复用刚创建的设置实例，引导器会保持其项目层关闭并重读。
					settingsManager,
					// 把调用方注入的工厂交给引导加载器；内置对象与普通工厂有不同加载阶段。
					extensionFactories: options.extensionFactories,
					// 实际进行不可信项目引导加载，结果包含扩展、运行上下文及错误。
				}).loadProjectTrustExtensions()
			: // 条件不满足就没有引导结果，例如用户显式 --approve/--no-approve 会跳过此加载。
				undefined;
	// 无结果/无 errors 用空数组；每个加载错误都追加警告而非立刻中断本函数。
	for (const error of extensionsResult?.errors ?? []) {
		// 用扩展路径及错误信息构造警告，不在这里重试加载。
		projectTrustWarnings.push(`Failed to load extension "${error.path}": ${error.error}`);
	}

	// 等待统一信任决策；明确覆盖可直接返回，其他路径可能读已存决定、执行扩展事件或等 UI。
	const projectTrusted = await resolveProjectTrusted({
		// 信任判断针对当前命令目录。
		cwd: options.cwd,
		// 把同一个信任存储实例交给决策器，必要时它可保存用户/扩展记住的决定。
		trustStore,
		// 传明确覆盖值，没有时才查其他来源。
		trustOverride: options.projectTrustOverride,
		// 从全局有效设置取默认项目策略；只有普通分支采用，不影响前面的保存专用分支。
		defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
		// 把已经加载的允许扩展交给 project_trust 事件，不再假定尚未执行它们的初始化。
		extensionsResult,
		// 创建可供信任事件使用的 CLI UI 适配对象，本行构造不立即弹窗。
		projectTrustContext: createProjectTrustContext({
			// UI 上下文也保留当前目录，用于显示信任问题。
			cwd: options.cwd,
			// 非 TTY 将得到 print 模式，其 UI 选择会直接返回无选择。
			mode: appMode,
			// 界面读取同一个设置管理器的主题/终端偏好。
			settingsManager,
			// 仅两端 TTY 对应的 interactive 才报告 hasUI:true。
			hasUI: appMode === "interactive",
		}),
		// 信任扩展事件错误由同步回调追加到警告数组；push 返回的数字被调用方当 void 忽略。
		onExtensionError: (message) => projectTrustWarnings.push(message),
	});
	// 应用最终布尔决定；可信时加载项目设置，不可信时保持项目层排除。
	settingsManager.setProjectTrusted(projectTrusted);
	// 属性简写返回设置与本次收集的警告；不自动把警告打印或写到磁盘。
	return { settingsManager, projectTrustWarnings };
}

// 处理 pi config，输入 argv 和可选内联扩展，返回 Promise<boolean>：非本命令为 false，已处理帮助/参数错误为 true；正常界面关闭后 process.exit(0) 不返回。
// 例 config -l 先要求项目可信；流程为参数→设置/信任→两份资源解析→警告去重→TUI。resolve 可能安装缺包，信任引导可执行扩展，界面会改设置/终端状态；没有把全流程放进 catch。
// 帮助优先于其他错误；默认编辑 global，但可信时界面仍可切 project。此入口不额外 await 设置 flush，也不保证 TUI 异常时自动完整清理。
export async function handleConfigCommand(
	// argv 的首词必须是 config，后面只允许本函数识别的选项；不修改输入数组。
	args: string[],
	// 可选运行时注入对象默认为新空对象，不从命令行反序列化扩展代码。
	runtimeOptions: PackageCommandRuntimeOptions = {},
	// 布尔结果仅指本命令是否接管；正常 UI 路径会 process.exit，而非 resolve true。
): Promise<boolean> {
	// 解构首词和剩余参数，...rest 收集新数组。
	const [command, ...rest] = args;
	// 其他命令由主 CLI 继续处理。
	if (command !== "config") {
		// false 表示未接管，不是 config 执行失败。
		return false;
	}

	// 只要剩余任意位置有帮助开关就直接显示帮助，其他非法参数在此不再报告。
	if (rest.includes("-h") || rest.includes("--help")) {
		// 输出固定帮助，不创建设置或 TUI。
		printConfigCommandHelp();
		// 帮助请求已被处理，返回 true。
		return true;
	}

	// 默认从 global 设置模式打开界面。
	let local = false;
	// 没有信任覆盖时保留 undefined，之后可走扩展/已存/默认/UI。
	let projectTrustOverride: boolean | undefined;
	// 逐个解析 config 的剩余参数，不接受位置来源。
	for (const arg of rest) {
		// -l 和 --local 都要求初始编辑项目覆盖。
		if (arg === "-l" || arg === "--local") {
			// 把初始写范围标成 project；稍后仍要检查项目是否可信。
			local = true;
			// 识别命令级明确批准的长短形式。
		} else if (arg === "-a" || arg === "--approve") {
			// 保存 true，若后面出现拒绝则会被后值改写。
			projectTrustOverride = true;
			// 识别命令级明确不批准的长短形式。
		} else if (arg === "-na" || arg === "--no-approve") {
			// 保存 false，确保后续 ?? 不把拒绝当缺省。
			projectTrustOverride = false;
			// 以 - 开头但没匹配的项立刻报未知选项，不继续收集所有错误。
		} else if (arg.startsWith("-")) {
			// 红色错误指出实际未知选项与 config 命令。
			console.error(chalk.red(`Unknown option ${arg} for "config".`));
			// 给出总体帮助或本命令简要用法作为提示。
			console.error(chalk.dim(`Use "${APP_NAME} --help" or "${CONFIG_COMMAND_USAGE}".`));
			// 设置失败退出码，不在错误分支立即终止进程。
			process.exitCode = 1;
			// 虽然失败仍已接管该命令，所以返回 true。
			return true;
			// 剩余不带 - 的字符串也不允许，config 没有位置参数。
		} else {
			// 输出第一个多余参数，不把它当要编辑的资源路径。
			console.error(chalk.red(`Unexpected argument ${arg}.`));
			// 补充 config 的简要用法。
			console.error(chalk.dim(`Usage: ${CONFIG_COMMAND_USAGE}`));
			// 参数错误设置失败码。
			process.exitCode = 1;
			// 返回已处理，阻止主 CLI 把这组输入当聊天。
			return true;
		}
	}

	// 读取当前工作目录，用作项目资源及设置基准，目录不可用时可能抛错。
	const cwd = process.cwd();
	// 解析用户配置根，不在这里创建它。
	const agentDir = getAgentDir();
	// 等待创建设置与信任，解构取回管理器和警告；这一步不在本入口 catch 中。
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		// 属性简写传入当前项目目录。
		cwd,
		// 属性简写传入用户配置根。
		agentDir,
		// 保留命令行明确的批准/拒绝或 undefined。
		projectTrustOverride,
		// 向普通信任引导传运行时内联扩展，可初始化全局/内联信任处理器。
		extensionFactories: runtimeOptions.extensionFactories,
	});
	// 把信任引导的错误警告先打印到 stderr。
	reportProjectTrustWarnings(projectTrustWarnings);
	// 只有请求 project 初始写范围时才要求可信；global 模式不因项目不可信而被完全拒绝。
	if (local && !settingsManager.isProjectTrusted()) {
		// 项目写入未获允许时给出明确 --approve 提示，不自动批准。
		console.error(chalk.red("Project is not trusted. Use --approve to modify local resource config."));
		// 设失败码，后续不打开资源配置界面。
		process.exitCode = 1;
		// 这条错误命令已处理，返回 true。
		return true;
	}
	// 报告目前已记录的设置错误并清空队列；不等待此后 UI 的保存。
	reportSettingsErrors(settingsManager, "config command");
	// 从注入扩展中提取内置项名称，未提供列表时用空数组。
	const builtinExtensions = (runtimeOptions.extensionFactories ?? [])
		// 类型谓词筛掉裸函数与非 builtin:true 对象，成立后 TS 可读 name。
		.filter(isBuiltinExtension)
		// 只取名称交包资源解析器，不把工厂函数作为磁盘路径。
		.map((input) => input.name);
	// 另外创建 projectTrusted:false 的管理器，为 global 资源视图排除项目层。
	const globalSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	// 用全局设置解析器构造全局可配置资源列表，下面 resolve 可能安装缺包。
	const globalResolvedPaths = await new DefaultPackageManager({
		// 资源搜索项目基准仍是当前 cwd，但该管理器项目设置开关关闭。
		cwd,
		// 读取全局设置/资源的用户根。
		agentDir,
		// 此实例只看全局层，与用于最终 UI 写设置的管理器区分。
		settingsManager: globalSettingsManager,
		// 把已知内置扩展名交给解析器生成 builtin: 资源条目。
		builtinExtensions,
		// 等待全局资源解析；没有 onMissing 回调时，联网状态下缺包可自动安装并记录安装失败。
	}).resolve();
	// 项目可信才单独解析有效 global+project 视图。
	const projectResolvedPaths = settingsManager.isProjectTrusted()
		? // 可信时使用含项目层设置的管理器解析；可能发现/安装项目来源并读取资源路径。
			await new DefaultPackageManager({ cwd, agentDir, settingsManager, builtinExtensions }).resolve()
		: // 不可信时复用全局解析结果引用，不读项目视图。
			globalResolvedPaths;
	// 按格式化后的完整警告文字构造 Set 去重，不按包身份强行合并不同原因。
	const installWarnings = new Set(
		// 合并两份安装失败数组；缺省空数组，对同一解析对象的重复项稍后由 Set 折叠。
		[...(globalResolvedPaths.installFailures ?? []), ...(projectResolvedPaths.installFailures ?? [])].map(
			// 把每条失败转为单行来源/原因/移除建议文字。
			formatPackageInstallWarning,
		),
	);
	// 按 Set 首次插入顺序逐条展示去重后的警告。
	for (const warning of installWarnings) {
		// 黄色 Warning 写 stderr，不改变资源 enabled 状态。
		console.error(chalk.yellow(`Warning: ${warning}`));
	}

	// 打开终端配置界面并等待关闭；用户选择可能排队保存设置，本入口没有统一异常清理层。
	await selectConfig({
		// 把 global/project 两份资源列表放到具名字段供界面切换。
		resolvedPaths: { global: globalResolvedPaths, project: projectResolvedPaths },
		// 使用最终信任状态的设置管理器读写选择，而非仅全局解析器实例。
		settingsManager,
		// 界面知道当前项目目录，以便定位项目设置。
		cwd,
		// 界面也得到用户资源根。
		agentDir,
		// -l 只决定初始写范围；不带时为 global，不代表可信时不能 Tab 切 project。
		writeScope: local ? "project" : "global",
		// 只有当前管理器信任项目才开放 project 模式切换。
		projectModeAvailable: settingsManager.isProjectTrusted(),
	});

	// 界面正常关闭后请求进程成功退出，Node 类型声明为 never；本入口不额外 await flush，真实 process.exit 也不等待所有异步任务。
	process.exit(0);
}

// 处理 install/remove/uninstall/update/list，输入 argv 和内联扩展，返回 Promise<boolean>。false 仅表示不是本组命令；true 表示已处理，失败仍可为 true 并通过 process.exitCode=1 表达。
// 例 install ./pkg 检查本地来源后把来源加入配置，remove ./pkg 不删除该本地源码目录；列表来自配置，不保证每项已安装。update --models 提前走模型目录，普通 update 默认只升级 Pi。
// 包动作可联网、启动 npm/git/自定义命令并写/删文件；设置信任、报告错误、构造管理器在末尾 try 外，仍可能直接拒绝。try 内操作错误打印后设失败码，不回滚已发生的文件/进程/配置副作用。
export async function handlePackageCommand(
	// 传入原始 CLI argv，解析器会识别规范命令及 uninstall 别名。
	args: string[],
	// 运行时扩展注入项可省略，默认空对象。
	runtimeOptions: PackageCommandRuntimeOptions = {},
	// 返回是否接管，不把 true 当业务操作成功标志；错误还需看 process.exitCode。
): Promise<boolean> {
	// 先纯解析命令和首项参数错误，没有文件/进程副作用。
	const options = parsePackageCommand(args);
	// 首词不属于包命令时交还主 CLI。
	if (!options) {
		// 未接管返回 false，不打印错误。
		return false;
	}

	// 帮助优先于所有记录的错误，避免帮助操作触发安装/信任流程。
	if (options.help) {
		// 按解析得到的规范命令打印帮助。
		printPackageCommandHelp(options.command);
		// 帮助已处理，返回 true，不创建管理器。
		return true;
	}

	// 按既定优先级先报告未知选项，即便还存在其他错误。
	if (options.invalidOption) {
		// 红色说明哪个选项不属于当前规范子命令。
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		// 提示主帮助或对应子命令用法，不执行所展示命令。
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		// 记录失败码，交主 CLI 选择退出方式。
		process.exitCode = 1;
		// 已处理参数错误，不落入普通聊天。
		return true;
	}

	// 第二优先级报告 --extension 缺值等已记录问题。
	if (options.missingOptionValue) {
		// 输出缺失值的具体选项名。
		console.error(chalk.red(`Missing value for ${options.missingOptionValue}.`));
		// 给出该子命令简要用法。
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		// 设失败退出码。
		process.exitCode = 1;
		// 错误虽失败，仍返回已处理 true。
		return true;
	}

	// 接着检查多余位置参数。
	if (options.invalidArgument) {
		// 报告第一个意外参数，不试图批量安装多个来源。
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		// 再次提供本子命令的合法形式。
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		// 保留命令失败状态。
		process.exitCode = 1;
		// 结束该错误命令的处理。
		return true;
	}

	// 最后报告解析器发现的互斥目标或重复来源冲突。
	if (options.conflictingOptions) {
		// 直接显示解析器提供的首个冲突文字。
		console.error(chalk.red(options.conflictingOptions));
		// 附上对应命令的简要用法。
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		// 冲突组合不得继续更新，设失败码。
		process.exitCode = 1;
		// 返回已接管，避免错误输入继续到其他 CLI 功能。
		return true;
	}

	// 取出位置来源，update --extension 的来源仍保存在 updateTarget 而不是此变量。
	const source = options.source;
	// 安装/删除必须有非空位置来源，list/update 则按其他规则处理。
	if ((options.command === "install" || options.command === "remove") && !source) {
		// 指出缺少哪个命令的来源，而不是访问 undefined 路径。
		console.error(chalk.red(`Missing ${options.command} source.`));
		// 展示安装/删除的用法。
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		// 缺少必填来源，设置失败码。
		process.exitCode = 1;
		// 命令错误已处理，不构造管理器。
		return true;
	}

	// 模型目录目标在包/信任管理器创建前提前分流；可选链兼顾非 update 的空目标。
	if (options.command === "update" && options.updateTarget?.type === "models") {
		// 只捕获本次模型目录刷新错误。
		try {
			// 使用用户根创建/刷新模型目录，可按内部显式许可联网；这里不走包安装或项目信任流程。
			await refreshModelCatalogs(getAgentDir());
			// 收到刷新拒绝时规范化错误文字，不自动重试整个命令。
		} catch (error: unknown) {
			// Error 取 message，其他抛出值使用固定模型目录错误说明。
			const message = error instanceof Error ? error.message : "Unknown model catalog refresh error";
			// 把模型目录失败写 stderr，不冒充包安装失败。
			console.error(chalk.red(`Error: ${message}`));
			// 刷新失败设退出码 1，成功路径不改此码。
			process.exitCode = 1;
		}
		// 模型目录命令到此已处理，不再走包安装/自身升级。
		return true;
	}

	// 读取实际 cwd；这里在下面包动作 try 之外，失败可能直接拒绝入口。
	const cwd = process.cwd();
	// 解析用户数据根，后续管理器与信任库共用。
	const agentDir = getAgentDir();
	// 只有 install/remove 加 local 才属于本地包配置写入；list/update 不以这个条件拒绝整个命令。
	const writesProjectPackageConfig = (options.command === "install" || options.command === "remove") && options.local;
	// 等待设置与信任；构造/信任异常不被下面包动作 catch 包住。
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		// 传当前工作目录。
		cwd,
		// 传用户配置根。
		agentDir,
		// 命令行明确覆盖优先，false 不能当缺省。
		projectTrustOverride: options.projectTrustOverride,
		// update 仅采用保存的信任记录，不询问扩展/UI 或套默认 always。
		useSavedProjectTrustOnly: options.command === "update",
		// 普通包命令可用注入工厂提供信任处理；保存专用分支会跳过它们。
		extensionFactories: runtimeOptions.extensionFactories,
	});
	// 先输出信任阶段收集的警告。
	reportProjectTrustWarnings(projectTrustWarnings);
	// 请求写项目包配置但项目未信任时提前拒绝，不启动安装/删除。
	if (!settingsManager.isProjectTrusted() && writesProjectPackageConfig) {
		// 给出显式批准的提示，代码不自行替用户切为 trusted。
		console.error(chalk.red("Project is not trusted. Use --approve to modify local package config."));
		// 设置本次命令失败码。
		process.exitCode = 1;
		// 返回已处理，避免继续执行包动作。
		return true;
	}
	// 取走目前的设置错误；后续 setter 的异步保存错误不由这一次报告覆盖。
	reportSettingsErrors(settingsManager, "package command");
	// 自更新包管理器命令只读全局 npmCommand，不采用可信项目层对它的覆盖。
	const selfUpdateNpmCommand = settingsManager.getGlobalSettings().npmCommand;

	// 构造实际包管理器，路径会归一化；它的动作可启动 npm/git，但构造本身不安装。
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	// Update result events describe a changed package, e.g. "npm:foo 1.2.0 -> 1.3.0".
	// 记录 update/result 事件的消息文字，每条事件一项，不额外按包身份去重。
	const updatedPackages: string[] = [];
	// Progress messages are warnings, e.g. npm reinstalled the old version from stale registry metadata.
	// 累计带文字的 progress 事件数，在 update 汇总时判断是否有警告。
	let warningCount = 0;
	// 安装同步进度接收器，收到事件时保存结果或写 stdout；不返回调度决策，但回调内的输出异常仍可能传播。
	packageManager.setProgressCallback((event) => {
		// 只把有文字的 update/result 作为已变化项摘要。
		if (event.type === "result" && event.action === "update" && event.message) {
			// 保存该结果消息，最终计数等于消息条数，不独立证明唯一包数。
			updatedPackages.push(event.message);
			// start 事件展示开始信息；其 message 在接口中可选，这里直接做模板插值。
		} else if (event.type === "start") {
			// 以弱化样式写 stdout 并明确加 LF，不把开始提示计为警告。
			process.stdout.write(chalk.dim(`${event.message}\n`));
			// 有文字的 progress 在本 CLI 作为警告展示；complete/error 事件不由此分支打印。
		} else if (event.type === "progress" && event.message) {
			// 每条警告事件增加计数，最终摘要据此避免无依据宣称已最新。
			warningCount++;
			// 黄色警告写 stdout，和前面项目信任/设置警告使用 stderr 的路径不同。
			process.stdout.write(chalk.yellow(`${event.message}\n`));
		}
	});

	// 只有下面 switch 包动作在这个总 catch 内；前面的信任/设置/管理器构造已完成。
	try {
		// 按规范命令分流，uninstall 已经变成 remove。
		switch (options.command) {
			// 安装一个来源并加入对应作用域的设置。
			case "install":
				// source! 是 TS 非空断言，依据上方必填检查；先实际安装再 setter 排队保存，本层不 await flush。
				await packageManager.installAndPersist(source!, { local: options.local });
				// installAndPersist 的 Promise 完成后打印安装成功，不额外核实排队的设置写盘是否成功。
				console.log(chalk.green(`Installed ${source}`));
				// 结束安装命令，主 CLI 随后可按 exitCode 退出。
				return true;

			// 删除分支用局部花括号隔离 removed 变量。
			case "remove": {
				// 先执行管理器 remove 再移除配置项；本地路径来源不会删原源码目录。布尔返回仅说明配置列表是否改变。
				const removed = await packageManager.removeAndPersist(source!, { local: options.local });
				// 没有匹配配置记录时按失败处理，即便底层删除动作可能已经发生。
				if (!removed) {
					// 输出未匹配来源说明，不把返回 false 当静默成功。
					console.error(chalk.red(`No matching package found for ${source}`));
					// 未匹配设置项使本命令失败。
					process.exitCode = 1;
					// 失败也返回已处理 true。
					return true;
				}
				// 配置列表确有变动时打印删除成功；不额外确认设置保存队列成功落盘。
				console.log(chalk.green(`Removed ${source}`));
				// 结束删除分支。
				return true;
			}

			// list 展示配置中的来源，而非完整磁盘包扫描。
			case "list": {
				// 读取 global/project 配置列表并尝试定位安装路径；用户 npm 旧布局可触发只读 root/list 子进程探测。
				const configuredPackages = packageManager.listConfiguredPackages();
				// 按 user scope 筛出全局用户项，生成新数组且不更改配置。
				const userPackages = configuredPackages.filter((pkg) => pkg.scope === "user");
				// 按 project scope 筛项目项；不可信项目设置通常已被排除。
				const projectPackages = configuredPackages.filter((pkg) => pkg.scope === "project");

				// 没有任何配置项时走空列表文案；不是独立证明磁盘完全没有其他包。
				if (configuredPackages.length === 0) {
					// 打印既有 No packages installed 文案，实际条件仅是配置列表为空。
					console.log(chalk.dim("No packages installed."));
					// 空列表已处理，无须继续打印范围标题。
					return true;
				}

				// 本地格式化回调接收列表元素类型，依次打印来源/可选安装路径，返回 void；typeof 加 [number] 提取数组元素静态类型。
				const formatPackage = (pkg: (typeof configuredPackages)[number]) => {
					// filtered 表示配置项使用对象形状，显示标记；不据此宣称资源实际全部被排除。
					const display = pkg.filtered ? `${pkg.source} (filtered)` : pkg.source;
					// 用两个空格缩进打印来源，不对字符串做额外 shell 解析。
					console.log(`  ${display}`);
					// 只有找到安装路径时才显示第二行，不要求每个配置包都已安装。
					if (pkg.installedPath) {
						// 弱化显示安装路径，不在这里打开文件或启动包代码。
						console.log(chalk.dim(`    ${pkg.installedPath}`));
					}
				};

				// 用户项非空才打印对应范围段。
				if (userPackages.length > 0) {
					// 用户设置范围用加粗标题，与项目范围分开。
					console.log(chalk.bold("User packages:"));
					// 按配置原顺序遍历用户项，不在这里按名字排序或去重。
					for (const pkg of userPackages) {
						// 调用本地打印器输出此项来源和可选路径。
						formatPackage(pkg);
					}
				}

				// 项目项非空才打印项目段。
				if (projectPackages.length > 0) {
					// 前面已有用户段时加空行，避免空列表也输出多余分隔。
					if (userPackages.length > 0) console.log();
					// 加粗标记项目配置包段。
					console.log(chalk.bold("Project packages:"));
					// 按项目配置原顺序遍历这些项。
					for (const pkg of projectPackages) {
						// 复用同一输出回调，不修改项目包设置。
						formatPackage(pkg);
					}
				}

				// 列表命令完成返回 true，即使部分项没有 installedPath。
				return true;
			}

			// 更新分支可以分别调包管理器、自定义命令、托管更新或普通全局包更新。
			case "update": {
				// 正常解析器已提供目标；若没有则回退 self，不默认 all。
				const target = options.updateTarget ?? { type: "self" };
				// 只有完全默认的 update 才提示未包含扩展包。
				if (options.showExtensionsSkippedNote) {
					// 打印默认范围提醒，不表示包更新失败。
					console.log(
						// 说明要更新扩展需显式 --extensions；这里不执行所展示命令。
						chalk.dim(`Extensions are skipped. Run ${APP_NAME} update --extensions to update extensions.`),
					);
				}
				// 目标包含 extensions/all 时，先更新包，再考虑自身；前面的包副作用不会因后续自身失败回滚。
				if (updateTargetIncludesExtensions(target)) {
					// 单包目标传其 source，all 则 undefined 表示管理器更新全范围配置包。
					const updateSource = target.type === "extensions" ? target.source : undefined;
					// 等待实际包更新检查/安装/git 操作；固定 npm 版本和本地来源等仍按核心策略跳过。
					await packageManager.update(updateSource);
					// Only claim "up to date" when the update actually checked and nothing warned.
					// 按核心包管理器的 1/true/yes 环境规则识别离线，和版本查询的任意非空规则不同。
					if (isOfflineModeEnabled()) {
						// 离线跳过时明确说明，避免宣称已经核实包都是最新。
						console.log(chalk.yellow("Skipped package updates (offline mode)"));
						// 没有变化结果但收到警告时，使用未更新提醒而非已最新。
					} else if (updatedPackages.length === 0 && warningCount > 0) {
						// 开始展示有警告、无更新的摘要。
						console.log(
							// 警告摘要用黄色，不设失败码或再次运行更新。
							chalk.yellow(
								// 有单包来源时使用更具体的提示文字。
								updateSource
									? // 单包分支点名没有更新的来源。
										`${updateSource} was not updated, see the warnings above`
									: // 全范围分支提示没有包被更新并让用户看上方警告。
										"No packages were updated, see the warnings above",
							),
						);
						// 既非离线，也无变化结果且没警告，才采用已最新文案；这里只依据这些观察，不独立扫描所有包。
					} else if (updatedPackages.length === 0) {
						// 向 stdout 输出无变化且无警告的状态说明。
						console.log(
							// 给正常状态文字着绿色。
							chalk.green(
								// 单来源点名，全部包用复数文案；不在此核实每项为何被核心更新策略跳过。
								updateSource ? `${updateSource} is already up to date` : "Packages are already up to date",
							),
						);
						// 存在已变化结果消息时，打印变化摘要列表。
					} else {
						// 数量就是记录的结果消息条数，没有额外身份去重。
						const count = updatedPackages.length;
						// 按 count===1 选择英文单复数，模板插值只用于展示。
						console.log(chalk.green(`Updated ${count} package${count === 1 ? "" : "s"}:`));
						// 依事件收集顺序输出每条变化摘要。
						for (const message of updatedPackages) {
							// 缩进显示核心管理器提供的变化文字，不重新计算版本差。
							console.log(`  ${message}`);
						}
					}
				}
				// 目标包含自身时再进入 Pi 更新；仅 extensions 目标到后面直接返回。
				if (updateTargetIncludesSelf(target)) {
					// 解析用户显式配置的自更新 argv，环境覆盖优先。
					const configuredSelfUpdateArgv = getConfiguredSelfUpdateArgv(
						// 只从 global selfUpdateCommand 取设置值，不使用项目配置的命令。
						settingsManager.getGlobalSettings().selfUpdateCommand,
					);
					// A configured command is explicit user intent, so it replaces the managed install path too.
					// 显式用户命令优先级高于托管安装路径；有配置时甚至不调用托管根识别。
					const managedInstallRoot = configuredSelfUpdateArgv ? undefined : getActiveManagedInstallRoot();
					// 托管路径不支持 --force，必须在发布查询或安装前拒绝。
					if (managedInstallRoot && options.force) {
						// 输出托管强制重装不支持的错误。
						console.error(
							// 红色仅强调说明，不执行修复。
							chalk.red(
								// 提示重新运行安装器进行修复；这行不下载或执行安装脚本。
								`Managed ${APP_NAME} installations do not support --force; rerun the installer to repair this installation.`,
							),
						);
						// 明确不支持的强制托管更新设失败码。
						process.exitCode = 1;
						// 拒绝后结束，连最新版本查询也不做。
						return true;
					}
					// 联网查询目标并判断是否需要执行；即使配置用户命令，也先需要发布计划。
					const selfUpdatePlan = await getSelfUpdatePlan(options.force);
					// 候选不更新且未 force 时不启动任何更新命令。
					if (!selfUpdatePlan.shouldRun) {
						// 计划无需执行，直接结束命令。
						return true;
					}
					// 用户明确配置的命令分支优先于托管和安装器检测。
					if (configuredSelfUpdateArgv) {
						// 替换占位符、执行用户命令并探测目标版本；该辅助函数可以捕获执行失败设 exitCode。
						await runConfiguredSelfUpdate(configuredSelfUpdateArgv, selfUpdatePlan);
						// 已走用户配置路径就结束，不继续备用安装器。
						return true;
					}
					// 没有自定义命令且识别到托管根，走固定清单/lockfile 更新路径。
					if (managedInstallRoot) {
						// 托管更新前可显示发布说明。
						if (selfUpdatePlan.note) {
							// 将远端提示渲染到终端，失败时辅助函数自带纯文字回退。
							printSelfUpdateNote(selfUpdatePlan.note);
						}
						// 单独捕获托管下载、安装、验证、激活或清理错误。
						try {
							// 先提示正在更新托管安装。
							console.log(chalk.dim(`Updating managed ${APP_NAME} installation...`));
							// 等待拿锁、暂存安装、版本输出检查和切换；会真实联网、npm ci、写删文件。
							await runManagedSelfUpdate(managedInstallRoot, selfUpdatePlan.version);
							// 捕获任意阶段的托管更新拒绝；失败可能发生在切换活动指针之后。
						} catch (error: unknown) {
							// Error 取 message，非 Error 使用托管更新固定回退文字。
							const message = error instanceof Error ? error.message : "Unknown managed update error";
							// 向 stderr 报错，不回滚已切换指针或此前成功的包更新。
							console.error(chalk.red(`Error: ${message}`));
							// 托管更新失败设命令失败码。
							process.exitCode = 1;
							// 失败处理完结束，不再尝试普通 npm 自更新。
							return true;
						}
						// 托管更新函数完成后报告从运行版本到目标版本，不改本进程已加载代码。
						console.log(chalk.green(`Updated ${APP_NAME} from ${VERSION} to ${selfUpdatePlan.version}`));
						// 托管路径完成，结束命令。
						return true;
					}

					// 剩余普通自更新路径按运行时/安装路径启发式识别安装方式。
					const installMethod = detectInstallMethod();
					// Windows 只允许普通 npm/pnpm 安装器分支；自定义命令和托管路径此前已独立处理。
					if (process.platform === "win32" && installMethod !== "npm" && installMethod !== "pnpm") {
						// 打印当前平台不支持这一安装方式自动更新。
						console.error(
							// 错误说明只允许 Windows 普通 npm/pnpm 自更新，不是在判定整个 Pi 是否支持 Windows。
							chalk.red(`${APP_NAME} self-update on Windows is only supported for npm and pnpm installs.`),
						);
						// 展示实际检测结果并提示手动维护，不执行手动操作。
						console.error(chalk.dim(`Detected install method: ${installMethod}. Update ${APP_NAME} manually.`));
						// 不支持的普通 Windows 更新设失败码。
						process.exitCode = 1;
						// 停止而不猜另一套安装命令。
						return true;
					}
					// 构造逻辑包名与明确版本安装规格，支持活动包名改变。
					const selfUpdateTarget = {
						// 逻辑包名来自发布计划，可能和当前 PACKAGE_NAME 不同。
						packageName: selfUpdatePlan.packageName,
						// 明确安装规格保留目标版本，而不是只安装无版本包名。
						installSpec: selfUpdatePlan.installSpec,
					};
					// 调用统一辅助函数检查安装方式、全局归属与写权限并生成计划；其中可运行只读包管理器探测。
					const selfUpdateCommand = getSelfUpdateCommand(PACKAGE_NAME, selfUpdateNpmCommand, selfUpdateTarget);
					// 没有可执行计划就输出人工说明并失败，不直接执行猜测命令。
					if (!selfUpdateCommand) {
						// 给出包装器/目标相关的维护建议及入口位置。
						printSelfUpdateUnavailable(selfUpdateNpmCommand, selfUpdateTarget);
						// 没有自动计划时设命令失败码。
						process.exitCode = 1;
						// 结束无法自动更新的命令。
						return true;
					}
					// 实际普通更新前也可显示发布说明。
					if (selfUpdatePlan.note) {
						// 复用同一终端 Markdown 提示器，不改发布正文。
						printSelfUpdateNote(selfUpdatePlan.note);
					}
					// 把 Windows 原生库准备与更新步骤一起捕获，但不提供回滚。
					try {
						// 只有 npm 安装方式才需要进入 Windows 原生库准备助手；该助手自己再查平台。
						if (installMethod === "npm") {
							// Windows 可真实搬移/复制已加载依赖，其他平台助手直接返回。
							prepareWindowsNpmSelfUpdate();
						}
						// 依计划顺序真实运行包管理器步骤；步骤成功不在这条路径另查 PATH 版本。
						await runSelfUpdate(selfUpdateCommand);
						// 命令/原生库准备失败都走这里，可能已有部分文件/卸载动作完成。
					} catch (error: unknown) {
						// 统一取 Error.message 或固定包命令错误文字。
						const message = error instanceof Error ? error.message : "Unknown package command error";
						// 把普通自更新失败写 stderr。
						console.error(chalk.red(`Error: ${message}`));
						// 只有检测为 pnpm 时额外提示元数据缓存可能过旧。
						if (installMethod === "pnpm") {
							// 打印 prune 建议，本行不会真的执行 prune。
							printPnpmSelfUpdateMetadataHint();
						}
						// 展示当前计划的手动重试命令，不自行再次执行。
						printSelfUpdateFallback(selfUpdateCommand);
						// 记录普通自更新失败码。
						process.exitCode = 1;
						// 失败后不继续打印成功或迁移安装器提示。
						return true;
					}
					// 命令全部退出成功后直接打印更新成功；和自定义命令辅助函数不同，此路径没有额外版本重查。
					console.log(chalk.green(`Updated ${APP_NAME} from ${VERSION} to ${selfUpdatePlan.version}`));
					// The pi.dev installer migrates global npm installs to a managed install
					// that pins all dependencies. It does not migrate pnpm, yarn, or bun installs.
					// 只有 npm 布局额外建议迁移到依赖锁定的托管安装；不是自动迁移。
					if (installMethod === "npm") {
						// 为当前平台选择一条仅供展示的安装脚本文字。
						const installerCommand =
							// Windows 选择 PowerShell 提示，其他平台选择 curl/sh 提示。
							process.platform === "win32"
								? // Windows 示例会下载并执行安装器，但本行只是字符串，CLI 在此不运行它。
									'powershell -c "irm https://pi.dev/install.ps1 | iex"'
								: // Unix 示例同样只保存在字符串里，不在这里联网或启动 sh。
									"curl -fsSL https://pi.dev/install.sh | sh";
						// 迁移建议前输出空行。
						console.log();
						// 打印普通 npm 安装不锁定全部传递依赖的既有说明。
						console.log(chalk.yellow(`This npm installation of ${APP_NAME} does not pin its dependencies.`));
						// 建议用安装器切到托管安装，不调用安装器。
						console.log(chalk.yellow("Run the installer to migrate to a managed installation that does:"));
						// 把建议文字与实际示例命令隔开。
						console.log();
						// 加粗展示选中的安装器命令，仅写 stdout。
						console.log(`  ${chalk.bold(installerCommand)}`);
					}
				}
				// 更新各目标分支处理完后返回 true；是否成功仍需结合 exitCode。
				return true;
			}
		}
		// 捕获 switch 内未被局部 catch 处理的异常；前面的设置/信任/构造不在这个范围。
	} catch (error: unknown) {
		// Error 使用原消息，其余异常用固定回退文本。
		const message = error instanceof Error ? error.message : "Unknown package command error";
		// 统一写 stderr，但不会撤销已经执行的安装、删除、配置或活动版本切换。
		console.error(chalk.red(`Error: ${message}`));
		// 操作失败设进程退出码，交主 CLI 退出。
		process.exitCode = 1;
		// 返回命令已接管，不能把此 true 理解为操作成功。
		return true;
	}
}
