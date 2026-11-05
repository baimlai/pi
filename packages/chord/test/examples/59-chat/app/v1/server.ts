// 文件导读
// 所属：packages/chord/test/examples/59-chat，chat 应用 API v1 的服务器子路径 `@chat/app/v1/server`。
// 作用：给服务器插件提供两样东西：
//   1) `Http` 注册表：插件向它贡献 HTTP 路由（聊天插件用它提供登录页、频道列表和附件下载）；
//   2) `login`：app kit 的“选名即登录”facet，安装它等价于公开 POST /_chord/login { name }，
//      成功后创建 { kind: "user", id, name } 的临时 principal 并签发会话 cookie。
// 上游：plugins/chat/server.ts 导入 Http 贡献路由；plugins/login.server.ts 默认导出 login facet。
// 下游：src/node/app/index.ts 的 ephemeralLoginFacet、src/node/http/index.ts 的 Http 注册表。
// 能力清单：
// - `Http`（再导出）：HTTP 路由注册表 token；
// - `login`：Facet<ChatPrincipal>，可直接作为插件默认导出。
// 典型用法（示例）：
//   self.contribute(Http, { routes: { "GET /": { public: true, handler: ... } } });
// 阅读顺序：先看两行导出，再看 plugins/chat/server.ts 如何贡献路由。
// 运行方式：随服务器插件加载；不单独执行。
// 校验边界：login 的 handler 在运行时校验请求体（4 KiB 上限、name 必须是非空字符串）；
// `public: true` 明确绕过认证，这是 HTTP 组件安全模型的一部分。

// The chat's API v1 for server facets (`@chat/app/v1/server`): the HTTP registry, and the kit's pick-a-name login as a
// facet its one-line plugin exports.

import { ephemeralLoginFacet } from "../../../../../src/node/app/index.ts";
import type { ChatPrincipal } from "../principals.ts";

// Http 是注册表 token，不是路由表本身；路由由各插件在 setup 中贡献，HTTP 组件负责组合与匹配。
export { Http } from "../../../../../src/node/http/index.ts";

// 泛型参数让 facet 的类型与应用 principal 对齐；kit 在运行时会用条件类型错误提示缺失 user 形状的应用。
// 该方法无副作用地返回 facet；真正的路由注册发生在插件 load 时执行 setup。
/** The kit's ephemeral login: `POST /_chord/login { name }` signs in as `{ kind: "user", id, name }`. */
export const login = ephemeralLoginFacet<ChatPrincipal>();
