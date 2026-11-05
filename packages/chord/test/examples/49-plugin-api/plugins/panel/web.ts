/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/49-plugin-api/plugins/panel/web.ts，panel 插件的 web facet。
 * 同目录 package.json 是发现清单：name "@acme/panel"、private、type: "module"；JSON 不能写注释，说明写在这里。
 * 演示什么：与 server.ts 的导入相反，web facet 可以并且应该使用 "@acme/app/v3/web"。构建成功后，
 * main.ts 用 evaluateFacet 在一个单独的 page 宿主上求值它，向 Panels 注册表贡献 { title: "word count" }。
 * 上游/下游：main.ts 的 build 产出 BuiltScript；evaluateFacet 注入 webModules（v3/v3web/v2）；页面 facet compose 标题。
 * 能力清单：默认导出的 facet 向 Panels 贡献一个带 title 的对象。
 * 典型运行顺序：build（成功）-> evaluateFacet（执行 setup，贡献）-> page.load（装入宿主）-> 读取 Panels。
 * 示例（真实签名）：self.contribute(Panels, { title: "word count" })
 * 预期输出：panels on the page: word count
 * 建议阅读顺序：先看 import 的 /web 子路径，再对照 server.ts 为何同一条导入在 server 被拒。
 * 前置条件：由 main.ts 构建并求值；单独执行本文件不会注册任何东西。
 */
// The panel plugin's web facet: the web's module of the API is for exactly this kind.

// 共享 v3 导出 defineFacet；web 的 hostPackages 包含它。
import { defineFacet } from "@acme/app/v3";
// web kind 专属模块，当前构建 kind 是 web，因此该说明符在 hostPackages 中，导入保持 external 并在求值时解析。
import { Panels } from "@acme/app/v3/web";

// setup 执行一次，贡献 { title }；main.ts 的 compose 只取 title 字段组成数组。
export default defineFacet((_host, self) => self.contribute(Panels, { title: "word count" }));
