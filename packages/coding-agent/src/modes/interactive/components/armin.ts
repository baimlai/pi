// 把内嵌XBM位图转成终端半格字符，再用随机动画逐步显示；宿主构造组件即开timer，离开时应dispose。只画文字，不发模型/图片请求。
/**
 * Armin says hi! A fun easter egg with animated XBM art.
 */

// 只导入组件与TUI类型，implements/字段注解编译后擦除；真实UI对象由调用方传入。
import type { Component, TUI } from "@earendil-works/pi-tui";
// 实时共享主题用于accent着色；本文件不更改主题，缓存失效仍需宿主通知。
import { theme } from "../theme/theme.ts";

// XBM image: 31x36 pixels, LSB first, 1=background, 0=foreground
// 图像像素宽31；export允许其他模块读取这一常量，不在此计算终端列数。
export const ARMIN_WIDTH = 31;
// 像素高36，后面每两个纵向像素合成一个字符格，所以显示图像为18行。
export const ARMIN_HEIGHT = 36;
// 内部短名指向同一数值，const禁止变量重新赋值，不额外创建图像对象。
const WIDTH = ARMIN_WIDTH;
// 内部高度取公开常量，数据和循环使用这份固定尺寸。
const HEIGHT = ARMIN_HEIGHT;
// 数字数组存XBM原始字节；0xff是十六进制255，不是字符串；每行4字节，最后1个填充bit不显示。
const BITS = [
	// 位图连续字节0..18，覆盖像素行0..4的相应部分；源码折行不等于图像换行，仍按每4字节解码。
	0xff, 0xff, 0xff, 0x7f, 0xff, 0xf0, 0xff, 0x7f, 0xff, 0xed, 0xff, 0x7f, 0xff, 0xdb, 0xff, 0x7f, 0xff, 0xb7, 0xff,
	// 位图连续字节19..37，覆盖像素行4..9的相应部分；源码折行不等于图像换行，仍按每4字节解码。
	0x7f, 0xff, 0x77, 0xfe, 0x7f, 0x3f, 0xf8, 0xfe, 0x7f, 0xdf, 0xff, 0xfe, 0x7f, 0xdf, 0x3f, 0xfc, 0x7f, 0x9f, 0xc3,
	// 位图连续字节38..56，覆盖像素行9..14的相应部分；源码折行不等于图像换行，仍按每4字节解码。
	0xfb, 0x7f, 0x6f, 0xfc, 0xf4, 0x7f, 0xf7, 0x0f, 0xf7, 0x7f, 0xf7, 0xff, 0xf7, 0x7f, 0xf7, 0xff, 0xe3, 0x7f, 0xf7,
	// 位图连续字节57..75，覆盖像素行14..18的相应部分；源码折行不等于图像换行，仍按每4字节解码。
	0x07, 0xe8, 0x7f, 0xef, 0xf8, 0x67, 0x70, 0x0f, 0xff, 0xbb, 0x6f, 0xf1, 0x00, 0xd0, 0x5b, 0xfd, 0x3f, 0xec, 0x53,
	// 位图连续字节76..94，覆盖像素行19..23的相应部分；源码折行不等于图像换行，仍按每4字节解码。
	0xc1, 0xff, 0xef, 0x57, 0x9f, 0xfd, 0xee, 0x5f, 0x9f, 0xfc, 0xae, 0x5f, 0x1f, 0x78, 0xac, 0x5f, 0x3f, 0x00, 0x50,
	// 位图连续字节95..113，覆盖像素行23..28的相应部分；源码折行不等于图像换行，仍按每4字节解码。
	0x6c, 0x7f, 0x00, 0xdc, 0x77, 0xff, 0xc0, 0x3f, 0x78, 0xff, 0x01, 0xf8, 0x7f, 0xff, 0x03, 0x9c, 0x78, 0xff, 0x07,
	// 位图连续字节114..132，覆盖像素行28..33的相应部分；源码折行不等于图像换行，仍按每4字节解码。
	0x8c, 0x7c, 0xff, 0x0f, 0xce, 0x78, 0xff, 0xff, 0xcf, 0x7f, 0xff, 0xff, 0xcf, 0x78, 0xff, 0xff, 0xdf, 0x78, 0xff,
	// 位图连续字节133..143，覆盖像素行33..35的相应部分；源码折行不等于图像换行，仍按每4字节解码。
	0xff, 0xdf, 0x7d, 0xff, 0xff, 0x3f, 0x7e, 0xff, 0xff, 0xff, 0x7f,
];

