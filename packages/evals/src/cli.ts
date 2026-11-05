/**
 * pi-evals 的文档对照评测命令行入口，也是整个比较流程的编排者。
 *
 * 所属包与模块：packages/evals 是 Pi coding agent 的行为评测包；本文件属于 src 下的
 * CLI 层。它由 package.json 的 `eval:docs` 脚本执行：
 * `node --experimental-strip-types src/cli.ts`。
 *
 * 本文件解决什么问题：在隔离容器中，对同一批文档评测用例分别跑
 * `without_docs`（不提供 Pi 文档）和 `with_docs`（提供 Pi 文档）两个镜像，
 * 然后按运行臂配对，计算“文档是否带来通过率提升”及 token、工具调用、耗时和成本差异。
 *
 * 上下游与结果流向：
 * - 上游：命令行参数与 PI_PROVIDER / PI_MODEL / PI_EVAL_RUNS_PER_VARIANT 环境变量。
 * - 下游：docker.ts 负责构建镜像、发现用例、执行单臂；plan.ts 负责用例与任务计划；
 *   report.ts 负责读取 Vitest JSON、配对观测并生成报告。
 * - 结果：写入 `.eval/<时间戳>_<uuid>/` 下的 protocol.json、expected-runs.json、
 *   observations.jsonl、tasks/<hash>/vitest.json、<variant>/sessions/<hash> 以及 report.json/report.txt。
 * - 错误：参数或环境配置错误同步抛出；Docker 失败或发现不一致也抛错；有被阻塞的配对时
 *   最终把 process.exitCode 设为 1，但已经写出的观测和报告保留。
 *
 * 本文件没有导出；它在被导入/执行时就会运行顶层流程。能力清单：
 * - EvalCliOptions：解析后的 CLI 配置形状（provider、model、重复次数、文件与发现参数）。
 * - RUNNER_OPTIONS / FILTER_OPTIONS：分别识别本运行器自己的选项和透传给 Vitest 的过滤选项。
 * - parseEvalCli：解析 argv 与环境变量，校验模型选择与重复次数。
 * - packageRoot / artifactRunId / containerPath / normalizeDiscoveredFile：
 *   路径与产物目录辅助。
 * - compareDiscovery：要求两个变体发现出完全相同的用例身份集合。
 * - 顶层代码：选择评测文件、构建镜像、发现用例、生成任务、逐个运行、汇总并落盘报告。
 *
 * 典型调用示例（示例，不是本文件自动执行的内容）：
 *   PI_PROVIDER=openai-codex PI_MODEL=gpt-5.6-sol \
 *     node --experimental-strip-types src/cli.ts evals/models.docs.eval.ts --runs-per-variant 2
 * 等价于把 provider/model 通过环境变量传入，只跑 models 文档评测，并对每个变体重复两次。
 *
 * 建议阅读顺序：先看 EvalCliOptions 与 parseEvalCli，理解选项从哪来；
 * 再看 packageRoot 附近的路径辅助；最后从 `const cli = parseEvalCli(...)` 开始顺序读顶层编排。
 */

import { createHash, randomUUID } from "node:crypto";
import { globSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildImages, createDockerContext, discoverCases, requireEvalAuthFile, runTask } from "./docker.ts";
import { createTaskPlan, type DiscoveredEvalCase, DOCUMENTATION_VARIANTS, parseDiscoveredCases } from "./plan.ts";
import {
	type EvalObservation,
	erroredObservation,
	formatEvalComparisonReport,
	readTaskObservation,
	summarizeEvalObservations,
} from "./report.ts";

