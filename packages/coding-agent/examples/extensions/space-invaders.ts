/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是“终端太空侵略者”。
 * 上游：用户在 TUI 中输入 /invaders 启动。下游：ctx.sessionManager.getEntries() 读取存档；
 * ctx.ui.custom() 挂载 SpaceInvadersComponent；setInterval 每 50ms 推进游戏；isKeyRelease
 * 区分按键按下/松开；pi.appendEntry("space-invaders-save", state) 保存进度。
 *
 * 演示的机制：组件通过 `wantsKeyRelease = true` 请求 Kitty 键盘协议的松开事件，从而在按住
 * 方向键时持续移动、松开即停；玩家、外星人、子弹、掩体都由简单坐标与布尔网格表示。失败或
 * 胜利后 R/空格重开，胜利会进入下一关（外星人移动延迟随关卡与剩余数量变化）。
 *
 * 能力清单：
 * - Point/Bullet/Alien/Shield/GameState/KeyState：游戏数据结构。
 * - createShields/createAliens/createInitialState：生成关卡初始布局。
 * - SpaceInvadersComponent：tick 主循环、moveAliens、alienShoot、checkCollisions、
 *   handleInput、render、dispose。
 * - 默认导出：注册 /invaders 命令，恢复存档并打开组件。
 *
 * 典型运行顺序：输入 /invaders -> 方向键/AD 移动、空格/F 射击 -> 击中外星人得分 ->
 * Esc 暂停保存 -> 再次打开继续 -> 清空外星人进入下一关或死亡后重开。
 *
 * 示例（真实签名）：
 *   class SpaceInvadersComponent { wantsKeyRelease = true; handleInput(data: string): void }
 *   // 按键事件里 isKeyRelease(data) 为 true 表示松开，用于把 keys.left 置回 false。
 *
 * 建议阅读顺序：先看常量与三个生成函数，再看 tick 中的玩家移动/射击/子弹更新，然后看
 * moveAliens/alienShoot/checkCollisions，最后看 handleInput 与 render。
 *
 * 前置条件：仅 TUI 模式；按住/松开事件依赖终端支持 Kitty 键盘协议，不支持时按键会被当作
 * 重复按下。不调用模型、不产生费用；关闭前必须 dispose 定时器。
 */

