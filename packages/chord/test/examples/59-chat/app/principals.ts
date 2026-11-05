// 文件导读
// 所属：packages/chord/test/examples/59-chat，Chord 示例 59（多 channel 聊天应用）。
// 作用：定义 chat 应用的 principal 联合类型。服务器、每个 channel worker、板主 owner、选名登录的
// 普通用户都用 `kind` 区分；worker 身份额外带 channel 名，便于按频道授权。
// 上游：start.ts 用 `startServer<ChatPrincipal>` 声明应用身份；worker 启动选项的 principal 回调
// 根据地址生成 { kind: "worker", channel }；app/v1/server.ts 的 ephemeral login facet 创建 user。
// 下游：纯类型，无 import、无副作用；编译后擦除。
// 能力清单：`ChatPrincipal` 四种身份。
// 典型值（示例）：
//   const worker: ChatPrincipal = { kind: "worker", channel: "general" };
//   const user: ChatPrincipal = { kind: "user", id: "u_1", name: "Ada" };
// 阅读顺序：先看联合成员，再看 app/v1.ts 的 Room 契约与 start.ts 的 worker 身份映射。
// 注意：运行时认证由 app kit 完成；类型不会阻止构造任意对象，真正的信任边界在登录/链路握手。

// The chat's principals: its server and channel workers, the kit's owner, and users who picked a name.

// 可辨识联合：`kind` 是字面量判别字段，switch/if 按它收窄后其余字段才可访问。
// readonly 只在编译期阻止赋值；对象在运行时仍是普通可变对象。
/** Who someone is in the chat. */
export type ChatPrincipal =
	// 服务器宿主自身。
	| { readonly kind: "server" }
	// channel worker：channel 是该实例负责的频道名（与 Channel 地址的 id 对应）。
	| { readonly kind: "worker"; readonly channel: string }
	// 板主：通过启动脚本的 owner 链接登录。
	| { readonly kind: "owner" }
	// 普通用户：id 用于对象/数据归属，name 用于消息作者显示。
	| { readonly kind: "user"; readonly id: string; readonly name: string };
