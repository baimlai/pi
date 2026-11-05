/**
 * 把工具元信息和JSON Schema转成给模型看的TypeScript声明；coding-agent的codemode说明和工具搜索会用它。
 * 声明是说明书：把输入写成string/对象、返回写成Promise<T>，不会创建函数或替宿主校验参数。
 * 模块无网络/文件IO；递归渲染只支持schema子集，并用引用展开额度和可选文字预算控制输出。
 */
// 共用名称映射，确保展示出来的tools.foo与运行层使用同一种拼写。
import { toCodemodeIdentifier } from "./identifier.ts";

// 从此轻量入口也能导入名称映射，不必为了取它加载worker后端。
export { toCodemodeIdentifier };

// import type仅供TS检查，生成JS时擦除；schema的值仍是unknown，需要按实际字段读取。
import type { CodemodeJsonSchema, CodemodeTool } from "./types.ts";

// 允许ASCII标识符形状；不排除JS保留字，非匹配属性名后面会用JSON字符串加引号。
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// 生成声明每层缩进两空格；这是返回文本的格式，不是源码制表风格。
const INDENT = "  ";
/** Largest rendered input type, in characters, before it becomes `unknown`. */
// 输入类型默认最多16000个UTF-16码元；数字中的_只是方便读。回退unknown本身也有7码元。
export const DEFAULT_INPUT_SCHEMA_MAX_CHARS = 16_000;
/** Local `$ref` expansions per rendered schema, so shared definitions cannot blow up the output. */
// 每次渲染最多展开32次引用，既防递归也防多次共享定义把输出放大；不是最多32层对象。
const MAX_REF_EXPANSIONS = 32;
/** JSON Schema keywords with a number or string value shown as `@keyword value` property tags. */
// 这些约束写成属性注释标签，而非运行时验证器；下面按固定顺序输出。
const TAG_KEYWORDS = [
	// 数值下界（包含端点）。
	"minimum",
	// 数值下界（不含端点）。
	"exclusiveMinimum",
	// 数值上界（包含端点）。
	"maximum",
	// 数值上界（不含端点）。
	"exclusiveMaximum",
	// 数值应为某个数的倍数。
	"multipleOf",
	// 字符串长度下界。
	"minLength",
	// 字符串长度上界。
	"maxLength",
	// 正则模式文本，声明里只展示，不执行正则。
	"pattern",
	// 格式提示，例如date-time；这里也只展示。
	"format",
	// 数组项目数下界。
	"minItems",
	// 数组项目数上界。
	"maxItems",
];
/** Tag keywords whose values all hold at once, so only the largest (lower) or smallest (upper) matters. */
// 同类下界取较大的那个，展示当前已读取的合并约束。
const LOWER_BOUNDS = new Set(["minimum", "exclusiveMinimum", "minLength", "minItems"]);
// 同类上界取较小的那个；不会在此判断上下界是否矛盾。
const UPPER_BOUNDS = new Set(["maximum", "exclusiveMaximum", "maxLength", "maxItems"]);
/** Longest property tag; longer ones (large defaults, long patterns) are left out. */
// 超过80码元的整条标签直接省略，不截一半。
const MAX_TAG_CHARS = 80;
/** Characters that end a `//` comment. */
// g全局匹配四种JS行终止符，避免属性//注释被标签内容提前换行。
const LINE_TERMINATORS = /[\r\n\u2028\u2029]/g;

/** 输入是工具/宿主全局函数的只读视图；只生成介绍文字，不调用它们的execute。 */
export interface RenderDeclarationsOptions {
	// readonly禁止通过这个数组类型增删/重排，未使每个工具对象深只读。
	tools?: readonly CodemodeTool[];
	// 可不传globals，默认不生成额外全局声明。
	globals?: readonly CodemodeTool[];
}

/**
 * Render TypeScript declarations for the script-visible API. Tools become members of
 * `declare const tools`, globals become `declare function` statements, and `ns.member` globals
 * members of `declare const ns`. Descriptions become doc comments; schemas become types.
 */
