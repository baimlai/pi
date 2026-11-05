// The control channel between the server and a worker (slice 10 §3): JSON messages beside the link's `Uint8Array`
// frames on one IPC channel (the IPC link skips them), and errors as they cross it (`{ message, code?, reason? }`,
// never a stack or a cause).

// 文件导读
// 所属模块：packages/chord/src/node/workers，服务器进程与 worker 子进程之间的控制通道。
// 解决的问题：同一条 IPC 通道既传 link 的二进制帧，又传启动/停止/重载等控制消息；控制消息必须有稳定信封，
//   跨进程的错误只能保留可公开的 message/code/reason，不能带堆栈或 cause。
// 职责边界：只定义消息形状、信封识别、错误与重载报告的双向转换；不拥有 IPC 连接、不 fork 进程、不决定重试。
// 上游：process.ts 的 WorkerProcess 在收到 IPC 消息时调用 controlOf；main.ts 的 Worker 和 workers.ts 的
//   WorkersComponent 处理具体消息。下游：子进程收到 ToWorker 后执行动作，服务器收到 FromWorker 后更新状态。
// 结果以进程事件形式流向调用方；错误在跨边界时被 crossed 压缩，在另一侧由 uncrossed 还原。
// 能力清单：
// - CrossedError、CrossedCause、CrossedReport：可跨 IPC 的错误、失败原因和重载报告。
// - ToWorker：服务器发给 worker 的 start/shutdown/reload 联合。
// - FromWorker：worker 发给服务器的 started/ready/idle/fatal/reloaded 联合。
// - envelope()、ENVELOPE、controlOf()：控制消息的信封与识别。
// - crossed()、uncrossed()：单个错误的跨进程转换与还原。
// - crossedReport()、uncrossedReport()：重载报告的跨进程转换与还原。
// 组合关系：WorkersComponent -> WorkerProcess.send(envelope(ToWorker)) -> 子进程 controlOf -> Worker.#message；
//   子进程 #send(envelope(FromWorker)) -> 服务器 controlOf -> WorkersComponent.#control；报告与错误在发送前 crossed。
// 示例：
//   const message = controlOf<FromWorker>({ "chord.workers": { kind: "idle", idle: true } });
//   // message?.kind === "idle"；其他 IPC 消息（link 帧）返回 undefined
//   const restored = uncrossed(crossed(new Error("boom"))); // Error("boom")，不保留原堆栈
// 建议阅读顺序：先看 ToWorker/FromWorker 的字段，再看 envelope/controlOf 的信封规则，最后看 crossed/uncrossed
//   与报告转换如何处理错误细节。

import type { Address } from "../../contracts/index.ts";
import { ChordError, type FailureCause, isChordError } from "../../data/index.ts";
import { chordErrorFromJson } from "../../data/internal.ts";
import type { ReloadReport } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import type { PluginScript } from "../plugins/runtime.ts";

/** An error as it crosses: its message, and a ChordError's code and reason. */
// 跨 IPC 的错误只保留这三个可序列化字段；stack、cause、自定义属性都不传输，避免泄露内部细节。
export type CrossedError = { readonly message: string; readonly code?: string; readonly reason?: string };

/** A reload report as it crosses: its errors crossed. */
// 重载报告的可传输版本：plugins 是插件增删改摘要；failed 里的错误已 crossed；
// objects 只在 parked 时带 cause，其余对象状态直接透传。
export type CrossedReport = {
	readonly plugins: ReloadReport["plugins"];
	readonly failed: readonly { readonly plugin: string; readonly error: CrossedError }[];
	readonly objects: readonly { readonly object: string; readonly kind: string; readonly cause?: CrossedCause }[];
};

/** A failure cause as it crosses. */
// parked 对象的失败原因：保留 kind（如 reload/setup）和已压缩的 error。
type CrossedCause = { readonly kind: FailureCause["kind"]; readonly error: CrossedError };

/** What the server sends a worker. */
// 服务器 -> worker 的控制消息联合：
// start 携带地址、服务器算好的 start 数据、完整插件脚本集和锁名；shutdown 请求退出；reload 只带新的脚本集。
export type ToWorker =
	| {
			readonly kind: "start";
			readonly address: Address;
			readonly start: JsonValue;
			readonly scripts: readonly PluginScript[];
			readonly lock: string;
	  }
	| { readonly kind: "shutdown" }
	| { readonly kind: "reload"; readonly scripts: readonly PluginScript[] };

/** What a worker sends the server. */
// worker -> 服务器的控制消息：started 表示应用 host 已在 link 上监听；ready 带首次加载报告和初始 idle；
// idle 是状态翻转；fatal 是脱敏后的致命错误；reloaded 成功带报告、失败带 error（同一 kind 的联合）。
export type FromWorker =
	| { readonly kind: "started" }
	| { readonly kind: "ready"; readonly idle: boolean; readonly report: CrossedReport }
	| { readonly kind: "idle"; readonly idle: boolean }
	| { readonly kind: "fatal"; readonly error: CrossedError }
	| { readonly kind: "reloaded"; readonly report: CrossedReport }
	| { readonly kind: "reloaded"; readonly error: CrossedError };

