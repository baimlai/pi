// 把宿主已加载的包导出对象提供给 jiti，供源码/嵌入程序里的扩展复用同一份运行时；不是独立沙箱，也不隔离扩展权限。
// 命名空间导入 import * as X 收集模块命名成员；此模块真正求值会加载这些静态依赖，上游 loader 是按需动态导入本表。
import * as bundledPiAgentCore from "@earendil-works/pi-agent-core";
// 模型目录/能力辅助子入口，独立于 pi-ai 根入口。
import * as bundledPiAiModels from "@earendil-works/pi-ai/models";
// OAuth 辅助子入口，导入模块不等于发起登录。
import * as bundledPiAiOauth from "@earendil-works/pi-ai/oauth";
// 供应商工厂/实现导出集合，不在此发聊天请求。
import * as bundledPiAiProviders from "@earendil-works/pi-ai/providers/all";
// 终端组件/按键等宿主模块，避免扩展再加载另一份 TUI 全局状态。
import * as bundledPiTui from "@earendil-works/pi-tui";
// 宿主 TypeBox schema 构造入口。
import * as bundledTypebox from "typebox";
// TypeBox 编译器入口，字典提供模块对象，不在此编译 schema。
import * as bundledTypeboxCompile from "typebox/compile";
// TypeBox value 操作入口，供扩展读取/校验等调用。
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @earendil-works/pi-coding-agent.
// 提供 coding-agent 根导出对象。原英文“不重导出 loader”已不完全符合当前根入口：根 index 经 extensions/index 重导出部分加载函数；这里依靠 loader 按需动态导入本表，避免启动就静态拉入整个扩展视图，勿据旧英文推断导出列表。
import * as bundledPiCodingAgent from "../../index.ts";
// 扩展专用 pi-ai 视图，把 compat 导出与宿主 TypeBox/StringEnum 汇合。
import * as bundledPiAiExtensionView from "./pi-ai-extension-view.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
// specifier 到模块导出对象的表。Record<string,unknown> 允许各包导出结构不同，未知结构由 jiti 消费；例如扩展导入 pi-ai 根会拿到兼容视图，不在建表时执行模型函数。
export const VIRTUAL_MODULES: Record<string, unknown> = {
	// 现代 TypeBox 根指向宿主同一模块命名空间。
	typebox: bundledTypebox,
	// TypeBox schema 编译子入口。
	"typebox/compile": bundledTypeboxCompile,
	// TypeBox value 子入口。
	"typebox/value": bundledTypeboxValue,
	// 旧包名同样指向现代 TypeBox 对象，不创建旧版本实现。
	"@sinclair/typebox": bundledTypebox,
	// 旧 compile 子入口复用现代编译模块。
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	// 旧 value 子入口复用现代 value 模块。
	"@sinclair/typebox/value": bundledTypeboxValue,
	// 现代 Agent 核心入口，扩展与宿主共享核心类型对应的运行值。
	"@earendil-works/pi-agent-core": bundledPiAgentCore,
	// 现代 TUI 入口，共享主题/按键等模块状态。
	"@earendil-works/pi-tui": bundledPiTui,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint) plus TypeBox's Type, Static and TSchema:
	// existing extensions using the old global API and pi-ai's former TypeBox
	// re-exports keep working.
	// 现代 pi-ai 根指向扩展兼容视图，带回 TypeBox 及兼容全局 API。
	"@earendil-works/pi-ai": bundledPiAiExtensionView,
	// 显式 compat 同样使用这份扩展视图。
	"@earendil-works/pi-ai/compat": bundledPiAiExtensionView,
	// models 子入口提供思考档位等模型辅助方法，并不只靠根导出代替它。
	"@earendil-works/pi-ai/models": bundledPiAiModels,
	// OAuth 子入口对象，实际登录须调用其函数。
	"@earendil-works/pi-ai/oauth": bundledPiAiOauth,
	// 供应商工厂子入口对象。
	"@earendil-works/pi-ai/providers/all": bundledPiAiProviders,
	// coding-agent 根导出，供扩展创建工具/组件等。
	"@earendil-works/pi-coding-agent": bundledPiCodingAgent,
	// 旧 Agent 包名复用当前宿主模块。
	"@mariozechner/pi-agent-core": bundledPiAgentCore,
	// 旧 TUI 包名复用当前宿主模块。
	"@mariozechner/pi-tui": bundledPiTui,
	// 旧 pi-ai 根也取得扩展兼容视图。
	"@mariozechner/pi-ai": bundledPiAiExtensionView,
	// 旧 compat 别名指同一个兼容视图对象。
	"@mariozechner/pi-ai/compat": bundledPiAiExtensionView,
	// 旧 models 别名保持与现代子入口同一对象身份。
	"@mariozechner/pi-ai/models": bundledPiAiModels,
	// 旧 OAuth 别名复用当前入口。
	"@mariozechner/pi-ai/oauth": bundledPiAiOauth,
	// 旧供应商工厂入口复用当前模块。
	"@mariozechner/pi-ai/providers/all": bundledPiAiProviders,
	// 旧 coding-agent 包名复用当前根导出。
	"@mariozechner/pi-coding-agent": bundledPiCodingAgent,
};
