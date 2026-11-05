/**
 * The `codemode` tool as an extension. The CLI loads it as a built-in extension; SDK users
 * add `createCodemodeExtension()` to their extension factories.
 *
 * `codemode` is registered inactive. Activate it with `--tools`, the `defaultTools` setting, or
 * `setActiveTools()`; the MCP extension activates it when MCP tools are only reachable from scripts.
 */

// 把 codemode 注册成内置扩展；上游 CLI 或 SDK 调 createCodemodeExtension，真正脚本执行在 tool.ts → execute.lazy.ts → execute.ts。
// 例：MCP 只有脚本可调用的工具时，MCP 扩展可以激活这里默认 inactive 的 codemode；注册和激活不是同一步。
// import type 只借用接口，配置默认值和工具工厂才需要运行时加载。
import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
import { createCodemodeToolDefinition } from "./tool.ts";

/** 扩展构造选项；可覆盖设置里的模式和声明预算，以及是否给脚本开放模型辅助接口。 */
export interface CodemodeExtensionOptions {
	/** Overrides the `codemode.mode` setting. */
	// on 保留模型直接调用工具，only 隐去可由脚本调用的直接工具声明；这不是允许脚本递归启动 codemode。
	mode?: CodemodeMode;
	/** Overrides the `codemode.inlineBudget` setting. */
	// 只约束描述内嵌工具片段的估算 token，不是脚本输出 token 或真实模型窗口上限。
	inlineBudget?: number;
	/** Expose the model catalog and classifiers to scripts as `models`. Default: `true`. */
	// 是否声明 models 全局接口；true 不代表现在就发起模型请求。
	models?: boolean;
}

// 读取动态设置，只认 only，否则回到 SETTINGS_DEFAULTS；每次工具 loadout 准备时可读到新值。
function readMode(pi: ExtensionAPI): CodemodeMode {
	// ?. 允许没有 codemode 设置；三元表达式返回两个已决定的模式之一，不改变设置文件。
	return pi.getSettings().codemode?.mode === "only" ? "only" : SETTINGS_DEFAULTS.codemode.mode;
}

// 读取设置边界的非负有限预算，不能用的值返回 undefined 交后续默认；允许0和小数，不强制整数。
function readInlineBudget(pi: ExtensionAPI): number | undefined {
	// 读取当前设置快照的字段，不缓存第一次启动的值。
	const budget = pi.getSettings().codemode?.inlineBudget;
	// typeof 收窄后用 Number.isFinite/范围条件表达此读取规则；不是给 TypeScript 声明自动加运行时校验。
	return typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : undefined;
}

/** 创建扩展工厂，调用时注册工具；例 createCodemodeExtension({models:false}) 不给脚本开放 models。构造不执行脚本。 */
export function createCodemodeExtension(options: CodemodeExtensionOptions = {}): ExtensionFactory {
	// 返回接收 ExtensionAPI 的闭包，options 保留在闭包中。
	return (pi) => {
		// 注册这份工具定义；pi.registerTool 是宿主接口，不立即执行工具。
		pi.registerTool({
			// 展开工具工厂的全部定义字段，然后下面覆盖 defaultActive。
			...createCodemodeToolDefinition({
				// 将成功脚本的 store 写入记录转发给会话自定义条目，失败脚本不在执行器里持久化写入。
				appendEntry: (customType, data) => pi.appendEntry(customType, data),
				// ?? 未配置才true，显式false会保留。
				models: options.models ?? true,
				// 按名称从当前工具集合查命名空间，找不到就 undefined；不是为脚本凭空新增工具。
				getToolNamespace: (name) => pi.getAllTools().find((tool) => tool.name === name)?.namespace,
				// 动态收集每个工具的提示规则，让 describeTool/ALL_TOOLS 也能带上规则。
				getToolGuidelines: () =>
					// Map 保存名称→规则数组；as const 保住 [键,值] 二元组类型，未额外深复制规则。
					new Map(pi.getAllTools().map((tool) => [tool.name, tool.promptGuidelines ?? []] as const)),
				// 显式options优先，否则执行时再读当前设置；这里只返回回调，不立刻求值。
				getMode: () => options.mode ?? readMode(pi),
				// 显式预算优先；undefined 继续由工具层用默认预算，0不被当假值丢弃。
				getInlineBudget: () => options.inlineBudget ?? readInlineBudget(pi),
			}),
			// 注册默认不激活，可由 --tools、设置、扩展激活；这不等于 exposure:hidden。
			defaultActive: false,
		});
	};
}

// 默认导出已经创建的扩展工厂，供扩展加载器直接调用；创建工厂本身还没拿到 pi。
export default createCodemodeExtension();
