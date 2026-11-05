#!/usr/bin/env node

// 文件导读：对已构建的 pi 二进制做 codemode 端到端冒烟测试，不访问真实模型服务。
// 所属：仓库根 `scripts/` 的发布/CI 验证脚本；由 `.github/workflows/build-binaries.yml` 在构建产物后调用。
// 作用：在 127.0.0.1 随机端口启动一个假的 OpenAI `/chat/completions` 服务，临时目录写入
//   models.json，spawn 被测 pi 二进制并让它执行 `codemode` 工具；假服务第一次响应返回一个
//   codemode toolCall（调用 JS worker 打印 WORKER_MARKER），第二次校验工具结果里包含该 marker，
//   再回复 SUCCESS_MARKER。脚本同时验证进程退出码、stdout marker 与请求次数。
// 上游：`node scripts/smoke-test-codemode-binary.mjs <pi-binary>`（CI 传入构建出的可执行文件路径）；
//   参数必须是唯一的位置参数；`.js` 文件会用当前 Node 运行，其他扩展名直接执行。
// 下游：本地 HTTP 服务器、临时目录文件、spawn 被测二进制；环境变量 PI_CODING_AGENT_DIR 指向临时目录，
//   PI_OFFLINE=1 强制离线。被测进程的参数禁用 session/context/skills/prompts/themes，只启用 codemode。
// 输出与错误：成功把被测进程 stdout 转发到当前 stdout；失败抛出含 exit code、请求数与 stdout/stderr 的错误。
//   超时 30 秒会 kill 子进程。main().catch 打印错误并设 process.exitCode=1；成功退出码 0。
// 能力清单：
//   - completionChunk/sendCompletion：构造并发送 OpenAI streaming chunk。
//   - readRequest/toolResultContainsMarker：读取请求体并查找工具结果 marker。
//   - main：启动服务器、写配置、spawn、超时控制、断言与清理。
// 典型调用与预期：
//   示例 `node scripts/smoke-test-codemode-binary.mjs ./packages/coding-agent/dist/pi`；
//   打印被测进程的 `PI_CODEMODE_BINARY_SMOKE_OK`，退出码 0；二进制损坏或无 codemode 能力则退出 1。
// 阅读顺序：先看 marker 与 chunk 构造函数，再看服务器两次响应的状态机，最后读 main 的 spawn/断言/清理。
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

// worker 内部打印的标记，必须经 codemode 工具结果回到模型请求中。
const WORKER_MARKER = "PI_CODEMODE_WORKER_OK";
// 假服务第二次响应使用的成功标记；脚本在被测进程 stdout 中查找它。
const SUCCESS_MARKER = "PI_CODEMODE_BINARY_SMOKE_OK";
const FAILURE_MARKER = "PI_CODEMODE_BINARY_SMOKE_FAILED";
// 整个子进程生命周期上限；超时后 kill 并判失败。
const TIMEOUT_MS = 30_000;

// 构造一条 OpenAI chat.completion.chunk；usage 只在最后一块出现。
// delta 是本次增量对象（role/tool_calls/content），finishReason 为 null 表示流未结束。
function completionChunk(id, delta, finishReason = null, usage) {
	return {
		id,
		object: "chat.completion.chunk",
		created: 0,
		model: "codemode-smoke",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		// 条件展开：只有传入 usage 时才添加该字段，保持 chunk 形状与 OpenAI 流一致。
		...(usage ? { usage } : {}),
	};
}

// 以 text/event-stream 发送若干 chunk，并以 `data: [DONE]` 结束。
// 每个 chunk 一行 JSON 加空行；connection: close 让客户端读到流结束。
function sendCompletion(response, chunks) {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "close",
	});
	for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	response.end("data: [DONE]\n\n");
}

// 读取整个请求体（Buffer 逐块转字符串）；用于检查第二次请求是否带回工具结果。
async function readRequest(request) {
	let body = "";
	for await (const chunk of request) body += chunk.toString();
	return body;
}

// 判断请求 JSON 的 messages 中是否有一条 role=tool 的消息包含 worker marker。
// 只信任假客户端发来的 JSON，因此直接 JSON.parse（解析失败会让外层请求处理抛错）。
function toolResultContainsMarker(body) {
	const payload = JSON.parse(body);
	// 结构检查限定在 messages 数组；没有则返回 false。字符串化 content 兼容多模态块。
	return (
		Array.isArray(payload.messages) &&
		payload.messages.some(
			(message) => message?.role === "tool" && JSON.stringify(message.content).includes(WORKER_MARKER),
		)
	);
}

