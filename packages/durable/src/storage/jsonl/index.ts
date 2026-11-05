// JSONL 的平台无关入口：调用者提供 FileSystem；本地 Node 打开函数在 ./node.ts。
// 这里只重导出实现、配置类型及两类错误，不会因为导入入口就读取或创建日志文件。
// 文件导读
// 所属：packages/durable/src/storage/jsonl 的包入口（导出子路径 ./storage/jsonl）。
// 职责边界：暴露 JsonlStorage 及其选项和错误类型；不选择文件系统、不决定目录、不做恢复。恢复由
//   JsonlStorage.open 完成，文件系统由调用者注入（Node 入口在 ./node.ts）。
// 上下游：跨平台宿主从本入口导入并在已有 FileSystem 上打开；测试在临时目录上打开；下游是 ./storage.ts。
// 能力清单：
// - JsonlStorage（类）：以 main.jsonl + 每任务/文档 sidecar 追加日志实现 Storage。
// - JsonlStorageOptions（类型）：目前只有 fsync。
// - JsonlCorruptionError：完整行无法解析或日志顺序不合法时抛出。
// - JsonlStoragePoisonedError：提交已部分生效后写盘失败，必须重开存储。
// 组合顺序：JsonlStorage.open(directory, fs, context, options) -> 读写 -> close(context)。
// 示例：const storage = await JsonlStorage.open("/data/logs", myFileSystem, context);
// 阅读顺序：先看 ./storage.ts 顶部的文件导读与类型，再看 open/recover，最后看 commit/append 与两个错误类。
export {
	JsonlCorruptionError,
	JsonlStorage,
	type JsonlStorageOptions,
	JsonlStoragePoisonedError,
} from "./storage.ts";
