// 文件导读
// 所属：仓库根 scripts/，是 coding-agent 启动性能基准 CLI（Node 或 Bun），不是包源码。
// 作用：构建/复用 coding-agent 入口，反复启动 TUI 或 RPC 模式，测量“到可用状态”的耗时；
// 可选采集 V8 CPU profile，并把结果以人类可读表格和 CI 友好的 METRIC 行输出。
// 能力：按 TUI/RPC 模式构建或复用入口；重复启动并计时；可选采集 CPU profile；汇总统计并打印 METRIC 行。
// 上游：根 package.json：
//   npm run profile:tui -> node scripts/profile-coding-agent-node.mjs --mode tui
//   npm run profile:rpc -> node scripts/profile-coding-agent-node.mjs --mode rpc
//   bun run profile:tui / bun run profile:rpc -> 通过 bun 启动同一脚本，--runtime auto 会选 bun。
// 下游：packages/coding-agent 的 dist/cli.js（Node）、dist/bundle/cli.js（--bundle）或 src/cli.ts（Bun）；
//       子进程内部通过 PI_TIMING=1 在 stderr 打印 Startup Timings，通过 PI_STARTUP_BENCHMARK=1 在 TUI 初始化后退出。
// 参数：见 printHelp；主要选项 --mode tui|rpc、--runs/--warmup、--runtime node|bun|auto、--profile-dir、--label、
//       --agent-dir、--isolated-agent-dir、--bundle、--no-offline、--skip-build、--cpu-profile、--help。
// 环境变量（由本脚本设置到子进程）：
//   PI_TIMING=1                 打开子进程的启动分段计时。
//   PI_STARTUP_BENCHMARK=1      TUI 模式在首次可用状态后停止并退出；RPC 模式不使用。
//   PI_OFFLINE=1 / PI_SKIP_VERSION_CHECK=1  默认强制离线，--no-offline 可关闭。
//   PI_CODING_AGENT_DIR         --agent-dir 或 --isolated-agent-dir 指定的配置目录。
// 输出：每次运行打印 [run N] elapsed=...；多次运行打印 min/median/avg/max；最后输出 METRIC startup_time_ms=...，
//       每个分段计时也转成 METRIC <label>_ms。CPU profile 写入 profile 目录（Node 默认 profiles-node，Bun 默认 profiles-bun）。
// 副作用：默认先运行 npm 构建（会写各包 dist）；创建 profile 目录；--isolated-agent-dir 在系统临时目录创建配置并在运行后删除；
//       子进程可能写会话/配置；TUI 模式会接管本地终端。
// 退出码：正常 0；参数错误、构建失败、子进程非零退出等由 main().catch 打印消息并以 1 退出。
// 示例（真实命令行）：
//   node scripts/profile-coding-agent-node.mjs --mode rpc --runs 3 --warmup 1 --no-offline
//   node scripts/profile-coding-agent-node.mjs --mode tui --bundle --cpu-profile --isolated-agent-dir
// 阅读顺序：先看 printHelp/parseArgs 了解输入，再看 getRuntimeCommand/createBenchmarkEnv，最后看 TUI/RPC 两个运行器。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

// ESM 没有 __dirname；从 import.meta.url 还原脚本目录，再上溯到仓库根。
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
// coding-agent 包目录与三种入口：普通 dist、bundle 版 dist、Bun 直接跑的源码入口。
const packageDir = join(repoRoot, "packages", "coding-agent");
const distCliPath = join(packageDir, "dist", "cli.js");
const bundledDistCliPath = join(packageDir, "dist", "bundle", "cli.js");
const srcCliPath = join(packageDir, "src", "cli.ts");
// 默认 profile 输出目录按运行时分开，避免 Node/Bun 的 profile 混在一起。
const defaultNodeProfileDir = join(repoRoot, "profiles-node");
const defaultBunProfileDir = join(repoRoot, "profiles-bun");
// 子进程使用的环境变量名常量，避免多处拼写漂移。
const agentDirEnvName = "PI_CODING_AGENT_DIR";
const startupBenchmarkEnvName = "PI_STARTUP_BENCHMARK";

