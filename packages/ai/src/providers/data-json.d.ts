// 文件导读：packages/ai 的 JSON 模块兜底类型声明（ambient module declaration）。
//
// 所属模块：AI provider 适配层的数据装载。providers/ 下的若干自动生成 *.models.ts 以
// `import values from "./data/zai.json" with { type: "json" }` 读取生成数据；这些 data/*.json 由
// catalog/generate.ts 产生，并在 .gitignore 中排除（package.json 的 generate-models 脚本）。本文件在源码树中
// 提供一个通配声明，避免这些 import 在缺少生成数据、或解析器未能给出精确类型时完全没有模块类型。
//
// 职责边界：只描述“任意 *.json 模块的默认导出存在且类型为 unknown”。它不生成或修改 JSON，不执行文件加载，
// 不定义业务字段，也不做 schema 校验；运行时 JSON 解析由 Node 的 import attributes / 模块加载器完成。
// 上游入口：TypeScript 编译器在解析 import 时匹配本文件的环境模块声明，不需要显式 import 本文件。下游结果：
// 当实际 JSON 文件存在且 resolveJsonModule 开启时，编译器优先使用文件内容推导的精确类型，本声明不会覆盖它；
// 只有找不到对应数据文件时，默认导出才退化为 unknown，调用方必须自行收窄/断言。错误流向：JSON 语法错误在
// 编译期由 tsc、运行时由模块加载器报告；未知字段/缺失字段不是本声明能发现的错误。
//
// 能力清单（本文件只有声明，没有运行时导出）：
//   - declare module "*.json"：通配环境模块声明，让所有 .json 模块具备一个默认导出形状。
//   - const value: unknown：默认导出的编译期类型；unknown 不允许直接访问属性，比 any 更安全。
//   - export default value：声明默认导出指向该 const；不产生常量、不加载文件、不创建 namespace。
//
// 组合与典型调用顺序：生成器写 data/*.json → models.ts 使用 import attributes 导入 → tsc 解析模块；文件存在时得到
// 精确类型并传入 ChatModelCatalog<typeof values, ...>，文件缺失时本声明只提供 unknown 兜底，不会恢复具体字段类型。
// 整条链路没有本文件的显式调用点，它只在类型解析阶段生效。
//
// 示例（真实语法）：
//   import values from "./data/zai.json" with { type: "json" };
//   // 数据文件存在时，values 的类型由 JSON 内容推导；若解析不到文件，则由本声明的 unknown 兜底。
//   // 示例描述编译期行为；运行时仍由模块加载器读取并解析该 JSON。
//
// 建议阅读顺序：先读下面的 declare module "*.json"；再对照任一 *.models.ts 的 import 与 package.json 的
// generate-models 脚本，确认数据来源和类型回退场景。
declare module "*.json" {
	// 环境声明里的 const 只描述默认值的名字与 unknown 类型，不在这里分配常量或解析文件；unknown 不像 any 那样放行任意属性访问。
	const value: unknown;
	// 说明默认导出是上面声明的 value；export default 在此没有实际加载/返回数据的动作，运行时 JSON 语法解析由模块加载器负责。
	export default value;
}
