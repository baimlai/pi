// The active theme of a client (slice 11 §4b): the `Themes` registry on the client's host (served there by the kit),
// the user's `ThemeChoice` (held on the server; until it binds, or when the app serves none, the first theme of each
// mode) and the client's mode, combined; each change calls the client's writer (CSS variables on a page, the colour
// lookup in a terminal).

//
// 文件导读
// 所属：packages/chord 的 surfaces 层（`chord/surfaces`），负责客户端“当前主题”的组合与跟随。
// 职责边界：把三样东西合成为 Theme：服务器端的 Themes 注册表、用户 ThemeChoice 的 pick、客户端当前 mode；
// 不定义主题结构、不写 CSS/ANSI，具体呈现由调用方的 changed 回调决定。上游是 web/react/tui 客户端初始化；
// 下游是 Themes 注册表与 ThemeChoice 的 watch。结果通过回调推送；stop 中止内部 AbortController 并释放 hold。
// 错误：host.registry/watch 失败会让 followActiveTheme 拒绝；pick.watch 首次失败被忽略（hold 已结束）。
// 能力清单：
// - ThemeFollower：跟随句柄类型，含 setMode 与 stop。
// - followActiveTheme：立即回调一次，再订阅注册表与用户选择，直到 stop。
// 组合与顺序：update() 用 activeTheme(themes, pick, current) 计算；先立即 update（回退主题），
// 再 await registry 并 update，再 start registry watch 与 choice.pick watch；setMode 改 current 并 update；stop 释放。
// 示例：`const follower = await followActiveTheme(host, "dark", (theme) => apply(theme), context);`
// 阅读顺序：先看 ThemeFollower，再看 followActiveTheme 的 update 与两个 watch，最后看 setMode/stop。
import { type Context, withAbortSignal } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { Host } from "../host/index.ts";
import { ThemeChoice } from "./theme-choice.ts";
import { activeTheme, type Theme, type ThemePick, Themes } from "./themes.ts";

/** A client's active theme as it follows it: its mode can change (a page's colour scheme), and it ends. */
// 跟随句柄：setMode 在页面颜色方案变化时调用；stop 结束所有订阅并释放服务器端 hold。
// Theme["mode"] 是索引访问类型，取 Theme 类型中 mode 字段的类型，避免重复写 "dark" | "light"。
export type ThemeFollower = {
	/** The client's mode changed: the active theme is chosen again. */
	setMode(mode: Theme["mode"]): void;
	stop(): void;
};

/**
 * Follows the active theme on `host` for `mode`, calling `changed` with it at once (the fallback or the first of its
 * mode) and at every change of the registry, the user's pick or the mode, until `stop`.
 */
// 跟随指定 host 上的当前主题。输入：host、初始 mode、主题变化回调、外部 context。
// 输出：ThemeFollower。副作用：注册两个 watch、在服务器端 hold 一个 ThemeChoice；stop 时全部释放。
// 泛型 P extends Principal 保持 host 的主体类型；context 用于把外部取消与内部 abort 合并。
// 流程：先立即回调回退主题 → 取注册表 → 再回调 → 订阅注册表 → hold 用户选择并订阅 pick。
export async function followActiveTheme<P extends Principal>(
	host: Host<P>,
	mode: Theme["mode"],
	changed: (theme: Theme) => void,
	context: Context,
): Promise<ThemeFollower> {
	// 内部 AbortController：stop 时触发，统一结束 registry.watch 与 pick.watch。
	const abort = new AbortController();
	// withAbortSignal 把内部信号与外部 context 合并成一个派生 context；任一中止都生效。
	const ctx = withAbortSignal(abort.signal, context);
	// 注册表初始为空，pick 初始为“两个模式都未选择”，因此第一次 activeTheme 会使用内置回退主题。
	let themes: readonly Theme[] = [];
	let pick: ThemePick = { dark: null, light: null };
	// current 是可变的当前模式，setMode 会更新它。
	let current = mode;
	// update 是唯一的“重新计算并通知”入口，保证任何变化都走同一逻辑。
	const update = (): void => changed(activeTheme(themes, pick, current));
	// 立即通知一次，调用方无需等待网络即可得到可用主题。
	update();
	// registry 是远程对象句柄；await 期间可能被外部中止，此时 Promise 拒绝。
	const registry = await host.registry(Themes, ctx);
	// 读取当前注册表值并再次通知。
	themes = registry.value;
	update();
	// 订阅注册表变化；只要 value 帧就更新 themes 并通知。failed 帧保持旧 themes。
	(await registry.watch(ctx)).start(async (call) => {
		if (call.kind === "value") themes = call.value;
		update();
	});
	// 在服务器端 hold 一个 ThemeChoice 对象，pick 是其可观察字段。
	const choice = host.hold(ThemeChoice, {}, ctx);
	// pick.watch 可能因 hold 结束而拒绝；then 的第二个回调吞掉该拒绝（follower 已停止，无需上报）。
	choice.pick.watch(ctx).then(
		(watch) =>
			watch.start(async (call) => {
				// 远程值在运行时由桥接层校验形状；这里用 `as ThemePick` 做编译期断言。
				if (call.kind === "value") pick = call.value as ThemePick;
				update();
			}),
		// The hold ended (the follower stopped) before its first value.
		() => {},
	);
	return {
		setMode: (next) => {
			// 只改变本地 mode，不写服务器；随后重新选择主题。
			current = next;
			update();
		},
		stop: () => {
			// abort 结束两个 watch（它们以 aborted 终止）；release 释放服务器端 hold。
			abort.abort();
			choice.release();
		},
	};
}
