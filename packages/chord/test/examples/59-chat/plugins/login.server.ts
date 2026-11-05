// 文件导读
// 所属：packages/chord/test/examples/59-chat/plugins，单文件插件 login 的 server facet。
// 命名规则：根目录顶部的 `<name>.<kind>.<ext>` 被识别为单文件插件。这里 name = "login"、
// kind = "server"、ext = ".ts"；插件加载器按 kind 把本文件构建成服务器 facet，因此不会在浏览器
// 或 worker 中执行。单文件插件只允许导入宿主包，不允许本插件目录内的相对文件。
// 作用：把 app kit 的 ephemeral login facet 作为本插件的默认导出。装上这个插件，服务器就获得
// 公开的 POST /_chord/login 路由：提交任意非空 name，即创建临时 user 身份并签发会话 cookie。
// 这是示例 59 的登录入口；web 首页与 tui 客户端都调用它。
// 上游：app kit 的插件发现/构建/加载；login facet 来自 app/v1/server.ts。
// 下游：src/node/app/ephemeral.ts 的 ephemeralLoginFacet；无文件、无网络副作用（加载时只声明路由）。
// 能力清单：默认导出的 Facet<ChatPrincipal>。
// 阅读顺序：一行导入 + 一行导出；行为细节见 src/node/app/ephemeral.ts。
// 运行方式：随 startChat 的插件根加载；不能单独执行。
// 说明：`export default login` 直接复用 facet 对象，加载器识别的就是 defineFacet 返回的 { setup }。

// The kit's pick-a-name login, added to the chat as a one-line plugin.

import { login } from "@chat/app/v1/server";

export default login;
