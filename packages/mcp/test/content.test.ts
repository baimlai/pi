// 验证协议内容到模型text/image数组的纯内存转换，无模型请求/链接访问/媒体解码。describe组织用例、it注册断言函数、expect比较实际结果。
import { describe, expect, it } from "vitest";
// ContentBlock是TS联合类型，toLlmContent是实际转换函数；带type项执行JS时擦除，不验证伪造媒体字节。
import { type ContentBlock, toLlmContent } from "../src/index.ts";

// 按转换函数名分组两个同步用例；注册describe不等于立刻发任何I/O。
describe("toLlmContent", () => {
	// 构造七种代表内容，断言顺序与映射文字/图片及元信息丢弃；例：audio变省略说明。函数无参数/返回业务值，断言不符会抛测试错误；没有证明图片/音频数据格式有效或URI可读。
	it("passes text and images through and replaces other blocks with text", () => {
		// 显式ContentBlock[]让TS按每项type标签检查字段，数组是本地测试样本。
		const blocks: ContentBlock[] = [
			// 文本附priority供检查转换只保留正文而不保留annotations。
			{ type: "text", text: "hello", annotations: { priority: 1 } },
			// 图片附_meta供检查输出去元数据；aW1n只是测试字符串，不是完整PNG验证样本。
			{ type: "image", data: "aW1n", mimeType: "image/png", _meta: { x: 1 } },
			// 音频样本供产生占位文字，不在此播放或转写。
			{ type: "audio", data: "YXVk", mimeType: "audio/wav" },
			// 资源链接含file URI和名称，转换只拼文字，不访问文件。
			{ type: "resource_link", uri: "file:///a.txt", name: "a.txt" },
			// 嵌入文本资源把inline作为结果文字，不沿URI读取。
			{ type: "resource", resource: { uri: "file:///b.txt", text: "inline" } },
			// 嵌入image/png二进制字符串供映射为image，未核实实际字节MIME。
			{ type: "resource", resource: { uri: "file:///c.png", mimeType: "image/png", blob: "Yw==" } },
			// 无MIME的二进制资源会走unknown type占位，不把blob发为文字正文。
			{ type: "resource", resource: { uri: "file:///d.bin", blob: "ZA==" } },
		];
		// 直接调用纯转换并toEqual深比较数组/对象值与顺序，不检查引用身份或无修改性。
		expect(toLlmContent({ content: blocks })).toEqual([
			// 文本正文保留，期待对象不再含priority/annotations。
			{ type: "text", text: "hello" },
			// 图片data/mimeType保留，期待对象不再含_meta。
			{ type: "image", data: "aW1n", mimeType: "image/png" },
			// 音频只保留带MIME的固定省略说明，不含音频data。
			{ type: "text", text: "[audio audio/wav omitted]" },
			// 链接转换为name冒号URI的文字，不输出ResourceLink对象。
			{ type: "text", text: "a.txt: file:///a.txt" },
			// 嵌入文本资源只取text字段。
			{ type: "text", text: "inline" },
			// 图片资源的blob变data字段，并使用声明的image/png。
			{ type: "image", data: "Yw==", mimeType: "image/png" },
			// 非图片二进制资源输出URI/unknown type说明，不携带blob。
			{ type: "text", text: "[binary resource file:///d.bin (unknown type) omitted]" },
		]);
	});

	// 断言空content时用结构化值的JSON文本，已有文本块时不额外追加；例：null输出字符串null。无I/O，断言失败抛测试错误；未覆盖循环/BigInt等JSON.stringify失败或任意非法JS输入。
	it("falls back to the structured content as JSON when there are no blocks", () => {
		// #10416: structured content may be any JSON value.
		// 数组结构化值也允许兜底，content空是触发条件，不要求structuredContent是对象。
		expect(toLlmContent({ content: [], structuredContent: [1, 2] })).toEqual([
			// 精确期待JSON.stringify的两空格缩进与换行；源码字符串中的反斜杠n在运行时表示一个换行字符。
			{ type: "text", text: "[\n  1,\n  2\n]" },
		]);
		// null区别于undefined，明确期待一块text:"null"而不是省略结果。
		expect(toLlmContent({ content: [], structuredContent: null })).toEqual([{ type: "text", text: "null" }]);
		// 普通对象也走相同JSON兜底。
		expect(toLlmContent({ content: [], structuredContent: { n: 1 } })).toEqual([
			// 预期对象JSON文字同样用两空格缩进，没有调用模型总结。
			{ type: "text", text: '{\n  "n": 1\n}' },
		]);
		// 同时有文本块和结构化对象时，只保留现有块，不拼第二段JSON。
		expect(toLlmContent({ content: [{ type: "text", text: "n=1" }], structuredContent: { n: 1 } })).toEqual([
			// 预期数组唯一一块n=1，验证优先使用已有content。
			{ type: "text", text: "n=1" },
		]);
	});
});
