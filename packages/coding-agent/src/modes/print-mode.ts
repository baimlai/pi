// 执行非交互输入：text模式在消息末项恰为assistant时打印其文字，json模式流式发会话事件；多个输入依次await，最后清理运行时并冲刷stdout。
/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

// 两个纯类型分别描述回复与图片；图片数据由上游CLI/宿主准备，这里不解析@file。
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
// 运行时宿主管理当前会话替换/分叉与销毁，本函数不自行重新创建整套服务。
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
// 原始stdout只发结果/协议，写入是排队式的；背压等待与最后冲刷保证追上当前输出链。
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
// 信号退出时清理已跟踪的分离子进程，不代表任意外部远端任务都被终止。
import { killTrackedDetachedChildren } from "../utils/shell.ts";
// 把流式事件的累积快照转换为较小传输形状，避免每个delta重复整个回答。
import { toJsonEvent } from "./json-event.ts";

/**
 * Options for print mode.
 */
// 所有输入均已是文字/图片结构；类型检查不自动校验运行时传入任意JSON。
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	// 字面量联合只允许text/json；这里没有rpc交互命令读取。
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	// 初始输入之后按数组顺序依次提交，每条等待session.prompt完成，不并行启动所有query。
	messages?: string[];
	/** First message to send (may contain @file content) */
	// 初始文字可已包含文件正文；空字符串在下面if中会跳过。
	initialMessage?: string;
	/** Images to attach to the initial message */
	// 只挂到初始输入，后续messages不复用这份图片；没有初始文字时也不会单独发送这些图片。
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
/**
 * 绑定扩展/输出订阅后依次发送初始输入和messages，返回建议进程退出码；真正process.exit通常由外层CLI决定。
 * 例：initialMessage="读文件"、messages=["再总结"]会完成第一轮再发第二轮；text只在消息数组末项恰为assistant时输出该条文本，json持续输出协议事件。
 * text模式末回复error/aborted或length记1；json里的模型error事件本身不在此改exitCode。请求抛错打印文字并返回1。
 * 主try/finally会移信号监听、dispose和flush；更早的绑定回调设置等初始化在try外，且finally自身错误可覆盖原返回结果。
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	// 对象解构并为缺省messages给新空数组，原options本身不修改。
	const { mode, messages = [], initialMessage, initialImages } = options;
	// 局部退出码，只有明确分支改为1，不能把0等同于所有模型/工具任务都业务成功。
	let exitCode = 0;
	// let允许runtimeHost替换会话后重绑定，回调会读取这个最新变量。
	let session = runtimeHost.session;
	// 两种订阅独立清理：对外会话事件与Agent背压等待。
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	// 防重复销毁的本地标志，设置后不因dispose拒绝而自动回滚。
	let disposed = false;
	// 保存精确off闭包，正常结束不留下进程信号监听。
	const signalCleanupHandlers: Array<() => void> = [];

	/** 取消本函数订阅并销毁运行时，重复调用直接返回；例：信号路径与finally都进入时只首次执行。标志在await前设置，不保证第一次失败后会重试清理。 */
	const disposeRuntime = async (): Promise<void> => {
		// 已开始销毁就跳过，不等待另一份销毁Promise完成。
		if (disposed) return;
		// 先标记，以免并发入口重复调用。
		disposed = true;
		// ?.()在订阅尚未建立时什么也不做。
		unsubscribe?.();
		// 移除低层背压监听。
		unsubscribeBackpressure?.();
		// 宿主负责其资源生命周期；异常向外传播，不在这里吞掉。
		await runtimeHost.dispose();
	};

	/** 注册SIGTERM及非Windows的SIGHUP处理，返回void；处理器会清跟踪子进程、尝试dispose后直接退出129/143。这里没有注册SIGINT。 */
	const registerSignalHandlers = (): void => {
		// NodeJS.Signals限制可用信号名字，起始只含SIGTERM。
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		// Windows不额外注册SIGHUP这条路径。
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		// 每个signal用自己的闭包，便于选择退出码与精确取消。
		for (const signal of signals) {
			// 事件回调同步启动清理，不阻塞等它完成。
			const handler = () => {
				// 仅清理程序自己跟踪的分离子进程。
				killTrackedDetachedChildren();
				// finally无论dispose成功/拒绝都请求退出；void不会使清理变同步。
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			// process是全局事件源，生命周期结束时要off。
			process.on(signal, handler);
			// 收集而不是立即执行取消函数。
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	// 在发送任何输入前安装退出信号逻辑。
	registerSignalHandlers();

	// 宿主替换会话后会调用此闭包；rebindSession的const稍后初始化，正常调用时已经定义完成。
	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	/** 绑定当前宿主会话的扩展动作与输出监听，成功返回void；例：扩展切到新会话后重读runtimeHost.session，避免继续订阅旧会话。 */
	const rebindSession = async (): Promise<void> => {
		// 每次都取宿主当前会话，不沿用启动时旧引用。
		session = runtimeHost.session;
		// 等扩展绑定完成再替换本函数的事件订阅。
		await session.bindExtensions({
			// 模式标签供扩展了解宿主能力；不是把print模式变成交互TUI。
			mode: mode === "json" ? "json" : "print",
			// 将扩展命令上下文的会话动作接回宿主/当前会话。
			commandContextActions: {
				// 仅等待当前会话空闲，不主动运行一个query。
				waitForIdle: () => session.waitForIdle(),
				// 新会话要通过runtimeHost管理资源/重绑定，不只new一个SessionManager。
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				// fork对外只需要是否取消，宿主还可能返回选中原文等额外信息。
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				// 树导航直接委托会话，显式转交被支持的几个选项，不整体复制任意字段。
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						// 是否请求分支摘要，可缺省由会话处理。
						summarize: navigateOptions?.summarize,
						// 摘要的追加/替换指令和目标标签分别传递。
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					// 收窄给扩展的动作结果，不把完整宿主结果泄露为新公共契约。
					return { cancelled: result.cancelled };
				},
				// 切持久会话也经过宿主，并返回其取消状态。
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				// 重载当前会话资源；await使绑定调用者知道动作何时结束。
				reload: async () => {
					await session.reload();
				},
			},
			// 扩展错误显示在stderr，避免混进正常text/JSON stdout。
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		// 先移除旧订阅，重绑定不重复打印同一会话事件。
		unsubscribe?.();
		unsubscribeBackpressure?.();
		// 会话事件供外部JSON客户端重建流；text模式也登记这个回调但不输出逐事件内容。
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") {
				// toJsonEvent去累积快照，JSON编码后加一个真实LF作记录分隔。
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
			}
		});
		// 只有JSON模式把低层Agent派发与stdout排队进度联系起来，避免流持续积压。
		unsubscribeBackpressure =
			mode === "json"
				? // async监听让Agent层可以等待当前输出链，非等待远端用户已消费/展示。
					session.agent.subscribe(async () => {
						await waitForRawStdoutBackpressure();
					})
				: // text模式不逐事件输出，故无此监听。
					undefined;
	};

	// 此try包住主要运行流程，但上面的信号安装/重绑定回调登记已经发生。
	try {
		// JSON先输出当前会话头，之后才绑定开始阶段的事件输出。
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			// 有头才发；无头不伪造空对象记录。
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		// 扩展会话启动逻辑和事件订阅先就绪，再发送用户输入。
		await rebindSession();

		// 真值检查意味着空字符串跳过，图片也不会单独提交。
		if (initialMessage) {
			// await一次prompt完成；它内部仍可能有多轮模型/工具调用。
			await session.prompt(initialMessage, { images: initialImages });
		}

		// 多条CLI追加输入串行执行，前一条结束后才发后一条。
		for (const message of messages) {
			await session.prompt(message);
		}

		// text只在全部输入处理后取最终状态，不打印每轮历史回复。
		if (mode === "text") {
			const state = session.state;
			// 仅取数组最后项，不倒序寻找最近assistant；末项非assistant时下面不输出正文。
			const lastMessage = state.messages[state.messages.length - 1];

			// 可选链允许无消息，role标签区分消息种类。
			if (lastMessage?.role === "assistant") {
				// 原代码保留的类型断言，不是运行时另做验证。
				const assistantMsg = lastMessage as AssistantMessage;
				// error/aborted先报错误，不进入打印所有文本的成功路径。
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					// errorMessage空缺/空串时显示stopReason后备提示；不在这里做内容脱敏。
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					// 思考/工具调用等块不当作最终text正文输出。
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							// 每个文本块后追加换行，排到原始stdout链。
							writeRawStdout(`${content.text}\n`);
						}
					}
					// length仍先打印收到的部分文本，再向stderr说明截断并返回失败码。
					if (assistantMsg.stopReason === "length") {
						console.error("Response was truncated: the model reached its output token limit.");
						exitCode = 1;
					}
				}
			}
		}

		// 返回前finally仍要执行；它自身若抛错，这个退出码不会作为成功结果返回。
		return exitCode;
	} catch (error: unknown) {
		// 普通抛出值转可显示文字，不仅限Error；没有在此保存异常堆栈或保证隐藏敏感内容。
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		// 移除本函数安装的信号处理，不移除其他模块的同信号监听。
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		// 先结束运行时，再等待它可能产生的最后输出。
		await disposeRuntime();
		// 冲刷排队协议输出，不等于远端终端已经显示或磁盘fsync。
		await flushRawStdout();
	}
}