// 主流程：校验参数 → 建临时目录 → 启动假服务 → 写模型配置 → spawn 被测二进制 →
// 等待退出（带超时）→ 断言退出码/stdout/请求数 → 清理服务器与临时目录。
async function main() {
	// 只接受一个位置参数：二进制路径。多传/少传都视为用法错误。
	const binaryArg = process.argv[2];
	if (!binaryArg || process.argv.length !== 3) {
		throw new Error("Usage: node scripts/smoke-test-codemode-binary.mjs <pi-binary>");
	}
	const binary = resolve(binaryArg);
	// 每个测试独立临时目录，存放 models.json 与被测进程的 agent 状态；finally 中删除。
	const tempDir = await mkdtemp(join(tmpdir(), "pi-codemode-binary-smoke-"));
	let requestCount = 0;
	// 假 OpenAI 服务：只处理 POST .../chat/completions，其他请求 404。
	const server = createServer(async (request, response) => {
		if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
			response.writeHead(404).end();
			return;
		}
		const body = await readRequest(request);
		requestCount++;
		const id = `chatcmpl-codemode-smoke-${requestCount}`;
		// 第一次请求：要求模型调用 codemode，代码内容就是打印 worker marker。
		// 这样可验证二进制里的 worker 能真正执行 JS，而不是只加载工具定义。
		if (requestCount === 1) {
			sendCompletion(response, [
				completionChunk(id, {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "call_codemode_smoke",
							type: "function",
							function: {
								name: "codemode",
								arguments: JSON.stringify({ code: `text("${WORKER_MARKER}")` }),
							},
						},
					],
				}),
				completionChunk(id, {}, "tool_calls", { prompt_tokens: 1, completion_tokens: 1 }),
			]);
			return;
		}
		// 第二次及以后：检查请求里是否带回 marker；据此回复成功或失败标记，让被测进程退出。
		const marker = toolResultContainsMarker(body) ? SUCCESS_MARKER : FAILURE_MARKER;
		sendCompletion(response, [
			completionChunk(id, { role: "assistant", content: marker }),
			completionChunk(id, {}, "stop", { prompt_tokens: 1, completion_tokens: 1 }),
		]);
	});

	try {
		// 监听随机端口（0），只绑定回环地址，避免暴露到网络。
		await new Promise((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolveListen);
		});
		const address = server.address();
		// listen 成功后 address 应是对象；字符串表示 Unix socket，不符合本测试预期。
		if (!address || typeof address === "string") throw new Error("Smoke-test server did not bind to a TCP port");
		// 通过 PI_CODING_AGENT_DIR 让被测进程读取这个自定义 provider，指向假服务。
		await writeFile(
			join(tempDir, "models.json"),
			JSON.stringify({
				providers: {
					"codemode-smoke": {
						baseUrl: `http://127.0.0.1:${address.port}/v1`,
						api: "openai-completions",
						apiKey: "smoke-test",
						models: [{ id: "codemode-smoke" }],
					},
				},
			}),
		);

		// 参数刻意最小化：只启用 codemode，禁用会话/上下文文件/技能/模板/主题，保证测试隔离。
		const piArgs = [
			"--provider",
			"codemode-smoke",
			"--model",
			"codemode-smoke",
			"--tools",
			"codemode",
			"--print",
			"--no-session",
			"--offline",
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"Run the codemode binary smoke test.",
		];
		// CI 可能直接传构建出的 .js 入口；此时用当前 Node 执行它，其他扩展名直接 spawn。
		const javaScript = extname(binary) === ".js";
		const child = spawn(javaScript ? process.execPath : binary, javaScript ? [binary, ...piArgs] : piArgs, {
			cwd: tempDir,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: tempDir,
				PI_OFFLINE: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		// 收集完整输出，失败时一并放进错误消息，便于 CI 日志定位。
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		// 等待退出并施加 30 秒超时；超时先 kill 再 reject。
		const exitCode = await new Promise((resolveExit, reject) => {
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error(`Smoke test timed out after ${TIMEOUT_MS} ms`));
			}, TIMEOUT_MS);
			// spawn 失败没有 exit；clearTimeout 防止之后再次触发超时。
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				resolveExit(code);
			});
		});
		// 三个条件同时成立才算通过：正常退出、stdout 含成功标记、至少两次模型请求（含工具结果回传）。
		if (exitCode !== 0 || !stdout.includes(SUCCESS_MARKER) || requestCount < 2) {
			throw new Error(
				`Codemode binary smoke test failed (exit ${exitCode}, requests ${requestCount})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
			);
		}
		process.stdout.write(stdout);
	} finally {
		// 先关服务器，再删临时目录；force 忽略删除时的缺失文件。
		await new Promise((resolveClose) => server.close(resolveClose));
		await rm(tempDir, { recursive: true, force: true });
	}
}

// 顶层错误处理：只打印 message，设置 exitCode=1 而不是立即退出，允许事件循环自然收尾。
main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
