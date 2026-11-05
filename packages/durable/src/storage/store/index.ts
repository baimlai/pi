// 将 Durable 记录存入现有 Chord Store 的入口；只导出类，打开和生命周期由调用者安排。
// 文件导读
// 所属：packages/durable/src/storage/store 的包入口（导出子路径 ./storage/store）。
// 职责边界：仅转发 StoreStorage，不打开 store、不建表、不校验 owner 名；这些发生在 StoreStorage.open。
// 上下游：宿主先用 Chord 的 openStore() 打开一个 store，再调用 StoreStorage.open(store, owner, context)；
//   下游实现分布在 storage.ts（读取与打开）、commit.ts（写入检查）、documents.ts（文档引擎映射）、
//   queries.ts（预编译查询）和 tables.ts（表声明）。
// 能力清单：
// - StoreStorage（类）：在 Chord store 的声明表和文档引擎上实现 Durable 的 Storage 接口。
// 组合顺序：openStore -> StoreStorage.open -> commit/读方法 -> StoreStorage.close（不关闭宿主 store）。
// 示例：import { StoreStorage } from "@earendil-works/pi-durable/storage/store";
//   const storage = await StoreStorage.open(store, "durable.app", context);
// 阅读顺序：storage.ts 的类与 open -> tables.ts 的表声明 -> queries.ts 的读取 -> commit.ts 的提交 -> documents.ts。
export { StoreStorage } from "./storage.ts";
