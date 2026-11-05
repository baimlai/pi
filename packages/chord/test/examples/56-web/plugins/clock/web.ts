// 文件导读
// 所属：packages/chord/test/examples/56-web/plugins/clock，Chord 示例 56 的内置插件（web facet）。
// 同目录 package.json 是插件清单：`name`（@board/clock）是插件身份，决定注册表排序、dirty 检测
// 和 rollout 步骤名；`private: true` 防止误发布到 npm；`type: "module"` 让该目录的 .ts 按 ESM 解析。
// 清单由 app kit 的插件加载/构建器读取，本代码文件不解析它。
// 作用：插件脚本的最小示例——向页面 Panels 注册表贡献一张面板。服务器把本文件构建成一个自注册
// 脚本（调用全局 chordFacet），页面加载后它注册的 facet 在客户端宿主里执行 setup。
// 上游：插件目录被 startBoard 复制到临时目录并交给 startServer 构建；main.ts 第 4 步修改本文件
// 代码里的初始面板文本，把时间推进一分钟，用来演示热更新。
// 下游：`@board/app/v1` 与 `@board/app/v1/web` 说明符由构建器解析到应用的 API 模块；运行时
// 不访问网络或文件。
// 能力清单：
// - 默认导出 `defineFacet(...)`：facet 的 setup 向 Panels 贡献标题为 Clock 的面板与它的初始文本。
// 典型效果：页面出现标题为 Clock、文本为代码中初始字符串的面板。
// 阅读顺序：先看 import 说明符，再看 default export 的 setup 回调。
// 运行方式：随示例 56 构建；不能单独执行。
// 说明：defineFacet 的 setup 必须同步且只做声明；真正的对象/注册表发布由宿主在 load 时完成。

// The clock plugin's web facet: a panel on the board page.

// 这两个说明符不是 npm 包：插件构建器把它们映射到 start.ts 的 api.modules / kinds 配置。
import { defineFacet } from "@board/app/v1";
import { Panels } from "@board/app/v1/web";

// 默认导出是插件加载器识别的 facet。
// 第一个参数 _host 本插件不使用（下划线是“有意忽略”的约定）；self 提供 contribute 等声明 API。
// self.contribute(Panels, 值)：值的类型由注册表的泛型参数（Panel）在编译期检查。
export default defineFacet((_host, self) => self.contribute(Panels, { title: "Clock", text: "12:00" }));
