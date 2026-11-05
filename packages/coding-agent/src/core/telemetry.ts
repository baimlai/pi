// 计算安装遥测开关，供请求身份等调用方读取；本文件自己不收集/发送事件。
// import type仅参与编译期检查，不加载设置管理器来构造实例。
import type { SettingsManager } from "./settings-manager.ts";

/** 把环境文字解释为开关；例：YES/true/1为true，空串、带空格的" true "和其他值为false，不自动trim。无副作用。 */
function isTruthyEnvFlag(value: string | undefined): boolean {
	// 缺省或空串先返回false，后面才安全调用字符串方法。
	if (!value) return false;
	// ||短路：1精确匹配，true/yes忽略大小写；不是任意非空字符串都开启。
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/**
 * 有PI_TELEMETRY环境值就按其文字判断，否则读取设置；返回boolean，不写设置。
 * 例：环境空串也算显式覆盖，会关闭；传undefined会触发默认参数，仍读取当前进程环境。
 */
export function isInstallTelemetryEnabled(
	// 调用方传已有设置管理器，函数不访问其他设置字段。
	settingsManager: SettingsManager,
	// 默认值在每次调用时计算；string|undefined允许环境变量不存在。
	telemetryEnv: string | undefined = process.env.PI_TELEMETRY,
): boolean {
	// !==undefined保留显式空串/0文字的覆盖，不能替换成简单truthy回退。
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}