// 31/8向上取整为4，每个像素行独占完整4字节，不能直接按31个bit连续跨行读。
const BYTES_PER_ROW = Math.ceil(WIDTH / 8);
// 36/2向上取整为18；若像素高为奇数，最下格的下半像素由越界y规则当背景。
const DISPLAY_HEIGHT = Math.ceil(HEIGHT / 2); // Half-block rendering

// 字符串字面量联合只允许七种效果名，不生成enum对象，也不验证任意外部字符串。
type Effect = "typewriter" | "scanline" | "rain" | "fade" | "crt" | "glitch" | "dissolve";

// 可随机选择的效果表；Effect[]使每个元素受联合约束，数组本身并非readonly/freeze。
const EFFECTS: Effect[] = ["typewriter", "scanline", "rain", "fade", "crt", "glitch", "dissolve"];

// Get pixel at (x, y): true = foreground, false = background
// 读取有效坐标的前景布尔，不改数据；例(0,0)取首字节最低位，1表示背景故false。只判断y上界，未校验负数/x越界，不能声称所有越界都返回false。
export function isArminPixel(x: number, y: number): boolean {
	// 底部以外直接背景，支持半格最后一个下像素缺失；没有同时判断x或y<0。
	if (y >= HEIGHT) return false;
	// y选像素行，再由floor(x/8)选行内字节；合法x=8时落到本行第二字节。
	const byteIndex = y * BYTES_PER_ROW + Math.floor(x / 8);
	// %取余得到位偏移，合法整数x时为0..7，符合最低有效位在前的编码。
	const bitIndex = x % 8;
	// >>右移把目标位移到最低位，&1取这一bit，再===0解释为前景；并不解码PNG/JPEG。
	return ((BITS[byteIndex] >> bitIndex) & 1) === 0;
}

// Get the character for a cell (2 vertical pixels packed)
// 把同列上下两像素合成一个字符，返回满格/上半/下半/空格；例上true下false得到上半块，无IO。row是字符行而非像素y。
function getChar(x: number, row: number): string {
	// 字符row对应上像素y=row*2。
	const upper = isArminPixel(x, row * 2);
	// 同一字符的下像素紧接其后，y=row*2+1。
	const lower = isArminPixel(x, row * 2 + 1);
	// 上下均前景就用满格字符。
	if (upper && lower) return "█";
	// 前面未同时成立而上为true，显示上半块。
	if (upper) return "▀";
	// 只剩下方前景时显示下半块。
	if (lower) return "▄";
	// 两者均背景时返回普通空格，仍占一个字符格。
	return " ";
}

// Build the final image grid
// 构造最终18×31字符矩阵，逐行逐列调用getChar，返回独立数组；例grid[0][0]是最上左字符。只构图，不启动动画。
function buildFinalGrid(): string[][] {
	// string[][]表示字符串数组的数组；外数组按行，内数组按列。
	const grid: string[][] = [];
	// 从字符行0枚举到17，不是枚举全部36像素行。
	for (let row = 0; row < DISPLAY_HEIGHT; row++) {
		// 每次循环新建一个行数组，避免所有行共用同一个引用。
		const line: string[] = [];
		// 每行枚举31列，越过填充bit之前停止。
		for (let x = 0; x < WIDTH; x++) {
			// 取本格半块字符并追加，push会修改当前line数组。
			line.push(getChar(x, row));
		}
		// 完成的一行按顺序加入总矩阵。
		grid.push(line);
	}
	// 返回字符矩阵；主题颜色尚未应用。
	return grid;
}

