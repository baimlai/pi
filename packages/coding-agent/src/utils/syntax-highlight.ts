// 把highlight.js产出的span HTML转换成主题格式文字，供终端代码块使用；先注册常见语言，其他语法稍后从本地依赖加载。
// 仅解析本渲染器需要的span/实体，并非通用HTML解析或安全过滤；主题函数决定如何加ANSI等样式，本模块不执行待高亮代码。
import hljs from "highlight.js/lib/core.js";
import bash from "highlight.js/lib/languages/bash.js";
import c from "highlight.js/lib/languages/c.js";
import cpp from "highlight.js/lib/languages/cpp.js";
import csharp from "highlight.js/lib/languages/csharp.js";
import dart from "highlight.js/lib/languages/dart.js";
import go from "highlight.js/lib/languages/go.js";
import groovy from "highlight.js/lib/languages/groovy.js";
import java from "highlight.js/lib/languages/java.js";
import javascript from "highlight.js/lib/languages/javascript.js";
import json from "highlight.js/lib/languages/json.js";
import kotlin from "highlight.js/lib/languages/kotlin.js";
import lua from "highlight.js/lib/languages/lua.js";
import nix from "highlight.js/lib/languages/nix.js";
import perl from "highlight.js/lib/languages/perl.js";
import php from "highlight.js/lib/languages/php.js";
import python from "highlight.js/lib/languages/python.js";
import ruby from "highlight.js/lib/languages/ruby.js";
import rust from "highlight.js/lib/languages/rust.js";
import scala from "highlight.js/lib/languages/scala.js";
import swift from "highlight.js/lib/languages/swift.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import { decodeHtmlEntityAt } from "./html.ts";

// 属性简写把导入的语法函数放进表：python等价于python:python；JSON也在启动集合中，不由后续异步加载才提供。
const eagerLanguages = {
	python,
	java,
	go,
	javascript,
	json,
	cpp,
	typescript,
	php,
	ruby,
	c,
	csharp,
	nix,
	bash,
	rust,
	scala,
	kotlin,
	swift,
	dart,
	groovy,
	perl,
	lua,
};

// 模块求值时注册，Object.entries把表变成[语言名,语法函数]；共享hljs注册表因此发生变化。
for (const [name, language] of Object.entries(eagerLanguages)) {
	hljs.registerLanguage(name, language);
}

// 联合类型表示尚未开始或共享的异步任务；缓存Promise使并发请求不反复调度导入。
let allLanguagesPromise: Promise<void> | undefined;

// 无输入，返回其他本地语言定义加载完成的共享Promise；setImmediate把较重导入推迟到后续事件循环。
// 例如界面已显示后调用，完成可触发重绘；导入拒绝也resolve以保留常用语言，不表示所有语法加载成功，失败后不会自动重试。
export function loadAllHighlightLanguages(): Promise<void> {
	// 只在首次调用创建任务，后续调用返回同一个Promise引用。
	if (!allLanguagesPromise) {
		allLanguagesPromise = new Promise((resolve) => {
			// 本地包导入，不是下载语言文件；包index会在同一core实例上注册全套语言。
			setImmediate(() => {
				// 保留现有动态导入行为；void忽略then返回值，成功/失败回调都结算外层任务。
				void import("highlight.js/lib/index.js").then(
					() => resolve(),
					() => {
						// Eager languages and plaintext fallback remain available.
						// 降级不向调用方抛导入错误，但已经注册的语言也不会回滚。
						resolve();
					},
				);
			});
		});
	}
	// Promise<void>只表示可等待，不携带语言数量或成功标记。
	return allLanguagesPromise;
}

// 格式函数把文字转换成带样式字符串；本渲染器按非空单行调用，类型本身不限制输入有无换行，可用chalk或测试里的[text]包装函数。
export type HighlightFormatter = (text: string) => string;
// Record<string,...>按scope名索引，Partial让每项可缺省；没配置的子scope可沿栈继承，不强制提供完整主题。
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

