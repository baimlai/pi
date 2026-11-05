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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DoomOverlayComponent } from "./doom-component.ts";
import { DoomEngine } from "./doom-engine.ts";
import { ensureWadFile } from "./wad-finder.ts";

// Persistent engine instance - survives between invocations
// 模块级引用跨多次命令保留引擎；null 表示当前没有可复用实例。
let activeEngine: DoomEngine | null = null;
// 记录成功初始化使用的 WAD 路径，按字符串相等决定复用，不比较内容。
let activeWadPath: string | null = null;

// 扩展入口收到 Pi API，只注册 /doom-overlay 命令，无返回；游戏在命令 handler 才启动。
// 流程为检查TUI、选WAD、复用或初始化引擎、等待覆盖层结束；可下载/读文件并启动定时器。
// 例：第二次用同一路径调用命令会恢复缓存引擎，加载/显示错误会清缓存；下载查找位于下方 try 外。
export default function (pi: ExtensionAPI) {
	// 注册命令定义；description 是用户帮助文字，handler 为异步命令处理器。
	pi.registerCommand("doom-overlay", {
		description: "Play DOOM as an overlay. Q to pause and exit.",

		// args 是命令参数字符串，ctx 是当前扩展上下文；await 的异常由对应 try 或外层处理。
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
					// 先缓存新实例；若后续失败会在 catch 清空。
					// 丢弃引擎引用。
					activeEngine = new DoomEngine(wad);
					// 等待读文件、加载WASM及 C 初始化完成。
					await activeEngine.init();
					// 只有成功初始化才记住可复用路径。
					// 同时丢弃路径，避免状态不配套。
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