// 实现TUI组件的动画类：构造随机选效果并启动定时器，render读当前格/缓存，dispose停timer。implements只检查接口，不自动挂载/销毁或保证所有效果收敛。
export class ArminComponent implements Component {
	// 保存宿主引用，用于请求重画；TS private不是运行时#私有字段。
	private ui: TUI;
	// ReturnType<typeof setInterval>复用本机timer句柄类型，|null表示未运行/已停止；不是把句柄当纯数字写死。
	private interval: ReturnType<typeof setInterval> | null = null;
	// 构造时确定本实例效果，正常流程不在每帧重新随机选择。
	private effect: Effect;
	// 完整静态图案矩阵，后续效果从它复制到当前帧。
	private finalGrid: string[][];
	// 当前显示矩阵，可被逐格修改或整体替换。
	private currentGrid: string[][];
	// Record<string,unknown>收纳各效果不同状态；后面as只表达程序约定，不实际按字段校验。
	private effectState: Record<string, unknown> = {};
	// 缓存已经着色/补空格后的行字符串，render可直接返回同一数组引用。
	private cachedLines: string[] = [];
	// 上次渲染宽度，初始0；不是当前TUI的动态宽度查询。
	private cachedWidth = 0;
	// 每次动画更新递增版本，即使某帧格子没有变化也递增。
	private gridVersion = 0;
	// 初始-1确保第一次render时版本不相等，不会误用空缓存。
	private cachedVersion = -1;

	// 输入宿主创建组件：随机效果→最终图→空图→效果状态→启动timer。例new ArminComponent(ui)已开始动画，未挂载也会请求渲染；定时回调异常没有统一catch。
	constructor(ui: TUI) {
		// 保存调用者传入的同一ui对象，不创建真实终端。
		this.ui = ui;
		// Math.random在[0,1)取值，乘7再floor选0..6下标；用于装饰效果，不是密码学随机。
		this.effect = EFFECTS[Math.floor(Math.random() * EFFECTS.length)];
		// 每实例生成一份最终字符网格供效果复制。
		this.finalGrid = buildFinalGrid();
		// 当前帧先空白，dissolve初始化稍后会改成噪声。
		this.currentGrid = this.createEmptyGrid();

		// 按已选效果建立对应状态，调用不等于已输出终端。
		this.initEffect();
		// 立即安排循环定时器，宿主须在不再使用时dispose；这里没有unref。
		this.startAnimation();
	}

	// 宿主通知显示需失效时只把缓存宽度置0，返回void；例正常正宽下一次render会重算，不改变网格/版本或自行请求重画。width恰为0不是强制失效保证。
	invalidate(): void {
		// 置0作为缓存宽度哨兵，并没有清cachedLines或把cachedVersion设-1。
		this.cachedWidth = 0;
	}

	// 按给定宽度返回着色图像行加问候行；同宽同版本复用缓存。例正常宽40时左留1列，其余补空格；问候未裁剪、非正宽有slice负值语义，不保证任意宽都不溢出。主题/字符串异常直接抛。
	render(width: number): string[] {
		// 宽度和网格版本都一致才复用；主题变化不在缓存键里，需宿主invalidate。
		if (width === this.cachedWidth && this.cachedVersion === this.gridVersion) {
			// 原缓存数组直接返回，调用者不应把它当新数组随意修改。
			return this.cachedLines;
		}

		// 左边固定留1列普通空格。
		const padding = 1;
		// 图案可用列数减去左留白；没有Math.max夹零，极窄值会影响slice行为。
		const availableWidth = width - padding;

		// map逐行生成带颜色的新字符串数组，不修改当前格矩阵。
		this.cachedLines = this.currentGrid.map((row) => {
			// Clip row to available width before applying color
			// 先按格数组slice再join，只裁图案部分；availableWidth<0时slice表示从尾端扣除，而非自动清空。
			const clipped = row.slice(0, availableWidth).join("");
			// 右侧补到给定宽度，Math.max避免repeat接收负数；不等于把已有过长文字截短。
			const padRight = Math.max(0, width - padding - clipped.length);
			// 模板串拼左空格、accent正文与右空格；ANSI着色不改变这些单格字符的视觉占宽。
			return ` ${theme.fg("accent", clipped)}${" ".repeat(padRight)}`;
		});

		// Add "ARMIN SAYS HI" at the end
		// 固定问候文字只是显示内容，不是系统提示词或模型输入。
		const message = "ARMIN SAYS HI";
		// 问候太长时右补零，不会缩短message本身。
		const msgPadRight = Math.max(0, width - padding - message.length);
		// 最后追加问候行，所以总返回19行；宽度小于问候加左留白时仍可能超宽。
		this.cachedLines.push(` ${theme.fg("accent", message)}${" ".repeat(msgPadRight)}`);

		// 记录本次使用的宽度供下一次缓存比较。
		this.cachedWidth = width;
		// 缓存对应当前帧版本，后续tick增版本会让它失效。
		this.cachedVersion = this.gridVersion;

		// 返回本次缓存引用，函数本身不write真实终端。
		return this.cachedLines;
	}

