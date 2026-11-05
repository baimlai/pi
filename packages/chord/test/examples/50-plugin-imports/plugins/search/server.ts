// 文件导读
// 所属：packages/chord/test/examples/50-plugin-imports/plugins/search，search 插件的 server facet。
// 作用：用相对路径导入同根 notes 插件的共享契约（构建时复制进本脚本）；定义 Search 契约并派生 hits。
// 上下游：example 50 的 build 打包 server 与 web 两个 facet；load 在 server 宿主上服务 Search；main.ts get Search
// 后读取 hits。运行期依赖 Notes 对象：self.get 把 Notes 记为依赖，Notes 未 live 时本对象等待。
// 同目录 package.json 是清单（JSON 不能注释）：name = "@acme/search" 是插件身份；private 与 type: "module" 的
// 含义与其他插件一致。
// 能力：Search（acme.search，版本 1，params {}，成员 hits: int()）；默认导出的 Facet。
// 运行：node --conditions=source --experimental-strip-types test/examples/50-plugin-imports/main.ts
// 示例：const notes = self.get(Notes, {}); return { hits: self.derive([notes.text], ([text]) => text.split(",").length) };
// 阅读顺序：notes/contract.ts -> 本文件 -> search/web.ts。
// The search plugin's server facet: uses the notes plugin's contract, imported by relative path (same root, same
// commit: a copy of that file in this script).

// int() 声明整数状态成员；local 定义本地契约。
import { defineFacet, int, local } from "@acme/app/v3";
// 跨插件、同根相对导入：构建时复制 notes/contract.ts 的内容，所以 search 与 notes 必须来自同一次检出。
import { Notes } from "../notes/contract.ts";

// 与 notes 的约定一样：名称、版本、空参数和一个整数成员。本契约不导出，main.ts 用相同的声明重新构造。
const Search = local("acme.search", { version: 1, params: {}, members: { hits: int() } });

// 工厂的第二个参数 self 提供依赖声明。_params 以单下划线开头表示本工厂不使用参数（团队的命名约定，不改变类型）。
export default defineFacet((host) =>
	host.serve(Search, (_params, self) => {
		// 声明对 Notes（空参数）的依赖；对象激活时会等待 Notes 可用，而不是立即失败。
		const notes = self.get(Notes, {});
		// derive 接收源数组和同步纯函数。回调参数与源一一对应，这里解构出 text；返回值必须是 JSON 值。
		// 固定文本 "buy milk, call bob, ship it" 按逗号切分得到 3 段，因此 hits 为 3。
		return { hits: self.derive([notes.text], ([text]) => text.split(",").length) };
	}),
);
