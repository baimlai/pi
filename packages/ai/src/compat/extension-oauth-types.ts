// 旧coding-agent扩展OAuth声明：描述宿主提示/设备码/选项和回调，不实现UI、登录、浏览器或剪贴板动作。
// core/provider-composer把这些旧回调接到统一AuthInteraction；ai/oauth.ts与index.ts只转导出类型。
// OAuthCredentials是access/refresh/expires等旧凭据形状，不是新增运行时认证对象；import type会擦除。
import type { OAuthCredentials } from "../auth/types.ts";

/** Legacy extension OAuth prompt. */
// 普通输入提示数据，例message="验证码"、placeholder="粘贴"；结构类型不弹窗或验证内容。
export interface OAuthPrompt {
	// 必需的提示文字，string不防终端控制码。
	message: string;
	// 可选占位文字，不等于默认答案。
	placeholder?: string;
	// 允许空输入的旧元数据；接口不自动应用该规则，桥接/宿主是否采用需看实现。
	allowEmpty?: boolean;
}

/** Legacy extension OAuth authorization link. */
// 授权页面通知数据，例url指向用户确认页面；只声明地址文字，不执行跳转或验证可信域名。
export interface OAuthAuthInfo {
	// 必需URL字符串，不运行new URL或只允许https的检查。
	url: string;
	// 可选附加操作说明，空串也满足类型。
	instructions?: string;
}

/** Legacy extension OAuth device-code notification. */
// 设备码通知形状，把短码/验证地址交宿主显示；例userCode=ABCD不代表服务端access token。
export interface OAuthDeviceCodeInfo {
	// 用户在网页输入的代码文字，不是设备端用于轮询的device_code字段。
	userCode: string;
	// 验证网址，类型不使它自动打开或发HTTP。
	verificationUri: string;
	/** Offer best-effort browser opening on user confirmation. Defaults to true; clients may ignore it. */
	// 可选确认后尝试打开浏览器的展示策略；英文default true是宿主约定，这个?字段不会在运行时自动写true，客户端可忽略。
	openBrowserOnConfirm?: boolean;
	/** Offer copying of userCode on user confirmation, replacing the clipboard. Defaults to true. */
	// 可选确认后复制短码策略，真正执行才会覆盖剪贴板；类型/通知本身不复制，也不自动补默认。
	copyCodeOnConfirm?: boolean;
	// 可选建议轮询间隔，单位秒；接口不设timer或检查正整数。
	intervalSeconds?: number;
	// 可选授权有效期秒数，类型不等于开始倒计时或自动拒绝过期输入。
	expiresInSeconds?: number;
}

// 一项旧选择菜单数据，例{id:"browser",label:"浏览器登录"}，不存实际执行函数。
export interface OAuthSelectOption {
	// 回调返回的稳定选项标识，与显示文字分开。
	id: string;
	// 显示给用户的标签，接口不排版或本地化。
	label: string;
}

// 选择提示由文字和选项数组构成；例options列browser/device两项，再由宿主onSelect异步返回id。
export interface OAuthSelectPrompt {
	// 菜单提示文字。
	message: string;
	// 可变数组类型，不要求至少一项或id唯一，也不做运行时freeze。
	options: OAuthSelectOption[];
}

/** Callback surface retained only for coding-agent extension compatibility. */
// 旧登录交互回调集合：扩展调用宿主以通知/提问；接口声明不执行这些函数。
// 例onAuth({url})只交显示信息，onPrompt({message})返回用户文字；Promise拒绝可表示失败/取消，宿主如何取消需看实现，signal仅协作通知。
export interface OAuthLoginCallbacks {
	// 必需同步授权链接通知，返回void，不保证回调不抛错，也不代表用户已确认。
	onAuth(info: OAuthAuthInfo): void;
	// 必需同步设备码通知，不等待用户回答或轮询完成。
	onDeviceCode(info: OAuthDeviceCodeInfo): void;
	// 必需输入函数，接OAuthPrompt，异步返回string；返回类型不验证答案非空或格式。
	onPrompt(prompt: OAuthPrompt): Promise<string>;
	// 可选进度通知，?标在方法名表示可以没该方法；void不是吞掉同步异常的承诺。
	onProgress?(message: string): void;
	// 可选手工贴码输入，无参数、Promise<string>；调用方应先确认存在，不自动开本地回调端口。
	onManualCodeInput?(): Promise<string>;
	// 必需选择函数，接菜单、异步返回选中id或undefined；undefined可表达没选，类型不强制它一定来自options。
	onSelect(prompt: OAuthSelectPrompt): Promise<string | undefined>;
	// 整个旧登录流程的可选AbortSignal，接口不自行监听/中止不合作的实现；桥接会把同一信号交旧扩展。
	signal?: AbortSignal;
}

// 只转导出凭据类型，生成JS无OAuthCredentials值，也不在这里持久保存/刷新凭据。
export type { OAuthCredentials };
