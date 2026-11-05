// 把已经校验失败的值解释成{path,keyword,message}列表；Validator.errors先跑快速check，失败后才创建并调用这里。
// 例如规则要求name是字符串、输入{name:1}，错误路径为/name，keyword为type；输入不会在此转换或主动写回。
// 解释过程重新调用编译后的子规则、format回调及JSON序列化等，不保证无副作用或不抛异常；$dynamicRef的解释是近似的。
// 这不是另一套决定校验成败的入口：布尔结果由Compiler/Validator负责，错误选支以可读性为目标，不总列出每一候选分支。
// Errors of a failed value: a walk over the schema that reports each failing keyword at the value it failed on.
// It runs only for values that failed the check, using the compiler's checks for subschemas.

// 创建“哪些字段/数组项已被规则处理”的运行时记录，专用于解释unevaluated类错误，不是代码注释。
import { newAnnotations } from "./annotations.ts";
// 下面从实际布尔检查器复用相同判定，避免错误解释与长度、相等性、倍数等语义各写一套。
import {
	// 按Unicode码点数计字符串长度，表情代理对算1，不是显示列数或string.length。
	codePoints,
	// constCheck先按常量生成检查闭包，再对当前值调用。
	constCheck,
	// containsCheck按匹配项数与上下界判断数组，内部调用传入的子项检查。
	containsCheck,
	// enumCheck按允许值生成检查器，原始值与对象/数组使用相应相等策略。
	enumCheck,
	// isMultiple复用十进制倍数判断，处理浮点除法误差。
	isMultiple,
	// isObject排除null、数组、Uint8Array；并不证明任意JS对象是纯JSON数据。
	isObject,
	// NEVER是始终false的检查函数，作为未知type名的失败回退。
	NEVER,
	// TYPE_CHECKS用Map把string/number/object/bytes等名字对应到布尔函数。
	TYPE_CHECKS,
	// uniqueCheck按JSON式深比较查重复项，不是只把对象引用放进Set。
	uniqueCheck,
} from "./checks.ts";
// import type只引入TS类型；这里拿外部已创建的Compiler实例，不在此构造它。
import type { Compiler } from "./compiler.ts";
// isSchemaObject是unknown规则节点边界的运行时判断：非null非数组对象。
import { isSchemaObject } from "./resolver.ts";
// 复用正则缓存，先按u编译、旧转义不兼容时无标志回退；两种都不合法会抛出。
import { sharedRegex } from "./shared.ts";
// 规则字段值保留unknown、错误字段用公开类型约束；这些类型不会自动校验传入对象。
import type { SchemaObject, ValidationError } from "./types.ts";

/** Explains failures of one compiled schema. */
// 保存一份规则和供子规则检查/引用解析使用的Compiler，按失败值遍历生成解释。
// 例如同一Validator反复处理错误输入可复用Explainer；单次$ref对象错误缓存会在每次errors结束后释放。
// export class提供运行时类；private/readonly主要由TS约束访问与重赋，不深冻结schema或compiler。
export class Explainer {
	// 保存编译器实例，它持有规则检查缓存、引用解析器、draft与用户format配置。
	private readonly c: Compiler;
	// 原始根规则引用，unknown表示遍历时仍需检查布尔/对象等节点形态。
	private readonly schema: unknown;
	/**
	 * The errors of `$ref` targets for object values, within one errors() call: a recursive union explains each branch
	 * to pick the one to blame, and every branch would explain the same children again, exponentially in the depth.
	 */
	// 可空双层Map：第一键是引用目标规则对象身份，第二键是输入对象身份，值为该对象最近记录的path与错误数组。
	// 命中还要求path相同；同一对象在/a和/b出现会重新解释以生成正确路径。只缓存完成结果，不是处理循环值的“访问中”哨兵。
	// 类型中的| undefined表示尚未按需分配；Map强持有对象但只限当前errors调用，finally会丢弃整张表。
	private memo: Map<object, Map<object, { path: string; errors: ValidationError[] }>> | undefined = undefined;

	// 接收compiler/schema并确保根检查已编好，返回新实例；不校验具体输入，不克隆/修改schema。
	// 例如Validator首次失败时new Explainer(compiler(...),schema)；root编译可能因坏规则/引用抛错，但不按URI联网取文档。
	constructor(compiler: Compiler, schema: unknown) {
		// 把参数保存为实例字段，后续ok/walk共用这份编译状态。
		this.c = compiler;
		// 保存根规则原引用，调用方编译后改schema可能使检查与延迟解释不一致。
		this.schema = schema;
		// 触发或命中根检查编译缓存；这里是编译规则，不是向模型或网络发送请求。
		compiler.root();
	}

	/** The errors of `value`, at least one (`value` failed the check). */
	// 为已失败value返回至少一条可读错误，根路径用空串；按规则walk收集，finally清单次memo，必要时加通用invalid。
	// 例如缺必需name得到/name+required；此方法本身不先保证value失败，直接传合法值也会因空结果而得到通用invalid，上层负责筛选。
	// 返回错误是正常路径；用户getter/format、序列化、坏规则等抛错会向外传播，finally只清memo，不把异常变成错误列表。
	errors(value: unknown): ValidationError[] {
		// 新建本次独立错误数组，元素类型由TS约束为ValidationError。
		const out: ValidationError[] = [];
		// try/finally保证正常返回或中途抛错都执行memo清理，没有catch吞错。
		try {
			// 从根schema、解析器rootBase、整个value和空JSON Pointer路径开始；walk通过out引用追加。
			this.walk(this.schema, this.c.r.rootBase, value, "", out);
		} finally {
			// 断开本次缓存引用，避免解释器跨次保留输入对象与旧路径错误；不清编译器自身缓存。
			this.memo = undefined;
		}
		// 没有具体解释时补根schema/invalid；也涵盖非JSON数值等布尔检查失败但逐规则解释没给细节的情况。
		if (out.length === 0) out.push({ path: "", keyword: "schema", message: "invalid" });
		// 返回收集到的数组，不再次克隆每条错误。
		return out;
	}

