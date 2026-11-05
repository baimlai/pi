// 处理已经解码为 JavaScript 字符串的文件正文，只识别开头的 BOM，不清理普通空白或中间字符。
/** Split a leading UTF-8 byte order mark from decoded text. */
/**
 * 分离文件头的 Unicode BOM 字符，返回 {bom,text}，原字符串不被修改。
 * 例如输入 "\uFEFFhello"，结果是 bom="\uFEFF"、text="hello"；输入 "hello" 则 bom 为空。
 * \uFEFF 是源码中的 Unicode 转义写法，运行时代表一个字符；不是六个普通文本字符。
 */
export function splitBom(content: string): { bom: string; text: string } {
	// 三元表达式根据首字符选择对象；slice(1) 跳过一个 BOM，字符串内其他位置保持原样。
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** Remove a leading UTF-8 byte order mark from decoded text. */
/** 去掉已解码文字开头的 BOM，仅取 splitBom 的 text 字段；例如读取 JSON/提示词文件后先调用它，再做解析。 */
export function stripBom(content: string): string {
	// 复用同一条识别规则，不把 trim() 当作 BOM 处理，以免误删正文两端有意义的空白。
	return splitBom(content).text;
}
