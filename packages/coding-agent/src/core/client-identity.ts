// 为模型请求提供Pi身份元数据；SDK每次构造请求选项时读取，最终请求头由ai层生成。
// ClientIdentity是类型，PI_ATTRIBUTION是运行时常量；同一import中用type区分。
import { type ClientIdentity, PI_ATTRIBUTION } from "@earendil-works/pi-ai";
// VERSION来自统一配置入口，兼容源码、npm和独立可执行文件的安装方式。
import { VERSION } from "../config.ts";
// 这里只需要设置读取接口，不创建SettingsManager实例。
import type { SettingsManager } from "./settings-manager.ts";
// 统一处理环境变量优先于设置的遥测开关。
import { isInstallTelemetryEnabled } from "./telemetry.ts";

/**
 * How pi's requests identify it to providers: a detailed `User-Agent` with pi's version, and attribution to pi as a
 * CLI agent while install telemetry is enabled.
 */
/**
 * 读取当前开关，返回请求身份对象；不直接发送遥测或HTTP请求。
 * 例：关闭遥测后attribution为null，但userAgent仍为detailed并带版本；关闭归属信息不等于清除所有请求身份。
 * 每次返回新顶层对象，设置读取异常向上传播。
 */
export function getClientIdentity(settingsManager: SettingsManager): ClientIdentity {
	// 返回类型约束对象字段，实际HTTP头的名字/取舍由下游决定。
	return {
		// 字符串字面量选择详细User-Agent策略，不在此拼接平台信息。
		userAgent: "detailed",
		// 属性值使用当前版本常量。
		version: VERSION,
		// 三元表达式：允许遥测时提供Pi归属信息，否则用null明确禁用默认归属。
		attribution: isInstallTelemetryEnabled(settingsManager) ? PI_ATTRIBUTION : null,
	};
}