	// 创建18行31列的空格矩阵，无输入/IO；例修改grid[0][0]不会改grid[1][0]，外层回调每次都新建行。
	private createEmptyGrid(): string[][] {
		// Array.from调用18次行工厂，各行Array(31).fill填不可变空格字符串；没有共用一个可变内数组。
		return Array.from({ length: DISPLAY_HEIGHT }, () => Array(WIDTH).fill(" "));
	}

	// 按effect初始化effectState，dissolve还生成噪声帧；返回void。例fade预先打乱558个格的位置，tick随后顺序取；随机分配在初始化发生，不验证as类型或保证rain结束。
	private initEffect(): void {
		// switch按固定效果名分派，case后break避免落入其他初始化。
		switch (this.effect) {
			// 打字机记录已经处理的线性格下标。
			case "typewriter":
				// 初始pos0，从第一格开始。
				this.effectState = { pos: 0 };
				// 结束本case，不继续scanline。
				break;
			// 扫描线按整字符行推进。
			case "scanline":
				// 从第0行开始复制。
				this.effectState = { row: 0 };
				// 停止当前初始化分支。
				break;
			// 雨滴效果为每列保存独立下落位置和已稳定底部区段。
			case "rain":
				// Track falling position for each column
				// 把新的雨滴状态对象替换到通用effectState。
				this.effectState = {
					// 为31列各新建一个对象；箭头后({})表示返回对象，不是代码块。
					drops: Array.from({ length: WIDTH }, () => ({
						// 初始y在0至-35之间，列因此错开进入画面；负号作用于floor结果。
						y: -Math.floor(Math.random() * DISPLAY_HEIGHT * 2),
						// 初始没有稳定底部区段，单位是字符行数。
						settled: 0,
					})),
				};
				// 结束rain初始化。
				break;
			// 花括号为fade局部变量单独建立块级作用域。
			case "fade": {
				// Shuffle all pixel positions
				// [number,number][]是二元数值元组数组，每项按[row,x]保存，不是任意长度坐标。
				const positions: [number, number][] = [];
				// 枚举所有18个字符行。
				for (let row = 0; row < DISPLAY_HEIGHT; row++) {
					// 各行枚举31列，包含最终为空格的格子。
					for (let x = 0; x < WIDTH; x++) {
						// 共加入558个坐标，每个坐标创建独立二元数组。
						positions.push([row, x]);
					}
				}
				// Fisher-Yates shuffle
				// 从末尾逆向洗牌直到索引1，0无需再交换。
				for (let i = positions.length - 1; i > 0; i--) {
					// 在0..i闭区间随机选交换伙伴。
					const j = Math.floor(Math.random() * (i + 1));
					// 解构赋值交换两个坐标引用，右侧先求值，避免手写临时变量；不更改坐标内部。
					[positions[i], positions[j]] = [positions[j], positions[i]];
				}
				// positions同名属性简写，idx从0依次消耗打乱的坐标。
				this.effectState = { positions, idx: 0 };
				// 结束fade初始化。
				break;
			}
			// CRT从中间行向上下扩展。
			case "crt":
				// 扩展半径初始0，首帧只复制中间行。
				this.effectState = { expansion: 0 };
				// 结束CRT初始化。
				break;
			// 故障效果先显示若干扰动帧，再恢复全图。
			case "glitch":
				// phase从0开始，glitchFrames固定8；不是8毫秒。
				this.effectState = { phase: 0, glitchFrames: 8 };
				// 结束glitch初始化。
				break;
			// dissolve用块作用域保存自己的坐标列表。
			case "dissolve": {
				// Start with random noise
				// 替换当前帧为噪声矩阵，每个字符行由独立Array.from产生。
				this.currentGrid = Array.from({ length: DISPLAY_HEIGHT }, () =>
					// 每个格调用一次随机字符工厂。
					Array.from({ length: WIDTH }, () => {
						// 候选包含空格与深浅块/半块，都是装饰字符，不是位图数据字节。
						const chars = [" ", "░", "▒", "▓", "█", "▀", "▄"];
						// 随机取一个候选字符串，初始噪声不必与最终前景位置一致。
						return chars[Math.floor(Math.random() * chars.length)];
					}),
				);
				// Shuffle positions for gradual resolve
				// 为渐进还原另建坐标表，二元元组顺序仍[row,x]。
				const dissolvePositions: [number, number][] = [];
				// 覆盖全部字符行。
				for (let row = 0; row < DISPLAY_HEIGHT; row++) {
					// 覆盖各行全部列。
					for (let x = 0; x < WIDTH; x++) {
						// 逐格收集坐标，后面打乱后分批还原。
						dissolvePositions.push([row, x]);
					}
				}
				// 第二套坐标同样由尾向前洗牌。
				for (let i = dissolvePositions.length - 1; i > 0; i--) {
					// 在当前前缀中取均匀随机下标，包括当前位置。
					const j = Math.floor(Math.random() * (i + 1));
					// 交换坐标数组引用，不改最终图案。
					[dissolvePositions[i], dissolvePositions[j]] = [dissolvePositions[j], dissolvePositions[i]];
				}
				// 字段名positions接dissolvePositions，idx0表示尚未还原。
				this.effectState = { positions: dissolvePositions, idx: 0 };
				// 结束dissolve初始化。
				break;
			}
		}
	}

