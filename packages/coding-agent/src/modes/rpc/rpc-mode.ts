// RPC服务端把stdin命令、会话流事件和扩展UI交互接在同一JSONL通道上；响应关联id，模型运行完成另看事件。
/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
// 命名空间导入Node crypto，下面用randomUUID为扩展UI交互生成关联id。
import * as crypto from "node:crypto";
// 运行时宿主负责会话替换/分叉/销毁；import type不在此创建宿主。
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
// 扩展UI接口/选项只作编译期契约，下面逐方法适配可通过RPC表达的能力。
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
// stdout控制是运行值：普通日志转stderr，显式原始输出才发协议。
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
// 退出信号处理时清理已跟踪的分离子进程，不是任意远端模型任务的取消证明。
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
// RPC仍给扩展提供当前theme对象作格式化辅助，但不支持TUI主题切换。
import { type Theme, theme } from "../interactive/theme/theme.ts";
// 会话事件去掉流式累积partial，减少传输重复正文。
import { toJsonEvent } from "../json-event.ts";
// 编码/解码只按LF处理记录边界，实际JSON解析在handleInputLine。
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
// 协议类型没有自动生成完整wire校验器，下面as断言也不会校验所有字段。
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";

// 纯类型重导出方便消费者，不因为export type就启动RPC循环。
// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.ts";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
/**
 * 作为JSONL服务端运行：接管stdout、绑定扩展/会话事件、读stdin命令并回关联响应，UI交互也走同一通道。
 * 例：prompt受理返回disposition，后续message_update/message_end/agent_settled再流式发送；连续输入行的异步处理可重叠，不是逐行await命令队列。
 * Promise<never>表示正常不会resolve业务值，EOF/信号/关闭请求最终process.exit；初始化和其他异步操作仍可能拒绝，类型never不代表不能出错。
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	// 修改进程全局stdout.write，普通console.log不再污染协议；本长期模式退出而非恢复原函数。
	takeOverStdout();
	// 当前会话可在new/fork/switch后改变，因此用let并在rebind重新读取。
	let session = runtimeHost.session;
	// 当前会话事件订阅的取消函数。
	let unsubscribe: (() => void) | undefined;
	// 低层Agent输出背压监听的取消函数，和会话订阅分开。
	let unsubscribeBackpressure: (() => void) | undefined;

	/**
	 * 局部协议输出：序列化对象并排入原始stdout链，立即返回void，不等待客户端消费。
	 * 例：output(success(...))只排队一行；需要等待本地写队列时另调用waitForRawStdoutBackpressure。编码错误可同步传出。
	 */
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		// serializeJsonLine负责一个末尾LF，writeRawStdout负责串行写，不重复加换行。
		writeRawStdout(serializeJsonLine(obj));
	};

	/**
	 * 构造成功响应数据，不直接写stdout；泛型T限制command名字为已知协议命令。
	 * 例：cycle_model无候选用data:null，abort无data；data类型未与T一一关联，as RpcResponse依赖各case遵守正确形状，并非运行时schema验证。
	 */
	const success = <T extends RpcCommand["type"]>(
		// 原命令可没有id，JSON编码时undefined字段会省略。
		id: string | undefined,
		// T在编译期保留本次命令名字面量。
		command: T,
		// data可省略或显式null，object不接受普通字符串作为顶层data类型。
		data?: object | null,
	): RpcResponse => {
		// undefined才走省略data，null仍要保留。
		if (data === undefined) {
			// 构造无data成功对象，用断言适配联合契约；不在此验证该命令是否本应带数据。
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		// data存在时保留它，包括null。
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	/**
	 * 构造失败响应，返回RpcResponse，不在这里抛Error或输出。
	 * 例：未知命令仍可保留原command文字与id，success:false让客户端决定如何处理。
	 */
	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		// error属性是可显示文字，没有错误堆栈/内容脱敏保证。
		return { id, type: "response", command, success: false, error: message };
	};

	// Pending extension UI requests waiting for response
	// UI请求id到Promise完成函数的Map，与客户端req_命令id是不同用途。
	const pendingExtensionRequests = new Map<
		// 键是服务端生成的UUID字符串。
		string,
		// 原实现保留any以容纳不同对话返回值；不是wire输入已经校验的声明。本注释任务不改其类型设计。
		{ resolve: (value: any) => void; reject: (error: Error) => void }
		// 创建本次runRpcMode私有Map，不是全局跨进程共享。
	>();

	// Shutdown request flag
	// 扩展请求关闭先置标志，后面命令结束或settled事件检查它。
	let shutdownRequested = false;
	// 关闭流程是否已进入，重复进入会直接process.exit，不再次完整清理。
	let shuttingDown = false;
	// 记录本模式注册的信号off闭包，关闭时逐一取消。
	const signalCleanupHandlers: Array<() => void> = [];

	/** Helper for dialog methods with signal/timeout support */
	/**
	 * 为select/confirm/input建立可取消/超时的UI往返Promise，返回解析后的T或默认值。
	 * 先检查已取消，再分配UUID、登记等待项、发送UI请求；正常响应/取消/超时清监听和Map。例：confirm超时默认false，input取消默认undefined。
	 * 不校验回复value类型/选项成员；parseResponse/output同步抛错不被这里统一转换成默认值，reject句柄只是登记，并未在shutdown里遍历全部待决UI请求拒绝。
	 */
	function createDialogPromise<T>(
		// 可选对话选项含signal/timeout。
		opts: ExtensionUIDialogOptions | undefined,
		// 取消/超时时的结果，可为undefined或false，类型T由调用方推导。
		defaultValue: T,
		// 要发出的method/title/options等请求字段，未知值允许在对象内表示。
		request: Record<string, unknown>,
		// 把UI响应联合转成具体对话返回值的回调，不是通用JSON schema验证器。
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		// 已取消就立即resolve默认值，不登记/发出新的UI请求。
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		// UI UUID用于与外部宿主回复关联。
		const id = crypto.randomUUID();
		// Promise构造器同步安装等待状态，最终完成可由之后stdin响应触发。
		return new Promise((resolve, reject) => {
			// 保存可选超时句柄，便于任一路径清理。
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			// 局部清理：清定时器、退订abort、删除Map，返回void；多次调用允许重复清理，但不撤销已发给宿主的UI文字。
			const cleanup = () => {
				// 有计时器才清，未设置timeout无需额外操作。
				if (timeoutId) clearTimeout(timeoutId);
				// 与下面登记的同一onAbort函数引用匹配。
				opts?.signal?.removeEventListener("abort", onAbort);
				// 使后来的同id回复无法再次命中等待项。
				pendingExtensionRequests.delete(id);
			};

			// 取消回调清资源后resolve默认值，不reject；例：取消输入框可让扩展得到undefined自行决定下一步。
			const onAbort = () => {
				// 先清理避免以后超时/回复重复工作。
				cleanup();
				// Promise接受默认值，不把取消伪装成宿主已输入字符串。
				resolve(defaultValue);
			};
			// 信号存在才加一次性监听；外部abort不会强制让宿主窗口马上关闭。
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			// 真值timeout才启计时器，0不启；这里未验证正整数/全部平台时限范围。
			if (opts?.timeout) {
				// 到时走本地默认结果路径。
				timeoutId = setTimeout(() => {
					// 清等待项和abort监听。
					cleanup();
					// 超时也不是reject。
					resolve(defaultValue);
					// 用原opts.timeout交Node计时器解释。
				}, opts.timeout);
			}

			// 发请求前先登记，避免极快回信没有等待项。
			pendingExtensionRequests.set(id, {
				// 匹配UI回复时由handleInputLine调用这个包装器。
				resolve: (response: RpcExtensionUIResponse) => {
					// 正常响应也先清资源。
					cleanup();
					// 用具体method的解析规则取结果，类型T本身不执行值校验。
					resolve(parseResponse(response));
				},
				// 保存原reject，但本文件关闭流程没有逐条调用它。
				reject,
			});
			// request最后展开，可在JS层覆盖前面字段；当前内部调用者只给method/title等约定数据，不把as当保护。
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	/**
	 * 创建RPC版本的ExtensionUIContext，返回新对象，不绘制本地TUI。
	 * 例：select发extension_ui_request并等回信；setStatus只单向发送；需要TUI组件实例的能力保留空实现/后备值。每次rebind会创建新UI上下文。
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		// 选择框方法把标题/选项/对话选项交通用Promise；例：select("选模型",["a","b"])等待value或undefined。
		select: (title, options, opts) =>
			// 默认结果undefined，timeout也发给宿主作为提示。
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				// 先认取消，再有value就返回；不检查value真是string或在options集合内。
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		// 确认框默认false；例：confirm("继续?","说明")等待confirmed或取消/超时false。
		confirm: (title, message, opts) =>
			// 复用对话生命周期，传method=confirm及正文。
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				// 用in运算区分响应形状，未验证confirmed运行时一定boolean。
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		// 短输入框可给placeholder，取消/超时undefined；例：input("名字","可选提示")不把placeholder当真实预填值。
		input: (title, placeholder, opts) =>
			// 输入标题/占位提示和超时发送给宿主，实际展示由宿主负责。
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				// 有value取value，否则undefined；和select一样没有进一步字段类型校验。
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		// 发送无需回信的通知，返回void；例：notify("已保存","info")只排队，不等UI显示确认。
		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			// 构造通知协议对象，不向pending Map登记。
			output({
				// 统一UI事件标签。
				type: "extension_ui_request",
				// 通知也带UUID用于识别，但没有对应等待Promise。
				id: crypto.randomUUID(),
				// 方法名notify。
				method: "notify",
				// 通知正文属性简写。
				message,
				// 可选级别，undefined会在JSON编码时省略。
				notifyType: type,
				// as仅声明该内部构造符合协议。
			} as RpcExtensionUIRequest);
		},

		// RPC不支持原始终端键盘回调，返回空取消函数以满足接口；例：调用off()也无额外行为。
		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			// 返回函数而非undefined，调用方仍可统一做订阅清理。
			return () => {};
		},

		// 单向更新扩展状态文字，undefined表示删除意图；例：setStatus("job",undefined)在JSON里省略statusText，宿主按协议处理。
		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			// 只发送状态变化，不在本地维护TUI状态组件。
			output({
				// UI请求标签。
				type: "extension_ui_request",
				// 单向通知UUID。
				id: crypto.randomUUID(),
				// 方法名setStatus。
				method: "setStatus",
				// 状态项key。
				statusKey: key,
				// 状态文字可undefined，JSON不会编码JS undefined值本身。
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		// 工作提示文字需要TUI loader，本RPC适配为空实现；例：调用它不会发送任何UI请求，_前缀标明参数故意不用。
		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		// 工作状态可见性在RPC无本地TUI，空实现；例：传false也不修改模型是否运行。
		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported in RPC mode - requires TUI loader access
		},

		// 自定义工作指示器在RPC不支持，空实现；例：不执行options里的TUI构造工厂。
		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported in RPC mode - requires TUI loader access
		},

		// 隐藏思考块标签在RPC无TUI渲染，空实现；例：传标签不会改变JSON中的模型思考内容。
		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		/**
		 * 只转发文字数组/undefined的小部件，忽略组件工厂；例：setWidget("x",["a"])发送文字行，不尝试序列化函数。
		 * content是unknown边界，所以Array.isArray用于实际分流；只验证是数组，没有逐项验证字符串，不把类型断言称为schema检查。
		 */
		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			// undefined可表达移除；其他任意数组也会进入，元素类型未在此验证。
			if (content === undefined || Array.isArray(content)) {
				// 构造单向小部件通知。
				output({
					// 事件标签。
					type: "extension_ui_request",
					// 通知UUID。
					id: crypto.randomUUID(),
					// 方法名setWidget。
					method: "setWidget",
					// 目标部件key。
					widgetKey: key,
					// as string[]不会把数字数组转换为文字数组。
					widgetLines: content as string[] | undefined,
					// 可选位置原样传，缺省由宿主处理。
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		// 自定义页脚工厂依赖TUI，RPC空实现；例：不会执行传入factory或把它发成JSON。
		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		// 自定义页眉同样不在RPC执行/传输工厂。
		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		// 单向请求宿主设置标题，返回void；例：setTitle("任务")不直接对服务端终端输出控制序列。
		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			// 构造标题通知。
			output({
				// UI事件标签。
				type: "extension_ui_request",
				// 通知UUID。
				id: crypto.randomUUID(),
				// 方法名setTitle。
				method: "setTitle",
				// 原标题文字，不在这里做终端转义。
				title,
			} as RpcExtensionUIRequest);
		},

		// 自定义TUI界面在RPC不支持，async实际resolve(undefined)；例：as never只为接口类型适配，不会把undefined变成“运行时永不返回”。
		async custom() {
			// Custom UI not supported in RPC mode
			// 断言不生成值转换或异常，返回值仍是undefined。
			return undefined as never;
		},

		// 把粘贴请求降为设置编辑器文字，不模拟本地粘贴键/历史；例：pasteToEditor("x")转发set_editor_text。
		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			// 普通方法中的this指当前UI上下文对象，复用自己的setEditorText。
			this.setEditorText(text);
		},

		// 单向请求宿主设置编辑器内容，不把文字自动提交给模型；例：setEditorText("待修改")只改外部输入框。
		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			// 构造编辑器文字通知。
			output({
				// UI事件标签。
				type: "extension_ui_request",
				// 通知UUID。
				id: crypto.randomUUID(),
				// wire方法名使用下划线形式。
				method: "set_editor_text",
				// 正文文字。
				text,
			} as RpcExtensionUIRequest);
		},

		// 同步接口无法向宿主发请求并等待，因此固定返回空串；例：不能用它读取外部编辑器当前真实内容。
		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			// 返回后备""，未登记任何等待项。
			return "";
		},

		/**
		 * 请求宿主大编辑器，返回文字或undefined；例：editor("修改", "原文")等value/取消。
		 * 它独立登记Promise，没有使用createDialogPromise的signal/timeout清理；等待项由回信入口删除，不自动因关闭请求逐项reject。
		 */
		async editor(title: string, prefill?: string): Promise<string | undefined> {
			// 创建独立UI UUID。
			const id = crypto.randomUUID();
			// 等待宿主后续输入，不在服务端读取stdin原始终端编辑。
			return new Promise((resolve, reject) => {
				// 发请求前登记完成函数。
				pendingExtensionRequests.set(id, {
					// 收到此id结果后按字段取值，未做完整响应schema校验。
					resolve: (response: RpcExtensionUIResponse) => {
						// 明确取消优先于其他字段。
						if ("cancelled" in response && response.cancelled) {
							// 取消返回undefined。
							resolve(undefined);
							// 有value就取它，不在此验证类型。
						} else if ("value" in response) {
							// resolve宿主给的value。
							resolve(response.value);
						} else {
							// 其他形状后备undefined。
							resolve(undefined);
						}
					},
					// 保存reject但本文件没有统一关机遍历调用。
					reject,
				});
				// 发送标题与可选预填，undefined在JSON中省略。
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		// RPC不组合本地补全提供器，空实现；例：传来的TUI补全配置不会被运行。
		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		// RPC不能安装本地编辑器组件，空实现。
		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		// 查询编辑器组件固定undefined；例：调用方不能据此获得宿主UI对象。
		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			// 显式返回缺组件。
			return undefined;
		},

		// getter提供导入的当前theme引用供扩展格式化；例：ctx.ui.theme不加括号，不表示可通过RPC切主题。
		get theme() {
			// 返回同一theme对象，不深复制。
			return theme;
		},

		// RPC主题目录查询固定空数组；例：getAllThemes()不扫描主题文件。
		getAllThemes() {
			// 每次返回新空数组。
			return [];
		},

		// 按名取主题固定undefined，_name表示未使用。
		getTheme(_name: string) {
			// 不因名称合法就加载主题。
			return undefined;
		},

		// 主题切换固定返回失败结果，不抛也不发UI协议；例：setTheme("dark")得到success:false。
		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			// 普通对象结果声明不支持，不改变当前theme。
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		// 工具展开状态在无TUI的RPC固定false；例：这个值不能反推宿主外部UI的折叠状态。
		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			// 同步后备false。
			return false;
		},

		// 设置工具展开在RPC为空实现，不更改事件传输内容。
		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	// 宿主替换会话后调用重绑定闭包，避免继续用旧session；声明稍后定义，正常调用时const已初始化。
	runtimeHost.setRebindSession(async () => {
		// 等待绑定结束，异常回传宿主。
		await rebindSession();
	});

	/**
	 * 读取宿主当前会话，绑定RPC UI与动作，替换事件/背压订阅，成功返回void。
	 * 例：new_session/fork/switch成功后重新订阅新会话；先await bindExtensions，再退掉旧订阅，绑定失败可能仍保留旧订阅，不宣称原子替换。
	 * 当前成功替换路径中，宿主finishSessionReplacement先调用已注册的重绑定，下面RPC命令case又显式调用一次；因此扩展绑定及其启动/资源发现钩子通常会执行两次。
	 */
	const rebindSession = async (): Promise<void> => {
		// 刷新外层session引用，后面的回调都用它。
		session = runtimeHost.session;
		// 把宿主操作能力交会话扩展系统，不在此重新加载全部服务。
		await session.bindExtensions({
			// 每次构造RPC适配UI。
			uiContext: createExtensionUIContext(),
			// mode标识rpc，扩展可据此选择可用交互方式。
			mode: "rpc",
			// 命令上下文动作接到宿主或当前会话。
			commandContextActions: {
				// 等待会话空闲，不等某个独立RPC响应。
				waitForIdle: () => session.waitForIdle(),
				// 新会话交宿主维护生命周期。
				newSession: async (options) => runtimeHost.newSession(options),
				// 分叉代理只返回扩展接口需要的取消标志。
				fork: async (entryId, forkOptions) => {
					// 等待宿主fork完成。
					const result = await runtimeHost.fork(entryId, forkOptions);
					// 不透传selectedText等其他宿主字段。
					return { cancelled: result.cancelled };
				},
				// 树导航显式转交支持的几项选项，返回取消标志。
				navigateTree: async (targetId, options) => {
					// 调用当前会话导航，不是新建RPC子进程。
					const result = await session.navigateTree(targetId, {
						// 是否生成分支摘要。
						summarize: options?.summarize,
						// 自定义摘要指令。
						customInstructions: options?.customInstructions,
						// 是否替换内置摘要指令。
						replaceInstructions: options?.replaceInstructions,
						// 目标标签。
						label: options?.label,
					});
					// 收窄导航返回值为cancelled。
					return { cancelled: result.cancelled };
				},
				// 切文件会话通过宿主，接收路径与选项。
				switchSession: async (sessionPath, options) => {
					// 原样返回宿主动作结果。
					return runtimeHost.switchSession(sessionPath, options);
				},
				// 重载当前会话资源，等待完成后返回void。
				reload: async () => {
					// 重载的底层副作用/错误按会话层实现。
					await session.reload();
				},
			},
			// 扩展请求退出只设置标志，真正清理在后续检查入口。
			shutdownHandler: () => {
				// 不在这个回调直接process.exit。
				shutdownRequested = true;
			},
			// 扩展错误单独输出extension_error事件，不冒充命令response。
			onError: (err) => {
				// 包含扩展路径/事件/错误文字，不保证错误内容已脱敏。
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		// 移掉之前会话事件监听。
		unsubscribe?.();
		// 移掉之前Agent背压监听。
		unsubscribeBackpressure?.();
		// 登记对外会话事件，输出转换后的传输形状。
		unsubscribe = session.subscribe((event) => {
			// 包括最终message_end等完整事件；message_update会去累积快照。
			output(toJsonEvent(event));
			// settled时也检查扩展是否请求关闭。
			if (event.type === "agent_settled") {
				// 异步关闭检查不await，不阻塞此同步事件回调。
				void checkShutdownRequested();
			}
		});
		// 低层Agent监听等待当前stdout队列，背压可传回流式运行链。
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			// 仅等本地写链，不代表外部宿主已经显示/处理全部事件。
			await waitForRawStdoutBackpressure();
		});
	};

	/**
	 * 注册SIGTERM和非Windows的SIGHUP退出处理；返回void，保存off以便shutdown清理。
	 * 例：SIGHUP退出码129，SIGTERM为143；没有在此注册SIGINT处理器。
	 */
	const registerSignalHandlers = (): void => {
		// 起始仅SIGTERM。
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		// 非Windows才额外注册挂断信号。
		if (process.platform !== "win32") {
			// 向信号数组加SIGHUP。
			signals.push("SIGHUP");
		}

		// 逐信号建立独立handler闭包。
		for (const signal of signals) {
			// 事件handler同步开始清理后启动async shutdown。
			const handler = () => {
				// 先处理自己跟踪的分离子进程。
				killTrackedDetachedChildren();
				// 信号种类传给shutdown，SIGTERM路径刻意不等待flush。
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			// 安装进程全局监听。
			process.on(signal, handler);
			// 保存精确取消函数，不立即调用。
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	// 先完成初次扩展/事件绑定，失败时函数可拒绝且尚未安装下面信号监听。
	await rebindSession();
	// 绑定完成再安装信号处理。
	registerSignalHandlers();

	// Handle a single command
	/**
	 * 处理一个已按RpcCommand使用的对象，返回待输出响应；prompt特例自行异步输出并返回undefined。
	 * 例：get_state马上读快照，compact/Bash/fork可await耗时动作；不同输入行不由这里排全局串行队列。该类型来自wire断言，不代表所有字段已验证，异常由handleInputLine尽力转error。
	 */
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		// 保存原请求id供所有响应关联，不重新分配req序号。
		const id = command.id;

		// 按命令type分流；联合类型帮助TS读取各case的字段，运行时未知type仍可走default。
		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			// prompt采用受理回调回复，不能等完整模型run结束才确认用户输入；也不能受理失败前先发假成功。
			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				// 记录是否已经发过权威受理结果。
				let preflightSucceeded = false;
				// 立即启动会话prompt但不await整个run，避免阻塞接收后续控制输入。
				void session
					// 传入本次用户文字与选项。
					.prompt(command.message, {
						// 图片挂到这条输入。
						images: command.images,
						// 运行中投递策略原样传递。
						streamingBehavior: command.streamingBehavior,
						// source=rpc使输入钩子知道来源。
						source: "rpc",
						// 会话预检查完成时回调，disposition可能started/queued/handled。
						preflightResult: (disposition) => {
							// 先置标志，再发送成功回执，防后续run错误重复发这条输入失败。
							preflightSucceeded = true;
							// 权威受理结果按原请求id输出一次。
							output(success(id, "prompt", { disposition }));
						},
					})
					// 捕获prompt Promise拒绝；已受理后的模型错误由事件协议表现，不重复失败回执。
					.catch((e) => {
						// 只有受理前失败才发response错误。
						if (!preflightSucceeded) {
							// 采用原实现e.message，不保证任意JS抛出值都有message，也无脱敏。
							output(error(id, "prompt", e.message));
						}
					});
				// 告诉handleInputLine本case没有另一个同步response可输出。
				return undefined;
			}

			// 插话通过会话输入钩子，等待受理状态，不承诺立刻打断已在生成的远端token。
			case "steer": {
				// source标记为rpc，携带本条图片。
				const disposition = await session.steer(command.message, command.images, { source: "rpc" });
				// 返回disposition成功回执，稍后由外层编码输出。
				return success(id, "steer", { disposition });
			}

			// 追问也走输入转换/扩展处理路径，不简单假设永远queued。
			case "follow_up": {
				// 等待受理后取得实际状态。
				const disposition = await session.followUp(command.message, command.images, { source: "rpc" });
				// 返回跟随输入的权威disposition。
				return success(id, "follow_up", { disposition });
			}

			// 取消当前会话活动。
			case "abort": {
				// await会话取消流程完成，不是只改本地布尔位。
				await session.abort();
				// 空成功回执，不带data。
				return success(id, "abort");
			}

			// 清两种输入队列并取回被移除文字。
			case "clear_queue": {
				// session.clearQueue同步返回对象，直接作为响应data。
				return success(id, "clear_queue", session.clearQueue());
			}

			// 新会话动作交宿主，不在协议层手工替换SessionManager。
			case "new_session": {
				// 非空parentSession才组对象；空串视为没给来源。
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				// 等宿主动作返回取消状态。
				const result = await runtimeHost.newSession(options);
				// 只有未取消才主动重绑当前session。
				if (!result.cancelled) {
					// 重新读取新会话并更新事件/UI能力。
					await rebindSession();
				}
				// cancelled:true也作为成功响应业务结果返回。
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			// 同步组装get_state快照，不发模型请求。
			case "get_state": {
				// 类型注解检查当前构造所需字段，非运行时序列化验证。
				const state: RpcSessionState = {
					// 当前选择可缺模型。
					model: session.model,
					// 当前思考档位。
					thinkingLevel: session.thinkingLevel,
					// 是否正在流式活动。
					isStreaming: session.isStreaming,
					// 是否正在压缩。
					isCompacting: session.isCompacting,
					// 插话消费策略。
					steeringMode: session.steeringMode,
					// 追问消费策略。
					followUpMode: session.followUpMode,
					// 可选会话文件路径，undefined编码时省略。
					sessionFile: session.sessionFile,
					// 会话id，不是命令请求id。
					sessionId: session.sessionId,
					// 可选显示名。
					sessionName: session.sessionName,
					// 自动压缩开关。
					autoCompactionEnabled: session.autoCompactionEnabled,
					// 当前消息数组长度，非全部原始条目数。
					messageCount: session.messages.length,
					// 会话getter定义的待处理消息数。
					pendingMessageCount: session.pendingMessageCount,
				};
				// 返回完整状态对象。
				return success(id, "get_state", state);
			}

			// =================================================================
			// Model
			// =================================================================

			// 只从当前可用快照精确定位切换目标；CLI的模糊/自定义id回退不在这个RPC分支。
			case "set_model": {
				// 同步读已有可用列表，不主动刷新网络/认证。
				const models = session.modelRuntime.getAvailableSnapshot();
				// 同时严格比较provider/id，不改大小写或做子串。
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				// 找不到就直接构造失败响应，不调用setModel。
				if (!model) {
					// 错误包含请求身份。
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				// 会话还会检查配置认证、记录选择并应用档位规则；此处未传persist，所以不请求保存全局默认。
				await session.setModel(model);
				// 返回实际模型对象，客户端可以声明较小视图。
				return success(id, "set_model", model);
			}

			// 请求默认方向的模型循环。
			case "cycle_model": {
				// 可能返回切换信息或undefined。
				const result = await session.cycleModel();
				// 无可循环结果不作为协议错误。
				if (!result) {
					// 显式data:null保留“没有新模型”。
					return success(id, "cycle_model", null);
				}
				// 有结果就返回模型/档位/范围信息。
				return success(id, "cycle_model", result);
			}

			// 列已有可用快照。
			case "get_available_models": {
				// 不await实时检查。
				const models = session.modelRuntime.getAvailableSnapshot();
				// 套{models}数据对象，即使数组为空也成功。
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			// 设置思考档位，实际按模型能力钳制。
			case "set_thinking_level": {
				// 会话同步更新档位及相应历史，不在这里自己修改模型参数。
				session.setThinkingLevel(command.level);
				// 空成功回执，不回显钳制结果。
				return success(id, "set_thinking_level");
			}

			// 循环当前模型支持档位。
			case "cycle_thinking_level": {
				// 结果可能缺省。
				const level = session.cycleThinkingLevel();
				// 当前模型不支持thinking时会话返回undefined，转成协议null；单档位本身不导致空结果。
				if (!level) {
					// 成功但无新档位。
					return success(id, "cycle_thinking_level", null);
				}
				// 有档位时包装level字段。
				return success(id, "cycle_thinking_level", { level });
			}

			// 读当前模型支持的档位列表。
			case "get_available_thinking_levels": {
				// 不直接返回全局常量的全部档位。
				const levels = session.getAvailableThinkingLevels();
				// 返回{levels}。
				return success(id, "get_available_thinking_levels", { levels });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			// 设置插话消费模式。
			case "set_steering_mode": {
				// 策略变更由会话方法负责。
				session.setSteeringMode(command.mode);
				// 空成功回执。
				return success(id, "set_steering_mode");
			}

			// 设置后续输入消费模式。
			case "set_follow_up_mode": {
				// 这与插话模式是独立设置。
				session.setFollowUpMode(command.mode);
				// 空成功回执。
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			// 手动上下文压缩，等待摘要/扩展接管等完整结果；不在服务端协议层自行拼Topic。
			case "compact": {
				// 传可选自定义摘要指令，实际模型调用在会话压缩层。
				const result = await session.compact(command.customInstructions);
				// 将CompactionResult作为data。
				return success(id, "compact", result);
			}

			// 只切自动压缩开关，不等于立刻执行一次压缩。
			case "set_auto_compaction": {
				// 显式enabled可为false，原样转交。
				session.setAutoCompactionEnabled(command.enabled);
				// 空成功响应。
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			// 设置自动重试开关。
			case "set_auto_retry": {
				// 不在此立即重跑旧请求。
				session.setAutoRetryEnabled(command.enabled);
				// 空成功响应。
				return success(id, "set_auto_retry");
			}

			// 终止重试等待路径。
			case "abort_retry": {
				// 同步请求取消，不是手动发送远端模型HTTP请求。
				session.abortRetry();
				// 空成功响应。
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			// Bash先允许扩展决定结果/后端；扩展钩子失败会由外层报错，不偷偷回本地执行。
			case "bash": {
				// 等待user_bash事件路径，可能返回现成结果或自定义operations。
				const eventResult = await session.extensionRunner.emitUserBash({
					// 事件标签。
					type: "user_bash",
					// 原命令文字，不转成argv数组。
					command: command.command,
					// 缺省false，保留显式false，不把0/字符串当成已验证布尔。
					excludeFromContext: command.excludeFromContext ?? false,
					// 使用会话工作目录，不直接取process.cwd。
					cwd: session.sessionManager.getCwd(),
				});

				// 扩展已给结果时不再重复执行命令。
				if (eventResult?.result) {
					// 仍把该结果记到会话，以便后续上下文/展示一致。
					session.recordBashResult(command.command, eventResult.result, {
						// 是否排除出模型上下文原样传给记录方法。
						excludeFromContext: command.excludeFromContext,
					});
					// 协议success不意味着exitCode一定0，真实执行状态在结果里。
					return success(id, "bash", eventResult.result);
				}

				// 没现成结果才执行；第二参数undefined表示此处不提供逐文字块onChunk回调。
				const result = await session.executeBash(command.command, undefined, {
					// 转发上下文排除选项。
					excludeFromContext: command.excludeFromContext,
					// 原请求id供Bash执行关联。
					id,
					// 扩展可提供远端/容器operations，缺省交会话本地后端。
					operations: eventResult?.operations,
				});
				// 返回完整执行结果对象。
				return success(id, "bash", result);
			}

			// 请求停止会话当前Bash执行。
			case "abort_bash": {
				// 不在此直接枚举杀进程，具体取消由会话负责。
				session.abortBash();
				// 空成功回执。
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			// 读取会话已记录统计。
			case "get_session_stats": {
				// 不请求供应商账单。
				const stats = session.getSessionStats();
				// 返回SessionStats。
				return success(id, "get_session_stats", stats);
			}

			// 导出HTML文件可能有文件I/O。
			case "export_html": {
				// 结果是实际输出路径，不是HTML正文。
				const path = await session.exportToHtml(command.outputPath);
				// 返回{path}。
				return success(id, "export_html", { path });
			}

			// 切另一份持久会话。
			case "switch_session": {
				// 通过宿主管理资源与会话替换。
				const result = await runtimeHost.switchSession(command.sessionPath);
				// 取消时保留原会话绑定。
				if (!result.cancelled) {
					// 未取消重新取当前宿主会话并订阅。
					await rebindSession();
				}
				// 返回业务取消标志。
				return success(id, "switch_session", result);
			}

			// 从指定条目fork。
			case "fork": {
				// 宿主返回选中文本与取消状态。
				const result = await runtimeHost.fork(command.entryId);
				// 仅成功替换时重绑定。
				if (!result.cancelled) {
					// 使后续RPC命令读新session。
					await rebindSession();
				}
				// 把宿主selectedText映射到协议text字段。
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			// 从当前leaf位置克隆活动分支，复用fork(position:at)。
			case "clone": {
				// 先取当前选中条目id。
				const leafId = session.sessionManager.getLeafId();
				// 没有leaf不能凭空指定克隆位置。
				if (!leafId) {
					// 保持原请求id报清晰错误。
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				// position:at包含当前条目位置，区别于普通用户消息前fork的用途。
				const result = await runtimeHost.fork(leafId, { position: "at" });
				// 扩展允许动作才更新绑定。
				if (!result.cancelled) {
					// 重订阅克隆后的当前会话。
					await rebindSession();
				}
				// 克隆协议只返回cancelled，不附选中文本。
				return success(id, "clone", { cancelled: result.cancelled });
			}

			// 供外部宿主展示可分叉用户消息。
			case "get_fork_messages": {
				// 用会话辅助提取条目id/文字。
				const messages = session.getUserMessagesForForking();
				// 返回messages数组，不是整个AgentMessage状态。
				return success(id, "get_fork_messages", { messages });
			}

			// 读取追加顺序条目，可用since做增量拉取。
			case "get_entries": {
				// 局部别名复用同一个当前SessionManager。
				const sessionManager = session.sessionManager;
				// getEntries返回原始历史条目，不限制当前分支。
				let entries = sessionManager.getEntries();
				// 只检查是否undefined，显式空字符串会尝试按id查找。
				if (command.since !== undefined) {
					// 精确查游标，findIndex失败为-1。
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					// 未知游标作为错误，不默默返回全部历史。
					if (sinceIndex === -1) {
						// 错误回显since值。
						return error(id, "get_entries", `Entry not found: ${command.since}`);
					}
					// 排除游标自身，slice产生新外层数组。
					entries = entries.slice(sinceIndex + 1);
				}
				// 同时给当前leafId，便于客户端把追加历史与当前分支关联。
				return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
			}

			// 读完整会话树。
			case "get_tree": {
				// 获取当前管理器引用。
				const sessionManager = session.sessionManager;
				// 返回树节点与leaf，不把所有节点都装进模型上下文。
				return success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
			}

			// 读取最近assistant文字。
			case "get_last_assistant_text": {
				// 会话无文字时实际返回undefined；下一步{text}经JSON编码会省略text，尽管原协议类型声明string|null。
				const text = session.getLastAssistantText();
				// 包装text字段。
				return success(id, "get_last_assistant_text", { text });
			}

			// 设置显示名先清两端空白。
			case "set_session_name": {
				// string类型不保证非空，这里执行实际内容校验。
				const name = command.name.trim();
				// trim后空串拒绝。
				if (!name) {
					// 不是设置成空名后再提示，而是直接返回失败。
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				// 有效名称写入当前会话元数据。
				session.setSessionName(name);
				// 空成功回执。
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			// 读取当前Agent消息状态。
			case "get_messages": {
				// 直接作为data.messages，编码时转成JSON，和entries原始历史不同。
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			// 按扩展→模板→技能拼动态命令元数据；本分支不加入内置命令表，也不再次按enableSkillCommands过滤技能。
			case "get_commands": {
				// 创建本次新数组，不修改已登记命令。
				const commands: RpcSlashCommand[] = [];

				// 局部command遮蔽外层请求变量，只在循环体代表某个扩展命令。
				for (const command of session.extensionRunner.getRegisteredCommands()) {
					// 复制可编码展示元数据，未把handler函数发出去。
					commands.push({
						// 用invocationName而非扩展内部原名，保留命名空间/冲突后的实际调用名。
						name: command.invocationName,
						// 可选描述。
						description: command.description,
						// 来源标签extension。
						source: "extension",
						// 资源来源信息。
						sourceInfo: command.sourceInfo,
					});
				}

				// 模板逐项加到同一列表后面。
				for (const template of session.promptTemplates) {
					// 模板元数据对象。
					commands.push({
						// 模板调用名。
						name: template.name,
						// 模板描述。
						description: template.description,
						// 来源标签prompt。
						source: "prompt",
						// 模板来源。
						sourceInfo: template.sourceInfo,
					});
				}

				// 读取已加载技能元信息；不在这里读取所有技能正文。
				for (const skill of session.resourceLoader.getSkills().skills) {
					// 把技能转换为命令展示项。
					commands.push({
						// 技能命令名带skill:前缀。
						name: `skill:${skill.name}`,
						// 技能描述。
						description: skill.description,
						// 来源标签skill。
						source: "skill",
						// 技能来源元数据。
						sourceInfo: skill.sourceInfo,
					});
				}

				// 返回合并数组，未在本函数统一排序/去重。
				return success(id, "get_commands", { commands });
			}

			// 静态联合之外的wire未知type仍有运行时后备路径。
			default: {
				// as只帮助把未知命令名称读为字符串类型，不是真实形状验证。
				const unknownCommand = command as { type: string };
				// 关联原id返回unknown command失败，不能在错误路径丢请求身份。
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	// 输入取消函数先给空实现，后面IIFE绑定JSONL后替换；上面的原英语概述对应稍后的checkShutdownRequested逻辑。
	let detachInput = () => {};

	/**
	 * 关闭服务端：重复进入直接exit，否则移监听、销毁宿主、停止stdin，按信号选择flush，再退出进程。
	 * 例：EOF正常退出0并flush；SIGTERM退出143且跳过flush。它不会遍历pending UI请求reject，也没有总finally保证dispose抛错后仍执行余下清理。
	 */
	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		// 已开始关闭时直接退出，避免再次等待同一套资源。
		if (shuttingDown) {
			// 立即process.exit并终止当前JS流程。
			process.exit(exitCode);
		}
		// 在第一个await前置标志，后续并发关闭进入短路径。
		shuttingDown = true;
		// 先取消本模式信号监听。
		for (const cleanup of signalCleanupHandlers) {
			// 执行每个保存的off闭包。
			cleanup();
		}
		// 移当前会话事件输出订阅。
		unsubscribe?.();
		// 移Agent背压监听。
		unsubscribeBackpressure?.();
		// 等待宿主关闭钩子，再同步释放/请求取消；不等待所有模型、工具或摘要任务终止，异常可使本函数拒绝而尚未exit。
		await runtimeHost.dispose();
		// 卸载JSONL与stdin结束监听。
		detachInput();
		// 暂停stdin，停止通常的流动数据读取。
		process.stdin.pause();
		// SIGTERM特别跳过flush，其他路径等待当前输出。
		if (signal !== "SIGTERM") {
			// 不是fsync或外部宿主显示确认。
			await flushRawStdout();
		}
		// 返回类型never的正常结束方式是退出进程，不返回一个退出码。
		process.exit(exitCode);
	}

	/**
	 * 若扩展已请求关闭就执行shutdown，否则立即返回；不额外检查session是否idle。
	 * 例：命令处理结束或agent_settled都可触发检查，不能仅凭函数名说它只会等完全空闲才退出。
	 */
	async function checkShutdownRequested(): Promise<void> {
		// 标志未置则无副作用。
		if (!shutdownRequested) return;
		// await关闭通常不会正常返回，失败仍可拒绝。
		await shutdown();
	}

	/**
	 * 处理一条文字记录：JSON解析、优先路由UI回信，否则按命令执行/回复并等当前输出链。
	 * 例：坏JSON返回command=parse失败，不知道原id；UI回信按UUID完成对话，不再回一个普通命令response。多行回调不await本函数，因此可并发进入。
	 * 仅UI类别有粗对象/type检查，其余直接as RpcCommand；不是完整wire schema验证。某些恶意/错误形状如null，可在错误响应再次访问command.id时继续抛，不能承诺任意输入都安全转成error。
	 */
	const handleInputLine = async (line: string) => {
		// 外部JSON先存unknown，不能靠JSON.parse成功就假定是命令对象。
		let parsed: unknown;
		// 此try只包语法解析，UI解析与命令执行各在后面。
		try {
			// 可解析出对象、数组、null、字符串等任意JSON值。
			parsed = JSON.parse(line);
			// 只捕获JSON语法解析失败。
		} catch (parseError: unknown) {
			// 排一条失败响应。
			output(
				// 调用统一错误对象构造器。
				error(
					// 语法坏时无法可靠取id。
					undefined,
					// 用parse作为命令名标识解析层错误。
					"parse",
					// 错误转文字，不在此脱敏。
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			// 解析错误输出也等本地背压。
			await waitForRawStdoutBackpressure();
			// 当前坏行处理结束，其他行仍可进入。
			return;
		}

		// Handle extension UI responses
		// 先识别UI回信，避免误走普通命令switch。
		if (
			// unknown边界先确认object。
			typeof parsed === "object" &&
			// 排除typeof null也是object的情况。
			parsed !== null &&
			// in检查该对象有type字段。
			"type" in parsed &&
			// 只有UI回信标签走这个分支；其他字段没有完整校验。
			parsed.type === "extension_ui_response"
		) {
			// as不验证id/value/confirmed的运行时类型。
			const response = parsed as RpcExtensionUIResponse;
			// 用回信id查待决对话，命令req_序号不应当UI UUID使用。
			const pending = pendingExtensionRequests.get(response.id);
			// 未知或超时后回信无等待项，直接忽略。
			if (pending) {
				// 先删除，避免重复回信再次完成同项。
				pendingExtensionRequests.delete(response.id);
				// 调用对话包装的resolve，它可能进一步清计时器并执行解析回调；这段不在下面命令try内。
				pending.resolve(response);
			}
			// UI回信不生成普通response，也不在这个分支检查shutdownRequested。
			return;
		}

		// 其余解析值按命令类型使用，没有在这里执行全字段schema检查。
		const command = parsed as RpcCommand;
		// 尝试把命令执行异常变成带id/type的失败回执。
		try {
			// 等待该命令的处理，不代表其他输入行被串行锁住。
			const response = await handleCommand(command);
			// prompt返回undefined自行异步受理回复，其他case通常有响应。
			if (response) {
				// 有响应才编码输出。
				output(response);
				// 等这一刻排队的stdout写入追上。
				await waitForRawStdoutBackpressure();
			}
			// 命令处理后检查扩展关闭请求，不另等模型完成。
			await checkShutdownRequested();
			// 仅捕获这个try里的命令/输出/检查异常，不覆盖上面UI回信分支。
		} catch (commandError: unknown) {
			// 尝试输出失败回执，错误对象构造/访问命令字段自身仍可能抛。
			output(
				// 使用统一error形状。
				error(
					// 保留原请求id，前提是command实际可访问该属性。
					command.id,
					// 保留原命令名。
					command.type,
					// 将Error.message或任意抛出值转换文字，无内容脱敏。
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			// 失败回执也等本地写队列。
			await waitForRawStdoutBackpressure();
		}
	};

	/**
	 * stdin结束时启动关闭；不在这里等待每条正在异步处理的命令完成。
	 * 例：调用方关闭输入管道会请求退出，不仅表示“暂时没有新问题”。
	 */
	const onInputEnd = () => {
		// void忽略关闭Promise，拒绝不会由void自动捕获。
		void shutdown();
	};
	// 先注册此end监听，JSONL阅读器稍后也登记自己的end冲刷残段监听。
	process.stdin.on("end", onInputEnd);

	/**
	 * IIFE立即建立JSONL监听并返回组合取消函数，赋给外层detachInput。
	 * 例：shutdown可统一移掉data/end处理；最后无LF残段由JSONL的end回调处理，与先注册的shutdown end监听可能交错，不是“全部命令完成后才关闭”的保证。
	 */
	detachInput = (() => {
		// 给stdin挂增量UTF-8/LF阅读器。
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			// 每行独立启动async处理且不await，输入顺序不等于所有响应完成顺序。
			void handleInputLine(line);
		});
		// 返回精确清理两个来源的闭包。
		return () => {
			// 移除阅读器自己的data/end监听，不关闭stdin文件描述符。
			detachJsonl();
			// 再移本模式的EOF关闭监听。
			process.stdin.off("end", onInputEnd);
		};
		// ()立即执行函数表达式，得到真正取消函数，不把工厂本身存进去。
	})();

	// Keep process alive forever
	// 永不主动resolve/reject的Promise作为长期模式等待；实际存活还依赖stdin等句柄，关闭通过process.exit走另一条路径。
	return new Promise(() => {});
}
