// /bug的交互流程：逐步收集选择，可选让当前模型写摘要，再上传或写ZIP并记录会话；真正收集/脱敏/打包/网络请求交core helpers，本文件负责串流程与临时输入界面。
// 只用本机路径拼接处理导出文件，不在导入时创建报告。
import * as path from "node:path";
// 宿主组件与TUI只作类型约束，具体界面实例通过context传入。
import type { Container, EditorComponent, TUI } from "@earendil-works/pi-tui";
// 把运行时认证结果取成可用凭据文字，未配置Radius时后面允许匿名上传。
import { getAuthCredential } from "../../cli/auth-command.ts";
// AgentSession类型提供当前模型/消息/设置/会话管理，不在这里创建会话。
import type { AgentSession } from "../../core/agent-session.ts";
// 实际收集与归档入口和纯类型一起导入；下面每项的副作用不同。
import {
	// 标记写入会话的报告投递custom entry类型。
	BUG_REPORT_CUSTOM_ENTRY_TYPE,
	// 报告材料包的静态结构，类型本身不执行脱敏。
	type BugReportBundle,
	// 会话记录数据类型，后面satisfies据此检查字段。
	type BugReportSessionEntryData,
	// 用报告id组成建议ZIP名，不写文件。
	bugReportArchiveFileName,
	// 从全部原始会话条目与崩溃记录选错误诊断，不局限当前分支。
	collectBugReportDiagnostics,
	// 收运行/模型/扩展/设置元数据，部分字段按有限规则脱敏，不保证整个报告所有文字已去秘密。
	collectBugReportMetadata,
	// 把bundle转报告文件并写ZIP；异步写盘失败可拒绝。
	writeBugReportArchive,
} from "../../core/bug-report.ts";
// 真正的multipart POST上传，只有后面upload流程调用才会联网。
import { uploadBugReport } from "../../core/bug-report-upload.ts";
// 读取当前崩溃诊断、成功记录报告后按条件清日志；不是控制程序崩溃的接口。
import { clearCrashLog, readCrashLog } from "../../core/crash-log.ts";
// 给编辑面板处理外部编辑器动作的键位管理器类型。
import type { KeybindingsManager } from "../../core/keybindings.ts";
// Radius网关地址与供应商id，预览地址不代表实际网络认证已通过。
import { getRadiusGatewayUrl, RADIUS_PROVIDER_ID } from "../../core/radius.ts";
// 把当前会话分支序列化成JSONL文字，不在buildBundle这一步写单独会话文件。
import { serializeSessionBranch } from "../../core/session-export.ts";
// 带边框/动画/协作取消signal的等待组件，宿主移除时需dispose停动画。
import { BorderedLoader } from "./components/bordered-loader.ts";
// 输入说明的多行编辑面板，支持宿主配置的外部编辑器动作。
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
// 字符串选项面板，确认/取消通过回调交还结果，不自动管理报告流程。
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
// 给附带的会话尾部加系统提示/工具schema等展示元数据，不调用分享上传流程。
import { createShareTrailingEntries } from "./session-share.ts";
// 当前主题代理给等待动画/面板着色，实际颜色由主题模块决定。
import { theme } from "./theme/theme.ts";

// /bug宿主能力集合，都是已有实例/回调；没有自动复制、落盘或网络验证。
interface BugReportContext {
	// 当前会话，提供材料与可选模型摘要入口。
	session: AgentSession;
	// 转焦点、请求重画用的TUI。
	ui: TUI;
	// 临时面板替换这个编辑区容器的全部孩子，不是TUI的独立overlay栈API。
	editorContainer: Container;
	// 面板结束后放回的原编辑器引用。
	editor: EditorComponent;
	// 应用键位，用于说明输入面板。
	keybindings: KeybindingsManager;
	// 同步状态提示回调，可能抛错，类型void不保证不产生其他宿主副作用。
	showStatus: (message: string) => void;
	// 同步错误提示回调，不由本文件统一catch所有回调异常。
	showError: (message: string) => void;
}