	// 启动周期帧更新，返回void；glitch目标60fps，其余30fps。例timer每次先改格/版本再请求渲染，完成才清timer；真实调度不精确，异常不由此catch，重复调用也没有先清旧timer。
	private startAnimation(): void {
		// 三元表达式按效果给目标帧率，不测实际终端刷新能力。
		const fps = this.effect === "glitch" ? 60 : 30;
		// setInterval保存句柄；箭头捕获this，回调未来重复执行，不是现在同步运行全部动画。
		this.interval = setInterval(() => {
			// 推进一帧，返回true仅表示该效果报告完成。
			const done = this.tickEffect();
			// 即使done=true也先加版本，让最终图案下次可重算。
			this.updateDisplay();
			// 通知宿主安排重画，不等同本行已把19行写到屏幕。
			this.ui.requestRender();
			// 只有效果报告完成才自动停；某分支始终false就保持timer。
			if (done) {
				// 清除本字段指向的周期timer。
				this.stopAnimation();
			}
			// 1000/fps是目标毫秒间隔，Node调度/忙碌会延迟，不是精确帧时钟。
		}, 1000 / fps);
	}

	// 停当前记录的timer，无参数/返回值；例dispose后interval=null，再停一次无事。未取消已执行中的回调，也不dispose宿主UI。
	private stopAnimation(): void {
		// 有句柄才清理，null表示没有当前timer。
		if (this.interval) {
			// clearInterval阻止后续周期触发，不撤回此前requestRender。
			clearInterval(this.interval);
			// 置null避免正常路径重复清相同句柄。
			this.interval = null;
		}
	}

	// 分派当前效果的一次tick，返回完成布尔，无直接终端IO；例scanline交tickScanline。default是原有兜底，不代表类型允许第八种效果。
	private tickEffect(): boolean {
		// 按effect选择唯一效果方法，return避免fallthrough。
		switch (this.effect) {
			// 打字机分支。
			case "typewriter":
				// 转交线性逐格更新并返回其完成状态。
				return this.tickTypewriter();
			// 扫描线分支。
			case "scanline":
				// 转交整行复制。
				return this.tickScanline();
			// 雨滴分支。
			case "rain":
				// 转交每列独立下落更新。
				return this.tickRain();
			// 渐显分支。
			case "fade":
				// 转交随机坐标逐格恢复。
				return this.tickFade();
			// CRT分支。
			case "crt":
				// 转交中心扩展更新。
				return this.tickCrt();
			// 故障分支。
			case "glitch":
				// 转交随机扰动/最终复原。
				return this.tickGlitch();
			// 溶解分支。
			case "dissolve":
				// 转交从噪声到最终图的逐格还原。
				return this.tickDissolve();
			// 正常Effect类型已覆盖，保留原代码的其他值兜底分支。
			default:
				// 未知运行值按完成处理，便于上层停止，而非抛错误。
				return true;
		}
	}

