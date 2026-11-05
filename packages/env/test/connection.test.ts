// 用受控 Node 假 daemon 检查启动诊断、UTF-8 流边界、重试和 ready 后进程退出；模板源码保持原样。
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Connection, isConnectionLost, RemoteError } from "../src/connection.ts";

// 静态类型 Connection[] 表示待清理的连接列表；列表里既有启动失败连接，也有可正常握手的假 daemon 连接。
const connections: Connection[] = [];
// 测试组结束时回调逐个 close，释放本文件启动的 Node 子进程和心跳；不会清理别的测试文件资源。
afterAll(() => {
	// for...of 按数组项关闭；close 同步发终止，不在此等待每个系统进程的 close 事件。
	for (const connection of connections) connection.close();
});

/** A connection whose "daemon" is a Node script; the script receives `serve --token <hex>` as its arguments. */
// 用 Node -e 脚本构造惰性 Connection，登记清理后返回。script 可为字符串或每次启动重新调用的同步工厂，onLog 可省；例如 connect(failing("denied")) 模拟启动失败，不连 SSH。
function connect(script: string | (() => string), onLog?: (text: string) => void): Connection {
	// 构造只保存选项；真正子进程启动在 info/request 首次使用时。
	const connection = new Connection({
		// 每次启动返回 [Node路径,-e,脚本]；typeof 缩小字符串/函数联合，函数在重连时可给不同脚本，Connection 还会追加 serve --token 参数。
		command: async () => [process.execPath, "-e", typeof script === "string" ? script : script()],
		// 对象展开在没传 onLog 时不创建该字段；传了就保留同一函数接收原始 stderr。
		...(onLog === undefined ? {} : { onLog }),
	});
	// 记入共享清理账本，避免失败测试留下本文件启动的子进程。
	connections.push(connection);
	// 返回可供调用的同一个连接实例，不等于握手完成。
	return connection;
}

/** A script that writes `stderr` and exits with `code` once the write is flushed. */
// 返回会写 stderr 后退出的 JavaScript 源码字符串，不在本函数执行它。stderr 用 JSON.stringify 安全嵌入，code 缺省 1；例如 failing("bad",7) 稍后退出码为 7。
function failing(stderr: string, code = 1): string {
	// 生成单行脚本：等 stderr.write 回调再 process.exit，避免测试只看见退出却没收完诊断；脚本正文保持原样。
	return `process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(${code}));`;
}

// 触发 info 并把预期的启动 Error 作为成功返回值收集；若成功或抛出非 Error 则让用例失败。返回 Promise<Error>，会启动对应假 daemon，例如错误诊断断言先 await 此函数。
async function startError(connection: Connection): Promise<Error> {
	// try 捕获 info 的拒绝；它只覆盖握手触发，不替代测试框架的断言。
	try {
		// 等待握手；测试中假脚本会退出或拒绝 hello，正常得到 info 会继续到最后的显式失败。
		// 先确认 ready，再开始计时，排除启动耗时。
		await connection.info();
		// catch 的 error 是 unknown，JavaScript 可以抛任意值，需实际检查后才能按 Error 返回。
	} catch (error) {
		// 只把 Error 实例视作此辅助函数支持的预期错误，instanceof 在运行时判断，不是类型断言。
		if (error instanceof Error) return error;
		// 非 Error 原样再抛，防把未知抛值当成符合断言的错误。
		throw error;
	}
	// info 意外成功也必须失败，否则错误断言可能被跳过。
	throw new Error("The start did not fail");
}

/**
 * Speaks the daemon's sync line and framing. `hello` gets `helloReply` (a result, or an error frame). The next request
 * makes it exit while a process it started keeps stdout and stderr open for a few seconds.
 */