// 打印完整用法；由 --help 触发，随后 main 直接 return（退出码 0）。
function printHelp() {
	console.log(`Usage:
  node scripts/profile-coding-agent-node.mjs [options]

Profiles coding-agent startup with the runtime selected below:
- npm run profile:tui     -> builds packages/coding-agent and profiles TUI startup with Node
- npm run profile:rpc     -> builds packages/coding-agent and profiles RPC startup with Node
- bun run profile:tui     -> profiles TUI startup from src/cli.ts directly with Bun
- bun run profile:rpc     -> profiles RPC startup from src/cli.ts directly with Bun

Options:
  --mode <name>          tui or rpc (default: tui)
  --runs <n>             Number of measured runs (default: 1)
  --warmup <n>           Number of warmup runs before measurements (default: 0)
  --profile-dir <dir>    CPU profile output directory
                         Default: profiles-node for Node, profiles-bun for Bun
  --label <name>         Profile name prefix (default: <mode>-startup)
  --runtime <name>       node, bun, or auto (default: auto)
  --agent-dir <dir>      Use a specific PI_CODING_AGENT_DIR for the benchmark run
  --isolated-agent-dir   Use a fresh temporary agent dir instead of the normal one
  --bundle               Build and profile the bundled Node entrypoint instead of dist/cli.js
  --no-offline           Do not force PI_OFFLINE=1 / PI_SKIP_VERSION_CHECK=1
  --skip-build           Reuse the selected build output without rebuilding first (Node only)
  --cpu-profile          Write CPU profiles for benchmark runs
  --help                 Show this help

Notes:
  - By default the benchmark uses your normal configured agent dir, so global models/auth/settings work.
  - TUI mode measures startup until the interactive UI reaches first usable state.
  - RPC mode measures startup until a real get_state request receives a response, then closes stdin to exit cleanly.
  - CPU profiles are kept in the selected profile directory for later analysis.
`);
}

// 解析非负整数参数；Number.parseInt 会接受 "3abc" 这类前缀，因此先用 isFinite 判断结果即可，
// 不完全拒绝尾部垃圾。NaN 或负数都报错。
function parseIntegerFlag(value, name) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`Invalid ${name}: ${value}`);
	}
	return parsed;
}

// 限制 --runtime 为三个允许值；返回字符串字面量之外的输入直接报错。
function parseRuntime(value) {
	if (value === "auto" || value === "node" || value === "bun") {
		return value;
	}
	throw new Error(`Invalid --runtime: ${value}`);
}

// 限制 --mode 只能是 tui 或 rpc。
function parseMode(value) {
	if (value === "tui" || value === "rpc") {
		return value;
	}
	throw new Error(`Invalid --mode: ${value}`);
}

// 手写参数解析：布尔选项无值，带值选项必须跟一个参数；未知选项立即报错。
function parseArgs(argv) {
	const options = {
		mode: "tui",
		bundle: false,
		runs: 1,
		warmup: 0,
		profileDir: undefined,
		label: undefined,
		offline: true,
		build: true,
		runtime: "auto",
		agentDir: undefined,
		isolatedAgentDir: false,
		cpuProfile: false,
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];

		// -h 是 --help 的短别名；这两个不取值。
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}

		// --no-offline 是反向布尔：默认 offline=true，出现时改成 false。
		if (arg === "--no-offline") {
			options.offline = false;
			continue;
		}

		if (arg === "--isolated-agent-dir") {
			options.isolatedAgentDir = true;
			continue;
		}

		if (arg === "--bundle") {
			options.bundle = true;
			continue;
		}

		// --skip-build 也是反向布尔：默认 build=true。
		if (arg === "--skip-build") {
			options.build = false;
			continue;
		}

		if (arg === "--cpu-profile") {
			options.cpuProfile = true;
			continue;
		}

		// 所有带值选项：若已是最后一个参数，说明缺少值，提前给出明确错误。
		if (
			(arg === "--mode" ||
				arg === "--runs" ||
				arg === "--warmup" ||
				arg === "--profile-dir" ||
				arg === "--label" ||
				arg === "--runtime" ||
				arg === "--agent-dir") &&
			index + 1 >= argv.length
		) {
			throw new Error(`Missing value for ${arg}`);
		}

		// ++index 先自增再取值，跳过选项值本身。
		if (arg === "--mode") {
			options.mode = parseMode(argv[++index]);
			continue;
		}

		if (arg === "--runs") {
			options.runs = parseIntegerFlag(argv[++index], "--runs");
			continue;
		}

		if (arg === "--warmup") {
			options.warmup = parseIntegerFlag(argv[++index], "--warmup");
			continue;
		}

		// 路径选项统一 resolve 成绝对路径，后续 cwd 变化不影响。
		if (arg === "--profile-dir") {
			options.profileDir = resolve(argv[++index]);
			continue;
		}

		if (arg === "--label") {
			options.label = argv[++index];
			continue;
		}

		if (arg === "--runtime") {
			options.runtime = parseRuntime(argv[++index]);
			continue;
		}

		if (arg === "--agent-dir") {
			options.agentDir = resolve(argv[++index]);
			continue;
		}

		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

