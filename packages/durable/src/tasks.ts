// 文件导读
// 所属：packages/durable 根级任务定义辅助，被 harness/tool.ts、harness/generation.ts、harness/compaction.ts 使用。
// 作用：把 TaskDefinition 包成一个 Task token，供 createRegistry()、tx.createTask() 与调度器使用；token 只是定义引用。
// 职责边界：不校验 name/version/phases、不复制函数、不注册、不执行 initial/phase/abort、不写存储；
// 真正的参数校验、迁移和阶段调用发生在注册表与 Harness 调度器中。上游：应用调用 defineTask 声明自定义持久任务；
// 下游：types.ts 的 TaskDefinition/Task 类型，registry.ts 负责安装，scheduler 负责运行。
// 能力清单：
// - defineTask<I, S, R, H>(definition)：返回 { definition }；I 是输入，S 是至少含 phase 字符串的检查点联合，
//   R 是终态结果，H 是任务挂钩对象（省略时为 object）。定义字段含义见 types.ts 的 TaskDefinition。
// 组合与典型顺序：defineTask(...) → createRegistry({ tasks: [...] }) → Harness.open(...) →
// tx.createTask(token, input, options) → 调度器按 state.phase 调用 phases[phase]。
// 示例（只展示形状，字段需按 TaskDefinition 补全）：
//   const Fetch = defineTask<{ url: string }, { phase: "get" }, string>({
//     name: "app.fetch", version: 1,
//     initial: () => ({ phase: "get" }),
//     phases: { get: async (task, runtime, context) => { /* ... */ } },
//     abort: async (task, runtime, context) => { /* ... */ },
//   });
// 注意：示例不是可运行代码；运行时 defineTask 不会调用 initial 或任何 phase。
// 阅读顺序：先看 types.ts 中 TaskDefinition 的字段说明，再看本函数，最后看 harness/registry.ts 如何安装定义。
import type { Task, TaskDefinition } from "./types.ts";

// 将任务定义包成类型化 token，供注册表和 tx.createTask 等调用使用；不会执行 initial、phase 或 abort。
// I 是输入，S 是带 phase 字符串的检查点，R 是结果，H 是挂钩对象（省略时为 object）。
// 输入定义原样保存在返回对象中，不复制、不验证、不写存储；错误来自后续真正使用定义的路径。
// 例：defineTask({ name, version, initial, phases, abort }) 只是描述任务，仍须注册后由 Harness 调度。
// 把任务定义包装成 token。
// 输入：完整的 TaskDefinition（name/version/initial/phases/abort，可选 migrate/hooks）；输出：持有同一对象的 Task。
// 副作用：无；错误：无。它不检查 version 是否为正、phases 是否覆盖所有 phase，也不检查 abort 是否存在。
// 主要流程只有一步：属性简写构造 { definition }，之后注册表/调度器再读取 definition 的字段。
// 例子：const token = defineTask(def); token.definition === def 为 true（没有复制）。
/** Define an executable task. Register it in the registry so a Harness can run tasks of its kind. */
export function defineTask<I, S extends { phase: string }, R, H extends object = object>(
	definition: TaskDefinition<I, S, R, H>,
): Task<I, S, R, H> {
	// 属性简写等价于 { definition: definition }，返回对象继续引用同一份定义。
	return { definition };
}
