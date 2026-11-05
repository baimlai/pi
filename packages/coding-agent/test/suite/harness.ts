import { createInMemoryModelRegistry, createModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
/**
 * Local test harness for the new coding-agent test suite.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type {
	FauxModelDefinition,
	FauxProviderRegistration,
	FauxResponseStep,
	Model,
	ToolResultMessage,
} from "@earendil-works/pi-ai/compat";
import { registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { AgentSession, type AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionRunner, ExtensionUIContext } from "../../src/core/extensions/index.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { InlineExtension, ResourceLoader } from "../../src/index.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "../utilities.ts";

// type 声明仅用于 TypeScript 检查；字面量 "text" 使这一形状能与图片等内容块区分。
type MessageTextPart = { type: "text"; text: string };

/**
 * 从未知消息中取出可读正文，返回字符串；不修改消息，也不读取文件。
 * 先检查外层对象和 content，再直接返回字符串，或筛选数组中的 text 块并用换行连接。
 * 例：content 为 [{type:"text",text:"a"},{type:"text",text:"b"}] 时得到 "a\nb"。
 * unknown 要求访问属性前先收窄；后面的 as 只告诉编译器预期形状，不验证数组及其元素，因此这不是任意 JSON 的完整校验器。
 */
export function getMessageText(message: unknown): string {
	// ! 排除 null/undefined 等假值；typeof 和 in 是未知输入边界检查，避免对非对象取 content。
	if (!message || typeof message !== "object" || !("content" in message)) {
		// 没有可提取内容时统一用空字符串，方便测试断言。
		return "";
	}
	// content? 表示属性可缺省；string | Array<...> 表示两种预期表示法，as 本身不会转换值。
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	// 只有 undefined 在此早退；若调用者强行传入 null，仍不在此函数的完整保障范围内。
	if (content === undefined) {
		return "";
	}
	// 字符串正文无需遍历内容块。
	if (typeof content === "string") {
		return content;
	}
	// 链式调用先保留文字块，再取文字，最后连成一个便于比较的字符串。
	// part is MessageTextPart 是类型谓词，让后续 map 知道保留下来的块有 text；运行时只检查 type。
	// 箭头函数对每个块返回它的文字，不保留块对象。
	// 多块之间插入换行；空数组产生空字符串。
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/** 从夹具的当前消息投影中取全部用户正文，返回新字符串数组；无额外 I/O。例：两次用户提问得到两个元素，不包含助手回复。 */
export function getUserTexts(harness: Harness): string[] {
	// 读取当前会话消息，过滤角色后调用上面的统一正文提取器。
	// role 是消息联合类型的判别字段；filter 在运行时选择用户项。
	// map 为每个用户消息计算一项，不修改原历史。
	return harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message));
}

