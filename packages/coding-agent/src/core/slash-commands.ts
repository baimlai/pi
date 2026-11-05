// 声明斜杠命令的展示元数据，供补全/UI识别；这里只列名字、说明和参数提示，真正命令处理在交互模式中。
// 应用名用于 quit 的展示文字，不影响命令名本身。
import { APP_NAME } from "../config.ts";
// 来源信息是纯类型，补全结果可据此展示扩展/技能/模板从哪里来。
import type { SourceInfo } from "./source-info.ts";

// 这里的source分类用于动态命令；内置命令另用下方BuiltinSlashCommand结构。
export type SlashCommandSource = "extension" | "prompt" | "skill";

// 动态命令的发现结果，不包含执行函数；同名冲突的处理由资源/扩展调用方负责。
export interface SlashCommandInfo {
	// 命令名通常不带开头斜杠，UI负责补成用户看到的 /name。
	name: string;
	// 可选的补全说明；没有说明仍可有命令项。
	description?: string;
	// 从哪种资源变成可调用命令。
	source: SlashCommandSource;
	// 同时保留更具体的路径、范围、包来源等元数据。
	sourceInfo: SourceInfo;
}

// 内置命令的补全/展示契约；argumentHint只是文字，不是参数校验schema。
export interface BuiltinSlashCommand {
	// 查找/输入使用的命令标识。
	name: string;
	// 当前界面采用的英语说明，注释不改运行时文案。
	description: string;
	// 可选参数占位提示，例如 <provider/model>，不会由本文件解析。
	argumentHint?: string;
}

// ReadonlyArray限制通过此类型增删项，不自动冻结数组或每个对象。
// 例如本表含compact，仅让调用方知道有这项；加载本文件不会立即触发压缩或调用模型。
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	// 打开设置界面的元数据。
	{ name: "settings", description: "Open settings menu" },
	// 模型选择入口，参数提示不是“只有指定供应商才能执行”的运行时校验。
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	// 浏览会话树/切换分支。
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	// 思考档位选择，合法档位解析由命令处理器负责。
	{ name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
	// 管理Ctrl+P模型循环的范围；快捷键默认/覆盖定义在键绑定系统。
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	// 导出历史；这里仅说明HTML/JSONL，尚不创建文件。
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	// 导入会话文件的入口说明。
	{ name: "import", description: "Import a JSONL session, preserving its ID and working directory" },
	// 分享可能走Radius或gist，具体目的地由设置与处理器决定。
	{ name: "share", description: "Share session via a Radius artifact or a GitHub gist" },
	// 报告问题的命令说明；列出此项不会自动上传报告。
	{ name: "bug", description: "Report a bug to the Pi developers", argumentHint: "<description>" },
	// 复制最后回复的入口，不在本表访问剪贴板。
	{ name: "copy", description: "Copy last agent message to clipboard" },
	// 修改会话显示名称。
	{ name: "name", description: "Set session display name" },
	// 展示会话信息与用量统计。
	{ name: "session", description: "Show session info and stats" },
	// 展示更新日志。
	{ name: "changelog", description: "Show changelog entries" },
	// 展示快捷键帮助。
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	// 从旧用户消息位置创建分叉会话的入口。
	{ name: "fork", description: "Create a new fork from a previous user message" },
	// 从当前位置复制当前会话的入口，与从旧消息fork的描述不同。
	{ name: "clone", description: "Duplicate the current session at the current position" },
	// 管理供后续会话使用的项目信任决定。
	{ name: "trust", description: "Save project trust decision for future sessions" },
	// 配置供应商认证，可提示供应商参数；并非此处开始OAuth流程。
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	// 移除认证的入口说明，本表不操作凭证存储。
	{ name: "logout", description: "Remove provider authentication" },
	// 新建会话的入口。
	{ name: "new", description: "Start a new session" },
	// 手动上下文压缩入口；实际压缩/扩展接管规则在会话层。
	{ name: "compact", description: "Manually compact the session context" },
	// 恢复其他会话的入口。
	{ name: "resume", description: "Resume another session" },
	// 重新加载资源的入口；是否复用扩展及不能撤回的副作用由资源加载实现决定。
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	// 模板字面量只把APP_NAME写进说明，命令名始终quit。
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