// npm_config_user_agent 由 npm/bun 注入；以 "bun/" 开头说明当前命令是 bun run。
function detectRuntimeFromPackageManager() {
	const userAgent = process.env.npm_config_user_agent ?? "";
	return userAgent.startsWith("bun/") ? "bun" : "node";
}

// auto 时根据包管理器推断，否则使用显式值。
function resolveRuntime(requestedRuntime) {
	if (requestedRuntime === "auto") {
		return detectRuntimeFromPackageManager();
	}
	return requestedRuntime;
}

// profile 目录：显式参数优先；否则 Node/Bun 各有默认目录。
function resolveProfileDir(runtime, requestedProfileDir) {
	if (requestedProfileDir) {
		return requestedProfileDir;
	}
	return runtime === "bun" ? defaultBunProfileDir : defaultNodeProfileDir;
}

// 标签用于 CPU profile 文件名和 METRIC 名称；默认 <mode>-startup。
function resolveLabel(mode, requestedLabel) {
	return requestedLabel ?? `${mode}-startup`;
}

// 毫秒保留一位小数并加单位，便于阅读。
function formatMs(value) {
	return `${value.toFixed(1)}ms`;
}

// 把绝对路径转成相对仓库根的路径；仓库外仍返回绝对路径。
function toDisplayPath(path) {
	const relativePath = relative(repoRoot, path);
	// 非空且不以 .. 开头才在仓库内；统一用 /，避免 Windows 输出反斜杠。
	if (relativePath !== "" && !relativePath.startsWith("..")) {
		return relativePath.replaceAll("\\", "/");
	}
	return path;
}

// 计算一组耗时的 min/max/avg/median；调用方保证数组非空。
function summarize(values) {
	// 复制后排序，避免修改调用方数组。
	const sorted = [...values].sort((a, b) => a - b);
	const total = sorted.reduce((sum, value) => sum + value, 0);
	const middle = Math.floor(sorted.length / 2);
	// 偶数个时取中间两项平均，奇数个时取正中间。
	const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
	return {
		min: sorted[0],
		max: sorted[sorted.length - 1],
		avg: total / sorted.length,
		median,
	};
}

// 从子进程 stderr 中提取 "--- Startup Timings[: namespace] ---" 块里的 label: Nms 行。
function parseStartupTimings(stderr) {
	const lines = stderr.split(/\r?\n/);
	const timings = new Map();
	let inBlock = false;

	for (const line of lines) {
		// 标题可带命名空间（如 session）；[^-]+ 排除分隔线本身。
		if (/^--- Startup Timings(?:: [^-]+)? ---$/.test(line.trim())) {
			inBlock = true;
			continue;
		}
		if (!inBlock) {
			continue;
		}
		// 分隔线全是连字符，遇到就结束整个解析。
		if (line.includes("------------------------")) {
			break;
		}
		// 行格式为两个空格缩进、标签、冒号、整数毫秒；TOTAL 行也符合，会被计入。
		const match = line.match(/^\s+([^:]+):\s+(\d+)ms$/);
		if (!match) {
			continue;
		}
		timings.set(match[1], Number.parseInt(match[2], 10));
	}

	return timings;
}

