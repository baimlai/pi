// Types for the report plugin's imports that its directory does not hold: the app's host packages (an app ships their
// types with its plugin template) and its dependencies before `npm install` (their own types once installed).

// 文件导读
// 所属：Chord 示例 37 的 plugins/report 插件目录，一个只含 TypeScript 环境模块声明的 .d.ts 文件。
// 作用：给编辑器和 tsc 提供 Report 插件用到、但该目录没有真实安装的类型——应用的宿主包（@example/app、
// @example/legacy）和 npm 依赖（example-greeting、example-native）。真实应用通常把宿主包类型随插件模板提供；
// 依赖的类型在 npm install 后来自各包自己的 .d.ts。本文件不参与运行时：esbuild 不做类型检查，也不会加载 .d.ts。
// 上游：仓库根 tsconfig 的 include 覆盖 packages/*/test/**/*，TypeScript 因此读取本文件；下游：report/server.ts
// 的 import 语句获得声明，编辑器能补全和报类型错误。删除本文件只影响类型提示，示例仍能构建和运行（esbuild 只剥离类型）。
// 能力清单：
// - declare module "@example/app"：默认导出应用信息对象，命名导出 currency。
// - declare module "@example/legacy"：默认导出带 pad 的 CommonJS 对象。
// - declare module "example-greeting"：命名导出 greet。
// - declare module "example-native"：命名导出 where。
// 示例：这些声明只约束编译期；若运行时实际导出缺失，错误会在求值或调用时出现，TypeScript 无法阻止。
// 建议阅读顺序：对照 report/server.ts 的 import 语句逐个模块看，注意声明与真实导出的形状必须一致。

// 声明一个环境模块（ambient module）：告诉 TypeScript “名为 @example/app 的模块存在，形状如下”。
// 本文件没有任何 import/export 语句，因此整体是全局声明文件；declare module 的字符串就是导入说明符。
declare module "@example/app" {
	// 先在模块作用域内声明常量，再由 export default 导出；类型字面量中的 readonly 只阻止编译期赋值。
	const app: { readonly name: string; readonly version: number };
	// 默认导出绑定上面声明的常量，对应 `import app from "@example/app"`。
	export default app;
	// 命名导出函数，对应 `import { currency } from "@example/app"`；参数和返回值都是编译期检查。
	export function currency(cents: number): string;
}

// CommonJS 宿主包的形状：默认导入得到对象本身；声明要求 text 为 string、width 为 number，运行时由实现自行转换。
declare module "@example/legacy" {
	const legacy: { pad(text: string, width: number): string };
	export default legacy;
}

// 本地依赖包；安装后在插件目录的 node_modules 中，但编辑器类型检查先靠这份声明。
declare module "example-greeting" {
	export function greet(name: string): string;
}

// chord.external 包；运行时从插件的 node_modules 加载，类型仍由这份声明提供。
declare module "example-native" {
	export function where(): string;
}
