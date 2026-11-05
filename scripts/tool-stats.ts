#!/usr/bin/env node

// 文件导读：生成一个本地 HTML 仪表盘，展示各工具调用的结果 token 估算、调用次数与直方图。
// 所属：仓库根 `scripts/` 的会话分析脚本系列；输出是可直接在浏览器查看的单文件页面。
// 作用：递归扫描会话 JSONL，把 assistant 的 toolCall 与 toolResult 配对，按工具名统计调用数、
//   结果数、结果文本估算 token 与错误数；对 bash 再按命令首词聚合。最后把数据嵌入 HTML 并打开浏览器。
// 上游：手动运行 `node scripts/tool-stats.ts [--sessions-dir <dir>] [--output <file.html>]`；
//   默认扫描 `~/.pi/agent/sessions`，默认输出 `<tmp>/pi-tool-stats.html`。
// 下游：读取会话 JSONL；`openBrowser` 来自 coding-agent，会调用系统默认浏览器打开文件。
//   生成的 HTML 依赖 CDN 上的 Tailwind 与 Chart.js（需要联网才能完整渲染图表）。
// 输出与错误：成功打印 `Wrote <path>` 并尝试打开浏览器；目录不存在时抛错并以 1 退出；--help exit(0)。
//   单行 JSON 解析失败计入 parseErrors，不中断。输出文件的父目录会自动创建，同名文件会被覆盖。
// 能力清单：
//   - parseArgs/jsonlFiles：CLI 与文件枚举。
//   - getStats/createToolStats/createBashStats：按 key 惰性创建聚合对象。
//   - estimateTokenCount/contentText：粗估结果 token 与提取文本。
//   - commandKey：把 bash 命令归一成“命令 + 子命令”。
//   - bucketCounts/bucketLabels：生成 0 到 32000+ 的 token 直方图。
//   - 顶层扫描与 HTML 生成：配对 toolCall/toolResult，嵌入数据并写文件。
// 典型调用与预期：
//   示例 `node scripts/tool-stats.ts -o /tmp/tool-stats.html`；打印 Wrote，随后浏览器打开该文件。
// 阅读顺序：先看类型与 BUCKETS，再看扫描/配对逻辑，最后看 HTML 模板之前的数据整理（模板本身是静态页面）。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openBrowser } from "../packages/coding-agent/src/utils/open-browser.ts";

// 消息内容块的几种形状；这些 interface/type 只在编译期存在，运行时靠字段判断。
interface TextContent { type: "text"; text: string }
interface ImageContent { type: "image"; data: string; mimeType?: string }
interface ToolCallContent { type: "toolCall"; id: string; name: string; arguments?: Record<string, unknown> }
// 联合类型再加一个宽松分支，兼容未来/旧格式的块；运行时只访问已判断存在的字段。
type Content = TextContent | ImageContent | ToolCallContent | { type: string; [key: string]: unknown };
// 一条消息：toolResult 会带 toolCallId/toolName，assistant 消息的 content 里是 toolCall 块。
interface Message { role?: string; content?: string | Content[]; toolCallId?: string; toolName?: string; details?: unknown }
// 会话条目外层；只声明统计需要的字段。
interface Entry { type?: string; message?: Message }
// 单个工具的累计统计；samples 保存每次结果 token，用于直方图。
interface ToolStats { calls: number; results: number; estimatedTokens: number; samples: number[]; errors: number }
interface BashCommandStats { calls: number; estimatedTokens: number; samples: number[] }
// 从 toolCall 保存的配对信息：结果回来时可回查它属于哪个 bash 命令。
interface ToolCallInfo { toolName: string; bashCommand?: string }

// 直方图分桶上界；相邻两项构成一个桶，最后一项 Infinity 表示“32000+”。
const BUCKETS = [0, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, Number.POSITIVE_INFINITY];

// 解析 CLI，返回 sessionsDir 与输出文件路径（均为绝对路径）。
// 未知参数被忽略；带值选项只在下一个参数存在时生效；--help 打印后 exit(0)。
function parseArgs(): { sessionsDir: string; output: string } {
	// 默认值：全部项目会话 + 系统临时目录下的 HTML 文件。
	let sessionsDir = join(homedir(), ".pi", "agent", "sessions");
	let output = join(tmpdir(), "pi-tool-stats.html");
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--sessions-dir" && args[i + 1]) sessionsDir = resolve(args[++i]);
		else if ((arg === "--output" || arg === "-o") && args[i + 1]) output = resolve(args[++i]);
		else if (arg === "--help" || arg === "-h") {
			console.log(`Usage: scripts/tool-stats.ts [--sessions-dir <dir>] [--output <file.html>]`);
			process.exit(0);
		}
	}
	return { sessionsDir, output };
}