// 多轮选择后得到的内存配置；正常prompt流程只有不附原文时才询问摘要，两布尔类型本身没有表达互斥限制。
interface BugReportOptions {
	// 可选已trim错误线索，空白会变undefined。
	hint?: string;
	// 是否把当前分支原文放入报告，不控制诊断遍历范围。
	includeSession: boolean;
	// 是否调用当前模型生成摘要，生成摘要仍需把选中对话发模型供应商。
	includeSummary: boolean;
	// 字面量联合只允许上传或本地ZIP出口，实际选择在prompt最后一步确定。
	delivery: "upload" | "zip";
}

// &交叉类型表示既是Container又可有dispose方法；它不会为所有组件自动添加dispose。
type Overlay = Container & { dispose?: () => void };

// 展示给用户的用途/接收方说明，字符串本身不执行脱敏；材料限制仍以各collector的实际字段规则为准。
const DISCLAIMER =
	"This report goes to the Pi developers (Earendil) and is not shared publicly. It includes your pi version, operating system, the current model and provider configuration (without API keys), loaded extensions, settings, and provider error diagnostics from this session.";
// 提示原文包括工具读到的文件/命令输出；选择不附原文，不等于诊断里的错误文字也全被清掉。
const TRANSCRIPT_NOTE =
	"The transcript contains your messages, model output, tool calls and their results, including file contents and command output read during this session.";

/** Run the `/bug` flow: consent, optional summary, then upload or export. */
// 串起选择→可选摘要→收材料→上传或ZIP，返回Promise<void>；例不附原文/选摘要/ZIP会调用模型后写本地ZIP。取消/许多失败提示后直接返回，但未覆盖的IO/组件/回调错误仍可拒绝，没有统一事务回滚或重入锁。
export async function reportBug(context: BugReportContext, initialHint?: string): Promise<void> {
	// 等多轮选择完才拿到配置；initialHint只作为说明输入框预填，不自动提交。
	const options = await promptForOptions(context, initialHint);
	// undefined代表其中某轮取消，尚不生成摘要/报告包。
	if (!options) {
		// 提示取消，只说明此流程返回，不取消其他Agent/扩展任务。
		context.showStatus("Bug report cancelled");
		// 结束本次异步流程。
		return;
	}
	// 仅upload检查此离线环境字符串，任意非空（包括false文字）都阻止；ZIP分支不在这里阻止可选模型摘要。
	if (options.delivery === "upload" && process.env.PI_OFFLINE) {
		// 提示用户另选ZIP，本次直接结束，不自动重新打开选择面板。
		context.showError("Uploading bug reports requires online mode. Use Export as Zip instead.");
		// 没有生成报告或发上传请求。
		return;
	}

	// 尚无摘要，用undefined与实际生成的字符串区分。
	let summary: string | undefined;
	// 正常选择流程中仅不附原文时可选择生成摘要。
	if (options.includeSummary) {
		// 创建/挂载可取消动画，构造会启动动画并请求重画；showLoader在下面try之外。
		const loader = showLoader(
			// 传同一个宿主编辑区/界面。
			context,
			// 可选链取当前模型名，缺模型用提示后备文字，不因此替用户选模型。
			`Writing summary with ${context.session.model?.name ?? "the current model"}...`,
		);
		// 仅包模型摘要await，不把所有后续UI操作都纳入统一finally。
		try {
			// AgentSession解析实际模型/认证并调用摘要请求；传信号是协作取消，不直接在本层生成总结文字。
			summary = await context.session.summarizeForBugReport({ hint: options.hint, signal: loader.signal });
			// 捕获此调用的同步错误/Promise拒绝，unknown要求使用前规范化。
		} catch (error: unknown) {
			// 停动画并恢复原编辑器；该恢复自身若抛错，后面的提示/返回也会被中断。
			restoreEditor(context, loader);
			// 信号已取消就按取消提示，不再展示原模型错误；本行没有证明请求已回滚全部副作用。
			if (loader.signal.aborted) context.showStatus("Bug report cancelled");
			// 其他失败只保Error.message，非Error抛值降为Unknown error。
			else context.showError(`Failed to write bug report summary: ${errorMessage(error)}`);
			// 摘要失败不再继续上传/ZIP。
			return;
		}
		// 正常摘要完成也恢复编辑器，dispose只停动画，不把signal改成取消。
		restoreEditor(context, loader);
		// 摘要函数忽略取消但返回成功时，此检查仍丢弃结果，避免继续生成/投递报告。
		if (loader.signal.aborted) {
			// 报告取消状态，不把已得summary当成功报告。
			context.showStatus("Bug report cancelled");
			// 结束当前流程。
			return;
		}
	}

	// 声明将要构造的报告包类型，尚未实际读诊断或创建ZIP。
	let bundle: BugReportBundle;
	// 收集材料可能因设置/日志/序列化异常失败，集中转成宿主错误提示。
	try {
		// 同步读取材料并组对象，原文按选择只序列化当前分支，诊断按全部条目取。
		bundle = buildBundle(context.session, options, summary);
		// 构建失败没有可用bundle，不继续出口步骤。
	} catch (error: unknown) {
		// 只规范错误说明，不自动把所有失败原因或诊断内容脱敏。
		context.showError(`Failed to build bug report: ${errorMessage(error)}`);
		// 结束本次报告流程。
		return;
	}

	// upload尝试完成后，失败才询问是否改为本地ZIP；直接ZIP跳过整个分支。
	if (options.delivery === "upload") {
		// undefined既可表示上传成功，也可表示上传阶段取消；具体状态提示由upload内部完成。
		const failure = await upload(context, bundle);
		// 成功/取消都不继续ZIP，不凭返回void自动判断是成功。
		if (failure === undefined) return;
		// 有失败文字才挂载后备选择面板，不自动重试网络上传。
		const fallback = await choose(
			// 沿用当前宿主。
			context,
			// 面板标题。
			"Upload failed",
			// 候选顺序默认选ZIP，用户仍需通过面板确认。
			["Export as Zip", "Cancel"],
			// 失败文字与后备说明作为UI文本展示，不放进模型提示词。
			`${failure}\n\nExport the report as a zip archive instead?`,
		);
		// 取消/undefined或任何非ZIP返回都结束；没有把字符串自动模糊匹配为选择。
		if (fallback !== "Export as Zip") {
			// 报告后备流程也被取消。
			context.showStatus("Bug report cancelled");
			// 不再写文件。
			return;
		}
	}
	// 直接ZIP或用户确认的失败后备都使用同一bundle/id，不重新调用模型或重收材料。
	await exportZip(context, bundle);
}

