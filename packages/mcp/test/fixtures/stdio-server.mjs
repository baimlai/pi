// 供stdio.test.ts启动的手写Node模拟MCP服务：stdin逐行读JSON，stdout一行一份结果，stderr写诊断。
// 运行这个模块会持续等stdin；不是仅导出函数的库，不连接网络/模型，不做完整协议或工具参数schema检查。
// 从Node内置readline取按行接口，导入本身不会替这里创建业务流。
import { createInterface } from "node:readline";

// ready写到stderr而非协议stdout，让传输可独立捕获诊断，不污染JSON-RPC行。
console.error("stdio fixture ready");
// 从stdin建逐行接口；crlfDelay=Infinity使跨时间到达的CRLF仍作为一个行尾，不是设置无限等待每行的超时。
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

// 顶层for await按异步迭代取一行，输入EOF结束循环；.mjs为ES模块，支持顶层await，无额外常驻timer。
for await (const line of lines) {
	// 把该行JSON解码；坏JSON会抛错，没有局部catch生成协议错误响应。
	const message = JSON.parse(line);
	// 没有id就continue忽略通知；in也能看继承属性，不能视作完整请求骨架校验，非对象还可能抛错。
	if (!("id" in message)) continue;
	// let为本轮结果留变量；本文件是普通JS，没有TS类型标注或隐式schema验证。
	let result;
	// 按method字符串选握手分支，不核对客户端版本。
	if (message.method === "initialize") {
		// 准备固定握手业务结果对象，不直接写stdout。
		result = {
			// 选择一个被客户端支持的固定版本，不动态取LATEST_PROTOCOL_VERSION。
			protocolVersion: "2025-06-18",
			// 声明提供工具能力，具体工具随后由tools/list列出。
			capabilities: { tools: {} },
			// 模拟服务固定身份，不读取包版本/真实服务器信息。
			serverInfo: { name: "stdio-fixture", version: "1.0.0" },
		};
	// 列表分支与握手分支互斥。
	} else if (message.method === "tools/list") {
		// 只列echo及object输入schema，未规定text为必填，也没有在下一分支执行该schema。
		result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
	// 所有tools/call都用下面回显，不进一步校验params.name必须echo。
	} else if (message.method === "tools/call") {
		// 直接读取params.arguments.text再String化作text块；例hello回hello，缺中间对象会抛错，非字符串值可能被String转换。
		result = { content: [{ type: "text", text: String(message.params.arguments.text) }] };
	// ping分支返回空业务对象，表示本模拟器可回应存活探测。
	} else if (message.method === "ping") {
		// 空对象是成功result，不是undefined或没有回复。
		result = {};
	// 剩余方法走未知方法error分支。
	} else {
		// 用原请求id回-32601错误，一行JSON后追加LF；stdout.write只排入管道，不await其回调/背压。
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } })}\n`);
		// 发过error后跳过本轮成功result写出，防同一编号重复答复。
		continue;
	}
	// 已识别方法把本轮result序列化回原id并加LF；字段内换行由JSON编码转义，单条结果保持一行。
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}