// 把多次运行的标签计时聚合成每个标签的统计；某标签只出现一次时也正常统计。
function summarizeTimingMaps(runs) {
	const valuesByLabel = new Map();
	for (const run of runs) {
		for (const [label, value] of run.timings.entries()) {
			const values = valuesByLabel.get(label);
			if (values) {
				values.push(value);
			} else {
				valuesByLabel.set(label, [value]);
			}
		}
	}

	const summaries = new Map();
	for (const [label, values] of valuesByLabel.entries()) {
		summaries.set(label, summarize(values));
	}
	return summaries;
}

// 把任意标签转成合法 METRIC 名称：非字母数字替换为下划线、去掉首尾下划线、追加 _ms。
function toMetricName(label) {
	return `${label.replaceAll(/[^a-zA-Z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "")}_ms`;
}

// 等待子进程退出：spawn 错误直接 reject；被信号终止也算失败；正常退出 resolve 退出码。
async function waitForExit(child, errorPrefix) {
	return await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) {
				reject(new Error(`${errorPrefix} exited from signal ${signal}`));
				return;
			}
			// code 为 null 且无 signal 的极端情况按 0 处理；常规退出都有数字。
			resolve(code ?? 0);
		});
	});
}

// 先构建依赖包，再构建 coding-agent；任一命令失败时打印捕获的输出并抛错。
async function runBuild(bundle) {
	process.stdout.write(
		`Building dependencies and the ${bundle ? "bundled" : "unbundled"} coding-agent Node entrypoint...\n`,
	);
	const startedAt = performance.now();
	const commands = [
		{
			label: "Dependency build",
			// 一次 npm run build 带多个 --workspace，按依赖顺序构建，避免 coding-agent 引用旧 dist。
			args: [
				"run",
				"build",
				"--workspace",
				"packages/tui",
				"--workspace",
				"packages/telemetry",
				"--workspace",
				"packages/ai",
				"--workspace",
				"packages/agent",
			],
		},
		{
			label: "Coding-agent build",
			// bundle 版用 esbuild 打包入口；非 bundle 用 tsc 输出可单独 profile 的模块文件。
			args: ["run", bundle ? "build" : "build:unbundled", "--workspace", "packages/coding-agent"],
		},
	];

	for (const command of commands) {
		// spawn 而不是 exec：构建输出可能很大，用流式捕获避免 maxBuffer 限制。
		const child = spawn("npm", command.args, {
			cwd: repoRoot,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			// Windows 上 npm 是 .cmd，需要通过 shell 启动。
			shell: process.platform === "win32",
		});

		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		const exitCode = await waitForExit(child, command.label);
		if (exitCode !== 0) {
			// 失败时把完整输出交给用户；成功时静默，避免刷屏。
			if (stdout.trim()) {
				process.stdout.write(`${stdout}${stdout.endsWith("\n") ? "" : "\n"}`);
			}
			if (stderr.trim()) {
				process.stderr.write(`${stderr}${stderr.endsWith("\n") ? "" : "\n"}`);
			}
			throw new Error(`${command.label} failed with exit code ${exitCode}`);
		}
	}

	process.stdout.write(`Build completed in ${formatMs(performance.now() - startedAt)}\n`);
}