// 依次问说明/原文/可选摘要/投递方式，返回选择对象或undefined；例说明留空仍可报告，Esc得到null/undefined后按轮次取消。面板会替换编辑区；这里不执行上传、摘要或持久化，组件/回调错误可拒绝。
async function promptForOptions(
	// 当前会话和界面宿主。
	context: BugReportContext,
	// 参数位置必需但值可undefined，作为第一轮输入的初始值。
	initialHint: string | undefined,
	// Promise包装配置或取消标记，区别于输入框用的null。
): Promise<BugReportOptions | undefined> {
	// 输入说明面板显示现有用途声明与可选问题；空字符串是合法提交，不等于取消。
	const hint = await input(context, "Report a bug", `${DISCLAIMER}\n\nWhat went wrong? (optional)`, initialHint);
	// 只有null表示输入面板取消，空串仍继续下一轮。
	if (hint === null) return undefined;
	// 第二轮明确询问是否附转录原文，await期间不自动读取报告材料。
	const transcript = await choose(
		// 宿主上下文引用不复制。
		context,
		// 面板标题。
		"Include the session transcript?",
		// 确定候选文字，默认首项；选择器本身按键位处理导航/确认。
		["Yes, include the transcript", "No"],
		// 展示工具结果/文件内容等可随原文发送的现有提示。
		TRANSCRIPT_NOTE,
	);
	// choose取消返回undefined，这里真值判断也把空串当取消，正常候选都非空。
	if (!transcript) return undefined;
	// 除严格No外都设true，正常面板只会返回给定两项之一。
	const includeSession = transcript !== "No";
	// 缺省不生成摘要，附原文时不会打开下面的摘要询问。
	let includeSummary = false;
	// 不附原文才给“用模型摘要代替”的选项，两个include并非可任意独立勾选的UI。
	if (!includeSession) {
		// 捕获当前模型用于这一轮说明，后续真正摘要还会从session读取模型。
		const model = context.session.model;
		// 询问是否允许模型总结，文字说明模型供应商仍会收到转录、使用用户凭证/token。
		const summary = await choose(
			// 同一宿主挂载新一轮选择面板。
			context,
			// 缺省名称仅作UI说明，不代表已经选到可调用的模型。
			`Attach a summary written by ${model?.name ?? "the current model"} instead?`,
			// 是/否两项，拒绝摘要也允许继续只交诊断材料。
			["Yes, generate a summary", "No"],
			// 这是现有产品提示，摘要生成时发送选中的对话，最终报告只附生成文字而非session.jsonl。
			`The transcript is sent to ${model?.provider ?? "your provider"} with your credentials and tokens. Only the generated summary is attached; the transcript stays on your machine.`,
		);
		// 此轮取消则整个报告配置取消。
		if (!summary) return undefined;
		// 正常候选No才关闭摘要，未在这里立即发模型请求。
		includeSummary = summary !== "No";
	}
	// 用户描述去首尾空白，说明中的空串在后面会显示none并存undefined。
	const description = hint.trim();
	// 最后一轮选择上传/ZIP/取消；这一步以前尚不生成摘要/报告包。
	const delivery = await choose(
		// 挂载到同一编辑区。
		context,
		// 面板标题。
		"Bug report",
		// 三个固定选项，默认首项Upload仍需要确认输入。
		["Upload Report", "Export as Zip", "Cancel"],
		// 展示描述/附带内容/接收主机；new URL只解析地址，坏网关URL可抛错，预览不访问网络。ZIP写process.cwd而不一定是session cwd。
		`Description: ${description || "none"}\nTranscript: ${includeSession ? "included" : "not included"}\nSummary: ${includeSummary ? `written by ${context.session.model?.name ?? "the current model"}` : "none"}\n\nUpload sends the report to ${new URL(getRadiusGatewayUrl()).host}. Export writes a zip archive to the current directory instead.`,
	);
	// 选择器取消或明确Cancel都返回undefined，不去自动选另一种出口。
	if (!delivery || delivery === "Cancel") return undefined;
	// 返回新选择对象，不保存到SettingsManager。
	return {
		// 空白描述规范为undefined，非空保留trim后的文字。
		hint: description || undefined,
		// 属性简写保存是否附原文。
		includeSession,
		// 属性简写保存是否生成摘要。
		includeSummary,
		// 仅Upload Report映射upload，正常余下候选Export as Zip映射zip；不是按文件扩展名推测。
		delivery: delivery === "Upload Report" ? "upload" : "zip",
	};
}

