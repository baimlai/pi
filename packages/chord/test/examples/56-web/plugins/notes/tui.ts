// 文件导读
// 所属：packages/chord/test/examples/56-web/plugins/notes，Chord 示例 56 的内置插件（终端 facet）。
// 同目录 package.json 是插件清单：`name`（@board/notes）是插件身份（注册表排序、dirty 检测、
// rollout 步骤名）；`private: true` 防止误发布；`type: "module"` 指定 ESM。
// 清单由 app kit 的插件加载/构建器读取，代码文件不解析它。
// 作用：向终端 Lines 注册表贡献一行文本。服务器把本文件构建成终端沙箱可执行的注册脚本；
// tui/main.ts 的 compose 汇总所有贡献并重绘。
// 上游：插件构建器打包；startTerminalRuntime 在沙箱中执行注册脚本后，TuiScope 订阅 Lines。
// 下游：`@board/app/v1` 与 `@board/app/v1/tui` 由构建器映射到应用 API 模块；无网络、无文件。
// 能力清单：
// - 默认导出 `defineFacet(...)`：setup 贡献字符串 "Notes: Buy milk"。
// 典型效果：终端 Board 标题下出现一行 "  Notes: Buy milk"（缩进与颜色由终端入口添加）。
// 阅读顺序：先看 import 说明符，再看 default export。
// 运行方式：随示例 56 构建；不能单独执行。

// The notes plugin's terminal facet: a line on the terminal board.

import { defineFacet } from "@board/app/v1";
import { Lines } from "@board/app/v1/tui";

// Lines 注册表的贡献类型是 string，因此第二个参数直接是字符串，而不是 { value } 包装。
// 具体如何合并（按插件名排序、map 取 value）由服务端/客户端 facet 的 compose 决定。
export default defineFacet((_host, self) => self.contribute(Lines, "Notes: Buy milk"));
