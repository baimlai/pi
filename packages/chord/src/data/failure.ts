// 文件导读
// 所属包与模块：packages/chord/src/data 的失败原因模块（layer-1），服务 Chord 的 open/依赖等待/重试策略。
// 职责边界：把一次失败归类为 transient/broken/waiting，并构造 waiting 的标准消息；不执行重试、不调度定时器、
// 不访问 I/O，也不读取错误代码来猜类别（类别由失败发生阶段决定）。
// 上游：host 的 open/调用/等待路径捕获错误后调用 openFailure 或 waitingFor。下游：重试、park、唤醒逻辑按
// kind 决定策略；消息格式会被下游剥离以找到根因，并进入遥测。
// 错误流向：本文件不抛出这些错误，只构造并返回；调用方决定抛出或上报。ChordError 的 code 表达内容，
// kind 表达恢复策略，两者不能互相推断。
// 能力清单：
// - FailureCause（联合类型）：transient/broken/waiting 三种原因，均带 ChordError。
// - broken（函数）：把 open 的抛出原因标记为不可自动恢复。
// - openFailure（函数）：把 open 的实际抛出值转成 FailureCause。
// - waitingFor（函数）：为依赖失败构造带“waiting for ...”消息的 waiting 原因。
// - sameCause（函数）：按可见字段比较两个原因。
// 组合关系与典型调用顺序：open 抛错 -> openFailure 得到 transient/broken；依赖 B 失败 -> waitingFor(A, err)
// 构造 A 的等待原因 -> sameCause 在唤醒时去重。消息长度常量仅供 waitingFor/clipped/rootMessage 使用。
// 示例（真实签名）：throw broken(new Error("bad config"));
// const cause = waitingFor("session S1", asChordError(error, "open"));
// 建议阅读顺序：先 FailureCause，再看 broken/openFailure 的边界，然后 waitingFor 与三个消息辅助函数，
// 最后 sameCause 与 BrokenOpen。

// Failure causes: transient (the object's own effect failed: retry later), broken (its own code, a cycle or authority:
// retry by hand) or waiting (not its fault: no provider, no fitting version, a dependency that failed; woken by an
// event). The failing stage decides, never the error code.

import { asChordError, ChordError } from "./errors.ts";

/** Why an object, or a request, is failed; the kind comes from the failing stage, never from the error code. */
// 三个 kind 表示恢复策略：transient 可退避重试，broken 需外部触发，waiting 等供应者变化。
// code 表达错误内容，kind 表达失败发生阶段，两者不能互相代推。readonly 不冻结 Error 实例。
export type FailureCause =
	| { readonly kind: "transient"; readonly error: ChordError }
	| { readonly kind: "broken"; readonly error: ChordError }
	| { readonly kind: "waiting"; readonly error: ChordError };

/** Marks an open's failure as broken (bad configuration): `throw broken(error)`. */
// 给 open 的任意抛出原因加显式“配置等不可自动恢复”标记，返回 Error 而不直接抛出。
// 示例 throw broken(new Error("bad config"))；只包装本地原因，openFailure 识别该类，不进行 I/O。
export function broken(cause: unknown): Error {
	// 创建私有标记类实例，避免用消息文字来猜测故障类别。
	return new BrokenOpen(cause);
}

/** The cause of a value thrown by an open: broken when it came from `broken()`, transient otherwise. */
// 将 open 实际抛出的 unknown 值转成 FailureCause；私有 broken 标记走 broken，其余走 transient。
// 例如普通 Error("offline") 会包装为 unavailable 的 transient；不从 error.code 猜类别，无 I/O。
export function openFailure(thrown: unknown, label: string): FailureCause {
	// 识别标记并解出原 cause，再由 asChordError 统一错误形状。
	if (thrown instanceof BrokenOpen) return { kind: "broken", error: asChordError(thrown.cause, label) };
	// 未显式标记的一律是开资源阶段的瞬时失败，由上层决定退避安排。
	return { kind: "transient", error: asChordError(thrown, label) };
}

/** The longest message a `waiting` cause of a dependent carries (telemetry's rule for error messages). */
// 等待消息上限以 JavaScript 字符串长度计（UTF-16 码元），不是 UTF-8 字节计。
const MESSAGE_LIMIT = 500;

/** How a dependent's message names its blocker: the nearest one first. */
const PREFIX = "waiting for ";

/** The separator after a blocker's label. */
const SEPARATOR = ": ";

/** The marker of a clipped label or root. */
const CLIPPED = "…";

/** The most of the 500 characters the root cause takes when both are long: the nearest blocker keeps the rest. */
const ROOT_LIMIT = 320;

/**
 * The `waiting` cause of a dependent parked on `blocker`, which failed with `error`: `unavailable`, its message always
 * "waiting for <blocker>: <root cause>" (the root found through any "waiting for …: " of `error`'s message), so a ring
 * of waiting attempts passing causes round reaches the same message after one round; within 500 characters, the
 * label clipped first, the root only past its share. `error` is its cause.
 */
