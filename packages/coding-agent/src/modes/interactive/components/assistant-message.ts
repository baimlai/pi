// 渲染助手正文与思考，复用流式 Markdown 缓存；展示折叠和错误状态，不执行工具或修改模型上下文。
// 只导入助手消息类型，编译后擦除，不在这里调用模型。
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	// 可绘制孩子的接口类型，只参与静态检查。
	type Component,
	// 纵向组织正文、思考和提示行的运行时容器。
	Container,
	// 有缓存的 Markdown 渲染组件，流式更新会尽量复用。
	Markdown,
	// Markdown 样式函数集合的类型。
	type MarkdownTheme,
	// 给思考块包一层点击处理，原内容排版仍由孩子负责。
	MouseRegion,
	// 输出指定数量空行。
	Spacer,
	// 展示普通文字/ANSI 样式，不解析 Markdown。
	Text,
} from "@earendil-works/pi-tui";
// 扩展显示转换器的签名；它不负责改发给模型的消息。
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
// 取得默认 Markdown 样式，并用当前主题给思考/错误文字着色。
import { getMarkdownTheme, theme } from "../theme/theme.ts";
// 为转换器补充消息类型、流式状态、宽度与可选条目元数据；失败的转换器不会中断其余转换。
import { createMarkdownTransform } from "./markdown-transform.ts";

// 终端 OSC 133 区域开始控制序列，不是可见文字。
const OSC133_ZONE_START = "\x1b]133;A\x07";
// 终端区域后续边界标记，效果由终端能力决定。
const OSC133_ZONE_END = "\x1b]133;B\x07";
// 和结束标记一起附到最后一行前的终结阶段控制序列。
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * A Markdown block of the last update. The next update reuses it at the same position for the same kind of content, so
 * a streamed answer keeps the blocks it already rendered, also once the stream ends.
 */
// interface 只描述缓存槽形状，不分配对象；槽按本次可见 Markdown 的顺序匹配，不按原内容块 ID 匹配。
interface MarkdownSlot {
	// 字面量联合区分正文/思考，只有种类相同才能复用旧槽。
	kind: "text" | "thinking";
	// 保留实际 Markdown 实例以便复用内部块/代码高亮缓存；其中弱引用缓存仍可能被垃圾回收。
	markdown: Markdown;
}

/**
 * Component that renders a complete assistant message
 */
// 交互模式在历史消息和流式增量时调用本组件；工具执行内容由其他组件独立展示。
export class AssistantMessageComponent extends Container {
	// 内部容器存正文、思考、间距及结束提示；外层仍负责统一接口。
	private contentContainer: Container;
	// 所有思考段的默认隐藏策略，不会删除原消息里的 thinking 内容。
	private hideThinkingBlock: boolean;
	// 创建 Markdown 时使用的主题对象。
	private markdownTheme: MarkdownTheme;
	// 思考隐藏时显示的提示文字；纯空白表示连提示也不显示。
	private hiddenThinkingLabel: string;
	// 正文/提示左右的列留白，构造 Markdown 时传入。
	private outputPad: number;
	// 只读数组类型限制本类改动列表，不冻结扩展函数或原数组。
	private markdownTransformers: readonly MarkdownTransformer[];
	// 保存最近更新的原消息引用，便于改设置或点击后重建；不是深拷贝快照。
	private lastMessage?: AssistantMessage;
	// 最近消息是否含 toolCall；决定是否由本组件加终端区域标记。
	private hasToolCalls = false;
	// 由 updateContent 的参数维护，初始 false；不靠 stopReason 自动推断。
	private isStreaming = false;
	// 可选持久化条目 ID，实时消息可能没有。
	private messageId?: string;
	// 可选条目时间戳，仅供显示转换上下文。
	private timestamp?: string;
	// 按非空连续思考段的本次序号覆盖隐藏策略；内容顺序变化时编号可能对应不同段。
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	// 保存上次可见 Markdown 的槽位，折叠成 Text 的思考段不占槽。
	private markdownSlots: MarkdownSlot[] = [];

