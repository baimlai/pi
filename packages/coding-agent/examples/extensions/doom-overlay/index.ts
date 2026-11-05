/**
 * DOOM Overlay Demo - Play DOOM as an overlay
 *
 * Usage: pi --extension ./examples/extensions/doom-overlay
 *
 * Commands:
 *   /doom-overlay - Play DOOM in an overlay (Q to pause/exit)
 *
 * This demonstrates that overlays can handle real-time game rendering at 35 FPS.
 */

/**
 * 文件导读（doom-overlay 扩展示例入口）
 *
 * 所属与用途：本文件是 `packages/coding-agent/examples/extensions/doom-overlay` 示例的入口，
 * 注册 `/doom-overlay` 命令，把一段用 WebAssembly 编译的 DOOM 作为 TUI 覆盖层运行。
 * 它负责命令生命周期和引擎缓存；具体按键、渲染、WASM 装载、WAD 查找分别在同目录其他文件。
 *
 * 上游如何进入：同目录没有 package.json，因此以单文件/目录扩展方式加载：
 *   pi --extension packages/coding-agent/examples/extensions/doom-overlay
 * （原英文头部的 `./examples/extensions/doom-overlay` 是相对 `packages/coding-agent` 的路径。）
 * 加载后执行 `/doom-overlay`，可带一个 WAD 路径参数；不带参则自动查找或下载。
 *
 * 下游依赖：`doom-component.ts` 提供 TUI 组件与 35 FPS 循环，`doom-engine.ts` 加载 WASM 并
 * 推入按键，`wad-finder.ts` 查找/下载 `doom1.wad`。本文件本身不直接发起网络请求，但
 * `ensureWadFile` 可能下载；引擎初始化会读取 WAD 与 `doom/build/doom.js`、`doom/build/doom.wasm`。
 *
 * 能力清单：
 * - 模块级 `activeEngine`/`activeWadPath`：跨命令调用缓存引擎，相同 WAD 路径可恢复。
 * - `pi.registerCommand("doom-overlay")`：命令定义。
 * - handler：检查 TUI 模式 -> 选择 WAD -> 复用或初始化 -> 打开覆盖层 -> 失败时清理缓存。
 *
 * 典型运行顺序：
 *   1. 启动 pi 并加载扩展；
 *   2. `/doom-overlay`（或 `/doom-overlay ~/doom1.wad`）；
 *   3. 首次运行若无 WAD，会显示 Loading 并尝试下载；
 *   4. 覆盖层中 WASD 移动、F 开火、空格开门、Q 暂停并退出；
 *   5. 再次执行命令且 WAD 路径相同，会复用引擎并发送一次 Pause 作为恢复。
 *
 * 示例（真实命令）：
 *   /doom-overlay
 *   /doom-overlay /absolute/path/to/doom1.wad
 * 预期：出现占终端约 75% 宽、最多 95% 高的居中覆盖层；失败时显示通知并结束命令。
 *
 * 建议阅读顺序：先看本文件的命令 handler 和缓存策略，再读 `doom-component.ts` 的渲染/按键，
 * 然后读 `doom-engine.ts` 的 WASM 装载，最后读 `wad-finder.ts` 的 WAD 来源。
 *
 * 注意：命令参数不做存在性检查；传了不存在的路径时，错误会在 `DoomEngine.init()` 的
 * `readFileSync(WAD)` 或后续加载阶段抛出，并被下面的 catch 转成通知。没有 WAD 且下载失败时，
 * `ensureWadFile` 返回 null，函数提前返回。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DoomOverlayComponent } from "./doom-component.ts";
import { DoomEngine } from "./doom-engine.ts";
import { ensureWadFile } from "./wad-finder.ts";

// Persistent engine instance - survives between invocations
// 模块级引用跨多次命令保留引擎；null 表示当前没有可复用实例。
let activeEngine: DoomEngine | null = null;
// 记录成功初始化使用的 WAD 路径，按字符串相等决定复用，不比较内容。
let activeWadPath: string | null = null;

/**
 * 扩展默认导出：注册 `/doom-overlay` 命令。
 *
 * 输入：`pi` 扩展 API。输出：无返回值。
 * 副作用：只修改宿主命令表；不启动游戏、不读 WAD。
 * 错误路径：注册本身不抛错。
 * 示例：加载扩展后输入 `/doom-overlay`，才会进入下面的 handler。
 */
