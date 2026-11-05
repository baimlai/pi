/**
 * schema编译器把规则数据编成可复用校验闭包，而不是生成eval代码；它不在编译时验证某一份用户参数。
 * 例对象的path:str与offset:int各编一次，随后check({path:"a"})只运行组合好的函数；递归$ref靠提前缓存槽解决编译循环。
 * 普通关键词按字符串/数字/对象/数组分组，常见叶子、闭对象、数组和标签联合有专用路径；unevaluated*另记覆盖位置。
 * 编译是按实际读取的关键字做形状检查，不是覆盖所有JSON Schema元规则的严格schema校验器。format/访问器异常可传播。
 * 动态引用需要运行时URI作用域及查找闭包，可能保留Compiler；普通检查工厂尽量只捕获必要参数，释放编译期表。
 */
// The compiler: a schema to one check closure, built once. Keywords group by the type they constrain, so a value
// is classified once per schema, and the common shapes (closed objects, arrays of one item schema, tagged unions,
// leaf schemas) get one specialized closure each.

// 引入需要记录字段/数组位置的检查工厂，用于2020-12的unevaluated*，这里的annotation不是description元数据。
import {
	// 带账本恒失败函数。
	ANNOTATING_FALSE,
	// 带账本恒通过函数，不声称自动覆盖全部字段。
	ANNOTATING_TRUE,
	// 多接收Annotations账本参数的函数类型，type导出项编译时擦除。
	type AnnotatingCheck,
	// 普通断言后接若干带记录检查。
	annotateAll,
	// anyOf/oneOf遍历成功分支并合并位置。
	annotateAny,
	// 数组prefix/rest/contains及已覆盖下标记录。
	annotateArray,
	// dependentSchemas触发的整对象检查。
	annotateDependent,
	// if/then/else及成功条件位置贡献。
	annotateIf,
	// properties/pattern/additional及字段位置记录。
	annotateObject,
	// 普通Check适配成不记位置的函数。
	ignoreAnnotations,
	// 递归引用的带账本间接槽。
	indirectAnnotating,
	// 把本schema账本与父兄弟隔离，成功后再合并。
	isolateAnnotations,
	// 运行时动态资源scope压栈/弹栈的带记录包装。
	scopedAnnotating,
	// 只检查尚未覆盖数组项。
	unevaluatedItems,
	// 只检查尚未覆盖对象键。
	unevaluatedProperties,
	// 将带记录检查包装成每次新建账本的普通Check。
	withFreshAnnotations,
} from "./annotations.ts";
// 普通布尔检查工厂，常见叶子/对象/数组/联合可特化，避免运行时重新遍历整份schema。
import {
	// 恒true共享函数。
	ALWAYS,
	// 多个检查取合取，全都通过才true。
	and,
	// 普通anyOf，首个通过可短路。
	anyCheck,
	// 本库Uint8Array类型及长度扩展。
	bytesCheck,
	// 固定const值检查。
	constCheck,
	// contains命中计数，无位置记录。
	containsCheck,
	// 只有声明字段/额外键策略的对象快路径。
	declaredObject,
	// 键出现就要求另一些键的依赖。
	dependentRequiredCheck,
	// 键出现就对整对象跑子schema的依赖。
	dependentSchemasCheck,
	// 枚举值检查，按数量/形状选择实现。
	enumCheck,
	// 类别不匹配时宽松通过，表示此关键字只约束对应类别。
	GUARD_LOOSE,
	// 对象工厂可省类别检查，由外层负责。
	GUARD_NONE,
	// 类别不匹配时严格拒绝。
	GUARD_STRICT,
	// 0|1|2的守卫类型联合，不是运行时枚举。
	type Guard,
	// 数组类别分流包装。
	guardArray,
	// 对象类别分流包装。
	guardObject,
	// 字段名也是Object.prototype成员时的内部位标志。
	INHERITED,
	// 共享数组类型叶函数。
	IS_ARRAY,
	// 共享对象类型叶函数。
	IS_OBJECT,
	// 条件分支布尔组合。
	ifCheck,
	// 递归普通Check的间接槽。
	indirect,
	// 数组前缀/后续项检查。
	itemsCheck,
	// 按共享叶函数身份查内联代码。
	LEAF_CODES,
	// 数组长度检查。
	lengthCheck,
	// 类别/长度/prefix/rest合并的数组快路径。
	listCheck,
	// 恒false共享函数。
	NEVER,
	// 子规则布尔取反。
	notCheck,
	// 数字类型/界限/倍数合并检查。
	numberCheck,
	// 恰一个联合分支通过。
	oneCheck,
	// 较复杂对象规则：模式/额外必填/额外字段检查。
	openObject,
	// 对象字段数量界限。
	propertyCountCheck,
	// 对象键名规则。
	propertyNamesCheck,
	// 必填字段内部位标志。
	REQUIRED,
	// 普通Check的动态scope包装。
	scopedCheck,
	// 字符串类别/长度/正则/format合并检查。
	stringCheck,
	// 类型名→共享叶函数映射。
	TYPE_CHECKS,
	// 按必填const标签选互斥分支。
	taggedCheck,
	// 多个type名字组成类型联合检查。
	typeCheck,
	// 数组项目深比较去重检查，不实际删除重复项。
	uniqueCheck,
} from "./checks.ts";
// Resolver负责URI/锚点/Pointer定位；isSchemaObject只认非null非数组对象外形，不完整验证schema文档。
import { documentOf, isSchemaObject, Resolver, resolveUri } from "./resolver.ts";
// 正则编译可跨schema弱共享，无需每次输入new RegExp。
import { sharedRegex } from "./shared.ts";
// 编译选项/规则/回调类型在运行JS中擦除。
import type { Check, CompileOptions, FormatCheck, JsonSchema, SchemaObject } from "./types.ts";

/** Thrown when a compile without dynamic scope tracking meets a bookended `$dynamicRef`: compile again with it. */
// 唯一Symbol作为动态重启哨兵；例bookended动态引用首次编译时抛它，validator.ts只认此身份重建动态Compiler，不靠错误字符串判断。
export const RESTART = Symbol("restart");

/** One compile of a schema. Its caches and indexes are garbage once the root check is built. */
// Compiler构造规则闭包：按对象缓存递归槽，按类型合并关键字，必要时带求值账本/动态资源scope。例compile对象的path字段只需编一次字符串check。
// 普通检查工厂不捕获Compiler，可让编译状态被回收；动态lookup捕获this/compile回调，会使Compiler及Resolver继续存活，回收时间仍由GC决定。
export class Compiler {
	// 规则地址解析器，暴露给Explainer/Coercer复用同一套语义。
	readonly r: Resolver;
	// 本次固定draft；跨文档引用仍用这次draft，不会按被引用文档$schema自动切版本。
	readonly draft: "2020-12" | "7";
	// 格式检查表原引用；只显式注册的format有断言作用。
	readonly formats: Readonly<Record<string, FormatCheck>> | undefined;
	/** Whether checks track the dynamic scope (the schema has a bookended `$dynamicRef`). */
	// dynamic决定是否维护运行时资源作用域，不等于是否允许静态$ref。
	readonly dynamic: boolean;
	// 根规则原引用，构造器没有克隆/冻结。
	private readonly schema: JsonSchema;
	// 动态资源URI栈，正常包装push/check/pop；用户回调抛错不普遍自动恢复栈。
	private readonly scope: string[];
	// 普通Check按schema对象身份缓存，不按JSON内容去重；递归编译期间先放间接函数。
	private readonly cache = new Map<object, Check>();
	// 带账本检查使用独立缓存，不能和普通函数签名混用。
	private readonly annotatingCache = new Map<object, AnnotatingCheck>();

