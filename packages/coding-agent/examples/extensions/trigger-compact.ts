/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是按上下文用量触发压缩。
 * 上游：turn_end 事件在每轮结束时读取 ctx.getContextUsage()；用户也可输入
 * /trigger-compact [instructions] 手动触发。下游：ctx.compact() 请求会话层启动压缩
 * （摘要过程可能调用模型并产生费用），onComplete/onError 回调用 notify 报告结果。
 *
 * 演示的机制：记录上一轮的 token 数，只有当“上一轮不超过阈值、这一轮超过阈值”时才
 * 触发一次压缩，避免每轮重复触发；tokens 为 null（尚不可知）时跳过。
 *
 * 能力清单：
 * - COMPACT_THRESHOLD_TOKENS：阈值常量 100000。
 * - triggerCompaction(ctx, customInstructions?)：发起压缩并注册成功/失败通知。
 * - turn_end 监听：检测跨越阈值并自动触发。
 * - /trigger-compact：立即压缩，参数作为摘要指示。
 *
 * 典型运行顺序：加载扩展 -> 持续对话使上下文增长 -> 跨过 100k 的那一轮结束后自动压缩，
 * UI 先提示 "Compaction started"，成功后再提示 "Compaction completed"。
 *
 * 示例（真实签名）：
 *   ctx.compact({ customInstructions: "focus on decisions", onComplete(){}, onError(e){} });
 *   调用立即返回，压缩在后台继续；不要把它当成已完成。
 *
 * 建议阅读顺序：先看 triggerCompaction 的回调结构，再看 turn_end 中 crossedThreshold
 * 的计算与 previousTokens 的更新顺序，最后看命令处理器。
 *
 * 前置条件：需要能读取上下文用量的会话；压缩通常需要模型认证，失败会走 onError。
 * 无 UI 时只是跳过通知，压缩仍会执行。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// 触发阈值：估算 token 数超过该值后压缩一次。数字分隔符 _ 只是可读性写法，运行时等于 100000。
const COMPACT_THRESHOLD_TOKENS = 100_000;

// 扩展入口：previousTokens 保存上一轮观测值，初始 undefined 表示尚未观测到。
export default function (pi: ExtensionAPI) {
	// 为什么用三种状态：undefined=从未观测，null=观测到但未知（例如刚压缩后），number=已知估算值。
	let previousTokens: number | null | undefined;

	// 发起一次压缩：customInstructions 可选，成功/失败都只做 UI 通知。
	const triggerCompaction = (ctx: ExtensionContext, customInstructions?: string) => {
		// 只有具备 UI 时才通知，避免无界面模式做无用调用。
		if (ctx.hasUI) {
			ctx.ui.notify("Compaction started", "info");
		}
		// compact 立即返回；实际摘要在后台进行，结果通过回调送回。
		ctx.compact({
			customInstructions,
			onComplete: () => {
				// 回调运行时再次检查 hasUI，因为期间上下文可能已变化。
				if (ctx.hasUI) {
					ctx.ui.notify("Compaction completed", "info");
				}
			},
			onError: (error) => {
				if (ctx.hasUI) {
					// error.message 是 Error 的标准字段；通知用 error 级别显示失败。
					ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
				}
			},
		});
	};

	// 每轮结束后运行；同步回调，不返回结果。
	pi.on("turn_end", (_event, ctx) => {
		// getContextUsage 在用量未知时可能返回 undefined；?. 和 ?? 把两种情况统一成 null。
		const usage = ctx.getContextUsage();
		const currentTokens = usage?.tokens ?? null;
		// 未知用量无法判断是否跨越阈值，直接跳过，也不改写 previousTokens。
		if (currentTokens === null) {
			return;
		}

		// 只有“上一次观测存在且不超过阈值”才说明本轮可能刚刚跨过阈值。
		const crossedThreshold =
			previousTokens !== undefined && previousTokens !== null && previousTokens <= COMPACT_THRESHOLD_TOKENS;
		// 更新必须发生在判断之后，否则本次比较会拿当前值和自己比。
		previousTokens = currentTokens;
		// 未跨阈值，或当前仍未超过阈值，都不触发。
		if (!crossedThreshold || currentTokens <= COMPACT_THRESHOLD_TOKENS) {
			return;
		}
		triggerCompaction(ctx);
	});

	// 手动命令：原样把参数作为摘要指示；空白参数转为 undefined。
	pi.registerCommand("trigger-compact", {
		description: "Trigger compaction immediately",
		handler: async (args, ctx) => {
			// trim 后若为空串，|| 选择 undefined，避免向 compact 传空白指示。
			const instructions = args.trim() || undefined;
			triggerCompaction(ctx, instructions);
		},
	});
}
