/**
 * 登录交互面板：宿主执行真正的 API key/OAuth 登录，本类显示链接/设备码/进度，并把用户输入包装成 Promise 交回宿主。
 * 例设备码画面只展示短码和验证网址，确认一次后才尝试复制短码/打开浏览器；轮询与凭证保存不在这个组件中。
 * 一份 Input 配一组 resolver/rejecter 槽，不支持并发等待多个输入；signal 用于合作取消，不代表浏览器、已发复制或所有后台工作立即终止。
 * URL 展示/链接目标有专门处理，但普通说明、代码、用户输入不都走同样的清理；显示文本和真实认证完成必须区分。
 */
// 认证信息链接/兼容设备码都是数据接口，type 导入不运行认证、轮询或 token 兑换。
import type { AuthInfoLink, OAuthDeviceCodeInfo } from "@earendil-works/pi-ai";
// TUI 提供组合布局、输入、文字与超链接工具；type 项在运行代码中擦除。
import {
	// Container 组合子组件，键盘路由仍由本类实现。
	Container,
	// Focusable 要求 focused 字段，下面向实际 Input 透传。
	type Focusable,
	// 读取当前动作绑定，不把所有键固定成回车/Escape。
	getKeybindings,
	// hyperlink 只包 OSC8 控制串，不验证或打开 URL；本文件的 webLink 先限制网页目标，AuthUrl 子组件另有自己的包装行为。
	hyperlink,
	// Input 保存一份可复用文字/编辑状态，不是带密码遮罩的专用控件。
	Input,
	// 替换每段 C0/C1 控制字符为空格，不会把所有外来文本变成通用安全格式。
	replaceControlCharacters,
	// Spacer 是空行布局。
	Spacer,
	// Text 可折行，左右/上下内边距由后两个参数决定。
	Text,
	// TruncatedText 给设备动作提示保留单行，不把长说明扩成多行。
	TruncatedText,
	// TUI 只作为刷新宿主的类型，不在构造这里创建一个新终端。
	type TUI,
} from "@earendil-works/pi-tui";
// 异步复制 helper 有真实剪贴板/终端副作用，只在用户复制动作触发后调用。
import { copyToClipboard } from "../../../utils/clipboard.ts";
// 平台启动器只发起默认处理器打开，不等待浏览器或认证结果；本类限制它的输入为 http(s)。
import { openBrowser } from "../../../utils/open-browser.ts";
// 共享主题对象生成 ANSI 样式，不保留独立主题快照。
import { theme } from "../theme/theme.ts";
// 授权 URL 子组件显示链接及复制提示，copy() 的异步结果由该子组件更新。
import { AuthUrlComponent } from "./auth-url.ts";
// 上下边框依当前主题显示。
import { DynamicBorder } from "./dynamic-border.ts";
// 帮助键名随配置动作显示，不等于注册这些按键。
import { keyHint } from "./keybinding-hints.ts";

/**
 * The `http:` or `https:` URL `value` names, normalized, or undefined. The shared launcher also opens files and custom
 * protocols, so login only opens web URLs. Normalizing percent-encodes control characters, which would otherwise end a
 * terminal hyperlink early.
 */
// webUrl 接文字、按标准 URL 解析并只保留 http(s)，返回规范 href 或 undefined，无访问目标副作用；例如 file:///tmp/a 被拒作浏览器目标，不检查 https 站点是否可信或存在。
function webUrl(value: string): string | undefined {
	// URL.canParse 无 base，所以普通相对路径不通过；不能解析就返回 undefined。
	if (!URL.canParse(value)) return undefined;
	// 创建 URL 对象，得到协议/规范化 href；这是 URL 语法处理，不是网络请求。
	const url = new URL(value);
	// 只接受这两种协议；使用规范 href 作为后续目标，不直接转交原字符串。
	return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
}

/**
 * `value` normalized as a web URL, else with control characters replaced: an untrusted string printed as is could end a
 * hyperlink early or send its own escape sequences to the terminal.
 */
