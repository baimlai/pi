// JSONL用LF分隔JSON记录；这些用例通过内存Readable验证文字分隔，不连接真正的RPC进程。
import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";

// 登记协议记录边界用例；读取器只拆行，JSON.parse由测试自己执行。
describe("RPC JSONL framing", () => {
	// 无输入；编码包含Unicode行/段分隔符的对象，检查正文和末尾LF，再解析回原对象。例如U+2028留在JSON字符串内，不能被视为记录边界。
	test("serializes strict JSONL records without escaping Unicode separators", () => {
		// \u2028与\u2029是源码转义，运行时分别成为实际的Unicode字符。
		const line = serializeJsonLine({ text: "a\u2028b\u2029c" });

		// 包含断言要求原字符仍存在，没有被写成六字符的反斜杠u文本。
		expect(line).toContain("a\u2028b\u2029c");
		// 检查记录结束标记；仅验证末尾LF，没有断言全部内容只能有一个LF。
		expect(line.endsWith("\n")).toBe(true);
		// trim移除记录尾空白后JSON.parse；解析失败会直接使测试抛错。
		expect(JSON.parse(line.trim())).toEqual({ text: "a\u2028b\u2029c" });
	});

	// 无输入；把一条记录放进内存流，收集拆行回调并等end，期待只一行且内容完整。Promise<void>只表示完成，不携带结果；不覆盖字节跨块情况。
	test("splits on LF only and preserves U+2028/U+2029 inside payloads", async () => {
		// 显式string[]让push只接受字符串；结果在流回调内累积。
		const lines: string[] = [];
		// Readable.from按给定迭代项供数据，数组这里只包含一段完整文字。
		const stream = Readable.from([serializeJsonLine({ text: "a\u2028b\u2029c" })]);

		// Promise执行器立即登记end监听；先登记再启动读取，避免漏掉结束。
		const done = new Promise<void>((resolve) => {
			// end发生时调用resolve；没有安装error→reject通路。
			stream.on("end", resolve);
		});

		// 读取器订阅data/end并返回退订函数；本例不保存它，由流自然结束。
		attachJsonlLineReader(stream, (line) => {
			// 每次回调追加一条已去分隔符的记录文字，不在此解析。
			lines.push(line);
		});

		// 等内存流结束后再断言，避免在数据到达前检查空数组。
		await done;

		// 若误把U+2028/U+2029拆开，条数将超过一。
		expect(lines).toHaveLength(1);
		// 索引取首行并解析，深比较字符内容。
		expect(JSON.parse(lines[0])).toEqual({ text: "a\u2028b\u2029c" });
	});

	// 无输入；读取包含两条CRLF记录的Buffer，等end后比较去掉行尾CR/LF的文字。例如第二行不应带\r；没有测试正文内部的CR。
	test("handles CRLF-delimited input", async () => {
		// 收集每次回调得到的行。
		const lines: string[] = [];
		// Buffer.from默认UTF-8编码，\r\n分别生成CR与LF字节。
		const stream = Readable.from([Buffer.from('{"a":1}\r\n{"b":2}\r\n')]);

		// 在附加读取器前建立只等待结束的Promise。
		const done = new Promise<void>((resolve) => {
			// 此处仅处理end，没有模拟流错误。
			stream.on("end", resolve);
		});

		// 同步行回调接收已移除分隔符的文字。
		attachJsonlLineReader(stream, (line) => {
			// push原地改变数组，而不是重新分配lines变量。
			lines.push(line);
		});

		// 等所有正常流数据被读取。
		await done;

		// 深比较既检查两条的顺序，也检查末尾没有CR。
		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	// 无输入；提供没有末尾LF的最后一条记录，结束时应冲刷缓冲。例如{"a":1}仍需回调一次；不覆盖空残段或不完整UTF-8。
	test("emits a final line without trailing LF", async () => {
		// 每条文本仍收集到独立的测试局部数组。
		const lines: string[] = [];
		// 一个Buffer块结束后流就end；内容不包含换行。
		const stream = Readable.from([Buffer.from('{"a":1}')]);

		// 建立end完成信号；返回类型void意味着await只等待，不取值。
		const done = new Promise<void>((resolve) => {
			// 注册结束监听，不读取文件或网络。
			stream.on("end", resolve);
		});

		// 附加读取器使其在end时也能发送最后非空残段。
		attachJsonlLineReader(stream, (line) => {
			// 保存残段回调内容供结束后的断言使用。
			lines.push(line);
		});

		// await恢复时同一end事件的同步监听器已经执行完。
		await done;

		// 同时检查只发送一次，且正文原样保留。
		expect(lines).toEqual(['{"a":1}']);
	});
});
