// 文件导读
// 所属：packages/chord/test/examples/51-single-file-plugin/plugins，单文件插件 clock 的 server facet。
// 作用：演示单文件插件可以导入应用 API 的“本种类模块” @acme/app/v3/server，并把 serverName() 的结果放进对象文本。
// 上下游：discovery 把 clock.server.ts 识别为插件 clock（布局 file）；build 允许共享 API 与 server 模块；load 后
// main.ts get Clock 读取文本。
// 能力：Clock（example.clock，版本 1，params {}，成员 text: str()）；默认导出的 Facet。
// 运行：node --conditions=source --experimental-strip-types test/examples/51-single-file-plugin/main.ts
// 示例：const Clock = local("example.clock", { version: 1, params: {}, members: { text: str() } });
// 阅读顺序：hello.server.ts -> 本文件。
// Another single-file plugin: a line naming the server, through the server's module of the API.

// 共享 API 与 server 种类模块都是宿主包，求值时由宿主提供实例，不会被打进脚本。
import { constant, defineFacet, local, str } from "@acme/app/v3";
import { serverName } from "@acme/app/v3/server";

// 单文件插件没有 package.json，契约只能内联声明；main.ts 用相同声明绑定它。
const Clock = local("example.clock", { version: 1, params: {}, members: { text: str() } });

// 工厂无参数；模板字符串在对象激活时调用 serverName()，结果包在 constant 里成为永不变化的状态成员。
export default defineFacet((host) => host.serve(Clock, () => ({ text: constant(`ticking on ${serverName()}`) })));
