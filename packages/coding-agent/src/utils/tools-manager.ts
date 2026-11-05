// 为find/grep和交互启动寻找fd/rg，必要时从GitHub下载预构建工具；不负责模型工具执行、包管理器安装或沙箱隔离。
// 本模块导入时只定位bin目录；getToolPath会执行系统候选的--version，ensureTool在缺工具且允许时才发网络请求并落盘。
import { type SpawnSyncReturns, spawnSync } from "child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "fs";
import { arch, platform } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { getBinDir, VERSION } from "../config.ts";
import { fetchWithRetry } from "./management-http.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

// 路径从config统一取得，兼容配置根覆盖；模块加载后保存该值，并非每次请求都重新读取环境。
const TOOLS_DIR = getBinDir();
// 版本重定向请求和归档下载分别给管理HTTP helper总体预算；解压子进程本身没有在此设置超时。
const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

// 无输入，读取PI_OFFLINE返回是否禁用自动下载，无I/O；例如1/TRUE/yes启用，0/false/任意其他文字不启用。
// 与version-check中“任何非空PI_OFFLINE都跳过”的判断不同，本函数不trim空白，也不屏蔽getToolPath的本地进程探测。
function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	// 环境值是string|undefined，缺失和空串都表示未启用。
	if (!value) return false;
	// ===精确比较，toLowerCase只让true/yes大小写不敏感。
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

// 一种受管理工具的元数据；这是TypeScript接口，不会自动校验下载内容或系统二进制身份。
interface ToolConfig {
	// 面向用户的显示名，ripgrep的命令名实际是rg。
	name: string;
	// GitHub仓库标识owner/repo，用来拼版本查询和归档下载地址。
	repo: string; // GitHub repo (e.g., "sharkdp/fd")
	// 归档里期待的程序基名，Windows在使用处另加.exe。
	binaryName: string; // Name of the binary inside the archive
	// 可选系统命令候选表，?表示可省略；实际查找优先受管理bin目录，之后才用这些名字。
	systemBinaryNames?: string[]; // Alternative system command names to try before downloading
	// GitHub标签前缀，例如fd下载标签v10.3.0需v，而rg标签直接用版本数字。
	tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
	// 函数属性接收不带前导v的版本和平台后缀，返回归档文件名；表中的实现只拼字符串、无I/O。
	getAssetName: (version: string, target: string) => string;
}

// Map Node's platform/arch to the release target suffix shared by fd and ripgrep.
// Only x64 and arm64 are mapped. Other architectures (e.g. ARM32 `arm`, `ia32`)
// must not fall back to x86-64 binaries (#11209).
// 输入Node平台/架构名，返回发行包目标后缀或undefined，无副作用；例如linux+arm64得到aarch64-unknown-linux-musl.tar.gz。
// 仅列出支持组合，不把arm/ia32猜成x64；也不探测实际libc或验证本机确实能执行该包。
function getReleaseTarget(plat: string, architecture: string): string | undefined {
	// 嵌套三元先映射架构，未知得到undefined；后面提前返回收窄类型为string。
	const archStr = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : undefined;
	if (!archStr) return undefined;
	// 不同平台同时选择目标三元组和压缩格式，Windows用zip，其余两个用tar.gz。
	if (plat === "darwin") return `${archStr}-apple-darwin.tar.gz`;
	if (plat === "linux") return `${archStr}-unknown-linux-musl.tar.gz`;
	if (plat === "win32") return `${archStr}-pc-windows-msvc.zip`;
	return undefined;
}

// Record把字符串键映射为ToolConfig；对外API用"fd"|"rg"限制选择，本表自身仍是普通可索引对象。
const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		// 某些发行版把fd命令安装成fdfind，探测时按此顺序尝试。
		systemBinaryNames: ["fd", "fdfind"],
		tagPrefix: "v",
		getAssetName: (version, target) => `fd-v${version}-${target}`,
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		getAssetName: (version, target) => `ripgrep-${version}-${target}`,
	},
};

