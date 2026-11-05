/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/49-plugin-api/plugins/legacy/server.ts，legacy 插件的 server facet。
 * 同目录 package.json 是发现清单：name "@acme/legacy"、private、type: "module"；JSON 不能写注释，说明写在这里。
 * 演示什么：旧版本仍被支持时的兼容性。应用仍列出 v2，所以本插件构建通过；它使用 v2 的旧名字 Hellos，
 * 而 Hellos 在 v2.ts 中只是 Greetings 的别名，因此贡献落入同一个 acme.greetings 注册表。
 * 上游/下游：main.ts 的 modules 提供 "@acme/app/v2" 实例；core facet 按插件名顺序组合问候。
 * 能力清单：默认导出的 facet 向 Hellos（即 Greetings）贡献一条字符串。
 * 典型运行顺序：发现 -> 构建（v2 在 api.versions 中且模块可用）-> 求值 -> 贡献 -> 读端合成。
 * 示例（真实签名）：import { defineFacet, Hellos } from "@acme/app/v2";
 * 预期输出：hello from a v2 plugin（与 hello 的 v3 问候一起按插件名排序）。
 * 建议阅读顺序：对照 app/v2.ts 的 `Greetings as Hellos`，确认别名不是另一个注册表。
 * 前置条件：必须由 main.ts 加载；单独执行本文件不会注册任何东西。
 */
// A plugin written against v2 a year ago: the app still lists v2, so it builds and runs, through v2's names.

// 从 v2 模块导入：路径版本是 v2，构建允许；Hellos 的类型和值都来自 v3 的 Greetings（v2.ts re-export 改名）。
import { defineFacet, Hellos } from "@acme/app/v2";

// setup 中把 Hellos 贡献给宿主；宿主按注册表名 acme.greetings 找到同一记录，因此与 v3 插件混排。
// 字符串 "hello from a v2 plugin" 是贡献值，没有使用宿主参数。
export default defineFacet((_host, self) => self.contribute(Hellos, "hello from a v2 plugin"));
