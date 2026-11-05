// 所属：packages/durable/src/images，项目手写的 TypeScript 环境声明；不是 Photon 的生成物，也不是运行时模块。
// 解决的问题：cloudflare.ts 直接 import "@silvia-odwyer/photon/photon_rs_bg.wasm"，这个说明符没有真实的 JS
// 模块入口；若没有声明，TypeScript 会报找不到模块。本文件只为类型检查补一个模块形状。
// 职责边界：纯声明文件（.d.ts），不产生 JavaScript，不在运行时加载、编译或校验 wasm；Wrangler 的默认
// CompiledWasm 规则在打包时把该导入变成已编译的 WebAssembly.Module。
// 上游：cloudflare.ts 的默认导入；下游：TypeScript 提供的 WebAssembly.Module 类型。
// 能力清单：
// - declare module "...photon_rs_bg.wasm"：声明该导入说明符存在；唯一导出是默认值 WebAssembly.Module。
// 组合：tsconfig.build.json 的 files 显式包含本文件（exclude 里的 **/*.d.ts 不作用于 files），构建时类型可用。
// 示例：import photonWasm from "@silvia-odwyer/photon/photon_rs_bg.wasm";
//       createPhotonImages(photonWasm); // 此处 photonWasm 的静态类型为 WebAssembly.Module
// 建议阅读顺序：先看模块说明符与默认导出声明，再看 cloudflare.ts 如何把这个值交给 initSync。
// Imported by cloudflare.ts. Wrangler's default `CompiledWasm` rule makes a .wasm import a compiled module.
// 这是项目手写的环境声明，不是 Photon 生成物；告诉 TypeScript 特定 .wasm 导入的类型。
// 它不会在运行时加载或校验 Wasm；真正的转换由 Wrangler 的 CompiledWasm 规则完成。
// declare module 的参数是精确的模块说明符；只有字符串完全匹配的 import 才使用这个声明。
declare module "@silvia-odwyer/photon/photon_rs_bg.wasm" {
	// const 只声明此模块默认导出的值是已编译 WebAssembly.Module，不在这里创建实例。
	// 环境声明中的 const 没有初始化表达式，也不会生成代码；WebAssembly.Module 在这里是类型位置。
	const module: WebAssembly.Module;
	// 使 cloudflare.ts 的默认导入获得上面的类型；例如 photonWasm 可直接交给 initSync。
	// 在 .d.ts 中 export default 后面跟一个已声明的符号，表示默认导出就是该符号的类型。
	export default module;
}
