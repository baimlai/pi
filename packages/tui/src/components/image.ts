// 把base64图片作为TUI组件排成终端行；terminal-image提供能力/尺寸/协议辅助，组件负责转码、行数占位与缓存，上层TUI才真正写终端。
import {
	// Kitty没有指定ID时生成随机ID，便于随后放置/清理。
	allocateImageId,
	// 读共享能力缓存，冷缓存可能触发环境/tmux探测。
	getCapabilities,
	// 取每个终端格的像素尺寸。
	getCellDimensions,
	// 从支持格式的文件头估算图片宽高，不是完整图像验证。
	getImageDimensions,
	// 转PNG后重新读其头部尺寸，允许转码器调整方向。
	getPngDimensions,
	// type只引入像素尺寸形状。
	type ImageDimensions,
	// 无图片能力/无可用数据时生成文字说明。
	imageFallback,
	// 按能力和格数预算生成Kitty或iTerm2控制串及预留格数。
	renderImage,
} from "../terminal-image.ts";
// implements的Component契约要求render/invalidate等；类型导入不会建立TUI实例。
import type { Component } from "../tui.ts";
// 文字回退按显示格宽截断，忽略ANSI样式占用，必要时加省略号。
import { truncateToWidth } from "../utils.ts";

/**
 * Converts base64 image data to base64 PNG data, or returns null if it cannot.
 * Called synchronously during rendering.
 */
// 同步转换回调契约：输入原base64及MIME，返回PNG base64或null。调用者可自行实现，TS不验证返回内容真为PNG，回调抛错会传播。
export type ImageTranscoder = (base64Data: string, mimeType: string) => string | null;

// 共享可选转换器；登记函数只保存引用，不在这里调用它。
let imageTranscoder: ImageTranscoder | undefined;
// Backstop for callers that recreate Image instances. Keyed by source data, least recently used first.
// 跨Image实例的32项LRU缓存，键只有原base64，不含MIME；null失败结果也缓存，读到undefined才算没缓存。
const pngCache = new Map<string, string | null>();

/**
 * Register the converter used for non-PNG images on Kitty-protocol terminals, which only accept PNG.
 * Without one, such images render as text fallbacks.
 */
// 替换同步转码器或设undefined，返回void；例：Photon加载完后登记，原来文字回退的组件需上层invalidate重绘。
// 会清共享PNG缓存，但不清各Image已保存的pngData/行缓存；这里采用f=100的PNG编码，不是整个Kitty图形协议只支持PNG。
export function setImageTranscoder(transcoder: ImageTranscoder | undefined): void {
	// 保存函数引用或undefined，所有实例后续都可观察。
	imageTranscoder = transcoder;
	// 清掉共享成功/失败项，使新转换器有机会重试；不遍历现有实例。
	pngCache.clear();
}

// 取PNG转换结果并更新LRU，返回string/null；例：同数据第二个实例可复用首次转换。
// 先看有无转换器、再查缓存，命中也移至末尾，超32项删最旧；缓存键不含MIME，异常不捕获，无图像有效性检查。
function toPng(base64Data: string, mimeType: string): string | null {
	// 没转换器立即null，此情况不写共享失败缓存。
	if (!imageTranscoder) return null;
	// 只按数据查表，get可返回成功串、null或undefined。
	const cached = pngCache.get(base64Data);
	// 只有undefined才实际同步转码；null会阻止同数据重新转换，直到换转码器或该项被淘汰。
	const png = cached === undefined ? imageTranscoder(base64Data, mimeType) : cached;
	// 先删除使接下来set能将此键移到Map末尾。
	pngCache.delete(base64Data);
	// 存成功或null，并更新最近使用顺序。
	pngCache.set(base64Data, png);
	// 超过32项时删最早键；!只是TS非空断言，容量条件说明正常Map此刻非空。
	if (pngCache.size > 32) pngCache.delete(pngCache.keys().next().value!);
	// 原样返回缓存/转换结果，不复制字符串或改MIME。
	return png;
}

// 文字回退的主题接口，不控制图像像素颜色。
export interface ImageTheme {
	// 输入回退文字并返回着色后的字符串；回调可有自己的副作用，本组件不捕获错误。
	fallbackColor: (str: string) => string;
}

// 组件布局/回退选项，单位格数，?均可省；不会运行时冻结。
export interface ImageOptions {
	// 最大占用列数，缺省60，render还会受父宽-2限制。
	maxWidthCells?: number;
	// 最大占用行数；缺省按像素正方形预算计算，不是固定60行。
	maxHeightCells?: number;
	// 仅用于回退展示/文件链接，不在组件里读取该文件。
	filename?: string;
	/** Kitty image ID. If provided, reuses this ID (for animations/updates). */
	// 调用方指定的Kitty ID，复用时可替换既有图；不在此保证唯一性。
	imageId?: number;
}

