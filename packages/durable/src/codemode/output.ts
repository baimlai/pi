// 所属：packages/durable/src/codemode，把一次代码模式脚本的 CodemodeResult 排版成模型可读的工具结果。
// 作用：拼接 “Script completed/failed + wall time” 头部，区分文本项、console 输出、返回值与错误；按 token
// 预算截断（保留开头和结尾，完整文本写入临时文件）；并把脚本输出的图片保存成临时文件，在图片前标注路径。
// 职责边界：只负责格式化与写临时文件；不执行脚本、不判断业务成败、不持久化 journal（由 codemode.ts 负责）。
// 上游：codemode.ts 的 CodemodeCall.complete 调用 formatResult，并传入 OUTPUT_LIMITS 与 outputFiles()。
// 下游：pi-ai 的 TextContent/ImageContent、pi-codemode/portable 的 CodemodeOutputItem/CodemodeResult。
// 能力清单（导出项）：
// - OutputFile：写结果文件的回调类型（固定文件名 → 路径或错误）。
// - DEFAULT_MAX_OUTPUT_TOKENS：默认 10000 token 预算。
// - formatResult(result, options)：返回 content 与（截断时）fullOutputPath。
// 内部流程：formatItems（打标签/收拢 console）→ 失败时追加 Script error → joinAdjacentText →
// truncate（超预算时首尾保留并写 output.txt）→ saveImages（图片写临时文件）→ 加头部。
// 示例：const { content, fullOutputPath } = await formatResult(result, {
//   generatedImages: 0, wallMs: 1200, maxOutputTokens: 10000, calls: [],
//   limits: { maxBytes: 4 * 1024 * 1024, maxLines: 100_000 }, write: outputFiles() });
// 建议阅读顺序：先 Item/OutputFile/Limits 与常量，再 valueText/formatItems/joinAdjacentText，然后 truncate、
// saveImages、formatError，最后读 formatResult 的组装顺序。
/**
 * A script's result as the model reads it, copied from the coding agent's code mode: a "Script completed/failed"
 * header with the wall time, the script's text items (`==> text N/M <==` when there are several), its `console` lines
 * in one `<console_output>` block, the returned value, and on failure the error with the calls already made. Text past
 * the token budget is cut to its start and end, with the complete text in a temp file; images are saved to temp files
 * too, with their path next to them, because a script has no other way to hand their bytes on.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { CodemodeOutputItem, CodemodeResult } from "@earendil-works/pi-codemode/portable";

// 工具结果内容块：文本或图片；两者都来自 pi-ai 的 content 类型。
type Item = TextContent | ImageContent;

/** Writes a file of the result under a fixed name; its path, or why it could not be written. */
// 写结果文件的回调：name 是固定文件名（output.txt、image-1.png），data 是字符串或字节；
// 成功返回 { path }，失败返回 { error }。实现由 codemode.ts 注入（沙箱环境可能不存在）。
export type OutputFile = (name: string, data: string | Uint8Array) => Promise<{ path: string } | { error: string }>;

/** The tool's output limits, which the Harness enforces by cutting without a spill file: results stay inside them. */
// 工具输出上限；Harness 只会硬截断而不写 spill 文件，因此本模块必须自己保证结果落在限制内。
type Limits = { readonly maxBytes: number; readonly maxLines: number };
/** Lines of the result besides the script's text: the header, markers, notes. */
// 为头部、标记和提示预留的行数，计算文本可用的行预算时从 maxLines 中扣除。
const LINE_MARGIN = 100;

/** Default token budget for script output. */
// 脚本输出默认 token 预算；可由脚本首行 // @options 的 max_output_tokens 覆盖。
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
/** Characters per token when estimating. */
// 粗略估算：4 个字符≈1 token；不调用 tokenizer，只用于截断阈值与提示。
const CHARS_PER_TOKEN = 4;

/** File extensions of the image types `image()` accepts. */
// image() 接受的内联图片类型到临时文件扩展名的映射；未知类型回退为 .bin。
const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

/** Like the script's `text()`: strings as is, other values as compact JSON. */
// 把脚本 return 的值转成文本：字符串原样，其他值用紧凑 JSON；JSON.stringify 返回 undefined 时退回 String。
function valueText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? String(value);
}