/** `message` in its envelope, as it goes over the IPC channel. */
// 用途：给控制消息套上计算属性名信封。输入 ToWorker 或 FromWorker，输出 { "chord.workers": message }。
// 计算属性名 [ENVELOPE] 在运行时生成普通字符串键，使 link 的二进制帧（Uint8Array）与控制消息可区分。
export function envelope(message: ToWorker | FromWorker): { readonly [ENVELOPE]: ToWorker | FromWorker } {
	return { [ENVELOPE]: message };
}

/** The envelope's key: a control message is `{ "chord.workers": message }`. */
// 信封键必须与 link 的 IPC 解码器约定一致；改这里等于改进程间协议。
const ENVELOPE = "chord.workers";

/**
 * The control message in an IPC message, or `undefined` for anything else (a link frame, the app's own). A trust
 * boundary in name only: both ends are the app's processes, so only the envelope is checked.
 */
// 用途：从任意 IPC 消息中取出控制消息。输入 unknown，输出 FromWorker/ToWorker 或 undefined。
// 只检查“是对象、非 null、带信封键”，不深验字段：两端都是应用自己的进程，字段由 TypeScript 在发送侧保证。
// link 的二进制帧没有该键，因此返回 undefined 被忽略。
export function controlOf<M extends ToWorker | FromWorker>(message: unknown): M | undefined {
	if (typeof message !== "object" || message === null || !(ENVELOPE in message)) return undefined;
	// Sent by the other end of this channel through `envelope`.
	return (message as { readonly [ENVELOPE]: M })[ENVELOPE];
}

/** `error` as it crosses. */
// 用途：把未知错误压成可传输形状。输入 unknown，输出 CrossedError；无副作用。
// ChordError 保留 code 和可选 reason；其他 Error 只留 message；非 Error 用 String 转文本。
// 不复制 stack/cause，正是“公开错误”策略的一部分。
export function crossed(error: unknown): CrossedError {
	if (isChordError(error)) {
		return {
			message: error.message,
			code: error.code,
			// 只有 reason 存在时才展开该键，避免传出 undefined（IPC/JSON 语义不一致）。
			...(error.reason === undefined ? {} : { reason: error.reason }),
		};
	}
	return { message: error instanceof Error ? error.message : String(error) };
}

/** A crossed error as an error again: a ChordError when its code is one, an `Error` otherwise. */
// 用途：把 CrossedError 还原成 Error。输入压缩后的错误，输出 Error；无副作用。
// 无 code 直接构造普通 Error；有 code 时用 chordErrorFromJson 重建 ChordError。
// 若 code/reason 不合法，chordErrorFromJson 抛错，这里捕获后降级成普通 Error，保证还原过程不失败。
export function uncrossed(error: CrossedError): Error {
	if (error.code === undefined) return new Error(error.message);
	try {
		return chordErrorFromJson({
			code: error.code,
			message: error.message,
			...(error.reason === undefined ? {} : { reason: error.reason }),
		});
	} catch {
		return new Error(error.message);
	}
}

/** `report` as it crosses. */
// 用途：转换重载报告。输入 ReloadReport，输出 CrossedReport。
// plugins 是纯数据直接保留；failed 的 error 逐个 crossed；objects 中 parked 项保留 object/kind 并压缩 cause，
// 其他项原样返回（它们本来就是可传输的状态字符串）。
export function crossedReport(report: ReloadReport): CrossedReport {
	return {
		plugins: report.plugins,
		failed: report.failed.map(({ plugin, error }) => ({ plugin, error: crossed(error) })),
		objects: report.objects.map((each) =>
			each.kind === "parked"
				? {
						object: each.object,
						kind: each.kind,
						cause: { kind: each.cause.kind, error: crossed(each.cause.error) },
					}
				: each,
		),
	};
}

/** A crossed report as a report again. */
// 用途：还原重载报告。输入 CrossedReport，输出 ReloadReport。
// failed 的 error 逐个 uncrossed；objects 的 cause 若存在，则把错误还原成 ChordError：
// 没有 code 的错误（例如从旧协议或普通 Error 来的）统一包成 unavailable，因为 parked 原因在本地要求 ChordError。
export function uncrossedReport(report: CrossedReport): ReloadReport {
	return {
		plugins: report.plugins,
		failed: report.failed.map(({ plugin, error }) => ({ plugin, error: uncrossed(error) })),
		objects: report.objects.map(({ object, kind, cause }) => {
			if (cause === undefined)
				return { object, kind: kind as Exclude<ReloadReport["objects"][number]["kind"], "parked"> };
			const error = uncrossed(cause.error);
			// A parked object's cause is a ChordError on the worker; one that crossed without a code is wrapped as one.
			const chord = isChordError(error) ? error : new ChordError({ code: "unavailable", message: error.message });
			return { object, kind: "parked", cause: { kind: cause.kind, error: chord } as FailureCause };
		}),
	};
}