// 按 helloReply 生成协议假 daemon 源码；不执行真实 daemon。脚本写 token 同步行，缓存 stdin 完整帧，只处理 REQUEST，首个 hello 返回结果或 EINVAL，后续请求启动占管道 3 秒的子进程后立即退出。
function fakeDaemon(helloReply: "result" | "error"): string {
	// 以下模板仅构造稍后交 Node -e 的源码，不插入中文到模板正文；frame 将 JSON 编码为 13 字节大端头+UTF-8正文，id 原样回传。
	// 脚本先处理 hello；拒绝帧保留 code/message/path/extra。成功分支后下次请求不回结果而退出，继承 stdout/stderr 的子孙通过 unref 保留管道，专门区分 exit 与 close 事件时机。
	return `
const { spawn } = require("node:child_process");
const token = process.argv[process.argv.indexOf("--token") + 1];
process.stdout.write("PI-ENV " + token + "\\n");
function frame(type, id, json) {
	const body = Buffer.from(JSON.stringify(json));
	const header = Buffer.alloc(13);
	header.writeUInt32BE(9 + body.length, 0);
	header.writeUInt8(type, 4);
	header.writeUInt32BE(id, 5);
	header.writeUInt32BE(body.length, 9);
	return Buffer.concat([header, body]);
}
let buffered = Buffer.alloc(0);
let requests = 0;
process.stdin.on("data", (chunk) => {
	buffered = Buffer.concat([buffered, chunk]);
	while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
		const length = buffered.readUInt32BE(0);
		const type = buffered.readUInt8(4);
		const id = buffered.readUInt32BE(5);
		buffered = buffered.subarray(4 + length);
		if (type !== 1) continue;
		if (++requests === 1) {
			const info = { protocol: 1, version: "test", os: "linux", arch: "x86_64", home: "/", tmpdir: "/tmp",
				separator: "/", cwd: "/", driveCwds: {}, pid: process.pid };
			const refusal = { code: "EINVAL", message: "hello refused", path: "/daemon", extra: 1 };
			process.stdout.write(${JSON.stringify(helloReply)} === "result" ? frame(2, id, info) : frame(3, id, refusal));
			continue;
		}
		spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: ["ignore", "inherit", "inherit"] }).unref();
		process.exit(0);
	}
});
`;
}