	// 构造保存根/格式/draft并建Resolver与空scope，尚不root编译，也不检查任何用户值。例validator.ts先用dynamic=false尝试，遇哨兵再新建true版。
	constructor(schema: JsonSchema, options: CompileOptions, dynamic: boolean) {
		// 保存schema原引用。
		this.schema = schema;
		// 每个Compiler独立地址解析/索引，无HTTP加载。
		this.r = new Resolver(schema, options);
		// 由Resolver按选项定draft。
		this.draft = this.r.draft;
		// 保留formats表原引用，不自动导入标准formats。
		this.formats = options.formats;
		// 记录是否启用动态作用域跟踪。
		this.dynamic = dynamic;
		// 新建每次编译所用的scope数组，不是模块共享。
		this.scope = [];
	}

	/** The check of the root schema. */
	// root从根规则及根基准进入check，返回可复用布尔闭包；例compile内部可能先探测root再取root，缓存/共享叶避免重复构造多数规则。
	root(): Check {
		// 返回函数本身，不在此传用户输入执行它。
		return this.check(this.schema, this.r.rootBase);
	}

	/** The check of a schema (cached by schema object; a recursive reference goes through an indirection). */
	// check流程：布尔常量→规则对象边界→缓存→简单叶子→递归槽→完整build→补槽/缓存。输入是规则节点，不是用户参数；规则不合法或引用失效可抛错，不回滚半完成缓存。
	check(node: unknown, base: string): Check {
		// true schema直接共享ALWAYS。
		if (node === true) return ALWAYS;
		// false schema直接共享NEVER。
		if (node === false) return NEVER;
		// unknown规则边界确认非null非数组对象；Date等对象仍可过外形关，不等于完整JSON Schema合法性检查。
		if (!isSchemaObject(node))
			// 形状不符抛Error，JSON.stringify用于报错也可能因非JSON值抛自身异常。
			throw new Error(`A schema must be an object or a boolean, got ${JSON.stringify(node)}`);
		// 查对象身份缓存，递归遇到自己时也可取得已放的间接槽。
		const cached = this.cache.get(node);
		// 缓存存在直接返回，不按base再复制一份同对象规则。
		if (cached !== undefined) return cached;
		// 尝试纯type/中性描述的共享叶路径。
		const bare = this.bareType(node);
		// 匹配时直接返回共享函数，不把它额外存进对象缓存。
		if (bare !== undefined) return bare;
		// 显式槽允许undefined初值，后面build完才填；类型联合表达编译中状态。
		const slot: { check: Check | undefined } = { check: undefined };
		// 先放间接闭包，子规则引用回自身时可停止重复展开。
		this.cache.set(node, indirect(slot));
		// 按节点自身$id/索引base修正基准，再真正编关键词。
		const check = this.build(node, this.r.baseFor(node, base));
		// 补好槽，先前递归闭包开始能调用完整check。
		slot.check = check;
		// 普通以后命中直接拿完整check，不多绕间接函数。
		this.cache.set(node, check);
		// 返回布尔检查函数，不保留错误列表或转换结果。
		return check;
	}

	// build选择规则路径：draft7引用独占、2020-12带unevaluated*走账本、其余plain加必要scope。例同级$ref/maxLength在draft7只保留引用。
	private build(node: SchemaObject, base: string): Check {
		// draft7字符串$ref覆盖所有同级关键字，不先编普通字段约束。
		if (this.draft === "7" && typeof node.$ref === "string") return this.ref(node.$ref, base);
		// 2020-12显式unevaluated属性/项目关键字触发带位置路径；包括false，因为false不是undefined。
		if (this.draft !== "7" && (node.unevaluatedProperties !== undefined || node.unevaluatedItems !== undefined)) {
			// 每次用户值校验新账本，对外仍给普通Check，防上次值污染下次记录。
			return withFreshAnnotations(this.annotating(node, base));
		}
		// 普通关键词先合成一个check。
		const check = this.plain(node, base);
		// 启动态且节点是资源根时包scope；&&短路下普通模式不必调用isResource建索引。
		return this.dynamic && this.r.isResource(node, base) ? scopedCheck(this.scope, base, check) : check;
	}

	/**
	 * The module-level check of a schema that is only a `type` (with annotations), `ALWAYS` for one with no assertion
	 * at all; undefined for every other schema. These are the most common subschemas and cost nothing to share.
	 */
	// bareType识别只有type及中性关键字的常见规则，例{type:"string",description:"路径"}复用共享函数。没有断言ALWAYS，其他情况undefined交完整build，不是unknown keyword报错器。
	private bareType(node: SchemaObject): Check | undefined {
		// type初值undefined，用unknown保存未经验证的schema字段。
		let type: unknown;
		// for...in实际也看继承可枚举键，不仅Object.keys；普通JSON对象无这类原型字段。
		for (const k in node) {
			// 发现type记其原值。
			if (k === "type") type = node.type;
			// 非type且非中性字段就放弃此快路径，不代表整份规则无效。
			else if (!NEUTRAL_KEYWORDS.has(k)) return undefined;
		}
		// 只有中性描述或type值undefined时恒通过。
		if (type === undefined) return ALWAYS;
		// 字符串类型名查共享表；未知名字或数组类型返回undefined，让完整路径处理。
		return typeof type === "string" ? TYPE_CHECKS.get(type) : undefined;
	}