// 同步组报告包：取扩展→收元数据/全部条目诊断/崩溃→可选当前分支原文及展示尾条；例includeSession=false时没有sessionJsonl，但诊断仍会收集。状态查询/序列化可抛，readCrashLog通常把读文件/解析失败降为[]；不生成摘要、不写ZIP、不上传，不对原文/摘要再统一脱敏。
function buildBundle(session: AgentSession, options: BugReportOptions, summary: string | undefined): BugReportBundle {
	// 取已加载扩展及其错误，不重新加载或执行所有扩展。
	const extensions = session.resourceLoader.getExtensions();
	// 新报告外壳，内部部分数据仍可能共享引用，具体collector有自己的复制规则。
	return {
		// collector挑字段/有限脱敏，不直接序列化整份session。
		metadata: collectBugReportMetadata({
			// 用户说明只trim，不扫描任意正文秘密。
			hint: options.hint,
			// 当前会话id，不是报告id。
			sessionId: session.sessionId,
			// 会话cwd作为材料，只有附原文才进入元信息；不是ZIP输出目录。
			cwd: session.sessionManager.getCwd(),
			// 传递是否附原文，实际原文另在下面组装。
			includeSession: options.includeSession,
			// 以实际已有摘要为准，空串也算存在，不只看用户曾选择的意愿。
			includeSummary: summary !== undefined,
			// 当前有效消息数，不是全部原始树条目数。
			messageCount: session.messages.length,
			// 当前模型可缺省，collector不自动替选模型。
			model: session.model,
			// 提供商配置/认证状态查询能力，collector不导出原始token。
			modelRuntime: session.modelRuntime,
			// 当前思考档位仅作元数据，不在此改变预算。
			thinkingLevel: session.thinkingLevel,
			// 已加载扩展数组交collector挑来源/路径等字段。
			extensions: extensions.extensions,
			// 加载错误文字/路径可能含用户内容，没有全面脱敏保证。
			extensionErrors: extensions.errors,
			// 只读全局设置，交collector按键/URL有限规则处理。
			globalSettings: session.settingsManager.getGlobalSettings(),
			// 同样读项目设置，不修改设置文件。
			projectSettings: session.settingsManager.getProjectSettings(),
		}),
		// 读本机崩溃日志，遍历全部原始条目取异常assistant诊断；错误文字/堆栈仍可能带内容或秘密。
		diagnostics: collectBugReportDiagnostics(session.sessionManager, readCrashLog()),
		// 简写保存摘要原文，undefined时后续不附summary.md。
		summary,
		// 只有附原文才序列化当前分支，不把整棵分支树拼进session.jsonl。
		sessionJsonl: options.includeSession
			? // 回调加系统提示/工具schema等展示尾条，原文不在这里再跑脱敏器。
				serializeSessionBranch(session.sessionManager, (parentId, timestamp) =>
					// 使用序列化器给的parentId/时间接到分支尾部，不调用分享上传流程。
					createShareTrailingEntries(session, parentId, timestamp),
				)
			: // 不附时值undefined，后续清单不会生成会话原文文件。
				undefined,
	};
}

