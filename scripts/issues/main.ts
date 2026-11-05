// 文件导读
// 所属：仓库根 scripts/issues/ 的 issue 分诊服务入口，通常通过 scripts/issues/run.sh 启动。
// 职责：打开持久化 Triage（pi-durable Harness + SQLite）、同步 issue 语料、后台队列分诊，
//   并在本地 HTTP 服务上提供状态/会话/决策接口与单页 UI；用一次性 token 链接认证。
// 能力：Triage 初始化/恢复；定时同步语料；JSON API 与 UI 路由；一次性 token 换取 cookie；信号关闭。
// 上游：run.sh → node --conditions=source --import ./scripts/issues/register.mjs scripts/issues/main.ts。
// 下游：github.ts（Corpus/gh）、triage.ts（Triage/pi-durable）、ui.html（浏览器页面）、data/ 下的 corpus/token/sqlite。
// 环境变量：
//   TRIAGE_DATA（默认 scripts/issues/data）数据目录；TRIAGE_MODEL（provider/modelId，默认 openai-codex/gpt-5.6-sol）；
//   TRIAGE_THINKING（默认 medium）；TRIAGE_SYNC_MINUTES（20）；TRIAGE_CORPUS_DAYS（120）；
//   TRIAGE_CONCURRENCY（4）；TRIAGE_INBOX_DAYS（2）；TRIAGE_SOCKET（Unix socket 路径，优先于端口）；TRIAGE_PORT（7788）。
// 输入：HTTP 请求（token 查询参数或 cookie）。输出：JSON API/HTML 页面；启动时打印监听地址与 token 文件位置。
// 副作用：创建数据目录；首次生成 data/token（0600）；同步时调用 gh 并写 corpus.json；打开 SQLite；
//   监听 127.0.0.1 或 Unix socket（0660）；定时同步；SIGINT/SIGTERM 时关闭服务器与 Triage 后退出。
// 退出码：正常运行直到收到信号，收到后以 0 退出；启动阶段异常（triage.open/端口占用等）为未捕获拒绝，进程非零退出。
// 示例：
//   scripts/issues/run.sh
//   TRIAGE_SOCKET=/tmp/triage.sock TRIAGE_MODEL=anthropic/claude-sonnet-4-5 scripts/issues/run.sh
// 建议阅读顺序：环境与 Triage 初始化 → runSync → view → 认证/JSON/响应辅助 → 路由 → 监听与信号处理。
// Issue triage: sync issues, triage new ones with a pi-durable agent, and serve a small web UI for decisions.
// See README.md.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// 仅类型导入：ModelThinkingLevel 是联合字面量，运行时不存在。
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Corpus, inInbox, issueStatus, REPO } from "./github.ts";
import { PRIORITIES, type Priority, Triage } from "./triage.ts";

// 数据目录可由 TRIAGE_DATA 覆盖；mkdirSync 保证 Corpus/token/SQLite 有可写位置。
const scriptDir = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.TRIAGE_DATA ?? join(scriptDir, "data");
mkdirSync(dataDir, { recursive: true });
// 只按第一个 / 切分；空字符串被 filter(Boolean) 去掉，因此未设置时使用默认 provider/modelId。
const [provider = "openai-codex", modelId = "gpt-5.6-sol"] = (process.env.TRIAGE_MODEL ?? "")
	.split("/")
	.filter(Boolean);
// 定时同步间隔（分钟）；Number 解析失败会得到 NaN，setInterval 会退化为极短间隔，配置时需填有效数字。
const syncMinutes = Number(process.env.TRIAGE_SYNC_MINUTES ?? 20);

