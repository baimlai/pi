// Compression for Chord v2 hosts on Node (§22, slice 4b): the synchronous compressor `createHost({ compression })`
// takes, over Node's zlib. Node-only, so it lives in `src/node`, outside the portable core (which imports no Node
// module).
// 所属：Chord 的 Node 主机适配层（src/node），实现 link 包的 Compression 接口；不进入可移植核心。
// 职责：用 Node zlib 做原始 deflate/inflate，并把解压超限与损坏输入分类成联合结果。
// 边界：不决定何时压缩（由 originPart 的阈值/策略决定），不关闭连接，不做异步调度。
// 上游：createHost({ compression: nodeCompression }) 注入；下游：node:zlib 的同步 API。
// 导出清单：nodeCompression 常量；deflate(bytes) 返回压缩字节；inflate(bytes, limit) 返回 bytes/too_large/corrupt。
// 组合：发送侧 originPart 超阈值时 deflate；接收侧 part 解压，limit 限制单次内存。
// 示例：const result = nodeCompression.inflate(compressed, 16 * 1024); if (result.kind === "bytes") use(result.bytes);
// 阅读顺序：文件头 → 导入 → nodeCompression.deflate → inflate 成功/超限/损坏分支。

// 别名 buffer 只用于 MAX_LENGTH；这是 Node Buffer 的最大长度常量（随平台/版本变化）。
import { constants as buffer } from "node:buffer";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { Compression } from "../link/index.ts";

/**
 * Raw deflate at level 1 (`deflateRawSync`), and inflate bounded by `maxOutputLength` (`inflateRawSync`): past the
 * limit `too_large`, data that is no raw deflate stream `corrupt`.
 */
// Compression 是 link 层定义的接口；此常量在模块加载时就绪，可安全共享，不带每连接状态。
export const nodeCompression: Compression = {
	// deflate 接收原始字节，同步返回 level: 1 的 raw-deflate 字节；例如重复文本可能变小，但是否采用它由 originPart 判断。
	// level 1 优先速度而非压缩率；raw deflate 不带 zlib 头，双方必须使用同一格式。
	// 同步调用会阻塞事件循环，适合单条链路消息的小块数据；异常（如内存不足）直接抛出。
	deflate: (bytes) => deflateRawSync(bytes, { level: 1 }),
	// inflate 接收压缩字节与解压上限，返回带 kind 的结果；不会把损坏输入作为普通异常抛给调用者。
	// 例如 limit 为 0 时，任何非空解压结果都是 too_large。同步 zlib 会占用当前线程，且会分配输出 Buffer。
	inflate: (bytes, limit) => {
		// 捕获 zlib 对上限或无效压缩流抛出的异常，转换为 Compression 约定的联合类型。
		try {
			// zlib refuses a bound of 0: inflate at most one byte, and one byte is past a limit of 0.
			// Math.min 同时遵守调用者上限和 Node 最大 Buffer 长度；Math.max 处理 zlib 不接受 0 的限制。
			// maxOutputLength 让 zlib 在超过上限时抛错，而不是先分配完整输出；Node 不接受 0，所以至少传 1。
			// 解压后再比较 byteLength 覆盖 limit 远小于 1 或平台边界情况；返回的 Buffer 可直接当 Uint8Array 使用。
			const inflated = inflateRawSync(bytes, { maxOutputLength: Math.max(1, Math.min(limit, buffer.MAX_LENGTH)) });
			// Buffer 也是 Uint8Array；kind 字面量让 TypeScript 在消费结果时区分成功和超限。
			return inflated.byteLength > limit ? { kind: "too_large" } : { kind: "bytes", bytes: inflated };
		} catch (error) {
			// as 只告诉 TypeScript 可以读可选 code，并不验证异常形状；这里只识别 zlib 的输出超限错误码。
			// as 不验证异常形状；只读取可选 code，未知异常仍安全地落到 corrupt。
			if ((error as { readonly code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") return { kind: "too_large" };
			// 其他 zlib 异常保留为 corrupt 的原因，由上层决定如何关闭协议连接。
			return { kind: "corrupt", error };
		}
	},
};
