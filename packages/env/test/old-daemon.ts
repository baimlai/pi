// 模拟 hello 没有 features 的旧 daemon，供 listFiles/process 能力缺失测试使用。
/**
 * A stand-in for a daemon released before `hello.features`: it answers `hello` without `features` and refuses every
 * other operation as an unknown one, as such a daemon refuses `listFiles`. Started as `node old-daemon.ts serve --token
 * <hex>`.
 */
// 从命令行取 --token 后一项供同步标记使用；这是受控测试夹具，不验证缺项或真正认证客户端。
const token = process.argv[process.argv.indexOf("--token") + 1];
// 先向 stdout 写协议同步行；客户端会跳过它之前的 shell 噪声，再开始按二进制帧读取。
process.stdout.write(`PI-ENV ${token}\n`);

// 发送一条无 payload 的回复帧。输入 type/id 与 JSON 字段，返回 void，会写 stdout；例如 send(3, 2, {code:"EINVAL"}) 回绝第 2 个请求。
function send(type: number, id: number, json: Record<string, unknown>): void {
	// JSON.stringify 序列化后按 UTF-8 转字节；Record<string, unknown> 是 TS 字典约束，不是运行时 JSON schema。
	const body = Buffer.from(JSON.stringify(json), "utf8");
	// 头部共 13 字节：帧长 4、类型 1、请求号 4、JSON 长 4；alloc 先填零。
	const header = Buffer.alloc(13);
	// 大端整数写帧长，不包含开头自己的 4 字节；此夹具没有二进制 payload。
	header.writeUInt32BE(9 + body.length, 0);
	// 偏移 4 写一字节类型，2 为结果、3 为错误。
	header.writeUInt8(type, 4);
	// 偏移 5 写原请求号，客户端据此找到对应 Promise。
	header.writeUInt32BE(id, 5);
	// 偏移 9 写 JSON 的字节长，不是 JavaScript 字符串的字符数。
	header.writeUInt32BE(body.length, 9);
	// 复制拼出连续帧并交 stdout；没有等待背压或写入完成确认。
	process.stdout.write(Buffer.concat([header, body]));
}

// let 允许后面替换缓存；从零字节开始积累 stdin，避免把流的 chunk 当作完整协议帧。
let buffered = Buffer.alloc(0);
// 每次收到 stdin 字节执行回调：积累完整帧、取出 op，hello 给旧版信息，其他操作都回 EINVAL；会修改缓存并写回复。
process.stdin.on("data", (chunk: Buffer) => {
	// 把上次残帧和新 chunk 合并；Buffer 类型标注不会在运行时验证事件数据。
	buffered = Buffer.concat([buffered, chunk]);
	// 至少有 4 字节才能读长度头，并且全帧到齐才进入循环；受控夹具未校验恶意长度上限或最短头长。
	while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
		// 读取不含自身 4 字节的帧长。
		const length = buffered.readUInt32BE(0);
		// 读取 REQUEST/RESULT 等类型，本夹具只处理 REQUEST=1。
		const type = buffered.readUInt8(4);
		// 保存关联请求号，回帧复用它。
		const id = buffered.readUInt32BE(5);
		// 读取 JSON 字节长，后面按这个范围解码。
		const jsonLength = buffered.readUInt32BE(9);
		// subarray 取 JSON 区域、解 UTF-8 后 parse；as {op?:string} 只让 TS 允许读可选 op，未运行 schema 校验，坏 JSON 会抛出。
		const json = JSON.parse(buffered.subarray(13, 13 + jsonLength).toString("utf8")) as { op?: string };
		// 先消费当前整帧，留下后续帧或残帧的视图。
		buffered = buffered.subarray(4 + length);
		// 非请求帧直接 continue，例如客户端 PING 不会得到业务回复。
		if (type !== 1) continue;
		// 只有 hello 分支返回成功信息，特意不带 features，模拟功能发现字段出现前的发布版。
		if (json.op === "hello") {
			// 返回协议 1、模拟 Linux 路径及当前 Node pid；这些是假元数据，不意味着夹具运行在 Linux。
			send(2, id, {
				// 以下字段满足客户端读取握手信息的最小需要，version 固定为旧版；features 故意缺省。
				protocol: 1,
				version: "1.1.0",
				os: "linux",
				arch: "x86_64",
				home: "/",
				separator: "/",
				tmpdir: "/tmp",
				cwd: "/",
				driveCwds: {},
				pid: process.pid,
			});
		} else {
			// 其他 op 回 EINVAL 和 unknown operation 文字；客户端应先看 features，避免把缺能力当一般失败。
			send(3, id, { code: "EINVAL", message: `unknown operation ${json.op}` });
		}
	}
});
// stdin 结束后回调以 0 退出进程，没有额外资源清理；这只用于测试子进程。
process.stdin.on("end", () => process.exit(0));