// 解析结果只包含运行器真正需要的字段；可选字段用 `?:` 表示可能不存在（严格模式下需先收窄再使用）。
type EvalCliOptions = {
	// 模型供应商标识，例如 openai-codex；命令行与环境变量都未提供时为 undefined。
	provider?: string;
	// 模型 id，例如 gpt-5.6-sol；必须与 provider 同时出现。
	model?: string;
	// 每个变体重复运行几次，至少为 1。
	runsPerVariant: number;
	// 显式请求的 .docs.eval.ts 文件；为空表示用 glob 发现全部文档评测。
	requestedFiles: string[];
	// 透传给 Vitest discovery 的参数（例如 -t 过滤），不参与本地选项解析。
	discoveryArgs: string[];
};

// Set<string> 只用于 O(1) 成员检查；这些是运行器自己的选项名。
const RUNNER_OPTIONS = new Set(["--provider", "--model", "--runs-per-variant"]);
// Vitest 的测试名过滤选项；值会原样交给容器内的 discovery 命令。
const FILTER_OPTIONS = new Set(["-t", "--testNamePattern"]);

// 解析命令行参数与环境变量。输入默认使用 process.env，测试可注入替代环境。
// 返回 EvalCliOptions；缺少值、未知参数、模型选择不完整或重复次数非法时抛 Error。
// 示例：parseEvalCli(["--provider","p","--model","m"], {})
// 返回 { provider: "p", model: "m", runsPerVariant: 1, requestedFiles: [], discoveryArgs: [] }。
function parseEvalCli(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): EvalCliOptions {
	// 先声明为 undefined，后面根据命令行或环境变量决定最终值。
	let provider: string | undefined;
	let model: string | undefined;
	let runsText: string | undefined;
	// 标记“模型是否由命令行选择”，以决定是要求完整 CLI 选择还是允许环境变量回退。
	let cliSelectedModel = false;
	const requestedFiles: string[] = [];
	const discoveryArgs: string[] = [];

	// 用索引循环而不是 for...of，因为有些选项要消费下一个 argv 元素。
	for (let index = 0; index < args.length; index += 1) {
		// 未开启 noUncheckedIndexedAccess 时，数组下标访问按元素类型 string 处理。
		const argument = args[index];
		// 以 .docs.eval.ts 结尾的位置参数被视为要运行的评测文件，而不是选项。
		if (argument.endsWith(".docs.eval.ts")) {
			requestedFiles.push(argument);
			continue;
		}
		// -t / --testNamePattern 需要紧跟一个值；缺值就立刻报错，避免把下一条选项误当值。
		if (FILTER_OPTIONS.has(argument)) {
			const value = args[index + 1];
			if (!value) throw new Error(`Missing value for ${argument}.`);
			// 两个参数一起交给 Vitest；index += 1 跳过已经消费的值。
			discoveryArgs.push(argument, value);
			index += 1;
			continue;
		}
		// 也接受 --testNamePattern=value 的等号形式；等号后为空视为缺值。
		if (argument.startsWith("--testNamePattern=")) {
			if (argument.length === "--testNamePattern=".length) throw new Error("Missing value for --testNamePattern.");
			discoveryArgs.push(argument);
			continue;
		}

		// 统一处理 --name=value 与 --name value：先找等号，取出选项名。
		const equals = argument.indexOf("=");
		const name = equals === -1 ? argument : argument.slice(0, equals);
		// 只认识 RUNNER_OPTIONS 中的三个选项；其他内容一律拒绝，避免静默忽略拼写错误。
		if (RUNNER_OPTIONS.has(name)) {
			// 等号形式直接切出右侧；空格形式读取下一个参数。
			const value = equals === -1 ? args[index + 1] : argument.slice(equals + 1);
			// 空格形式下，值若以 "-" 开头说明调用者忘了传值（或传了另一个选项）。
			if (!value || (equals === -1 && value.startsWith("-"))) throw new Error(`Missing value for ${name}.`);
			// 根据选项名写入对应变量；--runs-per-variant 暂存字符串，稍后统一转数字。
			if (name === "--provider") provider = value;
			else if (name === "--model") model = value;
			else runsText = value;
			// provider/model 任一由 CLI 给出，就要求两者都由 CLI 给出，禁止与 env 混搭。
			if (name !== "--runs-per-variant") cliSelectedModel = true;
			// 空格形式消费了下一个参数，索引要前进。
			if (equals === -1) index += 1;
			continue;
		}
		// 到这里仍不认识，说明不是本运行器支持的参数。
		throw new Error(`Unsupported eval argument: ${argument}`);
	}

	// 去掉首尾空白；空字符串按未提供处理（`|| undefined`）。
	provider = provider?.trim() || undefined;
	model = model?.trim() || undefined;
	if (cliSelectedModel) {
		// 命令行选择必须成对出现，避免只覆盖一半而悄悄使用环境变量中的另一半。
		if (!provider || !model) throw new Error("CLI model selection requires both --provider and --model.");
	} else {
		// 没有 CLI 选择时，从环境变量读取默认值。
		provider = environment.PI_PROVIDER?.trim() || undefined;
		model = environment.PI_MODEL?.trim() || undefined;
		// Boolean(...) 比较把 undefined 和空字符串都视为 false，要求两者同时有或同时无。
		if (Boolean(provider) !== Boolean(model)) throw new Error("Set both PI_PROVIDER and PI_MODEL, or neither.");
	}

	// 命令行值优先于环境变量；两者都缺省时为 1。
	const configuredRuns = (runsText ?? environment.PI_EVAL_RUNS_PER_VARIANT)?.trim();
	const runsPerVariant = configuredRuns ? Number(configuredRuns) : 1;
	// 非数字字符串会得到 NaN，小数会得到非整数，都会被 isSafeInteger 拒绝；
	// 空串已在上面的三元表达式中按缺省值 1 处理，不会进入 Number 分支。
	if (!Number.isSafeInteger(runsPerVariant) || runsPerVariant < 1) {
		throw new Error("Runs per variant must be a positive integer.");
	}

	return { provider, model, runsPerVariant, requestedFiles, discoveryArgs };
}

