// 接收 shell 的流式字节，有限内存中保留末尾展示，必要时把完整原始输出写临时日志；bash.ts 定期取快照并在结束时读程序化结果。
// 只导入写流类型，运行时不因此加载一个名为 WriteStream 的值。
import type { WriteStream } from "node:fs";
// 异步打开已完成的日志，支持显式位置的头尾分段读取。
import { open } from "node:fs/promises";
import { createOutputFileStream } from "../../utils/output-files.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

// 累计器创建时的宿主配置，不是模型直接调用的参数 schema。
export interface OutputAccumulatorOptions {
	// 可选展示行数预算；缺省复用工具公共值。
	maxLines?: number;
	// 可选展示字节预算；并非限制命令实际能输出多少字节。
	maxBytes?: number;
	// 临时日志文件名用途前缀，例如 pi-bash。
	tempFilePrefix?: string;
}

// UI/模型展示的一次状态快照。
export interface OutputSnapshot {
	// 本次可见输出正文，可能只保留末尾。
	content: string;
	// 包含原总量、展示量和截断原因。
	truncation: TruncationResult;
	// 只有创建过临时日志才有路径，不能假设每次输出都落盘。
	fullOutputPath?: string;
}

// 供程序读取的输出与是否仍有省略的标志。
export interface FullOutput {
	// 本次可见输出正文，可能只保留末尾。
	content: string;
	/** Whether `content` omits part of the output. */
	// 即使比 UI 预算更大，也可能被 readFullOutput 的单独上限裁剪。
	truncated: boolean;
}

