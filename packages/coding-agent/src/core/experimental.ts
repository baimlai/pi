// 为实验功能开关提供单一读取入口；每次调用读取环境，不在模块加载时缓存。
/**
 * 仅当环境变量 PI_EXPERIMENTAL 恰好是字符串 "1" 时返回 true，无文件或网络副作用。
 * 例：PI_EXPERIMENTAL=true、0、空字符串和未设置都为 false；调用后改变环境会影响下一次结果。
 */
export function areExperimentalFeaturesEnabled(): boolean {
	// === 做严格字符串比较，不把任意非空环境值当作开启；返回类型 boolean 仅是 TS 契约。
	return process.env.PI_EXPERIMENTAL === "1";
}
