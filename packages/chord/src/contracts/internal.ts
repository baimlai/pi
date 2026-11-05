// 文件导读
// 所属模块：packages/chord/src/contracts，Chord 内部层使用的契约入口。
// 解决的问题：链接、host 和演进代码需要公开入口没有的数据访问器、校验函数和类型级工具，集中从这里导出。
// 职责边界：只做再导出；调用 contractData 等函数才会读取 WeakMap 或做校验；不声明契约、不修改数据。
// 上游：链接绑定、host 路由、evolve 等内部模块 import；下游：accepts/contract/evolve/fingerprint/host-kind/
//   names/params/schema 的实现。结果与错误都来自被再导出的函数。
// 能力清单：
// - checkAccepts()：验证旧版本映射表。
// - ContractShape、CurrentVariants、ShapeOf、VariantImplementation、VariantNames：编译期的契约形状工具。
// - contractData()、currentVariants()、variantsAt()、variantOrder()、variantNames()、takesNoArgs()：
//   运行时句柄数据与线上索引查询。
// - LOCAL、MethodData、VariantData：local 变体名和成员数据类型。
// - editWith()：执行编辑回调并检查返回同一编辑器。
// - fingerprintOf()、hash64()、NORMAL_FORM_VERSION：指纹计算。
// - Increment：版本号加一的类型。
// - kindParams()、checkName()、Params/ParamsData、Method：host 种类、名称校验、参数数据和运行时方法标记。
// 组合关系：链接绑定 -> contractData + checkAccepts + fingerprintOf；evolve -> editWith + Increment；
//   声明 -> Method/Params/checkName/kindParams。
// 示例：
//   const data = contractData(notes);
//   const accepted = checkAccepts(notes, {});        // 没有旧版本时返回 { versions: [] }
//   console.log(data.versions.at(-1)!.version);     // 当前版本号
// 建议阅读顺序：先看 contractData/currentVariants 等运行时查询，再看 checkAccepts/fingerprintOf 的绑定用途，
//   最后按需查类型工具（ShapeOf、CurrentVariants、Increment）。

// Contracts for Chord's layers: accepted versions, the data behind a contract handle, and the types L4 dispatches on.

// Chord 内部层使用的契约入口：除了公开类型，还导出链接/host 需要的运行时数据访问器和类型级派发工具。
// 这里同样只再导出；调用 contractData、checkAccepts 等函数才会读取 WeakMap 或做校验。

// 旧版本映射检查；链接绑定时使用。
export { checkAccepts } from "./accepts.ts";
// 句柄数据、当前变体、变体名索引和成员“无参数”判断。
export {
	type ContractShape,
	type CurrentVariants,
	contractData,
	currentVariants,
	LOCAL,
	type MethodData,
	type ShapeOf,
	takesNoArgs,
	type VariantData,
	type VariantImplementation,
	type VariantNames,
	variantNames,
	variantOrder,
	variantsAt,
} from "./contract.ts";
export { editWith } from "./evolve.ts";
// 指纹算法与规范形式版本；链接握手和测试使用。
export { fingerprintOf, hash64, NORMAL_FORM_VERSION } from "./fingerprint.ts";
// 类型层的版本号加一，只在编译期存在。
export type { Increment } from "./history.ts";
// host 种类的 params 数据。
export { kindParams } from "./host-kind.ts";
// 名称校验。
export { checkName } from "./names.ts";
// params 数据结构。
export type { Params, ParamsData } from "./params.ts";
// Method 类用于运行时 instanceof 判断。
export { Method } from "./schema.ts";
