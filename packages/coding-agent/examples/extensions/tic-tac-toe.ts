/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是“人机井字棋”，
 * 同时演示工具定义上的 executionMode: "sequential"。
 * 上游：用户在 TUI 输入 /tic-tac-toe 开始；每走一步后 pi.sendMessage 触发模型回合；模型调用
 * tic_tac_toe 工具（一次一个动作）与 tic_tac_toe_see_board 工具查询棋盘。
 * 下游：ctx.ui.custom() 挂载 TicTacToeComponent；pi.appendEntry("tic-tac-toe-save", ...)
 * 持久化；pi.sendMessage/registerMessageRenderer 渲染走子与终局横幅；
 * before_agent_start 每轮注入游戏规则；ctx.sessionManager.getBranch() 恢复棋盘。
 *
 * 演示的机制：代理要走到目标格，必须在同一条助手响应里先发多个 move_* 再发 play。默认的
 * parallel 执行会让 play 可能与 move_* 并发完成，导致 O 落错格；executionMode: "sequential"
 * 让同一响应的兄弟工具调用串行执行。用户光标只存在于 TUI，绝不出现在工具结果里；代理光标
 * 在成功 play 后回到 (0,0)，失败时保留位置以便重试。
 *
 * 能力清单：
 * - TicTacToeError：非法动作从 execute 抛出，宿主转为 isError 的工具错误。
 * - Cell/GameStatus/GameState/BoardDetails：棋盘、状态与持久化结构。
 * - getWinLine/checkWin：八条连线检测与胜负/平局判定。
 * - boardToAscii：给模型看的坐标棋盘，标记代理光标。
 * - renderBoard/renderVisualBoard/renderBoardSnapshot：ANSI 棋盘、光标与胜利高亮。
 * - TicTacToeComponent/BannerMessageComponent/GameOverMessageComponent：TUI 与消息渲染组件。
 * - reconstructState/getBoardDetails：从分支工具结果恢复与导出状态。
 * - 默认导出：注册命令、两个工具、消息渲染器、before_agent_start 与会话事件。
 *
 * 典型运行顺序：/tic-tac-toe -> 用户方向键移动、Enter 落 X -> 消息触发模型 -> 模型串行
 * move_*+play 落 O -> 直到 win/draw 显示终局横幅 -> R 重开或 Q 退出。
 *
 * 示例（真实签名）：
 *   pi.registerTool({ name: "tic_tac_toe", parameters: Type.Object({ action: StringEnum([...]) }),
 *     executionMode: "sequential", async execute(_id, params, _signal, _onUpdate, _ctx) { ... } });
 *   // 工具一次只接受一个 action；串行模式保证同一响应内的调用按顺序完成。
 *
 * 建议阅读顺序：先看类型与 checkWin/boardToAscii，再看 renderBoard 的 ANSI 拼接，然后看
 * TicTacToeComponent 的输入与命令处理器，最后看两个工具与 before_agent_start 的提示词。
 *
 * 前置条件：仅 TUI 模式可玩；需要模型配合调用工具，会产生模型费用。用户光标与代理光标
 * 分离，恢复状态时只信任工具结果中的 BoardDetails。
 */