/**
 * Lay out the script's output so the model can tell items apart: with more than one text item, each starts with a
 * `==> text N/M <==` line; `console` lines follow all other output in one `<console_output>` block.
 */
// 把脚本输出项排版成工具内容块：图片原样保留；console 行先收集，
// 普通文本在多条时加 “==> text N/M <==” 前缀；最后把 console 行合成一个 <console_output> 块。
// 纯函数：不修改 output 数组，也不写文件。例两条文本加一行 console：
//   [{type:"text",text:"a"},{type:"text",text:"b"},{type:"text",console:true,text:"c"}]
//   → 带编号的两条文本 + 一个 <console_output> 文本块。
function formatItems(output: readonly CodemodeOutputItem[]): Item[] {
	// 只统计非 console 的文本项，作为编号总数；图片和 console 不参与编号。
	const total = output.filter((item) => item.type === "text" && !item.console).length;
	const items: Item[] = [];
	// console 文本按出现顺序暂存，最后统一包进一个块。
	const consoleLines: string[] = [];
	// index 只对普通文本递增，因此编号连续且与 console/图片无关。
	let index = 0;
	for (const item of output) {
		if (item.type === "image") items.push(item);
		else if (item.console) consoleLines.push(item.text);
		else {
			index++;
			// 只有一条普通文本时不加编号前缀，减少噪声；多条时 N/M 帮助模型定位。
			items.push({ type: "text", text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text });
		}
	}
	// console 输出必须排在所有其他输出之后，避免打断脚本正文。
	if (consoleLines.length > 0) {
		items.push({ type: "text", text: `<console_output>\n${consoleLines.join("\n")}\n</console_output>` });
	}
	return items;
}

/**
 * Join adjacent text items into one, each part starting on its own line. The separator check looks at the last
 * non-empty part, not the joined text: reading the end of a growing concatenation makes V8 copy it on every item, which
 * is quadratic.
 */
// 合并相邻文本块，每部分独占一行；图片块会切断合并（保持图片与其前后文本的顺序）。
// 关键实现：用 lastPart 记录最后一段非空文本的结尾，而不是反复检查已拼接字符串的末尾，
// 避免 V8 在每次追加时复制整个字符串（二次复杂度）。空文本不更新 lastPart。
// 例 ["a","b"] → "a\nb"；["a\n","b"] → "a\nb"（已有换行不重复添加）。
function joinAdjacentText(items: readonly Item[]): Item[] {
	const joined: Item[] = [];
	// parts 暂存当前连续文本段，flush 时一次 join 成一个块。
	let parts: string[] = [];
	// 最后一段非空文本，用于判断是否需要在下一段前补换行。
	let lastPart = "";
	// 结束当前文本段：有内容就推入 joined，并重置状态。
	const flush = () => {
		if (parts.length > 0) joined.push({ type: "text", text: parts.join("") });
		parts = [];
		lastPart = "";
	};
	for (const item of items) {
		if (item.type !== "text") {
			// 图片打断文本流：先提交已有文本，再原样加入图片。
			flush();
			joined.push(item);
			continue;
		}
		// 上一段非空且不以换行结束，就补一个换行，保证每部分从新行开始。
		if (lastPart !== "" && !lastPart.endsWith("\n")) {
			parts.push("\n");
			lastPart = "\n";
		}
		parts.push(item.text);
		// 只有非空文本才成为“最后一段”，空文本不改变换行判断。
		if (item.text !== "") lastPart = item.text;
	}
	// 收尾：推入最后一段文本。
	flush();
	return joined;
}

/**
 * Apply the token budget: when the combined text exceeds it, the text items become one item that keeps the start and
 * end of the text, and images follow it. The complete text is written to a temp file.
 */
