// 运行工具内部再次发起的工具调用：复用宿主管线/钩子，带父id广播，并把记录与用量汇总到根工具结果。
/**
 * Tool calls that a tool makes while it runs (`ctx.executeTool()`), for example from codemode
 * scripts. The agent loop does not know about them: the session runs each one through the agent's
 * tool pipeline (`runToolCall`) with its own hooks, emits `tool_execution_*` events with
 * `parentToolCallId`, and records the calls and their usage on the model-issued call's tool result
 * message.
 *
 * Nothing here runs until a tool calls `ctx.executeTool()`.
 */

// 从Agent层仅导入工具定义、调用、输出和更新回调类型；真正运行管线由宿主注入。
import type {
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
// AI层提供可序列化记录/用量类型；unknown结果细节不在这里擅自读取结构。
import type { JsonObject, NestedToolCallRecord, NestedToolCalls, TextContent, Usage } from "@earendil-works/pi-ai";
// 嵌套各层的用量按同一辅助合并，不把子调用各自另存成独立会话消息。
import { combineUsage } from "./usage-totals.ts";

/**
 * Limits of the nested-call record on a tool result: arguments
 * over the per-call or total size are omitted, calls beyond the count are dropped, and the record
 * is marked incomplete when any of that happens.
 */
// 这些限制只控制结果消息里保留多少调用记录/参数，不阻止实际继续执行工具。
export const NESTED_CALL_LIMITS = {
	// 同一根调用最多记录256个嵌套调用，超出只丢记录。
	maxCalls: 256,
	// 单项JSON参数UTF-8字节超过8KiB时省略参数正文。
	maxArgumentBytesPerCall: 8 * 1024,
	// 同一记录器保留的参数总字节预算32KiB；已经省略的参数不消耗这份保留预算。
	maxArgumentBytesTotal: 32 * 1024,
	// 错误说明最多保留500个JS码元，不是500字节。
	maxErrorChars: 500,
	// as const保留字面量/只读类型，不在运行时冻结对象。
} as const;

// 默认UTF-8编码器用于计算JSON参数字节数。
const encoder = new TextEncoder();

/** What the nested calls of one model-issued tool call leave on its tool result message. */
// 根工具结束后可转移到其toolResult消息的嵌套摘要。
export interface NestedCallSummary {
	/** Becomes `nestedCalls`. Undefined when no nested call was made. */
	// calls允许undefined，表示没有嵌套记录；部分记录用complete:false另行标记。
	calls: NestedToolCalls | undefined;
	/** Summed `usage` of the nested results, added to the message's `usage`. */
	// 所有已汇报嵌套结果用量的合计，可在没有任何usage时undefined。
	usage: Usage | undefined;
}

/**
 * Collects the nested calls of one model-issued tool call, including calls made by nested tools.
 * The snapshot becomes `nestedCalls` on the tool result message.
 */
/**
 * 收集同一根模型工具调用的全部深度子调用，不负责实际执行工具。
 * 例：根call调用middle，middle又调用leaf，两条子调用共享这一个记录器；start/finish记录状态，addUsage单独累计结果用量。
 */
export class NestedCallRecorder {
	// readonly只固定数组字段引用，内部仍push；private是TS访问限制，不是#运行时私有。
	private readonly calls: NestedToolCallRecord[] = [];
	// Map按记录对象身份保存开始时间，finish后删除。
	private readonly startedAt = new Map<NestedToolCallRecord, number>();
	// 完整性初始true，丢调用/参数后永久变false，未完成项还会在snapshot中单独判断。
	private complete = true;
	// 已保留参数的UTF-8字节累计，不是所有执行过参数的总大小。
	private argumentBytes = 0;
	/** Summed usage of every nested result, including calls dropped from the record. */
	// 用量可包含因记录数量上限被丢掉的调用，所以不能只靠calls重算总费用。
	private usage: Usage | undefined;

	/** Record a call as it starts. Returns undefined when the call is dropped. */
	/**
	 * 开始记录一条调用，返回可供finish更新的记录引用；数量超限返回undefined，但不取消工具。
	 * 例：大参数只保存argumentsBytes并标记不完整；小参数先JSON往返复制为数据。JSON.stringify失败如循环引用会直接抛，不能称为永不失败的日志操作。
	 */
	start(toolCall: AgentToolCall): NestedToolCallRecord | undefined {
		// 先看已保存调用数，超限时连参数序列化都跳过。
		if (this.calls.length >= NESTED_CALL_LIMITS.maxCalls) {
			// 即使不保存该调用，也记住摘要不完整。
			this.complete = false;
			// undefined提示后续finish没有记录可更新。
			return undefined;
		}
		// 初始unfinished，尚不能把开始事件当作执行成功。
		const record: NestedToolCallRecord = { id: toolCall.id, name: toolCall.name, status: "unfinished" };
		// 参数缺省按{}；JSON序列化本身可能执行toJSON或抛错，不是任意JS对象的安全克隆。
		const json = JSON.stringify(toolCall.arguments ?? {});
		// 按序列化文本的UTF-8字节数衡量，中文不能只用json.length。
		const bytes = encoder.encode(json).length;
		// 参数正文超过单项或累计任一预算就省略，等于预算仍允许。
		if (
			// 检查单条上限。
			bytes > NESTED_CALL_LIMITS.maxArgumentBytesPerCall ||
			// 检查加入本条后保留正文的总预算。
			this.argumentBytes + bytes > NESTED_CALL_LIMITS.maxArgumentBytesTotal
		) {
			// 记录原本需要的字节数，方便知道省略规模。
			record.argumentsBytes = bytes;
			// 丢失参数正文也算记录不完整。
			this.complete = false;
		} else {
			// 解析回JSON数据复制参数；as JsonObject只约束后续TS使用，不额外验证对象schema。
			record.arguments = JSON.parse(json) as JsonObject;
			// 只有正文被保留才消耗累计预算。
			this.argumentBytes += bytes;
		}
		// 记录顺序按start调用先后，可能早于实际获得串行执行队列。
		this.calls.push(record);
		// 性能单调时钟记录开始点，后续duration可包含排队时间。
		this.startedAt.set(record, performance.now());
		// 返回同一record供finish原地更新，非只读快照。
		return record;
	}

	/**
	 * 完成一个已保存记录：更新ok/error、计时和可选错误文字；无记录则忽略，返回void。
	 * 例：工具错误文字很长只保留前500码元；这里截文字不做脱敏，不保证内容可公开。
	 */
	finish(record: NestedToolCallRecord | undefined, isError: boolean, errorText: string): void {
		// 超数量限制的调用没有record，不尝试更新别的记录。
		if (!record) return;
		// isError决定状态标签，不通过结果文字猜测成功。
		record.status = isError ? "error" : "ok";
		// 时间差四舍五入为毫秒；开始时间缺失时用本次performance.now兜底，非严格校验同一记录只完成一次。
		record.durationMs = Math.round(performance.now() - (this.startedAt.get(record) ?? performance.now()));
		// 结束后删除开始时间Map项。
		this.startedAt.delete(record);
		// 只有错误且文字非空才写error，slice按JS字符串码元裁剪。
		if (isError && errorText) record.error = errorText.slice(0, NESTED_CALL_LIMITS.maxErrorChars);
	}

	/**
	 * 累计一份已完成工具结果Usage；不返回新摘要，直接更新本记录器状态。
	 * 例：首次直接持有usage引用，第二次才通过combineUsage创建合并对象；调用方须避免把已交来的用量再重复上报。
	 */
	addUsage(usage: Usage): void {
		// 有旧值则合并，无旧值直接采用原引用，不做深拷贝。
		this.usage = this.usage ? combineUsage(this.usage, usage) : usage;
	}

	/**
	 * getter读取当前累计用量或undefined，没有网络/文件副作用。
	 * 例：recorder.totalUsage不加括号；返回引用不因为getter就自动变只读。
	 */
	get totalUsage(): Usage | undefined {
		// 直接返回当前字段，不复制用量对象。
		return this.usage;
	}

	/** Copy of the record so far, or undefined when no nested call was made. */
	/**
	 * 生成当前调用记录快照；完全没嵌套时undefined，丢记录/参数或仍有unfinished项则complete:false。
	 * 只浅复制每条记录，嵌套arguments对象仍共享；例：刚start尚未finish，snapshot已含该调用但不完整。
	 */
	snapshot(): NestedToolCalls | undefined {
		// 只有没有记录且未发生丢弃时才能表示“没调用”；丢完的情况仍需报告不完整。
		if (this.calls.length === 0 && this.complete) return undefined;
		// map+对象展开复制顶层记录，后续finish改status不会改旧快照顶层字段。
		const calls = this.calls.map((call) => ({ ...call }));
		// 既要求没有丢弃，又要求每项都已结束；every空数组为true，但前面complete仍可为false。
		return { calls, complete: this.complete && calls.every((call) => call.status !== "unfinished") };
	}
}

// 一次嵌套执行的可选取消/局部输出配置。
export interface NestedToolCallOptions {
	/** Defaults to the calling tool's signal. */
	// 类型允许不传；本runner只转交options.signal，调用工具默认信号的继承由会话宿主创建上下文时处理。
	signal?: AbortSignal;
	/** Receives partial results of the nested tool, in addition to `tool_execution_update` events. */
	// 除事件广播外再向调用者回传局部结果，类型本身没有保证回调不抛。
	onUpdate?: AgentToolUpdateCallback;
}

/** `tool_execution_*` events of nested calls. */
// 开始/更新/结束的标签联合；parentToolCallId让UI把子事件挂回直接父调用。
export type NestedToolExecutionEvent =
	// 开始事件携带新id、工具名、参数及直接父id；参数保持unknown，非schema通过的承诺。
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; parentToolCallId: string }
	| {
			// 中间结果事件标签。
			type: "tool_execution_update";
			// 本次子调用id。
			toolCallId: string;
			// 工具名。
			toolName: string;
			// 该子调用的参数。
			args: unknown;
			// 局部结果细节unknown，外层只依赖AgentToolResult通用字段。
			partialResult: AgentToolResult<unknown>;
			// 直接父调用id，不一定是最顶层根id。
			parentToolCallId: string;
	  }
	| {
			// 完成事件标签，不在这个类型里自动判断成功。
			type: "tool_execution_end";
			// 结束的子调用id。
			toolCallId: string;
			// 工具名。
			toolName: string;
			// 完整工具结果。
			result: AgentToolResult<unknown>;
			// 宿主管线报告的错误状态。
			isError: boolean;
			// 可选管线耗时，与记录器从start起的耗时来源可能不同。
			durationMs?: number;
			// 直接父id供界面关联。
			parentToolCallId: string;
	  };

