/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/49-plugin-api/plugins/ancient/env.d.ts，插件 ancient 的手写环境声明。
 * 演示什么：插件按 v1 API 编写，但应用已不提供 "@acme/app/v1" 模块——没有可对照的源码。作者用
 * 环境模块声明（ambient module declaration）给 TypeScript 一个最小类型面，让旧源码通过类型检查。
 * 这只影响编译期：构建插件时解析器按 api.versions 检查说明符，仍会拒绝 v1；运行前就失败，不会求值。
 * 上游/下游：同目录 package.json 提供插件身份 "@acme/ancient"；server.ts 从这里声明的模块 import。
 * 能力清单：声明 defineFacet 与 Greetings 两个导出，类型都刻意放宽（unknown），只保证调用能编译。
 * 示例（真实签名）：declare module "@acme/app/v1" { export const Greetings: unknown; }
 * 建议阅读顺序：先看 declare module 的名字，再读 server.ts 如何触发构建错误。
 * 前置条件：仅作为类型声明被 server.ts 使用；单独执行无运行时效果（.d.ts 不产生 JS）。
 */
// Types of the API version this plugin was written against: the app no longer provides it (no module to type-check
// against, the build refuses the import), so the plugin's last author left these.

// declare module "specifier" 是环境模块声明：告诉 TypeScript“存在这个模块，形状如下”，不会生成运行时代码。
// 它只在本编译单元内生效，不能让 esbuild 的 API 检查放行——构建仍按真实的 api.versions 拒绝该说明符。
declare module "@acme/app/v1" {
	// 旧版 defineFacet 的签名被简化：host 与返回值都是 unknown，self 只声明 contribute 一个方法。
	// 这是编译期的宽容面，不表示运行时真的接受任意形状；真实 Chord 的 defineFacet 约束严格得多。
	export function defineFacet(
		setup: (host: unknown, self: { contribute(registry: unknown, value: string): void }) => void,
	): unknown;
	// Greetings 只声明为 unknown，因此 server.ts 把它传给 contribute 的 registry 参数能通过类型检查。
	// 运行时构建在解析 import 时就失败，这些形状不会被执行。
	export const Greetings: unknown;
}
