// 为 settings/models 等本地配置读取整理 JSON 文本；保留字符串内容，结果再交给调用方的 JSON.parse。
/** Strip `//` line comments and trailing commas from JSON, leaving string literals untouched. */
/** 允许配置含 // 行注释和尾逗号；例：{"a":1,} 变 {"a":1}，"https://x" 内的 // 保留。不支持全部 JSON5 语法。 */
export function stripJsonComments(input: string): string {
	// replace 返回新字符串，不修改 input；下面两次转换从左到右依次执行。
	return (
		input
			// 正则优先匹配完整 JSON 字符串（含反斜线转义），或匹配 // 到行末；m 以双引号开头就原样保留，否则删除注释。
			.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
			// 再匹配字符串或“逗号+空白+闭括号”；tail 是捕获的空白/闭括号，有它就只去逗号，否则保留完整字符串。
			.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""))
	);
}
