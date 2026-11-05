// 文件导读
// 所属：packages/chord/test/examples/50-plugin-imports/plugins/notes，notes 插件的共享契约文件（slice 12 §2、§3）。
// 作用：只声明一份 local 契约 acme.notes，供 notes 自己的 server facet 和同根 search 插件的 server facet 使用。
// 契约是纯数据，没有默认导出，因此本文件不是 facet；构建时它作为同根相对导入被复制进导入方的脚本。
// 上下游：discovery 通过同目录 package.json 识别插件名，server.ts 是对应的 server facet；build 读取本文件；
// 下游是 notes/server.ts 的 host.serve 与 search/server.ts 的 self.get，二者通过同一契约身份绑定。
// 能力：Notes——版本 1、空参数、一个字符串状态成员 text 的本地契约句柄。
// 运行：由 main.ts 的构建与加载间接执行；命令见 50-plugin-imports/main.ts 文件头。
// 示例：import { Notes } from "./contract.ts"; host.serve(Notes, () => ({ text: constant("…") }));
// 阅读顺序：先看 local 的声明，再读 server.ts 如何服务它。
// The notes plugin's shared contract: data only, importable from every kind. Other plugins of this root import it by
// relative path; the build copies it into their scripts.

// 只从应用 API 导入构建器：插件不直接依赖 Chord，构建检查会拒绝 @earendil-works/chord。
import { local, str } from "@acme/app/v3";

/** The notes, as one text. */
// local 声明本地契约：名称、版本、参数 schema 和成员表。声明时会运行时检查名称与成员形状；
// params: {} 表示没有参数；members.text 用 str() 声明为字符串状态成员。
// 返回的 Notes 是契约句柄：类型信息在编译期，运行时身份由名字、版本和 schema 共同决定。
export const Notes = local("acme.notes", { version: 1, params: {}, members: { text: str() } });
