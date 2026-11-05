// 文件导读
// 所属：packages/chord/test/examples/56-web/tui，Chord 示例 56 的终端入口；start.ts 把它作为 tui.entry。
// 作用：终端客户端的基础 bundle（由服务器用 esbuild 以 sandbox 平台构建），在启动器的子进程沙箱中
// 运行。它声明应用自己的 core facet（提供 Lines 注册表），用 `startTerminalRuntime` 连接服务器、
// 加载插件，并在 `render` 中创建 `TuiScope`：注册表或主题变化时重绘整屏；按 q 退出。
// 上游：示例 56 主进程启动服务器后，终端测试（见 57-tui）或 `--serve` 时的人工终端会加载本入口。
// 下游：src/tui/index.ts 的 startTerminalRuntime/TuiScope（内部再用 startClient、TuiScripts、
// BridgeTerminal、TerminalTheme）；插件 notes/tui.ts 向 Lines 贡献文本。
// 能力清单：
// - `core`：应用 facet，作为 Lines 注册表的 compose 提供者；
// - `render`：拿到运行时后建立 scope、订阅注册表、注册输入处理并首绘。
// 典型行为：屏幕先清屏并显示标题 "Board"，下面每行一条插件贡献；q 让运行时以状态码 0 退出。
// 阅读顺序：先看 core 的 compose，再看 render 中 TuiScope → registry → draw → onInput 的顺序。
// 运行方式：不单独运行；由示例启动器在沙箱中执行。没有可写的 stdout 约定，绘制走桥接终端。
// 说明：终端插件与 web 插件使用同一份 app/v1 API，但注册表分别来自 app/v1/tui 与 app/v1/web。

// The board app's terminal entry (the base bundle the sandbox runs): `startTerminalRuntime` with the app's terminal
// modules, a core facet serving `Lines`, and a redraw of the board on every change (`TuiScope`). `q` quits.

import * as chord from "../../../../src/index.ts";
// TuiScope 把 hold/watch/registry 的生命周期绑到一个对象上，dispose 时统一释放。
import { startTerminalRuntime, TuiScope } from "../../../../src/tui/index.ts";
import * as v1tui from "../app/v1/tui.ts";
import * as v1 from "../app/v1.ts";

// 应用 facet：与 web 入口的 core 形状一致，但服务的是终端注册表。
// compose 把贡献表（每项含 value）映射成 readonly string[]；注册表按插件名排序后交给读者。
const core = chord.defineFacet((host) =>
	host.serve(v1tui.Lines, { compose: (table) => table.map(({ value }) => value) }),
);

// `void` 表示有意丢弃返回的 Promise：入口模块在 IIFE 中立即执行，不需要顶层 await。
// startTerminalRuntime 在沙箱内取桥、加载插件、连接服务器并应用主题，成功后调用 render。
// 失败会表现为未处理的 Promise 拒绝（启动器会记录该子进程的 stderr）。
void startTerminalRuntime({
	// 插件脚本中的 import 说明符 → 真实模块；由服务器构建时保留为外部依赖，运行时从这里取。
	modules: { "@board/app/v1": v1, "@board/app/v1/tui": v1tui },
	// 应用自己的 facets；主题 facet 由 startTerminalRuntime 自动排在最前，无需在此重复。
	core: [{ name: "@board/core", facet: core }],
	// render 只调用一次，但其中的订阅会在运行时持续生效。
	render: (runtime) => {
		// 解构出桥接终端与主题；terminal 负责写字节，theme 只生成带颜色的字符串。
		const { terminal, theme } = runtime;
		// TuiScope 的第二个参数是“任意被观察值变化时”的回调；这里直接重绘。
		const scope = new TuiScope(runtime.host, () => draw());
		// registry 返回一个读取函数（不是 Promise）：每次调用给出最新合并值，尚无值时返回 undefined。
		// 注意：draw 在下面才定义，但此处只是登记回调，真正调用发生在初始化完成之后，闭包能读到 draw。
		const lines = scope.registry(v1tui.Lines);
		// draw 是同步函数：读取当前注册表值 → 给每行加缩进和前景色 → 拼成 CRLF 分隔的文本。
		const draw = (): void => {
			// `?? []`：首次组合尚未到达时按空列表处理；map/join 生成一段可写入终端的文本。
			// theme.fg("fg", line) 返回带 SGR 转义序列的字符串，不会修改 line 本身。
			const body = (lines() ?? []).map((line) => `  ${theme.fg("fg", line)}`).join("\r\n");
			// \x1b[2J 清屏，\x1b[H 把光标移到左上角；标题用 accent 色，正文用普通前景色。
			terminal.write(`\x1b[2J\x1b[H${theme.fg("accent", "Board")}\r\n${body}\r\n`);
		};
		// 主题切换时重绘；onChange 返回取消订阅函数，这里不保存它，订阅持续到终端运行时结束。
		theme.onChange(draw);
		// 终端输入是原始字节字符串；本示例只处理单个字符 q。
		terminal.onInput((data) => {
			// 退出码 0 表示正常退出；exit 只发送请求，不等待进程结束。
			if (data === "q") runtime.exit(0);
		});
		// 首绘：插件注册表可能已经就绪，先画一次；之后由 scope 的变化回调触发。
		draw();
	},
});