// 递归枚举目录下所有 .jsonl，返回路径数组；目录不可读时抛错。
// 与 read-tool-stats 的生成器不同，这里先收集成数组，便于报告总文件数。
function jsonlFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...jsonlFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
	}
	return out;
}

// 泛型 helper：map 中已有 key 就返回，否则用 create 创建并写入。
// 返回的是可变对象引用，调用方直接递增字段；T 由调用处推断。
function getStats<T>(map: Map<string, T>, key: string, create: () => T): T {
	let stats = map.get(key);
	if (!stats) {
		stats = create();
		map.set(key, stats);
	}
	return stats;
}

// 新建一个工具统计对象；samples 每次结果追加一个估算 token 数。
function createToolStats(): ToolStats {
	return { calls: 0, results: 0, estimatedTokens: 0, samples: [], errors: 0 };
}

// 新建一个 bash 命令统计对象；只有结果回来后才累加 token。
function createBashStats(): BashCommandStats {
	return { calls: 0, estimatedTokens: 0, samples: [] };
}

// 粗略估算 token：按 4 字符约 1 token 向上取整；不是真实分词，仅用于相对比较。
function estimateTokenCount(text: string): number {
	return Math.ceil(text.length / 4);
}

// 把 toolResult 的 content 转成可估算长度的文本：
// 字符串原样返回；数组逐块取 text 或图片 data；其他块 JSON.stringify 兜底。
// 图片块取其 base64 的 data 字段，长度反映结果体积。
function contentText(content: Message["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	// 映射链整体在下一行完成，注释只放在链外。
	return content.map((block) => {
		if (block.type === "text" && "text" in block && typeof block.text === "string") return block.text;
		if (block.type === "image" && "data" in block && typeof block.data === "string") return block.data;
		return JSON.stringify(block);
	}).join("\n");
}

// 从 toolCall 的 arguments 中取 bash 命令；不是字符串或缺失时返回 undefined。
function getBashCommand(args: Record<string, unknown> | undefined): string | undefined {
	const command = args?.command;
	return typeof command === "string" ? command : undefined;
}

// 把一条 bash 命令归一成统计键：取第一段（按换行、&&、||、;、| 切分），
// 去掉前置 VAR=value 与 sudo，保留可执行文件名与第一个非选项子命令。
// 例：`FOO=1 sudo git commit -m x` → `"git commit"`；`ls -la` → `"ls"`。
function commandKey(command: string): string {
	// [0] 可能为 undefined（空命令）；?? 回退到整串 trim。
	const first = command.split(/\n|&&|\|\||;|\|/)[0]?.trim() ?? command.trim();
	// 正则吃掉环境变量赋值与 sudo，再捕获命令与可选子命令。
	const match = first.match(/^(?:\w+=\S+\s+)*(?:sudo\s+)?([^\s]+)(?:\s+([^\s]+))?/);
	if (!match) return "unknown";
	const bin = match[1] ?? "unknown";
	// 以 - 开头的第二段是选项（如 -la），不并入键，避免把每个选项组合拆成新命令。
	const sub = match[2] && !match[2].startsWith("-") ? ` ${match[2]}` : "";
	return `${bin}${sub}`;
}

// 把样本值放进 BUCKETS 定义的区间，返回与桶数等长的计数数组。
// findIndex 找第一个“sample <= 上界”的桶；结果减 1 转成从 0 开始的桶下标，再夹到合法范围。
function bucketCounts(samples: number[]): number[] {
	const counts = new Array(BUCKETS.length - 1).fill(0) as number[];
	for (const sample of samples) {
		const index = BUCKETS.findIndex((max, i) => i > 0 && sample <= max) - 1;
		counts[Math.max(0, index)]++;
	}
	return counts;
}

// 生成与 bucketCounts 对应的标签，如 "0-50" ... "32000+"；最后一个桶上界为 Infinity 时用 +。
function bucketLabels(): string[] {
	return BUCKETS.slice(0, -1).map((min, i) => {
		const max = BUCKETS[i + 1];
		return Number.isFinite(max) ? `${min}-${max}` : `${min}+`;
	});
}

// 以下是顶层执行流程：先解析参数并校验目录，再扫描所有文件、生成数据、写 HTML、打开浏览器。
const { sessionsDir, output } = parseArgs();
if (!existsSync(sessionsDir)) throw new Error(`Sessions directory not found: ${sessionsDir}`);

// tools 按工具名聚合；bashCommands 按归一化命令聚合；callsById 用于把结果配回调用。
const tools = new Map<string, ToolStats>();
const bashCommands = new Map<string, BashCommandStats>();
const callsById = new Map<string, ToolCallInfo>();
let parseErrors = 0;
const files = jsonlFiles(sessionsDir);

for (const file of files) {
	// 整个文件读入后按行处理；不需要流式，因为后续还要为每个文件保持解析器局部状态。
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry: Entry;
		try { entry = JSON.parse(line) as Entry; } catch { parseErrors++; continue; }
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message) continue;
		// assistant 消息里的 toolCall：增加调用计数，并记录 id → 工具/命令 的映射。
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type !== "toolCall" || !("name" in block) || typeof block.name !== "string") continue;
				const stats = getStats(tools, block.name, createToolStats);
				stats.calls++;
				// 只有 bash 需要额外解析 command，用于按命令聚合。
				const bashCommand = block.name === "bash" ? getBashCommand(block.arguments) : undefined;
				callsById.set(block.id, { toolName: block.name, bashCommand });
				if (bashCommand) getStats(bashCommands, commandKey(bashCommand), createBashStats).calls++;
			}
		} else if (message.role === "toolResult" && message.toolName) {
			// 工具结果：估算文本 token，累加到对应工具；若结果对应 bash 调用，再累加到命令统计。
			const text = contentText(message.content);
			const tokens = estimateTokenCount(text);
			const stats = getStats(tools, message.toolName, createToolStats);
			stats.results++;
			stats.estimatedTokens += tokens;
			stats.samples.push(tokens);
			// isError 不是 Message 声明的字段，因此用 in 做运行时检查再比较。
			if ("isError" in message && message.isError === true) stats.errors++;
			const call = message.toolCallId ? callsById.get(message.toolCallId) : undefined;
			if (call?.bashCommand) {
				const bash = getStats(bashCommands, commandKey(call.bashCommand), createBashStats);
				bash.estimatedTokens += tokens;
				bash.samples.push(tokens);
			}
		}
	}
}