// displayUrl 先取可用 web href，否则替换原串控制字符，返回展示文字，无打开动作；例如非网页带 ESC 的文字会留下可见其余部分，不解析整段 ANSI 意图。
function displayUrl(value: string): string {
	// ?? 只在 webUrl 为 undefined 时执行右侧清理；网页则采用 URL 的规范序列化，不等同对任意展示字段全局清理。
	return webUrl(value) ?? replaceControlCharacters(value);
}

/** `text` as a terminal hyperlink to `url` when that is a web URL, else plain `text`. */
// webLink 为网页目标包超链接，其他原样返回 text，无打开/认证；例如 text=Help、url=https://example.com 得终端可点击文字。text 本身未在此清控制字符。
function webLink(text: string, url: string): string {
	// 独立规范目标 URL，不凭显示文字猜地址。
	const target = webUrl(url);
	// 没网页目标就返回原 text，有目标才调用 hyperlink；终端是否支持点击由终端决定。
	return target === undefined ? text : hyperlink(text, target);
}

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
// 面板兼有布局和焦点接口，但没有认证实现/公开成功结算方法；宿主 await modelRuntime.login 决定成功，这里的 onComplete 主要用于取消通知。
export class LoginDialogComponent extends Container implements Focusable {
	// 动态内容区域，链接/提示/输入等都加在其中。
	private contentContainer: Container;
	// 同一个 Input 会被多个顺序提示复用，不创建每步独立输入框。
	private input: Input;
	// 原 TUI 宿主用于请求刷新，不负责本类保存凭证。
	private tui: TUI;
	/** The shown sign-in URL, which `app.message.copy` copies. */
	// 当前授权链接子组件可缺省，copy 动作仅在此引用存在时转交；从布局清除一个组件不一定自动清此字段。
	private authUrl?: AuthUrlComponent;
	// 每个面板新建取消控制器，取消后不重置；它只发 signal，不自动终止所有外部副作用。
	private abortController = new AbortController();
	// 当前输入 Promise 的 resolve 函数，可缺；后一个 prompt 会覆盖这个槽，不排队多个等待输入。
	private inputResolver?: (value: string) => void;
	// 同一当前输入 Promise 的 reject 槽，取消时用于拒绝，不保存任意历史提示的 rejecter。
	private inputRejecter?: (error: Error) => void;
	// 设备码待确认动作及对应提示容器；清除此槽后重复确认不会再次启动同一动作。
	private deviceCodeAction?: { info: OAuthDeviceCodeInfo; hint: Container };
	// 保留设备码提示容器引用，动作发起后仍可把提示改成异步结果。
	private deviceCodeHint?: Container;
	// 外部取消/完成通知的函数类型，可选 message；组件不以它代替真实登录 Promise 的结果。
	private onComplete: (success: boolean, message?: string) => void;

	// Focusable implementation - propagate to input for IME cursor positioning
	// 内部焦点初始 false，设备码确认还会检查它。
	private _focused = false;
	// focused getter 只读本组件标记，例如未聚焦时可拒设备确认，不自行检查终端当前编辑器。
	get focused(): boolean {
		// 返回保存字段。
		return this._focused;
	}
	// focused setter 同步更新内部 Input 的光标状态，返回隐式 void；切焦点不会自行取消输入 Promise 或复制任务。
	set focused(value: boolean) {
		// 保存外层焦点布尔。
		this._focused = value;
		// 透传给同一个输入框，不新增 DOM/终端输入监听。
		this.input.focused = value;
	}

