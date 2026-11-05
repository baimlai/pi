// 处理RPC的逐行协议边界：写端追加LF，读端只按LF拆行；这里只处理字节/行，不解析JSON或校验命令。
// Readable是运行时传入流的类型，不由此行创建stdin/stdout。
import type { Readable } from "node:stream";
// UTF-8字符可能跨Buffer，StringDecoder保留半字符等待下一块。
import { StringDecoder } from "node:string_decoder";

/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only.
 */
/**
 * 把可JSON序列化的数据编码成一条带末尾换行的协议文字，不直接写流。
 * 例：{text:"a\nb"}中换行会由JSON.stringify转义，最后才加记录分隔LF；U+2028/U+2029不会被本模块当分隔符。
 * unknown只是允许传任意类型，并不保证都能编码：循环对象/BigInt会抛；顶层undefined会被模板串变成"undefined\n"，调用方须传协议可编码值。
 */
export function serializeJsonLine(value: unknown): string {
	// JSON.stringify先编码正文，模板末尾的\n才是两条记录之间真正的分隔符。
	return `${JSON.stringify(value)}\n`;
}

/**
 * Attach an LF-only JSONL reader to a stream.
 *
 * This intentionally does not use Node readline. Readline splits on additional
 * Unicode separators that are valid inside JSON strings and therefore does not
 * implement strict JSONL framing.
 */
/**
 * 订阅Readable的data/end，增量解码UTF-8并按LF拆行，逐行同步调用onLine；返回取消订阅函数。
 * 例：两块"ab"、"c\nnext\n"会回调"abc"与"next"；CRLF会去末尾一个CR，空行也会回调。结束时非空残段即使没LF也会交出去。
 * 不限制缓冲长度，不解析/过滤JSON，不await回调、不隔离回调异常；取消只移监听，不暂停或关闭流，也不冲刷已缓冲残段。
 */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
	// 每个阅读器有独立解码状态，避免不同流之间拼接半字符。
	const decoder = new StringDecoder("utf8");
	// 保存尚未遇LF的文字尾部，后续块直接接在它后面。
	let buffer = "";

	/** 向外回调一行，最多去掉行末一个CR；例："x\r"变"x"，不trim其他空白，不跳过空行。 */
	const emitLine = (line: string) => {
		// endsWith检查末字符，slice(0,-1)去一位；这不是对正文所有CR的全局删除。
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	/** 追加一块字符串/Buffer并尽量发出所有完整行；例：一块有3个LF，就同步调用3次，不形成异步串行命令队列。 */
	const onData = (chunk: string | Buffer) => {
		// typeof根据联合输入分流：已是文字直接拼接，Buffer通过跨块解码器；混合两种输入时也不额外重置解码状态。
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		// 一块数据可能含多条记录，因此持续查找，直到没有LF。
		while (true) {
			// 只找U+000A，不按Unicode段落/行分隔符切开合法JSON字符串。
			const newlineIndex = buffer.indexOf("\n");
			// indexOf找不到返回-1，此时保留整段buffer等下一块。
			if (newlineIndex === -1) {
				return;
			}

			// 先回调LF之前的内容；回调同步抛错时，下一行裁缓冲还没执行。
			emitLine(buffer.slice(0, newlineIndex));
			// 丢掉已交付行及一个LF，保留后续记录/残段。
			buffer = buffer.slice(newlineIndex + 1);
		}
	};

	/** 输入结束时结束UTF-8解码，再发最后非空残段；残缺字节按StringDecoder规则处理，不代表已通过JSON校验。 */
	const onEnd = () => {
		// end可把最后不完整UTF-8字节转成替代字符，追加到尚存文字。
		buffer += decoder.end();
		// 结束时空残段不再产生额外空行，但data里明确出现的空记录仍会回调。
		if (buffer.length > 0) {
			// 最后一条记录不强制要求末尾LF。
			emitLine(buffer);
			// 回调成功后清残段。
			buffer = "";
		}
	};

	// 添加data监听会让通常的Readable进入流动模式，调用方负责流的整体生命周期。
	stream.on("data", onData);
	// 本函数没有监听error/close来代替end，流异常由宿主处理。
	stream.on("end", onEnd);

	// 返回闭包捕获准确监听器引用，取消时不会移除其他模块的监听。
	return () => {
		// 停止接收后续数据；已有buffer不再自动发出。
		stream.off("data", onData);
		// 同时停止结束时冲刷。
		stream.off("end", onEnd);
	};
}