// 运行器依赖的最小宿主接口；具体会话提供工具目录、执行管线和事件广播。
export interface NestedToolCallHost {
	/** Tools nested calls resolve against. */
	// 读取嵌套可调用工具的目录；readonly仅限制通过返回类型修改数组。
	getTools(): readonly AgentTool[];
	/** Whether every nested call runs exclusively, as when the agent executes tool calls sequentially. */
	// 是否要求尚未持队列的调用进入独占队列；已持队列子树会跳过再次排队。
	isSequential(): boolean;
	/** Run the call through the tool pipeline, with hooks that report `parentToolCallId`. */
	// 调用宿主工具管线并返回Outcome；信号、钩子和参数schema处理的实际执行在宿主，不由接口声明自动完成。
	runToolCall(
		// 已组装的子toolCall对象。
		toolCall: AgentToolCall,
		// 直接父id，给宿主钩子与事件上下文使用。
		parentToolCallId: string,
		// 可缺取消信号，不在此接口中补默认值。
		signal: AbortSignal | undefined,
		// 宿主可await的局部更新回调，runner会在其中广播更新事件。
		onUpdate: (partialResult: AgentToolResult<unknown>) => Promise<void>,
	): Promise<AgentToolCallOutcome>;
	// 异步广播事件；若宿主拒绝，runner没有总catch吞掉它。
	emit(event: NestedToolExecutionEvent): Promise<void>;
}

