// 把手写 win32-platform.c 编译为 x64/arm64 的 Windows 原生 .node，供 native-platform.ts 按进程架构加载；npm 的 build:native:win32 脚本进入这里。
// 这里是手写生成器，prebuilds 中的二进制是输出；顶层先创建临时目录，正式构建再探测/执行工具链并覆盖目标文件，不会因此调用模块里的剪贴板方法。
// 导入同步进程执行 API，下面的探测与编译都会等待子进程完全结束，没有添加超时。
import { spawnSync } from "node:child_process";
// 导入真实文件操作：创建/删除临时树、写批处理文件、检查路径、复制产物并设置权限；不把这些操作 mock 成内存数据。
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// 从 Node 获取系统临时目录，后面再建立随机子目录。
import { tmpdir } from "node:os";
// * as path 是命名空间导入，通过 path.join/dirname 等名称调用；本文件是 JavaScript .mjs，参数没有写 TS 类型注解。
import * as path from "node:path";
// 把本 ESM 文件的 file URL 转为系统路径，避免把 URL 编码直接当文件名。
import { fileURLToPath } from "node:url";

// import.meta.url 指向脚本自身；dirname 得到 native/win32，和用户运行命令时的 process.cwd 可以不同。
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// 从脚本目录定位唯一 C 入口；它再包含相邻 clipboard.h/napi.h，工具链负责展开这些头文件。
const sourceFile = path.join(scriptDir, "src", "win32-platform.c");
// 模块顶层立刻创建真实临时目录；即使后面只请求 --help，也已经发生这一步，且此刻尚未注册退出清理。
const temporaryDir = mkdtempSync(path.join(tmpdir(), "pi-tui-win32-"));

// 目标数组是两种输出架构的配置，后面的 for...of 按顺序分别构建；const 只禁止重绑数组，不会冻结元素。
const targets = [
	// 第一个对象描述 Windows x64 目标，不代表运行此脚本的机器必须是 x64。
	{
		// 用于输出目录名 win32-x64。
		arch: "x64",
		// 传给 Visual Studio 环境脚本的目标架构名。
		msvcArch: "x64",
		// 通用 Clang 交叉编译时使用的 x64 Windows GNU 目标三元组字符串。
		mingwTarget: "x86_64-w64-windows-gnu",
		// 没有环境覆盖时依次探测这两个已带目标前缀的程序名；不下载编译器。
		prefixedCompilers: ["x86_64-w64-mingw32-gcc", "x86_64-w64-mingw32-clang"],
		// 按这个环境变量键查 x64 专用编译器，其值被当作可执行程序名/路径，不按空格拆成命令加参数。
		envCompiler: "CC_X64",
	},
	// 第二个对象与 x64 共用源文件，但生成独立 arm64 二进制。
	{
		// 用于输出目录名 win32-arm64。
		arch: "arm64",
		// Visual Studio 对此目标使用 arm64 架构参数。
		msvcArch: "arm64",
		// 需要显式目标标志时使用 AArch64 Windows GNU 三元组。
		mingwTarget: "aarch64-w64-windows-gnu",
		// 优先探测 arm64 对应的 MinGW GCC/Clang 程序，而非沿用 x64 编译器名。
		prefixedCompilers: ["aarch64-w64-mingw32-gcc", "aarch64-w64-mingw32-clang"],
		// 允许通过 CC_ARM64 单独覆盖这一架构的编译器。
		envCompiler: "CC_ARM64",
	},
];

