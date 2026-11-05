/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是终端标题动画。
 * 上游：宿主通过 `pi --extension examples/extensions/titlebar-spinner.ts` 加载；
 * agent_start 开始动画，agent_settled/session_shutdown 停止并恢复静态标题。
 * 下游：ctx.ui.setTitle() 修改终端窗口/标签标题；path.basename(process.cwd()) 与
 * pi.getSessionName() 只读取本地信息。不写文件、不发网络请求、不调用模型。
 *
 * 演示的机制：用 setInterval 每 80ms 换一帧盲文字符，把进度感放在终端标题里；
 * 所有定时器都必须有停止路径，否则会话结束后仍会持续触发 UI 调用。
 *
 * 能力清单：
 * - BRAILLE_FRAMES：十个盲文点帧组成的循环动画素材。
 * - getBaseTitle(pi)：拼出不含动画帧的静态标题（π - 会话名 - 目录）。
 * - stopAnimation(ctx)：清除定时器、重置帧序号并恢复静态标题。
 * - startAnimation(ctx)：先停止旧动画，再启动新的 80ms 定时器。
 * - 默认导出：注册 agent_start/agent_settled/session_shutdown 三个监听器。
 *
 * 典型运行顺序：加载扩展 -> 发送一条消息 -> 标题开始闪烁 -> Agent 稳定结束后恢复
 * `π - <session> - <cwd>`；退出会话时再次确保清理。
 *
 * 示例（真实签名）：
 *   ctx.ui.setTitle("π - my-session - pi");  // 返回 void
 *   真实运行时终端是否显示标题取决于终端模拟器，不支持时调用无害。
 *
 * 建议阅读顺序：先看 getBaseTitle 的拼接逻辑，再看 stopAnimation 与 startAnimation
 * 的配对，最后看三个生命周期监听器。
 *
 * 前置条件：需要交互式终端；标题栏支持 OSC 转义序列的终端才能看到效果。
 */

/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   pi --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// 十个盲文字符按视觉顺序排列；取模循环复用。
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// 生成静态标题：终端标题不显示完整路径，只取当前目录名。
function getBaseTitle(pi: ExtensionAPI): string {
	// path.basename 只保留路径最后一段；process.cwd() 是启动时的工作目录。
	const cwd = path.basename(process.cwd());
	// getSessionName 未命名时返回 undefined，用于决定是否把会话名放进标题。
	const session = pi.getSessionName();
	// 三元表达式选择带会话名或不带会话名的两种格式。
	return session ? `π - ${session} - ${cwd}` : `π - ${cwd}`;
}

// 扩展入口：timer 与 frameIndex 存在闭包里，被 start/stop 共享。
export default function (pi: ExtensionAPI) {
	// setInterval 返回 Node 定时器对象；初始为 null 表示没有动画在跑。
	let timer: ReturnType<typeof setInterval> | null = null;
	// 当前帧索引，停止时归零，下次启动从第一帧开始。
	let frameIndex = 0;

	// 停止动画：幂等，可在没有定时器时安全调用。
	function stopAnimation(ctx: ExtensionContext) {
		// 只有存在定时器时才 clearInterval，避免传入 null。
		if (timer) {
			// clearInterval 取消调度；之后把引用置空，防止重复清除。
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		// 恢复不带动画帧的标题，避免最后一次动画帧残留在标题栏。
		ctx.ui.setTitle(getBaseTitle(pi));
	}

	// 启动动画：先清理旧定时器，保证任一时刻最多一个 interval。
	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		// 每 80ms 执行一次回调；回调里重新读取 cwd 与会话名，能反映期间的变化。
		timer = setInterval(() => {
			// 取模让 frameIndex 超出数组长度后回到开头；数组元素类型是 string。
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = pi.getSessionName();
			// 与静态标题相同的拼接，只是前面多了会变化的 frame。
			const title = session ? `${frame} π - ${session} - ${cwd}` : `${frame} π - ${cwd}`;
			ctx.ui.setTitle(title);
			// 后置自增推进到下一帧。
			frameIndex++;
		}, 80);
	}

	// 底层 Agent 开始运行时启动；async 只是让签名与事件系统一致，内部没有 await。
	pi.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	// agent_settled 表示这一轮真正稳定结束（不是底层 agent_end），此时停止动画。
	pi.on("agent_settled", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	// 会话关闭时兜底清理，防止异常路径留下定时器。
	pi.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