	/** Every keyword of `node`, not tracking annotations. */
	// plain把字符串/数字/对象/数组等同类关键字合并，再接跨类型断言；例字符串type+minLength只需一个字符串group，不重复typeof检查。
	private plain(node: SchemaObject, base: string): Check {
		// 编译时收集子check，最后and组合；不在每个用户输入上重读规则。
		const parts: Check[] = [];
		// 省略type记undefined，数组原样用，单个名字包成一项；未在此全量校验type字段内容。
		const types = node.type === undefined ? undefined : Array.isArray(node.type) ? node.type : [node.type];
		// 只有一个type候选才可把类别要求融合进专用group。
		const single = types?.length === 1 ? types[0] : undefined;
		// 跟踪是否已有某group承担type限制，避免额外独立typeCheck。
		let typeInGroup = false;
		// 单一bytes是扩展专门分支，不走普通字符串/数字/对象/数组group。
		if (single === "bytes") {
			// bytes用minLength/maxLength长度规则，非number界限用默认；??保留0而不是被||吃掉。
			parts.push(bytesCheck(number(node.minLength) ?? 0, number(node.maxLength) ?? Number.POSITIVE_INFINITY));
			// bytesCheck已保证Uint8Array类型，标type已覆盖。
			typeInGroup = true;
			// 其他类型/多类型进入各类group构建。
		} else {
			// 单一string才严格要求字符串，其他情况字符串关键字不约束别的值类别。
			const string = this.stringGroup(node, single === "string");
			// 确实构造出字符串检查才追加。
			if (string !== undefined) parts.push(string);
			// numeric只表单一number/integer，用于后面判断type是否已合并。
			const numeric = single === "number" || single === "integer";
			// mode1数字、2整数、0宽松，局部number变量名不调用Number转换，也不做取整。
			const number = this.numberGroup(node, single === "number" ? 1 : single === "integer" ? 2 : 0);
			// 有实际数值界限才追加group；纯type可留给共享叶。
			if (number !== undefined) parts.push(number);
			// 同理单一object让objectGroup严格，否则对象关键词只管对象。
			const object = this.objectGroup(node, base, single === "object");
			// 对象group存在才追加。
			if (object !== undefined) parts.push(object);
			// 数组group可把type/length/items合并。
			const array = this.arrayGroup(node, base, single === "array");
			// 数组group存在才追加。
			if (array !== undefined) parts.push(array);
			// 只有与single相符且确实生成group才说明type已经检查。
			typeInGroup =
				// 严格字符串group覆盖string类型要求。
				(single === "string" && string !== undefined) ||
				// 数字/整数group覆盖其单类型要求。
				(numeric && number !== undefined) ||
				// 对象group覆盖object要求。
				(single === "object" && object !== undefined) ||
				// 数组group覆盖array要求。
				(single === "array" && array !== undefined);
		}
		// 还没融合type时放到最前，先拒绝错误类别再跑其他关键词；多类型也走此处。
		if (types !== undefined && !typeInGroup) parts.unshift(typeCheck(types));
		// 追加enum/const/组合/引用等不专属某个类别的规则。
		this.inPlace(node, base, parts);
		// and按parts数量选择最小闭包/短路循环。
		return and(parts);
	}

	// The keywords that apply to the value itself, whatever its type.
	// inPlace把适用于整值的断言追加parts，例const、allOf、if、引用；原地改的是编译数组，不改schema/用户值，无IO。
	private inPlace(node: SchemaObject, base: string, parts: Check[]): void {
		// enum为数组才编枚举，其他未知形状此处忽略。
		if (Array.isArray(node.enum)) parts.push(enumCheck(node.enum));
		// const用自有键存在性，const:undefined也算提供，而非用truthy判断。
		if (Object.hasOwn(node, "const")) parts.push(constCheck(node.const));
		// allOf每支编普通check，再合成全都通过。
		if (Array.isArray(node.allOf)) parts.push(and(node.allOf.map((s) => this.check(s, base))));
		// anyOf选择可优化联合，false表示非恰一要求。
		if (Array.isArray(node.anyOf)) parts.push(this.union(node.anyOf, base, false));
		// oneOf传true，要求恰一支。
		if (Array.isArray(node.oneOf)) parts.push(this.union(node.oneOf, base, true));
		// not只要不是undefined就编，false/true schema仍有效。
		if (node.not !== undefined) parts.push(notCheck(this.check(node.not, base)));
		// 普通路径无then/else的if不独立增加断言；账本路径会保留成功if的位置贡献。
		if (node.if !== undefined && (node.then !== undefined || node.else !== undefined)) {
			// 缺then视恒通过，不需要编undefined。
			const then = node.then === undefined ? ALWAYS : this.check(node.then, base);
			// 缺else也视恒通过。
			const otherwise = node.else === undefined ? ALWAYS : this.check(node.else, base);
			// 编条件再与两侧布尔组合，运行时只执行选中侧。
			parts.push(ifCheck(this.check(node.if, base), then, otherwise));
		}
		// 普通$ref与同级断言叠加（draft7已在build提前返回）。
		if (typeof node.$ref === "string") parts.push(this.ref(node.$ref, base));
		// 非draft7才识别字符串$dynamicRef。
		if (this.draft !== "7" && typeof node.$dynamicRef === "string") {
			// 追加动态引用检查，可能抛RESTART要求重建Compiler。
			parts.push(this.dynamicRef(node.$dynamicRef, base));
		}
	}

	// union先试纯const枚举，再试对象标签分支，最后普通any/oneOf。例kind互斥联合仅验选中分支，不额外扫描全部；优化失败undefined才回退。
	private union(branches: readonly unknown[], base: string, exactlyOne: boolean): Check {
		// checks是编译时惰性工厂，只有需要末级回退才map编所有分支；返回的检查仍由各工厂决定捕获项。
		const checks = () => branches.map((s) => this.check(s, base));
		// 下面??链按顺序选首个非null/undefined函数，不在用户输入上再挑优化器。
		return (
			// 纯const且适合时直接enumCheck。
			constUnion(branches, exactlyOne) ??
			// 否则找必填互斥const标签。
			this.tagged(branches, base) ??
			// 都不适合时编每支，exactlyOne选择恰一或任一。
			(exactlyOne ? oneCheck(checks()) : anyCheck(checks()))
		);
	}

	// ref先寻址再编目标，跨资源且dynamic时加scope。例#/$defs/Name共用目标对象的check，未找到默认抛错或按Resolver选项回退false，无HTTP。
	private ref(ref: string, base: string): Check {
		// 定位目标节点及其base，可能触发延迟索引。
		const target = this.r.resolve(ref, base);
		// 递归交check，缓存/间接槽处理循环引用的编译，不代表自动防循环用户数据。
		const check = this.check(target.node, target.base);
		// 仅dynamic且目标base改变才在引用边再包scope；目标资源自身也可能有资源根包装。
		return this.dynamic && target.base !== base ? scopedCheck(this.scope, target.base, check) : check;
	}

	// dynamicRef仅对bookended动态锚点运行scope查找，否则退普通ref；例扩展树资源先进入scope，再按锚点选择重载规则。
	private dynamicRef(ref: string, base: string): Check {
		// 解析初始目标/名字，可能触发重启哨兵。
		const resolved = this.bookended(ref, base);
		// 不是动态锚点名字场景就按静态引用编译。
		if (resolved === undefined) return this.ref(ref, base);
		// 解构初始目标与锚点名。
		const { initial, name } = resolved;
		// 预编初始目标作没有动态候选时的回退。
		const fallback = this.check(initial.node, initial.base);
		// 用泛型lookup缓存各资源的该锚点check；箭头捕获this，所以此类闭包会保留Compiler。
		const lookup = this.dynamicLookup(name, (node, b) => this.check(node, b));
		// 保存同一scope数组供运行读取，不是初始空数组的快照。
		const scope = this.scope;
		// 每次用户值校验时运行此闭包。
		return (v) => {
			// 从栈下标0往后查，即先较外层资源，不是从末尾逆查最近项。
			for (let i = 0; i < scope.length; i++) {
				// 查这个资源是否声明同名动态锚点，结果可缓存null。
				const check = lookup(scope[i]);
				// 找到即执行并返回，不继续试其他资源，即使该检查false也不回退别支。
				if (check !== null) return check(v);
			}
			// 所有资源都没有候选才用最初静态目标。
			return fallback(v);
		};
	}

