// edit 在同文件队列中完成“读原文 → 匹配多处非重叠替换 → 保留 BOM/换行 → 写回”，并生成显示 diff 与标准 patch。
// R_OK/W_OK 是 Node 文件权限检查常量；后面按位或组合为可读且可写要求。
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
// Type 创建实际 schema，Static 从 schema 推导 TS 类型；一个负责运行时规则，一个负责开发时提示。
import { type Static, Type } from "typebox";
// 拆出不可见 BOM 字符，匹配时去掉、写回时保留，避免模型 oldText 因看不到 BOM 而匹配失败。
import { splitBom } from "../../utils/text.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type EditRenderState, editRenderers } from "./renderers/edit.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";

// 定义单次替换对象 schema：oldText 是原文片段，newText 是替换后的片段。
const replaceEditSchema = Type.Object(
	{
		// 旧文本必须是字符串；唯一性与是否重叠要结合文件正文判断，不能只靠 schema 判断。
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		// 新文本允许为空字符串，表示删除旧片段。
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

// 外层参数 schema 只包含目标 path 和编辑数组。
const editSchema = Type.Object(
	{
		// 目标路径由执行时的 cwd 解析，不限制只能相对路径。
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		// 每个数组元素遵循单次替换 schema；数组顺序记录意图，实际按原始位置倒序应用避免偏移改变。
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{},
);

// 给模型说明该工具适用精确局部替换，以及多个改动怎样组织。
export const editToolSystemPromptContribution = {
	snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	guidelines: [
		"Use edit for targeted changes. Batch changes to one file in a single call.",
		"Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
	],
	// 类型层保留具体字面量；没有调用 Object.freeze，不改变运行时可变性。
} as const;

// typeof 在类型位置取 schema 类型，再由 Static 推导 path/edits 字段。
export type EditToolInput = Static<typeof editSchema>;
// 交叉类型保留新输入，同时描述可能出现的旧顶层字段；仅用于兼容整理未知输入。
type LegacyEditToolInput = EditToolInput & {
	// 旧字段可能缺失或类型错误，先用 unknown，检查后才能当字符串。
	oldText?: unknown;
	// 同上，新片段也必须在整理时确认字符串。
	newText?: unknown;
};

// 命名类型描述一项合法替换，类型本身不生成任何校验动作。
type SingleEditInput = { oldText: string; newText: string };

/**
 * 判断未知外部值是否是 {oldText:string,newText:string}；这是模型参数兼容整理前的信任边界检查。
 * 例：单个对象可包装为 edits 数组；数组、null 和非对象都不算单个编辑。
 */
function isSingleEditInput(value: unknown): value is SingleEditInput {
	// 未知模型输入边界：排除 null、非对象和数组，剩下才能检查字段。
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		// 不符合单编辑对象形状，调用者不会把它包装成 edits 数组。
		return false;
	}

	// 将已确认对象视为字符串键映射；as 不验证字段值，下一行仍需实际检查。
	const edit = value as Record<string, unknown>;
	// 只有两个字段都为字符串才成功；返回类型 value is SingleEditInput 让 TS 在调用方收窄。
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

// 文件修改后的展示详情：面向终端 diff、标准 patch 及跳转行。
export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	// 带行号和上下文的易读 diff。
	diff: string;
	/** Standard unified patch of the changes made */
	// 可用于标准补丁消费者的 unified patch。
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	// 新文件里首个变化的行号，可选，供界面跳转。
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
// 可注入文件系统后端，便于远程编辑或测试，不改变匹配算法。
export interface EditOperations {
	/** Read file contents as a Buffer */
	// 读取原始字节，随后按 UTF-8 解码。
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	// 异步整文件写回；执行器已算好最终全文。
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	// 确认目标可读写，错误通过 Promise 拒绝传播。
	access: (absolutePath: string) => Promise<void>;
}

// 默认走本机文件操作；options.operations 可替换。
const defaultEditOperations: EditOperations = {
	// 使用 Node 异步读取，返回 Buffer。
	readFile: (path) => fsReadFile(path),
	// 按 UTF-8 覆盖最终文件内容。
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	// 按位或 | 把可读与可写两个权限要求组合在一起；这里的 | 不是 TS 联合类型。
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

// 工具创建配置，模型不能通过参数自行更换后端。
export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	// 可选自定义文件后端，不传时用默认。
	operations?: EditOperations;
}

/**
 * 兼容模型可能发来的参数形状，返回交给 schema 校验的 EditToolInput；它并不执行文件编辑。
 * 流程：字符串 edits 尝试 JSON.parse → 单对象包数组 → 旧 oldText/newText 合进数组；整理失败的值保留给后续校验报告。
 * 例如 edits:"[{"oldText":"a","newText":"b"}]" 可整理为数组。本函数会修改外部参数对象的 edits 字段。
 */
function prepareEditArguments(input: unknown): EditToolInput {
	// 输入来自模型，先判断是否有可整理字段；非对象直接交后续校验拒绝。
	if (!input || typeof input !== "object") {
		// 只做类型断言让签名一致，不把错误输入转换成合法值。
		return input as EditToolInput;
	}

	// 把外部对象当未知字段映射访问，后面用运行时检查决定怎样兼容。
	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array.
	// Others send a single edit object instead of a one-element edits array.
	// 某些模型把数组编码成 JSON 字符串，先识别这种错误形状。
	if (typeof args.edits === "string") {
		try {
			// 解析外部 JSON，可能抛异常；这一步还不证明其中每项符合 schema。
			const parsed = JSON.parse(args.edits);
			// 若解析为数组，接受它作为待校验 edits。
			if (Array.isArray(parsed)) {
				// 原地更新参数对象字段；调用者之后看到的也是整理后的值。
				args.edits = parsed;
				// 若解析出来只有一项合法编辑对象，就包为一元素数组。
			} else if (isSingleEditInput(parsed)) {
				// 统一下游输入形状为数组，而非让执行器维护两套路径。
				args.edits = [parsed];
			}
			// 解析失败不吞掉整个调用；保留原坏值，让 schema 校验给模型统一反馈。
		} catch {}
		// 直接传对象的情况也兼容为数组，不需要先 JSON.stringify 再解析。
	} else if (isSingleEditInput(args.edits)) {
		// 用一项数组包住原对象，保持 oldText/newText 内容不变。
		args.edits = [args.edits];
	}

	// 临时用旧参数类型查看顶层 oldText/newText；断言不会生成字段。
	const legacy = args as LegacyEditToolInput;
	// 缺任一旧字段时不执行旧格式迁移；已有 edits 仍可交给新 schema 校验。
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		// 返回整理后的对象；正确性最终由调用管线校验。
		return args as EditToolInput;
	}

	// 已有数组浅复制后再追加旧格式项，避免直接 push 修改原数组；不是深复制每项对象。
	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	// 把确认是字符串的旧字段迁移为新数组的一项。
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	// 解构取走旧字段，...rest 保存剩余字段；前导下划线表示这些取出的值不再使用。
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	// 返回不再携带旧顶层编辑字段的新对象，同时写入统一 edits 数组。
	return { ...rest, edits } as EditToolInput;
}

/**
 * 检查 edit 至少包含一次替换，并提取 path/edits；返回供执行器使用的简化对象，无文件副作用。
 * 例：edits:[] 会抛错；完整参数形状的常规校验由 Agent schema 管线负责。
 */
function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	// 执行前要求至少一项替换；保留原实现的数组检查，不在注释任务中重构。
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		// 拒绝空编辑请求，防止读写一次却没有明确操作。
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	// 仅提取后续需要的 path/edits，保持数组元素引用。
	return { path: input.path, edits: input.edits };
}

/**
 * 创建 edit 工具定义，输入 cwd 和可选文件后端，返回 schema、参数整理器、执行函数和渲染器。
 * 例：在原文件唯一位置将 oldText:"red" 替换为 newText:"blue"；一批 edits 全部对同一份原文匹配，不能用前一替换结果作为后一项 oldText。
 */
export function createEditToolDefinition(
	// 默认工作目录，相对目标路径据此解析。
	cwd: string,
	// 宿主可选择自定义文件操作。
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	// 可选链读取配置，空缺时采用本地后端。
	const ops = options?.operations ?? defaultEditOperations;
	return {
		// 模型调用名，Agent 以它找到工具定义。
		name: "edit",
		// 终端显示名称。
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		// 将局部编辑用途摘要提供给 system 提示词组装。
		promptSnippet: editToolSystemPromptContribution.snippet,
		// 浅复制工具使用指南，原字符串完整保留。
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		// 暴露给模型并由 Agent 校验的参数规则。
		parameters: editSchema,
		// 偏好供应商按 schema 生成 JSON，不能代替本地校验。
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		// 此工具使用自带渲染壳；具体显示交给 editRenderers。
		renderShell: "self",
		// 先运行上面的输入兼容整理，再由 Agent 正常做 schema 校验。
		prepareArguments: prepareEditArguments,
		/**
		 * 执行一批精确文本替换；返回异步工具结果，副作用是覆盖目标文件，失败抛给 Agent 形成错误 toolResult。
		 * 先获得同文件队列，再做可读写检查、读取、匹配、写回；取消只停止后续阶段，不回滚已经完成的写入。
		 */
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			// 解构校验结果，取目标路径和非空替换列表。
			const { path, edits } = validateEditInput(input);
			// 会话执行目录优先，工厂目录兜底，得到绝对路径。
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);

			// 同目标文件的 read-modify-write 整体排队，避免两个编辑都基于同一旧文本互相覆盖。
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				/**
				 * 在每个异步阶段前后检查取消的局部函数；闭包从外层读取 signal。
				 * 不注册“收到 abort 就立即放行”的队列出口，否则旧 writeFile 可能未完成就与下一次修改重叠。
				 */
				const throwIfAborted = (): void => {
					// 取消只影响后续流程；在途文件操作完成前不会提前释放该文件队列。
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				// 每个阶段边界查看是否已取消，尤其 await 期间可能收到新取消请求。
				throwIfAborted();

				// Check if file exists.
				try {
					// 先确认可读写；缺文件或权限问题进入下面 catch，给模型可理解的路径错误。
					await ops.access(absolutePath);
					// 文件系统可能抛任意值，用 unknown 强制先收窄再取错误字段。
				} catch (error: unknown) {
					// 每个阶段边界查看是否已取消，尤其 await 期间可能收到新取消请求。
					throwIfAborted();
					// 准备给模型的可读文件错误说明，不把所有错误都当作文件不存在。
					const errorMessage =
						// 标准 Error 且具有 code 时展示操作系统码，否则转为字符串；这是错误边界的运行时判断。
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					// 补上用户目标路径后重新抛错，Agent 会将它作为工具失败结果。
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				// 每个阶段边界查看是否已取消，尤其 await 期间可能收到新取消请求。
				throwIfAborted();

				// Read the file.
				// 读取文件字节；await 等读完才做文本匹配。
				const buffer = await ops.readFile(absolutePath);
				// 按 UTF-8 解码成字符串，BOM 若存在也保留到下一步拆分。
				const rawContent = buffer.toString("utf-8");
				// 每个阶段边界查看是否已取消，尤其 await 期间可能收到新取消请求。
				throwIfAborted();

				// Strip BOM before matching. The model will not include an invisible BOM in oldText.
				// 把 BOM 单独保存，把 text 字段改名为 content；模型 oldText 通常不会含不可见 BOM。
				const { bom, text: content } = splitBom(rawContent);
				// 记录原换行习惯，写回时保留 LF 或 CRLF。
				const originalEnding = detectLineEnding(content);
				// 先将换行统一为 LF，避免模型 oldText 的换行与文件平台习惯不同而失配。
				const normalizedContent = normalizeToLF(content);
				// 核心算法验证每项唯一/不重叠并计算最终文本；算法可能做 Unicode 容错，未写磁盘。
				const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
				// 每个阶段边界查看是否已取消，尤其 await 期间可能收到新取消请求。
				throwIfAborted();

				// 把编辑结果恢复原换行，再拼回 BOM，减少无关格式变化。
				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				// 实际覆盖目标；此后即使取消，也不能声称文件未变化或自动回滚。
				await ops.writeFile(absolutePath, finalContent);
				// 每个阶段边界查看是否已取消，尤其 await 期间可能收到新取消请求。
				throwIfAborted();

				// 计算终端可读 diff 与第一变化行，用于展示本次实际文本差异。
				const diffResult = generateDiffString(baseContent, newContent);
				// 生成标准 unified patch，包含路径与上下文，供程序/界面使用。
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				return {
					// 模型看到的是成功说明；详细 diff/patch 放在 details，避免默认把全部补丁塞回模型。
					content: [
						{
							// 内容块的标签，TS 和供应商可据此识别文字。
							type: "text",
							// 模板插入替换块数和目标路径，不把修改前后整文件重复返回。
							text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
						},
					],
					// 详情给终端渲染/跳转；patch 是同名属性简写。
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
		// 合入编辑预览与结果显示函数，执行算法与界面解耦。
		...editRenderers,
	};
}

/**
 * 为独立低层 Agent 创建 edit 适配工具；工厂阶段不读取或修改文件。
 * 输入 cwd/options，内部先创建定义再 wrapper 转发，返回 AgentTool。
 */
export function createEditTool(cwd: string, options?: EditToolOptions): TypeBoxAgentTool<typeof editSchema> {
	// 创建定义再适配为 AgentTool，这一步不访问文件。
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
