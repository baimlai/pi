import { join } from "node:path";
import { Agent, type AgentMessage, setDefaultStreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession, markRuntimeStreamFunction } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { CacheWarmer } from "./cache-warmer.ts";
import { getClientIdentity } from "./client-identity.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { createToolNameMatcher } from "./mcp-servers.ts";
import { convertToLlm } from "./messages.ts";
import { findInitialModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import {
	applyToolModifiers,
	DEFAULT_TOOL_NAMES,
	getToolListError,
	isToolModifier,
	SettingsManager,
} from "./settings-manager.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	withFileMutationQueue,
} from "./tools/index.ts";
import { getBranchSelection } from "./virtual-models.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn. Agent core remains
// provider-agnostic and does not import pi-ai/compat itself.
setDefaultStreamFn(streamSimple);

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.pi/agent */
	agentDir?: string;

	/** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
	modelRuntime?: ModelRuntime;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names or patterns, where `*` matches any characters.
	 *
	 * When omitted, pi uses the resolved `defaultTools` setting for the initial
	 * selection when configured. Otherwise it enables the default built-in tools
	 * (read, bash, edit, write). Extension/custom tools remain enabled unless
	 * `noTools` changes that default. When provided, only matching tools are
	 * enabled. MCP tools stay registered for codemode and tool search unless an
	 * entry starts with `mcp__`; then only matching MCP tools are kept. An empty
	 * list, like `noTools: "all"`, disables MCP tools too.
	 *
	 * A list of only `+name` and `-name` entries is not an allowlist: it adds tools
	 * to or removes them from the default selection, like the `defaultTools` setting.
	 * These entries take exact names. Mixing them with plain entries throws.
	 */
	tools?: string[];
	/**
	 * Optional denylist of tool names or patterns to disable. Applies after `tools` when both are
	 * provided, MCP tools included.
	 */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createPowerShellTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@earendil-works/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
