/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是“终端贪吃蛇小游戏”。
 * 上游：用户在 TUI 中输入 /snake 启动。下游：ctx.sessionManager.getEntries() 读取上次保存
 * 的游戏状态；ctx.ui.custom() 挂载 SnakeComponent；setInterval 驱动 tick；matchesKey 与
 * visibleWidth 处理按键和终端宽度；pi.appendEntry("snake-save", state) 把进度写入会话。
 *
 * 演示的机制：扩展可以用自定义 Component 占满视口、自己维护游戏循环与渲染缓存；游戏进度
 * 不写外部文件，而是作为自定义会话条目保存，恢复会话或切换分支后仍可继续。Esc 暂停并保存，
 * Q 退出并清除保存，游戏结束后 R/空格重开。
 *
 * 能力清单：
 * - Direction/Point/GameState：方向、坐标与完整游戏状态。
 * - createInitialState()：生成三条蛇身、初始食物与分数。
 * - spawnFood(snake)：随机生成不与蛇身重叠的食物。
 * - SnakeComponent：tick 游戏步进、handleInput 键盘处理、render 网格渲染、dispose 清理定时器。
 * - 默认导出：注册 /snake 命令，读取最后一条 snake-save 并打开组件。
 *
 * 典型运行顺序：输入 /snake -> 方向键/WASD 移动 -> 吃到食物加分 -> Esc 暂停保存并关闭 ->
 * 再次 /snake 从暂停状态继续 -> Q 清除进度。
 *
 * 示例（真实签名）：
 *   pi.appendEntry<GameState>("snake-save", state); // state 为 null 时表示清除
 *   ctx.ui.custom((tui, _theme, _kb, done) => new SnakeComponent(tui, () => done(undefined), onSave, saved));
 *
 * 建议阅读顺序：先看 GameState 与 createInitialState，再看 SnakeComponent.tick 的移动/碰撞，
 * 然后看 render 的网格与缓存，最后看命令中的状态读取与保存回调。
 *
 * 前置条件：仅 TUI 模式可用；不调用模型、不产生费用；关闭组件前必须 dispose 定时器，否则
 * 定时器会在界面消失后继续触发 requestRender。
 */

