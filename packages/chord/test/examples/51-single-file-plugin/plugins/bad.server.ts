// 文件导读
// 所属：packages/chord/test/examples/51-single-file-plugin/plugins，单文件插件 bad 的 server facet（反面示例）。
// 作用：单文件插件只能导入宿主包（应用 API）；这里导入根目录的 helper.ts，构建被拒绝，错误提示把它改成目录。
// 上下游：discovery 把 bad.server.ts 识别为插件 bad 的 server facet；build 失败；load 把 bad 放进 loaded.failed，
// 但不影响其他插件。helper.ts 本身不是插件。
// 能力：默认导出的 Facet 仅用于触发构建错误；setup 从未执行。
// 运行：node --conditions=source --experimental-strip-types test/examples/51-single-file-plugin/main.ts
// 示例：import { helper } from "./helper.ts"; 在单文件插件里是非法的。
// 阅读顺序：helper.ts -> 本文件 -> main.ts 的失败输出。
// A single-file plugin importing another file: refused at build, saying to make it a directory.

import { defineFacet } from "@acme/app/v3";
// 相对导入非宿主包：单文件插件没有目录，构建器无法把其他文件视为“本插件文件”，因此拒绝。
import { helper } from "./helper.ts";

// 若构建通过，setup 会打印 helper；实际运行中构建已失败，这一行不会执行。
export default defineFacet(() => console.log(helper));
