/**
 * 在真正校验前，尽量把模型工具参数等松散输入转成规则期望形状；Validator只有coerce:true才调用此实现。
 * 例obj({n:int(),extra:opt(str())})处理{n:"3.5",extra:null}：先删extra，再把n截成3，最后仍由check决定是否合法。
 * 第1轮可选null清理、第2轮按JSON Schema结构适配TypeBox转换规则、第3轮按type补基础转换，不能任意调换顺序。
 * 此文件是本库手写适配，不调用Value.Convert，也不同于它原地修改输入的API；常规JSON变化路径浅复制，保留未变引用。
 * 转换不是全面验证/消毒：unknown结果、规则引用、特殊原型/访问器、循环与用户回调边界按各函数说明，异常并非全部吞掉。
 */
// Coercion: turns a loosely typed value (a model's tool call arguments, form input, query strings) into the value a
// schema most likely meant, before it is checked. Only validators compiled with `{ coerce: true }` have it, and they
// build it on their first coerce() or parse(); the check path never runs it.
//
// Three passes, in this order:
// 1. Optional nulls: a `null` in an optional property whose schema rejects null is dropped, as if omitted.
// 2. Conversion rules ported from TypeBox 1.3.27's Value.Convert (MIT), keyed on JSON Schema structure (`$ref`, `const`,
//    `enum`, `anyOf`/`oneOf`, `allOf`, `type`, `items`/`prefixItems`, `properties`/`patternProperties`) instead of
//    TypeBox's kind marks: `null` becomes "null" for a string, `"3.5"` becomes 3 for an integer, a single value becomes
//    a one-item array, and a union takes the first branch whose conversion passes.
// 3. Primitive coercion by `type` (also type arrays), as in Ajv's `coerceTypes`: what pass 2 left, for example a type
//    array `["integer", "null"]`, or `""` for `null`.
// A value that cannot be coerced is left as it is; the check then reports it.
//
// Every pass is copy-on-write: an object or array is copied only when one of its members changes, so an unchanged
// value comes back as the same reference and the input is never modified. All passes walk the same keywords for
// members: `properties`, then `patternProperties`, then `additionalProperties` for keys neither names; tuple items by
// `prefixItems` (or a draft-7 `items` array), the rest by `items`. Draft 7's `additionalItems` is not coerced.

// Compiler只作类型导入，但实例会保存在c并用于检查转换候选；import type本身不加载Compiler实现。
import type { Compiler } from "./compiler.ts";
// schema节点外形守卫，排null/数组，不完整校验schema或对象原型。
import { isSchemaObject } from "./resolver.ts";
// patternProperties复用预编共享正则，不为每个字段反复new。
import { sharedRegex } from "./shared.ts";
// SchemaObject的字段保持unknown，关键字读取处再判形状。
import type { SchemaObject } from "./types.ts";

/** Coerces values for one compiled schema. */
// Coercer保存一份规则和Compiler，按三轮尝试转换。例数字字段"3.5"可变3.5，整数可变3；返回unknown，不保证合法，parse随后check才定结果。它是本库适配实现，不直接调用TypeBox运行库。
export class Coercer {
	// 共享Compiler及其Resolver/格式回调，转换候选可借check验规则。
	private readonly c: Compiler;
	// 根规则未假定是合法对象，递归入口用unknown接着判形状；保存原引用不克隆。
	private readonly schema: unknown;
	/**
	 * The (schema node, value) pairs pass 2 is converting through a re-entry point, as a stack. Conversion can enter
	 * a node again with the same value only through a `$ref` or by wrapping a single value into an array (also for
	 * schemas that cycle through shared JS objects): a recursive schema that meets a value no branch accepts would
	 * convert it without end. A pair already on the stack (primitives by value, objects by reference) leaves the value
	 * unchanged. Only those two points push, so schemas without references or wraps pay nothing.
	 */
	// 扁平栈按[node,value]每次存两项，只在第二轮的$ref/单值包数组重入点使用，不是任意递归/循环值的通用visited表。
	private readonly entered: unknown[] = [];
	/** How often a re-entry was cut short in this coerce() call; results computed across one are not memoized. */
	// cuts统计本轮发现相同栈对而截断的次数，防把依赖截断的局部结果误当可复用memo。
	private cuts = 0;
	/**
	 * Results of `$ref` targets by (node, value) within one coerce() call: a recursive union whose branches all
	 * convert the same children (and all fail) would convert them once per branch, exponentially in the depth.
	 */
	// memo按目标对象→输入值→结果记单次第二轮的$ref转换，外层调用结束清；Map强持有但不是跨调用永久缓存。
	private memo: Map<object, Map<unknown, unknown>> | undefined = undefined;

	// 构造仅记Compiler/根规则，不立即转换/校验输入。例Validator首次coerce才new它，可在之后多次coerce复用实例，单次memo不跨调用。
	constructor(compiler: Compiler, schema: unknown) {
		// 保存同一个编译器，后面用它解析引用并验候选。
		this.c = compiler;
		// 保存规则原引用，readonly不深冻结它。
		this.schema = schema;
	}

	/** `value` coerced: a copy along the changed paths only, or `value` itself when nothing changes. */
	// coerce依次删可选null→结构/字面量转换→type基础转换；例{n:null,required:"2"}按字段规则删/转。通常变化路径复制、没变可原引用；访问器/format等用户代码副作用不在此回滚。
	coerce(value: unknown): unknown {
		// 从根的资源基准开始，不把输入字符串当文件路径读取。
		const base = this.c.r.rootBase;
		// 先清可选字段null，避免下一轮把原本可省的null转成"null"/0。
		const withoutNulls = this.dropOptionalNulls(value, this.schema, base);
		// 先convertOnly第二轮，再coerceTypes第三轮，顺序不可当成互不相关的并行map。
		return this.coerceTypes(this.convertOnly(withoutNulls), this.schema, base);
	}