// 组装被测 CLI 的启动命令：Node 用当前解释器 + 构建产物，Bun 直接跑 TypeScript 源码。
function getRuntimeCommand(runtime, mode, profileDir, profileName, cpuProfile, nodeEntryPath) {
	// --no-session 避免把基准运行写入会话历史；RPC 模式再追加 --mode rpc。
	const benchmarkArgs = ["--no-session"];
	if (mode === "rpc") {
		benchmarkArgs.push("--mode", "rpc");
	}

	if (runtime === "bun") {
		const args = [];
		// Bun 的 CPU profile 参数与 Node 类似，但由 Bun 自己实现。
		if (cpuProfile) {
			args.push("--cpu-prof", `--cpu-prof-dir=${profileDir}`, `--cpu-prof-name=${profileName}`);
		}
		args.push(srcCliPath, ...benchmarkArgs);
		return {
			executable: "bun",
			args,
		};
	}

	const args = [];
	// Node 的 V8 CPU profile 参数；profileName 已含 .cpuprofile 后缀。
	if (cpuProfile) {
		args.push("--cpu-prof", `--cpu-prof-dir=${profileDir}`, `--cpu-prof-name=${profileName}`);
	}
	args.push(nodeEntryPath, ...benchmarkArgs);
	return {
		// 用 process.execPath 保证与当前脚本同一个 Node 版本。
		executable: process.execPath,
		args,
	};
}

// 构造子进程环境：打开计时、设置 agent 配置目录、TUI 基准开关和默认离线开关。
function createBenchmarkEnv(options, isolatedAgentDir) {
	const env = { ...process.env, PI_TIMING: "1" };
	// 显式 --agent-dir 优先；否则使用隔离目录（若启用）；都没有则沿用用户原配置。
	if (options.agentDir) {
		env[agentDirEnvName] = options.agentDir;
	} else if (isolatedAgentDir) {
		env[agentDirEnvName] = isolatedAgentDir;
	}
	// 只有 TUI 支持“初始化完成后退出”的基准模式；RPC 用 get_state 握手判断就绪。
	if (options.mode === "tui") {
		env[startupBenchmarkEnvName] = "1";
	}
	// 默认禁止联网和版本检查，避免启动耗时受网络影响；--no-offline 可恢复真实行为。
	if (options.offline) {
		env.PI_OFFLINE = "1";
		env.PI_SKIP_VERSION_CHECK = "1";
	}
	return env;
}

// TUI 单次运行：启动交互 CLI，等它在首次可用状态后自行退出，测整段耗时。
async function runTuiBenchmarkRun({ runtime, runIndex, measuredIndex, options, profileDir }) {
	const runNumber = runIndex + 1;
	// 文件名补零到三位，排序稳定；warmup 与 measured 共享同一编号序列。
	const suffix = String(runNumber).padStart(3, "0");
	const profileName = `${options.label}-${suffix}.cpuprofile`;
	// 隔离模式为每次运行建临时根，避免上次运行的认证/设置影响下一次。
	const tempRoot = options.isolatedAgentDir ? mkdtempSync(join(tmpdir(), "pi-startup-benchmark-")) : undefined;
	const isolatedAgentDir = tempRoot ? join(tempRoot, "agent") : undefined;
	if (isolatedAgentDir) {
		mkdirSync(isolatedAgentDir, { recursive: true });
	}

	const nodeEntryPath = options.bundle ? bundledDistCliPath : distCliPath;
	const command = getRuntimeCommand(runtime, "tui", profileDir, profileName, options.cpuProfile, nodeEntryPath);
	const child = spawn(command.executable, command.args, {
		cwd: packageDir,
		env: createBenchmarkEnv(options, isolatedAgentDir),
		// TUI 需要直接占用终端：stdin/stdout 继承；stderr 捕获用于解析计时。
		stdio: ["inherit", "inherit", "pipe"],
		// Bun 在 Windows 下是 .cmd；Node 用绝对路径无需 shell。
		shell: process.platform === "win32" && runtime === "bun",
	});

	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	// 计时从 spawn 返回后开始，到子进程退出结束；包含子进程初始化、TUI 首次可用状态，
	// 以及 coding-agent 退出前固定等待终端查询回复的 150ms（见 packages/coding-agent/src/main.ts）。
	const startedAt = performance.now();
	const exitCode = await waitForExit(child, `Benchmark ${measuredIndex === undefined ? `warmup ${runNumber}` : `run ${measuredIndex}`}`);
	const elapsedMs = performance.now() - startedAt;

	try {
		if (exitCode !== 0) {
			throw new Error(stderr.trim() || `Benchmark child exited with code ${exitCode}`);
		}

		// --cpu-profile 时确认文件确实写出；否则后续分析会找不到 profile。
		const profilePath = options.cpuProfile ? join(profileDir, profileName) : undefined;
		if (profilePath && !existsSync(profilePath)) {
			throw new Error(`CPU profile was not written: ${profilePath}`);
		}

		return { elapsedMs, profilePath, timings: parseStartupTimings(stderr) };
	} finally {
		// 无论成功失败都清理本次隔离目录；用户配置目录不受影响。
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}
}

