// Imported by runtime-setup.ts. Bun's default loader for .wasm evaluates to the file's path.
// 为Bun启动模块的这条.wasm导入提供TS声明：默认值是可读文件路径，不是WebAssembly.Instance或二进制字节。
// .d.ts不产生运行时代码，实际资源内嵌/路径解析由Bun和打包流程负责；不因此让Node默认支持同一导入。
declare module "quickjs-wasi/quickjs.wasm" {
	// const描述外部模块暴露的字符串值，不在这里创建或检查磁盘文件。
	const path: string;
	// 供import quickjsWasmPath from该模块使用；runtime-setup再把字符串交配置setter。
	export default path;
}
