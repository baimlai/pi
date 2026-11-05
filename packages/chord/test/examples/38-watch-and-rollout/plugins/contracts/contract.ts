// 文件导读
// 所属：packages/chord/test/examples/38-watch-and-rollout/plugins/contracts，示例 38 的共享契约插件 @example/shared
// （包名来自同目录 package.json）。它没有 server/worker 等 facet 文件，是“只含契约”的插件：不会被加载到 host，
// 但同一插件根内的其他插件可以通过相对路径导入它的文件。
// 作用：构建时 contract.ts 会被复制进每个导入它的插件脚本（notes、old、tags 的 facet）；因此编辑本文件会让所有
// 导入者以及 @example/shared 自己变脏，示例第 2 步验证这一点。
// 上游：notes/server.ts、notes/worker.ts、old/server.ts、tags/server.ts、tags/worker.ts 的相对 import；
// 下游依赖：@earendil-works/chord 的 local/str（构建时保持 external，求值时由宿主包映射提供本进程实例）。
// 能力清单：
// - labelOf(plugin)：按插件短名生成一个 local 契约声明（名字 example.label.<plugin>、版本 1、空 params、成员 text）。
// 示例（真实签名）：const NotesLabel = labelOf("notes");
// 它等价于 local("example.label.notes", { version: 1, params: {}, members: { text: str() } })；这是声明，不创建对象。
// 建议阅读顺序：先读 labelOf 的返回声明，再看各 facet 文件如何用不同插件名调用它。

// The contracts the plugins share (a contracts-only plugin): every plugin importing this file has a copy of it, so an
// edit here marks every one of them dirty.

import { local, str } from "@earendil-works/chord";

/** The label a plugin shows, one type per plugin. */
// 输入是插件短名，输出是 local 契约；没有 I/O，也不注册任何东西。
// 模板字符串在调用时拼出契约名；名字与版本一起构成契约身份，成员形状由 members 里的 schema 描述。
// 例：labelOf("tags") 生成 name "example.label.tags"、version 1、params {}、members { text: str() }。
export function labelOf(plugin: string) {
	return local(`example.label.${plugin}`, { version: 1, params: {}, members: { text: str() } });
}