// 把缓冲区按行切开，逐行回调完整行；返回尚未遇到换行的剩余部分。
function splitJsonLines(buffer, onLine) {
	let remaining = buffer;
	while (true) {
		const newlineIndex = remaining.indexOf("\n");
		// 没有换行说明当前块还不完整，留给下次 data 事件继续拼接。
		if (newlineIndex === -1) {
			return remaining;
		}
		const line = remaining.slice(0, newlineIndex);
		// 兼容 CRLF：回调前去掉行尾的 \r。
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		remaining = remaining.slice(newlineIndex + 1);
	}
}

// RPC 单次运行：启动 RPC 模式，发送 get_state，收到响应后关闭 stdin 让进程退出。
async function runRpcBenchmarkRun({ runtime, runIndex, measuredIndex, options, profileDir }) {
	const runNumber = runIndex + 1;
	const suffix = String(runNumber).padStart(3, "0");
	const profileName = `${options.label}-${suffix}.cpuprofile`;
	// 与 TUI 相同的隔离目录策略。
	const tempRoot = options.isolatedAgentDir ? mkdtempSync(join(tmpdir(), "pi-startup-benchmark-")) : undefined;
	const isolatedAgentDir = tempRoot ? join(tempRoot, "agent") : undefined;
	if (isolatedAgentDir) {
		mkdirSync(isolatedAgentDir, { recursive: true });
	}

	const nodeEntryPath = options.bundle ? bundledDistCliPath : distCliPath;
	const command = getRuntimeCommand(runtime, "rpc", profileDir, profileName, options.cpuProfile, nodeEntryPath);
	// RPC 不占用终端，三个管道都由本脚本控制。
	const child = spawn(command.executable, command.args, {
		cwd: packageDir,
		env: createBenchmarkEnv(options, isolatedAgentDir),
		stdio: ["pipe", "pipe", "pipe"],
		shell: process.platform === "win32" && runtime === "bun",
	});

	let stdoutBuffer = "";
	let stderr = "";
	let readyElapsedMs;
	let responseError;
	// 每次运行用唯一 id，避免把子进程的其他响应误当成自己发出的 get_state。
	const requestId = `startup-benchmark-${runNumber}`;
	const startedAt = performance.now();

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		// 保留半行到下一次 data，避免 JSON 被 chunk 边界截断。
		stdoutBuffer = splitJsonLines(stdoutBuffer + chunk, (line) => {
			if (line.trim() === "") {
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch (error) {
				// 非 JSON 行（例如日志混入 stdout）记录错误；RPC 协议要求每行一个 JSON。
				responseError = error instanceof Error ? error.message : String(error);
				return;
			}

			// 只认 type=response、id 匹配、command=get_state 的那一条。
			if (parsed?.type !== "response" || parsed.id !== requestId || parsed.command !== "get_state") {
				return;
			}

			if (parsed.success !== true) {
				responseError = typeof parsed.error === "string" ? parsed.error : "get_state failed";
				return;
			}

			// 第一次成功响应就是“RPC 可用”的时刻；关闭 stdin 触发正常退出。
			if (readyElapsedMs === undefined) {
				readyElapsedMs = performance.now() - startedAt;
				child.stdin.end();
			}
		});
	});

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	// 写入一行 JSON 请求；\n 是 RPC 协议的行分隔符。
	child.stdin.setDefaultEncoding("utf8");
	child.stdin.write(`${JSON.stringify({ id: requestId, type: "get_state" })}\n`);

	const exitCode = await waitForExit(child, `Benchmark ${measuredIndex === undefined ? `warmup ${runNumber}` : `run ${measuredIndex}`}`);

	try {
		// 先报告协议层错误，再检查是否真的收到响应。
		if (responseError) {
			throw new Error(responseError);
		}
		if (readyElapsedMs === undefined) {
			throw new Error(stderr.trim() || "RPC benchmark did not receive get_state response");
		}
		if (exitCode !== 0) {
			throw new Error(stderr.trim() || `Benchmark child exited with code ${exitCode}`);
		}

		const profilePath = options.cpuProfile ? join(profileDir, profileName) : undefined;
		if (profilePath && !existsSync(profilePath)) {
			throw new Error(`CPU profile was not written: ${profilePath}`);
		}

		return { elapsedMs: readyElapsedMs, profilePath, timings: parseStartupTimings(stderr) };
	} finally {
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}
}

