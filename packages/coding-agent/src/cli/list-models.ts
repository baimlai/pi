// 为 --list-models 获取可用模型、模糊筛选并输出对齐表格，不调用模型生成回答。
/**
 * List available models with optional fuzzy search
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { formatNoModelsAvailableMessage } from "../core/auth-guidance.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";

/**
 * Format a number as human-readable (e.g., 200000 -> "200K", 1000000 -> "1M")
 */
/**
 * 把 token 容量格式化为简短字符串，不改变实际模型限制。
 * 输入 200000 返回 "200K"，1500000 返回 "1.5M"，512 返回 "512"；只负责展示。
 */
function formatTokenCount(count: number): string {
	// 数字里的下划线只是提高源码可读性，运行值仍为 1000000；先判断百万档避免落入千档。
	if (count >= 1_000_000) {
		// 转换成以百万为单位的小数，例如 1500000 变 1.5。
		const millions = count / 1_000_000;
		// 取余为 0 表示整数，不多显示 .0；有小数时保留一位。
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	// 不足百万但至少一千时使用 K。
	if (count >= 1_000) {
		// 以千为单位，1500 变 1.5。
		const thousands = count / 1_000;
		// 同样避免整数显示无用小数位。
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	// 不足一千直接转字符串，不加单位。
	return count.toString();
}

/**
 * List available models, optionally filtered by search pattern
 */
/**
 * 异步列出可用模型，按可选搜索词筛选，再按供应商和模型 id 排序输出。
 * 返回 Promise<void>；副作用是 stdout 表格及 stderr 运行时目录相关警告，取消信号传给目录查询。
 * 例：searchPattern="sonnet" 会在 provider 与 id 组成的文字上模糊匹配；结果为空则明确提示。
 */
export async function listModels(
	// 使用共享模型运行时获取目录、认证可用性等信息，不直接读取全局模型数组。
	modelRuntime: ModelRuntime,
	// 可选模糊搜索词，例如 sonnet；没传时不筛选。
	searchPattern?: string,
	// 可选取消信号，继续传给模型可用性查询。
	signal?: AbortSignal,
): Promise<void> {
	// 读取运行时累计的配置加载、供应商组装和可用性刷新错误；有错误时仍可能有可列出的模型。
	const loadError = modelRuntime.getError();
	// 有加载问题时提示警告，但不在这里立即结束列举。
	if (loadError) {
		// 沿用现有警告标题，具体错误可能来自不同阶段；警告写 stderr，表格写 stdout。
		console.error(chalk.yellow(`Warning: errors loading models.json:\n${loadError}`));
	}

	// 等待可用模型列表并复制顶层数组；后面的 sort 不会改运行时持有的原数组。
	const models = [...(await modelRuntime.getAvailable(undefined, { signal }))];

	// 没有可用模型时输出认证/模型配置提示，然后结束。
	if (models.length === 0) {
		// 复用统一的无模型提示，避免每个命令给出不同建议。
		console.log(formatNoModelsAvailableMessage());
		// 提前结束当前列举函数，不退出整个 Node 进程。
		return;
	}

	// Apply fuzzy filter if search pattern provided
	// 显式标注模型数组类型；let 允许筛选后替换数组变量。
	let filteredModels: Model<Api>[] = models;
	// 只在搜索词非空时执行模糊匹配。
	if (searchPattern) {
		// 以供应商名和模型 id 联合文字作为匹配目标，不按展示 name 搜索。
		filteredModels = fuzzyFilter(models, searchPattern, (m) => `${m.provider} ${m.id}`);
	}

	// 有模型但没有匹配结果时，区别于完全没有可用模型。
	if (filteredModels.length === 0) {
		// 告诉用户是哪一个搜索模式没有命中。
		console.log(`No models matching "${searchPattern}"`);
		// 提前结束当前列举函数，不退出整个 Node 进程。
		return;
	}

	// Sort by provider, then by model id
	// sort 原地重排当前数组，先按供应商，再按模型 id。
	filteredModels.sort((a, b) => {
		// 字符串比较返回负/零/正，适合直接作为排序比较值。
		const providerCmp = a.provider.localeCompare(b.provider);
		// 供应商不同就按供应商排序，不再比较 id。
		if (providerCmp !== 0) return providerCmp;
		// 同一供应商下再按模型 id 排序。
		return a.id.localeCompare(b.id);
	});

	// Calculate column widths
	// 将每个模型变成展示行；箭头函数的 ({...}) 表示直接返回对象。
	const rows = filteredModels.map((m) => ({
		// 供应商列采用稳定 id。
		provider: m.provider,
		// 模型列采用模型 id，不混入描述文字。
		model: m.id,
		// 上下文窗口格式化成 K/M，表示模型目录声明的容量。
		context: formatTokenCount(m.contextWindow),
		// 输出 token 上限是另一个值，不能把它当完整上下文窗口。
		maxOut: formatTokenCount(m.maxTokens),
		// 按模型元数据报告是否支持思考；不表示当前请求已开启思考。
		thinking: m.reasoning ? "yes" : "no",
		// 检查输入模态是否包括 image，不能据此推断模型也会生成图片。
		images: m.input.includes("image") ? "yes" : "no",
	}));

	// 定义各列标题文字，后面计算宽度也要把标题算进去。
	const headers = {
		// 供应商的列名。
		provider: "provider",
		// 模型 id 的列名。
		model: "model",
		// 完整上下文容量的列名。
		context: "context",
		// 最大输出容量的列名，与 context 区分。
		maxOut: "max-out",
		// 是否支持思考的列名。
		thinking: "thinking",
		// 是否接受图片输入的列名。
		images: "images",
	};

	// 每列取标题与所有行的最大字符串长度；... 展开行长度作为 Math.max 的多个参数。
	const widths = {
		// 取标题与每个供应商文字的最大长度；map 只提取本列的长度。
		provider: Math.max(headers.provider.length, ...rows.map((r) => r.provider.length)),
		// 模型 id 往往最长，不能只按第一行决定列宽。
		model: Math.max(headers.model.length, ...rows.map((r) => r.model.length)),
		// 格式化后的 K/M 文字也要与标题比较宽度。
		context: Math.max(headers.context.length, ...rows.map((r) => r.context.length)),
		// 最大输出列独立计算，不复用 context 的宽度。
		maxOut: Math.max(headers.maxOut.length, ...rows.map((r) => r.maxOut.length)),
		// thinking 标题比 yes/no 长，纳入标题才能对齐。
		thinking: Math.max(headers.thinking.length, ...rows.map((r) => r.thinking.length)),
		// images 列同样不能只按 yes/no 的长度补空格。
		images: Math.max(headers.images.length, ...rows.map((r) => r.images.length)),
	};

	// Print header
	// 依次排列每列标题，padEnd 补空格到该列宽度。
	const headerLine = [
		// padEnd 只在右边补空格到目标宽度，不截断长文字。
		headers.provider.padEnd(widths.provider),
		// 按同一顺序写模型标题。
		headers.model.padEnd(widths.model),
		// 上下文容量标题。
		headers.context.padEnd(widths.context),
		// 输出容量标题。
		headers.maxOut.padEnd(widths.maxOut),
		// 思考能力标题。
		headers.thinking.padEnd(widths.thinking),
		// 图片输入标题。
		headers.images.padEnd(widths.images),
		// join 的两个空格是列间距；前面的 padEnd 已补齐列内宽度。
	].join("  ");
	// 先写表头，再逐行输出模型。
	console.log(headerLine);

	// Print rows
	// 按已经排好序的展示行输出。
	for (const row of rows) {
		// 以同一列顺序拼装当前行，列间用两个空格分隔。
		const line = [
			// 每行采用与标题完全相同的列顺序和列宽。
			row.provider.padEnd(widths.provider),
			// 当前模型 id。
			row.model.padEnd(widths.model),
			// 当前模型的格式化上下文容量。
			row.context.padEnd(widths.context),
			// 当前模型的格式化最大输出。
			row.maxOut.padEnd(widths.maxOut),
			// 思考能力 yes/no。
			row.thinking.padEnd(widths.thinking),
			// 图片输入能力 yes/no。
			row.images.padEnd(widths.images),
			// 按表头一致的间距拼成一行文字。
		].join("  ");
		// 输出一行；本函数只列模型，不发送聊天问题。
		console.log(line);
	}
}
