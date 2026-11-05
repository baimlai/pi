/**
 * pi-evals 的 Docker 执行层：构建两个对照镜像、检查认证文件、在隔离容器里发现用例并运行单个任务。
 *
 * 所属包与模块：packages/evals/src 的容器执行层。它把 cli.ts 的计划翻译成
 * `docker build` / `docker run` 命令，不解析 Vitest 报告，也不计算评测结论。
 *
 * 责任边界：
 * - 只负责“怎么在容器里跑”和产物路径；用例结构由 plan.ts 校验，观测语义由 report.ts 解析。
 * - 所有容器都以 --read-only 启动，仅挂载产物目录与只读 auth.json，并写入临时目录。
 * - Docker 自身失败通过退出码与抛错体现；单个评测失败通常仍会留下 vitest.json，
 *   由 report.ts 判定为 errored，而不是在这里中断整批计划。
 *
 * 上下游：
 * - 上游入口是 cli.ts：buildImages → requireEvalAuthFile → createDockerContext →
 *   discoverCases → runTask。
 * - 下游依赖本机 docker CLI 与 packages/evals/docker/Dockerfile、docker/entrypoint.ts；
 *   容器入口负责校验镜像内容、复制凭据并调用 Vitest；harness 在进程内完成降权。
 * - 结果：发现阶段返回 discovered-tests.json 路径；执行阶段返回 vitest.json 路径（可能不存在）。
 *
 * 本文件的能力清单：
 * - BuiltImages：两个变体到镜像名/镜像 id 的映射。
 * - DockerContext：执行一次比较所需的只读上下文（非导出类型，仅在包内传递）。
 * - execute / requireSuccess：同步调用外部命令并统一处理退出码。
 * - buildImages：按仓库路径哈希构建并检查两个变体镜像。
 * - environment：生成 docker 的 `--env NAME=value` 参数对。
 * - requireEvalAuthFile：定位并校验宿主机 auth.json 中存在指定 provider 的凭据。
 * - dockerArgs：组装一次 `docker run` 的隔离参数与挂载。
 * - createDockerContext：把执行参数收拢成上下文对象。
 * - discoverCases：在容器内只执行 discovery，返回 JSON 文件路径。
 * - taskDirectoryName：由任务身份哈希出稳定的产物子目录名。
 * - runTask：用精确测试名过滤器运行单个任务，返回报告路径或 undefined。
 *
 * 典型调用示例（示例，不是本文件自动执行的内容）：
 *   const images = buildImages();
 *   const authPath = requireEvalAuthFile("openai-codex");
 *   const context = createDockerContext(images, "/repo/.eval/run", authPath, "openai-codex", "gpt-5.6-sol", 1);
 *   const discovery = discoverCases(context, "without_docs", ["evals/models.docs.eval.ts"], []);
 *   const report = runTask(context, task); // report 为 vitest.json 路径或 undefined
 *
 * 建议阅读顺序：先看 execute/requireSuccess 与 environment 这些薄辅助，
 * 再看 buildImages 与 requireEvalAuthFile 的准备阶段，最后看 dockerArgs 和 discover/runTask 的执行阶段。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DocumentationVariant, EvalTask } from "./plan.ts";

// 本文件位于 packages/evals/src，因此 dirname 是 src，向上一级得到包根。
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 再向上一级是 monorepo 仓库根，也是 docker build 的构建上下文。
const repositoryRoot = resolve(packageRoot, "../..");

// Record 映射类型要求两个变体键都存在；值的 name 是 Docker 标签，id 是构建后 inspect 的镜像摘要。
// 这是编译期结构约束，运行时不会自动校验对象是否真的包含两个键。
export type BuiltImages = Record<DocumentationVariant, { name: string; id: string }>;

// 包内执行上下文：只保存一次比较运行期间不变的值，避免每个辅助函数都传一长串参数。
// 它不是导出 API，字段由 createDockerContext 一次性填好。
type DockerContext = {
	// 两个已构建并 inspect 过的镜像。
	images: BuiltImages;
	// 宿主机上本次运行的产物根目录，会被挂载到容器的 /artifacts。
	artifactDirectory: string;
	// 宿主机 auth.json 的绝对路径，以只读方式挂载给容器入口。
	authPath: string;
	// 模型供应商，写入容器环境变量 PI_PROVIDER。
	provider: string;
	// 模型 id，写入容器环境变量 PI_MODEL。
	model: string;
	// 每个变体的重复次数，写入容器环境变量供容器内 harness 使用。
	runsPerVariant: number;
};

// 同步执行外部命令。capture 为 true 时只捕获 stdout，stderr 仍继承到当前终端；
// 返回退出码与 stdout，不根据退出码抛错。spawnSync 返回的 status 在信号终止时为 null，
// 这里用 `?? 1` 归一化为失败。示例：execute("docker", ["--version"], true)。
function execute(command: string, args: readonly string[], capture = false): { status: number; stdout: string } {
	const result = spawnSync(command, args, {
		// 所有命令都在包根执行，使 Dockerfile 与相对路径保持一致。
		cwd: packageRoot,
		// 捕获模式忽略 stdin、管道捕获 stdout、stderr 继续打印；否则三者都继承。
		stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
		// 把 stdout 解码为字符串，capture 为 false 时此选项无害。
		encoding: "utf8",
	});
	// spawnSync 自身的启动错误（例如找不到 docker）通过 error 返回，而不是非零退出码。
	if (result.error) throw result.error;
	return { status: result.status ?? 1, stdout: capture ? result.stdout : "" };
}

// 执行命令并要求成功。输入命令与参数；非零退出码时抛 Error，无返回值。
// 示例：requireSuccess("docker", ["image", "inspect", "x"])。
function requireSuccess(command: string, args: readonly string[]): void {
	const { status } = execute(command, args);
	if (status !== 0) throw new Error(`${command} exited with status ${status}.`);
}

// 构建 without_docs 与 with_docs 两个镜像，并返回带镜像 id 的映射。
// 输入无；Docker 构建或 inspect 失败时抛错。同名镜像会被重新构建。
// 示例：buildImages() -> { without_docs: { name: "pi-evals-abc-without-docs:local", id: "sha256:..." }, ... }。
export function buildImages(): BuiltImages {
	// 镜像名前缀包含仓库根路径的 SHA-256 前 12 位，避免不同 checkout 的同名镜像互相覆盖。
	const prefix = `pi-evals-${createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 12)}`;
	// satisfies 在保留字面量推断的同时检查对象满足 BuiltImages；id 先置空，构建后填写。
	const images = {
		without_docs: { name: `${prefix}-without-docs:local`, id: "" },
		with_docs: { name: `${prefix}-with-docs:local`, id: "" },
	} satisfies BuiltImages;
	// 用 as const 的元组遍历两个键，保证类型上是 DocumentationVariant 而不是宽泛 string。
	for (const variant of ["without_docs", "with_docs"] as const) {
		// --target 选择 Dockerfile 中对应的构建阶段；构建上下文是整个仓库根。
		requireSuccess("docker", [
			"build",
			"--target",
			variant,
			"--tag",
			images[variant].name,
			"--file",
			join(packageRoot, "docker", "Dockerfile"),
			repositoryRoot,
		]);
		// 取镜像的完整 Id；--format 使用 Go 模板语法。
		const inspected = execute("docker", ["image", "inspect", "--format", "{{.Id}}", images[variant].name], true);
		if (inspected.status !== 0 || !inspected.stdout.trim())
			throw new Error(`Cannot inspect ${images[variant].name}.`);
		// trim 去掉 inspect 输出末尾的换行后再保存。
		images[variant].id = inspected.stdout.trim();
	}
	return images;
}

// 生成 docker 的 `--env NAME=value` 两个参数。单独封装是为了让 dockerArgs 更易读。
function environment(name: string, value: string): string[] {
	return ["--env", `${name}=${value}`];
}

// 定位并校验评测认证文件。输入 provider 名称；返回 auth.json 的绝对路径。
// 文件不存在、不是普通文件、JSON 非法或缺少该 provider 键时抛 Error。
// 只检查根对象存在该键，不验证凭据内部结构或是否仍然有效。
// 示例：requireEvalAuthFile("openai-codex") -> "/Users/me/.pi/agent/auth.json"。
export function requireEvalAuthFile(provider: string): string {
	const path = join(
		// PI_CODING_AGENT_DIR 指向自定义 agent 目录；否则使用家目录下的 ~/.pi/agent。
		process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent"),
		"auth.json",
	);
	// existsSync 处理“不存在”，statSync().isFile() 排除目录或特殊文件。
	if (!existsSync(path) || !statSync(path).isFile())
		throw new Error(`Eval authentication file does not exist: ${path}`);
	// credentials 来自外部文件，因此类型是 unknown，必须逐步收窄。
	let credentials: unknown;
	try {
		credentials = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		// { cause: error } 保留底层解析错误，同时给出带路径的可读消息。
		throw new Error(`Eval authentication file is invalid: ${path}`, { cause: error });
	}
	// 依次排除非对象、null、数组；Object.hasOwn 只检查自有属性，避免原型链上的同名键。
	if (
		typeof credentials !== "object" ||
		credentials === null ||
		Array.isArray(credentials) ||
		!Object.hasOwn(credentials, provider)
	) {
		throw new Error(`Eval authentication file has no credential for provider ${provider}.`);
	}
	return path;
}

// 组装一次 docker run 的完整参数。输入上下文、变体、宿主机产物目录和容器入口参数。
// 副作用：创建产物目录（0o700）。返回参数数组，供 execute 直接使用。
// 容器根文件系统只读，/tmp 与 Vite 临时目录用 tmpfs 提供可写空间；
// 产物目录可写挂载到 /artifacts，auth.json 以只读文件挂载。
function dockerArgs(
	context: DockerContext,
	variant: DocumentationVariant,
	outputDirectory: string,
	entrypointArgs: readonly string[],
): string[] {
	// 每个任务/发现阶段独立目录，权限只给当前用户。
	mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
	const args = [
		"run",
		// --rm 在容器退出后删除容器层，避免堆积。
		"--rm",
		// --read-only 让根文件系统不可写，防止评测过程中的产出污染镜像。
		"--read-only",
		// tmpfs 在内存中提供可执行临时目录，模式 1777 允许所有用户写入自己的文件。
		"--tmpfs",
		"/tmp:rw,exec,mode=1777",
		// Vite 会在 node_modules 下创建临时目录；根只读时必须单独给它可写空间。
		"--tmpfs",
		"/repo/node_modules/.vite-temp:rw,exec,mode=1777",
		// 把宿主机任务目录绑定挂载到容器的 /artifacts，报告和会话写回这里。
		"--mount",
		`type=bind,source=${outputDirectory},target=/artifacts`,
		// 容器入口和 harness 通过这些环境变量知道产物目录、重复次数与沙箱身份。
		...environment("PI_EVAL_ARTIFACT_DIR", "/artifacts"),
		...environment("PI_EVAL_RUNS_PER_VARIANT", String(context.runsPerVariant)),
		...environment("PI_EVAL_SANDBOX_UID", "65532"),
		...environment("PI_EVAL_SANDBOX_GID", "65532"),
		...environment("PI_PROVIDER", context.provider),
		...environment("PI_MODEL", context.model),
	];
	// 宿主机不是所有平台都有 POSIX uid/gid（例如 Windows）；有就告诉容器把产物 chown 回调用者。
	if (typeof process.getuid === "function" && typeof process.getgid === "function") {
		args.push(
			...environment("PI_EVAL_ARTIFACT_UID", String(process.getuid())),
			...environment("PI_EVAL_ARTIFACT_GID", String(process.getgid())),
		);
	}
	// 认证文件只读挂载到固定路径；容器入口把它复制到临时 agent 目录，harness 读取后再删除。
	args.push("--mount", `type=bind,source=${context.authPath},target=/run/pi-eval-secrets/auth.json,readonly`);
	// 镜像名之后是容器入口参数，例如 --discover 或 --project docs。
	args.push(context.images[variant].name, ...entrypointArgs);
	return args;
}

// 创建执行上下文。输入均为一次运行期间不变的值；返回 DockerContext，无副作用。
// 示例：createDockerContext(images, "/tmp/run", "/home/me/.pi/agent/auth.json", "p", "m", 1)。
export function createDockerContext(
	images: BuiltImages,
	artifactDirectory: string,
	authPath: string,
	provider: string,
	model: string,
	runsPerVariant: number,
): DockerContext {
	// 属性简写把同名参数直接放进对象。
	return { images, artifactDirectory, authPath, provider, model, runsPerVariant };
}

// 在指定变体镜像里只发现用例，不执行模型请求。输入上下文、变体、文件列表与额外 Vitest 参数；
// 返回容器写出的 discovered-tests.json 的宿主机路径。容器失败时抛 Error。
// 示例：discoverCases(ctx, "with_docs", ["evals/models.docs.eval.ts"], ["-t", "adds the model"])。
export function discoverCases(
	context: DockerContext,
	variant: DocumentationVariant,
	files: readonly string[],
	vitestArgs: readonly string[],
): string {
	// 每次发现使用独立目录，两个变体互不覆盖。
	const outputDirectory = join(context.artifactDirectory, "discovery", variant);
	// --discover、--project docs 与评测文件由容器入口转交给 Vitest。
	const args = dockerArgs(context, variant, outputDirectory, [
		"--discover",
		"--project",
		"docs",
		...files,
		...vitestArgs,
	]);
	const { status } = execute("docker", args);
	if (status !== 0) throw new Error(`${variant} eval discovery failed.`);
	// 即使退出码为 0，后续读取也会验证文件确实存在。
	return join(outputDirectory, "discovered-tests.json");
}

// 任务目录名：对 [evalSet, caseId, variant, model, runNumber] 做 SHA-256。
// 输入一个 EvalTask；返回 64 位十六进制字符串。哈希避免用例名中的斜杠等字符破坏路径。
function taskDirectoryName(task: EvalTask): string {
	const identity = JSON.stringify([task.evalSet, task.caseId, task.variant, task.model, task.runNumber]);
	return createHash("sha256").update(identity).digest("hex");
}

// 在一个全新容器里运行单个任务。输入上下文与任务；返回 vitest.json 路径，
// 若容器没有写出报告则返回 undefined。这里故意不检查退出码：
// 测试失败是有意义的观测，报告可能仍然存在，由 report.ts 分类。
// 示例：runTask(ctx, task) -> "/repo/.eval/run/tasks/<hash>/vitest.json"。
export function runTask(context: DockerContext, task: EvalTask): string | undefined {
	// 任务目录按身份哈希命名，重复运行同一任务会复用同一目录并可覆盖旧产物。
	const outputDirectory = join(context.artifactDirectory, "tasks", taskDirectoryName(task));
	// Vitest 报告的 fullName 由祖先标题和用例标题以空格连接；discovery 名称用 " > " 分隔，
	// 这里要转换成报告格式，才能用 --testNamePattern 精确选中该用例。
	const testName = `${task.evalSet} ${task.caseId}`;
	// 转义正则元字符，再锚定首尾，确保只匹配这一个用例，避免前缀误匹配。
	const exactName = `^${testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
	const args = dockerArgs(context, task.variant, outputDirectory, [
		"--project",
		"docs",
		task.file,
		"--testNamePattern",
		exactName,
	]);
	execute("docker", args);
	// 容器退出码不决定返回值；只有真实存在的 JSON 才能交给 report.ts 读取。
	const reportPath = join(outputDirectory, "vitest.json");
	return existsSync(reportPath) ? reportPath : undefined;
}