	// 打字机每帧最多拷3格，跨行按pos展开，无参数返回是否越过全图。例pos31从第二字符行开始；恰好最后3格结束时本帧仍false，下一帧才检查到完成。
	private tickTypewriter(): boolean {
		// as按initEffect建立的约定读取pos，不运行时验证effectState。
		const state = this.effectState as { pos: number };
		// 本帧最多处理3个字符格，名字pixels不指原36行的单像素。
		const pixelsPerFrame = 3;

		// 逐格计数，不保证每格都是前景。
		for (let i = 0; i < pixelsPerFrame; i++) {
			// 线性下标整除31得到字符行。
			const row = Math.floor(state.pos / WIDTH);
			// 余数得到行内列，合法pos时在0..30。
			const x = state.pos % WIDTH;
			// 先查行越界再访问矩阵，全部558格之后返回完成。
			if (row >= DISPLAY_HEIGHT) return true;
			// 复制最终字符，空格也复制，写入当前帧同一位置。
			this.currentGrid[row][x] = this.finalGrid[row][x];
			// 推进到下一个线性格。
			state.pos++;
		}
		// 本轮最多3格处理完而未提前越界，报告继续。
		return false;
	}

	// 扫描线每帧复制完整一行，返回是否完成；例row0复制最上行。复制最后一行那帧仍false，下次进入才true，不直接请求重绘。
	private tickScanline(): boolean {
		// 按scanline初始化约定把通用状态视为row对象，as不转换值。
		const state = this.effectState as { row: number };
		// 已越过18行就报告完成，不再访问格子。
		if (state.row >= DISPLAY_HEIGHT) return true;

		// Copy row
		// 从左至右复制这一行的31格，不复用最终行数组引用。
		for (let x = 0; x < WIDTH; x++) {
			// 当前行当前列取得最终字符。
			this.currentGrid[state.row][x] = this.finalGrid[state.row][x];
		}
		// 行游标向下移动一次。
		state.row++;
		// 刚复制的一行通过外层updateDisplay/requestRender显示，当前仍报告继续。
		return false;
	}

