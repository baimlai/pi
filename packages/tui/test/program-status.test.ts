// 测 OSC7501 程序状态的字符串编码/回复识别，不把报告写真实终端，也不执行文案里的 bash。各 it 无参数、正常返回 void，断言失败抛错。
// equal 比本文件确定类型的数值/字符串，match/doesNotMatch 检模式；消息解码辅助仅供断言，不是外部协议安全验证器。
import assert from "node:assert";
// 注册分组和用例。
import { describe, it } from "node:test";
// 导入真实格式化器/识别器，不做支持性协商。
import { formatProgramStatus, isProgramStatusReply } from "../src/program-status.ts";

// 从 sequence 首个 :msg= 后抓 base64 并转 UTF-8，返回 string|undefined、不改输入；例没有 msg 字段得 undefined。只做测试提取，不验证整份报告或 base64 是否规范。
function decodeMessage(sequence: string): string | undefined {
	// exec 返回匹配对象或 null，?.[1] 安全取第一捕获；* 允许空 base64，但无字段与字段为空不同。
	const message = /:msg=([A-Za-z0-9+/=]*)/.exec(sequence)?.[1];
	// 三元先区分缺字段，再 Buffer.from 解码/toString；不会把 undefined 传给解码器，空字段可得空串。
	return message === undefined ? undefined : Buffer.from(message, "base64").toString("utf8");
}

// #10607
// #10607 分组检查报告编码细节，报告用 ST 结束而非一行普通 console 文本。
describe("formatProgramStatus", () => {
	// 完整字段例：blocked 才保留 kind，消息 UTF-8 编码后 base64，检查整个字符串。
	it("encodes state, app, kind, and a base64 message", () => {
		// 下面多行实际值/期望值共同属于一次 assert.equal。
		assert.equal(
			// 状态 blocked、程序 pi、等待 permission，文案只是文字，不真的请求权限。
			formatProgramStatus({ state: "blocked", app: "pi", kind: "permission", message: "Allow bash?" }),
			// 模板以独立 Buffer 编码同文案构成期望，字段冒号分隔、ST 结束，无写终端动作。
			`\x1b]7501;state=blocked:app=pi:kind=permission:msg=${Buffer.from("Allow bash?").toString("base64")}\x1b\\`,
		);
		// clear 没其他字段时只生成清除根状态的控制串，不意味着现在真实屏状态已清。
		assert.equal(formatProgramStatus({ state: "clear" }), "\x1b]7501;state=clear\x1b\\");
	});

	// 省略例：非 blocked 的 kind、含空格非法 app、清洗后空白 message 都不输出，整份报告仍保留 working。
	it("omits kind outside blocked, invalid app names, and empty messages", () => {
		// 完整串比较，而不是只寻找某字段不存在。
		assert.equal(
			// 同时提供三类应省字段；空白文案含换行，控制符清空格后 trim 为空。
			formatProgramStatus({ state: "working", app: "my app", kind: "auth", message: " \n " }),
			// 结果只剩 state=working 及外壳。
			"\x1b]7501;state=working\x1b\\",
		);
		// 32 字符 app 位于允许上界，应保留；正则中 {32} 是重复次数。
		assert.match(formatProgramStatus({ state: "idle", app: "a".repeat(32) }), /:app=a{32}\x1b/);
		// 33 字符超上界，结果不能含 app=；不是截成 32 字符继续发送。
		assert.doesNotMatch(formatProgramStatus({ state: "idle", app: "a".repeat(33) }), /app=/);
	});

	// 控制符清洗例：删除整段 ANSI 与只把控制码点变空格不同，后面的 [31m 普通码元仍保留。
	it("replaces control characters, which make terminals discard the report", () => {
		// 构造 LF、ESC、C1 CSI、tab 混合消息；formatter 先替换控制符/trim，再编码。
		const sequence = formatProgramStatus({ state: "error", message: "first\nsecond\x1b[31m\u009bthird\t" });
		// decodeMessage 还原后应为该文本；ESC 被替空格，但后面的 [31m 未整体作为样式码删掉，尾 tab 空白被 trim。
		assert.equal(decodeMessage(sequence), "first second [31m third");
	});

	// UTF-8 限长例：单个 é 编码 2 字节，最多保留 1024 个；这不是按 2048 个 UTF-16 码元硬切，也非字素完整性测试。
	it("cuts long messages at a UTF-8 boundary within the spec limits", () => {
		// 原消息 2000 个 é，约 4000 个 UTF-8 字节，必超 2048 预算。
		const sequence = formatProgramStatus({ state: "working", app: "pi", message: "é".repeat(2000) });
		// ! 是 TS 非空断言，约定 formatter 已有 msg，不执行运行时检查，若实际缺失仍由后续断言暴露。
		const message = decodeMessage(sequence)!;
		// 内容应恰保留 1024 个完整 é，没有半截 UTF-8。
		assert.equal(message, "é".repeat(1024));
		// 默认 Buffer.byteLength 按 UTF-8，消息 <=2048 字节。
		assert.ok(Buffer.byteLength(message) <= 2048);
		// 控制串含 ASCII/base64，因此本样本 sequence.length <=4096 也限制对应 ASCII 字节，但不是一般 Unicode 文本都能以 length 代字节。
		assert.ok(sequence.length <= 4096);
	});
});

// 回复识别组：只认带 ? 的能力回显，不把普通状态报告误当支持回复。
describe("isProgramStatusReply", () => {
	// 接受两种结束符及未来字段例：只查支持的外壳，不解释 version 值。
	it("accepts the query echo with either terminator and future pairs", () => {
		// ST 结尾的 query 回显应 true。
		assert.equal(isProgramStatusReply("\x1b]7501;?\x1b\\"), true);
		// BEL 结尾同样 true。
		assert.equal(isProgramStatusReply("\x1b]7501;?\x07"), true);
		// ? 后多出 version=2 也接受，并不校验未来字段业务含义。
		assert.equal(isProgramStatusReply("\x1b]7501;?version=2\x1b\\"), true);
		// 普通 state=idle 报告不是查询回显，false。
		assert.equal(isProgramStatusReply("\x1b]7501;state=idle\x1b\\"), false);
		// OSC11 是默认背景颜色回复，不是 OSC7501，false。
		assert.equal(isProgramStatusReply("\x1b]11;rgb:0000/0000/0000\x07"), false);
	});
});
