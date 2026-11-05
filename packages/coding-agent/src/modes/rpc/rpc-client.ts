// 以子进程+JSONL驱动Pi：请求响应按id匹配，模型进度另以事件广播；客户端类型不替代跨进程输入校验。
/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

// spawn是运行值，ChildProcess是纯类型；客户端会启动独立node进程，通过三个管道通信。
import { type ChildProcess, spawn } from "node:child_process";
// 消息与思考档位仅作为公共方法的类型契约。
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
// 图片是结构化base64内容，不在客户端方法中读取图片路径。
import type { ImageContent } from "@earendil-works/pi-ai";
// 受理状态和统计复用会话层定义，prompt结果不是最终回答文字。
import type { PromptDisposition, QueuedInputDisposition, SessionStats } from "../../core/agent-session.ts";
// Bash返回执行状态/显示文字，不是远端ChildProcess引用。
import type { BashResult } from "../../core/bash-executor.ts";
// 压缩返回结果结构；真正摘要由子进程会话执行。
import type { CompactionResult } from "../../core/compaction/index.ts";
// 追加条目与会话树数据分别用于不同查询。
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
// 事件类型已去流式累积快照，不等同完整内存事件。
import type { JsonAgentSessionEvent } from "../json-event.ts";
// 这两个是运行时JSONL编码/拆行函数，负责LF与UTF-8边界，不做完整schema验证。
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
// 协议命令/响应纯类型，下面as断言不把外部JSON变成已校验数据。
import type { RpcCommand, RpcResponse, RpcSessionState, RpcSlashCommand } from "./rpc-types.ts";

// ============================================================================
// Types
// ============================================================================

/** Distributive Omit that works with union types */
// 分配式条件类型对联合每项分别Omit指定键；K extends keyof T要求键名在类型允许范围，T extends unknown用于触发逐项分配。
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
// 所有公开方法只传命令正文，id由send统一分配，调用者不能借该类型自行覆盖请求序号。
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

// 子进程启动选项，本构造函数只保存引用，不深复制/冻结。
export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	// 默认实际是相对路径dist/cli.js，不搜索安装目录；相对路径受子进程cwd影响，原英语searches在此不代表自动定位。
	cliPath?: string;
	/** Working directory for the agent */
	// 子进程工作目录，不修改父进程cwd。
	cwd?: string;
	/** Environment variables */
	// 显式环境覆盖合并到父进程环境；Record<string,string>限制编译期键值，不在此校验真实环境。
	env?: Record<string, string>;
	/** Provider to use */
	// 可选供应商参数，真值时加--provider。
	provider?: string;
	/** Model ID to use */
	// 可选模型参数，真值时加--model。
	model?: string;
	/** Additional CLI arguments */
	// 额外argv会追加在内置参数之后，参数冲突交CLI解析，不在此过滤。
	args?: string[];
}

// 客户端消费模型目录时声明的较小视图，服务端实际可能返回更多元数据。
export interface ModelInfo {
	// 供应商身份。
	provider: string;
	// 模型id，与provider共同定位模型。
	id: string;
	// 声明的上下文窗口，不在客户端重新测量。
	contextWindow: number;
	// 模型是否支持思考的元数据。
	reasoning: boolean;
}

// 事件监听器同步返回void；客户端不await异步尾部，一个同步抛错也会被handleLine整体catch截断本次派发。
export type RpcEventListener = (event: JsonAgentSessionEvent) => void;

// ============================================================================
// RPC Client
// ============================================================================

/**
 * 管理RPC子进程、请求id到Promise的匹配，以及事件订阅；不在本进程执行Agent模型循环。
 * 例：start后先onEvent订阅，再await prompt拿受理状态；等待最终回答要看message_end/agent_settled。没有启动就发请求会拒绝。
 */
export class RpcClient {
	// null代表未启动或stop清掉引用，不代表所有旧进程资源一定已经退出。
	private process: ChildProcess | null = null;
	// 取消stdout拆行监听的闭包，stop时调用。
	private stopReadingStdout: (() => void) | null = null;
	// 监听器数组允许同一函数重复注册，和用Set的事件总线不同。
	private eventListeners: RpcEventListener[] = [];
	// Map把请求id关联到两个完成函数；泛型声明不校验收到响应的真实data形状。
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		// 每个客户端实例独立请求表。
		new Map();
	// 单调递增序号，start/stop没有重置它。
	private requestId = 0;
	// 累计stderr文字，重复start不会自动清空这份历史；当前未限制累计大小。
	private stderr = "";
	// 缓存最近进程/管道故障，之后send优先拒绝它。
	private exitError: Error | null = null;
	// 启动配置引用，TypeScript private不是运行时#私有字段。
	private options: RpcClientOptions;

