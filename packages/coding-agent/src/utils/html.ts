// 为语法高亮等文本渲染解码少量HTML实体；不是浏览器HTML解析器，也不负责删除标签或过滤终端控制字符。
// 单个实体的结果：text是解码文字，length是原串中从&到;的UTF-16码元长度，供扫描器跳过已消费部分。
export interface DecodedHtmlEntity {
	// 一个码点可能是两个UTF-16码元，例如某些表情；不要用text.length代替原输入消费长度。
	text: string;
	length: number;
}

// 输入数字码点，范围内返回String.fromCodePoint结果，否则undefined；无I/O。
// 例如65得到A，0x110000失败；这里没有排除代理项或采用浏览器数字引用的替换字符规则。
function decodeCodePoint(codePoint: number): string | undefined {
	// Number.isInteger同时排除NaN、Infinity和小数，再约束Unicode码点数值范围。
	if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
		return undefined;
	}
	// 按码点构造字符串，超过0xffff的合法值会编码成代理对，不会抛越界RangeError。
	return String.fromCodePoint(codePoint);
}

// 输入去掉&和;的实体正文，返回识别出的文字或undefined；只认五个命名实体及十/十六进制数字，无副作用。
// 例如amp→&、#x41→A；parseInt允许有效数字后的其他字符，因此#65xyz也可能得到A，不能当严格实体校验器。
export function decodeHtmlEntity(entity: string): string | undefined {
	// switch按大小写精确匹配；这些case分别立即return，不会穿透下一个分支。
	switch (entity) {
		case "amp":
			return "&";
		case "lt":
			return "<";
		case "gt":
			return ">";
		case "quot":
			return '"';
		case "apos":
			return "'";
	}

	// 数字引用接受小写或大写x；slice(2)去掉#x，16明确指定进制。
	if (entity.startsWith("#x") || entity.startsWith("#X")) {
		return decodeCodePoint(Number.parseInt(entity.slice(2), 16));
	}

	// 其余以#开头的按十进制读；空串/无有效数字产生NaN，再由范围函数拒绝。
	if (entity.startsWith("#")) {
		return decodeCodePoint(Number.parseInt(entity.slice(1), 10));
	}

	// 未覆盖的命名实体不猜测，交调用方保留原文字。
	return undefined;
}

// 输入原串和调用方认为是&的位置，尝试解码直到下一个;，返回文字和消费长度，失败undefined；不自行验证html[index]确实为&。
// 例如在"x&amp;y"的索引1得到{text:"&",length:5}；无分号或分号距起点超过16码元就不尝试，无I/O。
export function decodeHtmlEntityAt(html: string, index: number): DecodedHtmlEntity | undefined {
	// indexOf从起点后一位搜索最近分号，本身可搜索到串尾；找到位置后才检查长度预算。
	const semicolonIndex = html.indexOf(";", index + 1);
	// 此处预算约束的是分号与起点距离，返回的length还要加1包含分号。
	if (semicolonIndex === -1 || semicolonIndex - index > 16) {
		return undefined;
	}

	// 去掉假定的&及末尾;，交单实体函数；仅解码一层，例如&amp;lt;不会递归变成<。
	const entity = html.slice(index + 1, semicolonIndex);
	const decoded = decodeHtmlEntity(entity);
	// 用===undefined区分“未识别”，不靠字符串真值决定是否成功。
	if (decoded === undefined) {
		return undefined;
	}

	// text:decoded显式重命名结果字段，length计算原输入被消费的范围，扫描器据此前进。
	return { text: decoded, length: semicolonIndex - index + 1 };
}