// 中文初始化入口：装配会话所需对象，不是在这里处理某一句问题。一般创建一次 session，再多次 await session.prompt(...)。
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	// 确定工作目录，影响相对文件路径和项目资源发现；优先显式 cwd，再取会话目录，最后取进程目录。
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	// 确定 Pi 配置目录，默认 ~/.pi/agent；它不是用户项目的源码目录。
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	// 允许调用者传入资源加载器；没有时下面创建默认实现。
	let resourceLoader = options.resourceLoader;

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	// 创建/复用模型与认证运行时；后面的每次模型请求都通过它路由到实际供应商。
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));

	// 读取全局/项目设置，例如默认模型、工具、压缩阈值。
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	// 默认创建可持久化会话记录；可以显式传 SessionManager.inMemory() 只保存在内存。
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	// 恢复当前分支的有效消息；压缩过的历史会按投影规则呈现，不是把全部原始日志直接发模型。
	const existingSession = sessionManager.buildSessionContext();
	// 有恢复消息表示这是已有会话；后面会尝试恢复模型和思考级别。
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// Assistant messages name the physical model that answered, so a virtual selection is only in
	// model_change entries.
	const sessionModel = getBranchSelection(sessionManager.getBranch(), (provider, modelId) =>
		modelRuntime.getModel(provider, modelId),
	);

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && sessionModel) {
		const restoredModel = modelRuntime.getModel(sessionModel.provider, sessionModel.modelId);
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${sessionModel.provider}/${sessionModel.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
			// 共享模型/认证运行时，让会话和模型请求函数使用一致的配置。
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to per-model override, then global default
	if (thinkingLevel === undefined && model) {
		const perModel = settingsManager.getModelThinkingLevel(model.provider, model.id);
		if (perModel) {
			thinkingLevel = perModel;
		}
	}
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const toolListError = options.tools ? getToolListError(options.tools) : undefined;
	if (toolListError) throw new Error(`Invalid tools option: ${toolListError}`);
	const defaultToolNames = options.noTools ? [] : (settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES);
	// A `tools` list of only `+name`/`-name` entries changes the default selection instead of
	// replacing it, like the `defaultTools` setting.
	const toolModifiers = options.tools?.some(isToolModifier) ? options.tools : undefined;
	const selectedToolNames = toolModifiers ? applyToolModifiers(defaultToolNames, toolModifiers) : options.tools;
	const allowedToolNames = toolModifiers
		? options.noTools === "all"
			? selectedToolNames
			: undefined
		: (options.tools ?? (options.noTools === "all" ? [] : undefined));
	const excludedToolNames = options.excludeTools;
	const isExcludedTool = excludedToolNames ? createToolNameMatcher(excludedToolNames) : undefined;
	const initialActiveToolNames = (selectedToolNames ?? defaultToolNames).filter((name) => !isExcludedTool?.(name));

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	// 注册消息转换函数；名字虽长，主要是转换自定义消息，再按设置屏蔽图片。
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		// 先将 coding-agent 的 custom/bash/摘要等消息转成模型消息格式；不是调用模型。
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	// 共享引用盒子：稍后 AgentSession 创建扩展运行器后填 current，已注册的回调能读到最新值。
	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const cacheWarmer = new CacheWarmer(
		// 共享模型/认证运行时，让会话和模型请求函数使用一致的配置。
		modelRuntime,
		// 负责会话条目、分支、投影与可选 JSONL 保存。
		sessionManager,
		() => settingsManager.getCacheWarmingMode(),
		async (event) => extensionRunnerRef.current?.emitCacheWarmingDecision(event) ?? event.action,
	);
	// 每次请求才读取超时、重试等设置，使会话中途改配置也能生效。
	const buildRequestOptions = (options: ModelsSimpleStreamOptions = {}): ModelsSimpleStreamOptions => {
		const providerRetrySettings = settingsManager.getProviderRetrySettings();
		const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
		const headerRunner = extensionRunnerRef.current;
		// 返回本次请求选项：保留显式参数，再补超时、重试、身份和请求头处理回调。
		return {
			...options,
			timeoutMs: options.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs,
			websocketConnectTimeoutMs: options.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs(),
			maxRetries: options.maxRetries ?? providerRetrySettings.maxRetries,
			maxRetryDelayMs: options.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
			// Replaces the agent loop's default identity; read per request so telemetry changes apply at once.
			identity: getClientIdentity(settingsManager),
			transformHeaders: async (headers) =>
				headerRunner?.hasHandlers("before_provider_headers")
					? headerRunner.emitBeforeProviderHeaders(headers)
					: headers,
		};
	};
	// Warm only requests for the selected model. Requests a virtual selection routed, or that an
	// extension redirected, may not be repeated by the next request, so warming them could be wasted.
	const cacheContextIsCurrent = (requestModel: Model<any>) => {
		const messages = agent.state.messages;
		return () => {
			const currentModel = agent.state.model;
			const currentMessages = agent.state.messages;
			return (
				currentModel.provider === requestModel.provider &&
				currentModel.id === requestModel.id &&
				messages.length <= currentMessages.length &&
				messages.every((message, index) => currentMessages[index] === message)
			);
		};
	};
	const transformProviderPayload = async (payload: unknown) => {
		// 执行回调时再读取扩展运行器，重载扩展后也能用到新对象。
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("before_provider_request")) return payload;
		return runner.emitBeforeProviderRequest(payload);
	};
	const handleProviderResponse: NonNullable<ModelsSimpleStreamOptions["onResponse"]> = async (response) => {
		// 执行回调时再读取扩展运行器，重载扩展后也能用到新对象。
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("after_provider_response")) return;
		await runner.emit({
			type: "after_provider_response",
			status: response.status,
			headers: response.headers,
		});
	};
	const handleProviderStreamEvent: NonNullable<ModelsSimpleStreamOptions["onProviderStreamEvent"]> = async (
		data,
		// 当前模型选择，是一个含 provider/id 等信息的对象，不是正在运行的模型实例。
		model,
	) => {
		// 执行回调时再读取扩展运行器，重载扩展后也能用到新对象。
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("provider_stream_event")) return;
		await runner.emit({
			data,
			type: "provider_stream_event",
			provider: model.provider,
			api: model.api,
			model: model.id,
		});
	};

	// 创建低层 Agent，负责模型/工具循环；下面把 coding-agent 特有能力以回调形式交给它。
	const agent = new Agent({
		// Agent 起始状态；若恢复已有会话，就从旧历史继续。
		initialState: {
			// 先给空提示词；AgentSession 会根据资源、工具和扩展构造实际 system 内容。
			systemPrompt: "",
			// 当前模型选择，是一个含 provider/id 等信息的对象，不是正在运行的模型实例。
			model,
			// 当前思考级别，前面已经按模型能力限制到支持范围。
			thinkingLevel,
			// 这里先为空；稍后 AgentSession 的工具注册过程填入实际可执行工具。
			tools: [],
			// 放入已恢复的历史；之后每次 prompt 在这份会话基础上追加。
			messages: existingSession.messages,
		},
		// 传函数引用；真正调用发生在 agent-loop.ts 的模型请求边界。
		convertToLlm: convertToLlmWithBlockImages,
		// 关键接线：低层 Agent 以后通过这段回调请求模型；构造 Agent 时不会立即执行它。
		streamFn: async (model, context, options) => {
			// 合并本次请求参数与实时设置，得到 ModelRuntime 使用的 options。
			const requestOptions = buildRequestOptions(options);
			// Compaction and summaries use their own routing ids; only session requests
			// replace the cache entry, so warming restarts from them. Keep warming while
			// the current transcript still extends the request's prefix. Agent state may
			// shallow-copy the messages array or refresh the model object without changing
			// the provider request, so top-level object identity is not a valid cache key.
			// 只有本会话的普通请求才替换缓存保温目标，摘要等独立请求不应替换它。
			if (options?.sessionId === sessionManager.getSessionId()) {
				// 登记缓存保温目标；实际是否保温由策略决定，不表示每次 prompt 必然额外发请求。
				cacheWarmer.start({ model, context, options: requestOptions }, cacheContextIsCurrent(model));
			}
			// 生产路径进入 ModelRuntime；它从 Models 取 Provider，处理认证后直接调用 provider.streamSimple。
			return modelRuntime.streamSimple(model, context, requestOptions);
		},
		// 供应商请求体构造后，让扩展有机会处理它。
		onPayload: transformProviderPayload,
		// 收到响应头时通知扩展；它不是完整 assistant 回答事件。
		onResponse: handleProviderResponse,
		// 将供应商原始流事件交给有需要的扩展观察。
		onProviderStreamEvent: handleProviderStreamEvent,
		// 给请求带上会话 id；缓存优化可能使用它，但聊天历史仍必须通过 messages 传递。
		sessionId: sessionManager.getSessionId(),
		// 请求前把上下文交给扩展；外层会话还会继续包装这个变换。
		transformContext: async (messages) => {
			// 执行回调时再读取扩展运行器，重载扩展后也能用到新对象。
			const runner = extensionRunnerRef.current;
			// 还没有扩展运行器时直接保留原上下文。
			if (!runner) return messages;
			// 调用扩展 context 处理器，取得本次请求使用的消息。
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});
	// This stream resolves auth through modelRuntime, so summaries must not pre-resolve it (#11520).
	// 标记该请求函数已自行处理认证，避免摘要请求重复预解析 OAuth 等凭证。
	markRuntimeStreamFunction(agent.streamFunction, modelRuntime);

	// Restore missing settings metadata for older sessions.
	if (hasExistingSession) {
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	// 把 Agent、日志、配置、工具、扩展组成上层会话；用户平时调用的是这个 session。
	const session = new AgentSession({
		// 交给会话层管理的低层 Agent 实例。
		agent,
		// 负责会话条目、分支、投影与可选 JSONL 保存。
		sessionManager,
		// 提供配置读取与更新，供请求前准备、工具和压缩使用。
		settingsManager,
		// 项目工作目录，read("decision.txt") 等相对路径以此为基准。
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		// 共享模型/认证运行时，让会话和模型请求函数使用一致的配置。
		modelRuntime,
		cacheWarmer,
		initialActiveToolNames,
		usesDefaultTools: (options.tools === undefined || toolModifiers !== undefined) && !options.noTools,
		defaultToolModifiers: toolModifiers,
		allowedToolNames,
		excludedToolNames,
		// 把引用盒子交给会话，创建扩展运行器后会填入 current。
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
	});

	const extensionsResult = resourceLoader.getExtensions();

	// 返回装配结果对象；用 const { session } = await createAgentSession(...) 解构出会话。
	return {
		// 真正拿来 subscribe、prompt、compact、dispose 的会话对象。
		session,
		// 附带扩展加载结果，交互界面可以据此绑定 UI。
		extensionsResult,
		// 恢复旧模型失败时的提示信息；没有问题时通常为 undefined。
		modelFallbackMessage,
	};
}