// ?表示属性可省略，开发期检查字段类型，不会在运行时自动校验宿主传入的对象。
export interface HighlightOptions {
	// 指定语言走highlight；省略时才自动识别，不由languageSubset覆盖显式语言。
	language?: string;
	// 透传给显式语言高亮，控制非法语法匹配处理；不是忽略未知语言名的开关。
	ignoreIllegals?: boolean;
	// 只供自动识别限制候选语言，未提供则由highlight.js使用已注册集合。
	languageSubset?: string[];
	// 供HTML文本转换使用，不是CSS样式对象。
	theme?: HighlightTheme;
}

// 扫描器只认这个精确闭标签，以及开标签中首个hljs-前缀类名。
const SPAN_CLOSE = "</span>";
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

// 输入一个开span标签字符串，返回首个hljs-类名去前缀后的scope，找不到undefined；不读外部状态。
// 例如<span class="language-js hljs-title function_">取title，只认单/双引号class，不解析无引号属性或完整HTML语法。
function getScopeFromSpanTag(tag: string): string | undefined {
	// 两个捕获组分别装双引号/单引号内容；exec可为null，?.安全读取，再用??选择实际捕获。
	const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	const classValue = match?.[1] ?? match?.[2];
	// 缺class或空class都不提供scope，但外层仍会保留一层span栈位置。
	if (!classValue) {
		return undefined;
	}

	// 空白切分多个类名，遇首个匹配立即返回；不会合并多个hljs-类的格式。
	for (const className of classValue.split(/\s+/)) {
		if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
			// slice移除前缀，保留诸如title.function这种scope正文。
			return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
		}
	}

	return undefined;
}

// 输入scope及主题，按完整名→第一个点前缀→第一个横线前缀查格式函数，没找到undefined；只查表不调用函数。
// 例如title.function先查该键再查title；没有层层缩短所有前缀的递归规则，也不在这里应用theme.default。
function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
	// 方括号用运行时字符串选属性，exact由主题类型推导为函数或undefined。
	const exact = theme[scope];
	if (exact) {
		return exact;
	}

	// indexOf=-1代表没有分隔符；有点则只试点前面的第一段。
	const dotIndex = scope.indexOf(".");
	if (dotIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dotIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	// 点前缀未命中后再试横线前缀，例如meta-keyword可回退meta。
	const dashIndex = scope.indexOf("-");
	if (dashIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dashIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	return undefined;
}

// 输入嵌套span的scope栈和主题，从最内层向外找首个已配置函数，最后返回theme.default；无匹配可undefined，无I/O。
// 例如外层string内层subst，主题只配string时内层也继承string；Array<string|undefined>允许无scope的span占位。
function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
	// 从length-1反向走，实现内层优先；不修改原栈。
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		// 没有class或空scope时跳过当前层，继续查父层。
		if (!scope) {
			continue;
		}
		// 该层可以匹配完整/前缀scope，找到即停止，不把父子格式函数叠加执行。
		const formatter = getScopeFormatter(scope, theme);
		if (formatter) {
			return formatter;
		}
	}
	// default本身也是可选函数，调用方会处理没有任何格式的纯文字。
	return theme.default;
}

// 输入HTML和扫描位置，判断是否像本实现接受的span开标签起点；返回布尔，不找>或验证剩余属性。
// 例如<span class=...接受，<spanish拒绝；匹配大小写敏感，后面允许>或指定空白字符。
function isSpanOpenTagStart(html: string, index: number): boolean {
	if (!html.startsWith("<span", index)) {
		return false;
	}
	// 索引越界得到undefined，下面的精确比较自然为false。
	const nextChar = html[index + "<span".length];
	return nextChar === ">" || nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r";
}

