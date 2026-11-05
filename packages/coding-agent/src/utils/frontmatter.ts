// 从技能/提示词 Markdown 中分离 YAML 头；只处理内存文字，不读文件，也不验证业务字段或执行内容。
import { parse } from "yaml";
import { stripBom } from "./text.ts";

// 泛型T要求在类型上是字符串键字典；解析结果用T描述，但外部YAML仍可能实际是数字、数组等其他值。
type ParsedFrontmatter<T extends Record<string, unknown>> = {
	// YAML头部的解析结果；这里的T是开发期约定，不是运行时schema检查。
	frontmatter: T;
	// 去头后的正文；找到成对标记时trim，无头时保留规范换行后的空白。
	body: string;
};

// 统一换行，输入任意文字，返回新串，无副作用；例如CRLF和单独CR都变成LF，g表示替换全部匹配。
const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

// 分离原始头部文字与正文，输入Markdown，返回yamlString或null及body，不解析YAML。
// 先去开头BOM、统一换行，再检查开头---和下一个换行后---；例如普通正文没有结束标记就原样作为body。
// 这里仅做前缀/子串匹配，不要求标记独占整行；确实识别到头部时正文两端空白会被trim。
const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
	// 函数组合从里到外执行，stripBom只移除第一个开头BOM，不清理普通空格。
	const normalized = normalizeNewlines(stripBom(content));

	// 开头必须立即是三个横线，前面有空白则不识别为头部。
	if (!normalized.startsWith("---")) {
		// null明确表示没有识别出头部，正文不做trim。
		return { yamlString: null, body: normalized };
	}

	// 从开头三个横线之后找首个换行+三个横线，-1表示没找到。
	const endIndex = normalized.indexOf("\n---", 3);
	// 无结束标记时不丢掉疑似头部，整份内容仍当正文。
	if (endIndex === -1) {
		return { yamlString: null, body: normalized };
	}

	return {
		// slice起点4假设开头是---加换行，终点不包含结束标记前的换行。
		yamlString: normalized.slice(4, endIndex),
		// 跳过结束标记的换行和三个横线，再去掉正文两端空白。
		body: normalized.slice(endIndex + 4).trim(),
	};
};

// 解析头部并返回正文，输入Markdown和可选类型参数T；没有有效头部文字时给空对象，不做文件I/O。
// 例如parseFrontmatter<{name:string}>(文档)让编辑器知道name类型，但as T不会核验name真是字符串。
// YAML语法错误直接抛给调用方；parse也允许标量/数组，业务加载器仍要检查实际字段，不能把泛型当验证器。
export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	// extends是泛型约束，等号后的Record是调用方不指定T时的默认类型。
	content: string,
): ParsedFrontmatter<T> => {
	// 对象解构取出拆分结果；body已经按是否存在头部采用不同空白规则。
	const { yamlString, body } = extractFrontmatter(content);
	// null或空串均视作没有可解析头部，避免把空结果传给YAML解析器。
	if (!yamlString) {
		// as只改变静态类型，空对象没有被填入T要求的业务字段；body是属性简写。
		return { frontmatter: {} as T, body };
	}
	// 第三方yaml.parse负责真正语法解析，未捕获的解析错误会向上抛出。
	const parsed = parse(yamlString);
	// 注释-only或YAML null解析为nullish时回退空对象；其他值直接断言为T，未进行形状校验。
	return { frontmatter: (parsed ?? {}) as T, body };
};

// 只取正文，输入Markdown返回字符串，无I/O；例如技能显式调用时删掉元信息再作为说明使用。
// 它复用完整解析，所以无效YAML仍会抛错；不是遇到横线就盲目删文字的容错函数。
export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;
