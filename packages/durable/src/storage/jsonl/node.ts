// 使用 NodeExecutionEnv 提供的本地文件系统能力打开 JSONL 存储。
// 文件导读
// 所属：packages/durable/src/storage/jsonl 的 Node 打开入口（导出子路径 ./storage/jsonl/node）。
// 职责边界：为调用者创建以 process.cwd() 为根的本地文件系统环境，再交给 JsonlStorage.open；不实现日志格式，
//   也不选择 fsync 策略（由 options 传入）。
// 上下游：本地脚本/测试调用 openNodeJsonlStorage；下游是 env/node.ts 的 NodeExecutionEnv 与 ./storage.ts。
// 能力清单：
// - openNodeJsonlStorage(directory, context, options?)：打开或创建目录并恢复日志。
// - JsonlStorage / JsonlStorageOptions（转导出）：方便平台入口处一并导入。
// 组合顺序：new NodeExecutionEnv({ cwd: process.cwd() }) -> JsonlStorage.open(directory, env, context, options)。
// 示例：const storage = await openNodeJsonlStorage("./history", context);
//   "./history" 相对调用时的当前工作目录；目录不存在会被创建。
// 阅读顺序：先看本函数，再看 ./storage.ts 的 open/recover；文件系统实现见 ../../env/node.ts。
import type { Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "../../env/node.ts";
import { JsonlStorage, type JsonlStorageOptions } from "./storage.ts";

/** Open or create a JSONL storage directory using the local Node filesystem. */
// directory 为日志目录，context 携带取消/追踪，options 控制如 fsync；返回恢复完成的存储 Promise。
// 构造以进程工作目录为根的环境，再交给 JsonlStorage.open 创建/读取日志；文件错误或损坏会拒绝。
// 例：directory 为 "./history" 时，路径相对调用时的 process.cwd()，不是此源码文件的位置。
export async function openNodeJsonlStorage(
	directory: string,
	context: Context,
	options: JsonlStorageOptions = {},
): Promise<JsonlStorage> {
	// NodeExecutionEnv 比这里只需要的 FileSystem 能力更宽；open 仅接收其文件系统接口使用。
	return JsonlStorage.open(directory, new NodeExecutionEnv({ cwd: process.cwd() }), context, options);
}

export { JsonlStorage, type JsonlStorageOptions } from "./storage.ts";
