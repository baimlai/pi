// CLI启动时选用的内置扩展清单；数组里是工厂声明，资源加载层随后运行工厂并按注册名称过滤被替代项。
// 被替代的工厂仍已初始化过，过滤不回滚其任意副作用；builtin资源也受设置/--no-extensions等加载规则控制。
// InlineExtension是工厂或具名配置对象的联合类型，只参与TS检查，不会自动加载扩展。
import type { InlineExtension } from "../core/extensions/types.ts";
// 默认导入名可在本文件起别名；codemodeExtension是模块默认工厂，不是已经执行的结果。
import codemodeExtension from "./codemode/index.ts";
// llama.cpp工厂负责注册供应商及/llama管理命令，导入此名字不调用工厂本身。
import llamaExtension from "./llama/index.ts";
// MCP工厂在加载时登记其能力，后续连接/调用仍有各自生命周期。
import mcpExtension from "./mcp/index.ts";
// 工具目录搜索的内置工厂，可被符合替换规则的第三方扩展接管。
import toolSearchExtension from "./tool-search/index.ts";

// 公开按顺序排列的扩展配置：例如启动加载器取得数组，再逐个执行factory；const只禁止变量重绑，数组仍可变。
export const builtInExtensions: InlineExtension[] = [
	// 这一项具名llama.cpp并标记内置，没有设置replaceable，不能把其他三项的接管规则直接套给它。
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	// 非可替换扩展占用相同工具/命令/flag名时，可把codemode整项排除；两个replaceable项不互相排除，不是此行直接覆盖注册表。
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	// 配置名tool-search与工具名tool_search不同；具体按注册名称过滤的是resource-loader，不按数组name自行猜测。
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	// MCP这一项也可让自定义/mcp实现接管，避免两份内置/外部管理逻辑并跑。
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