// 注册启动失败测试：无外部网络，只有受控 Node 子进程、内存字符串和一例自建临时目录。describe 回调在收集阶段注册用例，异步 it 回调稍后才执行。
describe("Connection start failures", () => {
	// 例：假 SSH 文字和退出码 255 应进入 lost 错误摘要；这里只写模拟诊断，没有实际 SSH。
	it("includes the end of stderr when the daemon exits before it is ready", async () => {
		// 写 Permission denied 后退出，等待收集实际启动错误。
		// 假脚本只写 x 和两枚不完整前导字节后退出 7；日志回调仍按块入账。
		const error = await startError(connect(failing("ssh: Permission denied (publickey).\n", 255)));
		// 断言错误明确带连接丢失标记；不能只根据 code=unknown 推断。
		expect(isConnectionLost(error)).toBe(true);
		// 精确比对诊断文字，包括换行、stderr 标题和被清理后的内容。
		expect(error.message).toBe(
			// 期望值同时约束退出码、清理后的 stderr 和行尾；这不是运行中的 shell 命令。
			"pi-env exited with code 255 before it was ready\nremote stderr:\nssh: Permission denied (publickey).",
		);
	});

	// 例：没有 stderr 或只有空白/控制符时，只留退出错误，不凭空加 remote stderr 标题。
	it("keeps the message unchanged when the daemon wrote nothing printable to stderr", async () => {
		// 每次 connect 创建独立假进程；括号先等启动失败再取 message，避免把 Promise 本身作断言。
		expect((await startError(connect("process.exit(3);"))).message).toBe(
			// 期望值同时约束退出码、清理后的 stderr 和行尾；这不是运行中的 shell 命令。
			"pi-env exited with code 3 before it was ready",
		);
		// 每次 connect 创建独立假进程；括号先等启动失败再取 message，避免把 Promise 本身作断言。
		expect((await startError(connect(failing(" \n\u0007\u001b[0m\n", 3)))).message).toBe(
			// 期望值同时约束退出码、清理后的 stderr 和行尾；这不是运行中的 shell 命令。
			"pi-env exited with code 3 before it was ready",
		);
	});

	// 例：含颜色转义、CRLF、C0/C1 与 Unicode 的诊断，应只清控制信息并保留正文。
	it("drops terminal escapes and C0 and C1 control characters, keeping other text", async () => {
		// 构造输入诊断；转义写法代表真实控制字符，字符串内容保持不变。
		const stderr =
			"\u001b[31mred\u001b[0m\r\nbell\u0007 del\u007f\tc1:\u0085\u009d end\nÜberprüfung fehlgeschlagen ✗\n\n";
		// 让子进程写完整输入，收 Connection 实际生成的摘要。
		// 假脚本只写 x 和两枚不完整前导字节后退出 7；日志回调仍按块入账。
		const error = await startError(connect(failing(stderr)));
		// 精确比对诊断文字，包括换行、stderr 标题和被清理后的内容。
		expect(error.message).toBe(
			// 期望值同时约束退出码、清理后的 stderr 和行尾；这不是运行中的 shell 命令。
			"pi-env exited with code 1 before it was ready\nremote stderr:\nred\nbell del\tc1: end\nÜberprüfung fehlgeschlagen ✗",
		);
	});

	// 生成 30 行只保留最后 20 行；此例说明行数上限，不证明任意长度输入的所有裁剪组合。
	it("keeps only the last 20 lines of stderr", async () => {
		// Array.from 的回调接下标 0..29，生成 line 0 到 line 29；_ 表示首个参数未使用。
		const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
		// join 用 LF 拼行，末尾再补 LF，走实际 stderr 流。
		// 假脚本只写 x 和两枚不完整前导字节后退出 7；日志回调仍按块入账。
		const error = await startError(connect(failing(`${lines.join("\n")}\n`)));
		// 精确比对诊断文字，包括换行、stderr 标题和被清理后的内容。
		expect(error.message).toBe(
			// 模板计算期望最后十行被裁掉后的文字；slice(10) 留索引 10..29，不改原数组。
			`pi-env exited with code 1 before it was ready\nremote stderr:\n${lines.slice(10).join("\n")}`,
		);
	});

	// 生成 30 行只保留最后 20 行；此例说明行数上限，不证明任意长度输入的所有裁剪组合。
	// 用 5000 个 x 触发先裁末 2000 UTF-16 码元再去末尾 LF；最终 x 数量应为 1999。
	it("keeps only the last 2000 characters of stderr", async () => {
		// 首行应被长正文顶出保留尾部，避免测试只覆盖短 stderr。
		// 假脚本只写 x 和两枚不完整前导字节后退出 7；日志回调仍按块入账。
		const error = await startError(connect(failing(`first\n${"x".repeat(5000)}\n`)));
		// 以标题切出尾部；索引不存在时 ?? 回空串，让后续断言明确失败而非取 undefined。
		const tail = error.message.split("\nremote stderr:\n")[1] ?? "";
		// 1999 个 x 加输入末尾 LF 曾占 2000 码元，摘要去行尾后剩这个长度。
		expect(tail).toBe("x".repeat(1999));
	});

	// 原 onLog 日志应完整保留颜色序列；错误摘要的过滤不能顺便改回调输入。
	it("passes stderr to onLog unchanged", async () => {
		// 回调每次收到的文字块按顺序存数组；string[] 仅为 TS 静态元素类型。
		const logged: string[] = [];
		// onLog 箭头回调把原始 text push 到数组；push 返回长度，但 void 回调调用方忽略该值。
		await startError(connect(failing("\u001b[31mred\u001b[0m\n"), (text) => logged.push(text)));
		// 拼各块而非假设一次 data 事件，精确比对原始或替换字符后的完整流。
		expect(logged.join("")).toBe("\u001b[31mred\u001b[0m\n");
	});

	// #10716: acknowledge the first stderr read before writing the remaining UTF-8 bytes.
	// 表驱动回调对 é、错、emoji 各跑一次；刻意跨 stderr chunk 拆 UTF-8，验证 StringDecoder 跨块保留。
	it.each(["\u00e9", "\u9519", "\u{1f600}"])("decodes %s split across stderr chunks", async (character) => {
		// 为一次表驱动用例创建唯一临时目录，用确认文件同步父子进程，避免依赖任意固定延时。
		const directory = mkdtempSync(join(tmpdir(), "pi-env-stderr-"));
		// 此路径是本用例确认文件，子进程只轮询它，不读用户文件。
		const acknowledged = join(directory, "logged");
		// 构造输入诊断；转义写法代表真实控制字符，字符串内容保持不变。
		const stderr = `prefix ${character} suffix\n`;
		// 默认按 UTF-8 得到完整字节，中文和 emoji 各占多个字节。
		const bytes = Buffer.from(stderr);
		// 在 prefix 之后只取字符的第一个字节，确保这个多字节字符跨两次写入。
		const split = Buffer.byteLength("prefix ") + 1;
		// 回调每次收到的文字块按顺序存数组；string[] 仅为 TS 静态元素类型。
		const logged: string[] = [];
		// 生成受控子脚本：先写 prefix 加首字节，轮询确认文件后写余下字节并退出 7；3 秒保险超时会以 99 暴露同步失败。
		const connection = connect(
			`
const { existsSync } = require("node:fs");
const bytes = Buffer.from(${JSON.stringify([...bytes])});
const timeout = setTimeout(() => process.exit(99), 3000);
process.stderr.write(bytes.subarray(0, ${split}));
const poll = setInterval(() => {
	if (!existsSync(${JSON.stringify(acknowledged)})) return;
	clearInterval(poll);
	clearTimeout(timeout);
	process.stderr.write(bytes.subarray(${split}), () => process.exit(7));
}, 5);
`,
			// onLog 收到首个可解码文本就记录并写确认文件；它是本地测试同步信号，不修改 stderr 数据。
			(text) => {
				// 保存当前文字块，后面要求至少两次通知并完整重组。
				logged.push(text);
				// 仅首次通知创建确认文件，让子进程可以发送剩余 UTF-8 字节；存在检查不是并发原子锁。
				if (!existsSync(acknowledged)) writeFileSync(acknowledged, "");
			},
		);
		// 确认文件测试无论断言成功或失败都进入 finally 清理。
		try {
			// 等待子进程 7 或保险超时 99 的启动失败，实际退出码参与后续精确消息断言。
			const error = await startError(connection);
			// 至少两个回调证明不是一次性收全后才解码；此断言配合确认文件强制分批。
			expect(logged.length).toBeGreaterThanOrEqual(2);
			// 把各回调文本还原成原始字符串，检查多字节字符没有损坏或重复。
			expect(logged.join("")).toBe(stderr);
			// 精确包含退出码 7 和去末尾换行后的原正文。
			expect(error.message).toBe(
				`pi-env exited with code 7 before it was ready\nremote stderr:\n${stderr.trimEnd()}`,
			);
			// 测试抛错也关闭连接并删除本用例目录，不把临时确认文件留给其他运行。
		} finally {
			// 同步请求关闭本例假 daemon，后续共享 afterAll 再 close 也允许。
			connection.close();
			// 递归强制删除唯一临时目录。
			rmSync(directory, { recursive: true, force: true });
		}
	});

	// 例：stderr 在 emoji 的 UTF-8 字节只到一半就结束，应冲刷一个 U+FFFD 替换字符。
	it("flushes an incomplete UTF-8 character when stderr ends", async () => {
		// 回调每次收到的文字块按顺序存数组；string[] 仅为 TS 静态元素类型。
		const logged: string[] = [];
		// 假脚本只写 x 和两枚不完整前导字节后退出 7；日志回调仍按块入账。
		const error = await startError(
			// 输入字节 [0x78,0xf0,0x9f] 不能组成完整 emoji；回调本行返回 push 长度但 API 忽略它。
			connect("process.stderr.write(Buffer.from([0x78, 0xf0, 0x9f]), () => process.exit(7));", (text) =>
				// 记录 stderr 解码器在结束时吐出的文本，包括末尾替换字符。
				logged.push(text),
			),
		);
		// 拼各块而非假设一次 data 事件，精确比对原始或替换字符后的完整流。
		expect(logged.join("")).toBe("x\uFFFD");
		// 精确比对诊断文字，包括换行、stderr 标题和被清理后的内容。
		expect(error.message).toBe("pi-env exited with code 7 before it was ready\nremote stderr:\nx\uFFFD");
	});

	// 命令工厂每次返回不同诊断，两次失败间 Connection 应清旧尾部，例 failure 2 不带 failure 1。
	it("reports only the stderr of the attempt that failed", async () => {
		// 可变计数由命令工厂闭包捕获；这里只记录启动尝试次数。
		let attempt = 0;
		// 生成受控子脚本：先写 prefix 加首字节，轮询确认文件后写余下字节并退出 7；3 秒保险超时会以 99 暴露同步失败。
		// 每次重新准备脚本时 ++attempt 先递增后插入诊断，验证失败后下次请求重试。
		const connection = connect(() => failing(`failure ${++attempt}\n`));
		// 第一次调用应从 failure 1 启动得到错误。
		expect((await startError(connection)).message).toContain("failure 1");
		// 同一个连接在失败后再次 info，触发第二次 Node 子进程启动。
		const second = await startError(connection);
		// 第二次摘要必须包含这次工厂的文本。
		expect(second.message).toContain("failure 2");
		// 还必须明确排除第一次残留，单查新文本不足以证明尾部已清理。
		expect(second.message).not.toContain("failure 1");
	});

	// hello 的正常 ERROR 不是丢线：两次尝试都保 code/path/额外字段，防启动失败包装抹掉业务错误。
	it("keeps the fields of a hello the daemon refused", async () => {
		// 生成受控子脚本：先写 prefix 加首字节，轮询确认文件后写余下字节并退出 7；3 秒保险超时会以 99 暴露同步失败。
		// 选择返回 hello EINVAL 的协议脚本，不会进入后续占管道子进程分支。
		const connection = connect(fakeDaemon("error"));
		// 两次在同一连接上触发启动失败，覆盖清理后重试。
		for (let attempt = 0; attempt < 2; attempt++) {
			// 等待子进程 7 或保险超时 99 的启动失败，实际退出码参与后续精确消息断言。
			const error = await startError(connection);
			// 真实运行检查错误类后，TS 才允许访问 RemoteError 专属字段；不符合则重新抛出失败。
			if (!(error instanceof RemoteError)) throw error;
			// 保持 daemon 的 EINVAL，而非统一替换为连接 lost。
			expect(error.code).toBe("EINVAL");
			// 保持 daemon 回的 /daemon 路径。
			expect(error.path).toBe("/daemon");
			// 额外 JSON 字段 extra=1 也应保留，不只测试构造器摘出的字段。
			expect(error.fields.extra).toBe(1);
			// 允许启动包装附加诊断，因此只要求 hello refused 前缀。
			expect(error.message.startsWith("hello refused")).toBe(true);
			// 业务拒绝不得被标记成失联，调用者可能据此决定是否重连。
			expect(isConnectionLost(error)).toBe(false);
		}
	});

	// 指定必不存在的程序，验证本机 spawn 失败而非 hello 拒绝；无网络。
	it("reports a daemon that cannot be started as a spawn error", async () => {
		// 惰性连接尚未启动，startError 才触发该无效路径。
		const connection = new Connection({ command: ["/nonexistent/pi-env"] });
		// 此例没经过 connect 助手，也必须登记统一清理。
		connections.push(connection);
		// 假脚本只写 x 和两枚不完整前导字节后退出 7；日志回调仍按块入账。
		// 等待实际错误；后面用 instanceof 确认可读取 RemoteError.code。
		const error = await startError(connection);
		// error 是 Error 但未必是 RemoteError，运行判断后才读专属字段。
		if (!(error instanceof RemoteError)) throw error;
		// 无法启动本机程序应是 spawn_error，不是远端返回 EINVAL。
		expect(error.code).toBe("spawn_error");
		// 断言错误明确带连接丢失标记；不能只根据 code=unknown 推断。
		expect(isConnectionLost(error)).toBe(true);
	});
});

