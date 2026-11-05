// 文件导读
// 所属：packages/chord/test/examples/51-single-file-plugin/plugins，单文件插件 hello 的 server facet。
// 作用：文件名符合 `<name>.<kind>.ts`，因此它是插件 hello 的 server 文件；与 hello.web.ts 一起组成同一个插件的两个
// facet。它没有目录和 package.json，只能导入应用 API，契约内联声明。
// 上下游：discovery 按文件名分组；build 打包；load 在 server 宿主上执行 setup；main.ts get Hello 读取文本。第 2 步
// 会把本文件删除，改成 hello/ 目录插件，reload 视作同一个插件。
// 能力：Hello（example.hello，版本 1，params {}，成员 text: str()）；默认导出的 Facet。
// 运行：node --conditions=source --experimental-strip-types test/examples/51-single-file-plugin/main.ts
// 示例：export default defineFacet((host) => host.serve(Hello, () => ({ text: constant("hello from one file") })));
// 阅读顺序：本文件 -> hello.web.ts -> main.ts 第 2、3 步。
// A single-file plugin named `hello` (its file name: `<name>.<kind>.ts`), its server facet: it defines its contract
// inline and serves it. No directory, no package.json: it imports only the app's API.

import { constant, defineFacet, local, str } from "@acme/app/v3";

// 契约名 example.hello 由本插件定义，main.ts 重新声明同一份契约来获取对象。
const Hello = local("example.hello", { version: 1, params: {}, members: { text: str() } });

// 工厂不读参数；返回的 text 是常量，因此对象的状态不会变化。
export default defineFacet((host) => host.serve(Hello, () => ({ text: constant("hello from one file") })));
