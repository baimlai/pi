// 全屏3D彩蛋实现：轻量入口按需加载本文件，把旧屏幕变成盲文点阵尘埃，再画旋转的pi标识或Armin，关闭时重组旧画面。
// 理解顺序：位图→小方块模型→移动/旋转位置→逐点射线求遮挡→点阵字符与ANSI颜色→全屏浮层。这里的3D是终端文字渲染，不是WebGL。
// 从TUI取运行时颜色/按键工具，以及编译后擦除的组件、鼠标、颜色接口；普通import中的type只保留类型用途。
import {
	// 把Color编码成背景色ANSI序列，后面的ansi缓存用它减少同色序列构造。
	backgroundAnsi,
	// Color是带kind标签的颜色类型，不是RGB三元组本身；type修饰表示不导入运行值。
	type Color,
	// Component描述render等组件契约，implements只做静态检查，不替组件自动实现生命周期。
	type Component,
	// colorToRgb把项目Color对象转成r/g/b对象，再由本文件改成三元组。
	colorToRgb,
	// foregroundAnsi生成前景色序列；实际TrueColor或索引形式还受主题颜色模式影响。
	foregroundAnsi,
	// 读取当前可配置按键表，取消/清屏不是在本文件硬编码Ctrl组合键。
	getKeybindings,
	// indexedColor构造调色板索引颜色，供旧屏幕ANSI的16色/256色解析。
	indexedColor,
	// rgbColor构造RGB颜色对象，后面解包24位颜色缓存键时使用。
	rgbColor,
	// TUI接口让本文件调用浮层/终端查询，不因类型注解而创建真实终端。
	type TUI,
	// 鼠标事件类型约束宿主传入字段，不在运行时自行验证数据。
	type TuiMouseEvent,
	// 鼠标结果类型描述是否接管事件、是否立即要求渲染等反馈。
	type TuiMouseEventResult,
	// visibleWidth按终端显示列求字素宽度，不把JS字符串length直接当屏幕列。
	visibleWidth,
} from "@earendil-works/pi-tui";
// 共享主题代理提供文字/强调色、明暗与颜色模式；动画同时会向终端探测实际默认色。
import { theme } from "../theme/theme.ts";
// 复用Armin手写位图的宽高/像素判定，不另外存一份人物图；这里只导入，不启动内联Armin动画。
import { ARMIN_HEIGHT, ARMIN_WIDTH, isArminPixel } from "./armin.ts";
// 把取消键名称变成提示用文字，提示跟当前配置走。
import { formatKeyText } from "./keybinding-hints.ts";

/**
 * Fullscreen 3D easter eggs: the pi logo (header logo click) and Armin (/arminsayshi). Both are bitmaps built from
 * one block per pixel. The current screen dissolves into braille dust while the model spins in the center and its
 * blocks play a sliding puzzle. Leaving plays the same timeline backwards, so the screen reassembles.
 *
 * The pi logo lifts off the header, flies to the center, and grows; the dust spreads out from the header logo.
 * Armin grows out of a speck at the center; the dust spreads out from the center.
 *
 * The blocks are ray cast per braille dot. A braille cell holds 2x4 roughly square dots, so one pixel of a
 * half-block bitmap is exactly 2x2 dots, and the header logo (4x2 cells) is 8x8 dots when it lifts off.
 */

// Rgb给三项数字元组起别名，readonly禁止经此类型改下标，既不运行时freeze也不保证数字都在0..255。例[255,0,0]表示红。
type Rgb = readonly [number, number, number];

// 旧画面的一个终端列槽：保存字素、已解析颜色和变尘埃的时序。interface只描述结构，不生成实例或校验器。
interface ScreenCell {
	// 原字素文字；宽字第二列占位使用空串，不再重复整个中文字。
	text: string;
	/** 1 or 2 for a grapheme, 0 for the second column of a wide grapheme. */
	// 显示列宽约定：1普通字素、2宽字素首列、0宽字素续列；number本身并未把取值限制为这三个数字。
	width: number;
	// 这一列解析后的文字RGB色，已处理反色/变暗效果。
	fg: Rgb;
	/** Undefined when the cell uses the terminal's default background. */
	// 明确允许undefined表示终端默认背景；与bg?:Rgb不同，此字段在结构里仍要求存在。
	bg: Rgb | undefined;
	/** Seconds until the cell turns into braille dust. */
	// 从动画起点开始过多少秒才让此格分解；随后还会走DUST_DURATION时长。
	delay: number;
	/** Number of braille dots the glyph turns into. */
	// 字符分解初始大致用几个盲文点，按字符类别估计，不从真实字体取轮廓。
	ink: number;
	// 稳定伪随机种子，使同一格的尘埃变化可重复。
	seed: number;
}

// 星点的固定参数；闪烁颜色每帧由时间计算，这些字段本身不自动更新。
interface Star {
	/** Braille character with the single dot the star occupies. */
	// 用一个盲文点对应的Unicode字符当星星，而非一个图片对象。
	glyph: string;
	/** Color the star leans toward; it only ever shows a small step from the background toward it. */
	// 星光偏色RGB，最终只会从背景往该方向混入少量。
	tint: Rgb;
	/** Largest step from the background toward the tint, from 0 to 1. */
	// 最大混色权重，约定在0..1；类型number并不执行范围验证。
	strength: number;
	// 正弦闪烁的初始相位，不同星点错开明暗变化。
	phase: number;
	/** Flicker speed in radians per second. */
	// 闪烁角速度，单位弧度/秒，不是每秒帧数。
	speed: number;
}

// 一个轴对齐方块的物体坐标包围盒；先在此空间移动，再统一乘旋转矩阵。
interface Box {
	// x/y/z三个最小边界，readonly只限制通过此元组引用写值。
	min: readonly [number, number, number];
	// 对应三个最大边界；类型不检查min一定小于max。
	max: readonly [number, number, number];
	// 未加光照前的品牌/人物RGB基础色。
	color: Rgb;
}

// 一帧模型的屏幕位置与旋转参数；中心和比例使用盲文点单位，不直接使用终端列行。
interface Pose {
	// 投影中心横坐标，一终端列含两个盲文点。
	centerX: number;
	// 投影中心纵坐标，一终端行含四个盲文点。
	centerY: number;
	/** Braille dots per model pixel at depth 0. */
	// 深度0处一个模型像素对应多少盲文点，实际投影还乘透视倍率。
	scale: number;
	// 绕y轴的偏航角，弧度制。
	yaw: number;
	// 绕x轴的俯仰角，弧度制。
	pitch: number;
	// 绕z轴的侧倾角，弧度制。
	roll: number;
}

// 每个模型像素块厚0.7模型单位，中心层z=0时前后各占一半厚度。
const DEPTH = 0.7;
// 进入后0.1秒才开始飞起/分解波，不是请求延迟超时。
const FLY_START = 0.1;
// 飞向屏幕中心的插值阶段持续1.3秒，和后面常驻旋转不是同一个截止。
const FLY_DURATION = 1.3;
/** Braille dots per pixel when a model without an origin appears, growing from a speck at the center. */
// 没有页头起点的Armin从每像素0.1盲文点的小尺寸开始放大。
const START_SCALE = 0.1;

/** Grid position of a block: column and row in the bitmap, and layer (-1, 0, 1) in depth. */
// Cell3为只读[x,y,z]格坐标；当前算法把深度层限制-1/0/1，但类型本身只检查三项number。
type Cell3 = readonly [number, number, number];

/** A bitmap built from one block per foreground pixel. Each is a block that the puzzle slides around. */
// 位图模型：每个有颜色的像素变成一个可移动方块，附带相机/尺寸/拼图策略。不是动画一帧的屏幕画面。
interface Model {
	/** Bitmap size in pixels. */
	// 原位图列数，作为方块x坐标边界。
	columns: number;
	// 原位图行数，作为方块y坐标边界。
	rows: number;
	// Array<...>和...[]均是数组写法；每块保留家位置home和基础色，数组并非readonly。
	blocks: Array<{ home: Cell3; color: Rgb }>;
	/** Camera distance from the model's center, in pixels. */
	// 相机距模型中心的距离，数值越大，同样深度差的透视变化通常越小。
	cameraDistance: number;
	/** Farthest distance of any block corner from the center, with blocks on the outer depth layers. */
	// 按位图外框及可移动深度估计的最远半径，供最终缩放留边；不是每帧遍历所有角点求精确最小包围球。
	radius: number;
	/** Largest share of the screen width the spinning model covers. */
	// 终态缩放期望占屏幕宽度的比例，还会受高度和最小起始比例限制，并非所有屏幕都严格不超过该比例。
	widthShare: number;
	/** Number of blocks the puzzle moves per step, given a random number from 0 to 1. */
	// 函数类型：接0..1随机数并返回此步希望移动的块数；声明不验证输入范围、不自动产生随机数。
	puzzleMoves: (random: number) => number;
	/**
	 * Top-left cell of the model's half-block rendering on screen. The model lifts off from there and replaces it.
	 * Undefined to grow out of the center.
	 */
	// 页头标识原先所在的0基终端列行；undefined表示从屏幕中心长出，不是坐标(0,0)。
	origin: { column: number; row: number } | undefined;
}

// 把二维像素回调转成模型，输入宽高、pixel及相机/移动选项，返回Model；例2×1只有(0,0)给颜色，就生成一个home=[0,0,0]方块。
// 流程逐像素取色→收集有色块→保存相机/外框半径→闭包绑定块数。会调用传入回调，异常直接传播；不读终端、不启动定时器，也不验证尺寸数值。
function createModel(
	// columns决定横向扫描次数，同时原样保存在返回模型。
	columns: number,
	// rows决定纵向扫描次数，不在这里按屏幕大小缩小原位图。
	rows: number,
	// pixel是函数参数，返回RGB表示有块、undefined表示透明；=>在这里描述函数签名而非定义函数体。
	pixel: (column: number, row: number) => Rgb | undefined,
	// Pick从Model挑三项属性，再用交叉类型&补上这个工厂专用的puzzleMoves签名，仍只是静态结构约束。
	options: Pick<Model, "cameraDistance" | "widthShare" | "origin"> & {
		// 此处移动策略还接blockCount，返回模型里的策略稍后会把第二参数封在闭包里。
		puzzleMoves: (random: number, blockCount: number) => number;
	},
): Model {
	// Model["blocks"]是索引访问类型，直接复用模型的数组类型；初值是新空数组，不是读取某个Model实例。
	const blocks: Model["blocks"] = [];
	// 从上往下遍历位图行，let row可在每轮row++更新。
	for (let row = 0; row < rows; row++) {
		// 每行从左往右遍历列；这里以模型像素为单位，不是终端字符列。
		for (let column = 0; column < columns; column++) {
			// 调用外部像素回调，异常会终止整个模型构造，不被包装成空像素。
			const color = pixel(column, row);
			// 有RGB数组才push一个块，初始深度0；对象属性color用简写，未复制颜色元组。undefined透明位不占块。
			if (color) blocks.push({ home: [column, row, 0], color });
		}
	}
	// 返回普通对象；下面的字段简写复用局部值，不会自动clone块或选项对象。
	return {
		// 同名属性简写columns:columns。
		columns,
		// 同名属性简写rows:rows。
		rows,
		// 把刚构造的块数组交给模型，后面的闭包也引用这个数组。
		blocks,
		// 从选项取相机距离，不在本函数修正过小/无穷数值。
		cameraDistance: options.cameraDistance,
		// hypot求外框半宽、半高、最外层厚度的三维长度；深度1再加半厚度，为上下层移动留空间。
		radius: Math.hypot(columns / 2, rows / 2, 1 + DEPTH / 2),
		// 保留调用方提供的宽度占比，真正适配屏幕在pose中计算。
		widthShare: options.widthShare,
		// 箭头函数形成闭包：之后每次接random时，把当前blocks.length当第二实参传给原策略，不立即决定所有步数。
		puzzleMoves: (random) => options.puzzleMoves(random, blocks.length),
		// 保留原origin对象引用或undefined，未冻结/复制起点。
		origin: options.origin,
	};
}

// 珊瑚色RGB元组，const固定变量绑定，不等运行时数组不可改。
const CORAL: Rgb = [228, 138, 122];
// 蓝色基础RGB，用在pi左侧笔画。
const BLUE: Rgb = [79, 142, 179];
// 黄色基础RGB，用在pi右侧笔画。
const YELLOW: Rgb = [234, 182, 93];
// 4×4手写位图，每个ASCII字符是一像素，c/b/y有色，点号透明；它显示为半块时占4列2行。
const PI_LOGO_PIXELS = ["ccc.", "b.c.", "bb.y", "b..y"];
// Record<string,Rgb>在TS里给字符串索引RGB返回类型，但普通缺失键（如点号）运行时仍会得到undefined；类型声明不补字典项，下游有色判定保留透明。
const PI_LOGO_COLORS: Record<string, Rgb> = { c: CORAL, b: BLUE, y: YELLOW };

// 创建从页头起飞的4×4 pi模型，接0基起点、返回新Model；例origin={column:2,row:0}让模型替换该处原标识。只组数据，实际动画由外层浮层驱动。
function piLogoModel(origin: { column: number; row: number }): Model {
	// 回调先取位图一行再取字符查颜色；两个!只消除TS的可能undefined提示，不在运行时检查数组下标。
	return createModel(4, 4, (column, row) => PI_LOGO_COLORS[PI_LOGO_PIXELS[row]![column]!], {
		// pi标识相机距中心10模型单位。
		cameraDistance: 10,
		// 最终尺寸以屏幕宽35%为一项限制，还要结合屏幕高度与起始比例。
		widthShare: 0.35,
		// 条件表达式?:按random<0.4选2块，否则1块；random来自确定性hash，不调用Math.random。
		puzzleMoves: (random) => (random < 0.4 ? 2 : 1),
		// 保存传入origin引用，属性简写等价origin:origin。
		origin,
	});
}

// 用Armin位图创建单色人物模型，输入主题强调RGB，返回新Model；所有前景像素用同一颜色，透明处无块。无页头origin，后面从中心小点放大。
function arminModel(color: Rgb): Model {
	// 复用实际位图宽高，只有isArminPixel为true才交颜色给createModel；三元分支不创建两个模型。
	return createModel(ARMIN_WIDTH, ARMIN_HEIGHT, (column, row) => (isArminPixel(column, row) ? color : undefined), {
		// Far enough that the perspective stays mild for a figure about 36 blocks tall.
		// 相机距80，使约36像素高的人物透视较温和，不是等待80毫秒。
		cameraDistance: 80,
		// 期望宽度占比45%，最终pose仍综合高度/起始缩放。
		widthShare: 0.45,
		// 每步目标移动块数按块数的约3%到7%四舍五入；能否真移动这么多还取决于可用邻格。
		puzzleMoves: (random, blockCount) => Math.round(blockCount * (0.03 + random * 0.04)),
		// 显式undefined选择中心生长路径，不是把属性省略后交默认起点。
		origin: undefined,
	});
}

// The sliding puzzle: after the model spun for a while, blocks slide into free neighboring cells, a few at a time.
// Each cycle shuffles, flies every block back home, and holds the model briefly.
// 拼图阶段在飞行完成再等3秒后开始，计算得到4.4秒。
const PUZZLE_START = FLY_START + FLY_DURATION + 3;
// 每个滑动步骤0.3秒。
const PUZZLE_STEP = 0.3;
// 每周期打乱12步，步骤快照会有起始加12步共13份。
const PUZZLE_STEPS = 12;
// 打乱结束后用1秒同时回家；这条弧线插值没有真实物理碰撞检测。
const PUZZLE_RETURN = 1;
// 回家后保持完整图案0.6秒，再进入下周期。
const PUZZLE_HOLD = 0.6;
// 周期等于打乱12步3.6秒+回家1秒+保持0.6秒，共5.2秒。
const PUZZLE_CYCLE = PUZZLE_STEP * PUZZLE_STEPS + PUZZLE_RETURN + PUZZLE_HOLD;
// 可选邻格位移列表，xy四向各出现两次、z两向各一次，因此不是六方向等概率权重；元组本身不承诺新位置空闲。
const PUZZLE_MOVES: Cell3[] = [
	// 向右一模型格。
	[1, 0, 0],
	// 向左一模型格。
	[-1, 0, 0],
	// 向下一模型格。
	[0, 1, 0],
	// 向上一模型格。
	[0, -1, 0],
	// 再次列右移，候选池会多一份对应候选，增加xy平面移动权重。
	[1, 0, 0],
	// 再次列左移，同样作为独立候选参与选择。
	[-1, 0, 0],
	// 再次列下移，未在生成候选后去重。
	[0, 1, 0],
	// 再次列上移，不是用来表示移动两格。
	[0, -1, 0],
	// 向前一深度层。
	[0, 0, 1],
	// 向后一深度层，实际目标还会检查在-1..1内。
	[0, 0, -1],
];

