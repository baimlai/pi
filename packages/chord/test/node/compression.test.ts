// Tests of nodeCompression: raw deflate and the bounded inflate with its tagged outcomes, a limit of 0 included.

import { describe, expect, it } from "vitest";
import type { Inflated } from "../../src/link/part.ts";
import { nodeCompression } from "../../src/node/compression.ts";

// TextEncoder 把字符串变成 UTF-8 字节；压缩接口收发字节，不直接收发 JS 对象。
const UTF8 = new TextEncoder();

// 把成功的解压结果转成普通 Uint8Array，便于比较字节内容；失败分支原样返回。
// 参数 Inflated 是按 kind 区分的联合类型，条件成立后 TypeScript 才允许读 bytes。
// 例如 {kind:"bytes",bytes:Buffer.from([1])} 得到 [1]；此辅助函数不执行解压，也不抛出协议错误。
const bytesOf = (inflated: Inflated) => (inflated.kind === "bytes" ? new Uint8Array(inflated.bytes) : inflated);

// 注册压缩测试组；describe/it 的回调由 Vitest 执行，expect 失败会使当前测试失败。
describe("nodeCompression", () => {
	// 用重复文本构造易压缩输入，检查压缩尺寸以及两种解压上限下的往返结果；不保证任意数据都能缩到十分之一。
	it("deflates raw at level 1 and inflates back", () => {
		// JSON.stringify 先生成 JSON 文本，repeat(5000) 只是在内存中制造重复数据，再编码成字节。
		const bytes = UTF8.encode(JSON.stringify({ text: "lorem ipsum ".repeat(5000) }));
		// 调用 Node 同步 raw-deflate 压缩器；返回值是压缩后的字节。
		const deflated = nodeCompression.deflate(bytes);
		// 只对这个高重复样本要求压缩后小于原大小的十分之一。
		expect(deflated.byteLength).toBeLessThan(bytes.byteLength / 10);
		// 把解压上限设为准确原长度，要求成功且逐字节一致。
		expect(bytesOf(nodeCompression.inflate(deflated, bytes.byteLength))).toEqual(bytes);
		// Infinity 表示调用方不再限制尺寸；实现仍受 Node Buffer 最大长度约束。
		expect(bytesOf(nodeCompression.inflate(deflated, Number.POSITIVE_INFINITY))).toEqual(bytes);
	});

	// 制造大解压体积的压缩样本，要求较小上限返回 too_large；本例会在内存创建 256 MiB 零字节。
	it("gives too_large past the limit, without inflating the rest (a bomb)", () => {
		// 先分配零填充数组并压缩；这里的 bomb 指压缩很小、展开很大的测试数据。
		const bomb = nodeCompression.deflate(new Uint8Array(256 * 1024 * 1024));
		// 只准解出 1 MiB，检查受限解压的结果标签，不检查耗时或进程峰值内存。
		expect(nodeCompression.inflate(bomb, 1024 * 1024)).toEqual({ kind: "too_large" });
	});

	// 覆盖上限恰好为 0 和 1 的边界；空内容在零上限成功，任何非空内容在零上限失败。
	it("takes a limit of 0: an empty stream inflates, anything else is too_large (never zlib's range error)", () => {
		// 空流解压不产生字节；toEqual 比较数组内容。下面两行的新 Uint8Array(1/100) 都是非空输入。
		expect(bytesOf(nodeCompression.inflate(nodeCompression.deflate(new Uint8Array(0)), 0))).toEqual(
			new Uint8Array(0),
		);
		// 一个解压字节超过 0，必须返回 too_large，不能把 zlib 参数错误误判为损坏。
		expect(nodeCompression.inflate(nodeCompression.deflate(new Uint8Array(1)), 0)).toEqual({ kind: "too_large" });
		// 更大的非空流也应走同一个超限分支。
		expect(nodeCompression.inflate(nodeCompression.deflate(new Uint8Array(100)), 0)).toEqual({ kind: "too_large" });
		// 上限等于结果长度应成功；下一行给出期望的一个零字节。
		expect(bytesOf(nodeCompression.inflate(nodeCompression.deflate(new Uint8Array(1)), 1))).toEqual(
			new Uint8Array(1),
		);
	});

	// 给出固定的非法 deflate 字节，要求损坏标签；toMatchObject 只匹配 kind，不固定底层 zlib 错误对象。
	it("gives corrupt for data that is no raw deflate stream", () => {
		expect(nodeCompression.inflate(new Uint8Array([255, 1, 2, 3]), 100)).toMatchObject({ kind: "corrupt" });
	});
});