/** Calls below one model-issued call share its recorder. */
// 每个调用id对应的范围数据；同一根下共享记录器，各自维护子序号和是否持队列。
interface CallScope {
	// 引用共享的根记录器，不为每层重复计费建独立树。
	recorder: NestedCallRecorder;
	// 该父调用下下一子id的数字后缀，从1递增。
	nextId: number;
	/** Set inside a call that holds the exclusive queue, so its own nested calls do not wait on it. */
	// 已在独占队列中的子树不再排到自己后面，避免递归嵌套等待父项造成死锁。
	holdsQueue: boolean;
}

/**
 * 拼接工具结果中的文本块，供错误摘要使用；不包含图片/其他块。
 * 例：文本a、图像、文本b得到a换行b；只读结果，不在这里检查isError或进行内容脱敏。
 */
function textOf(result: AgentToolResult<unknown>): string {
	// 结果content缺省时用空数组。
	return (
		(result.content ?? [])
			// filter的block is TextContent是类型谓词；判断type后让TS知道后续块有text字段。
			.filter((block): block is TextContent => block.type === "text")
			// map提取各文本块正文。
			.map((block) => block.text)
			// 以换行连接，空文本列表返回空字符串。
			.join("\n")
	);
}

/**
 * 按宿主管线运行嵌套工具，并维护记录/串行队列；不替Agent循环创建新的模型回合。
 * 例：codemode脚本调用工具，事件仍有父id，根工具结果最后通过takeRecord接收这批记录和用量。
 */
