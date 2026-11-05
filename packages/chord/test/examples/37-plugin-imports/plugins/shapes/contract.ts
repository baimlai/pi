// The shapes plugin's contract (a contracts-only plugin): other plugins import this file and get their own copy of it.
// A copied file may import host packages and files of its own plugin only.

// 文件导读
// 所属：Chord 示例 37 的 plugins/shapes 插件；本文件是它的契约文件，也是“被复制进其他插件”的示例。
// 演示什么：shapes 没有 server facet（应用只声明了 server 这一种 kind，而该目录没有 server.ts），所以它是
// contracts-only 插件：会被发现、会被其他插件通过相对路径导入，但永远不会被加载执行。Report 插件执行
// `import { Report } from "../shapes/contract.ts"` 时，构建把本文件复制进 Report 的脚本（记录在 built.copied）。
// 复制规则只允许宿主包和该文件自己插件的文件，因此本文件只能从 @earendil-works/chord 导入；units.ts 演示了违反
// 规则的后果。
// 同目录的 package.json（JSON 不能写注释，清单作用记录在这里）：
// - `name: "@example/shapes"`：插件身份，日志和 plugins.build 使用它；目录名不参与身份。
// - `type: "module"`：源码按 ES 模块解析。
// - `private: true`：防止误发布。
// 上游：main.ts 的 createPlugins 发现 plugins/ 根；report 通过相对路径导入本文件（ruler 导入的是同目录的 units.ts）；
// 下游：Report 契约在主程序的 TypeScript 类型里和 Report 插件的脚本里各有一份声明，但契约身份由 name + version
// 决定，仍指向同一类型。
// 能力清单：
// - Report：local 契约（version 1，无参数，一个 state 成员 text: string）。
// 示例（真实用法）：import { Report } from "../shapes/contract.ts";
//   const report = await host.get(Report, {}, context);  // 由 Report 插件的 facet 服务
// 建议阅读顺序：先看 local 的三个参数，再看 str schema 在工厂里对应的 Watchable<string> 类型。

// 从 Chord 的公共入口导入契约声明函数与 schema 构造函数。对复制文件来说这是允许的“宿主包导入”；
// 构建保持该说明符 external，求值时 require 返回应用传入的同一个 Chord 模块实例。
import { local, str } from "@earendil-works/chord";

// 声明一个 local 契约。参数依次是：
// - "example.report"：契约名，和 version 一起构成跨插件的类型身份。
// - version: 1：本声明的版本号；升级时在同一契约历史里追加版本。
// - params: {}：空参数，表示该对象在宿主上只有一个实例。
// - members: { text: str() }：text 是 state 成员；schema 描述线上/存储中的值类型。
// local() 在运行时检查名称、键集合和成员类别（方法、keyed、state）。schema 描述成员值类型并参与契约身份/编码；
// 方法参数会在提供方按 schema 校验，而 state 成员的值和调用结果从不做运行时校验（设计 §4 Values、§5 表）。
// 返回值是 Contract 句柄，不是对象实例；host.serve 用它注册工厂，host.get 用它请求对象。
/** A report: its lines. */
export const Report = local("example.report", { version: 1, params: {}, members: { text: str() } });
