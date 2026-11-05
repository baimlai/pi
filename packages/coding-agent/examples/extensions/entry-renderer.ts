// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；复制到扩展目录或 `pi -e ./entry-renderer.ts` 加载。
// 演示内容：注册 status-card 自定义 entry 渲染器，并用 /status-card 追加一张持久化、但不发送给 LLM 的状态卡片。
// 上下游：命令调用 pi.appendEntry 写入会话 entries；交互式 transcript 通过 pi.registerEntryRenderer 渲染；Box/Text 负责布局。不调用模型、不读写普通文件。
// 能力清单：
// - StatusCardData：卡片数据，message 是正文，timestamp 是毫秒时间。
// - registerEntryRenderer<StatusCardData>：折叠时显示 [status] 与消息，展开时显示本地时间。
// - /status-card [message]：追加自定义 entry；空参数使用默认文案。
// 典型运行顺序：输入 /status-card Build green -> appendEntry 写入会话 -> 渲染器创建 Box -> 折叠显示 [status] Build green -> ctrl+e 展开显示本地时间。
// 示例（真实签名）：
//   /status-card Build green
//   // 卡片正文为 "[status] Build green"，展开后显示例如 "2026/11/6 14:30:00"
// 阅读顺序：先看 StatusCardData 和渲染器，再看命令如何 appendEntry。
// 前置与副作用：自定义 entry 只存会话日志，不进入 LLM 上下文；需要交互式渲染器才可见。entry.data 来自持久化日志，可能缺失或来自旧格式；?? 只处理 null/undefined，不验证 message/timestamp 的运行时类型。缺少 data 时用 Date.now() 生成回退时间，每次重画都会变化。toLocaleString 受系统语言/时区影响，输出不稳定。消息没有长度限制，超长文本会写入会话并撑高卡片。命令没有 UI 通知，appendEntry 本身返回 void。
/**
 * Custom entry rendering example.
 *
 * Shows how to render durable extension data inside the chat without sending it
 * to the LLM. Custom entries are stored in the session via pi.appendEntry() and
 * rendered in interactive mode via pi.registerEntryRenderer().
 *
 * Usage: /status-card [message]
 */

// import type 只引入类型；ExtensionAPI 用于标注入口，编译后擦除。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Box 提供背景和内边距，Text 绘制文本；两者都是 pi-tui 的 Component。
import { Box, Text } from "@earendil-works/pi-tui";

// 卡片数据的持久化形状；泛型参数只影响编译期，不会在读取 session 文件时做校验。
interface StatusCardData {
	message: string;
	timestamp: number;
}

export default function (pi: ExtensionAPI) {
	// 注册自定义 entry 的渲染器；entry.data 的类型由 StatusCardData 指定。
	pi.registerEntryRenderer<StatusCardData>("status-card", (entry, { expanded }, theme) => {
		// data 可能为 undefined；回退对象用当前时间，因此每次重画展开时间都可能不同。
		const data = entry.data ?? { message: "No data", timestamp: Date.now() };
		// Box(1,1,bgFn) 创建带内边距和 customMessageBg 背景的容器。
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		// 折叠状态下也显示消息；accent 色只包住 [status] 标签。
		box.addChild(new Text(`${theme.fg("accent", "[status]")} ${data.message}`, 0, 0));

		// expanded 由用户展开/折叠状态决定；keyHint 这里没有使用。
		if (expanded) {
			// toLocaleString 使用系统语言和时区，不是固定格式；timestamp 假定是毫秒数。
			box.addChild(new Text(theme.fg("dim", new Date(data.timestamp).toLocaleString()), 0, 0));
		}

		// 返回 Box 作为整个 entry 的组件；Box 负责子组件布局。
		return box;
	});

	// 命令名不带斜杠；执行时只写 entry，不发送消息。
	pi.registerCommand("status-card", {
		description: "Render a durable status card that is not sent to the LLM",
		// handler 不需要 ctx；args 是 /status-card 后的原始文本。
		handler: async (args) => {
			// appendEntry 把 data 持久化到会话日志；不会触发模型轮次。
			pi.appendEntry<StatusCardData>("status-card", {
				// trim 后为空则使用默认文案；否则保留用户输入（包括内部换行）。
				message: args.trim() || "Status card",
				// 记录写入时的毫秒时间；渲染器展开时再格式化。
				timestamp: Date.now(),
			});
		},
	});
}