export default function (pi: ExtensionAPI) {
	// 注册命令定义；description 是用户帮助文字，handler 为异步命令处理器。
	pi.registerCommand("doom-overlay", {
		description: "Play DOOM as an overlay. Q to pause and exit.",

		/**
		 * 命令处理：选择 WAD、准备引擎、打开覆盖层直到用户退出。
		 *
		 * 输入：`args` 是斜杠命令后的原始参数（可为 undefined/空白）；`ctx` 是扩展上下文
		 * （模式、通知、自定义 UI、主题）。
		 * 输出：`Promise<void>`；覆盖层关闭或提前返回时完成。
		 * 副作用：可能下载 WAD、读取 WAD/构建文件、启动 35 FPS 定时器、修改模块级引擎缓存。
		 * 错误路径：非 TUI 模式或 WAD 查找失败时通知并返回；引擎初始化/覆盖层异常被 catch，
		 * 通知用户并清空缓存；查找 WAD 位于 try 外，其异常不会被这里的 catch 捕获。
		 * 流程：模式检查 -> 选择 WAD -> 复用或创建引擎 -> `ctx.ui.custom` 等待覆盖层 ->
		 * 失败时清理缓存。
		 * 示例：`/doom-overlay ./doom1.wad` 使用显式路径；再次执行同路径会发送 Pause 恢复。
		 */
		handler: async (args, ctx) => {
			// 非 TUI 模式不能显示交互覆盖层。
			if (ctx.mode !== "tui") {
				// 发错误通知解释模式限制。
				ctx.ui.notify("DOOM requires interactive mode", "error");
				// 立即退出 handler，不查文件或启动游戏。
				return;
			}

			// Auto-download WAD if not present
			// 先提示加载中。
			ctx.ui.notify("Loading DOOM...", "info");
			// ?. 可选调用链配合三元表达式：非空参数直接作路径，否则 await 查找/下载；显式路径不在此验证。
			const wad = args?.trim() ? args.trim() : await ensureWadFile();

			// 默认查找下载失败的 null 在此提示并退出。
			if (!wad) {
				// 提示下载失败，但此信息不细分网络、解压、标头或写入错误。
				ctx.ui.notify("Failed to download DOOM WAD file. Check your internet connection.", "error");
				// 没有 WAD 路径就不进入引擎加载。
				return;
			}

			// 捕获引擎加载和覆盖层显示过程的异常。
			try {
				// Reuse existing engine if same WAD, otherwise create new
				// 本次默认创建新游戏，复用成功时再改为true。
				let isResume = false;
				// 已有实例且路径字符串相同便复用，未重新核对文件内容或 initialized 标记。
				if (activeEngine && activeWadPath === wad) {
					// 向用户显示恢复提示。
					ctx.ui.notify("Resuming DOOM...", "info");
					// 告诉组件模拟 Pause 来恢复。
					isResume = true;
					// 路径不同或无实例时构建新引擎。
				} else {
					// 显示即将读取的 WAD 路径。
					ctx.ui.notify(`Loading DOOM from ${wad}...`, "info");
					// 先把新实例放进模块变量；如果 init 抛错，catch 会把引擎与路径一起清空。
					activeEngine = new DoomEngine(wad);
					// 等待读文件、加载 WASM 及 C 初始化完成；可能耗时较长（前面还可能有 WAD 下载）。
					await activeEngine.init();
					// 只有初始化成功才记录路径，保证下一次“相同路径”复用的一定是已初始化的引擎。
					activeWadPath = wad;
				}

				// 等待自定义覆盖层调用 done，期间组件定时渲染游戏。
				await ctx.ui.custom(
					// 工厂收到 TUI、主题、键绑定和完成回调；前缀 _ 表示这里不用的参数。
					(tui, _theme, _keybindings, done) => {
						// activeEngine! 是非空断言，TS信任上面分支已赋值；退出回调用 done(undefined) 完成等待。
						return new DoomOverlayComponent(tui, activeEngine!, () => done(undefined), isResume);
					},
					// 第二参数声明此自定义组件作为覆盖层显示。
					{
						// 开启覆盖层模式。
						overlay: true,
						// 交给 TUI 的布局配置对象。
						overlayOptions: {
							// 覆盖层宽是终端宽的75%，以代码当前值为准。
							width: "75%",
							// 布局最大高限制为终端的95%。
							maxHeight: "95%",
							// 以中心锚点定位。
							anchor: "center",
							// 顶部保留1行边距。
							margin: { top: 1 },
						},
					},
				);
				// 初始化或显示失败时清除缓存，使下次重新加载。
			} catch (error) {
				// 将捕获值插入错误通知，不重新抛出。
				ctx.ui.notify(`Failed to load DOOM: ${error}`, "error");
				activeEngine = null;
				activeWadPath = null;
			}
		},
	});
}