// 上传已有bundle，返回失败文字，成功/取消均返回undefined；例没Radius provider可匿名。动画→认证→POST→恢复/写会话记录/提示，可能联网和落盘；成功后的本地记录/提示也在catch范围，失败不会撤回远端报告。
async function upload(context: BugReportContext, bundle: BugReportBundle): Promise<string | undefined> {
	// 构造/挂载loader在try外，这阶段抛错不走下面恢复逻辑。
	const loader = showLoader(context, "Uploading bug report...");
	// 保护认证、上传和成功后的本地操作，不仅是fetch。
	try {
		// 有provider配置不等于已登录或凭据有效。
		const provider = context.session.modelRuntime.getProvider(RADIUS_PROVIDER_ID);
		// 有provider才尝试取认证，否则token缺省让helper匿名上传。
		const token = provider
			? // 从解析后的认证对象提取可用凭据字符串。
				getAuthCredential(
					// OAuth至少还有效5分钟；getAuth可刷新，这里没传loader.signal，不保证取消立即停认证等待。
					await context.session.modelRuntime.getAuth(RADIUS_PROVIDER_ID, { minOAuthValidityMs: 5 * 60_000 }),
				)
			: // 未配置provider仍可匿名，不在这里自动打开登录面板。
				undefined;
		// 真正multipart POST，await服务端结果，signal仅协作取消，不回滚已发送内容。
		const result = await uploadBugReport(bundle, { token, signal: loader.signal });
		// 正常返回先恢复编辑器，本成功路径没有额外查loader.signal.aborted。
		restoreEditor(context, loader);
		// 追加bundle元数据，失败不会撤回已上传报告。
		recordInSession(context.session, bundle, { delivery: "upload" });
		// 展示服务端返回id，没有核实它与bundle.metadata.id完全一致。
		context.showStatus(`Bug report uploaded. Report ID: ${result.id}`);
		// undefined让上层结束，不进入ZIP后备。
		return undefined;
		// 成功后的会话记录/提示异常也可能到此，不一定代表网络上传未成功。
	} catch (error: unknown) {
		// 可再次恢复，dispose/宿主回调若抛仍可让本方法拒绝。
		restoreEditor(context, loader);
		// 已取消则按取消提示，不把失败原因交上层询问ZIP。
		if (loader.signal.aborted) {
			// 只提示流程取消，不证明网关未收到先前请求。
			context.showStatus("Bug report cancelled");
			// 同样用undefined终止上层流程。
			return undefined;
		}
		// 非取消错误转文字，上层可询问导出同一bundle。
		return errorMessage(error);
	}
}

