// 用可选原生模块查询此刻修饰键是否按下；terminal.ts 用它补认部分终端未编码的 Shift+Enter。
// type 只引入编译期键名；getNativePlatformHelper 才是实际运行的函数。
import { getNativePlatformHelper, type ModifierKey } from "./native-platform.ts";

// 重新导出允许键名的类型，不创建新的运行时值。
export type { ModifierKey } from "./native-platform.ts";

// 查询当前系统键状态，返回 boolean；例：传 "shift" 检查 Shift。
// 先取 helper，再调用可选能力；缺模块/能力/调用失败都返回 false，无法区分“不支持”和“已松开”。
// 首次获取可同步加载 .node；查询时刻可能晚于输入事件发生时刻，不是历史按键状态。
export function isNativeModifierPressed(key: ModifierKey): boolean {
	// 取 macOS/Windows helper；Linux 不通过这个入口提供键状态。
	const helper = getNativePlatformHelper();
	// 可选链避开 undefined；方法缺失就 false，不用 shell 补查。
	if (!helper?.isModifierPressed) return false;
	// 只捕获下面方法调用的异常，helper 的获取在 try 之前。
	try {
		// 只有严格等于 true 才算按下，不把其他真值当 true。
		return helper.isModifierPressed(key) === true;
		// 原生查询抛错也按不可用处理，不让输入分发因此中断。
	} catch {
		// 返回保守的 false，而非抛出原生异常。
		return false;
	}
}
