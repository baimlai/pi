/**
 * pi-evals 的“计划层”：把 Vitest 发现到的文档评测用例展开成一条条可单独执行的运行臂。
 *
 * 所属包与模块：packages/evals/src 是 pi-evals 包的运行器代码，本文件只负责纯数据变换，
 * 不启动 Docker，也不读写文件。
 *
 * 解决什么问题：文档对照评测要在同一个用例上比较两种镜像变体：
 * `without_docs`（去掉 Pi 文档和系统提示中的文档路由）与 `with_docs`（保留文档）。
 * 发现阶段只告诉我们有哪些用例；执行阶段还需要把每个用例复制成
 * “用例 × 变体 × 模型 × 第几次重复”的独立任务，才能分别放进全新容器运行。
 *
 * 上下游：
 * - 上游入口是 cli.ts：它先用 parseDiscoveredCases 校验两个变体的 discovery JSON，
 *   再用 createTaskPlan 生成任务数组，并写入 protocol.json / expected-runs.json。
 * - 下游是 docker.ts 的 runTask（按单个 EvalTask 启动容器）和 report.ts
 *   （按 EvalTask 的相同字段配对 control/treatment 观测）。
 * - 错误以 TypeError 同步抛出，由 cli.ts 顶层 await 直接变成进程失败。
 *
 * 本文件的能力清单：
 * - DOCUMENTATION_VARIANTS：两个变体名的只读元组，同时作为运行时枚举值。
 * - DocumentationVariant：由上面的元组推导出的字符串联合类型，只在编译期存在。
 * - DiscoveredEvalCase：发现阶段的一个用例身份（文件、完整名、评测集、用例名）。
 * - EvalTask：DiscoveredEvalCase 再加变体、模型、重复序号，是执行与配对的最小单位。
 * - isRecord：内部类型谓词，把 unknown 收窄为普通对象（运行时真有检查）。
 * - parseDiscoveredCases：校验 discovery JSON 的数组元素，拆出 `<eval set> > <case>` 并拒绝重复身份。
 * - createTaskPlan：校验模型身份与重复次数，生成交替顺序的任务列表。
 *
 * 典型调用示例（示例，不是本文件运行时会自动执行的内容）：
 *   const cases = parseDiscoveredCases([
 *     { name: "Add model > adds the model", file: "evals/models.docs.eval.ts" },
 *   ]);
 *   const tasks = createTaskPlan(cases, "fixture/model", 1);
 *   // tasks 长度为 2，顺序是 without_docs、with_docs。
 *
 * 建议阅读顺序：先看 DOCUMENTATION_VARIANTS / DocumentationVariant / DiscoveredEvalCase /
 * EvalTask 这组类型，再看 parseDiscoveredCases 的输入校验，最后看 createTaskPlan 的笛卡尔积与交替顺序。
 */

// `as const` 让数组字面量保持只读元组，元素类型被收窄为具体的两个字符串字面量，而不是 string[]。
// 这样下面的 DocumentationVariant 可以直接从值推导类型，运行时这个常量就是普通数组。
export const DOCUMENTATION_VARIANTS = ["without_docs", "with_docs"] as const;
// 索引访问类型 (typeof DOCUMENTATION_VARIANTS)[number] 取元组所有元素类型的联合，得到
// "without_docs" | "with_docs"。类型在编译后被擦除，不会产生运行时对象。
export type DocumentationVariant = (typeof DOCUMENTATION_VARIANTS)[number];

// 发现阶段从 Vitest JSON 读出的用例描述。字段全都来自外部文件，
// 所以 parseDiscoveredCases 会逐项做运行时校验，不能只依赖这里的类型标注。
export type DiscoveredEvalCase = {
	// 相对于 packages/evals 的评测文件路径，例如 evals/models.docs.eval.ts。
	file: string;
	// Vitest 的完整测试名，约定格式是 "<eval set> > <case>"。
	fullName: string;
	// 分隔符 " > " 前的评测集名称，例如 "Add model"。
	evalSet: string;
	// 分隔符 " > " 后的用例名称，例如 "adds the model"。
	caseId: string;
};

// 一个具体运行臂：交叉类型 & 表示它拥有 DiscoveredEvalCase 的全部字段，再追加三个执行维度。
export type EvalTask = DiscoveredEvalCase & {
	// 本次使用哪个镜像变体。
	variant: DocumentationVariant;
	// "provider/model" 形式，用于让报告核对实际提供请求的模型。
	model: string;
	// 从 1 开始的重复序号；奇偶决定两个变体的先后顺序。
	runNumber: number;
};