	/** Pass 2 alone, as TypeBox's `Value.Convert` (the TypeBox conformance tests run it). */
	// convertOnly只运行第二轮供TypeBox兼容案例比较，正常或异常都清memo/cuts；例"3.5"按integer截3，不执行前置删null或第三轮。不是完整校验函数。
	convertOnly(value: unknown): unknown {
		// try/finally确保调用结束不把这次值的memo带到下次。
		try {
			// 从根与rootBase进入结构转换，返回值仍可能不合法。
			return this.convert(this.schema, this.c.r.rootBase, value);
			// finally无论成功/throw都运行，不代表吞掉异常。
		} finally {
			// 释放本次memo引用，实际内存回收由GC决定。
			this.memo = undefined;
			// 截断计数归零，entered栈由每层reenter自己的finally弹出。
			this.cuts = 0;
		}
	}

	/** `node` converted for `value` at a re-entry point: unchanged when that pair is already being converted. */
	// reenter在引用/单值包装处防相同(node,value)重入：先扫栈→可用memo→压栈转换→finally弹栈→无截断才缓存。例递归“数值或本类型数组”遇不可转换对象，避免无穷单值包装。
	private reenter(node: object, base: string, value: unknown, memoize: boolean): unknown {
		// 本地引用同一entered数组，下面原地push/缩短，不复制。
		const entered = this.entered;
		// 每步2读node/value一对。
		for (let i = 0; i < entered.length; i += 2) {
			// node按身份===，value用Object.is（NaN等于自身，+0/-0区分）；与下方Map键的SameValueZero口径不同。
			if (entered[i] === node && Object.is(entered[i + 1], value)) {
				// 发现当前栈已有这对，记录发生过截断。
				this.cuts++;
				// 保留原值停止这条转换重入，不把它当已经验证成功。
				return value;
			}
		}
		// 只有memoize为真才读memo，单值包数组场景传false不复用该缓存。
		const memo = memoize ? this.memo?.get(node) : undefined;
		// 先has再get，缓存结果本身可以是undefined，不能只凭get(undefined)判断没缓存。
		if (memo?.has(value)) return memo.get(value);
		// 记进入前cuts，完成后据是否变化决定能否memo。
		const cuts = this.cuts;
		// 入栈同一个规则对象和待转换值。
		entered.push(node, value);
		// 准备接结果，unknown要求后续仍按实际规则校验。
		let result: unknown;
		// try保护栈生命周期，不负责捕获/吞转换异常。
		try {
			// 递归执行第二轮convert。
			result = this.convert(node, base, value);
			// 即使递归throw也退出当前两槽栈记录。
		} finally {
			// 缩短数组2项，不按栈内对象内容重新查找。
			entered.length -= 2;
		}
		// 可缓存且期间未截断，才认为结果不依赖当前递归上下文。
		if (memoize && this.cuts === cuts) {
			// 第一次需要memo才分配外层Map。
			this.memo ??= new Map();
			// 找该schema目标对应的值表。
			let values = this.memo.get(node);
			// 没有表才创建。
			if (values === undefined) {
				// 值表键是unknown，基础值按Map相等规则，对象按身份。
				values = new Map();
				// 把新表挂到目标节点上。
				this.memo.set(node, values);
			}
			// 记本输入到结果，不深复制它；同次其他分支可复用。
			values.set(value, result);
		}
		// 返回结果，不将unknown断言成已合法类型。
		return result;
	}

	/** Whether `value` passes the schema `node`; undefined when `node` cannot be compiled. */
	// passes尝试编子规则并检查候选，true/false有效，任何异常返回undefined。例null能否被字段接受；不把undefined混同明确拒绝，catch也包括format/getter抛错，不只编译失败。
	private passes(node: unknown, base: string, value: unknown): boolean | undefined {
		// try覆盖编译及实际check调用两步。
		try {
			// 先按已索引base修正节点，再获取check并运行value。
			return this.c.check(node, this.baseOf(node, base))(value);
			// 任何抛错都进入无结论路径，此处不记录错误文字。
		} catch {
			// undefined表示没有得出可靠通过/拒绝，不是转换后的用户值。
			return undefined;
		}
	}

