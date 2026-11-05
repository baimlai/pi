// 文件导读
// 所属：packages/chord/test/examples/52-test-plugin/plugins/stats，stats 插件的 worker facet（被测插件）。
// 作用：演示三种声明：向 worker API 的 Indexers 注册表贡献条目；服务 Stats（按 project 统计 Notes 的词数）；服务
// TagLine（读取 Tags 契约并拼接标签）。示例故意不给 Tags 提供桩：TagLine 的请求会停在未绑定依赖上，供 main.ts 用
// t.unserved() 观察。
// 上下游：testPlugin 用生产构建打包本文件、求值并加载到内存宿主；Notes 契约由同根 notes/contract.ts 相对导入，运行时由
// main.ts 的 notesStub 提供；Indexers 由 helper 收集；Tags 无人服务。
// 同目录 package.json 是清单（JSON 不能注释）：name = "@acme/stats" 是插件身份；没有 dependencies，private/type 与
// 其他插件相同；testPlugin 的发现读取它。
// 能力：Stats（acme.stats，版本 1，params { project }，成员 words: int()）；TagLine（acme.tag-line，同一参数，成员
// text: str()）；Tags 只是本插件引用的契约声明；默认导出的 Facet。
// 运行：node --conditions=source --experimental-strip-types test/examples/52-test-plugin/main.ts
// 示例：self.contribute(Indexers, { name: "word count" }); self.get(Notes, { project });
// 阅读顺序：notes/contract.ts -> 本文件 -> main.ts。
// The stats plugin's worker facet: words per project over the notes plugin's `Notes`, an indexer contributed to the
// workers' `Indexers` registry, and tags over a `Tags` contract (the tags plugin's; this example's test stubs none).

import { defineFacet, int, local, str } from "@acme/app/v3";
// Indexers 只在 worker 种类模块中存在；构建器会确认 worker facet 导入它合法。
import { Indexers } from "@acme/app/v3/worker";
// 同根相对导入：构建时把 notes 的契约文件复制进本脚本；测试进程再按相同声明绑定到桩。
import { Notes } from "../notes/contract.ts";

/** Words per project. */
// 三个契约参数都含 project，因此对象身份按 project 区分；成员类型分别是 int/str。
const Stats = local("acme.stats", { version: 1, params: { project: str() }, members: { words: int() } });

/** The tags plugin's contract, as this plugin uses it. */
const Tags = local("acme.tags", { version: 1, params: { project: str() }, members: { list: str() } });

/** The tags of a project, as this plugin shows them. */
const TagLine = local("acme.tag-line", { version: 1, params: { project: str() }, members: { text: str() } });

// setup 同时拿到 host 和 self：前者服务对象，后者做注册表贡献。
// 贡献在插件加载期间就写入注册表；工厂则按对象参数执行。
export default defineFacet((host, self) => {
	// Indexers 无人提供时，testPlugin 的辅助 facet 会接管并收集该条目。
	self.contribute(Indexers, { name: "word count" });
	// Stats 工厂解构参数 project；self.get 声明对 Notes 的依赖，Notes 未 live 时该对象等待。
	host.serve(Stats, ({ project }, self) => {
		const notes = self.get(Notes, { project });
		// derive 的同步纯函数把文本按空白切分并计数；结果为整数状态成员 words。
		return { words: self.derive([notes.text], ([text]) => text.split(/\s+/).filter(Boolean).length) };
	});
	// TagLine 工厂依赖 Tags；本示例没有 Tags 的桩，因此该对象停在 failed/waiting。
	host.serve(TagLine, ({ project }, self) => {
		const tags = self.get(Tags, { project });
		// 模板字符串在 derive 计算时求值，把标签列表拼成一行文本。
		return { text: self.derive([tags.list], ([list]) => `tags: ${list}`) };
	});
});
