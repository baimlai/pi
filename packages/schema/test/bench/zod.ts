// 为比较基准构建Zod原生规则：固定9案例按名手写，corpus只适配限定子集，规范套件才走fromJSONSchema；布尔裁决比较不等于所有输入/解析输出完全等价。
// Zod in the comparison. Zod is not a JSON Schema validator: the speed cases are written here as the native Zod
// schemas a developer would write (z.strictObject for closed objects, z.discriminatedUnion for tagged unions, z.lazy
// for recursion), and the corpus schemas are built into the same native calls by `nativeZod`. Only the conformance run
// goes through z.fromJSONSchema, Zod's (semi-experimental) JSON Schema import.

// 命名空间导入Zod运行时工厂和类型；下面调用创建schema，不立即验证基准样本。
import * as z from "zod";
// JsonSchema只作TS类型，编译到JS后此导入擦除。
import type { JsonSchema } from "../../src/index.ts";
// 导入固定案例数据，用schema对象身份与原生规则配对，不导入计时/外部候选验证器。
import { cases } from "./cases.ts";

// UUID只做小写十六进制分段外形校验，无版本/变体断言；此正则无g/m，$不忽略最后LF。
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 以kind值定位text/image/code分支；不是依次把每个样本转成三种对象，不添加转换。
const block = z.discriminatedUnion("kind", [
	// text分支封闭，需字面量kind和字符串text；strictObject会对额外键报错。
	z.strictObject({ kind: z.literal("text"), text: z.string() }),
	// image分支也是封闭对象，下面alt可省。
	z.strictObject({
		// 标签必须是image。
		kind: z.literal("image"),
		// src只要求string，不取图片/请求URL。
		src: z.string(),
		// width要求非负安全整数；Zod .int()还限制Number安全整数范围，不是所有JSON Schema integer的无条件等价。
		width: z.number().int().min(0),
		// height也用相同整数/最小值约束。
		height: z.number().int().min(0),
		// alt.optional()接受省略或undefined；提供其他值时按字符串验证。
		alt: z.string().optional(),
	}),
	// code标签固定，语言枚举ts/js/py，source只当文字，不执行源码。
	z.strictObject({ kind: z.literal("code"), lang: z.enum(["ts", "js", "py"]), source: z.string() }),
]);

// 共享非负安全整数id规则，后面多个字段复用同一实例。
const id = z.number().int().min(0);

// range封闭且start/end各至少1；没有start<=end约束。
const range = z.strictObject({ start: z.number().int().min(1), end: z.number().int().min(1) });
// replace要求两个字符串，不要求非空或检查原文件内容。
const replace = z.strictObject({ oldText: z.string(), newText: z.string() });
// lineEdit复用range并要求text，两个字段都不可省。
const lineEdit = z.strictObject({ range, text: z.string() });

// 富文本封闭对象，用于页面递归块。
const richText = z.strictObject({
	// type允许text或mention。
	type: z.enum(["text", "mention"]),
	// Zod字符串max按JS长度规则约束，当前基准文字为ASCII；不要把与JSON Schema码点长度视为全范围相同。
	content: z.string().max(2000),
	// annotations本身可省，但提供时bold/italic/color在这版全部必填；cases.ts的JSON版本三个子字段可选，当前固定样本全提供，不能据此宣称规则完全等价。
	annotations: z.strictObject({ bold: z.boolean(), italic: z.boolean(), color: z.string() }).optional(),
});

// 递归块的TS静态形状，配合z.lazy打破构造时自引用；声明本身不产生运行时校验。
type PageBlock = {
	// 字符串字面量联合只允许五种标签，区别一般string。
	type: "paragraph" | "heading_1" | "heading_2" | "bulleted_list_item" | "to_do";
	// typeof取得richText静态类型，z.infer取其解析输出类型，再[]表示数组；不在此调用解析器。
	rich_text: z.infer<typeof richText>[];
	// ?让checked静态可选，存在时为boolean。
	checked?: boolean;
	// children可选且元素回到PageBlock，类型递归没有设置最大层数。
	children?: PageBlock[];
};

