// 对相同弃用警告文字做进程内去重；导入本模块不打印，实际调用warnDeprecation才写console.warn。
import chalk from "chalk";

// Set<string>保存已经尝试发出的完整文字，大小写/空白都参与精确相等；无持久化，也无容量上限。
const emittedDeprecationWarnings = new Set<string>();

// 输入警告文字，首次记录后以黄色前缀写stderr渠道，之后相同文字直接返回，无返回值。
// 例如连续两次传"use new API"只打印一次；不同文字各打印，console.warn若抛错会向上传播且该文字仍已记为发出。
export function warnDeprecation(message: string): void {
	// 已有则提前结束，不再次构造颜色字符串/输出；去重范围是此模块实例的生命周期。
	if (emittedDeprecationWarnings.has(message)) return;
	// 先记状态再输出，所以重入相同警告也不会无限重复。
	emittedDeprecationWarnings.add(message);
	// chalk是否实际加入ANSI由其颜色能力配置决定；console.warn通常写stderr，不是抛弃用异常。
	console.warn(chalk.yellow(`Deprecation warning: ${message}`));
}

/** Clear deprecation warning state. Exported for tests. */
// 无输入，清掉模块去重集合且不打印；例如测试间调用后同一句警告又能输出，不会删除已经写出的日志。
export function clearDeprecationWarningsForTests(): void {
	emittedDeprecationWarnings.clear();
}
