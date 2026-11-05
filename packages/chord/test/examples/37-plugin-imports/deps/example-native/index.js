// A package a plugin keeps external (`chord.external`: a native addon, a package that reads its own files): the build
// leaves its import as it is, and the facet's `require` loads it from the plugin's `node_modules` at run time.

// 文件导读
// 所属：Chord 示例 37 的 deps/example-native，一个被插件标记为 `chord.external` 的本地包。
// 演示什么：external 包在构建时保持为 require 调用，求值时由插件的 node_modules 通过 createRequire(插件目录) 加载。
// 它模拟“原生插件或需要读取自身文件的包”：这类包不能被打包成一段脚本，必须在运行时由 Node 从磁盘解析。本文件
// 利用真实的 CommonJS 全局 __filename 返回自己的路径，恰好说明为什么 external 包可以、而插件脚本不可以依赖文件身份。
// 同目录的 package.json（JSON 不能写注释，字段含义记录在这里）：
// - `name: "example-native"`：import 说明符与安装后的目录名。
// - `version: "1.0.0"`：清单字段；file: 依赖不经过 registry 解析。
// - `private: true`：防止误发布。
// - `type: "commonjs"`：本文件按 CommonJS 解析，exports 可用。
// - `main: "index.js"`：包入口。
// 上游：report/package.json 的 dependencies 与 `chord.external` 都列出 example-native；main.ts 的假 npm 把它复制进
// report/node_modules；构建时保持 external；下游：Report 插件调用 where()。
// 能力清单：
// - where()：返回本模块文件的绝对路径。
// 示例（真实运行时值）：where() 可能返回 "/tmp/.../plugins/report/node_modules/example-native/index.js"。
// 建议阅读顺序：文件头 -> exports.where 的赋值与 __filename 的来源。

// exports 是 module.exports 的初始引用；给 exports.where 赋值就是给模块导出对象加一个命名导出。
// 箭头函数体直接读取 __filename：这个变量由 Node 在加载本 CommonJS 模块时提供，指向本文件。
// 插件脚本被 vm 求值，没有真实文件身份，所以同样的写法在插件里是构建错误；外部包则仍由普通 require 加载。
exports.where = () => __filename;