	// 构造接宿主、供应商 id、完成通知和可选名字/标题，保存引用→建边框标题/内容区→建 Input 回调，返回新组件；不启动浏览器或登录。例 api_key 流程也可复用此面板。
	constructor(
		// 用于 requestRender 的外部 TUI 实例。
		tui: TUI,
		// 用于默认标题的供应商 id，不直接定位或执行认证 handler。
		providerId: string,
		// 外部结果通知，构造只是保存；实际登录宿主通常传空回调并从登录 Promise 处理结果。
		onComplete: (success: boolean, message?: string) => void,
		// 可选显示名字，空字符串也会因 || 回退 id。
		providerNameOverride?: string,
		// 可选整个标题，空字符串因 ?? 被保留，和上一个参数回退规则不同。
		titleOverride?: string,
	) {
		// 派生类先 super() 初始化布局树。
		super();
		// 保存宿主引用。
		this.tui = tui;
		// 保存外部通知函数，不立即执行。
		this.onComplete = onComplete;

		// 用 || 选显示名，undefined/空字符串都会改用 id。
		const providerName = providerNameOverride || providerId;
		// 用 ?? 选标题，只有 null/undefined 才生成 Login to 名字。
		const title = titleOverride ?? `Login to ${providerName}`;

		// Top border
		// 顶部边框加入父布局。
		this.addChild(new DynamicBorder());

		// Title
		// 标题先粗体再 accent 色，Text 水平留1列、垂直0行。
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		// Dynamic content area
		// 新建动态内容容器，与标题/边框分离。
		this.contentContainer = new Container();
		// 接入父布局，之后 showAuth 等方法只清这个区域。
		this.addChild(this.contentContainer);

		// Input (always present, used when needed)
		// 创建 Input 对象但此时尚未加到可见内容区，只有等待输入时才出现。
		this.input = new Input();
		// 输入框提交回调检查当前 resolver，空闲输入不会自动完成登录。
		this.input.onSubmit = () => {
			// 有等待输入的 Promise 才处理当前文本。
			if (this.inputResolver) {
				// 取完整输入值，不 trim、不在此做授权码/API key 格式校验。
				const value = this.input.getValue();
				// 把可见 Input 替换成已提交文字，不使用密码遮罩；本类不会自动隐藏 secret 类型内容。
				this.replaceInputWithSubmittedText(value);
				// resolve 当前 Promise，后续认证由等待它的宿主/handler 继续。
				this.inputResolver(value);
				// 清 resolve 槽，后续重复提交不再响应这一轮。
				this.inputResolver = undefined;
				// 同步清 reject 槽，取消时不会再拒已提交 Promise。
				this.inputRejecter = undefined;
			}
		};
		// Input 自身识别取消键时也调用面板取消，正常外层先消费取消键。
		this.input.onEscape = () => {
			// 复用取消流程，不直接关闭 TUI。
			this.cancel();
		};

		// Bottom border
		// 最后加底边框；Input 尚未展示也能构成面板外壳。
		this.addChild(new DynamicBorder());
	}

	// signal getter 返回同一个控制器的信号，无新建/取消；例如宿主传它给 modelRuntime.login 合作响应用户取消。
	get signal(): AbortSignal {
		// 直接暴露只读信号，不暴露 abortController 的 abort 方法。
		return this.abortController.signal;
	}

	// replaceInputWithSubmittedText 遍历动态区子组件，把所有身份等于当前 Input 的条目换成新 Text，返回 void；例如提交 abc 后显示 > abc，不清原 Input 的 value/撤销状态或触发刷新。
	private replaceInputWithSubmittedText(value: string): void {
		// map 创建新 children 数组，不对整个父 Container 清屏。
		this.contentContainer.children = this.contentContainer.children.map((child) =>
			// 按对象引用比较，不是按内容；新 Text 左右/上下均0，用户输入原样插入，不保证可安全隐藏秘密或控制字符。
			child === this.input ? new Text(`> ${value}`, 0, 0) : child,
		);
	}

	// clearDeviceCodeAction 移除当前设备提示并清两引用，返回 void；例如转入普通授权 URL 时旧确认动作消失。不清 authUrl/输入等待，也不能撤回已经开始的复制。
	private clearDeviceCodeAction(): void {
		// 有设备提示容器才尝试从动态区移除。
		if (this.deviceCodeHint) {
			// removeChild 按引用移首项，找不到无操作，不 dispose 外部任务。
			this.contentContainer.removeChild(this.deviceCodeHint);
		}
		// 清提示引用，迟到复制仍捕获旧 hint，但后面状态更新会检查当前布局。
		this.deviceCodeHint = undefined;
		// 清待确认动作引用，后续回车不再重触发它。
		this.deviceCodeAction = undefined;
	}

