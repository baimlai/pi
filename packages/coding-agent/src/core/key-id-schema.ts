// 把TUI的按键字面量/常量转换为JSON Schema字符串规则；按键配置读入时据此检查，不识别终端原始转义字节。
import { Key, type KeyId } from "@earendil-works/pi-tui";
import { type TSchemaOptions, Type } from "typebox";

// as const保留四种修饰键的具体字面量，后面生成正则；顺序不是用户按下物理键的时序要求。
const modifiers = ["ctrl", "shift", "alt", "super"] as const;
// 基键允许单个小写字母/数字，或Key对象中的字符串值；(?:...)分组但不生成捕获编号。
const baseKeyPattern = `(?:[a-z0-9]|${Object.values(Key)
	// Key也有ctrl("x")等函数，typeof只在这个混合值集合边界保留字符串；正则特殊字符先转义为字面匹配。
	.flatMap((value) => (typeof value === "string" ? [value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")] : []))
	// 用或连接所有特定键名/符号，拼入同一正则，不会在这里真的监听这些按键。
	.join("|")})`;
// 每种修饰键生成“同名+...同名+”的重复片段，再用|组合；例如ctrl+shift+ctrl+x会命中重复ctrl。
const duplicateModifierPattern = modifiers.map((modifier) => `${modifier}\\+.*${modifier}\\+`).join("|");

// Unsafe<KeyId>把TS静态类型关联到字符串规则，不在构造时校验某个用户值；真正检查由Compile(...).Check执行。
export const KeyIdSchema = Type.Unsafe<KeyId>(
	Type.String({
		// ^/$作为首尾锚点，负向前瞻排除重复修饰键；{0,4}允许零到四个修饰前缀，每个后带字面+，再接一个基键。
		// 该模式没有m标志，^/$锚定整个输入；如ctrl+x后再带LF不能通过，不在这里trim用户文字。
		pattern: `^(?!.*(?:${duplicateModifierPattern}))(?:(?:${modifiers.join("|")})\\+){0,4}${baseKeyPattern}$`,
		// 英语description给编辑器展示，不参与正则检查，也不会把Ctrl自动转成ctrl。
		description: "Key identifier with optional ctrl, shift, alt, or super modifiers.",
	}),
);

// 输入可选schema元信息，返回“单个按键或按键数组”的新schema，无I/O、不校验实际值。
// 例如"ctrl+x"、["ctrl+x","alt+x"]和[]都允许；数组没有minItems或uniqueItems约束，空数组可用于清空默认绑定。
export function keybindingValueSchema(options?: TSchemaOptions) {
	// Type.Union生成anyOf；数组分支要求每项符合相同KeyIdSchema，不把"ctrl+x alt+x"按空格拆成两项。
	return Type.Union([KeyIdSchema, Type.Array(KeyIdSchema)], options);
}

// 无附加选项的共用值schema；例如KeybindingsManager预编译它后逐项过滤用户配置。
export const KeybindingValueSchema = keybindingValueSchema();