// import.meta.url 是本模块的 file:// URL；fileURLToPath 转成本地路径，
// 再取 dirname 得到 src 目录，向上解析到 packages/evals。所有相对路径都以它为根，避免依赖进程 cwd。
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 产物目录名由 UTC ISO 时间戳和 UUID 组成。replaceAll(":", "-") 让目录名在 Windows 上也合法，
// 同时保留可读的日期时间；randomUUID 防止同一毫秒内多次运行互相覆盖。
function artifactRunId(): string {
	return `${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}`;
}

// 把用户给出的评测路径解析为相对 packageRoot 的路径，供容器内使用。
// 输入是文件参数；路径逃出 packages/evals 时抛 Error；返回使用 "/" 的相对路径。
// 示例：containerPath("evals/models.docs.eval.ts") -> "evals/models.docs.eval.ts"。
function containerPath(path: string): string {
	// resolve 以 packageRoot 为基准处理相对路径与 ".."；绝对路径则保持不变。
	const absolute = resolve(packageRoot, path);
	// relative 计算从包根到目标的相对路径。
	const packageRelative = relative(packageRoot, absolute);
	// 以 ".." 开头说明目标在包外；这里只做前缀检查，路径不存在时由后续读取报错。
	if (packageRelative.startsWith("..")) throw new Error(`Eval file must be inside ${packageRoot}: ${path}`);
	// 容器是 Linux，统一把 Windows 反斜杠换成 "/"。
	return packageRelative.replaceAll("\\", "/");
}

// 容器内 discovery 报告的文件路径形如 /repo/packages/evals/evals/x.docs.eval.ts；
// 去掉固定前缀后变成相对于包根的路径，才能与本地 files 列表对齐。
function normalizeDiscoveredFile(path: string): string {
	const prefix = "/repo/packages/evals/";
	if (!path.startsWith(prefix)) throw new Error(`Discovered eval path is outside the container package: ${path}`);
	// slice 从固定前缀长度开始截取，保留其后的相对路径。
	return path.slice(prefix.length);
}