// 类型谓词 `value is Record<string, unknown>` 告诉 TypeScript：返回 true 的分支里，
// value 可以被收窄成普通对象。函数体里的 typeof/Array.isArray 是真实运行时检查，
// 这里处理的是 JSON.parse 得到的 unknown，属于合法的信任边界。
function isRecord(value: unknown): value is Record<string, unknown> {
	// 排除 null 和数组：它们 typeof 也是 "object"，但不是以字符串为键的普通记录。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 把 discovery JSON 的未知值解析成 DiscoveredEvalCase 数组。输入来自容器写出的文件，
// 因此要验证类型、名称格式和重复身份；任一不满足都会抛 TypeError。
// 示例：parseDiscoveredCases([{ name: "A > b", file: "evals/x.docs.eval.ts" }])
// 返回 [{ fullName: "A > b", evalSet: "A", caseId: "b", file: "evals/x.docs.eval.ts" }]。
export function parseDiscoveredCases(value: unknown): DiscoveredEvalCase[] {
	// 最外层必须是数组，否则后续 .map 没有意义。
	if (!Array.isArray(value)) throw new TypeError("Discovered eval cases must be an array.");
	// 用序列化后的 [evalSet, caseId] 作为身份键，避免字符串拼接带来的分隔歧义。
	const identities = new Set<string>();
	// map 返回新数组，同时保留输入顺序；回调内抛错会立即终止整个解析。
	return value.map((item) => {
		// isRecord 收窄对象；再要求 name 与 file 都是字符串，才能安全使用它们。
		if (!isRecord(item) || typeof item.name !== "string" || typeof item.file !== "string") {
			throw new TypeError("Discovered eval case is invalid.");
		}
		// 数组解构配合剩余元素：前两段是评测集与用例名，extra 收集多余的分隔段。
		const [evalSet, caseId, ...extra] = item.name.split(" > ");
		// 可选链 ?. 防止解构结果为 undefined；trim 拒绝只有空白的名称；extra 非空说明格式有歧义。
		if (!evalSet?.trim() || !caseId?.trim() || extra.length > 0) {
			throw new TypeError(`Documentation eval must use "<eval set> > <case>": ${item.name}`);
		}
		// JSON 数组序列化把两个字段编码成无歧义的身份字符串，供 Set 去重。
		const identity = JSON.stringify([evalSet, caseId]);
		if (identities.has(identity)) throw new TypeError(`Duplicate eval case identity: ${item.name}`);
		identities.add(identity);
		// 显式列出四个字段，避免把外部对象上多余的属性带进后续协议。
		return { file: item.file, fullName: item.name, evalSet, caseId };
	});
}

// 生成完整任务计划：每个用例 × 每个重复序号 × 两个变体。
// 输入 cases 来自 parseDiscoveredCases；model 必须是 "provider/model"；runsPerVariant 是正安全整数。
// 返回按用例、重复序号、变体顺序排列的新数组，不修改输入，也没有副作用。
// 示例：createTaskPlan(cases, "fixture/model", 2) 对单个用例生成 4 条任务，
// 变体顺序为 [without_docs, with_docs]（第 1 次）和 [with_docs, without_docs]（第 2 次）。
export function createTaskPlan(
	// readonly 只声明调用方不应修改数组，不会在运行时冻结或阻止修改。
	cases: readonly DiscoveredEvalCase[],
	model: string,
	runsPerVariant: number,
): EvalTask[] {
	// 模型身份必须包含分隔用的斜杠（不限制只能有一个），且不能以其开头或结尾。
	if (!model.includes("/") || model.startsWith("/") || model.endsWith("/")) {
		throw new TypeError("Model identity must contain a provider and model.");
	}
	// Number.isSafeInteger 同时排除小数、NaN、Infinity 和超过安全范围的整数。
	if (!Number.isSafeInteger(runsPerVariant) || runsPerVariant < 1) {
		throw new TypeError("Runs per variant must be a positive integer.");
	}
	const tasks: EvalTask[] = [];
	// 外层按用例，保持 discovery 的稳定顺序。
	for (const evalCase of cases) {
		// runNumber 从 1 开始，闭区间到 runsPerVariant。
		for (let runNumber = 1; runNumber <= runsPerVariant; runNumber += 1) {
			// 奇数轮先跑 control（without_docs），偶数轮先跑 treatment（with_docs），
			// 用于减少固定顺序带来的偏差；这只影响顺序，不影响配对身份。
			const variants: DocumentationVariant[] =
				runNumber % 2 === 1 ? ["without_docs", "with_docs"] : ["with_docs", "without_docs"];
			// 展开 evalCase 复制四个身份字段，再加上执行维度，生成互不共享的可变对象。
			for (const variant of variants) tasks.push({ ...evalCase, variant, model, runNumber });
		}
	}
	return tasks;
}