// 将bundle写当前进程cwd的ZIP后记录/提示，返回Promise<void>；例id=abc得到pi-bug-report-abc.zip。只写本地、不上传；写档失败提示返回，之后会话记录/提示失败仍可拒绝，已写文件不自动回滚。
async function exportZip(context: BugReportContext, bundle: BugReportBundle): Promise<void> {
	// 用process.cwd而非会话cwd，报告id拼建议文件名；路径计算在try外。
	const archivePath = path.join(process.cwd(), bugReportArchiveFileName(bundle.metadata.id));
	// 这里只保护归档写文件，不含后面的会话记录/提示。
	try {
		// ZIP helper会序列化/压缩/写路径，本层没另做覆盖确认、原子改名或传取消signal。
		await writeBugReportArchive(bundle, archivePath);
		// 捕获归档IO/序列化等失败，未覆盖所有后续步骤。
	} catch (error: unknown) {
		// 错误只提规范说明，不把失败说成已导出成功。
		context.showError(`Failed to write bug report: ${errorMessage(error)}`);
		// 写失败后不追加成功投递记录。
		return;
	}
	// ZIP已写完再记会话元信息，记录失败传播时文件可能已存在。
	recordInSession(context.session, bundle, { delivery: "zip", path: archivePath });
	// 展示输出路径和bundle报告id；换行保留原格式，不返回路径值。
	context.showStatus(`Bug report exported to: ${archivePath}\nReport ID: ${bundle.metadata.id}`);
}

// 追加投递元数据后按条件清崩溃日志，无返回；例ZIP记录附path，不存整份bundle或摘要正文。会话追加可抛，清日志尽力删除并吞掉文件删除错误；二者非原子，也不撤回网络报告。默认日志路径求值在helper的try外。
function recordInSession(
	// 当前会话，写入通过其SessionManager。
	session: AgentSession,
	// 读取已投递材料的id/时间/包含标记/崩溃数。
	bundle: BugReportBundle,
	// Pick提取delivery/path的TS结构且保留path可选性，不在运行时过滤额外键。
	delivery: Pick<BugReportSessionEntryData, "delivery" | "path">,
): void {
	// 追加custom entry会改变会话历史/可能落盘，不是模型可见普通用户消息。
	session.sessionManager.appendCustomEntry(BUG_REPORT_CUSTOM_ENTRY_TYPE, {
		// 使用bundle报告id，不重新生成。
		id: bundle.metadata.id,
		// 保存构建时间，不另取投递完成时刻。
		createdAt: bundle.metadata.createdAt,
		// 说明可null，未在此二次脱敏。
		hint: bundle.metadata.hint,
		// 只存附原文标记，不再序列化消息。
		sessionIncluded: bundle.metadata.session.included,
		// 只存附摘要标记，不把摘要正文放此条目。
		summaryIncluded: bundle.metadata.session.summaryIncluded,
		// 出口/path后展开可覆盖同名键，当前调用方只给约定字段。
		...delivery,
		// satisfies只做TS兼容检查并保留推断类型，不生成运行时验证或复制。
	} satisfies BugReportSessionEntryData);
	// bundle含崩溃就清当前日志，不按id逐条删除；收材料后新增记录也可能受清理影响。
	if (bundle.diagnostics.crashes.length > 0) clearCrashLog();
}

// 挂载输入面板并等文字或取消null；例空串是提交，null才取消。构造/挂载同步错误在Promise执行器内可变拒绝，未来按键回调的恢复错误不由它统一catch；没有重入完成锁/超时，不执行模型/上传。
function input(
	// 宿主提供原编辑器/键位/会话设置。
	context: BugReportContext,
	// 输入面板标题文字。
	title: string,
	// 普通UI说明，不是模型提示词。
	description: string,
	// 可选预填，不自动提交。
	initialValue?: string,
): Promise<string | null> {
	// 执行器立即建回调/组件，resolve以后由用户动作调用，不阻塞线程等按键。
	return new Promise((resolve) => {
		// 先声明供闭包捕获，正常组件构造不会在赋值前提交。
		let component: ExtensionEditorComponent;
		// 提交/取消共用收尾，先恢复再resolve；恢复抛错则本次resolve到不了。
		const finish = (value: string | null) => {
			// 无dispose时跳过，但仍恢复原编辑区与焦点。
			restoreEditor(context, component);
			// Promise只首次结算，多次finish仍会先重复恢复副作用。
			resolve(value);
		};
		// 新建多行输入面板，外部编辑器仅后续触发相应动作时启动。
		component = new ExtensionEditorComponent(
			// 组件的已有TUI宿主。
			context.ui,
			// 应用键位管理器引用。
			context.keybindings,
			// 展示标题。
			title,
			// 预填字符串或undefined。
			initialValue,
			// 提交回传Editor整理后的文字，空串也保留。
			(value) => finish(value),
			// 取消明确传null，区别正常空串提交。
			() => finish(null),
			// 属性简写传说明配置。
			{ description },
			// 读取外部编辑器命令配置，不在本行执行命令。
			context.session.settingsManager.getExternalEditorCommand(),
		);
		// 替换编辑区并聚焦，等待用户动作结算Promise。
		showOverlay(context, component);
	});
}

