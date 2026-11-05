// pi-tui对外公共入口：调用方从包名导入组件、键盘解析、布局/终端类型及样式工具，具体实现留在下面各源文件。
// export {...} from是重导出，不复制实现也不包装函数；标type的名字仅在编译期存在，运行时值重导出会加载其模块，但不会因此调用start/render等方法。
// 例：import {Text,TuiMainScreen,ProcessTerminal,type Terminal} from "@earendil-works/pi-tui" 可组装UI；实例创建/启动/停止仍由调用者负责。
// Core TUI interfaces and classes

// Marked是第三方Markdown解析器类，可构造解析/词法实例；Token是单个token联合类型，Tokens是各token结构的类型命名空间，不是TUI渲染组件。
export { Marked, type Token, type Tokens } from "marked";
// Autocomplete support
// 重导出补全相关结构与实际提供者；大括号列出本包承诺的名字，不把模块所有内部函数都公开。
export {
	// AutocompleteItem描述value/label/可选说明，供菜单显示与选中后应用。
	type AutocompleteItem,
	// AutocompleteProvider约定异步取建议及同步应用补全，声明不自动发起查询或取消。
	type AutocompleteProvider,
	// AutocompleteSuggestions包含候选数组和正在匹配的prefix。
	type AutocompleteSuggestions,
	// CombinedAutocompleteProvider实际组合斜杠命令、路径等补全，构造/调用的具体行为见autocomplete.ts。
	CombinedAutocompleteProvider,
	// SlashCommand声明命令名、说明和可选参数补全函数，不在此执行命令。
	type SlashCommand,
	// 以上名字都来自autocomplete模块，type标记部分去掉类型后不产生运行时导出。
} from "./autocomplete.ts";
// Colors and styling
// 颜色与文本样式的公共出口；这些函数生成颜色数据/控制字符串，不直接向终端写入。
export {
	// backgroundAnsi把具体颜色按指定输出模式编码为背景SGR字符串。
	backgroundAnsi,
	// Color是indexed/rgb/oklch三种带标签颜色对象的联合类型，不是任意CSS字符串。
	type Color,
	// ColorMixSpace约束混色使用oklch或编码sRGB通道。
	type ColorMixSpace,
	// colorToHex把颜色转换为RGB十六进制字符串。
	colorToHex,
	// colorToOkhsl得到便于选色的OKHSL通道。
	colorToOkhsl,
	// colorToOklch得到亮度/色度/色相通道。
	colorToOklch,
	// colorToRgb转换为0..255标度的RGB通道对象。
	colorToRgb,
	// foregroundAnsi生成前景颜色SGR，需要调用者提供终端颜色模式。
	foregroundAnsi,
	// IndexedColor是包含kind/index的调色板颜色形状，类型本身不验证0..255。
	type IndexedColor,
	// indexedColor是实际构造/校验索引颜色的函数，与只用于类型的IndexedColor不同。
	indexedColor,
	// mixColors按比例和空间混两种颜色，默认OKLCH；不是直接操作终端调色板。
	mixColors,
	// OkhslChannels是h/s/l数值通道结果，与带kind的具体颜色对象分开。
	type OkhslChannels,
	// OklchChannels是l/c/h通道结果，无kind标签。
	type OklchChannels,
	// OklchColorValue是带oklch标签的具体颜色接口。
	type OklchColorValue,
	// okhslColor按OKHSL输入转换成可用的RGB颜色对象，并非返回第四种Color联合成员。
	okhslColor,
	// oklchColor构造具体OKLCH颜色，数值规则见colors.ts。
	oklchColor,
	// parseColor解析支持的字符串或数字颜色写法，失败可抛错，不是浏览器全部CSS颜色解析器。
	parseColor,
	// RgbColorValue是带rgb标签的颜色值类型，无透明度字段。
	type RgbColorValue,
	// rgbColor实际构造RGB对象，校验通道数值范围。
	rgbColor,
	// styleText按TextStyle和模式给正文加前/背景与属性控制码，返回字符串。
	styleText,
	// styleTextWithAnsi复用预计算前/背景控制码，仅另读取文本属性；关闭时恢复默认，不自动恢复任意外层样式。
	styleTextWithAnsi,
	// TerminalColorMode区分256color/truecolor的输出编码，不是探测函数。
	type TerminalColorMode,
	// TextAttributes声明粗体、弱化、斜体、下划线、反色、删除线等可选开关。
	type TextAttributes,
	// TextStyle在属性开关上增加可选fg/bg颜色。
	type TextStyle,
	// 所有颜色实现来自colors.ts，数学转换还会调用oklab.ts，不在本入口复制公式。
} from "./colors.ts";
// Components
// Box是带内边距/可选背景的纵向容器，孩子仍由上层render，不因导入就占用终端。
export { Box } from "./components/box.ts";
// CancellableLoader在Loader上增加取消输入/回调接口，是否取消真正业务由宿主处理。
export { CancellableLoader } from "./components/cancellable-loader.ts";
// Editor是多行编辑组件；EditorOptions配置边距/菜单，EditorTheme提供边框及选择列表主题；后两者仅是类型。
export { Editor, type EditorOptions, type EditorTheme } from "./components/editor.ts";
// HStack横向排孩子，主轴尺寸/增长收缩规则由Stack和布局器处理。
export { HStack } from "./components/h-stack.ts";
// 图片组件及其可选同步转码入口，底层协议生成在terminal-image.ts。
export {
	// Image实现Component，render按终端能力生成图片行或回退文字，不等于此处已发送图片。
	Image,
	// ImageOptions描述图片组件宽度上限和可选文件名等配置。
	type ImageOptions,
	// ImageTheme提供文字回退的样式函数。
	type ImageTheme,
	// ImageTranscoder约定“base64原图+MIME→PNG base64或null”的同步回调类型，不是异步网络服务。
	type ImageTranscoder,
	// setImageTranscoder设置共享转码函数并清转换缓存；注册不立即转每张图片，已有实例的成功缓存另有生命周期。
	setImageTranscoder,
	// 这些名字都来自image组件；接口本身不解码或检查图片内容。
} from "./components/image.ts";
// Input为单行输入组件，保存值/光标、解析编辑键并返回一行绘制字符串。
export { Input } from "./components/input.ts";
// Loader是带定时切帧的Text派生组件，构造会启动；LoaderIndicatorOptions配置帧与间隔，调用者需stop结束动画。
export { Loader, type LoaderIndicatorOptions } from "./components/loader.ts";
// Markdown把Markdown渲染为终端行；DefaultTextStyle控制基础属性，MarkdownOptions控制处理选项，MarkdownTheme提供各语法主题回调。
export { type DefaultTextStyle, Markdown, type MarkdownOptions, type MarkdownTheme } from "./components/markdown.ts";
// MouseRegion给子组件包鼠标回调区域；MouseRegionHandler是其回调类型，包装本身不启用真实终端鼠标模式。
export { MouseRegion, type MouseRegionHandler } from "./components/mouse-region.ts";
// 纵向滚动组件的公开类和配置类型，实际视口裁剪需布局器配合。
export {
	// ScrollView保留滚动偏移、跟随与条状态，普通render仍可返回完整正文。
	ScrollView,
	// ScrollViewOptions配置follow/primary/越界/滚动条等，类型不自动拦截事件。
	type ScrollViewOptions,
	// ScrollViewScrollbar约束hidden/auto/always三种显示策略。
	type ScrollViewScrollbar,
	// ScrollViewScrollToOptions控制一次绝对滚动调用是否暂压末尾跟随。
	type ScrollViewScrollToOptions,
	// 滚动具体行为见scroll-view.ts与layout.ts，此处只提供包级入口。
} from "./components/scroll-view.ts";
// 选择菜单相关接口与组件出口，菜单只更新状态/通知回调，不自动执行候选业务。
export {
	// SelectItem是候选value、label与可选description结构。
	type SelectItem,
	// SelectList提供过滤、键盘/鼠标选择和列表渲染。
	SelectList,
	// SelectListLayoutOptions控制主列宽度边界及可选自定义截断。
	type SelectListLayoutOptions,
	// SelectListTheme提供各文字样式函数；字段被声明不等于每个渲染路径都调用它。
	type SelectListTheme,
	// SelectListTruncatePrimaryContext传给主列截断函数，含文本、宽度、候选与选中状态。
	type SelectListTruncatePrimaryContext,
	// 这组名字来自选择列表实现，不重新定义一份候选数据。
} from "./components/select-list.ts";
// SettingItem定义设置项及可选循环值/子菜单；SettingsList提供界面交互，SettingsListTheme定义样式，不自动保存到配置文件。
export { type SettingItem, SettingsList, type SettingsListTheme } from "./components/settings-list.ts";
// Spacer生成指定高度的空行，用于纵向留白。
export { Spacer } from "./components/spacer.ts";
// Text按列宽折行文字、加内边距并缓存行结果，文本中的样式代码会保留。
export { Text } from "./components/text.ts";
// TruncatedText用于单行按宽度截断显示，不是完整多行段落编辑器。
export { TruncatedText } from "./components/truncated-text.ts";
// 竖排堆叠组件复用Stack的尺寸类型，使包外无需依赖内部stack.ts路径。
export {
	// StackChild允许直接Component或带component/尺寸配置的条目。
	type StackChild,
	// StackEntry把组件引用与单孩子尺寸选项组合起来。
	type StackEntry,
	// StackEntryOptions描述basis/grow/shrink/minSize/maxSize/可见条件等。
	type StackEntryOptions,
	// StackOptions是整组gap和交叉轴对齐配置。
	type StackOptions,
	// VStack提供竖排实现，布局帧中可分配增长/收缩空间。
	VStack,
	// 条目类型由v-stack继续重导出自stack.ts，运行时代码仍是同一套实现。
} from "./components/v-stack.ts";
// Editor component interface (for custom editors)
// 只重导出自定义编辑器接口，去类型后不加载一个EditorComponent值；扩展工厂需自己实现getText/setText等方法。
export type { EditorComponent } from "./editor-component.ts";
// Fuzzy matching
// fuzzyMatch返回FuzzyMatch（matches/score），fuzzyFilter按查询筛选排序候选；分数越低越优，模糊子序列匹配不等于概率或模型检索。
export { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "./fuzzy.ts";
// Keybindings
// 快捷键配置/匹配管理入口；界面组件用动作名查询配置，不直接写死用户按键。
export {
	// getKeybindings读取当前共享管理器引用，不创建独立配置副本。
	getKeybindings,
	// getSelectPageIndex先按配置把输入匹配成翻页方向，再按当前项/页尺寸/总项数求目标下标，非翻页输入返回undefined。
	getSelectPageIndex,
	// Keybinding是可扩展动作名表的keyof类型。
	type Keybinding,
	// KeybindingConflict描述归一化按键被多个动作使用的报告，不会自动禁止冲突。
	type KeybindingConflict,
	// KeybindingDefinition定义一个动作的默认键和说明。
	type KeybindingDefinition,
	// KeybindingDefinitions是动作名到定义的映射类型。
	type KeybindingDefinitions,
	// Keybindings是动作名接口，可由声明合并增加业务动作，不是管理器实例。
	type Keybindings,
	// KeybindingsConfig是动作名到单键、多键或undefined覆盖值的配置形状。
	type KeybindingsConfig,
	// KeybindingsManager实际合并默认/自定义键、解析匹配并报告冲突。
	KeybindingsManager,
	// setKeybindings替换模块级管理器引用，之后组件读取到同一新配置，不在此执行任意动作。
	setKeybindings,
	// TUI_KEYBINDINGS是包内默认动作定义表，不是原始终端输入事件列表。
	TUI_KEYBINDINGS,
	// 这组类型与实现来自keybindings.ts，KeyId的协议解析另在keys.ts。
} from "./keybindings.ts";
// Keyboard input handling
// 原始键序列到可配置键标识的处理入口；这些函数解析字符串，不自行读取stdin。
export {
	// decodeKittyPrintable从受支持Kitty CSI-u序列中提取可打印文字，无法解码时undefined，不是全终端协议解析器。
	decodeKittyPrintable,
	// isKeyRelease检查输入是否为释放事件；协议与最近事件解析状态的细节见keys.ts。
	isKeyRelease,
	// isKeyRepeat判断重复按键事件，不等于判断两段输入字符串相同。
	isKeyRepeat,
	// isKittyProtocolActive只读模块布尔标记，不主动探测终端。
	isKittyProtocolActive,
	// Key是构造ctrl/shift等规范键标识的运行时辅助对象，不是TypeScript枚举。
	Key,
	// KeyEventType是press/repeat/release字面量联合。
	type KeyEventType,
	// KeyId描述允许的规范键名及修饰组合，编译期类型不替代真实输入解析。
	type KeyId,
	// matchesKey把原始输入与一个规范键标识匹配，内部可能更新最近解析事件类型，不应仅凭名称当成无状态比较。
	matchesKey,
	// parseKey将序列转换为键标识字符串或undefined，支持协议分支和限制见实现。
	parseKey,
	// setKittyProtocolActive只修改共享协议标志，真正启停控制码由ProcessTerminal发送。
	setKittyProtocolActive,
	// 这些运行时导出复用keys.ts的共享状态，不创建每个导入者独有的开关。
} from "./keys.ts";
// LaTeX rendering
// renderLatex把受支持的数学表达式转成Unicode终端文字，不支持/畸形时undefined；RenderLatexOptions的display控制纵向分数/上下限布局。
export { type RenderLatexOptions, renderLatex } from "./latex.ts";
// Native platform integration
// getNativeClipboard取可选原生接口，首次可能同步加载模块但不立即读剪贴板；NativeClipboard约定异步读文本/图片及部分平台可选写能力。
export { getNativeClipboard, type NativeClipboard } from "./native-platform.ts";
// oklabToOkhslLightness将Oklab亮度L映射为OKHSL亮度曲线，不是三通道颜色转换或终端探测。
export { oklabToOkhslLightness } from "./oklab.ts";
// Program status reporting (OSC 7501)
// formatProgramStatus生成OSC7501报告字符串；ProgramStatus描述state/app/kind/message，仅编码不发送、不自动协商支持性。
export { formatProgramStatus, type ProgramStatus } from "./program-status.ts";
// Input buffering for batch splitting
// StdinBuffer实际分批重组输入并发事件；StdinBufferEventMap描述事件参数，StdinBufferOptions配置ESC/序列超时，不会因导入自动监听stdin。
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "./stdin-buffer.ts";
// Terminal interface and implementations
// ProcessTerminal是真实stdin/stdout适配器，Terminal是可替换契约，isAppleTerminalSession依据平台/环境识别品牌；实例start才启用raw/粘贴/协商。
export { isAppleTerminalSession, ProcessTerminal, type Terminal } from "./terminal.ts";
// Terminal colors
// 终端颜色回复的数据形状与配色通知解析入口，查询发送/收集由TUI承担。
export {
	// parseTerminalColorSchemeReport解析CSI997的深浅配色通知，返回dark/light或undefined，不是解析完整RGB调色板。
	parseTerminalColorSchemeReport,
	// RgbColor是r/g/b三通道数据类型，不含具体颜色的kind判别标签。
	type RgbColor,
	// TerminalColorScheme约束dark/light两类，不能据此得到具体前景/背景RGB。
	type TerminalColorScheme,
	// TerminalColors描述可选默认前/背景及完整16项调色板的查询结果形状。
	type TerminalColors,
	// 上述类型/解析器来自terminal-colors.ts，本入口不自行发送OSC颜色查询。
} from "./terminal-colors.ts";
// Terminal image support
// 图片协议与终端能力的低层入口，大多返回字符串/数据；能力探测可能按环境执行tmux查询，需看detectCapabilities的参数与覆盖规则。
export {
	// allocateImageId随机产生合法Kitty ID，不承诺跨调用绝对唯一，也不在此注册图像。
	allocateImageId,
	// CellDimensions表示一个字符格的像素宽高，与原图像素大小不同。
	type CellDimensions,
	// calculateImageRows根据图片/格尺寸及列预算估算占多少终端行。
	calculateImageRows,
	// deleteAllKittyImages返回删除图像的Kitty控制字符串，调用者发送才作用于终端。
	deleteAllKittyImages,
	// deleteKittyImage按ID生成删除字符串，不立即删除内存/屏幕内容。
	deleteKittyImage,
	// detectCapabilities按环境/覆盖与可注入tmux检查得出能力对象，不是绘制测试，默认路径可能同步执行tmux查询。
	detectCapabilities,
	// encodeITerm2把base64图片及选项包装为iTerm2内联协议字符串，不发stdout。
	encodeITerm2,
	// encodeKitty把图片分块编码为本实现Kitty PNG传输代码，不在此验证整个PNG或保证终端支持。
	encodeKitty,
	// getCapabilities读取/冷启动探测共享能力对象，返回原引用。
	getCapabilities,
	// getCellDimensions读当前全局字符格像素尺寸，不向终端发查询，初始有估计值。
	getCellDimensions,
	// getGifDimensions读取GIF头部尺寸，失败null，不是解码全部帧。
	getGifDimensions,
	// getImageDimensions按MIME选择头部尺寸解析器，未知/无效结果为null，不负责转码。
	getImageDimensions,
	// getJpegDimensions扫描支持的JPEG帧标记取尺寸，不处理EXIF方向或全部图像验证。
	getJpegDimensions,
	// getPngDimensions读取PNG头部中的宽高，不能据此保证完整PNG/CRC合法。
	getPngDimensions,
	// getTerminalColorMode依据能力布尔值选择256color或truecolor编码模式。
	getTerminalColorMode,
	// getWebpDimensions读取支持的WebP头部分支，返回尺寸或null，不解压像素。
	getWebpDimensions,
	// hyperlink按能力决定是否用OSC8包文字，返回字符串，不打开URL。
	hyperlink,
	// ImageDimensions表示原图片的像素宽高。
	type ImageDimensions,
	// ImageProtocol是kitty/iterm2/null三种能力结果，null表示无支持的图片协议。
	type ImageProtocol,
	// ImageRenderOptions约定列/行预算、ID及协议相关选项，类型本身不保证数值范围。
	type ImageRenderOptions,
	// imageFallback生成包含MIME/尺寸/文件名等可选信息的回退说明文字。
	imageFallback,
	// renderImage按能力和尺寸生成图片控制串/占行信息或null，具体组件仍负责转码和输出集成。
	renderImage,
	// resetCapabilitiesCache仅清能力结论，保留程序覆盖、图片元数据和字符格尺寸，下次getCapabilities会重新探测。
	resetCapabilitiesCache,
	// setCapabilities直接保存显式能力对象，供宿主/测试确定使用的协议，不复制对象。
	setCapabilities,
	// setCapabilityOverrides设置程序级部分字段覆盖，影响能力探测并使能力缓存失效。
	setCapabilityOverrides,
	// setCellDimensions更新共享字符格尺寸引用，调用者负责通知相关组件失效重绘。
	setCellDimensions,
	// TerminalCapabilities描述图片协议、真彩色和超链接开关，是结论数据不是硬件保证。
	type TerminalCapabilities,
	// 这些低层函数来自terminal-image.ts，图片组件Image另在components/image.ts中组织渲染缓存。
} from "./terminal-image.ts";
// TUI核心接口、容器、覆盖层/输入事件和光标辅助方法的公共出口。
export {
	// Component要求render/invalidate，可选处理输入/鼠标；类型声明不会自动装配事件路由。
	type Component,
	// Container保存孩子并纵向拼接渲染结果，供其他容器/TUI继承。
	Container,
	// CURSOR_MARKER是零宽APC位置标记，宿主解析后摆硬件光标，不应把它作为可见文字宽度。
	CURSOR_MARKER,
	// compositeTuiLine在固定列把overlay行嵌入基础行，按宽字边界裁剪并补空格/重置样式。
	compositeTuiLine,
	// Focusable只要求focused字段，由宿主设置焦点，组件可据此发位置标记。
	type Focusable,
	// isFocusable是类型谓词，实际只检查对象非null且存在focused属性，不全面验证其类型/光标行为。
	isFocusable,
	// isViewportTUI检查运行时Symbol标记并缩窄接口，不等于对任意组件做完整能力审计。
	isViewportTUI,
	// OverlayAnchor约束中心/边角等定位字符串。
	type OverlayAnchor,
	// OverlayBounds是上次渲染的终端相对矩形行列/宽高。
	type OverlayBounds,
	// OverlayHandle描述隐藏/暂显/焦点/边界等控制方法，永久hide后不能再显示同一个覆盖层。
	type OverlayHandle,
	// OverlayMargin描述四边可选间距。
	type OverlayMargin,
	// OverlayOptions配置尺寸、锚点、偏移、可见回调及是否捕获焦点。
	type OverlayOptions,
	// OverlayUnfocusOptions指定释放覆盖层焦点后转交哪个组件或null。
	type OverlayUnfocusOptions,
	// renderFakeCursor仅给文字包模拟光标APC标记，最终是否反色/显示由TUI解析。
	renderFakeCursor,
	// SizeValue是绝对数字或数字百分比模板字符串类型，运行时还需实现按规则解析。
	type SizeValue,
	// TUI是接口而非可new的类，实际选择TuiMainScreen或TuiAltScreen。
	type TUI,
	// TuiInputListener是原始输入拦截回调类型，供上层消费或替换数据。
	type TuiInputListener,
	// TuiInputListenerResult约定可选consume/data，undefined表示无修改意见。
	type TuiInputListenerResult,
	// TuiMode区分regular主屏和fullscreen备用屏模式标签。
	type TuiMode,
	// TuiMouseButton是left/middle/right/none逻辑按钮类型。
	type TuiMouseButton,
	// TuiMouseEvent是已经正规化的局部坐标/按钮/修饰/滚轮等事件数据，不是原始stdin字符串。
	type TuiMouseEvent,
	// TuiMouseEventResult允许处理、捕获、焦点等结果，由上层路由执行，不因返回类型声明自动生效。
	type TuiMouseEventResult,
	// TuiMouseEventType列出press/release/move/drag/click/wheel种类。
	type TuiMouseEventType,
	// TuiStopOptions提供preserveScreen交接选项，具体行为看各TUI实现。
	type TuiStopOptions,
	// ViewportTUI在TUI上加布局根设置和运行时Symbol品牌，供支持布局帧的宿主使用。
	type ViewportTUI,
	// 所有这些名字从tui.ts重导出，共享原实现与标记，不新建第二套TUI状态。
} from "./tui.ts";
// TuiAltScreen是带应用自管滚动视口的备用屏实现；TuiAltScreenOptions配置轮速/鼠标/搜索样式/复制等，构造不等于start。
export { TuiAltScreen, type TuiAltScreenOptions } from "./tui-alt-screen.ts";
// TuiMainScreen向主屏/scrollback差分绘制；TuiMainScreenRenderState描述保存/恢复其绘制状态的数据，不是终端内容快照。
export { TuiMainScreen, type TuiMainScreenRenderState } from "./tui-main-screen.ts";
// Utilities
// 常用列宽/字符串工具的包级子集；内部字素分段器等没有在此全部公开。
export {
	// getOsc8LinkAtColumn按渲染行列返回覆盖该字素的OSC8 URL，不验证或打开URL。
	getOsc8LinkAtColumn,
	// replaceControlCharacters将每段连续C0/C1换成一个空格，不是剥离整个ANSI命令。
	replaceControlCharacters,
	// sliceByColumn按显示列取字符串片段，strict控制右边界是否允许完整宽字超出，不补半个字。
	sliceByColumn,
	// stripTerminalSequences删本解析器支持的控制码，未识别的内容仍保留，不是全面终端输入消毒。
	stripTerminalSequences,
	// truncateToWidth按连续字素前缀截断并可加省略号/补白，真正截断时重置正文样式/链接。
	truncateToWidth,
	// visibleWidth估算显示列，跳已识别序列、tab计3列，Unicode规则不保证每台终端字体一致。
	visibleWidth,
	// wrapTextWithAnsi按词/CJK字素折行并继承样式/链接，不自动填满每行背景。
	wrapTextWithAnsi,
	// 这组函数来自utils.ts，本入口不改变其缓存或参数默认值。
} from "./utils.ts";
// 只导出WheelScrollLines类型：可配置数值或auto滚轮策略；计算轮速状态的运行时对象不在此导出。
export type { WheelScrollLines } from "./wheel-scroll.ts";
