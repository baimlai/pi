/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/49-plugin-api/app/v3/server.ts，v3 API 的 server kind 专属模块。
 * 演示什么：同一版本可以按 facet 种类拆出只在该环境存在的 API。server 模块只在 server facet 的
 * hostPackages 白名单里，其他 kind 导入它会被构建拒绝；反过来，server facet 导入 web 模块也会被拒绝
 * （见 plugins/panel/server.ts 的错误）。
 * 上游/下游：main.ts 以 "@acme/app/v3/server" 提供给 server kind；plugins/hello/server.ts 导入并打印 serverName()。
 * 能力清单：serverName() 返回固定字符串，无参数、无副作用。
 * 典型运行顺序：构建时解析 server facet 的 import -> 求值时注入本模块 -> 插件调用 serverName()。
 * 示例（真实签名）：serverName(): string
 * 建议阅读顺序：读完本文件后看 panel 的 server facet 如何被拒绝导入 v3/web。
 * 前置条件：仅作为宿主包被 import；单独执行不产生输出。
 */
// Acme's API v3 for server facets only (`@acme/app/v3/server`): what exists on the server and nowhere else.

// 普通函数导出：插件调用它得到字符串；返回固定值，因此不依赖参数或外部状态。
/** The server's name. */
export function serverName(): string {
	return "the acme server";
}