// 同步删除共享临时目录，不接参数/不返回产物；正常退出与 SIGINT 回调复用它。
// recursive 清子树，force 允许路径已不存在；特定删除错误最多重试 5 次、按 100ms 基数退避，仍不保证所有情况下清理成功，错误没有被 catch。
function removeTemporaryDir() {
	// 同步 rm 适合 exit 不能等待异步任务的时机；只删除暂存树，不删除已复制到 prebuilds 的产物。
	rmSync(temporaryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// 把函数引用注册到 exit，在进程真正退出时执行同步清理；不是现在调用，也不能覆盖 SIGKILL 或进程崩溃等所有退出。
process.on("exit", removeTemporaryDir);
// Ctrl+C 对应的 SIGINT 回调先清理再请求退出；只注册这一信号，没有同样处理全部终止信号。
process.on("SIGINT", () => {
	// 先同步删除临时目录；若这里抛错，后面的 exit(130) 不会按此路径继续执行。
	removeTemporaryDir();
	// 显式退出码 130；退出仍会触发上面的 exit 监听，再清理一次，force 允许目录已不存在。
	process.exit(130);
});

// 以 --version 尝试启动给定程序，返回“未出现 ENOENT”的布尔值；有本地子进程副作用，不验证编译能力。
// 例如程序存在但 --version 返回非零，仍为 true；权限等非 ENOENT 启动错误也可能为 true，不能把名字当成强可用性保证。
function commandExists(command) {
	// 忽略三个标准流并同步等待；没有 shell 字符串展开，也没有 timeout 限制。
	const result = spawnSync(command, ["--version"], { stdio: "ignore" });
	// 短路或：没有 error 就 true；有 error 但错误码不是找不到程序的 ENOENT 也为 true，不检查 status。
	return !result.error || result.error.code !== "ENOENT";
}

// 执行 command 与独立 args，成功返回 undefined；启动错误或非零/空退出状态会抛错，中断当前构建。
// 默认把编译器输出直接交父进程标准流，options 可覆盖它并指定 cwd；例：run("clang", args, {cwd: buildDir}) 真正启动 clang，不是只打印命令。
function run(command, args, options = {}) {
	// 对象展开在 stdio 之后，因此 options 中同名字段优先；spawnSync 阻塞本脚本直到子进程结束。
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	// 若启动等操作有系统 Error，直接抛出原对象，保留它的错误信息。
	if (result.error) throw result.error;
	// 非零或 null 状态都失败；?? 在 status 为 null 时用 1 拼消息，并没有单独展示导致结束的 signal。
	if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? 1}`);
}

// 为生成的 Windows 批处理参数做双引号包裹，返回新字符串，无 I/O；例：含空格的路径会作为一段带引号文本写进 .cmd。
// 它只把内部双引号翻倍，并非通用 shell/批处理转义器；没有另行处理百分号变量展开等语法。
function quoteBatch(value) {
	// 模板外加一对双引号，replaceAll 把每个内部双引号替换成两个；不修改传入的原字符串。
	return `"${value.replaceAll('"', '""')}"`;
}

// 按运行本脚本的 Node 进程架构选择 MSVC 的 host_arch，返回 arm64 或 x64；与目标数组中的 arch 含义不同。
// 例：x64 Node 也能在工具链支持时用 x64 主机工具构建 arm64；其他 process.arch 在此同样回退 x64，不额外验证支持性。
function msvcHostArch() {
	// 三元只对 arm64 单独分支，不从操作系统硬件再次探测。
	return process.arch === "arm64" ? "arm64" : "x64";
}

// 寻找第一个存在的 VsDevCmd.bat 路径，找不到返回 undefined；先用可选 vswhere，再补 Visual Studio 2022 四种目录。
// 会读环境/文件存在性，可能执行本机 vswhere；不是解析 PATH，也不保证文件可运行或同时支持两个目标架构，后面另做有限探测。
// 例：若 vswhere 没有候选，会按已配置安装根尝试 2022/BuildTools、2022/Community 等位置，首个存在的脚本胜出。
function findVisualStudioDevCmd() {
	// 候选数组保持加入顺序，查询程序给出的安装位置先于硬编码 2022 路径。
	const candidates = [];
	// 环境键含括号，需用方括号属性访问；未设置则得到 undefined。
	const programFilesX86 = process.env["ProgramFiles(x86)"];
	// 只有这个安装根非空时，才拼 vswhere 的常见位置。
	if (programFilesX86) {
		// 定位安装器自带的 vswhere.exe，不扫描所有磁盘目录。
		const vswhere = path.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
		// existsSync 仅检查该路径存在，不证明它是可执行文件。
		if (existsSync(vswhere)) {
			// 同步运行本机 vswhere 并捕获 UTF-8 文本输出；这里没有先检查子进程 error/status 再读取 stdout。
			const result = spawnSync(
				// 直接执行已定位的程序路径。
				vswhere,
				// 下面是独立参数数组，星号不会由 shell 自动展开。
				[
					// 要求查询最新的符合条件安装。
					"-latest",
					// 后一个参数指定产品筛选范围。
					"-products",
					// * 是传给 vswhere 的产品匹配值，保留原字符串意义。
					"*",
					// 后一个参数声明必须具备的组件。
					"-requires",
					// 要求 VC x86/x64 工具组件；不在这里额外检查 arm64 交叉编译组件。
					"Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
					// 选择输出一个特定属性而非完整安装信息。
					"-property",
					// 只输出安装根路径，后面再拼环境初始化脚本名。
					"installationPath",
				],
				// encoding 让成功捕获的 stdout 按 Node 声明返回字符串，避免通常的 Buffer 解码。
				{ encoding: "utf8" },
			);
			// 按 LF/CRLF 逐行读输出；没有针对启动失败/不可用 stdout 的独立兜底，异常会向顶层传播。
			for (const line of result.stdout.split(/\r?\n/)) {
				// 去掉安装路径行两端空白。
				const installationPath = line.trim();
				// 只把非空行转换为 Common7/Tools/VsDevCmd.bat 候选；当前还没有验证这个拼接文件存在。
				if (installationPath) candidates.push(path.join(installationPath, "Common7", "Tools", "VsDevCmd.bat"));
			}
		}
	}

	// 再遍历两个常见 Program Files 根；它们可能重复，代码没有专门去重。
	for (const base of [process.env.ProgramFiles, programFilesX86]) {
		// 环境根为空就 continue 跳过本轮，不把 undefined 拼进路径。
		if (!base) continue;
		// 逐个尝试四种 2022 版产品目录名称，顺序会影响最终首个命中。
		for (const edition of ["BuildTools", "Community", "Professional", "Enterprise"]) {
			// 把候选完整路径加入数组；这里仅检查既定目录结构，不保证发现其他年份或自定义安装位置。
			candidates.push(path.join(base, "Microsoft Visual Studio", "2022", edition, "Common7", "Tools", "VsDevCmd.bat"));
		}
	}

	// find 回调逐项检查文件存在性，首个通过即返回；全部失败返回 undefined，不在此启动 VsDevCmd。
	return candidates.find((candidate) => existsSync(candidate));
}

// 用给定环境脚本生成 probe.cmd，再通过 cmd.exe 检查能否初始化 x64 环境并找到 cl.exe，返回布尔值。
// 会写临时文件/运行批处理；这只是有限探测，没有编译 C，也不证明 arm64 目标、链接库或完整构建可用。
// 例：VsDevCmd 成功但 where cl.exe 返回非零时，本函数仍返回 false；目录或批处理写入错误则直接抛出，不转换为 false。
function canUseMsvc(vsDevCmd) {
	// 探测文件放共享临时根的固定 msvc-probe 子目录，和正式产物目录分开。
	const probeDir = path.join(temporaryDir, "msvc-probe");
	// 递归确保目录存在，I/O 错误直接抛出。
	mkdirSync(probeDir, { recursive: true });
	// 指定要生成的 Windows 批处理文件路径。
	const batchFile = path.join(probeDir, "probe.cmd");
	// 同步写下面四行批处理；数组先拼为 CRLF 文本，内容仍是真正运行的命令，不能在字符串内插入源码注释。
	writeFileSync(
		// 把 probe.cmd 当作写入目标，不是立即执行参数。
		batchFile,
		// 批处理文本各行依次关闭回显、初始化环境、遇错误退出、检查 cl。
		[
			// @echo off 不回显后续命令文本，不等于禁止所有命令自身输出。
			"@echo off",
			// 调用环境脚本后返回当前批处理，目标固定 x64、主机按 Node 架构；>nul 丢弃该命令标准输出。
			`call ${quoteBatch(vsDevCmd)} -no_logo -arch=x64 -host_arch=${msvcHostArch()} >nul`,
			// errorlevel 至少为 1 时用当前错误码退出这一批处理，防止环境初始化失败仍继续查 cl。
			"if errorlevel 1 exit /b %errorlevel%",
			// where 从已初始化的环境找 cl.exe，两个重定向都丢弃输出；最后的退出状态作为探测结果。
			"where cl.exe >nul 2>nul",
		// join 用 CRLF 组合命令行，不额外执行这些字符串。
		].join("\r\n"),
	);
	// 启动 cmd.exe：/d 关闭 AutoRun，/s 配合 /c 处理引号，/c 执行批处理后退出；探测工作目录固定，输出忽略。
	const result = spawnSync("cmd.exe", ["/d", "/s", "/c", batchFile], { cwd: probeDir, stdio: "ignore" });
	// 只有没有启动 error 且退出码恰好 0 才可用；不同于上面 commandExists 的宽松规则。
	return !result.error && result.status === 0;
}

// 为当前目标选择 MinGW 风格编译器，返回 command/useTargetFlag 或 undefined；依次专用环境覆盖、通用 CC、带前缀程序、通用 clang。
// 选择可能执行 --version 探测，但不编译；例：CC_ARM64 已设时直接采用并且不添加 --target，不验证该程序是否真支持目标。
function resolveMingwCompiler(target) {
	// 用目标对象的 envCompiler 字段动态查环境变量。
	const envCompiler = process.env[target.envCompiler];
	// 专用覆盖优先且不探测，认为其已配置目标；此处不把值按命令行语法拆分。
	if (envCompiler) return { command: envCompiler, useTargetFlag: false };
	// 通用 CC 次优先，也不探测，但会添加 --target；用户若传不支持此参数的编译器，后续仍可能失败。
	if (process.env.CC) return { command: process.env.CC, useTargetFlag: true };
	// 没有覆盖才按目标配置顺序探测预带架构前缀的编译器。
	for (const command of target.prefixedCompilers) {
		// 首个宽松“存在”探测通过就返回，useTargetFlag=false 避免再附通用目标参数。
		if (commandExists(command)) return { command, useTargetFlag: false };
	}
	// 最后尝试 PATH 中的 clang，若存在则让它显式接收目标三元组。
	if (commandExists("clang")) return { command: "clang", useTargetFlag: true };
	// 没有候选时返回 undefined，由 buildWithMingw 给出可读错误；不自动安装工具链。
	return undefined;
}

// 将一个已构建暂存文件复制到目标架构 prebuilds，设置权限并打印相对路径；返回 undefined，文件操作失败会抛出。
// 例：target.arch=x64 写入 prebuilds/win32-x64/win32-platform.node。直接复制可覆盖旧文件，不是原子发布或两架构一起回滚。
function installOutput(temporaryOutput, target) {
	// 输出以脚本目录为基准，不取决于调用者当前 cwd。
	const outputDir = path.join(scriptDir, "prebuilds", `win32-${target.arch}`);
	// 创建最终产物目录。
	mkdirSync(outputDir, { recursive: true });
	// .node 是原生模块文件后缀，内部仍是 Windows DLL 格式，而非 TypeScript/JavaScript 源码。
	const output = path.join(outputDir, "win32-platform.node");
	// 同步复制并默认覆盖既有目标；它不验证 PE 架构、导出函数或能否被 Node 加载。
	copyFileSync(temporaryOutput, output);
	// 0o755 是八进制权限值；Windows 上权限语义受平台限制，不等价于 POSIX 三组 rwx 完整实现。
	chmodSync(output, 0o755);
	// 仅日志展示使用当前工作目录相对路径，实际写入位置已经由 output 决定。
	console.log(`Built ${path.relative(process.cwd(), output)}`);
}

// 按一个目标生成 MSVC build.cmd、执行编译链接、成功后复制产物；输入是目标配置和环境脚本路径，返回 undefined。
// 例：arm64 目标把目标参数传为 arm64，host 参数仍看 Node 架构。任何一步抛错就停止当前流程，之前已复制的其他架构产物不撤销。
function buildWithMsvc(target, vsDevCmd) {
	// 每个架构使用独立暂存目录，避免输出文件互相覆盖。
	const buildDir = path.join(temporaryDir, `msvc-${target.arch}`);
	// 编译器先把原生模块写在暂存位置。
	const temporaryOutput = path.join(buildDir, "win32-platform.node");
	// 确保暂存目录存在。
	mkdirSync(buildDir, { recursive: true });

	// 本目标的批处理脚本和中间文件也放在该暂存目录。
	const batchFile = path.join(buildDir, "build.cmd");
	// 同步写完整批处理文本：环境初始化、错误退出、cl 命令、再次检查错误；不是将工具链命令交给 JavaScript 求值。
	writeFileSync(
		// 写入目标是 build.cmd。
		batchFile,
		// 外层数组按行组成批处理；其中 cl 参数数组先拼成同一命令行。
		[
			// 关闭批处理命令回显，cl 自己的诊断仍可经继承标准流显示。
			"@echo off",
			// call 初始化当前目标/主机架构环境，quoteBatch 包裹环境脚本路径；这里使用 target.msvcArch，不是固定 x64 探测参数。
			`call ${quoteBatch(vsDevCmd)} -no_logo -arch=${target.msvcArch} -host_arch=${msvcHostArch()}`,
			// 环境设置失败就退出，不继续用错误的工具链环境构建。
			"if errorlevel 1 exit /b %errorlevel%",
			// 内层数组描述一条 cl 命令的程序名与参数，随后 join 成批处理字符串。
			[
				// cl 通过上面环境初始化后的 PATH 解析。
				"cl",
				// 不打印编译器常规标识横幅，错误诊断仍保留。
				"/nologo",
				// /TC 把输入按 C 处理，不因为编译器还支持 C++ 就切换语言。
				"/TC",
				// 请求 C11 语言模式，实际支持由安装的 MSVC 版本决定。
				"/std:c11",
				// /W4 提高警告级别；这里没有 /WX，因此本参数不意味着所有警告都按错误退出。
				"/W4",
				// /O1 选择偏向减小输出体积的优化组合。
				"/O1",
				// /GS- 关闭 MSVC 的栈安全 cookie 检查，不是添加新的运行时保护。
				"/GS-",
				// /LD 请求生成 DLL，而非普通控制台可执行程序。
				"/LD",
				// /Fe 指定最终 DLL 路径并保留 .node 名称；引用函数处理路径中空格的基本情况。
				`/Fe:${quoteBatch(temporaryOutput)}`,
				// 附上唯一 C 源文件路径，内部头文件由预处理器按 include 规则读取。
				quoteBatch(sourceFile),
				// /link 后的选项交给链接器，前面是 cl 的编译/驱动参数。
				"/link",
				// /NOENTRY 请求没有 DLL 入口点；模块由后续运行时寻找的 N-API 导出初始化，不在这里加载它。
				"/NOENTRY",
				// /NODEFAULTLIB 禁止自动加入默认库，下面只显式列出所需 Windows 系统库，不链接特定 Node 运行时库。
				"/NODEFAULTLIB",
				// kernel32 导入库提供内存、模块符号等 Windows 系统 API。
				"kernel32.lib",
				// user32 导入库供按键状态、窗口及剪贴板等 API 使用，编译链接本身不会读写剪贴板。
				"user32.lib",
				// /OPT:REF 让链接器去掉未引用的可消除函数/数据，以减少输出体积。
				"/OPT:REF",
				// /OPT:ICF 允许合并相同 COMDAT 实体，即链接器可单独选取/合并的代码或数据段；是否满足条件取决于实际中间代码。
				"/OPT:ICF",
			// 用空格把 cl 参数组拼成一条批处理命令；这不是 spawn 的独立 argv 数组，因此路径才需要前面的引用。
			].join(" "),
			// cl 命令失败则用其退出码终止 build.cmd，防止把失败误报成成功。
			"if errorlevel 1 exit /b %errorlevel%",
		// 外层用 Windows CRLF 行尾拼批处理正文，字符串字节原样决定稍后执行行为。
		].join("\r\n"),
	);

	// 真正运行 cmd.exe 编译，cwd 将 .obj 等相对中间文件放暂存目录；run 把非零退出状态抛为异常。
	run("cmd.exe", ["/d", "/s", "/c", batchFile], { cwd: buildDir });
	// 仅在 run 成功返回后复制本架构产物；不运行模块功能测试。
	installOutput(temporaryOutput, target);
}

// 按一个目标解析 MinGW 编译器、组 argv 编译链接，再复制输出；返回 undefined，缺编译器或执行/文件操作失败会抛错。
// 例：通用 clang 会收到 --target=x86_64-w64-windows-gnu；脚本不补装 Windows 头文件/系统库，也不保证任意宿主都有完整交叉工具链。
function buildWithMingw(target) {
	// 调用有明确优先顺序的编译器选择器，此刻可能只运行了 --version，尚未编译。
	const compiler = resolveMingwCompiler(target);
	// 没有任何选项时直接报配置错误。
	if (!compiler) {
		// 构造并抛出 Error，中断本架构及后续架构。
		throw new Error(
			// 错误消息插入当前架构和专用环境变量名，提供安装/配置说明，本脚本不执行安装。
			`No Windows cross-compiler found for ${target.arch}. Install Microsoft C++ Build Tools on Windows, or set ${target.envCompiler} to a MinGW-compatible compiler.`,
		);
	}

	// MinGW 也按目标分开暂存目录，与 MSVC 子目录不重叠。
	const buildDir = path.join(temporaryDir, `mingw-${target.arch}`);
	// 暂存输出使用最终 .node 文件名。
	const temporaryOutput = path.join(buildDir, "win32-platform.node");
	// 建立暂存目录，递归模式允许父目录已存在。
	mkdirSync(buildDir, { recursive: true });

	// 这里用独立 argv 数组传编译器，不拼 shell 命令；参数里的空格由 Node 传参处理，无需再 quoteBatch。
	const args = [
		// 条件数组展开：需要时增加一个 --target 参数，否则展开空数组，不会把空字符串占位传给编译器。
		...(compiler.useTargetFlag ? [`--target=${target.mingwTarget}`] : []),
		// 请求 C11 模式。
		"-std=c11",
		// 启用常见警告集合，不等于启用所有可能警告。
		"-Wall",
		// 再启用额外警告；这里没有 -Werror，因此警告不必然使构建失败。
		"-Wextra",
		// -Oz 请求更偏向缩小体积的优化，具体是否支持取决于所选编译器。
		"-Oz",
		// 关闭对标准库内建函数的特殊识别；不会自动提供缺少的运行库。
		"-fno-builtin",
		// 请求共享库形式的输出，Windows 目标对应 DLL。
		"-shared",
		// 不自动链接标准启动文件/库，代码通过 Windows API 和运行时符号查询工作，仍需要显式系统库。
		"-nostdlib",
		// -Wl, 把 --no-entry 传给链接器，避免常规 DLL 入口点要求；编译器/链接器必须兼容这组选项。
		"-Wl,--no-entry",
		// 让链接器剥离可移除的符号等信息以缩小体积，不代表删除供 Node 查找的 N-API 导出。
		"-Wl,--strip-all",
		// 加入真实 C 源文件路径，只有执行下面 run 时才开始编译。
		sourceFile,
		// 链接 Windows kernel32 系统导入库。
		"-lkernel32",
		// 链接 user32；不会在构建阶段因此打开用户剪贴板。
		"-luser32",
		// -o 的下一个参数指定输出文件。
		"-o",
		// 先写暂存文件，成功后才安装到 prebuilds。
		temporaryOutput,
	];

	// 同步启动选中的编译器，并把工作目录放到该架构暂存树；失败时不会执行后面的复制。
	run(compiler.command, args, { cwd: buildDir });
	// 复制成功编译的本架构产物并打印 Built 日志，不保证下一架构也会成功。
	installOutput(temporaryOutput, target);
}

// 帮助分支在工具链查找前退出，但晚于临时目录创建和退出监听注册；不能把执行 --help 描述为完全无文件副作用。
if (process.argv.includes("--help") || process.argv.includes("-h")) {
	// 下面整个多行模板原样打印用法、两个目标和四个环境变量示例；模板中的行是输出正文，不能往里面插入源码注释。
	console.log(`Usage: npm --prefix packages/tui run build:native:win32

Builds win32-x64 and win32-arm64 native prebuilds.

Environment:
  PI_TUI_WIN32_TOOLCHAIN=msvc|mingw
  CC_X64=/path/to/x86_64-w64-mingw32-gcc
  CC_ARM64=/path/to/aarch64-w64-mingw32-gcc
  CC=/path/to/clang`);
	// 退出码 0 表示帮助正常结束，并触发 exit 的同步临时目录清理。
	process.exit(0);
}

// 读取可选工具链覆盖；未定义是 undefined，显式空字符串则是另一个值。
const requestedToolchain = process.env.PI_TUI_WIN32_TOOLCHAIN;
// 只拒绝非空且不为两个允许名字的值；空字符串通过此 if，不是完整 schema 校验。
if (requestedToolchain && requestedToolchain !== "msvc" && requestedToolchain !== "mingw") {
	// 非法非空配置直接抛错，在任何编译器运行前终止；已创建的暂存树由 exit 监听尝试清理。
	throw new Error("PI_TUI_WIN32_TOOLCHAIN must be either 'msvc' or 'mingw'");
}

// 无论是否显式要求 mingw，都会先做 Visual Studio 定位；函数本身未用平台条件包住，所以不承诺此时没有本机进程探测。
const vsDevCmd = findVisualStudioDevCmd();
// 只要找到脚本就执行有限 MSVC 探测，否则 false；即使最后选择 mingw，也可能先写/运行这份探测批处理。
const hasMsvc = vsDevCmd ? canUseMsvc(vsDevCmd) : false;
// ?? 仅在未定义/null 时用自动选择：Windows 且存在 VsDevCmd 路径就选 msvc，否则 mingw；不看 hasMsvc，空字符串覆盖也不会回退。
const toolchain = requestedToolchain ?? (process.platform === "win32" && vsDevCmd ? "msvc" : "mingw");

// 只有最终值严格等于 msvc 才进入微软工具链；自动选择了 msvc 但探测失败时，不会自动再试 MinGW。
if (toolchain === "msvc") {
	// 既要找到脚本，也要前面的 x64 环境探测通过，才允许继续。
	if (!vsDevCmd || !hasMsvc) {
		// MSVC 不可用直接抛错，错误文字建议用户显式改配置；没有在 catch 中偷偷切另一套工具链。
		throw new Error("Microsoft C++ Build Tools not found. Install the Visual Studio C++ workload or set PI_TUI_WIN32_TOOLCHAIN=mingw.");
	}
	// 顺序构建 x64 再 arm64；首个失败就停止，第二个失败也不会回滚首个已复制产物。
	for (const target of targets) buildWithMsvc(target, vsDevCmd);
// 其余值进入 MinGW 分支；非空非法值已提前报错，但显式空字符串也会在这里执行。
} else {
	// 顺序调用每个目标的 MinGW 构建，选中的程序/库兼容性仍以实际执行结果为准。
	for (const target of targets) buildWithMingw(target);
}