	/** The initial target and anchor name of a `$dynamicRef` that resolves dynamically, or undefined for a plain ref. */
	// bookended确定$dynamicRef初始目标恰由同名$dynamicAnchor声明；例#node匹配node可动态替换，JSON Pointer引用仍静态。首次无动态支持时抛精确RESTART而非返回失败check。
	private bookended(
		// 原始引用文字。
		ref: string,
		// 当前资源基准。
		base: string,
		// 返回带初始Resolved/名字的对象，或undefined表普通ref；这一联合是TS声明，不加运行schema验证。
	): { initial: { node: unknown; base: string }; name: string } | undefined {
		// 先用正常引用解析，失效引用按Resolver策略处理。
		const initial = this.r.resolve(ref, base);
		// 完整URI用于提取#后名字。
		const uri = resolveUri(ref, base);
		// 按去fragment后的长度切片，没有额外decodeURIComponent，因此不要声称所有编码名字都会被归成同一锚点名。
		const name = uri.slice(documentOf(uri).length + 1);
		// 初始目标必须规则对象且$dynamicAnchor和名字严格相等。
		const anchored = isSchemaObject(initial.node) && initial.node.$dynamicAnchor === name;
		// 空片段、Pointer片段或不匹配锚点都退普通引用。
		if (name === "" || name.startsWith("/") || !anchored) return undefined;
		// 需要动态而当前关闭，抛哨兵让外层丢弃这次半完成编译并重来。
		if (!this.dynamic) throw RESTART;
		// 已启动态则返回定位信息。
		return { initial, name };
	}

	// Resolved at run time against the dynamic scope, so a schema with a bookended $dynamicRef keeps its compiler.
	// dynamicLookup通用于普通/带账本函数，按资源URI缓存同名动态锚点的已编结果或null；例某URI没有node锚点，下次直接复用null。运行时闭包捕获Compiler，缓存非跨实例全局。
	private dynamicLookup<T>(name: string, compile: (node: SchemaObject, base: string) => T): (uri: string) => T | null {
		// Map强持有本次查找结果，T是泛型函数等类型，null专门代表没有目标。
		const found = new Map<string, T | null>();
		// 返回接URI的查询闭包，按需编之前没见过的候选。
		return (uri) => {
			// 资源地址加#锚点名构成表键。
			const key = `${uri}#${name}`;
			// 缓存可能undefined（没查过）或null（已知没目标），两者区别很重要。
			let check = found.get(key);
			// 没查过才读Resolver动态锚点并调用compile。
			if (check === undefined) {
				// 不在此联网/重新遍历整个schema，只读已索引动态表。
				const target = this.r.dynamicAnchors.get(key);
				// 没有目标存null，有目标用其已索引base编；??保留存在的基准字符串。
				check = target === undefined ? null : compile(target, this.r.baseOf.get(target) ?? uri);
				// 记结果，下次少做查表/编译；编译抛错时不会执行set。
				found.set(key, check);
			}
			// 返回T或null给scope循环。
			return check;
		};
	}

	/** anyOf/oneOf whose branches are all objects with a distinct required const on one key: the tag picks the branch. */
	// tagged尝试对象必填const互斥标签优化；例kind=text/image。先规范纯$ref分支用于找标签，再编原分支保留全部断言，不适合就undefined退通用联合。
	private tagged(branches: readonly unknown[], base: string): Check | undefined {
		// 少于两支没有分支选择收益，放弃。
		if (branches.length < 2) return undefined;
		// 收集用于判断标签的对象节点。
		const resolved: SchemaObject[] = [];
		// 逐分支检查优化前提。
		for (const branch of branches) {
			// 非对象规则放弃，布尔分支不适合此优化。
			if (!isSchemaObject(branch)) return undefined;
			// $ref读到字符串且Object.keys(branch).length为1才先解引用；普通JSON的典型形状是纯{$ref}，这里没另证$ref就是那个自有可枚举键。
			const ref = typeof branch.$ref === "string" && Object.keys(branch).length === 1 ? branch.$ref : undefined;
			// 纯引用按该分支基准解析，否则直接使用分支本身。
			const node = ref === undefined ? branch : this.r.resolve(ref, this.r.baseFor(branch, base)).node;
			// 目标不是规则对象就不能找对象标签。
			if (!isSchemaObject(node)) return undefined;
			// 保持与原branches相同次序。
			resolved.push(node);
		}
		// 以第一支properties的字段名作为候选标签集合。
		const first = resolved[0].properties;
		// 没有对象字段表就放弃。
		if (!isSchemaObject(first)) return undefined;
		// 逐字段试能否在每支都找到互斥必填const。
		for (const key of Object.keys(first)) {
			// tagOf检查单个分支的对象type/required/const条件。
			const tags = resolved.map((s) => tagOf(s, key));
			// 任一缺标签或Set去重后少于分支数就试下一个字段；使用JS Set相等语义。
			if (tags.some((t) => t === undefined) || new Set(tags).size !== tags.length) continue;
			// 找到互斥标签即可构建按标签选一支的检查。
			return taggedCheck(
				// 标签字段名。
				key,
				// 每支对应的常量标签值。
				tags,
				// 仍编原branches，保留引用/同级断言，不只验证标签字段。
				branches.map((s) => this.check(s, base)),
			);
		}
		// 所有字段都不适合则退通用联合。
		return undefined;
	}

	// stringGroup收集字符串专属约束并选stringCheck；例minLength+pattern合为一函数。无约束undefined，把纯type留给外层；正则在此编译，format回调留到实际校验，异常可传播。
	private stringGroup(node: SchemaObject, strict: boolean): Check | undefined {
		// number helper只取typeof number，缺/其他形状默认最少0，不严格检验所有schema数值合法性。
		const min = number(node.minLength) ?? 0;
		// 最大长度默认Infinity。
		const max = number(node.maxLength) ?? Number.POSITIVE_INFINITY;
		// pattern字符串才编共享正则；坏正则两种标志均失败可抛SyntaxError。
		const re = typeof node.pattern === "string" ? sharedRegex(node.pattern) : undefined;
		// 格式回调是否采用取决于下面三项条件。
		const format =
			// 有显式格式表、format是字符串、且表有自有条目才采用。
			this.formats !== undefined && typeof node.format === "string" && Object.hasOwn(this.formats, node.format)
				? // 直接取已注册回调原引用。
					this.formats[node.format]
				: // 否则format仅元数据，不自动加载标准库。
					undefined;
		// 全默认且无re/format时没有独立字符串断言，返回undefined。
		if (min === 0 && max === Number.POSITIVE_INFINITY && re === undefined && format === undefined) return undefined;
		// 构造严格/宽松字符串检查，具体码点长度与短路规则在checks.ts。
		return stringCheck(strict, min, max, re, format);
	}