// Check if a command exists in PATH by trying to run it
// 输入命令名，同步执行--version后返回有没有spawn错误；会启动本机程序并阻塞当前线程，异常返回false。
// 例如程序存在但以非零码退出仍可能返回true：这里只检查result.error，不校验status、版本内容或工具身份，也未设子进程超时。
function commandExists(cmd: string): boolean {
	try {
		// 未启用shell，命令名由PATH解析，stdout/stderr捕获后不显示给用户。
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		// Check for ENOENT error (command not found)
		return result.error === undefined || result.error === null;
	} catch {
		// spawnSync本身同步抛错也按“不可用”处理。
		return false;
	}
}

// Get the path to a tool (system-wide or in our tools dir)
// 输入fd/rg，优先返回受管理bin里的路径，否则依次探测PATH候选并返回命令名，均无则null；不下载。
// 例如本地bin/fd存在就直接采用，不检查执行权限/文件类型；返回fdfind时只是命令名而非已锁定的绝对路径。
export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	// 保留原来的缺配置分支，不因TS联合类型而重写行为。
	if (!config) return null;

	// Check our tools directory first
	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	// existsSync只说明路径当前存在，不验证它就是期待的安全版本。
	if (existsSync(localPath)) {
		return localPath;
	}

	// Check system PATH - if found, just return the command name (it's in PATH)
	// ??只在未配置候选时用单个binaryName；配置空数组则不试系统命令。
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		// 顺序探测，首个可启动候选立即返回，调用方之后实际执行时会再次由PATH解析。
		if (commandExists(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

// Resolve the latest release version from the release page redirect.
// The api.github.com releases endpoint counts against the anonymous API
// quota (60 requests/hour per IP), which is permanently exhausted behind
// shared egress IPs such as corporate proxies and CI runners. The web
// endpoint answers with a redirect to the tagged release at no quota cost
// and lives on the same origin as the binary download itself.
// 输入GitHub owner/repo，发管理GET并读重定向标签，返回去掉一个前导v的版本字符串；网络/意外响应/URL解码失败会拒绝。
// 例如/sharkdp/fd/releases/tag/v10.4.2得到10.4.2；仅检查重定向状态、location含标签路由和末段，不做完整semver/目标仓库身份验证。
export async function getLatestVersion(repo: string): Promise<string> {
	// helper默认额外重试两次，10秒信号预算贯穿尝试；manual不自动跟到发行页正文。
	const response = await fetchWithRetry(
		`https://github.com/${repo}/releases/latest`,
		{
			// 使用当前Pi版本的管理User-Agent，不是下载工具本身的版本。
			headers: { "User-Agent": getPiUserAgent(VERSION) },
			redirect: "manual",
		},
		{ timeoutMs: NETWORK_TIMEOUT_MS },
	);

	// Only the status and headers matter here. Discard the body so the
	// connection can be reused.
	try {
		// 可选body不存在时await undefined也能完成，取消失败忽略，不妨碍读响应头。
		await response.body?.cancel();
	} catch {
		// Discarding the body is best-effort.
	}

	// 只把3xx当重定向；200即使有location也会按缺重定向报错。
	const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
	if (!location) {
		throw new Error(`Failed to resolve latest ${repo} release: HTTP ${response.status} without redirect`);
	}

	// 相对location按GitHub根解析，取pathname末段；不跟随第二跳，也不检查版本字符串是否为数字。
	const tag = new URL(location, "https://github.com").pathname.split("/").pop();
	if (!tag || !location.includes("/releases/tag/")) {
		throw new Error(`Failed to resolve latest ${repo} release: unexpected redirect to ${location}`);
	}
	// %编码先解开，再只去掉开头一个小写v；格式错误的%转义可抛URIError。
	return decodeURIComponent(tag).replace(/^v/, "");
}

// Download a file from URL
// 输入URL和目标路径，流式把成功HTTP响应写到文件，完成无返回值；请求/流/写盘失败拒绝，现有文件可能被截断。
// 例如工具归档下载到bin下；HTTP请求helper会重试响应/传输阶段，但pipeline里的正文中途失败不由此函数重试，也没有哈希/签名校验。
async function downloadFile(url: string, dest: string): Promise<void> {
	// 120秒传给fetch信号；不是独立包围所有文件系统和后续解压步骤的硬超时。
	const response = await fetchWithRetry(url, undefined, { timeoutMs: DOWNLOAD_TIMEOUT_MS });

	// fetch对HTTP 404通常返回Response而非throw，故需显式检查ok。
	if (!response.ok) {
		throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
	}

	// 成功状态却无流也无法保存归档，明确抛错而不是生成空文件假成功。
	if (!response.body) {
		throw new Error("No response body");
	}

	// createWriteStream实际打开/写入目标；Node流pipeline负责背压与相关流错误传播。
	const fileStream = createWriteStream(dest);
	// 保留现有as any类型桥接：把Web流转Node Readable，断言本身不做运行时转换或验证，fromWeb才执行适配。
	await pipeline(Readable.fromWeb(response.body as any), fileStream);
}

// 输入解压根目录和精确文件名，同步深度优先查找普通文件，返回首个路径或null；读目录错误可抛出。
// 例如归档多嵌套一层fd-v...仍可找到fd；显式栈代替函数递归，不跟随Dirent符号链接目录，不验证文件可执行或来源。
function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	// string[]限制栈元素类型；pop是后进先出，遍历顺序取决于实际目录枚举顺序。
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		// pop的类型含undefined，现有分支也会跳过空字符串路径。
		if (!currentDir) continue;

		// withFileTypes返回Dirent，isFile/isDirectory检查该目录项而非读文件内容。
		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			// 名字完全相同且普通文件才返回，不靠后缀模糊猜测。
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}
			// 目录先压栈，当前目录枚举完成后继续找，不展开符号链接。
			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

// 输入spawnSync结果，按启动错误→非空stderr→非空stdout→退出码生成一句失败详情，无额外I/O。
// 例如tar不存在优先显示error.message，code=2且有stderr则显示它；status为null且没有输出显示unknown，不分析信号字段。
function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
	// 可选链先确认error存在，再取message，保留实际启动错误优先级。
	if (result.error?.message) {
		return result.error.message;
	}
	// 输出可能为空，转默认UTF8并trim仅用于错误展示，不解释为解压结果数据。
	const stderr = result.stderr?.toString().trim();
	if (stderr) {
		return stderr;
	}
	const stdout = result.stdout?.toString().trim();
	if (stdout) {
		return stdout;
	}
	// ??保留status=0；调用者只在认为失败时使用此描述。
	return `exit status ${result.status ?? "unknown"}`;
}