	// 雨滴逐列落到下一前景位置，并保留其下方区段；返回帧开始观察到是否每列settled>=18。例落到row15后settled变3，下帧复制底部3行。内置图最左/最右列全是背景，本实现没有补齐空白列的分支，因此该效果需宿主dispose停timer，不能说必定自行结束。
	private tickRain(): boolean {
		// 把unknown状态断言为带drops数组的对象，和initEffect的rain约定配对。
		const state = this.effectState as {
			// 每列对象含当前字符y与已稳定的底部行数，[]表示数组。
			drops: { y: number; settled: number }[];
		};

		// 先假设全部稳定，发现任一未完成列再改false。
		let allSettled = true;
		// 每帧清空画面，后面重新画稳定区段和正在落的块。
		this.currentGrid = this.createEmptyGrid();

		// 按31列独立处理，不在列之间共享y。
		for (let x = 0; x < WIDTH; x++) {
			// 取得该列可变状态对象，后续直接改其字段。
			const drop = state.drops[x];

			// Draw settled pixels
			// 从最下行17向上复制settled个行位，包含原图的空格。
			for (let row = DISPLAY_HEIGHT - 1; row >= DISPLAY_HEIGHT - drop.settled; row--) {
				// 下标仍>=0才读写网格，避免稳定区段超出顶部。
				if (row >= 0) {
					// 把稳定区段原样恢复到空白帧。
					this.currentGrid[row][x] = this.finalGrid[row][x];
				}
			}

			// Check if this column is done
			// 整列区段覆盖18行就跳到下一列，不再移动雨滴。
			if (drop.settled >= DISPLAY_HEIGHT) continue;

			// 这一列在帧开始未完成，本帧最终返回false，即使稍后刚好落稳。
			allSettled = false;

			// Find the target row for this column (lowest non-space pixel)
			// -1哨兵表示还没找到剩余前景。
			let targetRow = -1;
			// 在稳定区段上方从下往上找下一目标。
			for (let row = DISPLAY_HEIGHT - 1 - drop.settled; row >= 0; row--) {
				// 非空格才算需要落稳的前景，半块/满块都可命中。
				if (this.finalGrid[row][x] !== " ") {
					// 保存首个命中的行号。
					targetRow = row;
					// 遇最低剩余前景就停止搜索。
					break;
				}
			}

			// Move drop down
			// 雨滴y每帧加1，负值阶段仍不可见。
			drop.y++;

			// Draw falling drop
			// 只有当前y在显示行范围内才落稳或画落块，越过底部并无额外重置分支。
			if (drop.y >= 0 && drop.y < DISPLAY_HEIGHT) {
				// 必须找到目标且已到达目标行才结算；targetRow=-1不会被判完成。
				if (targetRow >= 0 && drop.y >= targetRow) {
					// Settle
					// 记录从目标行到底的完整区段长度，不只是已前景像素的个数。
					drop.settled = DISPLAY_HEIGHT - targetRow;
					// 新雨滴随机重置到-1..-5，下一目标稍后再搜索。
					drop.y = -Math.floor(Math.random() * 5) - 1;
				} else {
					// Still falling
					// 仍在下落就显示临时深块，不要求该位置最终就是前景。
					this.currentGrid[drop.y][x] = "▓";
				}
			}
		}

		// 返回前面各列汇总的状态；空白列/上方仅余空白没有专门补齐路径，可能让timer持续。
		return allSettled;
	}

	// 渐显每帧最多恢复15个预洗牌格，返回是否耗尽；例positions[0]=[2,3]先恢复第三行第四列，余格已全恢复则true。仅改当前帧/idx，无IO。
	private tickFade(): boolean {
		// 元组数组和idx的断言对应fade初始化，不检查通用字典真实形状。
		const state = this.effectState as { positions: [number, number][]; idx: number };
		// 每帧最多15个字符格，不是毫秒数。
		const pixelsPerFrame = 15;

		// 分批消耗坐标表，最多15次。
		for (let i = 0; i < pixelsPerFrame; i++) {
			// 坐标表耗尽就提前返回完成，避免越界解构。
			if (state.idx >= state.positions.length) return true;
			// 二元解构依次得到行与列，顺序由初始化push约定。
			const [row, x] = state.positions[state.idx];
			// 将这个随机位置恢复成最终字符，可能是空白。
			this.currentGrid[row][x] = this.finalGrid[row][x];
			// 推进坐标游标，不移除数组元素。
			state.idx++;
		}
		// 本批处理完且尚未触发耗尽检查，报告继续。
		return false;
	}

	// CRT每帧从中间扩大可见行区段，返回expansion>18；例首帧只画row9，半径9已覆盖全图但仍按原阈值继续若干帧。每帧重建空图，不是透明度渐变。
	private tickCrt(): boolean {
		// 把状态视为扩展半径对象，字段由初始化提供。
		const state = this.effectState as { expansion: number };
		// 18/2向下取整为9，所以选第10个字符行作中心。
		const midRow = Math.floor(DISPLAY_HEIGHT / 2);

		// 清空当前矩阵，后面只恢复当前半径内的行。
		this.currentGrid = this.createEmptyGrid();

		// Draw from middle expanding outward
		// 上边界等于中间行减半径，允许暂时负数，循环再夹紧。
		const top = midRow - state.expansion;
		// 下边界等于中间行加半径。
		const bottom = midRow + state.expansion;

		// 把上下界夹到0..17，<=表示包含边界行。
		for (let row = Math.max(0, top); row <= Math.min(DISPLAY_HEIGHT - 1, bottom); row++) {
			// 区段内每行全部31格恢复。
			for (let x = 0; x < WIDTH; x++) {
				// 复制最终字符，不复制行数组。
				this.currentGrid[row][x] = this.finalGrid[row][x];
			}
		}

		// 本帧画完再加半径，完成比较用更新后的数。
		state.expansion++;
		// 严格大于18才结束，不是刚好覆盖图像就停。
		return state.expansion > DISPLAY_HEIGHT;
	}