// 比较两个变体发现出的用例集合是否一致。输入是两个 DiscoveredEvalCase 数组。
// 无返回值；身份集合不同时抛 Error。排序后序列化，避免数组顺序差异造成误报。
// 示例：left=[A]、right=[B] -> 抛 "Documentation variants discovered different eval cases."。
function compareDiscovery(left: readonly DiscoveredEvalCase[], right: readonly DiscoveredEvalCase[]): void {
	// 把每个用例归一化成 [fullName, 包内文件路径] 再排序；路径先去掉容器前缀。
	const identities = (cases: readonly DiscoveredEvalCase[]) =>
		cases.map(({ fullName, file }) => JSON.stringify([fullName, normalizeDiscoveredFile(file)])).sort();
	// 序列化整个身份数组再比较字符串；只要内容不同就说明两个镜像的用例队列不可比。
	if (JSON.stringify(identities(left)) !== JSON.stringify(identities(right))) {
		throw new Error("Documentation variants discovered different eval cases.");
	}
}

// 从这里开始是模块级执行流程。使用顶层 await，因此导入本模块就会跑完整个评测；
// 这不是可复用的库入口，而是被 node 直接执行的脚本。
const cli = parseEvalCli(process.argv.slice(2));
// slice(2) 跳过 node 可执行文件与脚本路径；此处保证最终一定拿到 provider 和 model。
if (!cli.provider || !cli.model) throw new Error("Set PI_PROVIDER and PI_MODEL, or pass --provider and --model.");
// 组合成报告与容器环境都使用的模型身份。
const selectedModel = { provider: cli.provider, model: cli.model };
const modelIdentity = `${selectedModel.provider}/${selectedModel.model}`;
// 有显式文件就只跑这些文件；否则用 globSync 在包根下发现全部文档评测。
const files = (
	cli.requestedFiles.length > 0 ? cli.requestedFiles : globSync("evals/**/*.docs.eval.ts", { cwd: packageRoot })
)
	// 统一转成包内相对路径并按字典序排序，确保 protocol 稳定可复现。
	.map(containerPath)
	.sort();
if (files.length === 0) throw new Error("No documentation eval files were selected.");
// 再次检查后缀：即使调用者用选项形式绕过位置参数判断，也不允许运行非文档评测。
for (const file of files) {
	if (!file.endsWith(".docs.eval.ts")) throw new Error(`Documentation runner cannot execute non-doc eval: ${file}`);
}

// 每次调用创建新的产物目录；mode 0o700 表示仅当前用户可进入。
const artifactDirectory = resolve(packageRoot, ".eval", artifactRunId());
// 容器内的 auth.json 来自宿主机 agent 目录；不存在或缺少该 provider 条目时在此提前失败。
const authPath = requireEvalAuthFile(selectedModel.provider);
await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
// 构建 without_docs 与 with_docs 两个镜像，并取回它们的镜像 id。
const images = buildImages();
// 两个镜像必须不同，否则“对照”实际上在同一种环境下运行，结果没有意义。
if (images.with_docs.id === images.without_docs.id)
	throw new Error("Documentation variants resolved to the same image.");
// 把镜像、产物目录、认证文件、模型与重复次数打包成执行上下文，交给 docker.ts。
const docker = createDockerContext(
	images,
	artifactDirectory,
	authPath,
	selectedModel.provider,
	selectedModel.model,
	cli.runsPerVariant,
);

