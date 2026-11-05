/**
 * Utilities for formatting keybinding hints in the UI.
 */

// 把可配置按键动作转成UI提示文字，供加载器、登录页、工具渲染器等使用；只格式化，不匹配输入或修改键位。type导入的Keybinding/KeyId在编译后擦除。
import { getKeybindings, type Keybinding, type KeyId } from "@earendil-works/pi-tui";
// 提示使用共享theme着色；扩展若加载到另一份包缓存，应使用宿主传入的keyText/keyHint以读取同一套配置。
import { theme } from "../theme/theme.ts";

// 格式化选项接口；声明不自动给外部输入做运行时验证。
export interface KeyTextFormatOptions {
	// 可选布尔值决定每个+分段的首字母大写，不是让整个组合键全大写。
	capitalize?: boolean;
}

// 格式化一个键片段并返回文字，无外部写入；例macOS的alt变option，capitalize=true再变Option。只转换文案，不改变真实键ID。
function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	// 仅darwin且片段忽略大小写等于alt才用option；其他片段保留原拼写，不trim空格。
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	// truthy capitalize时将首字符大写，余下保留；空片段仍空，charAt/slice不会因此抛错。
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

// 按/拆多个候选键、按+拆组合片段，逐片段格式化再原样分隔拼回，返回字符串；例capitalize下ctrl+x/alt+y变Ctrl+X/Alt+Y，macOS用Option。此函数不验证任意输入是否真是合法键ID。
export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	// 链式操作从原字符串开始，不修改调用方变量。
	return (
		key
			// 斜杠表示多个可选键，例如ctrl+x/ctrl+c；不是正则或文件路径解析。
			.split("/")
			// 每个候选组合分别处理。
			.map((k) =>
				// 从当前候选字符串继续链式分段。
				k
					// 加号分开修饰键和普通键，连续分隔符的空段也保留。
					.split("+")
					// 逐片段应用平台名转换/首字母规则。
					.map((part) => formatKeyPart(part, options))
					// 同一组合重新用加号连接。
					.join("+"),
			)
			// 多种候选再用斜杠连接，不添空格。
			.join("/")
	);
}

// 格式化KeyId数组并返回文字，无修改；例[]返回空串，["ctrl+x","ctrl+c"]按/合并后处理。KeyId是类型约束，不在这里执行输入校验。
function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	// 空列表不显示“undefined”或占位键。
	if (keys.length === 0) return "";
	// 先join多个配置键，再复用同一格式化规则。
	return formatKeyText(keys.join("/"), options);
}

// 按动作读当前配置并返回简洁键名，例keyText("app.tools.expand")随用户覆盖变化；读取无写盘/渲染副作用，getKeys错误照常传播。
export function keyText(keybinding: Keybinding): string {
	// 每次调用重新取得共享键位管理器和该动作的KeyId列表，不缓存默认值。
	return formatKeys(getKeybindings().getKeys(keybinding));
}

// 按动作读当前键位并把每片段首字母大写，返回展示字符串；例ctrl+x显示Ctrl+X，不把键配置本身改成大写。
export function keyDisplayText(keybinding: Keybinding): string {
	// 传显式capitalize:true给格式化器，配置读取和keyText一致。
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

// 生成带颜色的“键名+动作说明”，返回ANSI字符串；例ctrl+x to copy。无按键时仍保留前导空格加说明，不自动隐藏整条提示；主题回调异常传播。
export function keyHint(keybinding: Keybinding, description: string): string {
	// 键名用dim，说明含一个前导空格用muted；description原样，不验证/过滤控制字符。
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

// 对给定原始键文字生成提示，不按动作查配置；例rawKeyHint("ctrl+x","to copy")只应用平台格式化和颜色。返回ANSI字符串，无键位修改或终端写入。
export function rawKeyHint(key: string, description: string): string {
	// 与keyHint相同配色，但输入直接交formatKeyText，不能跟随某动作的用户覆盖。
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}