/** Block positions after each step of one shuffle cycle, starting at home. Deterministic per cycle. */
// 为model/cycle生成一个周期的所有格位置快照，返回Cell3[][]；steps[0]是家位置，steps[1]是第一步后的位置。相同模型/周期的选择可重复。
// 流程每步登记占位→枚举未动块的空邻格→优先上步没动的块→选候选→保存数组快照。仅组内存数据，回调错误向外传；候选不足时该步可少移动。
function shuffleSteps(model: Model, cycle: number): Cell3[][] {
	// 解构原位图列行，为目标边界与坐标编码使用，不改模型。
	const { columns, rows } = model;
	// map新建位置数组，但初始各元组仍是block.home原引用；后面换数组槽，不写这些只读元组。
	let positions: Cell3[] = model.blocks.map((block) => block.home);
	// 第一份快照就是当前positions数组，不另深拷贝。
	const steps = [positions];
	// 保存前一步动过的块索引，优先换块以减少原地抖动。
	const lastMoved = new Set<number>();
	// 周期编号派生起始伪随机整数，数字分隔符_只为阅读，7_919就是7919。
	let random = cycle * 7_919 + 1;
	// 无参箭头闭包先用当前random求hash再自增，不是每次重置种子；函数不需要声明完整返回类型，TS可推断number。
	const next = () => hash(random++);
	// 参数直接解构[x,y,z]，按深度/行/列压成数字键；只在算法给定整格边界内用于判占位，不是通用无碰撞哈希。
	const key = ([x, y, z]: Cell3) => ((z + 1) * rows + y) * columns + x;
	// 依次生成12步，外层每轮都会新建本步占位与移动记录。
	for (let step = 0; step < PUZZLE_STEPS; step++) {
		// Set收集本步开始时所有占位；下面只add目标，不delete源格，所以同一步也不能借用刚腾出的旧格。
		const occupied = new Set(positions.map(key));
		// 展开浅复制位置数组，写新槽不会修改上一份steps快照；元组没移动时仍共享。
		const nextPositions = [...positions];
		// 本步已移动块索引集合，让一个块同一步最多选一次。
		const moved = new Set<number>();
		// 模型策略接下一伪随机数决定目标次数；这是愿望数量，后面无候选可提前break。
		const moveCount = model.puzzleMoves(next());
		// 尝试达到该次数，每次重新枚举候选，已占的新目标参与后续过滤。
		for (let move = 0; move < moveCount; move++) {
			// 候选数组元素包含块索引和目标格；Array<{...}>是泛型数组类型，不在运行时校验对象。
			const candidates: Array<{ block: number; target: Cell3 }> = [];
			// 逐块看能否移动，顺序与模型blocks一致。
			for (let block = 0; block < positions.length; block++) {
				// 已在本步动过的块跳过，不允许同一块连续走多格。
				if (moved.has(block)) continue;
				// 从本步初始positions读此块位置；!只影响类型检查，不对不存在下标加保护。
				const [x, y, z] = positions[block]!;
				// 解构遍历每种邻格位移；重复xy位移仍各枚举一次。
				for (const [dx, dy, dz] of PUZZLE_MOVES) {
					// 逐分量相加构造新目标元组，不原地改原坐标。
					const target: Cell3 = [x + dx, y + dy, z + dz];
					// x/y出原位图外框就continue，不给块从图案四周飞出。
					if (target[0] < 0 || target[0] >= columns || target[1] < 0 || target[1] >= rows) continue;
					// 深度超三层或目标已占就跳过，||短路；占位含本步初始格及此前选过的新目标。
					if (target[2] < -1 || target[2] > 1 || occupied.has(key(target))) continue;
					// 合法候选压入数组，block/target均用属性简写。
					candidates.push({ block, target });
				}
			}
			// Prefer blocks that did not just move, so the puzzle does not look like one block jittering.
			// filter建立上一步未移动过的候选数组，仅用于偏好，不改变原candidates。
			const fresh = candidates.filter((candidate) => !lastMoved.has(candidate.block));
			// 有fresh就用它，否则退回所有候选，保证偏好不会阻止其他可行移动。
			const pool = fresh.length > 0 ? fresh : candidates;
			// 用[0,1)hash乘长度后floor取下标；pool空时下标也无元素，choice为undefined而非抛错。
			const choice = pool[Math.floor(next() * pool.length)];
			// 无候选时只跳出本步内层move循环，外层仍保存该步并继续后面步骤。
			if (!choice) break;
			// 把选中目标加入占位集合，未删除旧格；避免本步另一块同时进入同一目标或刚腾出的源格。
			occupied.add(key(choice.target));
			// 只替换nextPositions中该块的元组引用，原positions和家坐标不改。
			nextPositions[choice.block] = choice.target;
			// 登记该索引本步已动，不再加入接下来候选。
			moved.add(choice.block);
		}
		// 清掉上一轮lastMoved内容，这时旧偏好已用完。
		lastMoved.clear();
		// 把本步动过的块记成下一步的lastMoved；不拷贝moved集合本身。
		for (const block of moved) lastMoved.add(block);
		// 将本步完成数组设为下一步起点；旧数组已留在steps中不再写。
		positions = nextPositions;
		// 追加本步快照，所以没有移动的步骤也仍占一份位置数组。
		steps.push(positions);
	}
	// 返回全部快照，不启动计时、不直接改屏幕；blockOffsets会按时间在相邻快照间插值。
	return steps;
}

// 请求帧间隔约33.3毫秒，即30fps目标，不是系统能严格达到的刷新保证。
const FRAME_MS = 1000 / 30;
// 每格尘埃从初始点数到消失用0.35秒。
const DUST_DURATION = 0.35;
// 分解波从起点向远处传播最多再增加0.55秒。
const WAVE_SPREAD = 0.55;
// 每格额外最多约0.12秒稳定抖动，使边缘不完全齐刷刷。
const WAVE_JITTER = 0.12;
// 分解结束界限把起步、传播、抖动与尘埃时长相加，用于跳过已经空了的文字层。
const DISSOLVE_END = FLY_START + WAVE_SPREAD + WAVE_JITTER + DUST_DURATION;
// 旧背景色向终端默认背景过渡的时长0.5秒。
const BACKGROUND_FADE = 0.5;
// 首次关闭后的收回阶段按1.1秒归一化，第二次关闭可提前结束。
const EXIT_DURATION = 1.1;
// A faint starfield fades in behind the logo once the screen has dissolved.
// 星空从2.5秒开始显现，早于此时starAlpha为0。
const STARS_START = 2.5;
// 星空渐入过程2秒，不是星星的单次闪烁周期。
const STARS_FADE = 2;
// 确定性hash阈值约使1.8%的格有星点，不保证每个屏幕恰好这一比例。
const STAR_DENSITY = 0.018;
// Star tints: neutral, pale blue, pale gold, and pale rose, each mixed half with the terminal's foreground.
// 星点四种偏色列表，与终端前景各混一半后，从背景向该混合色按小权重插值；不是直接画纯白/纯彩色大点。
const STAR_TINTS: Rgb[] = [
	// 中性白偏色。
	[255, 255, 255],
	// 淡蓝偏色。
	[170, 195, 255],
	// 淡金偏色。
	[255, 225, 170],
	// 淡玫瑰偏色。
	[255, 190, 205],
];
// 标识颜色每通道按5量化，让相邻点阵格更常复用同一ANSI色。
const LOGO_COLOR_STEP = 5;
// On light backgrounds most of each braille cell shows the bright background, which washes the logo out. There,
// the logo gets a halo: its colors and coverage blurred into the cell backgrounds, strongest under the logo and
// fading out over HALO_RADIUS_X columns and HALO_RADIUS_Y rows (cells are about twice as tall as wide).
// 亮背景下给模型周围叠少量彩色背景晕，最大基础强度0.3。
const LIGHT_HALO_STRENGTH = 0.3;
// 光晕横向滤波半径6终端列。
const HALO_RADIUS_X = 6;
// 光晕纵向半径3终端行，以补偿一行通常比一列更高。
const HALO_RADIUS_Y = 3;
// 光晕强度按1/32步长量化，不是32种固定RGB色，也不代表含端点恰好只有32个可能值。
const HALO_LEVELS = 32;
// 星空整体渐入强度按1/8步长量化，0与1也包括在内，减少每帧细微颜色变化。
const STAR_ALPHA_LEVELS = 8;
// 每颗星的正弦闪烁再按1/3步长量化，正常取0、1/3、2/3、1四种强度。
const STAR_FLICKER_LEVELS = 3;
// 返回提示在飞行结束后0.5秒内渐入。
const HINT_FADE = 0.5;

