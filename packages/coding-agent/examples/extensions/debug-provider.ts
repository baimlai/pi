// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；复制到扩展目录或 `pi -e ./debug-provider.ts` 加载。
// 演示内容：/debug-provider [on|off] 开启后，按轮捕获原始 provider_stream_event，把 assistant 消息的来源和事件数组追加成可展开的自定义 entry。
// 上下游：命令控制开关；turn_start/provider_stream_event/message_end/turn_end 维护缓冲；pi.registerEntryRenderer 负责渲染，pi.appendEntry 把记录持久化到会话日志。使用 pi-tui 的 Box/Text 和 ctx.ui.setStatus。不调用模型。
// 能力清单：
// - ENTRY_TYPE/STATUS_KEY：自定义 entry 类型字符串与状态栏 key。
// - ProviderDebugEntry：一条记录，含 provider/api/model 与原始事件数组。
// - 默认导出 (pi: ExtensionAPI) => void：注册渲染器、命令和四个事件回调。
// - 渲染器：折叠时显示来源、事件数、展开提示；展开时显示缩进 JSON。
// 典型运行顺序：/debug-provider on -> turn_start 建缓冲 -> provider_stream_event 逐条深拷贝 -> message_end 暂存来源 -> turn_end 追加 entry -> ctrl+e 展开查看。
// 示例（真实签名）：
//   /debug-provider on
//   // 一轮对话后出现 "[provider debug] google/gemini-2.5-flash (google-generative-ai) · 12 events" 条目
// 阅读顺序：先看常量和记录类型，再看 entry renderer，最后看命令与 turn_start/provider_stream_event/message_end/turn_end 的状态流转。
// 前置与副作用：事件缓冲只在一轮内保留，关闭时清空；已追加的 entry 留在会话日志中，禁用不会删除。event.data 用 structuredClone 深拷贝，假定可克隆；展开时 JSON.stringify 假定可序列化。同一轮事件很多时内存和展开输出都会很大。开关不持久化，重载后默认关闭。entry.data 来自会话日志，渲染器虽检查缺失，但不验证 events 一定是数组。
/**
 * Raw provider event viewer.
 *
 * Usage: /debug-provider [on|off]
 * With no argument, the command toggles capture. Captured events are persisted
 * as expandable custom entries.
 */

// import type 只引入类型，编译后擦除；ExtensionAPI 用于标注扩展入口。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Box 提供背景/内边距容器，Text 绘制单行或多行文本；两者都是 pi-tui Component。
import { Box, Text } from "@earendil-works/pi-tui";

// 自定义 entry 的类型字符串与状态键；必须全局唯一，避免与其他扩展冲突。
const ENTRY_TYPE = "debug-provider-events";
// 状态键用于 ctx.ui.setStatus；清除时传 undefined，不会删除会话中的 entry。
const STATUS_KEY = "debug-provider";

// 一条调试记录：provider/api/model 标识来源，events 是该轮捕获的原始事件数组。
interface ProviderDebugEntry {
	provider: string;
	api: string;
	model: string;
	events: unknown[];
}

