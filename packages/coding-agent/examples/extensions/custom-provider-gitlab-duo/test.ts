/**
 * Test script for GitLab Duo extension
 * Run: node test.ts [model-id] [--thinking]
 *
 * Examples:
 *   node test.ts                              # Test default (claude-sonnet-4-5-20250929)
 *   node test.ts gpt-5-codex                  # Test GPT-5 Codex
 *   node test.ts claude-sonnet-4-5-20250929 --thinking
 */

/**
 * 文件导读（GitLab Duo 扩展示例的命令行冒烟测试）
 *
 * 所属与用途：本文件是 `custom-provider-gitlab-duo` 示例附带的独立测试脚本，不经过 pi 宿主，
 * 直接用 `registerApiProvider` 注册 `streamGitLabDuo`，再发一条固定的用户消息验证端到端流。
 * 它演示如何在宿主之外调用 pi-ai 的 `streamSimple`，以及如何手工读取宿主保存的 OAuth 凭证。
 *
 * 上游如何进入：在本目录执行 `node test.ts [model-id] [--thinking]`（Node 需要能剥离 TypeScript
 * 类型；仓库要求的 Node 版本满足这一点）。同目录 `index.ts` 提供模型目录和流函数。
 * 下游调用：向 GitLab 换取 direct access token，再经 AI Gateway 请求模型；会产生网络费用。
 *
 * 能力清单：
 * - 解析第一个位置参数作为模型 id，默认 `claude-sonnet-4-5-20250929`；
 * - 扫描 `--thinking` 决定是否请求低档推理；
 * - 读取凭证文件中的 `gitlab-duo.access`；
 * - 注册 API provider，构造 `Model` 与 `Context`，调用 `streamSimple` 并打印思考/文本/错误/用量。
 *
 * 输入/输出/退出码：
 * - 输入：命令行参数；凭证文件。不发任何文件写入。
 * - stdout：模型信息、思考过程、模型文本、完成后的 usage。
 * - stderr：未知模型或缺少凭证时的说明。
 * - 退出码：未知模型、缺少凭证时显式 `process.exit(1)`；读取/解析凭证失败由
 *   `main().catch(console.error)` 打印，但进程通常仍以 0 退出；模型流中的 error 事件也只打印，
 *   不会改变退出码。因此自动化使用时不能只看退出码。
 *
 * 运行示例：
 *   node test.ts gpt-5-codex --thinking
 * 预期（凭证文件位于脚本期望的旧路径时）：先打印
 * `Model: gpt-5-codex, Backend: openai, Thinking: true`，随后是思考/文本，
 * 最后打印 `Done! ...` 及 usage。若流失败，会打印 `Error: ...` 后正常结束。
 *
 * 重要风险：本脚本读取 `join(getAgentDir(), "extensions", "auth.json")`，这是旧版路径；
 * 当前宿主把凭证保存在 `join(getAgentDir(), "auth.json")`（`getAuthPath()`）。按当前版本运行时
 * 通常会在 `readFileSync` 处 ENOENT，需先把文件放到脚本期望的位置，或修改脚本（本学习任务不改代码）。
 *
 * 建议阅读顺序：先看参数解析与凭证读取，再看 provider 注册和模型构造，最后看事件循环。
 */

