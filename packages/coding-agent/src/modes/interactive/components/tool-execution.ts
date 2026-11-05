// 展示一条工具调用的参数、部分/最终结果和图片；交互模式驱动状态，renderer 只画界面，本类不调用工具 execute。
import {
	// 标准工具外壳：统一背景和内边距。
	Box,
	// 可渲染组件的静态接口，执行时擦除。
	type Component,
	// 纵向组织调用、结果、图片等孩子。
	Container,
	// 读取终端能力，决定是否显示内联图片。
	getCapabilities,
	// TUI 图片显示组件，可缓存转码结果和终端图像 ID。
	Image,
	// 包装孩子并添加未被孩子处理的点击事件。
	MouseRegion,
	// 生成指定数量的空行。
	Spacer,
	// 普通文字与 ANSI 样式的换行/背景组件。
	Text,
	// 宿主 UI 类型，提供 requestRender；本文件不新建终端。
	type TUI,
	// 传入鼠标事件的坐标和按键形状。
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
// 只导入工具/渲染上下文契约，不导入或调用工具 execute 实现。
import type { ToolDefinition, ToolRenderContext, ToolRenderers } from "../../../core/extensions/types.ts";

/** What this component needs from a tool: how to draw it, without executing it. */
// 仅重新导出渲染能力类型，调用者无需依赖完整工具定义。
export type { ToolRenderers };

// as 在导入中给文本提取函数起本地别名，避免与本类同名方法混淆；helper 清理显示控制字符并按能力补图片占位。
import { formatToolCallWithArgs, getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
// Kitty 非 PNG 图片可触发本地 Photon 加载，登记后请求刷新，不会向模型发请求。
import { ensurePngTranscoder } from "../../../utils/image-convert.ts";
// 当前主题提供待执行/成功/失败背景及文字颜色。
import { theme } from "../theme/theme.ts";
// 使用可配置快捷键生成提示，也把能力传给扩展 renderer。
import { keyHint, keyText } from "./keybinding-hints.ts";

// 有渲染定义但缺结果 renderer 时，通用结果预览保留前 10 个逻辑行，不是 10 个折行后的显示行。
const FALLBACK_PREVIEW_LINES = 10;

// 界面配置可只传部分字段；本类型不校验数值范围，也不决定工具权限。
export interface ToolExecutionOptions {
	// 期望显示图片，缺省 true；实际还依赖终端能力和图片字段。
	showImages?: boolean;
	// 图片最大列数，缺省 60；单位是终端格而非像素。
	imageWidthCells?: number;
	// 左右各留白列数，缺省 1；self 外框的 renderer 自己决定如何使用它。
	outputPad?: number;
}

// 工具行的显示状态机，接收交互模式传来的参数/结果和设置，不执行工具、不改模型结果。
export class ToolExecutionComponent extends Container {
	// 有定义且使用 default 外框时的统一背景容器。
	private contentBox: Box;
	// 完全没有渲染定义时使用的旧式通用文字显示。
	private contentText: Text;
	// 为通用文字包点击区域，有结果后可展开/折叠。
	private contentTextRegion: MouseRegion;
	// renderShell=self 时存 renderer 自绘内容，不套标准背景。
	private selfRenderContainer: Container;
	// 最近一次 self 渲染正文的行数，用于鼠标 y 范围与坐标转换。
	private selfRenderHeight = 0;
	// 调用槽上次返回的组件，作为 lastComponent 交回扩展以便复用。
	private callRendererComponent?: Component;
	// 结果槽自己的上次组件，和调用槽分开保存。
	private resultRendererComponent?: Component;
	// 同一工具行的调用/结果槽共享这个可变对象；原 API 的 any 放宽静态检查，并不验证状态结构。
	private rendererState: any = {};
	// 当前可显示 Image 实例列表，更新时尝试复用相同来源。
	private imageComponents: Image[] = [];
	/** Inputs of imageComponents, so updateDisplay can reuse images and keep their converted PNG data. */
	// Array<对象类型> 等价对象数组，逐项保存数据/MIME/列宽作为复用条件，不存完整结果快照。
	private imageSources: Array<{ data: string; mimeType: string; widthCells: number }> = [];
	// 与当前图片配套的空白间距组件，更新结果时会替换。
	private imageSpacers: Spacer[] = [];
	// 原工具名，用于标题与格式化，不用于在此查找执行函数。
	private toolName: string;
	// 该次工具调用的稳定 ID，传给 renderer 区分不同工具行。
	private toolCallId: string;
	// 当前参数可为流式未完整对象；沿用原 any 契约，显示层不重新做参数 schema 校验。
	private args: any;
	// 默认折叠；有定义时 renderer/结果兜底决定展示多少，完全无定义的旧显示不因此截行。
	private expanded = false;
	// 保存用户图片显示偏好，仍需结合终端能力。
	private showImages: boolean;
	// 当前图片列宽预算，构造和 setter 的处理规则不同。
	private imageWidthCells: number;
	// 当前工具输出的水平留白。
	private outputPad: number;
	// 初始按执行中/部分结果显示，updateResult 默认改成最终结果。
	private isPartial = true;
	// 保存可选渲染定义引用，只用 shell/call/result 三类能力；不读其 execute。
	private toolDefinition?: ToolRenderers;
	// 宿主刷新接口，部分方法调用 requestRender，部分仅更新组件树由调用方刷新。
	private ui: TUI;
	// 创建这条工具行时传入的工作目录，给路径显示使用，不在此 chdir。
	private cwd: string;
	// 与参数开始流入分开，宿主实际开始执行时才显式设置。
	private executionStarted = false;
	// 参数生成完成标记，用于 renderer 避免过早计算完整参数预览。
	private argsComplete = false;
	/** `updateArgs()` ran since the last display update; the next render applies it. */
	// 多次 updateArgs 先覆盖参数，到下一次显示更新/渲染时再合并应用。
	private argsPending = false;
	// 可选部分/最终结果的宽松展示形状；? 表示尚未有结果。
	private result?: {
		// 内容块数组的字段允许缺省，不是严格 text/image 标签联合，读取时需结合存在性。
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		// 错误状态用于背景与 renderer 上下文，不会在此重新抛出工具错误。
		isError: boolean;
		// 扩展自定义详情，原类型允许任意结构，直接交给 renderer。
		details?: any;
		// 可选最终执行耗时；部分结果传给 renderer 时隐藏该数值。
		durationMs?: number;
	};
	// 显示重建计算的整行隐藏标记；self 渲染还会独立检查实际行数组是否为空。
	private hideComponent = false;

	// 建立工具行：保存参数/定义/宿主→准备三种外壳→按定义选一个→生成初始显示。
	// 例未知工具且定义为 undefined 时展示工具名/JSON 参数；传 {} 定义则走调用/结果槽兜底，两条路径不同。
	// 不执行命令或请求模型；样式/JSON 格式化等同步错误可能传播，构造图片结果前不会加载转码器。
	constructor(
		// 工具原名，用于标题。
		toolName: string,
		// 本次调用 ID，持续用于多次流式更新。
		toolCallId: string,
		// 当前参数引用，允许尚在流入，原 any 不保证字段齐全。
		args: any,
		// 缺省使用新空配置；只设置 showImages 等所需字段即可。
		options: ToolExecutionOptions = {},
		// 联合允许轻量渲染定义、完整工具定义或明确 undefined；即使有 execute 也不会调用。
		toolDefinition: ToolRenderers | ToolDefinition<any, any, any> | undefined,
		// 宿主 UI 提供刷新请求方法。
		ui: TUI,
		// 记录当前工作目录供 renderer 解析显示路径。
		cwd: string,
	) {
		// 初始化父容器，随后才能访问 this。
		super();
		// 保存名称，不做别名映射或查表。
		this.toolName = toolName;
		// 保存调用标识。
		this.toolCallId = toolCallId;
		// 保留参数对象引用；updateArgs 时也采用替换引用而非深拷贝。
		this.args = args;
		// 保存渲染定义，当前组件没有动态切换定义的公开 setter。
		this.toolDefinition = toolDefinition;
		// ?? 只有 null/undefined 才默认 true，显式 false 予以保留。
		this.showImages = options.showImages ?? true;
		// 构造直接采用配置或 60，不在此执行 floor/至少 1 的 setter 规则。
		this.imageWidthCells = options.imageWidthCells ?? 60;
		// 缺省左右各 1，显式 0 不会变成默认。
		this.outputPad = options.outputPad ?? 1;
		// 保存宿主引用。
		this.ui = ui;
		// 保存传入目录文字，不读取磁盘。
		this.cwd = cwd;

		// 父容器先加消息间距；self render 另按实际可见内容手动安排这行。
		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		// 建立标准外壳，更新时再设置实际 outputPad 和待执行/成功/失败背景。
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		// 建立完全无定义时的通用 Text；它自己负责背景/留白。
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		// 包装通用显示，只有已经有 result 时才响应左键切换。
		this.contentTextRegion = this.createResultRegion(this.contentText);
		// 创建无标准背景的自绘容器，未选择它时也保留对象。
		this.selfRenderContainer = new Container();

		// 检查是否提供了定义对象，而非定义内是否真的有 renderCall/renderResult。
		if (this.hasRendererDefinition()) {
			// 有定义时选自绘或默认外壳，选择发生于构造。
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			// 无定义才使用旧式整段文字显示。
			this.addChild(this.contentTextRegion);
		}

		// 同步更新显示/图片列表；此调用不直接 requestRender，外层方法或宿主另行请求绘制。
		this.updateDisplay();
	}

	// 读取可选调用渲染函数，无参数/副作用；例定义 {} 返回 undefined，随后使用通用调用标题。
	// 索引访问类型复用 ToolDefinition 的 renderCall 签名，返回函数引用而不是执行函数。
	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		// ?. 在缺少定义时返回 undefined，不访问不存在对象字段。
		return this.toolDefinition?.renderCall;
	}

	// 读取结果渲染函数引用；例只定义 renderCall 时此处为空，结果用通用预览，无 IO 或回调执行。
	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		// 只读可选字段，真正调用在 updateDisplay。
		return this.toolDefinition?.renderResult;
	}

	// 判断定义是否存在，返回 boolean；例 {} 是 true，undefined 是 false，不检查回调是否存在或有效。
	private hasRendererDefinition(): boolean {
		// 严格比较 undefined；TS 定义不允许 null，但这里不承担外部数据的完整验证。
		return this.toolDefinition !== undefined;
	}

	// 返回外框策略，缺省 default；例 renderShell:"self" 让扩展承担框和留白，不改变工具执行行为。
	private getRenderShell(): "default" | "self" {
		// 可选读取并用 ?? 回退，返回类型由两个字符串字面量限制。
		return this.toolDefinition?.renderShell ?? "default";
	}

	// 为一个调用/结果槽创建上下文，传上次组件并共享行状态；例 renderer 可复用 lastComponent，读 argsComplete 决定是否做完整预览。
	// 返回新选项对象，但 args/state/组件仍为原引用；invalidate 回调会同步重建显示并请求 UI 刷新，不执行工具。
	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		// 对象字面量返回上下文快照；其中引用字段仍共享，可变字段标量反映本次调用时的值。
		return {
			// 当前参数可尚未完整，renderer 应参考 argsComplete。
			args: this.args,
			// 同一工具行的稳定关联 ID。
			toolCallId: this.toolCallId,
			// 给扩展的无参箭头回调，闭包绑定当前 this，调用时立刻进入本组件 invalidate。
			invalidate: () => {
				// 不只清缓存，还会在本类 override 中重建显示；renderer 不应无条件同步反复调用它。
				this.invalidate();
				// 通知宿主安排绘制，不直接写终端。
				this.ui.requestRender();
			},
			// 属性简写，调用槽和结果槽各自传入上次返回对象。
			lastComponent,
			// 两个槽共享的任意状态对象，不为每次 render 重新创建。
			state: this.rendererState,
			// 创建时记录的目录，供路径链接/文字显示。
			cwd: this.cwd,
			// 宿主是否已通知工具实际开始执行。
			executionStarted: this.executionStarted,
			// 宿主是否已通知模型参数生成完毕。
			argsComplete: this.argsComplete,
			// 当前是否仍是部分结果。
			isPartial: this.isPartial,
			// 当前本地展开状态，renderer 自己决定如何利用。
			expanded: this.expanded,
			// 用户期望的图片开关，尚不代表终端有能力显示。
			showImages: this.showImages,
			// 没有结果时默认非错误；有结果时原样提供错误标记。
			isError: this.result?.isError ?? false,
			// 部分结果不暴露最终耗时，最终结果才透传可选记录。
			durationMs: this.isPartial ? undefined : this.result?.durationMs,
			// 左右留白，self renderer 需自行应用。
			outputPad: this.outputPad,
			// 转交当前配置中的动作键显示函数。
			keyText,
			// 转交可附提示语/样式的快捷键提示函数。
			keyHint,
		};
	}

	// 创建通用调用标题组件，无参数，返回 Text；例 {path:"a.ts"} 折叠为键值预览、展开为逐字段正文。
	// 只格式化参数/样式，不调用工具；JSON stringify 等格式化异常仍可向上传播。
	private createCallFallback(): Component {
		// helper 按展开状态格式化，Text 自身无边距，统一使用外层布局。
		return new Text(formatToolCallWithArgs(this.toolName, this.args, theme, this.expanded), 0, 0);
	}

	// 没有结果 renderer 时生成文本预览，返回 Text 或 undefined；例 15 行折叠留前 10 行并提示还有 5 行。
	// 只裁显示逻辑行，不裁模型结果；文本/主题处理异常传播，没有文件或模型请求。
	private createResultFallback(): Component | undefined {
		// 提取当前结果文字，并按图片开关/终端能力决定图片占位。
		const output = this.getTextOutput();
		// 没有任何显示文字时不造空 Text。
		if (!output) {
			// 显式没有结果组件，由上层决定是否只显示调用标题/图片。
			return undefined;
		}

		// 按原始 LF 逻辑行拆分，后续 Text 仍可能把长行折成更多显示行。
		const lines = output.split("\n");
		// 展开用全部文字行；折叠只复制前 10 行。
		const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		// 计算隐藏的逻辑行数，不是 token 或显示折行数。
		const remaining = lines.length - displayLines.length;
		// 逐行套工具输出色后拼接，让保留正文与后面的提示有独立样式。
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		// 确实隐藏了行才附展开提示。
		if (remaining > 0) {
			// 嵌套模板字面量拼隐藏数和当前可配置快捷键；不在此绑定按键。
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		// 返回零内边距文字组件，Box 或自绘布局负责外部间距。
		return new Text(text, 0, 0);
	}

	// 给调用/结果显示包左键切换能力，返回 MouseRegion，不改变正文排版。
	// 例已有部分结果后点击标题可反转展开；尚无结果时不处理。孩子事件优先，本回调未执行时不切换。
	private createResultRegion(component: Component): MouseRegion {
		// MouseRegion 先询问孩子，仅在未处理时调用此兜底；箭头函数持有当前工具行。
		return new MouseRegion(component, (event) => {
			// 必须已有 result 且为左键 click，否则 undefined 表示未处理。
			if (!this.result || event.type !== "click" || event.button !== "left") return undefined;
			// 反转展开状态并同步重建，原工具结果不改。
			this.setExpanded(!this.expanded);
			// 让上层鼠标分发知道已经处理并安排绘制。
			return { handled: true };
		});
	}

	/**
	 * Show new partial arguments. Applied at the next render, so a call streaming many argument deltas between two
	 * frames runs its renderer once per frame, not once per delta (#9265).
	 */
	// 记录最新流式参数并请求绘制，无返回值；例一帧前收到 30 次参数片段，只保留最后引用等显示更新时应用。
	// 本方法不立即调用 renderer；其他 setter/updateResult 也会触发显示更新，不能理解为所有情况都严格每帧一次。
	updateArgs(args: any): void {
		// 保留参数对象引用；updateArgs 时也采用替换引用而非深拷贝。
		this.args = args;
		// 标记参数尚待应用到组件树；后续 render 或其他 updateDisplay 会清除此标记。
		this.argsPending = true;
		// 请求宿主绘制；仅发请求，不保证下一条代码执行前就完成绘屏。
		this.ui.requestRender();
	}

	// 标记工具已开始并立即重建/请求刷新；例参数生成完到执行开始时用于 renderer 启动自己的计时显示，不执行工具。
	markExecutionStarted(): void {
		// 只设置显示标记，不启动进程/计时器；renderer 可据此自行响应。
		this.executionStarted = true;
		// 同步更新显示/图片列表；此调用不直接 requestRender，外层方法或宿主另行请求绘制。
		this.updateDisplay();
		// 请求宿主绘制；仅发请求，不保证下一条代码执行前就完成绘屏。
		this.ui.requestRender();
	}

	// 标记参数完整，立即重建并请求刷新；例 edit renderer 可此时计算最终预览，不重新验证参数 schema。
	setArgsComplete(): void {
		// 保存完成标记，之后上下文持续为 true。
		this.argsComplete = true;
		// 同步更新显示/图片列表；此调用不直接 requestRender，外层方法或宿主另行请求绘制。
		this.updateDisplay();
		// 请求宿主绘制；仅发请求，不保证下一条代码执行前就完成绘屏。
		this.ui.requestRender();
	}

	// 替换部分或最终结果并重建显示，默认最终结果，无返回值；例 updateResult(result,true) 保持待执行背景，传 false 可显示成功/错误背景。
	// 保存原结果引用，不自动把部分结果拼起来，也不直接 requestRender；宿主事件处理器负责刷新。
	updateResult(
		// 形参对象重复当前显示所需形状，不要求完整 AgentToolResult 的所有业务字段。
		result: {
			// 数组可带文字/图片等宽松块，展示时按 type 和实际字段筛选。
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			// 详情只透传给扩展 renderer，不在此验证或复制。
			details?: any;
			// 是否错误由宿主结果事件提供，不从正文猜测。
			isError: boolean;
			/** Execution time of a final result. */
			// 最终执行耗时的可选记录，部分结果上下文不会采用。
			durationMs?: number;
		},
		// 默认 false 表示最终；需要流式中间结果时调用方明确传 true。
		isPartial = false,
	): void {
		// 保存这份结果的引用，之前部分结果整体被替换。
		this.result = result;
		// 保存当前结果阶段，决定背景/renderer 上下文。
		this.isPartial = isPartial;
		// 同步更新显示/图片列表；此调用不直接 requestRender，外层方法或宿主另行请求绘制。
		this.updateDisplay();
	}

	// 保存展开状态并重建，例传 true 让通用结果显示全部逻辑行；不改模型内容，不主动请求刷新。
	setExpanded(expanded: boolean): void {
		// 即使与旧值相同也保存并更新显示，没有早退优化。
		this.expanded = expanded;
		// 同步更新显示/图片列表；此调用不直接 requestRender，外层方法或宿主另行请求绘制。
		this.updateDisplay();
	}

	// 设置水平留白并重建；例传 0 去掉标准外壳左右边距，self renderer 通过上下文自行采用，无返回值。
	setOutputPad(outputPad: number): void {
		// 保存原数值，不在此校验范围或整数性。
		this.outputPad = outputPad;
		// 同步更新显示/图片列表；此调用不直接 requestRender，外层方法或宿主另行请求绘制。
		this.updateDisplay();
	}

	// 切换图片显示偏好并重建；例 false 在文字提取中生成图片占位，不删除原结果里的图片块。
	setShowImages(show: boolean): void {
		// 开关只影响显示列表/占位，不更改 result.content。
		this.showImages = show;
		// 同步更新显示/图片列表；此调用不直接 requestRender，外层方法或宿主另行请求绘制。
		this.updateDisplay();
	}

	// 调整图片最大列宽并重建；例 10.8 变 10，0 变 1。只 floor/下限处理，NaN/Infinity 并未被拒绝。
	setImageWidthCells(width: number): void {
		// floor 向下取整再至少 1；不同于构造直接采用 options.imageWidthCells。
		this.imageWidthCells = Math.max(1, Math.floor(width));
		// 同步更新显示/图片列表；此调用不直接 requestRender，外层方法或宿主另行请求绘制。
		this.updateDisplay();
	}

	// 先通知旧孩子缓存失效再重建显示，例主题变化后重调 renderer；不直接 requestRender，孩子自身可能请求。
	override invalidate(): void {
		// 父类遍历现有孩子 invalidate，异常向上传播，不自动销毁旧组件。
		super.invalidate();
		// 同步更新显示/图片列表；此调用不直接 requestRender，外层方法或宿主另行请求绘制。
		this.updateDisplay();
	}

	// 返回给定列宽的行数组：先应用待处理参数→隐藏则空→self 手动拼正文/图片→其他交父容器。
	// 例 self renderer 返回零行且无图片时整条连前置空行都不占；可能更新 renderer/图片缓存及 selfRenderHeight，不直接写终端。
	override render(width: number): string[] {
		// 仅新参数尚未应用时才重建；多次流式覆盖在这里合并成最后一份。
		if (this.argsPending) this.updateDisplay();
		// 若上次重建决定隐藏，直接返回无布局空间。
		if (this.hideComponent) {
			// 空数组不占行；不是隐藏原消息或工具执行结果。
			return [];
		}

		// self 路径不借父容器绘制标准壳，下面手动处理消息空行和图片。
		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			// 自绘正文按父宽渲染，renderer 自行处理背景/留白。
			const contentLines = this.selfRenderContainer.render(width);
			// 保存本轮正文实际高度，鼠标坐标转换使用它。
			this.selfRenderHeight = contentLines.length;
			// 正文没有行且没有图片时整条空，避免无意义消息间距。
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				return [];
			}

			// 本次手动汇总的新数组，不直接修改孩子行缓存。
			const lines: string[] = [];
			// 有正文时才加它自己的前置空行。
			if (contentLines.length > 0) {
				// 在自绘正文前加入一行消息间距。
				lines.push("");
				// 展开数组将各显示行逐项加入，而不是把数组当一个元素。
				lines.push(...contentLines);
			}
			// 按当前图片顺序附加间距与图像控制串/占位行。
			for (let i = 0; i < this.imageComponents.length; i++) {
				// 取对应图片的空行组件；数组索引本身不复制对象。
				const spacer = this.imageSpacers[i];
				// 有配套间距才渲染，未找到则跳过。
				if (spacer) {
					// 将空行组件产生的行加到结果。
					lines.push(...spacer.render(width));
				}
				// 取当前 Image 实例，可复用其已转码 PNG。
				const imageComponent = this.imageComponents[i];
				// 实例存在时才绘制这张图。
				if (imageComponent) {
					// 图像组件生成终端协议/高度占位或文字回退，真正输出由上层 TUI 完成。
					lines.push(...imageComponent.render(width));
				}
			}
			// self 路径返回手动汇总，不再调用 super 以免重复绘制图片。
			return lines;
		}

		// 标准壳或旧文字路径按父容器孩子顺序绘制，包含前置间距与图片。
		return super.render(width);
	}

	// 把鼠标转发到合适布局并返回处理结果；ReturnType 从父方法取得返回类型。
	// 例 self 正文前多一空行，因此 y 需减 1；此路径仅把正文区交给自绘容器，不替图片区派发事件，无 IO。
	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		// 非 self 使用父容器的普通孩子布局分发。
		if (!this.hasRendererDefinition() || this.getRenderShell() !== "self") return super.handleMouse(event);
		// self 最前空行和正文范围之外不处理；高度来自最近一次 render，未渲染时初始为 0。
		if (event.y <= 0 || event.y > this.selfRenderHeight) return undefined;
		// 构造相对正文的新事件对象，原事件不会原地修改。
		return this.selfRenderContainer.handleMouse({
			// 先浅复制坐标/按键等全部字段。
			...event,
			// 再覆盖 y，扣掉自绘正文前的消息空行。
			y: event.y - 1,
			// 正文接收到的高度只包含它自己，不包含下方图片。
			height: this.selfRenderHeight,
		});
	}

	// 重建工具行显示：清待处理参数→选状态背景→重调调用/结果槽或旧文字→移除旧图并按来源复用→计算隐藏标记。
	// 例部分结果换最终结果会换背景，参数不变的图片可保留 Image；renderer 失败回退，但回退本身/JSON/图像等错误仍可能传播。
	// 会修改子组件/缓存引用，非 PNG 图片可异步登记本地转码器；无工具执行、模型请求或直接绘屏，无返回值。
	private updateDisplay(): void {
		// 本次已应用最新参数，下一次无新参数的 render 不再重建。
		this.argsPending = false;
		// 优先按是否部分结果选择背景，不从 executionStarted 单独推断。
		const bgFn = this.isPartial
			? // 进行中即使用待执行背景，即便部分结果已有错误标记。
				(text: string) => theme.bg("toolPendingBg", text)
			: // 最终结果才看是否错误；无结果时可选访问得到 undefined。
				this.result?.isError
				? // 最终错误背景。
					(text: string) => theme.bg("toolErrorBg", text)
				: // 最终非错误背景；箭头函数在实际套背景时读取当前主题。
					(text: string) => theme.bg("toolSuccessBg", text);

		// 记录是否成功加了调用/结果组件，不等于组件实际 render 行数非零。
		let hasContent = false;
		// 先恢复可见，再按这次内容情况计算。
		this.hideComponent = false;
		// 检查是否提供了定义对象，而非定义内是否真的有 renderCall/renderResult。
		if (this.hasRendererDefinition()) {
			// 选择自绘容器或标准 Box，后面共用调用/结果槽组合流程。
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			// 只给标准 Box 设置本类负责的背景/留白；self 容器由 renderer 自己管。
			if (renderContainer instanceof Box) {
				// 更新背景回调；Box 在 render 时用样本和孩子行判断是否复用最终缓存。
				renderContainer.setBgFn(bgFn);
				// 标准外框采用当前水平留白并清自身组合缓存。
				renderContainer.setPaddingX(this.outputPad);
			}
			// 移除上次调用/结果包装层，保存的 renderer 组件仍可通过 lastComponent 复用。
			renderContainer.clear();

			// 取可选调用槽函数，不执行工具。
			const callRenderer = this.getCallRenderer();
			// 缺调用 renderer 时生成通用标题/参数预览。
			if (!callRenderer) {
				// 通用调用区也包鼠标切换区域，收到结果后即可点击展开。
				renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
				// 已加入调用组件，哪怕它实际返回空显示行也先记存在。
				hasContent = true;
			} else {
				// 捕获调用 renderer 的同步构建异常；未来组件 render 异常不在本 try 中。
				try {
					// 传最新参数、主题和调用槽上下文，上次组件由扩展选择是否复用。
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					// 保存本次返回对象，下一次调用槽作为 lastComponent 传回。
					this.callRendererComponent = component;
					// 用点击包装层纳入布局，组件自己的有效鼠标处理优先。
					renderContainer.addChild(this.createResultRegion(component));
					// 记录已经加入一个渲染组件，不检查它的实际显示高度。
					hasContent = true;
					// 调用槽失败时改用通用标题；catch 内回退若再次抛错则向上传播。
				} catch {
					// 不再把失败槽的旧组件作为下一次复用依据。
					this.callRendererComponent = undefined;
					// 异常后仍尝试展示原工具名和参数。
					renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
					// 记录已经加入一个渲染组件，不检查它的实际显示高度。
					hasContent = true;
				}
			}

			// 有部分或最终结果时才创建结果槽，尚无结果只展示调用。
			if (this.result) {
				// 取得结果槽函数，与调用槽独立。
				const resultRenderer = this.getResultRenderer();
				// 没有结果 renderer 时使用前 10 行文字兜底。
				if (!resultRenderer) {
					// 可能因没有显示文字而得到 undefined。
					const component = this.createResultFallback();
					// 仅实际有 Text 才添加结果区。
					if (component) {
						// 给结果组件同样包点击切换区域。
						renderContainer.addChild(this.createResultRegion(component));
						// 加入结果组件后标记存在内容。
						hasContent = true;
					}
				} else {
					// 结果 renderer 单独捕获同步构建异常，不影响已创建的调用槽。
					try {
						// 执行结果显示回调，不能据此认为工具重新执行。
						const component = resultRenderer(
							// 只投影 content/details；as any 沿用宽松展示数据适配，不进行运行时转换/校验。
							{ content: this.result.content as any, details: this.result.details },
							// 传结果专用选项，控制折叠和部分状态。
							{ expanded: this.expanded, isPartial: this.isPartial },
							// 提供当前主题。
							theme,
							// 传结果槽的 lastComponent，以及与调用槽共享的 state。
							this.getRenderContext(this.resultRendererComponent),
						);
						// 保存当前结果组件供下一次复用。
						this.resultRendererComponent = component;
						// 给结果组件同样包点击切换区域。
						renderContainer.addChild(this.createResultRegion(component));
						// 加入结果组件后标记存在内容。
						hasContent = true;
						// 结果槽异常转文字预览；这里没有单独显示 renderer 报错原因。
					} catch {
						// 丢弃失败槽的复用引用，下次给 undefined。
						this.resultRendererComponent = undefined;
						// 尝试默认结果文本；回退自身异常不会再由该 catch 捕获。
						const component = this.createResultFallback();
						// 只有非空显示文本才加入。
						if (component) {
							// 加入失败后的通用结果预览。
							renderContainer.addChild(this.createResultRegion(component));
							// 记录结果兜底存在。
							hasContent = true;
						}
					}
				}
			}
		} else {
			// 完全无定义的旧路径由 Text 自己套状态背景。
			this.contentText.setCustomBgFn(bgFn);
			// 旧 Text 的左右边距直接更新，不经过标准 Box。
			this.contentText.setPaddingX(this.outputPad);
			// 旧路径拼工具标题、完整 JSON 参数和文本输出，没有 10 行折叠预览规则。
			this.contentText.setText(this.formatToolExecution());
			// 通用 Text 被保留作为显示内容。
			hasContent = true;
		}

		// 暂存上次图片实例数组，下面的新列表可以按位置复用它们。
		const previousImages = this.imageComponents;
		// 暂存上次对应来源，比较 data/MIME/宽度是否都没变。
		const previousSources = this.imageSources;
		// 先从父容器移除当前所有图片，不立即销毁实例。
		for (const img of this.imageComponents) {
			// 摘掉孩子引用；后面若来源相同可重新加入同一 Image。
			this.removeChild(img);
		}
		// 本轮重新收集图片实例，不在旧数组上清空以保留 previousImages。
		this.imageComponents = [];
		// 本轮重新收集来源信息。
		this.imageSources = [];
		// 旧图片空行也要移除，避免每次更新多一份间距。
		for (const spacer of this.imageSpacers) {
			// 删除旧图片间距组件引用。
			this.removeChild(spacer);
		}
		// 清空本轮图片间距列表。
		this.imageSpacers = [];

		// 只有有结果才可能提取图片，参数里的 base64 不会自动当图片显示。
		if (this.result) {
			// 仅挑图片类型，原 content 数组不变，字段仍是宽松可选形状。
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			// 读取终端图片能力；冷缓存的底层能力探测可能检查环境/tmux。
			const caps = getCapabilities();
			// 按结果图片块的原有顺序处理。
			for (const img of imageBlocks) {
				// 终端支持、用户开启且数据/MIME 非空才创建 Image；不是完整文件有效性校验。
				if (caps.images && this.showImages && img.data && img.mimeType) {
					// 每张显示图片前建一行空白。
					const spacer = new Spacer(1);
					// 将空行加入父容器，标准路径由它绘制，self 路径会从列表手动绘制。
					this.addChild(spacer);
					// 同步保存配套间距，供 self render 与下次更新清理使用。
					this.imageSpacers.push(spacer);
					// 保存本次可显示来源及列宽，均为字符串/数字值。
					const source = { data: img.data, mimeType: img.mimeType, widthCells: this.imageWidthCells };
					// 本次第几张可显示图片，而非原结果数组的绝对索引。
					const index = this.imageComponents.length;
					// 只匹配上次相同显示位置，未在所有旧图之间做搜索。
					const previous = previousSources[index];
					// 以下三项都相同就复用旧 Image，保留已转码 PNG、行缓存和终端 ID。
					const imageComponent =
						// ?. 允许该位置没有旧来源；base64 字符串按值比较。
						previous?.data === source.data &&
						// 声明 MIME 也必须相同，不能只比较数据。
						previous.mimeType === source.mimeType &&
						// 最大列宽相同才复用，否则新建采用新布局选项。
						previous.widthCells === source.widthCells
							? // 复用同位置旧实例，不重新转换该图片。
								previousImages[index]
							: // 来源/宽度变化则构造新图像组件，实际转码/协议生成延迟到 render。
								new Image(
									// 原 base64 文字，并非磁盘路径。
									source.data,
									// 声明 MIME，Image 会据终端能力决定是否需 PNG 转码。
									source.mimeType,
									// 图形无法显示时的文字占位样式，不会更改图片像素颜色。
									{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
									// 只设置最大列宽，具体高度/父宽限制由 Image 计算。
									{ maxWidthCells: source.widthCells },
								);
					// 非精确 PNG 时尝试准备共享转码器；helper 内部只有 Kitty 协议才真正加载。
					if (source.mimeType !== "image/png") {
						// 登记完成回调，首次本地图像后端异步加载成功后触发；已登记或失败时不一定调用。
						ensurePngTranscoder(() => {
							// 用当前最新结果重建/失效图片，旧部分图片不会因本回调被重新塞回。
							this.invalidate();
							// 请求宿主用新转码器刷新；helper 不吞回调异常，链上异常可能形成拒绝。
							this.ui.requestRender();
						});
					}
					// 保存本轮选定的新/旧 Image 实例。
					this.imageComponents.push(imageComponent);
					// 保持来源与图像数组同索引对应，下次继续比较。
					this.imageSources.push(source);
					// 加入父容器显示顺序；self render 会专门遍历图像列表。
					this.addChild(imageComponent);
				}
			}
		}

		// 有定义但未加入任何调用/结果组件且无图时设置隐藏；不根据 Text 的实际行数判断，self 的空行检查另在 render。
		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			// 下次 render 返回空数组，不占消息间距。
			this.hideComponent = true;
		}
	}

	// 提取当前结果的终端文字，返回字符串；例关闭图片时补图片格式/尺寸占位，不改 result，也不读取图片文件。
	private getTextOutput(): string {
		// 共享 helper 清 ANSI/二进制控制/CR，按终端与开关决定图片文字占位。
		return getRenderedTextOutput(this.result, this.showImages);
	}

	// 完全无渲染定义的旧兜底：标题→两空格缩进 JSON 参数→清理后的结果文字，返回整段字符串。
	// 例 args={q:1} 显示完整 JSON；这里不按 expanded 截行，循环对象/BigInt 等 stringify 错误直接传播，无工具执行。
	private formatToolExecution(): string {
		// 先生成加粗且带工具标题色的名称。
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		// JSON 的 replacer 为 null、缩进 2；undefined/函数等可得 undefined，某些值会转换或抛错。
		const content = JSON.stringify(this.args, null, 2);
		// 只有得到了非空 JSON 文字才显示参数区。
		if (content) {
			// 标题后空一行再放 JSON 参数，不运行或验证这些参数。
			text += `\n\n${content}`;
		}
		// 提取当前结果文字，并按图片开关/终端能力决定图片占位。
		const output = this.getTextOutput();
		// 有结果文字或图片占位才附输出。
		if (output) {
			// 换行追加显示文字，不改变原始工具结果。
			text += `\n${output}`;
		}
		// 返回整段旧式显示，由 contentText 负责折行、背景与留白。
		return text;
	}
}
