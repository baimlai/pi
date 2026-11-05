// 验证 JSON part 与带二进制段的 payload：编码、还原、非法输入和原型安全边界。
import { describe, expect, it } from "vitest";
import { isChordError } from "../../src/data/index.ts";
import { jsonPart, parsePart, parsePayload, payloadPart, resolveSegments } from "../../src/link/values.ts";

// 登记普通 JSON 部分的出站文本与入站解析测试；没有网络传输。
describe("parts", () => {
	// 验证对象转文本、undefined 的 null 形式及两种入站形式；无参数、无外部副作用。
	// 例如 {a:1} 的文本解析后应还原字段 a；比较的是具体样本而非所有 JSON 值。
	it("are JSON text at their origin, parsed from text or from UTF-8 bytes where they are owned", () => {
		// 检查对象和数组被序列化为紧凑 JSON 文本。
		expect(jsonPart({ a: [1, "x"] })).toBe('{"a":[1,"x"]}');
		// 顶层 undefined 原生 stringify 没有结果，这个协议助手统一返回文本 null。
		expect(jsonPart(undefined)).toBe("null");
		// 直接解析字符串形式的 part，再深度比较对象。
		expect(parsePart('{"a":1}')).toEqual({ a: 1 });
		// 先用 UTF-8 编码器产生字节，再检验含 é 的文本能被严格解码和 JSON 解析。
		expect(parsePart(new TextEncoder().encode('{"a":"\u00e9"}'))).toEqual({ a: "\u00e9" });
	});

	// 分别喂不完整 JSON 和非法 UTF-8，要求解析器同步抛错。
	// 回调无返回值；例如单个左花括号不能构成完整对象；本测试不操作 host 或断言链路关闭。
	it("that are no strict UTF-8 JSON throw (a protocol error where they are parsed)", () => {
		// 延迟调用让 toThrow 捕捉 JSON 语法异常。
		expect(() => parsePart("{")).toThrow();
		// 双引号之间放非法字节 255，检验严格 UTF-8 解码器不会默默替换坏字节。
		expect(() => parsePart(new Uint8Array([0x22, 0xff, 0x22]))).toThrow();
	});
});