	// 创建助手显示组件，接收可选消息及思考/主题/留白/转换器设置；先建容器，有消息再填内容。
	// 例：new AssistantMessageComponent(message,true) 初始隐藏思考；未传消息则先留空，随后用 updateContent 更新。异常向上传播。
	constructor(
		// ? 表示可以先不传消息，适合流式开始前建立组件。
		message?: AssistantMessage,
		// 默认显示思考，类型由默认值推断为 boolean。
		hideThinkingBlock = false,
		// 默认主题仅在省略/undefined 时获取。
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		// 隐藏时默认提示；空字符串可让隐藏思考完全不占显示空间。
		hiddenThinkingLabel = "Thinking...",
		// 左右默认各留 1 列，不在此验证数字范围。
		outputPad = 1,
		// 默认没有显示转换器；后续原样保存列表引用。
		markdownTransformers: readonly MarkdownTransformer[] = [],
		// 可选日志条目 ID，透传给 Markdown 转换器。
		messageId?: string,
		// 可选时间戳，同样只作上下文。
		timestamp?: string,
	) {
		// 初始化父容器后才能访问 this。
		super();

		// 保存默认思考隐藏策略。
		this.hideThinkingBlock = hideThinkingBlock;
		// 保存样式对象引用。
		this.markdownTheme = markdownTheme;
		// 保存折叠提示正文，不在此做 trim。
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		// 记录当前留白，供之后创建显示块使用。
		this.outputPad = outputPad;
		// 保存扩展转换链，不立即调用。
		this.markdownTransformers = markdownTransformers;
		// 保存可选 ID。
		this.messageId = messageId;
		// 保存可选时间戳。
		this.timestamp = timestamp;

		// Container for text/thinking content
		// 建立内部纵向内容容器；重建时只清它，不替换外层组件。
		this.contentContainer = new Container();
		// 将内部容器注册为外层唯一孩子。
		this.addChild(this.contentContainer);

		// 只有传入初始消息才构建内容；不会自动设成流式模式。
		if (message) {
			// 使用当前 isStreaming 默认值更新；初次构造时为 false。
			this.updateContent(message);
		}
	}

	// 让缓存失效并按最近消息重建；例主题切换后刷新，无返回值，未收到消息时只通知孩子。
	override invalidate(): void {
		// 先让旧子组件清缓存；override 表明本方法重写父类接口。
		super.invalidate();
		// 存在最近消息才有可重建的内容。
		if (this.lastMessage) {
			// 重建显示并保留当前流式标志，不请求新模型回复。
			this.updateContent(this.lastMessage);
		}
	}

	// 改变全局思考显示策略，清空逐段点击覆盖并重建；例传 true 将各段恢复为隐藏默认。
	setHideThinkingBlock(hide: boolean): void {
		// 保存新的默认策略。
		this.hideThinkingBlock = hide;
		// 用户先前单独展开/隐藏的选择全部重置。
		this.thinkingVisibilityOverrides.clear();
		// 存在最近消息才有可重建的内容。
		if (this.lastMessage) {
			// 重建显示并保留当前流式标志，不请求新模型回复。
			this.updateContent(this.lastMessage);
		}
	}

	// 更新隐藏思考提示并按最近消息重建；例传空串使隐藏段不占空行，无返回值。
	setHiddenThinkingLabel(label: string): void {
		// 保存新提示；是否为空白在 updateContent 的隐藏分支判断。
		this.hiddenThinkingLabel = label;
		// 存在最近消息才有可重建的内容。
		if (this.lastMessage) {
			// 重建显示并保留当前流式标志，不请求新模型回复。
			this.updateContent(this.lastMessage);
		}
	}

	// 更新水平留白并丢弃旧 Markdown 槽，再重建；例从 1 改到 2 需新建带该内边距的 Markdown。
	setOutputPad(padding: number): void {
		// 先保存新留白，无取值检查。
		this.outputPad = padding;
		// Markdown takes its padding at construction.
		// 换成新空数组；重置时丢弃旧槽，普通 updateContent 时则先保存旧数组以供复用。
		this.markdownSlots = [];
		// 存在最近消息才有可重建的内容。
		if (this.lastMessage) {
			// 重建显示并保留当前流式标志，不请求新模型回复。
			this.updateContent(this.lastMessage);
		}
	}

