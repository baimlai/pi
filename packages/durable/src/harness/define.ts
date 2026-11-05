// 所属：packages/durable/src/harness，Durable harness 的“扩展声明”辅助层；纯类型推断与普通对象组装，没有运行时逻辑。
// 解决的问题：扩展作者直接写字面量时，工具参数 schema 与 execute(args) 的类型关联、扩展与工具类型、任务与钩子接口
// 容易丢失；这里用恒等函数与工厂函数把泛型推断留在调用点。
// 职责边界：不注册、不安装、不复制、不执行、不校验；运行时校验属于 Registry.install()、resolveAgent() 和 ToolTask。
// 上游：应用或扩展作者的 TypeScript 源码。下游：Extension 对象交给 Registry.install()，任务钩子由 agentHooks() 收集，
// 包装器由 resolveAgent() 的 applyWrap() 应用，afterRun 计划由 generation 的 finish 阶段创建为子任务。
// 能力清单：
// - defineExtension<Tool>：恒等函数，从扩展字面量推断工具类型，返回同一对象；
// - defineTool<TParameters, TDetails>：恒等函数，让 execute 的 args 由 parameters 推断、details 由 TDetails 约束；
// - section(key, render, options?)：构造提示词段，tag 控制是否用 <key>...</key> 包裹；
// - hook(task, handlers)：把任务名与部分钩子处理器绑定为 HookRegistration；
// - runEndTask(task, input)：把 afterRun 要请求的子任务与输入打包，不创建任务；
// - wrapTool(tool, wrapper)：按工具名声明包装，resolveAgent() 时应用；
// - wrapSection(key, wrapper)：按段 key 声明包装。
// 组合与典型顺序：defineTool → defineExtension（tools/sections/hooks/wraps）→ registry.install()；
//   会话创建时 resolveAgent() 选择扩展并应用 wraps；generation 运行时 agentHooks() 取钩子；afterRun 钩子返回
//   runEndTask(...) 数组，由生成任务统一提交创建子任务。
// 示例：
//   const read = defineTool({ name: "read", description: "Read a file",
//     parameters: { type: "object", properties: { path: { type: "string" } } },
//     async execute(args) { /* 使用 args.path，返回 ToolExecutionResult */ } });
//   const files = defineExtension({ name: "files", tools: [read], sections: [section("cwd", () => "/tmp")] });
//   registry.install(files); // 安装后由会话通过 resolveAgent() 选择
//   以上是示例调用形状，不是运行时行为；这些函数都不执行 execute 或 render。
// 建议阅读顺序：先看 types.ts 中 ToolRegistration/PromptSection/Extension/HookRegistration/Wrap 五个形状，再读
//   defineExtension/defineTool，然后 section/wrapTool/wrapSection，最后 hook/runEndTask。
// 每个构造函数都原样保留传入的引用；所有约束都只在编译期生效，JavaScript 调用者可以绕过。
import type { JsonValue } from "@earendil-works/chord/json";
import type { Task } from "../types.ts";
import type {
	AnyTask,
	Extension,
	HookRegistration,
	HooksOf,
	PromptSection,
	RunEndTask,
	ToolRegistration,
	Wrap,
} from "./types.ts";

// 下面三个泛型默认值让调用者可省略 <Tool>；Tool extends ToolRegistration 是编译期约束，不检查对象运行时形状。
/** Identity function that types an extension. */
// 为扩展提供泛型推断入口：输入扩展对象，原样返回同一个对象，没有安装或运行时校验。
// Tool extends ... 限制工具类型，= ... 提供省略泛型时的默认值。例如 defineExtension({ name: "files" }) 只帮助类型检查。
export function defineExtension<Tool extends ToolRegistration = ToolRegistration>(
	extension: Extension<Tool>,
): Extension<Tool> {
	// 不复制对象；registry.install() 才负责把扩展放进注册表。
	return extension;
}

// 例子：defineTool({ name: "read", parameters: schema, async execute(args) { ... } }) 返回同一个工具对象；
// execute 的 args 由 parameters 经 ToolArgs 推到 TParameters，details 的 JSON 值由 TDetails 约束。
// 工具真正执行时的参数校验发生在 ToolTask 中，本函数不调用 validateToolArguments。
/** Identity function that types a tool: `args` from `parameters`, details from what it reports. */
// 输入带参数 schema 和 execute 的工具，原样返回；两个泛型关联参数 schema 与 details 的 JSON 类型。
// 例如 defineTool({ ... }) 可让 execute 的 args 随 schema 推断；本函数不会执行工具或验证参数，错误由后续调用层处理。
export function defineTool<TParameters extends object, TDetails extends JsonValue = JsonValue>(
	tool: ToolRegistration<TParameters, TDetails>,
): ToolRegistration<TParameters, TDetails> {
	// 保留工具引用和全部字段，只在 TypeScript 开发阶段补充类型约束。
	return tool;
}