// 依次在两个镜像里只做 discovery，不执行模型请求。
const discoveries = [];
for (const variant of DOCUMENTATION_VARIANTS) {
	// discoverCases 返回容器写出的 discovered-tests.json 路径。
	const path = discoverCases(docker, variant, files, cli.discoveryArgs);
	// 读取并解析 JSON；parseDiscoveredCases 负责运行时结构校验。
	discoveries.push(parseDiscoveredCases(JSON.parse(await readFile(path, "utf8"))));
}
// 要求两个变体拥有完全相同的用例集合，否则无法逐一配对。
compareDiscovery(discoveries[0], discoveries[1]);
// 以第一个变体的发现结果为基准，把容器路径换成包内路径；展开复制避免修改原始对象。
const cases = discoveries[0].map((evalCase) => ({ ...evalCase, file: normalizeDiscoveredFile(evalCase.file) }));
if (cases.length === 0) throw new Error("No documentation eval cases matched the selection.");
// 展开成 (用例, 变体, 模型, 重复序号) 的完整任务列表。
const tasks = createTaskPlan(cases, modelIdentity, cli.runsPerVariant);

// 协议对象固定本次运行的计划：模型、次数、镜像 id、文件、用例与任务。
// schemaVersion 是报告消费者识别格式版本的依据。
const protocol = {
	schemaVersion: 1,
	model: modelIdentity,
	runsPerVariant: cli.runsPerVariant,
	images,
	files,
	// 只保留身份字段，不把每轮任务都塞进用例列表。
	cases: cases.map(({ evalSet, caseId, file }) => ({ evalSet, caseId, file })),
	tasks,
};
// 对协议 JSON 计算 SHA-256 摘要，报告用它证明观测来自同一份计划。
const protocolText = JSON.stringify(protocol);
const protocolDigest = createHash("sha256").update(protocolText).digest("hex");
await writeFile(
	resolve(artifactDirectory, "protocol.json"),
	// 落盘时缩进 2 格并补一个换行，便于人工查看和版本控制 diff。
	`${JSON.stringify({ ...protocol, protocolDigest }, null, 2)}\n`,
);
// expected-runs.json 单独保存完整计划，报告会把它当作“应该出现哪些观测”的基准。
await writeFile(resolve(artifactDirectory, "expected-runs.json"), `${JSON.stringify(tasks, null, 2)}\n`);

// 按计划顺序逐臂执行；每条观测都立即追加到 observations.jsonl。
const observations: EvalObservation[] = [];
// entries() 同时提供序号和任务，用于输出进度。
for (const [index, task] of tasks.entries()) {
	// 进度行包含用例、变体、模型和重复序号，方便在长日志中定位。
	console.log(
		`\n[${index + 1}/${tasks.length}] ${task.evalSet} > ${task.caseId} | ${task.variant} | ${task.model} | run ${task.runNumber}`,
	);
	// runTask 在容器内运行单个测试并返回 vitest.json 路径；容器失败可能没有报告。
	const reportPath = runTask(docker, task);
	// 有报告就读取真实观测；没有报告就记为 errored，让配对阶段显式阻塞而不是丢弃。
	const observation: EvalObservation = reportPath
		? await readTaskObservation(task, reportPath, artifactDirectory)
		: erroredObservation(task);
	observations.push(observation);
	// JSONL 每行一条观测；每轮重写整个文件，保证中途崩溃时已有结果仍然落盘。
	await writeFile(
		resolve(artifactDirectory, "observations.jsonl"),
		`${observations.map((item) => JSON.stringify(item)).join("\n")}\n`,
	);
}

// 汇总：按 pairKey 分组、要求每个变体恰好一条可评分观测、计算提升与总指标。
const report = summarizeEvalObservations(protocolDigest, tasks, observations);
// 生成供终端阅读的文本报告；颜色由 styleText 根据终端能力决定。
const reportText = formatEvalComparisonReport(report);
// 同时保存机器可读的 report.json 与人类可读的 report.txt。
await writeFile(resolve(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(artifactDirectory, "report.txt"), `${reportText}\n`);
console.log(`\n${reportText}`);
console.log(`\nArtifacts: ${artifactDirectory}`);
// 有被阻塞的配对时以非零退出码结束，但此时报告已经写出，便于继续排查。
if (report.blockedPairs.length > 0) process.exitCode = 1;
