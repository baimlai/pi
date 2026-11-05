/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/49-plugin-api/plugins/hello/server.ts，hello 插件的 server facet。
 * 同目录 package.json 是发现清单：name "@acme/hello"、private、type: "module"；JSON 不能写注释，说明写在这里。
 * 演示什么：正常的 v3 插件。它同时导入共享 API（@acme/app/v3）和 server kind 专属 API（@acme/app/v3/server），
 * 两者版本一致；构建通过，加载后向 Greetings 注册表贡献一条含服务器名的问候。
 * 上游/下游：main.ts 发现并构建，modules 提供这两个说明符的实例；问候由 @acme/core facet 的 compose 合成。
 * 能力清单：默认导出的 facet 向 Greetings 贡献字符串；serverName() 返回 "the acme server"。
 * 典型运行顺序：发现 -> 构建（检查版本与 kind 模块）-> evaluate setup -> contribute -> 读端 compose -> main 打印。
 * 示例（真实签名）：defineFacet((_host, self) => self.contribute(Greetings, "..."))
 * 预期输出：hello from a v3 plugin on the acme server
 * 建议阅读顺序：先看两个 import 的路径，再看模板字符串如何在求值时调用 serverName()。
 * 前置条件：必须由 main.ts 加载；单独执行本文件不会注册任何东西。
 */
// A plugin written against v3: the shared module and the server's own module, one version for the whole facet.

// 共享 v3 模块提供 defineFacet 和 Greetings；版本段一致（都从路径中的 v3 判定），满足“一个 facet 一个版本”。
import { defineFacet, Greetings } from "@acme/app/v3";
// server kind 专属模块：仅当前 server facet 的 hostPackages 包含它；web facet 导入同名模块会被拒绝。
import { serverName } from "@acme/app/v3/server";

// 默认导出 setup 函数：加载时执行一次，贡献问候语。serverName() 在求值时调用，结果拼进模板字符串。
// 这里没有用 _host，因为该 facet 只需要声明一条注册表贡献。
export default defineFacet((_host, self) => self.contribute(Greetings, `hello from a v3 plugin on ${serverName()}`));