	// 拿节点/基URI对应的检查函数并立即验证v，返回boolean；例如{type:"integer"}检查"1"为false。
	// 可复用Compiler.check缓存，也可能编译尚未见的节点；format可再次执行/抛错，不能当作恒无副作用的字段读取。
	private ok(node: unknown, base: string, v: unknown): boolean {
		// 连续两对括号：先check(node,base)获得闭包，再用(v)调用闭包。
		return this.c.check(node, base)(v);
	}

	// For $dynamicRef schemas this check runs outside the original dynamic scope, so their errors are approximate.
	// 解释node在v当前位置的失败，base供相对引用解析，path是当前JSON Pointer，out接收追加结果，返回void。
	// 流程是布尔/对象节点→先check排除成功→type→具体类型约束→组合/引用→必要时unevaluated或动态引用兜底。
	// 例对象字段数值小于minimum则写该字段路径；type已错会提前返回，避免再列不适用的长度等错误。
	// 递归子检查在各自入口运行，未重建原校验时的完整动态调用栈，因此动态引用错误不等同布尔检查的精确证明。
	private walk(node: unknown, base: string, v: unknown, path: string, out: ValidationError[]): void {
		// 布尔schema true允许所有值，不追加任何错误。
		if (node === true) return;
		// 布尔schema false拒绝所有值，直接给当前位置的通用拒绝错误。
		if (node === false) {
			// 对象简写path沿用当前路径，keyword为字符串"false"，不是布尔字段。
			out.push({ path, keyword: "false", message: "no value is allowed here" });
			// false节点无需继续按type/对象关键词解释。
			return;
		}
		// 非布尔又非规则对象时静默跳过；通常坏规则已在Compiler编译时抛错，这里不是完整元schema验证器。
		if (!isSchemaObject(node)) return;
		// 节点自身$id或索引基URI可能改变引用解析基准，取本层实际base。
		const b = this.c.r.baseFor(node, base);
		// 整个节点检查已通过就不用逐项解释；失败才往下，所以有效联合分支等不会产生错误。
		if (this.ok(node, b, v)) return;
		// 记住进入本层时out长度，用来判断本层及递归是否已新增解释，不受之前兄弟错误影响。
		const start = out.length;
		// 局部push回调收keyword/message及可选路径at，默认当前path；只往out追加，返回值推导为void。
		// 例如push("minimum","expected >= 1")用当前字段路径，required则显式传缺失子字段路径。
		const push = (keyword: string, message: string, at = path) => {
			// 字段path显式映射为at，另两字段使用属性简写；不改变当前遍历路径变量。
			out.push({ path: at, keyword, message });
		};
		// draft7里$ref覆盖所有兄弟关键词，包括type等，所以必须优先沿引用走。
		if (this.c.draft === "7" && typeof node.$ref === "string") {
			// 只解释引用目标在同一数据/路径上的失败。
			this.walkRef(node.$ref, b, v, path, out);
			// draft7引用结束后不再解释本节点其他关键词。
			return;
		}
		// 规则显式提供type才做类型错误解释；没有type时各类型关键词仅对对应值适用。
		if (node.type !== undefined) {
			// 数组type直接作为候选列表，单个type包装成数组；规则字段unknown需要Array.isArray判定。
			const types = Array.isArray(node.type) ? node.type : [node.type];
			// map为每种名字找检查器；非字符串/未知名字用NEVER，??只在未找到时回退，不执行NEVER直到下一步。
			const checks = types.map((t) => (typeof t === "string" ? TYPE_CHECKS.get(t) : undefined) ?? NEVER);
			// some检查任一类型是否允许v；全部不允许才报告一次type错误，取反!得到失败条件。
			if (!checks.some((check) => check(v))) {
				// 候选用" or "连接，实际值类型由typeName细分null/array/bytes/integer；异常非JSON候选转字符串也可能有额外行为。
				push("type", `expected ${types.join(" or ")}, got ${typeName(v)}`);
				// 类型已不匹配，终止当前节点解释，避免把不适用的后续规则当作主要原因。
				return;
			}
		}
		// enum必须是数组且实际枚举检查不通过才记录；&&右侧只在数组分支调用。
		if (Array.isArray(node.enum) && !enumCheck(node.enum)(v))
			// listValues最多列20个允许值，防止海量枚举把一条错误拉得过长。
			push("enum", `expected one of ${listValues(node.enum)}`);
		// hasOwn区分没有const和自有const值为undefined；检查失败后才格式化错误。
		if (Object.hasOwn(node, "const") && !constCheck(node.const)(v))
			// JSON.stringify表示预期常量；BigInt、循环对象或toJSON等可抛错，不在此捕获。
			push("const", `expected ${JSON.stringify(node.const)}`);
		// 字符串值解释长度/正则/格式；只有type严格等于"bytes"才排除这条分支。
		if (typeof v === "string" && node.type !== "bytes") this.walkString(node, v, push);
		// Uint8Array且规则type正好是"bytes"时解释字节长度；数组形式["bytes"]不走这个专门解释分支，可能回退通用错误。
		if (v instanceof Uint8Array && node.type === "bytes") this.walkBytes(node, v, push);
		// number值才解释数值边界/倍数；number包含NaN/Infinity，最终是否失败仍取决于编译检查。
		if (typeof v === "number") this.walkNumber(node, v, push);
		// 对象守卫排除null/数组/bytes后，解释属性、额外键、依赖等；不排除所有其他JS对象类别。
		if (isObject(v)) this.walkObject(node, b, v, path, out, push);
		// 真实数组才逐项和按数组关键词解释。
		if (Array.isArray(v)) this.walkArray(node, b, v, path, out, push);
		// allOf逐个遍历每个子规则；成功子规则在自身walk入口返回，失败者可各追加错误。
		if (Array.isArray(node.allOf)) for (const s of node.allOf) this.walk(s, b, v, path, out);
		// anyOf用联合解释器，false表示至少匹配一支即可。
		if (Array.isArray(node.anyOf)) this.walkUnion(node.anyOf, b, v, path, out, false);
		// oneOf要求恰好一支，true使联合解释器报告多支同时匹配。
		if (Array.isArray(node.oneOf)) this.walkUnion(node.oneOf, b, v, path, out, true);
		// not的子规则反而通过时才违反否定要求，错误归当前路径，不展开子规则成功细节。
		if (node.not !== undefined && this.ok(node.not, b, v)) push("not", "must not match the schema in not");
		// 有if才决定要解释哪一个条件分支，不把if检查不通过本身当错误。
		if (node.if !== undefined) {
			// if成功选then，否则选else；三元只选其中一个，分支可能缺省undefined。
			const branch = this.ok(node.if, b, v) ? node.then : node.else;
			// 选中分支存在才遍历，缺省分支等同没有附加要求。
			if (branch !== undefined) this.walk(branch, b, v, path, out);
		}
		// 现代draft中$ref与兄弟关键词共同生效，所以在其他检查之后仍解释引用；draft7已提前返回。
		if (typeof node.$ref === "string") this.walkRef(node.$ref, b, v, path, out);
		// 仅本层尚未新增任何错误且有unevaluated规则时，补查剩余字段/项；已有主要错误时不再追加这类解释。
		if (out.length === start && (node.unevaluatedProperties !== undefined || node.unevaluatedItems !== undefined)) {
			// 重跑带已评估记录的规则，以定位未被其他关键词处理的数据位置。
			this.walkUnevaluated(node, b, v, path, out);
		}
		// 若仍无解释且有动态引用，给当前路径一个动态引用通用错误；它不沿原动态作用域精确还原目标。
		if (out.length === start && typeof node.$dynamicRef === "string") {
			// 只报告动态引用不匹配，不声称识别出了哪个动态目标/子字段失败。
			push("$dynamicRef", "does not match the dynamically referenced schema");
		}
	}

