// 文件导读
// 所属：packages/chord/test/examples/56-web/plugins/notes，Chord 示例 56 的内置插件（web facet）。
// 同目录 package.json 是插件清单：`name`（@board/notes）是插件身份（注册表排序、dirty 检测、
// rollout 步骤名）；`private: true` 防止误发布；`type: "module"` 指定 ESM。
// 清单由 app kit 的插件加载/构建器读取，代码文件不解析它。
// 作用：向页面 Panels 注册表贡献一张 Notes 面板。它与同目录 tui.ts 是同一插件的两个 facet：
// 服务器按宿主种类分别构建并下发，web 页面只会加载 web facet。
// 上游：插件构建器打包本文件；页面的 startClient 执行注册脚本。
// 下游：`@board/app/v1` 与 `@board/app/v1/web` 由构建器映射到应用 API 模块；无网络、无文件。
// 能力清单：
// - 默认导出 `defineFacet(...)`：setup 贡献 { title: "Notes", text: "Buy milk" }。
// 典型效果：页面出现标题为 Notes、文本为 Buy milk 的面板。
// 阅读顺序：先看 import 说明符，再看 default export。
// 运行方式：随示例 56 构建；不能单独执行。

// The notes plugin's web facet: a panel on the board page.

import { defineFacet } from "@board/app/v1";
import { Panels } from "@board/app/v1/web";

// 注册表贡献在 setup 中声明；面板对象是普通数据，不包含回调，因此可安全地在插件与页面之间传递。
export default defineFacet((_host, self) => self.contribute(Panels, { title: "Notes", text: "Buy milk" }));
