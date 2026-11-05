// 交互模式把输入、终端布局、扩展对话框和会话事件接起来；AgentSession处理模型/工具等会话业务，AgentSessionRuntime负责替换会话。
// 主要入口是构造→run/init→输入或事件→组件更新→TUI重绘；本文件也接入登录、包更新、下载工具、剪贴板和子进程，不能把整个类当纯显示层。
/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

// import * as crypto把模块的命名导出收在crypto对象下；本文件用randomUUID为粘贴图片命名，不是生成模型请求。
// node:明确指Node内置模块；下面fs/os/path也是本机能力，真正文件读写发生在对应方法调用时。
import * as crypto from "node:crypto";
// fs命名空间用于会话文件存在检查、读取包信息、落粘贴图片与debug文件；这些调用有实际磁盘副作用。
import * as fs from "node:fs";
// os.tmpdir提供剪贴板图片临时文件所在目录；导入不等已创建文件。
import * as os from "node:os";
// path提供join/resolve/relative/basename等路径运算；路径归一不自动检查文件存在或授予访问权限。
import * as path from "node:path";
// 整条import type只给TS看：AgentMessage描述代理消息，ThinkingLevel约束思考档位；运行时没有这两个导入值，也不会自动校验外来JSON。
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
// 认证事件与提示的类型用于登录UI回调参数；类型定义不会主动登录。
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
// 同一命名导入可混合值与type：只擦除带type的项，重试判断函数仍是运行时调用。
import {
	// 助手消息类型，用于模型输出与UI组件的数据契约。
	type AssistantMessage,
	// 图片内容类型，描述编码数据/MIME等字段，不代表已经解码或显示。
	type ImageContent,
	// 实际函数用于判断助手错误是否归为可重试；是否发起下一次请求仍由会话逻辑决定。
	isRetryableAssistantError,
	// 模型协议Message类型与上面代理AgentMessage处在不同层，后者还能包含应用扩展消息。
	type Message,
	// Model类型描述供应商/协议/模型字段，类型存在不说明远端现在可用。
	type Model,
	// Usage类型描述token/费用等统计字段，不在导入处计算或扣费。
	type Usage,
} from "@earendil-works/pi-ai/compat";
// 这组整体是类型导入；多行花括号只是把多个名字列清楚，末尾逗号不再增加一项。
import type {
	// AutocompleteItem规定一条补全候选的形状。
	AutocompleteItem,
	// AutocompleteProvider规定查询补全候选的接口，而不是在此创建候选。
	AutocompleteProvider,
	// EditorComponent是编辑组件的接口，具体默认/扩展编辑器另行构造。
	EditorComponent,
	// Keybinding描述可配置按键绑定值，稍后交按键匹配器。
	Keybinding,
	// KeyId约束键名表示，不直接读取键盘事件。
	KeyId,
	// MarkdownTheme是Markdown展示所需样式函数集合的类型。
	MarkdownTheme,
	// OverlayHandle描述已显示浮层的控制句柄；句柄不是DOM元素。
	OverlayHandle,
	// OverlayOptions描述浮层布局等选项，不会只因声明就显示浮层。
	OverlayOptions,
	// SlashCommand描述斜杠命令补全项，执行回调与命令解析另有实现。
	SlashCommand,
	// 主屏渲染状态类型用于切换/退出后的画面衔接，不是整份会话持久化格式。
	TuiMainScreenRenderState,
} from "@earendil-works/pi-tui";
// 用TuiLayouts命名空间访问布局类型及isViewportTUI等运行时导出；命名空间导入语法不是TS的namespace声明。
import * as TuiLayouts from "@earendil-works/pi-tui";
// 以下混合导入真实组件/工具与type契约；导入类只是得到构造器，new之后才创建对应实例。
import {
	// 组合命令、路径等补全源的实际Provider类。
	CombinedAutocompleteProvider,
	// Component仅作TS组件契约，实例仍须提供真实render/invalidate等实现。
	type Component,
	// Container是持有子组件的布局容器，后文用它拼聊天区、状态区等。
	Container,
	// fuzzyFilter按查询做模糊筛选，用于候选列表，不发送模型检索请求。
	fuzzyFilter,
	// getCapabilities读取当前终端能力配置，供图片/颜色等显示决策使用。
	getCapabilities,
	// hyperlink生成终端超链接文字，并非这里打开浏览器。
	hyperlink,
	// Markdown是终端Markdown展示组件，区别于导出HTML中的浏览器marked库。
	Markdown,
	// matchesKey比较输入与配置键绑定，调用点仍要传具体绑定。
	matchesKey,
	// Spacer组件给布局留空行，不是异步等待。
	Spacer,
	// setCapabilityOverrides写终端能力覆盖，调用时会影响共享能力配置。
	setCapabilityOverrides,
	// setKeybindings设置TUI使用的共享按键配置，不等只修改当前局部变量。
	setKeybindings,
	// Terminal接口约束终端适配器；类型本身不会启用原始输入模式。
	type Terminal,
	// Text组件渲染普通终端文字，样式控制序列与排版另在组件处理。
	Text,
	// TruncatedText按终端列宽提供截断文字展示。
	TruncatedText,
	// TUI在这里仅作类型导入，实际实例由下方工厂创建。
	type TUI,
	// TuiAltScreen是备用屏实现，切入/退出由实际启动停止流程决定。
	TuiAltScreen,
	// TuiMainScreen是主屏实现，用于保留终端滚动历史的模式。
	TuiMainScreen,
	// TuiMouseEvent描述解析后的鼠标输入，不是浏览器MouseEvent。
	type TuiMouseEvent,
	// TuiMouseEventResult约束处理鼠标事件时的返回结果。
	type TuiMouseEventResult,
	// visibleWidth计算终端可见列宽；不能直接用JS字符串length替代宽字/控制序列处理。
	visibleWidth,
} from "@earendil-works/pi-tui";
// 默认导入chalk，用dim等方法生成退出提示样式；不因此启动一个TUI。
import chalk from "chalk";
// spawn是Node子进程入口，后文读取tmux选项；只有实际调用才启动进程，返回对象不等进程已结束。
import { spawn } from "child_process";
// 统一从config取应用标识与资源路径，兼顾源码/npm/独立打包布局，不在此拼__dirname。
import {
	// APP_NAME供命令/提示等应用名称使用。
	APP_NAME,
	// APP_TITLE用于界面标题，与当前会话名是不同输入。
	APP_TITLE,
	// CONFIG_DIR_NAME是配置目录名，后文用于说明文字与定位。
	CONFIG_DIR_NAME,
	// detectInstallChange用于判断安装是否变化，具体读取与比较在函数内。
	detectInstallChange,
	// getAgentDir取得当前agent配置根路径，返回路径不等保证目录已创建。
	getAgentDir,
	// getAuthPath提供凭据文件位置，不在这条导入里读取凭据。
	getAuthPath,
	// getDebugLogPath统一提供调试输出目标。
	getDebugLogPath,
	// getDocsPath返回包文档资源位置，供帮助信息引用。
	getDocsPath,
	// VERSION是当前程序版本值，检查远端新版需要另外调用更新检查。
	VERSION,
} from "../../config.ts";
// AgentSession/事件仅作类型；parseSkillBlock是实际技能块解析函数，用于展示，不因解析就执行技能里的命令。
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../core/agent-session.ts";
// 运行时协调器仅作类型；文件导入异常类是值，后文可用instanceof识别该错误分类。
import { type AgentSessionRuntime, SessionImportFileNotFoundError } from "../../core/agent-session-runtime.ts";
// 运行时诊断类型描述要展示的诊断记录，不会自动收集系统信息。
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.ts";
// 缓存统计辅助只服务本地分析和展示，是否向模型复用缓存由请求层另行决定。
import {
	// CACHE_TTL_MS是统计分析使用的毫秒窗口值，不强制远端缓存按这个时限保留。
	CACHE_TTL_MS,
	// CacheMiss是缓存未命中诊断结果的类型。
	type CacheMiss,
	// collectCacheMisses收集会话条目中的未命中分析结果。
	collectCacheMisses,
	// computeCacheWaste计算缓存浪费估计，不是实际账单读取。
	computeCacheWaste,
	// detectCacheMiss根据本地统计判断未命中情况，结论受记录和估算法限制。
	detectCacheMiss,
} from "../../core/cache-stats.ts";
// 两格式化函数把缓存预热状态/用量变成显示文字，预热请求由别处执行。
import { formatCacheWarmingStatus, formatCacheWarmingUsage } from "../../core/cache-warmer.ts";
// 崩溃辅助分别匹配扩展栈、记录崩溃、取得尚未通知的记录；具体调用可读写崩溃日志。
import { findExtensionStackMatches, recordCrash, takeUnnotifiedCrash } from "../../core/crash-log.ts";
// 导入默认思考档位和可展示档位列表，不代表每个模型都支持所有档位。
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "../../core/defaults.ts";
// 整组扩展契约只参与TS检查，具体函数/对象由本模式创建或从运行时取得。
import type {
	// 补全Provider工厂类型，约定如何为编辑器构造补全源。
	AutocompleteProviderFactory,
	// EditorFactory约束构建自定义编辑器的函数签名。
	EditorFactory,
	// 命令上下文类型面向扩展命令可调用的会话操作。
	ExtensionCommandContext,
	// 普通扩展上下文类型，字段的新鲜程度还要看实际构造与回调取值。
	ExtensionContext,
	// ExtensionRunner在此仅作运行器类型，不通过这条import实例化扩展系统。
	ExtensionRunner,
	// ExtensionUIContext约束提供给扩展的选择/输入/通知等UI能力。
	ExtensionUIContext,
	// 对话框选项契约包括取消/超时等配置；是否处理仍看对应实现。
	ExtensionUIDialogOptions,
	// Widget选项契约约束挂载位置等配置，不等已渲染到屏幕。
	ExtensionWidgetOptions,
	// MarkdownTransformer约定Markdown变换函数的接口。
	MarkdownTransformer,
	// ProjectTrustContext描述项目信任询问所需信息，类型检查不自动授信。
	ProjectTrustContext,
	// UserBashEventResult描述扩展Bash钩子的返回，不在此执行shell。
	UserBashEventResult,
	// WorkingIndicatorOptions是工作状态提示的配置类型。
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
// 实际FooterDataProvider负责页脚数据，其只读视图仅是TS契约；创建实例可能开始Git分支监听，导入不等已开始监听。
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
// HTTP调度器配置函数与超时显示格式化函数；配置共享请求行为，格式化本身只生成文字。
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../core/http-dispatcher.ts";
// AppKeybinding只约束键名，KeybindingsManager是真实配置加载/解析器；创建时的读取在构造流程解释。
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
// MCP HTTP服务配置类型，声明并不建立远端连接。
import type { McpHttpServerConfig } from "../../core/mcp-servers.ts";
// 把压缩/自定义记录转换成可展示消息的工厂；显示压缩摘要不是在这里调用模型生成摘要。
import { createCompactionSummaryMessage, createCustomMessage } from "../../core/messages.ts";
// 模型解析辅助供选择器确定具体引用与范围，不把用户名字直接当远端可用性证明。
import {
	// 供应商到默认模型ID的本地候选表，是对象值而非函数；表中有候选不等已认证或远端可调用。
	defaultModelPerProvider,
	// 按模型引用做精确匹配的辅助函数。
	findExactModelReferenceMatch,
	// 从模型集合解析限定的可循环范围，真正切换模型另有调用。
	resolveModelScopeFromModels,
} from "../../core/model-resolver.ts";
// 凭据同步错误类保留为运行时值，供异常分类；instanceof不是按错误文字匹配。
import { CredentialSynchronizationError } from "../../core/model-runtime.ts";
// 默认包管理器用于包信息/更新等操作，导入类不等马上安装依赖。
import { DefaultPackageManager } from "../../core/package-manager.ts";
// Radius服务的固定MCP地址和供应商ID；常量本身不发HTTP请求。
import { RADIUS_MCP_URL, RADIUS_PROVIDER_ID } from "../../core/radius.ts";
// 资源诊断类型用于展示资源加载问题，不在导入时扫描目录。
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
// 缺失会话cwd的提示格式化器与专门异常类，用于恢复/切换时让用户处理目录问题。
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.ts";
// 会话文件层的类型与操作入口；本地历史条目和送模型的消息不是同一种数据表示。
import {
	// SessionEntry是会话记录联合类型，按type字段区分记录。
	type SessionEntry,
	// SessionManager是实际会话历史管理类，负责JSONL与分支结构等操作。
	SessionManager,
	// 把一条会话记录转换为上下文消息；这里只导入函数，不发出模型请求。
	sessionEntryToContextMessages,
	// UsageEntry描述单独保存的用量记录，供统计重建。
	type UsageEntry,
} from "../../core/session-manager.ts";
// 全屏退出输出选项/终端模式都是类型，实际切屏由UI生命周期处理。
import type { FullscreenExitOutput, TuiMode } from "../../core/settings-manager.ts";
// 内置斜杠命令定义用于帮助/补全；命令文本匹配后的处理逻辑在本类。
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
// getSourcePackageKey是实际归属key计算器，SourceInfo仅描述资源来源，不自动验证来源可信。
import { getSourcePackageKey, type SourceInfo } from "../../core/source-info.ts";
// 读取安装遥测是否启用的决策，实际遥测发送在对应代码路径，不因导入发送。
import { isInstallTelemetryEnabled } from "../../core/telemetry.ts";
// 为工具集合配内置展示器；展示回调与工具execute分开。
import { withBuiltInRenderers } from "../../core/tools/renderers/index.ts";
// 截断结果类型用于把Bash输出状态交展示层，断言该类型不重新执行截断。
import type { TruncationResult } from "../../core/tools/truncate.ts";
// 项目信任辅助检查需授信资源并读写信任存储；不会凭TS类型直接运行项目扩展。
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../../core/trust-manager.ts";
// getUsageCostBreakdown整理用量费用分项，是本地统计而非向供应商查询账单。
import { getUsageCostBreakdown } from "../../core/usage-totals.ts";
// MCP配置的加载/添加入口，调用时可涉及配置文件；配置条目存在不等连接成功。
import { addMcpServerConfig, loadMcpConfig } from "../../extensions/mcp/config.ts";
// 更新日志定位、分版提取、链接整理与解析辅助，供启动说明和查看更新使用。
import { getChangelogPath, getNewEntries, normalizeChangelogLinks, parseChangelog } from "../../utils/changelog.ts";
// 真实系统剪贴板复制/读路径/读文字入口，只有对应用户操作路径调用；不是内存字符串变量。
import { copyToClipboard, readClipboardFilePaths, readClipboardText } from "../../utils/clipboard.ts";
// 剪贴板图片读取与MIME到扩展名转换；读取结果仍可能没有图片，不在导入处弹窗或落盘。
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.ts";
// Git URL解析函数只解释地址文字，clone/安装由包管理路径另外执行。
import { parseGitUrl } from "../../utils/git.ts";
// 图片转PNG工具准备入口，必要时可能准备/下载转码器；不是每条消息都转换图片。
import { ensurePngTranscoder } from "../../utils/image-convert.ts";
// cwd相对展示和家目录缩写辅助用于路径文字，不据此切换进程cwd或校验访问授权。
import { getCwdRelativePath, shortenHomePath } from "../../utils/paths.ts";
// 生成Pi User-Agent文字，实际HTTP调用决定何时把它放header。
import { getPiUserAgent } from "../../utils/pi-user-agent.ts";
// 退出清理时请求终止已跟踪的独立子进程；函数名不保证所有进程已经退出。
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
// 加载语法高亮语言定义，用于代码展示，不执行被展示的代码。
import { loadAllHighlightLanguages } from "../../utils/syntax-highlight.ts";
// stripBom去掉文本开头的BOM，不能替代JSON格式检查。
import { stripBom } from "../../utils/text.ts";
// ensureTool准备外部辅助工具，ToolStatus仅描述其状态；实际准备可查找/下载，不能只看类型假设成功。
import { ensureTool, type ToolStatus } from "../../utils/tools-manager.ts";
// 版本检查函数可能访问更新服务；LatestPiRelease类型只约束返回数据的使用。
import { checkForNewPiVersion, type LatestPiRelease } from "../../utils/version-check.ts";
// 问题报告入口在用户调用路径中处理反馈，不因导入就发送报告。
import { reportBug } from "./bug-report.ts";
// 创建聊天视口布局，具体焦点/滚动与TUI接口衔接。
import { createChatViewport } from "./chat-viewport.ts";
// ArminComponent是内联彩蛋组件，与下方惰性3D浮层入口不同。
import { ArminComponent } from "./components/armin.ts";
// 助手消息展示组件，承接流式消息内容的显示更新，不自行请求模型。
import { AssistantMessageComponent } from "./components/assistant-message.ts";
// Bash执行展示组件保存输出/状态，真正命令执行在会话调用路径。
import { BashExecutionComponent } from "./components/bash-execution.ts";
// 分支摘要消息组件负责呈现已得到的摘要。
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
// 压缩摘要消息组件负责显示压缩记录，不等压缩模型在组件中运行。
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
// 默认自定义编辑器类，组织输入与按键行为，区别于外部编辑器进程。
import { CustomEditor } from "./components/custom-editor.ts";
// 自定义会话条目的展示组件，和自定义消息组件承担不同记录类型。
import { CustomEntryComponent } from "./components/custom-entry.ts";
// 自定义消息组件把扩展消息交其展示规则处理。
import { CustomMessageComponent } from "./components/custom-message.ts";
// 动态边框组件供选择器/状态等界面组织使用。
import { DynamicBorder } from "./components/dynamic-border.ts";
// 公告组件用于显示启动公告内容，不代表导入时已输出终端文字。
import { EarendilAnnouncementComponent } from "./components/earendil-announcement.ts";
// 两个lazy彩蛋入口到实际播放时才加载3D实现；返回接手请求不必然意味着动画已播完。
import { playArmin3d, playPiLogo3d } from "./components/easter-egg-3d.lazy.ts";
// 扩展多行编辑对话框组件，用户完成后由回调交回内容。
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
// 扩展单行输入组件，取消/默认值等行为以实际实现为准。
import { ExtensionInputComponent } from "./components/extension-input.ts";
// 扩展选项选择器组件，展示候选并接收用户选择。
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
// 页脚组件与token数量格式化函数；格式化文字不重新估算模型token。
import { FooterComponent, formatTokens } from "./components/footer.ts";
// 按配置格式化键名/提示的辅助，避免UI文字与可配置键位分离；这些函数不是按键事件处理器。
import { formatKeyText, keyDisplayText, keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.ts";
// 登录对话框展示认证提示与输入，真正认证仍由Provider协议和回调驱动。
import { LoginDialogComponent } from "./components/login-dialog.ts";
// 创建Mermaid Markdown变换器，作用是将图表转换接入显示，不更改原会话提示词。
import { createMermaidMarkdownTransformer } from "./components/mermaid.ts";
// 模型选择器组件负责列表/搜索/选中界面，不单靠显示一项就完成运行时切换。
import { ModelSelectorComponent } from "./components/model-selector.ts";
// 认证选择器相关导入同时含类型、格式化函数与组件类。
import {
	// AuthSelectorProvider是认证候选展示数据的类型。
	type AuthSelectorProvider,
	// 把认证候选状态格式化为展示文字。
	formatAuthSelectorProviderStatus,
	// 把认证候选的类型格式化为展示文字。
	formatAuthSelectorProviderType,
	// OAuthSelectorComponent展示认证入口选择，名字不表示每个候选都必须走OAuth协议。
	OAuthSelectorComponent,
} from "./components/oauth-selector.ts";
// Pi图标行/字标及能力判断，供启动/页眉显示，不改变会话模型内容。
import { piLogoLines, piWordmark, supportsPiLogo } from "./components/pi-logo.ts";
// 构造登录菜单选择器，具体菜单选项与操作在登录命令路径组装。
import { createLoginMenuSelector } from "./components/radius-login-selector.ts";
// 限定模型范围选择器修改可循环模型范围，区别于只切换当前模型的选择器。
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";
// 会话选择器提供恢复会话的列表UI，实际加载与运行时重绑另行进行。
import { SessionSelectorComponent } from "./components/session-selector.ts";
// 设置选择器显示并回调设置变更；写入/生效时机要看各回调。
import { SettingsSelectorComponent } from "./components/settings-selector.ts";
// 技能调用消息展示组件识别技能块展示，不把显示动作说成执行技能脚本。
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
// 不同状态提示的具体实现与统一接口分开；UI状态变化通过构造/替换实际对象完成。
import {
	// 分支摘要生成期间的提示组件，不负责生成摘要正文。
	BranchSummaryStatusIndicator,
	// 上下文压缩期间的提示组件，不是压缩算法实现。
	CompactionStatusIndicator,
	// 空闲状态对象的实现，供状态区域切换。
	IdleStatus,
	// 模型重试状态展示实现，重试请求仍由会话层负责。
	RetryStatusIndicator,
	// StatusIndicator只作统一状态组件类型，运行时没有接口对象可new。
	type StatusIndicator,
	// 工作中状态展示实现，接收进度/提示文字更新。
	WorkingStatusIndicator,
} from "./components/status-indicator.ts";
// ThemedText为普通文字接当前主题显示样式。
import { ThemedText } from "./components/themed-text.ts";
// 思考档位选择器展示可选档位，真正模型支持范围由会话层确定。
import { ThinkingSelectorComponent } from "./components/thinking-selector.ts";
// 工具调用/结果展示组件与真实工具执行分开；事件到来后更新参数和结果。
import { ToolExecutionComponent } from "./components/tool-execution.ts";
// 树选择器提供会话历史分支导航，实际会话分支替换由后续回调处理。
import { TreeSelectorComponent } from "./components/tree-selector.ts";
// 信任选择器显示授权选项，用户选择之后才由调用者继续资源流程。
import { TrustSelectorComponent } from "./components/trust-selector.ts";
// 用户消息组件显示历史/新输入，不把渲染当作再向模型提交一次。
import { UserMessageComponent } from "./components/user-message.ts";
// 用户消息选择器供选择历史用户输入等交互。
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts";
// 外部编辑器辅助在调用时启动用户配置的编辑流程，和内置输入组件不同。
import { editInExternalEditor } from "./external-editor.ts";
// 刷新模型目录的异步协调函数，可能触发Provider目录请求，错误/取消边界在调用处解释。
import { refreshModelCatalogs } from "./model-catalog-refresh.ts";
// 生成模型搜索用文字的辅助，不调用远端搜索API。
import { getModelSearchText } from "./model-search.ts";
// BlockedStatus是类型，ProgramStatusReporter是真实状态报告器；状态 getter 与实际报告在运行时访问。
import { type BlockedStatus, ProgramStatusReporter } from "./program-status-reporter.ts";
// 会话分享入口在命令路径执行导出/分享流程，导入本身不上传历史。
import { shareSession } from "./session-share.ts";
// 主题模块既有查询/设置函数、类，也有全局theme代理；type ThemeColor仍只作编译期约束。
import {
	// 列可用主题名，具体扫描与来源优先级在主题模块实现。
	getAvailableThemes,
	// 列可用主题并附来源路径，供资源显示/诊断使用。
	getAvailableThemesWithPaths,
	// 把当前主题适配成编辑器需要的样式契约。
	getEditorTheme,
	// 把当前主题适配成终端Markdown需要的样式契约。
	getMarkdownTheme,
	// 按名称取得主题对象，失败行为以实际主题加载函数为准。
	getThemeByName,
	// 注册主题变化回调；本模块使用单一回调槽，并非每调用一次就无限追加监听器。
	onThemeChange,
	// 保留的system主题名称，供自动匹配终端背景使用。
	SYSTEM_THEME_NAME,
	// 替换扩展注册主题表，不是追加一个局部变量数组。
	setRegisteredThemes,
	// 停止主题文件watcher；停止watch不自动恢复上一份主题对象。
	stopThemeWatcher,
	// Theme类是运行时值，后文instanceof区分主题实例和主题名文字。
	Theme,
	// ThemeColor是主题颜色键的类型，类型不会把任意颜色字符串运行时转换成合法键。
	type ThemeColor,
	// theme是访问当前主题的共享代理，换主题后调用能取新的主题行为，不是导入时的颜色快照。
	theme,
} from "./theme/theme.ts";
// 交互主题控制器把主题选择与终端能力同步组织在一起，实例创建/监听生命周期在构造与stop路径处理。
import { InteractiveThemeController } from "./theme/theme-controller.ts";
// 导入创建实际TUI和稳定引用的两个函数；稳定引用用于切屏时让已持有的调用者继续访问当前实例。
import { createInteractiveTui, createInteractiveTuiReference } from "./tui-renderer.ts";

// 从原模块再导出这两个函数，外部可经本文件导入；export转发不在这里再创建TUI实例。
export { createInteractiveTui, createInteractiveTuiReference } from "./tui-renderer.ts";

/** Interface for components that can be expanded/collapsed */
// 只约定“切换展开状态”这一项能力，组件不必继承同一个类；结构类型允许任何具有相同方法的对象满足接口。
interface Expandable {
	// expanded是目标状态，不是“切换一次”；void表示调用方不使用返回值，具体组件自己决定是否使渲染缓存失效。
	setExpanded(expanded: boolean): void;
}

// 当前输入区至少满足EditorComponent；额外的光标查询是可选能力，方便粘贴时判断是否补空格。
interface ActiveEditor extends EditorComponent {
	// 方法名后的?表示可能没有这个方法；返回对象含行号/列号，number本身不在运行时限制整数或取值范围。
	getCursor?(): { line: number; col: number };
}

// 可把运行状态画进编辑器边框的组件契约；它是在普通编辑器接口上增加能力，不意味着所有扩展编辑器都支持。
interface WorkingStatusEditor extends EditorComponent {
	// readonly只限制TypeScript代码重新赋该属性，不是Object.freeze，也不是运行时只读权限。
	readonly embedWorkingStatus: boolean;
	// 传状态对象以供渲染，传undefined清除；这里只声明签名，不规定何时重绘或由谁销毁旧状态对象。
	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void;
}

// 探测编辑器是否明确启用嵌入状态并具有对应方法，返回布尔；真分支让TS把editor缩窄为WorkingStatusEditor。
// 例如普通Editor返回false，带embedWorkingStatus:true和设置方法的CustomEditor返回true；不调用该方法，也不完整校验整个编辑器对象。
function isEmbeddedStatus(editor: EditorComponent): editor is WorkingStatusEditor {
	// 括号把跨行&&表达式合成一个返回值，条件按从上到下短路。
	return (
		// 先查属性是否存在；in也能找到原型链属性，不限自身字段。
		"embedWorkingStatus" in editor &&
		// 必须严格为true，false或仅仅有同名属性都不算启用。
		editor.embedWorkingStatus === true &&
		// 再确认有状态设置入口，前面的条件失败时不会访问这里。
		"setWorkingStatusIndicator" in editor &&
		// 检查该成员能以函数形式调用；不在此验证它的参数、实现或是否会抛错。
		typeof editor.setWorkingStatusIndicator === "function"
	);
}

// 从unknown中识别可展开对象，返回类型谓词供调用方安全地调用setExpanded；例如带该方法的资源区文字可通过。
// 只检查非空对象及同名函数，不执行展开；函数对象即使挂了此方法，也因typeof不是object而不通过。
function isExpandable(obj: unknown): obj is Expandable {
	// unknown要求先排除非对象和null，再用in/typeof探测成员；这一串&&会短路，不是对组件做完整schema验证。
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

// 在可随主题重建文字的ThemedText上加折叠状态；extends继承显示能力，implements只让TS核对Expandable方法是否齐备。
class ExpandableText extends ThemedText implements Expandable {
	// 字段固定持有一个状态对象，但对象里的expanded仍可修改；把状态放进对象可让父类回调与本类方法共享它。
	private readonly state: { expanded: boolean };

	// 保存折叠/展开两种取文案回调和边距，创建可切换的文字组件；例两回调分别返回“3个资源”与资源清单。
	// 构造只建立延迟取文字的闭包，ThemedText到render时才调用它；回调异常不在这里统一捕获，不自动请求终端重绘。
	constructor(
		// 无参函数类型表示每次需要折叠文案时现取字符串，不在此保存某一次调用结果。
		getCollapsedText: () => string,
		// 展开文案同样延迟计算，因此调用方可以读取当时主题颜色。
		getExpandedText: () => string,
		// 未传expanded时默认折叠；省略类型注解时TS从false推断参数为boolean。
		expanded = false,
		// 水平方向边距默认0，随后原样交给父组件。
		paddingX = 0,
		// 垂直边距同样默认0；尾随逗号只方便增删参数，不增加额外参数。
		paddingY = 0,
	) {
		// 先用局部变量保存状态，避免在super之前访问派生类this；{ expanded }是属性名与变量名相同的简写。
		const state = { expanded };
		// 先构造父类，闭包每次按共享状态二选一取文案；三元运算符只执行选中的那个回调。
		super(() => (state.expanded ? getExpandedText() : getCollapsedText()), paddingX, paddingY);
		// super返回后才把同一个对象存进字段；不是复制一份互不相干的expanded。
		this.state = state;
	}

	// 写入展开目标并让文字缓存失效，返回void；例setExpanded(true)让下次render读取展开文案。
	// 这里只变组件状态，不调用ui.requestRender；实际何时输出一帧由宿主决定。
	setExpanded(expanded: boolean): void {
		// 修改共享对象中的布尔值，父类持有的闭包会看到新值。
		this.state.expanded = expanded;
		// 继承的invalidate标记文字需要重建，并使父Text缓存失效；不会当场调用取文案回调。
		this.invalidate();
	}
}

/** The built-in header. Clicking its logo (the first two lines, after one column of padding) plays an easter egg. */
// 内置页头沿用折叠文字，再为左上角标识增加鼠标点击入口；不在类加载时播放动画。
class BuiltInHeader extends ExpandableText {
	// 保存可选回调，参数是标识起点的屏幕列/行；整体函数类型用括号与undefined组成联合。
	onLogoClick: ((column: number, row: number) => void) | undefined;

	// 将符合标识区域的点击交回调，处理后返回handled，其余返回undefined让外层继续分派。
	// 例局部x=2,y=1命中，回调得到屏幕上标识的起点；这里不核对鼠标按钮，也没有自行限定y的下界。
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// 只接click、前两行及局部第1到4列，并要求已有回调；这一行提前return避免非命中时计算起点。
		if (event.type !== "click" || event.y > 1 || event.x < 1 || event.x > 4 || !this.onLogoClick) return undefined;
		// 屏幕坐标减局部坐标得到组件起点，再向右补一列内边距；回调同步执行，异常可传给鼠标分派方。
		this.onLogoClick(event.screenX - event.x + 1, event.screenY - event.y);
		// 仅声明该事件已处理，不在本对象中另请求焦点、捕获鼠标或立即重绘。
		return { handled: true };
	}
}

// 交叉类型要求有Component渲染/输入契约，并允许额外dispose清理方法；?不保证存在，也不意味着dispose会解决等待中的Promise。
type ExtensionDialogComponent = Component & { dispose?(): void };

// 压缩期间暂存的输入记录；这是UI自己的队列，与AgentSession的steering/follow-up队列分开维护。
type CompactionQueuedMessage = {
	// 保留原始提交文字，后面才按是否扩展命令决定执行方式。
	text: string;
	// 字符串字面量联合只允许这两种提交意图；TS开发期检查不会在运行时自动过滤外部JSON。
	mode: "steer" | "followUp";
};

// 仅用于渲染的摘要费用提示，不是发给模型的普通AgentMessage。
type CompactionCostNotice = {
	// 固定type作为联合类型的分支标记，后续谓词用它识别本记录。
	type: "compaction_cost";
	// 区分上下文压缩和分支摘要两种费用来源，决定显示标题。
	kind: "compaction" | "branch_summary";
	// 附带已记录Usage，其中包含token与cost字段；本类型不验证供应商计费是否准确。
	usage: Usage;
};

// 一条待渲染项目可能是Agent消息、自定义/用量会话条目或合成费用提示；Extract从SessionEntry联合中选出type匹配的分支。
type RenderSessionItem = AgentMessage | Extract<SessionEntry, { type: "custom" | "usage" }> | CompactionCostNotice;

// 按type识别自定义会话条目，真分支向TS暴露该分支字段；例custom条目由专用组件显示。
// 没有副作用，只信任这里已构造的RenderSessionItem联合，不逐字段验证外部输入。
function isCustomSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "custom" }> {
	// in先区分有type的条目与按role判别的普通消息，再严格比较custom。
	return "type" in item && item.type === "custom";
}

// 识别本文件合成的费用提示，返回类型谓词；例压缩结果带usage时可走费用渲染分支，不改变会话文件。
function isCompactionCostNotice(item: RenderSessionItem): item is CompactionCostNotice {
	// 只依据判别字段，不检查usage内部数值或费用来源。
	return "type" in item && item.type === "compaction_cost";
}

// 从渲染联合中识别持久化用量条目；例缓存预热usage可独立显示，不冒充助手回复。
function isUsageSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "usage" }> {
	// 条件通过后TS知道item是UsageEntry对应分支，检查本身不修改item。
	return "type" in item && item.type === "usage";
}

// EIO: tty reads/ioctls from an orphaned background process group, or writes after hangup.
// ENOTTY: the tty was revoked (macOS) and stdin is no longer a terminal.
// 把这四个Node错误码视作终端连接不可继续使用的信号；Set做精确成员匹配，不包含所有I/O错误。
const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN", "ENOTTY"]);

// 从unknown异常中判断是否属于上述终端错误，返回布尔；例{code:"EPIPE"}为true，普通Error没有code为false。
// 只读异常字段，不修复终端、不保证错误一定来自TTY；code访问器等自身抛错也未在这里catch。
function isDeadTerminalError(error: unknown): boolean {
	// 先排除空值、非对象和没有code的对象，避免直接访问unknown；in包含继承属性。
	if (!error || typeof error !== "object" || !("code" in error)) {
		// 无可比较的code直接判否，不把任意异常当终端已经失效。
		return false;
	}
	// as只让TS按Node异常接口读取可选code，不在运行时转换或校验对象形状。
	const code = (error as NodeJS.ErrnoException).code;
	// 排除undefined后查Set；未在集合里的值一律false，不按错误消息文本猜测。
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

// 把栈中匹配到的扩展名拼成排查建议，空结果返回undefined；例["a","b"]生成两个反引号名称和停用建议。
// 这是文字格式化，不停用扩展、不证明它导致崩溃；名称原文未在此去重、脱敏或转义控制字符。
export function formatCrashExtensionHint(extensionMatches: readonly string[] | undefined): string | undefined {
	// 保留原实现的运行时数组判断；参数的readonly类型只限制TS调用方，不能代替运行时检查。
	// 数组分支仅保留非空字符串，类型谓词帮助filter把结果缩窄为string[]；空格字符串仍保留。
	// 非数组/undefined取空列表，随后统一走“没有建议”的分支。
	const matches = Array.isArray(extensionMatches)
		? extensionMatches.filter((match): match is string => typeof match === "string" && match.length > 0)
		: [];
	// 没有有效名称就不生成提示，而不是显示空扩展列表。
	if (matches.length === 0) return undefined;
	// 每个名称包进反引号，仅为终端文案标记，不是shell执行或完整Markdown转义。
	const quoted = matches.map((match) => `\`${match}\``);
	// 按1个、2个、更多名称分开拼自然语言；最终是一个字符串。
	// 只有一个名称时直接取quoted[0]；前面已确认列表非空。
	// 两个名称用and连接，不插Oxford逗号。
	// join只连接已有字符串，不改变quoted数组。
	// 三项及以上先连前面各项，再补最后一项；slice(0,-1)产生新数组，原列表不改。
	const labels =
		// 一个名称无需连接词，下面直接取第一项。
		quoted.length === 1
			? quoted[0]
			: quoted.length === 2
				? quoted.join(" and ")
				: `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
	// 按数量选择单复数名词，只影响提示文字。
	const noun = matches.length === 1 ? "extension" : "extensions";
	// 同样选择单复数代词，保持后面建议语句一致。
	const pronoun = matches.length === 1 ? "it" : "them";
	// 返回完整排查文案并插入APP_NAME；“may be involved”只表示栈相关线索，不是因果结论或已执行验证。
	return `A stack frame came from loaded ${noun} ${labels}, which may be involved. Try disabling ${pronoun} with \`${APP_NAME} config\`, or run \`${APP_NAME} -ne\` to confirm.`;
}

// 保存启动时可能展示的Anthropic订阅认证提示原文；何时显示由后面认证检查和设置控制，这个常量本身不查费用或账户。
const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in /settings.";

// 用固定前缀猜测是否为Anthropic订阅OAuth键，返回布尔；例sk-ant-oat开头命中。
// 这里只看字符串前缀，不验证有效期、账户归属、余额或服务端是否接受；没有网络请求。
function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	// typeof排除undefined，startsWith是大小写敏感的字面前缀判断，不是正则或完整token解析。
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

// 识别同时以unknown占据供应商、模型ID和API的占位模型；例如缺省占位值可触发登录后的模型选择引导。
// any放宽这里的模型API泛型关联，不能据此宣称已校验模型能力；本函数不查目录、不修改模型。
function isUnknownModel(model: Model<any> | undefined): boolean {
	// !!先转换存在性为布尔，再逐项严格比较；只某一个字段为unknown并不满足这个条件。
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

// 把文字变成可展示在POSIX shell命令里的单个参数，安全字符原样，其余单引号包裹；例a b变成'a b'，空串变成''。
// 只返回字符串，不运行命令；不是面向所有Windows命令解释器的通用引用规则。
function quoteIfNeeded(value: string): string {
	// 白名单外字符正则配合非空条件，只有全由这些ASCII字母数字/符号组成才省略引号。
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		// 满足白名单直接返回原值，不做路径解析或展开~。
		// 若以后把未引用的~前缀交给shell，shell仍可能做家目录展开；这个函数返回原串不等于执行时字面值一定不变。
		return value;
	}
	// 含单引号时按“结束单引号→转义一个单引号→重新打开”拼接，再给整体加引号；这是生成命令文字，不是求值。
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

// 在适合终端展示且会话文件已存在时生成恢复命令，其他情况返回undefined；例如自定义目录会加--session-dir并引用该目录参数。
// 读取会话元信息并同步检查路径存在，不创建文件、不执行命令；文件存在也不证明内容可恢复或路径在检查后仍存在。
export function formatResumeCommand(sessionManager: SessionManager): string | undefined {
	// stdout不是TTY就不输出面向用户的恢复命令，重定向场景直接省略。
	if (!process.stdout.isTTY) return undefined;
	// 持久化模式为前提；isPersisted只表示模式，后面还要单独确认文件存在。
	if (!sessionManager.isPersisted()) return undefined;

	// 取当前会话文件路径，可能未定义，也可能只是计划写入的位置。
	const sessionFile = sessionManager.getSessionFile();
	// 有路径且existsSync为真才继续；存在检查与后续用户执行恢复不是原子操作。
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;

	// 先收集参数片段，初始为应用命令名；这里不是spawn的argv，因为最后会用空格连成展示文字。
	const args = [APP_NAME];
	// 仅非默认会话目录才显式加目录参数；默认判定由SessionManager的路径比较规则负责。
	if (!sessionManager.usesDefaultSessionDir()) {
		// 目录可能含空格等字符，因此调用上面的POSIX引用函数；不修改真实会话目录。
		args.push("--session-dir", quoteIfNeeded(sessionManager.getSessionDir()));
	}
	// 加会话ID，不是当前树的leaf ID；ID原样作为此片段，没有在本行另调用quoteIfNeeded。
	args.push("--session", sessionManager.getSessionId());
	// 空格拼出单行命令返回，调用方以后决定是否显示；不自动复制剪贴板。
	return args.join(" ");
}

// 检查供应商名称是否能在默认模型表里通过in找到，并以类型谓词让TS允许索引该表；不查询真实模型目录。
// 例如anthropic为表内名字；in还包含原型链，不能把此谓词解读成“自有键校验”或已注册供应商证明。
function hasDefaultModelProvider(providerId: string): providerId is keyof typeof defaultModelPerProvider {
	// 运行时行为完全由in决定，不核对该键的值是否存在/是字符串，也不验证该模型可用。
	return providerId in defaultModelPerProvider;
}

// 按已知加载模型数拼llama.cpp认证完成后的下一步文案，返回字符串；例数量0建议先/llama，再/model。
// 只使用调用方传来的数字，不探测服务器，不加载/选择模型；非0的其他数字都走第二支。
function llamaCppPostLoginGuidance(actionLabel: string, loadedModelCount: number): string {
	// 严格等于0才选“没有模型”的文案，不把负数或NaN自行规范成0。
	// 零模型分支把actionLabel原文接在前面，随后仅给命令建议。
	// 其他数量统一提示选择已有模型或打开管理菜单，不执行建议中的命令。
	return loadedModelCount === 0
		? `${actionLabel}. No llama.cpp models are loaded. Use /llama to load a model, then /model to select it.`
		: `${actionLabel}. Use /model to select a loaded llama.cpp model, or /llama to manage models.`;
}

// 登录补全把同一个供应商的多种认证方式汇总成一项，区别于登录菜单中“每种方式一项”的AuthSelectorProvider。
type LoginProviderCompletionOption = {
	// id作为去重键，也是补全写入输入区的供应商标识。
	id: string;
	// name是供人阅读和排序的名称，可能与id相同。
	name: string;
	// 索引访问类型取AuthSelectorProvider.authType的联合，再加[]组成可变数组；不是把整个Provider放进去。
	authTypes: AuthSelectorProvider["authType"][];
	// 可选订阅标记仅影响OAuth方式的显示标签；缺省undefined也按格式函数约定展示。
	subscription?: boolean;
};

// Radius登录菜单的介绍原文；声明常量不访问服务，不进行认证。
const RADIUS_LOGIN_INTRO = "Radius is a service crafted for Pi by the builders of Pi, Earendil Works";

// satisfies让TS核对两种认证类型都有数值顺序，同时保留对象自身推断；运行时仍是普通可变对象，不做schema校验。
const AUTH_TYPE_ORDER = { oauth: 0, api_key: 1 } satisfies Record<AuthSelectorProvider["authType"], number>;

// 把任意T列表经模糊检索映射成补全项，无匹配返回null；例如模型列表筛“opus”后转value/label/description。
// 本函数不做I/O或修改原列表，搜索/映射回调可以抛错；空查询时fuzzyFilter可原样返回输入数组，但map仍创建结果数组。
function createFuzzyAutocompleteItems<T>(
	// 泛型T让items元素与下面两个回调的输入保持同一种类型，不要求一定是模型或供应商。
	items: T[],
	// prefix是用户已输入的检索文字；分词/排序规则交给fuzzyFilter，不是简单startsWith。
	prefix: string,
	// 每个候选先由回调取得搜索字段，方便将id、名称等组合检索。
	getSearchText: (item: T) => string,
	// 选中候选再映射为TUI要求的AutocompleteItem；函数类型的返回值约束字段形状。
	toAutocompleteItem: (item: T) => AutocompleteItem,
	// 数组或null的联合明确区分“有补全列表”与“这里没有候选”，不会返回undefined。
): AutocompleteItem[] | null {
	// 按搜索文字做多词模糊过滤/评分；空白或仅分隔符查询可保留原顺序，未在此强制前缀匹配。
	const filtered = fuzzyFilter(items, prefix, getSearchText);
	// 没有候选用null告知上层，不对空数组执行映射。
	if (filtered.length === 0) return null;
	// 按过滤后顺序调用mapper，返回新的补全项数组；mapper异常直接传播。
	return filtered.map(toAutocompleteItem);
}

// 把多个认证菜单选项按供应商id合并，再按名称排序；例同一供应商OAuth/API key汇成authTypes两项。
// 返回新记录/数组并只修改这些汇总记录，不改输入选项；同id的name/subscription保留第一项，不做冲突校验。
function getLoginProviderCompletionOptions(
	// readonly数组限制此函数通过该参数增删元素；元素本身没有因此被深冻结。
	providerOptions: readonly AuthSelectorProvider[],
	// 结果仍是可变数组，供补全映射/查询使用。
): LoginProviderCompletionOption[] {
	// Map以字符串ID去重，值是新建的汇总对象，不直接把输入对象当成结果。
	const byId = new Map<string, LoginProviderCompletionOption>();
	// for...of按输入顺序读取每种认证方式，因此第一项会决定该供应商保留的名称/订阅标记。
	for (const provider of providerOptions) {
		// 查同id是否已有汇总；Map.get缺键返回undefined。
		const existing = byId.get(provider.id);
		// 有对象表示该供应商已处理过，后面只合并认证方式，不覆盖其他元信息。
		if (existing) {
			// includes精确去重认证类型，重复的同一方式不会再添加。
			if (!existing.authTypes.includes(provider.authType)) {
				// push修改的是新建汇总记录内部数组，不是输入provider的字段。
				existing.authTypes.push(provider.authType);
				// 新增方式后按oauth→api_key排序；sort原地修改该authTypes数组，比较器差值只决定先后。
				existing.authTypes.sort((a, b) => AUTH_TYPE_ORDER[a] - AUTH_TYPE_ORDER[b]);
			}
			// 已有记录处理完立即进入下一个输入，不再走首次创建分支。
			continue;
		}
		// 首次遇到ID时创建并登记新对象；对象中的字符串/布尔直接按值使用。
		byId.set(provider.id, {
			// 保留供应商ID作为Map键及结果字段，二者来自同一输入项。
			id: provider.id,
			// 使用首次遇到的显示名，后续同id不同名称不会在此覆盖。
			name: provider.name,
			// 初始认证列表只有当前方式，后续才按需添加/排序。
			authTypes: [provider.authType],
			// 保留首项的可选订阅标记，undefined也是被保留的结果值。
			subscription: provider.subscription,
		});
	}
	// 取Map值成新数组，再按本机localeCompare规则排序名称；不宣称固定ASCII字节顺序。
	return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// 生成登录补全的搜索文本，包含id、名称、认证内部名和显示名；例API key可通过api_key或API key检索。
// 纯拼字符串，不查询认证状态；格式函数/字段访问异常不会在这里统一捕获。
function getLoginProviderSearchText(provider: LoginProviderCompletionOption): string {
	// 先把所有认证方式汇总为一段空格分隔文字。
	const authTypes = provider.authTypes
		// 每种方式同时保留内部值与人类可读标签；subscription只参与标签，不验证账户套餐。
		.map((authType) => `${authType} ${formatAuthSelectorProviderType(authType, provider.subscription)}`)
		// 用空格连接多个方式，让后面模糊检索可以分别匹配词。
		.join(" ");
	// 把供应商ID、名称和认证文字连成一个搜索字段，不改变实际登录命令值。
	return `${provider.id} ${provider.name} ${authTypes}`;
}

// 生成登录补全项的描述文字，返回认证方式和可选显示名；例名称等于ID时只显示subscription/API key。
// 只格式化调用方记录，不检查凭证或可登录性，也不自动裁剪名称。
function formatLoginProviderCompletionDescription(provider: LoginProviderCompletionOption): string {
	// 取每种认证方式准备转显示名，结果顺序沿用汇总列表。
	const authTypes = provider.authTypes
		// 统一使用菜单同一格式规则，API key和OAuth的订阅/账户标签不在此另写一套。
		.map((authType) => formatAuthSelectorProviderType(authType, provider.subscription))
		// 多个认证标签以斜杠连接，形成同一条补全描述。
		.join("/");
	// 名称与ID严格相等则省掉重复名称，否则用中点分隔名称和认证标签。
	return provider.name === provider.id ? authTypes : `${provider.name} · ${authTypes}`;
}

/**
 * Options for InteractiveMode initialization.
 */
// 构造交互模式时的可选启动参数；?允许逐项省略，接口开发期检查不把任意外部对象自动变成合法配置。
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	// 已迁移进auth.json的供应商名列表，只供启动提醒；本字段不负责执行迁移。
	migratedProviders?: string[];
	/** Diagnostics collected before the interactive TUI was initialized. */
	// 会话运行时在启动前收集的诊断，init/run显示时消费；保存类型化记录不表示所有问题已解决。
	startupDiagnostics?: AgentSessionRuntimeDiagnostic[];
	/** Warning message if session model couldn't be restored */
	// 会话模型无法恢复时的备用说明，非空才可能显示，不在选项接口里进行模型切换。
	modelFallbackMessage?: string;
	/** Cwd to trust after reload if it gained a .pi directory during this implicitly trusted session. */
	// 记录隐式信任期间的目录，reload若该目录新增需信任资源才考虑登记信任；不是无条件信任所有目录的开关。
	autoTrustOnReloadCwd?: string;
	/** Initial message to send on startup (can include @file content) */
	// 启动后发送的首条文字，@file内容在上游准备；这不是构造函数立即发起请求的参数。
	initialMessage?: string;
	/** Images to attach to the initial message */
	// 附在首条初始消息上的图片内容，不在这里读图片文件或识别MIME。
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	// 首条之后逐项发送的其他文字，实际执行由run负责。
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	// 明确true时展开启动信息，即使quietStartup设置要求安静；false不等于强制隐藏全部信息。
	verbose?: boolean;
	/** TUI layout mode. */
	// 本次TUI普通/备用屏布局覆盖，缺省才读SettingsManager。
	tuiMode?: TuiMode;
	/** Initial interactive theme setting for this invocation. */
	// 本次调用的初始主题设置，供主题控制器内存优先使用，不等于立刻持久化。
	initialThemeSetting?: string;
	/** Terminal implementation. Defaults to the current process terminal. */
	// 可注入Terminal以替换当前进程终端适配器；提供此项仍不能自动屏蔽init/run的其他文件、网络或子进程副作用。
	terminal?: Terminal;
}

// 准备在启动区展示的单个扩展更新记录，包含包名/版本/归一后的Markdown；类型声明不会自己读取package.json或CHANGELOG。
interface ExtensionChangelogUpdate {
	// 扩展包显示名，后面用于生成更新标题。
	name: string;
	// 本次已加载包版本，用于标记当前更新的版本范围。
	version: string;
	// 已经整理好的更新正文，显示时按Markdown渲染而不是作为代码执行。
	markdown: string;
}

// 交互界面的总协调器：持有组件树、输入与事件处理器，借runtimeHost取得当前会话并在切换后重绑。
// private只限制TypeScript调用面的访问，不是JavaScript的#私有字段；本类的大量状态跨异步回调共享，不能据此理解为并行隔离。
export class InteractiveMode {
	// 保存运行时宿主，它能替换session；后面的getter现取会话，避免一直引用创建时的旧会话。
	private runtimeHost: AgentSessionRuntime;
	// 当前实际渲染器是普通主屏或备用全屏的联合类型，切模式时会整体替换这个对象。
	private renderer: TuiMainScreen | TuiAltScreen;
	// 稳定的TUI代理入口，将方法调用转发给当前renderer，其他组件可继续保存同一ui引用。
	private ui: TUI;
	// 离开主屏模式时保留其渲染状态，稍后切回可交给新主屏实例恢复；undefined表示尚无保存值。
	private mainScreenRenderState: TuiMainScreenRenderState | undefined;
	// 启动资源列表区域，例如AGENTS.md、技能、模板、扩展和诊断，不是模型上下文的存储。
	private loadedResourcesContainer: Container;
	// 对话组件容器，包含用户/助手消息、工具结果和部分状态；真正会话条目由SessionManager保存。
	private chatContainer: Container;
	// 把页头、资源区和聊天区接成可滚动文档；同一批组件可用于不同TUI布局。
	private documentContainer: Container;
	// 全屏模式可有文档滚动视图，普通模式不必创建；namespace导入上的类型也可用点号引用。
	private transcriptScrollView: TuiLayouts.ScrollView | undefined;
	// 全屏布局根组件，mount时挂给TUI；它不等于只放聊天内容的chatContainer。
	private fullscreenLayoutRoot: Component | undefined;
	// 显示还没正式提交到聊天区的消息与Bash输出，区别于AgentSession内部执行队列。
	private pendingMessagesContainer: Container;
	// 状态/进度等辅助显示的容器，可与连续状态消息复用逻辑配合。
	private statusContainer: Container;
	// 保留内置CustomEditor，扩展可以暂时替换当前editor，但恢复时仍用这一实例。
	private defaultEditor: CustomEditor;
	// 当前活动编辑器，可能是内置实例也可能是扩展工厂返回的对象；至少满足ActiveEditor接口。
	private editor: ActiveEditor;
	// 保存扩展的编辑器工厂，重载/重绑时按需要重建；undefined表示没有覆盖。
	private editorComponentFactory: EditorFactory | undefined;
	// 最后构成的补全提供者，可能已经套了多层扩展wrapper；尚未setup时可为空。
	private autocompleteProvider: AutocompleteProvider | undefined;
	// 按注册顺序保存补全包装工厂，数组初始为空；它们以后接收上一个provider并返回下一个。
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	// 工具管理器找到/安装fd后保存其路径，补全文件查找可使用；undefined并不表示文件系统没有任何匹配项。
	private fdPath: string | undefined;
	// 普通输入框和行内选择器共用的位置容器，showTopExtensionDialog决定当前可见对象。
	private editorContainer: Container;
	// 为当前普通选择器保存唯一身份对象，旧回调可用引用相等判断自己是否仍是当前选择器。
	private activeSelectorToken?: object;
	// 当前选择器的可选清理函数，整体签名为无参→void；并不是待选结果的Promise。
	private activeSelectorDispose?: () => void;
	// 内置页脚组件，读取会话/数据提供者显示模型、用量等信息。
	private footer: FooterComponent;
	// 页脚槽位，扩展自定义页脚时可替换槽内组件而保留容器。
	private footerContainer: Container;
	// 提供Git分支、扩展状态和供应商数量；它自己有文件监听等生命周期，退出需要dispose。
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	// 保存一份应用键位管理器供编辑器、选择器与扩展共用；并非把某一组硬编码按键直接绑定到输入。
	private keybindings: KeybindingsManager;
	// 保存当前应用版本文字，用于标题/启动信息，构造时来自VERSION。
	private version: string;
	// init完成启动TUI后的标记，不等于会话/模型已经运行；失败在置位前后会留下不同初始化阶段。
	private isInitialized = false;
	// getUserInput等待输入时保存的单个解决回调；可选函数不是事件监听列表，多次并发等待会覆盖这个槽。
	private onInputCallback?: (text: string) => void;
	// 还没有getUserInput等待者时暂存已提交文字，后面按FIFO取出；并非模型的steering/follow-up队列。
	private pendingUserInputs: string[] = [];
	// 当前活跃动画/状态对象，undefined表示没有；替换时宿主负责dispose旧对象。
	private activeStatusIndicator: StatusIndicator | undefined = undefined;
	// 记录这个状态是否画在编辑器边框，用于切换到普通状态行时清理/间距判断。
	private activeWorkingIndicatorEmbedded = false;
	// 常驻静置状态组件，readonly固定字段引用但不冻结对象；不等于Agent正在空闲的实时事实。
	private readonly idleStatus = new IdleStatus();
	// 扩展或宿主指定的工作文案，空缺时可回默认Working；这是显示配置，不启动任务。
	private workingMessage: string | undefined = undefined;
	// 允许隐藏工作指示器的开关，隐藏显示不会停止Agent、工具或压缩。
	private workingVisible = true;
	// 保存工作指示器动画等可选配置，具体字段由WorkingIndicatorOptions契约规定。
	private workingIndicatorOptions: WorkingIndicatorOptions | undefined = undefined;
	// 内置默认工作文字，readonly是TS约束；扩展覆盖通过workingMessage另存。
	private readonly defaultWorkingMessage = "Working";
	// 思考内容隐藏时的默认占位标题，和实际模型是否返回thinking分开。
	private readonly defaultHiddenThinkingLabel = "Thinking...";
	// 当前占位标题从默认值开始，扩展UI可以改写，resetExtensionUI再恢复。
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	// 上一次中断动作的毫秒时间，用于短时间双击退出；初值0还没有真实按键时间。
	private lastSigintTime = 0;
	// 记录空编辑器Escape动作时间，配合设置决定第二次是否打开树/分支选择器。
	private lastEscapeTime = 0;
	// 整理后的Pi更新Markdown，undefined表示无需展示或尚未取得；不等于原CHANGELOG文件内容全部缓存。
	private changelogMarkdown: string | undefined = undefined;
	// 各扩展的更新记录列表，显示时与Pi更新分开组织。
	private extensionChangelogUpdates: ExtensionChangelogUpdate[] = [];
	// 启动更新/迁移等通知的一次性门禁；本实例先置位后检查内容，不会等后来填充内容自动再展示。
	private startupNoticesShown = false;
	// Anthropic订阅认证提醒在本实例已展示的标记，防止模型切换等重复刷屏。
	private anthropicSubscriptionWarningShown = false;

	// Status line tracking (for mutating immediately-sequential status updates)
	// 连续状态消息前面的Spacer引用，便于下一条紧邻状态替换/复用，而不是每次新增空行。
	private lastStatusSpacer: Spacer | undefined = undefined;
	// 最近的可随主题变化的状态文字组件引用；普通聊天内容插入后可以清掉这份连续跟踪。
	private lastStatusText: ThemedText | undefined = undefined;
	// 保存最近状态原文，状态ThemedText闭包渲染时读取这一共享字段；不是输出历史的独立消息快照或用于文字相等比较的键。
	private lastStatusMessage = "";
	// 管理工具的启动下载进度是否已经进入显示流程，影响后续同类状态的组织。
	private managedToolStatusStarted = false;

	// Streaming message tracking
	// 正在接收助手增量的显示组件，message_update会持续更新它，而不是每个片段建一条消息。
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	// 边界压缩已提前画出的条目ID集合，后面相同entry_appended可跳过以免重复显示；readonly不妨碍add/clear。
	private readonly entriesRenderedByBoundaryCompaction = new Set<string>();
	// 当前流式助手消息引用，和组件分开保存以便事件结束时补诊断/错误显示；不是线程安全快照。
	private streamingMessage: AssistantMessage | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	// 按toolCallId关联工具显示行，工具开始/增量/结束事件据此找到同一组件；Map不在这里执行工具。
	private pendingTools = new Map<string, ToolExecutionComponent>();

	// Tool output expansion state
	// 全局展开状态用于后续可展开组件和快捷键更新，初始折叠；实际切换也会影响实现Expandable的其他组件。
	private toolOutputExpanded = false;

	// Thinking block visibility state
	// 思考块显示开关，随后从设置读取；只控制UI，不从模型上下文删thinking内容。
	private hideThinkingBlock = false;
	// 正文输出间距默认1，构造后可按设置覆盖，不是token预算。
	private outputPad = 1;
	// 提前创建内置Mermaid显示转换器，仅保存回调/主题引用，真正处理Markdown时才解析图形。
	private readonly mermaidMarkdownTransformer: MarkdownTransformer = createMermaidMarkdownTransformer({
		// 箭头函数延迟读取当前设置管理器，避免字段初始化时就访问尚未赋值的runtimeHost；切会话后也读新设置。
		getMode: () => this.settingsManager.getMermaidRenderingMode(),
		// 属性简写把导入的theme交转换器着色，不在此请求终端颜色或生成图。
		theme,
	});

	// Skill commands: command name -> skill file path
	// 补全建立时记录“技能命令名→技能文件路径”；提交路径仍由session.prompt处理，不是Map里保存可执行函数。
	private skillCommands = new Map<string, string>();

	// Agent subscription unsubscribe function
	// 当前会话事件的退订函数；重绑前调用以免旧session继续向本UI投递。
	private unsubscribe?: () => void;
	// 保存本实例装上的信号/错误监听清理闭包，注销时逐个调用，不代表操作系统信号已被全部屏蔽。
	private signalCleanupHandlers: Array<() => void> = [];

	// Track if editor is in bash mode (text starts with !)
	// 文本首个非空白字符为!时的UI模式标记，用来换边框色和Escape行为；不单凭此字段执行shell。
	private isBashMode = false;

	// Track current bash execution component
	// 当前Bash输出组件；这是展示/路由槽，并不保存整个子进程句柄或提供强制终止保证。
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	// Agent仍在流式输出时先把Bash结果放待处理区，提交下一条消息时可挪到聊天区。
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	// 压缩期间临时替换Escape前，保存原编辑器回调供结束时恢复；不是AbortController本身。
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	// 自动重试期间同样保留旧Escape回调，重试结束恢复原路由。
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	// 压缩期间按输入顺序缓存文字与steer/followUp意图；完成后再与Session队列协调提交。
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	// 记录已请求退出，防止重复进入shutdown；某些路径等Agent结算后才真正清理和退出进程。
	private shutdownRequested = false;

	/** Reports working, blocked, done, and error states to terminals that support OSC 7501. */
	// 程序状态报告器按会话事件显示working/blocked/done/error，构造只保存下面两个getter，不会此刻读取未赋值的ui。
	private readonly programStatus = new ProgramStatusReporter(
		// 用箭头延迟取当前稳定ui的terminal，切换渲染器后仍能读到新的终端适配器。
		() => this.ui.terminal,
		// 每次报告时取当前会话名；名称不在这里截断或脱敏，具体输出格式由状态报告器/Terminal负责。
		() => this.sessionManager.getSessionName(),
	);

	/** The `/bug` hint is shown at most once per session so error output stays readable. */
	// 本实例是否已经给过/bug建议；虽然原英文按session描述，当前字段在会话重绑时没有另清零，不应理解为每个新session必定再提示。
	private bugReportHintShown = false;
	// 安装变化警告的一次性标记，与普通崩溃提示分开，避免同一实例反复展示。
	private installChangeWarningShown = false;

	// Extension UI state
	// Extension dialogs shown in the editor slot (select, confirm, input, editor, inline custom).
	// The last entry is visible; see pushExtensionDialog().
	// 用数组当对话栈，最后一项可见；每项保存组件与可选blocked状态，关闭顶层可重新显示下面一层。
	private extensionDialogs: Array<{ component: ExtensionDialogComponent; blocked: BlockedStatus | undefined }> = [];
	// 保存扩展的终端输入拦截订阅记录，Set按对象引用区分；切TUI实例时可按handler重新注册。
	private extensionTerminalInputSubscriptions = new Set<{
		// 处理器可返回consume消费输入、data改写输入或undefined不改；可选字段不等于已运行时校验对象。
		handler: (data: string) => { consume?: boolean; data?: string } | undefined;
		// 保存当前渲染器给的取消订阅闭包，重绑时会替换这项，避免只取消旧TUI监听。
		unsubscribe: () => void;
	}>();

	// Extension widgets (components rendered above/below the editor)
	// 编辑器上方插件区域按key保存组件，交叉类型允许可选dispose；重复key先移除/清理原对象。
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	// 下方插件区域有独立Map，同名key是否清两区由setExtensionWidget的具体流程决定。
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	// !是“确定赋值断言”，仅告诉TS会在构造中赋值，不会自动创建Container或插运行时检查。
	private widgetContainerAbove!: Container;
	// 下方插件容器同样稍后构造，和Map中保存的组件引用配合重建显示顺序。
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	// 自定义页脚可为空，空时恢复内置Footer；Component与可选dispose交叉后再整体允许undefined。
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	// 页头槽位容器，用于在内置页头与扩展页头间替换组件。
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	// 保留内置页头引用，可能在init建立后才存在，便于扩展移除自定义页头时恢复。
	private builtInHeader: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	// 可选自定义页头组件及清理能力，不在字段声明时执行扩展工厂。
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	// 保存本次启动选项的浅复制，部分字段由构造器规范；嵌套数组/Terminal等引用并不会深复制。
	private options: InteractiveModeOptions;
	// 保存一个固定右键回调供渲染器注册；箭头绑定当前实例this，readonly限制字段重赋。
	// 返回void，实际异步剪贴板流程交handleRightClickPaste处理；本回调本身不等待结果。
	private readonly onRightClickPaste = (): void => {
		// void明确丢弃Promise作为同步事件接口的返回值，并不自动catch拒绝；具体错误处理要看被调方法内部。
		void this.handleRightClickPaste();
	};
	// 可选记住隐式信任的cwd，reload发现资源变化时只针对匹配目录处理，不把所有新项目一并信任。
	private autoTrustOnReloadCwd: string | undefined;
	// 主题控制器协调设置、终端深浅/颜色通知和加载主题；构造器稍后创建并持有。
	private themeController: InteractiveThemeController;

	// Convenience accessors
	// 现取runtimeHost.session，无输入、不复制会话；例如切换会话后再次this.session读到新对象，不缓存旧值。
	private get session(): AgentSession {
		// getter返回当前引用，宿主若尚无有效session可按自己的契约抛错，不在UI里另兜底。
		return this.runtimeHost.session;
	}
	// 现取当前会话的Agent，返回类型由TS从return推断；不创建新Agent，也不发模型请求。
	private get agent() {
		// 先经过上面的session getter，再拿该会话拥有的agent。
		return this.session.agent;
	}
	// 现取当前会话的会话树管理器，无副作用；例如切会话后getSessionId来自新的SessionManager。
	private get sessionManager() {
		// 返回原管理器引用，不复制条目或打开会话文件。
		return this.session.sessionManager;
	}
	// 现取当前会话的设置管理器，供延迟回调在重绑后使用新设置；不在getter里读磁盘或持久化。
	private get settingsManager() {
		// 返回会话已经持有的manager，读写动作由后面的具体方法负责。
		return this.session.settingsManager;
	}

	// 装配交互UI，输入运行时宿主与可选启动覆盖，返回InteractiveMode实例；例如new InteractiveMode(runtime,{tuiMode:"fullscreen"})准备备用屏组件。
	// 顺序为登记会话替换钩子→选TUI并搭容器→载键位/编辑器/页脚→初始化主题；尚不调用ui.start，也不在此提交用户问题。
	// 但构造并非纯函数：读取键位配置、创建Git监听、修改共享TUI设置/主题并可能监听自定义主题文件；这些调用失败没有统一回滚/资源清理。
	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
		// 先存宿主，后面的settingsManager等getter才有当前session可取。
		this.runtimeHost = runtimeHost;
		// 将当前设置的终端能力覆盖应用到TUI共享能力层，影响之后能力判断，不等于真实终端握手。
		setCapabilityOverrides(this.settingsManager.getTerminalCapabilityOverrides());
		// ??仅缺null/undefined时才读设置；显式传入的布局优先，表达式也避免不必要的后备getter调用。
		const tuiMode = options.tuiMode ?? this.settingsManager.getTuiMode();
		// 展开拷贝options顶层，再用解析后的tuiMode覆盖同名字段；不深拷贝initialImages等数组。
		this.options = { ...options, tuiMode };
		// 保存可选隐式信任目录，构造此刻不写ProjectTrustStore。
		this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
		// 注册旧会话失效前的同步UI清理钩子；只是保存回调，旧session真正失效时才执行。
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			// 清扩展对话/组件与编辑器覆盖，避免旧扩展UI继续挂在界面；不等价于逐个解决所有对话等待Promise。
			this.resetExtensionUI();
		});
		// 注册会话替换后的异步重绑钩子，Runtime按自己的流程等待它；箭头保留当前InteractiveMode实例。
		this.runtimeHost.setRebindSession(async () => {
			// 先按新会话重画并绑定扩展/订阅，renderBeforeBind允许session_start前已有历史界面。
			await this.rebindCurrentSession({ renderBeforeBind: true });
			// 重绑完成后从当前设置应用主题；不在此等待终端颜色查询，主题控制器自己保存对应Promise。
			this.themeController.applyFromSettings();
		});
		// 记录应用版本常量，后面用于启动页头与变更提醒。
		this.version = VERSION;
		// 创建当前布局对应的TUI对象，传入终端和交互选项；创建不等于start，还未注册本类完整输入处理。
		this.renderer = createInteractiveTui({
			// 属性简写传上面解析后的布局，决定普通主屏或备用全屏实例。
			tuiMode,
			// 硬件光标显示开关来自当前设置，真正光标控制由TUI.start/render等处理。
			showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
			// 传应用数据目录作日志位置，路径由config辅助函数解析，不自行依赖__dirname。
			logDirectory: getAgentDir(),
			// 转发可注入Terminal，undefined时工厂使用当前进程适配器；不在此自动隔离其余系统副作用。
			terminal: options.terminal,
			// 同一箭头回调负责全屏右键粘贴意图，注册时不读取剪贴板。
			onRightClickPaste: this.onRightClickPaste,
			// 全屏选择复制开关，影响以后用户选择操作，并非此刻已经复制内容。
			fullscreenCopyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
			// 全屏鼠标滚轮每次滚动行数，交渲染器按契约使用。
			fullscreenWheelScrollLines: this.settingsManager.getFullscreenWheelScrollLines(),
		});
		// 用getter构建稳定Proxy，组件保存ui后仍转发到可替换renderer；不是把旧renderer方法永久绑定一次。
		this.ui = createInteractiveTuiReference(() => this.renderer);
		// 按设置控制内容缩小时是否清屏，实际输出发生在渲染器相应动作中。
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		// 创建页头容器，目前没有启动标识/扩展页头子组件。
		this.headerContainer = new Container();
		// 创建资源列表容器，后面showLoadedResources再填充。
		this.loadedResourcesContainer = new Container();
		// 创建聊天区，init或会话重绑时按已有条目重建。
		this.chatContainer = new Container();
		// 创建文档总容器，下面按页头→资源→聊天顺序挂载。
		this.documentContainer = new Container();
		// 第一个子项是页头槽位，其内部之后可以换成自定义页头。
		this.documentContainer.addChild(this.headerContainer);
		// 资源区接在页头后，安静启动时可以保持空。
		this.documentContainer.addChild(this.loadedResourcesContainer);
		// 聊天区放最后，以便全屏文档统一滚动。
		this.documentContainer.addChild(this.chatContainer);
		// 独立创建待提交消息区，避免把还没送模型的文字直接混作已保存聊天。
		this.pendingMessagesContainer = new Container();
		// 创建状态区，存进度等临时组件。
		this.statusContainer = new Container();
		// 创建编辑器上方插件容器，与extensionWidgetsAbove中组件配套。
		this.widgetContainerAbove = new Container();
		// 创建下方插件容器，稍后mountSharedComponents决定位置。
		this.widgetContainerBelow = new Container();
		// 读取应用数据目录的keybindings.json并合并默认/迁移后的覆盖；坏文件按管理器规则回默认，不是这里写用户配置。
		this.keybindings = KeybindingsManager.create();
		// 同时替换TUI共享键位管理器，使基础组件和本类传入的manager使用同一配置；这是模块共享状态变更。
		setKeybindings(this.keybindings);
		// 读取编辑器横向内边距，在创建默认编辑器时一次传入。
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		// 读取补全菜单最多可见项数，不是候选总量上限。
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		// 创建默认CustomEditor，传稳定ui、当前编辑器主题及应用键位；父Editor构造错误会向外传播。
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			// 属性显式赋值把局部editorPaddingX映射成选项paddingX。
			paddingX: editorPaddingX,
			// 同名属性简写转发补全可见数设置。
			autocompleteMaxVisible,
			// 明确启用边框内工作状态，后面仍需设置具体状态对象才显示。
			embedWorkingStatus: true,
		});
		// 初始活动编辑器就是内置实例，扩展setEditorComponent以后可替换editor而保留defaultEditor。
		this.editor = this.defaultEditor;
		// 创建输入区槽位，后面也可暂放选择器/扩展对话。
		this.editorContainer = new Container();
		// 把编辑器挂进去；as只向TS表达Component视图，不转换对象或增加渲染方法。
		this.editorContainer.addChild(this.editor as Component);
		// 以当前会话cwd创建页脚数据源，构造会探测Git元数据并尝试建立watcher，不只是赋一个路径字段。
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		// 页脚显示组件同时取得会话和数据源；它不自行启动Agent生成。
		this.footer = new FooterComponent(this.session, this.footerDataProvider);
		// 初始化自动压缩显示标志，反映当前session设置，不在此调用压缩模型。
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		// 创建页脚槽位，与可替换的具体footer组件分离。
		this.footerContainer = new Container();
		// 先挂内置页脚，之后扩展可以替换槽内内容。
		this.footerContainer.addChild(this.footer);

		// Load hide thinking block setting
		// 从设置初始化thinking显示，替换字段声明处的默认false。
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		// 从设置初始化输出间距，后面创建消息组件时使用。
		this.outputPad = this.settingsManager.getOutputPad();

		// Register themes from resource loader and initialize
		// 把资源加载器已发现的主题注册进主题模块，供名字查询/加载；本行不自己扫描所有主题目录。
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		// 创建主题控制器并初始化具体主题/文件监听与深浅订阅，尚未在此调用ui.start或主动颜色查询流程。
		this.themeController = new InteractiveThemeController(this.ui, {
			// 回调每次取当前设置管理器，因此切会话后不一直读旧manager。
			getSettingsManager: () => this.settingsManager,
			// 主题加载等错误交本UI的showError，文字展示可能继续影响组件树。
			showError: (message) => this.showError(message),
			// 主题变化后重算当前编辑器边框颜色，而不是把整个会话重新发送给模型。
			onChanged: () => this.updateEditorBorderColor(),
			// 转发本次初始主题覆盖，控制器保存为内存优先设置，不自动写入设置文件。
			initialThemeSetting: options.initialThemeSetting,
		});
	}

	// 把命令来源压成补全描述中的短标签，缺来源/内置来源返回undefined；例用户npm包可显示u:npm:包名。
	// 只读取元数据并解析Git来源文字，不安装包、不探测路径；无法识别包格式时仅保留u/p/t范围标记。
	private getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
		// Built-in extension commands are untagged, like built-in commands.
		// 没有元数据或source严格为builtin就省标签，和内置斜杠命令保持同一显示风格。
		if (!sourceInfo || sourceInfo.source === "builtin") {
			// 返回undefined表示不添加前缀，不是认证失败或资源不可用。
			return undefined;
		}

		// 嵌套三元依次映射user→u、project→p、其余→t；SourceScope类型里的第三种是temporary。
		const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
		// 裁来源两端空白供下方比较，不修改sourceInfo.source。
		const source = sourceInfo.source.trim();

		// auto/local/cli这三种字面来源不再展示包名，只按范围标记。
		if (source === "auto" || source === "local" || source === "cli") {
			// 返回先前计算的单字母，不附原磁盘路径。
			return scopePrefix;
		}

		// 仅检测npm:前缀，不在此验证npm包语法、版本或可下载性。
		if (source.startsWith("npm:")) {
			// 保留npm来源原有版本说明，前面只添加范围和冒号。
			return `${scopePrefix}:${source}`;
		}

		// 复用Git来源解析器识别协议/带git:标签的形式，只做本地字符串解析，不运行git或联网。
		const gitSource = parseGitUrl(source);
		// 解析器返回对象才生成Git标签；null时继续下面的范围兜底。
		if (gitSource) {
			// 有非空ref才添加@引用后缀；空缺使用空串，不出现文字undefined。
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			// 用解析后的主机/仓库路径/引用做显示，不展示所有原始URL细节，也不证明该仓库可访问。
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}

		// 未知来源格式也仍有范围标签，不把整个来源字符串直接暴露到补全描述。
		return scopePrefix;
	}

	// 将来源标签加到可选描述前，返回描述字符串或undefined；例描述“检查代码”配u得到“[u] 检查代码”。
	// 纯格式化，不注册命令；无描述时也可以单独显示来源标签，标签生成异常直接传播。
	private prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
		// 先按上述规则取得短标签，没有标签时下面不额外分配组合文字。
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		// undefined/空标签按无来源处理，保留调用方描述原样。
		if (!sourceTag) {
			// 原描述可以是undefined或空串，不在这一分支强制替换成默认文字。
			return description;
		}
		// 有标签时仅真值描述才补空格和正文；空字符串会变成只有方括号标签。
		return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
	}

	// 列出扩展原始命令名与内置命令冲突的警告，返回ResourceDiagnostic数组；例扩展也注册model时给补全冲突说明。
	// 不移除/执行扩展命令；getRegisteredCommands会重新解析调用名并清runner命令诊断，随后本方法另建UI警告。
	private getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
		// 用内置命令name建Set便于精确比较，不带开头斜杠，不做大小写转换。
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		// 从传入runner开始链式取命令/过滤/映射，最终返回新数组。
		return (
			extensionRunner
				// 读取带最终invocationName的解析命令列表，可能与原name不同；不调用handler。
				.getRegisteredCommands()
				// 只保留原name命中内置表的命令，其他命名冲突由runner自身解析规则处理。
				.filter((command) => builtinNames.has(command.name))
				// 每个冲突命令映射成新诊断对象；箭头后({})表示返回对象而非函数块。
				.map((command) => ({
					// as const保留warning字面量类型以匹配诊断联合，不冻结对象或做运行时校验。
					type: "warning" as const,
					// 警告内容分两种情况选择，不改变真正命令注册状态。
					// 最终调用名仍等于原名时，提示它不会进这里的补全候选，不能解读成已删除扩展功能。
					// 若runner分配了另一个调用名，就把可用别名写进警告；实际命令查找仍由runner负责。
					message:
						// 最终调用名仍与原名相同，说明这条提示不能给出另一个调用名。
						command.invocationName === command.name
							? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
							: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
					// 携带扩展来源路径供诊断定位，不在此读取/验证该路径。
					path: command.sourceInfo.path,
				}))
		);
	}

	// 建立斜杠命令/参数/文件路径的基础补全器，返回AutocompleteProvider；例/model输入可按provider/id选择候选。
	// 先复制内置描述并补三种参数回调，再加模板/扩展/技能命令，最后交CombinedAutocompleteProvider。
	// 会清空并重建本实例skillCommands，读取当前资源/设置；构造补全器不立即扫描文件或运行fd，后续getSuggestions才可能做这些操作。
	private createBaseAutocompleteProvider(): AutocompleteProvider {
		// Define commands for autocomplete
		// 把内置表映射成新命令对象，类型注解要求满足SlashCommand；不会把回调直接写回共享BUILTIN_SLASH_COMMANDS。
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			// 命令名保留原值，不加/前缀；基础提供者处理实际补全格式。
			name: command.name,
			// 沿用内置说明，不在这里翻译或改提示字符串。
			description: command.description,
			// 条件对象展开：argumentHint真值时才加这个字段，空串/undefined均不展开属性。
			...(command.argumentHint && { argumentHint: command.argumentHint }),
		}));

		// 从新对象数组里找model项，find无匹配返回undefined。
		const modelCommand = slashCommands.find((command) => command.name === "model");
		// 只在内置表确实有model时安装参数补全，避免访问undefined。
		if (modelCommand) {
			// 保存同步补全回调，真正输入/model参数时才运行；函数返回数组或null，不发刷新请求。
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				// 模型候选按范围配置与现有可用快照二选一，变量类型由两个分支共同推断。
				// 有会话范围时只取记录里的model对象引用，范围项还可带思考级别。
				// 无范围时取最近发布的可用列表，不检查刚变化的凭证、不等待目录刷新，所以候选可以暂时滞后。
				const models =
					// scopedModels非空表示使用会话给定范围；空数组在此代表走全量快照，不是没有任何可选模型。
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRuntime.getAvailableSnapshot();

				// 没有模型时返回null表示不给参数补全，而非弹错或触发登录。
				if (models.length === 0) return null;

				// Create items with provider/id format
				// 将每个模型投影成搜索/展示所需字段，新建浅对象，不复制完整能力/价格等数据。
				const items = models.map((m) => ({
					// 模型裸ID用于显示，可能自身包含命名空间斜杠。
					id: m.id,
					// 保留真实注册供应商ID，与模型id内文字不混淆。
					provider: m.provider,
					// 保留人类名称以便getModelSearchText纳入检索，未在此重新生成名称。
					name: m.name,
					// 补全写入值使用provider/id完整身份，避免不同供应商同ID直接混作一项。
					label: `${m.provider}/${m.id}`,
				}));

				// 先按模型搜索规则模糊筛选，再转TUI候选；回调创建显示记录，搜不到由公共助手返回null。
				return createFuzzyAutocompleteItems(items, prefix, getModelSearchText, (item) => ({
					// value是应用候选时写进命令参数的完整label。
					value: item.label,
					// 菜单主要标签只放裸ID，供应商在description中另显示。
					label: item.id,
					// 描述使用供应商ID，不把整个模型对象转JSON。
					description: item.provider,
				}));
			};
		}

		// 同样查新列表的thinking命令，不在此执行思考级别切换。
		const thinkingCommand = slashCommands.find((command) => command.name === "thinking");
		// 找到才写回调，缺命令就保留原命令数组不报错。
		if (thinkingCommand) {
			// 回调执行时现取当前模型支持的级别，切模型后无需为这一数据单独缓存旧列表。
			thinkingCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				// 通用模糊补全助手负责空结果和映射，不另实现一套前缀筛选。
				return createFuzzyAutocompleteItems(
					// 按当前模型能力返回级别；没有模型时Session方法按自身契约返回全部选项副本，不查询真实服务能力。
					this.session.getAvailableThinkingLevels(),
					// 把用户已输入的参数前缀作为查询文字，空前缀也可列出全部。
					prefix,
					// 级别本身就是字符串，直接作为搜索文本。
					(level) => level,
					// 同一候选再映射成补全记录，不改变Session的thinkingLevel。
					(level) => ({
						// 选中后写入级别原字符串，例如high。
						value: level,
						// 菜单标签也用同一个级别名，没有另加供应商说明。
						label: level,
					}),
				);
			};
		}

		// 查login命令，下面只生成参数候选，不因补全触发认证。
		const loginCommand = slashCommands.find((command) => command.name === "login");
		// 内置表包含login时才安装该功能。
		if (loginCommand) {
			// 参数回调每次现读可展示供应商信息，返回同步列表/null；不在这里调用loginProvider。
			loginCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				// 先取得按认证方式区分的菜单项，再按ID合并，避免同一供应商在补全里出现两次。
				const providers = getLoginProviderCompletionOptions(this.getLoginProviderOptions());
				// 用ID/名称/认证标签共同检索，显示描述复用同一格式规则。
				return createFuzzyAutocompleteItems(providers, prefix, getLoginProviderSearchText, (provider) => ({
					// 写入值是供应商ID，认证方式在真正登录时再选择。
					value: provider.id,
					// 主要标签也显示ID，便于用户知道命令参数是什么。
					label: provider.id,
					// 描述补充名称和OAuth/API key等标签，不在此验证登录成功或凭证有效期。
					description: formatLoginProviderCompletionDescription(provider),
				}));
			};
		}

		// Convert prompt templates to SlashCommand format for autocomplete
		// 把当前promptTemplates转换成SlashCommand；这是命令补全视图，不立即展开模板正文。
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			// 沿用模板名，选中后上层以相应命令输入处理。
			name: cmd.name,
			// 说明前可带u/p/t或包来源标签，帮助区分同类资源来源。
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			// 仅有真值参数提示才加字段，语法与上面内置命令转换一致。
			...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
		}));

		// Convert extension commands to SlashCommand format
		// 用内置名建去重集合，为下一段扩展候选过滤；并不包括模板名或技能名。
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		// 从当前Session的扩展runner取得命令，类型注解只约束最终补全对象数组。
		const extensionCommands: SlashCommand[] = this.session.extensionRunner
			// 重新解析最终调用名并清runner命令诊断；该调用不会执行命令handler。
			.getRegisteredCommands()
			// 原始name与内置名相同就跳过这个补全入口，即使invocationName另有别名，这一条件仍按原name判断。
			.filter((cmd) => !builtinCommandNames.has(cmd.name))
			// 其余命令投影为新补全描述，不改变runner中的注册记录。
			.map((cmd) => ({
				// 使用runner分配的invocationName，而非原始name，保留扩展间名称冲突的解析结果。
				name: cmd.invocationName,
				// 说明加上来源短标签，来源信息缺失则保留原描述。
				description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
				// 直接传扩展已有的参数补全函数引用，查询时它可能同步/异步执行或抛错，本方法不额外包catch。
				getArgumentCompletions: cmd.getArgumentCompletions,
			}));

		// Build skill commands from session.skills (if enabled)
		// 每次重建基础补全都先清旧技能映射，避免已删除技能仍留在内部Map。
		this.skillCommands.clear();
		// 准备新的技能候选数组，默认空；设置关闭时保持空列表。
		const skillCommandList: SlashCommand[] = [];
		// 仅设置允许技能命令才遍历资源加载器的技能集合，不等于阻止其他入口使用技能。
		if (this.settingsManager.getEnableSkillCommands()) {
			// 读取已经加载/筛选的技能数组，不在这个循环里再扫描目录。
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				// 加skill:命名空间形成命令名，例如skill:review，不含开头/。
				const commandName = `skill:${skill.name}`;
				// 保存命令到技能文件路径的对应关系，后面命令处理可借它定位；这里不读技能正文。
				this.skillCommands.set(commandName, skill.filePath);
				// 向新的补全数组加入该技能的一项。
				skillCommandList.push({
					// 主名称与上面Map使用完全相同的commandName。
					name: commandName,
					// 技能说明同样附来源，实际描述文字保持资源提供的值。
					description: this.prefixAutocompleteDescription(skill.description, skill.sourceInfo),
				});
			}
		}

		// 构造组合补全器，保存候选/基目录/fd路径，稍后查询可同时处理斜杠命令和文件。
		return new CombinedAutocompleteProvider(
			// 数组展开按内置→模板→扩展→技能排列，不在这里为所有组做额外同名去重。
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			// 文件路径补全以当前会话cwd为基准，不使用随意捕获的旧进程目录。
			this.sessionManager.getCwd(),
			// 传已准备的fd可执行路径；undefined触发构造器默认null，禁用其fd模糊查询分支，不禁所有同步路径补全。
			this.fdPath,
		);
	}

	// 重建基础补全并依次套扩展wrapper，保存结果并更新默认/当前编辑器；例两个wrapper按注册顺序依次包裹。
	// 会修改本实例和编辑器补全配置；wrapper可同步抛错，没有统一回滚，当前编辑器不支持可选setter时仅更新默认编辑器。
	private setupAutocompleteProvider(): void {
		// let允许每轮将provider换成wrapper返回的新对象，初值来自刚构建的基础提供者。
		let provider = this.createBaseAutocompleteProvider();
		// 收集每次包装后provider暴露的触发字符，尚未单独从基础provider拷贝。
		const triggerCharacters: string[] = [];
		// for...of按wrapper注册顺序执行，不并行调用这些工厂。
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			// 每个工厂接前一层provider；返回对象成为下一层输入，工厂自己决定是否保留内部能力。
			provider = wrapProvider(provider);
			// 可选字段缺省用空数组，再展开入收集表；这里只收集包装后的对象，基础触发字符须由wrapper透传才会被看到。
			triggerCharacters.push(...(provider.triggerCharacters ?? []));
		}
		// 至少收集到一个字符才重设最终provider的triggerCharacters，空列表时不覆盖它自己的字段。
		if (triggerCharacters.length > 0) {
			// Set按首次出现顺序去重，再转新数组写进最终provider；不规范字符长度或检查运行时内容。
			provider.triggerCharacters = [...new Set(triggerCharacters)];
		}

		// 保存完成后的提供者，扩展切换编辑器时可再注入同一引用。
		this.autocompleteProvider = provider;
		// 内置编辑器必有setter，立即替换其补全引用，不等到用户首次查询才设置。
		this.defaultEditor.setAutocompleteProvider(provider);
		// 活动编辑器不同于默认对象时才另外处理，避免同一对象调用两次。
		if (this.editor !== this.defaultEditor) {
			// ?.只在自定义编辑器提供方法时调用；缺方法就跳过，不用运行时补一个默认实现。
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	// 把Pi和扩展的新版本内容追加到聊天区，一次性返回void；例折叠设置下显示简短更新提示。
	// 先置startupNoticesShown，再判内容/构建边框；即使本次内容为空或后面渲染构造失败，本实例以后也不会自动重试此方法。
	private showStartupNoticesIfNeeded(): void {
		// 已走过通知流程就直接退出，不重复追加同一批消息。
		if (this.startupNoticesShown) {
			// 提前return既不重绘也不重新读取CHANGELOG。
			return;
		}
		// 先设置门禁，下面没有内容的分支也会保留true。
		this.startupNoticesShown = true;

		// Pi正文空缺且扩展数组空才完全不画提示；任一有内容都继续。
		if (!this.changelogMarkdown && this.extensionChangelogUpdates.length === 0) {
			// 无通知不追加空边框，但一次性标记已经设置。
			return;
		}

		// 聊天已有内容时先加空行，空聊天从边框开始。
		if (this.chatContainer.children.length > 0) {
			// Spacer(1)是占一行的显示组件，不写空条目进SessionManager。
			this.chatContainer.addChild(new Spacer(1));
		}
		// 加主题化分隔边框，界定这批更新通知的起点。
		this.chatContainer.addChild(new DynamicBorder());
		// 只有Pi更新正文真值时才加Pi一节，扩展更新可以独立显示。
		if (this.changelogMarkdown) {
			// 折叠配置决定显示摘要或完整Markdown，不改变存储的changelogMarkdown。
			if (this.settingsManager.getCollapseChangelog()) {
				// 正则在正文中找首个形如版本标题的数字三元组；无锚点/无g，不验证整个文档格式或预发布版本完整性。
				const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
				// 匹配时取第一个捕获组，否则用当前应用version兜底；不是查询最新远程发布。
				const latestVersion = versionMatch ? versionMatch[1] : this.version;
				// 拼简短提示并把/changelog加粗，这个Text文案在创建时就嵌入当前主题样式。
				const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
				// 用水平边距1、垂直边距0的Text插入聊天，不调用模型或保存历史消息。
				this.chatContainer.addChild(new Text(condensedText, 1, 0));
			} else {
				// 展开模式标题用ThemedText延迟取颜色，主题失效后可重新计算；此处尚未渲染它。
				this.chatContainer.addChild(new ThemedText(() => theme.bold(theme.fg("accent", "What's New")), 1, 0));
				// 标题与正文之间留一行。
				this.chatContainer.addChild(new Spacer(1));
				// 构造并追加完整Pi更新正文组件，参数跨行属于同一个addChild调用。
				this.chatContainer.addChild(
					// 正文只trim两端，使用当前Markdown设置主题，保留内部更新文字与链接。
					new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
				);
				// 正文后留一行，和结尾边框/下一节分开。
				this.chatContainer.addChild(new Spacer(1));
			}
		}
		// 扩展更新数组非空才画扩展一节，不按Pi更新是否存在决定。
		if (this.extensionChangelogUpdates.length > 0) {
			// 若前面已有Pi内容，再留节间空行；否则直接显示扩展标题/摘要。
			if (this.changelogMarkdown) {
				// 这一行只增加布局空白，不生成额外更新记录。
				this.chatContainer.addChild(new Spacer(1));
			}
			// 扩展更新沿用同一折叠配置，不能单独为某个扩展在这里配置展开。
			if (this.settingsManager.getCollapseChangelog()) {
				// 折叠模式先把各扩展摘要拼成多行文本。
				const condensedText = this.extensionChangelogUpdates
					// 每项只显示名字与当前版本，不含完整更新正文，也不在这里比较版本新旧。
					.map((update) => `Updated ${update.name} to v${update.version}.`)
					// 按列表顺序用LF连接，数组不会被改变。
					.join("\n");
				// 把一次性拼好的摘要Text插入聊天，样式不通过ThemedText延迟重算。
				this.chatContainer.addChild(new Text(condensedText, 1, 0));
			} else {
				// 完整模式先加主题化扩展更新标题。
				this.chatContainer.addChild(
					// 标题渲染时现取accent和bold，换主题可在失效后重建。
					new ThemedText(() => theme.bold(theme.fg("accent", "Extension Updates")), 1, 0),
				);
				// 标题与合并正文之间留一行。
				this.chatContainer.addChild(new Spacer(1));
				// 按扩展记录顺序合并Markdown，两段之间加空白行，不做此处去重或再次解析更新版本。
				const markdown = this.extensionChangelogUpdates.map((update) => update.markdown).join("\n\n");
				// 使用同一Markdown显示主题渲染合并正文，参数1/0是边距，不是费用或字符限制。
				this.chatContainer.addChild(new Markdown(markdown, 1, 0, this.getMarkdownThemeWithSettings()));
				// 正文之后留空行，再接共同结尾边框。
				this.chatContainer.addChild(new Spacer(1));
			}
		}
		// 加结束边框；本方法仅改组件树，真正终端绘制由后续TUI调度。
		this.chatContainer.addChild(new DynamicBorder());
	}

	// 将一组共享组件按顺序挂到给定TUI，视口TUI再设全屏布局根，返回void；例切换屏幕后重用原聊天/编辑器对象。
	// 不启动终端、不复制组件状态；若视口根未初始化就抛错，此时前面的addChild已发生，没有回滚。
	private mountInteractiveTui(tui: TuiMainScreen | TuiAltScreen, components: readonly Component[]): void {
		// readonly只限制传入数组的写操作，for...of仍可把原组件引用挂进另一个容器。
		for (const component of components) tui.addChild(component);
		// 能力守卫检查符号标记并让TS把tui缩窄成ViewportTUI，不是对所有方法逐项做校验。
		if (TuiLayouts.isViewportTUI(tui)) {
			// 视口布局必须已由init创建；否则明确throw而不是静默退普通聊天树。
			if (!this.fullscreenLayoutRoot) throw new Error("Fullscreen layout is not initialized");
			// 将独立布局根交给视口TUI，内部可安排重绘；基础children与布局根不是互相复制的两棵内容树。
			tui.setLayoutRoot(this.fullscreenLayoutRoot);
		}
	}

	// 停止交互渲染器；全屏选transcript时先清浮层→切主屏→画一遍记录，再stop，其他情况按当前模式停。
	// 例全屏退出保留可滚动聊天记录时选transcript；会写终端/重挂组件，不负责关闭AgentSessionRuntime或等待模型结束，异常可传播。
	private stopInteractiveTui(fullscreenExitOutput: FullscreenExitOutput): void {
		// 仅当前真是fullscreen且设置精确为transcript才走导出聊天到主屏的路径。
		if (this.renderer.mode === "fullscreen" && fullscreenExitOutput === "transcript") {
			// hasOverlayEntries包括暂时隐藏的条目，while逐个移除到栈空，避免切模式被overlay门禁拒绝。
			while (this.renderer.hasOverlayEntries) this.renderer.hideOverlay();
			// 传false关闭进度恢复与新渲染器start，先只换对象和共享组件；这里未检查返回布尔。
			this.switchTuiMode("regular", false, false);
			// 在新主屏上立即绘制一次，让聊天记录留在普通屏幕；renderNow可在尚未start的初始实例执行。
			this.renderer.renderNow();
		}
		// 通过稳定ui停当前实例，仍全屏时preserveScreen=true；transcript分支已换主屏，因此传false走主屏停止规则。
		this.ui.stop({ preserveScreen: this.renderer.mode === "fullscreen" });
	}

	// 替换主屏/全屏渲染器并迁移共享组件/焦点/部分主屏缓存，返回是否接受切换；例有overlay时返回false不改模式。
	// 同模式直接true；真正切换先stop清旧对象，再建/挂新对象，按startRenderer决定是否start与重绑监听，按restoreProgress决定恢复进度。
	// 这是终端/组件状态变更，没有统一try/finally或失败回滚；true表示这条切换流程正常返回，不保证屏幕实际显示或所有异步任务结束。
	private switchTuiMode(mode: TuiMode, restoreProgress = true, startRenderer = true): boolean {
		// 保存旧对象局部引用，后面改this.renderer时仍能访问旧状态。
		const previousUi = this.renderer;
		// 模式已相同直接成功，不重启终端、不重挂组件或更新其他设置。
		if (mode === previousUi.mode) return true;
		// 任意浮层条目存在都拒绝，包括隐藏浮层，防止迁移时丢失overlay栈/焦点关系。
		if (previousUi.hasOverlayEntries) return false;

		// 浅复制children数组，只保存原组件引用；组件内部文本/选择状态仍随同一对象保留。
		const components = [...previousUi.children];
		// 记下旧焦点组件或null，之后尝试给新TUI设置焦点。
		const focus = previousUi.getFocusedComponent();
		// 复用同一Terminal适配器，不为新模式另开一个终端连接。
		const terminal = previousUi.terminal;
		// 读取当前硬件光标策略，保留运行期间可能更新的值。
		const showHardwareCursor = previousUi.getShowHardwareCursor();
		// 同样保留缩短清屏策略，而不重新从设置覆盖它。
		const clearOnShrink = previousUi.getClearOnShrink();
		// 保存可选调试回调，以便切换后快捷键仍能调用同一入口。
		const onDebug = previousUi.onDebug;
		// 只有旧对象为真实TuiMainScreen才捕获主屏专用缓存，instanceof同时让TS缩窄类型。
		if (previousUi instanceof TuiMainScreen) {
			// 捕获行/尺寸/光标等渲染缓存，不是保存整个终端、焦点或图片内容快照。
			this.mainScreenRenderState = previousUi.captureRenderState();
		}

		// 停止旧输入/输出生命周期并要求保留当前画面；随后还会清对象树，stop失败不由这里兜底。
		previousUi.stop({ preserveScreen: true });
		// 清旧焦点，避免同一编辑器在旧TUI仍保持焦点关系。
		previousUi.setFocus(null);
		// 清掉旧容器children，不销毁共享子组件；这些对象稍后挂进新TUI。
		previousUi.clear();
		// 若旧TUI有独立布局根也解除引用，避免旧渲染器继续持有完整布局。
		if (TuiLayouts.isViewportTUI(previousUi)) previousUi.setLayoutRoot(undefined);

		// 按目标模式创建新渲染器，下面把保留的终端/光标策略与当前全屏选项一起传入。
		const nextUi = createInteractiveTui({
			// 目标mode决定新实例类型，字段名tuiMode与参数名mode不同，需显式写键值。
			tuiMode: mode,
			// 沿用刚从旧实例读出的光标设置，属性简写不重新查SettingsManager。
			showHardwareCursor,
			// 日志位置重新通过config辅助函数解析，不直接从旧TUI私有字段读取。
			logDirectory: getAgentDir(),
			// 沿用Terminal对象，真正start时由它重新接收输入/尺寸变化回调。
			terminal,
			// 重新交本实例固定的右键粘贴入口，不在此读取系统剪贴板。
			onRightClickPaste: this.onRightClickPaste,
			// 全屏选择复制配置重新从当前会话设置读取，而不是捕获旧渲染器所有私有状态。
			fullscreenCopyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
			// 全屏滚轮行数同样按当前设置传递。
			fullscreenWheelScrollLines: this.settingsManager.getFullscreenWheelScrollLines(),
		});
		// 恢复上面保存的clearOnShrink，不调用设置持久化方法。
		nextUi.setClearOnShrink(clearOnShrink);
		// 把调试回调引用迁移到新实例，没有在此执行调试输出。
		nextUi.onDebug = onDebug;
		// 新实例为主屏且此前保存过主屏缓存才恢复；从未进过主屏时不伪造一份缓存。
		if (nextUi instanceof TuiMainScreen && this.mainScreenRenderState) {
			// restoreRenderState恢复普通行/尺寸估计并清图片缓存，不承诺完整还原真实终端状态。
			nextUi.restoreRenderState(this.mainScreenRenderState);
		}
		// 现在替换实际renderer，稳定ui代理从这一步起会转到新对象。
		this.renderer = nextUi;
		// 同时更新本实例options中的布局选择，未在这行写SettingsManager或磁盘。
		this.options.tuiMode = mode;
		// 重挂原共享组件，视口模式另设已有布局根；失败时this.renderer已是新对象，不会自动回旧实例。
		this.mountInteractiveTui(nextUi, components);
		// 让组件/渲染缓存失效，下次重绘重新取得内容与布局。
		nextUi.invalidate();
		// 恢复保存的焦点引用，未在此新建编辑器或复制输入文本。
		nextUi.setFocus(focus);
		// 不要求start时到这里就返回true，下面主题/输入监听/进度恢复都不会执行；退出转transcript使用这个分支。
		if (!startRenderer) return true;
		// 启动新渲染器的真实终端生命周期，可能设置raw模式/输出控制序列；不是单纯切一个布尔。
		nextUi.start();
		// 主题控制器通过稳定ui退旧订新深浅监听并应用通知开关，不重新创建控制器。
		this.themeController.rebindTui();
		// 把扩展保留的输入handler注册到新TUI并更新退订槽，避免它们只挂在旧实例。
		this.rebindExtensionTerminalInputListeners();
		// 跨行&&组合三个条件，全部满足才恢复终端工作进度显示。
		if (
			// 调用方必须允许恢复，停止流程可传false跳过。
			restoreProgress &&
			// 当前设置也必须允许终端进度，不因Agent忙就强制输出。
			this.settingsManager.getShowTerminalProgress() &&
			// 会话正在流式生成或压缩任一为真就视为仍有工作，括号将两种状态合在同一必要条件中。
			(this.session.isStreaming || this.session.isCompacting)
		) {
			// 向复用Terminal发送工作进度状态；不检查远端任务实际完成度，也不恢复具体百分比。
			terminal.setProgress(true);
		}
		// 正常走完返回true，不等待未来绘制帧或主题颜色查询结算。
		return true;
	}

	// 启动交互界面，返回Promise<void>；流程为装信号/更新信息→挂共享布局→启动TUI→等首轮颜色→构造页头→准备fd/rg→开输入处理→绑定扩展/历史→注册重绘通知。
	// 例如run先await init，之后再提交initialMessage；init会产生终端I/O、文件读取/监听，工具缺失时还可能下载，扩展启动处理器也可能有自己的副作用。
	// isInitialized在ui.start后就置true，不是整个方法完成的保证；后续异常没有统一finally回滚，重复调用看到true就直接返回，不等待先前仍在进行的初始化。
	async init(): Promise<void> {
		// 已标记启动就返回兑现void的Promise，不再次建布局/下载；它不是共享“首轮init完成Promise”。
		if (this.isInitialized) return;

		// 安装退出信号和终端/进程错误监听，清理逻辑在对应方法中；这一步发生在ui.start之前。
		this.registerSignalHandlers();

		// Load changelogs (only show new entries, skip for resumed sessions)
		// 取得本次应显示的Pi更新正文，方法可读CHANGELOG、更新设置记录并安排安装遥测；恢复会话按其规则省略。
		this.changelogMarkdown = this.getChangelogForDisplay();
		// 收集已加载扩展的新版本更新，记录版本并整理Markdown；不是重新安装或刷新扩展包。
		this.extensionChangelogUpdates = this.getExtensionChangelogUpdates();

		// Fullscreen renders on the alternate screen, so text printed to stdout here would stay in the shell
		// after exit. Fullscreen shows the notice in the header instead (#11508).
		// 普通屏才允许直接console输出范围提示，全屏留到页头，避免文字留在退出后的普通shell屏幕。
		if (this.renderer.mode !== "fullscreen") {
			// 根据当前范围与启动详细程度计算可选提示，不在这里刷新模型目录。
			const modelScopeNotice = this.getModelScopeNotice();
			// 有提示才直接写stdout，不通过chatContainer保存，也不写进模型消息。
			if (modelScopeNotice) console.log(modelScopeNotice);
		}

		// Keep one component tree and remount it when changing renderers.
		// 先填插件区域的初始占位/现有组件，后续布局引用同一容器，不等待扩展加载完成才创建槽位。
		this.renderWidgets(); // Initialize with default spacer
		// 建立聊天滚动区+底部输入dock的全屏布局包装，当前普通模式也先准备，供以后切屏复用。
		const viewport = createChatViewport({
			// 上方document含页头/资源/聊天，统一进入记录滚动区。
			document: this.documentContainer,
			// 待提交消息留在dock，滚动聊天时不随正文一起移走。
			pendingMessages: this.pendingMessagesContainer,
			// 状态区同样交底部布局，不放进模型上下文。
			status: this.statusContainer,
			// 编辑器上方插件槽，容器存在但此时可以为空/只有占位。
			widgetsAbove: this.widgetContainerAbove,
			// 当前输入区槽位作为布局项，而非固定只绑定defaultEditor对象。
			editor: this.editorContainer,
			// 编辑器下方插件槽放在页脚前。
			widgetsBelow: this.widgetContainerBelow,
			// 底部最后一项为页脚容器，扩展替换页脚后布局仍引用这个容器。
			footer: this.footerContainer,
			// 滚动条策略从当前设置取，实际布局/显示时机交ScrollView处理。
			scrollbar: this.settingsManager.getFullscreenScrollbar(),
			// 轨道着色回调在绘制需要时取当前主题，传入时不运行。
			scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
			// 滑块使用另一主题颜色，与轨道分开；参数text是既有符号文本，不在此计算滚动比例。
			scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
		});
		// 保留真正装进viewport中的ScrollView引用，后面可操作选择/滚动条。
		this.transcriptScrollView = viewport.transcript;
		// 保留VStack布局根供视口TUI挂载，不将整个布局树复制一次。
		this.fullscreenLayoutRoot = viewport.root;
		// 按基础TUI children顺序挂共享区域，同时对全屏TUI设独立布局根。
		this.mountInteractiveTui(this.renderer, [
			// 普通主屏首先顺序渲染整个文档，包括页头、资源和聊天。
			this.documentContainer,
			// 之后是还没正式进入会话的排队消息显示。
			this.pendingMessagesContainer,
			// 状态区域排在待发送消息之后。
			this.statusContainer,
			// 编辑器上方插件容器接在状态后。
			this.widgetContainerAbove,
			// 输入槽位随后，可在对话期间由选择器/扩展组件接管。
			this.editorContainer,
			// 下方插件区域保持独立，不混入输入文本。
			this.widgetContainerBelow,
			// 最后挂页脚；全屏模式具体几何仍由viewport.root布局，不只按这个列表堆满屏。
			this.footerContainer,
		]);
		// Accept text while startup completes, but only enable interrupt, exit, and submission feedback.
		// 启动未结束时先给app.clear安装CtrlC语义处理；实际按键由配置映射，方法名不表示硬编码ctrl+c。
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		// 空编辑器退出入口先可用，CustomEditor自身负责何时把输入路由到onCtrlD。
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		// 启动中提交只保留文字并提示“仍在启动”，不会通过这个回调提前发模型请求。
		this.defaultEditor.onSubmit = (text) => this.handleStartupSubmit(text);
		// 先给当前editor焦点，用户可输入；完整业务快捷键/提交回调还在后面准备完工具才安装。
		this.ui.setFocus(this.editor);

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		// 真正开始终端输入/渲染生命周期，必须在扩展session_start前完成，使扩展对话可交互。
		this.ui.start();
		// 立即记TUI已经启动；此时工具、扩展、历史和语法库仍未全部初始化。
		this.isInitialized = true;
		// 把当前idle等程序状态报告给Terminal，是否实际写协议取决于终端适配器支持。
		this.programStatus.report();
		// 按Kitty图片能力尝试后台登记PNG转码器，成功回调使UI失效/重绘；此处不await该加载。
		this.ensurePngTranscoder();

		// 立即应用主题设置并发起终端颜色查询，控制器记录当前待等Promise。
		this.themeController.applyFromSettings();
		// The header and startup notices bake theme colors into their text, so build them once the terminal
		// reported its colors. This ends at the terminal's DA1 reply, or after 100 ms if it answers nothing.
		// 等待最新查询首轮结果/超时后的应用，迟到颜色仍可能随后生效；不保证终端提供了完整调色板。
		await this.themeController.waitForTerminalColors();

		// Add header with keybindings from config (unless silenced)
		// 按启动安静/详细规则决定是否画完整页头；这不是关闭整个UI。
		if (this.shouldShowStartupHeader()) {
			// 保存本次是否展示更多资源细节的判断，下面引导文案闭包捕获此布尔值。
			const showDetails = this.shouldShowStartupDetails();
			// Built on demand so the header follows theme changes. The logo's first line carries the version,
			// its second line the first line of key hints. Terminals that cannot render the logo get a
			// "Pi vX" line instead, with the key hints below it.
			// 按Apple Terminal等环境线索决定半块logo或文字备选；没有进行实际像素试绘。
			const showLogo = supportsPiLogo();
			// 局部格式函数接提示文字，返回带版本的两行logo/文字页头；纯拼接，不播放动画或写终端。
			const withLogo = (hints: string) => {
				// 不支持半块图时用Pi文字品牌标识，版本用弱色，再换行接原提示；模板内每个换行都保留为内容。
				if (!showLogo) return `${piWordmark()} ${theme.fg("dim", `v${this.version}`)}\n${hints}`;
				// 二元组解构取得logo上/下两行，样式按调用当时主题颜色模式生成。
				const [top, bottom] = piLogoLines();
				// 把版本接在上行、提示首行接在下行，hints含多行时剩余部分自然延续。
				return `${top} ${theme.fg("dim", `v${this.version}`)}\n${bottom} ${hints}`;
			};

			// Build startup instructions using keybinding hint helpers
			// 局部箭头复用应用键位提示格式，参数类型限制为可配置AppKeybinding；它只生成文字，不登记快捷键处理器。
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

			// 完整启动帮助的延迟构建函数，每次调用都按当前键位/主题重建字符串；例如展开页头时显示全部操作。
			const expandedInstructions = () =>
				// 先收集逐行提示，再在数组结尾统一用LF连接，不立刻向终端逐行输出。
				[
					// 展示中断动作绑定，不在这里触发abort。
					hint("app.interrupt", "to interrupt"),
					// 展示清空输入动作绑定，实际清空由后面的输入处理器完成。
					hint("app.clear", "to clear"),
					// 取清空动作当前键位，并说明连续两次退出；twice只是展示文字，计时逻辑在handleCtrlC。
					rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
					// 说明退出动作仅在编辑器为空时适用，行为由CustomEditor路由限制。
					hint("app.exit", "to exit (empty)"),
					// 展示挂起动作，平台支持与信号处理由实际方法决定。
					hint("app.suspend", "to suspend"),
					// 基础TUI编辑器的删至行尾提示，也读取共享可配置键位。
					keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
					// 展示循环思考级别入口，不在构造帮助时改thinkingLevel。
					hint("app.thinking.cycle", "to cycle thinking level"),
					// 用原始组合标签展示前/后模型切换的两个键位，而不是另定义一个动作。
					rawKeyHint(
						// 分别读取正向/反向动作的当前按键，斜杠只连接显示。
						`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`,
						// 给上述组合键加“切模型”说明，不查询可循环的模型。
						"to cycle models",
					),
					// 展示打开模型选择器动作，而非马上弹选择框。
					hint("app.model.select", "to select model"),
					// 展示展开工具/更多内容动作，实际处理还可影响其他Expandable组件。
					hint("app.tools.expand", "to expand tools"),
					// 展示思考块显示切换，和模型思考计算级别不同。
					hint("app.thinking.toggle", "to expand thinking"),
					// 展示外部编辑器入口，创建这段帮助不会启动用户编辑器。
					hint("app.editor.external", "for external editor"),
					// 斜杠本身是命令输入语法，用rawKeyHint而非某个App动作ID。
					rawKeyHint("/", "for commands"),
					// 说明!可运行Bash，实际执行要等用户提交并经过钩子/会话路径。
					rawKeyHint("!", "to run bash"),
					// 说明!!的无上下文变体，不在帮助构建时修改历史。
					rawKeyHint("!!", "to run bash (no context)"),
					// 展示排队追问动作，与流中插话steer的提交方式区分。
					hint("app.message.followUp", "to queue follow-up"),
					// 展示取回队列以编辑的动作，具体取出顺序在restoreQueuedMessagesToEditor。
					hint("app.message.dequeue", "to edit all queued messages"),
					// 粘贴动作的说明包含macOS文件/图片/文本；这里不读取系统剪贴板或探测内容。
					hint("app.clipboard.pasteImage", "to paste files on macOS, images, or text"),
					// 文件拖入提示是普通说明，不在这里登记系统拖放事件。
					rawKeyHint("drop files", "to attach"),
					// 按数组顺序连接成多行，不添加额外尾随LF。
				].join("\n");
			// 紧凑帮助只列少数操作，函数调用时读取当前快捷键和主题；不是从完整帮助字符串做截断。
			const compactInstructions = () =>
				// 以短提示数组生成单行紧凑文案。
				[
					// 保留中断入口的简短说明。
					hint("app.interrupt", "interrupt"),
					// 把清空和退出键位合并展示，二者仍是不同动作/条件。
					rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
					// 保留/命令语法提示，不枚举所有命令。
					rawKeyHint("/", "commands"),
					// 保留!Bash语法提示，不触发执行。
					rawKeyHint("!", "bash"),
					// “more”引导用展开动作看完整帮助，按键仍由配置查出。
					hint("app.tools.expand", "more"),
					// 用带muted样式的中点连接各短提示，结果为一行字符串而非新组件。
				].join(theme.fg("muted", " · "));
			// 构造折叠态引导，返回弱色字符串；showDetails是本轮init保存的布尔值。
			const compactOnboarding = () =>
				// 调用主题前景着色，参数跨行仍是同一个函数调用。
				theme.fg(
					// 这段引导使用dim色，和帮助正文不使用相同强调度。
					"dim",
					// 插入当前展开按键，详细启动模式才额外提及已加载资源；不因文案承诺资源一定存在。
					`Press ${keyText("app.tools.expand")} to show full startup help${showDetails ? " and loaded resources" : ""}.`,
				);
			// 另一段固定入门提示也延迟着色，供折叠/展开两种页头共同调用。
			const onboarding = () =>
				// 只生成“可向Pi询问功能”的文字，没有在此读取文档或发起自问请求。
				theme.fg("dim", `Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.`);
			// 创建可展开页头，传两个延迟文案、初始状态和边距；真正取文字在组件render时。
			const header = new BuiltInHeader(
				// 折叠文案由紧凑提示、展开引导和入门说明组成，模板中的LF决定空行。
				() => `${withLogo(compactInstructions())}\n${compactOnboarding()}\n\n${onboarding()}`,
				// 展开文案使用完整多行操作帮助，保留入门说明但不重复compactOnboarding。
				() => `${withLogo(expandedInstructions())}\n\n${onboarding()}`,
				// 初始展开状态沿用工具输出展开标记，后面快捷键也可统一修改。
				this.getStartupExpansionState(),
				// 水平边距1，使标识位置与BuiltInHeader鼠标范围对应。
				1,
				// 垂直边距0，额外留白由外层Spacer管理。
				0,
			);
			// 有半块logo才装点击回调，点击时才调用懒加载动画入口并现取renderer；这里不直接启动动画。
			if (showLogo) header.onLogoClick = (column, row) => playPiLogo3d(this.renderer, column, row);
			// 保存内置页头对象，后面自定义页头取消可恢复这一引用。
			this.builtInHeader = header;

			// Setup UI layout
			// 页头前留一行，文字组件自身不再加垂直边距。
			this.headerContainer.addChild(new Spacer(1));
			// 把内置页头挂进槽位，不是直接挂到TUI顶层。
			this.headerContainer.addChild(this.builtInHeader);
			// 页头后同样留一行，使资源/聊天区与标识分开。
			this.headerContainer.addChild(new Spacer(1));
		} else {
			// Minimal header when silenced
			// 安静模式保留空Text作内置页头占位，便于扩展替换/恢复，不构建完整帮助文案。
			this.builtInHeader = new Text("", 0, 0);
			// 将空占位挂到同一headerContainer，布局树仍保持一致结构。
			this.headerContainer.addChild(this.builtInHeader);
		}
		// 全屏范围提示在页头路径显示，避免前面的console写到普通shell屏幕。
		if (this.renderer.mode === "fullscreen") this.showFullscreenModelScopeNotice();
		// 请求显示已搭建的启动界面，TUI会安排帧，不等下面工具准备完成才可见。
		this.ui.requestRender();

		// Ensure fd and rg are available after mounting the TUI (downloads if missing, adds to PATH via getBinDir)
		// so slow downloads do not make startup appear frozen.
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands.
		// 并行准备fd/rg并等待二者Promise，数组解构只取第一个路径；下载失败可能按ensureTool规则返回undefined而非必然拒绝。
		const [fdPath] = await Promise.all([
			// fd供文件补全使用，状态回调可更新UI；已安装/离线/不支持平台按工具管理器分支处理。
			ensureTool("fd", (status) => this.showManagedToolStatus(status)),
			// rg供检索/命令使用，虽然不保存第二个返回值，准备调用仍执行且必须等待。
			ensureTool("rg", (status) => this.showManagedToolStatus(status)),
		]);
		// 保存fd结果，可能undefined；补全器随后将缺路径解释为禁用fd模糊查询。
		this.fdPath = fdPath;

		// Enable the remaining input handlers only after managed-tool setup completes.
		// 工具准备结束后才装完整应用快捷键，替换启动阶段仅提供的少数入口。
		this.setupKeyHandlers();
		// 安装正式异步提交处理，斜杠命令/Bash/压缩队列/用户消息从此走正常路径。
		this.setupEditorSubmitHandler();
		// 更新启动状态显示请求，具体帧由TUI合并调度。
		this.ui.requestRender();

		// Initialize extensions first so resources are shown before messages
		// 绑定当前会话扩展和UI动作、补全/快捷键/资源，并安装会话事件订阅；扩展session_start可能使用刚启动的交互对话。
		await this.rebindCurrentSession();

		// Render initial messages AFTER showing loaded resources
		// 资源先显示后再投影已有会话消息，避免历史对话先于启动资源列表出现；不是重新发历史给模型。
		this.renderInitialMessages();

		// Set up theme file watcher
		// 登记主题模块唯一变更回调，后注册会覆盖前者；这行本身不是新建文件watcher，也没有返回退订器。
		onThemeChange(() => {
			// 主题变更后令UI/组件缓存失效，使延迟文字能重新取颜色。
			this.ui.invalidate();
			// 同步更新当前编辑器边框色，与是否Bash模式/当前状态配合。
			this.updateEditorBorderColor();
			// 再请求实际重绘，invalidate和requestRender是两个不同动作。
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		// 订阅页脚数据源的Git分支变化，数据源监听此前已在构造时建立；这里未保存返回的off，stop通过provider.dispose清其订阅。
		this.footerDataProvider.onBranchChange(() => {
			// 分支变化只请求重绘，不在此运行git fetch或改变模型会话。
			this.ui.requestRender();
		});

		// Initialize available provider count for footer display
		// 按当前会话范围优先、无范围时按可用快照统计唯一供应商数；被调方法同步返回void，await不会把计数变成目录刷新。
		await this.updateAvailableProviderCount();

		// Flush the completed startup state before loading the remaining syntax grammars.
		// 立即画出完成后的启动状态，再后台加载其余语法，避免把首帧推迟到所有高亮语法就绪。
		this.ui.renderNow();
		// 发起语法库后台加载，then成功时重绘；void仅忽略返回Promise，链上没有catch吞掉加载/回调异常。
		void loadAllHighlightLanguages().then(() => {
			// 加载结束时若已经stop，则不继续操作UI；不表示加载本身被取消。
			if (!this.isInitialized) return;
			// 语法就绪后使旧显示缓存失效，以便代码块用新语法重新高亮。
			this.ui.invalidate();
			// 请求下一帧，不在then中提交新会话消息。
			this.ui.requestRender();
		});
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	// 将应用名、可选会话名和cwd末段写终端标题，返回void；例会话名review、目录/repo得到带review/repo的标题。
	// 只读会话元信息并调用Terminal，不更改会话名/进程cwd，也不等待终端确认标题已显示；底层错误可传播。
	private updateTerminalTitle(): void {
		// basename按当前平台路径规则取最后一段，不显示完整家目录路径。
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		// 从当前SessionManager读取可选会话名，未定义/空串走无名分支。
		const sessionName = this.sessionManager.getSessionName();
		// 仅真值会话名才纳入标题，不在本行重新验证名称字符。
		if (sessionName) {
			// 标题三个片段用固定分隔符连接，真实终端转义/输出由setTitle负责。
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			// 无会话名时只保留应用标题和cwd末段，不把undefined插入文字。
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	// 交互模式主入口：等待init，后台查目录/版本/包/tmux，显示启动诊断，顺序处理初始消息，最后循环等待用户输入并交session.prompt。
	// 例如initialMessage="读README"先走Session的命令/扩展/模型预检，再进入下一次等待；prompt被扩展处理时不一定请求模型。
	// 返回Promise<void>但正常循环没有return出口，退出多由shutdown终止进程；会有真实终端/认证/网络/命令等副作用，不能作为纯内存smoke直接运行。
	// 局部try只包各次prompt，不是全方法兜底；后台then中的UI异常也不会被后面主循环的catch接住。
	async run(): Promise<void> {
		// 先等界面初始化；若此前init已置isInitialized但尚未结束，再次init按现有门禁会立即返回，不是共享初始化完成锁。
		await this.init();

		// 原始环境字符串的真值决定是否自动刷新；"0"/"false"也属于非空，会让这里跳过，不采用统一布尔解析器。
		if (!process.env.PI_OFFLINE) {
			// 为这位启动刷新等待者创建独立取消控制器，不把它当所有并发刷新共用的信号。
			const controller = new AbortController();
			// 15秒后通知取消；计时器不保证底层HTTP/提供商已停止，刷新协调器另处理等待者与共享取消关系。
			const timeout = setTimeout(() => controller.abort(), 15_000);
			// 不阻塞启动，复用同一ModelRuntime的并发全目录刷新；void只是忽略这条链的返回值。
			void refreshModelCatalogs(this.session.modelRuntime, controller.signal)
				// 刷新等待成功后按当时当前范围优先、无范围按可用快照重算供应商数，不读取本次返回值逐家判断刷新是否成功。
				.then(() => this.updateAvailableProviderCount())
				// 吞掉这条Promise链上已有的拒绝，包括then更新计数抛错；并不是包住整个run调用的try/catch。
				.catch(() => {})
				// 无论这条等待成功/失败都清15秒定时器，不会主动撤销已经收到的模型目录结果。
				.finally(() => clearTimeout(timeout));
		}

		// Start version check asynchronously
		// 自动版本检查自行遵守PI_OFFLINE/PI_SKIP_VERSION_CHECK并把普通查询错误转undefined；这里不await，也未为后续通知回调加catch。
		checkForNewPiVersion(this.version).then((newRelease) => {
			// 只有返回发布元数据才显示通知，同版本/较旧/禁用/普通查询失败都可能没有结果。
			if (newRelease) {
				// 根据release构造本地通知，不在这行执行自更新或安装。
				this.showNewVersionNotification(newRelease);
			}
		});

		// Start package update check asynchronously
		// 启动扩展包更新查询，函数内部将普通查询异常降为空数组；此处不等待其完成就继续启动。
		this.checkForPackageUpdates()
			// 查询成功后处理显示名数组，回调抛错会使后续链拒绝。
			.then((updates) => {
				// 非空才提示，空列表不证明每个远端都成功检查且没有更新。
				if (updates.length > 0) {
					// 显示可更新包名称，不在这里运行安装/升级命令。
					this.showPackageUpdateNotification(updates);
				}
			})
			// finally用于收尾标题，即使前面通知抛错也会运行；它不吞原拒绝，链尾也没有catch。
			.finally(() => {
				// On Windows, npm can overwrite the shared console title while checking
				// extension package versions. Restore Pi's title after the startup check.
				// 仅Windows且TUI仍标记运行时恢复标题，避免npm查询覆盖控制台标题或stop后又写。
				if (process.platform === "win32" && this.isInitialized) {
					// 现取当前会话名/cwd重设标题，不使用启动时捕获的旧标题字符串。
					this.updateTerminalTitle();
				}
			});

		// Check tmux keyboard setup asynchronously
		// 后台查询tmux键盘选项，可能启动只读tmux子进程；不await主启动，也没有在这里包通知回调异常。
		this.checkTmuxKeyboardSetup().then((warning) => {
			// 查询能给出警告文字才展示，无TMUX或查询失败可为undefined。
			if (warning) {
				// 向界面显示配置建议，不会自动改~/.tmux.conf或重启tmux。
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		// 对象解构一次取出启动选项，各局部值之后不自动跟随this.options同名属性被替换。
		const {
			// 取凭证迁移供应商列表，仅用于提醒，不在run再执行迁移。
			migratedProviders,
			// 取启动前已经收集的诊断列表，下面逐项按等级展示。
			startupDiagnostics,
			// 取模型恢复失败的可选备用说明，不直接决定目标模型。
			modelFallbackMessage,
			// 取首条启动文字，可与initialImages一起提交。
			initialMessage,
			// 取首条图片附件引用，没有为后续每条initialMessages重复附图。
			initialImages,
			// 取首条之后的附加消息列表，循环将串行等待各次prompt。
			initialMessages,
			// 解构来源是本次保存的options，不再访问argv解析器或读取新用户输入。
		} = this.options;

		// 缺列表时用[]，for...of保持诊断顺序，不把三种等级分组排序。
		for (const diagnostic of startupDiagnostics ?? []) {
			// type为error走错误显示；TS判别字段也帮助识别当前诊断分支。
			if (diagnostic.type === "error") {
				// 显示原诊断message，不在这里把诊断当异常throw。
				this.showError(diagnostic.message);
				// warning单独用警告样式，其余类型落入普通状态。
			} else if (diagnostic.type === "warning") {
				// 只投影文字，不代表已处理警告来源或修复配置。
				this.showWarning(diagnostic.message);
			} else {
				// 其他诊断按状态显示，未在run重新验证诊断结构。
				this.showStatus(diagnostic.message);
			}
		}

		// 迁移列表存在且非空才给提醒，避免空标题。
		if (migratedProviders && migratedProviders.length > 0) {
			// 用逗号连接供应商名，提示迁移结果；本行不读取/打印实际token。
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		// 读取模型运行时已记录错误，可能包含models.json配置、供应商组合和可用性错误，不只是一种JSON解析错误。
		const modelsJsonError = this.session.modelRuntime.getError();
		// 存在非空错误文字才显示，不再在此重新加载配置验证。
		if (modelsJsonError) {
			// 沿用原文统一冠models.json error前缀，不能据这个显示标签推断错误一定发生在该文件。
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		// 只有提供备用模型说明时才提醒，空串也不显示。
		if (modelFallbackMessage) {
			// 展示上游准备的说明，不在这里再尝试恢复旧模型。
			this.showWarning(modelFallbackMessage);
		}

		// 读取最近未通知崩溃记录，并尝试把未通知记录写为已通知；这个调用有本地日志读写副作用，不上传日志。
		const crash = takeUnnotifiedCrash();
		// 有符合日志时间规则的记录才提示；没有记录/读失败等不会让这里主动造一个崩溃。
		if (crash) {
			// 把记录时间转成本机locale显示文字，不保证服务器时区或固定格式。
			const when = new Date(crash.timestamp).toLocaleString();
			// 把已有崩溃线索作为警告追加到界面，不在此调用reportBug。
			this.showWarning(
				// 原提示说明以后/bug会附详情；这一行本身未发送任何报告，也未对crash.message另做脱敏。
				`${APP_NAME} crashed on ${when} (${crash.message}). Run /bug to report it; the crash details are attached automatically.`,
			);
		}

		// 后台检查Anthropic认证提示，内部有warning-only错误处理；可能查询认证/刷新凭证，不因void就变成纯字符串逻辑。
		void this.maybeWarnAboutAnthropicSubscriptionAuth();

		// Process initial messages
		// 首条文字真值才提交，空串略过；图片没有文字时此分支也不会单独发送。
		if (initialMessage) {
			// try仅保护这次首条prompt及随后同块操作，不覆盖前面的init/后台任务。
			try {
				// 将文字和图片交Session统一处理命令、扩展、模板、预检与运行；await遵循其Promise语义，不保证每次都调用模型。
				await this.session.prompt(initialMessage, { images: initialImages });
				// catch参数用unknown容纳任意抛出值，先缩窄再取Error.message。
			} catch (error: unknown) {
				// Error保留message，其余抛出值统一用固定未知错误文字，不直接String(error)。
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				// 显示失败后继续启动流程，不重新throw这一轮prompt错误。
				this.showError(errorMessage);
			}
		}

		// 存在附加列表才进入，空数组为真值但循环零次，不额外发送消息。
		if (initialMessages) {
			// 按原数组顺序处理每条文字，不并行发多个prompt。
			for (const message of initialMessages) {
				// 每一项各有try/catch，一项失败不会自动终止整个附加消息列表。
				try {
					// 附加消息没有传initialImages，使用Session默认选项；命令/扩展仍可拦截。
					await this.session.prompt(message);
					// 捕获这一项的拒绝，范围不包括列表迭代器本身在try外抛错。
				} catch (error: unknown) {
					// 同样只对Error提取message，其他抛出值使用固定兜底。
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					// 展示后继续下一条附加消息，而不是在这里重试原消息。
					this.showError(errorMessage);
				}
			}
		}

		// Main interactive loop
		// 无限串行主循环，普通return/break不存在；等输入让出事件循环，不是同步忙等。
		while (true) {
			// 取已提交的待处理文字或注册一个输入等待者；这一行在try外，若等待本身拒绝不由下面prompt catch处理。
			const userInput = await this.getUserInput();
			// 只包当前Session提问，下一轮仍会重新读取this.session以适应会话切换。
			try {
				// 把用户文字交会话层并等待此次调用完成；流中插话主要由提交处理器另用streamingBehavior协调。
				await this.session.prompt(userInput);
				// 当前提问拒绝后在这里转换为UI错误，不退出循环。
			} catch (error: unknown) {
				// 沿用与初始消息相同的Error/未知值格式规则。
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				// 显示错误，随后while回到等待输入；showError自身若抛错则会使run拒绝，未在catch内再套保护。
				this.showError(errorMessage);
			}
		}
	}

	// 查询已安装扩展包可用更新，仅返回显示名数组；例如npm包foo有更新时返回["foo"]供启动通知。
	// 离线或任何被本try捕到的异常都返回[]，不安装更新；DefaultPackageManager可能读目录并运行npm/git的只读远端查询，不能把此方法当无副作用检查。
	private async checkForPackageUpdates(): Promise<string[]> {
		// 这里同样按环境字符串真值判离线，包括"0"/"false"，比底层包管理器自己的布尔解析更早拦截。
		if (process.env.PI_OFFLINE) {
			// 直接返回兑现空数组的Promise，不创建包管理器或探测远端。
			return [];
		}

		// 把包管理器创建、查询和显示名映射都包进try，普通异常统一隐藏。
		try {
			// 新建包管理器并显式传当前会话环境，不使用其他会话默认设置。
			const packageManager = new DefaultPackageManager({
				// 安装/配置定位的cwd来自当前SessionManager，创建时读取一次。
				cwd: this.sessionManager.getCwd(),
				// 应用数据目录仍由统一config辅助函数解析，不自己拼家目录。
				agentDir: getAgentDir(),
				// 传当前SettingsManager引用，底层据两层包列表决定待查来源。
				settingsManager: this.settingsManager,
			});
			// 等待底层检查未固定的已安装来源，可能并发查询npm registry或git ls-remote；此处没有安装调用。
			const updates = await packageManager.checkForAvailableUpdates();
			// 只投影displayName，丢掉来源/scope/type等其他更新信息，不改底层记录。
			return updates.map((update) => update.displayName);
			// 无错误参数的catch有意不展示后台更新检查错误，不能据空结果判远端全部成功。
		} catch {
			// 任意捕获异常以无更新提示结束，不中断主交互启动。
			return [];
		}
	}

	// 在TMUX环境下读取两个键盘选项并返回可选警告文字，不修改配置；例extended-keys不是on/always时建议开启。
	// 会启动两个tmux只读子进程，每项最多等约2秒便可返回undefined；kill只发信号不等退出，不保证子进程已结束或所有异常都被吞。
	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		// TMUX缺省/空串时直接返回undefined，环境标记存在也不证明当前tmux服务可用。
		if (!process.env.TMUX) return undefined;

		// 局部辅助接选项名，返回该查询的文本或undefined；这里只调用固定的两个选项，不接受用户直接执行的shell串。
		const runTmuxShow = (option: string): Promise<string | undefined> => {
			// Promise executor同步启动子进程，resolve可以被多个回调调用但只有第一次结算生效。
			return new Promise((resolve) => {
				// spawn程序+argv分开传，不经shell拼命令；tmux查全局选项值，不运行用户模型或编辑器。
				const proc = spawn("tmux", ["show", "-gv", option], {
					// 忽略stdin/stderr，只捕获stdout，因此失败详细原因不在返回值里。
					stdio: ["ignore", "pipe", "ignore"],
				});
				// 累积stdout字符串，没有配置字节上限；let允许data回调追加。
				let stdout = "";
				// 为单个查询设2秒计时，不是整个Promise.all统一2秒截止。
				const timer = setTimeout(() => {
					// 超时发送默认终止信号，未等待close，也未检查kill返回值；进程可能仍在退出中。
					proc.kill();
					// 立即以undefined结束等待，后续close/data仍可能到来，但不能重新结算这份Promise。
					resolve(undefined);
					// 2000毫秒是调度器目标，事件循环繁忙时实际触发可以更晚。
				}, 2000);

				// 有stdout流才订阅data；?.不保证一定收到数据或限制编码格式。
				proc.stdout?.on("data", (data) => {
					// 每块用默认toString转文本后追加，没有独立StringDecoder保留跨块多字节状态。
					stdout += data.toString();
				});
				// 监听启动/进程层error，通常如程序不存在；回调不是HTTP错误处理器。
				proc.on("error", () => {
					// 错误已知后取消超时任务，避免再发kill。
					clearTimeout(timer);
					// 以undefined表示查询不可用，不把错误消息显示为选项值。
					resolve(undefined);
				});
				// close在进程结束且相关stdio关闭时给退出码，code可为null；不是只看exit事件就读完stdout。
				proc.on("close", (code) => {
					// 正常/非正常关闭都清这项计时器。
					clearTimeout(timer);
					// 仅code严格0才返回trim后的stdout，空输出返回空串，不是undefined；非0/null都转undefined。
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		// 两项并行等待并以位置解构，保留每项自己的计时/错误结果。
		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			// 第一项决定扩展键是否开启，查询失败会让后面直接不警告。
			runTmuxShow("extended-keys"),
			// 第二项读取扩展键编码格式，失败时并不一概阻止第一项关闭警告。
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		// 仅第一项为undefined就不警告；空字符串不是undefined，会被下面判作未开启。
		if (extendedKeys === undefined) return undefined;

		// 值必须精确on或always，大小写/其他文字不在这里规范。
		if (extendedKeys !== "on" && extendedKeys !== "always") {
			// 返回原英文操作建议，只提供文案，不写用户tmux配置或主动重启服务。
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		// 扩展键已开时，仅格式精确xterm才另给csi-u建议；undefined/其他值都不会在此报格式警告。
		if (extendedKeysFormat === "xterm") {
			// 同样只返回提示文字，不证明用户终端一定支持所有组合键。
			return "tmux extended-keys-format is xterm. Pi works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
		}

		// 未命中以上警告时返回undefined，不能据此证明所有tmux/终端键盘行为正常。
		return undefined;
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	// 同步取得启动应显示的Pi更新正文，返回字符串或undefined；例上次记录1.0.0时可合并日志中数值更新的条目。
	// 已有消息的会话直接略过；首次无版本只记录当前VERSION并安排遥测，不展示全部历史，读到新条目时同样先记版本再返回正文。
	// 可能读本地文件、排队保存用户设置、按开关发遥测；本方法不await落盘，不保证用户已真正看到通知后才记已读。
	private getChangelogForDisplay(): string | undefined {
		// Skip changelog for resumed/continued sessions (already have messages)
		// 以state.messages.length>0近似恢复/继续会话，不是检查启动argv里有没有--resume。
		if (this.session.state.messages.length > 0) {
			// 已有消息就不读日志或更新已读版本，避免恢复会话时插入启动更新内容。
			return undefined;
		}

		// 取有效设置中上次已读版本，缺省/空串都由后面的真值判断当首次。
		const lastVersion = this.settingsManager.getLastChangelogVersion();
		// 通过统一config重导出的辅助函数定位CHANGELOG，不直接用当前脚本__dirname。
		const changelogPath = getChangelogPath();
		// parseChangelog同步读文件按三段数字标题分块，缺文件/普通读取解析错误可返回[]，不是semver完整解析。
		const entries = parseChangelog(changelogPath);

		// 没记录版本时不比较历史条目；即使entries为空也会走首次记录流程。
		if (!lastVersion) {
			// Fresh install - record the version, send telemetry, don't show changelog
			// 更新用户层lastChangelogVersion并排队保存，返回时不表示磁盘成功写入。
			this.settingsManager.setLastChangelogVersion(VERSION);
			// 按离线/遥测开关安排当前版本的安装报告，可能发HTTP，但不阻塞取得正文。
			this.reportInstallTelemetry(VERSION);
			// 首次启动不显示更新日志；不是把所有旧版本内容标注进聊天。
			return undefined;
		}

		// 按三段数字比较筛新条目并保留文件顺序，不在这里按semver预发布语义或新旧重新排序。
		const newEntries = getNewEntries(entries, lastVersion);
		// 只有确实筛出新内容才更新已读记录与报告，空结果不会无条件推进记录到VERSION。
		if (newEntries.length > 0) {
			// 记录的是当前应用VERSION，不一定等于筛出日志条目中的最大版本；先记内存再排队保存。
			this.settingsManager.setLastChangelogVersion(VERSION);
			// 再次调用同一遥测辅助；这里没有额外去重表，是否触发由前面的版本分支决定。
			this.reportInstallTelemetry(VERSION);
			// 逐条把简单Markdown链接固定到该条日志版本标签，再用空行连接；不改原文件，也不验证链接资源存在。
			return newEntries.map((e) => normalizeChangelogLinks(e.content, e)).join("\n\n");
		}

		// 没有新条目返回undefined，调用方据此不显示Pi更新区域。
		return undefined;
	}

	// 收集包来源扩展的新版本日志，返回供UI显示的记录数组；例同一npm包导出多个扩展时只按来源+scope处理一次。
	// 只处理具有baseDir/changelogPath的包资源，读取package.json并比较上次已读日志；首次仅登记版本，有新条目则登记并生成带包名的正文。
	// 会同步读文件并排队保存设置，不安装包、不联网；去重键在读包之前就登记，首个同键资源失败时不会改用下一项重试。
	private getExtensionChangelogUpdates(): ExtensionChangelogUpdate[] {
		// Skip changelog for resumed/continued sessions (already have messages)
		// 只要当前会话已有消息便略过全部扩展更新，与Pi更新的恢复会话判定一致。
		if (this.session.state.messages.length > 0) {
			// 返回新空数组，不修改已读版本表。
			return [];
		}

		// Set保存本轮已见包身份，不跨调用/跨进程缓存。
		const seenKeys = new Set<string>();
		// 新数组累积可显示的更新记录，初值没有任何项。
		const updates: ExtensionChangelogUpdate[] = [];
		// 遍历已加载扩展，仅解构sourceInfo；不执行扩展模块或扫描未加载包。
		for (const { sourceInfo } of this.session.resourceLoader.getExtensions().extensions) {
			// 必须包来源且两个路径字段真值才继续；顶层本地扩展即使有文件也不走包更新日志流程。
			if (sourceInfo.origin !== "package" || !sourceInfo.baseDir || !sourceInfo.changelogPath) {
				// 本项不具条件则continue，不误当错误向用户报警。
				continue;
			}

			// 身份键只由source+scope序列化，不含文件路径/包根目录，借此合并同包多个扩展。
			const key = getSourcePackageKey(sourceInfo);
			// 相同键已处理就不再读第二份包元信息。
			if (seenKeys.has(key)) {
				// 跳过该项，继续之后其他身份的扩展。
				continue;
			}
			// 先登记已见，后续读包失败/缺version也不会回滚这个Set。
			seenKeys.add(key);

			// 从包根同步读package.json，只取字符串name/version；解析失败由辅助函数转undefined。
			const pkg = this.readPackageJson(sourceInfo.baseDir);
			// 缺包信息或版本空串都跳过，不把无版本包当v0比较。
			if (!pkg?.version) {
				// 本轮不生成记录，也不更新该键已读版本。
				continue;
			}

			// 按同一身份键查设置保存的已读版本，不取目录mtime作为更新依据。
			const lastVersion = this.settingsManager.getExtensionChangelogVersion(key);
			// 缺记录/空串视首次遇见该包，不展示所有历史日志。
			if (!lastVersion) {
				// Fresh install - record the version, don't show changelog
				// 以当前package.json版本登记用户层记录并排队保存，不等文件写完。
				this.settingsManager.setExtensionChangelogVersion(key, pkg.version);
				// 首次记录后继续下一包，不往updates加入空正文。
				continue;
			}

			// 按扩展提供的changelogPath解析版本标题，再按数字三段筛新条目；未验证路径一定在baseDir里。
			const newEntries = getNewEntries(parseChangelog(sourceInfo.changelogPath), lastVersion);
			// 至少一个比已读版本新的条目才生成扩展更新提示。
			if (newEntries.length > 0) {
				// 先保存包当前版本作为已读标记，不是保存每条日志都已被用户打开阅读的证据。
				this.settingsManager.setExtensionChangelogVersion(key, pkg.version);
				// name真值则作为显示名，否则回原来源串；不trim名称或检查是否与其它包同名。
				const name = pkg.name || sourceInfo.source;
				// Prefix each "## [x.y.z]" heading with the package name so entries render like Pi's own.
				// 将本包所有新日志内容合成一段Markdown，保持日志文件给的条目顺序。
				const markdown = newEntries
					// 无m的^只匹配每条content开头的##空白，把包名插在该开头标题后；不会改content内部所有同级标题，也不归一化这些链接。
					.map((entry) => entry.content.replace(/^##\s+/, `## ${name} `))
					// 条目之间以两个LF分隔，不在这里再按版本排序。
					.join("\n\n")
					// 裁整体两端空白，内部换行/原正文保持。
					.trim();
				// 一次加入该包的name/version/markdown三字段记录；对象简写name与markdown来自局部变量。
				updates.push({ name, version: pkg.version, markdown });
			}
		}

		// 返回本轮记录；即使空数组，首次版本登记等设置副作用也可能已经发生。
		return updates;
	}

	// 从指定包根读取package.json并返回字符串name/version的小对象，失败返回undefined；例合法JSON中version为数字时只丢该字段。
	// 同步读/JSON解析是本地文件信任边界，不执行包脚本；不做semver验证，也不完整保证JSON顶层为对象，null访问异常会由catch处理。
	private readPackageJson(packageRoot: string): { name?: string; version?: string } | undefined {
		// try同时包路径拼接、读取、去BOM、JSON.parse及属性提取，异常统一走缺结果。
		try {
			// 拼包根下固定文件名，去可选BOM后解析；as只声明接下来关心的未知字段，不实施运行时结构检查。
			const pkg = JSON.parse(stripBom(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"))) as {
				// name按unknown看待，须在下面确认字符串才向外暴露。
				name?: unknown;
				// version也不因JSON.parse成功就自动可信或合法semver。
				version?: unknown;
			};
			// 返回新对象，两个键即使值undefined也会存在；并非直接泄露完整包配置。
			return {
				// 仅typeof为string才保留名称，空串和空格串在本辅助里仍是合法字符串。
				name: typeof pkg.name === "string" ? pkg.name : undefined,
				// 版本同样只检查字符串类型，后面的调用者另以真值决定是否跳过。
				version: typeof pkg.version === "string" ? pkg.version : undefined,
			};
			// 权限/缺文件/JSON错误/null属性访问等异常被吞，不显示原错误。
		} catch {
			// 失败返回undefined，与“成功读取但两个字段均缺省”的对象区别开。
			return undefined;
		}
	}

	// 按开关发送当前版本的安装遥测，返回void且不等HTTP；例启用时向pi.dev报告version查询参数。
	// 先按原始PI_OFFLINE真值跳过，再按环境/设置判断遥测；5秒信号通知取消，请求失败静默，不上传会话正文或凭证，但详细User-Agent包含客户端环境信息。
	// 只忽略HTTP响应/普通拒绝，不检查response.ok；不能把正常Promise完成理解为服务端已记录事件。
	private reportInstallTelemetry(version: string): void {
		// 任意非空PI_OFFLINE都跳过，包括"0"/"false"；不使用下层工具管理器较窄的布尔规则。
		if (process.env.PI_OFFLINE) {
			// 离线直接结束，不计算User-Agent、不调用fetch。
			return;
		}

		// 遥测环境变量存在时优先按其布尔文字解析，否则读设置开关；本行只决定是否发送。
		if (!isInstallTelemetryEnabled(this.settingsManager)) {
			// 关闭时直接结束，不自动修改用户的遥测设置。
			return;
		}

		// 版本以encodeURIComponent编码进查询参数，避免&等改变参数结构；fetch会产生真实HTTP请求，不调用聊天模型。
		void fetch(`https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`, {
			// 请求头对象只显式设置User-Agent，没有在这里添加模型供应商认证。
			headers: {
				// 生成详细客户端标识，纯字符串函数本身不联网，格式由AI共享辅助负责。
				"User-Agent": getPiUserAgent(version),
			},
			// AbortSignal.timeout在约5秒后标记取消，不是等待远端服务器完成的保证。
			signal: AbortSignal.timeout(5000),
		})
			// 任意HTTP状态的已兑现Response都丢弃成undefined，不读JSON/正文，也不检查是否2xx。
			.then(() => undefined)
			// 把请求/then的拒绝转成undefined，后台报告不因为普通网络失败阻断界面。
			.catch(() => undefined);
	}

	// 为消息/日志创建Markdown样式配置：复制当前主题，再覆盖代码块缩进，返回新顶层对象；例设置缩进2只影响之后取得的这份配置。
	// 无终端I/O，不在这里渲染Markdown或修改全局Theme；样式函数引用仍可共享。
	private getMarkdownThemeWithSettings(): MarkdownTheme {
		// 对象字面量创建一份新配置，不把codeBlockIndent写回共享主题对象。
		return {
			// 展开基础Markdown主题中的颜色/样式函数，不深拷贝函数内部状态。
			...getMarkdownTheme(),
			// 同名字段后写覆盖前值，按当前SettingsManager读取代码块缩进。
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	// 为显示缩短家目录前缀，返回字符串；例家目录内绝对路径可变~/docs，相对路径原样。
	// 只按平台词法路径规则比较，不读磁盘、不跟随符号链接，也不改变当前目录。
	private formatDisplayPath(p: string): string {
		// 委托共享shortenHomePath，默认homeDir在调用时取当前系统家目录。
		return shortenHomePath(p);
	}

	// 把扩展入口路径压成更短显示名，先缩家目录，再去末尾/index.ts或/index.js；例~/ext/index.ts显示~/ext。
	// 仅字符串处理，不验证这是入口文件、目录或真实存在的路径；这里只识别/分隔符，不统一Windows反斜杠。
	private formatExtensionDisplayPath(path: string): string {
		// let保存初次显示路径，后面会覆盖为剥入口名的结果。
		let result = this.formatDisplayPath(path);
		// 两个无m的$都要求真实字符串结尾，大小写精确；不是移除中间目录中的index，也不会忽略最后的LF。
		result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
		// 返回压缩文字，未修改资源元数据中的原path。
		return result;
	}

	// 上下文文件若词法位于当前cwd内就显示相对路径，否则显示可缩家目录的绝对路径；例cwd/repo下a.md显示a.md，cwd本身显示.。
	// 不查文件/realpath，不用此结果证明符号链接目标或安全边界；解析/格式化错误可传播。
	private formatContextPath(p: string): string {
		// 先把会话cwd按当前平台node:path规则resolve为绝对基准，不改变process.cwd。
		const cwd = path.resolve(this.sessionManager.getCwd());
		// 绝对输入独立resolve，相对输入从会话cwd起算，折叠.和..；不访问目标文件。
		const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
		// 共享辅助进一步规范/比较路径，位于cwd内部则给相对字符串，否则undefined。
		const relativePath = getCwdRelativePath(absolutePath, cwd);
		// 显式比较undefined保留相对结果，目录自身的.也会正常返回。
		if (relativePath !== undefined) {
			// 优先显示cwd内相对路径，不再附~或绝对根。
			return relativePath;
		}

		// cwd外目标走家目录缩写，其他绝对位置仍保留；不把外部路径误当内部相对路径。
		return this.formatDisplayPath(absolutePath);
	}

	// 决定启动帮助/资源文字的初始展开，返回布尔；verbose为true或全局展开标志为true即展开，无I/O。
	private getStartupExpansionState(): boolean {
		// ||取第一个真值，否则取后面的布尔值；verbose缺省undefined时仍以toolOutputExpanded给出布尔结果。
		return this.options.verbose || this.toolOutputExpanded;
	}

	/** Startup header (logo, version, key hints). Hidden only by quietStartup: true. */
	// 决定是否画启动页头，verbose明确true优先，否则仅quietStartup严格true才隐藏；例如"header"仍保留页头。
	// 不控制全部启动警告/聊天输出，不在此写设置。
	private shouldShowStartupHeader(): boolean {
		// !==true让false、undefined和"header"都允许页头，不把任意真值设置都当隐藏。
		return this.options.verbose === true || this.settingsManager.getQuietStartup() !== true;
	}

	/** Startup details (model scope, loaded resources). Hidden by quietStartup: true or "header". */
	// 生成模型范围启动提示，有范围且允许详细启动时返回主题化文字，否则undefined；例如模型A带high可显示A:high。
	// 只读已有范围和键位，不刷新目录/切模型；提示只列裸模型ID，没有附全部provider，不能据显示文字唯一辨认跨供应商同名模型。
	private getModelScopeNotice(): string | undefined {
		// 无范围或不显示详细资源时直接省略，短路后不会遍历范围/取循环按键。
		if (this.session.scopedModels.length === 0 || !this.shouldShowStartupDetails()) return undefined;
		// 从当前会话范围构造模型列表，保持范围顺序。
		const modelList = this.session.scopedModels
			// 每项都映射为一个字符串，回调不改scopedModels记录。
			.map((sm) => {
				// 有真值thinkingLevel才加冒号后缀，off是非空字符串也会显示。
				const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
				// 使用sm.model.id与可选级别，不在这里展开显示名/供应商。
				return `${sm.model.id}${thinkingStr}`;
			})
			// 逗号空格连接每项，结果为同一提示中的列表。
			.join(", ");
		// 读取正向模型循环动作的所有当前绑定，未取反向动作，也不硬编码某个键。
		const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
		// 按是否至少有一个绑定决定附加操作引导。
		// 先以/连多个按键，再由格式助手首字母大写显示，外层用muted着色；仅生成提示。
		// 无绑定用空串，使最终列表不出现undefined。
		const cycleHint =
			// 无键位时不输出空的“to cycle”括号。
			cycleKeys.length > 0
				? theme.fg("muted", ` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`)
				: "";
		// 把范围与循环提示合为dim文字返回，不追加聊天组件。
		return theme.fg("dim", `Model scope: ${modelList}${cycleHint}`);
	}

	// 在全屏页头追加范围提示及空行，返回void；调用点负责确认当前是全屏，本方法自己不检查renderer.mode。
	// 例详细启动且配置范围才添加ThemedText；可能重复调用就重复追加，没有本方法级去重或移除旧提示逻辑。
	private showFullscreenModelScopeNotice(): void {
		// 先计算一次判断是否应添加；若为空直接返回，不创建占位组件。
		if (!this.getModelScopeNotice()) return;
		// 渲染时再次现取范围文案并随主题更新，之后条件变为无提示可渲染空串；已添加的Spacer仍存在。
		this.headerContainer.addChild(new ThemedText(() => this.getModelScopeNotice() ?? "", 1, 0));
		// 追加一行间隔，范围文案本身没有负责底部留白。
		this.headerContainer.addChild(new Spacer(1));
	}

	// 决定是否显示启动细节，verbose明确true或quietStartup明确false才显示；例quietStartup缺省undefined时不展示细节，但上面的页头仍可显示。
	// 只读设置，不展开组件/读取资源正文。
	private shouldShowStartupDetails(): boolean {
		// 严格比较false与true，"header"和undefined都不会经右侧判断开启详细列表。
		return this.options.verbose === true || this.settingsManager.getQuietStartup() === false;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	// 为资源路径生成包内短路径或家目录缩写，返回显示文字；例同一node_modules根下的兄弟依赖可保留../依赖/文件的拓扑。
	// 先统一斜杠并尝试包根相对位置，再用npm/git文本形状兜底，最后缩家目录；全程不查磁盘，不验证路径属实或可访问。
	// 各分支使用的匹配规则并不等价于完整包边界识别，不能把短显示结果当安装路径/安全隔离依据。
	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		// 替换所有反斜杠便于下面按/匹配，原fullPath字符串保持不变。
		const normalizedFullPath = fullPath.replace(/\\/g, "/");
		// 可选链取来源包根，缺sourceInfo时为undefined。
		const baseDir = sourceInfo?.baseDir;
		// 既有非空baseDir且source按本类npm:/git:前缀认作包才走根相对分支，不仅看origin字段。
		if (baseDir && this.isPackageSource(sourceInfo)) {
			// baseDir也统一为/，只用于下面正则与POSIX相对计算。
			const normalizedBaseDir = baseDir.replace(/\\/g, "/");
			// 用文本正则猜node_modules根与后面一至两段包路径，锚点要求整串匹配；不是读取package.json确认真正包根。
			const npmRootMatch = normalizedBaseDir.match(/^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/);
			// If fullPath is under the same node_modules root as baseDir, preserve that relative topology.
			// 有捕获根且fullPath同样以该根加/开头才保留依赖相对拓扑；前缀含边界斜杠避免根名直接拼接误命中。
			if (npmRootMatch?.[1] && normalizedFullPath.startsWith(`${npmRootMatch[1]}/`)) {
				// 明确用posix.relative按/计算，可返回以..开头的兄弟依赖路径；这一分支不强制资源必须在baseDir内部。
				return path.posix.relative(normalizedBaseDir, normalizedFullPath);
			}

			// 普通包根回退用本机path.resolve/relative算词法相对路径，不走realpath或验证文件存在。
			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			// 跨行条件约束这一回退的结果，全部成立才返回相对显示。
			if (
				// 相对结果必须真值，资源恰为根时通常空串，不从这里返回。
				relativePath &&
				// 另排除文字.；与上面非空判断共同保留原始条件，不据此改写逻辑。
				relativePath !== "." &&
				// 任何以..开头的相对名称都被排除，连..notes这类普通子名也会被挡，不只是越过父目录的路径。
				!relativePath.startsWith("..") &&
				// 再检查平台父目录前缀，这条比上条更窄但按原实现保留，不把两条件解释成不同安全层。
				!relativePath.startsWith(`..${path.sep}`) &&
				// 跨盘等相对计算可能返回绝对路径，必须排除；仍只是词法显示判断。
				!path.isAbsolute(relativePath)
			) {
				// 统一结果反斜杠后返回，显示不随平台混用分隔符。
				return relativePath.replace(/\\/g, "/");
			}
		}

		// 为后面的来源前缀匹配取得字符串，缺来源用空串。
		const source = sourceInfo?.source ?? "";
		// 在路径任意位置找node_modules/后的一至两段名称和余下内容；正则是显示启发式，不保证捕获组一定等于真实npm包边界。
		const npmMatch = normalizedFullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		// 路径形状命中且来源以npm:开头才用捕获的余下部分，来源/路径只满足一边不够。
		if (npmMatch && source.startsWith("npm:")) {
			// 返回第二个捕获组，可能与上面基于baseDir的相对结果不同，不再带包名。
			return npmMatch[2];
		}

		// Git回退按git/两段/余下内容的文字结构捕获，未解析真实checkout布局或验证来源仓库身份。
		const gitMatch = normalizedFullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		// 只有source带git:前缀才用这条回退；可由parseGitUrl识别的其他URL形式不一定走此分支。
		if (gitMatch && source.startsWith("git:")) {
			// 返回该正则余下内容，不能据此推断已经定位了真实仓库根。
			return gitMatch[1];
		}

		// 包路径缩短都未采用时，回原始fullPath做家目录显示缩写。
		return this.formatDisplayPath(fullPath);
	}

	// 从短显示路径取最后一个非空/非~片段作为紧凑标签，返回字符串；例~/skills/review.md得到review.md。
	// 纯显示处理不验证唯一性、文件后缀或存在性；路径拆不出片段则保留原短路径。
	private getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		// 先复用包根/npm/git/家目录的缩短规则，不自己重新解析包来源。
		const shortPath = this.getShortPath(resourcePath, sourceInfo);
		// 把反斜杠统一成/，以便按同一分隔符取尾段。
		const normalizedPath = shortPath.replace(/\\/g, "/");
		// 过滤空段与恰好~的段，..、.等其他文字不会在此折叠。
		const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		// 至少一个段才取尾项，避免空数组访问。
		if (segments.length > 0) {
			// !为非空断言，只影响TS类型；运行时仍是普通数组索引，上面的长度条件是实际保护。
			return segments[segments.length - 1]!;
		}
		// 没有尾段时返回shortPath，不强行生成空标签或文件名。
		return shortPath;
	}

	// 生成紧凑包来源名：npm去前缀，Git取解析仓库路径，其他原样；例npm:foo@1显示foo@1。
	// 输入可无来源，返回空串；只解析文字，不检查版本、仓库访问权或安装状态。
	private getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
		// 缺sourceInfo或source为nullish时用空串，保留显式空字符串。
		const source = sourceInfo?.source ?? "";
		// 大小写敏感识别npm:，不在此删包版本或scope。
		if (source.startsWith("npm:")) {
			// 去四字符前缀，若只剩空串则保留原npm:，避免把非空来源完全隐藏。
			return source.slice("npm:".length) || source;
		}

		// 其余尝试共享Git解析器，它支持的来源形式比本类isPackageSource前缀判断更广。
		const gitSource = parseGitUrl(source);
		// 成功才读解析结果，不把null当一个空仓库。
		if (gitSource) {
			// 优先返回host之外的仓库path，路径空时回原source；通常不在紧凑标签里保留host/ref。
			return gitSource.path || source;
		}

		// 不识别来源按原字符串显示，不据此认作本地路径。
		return source;
	}

	// 为单个扩展生成紧凑名称，包扩展带来源前缀，非包扩展取末段；例包foo的extensions/bar/index.ts可显示foo:bar。
	// 只格式化，没有唯一性保证；更全面的非包同名消歧由下面getCompactExtensionLabels另做。
	private getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		// 按npm:/git:字面前缀判断包，不是检查origin或parseGitUrl任意成功结果。
		if (!this.isPackageSource(sourceInfo)) {
			// 非包直接沿用短路径尾段，尚未比较其他扩展同名情况。
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		// 包来源标签保留npm版本或Git仓库路径，具体规则在前一个助手里。
		const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
		// 若标签最终空串，退回普通路径标签，避免生成冒号开头空来源。
		if (!sourceLabel) {
			// 保留sourceInfo给getShortPath，因此即使无来源标签仍可使用已有baseDir缩短路径。
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		// 先得到包短路径，再统一/，后面明确采用POSIX解析，不依赖本机分隔符。
		const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
		// 仅开头为extensions/才去这一级，其他路径保留；不是移除任意中间extensions目录。
		const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
		// 把路径拆成dir/name/ext等，name不含最后扩展名，不读取文件内容。
		const parsedPath = path.posix.parse(packagePath);

		// 文件名去后缀后严格为index时，优先展示其所在目录，index.ts/index.js以外后缀也会满足这条判断。
		if (parsedPath.name === "index") {
			// 没有目录或目录为.只用来源标签，否则来源:目录；不是返回index入口文件本身。
			return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
		}

		// 非index路径完整接在来源之后，仍可能包含多段目录/文件后缀。
		return `${sourceLabel}:${packagePath}`;
	}

	// 将扩展显示路径拆成非空/非~段的新数组，供同名消歧，例~/a/b.ts→["a","b.ts"]。
	// 只做格式化，不折叠..、不比较文件身份、不访问磁盘。
	private getCompactDisplayPathSegments(resourcePath: string): string[] {
		// 先按家目录缩写取得显示串，下面以链式操作继续处理返回值。
		return (
			this.formatDisplayPath(resourcePath)
				// 反斜杠替为/，让Windows来源也可按同一分隔符拆分。
				.replace(/\\/g, "/")
				// 按每个/分段，绝对根的首空段会在下步丢掉。
				.split("/")
				// 丢空段与~，保留其余原文段；结果不含主目录前缀标签但不保证绝对可逆。
				.filter((segment) => segment.length > 0 && segment !== "~")
		);
	}

	// 在非包扩展集合中，从文件尾开始找能区别其他项的最短后缀，返回标签；例a/index和b/index经预处理可用a/b目录名区分。
	// resourcePath供缺segments时兜底，index定位预处理记录，allPaths供逐项比较；不改数组，不读磁盘。
	// 若有重复完整路径/相同段，尝试到全部段仍不唯一时返回全段标签，不承诺输出必定唯一。
	private getCompactNonPackageExtensionLabel(
		// 保留原路径用于索引缺项/空段时的普通紧凑标签回退。
		resourcePath: string,
		// index是allPaths中的位置，不是文件系统inode或SessionEntry ID。
		index: number,
		// 内联对象数组类型要求每项有path和segments，比较实际只读segments；数组/对象没有被readonly或冻结。
		allPaths: Array<{ path: string; segments: string[] }>,
		// 返回字符串，不返回命中的资源对象或索引。
	): string {
		// 可选链容忍索引未命中，此时segments为undefined；没有根据index做运行时整数校验。
		const segments = allPaths[index]?.segments;
		// 找不到段数组或段为空就不能做后缀消歧。
		if (!segments || segments.length === 0) {
			// 退回末段格式规则，可能仍与其他项同名，但不会伪造一个唯一ID。
			return this.getCompactPathLabel(resourcePath);
		}

		// 从1段递增到完整段数，一旦找到唯一候选立刻返回；循环做的是字符串比较，不是目录逐层探测。
		for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
			// slice负下标取最后若干段并新建数组，join把候选拼成相对风格文本。
			const candidate = segments.slice(-segmentCount).join("/");
			// every逐项确认其他记录对应尾段都不同，遇到一项相同就停止判否。
			const isUnique = allPaths.every((item, itemIndex) => {
				// 跳过自己这一位置，避免候选永远因自己相同而失败。
				if (itemIndex === index) {
					// 自身比较视作通过，不代表和其他项已唯一。
					return true;
				}
				// 其他项也取相同段数尾部，严格字符串比较；不折叠大小写或解析符号链接。
				return item.segments.slice(-segmentCount).join("/") !== candidate;
			});

			// 所有其他项都不相同时采用这个最短候选。
			if (isUnique) {
				// 提前返回结束整个方法，不继续构造更长的标签。
				return candidate;
			}
		}

		// 未能唯一化时返回全部段连接，明确保留重复记录情况下仍可能重名的行为。
		return segments.join("/");
	}

	// 按原扩展顺序生成紧凑标签：包走来源规则，非包先去index入口名再互相比较最短后缀；例如两个不同目录的index.ts显示不同目录尾段。
	// 会创建新中间对象/段数组并在这些新数组上pop，不修改传入extensions；重复路径并不保证唯一化。
	private getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[] {
		// 先为所有项预处理，再过滤出非包集合，供稍后消歧；不是直接复用输入数组。
		const nonPackageExtensions = extensions
			// map创建每项的新包装和segments，原扩展记录不变。
			.map((extension) => {
				// 按格式化路径拆段，得到可修改的新数组。
				const segments = this.getCompactDisplayPathSegments(extension.path);
				// 取尾段，空数组时为undefined；后面的长度条件再保护pop规则。
				const lastSegment = segments[segments.length - 1];
				// 只有至少两段且尾段精确index.ts/index.js才去入口名；单独一个index.ts不在这里清成空。
				if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
					// pop只修改刚创建的segments，不改资源路径字符串。
					segments.pop();
				}
				// 返回预处理记录，保留来源供过滤判断。
				return {
					// 原path按值保留，稍后findIndex按它匹配；没有在此realpath去重。
					path: extension.path,
					// sourceInfo对象引用共享，不做深拷贝或修改。
					sourceInfo: extension.sourceInfo,
					// 保存已可能去index名的段数组，后缀比较使用这份结果。
					segments,
				};
			})
			// 只留下按前缀判定的非包项，包项不参与非包标签消歧。
			.filter((extension) => !this.isPackageSource(extension.sourceInfo));

		// 第二次map沿原extensions顺序输出，与中间过滤后的集合顺序不同用途。
		return extensions.map((extension) => {
			// 包项直接走来源+路径格式，不参与这里的全列表同名比较。
			if (this.isPackageSource(extension.sourceInfo)) {
				// 调用单项包标签规则，Git的host省略等显示边界仍保持。
				return this.getCompactExtensionLabel(extension.path, extension.sourceInfo);
			}

			// 按原path严格相等找第一项；重复路径会定位同一个首项，不按对象身份区分。
			const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
			// 未找到时用普通标签兜底，不用-1索引误取数组尾项。
			if (nonPackageIndex === -1) {
				// 这条回退仍传sourceInfo，保留包根短路径等上下文。
				return this.getCompactPathLabel(extension.path, extension.sourceInfo);
			}

			// 把预处理记录位置与整个非包集合交给后缀消歧函数，不改变最终输出顺序。
			return this.getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
		});
	}

	// 将来源元数据映射为显示标签、可选范围和颜色，返回新对象；例local/user显示弱色user，npm包显示accent来源及范围。
	// 缺来源按local/project，纯显示不验证资源信任或可执行资格；未用于这里的origin/baseDir不参与计算。
	private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		// 必填label承载来源主文字，不含路径。
		label: string;
		// 范围标签可缺，调用者可以选择是否在括号里展示。
		scopeLabel?: string;
		// 颜色只允许accent/muted这两种主题token字面量，TS不因此立即生成ANSI码。
		color: "accent" | "muted";
	} {
		// 元数据缺省时按本地来源，空串作为显式值保留，不被??覆盖。
		const source = sourceInfo?.source ?? "local";
		// 范围缺省按project，实际调用者通常给SourceScope联合中的三种值。
		const scope = sourceInfo?.scope ?? "project";
		// 只有source精确local时才将范围提升为主要显示标签。
		if (source === "local") {
			// 本地用户来源显示user而非local(user)。
			if (scope === "user") {
				// 返回muted标签，不附单独scopeLabel。
				return { label: "user", color: "muted" };
			}
			// 本地项目来源同理显示project。
			if (scope === "project") {
				// 仍用弱色，与包来源强调色区分。
				return { label: "project", color: "muted" };
			}
			// 本地临时来源强调“路径输入”类别，不把temp当持久配置层。
			if (scope === "temporary") {
				// 主标签path、范围temp分别存储，由调用者选择组合格式。
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			// 保留其他运行时scope值的原有兜底path；在既定SourceScope类型内正常调用通常已被前面分支覆盖。
			return { label: "path", color: "muted" };
		}

		// 显式CLI来源统一显示path，不将命令行资源自动归入用户包。
		if (source === "cli") {
			// 仅临时CLI项另带temp，其他CLI范围省范围标签；字段即使值undefined也在对象里存在。
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		// 包或其他来源按scope另算范围文字，下面与原source一起返回。
		const scopeLabel =
			// 三种已知范围映射user/project/temp，类型外其他值按原表达式回undefined。
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		// 主标签保留完整source，颜色accent；没有在这里解析npm/Git别名。
		return { label: source, scopeLabel, color: "accent" };
	}

	// 把资源归到user/project/path三组，返回分组键；例任何temporary或CLI来源优先进path。
	// 只读元数据，不检测磁盘路径类型或修改安装范围；缺省local/project归project。
	private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
		// 来源缺省local，不把undefined字符串拼进标签。
		const source = sourceInfo?.source ?? "local";
		// 范围缺省project，后面按固定优先级判断。
		const scope = sourceInfo?.scope ?? "project";
		// CLI来源或临时范围任一成立都优先path，即使CLI项scope写user也不会进user组。
		if (source === "cli" || scope === "temporary") return "path";
		// 非CLI/非temporary的用户范围进user。
		if (scope === "user") return "user";
		// 其余项目范围进project，不按路径前缀猜。
		if (scope === "project") return "project";
		// 保留原实现兜底path，不在这里抛未知范围异常。
		return "path";
	}

	// 判断本显示分组是否把来源当包，返回布尔；例npm:foo或git:host/repo为true。
	// 仅字面前缀规则，无I/O；origin=package并不单独满足它，未带git:的可解析HTTPS来源也不一定被本方法视作包。
	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		// 缺元数据用空串，两个startsWith都会为false。
		const source = sourceInfo?.source ?? "";
		// 大小写敏感地检查两种前缀，不调用parseGitUrl或npm解析器校验语法。
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	// 把资源按显示范围分组，每组再分普通路径和按source聚合的包，返回非空组数组；例同一project/npm:foo的技能在同一包子组。
	// 新建分组容器但保留原item对象引用，输入数组不变；返回顺序固定project→user→path，组内暂不排序、不去重资源路径。
	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
		// 返回项的scope被字符串联合限制为这三种显示组，不是原SourceScope的temporary。
		scope: "user" | "project" | "path";
		// 普通资源列表保留path与可选来源，供格式回调使用。
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		// packages以来源串为键，值是一组原资源记录；同名包的不同scope已先分到不同组。
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}> {
		// Record要求三个组键都有值，只参与TS检查；运行时下面仍是普通对象字面量。
		const groups: Record<
			// Record键联合与getScopeGroup返回值一致，因此groups[groupKey]可直接取已初始化组。
			"user" | "project" | "path",
			// Record的第二个类型参数是每组结构，跨行花括号属于类型而非运行时对象。
			{
				// 每个组本身保留scope，格式化时用它做标题。
				scope: "user" | "project" | "path";
				// paths是这一组的非包资源数组，不是字符串数组。
				paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
				// packages存同来源资源数组，Map键不含单个文件路径。
				packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
			}
			// 类型声明结束后=才开始真正建立分组对象。
		> = {
			// 用户组初始空数组/Map，每次调用新建，避免跨资源类别共享累积。
			user: { scope: "user", paths: [], packages: new Map() },
			// 项目组同样独立，不与用户组复用一个Map。
			project: { scope: "project", paths: [], packages: new Map() },
			// 路径组用于CLI/临时等来源，名称path不是磁盘目录变量。
			path: { scope: "path", paths: [], packages: new Map() },
		};

		// 沿输入顺序遍历每项，分组前不会修改items顺序。
		for (const item of items) {
			// 先按CLI/临时优先规则取显示组键。
			const groupKey = this.getScopeGroup(item.sourceInfo);
			// 从完整Record取得现有分组，不为每个资源再创建重复scope对象。
			const group = groups[groupKey];
			// 来源字符串缺省local，用作包Map键；即使不是包也只读不改。
			const source = item.sourceInfo?.source ?? "local";

			// 只有npm:/git:前缀来源进入packages，否则放paths。
			if (this.isPackageSource(item.sourceInfo)) {
				// 已有同来源数组就复用，没键才建新数组；??不覆盖已有空数组。
				const list = group.packages.get(source) ?? [];
				// 追加原item引用，后续外部若改该对象，分组视图也会看到。
				list.push(item);
				// 首次发布新数组，已有键则重设同数组引用；不复制包内每项。
				group.packages.set(source, list);
			} else {
				// 非包项直接加入本组paths，不尝试按路径父目录合并。
				group.paths.push(item);
			}
		}

		// 显式组顺序为project、user、path，和上面对象字面量的创建顺序不同；filter产生新数组。
		return [groups.project, groups.user, groups.path].filter(
			// 只保留有普通路径或至少一个包键的组，避免打印空标题。
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	// 把已分组资源格式化成多行主题文字，返回字符串；例project下普通路径缩进4格，npm包内文件缩进6格。
	// 遍历调用方给的组顺序，组内复制数组后按原路径/source名称排序，再调用两种路径格式函数；不重排输入数组、不执行资源。
	// 样式/格式回调异常直接传播，不做路径或文字脱敏；返回ANSI文本，不是可执行包管理计划。
	private formatScopeGroups(
		// groups接前面构造的scope组数组，也允许调用方提供同形状记录。
		groups: Array<{
			// scope标题使用显示组联合，不能在TS内误传temporary作为该字段。
			scope: "user" | "project" | "path";
			// paths给普通资源，元素仍有来源可供formatPath使用。
			paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
			// packages把source串映射到资源数组，没有强制Map必须按某顺序插入。
			packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
		}>,
		// 第二参数要求两个回调，使同一分组结构能以技能/模板/扩展各自方式展示。
		options: {
			// 普通路径格式函数只接当前资源，返回应显示的文字。
			formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
			// 包内路径格式函数还收到包source；某些调用方不使用第二参数，TS允许较少形参函数匹配此签名。
			formatPackagePath: (item: { path: string; sourceInfo?: SourceInfo }, source: string) => string;
		},
		// 整个方法返回合并字符串，未直接创建Text/Markdown组件。
	): string {
		// 局部行数组承接标题/路径，避免在遍历中反复替换整段文字。
		const lines: string[] = [];

		// 按groups现有顺序输出，不在这里再次决定project/user/path优先级。
		for (const group of groups) {
			// 组标题前留两个空格并用accent色，scope是展示标签，不是授权层级说明。
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			// 先浅复制普通资源数组再按path本机localeCompare排序，原group.paths不变，元素对象仍共享。
			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			// 按排序后的资源逐项生成路径行。
			for (const item of sortedPaths) {
				// 调用方格式化后加四空格与dim色，回调可读取来源/模板名，函数异常不被单项隔离。
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			// 把Map条目转新数组并按source键排序，解构比较器只取各条目的第一个元素。
			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			// for...of解构[source,items]，items仍是原包内数组引用，后面另复制才排序。
			for (const [source, items] of sortedPackages) {
				// 包来源加四空格和mdLink样式；这个颜色名不表示这里已创建真实终端超链接。
				lines.push(`    ${theme.fg("mdLink", source)}`);
				// 同样复制包内数组再按path排序，不原地修改分组中的items。
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				// 逐个包内资源交专用格式回调。
				for (const item of sortedPackagePaths) {
					// 加六空格区分于包名层级，回调收到该包source而非组scope。
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		// 各行以LF连接，未添加额外结尾换行；空组数组可返回空串。
		return lines.join("\n");
	}

	// 按精确路径优先、随后逐个/父前缀查来源元数据，返回最近命中对象或undefined；例/a/b/c先查自己，再/a/b、/a等。
	// 只查询给定Map并处理文字，不做文件系统父目录/realpath；反斜杠路径未在此统一，根/也不按完整路径API特殊处理。
	private findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
		// 先用原p字符串做Map键查找，不规范大小写或分隔符。
		const exact = sourceInfos.get(p);
		// 有来源对象就直接返回原引用，避免为已知精确资源再向上查。
		if (exact) return exact;

		// let保存当前待查前缀，原入参p不改。
		let current = p;
		// 只有仍含/才继续上溯；Windows纯反斜杠字符串在此不会被拆父级。
		while (current.includes("/")) {
			// 截到最后/之前，不保留那个斜杠；例如/a最后会变空串，而不是专门查询根/键。
			current = current.substring(0, current.lastIndexOf("/"));
			// 按截出的原文字查父来源，仍不检查真实目录存在。
			const parent = sourceInfos.get(current);
			// 找到就返回最近这个父前缀对应对象，后面更外层来源不再覆盖。
			if (parent) return parent;
		}

		// 精确与所有文字父前缀都未命中才返回undefined，不默认猜project/user。
		return undefined;
	}

	// 将来源标签与短路径组合供诊断显示，无来源则仅缩家目录；例npm:foo/project可显示“npm:foo (project) 文件”。
	// 纯格式化，不检查资源有效性/信任；标签和路径原文字没有在这里转义控制符。
	private formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
		// 仅有sourceInfo对象才尝试来源标签，空来源字段仍交其默认/原值规则处理。
		if (sourceInfo) {
			// 路径缩短按包根/来源启发式，可保留兄弟依赖相对拓扑。
			const shortPath = this.getShortPath(p, sourceInfo);
			// 解构只取label/scopeLabel，忽略getDisplaySourceInfo返回的color，本方法自己不套该颜色。
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			// 有真值范围标签才加括号，否则只保留来源主标签。
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			// 用一个空格接短路径，不把标签用于命令执行或文件定位。
			return `${labelText} ${shortPath}`;
		}
		// 完全无来源时只调用家目录显示缩写，不额外生成local/project标签。
		return this.formatDisplayPath(p);
	}

	// 把资源诊断格式化成多行主题文字，返回字符串；同名collision先归组显示首项赢家及各项输家，其余按错误/警告排路径与消息。
	// 例如两份同名技能显示一个选中路径和被跳过路径；本方法不解决冲突、不加载文件，也不保证分组内每条诊断具有相同赢家。
	// 只读诊断/来源Map并构建新数组，文字没有统一脱敏/控制符转义；同组仅按name，不同时按resourceType分组。
	private formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
		// 准备输出行数组，最后统一join而非逐行打印。
		const lines: string[] = [];

		// Group collision diagnostics by name
		// Map以冲突名称归组，值保存原诊断引用；可以把不同资源类别的同名冲突放在一组。
		const collisions = new Map<string, ResourceDiagnostic[]>();
		// 另存非完整collision项，保留它们相对输入顺序。
		const otherDiagnostics: ResourceDiagnostic[] = [];

		// readonly限制通过参数增删数组，遍历仍能读取各诊断对象。
		for (const d of diagnostics) {
			// 必须type为collision且详情存在；ResourceDiagnostic不是严格判别联合，不能只靠type就假定collision一定有值。
			if (d.type === "collision" && d.collision) {
				// 取同名已有组，缺键新建数组，不改d.collision.name。
				const list = collisions.get(d.collision.name) ?? [];
				// 把原诊断对象追加进本轮新数组，未复制内部详情。
				list.push(d);
				// 写回同一个组数组，首次建立Map键时确定后面遍历的组顺序。
				collisions.set(d.collision.name, list);
			} else {
				// warning/error或缺详情collision都放普通诊断，不为缺详情补伪造赢家/输家。
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		// 按名称首次出现顺序显示冲突组，所有普通诊断在这些组之后输出。
		for (const [name, collisionList] of collisions) {
			// 读取组第一条的可选冲突详情，只用这一条赢家作组内“保留项”。
			const first = collisionList[0]?.collision;
			// 没有first详情就跳过本组；正常由上面分组建立的非空组一般已有详情，保留原兜底条件。
			if (!first) continue;
			// 输出警告色名称标题，未在这里转义name中的引号或ANSI控制串。
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			// 加入首条赢家行，后面多行是同一push(theme.fg(...))调用。
			lines.push(
				// 外层dim应用于整条路径行，内层成功标记可再带自己的颜色码。
				theme.fg(
					// 赢家路径主体用弱色，是否被内层reset影响后续样式由theme字符串组合决定。
					"dim",
					// 先按赢家路径找精确/父来源，再组合标签和短路径；成功符号仅表示诊断给出的赢家，不是本函数重新验证或执行成功。
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			// 遍历组里全部诊断为各自输家生成行，可能包含重复路径，不在此去重。
			for (const d of collisionList) {
				// 每条仍检查详情存在，TS随后可读取loserPath。
				if (d.collision) {
					// 给本条输家追加一行，不再额外显示它自己的winnerPath。
					lines.push(
						// 同样用外层弱色包裹路径显示。
						theme.fg(
							// dim是显示主题token，不改变资源状态。
							"dim",
							// 按本条loserPath查来源，加跳过标记和(skipped)原文；只投影加载器决定，不在这里禁用资源。
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		// 冲突组之后按原顺序显示其他诊断，包括缺详情的collision。
		for (const d of otherDiagnostics) {
			// path真值才单列路径，空串与缺省都走只有消息的分支。
			if (d.path) {
				// 先给路径找来源并压成显示文字，不读取对应文件。
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				// type精确error才用错误色，其余包括collision都用warning色；路径行缩进两格。
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				// 消息再单独缩进四格，与路径分层；原message可能包含多行，本方法不逐行重新缩进。
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				// 无路径时只输出一条消息行并按同一等级规则着色。
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		// LF合并所有行返回，空诊断列表得到空串，不直接调用ui.requestRender。
		return lines.join("\n");
	}

	// 重建“已加载资源/诊断”独立显示区：先清旧内容，按启动详细/强制/安静诊断选项决定是否列，再为上下文、技能、模板、扩展和各类问题建组件。
	// 例如quietStartup开着但showDiagnosticsWhenQuiet:true时仍可看加载警告，而不展开资源清单；不执行资源、不修复冲突或重新reload。
	// 会修改资源容器、构造延迟主题文字并读取当前加载结果；不是整个函数完全无副作用的“幂等”，重复调用会清旧组件重新创建且命令诊断解析可变。
	private showLoadedResources(options?: {
		// 可选extensions显式覆盖扩展展示列表，传[]也算覆盖；这一选项不替换下面从loader取的错误/警告来源。
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		// force真值可强制显示清单，false不会禁止设置本来允许的详细清单。
		force?: boolean;
		// 安静模式是否仍显示诊断，只有严格true才单独开启。
		showDiagnosticsWhenQuiet?: boolean;
		// 整个选项对象也可省略，返回void，结果体现在loadedResourcesContainer变化。
	}): void {
		// Resource rendering is idempotent; chat clears no longer clear this separate container.
		// 无论之后显示开关如何都先清旧资源区，因此安静早返也会移除旧显示；不清chatContainer。
		this.loadedResourcesContainer.clear();

		// 强制真值或当前详细启动规则任一成立就列资源，||不会让false覆盖右侧true。
		const showListing = options?.force || this.shouldShowStartupDetails();
		// 展示清单就总展示诊断，否则还可由showDiagnosticsWhenQuiet严格true单开诊断。
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		// 两种显示都关闭时不继续取资源/构造组件，容器此刻已被清空。
		if (!showListing && !showDiagnostics) {
			// 提前return并非保留旧清单，不额外requestRender；上层负责何时重绘。
			return;
		}

		// 局部标题格式器给名称加方括号并按默认mdHeading或传入ThemeColor着色，调用时才取theme，无I/O。
		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
		// 局部紧凑列表助手接名称数组和可选排序开关，返回dim文字；例[" b ","a"]默认生成按名称排序的一行。
		// 只改新labels数组不改items，未对逗号/控制字符做转义，也不去重相同名称。
		const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
			// 逐项trim再过滤空串，map先产生新数组，因此后面的sort不修改原items。
			const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
			// 只有sort明确false才保留原顺序，省略/true均排序。
			if (options?.sort !== false) {
				// localeCompare按本机比较规则原地排新数组，不保证字节序。
				labels.sort((a, b) => a.localeCompare(b));
			}
			// 以逗号空格连接并加两格缩进/弱色，空列表仍可产生两个空格字符串。
			return theme.fg("dim", `  ${labels.join(", ")}`);
		};
		// Bodies are built on demand so the listing follows theme changes.
		// 局部建区助手保存折叠/展开正文函数并追加ExpandableText和空行，返回void；例Skills折叠显示名称，展开显示来源路径。
		// 正文到render时才生成以跟随主题，初始展开用当前全局设置；不会在这里执行资源或保证最终每节都非空。
		const addLoadedSection = (
			// name是节标题文本，不是资源Map键。
			name: string,
			// 折叠正文为无参字符串函数，让颜色在渲染时重新取。
			collapsedBody: () => string,
			// 未传展开正文时直接用同一collapsedBody函数引用，不复制它的执行结果。
			expandedBody = collapsedBody,
			// 标题默认mdHeading，调用者可以明确传其他ThemeColor。
			color: ThemeColor = "mdHeading",
			// 返回void只更新容器，不返回新section句柄给调用者。
		): void => {
			// 创建可展开文字组件，下面两个闭包共同使用当前节名/颜色。
			const section = new ExpandableText(
				// 折叠态由标题、LF和collapsedBody实时结果组合；不把回调文字塞进模板字面量源码里改写。
				() => `${sectionHeader(name, color)}\n${collapsedBody()}`,
				// 展开态改用expandedBody，其余标题/分隔格式相同。
				() => `${sectionHeader(name, color)}\n${expandedBody()}`,
				// 初始expanded取verbose或toolOutputExpanded的当时状态，不是每次render自动重新判该状态。
				this.getStartupExpansionState(),
				// 水平边距0，缩进由各body格式化函数自己生成。
				0,
				// 垂直边距0，空白由随后Spacer单独控制。
				0,
			);
			// 把新section追加到刚清理的资源区，之后全局展开快捷键可通过Expandable能力修改它。
			this.loadedResourcesContainer.addChild(section);
			// 每节固定追加一行间隔，即使延迟body最后变空也仍有这个组件。
			this.loadedResourcesContainer.addChild(new Spacer(1));
		};

		// 读取已加载技能和诊断的数组引用，不在查询时重新扫描或打开技能正文。
		const skillsResult = this.session.resourceLoader.getSkills();
		// 读取prompt模板及诊断，实际模板内容展开不在显示区执行。
		const promptsResult = this.session.resourceLoader.getPrompts();
		// 主题结果此处主要用于来源映射和冲突诊断，没有另建完整Themes清单一节。
		const themesResult = this.session.resourceLoader.getThemes();
		// 扩展列表按显式选项与当前资源快照二选一，nullish回退不会覆盖[]。
		const extensions =
			// 提供extensions就直接采用，包括调用者自己放进去的hidden项；隐藏过滤只在下面默认loader路径执行。
			options?.extensions ??
			// 未覆盖时从当前session资源加载器取已加载扩展。
			this.session.resourceLoader
				// getter返回现有扩展结果，不在此重新执行初始化工厂。
				.getExtensions()
				// 默认显示路径过滤hidden扩展；这些扩展仍可能在运行/诊断中存在，并非被停用。
				.extensions.filter((extension) => !extension.hidden)
				// 映射成path/sourceInfo两个字段的新记录，不把handler等扩展实现交给显示分组。
				.map((extension) => ({
					// 保留加载结果的扩展入口路径或标识，之后显示助手负责缩写。
					path: extension.path,
					// 来源对象引用沿用，不做安全认证或重新分类。
					sourceInfo: extension.sourceInfo,
				}));
		// 构建临时路径→来源Map供诊断格式化查找，既含可见扩展也会加技能/模板/主题信息。
		const sourceInfos = new Map<string, SourceInfo>();
		// 按展示扩展列表建立精确路径映射，显式覆盖时范围随它变化。
		for (const extension of extensions) {
			// 有来源才登记，undefined项不凭空猜local/project。
			if (extension.sourceInfo) {
				// 同路径后写会覆盖之前Map值，不合并多个来源。
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		// 再遍历所有技能，补充其来源，即使清单被隐藏仍为诊断提供定位。
		for (const skill of skillsResult.skills) {
			// 只对有sourceInfo的技能写Map。
			if (skill.sourceInfo) {
				// 技能使用filePath作键，后续同路径记录可覆盖扩展项来源。
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		// 模板同样纳入诊断来源Map，不只处理当前要展示的命令名。
		for (const prompt of promptsResult.prompts) {
			// 没有来源的模板仍可显示，但不会在这里得到来源映射。
			if (prompt.sourceInfo) {
				// 模板以filePath覆盖同键来源，不复制SourceInfo对象。
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		// 加载主题也可贡献诊断来源，和资源清单是否有Themes一节无关。
		for (const loadedTheme of themesResult.themes) {
			// 必须同时有真值sourcePath和sourceInfo才可登记；内存主题可没有文件来源。
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				// 主题路径是sourcePath，不是Theme.name字符串。
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		// 清单允许时才构造上下文/技能/模板/扩展各节，诊断分支在后面独立处理。
		if (showListing) {
			// 读取自定义系统提示的文件来源，直接输入的纯文字系统提示可能没有路径，因此不必出现在清单。
			const systemPromptSource = this.session.resourceLoader.getSystemPromptSource();
			// 拼上下文文件描述数组，保持系统提示→附加系统来源→AGENTS说明的顺序，不在此去重。
			const contextFiles = [
				// 主系统来源存在才展开一个元素，否则空数组，避免undefined混进列表。
				...(systemPromptSource ? [systemPromptSource] : []),
				// 附加系统文字中的实际文件来源依输入顺序加入，纯文字项不由该getter返回。
				...this.session.resourceLoader.getAppendSystemPromptSources(),
				// 加入已读取的AGENTS说明记录，虽然含content，下面只用path做显示。
				...this.session.resourceLoader.getAgentsFiles().agentsFiles,
			];
			// 至少一个上下文文件才加这一节，不为纯内存系统提示生成假文件名。
			if (contextFiles.length > 0) {
				// 上下文节前另留一空行，与页头/上方内容隔开。
				this.loadedResourcesContainer.addChild(new Spacer(1));
				// 展开正文是延迟函数，渲染时按当前主题生成每条路径行。
				const contextList = () =>
					// 展开态只缩家目录并弱色逐行，不把AGENTS全文打印进启动区。
					contextFiles
						.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
						.join("\n");
				// 折叠态也延迟计算，下面保留上下文来源先后顺序。
				const contextCompactList = () =>
					// 交公共紧凑列表助手做trim/连接，不自行复制一套排序逻辑。
					formatCompactList(
						// 折叠态优先用cwd内相对路径，外部再缩家目录，与展开态的格式不同。
						contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)),
						// sort:false明确保留系统/追加/AGENTS顺序，不按文件名打乱。
						{ sort: false },
					);
				// 注册Context节的两个body函数，初始展开仍由全局展开标记控制。
				addLoadedSection("Context", contextCompactList, contextList);
			}

			// 保留本次技能数组引用，下面建组与紧凑名称共用它。
			const skills = skillsResult.skills;
			// 无技能不建立空Skills节，但其诊断仍可能在后面显示。
			if (skills.length > 0) {
				// 展开态先把技能按显示scope/包来源分组，当前调用不读技能正文。
				const groups = this.buildScopeGroups(
					// 每项投影path/sourceInfo，保留原来源引用，丢掉描述等不需分组字段。
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				// 延迟展开显示，保存刚建的分组而非每次render重新查资源加载器。
				const skillList = () =>
					// 通用格式函数按组输出，两个回调决定普通/包路径如何展示。
					this.formatScopeGroups(groups, {
						// 非包路径只缩家目录，不用紧凑尾段，因此展开可看到更完整位置。
						formatPath: (item) => this.formatDisplayPath(item.path),
						// 包路径使用包内短路径/拓扑，不附技能名称或正文。
						formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
					});
				// 紧凑态只列技能name，默认trim后按名称排序，不展示每个路径。
				const skillCompactList = () => formatCompactList(skills.map((skill) => skill.name));
				// 建立Skills节，不在此把/skill命令注册进runner；补全路径另有处理。
				addLoadedSection("Skills", skillCompactList, skillList);
			}

			// 提示模板从Session公开视图取得，实际处理时模板可展开，这里只显示已加载元信息。
			const templates = this.session.promptTemplates;
			// 有模板才建立Prompts节，避免空标题。
			if (templates.length > 0) {
				// 同样按scope/source建展开分组，而不是按模板名称排序组本身。
				const groups = this.buildScopeGroups(
					// 把模板filePath映射到通用分组的path字段，来源引用不变。
					templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				// 建立路径→模板Map，重复filePath后项覆盖前项；用于展开时把文件位置替成/命令名。
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				// 延迟格式化模板展开列表，闭包捕获本次groups和templateByPath。
				const templateList = () =>
					// 通用分组布局仍会输出来源层级，条目名称由两个回调给出。
					this.formatScopeGroups(groups, {
						// 普通资源的格式回调接通用item，再去Map找模板元信息。
						formatPath: (item) => {
							// 按路径精确查模板，不模糊匹配名称或再次读文件。
							const template = templateByPath.get(item.path);
							// 匹配到就显示/模板名，没找到才回显示路径，避免直接访问undefined.name。
							return template ? `/${template.name}` : this.formatDisplayPath(item.path);
						},
						// 包内项也采用同一/模板名策略，未使用通用回调的第二个source参数。
						formatPackagePath: (item) => {
							// 仍以路径查模板对象，不拿包来源串作Map键。
							const template = templateByPath.get(item.path);
							// 同样用命令名或路径兜底，不因包来源多显示模板文件后缀。
							return template ? `/${template.name}` : this.formatDisplayPath(item.path);
						},
					});
				// 紧凑态映射为/模板名再交默认排序，与原模板数组顺序不必一致。
				const promptCompactList = () => formatCompactList(templates.map((template) => `/${template.name}`));
				// 建立Prompts节，名称是显示标题，不意味着生成模型prompt调用。
				addLoadedSection("Prompts", promptCompactList, templateList);
			}

			// 展示扩展列表非空才建Extensions节，与loader是否有加载错误分开判断。
			if (extensions.length > 0) {
				// 按显示scope及npm:/git:来源串聚合，隐藏过滤已在前面默认分支处理。
				const groups = this.buildScopeGroups(extensions);
				// 延迟生成展开态扩展清单，跟随主题变化重着色。
				const extList = () =>
					// 沿同一层级格式规则输出扩展路径。
					this.formatScopeGroups(groups, {
						// 普通扩展缩家目录并剥末尾/index.ts/js，仅影响显示，不改加载入口。
						formatPath: (item) => this.formatExtensionDisplayPath(item.path),
						// 包内扩展格式函数跨行返回表达式，不是一个含return语句的函数体。
						formatPackagePath: (item) =>
							// 先缩包路径，再剥index入口后缀；该规则与紧凑标签的最短后缀消歧不同。
							this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),
					});
				// 一次计算包来源/非包消歧后的紧凑标签，闭包后面复用这些字符串，不随渲染重跑路径消歧。
				const extensionLabels = this.getCompactExtensionLabels(extensions);
				// 每次取紧凑body仍会trim/按标签排序并着色，因此颜色随主题变，名称集合用本次快照。
				const extensionCompactList = () => formatCompactList(extensionLabels);
				// 建立Extensions节并显式给mdHeading色，实际默认也是该色，保留原调用。
				addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
			}
		}

		// 诊断允许时单独建问题区；即使showListing为false也可进入。
		if (showDiagnostics) {
			// 读取前面技能结果中的诊断数组引用，不再触发技能加载。
			const skillDiagnostics = skillsResult.diagnostics;
			// 技能问题非空才加提示组件，没有问题不造一个成功提示。
			if (skillDiagnostics.length > 0) {
				// 延迟格式化以取当前主题与来源标签，数组内容引用仍共享。
				const warningLines = () => this.formatDiagnostics(skillDiagnostics, sourceInfos);
				// 追加问题文字组件而不是可展开资源节，后面全局展开不改变这段的两种正文。
				this.loadedResourcesContainer.addChild(
					// 标题warning色，具体行按formatDiagnostics中的type再决定颜色；零边距由正文缩进/外层Spacer管理。
					new ThemedText(() => `${theme.fg("warning", "[Skill warnings]")}\n${warningLines()}`, 0, 0),
				);
				// 问题区后留一行，不写Session条目。
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			// 模板诊断可能包含命名冲突，来源仍来自promptsResult而不是模板补全器新计算。
			const promptDiagnostics = promptsResult.diagnostics;
			// 非空才显示Prompt conflicts区，标题固定不代表每条都是collision类型。
			if (promptDiagnostics.length > 0) {
				// 延迟委托统一诊断格式，保留错误/警告等分支差异。
				const warningLines = () => this.formatDiagnostics(promptDiagnostics, sourceInfos);
				// 追加可随主题重建的Text包装。
				this.loadedResourcesContainer.addChild(
					// 插入固定标题和多行诊断，模板字符串只拼显示文字，不执行模板命令。
					new ThemedText(() => `${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines()}`, 0, 0),
				);
				// 与下一问题区之间留一行。
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			// 创建扩展问题汇总新数组，后面合并加载错误、警告、命令冲突和快捷键问题。
			const extensionDiagnostics: ResourceDiagnostic[] = [];
			// 诊断重新取完整loader结果，不受options.extensions展示覆盖或hidden过滤限制。
			const extensionsResult = this.session.resourceLoader.getExtensions();
			// 遍历所有扩展加载错误，不仅是清单里可见扩展。
			for (const error of extensionsResult.errors) {
				// 把加载错误投影为ResourceDiagnostic，只保留error文字和path，不在这里重新throw或重新加载。
				extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
			}
			// warnings可缺省，??用[]让循环安全为空，不把错误列表当警告复用。
			for (const warning of extensionsResult.warnings ?? []) {
				// 映射为warning诊断，并保留原警告文字供后面显示。
				extensionDiagnostics.push({ type: "warning", message: warning.warning, path: warning.path });
			}

			// 先取runner目前保存的命令诊断引用，不在这个getter里解析命令。
			const commandDiagnostics = this.session.extensionRunner.getCommandDiagnostics();
			// 把现有记录展开进汇总数组，未复制每个对象。
			extensionDiagnostics.push(...commandDiagnostics);
			// 另算内置命令名冲突并追加；该助手调用getRegisteredCommands会清runner命令诊断，但前面已收集的对象仍在本数组中。
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner));

			// 读取runner保存的快捷键诊断，不在这里重新执行快捷键handler或探测终端键盘。
			const shortcutDiagnostics = this.session.extensionRunner.getShortcutDiagnostics();
			// 按现有顺序追加快捷键问题，不额外按type排序。
			extensionDiagnostics.push(...shortcutDiagnostics);

			// 汇总后至少一项才显示Extension issues区。
			if (extensionDiagnostics.length > 0) {
				// 延迟格式化汇总数组，来源Map用于定位但不执行原扩展代码。
				const warningLines = () => this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				// 追加可跟随主题失效重建的扩展问题组件。
				this.loadedResourcesContainer.addChild(
					// 固定warning标题下仍可含error色具体条目，标题不意味着所有扩展已停止或不可用。
					new ThemedText(() => `${theme.fg("warning", "[Extension issues]")}\n${warningLines()}`, 0, 0),
				);
				// 问题区结束留一行。
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			// 读取主题加载/命名诊断，清单没有Themes节也仍能显示它们。
			const themeDiagnostics = themesResult.diagnostics;
			// 非空才添加主题冲突区。
			if (themeDiagnostics.length > 0) {
				// 延迟统一格式化，保留当前主题色的更新能力。
				const warningLines = () => this.formatDiagnostics(themeDiagnostics, sourceInfos);
				// 创建ThemedText承接标题与诊断正文。
				this.loadedResourcesContainer.addChild(
					// 标题固定Theme conflicts，具体条目type可能不只collision；未在这里修复主题或切回默认。
					new ThemedText(() => `${theme.fg("warning", "[Theme conflicts]")}\n${warningLines()}`, 0, 0),
				);
				// 结尾留一行，整个方法没有直接requestRender，实际刷新交调用者安排。
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	// 将当前交互UI及会话操作绑定到扩展系统，等待session_start/资源发现，再重建主题注册、补全、快捷键、资源与启动通知。
	// 输入无参数，返回Promise<void>；例如扩展命令ctx.newSession会委托Runtime替换会话并让新UI重绑，而非直接清旧Agent消息数组。
	// 绑定可能执行扩展代码/加载额外资源，回调里还可新建/分叉/恢复会话或退出；本方法没有全程会话身份锁，外层rebindCurrentSession另做等待后的身份检查。
	private async bindCurrentSessionExtensions(): Promise<void> {
		// 新建面向扩展的UI闭包对象，方法真正调用时再进行对话/组件等操作。
		const uiContext = this.createExtensionUIContext();
		// 把宿主能力存入Session/Runner并等待启动事件和扩展资源发现完成，不只是保存一个ui指针。
		await this.session.bindExtensions({
			// 传刚创建的UI上下文，使用属性简写。
			uiContext,
			// 扩展运行模式标记为tui，不等于在这里另启动一个终端进程。
			mode: "tui",
			// 扩展ctx.abort走这个同步宿主回调，不要求扩展自己处理编辑器队列回填。
			abortHandler: () => {
				// 先按恢复逻辑取出排队文字回填编辑器，再请求abort；底层实际取消是异步，不保证本回调返回时已空闲。
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			// 为扩展命令上下文提供额外会话管理动作，普通ExtensionContext类型不直接列出这组命令专用方法；这里不是代码执行权限沙箱。
			commandContextActions: {
				// waitForIdle现取当前session等待其协调空闲，不主动发abort，不等独立Bash子进程。
				waitForIdle: () => this.session.waitForIdle(),
				// 异步新建会话回调把原options传Runtime，返回其{cancelled}结果或致命处理Promise。
				newSession: async (options) => {
					// 新建前先清UI活动指示器，不是停止Agent或释放Session资源。
					this.clearStatusIndicator();
					// try包Runtime新建与await，返回拒绝会进入下面致命路径。
					try {
						// Runtime先咨询扩展能否切换，再拆旧/建新/重绑，可通过options.setup/withSession运行调用者回调；不在本UI里自行复制历史。
						return await this.runtimeHost.newSession(options);
						// unknown兼容任意抛出值，再交统一错误展示/退出路径。
					} catch (error: unknown) {
						// 正常目标是显示致命错误并退出进程1，不是返回一个cancelled:true掩盖运行时异常；清理自己失败仍可能拒绝。
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				// 分叉回调接会话条目ID和可选位置/完成回调，等待Runtime给取消状态及可选旧用户文字。
				fork: async (entryId, options) => {
					// 保护Runtime分叉及随后UI回填/状态显示，任何这里捕获异常都按致命运行时错误处理。
					try {
						// Runtime根据position before/at生成新会话，可能保留父历史；不是对原数组slice后就完成替换。
						const result = await this.runtimeHost.fork(entryId, options);
						// 扩展取消分叉时不清/覆盖当前编辑器，也不显示成功状态。
						if (!result.cancelled) {
							// 成功后把selectedText回填，缺省用空串；before用户节点可返旧问题文字，at通常没有，因而会清输入。
							this.editor.setText(result.selectedText ?? "");
							// 成功状态属于UI提示，不是再追加一条用户提问。
							this.showStatus("Forked to new session");
						}
						// 对扩展只回传取消标记，不把selectedText结果继续透出这个适配层。
						return { cancelled: result.cancelled };
						// UI操作抛错也在同一catch范围内，不能把它只理解为捕获文件复制失败。
					} catch (error: unknown) {
						// 交致命显示/记录/停止路径，正常不再返回业务结果。
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				// 树内导航回调不新建会话文件，传条目ID和摘要选项给当前Session，返回给扩展的是简化取消结果。
				navigateTree: async (targetId, options) => {
					// 等待会话完成导航/可选分支摘要；底层拒绝忙碌/非法节点等异常，这个回调没有本地catch。
					const result = await this.session.navigateTree(targetId, {
						// ?.取是否请求摘要，undefined按Session默认false处理。
						summarize: options?.summarize,
						// 可选自定义摘要要求原样透传，不在UI里改写模型提示词。
						customInstructions: options?.customInstructions,
						// 可选替换默认要求开关原样透传，和追加要求语义不同。
						replaceInstructions: options?.replaceInstructions,
						// 可选摘要标签交会话保存，不在这里先写SessionManager。
						label: options?.label,
					});
					// 这里只判断cancelled，没有另判断结果aborted；不能写成“任一摘要取消都不再重画”。
					if (result.cancelled) {
						// 明确取消则返回简化true，不清聊天或刷新队列。
						return { cancelled: true };
					}

					// 非cancelled路径先清显示聊天，后面根据当前树位置重画；不删除持久化历史。
					this.chatContainer.clear();
					// 把导航后的上下文/条目投影成显示，不重新执行历史工具。
					this.renderInitialMessages();
					// 仅有真值editorText且当前输入trim为空才回填，避免覆盖用户尚未提交的非空文字。
					if (result.editorText && !this.editor.getText().trim()) {
						// 用Session返回的旧用户文字填输入，不自动提交模型。
						this.editor.setText(result.editorText);
					}
					// 显示导航完成提示；由于前面仅看cancelled，不把这句文案解释成对aborted字段的额外验证。
					this.showStatus("Navigated to selected point");
					// 后台处理压缩期间积压的输入，明确willRetry:false；这里不await队列完成，拒绝是否处理看被调方内部。
					void this.flushCompactionQueue({ willRetry: false });
					// 只向扩展返回cancelled:false，不保留summaryEntry/editorText/aborted所有细节。
					return { cancelled: false };
				},
				// 切会话动作转给已有恢复处理器，传路径与选项，使用同一信任/缺cwd/运行时错误策略。
				switchSession: async (sessionPath, options) => {
					// 返回处理器Promise，async自动接续它的兑现/拒绝，不在这里额外包装取消状态。
					return this.handleResumeSession(sessionPath, options);
				},
				// reload动作复用交互重载流程，不在回调对象里重新实现资源加载。
				reload: async () => {
					// 等待重载处理器完成，返回void；它自己的忙碌门禁/错误展示仍生效。
					await this.handleReloadCommand();
				},
			},
			// 扩展退出请求先记标志，空闲则启动shutdown，否则由Agent结算等路径稍后兑现。
			shutdownHandler: () => {
				// 状态只在本实例记录，不等于操作系统进程已经退出。
				this.shutdownRequested = true;
				// 按Session.isIdle协调状态判断，不能单凭某条assistant完成推断空闲。
				if (this.session.isIdle) {
					// 不等待退出Promise，shutdown内部清理出错也不是由void自动吞掉。
					void this.shutdown();
				}
			},
			// 扩展错误监听接已格式化的ExtensionError记录，下面只展示而不重新执行扩展。
			onError: (error) => {
				// 传来源、错误文字和栈到扩展错误显示，栈可能包含本机路径，未在此脱敏。
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		// 扩展session_start/resources_discover之后再注册最新主题集合，供扩展新增主题立刻可查询。
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		// 重建基础+wrapper补全并注入编辑器，可能清旧技能Map和执行包装工厂。
		this.setupAutocompleteProvider();

		// 在await后现取当前runner，不假定仍为方法开始时那个Session拥有的实例。
		const extensionRunner = this.session.extensionRunner;
		// 解析扩展快捷键与内置覆盖冲突并装默认编辑器回调，随后诊断显示可以读取新结果。
		this.setupExtensionShortcuts(extensionRunner);
		// 不强制资源清单，但要求安静模式仍展示诊断；force:false不覆盖详细启动设置的true。
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		// 尝试显示一次启动新版本通知，门禁此前已经设过时这里不会再加。
		this.showStartupNoticesIfNeeded();
	}

	// 将当前全屏滚动条设置交已有记录ScrollView，返回void；即使当前普通布局也可更新预建视图供以后切换。
	// 没有transcriptScrollView就跳过，不创建新布局/读用户文件；实际设置变化可由ScrollView安排失效。
	private applyFullscreenScrollbarSetting(): void {
		// ?.在缺视图时连参数求值也跳过，因此那时不会读取getFullscreenScrollbar。
		this.transcriptScrollView?.setScrollbar(this.settingsManager.getFullscreenScrollbar());
	}

	/** Lets extension images use the PNG transcoder; tool results register it themselves. */
	// 为扩展图片尝试登记共享PNG转码器，返回void；例如Kitty端首次加载成功后重画原来降级为文本的图片。
	// 该辅助自行按能力/已登记状态决定是否后台加载，不是每次都重新下载/转换图片；这里不await、不取消后台加载。
	private ensurePngTranscoder(): void {
		// 调用导入函数而非递归调用this.ensurePngTranscoder，传登记成功后的重绘回调。
		ensurePngTranscoder(() => {
			// 共享转码器可用后让现有显示缓存失效，准备重新绘制图片。
			this.ui.invalidate();
			// 再请求TUI帧，不直接从本回调读取图片文件或提交消息。
			this.ui.requestRender();
		});
	}

	// 把当前会话设置应用到共享能力/HTTP/TUI/页脚/编辑器，返回void；例如重绑会话后页脚换session、Git监听换cwd。
	// 它会修改全局dispatcher等共享状态，并可能触发转码器加载和Git监听重建；不等于修改了所有已存在消息组件或把设置写盘，没有统一回滚。
	private applyRuntimeSettings(): void {
		// 更新TUI能力覆盖，对以后能力判断生效，不重新探测真实终端。
		setCapabilityOverrides(this.settingsManager.getTerminalCapabilityOverrides());
		// 按新能力再尝试PNG转码器登记，内部缓存/已登记状态决定是否有工作。
		this.ensurePngTranscoder();
		// 重建并安装HTTP全局dispatcher，按闲置超时配置响应头/正文空闲预算，必要时匹配undici fetch；这里不发送具体HTTP请求。
		configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
		// 更新预建的全屏记录滚动条策略，不强制切全屏模式。
		this.applyFullscreenScrollbarSetting();
		// 只有实际renderer是TuiAltScreen才调用全屏专用复制/滚轮方法，instanceof让TS缩窄类型。
		if (this.renderer instanceof TuiAltScreen) {
			// 按当前设置更新选择即复制策略，不立刻复制当前选区。
			this.renderer.setCopyOnSelect(this.settingsManager.getFullscreenCopyOnSelect());
			// 更新鼠标滚轮行数配置，具体滚动要等用户事件。
			this.renderer.setWheelScrollLines(this.settingsManager.getFullscreenWheelScrollLines());
		}
		// 内置页脚换成当前session引用，不继续显示旧会话的模型/用量。
		this.footer.setSession(this.session);
		// 更新自动压缩标记，仅显示开关，不触发摘要请求。
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		// 页脚数据源换cwd，可关闭旧监听、探新Git位置、通知变化；不是只改显示字符串。
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		// 更新本实例思考块隐藏标志，已经创建的消息是否刷新还由渲染路径处理。
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		// 更新以后构建组件用的输出边距，不在这里遍历所有历史组件逐项改边距。
		this.outputPad = this.settingsManager.getOutputPad();
		// 修改硬件光标策略，真实终端是否显示取决于TUI后续绘制/光标处理。
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		// 先取缩短清屏配置为局部值，下面设置与条件共用。
		const clearOnShrink = this.settingsManager.getClearOnShrink();
		// 把配置交稳定ui当前实例，不写磁盘。
		this.ui.setClearOnShrink(clearOnShrink);
		// 不清屏且没有活动指示器时清状态容器，避免保留旧空闲占位；活动指示器存在则保留其显示。
		if (!clearOnShrink && !this.activeStatusIndicator) {
			// 只清临时状态区域，不清聊天/排队消息。
			this.statusContainer.clear();
		}
		// 取当前编辑器水平边距，下面同时更新默认和有能力的自定义编辑器。
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		// 取补全可见项数量，不改变提供者候选总量。
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		// 默认CustomEditor必有setPaddingX，直接应用新值。
		this.defaultEditor.setPaddingX(editorPaddingX);
		// 默认编辑器补全菜单容量也同步更新。
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		// 活动编辑器与默认不同时再处理一次，避免重复给同一实例设置。
		if (this.editor !== this.defaultEditor) {
			// 自定义编辑器可不实现这个可选方法，?.只跳过缺能力，不补运行时适配器。
			this.editor.setPaddingX?.(editorPaddingX);
			// 补全容量同样按可选能力更新，不能保证所有扩展编辑器都会响应设置。
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	// 重绑当前会话的UI/扩展/事件订阅，返回Promise<void>；例Runtime换会话后用renderBeforeBind:true先把新历史画出来再让扩展打开对话。
	// 先退旧订阅/重置状态/应用设置，按选项决定提前画与订阅，等待扩展绑定，再检查会话身份；仅仍为同一会话才继续补订阅和标题等刷新。
	// 身份检查不回滚前面已发生的UI/扩展副作用，也不是禁止await期间再切换的锁；异常交调用方处理。
	private async rebindCurrentSession(options: { renderBeforeBind?: boolean } = {}): Promise<void> {
		// 捕获本次开始时的Session对象身份，供await后比较，不把它当整个方法所有getter的数据快照。
		const session = this.session;

		// 有旧退订函数先调用，避免后面新会话再次订阅导致重复事件。
		this.unsubscribe?.();
		// 清本实例退订槽，表示当前没有由这个字段可取消的旧订阅。
		this.unsubscribe = undefined;
		// 重置程序状态的运行/压缩/静置记录；Reporter.reset不清blocked Map，不能说全部对话状态被此行取消。
		this.programStatus.reset();
		// 用当前Session设置更新HTTP/TUI/页脚/编辑器，可能有共享状态和监听副作用。
		this.applyRuntimeSettings();

		// 明确要求提前画时，扩展session_start前就准备历史和事件处理。
		if (options.renderBeforeBind) {
			// 清本UI聊天/队列显示状态并渲染当前会话，不删除SessionManager历史。
			this.renderCurrentSessionState();
			// 先装会话监听，使扩展启动阶段产生的事件能被当前UI处理。
			this.subscribeToAgent();
		}

		// 等待扩展启动/发现资源和对应UI配置，await期间别的操作仍可切换this.session。
		await this.bindCurrentSessionExtensions();

		// 对象身份已改变则本轮失效，避免在结尾又对新session重复订阅；不比较文件路径字符串。
		if (this.session !== session) {
			// 直接结束本轮，不执行后面的供应商/边框/标题刷新。
			return;
		}

		// 未提前订阅的普通启动路径，在扩展绑定完成后才装会话监听。
		if (!options.renderBeforeBind) {
			// 调用统一订阅方法并存退订引用，不重复执行提前路径的这一操作。
			this.subscribeToAgent();
		}

		// 同步按当前模型范围或可用快照重算供应商数量，await void不会发新目录请求。
		await this.updateAvailableProviderCount();
		// 按当前思考/Bash等状态重设编辑器边框，非重建全部消息。
		this.updateEditorBorderColor();
		// 更新终端标题为当前会话和cwd，不再使用旧会话标题。
		this.updateTerminalTitle();
	}

	// 处理使交互运行无法继续的运行时错误，输入显示前缀与unknown异常，目标是提示→可选扩展线索/本地崩溃记录→停止主题/UI→exit1。
	// 返回Promise<never>表示没有正常兑现业务值，仍可因自身显示/停止等步骤抛错而拒绝；不是“任何错误都保证清理完成后退出”。
	// 例如Runtime分叉失败调用本方法；会写本地日志/终端并结束进程，不自动向开发者上传报告。
	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		// Error用message，其余String转换；自定义toString也可能抛错，不在此额外兜底。
		const message = error instanceof Error ? error.message : String(error);
		// 先显示带前缀错误，showError若抛出会跳过后续记录/stop/exit。
		this.showError(`${prefix}: ${message}`);
		// 尝试从错误栈匹配当前已加载扩展，线索不是致因证明。
		const extensionHint = this.getCrashExtensionHint(error);
		// 只有有非空线索才附一条警告色文字。
		if (extensionHint) {
			// 用ThemedText延迟着色，边距取当前outputPad；未在此停用被提及扩展。
			this.chatContainer.addChild(new ThemedText(() => theme.fg("warning", extensionHint), this.outputPad, 0));
		}
		// 本地记录成功才显示报告步骤，失败不会伪称日志已保存。
		if (this.recordCrash("fatal_error", error)) {
			// 生成恢复/报告说明，存在sessionFile只影响文案，不验证文件仍存在。
			const instructions = this.crashReportInstructions();
			// 追加弱色步骤，不实际运行恢复命令或发送/bug。
			this.chatContainer.addChild(new ThemedText(() => theme.fg("muted", instructions), this.outputPad, 0));
		}
		// 停止全局主题文件监听，不在这里取消所有后台Promise。
		stopThemeWatcher();
		// 停止本交互实例并要求退出保留transcript，清理方法没有全局finally保障全部资源释放。
		this.stop("transcript");
		// 到达这一步才立即退出进程码1，不再正常返回；异步日志/网络等未由本行统一等待。
		process.exit(1);
	}

	// 为unknown错误生成可选扩展栈提示，任何本方法捕获异常都转undefined；例如非Error值没有可用stack通常无提示。
	// 读取当前扩展元信息、只做栈路径匹配和字符串格式化，不加载/执行扩展或证明其有bug。
	private getCrashExtensionHint(error: unknown): string | undefined {
		// 把取session、匹配与格式化一起保护，崩溃提示自身失败不再抛第二个错误。
		try {
			// 最后调用本文件文字助手，空匹配会给undefined。
			return formatCrashExtensionHint(
				// 共享栈匹配器按V8风格at帧与已加载扩展路径/包根做线索匹配。
				findExtensionStackMatches(
					// 只对真正Error读取stack，其他对象即使有stack字段也不在这条表达式读取。
					error instanceof Error ? error.stack : undefined,
					// 只拿当前loader知道的扩展，不扫描整个node_modules寻找所有可能模块。
					this.session.resourceLoader.getExtensions().extensions,
				),
			);
			// 路径/getter/格式化异常也被这一层catch吞掉，不把它们作为另一个致命错误上报。
		} catch {
			// 无提示返回undefined，调用方仍可继续记录原崩溃。
			return undefined;
		}
	}

	/** Persist a crash so the next start can point the user at `/bug`. Returns false when nothing was written. */
	// 把崩溃种类、异常和当前会话位置交本地记录器，返回是否取得记录；例fatal_error保存成功为true。
	// 有文件写入副作用，无网络上传；此UI包装额外捕获会话getter等异常，false不能区分无权限、坏路径或其他失败。
	private recordCrash(kind: "uncaught_exception" | "fatal_error", error: unknown): boolean {
		// try包括上下文读取和导入记录器调用，不只保护最终写文件。
		try {
			// 跨行括号中的比较式就是最终布尔返回值。
			return (
				// 调用导入的recordCrash函数，不是this.recordCrash递归；底层负责格式化/有限脱敏/追加保留记录。
				recordCrash({
					// 传入既定kind联合值，不自行推断错误严重程度。
					kind,
					// 保留unknown异常给底层格式化，未在本包装提前String化。
					error,
					// 附当前会话文件位置，可能缺省；路径不是整个会话正文。
					sessionFile: this.session.sessionFile,
					// 附当前会话cwd，底层记录如何处理路径由其契约决定，不能据这一层保证无敏感内容。
					cwd: this.session.sessionManager.getCwd(),
					// 底层返回undefined视作没写成，否则true；不再次读磁盘核对记录。
				}) !== undefined
			);
			// 额外捕获前面任何异常，尽力让崩溃处理不中断。
		} catch {
			// 失败返回false，调用方可省略“详情已保存”类说明。
			return false;
		}
	}

	// 生成崩溃后如何恢复并运行/bug的说明，返回纯字符串；有sessionFile就建议pi -r，否则先启动pi。
	// 不验证文件、创建报告或执行命令；APP_NAME用于恢复命令，另一分支原文start pi保持不变。
	private crashReportInstructions(): string {
		// 只按文件路径真值决定恢复指引，不要求existsSync，故建议不等于恢复必定成功。
		const resume = this.session.sessionFile ? `run \`${APP_NAME} -r\` to resume the session, then` : "start pi and";
		// 返回步骤文案，实际附加详情/发送由以后的reportBug路径负责。
		return `To report this crash: ${resume} run /bug. The crash details are attached automatically.`;
	}

	// 本实例最多追加一次/bug排查建议，返回void；例如首次未知助手错误后提醒，重复错误不刷同一提示。
	// 只修改门禁/聊天组件并请求重绘，不立即上传报告；门禁先置位，后续创建组件失败也不会自动重试。
	private suggestBugReport(): void {
		// 已提示则提前返回，不根据新session身份重新清零这个字段。
		if (this.bugReportHintShown) return;
		// 在追加文字前记true，避免同一实例重复提示。
		this.bugReportHintShown = true;
		// 追加一条延迟主题化文字，不作为AgentMessage写进模型上下文。
		this.chatContainer.addChild(
			// ThemedText允许主题失效时重建样式，正文是下面固定建议。
			new ThemedText(
				// 只告知/bug用途，未调用reportBug或检查此次错误真是Pi缺陷。
				() => theme.fg("muted", `If this looks like a ${APP_NAME} bug, /bug sends a report to the developers.`),
				// 水平边距沿用当前outputPad。
				this.outputPad,
				// 组件自身垂直边距0，聊天其他布局负责留白。
				0,
			),
		);
		// 请求下一帧展示建议，不等终端显示完成。
		this.ui.requestRender();
	}

	// 按助手错误性质决定是否建议/bug：非error、看似暂时故障、取消文字都略过，安装变化警告优先。
	// 例如明确cancelled不提示、未分类未知错误可提示；规则是错误文字启发式，不证明因果或能否成功重试，返回void且不实际重试。
	private maybeSuggestBugReport(message: AssistantMessage): void {
		// 只有error且未被共享分类器判为可重试暂时故障才继续；该分类器不实施重试预算/退避。
		if (message.stopReason !== "error" || isRetryableAssistantError(message)) return;
		// 大小写无关按英文词边界匹配abort/aborted/cancel/canceled/cancelled等形态，缺message用空串；不是结构化取消码校验。
		if (/\b(?:abort(?:ed)?|cancel(?:l?ed)?)\b/i.test(message.errorMessage ?? "")) return;
		// 检测到或已提示安装变化就优先使用那条建议，不再追加普通/bug提示。
		if (this.maybeShowInstallChangeWarning()) return;
		// 通过过滤后调用一次性建议助手，仍可能因已提示门禁而不新增文字。
		this.suggestBugReport();
	}

	/**
	 * After an error, check whether an update replaced or removed this install while the session ran.
	 * Code loaded on demand then fails with missing modules until restart (#10439). Returns true when
	 * the install changed.
	 */
	// 出错后检测当前安装清单是否变化，必要时只提醒重启，返回是否按安装变化处理；例其他终端更新了当前安装版本。
	// 不更新/恢复安装或验证错误就是热更新造成；已提示直接true，不重复扫描，当前调用的同步读取/显示异常没有本地统一catch。
	private maybeShowInstallChangeWarning(): boolean {
		// 已显示过变化警告就返回true，不要求这次再次detect仍有结果，确保后续错误不反复给普通bug建议。
		if (this.installChangeWarningShown) return true;
		// 检查进程启动时记住的package.json原位置，Bun二进制等按下层规则跳过；这是磁盘线索，不是全目录完整性校验。
		const change = detectInstallChange();
		// 无结论就返回false，允许调用者继续普通错误提示；不等于已证明安装没有任何变化。
		if (!change) return false;
		// 先记警告已显示，下面格式化/输出失败也不会自动清回false。
		this.installChangeWarningShown = true;
		// 根据updated/removed联合生成不同的原因说明。
		// updated分支提示磁盘版本与本进程VERSION差异，不在这里重新加载新版本代码。
		// 其他kind按移除/替换说明，不包含不存在的version值。
		const cause =
			// kind严格updated时TS可读取该分支必有的version字段。
			change.kind === "updated"
				? `${APP_NAME} was updated to ${change.version} while this session was running (${VERSION})`
				: `The ${APP_NAME} installation this session runs from was removed or replaced`;
		// 若TTY、持久化且文件已存在，尝试生成恢复命令；格式化本身不执行恢复。
		const resumeCommand = formatResumeCommand(this.sessionManager);
		// 有可用恢复命令才给完整命令建议，否则只建议重启应用。
		// 有恢复命令时把已做好目录引用的命令置于反引号，不在这里运行shell。
		// 兜底不假造会话ID/文件路径。
		const restart = resumeCommand
			? `Restart with \`${resumeCommand}\` to continue this session.`
			: `Restart ${APP_NAME}.`;
		// 显示安装变化与按需加载可能失败的说明，不把提示当自动修复完成。
		this.showWarning(`${cause}. Features that load code on demand can fail until restart. ${restart}`);
		// 返回true表示使用了/已使用过安装变化警告路径，不表示本次业务操作成功。
		return true;
	}

	// 清理旧会话显示投影并按当前会话历史重建，返回void；例Runtime切换后丢旧流组件/待工具显示。
	// 只改UI和本实例compaction队列，不删除持久化条目、不直接abort旧Agent；资源清单先清但本方法不单独再showLoadedResources。
	private renderCurrentSessionState(): void {
		// 清资源显示区域，后续bindCurrentSessionExtensions可重建。
		this.loadedResourcesContainer.clear();
		// 清聊天组件树，不是SessionManager.clear或删除会话文件。
		this.chatContainer.clear();
		// 清待发送展示区，不在这行操作Session的steering/follow-up队列。
		this.pendingMessagesContainer.clear();
		// 替换UI压缩队列为空数组，旧临时输入不再由本队列提交。
		this.compactionQueuedMessages = [];
		// 不再持有旧助手显示行，防止新事件继续更新旧聊天组件。
		this.streamingComponent = undefined;
		// 清旧流式消息引用，后续start事件重新建立。
		this.streamingMessage = undefined;
		// 清工具ID到显示组件的Map，不代表所有真实工具进程已经停止。
		this.pendingTools.clear();
		// 根据当前会话上下文/条目重画初始聊天，历史工具只是渲染不再执行。
		this.renderInitialMessages();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	/**
	 * Extension-registered definition, falling back to the built-in one. The renderer components take
	 * whatever this returns, so they never reach into the tool registry themselves.
	 */
	// 解析指定工具的显示方法，返回类型由TS推断；扩展resolver按加载/注册顺序可包裹或短路，全部委托后才取Session定义并补内置槽。
	// 例如扩展给read定制调用行、后备保留内置结果显示；方法可能运行渲染解析回调，但不执行工具，不保证一定有渲染器，也没有这里的结果缓存。
	private getRegisteredToolDefinition(toolName: string) {
		// runner接收延迟base函数，扩展不调用next时下面的内置/定义查找可完全不执行。
		return this.session.extensionRunner.resolveToolRenderers(toolName, () =>
			// 后备取当前工具注册定义，补缺失renderCall/renderResult；不把已有自定义槽整体覆盖成内置实现。
			withBuiltInRenderers(toolName, this.session.getToolDefinition(toolName)),
		);
	}

	// 取得Markdown显示变换器数组，内置Mermaid总在最前，后面按扩展加载顺序，返回新数组；不在取列表时解析正文。
	// 例如某条消息渲染时才依序调用这些函数；扩展函数引用共享，不在这里复制闭包或校验输出。
	private getMarkdownTransformers(): MarkdownTransformer[] {
		// 数组展开组合已有内置闭包与runner新取的扩展列表，不修改原注册数组。
		return [this.mermaidMarkdownTransformer, ...this.session.extensionRunner.getMarkdownTransformers()];
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	// 按有效应用键位解析扩展快捷键并安装默认编辑器拦截器，返回void；例扩展绑定ctrl+x，命中后先于普通编辑动作执行handler。
	// 每次解析重建冲突诊断，仅restrictOverride:true的保留内置动作不可覆盖，其他内置动作可被扩展覆盖并警告、扩展同键后加载者胜出；本方法只在非空结果时替换回调，空结果早返本身不清旧拦截器。
	// 上下文按命中时创建，处理器异步拒绝显示错误；但createContext和handler的同步抛错发生在Promise.resolve之前，不被这条catch兜住。
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		// 把用户覆盖合并后的有效键配置交runner计算，不能只用内置默认键检查冲突；返回Map按规范化键索引。
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		// 没有有效扩展键直接结束，未在这一分支给onExtensionShortcut赋undefined，清旧UI由其他生命周期逻辑负责。
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		// 局部无参工厂每次创建新ExtensionContext对象，箭头的({})是返回对象；字段快照与动态方法混合，不是所有值都实时getter。
		const createContext = (): ExtensionContext => ({
			// 创建当前交互UI闭包对象，可弹对话或改组件，不立刻执行这些动作。
			ui: this.createExtensionUIContext(),
			// 上下文mode写tui，供扩展知道当前宿主呈现方式，不切渲染器模式。
			mode: "tui",
			// 声明此上下文提供UI入口，不保证所有用户终端能力或自定义编辑器可选方法都存在。
			hasUI: true,
			// cwd字符串在createContext调用时读取，之后切会话不会自动改这个普通字段。
			cwd: this.sessionManager.getCwd(),
			// 把当前SessionManager引用放进只读上下文契约，不复制会话树，也不把对象运行时冻结。
			sessionManager: this.sessionManager,
			// 注册器来自本次解析用的extensionRunner，返回同一引用，不在此刷新目录。
			modelRegistry: extensionRunner.getModelRegistry(),
			// model是在本次创建上下文时取的引用，之后模型切换不会自动替换已保存ctx.model字段。
			model: this.session.model,
			// 范围列表同样按当前时点取值，未在此复制每个模型对象。
			scopedModels: this.session.scopedModels,
			// thinkingLevel为本次调用时的值，不通过属性getter持续跟踪。
			thinkingLevel: this.session.thinkingLevel,
			// 与上面快照字段不同，isIdle箭头每次执行现取this.session状态，不主动等待或取消。
			isIdle: () => this.session.isIdle,
			// 信任判断也延迟读当前SettingsManager，不因hasUI:true就自动授信。
			isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
			// signal在对象创建时从Agent取得，普通字段不会随之后新run/新session自动变成另一个信号。
			signal: this.session.agent.signal,
			// abort是同步意图入口，通过宿主队列恢复逻辑请求取消，不直接暴露Agent内部控制器。
			abort: () => {
				// 先把排队文字回填，再发取消请求；不等待工具/模型实际停下。
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			// 动态读取当前Session.pendingMessageCount，大于0为真；这里不另加本UI compactionQueuedMessages长度。
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			// 此快捷键上下文shutdown只记退出请求，和上面bindExtensions中空闲即启动shutdown的处理器并非完全相同路径。
			shutdown: () => {
				// 设标志后等待后续处理机会，本回调不直接process.exit或保证此刻空闲就退出。
				this.shutdownRequested = true;
			},
			// 动态委托当前会话的上下文用量估算，返回其可缺省结果；不是对文本重新tokenize的UI算法。
			getContextUsage: () => this.session.getContextUsage(),
			// compact入口保持同步void签名，真正工作由下面异步IIFE启动，扩展通过onComplete/onError回调收结果。
			compact: (options) => {
				// 立刻调用async箭头生成Promise并丢弃返回值，void不自动吞拒绝。
				void (async () => {
					// try包实际压缩及成功回调，因此成功回调自己抛错也会走onError。
					try {
						// 只把可选customInstructions交手动压缩，不在这层设置新的模型/摘要提示默认值。
						const result = await this.session.compact(options?.customInstructions);
						// 有完成回调才调用，未await它返回的任何Promise；它同步抛错则被下面catch捕获。
						options?.onComplete?.(result);
						// 压缩拒绝或同步完成回调异常都进此分支，不表示压缩一定没写入结果。
					} catch (error) {
						// Error原样保留，其他值用String包成新Error；字符串转换仍可抛出，catch内没再套保护。
						const err = error instanceof Error ? error : new Error(String(error));
						// 有onError才通知；其同步抛错会使后台IIFE拒绝，返回的Promise则未await，其拒绝另有未处理风险，都不会由当前catch重新捕获。
						options?.onError?.(err);
					}
					// })();同时结束箭头定义并立即调用，不是只保存一个稍后执行函数。
				})();
			},
			// 动态取当前会话实际systemPrompt文字，不在这里重新加载文件或拼技能列表。
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		// 为默认编辑器设置扩展拦截器，输入原始终端数据串，返回是否消费；自定义编辑器如何继承此入口由替换逻辑负责。
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			// 按最终Map顺序查首个匹配键，不为同一输入并发执行所有匹配handler。
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				// as KeyId只协调静态键格式类型，不运行时校验扩展声明；matchesKey负责解释输入/键位是否匹配。
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					// 先同步创建上下文并调用handler，再把其返回值/Promise交Promise.resolve；因此catch只接已取得返回值之后的拒绝，不兜同步求值异常。
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						// 异步拒绝显示统一错误，Error用message其余String；showError自身抛错会让catch返回的Promise再次拒绝，链尾未另处理。
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					// 命中立即返回true，表示消费输入，不等扩展工作做完，也不表示它最终成功。
					return true;
				}
			}
			// 无匹配返回false，让CustomEditor继续应用/基础编辑器输入路由。
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	// 按key设置/删除扩展页脚状态并请求一帧，返回void；例如setStatus("build","running")覆盖同key，undefined删除。
	// 不写会话历史、不执行任务或设置过期时间，空串仍按FooterDataProvider规则保留为值。
	private setExtensionStatus(key: string, text: string | undefined): void {
		// 数据源原地改Map，不在这里统一重新计算Git或模型用量。
		this.footerDataProvider.setExtensionStatus(key, text);
		// 显式请求重绘，因为数据源状态setter本身不会广播分支变化。
		this.ui.requestRender();
	}

	// 尝试把指示器放到当前编辑器边框，返回是否支持；例默认启用embed的CustomEditor可接受，普通扩展Editor返回false。
	// 先清默认编辑器槽再探测当前编辑器，不启动/销毁传入状态，也不自动requestRender；undefined表示清该槽。
	private setEditorWorkingStatusIndicator(indicator: StatusIndicator | undefined): boolean {
		// 无论当前editor是谁都先清默认槽，避免切回默认时看到过期状态。
		this.defaultEditor.setWorkingStatusIndicator(undefined);
		// 当前编辑器必须显式embedWorkingStatus:true且有设置方法才可嵌入，不因接口上可选borderColor就视作支持。
		if (!isEmbeddedStatus(this.editor)) return false;
		// 保存传入状态或undefined，由当前编辑器下次render决定如何画；方法异常直接传播。
		this.editor.setWorkingStatusIndicator(indicator);
		// true只表示调用了支持的setter，不证明边框已经在终端绘制出来。
		return true;
	}

	// 替换当前指示器，优先嵌入编辑器，不能嵌入才放状态区，返回void；例如自定义编辑器不支持embed时工作动画另占行。
	// 会dispose旧指示器、清容器并改字段，不取消业务；同一对象再次传入也会先被dispose，没有对象同一性特殊保护或失败回滚。
	private showStatusIndicator(indicator: StatusIndicator): void {
		// 存在旧指示器就释放其动画/倒计时，未清真实Agent/压缩控制器。
		this.activeStatusIndicator?.dispose();
		// 保存新对象为活跃状态，之后渲染/更新工作配置会读它。
		this.activeStatusIndicator = indicator;
		// 先默认记非嵌入，只有后面设置成功才改true。
		this.activeWorkingIndicatorEmbedded = false;
		// 清临时状态区已有组件，不动聊天或排队消息。
		this.statusContainer.clear();
		// 先清当前编辑器状态槽；辅助同时也会清默认编辑器槽，保留原调用次序。
		this.setEditorWorkingStatusIndicator(undefined);
		// 再尝试安装新指示器，返回值只表示编辑器能力分支。
		if (this.setEditorWorkingStatusIndicator(indicator)) {
			// 记录它使用边框显示，清理时可区分是否需要补状态占位。
			this.activeWorkingIndicatorEmbedded = true;
			// 嵌入成功就不把同一指示器再加到状态容器，避免两处显示。
			return;
		}
		// 无法嵌入则把原状态组件挂进单独区域，状态对象自身可已在构造时启动动画。
		this.statusContainer.addChild(indicator);
	}

	// 清活动状态，可指定只清某kind，返回void；例clearStatusIndicator("working")不打断仍在显示的compaction提示。
	// dispose/清字段/容器/边框后，原状态非嵌入且普通模式启缩短清屏时补两行IdleStatus占位；不取消真实任务、不在这里requestRender。
	private clearStatusIndicator(kind?: StatusIndicator["kind"]): void {
		// 指定kind且当前kind不相等（含根本没活动对象）就原样返回，不执行后面的容器清理。
		if (kind && this.activeStatusIndicator?.kind !== kind) {
			// 早返保留其他类型的动画与显示，防止隐藏working误删重试/摘要状态。
			return;
		}
		// 保存旧对象引用，清字段后仍可按它是否存在决定补空闲占位。
		const clearedIndicator = this.activeStatusIndicator;
		// 同样保存旧嵌入标记，不从已经清空的状态重新推测。
		const clearedIndicatorWasEmbedded = this.activeWorkingIndicatorEmbedded;
		// 若有对象就dispose动画，异常会中断后续清理，没有finally兜底。
		clearedIndicator?.dispose();
		// 清活跃对象引用，不再接受setWorkingIndicator对旧对象更新。
		this.activeStatusIndicator = undefined;
		// 重置嵌入标记，和对象引用一起表示当前无活跃状态。
		this.activeWorkingIndicatorEmbedded = false;
		// 清状态容器，也会移除之前可能已有的IdleStatus。
		this.statusContainer.clear();
		// 清当前/默认编辑器边框状态槽；不保证某个已被替换的旧自定义编辑器对象也被遍历清理。
		this.setEditorWorkingStatusIndicator(undefined);
		// 跨行条件决定是否留空闲占位，而非所有清状态场景都加空行。
		if (
			// 必须本次确实清掉过一个对象，空清理不额外加IdleStatus。
			clearedIndicator &&
			// 原状态在单独行显示才补占位，原本嵌入边框无需腾出同样高度。
			!clearedIndicatorWasEmbedded &&
			// 仅本实例options标记regular模式时采用此主屏显示策略。
			this.options.tuiMode === "regular" &&
			// 还要当前TUI启用clearOnShrink，避免内容缩小时旧状态区清理不合预期。
			this.ui.getClearOnShrink()
		) {
			// 挂常驻IdleStatus，其render返回两行空格，不启动动画或表示Agent已被本方法判空闲。
			this.statusContainer.addChild(this.idleStatus);
		}
	}

	// 创建并展示WorkingStatusIndicator，输入来自现有工作文案/动画配置，返回void；当前编辑器支持嵌入时用它的边框色，否则用默认主题。
	// 构造可启动动画并请求绘制，替换旧状态由showStatusIndicator负责；本方法本身不检查workingVisible或Agent忙碌，调用者需决定何时调用。
	private showWorkingStatusIndicator(): void {
		// 以当前编辑器是否支持嵌入决定是否提供统一颜色回调。
		// 支持时保存箭头，在真正着色时现读this.editor/思考级别，不固定捕获旧编辑器对象。
		// 非嵌入不传统一色，WorkingStatusIndicator按自身默认分别给动画accent/文字muted。
		const colorFn = isEmbeddedStatus(this.editor)
			? (text: string) =>
					// 有borderColor优先，否则用当前思考级别的主题边框色；||让缺省/空值回off，不在这里修改模型级别。
					(this.editor.borderColor ?? theme.getThinkingBorderColor(this.session.thinkingLevel || "off"))(text)
			: undefined;
		// 统一走状态替换/嵌入选择流程，不再自行直接加两处组件。
		this.showStatusIndicator(
			// 创建工作状态，基类Loader可能立即更新文字并开计时器。
			new WorkingStatusIndicator(
				// 给动画稳定ui入口，切渲染器后请求绘制仍可转发当前实例。
				this.ui,
				// ??只在workingMessage空缺才用默认Working，显式空串会保留为空文案。
				this.workingMessage ?? this.defaultWorkingMessage,
				// 传扩展设的动画帧/间隔等原配置，未在这行复制或新增参数。
				this.workingIndicatorOptions,
				// 传上面可选统一颜色回调，渲染时才执行。
				colorFn,
			),
		);
	}

	// 设置工作指示器是否可见并刷新，返回void；隐藏只清working类状态，不关闭真实任务或其他kind动画。
	// 例如visible:true且会话流式中、当前不是working，会新建工作状态，可能替换当时另一kind；不把它描述成只恢复已保存旧对象。
	private setWorkingVisible(visible: boolean): void {
		// 先保存可见偏好，后续agent_start等事件可据此决定显示。
		this.workingVisible = visible;
		// false路径仅处理工作显示，先走带kind过滤的清理。
		if (!visible) {
			// 当前若为retry/compaction，过滤条件会让clearStatusIndicator不动它。
			this.clearStatusIndicator("working");
			// 隐藏路径请求重绘，清状态函数本身没有此调用。
			this.ui.requestRender();
			// 立即结束，避免进入下面“正在流式就显示”的分支。
			return;
		}
		// 显示偏好为真且session正在流式、当前kind非working才新建；未要求当前完全没有其他状态。
		if (this.session.isStreaming && this.activeStatusIndicator?.kind !== "working") {
			// 重建工作指示器并替换旧状态，不恢复某个曾dispose的旧动画对象。
			this.showWorkingStatusIndicator();
		}
		// 即使没新建状态也请求一帧，使可见偏好相关显示可更新。
		this.ui.requestRender();
	}

	// 更新工作动画配置，并在当前kind为working时交已有指示器即时应用，返回void；例传自定义帧，undefined恢复底层默认策略。
	// 不更改文案、不创建新的Agent运行；只对活跃工作对象调用setIndicator，其他kind保持自身配置。
	private setWorkingIndicator(options?: WorkingIndicatorOptions): void {
		// 保存options原引用供以后新建WorkingStatusIndicator，未深拷贝frames数组。
		this.workingIndicatorOptions = options;
		// 只更新working，避免把工作帧覆盖到重试/压缩动画。
		if (this.activeStatusIndicator?.kind === "working") {
			// 委托继承Loader的setIndicator，可能重建计时/文字显示，不在本函数重复实现帧循环。
			this.activeStatusIndicator.setIndicator(options);
		}
		// 显式请求重绘，无活动working时仍保存偏好供下次使用。
		this.ui.requestRender();
	}

	// 更新隐藏思考块的占位标题并应用到已有助手组件/当前流组件，返回void；例传“分析中”只改UI标签，不改真实thinking正文。
	// undefined回默认，空串保留；遍历聊天直接子项，当前流组件若已在其中可能被调用两次，不宣称全树每个助手只更新一次。
	private setHiddenThinkingLabel(label?: string): void {
		// ??只对nullish回默认Thinking...，不会把显式空文字当缺省。
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		// 遍历当前chatContainer.children，不递归扩展组件/其他容器。
		for (const child of this.chatContainer.children) {
			// 只有真正AssistantMessageComponent实例才调用其专用setter，其他消息/工具行不修改。
			if (child instanceof AssistantMessageComponent) {
				// 把本实例新标题交助手显示对象，是否立即重算内容由组件setter负责。
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		// 另处理正在流式的组件引用，防止它不在聊天直接子项时漏掉。
		if (this.streamingComponent) {
			// 同一对象可能已在循环中更新过，这里仍保留原实现的再次赋值。
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		// 请求重绘，不向模型发送新的思考要求或改thinkingLevel。
		this.ui.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	// 按key设置/移除编辑器上下方挂件，返回void；字符串数组转Text容器，工厂则用当前ui/theme创建自定义组件。
	// 例如同key从above改below，先从两区删旧对象再加入目标区；undefined只移除。字符串分支只取前10项并加截断提示，工厂输出没有这条限制。
	// 先dispose旧组件才创建新组件，工厂/清理失败不回滚旧UI；这里只限制数组项数，不保证折行后的屏幕高度或全部挂件总高度。
	private setExtensionWidget(
		// key作为上下两区共同查找的名称，重复设置会替换原对象，不是文件路径或会话条目ID。
		key: string,
		// 联合允许字符串数组、同步工厂或undefined；&要求返回组件还能可选dispose，不允许这个签名直接返回Promise。
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		// 位置配置可缺省，下面默认放编辑器上方。
		options?: ExtensionWidgetOptions,
		// 动作返回void，创建/清理副作用在本次调用同步发生。
	): void {
		// ??仅缺值才取aboveEditor，显式belowEditor保持；运行时不在此schema校验位置文字。
		const placement = options?.placement ?? "aboveEditor";
		// 局部清理函数接某一挂件Map，使用外层key查并尽力按可选dispose清理；没有try捕获清理异常。
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			// 取对应key旧组件，缺键为undefined。
			const existing = map.get(key);
			// 存在真值dispose才以对象方法调用，保持接收者；typed契约已约定可选函数，未额外typeof检查。
			if (existing?.dispose) existing.dispose();
			// dispose成功后才删键；若dispose抛错，本Map键仍在，后面另一区清理也会被跳过。
			map.delete(key);
		};

		// 先从上方区域移除同key，不论新placement为何。
		removeExisting(this.extensionWidgetsAbove);
		// 再清下方同key，因此同一次设置目标是让该key只出现在一个区域。
		removeExisting(this.extensionWidgetsBelow);

		// 只有undefined代表纯删除，空数组仍创建一个空容器，工厂也不会被视作空内容。
		if (content === undefined) {
			// 删除后重建两个插件槽的子组件/占位并请求重绘。
			this.renderWidgets();
			// 结束当前设置，不再创建或登记替代对象。
			return;
		}

		// 先声明最后要登记的组件变量，两种内容分支均会赋值；类型不自动new任何对象。
		let component: Component & { dispose?(): void };

		// 数组分支显示字符串列表，其余分支按工厂调用；保留原运行时Array.isArray，不改联合类型业务判断。
		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			// 新Container负责把各Text依序竖排，不直接把原content数组交给渲染器。
			const container = new Container();
			// slice复制前最多10项，限制的是数组项数，每项Text内部仍可能折行/含多行。
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				// 每项水平边距1、垂直边距0，原line不trim或改写。
				container.addChild(new Text(line, 1, 0));
			}
			// 原数组长度超过10才另加提示，这一提示本身不计入前10项上限。
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				// 用延迟主题色标记截断，不展示被省略的内容，也不删原content数组项。
				container.addChild(new ThemedText(() => theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			// 把新容器作为最终组件，它没有额外工厂专用dispose逻辑。
			component = container;
		} else {
			// Factory function - create component
			// 同步执行扩展工厂，可能分配资源或抛错；此刻两个旧key位置已移除，失败没有自动恢复。
			component = content(this.ui, theme);
		}

		// 只有placement精确belowEditor才选下方，其他运行时值按原表达式走上方。
		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		// 按key登记创建结果，Map插入顺序决定同区域显示先后；替换前已删旧键，因此会排到末尾。
		targetMap.set(key, component);
		// 重建区域显示并请求帧，不把挂件内容写入会话历史。
		this.renderWidgets();
	}

	// 清理全部扩展挂件并重建空槽位，返回void；例如会话重载先释放旧组件定时器。
	// 按上方→下方顺序调用可选dispose，再清Map；任一dispose抛错会打断后续步骤，没有“保证所有对象都清完”的finally。
	private clearExtensionWidgets(): void {
		// 先遍历上方Map值，按插入顺序处理。
		for (const widget of this.extensionWidgetsAbove.values()) {
			// 有dispose才调用，没有则仅在稍后的clear解除Map引用；不递归销毁组件所有子资源。
			widget.dispose?.();
		}
		// 再遍历下方，同一个组件若被不同key登记多次可能收到多次dispose。
		for (const widget of this.extensionWidgetsBelow.values()) {
			// 可选清理错误直接传播，本层不按对象逐个catch。
			widget.dispose?.();
		}
		// 上方条目整体清空，此时上述两轮dispose均已正常走完。
		this.extensionWidgetsAbove.clear();
		// 下方同样清空，不删除编辑器或页脚。
		this.extensionWidgetsBelow.clear();
		// 重建插件容器，默认上方空时留Spacer，下方空时无占位。
		this.renderWidgets();
	}

	// 撤掉旧扩展贡献的UI：清对话/一层浮层/输入订阅/页头页脚/挂件/状态，恢复默认编辑器、补全、标题和工作显示偏好。
	// 返回void，供会话失效或reload使用；有组件dispose/主题/输入等副作用，没有统一回滚或逐项失败隔离。
	// 例如选择框dispose只停倒计时而不resolve其Promise，所以此重置不保证所有等待中的对话都已取消完成；hideOverlay也只调用一次，不等于清整个浮层栈。
	private resetExtensionUI(): void {
		// 有扩展行内对话才遍历清理/重建输入槽，没有则跳过这组操作。
		if (this.extensionDialogs.length > 0) {
			// 按栈数组当前顺序处理全部组件，不只处理可见顶项。
			for (const dialog of this.extensionDialogs) {
				// 只调用可选dispose，不调用各对话封闭的finish/resolve取消逻辑；未知组件自己决定清哪些资源。
				dialog.component.dispose?.();
			}
			// 清空本实例对话栈引用，不能据此断言Promise已结算或组件外部引用不存在。
			this.extensionDialogs = [];
			// 无顶层对话后恢复当前editor、焦点并清extension-dialog阻塞状态。
			this.showTopExtensionDialog();
		}
		// 移除当前最上层overlay的一次调用，未循环清隐藏/嵌套浮层，也不一定调用自定义组件done。
		this.ui.hideOverlay();
		// 退订本实例记录的扩展输入监听，不影响TUI其他非扩展监听。
		this.clearExtensionTerminalInputListeners();
		// 恢复内置页脚，旧自定义页脚可选dispose会同步执行。
		this.setExtensionFooter(undefined);
		// 恢复内置页头，尚未初始化页头时该方法按自己的门禁直接返回。
		this.setExtensionHeader(undefined);
		// 清上下方挂件并重建空区域，占位行为按renderWidgets实现。
		this.clearExtensionWidgets();
		// 删除页脚数据源里的所有扩展setStatus记录，不清Git分支缓存/监听。
		this.footerDataProvider.clearExtensionStatuses();
		// 让内置页脚缓存失效，以后重绘读到已清状态。
		this.footer.invalidate();
		// 把补全包装工厂列表整体换成空数组，旧wrapper不再被后续setup套入；没有统一调用其dispose契约。
		this.autocompleteProviderWrappers = [];
		// 恢复默认编辑器并保留当前getText文字；自定义编辑器没有在这里约定或调用通用dispose。
		this.setCustomEditorComponent(undefined);
		// 重建仅基础补全，更新编辑器；设置技能Map也会随当前资源重新生成。
		this.setupAutocompleteProvider();
		// 明确清内置编辑器的扩展快捷键拦截，避免setupExtensionShortcuts空结果早返留下旧回调。
		this.defaultEditor.onExtensionShortcut = undefined;
		// 把扩展自定义的窗口标题恢复成当前会话/cwd标题，不改会话名称。
		this.updateTerminalTitle();
		// 工作文案覆盖清成undefined，后面按默认Working显示。
		this.workingMessage = undefined;
		// 恢复工作可见偏好true，不因这行自动让Agent开始工作。
		this.workingVisible = true;
		// 清动画自定义配置，若当前是working会委托其setIndicator恢复默认。
		this.setWorkingIndicator();
		// 只有活动working类状态才重写提示文案，retry/compaction等不被这一块覆盖。
		if (this.activeStatusIndicator?.kind === "working") {
			// 直接改当前工作对象的message，不新建/替换指示器。
			this.activeStatusIndicator.setMessage(
				// 默认Working后附当前中断按键提示；与setWorkingMessage(undefined)只用默认文案的路径不同，保留原行为。
				`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`,
			);
		}
		// 恢复隐藏思考标题默认值并更新已有助手显示组件，随后会请求重绘。
		this.setHiddenThinkingLabel();
	}

	// Maximum total widget lines to prevent viewport overflow
	// 这条类级常量只用于每个字符串挂件截取前10项；原英文“total lines”是概述，不是所有挂件/折行总高度或工厂组件的硬上限。
	// static属于类本身，readonly/private仅TS约束，不创建运行时全局限流器。
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	// 把上下方挂件Map中的组件重新挂到各自显示容器并请求重绘，返回void；上方空槽也留一行，下方不留。
	// 只重挂已有组件，不调用工厂或dispose，未按MAX_WIDGET_LINES裁剪整个区域；容器未构造时提前返回。
	private renderWidgets(): void {
		// 构造早期可能还没有两个容器，原实现有门禁；!字段断言不会在运行时自动创建它们。
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		// 上方区域空时留Spacer，有内容时也先加一个leadingSpacer。
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		// 下方区域空时完全空，有内容时也不额外前置空行。
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		// 两个区域重建后请求一帧，不同步等待终端完成绘制。
		this.ui.requestRender();
	}

	// 重建单个挂件容器：先清children，无挂件按选项留白，有挂件按Map顺序加组件，返回void。
	// 例上方使用true/true可与编辑器隔开；本方法不销毁组件、不单独requestRender，调用方统一安排。
	private renderWidgetContainer(
		// 目标Container是要改的显示槽，非创建新容器返回。
		container: Container,
		// Map值是已创建组件，可选dispose在本方法不调用。
		widgets: Map<string, Component & { dispose?(): void }>,
		// 空Map时是否加入一行占位，是布尔显示策略而非内容上限。
		spacerWhenEmpty: boolean,
		// 非空Map是否在最前加入一行，与空占位开关分开。
		leadingSpacer: boolean,
		// 返回void，结果体现在目标container.children原地变化。
	): void {
		// 只解除旧children列表引用，不dispose那些原组件。
		container.clear();

		// 按Map键数判断是否为空，不逐个render检查实际可见高度。
		if (widgets.size === 0) {
			// 空时只有spacerWhenEmpty真才放占位。
			if (spacerWhenEmpty) {
				// 加入一行Spacer，让空上方区保持所需间隔。
				container.addChild(new Spacer(1));
			}
			// 空区域处理后return，不再走非空leadingSpacer分支。
			return;
		}

		// 有挂件时按leadingSpacer另决定前置空行。
		if (leadingSpacer) {
			// 前置一行，后面的组件不会被额外逐项加间隔。
			container.addChild(new Spacer(1));
		}
		// Map.values按插入顺序遍历，不按key字典排序。
		for (const component of widgets.values()) {
			// 挂同一组件引用，不重建其内部状态/文字，也不在这里限制其高度。
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	// 替换/恢复页脚组件，输入同步工厂或undefined，返回void；例工厂可用只读类型footerData查询Git分支和扩展状态。
	// 先dispose旧自定义项并清槽，再调用工厂或恢复内置对象，最后请求帧；工厂/清理抛错没有回滚，ReadonlyFooterDataProvider只是TS视图，不冻结底层对象。
	private setExtensionFooter(
		// factory参数的联合在下面分行写，整体允许缺省值undefined，不是函数的返回值可以undefined。
		// 工厂接稳定TUI/主题/只读页脚数据，返回Component加可选dispose；不会在类型声明阶段执行。
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			// 传undefined表示恢复内置页脚，不是永久隐藏页脚槽。
			| undefined,
		// 替换动作同步返回void，工厂不按此契约返回Promise。
	): void {
		// Dispose existing custom footer
		// 旧自定义页脚有dispose才清理，不对内置footer调用同样步骤。
		if (this.customFooter?.dispose) {
			// 以对象方法形式执行保留this，失败会中断后面清槽/新建。
			this.customFooter.dispose();
		}

		// 清显示槽children，但到这里customFooter字段尚指旧对象，工厂失败不自动恢复它的显示。
		this.footerContainer.clear();
		// 有工厂就创建新自定义对象，否则走内置分支。
		if (factory) {
			// Create and add custom footer, passing the data provider
			// 同步执行扩展工厂并保存结果，实际可分配监听/计时器；传数据源原对象的只读类型视图。
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			// 挂进页脚容器，后续显示由该组件render决定。
			this.footerContainer.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			// 清自定义引用，使后续逻辑知道使用内置页脚。
			this.customFooter = undefined;
			// 重新挂已有FooterComponent，而不是重造其数据源/Git监听。
			this.footerContainer.addChild(this.footer);
		}

		// 请求重绘显示替换结果，不确认终端是否已呈现。
		this.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	// 替换/恢复页头，输入同步组件工厂或undefined，返回void；例自定义可展开页头会同步当前toolOutputExpanded。
	// 未建builtInHeader时直接忽略请求；已有页头先dispose自定义项、找旧位置再替换，新建时找不到位置则插最前，恢复时找不到则不补插。
	// 组件工厂/清理异常直接传播，没有保留旧页头的事务回滚。
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		// 早期尚无内置页头就不调用工厂，也不把请求排队到以后自动应用。
		if (!this.builtInHeader) {
			// 立即结束，原自定义页头字段/容器在这条分支不变。
			return;
		}

		// Dispose existing custom header
		// 旧自定义页头有dispose才释放，内置页头不用这一额外清理入口。
		if (this.customHeader?.dispose) {
			// 清理同步执行，失败就跳过后面替换/恢复。
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		// 用当前自定义对象优先，否则内置对象，作为要在容器children里查找的引用。
		const currentHeader = this.customHeader || this.builtInHeader;
		// indexOf按对象身份找位置，不按组件名称/type匹配，找不到为-1。
		const index = this.headerContainer.children.indexOf(currentHeader);

		// 传工厂走新建分支，undefined走恢复内置。
		if (factory) {
			// Create and add custom header
			// 同步执行工厂并保存结果；此刻旧自定义对象可能已dispose，出错不回滚。
			this.customHeader = factory(this.ui, theme);
			// 运行时探测新页头是否实现setExpanded能力，不要求它继承ExpandableText。
			if (isExpandable(this.customHeader)) {
				// 支持时同步全局工具展开状态，不使用启动verbose做单独覆盖。
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			// 找得到旧位置就原位替换，保留页头前后其他Spacer/提示的位置。
			if (index !== -1) {
				// 直接修改children索引，不调用addChild或销毁旧对象。
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				// 新自定义项找不到原位置时unshift到最前，与恢复分支只替换已有位置的行为不同。
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			// 恢复时先清自定义引用，即使后面找不到原位置也仍清字段。
			this.customHeader = undefined;
			// 内置页头也可能是空Text，只有支持Expandable才同步展开。
			if (isExpandable(this.builtInHeader)) {
				// 修改原内置组件状态，不重造完整启动帮助。
				this.builtInHeader.setExpanded(this.toolOutputExpanded);
			}
			// 只有旧位置存在才恢复挂载；没位置不在这条分支自动unshift。
			if (index !== -1) {
				// 将保留的builtInHeader对象放回原槽位。
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		// 正常走完请求重绘，早期未初始化页头的return没有此请求。
		this.ui.requestRender();
	}

	// 登记扩展原始输入拦截器并返回off闭包，返回值用于以后取消；切换渲染器时同一记录可更新底层unsubscribe。
	// 只注册不调用handler；记录Set按对象区分，而内置TUI按handler函数去重，同一函数重复登记不等于两个独立底层订阅。
	private addExtensionTerminalInputListener(
		// handler可消费或替换data，undefined代表继续，不在本方法验证回调返回对象。
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
		// 返回类型是无参清理函数，不返回订阅ID或Promise。
	): () => void {
		// 先向当前TUI注册并保存其退订器，再组装记录；ui是稳定Proxy但返回的off属于注册当时实例。
		const subscription = { handler, unsubscribe: this.ui.addInputListener(handler) };
		// Set保存记录对象，便于切模式后迁移，重复同handler也会创建不同记录对象。
		this.extensionTerminalInputSubscriptions.add(subscription);
		// 返回闭包以后才执行取消，读取记录里的最新unsubscribe，而不是固定捕获旧TUI的off。
		return () => {
			// 调用当前保存的底层off；内置TUI用Set.delete，若别的适配器抛错，后面的记录删除会被跳过。
			subscription.unsubscribe();
			// 删除本条记录，不遍历其他相同handler的记录；底层按函数去重带来的共享影响仍存在。
			this.extensionTerminalInputSubscriptions.delete(subscription);
		};
	}

	// 将已记录输入拦截器迁移到当前TUI，返回void；例切主屏/全屏后先退旧，再按同handler注册新实例。
	// 修改每条记录的off，已返回给扩展的off闭包因此能取消新订阅；单项失败会打断迁移，没有全批回滚。
	private rebindExtensionTerminalInputListeners(): void {
		// 按记录Set插入顺序处理，不重新执行扩展的注册函数。
		for (const subscription of this.extensionTerminalInputSubscriptions) {
			// 先退该条旧底层订阅，避免旧渲染器继续保有handler。
			subscription.unsubscribe();
			// 在稳定ui当前实例注册，并覆盖记录退订器，已发给扩展的外层闭包无需替换。
			subscription.unsubscribe = this.ui.addInputListener(subscription.handler);
		}
	}

	// 取消本实例记录的全部扩展输入订阅并清表，返回void；不清TUI其他监听器，不执行handler。
	// 清理器没有逐个try/catch，前项抛错时后项与最终Set.clear不会得到保证。
	private clearExtensionTerminalInputListeners(): void {
		// 逐条调用各自最新off，不假定它们都还属于同一旧TUI实例。
		for (const subscription of this.extensionTerminalInputSubscriptions) subscription.unsubscribe();
		// 成功遍历后清记录Set，外部仍可能持有以前返回的off闭包。
		this.extensionTerminalInputSubscriptions.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	// 为项目授权决策创建小范围上下文，输入待判断cwd，返回ProjectTrustContext；只暴露选择/确认/输入/通知。
	// 例如Runtime切换到新目录需要询问时用它；构造对象不自己授信、不修改信任存储，也不创建普通完整会话扩展ctx。
	private createProjectTrustContext(cwd: string): ProjectTrustContext {
		// 复用完整交互UI闭包，然后挑四个方法，不立即弹任何对话。
		const ui = this.createExtensionUIContext();
		// 返回新对象，各方法引用仍是上一步创建的箭头闭包。
		return {
			// 保留传入待判断目录，未在这行改process.cwd或normalize路径。
			cwd,
			// 模式标为tui，说明使用交互呈现而非RPC/print。
			mode: "tui",
			// 声明有UI入口，不作为资源代码已受沙箱保护或用户已同意的证据。
			hasUI: true,
			// 嵌套ui仅取四种问答能力，不转交自定义组件/编辑器/页脚等全部入口。
			ui: {
				// select引用绑定好的箭头，不依赖以后调用时ui对象的this。
				select: ui.select,
				// confirm同理返回用户选择布尔，不在这里伪造确认结果。
				confirm: ui.confirm,
				// input转交单行对话，具体取消/占位行为仍取决于实现。
				input: ui.input,
				// notify用于显示决策信息，返回void，不返回授权结果。
				notify: ui.notify,
			},
		};
	}

	// 建立交互模式的ExtensionUIContext适配对象，返回闭包/主题getter集合；例扩展ctx.ui.select最终走本类对话栈，ctx.ui.setWidget走挂件Map。
	// 创建本对象不立刻弹窗/复制/登录，但后续方法可以改UI、读主题文件或排队写主题设置；没有对整组能力自动加生命周期/权限校验。
	// 方法多数箭头捕获当前InteractiveMode，实际调用时会使用那时editor/session/renderer；某些getter返回共享对象，不能当不可变快照。
	private createExtensionUIContext(): ExtensionUIContext {
		// 新建外层接口对象，不是把本类所有private成员直接暴露给扩展。
		return {
			// select把标题、字符串选项、取消/超时原样交行内选择对话，返回其Promise。
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			// confirm用固定Yes/No选择实现，取消也映射false，不在适配层自行决定同意。
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			// input转交标题/placeholder/选项；当前底层ExtensionInputComponent未使用placeholder，不能保证会显示占位提示。
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			// notify按type选择状态/警告/错误显示，不返回等待结果。
			notify: (message, type) => this.showExtensionNotify(message, type),
			// 原始终端输入注册入口返回off，切TUI实例时记录可重绑。
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			// 页脚状态按key覆盖，undefined删除，立即安排重绘而不是保存为模型消息。
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			// 设置工作文案覆盖，返回void；当前有工作指示器时也更新它，不因此启动工作。
			setWorkingMessage: (message) => {
				// 保存message原值，undefined表示以后回默认，空串是有效覆盖。
				this.workingMessage = message;
				// 仅活动kind为working才改显示，压缩/重试提示不在这里被替换。
				if (this.activeStatusIndicator?.kind === "working") {
					// nullish才回默认Working，Loader.setMessage自己负责更新文字/请求帧；本回调未另显式requestRender。
					this.activeStatusIndicator.setMessage(message ?? this.defaultWorkingMessage);
				}
			},
			// 工作可见性转给统一方法，不把隐藏显示等同取消任务。
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			// 动画配置转给统一方法，省略参数恢复底层默认。
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			// 隐藏思考标题更新现有助手组件，实际thinking正文保持不变。
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			// 按key/内容/位置统一管理挂件，调用时才可能同步执行扩展工厂。
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			// 页脚工厂同步调用，undefined恢复内置页脚。
			setFooter: (factory) => this.setExtensionFooter(factory),
			// 页头工厂也同步，若内置页头尚未建立会按实现忽略请求，不在这里排队。
			setHeader: (factory) => this.setExtensionHeader(factory),
			// 直接交当前Terminal设窗口标题，不改SessionManager保存的会话名。
			setTitle: (title) => this.ui.terminal.setTitle(title),
			// 自定义组件入口返回泛型结果Promise，浮层/行内与清理由showExtensionCustom具体实现。
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			// 把原text嵌进括号粘贴起止序列后交编辑器handleInput，不直接setText；未在这里转义text内已有控制序列，解析效果由编辑器决定。
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			// setEditorText覆盖当前活动编辑器文字，不自动提交、不改默认编辑器之外的历史。
			setEditorText: (text) => this.editor.setText(text),
			// 支持getExpandedText时优先取展开大粘贴等后的文字，返回空串也保留；仅结果nullish才回getText。
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			// editor是“打开多行编辑对话”的方法名，与本类当前输入对象字段editor不是同一个公开值。
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			// 登记额外补全包装工厂并重建整个补全链，返回void；工厂以后会包当前基础provider。
			addAutocompleteProvider: (factory) => {
				// push保留注册先后，没有去重工厂函数或提供本接口级off；清理在resetExtensionUI。
				this.autocompleteProviderWrappers.push(factory);
				// 立即重新套全部wrapper，若某个工厂抛错，数组已含新项且没有回滚。
				this.setupAutocompleteProvider();
			},
			// 编辑器工厂转交替换方法，undefined恢复默认，并尽量保留原getText内容。
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			// 返回当前编辑器工厂引用或undefined，名字getEditorComponent并不返回已创建的editor实例。
			getEditorComponent: () => this.editorComponentFactory,
			// 对象getter使扩展以ui.theme读取共享主题入口，不是一个需要调用的theme()方法。
			get theme() {
				// 返回导入的稳定主题代理，换主题后其方法可读新主题，不复制一份固定颜色对象。
				return theme;
			},
			// 枚举可用主题与路径，可能同步读/解析用户主题文件，不是只读一个内存数组；返回列表的同名优先级与真正加载优先级可不同。
			getAllThemes: () => getAvailableThemesWithPaths(),
			// 按名称尝试加载Theme，失败返回undefined，不切全局主题；此入口也可有本地读取/解析工作。
			getTheme: (name) => getThemeByName(name),
			// setTheme区分Theme实例与名称，返回success/error对象；名称成功可排队保存用户设置，实例只安装在内存。
			setTheme: (themeOrName) => {
				// instanceof按当前模块Theme构造器原型判断，不按对象形状猜；TS据分支缩窄参数类型。
				if (themeOrName instanceof Theme) {
					// 直接实例安装会关闭自动深浅联动/文件watcher并通知重绘，不调用settingsManager.setTheme保存JSON名称。
					return this.themeController.setThemeInstance(themeOrName);
				}
				// 字符串交主题控制器按名切换，加载可能回退system并返回失败，不等价于纯预览。
				const result = this.themeController.setThemeName(themeOrName);
				// 仅返回成功才考虑保存名称，失败不把坏名称写用户设置。
				if (result.success) {
					// 与单主题getter比较；getTheme含/配对时为undefined，因此不会把配对当与单名相等。
					if (this.settingsManager.getTheme() !== themeOrName) {
						// 排队更新用户层主题名，可信项目同名设置仍可能覆盖有效视图；此方法返回时不保证磁盘已经写完。
						this.settingsManager.setTheme(themeOrName);
					}
				}
				// 原控制器结果透传，不等flush或终端最终显示完成。
				return result;
			},
			// 读取本实例全局展开标记，返回布尔，不逐个检查每个工具组件当前状态。
			getToolsExpanded: () => this.toolOutputExpanded,
			// 按目标状态修改可展开显示组件，覆盖范围也含实现Expandable的页头/资源，不只工具结果。
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show an extension dialog in the editor slot.
	 * Dialogs form a stack: a new dialog hides the visible one, and closing the visible dialog shows
	 * the previous one again. Every dialog stays answerable, so no dialog promise is left pending,
	 * and dialogs opened from inside another dialog (for example a confirm from a custom component) work.
	 */
	// 把扩展行内组件压栈并显示最新项，返回void；例如自定义面板里再开confirm，旧面板保留在栈下等待恢复。
	// 先清普通选择器的活动身份/资源，再压扩展栈；并不取消下层扩展对话，也不保证所有Promise永不悬挂：reset/dispose异常或未调用done仍可留下等待。
	private pushExtensionDialog(component: ExtensionDialogComponent, blocked?: BlockedStatus): void {
		// 取消普通showSelector的活动令牌并调用其可选清理器，和扩展对话栈的finish不是同一机制。
		this.disposeActiveSelector();
		// 新记录放数组末尾成为顶层，component/blocked都是原引用，不深拷贝。
		this.extensionDialogs.push({ component, blocked });
		// 重建输入槽、焦点与程序阻塞状态并请求重绘，不重新构造下面的旧对话。
		this.showTopExtensionDialog();
	}

	/** Remove an extension dialog. If it was visible, show the previous dialog or the editor. */
	// 按组件对象身份移除一条扩展对话，若它原在顶部就恢复上一层/编辑器，返回void；例如隐藏下层对话收到abort也可独立移除。
	// 本方法不调用dispose、不resolve等待者，调用方finish负责这些；未在栈里则无操作。
	private removeExtensionDialog(component: ExtensionDialogComponent): void {
		// findIndex按===引用找第一项，不按标题/类型匹配，重复同对象也只找首个。
		const index = this.extensionDialogs.findIndex((dialog) => dialog.component === component);
		// 缺项直接return，不改焦点或blocked状态。
		if (index === -1) return;
		// splice原地删除这一条并缩短数组，其余对话对象继续保留。
		this.extensionDialogs.splice(index, 1);
		// 删除前末项索引等于删除后length，因此仅移除原顶层才刷新可见对话；删隐藏项不干扰当前顶层焦点。
		if (index === this.extensionDialogs.length) this.showTopExtensionDialog();
	}

	// 把栈顶扩展对话或当前editor放进输入槽，设置焦点/extension-dialog阻塞状态并请求帧，返回void。
	// 例如最后一层关闭后恢复当前自定义编辑器；不调用组件工厂/dispose，不保证业务工作被暂停。
	private showTopExtensionDialog(): void {
		// at(-1)取数组最后项，空栈为undefined，不修改数组。
		const top = this.extensionDialogs.at(-1);
		// 有顶层用其component，空栈才用this.editor；这里不重新创建默认编辑器。
		const component = top?.component ?? this.editor;
		// 清显示槽旧children，仅隐藏原对象，不销毁下层对话。
		this.editorContainer.clear();
		// 加入所选同一组件引用，先前文字/选择状态由对象保留。
		this.editorContainer.addChild(component);
		// 把输入焦点交这个组件，底层TUI按自己的浮层/焦点规则处理，不在这里直接转发键盘数据。
		this.ui.setFocus(component);
		// 仅更新extension-dialog这一来源的阻塞状态，undefined删除该项，不清Reporter其他来源的blocked记录。
		this.programStatus.setBlocked("extension-dialog", top?.blocked);
		// 请求帧展示变化，不await实际渲染。
		this.ui.requestRender();
	}

	/**
	 * Show a selector for extensions.
	 */
	// 打开字符串选择对话并返回所选文字或undefined；例["A","B"]选A兑现A，取消/已取消信号/倒计时取消给undefined。
	// 先检查信号→登记abort→造组件→压栈，正常finish退信号/停倒计时/移栈再resolve；数组不在这里复制或执行选项文字。
	// 没有独立finished标记或全局finally，构造/清理异常可拒绝或阻断finish；resetExtensionUI只dispose组件不调用本闭包，不能保证总会resolve。
	private showExtensionSelector(
		// 标题原文传组件，可含换行，不当作Markdown或模型请求。
		title: string,
		// 候选为字符串数组，真实索引/键盘导航交ExtensionSelectorComponent。
		options: string[],
		// 取消信号和超时可缺，只有组件倒计时条件满足才启用timeout。
		opts?: ExtensionUIDialogOptions,
		// 默认程序状态kind为question，message只用title；confirm可显式传permission覆盖。
		blocked: BlockedStatus = { kind: "question", message: title },
		// 返回结果类型区分字符串（含可能空串）与取消undefined，而非选择索引。
	): Promise<string | undefined> {
		// Promise executor同步装UI；同步构造异常会自动使这个Promise拒绝，不代表所有已注册资源都被清掉。
		return new Promise((resolve) => {
			// 信号在调用时已aborted就不创建组件或注册新监听。
			if (opts?.signal?.aborted) {
				// 兑现undefined，调用方可把它解释为取消。
				resolve(undefined);
				// 提前退出executor，后面const selector不会创建。
				return;
			}

			// 局部finish接选择值或undefined，闭包稍后用selector/onAbort；本方法不另外防多次finish重复清理，Promise只接收首次结算。
			const finish = (option: string | undefined) => {
				// 先移除这次abort监听，正常选择完成后不再由同信号触发取消。
				opts?.signal?.removeEventListener("abort", onAbort);
				// dispose只停组件倒计时；若它抛错，后面的移栈/resolve会被跳过。
				selector.dispose();
				// 按对象移栈，顶层关闭则恢复下层，隐藏项关闭不抢当前焦点。
				this.removeExtensionDialog(selector);
				// 清理正常走完才兑现选项值，未来再次resolve不改首个结果。
				resolve(option);
			};
			// abort回调与用户取消走同一finish(undefined)，不另发Agent abort或取消模型。
			const onAbort = () => finish(undefined);
			// 监听一次abort，{once:true}让信号触发后自动移除，这与finish主动remove配合。
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			// 同步构造选择组件，下面把成功/取消都接finish；创建不自动压栈。
			const selector = new ExtensionSelectorComponent(
				// 把标题原样显示，不在这里转义或trim。
				title,
				// 把候选数组传组件保存，未在此为外部后续改数组提供快照隔离。
				options,
				// 用户选项回调只回传option，不按内容另做权限/安全判断。
				(option) => finish(option),
				// 取消键/超时入口统一兑现undefined。
				() => finish(undefined),
				// 给倒计时TUI/毫秒配置，并允许工具展开动作同时展开其他UI；超时是按秒递减显示，不是严格墙钟截止保证。
				{ tui: this.ui, timeout: opts?.timeout, onToggleToolsExpanded: () => this.toggleToolOutputExpansion() },
			);
			// 压扩展栈并标记blocked，启动终端状态展示；不创建新的Session。
			this.pushExtensionDialog(selector, blocked);
		});
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	// 用Yes/No选择器实现确认，输入标题/正文/取消设置，返回Promise<boolean>；例选择Yes才true，No/取消均false。
	// 会打开行内UI并报告permission种类的阻塞，但该标签本身不赋予或撤销文件/代码权限。
	private async showExtensionConfirm(
		// title供状态报告，组合显示时还会接正文换行。
		title: string,
		// 正文message原文，不作为模型提示或命令执行。
		message: string,
		// 信号/超时交选择器，取消不会throw一个专用取消异常而是得到undefined。
		opts?: ExtensionUIDialogOptions,
		// async自动把最终布尔包装成Promise，底层构造/清理异常仍可拒绝。
	): Promise<boolean> {
		// 显示标题由title和message以LF连接，候选固定两个原英文字符串。
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts, {
			// OSC程序状态用permission类别标记等待确认，不代表此层完成安全授权。
			kind: "permission",
			// 状态消息只取title，不把正文一并送进这项终端状态字段。
			message: title,
		});
		// 严格比较Yes，任何其他返回值（含undefined/No）都为false。
		return result === "Yes";
	}

	// 询问会话原cwd缺失时是否改用已计算的fallbackCwd，返回同意后的路径或undefined；例如用户取消就不提供替代目录。
	// 只格式化错误issue并打开确认，不创建目录、不检查fallback此刻仍存在，也不直接切会话/授信。
	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		// 等待用户确认，异常沿Promise传播，不自动把UI错误都当取消。
		const confirmed = await this.showExtensionConfirm(
			// 使用固定缺cwd标题，不插真实目录到这个标题字段。
			"Session cwd not found",
			// 共享格式器把缺失原因/替代路径变成正文，具体目录决策已在error.issue里准备。
			formatMissingSessionCwdPrompt(error.issue),
		);
		// 同意仅返回issue.fallbackCwd原字符串，不在此resolve/realpath或创建它。
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	// 打开扩展单行输入对话，返回输入字符串或取消undefined；例提交空输入也可兑现空串，不在此trim。
	// 信号/倒计时/压栈清理模式与选择器相同；当前底层占位参数未使用，传placeholder不会显示占位文字。
	// 正常finish清监听/倒计时再移栈/resolve，无全局finished/finally保证，reset UI仅dispose仍可能留下等待。
	private showExtensionInput(
		// 标题供显示与question阻塞报告，保留原文。
		title: string,
		// placeholder签名允许省略，按原代码透传给目前未使用它的构造形参。
		placeholder?: string,
		// 可选信号与timeout，不附初始值或description等组件其他选项。
		opts?: ExtensionUIDialogOptions,
		// Promise值为输入全文或undefined，不拿空字符串表示取消。
	): Promise<string | undefined> {
		// 同步executor注册组件，构造异常会拒绝这份Promise。
		return new Promise((resolve) => {
			// 已取消先兑现undefined，不创建输入对象或计时器。
			if (opts?.signal?.aborted) {
				// 保留取消结果与用户真正提交空串的区别。
				resolve(undefined);
				// 结束executor，避免继续登记abort/挂组件。
				return;
			}

			// finish接字符串/undefined，约定在正常路径统一清理后结算。
			const finish = (value: string | undefined) => {
				// 解除本次信号监听，避免输入已结束仍收到abort处理。
				opts?.signal?.removeEventListener("abort", onAbort);
				// 停止输入组件倒计时，不由dispose本身resolve或发取消回调。
				input.dispose();
				// 按组件身份移除，若是顶层恢复上一层或当前编辑器。
				this.removeExtensionDialog(input);
				// 清理走完后兑现值；resolve不会因为Promise已结算而阻止此前重复清理副作用。
				resolve(value);
			};
			// abort与取消键同样传undefined，未把它转throw。
			const onAbort = () => finish(undefined);
			// 一次性信号监听，正常完成还会主动remove。
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			// 同步创建真实单行面板，内部Input保存文本/焦点，外层管理其栈位置。
			const input = new ExtensionInputComponent(
				// 标题原样交面板。
				title,
				// placeholder仍作为第二实参传入，但当前组件没有读取它，不会自动显示占位文字。
				placeholder,
				// 用户确认时把Input完整值交finish，包含空串/空格，不先trim。
				(value) => finish(value),
				// 取消/超时回调统一走finish(undefined)。
				() => finish(undefined),
				// 只给ui与timeout，底层要求timeout真值且大于0、有TUI才启倒计时，未验证finite。
				{ tui: this.ui, timeout: opts?.timeout },
			);
			// 压栈并报告question，message仅标题；不会把输入值送到终端程序状态字段。
			this.pushExtensionDialog(input, { kind: "question", message: title });
		});
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	// 打开扩展多行编辑面板，返回提交文字或取消undefined；例如预填draft让用户修改，确认才交等待方。
	// 接入当前TUI/键位与外部编辑器命令，普通创建不启动外部程序，但用户触发相关动作时组件会暂停TUI并运行编辑器。
	// 没有这里的AbortSignal/timeout选项，也没有调用通用dispose；组件finish只移栈/resolve，构造或回调异常按Promise/调用路径传播。
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		// 同步创建面板与回调，返回Promise等待用户动作，不在循环中轮询文本。
		return new Promise((resolve) => {
			// 局部finish处理提交/取消，未另防重复调用或在此trim。
			const finish = (value: string | undefined) => {
				// 移除本面板；隐藏下层编辑器也可按身份移除，不清上层对话。
				this.removeExtensionDialog(editor);
				// 兑现组件回传值，实际父Editor提交可先展开大粘贴并trim，整理不在此闭包完成。
				resolve(value);
			};
			// 创建ExtensionEditorComponent，它内部建基础Editor、标题/帮助和失败提示区。
			const editor = new ExtensionEditorComponent(
				// 传稳定ui，用户开启外部编辑器时组件会对它stop/start。
				this.ui,
				// 传应用键位识别外部编辑动作，普通取消还由组件读取共享全局键位。
				this.keybindings,
				// 面板标题原文，不作为Markdown解析。
				title,
				// 预填文字可省，组件只在真值时setText，不会自动提交。
				prefill,
				// 提交回调直接接组件整理后的文字。
				(value) => finish(value),
				// 取消键回调返回undefined，不将当前未提交文字隐式保留为成功结果。
				() => finish(undefined),
				// 显式undefined占住可选EditorOptions位置，未配置额外description/基础编辑选项。
				undefined,
				// 读取当前配置的外部命令，组件构造再按VISUAL/EDITOR/平台默认回退；读取不等于执行该命令。
				this.settingsManager.getExternalEditorCommand(),
			);
			// 将多行面板压栈并报告question状态，真正文字由编辑器持有，不写Session消息。
			this.pushExtensionDialog(editor, { kind: "question", message: title });
		});
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	// 替换活动输入编辑器或恢复默认，输入EditorFactory/undefined，返回void；例扩展提供Vim编辑器，原getText文字转到新实例。
	// 先保存工厂/文字，没扩展对话时清普通选择器/槽位，再创建并接默认提交/变更/部分外观与动作，最后迁移指示器和焦点。
	// 只保留getText，不复制光标、撤销、历史等完整状态；没有旧自定义编辑器通用dispose或全流程回滚，工厂异常可留下已清槽/已更新factory字段。
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		// 先记录工厂，后面创建失败也不会自动退回旧factory；getEditorComponent读的就是此字段。
		this.editorComponentFactory = factory;

		// Save text from current editor before switching
		// 当前编辑器普通getText内容保存一次，不用getExpandedText，可能仍含基础编辑器大粘贴占位表示。
		const currentText = this.editor.getText();

		// An open extension dialog keeps the editor slot; the new editor is shown when the last dialog closes.
		// 扩展行内对话栈非空时保持其可见组件，后台仍可替换this.editor供最后关对话后显示。
		const dialogOpen = this.extensionDialogs.length > 0;
		// 没有扩展对话才动当前输入槽，不让新编辑器盖住正在等待回答的顶层对话。
		if (!dialogOpen) {
			// 撤普通选择器令牌并调用清理器，和扩展对话栈分开。
			this.disposeActiveSelector();
			// 清输入槽children，后面创建编辑器若失败不会自动把原对象重新挂回。
			this.editorContainer.clear();
		}

		// 工厂存在走新自定义对象，undefined恢复原defaultEditor实例。
		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			// 同步调用工厂，传稳定ui、当前编辑器样式与应用键位；它可以分配资源，签名不允许直接返回Promise。
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			// 把默认编辑器当前onSubmit函数引用赋给新对象，确保提交仍进启动/正式处理器；不复制整个defaultEditor。
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			// onChange同样取当前引用，后续defaultEditor属性被换成别的函数不会自动替换这一普通字段。
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			// 把保存文字交新编辑器setText，不保证保留旧光标/撤销栈或阻止其onChange回调发生。
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			// 只有borderColor当前不是undefined才赋样式，属性可选且缺时不强加；不是单纯“只要接口允许就一定写”。
			if (newEditor.borderColor !== undefined) {
				// 沿用默认编辑器颜色函数引用，不以整个Theme对象覆盖新组件。
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			// 可选setPaddingX不为undefined才调用，按typed契约视作函数，不新增typeof检查。
			if (newEditor.setPaddingX !== undefined) {
				// 从defaultEditor实际当前padding读取，可能已被运行时设置更新。
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}
			// 补全可见数setter同样按可选能力调用。
			if (newEditor.setAutocompleteMaxVisible !== undefined) {
				// 复制的是默认编辑器的当前容量配置，不是拷贝其已经打开的补全菜单候选。
				newEditor.setAutocompleteMaxVisible(this.defaultEditor.getAutocompleteMaxVisible());
			}

			// Set autocomplete if supported
			// 新对象有setter且本实例已有provider才注入；无provider时不主动传undefined清它自己的配置。
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				// 让新编辑器使用本次包装完成的同一补全引用。
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			// 先经unknown再断言成字符串键记录，允许下面探测自定义能力；断言不改变对象/原型，也不验证它真继承CustomEditor。
			const customEditor = newEditor as unknown as Record<string, unknown>;
			// 用字段存在+Map实例识别可复制动作的能力，而非newEditor instanceof CustomEditor；Map仍是运行时原型判断，不是对全部跨模块对象的通用保证。
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				// 只有onEscape真值缺失才加后备，已有真值处理器保留；这条记录类型为unknown，没有额外校验已有真值一定可调用。
				if (!customEditor.onEscape) {
					// 箭头以后动态调用defaultEditor当时的onEscape，因此临时压缩/重试覆盖可被看到。
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				// 同样只在没有真值onCtrlD时补默认转发。
				if (!customEditor.onCtrlD) {
					// ?.调用允许默认入口暂未安装，保持当前this实例，不把方法拿出来丢接收者。
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				// 图片粘贴入口没有真值覆盖时才补。
				if (!customEditor.onPasteImage) {
					// 触发时转默认编辑器onPasteImage，不在换编辑器时读取剪贴板。
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				// 扩展快捷键入口也仅缺省时转发，保留新组件自己已有的处理器。
				if (!customEditor.onExtensionShortcut) {
					// 回调接终端data并动态读默认拦截器，可能返回boolean或缺省undefined，组件输入路由自己解释。
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				// 遍历默认应用动作Map，复制动作名与handler引用，不再次按键位注册系统监听。
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					// as只让TS允许Map.set，原地覆盖新编辑器同动作的处理器；这些Map项不像上面特殊回调那样“已有就保留”。
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			// 所有接线正常完成才将this.editor切到新对象；前面setText/外观调用期间它仍指旧编辑器。
			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			// 恢复默认时也把旧当前编辑器文字回填，默认对象自己的其他状态由setText实现决定。
			this.defaultEditor.setText(currentText);
			// 当前editor指回保存的默认实例，不重新构造一份CustomEditor。
			this.editor = this.defaultEditor;
		}

		// 没扩展对话才把新editor挂进输入槽；有对话时等showTopExtensionDialog以后恢复它，as不转换对象。
		if (!dialogOpen) this.editorContainer.addChild(this.editor as Component);
		// 存在活动指示器时，编辑器变化可能改变“边框内嵌/独立状态行”位置，需重新安放。
		if (this.activeStatusIndicator) {
			// 先清状态容器，避免原独立行和新边框重复显示。
			this.statusContainer.clear();
			// 尝试把同一指示器交新编辑器并记录成功与否，不dispose/重建业务状态动画。
			this.activeWorkingIndicatorEmbedded = this.setEditorWorkingStatusIndicator(this.activeStatusIndicator);
			// 新编辑器不支持嵌入时才放回状态区域。
			if (!this.activeWorkingIndicatorEmbedded) {
				// 继续使用原活动对象，保留其动画/倒计时进度。
				this.statusContainer.addChild(this.activeStatusIndicator);
			}
		}
		// 只有没有扩展对话时才把焦点交新editor，避免抢走顶层确认/选择框输入。
		if (!dialogOpen) this.ui.setFocus(this.editor as Component);
		// 请求显示替换与指示器迁移，不自动提交保存的文字。
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	// 把扩展通知按可选等级分发到错误/警告/普通状态显示，返回void；例type:error走showError，省略type按普通状态。
	// 只改UI，不throw通知文字为异常、不上传或保存模型消息；显示方法自身异常仍可传出。
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		// 只精确error使用错误处理，不按message内容猜等级。
		if (type === "error") {
			// 将message按错误样式和当前outputPad追加聊天并请求重绘，不在此变成抛出的Error对象。
			this.showError(message);
			// warning严格分支采用警告显示。
		} else if (type === "warning") {
			// 不在这里把警告升级成致命退出。
			this.showWarning(message);
		} else {
			// info/undefined等剩余运行时值都走showStatus，保留原兜底行为。
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	// 打开扩展自定义组件并等待done的泛型结果，行内压对话栈或浮层叠在现有内容上；例factory中按确认调用done("ok")，等待者得到字符串。
	// 保存输入文字→同步启动可异步返回的工厂→组件就绪后挂载，done先清UI/恢复文字再resolve并尽力dispose；这些是交互/资源副作用，不请求模型。
	// factory同步抛错发生在Promise.resolve参数求值时，不经过后面的链catch，但executor会拒绝外层Promise；后续清理也无全流程finally保障。
	// 工厂同步done后才返回的组件在closed分支被略过而不dispose；overlay的onHandle若抛错，catch拒绝却不自动hide已有浮层，注释不把这当保证清理的通用框架。
	private async showExtensionCustom<T>(
		// 泛型T贯穿done参数和最终Promise，不规定结果一定字符串/布尔，也不在运行时自动校验T。
		factory: (
			// 工厂取得稳定TUI，调用时可装组件，但这里尚未调用start/init。
			tui: TUI,
			// 传共享Theme代理用于显示，自定义组件自己决定何时取颜色。
			theme: Theme,
			// 传应用键位管理器，组件可识别配置动作，不应从本签名推断硬编码按键。
			keybindings: KeybindingsManager,
			// done回调用于完成并关闭本次UI，T为调用方/TS推断的结果类型。
			done: (result: T) => void,
			// 工厂可立即返回Component或返回其Promise，两种结果都允许可选dispose；不是Promise<T>结果直接由工厂完成。
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		// 可选对象控制显示方式与浮层句柄/阻塞报告，不含AbortSignal或timeout。
		options?: {
			// overlay缺省false走行内，true使用TUI浮层栈，底层仍可有自己的可见性条件。
			overlay?: boolean;
			// 浮层尺寸/位置可为对象或取对象函数，本实现显示时调用一次解析函数，不每帧重新调用这个外层工厂。
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			// 浮层创建后可把handle交调用方控制显示/焦点；该回调同步执行，抛错会进后面的Promise链catch。
			onHandle?: (handle: OverlayHandle) => void;
			// blocked只传行内压栈分支，浮层路径没有把它登记到ProgramStatusReporter。
			blocked?: BlockedStatus;
		},
		// async最终接续内部Promise<T>，前面getText等同步异常也转成拒绝；不意味着自动管理任意资源清理。
	): Promise<T> {
		// 保存当时editor.getText，关闭行内UI时会写回当前editor，即使期间编辑器实例/文字已被别处改变。
		const savedText = this.editor.getText();
		// ??只缺省才用false，显式true决定下面显示/恢复路径。
		const isOverlay = options?.overlay ?? false;

		// 新Promise等待done或工厂/挂载链拒绝；executor先同步定义闭包并调用factory。
		return new Promise((resolve, reject) => {
			// 组件尚未返回时为undefined，方便同步done路径可先关闭，但也意味着那时无法dispose后来才得到的对象。
			let component: ExtensionDialogComponent | undefined;
			// 浮层句柄在真正showOverlay之后才有，close可以精确移除此层而非误删顶上另一层。
			let overlayHandle: OverlayHandle | undefined;
			// closed标志防done重复进入主要清理/resolve，但不是对所有reject/外部reset路径的统一终态管理。
			let closed = false;

			// 局部恢复函数：有组件则按身份移行内栈，再把开始时文字写当前编辑器并请求帧；不重新创建旧编辑器或恢复撤销历史。
			const restoreEditor = () => {
				// component尚未得到时不移栈；隐藏下层组件移除也不会抢走上层焦点。
				if (component) this.removeExtensionDialog(component);
				// 无条件恢复savedText，可能覆盖等待期间别处给当前editor设置的新文字，保留原代码行为。
				this.editor.setText(savedText);
				// 请求显示恢复结果，setText/移栈若抛错则这行不会执行。
				this.ui.requestRender();
			};

			// done实际实现接T结果，尝试关闭本次显示后结算；如果hide/restore在resolve前抛错，没有finally保证结算。
			const close = (result: T) => {
				// 已经closed就忽略后续done，不再dispose或替换第一次结果。
				if (closed) return;
				// 先置closed再动UI，清理抛错也保持true，不会让下一次done自动重试清理。
				closed = true;
				// Remove this overlay, not the topmost one: another overlay may have opened above it.
				// 浮层只用保存的handle.hide永久移除自己，不是this.ui.hideOverlay误删当前栈顶；尚无handle时可选调用跳过。
				if (isOverlay) overlayHandle?.hide();
				// 行内恢复原文字并移当前组件，下面不额外在overlay分支恢复编辑器文字。
				else restoreEditor();
				// Note: both branches above already call requestRender
				// 先resolve结果，再尝试dispose；外层等待者会按Promise微任务时机继续，dispose同步段仍在本次回调栈内执行。
				resolve(result);
				// 仅这段可选dispose有try保护，不包括之前hide/restore。
				try {
					// 有已取得组件与dispose才调用；同步done早于工厂返回时这里尚无component。
					component?.dispose?.();
					// 清理函数抛错被忽略，不改变已经resolve的结果。
				} catch {
					/* ignore dispose errors */
				}
			};

			// factory在Promise.resolve之前同步执行，返回组件/Promise后才装then/catch；当场throw由外层executor自动拒绝，跳过链中restore逻辑。
			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				// 工厂成功产生组件后进入此回调，c不是done结果而是要挂载的组件。
				.then((c) => {
					// 若工厂已同步done就直接略过，当前实现未dispose这个后来到达的c，不能称所有完成路径都释放组件。
					if (closed) return;
					// 保存对象供之后close/restore/dispose使用，下面挂载失败也仍持有它。
					component = c;
					// 根据初始overlay布尔分支，不因组件是否有width属性自动改显示方式。
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						// 局部解析浮层选项，返回对象或undefined，调用发生在showOverlay参数求值时；不是交给TUI每帧回调。
						const resolveOptions = (): OverlayOptions | undefined => {
							// 有真值overlayOptions优先使用显式选项，不再读c.width兜底。
							if (options?.overlayOptions) {
								// 声明本次解析得到的选项局部值，两种分支最终都返回同一结构类型。
								// 函数形式现在同步调用，可读当前终端大小，也可能抛错进入链catch。
								// 对象形式原引用传递，不深拷贝margin/visible等字段。
								const opts =
									// typeof区分联合中的函数/对象，不是对外部任意JSON做完整校验。
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								// 直接返回本次选项，不额外合并width兜底或默认定位。
								return opts;
							}
							// Fallback: use component's width property if available
							// 没有显式选项才用as读取可选width属性，断言不验证运行时值真是number。
							const w = (c as { width?: number }).width;
							// width真值才组{width:w}，0/undefined不用兜底宽度；负数等真值也原样交底层布局规则。
							return w ? { width: w } : undefined;
						};
						// 在当前TUI显示浮层并保存专属句柄，可能改焦点/安排绘制，resolveOptions在调用前只求一次。
						overlayHandle = this.ui.showOverlay(c, resolveOptions());
						// Expose handle to caller for visibility control
						// 有onHandle才同步交句柄，调用者可隐藏/关闭；抛错时后面catch仅reject，不自动移除已显示overlay。
						options?.onHandle?.(overlayHandle);
					} else {
						// 行内组件走扩展对话栈并带可选blocked，不抢掉/销毁下面的扩展对话。
						this.pushExtensionDialog(c, options?.blocked);
					}
				})
				// 捕获工厂返回Promise拒绝或then内挂载/选项/onHandle异常；不覆盖factory在Promise.resolve之前的同步throw。
				.catch((err) => {
					// closed后忽略链拒绝，不替换已完成结果或重试清理。
					if (closed) return;
					// 仅行内失败时恢复输入文字/移栈，overlay失败不会在这里hide或dispose；restore自身再抛也未额外捕获。
					if (!isOverlay) restoreEditor();
					// 把原异常拒绝给等待者，不转成undefined取消或显示成功。
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	// 显示扩展错误与可选栈，返回void；例如标题中指明扩展路径，栈去首行后逐行弱色缩进。
	// 只投影文字并请求帧，不重新throw原错误、不自动停用扩展或上传报告；路径/栈没有在本方法脱敏或转义控制字符。
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		// 先拼错误标题原文，包含传入extensionPath和error，不据字符串推断可重试性。
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		// 延迟着错误色并用水平边距1，换主题后可重建样式。
		const errorText = new ThemedText(() => theme.fg("error", errorMsg), 1, 0);
		// 直接加到聊天区，不作为用户/助手历史条目保存。
		this.chatContainer.addChild(errorText);
		// stack真值才处理，空串不显示额外占位。
		if (stack) {
			// Show stack trace in dim color, indented
			// 按LF分割并去第一行，假定首行重复错误说明；不是解析/过滤所有V8帧，剩余非at文字仍可能保留。
			const stackLines = stack.split("\n").slice(1); // Skip first line (duplicates error message)
			// 至少还有一行才建第二个组件；含尾随LF的栈可留下空行项。
			if (stackLines.length > 0) {
				// 每行trim两端、前补两空格并dim着色，再LF连接；原栈缩进会丢失，敏感路径/正文未在此清洗。
				const renderStack = () => stackLines.map((line) => theme.fg("dim", `  ${line.trim()}`)).join("\n");
				// 用ThemedText保存延迟renderStack回调，不在这一步运行外部栈分析工具。
				this.chatContainer.addChild(new ThemedText(renderStack, 1, 0));
			}
		}
		// 请求显示新错误区，不自动调用suggestBugReport或recordCrash。
		this.ui.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	// 安装正式应用键盘入口，返回void；主要写defaultEditor回调/动作Map与TUI调试入口，处理文本时通过this.editor使用当前编辑器。
	// 例如Escape先取消流式/排队，再取消Bash，再退出Bash输入态，最后按空编辑器双击设置开树/分叉；动作匹配读取配置，不硬编码实际按键。
	// 只登记时不执行对应业务，但回调可退出/挂起/切模型/启动编辑器/复制等；许多async调用返回Promise而动作签名void，登记不意味着这些拒绝自动被统一捕获。
	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		// 替换默认Escape入口，压缩/重试期间可再临时覆盖并保存此函数。
		this.defaultEditor.onEscape = () => {
			// 正在流式时优先恢复排队文字并请求取消，即使同时有Bash也不先走后者。
			if (this.session.isStreaming) {
				// abort:true会在恢复队列后请求会话取消；这个同步回调不等待真正空闲。
				this.restoreQueuedMessagesToEditor({ abort: true });
				// 不在流式但有独立Bash任务才取消它。
			} else if (this.session.isBashRunning) {
				// 给Bash取消控制器发信号，不保证外部命令立刻退出。
				this.session.abortBash();
				// 没有运行任务但编辑器处于!输入态，就清这条输入而不弹树。
			} else if (this.isBashMode) {
				// 清当前活动编辑器文字，可能触发其onChange。
				this.editor.setText("");
				// 显式清本实例Bash模式标记，即使自定义编辑器未发onChange也会更新。
				this.isBashMode = false;
				// 恢复与当前思考级别相符的正常边框色，不触发任何shell命令。
				this.updateEditorBorderColor();
				// 其他情况下仅trim后为空的编辑器才考虑双Escape，非空普通文字不会被这一分支清掉。
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				// 从设置读tree/fork/none等动作，实际窗口不是按默认键名硬绑定。
				const action = this.settingsManager.getDoubleEscapeAction();
				// none直接略过，不更新这段时间戳，也不打开选择器。
				if (action !== "none") {
					// Date.now取墙钟毫秒用于双击窗口，不是性能计时或严格单调时钟。
					const now = Date.now();
					// 与上次间隔严格小于500毫秒才按双击处理，等于500走更新首击时间。
					if (now - this.lastEscapeTime < 500) {
						// 动作精确tree就开树导航，其余非none值按下一分支开用户消息分叉选择。
						if (action === "tree") {
							// 启动选择器流程，不在此自动选择树节点或调用模型摘要。
							this.showTreeSelector();
						} else {
							// 显示历史用户消息选择器，用户随后决定分叉点，不是立即复制会话。
							this.showUserMessageSelector();
						}
						// 识别一次双击后清时间戳，下一次按新的首击处理。
						this.lastEscapeTime = 0;
					} else {
						// 未进双击窗口就保存本次时间，不清其他输入/会话状态。
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		// 按app.clear动作登记handleCtrlC语义（清文字/短时第二次退出），实际触发键由管理器决定。
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		// 空编辑器退出入口设handleCtrlD，空条件由CustomEditor输入路由负责，本函数不在这里重复校验。
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		// 挂起动作转handleCtrlZ，平台/进程组信号与恢复由被调方法处理。
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		// 思考级别循环走Session能力列表并更新显示，不在登记时修改级别。
		this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		// 前向模型循环传字面forward，cycleModel内部处理普通切换异常；动作回调不await其Promise。
		this.defaultEditor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
		// 反向同理传backward，与正向共享同一模型循环实现。
		this.defaultEditor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));

		// Global debug handler on TUI (works regardless of focus)
		// TUI全局调试回调不依赖编辑器焦点，实际触发可写本地debug日志；这里仅赋函数。
		this.ui.onDebug = () => this.handleDebugCommand();
		// 模型选择动作弹选择界面，不直接猜一个目标模型。
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		// 展开动作翻转共享展开标志，可能同时更新页头/资源和聊天可展开项。
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		// 思考显示动作改隐藏设置并刷新助手组件，与模型thinkingLevel循环不同。
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		// 外部编辑器动作启动异步辅助，void表示不阻塞输入接口，不能理解为自动catch所有启动/恢复错误。
		this.defaultEditor.onAction("app.editor.external", () => void this.handleOpenExternalEditor());
		// 复制动作分多行登记，后面两个参数是动作ID与回调。
		this.defaultEditor.onAction(
			// 使用可配置app.message.copy动作，不直接判断ctrl+某键。
			"app.message.copy",
			// 复制时允许优先全屏选区并闪确认，异步执行未在此await；具体复制失败策略在handleCopyCommand。
			() => void this.handleCopyCommand({ flashConfirmation: true, preferSelection: true }),
		);
		// 追问动作按当前压缩/流式/空闲状态决定排队方式，返回Promise在此不等待。
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		// 取回排队消息以编辑，和清掉整个会话消息历史不同。
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		// 新会话动作转handleClearCommand，可能咨询扩展/替换Runtime；不是只清屏幕。
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		// 树动作打开同一会话的树导航选择器。
		this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
		// fork动作打开用户消息列表，等选择后再实际Runtime分叉。
		this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
		// resume动作列历史会话文件，等用户选项后才切换。
		this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());

		// 文字变化回调仅更新Bash输入模式/边框，不即时执行输入内容；参数注解是string。
		this.defaultEditor.onChange = (text: string) => {
			// 记旧标记以便只在模式变化时重设颜色，普通文字每字符变化不必重设边框。
			const wasBashMode = this.isBashMode;
			// trimStart只去开头空白，再看是否以!起始；!!也属于Bash输入态，不在这里区分上下文排除。
			this.isBashMode = text.trimStart().startsWith("!");
			// 新旧布尔不同才更新边框，减少无变化的样式设置。
			if (wasBashMode !== this.isBashMode) {
				// 使用当前editor和thinking级别决定颜色，不读剪贴板/运行命令。
				this.updateEditorBorderColor();
			}
		};

		// Handle clipboard paste (triggered on Ctrl+V). Copied files use their original paths,
		// images are attached via temporary files, and plain text is the final fallback.
		// 默认粘贴入口虽然名为onPasteImage，实际按文件路径→图片→文本的优先级处理。
		this.defaultEditor.onPasteImage = () => {
			// 异步读取/可写临时图片文件，不等待回调结果；handleClipboardPaste内部捕获try范围中的普通错误并显示。
			void this.handleClipboardPaste();
		};
	}

	// 右键粘贴到当时焦点组件，返回Promise<void>；先取target/handleInput，读系统文字，等待后焦点仍同对象才包括号粘贴数据交它。
	// 例如读取期间焦点切到确认框则丢弃本次文字，避免误送新组件；只检查对象身份，不建立完整会话/渲染器代次锁。
	// try内读取/输入/重绘异常静默忽略，try前取焦点/方法的异常不在其保护范围；不把文字直接提交模型。
	private async handleRightClickPaste(): Promise<void> {
		// 从实际renderer取当前焦点，局部保存对象引用，可能是编辑器/对话组件或null。
		const target = this.renderer.getFocusedComponent();
		// 保存该对象当时的可选handleInput函数，后面用call保留接收者。
		const handleInput = target?.handleInput;
		// 无焦点或无输入能力就返回，不读取系统剪贴板。
		if (!target || !handleInput) return;
		// try只从剪贴板读取开始，下面分派和requestRender也在catch范围中。
		try {
			// 异步读取系统剪贴板文字，可能调用原生模块或平台命令，失败/空内容可为null。
			const text = await readClipboardText();
			// 无文字或等待后当前焦点不是原target就省略；同target但文字/会话已变不在这行另做检查。
			if (!text || this.renderer.getFocusedComponent() !== target) return;
			// 用.call让方法this仍是target，括号粘贴序列交组件解析；原text内控制串未在这里转义。
			handleInput.call(target, `\x1b[200~${text}\x1b[201~`);
			// 处理后请求UI更新，组件可按输入规则改变文字/选择，不等于已经提交用户消息。
			this.ui.requestRender();
			// 本try范围任意异常都静默忽略，不只权限错误；不把错误显示进聊天。
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	// 按文件→图片→纯文字从系统粘贴到当前编辑器，返回Promise<void>；文件多项按Bash/普通模式用空格引用或换行，图片先存系统临时目录再插路径。
	// 读取可启动平台命令/原生API，图片会写本地文件；本函数没有临时图片生命周期删除，也不在此向模型上传。
	// optional insertTextAtCursor缺省时仍可能已经读取/写文件并return，不保证每个自定义编辑器都能插入；try内异常统一显示错误，不继续降级下一种内容。
	private async handleClipboardPaste(): Promise<void> {
		// try包全部三种读取/插入及临时写入，不是每种失败单独catch后继续下一种。
		try {
			// 先询问原生文件路径，helper只返回非空数组或null，不验证每条路径存在或读取文件正文。
			const filePaths = await readClipboardFilePaths();
			// 有路径列表就优先使用，不再考虑同一剪贴板可能还有的图片/文本表示。
			if (filePaths) {
				// Unicode属性Cc检查每条路径中的控制字符，包含换行/tab等；它不是对路径合法性/所属目录做完整校验。
				if (filePaths.some((filePath) => /\p{Cc}/u.test(filePath))) {
					// 发现控制字符直接throw到下面统一错误显示，避免在列表连接时把控制字符当正常路径分隔内容。
					throw new Error("Clipboard file path contains control characters");
				}
				// Bash输入态逐项做POSIX引用后空格连接，普通输入按LF列路径；不在这一行实际运行或打开文件。
				const paths = this.isBashMode ? filePaths.map(quoteIfNeeded).join(" ") : filePaths.join("\n");
				// 当前编辑器可提供逻辑光标；基础Editor的col为行内UTF-16下标，不是终端显示格数。
				const cursor = this.editor.getCursor?.();
				// 有光标时取当前存储文字相应逻辑行，越界回空串；没有能力就不尝试推断位置。
				const currentLine = cursor ? (this.editor.getText().split("\n")[cursor.line] ?? "") : "";
				// col>0才读取前一码元，避免负索引；可能得到undefined，后面按真值判是否补空格。
				const characterBeforeCursor = cursor && cursor.col > 0 ? currentLine[cursor.col - 1] : "";
				// 当前col就是插入点后一码元，行尾可为undefined，不重新查终端像素坐标。
				const characterAfterCursor = cursor ? currentLine[cursor.col] : "";
				// 前方有非空白字符才补前置空格，空白判断用JS正则\s，不按单词/路径语义解析。
				const leadingSpace = characterBeforeCursor && !/\s/.test(characterBeforeCursor) ? " " : "";
				// 后方有非空白字符才补后置空格，使插入路径与邻接文本分开。
				const trailingSpace = characterAfterCursor && !/\s/.test(characterAfterCursor) ? " " : "";
				// 可选能力存在才插入拼好的路径文字，缺能力跳过；未在这里按路径附加@或强制发送消息。
				this.editor.insertTextAtCursor?.(`${leadingSpace}${paths}${trailingSpace}`);
				// 无论optional插入是否执行都请求帧，不能据此确认内容已成功写入编辑器。
				this.ui.requestRender();
				// 文件路径分支结束，不再把同剪贴板内容另存为图片/读成文本。
				return;
			}

			// 无文件路径才尝试图片读取/必要格式转换，helper失败可返回null或拒绝。
			const image = await readClipboardImage();
			// 有图片对象才写文件，未在这里再次验证完整解码有效性或尺寸。
			if (image) {
				// 获取系统临时目录，不使用当前项目路径或用户指定工作文件。
				const tmpDir = os.tmpdir();
				// MIME转扩展名，未识别时按原代码用png兜底，不在这里单凭后缀重新转码字节。
				const ext = extensionForImageMimeType(image.mimeType) ?? "png";
				// 随机UUID组成文件名降低碰撞，未使用wx排他创建或自设权限模式，不把随机名等同访问隔离。
				const fileName = `pi-clipboard-${crypto.randomUUID()}.${ext}`;
				// 用本机path.join生成实际临时路径，可能含空格，下面直接插路径未调用quoteIfNeeded。
				const filePath = path.join(tmpDir, fileName);
				// 同步复制字节为Buffer并写文件，可能阻塞/失败，成功后此函数没有安排unlink。
				fs.writeFileSync(filePath, Buffer.from(image.bytes));

				// 把文件路径交可选插入方法，不直接把base64图片传给Session；若无插入能力文件仍已产生。
				this.editor.insertTextAtCursor?.(filePath);
				// 请求显示新路径，是否形成图片附件由后续输入文件处理负责。
				this.ui.requestRender();
				// 图片分支成功到此便return，不再读纯文字。
				return;
			}

			// 无文件/无图后最后读纯文字，保留原有空白/换行，不在本函数trim。
			const text = await readClipboardText();
			// 只有文字真值才尝试插入，空串/null都不做显示更新。
			if (text) {
				// 通过可选插入接口加到当前编辑器光标，不像右键路径那样包handleInput括号粘贴序列。
				this.editor.insertTextAtCursor?.(text);
				// 有文字即请求重绘，缺插入方法时也不自动回退setText。
				this.ui.requestRender();
			}
			// 任何已在try内抛出的值统一转显示，包括路径控制字符、原生/命令读取、文件写入或编辑器错误。
		} catch (error) {
			// Error取message，其他String(error)；showError或字符串转换自身再抛则不会由同一catch重新吞掉。
			this.showError(`Failed to paste from clipboard: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// 启动尚未完成时处理一次提交，返回void；例用户先输入问题并回车，只把原文字放回编辑区并提示稍等。
	// 不排队到pendingUserInputs、不调用Session.prompt、不执行Bash或内置命令。
	private handleStartupSubmit(text: string): void {
		// 把提交文字重新setText，补回基础Editor提交可能清掉的内容；会按编辑器自己的规范化/光标规则处理。
		this.editor.setText(text);
		// 显示固定启动中状态，不声称输入已经发送或会自动在启动结束后提交。
		this.showStatus("Startup is still in progress");
	}

	// 安装正式提交回调，返回void；回调先trim/忽略空输入，依序处理内置斜杠命令，再处理!/!!，最后按压缩/流式/空闲选择队列或主run循环。
	// 例如流式时普通文字以steer交Session；空闲时只唤醒getUserInput或存pendingUserInputs，实际提问由run循环执行，并非此回调始终等整个回答。
	// 回调是async但EditorComponent.onSubmit是void消费接口，基础编辑器不因类型而自动await/捕获拒绝；本回调没有统一try/catch，各分支异常仍按具体callee/输入调用栈传播。
	// 命令判断精确匹配或“命令+普通空格”前缀，不是任意空白分词，也不把所有/开头文本都当本UI内置命令。
	private setupEditorSubmitHandler(): void {
		// 把默认编辑器提交入口换成async函数；此方法setup本身仍同步结束，不在安装时调用回调。
		this.defaultEditor.onSubmit = async (text: string) => {
			// trim重写局部参数文字，去两端空白/换行，尚未直接改editor保存内容。
			text = text.trim();
			// 空字符串提前返回，避免空消息、空命令或空队列项。
			if (!text) return;

			// Handle commands
			// /settings只接受这个完整文字，不接受带参数变体。
			if (text === "/settings") {
				// 打开设置选择器，由选择后的回调更新设置/显示，不把命令发模型。
				this.showSettingsSelector();
				// 清当前editor文字，选择器显示位置由showSelector控制。
				this.editor.setText("");
				// 设置命令处理完就跳过Bash/压缩/流式/普通提问路径。
				return;
			}
			// /scoped-models打开循环模型范围配置，不是/model选择当前单模型。
			if (text === "/scoped-models") {
				// 先清输入，等待范围选择器准备时不保留命令文本。
				this.editor.setText("");
				// 同步构造并打开范围菜单；showModelsSelector返回void，这个await只按Promise微任务规则继续，不等待用户选择或后台目录刷新完成。
				await this.showModelsSelector();
				// 不把/scoped-models再进入Session.prompt。
				return;
			}
			// /model或带普通空格参数的形式在本地处理，/modelX或制表符分隔不满足这里的条件。
			if (text === "/model" || text.startsWith("/model ")) {
				// 带参数时slice(7)去/model加空格再trim，否则传undefined让处理器走交互选择。
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				// 先清命令文字，匹配/刷新模型时可显示对应状态。
				this.editor.setText("");
				// 委托精确缓存查找/必要刷新/选择器与setModel路径，不在这层手写模型匹配规则。
				await this.handleModelCommand(searchTerm);
				// 模型命令完成后不把原/model当用户问题发出。
				return;
			}
			// 思考级别有裸命令与空格参数两种入口，和模型命令分开匹配。
			if (text === "/thinking" || text.startsWith("/thinking ")) {
				// slice(10)去/thinking加空格并trim，空参数仍可能是空串，处理器自行决定用法。
				const searchTerm = text.startsWith("/thinking ") ? text.slice(10).trim() : undefined;
				// 清当前输入，不把级别参数留到普通提问队列。
				this.editor.setText("");
				// 同步处理直接级别或打开选择器，实际允许级别由Session模型能力决定。
				this.handleThinkingCommand(searchTerm);
				// 跳过后续提问分支，不因此改变思考块显示开关。
				return;
			}
			// /export及其空格参数交本地导出路径，格式后缀/输出位置由处理器解析。
			if (text === "/export" || text.startsWith("/export ")) {
				// 等待实际HTML/JSONL文件导出处理，可能创建/覆盖用户指定的输出路径。
				await this.handleExportCommand(text);
				// 处理器正常返回后才清文字，拒绝会跳过本行。
				this.editor.setText("");
				// 导出不作为Agent提问或扩展命令再执行。
				return;
			}
			// /import及带参数形式在UI优先处理，可替换整个运行时会话。
			if (text === "/import" || text.startsWith("/import ")) {
				// 等待导入确认、文件处理与Runtime替换，具体取消/缺cwd路径在处理器中；这里没有再包catch。
				await this.handleImportCommand(text);
				// 正常返回清输入，即使处理器内部返回取消也按此原流程清命令。
				this.editor.setText("");
				// 不把原导入命令留作普通模型文字。
				return;
			}
			// 只有完整/share命中这个入口，不在这里接受目的地参数。
			if (text === "/share") {
				// 等待分享辅助流程，可能导出、认证/上传或复制链接，实际目的地与取消由对应helper处理。
				await this.handleShareCommand();
				// 分享处理正常返回才清当前文字。
				this.editor.setText("");
				// 结束本次提交，不继续向模型发送/share。
				return;
			}
			// /bug支持可选空格后线索文字，命令本身由本UI处理。
			if (text === "/bug" || text.startsWith("/bug ")) {
				// 先去固定命令长度再trim剩余线索，裸/bug得到空串。
				const hint = text.slice("/bug".length).trim();
				// 在进入报告流程前清输入，用户线索已存局部变量。
				this.editor.setText("");
				// 空线索转undefined，非空传原整理文字；报告辅助可收集/展示/发送诊断，不在此假定每次都完成上传。
				await this.handleBugCommand(hint ? hint : undefined);
				// 报告流程后不另发一条模型问题。
				return;
			}
			// /copy精确匹配，只执行本地复制命令。
			if (text === "/copy") {
				// 默认选项走最近助手文字复制，不像快捷键入口那样明确preferSelection:true；实际剪贴板操作在callee。
				await this.handleCopyCommand();
				// 复制处理返回后清当前输入，不把复制出的正文粘回编辑器。
				this.editor.setText("");
				// 跳过模型/队列路径。
				return;
			}
			// /name及空格参数交会话名称处理，未按/provider等模型身份解析。
			if (text === "/name" || text.startsWith("/name ")) {
				// 传完整text让处理器取名称或显示用法，不在这里把空参数定义为清名。
				this.handleNameCommand(text);
				// 同步命名处理后清命令文字。
				this.editor.setText("");
				// 名称设置不成为下一轮用户消息。
				return;
			}
			// /session只打开当前会话统计信息，不切换历史文件。
			if (text === "/session") {
				// 构建本地会话/用量信息显示，快照和估算范围由处理器说明。
				this.handleSessionCommand();
				// 清输入命令，不清会话数据。
				this.editor.setText("");
				// 显示统计后结束本次提交。
				return;
			}
			// /changelog展示本地完整更新记录，与启动只显示新内容不同。
			if (text === "/changelog") {
				// 读/解析并显示更新日志，不发模型或远程版本查询。
				this.handleChangelogCommand();
				// 清掉本次命令文字。
				this.editor.setText("");
				// 不把日志命令作为普通提问。
				return;
			}
			// /hotkeys展示当前快捷键帮助，不修改按键绑定配置。
			if (text === "/hotkeys") {
				// 按当前有效键位构建Markdown帮助文字，不修改按键配置。
				this.handleHotkeysCommand();
				// 清输入，不影响键位管理器。
				this.editor.setText("");
				// 帮助展示后直接结束提交。
				return;
			}
			// /fork打开历史用户问题选择器，选择之后才决定Runtime分叉。
			if (text === "/fork") {
				// 调用选择器入口，不在这里预选某个消息ID。
				this.showUserMessageSelector();
				// 清当前命令，选择器另管理输入槽/焦点。
				this.editor.setText("");
				// 不把/fork发送给模型。
				return;
			}
			// /clone使用当前分支克隆入口，和/fork先选旧用户消息不同。
			if (text === "/clone") {
				// 先清输入，等待克隆过程可重绑到新会话。
				this.editor.setText("");
				// 等待handleCloneCommand的取消/Runtime分叉路径，外部异常策略由callee负责。
				await this.handleCloneCommand();
				// 不再执行普通消息提交。
				return;
			}
			// /tree打开同一会话树导航，不等同创建新会话文件。
			if (text === "/tree") {
				// 让用户选择目标条目，摘要选择/导航在后续回调执行。
				this.showTreeSelector();
				// 清输入文字，不删树节点。
				this.editor.setText("");
				// 树选择流程接管后不把/tree交模型。
				return;
			}
			// /trust展示项目授权设置/决策入口，不把文字真值直接当授信。
			if (text === "/trust") {
				// 打开信任选择器，存储更新/需重启说明由其回调决定。
				this.showTrustSelector();
				// 清命令，不在这一行修改ProjectTrustStore。
				this.editor.setText("");
				// 不把信任命令追加成模型上下文消息。
				return;
			}
			// /login支持可选供应商名称/ID参数，前缀严格为普通空格。
			if (text === "/login" || text.startsWith("/login ")) {
				// slice(7)去/login加空格，裸命令传undefined让登录菜单自行选择。
				const providerRef = text.startsWith("/login ") ? text.slice(7).trim() : undefined;
				// 清当前输入，认证文字不会作为下一条普通提问保留。
				this.editor.setText("");
				// 等待匹配/登录分派，实际OAuth/API key/ambient分支由处理器选择；直接登录路径可联网并变更凭据，菜单路径则先返回等待用户后续选择。
				await this.handleLoginCommand(providerRef);
				// 跳过Session普通prompt路径。
				return;
			}
			// 注销入口只识别完整/logout，不在此解析供应商参数。
			if (text === "/logout") {
				// 以logout模式打开凭证选择器，后面用户确认/选择才删除对应凭证。
				this.showOAuthSelector("logout");
				// 清命令输入，不在这一行清所有认证。
				this.editor.setText("");
				// 不把/logout发模型。
				return;
			}
			// /new优先于后面的队列判断，即使当前有压缩/流式也先由Runtime新会话逻辑处理自己的限制/收尾。
			if (text === "/new") {
				// 先清输入，防止重绑时把/new当旧草稿回填。
				this.editor.setText("");
				// 等待新会话处理，不是简单chatContainer.clear；取消/扩展钩子/异常见callee。
				await this.handleClearCommand();
				// 新会话入口不再走本次普通提问。
				return;
			}
			// /compact支持可选摘要自定义要求，属于手动压缩，不按普通消息排队。
			if (text === "/compact" || text.startsWith("/compact ")) {
				// slice(9)去命令加空格并trim，裸命令传undefined沿用摘要默认要求。
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				// 清输入后才开始压缩，文字要求保留在局部变量。
				this.editor.setText("");
				// 等待手动压缩入口，真正模型调用/事件/取消协调在Session及处理器中。
				await this.handleCompactCommand(customInstructions);
				// 压缩命令不作为待压缩后steer文字再提交。
				return;
			}
			// /reload精确匹配，资源/扩展重载不走模型提示词。
			if (text === "/reload") {
				// 先清输入，重载可替换扩展编辑器等UI状态。
				this.editor.setText("");
				// 等待重载处理器，当前忙碌可能仅提示不能重载，返回不等于所有时候都实际加载成功。
				await this.handleReloadCommand();
				// 不继续普通消息路径。
				return;
			}
			// /debug触发本地诊断输出，和/bug报告收集/发送流程不同。
			if (text === "/debug") {
				// 可写包含UI/消息状态的debug日志，本层不对其做脱敏保证。
				this.handleDebugCommand();
				// 清本次命令，debug文本不写回输入。
				this.editor.setText("");
				// 不把/debug当模型问题。
				return;
			}
			// 隐藏命令/arminsayshi进入动画/备选组件入口。
			if (text === "/arminsayshi") {
				// 运行对应显示方法，可能懒加载3D或用普通组件，不在这里改会话历史。
				this.handleArminSaysHi();
				// 清命令文字，动画显示对象另管理。
				this.editor.setText("");
				// 结束彩蛋分支，不进入Bash/排队。
				return;
			}
			// /dementedelves是另一固定显示命令，不接受此分支参数。
			if (text === "/dementedelves") {
				// 调用公告/显示组件入口，实际内容保留原文。
				this.handleDementedDelves();
				// 清输入，不发模型询问公告内容。
				this.editor.setText("");
				// 结束本次提交。
				return;
			}
			// /resume打开会话文件选择菜单，不直接使用“最近会话”常量路径。
			if (text === "/resume") {
				// 列表/用户选择后切换由对应组件和回调处理，可能读取会话目录。
				this.showSessionSelector();
				// 清命令，选择器继续拥有焦点。
				this.editor.setText("");
				// 不把/resume发送给Session.prompt。
				return;
			}
			// /quit精确匹配，直接走交互退出流程。
			if (text === "/quit") {
				// 先清输入，再清理TUI/会话运行时。
				this.editor.setText("");
				// 等待shutdown，其正常路径process.exit；异常可拒绝，不由这个提交回调统一捕获。
				await this.shutdown();
				// 若shutdown因已经在退出等原因正常返回，也不再把/quit当用户消息继续提交。
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			// 内置命令未命中后，任何!起始文字尝试按Bash处理，!!只是其中排除上下文的子形式。
			if (text.startsWith("!")) {
				// 前两个字符为!!才记isExcluded=true，不据正文里其他叹号判断。
				const isExcluded = text.startsWith("!!");
				// 按前缀长度切掉1或2个!后trim得到命令，原text仍保留供历史/忙时回填。
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				// 必须正文非空才执行；裸!或!!会穿过此分支继续下面队列/普通文字路径，不在这里报用法或直接return。
				if (command) {
					// 同一Session已有Bash任务时拒绝再启动一个，这不是检查所有系统子进程都空闲。
					if (this.session.isBashRunning) {
						// 警告仅提示先取消，没有自动终止已有任务。
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						// 把完整!输入放回编辑器供稍后重试，保留!!语法。
						this.editor.setText(text);
						// 忙时不继续执行/排队该Bash命令。
						return;
					}
					// 可选历史能力有则记录完整提交文字，不假定每个扩展编辑器都有历史。
					this.editor.addToHistory?.(text);
					// 等待Bash钩子/执行/显示处理，command已去前缀，isExcluded决定会话上下文记录方式；这一步可能启动真实本地或自定义后端命令。
					await this.handleBashCommand(command, isExcluded);
					// 正常返回后退出Bash输入模式，拒绝会跳过这行及后面边框恢复。
					this.isBashMode = false;
					// 按正常输入/当前思考状态更新边框，不改变已经执行的结果。
					this.updateEditorBorderColor();
					// 有实际Bash命令的分支到此结束，不重复把同一文字发模型。
					return;
				}
			}

			// Queue input during compaction (extension commands execute immediately)
			// 非内置/Bash提交在压缩中先进入UI暂存逻辑，而非立刻与压缩并发普通prompt。
			if (this.session.isCompacting) {
				// 只有runner精确识别为扩展命令才允许即时处理，不把所有/前缀都当扩展。
				if (this.isExtensionCommand(text)) {
					// 扩展命令走即时路径，先按编辑器能力记入历史。
					this.editor.addToHistory?.(text);
					// 清输入，用户可继续输入而命令自己执行。
					this.editor.setText("");
					// Session.prompt先处理扩展命令，因而可在手动压缩门禁之前被接管；不代表普通模型提问在压缩中也合法。
					await this.session.prompt(text);
				} else {
					// 其余文字按steer意图进入本UI compaction队列，helper负责历史/清输入/待显示状态。
					this.queueCompactionMessage(text, "steer");
				}
				// 压缩中分支不再落到下面流式或空闲路径，避免同一输入重复排队。
				return;
			}

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			// 不是压缩但会话仍在运行时，普通Enter提交按插话steer处理。
			if (this.session.isStreaming) {
				// 先记录完整整理后的文字，扩展编辑器无历史方法则跳过。
				this.editor.addToHistory?.(text);
				// 清当前输入，Session层随后可展开模板/技能或执行扩展命令。
				this.editor.setText("");
				// 显式streamingBehavior:"steer"满足忙碌prompt要求；await该调用的队列/命令处理，不等于等待整个正在运行Agent最终结束。
				await this.session.prompt(text, { streamingBehavior: "steer" });
				// 更新待处理文字显示，Session队列已由前面prompt按实际行为写入。
				this.updatePendingMessagesDisplay();
				// 请求UI帧，不强制打断当前模型流。
				this.ui.requestRender();
				// 流式输入不再进入本地pendingUserInputs，避免重复交主循环。
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			// 空闲普通消息先把待Bash显示组件挪到聊天区，保持视觉顺序；不是在这里重新执行Bash。
			this.flushPendingBashComponents();

			// 若getUserInput已有等待回调，则直接唤醒它，不另存相同文字一份。
			if (this.onInputCallback) {
				// 回调会清自己的槽并resolve主循环输入Promise；模型运行在run的后续await续体，不是此处同步完成回答。
				this.onInputCallback(text);
			} else {
				// 还没输入等待者时按FIFO暂存，供getUserInput下次取；区别于Session的steering/follow-up队列。
				this.pendingUserInputs.push(text);
			}
			// 普通输入也按可选能力加历史；本路径未显式editor.setText("")，依提交编辑器本身的清理行为，不保证任意自定义编辑器会自动清空。
			this.editor.addToHistory?.(text);
		};
	}

	// 订阅当前Session事件并保存off，返回void；事件回调用async等待handleEvent自己的处理，但发射方Session._emit同步调用监听器而不await其返回Promise。
	// 例如handleEvent因init或压缩等await让出后，Session仍可继续发后续事件；这里没有串行事件队列或统一catch，不能写成“会话等待UI处理完才继续”。
	// 本方法也不先退旧订阅，正常由rebindCurrentSession先unsubscribe再调用它。
	private subscribeToAgent(): void {
		// 对当前会话注册一次异步监听并保存取消函数，旧off若被覆盖且未先调用就无法仅从本字段找回。
		this.unsubscribe = this.session.subscribe(async (event) => {
			// 等待该次UI事件方法完成；拒绝变成监听器Promise拒绝，Session._emit并不会因此自动捕获/等待它。
			await this.handleEvent(event);
		});
	}

	// 将一个AgentSessionEvent投影到界面，返回Promise<void>：先确保界面初始化、失效页脚/更新终端状态，再按type处理消息、工具、条目、压缩与重试。
	// 例assistant增量更新同一消息组件，tool_execution_end更新对应工具行，agent_end只结束一次低层运行显示，agent_settled才检查退出请求。
	// 通常不在此执行工具或生成摘要，但未初始化时init会启动完整TUI/工具准备，settled退出可清理并终止进程，渲染解析还可调用扩展代码。
	// 公开事件发射方不await此监听器Promise，await初始化/退出等可让后续事件先继续；没有本方法级catch或通用串行队列，不保证UI异常阻止Session持久化。
	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		// 尚未标记启动才尝试init，true也可能只是TUI已start而后续初始化仍在进行。
		if (!this.isInitialized) {
			// 这里真实await可能让出事件循环，不用假定所有事件严格同步处理完才到下一条。
			await this.init();
		}

		// 每条事件先让内置页脚缓存失效，后续显示时重新读数据；不立即刷新模型用量。
		this.footer.invalidate();
		// 把同一事件交ProgramStatusReporter记录working/blocked/结果，实际报告规则与下方组件switch分开。
		this.programStatus.handleEvent(event);

		// switch按字符串判别联合，TS在每个case缩窄event字段；未列事件没有统一default报错或穷尽性检查。
		switch (event.type) {
			// agent_start代表低层Agent开始一次运行，不等于新建了会话文件。
			case "agent_start":
				// 清上一轮待工具显示索引，新轮工具由参数增量/开始事件再建立；不直接删除聊天里旧工具结果组件。
				this.pendingTools.clear();
				// Restore main escape handler if retry handler is still active
				// (retry success event fires later, but we need main handler now)
				// 如果重试临时Escape处理器仍保存着旧入口，在新Agent开始先恢复它，不必等较晚的重试成功通知。
				if (this.retryEscapeHandler) {
					// 把保存的普通Escape函数写回默认编辑器，后面输入回到正常取消/队列恢复规则。
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					// 清保存槽，避免auto_retry_end再次恢复同一份旧函数。
					this.retryEscapeHandler = undefined;
				}
				// 离开这个case，Agent运行本身由会话层继续，不在UI里再次启动流。
				break;

			// turn_start用于开始新一轮模型/工具循环的工作显示，和整个agent_start生命周期不同。
			case "turn_start":
				// 当前设置允许才写终端进度，不把状态文字显示当百分比进度。
				if (this.settingsManager.getShowTerminalProgress()) {
					// 设置不定工作进度true，真实协议支持由Terminal决定。
					this.ui.terminal.setProgress(true);
				}
				// workingVisible只控制这类指示器显示，不影响Agent是否运行。
				if (this.workingVisible) {
					// 已有working状态就复用，不重复创建/重启动画。
					if (this.activeStatusIndicator?.kind !== "working") {
						// 否则构造并展示工作指示器，可嵌入边框或单独行。
						this.showWorkingStatusIndicator();
					}
				} else {
					// 隐藏工作偏好时这里不带kind过滤，实际清任意活动指示器，保留原代码具体行为。
					this.clearStatusIndicator();
				}
				// 请求显示本轮状态变化，不等待终端完成绘制。
				this.ui.requestRender();
				// 结束turn_start显示处理，不发起新的模型请求。
				break;

			// 队列变动事件只提示重建待发送显示，这个case不直接使用event携带数组，而让辅助方法现读队列。
			case "queue_update":
				// 更新Session与UI压缩队列的展示文本，不取出/提交它们。
				this.updatePendingMessagesDisplay();
				// 请求一帧以反映新增/移除排队文字。
				this.ui.requestRender();
				// 不把queue_update作为聊天消息追加。
				break;

			// 持久化条目追加通知，按条目类型决定是否单独显示；普通message条目主要已由message事件显示，不在这里全部重画。
			case "entry_appended":
				// Set.delete既删除ID也返回是否原来存在；边界压缩已提前画出的条目命中就跳过此次通知，避免重复，非命中继续。
				if (this.entriesRenderedByBoundaryCompaction.delete(event.entry.id)) break;
				// custom条目是会话状态记录，与下面custom_message/Agent custom角色分开。
				if (event.entry.type === "custom") {
					// 仅有扩展entry renderer且产生内容才可能添加状态组件，helper决定插在当前流式回复之前等位置。
					this.addCustomEntryToChat(event.entry);
					// 即使helper没有可见内容仍请求帧，不把返回void当插入成功标记。
					this.ui.requestRender();
					// usage条目中这里只直接显示cache_warm类，其它usage不因本分支自动全部画出。
				} else if (event.entry.type === "usage" && event.entry.kind === "cache_warm") {
					// 格式化已记录缓存预热用量/费用，是否显示仍受辅助方法设置门禁控制。
					this.addCacheWarmingUsage(event.entry);
					// 请求重绘，不由显示事件再次预热缓存。
					this.ui.requestRender();
					// custom_message只有display真才显示；display=false条目仍可在会话/模型上下文里存在，不等于未保存。
				} else if (event.entry.type === "custom_message" && event.entry.display) {
					// 先构造应用custom消息再走通用消息显示，不把整个存储条目直接当模型Message。
					this.addMessageToChat(
						// 包装辅助只创建新消息/转换时间戳，不执行扩展或请求模型。
						createCustomMessage(
							// 保留扩展customType以寻找自定义消息renderer。
							event.entry.customType,
							// 正文字符串/块数组沿用引用，未在UI这里压缩或深复制图片。
							event.entry.content,
							// 保留display字段，虽然进入此分支时已经为真。
							event.entry.display,
							// 未知details原样透传给消息显示对象，核心不在这里解析其任意形状。
							event.entry.details,
							// 条目时间字符串由包装函数转为毫秒，不使用当前时间替代这个custom消息。
							event.entry.timestamp,
						),
					);
					// 通用消息组件加入后请求帧，不再持久化一次相同custom_message。
					this.ui.requestRender();
					// 新追加压缩检查点可能来自扩展边界批次，需把模型上下文前置摘要按显示时间位置重排。
				} else if (event.entry.type === "compaction") {
					// 读取当前叶子的压缩感知条目列表，可能已包含这批后续追加记录，不是仅拿event.entry一条。
					const entries = this.sessionManager.buildContextEntries();
					// 只有首项正好是本次检查点ID才重画，其他分支/旧摘要的通知直接跳过，不覆盖当前显示。
					if (entries[0]?.id !== event.entry.id) break;
					// 清聊天显示，原会话树记录不删。
					this.chatContainer.clear();
					// 拿当前branch完整根路径用于时间位置划分，和上面已压缩保留条目列表不同。
					const branch = this.sessionManager.getBranch();
					// 在完整分支里找当前检查点位置，缺项为-1，本行没有额外抛错检查。
					const compactionIndex = branch.findIndex((entry) => entry.id === event.entry.id);
					// 收集该位置后面的全部条目ID；若索引-1按原slice(0)实际收整条分支，不凭名称补“必已找到”的保证。
					const entriesAfterCompaction = new Set(branch.slice(compactionIndex + 1).map((entry) => entry.id));
					// 去掉上下文前置的第一条检查点，其余作为保留显示材料，不改entries原数组。
					const retainedEntries = entries.slice(1);
					// 先渲染不在检查点后缀集合中的保留项，也就是此次显示划分的前半；helper每次会重新建立自身工具显示索引。
					this.renderSessionEntries(retainedEntries.filter((entry) => !entriesAfterCompaction.has(entry.id)));
					// 再把本次摘要插到两段保留内容之间，和模型输入固定放最前的顺序区分。
					this.addMessageToChat(
						// 从已存摘要/token记录/条目时间包装显示消息，不在这里调用模型重新摘要。
						createCompactionSummaryMessage(event.entry.summary, event.entry.tokensBefore, event.entry.timestamp),
					);
					// 仅条目带usage才另加摘要费用提示，没有时不估造一份token/cost。
					if (event.entry.usage) {
						// 辅助方法仍会按显示设置决定是否真正追加费用行。
						this.addCompactionCostNotice({
							// 合成显示记录以compaction_cost判别，不是新增持久化SessionEntry。
							type: "compaction_cost",
							// kind说明此次费用来源是压缩，不是branch_summary。
							kind: "compaction",
							// 使用条目本身的Usage引用，不重新从聊天文字计算token。
							usage: event.entry.usage,
						});
					}
					// 最后渲染位于检查点后缀集合中的保留项；两次renderSessionEntries并非共享一张局部工具调用匹配表。
					this.renderSessionEntries(retainedEntries.filter((entry) => entriesAfterCompaction.has(entry.id)));
					// 把完整分支后缀的全部ID都登记去重，不仅限刚通过保留过滤真正显示的项；后续对应entry_appended可delete后跳过。
					for (const entryId of entriesAfterCompaction) this.entriesRenderedByBoundaryCompaction.add(entryId);
					// 摘要/保留历史变化后再次失效页脚，让其下次计算当前上下文/用量显示。
					this.footer.invalidate();
					// 请求显示这次重建结果，不修改模型上下文选择算法本身。
					this.ui.requestRender();
				}
				// entry_appended其它类型默认不加新组件，不在这个case逐项重放工具执行。
				break;

			// 会话信息变化时重新取元信息更新标题，而不是直接使用event.name拼标题。
			case "session_info_changed":
				// 标题反映当前会话名与cwd末段，不改变保存名称。
				this.updateTerminalTitle();
				// 页脚可能包含会话名等信息，令缓存失效。
				this.footer.invalidate();
				// 安排重绘显示信息变动。
				this.ui.requestRender();
				// 该事件不重建整个聊天历史。
				break;

			// 有效思考级别改变用于显示同步，不在这里再调用Session.setThinkingLevel。
			case "thinking_level_changed":
				// 页脚下次显示读取新级别，不在事件里重新查询供应商能力。
				this.footer.invalidate();
				// 边框颜色随当前级别更新，辅助自身会安排刷新/失效状态，不另造一条聊天消息。
				this.updateEditorBorderColor();
				// 离开case，保留当前消息/工具显示对象。
				break;

			// 消息开始按role分别处理自定义/用户/助手，其余角色在本case不创建普通文字组件。
			case "message_start":
				// custom角色可由扩展发出，是否真正显示交addMessageToChat的display门禁。
				if (event.message.role === "custom") {
					// 复用通用自定义消息renderer路径，不直接将所有details JSON打印。
					this.addMessageToChat(event.message);
					// 请求显示可能新增的自定义内容。
					this.ui.requestRender();
					// 用户消息开始表示Session已接收/调度这条输入，不只是它还在pending区等待。
				} else if (event.message.role === "user") {
					// 将用户文字/图片/技能包装等投影为聊天组件。
					this.addMessageToChat(event.message);
					// 重新读取待队列显示，让已被取出的输入不再继续重复挂在pending区。
					this.updatePendingMessagesDisplay();
					// 请求同帧展示聊天与队列变化。
					this.ui.requestRender();
					// 助手开始先建立空内容组件，后面的增量更新复用它。
				} else if (event.message.role === "assistant") {
					// 创建AssistantMessageComponent，保存显示配置，不执行任何toolCall。
					this.streamingComponent = new AssistantMessageComponent(
						// 首参undefined让构造先只建内部容器，实际内容下面用updateContent填入。
						undefined,
						// 初始思考块可见偏好取本实例当前标记，仅影响显示。
						this.hideThinkingBlock,
						// 取当前Markdown主题并覆盖代码块缩进，返回新顶层配置。
						this.getMarkdownThemeWithSettings(),
						// 传当前隐藏思考占位标题，空串可按助手组件规则不显示占位行。
						this.hiddenThinkingLabel,
						// 传当前输出水平边距，不在这里改usage/context大小。
						this.outputPad,
						// 变换器顺序为内置Mermaid再扩展，保存引用到实际渲染时应用。
						this.getMarkdownTransformers(),
					);
					// 保存event.message同一对象引用，不做深拷贝流式块。
					this.streamingMessage = event.message;
					// 把空/初始助手组件加入聊天，后面参数工具行可以接在它后面。
					this.chatContainer.addChild(this.streamingComponent);
					// 明确isStreaming:true更新正文，避免组件误按最终状态执行显示转换。
					this.streamingComponent.updateContent(this.streamingMessage, true);
					// 请求渲染初始助手内容，不等待整个模型回答。
					this.ui.requestRender();
				}
				// message_start未覆盖的role自然结束此case，没有default异常。
				break;

			// message_update携带的是当前消息对象/快照，UI据其content重建显示，不在此直接拼原始SSE字节。
			case "message_update":
				// 必须已有streamingComponent且role为assistant才更新，否则忽略这条增量。
				if (this.streamingComponent && event.message.role === "assistant") {
					// 替换当前消息引用为事件给的对象，后面循环读取最新content。
					this.streamingMessage = event.message;
					// 仍标流式true更新正文/思考，工具调用不在助手正文组件中真正执行。
					this.streamingComponent.updateContent(this.streamingMessage, true);

					// 逐块检查当前完整content，工具参数可能尚在生成，不假定每次事件只新增一块。
					for (const content of this.streamingMessage.content) {
						// 只有toolCall块需要独立工具行，text/thinking等已交助手组件显示。
						if (content.type === "toolCall") {
							// 按调用ID去重创建，工具名相同但ID不同仍会有不同组件。
							if (!this.pendingTools.has(content.id)) {
								// 创建工具显示行，仅解析渲染/保存参数，不调用工具execute或参数schema校验。
								const component = new ToolExecutionComponent(
									// 名称用于选择标题/渲染器，与工具调用ID用途不同。
									content.name,
									// 调用ID供后续执行事件关联同一行。
									content.id,
									// 参数可能是部分解析结果，沿用引用，不要求此时已通过完整schema验证。
									content.arguments,
									// 显示选项对象不包含真正工具执行权限/超时配置。
									{
										// 图片显示开关来自当前设置，不修改工具返回的原图片块。
										showImages: this.settingsManager.getShowImages(),
										// 图片最大显示列宽传组件，不在这里压缩/上传字节。
										imageWidthCells: this.settingsManager.getImageWidthCells(),
										// 通用输出边距原样传递。
										outputPad: this.outputPad,
									},
									// 调用扩展resolver链/内置后备取渲染定义，解析回调可运行，工具本身不运行。
									this.getRegisteredToolDefinition(content.name),
									// 稳定ui供组件请求帧/异步显示刷新，切渲染器后仍可转发。
									this.ui,
									// 当前会话cwd用于路径显示/renderer上下文，不切process.cwd。
									this.sessionManager.getCwd(),
								);
								// 新工具行沿全局展开偏好构建显示，尚未有最终结果也可先展示调用。
								component.setExpanded(this.toolOutputExpanded);
								// 把行接进聊天树，原助手正文组件继续保持。
								this.chatContainer.addChild(component);
								// 登记ID→组件，参数增量/执行开始/结束随后复用。
								this.pendingTools.set(content.id, component);
							} else {
								// 已经有ID则读现有组件，不每个参数片段新建一行。
								const component = this.pendingTools.get(content.id);
								// Map.get仍可能undefined，保留原实现的存在条件。
								if (component) {
									// 仅记录最新参数并请求渲染，组件把实际参数renderer更新推迟到显示阶段；不执行工具。
									component.updateArgs(content.arguments);
								}
							}
						}
					}
					// 整个消息增量处理后请求帧，TUI可合并同轮多次requestRender。
					this.ui.requestRender();
				}
				// 没有满足assistant/stream组件条件的增量不额外重建其他角色显示。
				break;

			// 完整消息结束时完成助手显示/参数预览和诊断，持久化仍由Session负责，不在UI里另appendMessage。
			case "message_end":
				// 用户结束事件直接跳过本case的最终requestRender，用户显示已在message_start处理。
				if (event.message.role === "user") break;
				// 只有仍有当前流式组件且role为assistant才做收尾；其他角色不在这里伪造助手组件。
				if (this.streamingComponent && event.message.role === "assistant") {
					// 保存最终事件消息引用，不以此前最后一个增量对象推断完整内容。
					this.streamingMessage = event.message;
					// 局部可选错误文字先为空，取消时生成自己的可读提示，普通error再取原错误。
					let errorMessage: string | undefined;
					// stopReason严格aborted时重新组织UI错误说明，不把所有error都显示为用户取消。
					if (this.streamingMessage.stopReason === "aborted") {
						// 从当前Session取普通重试计数，摘要重试有独立事件/计数，不混在这里。
						const retryAttempt = this.session.retryAttempt;
						// 按计数生成取消文案，不在这里发abort或开始下一次重试。
						// 计数大于1用复数s，展示的是事件时读到的次数，不是工具调用数。
						// 没重试计数就用Operation aborted原文。
						errorMessage =
							// 大于0才显示“若干次重试后取消”，0走普通取消文字。
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						// 直接修改共享message.errorMessage，不是只改UI副本；通常已初始化同步处理时，公共监听发生在Session随后appendMessage之前，因此这份修改也可进入保存消息。
						this.streamingMessage.errorMessage = errorMessage;
					}
					// 明确流式false重建最终正文/停止提示，让Markdown转换器可以按最终模式渲染。
					this.streamingComponent.updateContent(this.streamingMessage, false);

					// aborted或error任一成立都将仍待完成的工具显示标失败；其他停止原因即使length也走下面“参数完成”分支。
					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						// 前面取消路径已生成文字就沿用，尚无才从消息错误取值。
						if (!errorMessage) {
							// errorMessage真值优先，否则兜底Error；不做错误类型或计费状态解析。
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						// 遍历当前pendingTools所有行，解构忽略ID只取组件，未调用工具取消/重试。
						for (const [, component] of this.pendingTools.entries()) {
							// 用合成显示结果替换未完成行原结果，不把它写成真实toolResult消息。
							component.updateResult({
								// 合成一个text块说明错误，原部分输出不会在这里自动合并保留。
								content: [{ type: "text", text: errorMessage }],
								// isError:true给渲染器错误状态，表示这条显示的结束处理，不是重新验证工具进程退出码。
								isError: true,
							});
						}
						// 清待匹配索引，已画的错误组件仍在聊天树中。
						this.pendingTools.clear();
						// 按取消/暂时错误/安装变化过滤是否给bug建议，不在这里自动上传报告。
						this.maybeSuggestBugReport(this.streamingMessage);
					} else {
						// Args are now complete - trigger diff computation for edit tools
						// 非aborted/error时遍历仍挂着的工具行，说明参数流结束，可以生成完整预览。
						for (const [, component] of this.pendingTools.entries()) {
							// 标argsComplete并立即更新显示，edit等renderer可计算diff；不等于参数已通过工具schema或工具执行成功，length也会进入这里。
							component.setArgsComplete();
						}
						// 显示思考签名丢失等诊断，读的是当前消息与此前历史；正常同步事件路径尚在本条消息持久化之前。
						this.maybeShowThinkingDropNotice(this.streamingMessage);
						// 按当前usage/上条请求线索判断缓存未命中提醒，不在UI里重新发送请求或收费。
						this.maybeShowCacheMissNotice(this.streamingMessage);
					}
					// 清当前流式组件槽，组件已在聊天树作为完成消息保留。
					this.streamingComponent = undefined;
					// 清当前消息跟踪引用，不删除Agent/Session持有的最终消息对象。
					this.streamingMessage = undefined;
					// 最终usage/模型状态可变，令页脚下次重新计算显示。
					this.footer.invalidate();
				}
				// 非用户message_end即使没有当前助手组件也会请求一帧。
				this.ui.requestRender();
				// 消息收尾不表示整个Agent已结束，后面仍可执行刚生成的工具调用。
				break;

			// 用户手动Bash增量有独立回调渲染，本case不把同一delta再画一次。
			case "bash_execution_update":
				// The bash execution callback handles TUI output rendering.
				// 直接略过，保留其他Bash执行流程对组件的更新。
				break;

			// case后加块作用域，允许在此声明let component而不与其他case同名局部冲突。
			case "tool_execution_start": {
				// Nested calls (from codemode scripts) are shown inside their parent's row.
				// 有父调用ID的嵌套工具行由父工具renderer显示，跳过本级新建；不表示嵌套工具未执行/不计用量。
				if (event.parentToolCallId) break;
				// 优先用参数流阶段已按toolCallId创建的行，没有才后备新建。
				let component = this.pendingTools.get(event.toolCallId);
				// 没有预览行可能是非普通模型参数流发起的工具调用，仍可从执行事件建显示。
				if (!component) {
					// 创建ToolExecutionComponent只建立显示和renderer，不重复执行已开始的工具。
					component = new ToolExecutionComponent(
						// 用事件给的工具原名选择显示定义。
						event.toolName,
						// 用本次调用ID关联后续partial/end，与工具名称不是同一键。
						event.toolCallId,
						// 开始事件参数原样交显示，UI不在此再做schema校验。
						event.args,
						// 显示选项与前面参数预览路径保持同一组字段。
						{
							// 是否展示结果图片取当前设置，不删除原返回块。
							showImages: this.settingsManager.getShowImages(),
							// 传图片显示宽度，实际字节转换/图协议由组件/辅助处理。
							imageWidthCells: this.settingsManager.getImageWidthCells(),
							// 传当前输出边距，新组件不会自动继承旧组件所有局部设置。
							outputPad: this.outputPad,
						},
						// 扩展解析链/内置后备决定渲染槽，解析回调可以执行，但不是工具execute。
						this.getRegisteredToolDefinition(event.toolName),
						// ui稳定代理供该行请求刷新，未启动新终端对象。
						this.ui,
						// 会话cwd作renderer显示上下文，不把工具事件路径转成另一个工作目录。
						this.sessionManager.getCwd(),
					);
					// 新建行沿用全局展开偏好，后面仍可单独点击展开/折叠。
					component.setExpanded(this.toolOutputExpanded);
					// 追加聊天行，预先已有行时不重复追加。
					this.chatContainer.addChild(component);
					// 登记新的显示索引，update/end按这个ID找回。
					this.pendingTools.set(event.toolCallId, component);
				}
				// 标记执行已开始并重建/请求绘制，供renderer显示计时等；不在这里启动命令。
				component.markExecutionStarted();
				// 宿主再请求帧，TUI可合并组件内部的请求。
				this.ui.requestRender();
				// 结束这一工具开始case，保留组件待后续结果。
				break;
			}

			// 工具中间结果事件只更新已有索引，不为未知ID另建一行。
			case "tool_execution_update": {
				// Map按调用ID查，不按名称/父ID向上猜父行。
				const component = this.pendingTools.get(event.toolCallId);
				// 找不到行就忽略UI更新，嵌套调用常由父行自行显示，不代表底层结果被丢弃持久化。
				if (component) {
					// 浅展开partialResult再覆盖isError:false，并明确isPartial:true；组件整体替换本次部分结果，不由这里自动追加此前content。
					component.updateResult({ ...event.partialResult, isError: false }, true);
					// 结果更新方法本身不直接requestRender，宿主在此安排帧。
					this.ui.requestRender();
				}
				// 不把部分结果当最终完成，不删除pendingTools项。
				break;
			}

			// 工具最终结果事件完成对应显示行，作用域块允许与其他case使用同名component。
			case "tool_execution_end": {
				// 任何isError真值先尝试安装变化提醒，即使此ID没有本级行/属于嵌套调用也会检查；不因错误就自动建议所有工具重试。
				if (event.isError) this.maybeShowInstallChangeWarning();
				// 按调用ID取还未结束的行，结果对象本身不决定它应放到哪一行。
				const component = this.pendingTools.get(event.toolCallId);
				// 存在时才改显示/删索引，不为未知结果补建孤立组件。
				if (component) {
					// 浅复制最终result，事件isError/durationMs覆盖同名字段（即使durationMs为undefined）；默认isPartial:false，供成功/错误背景与耗时显示。
					component.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs });
					// 更新成功后删等待索引，聊天中的完成组件保留；updateResult抛错会跳过删除与后续请求。
					this.pendingTools.delete(event.toolCallId);
					// 请求显示最终结果，不在这行另保存toolResult或执行工具。
					this.ui.requestRender();
				}
				// 退出工具结束case，整次Agent可能还有其他工具/后续模型轮。
				break;
			}

			// 一次低层Agent运行结束的显示收尾；会话可能计划重试/压缩恢复，不能把它当agent_settled。
			case "agent_end":
				// 按设置决定是否清终端工作进度，不要求所有后续重试计划已经取消。
				if (this.settingsManager.getShowTerminalProgress()) {
					// 发progress:false表示这一显示阶段结束，不验证整任务业务成功。
					this.ui.terminal.setProgress(false);
				}
				// 只清kind为working的指示器，保留可能接手显示的retry/compaction等状态。
				this.clearStatusIndicator("working");
				// 还残留streamingComponent说明没有走完普通助手结束显示，移掉这个未正常完成的组件。
				if (this.streamingComponent) {
					// 从聊天直接移除当前流行，未删除Session中的任何消息记录。
					this.chatContainer.removeChild(this.streamingComponent);
					// 清组件跟踪槽，后续新agent_start/message_start重新建立。
					this.streamingComponent = undefined;
					// 清同时保存的消息引用，不改其正文/错误字段。
					this.streamingMessage = undefined;
				}
				// 清所有待工具显示关联，不逐个合成错误结果、不保证真实子进程由本case停止。
				this.pendingTools.clear();

				// 请求重绘收尾后的聊天/状态区。
				this.ui.requestRender();
				// 不在agent_end直接检查退出请求，留给整体结算事件。
				break;

			// 整体会话协调结算才进入退出检查，ProgramStatusReporter在前面已处理同一事件状态。
			case "agent_settled":
				// await检查shutdownRequested，必要时清理并退出；发射方不等待UI监听器Promise，因此不是反向阻塞Session结算的确认机制。
				await this.checkShutdownRequested();
				// 没有退出请求时仅完成本事件，不重新发Agent请求。
				break;

			// 压缩开始事件只设置可见进度/取消入口/动画，不在此生成摘要。
			case "compaction_start": {
				// 设置允许才向Terminal显示工作进度。
				if (this.settingsManager.getShowTerminalProgress()) {
					// 置进度true表示压缩阶段有工作，不提供完成百分比。
					this.ui.terminal.setProgress(true);
				}
				// Keep editor active; submissions are queued during compaction.
				// 保存默认编辑器当前Escape，可能已是另一个临时处理器；字段可为undefined。
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				// 压缩期间替换Escape为取消摘要入口，编辑器本身仍可输入并由提交处理器排队。
				this.defaultEditor.onEscape = () => {
					// Session同时通知手动/自动压缩控制器取消，不直接删摘要条目或等待底层停请求。
					this.session.abortCompaction();
				};
				// 按当前编辑器嵌入状态决定是否提供统一边框颜色函数。
				// 色函数在使用时现读编辑器/思考级别，不把它们固化成启动时颜色字符串。
				// 非嵌入不传统一色，CompactionStatusIndicator用自身默认颜色。
				const colorFn = isEmbeddedStatus(this.editor)
					? (text: string) =>
							// 当前borderColor存在优先，否则按思考级别/off取主题边框函数。
							(this.editor.borderColor ?? theme.getThinkingBorderColor(this.session.thinkingLevel || "off"))(
								// 将实际待着色text交选出的函数，括号跨行仍是同一次调用。
								text,
							)
					: undefined;
				// 按manual/threshold/overflow原因生成压缩动画文案并替换当前指示器，构造可开动画计时。
				this.showStatusIndicator(new CompactionStatusIndicator(this.ui, event.reason, colorFn));
				// 请求显示压缩状态，不禁用输入或直接调用Session.compact。
				this.ui.requestRender();
				// 结束压缩开始处理，真正摘要进度由Session继续推进。
				break;
			}

			// 压缩结束先还原进度/部分Escape状态，按取消→结果→错误优先级显示，再安排压缩队列提交。
			case "compaction_end": {
				// 按当前设置决定清Terminal进度，设置在压缩期间变更也以当前值为准。
				if (this.settingsManager.getShowTerminalProgress()) {
					// 发送progress:false，不表示用户队列随后不会继续启动工作。
					this.ui.terminal.setProgress(false);
				}
				// 只有保存的原Escape函数真值才恢复；如果原来undefined，这条分支不清新装的取消函数，不把注释写成“总恢复原值”。
				if (this.autoCompactionEscapeHandler) {
					// 把保存回调写回默认编辑器，其他自定义编辑器若通过动态转发可看到新入口。
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					// 清保存槽，避免以后又恢复同一旧函数。
					this.autoCompactionEscapeHandler = undefined;
				}
				// 只清compaction类动画，若其他kind已接管显示则不误删。
				this.clearStatusIndicator("compaction");
				// aborted优先，即使结果/错误字段同时真值也不走后面分支。
				if (event.aborted) {
					// 手动取消用错误提示样式，与自动取消普通状态区别显示。
					if (event.reason === "manual") {
						// 显示固定取消文字，不在此重新throw取消或重试压缩。
						this.showError("Compaction cancelled");
					} else {
						// 自动压缩取消用showStatus，不把它伪装为成功摘要。
						this.showStatus("Auto-compaction cancelled");
					}
					// 未取消且有result才按完成摘要重建聊天；没有结果不是必然成功。
				} else if (event.result) {
					// 读取当前SessionManager的压缩感知上下文，而非仅根据event.result拼完整历史。
					const entries = this.sessionManager.buildContextEntries();
					// 完成压缩时要求上下文首项type为compaction；这里只看类型，不另比较结果对象/条目ID。
					if (entries[0]?.type !== "compaction") {
						// 不满足不变量直接throw使UI监听器Promise拒绝，下面flush队列/requestRender也会被跳过；不是静默按空历史继续。
						throw new Error("Completed compaction is missing from the session context");
					}
					// 清聊天组件，持久化旧记录仍保留在会话树中。
					this.chatContainer.clear();
					// The latest compaction is prepended for model context; append it below at its chronological position.
					// 先渲染去首条检查点后的保留项，再在下面追加显示摘要；这条常规压缩结束路径与边界entry_appended的两段划分不同。
					this.renderSessionEntries(entries.slice(1));
					// 把当前完成结果包装为摘要消息显示，不重新调用摘要模型。
					this.addMessageToChat(
						// 包装函数只构造角色/summary/tokensBefore/毫秒时间戳。
						createCompactionSummaryMessage(
							// 摘要正文来自事件result，不在此再缩短或按Topic重组。
							event.result.summary,
							// 压缩前token数按结果记录使用，不重新tokenize原文。
							event.result.tokensBefore,
							// 本处显示时间使用当前UTC ISO文字，不采用Session检查点原timestamp，保留原始行为差异。
							new Date().toISOString(),
						),
					);
					// 有真实结果usage才显示对应费用，不凭tokensBefore估造费用。
					if (event.result.usage) {
						// 通过费用辅助方法处理显示设置/格式。
						this.addCompactionCostNotice({
							// 合成compaction_cost显示分支标签，不保存新的会话条目。
							type: "compaction_cost",
							// kind为compaction，费用标题与branch_summary区分。
							kind: "compaction",
							// 沿用结果Usage，不复制其内部cost对象。
							usage: event.result.usage,
						});
					}
					// 上下文/摘要显示改变后让页脚再计算当前显示。
					this.footer.invalidate();
					// 未取消、没result但有非空errorMessage才显示失败；字段全缺时不造一个Unknown error。
				} else if (event.errorMessage) {
					// 手动压缩错误用统一showError路径。
					if (event.reason === "manual") {
						// 显示Session提供的错误文字，不在UI层判定是否继续重试。
						this.showError(event.errorMessage);
					} else {
						// 自动压缩错误直接加Spacer和水平边距1的错误文字；手动showError则采用当前outputPad，二者不走同一封装。
						this.chatContainer.addChild(new Spacer(1));
						// 把已缩窄为string的错误存局部，供延迟ThemedText闭包安全使用。
						const errorMessage = event.errorMessage;
						// 延迟错误着色，水平边距1，未在此转义/脱敏错误正文。
						this.chatContainer.addChild(new ThemedText(() => theme.fg("error", errorMessage), 1, 0));
					}
				}
				// 无论普通取消/成功/失败分支，只要未提前抛错都会尝试flush；willRetry原样传入，决定与会话重试/队列协调，不在这里await。
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				// 安排显示压缩结束与队列变化，flush仍可能异步继续。
				this.ui.requestRender();
				// 结束当前事件处理，不保证排队输入已运行完。
				break;
			}

			// 普通回答自动重试开始，显示倒计时并暂时让Escape只取消退避等待。
			case "auto_retry_start": {
				// Set up escape to abort retry
				// 保存当前默认Escape，供新agent_start或auto_retry_end先到者恢复。
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				// 临时替换为重试取消入口，非直接关闭整个Session。
				this.defaultEditor.onEscape = () => {
					// 通知当前普通重试退避控制器abort，是否已开始下一次请求由Session协调，不在UI直接停止所有网络。
					this.session.abortRetry();
				};
				// 使用统一状态安放逻辑，旧动画会dispose，新状态可嵌入编辑器。
				this.showStatusIndicator(
					// 用事件次数/上限/毫秒延迟构造显示倒计时，计时器到期不在组件内部发模型请求。
					new RetryStatusIndicator(this.ui, event.attempt, event.maxAttempts, event.delayMs),
				);
				// 请求显示重试文案，实际退避/重试代码在会话层。
				this.ui.requestRender();
				// 结束开始事件，保留取消处理器直到后续恢复事件。
				break;
			}

			// 普通回答重试结束，按事件success决定是否显示最终失败，不重新推断任务业务是否已完成。
			case "auto_retry_end": {
				// Restore escape handler
				// 只有还保存旧函数才恢复；agent_start可能已提前恢复并把这个槽清空。
				if (this.retryEscapeHandler) {
					// 写回普通Escape入口，避免之后按键仍只发abortRetry。
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					// 清保存槽，后续结束事件不重复写旧值。
					this.retryEscapeHandler = undefined;
				}
				// 只清retry动画，若别的状态已接手则保留它。
				this.clearStatusIndicator("retry");
				// Show error only on final failure (success shows normal response)
				// success:false才显示失败，success:true也只是Session给的重试结果标签，不证明用户任务已全部成功。
				if (!event.success) {
					// 插入attempt与finalError，空错误回Unknown error；不在这里再发自动重试。
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				// 请求显示清理/失败结果。
				this.ui.requestRender();
				// 不把重试事件本身当助手消息存储。
				break;
			}

			// 摘要重试计划与普通回答重试事件分开，先显示错误，再展示等待动画。
			case "summarization_retry_scheduled": {
				// 显示这次摘要错误原因，真正重试预算/退避不在UI决定。
				this.showError(event.errorMessage);
				// 替换当前状态为retry倒计时，不在此额外覆盖Escape；压缩/树摘要入口自己的取消回调仍按原流程工作。
				this.showStatusIndicator(
					// 共享RetryStatusIndicator只是显示事件给的次数/延迟，不把普通Session.retryAttempt当摘要计数。
					new RetryStatusIndicator(this.ui, event.attempt, event.maxAttempts, event.delayMs),
				);
				// 请求错误和倒计时可见，不自行睡眠后重发摘要。
				this.ui.requestRender();
				// 结束计划事件，重试何时开始由后续会话事件通知。
				break;
			}

			// 下一次摘要请求将开始，撤倒计时并按来源换回分支摘要或压缩动画。
			case "summarization_retry_attempt_start": {
				// kind过滤只清retry，不影响可能已接手的其他状态。
				this.clearStatusIndicator("retry");
				// source判别联合为branchSummary时，该分支没有reason字段，因此用专门分支摘要指示器。
				if (event.source === "branchSummary") {
					// 只创建分支摘要工作显示，不调用generateBranchSummary或导航函数。
					this.showStatusIndicator(new BranchSummaryStatusIndicator(this.ui));
				} else {
					// 其余合法source为compaction，决定是否用当前编辑器边框统一着色。
					// 嵌入色回调延迟读取当前editor，不复制旧颜色结果。
					// 非嵌入交组件自己的默认颜色。
					const colorFn = isEmbeddedStatus(this.editor)
						? (text: string) =>
								// 有编辑器borderColor优先，缺省按当前思考级别/off回主题。
								(this.editor.borderColor ?? theme.getThinkingBorderColor(this.session.thinkingLevel || "off"))(
									// 实际文字text传给选出的颜色函数，仍无业务摘要操作。
									text,
								)
						: undefined;
					// 该source分支TS已保证有reason，按manual/threshold/overflow显示，不靠断言硬读不存在字段。
					this.showStatusIndicator(new CompactionStatusIndicator(this.ui, event.reason, colorFn));
				}
				// 请求下一轮摘要开始的显示，不实施重试网络策略。
				this.ui.requestRender();
				// 结束attempt_start事件，后续结果按压缩/树原流程发回。
				break;
			}

			// 摘要重试协调结束只清retry类状态，压缩/分支摘要本身的结束显示由其他路径负责。
			case "summarization_retry_finished": {
				// 若当前已不是retry，过滤条件会保留它，不强制清所有工作动画。
				this.clearStatusIndicator("retry");
				// 请求重绘最终状态，不在此显示一条通用“摘要成功”结论。
				this.ui.requestRender();
				// 退出case，未列的事件自然通过switch结束方法。
				break;
			}
		}
	}

	/** Extract text content from a user message */
	// 从标准Message提取user角色的文字并相邻拼接，非user返回空串；例两个text块A/B得到AB，图片块被忽略。
	// 纯读取不改消息、不加分隔换行或trim，也不解析附件；字符串content直接包装成临时text块以复用后面映射。
	private getUserMessageText(message: Message): string {
		// 先按role收窄，避免把助手/工具输出误当输入历史文字。
		if (message.role !== "user") return "";
		// 局部textBlocks接统一数组形式，下面不需要重复两种content结构。
		// 字符串包为单个新对象，保留原文字，空串最后仍返回空串。
		// 块数组只过滤type严格text，注解{type:string}描述回调最低字段，未深检查text实际形状。
		const textBlocks =
			// typeof在字符串/块数组联合中分支，不是完整消息schema验证。
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		// as向TS说明每个留下块有text，运行时不生成检查；join("")紧邻拼接，原块间没有新增空白。
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/** Show a managed-tool status update in the chat. */
	// 显示托管fd/rg准备进度，返回void；第一次前留空行，以后每条独立追加，不像普通showStatus合并相邻状态。
	// 只投影ToolStatus文字/等级，不下载工具；会重置普通状态行跟踪，避免下一条showStatus误把工具进度当自己可替换的上一行。
	private showManagedToolStatus(status: ToolStatus): void {
		// 这一实例第一次托管工具状态才加起始空白，后续不会每项重复。
		if (!this.managedToolStatusStarted) {
			// 聊天区加一行Spacer，和此前启动内容分开。
			this.chatContainer.addChild(new Spacer(1));
			// 记录已经开始工具状态区，不按fd与rg分别开一次。
			this.managedToolStatusStarted = true;
		}
		// warning前加Warning:原文，info直接沿用status.message，不改变原status对象。
		const message = status.type === "warning" ? `Warning: ${status.message}` : status.message;
		// 按等级选warning或dim色，颜色名字符串推断供theme.fg使用。
		const color = status.type === "warning" ? "warning" : "dim";
		// 每次新建独立ThemedText，闭包捕获本次局部message/color，主题变化后仍保留这条自己的文字。
		this.chatContainer.addChild(new ThemedText(() => theme.fg(color, message), 1, 0));
		// 清普通状态Spacer跟踪，下一条普通状态会建新行。
		this.lastStatusSpacer = undefined;
		// 清普通状态Text跟踪，与工具行不复用；未在此清lastStatusMessage字段。
		this.lastStatusText = undefined;
		// 请求绘制新进度，不等下载动作或文件写入完成。
		this.ui.requestRender();
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	// 向聊天显示普通状态，若最后两个子项正好是自己保存的Spacer/Text就更新该Text，否则新建一对，返回void；例连续两条“加载中/完成”可共用一行。
	// 会修改聊天树/lastStatusMessage并请求帧，不保存Session消息；新建Text回调读同一个this.lastStatusMessage字段，旧行以后被invalidate重建也可能读最新文字，不是独立不可变历史快照。
	private showStatus(message: string): void {
		// 取得当前children原数组引用，下面只读取末尾身份，真正增删仍交addChild。
		const children = this.chatContainer.children;
		// 有孩子才取最后项，否则undefined，不用负索引假定总有一行。
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		// 至少两项才取倒数第二项，供验证完整Spacer/Text配对。
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		// 必须两项都存在且引用分别等于本实例上次记录，才能判“紧邻状态”；任何别的组件插入都阻止这次合并。
		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			// 更新共享文案字段，不重新构造ThemedText。
			this.lastStatusMessage = message;
			// 让保存Text下次render重算回调内容/颜色，旧显示缓存不继续保留上条文字。
			this.lastStatusText.invalidate();
			// 请求一帧展现合并后的状态。
			this.ui.requestRender();
			// 已更新旧行就不再追加新Spacer/Text，避免同一条状态显示两次。
			return;
		}

		// 不满足相邻配对条件时建新的消息间隔组件。
		const spacer = new Spacer(1);
		// 先写文案字段，下面新闭包并没有捕获独立message局部值。
		this.lastStatusMessage = message;
		// 延迟回调每次读this.lastStatusMessage，因此与showManagedToolStatus捕获局部message的行为不同；只负责显示弱色文字。
		const text = new ThemedText(() => theme.fg("dim", this.lastStatusMessage), 1, 0);
		// 先把新Spacer加到聊天，保证后面相邻合并能识别二元配对。
		this.chatContainer.addChild(spacer);
		// 再加Text作为当前最后子项。
		this.chatContainer.addChild(text);
		// 保存新Spacer对象引用，下次检查按===身份比较而非内容。
		this.lastStatusSpacer = spacer;
		// 保存新Text引用，只有这个“最近一对”能被紧邻合并逻辑匹配。
		this.lastStatusText = text;
		// 请求显示新行，不输出到stdout或写JSONL。
		this.ui.requestRender();
	}

	// 将自定义状态条目交扩展entry renderer显示，返回void；没有renderer或它最终没有组件时略过，有当前流式回复则尽量插在其前面。
	// 例工具写入状态说明，插到正在生成的助手正文之前以稳定显示位置；构造/展开可调用renderer不止一次，组件只把同步renderer失败转错误卡片，未来render异常仍可传播。
	// 这里只建/插组件，不让custom状态条目参与模型上下文，也不在本方法requestRender，调用方安排。
	private addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void {
		// 按customType取首个注册EntryRenderer引用，不执行扩展命令或扫描文件。
		const renderer = this.session.extensionRunner.getEntryRenderer(entry.customType);
		// 未注册显示器就保留条目仅供状态/程序使用，不强制JSON打印。
		if (!renderer) {
			// 提前return不加空行或空卡片。
			return;
		}
		// CustomEntryComponent构造立即尝试renderer，传当前outputPad只用于其错误兜底卡片。
		const component = new CustomEntryComponent(entry, renderer, this.outputPad);
		// 同步全局展开偏好；若从默认false变true会再调用renderer，不保证每条仅渲染一次。
		component.setExpanded(this.toolOutputExpanded);
		// hasContent只检查有没有保存组件，不检查组件render是否真的有可见行。
		if (!component.hasContent()) {
			// 没组件就不挂聊天，不为这条留下多余消息Spacer。
			return;
		}

		// 正在跟踪助手流组件时优先查它在聊天中的实际位置。
		if (this.streamingComponent) {
			// indexOf按同一组件身份找索引，不按消息时间排序。
			const streamingIndex = this.chatContainer.children.indexOf(this.streamingComponent);
			// 找到且索引非负，才能原位插入到前面。
			if (streamingIndex >= 0) {
				// splice(index,0,component)只插入不删除，让当前流组件向后移动一格。
				this.chatContainer.children.splice(streamingIndex, 0, component);
				// 插入成功就结束，不又在末尾追加同一对象。
				return;
			}
		}

		// 没有可用流式位置时正常追加末尾，组件自己的消息间隔也随之显示。
		this.chatContainer.addChild(component);
	}

	// 把一条应用层AgentMessage变成聊天组件，返回void；按role处理Bash、custom、两类摘要、user、assistant，system/toolResult不在此直接显示。
	// 例如user文字识别完整skill包装后分开显示技能卡片和用户补充；仅有图片没有text时本函数用户分支不会建文字/图片行。
	// 这里只渲染已有记录，不重新执行历史Bash/工具/模型；构造可能运行扩展显示回调/启动再停止Loader，populateHistory可修改当前编辑器历史。
	private addMessageToChat(
		// AgentMessage包含应用扩展角色，不只API支持的system/user/assistant/toolResult。
		message: AgentMessage,
		// 可选populateHistory仅供user文字，messageId/timestamp供Markdown变换上下文；元信息不在这里写回会话。
		options?: { populateHistory?: boolean; messageId?: string; timestamp?: string },
		// 返回void，调用者按组件树变化观察结果，不得到新消息对象。
	): void {
		// 按role判别联合缩窄各分支字段，末尾never赋值只在TS开发期检查遗漏。
		switch (message.role) {
			// Bash历史是应用bashExecution角色，不伪造成模型toolCall/toolResult。
			case "bashExecution": {
				// 构造Bash显示卡片，先会建立运行Loader，再马上用历史完成信息停动画；不会执行message.command。
				const component = new BashExecutionComponent(
					// 命令文字只用于标题/显示，未传给spawn。
					message.command,
					// ui供Loader/显示刷新，使用当前稳定入口。
					this.ui,
					// excludeFromContext在组件内决定弱色等显示，真正模型过滤由消息转换层负责。
					message.excludeFromContext,
					// 输出边距沿用当前设置，而不是历史时保存的一份UI边距。
					this.outputPad,
				);
				// 输出真值才喂给组件，空串仍会显示命令/完成状态而没有正文。
				if (message.output) {
					// appendOutput去ANSI/规范换行并累计文本，不读取fullOutputPath文件补全被截断部分。
					component.appendOutput(message.output);
				}
				// 用历史结束信息设置显示终态并停Loader，不等待任何真实进程close。
				component.setComplete(
					// 退出码可能undefined，组件现有规则缺码也可显示complete，不能据此证明命令成功。
					message.exitCode,
					// 取消标记在显示终态判定中优先于非零退出码。
					message.cancelled,
					// 历史仅有truncated布尔时合成这个最小对象并as完整TruncationResult；断言不补齐其它字段/运行时数据。
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					// 全文文件路径只作提示文字，不在该组件里打开/读取。
					message.fullOutputPath,
				);
				// 把完成卡片加入聊天，未调用setExpanded，所以此Bash历史分支沿组件默认折叠，不自动跟随toolOutputExpanded。
				this.chatContainer.addChild(component);
				// 结束Bash显示，不进入普通文本/助手分支。
				break;
			}
			// custom角色与前面custom会话状态条目不是同一类型，这里可用自定义消息renderer或默认卡片。
			case "custom": {
				// display为真才展示，false只是UI隐藏偏好，不保证消息不送模型。
				if (message.display) {
					// 按customType读消息renderer引用，后面组件实际构造时可能调用它。
					const renderer = this.session.extensionRunner.getMessageRenderer(message.customType);
					// 创建自定义消息显示，renderer缺省/同步失败可由组件退默认Markdown，不在这里执行命令handler。
					const component = new CustomMessageComponent(
						// 传原消息引用，details业务结构由扩展renderer理解。
						message,
						// renderer可undefined，组件知道如何回默认显示。
						renderer,
						// 默认正文样式取当前主题+代码缩进，扩展自己渲染可采用不同样式。
						this.getMarkdownThemeWithSettings(),
						// 水平留白交组件/扩展选项，不是截断预算。
						this.outputPad,
					);
					// 同步展开偏好，自定义renderer可因此再次重建；默认卡片不因expanded标记自动折叠全部正文。
					component.setExpanded(this.toolOutputExpanded);
					// 把组件追加到聊天，隐藏custom不建立此对象。
					this.chatContainer.addChild(component);
				}
				// custom无论display真假都结束这个case，不落到普通user显示。
				break;
			}
			// compactionSummary为已有摘要的应用角色，展示卡片，不在此压缩上下文。
			case "compactionSummary": {
				// 摘要卡片前另加一行间隔。
				this.chatContainer.addChild(new Spacer(1));
				// 创建压缩摘要组件，消费已有summary/tokensBefore等字段。
				const component = new CompactionSummaryMessageComponent(
					// 传原消息，不在UI重新生成摘要文本。
					message,
					// Markdown样式取当前设置，而非原压缩时的主题。
					this.getMarkdownThemeWithSettings(),
					// 当前outputPad控制左右留白。
					this.outputPad,
				);
				// 摘要组件支持全局展开标记，展开不恢复原先被摘要替代的全部历史。
				component.setExpanded(this.toolOutputExpanded);
				// 加到聊天末尾，外层调用者决定它在前后保留内容间的位置。
				this.chatContainer.addChild(component);
				// 结束压缩摘要显示，费用提示由独立合成item处理。
				break;
			}
			// branchSummary为分支导航的已有摘要，类型与压缩检查点显示分开。
			case "branchSummary": {
				// 在分支摘要卡片前留空行。
				this.chatContainer.addChild(new Spacer(1));
				// 创建分支摘要组件，不再调用模型总结离开分支。
				const component = new BranchSummaryMessageComponent(
					// 传消息原引用，包含summary/fromId等应用字段。
					message,
					// 沿当前Markdown显示设置，不改摘要正文。
					this.getMarkdownThemeWithSettings(),
					// 传当前留白，布局和模型token数无关。
					this.outputPad,
				);
				// 按共享展开偏好显示折叠/完整摘要。
				component.setExpanded(this.toolOutputExpanded);
				// 追加分支摘要卡片，实际树导航/保存已由Session完成。
				this.chatContainer.addChild(component);
				// 离开此分支，不把摘要当普通用户原话。
				break;
			}
			// system消息通常只用于模型/状态检查点，不在聊天区显示系统提示全文。
			case "system":
				// 直接略过，不加占位或普通消息组件。
				break;
			// 用户角色先只提取文字块，图片不由这个分支单独显示。
			case "user": {
				// 标准Message助手按文本/块数组格式取文字，多个text块无分隔拼接。
				const textContent = this.getUserMessageText(message);
				// 文字真值才继续，只有图片或空字符串时也不会populateHistory。
				if (textContent) {
					// 已有聊天组件才在用户行前留空行，空聊天不多加前置Spacer。
					if (this.chatContainer.children.length > 0) {
						// 消息间隔是UI组件，不写入会话历史。
						this.chatContainer.addChild(new Spacer(1));
					}
					// 严格解析完整skill包装字符串，失败就按普通用户文字显示；不是通用XML解析器或读技能文件。
					const skillBlock = parseSkillBlock(textContent);
					// 只有符合包装形状才拆技能卡片与尾部用户补充，不凭/skill前缀猜。
					if (skillBlock) {
						// Render skill block (collapsible)
						// 技能调用组件只展示已解析name/content等，location字段不触发重新读文件。
						const component = new SkillInvocationMessageComponent(
							// 传完整ParsedSkillBlock，用户补充下面另处理，组件自身只画技能部分。
							skillBlock,
							// 技能正文展开使用当前Markdown样式。
							this.getMarkdownThemeWithSettings(),
							// 传输出左右留白，卡片内部另有自身纵向留白。
							this.outputPad,
						);
						// 按共享展开标记显示技能正文/折叠标签，不执行技能指令。
						component.setExpanded(this.toolOutputExpanded);
						// 技能卡片先加入聊天，补充用户问题随后另画。
						this.chatContainer.addChild(component);
						// Render user message separately if present
						// 解析后尾部userMessage经trim且真值才建第二个组件。
						if (skillBlock.userMessage) {
							// 技能卡片与用户补充之间留一行。
							this.chatContainer.addChild(new Spacer(1));
							// 补充问题使用普通UserMessageComponent，便于与技能上下文视觉区分。
							const userComponent = new UserMessageComponent(
								// 只传包装之后的userMessage，不把技能正文重复画一遍。
								skillBlock.userMessage,
								// 用户正文Markdown样式按当前设置。
								this.getMarkdownThemeWithSettings(),
								// 左右留白和其他用户消息一致。
								this.outputPad,
								// 用户文字也可走内置Mermaid/扩展显示变换器，不限助手正文。
								this.getMarkdownTransformers(),
								// 可选会话条目ID传给Markdown显示上下文，不是新建一个Session条目。
								options?.messageId,
								// 可选原条目ISO时间同样传给显示变换器，缺省保持undefined。
								options?.timestamp,
							);
							// 把补充问题接在技能卡片后，不自动再次提交。
							this.chatContainer.addChild(userComponent);
						}
					} else {
						// 非skill包装的普通文字直接构造用户显示组件。
						const userComponent = new UserMessageComponent(
							// 使用已拼好的全部textContent，未在本方法trim普通用户文字。
							textContent,
							// Markdown样式取当前主题+代码缩进。
							this.getMarkdownThemeWithSettings(),
							// 传当前显示边距，不改消息内容。
							this.outputPad,
							// 提供当前Markdown变换器列表，实际转换到渲染时才发生。
							this.getMarkdownTransformers(),
							// 元信息来自可选options，与原消息timestamp数值字段不是自动互换。
							options?.messageId,
							// 条目时间作为字符串透传，不在这里生成当前时间。
							options?.timestamp,
						);
						// 普通用户组件追加聊天，不涉及图片附件解码/上传。
						this.chatContainer.addChild(userComponent);
					}
					// 仅显式populateHistory真值时将文字放编辑器历史，普通实时start调用未传此选项。
					if (options?.populateHistory) {
						// 记完整textContent，skill包装也仍是包装全文而非只记尾部userMessage；当前编辑器无历史能力就跳过。
						this.editor.addToHistory?.(textContent);
					}
				}
				// 结束用户分支，图片独有输入不会在这里被转成默认文本占位。
				break;
			}
			// 助手历史直接创建已完成显示组件，工具调用行另由renderSessionItems遍历content处理。
			case "assistant": {
				// 创建助手显示器，不保存到streamingComponent当前流槽。
				const assistantComponent = new AssistantMessageComponent(
					// 初始消息已给出，构造会按默认非流式状态填显示。
					message,
					// 按本实例当前思考显示偏好，不重放历史时用户曾单段点击的局部覆盖。
					this.hideThinkingBlock,
					// 用当前Markdown主题与缩进。
					this.getMarkdownThemeWithSettings(),
					// 隐藏思考占位用当前label，未从会话文件读取原UI标签。
					this.hiddenThinkingLabel,
					// 传当前输出边距。
					this.outputPad,
					// 变换器可在最终显示状态转换正文/思考，不在这里改保存内容。
					this.getMarkdownTransformers(),
					// 会话条目ID作为可选转换上下文。
					options?.messageId,
					// 对应条目时间同样可缺，未自动退回message.timestamp。
					options?.timestamp,
				);
				// 加入助手文字组件，工具行随后由外层按调用块另追加。
				this.chatContainer.addChild(assistantComponent);
				// 不在本助手分支再次处理toolResult匹配。
				break;
			}
			// 独立toolResult不另建普通聊天卡片，避免与已有工具行重复。
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				// 留给renderSessionItems按toolCallId匹配结果，不执行该工具。
				break;
			}
			// default用于开发期联合穷尽检查，不是对外部JSON角色的运行时错误分支。
			default: {
				// 把message赋never让TS在漏掉已知role时报错；编译后只是普通const赋值，类型外角色实际落到这里也不会自动throw。
				const _exhaustive: never = message;
			}
		}
	}

	// 按顺序把混合RenderSessionItem追加到聊天，返回void；custom/usage/费用分别处理，助手文字外再建工具行，toolResult按ID回填此前工具行。
	// 例如assistant(toolCall id1)后接toolResult(id1)，显示同一行最终输出；只做历史显示不再次执行工具/模型，扩展显示回调仍可运行。
	// 每次调用先清this.pendingTools并新建本次局部匹配表，只有本批未匹配调用结束后回存；多次分段调用不是共享未完成工具的连续扫描。
	// 缓存提示另从SessionManager全部entries重推，非只扫描items/当前树分支，且miss表以原消息对象身份为键；不保证与深拷贝消息匹配。
	private renderSessionItems(
		// readonly数组限制通过此参数改列表，元素/消息对象未深冻结，显示器仍保存部分引用。
		items: readonly RenderSessionItem[],
		// 可选Map按消息对象引用附条目id/时间，不按文字内容或provider/model查元数据。
		messageMeta?: Map<AgentMessage, { id: string; timestamp: string }>,
		// 默认空选项，updateFooter/populateHistory都需真值才执行对应附加行为。
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
		// 返回void，显示结果留在chatContainer，方法不会先清整个聊天区。
	): void {
		// 抛弃先前的待工具索引，已在聊天树的旧组件不会因此自动移除或dispose。
		this.pendingTools.clear();
		// 为这次items创建局部ID表，工具结果只能匹配本次此前登记的调用。
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();
		// Cache misses are not persisted, unlike successful cache-warming usage.
		// Re-derive them and inject them after the assistant messages that paid for them.
		// 显示缓存提示开启才重新计算，关闭则用新空Map避免扫描。
		// 扫描全部追加条目而非getBranch，传当前ModelRuntime借价格目录估算额外费用，不探测真实供应商缓存。
		// 空Map的泛型给键/值类型，未保存到共享缓存，当前调用无提示可查。
		const cacheMisses = this.settingsManager.getShowCacheMissNotices()
			? collectCacheMisses(this.sessionManager.getEntries(), this.session.modelRuntime)
			: new Map<AssistantMessage, CacheMiss>();

		// 明确updateFooter真值才刷新页脚/边框，普通局部渲染不强制做这一步。
		if (options.updateFooter) {
			// 页脚失效等后续渲染时重读会话统计。
			this.footer.invalidate();
			// 边框按当前级别/模式更新，不改变选中模型。
			this.updateEditorBorderColor();
		}

		// 按items给定顺序遍历，没有按timestamp重新排序。
		for (const item of items) {
			// 类型谓词识别持久化custom状态条目，与Agent custom消息区分。
			if (isCustomSessionEntry(item)) {
				// 用扩展entry renderer显示，可能无内容略过。
				this.addCustomEntryToChat(item);
				// custom条目不再当消息读取role/content。
				continue;
			}
			// usage条目统一走本方法的预热显示助手；此谓词只看type，不在这里再核kind。
			if (isUsageSessionEntry(item)) {
				// 按预热文案格式显示传入UsageEntry；正常renderSessionEntries上游只把kind=cache_warm放进这条路径，直接其他调用者传别kind不会在此被再次过滤。
				this.addCacheWarmingUsage(item);
				// 用量记录不作为普通模型消息渲染。
				continue;
			}
			// 合成compaction_cost记录没有role，需先从联合中区分。
			if (isCompactionCostNotice(item)) {
				// 显示摘要token/费用，仍受缓存提示显示设置控制。
				this.addCompactionCostNotice(item);
				// 费用显示不触发额外模型摘要或写SessionEntry。
				continue;
			}

			// 前三种类型排除后item在TS中缩窄为AgentMessage，后面可以按role访问。
			const message = item;
			// Assistant messages need special handling for tool calls
			// 助手内容需要另外提取toolCall，单纯addMessageToChat只画文字/思考。
			if (message.role === "assistant") {
				// 按对象身份取这条助手的存储元信息，缺Map或缺键均undefined。
				const meta = messageMeta?.get(message);
				// 先追加助手文字显示，下面工具行随后接在聊天里。
				this.addMessageToChat(message, {
					// 条目id缺省时不伪造一个，交Markdown转换器可选上下文。
					messageId: meta?.id,
					// 时间同样沿meta，不自动改成当前墙钟。
					timestamp: meta?.timestamp,
				});
				// Render tool call components
				// 遍历助手完整content，多个调用每个有自己的显示行。
				for (const content of message.content) {
					// 只有toolCall建行，其他块已由助手组件处理。
					if (content.type === "toolCall") {
						// 新工具显示对象不是执行器，也不会因重放历史再次运行命令。
						const component = new ToolExecutionComponent(
							// 工具名决定renderer/标题。
							content.name,
							// 本次调用ID用于局部表配对结果。
							content.id,
							// 保存历史arguments引用，未在UI重新schema验证。
							content.arguments,
							// 构造显示选项，与真正工具调用的执行参数分开。
							{
								// 图片显示偏好取当前设置，不读取历史UI偏好。
								showImages: this.settingsManager.getShowImages(),
								// 当前图片最大列宽控制结果展示。
								imageWidthCells: this.settingsManager.getImageWidthCells(),
								// 水平边距同样使用当前实例值。
								outputPad: this.outputPad,
							},
							// 可运行扩展resolver链取显示方法，然后用内置方法补缺槽，不执行工具定义的execute。
							this.getRegisteredToolDefinition(content.name),
							// 给组件稳定TUI用于刷新。
							this.ui,
							// 当前会话cwd给路径显示，不以历史消息提供的任意cwd覆盖。
							this.sessionManager.getCwd(),
						);
						// 工具行按全局展开偏好重建，不从历史文件恢复每行用户曾点击的局部展开状态。
						component.setExpanded(this.toolOutputExpanded);
						// 先追加工具行，后面再根据助手是否失败决定显示结果/登记等待表。
						this.chatContainer.addChild(component);

						// 历史助手aborted/error时工具调用直接画错误提示，不等待后来同IDtoolResult覆盖本次局部表。
						if (message.stopReason === "aborted" || message.stopReason === "error") {
							// 声明必赋错误文字，各停止原因分支都会赋值。
							let errorMessage: string;
							// 取消文案走专门分支，不沿普通errorMessage。
							if (message.stopReason === "aborted") {
								// 读当前Session.retryAttempt，而非该历史消息专属重试次数；恢复历史时这个计数可能与当时不同。
								const retryAttempt = this.session.retryAttempt;
								// 根据当前计数选择显示文字，不修改历史message.errorMessage。
								// 按次数选择单/复数s，不从工具个数计算。
								// 零计数使用固定Operation aborted。
								errorMessage =
									// 大于0才附“若干次重试后取消”。
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								// 普通错误用历史errorMessage真值或Error兜底。
								errorMessage = message.errorMessage || "Error";
							}
							// 合成text错误结果仅改组件，不写新toolResult、不追加原部分输出。
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							// 其余停止原因（含length）把工具行存局部等待表，未在此调用setArgsComplete或markExecutionStarted。
							renderedPendingTools.set(content.id, component);
						}
					}
				}
				// 只有非取消/非错误助手才尝试补缓存未命中提示，不把报错请求也在这段显示同类提醒。
				if (message.stopReason !== "aborted" && message.stopReason !== "error") {
					// miss表按当前message对象身份查，文字相同的新对象不能命中。
					const miss = cacheMisses.get(message);
					// 有估算miss还会经过addCacheMissNotice的显著性阈值，不保证一定生成行。
					if (miss) this.addCacheMissNotice(miss);
				}
				// 工具结果不走addMessageToChat，它需要和先前调用共享一行。
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				// 按toolCallId查本次局部表，不搜索聊天所有旧工具组件。
				const component = renderedPendingTools.get(message.toolCallId);
				// 有已登记行才应用结果，没有前置调用/失败调用被排除时这条结果在本次显示里略过。
				if (component) {
					// 传标准结果整体替换组件结果，默认isPartial:false；不执行/读取工具输出文件。
					component.updateResult(message);
					// 匹配完成从局部等待表删，最后不会再加入this.pendingTools。
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				// 其它消息也按对象引用找元信息，custom应用消息可能由转换器新建后在Map登记。
				const meta = messageMeta?.get(message);
				// 通用显示处理Bash/custom/摘要/system/user，不在这里为每类重复建组件。
				this.addMessageToChat(message, {
					// 展开选项使populateHistory传下去，updateFooter额外字段由callee忽略；不因对象展开自动校验/过滤字段。
					...options,
					// 随后显式写messageId，覆盖可能存在的同名扩展字段。
					messageId: meta?.id,
					// timestamp同样以当前meta为准，缺省undefined会覆盖同名旧值。
					timestamp: meta?.timestamp,
				});
			}
		}

		// 扫完本批仍没结果的调用留下待执行显示，按Map保留顺序回存。
		for (const [toolCallId, component] of renderedPendingTools) {
			// 存到本实例pendingTools，后续实时工具事件可据ID继续更新；不是在此自动启动这些历史调用。
			this.pendingTools.set(toolCallId, component);
		}
		// 整个批次渲染后请求一帧，不等待所有工具组件未来异步图片/预览工作。
		this.ui.requestRender();
	}

	/**
	 * Render session entries to chat. Used for initial load and rebuild after compaction.
	 * @param entries Compaction-aware session entries to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	// 把已选会话条目转换成混合显示项再统一渲染，返回void；例compaction可贡献系统状态/摘要消息并附费用提示，custom状态直接交renderer。
	// 会清全屏文本选区、创建消息元信息Map，并通过renderSessionItems重建待工具索引/追加聊天；本方法自己不先clear聊天，也不选择当前分支。
	// sessionEntryToContextMessages逐条转换不是完整模型投影，不在这里应用context_edit改写/隐藏所有原文；调用方先用buildContextEntries做压缩感知条目选择。
	private renderSessionEntries(
		// entries是待显示的条目数组，可是完整当前上下文或边界前后两段，方法不按文件顺序再自动补其他条目。
		entries: SessionEntry[],
		// 选项默认空，不自动更新页脚或填历史，初次加载会显式开这两项。
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
		// 返回void，转换后消息对象仅供UI/元信息索引，不发供应商请求。
	): void {
		// Selection coordinates point into the transcript being replaced (#9311).
		// 全屏选区坐标指旧转录，重建前清掉避免指向错误文字；普通屏不调用此专用能力。
		if (this.renderer instanceof TuiAltScreen) this.renderer.resetTextSelection();
		// Map以AgentMessage对象为键，存其原条目id与字符串时间，可能多条消息映射到同一条目。
		const messageMeta = new Map<AgentMessage, { id: string; timestamp: string }>();
		// flatMap将每条返回的零/多显示项摊平一层，按输入条目顺序排列。
		const items = entries.flatMap((entry): RenderSessionItem[] => {
			// 普通custom和预热usage直接保留原条目对象；其他kind的usage不走此快捷分支。
			if (entry.type === "custom" || (entry.type === "usage" && entry.kind === "cache_warm")) {
				// 用单元素数组让flatMap保留这一条，而不是把它转换为模型消息。
				return [entry];
			}
			// 共享转换器可把普通消息原样返回、补缺content或包装custom/摘要，标签/独立用量/context_edit等本身返回[]。
			const messages = sessionEntryToContextMessages(entry);
			// 每个转换出的消息分别登记元信息，压缩带systemMessage时同条目可有两条消息。
			for (const msg of messages) {
				// 对象引用作键，因此随后addMessageToChat/renderer可查回id/时间，不依赖消息JSON相等。
				messageMeta.set(msg, { id: entry.id, timestamp: entry.timestamp });
			}
			// 只有两类摘要条目、带usage且至少转换出一条消息才附费用；空分支摘要即使有usage也可能不显示。
			if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage && messages.length > 0) {
				// 先放该条目的全部消息，再加合成费用项，kind保留原compaction/branch_summary字符串，类型由条件缩窄。
				return [...messages, { type: "compaction_cost", kind: entry.type, usage: entry.usage }];
			}
			// 其他条目只返回转换消息，[]自然不会产生聊天项。
			return messages;
		});
		// 将混合项、元信息与选项交统一历史渲染，缓存估算/工具结果匹配仍遵循该方法自己的扫描边界。
		this.renderSessionItems(items, messageMeta, options);
	}

	// 显示已记录缓存预热费用，返回void；例开启提示时加“Cache warmed: $...”一行，不再发起预热。
	// 本方法签名允许任意UsageEntry，未检查kind；正常调用方只送cache_warm，显示设置关闭直接略过。
	private addCacheWarmingUsage(entry: UsageEntry): void {
		// 与缓存未命中共用一个显示设置，不另有独立cache-warming提示开关。
		if (!this.settingsManager.getShowCacheMissNotices()) return;
		// 预热费用说明前加一行Spacer。
		this.chatContainer.addChild(new Spacer(1));
		// 辅助格式器使用记录cost.total和可选note，保留至少3位小数的显示规则，不在这里按目录重算价格。
		const usage = formatCacheWarmingUsage(entry);
		// ThemedText只延迟dim颜色，usage字符串已在本次调用格式化，后续修改entry不会自动重新算这份字符串。
		this.chatContainer.addChild(new ThemedText(() => theme.fg("dim", usage), 1, 0));
	}

	/**
	 * Render billing usage for a compaction or branch summary. The notice is derived
	 * from persisted summary usage and is not stored as a separate session entry.
	 */
	// 展示压缩/分支摘要已记录的用量提示，返回void；例四桶合计20k且费用0.02可显示约$0.02。
	// 仅由Usage分量相加和已有cost格式化，不核对供应商真实账单，也不作为独立条目保存；显示门禁仍是ShowCacheMissNotices。
	private addCompactionCostNotice(notice: CompactionCostNotice): void {
		// 关闭显示设置即不加空行/费用卡片，压缩实际执行与保存不受此开关影响。
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		// 解构取原Usage引用，不深复制内部cost。
		const { usage } = notice;
		// 总token把普通输入、输出、缓存读、缓存写相加，不用tokensBefore或自动去除缓存桶。
		const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		// cost.total至少0.01才显示两位小数约价，否则省金额；toFixed是展示舍入，不证明分项相加精确等于账单。
		const cost = usage.cost.total >= 0.01 ? ` (~$${usage.cost.total.toFixed(2)})` : "";
		// 仅kind精确compaction用Compaction标签，另一个已知分支用Branch summary。
		const label = notice.kind === "compaction" ? "Compaction" : "Branch summary";
		// 提示前空行，不修改Session的消息顺序。
		this.chatContainer.addChild(new Spacer(1));
		// 创建延迟主题文本追加聊天，下面字符串读本次计算的局部值。
		this.chatContainer.addChild(
			// token用紧凑k/M格式，原英文tokens billed沿用；实际数据是存储Usage/费用估计，不由这行重新确认扣费。
			new ThemedText(() => theme.fg("warning", `${label}: ${formatTokens(tokens)} tokens billed${cost}`), 1, 0),
		);
	}

	// 统计一条助手诊断里标记thinking_dropped的转换记录数，返回number；例同一诊断transformations有两项匹配就加2。
	// 只按诊断类型/动态JSON字段检查计数，不解析真实thinking正文、不去重记录、不核实提供商是否真的删过某段；static表示通过类调用，不依赖实例状态。
	private static countDroppedThinkingBlocks(message: AssistantMessage): number {
		// 局部计数从0开始，每次调用重新扫描而非全局累计。
		let count = 0;
		// 缺diagnostics用空数组，保持诊断顺序但只关心总数。
		for (const diagnostic of message.diagnostics ?? []) {
			// 只处理Anthropic输入转换诊断，其它错误/重试信息不计入。
			if (diagnostic.type !== "anthropic_input_transformations") continue;
			// details可缺，transformations是动态JsonValue，不能因TS外层诊断类型就当数组。
			const transformations = diagnostic.details?.transformations;
			// 数组形状才遍历，字符串/对象/null等跳过，未完整校验每个转换记录。
			if (!Array.isArray(transformations)) continue;
			// filter统计符合条件的项数，再加到count；不是修改原transformations数组。
			count += transformations.filter(
				// 每项可能是JSON标量/数组/对象，下面先检查再读type。
				(transformation) =>
					// 要求typeof为object，排除字符串/数字/布尔等；数组也属于object，未在此额外排除。
					typeof transformation === "object" &&
					// 再排除null，因为typeof null同样为object。
					transformation !== null &&
					// as只允许TS索引type，真正判定是属性严格等thinking_dropped，不检查其余字段或是否自有属性。
					(transformation as Record<string, unknown>).type === "thinking_dropped",
				// 取筛选后长度作为本诊断贡献，重复相同记录也逐项计数。
			).length;
		}
		// 返回本消息总计，没有副作用/输出。
		return count;
	}

	// 当本次thinking_dropped数量比当前分支最近助手更多时追加提示，返回void；例上条1、本条3，显示3而非差值2。
	// 与缓存提示共用设置，向后找最近任何assistant，不另按模型/供应商筛；正常已初始化message_end调用早于本条保存，所以预期找到上条。
	// 若异步初始化让保存先发生，这个前提可能不成立；本方法本身不按对象身份排除当前消息，也不恢复被丢思考内容。
	private maybeShowThinkingDropNotice(message: AssistantMessage): void {
		// 关闭提示设置直接省略，真实诊断仍留在消息中。
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		// 用静态扫描器统计当前消息标记，不读取模型签名字节。
		const droppedCount = InteractiveMode.countDroppedThinkingBlocks(message);
		// 本条0就无须回溯历史，避免显示无变化提示。
		if (droppedCount === 0) return;

		// 没有上一条助手时比较基数默认0。
		let previousDroppedCount = 0;
		// message_end reaches the UI before the current message is persisted,
		// so the branch's last assistant message is the previous response.
		// 取当前叶子的完整branch，不是全部文件记录或压缩裁剪后的显示上下文。
		const branch = this.sessionManager.getBranch();
		// 从最后一项往根逆向查，找到最近助手即停止，不按时间戳重新排序。
		for (let i = branch.length - 1; i >= 0; i--) {
			// 读取当前条目引用，后面type/role联合条件收窄。
			const entry = branch[i];
			// 只接受普通message条目中的assistant，摘要/usage等不会作为上条助手。
			if (entry.type === "message" && entry.message.role === "assistant") {
				// 对最近助手也按同一诊断规则计数，未计算累计到整条会话的次数。
				previousDroppedCount = InteractiveMode.countDroppedThinkingBlocks(entry.message);
				// 找到第一条就停，不继续找同模型或同请求链的另一条。
				break;
			}
		}
		// 相等或下降都不提示，只有严格增长才显示，但文案使用本次总量而非增量。
		if (droppedCount <= previousDroppedCount) return;

		// 按当前总数选单复数名词，不按丢弃token量。
		const noun = droppedCount === 1 ? "thinking block" : "thinking blocks";
		// 提示前加一行，未在方法里单独requestRender，外层message_end安排帧。
		this.chatContainer.addChild(new Spacer(1));
		// 用ThemedText构造诊断提醒，不追加真正模型消息。
		this.chatContainer.addChild(
			// 颜色延迟取，数量/名词捕获本次局部结果。
			new ThemedText(
				// 文案指向会话里的details，不在这里展开/发送全部诊断载荷，也不是重新向Anthropic询问。
				() => theme.fg("warning", `Anthropic dropped ${droppedCount} ${noun} (details in session)`),
				// 显示水平边距固定1，区别于一般消息可用outputPad。
				1,
				// 垂直边距0，空行由前面Spacer管理。
				0,
			),
		);
	}

	/**
	 * Show a transcript notice when a completed assistant message paid for a
	 * significant cache miss. Only states observable facts: the miss itself,
	 * a model switch, or an idle gap past the cache TTL.
	 */
	// 对刚完成助手消息检测显著缓存miss并给提示，返回void；例此前有缓存活动，本轮读缓存明显下降时可产生估算记录。
	// 依赖“当前消息尚未包含在entries”的调用时点，正常已初始化message_end满足；只比较相邻请求用量启发式，不对提示词前缀逐token比对，不查询真实缓存/账单。
	private maybeShowCacheMissNotice(message: AssistantMessage): void {
		// 显示设置关闭就完全省扫描/提示，消息usage本身不因此删除。
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		// Entries don't contain `message` yet: message_end fires before persistence.
		// 扫描全部现有条目取最后基准再比较这条message，传ModelRuntime只借价格；若message已在列表里会与自己形成错误基准，本方法不去重。
		const miss = detectCacheMiss(this.sessionManager.getEntries(), message, this.session.modelRuntime);
		// 有被算法计入的miss才交显著性展示阈值，不在此执行重新请求或自动预热。
		if (miss) this.addCacheMissNotice(miss);
	}

	// 把缓存未命中的估算说明追加聊天，返回void；至少20k漏读token或估算额外$0.1才展示，模型变化标签优先于空闲间隔标签。
	// 例模型切换又空闲6分钟时只显示after model switch；标签是线索/启发式，不证明单一原因或真实重计费数，方法不另检查设置也不requestRender，调用者控制。
	private addCacheMissNotice(miss: CacheMiss): void {
		// 两项都低于阈值才return，因此满足任一阈值即可显示；恰好20_000或0.1也不会被这行过滤。
		if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return;

		// 费用至少0.01才显示两位小数约价，金额小但token显著时仍可只显示token。
		const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
		// 用紧凑token数与可选金额构造文案，re-billed沿原英文，值实际来自用量差估算。
		const reBilled = `${formatTokens(miss.missedTokens)} tokens re-billed${cost}`;
		// 默认标签只说Cache miss，不为所有情况猜缓存失效原因。
		let label = "Cache miss";
		// 模型身份变更优先判定，未再要求当前/上一条是同一provider。
		if (miss.modelChanged) {
			// 标明发生在模型切换之后，不断言切换是唯一成因。
			label = "Cache miss after model switch";
			// 无模型变化且idleMs达到固定5分钟阈值才提空闲间隔；该常量不是所有供应商真实TTL配置。
		} else if (miss.idleMs >= CACHE_TTL_MS) {
			// 将毫秒除60000并四舍五入为分钟，基于消息时间戳差，不是实时测量网络断开时长。
			label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
		}
		// 提示前留一空行，不改模型上下文内容。
		this.chatContainer.addChild(new Spacer(1));
		// 延迟warning着色并捕获本次label/reBilled，不保存新的独立UsageEntry。
		this.chatContainer.addChild(new ThemedText(() => theme.fg("warning", `${label}: ${reBilled}`), 1, 0));
	}

	// 把当前压缩感知上下文追加到聊天并填用户输入历史，再按需显示项目未信任/已有压缩次数，返回void。
	// 例如恢复会话先重画摘要/保留消息、工具结果；本方法不先清聊天，重复调用可重复追加，清理由init/重绑/导航调用点安排。
	// 压缩次数统计全部Session条目（可含其它树分支），不只当前显示路径；不再次运行历史工具/模型。
	renderInitialMessages(): void {
		// 选择当前叶子的压缩检查点与保留条目，不等于getEntries全部文件行。
		const entries = this.sessionManager.buildContextEntries();
		// 交统一条目转换/工具匹配显示路径，并明确打开两个附加选项。
		this.renderSessionEntries(entries, {
			// 渲染前失效页脚并更新编辑器边框，便于恢复当前会话显示。
			updateFooter: true,
			// 用户文字加入当前编辑器可选历史，助手/图片独有用户消息不由此填普通文字历史。
			populateHistory: true,
		});
		// 项目未信任且存在需授权资源时添加说明，只提醒不在此授信/重启。
		this.renderProjectTrustWarningIfNeeded();

		// Show compaction info if session was compacted
		// 另外取全条目用来统计压缩记录，不复用上面的当前压缩裁剪列表。
		const allEntries = this.sessionManager.getEntries();
		// 只按type为compaction计数，branch_summary不算，文件里其它树路径的compaction也包含。
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		// 有记录才给统计状态，0不显示“未压缩”。
		if (compactionCount > 0) {
			// 单复数文案按次数，未反映每次节省token量或压缩是否属于当前分支。
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			// 普通showStatus可能与前面连续状态合并，统计不新增持久化会话记录。
			this.showStatus(`Session compacted ${times}`);
		}
	}

	// 在未信任项目确有受控资源时展示重启/授权提醒，返回void；例如cwd/.pi有扩展或祖先.agents/skills触发资源存在检查。
	// 只读设置/本机元数据并追加文字，不执行这些资源、不写信任存储；存在性不代表内容有效，检查范围按信任辅助函数的固定规则。
	private renderProjectTrustWarningIfNeeded(): void {
		// 项目已可信先短路不查资源；否则helper查当前.pi固定入口和祖先非用户全局.agents/skills，不是递归审计整个目录。
		if (this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(this.sessionManager.getCwd())) {
			// 没有提醒条件就不添空行/警告，不把无受控资源解释成已经保存了信任决定。
			return;
		}

		// 已有聊天才加间隔，空聊天从提醒本身开始。
		if (this.chatContainer.children.length > 0) {
			// 一行Spacer留白，不修改系统提示正文。
			this.chatContainer.addChild(new Spacer(1));
		}
		// 追加延迟主题文字，底层资源是否被忽略由实际加载/信任机制负责，不是警告文字实现隔离。
		this.chatContainer.addChild(
			// ThemedText让颜色可跟随主题失效重建，正文是下方固定提醒。
			new ThemedText(
				// 箭头无参，每次取颜色时返回同一语义文案。
				() =>
					// 使用theme.fg只生成带样式字符串，不读取被忽略扩展文件内容。
					theme.fg(
						// 警告级显示颜色，和ProjectTrustStore的true/false/null状态不是同一类型。
						"warning",
						// 插入配置目录名并建议/trust后重启；本方法不自动reload或restart进程。
						`This project is not trusted. Project ${CONFIG_DIR_NAME} resources and packages are ignored. Use /trust to save a trust decision, then restart pi.`,
					),
				// 水平边距1，与其它启动提醒一致。
				1,
				// 垂直边距0，外层Spacer控制前空行。
				0,
			),
		);
	}

	// 等待下一条空闲普通输入，返回Promise<string>；先shift本地FIFO，有值立即兑现，否则保存单个回调槽等正式提交唤醒。
	// 例如连续提交两条时第二条可先留pendingUserInputs；没有取消/超时或多等待者队列，若并发调用且队列空，后一次会覆盖前一次槽，使前一Promise继续等待。
	// 只接UI已整理文字，不读TTY/stdin、不在此发送模型请求。
	async getUserInput(): Promise<string> {
		// shift原地取出最早暂存文字并缩短数组，无元素为undefined。
		const queuedInput = this.pendingUserInputs.shift();
		// 用!==undefined而非真值判断，理论上已存空串也会作为输入返回，不把它误当没有值。
		if (queuedInput !== undefined) {
			// async把字符串包装成兑现Promise，不再登记新的onInputCallback。
			return queuedInput;
		}

		// 没有队列项则新建Promise，executor同步安装等待回调，不忙等轮询。
		return new Promise((resolve) => {
			// 覆盖单一回调字段，正式提交分支发现它时会调用；这里不累积多个监听函数。
			this.onInputCallback = (text: string) => {
				// 收到文字先清槽，让随后又提交的输入可以走本地FIFO，不重复唤醒同一等待者。
				this.onInputCallback = undefined;
				// resolve只把文字交run循环，模型调用发生在run的await后续体，不在此回调同步执行。
				resolve(text);
			};
		});
	}

	// 清聊天后按当前压缩感知条目重建，返回void；例思考/会话投影相关重画不用逐个重新执行业务。
	// 会重置全屏选区与待工具显示匹配，未传updateFooter/populateHistory，因此不在这里填编辑历史或主动更新页脚配置，也不重建资源区。
	private rebuildChatFromMessages(): void {
		// 移除聊天子组件，不删除Session历史文件或清消息数组。
		this.chatContainer.clear();
		// 现取当前上下文条目再显示，方法名虽叫FromMessages，实际源头是SessionEntry转换路径。
		this.renderSessionEntries(this.sessionManager.buildContextEntries());
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	// 处理中断/清空动作的双击退出语义，返回void；首次清编辑器，500ms内再次触发则后台shutdown。
	// 本方法不直接检查Agent状态或发SIGINT，实际触发键由AppKeybinding映射；async退出拒绝不由void自动吞，墙钟变化也不保证严格物理双击时长。
	private handleCtrlC(): void {
		// Date.now记录毫秒墙钟，不是单调性能时钟。
		const now = Date.now();
		// 间隔严格小于500才判双击，等于500按新的首击处理。
		if (now - this.lastSigintTime < 500) {
			// 启动退出Promise但不等待，正常会清终端/Runtime并exit；不在这一行简单kill所有工具。
			void this.shutdown();
		} else {
			// 首次动作调用clearEditor，只清当前编辑器文字并请求刷新，不清聊天或Session队列。
			this.clearEditor();
			// 保存本次作为下一次比较基准，双击分支本身没有重置lastSigintTime。
			this.lastSigintTime = now;
		}
	}

	// 收到“空编辑器退出”入口就后台shutdown，返回void；普通CustomEditor已在路由时限制空输入。
	// 这个包装自己不再验证editor内容，自定义编辑器调用它时需按同一约定；不等退出完成/不保证吞掉清理错误。
	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		// void仅适配同步动作接口，不表示shutdown所有异步资源都已清完。
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	// 退出流程的重入门禁，初始false；一旦置true即使后续清理拒绝也不自动复位，不等同Runtime已经dispose完成。
	private isShuttingDown = false;

	// 退出交互进程，返回Promise<void>但正常终点是process.exit(0)；重复进入已退出中则直接返回。
	// 信号路径先给Runtime的session_shutdown/失效清理机会再停终端，交互退出路径先退主题联动/排输入/停TUI，再dispose Runtime并显示可选恢复命令。
	// 例如/quit走交互分支，SIGTERM处理器传fromSignal:true；会改变终端、触发扩展清理并结束进程，不是只把UI可见性设为false。
	// 没有整体finally/逐项回滚，不保证所有子进程/网络都已停止或所有扩展都无TTY写入；标志先置位，任一步拒绝可阻断后续stop/exit。
	private async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		// 重入时直接返回兑现void，不等待已经在进行的首轮shutdown Promise。
		if (this.isShuttingDown) return;
		// 在第一次await之前锁门禁，信号/按键再次调用不会并发跑完整清理。
		this.isShuttingDown = true;
		// Keep signal handlers registered until terminal cleanup has completed.
		// `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
		// dispatch and re-sends the signal if only its own listeners remain.

		// 仅options.fromSignal真值走信号优先顺序，省略对象走普通交互路径。
		if (options?.fromSignal) {
			// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
			// (session_shutdown) BEFORE touching the terminal. Extension teardown
			// such as removing sockets does not write to the tty, so it must not be
			// skipped if a later terminal-restore write fails on a dead or stalled
			// terminal. If the terminal is gone, the restore writes below emit EIO,
			// which the stdout/stderr error handler turns into emergencyTerminalExit;
			// the render loop is already idle, so this cannot hot-spin (see #4144).
			// 先等待扩展session_shutdown并使会话资源失效/释放，Runtime.dispose本身不显式await所有Agent abort工作。
			await this.runtimeHost.dispose();
			// 再关闭主题自动深浅联动，可写终端通知开关，但不取消全部在途颜色查询。
			this.themeController.disableAutoSync();
			// 尽力排晚到键盘数据，最大约1000ms或默认空闲50ms可提前完成；不保证系统/SSH缓冲永久清空。
			await this.ui.terminal.drainInput(1000);
			// 调用本类stop释放选择器/状态/输入/页脚等并停TUI，内部也会最后注销信号；不是仅this.ui.stop。
			this.stop();
			// 信号清理走到这里才以0立即结束，不打印下面交互恢复命令。
			process.exit(0);
		}

		// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
		// TUI before emitting shutdown events so extension UI cleanup cannot repaint
		// the final frame while the process is exiting.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		// 交互分支先关主题主动通知，减少退出期间终端继续发外观报告；不代表卸了所有主题回调。
		this.themeController.disableAutoSync();
		// 在TUI还接管时等待晚到键释放等输入排空，再停止raw模式；await拒绝会跳过后面步骤。
		await this.ui.terminal.drainInput(1000);

		// 先停界面再发Runtime关闭事件，目的是减少扩展收尾重绘最终帧，但扩展任意外部写入不由此绝对禁止。
		this.stop();
		// 等待Runtime扩展关闭/宿主失效前清UI/会话dispose，清理回调可有自己的资源副作用和失败。
		await this.runtimeHost.dispose();

		// 按停后当前SessionManager生成可选恢复命令，要求stdout为TTY、持久模式与文件存在；不执行命令。
		const resumeCommand = formatResumeCommand(this.sessionManager);
		// 有完整建议才写到普通终端，内存会话或无文件时省略。
		if (resumeCommand) {
			// 用chalk弱化引导前缀并加LF写stdout，未等待write背压回调；命令引用已由formatResumeCommand负责。
			process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
		}

		// 正常清理与提示后立即exit0，不保证其它后台Promise或写缓冲都已完成。
		process.exit(0);
	}

	// 终端已失效时的紧急退出路径，返回never：标退出→卸本实例监听→请求杀已追踪子进程→exit129。
	// 例如EIO/EPIPE等命中错误码，刻意不恢复TTY/不跑普通Runtime扩展清理或记崩溃，避免失效终端写入递归出错；自身也没有额外try/finally。
	private emergencyTerminalExit(): never {
		// 先置门禁，其他异常路径看到已退出中可快速结束。
		this.isShuttingDown = true;
		// 注销本实例信号/流错误/未捕获异常监听；任一cleanup抛错会中断，不宣称必完成全部清理。
		this.unregisterSignalHandlers();
		// 仅请求终止已登记detached子进程/组，不扫描系统所有进程，不等待实际退出。
		killTrackedDetachedChildren();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		// 到达这里立即退出129，属于本程序选择的终止码，不再正常返回或补恢复命令。
		process.exit(129);
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw from
	 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
	 * tears down the process while leaving the terminal in raw mode with no
	 * cursor, requiring `stty sane && reset` to recover.
	 *
	 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
	 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
	 * paste / Kitty / modifyOtherKeys sequences.
	 */
	// 未捕获异常的最后处理器，输入Error，目标是尽力恢复终端、打印/记录崩溃再exit1；终端失效专用码改走紧急129路径。
	// 例如扩展ChildProcess回调同步throw可到这里；这不是通用可恢复异常处理，未等待Runtime.session_shutdown，也不重新开始主循环。
	// 三段try分别隔离卸监听/杀追踪进程/ui.stop失败，之后console输出等未被整段保护，不能保证任何写错误下都留下完整报告。
	private uncaughtCrash(error: Error): never {
		// A dead terminal is not a pi crash. Do not try to restore it or record it.
		// 先按终端错误码判断，命中时不当成Pi程序崩溃记录/恢复TTY。
		if (isDeadTerminalError(error)) {
			// 紧急方法正常不返回，所以不会继续下面普通crash流程。
			this.emergencyTerminalExit();
		}
		// 已经在退出时不再尝试第二轮日志/终端清理，减少递归崩溃。
		if (this.isShuttingDown) {
			// 直接exit1，和dead-terminal分支的129区分。
			process.exit(1);
		}
		// 首次普通崩溃先置退出门禁，后面出现另一个异常可触发快速路径。
		this.isShuttingDown = true;
		// 第一段尽力清监听，异常只影响这段不阻止后面两个尝试。
		try {
			// 只注销本实例登记的监听，不移除整个process上所有扩展监听器。
			this.unregisterSignalHandlers();
			// 空catch吞这次清监听失败，不自动打印次级错误。
		} catch {}
		// 第二段单独保护追踪子进程终止尝试。
		try {
			// 发清理信号并清追踪表，不等它们真正close。
			killTrackedDetachedChildren();
			// 终止辅助失败也继续尝试恢复终端，避免一个清理步骤拖死其余。
		} catch {}
		// 第三段保护底层TUI停止，不调用本类stop的全部UI清理链。
		try {
			// 尽力停终端/raw模式/光标协议，底层stop不是所有子步骤都有finally，抛错在此被吞。
			this.ui.stop();
			// 恢复失败也继续往stderr打印/记录，实际stderr可同样失效，不保证输出成功。
		} catch {}
		// 先打印固定崩溃标题；这行在三段try之外，console本身抛错可阻断后续步骤。
		console.error(`${APP_NAME} exiting due to uncaughtException:`);
		// 打印原Error通常包括堆栈，未由本行调用脱敏器，不能把控制台输出当已清洗报告。
		console.error(error);
		// 从当前加载扩展元数据匹配栈线索，内部失败可返回undefined。
		const extensionHint = this.getCrashExtensionHint(error);
		// 有线索才另起行打印停用排查建议，未自动禁用扩展或证明其致因。
		if (extensionHint) console.error(`\n${extensionHint}`);
		// 本地记录成功才给报告步骤，不在这里自动上传。
		if (this.recordCrash("uncaught_exception", error)) {
			// 打印恢复后/bug指引，实际报告收集发送仍需对应命令流程。
			console.error(`\n${this.crashReportInstructions()}`);
		}
		// 走到最后以1退出，never表示没有正常返回值，并不表示过程不会抛出异常。
		process.exit(1);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	// 若已请求退出就等待shutdown，无请求直接完成Promise<void>；例agent_settled后兑现扩展先前的退出意图。
	// 不在这里重新判isIdle/取消任务或清请求标志，退出顺序/重入门禁交shutdown负责。
	private async checkShutdownRequested(): Promise<void> {
		// shutdownRequested为false直接返回，不触碰终端。
		if (!this.shutdownRequested) return;
		// 等待退出流程，正常可能进process.exit；如果已有isShuttingDown则shutdown早返。
		await this.shutdown();
	}

	// 安装本实例的进程信号、三标准流错误及uncaughtException监听，返回void；先卸自己的旧订阅，再登记并存相应off闭包。
	// 例如SIGTERM先请求清追踪子进程，再走fromSignal退出；不是给所有错误加可恢复catch，也不在这里直接监听正常CtrlC的SIGINT（编辑器动作另处理）。
	// 注册修改process/stdio全局监听状态，回调可能写终端/杀追踪进程/exit；只有unregisterSignalHandlers按保存引用移除本实例项，不移除其他模块监听。
	private registerSignalHandlers(): void {
		// 先清前次登记记录避免重复，清理失败会打断本轮新注册，没有事务回滚。
		this.unregisterSignalHandlers();

		// NodeJS.Signals只在TS限制信号名，数组初始统一包含SIGTERM。
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		// 非Windows才额外处理SIGHUP，保留平台差异。
		if (process.platform !== "win32") {
			// 加入同一信号数组，后面复用处理器注册流程。
			signals.push("SIGHUP");
		}

		// 对选定信号分别创建处理器，不共享一个会遗失signal身份的off引用。
		for (const signal of signals) {
			// 信号回调同步先做终止请求，再启动异步关闭；不接收/返回业务消息。
			const handler = () => {
				// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
				// first, then attempts terminal restore. A genuinely dead terminal
				// surfaces as an EIO on the restore writes, which the stdout/stderr
				// error handler converts into emergencyTerminalExit (see #4144, #5080).
				// 尽力终止登记的detached工具进程，不保证操作系统所有子孙已结束。
				killTrackedDetachedChildren();
				// 指定fromSignal:true决定先Runtime清理再TTY恢复的顺序，void不观察关闭拒绝。
				void this.shutdown({ fromSignal: true });
			};
			// prependListener注册时排在当前已有同类监听前，不永久保证以后没有别的模块再prepend到更前。
			process.prependListener(signal, handler);
			// 保存按同signal/handler引用off的闭包；表达式真实返回Process对象，但这里按()=>void契约调用方忽略返回，并非JS强制改成undefined。
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		// 同一错误处理器供stdin/stdout/stderr使用，输入Error，终端失效码紧急退出，其余错误重新throw交进程未捕获异常路径。
		const terminalErrorHandler = (error: Error) => {
			// 只按上面明确四种code判断，普通磁盘/网络错误不会因为是Error就被当死终端。
			if (isDeadTerminalError(error)) {
				// 请求紧急退出，刻意跳过再次向失效终端写恢复序列。
				this.emergencyTerminalExit();
			}
			// 非死终端错误不静默吞掉，throw可转到下面uncaughtException监听器。
			throw error;
		};
		// stdin needs the handler too: once the terminal is gone, reads and setRawMode
		// fail with EIO (orphaned background process group) or ENOTTY (revoked tty).
		// Node emits these as stream errors, which are uncaught without a listener.
		// 为三标准流都登记，stdin读取/raw切换错误与stdout/stderr写错误都能走同一规则。
		for (const stream of [process.stdin, process.stdout, process.stderr]) {
			// 监听Node流error事件，正常数据/按键仍由Terminal适配器处理。
			stream.on("error", terminalErrorHandler);
			// 每个流的off闭包捕获那次stream引用，不会误清其他流或其他处理器。
			this.signalCleanupHandlers.push(() => stream.off("error", terminalErrorHandler));
		}

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in pi) leaves the terminal in raw mode with no cursor.
		// 未捕获异常监听转给本类uncaughtCrash，返回never是终止路径，不是继续正常运行的错误回调。
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		// 注册到process未捕获异常列表前面，让本实例先尝试停TTY；不因此阻止其他监听器代码本身被配置。
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		// 保存精确off闭包供停止/重初始化时移除，不调用removeAllListeners。
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
	}

	// 依次执行已保存cleanup并清列表，返回void；例stop只卸本实例signal/stream/uncaught监听。
	// 无逐项catch/finally，某项抛错时后项和数组重置可被跳过，不保证重复调用一定完全无副作用。
	private unregisterSignalHandlers(): void {
		// for...of按登记顺序清理，cleanup可能是Process.off或Stream.off等闭包。
		for (const cleanup of this.signalCleanupHandlers) {
			// 同步调用，不await返回值/异步清理；当前登记项都是移监听操作。
			cleanup();
		}
		// 正常遍历结束才把数组换成空，避免继续持有旧函数引用。
		this.signalCleanupHandlers = [];
	}

	// 处理挂起/恢复终端，返回void；Windows仅提示不支持，其他平台留保活interval/临时SIGINT监听/一次SIGCONT恢复，再stop并向当前进程组发SIGTSTP。
	// 例如shell fg恢复后SIGCONT清保活、重启TUI并全重绘；这会操作真实进程组和TTY，不是只切一个UI可见标志。
	// stop/发信号失败只清保活与SIGINT监听再throw，已登记的匿名SIGCONT监听没有在catch移除；也不保证信号发送成功就实际进入挂起状态。
	private handleCtrlZ(): void {
		// Windows没有这套Unix作业控制路径，先隔离平台分支。
		if (process.platform === "win32") {
			// 只显示不支持提示，不启动别的后台进程替代。
			this.showStatus("Suspend to background is not supported on Windows");
			// 直接return，避免注册Unix信号与interval。
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		// 2**30是约12.4天的周期，空回调目的只是保留ref句柄，让Node在恢复时有机会处理SIGCONT，不是阻止操作系统挂起或定时恢复。
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		// 空SIGINT回调仅改变Node默认终止处理，不停止其它已注册SIGINT监听器执行。
		const ignoreSigint = () => {};
		// 临时加这个监听，恢复或下面catch按同一引用移除。
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		// once让下一次SIGCONT回调只执行一回；这段登记在try之前，后面失败不自动撤销它。
		process.once("SIGCONT", () => {
			// 恢复后先去掉保活interval，释放额外事件循环句柄。
			clearInterval(suspendKeepAlive);
			// 移本次空SIGINT监听，不动别人同类监听器。
			process.removeListener("SIGINT", ignoreSigint);
			// 重新启动当前ui终端生命周期，可能写raw/键盘/屏幕协议；没有在这个恢复回调里catch异常。
			this.ui.start();
			// force:true请求全量重绘，清理挂起期间shell留下的显示差异，不是同步立即输出完成。
			this.ui.requestRender(true);
		});

		// try只包stop与发送挂起信号，不包上面注册动作或未来SIGCONT回调。
		try {
			// Stop the TUI (restore terminal to normal mode)
			// 暂停TUI恢复普通终端模式，尚未注销本InteractiveMode的全部信号/资源，不调用本类stop。
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			// POSIX pid=0指当前进程组，发SIGTSTP请求组内暂停；返回true只代表信号调用未报错，不等于已观察到所有进程停下。
			process.kill(0, "SIGTSTP");
			// 捕获stop/kill同步异常，执行有限回退后仍将原异常抛给输入调用方。
		} catch (error) {
			// 失败不再让保活interval无意义长期留存。
			clearInterval(suspendKeepAlive);
			// 移临时SIGINT回调，但未恢复已stop的ui，也未移那次SIGCONT listener。
			process.removeListener("SIGINT", ignoreSigint);
			// 保留原错误，不把挂起失败伪称成功/静默忽略。
			throw error;
		}
	}

	// 处理追问动作，返回Promise<void>；取展开后的输入并trim，压缩中普通文字记followUp，流式中用Session.prompt的followUp选项，空闲时转当前编辑器onSubmit。
	// 例如回答尚有工具工作时“接着写文档”应等低层没有工具/插话后投递，不是立刻中断本轮流。
	// 扩展命令压缩中仍可立即执行；空闲转发onSubmit并未await它的返回值，故此方法完成不保证异步提交/回答完成，没有这里的全局catch。
	private async handleFollowUp(): Promise<void> {
		// 优先展开大粘贴等内容，只有方法/结果nullish才回getText，最后去两端空白。
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		// 整理后空文字直接结束，不清编辑器、不排空消息。
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		// 压缩状态优先于普通isStreaming追问，避免直接与摘要过程冲突。
		if (this.session.isCompacting) {
			// 只对runner精确识别的扩展命令开即时处理路径。
			if (this.isExtensionCommand(text)) {
				// 有历史能力时记整理后的命令，不保证所有自定义编辑器都保存。
				this.editor.addToHistory?.(text);
				// 先清当前输入，命令文字已在局部text保存。
				this.editor.setText("");
				// Session.prompt先尝试扩展命令再检查普通压缩门禁，因此可被扩展接管；未指定streamingBehavior也不表示普通输入在这里合法。
				await this.session.prompt(text);
			} else {
				// 不是扩展命令则放UI压缩队列，意图明确followUp，helper同时清输入/更新待显示。
				this.queueCompactionMessage(text, "followUp");
			}
			// 压缩分支结束，不重复进下面普通运行/空闲提交。
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		// 非压缩但Session正在运行时用追问队列，不开第二个并发Agent。
		if (this.session.isStreaming) {
			// 记录历史文本，包含实际展开的大粘贴内容而非仅占位符。
			this.editor.addToHistory?.(text);
			// 清输入，让用户可继续起草下一条。
			this.editor.setText("");
			// Session仍处理命令/模板/输入扩展，普通文字按followUp队列投递；await是这次派发语义，不等整个运行结束。
			await this.session.prompt(text, { streamingBehavior: "followUp" });
			// 派发后重建待消息显示，取当前队列而不是假定一定新增一项。
			this.updatePendingMessagesDisplay();
			// 请求一帧，实际消费追问时由后续queue/message事件更新。
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		// 空闲且有onSubmit才退为普通Enter语义，实际键位不必是原英文描述中的Alt+Enter。
		else if (this.editor.onSubmit) {
			// 先清当前editor文字，提交函数得到已保存在text中的全文。
			this.editor.setText("");
			// 直接调用void类型onSubmit，不await其可能返回的Promise；同步throw会拒绝本async方法，未来拒绝不由这里接续。
			this.editor.onSubmit(text);
		}
	}

	// 取回两类待消息以继续编辑，并显示恢复条数，返回void；例如steer两条/followUp一条可合成输入草稿并提示3条。
	// 会清相应队列/改输入，不自动abort当前Agent；图片/custom等低层队列载荷不在返回文字计数中，具体范围见clearAllQueues。
	private handleDequeue(): void {
		// 调用恢复助手，返回的是文字消息条数，不是恢复后的行数或token数。
		const restored = this.restoreQueuedMessagesToEditor();
		// 0表示没有这两类排队文字，当前编辑器在恢复助手里不被覆盖。
		if (restored === 0) {
			// 提示没有可取文字，不证明所有低层/custom/Bash待项都为空。
			this.showStatus("No queued messages to restore");
		} else {
			// 显示条数单复数，状态提示可能与紧邻状态合并，不写Session历史。
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	// 按Bash输入模式或当前思考级别重设活动编辑器borderColor，再失效活动指示器并请求帧，返回void。
	// 例如输入!后用Bash色，删!后回思考色；只影响显示，不启用shell/思考计算或保存主题设置。
	private updateEditorBorderColor(): void {
		// 本实例isBashMode为真优先于thinkingLevel颜色，不据是否正有Bash子进程选择。
		if (this.isBashMode) {
			// 把颜色函数引用赋到当前editor可选borderColor属性，不当场渲染整条边框。
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			// 正常模式按当前Session.thinkingLevel，缺省/假值用off，不修改Agent状态。
			const level = this.session.thinkingLevel || "off";
			// 取对应主题函数作为编辑器颜色入口，主题切换后再次调用本方法可更新。
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		// 指示器可能画在边框里，使其缓存失效以采用新的显示样式，不重启动作业务。
		this.activeStatusIndicator?.invalidate();
		// 请求显示新边框/指示器，调用者不用另专门render一次。
		this.ui.requestRender();
	}

	// 循环当前模型支持的思考级别并更新页脚/边框/状态，返回void；末级通常回首级，无模型/不支持reasoning时提示不支持。
	// Session默认选项只改会话级别并记录变化，不在本调用显式保存全局thinking默认；不会请求模型验证能力。
	private cycleThinkingLevel(): void {
		// 让Session选择下一级并按能力钳制/记历史，UI不自行给levels做模运算。
		const newLevel = this.session.cycleThinkingLevel();
		// undefined表示没有可循环级别，不把off字符串误当缺结果。
		if (newLevel === undefined) {
			// 沿原文显示“不支持thinking”，也涵盖尚无当前模型的Session判断。
			this.showStatus("Current model does not support thinking");
		} else {
			// 切换成功先让页脚下次重读级别。
			this.footer.invalidate();
			// 当前输入框边框颜色跟随新有效思考级别。
			this.updateEditorBorderColor();
			// 状态显示Session返回的级别，纯UI文字不作为新用户问题。
			this.showStatus(`Thinking level: ${newLevel}`);
		}
	}

	// 按forward/backward循环模型并显示结果，返回Promise<void>；有范围用范围与可用快照交集，否则用全量可用快照，不在循环时刷新目录。
	// Session默认只记当前会话模型/思考变化并派扩展事件，本UI更新页脚/边框并后台检查Anthropic认证提醒；未显式persist全局默认。
	// try包切换及本块显示，捕到错误转showError；提示Only one是UI简化文案，实际候选0或1都可返回undefined。
	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		// 保护Session循环和同步UI更新，后面void认证提醒的内部Promise不由这段try等待。
		try {
			// 等待Session循环与模型选择扩展事件，result可能undefined；扩展处理器也可产生自己的副作用。
			const result = await this.session.cycleModel(direction);
			// 无法循环时不访问result.model/级别，也不假造一个首模型。
			if (result === undefined) {
				// 根据是否配置非空范围选文案，未反映过滤后究竟是0还是1项。
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				// 显示状态，不自动刷新认证/补充范围外模型来解决不足。
				this.showStatus(msg);
			} else {
				// 切换有结果就令页脚失效，显示当前模型信息。
				this.footer.invalidate();
				// 按新会话思考级别刷新输入边框。
				this.updateEditorBorderColor();
				// 可选后缀说明仅在推理模型且级别非off时显示。
				const thinkingStr =
					// &&短路后选thinking文字，否则空串；不据文案判断模型实际返回了thinking块。
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				// 模型显示名真值优先，否则裸ID，未在这里加provider作唯一标识。
				this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
				// 认证额外用量提醒单独后台执行，传这次结果模型；不在本方法继续等认证检查。
				void this.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
			}
			// 切换/显示同步错误被捕获，不表示模型状态已自动回滚到旧值。
		} catch (error) {
			// Error取message，其余String；showError自身错误仍可拒绝本方法。
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	// 反转当前全局展开偏好并委托统一方法，返回void；例如false→true展开支持此能力的页头/资源/聊天项。
	// 不读文件或执行工具，具体组件setExpanded可运行显示回调。
	private toggleToolOutputExpansion(): void {
		// !得到布尔相反值，不是对每个组件当前局部展开逐个取反。
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	// 将共享展开目标应用到活动页头及资源/聊天直接子项，返回void；相同目标直接略过，变化后显示Tool output状态。
	// 例工具、摘要、技能卡片、资源区文字都可能响应，名字Tools不代表只影响工具；不递归任意扩展组件树、不写全局设置或恢复所有历史正文。
	private setToolsExpanded(expanded: boolean): void {
		// 目标与字段相同则不再遍历，也不会纠正用户单击后与全局字段不同的某个局部组件。
		if (expanded === this.toolOutputExpanded) return;

		// 先记录全局目标，后续某组件抛错也不回滚字段或已更新的前面组件。
		this.toolOutputExpanded = expanded;
		// 自定义页头优先，缺省才取内置，不同时对两者都展开。
		const activeHeader = this.customHeader ?? this.builtInHeader;
		// 结构探测支持setExpanded才调用，普通Text/undefined都跳过。
		if (isExpandable(activeHeader)) {
			// 传目标布尔，不让页头自己随意翻转。
			activeHeader.setExpanded(expanded);
		}
		// 仅遍历资源容器和聊天容器两组直接children，不处理编辑器上下挂件Map。
		for (const container of [this.loadedResourcesContainer, this.chatContainer]) {
			// 同一组件若出现在这两容器可被多次调用，未做引用去重。
			for (const child of container.children) {
				// 按能力识别工具/摘要/ExpandableText等，非该能力项保持不变。
				if (isExpandable(child)) {
					// 组件自己重建显示或失效，可能执行扩展renderer，异常未逐项隔离。
					child.setExpanded(expanded);
				}
			}
		}
		// 显示固定Tool output标签并由showStatus安排重绘，文案范围比实际可响应组件集合更窄。
		this.showStatus(`Tool output: ${expanded ? "expanded" : "collapsed"}`);
	}

	/** Update rendered assistant messages without rebuilding live tool components. */
	// 把当前thinking隐藏偏好传给聊天直接助手组件并请求帧，返回void；不重建/丢失活工具组件。
	// 例如流式助手通常已在chat.children中也会更新；不递归其他容器，也不另遍历streamingComponent引用，助手setter会清各思考段局部点击覆盖。
	private updateThinkingBlockVisibility(): void {
		// 只读聊天直接children，不重扫Session历史或转换工具结果。
		for (const child of this.chatContainer.children) {
			// instanceof缩窄到真正AssistantMessageComponent，其他扩展自绘思考卡片不受此循环强制控制。
			if (child instanceof AssistantMessageComponent) {
				// 助手显示器按最后消息重建并清单段覆盖，不修改原thinking块/模型级别。
				child.setHideThinkingBlock(this.hideThinkingBlock);
			}
		}
		// 完成各助手更新后请求一帧。
		this.ui.requestRender();
	}

	// 翻转thinking显示、排队保存偏好、更新已画助手并提示，返回void；例隐藏只折叠UI，不从下一轮模型上下文删除思考签名。
	// 设置保存是异步队列语义，这里不await flush，不确认磁盘已落盘。
	private toggleThinkingBlockVisibility(): void {
		// 翻转本实例布尔字段，而不是设置Agent.thinkingLevel为off。
		this.hideThinkingBlock = !this.hideThinkingBlock;
		// 写用户层显示设置并排队保存，可信项目同名设置的覆盖仍按SettingsManager规则。
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);
		// 只更新助手显示，保留活工具组件对象。
		this.updateThinkingBlockVisibility();
		// 状态文字按本实例新偏好选hidden/visible，不证明所有扩展自绘组件都响应。
		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	// 暂停当前TUI并让配置的外部编辑器修改输入，返回Promise<void>；成功采用返回正文，结构化failed只显示提示，finally重启/全重绘。
	// 例如code --wait修改独立临时prompt文件；helper会建删临时目录并启动真实进程，不操作用户已有文件，但外部程序本身有自己的行为。
	// ui.stop在try外，失败不会进finally；等待后写当前this.editor而非捕获旧实例，也没有整个流程取消/忙锁或统一catch，helper拒绝在重启尝试后仍传播。
	private async handleOpenExternalEditor(): Promise<void> {
		// 读取当前设置解析出的外部命令，尚未运行或检查程序存在。
		const editorCmd = this.settingsManager.getExternalEditorCommand();
		// 优先展开大粘贴内容，缺能力/结果才取普通文本；不trim用户草稿。
		const content = this.editor.getExpandedText?.() ?? this.editor.getText();
		// 先停底层TUI让外部程序继承终端，保留本类其余会话/信号状态；本行不在后面try保护内。
		this.ui.stop();
		// 从真正helper调用开始用finally保证尝试重启，不是把所有失败变成提示的catch。
		try {
			// 等临时文件/子进程结束结果，helper没有在此实现超时或AbortSignal取消。
			const result = await editInExternalEditor({
				// command按配置原字符串传，helper空格拆分并非通用shell引号解析。
				command: editorCmd,
				// content用属性简写，作为临时文件初始内容，而不是命令字符串的一部分。
				content,
			});
			// 按判别status收窄，只有complete分支可访问content。
			if (result.status === "complete") {
				// 成功采用新文字，空串也会清输入；不把修改结果自动发模型。
				this.editor.setText(result.content);
			} else {
				// failed显示helper说明，不覆盖原输入文字；不是catch捕到所有IO/同步spawn异常。
				this.showStatus(result.message);
			}
			// try内正常return/throw都进入finally，原拒绝仍会继续传出，除非finally自身又抛新异常覆盖。
		} finally {
			// 重新start可能写终端协议/安装输入回调，若它抛错下面重绘不会执行。
			this.ui.start();
			// force:true安排全量重绘以清外部编辑器遗留画面，不保证立即渲染成功。
			this.ui.requestRender(true);
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	// 清当前活动编辑器文字并请求帧，返回void；例一次清空动作保留聊天/排队消息，setText可能触发该编辑器onChange。
	// 不清Session消息、不直接发abort，不在本函数显式把isBashMode设false（正常编辑器变化回调负责同步）。
	clearEditor(): void {
		// 调用当前editor.setText("")，基础Editor还会规范/重置光标/补全等自身状态，自定义实现按契约处理。
		this.editor.setText("");
		// 显式请求显示清空结果，不等下一条Agent事件才重绘。
		this.ui.requestRender();
	}

	// 向聊天追加一条错误文字并刷新，输入纯字符串、返回void；例showError("bad")显示Error: bad。
	// 这不是throw/致命退出，不自动recordCrash/上传/重试；新建ThemedText捕获本次局部errorMessage，重复调用会追加多条而非普通状态合并。
	showError(errorMessage: string): void {
		// 错误前留一空行，不依赖聊天是否为空。
		this.chatContainer.addChild(new Spacer(1));
		// 错误色与Error:前缀延迟生成，水平边距outputPad，正文未在本方法脱敏/转义控制符。
		this.chatContainer.addChild(new ThemedText(() => theme.fg("error", `Error: ${errorMessage}`), this.outputPad, 0));
		// 请求一帧，调用方仍自行决定是否继续任务/退出。
		this.ui.requestRender();
	}

	// 向聊天追加警告并刷新，输入字符串、返回void；例包更新/认证提醒使用Warning:前缀，不停止会话。
	// 独立追加不合并，文案闭包捕获本次参数；方法不确认/修复警告原因。
	showWarning(warningMessage: string): void {
		// 警告前固定加空行。
		this.chatContainer.addChild(new Spacer(1));
		// 延迟warning着色，水平边距固定1（不是outputPad），不改原warningMessage。
		this.chatContainer.addChild(new ThemedText(() => theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		// 请求显示，不等用户读完或作确认。
		this.ui.requestRender();
	}

	// 显示已有新版本元数据与更新命令/日志链接，返回void；例release.version=1.2.4时建议运行pi update，note非空再显示Markdown说明。
	// 不下载/安装/自动打开链接，构造/渲染可读取主题与终端能力；release.version在延迟函数里读取，note则此时trim成局部快照。
	showNewVersionNotification(release: LatestPiRelease): void {
		// 局部延迟函数生成更新命令提示，便于主题失效后重新取颜色，不在函数定义时执行命令。
		const updateInstruction = () =>
			// 第一段含release.version，使用muted色，仍是显示文字而非shell参数。
			theme.fg("muted", `New version ${release.version} is available. Run `) +
			// 第二段把当前APP_NAME update用accent强调，不启动包管理器。
			theme.fg("accent", `${APP_NAME} update`);
		// 固定变更日志URL原文，声明字符串不产生HTTP请求。
		const changelogUrl = "https://pi.dev/changelog";
		// 局部日志行函数在实际渲染时判断超链接能力，返回单行ANSI文字。
		const changelogLine = () => {
			// 读取当前能力hyperlinks，冷能力探测的行为由TUI能力模块负责，不假定所有终端都能点击。
			// 支持时用hyperlink包装可见URL和目标，生成OSC8显示控制文字，不主动访问网页。
			// 不支持则只着色普通URL字符串，仍给用户可读地址。
			const changelogLink = getCapabilities().hyperlinks
				? hyperlink(theme.fg("accent", changelogUrl), changelogUrl)
				: theme.fg("accent", changelogUrl);
			// 前缀Changelog弱色，后接链接/普通文字。
			return theme.fg("muted", "Changelog: ") + changelogLink;
		};
		// 只取note两端空白，空串后面略过；不校验远端说明Markdown内容可信性。
		const note = release.note?.trim();

		// 通知前留一行，与现有聊天分开。
		this.chatContainer.addChild(new Spacer(1));
		// warning色动态边框作为通知开始界线。
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		// 加入标题与更新指令的主题化文字组件。
		this.chatContainer.addChild(
			// 标题加粗/警告色，换行接更新命令，水平边距1、垂直0，不保存为模型消息。
			new ThemedText(() => `${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction()}`, 1, 0),
		);
		// note真值才展示说明，可为多行Markdown。
		if (note) {
			// 标题与说明之间留空行。
			this.chatContainer.addChild(new Spacer(1));
			// 说明用Markdown组件而非ThemedText模板直接拼整段，保留其排版规则。
			this.chatContainer.addChild(
				// 正文沿当前Markdown主题/缩进，固定左右1列留白。
				new Markdown(note, 1, 0, this.getMarkdownThemeWithSettings(), {
					// 普通正文额外用muted色，说明中的链接/代码仍由Markdown渲染负责。
					color: (text) => theme.fg("muted", text),
				}),
			);
			// 说明之后留一行，再接日志链接。
			this.chatContainer.addChild(new Spacer(1));
		}
		// 日志行延迟生成，可随能力/主题重新计算；未调用浏览器打开辅助。
		this.chatContainer.addChild(new ThemedText(changelogLine, 1, 0));
		// 末尾边框结束通知区，不把链接或release写入本地版本清单。
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		// 请求刷新，方法本身不做“是否更新”的版本比较，调用者已提供候选。
		this.ui.requestRender();
	}

	// 显示可更新包名称与pi update --extensions建议，返回void；例如["a","b"]生成两条短横线包名。
	// 只展示不查询/安装，调用方通常先判非空，本方法自己未拦空数组；packageLines本次一次拼好，后续外部改packages不会自动变更它。
	showPackageUpdateNotification(packages: string[]): void {
		// 更新指令用延迟函数重新取主题颜色，不重复查询远端。
		const updateInstruction = () =>
			// 普通提示前半句弱色，文案保留原英文。
			theme.fg("muted", "Package updates are available. Run ") +
			// 建议命令accent着色，不在此spawn npm/git。
			theme.fg("accent", `${APP_NAME} update --extensions`);
		// 按原数组顺序生成包名列表，LF分行，不排序/去重或把包名当完整shell引用。
		const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

		// 先追加一行间隔。
		this.chatContainer.addChild(new Spacer(1));
		// 警告动态边框作为区块开头。
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		// 标题、指令和包列表放同一个ThemedText组件。
		this.chatContainer.addChild(
			// Theme失效时可重建颜色，packageLines字符串本身保持创建时快照。
			new ThemedText(
				// 无参箭头延迟构建整段通知，不在定义时运行更新操作。
				() =>
					// 固定多段用LF连接，包名原文未在这里做Markdown/控制符转义。
					`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction()}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
				// 水平边距1，和单条普通warning一致。
				1,
				// 垂直边距0，前后Spacer/边框自己占行。
				0,
			),
		);
		// 追加结束边框，未自动把本次包更新提示设为已读设置。
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		// 请求重绘，真正升级需另行执行命令流程。
		this.ui.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	// 汇总待显示的steering/followUp文字，返回新对象与两个新数组，不消费队列；每类先Session文字，再UI压缩队列同类文字。
	// 例如Session有S1、压缩队列有F1/S2，结果steering=[S1,S2]、followUp=[F1]，不保留跨两类的全局到达顺序。
	// 名字All只指这两类显示文字，不含pendingUserInputs、待Bash/nextTurn custom或完整图片载荷；只读使用不等于返回readonly/冻结对象。
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		// 新建返回对象，不将内部两个数组原引用直接交出去。
		return {
			// steering数组按下面两个展开来源合并。
			steering: [
				// 复制Session展示用插话文字，不从低层消息块里提图片。
				...this.session.getSteeringMessages(),
				// 压缩队列先筛mode严格steer，再只取text，filter/map均新建数组，队列本身不变。
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			// followUp单独按同样方式合并，不与steering交织排序。
			followUp: [
				// 先展开Session展示用追问文字。
				...this.session.getFollowUpMessages(),
				// 再追加压缩暂存中的followUp文字，保留其在该队列里的相对顺序。
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	// 清Session的插话/追问两队列和UI压缩文字队列，并返回原文字分类新数组；例取消/取回输入可借结果回填编辑器。
	// Session.clearQueue还会清其低层对应队列中的图片/custom消息，但返回这里只含显示文字；不清Session pendingNextTurn、pendingUserInputs或Bash工作。
	// 清理分步进行并发queue_update，不是无通知的原子交换；错误可中途打断，调用方不得把返回文字当完整消息无损备份。
	private clearAllQueues(): { steering: string[]; followUp: string[] } {
		// 先由Session复制文字、清展示/低层两队列并同步发布queue_update，UI压缩队列此时尚未清。
		const { steering, followUp } = this.session.clearQueue();
		// 从现有压缩队列准备插话文字副本，下面链式过滤/映射不修改原记录。
		const compactionSteering = this.compactionQueuedMessages
			// 只取mode为steer的项，不按文字前缀猜类型。
			.filter((msg) => msg.mode === "steer")
			// 结果只保留text，原mode元信息通过返回数组归类表达。
			.map((msg) => msg.text);
		// 再为追问准备另一个新数组。
		const compactionFollowUp = this.compactionQueuedMessages
			// 只取followUp意图，不包含其他未来类型的运行时值。
			.filter((msg) => msg.mode === "followUp")
			// 映射文字，未保留每项对象引用给调用方。
			.map((msg) => msg.text);
		// 清UI压缩队列槽，和Session清理发生在不同步骤。
		this.compactionQueuedMessages = [];
		// 组合清前结果，返回对象可由调用者继续修改，不影响已清内部数组。
		return {
			// 插话顺序Session旧文字在前、压缩旧文字在后，不按时间戳合并。
			steering: [...steering, ...compactionSteering],
			// 追问采用同一分类内顺序。
			followUp: [...followUp, ...compactionFollowUp],
		};
	}

	// 重建待消息区域的文字预览，返回void；先清容器，若有steer/followUp就分组列单行摘要和取回编辑快捷键提示。
	// 例如多行队列消息仅显示首个LF前一行并按终端宽截断，完整文字仍在队列；不消费/提交消息，也不在本方法requestRender。
	// 清整个pending容器也会摘掉此前挂在其中的待Bash组件，但本方法未清pendingBashComponents数组，之后flush仍可处理其引用。
	private updatePendingMessagesDisplay(): void {
		// 清全部待显示children，不是只删除上次文字预览组件。
		this.pendingMessagesContainer.clear();
		// 解构并给两类数组取更具体局部名，汇总来源包含Session与UI压缩文字。
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		// 至少一类非空才建立占位/提示，零条时保持空容器。
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			// 有文字队列时先加一行间隔。
			this.pendingMessagesContainer.addChild(new Spacer(1));
			// 所有steering先显示，不与followUp按原全局到达顺序交错。
			for (const message of steeringMessages) {
				// 把原message接Steering:并弱色着色，未在这里修改/trim队列正文。
				const text = theme.fg("dim", `Steering: ${message}`);
				// TruncatedText只画首个LF前内容、超宽截断不折行，左右1列，预览不等于完整消息已经压缩。
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			// 插话全部后再列追问。
			for (const message of followUpMessages) {
				// 追问加Follow-up:区分，实际投递策略仍由Session/Agent负责。
				const text = theme.fg("dim", `Follow-up: ${message}`);
				// 同样只提供一行显示预算，队列内部字符串保持完整。
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			// 按app.message.dequeue查当前可配置快捷键展示，不硬写某组合键。
			const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
			// 拼“取回全部排队文字编辑”的提示，原箭头字符是既有运行时文案，保持不变。
			const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`);
			// 帮助也用单行截断组件，极窄屏可能截掉部分提示，不保证整句都可见。
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	// 取出并清相应队列，将steering后接followUp文字与当前草稿合并回输入，返回恢复文字条数；可选abort随后请求取消会话。
	// 例如两队列各一条加当前草稿，以双LF分段；只恢复文字，不保留两种排队意图/到达交错顺序或原图片/custom消息载荷。
	// 没有排队文字时不覆盖当前输入，但仍可abort；队列已清后setText等错误没有回滚，void abort不等真正空闲。
	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		// 先清Session/压缩队列并取得分类文字，期间可同步发队列事件。
		const { steering, followUp } = this.clearAllQueues();
		// steering全部在前、followUp在后，结果丢掉每项原mode，仅作草稿段落。
		const allQueued = [...steering, ...followUp];
		// 没有这两类文字时走轻量路径，不使用options.currentText覆盖输入。
		if (allQueued.length === 0) {
			// 重画空队列预览，pending容器已不再显示这些文字。
			this.updatePendingMessagesDisplay();
			// 即使没有队列，只要abort真值仍请求取消。
			if (options?.abort) {
				// 启动Session.abort并丢弃返回Promise，不能据恢复函数返回判断网络/工具已全部停止。
				void this.session.abort();
			}
			// 返回0表示恢复文字条数，不表示低层所有类型待项或业务状态均为空。
			return 0;
		}
		// 两条队列文字间加空白行，原文字内部换行照留。
		const queuedText = allQueued.join("\n\n");
		// 显式currentText优先，空串也保留；缺省才读当前普通getText，未展开大粘贴占位。
		const currentText = options?.currentText ?? this.editor.getText();
		// filter只用trim判断段是否全空白，保留非空段原字符串，再用双LF连接队列段与当前草稿。
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		// 整体setText回编辑器，基础实现会重置补全/光标等自身状态，不是逐消息恢复原撤销/附件结构。
		this.editor.setText(combinedText);
		// 队列已清，再更新预览；输入中的合并草稿尚未提交。
		this.updatePendingMessagesDisplay();
		// 有文字恢复后也可发abort，次序明确在回填/预览之后。
		if (options?.abort) {
			// 不await取消，异步拒绝并不是由void自动catch。
			void this.session.abort();
		}
		// 返回原文字项数，不是合并后段落数或最终队列长度。
		return allQueued.length;
	}

	// 压缩期间暂存一条文字及steer/followUp意图并给UI反馈，返回void；例普通Enter记录steer，追问动作记录followUp。
	// 会改本地队列、当前编辑器历史/文字与预览，但不立刻送Agent、不附图片；后续flush才按实际会话状态派发。
	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		// 追加新的{text,mode}记录，保持本UI压缩队列到达顺序，未在此做去重/模板展开。
		this.compactionQueuedMessages.push({ text, mode });
		// 当前编辑器有历史能力就记原文字。
		this.editor.addToHistory?.(text);
		// 清输入，用户可继续起草下一条，队列记录不随清输入丢失。
		this.editor.setText("");
		// 按两类文字分组重画pending预览，显示顺序可能与原跨类到达顺序不同。
		this.updatePendingMessagesDisplay();
		// 普通状态提示已排队，showStatus安排重绘，不表示模型已经处理。
		this.showStatus("Queued message for after compaction");
	}

	// 判断文字是否调用已注册扩展命令，返回布尔；例/review a.ts取review找runner最终invocationName。
	// 只查精确命令，不执行handler、不匹配内置/模板/技能的所有/语法；分词只认第一个普通空格，制表符不在这里当分隔符。
	private isExtensionCommand(text: string): boolean {
		// 不是/起始立即false，未trim输入，调用方通常已做整理。
		if (!text.startsWith("/")) return false;

		// 现取当前Session的runner，不固定沿用上次资源加载时对象。
		const extensionRunner = this.session.extensionRunner;

		// indexOf只查" "，没普通空格返回-1，不是正则按所有空白拆。
		const spaceIndex = text.indexOf(" ");
		// 无空格去首/后取整串，有空格只取/与首空格之间；/单独得到空命令名。
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		// runner按最终调用名精确查并重新解析注册命令，!!转是否存在；该查找不运行命令，也不在此把别名改回原name。
		return !!extensionRunner.getCommand(commandName);
	}

	// 派发压缩期间暂存文字，返回Promise<void>；先取本批/清显示，willRetry时只给后续重试排队（扩展命令仍即时），否则先执行前置扩展命令，再发起首个普通prompt并排余项。
	// 例如[扩展A,普通S,追问F]先等A，再启动S的Promise而不等它完成，然后把F放followUp；不承诺此时S已过所有异步预检并真正开模型流。
	// 失败恢复是尽力的文字队列重置，不是事务：会清当前Session对应两队列并用本批覆盖UI压缩队列，可能影响期间新队列，不能回滚已执行命令/已发prompt。
	// 首prompt有后台catch可稍后恢复，外层catch保护其它await/同步阶段；恢复助手自己抛错时没有第二层兜底，未等待promptPromise意味着方法完成不代表本批模型处理结束。
	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		// 本地压缩队列空直接返回，不清Session队列、不造空prompt。
		if (this.compactionQueuedMessages.length === 0) {
			// async返回已兑现void，调用者无需区分空队列特殊值。
			return;
		}

		// 浅复制外层队列作为本批，记录对象仍共享，不是不可变深快照。
		const queuedMessages = [...this.compactionQueuedMessages];
		// 立即把活动UI队列换成空，期间后续输入可进新数组，恢复时可能被覆盖。
		this.compactionQueuedMessages = [];
		// 先刷新pending显示，派发尚未完成，不能把文字消失当成功确认。
		this.updatePendingMessagesDisplay();

		// 局部错误恢复回调接unknown，清Session相关队列、恢复本批到UI队列并报错；不撤销之前业务副作用。
		const restoreQueue = (error: unknown) => {
			// 清当时Session全部steering/followUp低层队列，不只本次已排入的项，且返回文字被忽略。
			this.session.clearQueue();
			// 以本批数组直接覆盖当前compactionQueuedMessages，期间新增本地项不会自动合并；此后该数组也不再是独立只读副本。
			this.compactionQueuedMessages = queuedMessages;
			// 重建“待发送”预览，不在这里重新把恢复项立刻发一次。
			this.updatePendingMessagesDisplay();
			// 显示失败说明，文字格式化/显示本身可再抛错，没有这一回调内部try。
			this.showError(
				// 这一完整多行模板按本批数量选择单复数、Error取message否则String(error)；所有解释放在模板外，不向运行时字符串或其插值内部插注释。
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		// try包含各await派发与首prompt链的建立，不会自动等待下面后台promptPromise的最终结算。
		try {
			// willRetry真值表示会话计划恢复原运行，普通文字先排给那次后续回合而不是从UI另启动独立prompt。
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				// 按本批原队列顺序处理，不按steer/followUp分组重新排序。
				for (const message of queuedMessages) {
					// 每项现查是否扩展命令，注册表变化可能影响分类，不只依赖首次排队时的判断。
					if (this.isExtensionCommand(message.text)) {
						// 扩展命令通过Session.prompt即时处理并等待，不排成普通追问，即使原mode为followUp。
						await this.session.prompt(message.text);
						// 非命令且意图followUp才用追问队列。
					} else if (message.mode === "followUp") {
						// 等待共享输入扩展/模板展开/排队结果，不等待后续追问生成回答。
						await this.session.followUp(message.text);
					} else {
						// 其它已知模式steer走插话队列，具体在哪个回合边界取出由Agent策略决定。
						await this.session.steer(message.text);
					}
				}
				// 全部派发后重新读现有队列显示，不假定每条输入都必然queued（输入扩展可处理）。
				this.updatePendingMessagesDisplay();
				// 重试分支结束，不进入下面启动首普通prompt路径。
				return;
			}

			// Find first non-extension-command message to use as prompt
			// 找本批首个“不是当前扩展命令”的位置；普通/模板/技能等都可作为首prompt，不在这里先展开。
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			// findIndex为-1说明所有当前项都被识别为扩展命令。
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				// 全命令按原顺序串行处理，不并发执行多个handler。
				for (const message of queuedMessages) {
					// 等待每次Session.prompt命令处理，可能由扩展自己发消息/换会话，不能视作无副作用步骤。
					await this.session.prompt(message.text);
				}
				// 全命令完成就返回，无普通promptPromise，也不再做本函数末尾那次updatePendingMessagesDisplay。
				return;
			}

			// Execute any extension commands before the first prompt
			// 取首普通项前的扩展命令数组，新建外层slice，元素仍原引用。
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			// 按已找到的索引取首普通输入，作为启动/排入当前运行的prompt。
			const firstPrompt = queuedMessages[firstPromptIndex];
			// 其后全部项为rest，保持原顺序，其中仍可能混扩展命令/两种普通意图。
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			// 先串行执行首普通项之前的命令，防它们被重排到prompt后面。
			for (const message of preCommands) {
				// 动态this.session取当前会话，前一扩展命令若替换Runtime，后项会使用新的会话。
				await this.session.prompt(message.text);
			}

			// Start a prompt when idle, or queue it into a run still finishing compaction.
			// 发起首prompt并保存其带catch的Promise，不在这行await；下方排余项可与首prompt的异步预检/运行重叠。
			const promptPromise = this.session
				// 传原text和原mode，空闲可开run、忙碌可按steer/followUp排队，不强行要求此刻必须idle。
				.prompt(firstPrompt.text, { streamingBehavior: firstPrompt.mode })
				// 首prompt之后若拒绝，在这条后台链捕获；外层try不会由于未来拒绝自动跳转catch。
				.catch((error) => {
					// 恢复整个本批而非仅firstPrompt，已执行的preCommands也可能再次出现在待重试列表；不声称回滚或精确一次执行。
					restoreQueue(error);
				});

			// Queue remaining messages
			// 首prompt已发起后依序处理rest，不等首回答完成再开始排它们。
			for (const message of rest) {
				// 扩展命令仍优先即时执行，可能影响运行/会话/后续分类。
				if (this.isExtensionCommand(message.text)) {
					// 等待该命令处理，不传普通队列mode。
					await this.session.prompt(message.text);
					// 其余followUp项走追问队列，不抢占现有工具/插话。
				} else if (message.mode === "followUp") {
					// await其输入处理/排队派发，不代表等待模型回答。
					await this.session.followUp(message.text);
				} else {
					// steer项同样走共享插话入口，而不是直接改Agent.state.messages。
					await this.session.steer(message.text);
				}
			}
			// 余项派发正常结束后重画当前队列，首prompt仍可能未完成或稍后失败触发恢复。
			this.updatePendingMessagesDisplay();
			// 明确丢弃promptPromise，不await也不加第二个catch；其恢复回调若再抛错仍可成为未观察拒绝。
			void promptPromise;
			// 捕获try内同步错误与被await步骤拒绝，可能在首prompt已经启动后发生。
		} catch (error) {
			// 同样恢复整个本批；首prompt的独立catch日后也可再次调用恢复，本函数没有统一一次性错误门禁。
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	// 把暂存Bash显示组件从pending区挪到聊天区并清本地列表，返回void；用于下一条普通消息提交前保持视觉顺序。
	// 不执行Bash、不新增Session记录，也不在这里单独requestRender；组件此前若已从pending摘掉，removeChild可无操作后仍追加聊天。
	private flushPendingBashComponents(): void {
		// 按本地pendingBashComponents顺序处理同一对象引用，不新建卡片。
		for (const component of this.pendingBashComponents) {
			// 从pending容器删除这项，不要求它一定仍在该容器（队列预览重建可能已清children）。
			this.pendingMessagesContainer.removeChild(component);
			// 追加已有完整/部分输出卡片到聊天，原动画状态也随对象保留。
			this.chatContainer.addChild(component);
		}
		// 处理完替换为空数组，后续不会从这个列表再次移动相同项；没有dispose这些仍在聊天的组件。
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	// 使当前普通选择器令牌失效并调用其可选清理器，返回void；例扩展对话接管输入前先释放原模型菜单资源。
	// 不清扩展对话栈、不自己恢复编辑器/焦点，也不直接requestRender；字段先清，再调用dispose，异常不会把令牌自动还原。
	private disposeActiveSelector(): void {
		// 保存当前清理器局部引用，清字段后仍能执行它。
		const dispose = this.activeSelectorDispose;
		// 先清令牌，让旧done回调知道自己不再是当前选择器。
		this.activeSelectorToken = undefined;
		// 清本实例的dispose槽，后续不再从这里重复找到同一清理器。
		this.activeSelectorDispose = undefined;
		// 有函数才同步调用，不自动await任何异步资源停止；回调抛错直接传播。
		dispose?.();
	}

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	// 在输入槽显示一个普通选择器，工厂接done并返回显示组件/焦点目标/可选dispose，返回void；例设置面板外壳显示但内部SettingsList接键盘。
	// 用唯一token避免旧done把新选择器换回编辑器：create后保存dispose、撤旧选择器、登记新token、挂组件/焦点/请求帧。
	// 工厂在新token生效前执行，若同步调用done会因身份不符略过恢复，之后仍安装返回组件；done先dispose再检查身份，旧回调也可能重复清理，没有全流程异常回滚。
	// 这是单槽替换机制，不是扩展对话栈；done本身未requestRender，由菜单回调或输入后TUI重绘安排。
	private showSelector(
		// 工厂返回结构把外层component与实际focus组件分开，dispose可缺；类型声明不执行创建。
		create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
		// showSelector不返回用户选择Promise，选择通过菜单自身回调通知宿主。
	): void {
		// 空对象只用作唯一身份，不存路径/命令名，引用不同即可区分两次打开。
		const token = {};
		// 先声明可选清理器，工厂返回后才赋值，所以创建期间done看见的还是undefined。
		let dispose: (() => void) | undefined;
		// 局部done用于关闭/恢复输入，闭包捕获本次token与稍后赋值的dispose。
		const done = () => {
			// 先调用清理器，再检查是否仍当前；重复/旧done也可调用dispose，不保证只清理一次。
			dispose?.();
			// 不是当前令牌则不改新界面/焦点，防异步旧菜单完成覆盖新菜单。
			if (this.activeSelectorToken !== token) return;
			// 当前菜单完成先清活动令牌，后面操作异常也不自动恢复它。
			this.activeSelectorToken = undefined;
			// 清活动dispose槽，防之后disposeActiveSelector再从此槽找到它。
			this.activeSelectorDispose = undefined;
			// 清输入槽children，未清扩展对话栈或聊天。
			this.editorContainer.clear();
			// 恢复调用此刻的this.editor，可能已被扩展换过，不固定保存打开菜单前对象。
			this.editorContainer.addChild(this.editor);
			// 把焦点交活动编辑器；本闭包不额外requestRender，调用方一般另请求/由输入调度触发。
			this.ui.setFocus(this.editor);
		};
		// 现在同步运行工厂，旧选择器仍是当前token；工厂同步done的行为与正常稍后回调不同。
		const created = create(done);
		// 把返回的可选清理器放闭包槽，供done/活动清理引用。
		dispose = created.dispose;
		// 新对象已经创建后才清旧选择器；旧dispose抛错时新对象未挂载且没有这里的自动销毁。
		this.disposeActiveSelector();
		// 登记本次唯一token，从此稍后done才有资格恢复输入槽。
		this.activeSelectorToken = token;
		// 保存本次清理器供下一次替换/stop调用。
		this.activeSelectorDispose = dispose;
		// 清旧显示组件，下一行挂新外壳。
		this.editorContainer.clear();
		// 挂工厂返回component，不重新包装它或验证render形状。
		this.editorContainer.addChild(created.component);
		// 焦点可指组件内部列表，不要求等于外壳component。
		this.ui.setFocus(created.focus);
		// 请求帧展示新菜单，工厂异步工作/用户最终选择不在这个返回值里等待。
		this.ui.requestRender();
	}

	// 打开主设置菜单，返回void；取当前设置/会话/主题快照，提供各项即时修改回调，再让普通选择器把焦点交内部SettingsList。
	// 例如改终端图片显示会保存用户偏好并更新已画工具组件，改传输会同时改当前Agent字段；不同设置的即时应用范围不同，不能说全部历史/全部进程状态都自动同步。
	// 多数setter是改内存+排队保存，不等磁盘完成；菜单取消只关闭不撤销已改项。主题枚举/能力查询可读本地环境，预热/HTTP等回调可协调实际工作，构造/回调异常未统一回滚。
	private showSettingsSelector(): void {
		// 普通菜单工厂接done用于关闭，菜单自身不创建独立结果Promise。
		this.showSelector((done) => {
			// let先留空使回调可稍后引用selector（如切屏被拒时改回显示值）；构造完成前不假定已赋值。
			let selector: SettingsSelectorComponent | undefined;
			// 读已保存默认供应商，区别于当前Session.model.provider。
			const defaultProvider = this.settingsManager.getDefaultProvider();
			// 读已保存默认模型ID，可能与本会话临时选择不同。
			const defaultModelId = this.settingsManager.getDefaultModel();
			// 两者都真值才拼完整默认身份，否则用not set；供每模型思考菜单排序/预选，不是这份菜单直接设置默认模型的回调。
			const defaultModel = defaultProvider && defaultModelId ? `${defaultProvider}/${defaultModelId}` : "not set";
			// 构造菜单外壳，下面第一个对象是Config快照，第二个对象是Callbacks能力；TS据构造签名给回调参数推断类型。
			selector = new SettingsSelectorComponent(
				// 配置只在打开时收集，不自动订阅所有之后会话变更。
				{
					// 自动压缩当前开关来自Session getter，尚未因此执行摘要。
					autoCompact: this.session.autoCompactionEnabled,
					// 属性简写传刚拼的默认身份说明。
					defaultModel,
					// 当前模型引用供菜单标记，可undefined，不强行用默认模型补齐。
					currentModel: this.session.model,
					// 现有可用目录快照用于模型思考配置子菜单，读取不刷新认证/网络。
					availableDefaultModels: this.session.modelRuntime.getAvailableSnapshot(),
					// 终端工具图像显示偏好，与向模型发送图片策略分开。
					showImages: this.settingsManager.getShowImages(),
					// 图片列宽是终端字符格，不是像素尺寸。
					imageWidthCells: this.settingsManager.getImageWidthCells(),
					// 输入图片自动缩放偏好影响后续图片处理，不代表终端是否显示图片。
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					// 阻止向模型传图的偏好，开启不会在这个菜单删已有图片文件。
					blockImages: this.settingsManager.getBlockImages(),
					// 是否提供/skill:name补全/命令入口，和技能资源是否加载不是同一开关。
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					// 当前Agent插话队列投递策略，不是当前队列文字列表。
					steeringMode: this.session.steeringMode,
					// 追问的all/one-at-a-time策略单独读取。
					followUpMode: this.session.followUpMode,
					// 模型请求传输偏好，具体provider仍决定是否支持SSE/WebSocket等。
					transport: this.settingsManager.getTransport(),
					// /share默认目的地auto/gist/radius，取配置不上传任何会话。
					sessionShareDestination: this.settingsManager.getSessionShareDestination(),
					// HTTP头/正文空闲预算毫秒，不是每个任务总时长。
					httpIdleTimeoutMs: this.settingsManager.getHttpIdleTimeoutMs(),
					// 缓存预热模式来自设置，菜单本身不在这一行发起预热。
					cacheWarmingMode: this.settingsManager.getCacheWarmingMode(),
					// 这里是全局默认思考级别或共享默认常量，用于每模型覆盖说明，不等同session当前有效级别。
					thinkingLevel: this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
					// 拷贝完整THINKING_LEVEL_OPTIONS给配置；当前SettingsSelector未读取这个保留字段，实际每模型候选由能力另定，不可据它声称所有模型支持所有级别。
					availableThinkingLevels: [...THINKING_LEVEL_OPTIONS],
					// 读取provider/modelId到思考覆盖的字典，菜单构造会复制一份跟踪交互变化。
					modelThinkingLevels: this.settingsManager.getAllModelThinkingLevels(),
					// 主题选择优先控制器内存/设置，空串也因||回system；可能是light/dark配对，不一定等于当前实例名。
					currentTheme: this.themeController.getThemeSelection() || SYSTEM_THEME_NAME,
					// 取终端明暗已有判定，不在这个getter主动发颜色查询。
					terminalTheme: this.themeController.getTerminalTheme(),
					// 枚举可用主题名称，可能读用户自定义主题目录/JSON，不是只访问一份常量数组。
					availableThemes: getAvailableThemes(),
					// 用本实例当前thinking显示标志，可能由刚才快捷键改过。
					hideThinkingBlock: this.hideThinkingBlock,
					// Mermaid展示off/final/streaming偏好，不决定模型推理算法。
					mermaidRenderingMode: this.settingsManager.getMermaidRenderingMode(),
					// 启动更新日志折叠偏好，改变后不会在此自动把已展示通知重建。
					collapseChangelog: this.settingsManager.getCollapseChangelog(),
					// 安装遥测设置值快照，实际发送还会受PI_TELEMETRY/PI_OFFLINE等策略约束。
					enableInstallTelemetry: this.settingsManager.getEnableInstallTelemetry(),
					// 空编辑器双Escape行为可tree/fork/none，菜单不直接执行该动作。
					doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
					// 树菜单初始过滤模式，不在这份主菜单筛会话树。
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					// 硬件光标偏好，不等于当前哪个组件拥有焦点。
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					// 缓存成本/恢复诊断显示开关，不是开启/关闭供应商提示词缓存。
					showCacheMissNotices: this.settingsManager.getShowCacheMissNotices(),
					// 用户层默认项目信任政策，只作为未来决策回退，不等于当前项目已经可信。
					defaultProjectTrust: this.settingsManager.getDefaultProjectTrust(),
					// 当前编辑器水平padding设置，实际组件可还有自身留白/边框。
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					// 输出左右留白0或1，和编辑器padding不是同一个字段。
					outputPad: this.settingsManager.getOutputPad(),
					// 补全菜单可见项数，不限制提供者总候选数。
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					// 启动简化配置true/header/false，菜单改变影响后续启动显示，不直接拆已建页头。
					quietStartup: this.settingsManager.getQuietStartup(),
					// 内容收缩是否清理旧行，具体TUI行为由渲染器消费。
					clearOnShrink: this.settingsManager.getClearOnShrink(),
					// 终端OSC进度显示偏好，不在读取时发送控制码。
					showTerminalProgress: this.settingsManager.getShowTerminalProgress(),
					// 实际当前ui.mode作菜单初始值，避免仅用可能被启动选项覆盖的存储配置。
					tuiMode: this.ui.mode,
					// 全屏退出后输出transcript或resume-hint，不在菜单读取时真的退出。
					fullscreenExitOutput: this.settingsManager.getFullscreenExitOutput(),
					// 全屏滚动条策略，普通屏可先保存供以后切换。
					fullscreenScrollbar: this.settingsManager.getFullscreenScrollbar(),
					// 全屏选中自动复制偏好，不读取已有选区文字。
					fullscreenCopyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
					// 滚轮每步行数或auto，与文档总高度/终端行数不同。
					fullscreenWheelScrollLines: this.settingsManager.getFullscreenWheelScrollLines(),
					// 警告开关字典，菜单复制后改项，不是当前诊断消息集合。
					warnings: this.settingsManager.getWarnings(),
				},
				// 回调对象按SettingsCallbacks上下文推断参数类型，运行时仍是普通函数，菜单每次修改即时调用；没有统一“退出时提交”事务。
				{
					// 自动压缩开关回调，例false保存禁用并同步页脚，不当场取消已在进行的压缩。
					onAutoCompactChange: (enabled) => {
						// Session只写自动压缩设置，不调用compact，也不更改手动压缩入口。
						this.session.setAutoCompactionEnabled(enabled);
						// 页脚显示同步新值，不等下一次Session事件。
						this.footer.setAutoCompactEnabled(enabled);
					},
					// 终端图片显示回调，例false更新已有工具行的图像展示；不控制图片是否发送模型。
					onShowImagesChange: (enabled) => {
						// 先写用户层偏好并排队保存，后续组件更新失败不会回滚这份设置。
						this.settingsManager.setShowImages(enabled);
						// 只遍历聊天直接子项，不递归扩展嵌套组件/其他容器。
						for (const child of this.chatContainer.children) {
							// 真正ToolExecutionComponent才用专用图片setter，其他图片显示组件不在此强制更新。
							if (child instanceof ToolExecutionComponent) {
								// 设置展示开关并重建工具显示，不删除原结果content中的图块。
								child.setShowImages(enabled);
							}
						}
					},
					// 工具图片宽度回调，例80调整现有工具图的显示列宽，先保存再遍历。
					onImageWidthCellsChange: (width) => {
						// 存设置值，具体规范规则由SettingsManager处理，未等待flush。
						this.settingsManager.setImageWidthCells(width);
						// 同样只更新聊天直接工具行，不重建整个会话。
						for (const child of this.chatContainer.children) {
							// instanceof缩窄到支持该setter的显示类。
							if (child instanceof ToolExecutionComponent) {
								// 组件setter按自身规则floor/至少1并重建显示，不在此重新调用模型图片处理。
								child.setImageWidthCells(width);
							}
						}
					},
					// 输入图片自动缩放偏好回调，例false只改后续模型输入图片处理设置，不遍历终端工具行。
					onAutoResizeImagesChange: (enabled) => {
						// 保存到设置，已经发出的模型请求/已缩放字节不会在此回滚。
						this.settingsManager.setImageAutoResize(enabled);
					},
					// 模型图片阻止回调，例true影响后续传图，不代表删除历史图片或隐藏终端显示。
					onBlockImagesChange: (blocked) => {
						// 只保存策略，真正过滤/报错在输入处理路径消费它。
						this.settingsManager.setBlockImages(blocked);
					},
					// 技能命令开关回调，例关闭后重建基础补全，不把已加载技能资源从loader删除。
					onEnableSkillCommandsChange: (enabled) => {
						// 保存用户偏好，设置自身不执行资源发现。
						this.settingsManager.setEnableSkillCommands(enabled);
						// 重新建命令/技能Map并套现有wrapper，编辑器立即取得新补全入口。
						this.setupAutocompleteProvider();
					},
					// 插话策略回调，例one-at-a-time只改变以后队列取法，不重排现有文字。
					onSteeringModeChange: (mode) => {
						// Session同时更新Agent策略与设置，不由UI直接操纵内部消息数组。
						this.session.setSteeringMode(mode);
					},
					// 追问策略同理，例all表示下一次可消费全部追问，不表示立刻打断工具。
					onFollowUpModeChange: (mode) => {
						// 委托Session同步Agent和偏好两处状态。
						this.session.setFollowUpMode(mode);
					},
					// 传输偏好回调，例auto同时保存并给当前Agent；具体provider仍可选择支持的传输。
					onTransportChange: (transport) => {
						// 先排队保存偏好，不新建模型客户端或主动测试连接。
						this.settingsManager.setTransport(transport);
						// 更新当前Agent.transport影响后续请求选项，不保证迁移已经建立的连接/在途请求。
						this.session.agent.transport = transport;
					},
					// 分享目的地回调，例gist只为以后/share保存选择，不立即创建gist。
					onSessionShareDestinationChange: (destination) => {
						// SettingsManager排队存目的地，认证/上传留实际分享流程。
						this.settingsManager.setSessionShareDestination(destination);
					},
					// HTTP空闲超时回调，例0禁对应预算；先保存、再配置全局调度器、最后显示规范文字。
					onHttpIdleTimeoutMsChange: (timeoutMs) => {
						// 设置值保存不意味着dispatcher已成功替换，下一调用若抛错无回滚。
						this.settingsManager.setHttpIdleTimeoutMs(timeoutMs);
						// 更新全局undici dispatcher/必要fetch，影响后续管理/模型HTTP使用，不是整个任务总超时。
						configureHttpDispatcher(timeoutMs);
						// 显示可读时间或禁用说明，格式辅助不启动网络请求。
						this.showStatus(`HTTP idle timeout: ${formatHttpIdleTimeoutMs(timeoutMs)}`);
					},
					// 预热模式回调，例off保存并通知已有warmer重新协调；不是仅换一条显示文字。
					onCacheWarmingModeChange: (mode) => {
						// Session保存用户模式并调用warmer.onModeChanged，实际取消/调度按warmer策略，可有真实后台工作。
						this.session.setCacheWarmingMode(mode);
						// 提示保存的模式，不把状态文字当预热请求已成功完成。
						this.showStatus(`Cache warming: ${mode}`);
					},
					// 每模型思考覆盖回调，例为provider/id设high；先存覆盖，身份等于当前模型才即时应用会话级别。
					onModelThinkingLevelChange: (provider, modelId, level) => {
						// 键包含供应商与模型ID，避免同ID跨供应商覆盖，写用户层并排队保存。
						this.settingsManager.setModelThinkingLevel(provider, modelId, level);
						// If the override is for the current model, apply it to the session too
						// 取此刻当前模型，可能在菜单打开后已切换，不用构造时config.currentModel快照。
						const current = this.session.model;
						// 必须provider和id都严格相等才影响当前会话，其余覆盖仅供以后切到该模型使用。
						if (current && current.provider === provider && current.id === modelId) {
							// Session按模型支持钳制level，不将这里用户请求自动视作模型真实支持的预算。
							this.session.setThinkingLevel(level);
							// 当前级别更新后页脚重读。
							this.footer.invalidate();
							// 边框按新有效级别刷新，未发模型请求。
							this.updateEditorBorderColor();
						}
					},
					// 移除某provider/id的用户思考覆盖，若正是当前模型就显式应用全局默认；例删high后回默认medium（仍会按能力钳制）。
					onModelThinkingLevelRemove: (provider, modelId) => {
						// 删除用户层对应键并排队保存，不保证可信项目层同名覆盖也被删除。
						this.settingsManager.removeModelThinkingLevel(provider, modelId);
						// If the override was for the current model, revert to global default
						// 读取此刻会话模型，避免只按菜单打开时快照判断。
						const current = this.session.model;
						// 必须供应商与ID都匹配才改变当前会话，其他模型仅删配置。
						if (current && current.provider === provider && current.id === modelId) {
							// 明确读全局thinking默认或共享默认常量，不再按当前模型剩余的其他层覆盖重新推导。
							const globalDefault = this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
							// 将这一全局默认请求交Session钳制/记录，不能据删除操作宣称当前一定完全没有其他配置覆盖。
							this.session.setThinkingLevel(globalDefault);
							// 让页脚下次读新有效级别。
							this.footer.invalidate();
							// 边框同步当前会话显示，未保存新的全局thinking默认。
							this.updateEditorBorderColor();
						}
					},
					// 最终主题选择回调，例light/dark先保存配置再应用；和扩展UI.setTheme“成功后才保存名称”的路径顺序不同。
					onThemeChange: (themeSetting) => {
						// 先排队写用户主题设置，即使下面加载失败也没有这层回滚。
						this.settingsManager.setTheme(themeSetting);
						// 控制器保存内存覆盖、加载主题并发颜色查询；坏名称可回system但仍留之前保存的选择文字。
						this.themeController.setThemeSetting(themeSetting);
					},
					// 浏览主题时只调用preview，不执行SettingsManager.setTheme；预览也可能读文件/改全局主题并请求重绘，并非纯函数。
					onThemePreview: (themeName) => this.themeController.preview(themeName),
					// 思考块隐藏回调，例true改显示偏好并重建聊天助手，不把thinkingLevel设off。
					onHideThinkingBlockChange: (hidden) => {
						// 先更新本实例标记，新建消息也采用它。
						this.hideThinkingBlock = hidden;
						// 再排队保存用户显示偏好，不删除历史thinking。
						this.settingsManager.setHideThinkingBlock(hidden);
						// 更新聊天直接助手组件，清单段点击覆盖，保留工具组件实例。
						this.updateThinkingBlockVisibility();
					},
					// Mermaid显示时机回调，例final让流结束再绘图；保存后使现有聊天失效重算。
					onMermaidRenderingModeChange: (mode) => {
						// 保存off/final/streaming模式，不改模型提示词或工具参数。
						this.settingsManager.setMermaidRenderingMode(mode);
						// 让聊天孩子重新取Markdown变换结果，可能重新调用扩展显示回调。
						this.chatContainer.invalidate();
						// 显式请求重绘，不重新执行模型/历史工具。
						this.ui.requestRender();
					},
					// 缓存成本/诊断显示回调，例关闭需移除已画提醒，所以用全聊天重建而非只改一个字段。
					onShowCacheMissNoticesChange: (shown) => {
						// 先保存显示设置，不改变真正缓存是否启用。
						this.settingsManager.setShowCacheMissNotices(shown);
						// 清聊天按当前条目重画，工具显示对象/全屏选区会重建，不保留全部局部展开/选择状态。
						this.rebuildChatFromMessages();
					},
					// 更新启动日志折叠偏好，例true影响后续启动通知如何构造，不在这里拆当前已画通知。
					onCollapseChangelogChange: (collapsed) => {
						// 仅保存设置，没有调用showStartupNoticesIfNeeded重放。
						this.settingsManager.setCollapseChangelog(collapsed);
					},
					// 安装遥测开关回调，例false保存不再允许相应默认发送，实际环境覆盖/离线规则仍在发送入口。
					onEnableInstallTelemetryChange: (enabled) => {
						// 只存用户偏好，不当场发“已开启/关闭”遥测事件。
						this.settingsManager.setEnableInstallTelemetry(enabled);
					},
					// 启动简化配置回调，例header为以后启动保留页头；当前主菜单不重新执行init。
					onQuietStartupChange: (quiet) => {
						// 保存true/header/false，不在此清现有页头/资源组件。
						this.settingsManager.setQuietStartup(quiet);
					},
					// 用户默认信任政策回调，例ask改变未来无已存决定时的回退，不立即把当前目录授信/撤信。
					onDefaultProjectTrustChange: (defaultProjectTrust) => {
						// 只排队保存默认政策，不调用ProjectTrustStore.set或重载项目代码。
						this.settingsManager.setDefaultProjectTrust(defaultProjectTrust);
					},
					// 双Escape行为回调，例none停用空输入双击导航，之后按键处理现读此设置。
					onDoubleEscapeActionChange: (action) => {
						// 保存动作名字，不在此打开树/分叉菜单。
						this.settingsManager.setDoubleEscapeAction(action);
					},
					// 树默认筛选回调，例user-only供以后树菜单初始显示，不修改会话条目。
					onTreeFilterModeChange: (mode) => {
						// 仅保存偏好，当前SettingsSelector不是树组件。
						this.settingsManager.setTreeFilterMode(mode);
					},
					// 硬件光标回调，例false既保存又更新当前TUI策略，和编辑器focused无关。
					onShowHardwareCursorChange: (enabled) => {
						// 先存偏好，实际输出异常不在这里回滚它。
						this.settingsManager.setShowHardwareCursor(enabled);
						// 将布尔给当前TUI，光标如何在帧中定位仍由底层渲染。
						this.ui.setShowHardwareCursor(enabled);
					},
					// 编辑器边距回调，例2更新默认和有能力的自定义编辑器；菜单正常给固定档位，不把number类型视作范围验证。
					onEditorPaddingXChange: (padding) => {
						// SettingsManager按自己的范围规则规范/保存，但下面直接传原回调padding，不重新读归一后的值。
						this.settingsManager.setEditorPaddingX(padding);
						// 默认编辑器即时设置水平留白，由组件自身处理合法范围/失效。
						this.defaultEditor.setPaddingX(padding);
						// 只有活动对象不同且提供setter时再更新，缺能力不强行写入任意属性。
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							// 自定义编辑器也收到原padding，是否采用/如何布局由它实现。
							this.editor.setPaddingX(padding);
						}
					},
					// 输出边距回调，例0让支持setOutputPad的聊天/待显示直接子组件贴近边缘；不等于编辑器padding。
					onOutputPadChange: (padding) => {
						// 先保存用户设置，callback类型是0|1，正常TS调用受字面量限制。
						this.settingsManager.setOutputPad(padding);
						// 更新本实例字段，之后新消息组件用新padding。
						this.outputPad = padding;
						// 只遍历聊天和pending两个容器，不含资源列表/扩展上下挂件/页头页脚。
						for (const container of [this.chatContainer, this.pendingMessagesContainer]) {
							// 逐个直接子项探测，不递归任意深度组件树。
							for (const child of container.children) {
								// 动态能力字段需存在且为函数才调用，Component接口本身没有统一setOutputPad方法。
								if ("setOutputPad" in child && typeof child.setOutputPad === "function") {
									// 调用该组件自己的setter，不强制重建整个聊天；扩展方法同步抛错可打断后续遍历。
									child.setOutputPad(padding);
								}
							}
						}
						// 请求显示边距变化，不更改原消息文字或token计数。
						this.ui.requestRender();
					},
					// 补全可见项数回调，例10只改变菜单窗口，不删提供者的其余候选。
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						// 保存设置，SettingsManager可规范范围；下面仍使用回调原maxVisible。
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						// 默认编辑器即时接收新值。
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						// 活动自定义编辑器不同且有对应setter才同步，不保证任意扩展组件都会响应。
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							// 将同一原值交自定义实现，不在UI层复制其补全内部状态。
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					// 收缩清屏回调，例false保存并更新TUI，当前无活动指示器时移除状态占位。
					onClearOnShrinkChange: (enabled) => {
						// 先保存偏好，不立刻手工擦旧终端行。
						this.settingsManager.setClearOnShrink(enabled);
						// 渲染器后续帧使用该策略，具体清屏规则在TUI实现。
						this.ui.setClearOnShrink(enabled);
						// 只有禁用且没活跃指示器才清状态容器，不误删现有工作对象。
						if (!enabled && !this.activeStatusIndicator) {
							// 清区域包括可能IdleStatus，不是清所有聊天消息。
							this.statusContainer.clear();
						}
					},
					// 终端进度开关回调，例false这里只保存，不立即调用setProgress(false)或重配已有进度计时器。
					onShowTerminalProgressChange: (enabled) => {
						// 后续事件/stop路径按各自设置门禁决定写进度，不能据本setter承诺当前进度马上消失。
						this.settingsManager.setShowTerminalProgress(enabled);
					},
					// TUI模式回调，例regular→fullscreen先尝试迁移；有overlay阻止真实切换时恢复菜单显示值并不保存请求模式。
					onTuiModeChange: (mode) => {
						// switchTuiMode同模式直接true，真实换模式有浮层条目则false；没有这里的catch保护内部终端/构造异常。
						if (!this.switchTuiMode(mode)) {
							// 若selector已经赋值就把tui-mode一项恢复实际ui.mode，避免菜单显示未成功的请求值。
							selector?.getSettingsList().updateValue("tui-mode", this.ui.mode);
							// 提醒先关闭浮层，不在这里强制hideOverlay替用户消除阻碍。
							this.showStatus("Close active overlays before changing TUI mode");
							// 拒绝时直接结束回调，后面的SettingsManager.setTuiMode不会执行。
							return;
						}
						// 切换成功后才排队保存模式，运行时options由switchTuiMode已同步更新。
						this.settingsManager.setTuiMode(mode);
						// 没有活动指示器就清旧状态占位，不动仍在运行的状态对象。
						if (!this.activeStatusIndicator) this.statusContainer.clear();
						// 显示实际接受的mode，showStatus会请求帧。
						this.showStatus(`TUI mode: ${mode}`);
					},
					// 全屏退出输出回调，例resume-hint只存未来退出策略，不当场切屏/退出。
					onFullscreenExitOutputChange: (output) => {
						// 保存transcript/resume-hint，由stop默认参数以后读取。
						this.settingsManager.setFullscreenExitOutput(output);
					},
					// 滚动条回调，例always保存并更新已建transcript视图，普通模式也可先准备以后切全屏使用。
					onFullscreenScrollbarChange: (mode) => {
						// 存当前策略，不触发文件检索/聊天请求。
						this.settingsManager.setFullscreenScrollbar(mode);
						// 有ScrollView就设置，缺视图则可选链跳过，不新建布局。
						this.applyFullscreenScrollbarSetting();
					},
					// 全屏选中复制回调，例false保存并仅在当前确为备用屏时即时应用，不读取或复制现有文字。
					onFullscreenCopyOnSelectChange: (enabled) => {
						// 先保存偏好，供以后新建TuiAltScreen使用。
						this.settingsManager.setFullscreenCopyOnSelect(enabled);
						// instanceof后才调全屏专用setCopyOnSelect，普通屏不需要相同方法。
						if (this.renderer instanceof TuiAltScreen) this.renderer.setCopyOnSelect(enabled);
					},
					// 全屏滚轮策略回调，例auto保存并在当前备用屏即时配置，不主动滚动记录。
					onFullscreenWheelScrollLinesChange: (lines) => {
						// 存number/auto联合偏好，规范规则交SettingsManager。
						this.settingsManager.setFullscreenWheelScrollLines(lines);
						// 只给当前真实TuiAltScreen设置，未来新实例再从设置取值。
						if (this.renderer instanceof TuiAltScreen) this.renderer.setWheelScrollLines(lines);
					},
					// 警告字典回调，例关闭Anthropic提醒保存偏好，不删除聊天里已经显示过的旧警告。
					onWarningsChange: (warnings) => {
						// 整份warnings交设置管理器处理，未在此重新做认证检查。
						this.settingsManager.setWarnings(warnings);
					},
					// 主菜单取消/退出回调，关闭面板并请求帧；此前每项已即时应用/排队保存，不回滚。
					onCancel: () => {
						// done撤当前普通选择器身份并恢复editor/焦点。
						done();
						// 显式请求显示恢复，补上done本身没有requestRender的行为。
						this.ui.requestRender();
					},
				},
			);
			// 外层selector负责边框，实际focus给内部SettingsList，才能处理搜索/设置项输入。
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	// 按可选文字处理/thinking，返回void；无真值参数打开选择器，有参数先trim/小写再精确匹配当前支持级别。
	// 例HIGH匹配high，未知值列可选项；不做模糊匹配、不把任意数字当token预算，失败只提示，成功只改当前会话（persist:false）。
	private handleThinkingCommand(searchTerm?: string): void {
		// 现取当前模型允许级别，无模型时Session按契约给全列表，不请求服务端能力探测。
		const availableLevels = this.session.getAvailableThinkingLevels();
		// 参数真值判断先于trim，undefined/空串开菜单，直接传纯空白字符串则会继续查空规范文字。
		if (!searchTerm) {
			// 打开当前级别/默认级别都可标记的选择器，不在此先应用某个级别。
			this.showThinkingSelector();
			// 无参数不继续精确搜索。
			return;
		}

		// 只裁两端空白和转小写，不解析thinking后缀或别名。
		const normalized = searchTerm.trim().toLowerCase();
		// find按忽略大小写的完整级别文字比较，找不到undefined，不按前缀选第一个。
		const level = availableLevels.find((candidate) => candidate.toLowerCase() === normalized);
		// 未找到才报Unknown，不把off真值字符串误作关闭/无结果。
		if (!level) {
			// 错误包含原searchTerm与当前availableLevels，未更改Session级别。
			this.showError(`Unknown thinking level "${searchTerm}". Available levels: ${availableLevels.join(", ")}.`);
			// 失败后不打开另一个菜单或自动降级到默认级别。
			return;
		}

		// 找到则调用统一选择助手，false表示只改会话，不保存全局thinking默认。
		this.selectThinkingLevel(level, false);
	}

	// 应用请求思考级别并同步页脚/边框/状态，输入level与是否persist，返回void；例persist:true更新用户默认请求值，实际模型可能钳制到支持级别。
	// try包设置和显示，错误显示但不回滚已改状态；提示使用传入level，不重新读取钳制后的有效级别，因此不能据文案保证实际恰好相同。
	private selectThinkingLevel(level: ThinkingLevel, persist: boolean): void {
		// 捕获Session设置或同步UI更新异常，不是等待所有后台扩展事件完成的事务。
		try {
			// 属性简写{persist}交会话，保存请求偏好与有效级别记录按Session规则分开。
			this.session.setThinkingLevel(level, { persist });
			// 页脚失效以读取当前有效值。
			this.footer.invalidate();
			// 边框颜色按实际Session级别更新，而非只用参数level拼颜色。
			this.updateEditorBorderColor();
			// 根据persist选择Default前缀，数值仍显示原level，保留原语义。
			this.showStatus(persist ? `Default thinking level: ${level}` : `Thinking level: ${level}`);
			// 捕获任意抛出值，设置可能已部分写入/排队保存，不自动撤销。
		} catch (error) {
			// Error取message，其余String；显示失败自身还可继续抛出。
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	// 打开思考级别菜单，普通确认只改会话，设默认动作带persist:true，取消仅关闭；返回void，实际选择由回调完成。
	// 例如菜单从high确认medium后用统一助手更新；助手把错误转提示后仍返回，因此selectLevel随后也会done关闭，不保证失败时保留菜单。
	private showThinkingSelector(): void {
		// 以普通选择器机制接done，和扩展对话栈不同。
		this.showSelector((done) => {
			// 局部选择回调接级别/持久标记，统一应用后关闭，省重复处理代码。
			const selectLevel = (level: ThinkingLevel, persist: boolean) => {
				// 应用并显示结果，内部catch不向此回调返回success标志。
				this.selectThinkingLevel(level, persist);
				// 不论助手是否仅显示错误都调用done，恢复当前输入编辑器。
				done();
			};
			// 构造搜索/选择面板，不在构造时调用Session.setThinkingLevel。
			const selector = new ThinkingSelectorComponent(
				// 当前会话级别预选，??仅缺省才回共享默认常量。
				this.session.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
				// 候选来自当前模型能力，不因默认级别在列表外而强行加入。
				this.session.getAvailableThinkingLevels(),
				// 普通确认使用false，只改当前会话。
				(level) => selectLevel(level, false),
				// 取消回调不改级别或默认偏好。
				() => {
					// done恢复editor/焦点并清普通选择器槽。
					done();
					// 取消后明确请求重绘。
					this.ui.requestRender();
				},
				// 设默认动作使用true，同时按Session规则应用会话级别并保存请求默认。
				(level) => selectLevel(level, true),
				// 已存全局默认只供菜单标记default，不决定当前会话勾选或覆盖候选能力。
				this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
			);
			// 外壳本身实现Focusable并路由输入，所以component与focus都给selector同一实例。
			return { component: selector, focus: selector };
		});
	}

	// 处理/model后的可选搜索文字，返回Promise<void>；无文字开菜单，有精确命中就切换当前会话模型，否则带查询开菜单。
	// 例如/model p/demo先查已有候选，必要时刷新目录；这里不发送聊天来试用模型，设置失败显示错误，不把本次选择保存为全局默认。
	private async handleModelCommand(searchTerm?: string): Promise<void> {
		// undefined和空字符串都走无查询菜单；本方法未先trim，因此直接传空白仍会走查找路径。
		if (!searchTerm) {
			// 打开模型选择界面，菜单自己的目录刷新和确认回调在showModelSelector中处理。
			this.showModelSelector();
			// 菜单打开后结束命令，不继续精确查找。
			return;
		}

		// 等待精确匹配；这一await位于下面切换用try之外，查找中未自行消化的异常会使本方法拒绝。
		const model = await this.findExactModelMatch(searchTerm);
		// 只有拿到模型对象才走直接切换；undefined也可能表示跨供应商引用有歧义。
		if (model) {
			// 捕获模型切换及后续同步界面更新的异常，不提供已发生修改的回滚。
			try {
				// 等待会话切换模型并通知扩展等；persist:false不改全局默认模型，检查认证配置不等一次真实聊天成功。
				await this.session.setModel(model, { persist: false });
				// 让页脚重新计算当前模型等内容。
				this.footer.invalidate();
				// 按新模型的思考状态更新编辑区边框。
				this.updateEditorBorderColor();
				// 显示本次模型ID，不把provider/id整体写成默认设置。
				this.showStatus(`Model: ${model.id}`);
				// 后台检查Anthropic订阅认证提示；void只丢弃Promise返回值，本辅助本身吞掉认证查询失败。
				void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
				// 切换或界面更新失败进入此分支；异常不一定是Error实例。
			} catch (error) {
				// 用Error.message或String(error)显示错误文字。
				this.showError(error instanceof Error ? error.message : String(error));
			}
			// 精确命中路径处理完即结束，即使切换失败也不会再开搜索菜单。
			return;
		}

		// 找不到唯一精确结果时保留原查询，供用户在选择器中继续搜索和确认。
		this.showModelSelector(searchTerm);
	}

	// 从当前范围/快照精确匹配模型，返回模型或undefined；无会话范围且缓存未命中时最多等待一次带15秒取消计时的目录刷新。
	// 例如范围只有p/a时查询p/b直接未命中，不扩大范围联网搜索；没有范围时可刷新后再查。这里不模糊匹配或解析思考档位后缀。
	// Model<any>保留原有宽泛API参数类型，不是运行时验证模型字段；共享刷新取消不保证底层所有工作停止。
	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		// 先选本次同步候选；const固定数组变量，不冻结其中模型对象。
		// 非空会话范围分支用map丢掉thinkingLevel包装，留下模型对象引用的新数组。
		// 无范围时展开复制最近可用快照，尚未发起刷新。
		const cachedModels =
			// 存在显式会话范围时优先使用范围，而非把它和可用快照再求交集。
			this.session.scopedModels.length > 0
				? this.session.scopedModels.map((scoped) => scoped.model)
				: [...this.session.modelRuntime.getAvailableSnapshot()];
		// 精确解析provider/id或裸ID；歧义返回undefined，不靠认证状态自动选一个。
		const cachedMatch = findExactModelReferenceMatch(searchTerm, cachedModels);
		// 已有匹配立即返回；只要范围非空，即使未匹配也返回，避免搜索越过范围。
		if (cachedMatch || this.session.scopedModels.length > 0) return cachedMatch;

		// 缓存未命中且无范围时，先告诉用户将刷新目录。
		this.showStatus("Refreshing model catalogs…");
		// 本次等待持有独立取消信号，不代表拥有并独占所有共享刷新任务。
		const controller = new AbortController();
		// 区分本地15秒计时取消与其他取消原因，用于选择提示文案。
		let timedOut = false;
		// 注册15秒后的回调，计时数字中的下划线只帮助阅读，数值仍是15000毫秒。
		const timeout = setTimeout(() => {
			// 先记下本地超时原因，再触发取消信号。
			timedOut = true;
			// 请求取消本调用的等待；不能据此断言远端请求已结束。
			controller.abort();
		}, 15_000);
		// 刷新失败也要继续用缓存搜索，所以在此捕获刷新阶段异常。
		try {
			// 异步协调模型目录刷新，具体Provider目录策略/认证由运行时处理，不是发送聊天问题。
			const result = await refreshModelCatalogs(this.session.modelRuntime, controller.signal);
			// 只有结果标记aborted且本地计时已触发时使用超时提示。
			if (result.aborted && timedOut) {
				// 告知用户改用缓存，不清空已经存在的模型快照。
				this.showWarning("Model refresh timed out; searching cached models.");
				// 否则若某些供应商刷新失败，列出其错误映射的键。
			} else if (result.errors.size > 0) {
				// 把供应商ID数组用逗号拼接成警告；不在这里展开每条底层错误详情。
				this.showWarning(`Could not refresh ${[...result.errors.keys()].join(", ")}; searching cached models.`);
			}
			// 刷新Promise拒绝或try内同步处理抛错进入这里。
		} catch (error) {
			// 把刷新失败转成非致命警告，后面仍继续精确查找。
			// 本地计时已触发时报告超时与缓存回退。
			// 其他异常取message或转字符串，保留可显示的失败原因。
			this.showWarning(
				// 按本地timedOut标志选择文案，而非只看异常类型。
				timedOut
					? "Model refresh timed out; searching cached models."
					: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`,
			);
			// 不论成功、警告或抛错，都执行计时器清理。
		} finally {
			// 取消尚未触发的超时回调；已触发的取消信号不会因此恢复。
			clearTimeout(timeout);
		}
		// 重取当时的可用快照再做精确匹配；这是当前this.session的运行时，不是开始查找时锁定不变的会话快照。
		return findExactModelReferenceMatch(searchTerm, [...this.session.modelRuntime.getAvailableSnapshot()]);
	}

	/** Update the footer's available provider count from the current snapshot without refreshing catalogs. */
	// 同步更新页脚的供应商种数，返回void；只读取范围或可用快照，不刷新目录、验证token或改变当前模型。
	// 例如三个模型分别属于p/p/q，计数为2；显式范围中的供应商即使不在可用快照里也按此范围计入。
	private updateAvailableProviderCount(): void {
		// 决定计数使用哪组模型，后续只提取provider字段。
		// 有会话范围时从包装中取模型对象，保留原对象引用。
		// 无范围使用运行时最近的可用快照，不await任何认证操作。
		const models =
			// 有会话范围则优先统计范围。
			this.session.scopedModels.length > 0
				? this.session.scopedModels.map((scoped) => scoped.model)
				: this.session.modelRuntime.getAvailableSnapshot();
		// map取供应商字符串、Set去重；不是模型数量，也不按显示名称合并。
		const uniqueProviders = new Set(models.map((model) => model.provider));
		// 把去重集合大小交页脚数据源；本方法不自行requestRender。
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	// 在Anthropic订阅认证场景显示一次费用提示，输入可省略模型，返回Promise<void>；认证查询失败静默忽略。
	// 先看开关/本实例提示标志/供应商，再查认证配置类型，必要时解析实际key前缀。getAuth可能刷新或保存OAuth/执行配置值命令，不是纯字符串检查。
	// 例如oauth配置已存在但token过期，checkAuth仍可能返回oauth并直接提示；这不是验证订阅账户额度或实际账单。
	private async maybeWarnAboutAnthropicSubscriptionAuth(
		// 默认参数在每次调用时取当前会话模型；明确传undefined也使用该默认值，类型仍允许最终没有模型。
		model: Model<any> | undefined = this.session.model,
	): Promise<void> {
		// 只有开关明确为false才禁用；未配置不会因undefined被当作关闭。
		if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
			// 关闭警告时不再做认证查询。
			return;
		}
		// 此InteractiveMode实例已显示过时跳过；并发调用在await前都可读到false，不是并发去重锁。
		if (this.anthropicSubscriptionWarningShown) {
			// 无需重复显示提示，返回已完成Promise。
			return;
		}
		// 无模型或provider不严格等于anthropic都跳过；不根据模型名称猜供应商。
		if (!model || model.provider !== "anthropic") {
			// 其他供应商不会由此触发Anthropic认证解析。
			return;
		}

		// 整段仅作提示用途，认证和展示抛错都会被下面空catch吞掉。
		try {
			// 先查认证配置分类，不刷新OAuth或发送验证聊天；可选访问允许没有认证结果。
			if ((await this.session.modelRuntime.checkAuth("anthropic"))?.type === "oauth") {
				// 在展示之前设已提示标志；即使展示失败，此标志也不会在catch里回滚。
				this.anthropicSubscriptionWarningShown = true;
				// 显示固定订阅认证警告，不读取供应商账单。
				this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
				// 已按oauth分类提示后就不再解析key。
				return;
			}
			// 按供应商解析实际认证，缺失返回undefined；字符串重载不额外应用某个模型的配置头。
			const apiKey = (await this.session.modelRuntime.getAuth(model.provider))?.auth.apiKey;
			// 以已定义的key前缀启发式判断，不把任意非空key都视作订阅认证。
			if (!isAnthropicSubscriptionAuthKey(apiKey)) {
				// 前缀不匹配或key缺失就结束，不发额外测试请求。
				return;
			}
			// 记录本实例已提示；这不修改凭据或用户警告设置。
			this.anthropicSubscriptionWarningShown = true;
			// 前缀启发式命中时显示同一固定提醒。
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
			// 忽略提示检查中的失败；不会因此阻止模型切换，但也不证明认证可用。
		} catch {
			// Ignore auth lookup failures for warning-only checks.
		}
	}

	// 重载后按先前记住的cwd补存隐式信任，返回是否本次确实写入true；可能读写trust.json及其锁目录，失败显示警告。
	// 必须记忆cwd完全相同、当前设置已可信、确有需信任资源，且没有继承到任何已存决定才补写。例如已有父目录false时只清待补存记忆并返回false；新写入成功则清记忆并返回true。
	private maybeSaveImplicitProjectTrustAfterReload(): boolean {
		// 读取当前会话工作目录，不使用process.cwd作为替代。
		const cwd = this.sessionManager.getCwd();
		// 用原字符串严格比较记忆目录和当前cwd；不是realpath等价判断。
		if (this.autoTrustOnReloadCwd !== cwd) {
			// 不是待补存目录就不操作信任文件。
			return false;
		}
		// 还要求本会话已可信且实际存在需要信任的项目资源；资源存在检查不等解析成功或执行授权保证。
		if (!this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) {
			// 条件不成立不清记忆，后续重载仍可再检查。
			return false;
		}

		// 按运行时服务的agentDir构造信任存储路径；构造本身不读文件，此调用位于下方try之外。
		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		// 捕获下面信任读取/保存等同步失败；前面的目录条件探测与存储构造不在这个try内。
		try {
			// 查询最近祖先的决定；false和true都表示已有决定，只有null允许补写。
			if (trustStore.get(cwd) !== null) {
				// 已有决定就清待补存记忆，避免以后再尝试覆盖。
				this.autoTrustOnReloadCwd = undefined;
				// 没有发生新保存，返回false。
				return false;
			}
			// 在存储自己的锁内读改写cwd的true；直接覆盖文件不提供断电原子事务或回滚保证。
			trustStore.set(cwd, true);
			// 保存成功后清掉待补存目录。
			this.autoTrustOnReloadCwd = undefined;
			// 本次已写入新的信任记录，返回true供调用者显示状态。
			return true;
			// 读取/保存等失败进入此处；先前记忆不在此被清除。
		} catch (error) {
			// 把失败变成界面警告，避免将其当作成功保存。
			this.showWarning(
				// 兼容Error与其他抛出值，保留固定提示前缀。
				`Could not save project trust after reload: ${error instanceof Error ? error.message : String(error)}`,
			);
			// 失败返回false，但不会自动把当前会话的可信状态改成false。
			return false;
		}
	}

	// 打开持久化项目信任菜单，返回void；读出当前目录命中的存储决定，用户确认时保存更新并提示重启。
	// 例如选择信任父目录会一起写父目录true并删除当前目录覆盖；本入口不即时重载项目扩展，也不修改当前设置的projectTrusted。
	private showTrustSelector(): void {
		// 捕获打开菜单时的会话cwd，后续确认保存使用这一目录产生的选项。
		const cwd = this.sessionManager.getCwd();
		// 存储路径来自当前运行时服务的agentDir，而非硬编码用户主目录。
		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		// 同步加锁读取最近祖先决定，可能创建锁父目录；这些操作在showSelector前，没有本地try/catch。
		const savedDecision = trustStore.getEntry(cwd);
		// 交普通选择器宿主挂载/聚焦，done用于关闭和恢复编辑区。
		this.showSelector((done) => {
			// 构造信任面板，只展示并交回选择数据，写存储由这里的回调做。
			const selector = new TrustSelectorComponent({
				// 属性简写传入捕获的cwd，面板生成选项时另做规范化。
				cwd,
				// 保存决定用于显示和原选项勾选，不是当前会话可信值。
				savedDecision,
				// 当前会话可信状态单独显示，可以与磁盘继承决定不同。
				projectTrusted: this.settingsManager.isProjectTrusted(),
				// 确认回调同步执行，没有await或失败回滚包装。
				onSelect: (selection) => {
					// 在一次存储锁内按顺序应用选项提供的多条更新；失败会向调用栈抛出，后续done不会执行。
					trustStore.setMany(selection.updates);
					// 写入成功后关闭菜单并恢复编辑区。
					done();
					// 显示保存结果和需要重启的说明，不谎称当前资源已经按新决定重载。
					this.showStatus(
						// 三元表达式按selection.trusted选标签，模板插入应用名。
						`Saved trust decision: ${selection.trusted ? "trusted" : "untrusted"}. Restart ${APP_NAME} for this to take effect.`,
					);
				},
				// 取消只关闭，不保存拒绝记录或撤销已存在决定。
				onCancel: () => {
					// 完成菜单生命周期，恢复编辑区。
					done();
					// 请求把取消后的编辑界面绘出。
					this.ui.requestRender();
				},
			});
			// 同一个面板既提供渲染组件也接收键盘输入；没有额外dispose回调。
			return { component: selector, focus: selector };
		});
	}

	// 打开可搜索模型菜单，输入可选初始查询，返回void；列表先显示已有目录，组件后台刷新，确认才切换会话模型。
	// 例如普通确认p/demo只改本会话，设默认动作还保存默认provider/id；关闭时dispose取消本选择器的刷新等待，不保证共享底层任务终止。
	private showModelSelector(initialSearchInput?: string): void {
		// 普通选择器宿主负责挂载、恢复编辑区和关闭时调用下方dispose。
		this.showSelector((done) => {
			// 本地异步确认函数接收模型和是否持久化；闭包后续读取当前this.session，不锁定创建菜单时的会话。
			const selectModel = async (model: Model<any>, persist: boolean) => {
				// 捕获切换及其后界面更新失败；已发生的会话/设置修改不自动撤销。
				try {
					// 等待会话切换，persist决定是否写全局默认；不能由此保证远端聊天一定成功。
					await this.session.setModel(model, { persist });
					// 按当前范围/快照重算页脚供应商种数。
					this.updateAvailableProviderCount();
					// 让页脚模型等内容失效以便重绘。
					this.footer.invalidate();
					// 更新编辑边框对应的思考状态。
					this.updateEditorBorderColor();
					// 切换成功后关菜单，清理其目录刷新等待。
					done();
					// 持久化动作显示完整provider/id，普通选择只显示模型ID。
					this.showStatus(persist ? `Default model: ${model.provider}/${model.id}` : `Model: ${model.id}`);
					// 后台启动订阅认证提醒，不等待它完成才结束模型选择。
					void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
					// 任何try内错误都会进此分支，包括done或状态展示异常。
				} catch (error) {
					// 失败也尝试关闭菜单；如果done自身再抛错，本回调Promise会拒绝。
					done();
					// 显示错误而不自动重开选择器。
					this.showError(error instanceof Error ? error.message : String(error));
				}
			};
			// 读取保存的默认供应商，用于标记默认项，不自动切换它。
			const defaultProvider = this.settingsManager.getDefaultProvider();
			// 读取保存的默认模型ID，与供应商组合才构成默认身份。
			const defaultModel = this.settingsManager.getDefaultModel();
			// 创建实际模型选择组件；构造会立即使用快照并启动它自己的目录刷新逻辑。
			const selector = new ModelSelectorComponent(
				// 传TUI接口供组件安排刷新和终端交互。
				this.ui,
				// 当前会话模型决定当前项展示，不等于下面存储默认模型。
				this.session.model,
				// 运行时提供快照和目录刷新协调，不在此直接拼HTTP请求。
				this.session.modelRuntime,
				// 把会话范围交组件；列表范围处理以组件实现为准，不等同Session.cycleModel的认证可用交集。
				this.session.scopedModels,
				// 普通确认回调返回异步selectModel的Promise，false明确只作会话选择。
				(model) => selectModel(model, false),
				// 取消回调只关闭并重绘，不选择默认项。
				() => {
					// 通知普通选择器宿主完成。
					done();
					// 请求恢复后的编辑区渲染。
					this.ui.requestRender();
				},
				// 透传初始搜索字符串，缺省undefined由选择器使用空查询。
				initialSearchInput,
				// 默认动作传true给同一切换流程，避免另写一套模型更新步骤。
				(model) => selectModel(model, true),
				// 两项都非空才传默认身份对象，否则不标记默认；这是&&真值判断而非模型存在性检查。
				defaultProvider && defaultModel ? { provider: defaultProvider, id: defaultModel } : undefined,
			);
			// 返回显示/焦点组件和关闭清理函数；dispose设置组件closed并取消它的刷新等待。
			return { component: selector, focus: selector, dispose: () => selector.dispose() };
		});
	}

	// 打开/scoped-models循环范围菜单，返回void；先按会话范围或保存模式建状态，改变勾选即时改会话范围，另行保存才写设置，后台刷新目录。
	// 例如只选p/a、p/b时用此顺序循环；全部启用、没有可用选中项等情况映成会话空范围，空范围含义是改用所有可用模型，并非禁用所有模型。取消菜单不回滚已改范围。
	private showModelsSelector(): void {
		// 复制当前可用目录数组，模型对象仍共用；let允许刷新后整体替换。
		let availableModels = [...this.session.modelRuntime.getAvailableSnapshot()];
		// 按provider/id拼完整身份并建Set，供成员判断；Set消除同字串重复，不校验ID里的斜杠。
		let availableModelIds = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
		// 读取打开时保存的enabledModels模式，后续刷新仍按这个捕获值解析，不重读外部设置改动。
		const configuredPatterns = this.settingsManager.getEnabledModels();
		// 保留打开时的范围数组引用，用来判断最初是否已有会话覆盖。
		const sessionScopedModels = this.session.scopedModels;
		// 本地纯解析函数接只读模型数组，返回显式ID数组或null；null表示没有保存过滤，既不刷新目录也不写设置。
		const configuredEnabledIds = (models: readonly Model<any>[]): string[] | null => {
			// 可选访问配合否定：未配置或长度0都返回null；保存[]在这里同样被当作无模式。
			if (!configuredPatterns?.length) return null;
			// 把保存模式与给定模型池解析，结果含按模式去重的范围和未匹配等诊断。
			const resolved = resolveModelScopeFromModels(configuredPatterns, models);
			// 从已解析范围提取完整ID；这里不保留模式中附带的思考档位文字。
			const ids = resolved.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
			// 逐项检查诊断，不在这里打印所有警告。
			for (const diagnostic of resolved.diagnostics) {
				// 只把未命中的原模式补进列表供失效配置展示，避免重复；歧义和非法档位诊断不直接补为ID。
				if (diagnostic.code === "no-match" && !ids.includes(diagnostic.pattern)) ids.push(diagnostic.pattern);
			}
			// 返回新数组，含有效模型ID及可能暂时失效的原模式。
			return ids;
		};

		// 初始菜单启用状态与会话是否已有范围有关，变量稍后会随用户操作或刷新替换。
		// 已有范围直接转换成provider/id数组，保留其顺序。
		// 否则在初始可用目录中解析设置，可能得到null代表全启用。
		let currentEnabledIds =
			// 显式会话范围优先于保存模式。
			sessionScopedModels.length > 0
				? sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)
				: configuredEnabledIds(availableModels);
		// 记录用户是否已动过选择，避免刷新完成时用旧保存模式覆盖用户刚做的选择。
		let selectionChanged = false;

		// 本地同步回调将菜单启用状态映射成Session循环范围，返回void；不保存设置、不切当前模型，刷新和用户改动均可调用。
		// 例如显式[a]且当前可用[a,b]建立[a]范围；显式[]没有可用选中项则清范围，Session随后循环所有可用项。
		const updateSessionModels = (enabledIds: string[] | null): void => {
			// null原样保存，数组先复制，避免持有调用者之后原地修改的列表。
			currentEnabledIds = enabledIds === null ? null : [...enabledIds];
			// 可选some找是否至少一个显式ID可用；null/undefined表达式用??回落false，不把false误替换成true。
			const hasEnabledAvailableModel = enabledIds?.some((id) => availableModelIds.has(id)) ?? false;
			// 判断显式选择是否覆盖所有当前可用身份。
			const allAvailableModelsEnabled =
				// 非null且所有Set项都被包含即为全覆盖；可用Set为空时every天然为true，并非必须有一个模型。
				enabledIds !== null && [...availableModelIds].every((id) => enabledIds.includes(id));
			// 只在有数组、有可用选中项、又没有全覆盖时设置非空循环范围；[]虽真值仍因some为false不进入。
			if (enabledIds && hasEnabledAvailableModel && !allAvailableModelsEnabled) {
				// 再次按当前可用目录解析显式列表，失效项不会凭空变成模型；此处不展示解析诊断。
				const newScopedModels = resolveModelScopeFromModels(enabledIds, availableModels).scopedModels;
				// 替换会话内存循环范围，不写全局设置或立即切换当前模型。
				this.session.setScopedModels(
					// map新建包装项，保留解析所得模型和可选档位。
					newScopedModels.map((scoped) => ({
						// 模型元数据对象沿用解析结果引用。
						model: scoped.model,
						// 透传本次解析出的thinkingLevel，可能为undefined；不是直接沿用旧会话包装档位。
						thinkingLevel: scoped.thinkingLevel,
					})),
				);
				// 其他状态统一映成无显式范围，包括全启用、无可用选择和null。
			} else {
				// Session中[]意味着循环时使用全部可用快照，不能解释成禁用全部模型。
				this.session.setScopedModels([]);
			}
			// 按更新后的会话范围重新统计页脚供应商数。
			this.updateAvailableProviderCount();
			// 请求菜单/页脚画面更新；不执行模型请求。
			this.ui.requestRender();
		};

		// 普通选择器宿主挂载范围菜单，同时持有下面返回的清理函数。
		this.showSelector((done) => {
			// 标记菜单是否已被关闭/替换，异步刷新回调据此放弃更新旧组件。
			let disposed = false;
			// 单独记录本地计时取消原因，不等于运行时一定整体刷新失败。
			let timedOut = false;
			// 为本菜单的目录刷新等待建立取消信号。
			const controller = new AbortController();
			// 安排15秒计时回调；超时请求取消等待，不是杀死所有供应商网络操作。
			const timeout = setTimeout(() => {
				// 先记录超时，用于后面的警告文案。
				timedOut = true;
				// 触发本调用的AbortSignal。
				controller.abort();
			}, 15_000);
			// 创建范围/顺序选择面板，目录刷新不在该组件内发起，而在下面单独协调。
			const selector = new ScopedModelsSelectorComponent(
				// 第一个对象提供显示数据快照，第二个对象提供用户动作回调。
				{
					// 传当前可用模型数组，构造器建立自己的ID索引。
					allModels: availableModels,
					// null表示全启用，数组表示显式顺序，暂时失效的ID也可在菜单保留。
					enabledModelIds: currentEnabledIds,
					// 初始显示刷新状态行，后续setRefreshStatus才有既存Text可更新。
					refreshStatus: "Refreshing model catalogs…",
				},
				// 动作回调按接口推断参数类型；这些回调当前都是同步操作。
				{
					// 勾选/顺序变化通知，不必等保存动作就影响会话循环范围。
					onChange: (enabledIds) => {
						// 先标记用户已改动，防止后台刷新按最初设置覆盖它。
						selectionChanged = true;
						// 应用新范围，可能把空选映成无范围限制。
						updateSessionModels(enabledIds);
					},
					// 明确保存动作只负责落设置，不在此再次切当前模型。
					onPersist: (enabledIds) => {
						// 判断显式数组是否按此表达式覆盖目录，用于把全启用保存成无配置。
						const allEnabled =
							// null本身由下面直接归为无配置；这里要求非null才能访问数组字段。
							enabledIds !== null &&
							// 数量与目录数组长度相等，不是与去重Set的size比较。
							enabledIds.length === availableModels.length &&
							// 每个选择ID都必须在当前可用Set中；这组表达式不额外证明列表没有重复。
							enabledIds.every((id) => availableModelIds.has(id));
						// 全启用或null映成undefined以删除设置；否则保留显式列表，包括[]。
						const newPatterns = enabledIds === null || allEnabled ? undefined : enabledIds;
						// 数组先复制再交设置管理器；[]在JS里为真值，所以会作为[]保存而非undefined。
						this.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
						// 显示已交给设置保存流程；设置管理器排队写入，不在此await最终磁盘flush。
						this.showStatus("Model selection saved to settings");
					},
					// 取消表示关菜单，不撤销先前onChange已应用的范围或已保存配置。
					onCancel: () => {
						// 交宿主关闭并触发下面dispose。
						done();
						// 请求恢复编辑区画面。
						this.ui.requestRender();
					},
				},
			);
			// 后台刷新当前会话模型目录，void丢弃最终Promise值；then/catch处理结果，finally只清计时器。
			void refreshModelCatalogs(this.session.modelRuntime, controller.signal)
				// 刷新完成后更新菜单和会话范围；异步期间this.session仍可能变化，并非会话锁。
				.then((result) => {
					// 已关闭则忽略结果，不再触碰旧菜单。
					if (disposed) return;
					// 用当时当前运行时快照替换本地目录，复制数组保留模型对象。
					availableModels = [...this.session.modelRuntime.getAvailableSnapshot()];
					// 重建完整身份Set，使后续范围映射基于新目录。
					availableModelIds = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
					// 只有用户未改动且打开时没有会话范围，才重新按捕获的保存模式计算启用项。
					if (!selectionChanged && sessionScopedModels.length === 0) {
						// 解析新目录；暂时失效模式仍可保留给菜单显示。
						currentEnabledIds = configuredEnabledIds(availableModels);
						// 同时更新目录和启用状态；传null明确改成全启用，传数组替换显式列表。
						selector.updateModels(availableModels, currentEnabledIds);
						// 已有会话范围或用户改动时保留菜单当前选择。
					} else {
						// 省略第二参数仅更新目录，组件不会把enabledIds自动重置成null。
						selector.updateModels(availableModels);
					}
					// 显式启用列表才重新映射Session范围；null不调用，所以此行本身不会主动清一个后来被其他路径修改的范围。
					if (currentEnabledIds !== null) updateSessionModels(currentEnabledIds);
					// 超时取消与普通刷新错误分别显示。
					if (result.aborted && timedOut) {
						// 超时仍显示缓存目录，warning只是状态颜色，不抛异常。
						selector.setRefreshStatus("Model refresh timed out; showing cached models.", "warning");
						// 否则按供应商错误Map判断是否局部失败。
					} else if (result.errors.size > 0) {
						// 在菜单已有刷新状态行上写警告。
						selector.setRefreshStatus(
							// 只列错误供应商名，逗号连接，不展开敏感凭据或错误对象。
							`Could not refresh ${[...result.errors.keys()].join(", ")}; showing cached models.`,
							// 设置warning样式键。
							"warning",
						);
						// 没有上述标志时采用成功文案；这是本次刷新结果状态，不保证每个模型可真实聊天。
					} else {
						// 更新成功状态行，不新增一条聊天消息。
						selector.setRefreshStatus("Model catalogs refreshed.", "success");
					}
					// 请求绘制新目录/状态；setRefreshStatus本身不requestRender。
					this.ui.requestRender();
				})
				// catch也能捕获前面then处理中的异常；unknown要求先判断再取message。
				.catch((error: unknown) => {
					// 关闭后不再显示本次异常。
					if (disposed) return;
					// 把刷新或更新错误变成菜单警告，不重抛本次原异常。
					// 本地计时触发时显示缓存回退说明。
					// 其他异常用Error.message或String显示。
					selector.setRefreshStatus(
						// 按本地超时标志选择文案。
						timedOut
							? "Model refresh timed out; showing cached models."
							: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`,
						// 错误行采用warning颜色。
						"warning",
					);
					// 请求绘制警告；若catch内操作再抛错，后续finally不会吞掉该新拒绝。
					this.ui.requestRender();
				})
				// 无论成功还是拒绝都清计时器；finally不负责关闭菜单或回滚已应用范围。
				.finally(() => clearTimeout(timeout));
			// 返回宿主挂载信息和关闭清理钩子。
			return {
				// 范围选择器作为渲染组件。
				component: selector,
				// 同一组件通过Focusable把焦点传给其搜索框。
				focus: selector,
				// 关闭/替换普通选择器时调用同步清理，不等待共享目录任务结束。
				dispose: () => {
					// 先标记disposed，使随后到达的then/catch结果被忽略。
					disposed = true;
					// 取消本地计时，避免菜单关闭后又触发超时回调。
					clearTimeout(timeout);
					// 请求取消本菜单等待；已被其他调用共享的底层刷新可继续。
					controller.abort();
				},
			};
		});
	}

	// 列出可作为分叉起点的历史用户消息，返回void；用户选定后由Runtime创建/切换分叉会话，并把选中输入放回编辑区。
	// 例如在第二条用户提问处分叉，旧会话仍保留，编辑区供修改原提问；菜单只是选择起点，不再自动提交一次模型请求。
	private showUserMessageSelector(): void {
		// 从全部会话条目取有非空文字的user消息，包含旧分支，不只当前有效上下文；图片没有文字时不列入。
		const userMessages = this.session.getUserMessagesForForking();

		// 没有候选时不创建空选择器。
		if (userMessages.length === 0) {
			// 显示没有可分叉消息的普通状态。
			this.showStatus("No messages to fork from");
			// 到此结束，不触发Runtime.fork。
			return;
		}

		// 默认把光标放到最后一条候选的entryId；?.允许数组尾项不存在时给undefined。
		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

		// 交普通选择器宿主控制挂载和恢复编辑区。
		this.showSelector((done) => {
			// 创建用户消息列表组件，确认和取消分别回调。
			const selector = new UserMessageSelectorComponent(
				// 转换候选字段名为{id,text}，不把消息ID当数组下标。
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				// 确认回调是async；输入是选中会话条目ID，后续Runtime负责分叉协调。
				async (entryId) => {
					// 先关闭菜单，再开始分叉；用户会先回到编辑区。
					done();
					// 捕获分叉和完成后的界面更新失败，不撤销已经创建的会话文件。
					try {
						// 等待Runtime执行扩展钩子、分叉和当前会话重绑；可能返回cancelled。
						const result = await this.runtimeHost.fork(entryId);
						// 扩展等取消时不使用selectedText或显示成功。
						if (result.cancelled) {
							// 请求取消后的当前界面更新。
							this.ui.requestRender();
							// 取消时结束本确认回调。
							return;
						}

						// 把分叉结果的选中输入放入当前编辑器；??仅在null/undefined时回退空串，空字符串原样保留。
						this.editor.setText(result.selectedText ?? "");
						// 显示分叉成功，不代表已向模型发送新输入。
						this.showStatus("Forked to new session");
						// unknown兼容非Error抛出值。
					} catch (error: unknown) {
						// 显示分叉错误，不自动恢复已关闭菜单。
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				// 列表取消只关闭，不创建新会话。
				() => {
					// 恢复普通编辑区和焦点。
					done();
					// 请求重绘。
					this.ui.requestRender();
				},
				// 传初始选中ID；组件按身份而非原列表长度定位。
				initialSelectedId,
			);
			// 显示外层列表组件，但把焦点直接给内部消息列表，负责实际按键导航。
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	// 克隆当前会话叶节点及其之前的分支，返回Promise<void>；先要求有叶ID，再按position:at分叉并清空编辑区。
	// 例如已有用户/助手历史时/clone复制到当前叶本身，与/fork从某条用户输入前分叉不同；可能写新会话文件、触发扩展与重绑，失败只显示错误。
	private async handleCloneCommand(): Promise<void> {
		// 读取当前叶ID，不是整个会话文件最后一条记录的通用别名。
		const leafId = this.sessionManager.getLeafId();
		// 没有叶节点时无可克隆内容。
		if (!leafId) {
			// 显示普通提示，不创建空克隆。
			this.showStatus("Nothing to clone yet");
			// 结束命令。
			return;
		}

		// 捕获Runtime及后续编辑区更新失败。
		try {
			// at明确把所选叶节点本身包含在分叉中；Runtime负责切换新的会话和重绑UI。
			const result = await this.runtimeHost.fork(leafId, { position: "at" });
			// 分叉被钩子取消时不清编辑器或显示成功。
			if (result.cancelled) {
				// 请求保持当前会话画面。
				this.ui.requestRender();
				// 结束取消路径。
				return;
			}

			// 克隆成功后清当前编辑器，不把叶消息文字当作待发送提问。
			this.editor.setText("");
			// 显示克隆已完成的状态。
			this.showStatus("Cloned to new session");
			// 用unknown接任何抛出值，不保证只收到Error。
		} catch (error: unknown) {
			// 显示错误；不提供新会话创建/重绑的全事务回滚。
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	// 打开当前会话树导航，输入可选初选条目ID，返回void；用户选择后可总结离开的分支，再由Session移动叶子并重建聊天画面。
	// 例如选中旧user节点，真正位置退到其父节点，原问题只在编辑器空时回填；不会自动重发。标签会追加会话记录，复制会写系统剪贴板，请求摘要可能调用模型。
	// 菜单确认回调为async，但组件不await其返回值；询问/中止回复等前置步骤在下面导航try之外，不能把整个流程说成统一捕获异常或可回滚事务。
	private showTreeSelector(initialSelectedId?: string): void {
		// 取得整棵会话树/森林供浏览，不只是当前送模型的上下文消息。
		const tree = this.sessionManager.getTree();
		// 捕获真实叶节点，用于菜单活动路径标记；后面确认时还会重取当前叶子避免只凭旧快照判断。
		const realLeafId = this.sessionManager.getLeafId();
		// 读取保存的树筛选模式作为初值，本入口不另保存菜单中临时筛选变化。
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		// 原始树无根节点时不构造空菜单。
		if (tree.length === 0) {
			// 显示没有历史条目的状态。
			this.showStatus("No entries in session");
			// 到此结束，不询问摘要或移动位置。
			return;
		}

		// 普通选择器宿主挂载菜单，done会恢复编辑区。
		this.showSelector((done) => {
			// 创建树组件，它只回调导航意图，真正会话操作由本函数完成。
			const selector = new TreeSelectorComponent(
				// 传树快照，其中可含旧分支和元数据。
				tree,
				// 传打开时真实叶ID，不随着列表光标改变。
				realLeafId,
				// 以当时终端高度计算组件页长，不是订阅所有后续resize。
				this.ui.terminal.rows,
				// 异步确认接目标条目ID，后续多次await期间不持有会话锁。
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					// 与确认当时真实叶比较，不能只和打开菜单时的realLeafId比较。
					if (entryId === this.sessionManager.getLeafId()) {
						// 即使无需导航，也先关闭菜单。
						done();
						// 显示已经在此位置的状态。
						this.showStatus("Already at this point");
						// 提前结束，不再咨询摘要或扩展导航钩子。
						return;
					}

					// Ask about summarization
					// 先还原编辑区，再使用扩展对话框询问是否摘要。
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					// 默认不总结，只有用户完整选择后才改变。
					let wantsSummary = false;
					// 可选自定义要求初始undefined，类型允许字符串与undefined，不在此设置空提示词。
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					// 设置要求跳过询问时保持不总结；不是“默认自动总结”。
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						// 循环允许自定义要求编辑被取消后回到摘要选项，而非直接退出整个树操作。
						while (true) {
							// 等待一个选择结果；undefined表示取消，不是默认选择第一项。
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								// 此固定标签代表不生成摘要。
								"No summary",
								// 此标签选择使用默认摘要要求。
								"Summarize",
								// 此标签还要打开多行编辑框取得自定义要求。
								"Summarize with custom prompt",
							]);

							// 用户在摘要选择框取消时返回树，不执行导航。
							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								// 重新读取树并以刚选目标为初选，保留浏览位置而非复用已关闭组件。
								this.showTreeSelector(entryId);
								// 结束这次异步确认回调。
								return;
							}

							// 只把No summary视为false，另两项为true；候选由本地固定数组提供。
							wantsSummary = summaryChoice !== "No summary";

							// 仅自定义摘要选项需要编辑要求。
							if (summaryChoice === "Summarize with custom prompt") {
								// 等待扩展多行编辑器结果，不在这里直接执行外部编辑器或模型调用。
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								// undefined是取消；空字符串仍是一次已完成输入，不按false处理。
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									// 重新询问摘要选择，跳过本轮后续导航。
									continue;
								}
							}

							// User made a complete choice
							// 完整选择后退出循环，保留本次wantsSummary与customInstructions。
							break;
						}
					}

					// The user committed to navigating: stop the active response first.
					// 用户已确认后才停止当前回复，避免仅浏览或取消菜单就中断模型。
					if (this.session.isStreaming) {
						// 先清并把文本队列回填编辑器，原队列类型/图片等不会完整恢复；这里未传abort选项。
						this.restoreQueuedMessagesToEditor();
						// 再等待会话中止当前运行；不是只丢弃其Promise后立刻改历史。
						await this.session.abort();
					}

					// Recheck after the dialogs and streaming abort, before replacing another operation's UI.
					// 经过对话框和中止await后重查是否正在压缩/导航，避免抢占别的操作状态UI。
					if (this.session.isCompacting) {
						// 忙碌时显示错误，不开启新分支摘要。
						this.showError(
							// 保留固定错误文案，说明需等待压缩或树导航结束。
							"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
						);
						// 菜单已经关闭，忙碌返回时不自动重开它。
						return;
					}

					// Set up escape handler and status indicator if summarizing
					// 记录是否由本次建立摘要指示器，finally据此只清对应种类。
					let showingSummaryIndicator = false;
					// 保存默认编辑器Esc处理函数，可能是undefined；不是保存当前扩展编辑器的自有函数。
					const originalOnEscape = this.defaultEditor.onEscape;

					// 只有用户请求总结时才接管Esc并显示摘要动画。
					if (wantsSummary) {
						// 临时Esc回调请求取消当前会话分支摘要。
						this.defaultEditor.onEscape = () => {
							// 给摘要控制器发取消，不保证回调返回瞬间所有模型请求已经结束。
							this.session.abortBranchSummary();
						};
						// 在聊天区留分隔行，后续重建聊天时也可能被清掉。
						this.chatContainer.addChild(new Spacer(1));
						// 创建分支摘要状态组件；真正摘要逻辑仍在Session.navigateTree。
						this.showStatusIndicator(new BranchSummaryStatusIndicator(this.ui));
						// 记录本次建立过指示器，供finally清理。
						showingSummaryIndicator = true;
						// 请求显示摘要中状态。
						this.ui.requestRender();
					}

					// 从此处才捕获导航/完成显示异常，并在finally恢复Esc；上面的询问、abort或状态构造失败不由此try捕获。
					try {
						// 等待同会话树导航；Session会检查忙碌、咨询扩展，必要时总结并移动叶子/重建上下文。
						const result = await this.session.navigateTree(entryId, {
							// 显式传用户是否请求总结；不总结也可由扩展取消导航。
							summarize: wantsSummary,
							// 属性简写传可选自定义要求，没有replaceInstructions所以沿用Session默认附加语义。
							customInstructions,
						});

						// 摘要被中止的特殊结果优先处理，通常同时带cancelled:true。
						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							// 显示摘要已取消，而非导航成功。
							this.showStatus("Branch summarization cancelled");
							// 重新打开树并选原目标，供用户继续选择。
							this.showTreeSelector(entryId);
							// 返回前仍执行下面finally。
							return;
						}
						// 其他取消（例如扩展否决）仅显示取消，不自动重开树。
						if (result.cancelled) {
							// 显示导航取消状态。
							this.showStatus("Navigation cancelled");
							// 跳过成功画面重建和队列刷新。
							return;
						}

						// Update UI
						// 成功后清当前聊天组件，不删除持久化历史或其他分支。
						this.chatContainer.clear();
						// 按当前会话投影重建历史显示，同时更新相关页脚/提示。
						this.renderInitialMessages();
						// 只有返回非空editorText且当前编辑器trim后为空才回填，尽量保留用户已有内容。
						if (result.editorText && !this.editor.getText().trim()) {
							// 选中user等返回的旧文字进入编辑器等待修改，不调用prompt。
							this.editor.setText(result.editorText);
						}
						// 显示已移动到选定位置。
						this.showStatus("Navigated to selected point");
						// 后台恢复压缩期间的UI队列，willRetry:false走普通提交规则；不等待全部队列完成才结束导航回调。
						void this.flushCompactionQueue({ willRetry: false });
						// 导航或成功界面更新出错显示错误，已移动叶子/写摘要等不会在此回滚。
					} catch (error) {
						// 兼容Error和非Error异常。
						this.showError(error instanceof Error ? error.message : String(error));
						// 成功、取消、错误及try中return均会进finally。
					} finally {
						// 只有本次确实装了摘要指示器才清它。
						if (showingSummaryIndicator) {
							// 按branchSummary种类清除，避免直接清掉种类不匹配的新指示器。
							this.clearStatusIndicator("branchSummary");
						}
						// 无条件写回保存的Esc值，包括undefined；这不是比较并交换，期间别处改过的处理函数也会被覆盖。
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				// 树菜单取消本身不移动叶子、不调用摘要。
				() => {
					// 关闭普通选择器。
					done();
					// 请求绘制编辑区。
					this.ui.requestRender();
				},
				// 标签确认回调接目标ID和新标签；undefined可表达清除标签，不直接改消息正文。
				(entryId, label) => {
					// 追加标签变更记录，保存发生在当前SessionManager；组件已先更新本地包装标签，失败无自动回滚。
					this.sessionManager.appendLabelChange(entryId, label);
					// 请求显示标签更新。
					this.ui.requestRender();
				},
				// 初选ID可由上次取消摘要后再次打开时传入。
				initialSelectedId,
				// 用设置筛选模式作为本次菜单初值。
				initialFilterMode,
			);
			// 构造后设置复制回调，组件内部通过闭包在复制时读取最新onCopy。
			selector.onCopy = async (text) => {
				// 缺失或空文字不调用剪贴板；纯空白字符串仍是真值，会继续复制。
				if (!text) {
					// 显示所选条目没有可复制文字。
					this.showError("Selected entry has no text to copy");
					// 结束本次复制。
					return;
				}
				// 把实际剪贴板操作和完成状态显示包在try中。
				try {
					// 等待系统剪贴板复制；这是本机副作用，不是只改菜单缓存。
					await copyToClipboard(text);
					// 复制成功后显示状态。
					this.showStatus("Copied selected message to clipboard");
					// 复制或try内状态展示失败进入此处。
				} catch (error) {
					// 显示错误，不清空用户原有剪贴板作为补偿。
					this.showError(error instanceof Error ? error.message : String(error));
				}
			};
			// 同一外壳提供渲染/焦点，并在内部切换树列表和标签输入。
			return { component: selector, focus: selector };
		});
	}

	// 打开恢复会话菜单，返回void；提供当前项目/全部会话的异步文件列表、恢复、改名和界面回调。
	// 例如默认会话目录的All会扫描各项目目录，自定义目录的All只扫该目录。组件构造即加载当前范围，选中才Runtime恢复；删除等列表操作由组件内部另行处理，本函数不实际执行它们。
	private showSessionSelector(): void {
		// 普通选择器宿主挂载菜单；这里未提供总dispose，组件选择/取消包装会自行取消进行中的列表扫描。
		this.showSelector((done) => {
			// 创建会话选择器，传两个loader而非先阻塞等待全部文件读取完。
			const selector = new SessionSelectorComponent(
				// 当前项目loader接进度回调和取消信号，返回SessionManager.list的Promise。
				(onProgress, signal) =>
					// 按当前cwd与会话目录异步扫描，可能读文件/创建默认会话目录，不发送模型请求。
					SessionManager.list(
						// 每次loader被调用时取当前会话cwd，不是打开菜单时固定字符串。
						this.sessionManager.getCwd(),
						// 传当前会话管理器使用的目录，共享目录下list会按头cwd过滤项目归属。
						this.sessionManager.getSessionDir(),
						// 进度回调交给文件扫描层，候选计数不等最终有效条目数。
						onProgress,
						// 透传取消信号；合作取消不保证底层文件I/O已同步停止。
						signal,
					),
				// 第二个loader负责All视图，按当前是否默认目录选择重载。
				// 无目录参数走所有默认项目目录的listAll重载。
				// 显式目录重载只扫描当前自定义会话目录，透传进度/取消。
				(onProgress, signal) =>
					// 默认目录意味着可跨项目扫描默认会话根；自定义目录不会扩大到全部用户目录。
					this.sessionManager.usesDefaultSessionDir()
						? SessionManager.listAll(onProgress, signal)
						: SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress, signal),
				// 选中路径后的async回调等待恢复流程，但列表的void回调契约不等待这个返回Promise。
				async (sessionPath) => {
					// 先关闭菜单，组件包装此前已取消列表扫描。
					done();
					// 把路径交统一恢复入口，处理信任/缺失cwd/运行时重绑。
					await this.handleResumeSession(sessionPath);
				},
				// 取消菜单不切换会话。
				() => {
					// 恢复编辑区。
					done();
					// 请求渲染取消后的画面。
					this.ui.requestRender();
				},
				// 向组件提供退出动作回调；赋值不等列表当前必有直接触发它的输入分支。
				() => {
					// 若被调用则后台走完整shutdown，不在此await进程退出。
					void this.shutdown();
				},
				// 把组件内部列表进度等刷新转成TUI渲染请求。
				() => this.ui.requestRender(),
				// 额外配置改名能力、提示和已有键位管理器。
				{
					// 改名async接口接文件路径和新名字，不是旧名字；内部操作当前均同步。
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						// nullish值先回退空串，再去首尾空白。
						const next = (nextName ?? "").trim();
						// 空名直接返回，所以此回调不提供通过空名清除会话名称的动作。
						if (!next) return;
						// 为目标文件另开SessionManager，读取该文件历史，不切换当前运行时。
						const mgr = SessionManager.open(sessionFilePath);
						// 追加session_info记录保存名字，不重命名.jsonl文件；可能同步写磁盘并抛错。
						mgr.appendSessionInfo(next);
					},
					// 显示改名提示，实际能力由上面callback提供，只有提示不能保存名字。
					showRenameHint: true,
					// 复用当前键位实例，避免组件再创建并读取一份用户配置。
					keybindings: this.keybindings,
				},

				// 当前会话文件路径用于列表的活动项等判断，传入的是此刻快照。
				this.sessionManager.getSessionFile(),
			);
			// 同一会话选择外壳接收焦点，内部再路由搜索/改名输入。
			return { component: selector, focus: selector };
		});
	}

	// 恢复指定会话文件，返回Promise<{cancelled:boolean}>；清状态后交Runtime打开文件、检查cwd、重建并重绑会话，缺目录时可询问改用当前cwd重试一次。
	// 例如旧项目目录已删除，用户同意后将cwdOverride传回Runtime；其他首轮错误走致命处理。catch内询问或第二次恢复再抛错不会被同一个catch重新接住，也没有全流程回滚。
	private async handleResumeSession(
		// 输入是会话文件路径，不是会话树某个entryId。
		sessionPath: string,
		// Parameters<F>取得函数参数元组，[1]取switchSession的第二参数类型，让此处选项契约跟扩展命令接口一致；仅作静态类型计算。
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
		// 结果只报告取消布尔；未取消不代表没有诊断警告。
	): Promise<{ cancelled: boolean }> {
		// 先清当前状态指示器，这一步位于try外，失败会直接拒绝。
		this.clearStatusIndicator();
		// 捕获首轮Runtime切换与其后状态展示异常。
		try {
			// 等待运行时恢复，包含前置扩展钩子、旧会话收尾、新目录资源和UI重绑。
			const result = await this.runtimeHost.switchSession(sessionPath, {
				// 可选恢复后回调随Runtime转交，在新的扩展上下文执行。
				withSession: options?.withSession,
				// 用目标cwd构造信任交互上下文，不直接沿用旧会话目录语义。
				projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
			});
			// 被扩展等取消时不显示恢复成功。
			if (result.cancelled) {
				// 原样返回取消结果对象。
				return result;
			}
			// 首轮恢复成功显示普通状态。
			this.showStatus("Resumed session");
			// 原样交回Runtime结果，不自行再开另一个会话。
			return result;
			// unknown保留非Error抛出值，下方用异常类区分缺失cwd。
		} catch (error: unknown) {
			// instanceof按运行时异常类识别缺目录，不通过错误文字猜测。
			if (error instanceof MissingSessionCwdError) {
				// 等待用户是否接受回退cwd；提示只返回候选文字，不保证目录此刻仍存在。
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				// 未选出非空cwd则取消恢复。
				if (!selectedCwd) {
					// 显示恢复已取消。
					this.showStatus("Resume cancelled");
					// 新建取消结果，不把缺目录直接当成功。
					return { cancelled: true };
				}
				// 在catch内按覆盖cwd重试一次；此await若再失败会向上拒绝，不进入下方首轮致命分支。
				const result = await this.runtimeHost.switchSession(sessionPath, {
					// 明确覆盖目标文件头cwd，由Runtime/SessionManager处理对应会话状态。
					cwdOverride: selectedCwd,
					// 保留同一withSession回调，不因cwd回退而丢掉恢复后操作。
					withSession: options?.withSession,
					// 仍按最终目标cwd创建信任上下文。
					projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
				});
				// 第二次也可能被扩展取消。
				if (result.cancelled) {
					// 返回取消结果，不显示回退成功。
					return result;
				}
				// 第二次成功后显示已在当前cwd恢复的提示。
				this.showStatus("Resumed session in current cwd");
				// 返回重试结果。
				return result;
			}
			// 其他首轮错误交致命处理，它正常路径会停止界面并退出；返回Promise<never>可兼容本函数返回类型，也可能在退出前拒绝。
			return this.handleFatalRuntimeError("Failed to resume session", error);
		}
	}

	// 同步收集登录菜单候选，输入可选认证类型过滤，返回新数组；读取Provider能力和现有认证显示状态，不登录或实时验证token。
	// 例如同一个p同时支持oauth和api_key时产生两行，状态仍按当前认证快照分类；isSubscription只来自Provider元数据，不证明账户套餐资格。
	private getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
		// 显式元素类型约束候选字段，[]初始为空，后面push逐行填充。
		const options: AuthSelectorProvider[] = [];
		// 遍历当前运行时注册/组合出的Provider，不扫描凭据文件来决定全部登录能力。
		for (const provider of this.session.modelRuntime.getProviders()) {
			// 同步查询配置来源显示状态，可能来自运行期覆盖、存储快照、配置或认证快照，并不解析实际秘密。
			const authStatus = this.session.modelRuntime.getProviderAuthStatus(provider.id);
			// 只有configured真值才为候选设置状态后缀。
			// 已配置时构造一个新状态对象，两个认证候选可共用此对象。
			// 未配置时给undefined，组件会显示not configured。
			const status = authStatus.configured
				? {
						// 根据最近认证快照判oauth，否则标api_key；as const保留两个字符串字面类型，不触发实际认证转换。
						type: this.session.modelRuntime.isUsingOAuth(provider.id) ? ("oauth" as const) : ("api_key" as const),
						// 优先显示label，缺null/undefined时回退source；空字符串label会被保留。
						source: authStatus.label ?? authStatus.source,
					}
				: undefined;
			// 只有OAuth能力明确标isSubscription:true才记true；即便当前生成API key行也沿用这一Provider元数据。
			const subscription = provider.auth.oauth?.isSubscription === true;
			// 没指定过滤或要求oauth，且Provider确有OAuth能力，才添加OAuth候选。
			if ((!authType || authType === "oauth") && provider.auth.oauth) {
				// 向本次新数组追加，不修改Provider定义。
				options.push({
					// 稳定供应商ID用于后续实际认证分派。
					id: provider.id,
					// 显示名称用于菜单文字和搜索。
					name: provider.name,
					// 当前行代表oauth入口，不等于当前已经使用oauth。
					authType: "oauth",
					// 保留OAuth能力对象供读取标签/发起后续登录，不在赋值时执行login。
					method: provider.auth.oauth,
					// 共用上面推导的当前配置状态。
					status,
					// 附上订阅标签元数据。
					subscription,
				});
			}
			// 类似地按可选api_key过滤并要求API key能力存在。
			if ((!authType || authType === "api_key") && provider.auth.apiKey) {
				// 同一Provider可在这里再产生第二行。
				options.push({
					// 两行共用provider.id，后续还需authType区分。
					id: provider.id,
					// 共用Provider显示名。
					name: provider.name,
					// 标记此候选为API key入口。
					authType: "api_key",
					// API key能力可有login交互，也可能只依赖外部环境/配置，后面另行分派。
					method: provider.auth.apiKey,
					// 仍显示当前实际配置类型/来源，可能提示配置的是另一认证方式。
					status,
					// 沿用Provider订阅元数据，不据此把API key改称OAuth。
					subscription,
				});
			}
		}
		// 就地排序本次新数组，按名称localeCompare；同名多种认证候选没有额外二级排序。
		return options.sort((a, b) => a.name.localeCompare(b.name));
	}

	// 异步收集可注销的凭据元信息，返回候选数组；15秒信号限制本次读取等待，不删除凭据或发注销请求。
	// 例如已卸载Provider但凭据仍在列表中，照样用providerId显示；列表也可含运行期覆盖，不等所有认证来源都能由注销清除。
	private async getLogoutProviderOptions(): Promise<AuthSelectorProvider[]> {
		// 读取凭据类型/供应商信息，不取回真实key或token；AbortSignal.timeout表示取消信号，不是强行终止底层存储工作。
		return (
			(await this.session.modelRuntime.listCredentials({ signal: AbortSignal.timeout(15_000) }))
				// 解构每条元信息，仅用providerId与type构建展示行。
				.map(({ providerId, type }) => {
					// 查询当前Provider，可不存在，不能因为凭据存在就断言目录仍有该Provider。
					const provider = this.session.modelRuntime.getProvider(providerId);
					// 返回本条新的展示对象。
					return {
						// 保留凭据对应供应商ID。
						id: providerId,
						// Provider存在时用其name，否则用ID；??保留显式空字符串名称。
						name: provider?.name ?? providerId,
						// 候选认证种类沿用实际元信息。
						authType: type,
						// 显示固定stored credential来源文字；这只是本菜单标签，底层列表也可能合并了运行期覆盖。
						status: { type, source: "stored credential" },
						// 未知Provider或没有OAuth订阅标记时为false，不向服务端查询套餐。
						subscription: provider?.auth.oauth?.isSubscription === true,
					};
				})
				// 按显示名排序新数组，读取错误/取消仍通过Promise拒绝传出。
				.sort((a, b) => a.name.localeCompare(b.name))
		);
	}

	// 按输入引用精确筛选登录候选，返回数组，无认证副作用；例如大小写不同的ProviderID可匹配，但短子串不能。
	private findLoginProviderOptions(providerRef: string): AuthSelectorProvider[] {
		// 先trim再转小写，对ID和名字采用同一比较尺度。
		const normalizedProviderRef = providerRef.trim().toLowerCase();
		// 规范化后空串不做全量匹配。
		if (!normalizedProviderRef) {
			// 返回新空数组。
			return [];
		}

		// 从当前所有认证候选过滤，可能保留同供应商不同认证方式的多行。
		return this.getLoginProviderOptions().filter(
			// 谓词每次接一条候选，结果为布尔。
			(provider) =>
				// ProviderID小写后严格相等即匹配。
				provider.id.toLowerCase() === normalizedProviderRef ||
				// 或者显示名称小写后严格相等；不做模糊排序或唯一性消歧。
				provider.name.toLowerCase() === normalizedProviderRef,
		);
	}

	// 处理/login可选供应商引用，返回Promise<void>；无引用先选方式，唯一候选直接登录，同Provider多方式先选方式，其他情况开供应商搜索。
	// 例如p同时支持oauth/api_key时先问用哪一种；await只在直接登录路径等待对话流程，打开菜单的路径不等待未来认证完成。
	private async handleLoginCommand(providerRef?: string): Promise<void> {
		// undefined/空串走顶层菜单；直接传空白字符串仍会进入后面的规范化匹配。
		if (!providerRef) {
			// 展示认证方式菜单，并非立即登录某一默认Provider。
			this.showLoginAuthTypeSelector();
			// 打开菜单后结束此命令调用。
			return;
		}

		// 按精确ID/名称查所有方式候选，可能0、1或多行。
		const providerOptions = this.findLoginProviderOptions(providerRef);
		// 只命中一条方式可跳过额外菜单。
		if (providerOptions.length === 1) {
			// 等待该候选的认证流程；!是TS非空断言，不在运行时重新校验数组元素。
			await this.startProviderLogin(providerOptions[0]!);
			// 直接登录路径处理后返回，不再开搜索。
			return;
		}

		// 多个候选还要区分“同一Provider多个方式”与“多个Provider名字冲突”。
		if (providerOptions.length > 1) {
			// 按候选ID去重，不按显示名称去重。
			const providerIds = new Set(providerOptions.map((provider) => provider.id));
			// ID只剩一个说明可在同Provider的方式间选择。
			if (providerIds.size === 1) {
				// 把已匹配候选传给方式菜单，避免展示其他Provider。
				this.showLoginAuthTypeSelector(providerOptions);
				// 菜单打开后结束本调用。
				return;
			}
		}

		// 零匹配或跨Provider歧义时开供应商搜索；undefined表示不过滤方式，保留原查询作为搜索初值。
		this.showLoginProviderSelector(undefined, providerRef);
	}

	/** `onBack` reopens the selector the login was started from when the user cancels it. */
	// 按单条候选分派认证UI，输入候选和可选返回菜单回调，返回Promise<void>；OAuth/API交互分支等待对话，外部配置分支只展示说明。
	// 例如API key能力没有login函数时告诉用户如何在环境配置，不伪造一次凭据保存；onBack只在对应对话取消路径由实现调用。
	private async startProviderLogin(providerOption: AuthSelectorProvider, onBack?: () => void): Promise<void> {
		// 按行的authType判断，不通过显示名称或当前status分类。
		if (providerOption.authType === "oauth") {
			// 等待OAuth登录对话，转交ProviderID、显示名和返回动作。
			await this.showLoginDialog(providerOption.id, providerOption.name, onBack);
			// 非OAuth且能力对象确有login时，才走可交互API key登录。
		} else if (providerOption.method?.login) {
			// 等待API key认证对话，具体保存/同步由运行时负责。
			await this.showApiKeyLoginDialog(providerOption.id, providerOption.name, onBack);
			// 没有可调用login的API key能力走环境认证说明。
		} else {
			// 同步打开说明菜单，不在这里执行环境变量赋值或写入秘密。
			this.showAmbientAuthDialog(providerOption, onBack);
		}
	}

	// 展示认证方式菜单，输入可选同Provider候选列表，返回void；顶层列账号/API key并可追加Radius直达项，指定候选时只列其支持方式。
	// 例如p有oauth和api_key时二选一；若指定候选仅一种方式则直接后台启动认证。菜单关闭不代表认证完成，取消认证的onBack可重开来源菜单。
	private showLoginAuthTypeSelector(providerOptions?: AuthSelectorProvider[]): void {
		// The top-level selector offers Radius directly, as its last option.
		// 准备顶层Radius快捷候选；传了providerOptions（包括[]）时不再查顶层Radius入口。
		// 限定Provider菜单不附加独立Radius选项。
		// 顶层只从OAuth候选找首个Radius供应商，不直接执行登录。
		const radiusOption = providerOptions
			? undefined
			: this.getLoginProviderOptions("oauth").find((provider) => provider.id === RADIUS_PROVIDER_ID);
		// 有Radius候选才构造动画展示前缀，没有则undefined。
		const radiusText = radiusOption ? `Sign in with ${radiusOption.name}` : undefined;
		// 完整候选标签带认证状态后缀，后续按此字符串识别点击；不是独立不可碰撞的操作ID。
		const radiusLabel = radiusOption ? `${radiusText}${formatAuthSelectorProviderStatus(radiusOption)}` : undefined;
		// 指定候选里找首个OAuth能力，为方式菜单提供可选自定义标签。
		const oauthProvider = providerOptions?.find((provider) => provider.authType === "oauth");
		// 为共享API key/OAuth联合能力提取OAuth专用loginLabel。
		const oauthLoginLabel =
			// 先确认method存在且含loginLabel属性，in检查包含原型属性；只读取文字，不调用login。
			oauthProvider?.method && "loginLabel" in oauthProvider.method ? oauthProvider.method.loginLabel : undefined;
		// 仅null/undefined时回退默认账号标签，显式空字符串仍会保留。
		const subscriptionLabel = oauthLoginLabel ?? "Sign in with an account";
		// API key方式采用固定标签，不从能力对象另取名称。
		const apiKeyLabel = "Sign in with an API key";
		// 决定应出现哪些方式，用Set消重认证类型。
		// 指定候选时只列这些行实际具有的authType。
		// 顶层明确提供oauth/api_key两种入口，即使某一种当前没有供应商也先显示，后续列表会提示为空。
		const availableAuthTypes = providerOptions
			? new Set(providerOptions.map((provider) => provider.authType))
			: new Set<AuthSelectorProvider["authType"]>(["oauth", "api_key"]);
		// 创建要传给字符串选择器的候选数组，保持下面push顺序。
		const options: string[] = [];
		// 有OAuth方式才放账号入口。
		if (availableAuthTypes.has("oauth")) {
			// 追加可能自定义的账号标签。
			options.push(subscriptionLabel);
		}
		// 有API key方式才显示其入口。
		if (availableAuthTypes.has("api_key")) {
			// 追加API key固定标签。
			options.push(apiKeyLabel);
		}
		// Radius完整标签非空时放最后；普通账号入口仍可保留Radius，不在这里做供应商去重。
		if (radiusLabel) options.push(radiusLabel);

		// 没有可显示方式时不创建选择器。
		if (options.length === 0) {
			// 显示无登录方式状态。
			this.showStatus("No login methods available.");
			// 结束调用。
			return;
		}

		// 只针对明确候选列表的一种菜单项跳过选择器，顶层不因为选项数量自动登录。
		if (providerOptions && options.length === 1) {
			// 取列表首条候选，而非根据标签再次查Provider。
			const providerOption = providerOptions[0];
			// 有候选才启动，空数组不会访问不存在字段。
			if (providerOption) {
				// 后台启动认证，void不await整个登录，也没有为此分支提供onBack菜单回调。
				void this.startProviderLogin(providerOption);
			}
			// 直接分派后结束，不再构造方式菜单。
			return;
		}

		// 首条候选存在时标题附其名称，否则用通用标题。
		// 有首条候选时将显示名放入方式选择说明，不把名字当认证ID。
		// 没有首条候选时使用顶层通用认证方式标题。
		const title = providerOptions?.[0]
			? `Select authentication method for ${providerOptions[0].name}:`
			: "Select authentication method:";
		// 普通选择器宿主负责替换编辑区、焦点和清理动画。
		this.showSelector((done) => {
			// 本地确认回调接所选完整字符串，返回void；不是一个带唯一action字段的对象。
			const onSelect = (option: string) => {
				// 先关闭方式菜单、清计时资源，再开始下一步认证或打开另一个菜单。
				done();
				// 优先识别Radius快捷标签，存在文字碰撞时此分支也优先；不额外检查候选行身份。
				if (radiusOption && option === radiusLabel) {
					// 后台OAuth认证，取消时可重开顶层方式菜单。
					void this.startProviderLogin(radiusOption, () => this.showLoginAuthTypeSelector());
					// Radius快捷处理后不再进入通用方式分派。
					return;
				}
				// 与账号标签严格相等才当oauth，其余字符串按api_key解释；实际候选由上方构造。
				const authType = option === subscriptionLabel ? "oauth" : "api_key";
				// 指定Provider候选时只在这批里找所选认证类型。
				if (providerOptions) {
					// 找首条对应方式；同一方式有多条时不在这里再弹供应商消歧。
					const providerOption = providerOptions.find((provider) => provider.authType === authType);
					// 找到候选才开始登录，缺失时下面仍会返回。
					if (providerOption) {
						// 后台启动并把返回动作设为重开同一候选组的方式菜单。
						void this.startProviderLogin(providerOption, () => this.showLoginAuthTypeSelector(providerOptions));
					}
					// 限定候选组分派结束，不再开全量供应商菜单。
					return;
				}
				// 顶层方式选择后打开对应认证类型的供应商列表。
				this.showLoginProviderSelector(authType);
			};
			// 取消方式菜单只恢复编辑界面，不写认证或“不信任”记录。
			const onCancel = () => {
				// 通知普通选择器宿主完成。
				done();
				// 请求渲染恢复后的编辑区。
				this.ui.requestRender();
			};
			// 按是否有完整Radius展示信息选择动画子类工厂或普通字符串选择器。
			// 创建带Radius文字动画的菜单，实际仍沿用ExtensionSelector输入选择逻辑。
			// 没有Radius动画时构造普通选择器，沿用相同确认/取消函数。
			const selector =
				// 两份Radius字符串均非空才走动画；这里只用真值，不保证标签在数组中唯一。
				radiusLabel && radiusText
					? createLoginMenuSelector(
							// 传TUI只用于动画重绘，不在工厂发认证请求。
							this.ui,
							// 采用上面计算的通用/Provider标题。
							title,
							// 传保持账号/API key/Radius顺序的候选字符串数组。
							options,
							// label含状态后缀，text为动画前缀；工厂按首行字符串匹配装饰，不是整项身份校验。
							{ label: radiusLabel, text: radiusText },
							// 确认通知交回本地分派函数。
							onSelect,
							// 取消通知用于关闭并重绘。
							onCancel,
						)
					: new ExtensionSelectorComponent(title, options, onSelect, onCancel);
			// 宿主关闭时调用dispose；动画子类会停止interval，普通组件清可能的倒计时，不代表认证Promise自动被取消。
			return { component: selector, focus: selector, dispose: () => selector.dispose() };
		});
	}

	// 展示可搜索登录Provider列表，输入可选方式和搜索初值，返回void；确认后匹配ID+方式并启动对应认证，取消可回方式菜单。
	// 例如仅API key入口会过滤掉OAuth行；搜索文字只给本地候选过滤，不向远端提交搜索请求。组件名OAuthSelector也用于API key候选。
	private showLoginProviderSelector(authType?: AuthSelectorProvider["authType"], initialSearchInput?: string): void {
		// 按指定认证类型构造当前候选快照，不验证真实token。
		const providerOptions = this.getLoginProviderOptions(authType);
		// 空列表时改显示对应提示，不挂载无候选菜单。
		if (providerOptions.length === 0) {
			// 按authType三路选固定空状态文案。
			// authType为oauth时使用没有账号提供者的固定文字。
			// 否则检查是否明确为API key入口。
			// API key入口专用空状态。
			// 未指定类型时使用通用无登录提供者说明。
			const message =
				// OAuth入口使用账号提供者说明。
				authType === "oauth"
					? "No account providers available."
					: authType === "api_key"
						? "No API key providers available."
						: "No login providers available.";
			// 显示本次空状态。
			this.showStatus(message);
			// 不继续创建选择器。
			return;
		}

		// 普通选择器宿主挂载候选列表。
		this.showSelector((done) => {
			// 创建带搜索/分页的认证列表，不在构造时执行登录。
			const selector = new OAuthSelectorComponent(
				// login只是标题/空状态模式，不自动改变认证状态。
				"login",
				// 传打开时生成的候选数组；后续确认在同一数组里找回能力对象。
				providerOptions,
				// 异步确认接ProviderID和authType，二者一起区分同供应商多行；组件不等待void契约下的异步结果。
				async (providerId, selectedAuthType) => {
					// 先关闭候选菜单再打开认证对话。
					done();

					// 从原候选组查找完整匹配，不用显示名反查。
					const providerOption = providerOptions.find(
						// 两个严格相等条件同时满足才命中，避免选OAuth却取到API key能力。
						(provider) => provider.id === providerId && provider.authType === selectedAuthType,
					);
					// 没有对应候选时静默结束，菜单已被关闭。
					if (!providerOption) {
						// 不伪造缺失Provider认证调用。
						return;
					}

					// 等待具体认证流程；传回退闭包，用户取消后重建原方式过滤/查询的列表。
					await this.startProviderLogin(providerOption, () =>
						// 保留打开列表时的authType和initialSearchInput，不动态读取本次取消前搜索框文字。
						this.showLoginProviderSelector(authType, initialSearchInput),
					);
				},
				// 列表取消的返回目标取决于是否从指定方式入口进入。
				() => {
					// 先完成并移除当前普通选择器。
					done();
					// 有认证类型说明来自方式选择路径。
					if (authType) {
						// 重开顶层方式菜单，不局限为刚才那一Provider。
						this.showLoginAuthTypeSelector();
						// 未指定方式的通用搜索路径取消直接回编辑区。
					} else {
						// 请求恢复后的画面。
						this.ui.requestRender();
					}
				},
				// 给认证列表本地搜索框的初始文字。
				initialSearchInput,
			);
			// 同一认证列表外壳作component和focus；此处没有额外总dispose钩子。
			return { component: selector, focus: selector };
		});
	}

	// 登录/注销入口，输入字面联合mode，返回Promise<void>；登录转方式菜单，注销先读凭据元信息再展示可删除项。
	// 例如注销p会删除存储凭据及运行期覆盖，再同步本地状态，不改环境变量/models.json；同步失败与删除本身失败使用不同提示，不撤销已完成删除。
	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		// login只打开新的方式菜单，余下逻辑专用于logout。
		if (mode === "login") {
			// 展示顶层认证方式选择，不等待未来登录完成。
			this.showLoginAuthTypeSelector();
			// 返回，避免误读取注销候选。
			return;
		}

		// 声明稍后赋值的候选数组类型，不在此构造或读取文件。
		let providerOptions: AuthSelectorProvider[];
		// 只将凭据列表读取阶段包在这个try里。
		try {
			// 等待可注销元信息，内部有15秒取消信号；不读取秘密来显示。
			providerOptions = await this.getLogoutProviderOptions();
			// 读取失败显示错误并放弃菜单。
		} catch (error) {
			// 保留固定错误前缀并处理Error/非Error抛出值。
			this.showError(`Could not read stored credentials: ${error instanceof Error ? error.message : String(error)}`);
			// 不使用空数组冒充读取成功。
			return;
		}
		// 读取成功但无候选时显示边界说明。
		if (providerOptions.length === 0) {
			// 普通状态展示，不在此尝试清环境变量。
			this.showStatus(
				// 固定文案说明注销目标，不保证所有可用认证来源都被清空；运行期覆盖也可由底层注销路径移除。
				"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
			);
			// 无候选则结束，不挂载空列表。
			return;
		}

		// 挂载注销列表，宿主done负责恢复编辑区。
		this.showSelector((done) => {
			// 复用认证选择器，实际注销操作在确认回调里执行。
			const selector = new OAuthSelectorComponent(
				// 此时控制流已排除login，所以组件按logout显示标题。
				mode,
				// 传读取成功的候选快照。
				providerOptions,
				// 异步确认只接providerId，忽略组件传的第二个authType参数；每Provider凭据元信息用于找对应行。
				async (providerId: string) => {
					// 先关菜单再删除凭据，避免操作后仍停在旧列表。
					done();

					// 从打开时列表找首个对应ID；不在此重新读取凭据状态。
					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					// 不存在则结束，不凭外来ID直接注销。
					if (!providerOption) {
						// 菜单已关闭，不显示伪造成功。
						return;
					}

					// 捕获注销及其后界面更新失败。
					try {
						// 等待运行时按Provider串行删除凭据/覆盖并同步状态；不向供应商发送“撤销所有已发token”的通用保证。
						await this.session.modelRuntime.logout(providerOption.id, {
							// 15秒取消信号约束操作等待，底层已提交的删除不会因此自动回滚。
							signal: AbortSignal.timeout(15_000),
						});
						// updateAvailableProviderCount同步返回void，原await不会发另一次目录刷新；这里只从当前模型范围或可用快照重算供应商数。
						await this.updateAvailableProviderCount();
						// 根据刚才选项的认证种类选择完成说明。
						// 把Provider显示名放入状态，不打印凭据。
						// API key条目明确环境变量和models.json保持原样，之后仍可能凭这些来源获得认证。
						const message =
							// OAuth条目采用Logged out文案。
							providerOption.authType === "oauth"
								? `Logged out of ${providerOption.name}`
								: `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
						// 显示选定的成功说明。
						this.showStatus(message);
						// 注销失败或try内显示失败进入此处。
					} catch (error: unknown) {
						// 抽取可显示错误文字。
						const message = error instanceof Error ? error.message : String(error);
						// 异常类决定是已删除后同步失败还是一般失败。
						// 命中CredentialSynchronizationError时明确承认凭据已删除，避免让用户以为仍能靠旧存储条目登录。
						// 其他错误使用通用注销失败说明；本分支不恢复旧凭据。
						this.showError(
							// CredentialSynchronizationError是运行时类，标识凭据变更后本地同步失败，不是按消息字符串猜测。
							error instanceof CredentialSynchronizationError
								? `Credentials removed for ${providerOption.name}, but local model state could not be synchronized: ${message}`
								: `Logout failed: ${message}`,
						);
					}
				},
				// 取消列表不删除任何候选。
				() => {
					// 关闭普通选择器。
					done();
					// 请求恢复编辑区显示。
					this.ui.requestRender();
				},
			);
			// 同一列表组件接收焦点，未提供额外dispose。
			return { component: selector, focus: selector };
		});
	}

	// 登录成功后的模型选择与目录更新协调，输入Provider身份、认证类型和登录前模型，返回Promise<void>。
	// 若原模型是unknown占位，可按Provider默认候选切换并持久化；动态目录缺默认时先显示已保存，再后台刷新后有条件补选。其他原模型保留。
	// 例如Radius默认ID不存在可退到其目录首项，llama.cpp只给管理/选择提示。认证成功不等自动选模成功，后台刷新不包含在本函数完成等待里。
	private async completeProviderAuthentication(
		// 稳定ProviderID用于过滤模型和指定局部目录刷新。
		providerId: string,
		// 显示名用于状态/错误文字，不用于模型身份比较。
		providerName: string,
		// 认证类型只选择登录或保存key文案。
		authType: "oauth" | "api_key",
		// 保留登录前模型对象引用，既判unknown也在后台刷新后比较用户是否仍停在同一模型对象。
		previousModel: Model<any> | undefined,
	): Promise<void> {
		// 按认证种类构造本次完成动作前缀，不在此再次保存凭据。
		const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;

		// 捕获调用时的Session对象，用于后台刷新目标和迟到结果身份检查；下面finishAuthentication仍多处读动态this.session。
		const session = this.session;
		// Dynamic catalogs may be empty until the first authenticated network refresh.
		// 是否延后选默认由三个条件共同决定，并非所有登录都等待目录联网完成。
		const deferSelection =
			// 只有登录前为unknown占位模型才考虑自动选默认。
			isUnknownModel(previousModel) &&
			// 还要求本地默认模型候选表含此Provider；该辅助用in，保留普通对象原型链语义。
			hasDefaultModelProvider(providerId) &&
			// 从捕获的会话运行时读取当前可用快照。
			!session.modelRuntime
				// 同步取快照，不发目录请求。
				.getAvailableSnapshot()
				// 默认provider/id尚未在快照里时延后；!否定some结果，不是检查Provider所有模型都为空。
				.some((model) => model.provider === providerId && model.id === defaultModelPerProvider[providerId]);
		// 本地async完成函数负责选模、页脚和状态，无独立取消/锁；可能立即调用或在刷新后调用。
		const finishAuthentication = async () => {
			// 可选本次自动选中的模型，正常已有模型时一直undefined。
			let selectedModel: Model<any> | undefined;
			// 记录登录成功但选模不可完成的说明，不把它伪装成认证失败。
			let selectionError: string | undefined;
			// 原模型不是unknown时跳过自动默认选择，保留现有模型。
			if (isUnknownModel(previousModel)) {
				// 此处读取执行时当前this.session，不使用外层捕获session；await前后当前会话仍可能变化。
				const availableModels = this.session.modelRuntime.getAvailableSnapshot();
				// 从可用快照只取本次认证Provider的模型，保留目录顺序。
				const providerModels = availableModels.filter((model) => model.provider === providerId);
				// Matches LLAMA_PROVIDER_ID from extensions/llama/provider.ts; kept inline to avoid coupling interactive mode to the built-in extension.
				// llama.cpp必须由用户按加载情况选择，不自动给首个本地模型设默认。
				if (providerId === "llama.cpp") {
					// 按加载模型数量生成/llama和/model后续指引；不启动或加载模型。
					selectionError = llamaCppPostLoginGuidance(actionLabel, providerModels.length);
					// 其他Provider没有默认候选表时，不猜第一个模型。
				} else if (!hasDefaultModelProvider(providerId)) {
					// 记录已登录但需用户手动/model的说明。
					selectionError = `${actionLabel}, but no default model is configured for provider "${providerId}". Use /model to select a model.`;
					// 有默认表但该Provider可用模型列表为空，也无法自动选择。
				} else if (providerModels.length === 0) {
					// 记录目录暂无可用项的说明，不删除已存凭据。
					selectionError = `${actionLabel}, but no models are available for that provider. Use /model to select a model.`;
					// 已知默认候选且有模型时尝试选默认。
				} else {
					// 读取本地默认模型ID，是候选值而非远端现查结果。
					const defaultModelId = defaultModelPerProvider[providerId];
					// Radius catalogs vary by account; prefer balanced, then use catalog order.
					// 优先按默认ID精确匹配，必要时只为Radius做首项回退。
					selectedModel =
						// find找首个同ID模型；??仅未找到时执行回退。
						providerModels.find((model) => model.id === defaultModelId) ??
						// Radius目录随账户不同，允许用其目录首项；其他Provider默认缺失仍undefined。
						(providerId === "radius" ? providerModels[0] : undefined);
					// 没有选中模型时只记错误，不对undefined调用setModel。
					if (!selectedModel) {
						// 展示具体缺失默认ID，让用户改用/model。
						selectionError = `${actionLabel}, but its default model "${defaultModelId}" is not available. Use /model to select a model.`;
						// 找到候选时尝试切换并保存全局默认。
					} else {
						// 这里只捕获选模调用失败，避免抹掉已成功认证事实。
						try {
							// 等待当前Session.setModel，persist:true还写默认provider/id；即使调用后续失败，已改状态不在此回滚。
							await this.session.setModel(selectedModel, { persist: true });
							// 选默认模型失败进入此处。
						} catch (error: unknown) {
							// 清本地成功标记，后面不显示Selected。
							selectedModel = undefined;
							// 转错误为可显示文字。
							const errorMessage = error instanceof Error ? error.message : String(error);
							// 明确认证已成功但选模失败，并给手动/model建议。
							selectionError = `${actionLabel}, but selecting its default model failed: ${errorMessage}. Use /model to select a model.`;
						}
					}
				}
			}

			// 更新当前页脚Provider计数，原await保留但被调函数同步返回void，不另刷新目录。
			await this.updateAvailableProviderCount();
			// 让页脚按新模型等重新渲染。
			this.footer.invalidate();
			// 刷新编辑边框思考状态。
			this.updateEditorBorderColor();
			// 本地确实完成自动选模才显示Selected。
			if (selectedModel) {
				// 状态附配置helper给出的auth路径；这是保存位置提示，不额外读取文件核验磁盘持久化。
				this.showStatus(`${actionLabel}. Selected ${selectedModel.id}. Credentials saved to ${getAuthPath()}`);
				// 后台检查新选模型的订阅认证提醒。
				void this.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
				// 没有自动选模仍报告认证已完成。
			} else {
				// 显示凭据保存位置，不在此打印key/token。
				this.showStatus(`${actionLabel}. Credentials saved to ${getAuthPath()}`);
				// 自动选模有具体问题时额外显示错误。
				if (selectionError) {
					// 展示selectionError，保留认证成功状态。
					this.showError(selectionError);
					// 没有选模问题则可按当前模型检查订阅提醒。
				} else {
					// 不传模型参数，辅助在调用时取当前会话模型。
					void this.maybeWarnAboutAnthropicSubscriptionAuth();
				}
			}
		};
		// 动态目录尚缺默认时暂不调用finishAuthentication，避免先报缺失后立即重选。
		if (deferSelection) {
			// 先显示认证已保存、目录正在刷新；不是等待网络完成后的最终选模保证。
			this.showStatus(`${actionLabel}. Credentials saved to ${getAuthPath()}. Refreshing model catalog…`);
			// 不需延迟时先完成当前快照上的选择/状态。
		} else {
			// await完成函数，选模和同步UI步骤结算后才安排下面后台目录刷新。
			await finishAuthentication();
		}

		// 为后续局部刷新等待创建取消控制器。
		const controller = new AbortController();
		// 15秒后请求取消；本代码没有单独timedOut标志，下面任意aborted结果都采用超时文案。
		const timeout = setTimeout(() => controller.abort(), 15_000);
		// 后台链绑定捕获session的modelRuntime，而非刷新时可能已替换的this.session。
		void session.modelRuntime
			// 仅要求刷新本次Provider；是否允许联网遵循运行时自身策略，此处不传allowNetwork也不自行检查PI_OFFLINE。
			.refresh({ providers: [providerId], signal: controller.signal })
			// 刷新结果到达后异步处理，finishAuthentication可继续await模型切换。
			.then(async (result) => {
				// 任何aborted结果都被本UI标为刷新超时，不额外区分取消来源。
				if (result.aborted) {
					// 警告采用缓存回退文案；可能在用户已换会话时仍显示，下面身份保护只守自动选模。
					this.showWarning(`${actionLabel}, but its model catalog refresh timed out; using cached models.`);
					// 未aborted但错误Map非空时显示一般目录失败。
				} else if (result.errors.size > 0) {
					// 保留凭据成功事实，不声称登录整体失败。
					this.showWarning(`${actionLabel}, but its model catalog could not be refreshed; using cached models.`);
				}
				// Do not replace a model or session selected while the refresh was running.
				// 延后选模还要求当前Session对象仍是原对象，且模型对象仍严格等于登录前对象；不是按ID等值比较或全流程锁。
				if (deferSelection && this.session === session && session.model === previousModel) {
					// 条件通过才补做默认模型选择，避免通常的迟到刷新覆盖用户后来选择；函数内部await期间仍无额外身份锁。
					await finishAuthentication();
				}
				// 无论是否补选，都更新当时当前会话的Provider计数。
				this.updateAvailableProviderCount();
				// 让当前页脚失效。
				this.footer.invalidate();
				// 请求刷新画面。
				this.ui.requestRender();
			})
			// 捕获刷新拒绝和then内处理异常，unknown需要先判断再取message。
			.catch((error: unknown) => {
				// 把失败显示为警告而非删除凭据。
				this.showWarning(
					// 保留认证动作前缀并显示错误详情，不向这里附上秘密凭据。
					`${actionLabel}, but its model catalog could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
				);
			})
			// 链结算时清超时计时器；catch自身再抛错仍会让最终链拒绝，void不会额外吞掉它。
			.finally(() => clearTimeout(timeout));
	}

	// 展示环境/外部配置认证说明，输入候选和可选返回回调，返回void；替换编辑区为可关闭的LoginDialog，不调用Runtime.login或保存凭据。
	// 例如仅依赖AWS profile的能力没有交互login时，告诉用户在Pi外配置；关闭才还原编辑器并按需回原菜单。
	private showAmbientAuthDialog(providerOption: AuthSelectorProvider, onBack?: () => void): void {
		// 本地恢复函数清显示区、加回当前编辑器、聚焦并重绘；它不执行认证取消/凭据修改。
		const restoreEditor = () => {
			// 移除当前显示组件，不等dispose所有外部异步任务。
			this.editorContainer.clear();
			// 恢复执行此闭包时的this.editor，不固定为打开说明前那个对象。
			this.editorContainer.addChild(this.editor);
			// 让编辑器重新接键盘输入。
			this.ui.setFocus(this.editor);
			// 请求画面更新。
			this.ui.requestRender();
		};

		// 构造登录面板用作说明外壳，不自动打开URL。
		const dialog = new LoginDialogComponent(
			// TUI供面板请求刷新。
			this.ui,
			// ProviderID供默认语义，真正标题下面会覆盖。
			providerOption.id,
			// 完成通知在此主要响应取消/关闭，不读success/message；说明模式没有实际认证Promise。
			() => {
				// 先恢复编辑区。
				restoreEditor();
				// 可选链有onBack才返回上级菜单；不await回调或吞其异常。
				onBack?.();
			},
			// 供应商显示名覆盖默认ID显示。
			providerOption.name,
			// 整个标题用Provider setup，不显示默认Login to。
			`${providerOption.name} setup`,
		);
		// 追加外部配置说明，下面参数不会触发登录。
		dialog.showInfo(
			// 优先能力name，缺省Authentication，插入应用名；不输出真实环境变量值或秘密。
			`${providerOption.method?.name ?? "Authentication"} is configured outside ${APP_NAME}.`,
			// 没有附加说明链接。
			[],
			// true只要求显示关闭提示，不代表认证成功或信任确认。
			true,
		);

		// 清编辑区域，当前编辑器对象仍保留在this.editor。
		this.editorContainer.clear();
		// 把说明对话放到可见区域。
		this.editorContainer.addChild(dialog);
		// 焦点交面板，允许它处理关闭键。
		this.ui.setFocus(dialog);
		// 请求绘出说明。
		this.ui.requestRender();
	}

	// 以登录面板承载API key认证，输入ProviderID/名称/可选返回动作，返回Promise<void>；挂面板→Runtime登录→还原编辑器→协调选模和后台目录刷新。
	// 例如取消时按确切Login cancelled消息返回来源菜单；凭据已写但本地同步失败使用专门说明，不声称保存被撤销。构造/挂载在try外，恢复函数抛错也不保证界面总能还原。
	private async showApiKeyLoginDialog(providerId: string, providerName: string, onBack?: () => void): Promise<void> {
		// 捕获登录前模型对象，后续决定是否自动选择默认模型。
		const previousModel = this.session.model;

		// 创建面板；组件本身只处理显示/用户输入和取消信号。
		const dialog = new LoginDialogComponent(
			// 传当前TUI宿主。
			this.ui,
			// ProviderID供标题等使用，不直接构造网络端点。
			providerId,
			// 面板完成回调参数用下划线表示当前不用；真正认证完成由下面await判断。
			(_success, _message) => {
				// Completion handled below
			},
			// 显示Provider名称，而非直接显示ID。
			providerName,
		);

		// Bedrock API key入口额外提示可用其他AWS环境认证，不自动探测或修改这些环境。
		if (providerId === "amazon-bedrock") {
			// 在面板挂载前放入说明行。
			dialog.showDetails([
				// 第一行描述支持的profile/IAM/角色来源，未在此读取凭据。
				theme.fg("text", "You can also use an AWS profile, IAM keys, or role-based credentials."),
				// 加文档位置引导。
				theme.fg("muted", "See:"),
				// 用config资源helper取文档根再join providers.md，不依赖__dirname或实际打开文件。
				theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
			]);
		}

		// 清编辑器显示槽，不销毁编辑器对象。
		this.editorContainer.clear();
		// 挂上新登录面板。
		this.editorContainer.addChild(dialog);
		// 交面板焦点。
		this.ui.setFocus(dialog);
		// 请求显示登录界面。
		this.ui.requestRender();

		// 恢复函数供成功与失败共用，返回void，不负责取消Provider后台工作。
		const restoreEditor = () => {
			// 移除登录面板等当前显示。
			this.editorContainer.clear();
			// 加回调用时当前编辑器。
			this.editorContainer.addChild(this.editor);
			// 恢复输入焦点。
			this.ui.setFocus(this.editor);
			// 请求恢复画面。
			this.ui.requestRender();
		};

		// 捕获登录、恢复、完成处理的失败；已有凭据和设置副作用不回滚。
		try {
			// 等待API key能力交互、凭据变更及运行时同步，不在此直接写auth.json。
			await this.loginProvider(dialog, providerId, providerName, "api_key");
			// 认证成功后先还原编辑器。
			restoreEditor();
			// 协调默认选模/完成提示并安排后台目录刷新；此函数不等待整个后台刷新链结束。
			await this.completeProviderAuthentication(providerId, providerName, "api_key", previousModel);
			// 登录或后续完成步骤失败时进入这里。
		} catch (error: unknown) {
			// 失败也尝试恢复；若此函数抛错，后面错误分类不会执行。
			restoreEditor();
			// 取错误文字，下面有一条按确切文字识别取消。
			const errorMsg = error instanceof Error ? error.message : String(error);
			// 专门识别已完成凭据变更后的本地同步失败。
			if (error instanceof CredentialSynchronizationError) {
				// 显示部分成功说明，不谎称key仍未保存。
				this.showError(
					// 保留Provider名和同步错误详情，不重新打印key。
					`Saved API key for ${providerName}, but local model state could not be synchronized: ${errorMsg}`,
				);
				// 只有消息严格等于Login cancelled走返回来源菜单；其他取消样式不会自动归入此分支。
			} else if (errorMsg === "Login cancelled") {
				// 存在返回回调才调用，没有则仅恢复编辑区。
				onBack?.();
				// 其余失败使用普通保存失败提示。
			} else {
				// 显示Provider和错误文字，不自动重试认证或删除已变更凭据。
				this.showError(`Failed to save API key for ${providerName}: ${errorMsg}`);
			}
		}
	}

	// 把认证select提示转成字符串菜单，输入登录面板/选择提示/ProviderID，返回所选选项ID的Promise；取消拒绝Login cancelled。
	// 例如显示Browser但返回id=browser；通过label查首项，因此同名label会映到第一条，空ID按取消处理。这里只建UI，不实现prompt.signal取消，外层showAuthPrompt负责竞速。
	private showAuthSelect(
		// 认证菜单结束后需恢复的原登录面板引用。
		dialog: LoginDialogComponent,
		// Extract从AuthPrompt联合筛出type=select分支，让TS允许访问options；没有运行时schema转换。
		prompt: Extract<AuthPrompt, { type: "select" }>,
		// ProviderID只用于Radius说明差异，不从此ID解析秘密。
		providerId: string,
	): Promise<string> {
		// Promise executor立即建面板并保存回调，等待用户选择，不阻塞JS线程。
		return new Promise((resolve, reject) => {
			// 恢复原dialog的同步闭包；不重新创建其输入等待状态。
			const restoreDialog = () => {
				// 清当前选择界面。
				this.editorContainer.clear();
				// 把原登录面板加回来。
				this.editorContainer.addChild(dialog);
				// 恢复dialog焦点。
				this.ui.setFocus(dialog);
				// 请求重绘。
				this.ui.requestRender();
			};
			// 仅取label作为菜单项，选项description没有在这里逐项展示。
			const labels = prompt.options.map((option) => option.label);
			// 直接构造字符串选择器，没有走普通showSelector或扩展对话栈。
			const selector = new ExtensionSelectorComponent(
				// 提示message作菜单标题。
				prompt.message,
				// 传只含label的数组，ID稍后再从原options查回。
				labels,
				// 确认回调拿到label字符串，不是原选项对象。
				(optionLabel) => {
					// 先恢复dialog，之后才结算等待选择的Promise。
					restoreDialog();
					// 按label严格相等找第一条，再取其ID；重复标签无法在此区分。
					const id = prompt.options.find((option) => option.label === optionLabel)?.id;
					// ID真值才resolve；空字符串ID并不会被当作有效答案。
					if (id) resolve(id);
					// 缺失/空ID则拒绝取消错误，不同步throw该Error。
					else reject(new Error("Login cancelled"));
				},
				// 取消回调负责恢复并拒绝，不保存任何选择。
				() => {
					// 返回原登录面板。
					restoreDialog();
					// 用固定错误文字通知上层取消。
					reject(new Error("Login cancelled"));
				},
				// 只有Radius附固定介绍说明；其他Provider显式undefined，不展示每个option.description。
				{ description: providerId === RADIUS_PROVIDER_ID ? RADIUS_LOGIN_INTRO : undefined },
			);
			// 清编辑区域，尚未结算原dialog里的其他等待输入。
			this.editorContainer.clear();
			// 挂本次认证选择器。
			this.editorContainer.addChild(selector);
			// 焦点交选择器。
			this.ui.setFocus(selector);
			// 请求显示候选。
			this.ui.requestRender();
		});
	}

	// 统一处理认证输入提示，返回答案字符串Promise；select走ID菜单、manual_code走粘贴输入，其余text/secret共用普通showPrompt，再按可选signal与取消竞速。
	// 例如回调服务器先成功可取消手动输入等待；取消竞速只拒本次返回，不自动移除已经显示的菜单/清除原输入Promise。secret目前没有单独遮罩，placeholder仅显示示例。
	private async showAuthPrompt(dialog: LoginDialogComponent, prompt: AuthPrompt, providerId: string): Promise<string> {
		// 先声明本次用户交互的Promise，下面各分支都给它赋值。
		let response: Promise<string>;
		// 判别联合标签为select后TS知道存在options。
		if (prompt.type === "select") {
			// 立即创建选择UI，然后保存等待结果Promise。
			response = this.showAuthSelect(dialog, prompt, providerId);
			// manual_code显示手动码/回调地址输入。
		} else if (prompt.type === "manual_code") {
			// 只传message，manual_code的placeholder在此分支没有使用。
			response = dialog.showManualInput(prompt.message);
			// 剩余允许的text和secret走同一UI实现。
		} else {
			// showPrompt复用明文Input并显示placeholder示例，不因prompt.type=secret而自动隐藏输入/提交文本。
			response = dialog.showPrompt(prompt.message, prompt.placeholder);
		}
		// 没有单步信号直接返回response，由async函数接管其结算。
		if (!prompt.signal) return response;
		// 预取消检查发生在创建/显示交互之后；即使已abort，UI也可能已变化，并不会在此自动还原。
		if (prompt.signal.aborted) throw new Error("Login cancelled");
		// 把已确认存在的信号保留为局部引用，供监听和清理。
		const signal = prompt.signal;
		// 保存待安装的abort回调，类型是无参void函数或undefined。
		let onAbort: (() => void) | undefined;
		// 建立只会因取消拒绝的Promise，_resolve不用，不会主动成功。
		const aborted = new Promise<string>((_resolve, reject) => {
			// 事件到达时reject固定取消Error，不从事件回调同步throw。
			onAbort = () => reject(new Error("Login cancelled"));
			// 只监听一次abort，下面finally仍主动移除未触发监听器。
			signal.addEventListener("abort", onAbort, { once: true });
		});
		// 竞速后无论成功还是拒绝都清理本次监听。
		try {
			// 等答案或取消最先结算；Promise.race不会取消另一条Promise，也不自动结束仍显示的旧菜单。
			return await Promise.race([response, aborted]);
			// 成功、失败或return都走finally。
		} finally {
			// 若已创建回调则从同一个signal移除，避免残留监听；不处置response的内部输入槽。
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	// 把认证通知投影到登录面板，输入事件联合，返回void；按URL/设备码/说明/进度显示，不在本函数自行换token或保存凭据。
	// 例如auth_url会经dialog.showAuth尝试开浏览器，设备码则先显示、等用户确认便利操作；不能把所有notify都说成纯文字无副作用。
	private notifyAuthDialog(dialog: LoginDialogComponent, event: AuthEvent): void {
		// auth_url分支TS可读url/instructions。
		if (event.type === "auth_url") {
			// 交面板显示授权地址和说明；合法http(s)目标会尝试用系统浏览器打开，不等待认证完成。
			dialog.showAuth(event.url, event.instructions);
			// device_code事件携用户短码、验证URL及可选确认开关等。
		} else if (event.type === "device_code") {
			// 面板显示设备码并安装可能的确认后开浏览器/复制动作；此调用本身不轮询。
			dialog.showDeviceCode(event);
			// 额外追加等待文字，真正设备授权轮询由Provider流程执行。
			dialog.showWaiting("Waiting for authentication...");
			// info事件显示普通说明和可选链接。
		} else if (event.type === "info") {
			// showInfo追加消息/链接，默认没有关闭提示，不把链接存在当登录成功。
			dialog.showInfo(event.message, event.links);
			// 当前联合余项是progress，不是任意未知wire事件的运行时验证分支。
		} else {
			// 追加进度文字并请求重绘，不实现进度百分比或重试。
			dialog.showProgress(event.message);
		}
	}

	// 将认证运行时与登录面板接起来，输入面板/Provider身份/方式，返回Promise<void>；标记等待用户认证状态，转交取消/询问/通知回调，finally清状态。
	// 例如Provider询问区域会调用showAuthPrompt，返回文字再继续登录；登录可能联网并变更凭据，getDeviceId按需生成用户安装ID。这里不直接访问key/token来显示。
	private async loginProvider(
		// 面板提供整个登录信号与实际交互展示。
		dialog: LoginDialogComponent,
		// 稳定ProviderID给运行时定位能力。
		providerId: string,
		// 显示名仅用于状态文字。
		providerName: string,
		// 字面联合限定api_key/oauth，不靠方法名自动推断。
		method: "api_key" | "oauth",
		// 返回Promise只标本轮运行时登录结算，不含之后目录后台刷新。
	): Promise<void> {
		// 在try前注册login阻塞状态；这是程序状态报告，不是建立互斥锁或禁止所有输入。
		this.programStatus.setBlocked("login", { kind: "auth", message: `Log in to ${providerName}` });
		// 无论登录成功、拒绝还是取消，都会走finally清此状态。
		try {
			// 等待运行时按同Provider串行登录、修改凭据和同步本地状态；交互和网络由具体Provider执行。
			await this.session.modelRuntime.login(
				// 传目标ID。
				providerId,
				// 传用户已选的认证方式。
				method,
				// 交互对象让运行时与面板交流，不把UI组件直接作为凭据存储。
				{
					// 面板取消信号用于整轮登录，具体底层必须合作观察，取消不保证外部动作已停止。
					signal: dialog.signal,
					// prompt回调返回Promise，Provider等待用户文字/ID；闭包保留当前dialog和providerId。
					prompt: (prompt) => this.showAuthPrompt(dialog, prompt, providerId),
					// notify回调同步更新UI，返回void不自动吞异常。
					notify: (event) => this.notifyAuthDialog(dialog, event),
				},
				// 只把获取安装ID的闭包传入，需要它的flow才执行；首次执行可能生成UUID并排队保存用户设置，不使用项目层deviceId。
				{ getDeviceId: () => this.settingsManager.getOrCreateDeviceId() },
			);
			// 登录的正常/异常结算均清程序等待状态。
		} finally {
			// 只清login键，不直接停止Provider网络、关闭dialog或注销凭据。
			this.programStatus.setBlocked("login", undefined);
		}
	}

	// 承载OAuth登录完整UI流程，输入ProviderID/名称/可选返回菜单动作，返回Promise<void>；显示面板、等待运行时登录、恢复编辑器、协调默认模型，Radius还可询问MCP配置。
	// 例如授权成功但本地快照同步失败时保留成功事实并显示专门错误；取消只按确切Login cancelled消息识别。构造/挂载在try外，恢复UI和后续步骤也无全事务回滚。
	private async showLoginDialog(providerId: string, providerName: string, onBack?: () => void): Promise<void> {
		// 捕获登录前模型引用，后续仅unknown占位模型考虑自动选择。
		const previousModel = this.session.model;
		// 创建面板并给空完成回调，真正结果由Runtime.login的Promise决定；组件取消仍会abort自身信号。
		const dialog = new LoginDialogComponent(this.ui, providerId, (_success, _message) => {}, providerName);
		// 清编辑区显示，不销毁this.editor。
		this.editorContainer.clear();
		// 挂载登录面板。
		this.editorContainer.addChild(dialog);
		// 面板取得焦点供用户交互。
		this.ui.setFocus(dialog);
		// 请求显示登录界面。
		this.ui.requestRender();

		// 本地恢复函数用于成功和失败，共用当时当前this.editor而非旧编辑器快照。
		const restoreEditor = () => {
			// 移除登录等显示内容。
			this.editorContainer.clear();
			// 放回当前编辑器。
			this.editorContainer.addChild(this.editor);
			// 恢复编辑焦点。
			this.ui.setFocus(this.editor);
			// 请求恢复画面。
			this.ui.requestRender();
		};

		// 捕获登录和后续完成/MCP询问失败，已成功认证不自动撤销。
		try {
			// 等待OAuth能力交互和运行时凭据同步，可能联网、打开浏览器并保存token。
			await this.loginProvider(dialog, providerId, providerName, "oauth");
			// 成功后先恢复编辑器再显示完成状态。
			restoreEditor();
			// 协调默认选模并安排后台目录刷新；返回时后台刷新可尚未结束。
			await this.completeProviderAuthentication(providerId, providerName, "oauth", previousModel);
			// 仅Radius提供全局MCP复用此登录的可选配置菜单；调用此辅助不代表已经写入。
			if (providerId === RADIUS_PROVIDER_ID) this.offerRadiusMcpServer(providerId, providerName);
			// try内后续步骤失败也会进入这里，不仅OAuth远端失败。
		} catch (error: unknown) {
			// 失败也尝试恢复编辑器；恢复自身若抛错不再被此catch重新捕获。
			restoreEditor();
			// 生成可显示错误文字。
			const errorMsg = error instanceof Error ? error.message : String(error);
			// 凭据变更后本地同步失败用专门类型区分。
			if (error instanceof CredentialSynchronizationError) {
				// 显示已登录但同步失败的部分成功说明。
				this.showError(
					// Provider显示名及错误详情，不打印实际token。
					`Logged in to ${providerName}, but local model state could not be synchronized: ${errorMsg}`,
				);
				// 确切取消文字才回来源菜单，不是通用AbortError类型判断。
			} else if (errorMsg === "Login cancelled") {
				// 有onBack才重开来源，未提供时只保留恢复后的编辑器。
				onBack?.();
				// 其他失败显示一般登录错误，可能发生在凭据已保存后的选模/询问环节。
			} else {
				// 显示错误，不自动删除已提交的认证状态。
				this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
			}
		}
	}

	/**
	 * Offer to point the Radius MCP server in the global mcp.json at the Radius login, adding the server
	 * when missing. Nothing is asked when a global server already uses this login.
	 */
	// 询问是否让全局Radius MCP配置复用本次登录，输入Provider身份，返回void；读全局配置、按规范URL找已有项，确认后添加/替换并后台reload。
	// 例如已有同URL但用独立OAuth时，确认后用auth.provider替换并移除oauth字段；不读项目配置，不直接连接MCP，也不保证名字回退radius-mcp没有再撞名。
	private offerRadiusMcpServer(providerId: string, providerName: string): void {
		// 用config的agentDir定位全局mcp.json，当前cwd只作为加载器参数，不决定写入项目路径。
		const mcpPath = path.join(getAgentDir(), "mcp.json");
		// 局部纯字符串辅助删除结尾连续斜杠；u正则无m，$不能忽略最后LF，也不做URL解析、主机大小写/默认端口规范化。
		const normalizeUrl = (url: string) => url.replace(/\/+$/u, "");
		// 加载配置声明，只取servers，加载器返回的errors在此未展示。
		const { servers } = loadMcpConfig({
			// 全局目录通过helper取得，不硬编码主目录。
			agentDir: getAgentDir(),
			// 给当前会话cwd，但下面明确关闭项目配置读取。
			cwd: this.sessionManager.getCwd(),
			// false使loadMcpConfig只加载全局mcp.json，不代表更改本会话的项目可信状态。
			projectTrusted: false,
		});
		// 找首个HTTP且去尾斜杠后的URL字符串与Radius常量相等的服务器，包含disabled声明。
		const existing = servers.find(
			// in区分含url的HTTP配置，严格字符串比较不访问服务端。
			(server) => "url" in server.config && normalizeUrl(server.config.url) === normalizeUrl(RADIUS_MCP_URL),
		);
		// 已有同URL且auth.provider等于当前ID就直接跳过，不要求enabled:true，也不额外确认其他认证字段是否一致。
		if (existing && "url" in existing.config && existing.config.auth?.provider === providerId) return;

		// 优先沿用同URL服务器名字，没有才尝试radius。
		let name = existing?.name ?? "radius";
		// 没有同URL项且radius名字被占时仅退到radius-mcp，不继续检查该名字是否也被占用。
		if (!existing && servers.some((server) => server.name === name)) name = "radius-mcp";
		// 声明目标HTTP配置类型，类型检查不在此重新校验整个已有配置。
		// 浅复制已有配置，但auth整对象替成只含provider的新对象，不深合并旧auth子字段。
		// 没有已有项时生成固定Radius URL和共享Provider认证引用。
		const config: McpHttpServerConfig =
			// 已有HTTP项时保留其他顶层选项。
			existing && "url" in existing.config
				? { ...existing.config, auth: { provider: providerId } }
				: { url: RADIUS_MCP_URL, auth: { provider: providerId } };
		// `auth` replaces the MCP OAuth sign-in.
		// 从这个新配置对象删独立oauth入口；不删除其他服务器/全局OAuth token，不直接注销远端。
		delete config.oauth;

		// 打开普通Yes/No菜单，之前只是读取和构造配置。
		this.showSelector((done) => {
			// 字符串选择器负责用户意图，不直接写文件。
			const selector = new ExtensionSelectorComponent(
				// 标题明确显示Provider和即将修改的全局路径。
				`Configure ${providerName} MCP in ${mcpPath}?`,
				// 固定Yes/No两项，不把取消自动当Yes。
				["Yes", "No"],
				// 确认回调拿字符串，返回void。
				(option) => {
					// 先关菜单再执行写入，写入失败不会自动重开。
					done();
					// 所有非Yes选项直接返回，包括No。
					if (option !== "Yes") return;
					// 只把同步配置写入包进try；下面reload是独立后台步骤。
					try {
						// 按名字整项添加/替换HTTP配置，可创建文件与父目录；返回替换标志在此未使用，同名radius-mcp会被替换。
						addMcpServerConfig(mcpPath, name, config);
						// 配置读改写抛错时显示错误并停止，不继续重载。
					} catch (error: unknown) {
						// 把文件路径及错误文字展示给用户。
						this.showError(
							// Error用message，其他值转String，不在此自动修复损坏配置。
							`Could not update ${mcpPath}: ${error instanceof Error ? error.message : String(error)}`,
						);
						// 结束本次配置确认。
						return;
					}
					// The MCP extension reads mcp.json when the session starts.
					// 后台请求资源重载以让MCP会话启动流程读新配置；忙碌时handleReloadCommand可能只警告并返回，写入不会因此回滚。
					void this.handleReloadCommand();
				},
				// 菜单取消不写mcp.json。
				() => {
					// 关闭普通选择器。
					done();
					// 请求恢复编辑区显示。
					this.ui.requestRender();
				},
			);
			// 同一个字符串面板作渲染/焦点；这里没有倒计时或动画dispose。
			return { component: selector, focus: selector };
		});
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	// 重载设置/键位/扩展/技能/提示/主题/上下文资源，返回Promise<void>；拒绝活动回复或压缩，先重置扩展UI，再显示提示框，Session重载后重新绑定展示配置。
	// 例如扩展session_start要加自定义消息时，beforeSessionStart先重建旧聊天，避免事后重建擦掉新消息。失败只尝试恢复编辑区域，不回滚已失效旧runner、已加载资源或先前resetExtensionUI副作用。
	private async handleReloadCommand(): Promise<void> {
		// Agent仍在回复/收尾时不允许此入口重载，避免换掉执行中的扩展能力。
		if (this.session.isStreaming) {
			// 显示等待当前回复结束的警告。
			this.showWarning("Wait for the current response to finish before reloading.");
			// 到此结束，没有重置扩展UI或重新扫描资源。
			return;
		}
		// 压缩/树导航控制器活动时也拒绝重载。
		if (this.session.isCompacting) {
			// 显示等待压缩结束的警告。
			this.showWarning("Wait for compaction to finish before reloading.");
			// 结束，不抢占当前操作界面。
			return;
		}

		// 先清扩展编辑器/控件/监听/选择器等UI绑定；这一步在try外，且不保证结算所有旧对话Promise。
		this.resetExtensionUI();

		// 建立仅用于重载进度显示的普通容器。
		const reloadBox = new Container();
		// 局部样式函数每次用共享theme给边框着色，不缓存旧ANSI字符串。
		const borderColor = (s: string) => theme.fg("border", s);
		// 加入顶边框。
		reloadBox.addChild(new DynamicBorder(borderColor));
		// 边框后空一行。
		reloadBox.addChild(new Spacer(1));
		// 把延迟按主题生成的说明加入提示框。
		reloadBox.addChild(
			// ThemedText负责显示，不执行重载工作。
			new ThemedText(
				// 渲染时取muted颜色，文案列出将重载的资源种类。
				() => theme.fg("muted", "Reloading keybindings, extensions, skills, prompts, themes, and context files..."),
				// 文字水平内边距一列。
				1,
				// 文字上下不额外留行，空白由Spacer控制。
				0,
			),
		);
		// 说明后留空行。
		reloadBox.addChild(new Spacer(1));
		// 加入同色底边框。
		reloadBox.addChild(new DynamicBorder(borderColor));

		// 捕获resetExtensionUI之后当前编辑器，供失败路径恢复；不一定是重载命令刚进入前的扩展编辑器。
		const previousEditor = this.editor;
		// 清编辑区域显示槽。
		this.editorContainer.clear();
		// 挂重载提示框，不放回输入编辑器。
		this.editorContainer.addChild(reloadBox);
		// 焦点交提示容器，当前普通编辑输入暂不在焦点上。
		this.ui.setFocus(reloadBox);
		// 请求强制重绘，仍由TUI调度输出。
		this.ui.requestRender(true);
		// 等到Node nextTick回调结算，让出一次执行机会；不是等待终端确认已显示或屏幕已完全绘完。此await在try外。
		await new Promise((resolve) => process.nextTick(resolve));

		// 本地恢复显示函数接Component，清区域、挂组件、聚焦并重绘，返回void，不修改this.editor字段。
		const dismissReloadBox = (editor: Component) => {
			// 清当前重载提示或其他组件。
			this.editorContainer.clear();
			// 挂传入的组件引用。
			this.editorContainer.addChild(editor);
			// 焦点交传入组件，由TUI判断实际输入能力。
			this.ui.setFocus(editor);
			// 请求绘出恢复结果。
			this.ui.requestRender();
		};

		// 用于将聊天重建限制在本次重载最多一次成功完成，防止前置钩子和fallback重复清屏。
		let chatRestoredBeforeSessionStart = false;
		// 记录成功流程是否已经撤下提示框，错误路径据此决定是否恢复旧编辑器。
		let reloadBoxDismissed = false;
		// 前置恢复回调无参数/返回；更新展示设置后按当前消息重建聊天，不在此触发模型。
		const restoreChatBeforeSessionStart = () => {
			// 已成功重建就立即返回，扩展启动新增内容不会再被fallback擦掉。
			if (chatRestoredBeforeSessionStart) {
				// 结束重复调用。
				return;
			}
			// 在新设置读取后同步思考块隐藏偏好。
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			// 同步输出留白，后面新聊天组件使用此值。
			this.outputPad = this.settingsManager.getOutputPad();
			// 清聊天区并按当前有效消息重建；不是删除会话历史。
			this.rebuildChatFromMessages();
			// 重建成功后才标记完成；前面抛错不会把失败记成已恢复。
			chatRestoredBeforeSessionStart = true;
		};

		// 只从Session.reload开始捕获失败，先前reset/提示框构造等并不在此try里。
		try {
			// 等待Session重新读设置/资源、失效旧扩展并构新runner；有宿主绑定时在新session_start之前调用本回调。
			await this.session.reload({ beforeSessionStart: restoreChatBeforeSessionStart });
			// 若Session未调用前置钩子就在返回后补重建；已做过时回调自己短路。
			restoreChatBeforeSessionStart();
			// 重新读取键位文件，后续菜单/短键按新有效配置。
			this.keybindings.reload();
			// 优先自定义页眉，否则内置页眉，??不会因一般假值替换合法组件对象。
			const activeHeader = this.customHeader ?? this.builtInHeader;
			// 按运行时能力判断是否可展开，而非假设任意header都有此方法。
			if (isExpandable(activeHeader)) {
				// 同步全局展开状态，不写用户设置。
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			// 以新资源加载器的主题列表替换扩展主题注册表，getter自身不再次扫描。
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			// 应用运行时显示/HTTP/编辑器等设置，具体哪些即时生效看该辅助，不保证旧组件全部自动更新。
			this.applyRuntimeSettings();
			// 主题控制器按新设置选主题/自动深浅联动，可能读取主题文件。
			this.themeController.applyFromSettings();
			// 重建命令/技能/模型等补全源及扩展包装。
			this.setupAutocompleteProvider();
			// 取重载后当前扩展runner，而不是继续用旧失效实例。
			const runner = this.session.extensionRunner;
			// 按当前键位注册新扩展快捷处理。
			this.setupExtensionShortcuts(runner);
			// 更新资源说明与诊断，下面选项控制安静启动时展示边界。
			this.showLoadedResources({
				// 不强制列全部资源，仍依设置决定普通详情。
				force: false,
				// 即使quiet也显示诊断，避免重载错误被静默隐藏。
				showDiagnosticsWhenQuiet: true,
			});
			// 按记忆cwd/当前信任/实际项目资源条件尝试补存隐式信任；成功写入true才返回true。
			const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();
			// 读取模型运行时已有错误汇总，可能含配置、组合、可用性错误，不只models.json解析。
			const modelsJsonError = this.session.modelRuntime.getError();
			// 存在错误文字则额外显示，不把整个reload必然判成抛错。
			if (modelsJsonError) {
				// 显示原文models.json error标签；不应据标签误解getError只包含此一种来源。
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			// 显示重载完成状态，并区分是否本次额外保存项目信任。
			// savedImplicitProjectTrust为true时说明本次保存过，不保证以后磁盘/目录永远不变。
			// 否则普通重载完成说明。
			this.showStatus(
				// 按补存信任结果选择文案。
				savedImplicitProjectTrust
					? "Reloaded keybindings, extensions, skills, prompts, themes, and context files; saved project trust"
					: "Reloaded keybindings, extensions, skills, prompts, themes, and context files",
			);
			// 成功时挂当前this.editor；as Component只作类型断言，不新建/校验组件。
			dismissReloadBox(this.editor as Component);
			// 只有恢复显示调用成功后才记提示框已撤下。
			reloadBoxDismissed = true;
			// 重载或try内后续更新失败都进入此处，不能据此认定旧扩展/资源仍完整可用。
		} catch (error) {
			// 尚未成功撤提示时尝试挂之前捕获的编辑器。
			if (!reloadBoxDismissed) {
				// 只恢复显示组件，没把this.editor字段或其他重载副作用全回滚；恢复本身再失败会向上拒绝。
				dismissReloadBox(previousEditor as Component);
			}
			// 显示错误，不再次自动执行reload。
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// 处理/export，输入整条命令，返回Promise<void>；解析首个路径，精确小写.jsonl后缀导当前分支，否则HTML，成功显示实际路径、失败显示错误。
	// 例如/export "my report.html"保留空格；没有路径按HTML导出器默认位置，返回路径可能相对，不能一概说绝对路径。
	private async handleExportCommand(text: string): Promise<void> {
		// 只解析首路径参数，不执行shell展开或创建文件；解析发生在try外。
		const outputPath = this.getPathCommandArgument(text, "/export");

		// 捕获实际导出和完成状态展示失败。
		try {
			// ?.允许缺路径；endsWith大小写敏感，.JSONL不会走JSONL分支。
			if (outputPath?.endsWith(".jsonl")) {
				// 同步写当前分支JSONL，导出器返回实际路径，不包含未选中的所有分支。
				const filePath = this.session.exportToJsonl(outputPath);
				// 显示返回路径，不再次规范化或核验文件内容。
				this.showStatus(`Session exported to: ${filePath}`);
				// 其他后缀或缺路径均按HTML处理，并非检查扩展名有效才允许导出。
			} else {
				// 等待HTML导出，可能调用扩展HTML工具渲染器并写文件，不请求模型生成页面。
				const filePath = await this.session.exportToHtml(outputPath, {
					// 传当前主题名供导出优先候选，Session还会检查有效主题并做回退。
					themeName: theme.name,
				});
				// 显示实际HTML输出路径，可能是相对路径。
				this.showStatus(`Session exported to: ${filePath}`);
			}
			// unknown允许不是Error的抛出值。
		} catch (error: unknown) {
			// 仅Error保留message，其他值用Unknown error而不是String(error)，原行为保持。
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	// 从/export或/import整条命令取首个路径，返回字符串或undefined；支持首字符单/双引号包空格，不是完整shell参数解析器，无文件I/O。
	// 例如/export 'a b.html'返回a b.html，尾随参数忽略；未闭引号返回undefined，反斜杠转义和变量/~展开不在此处理。
	private getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
		// 完全只有命令名视为没传路径。
		if (text === command) {
			// 用undefined让导出选择默认路径/导入显示usage。
			return undefined;
		}
		// 要求命令后是普通空格；仅tab分隔不会在此被识别。
		if (!text.startsWith(`${command} `)) {
			// 非此命令前缀直接没有参数。
			return undefined;
		}

		// 切去命令与第一个空格，再只trimStart；尾空白稍后由首个空白截断规则处理。
		const argsString = text.slice(command.length + 1).trimStart();
		// 没有剩余非前导空白内容则缺参数。
		if (!argsString) {
			// 返回undefined，不返回空路径。
			return undefined;
		}

		// 读取首UTF-16码元，用于判断引号风格。
		const firstChar = argsString[0];
		// 首字符单/双引号才进入引号分支，两者不混合配对。
		if (firstChar === '"' || firstChar === "'") {
			// 从下标1找首个同样引号，不识别反斜杠转义。
			const closingQuoteIndex = argsString.indexOf(firstChar, 1);
			// 没闭引号时当作缺少可解析路径。
			if (closingQuoteIndex < 0) {
				// 返回undefined而非把残串当路径。
				return undefined;
			}
			// 只取两引号之间内容；空引号返回空字符串，闭引号之后内容全部忽略。
			return argsString.slice(1, closingQuoteIndex);
		}

		// 非引号路径找第一个正则空白，包含空格、tab等，不仅普通空格。
		const firstWhitespaceIndex = argsString.search(/\s/);
		// 没有空白就整段都是首参数。
		if (firstWhitespaceIndex < 0) {
			// 保留原字符串，不自动去引号/展开环境变量。
			return argsString;
		}
		// 有空白只取其之前路径，其他参数忽略。
		return argsString.slice(0, firstWhitespaceIndex);
	}

	// 处理/import，输入整条命令，返回Promise<void>；先解析路径和确认替换，再Runtime复制/打开并重绑会话，缺cwd可询问覆盖重试。
	// 例如源文件不存在显示非致命错误；其他首轮导入错误走致命处理。确认在try外，catch内重试失败向上拒绝，已复制目标文件不在此回滚或删除。
	private async handleImportCommand(text: string): Promise<void> {
		// 解析首路径，不根据.jsonl后缀在本层做文件内容校验。
		const inputPath = this.getPathCommandArgument(text, "/import");
		// undefined或空引号路径都无效。
		if (!inputPath) {
			// 显示usage说明。
			this.showError("Usage: /import <path.jsonl>");
			// 不询问确认也不读源文件。
			return;
		}

		// 等待用户明确是否替换当前会话；确认对话失败不由下方try处理。
		const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
		// No或取消均为false，不进入导入流程。
		if (!confirmed) {
			// 显示导入取消状态。
			this.showStatus("Import cancelled");
			// 保留当前会话，返回。
			return;
		}

		// 从清状态开始捕获首轮导入与完成提示失败。
		try {
			// 清已有状态指示器，不删除会话历史。
			this.clearStatusIndicator();
			// Runtime可复制源到会话目录、咨询扩展、检查cwd并替换运行时，不只是读入一组消息。
			const result = await this.runtimeHost.importFromJsonl(inputPath);
			// 运行时切换前钩子等可以取消。
			if (result.cancelled) {
				// 报告取消，不说导入成功；之前可能已经创建目录。
				this.showStatus("Import cancelled");
				// 结束此路径。
				return;
			}
			// 成功后显示输入路径，未展示Runtime内部可能避让重名后的目标路径。
			this.showStatus(`Session imported from: ${inputPath}`);
			// 区分缺cwd、缺源文件和其他首轮错误。
		} catch (error: unknown) {
			// 专门缺工作目录错误允许询问回退。
			if (error instanceof MissingSessionCwdError) {
				// 等待用户接受候选cwd，不自动mkdir原项目目录。
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				// 没有非空选择表示取消。
				if (!selectedCwd) {
					// 显示取消状态。
					this.showStatus("Import cancelled");
					// 不再重试导入。
					return;
				}
				// 在catch内传覆盖cwd重试；可能再次复制到新避让文件名，失败不会由此catch重新捕获。
				const result = await this.runtimeHost.importFromJsonl(inputPath, selectedCwd);
				// 第二轮也可能被扩展取消。
				if (result.cancelled) {
					// 显示重试导入取消。
					this.showStatus("Import cancelled");
					// 结束，保留已发生文件副作用而不伪造成功。
					return;
				}
				// 第二轮成功仍显示原输入路径。
				this.showStatus(`Session imported from: ${inputPath}`);
				// 处理完缺cwd重试即返回，不落入其他错误分类。
				return;
			}
			// 源文件不存在用专门异常类识别，和其他I/O失败不同。
			if (error instanceof SessionImportFileNotFoundError) {
				// 仅显示非致命导入错误，不退出整个程序。
				this.showError(`Failed to import session: ${error.message}`);
				// 结束本次命令，允许继续当前会话。
				return;
			}
			// 其他首轮错误交致命Runtime处理，正常流程停止UI并退出；不是普通警告后继续使用可能半替换状态。
			await this.handleFatalRuntimeError("Failed to import session", error);
		}
	}

	// 分享当前会话的命令适配，返回Promise<void>；把当前Session/UI/编辑器与消息回调交shareSession，具体导出、认证、上传或复制由该helper执行。
	// 例如/share可按设置使用分享后端；这里没有自实现上传协议，也不保证操作纯本地或自动脱敏。
	private async handleShareCommand(): Promise<void> {
		// 等待分享辅助完成其流程，错误处理以辅助内部和调用者为准。
		await shareSession({
			// 传调用时当前Session引用。
			session: this.session,
			// 传TUI界面能力。
			ui: this.ui,
			// 提供可临时替换的编辑区容器。
			editorContainer: this.editorContainer,
			// 提供当前编辑器对象，不是完整序列化输入状态。
			editor: this.editor,
			// 状态回调闭包调用本实例showStatus，保持this语义。
			showStatus: (message) => this.showStatus(message),
			// 错误回调转显示，不在此添加另一次上传。
			showError: (message) => this.showError(message),
		});
	}

	// 问题报告命令适配，输入可选用户线索，返回Promise<void>；转交会话/界面/键位给reportBug，由辅助询问并收集、总结或上传。
	// 例如用户可提供一个问题描述作为hint，不等于直接把所有会话内容上传；具体选择和脱敏边界在reportBug实现，不能在此保证无敏感数据。
	private async handleBugCommand(hint: string | undefined): Promise<void> {
		// 等待报告辅助流程，不在本入口直接调用模型或HTTP。
		await reportBug(
			// 第一参数为UI/会话依赖对象。
			{
				// 传当前会话，辅助据此选分享/摘要等路径。
				session: this.session,
				// 传TUI用于显示交互状态。
				ui: this.ui,
				// 提供报告期间可替换的编辑区域。
				editorContainer: this.editorContainer,
				// 提供当前输入编辑器。
				editor: this.editor,
				// 复用有效键位配置。
				keybindings: this.keybindings,
				// 状态反馈交本实例处理。
				showStatus: (message) => this.showStatus(message),
				// 错误反馈交本实例显示，不在此改变报告内容。
				showError: (message) => this.showError(message),
			},
			// 第二参数透传可选hint，不在这里拼成新的运行时提示词。
			hint,
		);
	}

	// 复制选区或最近助手文字，返回Promise<void>，有实际剪贴板副作用；优先选区需明确选项、备用屏、关闭自动复制且当前有选区，否则取Session最新合格助手。
	// 例如最近助手只有toolCall会无文字，并不会继续向前找第二条文字回复。选区复制在try外，普通消息复制失败才由下面catch显示；flash只改变完成反馈样式。
	private async handleCopyCommand(
		// 可选对象缺省新{}；flashConfirmation选择短暂提示，preferSelection启用优先选区规则，均不默认开启。
		options: { flashConfirmation?: boolean; preferSelection?: boolean } = {},
	): Promise<void> {
		// 以下四个条件&&同时成立才走选区，按顺序短路。
		if (
			// 调用者明确希望优先选区。
			options.preferSelection &&
			// 需当前UI是实际TuiAltScreen实例，普通主屏不提供这一专用路径。
			this.ui instanceof TuiAltScreen &&
			// 启用copy-on-select时不在本分支再次复制选区。
			!this.ui.getCopyOnSelect() &&
			// 还必须有活动选区，不能只凭备用屏类型假定有文字。
			this.ui.hasActiveSelection()
		) {
			// 等待备用屏自己的选区复制；此await在下面普通复制try外，拒绝会向调用者传出。
			await this.ui.copyActiveSelectionToClipboard();
			// 完成选区路径后不再复制助手消息，也不走下面flash/status反馈。
			return;
		}

		// Session倒序找最近合格assistant并拼text，跳过完全无内容的aborted，trim后可能undefined。
		const text = this.session.getLastAssistantText();
		// 没有非空文字时显示错误，不把thinking/tool参数当文字复制。
		if (!text) {
			// 显示无助手文字提示，并非证明历史绝无assistant对象。
			this.showError("No agent messages to copy yet.");
			// 结束，不调用剪贴板。
			return;
		}

		// 捕获普通消息复制及反馈UI失败。
		try {
			// 等待实际系统剪贴板helper，不只是改内存变量。
			await copyToClipboard(text);
			// 请求flash且当前仍是备用屏时采用闪现提示；await后UI可能已切换，故这里再次判断类型。
			if (options.flashConfirmation && this.ui instanceof TuiAltScreen) {
				// 显示短暂Copied反馈，不新增普通聊天状态行。
				this.ui.flash("Copied!");
				// 其他情况采用普通状态说明。
			} else {
				// 显示最近助手消息已复制。
				this.showStatus("Copied last agent message to clipboard");
			}
			// 复制或成功反馈失败进入此处，已成功替换剪贴板不被回滚。
		} catch (error) {
			// Error取message，其他抛出值转String。
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	// 设置或查看会话显示名，输入整条/name命令，返回void；去前缀/首尾空白，无名字则展示已有名或usage，有名字则追加名称记录并显示最终值。
	// 例如/name 登录排查只改会话显示名，不改JSONL文件名或会话ID；传空白不是删除名称。保存/观察者错误没有本地try捕获。
	private handleNameCommand(text: string): void {
		// 正则只去字符串起始/name及其后连续空白，再trim两端；函数本身没有额外验证/name后必须是分隔符，正常入口已按命令匹配。
		const name = text.replace(/^\/name\s*/, "").trim();
		// 没有剩余名字就走查看，不把空字符串写入历史。
		if (!name) {
			// 读取管理器当前有效会话名，不重新扫描整个目录。
			const currentName = this.sessionManager.getSessionName();
			// 当前名真值才显示，空串与undefined都走usage。
			if (currentName) {
				// 聊天区留一行空白。
				this.chatContainer.addChild(new Spacer(1));
				// 捕获当前名作为本条显示内容，ThemedText渲染时才取主题颜色；之后别处改名不会自动改此捕获值。
				this.chatContainer.addChild(new ThemedText(() => theme.fg("dim", `Session name: ${currentName}`), 1, 0));
				// 尚无有效显示名时提示用法。
			} else {
				// 普通警告，不创建空名字记录。
				this.showWarning("Usage: /name <name>");
			}
			// 请求更新画面。
			this.ui.requestRender();
			// 查看路径到此结束。
			return;
		}

		// Session追加session_info并通知观察者/扩展；可能写磁盘，扩展异步通知以void启动不等待。
		this.session.setSessionName(name);
		// 重新读取管理器接受后的最终名，以便发现规范化差异。
		const sessionName = this.sessionManager.getSessionName();
		// 严格比较最终名与用户trim后输入，不仅比较是否为空。
		if (sessionName !== name) {
			// 有变化时JSON.stringify保留引号/转义以说明差异；这不是脱敏或终端控制字符通用清理。
			this.showWarning(`Session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(sessionName)}`);
		}
		// 成功结果前加分隔空行。
		this.chatContainer.addChild(new Spacer(1));
		// 只有null/undefined才回退输入名，显式空串保留；通常管理器已有规范后的值。
		const displayName = sessionName ?? name;
		// 延迟取主题颜色，但displayName是本次捕获快照。
		this.chatContainer.addChild(new ThemedText(() => theme.fg("dim", `Session name set: ${displayName}`), 1, 0));
		// 请求显示新名字说明。
		this.ui.requestRender();
	}

	// 展示会话累计统计，返回void；同步捕获消息/用量/缓存估算与当前模型，构造按主题懒渲染的文字，不请求模型或供应商账单。
	// 例如旧分支和压缩前的费用仍在getEntries总账里；Input展示普通输入+缓存读+缓存写，缓存重计费为本地估算，不能直接当当前上下文窗口占用或真实账单。
	private handleSessionCommand(): void {
		// 扫描所有历史条目得到累计统计，包含其他分支、摘要和独立usage；不是只统计当前有效消息。
		const stats = this.session.getSessionStats();
		// 捕获本次显示名，后续renderInfo不重读新名字。
		const sessionName = this.sessionManager.getSessionName();
		// 取得全部会话条目用于缓存与费用分析，不限定当前分支。
		const entries = this.sessionManager.getEntries();
		// 按已有用量、前后提示体积和目录价格估算缓存miss损失，不查询远端真实缓存或发票。
		const cacheWaste = computeCacheWaste(entries, this.session.modelRuntime);

		// Cost/token totals per provider/model actually used (e.g. OpenRouter `auto`
		// resolves to a concrete responseModel). Usage without model attribution is
		// grouped separately so the breakdown reconciles with the session total.
		// 按实际responseModel/模型归属分费用，工具和摘要无模型归属用量归Tools/summaries桶，返回按费用降序的非零组。
		const usageBreakdown = getUsageCostBreakdown(entries);

		// Snapshot the stats; the text is built on demand so it follows theme changes.
		// 捕获此刻预热状态对象，后续文字随主题变但不持续重取最新状态。
		const cacheWarmingStatus = this.session.cacheWarmingStatus;
		// 捕获预热模式设置，不由本命令启动/停止预热。
		const cacheWarmingMode = this.settingsManager.getCacheWarmingMode();
		// 捕获当前模型元数据，用于决定费用分项是否与当前模型重复。
		const model = this.session.model;
		// 可选访问再模板拼接；无模型时实际得到undefined/undefined字串，不是undefined值。
		const selectedModelKey = `${model?.provider}/${model?.id}`;
		// 本地渲染函数每次返回完整说明串；只重做样式/格式，不重扫统计，所以后续新消息不会自动加到这条快照。
		const renderInfo = (): string => {
			// 从粗体标题和两个换行开始累积info，let允许+=逐段追加。
			let info = `${theme.bold("Session Info")}\n\n`;
			// 有非空名字才加Name行。
			if (sessionName) {
				// 插入捕获名字，不在此规范化或隐藏内容。
				info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
			}
			// 有文件路径时显示路径，nullish回退In-memory；不检查路径此刻是否存在。
			info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
			// 显示会话ID并留空行，ID不同于显示名。
			info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
			// 消息统计区标题。
			info += `${theme.bold("Messages")}\n`;
			// 显示全部type=message条目计数，包括其各种角色，不等只user+assistant。
			info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n`;
			// 显示user计数，非自定义消息记录总数。
			info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
			// 显示assistant计数，失败/取消回复也可能已计入。
			info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
			// 工具调用块数和toolResult条目数分开显示，不保证两者相等或全部成功。
			info += `${theme.fg("dim", "Tools:")} ${stats.toolCalls} calls, ${stats.toolResults} results\n\n`;
			// token统计区标题，以下数值是累计量而非窗口实时占用。
			info += `${theme.bold("Tokens")}\n`;
			// "Input" is the full prompt volume. With cache activity, split it into
			// cached (served from cache) vs uncached (everything else) - the only
			// provider-independent split. Cache writes, where reported, are a detail
			// of the uncached portion.
			// 对象解构取三个输入侧桶，缓存子项不重复叠加到input。
			const { input, cacheRead, cacheWrite } = stats.tokens;
			// 总prompt体积按input+cacheRead+cacheWrite定义；不是直接取某条usage.totalTokens。
			const promptTokens = input + cacheRead + cacheWrite;
			// locale格式化输入体积数字，可能随运行环境数字格式不同。
			info += `${theme.fg("dim", "Input:")} ${promptTokens.toLocaleString()}\n`;
			// prompt为正且有缓存活动才显示拆分，避免除0和无意义明细。
			if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
				// 缓存命中率只取cacheRead/prompt，乘100保留1位小数，再给百分比着dim色。
				const hitRate = theme.fg("dim", `(${((cacheRead / promptTokens) * 100).toFixed(1)}%)`);
				// Cached行表示读取缓存的累计token，不包括缓存新写入。
				info += `  ${theme.fg("dim", "Cached:")} ${cacheRead.toLocaleString()} ${hitRate}\n`;
				// 决定是否给Uncached行加写缓存说明。
				const written =
					// 只有cacheWrite正才标注written to cache，否则不追加后缀。
					cacheWrite > 0 ? ` ${theme.fg("dim", `(${cacheWrite.toLocaleString()} written to cache)`)}` : "";
				// Uncached由input+cacheWrite组成，写缓存仍属于本次未从缓存读取的部分。
				info += `  ${theme.fg("dim", "Uncached:")} ${(input + cacheWrite).toLocaleString()}${written}\n`;
			}
			// 输出桶单独显示，已包含在output的reasoning不再重复加。
			info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
			// 总token采用stats汇总的四主桶之和，不是费用或当前上下文大小。
			info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

			// 插入预热状态区标题。
			info += `\n${theme.bold("Cache Warming")}\n`;
			// 显示调用命令时捕获的预热模式。
			info += `${theme.fg("dim", "Mode:")} ${cacheWarmingMode}\n`;
			// 有状态则格式化，缺状态显示不可用；此文字不主动补一次预热或认证请求。
			info += `${theme.fg("dim", "Status:")} ${cacheWarmingStatus ? formatCacheWarmingStatus(cacheWarmingStatus) : "Inactive (cache warming unavailable)"}\n`;
			// 可选取得状态里的经济决策说明，没状态时undefined。
			const decision = cacheWarmingStatus?.decision;
			// 仅经济估算可用时显示预热/未命中成本预测。
			if (decision?.economicsAvailable) {
				// missCost保留3位小数，属于决策估算，不是实际这一条已收费金额。
				info += `${theme.fg("dim", "Cache miss penalty:")} $${decision.missCost.toFixed(3)}\n`;
				// warmCost同样是估算刷新成本，显示不发起刷新。
				info += `${theme.fg("dim", "Refresh cost:")} $${decision.warmCost.toFixed(3)}\n`;
			}

			// 已记录费用为正或有估算未命中token才展示Cost区，只有零费用/零miss时省略。
			if (stats.cost > 0 || cacheWaste.missedTokens > 0) {
				// 费用区标题前空一行。
				info += `\n${theme.bold("Cost")}\n`;
				// 累计cost.total显示3位小数，可能来自供应商报告或上游按价格计算，不在这里再推单价。
				info += `${theme.fg("dim", "Total:")} $${stats.cost.toFixed(3)}`;
				// A single entry repeats the total, unless it names a model other than the selected one.
				// 只有一组且键等于当前选中模型时省略重复分项；空数组的?.key为undefined，也会进分支但循环零次。
				if (usageBreakdown.length > 1 || usageBreakdown[0]?.key !== selectedModelKey) {
					// 遍历已按费用排序的分组，不在此再次扫描历史。
					for (const entry of usageBreakdown) {
						// 每组显示键、费用和四主桶token合计；formatTokens是紧凑显示，不重新分词。
						info += `\n  ${theme.fg("dim", `${entry.key}:`)} $${entry.cost.toFixed(3)} ${theme.fg("dim", `(${formatTokens(entry.tokens)} tokens)`)}`;
					}
				}
				// 有估算miss token才显示Cache Re-billed详情，不保证供应商实际按该估算重计费。
				if (cacheWaste.missedTokens > 0) {
					// 按次数是否严格等于1选择英文单复数。
					const missLabel = cacheWaste.missCount === 1 ? "1 miss" : `${cacheWaste.missCount} misses`;
					// 将估算token数和miss次数拼成共享详情文字。
					const detail = `${cacheWaste.missedTokens.toLocaleString()} tokens, ${missLabel}`;
					// 继续给info追加缓存重计费展示，分支只控制是否显示美元。
					// 达到阈值以3位小数显示估算美元，可能因四舍五入看成0.000，不是实际账单核对。
					// 低于阈值只显示估算未命中规模。
					info +=
						// 估算费用至少0.0001才显示金额，较小值仅列token/次数。
						cacheWaste.missedCost >= 0.0001
							? `\n${theme.fg("dim", "Cache Re-billed:")} $${cacheWaste.missedCost.toFixed(3)} ${theme.fg("dim", `(${detail})`)}`
							: `\n${theme.fg("dim", "Cache Re-billed:")} ${detail}`;
				}
			}
			// 交回完整说明字符串，不直接输出终端或保存统计记录。
			return info;
		};

		// 说明块前加空行。
		this.chatContainer.addChild(new Spacer(1));
		// ThemedText按需要调用renderInfo更新颜色，但数据仍是本次捕获快照。
		this.chatContainer.addChild(new ThemedText(renderInfo, 1, 0));
		// 请求绘制统计块。
		this.ui.requestRender();
	}

	// 读取并展示程序更新日志，返回void；解析本地文件、倒序拼全部版本Markdown、规范链接并加聊天区边框，不检查远端更新或安装版本。
	// 例如本地有多个版本条目时reverse改变本次新解析数组顺序；没有条目显示固定说明。文件解析/渲染异常不在此统一捕获。
	private handleChangelogCommand(): void {
		// 通过helper取得包内更新日志路径，不依赖cwd手工拼相对目录。
		const changelogPath = getChangelogPath();
		// 读取解析本地更新日志，所得数组归本次调用使用。
		const allEntries = parseChangelog(changelogPath);

		// 决定展示全部日志Markdown还是空状态文字。
		// 从解析出的数组开始链式处理，不直接修改磁盘日志。
		// 没有条目采用固定空说明。
		const changelogMarkdown =
			// 数组有条目才继续组合。
			allEntries.length > 0
				? allEntries
						// reverse原地反转本次数组，不是对上游共享全局数组排序。
						.reverse()
						// 逐条用该条版本元信息规范其内容链接。
						.map((e) => normalizeChangelogLinks(e.content, e))
						// 版本块间用两个换行分隔。
						.join("\n\n")
				: "No changelog entries found.";

		// 聊天区留分隔空行。
		this.chatContainer.addChild(new Spacer(1));
		// 加入顶边框。
		this.chatContainer.addChild(new DynamicBorder());
		// 按当前主题动态显示What's New标题。
		this.chatContainer.addChild(new ThemedText(() => theme.bold(theme.fg("accent", "What's New")), 1, 0));
		// 标题后空一行。
		this.chatContainer.addChild(new Spacer(1));
		// Markdown组件展示拼成的日志，左右/上下内边距均1，主题辅助还带当前代码块缩进设置。
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.getMarkdownThemeWithSettings()));
		// 加底边框结束日志块。
		this.chatContainer.addChild(new DynamicBorder());
		// 请求渲染，不自动滚动到外部浏览器。
		this.ui.requestRender();
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	// 按应用动作取当前键位的大写首字母展示串，返回string，无注册或按键匹配副作用。
	// 例如app.model.select显示当前有效配置，不固定写死某一快捷键；AppKeybinding在编译期限制动作名。
	private getAppKeyDisplay(action: AppKeybinding): string {
		// 委托keyDisplayText，它读取共享键位并按平台调整Alt/Option等显示，多绑定用/连接。
		return keyDisplayText(action);
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	// 按编辑器动作取展示键名，返回string，和应用动作辅助共用格式器；例如tui.input.submit显示当前发送动作绑定。
	private getEditorKeyDisplay(action: Keybinding): string {
		// 直接返回格式化字符串，不因此提交编辑器内容或重写键位。
		return keyDisplayText(action);
	}

	// 展示当前快捷键说明，返回void；先读取编辑/应用动作对应键名，再拼固定Markdown表，最后追加扩展当前有效短键，不执行任何所列动作。
	// 例如用户改发送键后此表采用新键名；英文Action列仍为固定说明，不是运行时逐项能力检测。多行模板里的反引号/插值都是实际展示内容，不能把中文注释插到模板内部。
	private handleHotkeysCommand(): void {
		// Navigation keybindings
		// 读取向上移动光标/浏览历史动作的有效展示键名。
		const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
		// 读取向下动作键名。
		const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
		// 读取光标左移动作键名。
		const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
		// 读取光标右移动作键名。
		const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
		// 读取向左按词移动动作键名。
		const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
		// 读取向右按词移动动作键名。
		const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
		// 读取行首动作键名。
		const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
		// 读取行尾动作键名。
		const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
		// 读取向前跳到字符动作键名，仅展示不询问字符。
		const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
		// 读取向后跳到字符动作键名。
		const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
		// 读取向上翻页键名。
		const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
		// 读取向下翻页键名。
		const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");

		// Editing keybindings
		// 读取提交输入动作，不立即发送消息。
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		// 读取插入新行键名，Windows额外说明在模板中按平台决定。
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		// 读取向后删词键名。
		const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
		// 读取向前删词键名。
		const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
		// 读取删除到行首键名。
		const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
		// 读取删除到行尾键名。
		const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
		// 读取yank（取回最近删除文字）动作键名，不读取系统剪贴板。
		const yank = this.getEditorKeyDisplay("tui.editor.yank");
		// 读取yankPop（轮换删除文字）动作键名。
		const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
		// 读取撤销动作键名。
		const undo = this.getEditorKeyDisplay("tui.editor.undo");
		// 读取补全/接受候选动作键名。
		const tab = this.getEditorKeyDisplay("tui.input.tab");

		// App keybindings
		// 读取应用中断动作键名，表内仅描述可能用途，不在此abort。
		const interrupt = this.getAppKeyDisplay("app.interrupt");
		// 读取清编辑器/双击退出动作键名。
		const clear = this.getAppKeyDisplay("app.clear");
		// 读取空编辑器退出动作键名。
		const exit = this.getAppKeyDisplay("app.exit");
		// 读取挂起动作键名；平台能否实际挂起由处理器决定，不由此查询判断。
		const suspend = this.getAppKeyDisplay("app.suspend");
		// 读取循环思考档位动作键名。
		const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
		// 读取向前循环模型动作键名。
		const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
		// 读取打开模型选择器动作键名。
		const selectModel = this.getAppKeyDisplay("app.model.select");
		// 读取展开工具输出动作键名。
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		// 读取隐藏/展示思考块动作键名，不等调模型思考强度。
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		// 读取外部编辑器动作键名，不实际启动进程。
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		// 读取向后循环模型动作键名。
		const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
		// 读取复制消息/选区动作键名，不触碰剪贴板。
		const copyMessage = this.getAppKeyDisplay("app.message.copy");
		// 读取排队follow-up动作键名。
		const followUp = this.getAppKeyDisplay("app.message.followUp");
		// 读取恢复队列到编辑器动作键名。
		const dequeue = this.getAppKeyDisplay("app.message.dequeue");
		// 读取粘贴文件/图片/文字动作键名，不主动读取剪贴板。
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");

		// 整个多行模板构成实际Markdown：Navigation逐行插入上面光标/跳转/翻页键，Editing插入提交/换行/删除/yank/撤销键，Other列应用动作和/、!、!!入口。
		// 模板内${...}在此求值，\`是把反引号作为Markdown行内代码输出；win32时给New line行加固定Windows Terminal说明。换行与表格字符都属于运行时文案，不添加注释到其中。
		// let让后面还能追加扩展表；这些Action说明不代表当前模型支持所有思考档位、主屏支持选区或所有平台支持挂起。
		let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${copyMessage}\` | Copy selection or last assistant message |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste files on macOS, images, or text from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

		// Add extension-registered shortcuts
		// 取当前扩展runner，后面查已解析的短键而非重新加载扩展。
		const extensionRunner = this.session.extensionRunner;
		// 按有效键位让runner解决扩展短键冲突并产生映射；该查询也会更新runner诊断，不是纯读一个静态常量表。
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		// 有有效短键才添加Extensions表。
		if (shortcuts.size > 0) {
			// 追加独立Markdown标题和表头；下方多行仍是原运行时模板内容，中文说明放在模板外。
			hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
			// 解构Map每个[key,shortcut]，按映射迭代顺序写表，不另按键名排序。
			for (const [key, shortcut] of shortcuts) {
				// 优先description，缺null/undefined才用extensionPath；显式空描述仍保留。
				const description = shortcut.description ?? shortcut.extensionPath;
				// 直接格式化此短键字符串并首字母大写，平台Alt/Option名称随formatter调整。
				const keyDisplay = formatKeyText(key, { capitalize: true });
				// 追加一行Markdown，不对描述的竖线/换行做专门转义；展示文字不在此注册或执行handler。
				hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
			}
		}

		// 快捷键块前留一行空白。
		this.chatContainer.addChild(new Spacer(1));
		// 加入顶边框。
		this.chatContainer.addChild(new DynamicBorder());
		// 按当前主题动态生成Keyboard Shortcuts标题。
		this.chatContainer.addChild(new ThemedText(() => theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
		// 标题后留空行。
		this.chatContainer.addChild(new Spacer(1));
		// trim仅去整段首尾空白，Markdown按设置主题/代码缩进展示，不修改真实按键配置。
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		// 加入底边框。
		this.chatContainer.addChild(new DynamicBorder());
		// 请求显示整块帮助。
		this.ui.requestRender();
	}

	// 新建并切换会话的/clear适配，返回Promise<void>；清状态→Runtime.newSession→若未取消显示成功，失败走致命处理。
	// 例如清会话不等删除旧JSONL历史，Runtime会通知扩展/拆旧/建新并重绑；取消不显示成功，已有副作用没有全回滚保证。
	private async handleClearCommand(): Promise<void> {
		// 清当前状态指示器，位于try外。
		this.clearStatusIndicator();
		// 捕获Runtime新建和后续提示失败。
		try {
			// 等待新会话完整运行时替换，具体历史/持久化策略由Runtime与管理器处理。
			const result = await this.runtimeHost.newSession();
			// 扩展等取消时保留当前结果，不显示新会话成功。
			if (result.cancelled) {
				// 结束取消路径。
				return;
			}
			// 成功提示前留空行。
			this.chatContainer.addChild(new Spacer(1));
			// 显示原有成功文字，左右/上下内边距各1；显示不代表已经发送首个模型问题。
			this.chatContainer.addChild(new ThemedText(() => theme.fg("accent", "✓ New session started"), 1, 1));
			// 请求重绘新会话UI。
			this.ui.requestRender();
			// unknown兼容非Error异常。
		} catch (error: unknown) {
			// 交致命处理停止界面并退出正常路径，避免继续使用可能半替换的运行时。
			await this.handleFatalRuntimeError("Failed to create session", error);
		}
	}

	// 把当前渲染行和有效Agent消息写本地debug日志，返回void；渲染→收集宽度/JSONL→创建父目录→覆盖文件→显示路径。
	// 例如换行/ANSI被JSON.stringify转成可见转义便于排查，但消息文本、工具数据等未统一脱敏；这是调试副本，不是崩溃报告脱敏流程，没有此方法内try兜底。
	private handleDebugCommand(): void {
		// 取当时终端列数供render计算布局。
		const width = this.ui.terminal.columns;
		// 取终端行数，只写调试元信息，不截断allLines到此高度。
		const height = this.ui.terminal.rows;
		// 实际调用当前UI.render，可能触发组件懒渲染/其内部更新，不读取终端屏幕回传。
		const allLines = this.ui.render(width);

		// 通过config helper取得调试文件位置，不手工依赖安装布局。
		const debugLogPath = getDebugLogPath();
		// 用数组组合日志段落，末尾join换行，不是构建JSON数组文件。
		const debugData = [
			// 当前墙钟ISO时间作为调试输出时间。
			`Debug output at ${new Date().toISOString()}`,
			// 记录当时宽x高。
			`Terminal: ${width}x${height}`,
			// 记录render返回的全部逻辑行数，可能大于屏幕行数。
			`Total lines: ${allLines.length}`,
			// 空字符串在join后成为分隔空行。
			"",
			// 渲染行段固定标题。
			"=== All rendered lines with visible widths ===",
			// map逐行产调试串，再用展开语法逐项加入外层数组。
			...allLines.map((line, idx) => {
				// 计算终端可见列宽，区别JS.length的UTF-16码元数。
				const vw = visibleWidth(line);
				// JSON.stringify显示行中的引号/控制字符转义，不清秘密或解释ANSI业务含义。
				const escaped = JSON.stringify(line);
				// 记录0起始下标、显示宽度及转义行文字。
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			// 两个日志部分间留空行。
			"",
			// 标明后段为Agent消息JSONL，不是完整SessionManager全部记录树。
			"=== Agent messages (JSONL) ===",
			// 当前有效消息逐条JSON.stringify，不包含所有分支元数据但仍可含敏感对话/工具数据；无通用脱敏。
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			// 末尾空串保证join结果以换行结束。
			"",
			// 各段用LF连接成一个文件内容字符串。
		].join("\n");

		// 递归创建父目录，已有目录可复用，权限等错误直接向上传播。
		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		// 同步覆盖调试文件，未指定append；没有原子替换/回滚保证。
		fs.writeFileSync(debugLogPath, debugData);

		// 成功反馈前加空行。
		this.chatContainer.addChild(new Spacer(1));
		// 添加带动态主题的两行反馈文本。
		this.chatContainer.addChild(
			// 渲染时用当前颜色，路径为此调用的捕获值；未在这里打开文件或上传它。
			new ThemedText(() => `${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		// 请求显示写入成功路径。
		this.ui.requestRender();
	}

	// 响应Armin彩蛋，返回void；先让惰性3D入口尝试接手，未接手则在聊天区挂内联组件。
	// 例如普通主屏返回false走内联；备用屏有可见浮层可返回true但本次不播放，因此true不等动画成功结束。内联组件有自己的动画计时生命周期。
	private handleArminSaysHi(): void {
		// 调用同步接手判定，true就返回；加载3D和播放在之后异步进行，不await完成。
		if (playArmin3d(this.renderer)) return;
		// 内联回退前留空行。
		this.chatContainer.addChild(new Spacer(1));
		// 创建Armin组件接入聊天，UI只负责显示，不请求模型。
		this.chatContainer.addChild(new ArminComponent(this.ui));
		// 请求绘制内联动画初始画面。
		this.ui.requestRender();
	}

	// 把内置公告组件加入聊天，返回void；例如隐藏命令展示固定公告，不执行shell/模型或发布消息到外部。
	private handleDementedDelves(): void {
		// 公告前加分隔空行。
		this.chatContainer.addChild(new Spacer(1));
		// 创建本地公告展示组件，不在此获取远端公告内容。
		this.chatContainer.addChild(new EarendilAnnouncementComponent());
		// 请求渲染。
		this.ui.requestRender();
	}

	// 处理用户!/!!命令，输入命令正文和可选上下文排除标志，返回Promise<void>；先咨询user_bash钩子，再展示扩展现成结果或调用Session执行器，流式更新组件。
	// 例如扩展返回{result}就只展示/记录，不再次本地执行；返回{operations}由统一执行器用自定义后端；钩子失败立即结束，绝不因接管失败又退回本地执行。
	// 执行结果和UI暂存是两层：Agent流式回复时组件先放pending区，Session也可暂存Bash消息；excludeFromContext只排除送模型内容，历史仍可保存。单个this.bashComponent槽并非按命令ID隔离，不能据此保证任意并发调用独立显示。
	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		// 捕获当前扩展runner用于本次钩子，不在这里重新加载扩展。
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		// 可选联合结果只允许operations或完整result；TypeScript限制配合runner对扩展返回边界的实际校验。
		let eventResult: UserBashEventResult | undefined;
		// 捕获钩子拒绝，避免错误接管后意外执行本地命令。
		try {
			// 等待按扩展注册顺序询问user_bash；首个合法接管结果生效，扩展期间可能已经自行执行外部动作。
			eventResult = await extensionRunner.emitUserBash({
				// 固定事件类型让runner定位用户Bash处理器。
				type: "user_bash",
				// 传用户命令正文，不在此拼shell设置前缀。
				command,
				// 告知是否排除模型上下文，扩展仍可观察命令并产生自己的副作用。
				excludeFromContext,
				// 取事件构造时当前SessionManager.cwd，不使用进程全局cwd代替。
				cwd: this.sessionManager.getCwd(),
			});
			// runner已向错误观察者报告并重抛；此层吞掉异常，只终止本次命令分派。
		} catch {
			// The extension runner already reported the error. Do not fall back to local execution.
			// 不创建执行器/结果组件，不回退本地；不能说扩展此前的外部动作也被撤销。
			return;
		}

		// If extension returned a full result, use it directly
		// 有完整result就走替换结果路径，跳过普通执行；这里判断不是exitCode成功与否。
		if (eventResult?.result) {
			// 保留扩展返回结果对象引用，字段由runner最小校验及BashResult契约约束，不检查命令业务真实性。
			const result = eventResult.result;

			// Create UI component for display
			// 创建展示组件并写全局当前Bash槽；构造启动显示状态，不是执行shell。
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext, this.outputPad);
			// 按此刻Agent运行状态决定组件位置；不是判断手动Bash后端自身是否运行。
			if (this.session.isStreaming) {
				// 回复进行中先加pending显示区，避免插进助手/工具对话中间。
				this.pendingMessagesContainer.addChild(this.bashComponent);
				// 另记组件引用，之后flushPendingBashComponents把它移到chat。
				this.pendingBashComponents.push(this.bashComponent);
				// Agent空闲就直接显示在聊天区。
			} else {
				// 接入聊天布局，不自行追加持久化记录。
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			// 只有非空output才追加显示，空串不额外调用appendOutput。
			if (result.output) {
				// 把扩展现成输出交展示组件，不执行输出中的命令。
				this.bashComponent.appendOutput(result.output);
			}
			// 把展示标成完成；非零退出码仍是完成结果，不自动转Promise异常。
			this.bashComponent.setComplete(
				// 透传可缺省的exitCode。
				result.exitCode,
				// 透传扩展记录的取消布尔。
				result.cancelled,
				// 截断时仅组最小{truncated,content}对象并断言TruncationResult；as不补齐完整类型其他字段，不重跑截断。
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				// 传可选完整输出文件路径用于显示提示，不在此读取或保证文件永久存在。
				result.fullOutputPath,
			);

			// Record the result in session
			// Session将已完成结果包装为bashExecution并保存或暂存；此调用本身不再执行命令，排除标志不等删除历史。
			this.session.recordBashResult(command, result, { excludeFromContext });
			// 清当前活跃显示槽，已挂载组件仍留chat/pending列表。
			this.bashComponent = undefined;
			// 请求绘制完成输出。
			this.ui.requestRender();
			// 到此结束，绝不继续普通执行路径；此完整结果分支没有外层try包住所有渲染/记录错误。
			return;
		}

		// Normal execution path (possibly with custom operations)
		// 快照此刻是否流式回复，后续只用于首次组件摆放，不持续跟随会话状态。
		const isDeferred = this.session.isStreaming;
		// 新建Bash显示组件并占当前槽，真正执行稍后才开始。
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext, this.outputPad);

		// 按捕获的isDeferred选择pending或chat区域。
		if (isDeferred) {
			// Show in pending area when agent is streaming
			// 运行中先显示在pending区。
			this.pendingMessagesContainer.addChild(this.bashComponent);
			// 记住待移动的组件引用。
			this.pendingBashComponents.push(this.bashComponent);
			// 非流式状态直接进聊天。
		} else {
			// Show in chat immediately when agent is idle
			// 加入当前聊天布局，不等执行已开始或成功。
			this.chatContainer.addChild(this.bashComponent);
		}
		// 请求显示进行中状态；这一构造/挂载过程在下面try外。
		this.ui.requestRender();

		// 从实际Session执行开始捕获异常，下面catch还处理展示完成失败。
		try {
			// 等待统一Bash执行器，它拼shell配置前缀、使用本地或自定义后端、流式回调并记录结果。
			const result = await this.session.executeBash(
				// 传原始命令，Session保存时也记录原正文而非加前缀后的整段。
				command,
				// 输出块回调同步执行，chunk为增量文字，不是目前累计全量输出。
				(chunk) => {
					// 只要全局当前Bash槽还存在就更新它；未核对与本次原组件身份是否相同。
					if (this.bashComponent) {
						// 把chunk追加到当前槽组件，组件处理输出/显示截断。
						this.bashComponent.appendOutput(chunk);
						// 请求重绘流式Bash输出，不await终端绘完。
						this.ui.requestRender();
					}
				},
				// 传排除标志与可选扩展operations；undefined让Session选择本地后端，不另调用钩子。
				{ excludeFromContext, operations: eventResult?.operations },
			);

			// 执行结束若当前槽还在，才写完成状态；Session此时已完成结果记录步骤。
			if (this.bashComponent) {
				// 更新可视状态，不重复调用recordBashResult。
				this.bashComponent.setComplete(
					// 显示执行器exitCode，可能undefined。
					result.exitCode,
					// 显示执行器取消标志，取消不等输出为空。
					result.cancelled,
					// 同样只创建最小截断描述并作TS断言，不补完整TruncationResult字段。
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					// 显示可选完整输出文件提示，不在这里打开文件。
					result.fullOutputPath,
				);
			}
			// 执行/记录或try内完成展示失败进入此处，部分命令副作用不可回滚。
		} catch (error) {
			// 当前槽还存在时先停止其进行中显示。
			if (this.bashComponent) {
				// 用undefined退出码和false取消完成组件；这是错误收尾参数，不代表命令真实正常退出或从未被取消。
				this.bashComponent.setComplete(undefined, false);
			}
			// 显示固定失败前缀，Error取message，其他抛出值用Unknown error。
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		// 清当前显示槽；不在finally中，所以catch内展示再抛错时这一步可能不执行。
		this.bashComponent = undefined;
		// 请求绘制收尾，已挂载的历史组件不因清槽而删除。
		this.ui.requestRender();
	}

	// 手动压缩命令适配，输入可选摘要要求，返回Promise<void>；清状态后等待Session.compact，依赖会话事件展示常规结果，捕获拒绝不再重复显示。
	// 例如/compact 保留最近决定让摘要补充某要求，Session会先abort当前运行并协调模型摘要/扩展；这里不自动续跑旧任务，也不保证所有前置失败都已发出结束事件。
	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		// 清当前指示器，位于try外，不等压缩已经开始。
		this.clearStatusIndicator();

		// 捕获会话手动压缩Promise拒绝，不返回CompactionResult给命令调用者。
		try {
			// 等待整个Session手动压缩，包括取消当前运行、准备、扩展或模型摘要、保存和事件协调。
			await this.session.compact(customInstructions);
			// 空catch避免与compaction_end常规错误提示重复；Session初始abort/start派发等在自身try外时，仍可能没有完整结束事件，原行为不改变。
		} catch {
			// Ignore, will be emitted as an event
		}
	}

	// 停止本交互界面的指定资源，输入可选全屏退出显示策略，返回void；清选择器/指示器/输入监听、关主题自动联动、释放页脚数据、退订事件，已初始化时停TUI，最后卸信号处理。
	// 例如resume-hint和transcript由stopInteractiveTui决定终端收尾，不等Runtime.dispose或取消所有模型/对话Promise。本方法无总finally，各步错误可打断后续清理，也没有共享完成Promise保证重复调用等待同次收尾。
	// 默认参数每次调用从设置读取，省略或传undefined才取默认；不是构造期固定的退出策略。
	stop(fullscreenExitOutput = this.settingsManager.getFullscreenExitOutput()): void {
		// 清普通选择器槽并调用其dispose；不等结算所有扩展对话Promise或移除全部浮层。
		this.disposeActiveSelector();
		// 只有当时终端进度设置为真才显式清终端进度；设为false不在此补发清除。
		if (this.settingsManager.getShowTerminalProgress()) {
			// 请求终端撤销进度显示，不是中止Agent任务。
			this.ui.terminal.setProgress(false);
		}
		// dispose当前状态指示器并移出状态区域，可能停止其loader动画。
		this.clearStatusIndicator();
		// 只禁用主题自动深浅联动，不调用ThemeController.dispose，也不在此解绑其颜色监听或全局主题文件watcher。
		this.themeController.disableAutoSync();
		// 清本实例登记的扩展终端输入监听，不是删除终端上其他所有用户监听器。
		this.clearExtensionTerminalInputListeners();
		// 调用默认页脚组件dispose；当前实现无操作，Git watcher由下面数据提供者负责。
		this.footer.dispose();
		// 标记页脚数据提供者disposed、清刷新计时/Git watcher和分支订阅，不等待已经启动的Git子进程退出。
		this.footerDataProvider.dispose();
		// 有会话事件退订函数才调用。
		if (this.unsubscribe) {
			// 从事件集合移除订阅，不在此清this.unsubscribe字段或撤销已进入执行的异步回调。
			this.unsubscribe();
		}
		// 只有已初始化TUI才执行终端停止逻辑，其他清理前面不依此门禁。
		if (this.isInitialized) {
			// 按全屏退出策略停止/保留画面等终端状态，具体是否输出transcript由辅助决定。
			this.stopInteractiveTui(fullscreenExitOutput);
			// 停止调用成功后才清初始化标志；前面抛错时不会自动设置false。
			this.isInitialized = false;
		}
		// 最后移除此实例安装的信号/流错误/uncaught处理器，不删除其他会话的监听器；前面任一步失败则可能尚未执行。
		this.unregisterSignalHandlers();
	}
}
