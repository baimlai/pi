// 把用户文字渲染为带背景的 Markdown，并给终端附上消息区域标记；扩展转换只改变显示，不改模型消息。
// Container 纵向拼接孩子，Markdown 负责排版；type MarkdownTheme 仅用于类型检查。
import { Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
// 转换器类型描述同步显示转换，不会因类型导入而运行扩展。
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
// 取得默认 Markdown 样式及当前主题着色能力。
import { getMarkdownTheme, theme } from "../theme/theme.ts";
// 创建带消息类型、宽度及流式状态的转换回调；转换器抛错时 helper 保留当前文字继续。
import { createMarkdownTransform } from "./markdown-transform.ts";

// OSC 133 A 为终端区域开始标记，ESC 与 BEL 是控制字符，不是可见正文。
const OSC133_ZONE_START = "\x1b]133;A\x07";
// 区域后续边界标记；实际导航/选择效果取决于终端支持。
const OSC133_ZONE_END = "\x1b]133;B\x07";
// 终结阶段标记，与上面的结束标记一起加到最后一行前。
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
// 继承容器布局；组件不接收键盘输入或发送用户请求，交互模式负责这些动作。
export class UserMessageComponent extends Container {
	// 保存原始显示文字，private 只限制 TS 访问，不是运行时加密或深冻结。
	private text: string;
	// 保存创建 Markdown 时使用的样式对象。
	private markdownTheme: MarkdownTheme;
	// 左右各留多少列，由外层输出设置传入。
	private outputPad: number;
	// readonly 数组类型禁止通过此类型增删转换器；并未复制或冻结原数组。
	private markdownTransformers: readonly MarkdownTransformer[];
	// ? 允许没有持久化条目 ID，实时消息常未提供。
	private messageId?: string;
	// 可选时间戳仅供转换器上下文，不在此解析或生成时间。
	private timestamp?: string;

	// 创建显示组件，接收正文、主题/留白/转换器及可选条目标识，保存后立即建立 Markdown 孩子。
	// 例：new UserMessageComponent("你好") 使用默认主题和左右 1 列留白；构建错误向上传播，不写会话。
	constructor(
		// 必填字符串正文；TS 类型不会在运行时把任意输入转成字符串。
		text: string,
		// 省略或 undefined 时调用主题工厂；不是每次 render 都重新获取该对象。
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		// 默认水平留白 1，类型推断为 number。
		outputPad = 1,
		// 默认没有扩展转换器；只读视图防止组件通过本类型修改数组。
		markdownTransformers: readonly MarkdownTransformer[] = [],
		// 可选持久化 ID，透传给显示转换器。
		messageId?: string,
		// 可选时间戳，作为上下文透传。
		timestamp?: string,
	) {
		// 先初始化父类孩子列表，再访问 this。
		super();
		// 保留原始正文，用于以后因留白变化而重建。
		this.text = text;
		// 保存样式引用，不在此克隆。
		this.markdownTheme = markdownTheme;
		// 保存当前水平留白。
		this.outputPad = outputPad;
		// 保存转换器列表引用，后面按其顺序执行。
		this.markdownTransformers = markdownTransformers;
		// 记录可选消息 ID；未提供就保留 undefined。
		this.messageId = messageId;
		// 记录可选时间戳，不修改其格式。
		this.timestamp = timestamp;
		// 以当前正文/设置重新创建子组件；不请求模型或直接写终端。
		this.rebuild();
	}

	// 更新左右留白并重建 Markdown，例传 0 使正文贴近内容区边缘；无返回值，不校验取值范围。
	setOutputPad(padding: number): void {
		// 先更新字段，让重建采用新值。
		this.outputPad = padding;
		// 以当前正文/设置重新创建子组件；不请求模型或直接写终端。
		this.rebuild();
	}

	// 移除旧显示并创建一个自行处理背景/留白的 Markdown；例留白改变后以原文重新排版。异常向上传播。
	private rebuild(): void {
		// 清空父容器孩子；不对旧 Markdown 执行额外 dispose。
		this.clear();
		// The Markdown pads and colors its own background: a Box around it would keep a second full-width copy of every
		// line, with identical output.
		// 将单个 Markdown 加入容器，不再套一份保存整行背景的 Box。
		this.addChild(
			// 构造器顺序为正文、水平留白、垂直留白、主题、默认样式和选项。
			new Markdown(
				// 把保存的原文交给 Markdown，不把显示转换结果写回原文。
				this.text,
				// 使用当前设置的左右留白。
				this.outputPad,
				// 上下各留 1 行，用户消息之间形成视觉间隔。
				1,
				// 正文 Markdown 语法样式由该主题对象负责。
				this.markdownTheme,
				{
					// 未被更具体 Markdown 样式覆盖的文字使用用户消息前景色。
					color: (content: string) => theme.fg("userMessageText", content),
					// 渲染行由 Markdown 自己套用户背景色；箭头函数返回着色字符串。
					bgColor: (content: string) => theme.bg("userMessageBg", content),
				},
				{
					// 有序列表保留用户写的数字标记，避免显示层统一重编号。
					preserveOrderedListMarkers: true,
					// 保留反斜杠转义的原始表达方式，是显示解析选项，不会改会话原文。
					preserveBackslashEscapes: true,
					// 建立延迟显示转换函数，实际渲染时收到正文和可用宽度。
					transform: createMarkdownTransform(
						// 告诉转换器当前是用户消息。
						"user",
						// 用户消息始终按非流式显示，回调每次调用都返回 false。
						() => false,
						// 扩展转换器按数组顺序处理前一个转换器的结果。
						this.markdownTransformers,
						// 提供持久化 ID，实时显示时可为 undefined。
						this.messageId,
						// 提供原时间戳供扩展使用，不在此补当前时间。
						this.timestamp,
					),
				},
			),
		);
	}

	// 按给定列宽渲染并附终端区域标记，返回行数组，不直接写终端；例如一行消息会在同一行附开始和结束标记。
	override render(width: number): string[] {
		// Container 新建汇总数组收集孩子行；下方修改汇总数组不会在 Markdown 缓存行上累计标记。
		const lines = super.render(width);
		// 无可绘制行时不访问首尾，避免生成 undefined 字样。
		if (lines.length === 0) {
			// 空数组原样返回。
			return lines;
		}

		// 将开始控制序列拼到首行前，不增加一行可见文字。
		lines[0] = OSC133_ZONE_START + lines[0];
		// 将两段结束控制序列拼到最后一行前；单行时仍保留刚加入的开始标记。
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		// 返回本次汇总的显示行，交给 TUI 绘制。
		return lines;
	}
}
