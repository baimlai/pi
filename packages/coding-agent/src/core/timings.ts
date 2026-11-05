// 记录启动各阶段之间的耗时；main 和扩展加载分别维护一组，启用后向 stderr 打印，不向遥测服务器发送。
/**
 * Central timing instrumentation for startup profiling.
 * Enable with PI_TIMING=1 environment variable.
 */

// 模块加载时读取一次开关；之后改环境不会改变此常量，和每次读取环境的 experimental.ts 不同。
const ENABLED = process.env.PI_TIMING === "1";
// 一组计时状态，不是单个独立计时器对象。
interface TimingNamespace {
	// Array<{...}> 表示含标签与毫秒数的对象数组。
	timings: Array<{ label: string; ms: number }>;
	// 本组上一次打点/重置的墙上时间。
	lastTime: number;
}

// 字面量联合限制分组，只能 main 或 extensions。
type TimingLabel = "main" | "extensions";

// Map 在模块生命周期保留各组记录；没有自动过期或打印后清空。
const timingNamespaces = new Map<TimingLabel, TimingNamespace>();

/**
 * 重置指定组的记录，并以当前时间作为新起点；缺省组为 main，返回 void。
 * 例：resetTimings("extensions") 只清扩展组，不影响 main。未启用时无状态变化。
 */
export function resetTimings(namespace: TimingLabel = "main"): void {
	// 开关关闭就直接返回，不创建 Map 项。
	if (!ENABLED) return;
	// 替换该组记录数组，并记住 Date.now()；不采用单调性能时钟。
	timingNamespaces.set(namespace, { timings: [], lastTime: Date.now() });
}

/**
 * 记录从该组上次时间到本次的差值，附 label，再推进时间基准。
 * 例：重置后约20ms调用 time("config")，新增约20ms；下一次约30ms后打点记的是30而不是累计50。未初始化组会先自动重置。
 */
export function time(label: string, namespace: TimingLabel = "main"): void {
	// 关闭时连当前时间都不读取。
	if (!ENABLED) return;
	// 先记本次时间；新组重置会在它之后再取一次 Date.now。
	const now = Date.now();

	// 不存在组时才初始化，已有记录不会因普通打点清空。
	if (!timingNamespaces.has(namespace)) {
		// 默认参数之外的显式 namespace 原样透传。
		resetTimings(namespace);
	}

	// ! 是非空断言：上面 has/reset 已建立组；它不会生成运行时检查。
	const timingNamespace = timingNamespaces.get(namespace)!;
	// 向本组数组追加标签和两次墙上时间差，可能因时钟调整/首次初始化顺序出现负数。
	timingNamespace.timings.push({ label, ms: now - timingNamespace.lastTime });
	// 下一次打点以本次 now 为基准。
	timingNamespace.lastTime = now;
}

/**
 * 把一组非负耗时打印到 stderr，负值滤掉，空组不输出；不修改原数组。
 * 例：两段20/30ms，TOTAL显示50ms；TOTAL只是保留段的和，不一定等于整个进程启动时间。
 */
function printTimingGroup(title: string, timings: TimingNamespace["timings"]): void {
	// 索引访问类型 TimingNamespace["timings"] 复用字段类型；filter 仅保留 ms>=0。
	const printableTimings = timings.filter((timing) => timing.ms >= 0);
	// 没有可打印项就不输出标题或总数。
	if (printableTimings.length === 0) return;
	// 模板字面量前加换行，构造分组标题。
	console.error(`\n--- ${title} ---`);
	// 依打点顺序输出每段。
	for (const t of printableTimings) {
		// 标签和毫秒拼成状态文字，不做 JSON 序列化。
		console.error(`  ${t.label}: ${t.ms}ms`);
	}
	// reduce 从0累加非负耗时；a是累计值，b是当前段。
	console.error(`  TOTAL: ${printableTimings.reduce((a, b) => a + b.ms, 0)}ms`);
	// repeat 生成与标题长度相关的分隔线，再换行。
	console.error(`${"-".repeat(title.length + 8)}\n`);
}

/**
 * 打印当前所有分组，返回 void，不重置计时记录。
 * 例：连续调用两次会重复打印同样记录；只有启用PI_TIMING且有非负段才实际输出。
 */
export function printTimings(): void {
	// 未启用时完全跳过打印。
	if (!ENABLED) return;
	// for...of 解构 Map 的键值对，按分组首次插入顺序遍历。
	for (const [namespace, timingNamespace] of timingNamespaces) {
		// 每组用相同打印规则，标题包含 namespace。
		printTimingGroup(`Startup Timings: ${namespace}`, timingNamespace.timings);
	}
}