	// cancel 清设备动作→abort 信号→拒当前等待输入并清槽→通知外部失败，返回 void；例如待输入时 Escape 使该 Promise 拒 Login cancelled。无重复完成锁，不保证关浏览器/停复制或拒所有被覆盖的旧 Promise。
	private cancel(): void {
		// 先移掉设备提示与确认槽。
		this.clearDeviceCodeAction();
		// AbortController.abort 发取消信号，真正认证后端必须合作观察；控制器之后保持 aborted。
		this.abortController.abort();
		// 有当前等待输入才主动 reject；没有就只发 signal 和外部通知。
		if (this.inputRejecter) {
			// 拒绝当前输入 Promise，用新 Error 给宿主识别取消，不直接从本行同步 throw 此 Error。
			this.inputRejecter(new Error("Login cancelled"));
			// 清 resolve 槽，取消后不再接这轮提交。
			this.inputResolver = undefined;
			// 清 reject 槽，重复 cancel 不再拒同一等待输入。
			this.inputRejecter = undefined;
		}
		// 同步通知外部失败；重复 cancel 仍可重复调用，外部回调异常不在此捕获。
		this.onComplete(false, "Login cancelled");
	}

	/**
	 * Called by onAuth callback - show URL and optional instructions
	 */
	// showAuth 清设备动作/动态区→规范 URL→建可复制链接/说明→尝试开网页→请求重画，返回 void；例如 https 链接自动发起浏览器打开，不等用户设备码确认。
	// 非网页 URL 只清控制符后显示，不发启动请求；普通 instructions 未统一清理。未清输入 resolver，openBrowser 同步异常也未在此 catch，不能把换画面视为所有旧等待结束。
	showAuth(url: string, instructions?: string): void {
		// 清旧设备操作，不清等待输入槽。
		this.clearDeviceCodeAction();
		// 只清动态子组件，不改顶部标题或 abort 信号。
		this.contentContainer.clear();
		// 新内容首行空白。
		this.contentContainer.addChild(new Spacer(1));
		// 先确认是否为可用 http(s) 目标，语法规范化不访问网址。
		const target = webUrl(url);
		// 网页用规范 href，非网页用控制符替换后的文字；AuthUrl 仍会包装所给字符串为终端链接并提供复制，不等于所有非网页点击都被禁止。
		this.authUrl = new AuthUrlComponent(this.tui, target ?? replaceControlCharacters(url));
		// 保存并加入同一链接组件，handleInput 的复制键后面使用它。
		this.contentContainer.addChild(this.authUrl);

		// 说明为真值才展示，空字符串不占额外说明行。
		if (instructions) {
			// 链接与说明之间空一行。
			this.contentContainer.addChild(new Spacer(1));
			// warning 色显示原 instructions，未调用 URL 专用清理器。
			this.contentContainer.addChild(new Text(theme.fg("warning", instructions), 1, 0));
		}

		// 只有规范网页目标才交系统启动器；异步启动失败由 helper 忽略，可能的同步参数错误在本方法不额外捕获。
		if (target !== undefined) openBrowser(target);
		// 安排重绘；前面若同步抛错，此行不会执行，已改组件树不回滚。
		this.tui.requestRender();
	}

