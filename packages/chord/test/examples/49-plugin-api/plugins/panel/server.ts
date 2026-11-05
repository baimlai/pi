/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/49-plugin-api/plugins/panel/server.ts，panel 插件的 server facet。
 * 同目录 package.json 是发现清单：name "@acme/panel"、private、type: "module"；JSON 不能写注释，说明写在这里。
 * 演示什么：按 kind 拆分的 API 模块不能被别的 kind 使用。server facet 导入 "@acme/app/v3/web" 时，
 * 构建器发现该说明符不在 server 的 hostPackages 中，按“not available to server facets”拒绝。
 * 同一插件的 web.ts 则构建成功——失败是按 facet 隔离的，不是整个插件一刀切。
 * 上游/下游：main.ts 的 plugins.load 不加载 panel；之后 plugins.build(["@acme/panel"]) 得到
 * server failed / web script 两个 BuiltFacet，main.ts 只求值 web。
 * 能力清单：源码层面定义 facet 并向 web 的 Panels 贡献 { title }；server 求值不会发生。
 * 典型运行顺序：build 按 kind 构建 -> server facet 因越界模块失败 -> web facet 成功 -> main.ts 只求值 web。
 * 示例（真实签名）：import { Panels } from "@acme/app/v3/web";
 * 预期构建错误：'\"@acme/app/v3/web\": not available to server facets'。
 * 建议阅读顺序：对照 app/v3/server.ts 与 app/v3/web.ts 的 kind 归属，再看 panel/web.ts 的正确用法。
 * 前置条件：必须由 main.ts 构建；单独执行本文件不会注册任何东西。
 */
// A server facet importing the web's module of the API: refused, naming the kind (a page's registry has no place on
// the server).

// 共享 v3 模块本身对 server 可用，单独导入它不会出错。
import { defineFacet } from "@acme/app/v3";
// web kind 专属模块：版本 v3 在 api.versions 中，但 server 的 hostPackages 没有这个说明符，因此被拒绝。
import { Panels } from "@acme/app/v3/web";

// setup 的贡献语法与 web.ts 相同；区别只在文件种类，构建器按 facet kind 分别检查 import。
export default defineFacet((_host, self) => self.contribute(Panels, { title: "a panel" }));