	// 解析ref并解释目标在v/path上的失败，向out追加，返回void；缺失引用在reject选项下报$ref，否则解析器可抛错。
	// 目标是规则对象且v为非null对象时按对象身份缓存完整解释，命中还须相同path；数组/bytes也可成为缓存的值键。
	// 例如共享对象同时在/a和/b出现，会重算不同路径；递归联合在同一路径反复访问同一子对象可复用，非任意循环值防护。
	private walkRef(ref: string, base: string, v: unknown, path: string, out: ValidationError[]): void {
		// Resolver按base在根/已注册schema文档里解析，不按URI发网络请求；返回目标节点与目标基URI。
		const target = this.c.r.resolve(ref, base);
		// resolve得到false可能是规则本来false，也可能是缺引用的reject回退，用isUnresolved区分。
		if (target.node === false && this.c.r.isUnresolved(ref, base)) {
			// 缺失引用明确记录原ref字符串和当前位置，而不是误报成用户主动写的false规则。
			out.push({ path, keyword: "$ref", message: `unresolved reference ${ref}` });
			// 缺引用错误解释完毕。
			return;
		}
		// 非对象规则或原始值/null不走双对象memo，直接递归；此处typeof判断来自unknown输入边界。
		if (!isSchemaObject(target.node) || typeof v !== "object" || v === null) {
			// 使用解析目标携带的base，不继续沿用父位置base。
			this.walk(target.node, target.base, v, path, out);
			// 直接递归完成后返回，避免落到Map对象键路径。
			return;
		}
		// ??=只在memo为null/undefined时创建外层Map，按本次实际需要惰性分配。
		this.memo ??= new Map();
		// 按目标规则对象引用取内层“输入对象→结果”表，首次可能undefined；let便于后续补建。
		let values = this.memo.get(target.node);
		// 可选链在内层表不存在时得到undefined，否则按输入对象引用查结果。
		const known = values?.get(v);
		// 同对象身份还要同path才可复用；不同路径不能直接套用已带路径的旧错误。
		if (known !== undefined && known.path === path) {
			// 展开缓存错误逐条追加到当前out，不复制每条错误对象。
			out.push(...known.errors);
			// 命中则不再次递归解释，节省联合重复遍历。
			return;
		}
		// 未命中新建局部错误数组，先独立完成目标解释。
		const errors: ValidationError[] = [];
		// 先walk再存memo；没有“正在解释”标记，循环输入/无限递归不是由这张缓存阻断的。
		this.walk(target.node, target.base, v, path, errors);
		// 先前没有取得内层表时，在本次目标解释完成后创建。
		if (values === undefined) {
			// 建立该目标规则对应的输入对象结果表。
			values = new Map();
			// 写入外层memo，键是目标规则的对象引用而非ref文本。
			this.memo.set(target.node, values);
		}
		// 记录该输入对象最近这次path及完成的errors；下次不同path会重新计算并覆盖该项。
		values.set(v, { path, errors });
		// 把刚收集的目标错误合并到调用方结果，即使空数组也可被缓存/合并。
		out.push(...errors);
	}

