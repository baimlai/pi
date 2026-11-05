import { describe, expect, test, vi } from "vitest";
import triggerCompactExtension from "../examples/extensions/trigger-compact.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../src/core/extensions/index.ts";

// 输入假定 token 数和可选压缩替身，返回示例扩展会读的最小上下文；不创建真实会话或模型。
// 例 createContext(105_000, compact) 报 52.5% 用量；compact 默认是新 spy，null 表示无法得知用量。
function createContext(tokens: number | null, compact = vi.fn()): ExtensionContext {
	// 显式返回类型让 TS 检查接口；对未使用子对象的 as 仅绕过结构要求，不补运行时实现。
	return {
		// 模拟打印模式且没有 UI，因此扩展不会尝试显示通知。
		mode: "print",
		hasUI: false,
		// 索引访问类型 ExtensionContext["ui"] 取得该属性类型；空对象只适合本例不会触及的路径。
		ui: {} as ExtensionContext["ui"],
		// 读取当前 cwd 字符串，但本夹具不往该目录写文件。
		cwd: process.cwd(),
		// 会话/注册表替身没有方法；不适用于需要真实会话 API 的用例。
		sessionManager: {} as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		// 当前没有模型，也没有可切换范围。
		model: undefined,
		scopedModels: [],
		// 两个零参箭头函数恒回 true，模拟空闲、已信任状态，不做实际安全判断。
		isIdle: () => true,
		isProjectTrusted: () => true,
		// 没有取消信号；以下动作均为无操作 spy 或固定结果。
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		// 简写 tokens 捕获参数；用量为 null 时百分比也 null，否则 tokens/200000*100 即 tokens/2000。
		getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: tokens === null ? null : tokens / 2000 }),
		// 直接保存调用者传入的压缩函数引用，便于跨几次事件累计调用次数。
		compact,
		// 本例无需真实系统提示词，只返回空串。
		getSystemPrompt: () => "",
	};
}

// 登记示例扩展跨阈值行为测试，不执行实际压缩，也不请求摘要模型。
describe("trigger-compact example extension", () => {
	// 连续送入 110k→120k→95k→105k，只有最后一次从不高于 100k 跨到高于 100k 才触发。
	// 无参数/返回；捕获事件回调后手动调用它，失败由 expect 抛出，不覆盖 slash 命令入口。
	test("only auto-compacts when context usage crosses the threshold", () => {
		// 联合类型允许尚未注册时为 undefined；函数类型中的 | 表示 ctx 可为两种上下文之一。
		let turnEndHandler:
			| ((event: { type: "turn_end" }, ctx: ExtensionContext | ExtensionCommandContext) => void)
			| undefined;

		// 只实现扩展注册时用到的 on/registerCommand；双重 as 不会创建完整 ExtensionAPI。
		const api = {
			// 输入事件名和处理器，遇 turn_end 就保存函数，无返回、无自动事件派发。
			on: (event: string, handler: (event: { type: "turn_end" }, ctx: ExtensionContext) => void) => {
				// 忽略其他事件，因此捕获的只可能是本测试关注的回调。
				if (event === "turn_end") {
					// 外部 let 被闭包赋值，随后测试可以手动调用它。
					turnEndHandler = handler;
				}
			},
			// 只接受命令注册，既不调用 handler 也不验证命令内容。
			registerCommand: vi.fn(),
		} as unknown as ExtensionAPI;

		// 执行真实扩展初始化，令它登记回调并建立私有 previousTokens 状态。
		triggerCompactExtension(api);
		// 保证确实捕获回调，避免后续 ?. 静默跳过导致假通过。
		expect(turnEndHandler).toBeDefined();

		// 每个事件复用同一压缩 spy，累计触发次数；事件字面量 as const 保留 type 的具体值。
		const compact = vi.fn();
		const event = { type: "turn_end" } as const;

		// 首次 110k 虽已高于阈值，但没有之前的样本，不能判定跨越。
		turnEndHandler?.(event, createContext(110_000, compact));
		expect(compact).not.toHaveBeenCalled();

		// 仍在阈值以上，不能重复自动压缩。
		turnEndHandler?.(event, createContext(120_000, compact));
		expect(compact).not.toHaveBeenCalled();

		// 退回阈值以下只更新历史值，不触发。
		turnEndHandler?.(event, createContext(95_000, compact));
		expect(compact).not.toHaveBeenCalled();

		// 这次从 95k 跨到 105k，真实扩展应调用 compact 一次；spy 不真正运行压缩。
		turnEndHandler?.(event, createContext(105_000, compact));
		expect(compact).toHaveBeenCalledTimes(1);
	});
});
