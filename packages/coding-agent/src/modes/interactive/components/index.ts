// 交互组件的集中导出入口：让外部从同一路径取得类、函数与类型；本文件没有额外注册监听或创建组件的逻辑。
// 运行时重导出遵循 ESM 模块加载规则，相关模块可能被加载；type 导出则会擦除，不会成为运行时值。
// UI Components for extensions
// 重导出 Armin 展示组件；export {名称} from 是转发导出，不在本文件构造实例。
export { ArminComponent } from "./armin.ts";
// 助手正文/思考显示组件，可更新同一条流式消息。
export { AssistantMessageComponent } from "./assistant-message.ts";
// 供外部取得 Bash 执行结果的展示组件；导出语句本身不运行命令。
export { BashExecutionComponent } from "./bash-execution.ts";
// 带边框的加载组件，调用者负责创建和生命周期。
export { BorderedLoader } from "./bordered-loader.ts";
// 已有分支摘要的折叠/展开显示组件。
export { BranchSummaryMessageComponent } from "./branch-summary-message.ts";
// 已有上下文压缩摘要的显示组件，导出不触发模型压缩。
export { CompactionSummaryMessageComponent } from "./compaction-summary-message.ts";
// 同时重导出编辑器运行时类和仅编译期的 CustomEditorOptions 类型。
export { CustomEditor, type CustomEditorOptions } from "./custom-editor.ts";
// 扩展消息显示组件，优先使用自定义 renderer。
export { CustomMessageComponent } from "./custom-message.ts";
// 同一行导出 diff 渲染函数和 type 选项；type 部分编译后擦除。
export { type RenderDiffOptions, renderDiff } from "./diff.ts";
// 随目标宽度生成边框显示的组件。
export { DynamicBorder } from "./dynamic-border.ts";
// 为扩展提供编辑界面的组件类。
export { ExtensionEditorComponent } from "./extension-editor.ts";
// 为扩展提供输入界面的组件类。
export { ExtensionInputComponent } from "./extension-input.ts";
// 为扩展提供选项选择界面的组件类。
export { ExtensionSelectorComponent } from "./extension-selector.ts";
// 花括号可跨多行：下面共同从同一个模块转发初始化界面及其类型。
export {
	// 首次设置的运行时界面组件。
	FirstTimeSetupComponent,
	// 初始化界面输入选项的类型，只参与静态检查。
	type FirstTimeSetupOptions,
	// 初始化界面结果的类型，不会因为导出而实际产生结果。
	type FirstTimeSetupResult,
} from "./first-time-setup.ts";
// 底部状态显示组件。
export { FooterComponent } from "./footer.ts";
// 重导出三种快捷键提示函数：配置中的动作键名、动作提示和原始按键提示。
export { keyHint, keyText, rawKeyHint } from "./keybinding-hints.ts";
// 登录交互界面组件；转发导出本身不发认证请求。
export { LoginDialogComponent } from "./login-dialog.ts";
// 单模型选择界面组件，调用者负责处理选择结果。
export { ModelSelectorComponent } from "./model-selector.ts";
// OAuth 提供方选择界面组件。
export { OAuthSelectorComponent } from "./oauth-selector.ts";
// 导出模型范围配置/回调的编译期类型，以及实际模型范围选择组件。
export { type ModelsCallbacks, type ModelsConfig, ScopedModelsSelectorComponent } from "./scoped-models-selector.ts";
// 会话选择界面组件。
export { SessionSelectorComponent } from "./session-selector.ts";
// 同时提供设置配置/回调类型和设置选择组件。
export { type SettingsCallbacks, type SettingsConfig, SettingsSelectorComponent } from "./settings-selector.ts";
// 图片显示设置的选择组件，不在本文件解码图片。
export { ShowImagesSelectorComponent } from "./show-images-selector.ts";
// 解析后的技能调用块显示组件，单独的用户请求由其他组件展示。
export { SkillInvocationMessageComponent } from "./skill-invocation-message.ts";
// 主题选择组件。
export { ThemeSelectorComponent } from "./theme-selector.ts";
// 思考级别选择组件。
export { ThinkingSelectorComponent } from "./thinking-selector.ts";
// 导出工具执行展示组件及选项类型；真正工具执行并不是这条导出语句负责。
export { ToolExecutionComponent, type ToolExecutionOptions } from "./tool-execution.ts";
// 会话树导航选择组件。
export { TreeSelectorComponent } from "./tree-selector.ts";
// 项目信任选择界面组件，具体信任决策仍由调用流程处理。
export { TrustSelectorComponent } from "./trust-selector.ts";
// 用户 Markdown 消息显示组件。
export { UserMessageComponent } from "./user-message.ts";
// 用户消息选择界面组件。
export { UserMessageSelectorComponent } from "./user-message-selector.ts";
// 重导出按显示行截断函数与结果类型；截断发生在实际调用函数时。
export { truncateToVisualLines, type VisualTruncateResult } from "./visual-truncate.ts";
