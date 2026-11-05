// 将已有技能块显示成可点击折叠卡片；交互模式负责创建/重绘它，模型调用与会话持久化不在这里。
// 命名导入取得布局/文字组件；type MarkdownTheme 在编译后擦除，其余名称供运行时构造组件。
import { Box, Container, Markdown, type MarkdownTheme, MouseRegion, Text } from "@earendil-works/pi-tui";
// type 导入只参与静态检查，编译后不会因这个导入加载业务模块。
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
// 默认 Markdown 主题在构造时取得，theme 着色调用读取当前全局主题。
import { getMarkdownTheme, theme } from "../theme/theme.ts";
// 快捷键文字来自配置，避免把固定键名写进提示。
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a skill invocation message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 * Only renders the skill block itself - user message is rendered separately.
 */
// extends 继承 Box 的布局/背景渲染；本类只把已有技能块变成可折叠界面，不生成或压缩模型消息。
export class SkillInvocationMessageComponent extends Box {
	// private 限制外部通过 TS 访问字段；初始折叠，类型由 false 推断为 boolean。
	private expanded = false;
	// 保存调用方传入的技能块对象引用；类型声明不复制或校验其内容。
	private skillBlock: ParsedSkillBlock;
	// Markdown 的颜色/样式函数集合，只影响显示。
	private markdownTheme: MarkdownTheme;

	// 创建技能块卡片：接收内容、可选 Markdown 主题和水平留白，保存引用并构建孩子。
	// 例：new SkillInvocationMessageComponent(skillBlock) 先显示折叠提示；不会读文件或请求模型，构建异常向上传播。
	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		// 先初始化父类：左右留白 outputPad、上下各 1 行，箭头回调在 Box 处理背景时读取当前主题。
		super(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		// 将形参存入实例；this 指当前卡片，不修改原技能块。
		this.skillBlock = skillBlock;
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

	// 重建技能块的标题/正文及点击区域，结果保存在子组件树中，没有返回值。
	// 例：折叠→展开会用 Markdown 替换简短 Text；孩子构造或主题函数抛错会向上传播。
	private updateDisplay(): void {
		// 移除旧孩子并失效 Box 缓存；这里不负责对旧组件调用 dispose。
		this.clear();
		// 创建纵向容器，把标题、正文作为一个整体交给鼠标包装层。
		const content = new Container();

		// 根据实例状态选择完整正文或折叠提示，两个分支不会同时加入。
		if (this.expanded) {
			// Expanded: label + skill name header + full content
			// 展开时先构造粗体技能标签；ANSI 22 关闭粗体。
			const label = theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m`);
			// 标签不额外留白，交给外层 Box 处理卡片边距。
			content.addChild(new Text(label, 0, 0));
			// 将技能名直接插入 Markdown 加粗标题；这里没有转义名称中的 Markdown。
			const header = `**${this.skillBlock.name}**\n\n`;
			// 把接下来创建的 Markdown/Text 加入纵向内容；这里只建组件，实际换行排版发生在 render。
			content.addChild(
				// 展示已解析技能正文；本组件不根据 location 去磁盘加载 SKILL.md。
				new Markdown(header + this.skillBlock.content, 0, 0, this.markdownTheme, {
					// 正文着色回调，text: string 是参数类型，箭头右侧返回带 ANSI 前景色的文字。
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			// Collapsed: single line - [skill] name (hint to expand)
			// 折叠时将标签、名称、快捷键合成单行源文字，实际窄屏仍可能由 Text 换行。
			const line =
				// 第一段显示粗体标签与分隔空格。
				theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
				// 第二段只放技能名，不放技能正文或单独的用户请求。
				theme.fg("customMessageText", this.skillBlock.name) +
				// 末段读取可配置展开快捷键；模板插值只生成显示提示。
				theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
			// 加入折叠提示 Text，不重复绘制用户消息；调用方会另建用户消息组件。
			content.addChild(new Text(line, 0, 0));
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