	// 解释字符串v的min/maxLength、pattern及已注册format，向push追加，返回void；不修改字符串。
	// 例如"\u{1F600}"码点长度为1；pattern不匹配给pattern错误，未知format不报错，用户format返回false报format、抛错则继续向外抛。
	private walkString(node: SchemaObject, v: string, push: Push): void {
		// 调用复用的码点计数器，合法代理对算1、孤立代理码元也算1；不是字素/终端宽。
		const n = codePoints(v);
		// 规则minLength真是数字才比较，规则来自unknown边界，不靠SchemaObject静态保证。
		if (typeof node.minLength === "number" && n < node.minLength) {
			// 不足最短码点数，错误仍归当前字符串路径。
			push("minLength", `expected at least ${node.minLength} characters`);
		}
		// 数字maxLength且实际码点数超出时，记录最长限制错误。
		if (typeof node.maxLength === "number" && n > node.maxLength) {
			// 错误文本列出最大允许码点数。
			push("maxLength", `expected at most ${node.maxLength} characters`);
		}
		// 字符串pattern交给共享正则test；没有隐式加^/$，坏正则可在编译/此处抛SyntaxError。
		if (typeof node.pattern === "string" && !sharedRegex(node.pattern).test(v)) {
			// 记录原pattern文本，便于理解是哪条表达式没匹配。
			push("pattern", `expected to match ${node.pattern}`);
		}
		// 读取编译选项里的format名称→检查函数表，可能未配置。
		const formats = this.c.formats;
		// 下面三元仅在名称有效且有自有注册项时取format，未知名称保留undefined。
		const format =
			// 排除未提供映射、非字符串名称和映射原型上的同名成员；这是schema/配置查找规则。
			formats !== undefined && typeof node.format === "string" && Object.hasOwn(formats, node.format)
				? // 注册项按名称索引获取，TS类型约定为字符串布尔检查回调。
					formats[node.format]
				: // 没有明确注册时忽略format断言，它只是schema标注。
					undefined;
		// 有回调就用v调用，false追加format错误；它可能被快速check和解释重复调用，异常无catch。
		if (format !== undefined && !format(v)) push("format", `expected format ${node.format}`);
	}

	// 为已确认Uint8Array的v解释字节长度上下界并调用push，返回void；例5字节、maxLength4给“at most 4 bytes”，不复制/修改字节。
	private walkBytes(node: SchemaObject, v: Uint8Array, push: Push): void {
		// 这里length是Uint8Array元素数，每元素1字节；仅处理数字minLength规则。
		if (typeof node.minLength === "number" && v.length < node.minLength) {
			// 字节不足时报最短字节数，区别于walkString的字符码点数。
			push("minLength", `expected at least ${node.minLength} bytes`);
		}
		// 字节数超出数字maxLength时失败。
		if (typeof node.maxLength === "number" && v.length > node.maxLength) {
			// 错误文本明确单位bytes。
			push("maxLength", `expected at most ${node.maxLength} bytes`);
		}
	}

	// 解释数值v的闭/开区间边界和multipleOf，返回void，通过push累计多个失败；输入本身不变。
	// 例如v=0、minimum=1报expected >= 1；此方法不重做type判断，也不承诺给NaN等非JSON数值列出所有快速检查失败原因。
	private walkNumber(node: SchemaObject, v: number, push: Push): void {
		// minimum含边界，小于它才追加错误；非数字关键词忽略。
		if (typeof node.minimum === "number" && v < node.minimum) push("minimum", `expected >= ${node.minimum}`);
		// maximum含边界，大于它才追加错误。
		if (typeof node.maximum === "number" && v > node.maximum) push("maximum", `expected <= ${node.maximum}`);
		// exclusiveMinimum不含边界，等于也失败；这里只支持数字形式。
		if (typeof node.exclusiveMinimum === "number" && v <= node.exclusiveMinimum) {
			// 错误用严格大于>表达开放下界。
			push("exclusiveMinimum", `expected > ${node.exclusiveMinimum}`);
		}
		// exclusiveMaximum不含上界，等于或大于都失败。
		if (typeof node.exclusiveMaximum === "number" && v >= node.exclusiveMaximum) {
			// 错误用严格小于<表达开放上界。
			push("exclusiveMaximum", `expected < ${node.exclusiveMaximum}`);
		}
		// 使用与布尔检查相同的十进制倍数助手，避免直接浮点取余产生不同解释。
		if (typeof node.multipleOf === "number" && !isMultiple(v, node.multipleOf)) {
			// 不是指定数字的倍数时追加multipleOf，零/非法约束等边界仍沿用检查器实际行为。
			push("multipleOf", `expected a multiple of ${node.multipleOf}`);
		}
	}