/**
 * Tic-Tac-Toe extension - demonstrates executionMode: "sequential" on tools.
 *
 * The user plays via /tic-tac-toe (arrow keys + Enter).
 * The agent plays via a single tool `tic_tac_toe` that takes ONE atomic action
 * per call. To play at (r, c) from its cursor (r0, c0) the agent must emit the
 * required move_* and a final `play` as SEPARATE tool_use blocks inside ONE
 * assistant response.
 *
 * Move actions share the agent cursor and have a 300ms delay. Under the
 * default parallel tool-execution mode this races: `play` can resolve before
 * the earlier `move_*` calls finish and O lands on the wrong cell. With
 * `executionMode: "sequential"` the runner serializes the sibling calls and O
 * lands on the intended cell.
 *
 * The user cursor (TUI-only) and the agent cursor (tool-only) are stored in
 * separate variables. Only the agent cursor is ever exposed to the agent.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme, ToolExecutionMode } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Thrown from the tool on illegal actions. The agent runtime surfaces thrown
// errors as tool errors (isError=true) without resetting any of our state.
// 自定义错误类便于宿主/日志区分业务错误；name 会出现在错误展示中。
class TicTacToeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TicTacToeError";
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// 空格用单个空格表示，便于直接比较和渲染。
type Cell = " " | "X" | "O";
// 结束状态区分谁赢，避免再读棋盘推断。
type GameStatus = "playing" | "win_X" | "win_O" | "draw";

// 完整游戏状态；用户光标与代理光标分开存储。
interface GameState {
	board: Cell[][];
	// User cursor (TUI-only, never exposed to the agent).
	userCursorRow: number;
	userCursorCol: number;
	// Agent cursor (manipulated by the tool, shown in the TUI during O's turn).
	agentCursorRow: number;
	agentCursorCol: number;
	status: GameStatus;
	userMark: Cell;
	agentMark: Cell;
	currentTurn: Cell;
}

// Persisted with each toolResult for state reconstruction AND sent to the
// agent as `details`. Only the agent cursor is included: the user cursor is
// private to the TUI.
// 这是唯一的恢复来源：分支里最后一个该结构的工具结果即当前状态。
interface BoardDetails {
	board: Cell[][];
	agentCursorRow: number;
	agentCursorCol: number;
	status: GameStatus;
	currentTurn: Cell;
}

// ---------------------------------------------------------------------------
// Game logic
// ---------------------------------------------------------------------------

// Agent cursor home: where the cursor is reset to after a SUCCESSFUL play.
// Pinned at (0,0) so every non-origin play requires at least one move, which
// guarantees multiple tool calls per turn and makes the parallel-vs-sequential
// behavior observable in the demo. The cursor is NOT reset when the user plays
// nor on a failed `play` (cell taken), so the agent can retry without
// starting over.
// 代理光标的复位点；只有成功 play 后才回到这里。
const AGENT_CURSOR_HOME_ROW = 0;
const AGENT_CURSOR_HOME_COL = 0;

// 新对局：空棋盘、用户光标在中心、用户执 X 先手。
function createInitialState(): GameState {
	return {
		// 3×3 字面量；每个字符串都是 Cell 联合的成员。
		board: [
			[" ", " ", " "],
			[" ", " ", " "],
			[" ", " ", " "],
		],
		userCursorRow: 1,
		userCursorCol: 1,
		agentCursorRow: AGENT_CURSOR_HOME_ROW,
		agentCursorCol: AGENT_CURSOR_HOME_COL,
		status: "playing",
		userMark: "X",
		agentMark: "O",
		currentTurn: "X",
	};
}

// 返回构成胜利的三个坐标；没有胜利时返回 null。
// 八条线：三行、三列、两条对角线。
function getWinLine(board: Cell[][]): [number, number][] | null {
	const lines: [number, number][][] = [
		[
			[0, 0],
			[0, 1],
			[0, 2],
		],
		[
			[1, 0],
			[1, 1],
			[1, 2],
		],
		[
			[2, 0],
			[2, 1],
			[2, 2],
		],
		[
			[0, 0],
			[1, 0],
			[2, 0],
		],
		[
			[0, 1],
			[1, 1],
			[2, 1],
		],
		[
			[0, 2],
			[1, 2],
			[2, 2],
		],
		[
			[0, 0],
			[1, 1],
			[2, 2],
		],
		[
			[0, 2],
			[1, 1],
			[2, 0],
		],
	];
	for (const line of lines) {
		// 取出三个格子的值；只有非空且三个相等才算赢。
		const vals = line.map(([r, c]) => board[r][c]);
		if (vals[0] !== " " && vals[0] === vals[1] && vals[1] === vals[2]) {
			return line;
		}
	}
	return null;
}

// 先判胜，再判平局（棋盘已满且无胜者），否则继续。
function checkWin(board: Cell[][]): GameStatus {
	const winLine = getWinLine(board);
	if (winLine) {
		const [r, c] = winLine[0];
		// 胜利线首格的标记决定赢家。
		return board[r][c] === "X" ? "win_X" : "win_O";
	}
	if (board.every((row) => row.every((c) => c !== " "))) {
		return "draw";
	}
	return "playing";
}

// 生成给模型看的纯文本棋盘：空格显示坐标，代理光标用尖括号标出。
function boardToAscii(board: Cell[][], agentCursorRow: number, agentCursorCol: number): string {
	// Plain grid with coordinates for empty cells, marking the agent cursor
	// position with angle brackets. The user cursor is NEVER included: it is a
	// TUI-only concept and must not leak to the agent.
	const rows = board.map((row, r) =>
		row
			.map((c, cIdx) => {
				// 光标只影响显示，不改变棋盘值。
				const onCursor = r === agentCursorRow && cIdx === agentCursorCol;
				if (c === " ") return onCursor ? `<[${r},${cIdx}]>` : ` [${r},${cIdx}] `;
				// 已落子格：光标格用 <X>，其他用居中空格。
				return onCursor ? `   <${c}>   ` : `    ${c}    `;
			})
			.join("|"),
	);
	// 固定宽度的行分隔线，保持 ASCII 表格对齐。
	const separator = "---------+---------+---------";
	return rows.join(`\n${separator}\n`);
}

// ---------------------------------------------------------------------------
// Visual board rendering (ANSI).
// - Cells have NO background fill. Only the centered glyph is drawn.
// - Played cells color their glyph AND their surrounding borders in the
//   player's color, so each mark reads as a colored boxed region.
// - Cursor is indicated with colored borders around the cursor cell.
// ---------------------------------------------------------------------------

// \u6bcf\u4e2a\u683c\u5b50\u7684\u5b57\u7b26\u5bbd\u5ea6\u4e0e\u884c\u6570\uff1b\u68cb\u76d8 3\u00d73 \u52a0\u4e0a\u8fb9\u6846\u7ea6\u5360 25 \u5217\u3002
const CELL_WIDTH = 7;
const CELL_HEIGHT = 3;

// Player colors (SGR fg codes). Also used for the borders of played cells.
const FG_CODE_X = "34"; // blue
const FG_CODE_O = "33"; // yellow
const FG_CODE_WIN = "32"; // green (overrides on the winning line)

// Single-character glyphs, picked for maximum visual size without emoji.
// - \u2573 (BOX DRAWINGS LIGHT DIAGONAL CROSS) for X
// - \u25ef (LARGE CIRCLE) for O
const GLYPH_X = "\u2573";
const GLYPH_O = "\u25ef";

// \u6697\u8272\u7528\u4e8e\u672a\u843d\u5b50/\u65e0\u9ad8\u4eae\u7684\u8fb9\u6846\uff1bRESET \u5173\u95ed\u6240\u6709 SGR \u5c5e\u6027\u3002
const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`;
const RESET = "\x1b[0m";

// \u6309\u53ef\u89c1\u5bbd\u5ea6\u5c45\u4e2d\uff1b\u8d85\u5bbd\u65f6\u622a\u65ad\u800c\u4e0d\u662f\u6362\u884c\u3002
function centerPad(content: string, width: number): string {
	const contentLen = visibleWidth(content);
	if (contentLen >= width) return truncateToWidth(content, width);
	const pad = width - contentLen;
	// \u5de6\u5c11\u53f3\u591a\uff0c\u4fdd\u8bc1\u603b\u5bbd\u5ea6\u7cbe\u786e\u3002
	const left = Math.floor(pad / 2);
	return " ".repeat(left) + content + " ".repeat(pad - left);
}

// Fg color for a played cell's glyph and its surrounding borders. Undefined
// for empty cells.
// \u80dc\u5229\u683c\u7edf\u4e00\u7eff\u8272\uff0c\u5176\u4f59\u6309 X/O \u7740\u8272\u3002
function cellFgCode(cell: Cell, isWin: boolean): string | undefined {
	if (cell === " ") return undefined;
	if (isWin) return FG_CODE_WIN;
	return cell === "X" ? FG_CODE_X : FG_CODE_O;
}

// \u751f\u6210\u5355\u5143\u683c\u7684\u4e00\u884c\uff1a\u53ea\u6709\u4e2d\u95f4\u884c\u7ed8\u5236\u5b57\u5f62\uff0c\u5176\u4f59\u884c\u7559\u767d\u3002
function buildCellContent(mark: Cell, lineIdx: number, isWin: boolean): string {
	const empty = " ".repeat(CELL_WIDTH);
	if (mark === " ") return empty;

	// CELL_HEIGHT \u4e3a 3\uff0c\u4e2d\u95f4\u884c\u4e0b\u6807\u4e3a 1\u3002
	const isMidLine = lineIdx === Math.floor(CELL_HEIGHT / 2);
	if (!isMidLine) return empty;

	const glyph = mark === "X" ? GLYPH_X : GLYPH_O;
	// \u5df2\u843d\u5b50\u683c\u5fc5\u7136\u6709\u989c\u8272\uff1b\u65ad\u8a00\u628a undefined \u6392\u9664\uff0c\u4f9b\u6a21\u677f\u5b57\u7b26\u4e32\u62fc\u63a5\u3002
	const fg = cellFgCode(mark, isWin) as string;
	const padLen = CELL_WIDTH - visibleWidth(glyph);
	const leftPad = Math.floor(padLen / 2);
	const rightPad = padLen - leftPad;
	// ;1m \u540c\u65f6\u542f\u7528\u7c97\u4f53\uff0c\u8ba9\u5b57\u5f62\u66f4\u9192\u76ee\u3002
	return `${" ".repeat(leftPad)}\x1b[${fg};1m${glyph}${RESET}${" ".repeat(rightPad)}`;
}

// Fg color for a border char based on its adjacent cells. Undefined when no
// adjacent cell is played or when adjacent plays disagree (border stays dim
// to show the separation).
// filter \u7684\u7c7b\u578b\u8c13\u8bcd\u628a undefined \u53bb\u6389\uff0c\u5269\u4f59\u6570\u7ec4\u5143\u7d20\u90fd\u662f string\u3002
function borderFgCode(adjacent: ReadonlyArray<{ cell: Cell; isWin: boolean }>): string | undefined {
	const fgs = adjacent.map((a) => cellFgCode(a.cell, a.isWin)).filter((f): f is string => !!f);
	if (fgs.length === 0) return undefined;
	const first = fgs[0];
	// \u53ea\u6709\u6240\u6709\u76f8\u90bb\u683c\u540c\u8272\u65f6\u624d\u7740\u8272\uff1b\u5426\u5219\u4fdd\u6301\u6697\u8272\u8868\u793a\u5206\u9694\u3002
	return fgs.every((f) => f === first) ? first : undefined;
}

// \u6e32\u67d3\u9009\u9879\uff1bcursor \u7701\u7565\u65f6\u8f93\u51fa\u9759\u6001\u5feb\u7167\u3002
interface BoardRenderOpts {
	board: Cell[][];
	maxWidth: number;
	// Optional cursor overlay. Omit to render a static snapshot (used in tool
	// results, move messages, and the game-over banner).
	cursor?: { row: number; col: number; owner: "user" | "agent" };
}

// \u6e32\u67d3\u5e26\u8fb9\u6846\u7684 3\u00d73 \u68cb\u76d8\uff1b\u8fd9\u662f\u7eaf\u51fd\u6570\uff0c\u4e0d\u8bfb\u5168\u5c40\u72b6\u6001\u3002
function renderBoard(opts: BoardRenderOpts): string[] {
	const { board, maxWidth, cursor } = opts;
	const showCursor = !!cursor;
	// \u65e0\u5149\u6807\u65f6\u7528 -1\uff0c\u6240\u6709 isCursor* \u5224\u65ad\u81ea\u7136\u4e3a false\u3002
	const cr = cursor?.row ?? -1;
	const cc = cursor?.col ?? -1;

	// Green for user cursor, yellow for agent cursor.
	const cursorSgr = cursor?.owner === "agent" ? "\x1b[33;1m" : "\x1b[32;1m";

	// \u9884\u5148\u7b97\u51fa\u80dc\u5229\u683c\u96c6\u5408\uff0c\u540e\u7eed\u6309 "\u884c,\u5217" \u5b57\u7b26\u4e32\u67e5\u8be2\u3002
	const winLine = getWinLine(board);
	const winCells = new Set((winLine ?? []).map(([r, c]) => `${r},${c}`));
	const cellAt = (r: number, c: number) => ({ cell: board[r][c], isWin: winCells.has(`${r},${c}`) });

	// \u5149\u6807\u8986\u76d6\u683c\u5b50\u7684\u56db\u6761\u8fb9\uff1a\u76f8\u90bb\u7684\u4e24\u4e2a\u89d2\u3001\u6c34\u5e73\u6bb5\u3001\u5782\u76f4\u6bb5\u3002
	const isCursorCorner = (gridR: number, gridC: number): boolean =>
		showCursor && (gridR === cr || gridR === cr + 1) && (gridC === cc || gridC === cc + 1);
	const isCursorHSegment = (gridR: number, c: number): boolean =>
		showCursor && c === cc && (gridR === cr || gridR === cr + 1);
	const isCursorVBorder = (r: number, gridC: number): boolean =>
		showCursor && r === cr && (gridC === cc || gridC === cc + 1);

	// \u4f18\u5148\u7ea7\uff1a\u5149\u6807\u9ad8\u4eae > \u68cb\u5b50\u989c\u8272 > \u6697\u8272\u3002
	const paintBorder = (ch: string, highlighted: boolean, fgCode: string | undefined): string => {
		if (highlighted) return `${cursorSgr}${ch}${RESET}`;
		if (fgCode) return `\x1b[${fgCode};1m${ch}${RESET}`;
		return DIM(ch);
	};

	// \u6839\u636e\u7f51\u683c\u5750\u6807\u9009\u62e9 Unicode \u5236\u8868\u7b26\uff1bgridR/gridC \u8303\u56f4 0..3\u3002
	const cornerChar = (gridR: number, gridC: number): string => {
		if (gridR === 0 && gridC === 0) return "\u250c";
		if (gridR === 0 && gridC === 3) return "\u2510";
		if (gridR === 3 && gridC === 0) return "\u2514";
		if (gridR === 3 && gridC === 3) return "\u2518";
		if (gridR === 0) return "\u252c";
		if (gridR === 3) return "\u2534";
		if (gridC === 0) return "\u251c";
		if (gridC === 3) return "\u2524";
		return "\u253c";
	};

	// \u89d2\u70b9\u5468\u56f4\u6700\u591a\u56db\u4e2a\u683c\u5b50\uff1b\u8d8a\u754c\u7684\u5750\u6807\u88ab\u8df3\u8fc7\u3002
	const cornerAdjacent = (gridR: number, gridC: number) => {
		const out: { cell: Cell; isWin: boolean }[] = [];
		for (const [dr, dc] of [
			[-1, -1],
			[-1, 0],
			[0, -1],
			[0, 0],
		]) {
			const r = gridR + dr;
			const c = gridC + dc;
			if (r >= 0 && r < 3 && c >= 0 && c < 3) out.push(cellAt(r, c));
		}
		return out;
	};

	const lines: string[] = [];

	// 4 \u6761\u6c34\u5e73\u8fb9\u6846 + \u6bcf\u6761\u8fb9\u6846\u4e0b\u65b9\u7684 3 \u884c\u5355\u5143\u683c\u5185\u5bb9\u3002
	for (let gridR = 0; gridR <= 3; gridR++) {
		// Horizontal border row.
		let row = "";
		for (let gridC = 0; gridC <= 3; gridC++) {
			const cornerColor = borderFgCode(cornerAdjacent(gridR, gridC));
			row += paintBorder(cornerChar(gridR, gridC), isCursorCorner(gridR, gridC), cornerColor);
			if (gridC < 3) {
				// \u6c34\u5e73\u7ebf\u6bb5\u4e0a\u4e0b\u5404\u6709\u4e00\u4e2a\u683c\u5b50\uff08\u8fb9\u754c\u5904\u53ea\u6709\u4e00\u4e2a\uff09\u3002
				const adj: { cell: Cell; isWin: boolean }[] = [];
				if (gridR > 0) adj.push(cellAt(gridR - 1, gridC));
				if (gridR < 3) adj.push(cellAt(gridR, gridC));
				const segColor = borderFgCode(adj);
				row += paintBorder("\u2500".repeat(CELL_WIDTH), isCursorHSegment(gridR, gridC), segColor);
			}
		}
		lines.push(centerPad(row, maxWidth));

		// \u6700\u540e\u4e00\u6761\u8fb9\u6846\u4e4b\u540e\u4e0d\u518d\u8f93\u51fa\u5185\u5bb9\u884c\u3002
		if (gridR === 3) break;

		for (let lineIdx = 0; lineIdx < CELL_HEIGHT; lineIdx++) {
			let contentRow = "";
			for (let gridC = 0; gridC <= 3; gridC++) {
				// \u5782\u76f4\u7ebf\u6bb5\u5de6\u53f3\u5404\u6709\u4e00\u4e2a\u683c\u5b50\u3002
				const adj: { cell: Cell; isWin: boolean }[] = [];
				if (gridC > 0) adj.push(cellAt(gridR, gridC - 1));
				if (gridC < 3) adj.push(cellAt(gridR, gridC));
				const vColor = borderFgCode(adj);
				contentRow += paintBorder("\u2502", isCursorVBorder(gridR, gridC), vColor);
				if (gridC < 3) {
					contentRow += buildCellContent(board[gridR][gridC], lineIdx, winCells.has(`${gridR},${gridC}`));
				}
			}
			lines.push(centerPad(contentRow, maxWidth));
		}
	}

	return lines;
}

// Full TUI board with the right cursor overlayed for the current turn.
// \u7528\u6237\u56de\u5408\u663e\u793a\u7528\u6237\u5149\u6807\uff0c\u4ee3\u7406\u56de\u5408\u663e\u793a\u4ee3\u7406\u5149\u6807\uff1b\u7ec8\u5c40\u4e0d\u663e\u793a\u5149\u6807\u3002
function renderVisualBoard(state: GameState, maxWidth: number): string[] {
	const isUserTurn = state.currentTurn === state.userMark;
	const cursor =
		state.status !== "playing"
			? undefined
			: {
					row: isUserTurn ? state.userCursorRow : state.agentCursorRow,
					col: isUserTurn ? state.userCursorCol : state.agentCursorCol,
					owner: (isUserTurn ? "user" : "agent") as "user" | "agent",
				};
	return renderBoard({ board: state.board, maxWidth, cursor });
}

/** Static snapshot used inside tool results and custom messages. */
// \u5feb\u7167\u4e0d\u5305\u542b\u4efb\u4f55\u5149\u6807\uff0c\u907f\u514d\u628a\u79c1\u6709\u72b6\u6001\u53d1\u7ed9\u6a21\u578b\u6216\u5176\u4ed6\u4eba\u3002
function renderBoardSnapshot(board: Cell[][], maxWidth: number): string[] {
	return renderBoard({ board, maxWidth });
}

