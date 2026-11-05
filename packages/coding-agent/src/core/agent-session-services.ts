// 装配某个工作目录的模型、设置和资源服务；上游由 CLI/会话切换调用，下游交给 SDK 创建真正会话。
// join 按平台路径规则拼接配置文件地址，不读取文件。
import { join } from "node:path";
// import type 只导入开发期类型；ThinkingLevel 限定可用思考级别，不会生成运行时代码。
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
// Model 描述供应商、模型 id、能力等元数据，不是一个已运行的模型进程。
import type { Model } from "@earendil-works/pi-ai";
// 全局配置目录由统一 config 入口确定，避免各模块各自猜安装路径。
import { getAgentDir } from "../config.ts";
// resolvePath 展开支持的路径形式并转成绝对路径；不保证目标存在。
import { resolvePath } from "../utils/paths.ts";
// 导入扩展启动事件与自定义工具声明类型，供装配参数约束使用。
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
// ModelRuntime 统一管理认证、模型目录和实际供应商请求路由。
import { ModelRuntime } from "./model-runtime.ts";
// 分组导入资源加载实现和相关接口，下面 type 项仅在编译检查时使用。
import {
	// 默认实现会发现并加载扩展、技能、提示词和主题等资源。
	DefaultResourceLoader,
	// 构造参数类型，下面通过 Omit 排除由本函数统一决定的三个字段。
	type DefaultResourceLoaderOptions,
	// ResourceLoader 是可替换接口，调用者可以提供自己的资源来源。
	type ResourceLoader,
	// reload 的可选参数包含加载阶段的项目信任回调。
	type ResourceLoaderReloadOptions,
	// 以上符号都来自同一资源加载模块。
} from "./resource-loader.ts";
// 同时导入 SDK 的输入/输出类型与运行时工厂；这里不会调用 session.prompt。
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./sdk.ts";
// SessionManager 管理会话历史及可选 JSONL 落盘，此处只需要其类型。
import type { SessionManager } from "./session-manager.ts";
// 设置管理器合并全局与项目设置，并暴露读取方法。
import { SettingsManager } from "./settings-manager.ts";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
// interface 描述返回诊断的数据形状；声明本身不执行检查或输出。
export interface AgentSessionRuntimeDiagnostic {
	// 字符串字面量联合类型限定三种严重程度；error 是否终止由调用方决定。
	type: "info" | "warning" | "error";
	// 可供 CLI 或 UI 展示的诊断正文。
	message: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
// 创建目录相关服务的输入；问号表示调用者可以省略该属性。
export interface CreateAgentSessionServicesOptions {
	// 本次会话生效的工作目录，项目设置和资源以它为基准。
	cwd: string;
	// 可指定用户配置目录；省略时使用 getAgentDir 的结果。
	agentDir?: string;
	// 可复用已创建且信任状态已决定的设置管理器。
	settingsManager?: SettingsManager;
	// 可复用模型运行时；提供后不会在这里再创建另一份。
	modelRuntime?: ModelRuntime;
	// 只传给本函数新建 ModelRuntime 的取消信号，不是整段资源加载的取消开关。
	modelRuntimeSignal?: AbortSignal;
	// CLI 暂未识别的扩展参数：键是参数名，值是有无开关或字符串值。
	extensionFlagValues?: Map<string, boolean | string>;
	// Omit<T, K> 从类型 T 排除指定键；三个目录/设置字段由本函数最终填入。
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	// 资源重载选项，例如在加载项目资源前先解决信任决策。
	resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
}

/**
 * Inputs for creating an AgentSession from already-created services.
 *
 * Use this after services exist and any cwd-bound model/tool/session options
 * have been resolved against those services.
 */
// 服务就绪后创建会话的输入；将基础设施准备和会话选项解析分成两步。
export interface CreateAgentSessionFromServicesOptions {
	// 已准备好的同一工作目录服务，保证模型、资源和设置引用一致。
	services: AgentSessionServices;
	// 本次会话的历史管理器，可能是新建、恢复或纯内存实例。
	sessionManager: SessionManager;
	// 向扩展说明为什么启动本会话；初次创建时可以省略。
	sessionStartEvent?: SessionStartEvent;
	// 显式模型选择；既有代码中的 any 是 Model 的 API 泛型占位，不代表运行时校验。
	model?: Model<any>;
	// 显式思考级别，最终仍由 SDK 按模型能力限制。
	thinkingLevel?: ThinkingLevel;
	// Array<T> 是 T[] 的另一种写法；每项可附带切换模型时的思考级别。
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	// 工具名称、模式或增删修饰项列表，实际语义由 SDK 解析。
	tools?: string[];
	// 索引访问类型复用 SDK 的 excludeTools 属性类型，避免两处声明漂移。
	excludeTools?: CreateAgentSessionOptions["excludeTools"];
	// 复用 SDK 的默认工具抑制模式类型，区分 all 和 builtin。
	noTools?: CreateAgentSessionOptions["noTools"];
	// 额外注册的工具定义；注册不等于立即执行工具。
	customTools?: ToolDefinition[];
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
// 聚合一个有效 cwd 对应的基础设施对象，尚不包含 AgentSession。
export interface AgentSessionServices {
	// 规范化后的绝对工作目录。
	cwd: string;
	// 规范化后的用户配置根目录。
	agentDir: string;
	// 模型目录、凭证与模型请求路由的共享实例。
	modelRuntime: ModelRuntime;
	// 此目录适用的设置实例，加载器和会话将共享它。
	settingsManager: SettingsManager;
	// 已经 reload 过的资源加载器。
	resourceLoader: ResourceLoader;
	// 注册供应商或解析扩展参数产生的诊断列表。
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

// 将 CLI 扩展参数写入扩展运行时。输入是加载器和可选参数 Map；返回诊断，不打印、不退出。
// 流程：汇总已注册参数→逐个匹配→写值或记错。例如 --label demo 会给 string 参数 label 写入 demo；未注册名称汇总为错误。
function applyExtensionFlagValues(
	// 从加载结果读取扩展声明，并向同一 runtime.flagValues 写值。
	resourceLoader: ResourceLoader,
	// 联合 undefined 表示未提供参数表；Map 遍历顺序就是插入顺序。
	extensionFlagValues: Map<string, boolean | string> | undefined,
	// 返回诊断数组；即使有错误也会继续检查其他参数。
): AgentSessionRuntimeDiagnostic[] {
	// 完全没有参数表时，无需读取扩展声明。
	if (!extensionFlagValues) {
		// 用空数组表示没有可报告的参数问题。
		return [];
	}

	// 收集本次参数解析错误，局部变量不会自动打印。
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	// 取出已加载扩展及共享 runtime；这里不是重新加载扩展。
	const extensionsResult = resourceLoader.getExtensions();
	// 记录参数名对应的声明类型，Map 的泛型约束键和值。
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	// 逐个读取扩展声明，扩展也可能完全没有自定义参数。
	for (const extension of extensionsResult.extensions) {
		// 数组解构取出 Map 的参数名与定义。
		for (const [name, flag] of extension.flags) {
			// 写入类型索引；同名后项在这个索引中覆盖前项。
			registeredFlags.set(name, { type: flag.type });
		}
	}

	// 暂存找不到声明的参数名，最后一次性生成提示。
	const unknownFlags: string[] = [];
	// 遍历 CLI 输入，解构名称和值。
	for (const [name, value] of extensionFlagValues) {
		// 查找名称对应的扩展参数声明。
		const flag = registeredFlags.get(name);
		// 没有声明就不应写入运行时参数表。
		if (!flag) {
			// 收集未知参数，后续继续验证其他输入。
			unknownFlags.push(name);
			// continue 跳过当前项剩余逻辑，进入下一项。
			continue;
		}
		// boolean 声明按出现即开启处理，不读取输入值真假。
		if (flag.type === "boolean") {
			// 将该布尔参数设为 true，扩展之后可用 getFlag 读取。
			extensionsResult.runtime.flagValues.set(name, true);
			// 布尔项处理完毕，不进入字符串值检查。
			continue;
		}
		// 输入值来自 CLI 参数边界；string 声明需要实际字符串，单独的 --label 会留下布尔值而报错。
		if (typeof value === "string") {
			// 保留字符串原值，包括空字符串；此处没有额外转换。
			extensionsResult.runtime.flagValues.set(name, value);
			// 字符串项成功写入后处理下一项。
			continue;
		}
		// 参数需要字符串却没有字符串值时，追加一项错误。
		diagnostics.push({
			// 标记严重程度，让上层决定是否中止启动。
			type: "error",
			// 模板插值把实际参数名放进缺值提示；这里不改变参数本身。
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	// 存在未知名称才创建汇总诊断。
	if (unknownFlags.length > 0) {
		// 向同一诊断数组追加未知参数错误。
		diagnostics.push({
			// 未知 CLI 选项在这里按错误报告。
			type: "error",
			// 根据数量选择单复数，再把名称映射成 --name 并以逗号连接。
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	// 返回所有错误，供服务创建函数与其他诊断合并。
	return diagnostics;
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
// 准备 cwd 对应的基础设施。输入为目录及可选实例/资源选项；返回服务对象，不发送聊天请求。
// 流程：确定目录→准备模型/设置→加载资源→注册扩展模型→刷新快照→应用参数。加载失败可向外抛出；单项注册失败转诊断。
// 例如创建 /repo/a 的服务后，可先依据其模型目录解析 --model，再调用 createAgentSessionFromServices。
export async function createAgentSessionServices(
	// 使用完整选项对象传参，新增可选字段无需改变函数参数位置。
	options: CreateAgentSessionServicesOptions,
	// async 返回 Promise；只有所有 await 步骤完成后服务才就绪。
): Promise<AgentSessionServices> {
	// 规范化 cwd，后续资源发现与相对路径都依赖这个值。
	const cwd = resolvePath(options.cwd);
	// 有自定义配置目录就解析它，否则使用用户默认目录。
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	// 下面的多行表达式选择本次共享模型运行时。
	const modelRuntime =
		// 空值合并只在调用者未提供实例时执行右侧创建，不因普通假值自动回退。
		options.modelRuntime ??
		// 等待模型运行时加载认证和模型配置；默认不是发起模型对话。
		(await ModelRuntime.create({
			// 凭证文件固定放在当前 agentDir 下。
			authPath: join(agentDir, "auth.json"),
			// 用户自定义模型配置也来自同一目录。
			modelsPath: join(agentDir, "models.json"),
			// 向新建运行时传递取消信号，通常由 CLI 设置启动超时。
			signal: options.modelRuntimeSignal,
		}));
	// 复用调用者的设置管理器；否则按有效 cwd 和 agentDir 新建。
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	// 新建资源加载器，统一把本次服务引用传入。
	const resourceLoader = new DefaultResourceLoader({
		// 对象展开复制额外加载选项；缺省时展开空对象。
		...(options.resourceLoaderOptions ?? {}),
		// 此处靠后的 cwd 覆盖展开对象里的同名运行时属性。
		cwd,
		// 绑定同一配置目录，避免资源与认证使用不同根目录。
		agentDir,
		// 把同一设置对象交给加载器，信任决策可更新它。
		settingsManager,
	});
	// 真正执行资源加载；resolveProjectTrust 等回调在 reload 内部才被调用。
	await resourceLoader.reload(options.resourceLoaderReloadOptions);

	// 创建本次服务的诊断容器，注册失败不会直接输出。
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	// 加载期间扩展可能暂存供应商注册，此时取出待处理队列。
	const extensionsResult = resourceLoader.getExtensions();
	// 解构每项的供应商名、配置和来源扩展路径。
	for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
		// 将单个扩展注册包在 try 中，避免一项失败阻断其他项。
		try {
			// 按声明配置注册供应商；内部校验并更新目录，也可能启动本地刷新。
			modelRuntime.registerProvider(name, config);
			// 捕获本项注册抛出的异常。
		} catch (error) {
			// Error 取 message，其他抛出值用 String 转成可展示内容。
			const message = error instanceof Error ? error.message : String(error);
			// 将异常转为结构化诊断，继续服务装配。
			diagnostics.push({
				// 标记该注册问题为 error。
				type: "error",
				// 带上扩展路径，便于定位哪份扩展声明出错。
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	// 处理完配置式注册后清空队列，避免后续重复应用。
	extensionsResult.runtime.pendingProviderRegistrations = [];
	// 第二类队列直接携带符合原生 Provider 接口的对象。
	for (const { provider, extensionPath } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
		// 原生注册同样逐项隔离异常。
		try {
			// 把完整 Provider 对象交给运行时，不经过配置式适配。
			modelRuntime.registerNativeProvider(provider);
			// 仅捕获当前 Provider 的注册错误。
		} catch (error) {
			// 将异常统一为字符串消息。
			const message = error instanceof Error ? error.message : String(error);
			// 保留错误供上层启动界面或 stderr 展示。
			diagnostics.push({
				// 此条仍然属于错误诊断。
				type: "error",
				// 保留扩展来源和实际异常消息。
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	// 清空已消费的原生 Provider 队列。
	extensionsResult.runtime.pendingNativeProviderRegistrations = [];
	// 第三类队列是虚拟模型声明：模型可在每次请求时路由到物理模型。
	for (const { definition, extensionPath } of extensionsResult.runtime.pendingVirtualModelRegistrations) {
		// 逐项处理虚拟模型注册，错误不影响检查其他定义。
		try {
			// 注册虚拟选择和路由函数；此刻不执行路由或模型请求。
			modelRuntime.registerVirtualModel(definition);
			// 无效 id、与物理模型冲突等错误在此转换为诊断。
		} catch (error) {
			// 兼容 Error 与其他 JS 抛出值。
			const message = error instanceof Error ? error.message : String(error);
			// 收集带来源的虚拟模型注册错误。
			diagnostics.push({
				// 错误严重程度交给调用方处理。
				type: "error",
				// 提示指向声明虚拟模型的扩展文件。
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	// 虚拟模型队列消费后清空。
	extensionsResult.runtime.pendingVirtualModelRegistrations = [];
	// 等待本地配置/模型/认证快照刷新；allowNetwork:false 禁止这次目录刷新联网，不保证扩展加载绝无副作用。
	await modelRuntime.refresh({ allowNetwork: false });
	// 展开参数诊断数组追加到现有列表，而不是把数组作为单个元素。
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

	// 对象字面量返回全部就绪服务；属性简写相当于 cwd:cwd。
	return {
		// 返回有效工作目录。
		cwd,
		// 返回用户配置目录。
		agentDir,
		// 返回共享模型运行时。
		modelRuntime,
		// 返回共享设置管理器。
		settingsManager,
		// 返回已完成加载的资源入口。
		resourceLoader,
		// 返回本次装配产生的诊断；此函数本身不打印。
		diagnostics,
	};
}

/**
 * Create an AgentSession from previously created services.
 *
 * This keeps session creation separate from service creation so callers can
 * resolve model, thinking, tools, and other session inputs against the target
 * cwd before constructing the session.
 */
// 从现成服务创建 AgentSession。输入含服务、历史与模型/工具选项；返回 SDK 的 session/扩展结果/模型回退提示。
// 只做参数转接，不重新 reload 服务；SDK 会补默认值、恢复上下文并注册请求回调。例如将新打开的 SessionManager 与 /repo/a 服务组合起来恢复会话。
export async function createAgentSessionFromServices(
	// 调用者负责服务和历史属于预期工作目录。
	options: CreateAgentSessionFromServicesOptions,
	// Promise 的结果类型直接复用 SDK 工厂输出；SDK 抛错会向外传播。
): Promise<CreateAgentSessionResult> {
	// 直接返回异步工厂的 Promise；此处无需再 await 才能转交结果。
	return createAgentSession({
		// 会话相对路径使用服务已经确定的 cwd。
		cwd: options.services.cwd,
		// 会话配置根目录使用服务值。
		agentDir: options.services.agentDir,
		// 复用已注册扩展供应商的模型运行时。
		modelRuntime: options.services.modelRuntime,
		// 复用信任状态及设置快照。
		settingsManager: options.services.settingsManager,
		// 复用已加载资源，SDK 不会再创建默认加载器。
		resourceLoader: options.services.resourceLoader,
		// 使用调用方选择的新建或恢复历史。
		sessionManager: options.sessionManager,
		// 显式模型为空时，由 SDK 执行恢复和默认选择。
		model: options.model,
		// 显式思考级别为空时，由 SDK 按历史/设置补齐。
		thinkingLevel: options.thinkingLevel,
		// 传递 UI 模型循环候选项。
		scopedModels: options.scopedModels,
		// 传递工具白名单或增删修饰项。
		tools: options.tools,
		// 排除规则最终可覆盖允许规则。
		excludeTools: options.excludeTools,
		// 传递默认工具抑制模式。
		noTools: options.noTools,
		// 额外自定义工具也交给会话统一注册。
		customTools: options.customTools,
		// 传递 new/resume/fork 等扩展启动元数据。
		sessionStartEvent: options.sessionStartEvent,
	});
}