	// 解释对象字段、键模式、额外键、键名、数量与依赖，向out/push追加，返回void，不主动修改v。
	// 例缺path且offset=0时可同时给/path required与/offset minimum；自有字段值undefined在required/声明属性分支视为缺失。
	// 遍历主要用Object.keys/hasOwn，面向JSON对象；若输入/规则带getter、Proxy等读取仍可产生副作用/异常，不提供任意JS对象一致性保证。
	private walkObject(
		// 当前对象规则，字段仍是unknown，每个关键词使用前按需要判定。
		node: SchemaObject,
		// 已计算的本层base，递归子规则会再考虑自己的$id。
		b: string,
		// isObject收窄后的字符串键值表，属性值仍unknown；Record不强制对象必须由JSON.parse产生。
		v: Record<string, unknown>,
		// 对象在根输入中的JSON Pointer路径。
		path: string,
		// 共享结果数组，字段递归直接向它追加。
		out: ValidationError[],
		// 当前节点的push闭包，可显式把错误定位到缺失/多余字段。
		push: Push,
	): void {
		// properties是规则映射对象才使用，否则空映射；不因为TS声明SchemaObject就信任它。
		const properties = isSchemaObject(node.properties) ? node.properties : {};
		// required只接受数组容器，元素是否字符串在循环中检查。
		const required = Array.isArray(node.required) ? node.required : [];
		// 逐个检查必需字段名，按required原顺序报告缺失。
		for (const k of required) {
			// 必须字符串键，且没有自有属性或值undefined才报缺失；原型链同名成员不满足此处要求。
			if (typeof k === "string" && (!Object.hasOwn(v, k) || v[k] === undefined))
				// 错误落在缺失字段的转义JSON Pointer，而不是只给父对象路径。
				push("required", "missing", pointer(path, k));
		}
		// 遍历规则声明的自有可枚举属性名，而非遍历输入所有属性。
		for (const k of Object.keys(properties)) {
			// 只解释输入自有且非undefined的声明字段；递归时拼正确转义路径，读取getter可能发生多次。
			if (Object.hasOwn(v, k) && v[k] !== undefined) this.walk(properties[k], b, v[k], pointer(path, k), out);
		}
		// patternProperties为对象才转成[正则源码,子规则]列表，其他形态用空列表。
		const patterns = isSchemaObject(node.patternProperties) ? Object.entries(node.patternProperties) : [];
		// 枚举输入自有可枚举字符串键；symbol/不可枚举键不进入这一循环。
		for (const k of Object.keys(v)) {
			// 已在properties声明就算匹配，即便字段值undefined，也不会再当额外键处理。
			let matched = Object.hasOwn(properties, k);
			// 数组解构依次取每一组模式与子规则；同一字段可同时匹配多个模式。
			for (const [p, s] of patterns) {
				// 正则匹配的是键名，不是字段值；表达式本身不自动全串锚定。
				if (sharedRegex(p).test(k)) {
					// 有任意模式命中就避免后面走additionalProperties。
					matched = true;
					// 每个命中的模式都解释字段值，声明属性规则与模式规则可以共同约束同一键。
					this.walk(s, b, v[k], pointer(path, k), out);
				}
			}
			// 既未声明也没匹配模式，且规则显式有additionalProperties，才解释额外属性要求。
			if (!matched && node.additionalProperties !== undefined) {
				// false直接报unknown field，定位到该额外键；不会删除字段。
				if (node.additionalProperties === false) push("additionalProperties", "unknown field", pointer(path, k));
				// 其他布尔/对象规则递归解释额外字段值，true会自然不产生错误。
				else this.walk(node.additionalProperties, b, v[k], pointer(path, k), out);
			}
			// propertyNames校验键名字符串本身；失败只给一个键名错误，不展开键名子规则的内部错误。
			if (node.propertyNames !== undefined && !this.ok(node.propertyNames, b, k)) {
				// 错误路径指向相应字段，keyword保持propertyNames。
				push("propertyNames", "invalid property name", pointer(path, k));
			}
		}
		// 按Object.keys计算自有可枚举字符串键数，值undefined的键也计入；非JSON对象与编译器某些for...in路径不保证等价。
		const count = Object.keys(v).length;
		// 数字minProperties且键数不足时，给父对象路径的数量错误。
		if (typeof node.minProperties === "number" && count < node.minProperties) {
			// 说明所需最少属性数量，不凭此推断具体缺哪些键。
			push("minProperties", `expected at least ${node.minProperties} properties`);
		}
		// 数字maxProperties且键数过多时记录上限错误。
		if (typeof node.maxProperties === "number" && count > node.maxProperties) {
			// 说明最多允许属性数量，具体额外字段由前面的additionalProperties判断。
			push("maxProperties", `expected at most ${node.maxProperties} properties`);
		}
		// 创建合并后的依赖映射：新draft的dependentRequired先放，旧dependencies后放，同名键以后者覆盖；不是合并两份依赖列表。
		const dependencies = {
			// 对象展开...把映射自有可枚举项复制进新对象；draft7或非对象dependentRequired时展开空对象。
			...(this.c.draft === "7" || !isSchemaObject(node.dependentRequired) ? {} : node.dependentRequired),
			// 旧dependencies在两种draft都读取；后展开的同名属性覆盖前面对应值。
			...(isSchemaObject(node.dependencies) ? node.dependencies : {}),
		};
		// 依次取触发字段k和依赖声明d，数组表示依赖字段列表，其他形态当schema解释。
		for (const [k, d] of Object.entries(dependencies)) {
			// 触发字段必须是输入自有属性；值即使undefined也算存在，与上面的required缺失规则不同。
			if (!Object.hasOwn(v, k)) continue;
			// 非数组依赖作为规则作用于整个对象v，路径保持父对象，不是只校验v[k]。
			if (!Array.isArray(d)) this.walk(d, b, v, path, out);
			// 数组依赖走字段存在性分支，下一层for由else控制，不依赖缩进决定JS语义。
			// 逐个读取依赖名；这里没有再按字符串过滤，通常传入合规schema。
			// 仅要求自有属性存在，不检查该依赖值是否undefined；缺失报dependentRequired并指出触发键，pointer会字符串化r。
			else
				for (const r of d)
					if (!Object.hasOwn(v, r)) push("dependentRequired", `required when ${k} is present`, pointer(path, r));
		}
		// dependentSchemas只在现代draft且值为映射对象时解释，draft7忽略此关键词。
		if (this.c.draft !== "7" && isSchemaObject(node.dependentSchemas)) {
			// 每一项是[触发字段名,作用于整个对象的schema]。
			// 触发键自有存在就递归校验整个v，保持对象路径；多个触发项可以各贡献错误。
			for (const [k, s] of Object.entries(node.dependentSchemas))
				if (Object.hasOwn(v, k)) this.walk(s, b, v, path, out);
		}
	}

