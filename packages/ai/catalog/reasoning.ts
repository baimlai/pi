// 将 models.dev 的原生 effort 名称转换成 Pi 可选思考档位；不决定一次请求实际启用哪档。
import type { ThinkingLevel, ThinkingLevelMap } from "../src/types.ts";
import type { ModelsDevReasoningOption } from "./sources/models-dev.ts";

// readonly 是编译期只读数组视图，不是 Object.freeze；off 单独通过原生 none 推导。
const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Converts models.dev verified effort values into Pi's selectable thinking levels.
 * Values without a Pi equivalent (`default` and JSON `null`) are intentionally
 * omitted.
 */
// 输入 toggle/effort/budget 联合选项，输出映射或 undefined；不改输入、无 I/O。
// 例 effort=["none","high"] 产生 off:"none"、high:"high"，其余列出的 Pi 档位为 null；只有 default 则不产映射。
export function getEffortThinkingLevelMap(options: readonly ModelsDevReasoningOption[]): ThinkingLevelMap | undefined {
	// flatMap 仅展开 type:"effort" 成员的 values；判别字段让 TS 知道该分支存在 values。
	const effortValues = options.flatMap((option) => (option.type === "effort" ? option.values : []));
	// 没 effort 值说明 toggle/budget 不能用本方法映成档位。
	if (effortValues.length === 0) return undefined;

	// Set 便于成员判断并消除重复值，不对值排序或改写。
	const supported = new Set(effortValues);
	// 至少一个 Pi 同名档位或 none 才有可表达结果；default/null 不算。
	if (!THINKING_LEVELS.some((level) => supported.has(level)) && !supported.has("none")) return undefined;

	// 无 none 时明确把 off 标记为不支持，和完全不提供映射不同。
	const map: ThinkingLevelMap = { off: supported.has("none") ? "none" : null };
	// 将每个可选档写成原生同名值或 null；缺失档位不会由默认逻辑误暴露。
	for (const level of THINKING_LEVELS) {
		map[level] = supported.has(level) ? level : null;
	}
	// 返回新建对象，后续供应商可继续浅合并或调整它。
	return map;
}