	// numberGroup只在有数值约束时构造group，mode带类型语义；例纯type:integer不额外创建界限闭包，而minimum则合并数字判断。
	private numberGroup(node: SchemaObject, mode: 0 | 1 | 2): Check | undefined {
		// 含端点下界，只识别JS number。
		const min = number(node.minimum);
		// 含端点上界。
		const max = number(node.maximum);
		// 不含端点下界。
		const xmin = number(node.exclusiveMinimum);
		// 不含端点上界。
		const xmax = number(node.exclusiveMaximum);
		// 倍数约束，不在这里转换字符串数字。
		const multipleOf = number(node.multipleOf);
		// 所有都undefined时省掉group，不用truthy排掉0。
		if ([min, max, xmin, xmax, multipleOf].every((x) => x === undefined)) return undefined;
		// Infinity作为默认无上界/下界数值。
		const inf = Number.POSITIVE_INFINITY;
		// 传默认开闭界限给numberCheck；启用该组时非有限输入的行为需看比较，不能等同裸typeof number。
		return numberCheck(mode, min ?? -inf, max ?? inf, xmin ?? -inf, xmax ?? inf, multipleOf);
	}

	// objectGroup组织对象专属规则：仅核心字段走单闭包，复杂关键字用外层类别guard再串多个check。例有propertyNames时不在每个子check重复判断对象。
	private objectGroup(node: SchemaObject, base: string, strict: boolean): Check | undefined {
		// 每个额外关键字都undefined才叫onlyCore；显式false/空数组也会使它走复杂分支。
		const onlyCore = OBJECT_EXTRAS.every((k) => node[k] === undefined);
		// A schema with only the core object keywords gets one closure that also does the type guard.
		// 仅核心时把严格/宽松类别guard合入core；复杂时core为NONE，由末尾guardObject统一分流。
		const core = this.objectCore(node, base, onlyCore ? (strict ? GUARD_STRICT : GUARD_LOOSE) : GUARD_NONE);
		// 成功构造纯core直接返回，省parts和额外包装。
		if (core !== undefined && onlyCore) return core;
		// 有core就当第一项，没core从空数组开始。
		const parts: Check[] = core === undefined ? [] : [core];
		// propertyNames存在就编字段名规则。
		if (node.propertyNames !== undefined) parts.push(propertyNamesCheck(this.check(node.propertyNames, base)));
		// 取字段数下界。
		const minProperties = number(node.minProperties);
		// 取字段数上界。
		const maxProperties = number(node.maxProperties);
		// 至少提供一界就增加计数约束。
		if (minProperties !== undefined || maxProperties !== undefined) {
			// 默认0..Infinity，不修改用户字段或补默认值。
			parts.push(propertyCountCheck(minProperties ?? 0, maxProperties ?? Number.POSITIVE_INFINITY));
		}
		// 收集触发键/必需键名列表；TS元组不在运行时检查每个数组元素都是string。
		const dependentRequired: [string, string[]][] = [];
		// 收集触发键/整对象schema检查。
		const dependentSchemas: [string, Check][] = [];
		// 新dependentRequired/dependentSchemas仅2020-12普通路径采用。
		if (this.draft !== "7") {
			// entries只把对象形状映射转条目。
			// 仅数组值加入required依赖，这里没额外逐元素过滤字符串。
			for (const [k, list] of entries(node.dependentRequired))
				if (Array.isArray(list)) dependentRequired.push([k, list]);
			// 每个dependentSchemas节点编普通check。
			for (const [k, s] of entries(node.dependentSchemas)) dependentSchemas.push([k, this.check(s, base)]);
		}
		// 旧dependencies在此不论draft都会读取。
		for (const [k, d] of entries(node.dependencies)) {
			// 数组值按键依赖。
			if (Array.isArray(d)) dependentRequired.push([k, d]);
			// 非数组值按整对象schema编译，非法节点可抛错。
			else dependentSchemas.push([k, this.check(d, base)]);
		}
		// 有字段依赖才加相关闭包。
		if (dependentRequired.length > 0) parts.push(dependentRequiredCheck(dependentRequired));
		// 有schema依赖才加整对象触发检查。
		if (dependentSchemas.length > 0) parts.push(dependentSchemasCheck(dependentSchemas));
		// 完全无对象断言时，严格返回对象叶函数，宽松undefined省约束。
		if (parts.length === 0) return strict ? IS_OBJECT : undefined;
		// 将parts合取后包一次对象类型分流。
		return guardObject(and(parts), strict);
	}

	// objectCore把properties/required/pattern/additional编成扁平字段表；例path必填str用叶代码+REQUIRED标志。简单闭对象走declaredObject，复杂模式/额外必填走openObject。
	private objectCore(node: SchemaObject, base: string, guard: Guard): Check | undefined {
		// properties仅对象外形采用，其他视空表，不全量验证schema定义。
		const properties = isSchemaObject(node.properties) ? node.properties : {};
		// required必须数组，且这里过滤成字符串列表；不在此去重。
		const required = Array.isArray(node.required) ? node.required.filter((k) => typeof k === "string") : [];
		// patternProperties非对象形状视空表。
		const patterns = isSchemaObject(node.patternProperties) ? node.patternProperties : {};
		// 读取additional原值，false与undefined语义不同。
		const additional = node.additionalProperties;
		// 自有可枚举属性名列表，不包括symbol/继承字段。
		const keys = Object.keys(properties);
		// 模式名字列表，用来编正则。
		const patternKeys = Object.keys(patterns);
		// 下面判断有没有任何核心对象约束。
		if (
			// 无声明/必填/模式字段。
			keys.length + required.length + patternKeys.length === 0 &&
			// 且额外属性没限制或显式true。
			(additional === undefined || additional === true)
		) {
			// 此时core不必建函数，类别要求由objectGroup处理。
			return undefined;
		}
		// One array per object: key, check, flags (leaf code, required, key also names an Object.prototype member).
		// 扁平数组每字段3槽，不为每个字段另建三元组对象。
		const entries: unknown[] = [];
		// 按properties键序编每个字段。
		for (const k of keys) {
			// 子规则check可能直接共享叶函数。
			const check = this.check(properties[k], base);
			// flags把下面三部分做位或合并。
			const flags =
				// 叶函数身份可映代码，否则0表示真正调用函数。
				(LEAF_CODES.get(check) ?? 0) |
				// required含此名则加REQUIRED位。
				(required.includes(k) ? REQUIRED : 0) |
				// 名字是Object.prototype成员则加INHERITED位，openObject可据此额外判断自有键。
				(k in Object.prototype ? INHERITED : 0);
			// 依次存名字/函数/标志，checks.ts按同布局读；unknown[]不在运行验证布局。
			entries.push(k, check, flags);
		}
		// required中没在properties自有键声明的名字，后面只查存在性。
		const extraRequired = required.filter((k) => !Object.hasOwn(properties, k));
		// 每个模式编共享正则+子check，as const把元组保成只读精确位置类型，不冻结运行数组。
		const pats = patternKeys.map((p) => [sharedRegex(p), this.check(patterns[p], base)] as const);
		// additional缺失/true不增加逐项check，其他包括false都编；账本路径保留显式true以记录覆盖。
		const extra = additional === undefined || additional === true ? undefined : this.check(additional, base);
		// 没有模式/额外必填且额外策略为无检查或全拒绝，适合简单快路径。
		if (pats.length === 0 && extraRequired.length === 0 && (extra === undefined || additional === false)) {
			// 只数已声明字段里属于required的数量；required重复名字不重复增加这里计数。
			const requiredCount = keys.filter((k) => required.includes(k)).length;
			// closed仅在additional严格false时true；其他入口已经筛选适用条件。
			return declaredObject(entries, requiredCount, additional === false, guard);
		}
		// 其他情形交openObject处理所有模式及额外必填规则。
		return openObject(entries, keys, extraRequired, pats, extra, guard);
	}