// 按 token 预算截断文本：未超预算且行数足够时原样返回；超预算时把所有文本合并成一个
// “开头 + 截断提示 + 结尾” 的块，图片移到该块之后，并把完整文本写入 output.txt。
// 本次写入失败不会丢结果：错误信息写进提示，仍返回截断后的内容。
// 例 maxTokens=10000 时 budget=40000 字符，头尾各约一半；行数也受 limits.maxLines 限制。
async function truncate(
	items: readonly Item[],
	maxTokens: number,
	limits: Limits,
	write: OutputFile,
): Promise<{ items: Item[]; fullOutputPath?: string }> {
	// 只拼接文本块；图片不参与 token 估算。
	const texts = items.filter((item): item is TextContent => item.type === "text").map((item) => item.text);
	// 以换行连接，和最终展示的文本结构一致。
	const combined = texts.join("\n");
	// Within the limits too: a UTF-16 unit is at most 3 UTF-8 bytes, and the rest of the result is a few short lines.
	// 同时满足字节上限：一个 UTF-16 单元最多 3 个 UTF-8 字节，除以 4 留出余量给头部与提示行。
	const budget = Math.min(maxTokens * CHARS_PER_TOKEN, Math.floor(limits.maxBytes / 4));
	// 头尾各分一半行预算，并扣除固定行（头部、提示等），因此除以 2。
	const lineBudget = Math.floor((limits.maxLines - LINE_MARGIN) / 2);
	const lines = combined.split("\n").length;
	// 没有文本，或字符数与行数都未超限：原样返回（复制数组，调用方可安全使用）。
	if (texts.length === 0 || (combined.length <= budget && lines <= 2 * lineBudget)) return { items: [...items] };
	// 字符预算对半分给开头和结尾；tailChars 为 0 时不保留结尾。
	const headChars = Math.floor(budget / 2);
	const tailChars = budget - headChars;
	// 先按字符切，再按行切，避免输出半行；tail 从末尾切并保留最后 lineBudget 行。
	const head = combined.slice(0, headChars).split("\n").slice(0, lineBudget).join("\n");
	const tail = tailChars > 0 ? combined.slice(-tailChars).split("\n").slice(-lineBudget).join("\n") : "";
	// removed 只用于提示被省略的规模；head/tail 可能因按行切而重复少量字符，这里按长度估算。
	const removed = combined.length - head.length - tail.length;
	let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split("\n").length}\n\n${head}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}`;
	// 完整文本写临时文件，模型可用 read 的 offset/limit 继续查看。
	const spilled = await write("output.txt", combined);
	text +=
		"path" in spilled
			? `\n\n[Full output: ${spilled.path} (read with offset/limit)]`
			: `\n\n[Could not save the full output: ${spilled.error}]`;
	// 截断后文本变成单块，图片按原顺序跟在后面；只有成功落盘才返回路径。
	return {
		items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
		...("path" in spilled ? { fullOutputPath: spilled.path } : {}),
	};
}

/** Save each image to a file and put a text item with its path before it; an image shown twice is saved once. */
// 把每个图片块保存成临时文件，并在图片前插入一个说明路径的文本块；相同 data 的图片只写一次。
// 写失败不中断结果，而是把错误放进说明文本。返回新数组，不修改输入；保存是并发的。
async function saveImages(items: readonly Item[], write: OutputFile): Promise<Item[]> {
	// data（base64）→ 写入 Promise；相同图片复用同一个 Promise，避免重复落盘。
	const labels = new Map<string, Promise<string>>();
	// 写一个图片并生成说明文字；index 只用于文件名。
	const label = async ({ data, mimeType }: ImageContent, index: number): Promise<string> => {
		// atob 得到二进制字符串，再逐字符转回字节；图片不是 UTF-8 文本，不能直接 TextEncoder。
		const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
		const kind = `${mimeType}, ${bytes.length} bytes`;
		// A failed write must not discard the result of a script whose calls already ran: it becomes part of the label.
		// 写失败也必须保留脚本结果，因此错误只进入说明文本，不向上抛。
		const saved = await write(`image-${index}${IMAGE_EXTENSIONS[mimeType] ?? ".bin"}`, bytes);
		return "path" in saved
			? `[Image saved to ${saved.path} (${kind})]`
			: `[Image (${kind}) could not be saved: ${saved.error}]`;
	};
	// 并发处理所有项；每个图片替换成 [说明文本, 图片块]，其他项保持原样。[...] 让 flat 得到一层展开。
	const result = await Promise.all(
		items.map(async (item): Promise<Item[]> => {
			if (item.type !== "image") return [item];
			// 同一 base64 图片复用已有写入；labels.size + 1 是新的图片序号。
			let pending = labels.get(item.data);
			if (pending === undefined) {
				pending = label(item, labels.size + 1);
				labels.set(item.data, pending);
			}
			return [{ type: "text", text: await pending }, item];
		}),
	);
	return result.flat();
}

// 把失败结果排版成错误文本：按 kind 选择脚本栈/超时/中止/沙箱故障的标题，再列出失败前已完成的工具调用。
// Extract<CodemodeResult, { ok: false }> 是 TypeScript 工具类型，从联合类型中取出失败分支，不产生运行时逻辑。
// 不会撤销已发生的工具调用：提示明确说明 “they are not undone”。例超时会显示 “Script timed out: ...”。
function formatError(
	result: Extract<CodemodeResult, { ok: false }>,
	calls: readonly { name: string; status: string }[],
) {
	const { error } = result;
	// 嵌套三元按 error.kind 分派；script 类型优先展示 stack，没有 stack 时退回 name/message。
	const head =
		error.kind === "script"
			? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
			: error.kind === "timeout"
				? `Script timed out: ${error.message}`
				: error.kind === "aborted"
					? `Script aborted: ${error.message}`
					: `Script sandbox failed: ${error.message}`;
	// 汇总失败前的调用名与状态；map/join 只生成文本，不改动调用记录。
	const summary =
		calls.length === 0
			? "No tool calls were made."
			: `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
	return `${head}\n\n${summary}`;
}