// ---------------------------------------------------------------------------
// TUI component
// ---------------------------------------------------------------------------

// TUI \u68cb\u76d8\u7ec4\u4ef6\uff1a\u7528\u6237\u7528\u65b9\u5411\u952e\u79fb\u52a8\u81ea\u5df1\u7684\u5149\u6807\uff0cEnter \u843d\u5b50\uff1b\u4ee3\u7406\u56de\u5408\u53ea\u8bfb\u3002
class TicTacToeComponent implements Component {
	// \u6307\u5411\u6269\u5c55\u95ed\u5305\u4e2d\u7684\u540c\u4e00\u4e2a gameState \u5bf9\u8c61\uff1b\u547d\u4ee4\u4fa7\u66f4\u65b0\u540e\u7ec4\u4ef6\u80fd\u7acb\u5373\u770b\u5230\u3002
	private state: GameState;
	private onClose: () => void;
	private onUserPlay: (row: number, col: number) => void;
	private tui: { requestRender: () => void };
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private version = 0;
	private cachedVersion = -1;

	constructor(
		tui: { requestRender: () => void },
		onClose: () => void,
		onUserPlay: (row: number, col: number) => void,
		state: GameState,
	) {
		this.tui = tui;
		this.onClose = onClose;
		this.onUserPlay = onUserPlay;
		this.state = state;
	}