	// arrayGroup兼容旧items元组和2020-12 prefixItems，再选合并listCheck或分项组合；例prefix只限已有位置，minItems才要求足够项。
	private arrayGroup(node: SchemaObject, base: string, strict: boolean): Check | undefined {
		// 前缀默认空，readonly只管类型层不冻结输入规则。
		let prefix: readonly unknown[] = [];
		// rest默认undefined，没有后续约束。
		let rest: unknown;
		// items为数组时使用旧元组结构，这里不限draft7才识别它。
		if (Array.isArray(node.items)) {
			// 每位置子规则取items数组。
			prefix = node.items;
			// 后续项由additionalItems决定。
			rest = node.additionalItems;
			// 非数组items走新前缀/统一items语义。
		} else {
			// 非draft7且prefixItems是数组才采用该前缀。
			if (this.draft !== "7" && Array.isArray(node.prefixItems)) prefix = node.prefixItems;
			// 后续规则从items取，可能true/false/undefined。
			rest = node.items;
		}
		// 编每个前缀位置的普通check。
		const prefixChecks = prefix.map((s) => this.check(s, base));
		// 普通路径省掉true后续检查，false变NEVER；与账本版显式true覆盖记录不同。
		const restCheck = rest === undefined || rest === true ? undefined : this.check(rest, base);
		// 数组长度下界，只采用number。
		const minItems = number(node.minItems);
		// 长度上界。
		const maxItems = number(node.maxItems);
		// 下面挑常见数组合并快路径。
		if (
			// 没有contains计数规则。
			node.contains === undefined &&
			// 没有显式uniqueItems:true去重规则。
			node.uniqueItems !== true &&
			// 且确有prefix/rest逐项约束。
			(prefixChecks.length > 0 || restCheck !== undefined)
		) {
			// The common array: one closure for the guard, the length bounds and the items.
			// 单一array严格，其他情况宽松，合并进listCheck。
			const guard = strict ? GUARD_STRICT : GUARD_LOOSE;
			// 一个闭包检查类别、长度、前缀和后续，避免层层重复调用。
			return listCheck(guard, minItems ?? 0, maxItems ?? Number.POSITIVE_INFINITY, prefixChecks, restCheck);
		}
		// 复杂组合从空parts收集。
		const parts: Check[] = [];
		// 有前缀/后续才增加逐项检查。
		if (prefixChecks.length > 0 || restCheck !== undefined) parts.push(itemsCheck(prefixChecks, restCheck));
		// 有长度界限才增加lengthCheck。
		if (minItems !== undefined || maxItems !== undefined) {
			// 上下界默认0/Infinity。
			parts.push(lengthCheck(minItems ?? 0, maxItems ?? Number.POSITIVE_INFINITY));
		}
		// contains存在就编候选项计数。
		if (node.contains !== undefined) {
			// draft7最少固定1，2020-12采用minContains或默认1。
			const min = this.draft === "7" ? 1 : (number(node.minContains) ?? 1);
			// 最大命中数由后面的三元选。
			const max =
				// draft7不采用maxContains，默认无上限；新draft读number值。
				this.draft === "7" ? Number.POSITIVE_INFINITY : (number(node.maxContains) ?? Number.POSITIVE_INFINITY);
			// 编contains的子schema再交计数工厂。
			parts.push(containsCheck(this.check(node.contains, base), min, max));
		}
		// uniqueItems只有严格true才启用，两两深比较，不做实际去重。
		if (node.uniqueItems === true) parts.push(uniqueCheck);
		// 无约束返回严格数组叶或宽松undefined。
		if (parts.length === 0) return strict ? IS_ARRAY : undefined;
		// 多项合取后只包一次数组类别guard。
		return guardArray(and(parts), strict);
	}

	/** The annotating check of a schema evaluated in place (only below `unevaluatedProperties`/`unevaluatedItems`). */
	// annotating是位置跟踪版check：独立缓存/递归槽→buildAnnotating；例anyOf成功分支都要给父级unevaluated*贡献位置，不用普通首成功短路联合替代。
	annotating(node: unknown, base: string): AnnotatingCheck {
		// true schema恒通过但不自动声明所有位置已覆盖。
		if (node === true) return ANNOTATING_TRUE;
		// false schema恒失败。
		if (node === false) return ANNOTATING_FALSE;
		// unknown规则对象外形检查，语义同普通check。
		if (!isSchemaObject(node))
			// 不是对象/布尔就抛错，报错JSON编码自身也可抛错。
			throw new Error(`A schema must be an object or a boolean, got ${JSON.stringify(node)}`);
		// 独立按对象身份缓存，避免和普通Check混用。
		const cached = this.annotatingCache.get(node);
		// 已有带记录函数直接返回。
		if (cached !== undefined) return cached;
		// 先声明可晚填的AnnotatingCheck槽。
		const slot: { check: AnnotatingCheck | undefined } = { check: undefined };
		// 先缓存间接函数，让递归子schema编译可返回到当前节点。
		this.annotatingCache.set(node, indirectAnnotating(slot));
		// 按节点base完整编带记录规则。
		const check = this.buildAnnotating(node, this.r.baseFor(node, base));
		// 补槽供先前递归引用使用。
		slot.check = check;
		// 后续普通命中改成完整函数，省间接层。
		this.annotatingCache.set(node, check);
		// 返回仍需(value,a)的检查，不在此为每个值建账本。
		return check;
	}

	// buildAnnotating将普通断言与需记位置关键字拆开：plain先跑，再按固定顺序parts，含自身unevaluated时隔离账本，最后可包动态scope。
	private buildAnnotating(node: SchemaObject, base: string): AnnotatingCheck {
		// 普通对象字典存其他关键字，只浅赋原引用，不是深克隆/schema消毒。
		const rest: Record<string, unknown> = {};
		// 标记是否发现任一需位置处理的关键字。
		let annotates = false;
		// 这里只取自有可枚举键，与bareType的for...in范围不同。
		for (const k of Object.keys(node)) {
			// 在ANNOTATING集合里的字段从普通部分移出，交后面的带位置工厂。
			if (ANNOTATING.has(k)) annotates = true;
			// 其他字段留给plain，例如type/required/minItems/not等；对象普通赋值保留原实现语义。
			else rest[k] = node[k];
		}
		// 编普通部分，不把需记位置的同一关键字再验一遍。
		const plain = this.plain(rest, base);
		// 顺序保存带记录检查。
		const parts: AnnotatingCheck[] = [];
		// 确有相关关键字才建相应parts。
		if (annotates) this.annotatingParts(node, base, parts);
		// 没有parts则适配普通check；否则先普通后带记录合取。false路径的账本是否发布由隔离层决定。
		const all = parts.length === 0 ? ignoreAnnotations(plain) : annotateAll(plain, parts);
		// own决定此schema是否要独立于父兄弟的记录。
		const own =
			// 自身明确unevaluatedProperties/Items才隔离。
			node.unevaluatedProperties !== undefined || node.unevaluatedItems !== undefined
				? // 新私有账本运行整个schema，成功才合到父a，避免看见父兄弟已覆盖位置。
					isolateAnnotations(all)
				: // 无自身unevaluated则沿用父传入的a累积。
					all;
		// 动态资源根再包scope，带记录签名仍同时传a。
		return this.dynamic && this.r.isResource(node, base) ? scopedAnnotating(this.scope, base, own) : own;
	}

