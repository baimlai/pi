// Tests of the JSONL archive encoding (slice 6a §13): parts as lines, chunks split anywhere (inside a line, inside a
// UTF-8 sequence), blank lines, and the refusal of a line that is no JSON.

import { describe, expect, it } from "vitest";
import type { ArchivePart } from "../../src/store/archive.ts";
import { decodeJsonl, encodeJsonl } from "../../src/store/jsonl.ts";
import { rejection } from "../support.ts";

// 将只读数组包装成异步可迭代输入，不复制数组元素；例如 from([1,2]) 依次产出 1、2。
// <T> 是泛型，保留元素类型；async function* 返回迭代器，yield* 委托给数组的迭代过程。
async function* from<T>(values: readonly T[]): AsyncIterable<T> {
	// 异步消费者仍可接收同步数组的元素；调用 from 本身尚未消费它。
	yield* values;
}

// 消费异步序列并按顺序收集成数组，例如 collect(from([1,2])) 得到 Promise<[1,2]>。
// T[] 是可追加数组；输入迭代器抛错会让本函数的 Promise 拒绝，不在这里吞掉。
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
	// 新数组只收集元素引用，不深拷贝归档片段。
	const all: T[] = [];
	// for await 等待每个 next()，全部读完才向调用方返回。
	for await (const value of values) all.push(value);
	// return 在 async 函数中成为 Promise 的完成值。
	return all;
}

// ArchivePart[] 在开发时限制片段形状；这个测试数据还特意含多字节 UTF-8 字符。
const PARTS: ArchivePart[] = [
	{ kind: "manifest", format: 1, schema: 1, lastSeq: 3, nextId: 2 },
	{ kind: "put", table: "app.store:edits", row: { id: "ü€😀", n: 1 }, version: 1, columns: {} },
	{ kind: "end", writes: 1 },
];

// JSONL 是“一行一个 JSON 值”；本组只验证编解码，导入格式的完整校验不在 decodeJsonl 内。
describe("jsonl", () => {
	// 将三片归档编码后，用多种块大小重新切割并解码；结果应相同，无磁盘或网络副作用。
	// 示例中 size=1 会把 €、表情字符拆成多个字节，测试流式解码会保留不完整字符。
	it("encodes one part per line and decodes it back, from chunks split anywhere", async () => {
		// collect 等待编码完成，Buffer.concat 按原顺序合并编码器产出的字节块。
		const bytes = Buffer.concat(await collect(encodeJsonl(from(PARTS))));
		// 每个 part 后都有换行，split 会多留下最后一个空字符串。
		expect(bytes.toString("utf8").split("\n")).toHaveLength(PARTS.length + 1);
		// 同一字节串分别按 1/2/3/7 字节与整块输入，覆盖跨行、跨字符的分块情况。
		for (const size of [1, 2, 3, 7, bytes.length]) {
			// Uint8Array[] 保存每次切割结果；Buffer 也能作为 Uint8Array 使用。
			const chunks: Uint8Array[] = [];
			// subarray 是原缓冲区上的视图；末块不够 size 时自动截到末尾。
			for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
			// toEqual 比较解码后的数据内容，不要求与 PARTS 保持对象引用相同。
			expect(await collect(decodeJsonl(from(chunks)))).toEqual(PARTS);
		}
	});

	// 人工构造首行、间隔空行和无结尾换行的输入；解码只产出两片原数据。
	// 示例把 manifest 和 end 放在一起，仅证明 JSONL 行规则，不证明该归档能成功导入。
	it("skips blank lines and takes a last line without a newline", async () => {
		// 模板字符串插入 JSON.stringify 的结果；保留的 \n 是被测输入的一部分。
		const text = `\n${JSON.stringify(PARTS[0])}\n\n${JSON.stringify(PARTS[2])}`;
		// TextEncoder 转 UTF-8；所有空行被跳过，末行在输入结束时仍被解析。
		expect(await collect(decodeJsonl(from([new TextEncoder().encode(text)])))).toEqual([PARTS[0], PARTS[2]]);
	});

	// 第二行故意使用非法 JSON；消费序列时应拒绝并指出 line 2，返回 Promise<void>。
	// rejection 将 ChordError 转成 JSON，便于只比对 code/reason/message 这些公开字段。
	it("refuses a line that is no JSON, naming it", async () => {
		// 第一行合法，保证错误定位确实来自下一行的 {nope。
		const text = `${JSON.stringify(PARTS[0])}\n{nope\n`;
		// 必须 collect 才会执行异步生成器的读取逻辑；创建迭代器本身不会报这个错。
		expect(await rejection(collect(decodeJsonl(from([new TextEncoder().encode(text)]))))).toMatchObject({
			code: "invalid",
			reason: "args",
			message: "jsonl: line 2 is not JSON",
		});
	});

	// 直接输入含无效 UTF-8 字节 0xff 的首行，验证字节解码错误与 JSON 语法错误分开报告。
	// 此例不做文本修复，预期 decoder 的 fatal 模式使异步消费拒绝。
	it("refuses bytes that are no UTF-8", async () => {
		// 0x7b 是 {，0x0a 是换行；只匹配相关错误字段，不要求完整错误对象相等。
		expect(await rejection(collect(decodeJsonl(from([new Uint8Array([0x7b, 0xff, 0x0a])]))))).toMatchObject({
			code: "invalid",
			message: "jsonl: line 1 is not UTF-8",
		});
	});
});
