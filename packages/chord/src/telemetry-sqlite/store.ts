// 所属：telemetry-sqlite 的只读查询层，把 SQLite 行转换为 pi-telemetry 的 StoredSpan/StoredTrace/StoredMetric。
// 职责：按 trace 取完整调用链、按条件分页找 trace、按系列/区间查指标；不负责写入、迁移或记录。
// 边界：SQL 全部参数化；属性键/值来自 query，不拼进 SQL 文本；JSON.parse 假定库内容由本模块写入。
// 上游：Recorder.getTrace/findTraces/findMetrics 委托；下游：SqliteDatabase.all 与 transaction。
// 导出清单：SpanRow 是数据库行形状；storedSpan 转成对外 Span；attributesSql 生成属性过滤；三个查询函数。
// 组合：getTrace 全量取一个 trace；findTraces 先用 heads 选 trace，再按 id 取所有 span 并分组；findMetrics 按 series 返回。
// 示例：const trace = await getTrace(db, "abc"); const page = await findTraces(db, { errors: true, limit: 20 });
// 阅读顺序：SpanRow → storedSpan → attributesSql → getTrace → findTraces → findMetrics。
import type {
	MetricQuery,
	SpanAttributes,
	SpanStatus,
	StoredMetric,
	StoredSpan,
	StoredTrace,
	TraceQuery,
} from "@earendil-works/pi-telemetry";
import type { SqliteDatabase, SqliteValue } from "../sqlite/index.ts";

// telemetry_spans 的原始行形状：列名是 snake_case；attributes/events/links/status 是 JSON 文本，读取时再解析。
type SpanRow = {
	id: string;
	trace_id: string;
	parent_id: string | null;
	name: string;
	started_ms: number;
	ended_ms: number;
	attributes: string;
	events: string;
	links: string;
	status: string;
};

// 把一行数据库记录映射为 StoredSpan；输入是已查出的行，输出是新的普通对象，不修改 row。
// JSON.parse 后用 as 断言：类型只在编译期成立，没有运行时 schema 校验；数据由本包写入，视为可信。
// events/links 内部字段还要从 snake_case 转成 camelCase；可选字段用条件展开，避免出现 undefined 属性。
// 示例：storedSpan({...}) 的 events[0] 从 { name, time_ms } 变为 { name, timeMs }。
function storedSpan(row: SpanRow): StoredSpan {
	return {
		id: row.id,
		traceId: row.trace_id,
		// 根 span 的 parent_id 为 NULL，对外省略 parentId；条件展开不会产生值为 undefined 的字段。
		// attributes/events/links/status 的 JSON.parse as 不验证内容；库内容由本包写入，视为可信。
		...(row.parent_id === null ? {} : { parentId: row.parent_id }),
		name: row.name,
		startedMs: row.started_ms,
		endedMs: row.ended_ms,
		attributes: JSON.parse(row.attributes) as SpanAttributes,
		events: (JSON.parse(row.events) as { name: string; time_ms: number; attributes: SpanAttributes }[]).map(
			// 数据库事件用 time_ms 与 schema 对齐；对外接口用 timeMs，转换时复制字段而不保留原对象。
			(event) => ({ name: event.name, timeMs: event.time_ms, attributes: event.attributes }),
		),
		links: (JSON.parse(row.links) as { trace_id: string; span_id: string; attributes?: SpanAttributes }[]).map(
			(link) => ({
				traceId: link.trace_id,
				spanId: link.span_id,
				...(link.attributes === undefined ? {} : { attributes: link.attributes }),
			}),
		),
		status: JSON.parse(row.status) as SpanStatus,
	};
}