	// baseOf仅复用Resolver已索引地址，否则沿父base；例$ref已定位的子资源不用再次拼$id。它不主动索引整树或调用baseFor重新解析$id。
	private baseOf(node: unknown, base: string): string {
		// 对象外形才查baseOf Map，??表示没条目用传入base；布尔/其他节点也沿base。
		return isSchemaObject(node) ? (this.c.r.baseOf.get(node) ?? base) : base;
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Pass 1: optional nulls
	// ---------------------------------------------------------------------------------------------------------------

	// 第一轮dropOptionalNulls沿对象成员/数组项删可选非nullable的null；例{offset:null}且offset不必填、拒null、非直接$ref时删。其他值保留；本轮不展开所有引用/组合图，不是完整schema转换。
	private dropOptionalNulls(value: unknown, schema: unknown, base: string): unknown {
		// 布尔/非对象schema不提供成员规则，原样返回。
		if (!isSchemaObject(schema)) return value;
		// 使用已索引base或父base，不在此主动重解$id。
		const b = this.baseOf(schema, base);
		// 先按实际值是否数组分流，不要求schema.type恰为array。
		if (Array.isArray(value)) {
			// mapItems按变化才复制数组，不用原生map总分配。
			return mapItems(value, (item, i) => {
				// 按当前位置取前缀/items子规则，旧式additionalItems不在此采用。
				const itemSchema = itemSchemaAt(schema, i);
				// 无子规则原项不动，有则递归删内部可选null。
				return itemSchema === undefined ? item : this.dropOptionalNulls(item, itemSchema, b);
			});
		}
		// 非数组值再用名为isPlainObject的守卫；实际只排null/数组，Date/bytes等对象也可进入，不验证普通原型。
		if (!isPlainObject(value)) return value;
		// properties对象形状采用，否则空表。
		const properties = isSchemaObject(schema.properties) ? schema.properties : {};
		// 模式字段表转成正则/规则元组数组。
		const patterns = isSchemaObject(schema.patternProperties)
			? // sharedRegex编每个模式，as const保留元组位置类型，不冻结运行元组。
				Object.entries(schema.patternProperties).map(([pattern, item]) => [sharedRegex(pattern), item] as const)
			: // 未提供/非对象模式表视空。
				[];
		// additional只有对象规则才深入，true/false不做成员转换，布尔校验留后续check。
		const additional = isSchemaObject(schema.additionalProperties) ? schema.additionalProperties : undefined;
		// 没有任何可走的成员规则就原样，properties:{}显式对象仍会进入后续流程。
		if (patterns.length === 0 && additional === undefined && !isSchemaObject(schema.properties)) return value;
		// required数组转Set仅作键存在查询；不把不在required里的任意额外键都当可删除的可选属性。
		const required = new Set(Array.isArray(schema.required) ? schema.required : []);
		// out保持undefined直到首次确实变化，Record类型不表示输入已是纯JSON。
		let out: Record<string, unknown> | undefined;
		// 局部set比较当前工作值，首次变化才浅展开原对象；例嵌套b被改才复制该层。普通属性赋值不作为__proto__等特殊键隔离措施。
		const set = (key: string, next: unknown) => {
			// ===相同就不写，NaN与NaN不等、+0/-0相等，不是Object.is或深比较。
			if (next === (out ?? value)[key]) return;
			// ??=首次变化创建浅副本，可触发原对象getter；保留未变子对象引用，不保留任意自定义原型。
			out ??= { ...value };
			// 只写out的键，未直接写入value；用户访问器自身副作用另计。
			out[key] = next;
		};
		// 枚举声明properties的自有可枚举字符串项。
		for (const [key, property] of Object.entries(properties)) {
			// 只处理输入自己的声明键，原型同名不在此第一阶段采用。
			if (!Object.hasOwn(value, key)) continue;
			// 直接属性schema有字符串$ref就标引用，本轮特意不删其null。
			const isRef = isSchemaObject(property) && typeof property.$ref === "string";
			// 四条件齐备才删：值null、不必填、非直接$ref、子check明确false；passes异常undefined时保留。
			if (value[key] === null && !required.has(key) && !isRef && this.passes(property, b, null) === false) {
				// 首次删除也先浅复制原对象。
				out ??= { ...value };
				// 删除副本该键，不把值改成undefined占位。
				delete out[key];
				// 删除后跳过该具名属性的递归分支。
				continue;
			}
			// 否则递归它内部的可选null，再按需set。
			set(key, this.dropOptionalNulls(value[key], property, b));
		}
		// Values of pattern and additional properties are walked for their own optional nulls; the keys themselves
		// are not optional properties, so they stay.
		// 有模式/额外对象规则才遍历实际键；这些键本身不因子规则拒null就被删，只深入其值内部。
		if (patterns.length > 0 || additional !== undefined) {
			// 遍历原value自有可枚举键，不是out删完后的重新枚举列表。
			for (const key of Object.keys(value)) {
				// 具名字段先标已匹配，避免误走additional。
				let matched = Object.hasOwn(properties, key);
				// 每个pattern都可作用，不只取第一命中。
				for (const [pattern, item] of patterns) {
					// 模式不匹配跳到下一条。
					if (!pattern.test(key)) continue;
					// 有一个命中就排除additional路径。
					matched = true;
					// 用当前out或原value的值继续处理多个模式，之前模式的改变可被后续模式看到。
					set(key, this.dropOptionalNulls((out ?? value)[key], item, b));
				}
				// 未具名/未命中模式且有additional对象规则时递归原字段值。
				if (!matched && additional !== undefined) set(key, this.dropOptionalNulls(value[key], additional, b));
			}
		}
		// 无变化原引用，有变化返回浅副本，不自动验证最终对象。
		return out ?? value;
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Pass 2: TypeBox's conversion rules
	// ---------------------------------------------------------------------------------------------------------------

	// convert是第二轮节点入口，先处理直接$ref再按关键字转换；例引用目标integer可把"2"转2。只跟静态$ref，$dynamicRef不在此作为独立转换入口。
	private convert(node: unknown, base: string, value: unknown): unknown {
		// 布尔或非对象规则不转换值。
		if (!isSchemaObject(node)) return value;
		// 取已索引基准。
		const b = this.baseOf(node, base);
		// 直接$ref优先，带同级其他关键字也先走它，不等同Compiler全部校验组合语义。
		if (typeof node.$ref === "string") {
			// 目标节点/基准保留unknown供解析后判对象。
			let target: { node: unknown; base: string };
			// 只保护引用解析阶段。
			try {
				// Resolver从根/注册文档定位，不访问URI网络地址。
				target = this.c.r.resolve(node.$ref, b);
				// 解析阶段异常时本次转换保留原值，不在此提供完整错误列表。
			} catch {
				// 不能解析就返回输入；之后真正check仍可能失败/抛错。
				return value;
			}
			// 目标对象才经reenter并启用memo，true/false等目标不作结构转换。
			return isSchemaObject(target.node) ? this.reenter(target.node, target.base, value, true) : value;
		}
		// 非引用规则交convertNode按关键字优先级选路径。
		return this.convertNode(node, b, value);
	}

	/** One schema node's conversion: its first keyword among `const`, `enum`, the unions, `allOf` and `type`. */
	// convertNode选首个适用关键字：const→enum→any/oneOf→allOf→type。例带const与type时先尝试const，不把同级所有转换无条件依次跑；转换后有效性由check判断。
	private convertNode(node: SchemaObject, b: string, value: unknown): unknown {
		// const以自有键存在判断，值可null/undefined，转换只在匹配目标字面量时采用。
		if (Object.hasOwn(node, "const")) return convertLiteral(node.const, value);
		// enum数组交枚举转换，不是任意真值都当列表。
		if (Array.isArray(node.enum)) return this.convertEnum(node, node.enum, b, value);
		// A union or intersection node may also declare members (plain JSON Schema; TypeBox's never do): they convert
		// after the branches.
		// anyOf优先于oneOf/type，可能另转节点自有字段。
		if (Array.isArray(node.anyOf)) return this.convertUnion(node, node.anyOf, b, value);
		// oneOf复用convertUnion：尝试新候选时验整个node的恰一规则；原值已有匹配支时可提前返回自有成员转换结果，最终仍需check。
		if (Array.isArray(node.oneOf)) return this.convertUnion(node, node.oneOf, b, value);
		// allOf按每支依次转换，不是先合并所有字段schema为一个对象。
		if (Array.isArray(node.allOf)) {
			// 保存当前接力值，初始为原输入。
			let next = value;
			// 上一支结果传下一支，顺序影响转换结果。
			for (const member of node.allOf) next = this.convert(member, b, next);
			// 分支后再处理节点自己声明的对象成员。
			return this.convertMembers(node, b, next);
		}
		// 其余按单一type名字分派，type数组不匹配这些字符串case，留第三轮处理。
		switch (node.type) {
			// 字符串转换路径。
			case "string":
				// tryString有结果取其value，无结果保留原值。
				return orValue(tryString(value), value);
			// 数字转换路径。
			case "number":
				// tryNumber接受部分基础值/字符串，不直接Number任意对象。
				return orValue(tryNumber(value), value);
			// integer在这里通过数值转换后截小数。
			case "integer": {
				// 先拿带value的转换结果，undefined表示没可用转换。
				const result = tryNumber(value);
				// Math.trunc向0截断，不是Math.floor；例如-3.5变-3，后续check仍可因界限失败。
				return result === undefined ? value : Math.trunc(result.value);
			}
			// 布尔转换路径。
			case "boolean":
				// tryBoolean规则不同于JS Boolean(value)，"false"可变false。
				return orValue(tryBoolean(value), value);
			// null转换路径。
			case "null":
				// tryNull只接受明确规定的零/空/文字，不把所有falsy都视null。
				return orValue(tryNull(value), value);
			// 数组转换路径。
			case "array":
				// 是否已有数组/元组决定逐项转换或包单值。
				return this.convertArray(node, b, value);
			// 对象转换路径。
			case "object":
				// 只处理可按成员走的对象值，不把数字等造一个空对象。
				return this.convertObject(node, b, value);
			// 没写type时仍可借结构关键字推要走的成员路径。
			case undefined:
				// properties/pattern任一存在可触发对象转换；单独additionalProperties不在这个条件里。
				if (node.properties !== undefined || node.patternProperties !== undefined) {
					// 按对象成员规则处理，仍由convertObject判输入形状。
					return this.convertObject(node, b, value);
				}
				// 没对象触发条件才看items/prefixItems，转数组路径。
				if (node.items !== undefined || node.prefixItems !== undefined) return this.convertArray(node, b, value);
				// 没有可用结构提示就原值。
				return value;
			// 其他type（含数组联合）此轮不转。
			default:
				// 原值留给后面的基础类型联合转换/check。
				return value;
		}
	}

	/** An enum is a union of its values: a member stays, else the first value the input converts to. */
	// convertEnum已有严格相等候选就保留，否则按候选顺序尝试对应字面量转换，并要求候选过整节点规则。例enum:[1,2]把"2"转2，"3"原样。
	private convertEnum(node: SchemaObject, values: readonly unknown[], base: string, value: unknown): unknown {
		// ===按值/对象身份，非JSON NaN不算此处已命中，不能概括为全局deepEqual。
		if (values.some((member) => member === value)) return value;
		// 依原枚举顺序尝试，不按最小编辑距离/最少变化打分。
		for (const member of values) {
			// 按这一个member的类型试转原value。
			const candidate = convertLiteral(member, value);
			// 真正变了且整个node明确通过才取它，passes异常undefined不采用。
			if (candidate !== value && this.passes(node, base, candidate) === true) return candidate;
		}
		// 没候选通过则保持原值，不抛“无法转换”专用错误。
		return value;
	}

	/**
	 * A value one branch accepts stays; else the first branch's conversion that the whole union accepts. Branches are
	 * converted in order and only until one is accepted, so a later recursive branch is not entered needlessly. A node
	 * that also declares members (plain JSON Schema; TypeBox's never do) converts them into each candidate before it is
	 * checked, so a branch is not discarded for a sibling property that is converted after it.
	 */
	// convertUnion先看原值是否过某支，有则只转节点自有成员；否则依序转分支+自有成员并用整联合验证候选。例string|number对"1"保留字符串，而非总转number；不是找最优匹配。
	private convertUnion(node: SchemaObject, branches: readonly unknown[], base: string, value: unknown): unknown {
		// 某支明确接受原值就不做分支转换；这并未证明节点自己的同级约束或oneOf整体都通过。
		if (branches.some((branch) => this.passes(branch, base, value) === true))
			// 仍处理节点自己声明的对象成员，结果不在这条早返分支再验整node。
			return this.convertMembers(node, base, value);
		// 没有原样可接受分支时逐个尝试。
		for (const branch of branches) {
			// 先转该分支，再转联合节点的自有对象成员，避免同级字段尚未转而错丢候选。
			const candidate = this.convertMembers(node, base, this.convert(branch, base, value));
			// 用整node检查，不仅单分支；oneOf多支同时匹配会失败。异常undefined也不采用。
			if (this.passes(node, base, candidate) === true) return candidate;
		}
		// 各候选不通过仍尽量转自有成员，不保证返回值合法。
		return this.convertMembers(node, base, value);
	}

	/** The object members of a union or intersection node, when it declares any. */
	// convertMembers为union/allOf同级对象成员补转换；例anyOf按a/b分支，节点自己还声明c:number时c也可转。仅对象成员，不在此转换同级数组关键词。
	private convertMembers(node: SchemaObject, base: string, value: unknown): unknown {
		// declares判断是否出现任一成员关键字。
		const declares =
			// 具名properties。
			node.properties !== undefined ||
			// 模式properties。
			node.patternProperties !== undefined ||
			// 额外成员规则，显式false也算声明，但convertObject不以布尔规则做值转换。
			node.additionalProperties !== undefined;
		// 有成员关键字才调用对象转换，否则原样。
		return declares ? this.convertObject(node, base, value) : value;
	}

	// convertArray遇元组只转已存在位置、绝不包单值；普通数组逐项或把单值包一项。例{items:{type:"number"}}把"2"变[2]，{prefixItems:[{type:"number"}]}对单值仍原样，不补缺项。
	private convertArray(node: SchemaObject, base: string, value: unknown): unknown {
		// 旧式items数组优先判断。
		const prefix = Array.isArray(node.items)
			? // 它就是前缀规则列表。
				node.items
			: // 否则看prefixItems是否数组。
				Array.isArray(node.prefixItems)
				? // 有则作为元组前缀。
					node.prefixItems
				: // undefined才代表非元组；空前缀数组仍算元组。
					undefined;
		// 元组路径。
		if (prefix !== undefined) {
			// A tuple converts its items and never wraps a single value.
			// 元组输入不是数组原样，不把单值包起来凑位置。
			if (!Array.isArray(value)) return value;
			// 旧items元组不转换additionalItems；新prefixItems的剩余规则用items。
			const rest = Array.isArray(node.items) ? undefined : node.items;
			// 按变化才复制输入数组。
			return mapItems(value, (item, i) => {
				// 前缀范围用对应schema，之后用rest；不新增缺失位置。
				const schema = i < prefix.length ? prefix[i] : rest;
				// 没有适用schema原项，其他交convert；false/true对象外形不符会保持值，校验另做。
				return schema === undefined ? item : this.convert(schema, base, item);
			});
		}
		// 普通非元组，输入本来为数组时逐项。
		if (Array.isArray(value)) {
			// 无items不走项转换；有则mapItems每项递归，不改变未变数组身份。
			return node.items === undefined ? value : mapItems(value, (item) => this.convert(node.items, base, item));
		}
		// The wrapped single value is converted by the item schema with the same value: a re-entry point.
		// 非数组的单值将被当成同一个值交items，有递归重入风险。
		const item = node.items;
		// items是对象规则才经reenter，memoize=false；最终一项数组本身始终新建，可能仍不合法。
		return [isSchemaObject(item) ? this.reenter(item, base, value, false) : value];
	}

	// convertObject按具名→所有命中模式→未匹配additional依次转换实际自有字段；例n_x:"2"按模式转2，额外flag:"true"按布尔转。只在值变时浅复制，不自动删除多余键/补缺键。
	private convertObject(node: SchemaObject, base: string, value: unknown): unknown {
		// 名为plain的守卫只排null/数组，非普通原型/bytes并未特别排除。
		if (!isPlainObject(value)) return value;
		// 具名规则表或空对象。
		const properties = isSchemaObject(node.properties) ? node.properties : {};
		// 模式表编为正则/schema元组。
		const patterns = isSchemaObject(node.patternProperties)
			? // as const保留元组类型，正则来自弱共享缓存。
				Object.entries(node.patternProperties).map(([pattern, schema]) => [sharedRegex(pattern), schema] as const)
			: // 无对象模式表则空。
				[];
		// additional仅对象schema参与转换，布尔true/false不转换字段值。
		const additional = isSchemaObject(node.additionalProperties) ? node.additionalProperties : undefined;
		// 副本初始不分配。
		let out: Record<string, unknown> | undefined;
		// 只走输入自有可枚举字符串键，不补没有出现的字段。
		for (const key of Object.keys(value)) {
			// An undefined property counts as absent.
			// 值undefined视缺失而跳过，保留原键本身，不在此删除。
			if (value[key] === undefined) continue;
			// next为当前字段接力值，unknown反映转换可失败。
			let next: unknown = value[key];
			// 是否具名依据规则表自有键。
			let matched = Object.hasOwn(properties, key);
			// 具名先转一次。
			if (matched) next = this.convert(properties[key], base, next);
			// 随后所有匹配模式按顺序继续转换。
			for (const [pattern, schema] of patterns) {
				// 不匹配模式就跳过。
				if (!pattern.test(key)) continue;
				// 命中任一模式，排除最后additional。
				matched = true;
				// 当前next作下一模式输入，不总用原value[key]。
				next = this.convert(schema, base, next);
			}
			// 既未具名也未匹配模式才走额外规则。
			if (!matched && additional !== undefined) next = this.convert(additional, base, next);
			// !==与原字段比较是否变更，不是深比较；NaN会被当不同而触发复制。
			if (next !== value[key]) {
				// 首次变化浅复制，未改子对象引用复用；展开可读getter，非通用不可变深拷贝。
				out ??= { ...value };
				// 写副本字段，不直接改value；没有特殊键隔离或描述符保真承诺。
				out[key] = next;
			}
		}
		// 没有任何字段变化就返回原对象引用。
		return out ?? value;
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Pass 3: primitive coercion by type
	// ---------------------------------------------------------------------------------------------------------------

	// coerceTypes第三轮先组合分支，再按type基础转换，最后明确对象/数组type才深入成员。例type:["integer","null"]可把"5"转5；没有独立$ref跟随/通用递归防护。
	private coerceTypes(value: unknown, schema: unknown, base: string): unknown {
		// 非对象schema原样，不对true/false产生转换。
		if (!isSchemaObject(schema)) return value;
		// 复用已索引基准。
		const b = this.baseOf(schema, base);
		// next作本节点逐步转换状态。
		let next = value;
		// allOf按顺序接力第三轮结果。
		if (Array.isArray(schema.allOf)) for (const member of schema.allOf) next = this.coerceTypes(next, member, b);
		// anyOf调用第三轮分支选择。
		if (Array.isArray(schema.anyOf)) next = this.coerceUnion(next, schema.anyOf, b);
		// oneOf也复用coerceUnion，它按分支check，不在此再次证明整个oneOf恰一；最后Validator.check负责。
		if (Array.isArray(schema.oneOf)) next = this.coerceUnion(next, schema.oneOf, b);
		// 读取单type/类型数组中的有效字符串名。
		const types = typesOf(schema);
		// 多个type且当前值已属于其中一类就不强转，避免string|number的"1"被无谓改成1。
		const matchesUnionMember = types.length > 1 && types.some((type) => matchesType(next, type));
		// 有类型且未被多类型已有类别接住时才试基础转换；单一type即使已匹配也可尝试无变化。
		if (types.length > 0 && !matchesUnionMember) {
			// 按类型名原顺序尝试，不排序偏好。
			for (const type of types) {
				// 尝试当前next的一步基础转换，不验证完整schema界限。
				const candidate = coercePrimitive(next, type);
				// !==看是否发生改变，NaN与自身不等也可进入，不等同“该候选已合法”。
				if (candidate !== next) {
					// 采用首个改变候选。
					next = candidate;
					// 停止尝试后续type，非全分支评分。
					break;
				}
			}
		}
		// 明确types含object且值过对象外形才递归第三轮字段；typeless properties本轮不在此触发。
		if (types.includes("object") && isPlainObject(next)) next = this.coerceProperties(next, schema, b);
		// 明确含array且值数组才逐项递归第三轮。
		if (types.includes("array") && Array.isArray(next)) next = this.coerceItems(next, schema, b);
		// 返回尝试结果，unknown提醒必须再校验。
		return next;
	}

	// coerceUnion原值若过任一支就保留；否则按支第三轮转换后首个被该支接受的候选。例integer|null的"5"可变5；不是完整oneOf整体校验，也不评分选最小修改。
	private coerceUnion(value: unknown, branches: readonly unknown[], base: string): unknown {
		// 先原样检查，明确true立即返回，undefined不当通过。
		for (const branch of branches) if (this.passes(branch, base, value) === true) return value;
		// 依序尝试每支。
		for (const branch of branches) {
			// 只做第三轮coerceTypes，不重新运行删null/第二轮。
			const coerced = this.coerceTypes(value, branch, base);
			// 校验这一分支而非整个父union，成功取候选。
			if (this.passes(branch, base, coerced) === true) return coerced;
		}
		// 无法取到候选原值。
		return value;
	}

	// coerceProperties按具名→模式→additional递归第三轮，变化才浅复制。例嵌套type联合只在本轮处理；具名阶段用in而非hasOwn，可读继承字段，不当通用原型隔离。
	private coerceProperties(
		// value已是可按键读的对象类别，字段仍unknown。
		value: Record<string, unknown>,
		// 当前成员schema对象。
		schema: SchemaObject,
		// 当前资源基准，子规则复用已索引地址。
		base: string,
	): Record<string, unknown> {
		// 具名字段表或空。
		const properties = isSchemaObject(schema.properties) ? schema.properties : {};
		// 模式字段表转元组。
		const patterns = isSchemaObject(schema.patternProperties)
			? // 编共享正则，不在每个用户字段动态new。
				Object.entries(schema.patternProperties).map(([pattern, item]) => [sharedRegex(pattern), item] as const)
			: // 没有模式表用空数组。
				[];
		// 额外字段只有对象schema才转换。
		const additional = isSchemaObject(schema.additionalProperties) ? schema.additionalProperties : undefined;
		// 延迟分配浅副本。
		let out: Record<string, unknown> | undefined;
		// 局部set对当前工作对象取值比较，首次变化才复制；例两个pattern可接力看前一步改值。
		const set = (key: string, next: unknown) => {
			// ===相同不写，不提供深相等/Object.is。
			if (next === (out ?? value)[key]) return;
			// 首次变化浅展开原value，未改分支保持引用。
			out ??= { ...value };
			// 普通赋值只写out，特殊键/描述符不作专门隔离。
			out[key] = next;
		};
		// 遍历schema的具名字段表。
		for (const [key, property] of Object.entries(properties)) {
			// in包括原型继承键；递归使用原value[key]，而非未声明键补默认。
			if (key in value) set(key, this.coerceTypes(value[key], property, base));
		}
		// 模式/额外阶段走原输入自有可枚举键。
		for (const key of Object.keys(value)) {
			// 具名标matched，避免进additional。
			let matched = Object.hasOwn(properties, key);
			// 检查所有模式，不首匹配就停。
			for (const [pattern, item] of patterns) {
				// 不匹配跳过。
				if (!pattern.test(key)) continue;
				// 匹配后排除additional。
				matched = true;
				// 取out或原value的最新值接力第三轮。
				set(key, this.coerceTypes((out ?? value)[key], item, base));
			}
			// 未具名/未命中模式才按additional第三轮转换。
			if (!matched && additional !== undefined) set(key, this.coerceTypes(value[key], additional, base));
		}
		// 无变化原引用，有变化浅副本。
		return out ?? value;
	}

	// coerceItems把数组位置交第三轮基础转换，例prefixItems中的integer|null把"5"变5。只认对象子schema，不因布尔false就删项，也不填缺项。
	private coerceItems(value: unknown[], schema: SchemaObject, base: string): unknown[] {
		// 借mapItems按变化路径复制。
		return mapItems(value, (item, i) => {
			// 取位置对应规则，旧元组追加项不使用additionalItems。
			const itemSchema = itemSchemaAt(schema, i);
			// 对象规则才递归，否则保留原项。
			return isSchemaObject(itemSchema) ? this.coerceTypes(item, itemSchema, base) : item;
		});
	}
}

/**
 * The schema of an array's item at `index`: a tuple's (`prefixItems`, or a draft-7 `items` array) for its prefix,
 * `items` after `prefixItems`, or `items` for every item. Undefined when nothing applies.
 */
// itemSchemaAt为第1/3轮选位置规则：旧items元组按下标，新prefix前缀后用items。例前缀两项第3项用rest；只选数据，不执行check/转换。
function itemSchemaAt(schema: SchemaObject, index: number): unknown {
	// 旧items数组优先，普通规则数组越界通常undefined，索引也可能读到原型属性；这里不采用additionalItems。
	if (Array.isArray(schema.items)) return schema.items[index];
	// 否则新prefixItems在前缀长度内取对应schema。
	if (Array.isArray(schema.prefixItems) && index < schema.prefixItems.length) return schema.prefixItems[index];
	// 无适用前缀就用items统一规则，可undefined/布尔/对象。
	return schema.items;
}

/** `items` mapped by `map`; the same array when every item maps to itself. */
// mapItems逐项算结果，仅首个!==变化才slice浅复制；例全部原样返回同数组。索引也可能读原型属性/访问器，循环无跳空槽协议，未承诺保留所有特殊数组描述符。
function mapItems(items: unknown[], map: (item: unknown, index: number) => unknown): unknown[] {
	// 副本延迟分配。
	let out: unknown[] | undefined;
	// 按length逐索引走，空槽在普通数组通常读undefined，但可能命中原型。
	for (let i = 0; i < items.length; i++) {
		// 同步调用map回调，异常直接传播。
		const next = map(items[i], i);
		// ===相同跳过，NaN视不同、+0/-0视相同，不能由此推断任意JS值身份完全保真。
		if (next === items[i]) continue;
		// 首次变化slice原数组，再沿用副本；普通浅复制不会复制每个任意自定义非索引属性。
		out ??= items.slice();
		// 更新副本此项，未直接写items。
		out[i] = next;
	}
	// 无变化保留原数组，否则返回新数组。
	return out ?? items;
}

// -------------------------------------------------------------------------------------------------------------------
// TypeBox's conversions of one value (value/convert/try in TypeBox 1.3.27): a result, or undefined when there is none
// -------------------------------------------------------------------------------------------------------------------

// Converted<T>用对象包装成功值，undefined专表无法转换；例{value:undefined}在类型层仍可与失败undefined区分。readonly只限制包装字段重赋。
type Converted<T> = { readonly value: T } | undefined;

// orValue取成功包装的value，否则保留原输入；例tryNumber("x")失败后仍"x"。只是解包，不验证结果适合schema。
function orValue(result: Converted<unknown>, value: unknown): unknown {
	// 严格undefined判断，不用truthy丢掉0/false/空串。
	return result === undefined ? value : result.value;
}

/** A literal (`const`, an enum value) taken from a value of another type that converts to exactly it. */
// convertLiteral按目标字面量类型尝试转换，只有结果严格等于目标才采用；例const:1把"1"转1，const:2不会把"1"转成其他值。null/对象目标没有专门转换分支。
function convertLiteral(literal: unknown, value: unknown): unknown {
	// 已经===目标则原样，函数/对象按身份而非深内容。
	if (literal === value) return value;
	// 候选转换函数由目标literal的类型决定，不由原value类型直接决定。
	const result =
		// 目标字符串。
		typeof literal === "string"
			? // 尝试按规则转字符串。
				tryString(value)
			: // 否则目标number。
				typeof literal === "number"
				? // 尝试数值转换，目标integer字面量也不在此单独Math.trunc。
					tryNumber(value)
				: // 否则目标boolean。
					typeof literal === "boolean"
					? // 尝试布尔转换。
						tryBoolean(value)
					: // 其他目标不提供候选。
						undefined;
	// 有包装且其value===目标才替换，没精确到目标保留原value。
	return result !== undefined && result.value === literal ? result.value : value;
}

// tryString接受BigInt/布尔/有限数字、null/undefined/已有字符串，给成功包装；例null→"null"、undefined→""。普通对象不调用任意toString强转，失败undefined。
function tryString(value: unknown): Converted<string> {
	// 先筛可直接转为文字的三类值；有限数字排NaN/Infinity。
	if (typeof value === "bigint" || typeof value === "boolean" || isFiniteNumber(value))
		// String转换得到基础字符串，装{value}。
		return { value: String(value) };
	// null特意用文字"null"，不同于第三轮的空串。
	if (value === null) return { value: "null" };
	// 字符串保持本值。
	if (typeof value === "string") return { value };
	// undefined特意转空串，不是文字"undefined"。
	if (value === undefined) return { value: "" };
	// 其余如对象/数组/Symbol无候选。
	return undefined;
}

// BigInt转number只接安全整数范围内的BigInt，防溢出精度；这不限制所有数值字符串也必须安全整数。
const MAX_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
// 安全负界常量，BigInt构造保存精确边界。
const MIN_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

// tryNumber尝试安全BigInt、布尔、有限number、null/undefined、数字及true/false/n后缀字符串；例""→0、"true"→1。普通字符串数值可被JS舍入，不承诺任意精度/只接受十进制。
function tryNumber(value: unknown): Converted<number> {
	// 真正bigint先单独判安全范围。
	if (typeof value === "bigint")
		// 范围内Number转换，否则失败，保留大BigInt给后续check处理。
		return value <= MAX_BIGINT && value >= MIN_BIGINT ? { value: Number(value) } : undefined;
	// 布尔映1/0，不直接用Boolean等其他规则。
	if (typeof value === "boolean") return { value: value ? 1 : 0 };
	// 原本有限number原样包回。
	if (isFiniteNumber(value)) return { value };
	// null或undefined都映0，不同于第一轮可选null删除。
	if (value === null || value === undefined) return { value: 0 };
	// 其他非字符串无候选，普通对象不触发valueOf/Number强转。
	if (typeof value !== "string") return undefined;
	// 一元+按JS数值字符串规则转，可接空白/十六进制等，不是JSON数字语法专用解析。
	const coerced = +value;
	// 结果有限即采用，整数精度是否安全不在此再判。
	if (Number.isFinite(coerced)) return { value: coerced };
	// 数值解析失败才取小写，没trim后再比true/false。
	const lowercase = value.toLowerCase();
	// 恰好大小写无关false→0，周围空白不自动去掉。
	if (lowercase === "false") return { value: 0 };
	// 恰好true→1。
	if (lowercase === "true") return { value: 1 };
	// 再试BigInt形状，例如"123n"；普通有效小数字符串已被前面一元+先处理。
	const big = bigIntOfString(value);
	// 此回退BigInt仍限安全范围，成功转number，否则无候选。
	return big !== undefined && big <= MAX_BIGINT && big >= MIN_BIGINT ? { value: Number(big) } : undefined;
}

/** TypeBox's TryBigInt of a string: `12n`, `12.5` (truncated) or `12`; true and false are not reached from tryNumber. */
// bigIntOfString处理严格几种十进制形状：12n去n、12.5只取整数部分、12直接转；例-12.5→-12n。它不支持所有BigInt构造器语法，且调用优先级使普通有限小数通常已先走数值解析。
function bigIntOfString(value: string): bigint | undefined {
	// 带n的有符号整数形式，去尾字母再BigInt，不接受任意前导零文本。
	if (/^-?(0|[1-9]\d*)n$/.test(value)) return BigInt(value.slice(0, -1));
	// 无n的小数形式按小数点前截，不向负Infinity取整。
	if (/^-?(0|[1-9]\d*)\.\d+$/.test(value)) return BigInt(value.split(".")[0]);
	// 普通有符号整数形式。
	if (/^-?(0|[1-9]\d*)$/.test(value)) return BigInt(value);
	// 都不匹配undefined，不抛“字符串不合法”专用错误。
	return undefined;
}

// tryBoolean采用0/1、false/true文字和null/undefined规则，例"FALSE"→false，"2"失败；不是JS truthy转换，其他值不因非空就变true。
function tryBoolean(value: unknown): Converted<boolean> {
	// BigInt只有0n/1n可转。
	if (typeof value === "bigint") return value === 0n ? { value: false } : value === 1n ? { value: true } : undefined;
	// 原boolean原样包装。
	if (typeof value === "boolean") return { value };
	// 有限number也只接受0/1，其他数字不强转。
	if (isFiniteNumber(value)) return value === 0 ? { value: false } : value === 1 ? { value: true } : undefined;
	// null/undefined映false。
	if (value === null || value === undefined) return { value: false };
	// 其余先要求字符串，数组/对象不强转。
	if (typeof value !== "string") return undefined;
	// 大小写归一但不trim。
	const lowercase = value.toLowerCase();
	// false文字或恰好"0"→false。
	if (lowercase === "false" || value === "0") return { value: false };
	// true文字或恰好"1"→true。
	if (lowercase === "true" || value === "1") return { value: true };
	// 未命中无候选。
	return undefined;
}

// tryNull接受明确的零/false/null/undefined及部分文字；例"NULL"→null、"nil"失败。规则是兼容转换约定，不是JS语言自动null转换。
function tryNull(value: unknown): Converted<null> {
	// BigInt只接0n。
	if (typeof value === "bigint") return value === 0n ? { value: null } : undefined;
	// boolean只接false。
	if (typeof value === "boolean") return value === false ? { value: null } : undefined;
	// 有限number只接0，+0/-0都===0。
	if (isFiniteNumber(value)) return value === 0 ? { value: null } : undefined;
	// null本身和undefined均包null。
	if (value === null || value === undefined) return { value: null };
	// 剩余非字符串无候选。
	if (typeof value !== "string") return undefined;
	// 文字大小写归一，不trim。
	const lowercase = value.toLowerCase();
	// 四类字符串：undefined/null文字（不分大小写）、空串、恰"0"。
	return lowercase === "undefined" || lowercase === "null" || value === "" || value === "0"
		? // 命中给{value:null}，可与失败undefined明确区分。
			{ value: null }
		: // 不命中无候选。
			undefined;
}

// isFiniteNumber从外部unknown筛真正有限number，例1成立、"1"/NaN/Infinity不成立；value is让TS在分支内收窄，不做转换。
function isFiniteNumber(value: unknown): value is number {
	// Number.isFinite不强转，前置typeof使返回类型谓词的意图清楚。
	return typeof value === "number" && Number.isFinite(value);
}

// -------------------------------------------------------------------------------------------------------------------
// Primitive coercion by type (pass 3)
// -------------------------------------------------------------------------------------------------------------------

// typesOf把单type字符串变一项列表，或过滤type数组为字符串列表；例["number",7]这里只留number，不证明schema定义符合全部元规则。
function typesOf(schema: SchemaObject): string[] {
	// 单字符串保留该名字，不验证是否本库支持的类型名。
	if (typeof schema.type === "string") return [schema.type];
	// filter回调显式类型谓词type is string让TS把unknown元素收窄成string[]。
	if (Array.isArray(schema.type)) return schema.type.filter((type): type is string => typeof type === "string");
	// 未提供/错误外形无可用类型列表。
	return [];
}

// matchesType只识别值类别以决定第三轮多type是否已满足；例number|string对"1"是已有字符串，不需转。它不检查minimum/pattern等，也不提供bytes类型分支。
function matchesType(value: unknown, type: string): boolean {
	// 按规则类型名分派。
	switch (type) {
		// 数字类别。
		case "number":
			// typeof number含NaN/Infinity，与最终带数值约束check不完全一样。
			return typeof value === "number";
		// 整数类别。
		case "integer":
			// 要求真正数字且整数，数字字符串不算。
			return typeof value === "number" && Number.isInteger(value);
		// 布尔类别。
		case "boolean":
			// 不把0/1当现成布尔。
			return typeof value === "boolean";
		// 字符串类别。
		case "string":
			// 仅typeof string。
			return typeof value === "string";
		// null类别。
		case "null":
			// 严格null，不是undefined。
			return value === null;
		// 数组类别。
		case "array":
			// 真实Array，不是任意可迭代对象。
			return Array.isArray(value);
		// 对象类别。
		case "object":
			// 复用实际仅排null/数组的isPlainObject，和checks.isObject排bytes不完全相同。
			return isPlainObject(value);
		// 未知类型名默认不匹配。
		default:
			// false只说明类别未匹配，非最终整份schema判定。
			return false;
	}
}

// coercePrimitive是第三轮较窄基础转换，例null→空串、空串→null，和第二轮null→"null"不同。没可用规则原样；不会包数组/造对象/验证全部限制。
function coercePrimitive(value: unknown, type: string): unknown {
	// 按目标type名字选规则，不是对未知值调用任意构造函数。
	switch (type) {
		// number和integer共用基础逻辑。
		case "number":
		// integer仅接受能转成整数的字符串，本轮不Math.trunc；第二轮可能已截过。
		case "integer": {
			// null映0。
			if (value === null) return 0;
			// 只有非空白字符串才尝试Number；空串本轮留原样，不像第二轮先转0。
			if (typeof value === "string" && value.trim() !== "") {
				// Number按JS字符串规则转换，可能得到NaN/Infinity。
				const parsed = Number(value);
				// number要求有限、integer要求整数；满足才采用parsed。
				if (type === "number" ? Number.isFinite(parsed) : Number.isInteger(parsed)) return parsed;
			}
			// boolean映1/0。
			if (typeof value === "boolean") return value ? 1 : 0;
			// 其余原样，即使最终不合法也不在此抛错。
			return value;
		}
		// boolean目标路径。
		case "boolean":
			// null映false。
			if (value === null) return false;
			// 恰小写"true"或数值1映true，不采用第二轮的大写/"1"规则。
			if (value === "true" || value === 1) return true;
			// 恰小写"false"或数值0映false。
			if (value === "false" || value === 0) return false;
			// 其他不转。
			return value;
		// string目标路径。
		case "string":
			// null映空串；第二轮已把null变"null"的值此时不会被再改空。
			if (value === null) return "";
			// number/boolean经String，未额外筛有限数；对象/BigInt不在这条转换里。
			if (typeof value === "number" || typeof value === "boolean") return String(value);
			// 其他保留。
			return value;
		// null目标路径。
		case "null":
			// 仅空字符串、数值0、布尔false变null，不同于tryNull较宽文字支持。
			return value === "" || value === 0 || value === false ? null : value;
		// 未知type或array/object等非基础转换目标。
		default:
			// 没有基础转换规则，原样。
			return value;
	}
}

// isPlainObject名称不代表严格普通对象检查：只排null/数组，Date/Map/Uint8Array等仍可进入；例{}成立，不作原型、JSON可编码或安全性验证。
function isPlainObject(value: unknown): value is Record<string, unknown> {
	// unknown边界用typeof+null+Array.isArray收窄；和schema节点守卫相似，但目标是待转换用户值。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