/** 按 UTF-8 计算文字字节数，纯计算，无 I/O；例“中”通常是 3 字节，不能用 text.length 代替。 */
function byteLength(text: string): number {
	// 得到文字编码后的实际字节数量。
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	// private 限制类外 TS 访问，readonly 防止构造之后在类型层重新赋值。
	private readonly maxLines: number;
	// 用于一次展示快照的字节上限。
	private readonly maxBytes: number;
	// 滚动缓冲区预算，留出比单次展示更大的余量减少频繁复制。
	private readonly maxRollingBytes: number;
	// 记住按需创建日志时采用的前缀。
	private readonly tempFilePrefix: string;
	// 跨 append 共用解码器，它能暂存分块末尾尚未完整的 UTF-8 字节。
	private readonly decoder = new TextDecoder();

	// 小输出阶段保存原始字节块；一旦落盘就清空这些引用。
	private rawChunks: Buffer[] = [];
	// 仅用于展示的已解码滚动尾部，不等于完整历史输出。
	private tailText = "";
	// 滚动尾部当前占多少 UTF-8 字节。
	private tailBytes = 0;
	// 裁剪后的尾部是否从完整行开头开始，影响快照是否应丢掉半行前缀。
	private tailStartsAtLineBoundary = true;
	// 收到的原始 Buffer 总字节数，即使尾部裁剪也不回退。
	private totalRawBytes = 0;
	// 已解码文字重新编码成 UTF-8 后的累计字节数；异常输入可能与原始数不同。
	private totalDecodedBytes = 0;
	// 已经出现换行结束的行数。
	private completedLines = 0;
	// 已结束的行加当前未换行的开放行。
	private totalLines = 0;
	// 最近一个换行后当前末行的字节数。
	private currentLineBytes = 0;
	// 当前末尾是否还有未用换行结束的文字。
	private hasOpenLine = false;
	// finish 后不再允许 append 的生命周期标志。
	private finished = false;

	// 可能没有创建文件，用联合类型表达缺省状态。
	private tempFilePath: string | undefined;
	// 正在写的流；close 时先移除此引用，再等待它真正完成。
	private tempFileStream: WriteStream | undefined;

	/**
	 * 建立输出累计器，输入展示行数/字节预算与临时文件名前缀；不在构造时创建日志文件。
	 * 例如 maxBytes=1024 的对象先在内存保存小输出，超预算后才切换到临时文件。
	 */
	constructor(options: OutputAccumulatorOptions = {}) {
		// 从配置取展示行数，空缺时用默认；?? 不会把 0 当缺省。
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		// 读取展示字节预算。
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		// 滚动目标保留两倍展示预算，且至少 1 字节，减少每来一个块就裁剪的频率。
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		// 默认文件名前缀是 pi-output。
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
	}

	/**
	 * 接收一个原始 Buffer 分块，增量 UTF-8 解码并更新展示尾部，再将原始数据留内存或写临时文件。
	 * 已 finish 后再 append 会抛错；分块可能把一个中文字符拆开，TextDecoder stream 模式会等待余下字节。
	 */
	append(data: Buffer): void {
		// 已经结束时 append 报错，finish 则直接返回；同一标志服务两种方法的不同生命周期要求。
		if (this.finished) {
			// 拒绝结束后写入，防止快照和落盘状态继续变化。
			throw new Error("Cannot append to a finished output accumulator");
		}

		// 原始计数按收到的字节增加，不依赖解码是否已输出字符。
		this.totalRawBytes += data.length;
		// 流式解码可能暂不输出半个中文字符，等下个块补齐再交给文字统计。
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		// 已有日志就继续写；首次超过预算时才转入落盘路径。
		if (this.tempFileStream || this.shouldUseTempFile()) {
			// 按需建立/复用日志，同时先写入此前保存的原始块。
			this.ensureTempFile();
			// 把本次原始字节写入流；?. 是可选调用保护，write 的完成仍需 closeTempFile 等待。
			this.tempFileStream?.write(data);
			// 尚未超限的小输出留在内存；不为零长度块保存无用引用。
		} else if (data.length > 0) {
			// 保存原始 Buffer 引用，后续完整读取或转存日志会用。
			this.rawChunks.push(data);
		}
	}

	/**
	 * 标记输出不再追加，并冲刷解码器暂存字节；多次调用可安全返回，不会重复计算正文。
	 * 必要时建立临时文件，但不负责等待日志写完；调用方随后应 await closeTempFile。
	 */
	finish(): void {
		// 已经结束时 append 报错，finish 则直接返回；同一标志服务两种方法的不同生命周期要求。
		if (this.finished) {
			return;
		}
		// 先设结束状态，使后续重复 finish 不再次冲刷解码器。
		this.finished = true;
		// 不带 stream:true 的最终 decode 冲刷尚未完成的末尾字节。
		this.appendDecodedText(this.decoder.decode());
		// 最终解码可能增加字符/字节计数，结束时再检查一次落盘需要。
		if (this.shouldUseTempFile()) {
			// 按需建立/复用日志，同时先写入此前保存的原始块。
			this.ensureTempFile();
		}
	}

	/**
	 * 返回当前可展示末尾及完整输出计数；可要求截断时确保日志落盘，读取快照不代表命令已经结束。
	 * 例：进程仍在持续输出，UI 每隔一段时间取快照显示最后 50KB，而原输出总字节数继续累积。
	 */
	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		// 先对内存尾部做一次展示裁剪；完整原输出总量后面单独覆盖。
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			// 此次快照采用累计器的展示行数预算。
			maxLines: this.maxLines,
			// 此次快照采用累计器的展示字节预算。
			maxBytes: this.maxBytes,
		});
		// 用完整计数判断是否裁剪，不能只看已经裁短的 tailText。
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		// 只有完整输出确实超预算才需要截断原因。
		const truncatedBy = truncated
			? // 优先用尾部裁剪器观察到的原因，否则根据完整计数推断超字节还是超行。
				(tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: // 没有任何裁剪时原因是 null。
				null;
		// 合成面向原始完整输出的准确详情，而不是误报滚动缓冲区的局部数量。
		const truncation: TruncationResult = {
			// 保留裁剪正文、展示计数和半行标记。
			...tailTruncation,
			// 以完整输出统计计算的裁剪标志覆盖局部结果。
			truncated,
			// 使用上面确定的裁剪原因。
			truncatedBy,
			// 原输出行数可能远大于滚动尾部行数。
			totalLines: this.totalLines,
			// 使用原累计已解码字节数，避免滚动裁剪后总量被重置。
			totalBytes: this.totalDecodedBytes,
			// 此次快照采用累计器的展示行数预算。
			maxLines: this.maxLines,
			// 此次快照采用累计器的展示字节预算。
			maxBytes: this.maxBytes,
		};

		// 调用方需要可回查原文且当前有省略时，保证存在临时文件。
		if (options.persistIfTruncated && truncation.truncated) {
			// 按需建立/复用日志，同时先写入此前保存的原始块。
			this.ensureTempFile();
		}

		return {
			// 快照正文来自尾部裁剪器。
			content: truncation.content,
			// 同时返回完整计数与裁剪详情。
			truncation,
			// 有日志就提供路径；无日志则 undefined。
			fullOutputPath: this.tempFilePath,
		};
	}

	/**
	 * 若有临时写流，结束它并等待 finish/error；无文件时直接返回。
	 * 成功表示已排队的写入结束，随后才能可靠 readFullOutput；错误会拒绝 Promise，调用方负责处理。
	 */
	async closeTempFile(): Promise<void> {
		// 小输出可能从未落盘，或写流已经关闭，此时无需等待 finish。
		if (!this.tempFileStream) {
			return;
		}

		// 保留需要关闭的流对象，随后可清空类字段。
		const stream = this.tempFileStream;
		// 标记不再接受通过该字段的写入；实际已排队字节仍由局部 stream 继续完成。
		this.tempFileStream = undefined;

		// 将流的事件完成/失败转换为可 await 的 Promise。
		await new Promise<void>((resolve, reject) => {
			// 写流失败回调，向调用者传播实际错误。
			const onError = (error: Error) => {
				// 失败后移除成功监听，避免留住无用回调引用。
				stream.off("finish", onFinish);
				// 让 closeTempFile 的 Promise 拒绝，不能谎称日志已完整写完。
				reject(error);
			};
			// 所有排队写入完成后运行成功回调。
			const onFinish = () => {
				// 成功后移除这次关闭操作的错误监听。
				stream.off("error", onError);
				// 完成 Promise<void>，不携带业务正文。
				resolve();
			};
			// 只监听一次关闭阶段写入错误。
			stream.once("error", onError);
			// 只监听一次写流完成事件。
			stream.once("finish", onFinish);
			// 发出结束写入请求；不代表这行返回时所有字节已经写完，因此必须等待事件。
			stream.end();
		});
	}

	/**
	 * The complete output, for callers that can take more than the display snapshot. Call after
	 * `finish()` and `closeTempFile()`. Output longer than `maxBytes` raw bytes keeps its first and
	 * last `maxBytes / 2` bytes around an omission marker.
	 */
	/**
	 * 结束后读取供程序调用者使用的较大输出：未落盘就合并内存块，已落盘则按预算读全文或首尾。
	 * 先 finish 和 closeTempFile，再调用本方法；首尾省略按原始字节计数，标记本身不计入预算。
	 * 例如 UI 只看 50KB，但脚本可设置 1MB；这仍可能裁剪，不能因函数名 Full 就保证无限输出。
	 */
	async readFullOutput(maxBytes: number): Promise<FullOutput> {
		// 未超过展示预算的输出仍在内存，无需读磁盘。
		if (!this.tempFilePath) {
			// 把原始块拼成连续 Buffer 后完整解码；此内存路径没有额外应用传入 maxBytes。
			return { content: new TextDecoder().decode(Buffer.concat(this.rawChunks)), truncated: false };
		}
		// 以只读模式打开已生成的完整日志。
		const file = await open(this.tempFilePath, "r");
		try {
			// 读取实际文件字节大小，决定完整读取还是头尾读取。
			const size = (await file.stat()).size;
			// 磁盘原文在程序调用预算内时，完整返回。
			if (size <= maxBytes) {
				// 读全文并解码；这里不会加入省略标记。
				return { content: new TextDecoder().decode(await file.readFile()), truncated: false };
			}
			// 头部分一半预算，奇数时向下取整。
			const headBytes = Math.floor(maxBytes / 2);
			// 余下预算给尾部，确保两段原始字节预算合计为 maxBytes。
			const tailBytes = maxBytes - headBytes;
			// 分配固定长度头部读取缓冲区。
			const head = Buffer.alloc(headBytes);
			// 分配固定长度尾部读取缓冲区。
			const tail = Buffer.alloc(tailBytes);
			// 从文件位置 0 读取头部字节。
			await file.read(head, 0, headBytes, 0);
			// 直接定位文件末尾读取，不必把巨大日志全文装进内存。
			await file.read(tail, 0, tailBytes, size - tailBytes);
			// Cut at character boundaries: streaming decode holds back an incomplete trailing sequence,
			// and the tail skips leading continuation bytes.
			// 流模式暂存头部末尾的不完整 UTF-8 字符，未再 flush 因而不会把半字符输出。
			const headText = new TextDecoder().decode(head, { stream: true });
			// 尾部字节可能从多字节字符中间开始，准备跳过续字节。
			let tailStart = 0;
			// UTF-8 续字节高位为 10，跳到一个完整字符开头再解码。
			while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
			// 从安全字节边界解码尾部。
			const tailText = new TextDecoder().decode(tail.subarray(tailStart));
			// 省略计数按原计划读取区间之间的原始字节计算，不包含为完整字符另外舍去的边界字节。
			const omitted = size - headBytes - tailBytes;
			// 头尾中间插明确省略标记，调用者知道这不是完整日志。
			return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true };
		} finally {
			// finally 中关闭只读句柄，即使读取/解码过程抛错也释放资源。
			await file.close();
		}
	}

	/** 返回当前最后一行累计的 UTF-8 字节数，供 shell 解释“末行本身过长”；纯读状态，不读文件。 */
	getLastLineBytes(): number {
		// 读取最近一行字节统计，供超长末行提示使用。
		return this.currentLineBytes;
	}

	/**
	 * 处理已完整解码的文字：更新总字节/尾部、按换行累加真实行数，必要时压缩内存尾部。
	 * 例：先来“a”，再来“\nb”，总行数变为 2，当前末行是 b；空块不改变状态。
	 */
	private appendDecodedText(text: string): void {
		// 解码器可能因为半字符暂时返回空串，不重复更新行数。
		if (text.length === 0) {
			return;
		}

		// 按 UTF-8 得到这批已解码文字的字节量。
		const bytes = byteLength(text);
		// 完整已解码总量持续累加，不因滚动尾部缩短而回退。
		this.totalDecodedBytes += bytes;
		// 把新文字接到展示尾部。
		this.tailText += text;
		// 同步更新展示尾部占用。
		this.tailBytes += bytes;
		// 超过滚动目标两倍才裁剪，批量处理减少每块复制字符串的成本。
		if (this.tailBytes > this.maxRollingBytes * 2) {
			// 按完整字符边界留下较小尾部，释放早期展示文字引用。
			this.trimTail();
		}

		// 本批新出现的换行计数。
		let newlines = 0;
		// -1 表示本批还没找到换行，后面用来确定当前末行。
		let lastNewline = -1;
		// 逐个查 LF；下次从 i+1 开始避免重复命中同一个换行。
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			// 一个换行意味着又有一行完成。
			newlines++;
			// 记住本批最后一个换行位置，循环结束后可计算末尾开放行。
			lastNewline = i;
		}
		// 本批没有换行，继续在同一条未结束行后追加。
		if (newlines === 0) {
			// 当前末行长度累积，而不是重置为这一个块长度。
			this.currentLineBytes += bytes;
			// 本批非空且未换行，末尾存在一条开放行。
			this.hasOpenLine = true;
		} else {
			// 累计新增的已结束行数。
			this.completedLines += newlines;
			// 取最后一个 LF 后的文字，作为新的未结束末行。
			const tail = text.slice(lastNewline + 1);
			// 当前末行字节数只由换行后的这段决定。
			this.currentLineBytes = byteLength(tail);
			// 如果批次恰好以换行结束，就不另算一条不存在的空行。
			this.hasOpenLine = tail.length > 0;
		}
		// 总行数 = 已结束行数 + 是否还有末尾开放行。
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	/**
	 * 把内存尾部缩到滚动预算附近，沿 UTF-8 边界取尾部，并记录起点是否为完整行开头。
	 * 它只裁剪展示用内存；超限时完整原始输出由临时文件保存，不能据内存长度计算总输出。
	 */
	private trimTail(): void {
		// 编码滚动尾部，方便按字节预算选择安全切点。
		const buffer = Buffer.from(this.tailText, "utf-8");
		// 若实际内容已经在滚动目标内，就不再构造新尾部字符串。
		if (buffer.length <= this.maxRollingBytes) {
			// 同步真实字节数，保持缓冲统计准确。
			this.tailBytes = buffer.length;
			return;
		}

		// 计算保留末 maxRollingBytes 字节的候选起点。
		let start = buffer.length - this.maxRollingBytes;
		// 若落在续字节，向右跳到完整 UTF-8 字符开头。
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			// 缩小保留区间一字节，直到不会拆半个字符。
			start++;
		}

		// 切点前一字节为 LF 才算从完整行开始；若未裁剪则保留已有边界状态。
		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		// 重新保存安全尾部文字，早期正文退出展示内存。
		this.tailText = buffer.subarray(start).toString("utf-8");
		// 记录新尾部真实字节数，可能比目标略少。
		this.tailBytes = byteLength(this.tailText);
	}

	/**
	 * 返回可交给 truncateTail 的展示文本；尾部从半行开始且还有换行时，丢掉那条不完整前缀行。
	 * 如果只剩一条超长行，则返回其尾部片段，后续截断器会生成对应说明。
	 */
	private getSnapshotText(): string {
		// 本就从完整行开头开始，快照可以直接使用。
		if (this.tailStartsAtLineBoundary) {
			// 返回滚动尾部，不包含此前已省去的原输出。
			return this.tailText;
		}

		// 寻找不完整前缀行的结束位置。
		const firstNewline = this.tailText.indexOf("\n");
		// 有后续完整行就丢掉首段半行；若根本没有换行，则保留唯一超长行的尾部。
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	/** 判断原始字节、已解码字节或总行数是否任一超过展示预算；不创建文件，只有布尔计算。 */
	private shouldUseTempFile(): boolean {
		return (
			// 任意一项超过展示预算就需要保留原文日志；|| 表示至少一项成立。
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	/**
	 * 按需创建一次临时日志，把尚在内存的原始块先写入，再清空块数组；后续 append 直接写流。
	 * 副作用是创建并持续写本地日志；重复调用复用已有路径，不重建文件。
	 */
	private ensureTempFile(): void {
		// 已有路径就复用，不重复创建新日志或再次复制旧块。
		if (this.tempFilePath) {
			return;
		}
		// 创建工具日志文件并同时得到路径和写流；对象解构取出两个返回字段。
		const { path, stream } = createOutputFileStream(this.tempFilePrefix, ".log");
		// 保存可供工具结果回查的日志路径。
		this.tempFilePath = path;
		// 后续原始 Buffer 直接写这个流。
		this.tempFileStream = stream;
		// 先把转存前的小输出按原顺序搬到日志，避免丢失文件开头。
		for (const chunk of this.rawChunks) {
			// 写入此前尚在内存的原始字节，不用重新编码展示文字。
			this.tempFileStream.write(chunk);
		}
		// 转存后释放原始块数组引用，控制内存占用。
		this.rawChunks = [];
	}
}