/** The tool result's content for a script's result, and the path of the complete text when it was cut. */
// 生成最终工具结果：追加脚本返回值（如有）、失败错误、未展示图片的提示，再依次做合并、截断和图片保存，
// 最后加 “Script completed/failed + 墙钟时间” 头部。返回值中 fullOutputPath 只在文本被截断且成功落盘时存在。
// 不修改 result；所有写入都通过 options.write 注入。例成功脚本返回 { ok:true, value } 时，value 作为文本块追加。
export async function formatResult(
	result: CodemodeResult,
	options: {
		/** Images `models.generateImages()` returned; when the script showed none, the result says so. */
		readonly generatedImages: number;
		readonly wallMs: number;
		readonly maxOutputTokens: number;
		readonly calls: readonly { name: string; status: string }[];
		readonly limits: Limits;
		readonly write: OutputFile;
	},
): Promise<{ content: Item[]; fullOutputPath?: string }> {
	// 复制输出数组，后面的 push 不会改到 result.output。
	const output = [...result.output];
	// 成功且有返回值（包括 null/0 等非 undefined）时，把返回值作为额外文本项。
	if (result.ok && result.value !== undefined) output.push({ type: "text", text: valueText(result.value) });
	// 先排版脚本自己的输出。
	const items = formatItems(output);
	// 失败时把错误详情放在最后，便于模型先看输出再定位错误。
	if (!result.ok) items.push({ type: "text", text: `Script error:\n${formatError(result, options.calls)}` });
	const generated = options.generatedImages;
	// 模型生成了图片但脚本一个都没展示：追加提示，避免结果里丢失图片存在这一事实。
	if (generated > 0 && !items.some((item) => item.type === "image")) {
		items.push({
			type: "text",
			text: `Note: models.generateImages() returned ${generated} image${generated === 1 ? "" : "s"} that the script did not show. Show each image block of result.output with image(block).`,
		});
	}
	// 先合并再截断：截断按整段文本计算，合并可避免碎片化；图片随截断结果移到文本之后。
	const truncated = await truncate(joinAdjacentText(items), options.maxOutputTokens, options.limits, options.write);
	// After truncation, which joins the text items and moves images after them, so each path stays next to its image.
	// 截断后再保存图片：此时图片已集中到文本块之后，路径说明仍紧挨对应图片；再次 join 合并新增的文本说明。
	const content = joinAdjacentText(await saveImages(truncated.items, options.write));
	// 头部说明整体成败与实际耗时（毫秒转秒，保留一位小数）。
	const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${(options.wallMs / 1000).toFixed(1)} seconds\nOutput:\n`;
	// 头部作为第一个文本块；fullOutputPath 只在有值时展开到返回对象。
	return {
		content: [{ type: "text", text: header }, ...content],
		...(truncated.fullOutputPath === undefined ? {} : { fullOutputPath: truncated.fullOutputPath }),
	};
}
