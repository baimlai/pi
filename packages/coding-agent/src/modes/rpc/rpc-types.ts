// 描述stdin命令、stdout响应和扩展UI往返的TypeScript契约；只是类型声明，不能替代JSON边界的真实校验。
/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

// 只导入消息/思考档位类型，运行时数据经JSONL传输，不会跨进程传类实例。
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
// 图片结构和模型类型用于声明wire字段，Model<any>是原契约保留的泛型写法，不代表运行时自动验证任意模型。
import type { ImageContent, Model } from "@earendil-works/pi-ai";
// 输入受理状态与会话统计复用会话层定义，避免协议另写一套含义。
import type { PromptDisposition, QueuedInputDisposition, SessionStats } from "../../core/agent-session.ts";
// 命令返回已清理/可能截断的BashResult，不是一个可执行子进程对象。
import type { BashResult } from "../../core/bash-executor.ts";
// 压缩返回摘要和相关元数据类型，真正模型调用在会话层。
import type { CompactionResult } from "../../core/compaction/index.ts";
// 原始条目与树节点分别服务追加历史查询和树形导航查询。
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
// 命令来源可以包含路径、范围和包元数据，和命令执行函数分开。
import type { SourceInfo } from "../../core/source-info.ts";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

/**
 * 用type标签区分所有stdin命令的联合；每项id?用于关联响应，服务端并不依靠这个TS定义完整校验外部JSON。
 * 例：{id:"q1",type:"prompt",message:"你好"}是受理请求，成功响应不等于模型已经回复完；事件另行输出。
 */
export type RpcCommand =
	// Prompting
	// 普通输入含可选图片；正在运行时的steer/followUp行为由streamingBehavior选择，不在类型定义里立即执行。
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	// 插话输入，返回实际queued/handled等受理状态，而非直接返回回答文本。
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	// 后续输入，通常在当前活动完成后处理，图片属于该条输入。
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	// 请求取消当前会话活动，无额外参数。
	| { id?: string; type: "abort" }
	// 清空两种待处理文字队列，成功响应返回清掉的文字。
	| { id?: string; type: "clear_queue" }
	// 新建会话，可选parentSession追踪来源，不是把父会话所有内容隐式复制进来。
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	// 查询当前状态，不提交用户消息。
	| { id?: string; type: "get_state" }

	// Model
	// 按精确供应商/模型id切换，是否在可用快照由服务端检查。
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	// 按会话当前循环范围切下一模型，不带单独direction参数。
	| { id?: string; type: "cycle_model" }
	// 读取已有可用模型快照，不在此协议类型里承诺实时联网刷新。
	| { id?: string; type: "get_available_models" }

	// Thinking
	// 显式设置请求档位；会话还会按模型能力钳制。
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	// 循环下一个支持的档位。
	| { id?: string; type: "cycle_thinking_level" }
	// 列当前模型可用档位。
	| { id?: string; type: "get_available_thinking_levels" }

	// Queue modes
	// 插话队列每次取全部或逐个取；mode联合限制两个字面量。
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	// 追问队列有独立消费策略，不与steeringMode共用字段。
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	// 手动压缩，可附自定义指令；此命令本身可能等待模型摘要或扩展接管结果。
	| { id?: string; type: "compact"; customInstructions?: string }
	// 只设置自动压缩开关，enabled:false是有效值。
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	// 只设置自动重试开关，不立即重跑当前请求。
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	// 请求停止重试等待路径。
	| { id?: string; type: "abort_retry" }

	// Bash
	// 执行Bash文字，可排除出后续模型上下文；不是把command按JSON argv数组解析。
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	// 请求取消会话正在管理的Bash执行。
	| { id?: string; type: "abort_bash" }

	// Session
	// 会话统计读取。
	| { id?: string; type: "get_session_stats" }
	// 导出HTML，outputPath可省略由会话层选路径。
	| { id?: string; type: "export_html"; outputPath?: string }
	// 切换到另一份会话文件，sessionPath是路径而非会话树条目id。
	| { id?: string; type: "switch_session"; sessionPath: string }
	// 从指定条目分叉，服务端返回选中文本与是否取消。
	| { id?: string; type: "fork"; entryId: string }
	// 从当前leaf位置复制活动分支，无须客户端再传leafId。
	| { id?: string; type: "clone" }
	// 取得适合分叉的用户消息列表及条目id。
	| { id?: string; type: "get_fork_messages" }
	// 读取追加顺序的原始条目；since排除该id自身，只取其后条目，不等同当前活动分支投影。
	| { id?: string; type: "get_entries"; since?: string }
	// 读取会话树及当前leafId。
	| { id?: string; type: "get_tree" }
	// 取最近assistant消息文字；原响应类型声明允许null，但当前服务端无文字时实际省略text字段，不发模型请求。
	| { id?: string; type: "get_last_assistant_text" }
	// 设置显示名，服务端还会trim并拒绝空白名；string类型自己没有这个约束。
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	// 读取会话消息状态，和包含模型切换/摘要等的原始entries不同。
	| { id?: string; type: "get_messages" }

	// Commands (available for invocation via prompt)
	// 列扩展命令/提示词/技能元数据；不等于列出内置斜杠命令表，也不直接执行命令。
	| { id?: string; type: "get_commands" };

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
// 给RPC宿主展示的动态命令信息，具体调用通过prompt中的斜杠文本触发。
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	// 名字不含开头斜杠，技能名可形如skill:name。
	name: string;
	/** Human-readable description */
	// 可缺说明，JSON编码会省略undefined属性。
	description?: string;
	/** What kind of command this is */
	// 来源标签三选一，不是认证/信任状态。
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	// 附原资源来源对象，不在这里按路径加载/执行资源。
	sourceInfo: SourceInfo;
}