// Braille dot bits, indexed by row * 2 + column within the 2x4 cell.
// 按格内row*2+column查盲文位：左列点1/2/3/7，右列4/5/6/8，并非简单逐行递增位序。
const DOT_BITS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];
// Array.from用长度对象生成全部256种8位盲文字符；_是未用的元素参数，bits是下标，0x2800是空盲文码位。
const BRAILLE = Array.from({ length: 256 }, (_, bits) => String.fromCharCode(0x2800 + bits));
// 把固定灯光方向归一化为单位向量，供面法线点积求漫反射。模块求值会做这次数学运算，不触终端。
const LIGHT = normalize([-0.45, -0.6, 0.75]);
// 灯光方向与面向相机的[0,0,1]方向相加后归一化，作为高光的半程向量。
const HALF_VECTOR = normalize([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);

// 把三维向量缩成长度1，输入只读三元组、返回新可写三元组；例[0,0,2]得[0,0,1]。纯计算但未处理零长度，零向量会产生NaN。
function normalize(v: readonly [number, number, number]): [number, number, number] {
	// hypot算欧几里得长度，不改变输入数组。
	const length = Math.hypot(v[0], v[1], v[2]);
	// 逐分量除长度并创建新数组；readonly只是输入类型限制，不是计算时自动复制。
	return [v[0] / length, v[1] / length, v[2] / length];
}

// 将有限普通数夹在0..1供动画插值，返回number；例-0.2→0、1.2→1。不是数字校验器，NaN两比较均false仍返回NaN。
function clamp01(value: number): number {
	// 嵌套三元先判断低于0，再判断高于1，否则保留原值；Infinity会到1，-Infinity到0。
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Quintic smoothstep. */
// 五次平滑插值：输入进度、返回0..1曲线，两端变化更柔和；例0→0、0.5→0.5、1→1。纯计算，不推进实际时钟。
function smooth(value: number): number {
	// 先夹进度，让普通越界值停在端点，而不是继续延长曲线。
	const t = clamp01(value);
	// 计算6t五次方-15t四次方+10t三次方，乘法展开避免额外函数；端点一阶/二阶导数都为0。
	return t * t * t * (t * (t * 6 - 15) + 10);
}

// 三次减速曲线，接进度返回先快后慢的插值权重；例0.5→0.875，关闭时用来把朝向转回整圈。
function easeOut(value: number): number {
	// 先把进度夹住再取剩余量1-t。
	const t = 1 - clamp01(value);
	// 用1减剩余量立方，结果从0趋向1。
	return 1 - t * t * t;
}

// 按amount线性混合两个RGB，返回新元组；例红与蓝各一半得到[127.5,0,127.5]。直接混编码数值，未做sRGB线性化/范围裁剪或四舍五入。
function mix(a: Rgb, b: Rgb, amount: number): Rgb {
	// 三个通道各算a+(b-a)*amount；amount超0..1会外推，不由函数强制变成合法颜色。
	return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount];
}

// 整数位混合生成稳定[0,1)伪随机数，接种子、返回number；相同种子取同值。纯计算，不是密码学哈希或安全随机数，位运算会把number截到32位。
function hash(value: number): number {
	// 异或常量后用imul作32位整数乘法，保留低32位，与普通浮点乘法语义不同。
	let x = Math.imul(value ^ 0x9e3779b9, 0x85ebca6b);
	// 无符号右移13位后异或回去，^=原地更新局部x。
	x ^= x >>> 13;
	// 第二个常量再做32位混合。
	x = Math.imul(x, 0xc2b2ae35);
	// 再用16位移位混合高低位。
	x ^= x >>> 16;
	// x>>>0转无符号32位整数，再除2的32次方，所以普通结果小于1。
	return (x >>> 0) / 0x100000000;
}

/** Whether a background is light, by relative luminance. */
// 按RGB加权阈值判断本动画是否走亮背景光照，输入元组直接解构；例白色true、黑色false。英文称relative luminance，但实现没有sRGB去伽马，不能当WCAG亮度计算。
function isLight([r, g, b]: Rgb): boolean {
	// 用原0..255通道加权和与128比较，只做粗分明暗，不校验取值或计算文字对比度。
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 128;
}

// 把项目Color转换成此文件Rgb元组，返回新数组；例如索引颜色先由colorToRgb映射，再取三个通道。类型不在运行时验证外部对象。
function toRgb(color: Color): Rgb {
	// 调用真实转换函数，并解构它返回的r/g/b字段。
	const { r, g, b } = colorToRgb(color);
	// 按红绿蓝顺序组元组，未在本层量化。
	return [r, g, b];
}

/** Braille dots a glyph turns into, a rough measure of how much ink it has. */
// 粗估字符变尘埃时的点数，接文字与通常[0,1)seed，返回0/2/3/4..6；例空白0、句点2、框线3。不是字体栅格化；seed范围由调用方hash约定。
function glyphInk(text: string, seed: number): number {
	// trim后空串就当无墨迹，Unicode空白也会走此分支。
	if (text.trim() === "") return 0;
	// 单个所列标点给2点；^/$限制整个字符串，不会把一整句都归为低墨量。
	if (/^[.,:;'`\-_·]$/.test(text)) return 2;
	// 单个U+2500..U+257F制表框线字符给3点。
	if (/^[\u2500-\u257f]$/.test(text)) return 3;
	// 其余字符按seed分3档得到4/5/6点；未在此夹住任意异常seed。
	return 4 + Math.floor(seed * 3);
}

// 默认Intl.Segmenter按字素分段，让组合音标/emoji序列尽量作为一个字素处理，不直接按UTF-16码元循环；一个字素可能占两终端列，不等于单格。
const segmenter = new Intl.Segmenter();

/** Parse rendered lines into cells with resolved colors. Other escape sequences (OSC, APC, cursor) are skipped. */
// 把旧屏幕逻辑行解析成带颜色的终端列槽，接行数组/最大列数/默认前景背景，返回二维ScreenCell数组；例一个两列中文字会生成宽2首槽和宽0续槽。
// 每行重置颜色状态→扫描ESC序列→解析有限SGR颜色/反色/变暗→字素分段并限宽。纯字符串/颜色计算，不回读终端、不执行光标移动；未知样式会略过，未闭合字符串控制序列会丢弃该行余部，短行不补齐。
// 不是任意ANSI的健壮容错器：索引色最终交indexedColor校验，坏索引可同步抛错；没有外层catch统一退回原文字。
function parseScreen(
	// readonly string[]只禁止经参数改数组；输入仍是逻辑行，不包括真实终端状态机的完整历史。
	lines: readonly string[],
	// width是最多保留多少显示列，不按字符串length直接切片。
	width: number,
	// 没有显式文字色时使用的RGB前景。
	foreground: Rgb,
	// 供反色与变暗混合的默认背景；普通无显式背景格的bg仍保持undefined。
	background: Rgb,
	// Array<Array<ScreenCell>>与ScreenCell[][]等价，是每行一个列槽数组。
): Array<Array<ScreenCell>> {
	// 局部箭头palette把索引颜色经项目Color转换成RGB；indexedColor会拒绝非整数/超0..255索引并抛错，使用固定参考色表而非查询终端自定义调色板。
	const palette = (index: number): Rgb => toRgb(indexedColor(index));
	// map每条输入行都输出一个新槽数组，即使该行没有可见文字也保留空数组。
	return lines.map((line) => {
		// 该行自己的输出数组，长度作为已经占用的终端列数。
		const cells: ScreenCell[] = [];
		// 未设置显式前景；number元组或undefined组成联合类型，稍后可被SGR改变。
		let fg: Rgb | undefined;
		// 未设置显式背景；状态不从上一条逻辑行继承。
		let bg: Rgb | undefined;
		// 本行起始不变暗，遇SGR2开启、22/0关闭。
		let dim = false;
		// 本行起始不反色，遇SGR7开启、27/0关闭。
		let inverse = false;
		// 行内闭包解释一次SGR参数串并修改fg/bg/dim/inverse，不直接输出文字；例31;2设红前景并变暗。
		// 仅处理下列颜色/重置/反色/变暗编号，不复刻所有终端SGR（如粗体、下划线）；数字内容来自控制序列这一文本边界，解析宽松。
		const applySgr = (params: string) => {
			// 空参数整体按重置0处理，否则按分号分组；中间空项未统一补0，parseInt空串会得NaN。
			const codes = params === "" ? ["0"] : params.split(";");
			// 按参数顺序应用；扩展颜色分号格式会在循环内额外推进i跳过它消费的分量。
			for (let i = 0; i < codes.length; i++) {
				// 一组再按冒号拆开并parseInt为十进制；该解析接受数字前缀，失败为NaN，不是严格全串整数校验。
				const parts = codes[i]!.split(":").map((part) => Number.parseInt(part, 10));
				// 先取首个码；??只在null/undefined时补0，NaN不会触发回退。
				const code = parts[0] ?? 0;
				// 38/48分别是扩展前景/背景，进入后才解析模式5索引色或模式2真彩色。
				if (code === 38 || code === 48) {
					// Extended color, either as `38;5;n` / `38;2;r;g;b` or colon sub-parameters.
					// 声明扩展色参数数组，稍后的两条分支都会给它赋值。
					let args: number[];
					// 有冒号子参数就按同一组处理，不再从后面的分号组取分量。
					if (parts.length > 1) {
						// 去掉主码，过滤所有NaN（包含空色彩空间占位），不检查每一分量在0..255内。
						args = parts.slice(1).filter((part) => !Number.isNaN(part));
						// `38:2::r:g:b` has an empty color space id, dropped above.
						// 没有冒号子参数时改从后续分号组取模式/分量，两个分支最终都写到同一args数组变量。
					} else {
						// 分号格式从下一组读颜色模式；缺项按空串解析仍得NaN。
						const kind = Number.parseInt(codes[i + 1] ?? "", 10);
						// 模式5消费模式+索引共2项，模式2消费模式+RGB共4项，其余模式也消费1项。
						const count = kind === 5 ? 2 : kind === 2 ? 4 : 1;
						// 切取对应项再逐个parseInt；缺少分量可能得到更短数组，坏内容可保留NaN。
						args = codes.slice(i + 1, i + 1 + count).map((part) => Number.parseInt(part, 10));
						// 推进外层下标，for结尾还会i++，所以本次消费过的色分量不再当普通SGR处理。
						i += count;
					}
					// 先设候选色未定义；只识别下面两种模式才赋值。
					let color: Rgb | undefined;
					// 模式5且第二项不是undefined时映射索引；此行不自行验证，但palette里的indexedColor会拒绝NaN/越界/非整数并同步抛错。
					if (args[0] === 5 && args[1] !== undefined) color = palette(args[1]);
					// 模式2至少四项时取RGB，!只是TS非空断言，不会挡住NaN或越界数字。
					else if (args[0] === 2 && args.length >= 4) color = [args[1]!, args[2]!, args[3]!];
					// 有数组对象才应用扩展色，未识别模式不把现有颜色清空。
					if (color) {
						// 主码38更新前景，闭包让后续普通文字读取新状态。
						if (code === 38) fg = color;
						// 这里剩余主码为48，更新背景。
						else bg = color;
					}
					// 普通码0重置本解析器保留的四项状态，不在输出中直接追加SGR0。
				} else if (code === 0) {
					// 清显式前景，后面文字再回退foreground。
					fg = undefined;
					// 清显式背景，保留默认背景的undefined语义。
					bg = undefined;
					// 关闭本解析器模拟的变暗。
					dim = false;
					// 关闭反色，不改变原默认色。
					inverse = false;
					// SGR2开启变暗，实际视觉在pushText用混色近似实现。
				} else if (code === 2) dim = true;
				// SGR22关闭变暗；本解析器没有另外维护粗体状态。
				else if (code === 22) dim = false;
				// SGR7让文字前景/背景在输出槽里交换。
				else if (code === 7) inverse = true;
				// SGR27取消反色。
				else if (code === 27) inverse = false;
				// 30..37映射调色板前8个前景索引。
				else if (code >= 30 && code <= 37) fg = palette(code - 30);
				// 90..97映射亮色前景索引8..15。
				else if (code >= 90 && code <= 97) fg = palette(code - 90 + 8);
				// 39只清前景，其他状态不改。
				else if (code === 39) fg = undefined;
				// 40..47映射背景索引0..7。
				else if (code >= 40 && code <= 47) bg = palette(code - 40);
				// 100..107映射亮色背景索引8..15。
				else if (code >= 100 && code <= 107) bg = palette(code - 100 + 8);
				// 49只清背景；未列出的码或NaN都不会命中这些分支。
				else if (code === 49) bg = undefined;
			}
		};
		// 行内闭包把普通文本追加为列槽，捕获当前颜色/样式；没有返回新数组，直接修改本行cells。
		// 例如中英混合按每个字素的显示宽度占槽，宽字符第二槽浅复制颜色与时序字段；超宽字素被continue跳过，后面更窄文字仍可能写入。
		const pushText = (text: string) => {
			// 对Intl.Segmenter产出的记录解构segment，迭代单位是字素，不是字符串的每个UTF-16码元。
			for (const { segment } of segmenter.segment(text)) {
				// 用项目显示宽度函数判断该字素占几终端列。
				const glyphWidth = visibleWidth(segment);
				// 零宽或放不下的字素跳过；这是continue而非break，不停止剩余文本扫描，也不在此补空格。
				if (glyphWidth === 0 || cells.length + glyphWidth > width) continue;
				// 显式fg不存在才用默认前景；??不按真假判断。
				let cellFg = fg ?? foreground;
				// 背景先取显式bg，无指定仍可为undefined。
				let cellBg = bg;
				// 反色打开时把两侧解析成明确的交换颜色。
				if (inverse) {
					// 反色文字采用显式背景或默认背景。
					cellFg = bg ?? background;
					// 反色背景采用显式前景或默认前景，原来未指定背景也会在此变明确。
					cellBg = fg ?? foreground;
				}
				// 变暗近似为文字色往有效背景混40%，不保留SGR2样式标签让终端再处理。
				if (dim) cellFg = mix(cellFg, cellBg ?? background, 0.4);
				// 构造该字素首槽，延迟/墨点/种子先0，后面prepareCells按位置补；属性text/width不是简写，其余fg/bg也显式映射局部名。
				const cell = { text: segment, width: glyphWidth, fg: cellFg, bg: cellBg, delay: 0, ink: 0, seed: 0 };
				// 把首槽压入行数组，此时数组长度增加1。
				cells.push(cell);
				// 显示宽2时再浅展开首槽生成续槽，覆盖text空串/width0；颜色元组仍共享，不复制字符串内容。
				if (glyphWidth === 2) cells.push({ ...cell, text: "", width: 0 });
			}
		};
		// i记录原逻辑行内的UTF-16偏移；它与输出cells.length的显示列数是两套坐标。
		let i = 0;
		// 扫描到原行末，控制序列自己不占输出列槽。
		while (i < line.length) {
			// 从当前偏移找下一个ESC字节对应字符；未实现C1单字符控制码的完整解析。
			const sequenceStart = line.indexOf("\x1b", i);
			// 后面再无ESC，就把剩余串全部按普通文本处理。
			if (sequenceStart === -1) {
				// slice取剩余文本交pushText，再按字素宽度过滤。
				pushText(line.slice(i));
				// 原行已经处理完，跳出while，不是丢弃当前cells。
				break;
			}
			// ESC之前有普通文本就先写槽；ESC紧接当前偏移时不造空槽。
			if (sequenceStart > i) pushText(line.slice(i, sequenceStart));
			// 读ESC后一个字符识别CSI或字符串控制序列，末尾孤立ESC会得到undefined。
			const kind = line[sequenceStart + 1];
			// ESC[为CSI；其中只有最终字母m才修改样式，光标移动等CSI被跳过。
			if (kind === "[") {
				// 从ESC和[之后开始找终结字节。
				let end = sequenceStart + 2;
				// 向后走到0x40..0x7e最终字节或行尾；这里不验证CSI中间所有字节是否合法。
				while (end < line.length && (line.charCodeAt(end) < 0x40 || line.charCodeAt(end) > 0x7e)) end++;
				// 只有m才把中间参数交applySgr，其他CSI不移动虚拟光标。
				if (line[end] === "m") applySgr(line.slice(sequenceStart + 2, end));
				// 跳过最终字节；若原CSI无终结符，end在行尾，后续自然结束。
				i = end + 1;
				// OSC/APC/DCS/PM四类字符串序列统按下方BEL或ST规则跳过；不是所有终端协议的完整状态机。
			} else if (kind === "]" || kind === "_" || kind === "P" || kind === "^") {
				// String sequences end at BEL or ST (ESC \).
				// 搜索BEL终止字符，indexOf返回-1表示没有。
				const bell = line.indexOf("\x07", sequenceStart + 2);
				// 搜索ST两个字符ESC加反斜杠，字符串里的转义是原运行数据，不应插入中文。
				const st = line.indexOf("\x1b\\", sequenceStart + 2);
				// 两种终止符都没有就停止整条行的解析，剩余部分不会当普通文字显示。
				if (bell === -1 && st === -1) break;
				// 取较早出现的BEL/ST并越过其1/2字符；同一套规则也用于APC/DCS/PM，不据此承诺完全符合每种协议。
				i = bell !== -1 && (st === -1 || bell < st) ? bell + 1 : st + 2;
				// 未识别的ESC类型走通用略过分支。
			} else {
				// 只跨过ESC和紧随一个字符，不完整处理多字节的所有其他转义形式。
				i = sequenceStart + 2;
			}
		}
		// 交回此行已有槽，不主动填到width，所以后面render要为缺格生成星星或空白。
		return cells;
	});
}

/** Row-major 3x3 rotation matrix for yaw (y), then pitch (x), then roll (z). */
// 生成按行存放的3×3旋转矩阵，输入yaw/pitch/roll弧度，返回长度9的number[]；依次绕y、x、z轴。纯计算，数组类型没静态强制恰好9项。
function rotation(yaw: number, pitch: number, roll: number): number[] {
	// 右侧先算六个正余弦，再通过数组解构绑定sy/cy/sx/cx/sz/cz。
	const [sy, cy, sx, cx, sz, cz] = [
		// yaw的正弦，供绕y轴矩阵使用。
		Math.sin(yaw),
		// yaw的余弦。
		Math.cos(yaw),
		// pitch的正弦，供绕x轴矩阵使用。
		Math.sin(pitch),
		// pitch的余弦。
		Math.cos(pitch),
		// roll的正弦，供绕z轴矩阵使用。
		Math.sin(roll),
		// roll的余弦，最后一项后逗号不增加数组元素。
		Math.cos(roll),
	];
	// Rz * Rx * Ry
	// y轴旋转矩阵按三行摊平，正负正弦位置决定本动画的旋转方向。
	const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
	// x轴旋转矩阵，x分量不变，y/z互相混合。
	const rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
	// z轴旋转矩阵，z分量不变，x/y互相混合。
	const rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
	// 矩阵从右向左作用于列向量：先Ry、再Rx、最后Rz；矩阵乘法顺序不能随意交换。
	return multiply(rz, multiply(rx, ry));
}

// 把两个按行摊平的3×3矩阵相乘，返回新9项数组；例a是单位矩阵时结果等于b。输入number[]未验证长度，!不提供运行时保护。
function multiply(a: number[], b: number[]): number[] {
	// 先创建9槽数组，此时还是空槽，后面的双循环会逐项赋值。
	const result = new Array<number>(9);
	// 枚举结果行0..2。
	for (let row = 0; row < 3; row++) {
		// 每行枚举结果列0..2。
		for (let column = 0; column < 3; column++) {
			// 按row*3+column定位一维结果槽，等号右侧跨到下一行。
			result[row * 3 + column] =
				// a的当前行与b的当前列做三项点积；b索引column、3+column、6+column对应三行，同列相乘求和。
				a[row * 3]! * b[column]! + a[row * 3 + 1]! * b[3 + column]! + a[row * 3 + 2]! * b[6 + column]!;
		}
	}
	// 返回已填写的数组，不更改a或b，也不创建矩阵类实例。
	return result;
}

// 旋转与拼图共用周期：方块回家后的停留中点，模型按设计正面朝相机，而不是另起一个无关旋转计时器。
// The spin is locked to the puzzle: one turn per cycle, facing the camera in the middle of each hold.
// 启动加速用1.4秒；单位与下面time相同，不是帧数或旋转圈数。
const SPIN_RAMP = 1.4;
// 基础相位匀速段的角速度为每个拼图周期转2π弧度，即一整圈；最终yaw另有正面减速修正，不恒速。PUZZLE_CYCLE含洗牌、回家和停留三段。
const SPIN_SPEED = (Math.PI * 2) / PUZZLE_CYCLE;
// How much the spin slows down while facing the camera (and speeds up while facing away), from 0 to 1.
// 0.6控制正面减速/背面加速程度，不是整体速度直接乘0.6；后面用它乘sin相位修正角度。
const SPIN_LINGER = 0.6;
// 首个正面时刻放在第一次洗牌结束、回家完成后的停留中点；不是PUZZLE_START就已经归位朝前。
const FIRST_FRONT_VIEW = PUZZLE_START + PUZZLE_STEP * PUZZLE_STEPS + PUZZLE_RETURN + PUZZLE_HOLD / 2;

/** Uniform spin that accelerates from rest over SPIN_RAMP, then turns at SPIN_SPEED. */
// 计算未加对齐修正的累计旋转相位，输入动画开始后的秒数，返回弧度，无状态修改或I/O。例time≤FLY_START返回0；过启动1.4秒后按固定角速度继续累积，不把角度限制在一圈内。
function baseSpinPhase(time: number): number {
	// 从起飞开始算经过时间，动画最初FLY_START秒还不启动旋转。
	const elapsed = time - FLY_START;
	// 起飞前或恰到起点时直接返回0，避免负时间继续代入加速多项式。
	if (elapsed <= 0) return 0;
	// 将加速段时间除以1.4秒得到u；u<1在加速段，后面不再需要把它夹回1。
	const u = elapsed / SPIN_RAMP;
	// Integral of the quintic smoothstep ramp.
	// 这是五次smoothstep速度曲线的积分，**表示乘方；积分让角速度从0平滑升至SPIN_SPEED，u=1时累计半个加速段的匀速相位。
	if (u < 1) return SPIN_SPEED * SPIN_RAMP * (u ** 6 - 3 * u ** 5 + 2.5 * u ** 4);
	// 加速结束后接上0.5×SPIN_RAMP的已积相位，再加剩余时间×稳定角速度，边界处相位连续。
	return SPIN_SPEED * (SPIN_RAMP * 0.5 + elapsed - SPIN_RAMP);
}

// Extra rotation added during the flight, so the phase is a whole number of turns at every assembled front view.
// 求首个正面时刻还差多少弧度到下一整圈；%取余而非角度单位转换，若恰为整圈该表达式仍给2π，修正稍后在飞行中渐进加入。
const SPIN_ALIGNMENT = Math.PI * 2 - (baseSpinPhase(FIRST_FRONT_VIEW) % (Math.PI * 2));

/** Spin phase: whole turns exactly when the reassembled logo faces the camera. */
// 计算实际累计相位，输入秒数返回弧度，不修改计时器；例起飞前为0，飞行结束后对齐项固定，之后每个拼图周期仍多一整圈。只改数值，不渲染。
function spinPhase(time: number): number {
	// 基础相位加“对齐角×飞行smooth进度”；smooth会夹0..1，故对齐只在飞行期间渐变，不在每次拼图回家时突跳角度。
	return baseSpinPhase(time) + SPIN_ALIGNMENT * smooth((time - FLY_START) / FLY_DURATION);
}

/** Yaw of the logo. It matches the phase at whole turns but lingers there, so the logo reads from the front. */
// 把相位变成更便于看清正面的yaw，输入秒数返回弧度，无副作用；例相位π/2时减0.6弧度，整圈处数学上不偏离原相位，但附近转得慢。
function spinAngle(time: number): number {
	// 先取已与拼图对齐的相位，避免用另一套独立时钟。
	const phase = spinPhase(time);
	// 减去0.6×sin相位；角度对相位的导数为1−0.6cos，正面附近0.4、背面附近1.6，改变局部快慢而不把累计角度归零。
	return phase - SPIN_LINGER * Math.sin(phase);
}

// 保存一个候选方块面的几何边界、投影包围盒和统一照明色；interface只描述数据，真正可见性与射线命中在后面计算。
interface Face {
	// 面垂直哪条物体坐标轴，循环实际给0/1/2；number类型本身不把外部值限成这三项。
	axis: number;
	/** Plane coordinate on `axis` in object space. */
	// 该轴上的平面坐标，例axis=2、plane=0.35表示物体空间z=0.35的面。
	plane: number;
	// 面内第一个轴u的最小坐标；u按(axis+1)%3选，不总是x轴。
	uMin: number;
	// 面内u轴最大坐标，命中测试包含边界。
	uMax: number;
	// 面内另一个轴v的最小坐标，v按(axis+2)%3选。
	vMin: number;
	// 面内v轴最大坐标；与u边界共同限定一块矩形面。
	vMax: number;
	/** Projected bounds in braille dots, inclusive. */
	// 投影包围盒左边界，单位是盲文点，不是终端字符列。
	minX: number;
	// 投影包围盒上边界，后面逐点循环包含此行。
	minY: number;
	// 投影包围盒右边界，包含端点；由四角投影向上取整并夹到点阵范围。
	maxX: number;
	// 投影包围盒下边界，包含端点，非数组slice的半开结束位置。
	maxY: number;
	// 这一面统一的受光红通道值，雾化尚未按各点深度加入。
	red: number;
	// 这一面统一的受光绿通道值，不是原始品牌色未经处理的值。
	green: number;
	// 这一面统一的受光蓝通道值，稍后与背景按雾化系数混合。
	blue: number;
}

/**
 * Renders the model's blocks into braille cells. Only faces that point at the camera and are not covered by a
 * touching block are drawn. Each face is rasterized over its projected bounds by intersecting each dot's ray
 * with the face's plane, with a depth buffer resolving overlaps. Buffers are reused between frames.
 */
// 方块光栅器把三维面变成终端盲文点与颜色缓冲；上层动画按帧调render，再读取这些数组拼ANSI行。本类不直接写终端，也不设置动画timer。
class BlockRaster {
	/** Braille dot bits per cell. */
	// 每终端格用8位保存2×4个盲文点是否点亮；先建空Uint8Array，尺寸确定后分配。
	bits = new Uint8Array(0);
	/** Lit dots per cell. */
	// 每格记录最终可见点数，正常为0..8，供平均颜色和光晕覆盖率使用，不是有几块方块压在此格。
	counts = new Uint8Array(0);
	/** Summed RGB of the lit dots per cell. */
	// 每格3个Float32元素累计可见点RGB之和，读出时上层再除点数；初始不是最终平均色。
	rgb = new Float32Array(0);
	/** Halo tint strength per cell, from 0 to 1. Only set when a halo was requested. */
	// 每格一个浮点光晕强度，正常调用者给0或0.3请求光晕；数组初始为空，不在字段声明时扫描屏幕。
	haloAmount = new Float32Array(0);
	/** Halo color per cell. */
	// 每格3个光晕RGB分量；它保存独立色值，具体混合强度另看haloAmount。
	haloRgb = new Float32Array(0);
	// 缓存上次分配的终端列数，private是TS访问限制，不是JS的#私有字段。
	private width = 0;
	// 缓存终端行数，列或行改变都会重建所有尺寸相关缓冲。
	private height = 0;
	/** Ray parameter of the nearest hit per dot; smaller is nearer. */
	// 每个盲文点保存最近命中的射线参数t，用Float32Array存储；它不是欧氏距离，初次分配后会填Infinity。
	private depth = new Float32Array(0);
	/** Face index + 1 of the nearest hit per dot, 0 for none. */
	// 每个点保存命中面下标+1，0留作未命中；Uint16Array有16位整数容量，不是任意大小的JS整数表。
	private faceIds = new Uint16Array(0);
	/** Cells written by the previous frame, cleared before the next one. */
	// 上次写过模型点的终端格矩形，可undefined表示没有；内联对象类型规定四个数字字段，| undefined表示可缺记录。
	private dirty: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
	/** Cells with a halo from the previous frame, cleared before the next one. */
	// 上次光晕写入的格矩形，与模型dirty独立，因为光晕会扩散到更大区域。
	private haloDirty: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
	// 保存物体尺度中的相机距离；readonly禁止TS正常代码重赋，构造时仍需显式赋值。
	private readonly cameraDistance: number;

	// 输入相机距离初始化光栅器，返回实例，无渲染/I/O；例距离10来自pi标识模型。这里只保存数值，不检查正数、相机是否在所有方块之外，也不预分配整屏缓冲。
	constructor(cameraDistance: number) {
		// 把参数写入字段供后续透视投影、反向射线和雾化共用，避免每帧另传一份相机距离。
		this.cameraDistance = cameraDistance;
	}

	// 把这一帧的方块绘到内部盲文/颜色缓冲，输入终端尺寸、姿态、方块、背景和光晕强度，返回void；例10列×3行对应20×12采样点，不直接返回字符行。
	render(
		// 终端字符列数，后面每列展开为两个水平盲文点；正常由宿主给尺寸，不在此做数值校验。
		width: number,
		// 终端字符行数，每行展开四个垂直盲文点。
		height: number,
		// Pose提供点阵中心、每模型像素的点数以及yaw/pitch/roll，不在本方法内更新动画时间。
		pose: Pose,
		// 只读方块列表包含物体空间min/max与原色；readonly不运行时冻结对象，方法按约定只读它们。
		boxes: readonly Box[],
		// 终端背景RGB，既用于判断明暗风格，也用于远面雾化。
		background: Rgb,
		// 请求的光晕强度；正数才调用renderHalo，函数未把任意调用者的值强制夹到0..1。
		haloStrength: number,
		// 返回void意味着结果通过实例数组字段交上层消费；流程是清旧区→可见面→逐点选近面→打包格/颜色→可选光晕，无终端写入，分配/数据访问异常不在此捕获。
	): void {
		// 两点一列，计算整屏点阵宽度。
		const dotWidth = width * 2;
		// 四点一行，计算整屏点阵高度；一格共有8个采样点。
		const dotHeight = height * 4;
		// 尺寸有任一变化就整套重建，避免旧数组步长与新宽高错位。
		if (width !== this.width || height !== this.height) {
			// 先缓存新列数，后面的格索引用同一width。
			this.width = width;
			// 缓存新行数；字段更新和后续分配不是可回滚事务。
			this.height = height;
			// 每格一个盲文位掩码，新的整型数组初值全0。
			this.bits = new Uint8Array(width * height);
			// 每格一个点数计数器，初值全0。
			this.counts = new Uint8Array(width * height);
			// 为每格分配连续RGB三槽，Float32Array初值全0，元素个数不是字节数。
			this.rgb = new Float32Array(width * height * 3);
			// 光晕强度按格分配，不按每个盲文点分配。
			this.haloAmount = new Float32Array(width * height);
			// 光晕颜色仍每格连续3个浮点槽。
			this.haloRgb = new Float32Array(width * height * 3);
			// 新缓冲全空，旧光晕脏区不再适用，直接丢记录。
			this.haloDirty = undefined;
			// 深度按整个点阵分配并填Infinity，任何正常正t都比它近；fill按元素写值，不是按字节。
			this.depth = new Float32Array(dotWidth * dotHeight).fill(Infinity);
			// 面编号按点阵分配，初值0就是没有面命中。
			this.faceIds = new Uint16Array(dotWidth * dotHeight);
			// 模型脏区也丢弃，新缓冲无需再按旧矩形清理。
			this.dirty = undefined;
			// 尺寸未变且上帧确有模型区域时，只清该矩形的格缓冲，不每帧清整屏。
		} else if (this.dirty) {
			// 解构上次格矩形；坐标包含右/下边界。
			const { minX, minY, maxX, maxY } = this.dirty;
			// 逐行清理，从minY到maxY两端都包含。
			for (let row = minY; row <= maxY; row++) {
				// 把该行对应盲文位清0；TypedArray.fill结束索引不包含，所以右边界要+1。
				this.bits.fill(0, row * width + minX, row * width + maxX + 1);
				// 同一格区点数清0，避免新帧平均色混进上帧计数。
				this.counts.fill(0, row * width + minX, row * width + maxX + 1);
				// RGB每格3槽，起止格索引都乘3；这里是清通道累计数组，不是用黑色画终端。
				this.rgb.fill(0, (row * width + minX) * 3, (row * width + maxX + 1) * 3);
			}
			// 清理完成后忘掉旧模型矩形，新帧命中会再建立。
			this.dirty = undefined;
		}
		// 旧光晕单独清理，即使新帧不再请求光晕也不能留上一帧颜色。
		if (this.haloDirty) {
			// 取上次光晕矩形，不误用较小的模型dirty。
			const { minX, minY, maxX, maxY } = this.haloDirty;
			// 逐行处理光晕影响过的终端格。
			for (let row = minY; row <= maxY; row++) {
				// 将这些格的光晕强度清0，让上层不继续混入旧色。
				this.haloAmount.fill(0, row * width + minX, row * width + maxX + 1);
				// 同区域RGB三槽清0，结束索引同样包含原maxX格的三个通道。
				this.haloRgb.fill(0, (row * width + minX) * 3, (row * width + maxX + 1) * 3);
			}
			// 旧光晕矩形清理完毕；renderHalo若本帧有写入会重新设置。
			this.haloDirty = undefined;
		}

		// 按yaw→pitch→roll生成物体到相机的旋转矩阵，m按行存3×3共9项。
		const m = rotation(pose.yaw, pose.pitch, pose.roll);
		// 解构屏幕点阵中心与缩放；scale单位是盲文点/模型像素，射线反算要除它。
		const { centerX, centerY, scale } = pose;
		// 本次用局部变量读取固定相机距离，不修改实例。
		const cameraDistance = this.cameraDistance;
		// The camera sits at (0, 0, cameraDistance) in camera space; object space is the transpose rotation.
		// 相机空间位置(0,0,D)乘旋转转置Rᵀ，得到物体空间射线共同起点；所以使用原矩阵第三行m[6..8]乘D，!仅告知TS元素存在。
		const origin = [m[6]! * cameraDistance, m[7]! * cameraDistance, m[8]! * cameraDistance];
		// 用背景RGB加权阈值启发式决定明暗风格，不做WCAG线性化亮度计算。
		const light = isLight(background);
		// 先取朝向相机、未被单个贴邻方块完整遮住且保守投影包围盒与屏幕相交的候选面，内部还预先算每面照明色。
		const faces = this.visibleFaces(m, origin, pose, boxes, dotWidth, dotHeight, light);
		// 没有候选面就返回；前面的旧模型/光晕缓冲已清，不会直接保留旧画面。
		if (faces.length === 0) return;
		// 总点阵包围盒的左端先设最大候选dotWidth，方便后面取min。
		let minX = dotWidth;
		// 总上边界先设dotHeight，不是当前已知有点在屏幕底边。
		let minY = dotHeight;
		// 总右边界初始-1，表示尚未纳入任何候选面。
		let maxX = -1;
		// 总下边界同样-1。
		let maxY = -1;
		// 只遍历这帧候选面的屏内点阵矩形，合并成总扫描区。
		for (const face of faces) {
			// 左边界取所有候选面的最小minX。
			minX = Math.min(minX, face.minX);
			// 上边界取最小minY。
			minY = Math.min(minY, face.minY);
			// 右边界取最大maxX。
			maxX = Math.max(maxX, face.maxX);
			// 下边界取最大maxY；合并的是矩形，不是精确可见点集合。
			maxY = Math.max(maxY, face.maxY);
		}
		// 合并矩形为空则结束，不进入逐点射线循环。
		if (maxX < minX || maxY < minY) return;

		// 取深度数组原引用，写局部变量仍修改实例缓冲，不是复制。
		const depth = this.depth;
		// 同样取每点面编号数组原引用。
		const faceIds = this.faceIds;
		// 依候选面顺序逐面扫它的投影矩形，最后每个点只留下最近命中面。
		for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
			// 取本面，非空断言依赖循环下标范围；不会在运行时验证Face完整结构。
			const face = faces[faceIndex]!;
			// 取本面的垂直轴a，稍后用该轴坐标求射线与平面交点。
			const a = face.axis;
			// 第一个面内轴u按循环顺序选择；例a=2时u=0。
			const u = (a + 1) % 3;
			// 另一个面内轴v；例a=2时v=1，便于用x/y范围检查z平面的矩形。
			const v = (a + 2) % 3;
			// 射线共同起点在垂直轴上的坐标。
			const originA = origin[a]!;
			// 共同起点在面内u轴上的坐标。
			const originU = origin[u]!;
			// 共同起点在面内v轴上的坐标。
			const originV = origin[v]!;
			// The ray direction in object space is linear in the dot position, so it is stepped per dot.
			// 点阵x每增加1，反变换后射线方向a分量增加m[a]/scale；线性步进避免每点重做完整矩阵乘法。
			const stepA = m[a]! / scale;
			// 同一水平点步进对应u方向分量的增量。
			const stepU = m[u]! / scale;
			// 同一水平点步进对应v方向分量的增量，三分量都未归一化为单位向量。
			const stepV = m[v]! / scale;
			// 取面最左采样点中心的屏幕横坐标，再减中心/除缩放回到相机投影平面；+0.5是点中心而非点左边缘。
			const sx = (face.minX + 0.5 - centerX) / scale;
			// 逐点阵行扫描本面，minY/maxY均包含在内。
			for (let dotY = face.minY; dotY <= face.maxY; dotY++) {
				// 本行采样中心的相机平面y坐标，屏幕向下为正，沿用模型行坐标方向。
				const sy = (dotY + 0.5 - centerY) / scale;
				// 将相机空间方向(sx,sy,−D)乘Rᵀ，求物体轴a方向；let因下一水平点还要累加步长。
				let directionA = m[a]! * sx + m[3 + a]! * sy - m[6 + a]! * cameraDistance;
				// 同一反向旋转求面内u方向分量。
				let directionU = m[u]! * sx + m[3 + u]! * sy - m[6 + u]! * cameraDistance;
				// 同一反向旋转求面内v方向分量，不使用方块原色参与几何计算。
				let directionV = m[v]! * sx + m[3 + v]! * sy - m[6 + v]! * cameraDistance;
				// 当前点在整屏点阵一维数组的索引，不是终端格索引。
				let index = dotY * dotWidth + face.minX;
				// 扫描本面这一行的每个点，同时递增x与数组索引；for第三段逗号依次执行两个递增。
				for (let dotX = face.minX; dotX <= face.maxX; dotX++, index++) {
					// 解平面方程originA+t×directionA=plane得到t；此处不专门防0除，后面正向/近远和矩形比较决定是否接收。
					const t = (face.plane - originA) / directionA;
					// 只收相机前方t>0且比该点已记t更小的候选；比较的是同一条射线参数而非不同方向的欧氏距离，!不检查数组越界。
					if (t > 0 && t < depth[index]!) {
						// 把相交参数代回u轴，得到物体空间面内交点坐标。
						const hitU = originU + t * directionU;
						// 同样得到v轴交点，用于确认射线不是只打中无限延伸平面。
						const hitV = originV + t * directionV;
						// 交点须落在本矩形面的u/v闭区间内；投影包围盒只是粗筛，真正命中由这里决定。
						if (hitU >= face.uMin && hitU <= face.uMax && hitV >= face.vMin && hitV <= face.vMax) {
							// 记录较近t到Float32深度缓冲，存储会有浮点精度舍入，未加独立epsilon比较。
							depth[index] = t;
							// 面下标加1再写Uint16编号，保留0作为未命中；不会在这里混合所有重叠面的颜色。
							faceIds[index] = faceIndex + 1;
						}
					}
					// 移到下一个水平点前，给方向a分量加已预计算的线性步长。
					directionA += stepA;
					// 同时推进u方向分量。
					directionU += stepU;
					// 同时推进v方向分量；屏幕行变化时会重新按sy计算起始方向。
					directionV += stepV;
				}
			}
		}

		// Shade the hit dots, pack them into braille cells, and reset the dot buffers for the next frame.
		// 下一阶段从每点最近面生成格结果，取bits原数组引用。
		const bits = this.bits;
		// 取每格点数数组，后面一个成功点加1，不按候选面数加。
		const counts = this.counts;
		// 取每格RGB累计数组，上层将用点数求平均色。
		const rgb = this.rgb;
		// 这帧实际写到的格矩形左端初始width，后面命中才收缩。
		let cellMinX = width;
		// 实际格矩形上端初始height。
		let cellMinY = height;
		// 实际格矩形右端初始-1，区别于候选面总体投影边界。
		let cellMaxX = -1;
		// 实际格矩形下端初始-1。
		let cellMaxY = -1;
		// 逐行扫合并候选区，为有最近面编号的点着色，并在消费后复位点缓冲。
		for (let dotY = minY; dotY <= maxY; dotY++) {
			// 计算该扫描行左端的一维点索引，随内层循环推进。
			let index = dotY * dotWidth + minX;
			// 逐点读取光栅命中结果，数组步长使用dotWidth。
			for (let dotX = minX; dotX <= maxX; dotX++, index++) {
				// 0表示没有面命中；正整数是前面记录的面下标+1。
				const id = faceIds[index]!;
				// 没命中直接跳过，不为透明点占盲文位或加点数。
				if (id === 0) continue;
				// 编号减1取获胜面；这里只给最终可见面的颜色，不绘制被遮挡面。
				const face = faces[id - 1]!;
				// Points farther from the camera fade slightly toward the background for depth.
				// 按命中深度把远点更多混向背景；t=1对应相机空间z=0时基准雾化0.15，亮背景再乘0.5，clamp01只夹这一雾化系数。
				const fog = clamp01(0.15 - cameraDistance * (1 - depth[index]!) * 0.12) * (light ? 0.5 : 1);
				// 该点面编号已读完，清成0供下一帧复用。
				faceIds[index] = 0;
				// 该点深度复位Infinity；正常帧中已写的命中点都会在这里消费，因而不每帧重填整屏depth。
				depth[index] = Infinity;
				// 点横坐标右移1相当于非负整数除2取整，找到它属于哪一字符列。
				const cellX = dotX >> 1;
				// 点纵坐标右移2相当于除4取整，找到对应字符行。
				const cellY = dotY >> 2;
				// 用字符列数width计算格索引，不再用dotWidth。
				const cell = cellY * width + cellX;
				// 用行内0..3与列内0..1查DOT_BITS，再按位或点亮此格相应盲文位；!只消除TS可缺元素提示。
				bits[cell]! |= DOT_BITS[(dotY & 3) * 2 + (dotX & 1)];
				// 为这个最终可见点将格内计数加1；一格最多8个采样位置，不因多个面重叠重复计点。
				counts[cell]!++;
				// 红色按face.red与背景红通道线性混合后累加，不在本行除点数。
				rgb[cell * 3] += face.red + (background[0] - face.red) * fog;
				// 绿色做同样雾化混合并累加到第二通道槽。
				rgb[cell * 3 + 1] += face.green + (background[1] - face.green) * fog;
				// 蓝色做同样混合并累加到第三通道槽；三槽连续分布在同一个Float32Array。
				rgb[cell * 3 + 2] += face.blue + (background[2] - face.blue) * fog;
				// 命中格比当前左界更靠左就更新，避免下帧清比实际写区更大范围。
				if (cellX < cellMinX) cellMinX = cellX;
				// 更新实际写区右边界。
				if (cellX > cellMaxX) cellMaxX = cellX;
				// 更新实际写区上边界。
				if (cellY < cellMinY) cellMinY = cellY;
				// 更新实际写区下边界；四个if是独立判断，可能在一个点同时命中多条更新。
				if (cellY > cellMaxY) cellMaxY = cellY;
			}
		}
		// 至少写过一个格才记新dirty，坐标包含四边；没有写到点时仍保持undefined，不凭候选面矩形假定有可见内容。
		if (cellMaxX >= 0) this.dirty = { minX: cellMinX, minY: cellMinY, maxX: cellMaxX, maxY: cellMaxY };
		// 正光晕强度才计算扩散，内部若无dirty还会早返；暗背景调用方正常传0，不为它分配这一帧模糊临时数组。
		if (haloStrength > 0) this.renderHalo(haloStrength);
	}

	/**
	 * Blur the logo's coverage and color over neighboring cells with a separable tent filter, so the tint falls
	 * off smoothly past the logo's edges.
	 */
	// 由本帧已画格生成邻域光晕，输入强度，返回void并写haloAmount/haloRgb/haloDirty；例单格8点经横纵三角权重向附近格渐淡，原格至少保留自身覆盖率。先横向再纵向模糊，保底自身覆盖后量化强度/色值；会新建权重与临时数组，无I/O，分配或访问失败未捕获，也不回滚已写的缓冲。
	private renderHalo(strength: number): void {
		// 只以真正有模型点的dirty为源；不是把旧屏幕文字或星点一起模糊。
		const cells = this.dirty;
		// 没有模型点就不生成光晕，也不分配权重/临时数组。
		if (!cells) return;
		// 解构尺寸与当前格点数/RGB累计原数组；它们不是预先除过点数的平均颜色。
		const { width, height, counts, rgb } = this;
		// 光晕向左扩6列并夹到屏幕0边界。
		const minX = Math.max(0, cells.minX - HALO_RADIUS_X);
		// 向右扩6列，最多到width−1，两个端点都包含。
		const maxX = Math.min(width - 1, cells.maxX + HALO_RADIUS_X);
		// 向上扩3行；字符格约高于宽，横纵半径选不同数值。
		const minY = Math.max(0, cells.minY - HALO_RADIUS_Y);
		// 向下扩3行并夹到height−1，不在屏外分配halo格。
		const maxY = Math.min(height - 1, cells.maxY + HALO_RADIUS_Y);
		// 光晕区域宽为包含两端的maxX−minX+1，用于临时数组局部步长。
		const regionWidth = maxX - minX + 1;
		// 局部tent工厂接半径返回归一化三角形权重数组，无外部I/O；例radius=1生成[1,2,1]/4。当前只传固定非负整数，不额外验证任意半径；每次调用新建数组，未缓存卷积核。
		const tent = (radius: number) => {
			// 生成2r+1个权重，中心r+1最大、向两侧逐格减1；Array.from第二参数接元素占位和索引i，箭头只用索引。
			const weights = Array.from({ length: radius * 2 + 1 }, (_, i) => radius + 1 - Math.abs(i - radius));
			// reduce从0把所有权重求和，用来保持归一化核的总权重为1。
			const total = weights.reduce((sum, weight) => sum + weight, 0);
			// map把每个权重除总和，返回新浮点数数组，不原地修改原weights。
			return weights.map((weight) => weight / total);
		};
		// 按横向半径6生成13项核，归一化之前为1..7..1。
		const weightsX = tent(HALO_RADIUS_X);
		// 按纵向半径3生成7项核，归一化之前为1..4..1，两遍可分离处理。
		const weightsY = tent(HALO_RADIUS_Y);

		// Horizontal pass over the rows that contain the logo: coverage and premultiplied color per cell.
		// 水平处理只需要模型dirty实际含点的这些行，扩散出的上/下行由纵向一遍生成。
		const rows = cells.maxY - cells.minY + 1;
		// 每个临时格4个Float32槽：覆盖率与预乘覆盖的RGB；本临时数组每次halo调用新分配，与实例的常驻结果缓冲不同。
		const horizontal = new Float32Array(rows * regionWidth * 4);
		// 逐行处理模型dirty的纵向范围，含上下边界。
		for (let y = cells.minY; y <= cells.maxY; y++) {
			// 每行对扩宽后的整个光晕x区间计算水平模糊。
			for (let x = minX; x <= maxX; x++) {
				// 当前目标的水平覆盖率累计从0开始，最终不是简单统计邻居格个数。
				let coverage = 0;
				// 红色预乘覆盖累计初始0。
				let red = 0;
				// 绿色预乘覆盖累计初始0。
				let green = 0;
				// 蓝色预乘覆盖累计初始0。
				let blue = 0;
				// 沿横向核从−6到+6采邻格，包含两端。
				for (let dx = -HALO_RADIUS_X; dx <= HALO_RADIUS_X; dx++) {
					// 核偏移加当前目标x得到源列；这里用对称核，左右翻转同权。
					const sourceX = x + dx;
					// 源列超出模型dirty就当0贡献，跳过但不为屏幕边缘重新归一化权重。
					if (sourceX < cells.minX || sourceX > cells.maxX) continue;
					// 源是整屏格索引，y是原屏幕行，不是临时数组局部行。
					const source = y * width + sourceX;
					// 取源格可见点数，!依据已分配整屏数组与合法索引，不进行运行检查。
					const count = counts[source]!;
					// 0点格不贡献覆盖或颜色，跳到下一个dx。
					if (count === 0) continue;
					// 横向权重再除8，把点数/累计点色转成覆盖率与覆盖预乘色；除数8来自一格2×4点。
					const weight = weightsX[dx + HALO_RADIUS_X]! / 8;
					// 覆盖率加count×weight；8点满格贡献一个除8前的归一化横向核权重，而不是贡献8。
					coverage += count * weight;
					// 红色累计本来是多个点之和，乘上面已除8的weight后，就是该格覆盖预乘的红贡献。
					red += rgb[source * 3]! * weight;
					// 绿通道按同权重累加，不另除count丢掉覆盖关系。
					green += rgb[source * 3 + 1]! * weight;
					// 蓝通道同样按点色和贡献。
					blue += rgb[source * 3 + 2]! * weight;
				}
				// 把原屏幕位置转成临时区域局部行/列索引，再乘4找到该格四槽起点。
				const target = ((y - cells.minY) * regionWidth + (x - minX)) * 4;
				// 第0槽存水平滤波覆盖率。
				horizontal[target] = coverage;
				// 第1槽存水平预乘红色。
				horizontal[target + 1] = red;
				// 第2槽存水平预乘绿色。
				horizontal[target + 2] = green;
				// 第3槽存水平预乘蓝色，下一遍纵向可直接加权这四槽。
				horizontal[target + 3] = blue;
			}
		}

		// Vertical pass into the halo buffers.
		// 纵向遍历扩高后的整片光晕范围，这一遍才包含模型上/下方格。
		for (let y = minY; y <= maxY; y++) {
			// 每行遍历扩宽范围，组合前一遍水平结果。
			for (let x = minX; x <= maxX; x++) {
				// 重新从0累加当前目标的最终覆盖率。
				let coverage = 0;
				// 最终预乘红色从0开始。
				let red = 0;
				// 最终预乘绿色从0开始。
				let green = 0;
				// 最终预乘蓝色从0开始。
				let blue = 0;
				// 沿纵向核从−3到+3取水平滤波行。
				for (let dy = -HALO_RADIUS_Y; dy <= HALO_RADIUS_Y; dy++) {
					// 源行是当前目标y加核偏移。
					const sourceY = y + dy;
					// 超出原模型dirty的行在水平缓冲没有数据，当0贡献，不改变权重总和。
					if (sourceY < cells.minY || sourceY > cells.maxY) continue;
					// 取纵向归一化权重；横向已经除过8，这里不重复再除8。
					const weight = weightsY[dy + HALO_RADIUS_Y]!;
					// 源行减cells.minY、源列减minX后定位水平临时数组的4槽。
					const source = ((sourceY - cells.minY) * regionWidth + (x - minX)) * 4;
					// 水平覆盖乘纵向权重累计，组成可分离二维三角模糊。
					coverage += horizontal[source]! * weight;
					// 预乘红色按同一纵向权重累加。
					red += horizontal[source + 1]! * weight;
					// 预乘绿色按同权重累加。
					green += horizontal[source + 2]! * weight;
					// 预乘蓝色按同权重累加，暂不除覆盖率还原颜色。
					blue += horizontal[source + 3]! * weight;
				}
				// 目标回到整屏格索引，用于写常驻halo结果。
				const target = y * width + x;
				// Cells under the logo keep at least their own coverage, so faces stay solidly tinted.
				// 读取目标自身原始点数，用于保证模型实心部分不被模糊稀释过头。
				const count = counts[target]!;
				// 原格有点且自身覆盖count/8高于模糊覆盖时，用原格覆盖/平均色替换这份模糊结果。
				if (count > 0 && count / 8 > coverage) {
					// 覆盖率提高到原格自己的可见点比例。
					coverage = count / 8;
					// 原红色和除count取平均，再乘替换后的覆盖率，保持“预乘覆盖色”的存储语义。
					red = (rgb[target * 3]! / count) * coverage;
					// 绿通道也先求原格平均，再按当前覆盖预乘。
					green = (rgb[target * 3 + 1]! / count) * coverage;
					// 蓝通道同样重建预乘值，避免只改coverage使最终还原色错误。
					blue = (rgb[target * 3 + 2]! / count) * coverage;
				}
				// 最终没有覆盖就不写光晕；上层render已清理上一帧halo区，正常流程不会因此留下旧光晕。
				if (coverage <= 0) continue;
				// Quantized so neighboring cells usually share a background and its escape sequence.
				// 先将覆盖上限夹到1，取0.7次方调渐变，再乘strength，按1/32步长四舍五入；这是离散档位而非连续每帧任意强度，strength自身未在这里夹范围。
				const amount = Math.round(strength * Math.min(1, coverage) ** 0.7 * HALO_LEVELS) / HALO_LEVELS;
				// 量化后仍为0或负数则跳过，不写无效光晕颜色。
				if (amount <= 0) continue;
				// 保存量化后的混色强度，真正与背景混合由上层动画render使用。
				this.haloAmount[target] = amount;
				// 预乘红色除coverage恢复平均色，再按5为步长量化，减少相邻格ANSI颜色变化；没有在此乘光晕强度。
				this.haloRgb[target * 3] = Math.round(red / coverage / LOGO_COLOR_STEP) * LOGO_COLOR_STEP;
				// 绿色按同样平均/5步长量化保存。
				this.haloRgb[target * 3 + 1] = Math.round(green / coverage / LOGO_COLOR_STEP) * LOGO_COLOR_STEP;
				// 蓝色按同样方法保存，独立于haloAmount的强度值。
				this.haloRgb[target * 3 + 2] = Math.round(blue / coverage / LOGO_COLOR_STEP) * LOGO_COLOR_STEP;
			}
		}
		// 记整片光晕候选矩形为下帧清理区，可能包含本帧因0覆盖未写入的格，仍可统一清理。
		this.haloDirty = { minX, minY, maxX, maxY };
	}

	// 从方块中挑选可栅格化的矩形面，输入旋转/物体空间相机位置/姿态/方块/屏幕点尺寸/背景风格，返回新Face数组；例相机在方块+z侧，只保留朝相机的z正面等候选。
	private visibleFaces(
		// 行优先3×3矩阵把物体点旋到相机空间；number[]本身不保证长度9，调用方rotation负责约定。
		m: number[],
		// 物体空间相机位置，是前面用矩阵转置算出的三分量数组，不是模型中心。
		origin: number[],
		// 姿态提供点阵中心与scale，本方法不使用它的角度重新求矩阵。
		pose: Pose,
		// 只读方块列表，仍可共享内部min/max/color元组，不复制方块。
		boxes: readonly Box[],
		// 点阵宽度用于投影包围盒横向裁屏，不是字符列数。
		dotWidth: number,
		// 点阵高度用于纵向裁屏，不是字符行数。
		dotHeight: number,
		// 背景明暗启发式结果控制照明公式，并不在这里重新探测终端颜色。
		lightBackground: boolean,
		// 返回候选面的几何、包围盒与预计算照明色；流程逐轴/正负面→背面与完整邻接面剔除→投影四角→裁屏→照明。它不决定每点最终遮挡、不做近裁剪面求交或输入数值校验，数据访问/分配异常直接传播。
	): Face[] {
		// 每调用创建新候选数组，与render复用的像素/格缓冲不同。
		const faces: Face[] = [];
		// 使用同一相机距离，保证面投影与反向射线匹配。
		const cameraDistance = this.cameraDistance;
		// 逐个轴对齐方块考察六个面，不把所有方块先合成单一网格。
		for (const box of boxes) {
			// 遍历三条物体坐标轴a，每轴再考察两侧。
			for (let a = 0; a < 3; a++) {
				// 选择本面内第一个坐标轴u；循环取余而非固定把每面当xy面。
				const u = (a + 1) % 3;
				// 选择另一个面内轴v，与a/u合成三条互异轴。
				const v = (a + 2) % 3;
				// 负面side=−1、正面side=1，分别对应朝外法线的符号。
				for (const side of [-1, 1]) {
					// 正面用box.max[a]、负面用box.min[a]作为平面坐标；非空断言不检查min≤max。
					const plane = side > 0 ? box.max[a]! : box.min[a]!;
					// Back faces point away from the camera.
					// 相机必须在该面朝外的一侧才保留，等于平面或背面就跳过；判断在物体空间完成，不需要先旋转法线。
					if ((origin[a]! - plane) * side <= 0) continue;
					// Faces pressed against a neighboring block are hidden. Positions are exact while blocks rest.
					// some寻找单个邻块是否完整覆盖这个贴合面，首个命中即停；不把多个邻块的部分覆盖合并成一个完整遮挡区。
					const covered = boxes.some(
						// 多行箭头隐式返回下面&&表达式，当前other就是另一候选方块。
						(other) =>
							// 先排除方块自身，靠对象引用比较，不按坐标内容判同一对象。
							other !== box &&
							// 邻块朝本面的那一侧须与当前平面严格相等；没有epsilon容差，移动插值期间不保证继续判为贴合。
							(side > 0 ? other.min[a] : other.max[a]) === plane &&
							// 邻块u轴最小值不得大于本块的最小值，确保覆盖到这一边。
							other.min[u]! <= box.min[u]! &&
							// 邻块u轴最大值须至少覆盖本块另一边。
							other.max[u]! >= box.max[u]! &&
							// 邻块v轴最小值同样须覆盖本面下界。
							other.min[v]! <= box.min[v]! &&
							// 邻块v轴最大值覆盖本面上界；所有&&都真才叫这一整面被覆盖。
							other.max[v]! >= box.max[v]!,
					);
					// 整面被该邻块盖住就不投影/存面；部分遮挡仍保留，交后面的逐点深度缓冲解决。
					if (covered) continue;

					// 准备四角投影的左边界，以Infinity便于第一次min替换。
					let minX = Infinity;
					// 投影上边界也从Infinity起。
					let minY = Infinity;
					// 投影右边界从−Infinity起，第一次max会替换。
					let maxX = -Infinity;
					// 投影下边界同样从−Infinity起。
					let maxY = -Infinity;
					// 复用三分量corner数组逐角赋值，不为每个角新建一个向量。
					const corner = [0, 0, 0];
					// u轴取最小/最大两个端点。
					for (const cornerU of [box.min[u]!, box.max[u]!]) {
						// v轴同样取两个端点，双循环产生本面的四角。
						for (const cornerV of [box.min[v]!, box.max[v]!]) {
							// 每角垂直轴坐标固定为当前面的plane。
							corner[a] = plane;
							// 设置这一角u方向坐标。
							corner[u] = cornerU;
							// 设置这一角v方向坐标，得到完整物体空间角点。
							corner[v] = cornerV;
							// 矩阵第一行点乘角点，得到相机空间x。
							const x = m[0]! * corner[0]! + m[1]! * corner[1]! + m[2]! * corner[2]!;
							// 第二行点乘角点，得到相机空间y，仍沿屏幕向下正方向约定。
							const y = m[3]! * corner[0]! + m[4]! * corner[1]! + m[5]! * corner[2]!;
							// 第三行点乘角点，得到相机空间z，用于透视缩放。
							const z = m[6]! * corner[0]! + m[7]! * corner[1]! + m[8]! * corner[2]!;
							// 透视倍率为scale×D/(D−z)，越靠相机倍率越大；这里不专门防z=D或把跨近面的几何裁开，依赖本动画的相机/模型布局。
							const perspective = (pose.scale * cameraDistance) / (cameraDistance - z);
							// 相机空间x乘倍率后加屏幕中心X，变成盲文点横坐标。
							const screenX = pose.centerX + x * perspective;
							// 相机空间y乘倍率后加中心Y，变成点纵坐标。
							const screenY = pose.centerY + y * perspective;
							// 把这个角纳入最小屏幕x。
							minX = Math.min(minX, screenX);
							// 纳入最小屏幕y。
							minY = Math.min(minY, screenY);
							// 纳入最大屏幕x。
							maxX = Math.max(maxX, screenX);
							// 纳入最大屏幕y；这只是保守四角矩形，内层仍须射线测面。
							maxY = Math.max(maxY, screenY);
						}
					}
					// 构造已裁到点阵屏幕的矩形，不在这里创建新的三维平面。
					const face = {
						// 左界向下取整并至少0，包含可能与左侧点中心相交的边缘候选。
						minX: Math.max(0, Math.floor(minX)),
						// 上界向下取整并至少0。
						minY: Math.max(0, Math.floor(minY)),
						// 右界向上取整并最多dotWidth−1，后续循环包含该点；没有在此要求与左界顺序正确。
						maxX: Math.min(dotWidth - 1, Math.ceil(maxX)),
						// 下界向上取整并最多dotHeight−1，后面另判空矩形。
						maxY: Math.min(dotHeight - 1, Math.ceil(maxY)),
					};
					// 投影完全落屏外导致右<左或下<上时丢掉面，避免无效光栅循环。
					if (face.maxX < face.minX || face.maxY < face.minY) continue;

					// Faces are flat, so lighting is computed once per face. The normal in camera space is a
					// column of the rotation matrix.
					// 物体空间面法线是±该轴单位向量，旋到相机空间就是矩阵第a列乘side；nx为其x分量。
					const nx = m[a]! * side;
					// 法线相机空间y分量取矩阵第二行第a列。
					const ny = m[3 + a]! * side;
					// 法线相机空间z分量取第三行第a列，不是面的深度坐标。
					const nz = m[6 + a]! * side;
					// 法线点乘预归一化LIGHT并把背光负值夹0，得到漫反射近似；平面法线恒定，所以每面算一次。
					const diffuse = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
					// 用法线x/z组合额外增强边缘光，是造型用的rim近似，不是按物理灯具位置求距离衰减。
					const rim = Math.max(0, nx * 0.8 - nz * 0.3);
					// On light backgrounds, highlights toward white would vanish, so faces only get darker than
					// the brand colors there.
					// 镜面高光依据背景风格分支，整个表达式的结果是加到RGB上的亮度量。
					// 亮背景取消向白色加亮的镜面项，避免白底上高光更难辨认。
					// 暗背景取法线与半程向量的正点积，24次幂让亮斑集中，再按0.6×255缩放；这是Blinn式高光近似，不是逐点追反射光。
					const specular = lightBackground
						? 0
						: Math.max(0, nx * HALF_VECTOR[0] + ny * HALF_VECTOR[1] + nz * HALF_VECTOR[2]) ** 24 * 0.6 * 255;
					// 计算原品牌色的照明乘数，亮暗两套经验权重分开。
					// 亮背景把环境光/漫反射/边缘光之和上限夹1，所以正常非负原色不因该乘数比品牌色更亮。
					// 暗背景允许乘数超过1，再与镜面项一起由最终通道上限裁到255；并未用clamp01把乘数夹住。
					const light = lightBackground
						? Math.min(1, 0.55 + diffuse * 0.45 + rim * 0.1)
						: 0.45 + diffuse * 0.78 + rim * 0.25;
					// 几何/颜色都准备好才追加一个Face，render稍后还要决定每个点真正看见哪一面。
					faces.push({
						// 保存垂直轴a供射线平面求交，属性名axis与局部变量a不相同所以显式赋值。
						axis: a,
						// plane属性简写复用当前平面坐标。
						plane,
						// 保存面内u轴最小物体坐标，不是投影后像素坐标。
						uMin: box.min[u]!,
						// 保存面内u轴最大坐标。
						uMax: box.max[u]!,
						// 保存面内v轴最小坐标。
						vMin: box.min[v]!,
						// 保存面内v轴最大坐标，后面采用闭区间命中。
						vMax: box.max[v]!,
						// 展开前面裁屏后的minX/minY/maxX/maxY四个字段，浅复制数字值。
						...face,
						// 原色红×照明乘数+镜面高光，并只上限截到255；下限没有在这行再次夹0。
						red: Math.min(255, box.color[0] * light + specular),
						// 绿通道按同一面照明计算并上限255，不独立重算法线或光方向。
						green: Math.min(255, box.color[1] * light + specular),
						// 蓝通道同样处理；结果是面色，按深度与背景混合还在render逐点阶段。
						blue: Math.min(255, box.color[2] * light + specular),
					});
				}
			}
		}
		// 返回本帧新候选数组，空数组合法；不按深度排序，近远关系由每点depth缓冲比较。
		return faces;
	}
}

/**
 * Which easter egg to play. The pi logo lifts off the header logo, whose top-left cell is at `column`, `row`.
 */
// 彩蛋参数的可辨联合类型：kind是分支标签，pi-logo分支须有终端格坐标column/row，armin分支没有坐标。先判断kind后TS才允许读取对应字段。
// export type只导出编译期类型，不生成校验器；例如{kind: "pi-logo", column: 2, row: 1}指定标识左上角，不验证它真的在屏幕内。
export type EasterEgg3d = { kind: "pi-logo"; column: number; row: number } | { kind: "armin" };

// 模块实例内的播放门禁，初始false；不是跨模块副本/跨进程锁，后面异步探色前就置true。
let playing = false;

/**
 * Show the animation as a fullscreen overlay until it is dismissed. The overlay takes focus and mouse input and
 * returns focus when hidden, so the rest of the UI keeps running underneath untouched.
 */
// 接宿主TUI、传入画面行和彩蛋参数，查询终端颜色后构造组件并建立全屏浮层，返回Promise<void>。例如标识点击会把捕获的画面作为消散素材。
// Promise只等待本函数的查询/建浮层流程，不等用户退出动画；已有播放会立即结束，探色后发现别的可见浮层也放弃。
// 会发送终端颜色查询、启动interval并改变浮层/焦点；没有try/finally，查询、构造或showOverlay抛错可能留下playing等状态，不能保证失败后自动恢复。
export async function playEasterEgg3d(tui: TUI, screen: readonly string[], egg: EasterEgg3d): Promise<void> {
	// 已经有本模块接下的播放就早返；async仍返回兑现void的Promise，不再发送颜色查询。
	if (playing) return;
	// 先锁住门禁再await，阻止探色尚未结束时又接下第二次播放；不是等画面已经显示才置true。
	playing = true;
	// Fading needs the terminal's actual default colors; the theme only knows its own.
	// 请求默认前景/背景及调色板颜色，等待回复或约100ms超时结果；实际方法会向Terminal.write发送查询，缺失回复仍可得到undefined字段。
	const reported = await tui.queryTerminalColors({ timeoutMs: 100 });
	// 从共享theme读取深/浅外观，供缺背景回复时选择黑/白；不把主题外观当作终端已经报告的真实背景。
	const dark = theme.appearance === "dark";
	// 局部转换回调接可缺的RGB对象和兜底元组，返回Rgb，无I/O；箭头的表达式主体继续到下一行。
	const toRgbTuple = (rgb: { r: number; g: number; b: number } | undefined, fallback: Rgb): Rgb =>
		// 有对象就提取三个通道建元组，否则返回原fallback引用；不在此验证通道范围或运行时冻结数组。
		rgb ? [rgb.r, rgb.g, rgb.b] : fallback;
	// 建立本次动画颜色对象；下面两字段分别选择探测值或兜底值，调色板回复未在此交给parseScreen。
	const colors = {
		// 前景优先用终端回复，否则把当前主题text颜色转RGB；函数参数先求值，所以兜底转换即使命中回复也会执行。
		foreground: toRgbTuple(reported.foreground, toRgb(theme.colors.text)),
		// 背景优先终端回复，缺失时深主题用黑、浅主题用白；不继续等待晚到颜色自动更新本对象。
		background: toRgbTuple(reported.background, dark ? [0, 0, 0] : [255, 255, 255]),
	};
	// 探色完成后再按宿主可见性规则检查浮层；hasOverlay会执行可见性回调，异常不被本函数捕获。
	if (tui.hasOverlay()) {
		// 此正常放弃分支释放播放门禁，没有创建动画interval。
		playing = false;
		// 已有可见浮层时返回，不把新动画叠在其上。
		return;
	}
	// 声明本次模型，实际根据判别标签在下一行选择。
	const model =
		// armin用主题accent构造位图模型；pi-logo用传入格坐标保留起飞原点。条件分支完成TS收窄，不验证用户坐标范围。
		egg.kind === "armin" ? arminModel(toRgb(theme.colors.accent)) : piLogoModel({ column: egg.column, row: egg.row });
	// 构造动画并传完成闭包；构造立即安排interval，但不在这里同步渲染模型。
	// 完成回调无参/void，正常由finish触发；闭包引用后面才赋值的overlay，按真实TUI的异步播放流程使用，不能认为此时句柄已存在。
	const animation = new EasterEgg3dAnimation(tui, screen, model, colors, () => {
		// 完成时先释放门禁；即使下一句hide抛错，这个赋值已经发生。
		playing = false;
		// 用对应句柄移除本浮层并让宿主处理焦点恢复/重绘，不按当前最顶层浮层盲删；异常没有catch或重试。
		overlay.hide();
	});
	// 按左上角、100%宽和100%最大高建立捕获型浮层并取得句柄；showOverlay会聚焦/排帧，返回不等实际画出，也不等待动画结束。
	const overlay = tui.showOverlay(animation, { anchor: "top-left", width: "100%", maxHeight: "100%" });
}

// 动画组件实现Component契约：保存画面/模型，定时请求渲染，返回ANSI行并处理退出输入；implements只让TS核对成员，不自动注册事件或焦点。
// playEasterEgg3d负责装入浮层；直接new本类也会建interval。组件没有统一dispose方法，停止靠finish及未再渲染超时判断。
export class EasterEgg3dAnimation implements Component {
	// 保存TUI引用供取终端尺寸/排帧，private和readonly只是TS限制，不会运行时冻结宿主。
	private readonly tui: TUI;
	/** The screen to dissolve, as rendered lines. */
	// 保留传入画面数组的同一引用；readonly string[]禁止经此类型增删改数组，不是Object.freeze，也不是深复制快照。
	private readonly screen: readonly string[];
	// 保存模型引用，构造后不经此字段重新赋值；内部对象仍非运行时冻结。
	private readonly model: Model;
	// 保存本次默认前景RGB元组，不因后来共享theme变化自动替换。
	private readonly foreground: Rgb;
	// 保存本次默认背景元组，后续混色/消散使用它，不在每帧重新探终端颜色。
	private readonly background: Rgb;
	// 完成回调引用，void表示忽略返回值，不自动等待异步回调；同步抛错仍会传播。
	private readonly onDone: () => void;
	// 实例字段初始化记录单调时间毫秒，作为动画相对时间起点；不是模块加载时所有实例共用起点。
	private readonly startTime = performance.now();
	// 记录最近尝试render的毫秒时刻，初值在构造字段初始化阶段取得；用来判断是否长时间没人绘制。
	private lastRender = performance.now();
	// ReturnType<typeof setInterval>取得计时句柄类型，|undefined表示已无句柄；字段声明本身不建立计时器。
	private timer: ReturnType<typeof setInterval> | undefined;
	// 退出状态的联合类型从下一行展开，未定义表示尚未开始退场。
	// 对象保存退出起点start（毫秒）、点击关闭时time（相对秒）、yaw/targetYaw（弧度）及关闭时每块的三轴offsets。
	// Array<[number, number, number]>是可变三元组数组，TS约束长度/成员类型，不执行坐标合法性检查或Object.freeze。
	private exit:
		| { start: number; time: number; yaw: number; targetYaw: number; offsets: Array<[number, number, number]> }
		// 联合分支undefined允许当前没有退场对象，后面if(this.exit)会收窄到对象分支。
		| undefined;
	// 缓存最近一次拼图周期编号和每步块坐标，缺省undefined；只缓存这一周期，不是全部历史帧。
	private shuffle: { cycle: number; steps: Cell3[][] } | undefined;
	// 上次准备素材的屏幕宽，-1使首次正常宽度render触发准备。
	private screenWidth = -1;
	// 对应高度哨兵；resize或invalidate后会重新解析画面/生成星点。
	private screenHeight = -1;
	/** Star per cell index, or undefined. */
	// 按终端格线性索引存可缺的Star，初始空数组；元素缺失表示该格没有星，不代表黑色星。
	private stars: Array<Star | undefined> = [];
	// 保存解析后的二维终端格数组，包括宽字素的第二列占位；初始尚未解析screen。
	private cells: ScreenCell[][] = [];
	// 实例内缓存颜色/前背景编码到ANSI字符串；readonly固定Map引用，不禁止set/clear，初始不发送控制码。
	private readonly ansiCache = new Map<number, string>();
	// 复用BlockRaster的光栅缓冲，构造时赋值，不每帧new光栅器。
	private readonly raster: BlockRaster;

	// 输入宿主、画面引用、模型、前背景和完成回调，创建光栅器并按约30fps安排排帧检查，构造返回组件实例而非动画完成Promise。
	// 例如new后即使未装浮层，超过约1秒没有render也会尝试finish；interval时机受事件循环影响，回调异常不在这里吞掉。
	constructor(
		// 宿主TUI负责真正渲染与终端写入。
		tui: TUI,
		// 待消散画面行，类型只读但这里保留引用，不重新抓屏。
		screen: readonly string[],
		// 位图/相机/起飞原点及拼图策略模型。
		model: Model,
		// 两种RGB元组供消散与背景混色；内联对象类型不会自动校验调用数据。
		colors: { foreground: Rgb; background: Rgb },
		// 结束时通知外层移除浮层，接函数而不是在构造参数中先执行它。
		onDone: () => void,
	) {
		// 保存同一宿主引用。
		this.tui = tui;
		// 保存同一画面数组，不复制每行或冻结外部数组。
		this.screen = screen;
		// 保存同一模型供姿态和拼图计算。
		this.model = model;
		// 按模型相机距离构造光栅器；只是分配对象，尚未投射方块或操作终端。
		this.raster = new BlockRaster(model.cameraDistance);
		// 固定本次前景元组引用。
		this.foreground = colors.foreground;
		// 固定本次背景元组引用。
		this.background = colors.background;
		// 保存结束通知闭包，尚未调用。
		this.onDone = onDone;
		// 建立interval并保存句柄；箭头回调捕获this，之后每次调度才检查结束条件或请求帧。
		this.timer = setInterval(() => {
			// Also stop when no longer rendered, e.g. when pi hides all overlays on exit.
			// 退场进度到1，或超过1000ms未调用render，任一成立就finish；&&比||先结合，短路时不会无条件计算exitProgress。
			if ((this.exit && this.exitProgress() >= 1) || performance.now() - this.lastRender > 1000) this.finish();
			// 仍活动则请求宿主稍后重绘，requestRender会合并/节流，不保证每个interval都实际画一帧。
			else this.tui.requestRender();
			// FRAME_MS为1000/30毫秒，交Node定时器调度；不是严格实时30fps承诺。
		}, FRAME_MS);
		// 若句柄提供unref则调用，使本计时器不单独维持Node事件循环；不是清掉interval或保证一定播放完。
		this.timer.unref?.();
	}

	/** Play the exit animation. A second call skips it. */
	// 请求关闭，首次保存当前时间/角度/偏移来播放退场，重复调用直接finish，返回void。
	// 例如第一次取消键让块归位并落回，退场中再按一次跳过；不返回可await的关闭完成结果，不在首次调用里立即移除浮层。
	close(): void {
		// 已有退场对象就视为第二次关闭请求，不重置退出起点。
		if (this.exit) {
			// 立即尝试清计时器并调用完成通知；通知抛错会中断本次close。
			this.finish();
			// 直接结束，不再保存新退出姿态。
			return;
		}
		// 取得自构造以来的相对秒数，固定本次退场开始时动画时间。
		const time = this.elapsed();
		// 按该时刻的旋转函数求yaw，不是读终端或测真实物体。
		const yaw = spinAngle(time);
		// 2π弧度表示一整圈，供向下一个正面角度对齐。
		const turn = Math.PI * 2;
		// 建立退场对象，保存关闭时的入场/拼图时刻和姿态数据，不运行时冻结这些对象。
		this.exit = {
			// start用当前毫秒计时，区别于相对秒time。
			start: performance.now(),
			// 属性简写保存刚求出的相对秒数。
			time,
			// 属性简写保存退场起始yaw。
			yaw,
			// 向上取整到下一整圈角度；已恰好整圈时保持，不保证必须再转满一圈。
			targetYaw: Math.ceil(yaw / turn) * turn,
			// 求当前每块偏移并保存，之后按退场进度缩回原位，不继续跑新的拼图步骤。
			offsets: this.blockOffsets(time),
		};
	}

	// 处理派发到组件的键盘片段，接data返回void；按当前可配置取消/清空动作调用close，其他键不在本方法执行操作。
	// 例如取消键触发退场；浮层宿主仍有全局输入路由，不能说本方法截断所有快捷键。匹配器/close异常可传播。
	handleInput(data: string): void {
		// 每次取共享键位管理器，不写死Escape/Ctrl+C；不直接读取stdin。
		const keybindings = getKeybindings();
		// 先匹配取消动作，不匹配才查app.clear；任一命中只调一次close，不在这里重绘或停TUI。
		if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.clear")) this.close();
	}

	// 处理规范化鼠标事件，点击时close，返回消费标记；例如任意派发到此组件的click都可退出，不限某一按钮或提示区。
	// 其余鼠标类型也标handled，抑制宿主对应退路；render:false只抑制本事件请求重绘，正常动画interval仍继续排帧。
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
		// 只有type恰好click才关闭，press/release/wheel等不在此启动退场。
		if (event.type === "click") this.close();
		// 返回已处理且本事件不要求额外渲染；没有请求capture/focus，也不代表未收到的全局事件都会被消费。
		return { handled: true, render: false };
	}

	// 使尺寸相关素材和ANSI缓存失效，返回void；下一次render会重建格子/星点，例主题重绘时重新取编码。
	// 不重新探测默认颜色、不替换原screen/model、不重置起始时间或退场状态，也不主动requestRender。
	invalidate(): void {
		// 宽哨兵改-1，使下一次正常尺寸比较失败。
		this.screenWidth = -1;
		// 高度同样失效，迫使素材按当前rows重建。
		this.screenHeight = -1;
		// 清当前Map内容而非换Map；后续miss时按当时theme颜色模式生成ANSI。
		this.ansiCache.clear();
	}

	// 按传入终端列宽生成一帧字符串数组，内部取当前terminal.rows作为高度；返回含ANSI样式的行，不直接Terminal.write。
	// 流程：必要时准备画面/星点→求入场或退场状态→光栅方块→按提示、模型、原字/尘点/星点次序合成每格→逐行复位样式。
	// 例如退出让消散时间倒走重组旧文字，但星点闪烁仍用当前elapsed；不逐帧回放历史。会改缓存/lastRender，假设尺寸等输入适用，没有统一数值/Unicode布局校验，异常向宿主传播。
	render(width: number): string[] {
		// 取宿主当前行数，最低按1行处理；width由调用者传入，不在这里限制为正整数。
		const height = Math.max(1, this.tui.terminal.rows);
		// 局部引用固定前景，避免反复读字段。
		const foreground = this.foreground;
		// 局部引用固定背景，并非重新读取共享theme背景。
		const background = this.background;
		// 记录render已被调用的时刻，定时器据此判断失去绘制；不证明这一帧已成功返回或写到终端。
		this.lastRender = performance.now();
		// 宽或高度不同就重建尺寸相关素材；invalidate把它们设-1也会触发。
		if (width !== this.screenWidth || height !== this.screenHeight) {
			// 记录新宽，后续素材索引用这个终端格数。
			this.screenWidth = width;
			// 记录新高，星场据此分配。
			this.screenHeight = height;
			// 解析保存的画面并设置消散时序/清掉原标识占位，不重新抓取当前聊天内容。
			this.cells = this.prepareCells(width, foreground);
			// 按新宽高重新建立确定性稀疏星数组，不沿旧二维坐标搬运星点。
			this.stars = this.prepareStars(width, height);
		}

		// Dissolve time runs forward on entry and backward on exit, so the screen reassembles in reverse order.
		// 声明本帧消散时间（秒），下面两分支都会赋值；let类型声明本身不开始计时。
		let dissolveTime: number;
		// 声明本帧Pose，包含点坐标中心、缩放和三个旋转角。
		let pose: Pose;
		// 本帧提示可见混合比例，由入场/退场路径决定。
		let hintAlpha: number;
		// 本帧星场淡入/淡出比例，和星点自身闪烁另算。
		let starAlpha: number;
		// 本帧每块三轴偏移数组；元组类型约束编译期结构，不是运行时矩阵类。
		let offsets: Array<[number, number, number]>;
		// 已有退场状态就保持关闭时的拼图时刻，并按退出进度回收/落回。
		if (this.exit) {
			// 取得夹到0..1的退出进度；这里不直接清interval，定时回调负责finish。
			const progress = this.exitProgress();
			// 退出前80%完成降落，progress达到0.8后landing保持1。
			const landing = clamp01(progress / 0.8);
			// 把平滑降落进度反转为从1降到0的保留量，供位置/缩放/倾斜收回。
			const settle = 1 - smooth(landing);
			// 消散时间从关闭时刻（最多DISSOLVE_END）线性降到0，逆向重组旧文字，不继续累加播放时间。
			dissolveTime = Math.min(this.exit.time, DISSOLVE_END) * (1 - progress);
			// 用关闭时的flyProgress乘settle求回落姿态，time固定为关闭时刻，下一行再单独覆盖yaw。
			pose = this.pose(width, height, this.flyProgress(this.exit.time) * settle, this.exit.time);
			// 在起始yaw与下一整圈targetYaw之间用easeOut插值，退出旋转并不是把历史yaw严格倒放。
			pose.yaw = this.exit.yaw + (this.exit.targetYaw - this.exit.yaw) * easeOut(landing);
			// 把原pitch再乘settle，落定时压回0。
			pose.pitch *= settle;
			// roll同样逐渐回到0，不保留关闭时的倾斜。
			pose.roll *= settle;
			// 提示在退出前20%内平滑淡出，基准亮度取关闭时hintAlpha。
			hintAlpha = this.hintAlpha(this.exit.time) * (1 - smooth(progress / 0.2));
			// 星场总体在退出前30%内淡出，基准为关闭时starAlpha。
			starAlpha = this.starAlpha(this.exit.time) * (1 - smooth(progress / 0.3));
			// Blocks are home well before the logo lands.
			// 方块偏移在退出前50%归零，比降落更早完成；gather从1平滑降0。
			const gather = 1 - smooth(progress / 0.5);
			// 对关闭时保存的偏移逐轴乘gather，map建立新三元组数组，不改exit.offsets。
			offsets = this.exit.offsets.map(([x, y, z]) => [x * gather, y * gather, z * gather]);
			// 尚未退场时按当前相对时间正常入场/旋转/拼图。
		} else {
			// 取本帧相对秒数。
			const time = this.elapsed();
			// 正常消散时间向前走。
			dissolveTime = time;
			// 按当前尺寸/飞行进度/时间求中心、缩放和旋转。
			pose = this.pose(width, height, this.flyProgress(time), time);
			// 计算飞行之后出现的退出提示亮度。
			hintAlpha = this.hintAlpha(time);
			// 计算星场总体淡入亮度。
			starAlpha = this.starAlpha(time);
			// 按当前拼图周期取得各块偏移，必要时更新周期缓存。
			offsets = this.blockOffsets(time);
		}

		// 解构位图像素宽高，不是终端行列或光栅点数。
		const { columns, rows } = this.model;
		// 逐块构建本帧轴对齐Box，map回调接块和对应偏移下标；不在这里改模型home坐标。
		const boxes: Box[] = this.model.blocks.map((block, index) => {
			// 取同下标三轴偏移，!只向TS断言存在，没有运行时越界检查。
			const [dx, dy, dz] = offsets[index]!;
			// 原横坐标减半模型宽以居中，再加当前dx，单位是模型格。
			const x = block.home[0] - columns / 2 + dx;
			// 纵向同理按模型高居中，加dy。
			const y = block.home[1] - rows / 2 + dy;
			// 每块XY各宽1格，Z厚DEPTH且中心在dz，保留原RGB引用；这里只生成包围盒，旋转/投射由光栅器执行。
			return { min: [x, y, dz - DEPTH / 2], max: [x + 1, y + 1, dz + DEPTH / 2], color: block.color };
		});
		// 复用本实例光栅器，下面会覆盖其本帧点位/颜色缓冲。
		const raster = this.raster;
		// 按终端宽高和Pose投射各Box；浅背景才请求LIGHT_HALO_STRENGTH色晕，深背景传0，不直接输出终端。
		raster.render(width, height, pose, boxes, background, isLight(background) ? LIGHT_HALO_STRENGTH : 0);
		// 局部halo回调接格索引和可缺基础背景，返回混合RGB或原undefined；读取本帧光栅结果，不改格数据。
		const halo = (index: number, base: Rgb | undefined): Rgb | undefined => {
			// 读取这一格色晕强度，!是静态非空断言。
			const amount = raster.haloAmount[index]!;
			// 强度不正就原样返回基础背景，保持默认背景可缺的区别。
			if (amount <= 0) return base;
			// 引用光栅器三通道交错数组，颜色起点为index*3。
			const color = raster.haloRgb;
			// 缺基础色时用终端默认背景，按色晕RGB和amount混合成新元组。
			return mix(base ?? background, [color[index * 3]!, color[index * 3 + 1]!, color[index * 3 + 2]!], amount);
		};
		// 原画面背景在BACKGROUND_FADE秒内平滑混向默认背景；退场dissolveTime倒走时也反向恢复。
		const backgroundFade = smooth(dissolveTime / BACKGROUND_FADE);
		// 正文基础淡化在0.6秒内增加到0.3，仅先稍微压暗/混背景，完全消失还由各格dust决定。
		const textFade = smooth(dissolveTime / 0.6) * 0.3;
		// Once the screen has fully dissolved, the text layer is empty and can be skipped.
		// 消散时间还早或背景尚未完全淡去才读取旧文字层，完成后可跳过整层；不是清除保存的this.cells。
		const textActive = dissolveTime < DISSOLVE_END || backgroundFade < 1;
		// 准备可缺的底部提示对象，宽不够/alpha不正时没有提示。
		const hint = this.hint(width, height, hintAlpha, background);
		// 把消散时间量化成每秒约14个散点状态编号，退出时编号随时间倒退；不是interval当前帧计数。
		const frame = Math.floor(dissolveTime * 14);
		// 另外取实时elapsed供星点闪烁，因此退出星光不严格逆放。
		const now = this.elapsed();
		// Star brightness is quantized, so a row only changes when one of its stars steps to another level
		// instead of on every frame.
		// 把星场总体alpha四舍五入到1/STAR_ALPHA_LEVELS刻度，减少每帧颜色微变，不是随机闪烁开关。
		const starLevel = Math.round(starAlpha * STAR_ALPHA_LEVELS) / STAR_ALPHA_LEVELS;
		// 局部starfield回调按一格索引返回字符/前景或undefined；混合当前背景、主题前景和预定星色，无外部I/O。
		const starfield = (index: number): { text: string; fg: Rgb } | undefined => {
			// 总体亮度为0就不查这一格星点。
			if (starLevel <= 0) return undefined;
			// 按线性格索引取可缺Star。
			const star = this.stars[index];
			// 该格没有星就返回undefined，调用者以空格填充。
			if (!star) return undefined;
			// 声明该星的闪烁比例，计算跨两行继续。
			const flicker =
				// 正弦把相位映到0..1，再乘闪烁档数并取整；速度单位弧度/秒，now单位秒。
				Math.round((0.5 + 0.5 * Math.sin(now * star.speed + star.phase)) * STAR_FLICKER_LEVELS) /
				// 除回档数得到离散0..1比例，降低连续颜色变化频率。
				STAR_FLICKER_LEVELS;
			// 返回本格星点的字符和颜色对象，不缓存整行字符串。
			return {
				// 沿用创建时单点盲文字符。
				text: star.glyph,
				// 先把默认前景与星色各混一半，再以强度、0.7..1闪烁因子和总体亮度混向背景，星光保持微弱。
				fg: mix(background, mix(foreground, star.tint, 0.5), star.strength * (0.7 + 0.3 * flicker) * starLevel),
			};
		};
		// 新建本帧输出行数组，稍后每行加样式复位。
		const lines: string[] = [];
		// 按当前terminal.rows对应的高度逐行生成，row为0基终端行。
		for (let row = 0; row < height; row++) {
			// 旧画面缺这一行就用空数组，不假设抓屏行数总与当前高度一致。
			const cells = this.cells[row] ?? [];
			// 当前输出行从空串开始，后面闭包原地追加。
			let line = "";
			// 前景缓存初值-1表示本行尚未显式设色/使用默认；不是RGB通道值。
			let currentFg = -1;
			// 背景同用-1作为默认哨兵，减少相邻格重复ANSI序列。
			let currentBg = -1;
			// 局部emit接文字及可缺前/背景，更新当前行和颜色键、返回void；例相邻同色盲文只需一次开启码。
			// 这是拼字符串而非终端写入；只对恰好一个普通空格省略前景切换，不是通用Unicode空白/样式渲染器。
			const emit = (text: string, fg: Rgb | undefined, bg: Rgb | undefined) => {
				// 存在前景就打包RGB数值，没有则用-1；颜色合法范围依赖上游计算。
				const fgKey = fg ? this.pack(fg) : -1;
				// 背景同样转换成可比较键。
				const bgKey = bg ? this.pack(bg) : -1;
				// 前景改变且文字不是单个ASCII空格才发前景码；空格不会更新currentFg，下一非空格再按实际样式补。
				if (fgKey !== currentFg && text !== " ") {
					// 有色用缓存ANSI，否则加SGR39恢复默认前景；这里只追加字节，不调用Terminal。
					line += fg ? this.ansi(fgKey, false) : "\x1b[39m";
					// 保存本行实际已发出的前景键。
					currentFg = fgKey;
				}
				// 背景变化总要处理，即使正文是空格也需要背景填色。
				if (bgKey !== currentBg) {
					// 有背景用背景ANSI，否则加SGR49恢复默认背景。
					line += bg ? this.ansi(bgKey, true) : "\x1b[49m";
					// 记录已发背景键，供下一格复用。
					currentBg = bgKey;
				}
				// 把原样text附在行末，不由emit按字素拆分或测宽。
				line += text;
			};
			// 逐终端列合成；宽字素完整输出时会在内部额外前进一列。
			for (let column = 0; column < width; column++) {
				// row*width+column将二维终端格映成光栅/星数组索引。
				const index = row * width + column;
				// 旧文字层活动才取当前格，否则按没有旧字处理，不停止画模型和星点。
				const cell = textActive ? cells[column] : undefined;
				// 求本格最终背景，halo调用参数跨下面两行。
				const cellBg = halo(
					// 传入当前线性格索引。
					index,
					// 旧格有显式背景且尚未淡完时先混向默认背景，否则undefined，让宿主默认背景或色晕接管。
					cell?.bg && backgroundFade < 1 ? mix(cell.bg, background, backgroundFade) : undefined,
				);
				// 提示存在且行/列落入其范围时优先输出；这里范围按hint.text.length的UTF-16码元算，不用visibleWidth，复杂Unicode键名可能与显示列不一致。
				if (hint && row === hint.row && column >= hint.start && column < hint.start + hint.text.length) {
					// 提示内偏移为当前列减起始列。
					const offset = column - hint.start;
					// 按UTF-16下标取提示的一个码元；键名部分用keyColor，后缀用color，不是按字素遍历提示。
					emit(hint.text[offset]!, offset < hint.keyLength ? hint.keyColor : hint.color, cellBg);
					// 提示优先盖过本格模型/旧字/星光，结束本列。
					continue;
				}
				// 取本格模型占用的盲文位掩码，0表示无模型点。
				const dots = raster.bits[index]!;
				// 有模型点就优先画模型，而不是让旧字/尘点穿过。
				if (dots) {
					// Quantized so neighboring cells on one face usually share a color and its escape sequence.
					// 以5乘本格已照亮点数作为除数，把总RGB还原平均后按5通道值量化；counts不等于模型块数量。
					const step = LOGO_COLOR_STEP * raster.counts[index]!;
					// 局部引用本帧点色累加数组。
					const rgb = raster.rgb;
					// 创建量化后的RGB元组，三个通道在后面分别计算。
					const color: Rgb = [
						// 红总和除以点数和颜色步长，取整后乘回颜色步长。
						Math.round(rgb[index * 3]! / step) * LOGO_COLOR_STEP,
						// 绿通道采用相同平均/量化流程。
						Math.round(rgb[index * 3 + 1]! / step) * LOGO_COLOR_STEP,
						// 蓝通道同理，减少同一表面相邻格的细微色差。
						Math.round(rgb[index * 3 + 2]! / step) * LOGO_COLOR_STEP,
					];
					// 按位掩码查256个盲文字符之一，带模型色和本格背景输出。
					emit(BRAILLE[dots]!, color, cellBg);
					// 模型已处理这一格，不再叠旧字或星点。
					continue;
				}
				// 没有旧画面格（或文字层停用）时只尝试星光。
				if (!cell) {
					// 求此格可缺的星字符与色。
					const star = starfield(index);
					// 有星画星、否则普通空格；?.可缺前景让emit保持或恢复相应样式。
					emit(star?.text ?? " ", star?.fg, cellBg);
					// 该列已生成，不进入尘点计算。
					continue;
				}
				// 当前消散时间减格自己的delay，再除尘化持续时间；负数为尚未轮到，0..1为逐渐减少点。
				const dust = (dissolveTime - cell.delay) / DUST_DURATION;
				// 宽2字素尚未开始尘化且右侧没有模型点时，才能完整输出旧宽字素；这里只专门检查右格模型位，不是验证所有叠层冲突。
				if (dust < 0 && cell.width === 2 && !raster.bits[index + 1]) {
					// 完整输出原字素，前景先做基础textFade混色，使用左格计算的背景。
					emit(cell.text, mix(cell.fg, background, textFade), cellBg);
					// 额外跳过右侧占位列，避免完整宽字素已经占两列后又输出一次。
					column++;
					// 宽字素完整保留后结束本轮，不执行下方按单格盲文拆散。
					continue;
				}
				// 普通宽1字素且还没开始尘化时也保留原文字；宽0占位不走这一分支。
				if (dust < 0 && cell.width === 1) {
					// 按基础淡化色输出原宽1字素。
					emit(cell.text, mix(cell.fg, background, textFade), cellBg);
					// 该格原字已输出，不再画尘点。
					continue;
				}
				// 其余情况用格的ink估计点数：未轮到时保留全部ink，开始后按夹限dust逐渐四舍五入到0。
				const dotCount = dust < 0 ? cell.ink : Math.round(cell.ink * (1 - clamp01(dust)));
				// 没有尘点就让星光或空背景显示出来。
				if (dotCount <= 0) {
					// 同一线性格位置查星，不创建新的随机星对象。
					const star = starfield(index);
					// 没星则填空格，保留本格背景/色晕。
					emit(star?.text ?? " ", star?.fg, cellBg);
					// 这一格处理完，不进入选点循环。
					continue;
				}
				// Pick `dotCount` distinct dots; the choice changes a few times per second so the dust shimmers.
				// 本格盲文位掩码从0起。
				let bits = 0;
				// 已放入的不同点数从0起，重复位不增加。
				let placed = 0;
				// 最多尝试32次或达到dotCount就停；有限尝试不保证每次都恰好凑满目标点数。
				for (let attempt = 0; placed < dotCount && attempt < 32; attempt++) {
					// 由格种子、离散消散帧和尝试次数生成确定性索引0..7，再查盲文点位；!只消除TS的可缺类型。
					const bit = DOT_BITS[Math.floor(hash(cell.seed * 7919 + frame * 131 + attempt) * 8)]!;
					// 该位已在掩码中就重试，不重复计数。
					if (bits & bit) continue;
					// 按位或|=把新点并入掩码，不覆盖先前点。
					bits |= bit;
					// 只有真正新增位才递增placed。
					placed++;
				}
				// 将基础textFade与dust的0.8次幂合成总淡化量，dust夹到0..1，逐步混至背景色。
				const fade = textFade + (1 - textFade) * clamp01(dust) ** 0.8;
				// 按选点掩码输出尘状盲文，颜色逐渐接近背景，不在这里移动真实终端光标。
				emit(BRAILLE[bits]!, mix(cell.fg, background, fade), cellBg);
			}
			// 把行末加SGR0复位样式后push到输出；模板内容保持原样，不把注释放入控制串。
			lines.push(`${line}\x1b[0m`);
		}
		// 返回本帧行数组，实际合成浮层/输出终端由TUI完成。
		return lines;
	}

	// 取自实例起点以来的秒数，返回number，无状态修改；例约500ms后为0.5，不承诺每次调用同一帧得到完全相同时刻。
	private elapsed(): number {
		// performance.now差值原单位毫秒，除1000变秒，不用受日历校时影响的Date.now。
		return (performance.now() - this.startTime) / 1000;
	}

	// 求当前退出归一化进度，返回0..1（按正常有限时间输入），没开始退出为0，不推进/结束计时器。
	private exitProgress(): number {
		// 已有退出对象才用当前毫秒减start、转秒再除EXIT_DURATION，clamp01夹两端；?:另支0。
		return this.exit ? clamp01((performance.now() - this.exit.start) / 1000 / EXIT_DURATION) : 0;
	}

	// 完成组件：有timer才取消interval、清句柄、同步调用onDone，返回void；例重复finish不重复通知。
	// 先清timer再通知，所以onDone抛错时计时器已经停止且不会自动重试通知；clearInterval也不撤销宿主此前排队的render。
	private finish(): void {
		// 没有活动句柄就早返；正常Node句柄是对象真值，undefined表示已完成。
		if (!this.timer) return;
		// 撤销后续interval调度，不等于停止整个TUI事件循环或撤回正在执行的回调。
		clearInterval(this.timer);
		// 先清句柄作为重复完成门禁。
		this.timer = undefined;
		// 同步通知外层收浮层，返回值不使用，抛错不捕获；本方法本身不直接重置模块playing。
		this.onDone();
	}

	/** Each block's displacement from its place in the model at `time`, in grid units. */
	// 给定动画相对秒数，返回与model.blocks一一对应的三轴位移；先未到拼图则全0，再按周期缓存步骤、在步骤间平滑插值、一起飞回、最后短暂停0。
	// 例如某块从原格滑到右邻格，偏移由[0,0,0]平滑变[1,0,0]；会更新最近周期shuffle缓存，但不改模型home。
	private blockOffsets(time: number): Array<[number, number, number]> {
		// 局部引用全部模型块，数组顺序用于和步骤/offsets按下标对齐。
		const blocks = this.model.blocks;
		// home是无参局部回调，每次调用map为每块建新的[0,0,0]三元组数组；不是把所有元素指向同一个可变元组。
		const home = (): Array<[number, number, number]> => blocks.map(() => [0, 0, 0]);
		// 拼图开始时间之前立即返回全0，即块保持模型原位。
		if (time < PUZZLE_START) return home();
		// 减拼图起点、除周期长度并向下取整，得到0基周期号。
		const cycle = Math.floor((time - PUZZLE_START) / PUZZLE_CYCLE);
		// 减去完整周期时长，得到当前周期内相对秒数。
		const local = time - PUZZLE_START - cycle * PUZZLE_CYCLE;
		// 缓存不存在或周期号不同才确定性生成这一周期全部步骤；?.让缺缓存时得到undefined再比较。
		if (this.shuffle?.cycle !== cycle) this.shuffle = { cycle, steps: shuffleSteps(this.model, cycle) };
		// 读取已准备的步骤数组，不每帧重新随机洗牌。
		const steps = this.shuffle.steps;
		// 局部offset接某块的绝对格位置和下标，返回相对该块home的可变三元组，无外部修改。
		const offset = (position: Cell3, index: number): [number, number, number] => {
			// 取同下标块的原始三轴格坐标，!不插入越界校验。
			const block = blocks[index]!.home;
			// 逐轴相减，区别“模型网格位置”和“相对原位的位移”。
			return [position[0] - block[0], position[1] - block[1], position[2] - block[2]];
		};
		// 总洗牌段时长等于每步秒数乘步骤数，不含回家/停留段。
		const shuffleEnd = PUZZLE_STEP * PUZZLE_STEPS;
		// 周期内仍在洗牌段才在相邻步骤间插值。
		if (local < shuffleEnd) {
			// 按步长向下取整得当前步骤下标。
			const step = Math.floor(local / PUZZLE_STEP);
			// 求本步内比例并smooth，达到步末前趋近1，不用线性突变换位。
			const progress = smooth((local - step * PUZZLE_STEP) / PUZZLE_STEP);
			// 按本步每块的起点map，回调返回当前连续位移，steps中还有下一步供插值。
			return steps[step]!.map((from, index) => {
				// 求该块本步起点相对home的位移a。
				const a = offset(from, index);
				// 求同块下一步终点位移b，连续两个!只作TS非空断言。
				const b = offset(steps[step + 1]![index]!, index);
				// 三个轴分别a+(b-a)*progress，返回新三元组，不改离散步骤坐标。
				return [a[0] + (b[0] - a[0]) * progress, a[1] + (b[1] - a[1]) * progress, a[2] + (b[2] - a[2]) * progress];
			});
		}
		// 洗牌结束但还在PUZZLE_RETURN回家时长内走统一归位段。
		if (local < shuffleEnd + PUZZLE_RETURN) {
			// All blocks fly home at once. Alternating arcs in depth keep them from passing through each other.
			// 把回家段相对秒数除段长得到u。
			const u = (local - shuffleEnd) / PUZZLE_RETURN;
			// 剩余位移系数从1平滑降到0。
			const remaining = 1 - smooth(u);
			// sin(πu)生成中间拱起、两端为0的深度弧，振幅0.8模型格。
			const arc = Math.sin(Math.PI * clamp01(u)) * 0.8;
			// 从最后一个离散洗牌位置给每块求回家位移。
			return steps[PUZZLE_STEPS]!.map((position, index) => {
				// 取得该块最后位置相对home的[x,y,z]偏移。
				const [x, y, z] = offset(position, index);
				// XY和原Z位移按remaining缩小，偶数/奇数块分别加正/负深度弧以错开轨迹；没有碰撞检测，不证明任意轨迹都不相交。
				return [x * remaining, y * remaining, z * remaining + (index % 2 === 0 ? arc : -arc)];
			});
		}
		// 回家段之后的保持阶段返回全0，直到下个周期重新洗牌。
		return home();
	}

	// 把相对秒数变成平滑飞行进度，返回0..1；例FLY_START之前0，飞行段结束后1，无状态修改。
	private flyProgress(time: number): number {
		// 先相对飞行起点/时长归一化，再交内部smooth夹限并平滑。
		return smooth((time - FLY_START) / FLY_DURATION);
	}

	// 把相对秒数变成星场总体淡入比例，返回number，无计时器/绘制副作用；到STARS_START才开始显现。
	private starAlpha(time: number): number {
		// 按星场起点和STARS_FADE归一化并smooth，正常有限时间下两端夹0/1。
		return smooth((time - STARS_START) / STARS_FADE);
	}

	// 计算提示在飞行结束后的淡入比例，返回number；不决定提示文字宽度是否够放，那由hint另判。
	private hintAlpha(time: number): number {
		// 减飞行起点和完整飞行时长，再除HINT_FADE做平滑淡入。
		return smooth((time - FLY_START - FLY_DURATION) / HINT_FADE);
	}

	// 按终端宽高、飞行进度和相对秒数返回新Pose；中心用盲文点坐标，scale为每模型像素对应的点数，角度用弧度，不修改模型或输出终端。
	// 例如pi-logo从header原点飞向视口中心，Armin从中心小点长大；缩放受半径/透视估算控制且不低于起始大小，极小视口不保证完全装得下。
	private pose(width: number, height: number, progress: number, time: number): Pose {
		// 解构模型像素尺寸、相机距、最大旋转半径、横向占比和可缺起点。
		const { columns, rows, cameraDistance, radius, widthShare, origin } = this.model;
		// 用半径与透视放大因子估计旋转时可达范围；依赖模型让相机距离大于半径，未在此检查分母。
		const reach = radius * (cameraDistance / (cameraDistance - radius));
		// Lifting off, the front face must cover exactly the half-block cells (2x2 dots per pixel) despite the
		// perspective.
		// 有原点时补偿前表面深度，使初始每像素约2×2盲文点；无原点时用START_SCALE从小点出现。
		const startScale = origin ? (2 * (cameraDistance - DEPTH / 2)) / cameraDistance : START_SCALE;
		// 同时考虑横向点宽占比、纵向留8点的空间并除reach求结束scale，再以startScale作下限，避免变小。
		const endScale = Math.max(startScale, Math.min(width * 2 * widthShare, (height * 4 - 8) * 0.48) / reach);
		// 点网格宽为终端列数×2，所以横向中心点坐标恰为width。
		const endX = width;
		// 点网格高为行数×4，中心height*2再向上2个点，为底部提示留视觉空间。
		const endY = height * 2 - 2;
		// 有原点时终端列转点坐标后加模型半宽（每像素初始2点）；无原点直接在目标中心起步。
		const startX = origin ? origin.column * 2 + columns : endX;
		// 行转4点，再加模型半高对应的点数rows；无原点则直接使用目标中心高度。
		const startY = origin ? origin.row * 4 + rows : endY;
		// 返回姿态对象，下面都是计算值，不把引用写进全局状态。
		return {
			// X在起点和终点之间按progress线性移动。
			centerX: startX + (endX - startX) * progress,
			// Y同样插值，坐标仍是盲文点而非终端格。
			centerY: startY + (endY - startY) * progress,
			// Interpolate the zoom geometrically so it feels uniform.
			// 用倍率的progress次幂做几何缩放插值，progress=0得startScale、=1得endScale；不是线性相加scale。
			scale: startScale * (endScale / startScale) ** progress,
			// yaw由时间相关旋转相位决定，退出分支会在调用后单独覆盖。
			yaw: spinAngle(time),
			// Tilts are zero at whole turns, so the camera looks straight at the front of the reassembled logo.
			// pitch用相位正弦和progress调制，整圈正面时趋0，尚未飞起时也为0。
			pitch: 0.3 * Math.sin(spinPhase(time)) * progress,
			// roll用双倍相位形成较小侧倾，振幅0.06乘飞行进度。
			roll: 0.06 * Math.sin(2 * spinPhase(time)) * progress,
		};
	}

	// 准备底部退出提示的行/起列/文字/两种颜色，接尺寸、透明混合比例和背景，返回对象或undefined，无终端写入。
	// 例如默认键名escape会生成escape to return；只取首个取消绑定，缺绑定用escape作显示兜底，不因此真的重新绑定Escape。
	// 这里长度/居中/后续取字都按JS UTF-16码元，不是字素或可见列；默认ASCII通常一致，复杂Unicode键名不保证列对齐。
	private hint(
		// 提示可用终端列宽，不是模型像素宽。
		width: number,
		// 当前终端行数，用来把提示放在倒数第二行。
		height: number,
		// 前景与背景的混色比例，不是终端真正alpha通道。
		alpha: number,
		// 本次默认背景RGB，作为淡入时的起始颜色。
		background: Rgb,
		// 返回结构包含0基行/起列、正文、键名码元长度和两RGB颜色；|undefined表示本帧不放提示，不是Promise。
	): { row: number; start: number; text: string; keyLength: number; keyColor: Rgb; color: Rgb } | undefined {
		// 比例不正时不生成文字或查询键位。
		if (alpha <= 0) return undefined;
		// 取当前取消动作首个KeyId并格式化；??只对缺值用escape，formatKeyText会把macOS alt显示成option，不执行动作。
		const key = formatKeyText(getKeybindings().getKeys("tui.select.cancel")[0] ?? "escape");
		// 用键名加固定英文后缀构造文字，模板只生成数据，不读取用户输入。
		const text = `${key} to return`;
		// 码元长度超过width就整条省略，不裁短文字，也未调用visibleWidth。
		if (text.length > width) return undefined;
		// 返回新的显示说明对象。
		return {
			// 指定倒数第二行；高度为1时结果是-1，不会被render的非负row命中，未另外夹限。
			row: height - 2,
			// 按码元长度居中并向下取整；不是按实际字素显示宽度居中。
			start: Math.floor((width - text.length) / 2),
			// 属性简写保存完整提示文字。
			text,
			// 保存键名UTF-16长度，渲染时据它区分键名和后缀颜色。
			keyLength: key.length,
			// 键名从背景混向当前主题muted的RGB，alpha为1时达到该色。
			keyColor: mix(background, toRgb(theme.colors.muted), alpha),
			// 后缀同理使用当前主题dim颜色；这里只有RGB混色，不是应用Theme.fg可能包含的全部字体样式。
			color: mix(background, toRgb(theme.colors.dim), alpha),
		};
	}

	/** A sparse, deterministic starfield: one braille dot in about STAR_DENSITY of all cells. */
	// 按宽高生成稀疏、确定性的星点数组，返回Array<Star|undefined>，不写屏幕或启动计时器。
	// 例如同线性索引总由相同hash/salt选同一盲文点、颜色和速度；STAR_DENSITY只是伪随机阈值，不保证任意小窗口恰好1.8%有星。
	private prepareStars(width: number, height: number): Array<Star | undefined> {
		// new Array(length)建稀疏槽，不是填满undefined值的密集数组；没选中星的索引保持空槽，读取效果为undefined。
		const stars = new Array<Star | undefined>(width * height);
		// 逐格遍历width*height线性索引，不直接按字节或模型块数遍历。
		for (let index = 0; index < width * height; index++) {
			// hash低于密度阈值才放星，其他格continue留下空槽；没有Math.random或网络随机源。
			if (hash(index * 3 + 0x51ed) >= STAR_DENSITY) continue;
			// 局部random按此格index和不同salt生成确定性0..1数，供同一星各属性取样，不推进全局随机状态。
			const random = (salt: number) => hash(index * 7 + salt * 0x9e37);
			// 选中格写入一份Star对象，下面依次保存图符/色/亮度/相位/速度。
			stars[index] = {
				// random(1)选0..7点位，再查单点盲文字符，!只让TS相信索引存在。
				glyph: BRAILLE[DOT_BITS[Math.floor(random(1) * 8)]!]!,
				// random(2)从四种预定tint选一种，元组引用共享，不在这里修改色表。
				tint: STAR_TINTS[Math.floor(random(2) * STAR_TINTS.length)]!,
				// 最大基础混色强度约0.10到不足0.22，之后还会乘淡入和闪烁因子。
				strength: 0.1 + random(3) * 0.12,
				// 相位在0到不足2π之间，让不同星不同时闪亮。
				phase: random(4) * Math.PI * 2,
				// 闪烁角速度约0.4到不足1.2弧度/秒，不是每秒闪烁次数Hz。
				speed: 0.4 + random(5) * 0.8,
			};
		}
		// 返回按线性格索引布置的稀疏数组，未生成ANSI行。
		return stars;
	}

	// 解析保存画面并为每个终端格补delay/seed/ink，接列宽及前景返回新二维ScreenCell数组；有模型起点时把原半块标识区域改空，供3D模型替代。
	// 例如宽2汉字的右占位格复用左格delay，但各列有独立seed；源screen字符串不修改。内部parseScreen只处理已有支持的样式/转义，不是完整终端仿真器。
	private prepareCells(width: number, foreground: Rgb): ScreenCell[][] {
		// 把原行按字素/可见列解析为格，保留显式背景等字段；宽字素额外产生width=0右占位。
		const cells = parseScreen(this.screen, width, foreground, this.background);
		// 再取宿主当前行数并最低用1，供扩散中心/距离归一化，不把输入screen裁成正好这么多行。
		const height = Math.max(1, this.tui.terminal.rows);
		// 解构模型像素尺寸和可缺的半块渲染起点。
		const { columns, rows, origin } = this.model;
		// The dust spreads out from where the model starts.
		// 有原点则用其终端列加模型半宽当扩散中心，否则视口宽的一半；这里单位回到终端格。
		const centerX = origin ? origin.column + columns / 2 : width / 2;
		// 半块每终端行对应2像素，模型半高换成rows/4行；无原点则用height/2。
		const centerY = origin ? origin.row + rows / 4 : height / 2;
		// 求到视口远角的归一化距离上界，纵差乘2近似补偿格高约为格宽两倍；不是精确物理尺寸探测。
		const farthest = Math.hypot(Math.max(centerX, width - centerX), Math.max(centerY, height - centerY) * 2);
		// 按已解析的所有源行遍历，数量可能与当前终端高度不同。
		for (let row = 0; row < cells.length; row++) {
			// 取这行格数组，!不做运行时验证。
			const line = cells[row]!;
			// 按解析后的终端列/占位格遍历，不按原字符串码元下标遍历。
			for (let column = 0; column < line.length; column++) {
				// 取当前可修改的ScreenCell对象。
				const cell = line[column]!;
				// Wide graphemes share their first column's timing so both halves change together.
				// width为0的宽字素右半格取紧邻左格作owner，其他格自作owner；依赖parseScreen的配对布局约定。
				const owner = cell.width === 0 ? line[column - 1]! : cell;
				// 以行列组合求确定性散列值，65_537的下划线只是数字分隔符。
				const seed = hash(row * 65_537 + column);
				// 非右占位才独立计算扩散时间。
				if (cell.width !== 0) {
					// 按横向差和放大两倍的纵向差求归一化距离，farthest用于把扩散大致限制到波浪传播范围。
					const distance = Math.hypot(column - centerX, (row - centerY) * 2) / farthest;
					// delay由飞行起点、距离传播和最多WAVE_JITTER的散列抖动组成，单位秒。
					cell.delay = FLY_START + distance * WAVE_SPREAD + seed * WAVE_JITTER;
					// 右占位不用自己距离重算，以便和宽字素左半同步变化。
				} else {
					// 直接复用owner已经算好的delay，不改owner本身。
					cell.delay = owner.delay;
				}
				// 保存未经hash的行列组合种子，render再结合frame/attempt求尘点位置。
				cell.seed = row * 65_537 + column;
				// 按owner原字和本格散列估墨量；两半共享字/时序，但seed不同，ink也不保证完全相同。
				cell.ink = glyphInk(owner.text, seed);
			}
		}
		// The 3D model replaces its half-block rendering on screen.
		// 只有有明确起飞原点的模型才移除原半块位图；中心长大的Armin不指定这块矩形。
		if (origin) {
			// 模型像素行数除2向上取整，得到原半块渲染所占终端行数；按原点开始处理。
			for (let row = origin.row; row < origin.row + Math.ceil(rows / 2); row++) {
				// 源画面可能没有这一行，允许得到undefined。
				const line = cells[row];
				// 缺行直接跳过，不新建空源行或报越界。
				if (!line) continue;
				// 按模型像素列数对应的终端格宽清理原标识矩形，不逐像素再问它是否为前景块。
				for (let column = origin.column; column < origin.column + columns; column++) {
					// 取原矩形中的可缺格；超源行长度时undefined。
					const cell = line[column];
					// 存在格才修改，未补齐不存在的列。
					if (cell) {
						// 把旧标识字符替成普通空格，避免2D原图与3D模型重叠。
						cell.text = " ";
						// 将此格按单列空格处理，不再保留原宽字素主格/右占位标记。
						cell.width = 1;
						// 墨量清0，旧标识不再散出文字尘点。
						cell.ink = 0;
						// 撤销显式背景，让默认背景/后续色晕接管；没有清fg、delay或seed。
						cell.bg = undefined;
					}
				}
			}
		}
		// 返回本次新解析/补时序的格数组，保留输入screen行字符串。
		return cells;
	}

	// 把RGB元组三通道四舍五入并按位拼成数值键，返回number，无缓存或I/O；例[255,0,0]得到0xff0000。
	// 位运算按JS 32位整数处理，依赖上游颜色在合理范围；此处不验证/夹限通道，不能当通用颜色校验器。
	private pack(color: Rgb): number {
		// 红左移16位、绿左移8位、蓝留低位再按位或；先各Math.round，不是用数组引用作Map键。
		return (Math.round(color[0]) << 16) | (Math.round(color[1]) << 8) | Math.round(color[2]);
	}

	// 按打包RGB和前/背景标志取得ANSI开启串，返回string；先查实例缓存，未命中才解通道、按当前theme模式编码并缓存，不发送终端。
	// 例同色前景和背景用相邻不同cacheKey；键没有包含颜色模式，模式变化需invalidate清缓存，已有命中不会重新读模式。
	private ansi(key: number, isBackground: boolean): string {
		// RGB键乘2预留最低一位，背景加1、前景加0，避免同色两种用途混用。
		const cacheKey = key * 2 + (isBackground ? 1 : 0);
		// 查Map，缺项为undefined；let允许miss时回写新编码。
		let value = this.ansiCache.get(cacheKey);
		// 只对缺项生成字符串，缓存空字符串也不会因假值被当miss。
		if (value === undefined) {
			// 用移位/255掩码取各8位通道再rgbColor构造颜色；rgbColor会验证范围/有限性，但不验证此前pack是否丢失高位信息。
			const color = rgbColor((key >> 16) & 255, (key >> 8) & 255, key & 255);
			// 在miss时读取共享theme的颜色模式，不重新探测终端；可能为truecolor或256color。
			const mode = theme.getColorMode();
			// 背景选backgroundAnsi，前景选foregroundAnsi，函数只编码SGR；256color模式会做RGB近似映射。
			value = isBackground ? backgroundAnsi(color, mode) : foregroundAnsi(color, mode);
			// 保存字符串到本实例Map，后续同key直接复用。
			this.ansiCache.set(cacheKey, value);
		}
		// 返回命中或刚生成的编码，不附自动复位码；行末复位由render添加。
		return value;
	}
}