	// 按列宽渲染行，纯文字助手消息附终端区域标记；有工具调用则跳过标记，由外部整体展示处理。
	// 例：正文一行时首尾控制序列都在该行，不多加可见行，渲染异常向上传播。
	override render(width: number): string[] {
		// 父容器新建汇总数组，避免下面的首尾修改写回 Markdown 缓存。
		const lines = super.render(width);
		// 工具消息或没有任何行时不加区域标记；|| 任一成立即可。
		if (this.hasToolCalls || lines.length === 0) {
			// 原样返回这次汇总行。
			return lines;
		}

		// 给首行加区域开始控制序列。
		lines[0] = OSC133_ZONE_START + lines[0];
		// 给末行加两个区域控制序列；窄屏换行不影响它们位于首尾行。
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		// 把显示结果交给 TUI，不直接写 stdout。
		return lines;
	}

	// 更新完整消息显示：保留引用/流式状态→清容器并尝试复用 Markdown→顺序排正文/思考→追加结束提示。
	// 例：先 updateContent(partial,true)，流结束后 updateContent(final,false)；省略第二参会沿用旧状态，并不自动结束流式。
	// 本方法不改原 content，也不执行 toolCall；新建/样式等异常会传播，无返回值。
	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		// 保存最近对象引用，设置或点击变化时重新使用它。
		this.lastMessage = message;
		// 保存宿主明确传入或默认沿用的流式状态。
		this.isStreaming = isStreaming;

		// Clear content container
		// 移除旧布局孩子；可复用 Markdown 仍由旧槽数组保存。
		this.contentContainer.clear();
		// 保留上次槽数组引用，用下方新数组长度作为匹配位置。
		const previousSlots = this.markdownSlots;
		// 换成新空数组；重置时丢弃旧槽，普通 updateContent 时则先保存旧数组以供复用。
		this.markdownSlots = [];
		// 局部工厂接收种类、文字和延迟创建函数，返回可复用 Markdown；MarkdownSlot["kind"] 是索引访问类型。
		// 例：第二次更新的首个 "text" 可复用上次首个正文槽；会更新实例文字和槽数组，创建回调异常向上传播。
		const markdownBlock = (kind: MarkdownSlot["kind"], text: string, create: () => Markdown): Markdown => {
			// 取当前第几个可见 Markdown 对应的旧槽，不按消息原数组索引匹配。
			const slot = previousSlots[this.markdownSlots.length];
			// ?. 允许缺槽；同种类复用，否则才调用 create，避免每次流更新都新建。
			const markdown = slot?.kind === kind ? slot.markdown : create();
			// 即使文字相同也更新并失效整次渲染缓存，保留内部块缓存；因此流结束后的显示转换会再执行。
			markdown.setText(text);
			// 属性简写记录本次使用的实例，下一次更新继续匹配。
			this.markdownSlots.push({ kind, markdown });
			// 把实例交给布局逻辑，创建工厂不会额外包一层容器。
			return markdown;
		};

		// Spacers are added lazily, right before the next visible content block. This puts a blank
		// line before the first visible block and after each visible thinking run that is followed
		// by more visible content, while hidden thinking runs without a label contribute nothing.
		// 延迟添加空行：第一段可见内容前需要，连续普通正文之间不自动重置。
		let needsSpacer = true;
		// 局部回调把可见块加入容器，必要时先放空行；捕获并修改外层 needsSpacer。
		// 例：首个正文前加空行，紧邻的第二正文不再加；只修改孩子列表/间距标志，没有返回值。
		const addVisibleChild = (child: Component) => {
			// 只有前一阶段要求间隔时才创建 Spacer，完全隐藏的思考不会触发本函数。
			if (needsSpacer) {
				// 为接下来这个可见正文或思考块加 1 行前置间距。
				this.contentContainer.addChild(new Spacer(1));
				// 消费这次间隔要求，避免紧接的正文重复留白。
				needsSpacer = false;
			}
			// 将实际可见组件排在间距之后。
			this.contentContainer.addChild(child);
		};

