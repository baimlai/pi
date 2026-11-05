// For benchmarks: the bytes live objects hold, from a heap snapshot. `heapUsed` after `gc()` also counts what the
// collector has not compacted yet, which hides a small leak or invents a large one.
import { Session } from "node:inspector/promises";

/** Sum of the self sizes of every object in a fresh heap snapshot, which collects garbage first. */
// 抓取当前 Node 进程的 V8 堆快照并累加对象自身字节数，返回 Promise<number>。
// 例如两次工作负载后分别测量以观察保留量；会触发堆快照/垃圾回收并占用额外内存，非轻量计时。
// 连接或协议/JSON 解析失败直接传出；快照请求结束无论成功失败都会断开 inspector。
export async function retainedBytes(): Promise<number> {
	// 创建当前进程的 inspector 协议会话，不连接外部调试服务。
	const inspector = new Session();
	// 建立与当前 V8 实例的连接。
	inspector.connect();
	// 堆快照通过多次事件发出，先收集字符串片段。
	const chunks: string[] = [];
	// 每到一个 chunk 就追加；这里累积的是快照 JSON 文本。
	inspector.on("HeapProfiler.addHeapSnapshotChunk", (message) => chunks.push(message.params.chunk));
	// 只将协议请求包进 try/finally，保证请求失败时也断开。
	try {
		// 等待生成完整快照，禁用进度报告但仍接收 chunk 事件。
		await inspector.post("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
	} finally {
		// 释放协议连接，随后在普通 JS 中分析已收到的数据。
		inspector.disconnect();
	}
	// 拼回 JSON 再解析；as 只是声明 V8 快照结构，没有逐字段运行时校验。
	const snapshot = JSON.parse(chunks.join("")) as {
		snapshot: { meta: { node_fields: string[] } };
		nodes: number[];
	};
	// 读取扁平 nodes 数组每条记录的字段顺序。
	const fields = snapshot.snapshot.meta.node_fields;
	// 每个节点占 width 个数值，用它定位下一条记录。
	const width = fields.length;
	// 定位 self_size 在每条记录内的偏移，不把指向的其他对象重复算入自身大小。
	const size = fields.indexOf("self_size");
	// 从零累加所有节点的自身大小。
	let total = 0;
	// 每次跨一条节点记录，! 告诉 TS 索引存在；V8 格式是此处依赖的协议约定。
	for (let index = size; index < snapshot.nodes.length; index += width) total += snapshot.nodes[index]!;
	// 返回所有 self_size 的和，不等同于整个操作系统进程的驻留内存。
	return total;
}