// z.lazy保存零参工厂，后续需要内部规则时再解析并缓存，避免初始化pageBlock时立刻读取自己。ZodType<PageBlock>是静态输出约束；例children可继续套同类块，构造不遍历用户数据、无I/O。
const pageBlock: z.ZodType<PageBlock> = z.lazy(() =>
	// 延迟工厂返回封闭块schema，额外键会被拒绝。
	z.strictObject({
		// 运行时枚举与上面的TS标签联合分别起作用，不由type声明自动生成。
		type: z.enum(["paragraph", "heading_1", "heading_2", "bulleted_list_item", "to_do"]),
		// rich_text每项使用共享richText规则。
		rich_text: z.array(richText),
		// checked可省，不按type标签限制哪些块才准带它。
		checked: z.boolean().optional(),
		// children元素延迟回到pageBlock；可省，数组本身没有数量上界。
		children: z.array(pageBlock).optional(),
	}),
);

/** The speed cases as native Zod schemas, by case name (the JSON Schema cases in cases.ts, one for one). */
// 按案例名存手写Zod规则；Record是字符串键字典，不保证任意名字真存在，后面显式检查。
const native: Record<string, z.ZodType> = {
	// 小封闭对象只接受text字符串。
	"small closed object": z.strictObject({ text: z.string() }),
	// 文档案例用封闭根结构，与cases.ts同名定位。
	"nested object with tagged unions": z.strictObject({
		// id用上面UUID外形正则。
		id: z.string().regex(uuid),
		// 标题长度1到200，不做trim或转换；当前样本ASCII避开跨实现字符计数差异。
		title: z.string().min(1).max(200),
		// 字符串tag数组最多16项。
		tags: z.array(z.string()).max(16),
		// 作者封闭、name必填、email可省，未做邮箱格式校验。
		author: z.strictObject({ name: z.string(), email: z.string().optional() }),
		// blocks数组每项按kind分支。
		blocks: z.array(block),
		// score可省，存在时0到1数值。
		score: z.number().min(0).max(1).optional(),
		// draft可省，提供时必须boolean。
		draft: z.boolean().optional(),
	}),
	// 五支消息通过kind定位；名字是固定基准名，不是动态从JSON Schema编译来的通用联合。
	"message union of 5": z.discriminatedUnion("kind", [
		// hello分支封闭对象。
		z.strictObject({
			// 标签固定hello。
			kind: z.literal("hello"),
			// protocol非负安全整数，未固定真实协议号。
			protocol: z.number().int().min(0),
			// incarnation验证UUID外形。
			incarnation: z.string().regex(uuid),
			// calls至少1的安全整数。
			calls: z.number().int().min(1),
		}),
		// hold分支封闭，下面chain可选。
		z.strictObject({
			// 标签固定hold。
			kind: z.literal("hold"),
			// 复用非负安全整数hold规则。
			hold: id,
			// 业务type字段为string，非Zod内部schema类型。
			type: z.string(),
			// 版本至少1的安全整数。
			version: z.number().int().min(1),
			// 指纹仅限制16个小写十六进制字符。
			fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
			// params接受任意unknown，包括undefined；不据这行保证与JSON required字段所有缺省场景等价。
			params: z.unknown(),
			// 地址封闭且kind为string，params用unknown，亦不校验具体参数形状。
			address: z.strictObject({ kind: z.string(), params: z.unknown() }),
			// chain最多64个UUID外形字符串且可省。
			chain: z.array(z.string().regex(uuid)).max(64).optional(),
		}),
		// release只接受kind/hold，不执行释放动作。
		z.strictObject({ kind: z.literal("release"), hold: id }),
		// call带三种id，args可选且值不限。
		z.strictObject({ kind: z.literal("call"), call: id, hold: id, method: id, args: z.unknown().optional() }),
		// abort支只有标签和call，不在这里取消任何请求。
		z.strictObject({ kind: z.literal("abort"), call: id }),
	]),
	// read用z.object：声明字段验证后，解析输出默认剥额外键；JSON开放对象则允许保留。这一比较只取safeParse.success，不比较解析后的数据。
	"tool: read": z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
	// edit要求路径和编辑数组，每项oldText/newText必填；默认z.object的未知键输出策略同样是strip，数组可空。
	"tool: edit": z.object({ path: z.string(), edits: z.array(z.object({ oldText: z.string(), newText: z.string() })) }),
	// bash要求字符串command、可选数值timeout，不启动shell。
	"tool: bash": z.object({ command: z.string(), timeout: z.number().optional() }),
	// issue原生规则独立手写，下面pattern/enum/nullable对应固定样本约束。
	"MCP create_issue (pattern, anyOf, enum)": z.strictObject({
		// owner使用多行链式构造；z是命名空间，真正调用从下一行string开始。
		owner: z
			// 以字符串规则为链起点。
			.string()
			// owner非空，不先trim。
			.min(1)
			// 只允许字母数字连字符；owner中空格反例会失败。
			.regex(/^[A-Za-z0-9-]+$/),
		// repo也用多行字符串约束链。
		repo: z
			// repo先要求string。
			.string()
			// repo非空。
			.min(1)
			// repo字符集合多了点/下划线，不查询真实仓库。
			.regex(/^[A-Za-z0-9._-]+$/),
		// 标题必填且至少1字符。
		title: z.string().min(1),
		// body可选字符串。
		body: z.string().optional(),
		// labels可选字符串数组。
		labels: z.array(z.string()).optional(),
		// assignees可选字符串数组，不检查真实账号。
		assignees: z.array(z.string()).optional(),
		// nullable额外接null，optional再额外接undefined/省略，number本身不转文字。
		milestone: z.number().nullable().optional(),
		// state可省，存在时为open/closed。
		state: z.enum(["open", "closed"]).optional(),
	}),
	// 文件编辑原生规则复用上面的replace/lineEdit实例，不走$ref解析。
	"MCP edit_file ($ref, anyOf)": z.strictObject({
		// 正则允许可选路径前缀及至少一个非NUL字符，不证明规范绝对路径、文件存在或权限。
		path: z.string().regex(/^(\/|\.\/|[A-Za-z]:\\)?[^\u0000]+$/),
		// 数组至少1项，union接受任一编辑形状；不是把修改应用到文件。
		edits: z.array(z.union([replace, lineEdit])).min(1),
		// dryRun可省，存在时boolean。
		dryRun: z.boolean().optional(),
	}),
	// 递归页面规则手写；下面parent用union，只有当前封闭互斥形状才与原oneOf的样本裁决一致，不是一般oneOf实现。
	"MCP create_page (recursive $ref, oneOf)": z.strictObject({
		// parent接受两个候选封闭对象之一。
		parent: z.union([
			// page_id支，只含一个UUID外形字段。
			z.strictObject({ page_id: z.string().regex(uuid) }),
			// database_id支同样封闭，因此同时带两个id会被两支拒绝。
			z.strictObject({ database_id: z.string().regex(uuid) }),
		]),
		// 页面标题必填非空。
		title: z.string().min(1),
		// due多行链不改变构造顺序，最后optional包住整个字符串约束。
		due: z
			// 先要求string。
			.string()
			// 只检查日期文字外形，不检查月份天数。
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			// due可以省略或undefined。
			.optional(),
		// 根children数组最多100项且可省，递归块内部数组没有这个上限。
		children: z.array(pageBlock).max(100).optional(),
	}),
};