// 登记方法参数/结果携带原始二进制段的协议测试。
describe("payloads", () => {
	// 输入含主图片与两张缩略图的对象，检查标记索引、段顺序及引用身份。
	// 无外部副作用；实际例子 data 为第 0 段，thumbs 为第 1、2 段，解码不复制这些数组。
	it("marked as carrying bytes write each byte leaf as a segment referenced by {$bytes: i}", () => {
		// 创建 1024 字节主数据并把每字节填为 7。
		const data = new Uint8Array(1024).fill(7);
		// 创建两个长度不同的缩略图数组，以便验证遍历顺序。
		const thumbs = [new Uint8Array([1, 2]), new Uint8Array([3])];
		// true 启用二进制处理；对象简写沿用变量名作键，解构取出文本和段列表。
		const { json, segments } = payloadPart({ name: "chart.png", data, thumbs }, true);
		// 对比全部 JSON 文本，要求每个字节叶子替换成对应数字索引标记。
		expect(json).toBe('{"name":"chart.png","data":{"$bytes":0},"thumbs":[{"$bytes":1},{"$bytes":2}]}');
		// 展开缩略图列表，深度比较三段的内容和排列。
		expect(segments).toEqual([data, ...thumbs]);
		// ! 只消除 TypeScript 的可能 undefined；toBe 用 === 验证首段复用原对象。
		expect(segments![0]).toBe(data);
		// 还原标记；as 只是本测试的类型断言，不会新增运行时形状校验。
		const read = parsePayload(json, segments) as { data: Uint8Array; thumbs: Uint8Array[] };
		// 检查解码后的 data 仍是同一字节数组。
		expect(read.data).toBe(data);
		// 检查嵌套数组内的两段数据均被正确还原。
		expect(read.thumbs).toEqual(thumbs);
	});

	// 使用 Node Buffer 子类验证编码器仍识别原始字节。
	// 输入三字节 Buffer，分别嵌套和放在根部；无 I/O，返回结果由断言观察。
	it("carry any Uint8Array subclass as bytes: a Node Buffer, whose toJSON the replacer never sees (slice 11)", () => {
		// 创建 Buffer，它继承 Uint8Array 且自带 toJSON。
		const buffer = Buffer.from([1, 2, 3]);
		// 同一 Buffer 出现两次，每次出现都形成一个段索引。
		const { json, segments } = payloadPart({ bytes: buffer, at: [buffer] }, true);
		// 要求 Buffer 没变成它默认 toJSON 生成的 type/data 对象。
		expect(json).toBe('{"bytes":{"$bytes":0},"at":[{"$bytes":1}]}');
		// 比较对象身份，确认段保留原 Buffer。
		expect(segments![0]).toBe(buffer);
		// 另测根值本身就是 Buffer 时也能生成第 0 段。
		expect(payloadPart(buffer, true)).toEqual({ json: '{"$bytes":0}', segments: [buffer] });
	});

	// 用户数据含 $bytes 时，与协议标记冲突，启用 bytes 模式必须拒绝。
	// 本例捕捉错误再检查 invalid/args；只影响局部变量，不发送真实调用。
	it("marked as carrying bytes refuse the reserved key $bytes with invalid/args", () => {
		// 用 unknown 保存任意 JavaScript 抛值，读取字段前需收窄类型。
		let thrown: unknown;
		// 尝试执行预期失败的编码，catch 将错误留给后面的断言。
		try {
			// 在普通 meta 内故意放保留键，不能把它误当作可信段引用。
			payloadPart({ meta: { $bytes: 0 }, data: new Uint8Array(1) }, true);
			// 捕捉编码期间的异常；此处不把异常继续抛出。
		} catch (error) {
			// 保存异常供后续同时验证类型和错误原因。
			thrown = error;
		}
		// 类型守卫验证 ChordError/code，&& 短路后才访问 reason，并要求 args。
		expect(isChordError(thrown, "invalid") && thrown.reason).toBe("args");
	});

	// 关闭 bytes 模式时保留键没有特殊含义，undefined 仍序列化成 null。
	// 本例输入 {$bytes:0}，应作为普通对象往返；没有段列表，也没有外部副作用。
	it("not marked are plain JSON, $bytes included; undefined is null", () => {
		// false 选择普通 JSON 路径，明确不生成二进制段。
		expect(payloadPart({ $bytes: 0 }, false)).toEqual({ json: '{"$bytes":0}', segments: undefined });
		// 检查无返回值的普通 payload 的文本约定。
		expect(payloadPart(undefined, false).json).toBe("null");
		// segments 为 undefined 时不解析标记，因此不会因缺第 0 段而报错。
		expect(parsePayload('{"$bytes":0}', undefined)).toEqual({ $bytes: 0 });
	});

	// 参数化测试以三种坏标记逐次调用下面的回调；%s 用每行描述命名用例。
	// 输入为描述与 value；预期在递归还原时抛错，例如只有一段时索引 1 越界。
	it.each([
		// 给定段列表只有索引 0，此索引无法解析。
		["an index past the segments", { $bytes: 1 }],
		// 用字符串 "0" 检验索引必须是数字；此样本没有覆盖小数。
		["a non-integer index", { $bytes: "0" }],
		// 段标记必须独占对象，不能混入 x 字段。
		["other keys next to $bytes", { $bytes: 0, x: 1 }],
		// _ 接收但不使用描述，value 是本轮坏标记；回调无业务返回和外部副作用。
	])("refuse a malformed reference: %s", (_, value) => {
		// 把标记嵌在对象内数组中，要求递归路径也能识别并拒绝错误标记。
		expect(() => resolveSegments({ a: [value] }, [new Uint8Array(1)])).toThrow(
			// 检查抛错文本属于段引用格式错误。
			"payload: a malformed byte segment reference",
		);
	});

	// 通过 JSON 构造同名 __proto__ 自有键，验证还原段时不改对象原型。
	// 本例解析得到的属性应是一字节数组；只修改本测试拥有的新解码对象。
	it("define a resolved key __proto__ as an own property", () => {
		// JSON.parse 与对象字面量的 __proto__ 规则不同，这里产生真正的自有数据属性。
		const parsed = JSON.parse('{"__proto__":{"$bytes":0}}');
		// 把第 0 段写回该键；as object 只向开发工具声明类型。
		const resolved = resolveSegments(parsed, [new Uint8Array(1)]) as object;
		// 要求原型仍是普通对象原型，没有被二进制数组替换。
		expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
		// 读取自有属性描述符；?. 允许属性不存在时得到 undefined，断言仍会失败。
		expect(Object.getOwnPropertyDescriptor(resolved, "__proto__")?.value).toEqual(new Uint8Array(1));
	});
});
