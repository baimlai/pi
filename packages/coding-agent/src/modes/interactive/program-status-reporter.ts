// 将交互会话事件投影成终端程序状态，宿主创建本类并转发事件；终端适配器负责协议支持和真正写出，本类不执行任务或对话。
// 只导入终端状态/接口类型，执行JS时擦除；实际终端由构造器回调取得，不在此创建。
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
// 从应用配置取稳定程序名，报告里作为app字段；本模块不读用户问题或模型正文。
import { APP_NAME } from "../../config.ts";
// 事件是会话/Agent扩展的联合类型，switch按type收窄后才能安全访问各事件字段。
import type { AgentSessionEvent } from "../../core/agent-session.ts";

// 索引访问类型取ProgramStatus的可选kind，再由NonNullable去掉undefined/null；这里的阻塞记录要求种类和文字都提供，不实施授权。
export type BlockedStatus = { kind: NonNullable<ProgramStatus["kind"]>; message: string };

// 取错误文字第一行并trim，缺省/首行空白则用Error；例“bad\nstack”得到bad。纯字符串操作，不清洗本行里的其他控制符或敏感文字。
function firstLine(text: string | undefined): string {
	// ?.跳过undefined，正则识别LF/CRLF，split限1项后取首项；||也让trim后的空串回退Error。
	return text?.split(/\r?\n/, 1)[0]?.trim() || "Error";
}

/**
 * Reports interactive-mode state to the terminal (OSC 7501): `working` during agent runs and
 * compaction, `blocked` while a dialog waits for the user, then `done`, `error`, or `idle` once the run
 * settles. Messages are limited to the session name, dialog titles, and the first line of errors; prompts
 * and assistant output are never reported.
 */
// 把交互事件投影成终端状态，优先级是对话阻塞→压缩→运行/静置；不执行Agent或压缩，也不负责判断终端是否支持协议。
export class ProgramStatusReporter {
	// 保存取得当前Terminal的函数，readonly只限制TS重赋字段，调用时才取终端，便于宿主替换。
	private readonly getTerminal: () => Terminal;
	// 保存当前会话名getter，可能返回undefined；会话名本身由宿主决定，没有在此脱敏。
	private readonly getSessionName: () => string | undefined;
	// 初始无运行，正常事件流中agent_start置true、agent_settled置false，reset也会清除；不以单条assistant结束推断整次运行结束。
	private runActive = false;
	// 独立记录压缩是否进行中，即使没有Agent运行也可显示working。
	private compacting = false;
	/** Outcome of the current run, reported once it settles. */
	// 本轮候选结局初始done，后续assistant或压缩事件可覆盖；不会在这里立即对外宣布完成。
	private runResult: ProgramStatus = { state: "done" };
	/** Status while no run is active. */
	// 无运行时展示的状态初始idle，与正在运行的runResult分开保存。
	private restingStatus: ProgramStatus = { state: "idle" };
	/** Open dialogs by source, in the order they opened. The most recent one is reported. */
	// Map按来源名保存对话，保持插入顺序；readonly固定Map引用，但仍能增删条目。
	private readonly blocked = new Map<string, BlockedStatus>();
	// 保存上次报告的JSON文字以去重，不是终端已成功接收的确认。
	private lastReport: string | undefined;

	// 保存终端/会话名getter，不立刻发送；例new ProgramStatusReporter(()=>terminal,()=>session.name)。两个回调若以后抛错，不由本类统一捕获。
	constructor(getTerminal: () => Terminal, getSessionName: () => string | undefined) {
		// 保存第一个函数引用，后面report现取终端。
		this.getTerminal = getTerminal;
		// 保存第二个函数引用，working/done报告时现取名字。
		this.getSessionName = getSessionName;
	}

