// A small npm package (local, so the example needs no network): a plugin lists it in its `dependencies`, and the build
// inlines it into the plugin's script.

// 文件导读
// 所属：Chord 示例 37 的 deps/example-greeting，一个被当作 npm 依赖安装的本地包。
// 演示什么：插件在 package.json 的 dependencies 里写包名，`installDependencies` 把包装进插件自己的 node_modules，
// 构建时 esbuild 按“已声明的依赖”规则把包源码内联进插件脚本。这与宿主包相反：宿主包保持 external，由应用注入。
// 同目录的 package.json（JSON 不能写注释，字段含义记录在这里）：
// - `name: "example-greeting"`：import 说明符与安装后的目录名。
// - `version: "1.0.0"`：真实包会参与 npm 解析；本例用 file: 依赖，只影响清单完整性。
// - `private: true`：防止误发布到 npm。
// - `type: "module"`：本文件按 ES 模块解析，因此可以使用 export。
// - `main: "index.js"`：包入口文件。
// 上游：plugins/report/package.json 的 `"example-greeting": "file:../../deps/example-greeting"`；副本里尚未安装时
// 构建会失败（这正是启动阶段 @example/report 被排除的原因），安装后构建成功。
// 下游：Report 插件调用 greet("plugins")。
// 能力清单：
// - greet(name)：返回 "hello, " 加名字的字符串。
// 示例（真实运行时值）：greet("plugins") 返回 "hello, plugins"；构建后这段函数源码被复制进 Report 的脚本。
// 建议阅读顺序：文件头 -> package.json 字段对照 -> greet 的参数和模板字符串。

// export 是 ES 模块语法，由 package.json 的 `type: "module"` 启用。
// 参数 name 没有类型注解：这是手写 JavaScript，构建器只剥离/打包，不做类型检查。
export function greet(name) {
	// 模板字符串把参数插入固定文本；返回值在插件里被拼进 Report 的 text。
	return `hello, ${name}`;
}
