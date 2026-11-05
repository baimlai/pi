/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/49-plugin-api/plugins/ancient/server.ts，ancient 插件的 server facet。
 * 同目录 package.json 是发现清单：name "@acme/ancient" 是插件身份，private 防止误发布，type: "module"
 * 让源码按 ES 模块解析；没有 dependencies/chord.external。JSON 不能写注释，清单说明集中写在这里。
 * 演示什么：插件 import 已下线的 API 版本时的构建拒绝。main.ts 的 api.versions 只有 ["v3", "v2"]，
 * 因此 "@acme/app/v1" 无法解析为可用版本，插件不会进入宿主，其他插件照常加载。
 * 上游/下游：main.ts 发现本插件并按 server kind 构建；类型来自同目录 env.d.ts 的手写声明。
 * 能力清单：默认导出一个 facet，向 v1 的 Greetings 贡献一条问候（只在源码层面存在）。
 * 典型运行顺序：发现 -> 构建报告 import 版本不可用 -> evaluate/加载被跳过 -> main.ts 打印失败原因。
 * 示例（真实签名）：import { defineFacet, Greetings } from "@acme/app/v1";
 * 预期构建错误：'\"@acme/app/v1\": @acme/app/v1 is not available: this app provides v3, v2'。
 * 建议阅读顺序：先看 import 的版本段 v1，再对照 main.ts 的 api.versions；错误位置会包含本文件行列号。
 * 前置条件：必须由 main.ts 加载；单独执行本文件不会注册任何东西。
 */
// A plugin written against v1, which the app no longer provides: refused at build, naming the versions it has.

// 该说明符来自 env.d.ts 的 ambient 声明，TypeScript 能通过；esbuild 构建期的 API 规则则按真实版本清单拒绝。
// 两个符号都是普通导入：defineFacet 来自“旧 API”，Greetings 是旧注册表名（v1 版本）。
import { defineFacet, Greetings } from "@acme/app/v1";

// 默认导出 facet：setup 收到 host 与 self，向 Greetings 贡献字符串。构建阶段失败，所以这段 setup 实际不会运行。
// _host 的命名表示刻意忽略宿主参数。
export default defineFacet((_host, self) => self.contribute(Greetings, "hello from v1"));
