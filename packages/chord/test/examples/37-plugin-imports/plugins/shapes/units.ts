// A file of the shapes plugin that imports a package (not a host package): fine for the shapes plugin itself, but a
// plugin importing this file would copy it, and a copied file may not import packages (the ruler plugin shows it).

// 文件导读
// 所属：Chord 示例 37 的 plugins/shapes 插件，一个普通源文件（既不是 facet 入口，也不是契约）。
// 演示什么：本文件从一个普通 npm 包 @earendil-works/pi-schema 导入 schema 构造函数。对 shapes 插件自己而言，这不会
// 触发“复制文件”规则，而是走普通依赖规则（包必须在该插件 package.json 的 dependencies 里声明，才会被内联）；
// 一旦 ruler 插件通过相对路径导入本文件，构建会把本文件复制进 ruler 的脚本，而复制文件只允许导入宿主包和它自己
// 插件的文件，于是这里的包导入被拒绝，ruler 的 server facet 构建失败（错误位置随源码行号变化）。
// 上游：plugins/ruler/server.ts 的 `import { Millimetres } from "../shapes/units.ts"`；构建器把本文件记录进
// built.copied；下游：无——复制失败后从未执行。
// 能力清单：
// - Millimetres：`num({ minimum: 0 })` 生成的数字 schema，仅用于演示复制限制。
// 示例（真实构建错误的文本，行列号随源码注释变化）：../shapes/units.ts:<line>:<col>: "@earendil-works/pi-schema":
//   a file copied from plugin "@example/shapes" may import only host packages and files of its own plugin
// 建议阅读顺序：先看 import 的来源类别，再看导出常量与 num 的选项。

// @earendil-works/pi-schema 不是本例的宿主包（modules 表里没有它），也不是 shapes 的 dependencies 成员。
// num 是 schema 构造器：调用只生成描述对象，不在这里校验任何值。
import { num } from "@earendil-works/pi-schema";

// 生成 `{ type: "number", minimum: 0 }` 形式的 schema 快照；TypeScript 类型是 Schema<number>。
// minimum 是运行时可读的约束；若它被用作方法参数 schema，校验会在调用边界发生，而不是在声明这一行。
// state 成员的值和调用结果不做校验，所以 schema 本身不等于运行时保证。
/** A length in millimetres. */
export const Millimetres = num({ minimum: 0 });
