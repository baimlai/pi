// 从真实按键动作定义生成keybindings.json的schema；已知动作有描述，未知扩展动作也允许，但值都需符合按键格式。
// 构造schema只创建规则对象，不读用户文件或绑定键盘；生成器发布JSON，运行时KeybindingsManager另用值schema过滤输入。
import { type TSchema, Type } from "typebox";
import { KeybindingValueSchema, keybindingValueSchema } from "./key-id-schema.ts";
import { KEYBINDINGS } from "./keybindings.ts";

// 重导出同一共享值规则，生成器可把它收进$defs，不在这里维护另一套按键语法。
export { KeybindingValueSchema } from "./key-id-schema.ts";

// Record<string,TSchema>表示动作名到schema对象的字典；它不是用户实际的按键配置。
const properties: Record<string, TSchema> = {
	// $schema只需是可选字符串，用于编辑器关联，不把URL限制为键名或检查在线可访问性。
	$schema: Type.Optional(Type.String()),
};

// 模块导入时枚举内置TUI及应用动作，解构动作id和定义；不会把defaultKeys自动写进用户配置。
for (const [id, definition] of Object.entries(KEYBINDINGS)) {
	// 按计算属性名添加每个可选动作，用户不配置时由按键管理器继承默认。
	properties[id] = Type.Optional(
		// 单字符串或字符串数组共用同一按键值规则。
		keybindingValueSchema({
			// 描述从动作定义取，避免schema和界面文案各写一套。
			description: definition.description,
		}),
	);
}

// 导出整个对象schema，例如{"app.session.new":"ctrl+n","extension.action":["alt+x"]}可通过值语法检查。
export const KeybindingsSchema = Type.Object(properties, {
	// 未知键也允许，供扩展定义新动作；不是additionalProperties:true放行任意值，而是仍限制为合法按键/数组。
	additionalProperties: KeybindingValueSchema,
});
