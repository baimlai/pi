/**
 * 把已存储span快照渲染成缩进文字，独立于采集/存储后端；不会查询数据库、追随link或上传遥测。
 * 例根read及子fetch会输出read一行、下方缩进fetch；事件和链接作为附加行，耗时来自endedMs-startedMs。
 * 输入按id去重后建父子表，按开始时间排根/兄弟，再用显式栈深度优先输出。它不校验任意坏父链，纯父环无根的分量不会输出。
 */
// 仅导入快照/属性类型，渲染器不因此加载内存adapter或某个存储后端。
import type { SpanAttributes, StoredSpan } from "./index.ts";

// formatAttributes把自有属性拼成 key=JSON文字；例{cached:false}变前置空格加cached=false。键名原样，值JSON转义不脱敏，不承诺整段可反解析或任意JS值都不抛错。
function formatAttributes(attributes: Readonly<SpanAttributes> = {}): string {
	// Object.entries按自有可枚举字符串字段，缺attributes用默认{}；readonly仅约束本视图写入。
	return (
		Object.entries(attributes)
			// 解构键值后字符串插值；undefined也会变展示文字undefined，JSON.stringify的用户toJSON/getter可有副作用/抛错。
			.map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
			// 把各段直接连接，每段本身已有前置空格。
			.join("")
	);
}

/** Render stored spans as a chronological forest, treating absent parents as roots. */
// renderTrace去重→分根/孩子→显式栈输出，例缺父快照的span当根。返回整段字符串，无终端写入；不修改原数组/快照，属性序列化仍可能运行用户代码。
export function renderTrace(spans: readonly StoredSpan[]): string {
	// Map按id去重，同id后项覆盖值，但首次插入位置保留；不按traceId另分组，所以调用方通常传同trace快照或已合并集合。
	const byId = new Map(spans.map((span) => [span.id, span]));
	// 收集没有可用父节点的根，初始空。
	const roots: StoredSpan[] = [];
	// 父id→子span数组，链接不作为父子边。
	const children = new Map<string, StoredSpan[]>();
	// 从Map取新数组按startedMs升序排，不原地sort输入；同时间靠稳定sort维持Map遍历顺序。
	for (const span of [...byId.values()].sort((left, right) => left.startedMs - right.startedMs)) {
		// 没parentId或父id没出现在byId里就根；不凭时间范围猜父子关系。
		if (span.parentId === undefined || !byId.has(span.parentId)) {
			// 按已经排好的时间顺序收根。
			roots.push(span);
			// 父存在则挂孩子，父自指/环没有额外报错机制。
		} else {
			// 取该父已经收集的兄弟列表。
			const siblings = children.get(span.parentId);
			// 首次孩子创建数组。
			if (siblings === undefined) children.set(span.parentId, [span]);
			// 后续追加，不再次单独sort，因为全量遍历已按开始时间排。
			else siblings.push(span);
		}
	}

	// 最终文字行累积数组，不是逐行流式回调。
	const lines: string[] = [];
	// 只反转局部roots，让栈pop仍先拿最早根；map把深度设0，不改原输入。
	const pending = roots.reverse().map((span) => ({ span, depth: 0 }));
	// 有待处理节点就持续迭代，不用递归函数，深树不占同样深的JS调用栈。
	while (pending.length > 0) {
		// 非空栈前提下pop必有项，!是TS非空断言，不加运行兜底。
		const { span, depth } = pending.pop()!;
		// 每层两个空格，深树的输出总量仍随缩进增长，没有严格输出预算。
		const indent = "  ".repeat(depth);
		// 成功状态默认没有错误后缀。
		let error = "";
		// 用标签status收窄为error分支，才可读可选error详情。
		if (span.status.status === "error") {
			// 先标error文字。
			error = " error";
			// 若有详情再拼name/message，未做脱敏或换行消毒。
			if (span.status.error !== undefined) error += ` ${span.status.error.name}: ${span.status.error.message}`;
		}
		// 追加主span一行。
		lines.push(
			// 插值组合缩进、名称、属性、毫秒差与错误；跨进程时钟/输入快照是否合理不由这里修正。
			`${indent}${span.name}${formatAttributes(span.attributes)} (${span.endedMs - span.startedMs}ms)${error}`,
		);
		// 事件按快照已有顺序输出，不按timeMs重新排序。
		for (const event of span.events) {
			// 事件时间是相对span开始的偏移，不是epoch时间；文字中的符号属展示，不参与树关系。
			lines.push(`${indent}  · ${event.name}${formatAttributes(event.attributes)} (+${event.timeMs}ms)`);
		}
		// 逐link只展示目标trace/span id。
		for (const link of span.links) {
			// 不查目标、不沿link递归，所以link循环不会让此函数循环跟随。
			lines.push(`${indent}  → link trace ${link.traceId} span ${link.spanId}${formatAttributes(link.attributes)}`);
		}
		// 没有孩子用空数组；??只处理缺失，不自动创建Map项。
		const descendants = children.get(span.id) ?? [];
		// 逆序压孩子，使下一次pop按正序先处理最早孩子，形成深度优先的树展示。
		for (let index = descendants.length - 1; index >= 0; index--) {
			// 子深度+1；!基于循环边界，TS断言不拷贝或验证子快照。
			pending.push({ span: descendants[index]!, depth: depth + 1 });
		}
	}
	// 用LF拼整段，空输入自然返回空字符串，不补末尾换行。
	return lines.join("\n");
}
