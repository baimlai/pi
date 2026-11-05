// 文件导读
// 所属：packages/chord/test/examples/53-app/app/v1，import 说明符为 @notes/app/v1/server 的 API 子模块。
// 作用：只给 server 类宿主开放的能力——Sessions（服务器签发的登录会话）与 Http（注册 HTTP 路由）。
// worker 插件的构建里没有这个模块名，所以 worker 代码无法 import 它，也无法贡献路由。
// 上游：start.ts 的 api.modules 把本文件登记为 "@notes/app/v1/server"；只有 kind 为 server 的构建能解析它。
// 下游：src/node/app/index.ts 的 Sessions 与 src/node/http/index.ts 的 Http；两者都是运行时契约 token。
// 能力清单：
// - Sessions：本地契约，成员 list/issue/verify/revoke；用于设备配对后端的管理接口；
// - Http：服务端契约，成员是 routes 对象，路由按方法与路径注册。
// 典型用法（示例）：
//   import { Http } from "@notes/app/v1/server";
//   self.contribute(Http, { routes: { "GET /": async () => ({ kind: "text", value: "ok" }) } });
// 阅读顺序：先看两个导出名，再看 plugins/home/server.ts 与 plugins/notes/server.ts 如何贡献 Http。
// 运行方式：不单独运行；被插件的 server 构建读取。
// 说明：`export ... from` 在类型剥离后仍然保留为 re-export，运行时模块解析失败会直接报错；
// 这也让“worker 插件误用 server 模块”在构建期暴露。
//
// The notes app's API v1 for server facets only (`@notes/app/v1/server`): the HTTP registry plugins contribute routes
// to, and the kit's sessions.

// kit 的会话对象：list/issue/verify/revoke；token 只存哈希，SessionInfo 不包含 token 本身。
export { Sessions } from "../../../../../src/node/app/index.ts";
// HTTP 契约：插件用 self.contribute(Http, { routes }) 注册路由；访问控制默认拒绝。
export { Http } from "../../../../../src/node/http/index.ts";