	/**
	 * 保存启动选项，返回新实例；不在构造时启动node或读取CLI文件。
	 * 例：new RpcClient({cliPath:"/repo/dist/cli.js"})后仍需await start()。传入对象后来被修改也会影响本实例读取它。
	 */
	constructor(options: RpcClientOptions = {}) {
		// 直接保存同一options引用，不做深拷贝。
		this.options = options;
	}

	/**
	 * Start the RPC agent process.
	 */
	/**
	 * 拼启动argv，启动PATH中的node，监听stderr/exit/error/stdout，再等100ms检查是否已有退出码。
	 * 例：指定cliPath为本地脚本可测试协议，默认路径不会自动寻找仓库。100ms是短等待，不是服务端握手或模型就绪保证；start失败后也没有在本函数自动stop重置进程引用。
	 */
	async start(): Promise<void> {
		// 只要仍持进程对象就拒绝重复start，即使它已经退出但尚未stop。
		if (this.process) {
			// 抛错前不启动第二个进程。
			throw new Error("Client already started");
		}

		// 清旧exitError，但不清stderr、请求序号或事件监听数组。
		this.exitError = null;

		// ??仅在路径空缺时回退，相对dist/cli.js交子进程按cwd解析。
		const cliPath = this.options.cliPath ?? "dist/cli.js";
		// 固定先进入RPC模式，后面的扩展参数仍可由CLI自行解释。
		const args = ["--mode", "rpc"];

		// 非空供应商才附加对应argv。
		if (this.options.provider) {
			// 两个数组元素保持参数边界，不拼成shell命令。
			args.push("--provider", this.options.provider);
		}
		// 非空模型参数才添加。
		if (this.options.model) {
			// 模型id原样作为独立argv传递。
			args.push("--model", this.options.model);
		}
		// 有额外数组就追加，空数组也合法且不加内容。
		if (this.options.args) {
			// ...展开数组成员，不把整个数组变成一个参数。
			args.push(...this.options.args);
		}

		// 程序名是node而非process.execPath；默认shell:false，CLI路径与参数分开传入。
		const childProcess = spawn("node", [cliPath, ...args], {
			// 子进程cwd可缺省，缺省按Node规则继承。
			cwd: this.options.cwd,
			// 先展开父环境，再用options.env同名覆盖，不在此删除敏感环境变量。
			env: { ...process.env, ...this.options.env },
			// 三个管道分别用来发命令、收协议、收调试输出。
			stdio: ["pipe", "pipe", "pipe"],
		});
		// 保存本次进程对象供回调检查身份，避免旧实例事件影响已经替换的引用。
		this.process = childProcess;

		// Collect stderr for debugging
		// stderr每块到来时即时处理。
		childProcess.stderr?.on("data", (data) => {
			// toString逐块转文字并累加，未使用跨块StringDecoder处理stderr半字符。
			this.stderr += data.toString();
			// 同时把原块转发到父进程stderr，便于直接看到调试/启动错误。
			process.stderr.write(data);
		});

		// exit只处理一次，但退出后没有立刻把this.process置null。
		childProcess.once("exit", (code, signal) => {
			// 旧进程回调不应覆盖另一进程状态，按对象身份跳过。
			if (this.process !== childProcess) return;
			// 构造包含码/信号与stderr的错误，无论退出码是否0，未完成请求都不能再等响应。
			const error = this.createProcessExitError(code, signal);
			// 保存退出故障，让后续send快速拒绝。
			this.exitError = error;
			// 拒绝所有仍等待响应的请求，并清表。
			this.rejectPendingRequests(error);
		});
		// 启动/子进程error也独立监听一次。
		childProcess.once("error", (error) => {
			// 同样避免旧进程事件写回当前状态。
			if (this.process !== childProcess) return;
			// 组合错误文字；没有在这里脱敏stderr。
			const processError = new Error(`Agent process error: ${error.message}. Stderr: ${this.stderr}`);
			// 缓存此故障。
			this.exitError = processError;
			// 让所有等待中的请求失败，而非等30秒超时。
			this.rejectPendingRequests(processError);
		});
		// stdin写管道错误可独立于exit出现，例如EPIPE。
		childProcess.stdin?.on("error", (error) => {
			// 只处理当前进程的管道错误。
			if (this.process !== childProcess) return;
			// 优先保留更早的exitError，防止后续EPIPE掩盖主要退出原因。
			const stdinError =
				// 没有既存故障才新建stdin错误，附累计stderr。
				this.exitError ?? new Error(`Agent process stdin error: ${error.message}. Stderr: ${this.stderr}`);
			// 保存最终错误对象。
			this.exitError = stdinError;
			// 拒绝并清空等待响应的请求。
			this.rejectPendingRequests(stdinError);
		});

		// Set up strict JSONL reader for stdout.
		// stdout按LF逐行读取；!由stdio:pipe配置支持，只是TS非空断言，不生成检查。
		this.stopReadingStdout = attachJsonlLineReader(childProcess.stdout!, (line) => {
			// 每一行转交响应/事件路由器，JSON解析在那边进行。
			this.handleLine(line);
		});

		// Wait a moment for process to initialize
		// 固定等100ms，不发get_state握手，不验证服务端是否已绑定扩展。
		await new Promise((resolve) => setTimeout(resolve, 100));

		// 只检查非null exitCode，不能把它描述为对所有spawn/signal错误的完整就绪判定。
		if (this.process.exitCode !== null) {
			// 有既存错误优先，否则用退出字段构造。
			const error = this.exitError ?? this.createProcessExitError(this.process.exitCode, this.process.signalCode);
			// 保存故障。
			this.exitError = error;
			// start的Promise拒绝，调用者仍需安排后续清理。
			throw error;
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	/**
	 * 取消stdout读取、发SIGTERM，等exit或1秒后尝试SIGKILL再返回，最后清进程引用/请求表。
	 * 例：尚未start时stop直接完成；若已退出但仍持引用，也可能等到1秒定时器。超时发SIGKILL后立即resolve，不承诺内核已确认退出；清表自身不逐项reject，正常exit处理器通常先拒绝未完成请求。
	 */
	async stop(): Promise<void> {
		// 未持进程就不安装计时器。
		if (!this.process) return;

		// 不再读后续stdout，包括可能迟到的响应。
		this.stopReadingStdout?.();
		// 清取消闭包引用。
		this.stopReadingStdout = null;
		// 先请求温和退出，不是进程树终止。
		this.process.kill("SIGTERM");

		// Wait for process to exit
		// Promise在exit事件或宽限期定时器任一触发时完成。
		await new Promise<void>((resolve) => {
			// 安排1秒后强制结束尝试。
			const timeout = setTimeout(() => {
				// 使用当时this.process引用，存在才kill。
				this.process?.kill("SIGKILL");
				// 发送SIGKILL后不再另等exit确认。
				resolve();
				// 宽限期1000ms，不是远端模型任务终止期限。
			}, 1000);

			// 订阅exit；若exit之前已经发生，不能指望再次回放这个事件。
			this.process?.on("exit", () => {
				// 正常观察到退出就取消强制结束定时器。
				clearTimeout(timeout);
				// resolve多次不会重复改变Promise结果。
				resolve();
			});
		});

		// 释放本实例的进程引用，之后允许再次start。
		this.process = null;
		// 仅清Map，不由此清每个请求闭包中的超时计时器；仍存活等待可能之后超时。
		this.pendingRequests.clear();
	}

	/**
	 * Subscribe to agent events.
	 */
	/**
	 * 登记同步事件监听并返回取消函数，不立即回放历史事件。
	 * 例：const off=client.onEvent(e=>...); off()移除首个同引用注册；重复注册相同函数会保留多份。
	 */
	onEvent(listener: RpcEventListener): () => void {
		// push而非Set.add，同一引用可重复出现。
		this.eventListeners.push(listener);
		// 返回闭包捕获listener身份。
		return () => {
			// indexOf找当前第一份相同引用，找不到为-1。
			const index = this.eventListeners.indexOf(listener);
			// 已不存在则取消成为空操作。
			if (index !== -1) {
				// splice原地删一项；派发时读的是数组快照，不因此漏掉本轮后面的监听。
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	/**
	 * 读取本客户端累计stderr字符串，不清空或重新读取子进程。
	 * 例：启动失败后可显示getStderr；这份记录可能含此前start周期内容，当前没有自动截断/脱敏。
	 */
	getStderr(): string {
		// 直接返回当前字符串值，不返回可修改的缓冲对象。
		return this.stderr;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns the prompt's disposition after acceptance; use onEvent() to receive streaming events.
	 * If the disposition is "handled", no run started for this prompt, so don't wait for agent_settled.
	 */
	/**
	 * 发送文字/可选图片与运行中投递策略，返回受理disposition；协议失败经getData抛错。
	 * 例：await prompt("你好")只表示started/queued/handled等受理，最终回答通过onEvent；handled不启动本次run，不能必然等待agent_settled。
	 */
	async prompt(
		// 用户文字，不在这里展开@文件。
		message: string,
		// 可选结构化图片数组。
		images?: ImageContent[],
		// 当前有活动时可指定插话或后续投递；省略交服务端默认处理。
		streamingBehavior?: "steer" | "followUp",
	): Promise<PromptDisposition> {
		// send统一分配id并等待30秒以内的命令响应，不等待模型全文。
		const response = await this.send({ type: "prompt", message, images, streamingBehavior });
		// 先由getData检查success，再从数据对象取disposition；泛型只是类型约定。
		return this.getData<{ disposition: PromptDisposition }>(response).disposition;
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	/**
	 * 发送插话，返回QueuedInputDisposition，失败响应会抛错。
	 * 例：运行中steer("先看测试")可能排队，扩展也可能直接handled；不是立刻替换当前模型正在生成的token。
	 */
	async steer(message: string, images?: ImageContent[]): Promise<QueuedInputDisposition> {
		// 发steer命令并等待它的受理回执。
		const response = await this.send({ type: "steer", message, images });
		// 解包返回受理状态，而非工具/回答内容。
		return this.getData<{ disposition: QueuedInputDisposition }>(response).disposition;
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	/**
	 * 发送追问并返回受理状态，错误响应经getData拒绝。
	 * 例：followUp("再总结")通常排在当前活动之后，仍以实际disposition为准。
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<QueuedInputDisposition> {
		// 协议名follow_up与JS方法followUp不同。
		const response = await this.send({ type: "follow_up", message, images });
		// 从命令数据中读disposition。
		return this.getData<{ disposition: QueuedInputDisposition }>(response).disposition;
	}

	/**
	 * Abort current operation.
	 */
	/**
	 * 请求取消当前活动，等待一份RPC响应后返回void。
	 * 例：await abort()；本方法只await send，没有getData，因此协议success:false不会被此方法自动转换成异常，运输/超时错误仍会拒绝。
	 */
	async abort(): Promise<void> {
		// 忽略响应内容与success字段，保持原实现行为。
		await this.send({ type: "abort" });
	}

	/**
	 * Clear queued steering and follow-up messages, returning their text.
	 */
	/**
	 * 清空插话/追问队列并返回移除的文字，错误响应抛错。
	 * 例：得到{steering:["改方向"],followUp:[]}，不是返回完整图片/消息对象。
	 */
	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		// 发送清队列命令。
		const response = await this.send({ type: "clear_queue" });
		// 按公开返回类型解包data，getData会先检查success。
		return this.getData(response);
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	/**
	 * 请求新会话并返回是否被扩展取消；可提供父会话路径，命令失败抛错。
	 * 例：newSession("/tmp/parent.jsonl")记录来源关系，cancelled:true也是成功响应里的业务结果。
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		// 可选parentSession为undefined时JSON编码省略该字段。
		const response = await this.send({ type: "new_session", parentSession });
		// 解包取消状态，不在本进程自己替换会话。
		return this.getData(response);
	}

	/**
	 * Get current session state.
	 */
	/**
	 * 查询当前会话快照，返回RpcSessionState；通信或失败响应抛错。
	 * 例：getState().model可缺，messageCount不是原始条目总数。
	 */
	async getState(): Promise<RpcSessionState> {
		// 发get_state，不会提交prompt。
		const response = await this.send({ type: "get_state" });
		// 解包快照数据，未做完整运行时schema验证。
		return this.getData(response);
	}

	/**
	 * Set model by provider and ID.
	 */
	/**
	 * 按provider/modelId请求切换，返回至少含provider/id的模型视图；不可用等错误响应会抛错。
	 * 例：setModel("demo","m1")，服务端实际可返回完整模型，多余字段不会在此被裁剪。
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		// 两个身份字段分开发，不用模糊匹配字符串。
		const response = await this.send({ type: "set_model", provider, modelId });
		// 只在类型层声明所需小视图，运行时仍返回同一data对象。
		return this.getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	/**
	 * 请求循环模型，返回新模型/档位/是否范围内，或null；失败响应抛错。
	 * 例：仅一个可循环模型时可能null，不是异常。
	 */
	async cycleModel(): Promise<{
		// 内联返回类型只声明消费所需模型身份，实际可含更多字段。
		model: { provider: string; id: string };
		// 切换后思考档位。
		thinkingLevel: ThinkingLevel;
		// 是否使用配置范围循环。
		isScoped: boolean;
	} | null> {
		// 发无方向字段的cycle_model，使用服务端默认方向。
		const response = await this.send({ type: "cycle_model" });
		// 解包可空结果，不把null自动变成错误。
		return this.getData(response);
	}

	/**
	 * Get list of available models.
	 */
	/**
	 * 读取服务端已有可用模型快照的客户端视图数组，失败响应抛错。
	 * 例：返回[]也合法；不能把调用成功解释为重新联网验证每个模型。
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		// 查询命令不发模型聊天请求。
		const response = await this.send({ type: "get_available_models" });
		// 泛型声明data有models数组，然后取该字段，不在此逐模型验证。
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Set thinking level.
	 */
	/**
	 * 发送思考档位设置并返回void；不解包success，协议失败不会由此自动抛错。
	 * 例：setThinkingLevel("high")，实际钳制后档位可另查getState。
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		// 只等send，不调用getData；运输/超时错误仍拒绝。
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	/**
	 * 循环思考档位，返回{level}或null，错误响应经getData抛错。
	 * 例：模型不支持thinking时null；只有一个支持档位仍可返回该档，不能按数量推断结果为空。
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		// 请求服务端按当前模型能力循环。
		const response = await this.send({ type: "cycle_thinking_level" });
		// 解包可空数据。
		return this.getData(response);
	}

	/**
	 * Get list of available thinking levels for the current model.
	 */
	/**
	 * 列当前模型支持的思考档位，返回数组；失败响应抛错。
	 * 例：只支持off的模型可能只有["off"]，不等于全部全局选项。
	 */
	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		// 发送专门查询命令。
		const response = await this.send({ type: "get_available_thinking_levels" });
		// 解包levels字段。
		return this.getData<{ levels: ThinkingLevel[] }>(response).levels;
	}

	/**
	 * Set steering mode.
	 */
	/**
	 * 设置插话队列一次取全部或逐个取，返回void，不检查响应success。
	 * 例：setSteeringMode("one-at-a-time")只改消费策略，不直接运行队列。
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		// 只await传输回执，保持原有协议失败处理差异。
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	/**
	 * 设置追问队列消费策略，返回void，不解包失败响应。
	 * 例：setFollowUpMode("all")与steering策略互不替代。
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		// 发set_follow_up_mode并忽略响应正文。
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	/**
	 * 请求手动压缩，等待CompactionResult；失败响应抛错，运输默认超时仍是30秒。
	 * 例：compact("保留关键决策")由服务端会话/扩展完成摘要，不在客户端本地压缩。长耗时服务端可能在客户端超时后仍继续。
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		// 把可选自定义指令发给会话压缩路径。
		const response = await this.send({ type: "compact", customInstructions });
		// 解包压缩结果，不只返回一个布尔值。
		return this.getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	/**
	 * 切自动压缩开关，返回void；无getData所以不自动抛协议失败。
	 * 例：false只是配置，不在这里撤回既有摘要。
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		// 发送明确布尔值，false不会被省略。
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	/**
	 * 切自动重试开关，返回void，不解包协议失败。
	 * 例：setAutoRetry(false)不等于自己取消当前执行；取消等待另用abortRetry。
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		// 只发送配置命令。
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	/**
	 * 请求停止重试等待，返回void，不检查协议success。
	 * 例：await abortRetry()不等于模型服务端已终止所有任务。
	 */
	async abortRetry(): Promise<void> {
		// 发送abort_retry，运输/超时仍可抛。
		await this.send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	/**
	 * 在子进程会话执行Bash，返回BashResult，协议错误会抛。
	 * 例：bash("pwd")可能exitCode非零仍有正常结果；这个简化方法没有提供协议excludeFromContext参数。
	 */
	async bash(command: string): Promise<BashResult> {
		// command是完整Bash文字，由服务端/扩展选择实际执行后端。
		const response = await this.send({ type: "bash", command });
		// 解包结果后，调用方仍需自行看exitCode/cancelled/truncated。
		return this.getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	/**
	 * 请求取消Bash，返回void；不解包success:false。
	 * 例：abortBash不在本进程直接杀子进程树，而是发会话命令。
	 */
	async abortBash(): Promise<void> {
		// 只等请求响应。
		await this.send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	/**
	 * 读取会话统计，返回SessionStats，失败响应抛错。
	 * 例：用于显示已记录用量，非向供应商查账单。
	 */
	async getSessionStats(): Promise<SessionStats> {
		// 查询统计命令。
		const response = await this.send({ type: "get_session_stats" });
		// 取data统计对象。
		return this.getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	/**
	 * 请求导出HTML，返回实际文件路径；服务端文件写入/扩展等错误可变失败响应并抛错。
	 * 例：exportHtml("/tmp/chat.html")写的是子进程可访问的路径，不会把HTML内容直接作为结果返回。
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		// 传可选输出路径，缺省交服务端。
		const response = await this.send({ type: "export_html", outputPath });
		// 解包{path}。
		return this.getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	/**
	 * 请求切换会话文件并返回取消状态，失败响应抛错。
	 * 例：switchSession("/tmp/other.jsonl")成功但cancelled:true时当前会话未按动作完成切换。
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		// 发送路径，不在父进程自己打开会话文件。
		const response = await this.send({ type: "switch_session", sessionPath });
		// 返回数据对象而非最终消息列表。
		return this.getData(response);
	}

	/**
	 * Fork from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	/**
	 * 从条目id请求分叉，返回selectedText对应的text及cancelled；失败响应抛错。
	 * 例：fork("entry_1")的条目不是请求req_1。
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		// 由宿主根据历史条目建立新会话。
		const response = await this.send({ type: "fork", entryId });
		// 解包text/cancelled，文字可给宿主编辑器回填。
		return this.getData(response);
	}

	/**
	 * Clone the current active branch into a new session.
	 * @returns Object with `cancelled: true` if an extension cancelled the clone
	 */
	/**
	 * 克隆当前活动分支到新会话，返回是否取消；失败响应抛错。
	 * 例：clone()由服务端读取当前leaf，不需要客户端先查树。
	 */
	async clone(): Promise<{ cancelled: boolean }> {
		// 发送单一clone命令。
		const response = await this.send({ type: "clone" });
		// 解包业务取消状态。
		return this.getData(response);
	}

	/**
	 * Get messages available for forking.
	 */
	/**
	 * 取得适合分叉的用户消息列表，返回条目id/文字数组；失败响应抛错。
	 * 例：UI用entryId供fork定位，显示text供人选择。
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		// 请求服务端提取用户消息。
		const response = await this.send({ type: "get_fork_messages" });
		// 解包messages列表，和getMessages的AgentMessage[]不同。
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get session entries in append order, optionally only those after the `since` entry id.
	 */
	/**
	 * 读全部追加条目或since之后条目，返回entries和当前leafId；未知since的错误响应会抛。
	 * 例：getEntries("e1")排除e1自身，仍可能含其他分支条目，不是只取活动分支模型消息。
	 */
	async getEntries(since?: string): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		// 发送可选游标字符串，未传时省略字段。
		const response = await this.send({ type: "get_entries", since });
		// 泛型精确声明条目数组与可空叶子，运行时未额外验证。
		return this.getData<{ entries: SessionEntry[]; leafId: string | null }>(response);
	}

	/**
	 * Get the session entry tree.
	 */
	/**
	 * 读会话树与当前leafId，失败响应抛错。
	 * 例：返回多分支树不代表每个节点都已包含在当前模型上下文。
	 */
	async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
		// 发送树查询。
		const response = await this.send({ type: "get_tree" });
		// 解包tree/leafId。
		return this.getData<{ tree: SessionTreeNode[]; leafId: string | null }>(response);
	}

	/**
	 * Get text of last assistant message.
	 */
	/**
	 * 读最近assistant文字，原签名声明string|null；错误响应抛错，不触发新的模型生成。
	 * 当前服务端无文字返回undefined并在JSON省略text字段，此方法读取.text实际得到undefined，虽然原签名没有声明它；本学习分支只解释，不顺带改API。
	 */
	async getLastAssistantText(): Promise<string | null> {
		// 查询最后文本。
		const response = await this.send({ type: "get_last_assistant_text" });
		// 只取data.text字段。
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * Set the session display name.
	 */
	/**
	 * 请求设置会话显示名，返回void；不检查失败响应。
	 * 例：name全空白时服务端会发error，但此方法只await send，因此不会自动抛那条协议错误，保持原实现。
	 */
	async setSessionName(name: string): Promise<void> {
		// name原样发送，trim/校验在服务端。
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * Get all messages in the session.
	 */
	/**
	 * 读取当前会话AgentMessage数组，失败响应抛错。
	 * 例：这不是getEntries返回的所有历史元数据条目。
	 */
	async getMessages(): Promise<AgentMessage[]> {
		// 发get_messages查询。
		const response = await this.send({ type: "get_messages" });
		// 解包messages字段。
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get available commands (extension commands, prompt templates, skills).
	 */
	/**
	 * 读取动态命令元数据，返回扩展/模板/技能列表，失败响应抛错。
	 * 例：可据此显示来源和描述；不包含可跨进程调用的JS函数，也非内置命令全集。
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		// 发送get_commands。
		const response = await this.send({ type: "get_commands" });
		// 取data.commands列表。
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_settled event is received.
	 */
	/**
	 * 从订阅建立以后等待下一次agent_settled，默认60秒，超时拒绝；不先查询当前是否已空闲。
	 * 例：如果事件已在调用前发过，本方法不会立即完成，可能一直等到超时。子进程exit不会由此方法直接监听；不能把no streaming旧英语等同于状态即时检查。
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		// 返回等待事件的Promise，不启动一次run。
		return new Promise((resolve, reject) => {
			// 安排超时，和send的30秒命令回执超时独立。
			const timer = setTimeout(() => {
				// 超时先退订，避免未来事件再写这个已拒绝等待。
				unsubscribe();
				// 附累计stderr便于排查；没有取消远端任务。
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
				// 调用者可覆盖timeout，不在此校验数值范围。
			}, timeout);

			// 登记事件回调，unsubscribe闭包正常在之后事件触发时已初始化。
			const unsubscribe = this.onEvent((event) => {
				// 只认agent_settled，agent_end本身不解除等待。
				if (event.type === "agent_settled") {
					// 收到目标事件清超时计时器。
					clearTimeout(timer);
					// 退订这一份监听。
					unsubscribe();
					// 无数据完成Promise。
					resolve();
				}
			});
		});
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	/**
	 * 从现在开始收集所有派发事件，直到含在数组内的第一条agent_settled，默认60秒超时拒绝。
	 * 例：数组不含调用前历史；没有请求id筛选，也不自动对应某个特定prompt，其他活动的结束事件也可使它完成。
	 */
	collectEvents(timeout = 60000): Promise<JsonAgentSessionEvent[]> {
		// Promise控制此次收集的完成/失败。
		return new Promise((resolve, reject) => {
			// 局部事件数组，不与其他collectEvents调用共享。
			const events: JsonAgentSessionEvent[] = [];
			// 独立收集超时。
			const timer = setTimeout(() => {
				// 超时移监听。
				unsubscribe();
				// 抛超时文字，不返回部分事件数组。
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
				// 等待时限由参数控制。
			}, timeout);

			// 订阅期间每条路由来的事件都处理。
			const unsubscribe = this.onEvent((event) => {
				// 先push再判断，因此结束事件也包含在最终数组。
				events.push(event);
				// 只以agent_settled收尾。
				if (event.type === "agent_settled") {
					// 正常收尾取消超时。
					clearTimeout(timer);
					// 移除此次监听，派发快照不会漏掉其他监听器。
					unsubscribe();
					// 返回该局部数组，不深复制消息。
					resolve(events);
				}
			});
		});
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	/**
	 * 先订阅collectEvents再发prompt，避免快速事件发生在订阅前；返回直到settled的事件数组。
	 * 例：普通started输入可收完整事件；当前实现不检查prompt的handled/queued状态，handled没有新run时可能超时。prompt自己拒绝时也没有在此主动取消已创建的收集等待。
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<JsonAgentSessionEvent[]> {
		// 先建立事件Promise，但此时未await，事件会同时开始收集。
		const eventsPromise = this.collectEvents(timeout);
		// 等待输入受理，返回的disposition被忽略。
		await this.prompt(message, images);
		// 再返回/等待收集Promise；两个超时机制彼此独立。
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	/**
	 * 解析一行并按响应id完成请求，否则作为事件派发；返回void，无完整wire schema验证。
	 * 例：未知/迟到response不再有pending项时也落进事件监听；catch不仅忽略坏JSON，也吞掉本轮同步监听器异常并中止余下派发。
	 */
	private handleLine(line: string): void {
		// 整个解析/路由/同步监听循环共享一个try。
		try {
			// JSON.parse可返回任意JS值，后面只是部分字段判断+类型断言。
			const data = JSON.parse(line);

			// Check if it's a response to a pending request
			// 必须response标签、真值id且Map里有等待项才按命令响应处理。
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				// has之后get!只为TS断言非空，不再运行schema验证。
				const pending = this.pendingRequests.get(data.id)!;
				// 先删Map项，防止相同响应重复完成请求。
				this.pendingRequests.delete(data.id);
				// 无论success真/假都resolve(response)，是否转错误由公共方法是否调用getData决定。
				pending.resolve(data as RpcResponse);
				// 本条按响应处理完，不再作为事件重复广播。
				return;
			}

			// Otherwise it's an event. Iterate a snapshot so listeners that unsubscribe during dispatch
			// do not cause later listeners to miss this event.
			// 拷贝监听器数组再遍历，退订不会使本轮后项下标前移漏掉。
			for (const listener of [...this.eventListeners]) {
				// 类型断言不保证data真的是JsonAgentSessionEvent；回调同步执行、不await。
				listener(data as JsonAgentSessionEvent);
			}
			// 捕获范围包含上面所有步骤，未逐监听器隔离，也未打印这次异常。
		} catch {
			// Ignore non-JSON lines
		}
	}

	/**
	 * 构造子进程退出错误文字，返回Error不直接抛；例：code=43与signal=null会同时显示。
	 * 会附累计stderr，不做内容脱敏或自动清空旧启动记录。
	 */
	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		// 模板字符串插入两个可null字段和stderr。
		return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
	}

	/**
	 * 用同一Error拒绝当前全部pending请求，再清表；不通知事件等待器的独立Promise。
	 * 例：进程exit使getCommands尽快拒绝，collectEvents仍可能等自己的60秒时限。
	 */
	private rejectPendingRequests(error: Error): void {
		// 遍历Map值中的包装reject闭包。
		for (const pending of this.pendingRequests.values()) {
			// 包装器会清各自请求超时，再拒绝原Promise。
			pending.reject(error);
		}
		// 完成批量拒绝后清索引引用。
		this.pendingRequests.clear();
	}

	/**
	 * 统一发送一个无id命令：检查进程/管道、分配req_序号、登记30秒超时、JSONL写stdin，等待同id响应。
	 * 例：get_state请求req_1与事件交错到达，handleLine按id找回Promise。响应success:false仍resolve；未连接/退出/写错/超时会reject。
	 * 超时只停止本地等候，不发取消命令；write返回的背压值被忽略，未等待drain。协议数据类型和command关联由调用方约定，非运行时完整校验。
	 */
	private async send(command: RpcCommandBody): Promise<RpcResponse> {
		// 先快照进程引用，后面检查本次对象。
		const childProcess = this.process;
		// 可选链在未启动时得到undefined stdin。
		const stdin = childProcess?.stdin;
		// 无进程或无管道拒绝，避免向null发送。
		if (!childProcess || !stdin) {
			// 命令Promise失败，不是返回RpcResponse错误对象。
			throw new Error("Client not started");
		}
		// 已有缓存故障时快速拒绝。
		if (this.exitError) {
			// 抛同一Error对象，保留退出上下文。
			throw this.exitError;
		}
		// 退出码非null说明已观察到普通退出；signal退出更多依赖exitError。
		if (childProcess.exitCode !== null) {
			// 没有已有缓存故障但发现退出时构造错误。
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			// 保存以便后续请求直接失败。
			this.exitError = error;
			// 当前send拒绝。
			throw error;
		}
		// 管道已销毁或不可写时拒绝，避免盲目登记等待响应。
		if (stdin.destroyed || !stdin.writable) {
			// 管道错误附stderr。
			const error = new Error(`Agent process stdin is not writable. Stderr: ${this.stderr}`);
			// 缓存管道故障。
			this.exitError = error;
			// 不继续创建请求id。
			throw error;
		}

		// 前缀req_加前置++，序号先增再用，首次为req_1。
		const id = `req_${++this.requestId}`;
		// 展开正文后补id，TS断言声明为命令联合，不验证外部内容。
		const fullCommand = { ...command, id } as RpcCommand;

		// 每条请求都有独立Promise和超时句柄。
		return new Promise((resolve, reject) => {
			// 响应未到时30秒后清项并拒绝。
			const timeout = setTimeout(() => {
				// 删除索引，使迟到响应不再命中这条请求。
				this.pendingRequests.delete(id);
				// 超时错误指明命令名和stderr，不自动abort服务端工作。
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
				// 固定30000ms，不使用collectEvents传入的timeout。
			}, 30000);

			// 先登记等待项再写，防止极快子进程响应先于登记。
			this.pendingRequests.set(id, {
				// 正常响应完成的包装器。
				resolve: (response) => {
					// 任意success状态的响应到来都会清超时。
					clearTimeout(timeout);
					// 原始Promise以RpcResponse完成，解包方法再判断业务成功。
					resolve(response);
				},
				// 进程/管道故障完成的包装器。
				reject: (error) => {
					// 拒绝前也清超时。
					clearTimeout(timeout);
					// 原Promise失败。
					reject(error);
				},
			});

			// 仅编码/同步write抛错在此catch中；异步管道error走start中监听。
			try {
				// 序列化一条LF结尾记录，write返回值未读取，无逐请求drain/回调等待。
				stdin.write(serializeJsonLine(fullCommand));
				// 同步编码或写入异常统一处理。
			} catch (error: unknown) {
				// 把非Error抛出值转成Error文字，不做脱敏。
				const writeError = error instanceof Error ? error : new Error(String(error));
				// 找到当前请求的包装器以便清它的超时。
				const pending = this.pendingRequests.get(id);
				// 先从Map删除。
				this.pendingRequests.delete(id);
				// 包装器存在才reject，已经完成的请求不会重复更改Promise状态。
				pending?.reject(writeError);
			}
		});
	}

	/**
	 * 从响应取泛型T数据；失败响应抛Error，成功时只as断言，不检查data真实结构。
	 * 例：getData<{models:ModelInfo[]}>(r)允许下一步.models访问，但服务端若返回错误形状，这个泛型不会在运行时自动修正。原英语safe依赖双方遵守协议。
	 */
	private getData<T>(response: RpcResponse): T {
		// 以success真假分流，不检查command是否与调用方法一致。
		if (!response.success) {
			// Extract从联合取失败分支，断言没有额外验证error字段。
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			// 将服务端错误文字转成调用者可catch的Error。
			throw new Error(errorResponse.error);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		// 成功分支断言为带data的项，实际void响应也可能没有data；正确调用由公共方法约定。
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		// 返回data引用并声明类型T，不做深复制/字段检查。
		return successResponse.data as T;
	}
}