	// 解释数组逐项规则、长度、去重与contains匹配数，结果追加到out/push，无主动值修改。
	// 先确定元组前缀与剩余项规则，再遍历全部项并检查数组整体约束；例[number,string]索引1（第二项）为2会在/1报type。
	// 旧items数组与additionalItems仍优先识别，现代prefixItems只在非draft7分支使用；自定义检查回调异常向外传播。
	private walkArray(
		// 数组规则节点，关键词按unknown内容运行时选择。
		node: SchemaObject,
		// 当前规则base，供项内引用解析。
		b: string,
		// 已收窄为数组，元素依旧unknown；函数不要求元素都是同一TS类型。
		v: unknown[],
		// 数组自身的JSON Pointer路径，项路径会追加数字索引。
		path: string,
		// 各项递归错误追加到同一结果数组。
		out: ValidationError[],
		// 数组整体错误用当前push默认路径，例如minItems。
		push: Push,
	): void {
		// readonly unknown[]约束本函数不能通过prefix修改元组schema数组，但不冻结原数组；初始无前缀。
		let prefix: readonly unknown[] = [];
		// 剩余项规则初始undefined，undefined表示未施加该项约束。
		let rest: unknown;
		// items为数组时按旧式元组规则解释，不同时再采用prefixItems。
		if (Array.isArray(node.items)) {
			// 各位置一条前缀schema，保存原数组引用。
			prefix = node.items;
			// 元组之外项由additionalItems决定；缺省undefined表示没有额外要求。
			rest = node.additionalItems;
		} else {
			// items不是数组时，现代draft可用prefixItems；draft7不会读此新关键词。
			if (this.c.draft !== "7" && Array.isArray(node.prefixItems)) prefix = node.prefixItems;
			// 前缀之后使用单个items规则，可为true/false/规则对象或未提供。
			rest = node.items;
		}
		// 按数组length遍历每个索引，普通稀疏空位通常读undefined，也可能命中原型数字属性/访问器；不是只枚举已有键。
		for (let i = 0; i < v.length; i++) {
			// 索引还在prefix内则取对应schema，否则选rest；只取一个，不把二者同时施加于该项。
			const s = i < prefix.length ? prefix[i] : rest;
			// 明确有schema才递归；数字索引可直接拼入JSON Pointer，无需转义/与~，错误归对应项。
			if (s !== undefined) this.walk(s, b, v[i], `${path}/${i}`, out);
		}
		// 实际项数不足数字minItems时，给数组自身路径报告数量错误。
		if (typeof node.minItems === "number" && v.length < node.minItems) {
			// 错误文本包含最少项数。
			push("minItems", `expected at least ${node.minItems} items`);
		}
		// 实际项数超过数字maxItems时报告数量上限。
		if (typeof node.maxItems === "number" && v.length > node.maxItems) {
			// 错误文本包含最多项数。
			push("maxItems", `expected at most ${node.maxItems} items`);
		}
		// uniqueItems只认严格true；深比较存在重复时给数组整体错误，不具体指定哪两项重复。
		if (node.uniqueItems === true && !uniqueCheck(v)) push("uniqueItems", "expected unique items");
		// 显式有contains规则时才统计匹配数；contains=false也是一条存在的规则。
		if (node.contains !== undefined) {
			// 将draft判断保存在局部布尔值，下面两个边界共用。
			const draft7 = this.c.draft === "7";
			// draft7固定至少1项；现代draft可用数字minContains，未提供/非数字也默认1。
			const min = draft7 || typeof node.minContains !== "number" ? 1 : node.minContains;
			// draft7忽略maxContains，现代draft未给数字上限也使用正无穷。
			const max = draft7 || typeof node.maxContains !== "number" ? Number.POSITIVE_INFINITY : node.maxContains;
			// 先编译/复用contains子检查，再生成计数闭包并检查整个数组；匹配数越上限会提前失败。
			if (!containsCheck(this.c.check(node.contains, b), min, max)(v)) {
				// 只报一条contains错误，并用上下界生成可读文本，不逐项把未匹配当错误。
				push("contains", containsMessage(min, max));
			}
		}
	}

	// 解释anyOf/oneOf：先数成功分支，满足条件就返回，多匹配oneOf报整体错误，零匹配再选择最可读失败分支。
	// 优先用不同常量标签选支；无标签则比较输入自有键被分支properties声明的数量，再比较该分支首条错误路径的字符串长度。
	// 例如{kind:"image",width:-1}会选image支的width错误；选择只是解释启发式，不改变布尔校验结果，也不把所有失败分支并排输出。
	// 递归解释会重复运行检查/format，可能抛错；正常返回void并通过out追加选中错误。
	private walkUnion(
		// readonly候选规则数组，只读是TS约束；每项仍unknown，允许布尔schema。
		branches: readonly unknown[],
		// 联合节点base，分支内部walk会再处理自己的$id。
		b: string,
		// 所有分支共同面对同一个值，不做转换。
		v: unknown,
		// 联合节点在输入中的路径，候选错误从这里向下延伸。
		path: string,
		// 最终只向此数组追加选中的诊断或联合层通用错误。
		out: ValidationError[],
		// true表示oneOf恰好一支，false表示anyOf至少一支；这是运行时开关而非TS类型标签。
		exactlyOne: boolean,
	): void {
		// filter对每个候选运行ok并收集成功者，length计数；即使anyOf早已有成功也仍检查余下所有分支。
		const matches = branches.filter((s) => this.ok(s, b, v)).length;
		// 恰好一个匹配两种联合都成功；anyOf多匹配也成功，不需要进一步解释。
		if (matches === 1 || (!exactlyOne && matches > 0)) return;
		// 选择错误的keyword文本，后面的诊断使用同一名称。
		const keyword = exactlyOne ? "oneOf" : "anyOf";
		// 经过上面的成功返回后，matches>1只可能是oneOf违反唯一匹配。
		if (matches > 1) {
			// 给联合自身路径报“多于一个分支匹配”，不选择某个子分支当失败原因。
			out.push({ path, keyword, message: "matches more than one alternative" });
			// 多匹配解释已完成，余下逻辑只处理零匹配。
			return;
		}
		// A tagged union reports the branch its tag selects; otherwise the branch whose first error is deepest.
		// tagOf扫描可作为常量判别键的候选；这里的解释启发式比Compiler的优化准入宽，不要求required/type=object。
		const tag = this.tagOf(branches, b);
		// 有可辨标签且输入通过isObject时，优先相信标签指向的候选；非对象输入仍走下方常规选支。
		if (tag !== undefined && isObject(v)) {
			// 从输入读取标签，用indexOf找候选常量；它用严格相等匹配，不按标签值类型强制转换。
			const i = tag.values.indexOf(v[tag.key]);
			// 标签缺失或不在候选列表时索引为-1，给标签字段本身报错。
			if (i < 0)
				// 追加标签范围错误对象，不展开每个候选的其他字段错误。
				out.push({
					// pointer转义标签键名，定位到标签字段。
					path: pointer(path, tag.key),
					// keyword使用anyOf/oneOf，而不是把它标成enum，因这是联合选支诊断。
					keyword,
					// 用受长度限制的JSON列表列出允许标签值，非JSON值的序列化仍可能有异常。
					message: `expected one of ${listValues(tag.values)}`,
				});
			// 标签有效时只解释对应原始分支，保留其自身引用/其他关键词；不保证标签必需规则已声明。
			else this.walk(branches[i], b, v, path, out);
			// 标签路径已决定后直接结束，不再比较别的候选“好不好”。
			return;
		}
		// An object is blamed on the branch that declares most of its properties (the one it was most likely meant for),
		// then on the branch whose first error is deepest.
		// 无标签时保存目前最佳解释及其声明键数量；undefined表示还没有可用候选，错误数组与计数字段由TS结构类型约束。
		let best: { errors: ValidationError[]; declared: number } | undefined;
		// 按branches原顺序尝试每一个候选；完全同分时保留更早分支。
		for (const s of branches) {
			// 每个分支先用独立错误数组，避免未选中的解释直接污染out。
			const errors: ValidationError[] = [];
			// 完整解释这一候选，可能通过$ref memo复用已完成的相同子值/路径结果。
			this.walk(s, b, v, path, errors);
			// 当前解释没有给出错误就不作为候选；动态作用域近似等情形可能导致此结果。
			if (errors.length === 0) continue;
			// 仅对象输入统计自有键与该候选properties的交集数，其他输入计0；不统计required、正则匹配或任意深层属性。
			const declared = isObject(v) ? this.declaredKeys(s, b, v) : 0;
			// 多行||表达式按优先级选更好的诊断；比较的是启发式分数，不是严格数学上的“最接近合法”。
			const better =
				// 还没有best时，第一个有错误的候选自动领先，||短路避免读undefined字段。
				best === undefined ||
				// 声明了更多输入自有键的分支优先。
				declared > best.declared ||
				// 声明数相同再比较第一条错误path的码元长度；较长键名/转义会影响长度，不是精确数路径层级。
				(declared === best.declared && errors[0].path.length > best.errors[0].path.length);
			// 确实更好才替换整个best，保留该候选的完整错误数组；完全同分不替换。
			if (better) best = { errors, declared };
		}
		// best可用时展开其所有错误；没有可解释候选则追加联合自身的“无分支匹配”，不修改输入或分支。
		out.push(...(best?.errors ?? [{ path, keyword, message: "matches no alternative" }]));
	}

