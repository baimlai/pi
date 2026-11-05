// edit 的调用预览/结果显示：参数完整后只读本地文件算diff，实际写文件由工具execute负责；结果可回填调用区以避免重复显示大diff。
/**
 * Presentation for the edit tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `edit.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

// Box带内边距/背景，Container纵向组合，Spacer空行，Text负责文字折行；都是运行值。
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
// 把既有diff按增删/上下文着色，一删一增时还可突出词级变化；不写文件。
import { renderDiff } from "../../../modes/interactive/components/diff.ts";
// 回调主题纯类型。
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
// 工具定义纯类型，此处只取显示槽。
import type { ToolDefinition } from "../../extensions/types.ts";
// edit最终diff/首变行详情类型，不加载实际写入实现。
import type { EditToolDetails } from "../edit.ts";
// computeEditsDiff是会读取文件但不写回的真实函数；type声明的Edit/成功/错误结果只在开发期使用。
import { computeEditsDiff, type Edit, type EditDiffError, type EditDiffResult } from "../edit-diff.ts";
// 显示路径链接与str参数规范辅助，不验证文件存在。
import { renderToolPath, str } from "../render-utils.ts";

// 预览是成功diff或带error文字的结果联合，运行期通过error字段区别。
type EditPreview = EditDiffResult | EditDiffError;
// 同一工具行跨调用/结果槽共享的渲染状态，type不自动创建对象，宿主初始化{}。
export type EditRenderState = {
	// 保存调用区Box引用，让结果槽能更新同一预览；它不是另一个工具调用。
	callComponent?: EditCallRenderComponent;
};
// 兼容流式/历史参数的展示形状，不是正式执行schema，字段都可缺。
type RenderableEditArgs = {
	// 新路径字段，预览选择它优先。
	path?: string;
	// 旧file_path别名；标题显示偏好与预览参数选择的顺序不完全相同。
	file_path?: string;
	// 批量替换列表。
	edits?: Edit[];
	// 旧式单次替换的原文本。
	oldText?: string;
	// 旧式单次替换的新文本，可为空表示删片段。
	newText?: string;
};
// 结果展示只依赖内容及可选diff详情，不读取整份执行Outcome。
type EditToolResultLike = {
	// 文字/图片等宽松内容块类型，按type挑文字。
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	// 可选diff/首变行详情。
	details?: EditToolDetails;
};
// 交叉类型：Box实例另挂预览字段，字段用?表示可能还没初始化；类型不会自动给Box安装这些字段。
type EditCallRenderComponent = Box & {
	// 当前成功diff或预览错误。
	preview?: EditPreview;
	// 预览所属参数的JSON键，用来忽略另一套旧参数的异步结果。
	previewArgsKey?: string;
	// 当前参数是否已有在途预览，避免同参数重绘重复启动读取。
	previewPending?: boolean;
	// 已观察到的执行结果错误状态，没有预览时用于背景选择。
	settledError?: boolean;
};
// 创建预览Box，无输入、返回带状态字段组件；仅分配对象，不读文件。例：首次edit调用行得到1格内边距和空预览，之后按主题重设背景。
function createEditCallRenderComponent(): EditCallRenderComponent {
	// Object.assign在新Box上附字段；初始背景回调输入文字原样返回，真正背景稍后由build设置。
	return Object.assign(new Box(1, 1, (text: string) => text), {
		// 显式undefined并断言联合类型，供TS允许后面写成功/错误预览。
		preview: undefined as EditPreview | undefined,
		// 参数键尚无，同样用断言保留string|undefined字段类型。
		previewArgsKey: undefined as string | undefined,
		// 没有在途计算。
		previewPending: false,
		// 初始未观察到执行错误，不代表工具已经成功执行。
		settledError: false,
	});
}
// 取复用的调用区组件，输入共享state与未知lastComponent，返回Box并可能回写state，无文件I/O。
// 优先宿主上次Box→共享state缓存→新建；例：结果槽曾更新state.callComponent，后续调用重绘继续用它。
function getEditCallRenderComponent(state: EditRenderState, lastComponent: unknown): EditCallRenderComponent {
	// lastComponent是未知组件边界，实际检测Box实例；不会验证其所有自定义预览字段。
	if (lastComponent instanceof Box) {
		// 断言该Box也允许附加预览字段，不运行额外检查。
		const component = lastComponent as EditCallRenderComponent;
		// 同步保存到共享state，供结果槽访问同一引用。
		state.callComponent = component;
		// 优先复用这个宿主传来的组件。
		return component;
	}
	// 没有可用last Box时看共享状态是否已有调用组件。
	if (state.callComponent) {
		// 已有就直接复用，不重建预览。
		return state.callComponent;
	}
	// 都没有时创建新的预览Box。
	const component = createEditCallRenderComponent();
	// 存到共享状态，跨renderCall/renderResult保留。
	state.callComponent = component;
	// 返回这份组件。
	return component;
}
// 把宽松展示参数整理成可预览的path+edits或null，不读文件、不验证替换是否能应用。
// 先有效非空路径，再有效非空批量edits，最后旧oldText/newText包装；例：只有路径或半个生成中的edit不触发文件读取。这是UI输入形状边界，不是执行权限校验。
function getRenderablePreviewInput(args: RenderableEditArgs | undefined): { path: string; edits: Edit[] } | null {
	// 整体参数还没出现时没有可预览材料。
	if (!args) {
		// 返回null，外层仍可画标题。
		return null;
	}

	// 预览路径优先args.path，只有它非字符串时才用字符串file_path；path为空字符串也不会回退旧别名。
	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	// 空字符串/没有合法路径都不预览。
	if (!path) {
		// 返回无预览输入，不把空路径当cwd文件。
		return null;
	}

	// 下面三个条件同时满足才采用批量版本。
	if (
		// UI可能看到流式/旧记录，实际检查edits是数组。
		Array.isArray(args.edits) &&
		// 数组至少有一个替换项。
		args.edits.length > 0 &&
		// 每个项的oldText/newText必须是字符串，包括空新文本；不在此验证旧文本唯一匹配/替换重叠。
		args.edits.every((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string")
	) {
		// 复用原edits数组引用返回，未深拷贝；只整理输入。
		return { path, edits: args.edits };
	}

	// 批量分支未满足但旧单次两个字段完整，也可以生成一项预览。
	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		// 新建单元素数组，把旧字段包装成批量替换形状。
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	// 仍无完整替换材料则不发预览读取。
	return null;
}
// 格式化edit调用标题，输入参数/主题/cwd，返回工具名和路径链接，无文件读取。例：edit src/a.ts；标题file_path非null/undefined优先（空串也优先），和预览优先path的选择规则应分开理解。
function formatEditCall(args: RenderableEditArgs | undefined, theme: Theme, cwd: string): string {
	// 标题用??优先file_path（空串也保留），str标非法值，renderToolPath按cwd创建显示链接。
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	// 拼加粗工具名与路径显示。
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}
// 计算结果区需要额外显示的文字，输入参数/已显示预览/执行结果/主题/错误状态，返回ANSI或undefined。
// 错误若和调用区预览同文则去重；成功仅在最终diff非空且与预览不同才显示。例：已有相同大diff时不再重复一份，也不显示普通成功句。
function formatEditResult(
	// 参数用来给diff显示函数提供路径（该函数目前保留但未使用filePath选项）。
	args: RenderableEditArgs | undefined,
	// 调用区已显示的成功/错误预览，可尚无。
	preview: EditPreview | undefined,
	// 现有执行结果内容/详情，不重新执行编辑。
	result: EditToolResultLike,
	// 当前主题用于错误文字颜色。
	theme: Theme,
	// 上下文错误标记，决定取错误文字还是diff。
	isError: boolean,
	// undefined表示结果槽不用额外正文，不代表执行没有结果。
): string | undefined {
	// 取兼容路径并规范显示类型。
	const rawPath = str(args?.file_path ?? args?.path);
	// 只有成功预览才取diff，用in操作符在联合中缩小类型。
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	// 只有error分支取预览错误文字。
	const previewError = preview && "error" in preview ? preview.error : undefined;
	// 执行错误时优先展示错误而非详情diff。
	if (isError) {
		// 从执行结果内容构造错误文字。
		const errorText = result.content
			// 只取text块，忽略图片。
			.filter((c) => c.type === "text")
			// 缺text或空text用空串，不访问其他块结构。
			.map((c) => c.text || "")
			// 多块错误用换行合并；这里不通过getTextOutput清理，渲染器按此已有路径展示。
			.join("\n");
		// 空错误或与调用区预览错误完全同文时省略结果区，避免重复。
		if (!errorText || errorText === previewError) {
			// 不额外创建结果文字。
			return undefined;
		}
		// 独立错误内容着error色返回，不把它当源代码diff。
		return theme.fg("error", errorText);
	}

	// 成功路径读取执行器最终diff。
	const resultDiff = result.details?.diff;
	// diff必须真值且不同于预览才补到结果区；相同或空diff不重复。
	if (resultDiff && resultDiff !== previewDiff) {
		// 调用diff着色器，null路径转undefined；当前renderDiff实际忽略filePath选项。
		return renderDiff(resultDiff, { filePath: rawPath ?? undefined });
	}

	// 没有新信息就不增加结果区正文。
	return undefined;
}
// 按预览与最终错误选择背景回调，输入状态/主题，返回(text)=>着色文字，不立即画组件。
// 优先预览：预览错误红、预览成功绿；仅无预览才看settledError，其余待处理色。成功预览并不保证实际写入成功，也可能优先于后来的settledError。
function getEditHeaderBg(
	// 可能已有diff或error预览。
	preview: EditPreview | undefined,
	// 最终错误状态可还未设置。
	settledError: boolean | undefined,
	// 主题提供不同背景色。
	theme: Theme,
	// 返回函数类型，背景在Box实际render时套到行文字上。
): (text: string) => string {
	// 有预览就使用预览类别，优先级高于settledError。
	if (preview) {
		// error字段存在表示预览失败。
		if ("error" in preview) {
			// 回调输入行文字、返回错误背景样式，不抛一个业务错误。
			return (text: string) => theme.bg("toolErrorBg", text);
		}
		// 成功预览用成功背景，只说明预览材料当时能算出diff。
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	// 无预览且最终错误时用错误背景。
	if (settledError) {
		// 返回错误背景回调。
		return (text: string) => theme.bg("toolErrorBg", text);
	}
	// 尚未有预览/最终错误就用待处理背景回调。
	return (text: string) => theme.bg("toolPendingBg", text);
}
// 重建调用区Box，输入组件/参数/主题/cwd/水平留白，返回同一组件并修改子列表，无读取写入。
// 先背景/留白→清旧子项→标题→已有预览正文；例：预览完成后同一Box由标题扩成标题+diff，而不另新增工具调用。
function buildEditCallComponent(
	// 要原地更新的调用Box。
	component: EditCallRenderComponent,
	// 宽松展示参数。
	args: RenderableEditArgs | undefined,
	// 主题。
	theme: Theme,
	// 路径显示基准cwd。
	cwd: string,
	// 宿主outputPad设置，替代默认水平留白。
	outputPad: number,
	// 返回同一组件引用，便于宿主复用。
): EditCallRenderComponent {
	// 根据实际优先规则设置背景函数，Box稍后渲染时应用。
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	// 按宿主设置调整横向留白，并使Box布局缓存失效。
	component.setPaddingX(outputPad);
	// 清旧子组件，不清preview字段。
	component.clear();
	// 重新加入零自身留白的标题Text，由Box提供边距。
	component.addChild(new Text(formatEditCall(args, theme, cwd), 0, 0));

	// 没有预览就只显示标题。
	if (!component.preview) {
		// 提前返回现有组件，不制造空正文行。
		return component;
	}

	// 准备预览正文字符串。
	const body =
		// error分支用错误色，成功分支把diff转成增删着色文字。
		"error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
	// 标题与预览间留一个逻辑空行。
	component.addChild(new Spacer(1));
	// 加入预览正文Text，外层Box负责留白。
	component.addChild(new Text(body, 0, 0));
	// 返回重建后的同一Box。
	return component;
}
// 记录新预览并判断可见预览是否变化，输入组件/成功或错误预览/参数键，返回boolean；会覆盖preview/key并清pending。
// 例如相同diff/首变行返回false以省重建，但仍写新引用；argsKey变化本身不计changed，外层另处理参数重置。
function setEditPreview(
	// 要修改的组件。
	component: EditCallRenderComponent,
	// 新预览，可能来自异步计算或最终结果。
	preview: EditPreview,
	// 所属参数键，可尚无。
	argsKey: string | undefined,
	// 返回可见预览变化标记，不等于参数/所有字段深比较。
): boolean {
	// 取旧预览引用，比较前不改它。
	const current = component.preview;
	// 三个条件任一命中就认为展示变化。
	const changed =
		// 首次没有预览必然变化，并利用||短路避免下面对undefined用in。
		current === undefined ||
		// 新旧都有error时进入错误文字比较。
		("error" in current && "error" in preview
			? // 错误文本不同才变更，同文不重建。
				current.error !== preview.error
			: // 否则比较两边是否同为错误分支，成功/错误类别变化也算变化；in优先于!==。
				"error" in current !== "error" in preview) ||
		// 不是错误的旧预览才继续比较成功字段。
		(!("error" in current) &&
			// 新预览也必须不是error分支。
			!("error" in preview) &&
			// 成功diff或首变行任一不同即变化，不做字符串以外深比较。
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	// 无论changed真假，都保存新预览对象。
	component.preview = preview;
	// 更新参数归属键，便于在途回调检查。
	component.previewArgsKey = argsKey;
	// 清掉该组件的在途标记，不代表取消了已经启动的Promise。
	component.previewPending = false;
	// 返回显示变化标记供结果槽决定是否重建调用Box。
	return changed;
}

// edit两项渲染方法，普通内置edit定义另设renderShell:"self"，此对象只提供方法不自行开启外壳策略。
export const editRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	// 调用渲染回调接参数/主题/context，返回Box；完整参数且没预览时启动只读异步计算，立即先画标题。例：oldText不存在时异步出现预检错误，不写文件。
	renderCall(args, theme, context) {
		// 取得可复用Box并放共享state。
		const component = getEditCallRenderComponent(context.state, context.lastComponent);
		// 只有参数材料足够且形状可用才形成预览输入。
		const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
		// 把路径/替换数组序列化为参数键，供异步结果归属比较；不是文件内容指纹，也不含mtime/cwd。
		const argsKey = previewInput ? JSON.stringify({ path: previewInput.path, edits: previewInput.edits }) : undefined;

		// 参数键不同就使旧预览状态失效。
		if (component.previewArgsKey !== argsKey) {
			// 清掉上一套参数预览。
			component.preview = undefined;
			// 记录当前参数键。
			component.previewArgsKey = argsKey;
			// 允许新参数启动自己的计算；旧Promise仍在运行，不主动取消。
			component.previewPending = false;
			// 清上一套参数最终错误标记。
			component.settledError = false;
		}

		// 仅argsComplete且有完整输入、无既有预览、无在途计算时才发起读取；结果重放可不满足argsComplete。
		if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
			// 先标在途，避免下一次render重复启动。
			component.previewPending = true;
			// 捕获本次参数键供异步完成时比较。
			const requestKey = argsKey;
			// 实际调用只读computeEditsDiff并附then，void不等待预览，回调收到diff或常见文件/计算错误对象。这里未附catch，路径解析等若在被调函数try外拒绝不会自动转预览数据，也不取消在途读取。
			void computeEditsDiff(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
				// 只有组件仍属于同一参数键才接受结果；它防另一套参数回写，不保证文件未变或相同参数多次计算的严格时序。
				if (component.previewArgsKey === requestKey) {
					// 保存此预览并清pending，忽略返回changed，因为下面总要请求刷新。
					setEditPreview(component, preview, requestKey);
					// 通知宿主使工具行失效并请求重绘，实际新正文在下一次build中构造。
					context.invalidate();
				}
			});
		}

		// 无论异步是否完成，立即构造当前可显示调用区。
		return buildEditCallComponent(
			// 复用的Box引用。
			component,
			// 原始展示参数，不把预览输入当执行参数写回。
			args as RenderableEditArgs | undefined,
			// 当前主题。
			theme,
			// 本工具行cwd。
			context.cwd,
			// 水平留白设置。
			context.outputPad,
		);
	},
	// 结果渲染回调输入执行结果/未使用options/主题/context，返回容器；先用最终diff回填调用预览并刷新必要状态，再仅显示独立错误/差异，避免重复大diff。例：历史重放没有文件也能用结果details恢复预览，不重写文件。
	renderResult(result, _options, theme, context) {
		// 取共享state里的调用Box，结果槽与调用槽因此能协调。
		const callComponent = context.state.callComponent;
		// 按同一宽松参数规则整理用于关联的输入，不读文件。
		const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
		// 生成结果对应参数键，形状与调用槽一致。
		const argsKey = previewInput ? JSON.stringify({ path: previewInput.path, edits: previewInput.edits }) : undefined;
		// 断言结果展示形状，不验证详情内容。
		const typedResult = result as EditToolResultLike;
		// 错误结果不取diff，防把失败的details当成功预览。
		const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
		// 累计是否需要重建调用区。
		let changed = false;
		// 调用区Box存在时才能回填/改背景。
		if (callComponent) {
			// 真实字符串diff（包括空串）才用于回填，结果边界仍做实际类型判断。
			if (typeof resultDiff === "string") {
				// 累计本次预览改变状态。
				changed =
					// 调用共享setter统一记录字段/比较。
					setEditPreview(
						// 要更新的调用Box。
						callComponent,
						// 最终diff及首变行，后者允许undefined。
						{ diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
						// 最终结果归属的参数键。
						argsKey,
						// setter先执行，再与旧changed合并，避免changed真时||短路跳过写入。
					) || changed;
			}
			// 最终错误标记改变也需刷新调用区。
			if (callComponent.settledError !== context.isError) {
				// 同步记录当前错误状态；背景函数仍优先预览类别。
				callComponent.settledError = context.isError;
				// 标记需要重建。
				changed = true;
			}
			// 只在可见预览/错误状态变化时重建调用区，减少不必要布局变动。
			if (changed) {
				// 更新同一调用Box而非再创建第二份。
				buildEditCallComponent(
					// 传已有组件。
					callComponent,
					// 使用本工具行原参数显示标题。
					context.args as RenderableEditArgs | undefined,
					// 当前主题。
					theme,
					// 本工具行cwd。
					context.cwd,
					// 当前水平留白。
					context.outputPad,
				);
			}
		}

		// 再判断结果区是否还有调用预览之外的新内容。
		const output = formatEditResult(
			// 参数供路径展示。
			context.args as RenderableEditArgs | undefined,
			// 传当前已回填的预览，因此相同最终diff通常不会再重复输出。
			callComponent?.preview,
			// 最终结果对象。
			typedResult,
			// 主题。
			theme,
			// 错误标志。
			context.isError,
		);
		// 结果槽优先复用Container，首次创建；与调用Box不是同一个组件槽。
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		// 清上次结果子项，准备当前额外内容。
		component.clear();
		// 没有额外正文时仍返回空容器，保持渲染器返回组件契约。
		if (!output) {
			// 空容器不占结果正文行，原始工具结果仍保留。
			return component;
		}
		// 有独立正文则先留一空行。
		component.addChild(new Spacer(1));
		// 正文Text使用宿主水平留白，纵向0，给错误/差异明确布局。
		component.addChild(new Text(output, context.outputPad, 0));
		// 交回结果组件。
		return component;
	},
};
