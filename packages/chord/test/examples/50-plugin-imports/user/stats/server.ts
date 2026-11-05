// 文件导读
// 所属：packages/chord/test/examples/50-plugin-imports/user/stats，Bob 的 stats 插件（用户根，非必选）。
// 作用：从 dependencies 导入 @bob/words（不是宿主包），构建时把安装版本内联；服务 Stats 对象，文本包含词数和依赖版本。
// 上下游：example 50 先在 user/stats 目录运行 npm install（git+file 依赖钉在第一个提交），再 build/load；main.ts get
// Stats 并打印 "4 words (@bob/words 1)"。即使仓库后来有版本 2，安装的提交仍是版本 1。
// 同目录 package.json 是清单（JSON 不能注释）：name = "@bob/stats" 是插件身份；dependencies 里的 @bob/words 是占位
// git URL，main.ts 第 1 步会把它替换成临时裸仓库和第一个提交的哈希；npm 与 build 读取该字段。
// 能力：Stats（bob.stats，版本 1，params {}，成员 text: str()）；默认导出的 Facet。
// 运行：node --conditions=source --experimental-strip-types test/examples/50-plugin-imports/main.ts
// 示例：import { VERSION, words } from "@bob/words"; const n = words("buy milk, call bob"); // n === 4
// 阅读顺序：package.json 的说明 -> 本文件 -> words/words.ts。
// Bob's stats plugin (the user's root): counts words with `@bob/words`, a dependency pinned to a git commit. The build
// inlines the package at the installed commit, whatever the repository holds since.

import { constant, defineFacet, local, str } from "@acme/app/v3";
// 包名导入走 dependencies：构建器从插件的 node_modules 内联安装版本；它不是宿主包，因此不会在求值时由宿主提供。
import { VERSION, words } from "@bob/words";

// 一个空参数、一个字符串成员的本地契约。
const Stats = local("bob.stats", { version: 1, params: {}, members: { text: str() } });

// 工厂不接收参数；模板字符串在对象激活时求值一次，words 的计数和 VERSION 都来自被内联的依赖代码。
export default defineFacet((host) =>
	host.serve(Stats, () => ({ text: constant(`${words("buy milk, call bob")} words (@bob/words ${VERSION})`) })),
);