/** The native Zod schema of each speed case's JSON Schema. */
// 建JSON schema对象→Zod实例的身份Map，ReadonlyMap只限制TS调用，不冻结Map。导入时完成，缺配对会抛；不检查正反样本、不执行计时。
export const nativeCases: ReadonlyMap<JsonSchema, z.ZodType> = new Map(
	// map回调输入每个Case，返回一对键值；例read案例把其原schema引用映到原生read规则，无外部I/O。
	cases.map((c) => {
		// 按精确c.name查字典，不按schema内容自动合成。
		const schema = native[c.name];
		// 若少一份原生规则就在模块导入时抛，避免基准静默漏案例。
		if (schema === undefined) throw new Error(`No native Zod schema for the case ${c.name}`);
		// JSON对象引用作Map键，结构相同但另造的对象不会命中此键。
		return [c.schema, schema];
	}),
);

// 本地Json只是unknown值字典，不承诺任意输入已验证或可JSON序列化。
type Json = Record<string, unknown>;

/**
 * The native Zod schema a developer would write for a corpus schema (corpus.ts): objects (closed ones strict),
 * strings with bounds, patterns and enums, bounded integers, numbers, booleans, string arrays, descriptions, and
 * $defs reused through their constant. Throws for any other shape.
 */
// nativeZod接本文件corpus子集规则和默认根规则，返回新Zod构造结果；例对象里的#/$defs/X递归构建X。不主动发I/O，不修改输入schema，但describe会登记Zod元数据；依赖内部生成形状，不是通用JSON Schema验证器/完整转换器，也不保证规则任意输入语义完全相同。
export function nativeZod(schema: Json, root: Json = schema): z.ZodType {
	// $ref是unknown字段，只有字符串才走简易定义分支，不先验证它是正确本地Pointer。
	if (typeof schema.$ref === "string") {
		// replace只移除第一个匹配文字片段，不是URI解析/Pointer解码，也不检查前缀位置；依赖corpus生成的简单定义名。
		const name = schema.$ref.replace("#/$defs/", "");
		// 直接索引root.$defs并递归构造，每次重建而非缓存；as不补表或检查循环。这个return会忽略引用节点自己的description及其他兄弟约束，缺目标/自循环可能抛错或递归不止。
		return nativeZod((root.$defs as Record<string, Json>)[name], root);
	}
	// 非引用节点交nativeType按限定type分派，root始终传同一根用于后代查定义。
	const built = nativeType(schema, root);
	// description为string才调用describe返回实例并登记Zod元数据；描述不成为验证约束，也不转换用户值，元数据写入不等于修改输入schema。
	return typeof schema.description === "string" ? built.describe(schema.description) : built;
}