/**
 * 生成给模型看的TS接口：工具对象→普通全局函数→按命名空间分组的全局函数。
 * 例工具名read、输入{type:"string"}会展示read(args: string): Promise<unknown>。
 * 结果是字符串，declare只是展示“可以怎样调用”，不创建函数，不运行TS检查，也不校验真实参数。
 * 工具顺序保留；命名空间按首次出现分组，普通全局声明先于这些分组。名称合法性/冲突由上层另行处理。
 */
export function renderDeclarations(options: RenderDeclarationsOptions): string {
	// string[]标注每个片段都是文字；最后一次性拼起来。
	const sections: string[] = [];
	// ??给缺失数组默认空数组，空数组本身不会被替换。
	const tools = options.tools ?? [];
	// 没工具就省略整个tools声明块。
	if (tools.length > 0) {
		// map为每个工具生成一条成员声明，不执行工具。
		const members = tools.map(
			// 模板先放文档注释、再放缩进和调用签名；两个helper负责具体文本。
			(tool) => `${docComment(tool.description, INDENT)}${INDENT}${renderToolSignature(tool)}`,
		);
		// join显式换行，生成declare const tools对象；它是模型提示文字中的TS语法。
		sections.push(`declare const tools: {\n${members.join("\n")}\n};`);
	}
	// Map<string,string[]>按命名空间收集成员，并保留第一次插入顺序。
	const namespaces = new Map<string, string[]>();
	// for...of遍历可选globals，没传时跳过。
	for (const global of options.globals ?? []) {
		// 只找第一个点，如models.list拆成models和list；本函数不验证多层点名。
		const dot = global.name.indexOf(".");
		// 无点表示普通全局函数。
		if (dot === -1) {
			// 顶层declare function没有额外缩进；head参数包含函数名。
			sections.push(renderGlobal(`declare function ${global.name}`, global, ""));
			// 已处理普通函数，不再进入命名空间分组。
			continue;
		}
		// slice不改原名，提取点前的组名。
		const namespace = global.name.slice(0, dot);
		// 同组复用原成员数组，新组从[]开始。
		const members = namespaces.get(namespace) ?? [];
		// 第一次遇到组时写Map，后续直接修改已保存的数组。
		if (members.length === 0) namespaces.set(namespace, members);
		// 去掉组名前缀后生成对象成员，如list(args:...):Promise<...>。
		members.push(renderGlobal(global.name.slice(dot + 1), global, INDENT));
	}
	// 解构Map的一对[组名,成员数组]。
	for (const [namespace, members] of namespaces) {
		// 每组生成一个declare const namespace，组内成员按输入顺序。
		sections.push(`declare const ${namespace}: {\n${members.join("\n")}\n};`);
	}
	// 用空行隔开片段；无工具/全局函数时返回空串。
	return sections.join("\n\n");
}

/**
 * One tool as a member of the `tools` object: `name(args: T): Promise<R>;` with the
 * name as the identifier scripts use. Input types longer than `inputMaxChars` render as `unknown`.
 */
/** 生成单个工具成员声明；例my-tool且无schema→my_tool(args: unknown): Promise<unknown>;。只限制输入类型长度，不限制输出类型长度。 */
export function renderToolSignature(
	// Pick<T,K>从CodemodeTool只选这三个字段，因此不要求传真实execute。
	tool: Pick<CodemodeTool, "name" | "inputSchema" | "outputSchema">,
	// ={}令整个options可省略；inputMaxChars?令其字段也可省略。
	options: { inputMaxChars?: number } = {},
): string {
	// 跨行三元选择输入类型；不根据execute函数的TS签名自动推断。
	const input =
		// 只有undefined表示未提供；显式false schema会转换为never。
		tool.inputSchema === undefined
			? // 这里把参数类型写成unknown，调用时仍可传任意值；实现若读取其字段需先收窄，返回类型另由outputSchema决定。
				"unknown"
			: // 字段缺省时用默认16000码元；0会保留并使几乎所有类型回退unknown。
				schemaToType(tool.inputSchema, { maxChars: options.inputMaxChars ?? DEFAULT_INPUT_SCHEMA_MAX_CHARS });
	// 工具名正规化，单参数名固定args，返回统一写Promise<T>，即便宿主实现同步返回。
	return `${toCodemodeIdentifier(tool.name)}(args: ${input}): Promise<${renderToolOutputType(tool.outputSchema)}>;`;
}

