// 文件导读
// 所属：packages/chord/test/examples/52-test-plugin/plugins/notes，notes 插件的契约文件，供 stats 插件的 worker facet
// 相对导入（构建时复制）。
// 作用：声明 acme.notes 契约，参数是 project，成员 text 是字符串。本示例不加载 notes 的 facet：测试用一个普通桩 facet
// 提供同一契约，桩在 main.ts 里用相同的名字、版本和 schema 重新声明。
// 上下游：testPlugin 的发现把本目录识别为一个只含契约的插件（同目录 package.json 提供名字 @acme/notes）；stats 的
// worker 构建复制本文件；运行时由 main.ts 的 notesStub 服务 Notes 对象。
// 同目录 package.json 是清单（JSON 不能注释）：name = "@acme/notes" 是插件身份；private/type 与其他插件相同。
// 能力：Notes——版本 1、参数 { project: string }、状态成员 text: string 的本地契约句柄。
// 运行：由 main.ts 的 testPlugin 构建 stats 时读取；命令见 52-test-plugin/main.ts 文件头。
// 示例：import { Notes } from "../notes/contract.ts"; self.get(Notes, { project });
// 阅读顺序：本文件 -> stats/worker.ts -> main.ts。
// The notes plugin's contract (its facets are not part of this example: a test of the stats plugin stubs them).

import { local, str } from "@acme/app/v3";

/** A project's notes, as one text. */
// 参数 schema 会在每次 get/hold 时检查；成员 text 的 schema 在对象实现返回时检查。
export const Notes = local("acme.notes", { version: 1, params: { project: str() }, members: { text: str() } });
