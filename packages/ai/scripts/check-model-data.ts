#!/usr/bin/env node
// 本地生成模型数据的校验CLI：只读当前AI包的生成TS/JSON/manifest，打印结果并设置退出码，不生成或下载缺失数据。
// 本文件没有“直接运行”门禁，import也会立即走下方校验；需要复用函数时应导入model-data.ts。

// dirname与join从脚本位置定位包根，不依赖调用者cwd。
import { dirname, join } from "node:path";
// 模块URL转换为本地文件路径，不是访问一个HTTP资源。
import { fileURLToPath } from "node:url";
// 导入离线校验函数；其模块顶层只定义函数/常量，不在导入时自行读盘。
import { validateGeneratedModelData } from "./model-data.ts";

// import.meta.url是本脚本URL，转路径取目录再上一级得到AI包根。
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// try覆盖实际验证和成功输出；任何同步异常都进入下面catch。
try {
	// 读当前结构并核目录必要字段/hash，成功void；不是独立上游目录版本或发布签名验证。
	validateGeneratedModelData(packageRoot);
	// 验证与前面IO都成功后才向stdout输出通过文案。
	console.log("Generated model data is valid.");
// 捕获unknown失败值，包括读取/JSON/字段问题，不修复数据。
} catch (error) {
	// Error取message，其他抛出值String化后写stderr，保留明确失败说明。
	console.error(error instanceof Error ? error.message : String(error));
	// 仅打印修复建议，反引号中的hydrate命令不会被这里执行；也未自动联网或改文件。
	console.error("\nModel data is missing or stale. Run `npm run hydrate:model-data` from the repository root.");
	// 设置进程最终非零退出码，不立即process.exit；已写出的错误文字与其他待完成工作不会被此行硬截断。
	process.exitCode = 1;
}