// 语料文件不存在时按 TRIAGE_CORPUS_DAYS 回溯初始化 since。
const corpus = new Corpus(join(dataDir, "corpus.json"), Number(process.env.TRIAGE_CORPUS_DAYS ?? 120));
const triage = new Triage({
	dataDir,
	scriptDir,
	corpus,
	model: { provider, modelId },
	// 环境变量绕过类型检查，这里显式断言为模型层认识的级别；非法值会在使用时报错。
	thinkingLevel: (process.env.TRIAGE_THINKING ?? "medium") as ModelThinkingLevel,
	concurrency: Number(process.env.TRIAGE_CONCURRENCY ?? 4),
	inboxDays: Number(process.env.TRIAGE_INBOX_DAYS ?? 2),
});
// 顶层 await：Harness 打开完成（含恢复未完成任务）后才开始监听。
await triage.open();

// token 首次随机生成（24 字节 → 48 个十六进制字符），文件权限 0600；之后复用同一文件。
const tokenPath = join(dataDir, "token");
if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(24).toString("hex"), { mode: 0o600 });
const token = readFileSync(tokenPath, "utf8").trim();

// 同步状态暴露给 /api/state，供 UI 显示进行中/上次时间/错误/条数。
const sync = { running: false, lastSync: "", lastError: "", lastCount: 0 };
// 串行化同步：正在运行时再次调用直接返回，避免并发 gh 与重复入队。
async function runSync(): Promise<void> {
	if (sync.running) return;
	sync.running = true;
	try {
		sync.lastCount = await corpus.sync();
		sync.lastSync = new Date().toISOString();
		sync.lastError = "";
		// 同步完成后把收件箱中新/变更的 issue 放入分诊队列。
		await triage.enqueueInbox();
	} catch (error) {
		// 同步失败不崩溃服务：记录状态并打印，等待下一次定时重试。
		sync.lastError = error instanceof Error ? error.message : String(error);
		console.error("sync:", error);
	} finally {
		sync.running = false;
	}
}

// 汇总 UI 所需的完整状态：收件箱 issue 列表 + 每条的分诊结果/决策 + 队列/费用等运行时信息。
async function view() {
	const state = await triage.state();
	const items = corpus
		.all()
		.filter((issue) => inInbox(issue, state.inboxSince))
		// 编号降序：新 issue 在前。
		.sort((a, b) => b.number - a.number)
		.map((issue) => {
			const entry = state.issues[issue.number];
			// 结果中的 duplicate 只存编号；这里补上当前标题与状态，UI 才能直接展示。
			const result = entry?.result
				? {
						...entry.result,
						duplicates: entry.result.duplicates.map((dup) => {
							const other = corpus.get(dup.number);
							return { ...dup, title: other?.title ?? "", status: other ? issueStatus(other) : "" };
						}),
					}
				: null;
			return {
				number: issue.number,
				title: issue.title,
				author: issue.author,
				association: issue.association,
				status: issueStatus(issue),
				createdAt: issue.createdAt,
				// 正文截断到 4000 字符，避免状态响应过大；完整正文仍在语料中。
				body: issue.body.slice(0, 4000),
				authorStats: corpus.authorStats(issue),
				triage: entry ? { status: entry.status, error: entry.error, result } : null,
				decision: entry?.decision ?? null,
			};
		});
	return {
		repo: REPO,
		model: `${provider}/${modelId}`,
		inboxSince: state.inboxSince,
		// 只暴露 name/owner，不把完整分类实现发给前端。
		categories: triage.categories.map(({ name, owner }) => ({ name, owner })),
		sync,
		queue: triage.queueSize(),
		cost: await triage.usageCost(),
		items,
	};
}

