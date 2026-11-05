// 管理当前会话及目录相关服务，串起恢复、新建、分叉和导入；CLI/UI 持有这个容器，SDK 工厂负责创建内部会话。
// 导入同步文件操作：导入会话时创建目录、检查存在性并独占复制 JSONL。
import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
// basename 取文件名，join 拼地址，parse 拆出扩展名以生成不重名的目标。
import { basename, join, parse } from "node:path";
// 路径规范化与比较统一走 paths 模块；pathsEqual 不会自动追踪符号链接。
import { pathsEqual, resolvePath } from "../utils/paths.ts";
// 只导入会话类型；运行时不需要通过本模块构造 AgentSession。
import type { AgentSession } from "./agent-session.ts";
// 服务包与诊断的类型来自目录服务装配层。
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
// 下面分组导入扩展事件和上下文类型，不增加运行时依赖。
import type {
	// 项目信任交互所需的上下文，恢复不同目录会话时可重新创建。
	ProjectTrustContext,
	// 会话替换完成后传给 withSession 的新上下文，避免继续使用失效旧上下文。
	ReplacedSessionContext,
	// 关闭事件类型限定 teardown 的 reason 字段。
	SessionShutdownEvent,
	// 启动事件记录 new/resume/fork 等来源信息。
	SessionStartEvent,
	// 这些类型通过扩展公共入口导入。
} from "./extensions/index.ts";
// 统一触发会话关闭钩子，让扩展在会话失效前清理资源。
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
// SDK 工厂的结果类型包括 session、扩展加载结果和模型回退提示。
import type { CreateAgentSessionResult } from "./sdk.ts";
// 在拆除旧会话前检查目标会话目录是否仍存在。
import { assertSessionCwdExists } from "./session-cwd.ts";
// 历史管理器提供新建、打开、分叉和持久化能力。
import { SessionManager } from "./session-manager.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
// extends 让接口继承 SDK 结果字段，再添加本运行时需要的服务和诊断。
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	// 本次会话对应的 cwd 相关基础设施。
	services: AgentSessionServices;
	// 本次创建过程的诊断，交由宿主展示。
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
// 函数类型：接收下面的目标信息，异步返回完整会话；声明不会实际创建对象。
export type CreateAgentSessionRuntimeFactory = (options: {
	// 目标会话使用的工作目录。
	cwd: string;
	// 用户配置根目录，切换 cwd 时通常保持不变。
	agentDir: string;
	// 已经打开或新建的会话历史管理器。
	sessionManager: SessionManager;
	// 可选启动原因，首次启动可省略。
	sessionStartEvent?: SessionStartEvent;
	// 可选信任交互上下文，宿主可针对目标 cwd 提供 UI。
	projectTrustContext?: ProjectTrustContext;
	// Promise 表示工厂调用可能加载磁盘资源并异步完成。
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
// 专门标识导入源不存在，调用方可用 instanceof 区分其他读取错误。
export class SessionImportFileNotFoundError extends Error {
	// readonly 仅禁止 TypeScript 代码再次赋值，不会在 JS 运行时冻结属性。
	readonly filePath: string;

	// 构造导入文件缺失异常。输入为解析后的路径，结果为 Error 实例；只保存路径和名称，不访问磁盘。
	// 例如导入 /tmp/missing.jsonl 时，上游存在性检查失败后创建此错误。
	constructor(filePath: string) {
		// super 先调用 Error 构造器，设置人类可读错误消息。
		super(`File not found: ${filePath}`);
		// 设置具体错误名，便于日志识别。
		this.name = "SessionImportFileNotFoundError";
		// 保留源路径，UI 可以直接展示或用于后续处理。
		this.filePath = filePath;
	}
}

// 从用户消息抽取纯文本。输入可以是字符串或内容块数组；返回连接后的文本，不改原数组。
// 数组会先筛掉图片等非文本块，再 map 取文字并拼接，例如两个文本块 a/b 得到 ab。
function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	// 用 typeof 区分合法联合类型的字符串分支和数组分支。
	if (typeof content === "string") {
		// 已经是文本就原样返回，空字符串也保留。
		return content;
	}

	// 以下链式调用从内容块中产生新数组，最后产生字符串。
	return (
		content
			// 类型谓词 part is ... 同时告诉 TS 过滤后的块有 text:string；运行时条件筛选真实文本块。
			.filter(
				(part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string",
			)
			// 把每个保留块映射成 text 字段。
			.map((part) => part.text)
			// 用空分隔符连接，不额外插入换行或空格。
			.join("")
	);
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
// 有状态的当前会话容器；替换流程先清理旧会话再建新会话，失败不自动回滚。
export class AgentSessionRuntime {
	// 可选异步宿主回调，用于替换后给 UI 重新绑定新的会话。
	private rebindSession?: (session: AgentSession) => Promise<void>;
	// 可选同步清理钩子，在旧会话上下文失效之前拆除宿主 UI。
	private beforeSessionInvalidate?: () => void;
	// 当前会话对象；private 约束 TS 调用者不直接访问该字段。
	private _session: AgentSession;
	// 当前 cwd 对应的服务包，会随会话替换一起更新。
	private _services: AgentSessionServices;
	// readonly 表示构造后不换工厂；工厂闭包可继续使用 CLI 的固定参数。
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	// 当前这次装配的诊断列表，切换后替换成新列表。
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	// 当前会话的模型恢复回退提示，可以没有。
	private _modelFallbackMessage?: string;

	// 保存初始会话与服务。输入包括创建工厂及可选诊断/提示；构造不发请求、不加载会话。
	// 例如先由 createRuntime 得到会话，再 new AgentSessionRuntime(...) 建立可切换的容器。
	constructor(
		// 调用者已经创建好的初始 AgentSession。
		_session: AgentSession,
		// 与初始会话配套的目录服务。
		_services: AgentSessionServices,
		// 以后 new/resume/fork 时重新装配会话的函数引用。
		createRuntime: CreateAgentSessionRuntimeFactory,
		// 省略诊断时每次构造得到新的空数组。
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		// 恢复模型失败时的可选提示。
		_modelFallbackMessage?: string,
		// 这些是普通构造参数，字段需要在函数体显式赋值；没有使用 TS 参数属性语法。
	) {
		// 保存会话引用，不复制会话对象。
		this._session = _session;
		// 保存服务引用，供 cwd 和配置访问。
		this._services = _services;
		// 保存工厂，当前不会调用它。
		this.createRuntime = createRuntime;
		// 保存初始诊断列表引用。
		this._diagnostics = _diagnostics;
		// 保存初始模型回退提示。
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	// 读取当前服务包，无参数、无副作用；例如 runtime.services.modelRuntime 始终跟随最新会话。
	get services(): AgentSessionServices {
		// getter 直接返回内部引用，不做副本或刷新。
		return this._services;
	}

	// 读取当前会话，无参数；替换后下次访问得到新对象，例如 runtime.session.prompt(...)。
	get session(): AgentSession {
		// 返回容器现在持有的 AgentSession。
		return this._session;
	}

	// 读取有效 cwd，无参数、无磁盘操作；它可能与进程启动目录不同。
	get cwd(): string {
		// 从当前服务包取目录，保证与加载的资源一致。
		return this._services.cwd;
	}

	// 读取诊断只读视图；readonly 只限制 TS 的数组修改操作，不复制、不冻结数组。
	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		// 返回当前诊断数组供 UI 或 CLI 展示。
		return this._diagnostics;
	}

	// 读取可选的模型回退消息；正常恢复成功时通常为 undefined。
	get modelFallbackMessage(): string | undefined {
		// 返回当前保存的提示，不在此重新检查模型。
		return this._modelFallbackMessage;
	}

	// 注册或清除替换后重绑回调。输入是可选 async 函数，无返回值；只存引用。
	// 例如 UI 注册 session => bindEvents(session)，会话切换成功后才真正执行。
	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		// 将回调保存到字段；传 undefined 可解除。
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	// 注册或清除同步失效前钩子。输入为可选函数，无返回值；关闭钩子完成后、dispose 前调用。
	// 例如宿主在这里移除旧扩展的 TUI 组件；此处设置回调时不会执行清理。
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		// 存储同步回调引用，后续 teardown/dispose 才调用。
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	// 通知扩展即将 new/resume。输入是原因和可选目标文件；异步返回 cancelled，不替换会话。
	// 有监听器就 await emit；例如扩展返回 cancel:true 会阻止后续切换。
	private async emitBeforeSwitch(
		// 联合字面量只允许两种切换原因。
		reason: "new" | "resume",
		// 恢复时可提供目标 JSONL，新建时可能还没有目标。
		targetSessionFile?: string,
		// 返回对象中的 cancelled 是确定布尔值。
	): Promise<{ cancelled: boolean }> {
		// 使用当前会话的扩展运行器，避免通知已经失效的旧实例。
		const runner = this.session.extensionRunner;
		// 无监听器时跳过事件分发。
		if (!runner.hasHandlers("session_before_switch")) {
			// 没有扩展阻止，允许继续切换。
			return { cancelled: false };
		}

		// 等待所有相应切换前处理器，取得聚合结果。
		const result = await runner.emit({
			// 事件判别字段决定 runner 调用哪类处理器。
			type: "session_before_switch",
			// 属性简写传递本次 new/resume 原因。
			reason,
			// 带上可选目标文件路径。
			targetSessionFile,
		});
		// 可选链容忍无事件结果；只有严格等于 true 才认为取消。
		return { cancelled: result?.cancel === true };
	}

	// 通知扩展即将分叉。输入是条目 id 和 before/at 位置；返回 cancelled，不改变历史。
	// 例如 before 用户条目时，监听器可先检查是否允许分叉并返回 cancel。
	private async emitBeforeFork(
		// 指定分叉参考条目的唯一 id。
		entryId: string,
		// position 是必填对象字段，调用方先补齐默认值。
		options: { position: "before" | "at" },
		// 异步完成事件处理后返回确定的取消状态。
	): Promise<{ cancelled: boolean }> {
		// 取当前会话对应的扩展事件运行器。
		const runner = this.session.extensionRunner;
		// 没有分叉前钩子就不用构造/分发该事件。
		if (!runner.hasHandlers("session_before_fork")) {
			// 默认允许分叉继续。
			return { cancelled: false };
		}

		// 等待分叉前处理器返回。
		const result = await runner.emit({
			// 此事件与普通切换事件区分开来。
			type: "session_before_fork",
			// 把参考条目的 id 传给扩展。
			entryId,
			// 对象展开将 position 合并到事件顶层。
			...options,
		});
		// 无结果或 cancel 不是 true 均视为未取消。
		return { cancelled: result?.cancel === true };
	}

	// 拆除当前会话。输入是关闭原因与目标文件；返回完成 Promise，有中止请求和资源清理副作用。
	// 顺序是 await abort→关闭扩展事件→同步 UI 清理→dispose，例如恢复另一会话前先把旧回合工具结果保存完。
	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		// Settle any active response first so the aborted turn (including tool
		// results) is persisted to the outgoing session before it is replaced.
		// 等待正在运行的回合中止并收尾，避免尚未保存的消息丢到会话替换之外。
		await this.session.abort();
		// 向当前扩展广播关闭事件，等待清理处理器。
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			// 标记为会话关闭事件。
			type: "session_shutdown",
			// 传递 new/resume/fork 等具体原因。
			reason,
			// 给扩展提供即将切换到的目标文件，可为空。
			targetSessionFile,
		});
		// 可选调用同步宿主清理钩子，不在清理和失效之间让出事件循环。
		this.beforeSessionInvalidate?.();
		// 使旧会话及其扩展上下文失效并释放相应资源。
		this.session.dispose();
	}

	// 应用已经创建成功的新结果。输入为完整工厂结果，无返回值；替换四个当前字段，不重建对象。
	// 例如切换成功后，所有 getter 立即指向新会话和服务。
	private apply(result: CreateAgentSessionRuntimeResult): void {
		// 更新当前会话引用。
		this._session = result.session;
		// 同时更新目录相关服务，避免工具/设置仍指向旧 cwd。
		this._services = result.services;
		// 用新装配诊断替换旧诊断。
		this._diagnostics = result.diagnostics;
		// 用本次模型回退提示替换旧提示，包括清空成 undefined。
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	// 完成会话替换后的宿主工作。输入为可选 withSession 回调，异步无值返回；先重绑 UI，再传递新上下文。
	// 例如扩展需要在新会话里追加提示，应写在 withSession(ctx) 中，不能继续用旧 ctx。
	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		// 只有宿主注册了重绑函数才执行。
		if (this.rebindSession) {
			// 等待宿主绑定新会话，后续操作可以使用更新后的界面。
			await this.rebindSession(this.session);
		}
		// 调用方提供了新上下文操作才进入此分支。
		if (withSession) {
			// 创建新会话有效上下文，并等待该回调完成；异常向调用方传播。
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	// 恢复指定会话。输入为 JSONL 路径及可选 cwd/新上下文/信任工厂；返回 cancelled。
	// 先允许扩展取消，再打开并检查目录，再拆旧建新、重绑宿主。例如 /resume a.jsonl 会切到文件头记录的 cwd；创建失败不会复原已 dispose 的旧会话。
	async switchSession(
		// 目标文件地址，交给 SessionManager.open 解析。
		sessionPath: string,
		// 可选对象集中描述恢复时的额外行为。
		options?: {
			// 覆盖文件头中的 cwd，常用于原工作目录已删除时。
			cwdOverride?: string;
			// 恢复后用新扩展上下文执行的异步操作。
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			// 按目标 cwd 构造信任交互上下文，避免沿用旧目录的 UI 语义。
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
		// 此方法异步返回取消状态，其他失败通过异常报告。
	): Promise<{ cancelled: boolean }> {
		// 在读取/拆除前通知扩展恢复意图。
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		// 扩展若取消，立即终止后续替换流程。
		if (beforeResult.cancelled) {
			// 原样返回取消结果，当前会话仍保留。
			return beforeResult;
		}

		// 保存旧会话文件，用于新会话的启动事件元数据。
		const previousSessionFile = this.session.sessionFile;
		// 打开目标文件；省略 sessionDir 时从目标文件父目录推导会话目录。
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		// 检查目标 cwd；失败发生在旧会话 teardown 之前。
		assertSessionCwdExists(sessionManager, this.cwd);
		// 等旧回合与扩展清理完成后再创建新运行时。
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		// 工厂成功返回后一次性应用其会话/服务/诊断引用。
		this.apply(
			// 调用已保存工厂，为目标目录重新装配基础设施和会话。
			await this.createRuntime({
				// 目标工作目录来自刚打开的会话管理器。
				cwd: sessionManager.getCwd(),
				// 保留同一用户配置根目录。
				agentDir: this.services.agentDir,
				// 历史使用目标文件的管理器。
				sessionManager,
				// 说明这是恢复，并带上之前的会话文件。
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				// 可选链调用信任工厂；未提供时传 undefined 让宿主工厂决定。
				projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
			}),
		);
		// 重新绑定宿主，并执行可选的恢复后操作。
		await this.finishSessionReplacement(options?.withSession);
		// 到达这里表示流程未被取消，不代表所有诊断都没有 warning。
		return { cancelled: false };
	}

	// 在当前 cwd 新建会话。可选输入指定父会话、初始化历史和新上下文回调；返回 cancelled。
	// 沿用旧会话持久化模式→拆旧建新→运行 setup→刷新上下文→重绑。例如 setup 可添加初始历史，refreshContext 才把它投影到 Agent。
	async newSession(options?: {
		// 可选父会话文件记录来源关系，不自动复制旧历史。
		parentSession?: string;
		// 新会话建立后直接操作 SessionManager 的异步初始化函数。
		setup?: (sessionManager: SessionManager) => Promise<void>;
		// 使用新有效扩展上下文的完成回调。
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		// 方法完成时返回对象，而不是新会话本身；新会话通过 getter 读取。
	}): Promise<{ cancelled: boolean }> {
		// 扩展可在创建新历史前阻止切换。
		const beforeResult = await this.emitBeforeSwitch("new");
		// 检测扩展的取消标志。
		if (beforeResult.cancelled) {
			// 取消时不创建新会话、不拆旧会话。
			return beforeResult;
		}

		// 保存旧文件用于 session_start 事件。
		const previousSessionFile = this.session.sessionFile;
		// 复用当前会话日志存储目录。
		const sessionDir = this.session.sessionManager.getSessionDir();
		// 根据旧会话是否落盘，决定新管理器的持久化模式。
		const sessionManager = this.session.sessionManager.isPersisted()
			? // 旧会话落盘，新会话也使用相同 cwd/sessionDir 的可持久化管理器。
				SessionManager.create(this.cwd, sessionDir)
			: // 旧会话纯内存，新会话继续纯内存。
				SessionManager.inMemory(this.cwd);
		// 显式传入 parentSession 时需要给新会话头写入来源关系。
		if (options?.parentSession) {
			// 重置新管理器的初始会话头并记录父文件；此处不复制父消息。
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		// 等待旧会话回合与关闭钩子收尾。
		await this.teardownCurrent("new", sessionManager.getSessionFile());
		// 应用重新创建的完整运行时结果。
		this.apply(
			// 按当前目录创建全新的 AgentSession。
			await this.createRuntime({
				// 新会话留在当前工作目录。
				cwd: this.cwd,
				// 配置目录保持一致。
				agentDir: this.services.agentDir,
				// 使用刚创建的空历史管理器。
				sessionManager,
				// 扩展收到 new 原因与旧文件信息。
				sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
			}),
		);
		// 存在初始化函数才修改新历史。
		if (options?.setup) {
			// 让调用者按需填充新会话管理器，等待所有初始化写入。
			await options.setup(this.session.sessionManager);
			// 把修改后的历史重新投影到 Agent，使消息和设置与管理器一致。
			this.session.refreshContext();
		}
		// 初始化完成后再重绑宿主并执行 withSession。
		await this.finishSessionReplacement(options?.withSession);
		// 新会话建立成功，返回未取消。
		return { cancelled: false };
	}

	// 从某条历史分叉。输入是条目 id，默认 before；返回 cancelled 和可能要回填编辑器的 selectedText。
	// at 包含该条目，before 只接受用户消息并回到其父条目。按落盘/内存分别建分支，旧会话先收尾后替换；非法条目或缺失源文件抛错。
	// 例如 before 第三条用户问题会保留之前历史，并把第三条问题文字返给 UI 编辑。
	async fork(
		// 指定会话树中的参考条目。
		entryId: string,
		// 位置可省略，withSession 在新分支完成后使用新上下文执行。
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
		// selectedText 只在 before 用户消息时产生；图片不被转成可编辑文本。
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		// ?? 只在 position 未提供时取 before。
		const position = options?.position ?? "before";
		// 在分叉前把 id 和实际位置通知扩展。
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		// 扩展阻止时无需再查询条目。
		if (beforeResult.cancelled) {
			// 返回取消结果，不附带选中文字。
			return { cancelled: true };
		}
		// 分支的最终保留条目；null 表示没有任何原历史条目可保留。
		let targetLeafId: string | null;
		// 稍后可回填输入框的用户文本，默认未定义。
		let selectedText: string | undefined;

		// 在当前历史索引里查找参考条目。
		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		// 非法/不存在 id 不能作为分叉位置。
		if (!selectedEntry) {
			// 抛出错误，保持后续 teardown 尚未发生。
			throw new Error("Invalid entry ID for forking");
		}

		// at 允许保留到指定条目本身。
		if (position === "at") {
			// 目标叶子直接取所选条目 id。
			targetLeafId = selectedEntry.id;
			// 另一种情况是 before，需要排除用户问题本身。
		} else {
			// 只有用户消息能提取文本并回到问题之前，其他条目拒绝。
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				// 抛出非法分叉位置错误。
				throw new Error("Invalid entry ID for forking");
			}
			// 把父节点作为保留历史的末尾，首条消息的父节点可能是 null。
			targetLeafId = selectedEntry.parentId;
			// 提取被排除问题的文本，让宿主可再次编辑发送。
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		// 记录旧文件，用于分叉的新会话启动事件。
		const previousSessionFile = this.session.sessionFile;
		// 落盘会话需要使用独立目标文件，保留原文件。
		if (this.session.sessionManager.isPersisted()) {
			// 读取当前实际会话文件路径。
			const currentSessionFile = this.session.sessionFile;
			// 持久化会话缺少路径属于无效状态，不能继续复制。
			if (!currentSessionFile) {
				// 明确报错而不是猜测源文件。
				throw new Error("Persisted session is missing a session file");
			}
			// 目标新文件沿用当前会话目录。
			const sessionDir = this.session.sessionManager.getSessionDir();
			// 目标为空表示从历史最开头之前分叉，结果是空会话。
			if (!targetLeafId) {
				// 创建新的空管理器，不需要从源文件读取历史条目。
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				// 把原会话路径写成父会话来源。
				sessionManager.newSession({ parentSession: currentSessionFile });
				// 拆除旧会话，并把新目标文件传给关闭钩子。
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				// 将工厂结果设置为当前会话。
				this.apply(
					// 按空分叉历史重新创建运行时。
					await this.createRuntime({
						// 沿用当前工作目录。
						cwd: this.cwd,
						// 沿用用户配置目录。
						agentDir: this.services.agentDir,
						// 交给工厂新建的空历史管理器。
						sessionManager,
						// 向扩展说明来源是 fork，并指明旧文件。
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
				);
				// 完成宿主重绑和新上下文操作。
				await this.finishSessionReplacement(options?.withSession);
				// 返回成功及待回填文本，提前结束空分支流程。
				return { cancelled: false, selectedText };
			}

			// 非空落盘分支必须已经有实际源文件。
			if (!existsSync(currentSessionFile)) {
				// 尚未保存对话时直接报错；管理器有目标路径不代表磁盘文件已经存在。
				throw new Error("This session has not been saved yet. Send a message before cloning or forking it.");
			}
			// 另开管理器读取原文件，避免修改旧会话管理器的选中分支。
			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			// 只把根到目标叶子的路径提取成新会话，管理器自身切到新分支。
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			// 落盘分叉应该返回目标文件；空结果视为创建失败。
			if (!forkedSessionPath) {
				// 阻止后续替换，向调用方报告无法创建分支。
				throw new Error("Failed to create forked session");
			}
			// 此时目标历史已经准备好，再等待旧会话收尾。
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			// 应用目标分支的完整运行时结果。
			this.apply(
				// 通过相同工厂重建新分支的会话对象。
				await this.createRuntime({
					// cwd 来自分叉管理器。
					cwd: sessionManager.getCwd(),
					// 沿用配置目录。
					agentDir: this.services.agentDir,
					// 使用已经切到新文件的分叉管理器。
					sessionManager,
					// 传递 fork 启动事件及旧会话来源。
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
			);
			// 等待新会话 UI/上下文绑定。
			await this.finishSessionReplacement(options?.withSession);
			// 返回分叉成功，selectedText 可能为 undefined。
			return { cancelled: false, selectedText };
		}

		// 内存模式不需要另开源文件，继续使用原历史管理器。
		const sessionManager = this.session.sessionManager;
		// 先中止并清理旧 AgentSession，再改变管理器中的历史。
		await this.teardownCurrent("fork", sessionManager.getSessionFile());
		// 没有要保留的历史就重置为空会话。
		if (!targetLeafId) {
			// 新内存会话记录可选父来源，但不会产生磁盘文件。
			sessionManager.newSession({ parentSession: previousSessionFile });
			// 有目标叶子时提取它的根路径。
		} else {
			// 在内存替换历史；内存模式返回 undefined 是正常行为，这里不把它当错误。
			sessionManager.createBranchedSession(targetLeafId);
		}
		// 应用从改好历史重新创建的会话。
		this.apply(
			// 调用工厂，让消息、资源和扩展上下文重新绑定。
			await this.createRuntime({
				// 分叉留在当前 cwd。
				cwd: this.cwd,
				// 保持相同 agentDir。
				agentDir: this.services.agentDir,
				// 传入已更新的内存管理器。
				sessionManager,
				// 扩展仍收到 fork 原因和旧会话路径。
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			}),
		);
		// 新会话就绪后执行宿主与调用者完成回调。
		await this.finishSessionReplacement(options?.withSession);
		// 返回成功及可能存在的用户文本。
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	// 导入 JSONL 并切换。输入为源路径和可选 cwd 覆盖；返回取消状态，可能创建目录及复制文件。
	// 流程：解析源→选不重名目标→切换前钩子→复制→打开检查→拆旧建新。例如已有 a.jsonl 时导入另一份 a.jsonl，目标改成 a-1.jsonl；后续失败不会自动删除已复制文件。
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		// 把源路径转为绝对路径；不会因此验证 JSONL 格式。
		const resolvedPath = resolvePath(inputPath);
		// 先检查源路径是否存在。
		if (!existsSync(resolvedPath)) {
			// 不存在时抛专用错误，旧会话未受影响。
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		// 导入目标使用当前会话管理器的日志目录。
		const sessionDir = this.session.sessionManager.getSessionDir();
		// 目录尚不存在时需要创建。
		if (!existsSync(sessionDir)) {
			// 递归补齐中间目录；即便后续扩展取消，这个目录也可能已创建。
			mkdirSync(sessionDir, { recursive: true });
		}

		// 目标初始文件名使用源文件 basename，丢弃源目录部分。
		let destinationPath = join(sessionDir, basename(resolvedPath));
		// 按平台规范化路径比较，判断源是否已是目标；此处不解析符号链接。
		const sourceAlreadyStored = pathsEqual(destinationPath, resolvedPath);
		// 源与目标不同才执行重名避让和后续复制。
		if (!sourceAlreadyStored) {
			// 拆出不含扩展名的 name 与带点的 ext。
			const { name, ext } = parse(destinationPath);
			// 候选后缀从 1 开始。
			let suffix = 1;
			// 目标存在就持续尝试下一个后缀。
			while (existsSync(destinationPath)) {
				// 后置 ++ 先用当前数字再加一，例如 a-1.jsonl、a-2.jsonl。
				destinationPath = join(sessionDir, `${name}-${suffix++}${ext}`);
			}
		}
		// 目标名确定后再询问扩展是否允许恢复切换。
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		// 扩展取消时不复制源文件。
		if (beforeResult.cancelled) {
			// 返回取消结果；此前可能已创建空目录。
			return beforeResult;
		}

		// 保存旧文件供新启动事件使用。
		const previousSessionFile = this.session.sessionFile;
		// 源已在目标位置就直接打开，避免复制到自身。
		if (!sourceAlreadyStored) {
			// COPYFILE_EXCL 在目标已存在时失败，防止选名到复制之间的竞争覆盖现有文件。
			copyFileSync(resolvedPath, destinationPath, constants.COPYFILE_EXCL);
		}

		// 读取导入后的目标文件，cwdOverride 可替换文件头目录。
		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		// 检查有效 cwd，失败时旧会话仍未拆除，但已复制文件不会回滚。
		assertSessionCwdExists(sessionManager, this.cwd);
		// 目标有效后等待旧会话关闭收尾。
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		// 应用新创建的导入会话运行时。
		this.apply(
			// 按目标历史及目录重新装配。
			await this.createRuntime({
				// 使用导入文件的有效 cwd。
				cwd: sessionManager.getCwd(),
				// 沿用用户配置根目录。
				agentDir: this.services.agentDir,
				// 使用目标 JSONL 的历史管理器。
				sessionManager,
				// 导入对扩展表现为 resume，而不是额外定义新启动原因。
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
		);
		// 重绑宿主；本方法没有额外 withSession 参数。
		await this.finishSessionReplacement();
		// 返回导入切换未被取消。
		return { cancelled: false };
	}

	// 关闭运行时。无参数、异步无值返回；先通知 quit，再同步清理并 dispose。
	// 例如宿主退出时 await runtime.dispose()。此方法本身不像 teardownCurrent 那样显式 await abort，调用方需按退出流程处理活跃回合。
	async dispose(): Promise<void> {
		// 等待当前扩展的关闭事件处理器。
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			// 使用会话关闭事件类型。
			type: "session_shutdown",
			// quit 表示程序退出，而非切换到另一个会话。
			reason: "quit",
		});
		// 旧上下文失效前同步拆宿主 UI。
		this.beforeSessionInvalidate?.();
		// 释放会话资源并使旧扩展上下文失效。
		this.session.dispose();
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
// 创建首次运行时容器。输入为可复用工厂及初始目标，返回 AgentSessionRuntime；创建失败直接抛出。
// 先检查 cwd，再 await 工厂，最后保存结果和工厂。例如 CLI 第一次启动调用它，之后容器用同一工厂处理 /new。
export async function createAgentSessionRuntime(
	// 工厂负责实际资源/会话创建，此函数只协调首次装配。
	createRuntime: CreateAgentSessionRuntimeFactory,
	// 初始目标选项与后续替换使用的公共字段一致。
	options: {
		// 当会话 cwd 缺失时用于错误说明的当前目录。
		cwd: string;
		// 用户配置根目录。
		agentDir: string;
		// CLI 已选好的历史管理器。
		sessionManager: SessionManager;
		// 可选扩展启动元数据。
		sessionStartEvent?: SessionStartEvent;
	},
	// Promise 完成后返回可管理后续切换的容器。
): Promise<AgentSessionRuntime> {
	// 先确认已选会话的有效工作目录可用。
	assertSessionCwdExists(options.sessionManager, options.cwd);
	// 等待实际会话与目录服务创建。
	const result = await createRuntime(options);
	// 创建容器，构造器仅保存以下引用。
	return new AgentSessionRuntime(
		// 保存首次创建的会话。
		result.session,
		// 保存其目录服务。
		result.services,
		// 保存同一个工厂供以后复用。
		createRuntime,
		// 保存初次创建诊断。
		result.diagnostics,
		// 保存初次模型回退提示。
		result.modelFallbackMessage,
	);
}

// 重新导出服务层公共 API，使 SDK 使用者可从运行时入口统一导入。
export {
	// 服务装配诊断类型，供宿主决定如何展示。
	type AgentSessionRuntimeDiagnostic,
	// cwd 相关基础设施包类型。
	type AgentSessionServices,
	// 现成服务创建会话所需的参数类型。
	type CreateAgentSessionFromServicesOptions,
	// 准备目录服务所需的参数类型。
	type CreateAgentSessionServicesOptions,
	// 服务已存在时创建 AgentSession 的函数。
	createAgentSessionFromServices,
	// 创建模型/设置/资源服务的函数。
	createAgentSessionServices,
	// 重导出直接指向服务模块，不额外包装或调用这些函数。
} from "./agent-session-services.ts";
