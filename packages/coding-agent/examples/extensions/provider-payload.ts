// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：把每次供应商请求的最终 payload 与响应状态/响应头同步追加到项目 .pi/provider-payload.log，
//   用于观察 Pi 实际发送给模型的内容；日志可能包含完整对话和敏感数据。
// 上游：扩展加载后宿主在发送请求前触发 before_provider_request，收到 HTTP 响应后触发 after_provider_response。
// 下游：appendFileSync 写 <cwd>/.pi/provider-payload.log；不创建目录，不返回替换 payload。
//   写入/序列化异常会从事件处理器向外传播。
// 能力：
//   默认导出函数  注册两个观察型钩子。
// 典型顺序：请求适配完成 -> before_provider_request 写 payload -> HTTP 响应 -> after_provider_response 写状态/头。
// 示例：一次请求后日志先出现缩进的 JSON 请求体，再出现 `[200] {"content-type":"..."}`。
// 阅读顺序：先看日志位置与写盘方式，再看两个事件的字段差异，最后看被注释的 payload 替换写法。

// 把供应商请求体与响应状态/头同步追加到项目 .pi 下的日志；日志可能包含完整请求数据。

// 导入同步文件追加函数；调用时会阻塞当前 JavaScript 线程直到写入结束。
import { appendFileSync } from "node:fs";
import { join } from "node:path";
// 配置目录名是运行时值，type 标记的 API 名称只供 TypeScript 检查。
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 入口仅登记两个钩子，不创建日志目录。例：请求发生时写 provider-payload.log；写入或序列化失败会向事件调用方传播。
// 如果 <cwd>/.pi 不存在，appendFileSync 会抛 ENOENT；示例要求项目已有配置目录。
export default function (pi: ExtensionAPI) {
	// 发送请求前读取提供商最终请求体；此回调没有返回替换对象，所以只记录。
	// event.payload 是 unknown（各供应商协议不同）；JSON.stringify 能处理普通对象，遇到循环引用/BigInt 会抛错。
	pi.on("before_provider_request", (event, ctx) => {
		// 按当前工作目录拼出日志位置；join 只拼路径，不保证父目录存在。
		const logFile = join(ctx.cwd, CONFIG_DIR_NAME, "provider-payload.log");
		// JSON.stringify 的第三参 2 生成两空格缩进，再追加两个换行，以 UTF-8 写盘。
		// 同步写虽然简单，但会阻塞事件循环；大 payload 或慢磁盘时可能拖慢请求。
		appendFileSync(logFile, `${JSON.stringify(event.payload, null, 2)}\n\n`, "utf8");

		// Optional: replace the payload instead of only logging it.
		// 取消注释后返回新对象即可替换本次请求体（非 undefined 返回值会逐处理器串接）；
		// 当前实现刻意不返回，保持请求原样。
		// return { ...event.payload, temperature: 0 };
	});

	// 收到响应元数据后记录状态与请求头；这里不读取/复制响应正文。
	// status 是 HTTP 状态码；headers 是 string->string 的响应头，与请求头的可删除 null 值不同。
	pi.on("after_provider_response", (event, ctx) => {
		// 按当前工作目录拼出日志位置；join 只拼路径，不保证父目录存在。
		const logFile = join(ctx.cwd, CONFIG_DIR_NAME, "provider-payload.log");
		// 将状态码和头对象的紧凑 JSON 追加为一段记录。
		// headers 的枚举顺序取决于运行时对象，日志不保证固定顺序。
		appendFileSync(logFile, `[${event.status}] ${JSON.stringify(event.headers)}\n\n`, "utf8");
	});
}