import { type Api, type Context, type Model, registerApiProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "fs";
import { join } from "path";
import { MODELS, streamGitLabDuo } from "./index.ts";

// 与 index.ts 相同的 id -> 模型配置映射，用于校验命令行传入的 id。
const MODEL_MAP = new Map(MODELS.map((m) => [m.id, m]));

/**
 * 脚本主流程：解析参数、读取凭证、注册 provider、发起一次流式请求并打印结果。
 *
 * 输入：`process.argv`（Node 命令行参数数组；索引 0/1 是 node 与脚本路径）。
 * 输出：无返回值，结果写到 stdout/stderr。
 * 副作用：读取凭证文件；发起真实网络请求；不写文件。
 * 错误路径：未知模型/缺凭证时 `process.exit(1)` 立即结束；文件读取或 JSON 解析异常由文件末尾的
 * `catch` 打印，进程退出码仍为 0。
 * 主要流程：取模型 id -> 查配置 -> 读 `gitlab-duo` 凭证 -> 注册 API -> 构造模型与上下文 ->
 * 调用 `streamSimple` -> 按事件类型打印。
 *
 * 示例：`node test.ts gpt-5-codex`；真实运行会先打印 Model 行，再流式输出模型回复。
 */
async function main() {
	// `argv[2]` 是第一个自定义参数；`||` 在缺省（空串）时落回默认模型。
	const modelId = process.argv[2] || "claude-sonnet-4-5-20250929";
	// 不要求 `--thinking` 在固定位置，只要参数数组中出现即可。
	const useThinking = process.argv.includes("--thinking");

	const cfg = MODEL_MAP.get(modelId);
	if (!cfg) {
		console.error(`Unknown model: ${modelId}`);
		console.error("Available:", MODELS.map((m) => m.id).join(", "));
		// 退出码 1 表示“参数错误”，自动化脚本可据此判断。
		process.exit(1);
	}

	// Read auth
	// 注意：这是旧版凭证路径。当前宿主写入的是 `<agentDir>/auth.json`，不是 `extensions/auth.json`。
	const authPath = join(getAgentDir(), "extensions", "auth.json");
	// 没有 try/catch：文件不存在或 JSON 非法会 reject，最终由 `main().catch(console.error)` 打印。
	const authData = JSON.parse(readFileSync(authPath, "utf-8"));
	// 供应商 id 是 auth.json 的顶层键；OAuth 条目形如
	// `{ "gitlab-duo": { type: "oauth", access, refresh, expires } }`。
	const gitlabCred = authData["gitlab-duo"];
	// 可选链 `?.` 防止 gitlabCred 为 undefined 时访问 `.access` 抛错。
	if (!gitlabCred?.access) {
		console.error("No gitlab-duo credentials. Run /login gitlab-duo first.");
		process.exit(1);
	}

	// Register provider
	// 在宿主外调用 `streamSimple` 前，必须先让 pi-ai 知道哪个 API 标识对应哪个实现。
	// `stream` 与 `streamSimple` 都指向同一个函数；类型断言只用于满足 `Api` 品牌类型。
	registerApiProvider({
		api: "gitlab-duo-api" as Api,
		stream: streamGitLabDuo,
		streamSimple: streamGitLabDuo,
	});

	// Create model
	// 手工构造与宿主注册时等价的模型对象；缺少字段会在编译期报错。
	const model: Model<Api> = {
		id: cfg.id,
		name: cfg.name,
		api: "gitlab-duo-api" as Api,
		provider: "gitlab-duo",
		baseUrl: cfg.baseUrl,
		reasoning: cfg.reasoning,
		input: cfg.input,
		cost: cfg.cost,
		contextWindow: cfg.contextWindow,
		maxTokens: cfg.maxTokens,
	};

	// 最小上下文：一条用户消息。`timestamp` 是 Pi 消息类型的必填字段。
	const context: Context = {
		messages: [{ role: "user", content: "Say hello in exactly 3 words.", timestamp: Date.now() }],
	};

	console.log(`Model: ${model.id}, Backend: ${cfg.backend}, Thinking: ${useThinking}`);

	// `streamSimple` 按 model.api 找到刚注册的实现；apiKey 是 GitLab 访问令牌。
	// `reasoning: undefined` 表示不请求思考；`--thinking` 时请求低档。
	const stream = streamSimple(model, context, {
		apiKey: gitlabCred.access,
		maxTokens: 100,
		reasoning: useThinking ? "low" : undefined,
	});

	// 逐事件消费；字符串增量直接写入 stdout，避免每次 console.log 多换行。
	for await (const event of stream) {
		if (event.type === "thinking_start") console.log("[Thinking]");
		else if (event.type === "thinking_delta") process.stdout.write(event.delta);
		else if (event.type === "thinking_end") console.log("\n[/Thinking]\n");
		else if (event.type === "text_delta") process.stdout.write(event.delta);
		// error 事件不会 throw，因此循环会正常结束，退出码仍为 0。
		else if (event.type === "error") console.error("\nError:", event.error.errorMessage);
		else if (event.type === "done") console.log("\n\nDone!", event.reason, event.message.usage);
	}
}

// 顶层调用返回 Promise；`.catch` 只负责打印，不重新抛错，所以不会设置非零退出码。
main().catch(console.error);