/** 从同一会话投影中取助手正文；参数是夹具，结果是新数组，无写入副作用。例：工具调用助手没有 text 块时对应元素为空字符串。 */
export function getAssistantTexts(harness: Harness): string[] {
	// 与用户提取相同的两步流程，只把角色条件改为 assistant。
	// 保留助手消息，工具结果不会混入。
	// 文字内容由 helper 处理；不把 thinking 或 toolCall 当正文。
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

/** The latest result of `toolName` in the session transcript. */
/** 在夹具历史中从后往前找指定工具的结果，返回原消息引用；找不到就抛错。例：read 执行两次时 getToolResult(h,"read") 返回后一次，不执行新的 read。 */
export function getToolResult(harness: Harness, toolName: string): ToolResultMessage {
	// findLast 与 find 的方向相反；类型谓词同时给 TypeScript 说明返回值是工具结果消息。
	const result = harness.session.messages.findLast(
		// && 要求角色和工具名同时相等；只有 toolResult 分支才读取 toolName。
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
	// 测试找不到预期结果时尽早失败；模板字符串把工具名写入错误说明。
	if (!result) throw new Error(`No ${toolName} tool result`);
	// 返回找到的消息，不复制内容。
	return result;
}

/** An extension UI context that does nothing, with `overrides` applied. */
/**
 * 创建不显示真实终端界面的扩展 UI 替身；overrides 是部分接口字段，最后覆盖默认实现。
 * 返回完整接口对象，大部分动作返回 undefined，选择/输入默认取消，确认默认 false；不触碰剪贴板或编辑器。
 * 例：传 {confirm:async()=>true} 可让待测流程模拟用户确认；泛型 custom 的断言只是满足测试类型，不会生成真实组件。
 */
export function createTestUiContext(overrides: Partial<ExtensionUIContext> = {}): ExtensionUIContext {
	// Partial<T> 在开发期允许只提供某些 T 字段；默认 {} 使不传参也能调用。
	return {
		// async 箭头返回已完成的 Promise；默认选项、确认、输入分别模拟取消/否/取消。
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		// 空函数不显示通知；onTerminalInput 返回另一个空函数，充当撤销订阅的句柄。
		notify: () => {},
		onTerminalInput: () => () => {},
		// 下面这些显示设置入口均不保存状态：状态栏、工作提示、可见性、指示器和隐藏思考标签。
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		// 组件/页眉页脚/窗口标题的替身同样不创建真实 TUI。
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		// <T> 是调用方指定的结果类型；as T 不提供运行时值，默认实际仍得到 undefined。
		custom: async <T>() => undefined as T,
		// 粘贴、设置编辑器文本均为空操作，读文本固定返回空串。
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		// 默认多行编辑器模拟取消；补全/组件设置为空操作，组件读取返回 undefined。
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		// getter 在访问 ui.theme 时返回导入的主题引用，没有复制主题。
		get theme() {
			return theme;
		},
		// 不提供可切换主题；切换用结构化失败结果而不是抛错，展开状态固定为 false。
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		// 对象展开靠后，所以同名覆盖项会取代上面的默认函数或属性。
		...overrides,
	};
}

// interface 只约束调用方传参，不生成运行时校验；所有 ? 字段都可以省略。
export interface HarnessOptions {
	// faux 供应商名及模型描述；不传时由 registerFauxProvider 选默认值。
	provider?: string;
	models?: FauxModelDefinition[];
	// Partial 允许只覆盖少数设置；tools 是可选基础工具替换列表。
	settings?: Partial<Settings>;
	tools?: AgentTool[];
	// 初始激活、允许和排除列表分别影响工具加载策略；空数组与 undefined 的含义不同。
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	// 可直接给资源加载器，或让夹具从内联扩展工厂建立只含测试资源的加载器。
	resourceLoader?: ResourceLoader;
	extensionFactories?: Array<InlineExtension | CreateTestExtensionsResultInput>;
	// 缺省 true，安装的是字符串 faux-key；false 用来测试缺认证路径，不是读取真实用户凭据。
	withConfiguredAuth?: boolean;
	// Record 的键是字符串，值 unknown；这是待写入临时 models.json 的测试配置。
	modelsJson?: Record<string, unknown>;
	/** Session to continue, for example to test a resume. Default: a new in-memory session. */
	sessionManager?: SessionManager;
}

// 返回夹具的结构契约；这些字段共享实际 session/manager/provider 引用。
export interface Harness {
	// 会话与两个内存管理器，以及内存认证和可编程假供应商。
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	faux: FauxProviderRegistration;
	// 元组首项必需，后面的 ...T[] 可有零到多项，因此模型列表在类型上非空。
	models: [Model<string>, ...Model<string>[]];
	// 方法重载：不传 ID 保证默认模型，传 ID 查不到时可返回 undefined。
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	// 函数类型 (参数)=>返回值；设定/追加脚本回复会改变假供应商状态。
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	// events 记录原始事件；Extract 从事件联合类型中挑出 type 符合 T 的成员。
	events: AgentSessionEvent[];
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	tempDir: string;
	// 调用者负责结束后调用，释放会话、注销供应商并删除临时目录。
	cleanup: () => void;
}

/** 创建供单个夹具使用的临时目录，返回绝对路径；写文件系统，失败向上抛出。例：路径形如系统 tmp 下的 pi-suite-时间-随机串；随机名降低碰撞概率，并非严格唯一保证。 */
function createTempDir(): string {
	// Date.now 返回毫秒；36 进制随机串去掉前面的 0.，join 处理宿主路径分隔符。
	const tempDir = join(tmpdir(), `pi-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	// recursive 允许补齐父目录，也允许已有目录；没有在这里建立权限沙箱。
	mkdirSync(tempDir, { recursive: true });
	// 把路径交给后续 models.json、工具 cwd 等共用。
	return tempDir;
}

/**
 * 异步组装真实 AgentSession 与内存设置/认证、脚本化 faux 模型，返回可操作且可清理的 Harness。
 * 流程是建临时目录、注册供应商、建模型运行时和 Agent、加载测试扩展、构造会话并记录事件。
 * 副作用包括临时目录/可选 models.json 写入、供应商注册、扩展工厂执行；模型目录 helper 禁止模型网络。
 * 例：h=await createHarness(); h.setResponses([fauxAssistantMessage("ok")]); await h.session.prompt("hi") 会消费假回复。
 * 这里不代替测试调用 cleanup；初始化任一步失败会向外抛出，函数没有自动回收此前已创建资源的 try/finally。
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	// 默认参数使 createHarness() 等价于传空选项；先落地临时工作目录。
	const tempDir = createTempDir();
	// 注册假供应商，传入可选名称/模型列表；响应来自脚本而非真实模型服务。
	const fauxProvider: FauxProviderRegistration = registerFauxProvider({
		provider: options.provider,
		models: options.models,
	});
	// 显式清空回复脚本，再取非空模型列表的默认模型。
	fauxProvider.setResponses([]);
	const model = fauxProvider.getModel();
	// 有自定义基础工具才按 name 建字典；Object.fromEntries 将 [键,值] 数组转为对象。
	const toolMap = options.tools ? Object.fromEntries(options.tools.map((tool) => [tool.name, tool])) : undefined;
	// ?? 仅对 null/undefined 回退，显式 false 会保留。
	const withConfiguredAuth = options.withConfiguredAuth ?? true;
	// 通过共享可变容器连接稍后构造的 runner；current? 在 runner 尚未安装时可以缺省。
	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	// 会话管理器可由调用方提供以恢复已有历史；默认管理器和设置都只存内存。
	const sessionManager = options.sessionManager ?? SessionManager.inMemory();
	const settingsManager = SettingsManager.inMemory(options.settings);

	// 内存认证仓库不读取用户 auth.json。
	const authStorage = AuthStorage.inMemory();
	// 只有要求配置认证的案例才为测试供应商存假 key；await 等待串行修改完成。
	if (withConfiguredAuth) {
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	}
	// modelsJson 没提供时不生成配置路径；否则准备在自己的临时目录写 JSON。
	const modelsPath = options.modelsJson === undefined ? undefined : join(tempDir, "models.json");
	// JSON.stringify 是序列化，不是模式校验；路径存在时同步写文件，错误向上抛。
	if (modelsPath) writeFileSync(modelsPath, JSON.stringify(options.modelsJson));
	// 两个 helper 均关闭模型网络；带文件时额外加载该配置，不带文件走纯内存目录入口。
	const modelRegistry = modelsPath
		? await createModelRegistry(authStorage, modelsPath)
		: await createInMemoryModelRegistry(authStorage);
	// 把 faux 的模型元数据注册到会话模型目录，让模型选择/认证走正常接口。
	if (withConfiguredAuth) {
		modelRegistry.registerProvider(model.provider, {
			// 供应商级连接地址、假 key 和 API 来自已注册的 faux 对象。
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: fauxProvider.api,
			// map 投影出注册目录需要的每个模型字段；不执行推理，也不深复制嵌套元数据。
			models: fauxProvider.models.map((registeredModel) => ({
				// 标识/名称/API、推理能力及输入约束均原样传递。
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				inputLimits: registeredModel.inputLimits,
				// 费用、上下文/输出上限和 URL 用于后面的会话策略测试。
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
	}

	// 低层 Agent 负责模型/工具循环；此时构造对象尚未调用 prompt。
	const agent = new Agent({
		// 每次请求取假 key；关闭配置认证时返回 undefined，供缺认证测试使用。
		getApiKey: () => (withConfiguredAuth ? "faux-key" : undefined),
		// compat 的 streamSimple 依模型 API 分派到已注册 faux 流。
		streamFn: streamSimple,
		// 初态用默认模型、空提示词/工具；AgentSession 构造后会组装实际工具和提示词。
		initialState: {
			model,
			systemPrompt: "",
			tools: [],
		},
		// 应用消息先经真实转换函数投影成模型可接受的消息。
		convertToLlm,
		// 每次请求前读取当时的 runner，避免捕获初始化前的空值；payload 类型由 Agent 回调推断。
		onPayload: async (payload) => {
			const runner = extensionRunnerRef.current;
			// ?. 在 runner 缺省时得到 undefined；没有对应 handler 就保持原 payload。
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			// 返回扩展钩子处理后的载荷；async 会等待其 Promise 并向上传播失败。
			return runner.emitBeforeProviderRequest(payload);
		},
		// 收到供应商响应元信息时，同样只在存在 handler 时转发。
		onResponse: async (response) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			// await 让 after_provider_response 钩子完成后才继续，不在此消费响应正文。
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		// AgentMessage[] 是显式参数类型；上下文钩子可替换本次发给模型的消息投影。
		transformContext: async (messages: AgentMessage[]) => {
			const runner = extensionRunnerRef.current;
			// 没有 runner 直接沿用原数组；有 runner 就交给其 context 事件链。
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
	});
	// 工厂会真实执行并注册工具/事件；未传工厂时不创建扩展结果。
	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, tempDir)
		: undefined;
	// 调用方给的 loader 优先；否则使用不扫描真实项目资源的测试 loader。
	const resourceLoader =
		options.resourceLoader ?? createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined);

	// 将所有依赖交给真实会话构造器：它安装 Agent 钩子、运行时工具及扩展 runner。
	const session = new AgentSession({
		// 属性简写 agent 等价于 agent: agent；这些管理器沿用同一引用。
		agent,
		sessionManager,
		settingsManager,
		// 工具相对路径的根目录是临时 cwd；模型运行时由本测试 helper 取回。
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader,
		baseToolsOverride: toolMap,
		// undefined 与 [] 不同：前者使用默认工具策略，后者明确从空激活列表开始。
		initialActiveToolNames: options.initialActiveToolNames,
		usesDefaultTools: options.initialActiveToolNames === undefined,
		allowedToolNames: options.allowedToolNames,
		excludedToolNames: options.excludedToolNames,
		// 构造过程把 runner 写回容器，上面 Agent 的回调以后便能读取它。
		extensionRunnerRef,
	});

	// 可变数组收集事件原对象，供测试按时间顺序断言。
	const events: AgentSessionEvent[] = [];
	// subscribe 使每个会话事件都追加到数组；清理由 session.dispose 统一断开。
	session.subscribe((event) => {
		events.push(event);
	});

	// 返回对象暴露依赖、假回复控制器、事件查询及清理函数；不额外复制会话。
	return {
		session,
		sessionManager,
		settingsManager,
		authStorage,
		faux: fauxProvider,
		models: fauxProvider.models,
		// 将供应商闭包方法直接交给测试调用；不绑定到返回对象的 this 状态。
		getModel: fauxProvider.getModel,
		setResponses: fauxProvider.setResponses,
		appendResponses: fauxProvider.appendResponses,
		getPendingResponseCount: fauxProvider.getPendingResponseCount,
		events,
		/** 按事件 type 返回匹配项的新数组；泛型 T 保留精确事件类型，例 eventsOfType("agent_end") 可直接读该事件字段。无 I/O。 */
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			// extends 将 T 限定为有效 type 值；Extract 是类型层面过滤，运行时真正执行的是 ===。
			return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
		},
		tempDir,
		/** 停止此夹具并删除它的临时工作目录，返回 void；不等待所有取消任务完成。例：afterEach 中调用 h.cleanup()；清理抛错会向外传播。 */
		cleanup() {
			// dispose 解除订阅并请求取消，再从全局注册表移除本次 faux 供应商。
			session.dispose();
			fauxProvider.unregister();
			// 仅目录仍存在时递归删除；没有 force，也没有在这里自动恢复调用方给的 manager。
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}