	/** How many of the keys of `v` the branch `s` (through a `$ref`) declares in `properties`. */
	// 计算对象v有多少自有可枚举键出现在分支s的properties中，供联合解释打分，无输入修改。
	// 若s有字符串$ref，只解析一跳并看目标的properties，不合并兄弟/allOf等；例输入{a:1,b:2}对只声明a的支计1。
	// 解析可抛错，这不是完整推导分支所有可接受键的算法。
	private declaredKeys(s: unknown, b: string, v: Record<string, unknown>): number {
		// 规则对象且有$ref就按传入b解析一次取node；否则直接用s，不递归追完整引用链或展开组合。
		const node = isSchemaObject(s) && typeof s.$ref === "string" ? this.c.r.resolve(s.$ref, b).node : s;
		// 候选/目标以及properties都为规则对象形态时才取映射，否则视为无声明。
		const properties = isSchemaObject(node) && isSchemaObject(node.properties) ? node.properties : {};
		// Object.keys(v)不含原型/symbol/不可枚举键；filter按properties自有键筛选，length就是交集数量。
		return Object.keys(v).filter((k) => Object.hasOwn(properties, k)).length;
	}

	// 寻找能区分所有分支的常量标签，返回{key,values}或undefined；不修改规则，引用解析可能抛错。
	// 例如每支properties.kind.const分别是text/image，返回kind及这两个值；按首支properties键的枚举顺序选第一个可用键。
	// 这是错误选支启发式，不核查标签required、不要求分支type=object，也不展开allOf；与Compiler更严格的快速联合优化不同。
	private tagOf(branches: readonly unknown[], b: string): { key: string; values: unknown[] } | undefined {
		// 先map各候选，下面三元为每项返回单跳$ref目标或原节点，得到新的resolved数组。
		const resolved = branches.map((s) =>
			// 分支有字符串$ref就直接解析其目标；采用当前b，不在本助手额外调用baseFor合并分支$id。
			isSchemaObject(s) && typeof s.$ref === "string" ? this.c.r.resolve(s.$ref, b).node : s,
		);
		// 首个候选决定可以尝试哪些标签键；空分支数组得到undefined。
		const first = resolved[0];
		// 首支不是对象/没有对象properties就无法扫描标签，直接返回无结果。
		if (!isSchemaObject(first) || !isSchemaObject(first.properties)) return undefined;
		// 只尝试首支声明的自有可枚举键，不把别支独有键作为标签。
		for (const key of Object.keys(first.properties)) {
			// 局部map回调为每个分支读取同一个key的const，返回该标签值或undefined，无主动修改。
			// 例如key=kind时依次得到["text","image"]；没有该属性/const的分支贡献undefined使候选失败。
			const values = resolved.map((s) => {
				// 分支和properties都为对象才读同名字段规则，否则tag为undefined。
				const tag = isSchemaObject(s) && isSchemaObject(s.properties) ? s.properties[key] : undefined;
				// 字段规则是对象就取const；这里没有hasOwn要求，也不会验证它还有哪些其他约束。
				return isSchemaObject(tag) ? tag.const : undefined;
			});
			// 所有标签都不能undefined，且不能是非null对象；null允许，函数/symbol等非JSON值也没被此条件排除。
			const primitive = values.every((x) => x !== undefined && (typeof x !== "object" || x === null));
			// Set按SameValueZero去重；每支标签不同才返回。它与上面indexOf的NaN行为有差异，主要面向JSON标签。
			if (primitive && new Set(values).size === values.length) return { key, values };
		}
		// 所有候选键都不合适则返回undefined，调用方使用普通分支打分。
		return undefined;
	}