// 整理为可序列化行：计算平均 token 与直方图，按估算 token 降序；bash 只保留前 50 个命令。
const toolRows = [...tools.entries()].map(([name, s]) => ({ name, ...s, avg: s.results ? s.estimatedTokens / s.results : 0, histogram: bucketCounts(s.samples) })).sort((a, b) => b.estimatedTokens - a.estimatedTokens);
const bashRows = [...bashCommands.entries()].map(([name, s]) => ({ name, ...s, avg: s.samples.length ? s.estimatedTokens / s.samples.length : 0, histogram: bucketCounts(s.samples) })).sort((a, b) => b.estimatedTokens - a.estimatedTokens).slice(0, 50);
// data 会被 JSON.stringify 后嵌入页面；generatedAt 使用 UTC ISO 时间。
const data = { generatedAt: new Date().toISOString(), sessionsDir, files: files.length, parseErrors, bucketLabels: bucketLabels(), tools: toolRows, bashCommands: bashRows };

// 下面是一段完整 HTML 模板字符串：静态页面结构 + 内嵌数据 + 浏览器端 Chart.js 绘图脚本。
// 不要把注释写进模板内容，否则会原样出现在生成的 HTML/JS 中。
const html = `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<title>Pi Tool Stats</title>
	<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
	<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.9/dist/chart.umd.min.js"></script>
</head>
<body class="bg-zinc-950 text-zinc-100 p-6">
	<main class="max-w-7xl mx-auto space-y-6">
		<h1 class="text-3xl font-bold">Pi Tool Stats</h1>
		<p class="text-zinc-400">${data.files} session files from <code>${sessionsDir}</code>. Generated ${data.generatedAt}.</p>
		<section class="grid md:grid-cols-2 gap-6">
			<div class="bg-zinc-900 rounded p-4"><h2 class="font-semibold mb-3">Estimated result tokens by tool</h2><canvas id="tokens"></canvas></div>
			<div class="bg-zinc-900 rounded p-4"><h2 class="font-semibold mb-3">Tool calls</h2><canvas id="calls"></canvas></div>
		</section>
		<section class="grid md:grid-cols-2 gap-6">
			<div class="bg-zinc-900 rounded p-4">
				<div class="flex items-center justify-between gap-4 mb-3">
					<h2 class="font-semibold">Tool result token histogram</h2>
					<select id="toolSelect" class="bg-zinc-800 rounded px-2 py-1 text-sm"></select>
				</div>
				<p id="toolSummary" class="text-sm text-zinc-400 mb-3"></p>
				<canvas id="toolHistogram" height="120"></canvas>
			</div>
			<div class="bg-zinc-900 rounded p-4">
				<div class="flex items-center justify-between gap-4 mb-3">
					<h2 class="font-semibold">Bash result token histogram</h2>
					<select id="bashSelect" class="bg-zinc-800 rounded px-2 py-1 text-sm"></select>
				</div>
				<p id="bashSummary" class="text-sm text-zinc-400 mb-3"></p>
				<canvas id="bashHistogram" height="120"></canvas>
			</div>
		</section>
		<section class="bg-zinc-900 rounded p-4"><h2 class="font-semibold mb-3">Tools</h2><div id="tools"></div></section>
		<section class="bg-zinc-900 rounded p-4">
			<h2 class="font-semibold mb-3">Bash common commands (best effort)</h2>
			<div id="bash" class="mt-4"></div>
		</section>
	</main>
	<script>
		const data=${JSON.stringify(data)};
		function fmt(n){return Math.round(n).toLocaleString()}
		function esc(s){return String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
		function table(rows,el){
			document.getElementById(el).innerHTML='<table class="w-full text-sm"><thead class="text-zinc-400"><tr><th class="text-left p-2">Name</th><th class="text-right p-2">Calls</th><th class="text-right p-2">Results</th><th class="text-right p-2">Est. tokens</th><th class="text-right p-2">Avg/result</th><th class="text-left p-2 w-64">Histogram</th></tr></thead><tbody>'+rows.map((r,i)=>'<tr class="border-t border-zinc-800 hover:bg-zinc-800/50 cursor-pointer" data-row="'+i+'"><td class="p-2 font-mono">'+esc(r.name)+'</td><td class="p-2 text-right">'+fmt(r.calls)+'</td><td class="p-2 text-right">'+fmt(r.results??r.samples.length)+'</td><td class="p-2 text-right">'+fmt(r.estimatedTokens)+'</td><td class="p-2 text-right">'+fmt(r.avg)+'</td><td class="p-2"><canvas id="'+el+'Hist'+i+'" height="34"></canvas></td></tr>').join('')+'</tbody></table>';
			rows.forEach((r,i)=>new Chart(document.getElementById(el+'Hist'+i),{type:'bar',data:{labels:data.bucketLabels,datasets:[{data:r.histogram,label:r.name,backgroundColor:'#60a5fa'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{title:(items)=>data.bucketLabels[items[0].dataIndex]+' tokens'}}},scales:{x:{display:false},y:{display:false}}}}));
			document.querySelectorAll('#'+el+' tr[data-row]').forEach(row=>row.addEventListener('click',()=>document.getElementById(el==='tools'?'toolSelect':'bashSelect').value=row.dataset.row,document.getElementById(el==='tools'?'toolSelect':'bashSelect').dispatchEvent(new Event('change'))));
		}
		function fillSelect(id,rows){document.getElementById(id).innerHTML=rows.map((r,i)=>'<option value="'+i+'">'+esc(r.name)+'</option>').join('')}
		function summary(r){return fmt(r.calls)+' calls, '+fmt(r.results??r.samples.length)+' results, '+fmt(r.estimatedTokens)+' estimated result tokens, '+fmt(r.avg)+' avg/result'}
		function singleHistogram(canvasId,summaryId,selectId,rows){
			let chart;
			function update(){
				const row=rows[Number(document.getElementById(selectId).value)]??rows[0];
				document.getElementById(summaryId).textContent=row?summary(row):'No data';
				if(chart)chart.destroy();
				chart=new Chart(document.getElementById(canvasId),{type:'bar',data:{labels:data.bucketLabels,datasets:[{label:row?.name??'',data:row?.histogram??[],backgroundColor:'#60a5fa'}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{title:(items)=>data.bucketLabels[items[0].dataIndex]+' tokens',label:(item)=>fmt(item.raw)+' results'}}},scales:{y:{beginAtZero:true,title:{display:true,text:'result count'}},x:{title:{display:true,text:'estimated tokens/result'}}}}});
			}
			document.getElementById(selectId).addEventListener('change',update);
			update();
		}
		table(data.tools,'tools');
		table(data.bashCommands,'bash');
		fillSelect('toolSelect',data.tools);
		fillSelect('bashSelect',data.bashCommands);
		singleHistogram('toolHistogram','toolSummary','toolSelect',data.tools);
		singleHistogram('bashHistogram','bashSummary','bashSelect',data.bashCommands);
		new Chart(document.getElementById('tokens'),{type:'bar',data:{labels:data.tools.map(r=>r.name),datasets:[{label:'estimated tokens',data:data.tools.map(r=>r.estimatedTokens)}]},options:{plugins:{legend:{display:false}}}});
		new Chart(document.getElementById('calls'),{type:'bar',data:{labels:data.tools.map(r=>r.name),datasets:[{label:'calls',data:data.tools.map(r=>r.calls)}]},options:{plugins:{legend:{display:false}}}});
	</script>
</body>
</html>`;

// 确保输出文件的父目录存在（recursive 对已存在目录不报错），然后覆盖写入 HTML。
mkdirSync(resolve(output, ".."), { recursive: true });
writeFileSync(output, html);
console.log(`Wrote ${output}`);
// 副作用：调用系统默认浏览器打开生成的本地文件；无图形环境时由 openBrowser 自行处理失败。
openBrowser(output);
