// 将已有分支摘要显示成可点击折叠卡片；交互模式负责创建/重绘它，模型调用与会话持久化不在这里。
// 混合导入中，Box 等是运行时组件，type MarkdownTheme 只负责检查主题参数的结构。
import { Box, Container, Markdown, type MarkdownTheme, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
// type 导入只参与静态检查，编译后不会因这个导入加载业务模块。
import type { BranchSummaryMessage } from "../../../core/messages.ts";
// 默认 Markdown 主题在构造时取得，theme 着色调用读取当前全局主题。
import { getMarkdownTheme, theme } from "../theme/theme.ts";
// 快捷键文字来自配置，避免把固定键名写进提示。
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a branch summary message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
// extends 继承 Box 的布局/背景渲染；本类只把已有分支摘要变成可折叠界面，不生成或压缩模型消息。
export class BranchSummaryMessageComponent extends Box {
	// private 限制外部通过 TS 访问字段；初始折叠，类型由 false 推断为 boolean。
	private expanded = false;
	// 保存调用方传入的分支摘要对象引用；类型声明不复制或校验其内容。
	private message: BranchSummaryMessage;
	// Markdown 的颜色/样式函数集合，只影响显示。
	private markdownTheme: MarkdownTheme;

	// 创建分支摘要卡片：接收内容、可选 Markdown 主题和水平留白，保存引用并构建孩子。
	// 例：new BranchSummaryMessageComponent(message) 先显示折叠提示；不会读文件或请求模型，构建异常向上传播。
	constructor(message: BranchSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		// 先初始化父类：左右留白 outputPad、上下各 1 行，箭头回调在 Box 处理背景时读取当前主题。
		super(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		// 将形参存入实例；this 指当前卡片，不修改原分支摘要。
		this.message = message;
		// 记住传入主题；默认参数只在省略或传 undefined 时求值。
		this.markdownTheme = markdownTheme;
		// 按当前展开状态重新建立子组件；此调用本身不直接向终端写字。
		this.updateDisplay();
	}

	// 设置展开状态并重建显示，无返回值；例如 setExpanded(true) 展示全部正文，即使状态相同也重建。
	setExpanded(expanded: boolean): void {
		// 保存 boolean 状态；该值只控制界面，不改模型上下文。
		this.expanded = expanded;
		// 按当前展开状态重新建立子组件；此调用本身不直接向终端写字。
		this.updateDisplay();
	}

	// 修改水平留白，交给 Box 清除自身布局缓存；例如传 0 去掉左右边距，不在这里重建正文。
	setOutputPad(outputPad: number): void {
		// 调用父类方法设置左右各多少列留白；参数没有在此做有限数或范围检查。
		this.setPaddingX(outputPad);
	}

	// 使旧显示失效并重建主题相关文字；例如主题切换后由父级通知，override 表示重写父类同名方法。
	override invalidate(): void {
		// 父类先清自己的缓存，再递归通知现有孩子；返回后再用下方调用替换孩子。
		super.invalidate();
		// 按当前展开状态重新建立子组件；此调用本身不直接向终端写字。
		this.updateDisplay();
	}

	// 重建分支摘要的标题/正文及点击区域，结果保存在子组件树中，没有返回值。
	// 例：折叠→展开会用 Markdown 替换简短 Text；孩子构造或主题函数抛错会向上传播。
	private updateDisplay(): void {
		// 移除旧孩子并失效 Box 缓存；这里不负责对旧组件调用 dispose。
		this.clear();
		// 创建纵向容器，把标题、正文作为一个整体交给鼠标包装层。
		const content = new Container();

		// 用 ANSI 1/22 开启/关闭粗体，再套主题标签色；模板字面量仍只是显示字符串。
		const label = theme.fg("customMessageLabel", `\x1b[1m[branch]\x1b[22m`);
		// 标题 Text 的水平/垂直内边距都为 0，避免与外层 Box 重复留白。
		content.addChild(new Text(label, 0, 0));
		// 标题之后加 1 行空白，折叠和展开两种状态都有。
		content.addChild(new Spacer(1));

		// 根据实例状态选择完整正文或折叠提示，两个分支不会同时加入。
		if (this.expanded) {
			// 只为展开显示添加加粗标题及空行；摘要在进入组件前已由其他逻辑生成。
			const header = "**Branch Summary**\n\n";
			// 把接下来创建的 Markdown/Text 加入纵向内容；这里只建组件，实际换行排版发生在 render。
			content.addChild(
				// 将显示标题拼到已有摘要前，按 Markdown 排版；不改 message.summary 本身。
				new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
					// 正文着色回调，text: string 是参数类型，箭头右侧返回带 ANSI 前景色的文字。
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			// 把接下来创建的 Markdown/Text 加入纵向内容；这里只建组件，实际换行排版发生在 render。
			content.addChild(
				// 折叠时只显示简短提示；Text 不把提示解析成 Markdown。
				new Text(
					// 折叠提示前缀，+ 连接接下来的快捷键与结尾。
					theme.fg("customMessageText", "Branch summary (") +
						// 读取当前全局快捷键映射并弱化显示；仅生成提示，不在该组件绑定按键。
						theme.fg("dim", keyText("app.tools.expand")) +
						// 拼接提示后半段，保持各片段自己的主题色。
						theme.fg("customMessageText", " to expand)"),
					// 水平留白为 0，由外层 Box 提供左右边距。
					0,
					// 垂直留白为 0，不在提示自身再加上下空行。
					0,
				),
			);
		}

		// 将整个可点击区域作为本 Box 的孩子；Box 继续负责卡片背景及留白。
		this.addChild(
			// 包装原内容；MouseRegion 先向孩子分发事件，孩子未处理时才调用此兜底回调。
			new MouseRegion(content, (event) => {
				// 只处理左键 click；|| 表示任一条件成立即退出，undefined 表示本层未处理。
				if (event.type !== "click" || event.button !== "left") return undefined;
				// ! 反转展开状态并重建组件；点击行为不发送新的对话消息。
				this.setExpanded(!this.expanded);
				// 返回事件处理结果，由上层鼠标分发流程安排后续重绘；不在这里注册键盘快捷键。
				return { handled: true };
			}),
		);
	}
}