	// annotatingParts按对象→数组→all/any/one→if→引用→依赖→unevaluated顺序建记录项；最后两项必须在前面收齐覆盖后运行。例anyOf两个成功对象分支可共同放行a/b键。
	private annotatingParts(node: SchemaObject, base: string, parts: AnnotatingCheck[]): void {
		// 下面任一对象关键字出现就需要对象位置检查。
		if (
			// properties可记具名字段。
			node.properties !== undefined ||
			// patternProperties可记全部命中的键。
			node.patternProperties !== undefined ||
			// additionalProperties显式true也要记剩余键。
			node.additionalProperties !== undefined
		) {
			// 字段子值用普通check验证，记录的是父对象的字段名，不把子值账本混进父值。
			const props = entries(node.properties).map(([k, s]) => [k, this.check(s, base)] as const);
			// 正则与子check按只读元组组织；模式可多条同时命中。
			const pats = entries(node.patternProperties).map(([p, s]) => [sharedRegex(p), this.check(s, base)] as const);
			// 额外字段规则与未提供做明确区分。
			const extra =
				// 只有undefined省略；true编ALWAYS，告诉annotateObject这些额外字段也算已求值。
				node.additionalProperties === undefined ? undefined : this.check(node.additionalProperties, base);
			// 追加对象带位置检查，实际类型不对时工厂宽松通过，type由plain控制。
			parts.push(annotateObject(props, pats, extra));
		}
		// prefix/items/contains任一提供才组织数组位置信息。
		if (node.prefixItems !== undefined || node.items !== undefined || node.contains !== undefined) {
			// 先看新式prefixItems是否真数组。
			const prefix = Array.isArray(node.prefixItems)
				? // 是则优先新前缀。
					node.prefixItems
				: // 否则看旧items是否数组。
					Array.isArray(node.items)
					? // 旧元组作为前缀。
						node.items
					: // 都没有前缀用空列表。
						[];
			// 旧items数组用additionalItems作rest，否则items本身作rest。
			const rest = Array.isArray(node.items) ? node.additionalItems : node.items;
			// 把这一组作为一条parts项。
			parts.push(
				// 数组账本工厂接下列5个参数。
				annotateArray(
					// 每个前缀值交普通check验证，父账本只记前缀长度。
					prefix.map((s) => this.check(s, base)),
					// 显式rest:true仍转ALWAYS，之后标allItems，与普通arrayGroup的省略true不同。
					rest === undefined ? undefined : this.check(rest, base),
					// contains有提供才编，检查每项通过时记离散下标。
					node.contains === undefined ? undefined : this.check(node.contains, base),
					// 默认至少命中1，number取到0时保留0。
					number(node.minContains) ?? 1,
					// 默认最多Infinity。
					number(node.maxContains) ?? Number.POSITIVE_INFINITY,
				),
			);
		}
		// allOf每支都按带位置规则追加，按顺序合取；不是创建分支私有账本后无条件合并。
		if (Array.isArray(node.allOf)) for (const s of node.allOf) parts.push(this.annotating(s, base));
		// anyOf必须数组才构造。
		if (Array.isArray(node.anyOf))
			// 追加由下面工厂构造的一条检查。
			parts.push(
				// annotateAny要遍历全部分支，收成功分支位置。
				annotateAny(
					// 每支递归annotating，保持子schema自己的隔离语义。
					node.anyOf.map((s) => this.annotating(s, base)),
					// false表示至少一支，不要求恰一支。
					false,
				),
			);
		// oneOf同样先确认数组。
		if (Array.isArray(node.oneOf))
			// 追加带记录的恰一联合。
			parts.push(
				// 复用annotateAny的计数/合并机制。
				annotateAny(
					// 每个oneOf子schema独立编带记录函数。
					node.oneOf.map((s) => this.annotating(s, base)),
					// true表示末尾恰一支通过；多支成功最后失败时工厂内部不自动撤销已合的a。
					true,
				),
			);
		// 即便没有then/else，if成功也可贡献覆盖位置，所以不能照普通inPlace省略它。
		if (node.if !== undefined) {
			// 缺then保留undefined，annotateIf自己按通过处理。
			const then = node.then === undefined ? undefined : this.annotating(node.then, base);
			// 缺else同理。
			const otherwise = node.else === undefined ? undefined : this.annotating(node.else, base);
			// 条件私有账本、选中分支与合并细节在annotateIf中实现。
			parts.push(annotateIf(this.annotating(node.if, base), then, otherwise));
		}
		// 字符串静态引用用带记录目标，位置可贡献给当前位置父账本。
		if (typeof node.$ref === "string") parts.push(this.annotatingRef(node.$ref, base));
		// 动态引用同理，但运行时scope选择可能保留Compiler。
		if (typeof node.$dynamicRef === "string") parts.push(this.annotatingDynamicRef(node.$dynamicRef, base));
		// dependentSchemas触发键存在才验整值及贡献位置，不自动把触发键标已覆盖。
		for (const [k, s] of entries(node.dependentSchemas)) parts.push(annotateDependent(k, this.annotating(s, base)));
		// 剩余对象属性规则最后处理。
		if (node.unevaluatedProperties !== undefined) {
			// 值检查用普通Check，unevaluatedProperties工厂负责跳已记录键并标allProps。
			parts.push(unevaluatedProperties(this.check(node.unevaluatedProperties, base)));
		}
		// 剩余数组项目同样最后，用父账本前缀/离散下标跳过已覆盖项。
		if (node.unevaluatedItems !== undefined) parts.push(unevaluatedItems(this.check(node.unevaluatedItems, base)));
	}

	// annotatingRef与ref同样寻址/可包scope，但传递同一个当前位置账本；例$ref指到声明字段规则，成功字段可供外层unevaluated*看到。
	private annotatingRef(ref: string, base: string): AnnotatingCheck {
		// 先解析目标/基准，按Resolver策略处理失效引用。
		const target = this.r.resolve(ref, base);
		// 递归编目标带位置函数。
		const check = this.annotating(target.node, target.base);
		// 跨资源且dynamic时加带账本scope包装，正常路径push/check/pop。
		return this.dynamic && target.base !== base ? scopedAnnotating(this.scope, target.base, check) : check;
	}

