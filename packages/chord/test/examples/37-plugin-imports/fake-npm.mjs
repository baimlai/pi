// A stand-in for `npm install` (the example needs no network): run in a plugin's directory, it copies every
// `file:` dependency of the plugin's package.json into its node_modules, as npm would install it.

// 文件导读
// 所属：Chord 示例 37 的本地“假 npm”脚本（.mjs 是 ES 模块）。
// 作用：main.ts 的 createPlugins 通过 install 选项把 npm 命令换成 `[process.execPath, 本文件路径]`。因此
// `plugins.installDependencies("@example/report", context)` 实际执行的是：
//   <当前 Node 可执行文件> fake-npm.mjs install --omit=dev --legacy-peer-deps --ignore-scripts --no-audit --no-fund
// 工作目录是 report 插件目录。本脚本忽略后面的 npm 参数，只读取当前目录的 package.json，把每个 `file:` 依赖递归
// 复制到 node_modules/<包名>，从而在无网络环境模拟 npm 的安装结果。
// 能力清单：读取当前目录 package.json；拒绝非 file: 依赖；把每个 file: 依赖复制到 node_modules/<包名>。
// 上游：packages/chord/src/node/plugins/install.ts 的 installDependencies（子进程，cwd = 插件目录）；
// 下游：写入插件目录的 node_modules；之后构建从那里内联 example-greeting，求值/运行时从那里 require example-native。
// 输入：cwd 中的 package.json；输出：无 stdout；错误：读取失败、JSON 非法或遇到非 file: 依赖时抛出，进程以非零码退出，
// installDependencies 会把子进程输出放进拒绝的错误消息。
// 幂等性：可重复运行（同内容覆盖），但不会删除上一次留下而本次清单已移除的包。
// 示例（命令行）：cd plugins/report && node /path/to/fake-npm.mjs install
// 建议阅读顺序：package.json 的解构与 JSON 解析 -> 依赖循环 -> file: 校验 -> cpSync 复制。

import { cpSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// readFileSync("package.json") 相对于进程 cwd 解析，而 installDependencies 把 cwd 设为插件目录，所以读到的是
// 插件的清单。JSON.parse 的返回值在类型上是 any：这是脚本对 npm 清单的信任边界，下面的代码按“对象且带
// dependencies”使用它，没有额外的形状校验；若 dependencies 是 null，Object.entries 会抛 TypeError。
// 解构默认值 dependencies = {} 只在属性为 undefined 时生效，不会覆盖 null。
const { dependencies = {} } = JSON.parse(readFileSync("package.json", "utf8"));
// Object.entries 返回 [键, 值] 二元组数组；值来自 any，所以 spec 也是 any，startsWith 在运行时才校验。
for (const [name, spec] of Object.entries(dependencies)) {
	// 只支持 file: 依赖，因为示例不访问网络；真实 npm 还支持版本号、git、workspace 等来源。
	// 抛出会让 Node 以非零状态退出，installDependencies 捕获输出并拒绝。
	if (!spec.startsWith("file:")) throw new Error(`fake npm: ${name}@${spec} is not a local package`);
	// "file:../../deps/example-greeting" -> 去掉前缀得到相对路径，resolve 相对 cwd（插件目录）变成绝对路径。
	// 目标是 node_modules/<name>；recursive: true 允许复制目录，并在需要时创建包含父目录 node_modules 的目标路径。
	cpSync(resolve(spec.slice("file:".length)), join("node_modules", name), { recursive: true });
}