	// \u4ee3\u7406\u843d\u5b50\u540e\u7531\u547d\u4ee4\u4fa7\u8c03\u7528\uff1b\u9012\u589e version \u4f7f\u6e32\u67d3\u7f13\u5b58\u5931\u6548\u3002
	updateState(state: GameState): void {
		this.state = state;
		this.version++;
		this.tui.requestRender();
	}

	// \u8fd4\u56de true \u8868\u793a\u4e8b\u4ef6\u5df2\u5904\u7406\uff1b\u7ec4\u4ef6\u5728\u7528\u6237\u56de\u5408\u5916\u541e\u6389\u6240\u6709\u6309\u952e\u3002
	handleInput(data: string): boolean {
		// Esc/Q \u4efb\u4f55\u65f6\u5019\u90fd\u53ef\u9000\u51fa\u3002
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.onClose();
			return true;
		}
		// \u7ec8\u5c40\u540e\u53ea\u54cd\u5e94 R\uff08\u547d\u4ee4\u4fa7\u4f1a\u91cd\u5f00\uff09\uff1b\u5176\u4ed6\u952e\u5ffd\u7565\u4f46\u4ecd\u6807\u8bb0\u5df2\u5904\u7406\u3002
		if (this.state.status !== "playing") {
			if (data === "r" || data === "R") {
				this.onClose();
				return true;
			}
			return true;
		}
		// \u4ee3\u7406\u56de\u5408\u4e0d\u5141\u8bb8\u7528\u6237\u79fb\u52a8\u5149\u6807\u6216\u843d\u5b50\u3002
		if (this.state.currentTurn !== this.state.userMark) return true;

		// \u5149\u6807\u5728 0..2 \u5185\u79fb\u52a8\uff1b\u5230\u8fb9\u754c\u540e\u518d\u6309\u540c\u4e00\u65b9\u5411\u4e0d\u751f\u6548\u3002
		if (matchesKey(data, "up") && this.state.userCursorRow > 0) {
			this.state.userCursorRow--;
			this.version++;
			this.tui.requestRender();
		} else if (matchesKey(data, "down") && this.state.userCursorRow < 2) {
			this.state.userCursorRow++;
			this.version++;
			this.tui.requestRender();
		} else if (matchesKey(data, "left") && this.state.userCursorCol > 0) {
			this.state.userCursorCol--;
			this.version++;
			this.tui.requestRender();
		} else if (matchesKey(data, "right") && this.state.userCursorCol < 2) {
			this.state.userCursorCol++;
			this.version++;
			this.tui.requestRender();
		} else if (matchesKey(data, "return") || data === " ") {
			// \u53ea\u6709\u7a7a\u683c\u5b50\u53ef\u4ee5\u843d\u5b50\uff1b\u5df2\u6709\u6807\u8bb0\u7684\u683c\u5b50\u6309\u4e0b\u65e0\u6548\u3002
			const { userCursorRow, userCursorCol } = this.state;
			if (this.state.board[userCursorRow][userCursorCol] === " ") {
				this.onUserPlay(userCursorRow, userCursorCol);
			}
		}
		// \u65b9\u5411\u952e/\u56de\u8f66\u5904\u7406\u5b8c\u540e\u4ecd\u8fd4\u56de true\uff0c\u907f\u514d\u4e8b\u4ef6\u7ee7\u7eed\u5192\u6ce1\u5230\u7f16\u8f91\u5668\u3002
		return true;
	}

	// \u5bbd\u5ea6\u53d8\u5316\uff08\u6216\u9996\u6b21\u6e32\u67d3\uff09\u65f6\u6e05\u7a7a\u7f13\u5b58\u3002
	invalidate(): void {
		this.cachedWidth = 0;
	}

	// \u6e32\u67d3\u6807\u9898\u3001\u72b6\u6001\u884c\u3001\u68cb\u76d8\u3001\u5e95\u90e8\u63d0\u793a\u4e0e\u5206\u9694\u7ebf\u3002
	render(width: number): string[] {
		// \u72b6\u6001\u672a\u53d8\u4e14\u5bbd\u5ea6\u76f8\u540c\u65f6\u590d\u7528\u7f13\u5b58\uff1b\u7528\u6237\u79fb\u52a8\u5149\u6807\u4f1a\u9012\u589e version\u3002
		if (width === this.cachedWidth && this.cachedVersion === this.version) {
			return this.cachedLines;
		}

		// \u5c40\u90e8 ANSI \u6784\u9020\uff1b\u4e0e renderBoard \u7684\u7740\u8272\u65b9\u5f0f\u5206\u5f00\u7ef4\u62a4\u3002
		const ESC = "\x1b[";
		const reset = `${ESC}0m`;
		const bold = (s: string) => `${ESC}1m${s}${reset}`;
		const dim = (s: string) => `${ESC}2m${s}${reset}`;
		const blue = (s: string) => `${ESC}34m${s}${reset}`;
		const yellow = (s: string) => `${ESC}33m${s}${reset}`;
		const green = (s: string) => `${ESC}32m${s}${reset}`;

		const lines: string[] = [];

		// Top title banner, full width.
		// \u6807\u9898\u5c45\u4e2d\uff0c\u4e24\u4fa7\u7528\u6a2a\u7ebf\u586b\u6ee1\u5269\u4f59\u5bbd\u5ea6\u3002
		const titleText = " Tic-Tac-Toe ";
		const titleLen = visibleWidth(titleText);
		const borderLen = Math.max(0, width - titleLen);
		const leftBorder = Math.floor(borderLen / 2);
		const rightBorder = borderLen - leftBorder;
		lines.push(dim("\u2500".repeat(leftBorder)) + bold(blue(titleText)) + dim("\u2500".repeat(rightBorder)));

		lines.push("");

		// Status line.
		// \u7ec8\u5c40\u663e\u793a\u7ed3\u679c\uff1b\u8fdb\u884c\u4e2d\u9ad8\u4eae\u5f53\u524d\u56de\u5408\u7684\u4e00\u65b9\u3002
		if (this.state.status !== "playing") {
			const statusText =
				this.state.status === "draw"
					? bold(yellow("Draw!"))
					: this.state.status === "win_X"
						? bold(green("X wins!"))
						: bold(yellow("O wins!"));
			lines.push(centerPad(statusText, width));
		} else if (this.state.currentTurn === "X") {
			lines.push(centerPad(`Turn: ${bold(blue("X"))} (You)  ${dim("|")}  ${bold(yellow("O"))} (Agent)`, width));
		} else {
			lines.push(centerPad(`${blue("X")} (You)  ${dim("|")}  Turn: ${bold(yellow("O"))} (Agent)`, width));
		}

		lines.push("");
		lines.push("");

		// \u5c55\u5f00\u6e32\u67d3\u884c\u6570\u7ec4\uff1brenderVisualBoard \u8fd4\u56de\u591a\u884c\u3002
		lines.push(...renderVisualBoard(this.state, width));

		lines.push("");
		lines.push("");

		// Footer.
		// \u4e09\u79cd\u63d0\u793a\uff1a\u7ec8\u5c40\u3001\u4ee3\u7406\u601d\u8003\u4e2d\u3001\u7528\u6237\u64cd\u4f5c\u8bf4\u660e\u3002
		let footer: string;
		if (this.state.status !== "playing") {
			footer = `${bold("R")} restart  ${dim("|")}  ${bold("Q")}/${bold("ESC")} quit`;
		} else if (this.state.currentTurn !== this.state.userMark) {
			footer = dim("Agent is thinking...");
		} else {
			footer = `${bold("\u2190\u2191\u2193\u2192")} move  ${dim("|")}  ${bold("ENTER")} play  ${dim("|")}  ${bold("ESC")} quit`;
		}
		lines.push(centerPad(footer, width));

		// Bottom separator between the component and the editor below.
		lines.push("");
		lines.push(dim("\u2500".repeat(width)));

		// \u66f4\u65b0\u7f13\u5b58\u540e\u8fd4\u56de\u3002
		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedVersion = this.version;
		return lines;
	}
}