	/**
	 * Called by onDeviceCode callback - show URL and user code.
	 */
	// showDeviceCode 显示验证 URL/短码并可安装一次性确认动作，无返回；先清授权复制入口、补默认动作选项、换内容并建提示，不在此轮询或保存凭证。例如显示后仍需确认才发浏览器/复制请求。
	// 只使用 userCode/verificationUri/两个确认开关，不把 intervalSeconds/expiresInSeconds 实现为倒计时或过期判断；也未清已有输入 resolver，后者存在时会挡设备确认。
	showDeviceCode(info: OAuthDeviceCodeInfo): void {
		// 设备码画面不再使用旧授权 URL 的复制快捷键入口。
		this.authUrl = undefined;
		// 对参数局部变量赋新对象，不直接写调用方 info 对象。
		info = {
			// 先浅展开全部原字段，其他兼容字段仍保留但未在本类消费。
			...info,
			// ?? 默认允许确认后开浏览器，显式 false 保留。
			openBrowserOnConfirm: info.openBrowserOnConfirm ?? true,
			// 默认允许确认后复制短码，显式 false 保留。
			copyCodeOnConfirm: info.copyCodeOnConfirm ?? true,
		};
		// 移除上一轮设备提示/确认动作。
		this.clearDeviceCodeAction();
		// 清旧动态内容，等待输入槽本身不在这个容器里，未被 clear 解决。
		this.contentContainer.clear();
		// 新内容前留空行。
		this.contentContainer.addChild(new Spacer(1));
		// 验证地址先用 URL 展示专用处理，不能直接把任意 ESC 插到终端目标里。
		const shownUrl = displayUrl(info.verificationUri);
		// 显示规范/清理后地址并为可识别网页包终端链接；不在这里自动调用 openBrowser。
		this.contentContainer.addChild(new Text(theme.fg("accent", webLink(shownUrl, shownUrl)), 1, 0));

		// macOS 提示 Cmd 点击，其他 Ctrl 点击，只是文案，不注册鼠标动作。
		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		// 点击提示关联原验证 URI 的规范网页目标，非法/非网页时退为普通提示文字。
		this.contentContainer.addChild(new Text(theme.fg("dim", webLink(clickHint, info.verificationUri)), 1, 0));
		// 地址与短码之间空一行。
		this.contentContainer.addChild(new Spacer(1));
		// 短码按原 userCode 显示，未做格式校验或控制符替换；不把设备端秘密 device_code 存在这里。
		this.contentContainer.addChild(new Text(theme.fg("warning", `Enter code: ${info.userCode}`), 1, 0));

		// 只有尚未取消且至少开一种便利动作时才安装确认入口，展示 URL/短码本身不依赖此条件。
		if (!this.signal.aborted && (info.openBrowserOnConfirm || info.copyCodeOnConfirm)) {
			// 决定确认提示的操作描述，多行嵌套三元在后面给出四种组合中的三种有效组合。
			const actionLabel = info.openBrowserOnConfirm
				? // 有开浏览器动作时再看是否同时复制。
					info.copyCodeOnConfirm
					? // 两者都启用，说明打开并复制。
						"to open browser and copy code"
					: // 仅开浏览器，不复制。
						"to open browser"
				: // 仅复制，不开浏览器；两项都 false 时外层已跳过。
					"to copy code";
			// Reuse this single row for progress/result text, including in narrow terminals.
			// 新提示容器把进度/结果固定在同一位置，后面异步闭包捕获它。
			const hint = new Container();
			// 显示配置确认键，单行截断防窄屏折成多行提示。
			hint.addChild(new TruncatedText(`(${keyHint("tui.select.confirm", actionLabel)})`, 1, 0));
			// 将提示接入当前动态区域，后续状态更新检查是否仍在此布局。
			this.contentContainer.addChild(hint);
			// 保存提示引用，以便切步骤时移除。
			this.deviceCodeHint = hint;
			// 保存含 info/hint 的一次性待确认动作，不立刻复制/启动浏览器。
			this.deviceCodeAction = { info, hint };
		}
		// 请求重绘，哪怕两种便利动作都关闭仍要显示地址和短码。
		this.tui.requestRender();
	}

	// setDeviceCodeStatus 尝试用一条新文字替换指定设备提示，返回 void；例如复制完成才显示 Code copied。已取消、失焦或 hint 已移除就忽略，不检查一个独立登录成功状态。
	private setDeviceCodeStatus(hint: Container, message: string): void {
		// 三项保护迟到回调：signal、当前焦点、hint 对象是否仍在当前动态区；失焦时丢弃这次更新，之后回焦不会自动补回。
		if (this.signal.aborted || !this.focused || !this.contentContainer.children.includes(hint)) return;
		// 替换该 hint 的全部子组件为一个 dim 单行文字，不改短码/等待轮询的其他行。
		hint.children = [new TruncatedText(theme.fg("dim", message), 1, 0)];
		// 只在保护通过时通知重画。
		this.tui.requestRender();
	}