// JSON equality must distinguish boolean true from numeric 1. json_each also handles arbitrary attribute keys.
// 生成属性过滤 SQL：每个键值对产生一个 EXISTS/json_each 条件，条件之间用 AND 连接。
// 输入 attributes（可省略）、列名 column 与参数数组 params；输出 SQL 片段，同时把键和值追加到 params。
// 类型片段是代码里的常量，键和值都走占位符，因此不把用户输入拼进 SQL。无属性时返回 "1"（恒真）。
// 示例：{ region: "eu", ok: true } 生成两个 EXISTS；布尔 true 要匹配 JSON 类型 true，而不是数字 1。
function attributesSql(attributes: TraceQuery["attributes"], column: string, params: SqliteValue[]): string {
	return (
		Object.entries(attributes ?? {})
			.map(([key, value]) => {
				const type =
					// JSON1 的 entry.type 区分 true/false 与 integer/real；数字条件接受整数和浮点两种存储类型。
					typeof value === "number"
						? "entry.type IN ('integer', 'real')"
						: typeof value === "boolean"
							? `entry.type = '${value ? "true" : "false"}'`
							: "entry.type = 'text'";
				// 布尔值在 SQLite 参数中存为 1/0，但前面用 entry.type 保证不会误匹配数值 1；字符串/数字直接绑定。
				params.push(key, typeof value === "boolean" ? Number(value) : value);
				return `EXISTS (SELECT 1 FROM json_each(${column}) entry WHERE entry.key = ? AND ${type} AND entry.value = ?)`;
			})
			.join(" AND ") || "1"
	);
}

// 读取一个 trace 的全部 span，按开始时间和 id 稳定排序；没有行时返回 undefined 而不是空 trace。
// 参数化 traceId；调用前应 flush 才能看到尚未提交的 span。示例：await getTrace(db, "abc")。
export async function getTrace(db: SqliteDatabase, traceId: string): Promise<StoredTrace | undefined> {
	const rows = await db.all<SpanRow>(
		"SELECT * FROM telemetry_spans WHERE trace_id = ? ORDER BY started_ms, id",
		traceId,
	);
	return rows.length ? { traceId, spans: rows.map(storedSpan) } : undefined;
}