// 返回的是普通对象而不是缓存或类实例；tag 的语义是“是否用 <key>...</key> 包裹”，由 renderSections() 落实。
/** A prompt section; tagged unless `tag` is false. */
// 用 key、渲染回调和可选 tag 设置构造提示词段，返回普通对象；不调用 render，也没有外部副作用。
// PromptSection<Tool>["render"] 是索引访问类型，复用段定义的回调签名。例如 section("cwd", render, { tag: false }) 保留裸文本。
export function section<Tool extends ToolRegistration = ToolRegistration>(
	key: string,
	render: PromptSection<Tool>["render"],
	options?: { readonly tag?: boolean },
): PromptSection<Tool> {
	// ?. 在 options 缺省时得到 undefined；不提供 tag 字段就由渲染层采用默认包裹行为，显式 false 则被保留。
	return options?.tag === undefined ? { key, render } : { key, render, tag: options.tag };
}

// HooksOf<K> 是条件类型：从 Task 的第四个泛型参数取出钩子接口；Partial 让实现者可以只给一部分钩子。
// 返回值的 task 字段是字符串名称，所以同一个钩子对象可以在不同注册表快照间按名称匹配。
/** Hook handlers for tasks with `task`'s name. */
// 由任务及其部分钩子构造注册项；Partial 允许只实现 HooksOf<K> 中的一部分，返回值按任务名匹配。
// 例如 hook(GenerationTask, { afterResponse }) 不立刻运行钩子；无复制、无运行时函数形状检查。
export function hook<K extends AnyTask>(task: K, handlers: Partial<HooksOf<K>>): HookRegistration {
	// 只保存任务定义的名称，不把整个任务对象当作匹配键。
	return { task: task.definition.name, handlers };
}

// I、S、R、H 必须与 task 的定义一致（Task<I, S, R, H>）；S 的相位约束 { phase: string } 也是编译期检查。
/** A task an `afterRun` hook asks for, its input typed by the task (spec §8.3). */
// 将任务和输入打包为 afterRun 的请求，不创建任务；I 关联 task 的输入类型与 input，S 必须有字符串 phase。
// R 为结果、H 为钩子类型。例如 runEndTask(IndexTask, { path: "a" }) 待 generation 统一提交时才创建子任务。
export function runEndTask<I extends JsonValue, S extends { phase: string }, R, H extends object>(
	task: Task<I, S, R, H>,
	input: I,
): RunEndTask {
	// 返回引用组成的普通数据；任务定义和输入的运行时合法性不在这里检查。
	return { task, input };
}

// Wrap<Tool> 是带判别字段的联合类型：tool 字段对应工具包装，section 字段对应提示词段包装，二者只能出现一个。
/** Wrap the tool named like `tool` wherever the wrapping extension is selected. */
// 输入工具和同类型包装回调，返回按名称定位的包装声明；本函数不调用 wrapper，无外部副作用。
// 例如 wrapTool(readTool, tool => ({ ...tool, description: "..." })) 在解析 agent 时应用，回调抛错也发生在那时。
export function wrapTool<Tool extends ToolRegistration>(tool: Tool, wrapper: (tool: Tool) => Tool): Wrap<Tool> {
	// 保存名称与回调，让注册对象的引用不同仍能按名称匹配。
	return { tool: tool.name, wrap: wrapper };
}

// 调用 resolveAgent() 时，包装回调用当前已合成的段作为输入，返回值替换该项；重命名 target 会被视为包装失败。
/** Wrap the section `key` wherever the wrapping extension is selected. */
// 输入段 key 和转换 PromptSection 的回调，返回段包装声明；不渲染、不执行包装，也不检查 key 是否已存在。
// 例如 wrapSection("cwd", section => ({ ...section, tag: false })) 由 agent 解析阶段处理。
export function wrapSection<Tool extends ToolRegistration = ToolRegistration>(
	key: string,
	wrapper: (section: PromptSection<Tool>) => PromptSection<Tool>,
): Wrap<Tool> {
	// section 字段使这个对象落在 Wrap 联合类型的“提示词段”分支。
	return { section: key, wrap: wrapper };
}