// ---------------------------------------------------------------------------
// Move-message renderer (full width banner)
// ---------------------------------------------------------------------------

// Full-width banner message with an optional board snapshot underneath.
// \u8d70\u5b50\u6d88\u606f\u6a2a\u5e45\uff1a\u6807\u9898\u884c + \u53ef\u9009\u68cb\u76d8\u5feb\u7167\uff1b\u5c55\u5f00\u65f6\u624d\u663e\u793a\u68cb\u76d8\u3002
class BannerMessageComponent implements Component {
	// \u53ea\u8bfb\u5b57\u6bb5\uff1b\u7ec4\u4ef6\u6e32\u67d3\u671f\u95f4\u4e0d\u4fee\u6539\u3002
	private readonly title: string;
	private readonly details: BoardDetails | undefined;
	private readonly expanded: boolean;
	private readonly theme: Theme;

	constructor(title: string, details: BoardDetails | undefined, expanded: boolean, theme: Theme) {
		this.title = title;
		this.details = details;
		this.expanded = expanded;
		this.theme = theme;
	}

	// \u6ca1\u6709\u7f13\u5b58\uff0c\u7a7a\u5b9e\u73b0\u5373\u53ef\u3002
	invalidate(): void {}

	render(width: number): string[] {
		const dim = (s: string) => this.theme.fg("dim", s);
		const lines: string[] = [];
		// \u6807\u9898\u4e24\u4fa7\u5404\u7559\u4e00\u4e2a\u7a7a\u683c\uff0c\u5269\u4f59\u5bbd\u5ea6\u5e73\u5206\u7ed9\u6a2a\u7ebf\u3002
		const titleLen = visibleWidth(this.title);
		const fillLen = Math.max(0, width - titleLen - 2);
		const leftFill = Math.floor(fillLen / 2);
		const rightFill = fillLen - leftFill;
		lines.push(`${dim("\u2500".repeat(leftFill))} ${this.title} ${dim("\u2500".repeat(rightFill))}`);

		// \u6298\u53e0\u65f6\u4e0d\u6e32\u67d3\u68cb\u76d8\uff0c\u51cf\u5c11\u6d88\u606f\u9ad8\u5ea6\u3002
		if (this.expanded && this.details) {
			lines.push("");
			lines.push(...renderBoardSnapshot(this.details.board, width));
		}

		return lines;
	}
}

// End-of-game banner: two dim hrs, a big colored title line, and the final
// board with the winning line highlighted.
// \u7ec8\u5c40\u6a2a\u5e45\uff1a\u4e0a\u4e0b\u6a2a\u7ebf\u3001\u7ed3\u679c\u6807\u9898\u4e0e\u526f\u6807\u9898\u3001\u5e26\u80dc\u5229\u9ad8\u4eae\u7684\u6700\u7ec8\u68cb\u76d8\u3002
class GameOverMessageComponent implements Component {
	private readonly status: GameStatus;
	private readonly details: BoardDetails | undefined;
	private readonly theme: Theme;

	constructor(status: GameStatus, details: BoardDetails | undefined, theme: Theme) {
		this.status = status;
		this.details = details;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const dim = (s: string) => this.theme.fg("dim", s);
		const bold = (s: string) => this.theme.bold(s);

		const hr = dim("\u2500".repeat(width));
		const lines: string[] = [];
		lines.push(hr);
		lines.push("");

		// \u6309\u7ed3\u675f\u72b6\u6001\u9009\u62e9\u6807\u9898\u4e0e\u526f\u6807\u9898\uff1bdefault \u5206\u652f\u7406\u8bba\u4e0a\u53ea\u5728\u672a\u77e5\u72b6\u6001\u51fa\u73b0\u3002
		let title: string;
		let sub: string;
		switch (this.status) {
			case "win_X":
				title = bold(this.theme.fg("accent", "\u2605 Player X wins \u2605"));
				sub = "You beat the agent.";
				break;
			case "win_O":
				title = bold(this.theme.fg("warning", "\u2605 Player O wins \u2605"));
				sub = "The agent beat you.";
				break;
			case "draw":
				title = bold(this.theme.fg("muted", "\u2014 Draw \u2014"));
				sub = "No winner.";
				break;
			default:
				title = bold("Game over");
				sub = "";
				break;
		}

		// \u6807\u9898\u4e0e\u526f\u6807\u9898\u5404\u81ea\u5c45\u4e2d\uff1b\u526f\u6807\u9898\u4e3a\u7a7a\u65f6\u4ecd\u8f93\u51fa\u4e00\u884c\u7a7a\u683c\u3002
		for (const line of [title, dim(sub)]) {
			const pad = Math.max(0, width - visibleWidth(line));
			lines.push(`${" ".repeat(Math.floor(pad / 2))}${line}`);
		}

		lines.push("");
		// details \u7531\u6d88\u606f\u6e32\u67d3\u5668\u4f20\u5165\uff1b\u7f3a\u5931\u65f6\u53ea\u663e\u793a\u6807\u9898\u3002
		if (this.details) {
			lines.push(...renderBoardSnapshot(this.details.board, width));
			lines.push("");
		}
		lines.push(hr);

		return lines;
	}
}

// ---------------------------------------------------------------------------
// Delay helper
// ---------------------------------------------------------------------------

// \u628a setTimeout \u5305\u88c5\u6210 Promise\uff0c\u4f9b\u5de5\u5177\u6a21\u62df\u68cb\u5b50\u79fb\u52a8\u8017\u65f6\u3002
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// \u81ea\u5b9a\u4e49\u6761\u76ee/\u6d88\u606f\u7c7b\u578b\uff1b\u540c\u4e00\u5b57\u7b26\u4e32\u5728\u4e0d\u540c API \u4e2d\u4f7f\u7528\u65f6\u542b\u4e49\u4e0d\u540c\u3002
const SAVE_TYPE = "tic-tac-toe-save";
const MOVE_MESSAGE_TYPE = "tic-tac-toe-move";
const GAME_OVER_MESSAGE_TYPE = "tic-tac-toe-game-over";

// \u6a21\u5757\u7ea7\u72b6\u6001\uff1a\u6269\u5c55\u751f\u547d\u5468\u671f\u5185\u53ea\u6709\u4e00\u5c40\uff1b\u6062\u590d\u65f6\u6574\u4f53\u91cd\u5efa\u3002
let gameState: GameState = createInitialState();
// \u5f53\u524d\u6253\u5f00\u7684 TUI \u7ec4\u4ef6\uff1b\u4e0d\u5728\u6e38\u620f\u4e2d\u65f6\u4e3a null\u3002
let component: TicTacToeComponent | null = null;
// \u662f\u5426\u5904\u4e8e\u5bf9\u5c40\u4e2d\uff1bbefore_agent_start \u7528\u5b83\u51b3\u5b9a\u662f\u5426\u6ce8\u5165\u89c4\u5219\u3002
let gameActive = false;