/**
 * Snake game extension - play snake with /snake command
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";

// 逻辑网格尺寸；渲染时每个格子占 2 个终端列以接近正方形。
const GAME_WIDTH = 40;
const GAME_HEIGHT = 15;
// 逻辑步进间隔（毫秒）；渲染更新由 version 计数驱动，不额外定时。
const TICK_MS = 100;

// 方向是字面量联合，switch 可以穷尽检查。
type Direction = "up" | "down" | "left" | "right";
// 网格坐标从 0 开始，越界即撞墙。
type Point = { x: number; y: number };

// 游戏状态是可 JSON 序列化的纯数据，因此能直接写入会话条目。
interface GameState {
	snake: Point[];
	food: Point;
	direction: Direction;
	// nextDirection 暂存本 tick 内收到的转向，避免同一 tick 连续转向导致自撞。
	nextDirection: Direction;
	score: number;
	gameOver: boolean;
	highScore: number;
}

// 新游戏：蛇身水平放在中央，头在最右，朝右移动。
function createInitialState(): GameState {
	const startX = Math.floor(GAME_WIDTH / 2);
	const startY = Math.floor(GAME_HEIGHT / 2);
	return {
		snake: [
			{ x: startX, y: startY },
			{ x: startX - 1, y: startY },
			{ x: startX - 2, y: startY },
		],
		// 只把蛇头传给 spawnFood；初始食物仍可能落在身体上，这是示例的简化。
		food: spawnFood([{ x: startX, y: startY }]),
		direction: "right",
		nextDirection: "right",
		score: 0,
		gameOver: false,
		highScore: 0,
	};
}

// 随机找空格：do-while 先抽再检查，蛇占满整个网格时会无限循环。
function spawnFood(snake: Point[]): Point {
	let food: Point;
	do {
		food = {
			x: Math.floor(Math.random() * GAME_WIDTH),
			y: Math.floor(Math.random() * GAME_HEIGHT),
		};
	} while (snake.some((s) => s.x === food.x && s.y === food.y));
	return food;
}

// 游戏组件实现 Component 的可选子集：render/invalidate/handleInput。
class SnakeComponent {
	// 当前游戏状态；保存时直接把引用写进会话（appendEntry 会序列化）。
	private state: GameState;
	// 定时器句柄；null 表示未运行（暂停或已关闭）。
	private interval: ReturnType<typeof setInterval> | null = null;
	private onClose: () => void;
	// null 表示要求清除已保存进度。
	private onSave: (state: GameState | null) => void;
	// 只依赖 requestRender，不持有完整 TUI 类型，便于测试与解耦。
	private tui: { requestRender: () => void };
	// 渲染缓存：宽度和 version 都未变时直接返回上次结果。
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	// version 在状态变化时递增；-1 保证首次渲染一定重建缓存。
	private version = 0;
	private cachedVersion = -1;
	private paused: boolean;

	constructor(
		tui: { requestRender: () => void },
		onClose: () => void,
		onSave: (state: GameState | null) => void,
		savedState?: GameState,
	) {
		this.tui = tui;
		// 有未结束的存档：恢复并以暂停状态打开，等用户按键再启动定时器。
		if (savedState && !savedState.gameOver) {
			// Resume from saved state, start paused
			this.state = savedState;
			this.paused = true;
		} else {
			// New game or saved game was over
			// 新游戏：只继承最高分。
			this.state = createInitialState();
			if (savedState) {
				this.state.highScore = savedState.highScore;
			}
			this.paused = false;
			// 立即开始循环；每 TICK_MS 推进一次。
			this.startGame();
		}
		this.onClose = onClose;
		this.onSave = onSave;
	}

	// 启动定时器：游戏结束后仍保留 interval，但回调不再 tick。
	private startGame(): void {
		this.interval = setInterval(() => {
			if (!this.state.gameOver) {
				this.tick();
				// 状态变化后递增 version，使 render 缓存失效。
				this.version++;
				this.tui.requestRender();
			}
		}, TICK_MS);
	}

	// 一步游戏逻辑：应用转向、移动头、判定撞墙/自撞/吃食。
	private tick(): void {
		// Apply queued direction change
		// 使用 nextDirection 而不是 direction，保证一个 tick 只转向一次。
		this.state.direction = this.state.nextDirection;

		// Calculate new head position
		const head = this.state.snake[0];
		let newHead: Point;

		// 四个方向分别计算新头坐标；switch 覆盖 Direction 的全部取值。
		switch (this.state.direction) {
			case "up":
				newHead = { x: head.x, y: head.y - 1 };
				break;
			case "down":
				newHead = { x: head.x, y: head.y + 1 };
				break;
			case "left":
				newHead = { x: head.x - 1, y: head.y };
				break;
			case "right":
				newHead = { x: head.x + 1, y: head.y };
				break;
		}

		// Check wall collision
		// 网格外即撞墙；边界用半开区间 [0, GAME_WIDTH) / [0, GAME_HEIGHT)。
		if (newHead.x < 0 || newHead.x >= GAME_WIDTH || newHead.y < 0 || newHead.y >= GAME_HEIGHT) {
			this.state.gameOver = true;
			return;
		}

		// Check self collision
		// 注意：尾巴在本 tick 会移走，这里仍把它算作碰撞，属于示例的保守判定。
		if (this.state.snake.some((s) => s.x === newHead.x && s.y === newHead.y)) {
			this.state.gameOver = true;
			return;
		}

		// Move snake
		// 先插入新头；若没吃到食物，稍后弹出尾巴，整体前移一格。
		this.state.snake.unshift(newHead);

		// Check food collision
		if (newHead.x === this.state.food.x && newHead.y === this.state.food.y) {
			// 吃到食物加 10 分，蛇身长度保持不变（不 pop）。
			this.state.score += 10;
			if (this.state.score > this.state.highScore) {
				this.state.highScore = this.state.score;
			}
			// 新食物可能生成在蛇身之外；spawnFood 会重抽直到不重叠。
			this.state.food = spawnFood(this.state.snake);
		} else {
			this.state.snake.pop();
		}
	}

	// 键盘输入：暂停时任意键继续，Esc 暂停保存，Q 退出清档，方向键/WASD 转向。
	handleInput(data: string): void {
		// If paused (resuming), wait for any key
		if (this.paused) {
			// 暂停状态下 Esc/Q 直接关闭，但不清除存档。
			if (matchesKey(data, "escape") || data === "q" || data === "Q") {
				// Quit without clearing save
				this.dispose();
				this.onClose();
				return;
			}
			// Any other key resumes
			// 其他任意键继续游戏并重新启动定时器。
			this.paused = false;
			this.startGame();
			return;
		}

		// ESC to pause and save
		// Esc：停止定时器、保存当前状态、关闭组件。顺序上先 dispose 再 onSave。
		if (matchesKey(data, "escape")) {
			this.dispose();
			this.onSave(this.state);
			this.onClose();
			return;
		}

		// Q to quit without saving (clears saved state)
		// Q：传入 null，命令侧会写一条 data 为 null 的条目覆盖旧存档。
		if (data === "q" || data === "Q") {
			this.dispose();
			this.onSave(null); // Clear saved state
			this.onClose();
			return;
		}

		// Arrow keys or WASD
		// 反向键被忽略（例如向右时按左），否则会立即自撞。
		if (matchesKey(data, "up") || data === "w" || data === "W") {
			if (this.state.direction !== "down") this.state.nextDirection = "up";
		} else if (matchesKey(data, "down") || data === "s" || data === "S") {
			if (this.state.direction !== "up") this.state.nextDirection = "down";
		} else if (matchesKey(data, "right") || data === "d" || data === "D") {
			if (this.state.direction !== "left") this.state.nextDirection = "right";
		} else if (matchesKey(data, "left") || data === "a" || data === "A") {
			if (this.state.direction !== "right") this.state.nextDirection = "left";
		}

		// Restart on game over
		// 游戏结束后 R 或空格重开；先保存最高分，再重置状态。
		if (this.state.gameOver && (data === "r" || data === "R" || data === " ")) {
			const highScore = this.state.highScore;
			this.state = createInitialState();
			this.state.highScore = highScore;
			// 重开时清除旧存档，避免下次启动恢复到结束状态。
			this.onSave(null); // Clear saved state on restart
			this.version++;
			this.tui.requestRender();
		}
	}

	// 只需清空宽度缓存；version 未变但宽度可能变，下一次 render 会重建。
	invalidate(): void {
		this.cachedWidth = 0;
	}

	// 渲染完整游戏画面；ANSI 颜色直接写字符串，未使用主题系统。
	render(width: number): string[] {
		// 宽度和版本都匹配时才复用缓存；游戏每 tick 递增 version。
		if (width === this.cachedWidth && this.cachedVersion === this.version) {
			return this.cachedLines;
		}

		const lines: string[] = [];

		// Each game cell is 2 chars wide to appear square (terminal cells are ~2:1 aspect)
		const cellWidth = 2;
		// 减去左右边框与内边距占用的 4 列；窄终端时网格会变窄。
		const effectiveWidth = Math.min(GAME_WIDTH, Math.floor((width - 4) / cellWidth));
		const effectiveHeight = GAME_HEIGHT;

		// Colors
		// 局部着色函数返回带 ANSI 转义的字符串；22 是关闭粗体/暗色，0 是全部重置。
		const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
		const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
		const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
		const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

		// 边框内部宽度：有效列数 × 每格 2 字符。
		const boxWidth = effectiveWidth * cellWidth;

		// Helper to pad content inside box
		// 计算可见宽度（忽略 ANSI）后补空格，保证右边框对齐。
		const boxLine = (content: string) => {
			const contentLen = visibleWidth(content);
			const padding = Math.max(0, boxWidth - contentLen);
			return dim(" │") + content + " ".repeat(padding) + dim("│");
		};

		// Top border
		lines.push(this.padLine(dim(` ╭${"─".repeat(boxWidth)}╮`), width));

		// Header with score
		const scoreText = `Score: ${bold(yellow(String(this.state.score)))}`;
		const highText = `High: ${bold(yellow(String(this.state.highScore)))}`;
		const title = `${bold(green("SNAKE"))} │ ${scoreText} │ ${highText}`;
		lines.push(this.padLine(boxLine(title), width));

		// Separator
		lines.push(this.padLine(dim(` ├${"─".repeat(boxWidth)}┤`), width));

		// Game grid
		// 逐行逐列扫描网格；优先级：蛇头 > 蛇身 > 食物 > 空格。
		for (let y = 0; y < effectiveHeight; y++) {
			let row = "";
			for (let x = 0; x < effectiveWidth; x++) {
				const isHead = this.state.snake[0].x === x && this.state.snake[0].y === y;
				// slice(1) 排除蛇头；每条蛇身格都要线性查找一次。
				const isBody = this.state.snake.slice(1).some((s) => s.x === x && s.y === y);
				const isFood = this.state.food.x === x && this.state.food.y === y;

				if (isHead) {
					row += green("██"); // Snake head (2 chars)
				} else if (isBody) {
					row += green("▓▓"); // Snake body (2 chars)
				} else if (isFood) {
					row += red("◆ "); // Food (2 chars)
				} else {
					row += "  "; // Empty cell (2 spaces)
				}
			}
			lines.push(this.padLine(dim(" │") + row + dim("│"), width));
		}

		// Separator
		lines.push(this.padLine(dim(` ├${"─".repeat(boxWidth)}┤`), width));

		// Footer
		// 三态提示：暂停、结束、进行中；文字颜色与状态匹配。
		let footer: string;
		if (this.paused) {
			footer = `${yellow(bold("PAUSED"))} Press any key to continue, ${bold("Q")} to quit`;
		} else if (this.state.gameOver) {
			footer = `${red(bold("GAME OVER!"))} Press ${bold("R")} to restart, ${bold("Q")} to quit`;
		} else {
			footer = `↑↓←→ or WASD to move, ${bold("ESC")} pause, ${bold("Q")} quit`;
		}
		lines.push(this.padLine(boxLine(footer), width));

		// Bottom border
		lines.push(this.padLine(dim(` ╰${"─".repeat(boxWidth)}╯`), width));

		// 缓存本次结果；cachedVersion 与 version 对齐后，无状态变化时不再重建。
		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedVersion = this.version;

		return lines;
	}

	// 把一行补齐到终端宽度；用正则去掉 ANSI 后计算可见长度。
	private padLine(line: string, width: number): string {
		// Calculate visible length (strip ANSI codes)
		const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, "").length;
		const padding = Math.max(0, width - visibleLen);
		return line + " ".repeat(padding);
	}

	// 清理定时器；关闭、暂停、退出时都必须调用，避免后台继续 tick。
	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}
}

// 自定义会话条目类型；用于在同一会话中区分不同扩展的数据。
const SNAKE_SAVE_TYPE = "snake-save";

// 扩展入口：注册 /snake 命令。
export default function (pi: ExtensionAPI) {
	pi.registerCommand("snake", {
		description: "Play Snake!",

		handler: async (_args, ctx) => {
			// 自定义全屏组件只在 TUI 可用；其他模式只提示。
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Snake requires interactive mode", "error");
				return;
			}

			// Load saved state from session
			// getEntries 返回完整会话（不只当前分支）；从后往前找最新一条存档。
			const entries = ctx.sessionManager.getEntries();
			let savedState: GameState | undefined;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				// data 是 unknown，断言成 GameState；null 存档会导致 savedState 为 null。
				if (entry.type === "custom" && entry.customType === SNAKE_SAVE_TYPE) {
					savedState = entry.data as GameState;
					break;
				}
			}

			// custom 会等待 done()；组件回调负责保存并关闭。
			await ctx.ui.custom((tui, _theme, _kb, done) => {
				return new SnakeComponent(
					tui,
					() => done(undefined),
					(state) => {
						// Save or clear state
						// state 为 null 时写入 null，表示清除进度。
						pi.appendEntry(SNAKE_SAVE_TYPE, state);
					},
					savedState,
				);
			});
		},
	});
}