// ============================================================================
// RPC State
// ============================================================================

// get_state的快照数据，服务端读取这些字段后编码；跨进程得到数据值而非活的会话引用。
export interface RpcSessionState {
	// 未选模型时可省略；保留原Model<any>契约，不把any扩散成新实现。
	model?: Model<any>;
	// 当前会话思考档位。
	thinkingLevel: ThinkingLevel;
	// 当前是否流式运行，不等同整个宿主没有其他异步工作。
	isStreaming: boolean;
	// 是否正在做压缩。
	isCompacting: boolean;
	// 当前插话消费策略。
	steeringMode: "all" | "one-at-a-time";
	// 当前追问消费策略。
	followUpMode: "all" | "one-at-a-time";
	// 内存会话可能没有文件路径。
	sessionFile?: string;
	// 会话唯一标识，与请求id不同。
	sessionId: string;
	// 可选显示名。
	sessionName?: string;
	// 自动压缩开关。
	autoCompactionEnabled: boolean;
	// 当前消息数组长度，不是原始entries总条数。
	messageCount: number;
	// 排队待处理消息数量，具体统计包含项由会话getter定义。
	pendingMessageCount: number;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
/**
 * 命令响应联合同时用command/success区分返回形状；id关联一次命令，不是流式事件的会话id。
 * success:true只指该命令路径成功；例如new_session仍可data.cancelled=true，prompt也可能仅queued/handled。普通模型输出走另一个事件协议类型。
 */
export type RpcResponse =
	// Prompting
	// prompt响应返回受理disposition，完成后的assistant内容/agent_settled另走事件流。
	| { id?: string; type: "response"; command: "prompt"; success: true; data: { disposition: PromptDisposition } }
	// steer响应返回队列/扩展处理状态。
	| { id?: string; type: "response"; command: "steer"; success: true; data: { disposition: QueuedInputDisposition } }
	// follow_up多行对象声明，与上一项只是排版不同。
	| {
			// 可选关联id，通常回显原命令id。
			id?: string;
			// 固定response标签，和会话事件标签不同。
			type: "response";
			// 明确这是follow_up的响应。
			command: "follow_up";
			// 命令成功受理，不代表已完成下一轮回答。
			success: true;
			// 返回实际输入受理状态。
			data: { disposition: QueuedInputDisposition };
	  }
	// abort成功不带data；是否有被取消活动由会话状态/事件体现。
	| { id?: string; type: "response"; command: "abort"; success: true }
	// clear_queue有数据响应，返回被移出的文字。
	| {
			// 请求关联id。
			id?: string;
			// 固定响应标签。
			type: "response";
			// 对应清队列命令。
			command: "clear_queue";
			// 成功标签。
			success: true;
			// 两队列分别返回字符串数组，不包含完整图片或消息对象。
			data: { steering: string[]; followUp: string[] };
	  }
	// 扩展可取消新会话动作，cancelled:true仍作为成功协议响应返回。
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	// get_state返回上面定义的状态对象。
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	// set_model成功响应带完整模型数据，不仅是id。
	| {
			// 原请求id。
			id?: string;
			// 响应标签。
			type: "response";
			// 设置模型命令标识。
			command: "set_model";
			// 成功布尔字面量，便于TS缩小分支。
			success: true;
			// 原契约完整模型对象，客户端可只声明自己用到的较小视图。
			data: Model<any>;
	  }
	// cycle_model可能没有可循环项。
	| {
			// 原请求id。
			id?: string;
			// 响应标签。
			type: "response";
			// 模型循环命令。
			command: "cycle_model";
			// 成功即使data=null也有效。
			success: true;
			// 有切换时给模型/档位/是否范围内；null表示没有可切换结果，不是失败error。
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	// 可用模型查询的列表响应。
	| {
			// 关联请求id。
			id?: string;
			// 响应标签。
			type: "response";
			// 命令名称。
			command: "get_available_models";
			// 成功标签。
			success: true;
			// 数据对象包住models数组，即使数组为空仍是成功响应。
			data: { models: Model<any>[] };
	  }

	// Thinking
	// 设置档位成功响应没有data，不回显钳制后的档位；可另get_state查询。
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	// 循环档位的响应。
	| {
			// 关联id。
			id?: string;
			// 响应标签。
			type: "response";
			// 命令名称。
			command: "cycle_thinking_level";
			// 成功标签。
			success: true;
			// 新档位对象；当前模型不支持thinking时服务端返回null，不能按“只有一个档位”推断为null。
			data: { level: ThinkingLevel } | null;
	  }
	// 当前支持档位列表响应。
	| {
			// 关联id。
			id?: string;
			// 响应标签。
			type: "response";
			// 命令名称。
			command: "get_available_thinking_levels";
			// 成功标签。
			success: true;
			// levels数组，不是把所有全局档位无条件当作模型都支持。
			data: { levels: ThinkingLevel[] };
	  }

	// Queue modes
	// 设置插话策略的空成功响应。
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	// 设置追问策略的空成功响应。
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	// 压缩命令成功带完整CompactionResult，等待时长由实际摘要路径决定。
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	// 自动压缩开关设置成功，不代表当场已压缩。
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	// 自动重试配置成功，不直接代表某次模型重试成功。
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	// 停止重试等待的成功回执。
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	// Bash成功表示执行路径返回BashResult；其中exitCode可非零，不能把协议success当成命令业务成功。
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	// 取消Bash的回执，不附新BashResult。
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	// 统计对象，不重新向供应商请求账单。
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	// 返回实际导出文件路径。
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	// 切会话可被扩展取消，状态放在data。
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	// 分叉返回选中文本与取消标志，可能用于外部编辑器回填。
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	// 克隆只返回取消状态，不附新的会话全文。
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	// 可分叉用户消息列表的响应。
	| {
			// 关联id。
			id?: string;
			// 响应标签。
			type: "response";
			// 命令名称。
			command: "get_fork_messages";
			// 成功标签。
			success: true;
			// Array<{...}>内联对象数组，每条同时带条目身份和展示文字。
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	// 原始条目列表响应。
	| {
			// 关联id。
			id?: string;
			// 响应标签。
			type: "response";
			// 命令名称。
			command: "get_entries";
			// 成功标签。
			success: true;
			// 追加顺序entries以及当前leaf；null表示没有当前条目。
			data: { entries: SessionEntry[]; leafId: string | null };
	  }
	// 会话树响应。
	| {
			// 关联id。
			id?: string;
			// 响应标签。
			type: "response";
			// 命令名称。
			command: "get_tree";
			// 成功标签。
			success: true;
			// 树节点数组和当前leafId，树可含非当前分支。
			data: { tree: SessionTreeNode[]; leafId: string | null };
	  }
	// 最后回复文字响应。
	| {
			// 关联id。
			id?: string;
			// 响应标签。
			type: "response";
			// 命令名称。
			command: "get_last_assistant_text";
			// 成功标签。
			success: true;
			// 保留原string|null声明；当前会话无文字返回undefined，JSON编码省略text，所以实际wire可能是data:{}，类型未完整反映此边界。
			data: { text: string | null };
	  }
	// 设置显示名的空成功响应。
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	// messages是模型对话状态，不含每种原始会话元条目。
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	// 动态命令元数据响应。
	| {
			// 关联id。
			id?: string;
			// 响应标签。
			type: "response";
			// 命令名称。
			command: "get_commands";
			// 成功标签。
			success: true;
			// 列表项不含可跨进程执行的JS函数。
			data: { commands: RpcSlashCommand[] };
	  }

	// Error response (any command can fail)
	// 失败分支允许任意command字符串，覆盖未知命令；error仅是文字，不包含data字段的成功契约。
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
/**
 * 扩展要求宿主显示UI/状态的输出协议，method标签细分能力；其中notify/setStatus等是单向通知，不都需要响应。
 * UI请求id通常由服务端UUID生成，与外部req_序号不同。含undefined字段编码成JSON时会被省略，类型声明不等于wire必有该键。
 */
export type RpcExtensionUIRequest =
	// 选择框含标题与选项，timeout可缺；返回value/取消由另一个输入类型表达。
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	// 确认框含标题/正文，响应confirmed布尔值。
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	// 文本输入框的请求结构。
	| {
			// 统一UI请求标签。
			type: "extension_ui_request";
			// 宿主回传结果必须使用同一UI请求id。
			id: string;
			// 方法名input，和RPC命令prompt不是同一层。
			method: "input";
			// 输入框标题。
			title: string;
			// 可选占位提示，不是预填的真实输入。
			placeholder?: string;
			// 宿主可参考的超时毫秒数，服务端也按对话帮助函数管理超时。
			timeout?: number;
	  }
	// 较大编辑器请求含可选prefill；该路径和短input的服务端超时/信号处理不同。
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	// 无需宿主回信的通知请求。
	| {
			// 请求标签。
			type: "extension_ui_request";
			// 仍分配id但不一定登记到等待Map。
			id: string;
			// 通知方法。
			method: "notify";
			// 通知正文。
			message: string;
			// 通知级别省略时交宿主默认处理。
			notifyType?: "info" | "warning" | "error";
	  }
	// 设置状态文字的单向请求。
	| {
			// 请求标签。
			type: "extension_ui_request";
			// 通知标识。
			id: string;
			// 方法名setStatus。
			method: "setStatus";
			// 哪一项扩展状态。
			statusKey: string;
			// undefined表示清除意图，JSON编码后字段会缺省，不会出现JS undefined字面量。
			statusText: string | undefined;
	  }
	// 设置文字小部件的请求，RPC不支持TUI组件工厂。
	| {
			// 请求标签。
			type: "extension_ui_request";
			// 通知标识。
			id: string;
			// 方法名setWidget。
			method: "setWidget";
			// 小部件key。
			widgetKey: string;
			// 文字行数组或移除意图，wire可能省略undefined字段。
			widgetLines: string[] | undefined;
			// 可选编辑器上方/下方位置。
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	// 设置窗口/终端标题的单向请求，具体宿主决定如何表现。
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	// 设置外部编辑器文字；这不是给模型提交消息。
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
// 宿主对等待中的UI请求回传的三种形状，id对应UI请求，不经普通RpcCommand响应流程。
export type RpcExtensionUIResponse =
	// 选择/文本/编辑器的文字结果。
	| { type: "extension_ui_response"; id: string; value: string }
	// 确认框的布尔结果，false也是明确结果而非缺失。
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	// 取消标记固定true；TS联合不自动阻止外部JSON缺字段/多字段。
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

// 索引访问类型取命令联合所有type值，得到命令名称的字符串字面量联合，不创建运行时数组。
export type RpcCommandType = RpcCommand["type"];
