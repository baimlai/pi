/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/49-plugin-api/plugins/mixed/server.ts，mixed 插件的 server facet。
 * 同目录 package.json 是发现清单：name "@acme/mixed"、private、type: "module"；JSON 不能写注释，说明写在这里。
 * 演示什么：同一个 facet 混用两个 API 版本会被拒绝。即使 v2 的 Hellos 目前只是 v3 Greetings 的别名，
 * 构建规则也不做跨版本推断：两个版本的注册表可能是不同契约，混用会让贡献去向不确定。
 * 上游/下游：main.ts 发现并构建；失败只影响本插件，hello 与 legacy 仍加载。
 * 能力清单：源码层面定义 facet 并向 Hellos 贡献；运行时不会执行。
 * 典型运行顺序：发现 -> 构建记录两个版本 -> 混版本检查拒绝 -> 跳过求值 -> main.ts 打印失败原因。
 * 示例（真实签名）：import { Hellos } from "@acme/app/v2"; import { defineFacet } from "@acme/app/v3";
 * 预期构建错误：'one facet imports one version of @acme/app: this one imports @acme/app/v2 (...) and @acme/app/v3 (...)'。
 * 建议阅读顺序：先确认两个 import 的版本段不同，再理解“一个 facet 一个版本”的规则。
 * 前置条件：必须由 main.ts 加载；单独执行本文件不会注册任何东西。
 */
// A facet importing two versions of the API: refused (v2's and v3's registries may be different ones).

// 第一次导入版本 v2：构建器记录版本及其首个导入者。
import { Hellos } from "@acme/app/v2";
// 第二次导入版本 v3：版本集合出现两个值，构建结束前触发 mixedVersions 检查并报告。
import { defineFacet } from "@acme/app/v3";

// setup 本身语法合法；错误来自 import 解析阶段，因此这个贡献不会发生。
export default defineFacet((_host, self) => self.contribute(Hellos, "hello from two versions"));