// 挂载候选面板，返回选中文字或取消undefined；例Yes/No默认首项但仍需确认。保留原数组/回调，恢复先于结算；构造/挂载异常可拒绝，未来回调错误不统一兜底，不保存设置或发送报告。
function choose(
	// 沿用同一宿主。
	context: BugReportContext,
	// 候选面板标题。
	title: string,
	// 字符串候选数组，不要求名字唯一。
	options: string[],
	// 可选说明，真值时显示。
	description?: string,
): Promise<string | undefined> {
	// 异步等用户动作，执行器同步建立组件。
	return new Promise((resolve) => {
		// 先声明供收尾闭包捕获，挂载前完成赋值。
		let component: ExtensionSelectorComponent;
		// 选择传文字，取消不传值；无完成锁，恢复可重复执行。
		const finish = (value?: string) => {
			// dispose停可选倒计时；本次没传timeout，通常没有该timer。
			restoreEditor(context, component);
			// 原所选文字/undefined直接结算，不模糊匹配或规范化。
			resolve(value);
		};
		// finish作确认、无参finish作取消；构造不自动确认首项。
		component = new ExtensionSelectorComponent(title, options, finish, () => finish(), {
			// 传已有UI，不创建真实终端。
			tui: context.ui,
			// 可选说明属性简写。
			description,
		});
		// 挂载后等用户按键调用finish。
		showOverlay(context, component);
	});
}

// 创建/挂载等待动画并返回loader供读取signal；例上传时焦点交它处理取消键。构造已开动画，挂载失败无finally自动dispose；不启动业务或自动恢复编辑器。
function showLoader(context: BugReportContext, message: string): BorderedLoader {
	// 默认可取消，主题/动画构造错误可抛。
	const loader = new BorderedLoader(context.ui, theme, message);
	// 临时替换编辑区并聚焦，后续取消只通过signal协作。
	showOverlay(context, loader);
	// 返回同一实例，供上游请求和最终清理。
	return loader;
}

// 清空编辑区后放临时组件、聚焦/重画，无返回；例输入面板替换原编辑器。这是容器替换，不维护嵌套overlay栈/旧焦点，异常可能留下部分已变状态。
function showOverlay(context: BugReportContext, component: Overlay): void {
	// clear只移除孩子，不逐个dispose旧组件。
	context.editorContainer.clear();
	// 原组件引用加入，不深复制。
	context.editorContainer.addChild(component);
	// 焦点交临时组件，不自动确认或提交。
	context.ui.setFocus(component);
	// 请求下一帧，实际写出交TUI。
	context.ui.requestRender();
}

// 尝试dispose临时组件再恢复原编辑器/焦点并重画，无返回；例loader结束停动画。dispose抛错会阻止后续恢复，没有finally/回滚，不取消业务signal或恢复原先全部孩子。
function restoreEditor(context: BugReportContext, component: Overlay): void {
	// 有dispose才调用，?.不吞异常；loader.dispose停动画但不abort业务。
	component.dispose?.();
	// 未确认当前面板仍属于本任务，旧异步收尾也可能影响后来界面。
	context.editorContainer.clear();
	// 只放回context保存的原编辑器，不恢复其他旧孩子。
	context.editorContainer.addChild(context.editor);
	// 原编辑器重新接输入焦点。
	context.ui.setFocus(context.editor);
	// 请求重画，不等待实际显示完成。
	context.ui.requestRender();
}

// 已知Error取message，其他抛值固定Unknown error；例抛字符串bad会丢原文。无I/O，不是序列化/脱敏器，自定义message getter仍可能抛。
function errorMessage(error: unknown): string {
	// 当前realm的instanceof原型判断，message空串也保留，不trim或对非Error做String转换。
	return error instanceof Error ? error.message : "Unknown error";
}