// 输入highlight.js风格HTML和可选主题，返回已经去span、解一层实体、应用格式的文字；主题回调可产生副作用/抛错，本函数不catch。
// 例如<span class="hljs-keyword">const</span>配keyword:s=>"["+s+"]"得到[const]；未知HTML标签保留文字，不可当HTML净化器。
// 流程：积累文字→遇span边界按当前栈刷出→入/出栈→解实体→末尾刷出；每条非空行分别调用格式函数，空行保留。
export function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
	// let可反复赋值；output存最终文字，textBuffer只存同一scope区间内的待格式化正文。
	let output = "";
	let textBuffer = "";
	// const不禁止数组push/pop，只禁止把scopes变量重新指向其他数组。
	const scopes: Array<string | undefined> = [];

	// 闭包无参数、无返回值，读取当前栈并消费textBuffer；例如a\nb分别格式化a、b，中间换行不包进ANSI样式。
	const flushText = () => {
		// 空缓冲不调用用户主题函数，避免无内容也产生额外格式字符。
		if (!textBuffer) {
			return;
		}
		const formatter = getActiveFormatter(scopes, theme);
		// 三元表达式决定有格式逐行处理，或无格式原样追加；换行保留，空行不调用formatter。
		output += formatter
			? textBuffer
					.split("\n")
					// 回调返回每行结果，map生成新数组，不改原缓冲字符串。
					.map((line) => (line ? formatter(line) : line))
					.join("\n")
			: textBuffer;
		// 已消费的正文清空，下一段按新的栈状态处理。
		textBuffer = "";
	};

	// index按UTF-16码元扫描，整个输入都在内存中，没有浏览器DOM或递归节点树。
	let index = 0;
	while (index < html.length) {
		// 先认开span，找到首个>即认为标签结束，并非能处理属性引号内>的通用HTML解析。
		if (isSpanOpenTagStart(html, index)) {
			const tagEndIndex = html.indexOf(">", index + 5);
			if (tagEndIndex !== -1) {
				// 在入栈前刷出正文，保证先前文字使用父层格式。
				flushText();
				const tag = html.slice(index, tagEndIndex + 1);
				const scope = getScopeFromSpanTag(tag);
				// 即使scope未识别也入栈，随后闭标签仍能正确弹掉对应占位。
				scopes.push(scope);
				index = tagEndIndex + 1;
				// 跳过整段标签，不把它追加到正文；无>则继续下面的普通字符路径。
				continue;
			}
		}

		// 只认精确</span>，先刷出内层正文再弹栈；多余闭标签也会被消费而不抛错。
		if (html.startsWith(SPAN_CLOSE, index)) {
			flushText();
			if (scopes.length > 0) {
				scopes.pop();
			}
			index += SPAN_CLOSE.length;
			continue;
		}

		// 只有&位置尝试实体解码；解出来的<等直接进正文，不回头当新标签解析。
		if (html[index] === "&") {
			const decoded = decodeHtmlEntityAt(html, index);
			if (decoded) {
				textBuffer += decoded.text;
				// 按原实体长度跳过，不按解码后的字符长度前进。
				index += decoded.length;
				continue;
			}
		}

		// 普通字符、未知实体、残缺标签都逐码元保留原文。
		textBuffer += html[index];
		index++;
	}

	// 即使末尾span未闭合，剩余正文也按当前栈刷出。
	flushText();
	return output;
}

// 输入源代码和可选选项，先由highlight.js生成HTML，再转换成主题文字返回；不执行代码，不自行catch依赖或主题回调异常。
// 例如language:"typescript"走指定语法，省略language走自动候选；界面的highlightCode会先校验语言并自行兜底为普通文字。
export function highlight(code: string, options: HighlightOptions = {}): string {
	// 只有language真值才走指定语法；ignoreIllegals仅在该分支透传，自动识别只接languageSubset。
	const html = options.language
		? hljs.highlight(code, {
				language: options.language,
				ignoreIllegals: options.ignoreIllegals,
			}).value
		: hljs.highlightAuto(code, options.languageSubset).value;
	// .value是带span和转义实体的字符串，theme未给时render函数默认空表。
	return renderHighlightedHtml(html, options.theme);
}

// 输入语言名/别名，返回当前注册表能否识别；例如ts可由TypeScript的别名表命中，不会因此下载或加载其他语言。
export function supportsLanguage(name: string): boolean {
	// 依赖内部把名字转小写并查正式名/别名；这里不遍历语言集合。
	return hljs.getLanguage(name) !== undefined;
}

/**
 * Number of registered grammars. It grows when the deferred grammars load, which can change the highlighting of
 * code that embeds another language, such as HTML in a JavaScript template literal.
 */
// 无输入，返回当前正式注册语法数量，供CodeHighlighter判断缓存是否需刷新；只计注册名，不把别名另算一门语言。
// 例如延迟加载前后数量变化会触发重算；数量相同并不保证语法实现或配置从未变化，这不是内容指纹。
export function getHighlightLanguageCount(): number {
	return hljs.listLanguages().length;
}
