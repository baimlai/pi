// 所属：packages/durable/src/tools，Durable 内置的精确文本替换工具（edit）。
// 解决的问题：模型经常用“找到一段原文，替换成新文本”的方式改文件，但可能会漏转义、给出重复匹配或重叠区间，
// 也可能把 edits 写成 JSON 字符串/单个对象。这里统一修复参数形状、校验唯一性与重叠、保留 BOM 与换行风格，
// 并在同一文件的并发写之间排队。
// 职责边界：只编辑已存在的单个文件；不创建文件（write 的职责）、不做模糊的人为猜测（只有空白/引号等有限
// 归一化，见 edit-diff.ts）、不负责回滚。写入前的差异计算只用于展示，不参与实际写入。
// 上游：Harness ToolTask 调用 createEditTool() 生成的工具。下游：requireEnv、resolveToolPath、
// withFileMutationQueue、edit-diff.ts 的归一化/匹配/差异函数、ExecutionEnv 的 fileInfo/readTextFile/writeFile。
// 能力清单（导出项）：
// - EditToolInput：由 editSchema 推导的编译期参数类型 { path, edits[] }。
// - EditToolDetails：结果 details，包含展示用 diff、统一 patch 和首个变化行号。
// - createEditTool()：返回 name 为 "edit" 的 ToolRegistration；构造时不读写文件。
// 组合与流向：prepareArguments 先修补常见参数错误（仍需通过 schema 校验）→ execute 校验 edits 非空 →
// 解析绝对路径 → 文件队列内读取原文件 → 去 BOM、记录换行风格、统一为 LF → 应用替换 → 恢复 BOM/换行 →
// 写回 → 生成 diff/patch。
// 示例（真实签名）：
//   const edit = createEditTool();
//   // 模型调用 edit({ path: "a.txt", edits: [{ oldText: "foo", newText: "bar" }] })
//   // 成功时 result.details.diff 为带行号的展示差异，result.details.patch 为标准 unified patch。
// 建议阅读顺序：先看两个 schema 与三个参数类型，再看 isSingleEditInput/prepareEditArguments（参数修复），
// 然后读 validateEditInput 与 createEditTool 的 execute 流程；匹配与差异细节去 edit-diff.ts。
import { arr, obj, type Static, str } from "@earendil-works/pi-schema";
import type { FileError } from "../env/index.ts";
import { defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { requireEnv } from "./env.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";

// 单条替换的运行时 schema：oldText/newText 都必填字符串。open:true 允许额外字段，兼容模型多传的内容。
// description 是给模型看的约束：oldText 必须在原文件中唯一，且同一次调用的多条 oldText 不能重叠。
const replaceEditSchema = obj(
	{
		oldText: str({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: str({ description: "Replacement text for this targeted edit." }),
	},
	{ open: true },
);

// edit 工具参数：path 必填，edits 是非空的替换数组。arr 只表达“数组”，非空由 execute 的 validateEditInput
// 在运行时检查（schema 本身没有 minItems 约束）。
const editSchema = obj(
	{
		path: str({ description: "Path to the file to edit (relative or absolute)" }),
		edits: arr(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{ open: true },
);

// Static 把 schema 的构建器类型转成 TS 参数类型；它不产生运行时代码，也不代替 Harness 的校验。
export type EditToolInput = Static<typeof editSchema>;
// 兼容旧模型输出：把 oldText/newText 放在参数顶层，而不是 edits 数组里。
type LegacyEditToolInput = EditToolInput & { oldText?: unknown; newText?: unknown };
// 单个替换对象的内部形状；只在参数修复时使用，不是导出的公开 API。
type SingleEditInput = { oldText: string; newText: string };

// 类型谓词（value is SingleEditInput）：返回 true 时 TypeScript 在调用处把 unknown 收窄为 SingleEditInput。
// 运行时确实检查了对象非空、非数组且两个字段都是字符串，因此这不是仅靠断言。
function isSingleEditInput(value: unknown): value is SingleEditInput {
	// 先排除 null、非对象和数组；数组虽然 typeof 为 "object"，但不会是本函数的合法输入。
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	// as Record<string, unknown> 只用于按键读取未知对象；字段仍逐个做 typeof 检查。
	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

/**
 * Repair shapes models commonly send: `edits` as a JSON string or as a single edit object, and a top-level
 * `oldText`/`newText` pair. Works on a copy; the call's arguments stay unchanged.
 */
// 在 Harness 校验 schema 之前修补模型常见的错误参数形状；返回新的 EditToolInput，原 input 不被修改。
// 处理三种情况：edits 是 JSON 字符串、edits 是单个对象、顶层直接给 oldText/newText。无法识别的形状原样返回，
// 交给 schema 校验报错。纯函数：复制对象、不写文件、不抛业务错误（JSON.parse 的异常被吞掉后保留原值）。
// 例：{ path:"a", edits:'[{"oldText":"x","newText":"y"}]' } → edits 变成数组。
function prepareEditArguments(input: unknown): EditToolInput {
	// 非对象（含 null/数组）无法修补，直接交给后续校验；这里的 as 只用于满足返回类型。
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as EditToolInput;
	// 浅拷贝顶层，确保下面的修改不会影响调用方传入的参数对象；edits 数组元素仍共享引用。
	const args: Record<string, unknown> = { ...input };
	if (typeof args.edits === "string") {
		// 模型有时把整个 edits 数组序列化成字符串。
		try {
			const parsed: unknown = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				// JSON 字符串里是单个替换对象时包成数组。
				args.edits = [parsed];
			}
		} catch {}
		// 解析失败时保留原字符串，让 schema 校验给出明确的类型错误；空 catch 是有意为之。
	} else if (isSingleEditInput(args.edits)) {
		// edits 直接给成单个对象而不是数组。
		args.edits = [args.edits];
	}

	// 旧格式：顶层 oldText/newText。先按 LegacyEditToolInput 读取这两个未知字段。
	const legacy = args as LegacyEditToolInput;
	// 两个字段都必须是字符串才视为旧格式；否则原样返回，避免吞掉真正的参数错误。
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") return legacy;
	// 已有 edits 数组时复制一份再追加，避免修改原数组；没有时从空数组开始。
	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	// 解构重命名 oldText/newText 为 _oldText/_newText，只是为了把这两个顶层字段从 rest 中剔除；
	// 解构赋值本身不调用任何函数。...rest 收集其余字段。
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits };
}

// 返回给 UI/程序的结果详情：diff 是带行号的展示文本，patch 是标准 unified diff；
// 只有发生截断或首行超限等情况下 firstChangedLine 才可能缺省（? 表示可选属性，仅编译期约束）。
export type EditToolDetails = {
	diff: string;
	patch: string;
	firstChangedLine?: number;
};

// schema 只保证 edits 是数组；这里补上运行时约束“至少一条”，并返回可用的 path/edits。
// 参数已由 Harness 校验过类型，因此这里不重复 typeof 检查；空数组仍是 schema 不表达的业务规则。
function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

// 把环境的 FileError 包装成面向模型的 Error，保留原始错误作为 cause（ES2022 的 Error options）。
// 消息里带路径和机器可读的 code，便于模型/用户判断是权限、目录还是不存在。
function editAccessError(path: string, error: FileError): Error {
	return new Error(`Could not edit file: ${path}. Error code: ${error.code}.`, { cause: error });
}

// 创建 edit 工具注册；无参数。构造时不读文件、不安装工具，execute 由 Harness 在模型调用时触发。
// 第二个泛型参数 EditToolDetails 约束 execute 返回的 details 形状；返回值仍是普通注册对象。
// 例：registry.install(defineExtension({ name: "files", tools: [createEditTool()] })) 后模型才会看到 edit。
export function createEditTool(): ToolRegistration<typeof editSchema, EditToolDetails> {
	// defineTool 是恒等函数，负责把 parameters 与 args、details 的 TS 类型关联起来。
	return defineTool({
		name: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		parameters: editSchema,
		// Harness 会在 schema 校验前调用它修复常见参数形状；返回结果仍会被 schema 再校验一次。
		prepareArguments: prepareEditArguments,
		// args 已经由 schema 推导出类型；api 提供环境、提交与诊断等能力；context 携带取消信号。
		async execute(args, api, context) {
			// 运行时补足 schema 不表达的非空约束，并取出类型化后的 edits 数组。
			const { path, edits } = validateEditInput(args);
			// 没有执行环境就直接失败，不回退到宿主进程文件系统。
			const env = requireEnv(api);
			// 统一字符整理后按环境 cwd 解析为绝对路径；解析失败会抛 FileError。
			const absolutePath = await resolveToolPath(env, path, context);
			// 同一文件的 edit/write 串行；参数是环境、绝对路径、实际修改回调和上下文。
			return withFileMutationQueue(
				env,
				absolutePath,
				async () => {
					// 可能已在队列中等待，因此拿到队位后重新检查取消。
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					// 先确认目标存在及其类型；fileInfo 失败保留环境错误码。
					const info = await env.fileInfo(absolutePath, context);
					if (!info.ok) throw editAccessError(path, info.error);
					// 只编辑普通文件；符号链接允许（读取会跟随到目标），目录等其他类型拒绝。
					if (info.value.kind !== "file" && info.value.kind !== "symlink") {
						throw new Error(`Could not edit file: ${path}. Path is not a file.`);
					}

					// 读取完整文本内容；edit 是整文件读-改-写，不做流式编辑。
					const readResult = await env.readTextFile(absolutePath, context);
					if (!readResult.ok) throw editAccessError(path, readResult.error);
					// 读文件期间也可能被取消，写回前尽早返回。
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");

					// 暂存并剥离 UTF-8 BOM，写回时再补回；text: content 是解构重命名。
					const { bom, text: content } = stripBom(readResult.value);
					// 记录原文件主要使用的换行风格（CRLF 或 LF），写回时恢复，避免整文件换行被改写。
					const originalEnding = detectLineEnding(content);
					// 匹配前统一成 LF，避免模型给的 oldText 与文件 CRLF 不匹配。
					const normalizedContent = normalizeToLF(content);
					// 在统一换行后的内容上应用全部替换；内部会检查唯一性、重叠和不产生变化的情况。
					const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
					// 替换计算完成后再次检查取消，然后再写文件。
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");

					// 恢复 BOM 和原换行风格，得到最终写回内容。
					const finalContent = bom + restoreLineEndings(newContent, originalEnding);
					// 覆盖写回；失败时包装为带路径和错误码的 Error。
					const writeResult = await env.writeFile(absolutePath, finalContent, context);
					if (!writeResult.ok) throw editAccessError(path, writeResult.error);
					// 写入已经发生；这里的取消检查只能报告取消，不能撤销写入。
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");

					// base/new 都是 LF 归一化后的文本，差异展示不包含换行风格变化。
					const diffResult = generateDiffString(baseContent, newContent);
					const details: EditToolDetails = {
						diff: diffResult.diff,
						patch: generateUnifiedPatch(path, baseContent, newContent),
						// 条件展开：firstChangedLine 为 undefined 时不添加该键，而不是写成 undefined。
						...(diffResult.firstChangedLine === undefined
							? {}
							: { firstChangedLine: diffResult.firstChangedLine }),
					};
					// output 是模型可见的成功文本；details 给 UI，不进入模型上下文。
					return {
						output: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
						details,
					};
				},
				context,
			);
		},
	});
}