// 输入解压程序/argv，同步启动，只有无error且status=0返回null成功，否则返回带命令名的详情；同步spawn抛错仍可传出。
// 例如unzip退出1即视为失败供另一个候选尝试；没有shell、执行超时或归档路径净化，阻塞直到子进程结束。
function runExtractionCommand(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { stdio: "pipe" });
	if (!result.error && result.status === 0) {
		return null;
	}
	return `${command}: ${formatSpawnFailure(result)}`;
}

// 输入归档路径、解压目录、展示名，运行tar xzf到目录，无返回；失败抛带归档名的Error。
// 例如foo.tar.gz解到临时目录；是否限制归档成员路径取决于外部tar行为，本包装器不自行枚举/验证成员。
function extractTarGzArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
	// null表示成功，非空字符串直接用于错误说明。
	if (failure) {
		throw new Error(`Failed to extract ${assetName}: ${failure}`);
	}
}

// 无输入，为Windows ZIP解压选系统tar.exe路径；存在SystemRoot/System32/tar.exe就返回，否则返回PATH命令名，无进程启动。
// 例如避开Git Bash的GNU tar；这里只检查存在，不验证签名或可执行性，SystemRoot来自当前环境。
function getWindowsTarCommand(): string {
	const systemRoot = process.env.SystemRoot;
	if (systemRoot) {
		const systemTar = join(systemRoot, "System32", "tar.exe");
		if (existsSync(systemTar)) {
			return systemTar;
		}
	}
	return "tar.exe";
}

