/**
 * 把任意工具名称映射为脚本可用的ASCII标识符形状，声明生成与VM工具暴露共用此规则。
 * 只替换字符，不做唯一性/保留字验证；a-b和a_b都可变成a_b，冲突处理要看使用它的上层。
 */
/**
 * The identifier a script uses for a tool: characters that are not valid in a JavaScript
 * identifier become `_`. `mcp__docs__search` stays as is, `my-tool` becomes `my_tool`.
 */
/** 例my-tool→my_tool、9x→_x、空名→_。逐码点遍历，首字符不允许数字；不做Unicode规范化，也不转义JS保留字。 */
export function toCodemodeIdentifier(name: string): string {
	// 从空字符串累计结果，当前结果是否为空决定首字符规则。
	let identifier = "";
	// for...of遍历字符串的Unicode码点，不是逐UTF-16码元；一个非BMP表情会替换成一个_。
	for (const char of name) {
		// 三元表达式选择首位/后续规则；^和$要求整枚码点恰好为一个允许的ASCII字符。
		const valid = identifier === "" ? /^[A-Za-z_$]$/.test(char) : /^[A-Za-z0-9_$]$/.test(char);
		// +=追加允许的原字符或_；不会像删除字符那样把后续字符向首位提升。
		identifier += valid ? char : "_";
	}
	// 空名称至少给一个_；非空结果原样返回，唯一性不由本函数保证。
	return identifier === "" ? "_" : identifier;
}
