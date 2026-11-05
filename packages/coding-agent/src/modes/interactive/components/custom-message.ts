// 展示扩展自定义消息：优先使用扩展组件，缺失/失败则回退文字卡片；是否 display 的筛选由调用方处理。
// 文本内容块类型，用于 filter 的类型谓词；不会因导入而调用模型。
import type { TextContent } from "@earendil-works/pi-ai";
// 扩展只需返回符合 Component 接口的对象，类型导入在执行时擦除。
import type { Component } from "@earendil-works/pi-tui";
// 运行时布局组件和仅编译期的 MarkdownTheme 混合命名导入。
import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
// 消息渲染器接收消息、展开/留白/快捷键选项与主题，返回组件或 undefined。
import type { MessageRenderer } from "../../../core/extensions/types.ts";
// 消息 content 可为字符串或内容块数组；unknown 详情不会在这里自动验证。
import type { CustomMessage } from "../../../core/messages.ts";
// 默认 Markdown 样式供普通文字卡片使用，theme 供运行时着色及扩展读取。
import { getMarkdownTheme, theme } from "../theme/theme.ts";
// 提供配置感知的快捷键提示能力给扩展。
import { keyHint, keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
// 容器统一添加消息间距；扩展可以返回完全自行设计的组件，不强制套默认背景。
export class CustomMessageComponent extends Container {
	// 保存消息对象引用；details 业务结构未知，不在显示层作 schema 验证。
	private message: CustomMessage<unknown>;
	// 可选扩展回调，没有就直接使用默认文字卡片。
	private customRenderer?: MessageRenderer;
	// 可复用的默认卡片；使用扩展组件时从孩子列表移除，但保留实例。
	private box: Box;
	// 当前扩展返回的显示对象，可不存在。
	private customComponent?: Component;
	// 默认卡片中 Markdown 使用的主题。
	private markdownTheme: MarkdownTheme;
	// 展开状态只交给扩展；默认卡片没有折叠正文的逻辑。
	private _expanded = false;
	// 当前水平留白，同时提供给扩展选项与默认卡片。
	private outputPad: number;

	// 创建消息组件，保存输入后加一行间距、建立备用 Box 并尝试渲染。
	// 例：消息的 customType 为 "note"、content 为 "hi" 且未提供 renderer 时，显示标签和 Markdown；回调异常会静默回退。
	constructor(
		// 必填消息，泛型 unknown 要求使用 details 前自行收窄其结构。
		message: CustomMessage<unknown>,
		// 可省略扩展渲染函数；? 表示也允许 undefined。
		customRenderer?: MessageRenderer,
		// 默认样式仅用于此组件自行渲染的正文。
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		// 默认左右各 1 列。
		outputPad = 1,
	) {
		// 初始化父类后才能使用 this。
		super();
		// 保存原消息，不复制/改变它的 display 或 content。
		this.message = message;
		// 保存可选回调引用。
		this.customRenderer = customRenderer;
		// 保存默认文字主题。
		this.markdownTheme = markdownTheme;
		// 记录当前留白。
		this.outputPad = outputPad;

		// 消息前的这一个空行始终保留，后续 rebuild 不清空整个容器。
		this.addChild(new Spacer(1));

		// Create box with purple background (used for default rendering)
		// 先建默认 Box；真正使用时 rebuild 会用 outputPad 覆盖最初水平值 1。
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		// 尝试扩展渲染，必要时创建默认正文；本函数不主动请求 TUI 重绘。
		this.rebuild();
	}

	// 状态改变才重调渲染器；例如展开详情，默认卡片仍显示全部文字，无返回值。
	setExpanded(expanded: boolean): void {
		// 相同状态不重建，避免重复调用扩展。
		if (this._expanded !== expanded) {
			// 保存状态后，rebuild 将其放进扩展选项。
			this._expanded = expanded;
			// 用更新后的设置替换当前内容。
			this.rebuild();
		}
	}

	// 更新水平留白，数值变化才重建；扩展也会收到新值，是否采用由它决定。
	setOutputPad(outputPad: number): void {
		// 比较新旧设置，不在此验证数字范围。
		if (this.outputPad !== outputPad) {
			// 先保存数值，随后 renderer 或默认 Box 都读该字段。
			this.outputPad = outputPad;
			// 用更新后的设置替换当前内容。
			this.rebuild();
		}
	}

	// 旧孩子失效后重调渲染器/默认渲染；例如主题变化后刷新，无返回值，孩子 invalidate 异常仍传播。
	override invalidate(): void {
		// 先让当前孩子清缓存；这不是销毁组件。
		super.invalidate();
		// 尝试扩展渲染，必要时创建默认正文；本函数不主动请求 TUI 重绘。
		this.rebuild();
	}

	// 移除旧内容→优先调用扩展→有组件就返回，否则用 Box 展示文本。
	// 例：扩展返回 undefined 或同步抛错会退回默认样式；未来组件 render 抛错不由这里捕获。
	private rebuild(): void {
		// Remove previous content component
		// 若上次使用扩展组件，先从孩子列表摘掉。
		if (this.customComponent) {
			// 删除引用但不调用旧组件 dispose；资源管理不能依赖本方法自动清理。
			this.removeChild(this.customComponent);
			// 重置扩展显示状态，避免回退时还引用旧对象。
			this.customComponent = undefined;
		}
		// 默认 Box 可能原本不在列表；先移除，避免重复添加。
		this.removeChild(this.box);

		// Try custom renderer first - it handles its own styling
		// 只有注册回调时才尝试扩展分支。
		if (this.customRenderer) {
			// 把扩展同步调用作为异常边界；失败不显示单独错误卡片。
			try {
				// 实际调用扩展，由它决定样式和内容。
				const component = this.customRenderer(
					// 传原消息引用；组件自身不会替扩展克隆 details。
					this.message,
					// 选项对象包含展开、留白和当前宿主快捷键提示函数。
					{ expanded: this._expanded, outputPad: this.outputPad, keyText, keyHint },
					// 传当前主题对象，使自定义组件自行着色。
					theme,
				);
				// 返回实际组件时采用扩展结果；undefined 则继续默认分支。
				if (component) {
					// Custom renderer provides its own styled component
					// 记录以便下次重建时移除。
					this.customComponent = component;
					// 直接加入父容器，不额外套默认 Box。
					this.addChild(component);
					// 扩展已接管显示，本次不构建默认文字卡片。
					return;
				}
				// 忽略扩展同步异常并继续默认显示；catch 不绑定错误变量。
			} catch {
				// Fall through to default rendering
			}
		}

		// Default rendering uses our box
		// 将备用 Box 放回消息间距之后。
		this.addChild(this.box);
		// 清除旧默认标签/正文，防止重复堆积。
		this.box.clear();
		// 按当前设置更新默认卡片左右留白。
		this.box.setPaddingX(this.outputPad);

		// Default rendering: label + content
		// 显示粗体类别标签；customType 直接插入，未在此过滤 ANSI 或其他字符。
		const label = theme.fg("customMessageLabel", `\x1b[1m[${this.message.customType}]\x1b[22m`);
		// 标签无额外内边距。
		this.box.addChild(new Text(label, 0, 0));
		// 标签与正文之间留 1 行。
		this.box.addChild(new Spacer(1));

		// Extract text content
		// 两条内容分支最终都产生字符串，let 允许稍后赋值。
		let text: string;
		// 运行时区分类型中允许的字符串/数组两种表现，不是完整消息验证。
		if (typeof this.message.content === "string") {
			// 直接使用字符串正文。
			text = this.message.content;
		} else {
			// 数组分支只提取文本块，图片不会被此默认渲染器绘制。
			text = this.message.content
				// 类型谓词让 filter 结果收窄成 TextContent[]；实际筛选条件只是 type 等于 text。
				.filter((c): c is TextContent => c.type === "text")
				// 逐块取 text，生成字符串数组。
				.map((c) => c.text)
				// 用换行连接多个文本块，不保留图片位置。
				.join("\n");
		}

		// 将新正文作为默认卡片孩子加入。
		this.box.addChild(
			// 正文无独立内边距，统一采用 Box 的留白和背景。
			new Markdown(text, 0, 0, this.markdownTheme, {
				// 普通正文使用自定义消息前景色；没有经过用户/助手的 MarkdownTransformer 链。
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}
}