// nativeType把corpus当前会生成的object/string/integer/number/boolean/string-array造为Zod。例未知type:null走default抛；它依赖已知生成器，部分关键字会忽略而非全面拒绝所有未知形状，无I/O/输入修改。
function nativeType(schema: Json, root: Json): z.ZodType {
	// switch按schema.type的运行字段分派，unknown不是自动穷尽的TS字面量联合。
	switch (schema.type) {
		// 对象支使用块级作用域容纳局部required/shape变量。
		case "object": {
			// 把必填名转Set便于has查询；as string[]只改TS视图，不检查数组/元素形状或填默认值。
			const required = new Set(schema.required as string[]);
			// shape是字段名到Zod实例的本地新表，不是复制用户对象数据。
			const shape: Record<string, z.ZodType> = {};
			// Object.entries遍历规则表自己的可枚举字段，解构出名字/规则；as不保证任意外来properties有效。
			for (const [key, value] of Object.entries(schema.properties as Record<string, Json>)) {
				// 每个子规则递归构建，沿用原根供$ref取定义。
				const property = nativeZod(value, root);
				// Set含名则保持字段规则，否则包optional；只处理required里且实际声明的字段，不额外实现任意JSON Schema required语义。
				shape[key] = required.has(key) ? property : property.optional();
			}
			// 只有严格false选strictObject；其余选默认strip的object。无额外关键字适配，开放JSON对象的未知字段解析输出因此并非原样保留。
			return schema.additionalProperties === false ? z.strictObject(shape) : z.object(shape);
		}
		// 字符串支有单独作用域，可在链上重赋本地string变量。
		case "string": {
			// enum真为数组才用Zod枚举；非空string元组断言不验证实际成员。此早返回忽略同节点长度/pattern，依赖corpus枚举支没有这些并列约束。
			if (Array.isArray(schema.enum)) return z.enum(schema.enum as [string, ...string[]]);
			// 先创建基础字符串schema，后续链式方法返回实例并保存下来。
			let string = z.string();
			// 仅数值minLength才加最短长度检查；Zod按JS字符串长度，与通用JSON Schema码点计数并非所有文本等价。
			if (typeof schema.minLength === "number") string = string.min(schema.minLength);
			// 仅数值maxLength才加上界，当前生成的配套样本都是ASCII。
			if (typeof schema.maxLength === "number") string = string.max(schema.maxLength);
			// 字符串pattern才编正则并加regex；无flags，坏表达式可在构造时抛错，不是safeParse布尔失败。
			if (typeof schema.pattern === "string") string = string.regex(new RegExp(schema.pattern));
			// 返回累计字符串规则，不执行样本检查。
			return string;
		}
		// integer单独分支，当前corpus保证同时提供minimum/maximum。
		case "integer":
			// 多行return从z开始调用后续number/int/min/max，不是返回命名空间z本身。
			return (
				z
					// 先要求有限number，不做数值字符串coerce。
					.number()
					// Zod int还限制安全整数；当前生成器上下界很小，不证明任意JSON整数规则等价。
					.int()
					// 应用已有minimum；as number不在缺字段时自动提供默认下界。
					.min(schema.minimum as number)
					// 应用maximum，静态断言不检查上界合法性；构造完直接返回。
					.max(schema.maximum as number)
			);
		// 普通number支和integer支分开，不套Math.trunc或整数约束。
		case "number":
			// 只造基础number规则，忽略此支其他数值关键字；适配的是corpus无数值界限的number分支。
			return z.number();
		// boolean类型支。
		case "boolean":
			// 造布尔规则，不把非空字符串按JS真值转换。
			return z.boolean();
		// array支只针对corpus固定的字符串成员数组。
		case "array":
			// 固定z.string()而不读schema.items，maxItems直接断言number；不支持任意数组成员/元组/额外关键字语义。
			return z.array(z.string()).max(schema.maxItems as number);
		// 未识别type走default，而不是任意schema都能在本地兜底适配。
		default:
			// 把schema序列化后截前80个UTF-16码元作异常诊断；循环/BigInt/toJSON可能先抛，不保证总产生这条固定Error，无秘密脱敏。
			throw new Error(`No native Zod builder for ${JSON.stringify(schema).slice(0, 80)}`);
	}
}

/** z.fromJSONSchema with the draft given; it accepts only local $refs, so remote documents are not passed. */
// 规范比较入口：输入JsonSchema和draft选项返回Zod schema，例字符串minLength:1可导入后safeParse。委托真实z.fromJSONSchema，不传远程文档；它会JSON序列化/解析规范化、可能调用输入toJSON或抛错，并可能登记Zod元数据，非网络解析器。
export function zodFromJsonSchema(schema: JsonSchema, draft: "2020-12" | "7"): z.ZodType {
	// as never只绕过静态schema类型差异，不改变对象；defaultTarget把7映draft-7，否则2020-12。Zod仍优先识别输入$schema，选项是兜底，不强制覆盖声明版本。
	return z.fromJSONSchema(schema as never, { defaultTarget: draft === "7" ? "draft-7" : "draft-2020-12" });
}