		// Render content in order
		// 非空连续思考段从 0 编号，用于逐段点击覆盖；不等于原 content 的索引。
		let thinkingRunIndex = 0;
		// 按内容顺序遍历；思考分支会自行推进 i 合并连续块。
		for (let i = 0; i < message.content.length; i++) {
			// 取当前块，后续用 type 标签让 TS 收窄为 text 或 thinking。
			const content = message.content[i];
			// 只有文本类型且去空白后非空才显示；&& 短路后 text 字段才可安全读取。
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				// 移除显示正文首尾空白，不修改原块 text。
				const text = content.text.trim();
				// 将处理后的内容纳入有间距规则的显示布局。
				addVisibleChild(
					// 取得同位置同类旧实例，或调用下面的构造回调。
					markdownBlock(
						// 槽类型为普通正文。
						"text",
						// 传入已 trim 的显示内容。
						text,
						// 延迟创建箭头函数，仅无法复用时才真正构造 Markdown。
						() =>
							// 正文水平留白按设置，垂直 0，不额外指定背景样式；最后一个对象是 Markdown 选项。
							new Markdown(text, this.outputPad, 0, this.markdownTheme, undefined, {
								// 把扩展转换挂到 Markdown 的渲染阶段，不把转换后的文字写回消息。
								transform: createMarkdownTransform(
									// 上下文标记此块为助手正文。
									"assistant",
									// 每次转换时读取最新实例字段，复用旧 Markdown 也能看到流结束。
									() => this.isStreaming,
									// 提供顺序执行的显示转换器列表。
									this.markdownTransformers,
									// 传可选持久化条目 ID。
									this.messageId,
									// 传可选条目时间戳。
									this.timestamp,
								),
							}),
					),
				);
				// 思考分支会把紧邻的 thinking 块合成一个可展开区域；toolCall 等其他类型在此循环不直接显示。
			} else if (content.type === "thinking") {
				// 显式 string[] 收集当前连续段里非空思考文字。
				const thinkingBlocks: string[] = [];
				// 省略 for 初始化项，沿用外层 i，向前扫描全部相邻思考块。
				for (; i < message.content.length; i++) {
					// 取扫描到的块，不能假设连续后面的块仍是 thinking。
					const thinkingContent = message.content[i];
					// 遇到正文或工具块便结束当前思考段。
					if (thinkingContent.type !== "thinking") {
						// 保留 i 指向第一个非思考块，下面会回退给外层处理。
						break;
					}
					// 去掉该思考块首尾空白，只影响显示字符串。
					const thinking = thinkingContent.thinking.trim();
					// 空白块不加入合并列表。
					if (thinking) {
						// 追加非空思考正文，保持块原有顺序。
						thinkingBlocks.push(thinking);
					}
				}
				// 抵消外层循环即将执行的 i++，避免跳过第一个非思考块。
				i--;

				// 连续段全为空白就不创建区域，也不消耗思考段编号。
				if (thinkingBlocks.length === 0) {
					// 跳过当前段，继续外层内容循环；不添加间距或提示。
					continue;
				}

				// 取当前段编号后递增，点击回调闭包保留本段编号。
				const runIndex = thinkingRunIndex++;
				// ?? 只在没有逐段选择时取全局默认，false 的明确覆盖也会保留。
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				// A hidden run with an empty label renders nothing, including no spacing.
				// 隐藏且提示为空白时完全不显示该段；不会预先加入空白占位。
				if (hidden && !this.hiddenThinkingLabel.trim()) {
					// 跳过当前段，继续外层内容循环；不添加间距或提示。
					continue;
				}
				// 连续非空思考块之间加两个换行形成段落。
				const thinking = thinkingBlocks.join("\n\n");
				// 三元表达式选择短提示 Text 或可复用的完整思考 Markdown。
				const thinkingComponent = hidden
					? // 隐藏提示使用思考色和斜体；水平按设置，垂直不留白。
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0)
					: // 只有展开状态才占用本次 Markdown 槽，隐藏 Text 不参与槽复用。
						markdownBlock(
							// 标记槽为思考，不能复用同位置的普通正文实例。
							"thinking",
							// 合并后的整段思考正文。
							thinking,
							// 仅缺少可复用思考槽时创建新 Markdown。
							() =>
								// 构造完整思考正文，传样式对象和独立转换器上下文。
								new Markdown(
									// 要排版的合并文字。
									thinking,
									// 水平留白与普通助手正文一致。
									this.outputPad,
									// 垂直留白为 0，段间距由 needsSpacer 管理。
									0,
									// 使用当前保存的 Markdown 主题。
									this.markdownTheme,
									{
										// 给思考普通文字套主题思考色。
										color: (text: string) => theme.fg("thinkingText", text),
										// 默认使用斜体样式。
										italic: true,
									},
									{
										// 思考显示也允许扩展转换，但与正文使用不同 messageType。
										transform: createMarkdownTransform(
											// 明确此处是助手思考，而非最终回复正文。
											"assistant-thinking",
											// 每次转换读取最新流式状态，而不是创建时的一份布尔值。
											() => this.isStreaming,
											// 使用同一批扩展转换器，由它们依据 messageType 决定处理方式。
											this.markdownTransformers,
											// 透传可选条目 ID。
											this.messageId,
											// 透传可选时间戳。
											this.timestamp,
										),
									},
								),
						);
				// 将思考提示或完整思考正文纳入相同的间距规则。
				addVisibleChild(
					// 为本段提示或正文包点击处理；孩子若已处理鼠标事件则本兜底不执行。
					new MouseRegion(thinkingComponent, (event) => {
						// 仅左键单击切换，其他事件表示未处理。
						if (event.type !== "click" || event.button !== "left") return undefined;
						// 把本次段的隐藏状态反转并写入覆盖 Map，不改变全局默认。
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						// 按最近消息重建，让覆盖立即反映到组件树。
						if (this.lastMessage) this.updateContent(this.lastMessage);
						// 通知鼠标分发器事件已处理，后续由宿主安排重绘。
						return { handled: true };
					}),
				);
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				// 只有遇到下一块可见内容才真正添加空行，末尾工具执行前不会凭空留一行。
				needsSpacer = true;
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		// some 检查任意块是否为工具调用；不要求工具已执行完，也不在这里执行。
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		// 存给 render 决定是否添加 OSC 区域标记。
		this.hasToolCalls = hasToolCalls;
		// 长度截断无论是否含工具调用都显示，工具参数尚未完整时也需提醒。
		if (message.stopReason === "length") {
			// 结束提示前明确加 1 行，不依赖正文 needsSpacer 状态。
			this.contentContainer.addChild(new Spacer(1));
			// 将长度截断提示加入部分正文之后。
			this.contentContainer.addChild(
				// 用错误色提示回复未完成；该组件只展示，不自动续写或重试。
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
			// 非长度原因仅在没有 toolCall 时由此处显示错误；工具执行组件负责工具相关中止/错误。
		} else if (!hasToolCalls) {
			// 展示外部中止后的提示，不丢掉已显示的部分正文。
			if (message.stopReason === "aborted") {
				// 优先使用更具体的中止原因，否则换成人类可读默认提示。
				const abortMessage =
					// 非空且不是通用 Request was aborted 时保留原原因。
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? // 三元表达式真分支使用原始错误文字。
							message.errorMessage
						: // 缺少具体原因时使用默认中止提示。
							"Operation aborted";
				// 中止或失败提示之前加 1 行间距。
				this.contentContainer.addChild(new Spacer(1));
				// 加入中止原因 Text，采用当前水平留白。
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
				// 普通错误分支；成功结束不加这类提示。
			} else if (message.stopReason === "error") {
				// || 对空串等假值使用默认未知错误提示。
				const errorMsg = message.errorMessage || "Unknown error";
				// 中止或失败提示之前加 1 行间距。
				this.contentContainer.addChild(new Spacer(1));
				// 拼接 Error 前缀并显示原因，原消息字段保持不变。
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