	// 接收一个会话事件，按状态变化调用report；例start→assistant error→settled最终报告error。未知类型/非assistant消息直接忽略，其他回调或发送错误可同步传播。
	handleEvent(event: AgentSessionEvent): void {
		// 判别联合按event.type分支，TS随case缩窄具体事件；不是重新校验外部JSON。
		switch (event.type) {
			// 开始运行事件只改变运行标记/候选结果，不自动清旧阻塞对话或压缩标记。
			case "agent_start":
				// 记为仍在运行，currentStatus通常会选working。
				this.runActive = true;
				// 新一轮预设成功结局，等后续事件覆盖；此刻仍不会选done对外展示。
				this.runResult = { state: "done" };
				// break离开switch，随后统一report，不退出整个方法。
				break;
			// 单条消息结束时查看assistant的stopReason，用户/工具消息不决定本轮结局。
			case "message_end":
				// The latest response decides the outcome, so a retried error is replaced by its successful retry.
				// 非assistant立即返回，跳过本次report；role判断同时让TS缩窄message类型。
				if (event.message.role !== "assistant") return;
				// 三元表达式给候选结果重新赋值，后来的assistant可替换早先错误。
				this.runResult =
					// 只有stopReason严格为error走错误支；aborted/length/toolUse等本行都走done候选，最终aborted还由settled处理。
					event.message.stopReason === "error"
						? // 错误支携带首行文字，不携带assistant正文；首行仍可能包含敏感信息。
							{ state: "error", message: firstLine(event.message.errorMessage) }
						: // 其他停止原因先记done，不意味整个Agent已完成或没有后续工具调用。
							{ state: "done" };
				// 到共同report，runActive仍true时通常继续显示working。
				break;
			// 开始压缩，不区分manual/threshold/overflow来设置此标记。
			case "compaction_start":
				// 压缩标记true会在无阻塞对话时优先显示压缩文字。
				this.compacting = true;
				// 共同report更新展示，不在此调用模型做摘要。
				break;
			// 结束压缩，按是否仍有Agent运行决定修改哪份结局。
			case "compaction_end":
				// 先清压缩标记，随后才能回到普通运行/静置状态。
				this.compacting = false;
				// 若运行仍活跃，压缩失败只写runResult，最终等settled采用。
				if (this.runActive) {
					// A failed recovery compaction ends the run unless a later response succeeds.
					// 取消优先于错误文字，记idle候选；不证明远端请求或工具已全部停止。
					if (event.aborted) this.runResult = { state: "idle" };
					// 否则只有错误文字为真值才记error；空串不算此分支，成功不主动重置此前结果。
					else if (event.errorMessage) this.runResult = { state: "error", message: firstLine(event.errorMessage) };
					// 无Agent运行且压缩取消时，直接把静置状态设idle。
				} else if (event.aborted) {
					// 该状态稍后report直接可见，但阻塞对话仍可盖住它。
					this.restingStatus = { state: "idle" };
					// 无运行/未取消，仅manual压缩在这里更新静置结局；其他reason维持原静置状态。
				} else if (event.reason === "manual") {
					// 手动压缩的错误文字是否真值决定结局。
					this.restingStatus = event.errorMessage
						? // 失败用首行说明，异常文字未在此自动脱敏。
							{ state: "error", message: firstLine(event.errorMessage) }
						: // 否则手动压缩成功记done，后面可附会话名。
							{ state: "done" };
				}
				// 压缩结果整理完后统一report。
				break;
			// Agent整体结算事件，与一条message_end不同。
			case "agent_settled":
				// 运行标记关闭，后续不再仅因本轮而显示working。
				this.runActive = false;
				// 最终取消则idle，否则采用最近候选结果对象；这里不深复制该对象。
				this.restingStatus = event.aborted ? { state: "idle" } : this.runResult;
				// 统一report结局；仍打开的对话优先显示blocked。
				break;
			// 会话信息变化只触发重新计算，不直接使用事件中的name覆盖getter来源。
			case "session_info_changed":
				// The session name is part of working and done reports.
				// 不改其他状态，离开switch后report会重取会话名。
				break;
			// 没有列出的事件（如turn_start）不影响本报告器。
			default:
				// 直接返回，避免每个无关事件都重新构造状态。
				return;
		}
		// 已处理事件统一走去重发送；report失败可向调用者抛出，没有统一catch。
		this.report();
	}

