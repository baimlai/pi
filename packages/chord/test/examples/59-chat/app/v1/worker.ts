// 文件导读
// 所属：packages/chord/test/examples/59-chat，chat 应用 API v1 的 worker 子路径 `@chat/app/v1/worker`。
// 作用：给 channel worker 的插件公开 app kit 的 `Files` 契约（每个 worker 自己的文件存储，支持
// 分块上传、索引与容量上限）。聊天插件用它保存附件。
// 上游：plugins/chat/worker.ts 导入 Files 并在 Room 方法中调用 begin/append/finish/read。
// 下游：src/node/app/index.ts 的 Files（local 契约）；客户端通过 Room 方法间接访问，不直接持有它。
// 能力清单：`Files`（再导出）。
// 典型用法（示例）：
//   const files = await ctx.get(Files, {});
//   const upload = await files.begin({ name, mime }, ctx);
//   await files.append({ upload, offset, bytes }, ctx);
// 阅读顺序：只此一行；实现与分块细节见 plugins/chat/worker.ts。
// 运行方式：随 worker 插件加载；不单独执行。
// 说明：Files 是 local 契约，身份只在本宿主内有效；跨 worker 不会共享同一个文件存储。

// The chat's API v1 for channel workers (`@chat/app/v1/worker`): the kit's `Files`, each worker's own.

export { Files } from "../../../../../src/node/app/index.ts";