// 实现Component的有状态图片对象；render会写自身/共享缓存与元数据，但不直接输出控制串到终端。
export class Image implements Component {
	// 原始base64字符串，不是磁盘文件路径。
	private base64Data: string;
	// 原声明MIME，仅精确image/png跳过Kitty转码。
	private mimeType: string;
	// 原图像素尺寸或800×600估计，可能并非完整解码后的大小。
	private dimensions: ImageDimensions;
	// 保存主题对象引用。
	private theme: ImageTheme;
	// 保存原选项对象引用，调用方修改选项不会自动清缓存。
	private options: ImageOptions;
	// 可选Kitty图像ID，可能在首次图片render时才分配。
	private imageId?: number;
	/** Converted PNG data for Kitty. Failures are not stored so a later transcoder can retry. */
	// 实例成功PNG缓存；null转换成undefined，所以实例字段不记失败，但共享LRU仍可能记null。
	private pngData?: string;

	// 上次render的原行数组引用，没有深复制。
	private cachedLines?: string[];
	// 缓存只以父宽度为键，未把能力、单元格像素尺寸或主题纳入。
	private cachedWidth?: number;

	// 保存图片/主题/布局材料，建立像素尺寸，例：未读出尺寸时估计800×600。
	// 不转PNG、不分配随机ID、不写终端；显式dimensions与theme/options共享引用，文件头解析只在没有显式尺寸时执行。
	constructor(
		// 原图片base64。
		base64Data: string,
		// 声明MIME决定头部尺寸解析与是否转码。
		mimeType: string,
		// 回退文字的主题着色函数。
		theme: ImageTheme,
		// 布局/文件名/ID选项，缺省新空对象。
		options: ImageOptions = {},
		// 可选显式像素尺寸，传入即优先采用，不校验正数/有限性。
		dimensions?: ImageDimensions,
	) {
		// 保存原数据。
		this.base64Data = base64Data;
		// 保存原MIME。
		this.mimeType = mimeType;
		// 保存主题引用。
		this.theme = theme;
		// 保存选项引用，不复制。
		this.options = options;
		// ||按真值优先显式尺寸、再尝试头部读取、再800×600估计；不是图片内容有效性的证明。
		this.dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		// 保留可选调用方ID，未传则仍undefined。
		this.imageId = options.imageId;
	}

	/** Get the Kitty image ID used by this image (if any). */
	// 返回此实例当前Kitty ID或undefined；例：未渲染且未指定ID时无值。只读字段，不分配、不查询终端。
	getImageId(): number | undefined {
		// 返回内存中的ID。
		return this.imageId;
	}

	// 使行输出缓存失效，返回void；例：格像素尺寸或转换器就绪后上层调用，再render重算。保留成功PNG和imageId，不释放终端图片。
	invalidate(): void {
		// 清行数组缓存。
		this.cachedLines = undefined;
		// 清对应父宽度；原缓存数组被外部持有时仍存在。
		this.cachedWidth = undefined;
	}

