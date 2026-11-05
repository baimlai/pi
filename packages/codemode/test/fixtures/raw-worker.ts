// 手写测试替身：把 code 当 JSON 数据发给宿主，专门构造真实 VM 不会产生的坏桥消息；不会编译或执行 code。
/**
 * Stands in for the real worker in host tests: posts the JSON message (or array of messages) passed
 * as the script source, so tests can send the host payloads the real prelude never produces.
 */
// 两个值由 Node 子线程提供；主线程直接导入本文件不具备相同 workerData。
import { parentPort, workerData } from "node:worker_threads";

// as 只作静态断言；JSON.parse 真正解析文字，语法错误会在线程内抛出，返回值先按 unknown 持有。
const messages: unknown = JSON.parse((workerData as { code: string }).code);
// 运行时判 JSON 是否数组：数组逐项发送，单值包装为一项；?. 让没有 parentPort 时不发送。发送后没有自行等待回复。
for (const message of Array.isArray(messages) ? messages : [messages]) parentPort?.postMessage(message);
