// 提供测试共享的选择列表、Markdown 和编辑器主题；只构造 ANSI 包装函数，导入本文件不会写终端或启动 TUI。
/**
 * Default themes for TUI tests using chalk
 */

// Chalk 是可独立配置的运行时构造器，不使用默认实例的自动颜色探测结果。
import { Chalk } from "chalk";
// type 导入三个接口，编译期核对字段/回调；不会创建主题验证器或渲染组件。
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "../src/index.ts";

// 显式颜色级别3表示 truecolor 能力，确保这些测试主题输出样式控制码；不证明宿主真实终端支持该能力。
const chalk = new Chalk({ level: 3 });

// 选择菜单主题对象，所有回调输入文字、返回带样式的新串，无 I/O；例 selectedText("a") 返回粗体包装，回调异常会交给调用者。
export const defaultSelectListTheme: SelectListTheme = {
	// 前缀蓝色函数；接口需要此字段，但当前 SelectList 绘制把前缀和正文一起交 selectedText，没有调用 selectedPrefix。
	selectedPrefix: (text: string) => chalk.blue(text),
	// 选中整行用粗体，不是更改文本内容或配置系统字体。
	selectedText: (text: string) => chalk.bold(text),
	// 未选中行的说明用 dim 弱化强度，chalk.dim 不是独立前景色。
	description: (text: string) => chalk.dim(text),
	// 菜单滚动页码信息也用 dim。
	scrollInfo: (text: string) => chalk.dim(text),
	// 无匹配提示用相同的弱化样式。
	noMatch: (text: string) => chalk.dim(text),
};

// Markdown 各语法的主题函数表，输入文字→包装样式→返回字符串；可组合样式，不在这里做 Markdown 解析、折行或高亮代码词法分析。
export const defaultMarkdownTheme: MarkdownTheme = {
	// 链式 bold.cyan 同时用粗体与青色包装标题。
	heading: (text: string) => chalk.bold.cyan(text),
	// 链接可见文字用蓝色，不在这里生成 OSC8 链接地址。
	link: (text: string) => chalk.blue(text),
	// 额外显示的 URL 用 dim，是否显示 URL 由 Markdown 渲染逻辑决定。
	linkUrl: (text: string) => chalk.dim(text),
	// 行内代码文字用黄色。
	code: (text: string) => chalk.yellow(text),
	// 代码块内容默认用绿色，不会调用外部高亮器。
	codeBlock: (text: string) => chalk.green(text),
	// 代码块围栏/边界提示弱化。
	codeBlockBorder: (text: string) => chalk.dim(text),
	// 引用正文包装为斜体。
	quote: (text: string) => chalk.italic(text),
	// 引用的竖线边界弱化，和正文斜体分开。
	quoteBorder: (text: string) => chalk.dim(text),
	// 水平分隔线弱化，不在这里创建分隔线文本。
	hr: (text: string) => chalk.dim(text),
	// 列表项目符号用青色，列表结构由调用方构建。
	listBullet: (text: string) => chalk.cyan(text),
	// Markdown 粗体语法对应 Chalk 粗体包装。
	bold: (text: string) => chalk.bold(text),
	// Markdown 斜体语法对应 Chalk 斜体包装。
	italic: (text: string) => chalk.italic(text),
	// 删除线语法包装为 SGR 删除线。
	strikethrough: (text: string) => chalk.strikethrough(text),
	// 下划线包装，跨行关闭/恢复由换行渲染器处理。
	underline: (text: string) => chalk.underline(text),
};

// 编辑器主题复用上面的选择列表对象，只有边框函数与菜单主题两字段；类型注解不冻结对象，例候选菜单可直接用共享 selectList。
export const defaultEditorTheme: EditorTheme = {
	// 编辑边框用 dim，不会绘制或改变边框几何。
	borderColor: (text: string) => chalk.dim(text),
	// 保存同一个主题对象引用，不拷贝其中函数。
	selectList: defaultSelectListTheme,
};
