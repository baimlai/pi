// 所属：packages/durable/src/tools，Durable 内置编码工具包的公开入口（包导出 "./tools"）。
// 解决的问题：应用常常需要同时提供 read/write/edit/bash；若每次手工拼装，容易漏掉类型导出或图片处理配置。
// 这里把四个工具（可选再加 powershell）打包成一个 Extension，并集中导出各工具的类型与工厂。
// 职责边界：只构造工具注册对象和扩展描述；不安装到 Registry、不执行工具、不判断会话是否选中该扩展，
// 也不创建执行环境（环境由 HarnessOptions.env 提供）。
// 上游：宿主应用调用 createCodingTools(options) 后把结果交给 Registry.install()，或直接使用 CodingTools。
// 下游：harness/define.ts 的 defineExtension/defineTool，以及 read/write/edit/bash 四个工厂；read 的图片
// 转换能力来自 image-processor.ts 的 ImageProcessor。
// 能力清单（导出项）：
// - createCodingTools(options?)：创建名为 "coding-tools" 的 Extension；options 只透传给 read，其余工具用默认配置。
// - CodingTools：模块加载时创建的无图片处理器默认扩展对象；导入它不会安装或执行任何工具。
// - 再导出：BashExecution/BashPrepare/BashToolInput/BashToolOptions/PowerShellToolInput/PowerShellToolOptions、
//   createBashTool/createPowerShellTool（bash.ts）；EditToolDetails/EditToolInput/createEditTool（edit.ts）；
//   DEFAULT_IMAGE_LIMITS/ImageLimits/ImageProcessor/PreparedImage（image-processor.ts）；
//   ReadToolDetails/ReadToolInput/ReadToolOptions/createReadTool（read.ts）；
//   WriteToolInput/createWriteTool（write.ts）。
// 组合关系：createReadTool(options) 等工厂 → tools 数组 → defineExtension 返回普通对象；工具真正执行发生在
// Harness 的 ToolTask 中，这里不做任何 I/O。
// 示例（真实签名，仅展示装配）：
//   const codingTools = createCodingTools({ images: processor }); // 返回 Extension，尚未安装
//   registry.install(codingTools);
// 建议阅读顺序：先读本文件与 harness/define.ts 的 defineExtension/defineTool 签名，再按 read → write → edit →
// bash 阅读各工厂；图片相关从 image-processor.ts 的 ImageProcessor 进入。
import { defineExtension } from "../harness/define.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createReadTool, type ReadToolOptions } from "./read.ts";
import { createWriteTool } from "./write.ts";

export {
	// type 修饰的导出只供 TypeScript 检查；函数导出才会成为运行时的模块成员。
	type BashExecution,
	type BashPrepare,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createPowerShellTool,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./bash.ts";
// edit 工具只导出工厂、模型可见的输入类型和结果 details 类型；具体差异算法留在 edit-diff.ts。
export { createEditTool, type EditToolDetails, type EditToolInput } from "./edit.ts";
export {
	DEFAULT_IMAGE_LIMITS,
	type ImageLimits,
	type ImageProcessor,
	type PreparedImage,
} from "./image-processor.ts";
// ReadToolOptions 是唯一会传入图片处理器的配置入口；ReadToolDetails 携带截断信息。
export { createReadTool, type ReadToolDetails, type ReadToolInput, type ReadToolOptions } from "./read.ts";
// write 没有可选配置，因此只导出输入类型和工厂。
export { createWriteTool, type WriteToolInput } from "./write.ts";

/**
 * The `coding-tools` extension: `read`, `write`, `edit`, and `bash`; nothing installs it automatically.
 * `createPowerShellTool()` adds `powershell`. `images` prepares the images `read` returns (see `ReadToolOptions`).
 */
/**
 * 创建包含四种编码工具的扩展描述；options 只传给 read，用来配置图片处理器，省略时为空对象。
 * 返回 name 和 tools，不执行命令、不读写文件，也不把扩展安装到注册表。
 * 例如 createCodingTools({ images: processor }) 的 read 可以转换图片；其余三个工具保持各自默认配置。
 */
export function createCodingTools(options: ReadToolOptions = {}) {
	// defineExtension 直接返回此对象，并在编译时检查它符合扩展类型。
	return defineExtension({
		// 扩展名用于注册与选择；工具工厂此时仅构造定义。
		name: "coding-tools",
		tools: [createReadTool(options), createWriteTool(), createEditTool(), createBashTool()],
	});
}

/** `createCodingTools()` without an image processor. */
// 模块首次加载就构造默认扩展对象；导入它仍不会自动安装或执行任何工具。
export const CodingTools = createCodingTools();