// \u4ece\u5f53\u524d\u5206\u652f\u91cd\u5efa\u68cb\u76d8\uff1a\u6309\u65f6\u95f4\u987a\u5e8f\u5e94\u7528\u6700\u540e\u4e00\u4e2a\u5de5\u5177\u7ed3\u679c\u4e2d\u7684 BoardDetails\u3002
function reconstructState(ctx: ExtensionContext): void {
	gameState = createInitialState();
	gameActive = false;

	// getBranch \u53ea\u5305\u542b\u5f53\u524d\u8def\u5f84\uff1b\u5207\u6362\u5206\u652f\u540e\u68cb\u76d8\u56de\u5230\u8be5\u5386\u53f2\u70b9\u3002
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		// \u53ea\u6709\u8fd9\u4e24\u4e2a\u5de5\u5177\u7684\u7ed3\u679c\u643a\u5e26\u53ef\u4fe1\u68cb\u76d8\u72b6\u6001\u3002
		if (msg.role !== "toolResult") continue;
		if (msg.toolName !== "tic_tac_toe" && msg.toolName !== "tic_tac_toe_see_board") continue;

		// details \u662f unknown\uff1b\u6bcf\u4e2a\u65b0\u7ed3\u679c\u90fd\u6574\u4f53\u8986\u76d6\u65e7\u72b6\u6001\u3002
		const details = msg.details as BoardDetails | undefined;
		if (details) {
			// \u590d\u5236\u6bcf\u4e00\u884c\uff0c\u907f\u514d\u628a\u6570\u7ec4\u5f15\u7528\u76f4\u63a5\u4ea4\u7ed9\u8fd0\u884c\u65f6\u72b6\u6001\u3002
			gameState.board = details.board.map((row) => [...row]);
			gameState.agentCursorRow = details.agentCursorRow;
			gameState.agentCursorCol = details.agentCursorCol;
			gameState.status = details.status;
			gameState.currentTurn = details.currentTurn;
		}
	}
}

// \u5bfc\u51fa\u53ef\u6301\u4e45\u5316\u7684\u5feb\u7167\uff1b\u7528\u6237\u5149\u6807\u4e0d\u5728\u5176\u4e2d\uff0c\u4fdd\u6301 TUI \u79c1\u6709\u3002
function getBoardDetails(): BoardDetails {
	return {
		board: gameState.board.map((row) => [...row]),
		agentCursorRow: gameState.agentCursorRow,
		agentCursorCol: gameState.agentCursorCol,
		status: gameState.status,
		currentTurn: gameState.currentTurn,
	};
}

