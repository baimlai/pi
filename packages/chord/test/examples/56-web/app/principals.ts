// 文件导读
// 所属：packages/chord/test/examples/56-web，Chord 示例 56（同一块 board 同时提供 web 页面与终端界面）。
// 作用：定义 board 应用的 principal（主体，即“谁在调用”）联合类型。Chord 的对象身份和授权都围绕
// principal 展开；这里把身份限制为服务端自身、板主 owner、普通用户 user 三种。
// 上游：start.ts 用 `startServer<BoardPrincipal>` 声明应用的身份类型；各插件 facet 的工厂/方法
// 通过参数拿到 principal 后按 `kind` 分支。
// 下游：纯类型文件，无 import、无运行时副作用、不写文件；编译后被完全擦除。
// 能力清单：
// - `BoardPrincipal`：三种身份的 discriminated union（可辨识联合）。
// 典型用法（示例）：
//   const owner: BoardPrincipal = { kind: "owner" };
//   const guest: BoardPrincipal = { kind: "user", id: "u1", name: "Ada" };
// 阅读顺序：先看 `BoardPrincipal`，再看 app/v1.ts（对插件公开的 API）和 start.ts（如何启动宿主）。
// 运行方式：本文件不单独运行，它随示例 56 的入口 main.ts 一起被加载。
// 注意：TypeScript 只在编译期检查这些字段；运行时不会对 principal 形状做二次校验，真正的认证
// 发生在 app kit 的认证与 owner token 路径（见 packages/chord/src/node/app）。

// The board app's principals: its server, the kit's owner, and users.

// 可辨识联合：所有成员都有一个字面量类型的 `kind` 字段，TypeScript 通过比较 kind 来收窄类型。
// `readonly` 只约束编译期的赋值，不会在运行时冻结对象。
/** Who someone is in the board app. */
export type BoardPrincipal =
	// 服务端宿主自身：内部对象以这个身份运行。
	| { readonly kind: "server" }
	// 板主：由启动时打印的一次性登录链接换成 owner 会话，可编辑板上的内容。
	| { readonly kind: "owner" }
	// 普通用户：id 用于标识与对象寻址，name 用于界面显示。
	| { readonly kind: "user"; readonly id: string; readonly name: string };
