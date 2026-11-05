// 文件导读
// 所属：packages/chord/test/examples/53-app/app，Chord 示例 53 到 55 共用的 notes 应用 API 目录。
// 作用：定义应用的身份类型 NotesPrincipal，说明谁可以作为服务器、worker、kit 的 owner 或插件登录的 user。
// 上游：start.ts 用 startServer<NotesPrincipal> 把这个类型交给 app kit；插件 facet 的工厂和方法在运行时收到
// 具体 principal 后按 kind 分支。下游：纯类型文件，没有 import、没有运行时副作用，类型剥离后完全消失。
// 能力清单：
// - NotesPrincipal：四种身份的 discriminated union（可辨识联合）。
// 典型用法（示例）：
//   const owner: NotesPrincipal = { kind: "owner" };
//   const worker: NotesPrincipal = { kind: "worker", project: "project|p1" };
// 阅读顺序：先看 NotesPrincipal 的成员，再看 start.ts 的 principal 选项如何产生这些值。
// 运行方式：不单独运行；它随示例 53 的入口 main.ts 一起被 Node 的类型剥离器加载。
// 类型检查与运行时：TypeScript 只在开发期检查字段形状和 kind 收窄；运行时不会按这个类型校验 principal，
// 身份由 app kit 的 owner 链接、会话认证和 worker 启动消息产生。

// The notes app's principals: its server and workers, the kit's owner, and the users its plugins may sign in.

// 可辨识联合（discriminated union）：每个成员都有字面量类型的 kind 字段，TypeScript 比较 kind 后就能收窄
// 到具体成员。如果写成 `kind: string`，下面的 if/switch 就无法得到字段类型。
/** Who someone is in the notes app. */
export type NotesPrincipal =
	// 服务器宿主自身：服务器进程里的核心对象以这个身份运行。
	| { readonly kind: "server" }
	// app kit 的 owner：AppOptions<P> 的条件类型要求 P 必须能容纳 { kind: "owner" }。
	| { readonly kind: "owner" }
	// worker 进程的身份；project 是 host 地址的 key（Project({ id }) 生成 "project|<id>"），不是单独的 id。
	| { readonly kind: "worker"; readonly project: string }
	// 留给插件登录的普通用户；示例本身不签发 user 会话，但类型允许应用以后加入这种登录。
	| { readonly kind: "user"; readonly id: string; readonly name: string };