	// 故障前8帧随机旋转/替换行，第9次恢复干净全图并true；例横向偏移-3相当把尾3格搬前。不做真正两行互换，随机阈值也不保证每帧必定出现扰动。
	private tickGlitch(): boolean {
		// 按初始化约定取阶段和扰动帧数，as只影响TS访问。
		const state = this.effectState as { phase: number; glitchFrames: number };

		// phase0..7走扰动分支，之后转最终帧。
		if (state.phase < state.glitchFrames) {
			// Glitch phase: show corrupted version
			// 每帧基于最终图各行生成新行，不累积上帧噪声。
			this.currentGrid = this.finalGrid.map((row) => {
				// 随机整数偏移在-3..3，0也是合法值。
				const offset = Math.floor(Math.random() * 7) - 3;
				// 展开浅复制这一行字符串格，不修改finalGrid。
				const glitchRow = [...row];

				// Random horizontal offset
				// 约30%分支尝试水平循环位移；优先命中后不会再看垂直替换。
				if (Math.random() < 0.3) {
					// slice对负值按尾部计数，两段concat形成循环位移，不填额外空格。
					const shifted = glitchRow.slice(offset).concat(glitchRow.slice(0, offset));
					// 截回31格并作为map本行结果，提前return只结束当前回调。
					return shifted.slice(0, WIDTH);
				}

				// Random vertical swap
				// 前面未选水平分支才再独立抽约20%概率，因此不是全体行固定20%。
				if (Math.random() < 0.2) {
					// 随机选某个最终行，可恰好选回本行。
					const swapRow = Math.floor(Math.random() * DISPLAY_HEIGHT);
					// 复制选中行替换当前行，不把原行写回另一个位置，原英语swap不是实际交换。
					return [...this.finalGrid[swapRow]];
				}

				// 没有选任一扰动时，返回这行普通副本。
				return glitchRow;
			});
			// 完成一帧后阶段加1。
			state.phase++;
			// 扰动阶段仍未报告完成，外层timer继续。
			return false;
		}

		// Final frame: show clean image
		// 最终全图逐行复制，移除上一帧扰动且保持finalGrid不变。
		this.currentGrid = this.finalGrid.map((row) => [...row]);
		// 报告完成，外层先请求显示最终帧再停止timer。
		return true;
	}

	// 溶解每帧恢复20个预洗牌格，逐步把随机块变为最终图，返回坐标是否耗尽；例与fade共用坐标思路，但起始噪声/每帧数量不同。没有额外随机删除过程。
	private tickDissolve(): boolean {
		// 断言位置表/游标结构和dissolve初始化匹配，不验证任意unknown。
		const state = this.effectState as { positions: [number, number][]; idx: number };
		// 每帧最多恢复20个字符格。
		const pixelsPerFrame = 20;

		// 逐项恢复本帧额度。
		for (let i = 0; i < pixelsPerFrame; i++) {
			// 已耗尽先返回true，不读取不存在坐标。
			if (state.idx >= state.positions.length) return true;
			// 从当前随机坐标元组解构行和列。
			const [row, x] = state.positions[state.idx];
			// 覆盖噪声格为最终字符，包括最终空格。
			this.currentGrid[row][x] = this.finalGrid[row][x];
			// 推进位置表游标。
			state.idx++;
		}
		// 尚未通过耗尽检查，报告还有后续帧。
		return false;
	}

	// 仅增加网格版本，令后续render缓存失效，返回void；例每tick调用一次，不检查内容变化也不自行发渲染请求。
	private updateDisplay(): void {
		// ++把数值加1，缓存比较将看见新版本。
		this.gridVersion++;
	}

	// 释放组件自身的周期timer，返回void；例宿主从布局移除后调用它，动画就不再继续调度。不会销毁ui/清格/清显示缓存或撤回已经安排的重画。
	dispose(): void {
		// 委托可重复调用的停止函数，不附加终端输出。
		this.stopAnimation();
	}
}