	// annotatingDynamicRef保留动态锚点选择及位置贡献；例扩展树覆写节点规则后仍把其成功检查覆盖位置交回父a，未匹配资源才用初始目标。
	private annotatingDynamicRef(ref: string, base: string): AnnotatingCheck {
		// 先判断初始目标是否bookended，同样可能抛RESTART。
		const resolved = this.bookended(ref, base);
		// 非动态锚点情况按带记录静态引用编。
		if (resolved === undefined) return this.annotatingRef(ref, base);
		// 拿初始目标与锚点名。
		const { initial, name } = resolved;
		// 初始目标编成带账本回退函数。
		const fallback = this.annotating(initial.node, initial.base);
		// 泛型lookup的T此时为AnnotatingCheck；回调捕获this，动态Compiler继续存活。
		const lookup = this.dynamicLookup(name, (node, b) => this.annotating(node, b));
		// 引用同一scope数组，运行时观察压入的资源。
		const scope = this.scope;
		// 每次检查同时接用户值和父账本。
		return (v, a) => {
			// 从较外层scope起按顺序找。
			for (let i = 0; i < scope.length; i++) {
				// 查候选锚点函数或null。
				const check = lookup(scope[i]);
				// 首个目标立刻运行并返回，不因false改试下一资源。
				if (check !== null) return check(v, a);
			}
			// 无动态候选才回退初始目标，并传同一a。
			return fallback(v, a);
		};
	}
}

/** Keywords that never affect a check. */
// 中性关键字集合供bareType/constUnion判定，不表示关键字在所有上下文永远无影响：$defs可被引用，min/maxContains只有配contains才有断言作用。
export const NEUTRAL_KEYWORDS = new Set([
	// $schema不自动切换本次编译draft。
	"$schema",
	// $comment是说明文字。
	"$comment",
	// title元数据。
	"title",
	// description元数据。
	"description",
	// default不自动填输入。
	"default",
	// examples不作为实际校验用例自动执行。
	"examples",
	// deprecated仅提示。
	"deprecated",
	// readOnly不冻结/拒绝写值。
	"readOnly",
	// writeOnly不自动隐藏或脱敏输出。
	"writeOnly",
	// $defs中的规则只有被引用等实际使用时才影响当前值。
	"$defs",
	// 旧definitions同理。
	"definitions",
	// contentEncoding不触发自动解码。
	"contentEncoding",
	// contentMediaType不触发内容校验。
	"contentMediaType",
	// minContains没有contains时不单独约束数组。
	"minContains",
	// maxContains同理，和contains一起由array group读取。
	"maxContains",
	// $vocabulary不在此切换全部词汇表支持，已知兼容缺口见conformance测试。
	"$vocabulary",
]);

// The object keywords besides the core (properties, required, patternProperties, additionalProperties).
// 核心对象关键字之外需要单独检查的关键词清单，任一存在会走复杂对象组合。
const OBJECT_EXTRAS = [
	// 键名检查。
	"propertyNames",
	// 最少属性数。
	"minProperties",
	// 最多属性数。
	"maxProperties",
	// 新式键依赖。
	"dependentRequired",
	// 新式整对象依赖。
	"dependentSchemas",
	// 旧式合并依赖。
	"dependencies",
];

// The keywords an annotating check handles itself; every other keyword compiles into its plain part.
// 带求值账本路径负责的关键字清单，buildAnnotating把它们从plain部分移除，避免丢位置或重复执行。
const ANNOTATING = new Set([
	// 具名字段覆盖位置。
	"properties",
	// 模式字段覆盖位置。
	"patternProperties",
	// 额外字段覆盖位置。
	"additionalProperties",
	// 数组前缀位置。
	"prefixItems",
	// 数组通用/后续项目。
	"items",
	// 旧元组后续项目。
	"additionalItems",
	// contains命中下标。
	"contains",
	// contains最少命中数。
	"minContains",
	// contains最多命中数。
	"maxContains",
	// allOf子规则贡献。
	"allOf",
	// anyOf全部成功分支贡献。
	"anyOf",
	// oneOf成功分支及计数要求。
	"oneOf",
	// 条件成功位置贡献。
	"if",
	// then选中分支贡献。
	"then",
	// else选中分支贡献。
	"else",
	// 静态引用目标贡献。
	"$ref",
	// 动态引用目标贡献。
	"$dynamicRef",
	// 整对象依赖规则贡献。
	"dependentSchemas",
	// 剩余对象字段最后验证。
	"unevaluatedProperties",
	// 剩余数组项最后验证。
	"unevaluatedItems",
]);

/** anyOf/oneOf whose branches are all `{ const: primitive }`: an enum (distinct values make oneOf the same). */
// constUnion将全为单const加中性描述的联合降成enum；例anyOf:[{const:"a"},{const:"b"}]。oneOf只在候选无重复才可等价降级，否则undefined走通用计数。
function constUnion(branches: readonly unknown[], exactlyOne: boolean): Check | undefined {
	// 收集值，unknown并不先宣称是合法JSON基本值。
	const values: unknown[] = [];
	// 逐分支核对降级前提。
	for (const branch of branches) {
		// 必须对象且自有const键，否则放弃。
		if (!isSchemaObject(branch) || !Object.hasOwn(branch, "const")) return undefined;
		// 其他自有可枚举键只能中性；不是仅看到const就忽略其他断言。
		for (const k of Object.keys(branch)) if (k !== "const" && !NEUTRAL_KEYWORDS.has(k)) return undefined;
		// 非null对象常量不走此优化；函数等非JSON的非object值没有在此另外排除。
		if (typeof branch.const === "object" && branch.const !== null) return undefined;
		// oneOf重复候选会造成多支通过，故不能简单enum；includes用SameValueZero。
		if (exactlyOne && values.includes(branch.const)) return undefined;
		// 保留候选原值，不进行序列化/复制。
		values.push(branch.const);
	}
	// 全部适合才编枚举，空分支列表也会得到恒无匹配的enum检查。
	return enumCheck(values);
}

// The tag of a tagged-union branch: a primitive const on a required property of an object schema.
// tagOf取单支某键的必填基本const标签，供tagged优化；例{type:"object",required:["kind"],properties:{kind:{const:"text"}}}取text，条件不满足undefined。
function tagOf(branch: SchemaObject, key: string): unknown {
	// 先取字段表，后面再确认其对象形状。
	const properties = branch.properties;
	// 明确对象type、required数组且含此键才可认为标签是必需的。
	if (branch.type !== "object" || !Array.isArray(branch.required) || !branch.required.includes(key)) return undefined;
	// 字段表外形正确才取该字段规则，不主动寻址它内部的$ref。
	const tag = isSchemaObject(properties) ? properties[key] : undefined;
	// 标签规则需对象且自有const，否则undefined。
	if (!isSchemaObject(tag) || !Object.hasOwn(tag, "const")) return undefined;
	// 只排非null对象常量，保留null与其他非object；返回undefined也会被调用者当缺标签，不能把undefined当可优化标签。
	return typeof tag.const === "object" && tag.const !== null ? undefined : tag.const;
}

// number读取schema数值关键字，只判断typeof，不做字符串转数/有限性/非负整数检查；例0保留，"0"变undefined，具体约束范围需看检查工厂。
function number(value: unknown): number | undefined {
	// 三元返回原number或undefined，NaN/Infinity仍满足typeof，不能从此helper推断规则已全面合法。
	return typeof value === "number" ? value : undefined;
}

// entries把对象外形schema映射变成自有可枚举键值对，例properties→[字段名,规则]；非对象视空列表，不是输入用户对象转换。
function entries(value: unknown): [string, unknown][] {
	// isSchemaObject外形过滤后Object.entries，数组/null/基础值返回[]，不深验证每个条目。
	return isSchemaObject(value) ? Object.entries(value) : [];
}
