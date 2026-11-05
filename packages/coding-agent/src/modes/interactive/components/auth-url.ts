// 登录用的链接组件：显示授权URL、点击说明和复制结果；login-dialog/MCP管理页负责把复制快捷键转给copy()。构造不打开浏览器，点击是否打开由终端支持决定。
import { Container, hyperlink, Text, type TUI } from "@earendil-works/pi-tui";
// 剪贴板helper可能调用平台命令或输出终端OSC52；这里只保存函数引用，copy时才有这些副作用。
import { copyToClipboard } from "../../../utils/clipboard.ts";
// 共享theme用于生成ANSI颜色，keyHint按当前配置格式化动作键名。
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

/**
 * A sign-in URL with a click hint and a copy hint. Hosts call `copy()` when `app.message.copy` is
 * pressed, since a long URL wraps and often cannot be selected or clicked as a whole (SSH, tmux).
 */
// 继承Container的子组件布局；URL展示和提示分别为Text，不自行读取授权回调/换token。
export class AuthUrlComponent extends Container {
	// 公开只读URL字段：readonly约束TS中重赋，不会校验URL是否合法或可访问。
	readonly url: string;
	// 终端宿主用于安排重画，private只是TS访问约束。
	private readonly tui: TUI;
	// 可更新的提示Text引用；readonly不禁止调用setText改变其内部文字。
	private readonly hint: Text;

	// 创建URL行和提示行，保存宿主/URL并初始化提示；例传长授权URL会由Text折行。构造会requestRender，但不复制或访问URL，样式/布局回调错误传播。
	constructor(tui: TUI, url: string) {
		// 继承类先super构造Container，之后才能访问this。
		super();
		// 保存TUI引用，供异步复制后刷新提示。
		this.tui = tui;
		// 保存原URL，不在这里规范化、过滤控制字符或限制协议；调用方需决定可展示输入。
		this.url = url;
		// hyperlink把同一URL作为显示文本和终端链接目标，accent着色；1/0为水平/垂直留白。
		this.addChild(new Text(theme.fg("accent", hyperlink(url, url)), 1, 0));
		// 先建空提示，稍后setHint填入；Text原文空白时不占行。
		this.hint = new Text("", 1, 0);
		// 将同一提示实例接到布局，后面更新它即可显示新结果。
		this.addChild(this.hint);
		// 初始显示可配置复制动作键；setHint还会附平台点击说明并请求重画。
		this.setHint(keyHint("app.message.copy", "to copy"));
	}

	// 更新提示后缀并请求重画，返回void；例复制成功后缀换成成功文字，点击链接仍指向原URL。不会验证终端支持点击，样式/重画异常可抛出。
	private setHint(suffix: string): void {
		// macOS提示Cmd点击，其他平台提示Ctrl点击；三元只选择文案，不注册鼠标事件。
		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		// 点击提示本身也包装成指向原URL的终端链接；后缀原样拼接已着色文字。
		this.hint.setText(`${theme.fg("dim", hyperlink(clickHint, this.url))} ${theme.fg("dim", "•")} ${suffix}`);
		// 安排后续TUI重画，不在此同步绘制整个屏幕。
		this.tui.requestRender();
	}

	// 异步复制原URL，成功/失败都更新提示，返回Promise<void>；例剪贴板命令拒绝后显示原因。try也包含成功提示，若错误提示本身再抛错，Promise仍可拒绝；并发复制没有结果序号保护。
	async copy(): Promise<void> {
		// 将复制和成功提示的异常一起捕获，不只包操作系统命令。
		try {
			// await实际复制helper；helper正常完成后才显示成功，不代表所有剪贴板实现都已验证内容。
			await copyToClipboard(this.url);
			// 成功色提示会替换初始快捷键说明，仍保留点击链接提示。
			this.setHint(theme.fg("success", "Copied URL to clipboard"));
			// 未知异常进入这里，具体可能是复制失败或上面的样式/重画失败。
		} catch (error) {
			// instanceof后读Error.message，其余String；没有自动脱敏，setHint若抛错不再捕获。
			this.setHint(theme.fg("error", error instanceof Error ? error.message : String(error)));
		}
	}
}