export class NestedToolCallRunner {
	// 构造后固定宿主引用，readonly不冻结宿主本身。
	private readonly host: NestedToolCallHost;
	/** Scopes by the id of the calling tool call. */
	// Map既存根调用也存正在执行子调用的范围，便于递归查到共享记录器。
	private readonly scopes = new Map<string, CallScope>();
	/** Serializes nested calls that must not run concurrently. */
	// 独占调用的Promise闸门链；不要求并行工具都入队。
	private queueTail: Promise<void> = Promise.resolve();

	/**
	 * 保存宿主依赖，不在构造时执行工具、注册事件或创建定时器。
	 * 例：new NestedToolCallRunner(host)直到execute才开始创建调用范围。
	 */
	constructor(host: NestedToolCallHost) {
		// 显式字段赋值，未使用需要编译转换的TS参数属性语法。
		this.host = host;
	}

	/**
	 * Run `name` on behalf of the call `callerId`. The nested call gets the id `<callerId>/<n>`.
	 * Never rejects for tool failures: they come back as `isError: true`.
	 */
	/**
	 * 代表callerId运行name(args)，生成子id，记录开始、按需排队、执行宿主管线、记录结果并发结束事件。
	 * 例：call的第一次子调用为call/1，它的第一次子调用为call/1/1，共享根记录器；单根开始时间包含等待队列的时间。
	 * 普通工具失败由宿主包装成isError:true；原英语Never rejects不代表任何异常都吞掉：JSON参数、宿主emit/runToolCall或更新回调抛错仍可能拒绝。队列finally释放，但异常路径未必生成完整结束记录/事件。
	 */
	async execute(
		callerId: string,
		name: string,
		args: unknown,
		options: NestedToolCallOptions = {},
	): Promise<AgentToolCallOutcome> {
		// 按直接父id查范围，未出现过的调用先建立新根范围。
		let scope = this.scopes.get(callerId);
		// 没有范围可能是首次根调用，也可能是调用方已清空/取走后再次使用相同id。
		if (!scope) {
			// 新根带独立记录器、子序号1、尚未持独占队列。
			scope = { recorder: new NestedCallRecorder(), nextId: 1, holdsQueue: false };
			// 保留根范围供下一次同父id子调用和takeRecord使用。
			this.scopes.set(callerId, scope);
		}
		// 构造Agent通用工具调用数据，不直接在此调用工具execute。
		const toolCall: AgentToolCall = {
			// 标签固定toolCall。
			type: "toolCall",
			// 模板字面量生成路径式id；后缀++先取当前数，再把父范围序号加1。
			id: `${callerId}/${scope.nextId++}`,
			// 属性简写保留请求工具名，不因找不到工具就在此提前报错。
			name,
			// null/undefined参数用{}；as仅让类型匹配工具调用契约，真正schema验证在宿主管线。
			arguments: (args ?? {}) as AgentToolCall["arguments"],
		};
		// 开始记时/保存参数发生在排队之前，序列化失败也发生在执行try/finally之前。
		const record = scope.recorder.start(toolCall);
		// 先await开始事件，处理器拒绝会阻止继续执行，当前record可仍unfinished。
		await this.host.emit({
			// 开始事件类型。
			type: "tool_execution_start",
			// 子调用完整id。
			toolCallId: toolCall.id,
			// 显示/钩子使用的工具名。
			toolName: name,
			// 转交同一参数对象引用，不克隆事件数据。
			args: toolCall.arguments,
			// 关联直接父调用。
			parentToolCallId: callerId,
		});

		// 结果始终是boolean；找不到工具时单工具的===条件为false，但宿主全局顺序策略仍可要求入队，不在此验证工具存在。
		const exclusive =
			// 父范围已持队列时不能再次等待它自己的队列尾。
			!scope.holdsQueue &&
			// 宿主整体顺序执行或单个工具声明顺序执行任一成立即可。
			(this.host.isSequential() ||
				// find只为读executionMode；未找到工具最终由宿主管线处理为错误或其契约规定结果。
				this.host.getTools().find((tool) => tool.name === name)?.executionMode === "sequential");
		// 只有入独占队列才会得到释放回调。
		let release: (() => void) | undefined;
		// 独占调用建立新闸门再等前项，保证后来的独占项排在自己后面。
		if (exclusive) {
			// 保存之前的队尾Promise。
			const previous = this.queueTail;
			// 立即把新未完成Promise设为队尾。
			this.queueTail = new Promise((resolve) => {
				// 把resolve作为release供finally放行后继，不在这里立刻调用。
				release = resolve;
			});
			// 等待前一独占项释放，其他无需独占的调用不走这个等待。
			await previous;
		}
		// 执行前把当前子id也登记为父范围，允许它内部再次ctx.executeTool。
		this.scopes.set(toolCall.id, {
			// 继续共享同一个根记录器。
			recorder: scope.recorder,
			// 这个子调用自己的下级序号独立从1起。
			nextId: 1,
			// 自己或祖先已持队列时，后代继承“已有队列”的状态。
			holdsQueue: scope.holdsQueue || exclusive,
		});
		// 结果待宿主管线完成后赋值；异常时不会继续到正常后处理。
		let outcome: AgentToolCallOutcome;
		// 无论管线成功/失败/异常，下面finally都会清当前子范围并释放队列。
		try {
			// 调用宿主的完整工具管线，传直接父id和本次信号，更新回调用async等待事件发送。
			outcome = await this.host.runToolCall(toolCall, callerId, options.signal, async (partialResult) => {
				// 额外更新回调同步调用，不await它的异步尾部；同步抛错会使此async更新回调拒绝。
				options.onUpdate?.(partialResult);
				// 再广播带父id的局部结果事件，await尊重宿主Promise。
				await this.host.emit({
					// 更新事件标签。
					type: "tool_execution_update",
					// 本次子id。
					toolCallId: toolCall.id,
					// 工具名。
					toolName: name,
					// 原参数。
					args: toolCall.arguments,
					// 属性简写附局部结果对象，未复制。
					partialResult,
					// 挂到直接父调用。
					parentToolCallId: callerId,
				});
			});
			// 工具结果返回或异常都会进入清理；不在这里把异常转Outcome。
		} finally {
			// 删除当前子范围，不删除根父范围，后面仍可takeRecord。
			this.scopes.delete(toolCall.id);
			// 有release才调用，放行后继独占项；?.()省略时不做事。
			release?.();
		}

		// 仅正常得到Outcome才完成记录；错误状态来自宿主，文本来自结果中的文本块。
		scope.recorder.finish(record, outcome.isError, textOf(outcome.result));
		// Nested results are not persisted, so their usage is only counted through the recorder.
		// 有用量就计入共享记录器，包含因记录上限被丢掉的调用；宿主应上报本工具自身用量避免重复子树计费。
		if (outcome.result.usage) scope.recorder.addUsage(outcome.result.usage);
		// 正常后处理完成后发送结束事件，事件异常仍会拒绝execute。
		await this.host.emit({
			// 结束标签。
			type: "tool_execution_end",
			// 子调用id。
			toolCallId: toolCall.id,
			// 工具名。
			toolName: name,
			// 完整结果对象引用。
			result: outcome.result,
			// 宿主返回的错误标记。
			isError: outcome.isError,
			// 条件展开只在durationMs非undefined时加字段，显式0也保留。
			...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
			// 直接父id。
			parentToolCallId: callerId,
		});
		// 向调用者返回同一Outcome，不再包装为新对象。
		return outcome;
	}