/**
 * A tool's sample: the description followed by the tool's declaration. Used for tool
 * listings and `ALL_TOOLS` entries.
 */
/** 生成单工具说明+TS代码围栏；例{name:"foo",description:"bar"}输出说明bar及tools对象的foo成员声明。文字仅展示，不执行；描述缺失仍保留前面的空白分隔。 */
export function renderToolSample(
	// 这个Pick额外带description，仍无需execute。
	tool: Pick<CodemodeTool, "name" | "description" | "inputSchema" | "outputSchema">,
	// 把输入类型预算继续传给renderToolSignature。
	options: { inputMaxChars?: number } = {},
): string {
	// 把成员签名包进tools对象的顶层声明。
	const declaration = `declare const tools: { ${renderToolSignature(tool, options)} };`;
	// ?.避免缺失描述时报错；trim只去描述两端空白，??再把缺失值改空串。
	return `${tool.description?.trim() ?? ""}\n\ncodemode tool declaration:\n\`\`\`ts\n${declaration}\n\`\`\``;
}

/** The type a tool call resolves to: the output schema's type, and `unknown` without a schema. */
/** 返回调用结果的展示类型；例如{type:"string"}→string，undefined→unknown，false→never。这里不设置长度预算，也不校验真实返回值。 */
export function renderToolOutputType(schema: CodemodeJsonSchema | undefined): string {
	// 三元表达式只区分未提供与已提供schema。
	return schema === undefined ? "unknown" : schemaToType(schema);
}

/** 拼全局函数的描述/签名；显式signature优先，例head为declare function pick、signature为(): void。只接字符串，不解析签名合法性。 */
function renderGlobal(head: string, global: CodemodeTool, indent: string): string {
	// 连空字符串signature也算显式提供，不按真假值判断。
	if (global.signature !== undefined) {
		// 直接拼作者提供的签名，绕过schema生成；函数名及签名不会在此重写/校验。
		return `${docComment(global.description, indent)}${indent}${head}${global.signature};`;
	}
	// 没显式signature时才按单参数schema生成；这里没有工具输入的16000默认限制。
	const input = global.inputSchema === undefined ? "unknown" : schemaToType(global.inputSchema);
	// 同样生成Promise的结果类型。
	const output = global.outputSchema === undefined ? "unknown" : schemaToType(global.outputSchema);
	// head可能含declare function，也可能只是命名空间内的成员名。
	return `${docComment(global.description, indent)}${indent}${head}(args: ${input}): Promise<${output}>;`;
}

/** 描述转成JSDoc文本；缺失/空白→空串，多行各加星号，并转义闭合注释标记防止提前结束。仅处理文本，无IO。 */
function docComment(description: string | undefined, indent: string): string {
	// 可选链先取到字符串再trim，undefined仍为undefined。
	const text = description?.trim();
	// 空串或undefined不生成空文档块。
	if (!text) return "";
	// 先转义星号斜杠，再按LF/CRLF拆行；这里不是Markdown渲染。
	const lines = text.replaceAll("*/", "*\\/").split(/\r?\n/);
	// 单行用简短文档块，末尾LF让下一个声明另起行。
	if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
	// 多行map给每行缩进；空行仅写星号，最后join和闭合文档块。
	return `${indent}/**\n${lines.map((line) => `${indent} *${line ? ` ${line}` : ""}`).join("\n")}\n${indent} */\n`;
}