// \u6269\u5c55\u5165\u53e3\uff1a\u6ce8\u518c\u4e8b\u4ef6\u3001\u6d88\u606f\u6e32\u67d3\u5668\u3001\u547d\u4ee4\u4e0e\u4e24\u4e2a\u5de5\u5177\u3002
export default function (pi: ExtensionAPI) {
	// \u4f1a\u8bdd\u542f\u52a8\u4e0e\u6811\u5bfc\u822a\u65f6\u90fd\u91cd\u5efa\uff0c\u4fdd\u8bc1\u68cb\u76d8\u4e0e\u5f53\u524d\u5206\u652f\u4e00\u81f4\u3002
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// Sent once per game at end-of-game. The custom renderer paints the banner;
	// `content` is a plain-text fallback for any non-TUI consumer and for the
	// LLM (in case the message ends up in future context).
	// display: true \u8ba9\u6d88\u606f\u8fdb\u5165 TUI\uff1bdetails \u4f9b renderer \u753b\u6700\u7ec8\u68cb\u76d8\u3002
	const emitGameOverMessage = (): void => {
		const label =
			gameState.status === "win_X"
				? "Player X (human) wins"
				: gameState.status === "win_O"
					? "Player O (agent) wins"
					: gameState.status === "draw"
						? "Draw"
						: "Game over";
		pi.sendMessage({
			customType: GAME_OVER_MESSAGE_TYPE,
			content: `Game over: ${label}.`,
			display: true,
			details: getBoardDetails(),
		});
	};

	// -----------------------------------------------------------------------
	// Custom message renderer for user move messages
	// -----------------------------------------------------------------------
	// second \u53c2\u6570\u542b expanded\uff1brenderer \u8fd4\u56de\u5b9e\u73b0 render \u7684\u7ec4\u4ef6\u5373\u53ef\u3002
	pi.registerMessageRenderer(MOVE_MESSAGE_TYPE, (message, { expanded }, theme) => {
		// \u6d88\u606f details \u662f unknown\uff1b\u6e32\u67d3\u5668\u53ea\u505a\u5c55\u793a\uff0c\u7f3a\u5931\u65f6\u7528\u9ed8\u8ba4\u6807\u7b7e\u3002
		const details = message.details as BoardDetails | undefined;
		const turnLabel =
			details?.currentTurn === "O"
				? `${theme.fg("warning", theme.bold("O"))} (Agent)`
				: `${theme.fg("accent", theme.bold("X"))} (You)`;
		const title = `${theme.fg("accent", theme.bold("Player X played"))}  ${theme.fg("dim", "\u2192")}  next: ${turnLabel}`;
		return new BannerMessageComponent(title, details, expanded, theme);
	});

	// -----------------------------------------------------------------------
	// Custom message renderer for game-over messages
	// -----------------------------------------------------------------------
	pi.registerMessageRenderer(GAME_OVER_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details as BoardDetails | undefined;
		// \u6ca1\u6709 details \u65f6\u6309 draw \u6e32\u67d3\uff0c\u907f\u514d\u51fa\u73b0\u7a7a\u767d\u7ec8\u5c40\u6a2a\u5e45\u3002
		const status = (details?.status ?? "draw") as GameStatus;
		return new GameOverMessageComponent(status, details, theme);
	});

	// -----------------------------------------------------------------------
	// before_agent_start - inject game instructions each turn
	// -----------------------------------------------------------------------
	// 对局中每轮把规则追加到系统提示；不在对局时不改动提示词。
	pi.on("before_agent_start", async (event) => {
		// undefined 表示不修改；宿主保留原提示。
		if (!gameActive) return undefined;

		// 模板字符串内是完整规则与示例，不对其中逐行加注释。
		const instructions = `

## Tic-Tac-Toe (you are Player O)

A tic-tac-toe game is in progress. The human is Player X. You are Player O.
The human plays through a TUI; you play through the \`tic_tac_toe\` tool.

### Turn protocol

When the human plays, you receive a message that contains the cell X marked,
the full board, and YOUR cursor position (Player O's cursor). The message is
the source of truth for the board.

Player O's cursor persists between O turns. It is reset to (row=${AGENT_CURSOR_HOME_ROW}, col=${AGENT_CURSOR_HOME_COL})
only after a successful \`play\`. If a \`play\` fails (cell already taken), the
cursor stays where it was, so you can move and retry.

You may also call \`tic_tac_toe_see_board\` if you want the current board and
your cursor position restated at any point. The user's cursor is private and
is never shown to you.

### The tool

\`tic_tac_toe\` takes ONE action per call:
- \`move_up\` / \`move_down\` / \`move_left\` / \`move_right\`: move YOUR cursor one cell (clamped at edges)
- \`play\`: place O on the cell under YOUR cursor. Errors if the cell is not empty.

There is no batched form. One call = one action.

### CRITICAL: emit the whole turn in a single response

To play at (r, c) from your cursor (r0, c0) emit, in order:
- \`move_down\` (r - r0) times (or \`move_up\` (r0 - r) times if r < r0)
- \`move_right\` (c - c0) times (or \`move_left\` (c0 - c) times if c < c0)
- one call of \`play\`

All of these tool calls MUST be emitted in the SAME assistant response, as
separate tool_use blocks, before you stop. Do not:
- split the sequence across multiple assistant responses,
- wait for a move result before emitting the next move or \`play\`,
- write any explanation or text between the tool calls,
- call any other tool during your turn (except \`tic_tac_toe_see_board\` when you
  explicitly need the state restated).

Decide the target cell first, then dump every action for the turn in one go.

### Examples (cursor starts at (${AGENT_CURSOR_HOME_ROW}, ${AGENT_CURSOR_HOME_COL}))

- Target (0,0): one call, \`play\`.
- Target (0,2): \`move_right\`, \`move_right\`, \`play\`. Three calls, one response.
- Target (1,1): \`move_down\`, \`move_right\`, \`play\`. Three calls, one response.
- Target (2,2): \`move_down\`, \`move_down\`, \`move_right\`, \`move_right\`, \`play\`. Five calls, one response.

### Strategy

1. If you have two O's in a line with the third cell empty, win by playing there.
2. Otherwise, if X has two in a line with the third cell empty, block there.
3. Otherwise, prefer center, then corners, then edges.
`;

		return {
			systemPrompt: event.systemPrompt + instructions,
		};
	});

	// -----------------------------------------------------------------------
	// /tic-tac-toe command
	// -----------------------------------------------------------------------
	// /tic-tac-toe：打开棋盘并开始/恢复一局。
	pi.registerCommand("tic-tac-toe", {
		description: "Play tic-tac-toe against the agent",

		handler: async (_args, ctx) => {
			// 组件只支持 TUI；其他模式提示错误。
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Tic-tac-toe requires interactive mode", "error");
				return;
			}

			// 先按当前分支恢复；已结束的对局重新开一局空棋盘。
			reconstructState(ctx);
			if (gameState.status !== "playing") {
				gameState = createInitialState();
			}
			// 标记对局活跃，使 before_agent_start 注入规则。
			gameActive = true;
			// 会话名便于区分多个对局会话。
			pi.setSessionName("Tic-Tac-Toe");

			// custom 的泛型 void 表示 done 不携带返回值。
			await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
				component = new TicTacToeComponent(
					tui,
					// 关闭回调：清空组件引用、结束对局并让 custom 返回。
					() => {
						component = null;
						gameActive = false;
						done(undefined);
					},
					// 用户落子回调：更新棋盘、判定胜负、持久化并触发模型回合。
					(row, col) => {
						gameState.board[row][col] = gameState.userMark;
						gameState.status = checkWin(gameState.board);
						// 未结束则轮到代理。
						if (gameState.status === "playing") {
							gameState.currentTurn = gameState.agentMark;
						}
						// 先刷新 TUI，再写入会话条目。
						component?.updateState(gameState);
						pi.appendEntry(SAVE_TYPE, getBoardDetails());

						if (gameState.status === "playing") {
							// IMPORTANT: user play does NOT touch the agent cursor.
							// The agent cursor is only reset after a successful agent play.
							// 只把代理光标交给模型；用户光标保持私有。
							const boardAscii = boardToAscii(
								gameState.board,
								gameState.agentCursorRow,
								gameState.agentCursorCol,
							);
							// triggerTurn: true 让这条消息立即触发一次模型回合。
							pi.sendMessage(
								{
									customType: MOVE_MESSAGE_TYPE,
									content:
										`Player X played at (row=${row}, col=${col}). It is now Player O's turn.\n\n` +
										`Board (your cursor marked with <>):\n${boardAscii}\n\n` +
										`Your cursor is at (row=${gameState.agentCursorRow}, col=${gameState.agentCursorCol}). ` +
										`Decide your target cell, then emit every move_* and the final play ` +
										`as separate tic_tac_toe tool calls in THIS response.`,
									display: true,
									details: getBoardDetails(),
								},
								{ triggerTurn: true },
							);
						} else {
							// 用户这一步直接结束比赛：发终局消息并停止注入规则。
							emitGameOverMessage();
							gameActive = false;
						}
					},
					gameState,
				);
				return component;
			});
		},
	});

	// -----------------------------------------------------------------------
	// tic_tac_toe tool - one action per call.
	// -----------------------------------------------------------------------

	// 工具动作的本地字面量类型；参数 schema 也限制为同样的字符串集合。
	type Action = "move_up" | "move_down" | "move_left" | "move_right" | "play";

	// 每个动作的人为延迟；move 有 300ms 延迟，使并发执行时的竞态可观察。
	const ACTION_DELAYS: Record<Action, number> = {
		move_up: 300,
		move_down: 300,
		move_left: 300,
		move_right: 300,
		play: 0,
	};

	// 主工具：一次只做一个动作；executionMode 让同一响应的调用串行。
	pi.registerTool({
		name: "tic_tac_toe",
		label: "Tic-Tac-Toe",
		description:
			"Execute ONE tic-tac-toe action as Player O. `action` is exactly one of: move_up, move_down, move_left, move_right (move YOUR cursor one cell, clamped at edges), or play (place O under YOUR cursor; errors if the cell is not empty). There is no batched form. To play at (r, c) from your current cursor (r0, c0), emit the required move_down/move_up and move_right/move_left calls, then play, all as separate tool_use blocks in the SAME assistant response. Do not split the sequence across responses and do not wait for a result before emitting the next call. Your cursor position persists between turns and is reset to (0,0) only after a successful play.",
		promptSnippet: "Play a tic-tac-toe action (move_up/down/left/right or play) as Player O",
		// \u4e24\u6761\u7b80\u77ed\u6307\u5357\u4e0e description \u4e00\u8d77\u8fdb\u5165\u5de5\u5177\u63d0\u793a\uff1b\u771f\u6b63\u7684\u957f\u89c4\u5219\u5728\u7cfb\u7edf\u63d0\u793a\u4e2d\u3002
		promptGuidelines: [
			"When it is your tic-tac-toe turn, decide the target cell first, then emit every move_* plus the final play as separate tic_tac_toe tool calls in a SINGLE assistant response. Never split them across responses or wait for intermediate results.",
			"Never ask the user for the board. The board and your cursor position are included in the user's move message; use tic_tac_toe_see_board if you need them restated.",
		],
		// StringEnum \u751f\u6210\u4f9b\u5e94\u5546\u517c\u5bb9\u7684\u5b57\u7b26\u4e32\u679a\u4e3e schema\uff1b\u53c2\u6570\u53ea\u6709 action \u4e00\u4e2a\u5b57\u6bb5\u3002
		parameters: Type.Object({
			action: StringEnum(["move_up", "move_down", "move_left", "move_right", "play"] as const, {
				description:
					"The single action to perform this call. Emit multiple tic_tac_toe calls in one response to string actions together.",
			}),
		}),
		// \u5173\u952e\u6f14\u793a\u70b9\uff1a\u540c\u4e00\u52a9\u624b\u54cd\u5e94\u91cc\u7684\u5144\u5f1f\u5de5\u5177\u8c03\u7528\u6309\u6570\u7ec4\u987a\u5e8f\u4e32\u884c\u6267\u884c\u3002
		executionMode: "sequential" as ToolExecutionMode,

		// \u6267\u884c\u4e00\u4e2a\u52a8\u4f5c\uff1b\u6210\u529f\u65f6\u8fd4\u56de\u6587\u672c\u4e0e\u6700\u65b0\u68cb\u76d8\uff0c\u975e\u6cd5\u52a8\u4f5c\u629b TicTacToeError\u3002
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// params.action \u5df2\u7531 schema \u6821\u9a8c\u4e3a\u4e94\u4e2a\u5b57\u9762\u91cf\u4e4b\u4e00\uff0c\u53ef\u76f4\u63a5\u7d22\u5f15\u5ef6\u8fdf\u8868\u3002
			const actionDelay = ACTION_DELAYS[params.action];
			if (actionDelay > 0) await delay(actionDelay);

			let result: string;

			// \u6bcf\u4e2a case \u53ea\u4fee\u6539\u4ee3\u7406\u5149\u6807\u6216\u843d\u5b50\uff1bswitch \u5bf9 Action \u8054\u5408\u505a\u7a77\u5c3d\u68c0\u67e5\u3002
			switch (params.action) {
				case "move_up":
					// \u8fb9\u754c\u5904\u4e0d\u79fb\u52a8\uff0c\u4f46\u4ecd\u8fd4\u56de\u6210\u529f\u6587\u672c\u3002
					if (gameState.agentCursorRow > 0) gameState.agentCursorRow--;
					result = `Moved up. Cursor: (${gameState.agentCursorRow}, ${gameState.agentCursorCol})`;
					break;
				case "move_down":
					if (gameState.agentCursorRow < 2) gameState.agentCursorRow++;
					result = `Moved down. Cursor: (${gameState.agentCursorRow}, ${gameState.agentCursorCol})`;
					break;
				case "move_left":
					if (gameState.agentCursorCol > 0) gameState.agentCursorCol--;
					result = `Moved left. Cursor: (${gameState.agentCursorRow}, ${gameState.agentCursorCol})`;
					break;
				case "move_right":
					if (gameState.agentCursorCol < 2) gameState.agentCursorCol++;
					result = `Moved right. Cursor: (${gameState.agentCursorRow}, ${gameState.agentCursorCol})`;
					break;
				case "play": {
					// \u7ed3\u675f\u6216\u975e\u4ee3\u7406\u56de\u5408\u65f6\u629b\u9519\uff1b\u629b\u9519\u4e0d\u4f1a\u4fee\u6539\u72b6\u6001\u3002
					if (gameState.status !== "playing") {
						throw new TicTacToeError(`Game is over (${gameState.status}).`);
					}
					if (gameState.currentTurn !== gameState.agentMark) {
						throw new TicTacToeError("It is not your turn.");
					}
					const r = gameState.agentCursorRow;
					const c = gameState.agentCursorCol;
					// \u76ee\u6807\u683c\u5df2\u5360\u7528\uff1a\u6e38\u6807\u4fdd\u6301\u539f\u4f4d\uff0c\u65b9\u4fbf\u6a21\u578b\u79fb\u52a8\u540e\u91cd\u8bd5\u3002
					if (gameState.board[r][c] !== " ") {
						// Do NOT reset the cursor on failure. The agent can retry
						// from the cursor's current position.
						component?.updateState(gameState);
						pi.appendEntry(SAVE_TYPE, getBoardDetails());
						throw new TicTacToeError(
							`Cell (${r},${c}) is already ${gameState.board[r][c]}. Your cursor is still at (${r},${c}). Move to an empty cell and retry play.`,
						);
					}
					gameState.board[r][c] = gameState.agentMark;
					gameState.status = checkWin(gameState.board);
					// Reset agent cursor to home ONLY on successful play.
					gameState.agentCursorRow = AGENT_CURSOR_HOME_ROW;
					gameState.agentCursorCol = AGENT_CURSOR_HOME_COL;
					if (gameState.status === "playing") {
						// \u672a\u7ed3\u675f\uff1a\u4ea4\u8fd8\u7528\u6237\u56de\u5408\u3002
						gameState.currentTurn = gameState.userMark;
						result = `Placed O at (${r},${c}). Cursor reset to (${AGENT_CURSOR_HOME_ROW},${AGENT_CURSOR_HOME_COL}). Your turn, X!`;
					} else if (gameState.status === "win_O") {
						// \u4ee3\u7406\u83b7\u80dc\uff1a\u7ed3\u675f\u5bf9\u5c40\u5e76\u53d1\u7ec8\u5c40\u6d88\u606f\u3002
						result = `Placed O at (${r},${c}). Player O wins!`;
						gameActive = false;
						emitGameOverMessage();
					} else if (gameState.status === "draw") {
						result = `Placed O at (${r},${c}). It's a draw!`;
						gameActive = false;
						emitGameOverMessage();
					} else {
						// \u7406\u8bba\u4e0a win_X \u4e0d\u4f1a\u7531 O \u843d\u5b50\u4ea7\u751f\uff1b\u4fdd\u7559\u515c\u5e95\u6587\u672c\u3002
						result = `Placed O at (${r},${c}).`;
					}
					break;
				}
			}

			// \u6240\u6709\u52a8\u4f5c\uff08\u5305\u62ec move\uff09\u90fd\u5237\u65b0 TUI \u5e76\u6301\u4e45\u5316\uff0c\u6062\u590d\u65f6\u80fd\u56de\u5230\u6700\u65b0\u5149\u6807\u3002
			component?.updateState(gameState);
			pi.appendEntry(SAVE_TYPE, getBoardDetails());

			return {
				content: [{ type: "text", text: result }],
				details: getBoardDetails(),
			};
		},

		// \u8c03\u7528\u884c\uff1a\u5de5\u5177\u540d + \u52a8\u4f5c\u540d\uff1b\u4e0d\u8bfb\u53d6\u6e38\u620f\u72b6\u6001\u3002
		renderCall(args, theme) {
			// args \u6765\u81ea schema\uff0caction \u4e00\u5b9a\u662f\u5b57\u7b26\u4e32\uff1btypeof \u4ec5\u4e3a\u6ee1\u8db3\u6e32\u67d3\u51fd\u6570\u7684\u5bbd\u6cdb\u7c7b\u578b\u3002
			const action = typeof args.action === "string" ? args.action : "";
			return new Text(theme.fg("toolTitle", theme.bold("tic_tac_toe ")) + theme.fg("muted", action), 0, 0);
		},

		// \u7ed3\u679c\u884c\uff1a\u6210\u529f/\u5931\u8d25\u524d\u7f00 + \u6587\u672c\uff1b\u5c55\u5f00\u65f6\u9644\u5e26\u68cb\u76d8\u6a2a\u5e45\u3002
		renderResult(result, { expanded }, theme, context) {
			const details = result.details as BoardDetails | undefined;
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			// context.isError \u533a\u5206\u629b\u9519\u7ed3\u679c\u4e0e\u6b63\u5e38\u7ed3\u679c\u3002
			const prefix = context?.isError ? theme.fg("error", "\u2717 ") : theme.fg("success", "\u2713 ");
			const summary = prefix + theme.fg("muted", msg);

			if (expanded && details) {
				return new BannerMessageComponent(summary, details, true, theme);
			}
			return new Text(summary, 0, 0);
		},
	});

	// -----------------------------------------------------------------------
	// tic_tac_toe_see_board tool - inspect board + agent cursor.
	// -----------------------------------------------------------------------
	// 只读查询工具：不修改状态，用于模型在回合中重新确认棋盘与光标。
	pi.registerTool({
		name: "tic_tac_toe_see_board",
		label: "See Board",
		description:
			"Return the current tic-tac-toe board state and YOUR cursor position (Player O). Takes no arguments. Use this if you need the current state restated mid-turn (for example after a failed play). The user's cursor is never exposed.",
		promptSnippet: "Inspect the tic-tac-toe board and your cursor",
		parameters: Type.Object({}),

		// \u65e0\u53c2\u6570\u3001\u65e0\u526f\u4f5c\u7528\uff1b\u8fd4\u56de ASCII \u68cb\u76d8\u3001\u4ee3\u7406\u5149\u6807\u3001\u72b6\u6001\u4e0e\u56de\u5408\u3002
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const boardAscii = boardToAscii(gameState.board, gameState.agentCursorRow, gameState.agentCursorCol);
			const text =
				`Board (your cursor marked with <>):\n${boardAscii}\n\n` +
				`Your cursor: (row=${gameState.agentCursorRow}, col=${gameState.agentCursorCol})\n` +
				`Status: ${gameState.status}\n` +
				`Turn: ${gameState.currentTurn === gameState.agentMark ? "Player O (you)" : "Player X"}`;
			// \u4e0d\u5199 appendEntry\uff1a\u67e5\u8be2\u4e0d\u6539\u53d8\u72b6\u6001\uff0c\u6062\u590d\u65f6\u65e0\u9700\u91cd\u653e\u3002
			return {
				content: [{ type: "text", text }],
				details: getBoardDetails(),
			};
		},

		// \u8c03\u7528\u884c\u53ea\u663e\u793a\u5de5\u5177\u540d\u3002
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("tic_tac_toe_see_board")), 0, 0);
		},

		// \u6298\u53e0\u65f6\u53ea\u663e\u793a\u5149\u6807\u5750\u6807\uff1b\u5c55\u5f00\u663e\u793a\u68cb\u76d8\u3002
		renderResult(result, { expanded }, theme) {
			const details = result.details as BoardDetails | undefined;
			const summary =
				theme.fg("success", "\u2713 ") +
				theme.fg("muted", `cursor (${details?.agentCursorRow ?? 0},${details?.agentCursorCol ?? 0})`);
			if (expanded && details) {
				return new BannerMessageComponent(summary, details, true, theme);
			}
			return new Text(summary, 0, 0);
		},
	});
}