	/** Remove and return the record of the nested calls a model-issued call made. */
	/**
	 * 取走某调用id范围的当前记录/用量，并从Map删除该范围；找不到则undefined。
	 * 例：根call执行完后调用一次返回摘要，第二次undefined；它不等待仍在运行的子调用，所以调用时机由宿主保证。
	 */
	takeRecord(toolCallId: string): NestedCallSummary | undefined {
		// 先拿范围引用，删除Map后仍可读取这个对象。
		const scope = this.scopes.get(toolCallId);
		// 先删除保证正常后续读取不会重复取同一记录。
		this.scopes.delete(toolCallId);
		// 无范围时不伪造空摘要。
		if (!scope) return undefined;
		// snapshot浅复制记录，totalUsage直接返回当前用量引用；不在此写会话文件。
		return { calls: scope.recorder.snapshot(), usage: scope.recorder.totalUsage };
	}

	/**
	 * 清空范围索引，返回void；不取消已开始的工具、不重置队列闸门或强行释放它。
	 * 例：会话清理时移除可再查询的范围，仍在执行的闭包可能继续持有旧scope，不能把clear当作abort。
	 */
	clear(): void {
		// Map.clear只去掉索引引用，活跃执行的局部引用仍存在。
		this.scopes.clear();
	}
}