// 输入：请求。输出：cookie 中的 triage token 是否等于服务 token。
// timingSafeEqual 需要等长输入，因此先比较长度；regex 只接受十六进制字符。
function authorized(req: IncomingMessage): boolean {
	const cookie = /(?:^|;\s*)triage=([0-9a-f]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
	return cookie.length === token.length && timingSafeEqual(Buffer.from(cookie), Buffer.from(token));
}

// 读取并解析请求体 JSON；空体按 {} 处理。请求体是外部输入，这里只做 JSON 解析，字段在路由中校验。
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

// 统一响应：JSON 默认类型；禁用缓存，避免浏览器缓存状态/页面。
function send(res: ServerResponse, status: number, body: string, type = "application/json"): void {
	res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
	res.end(body);
}

// 路由入口：先处理 token 链接（302 设置 cookie），再校验 cookie，然后分发 GET/POST。
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");
	// ?t=<token> 是首次访问的引导链接；成功后写一年期 cookie 并重定向到无参数首页。
	if (url.searchParams.get("t") === token) {
		res.writeHead(302, {
			"set-cookie": `triage=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`,
			location: "/",
		});
		res.end();
		return;
	}
	// 未认证统一 401 文本，提示用带 token 的链接打开。
	if (!authorized(req)) return send(res, 401, "Open the link with ?t=<token> once.", "text/plain");

	if (req.method === "GET" && url.pathname === "/") {
		return send(res, 200, readFileSync(join(scriptDir, "ui.html"), "utf8"), "text/html; charset=utf-8");
	}
	if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, JSON.stringify(await view()));
	if (req.method === "GET" && url.pathname === "/api/conversation") {
		// number 缺失/非数字会得到 NaN，transcript 查不到时返回 404。
		const items = await triage.transcript(Number(url.searchParams.get("number")));
		return items ? send(res, 200, JSON.stringify({ items })) : send(res, 404, '{"error":"no conversation"}');
	}
	if (req.method === "POST" && url.pathname === "/api/sync") {
		// 202 表示已接受但未完成；void 让同步在后台进行，不阻塞响应。
		void runSync();
		return send(res, 202, "{}");
	}
	if (req.method === "POST" && url.pathname === "/api/retriage") {
		const { number } = await readJson(req);
		await triage.retriage(Number(number));
		return send(res, 200, "{}");
	}
	if (req.method === "POST" && url.pathname === "/api/decide") {
		const body = await readJson(req);
		// 字段来自 JSON，运行时校验；null/undefined 允许（表示不设置该维度）。
		const priority = body.priority as Priority | null | undefined;
		const category = body.category as string | null | undefined;
		if (priority != null && !PRIORITIES.includes(priority)) return send(res, 400, '{"error":"bad priority"}');
		if (category != null && !triage.categories.some((c) => c.name === category)) {
			return send(res, 400, '{"error":"bad category"}');
		}
		// 支持单个 number 或 numbers 数组；数组元素统一转数字。
		const numbers = Array.isArray(body.numbers) ? body.numbers.map(Number) : [Number(body.number)];
		for (const number of numbers) await triage.decide(number, { priority, category });
		return send(res, 200, "{}");
	}
	send(res, 404, '{"error":"not found"}');
}

// 所有 handler 异常集中到 500；headers 已发送时不再写状态行，只记录日志。
const server = createServer((req, res) => {
	handle(req, res).catch((error: unknown) => {
		console.error(error);
		if (!res.headersSent) send(res, 500, JSON.stringify({ error: String(error) }));
	});
});
// 优先 Unix socket：适合本机/SSH 转发且不占 TCP 端口；启动后收紧权限到 0660。
const socket = process.env.TRIAGE_SOCKET;
if (socket) {
	// 上次进程异常退出可能留下 socket 文件；先删除再监听。
	if (existsSync(socket)) unlinkSync(socket);
	server.listen(socket, () => chmodSync(socket, 0o660));
	console.log(`listening on ${socket}, token in ${tokenPath}`);
} else {
	const port = Number(process.env.TRIAGE_PORT ?? 7788);
	// 只绑定回环地址，避免把带 token 的 UI 暴露到局域网。
	server.listen(port, "127.0.0.1");
	console.log(`http://127.0.0.1:${port}/?t=<token from ${tokenPath}>`);
}

// 启动即同步一次，随后按 TRIAGE_SYNC_MINUTES 定时同步。
void runSync();
setInterval(() => void runSync(), syncMinutes * 60_000);

// 收到退出信号：停止接收新请求，关闭 Triage（flush 持久化）后以 0 退出。
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		server.close();
		void triage.close().finally(() => process.exit(0));
	});
}
