// 文件导读
// 所属：packages/chord/test/examples/50-plugin-imports/user/reach，用户根（另一个仓库）中的插件，演示跨根相对导入被拒绝。
// 作用：server facet 用 ../../plugins/notes/contract.ts 导入 app 根里的契约；该路径离开自己的根，构建器报错并提示通过
// 应用 API 或 dependencies 获取契约。
// 上下游：example 50 的 discovery 扫描 user/ 根（非必选）；build 失败；load 的报告里列出 reach，但不会让 load 拒绝。
// 同目录 package.json 是清单（JSON 不能注释）：name = "@bob/reach" 是插件身份，private/type 与其他插件相同。
// 能力：默认导出的 Facet（仅用于展示拒绝；若加载成功，setup 会打印契约名）。
// 运行：node --conditions=source --experimental-strip-types test/examples/50-plugin-imports/main.ts
// 示例：import { Notes } from "../../plugins/notes/contract.ts"; 在另一个根里这是被拒绝的写法。
// 阅读顺序：本文件 -> main.ts 的加载报告。
// A user's plugin (another root) importing the app's notes contract by its path: refused, a relative path leaving its
// root; a plugin of another repository takes contracts as a dependency (or from the app's API).

import { defineFacet } from "@acme/app/v3";
// 这个相对路径指向 app 根，而不是本插件的根；构建器解析后判定为 other-root 并拒绝。
import { Notes } from "../../plugins/notes/contract.ts";

// setup 不使用 host；Notes.name 只在构建通过并加载后才会执行。
export default defineFacet(() => console.log(Notes.name));