// 扩展入口：注册 entry 渲染器、命令和四个生命周期回调；加载时不捕获事件。
export default function (pi: ExtensionAPI) {
	// 关闭时 enabled=false；状态不持久化，扩展重载后重置。
	let enabled = false;
	// 当前轮次的事件缓冲；undefined 表示未捕获（关闭或已结束）。
	let activeEvents: unknown[] | undefined;
	// message_end 先暂存，turn_end 再追加；避免在一轮中间写多个 entry。
	let completedEntry: ProviderDebugEntry | undefined;

	// 注册自定义 entry 的渲染器；entry.data 是 appendEntry 时保存的 ProviderDebugEntry。
	pi.registerEntryRenderer<ProviderDebugEntry>(ENTRY_TYPE, (entry, { expanded, keyHint }, theme) => {
		// entry.data 可能缺失（旧记录/其他来源），先判断再访问。
		const data = entry.data;
		// 缺少数据时返回单行警告，不用空对象继续。
		if (!data) return new Text(theme.fg("warning", "[provider debug] Missing event data"), 0, 0);

		// Box(1,1,bgFn) 创建带内边距和背景的容器；bg 使用 customMessageBg 主题 token。
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		// 单数/复数只影响展示；events.length 假定 events 是数组。
		const count = `${data.events.length} event${data.events.length === 1 ? "" : "s"}`;
		// 未展开时显示 keyHint；keyHint 返回当前键位绑定对应的提示文字。
		const expandHint = expanded ? "" : ` (${keyHint("app.tools.expand", "to view events")})`;
		// addChild 把 Text 放入 Box；Box 负责布局。
		box.addChild(
			new Text(
				// 标题行包含 provider/model/api 和事件数；模板只做拼接，不执行事件内容。
				`${theme.fg("accent", "[provider debug]")} ${data.provider}/${data.model} (${data.api}) · ${count}${expandHint}`,
				0,
				0,
			),
		);
		// 展开时再序列化事件；大对象可能产生很长的输出。
		if (expanded) {
			// JSON.stringify 缩进 2；如果 events 含循环引用/BigInt，这里会抛错。
			box.addChild(new Text(JSON.stringify(data.events, null, 2), 0, 0));
		}
		// 返回 Box 作为整个 entry 的组件。
		return box;
	});

	// 命令切换捕获状态；无参数时翻转，on/off 显式设置。
	pi.registerCommand("debug-provider", {
		description: "Toggle capture of raw provider stream events",
		// args 是原始参数字符串；ctx 提供状态和通知 UI。
		handler: async (args, ctx) => {
			// 统一转小写去空白，接受 ON/Off 等写法；空串表示切换。
			const requestedState = args.trim().toLowerCase();
			// 只允许空串/on/off；其他值提示用法并结束。
			if (requestedState !== "" && requestedState !== "on" && requestedState !== "off") {
				ctx.ui.notify("Usage: /debug-provider [on|off]", "warning");
				return;
			}

			// 空串取反，否则按 on 布尔值设置；off 会得到 false。
			enabled = requestedState === "" ? !enabled : requestedState === "on";
			// 关闭时清空当前缓冲和待追加记录；已追加的 entry 不受影响。
			if (!enabled) {
				activeEvents = undefined;
				completedEntry = undefined;
			}
			// setStatus 用固定 key 更新状态栏；undefined 清除该 key。
			ctx.ui.setStatus(STATUS_KEY, enabled ? "provider debug" : undefined);
			// 通知最终状态；enabled 已更新。
			ctx.ui.notify(`Provider event capture ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	// 每轮开始重置缓冲；关闭时保持 undefined，避免记录。
	pi.on("turn_start", () => {
		// 新数组只在启用时创建；completedEntry 不在这里清空，正常顺序下 turn_end 已处理。
		activeEvents = enabled ? [] : undefined;
	});

	// provider_stream_event 是原始 provider 事件流；仅在启用且本轮有缓冲时记录。
	pi.on("provider_stream_event", (event) => {
		// structuredClone 深拷贝事件数据，避免后续 provider 复用对象影响记录；可选链在关闭时跳过。
		activeEvents?.push(structuredClone(event.data));
	});

	// message_end 在消息定稿后、持久化前触发；只处理 assistant，并用 activeEvents 判断是否在捕获。
	pi.on("message_end", (event) => {
		// role 判别联合收窄 message；没有 activeEvents 说明关闭或已处理。
		if (event.message.role !== "assistant" || !activeEvents) return;
		// 暂存来源信息和事件数组，等 turn_end 再写 entry。
		completedEntry = {
			provider: event.message.provider,
			api: event.message.api,
			model: event.message.model,
			events: activeEvents,
		};
		// activeEvents 置空，避免同轮后续 assistant 消息复用旧数组。
		activeEvents = undefined;
	});

	// 一轮结束才写入自定义 entry，保证一次调用对应一条记录。
	pi.on("turn_end", () => {
		// 没有完成记录（关闭/中止/非 assistant）就不追加。
		if (!completedEntry) return;
		// appendEntry 把自定义数据持久化到会话日志；泛型参数与 entry 类型匹配。
		pi.appendEntry<ProviderDebugEntry>(ENTRY_TYPE, completedEntry);
		// 清空待写记录；activeEvents 已在 message_end 清空。
		completedEntry = undefined;
	});
}
