// The report plugin's server facet: one of each import a facet may have.

// 文件导读
// 所属：Chord 示例 37 的 plugins/report 插件，它的 server facet，也是本示例的核心：一个 facet 允许的每种导入各出现一次。
// 演示什么：
// - Node 内置模块（node:fs）：保持 external，求值时按 Node 规则加载。
// - 宿主包（@earendil-works/chord、@example/app、@example/legacy）：保持 external，求值时由应用的 modules 表回答；
//   其中 @example/app 是 ES 模块（默认 + 命名导入），@example/legacy 是 CommonJS 对象。
// - npm dependencies（example-greeting）：安装后由构建内联进脚本。
// - chord.external（example-native）：保持 external，运行时从本插件的 node_modules 加载。
// - 同 root 另一插件的文件（../shapes/contract.ts）：复制进脚本，记录在 built.copied。
// - 本插件自己的文件（data/rates.json）：不打包，运行时用 pluginFile(path) 得到绝对路径再读取。
// 同目录的 package.json（JSON 不能写注释，清单作用记录在这里）：
// - `name: "@example/report"`：插件身份，plugins.build(["@example/report"]) 用这个名字。
// - `type: "module"`：源码按 ES 模块解析；`private: true`：防止误发布。
// - `dependencies`：example-greeting 与 example-native 都写成 `file:` 指向 ../../deps，假 npm 据此复制。
// - `chord.external: ["example-native"]`：该包在 Node 构建中保持外部，求值时从本插件的 node_modules 加载。
// 同目录的 data/rates.json：运行时读取的数据文件，内容为 `{ "vat": 20 }`；JSON 不能写注释，所以用途记录在这里。
// 同目录的 env.d.ts：仅给编辑器/tsc 的模块声明，不参与构建与运行。
// 上游：plugins.load/reload 构建并求值本 facet；下游：host.get(Report) 的 text 成员，主程序打印它。
// 能力清单：
// - 默认导出：defineFacet(setup)，在 setup 中服务 local 契约 Report（一个不变的 text 字符串）。
// 典型结果："example app v3 | EUR 12.50 | ...vat | 20% | hello, plugins | node_modules/example-native/index.js"。
// 示例（真实接口）：export default defineFacet((host) => host.serve(Report, () => ({ text: constant("...") })));
// 建议阅读顺序：按 import 顺序读（内置 -> Chord -> 宿主包 -> 依赖 -> external -> 复制的契约），再看 rates 的读取，
// 最后看 defineFacet/serve/constant 如何把值暴露为 Watchable。

// Node 内置模块：构建保持 external，求值时由插件的 require 从 Node 加载，所以允许。
import { readFileSync } from "node:fs";
// Chord 的两个公开 API：constant 构造永不变化的 Watchable，defineFacet 定义 facet。
import { constant, defineFacet } from "@earendil-works/chord";
// 这个说明符总是保持 external，并由求值器绑定到当前插件的目录；在 facet 之外调用 pluginFile 会抛错。
import { pluginFile } from "@earendil-works/chord/plugins";
// Host packages: an ES module (default and named imports) and a CommonJS one, the app's own instances.
// @example/app 是 ES 模块命名空间：Chord 把它包装成带 __esModule 的对象，所以默认导入拿到 default 导出，
// 命名导入拿到 currency。两份值都是应用进程里的同一实例，不是复制品。
import app, { currency } from "@example/app";
// @example/legacy 是 CommonJS 的 module.exports 对象；默认导入直接得到该对象（它没有 __esModule 标记）。
import legacy from "@example/legacy";
// An npm dependency: inlined into this script by the build (installed first).
// example-greeting 列在本插件 dependencies 中；构建前必须先安装，否则构建报 "Could not resolve"（启动阶段的输出正是如此）。
import { greet } from "example-greeting";
// A `chord.external` package: left external, loaded from this plugin's node_modules when the script runs.
// 与 dependencies 的区别：不内联，脚本里的调用保持为 require("example-native")，由插件目录的 createRequire 解析。
import { where } from "example-native";
// A contract of another plugin of this root, by relative path: a copy built into this script.
// ../shapes/contract.ts 属于同一 root 的 shapes 插件；构建复制它并记录到 built.copied。复制文件只导入了宿主包，合规。
import { Report } from "../shapes/contract.ts";

// A file of this plugin, read at run time by its absolute path.
// 这一行在 facet 被求值时执行（不是构建时）：pluginFile 返回本插件目录内 data/rates.json 的绝对路径，
// readFileSync 读取文本，JSON.parse 解析成对象。`as { readonly vat: number }` 只是 TypeScript 类型断言，
// 运行时不做形状校验：文件不是合法 JSON 会在求值时抛错；是合法 JSON 但缺 vat，则要到拼字符串时才暴露。
// 这正是不用普通相对路径/__dirname 的原因：插件脚本没有文件身份，只有 pluginFile 能给出允许范围内的绝对路径。
const rates = JSON.parse(readFileSync(pluginFile("data/rates.json"), "utf8")) as { readonly vat: number };

// 默认导出一个 facet。defineFacet 只保存 setup；宿主在 load/reload 时调用它，setup 内只能做声明（这里是 host.serve）。
// host 的类型参数来自应用固定的 principal；本例没有 address/principal 需求，local 契约即可。
export default defineFacet((host) =>
	// serve(Report, factory)：把 local 契约 Report 绑定到工厂。Report 的 params 为空，所以工厂不需要参数；
	// 工厂返回实现对象，其中 state 成员 text 的值必须是 Watchable<string>（由 constant 提供）。
	host.serve(Report, () => ({
		// constant(value) 返回一个永不变化的 Watchable，所以主程序读取 .text.value 得到固定字符串。
		// 下面六段依次来自：ES 模块宿主包的默认导出、它的命名导出、CJS 宿主包、pluginFile 读取的文件、
		// 构建时内联的依赖、chord.external 包。
		text: constant(
			[
				// app 的 default 导出：名字和版本 -> "example app v3"。
				`${app.name} v${app.version}`,
				// app 的命名导出：1250 分 -> "EUR 12.50"。
				currency(1250),
				// CJS 宿主包的方法：右侧用 "." 补到 6 位 -> "...vat"。
				legacy.pad("vat", 6),
				// 运行时从 data/rates.json 读到的值 -> "20%"。
				`${rates.vat}%`,
				// 构建时内联的 example-greeting -> "hello, plugins"。
				greet("plugins"),
				// chord.external 的 example-native：where() 返回其模块文件路径，取最后三段 ->
				// "node_modules/example-native/index.js"。
				// biome-ignore format: 保持原始单行表达式，学习注释不改变代码格式。
				where().split("/").slice(-3).join("/"),
			].join(" | "),
		),
	})),
);