// 输入zip路径、解压目录和展示名，同步按平台尝试解压器，首个成功结束，全部失败拼接详情抛错。
// Windows系统tar→PowerShell Expand-Archive，其他平台unzip→tar；例如tar不支持zip时切到下一候选，不是下载其他工具。
// 外部命令可写解压文件，失败可能已留下部分输出；不实现归档沙箱、原子事务或执行超时。
function extractZipArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failures: string[] = [];

	// platform读取真实宿主（测试可mock），决定候选顺序。
	if (platform() === "win32") {
		// Windows ships bsdtar as tar.exe, which supports zip files. Prefer the
		// System32 binary over Git Bash's GNU tar, which does not handle zip archives.
		const tarFailure = runExtractionCommand(getWindowsTarCommand(), ["xf", archivePath, "-C", extractDir]);
		// 首选成功立即返回，失败详情入数组留给最终汇总。
		if (!tarFailure) return;
		failures.push(tarFailure);

		const script =
			"& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
		// 脚本内容保留原样，路径作为参数传入；Bypass是该PowerShell进程执行策略选项，不是安全沙箱。
		const powershellFailure = runExtractionCommand("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
			archivePath,
			extractDir,
		]);
		if (!powershellFailure) return;
		failures.push(powershellFailure);
	} else {
		// -q减少普通输出，-d指定目标；失败后用tar再次尝试同一zip。
		const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
		if (!unzipFailure) return;
		failures.push(unzipFailure);

		const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);
	}

	// join保留各候选失败原因，便于知道是缺命令还是解压报错。
	throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
}