	// 按父宽度生成字符串行数组；例：Kitty首行是图像协议，后面空行补足高度。
	// 流程：查宽缓存→定格数预算→必要时转PNG→图片协议或文字回退→缓存。会同步转码、分配ID/登记元数据；回调错误可抛，首次能力获取可能探测tmux，无终端直接写入。
	render(width: number): string[] {
		// 只有行缓存存在且父width全等才命中；能力/单元格变化需上层invalidate才绕开。
		if (this.cachedLines && this.cachedWidth === width) {
			// 返回同一数组，不防止外部修改。
			return this.cachedLines;
		}

		// 父宽先留2列，与选项/默认60取较小，再至少1；很窄父容器也会给图片1列，不保证永不超父宽。
		const maxWidth = Math.max(1, Math.min(width - 2, this.options.maxWidthCells ?? 60));
		// 读共享格像素尺寸，这不是字体点数。
		const cellDimensions = getCellDimensions();
		// 最大列×每格像素宽，除每格像素高并向上取整，默认包围盒约为像素正方形。
		const defaultMaxHeight = Math.max(1, Math.ceil((maxWidth * cellDimensions.widthPx) / cellDimensions.heightPx));
		// 显式最大行数优先，??不会把0当缺省，后续尺寸算法会至少1格。
		const maxHeight = this.options.maxHeightCells ?? defaultMaxHeight;

		// 获取能力，缓存未建立时可能做环境探测。
		const caps = getCapabilities();
		// 局部data先指原图，let允许转码失败时改null。
		let data: string | null = this.base64Data;
		// 局部尺寸先用原尺寸，转码成功后可换PNG尺寸，不改this.dimensions。
		let dimensions = this.dimensions;
		// 只有Kitty且MIME不精确等于image/png才转换。
		if (caps.images === "kitty" && this.mimeType !== "image/png") {
			// ??=仅实例还没成功PNG才取共享转换结果；null变undefined以便以后有机会重试，但共享null仍可能命中。
			this.pngData ??= toPng(this.base64Data, this.mimeType) ?? undefined;
			// 失败统一用null，后面走回退；成功字符串保持。
			data = this.pngData ?? null;
			// Conversion may apply EXIF rotation, so prefer the PNG's own dimensions.
			// 有数据时优先采用PNG头部的宽高，例如EXIF旋正后宽高交换；坏头仍用旧尺寸，不因此拒绝载荷。
			if (data) dimensions = getPngDimensions(data) ?? dimensions;
		}
		// 声明稍后各分支都要赋值的行数组。
		let lines: string[];

		// 协议可用且data非空才尝试图片；空字符串会回退。
		if (caps.images && data) {
			// 仅Kitty且ID恰为undefined才自动分配，0被视为显式ID。
			if (caps.images === "kitty" && this.imageId === undefined) {
				// 写实例随机ID；随机降低碰撞概率但不保证全局唯一。
				this.imageId = allocateImageId();
			}
			// 底层计算布局并生成协议串；它还可登记Kitty元数据。
			const result = renderImage(data, dimensions, {
				// 传计算后的列预算。
				maxWidthCells: maxWidth,
				// 传行预算，宽高会一起等比受限。
				maxHeightCells: maxHeight,
				// 传当前实例ID。
				imageId: this.imageId,
				// Kitty指定C=1让终端不按默认规则移动光标，行位置由TUI统一维护。
				moveCursor: false,
			});

			// 底层返回结果才建立协议输出。
			if (result) {
				// Store the image ID for later cleanup
				// 结果ID为真值才更新；0不会在此写回。
				if (result.imageId) {
					// 保留ID供上层TUI后续清理使用，组件自身没有dispose删除动作。
					this.imageId = result.imageId;
				}

				// Kitty与iTerm2需要不同的占位行布局。
				if (caps.images === "kitty") {
					// For Kitty: C=1 prevents cursor movement.
					// Don't need the cursor movement.
					// Kitty在第一行放完整协议串，不再加上移码。
					lines = [result.sequence];

					// Return `rows` lines so TUI accounts for image height.
					// 补rows−1个空行，TUI据行数组长度预留高度，不是空白PNG像素。
					for (let i = 0; i < result.rows - 1; i++) {
						// 追加一个空占位行。
						lines.push("");
					}
					// 此处剩余支持协议是iTerm2。
				} else {
					// Return `rows` lines so TUI accounts for image height.
					// First (rows-1) lines are empty and cleared before the image is drawn.
					// Last line: move cursor back up, draw the image, then move back down
					// so TUI cursor accounting stays inside the scroll area.
					// 先从空行数组开始。
					lines = [];
					// 先预留rows−1行，真正协议串放最后一行。
					for (let i = 0; i < result.rows - 1; i++) {
						// 空占位行会被TUI按普通行处理/清除。
						lines.push("");
					}
					// 从最后占位行回到图片起点需要上移多少行。
					const rowOffset = result.rows - 1;
					// 多行时生成CSI n A；单行不用上移。此处只构造字符串。
					const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";
					// 最后一行上移后发图像串；返回行中没有显式moveDown，上层终端/渲染器负责后续光标记账。
					lines.push(moveUp + result.sequence);
				}
				// 底层无法生成图片串则使用文字。
			} else {
				// 回退用原MIME/原尺寸/文件名，不用局部转码尺寸替换说明。
				const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
				// 先主题着色再按显示宽截断，回调异常向外传；只返回一行。
				lines = [truncateToWidth(this.theme.fallbackColor(fallback), width)];
			}
			// 无协议或无转换数据同样回退。
		} else {
			// 生成原图片文字说明，可能按能力添加文件超链接。
			const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
			// 保持回退在父显示宽度内，必要时省略。
			lines = [truncateToWidth(this.theme.fallbackColor(fallback), width)];
		}

		// 保存当前行数组引用，无复制。
		this.cachedLines = lines;
		// 只记录本次父宽作为缓存键。
		this.cachedWidth = width;

		// 返回刚生成的数组，之后同宽render可直接复用。
		return lines;
	}
}