	// 在其他主要解释未增加错误时，重跑去掉本层unevaluated规则的带记录检查，再解释尚未处理的字段/项。
	// 例如properties只处理a、unevaluatedProperties=false，输入{a:1,b:2}会在/b报unknown field；结果追加out，无主动值修改。
	// 重跑可触发format等回调；不复用原布尔检查的动态作用域，也没有保证记录与任意非JSON对象/异常回调完全一致。
	private walkUnevaluated(node: SchemaObject, b: string, v: unknown, path: string, out: ValidationError[]): void {
		// 对象解构拿两个unevaluated约束，...rest浅复制其他自有可枚举字段，避免它们自己把剩余数据先标成已处理。
		const { unevaluatedProperties, unevaluatedItems, ...rest } = node;
		// 新建空记录：props/indexes未分配，items前缀为0，allProps/allItems均false。
		const a = newAnnotations();
		// 编译并执行rest的annotating检查，向a记录评估覆盖范围；布尔返回值这里被忽略，后续只读记录。
		this.c.annotating(rest, b)(v, a);
		// 输入为对象、有本层unevaluatedProperties且未标成所有字段已处理，才枚举剩余字段。
		if (isObject(v) && unevaluatedProperties !== undefined && !a.allProps) {
			// 只遍历输入自有可枚举字符串键。
			for (const k of Object.keys(v)) {
				// props集合存在且包含k就已被处理，直接跳过；null时可选链得到undefined，视为未覆盖。
				if (a.props?.has(k)) continue;
				// 剩余字段规则为false时，无需再展开子规则，直接给专门关键词错误。
				if (unevaluatedProperties === false) {
					// 错误路径转义键名，keyword使用unevaluatedProperties，区别于additionalProperties的局部匹配。
					out.push({ path: pointer(path, k), keyword: "unevaluatedProperties", message: "unknown field" });
					// 其他布尔/对象规则针对剩余字段值递归；true不会产生错误，非false子规则失败保持其具体关键词。
				} else this.walk(unevaluatedProperties, b, v[k], pointer(path, k), out);
			}
		}
		// 输入为数组、有unevaluatedItems且没有allItems标记时检查未覆盖项。
		if (Array.isArray(v) && unevaluatedItems !== undefined && !a.allItems) {
			// a.items代表已处理连续前缀的长度，从该索引到数组末尾查剩余项。
			for (let i = a.items; i < v.length; i++) {
				// contains等可能单独覆盖前缀外索引，indexes集合已有则跳过。
				if (a.indexes?.has(i)) continue;
				// 剩余项不允许存在时，直接用unevaluatedItems诊断。
				if (unevaluatedItems === false) {
					// 索引路径无需键名转义，定位到具体未评估的数组项。
					out.push({ path: `${path}/${i}`, keyword: "unevaluatedItems", message: "unexpected item" });
					// 允许用schema约束剩余项时递归解释其具体失败，不改数组和a记录。
				} else this.walk(unevaluatedItems, b, v[i], `${path}/${i}`, out);
			}
		}
	}
}

// 函数类型别名：keyword/message必需，at?可省略，返回void；它只规定回调接口，运行时默认路径由walk里的闭包实现。
type Push = (keyword: string, message: string, at?: string) => void;

// Enum errors name the allowed values; a long list (an enum of thousands) is cut, so the message stays readable.
// 枚举/标签错误最多展示20个值；这是错误文本长度策略，不限制enum允许成员数量或验证规模。
const LISTED_VALUES = 20;

/** `values` as JSON, at most LISTED_VALUES of them, then how many more there are. */
// 把允许值数组格式化成错误文本，短列表直接JSON，长列表只序列化前20项并注明剩余数；不修改数组。
// 例如21项只列前20项再加“... and 1 more”；截断后的文本不是可直接JSON.parse的合法JSON。序列化非JSON对象/BigInt可抛错。
function listValues(values: readonly unknown[]): string {
	// 长度不超上限时JSON.stringify整个数组；原生序列化可调用toJSON、读取getter，不能视为对任意JS输入纯操作。
	if (values.length <= LISTED_VALUES) return JSON.stringify(values);
	// slice复制前20项的数组容器再序列化，不遍历尾部来生成文本。
	const listed = JSON.stringify(values.slice(0, LISTED_VALUES));
	// 去掉JSON末尾]，拼剩余数量和新的]；只是展示文本，省略号不是JSON语法。
	return `${listed.slice(0, -1)}, ... and ${values.length - LISTED_VALUES} more]`;
}

// 根据contains匹配上下界生成英文句子，返回字符串，无数据遍历/修改；例min1/maxInfinity为at least 1 matching item，先处理无上限再处理min0。
function containsMessage(min: number, max: number): string {
	// 上限为正无穷时只说至少min，min严格为1用单数item，否则items。
	if (max === Number.POSITIVE_INFINITY) return `expected at least ${min} matching ${min === 1 ? "item" : "items"}`;
	// 其他上限且最少0时只说至多max，按max是否1选单复数；min/max合法性或有限性不在本函数验证。
	if (min === 0) return `expected at most ${max} matching ${max === 1 ? "item" : "items"}`;
	// 其余情况列两个边界，使用复数items，不额外处理min=max的特殊措辞；NaN/负Infinity等也没被此分支先排除。
	return `expected between ${min} and ${max} matching items`;
}

// 给JSON Pointer父路径追加一个键，返回新串，不修改输入；例key="a/b~c"变成/a~1b~0c，根path空串，key可为字符串或数字。
function pointer(path: string, key: string | number): string {
	// 先String(key)，再全局把~换~0、/换~1，顺序避免二次转义刚产生的~；模板中的/负责分隔路径段。
	return `${path}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

// 为type错误生成实际类型名，无修改/遍历/IO；先细分null/array/bytes/整数再退回typeof，例1→integer、1.5→number。
function typeName(v: unknown): string {
	// typeof null为object，因此先单独返回null。
	if (v === null) return "null";
	// 数组单独返回array，不让它落入object。
	if (Array.isArray(v)) return "array";
	// Uint8Array（含其子类）标为bytes；其他TypedArray不在此分支内。
	if (v instanceof Uint8Array) return "bytes";
	// number且Number.isInteger时显示integer，包括JS可表示的整数而非只安全整数。
	if (typeof v === "number" && Number.isInteger(v)) return "integer";
	// 剩余值按原生typeof命名，NaN/Infinity仍叫number，函数/symbol/undefined也可有对应文本。
	return typeof v;
}