// 注册握手完成后的退出测试；区别于前一组，ready 后应观察 exit 立即失败而非等 pipe close。
describe("Connection of a ready daemon", () => {
	// 例：假 daemon 第二次请求即退出，但其子孙占 stdout/stderr 3 秒；请求应在 2 秒内失败。此计时有宽松阈值，不保证实时调度。
	it("fails pending requests as soon as the daemon exits, even while its pipes stay open", async () => {
		// 生成受控子脚本：先写 prefix 加首字节，轮询确认文件后写余下字节并退出 7；3 秒保险超时会以 99 暴露同步失败。
		// 选择成功 hello 的脚本，后面的 lstat 才触发退出与占管道子孙。
		const connection = connect(fakeDaemon("result"));
		// 等待握手；测试中假脚本会退出或拒绝 hello，正常得到 info 会继续到最后的显式失败。
		// 先确认 ready，再开始计时，排除启动耗时。
		await connection.info();
		// 记录墙钟毫秒，用于比较失败耗时；系统时钟跳变也会影响结果。
		const started = Date.now();
		// 把成功映成 undefined、拒绝映成原抛值，便于下面统一用 Error 断言而不漏测意外成功。
		const outcome = await connection.request("lstat", { path: "/" }).then(
			// 若 lstat 意外成功，返回 undefined，下面显式报 The request did not fail。
			() => undefined,
			// 错误可为任意值，先作为 unknown 返回，不强行 as Error。
			(error: unknown) => error,
		);
		// 用运行检查排除意外成功和非 Error 抛值。
		if (!(outcome instanceof Error)) throw new Error("The request did not fail");
		// ready 后直接退出应使在途请求失败且标记 lost。
		expect(isConnectionLost(outcome)).toBe(true);
		// 摘要只应是固定连接丢失信息，启动前退出的特殊错误不能误用在这里。
		expect(outcome.message).toBe("pi-env connection lost");
		// The process the daemon started holds its pipes for 3 s; the request must not wait for them.
		// 2 秒阈值小于子孙占管道 3 秒，证明失败不等待其 stdout/stderr 关闭。
		expect(Date.now() - started).toBeLessThan(2000);
	});
});
