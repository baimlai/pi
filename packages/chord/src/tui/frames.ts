// Frames for the terminal (slice 11 §4; fix round 1, Fable L9): the launcher drops a frame over 64 KiB whole (an escape
// it could hide is never written in parts), so the sandbox splits a large write into frames, each cut only between
// escape sequences and never inside a surrogate pair: a first paint of a large true-colour screen arrives whole.
// 中文说明：本文件负责把终端输出切成启动器可接受的帧。上游是 BridgeTerminal.write / SandboxChannel.write；
// 下游是启动器的 pipe 帧协议（单帧上限 64 KiB，这里按 16K 个 UTF-16 码元保守切分）。
// 切点只落在完整字符或完整转义序列之后，因此每一帧单独写出也不会截断控制序列。
// 所属：tui 沙箱侧输出分帧工具，不依赖 Bridge，也不了解终端语义。
// 边界：只在字符串层面切分，不写终端、不校验转义内容；单个超长单元原样独立成帧，由 launcher 丢弃或处理。
// 上游：SandboxChannel.write 调用；下游：SandboxMessage.write → node/tui/pipe.ts 帧协议 → launcher。
// 导出清单：FRAME_UNITS 是一帧的 UTF-16 码元上限；splitFrames 返回安全切分后的帧数组。
// 内部能力：unitEnd 避开代理对中间；sequenceEnd 计算 CSI/OSC/DCS 等 ESC 序列的结束位置。
// 组合：write(data) → splitFrames(data) → 每条帧一次 bridge.send({ kind: "write" })。
// 示例：const frames: string[] = splitFrames(hugeText);
// 阅读顺序：FRAME_UNITS → splitFrames → unitEnd → sequenceEnd。

/** The most UTF-16 units of one frame: at most 3 UTF-8 bytes each, so under the launcher's 64 KiB. */
// 一帧允许的最大 UTF-16 码元数。UTF-8 每单元最多 3 字节，因此一帧最多约 48 KiB，低于启动器 64 KiB 的丢弃线。
export const FRAME_UNITS = 16 * 1024;

/** `data` as frames of at most `FRAME_UNITS` units, cut outside escape sequences (one longer is its own frame). */
// 把 data 切成每帧不超过 FRAME_UNITS 个码元的数组；单个字符/转义序列本身超长时独占一帧。
// 输入为空或未超限时返回单元素数组（保留空字符串），调用方照常发送一条 write。
// 例如 20K 个普通字符会分成 ~16K 与剩余两帧；若第 16K 个位置位于 ESC 序列中，则等序列结束再切。
export function splitFrames(data: string): string[] {
	// length 是 UTF-16 码元数，不是 Unicode 字符数；代理对算两个单元，与 FRAME_UNITS 口径一致。
	if (data.length <= FRAME_UNITS) return [data];
	const frames: string[] = [];
	// start 当前帧起点；safe 最近一个可切位置；index 正在扫描的码元位置。
	let start = 0;
	// The last place a frame may end: after a character or a whole sequence, never inside one.
	let safe = 0;
	let index = 0;
	while (index < data.length) {
		// 27 是 ESC；转义序列整体算一个“单元”，其他字符按码点（代理对算一对）前进。
		const end = data.charCodeAt(index) === 27 ? sequenceEnd(data, index) : unitEnd(data, index);
		// 加入下一单元会超过上限时，在最近的 safe 处切；safe === start 表示单单元就超长，留给最后原样输出。
		if (end - start > FRAME_UNITS && safe > start) {
			// slice 取 [start, safe) 的字符串；start 移到切点，下一帧从这里继续。
			frames.push(data.slice(start, safe));
			start = safe;
		}
		// 扫描指针前进到当前单元之后；随后把 end 记为最新安全切点。
		index = end;
		safe = end;
	}
	// 最后一帧取剩余全部；即使超过 FRAME_UNITS 也只可能是单个超长转义序列，启动器按整帧处理。
	frames.push(data.slice(start));
	return frames;
}

/** The index after the character at `index`, a surrogate pair kept together. */
// 返回 index 处一个普通字符之后的索引；高代理项（0xD800..0xDBFF）且后面还有单元时跨过两个码元。
// 这里不拼接或验证码点，只避免在代理对中间切开；孤立代理项仍按单单元处理。
function unitEnd(data: string, index: number): number {
	const code = data.charCodeAt(index);
	return code >= 0xd800 && code <= 0xdbff && index + 1 < data.length ? index + 2 : index + 1;
}

/** The index after the escape sequence at `index` (CSI to its final; OSC, DCS and the like to their terminator). */
// 返回 index 处 ESC 开始的转义序列结束后的索引；未知/不完整序列至少跳过 ESC 与下一字符。
// CSI（ESC[）在参数字节 0x20..0x3F 后还有一个最终字节；OSC/DCS 等以 BEL 或 ESC\ 结束。
function sequenceEnd(data: string, index: number): number {
	const introducer = data[index + 1];
	// CSI：参数与中间字节范围 0x20..0x3F，遇到最终字节 0x40..0x7E 即结束；+1 后仍用 min 防越界。
	if (introducer === "[") {
		let at = index + 2;
		while (at < data.length && data.charCodeAt(at) >= 0x20 && data.charCodeAt(at) <= 0x3f) at++;
		return Math.min(at + 1, data.length);
	}
	// OSC/DCS/SOS/PM/APC 这类带字符串正文的序列；undefined 检查是因为索引可能越界。
	if (introducer !== undefined && "]PX^_".includes(introducer)) {
		for (let at = index + 2; at < data.length; at++) {
			// BEL（0x07）终止 OSC；ESC\ 终止 DCS 等，两者都算完整序列。
			if (data.charCodeAt(at) === 7) return at + 1;
			if (data[at] === "\x1b" && data[at + 1] === "\\") return at + 2;
		}
		return data.length;
	}
	// 其他 ESC 转义（如 ESC(0 或单独的 ESC）按两个码元跳过，至少不会把 ESC 留在帧尾。
	return Math.min(index + 2, data.length);
}
