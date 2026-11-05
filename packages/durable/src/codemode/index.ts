// 所属：packages/durable/src/codemode，codemode 模块的公开出口。
// 作用：只做再导出，把工具/文档/类型（codemode.ts）与命名空间/预算（describe.ts）汇总给 durable 的其余部分。
// 职责边界：无运行逻辑、无副作用；不定义新类型，也不改变默认值。
// 上游：packages/durable 的包入口或 Harness 组装代码从这里导入。
// 下游：./codemode.ts 与 ./describe.ts。
// 能力清单：CODEMODE_MODULE_VERSION、CODEMODE_TOOL_NAME、CodemodeGlobal、CodemodeNestedCall、CodemodeStoreDoc、
// CodemodeToolDetails、CodemodeToolInput、CodemodeToolOptions、createCodemodeExtension、createCodemodeTool、
// CodemodeNamespace、DEFAULT_CODEMODE_INLINE_BUDGET。
// 示例：import { createCodemodeExtension } from "./codemode/index.ts";
// 建议阅读顺序：先看 codemode.ts 的 createCodemodeTool/createCodemodeExtension，再按需读 describe.ts 的渲染逻辑。
export {
	// 版本号：重放兼容性判断使用；升级存储结果到脚本可见值的逻辑时递增。
	CODEMODE_MODULE_VERSION,
	// 工具名常量 "codemode"。
	CODEMODE_TOOL_NAME,
	// 脚本全局函数的类型：名字、可选 spread、execute 实现。
	type CodemodeGlobal,
	// 结果 details 中一次嵌套工具调用的展示行。
	type CodemodeNestedCall,
	// 会话级、可回溯、按 fork 点复制的脚本键值存储文档。
	CodemodeStoreDoc,
	// codemode 工具结果的 details 类型。
	type CodemodeToolDetails,
	// 工具参数类型（由 schema 推导）。
	type CodemodeToolInput,
	// 创建工具时的选项：sandbox、命名空间、预算、models 开关、额外 globals。
	type CodemodeToolOptions,
	// 创建包含工具与提示词段的完整扩展。
	createCodemodeExtension,
	// 只创建 codemode 工具注册。
	createCodemodeTool,
} from "./codemode.ts";
// 命名空间配置类型与工具声明的默认 token 预算，来自说明渲染模块。
export { type CodemodeNamespace, DEFAULT_CODEMODE_INLINE_BUDGET } from "./describe.ts";