	/** Report `blocked` for a dialog until it is cleared with `undefined`. Reopening a source replaces it. */
	// 按source登记/清除对话并报告；例setBlocked("login",{kind:"auth",message:"Log in"})覆盖底层working，传undefined解除。只记录显示状态，不打开UI或授权。
	setBlocked(source: string, status: BlockedStatus | undefined): void {
		// 先删除旧来源，随后若重新加入会排到Map末尾，成为最近对话。
		this.blocked.delete(source);
		// 有状态才登记；undefined只删除，消息不按首行裁剪，最终终端formatter另做控制符/字节处理。
		if (status) this.blocked.set(source, status);
		// 立即根据新的最高优先级状态尝试报告。
		this.report();
	}

	/** Forget the previous session's run, for example after switching sessions. */
	// 切会话时重置运行/压缩/静置结局并报告，输入无参数；例done后reset回idle。它不清blocked或lastReport，仍打开的对话可继续覆盖显示。
	reset(): void {
		// 清运行标记，不取消真实Agent执行。
		this.runActive = false;
		// 清压缩标记，不停止真实模型摘要请求。
		this.compacting = false;
		// 为以后运行设done候选。
		this.runResult = { state: "done" };
		// 当前静置设idle，不清对话Map。
		this.restingStatus = { state: "idle" };
		// 按完整优先级发送，若同上次JSON相同仍会去重。
		this.report();
	}

	// 计算当前状态、加app、JSON去重并交终端；无参数/返回。例连续同名working只尝试一次；这里不确认终端协议支持或成功接收。
	report(): void {
		// 浅复制当前状态并覆盖app，类型注解供TS核对，不将消息内容送模型。
		const status: ProgramStatus = { ...this.currentStatus(), app: APP_NAME };
		// JSON.stringify忽略值为undefined的字段，比较的是序列化结果，不是对象引用。
		const key = JSON.stringify(status);
		// 和上次key相同直接返回，也不会重新取/通知可能已替换的Terminal。
		if (key === this.lastReport) return;
		// 先记key再发，终端getter或发送抛错时不回滚；下次相同状态仍可能被去重。
		this.lastReport = key;
		// 现取Terminal并调用其方法；ProcessTerminal按能力标记决定是否实际写OSC，本类本身不直接写stdout，不等终端确认接收。
		this.getTerminal().setProgramStatus(status);
	}

	// 按优先级取当前ProgramStatus，纯读本地状态但可调用会话名getter。例同时compacting和有login时先返回blocked；不检查真实任务/窗口状态。
	private currentStatus(): ProgramStatus {
		// 把Map值复制成数组取最后项，空Map得到undefined；这是读取最近来源，不按时间戳排序。
		const blocked = [...this.blocked.values()].at(-1);
		// 有阻塞则先返回新对象，展开状态提供kind/message；正常类型契约下不会覆盖state。
		if (blocked) return { state: "blocked", ...blocked };
		// 否则压缩优先显示固定working文字，即使runActive为false。
		if (this.compacting) return { state: "working", message: "Compacting context" };
		// 有运行取working字面量，as const避免TS把state扩大为任意string；否则暂取原静置对象引用。
		const status = this.runActive ? { state: "working" as const } : this.restingStatus;
		// working/done才浅复制并用getter会话名覆盖message；undefined序列化时省掉，不保留旧message。
		if (status.state === "working" || status.state === "done") return { ...status, message: this.getSessionName() };
		// idle/error等直接返回原状态，error首行说明保留；调用方report还会浅复制再加app。
		return status;
	}
}