/**
 * Space Invaders game extension - play with /invaders command
 * Uses Kitty keyboard protocol for smooth movement (press/release detection)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";

// 游戏网格与节奏常量；PLAYER_Y 固定在底部上方一行。
const GAME_WIDTH = 60;
const GAME_HEIGHT = 24;
const TICK_MS = 50;
const PLAYER_Y = GAME_HEIGHT - 2;
const ALIEN_ROWS = 5;
const ALIEN_COLS = 11;
const ALIEN_START_Y = 2;

type Point = { x: number; y: number };

// 子弹方向用 -1/1 表示向上/向下，同时决定每 tick 的 y 增量。
interface Bullet extends Point {
	direction: -1 | 1; // -1 = up (player), 1 = down (alien)
}

// type 决定分值、颜色与精灵；alive 为 false 后仍保留在数组中。
interface Alien extends Point {
	type: number; // 0, 1, 2 for different alien types
	alive: boolean;
}

// 掩体只有 x；y 由渲染/碰撞时用 PLAYER_Y - 5 推导。
interface Shield {
	x: number;
	segments: boolean[][]; // 4x3 grid of destructible segments
}

// 全部游戏状态；直接作为自定义会话条目持久化。
interface GameState {
	player: { x: number; lives: number };
	aliens: Alien[];
	// 整群外星人的移动方向；撞边后取反并下移。
	alienDirection: 1 | -1;
	// 计数器达到 alienMoveDelay 时移动一次外星人。
	alienMoveCounter: number;
	alienMoveDelay: number;
	// 撞边后的下一 tick 只下移、不横移。
	alienDropping: boolean;
	bullets: Bullet[];
	shields: Shield[];
	score: number;
	highScore: number;
	level: number;
	gameOver: boolean;
	victory: boolean;
	// 外星人射击节流计数器。
	alienShootCounter: number;
}

// 按住状态；由按键按下/松开事件维护。
interface KeyState {
	left: boolean;
	right: boolean;
	fire: boolean;
}

// 四块掩体，水平等距分布；下排中间留缺口形成拱形。
function createShields(): Shield[] {
	const shields: Shield[] = [];
	const shieldPositions = [8, 22, 36, 50];
	for (const x of shieldPositions) {
		shields.push({
			x,
			segments: [
				[true, true, true, true],
				[true, true, true, true],
				[true, false, false, true],
			],
		});
	}
	return shields;
}

// 5×11 外星人方阵；上方两行类型更“值钱”，x 间距 5、y 间距 2 方便渲染精灵。
function createAliens(): Alien[] {
	const aliens: Alien[] = [];
	for (let row = 0; row < ALIEN_ROWS; row++) {
		// 第一行 type 2，第二三行 type 1，其余 type 0。
		const type = row === 0 ? 2 : row < 3 ? 1 : 0;
		for (let col = 0; col < ALIEN_COLS; col++) {
			aliens.push({
				x: 4 + col * 5,
				y: ALIEN_START_Y + row * 2,
				type,
				alive: true,
			});
		}
	}
	return aliens;
}

// 新关卡：保留最高分与关卡号；外星人移动延迟随关卡提高而缩短，下限 5。
function createInitialState(highScore = 0, level = 1): GameState {
	return {
		player: { x: Math.floor(GAME_WIDTH / 2), lives: 3 },
		aliens: createAliens(),
		alienDirection: 1,
		alienMoveCounter: 0,
		alienMoveDelay: Math.max(5, 20 - level * 2),
		alienDropping: false,
		bullets: [],
		shields: createShields(),
		score: 0,
		highScore,
		level,
		gameOver: false,
		victory: false,
		alienShootCounter: 0,
	};
}

// 游戏组件：维护状态、输入与定时器，实现 render/invalidate/handleInput。
class SpaceInvadersComponent {
	private state: GameState;
	// 按住状态；松开事件会把对应字段置 false。
	private keys: KeyState = { left: false, right: false, fire: false };
	private interval: ReturnType<typeof setInterval> | null = null;
	private onClose: () => void;
	private onSave: (state: GameState | null) => void;
	private tui: { requestRender: () => void };
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private version = 0;
	private cachedVersion = -1;
	private paused: boolean;
	// 射击冷却，防止按住空格每 tick 都发射。
	private fireCooldown = 0;
	// 玩家每两个 tick 移动一次，避免在 50ms 步进下过快。
	private playerMoveCounter = 0;

	// Opt-in to key release events for smooth movement
	// 声明需要松开事件；终端不支持 Kitty 协议时该标记无效，移动会变成离散按键。
	wantsKeyRelease = true;

	constructor(
		tui: { requestRender: () => void },
		onClose: () => void,
		onSave: (state: GameState | null) => void,
		savedState?: GameState,
	) {
		this.tui = tui;
		// 只有未结束且未胜利的存档才恢复；否则用旧最高分开新局。
		if (savedState && !savedState.gameOver && !savedState.victory) {
			this.state = savedState;
			this.paused = true;
		} else {
			this.state = createInitialState(savedState?.highScore);
			this.paused = false;
			this.startGame();
		}
		this.onClose = onClose;
		this.onSave = onSave;
	}

	// 每 TICK_MS 推进一次；结束或胜利后定时器仍存在但不再 tick。
	private startGame(): void {
		this.interval = setInterval(() => {
			if (!this.state.gameOver && !this.state.victory) {
				this.tick();
				this.version++;
				this.tui.requestRender();
			}
		}, TICK_MS);
	}

	// 一个游戏 tick 的完整流程：玩家移动、射击、子弹移动、外星人移动/射击、碰撞、胜利判定。
	private tick(): void {
		// Player movement (smooth, every other tick)
		this.playerMoveCounter++;
		if (this.playerMoveCounter >= 2) {
			this.playerMoveCounter = 0;
			// 玩家占 (x-1, x, x+1) 三格，因此左右各留 2/3 格边界。
			if (this.keys.left && this.state.player.x > 2) {
				this.state.player.x--;
			}
			if (this.keys.right && this.state.player.x < GAME_WIDTH - 3) {
				this.state.player.x++;
			}
		}

		// Fire cooldown
		// 每 tick 减一；到 0 才允许再次发射。
		if (this.fireCooldown > 0) this.fireCooldown--;

		// Player shooting
		if (this.keys.fire && this.fireCooldown === 0) {
			// 屏幕上最多两颗玩家子弹，避免火力过强。
			const playerBullets = this.state.bullets.filter((b) => b.direction === -1);
			if (playerBullets.length < 2) {
				this.state.bullets.push({ x: this.state.player.x, y: PLAYER_Y - 1, direction: -1 });
				this.fireCooldown = 8;
			}
		}

		// Move bullets
		// 先按方向移动 y，再过滤掉越界的子弹；filter 会替换数组引用。
		this.state.bullets = this.state.bullets.filter((bullet) => {
			bullet.y += bullet.direction;
			return bullet.y >= 0 && bullet.y < GAME_HEIGHT;
		});

		// Alien movement
		// 计数器累积到延迟值才移动整群，延迟越小移动越快。
		this.state.alienMoveCounter++;
		if (this.state.alienMoveCounter >= this.state.alienMoveDelay) {
			this.state.alienMoveCounter = 0;
			this.moveAliens();
		}

		// Alien shooting
		// 固定每 30 tick 尝试射击一次；是否真的发射还受底部外星人与子弹数限制。
		this.state.alienShootCounter++;
		if (this.state.alienShootCounter >= 30) {
			this.state.alienShootCounter = 0;
			this.alienShoot();
		}

		// Collision detection
		this.checkCollisions();

		// Check victory
		// every 对空数组返回 true，但外星人数组始终保留 55 项，只把 alive 置 false。
		if (this.state.aliens.every((a) => !a.alive)) {
			this.state.victory = true;
		}
	}

	// 整群外星人的移动：正常横移，撞到左右边界后下一 tick 下移；剩余越少速度越快。
	private moveAliens(): void {
		// 只处理存活外星人；全部死亡后直接返回。
		const aliveAliens = this.state.aliens.filter((a) => a.alive);
		if (aliveAliens.length === 0) return;

		if (this.state.alienDropping) {
			// Drop down
			// 下移一 tick；任何一只到达玩家上方一行就判负。
			for (const alien of aliveAliens) {
				alien.y++;
				if (alien.y >= PLAYER_Y - 1) {
					this.state.gameOver = true;
					return;
				}
			}
			// 下移完成后恢复横移。
			this.state.alienDropping = false;
		} else {
			// Check if we need to change direction
			// 用存活外星人的最左/最右 x 判断是否撞边，而不是整群原始边界。
			const minX = Math.min(...aliveAliens.map((a) => a.x));
			const maxX = Math.max(...aliveAliens.map((a) => a.x));

			if (
				(this.state.alienDirection === 1 && maxX >= GAME_WIDTH - 3) ||
				(this.state.alienDirection === -1 && minX <= 2)
			) {
				// 撞边：反向，并标记下一 tick 下移。
				this.state.alienDirection *= -1;
				this.state.alienDropping = true;
			} else {
				// Move horizontally
				// 直接修改每个外星人对象的 x，数组元素是引用。
				for (const alien of aliveAliens) {
					alien.x += this.state.alienDirection;
				}
			}
		}

		// Speed up as fewer aliens remain
		// 剩余数量阈值决定新的移动延迟；注意这里不恢复变慢，只会越来越快。
		const aliveCount = aliveAliens.length;
		if (aliveCount <= 5) {
			this.state.alienMoveDelay = 1;
		} else if (aliveCount <= 10) {
			this.state.alienMoveDelay = 2;
		} else if (aliveCount <= 20) {
			this.state.alienMoveDelay = 3;
		}
	}

	// 外星人射击：每列只允许最底部的外星人开火，全局最多 3 颗敌方子弹。
	private alienShoot(): void {
		const aliveAliens = this.state.aliens.filter((a) => a.alive);
		if (aliveAliens.length === 0) return;

		// Find bottom-most alien in each column
		// 以 x 为列键；y 越大越靠下，保留每列 y 最大的外星人。
		const columns = new Map<number, Alien>();
		for (const alien of aliveAliens) {
			const existing = columns.get(alien.x);
			if (!existing || alien.y > existing.y) {
				columns.set(alien.x, alien);
			}
		}

		// Random column shoots
		const shooters = Array.from(columns.values());
		// 敌方子弹总数上限 3；shooter 从可射击列中随机选。
		if (shooters.length > 0 && this.state.bullets.filter((b) => b.direction === 1).length < 3) {
			const shooter = shooters[Math.floor(Math.random() * shooters.length)];
			this.state.bullets.push({ x: shooter.x, y: shooter.y + 1, direction: 1 });
		}
	}

	// 碰撞检测：玩家子弹打外星人、敌方子弹打玩家、双方子弹打掩体。
	private checkCollisions(): void {
		// 用 Set 收集待删除子弹；同一颗子弹可能命中多个掩体，但只删一次。
		const bulletsToRemove = new Set<Bullet>();

		for (const bullet of this.state.bullets) {
			// Player bullets hitting aliens
			if (bullet.direction === -1) {
				for (const alien of this.state.aliens) {
					// 外星人精灵占 3 列，因此 |dx| <= 1 且 y 相等即命中。
					if (alien.alive && Math.abs(bullet.x - alien.x) <= 1 && bullet.y === alien.y) {
						alien.alive = false;
						bulletsToRemove.add(bullet);
						// type 2/1/0 分别得 30/20/10 分。
						const points = [10, 20, 30][alien.type];
						this.state.score += points;
						if (this.state.score > this.state.highScore) {
							this.state.highScore = this.state.score;
						}
						// 一颗子弹只击中一只外星人。
						break;
					}
				}
			}

			// Alien bullets hitting player
			if (bullet.direction === 1) {
				// 玩家同样占 3 列；y 必须正好在 PLAYER_Y。
				if (Math.abs(bullet.x - this.state.player.x) <= 1 && bullet.y === PLAYER_Y) {
					bulletsToRemove.add(bullet);
					this.state.player.lives--;
					if (this.state.player.lives <= 0) {
						this.state.gameOver = true;
					}
				}
			}

			// Bullets hitting shields
			// 掩体区域是 4 列×3 行；相对坐标落在范围内且该段仍存在时销毁该段。
			for (const shield of this.state.shields) {
				const relX = bullet.x - shield.x;
				const relY = bullet.y - (PLAYER_Y - 5);
				if (relX >= 0 && relX < 4 && relY >= 0 && relY < 3) {
					if (shield.segments[relY][relX]) {
						shield.segments[relY][relX] = false;
						bulletsToRemove.add(bullet);
					}
				}
			}
		}

		// 一次性过滤，避免遍历过程中修改数组。
		this.state.bullets = this.state.bullets.filter((b) => !bulletsToRemove.has(b));
	}

	// 键盘入口：用 isKeyRelease 区分按下/松开；控制键只响应按下，移动/射击两者都处理。
	handleInput(data: string): void {
		// released 为 true 表示松开事件；没有 Kitty 协议时始终 false。
		const released = isKeyRelease(data);

		// Pause handling
		// 暂停时只响应按下事件，避免松开瞬间又触发一次逻辑。
		if (this.paused && !released) {
			// 暂停中 Esc/Q 关闭且保留存档。
			if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
				this.dispose();
				this.onClose();
				return;
			}
			// 其他任意按下键恢复游戏。
			this.paused = false;
			this.startGame();
			return;
		}

		// ESC to pause and save
		// 运行中 Esc：停表、保存、关闭。
		if (!released && matchesKey(data, Key.escape)) {
			this.dispose();
			this.onSave(this.state);
			this.onClose();
			return;
		}

		// Q to quit without saving
		// Q：保存 null 清除存档。
		if (!released && (data === "q" || data === "Q")) {
			this.dispose();
			this.onSave(null);
			this.onClose();
			return;
		}

		// Movement keys (track press/release state)
		// 方向键与 AD 都支持；松开事件把对应按住标记置 false。
		if (matchesKey(data, Key.left) || data === "a" || data === "A" || matchesKey(data, "a")) {
			this.keys.left = !released;
		}
		if (matchesKey(data, Key.right) || data === "d" || data === "D" || matchesKey(data, "d")) {
			this.keys.right = !released;
		}

		// Fire key
		// 空格或 F 控制持续射击；实际射速由 fireCooldown 限制。
		if (matchesKey(data, Key.space) || data === " " || data === "f" || data === "F" || matchesKey(data, "f")) {
			this.keys.fire = !released;
		}

		// Restart on game over or victory
		// 结束或胜利后 R/空格重开；胜利时进入下一关，失败时回到第 1 关。
		if (!released && (this.state.gameOver || this.state.victory)) {
			if (data === "r" || data === "R" || data === " ") {
				const highScore = this.state.highScore;
				const nextLevel = this.state.victory ? this.state.level + 1 : 1;
				this.state = createInitialState(highScore, nextLevel);
				// 重置按住状态，避免旧按键导致新一局自动移动/射击。
				this.keys = { left: false, right: false, fire: false };
				this.onSave(null);
				this.version++;
				this.tui.requestRender();
			}
		}
	}

	// 清空宽度缓存；下一次 render 重新计算布局。
	invalidate(): void {
		this.cachedWidth = 0;
	}

	// 渲染整帧：边框、状态头、60×24 网格与底部提示。
	render(width: number): string[] {
		// 宽度或版本变化才重建；游戏每 tick 都递增 version。
		if (width === this.cachedWidth && this.cachedVersion === this.version) {
			return this.cachedLines;
		}

		const lines: string[] = [];

		// Colors
		// 局部 ANSI 着色函数；白色用 97 提高对比度。
		const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
		const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
		const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
		const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
		const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
		const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
		const white = (s: string) => `\x1b[97m${s}\x1b[0m`;
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

		// 网格固定 60 列；终端更窄时由 padLine 截断/补空格，不做缩放。
		const boxWidth = GAME_WIDTH;

		// 给一行内容补到盒子宽度，并加左右边框。
		const boxLine = (content: string) => {
			const contentLen = visibleWidth(content);
			const padding = Math.max(0, boxWidth - contentLen);
			return dim(" │") + content + " ".repeat(padding) + dim("│");
		};

		// Top border
		lines.push(this.padLine(dim(` ╭${"─".repeat(boxWidth)}╮`), width));

		// Header
		// 生命值用红心重复表示；剩余 0 时显示空串。
		const title = `${bold(green("SPACE INVADERS"))}`;
		const scoreText = `Score: ${bold(yellow(String(this.state.score)))}`;
		const highText = `Hi: ${bold(yellow(String(this.state.highScore)))}`;
		const levelText = `Lv: ${bold(cyan(String(this.state.level)))}`;
		const livesText = `${red("♥".repeat(this.state.player.lives))}`;
		const header = `${title} │ ${scoreText} │ ${highText} │ ${levelText} │ ${livesText}`;
		lines.push(this.padLine(boxLine(header), width));

		// Separator
		lines.push(this.padLine(dim(` ├${"─".repeat(boxWidth)}┤`), width));

		// Game grid
		// 每个格子独立决定显示什么；colored 防止低优先级对象覆盖高优先级。
		for (let y = 0; y < GAME_HEIGHT; y++) {
			let row = "";
			for (let x = 0; x < GAME_WIDTH; x++) {
				let char = " ";
				let colored = false;

				// Check aliens
				// 外星人占 3 列：中间用主精灵，左右用方向性字符拼出形状。
				for (const alien of this.state.aliens) {
					if (alien.alive && alien.y === y && Math.abs(alien.x - x) <= 1) {
						// 每个 type 一组三个字符，按 x 相对位置选择。
						const sprites = [
							x === alien.x ? "▼" : "╲╱"[x < alien.x ? 0 : 1],
							x === alien.x ? "◆" : "╱╲"[x < alien.x ? 0 : 1],
							x === alien.x ? "☆" : "◄►"[x < alien.x ? 0 : 1],
						];
						const colors = [green, cyan, magenta];
						// 函数数组按 type 取色；type 来自游戏状态，正常为 0/1/2。
						char = colors[alien.type](sprites[alien.type]);
						colored = true;
						break;
					}
				}

				// Check shields
				// 掩体区相对坐标 4×3；只画仍为 true 的段。
				if (!colored) {
					for (const shield of this.state.shields) {
						const relX = x - shield.x;
						const relY = y - (PLAYER_Y - 5);
						if (relX >= 0 && relX < 4 && relY >= 0 && relY < 3) {
							if (shield.segments[relY][relX]) {
								char = dim("█");
								colored = true;
							}
							break;
						}
					}
				}

				// Check player
				// 玩家占三列：中间 ▲，两侧 ═。
				if (!colored && y === PLAYER_Y && Math.abs(x - this.state.player.x) <= 1) {
					if (x === this.state.player.x) {
						char = white("▲");
					} else {
						char = white("═");
					}
					colored = true;
				}

				// Check bullets
				// 子弹最后绘制，会覆盖同格的其他对象；玩家黄色、外星人红色。
				if (!colored) {
					for (const bullet of this.state.bullets) {
						if (bullet.x === x && bullet.y === y) {
							char = bullet.direction === -1 ? yellow("│") : red("│");
							colored = true;
							break;
						}
					}
				}

				// 未命中的空格保持单个空格；注意网格并非每格 2 字符宽。
				row += colored ? char : " ";
			}
			lines.push(this.padLine(dim(" │") + row + dim("│"), width));
		}

		// Separator
		lines.push(this.padLine(dim(` ├${"─".repeat(boxWidth)}┤`), width));

		// Footer
		// 四种状态对应不同提示：暂停、失败、胜利、进行中。
		let footer: string;
		if (this.paused) {
			footer = `${yellow(bold("PAUSED"))} Press any key to continue, ${bold("Q")} to quit`;
		} else if (this.state.gameOver) {
			footer = `${red(bold("GAME OVER!"))} Press ${bold("R")} to restart, ${bold("Q")} to quit`;
		} else if (this.state.victory) {
			footer = `${green(bold("VICTORY!"))} Press ${bold("R")} for level ${this.state.level + 1}, ${bold("Q")} to quit`;
		} else {
			footer = `←→ or AD to move, ${bold("SPACE")}/F to fire, ${bold("ESC")} pause, ${bold("Q")} quit`;
		}
		lines.push(this.padLine(boxLine(footer), width));

		// Bottom border
		lines.push(this.padLine(dim(` ╰${"─".repeat(boxWidth)}╯`), width));

		// 更新缓存；与 snake 不同，这里没有动态宽度，但仍按 width 缓存。
		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedVersion = this.version;

		return lines;
	}

	// 按终端宽度补齐；ANSI 用正则剥离后再计长度。
	private padLine(line: string, width: number): string {
		const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, "").length;
		const padding = Math.max(0, width - visibleLen);
		return line + " ".repeat(padding);
	}

	// 清理定时器；关闭/暂停/退出路径都会调用。
	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}
}

// 存档条目类型；与 snake 的保存机制相同。
const INVADERS_SAVE_TYPE = "space-invaders-save";

// 扩展入口：注册 /invaders 命令。
export default function (pi: ExtensionAPI) {
	pi.registerCommand("invaders", {
		description: "Play Space Invaders!",

		handler: async (_args, ctx) => {
			// 全屏游戏仅 TUI 可用。
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Space Invaders requires interactive mode", "error");
				return;
			}

			// Load saved state from session
			// 从最新条目往前找最后一条存档；data 为 null 表示没有进行中的游戏。
			const entries = ctx.sessionManager.getEntries();
			let savedState: GameState | undefined;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type === "custom" && entry.customType === INVADERS_SAVE_TYPE) {
					savedState = entry.data as GameState;
					break;
				}
			}

			// 打开组件并等待关闭；保存回调写入会话条目。
			await ctx.ui.custom((tui, _theme, _kb, done) => {
				return new SpaceInvadersComponent(
					tui,
					() => done(undefined),
					(state) => {
						pi.appendEntry(INVADERS_SAVE_TYPE, state);
					},
					savedState,
				);
			});
		},
	});
}