// 按 mode 分派到对应运行器；参数对象整体透传。
async function runBenchmarkRun(params) {
	if (params.options.mode === "rpc") {
		return await runRpcBenchmarkRun(params);
	}
	return await runTuiBenchmarkRun(params);
}

// 主流程：解析参数、校验组合、准备入口和目录、执行 warmup + measured 运行、汇总输出。
async function main() {
	const options = parseArgs(process.argv.slice(2));
	// 帮助优先，不构建也不启动子进程。
	if (options.help) {
		printHelp();
		return;
	}

	// 两种 agent 目录来源互斥，同时指定会让行为不明确。
	if (options.agentDir && options.isolatedAgentDir) {
		throw new Error("--agent-dir and --isolated-agent-dir cannot be combined");
	}

	// TUI 基准需要真实终端；管道/CI 中无法初始化交互界面。
	if (options.mode === "tui" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
		throw new Error("TUI benchmark must be run from an interactive terminal.");
	}

	const runtime = resolveRuntime(options.runtime);
	// --bundle 只适用于 Node 的构建产物；Bun 直接跑源码。
	if (options.bundle && runtime !== "node") {
		throw new Error("--bundle only supports the Node runtime");
	}
	options.label = resolveLabel(options.mode, options.label);
	const profileDir = resolveProfileDir(runtime, options.profileDir);

	// Node 默认重新构建；--skip-build 复用现有 dist。Bun 不需要构建。
	if (runtime === "node" && options.build) {
		await runBuild(options.bundle);
	}
	if (runtime === "bun") {
		process.stdout.write(
			`Using Bun runtime with ${options.mode === "rpc" ? "packages/coding-agent/src/cli.ts --mode rpc" : "packages/coding-agent/src/cli.ts"}\n`,
		);
	}

	const entryPath = runtime === "bun" ? srcCliPath : options.bundle ? bundledDistCliPath : distCliPath;
	// 防止误测：npm run build 可能把 dist/cli.js 生成为只 re-export bundle 的门面；
	// 此时 --skip-build 的非 bundle profile 只会测到门面，提示用户去掉 --skip-build。
	if (
		runtime === "node" &&
		!options.bundle &&
		!options.build &&
		existsSync(distCliPath) &&
		readFileSync(distCliPath, "utf8").includes('import "./bundle/cli.js";')
	) {
		throw new Error("dist/cli.js is a bundled facade; rerun without --skip-build for an unbundled profile");
	}
	// 入口不存在通常意味着没构建或路径不对，直接给出明确错误。
	if (!existsSync(entryPath)) {
		throw new Error(`CLI entrypoint not found: ${entryPath}`);
	}

	// 即使不采集 CPU profile，也创建目录；后续可能追加输出。
	mkdirSync(profileDir, { recursive: true });

	const measuredRuns = [];
	const totalRuns = options.warmup + options.runs;
	for (let runIndex = 0; runIndex < totalRuns; runIndex++) {
		// warmup 阶段 measuredIndex 为 undefined；之后从 1 开始编号。
		const measuredIndex = runIndex >= options.warmup ? runIndex - options.warmup + 1 : undefined;
		const result = await runBenchmarkRun({
			runtime,
			runIndex,
			measuredIndex,
			options,
			profileDir,
		});

		process.stdout.write(
			`[${measuredIndex === undefined ? `warmup ${runIndex + 1}` : `run ${measuredIndex}`}] elapsed=${formatMs(result.elapsedMs)}\n`,
		);

		// 只有正式测量进入统计；warmup 结果丢弃。
		if (measuredIndex !== undefined) {
			measuredRuns.push(result);
		}
	}

	if (measuredRuns.length === 0) {
		process.stdout.write("\nNo measured runs requested.\n");
		return;
	}

	// 总耗时与各分段计时分别汇总；单次运行也走同一套统计，只是 min/max/median 相同。
	const elapsedSummary = summarize(measuredRuns.map((run) => run.elapsedMs));
	const timingSummaries = summarizeTimingMaps(measuredRuns);
	// 选出最慢的一次，CPU profile 推荐先看它；数组非空，reduce 不需要初始值。
	const maxElapsedRun = measuredRuns.reduce((slowest, run) => (run.elapsedMs > slowest.elapsedMs ? run : slowest));
	if (measuredRuns.length === 1) {
		process.stdout.write("\nResult\n");
		process.stdout.write(`  runtime:          ${runtime}${options.bundle ? " (bundle)" : ""}\n`);
		process.stdout.write(`  mode:             ${options.mode}\n`);
		process.stdout.write(`  elapsed:          ${formatMs(measuredRuns[0].elapsedMs)}\n`);
		for (const [label, summary] of timingSummaries.entries()) {
			process.stdout.write(`  ${label}: ${formatMs(summary.median)}\n`);
		}
		if (options.cpuProfile && maxElapsedRun.profilePath) {
			// 显示相对路径，便于在仓库根直接打开。
			process.stdout.write(`  selected profile: ${toDisplayPath(maxElapsedRun.profilePath)}\n`);
			process.stdout.write(`  profiles dir:     ${toDisplayPath(profileDir)}\n`);
		}
		// METRIC 行是稳定的机器可读格式，便于 CI 采集。
		process.stdout.write(`METRIC startup_time_ms=${measuredRuns[0].elapsedMs.toFixed(1)}\n`);
		for (const [label, summary] of timingSummaries.entries()) {
			process.stdout.write(`METRIC ${toMetricName(label)}=${summary.median.toFixed(1)}\n`);
		}
		return;
	}

	process.stdout.write("\nSummary\n");
	process.stdout.write(`  runtime:          ${runtime}${options.bundle ? " (bundle)" : ""}\n`);
	process.stdout.write(`  mode:             ${options.mode}\n`);
	process.stdout.write(`  elapsed min:      ${formatMs(elapsedSummary.min)}\n`);
	process.stdout.write(`  elapsed median:   ${formatMs(elapsedSummary.median)}\n`);
	process.stdout.write(`  elapsed avg:      ${formatMs(elapsedSummary.avg)}\n`);
	process.stdout.write(`  elapsed max:      ${formatMs(elapsedSummary.max)}\n`);
	for (const [label, summary] of timingSummaries.entries()) {
		process.stdout.write(`  ${label} median: ${formatMs(summary.median)}\n`);
	}
	if (options.cpuProfile && maxElapsedRun.profilePath) {
		process.stdout.write(`  selected profile: ${toDisplayPath(maxElapsedRun.profilePath)}\n`);
		process.stdout.write(`  profiles dir:     ${toDisplayPath(profileDir)}\n`);
	}
	process.stdout.write(`METRIC startup_time_ms=${elapsedSummary.median.toFixed(1)}\n`);
	for (const [label, summary] of timingSummaries.entries()) {
		process.stdout.write(`METRIC ${toMetricName(label)}=${summary.median.toFixed(1)}\n`);
	}
}

// 顶层错误出口：把 Error 或任意抛出值转成消息，打印到 stderr 并以 1 退出。
main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exit(1);
});