// 为依赖失败生成 waiting 原因，输入最近阻挡者名称和 ChordError，返回新 unavailable 错误。
// 先剥离嵌套 waiting for 前缀，再控制根消息/名称长度，cause 保留原错误；不设定时器、不重试。
// 例如 A 等 B，而 B 的消息为 "waiting for C: offline"，结果是 "waiting for B: offline"。
export function waitingFor(blocker: string, error: ChordError): FailureCause {
	// 从现有消息文字剥掉连续等待标签，避免依赖环每传一轮就把名字无限加长。
	let root = rootMessage(error.message);
	// 默认保留最近的 blocker 名字；过长时只修改本地字符串变量。
	let label = blocker;
	// 预先减去固定前缀和分隔符所占长度，余下分给名称和根消息。
	const room = MESSAGE_LIMIT - PREFIX.length - SEPARATOR.length;
	// 只有两段总长超过预算才进入裁剪，不影响正常短消息。
	if (label.length + root.length > room) {
		// 根消息至少获得 ROOT_LIMIT 的预算；名称较短时还能把剩余位置让给根消息。
		const rootRoom = Math.max(ROOT_LIMIT, room - label.length);
		// 根消息超过分给它的份额时加省略号裁剪。
		if (root.length > rootRoom) root = clipped(root, rootRoom);
		// 裁剪根消息后仍超长，就把最近阻挡者的标签压到剩余空间。
		if (label.length + root.length > room) label = clipped(label, room - root.length);
	}
	// 构造稳定的单层等待消息，固定前缀便于下一层继续找根原因。
	const message = `${PREFIX}${label}${SEPARATOR}${root}`;
	// 返回新原因但保留本地 cause 链；不改变传入 error，也不把 cause 直接发到线上。
	return { kind: "waiting", error: new ChordError({ code: "unavailable", message }, { cause: error }) };
}

/** `text` within `length` characters, clipped with "…" when longer. */
// 把文本限制到指定长度，超长时尾部用省略号替代；例如 clipped("abcdef",4) 为 "abc…"。
// 这里直接按字符串位置切片，不处理完整 Unicode 字素；输入预算由 waitingFor 计算，无 I/O。
function clipped(text: string, length: number): string {
	// 没超过预算就保留原文字，超过时给省略号预留自身长度。
	return text.length <= length ? text : `${text.slice(0, length - CLIPPED.length)}${CLIPPED}`;
}

/** The root cause in a "waiting for X: root" message: past every leading "waiting for …: ". */
// 从消息开头连续去掉 "waiting for 名称: "，返回最终尾部，不读取 Error.cause。
// 例如 "waiting for A: waiting for B: bad" 得 "bad"；若没有分隔符就原样保留剩余文字。
function rootMessage(message: string): string {
	// 用局部变量逐步推进，不修改原错误对象的 message。
	let rest = message;
	// 仅处理处在最开头的约定前缀，正文里的同样字样不会被任意删除。
	while (rest.startsWith(PREFIX)) {
		// 从前缀后找首个冒号空格，作为 blocker 标签结束位置。
		const end = rest.indexOf(SEPARATOR, PREFIX.length);
		// 不完整的等待文字停止剥离，避免把正文猜成合法格式。
		if (end < 0) break;
		// 跳到本层标签后，下一轮可以继续剥离另一层等待前缀。
		rest = rest.slice(end + SEPARATOR.length);
	}
	// 返回当前找到的根消息文字。
	return rest;
}

/** Whether two failure causes say the same (a wake compares causes by value): kind, code, reason and message. */
// 按可见故障内容比较两个原因，返回 boolean，无缓存或副作用。
// 例如两个独立 Error 实例的 kind/code/reason/message 相等也算相同；details、cause、stack 不参与比较。
export function sameCause(a: FailureCause, b: FailureCause): boolean {
	// 解构并重命名为 left，使后面的字段比较清晰。
	const { error: left } = a;
	// 取得右侧错误，保持原对象引用。
	const { error: right } = b;
	// 用严格相等比较恢复类别与四项可见错误信息，供唤醒逻辑避免重复发布同原因。
	return (
		a.kind === b.kind && left.code === right.code && left.reason === right.reason && left.message === right.message
	);
}

// 仅此模块使用的标记类；外部通过 broken 创建，不依赖错误文字来识别。
class BrokenOpen extends Error {
	// 保留 open 的原抛出值为 cause，并生成可读消息；例如字符串 "bad" 也能包装，无 I/O。
	constructor(cause: unknown) {
		// unknown 是错误边界；原生 Error 取 message，其他值转字符串，同时保留原 cause。
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		// 设置本地诊断名称，不改变 asChordError 最终选择的错误代码。
		this.name = "BrokenOpen";
	}
}
