// 所属：packages/durable/src/tools，工具层的路径整理与解析辅助。
// 解决的问题：模型经常把复制来的路径带上特殊 Unicode 空格或开头的 @；同时相对路径必须按本次执行环境的 cwd
// 解析，不能按宿主 Node 进程的 cwd。图片文件还可能出现 AM/PM 窄空格、NFD 分解等名称变体。
// 职责边界：只做字符串整理并调用 ExecutionEnv 的路径 API；不读文件内容（resolveReadToolPath 只调用 exists 探测），
// 不创建文件、不枚举目录，也不定义“绝对路径”的平台细节（由具体环境实现决定）。
// 上游：read/write/edit 的 execute。下游：normalizeToolPath（纯函数）、ExecutionEnv.absolutePath/exists，以及
// env/index.ts 的 getOrThrow。
// 能力清单：
// - resolveToolPath(env, path, context)：整理后解析为绝对路径；解析失败抛 FileError。
// - resolveReadToolPath(env, path, context)：只读场景下依次尝试常见视觉变体，返回第一个存在的路径；都不存在时
//   返回原绝对路径，让后续打开文件报告原始错误。
// 组合：write/edit 直接调用 resolveToolPath；read 调用 resolveReadToolPath，因此读取比写入更宽容。
// 示例（真实签名）：
//   const absolute = await resolveReadToolPath(env, "@a.ts", context); // cwd=/repo 时通常得到 /repo/a.ts
// 建议阅读顺序：先看 UNICODE_SPACES 与 normalizeToolPath，再看 resolveToolPath，最后看 resolveReadToolPath 的
// 变体查找顺序。
import type { Context } from "@earendil-works/chord/context";
import { type ExecutionEnv, getOrThrow } from "../env/index.ts";

// g 表示替换所有匹配项；这些视觉上近似空格的字符可能来自复制的文件路径。
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

/** 纯字符串整理：将特殊空格变为普通空格，并去掉一个开头的 @；例如 @a.ts 变为 a.ts，不访问文件。 */
function normalizeToolPath(path: string): string {
	// replace 返回新字符串，不修改传入的 path。
	const normalized = path.replace(UNICODE_SPACES, " ");
	// 条件表达式只移除第一个 @，不会在这里展开 ~ 或解析 ..。
	return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}

/**
 * 按 env 的工作目录解析整理后的 path，context 传递取消等调用上下文；返回绝对路径。
 * 只调用环境的路径解析，不检查文件存在；环境返回失败时 getOrThrow 抛出原错误。
 * 例如 cwd=/repo 时，a.ts 通常由环境解析为 /repo/a.ts；具体路径语义由该环境决定。
 */
export async function resolveToolPath(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	// await 等待 Result；getOrThrow 在成功分支取 value，在失败分支抛 error。
	return getOrThrow(await env.absolutePath(normalizeToolPath(path), context));
}

/**
 * 为只读操作尝试常见的路径字符变体；参数与 resolveToolPath 相同，返回首个存在的路径。
 * 会依次访问 exists，任一环境错误向外抛；都不存在时返回原绝对路径，让后续打开文件报告错误。
 * 例如普通空格加 PM. 的截图名还会尝试窄不换行空格版本；不会枚举目录或保证找到所有相似文件。
 */
export async function resolveReadToolPath(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	// 先完成统一的 @ 与空格整理，所有候选都基于这条绝对路径。
	const resolved = await resolveToolPath(env, path, context);
	// 顺序就是查找优先级：原样、AM/PM 特殊空格、分解式 Unicode、弯单引号、分解式加弯单引号。
	const variants = [
		resolved,
		resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
		resolved.normalize("NFD"),
		resolved.replace(/'/g, "\u2019"),
		resolved.normalize("NFD").replace(/'/g, "\u2019"),
	];

	// Set 保留插入顺序并去重，避免相同路径多次向环境查询。
	for (const variant of new Set(variants)) {
		// 只接受 exists 的 true；错误不会被当作“不存在”吞掉。
		if (getOrThrow(await env.exists(variant, context))) return variant;
	}
	// 不在这里创建文件，也不把查找失败转成自定义异常。
	return resolved;
}