	// activateDeviceCode 先更新提示，复制 Promise 后台处理，同时尽力开网页，返回 void；例如复制失败显示手动复制而浏览器仍可启动，不等待复制才继续认证轮询。
	// 浏览器分支包同步 try/catch，复制结果链不阻塞；首次提示更新异常可同步抛出，Promise 提示链也可再拒绝，不保证整段无异常或撤回已发副作用。
	private activateDeviceCode(info: OAuthDeviceCodeInfo, hint: Container): void {
		// 先设复制中或浏览器已请求文案，这不是操作成功证明；状态 helper 可能因失焦等忽略。
		this.setDeviceCodeStatus(hint, info.copyCodeOnConfirm ? "Copying code..." : "Browser open requested");
		// 只在复制开关为真时发起真实剪贴板 helper。
		if (info.copyCodeOnConfirm) {
			// Do not delay polling or browser opening while clipboard tools are running.
			// void 只丢弃 Promise 返回值，不表示取消/等待/吞掉所有后续异常。
			void copyToClipboard(info.userCode)
				// 复制完成时尝试更新同一旧 hint，保护条件决定画面是否还能改变。
				.then(() => this.setDeviceCodeStatus(hint, "Code copied to clipboard"))
				// 复制或前一个成功提示回调拒绝时尝试显示手动复制；错误提示自身再抛错不会在此再兜底。
				.catch(() => this.setDeviceCodeStatus(hint, "Copy code manually"));
		}
		// 浏览器开关独立于复制，前面只是启动 Promise 链，没有 await。
		if (info.openBrowserOnConfirm) {
			// 只将启动目标处理/启动调用的同步错误放进 try。
			try {
				// 再次确认 verificationUri 为规范网页，非网页则不打开。
				const target = webUrl(info.verificationUri);
				// 发起平台启动，不等待网页就绪或认证完成。
				if (target !== undefined) openBrowser(target);
				// 此 catch 不包括浏览器真正页面加载后的错误，也不包前面的复制 Promise 链。
			} catch {
				// Launcher failures must not interrupt login.
			}
		}
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	// showManualInput 追加提示/复用 Input，返回等待提交或取消的 Promise<string>；例如先前授权 URL 保留，用户贴回调地址。它只清设备动作、不清整个区或 authUrl，也不排队多个并发 prompt。
	showManualInput(prompt: string): Promise<string> {
		// 旧设备确认入口清掉，避免回车同时触发便利动作。
		this.clearDeviceCodeAction();
		// 清可见输入值；Input.setValue 不清所有撤销/粘贴状态或把光标移到末尾。
		this.input.setValue("");
		// 提示前留空行。
		this.contentContainer.addChild(new Spacer(1));
		// 原 prompt 以 dim 文字显示，未作 URL/秘密专用处理。
		this.contentContainer.addChild(new Text(theme.fg("dim", prompt), 1, 0));
		// 把同一个输入框对象加到动态区；重入调用可能再次添加同引用。
		this.contentContainer.addChild(this.input);
		// 加取消提示，不是自动注册另一取消监听器。
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		// 先请求刷新，再创建下面等待 Promise；真实渲染由宿主调度。
		this.tui.requestRender();

		// Promise executor 同步运行，当前函数返回等待用户输入的 Promise，不阻塞 JS 线程。
		return new Promise((resolve, reject) => {
			// 本轮 resolve 覆盖槽内旧函数，旧的未完成 Promise 不在此自动拒绝。
			this.inputResolver = resolve;
			// 本轮 reject 也覆盖旧槽，用于之后 cancel。
			this.inputRejecter = reject;
		});
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input
	 * Note: Does NOT clear content, appends to existing (preserves URL from showAuth)
	 */
	// showPrompt 追加消息/可选示例/同一 Input，返回用户文字 Promise，无清除已有授权 URL；例如输入 API key 仍是普通明文 Input，没有 secret 参数自动遮罩，也不在此保存凭证。
	showPrompt(message: string, placeholder?: string): Promise<string> {
		// 清设备提示/动作，但不解决旧输入 Promise。
		this.clearDeviceCodeAction();
		// 消息前加空行，已有 URL/说明保留。
		this.contentContainer.addChild(new Spacer(1));
		// 原 message 用 text 色显示，不清控制字符。
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		// placeholder 为真值才显示例子，空串不显示。
		if (placeholder) {
			// 把 placeholder 作为“e.g.”说明，不设置 Input 的占位属性或默认值。
			this.contentContainer.addChild(new Text(theme.fg("dim", `e.g., ${placeholder}`), 1, 0));
		}
		// 复用输入框加入可见内容，不为每个 prompt 建新组件。
		this.contentContainer.addChild(this.input);
		// 追加取消/提交操作帮助。
		this.contentContainer.addChild(
			// 帮助由单个 Text 展示，可按宽度折行。
			new Text(
				// 两种动作名从当前键位取得，只是帮助字符串。
				`(${keyHint("tui.select.cancel", "to cancel,")} ${keyHint("tui.select.confirm", "to submit")})`,
				// 帮助水平留1列。
				1,
				// 上下留0行。
				0,
			),
		);

		// 清输入值但不全面重置编辑历史；认证格式由收到结果的后端检查。
		this.input.setValue("");
		// 请求下一轮绘制，不在此 await 绘制完成。
		this.tui.requestRender();

		// 创建本轮等待 Promise，executor 立即写下面两个槽。
		return new Promise((resolve, reject) => {
			// 保存最新 resolve，旧未完成 prompt 不自动结算。
			this.inputResolver = resolve;
			// 保存最新 reject，取消只直接拒这一轮。
			this.inputRejecter = reject;
		});
	}

	/** Show informational text before another login step. */
	// showDetails 清授权复制入口/设备动作/动态区，再逐行显示原说明并请求刷新，返回 void；例如认证前展示支持的 AWS 凭证来源，不打开链接或清输入 resolver。
	showDetails(lines: string[]): void {
		// 清旧 AuthUrl 引用，快捷复制不再路由到它。
		this.authUrl = undefined;
		// 移掉旧设备确认提示和动作槽。
		this.clearDeviceCodeAction();
		// 清动态布局，不重置 Input 值或 Promise 等待槽。
		this.contentContainer.clear();
		// 说明前留空行。
		this.contentContainer.addChild(new Spacer(1));
		// 按输入数组顺序显示每段原文。
		for (const line of lines) {
			// 每段建 Text，若原文本身有换行/过长仍可多行；未在这里替换控制字符。
			this.contentContainer.addChild(new Text(line, 1, 0));
		}
		// 请求重绘，不表示真实认证已经启动。
		this.tui.requestRender();
	}

	/** Show provider-owned information and links without starting an auth callback flow. */
	// showInfo 追加普通消息/可选链接/可选关闭提示并刷新，返回 void；例如环境认证说明可附 Docs 链接。与 showDetails 不同，它不清旧内容/authUrl/设备动作/输入等待，亦不启动认证回调流程。
	showInfo(message: string, links: readonly AuthInfoLink[] = [], showCloseHint = false): void {
		// 在已有内容后加空行，不 clear。
		this.contentContainer.addChild(new Spacer(1));
		// 消息原文着普通色，不自动脱敏。
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		// 按 readonly 链接数组遍历，readonly 不冻结对象或证明 URL 可信。
		for (const link of links) {
			// 单独规范/清理链接 URL 的展示文字。
			const url = displayUrl(link.url);
			// label 真值才加前缀，label 原文未做同样控制符清理；空 label 仅显示地址。
			const text = link.label ? `${link.label}: ${url}` : url;
			// 对可识别网页包超链接，点击打开由终端处理，不在本方法调用 openBrowser。
			this.contentContainer.addChild(new Text(theme.fg("accent", webLink(text, url)), 1, 0));
		}
		// 调用方要求时才展示关闭帮助，缺省 false 不加。
		if (showCloseHint) {
			// 关闭提示前空一行。
			this.contentContainer.addChild(new Spacer(1));
			// 显示配置取消键，按它会经本面板 cancel，不创建独立成功关闭状态。
			this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to close")})`, 1, 0));
		}
		// 刷新整个对话框。
		this.tui.requestRender();
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	// showWaiting 追加等待文字与取消帮助，返回 void 并请求刷新；例如显示 Waiting for authentication，不在此轮询、定时或保证下一步完成，旧设备确认可继续存在。
	showWaiting(message: string): void {
		// 在已有内容后加一空行。
		this.contentContainer.addChild(new Spacer(1));
		// 原等待文字用 dim 色，未替换成实际进度计量。
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		// 取消提示随配置绑定，不主动取消。
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		// 安排重画，不等待认证 Promise。
		this.tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	// showProgress 追加一段原进度文字并刷新，无返回/轮询；例如后端 notify 传 Waiting... 即增一条 Text，不改已有输入等待或清掉旧进度。
	showProgress(message: string): void {
		// 新 Text 加到末尾，长消息可折行，没有此方法内的条数保留上限。
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		// 通知宿主重画。
		this.tui.requestRender();
	}

	// handleInput 优先取消→授权链接复制→一次性设备动作→Input，返回 void；例如当前显示设备码且有焦点/无输入等待，确认消费动作一次。无真实认证成功判断，异步 copy 不 await。
	handleInput(data: string): void {
		// 每次读取当前动作键位，包括应用级复制绑定。
		const kb = getKeybindings();

		// 配置取消键优先消费，即使同时可能匹配复制/确认也先取消。
		if (kb.matches(data, "tui.select.cancel")) {
			// 清动作、发取消信号、拒当前输入并通知外部。
			this.cancel();
			// 不再把取消键传给 Input。
			return;
		}
		// 有 AuthUrl 引用且匹配复制动作才调用其 copy；此分支不检查 aborted/focused，取消后若宿主仍路由输入也可能复制，手动输入画面还可保留该入口。
		if (this.authUrl && kb.matches(data, "app.message.copy")) {
			// 后台复制授权 URL；AuthUrl 自己更新提示，void 不额外兜底其提示阶段的异常。
			void this.authUrl.copy();
			// 复制键不进入输入文字或触发设备码复制。
			return;
		}

		// 以下多项同时满足才消费设备确认，&& 按顺序短路。
		if (
			// 必须仍有待确认设备动作。
			this.deviceCodeAction &&
			// 不能同时正在等普通输入；即便 Input 已从内容区消失，其 resolver 仍可能存在。
			!this.inputResolver &&
			// 取消后的信号禁止此便利动作，但不是对下面所有 Input 方法做全局禁用。
			!this.signal.aborted &&
			// 只在当前组件 focused 标记为 true 时允许。
			this.focused &&
			// 最后需匹配配置确认动作，不额外以字面 LF 在此触发设备动作。
			kb.matches(data, "tui.select.confirm")
		) {
			// 捕获本次动作信息/提示容器，清槽后仍可用于下面发起操作。
			const action = this.deviceCodeAction;
			// Consume once so a repeated Enter cannot launch multiple browsers or clipboard writes.
			// 先清动作槽防重复回车重发；后续同步失败也不自动恢复这一槽。
			this.deviceCodeAction = undefined;
			// 发起复制/开浏览器，并后台更新同一提示容器。
			this.activateDeviceCode(action.info, action.hint);
			// 额外请求重绘，不等复制/浏览器完成。
			this.tui.requestRender();
			// 本次确认不再传给 Input。
			return;
		}

		// Pass to input
		// 未消费的键交给复用 Input，即使它此时未显示；无 resolver 时提交不会完成登录，但编辑值仍可能变化。
		this.input.handleInput(data);
	}
}