// 按名称、开始时间、错误、属性和游标筛选 trace，返回一页（默认 20）并可能带下一页游标。
// 先按 trace 汇总最小开始时间得到 heads，再取整页 span 分组，避免为每个 trace 单独查询。
// 排序为 started_ms DESC, trace_id ASC；游标是 [started_ms, trace_id] 的 JSON，下一页从严格更旧的位置继续。
// 示例：const page = await findTraces(db, { errors: true, limit: 10 }); 之后传 page.cursor 取下一页。
export async function findTraces(
	db: SqliteDatabase,
	query: TraceQuery = {},
): Promise<{ traces: readonly StoredTrace[]; cursor?: string }> {
	const limit = query.limit ?? 20;
	const conditions: string[] = [];
	const params: SqliteValue[] = [];
	// 名称匹配 trace 中最早开始的 span（通常是根 span）；子查询与 heads.trace_id 关联。
	if (query.name !== undefined) {
		conditions.push(
			"(SELECT name FROM telemetry_spans WHERE trace_id = heads.trace_id ORDER BY started_ms, id LIMIT 1) = ?",
		);
		params.push(query.name);
	}
	if (query.startMin !== undefined) {
		conditions.push("started_ms >= ?");
		params.push(query.startMin);
	}
	if (query.startMax !== undefined) {
		conditions.push("started_ms <= ?");
		params.push(query.startMax);
	}
	// errors 为真时要求 trace 中至少一个 span 的 status.status 是 error；json_extract 读取 JSON 文本。
	if (query.errors)
		conditions.push(
			"EXISTS (SELECT 1 FROM telemetry_spans WHERE trace_id = heads.trace_id AND json_extract(status, '$.status') = 'error')",
		);
	if (query.attributes)
		conditions.push(
			`EXISTS (SELECT 1 FROM telemetry_spans candidate WHERE candidate.trace_id = heads.trace_id AND ${attributesSql(query.attributes, "candidate.attributes", params)})`,
		);
	if (query.cursor !== undefined) {
		// cursor 来自调用方（可能经网络），这里只做类型断言、不校验形状；形状错误会在参数绑定时失败。
		const cursor = JSON.parse(query.cursor) as [number, string];
		// 与 ORDER BY started_ms DESC, trace_id 对应：先取更旧的时间；同一时间取更大的 trace_id，避免重复/跳过。
		conditions.push("(started_ms < ? OR (started_ms = ? AND trace_id > ?))");
		params.push(cursor[0], cursor[0], cursor[1]);
	}
	return db.transaction(async (tx) => {
		// CTE heads 每个 trace 只留 min(started_ms)；LIMIT limit+1 用于判断是否还有下一页。
		const heads = await tx.all<{ trace_id: string; started_ms: number }>(
			`WITH heads AS (
			SELECT trace_id, min(started_ms) started_ms FROM telemetry_spans GROUP BY trace_id
		) SELECT * FROM heads WHERE ${conditions.join(" AND ") || "1"} ORDER BY started_ms DESC, trace_id LIMIT ?`,
			// 参数顺序与 conditions 中占位符出现顺序一致；limit+1 单独追加在最后。
			...params,
			limit + 1,
		);
		const more = heads.length > limit;
		if (more) heads.pop();
		// 没有匹配 trace 时直接返回空页，不再执行第二次查询；cursor 也不返回。
		if (!heads.length) return { traces: [] };
		const rows = await tx.all<SpanRow>(
			// 用 json_each 展开 id 数组，避免动态构造 IN 占位符；结果按 trace 内时间/id 排序。
			"SELECT * FROM telemetry_spans WHERE trace_id IN (SELECT value FROM json_each(?)) ORDER BY started_ms, id",
			JSON.stringify(heads.map((head) => head.trace_id)),
		);
		const grouped = new Map<string, StoredSpan[]>();
		for (const row of rows) {
			const spans = grouped.get(row.trace_id) ?? [];
			spans.push(storedSpan(row));
			grouped.set(row.trace_id, spans);
		}
		// heads 非空且 more 时 limit+1 已被 pop；! 表示数组末尾确实存在，不产生运行时检查。
		const last = heads.at(-1)!;
		return {
			// 每个 head 的 span 都已由上面的查询装入 grouped；! 依赖 SQL 结果的完整性，不是运行时验证。
			traces: heads.map((head) => ({ traceId: head.trace_id, spans: grouped.get(head.trace_id)! })),
			...(more ? { cursor: JSON.stringify([last.started_ms, last.trace_id]) } : {}),
		};
	});
}

// 按必填的 name 和可选时间范围/属性查询指标系列，按区间与 series_key 排序返回。
// 返回只读数组；unit 为 null 时省略字段，attributes 解析为对象。
// 示例：await findMetrics(db, { name: "hits", startMin: Date.now() - 60000 })。
export async function findMetrics(db: SqliteDatabase, query: MetricQuery): Promise<readonly StoredMetric[]> {
	const params: SqliteValue[] = [query.name];
	const conditions = ["name = ?"];
	if (query.startMin !== undefined) {
		conditions.push("interval_ms >= ?");
		params.push(query.startMin);
	}
	if (query.startMax !== undefined) {
		conditions.push("interval_ms <= ?");
		params.push(query.startMax);
	}
	// 指标表的 attributes 列本身是 JSON 对象，和查询属性逐项匹配；无条件时该函数返回 "1"。
	conditions.push(attributesSql(query.attributes, "attributes", params));
	const rows = await db.all<{
		interval_ms: number;
		name: string;
		kind: StoredMetric["kind"];
		unit: string | null;
		attributes: string;
		count: number;
		sum: number;
		min: number;
		max: number;
	}>(`SELECT * FROM telemetry_metrics WHERE ${conditions.join(" AND ")} ORDER BY interval_ms, series_key`, ...params);
	return rows.map((row) => ({
		intervalMs: row.interval_ms,
		name: row.name,
		kind: row.kind,
		...(row.unit === null ? {} : { unit: row.unit }),
		attributes: JSON.parse(row.attributes) as SpanAttributes,
		count: row.count,
		sum: row.sum,
		min: row.min,
		max: row.max,
	}));
}
