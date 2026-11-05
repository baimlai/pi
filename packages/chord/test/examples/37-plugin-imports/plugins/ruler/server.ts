// The ruler plugin's server facet: imports a file of the shapes plugin that imports a package. Refused at build: a
// copied file may import only host packages and files of its own plugin.

// 文件导读
// 所属：Chord 示例 37 的 plugins/ruler 插件，它的 server facet。
// 演示什么：facet 通过相对路径导入同一 root 内另一个插件（shapes）的文件时，构建会把这个文件复制进本插件的脚本。
// 复制文件只允许导入宿主包和该文件自己插件的文件，不能导入普通 npm 包；units.ts 恰好导入了
// @earendil-works/pi-schema，因此 ruler 的整个 server facet 构建失败：启动时被排除，重载时仍被报告。
// 它和 paths、refused 一起说明“构建失败是返回值中的一项，不是异常”，不会中止其他插件的构建。
// 同目录的 package.json（JSON 不能写注释，清单作用记录在这里）：
// - `name: "@example/ruler"`：插件身份，错误报告和 plugins.build([...]) 使用它。
// - `type: "module"`：源码按 ES 模块解析。
// - `private: true`：防止误发布。
// 上游：main.ts 的 createPlugins 发现 plugins/ 根并构建所有 server facet；下游：构建器读取本文件，并因
// ../shapes/units.ts 的导入把该文件记为 copied，随后拒绝被复制文件里的包导入。
// 能力清单：
// - 默认导出：一个只打印 Millimetres 的 facet；只有构建成功时才会被求值和执行，本例中永远不会。
// 示例（真实构建错误文本，行列号随源码注释变化）：../shapes/units.ts:<line>:<col>: "@earendil-works/pi-schema":
//   a file copied from plugin "@example/shapes" may import only host packages and files of its own plugin
// 建议阅读顺序：先看两条 import 的区别（宿主包 vs 同根相对路径），再读 units.ts 的 import 与复制规则。

// defineFacet 来自宿主包：保持 external，求值时 require 返回应用传入的 Chord 模块实例。
import { defineFacet } from "@earendil-works/chord";
// 相对路径进入同一 root 的另一插件：允许，但构建会把目标文件复制进来并在 built.copied 中记录。
// 导入本身不是错误；错误出在被复制文件内部的包导入。
import { Millimetres } from "../shapes/units.ts";

// defineFacet 只保存 setup 回调并返回 facet 对象，不在此时执行。构建阶段先失败，所以这段 setup 从未运行。
export default defineFacet(() => {
	// 若构建成功，这里会打印 num() 生成的 schema 对象；在本例中只是说明复制文件的用途。
	console.log(Millimetres);
});