/** 对象属性名可直接写就保留，否则用JSON引号；例max-lines→"max-lines"。只查字符形状，不完整判断JS关键字语境。 */
function propertyKey(name: string): string {
	// JSON.stringify还转义属性名里的引号/换行，防止直接拼入声明。
	return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** 把类型文本去重后用|连接；例[string,string,number]→string | number；含unknown则整体unknown，空集合则never。 */
function union(types: string[]): string {
	// Set按首次出现顺序去重，再用展开语法恢复数组。
	const unique = [...new Set(types)];
	// TS中unknown与其他类型的联合仍是unknown，这里提前简化。
	if (unique.includes("unknown")) return "unknown";
	// 仅做文本去重/连接，不是通用类型化简器；例如never | string不会进一步缩掉never。
	return unique.length === 0 ? "never" : unique.join(" | ");
}

/**
 * Convert a JSON Schema to a TypeScript type expression: objects on one line (`{ a: string; b?: number; }`) with properties sorted by name,
 * or one property per line with `//` comments when a property has a description or constraints the
 * type cannot express (`// @integer @minimum 1 @default 20`); `Array<T>` for arrays. Local references
 * (`#/$defs/...`, `#/definitions/...`) resolve against `schema`; recursive and remote references
 * render as `unknown`. A result longer than `maxChars` is rendered again without the constraint tags,
 * and renders as `unknown` if it is still too long.
 */
/**
 * JSON Schema子集转为可读TS类型文本，供renderDeclarations及工具搜索展示。
 * 例{type:"object",properties:{q:{type:"string"}},required:["q"]}→{ q: string; }。
 * 先带约束标签渲染；超maxChars再去标签；仍超限则unknown。描述不会随标签一起删，unknown也可能长于很小的预算。
 * 不验证实际数据，不保证覆盖全部JSON Schema语义；错误百分号引用、不能JSON序列化的const/default等仍可能抛错。
 */
export function schemaToType(schema: CodemodeJsonSchema, options: { maxChars?: number } = {}): string {
	// 每次render新建引用路径Set和展开计数；第二轮渲染不会沿用第一轮已消耗的计数。
	const render = (tags: boolean) => toType(schema, { root: schema, resolving: new Set(), expansions: 0, tags });
	// tags:true让属性注释带@integer/@minimum等约束提示。
	const type = render(true);
	// 无预算或已经合限就直接返回；length按UTF-16码元计，不是token数。
	if (options.maxChars === undefined || type.length <= options.maxChars) return type;
	// 第二轮仅关闭约束标签；属性描述仍显示。
	const untagged = render(false);
	// 再超限就回退unknown，不对文字硬切一半。
	return untagged.length <= options.maxChars ? untagged : "unknown";
}

/** 同一次递归渲染共享的上下文：原根、当前引用路径、总展开次数与标签开关。 */
interface SchemaContext {
	// 本地$ref相对最外层schema解析，不相对当前子节点。
	root: CodemodeJsonSchema;
	/** References being expanded on the current path, to stop at recursive types. */
	// Set只记当前递归路径，离开引用后删除，因此不同属性仍可重复引用同一目标。
	resolving: Set<string>;
	// 每次成功取到引用目标加1，退出递归不减，是本轮总次数。
	expansions: number;
	/** Whether property comments include constraint tags. */
	// false只省约束标签，不省描述或普通类型。
	tags: boolean;
}

/** 解析#或#/...本地引用，找不到/目标不是schema形状则undefined。例#/$defs/X沿根字段查X；不联网解析外部引用。 */
function resolveRef(ref: string, root: CodemodeJsonSchema): CodemodeJsonSchema | undefined {
	// 仅接受这两种本地前缀，远程URL直接无法解析。
	if (ref !== "#" && !ref.startsWith("#/")) return undefined;
	// 根开始按unknown逐层走，每层验证形状后再取键。
	let current: unknown = root;
	// 分割路径并滤空段；#最终保留根，但空属性名路径段不会被保留，不是完整JSON Pointer实现。
	for (const segment of ref.slice(2).split("/").filter(Boolean)) {
		// 先URL解码，再把~1变斜杠、~0变波浪线；错误百分号编码会抛URIError，未在此吞掉。
		const key = decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
		// schema字段读取边界；in可命中继承键，这里并非严格的自有属性检查。
		if (typeof current !== "object" || current === null || Array.isArray(current) || !(key in current)) {
			// 某一层形状/键不满足，就声明为不可解析引用。
			return undefined;
		}
		// 验过对象后断言键值字典，继续下钻；值仍为unknown。
		current = (current as Record<string, unknown>)[key];
	}
	// 布尔schema也是合法的渲染输入，不能因不是对象就丢弃。
	if (typeof current === "boolean") return current;
	// 最后仅接受非null、非数组对象。
	return typeof current === "object" && current !== null && !Array.isArray(current)
		? // 断言不深度验证schema所有关键字。
			(current as Record<string, unknown>)
		: // 数字/字符串等非schema目标返回undefined。
			undefined;
}

/**
 * 递归调度类型渲染：布尔→引用→const/enum→联合/交叉→type→对象/数组结构推断。
 * 例如integer只展示number，数值范围要靠旁边标签；anyOf/oneOf都展示联合，无法表达oneOf“只能命中一项”。
 * 共享上下文限制引用展开，未支持的关键字通常回退unknown或不显示；不会调用JSON Schema验证器。
 */
function toType(schema: CodemodeJsonSchema, context: SchemaContext): string {
	// true允许任意数据，类型展示unknown。
	if (schema === true) return "unknown";
	// false不允许任何数据，类型展示never。
	if (schema === false) return "never";
	// schema子节点来自unknown字段；不符合对象形状时退unknown。
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return "unknown";
	// $ref优先于兄弟字段，下面不再合并同节点其他约束。
	if (typeof schema.$ref === "string") {
		// 记下确切引用字符串作递归检测键。
		const ref = schema.$ref;
		// 当前路径重复或本轮已展开32次就停止，避免递归和大输出。
		if (context.resolving.has(ref) || context.expansions >= MAX_REF_EXPANSIONS) return "unknown";
		// 相对最外层根解析目标。
		const target = resolveRef(ref, context.root);
		// 外部/缺失/非schema目标都退unknown。
		if (target === undefined) return "unknown";
		// 总展开计数不在finally减少，限制本轮全部引用工作量。
		context.expansions++;
		// 标记进入当前引用路径。
		context.resolving.add(ref);
		// 确保递归返回或抛错都撤销路径标记。
		try {
			// 子节点继续共享根和总次数，保持引用相对位置。
			return toType(target, context);
		} finally {
			// 只删除路径占用，不删除已消耗展开次数。
			context.resolving.delete(ref);
		}
	}

	// const转JSON字面量；in也包含继承字段，undefined序列化会回退unknown。
	if ("const" in schema) return JSON.stringify(schema.const) ?? "unknown";
	// enum逐值变字面量类型后去重；空数组得到never，不在这里确认枚举值符合其他type。
	if (Array.isArray(schema.enum)) return union(schema.enum.map((value) => JSON.stringify(value) ?? "unknown"));

	// anyOf数组优先于oneOf数组，两者都用联合表示。
	const variants = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
	// as仅帮助把unknown分支传下去，运行时形状仍由toType处理；[]也会进入并得到never。
	if (variants) return union(variants.map((variant) => toType(variant as CodemodeJsonSchema, context)));
	// allOf用交叉类型近似“同时满足”。
	if (Array.isArray(schema.allOf)) {
		// 先渲染各个子项。
		const parts = schema.allOf
			// 共用context使不同子项也消耗同一引用展开额度。
			.map((part) => toType(part as CodemodeJsonSchema, context))
			// unknown在交叉中不增加约束，先移除。
			.filter((part) => part !== "unknown");
		// 如果没有剩余约束，整体unknown。
		return parts.length === 0
			? // 空交叉并不在此表示never。
				"unknown"
			: // 联合成员先加括号，保证|与&的优先级；这是文本处理，不解析完整TS类型。
				parts
					.map((part) => (part.includes(" | ") ? `(${part})` : part))
					.join(" & ");
	}

	// 读取type关键字，未知时可能从结构字段推断。
	const type = schema.type;
	// type数组逐项递归，展开复制schema并覆盖type，最后组成联合。
	if (Array.isArray(type)) return union(type.map((entry) => toType({ ...schema, type: entry }, context)));
	// switch按明确类型选择渲染器，不转换实际值。
	switch (type) {
		// 字符串类型不把pattern等规则变成TS子类型。
		case "string":
			// 返回字符串"string"，它是类型文本，不是用户数据。
			return "string";
		// JSON Schema的number与integer都映射TS number。
		case "number":
		// 整数要求只能作为属性标签展示，TS没有独立integer基本类型。
		case "integer":
			// number类型文本本身不检查有限性或范围。
			return "number";
		// 真/假统一布尔类型，const分支可更精确表示单一值。
		case "boolean":
			// 此处返回的是类型名字。
			return "boolean";
		// null是独立字面量类型，不等于undefined。
		case "null":
			// 以字符串形式表达null类型。
			return "null";
		// 数组交给items/prefixItems规则。
		case "array":
			// 同上下文递归数组元素。
			return arrayType(schema, context);
		// 对象交给属性/required/additionalProperties规则。
		case "object":
			// 同上下文递归属性。
			return objectType(schema, context);
		// 缺type时，只从下面列出的结构关键字推断。
		case undefined:
			// 存在任一个对象相关键就优先视为对象。
			if ("properties" in schema || "additionalProperties" in schema || "required" in schema) {
				// 不要求properties真正有效才做这个分支选择。
				return objectType(schema, context);
			}
			// 没对象线索但有items/prefixItems就按数组处理。
			if ("items" in schema || "prefixItems" in schema) return arrayType(schema, context);
			// 例如{}没有更多线索，展示unknown。
			return "unknown";
		// 不认识的显式type不会猜测其业务含义。
		default:
			// 回退宽类型，不在此抛不支持错误。
			return "unknown";
	}
}

/** 渲染元素数组或定长元组；例items:string→Array<string>，prefixItems:[string,number]→[string, number]。本实现非数组items优先，会盖过同节点prefixItems。 */
function arrayType(schema: Record<string, unknown>, context: SchemaContext): string {
	// items存在且不是数组就先走统一元素类型；false会得到Array<never>。
	if (schema.items !== undefined && !Array.isArray(schema.items)) {
		// 递归元素类型再包Array<T>；不表达minItems/maxItems等长度限制。
		return `Array<${toType(schema.items as CodemodeJsonSchema, context)}>`;
	}
	// 走到这里才考虑元组；新写法prefixItems优先于旧式数组items。
	const tuple = Array.isArray(schema.prefixItems)
		? // 取prefixItems数组，包含空数组。
			schema.prefixItems
		: // 没有prefixItems数组则检查旧式items数组。
			Array.isArray(schema.items)
			? // 每个位置可以有自己的schema。
				schema.items
			: // 两种都没有就空元组候选，下面回退unknown[]。
				[];
	// 非空元组逐项转换，不补额外元素/rest，也不完整表达JSON Schema的元组允许范围。
	if (tuple.length > 0) return `[${tuple.map((item) => toType(item as CodemodeJsonSchema, context)).join(", ")}]`;
	// 无元素类型线索的数组，元素保持unknown。
	return "unknown[]";
}

/** 取属性的字符串description并去两端空白；例{description:" hi "}→hi，其余→空串。此处不渲染Markdown或检查整份schema。 */
function descriptionOf(property: unknown): string {
	// 断言只描述可能的字段；可选链防null/undefined，真正的字段类型仍是unknown。
	const description = (property as { description?: unknown } | null | undefined)?.description;
	// 仅接受字符串描述，其他类型不强制String转换。
	return typeof description === "string" ? description.trim() : "";
}

/**
 * Constraints of a property that its TypeScript type cannot express, as JSDoc-style tags:
 * `@integer @minimum 1 @maximum 100 @default 20`. Empty when there are none.
 */
/**
 * 提取属性中TS类型表达不出的约束，变成一行@标签，例integer+minimum:1→@integer @minimum 1。
 * 只在anyOf/oneOf去null后恰有一支时兼读那一支；同时按旧draft布尔exclusive边界转换。
 * 只供提示，不检查数据或约束一致性；过长标签省略，行终止符转义。非JSON的default仍可能在stringify抛错。
 */
function constraintTags(schema: unknown): string {
	// schema来源是unknown边界，非对象/数组/null没有可读属性约束。
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return "";
	// 保持值unknown，之后逐字段确认可展示类别。
	const property = schema as Record<string, unknown>;
	// Optional fields such as Pydantic's `int | None` keep their constraints in the non-null branch.
	// The branch's constraints apply together with the property's, so both are read.
	// 只有anyOf确为数组才优先使用，否则尝试oneOf。
	const variants = Array.isArray(property.anyOf) ? property.anyOf : property.oneOf;
	// nonNull只用于可空单分支的提示提取，不执行oneOf唯一匹配语义。
	const nonNull: unknown[] = Array.isArray(variants)
		? // 去掉type恰为"null"的分支；type数组里含null不会由这个条件排除。
			variants.filter((variant) => (variant as { type?: unknown } | null)?.type !== "null")
		: // 没有分支数组就不做兼读。
			[];
	// 必须恰剩一支；多支不能随意把彼此约束当同时成立。
	const branch = nonNull.length === 1 ? nonNull[0] : undefined;
	// 父属性总是读，单个非null对象分支才附加。
	const branches =
		// 这一步确认可读取字典键的形状。
		typeof branch === "object" && branch !== null && !Array.isArray(branch)
			? // 创建两项数组，不改父属性和分支原对象。
				[property, branch as Record<string, unknown>]
			: // 无适合的单分支就只读父属性。
				[property];
	// Draft-04 and OpenAPI 3.0 make `minimum`/`maximum` exclusive with a boolean `exclusiveMinimum`/`exclusiveMaximum`.
	// 将旧式exclusiveMinimum:true + minimum:N改为便于统一展示的exclusiveMinimum:N。
	const schemas = branches.map(
		// 返回类型标注Record，箭头后({})表示直接返回对象而非函数体。
		(schema): Record<string, unknown> => ({
			// 展开原字段，在新对象上覆盖，不原地修改输入schema。
			...schema,
			// 仅严格true启用旧式转换；minimum置undefined，避免同一边界重复标为含/不含端点。
			...(schema.exclusiveMinimum === true ? { minimum: undefined, exclusiveMinimum: schema.minimum } : {}),
			// 上界做同样转换；false不参与，数值式exclusiveMaximum也原样保留。
			...(schema.exclusiveMaximum === true ? { maximum: undefined, exclusiveMaximum: schema.maximum } : {}),
		}),
	);

	// 累积标签，顺序由下面规则决定。
	const tags: string[] = [];
	// 局部箭头函数识别integer或type数组含integer；只是展示提示条件。
	const isInteger = (type: unknown) => type === "integer" || (Array.isArray(type) && type.includes("integer"));
	// 任一兼读schema为integer就展示一次@integer。
	if (schemas.some((schema) => isInteger(schema.type))) tags.push("@integer");
	// 固定关键字顺序，避免对象输入顺序使展示不稳定。
	for (const keyword of TAG_KEYWORDS) {
		// 从父属性及可选分支取该关键字的值。
		const values = schemas.map((schema) => schema[keyword]);
		// 上下界有合并规则，其他标签按各不同值展示。
		if (LOWER_BOUNDS.has(keyword) || UPPER_BOUNDS.has(keyword)) {
			// 仅筛number；不额外验证有限数，schema通常来自JSON数据。
			const numbers = values.filter((value) => typeof value === "number");
			// 没数值就没有可合并的界限。
			if (numbers.length === 0) continue;
			// 下界取max，上界取min；...把数组展开为函数实参。
			tags.push(`@${keyword} ${LOWER_BOUNDS.has(keyword) ? Math.max(...numbers) : Math.min(...numbers)}`);
			// 已合并的边界不再逐项重复输出。
			continue;
		}
		// Set去掉父属性和分支完全相同的值，保留首次顺序。
		for (const value of new Set(values)) {
			// 只展示数字/字符串关键字，不对其他对象强制转文字。
			if (typeof value === "number" || typeof value === "string") tags.push(`@${keyword} ${value}`);
		}
	}
	// 任一兼读节点要求uniqueItems就提示，未在此去重真实数组。
	if (schemas.some((schema) => schema.uniqueItems === true)) tags.push("@uniqueItems");
	// Annotations, unlike constraints, come from the property itself.
	// default只取父属性，null/undefined不展示，但0/false/空串会保留。
	if (property.default !== undefined && property.default !== null) {
		// stringify用于显示默认值，不代表运行时会替用户自动填入。
		tags.push(`@default ${JSON.stringify(property.default)}`);
	}
	// deprecated仅取父属性严格true，不自动从分支继承。
	if (property.deprecated === true) tags.push("@deprecated");
	// 先过滤、再转义、最后空格连接成一行。
	return (
		tags
			// 长度按转义前码元算；转义后可能超过80，不是最终行长硬上限。
			.filter((tag) => tag.length <= MAX_TAG_CHARS)
			// 每个换行码元变成可见的反斜杠uXXXX文本，防止冲出生成的//注释行。
			.map((tag) =>
				tag.replace(LINE_TERMINATORS, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`),
			)
			// 返回一行标签；无标签则空串。
			.join(" ")
	);
}

/** 渲染对象字段/可选性/字典索引；例required:[q]让q无?。属性按名排序，有描述/标签才切多行；不验证必填键存在或索引签名与具名字段相容性。 */
function objectType(schema: Record<string, unknown>, context: SchemaContext): string {
	// properties是unknown字段，先检查其对象形状。
	const properties =
		// 只接受非null、非数组对象作为属性字典。
		typeof schema.properties === "object" && schema.properties !== null && !Array.isArray(schema.properties)
			? // 断言帮助后续按名字读取，各属性值仍未知。
				(schema.properties as Record<string, unknown>)
			: // 无有效properties就用空字典。
				{};
	// required数组转Set便于查名；不在此校验每项是否字符串。
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	// 自有可枚举键按JS默认字符串序排序，不按本地语言习惯排序。
	const names = Object.keys(properties).sort();
	// 每个具名属性先生成类型行；描述稍后加。
	const members = names.map((name) => {
		// required含此名字则必填，否则TS字段名后加?。
		const optional = required.has(name) ? "" : "?";
		// 属性名必要时加引号，再递归类型，末尾分号分隔成员。
		return `${propertyKey(name)}${optional}: ${toType(properties[name] as CodemodeJsonSchema, context)};`;
	});
	// additionalProperties是额外未列名键的展示规则。
	const additional = schema.additionalProperties;
	// 显式false不加索引；其余已提供值按schema/true处理。
	if (additional !== undefined && additional !== false) {
		// true给任意额外键unknown类型，其他值递归渲染。
		const type = additional === true ? "unknown" : toType(additional as CodemodeJsonSchema, context);
		// 追加TS字符串索引签名；不会验证它和已有具名属性类型是否矛盾。
		members.push(`[key: string]: ${type};`);
		// 未提供额外属性规则且无具名字段时，显示开放字典。
	} else if (additional === undefined && names.length === 0) {
		// 空对象schema不会误展示为完全没有任何字段的约束。
		members.push("[key: string]: unknown;");
	}
	// 无成员才返回{}；TS的{}并不精确等同JSON Schema“只能空对象”，这里只近似展示。
	if (members.length === 0) return "{}";
	// 和names一一对应准备每个属性的注释行数组。
	const comments = names.map((name) => {
		// 取得去首尾空白的描述；非字符串为空。
		const lines = descriptionOf(properties[name])
			// CR/LF/Unicode换行都拆开，保证每行单独加//。
			.split(LINE_TERMINATORS)
			// 每行独立去两端空白。
			.map((line) => line.trim())
			// Boolean作为回调去掉空行，不保留描述中的空白段落。
			.filter(Boolean);
		// context.tags=false的降级渲染省略约束标签，保留描述。
		const tags = context.tags ? constraintTags(properties[name]) : "";
		// 有标签时把它加在描述后，数组展开产生新数组。
		return tags ? [...lines, tags] : lines;
	});
	// 所有属性都无注释就用紧凑单行对象。
	if (!comments.some((comment) => comment.length > 0)) return `{ ${members.join(" ")} }`;

	// 有任一描述/标签就用多行排版。
	const lines = ["{"];
	// index让每份注释找到同位置成员行。
	comments.forEach((comment, index) => {
		// 逐行加缩进和//；文字只是生成声明，不是此源码中的真实注释。
		for (const line of comment) lines.push(`${INDENT}// ${line}`);
		// 子对象本身可多行，给其每个后续LF补本层缩进。
		lines.push(`${INDENT}${members[index].replaceAll("\n", `\n${INDENT}`)}`);
	});
	// 具名字段之后的索引签名单独追加，不需要对应描述。
	for (const member of members.slice(names.length)) lines.push(`${INDENT}${member}`);
	// 生成字符串里的闭合大括号。
	lines.push("}");
	// join换行得到完整类型表达式，不对输出再做TS编译。
	return lines.join("\n");
}
