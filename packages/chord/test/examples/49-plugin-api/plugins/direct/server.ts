/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/49-plugin-api/plugins/direct/server.ts，direct 插件的 server facet。
 * 同目录 package.json 是发现清单：name "@acme/direct"、private、type: "module"；JSON 不能写注释，说明写在这里。
 * 演示什么：配置了应用 API 后，插件不能直接 import Chord。应用 API 应 re-export 允许插件使用的部分；
 * 直接导入会在构建时报错，错误文本会指向最新 API 版本，而不是让插件悄悄依赖内部实现。
 * 上游/下游：main.ts 发现并构建本插件；构建失败后它不进入宿主，只有错误出现在 LoadReport.failed。
 * 能力清单：源码层面定义了一个空 facet；运行时不会执行。
 * 典型运行顺序：发现 -> 构建解析 import 时拒绝 -> 跳过求值 -> main.ts 打印失败原因。
 * 示例（真实签名）：import { defineFacet } from "@earendil-works/chord";
 * 预期构建错误：'plugins import Chord through the app's API ("@acme/app/v3"), never directly'。
 * 建议阅读顺序：对照 v3.ts 的 re-export 清单，理解为何插件应改从应用 API 导入。
 * 前置条件：必须由 main.ts 加载；单独执行本文件不会注册任何东西。
 */
// A plugin importing Chord directly: refused, pointing to the app's API (which re-exports what plugins may use).

// 直接导入 Chord 包：唯一例外是 "@earendil-works/chord/plugins" 的 pluginFile（此处未用），其余子路径也会被拒。
// 这条规则只在应用声明了 api 时生效；没有 api 时 hostPackages 决定放行范围。
import { defineFacet } from "@earendil-works/chord";

// setup 为空函数：本来也不向任何契约贡献。构建拒绝发生在 import 解析阶段，早于求值，所以这里没有运行机会。
export default defineFacet(() => {});