// Download and install a tool
// 输入fd/rg，选目标/版本→下载归档→建独立解压目录→找二进制→rename到bin→Unix chmod，返回最终路径；失败拒绝。
// 例如darwin/x64的fd固定10.3.0不查询最新版；其他组合查询GitHub。会联网、运行解压器和写盘，调用方负责是否允许。
// 清理仅覆盖进入try后的归档/解压目录；下载或建目录之前失败可留归档，rename/chmod不构成可回滚事务，同工具并发也无锁。
async function downloadTool(tool: "fd" | "rg"): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();
	// 直接调用本私有函数也重新确认支持组合，避免误构造不兼容下载名。
	const target = getReleaseTarget(plat, architecture);
	if (!target) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	// fd is pinned on darwin/x64, so skip the version lookup there.
	// 三元分支只有未固定版本时才await网络查询；asset函数把版本与目标后缀组合。
	const version =
		tool === "fd" && plat === "darwin" && architecture === "x64" ? "10.3.0" : await getLatestVersion(config.repo);
	const assetName = config.getAssetName(version, target);

	// Create tools directory
	// recursive允许目录已存在，失败直接抛；目录与归档不放系统临时根。
	mkdirSync(TOOLS_DIR, { recursive: true });

	// tagPrefix适配fd的v标签与rg无v标签；assetName同时作为bin目录中的下载文件名。
	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const archivePath = join(TOOLS_DIR, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	// Download
	// 这个await位于下面try之外，因此下载过程中失败不执行下面finally。
	await downloadFile(downloadUrl, archivePath);

	// Extract into a unique temp directory. fd and rg downloads can run concurrently
	// during startup, so sharing a fixed directory causes races.
	// 工具名、PID、时间、随机后缀降低解压目录冲突；归档文件名和最终binaryPath本身仍是固定的。
	const extractDir = join(
		TOOLS_DIR,
		`extract_tmp_${config.binaryName}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(extractDir, { recursive: true });

	try {
		// 仅支持表中两种归档后缀，不根据响应Content-Type动态选择程序。
		if (assetName.endsWith(".tar.gz")) {
			extractTarGzArchive(archivePath, extractDir, assetName);
		} else if (assetName.endsWith(".zip")) {
			extractZipArchive(archivePath, extractDir, assetName);
		} else {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		// Find the binary in extracted files. Some archives contain files directly
		// at root, others nest under a versioned subdirectory.
		// 先试“去压缩后缀的目录/文件名”和根文件名，没找到才遍历所有子目录。
		const binaryFileName = config.binaryName + binaryExt;
		const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
		const extractedBinaryCandidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
		let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));

		if (!extractedBinary) {
			// 私有搜索返回null，??转换为当前变量允许的undefined，不改变后续真值分支。
			extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
		}

		if (extractedBinary) {
			// 移动到受管理路径；目标已存在/文件被占用等平台错误可抛，不保留旧版备份。
			renameSync(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
		}

		// Make executable (Unix only)
		// 0755赋予所有者读写执行、其他用户读执行；Windows不使用该Unix权限设置。
		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
		}
	} finally {
		// Cleanup
		// force忽略不存在，不忽略所有权限/占用错误；首个rm抛错也可能阻止第二次清理，并覆盖原错误。
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

// Termux package names for tools
// Android只给用户安装命令提示，不自行执行pkg；fd与ripgrep的包名不同。
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

export interface ToolStatus {
	// 字符串字面量联合只允许两种级别，回调决定如何展示。
	type: "info" | "warning";
	// 面向调用者的展示文字，内部不把它自动写console或转成异常。
	message: string;
}

/**
 * Ensure a tool is available, downloading if necessary.
 * Reports progress through `onStatus`; status messages are otherwise silent.
 * Returns the tool path, or undefined if unavailable.
 */
// 输入工具名和可选状态回调，优先复用本地/系统工具，离线/Android/不支持目标时警告并undefined，否则尝试下载。
// 例如ensureTool("rg",s=>showStatus(s))安装成功返回路径；普通下载异常转换为警告，但回调本身抛错仍可能使Promise拒绝。
// 已有工具检测和下载前回调在try之外；成功回调在try内，若它抛错会进入下载失败处理，不应理解为所有异常都被吞掉。
export async function ensureTool(
	tool: "fd" | "rg",
	onStatus?: (status: ToolStatus) => void,
): Promise<string | undefined> {
	// 先检查现成工具，即使启用了离线模式仍可返回已有工具。
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	if (isOfflineModeEnabled()) {
		// 可选调用?.()：没回调就静默，不自动console打印警告。
		onStatus?.({ type: "warning", message: `${config.name} not found. Offline mode enabled, skipping download.` });
		return undefined;
	}

	// On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
	// Users must install via pkg.
	if (platform() === "android") {
		// ??让未列出的工具仍能退回自身名称，当前公有工具联合仅fd/rg。
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		onStatus?.({ type: "warning", message: `${config.name} not found. Install with: pkg install ${pkgName}` });
		return undefined;
	}

	// Prebuilt downloads only exist for the targets mapped in getReleaseTarget.
	if (!getReleaseTarget(platform(), arch())) {
		// 不支持时只给提示，避免下载x64包后到执行时才失败。
		onStatus?.({
			type: "warning",
			message: `${config.name} not found. Automatic download is not supported on ${platform()}/${arch()}. Install ${config.name} with your system package manager.`,
		});
		return undefined;
	}

	// Tool not found - download it
	// 通知开始后进入try；没有回调时也正常继续下载。
	onStatus?.({ type: "info", message: `${config.name} not found. Downloading...` });

	try {
		const path = await downloadTool(tool);
		// 下载后直接信任返回路径，不再执行一次工具验证其版本/功能。
		onStatus?.({ type: "info", message: `${config.name} installed to ${path}` });
		return path;
	} catch (e) {
		// Include the error cause chain: fetch failures surface as a bare
		// "fetch failed" TypeError with the actionable detail (DNS, TLS,
		// timeout) hidden in the cause. Depth-capped to guard against
		// circular cause chains.
		const messages: string[] = [];
		// unknown容纳任意抛出值；只沿Error.cause走最多5层，避免循环cause永不结束。
		for (
			let current: unknown = e, depth = 0;
			current instanceof Error && depth < 5;
			// 逗号表达式每轮同时前进cause并增加深度，不是遍历AggregateError.errors全部分支。
			current = current.cause, depth++
		) {
			// 重复消息不再加入，但仍继续向后查看cause；非Error根错误留给String(e)。
			if (!messages.includes(current.message)) messages.push(current.message);
		}
		onStatus?.({
			type: "warning",
			message: `Failed to download ${config.name}: ${messages.length > 0 ? messages.join(": ") : String(e)}`,
		});
		// 对普通下载失败返回不可用，find/grep等调用方据此报错或降级。
		return undefined;
	}
}
