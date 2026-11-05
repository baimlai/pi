// 把供应商请求体与响应状态/头同步追加到项目 .pi 下的日志；日志可能包含完整请求数据。

// 导入同步文件追加函数；调用时会阻塞当前 JavaScript 线程直到写入结束。
import { appendFileSync } from "node:fs";
import { join } from "node:path";
// 配置目录名是运行时值，type 标记的 API 名称只供 TypeScript 检查。
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 入口仅登记两个钩子，不创建日志目录。例：请求发生时写 provider-payload.log；写入或序列化失败会向事件调用方传播。
export default function (pi: ExtensionAPI) {
	// 发送请求前读取提供商最终请求体；此回调没有返回替换对象，所以只记录。
	pi.on("before_provider_request", (event, ctx) => {
		// 按当前工作目录拼出日志位置；join 只拼路径，不保证父目录存在。
		const logFile = join(ctx.cwd, CONFIG_DIR_NAME, "provider-payload.log");
		// JSON.stringify 的第三参 2 生成两空格缩进，再追加两个换行，以 UTF-8 写盘。
		appendFileSync(logFile, `${JSON.stringify(event.payload, null, 2)}\n\n`, "utf8");

		// Optional: replace the payload instead of only logging it.
		// return { ...event.payload, temperature: 0 };
	});

	// 收到响应元数据后记录状态与请求头；这里不读取/复制响应正文。
	pi.on("after_provider_response", (event, ctx) => {
		// 按当前工作目录拼出日志位置；join 只拼路径，不保证父目录存在。
		const logFile = join(ctx.cwd, CONFIG_DIR_NAME, "provider-payload.log");
		// 将状态码和头对象的紧凑 JSON 追加为一段记录。
		appendFileSync(logFile, `[${event.status}] ${JSON.stringify(event.headers)}\n\n`, "utf8");
	});
}
