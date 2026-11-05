/** Type-only compatibility entry point for coding-agent extension OAuth declarations. */
// 旧扩展OAuth声明的纯类型出口；这里不暴露内置登录实现，不导入flow运行模块、不读凭据/开浏览器。
// export type在JS中擦除；例扩展用import type {OAuthPrompt}描述一个提示对象，不因此自动显示界面或登录。
export type {
	// 授权链接通知的数据形状，含url和可选说明；类型不自动验证URL可信。
	OAuthAuthInfo,
	// 旧OAuth凭据类型，从兼容声明再转导出，字段不会在此持久化或刷新。
	OAuthCredentials,
	// 设备码通知数据，包含代码/验证地址与可选确认行为；仅声明，不复制剪贴板。
	OAuthDeviceCodeInfo,
	// 宿主需实现的登录回调契约，包含提示/选择及可选signal；没有在此创建这些函数。
	OAuthLoginCallbacks,
	// 输入提示的数据类型，例如message/placeholder/allowEmpty。
	OAuthPrompt,
	// 单个选择项id/label的类型，不在此建立实际菜单。
	OAuthSelectOption,
	// 选择提示message/options形状，约束开发期字段，不校验运行数据。
	OAuthSelectPrompt,
} from "./compat/extension-oauth-types.ts";
