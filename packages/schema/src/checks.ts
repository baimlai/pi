/**
 * Compiler用的检查工厂：把某个schema关键字编成unknown→boolean闭包，复用叶函数并特化常见对象/数组/联合。
 * 例minimum关键字通过numberCheck捕获边界，之后每份工具参数只需调闭包；此模块不解析规则地址、不生成eval字符串。
 * 返回闭包尽量只捕获参数，不捕获Compiler；用户format/check、对象访问器仍可抛错或有副作用，没有统一回滚/吞错。
 * 常规输入是JSON数据；任意JS原型、NaN、循环对象的实际边界在具体函数旁说明，不凭类型名虚构通用深比较/安全净化。
 */
// Check factories: each returns a closure that captures only its arguments, never the compiler, so a compiled
// schema keeps no compile-time state alive. Leaf checks are module constants that object and array loops inline.

// Check只是unknown→boolean函数类型，实际验证由下面返回的闭包完成。
import type { Check } from "./types.ts";

// 恒通过的共享函数；例空schema {}可直接复用，不为每份规则新分配闭包。
export const ALWAYS: Check = () => true;
// 恒失败的共享函数；例false schema拒绝当前位置任意值。
export const NEVER: Check = () => false;
// 只检查JS字符串类型，不含长度/正则/格式。
const IS_STRING: Check = (v) => typeof v === "string";
// 只检查typeof number，非JSON的NaN/Infinity也会通过这个单独叶子。
const IS_NUMBER: Check = (v) => typeof v === "number";
// 整数用Number.isInteger，数字字符串不转型，NaN/Infinity不成立。
const IS_INTEGER: Check = (v) => Number.isInteger(v);
// 只接受真正boolean，不把0/1或"true"当布尔。
const IS_BOOLEAN: Check = (v) => typeof v === "boolean";
// 只接受null，undefined不成立。
const IS_NULL: Check = (v) => v === null;
// 真正数组用Array.isArray判断，普通带length对象不成立。
export const IS_ARRAY: Check = (v) => Array.isArray(v);
// bytes是本库Uint8Array扩展；instanceof是运行值边界，不是TS泛型验证。
const IS_BYTES: Check = (v) => v instanceof Uint8Array;
// 对象叶子复用下面isObject排null/数组/bytes，未限制为无原型或普通对象。
export const IS_OBJECT: Check = (v) => isObject(v);

/** Whether `v` is a JSON object: not null, an array or bytes. */
// isObject给用户值做对象类别收窄，例{}成立、[]/null/Uint8Array不成立；Date等其余对象可过此关，不保证JSON可编码或字段已合法。
export function isObject(v: unknown): v is Record<string, unknown> {
	// &&短路依次筛类型、null、数组和bytes；value is类型谓词成功后可按字符串键读unknown。
	return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

/** The check of a `type` name; `bytes` (a Uint8Array) extends JSON Schema for values that never pass through JSON. */
// 类型名→共享check，ReadonlyMap只限制TS接口，不在运行时冻结Map；例typeCheck(["string"])可直接取IS_STRING。
export const TYPE_CHECKS: ReadonlyMap<string, Check> = new Map([
	// string类型名映字符串叶子。
	["string", IS_STRING],
	// number映typeof检查，不附加有限性约束。
	["number", IS_NUMBER],
	// integer映整数检查。
	["integer", IS_INTEGER],
	// boolean映布尔检查。
	["boolean", IS_BOOLEAN],
	// null映严格null检查。
	["null", IS_NULL],
	// array映数组检查。
	["array", IS_ARRAY],
	// object映排除数组/bytes的对象检查。
	["object", IS_OBJECT],
	// bytes是非标准JSON内存扩展。
	["bytes", IS_BYTES],
]);

/** Leaf checks that object and array loops run inline by code instead of calling them. */
// 按check函数身份映小整数代码，让对象/数组循环内联常见叶子，避免每项再调函数；不是按函数名匹配。
export const LEAF_CODES: ReadonlyMap<Check, number> = new Map([
	// 1代表字符串。
	[IS_STRING, 1],
	// 2代表number。
	[IS_NUMBER, 2],
	// 3代表integer。
	[IS_INTEGER, 3],
	// 4代表boolean。
	[IS_BOOLEAN, 4],
	// 5代表null。
	[IS_NULL, 5],
	// 6代表恒通过；其余未映函数用代码0走真正check。
	[ALWAYS, 6],
]);

// leafOk按Compiler装入的叶代码快速判一个值；例代码1查typeof string。默认直接true，调用方只应给已约定代码，不在此校验表元数据。
function leafOk(code: number, x: unknown): boolean {
	// switch按整数码选叶子，避免Map查找发生在每个用户字段上。
	switch (code) {
		// 字符串分支。
		case 1:
			// 不把其他值String化。
			return typeof x === "string";
		// number分支。
		case 2:
			// 保留typeof number语义，也含NaN/Infinity。
			return typeof x === "number";
		// integer分支。
		case 3:
			// Number.isInteger不做强制转换。
			return Number.isInteger(x);
		// boolean分支。
		case 4:
			// 要求JS布尔。
			return typeof x === "boolean";
		// null分支。
		case 5:
			// undefined与null严格不等。
			return x === null;
		// 默认覆盖ALWAYS代码6，其他未约定码也会落这里，不是错误检测器。
		default:
			// 直接通过。
			return true;
	}
}

/** Whether a combined object or array check also checks the type: not at all, strictly, or passing other types. */
// GUARD_NONE表示调用方已完成对象类型分流；对象闭包据此省检查，数组listCheck仍会先判数组。
export const GUARD_NONE = 0;
// GUARD_STRICT要求对应对象/数组类别，其他值失败。
export const GUARD_STRICT = 1;
// GUARD_LOOSE只在对应类别检查，其他类别通过，符合只写properties/items不强制type的语义。
export const GUARD_LOOSE = 2;
// typeof常量用于类型层，得到0|1|2字面量联合，不是枚举emit。
export type Guard = typeof GUARD_NONE | typeof GUARD_STRICT | typeof GUARD_LOOSE;

/** Flags of a declared property in an object check's entries: its leaf code and two bits. */
// 低3位掩码二进制111，提取叶代码；不是字段个数。
export const CODE = 7;
// 第4位表示必填，用位或叠加、位与读取。
export const REQUIRED = 8;
// 第5位表示键也是Object.prototype成员，openObject借它区分自有键；declaredObject循环不另读此位。
export const INHERITED = 16;

/** All of `parts`; two and three parts get closures without a loop. */
// and把多个检查合成全通过，例[min,max]两项依次短路。0/1/2/3项特化省循环，更多才遍历；只捕获parts/函数，不捕获Compiler，无错误吞并。
export function and(parts: readonly Check[]): Check {
	// 按编译时已有parts数量选实现，后续校验不用再switch这个数量。
	switch (parts.length) {
		// 没有任何断言。
		case 0:
			// 空合取为真，共享ALWAYS。
			return ALWAYS;
		// 仅一条无需再包闭包。
		case 1:
			// 直接返回同一个检查函数。
			return parts[0];
		// 两条时特化。
		case 2: {
			// 解构两份函数，闭包只记a/b。
			const [a, b] = parts;
			// &&先a后b，a失败不运行b；回调异常原样传播。
			return (v) => a(v) && b(v);
		}
		// 三条时同理特化。
		case 3: {
			// 解构a/b/c，不克隆函数。
			const [a, b, c] = parts;
			// 从左到右短路。
			return (v) => a(v) && b(v) && c(v);
		}
		// 四项及以上走循环。
		default:
			// 返回一次用户值校验用的闭包，不在构造阶段检查v。
			return (v) => {
				// 第一条失败即false，后面的检查不执行。
				for (let i = 0; i < parts.length; i++) if (!parts[i](v)) return false;
				// 所有项均通过才true。
				return true;
			};
	}
}

/** A check whose implementation is set later: the indirection a recursive reference goes through. */
// indirect为递归schema留可稍后填的槽；例树的children指回树，Compiler先缓存此闭包避免无限编译，调用前才补slot.check。
export function indirect(slot: { check: Check | undefined }): Check {
	// as是“调用前已补槽”的约定，不加运行兜底；每次读取slot最新函数再调用，同步异常透传。
	return (v) => (slot.check as Check)(v);
}

/** `check` with `uri` pushed onto the dynamic scope while it runs (only for schemas with `$dynamicRef`). */
// scopedCheck给动态引用检查压入资源URI，执行后正常弹栈。例进入扩展树资源再解析动态锚点；没有finally，check抛错会保留压入项，不当事务。
export function scopedCheck(scope: string[], uri: string, check: Check): Check {
	// 捕获同一scope数组/uri/check，每次校验执行下面步骤。
	return (v) => {
		// push资源URI，动态lookup按当前作用域选择规则。
		scope.push(uri);
		// 同步运行检查并保存true/false，可能调用用户format回调。
		const ok = check(v);
		// 只有正常返回才pop，不在异常情况下自动恢复。
		scope.pop();
		// 回传原判定，不把scope内容返回给用户。
		return ok;
	};
}

/** Any of the named types. */
// typeCheck把一组类型名编成“任一种成立”检查；例["string","null"]接受两类。未知/非字符串名字编成NEVER，空列表恒失败，无值转换。
export function typeCheck(types: readonly unknown[]): Check {
	// schema关键字输入仍unknown，先确认名为字符串再查Map；??把未找到者变NEVER。
	const checks = types.map((t) => (typeof t === "string" ? TYPE_CHECKS.get(t) : undefined) ?? NEVER);
	// 单类型直接返回共享check，省包装。
	if (checks.length === 1) return checks[0];
	// 多类型/空数组返回闭包。
	return (v) => {
		// 任一类型通过即可短路true。
		for (let i = 0; i < checks.length; i++) if (checks[i](v)) return true;
		// 没有类型通过，包括空列表，为false。
		return false;
	};
}

/** A Uint8Array within the length bounds. */
// bytesCheck要求Uint8Array且长度位于含端点区间；例(0,4)接受4字节，不接受普通数组。只读长度，不复制/编码数据。
export function bytesCheck(min: number, max: number): Check {
	// instanceof先筛类型，再按元素长度比较，Uint8Array每项正好1字节；回传boolean。
	return (v) => v instanceof Uint8Array && v.length >= min && v.length <= max;
}

/** The number of Unicode code points of `s`: JSON Schema string lengths count code points, not UTF-16 units. */
// codePoints按Unicode码点计长；例"\u{1F600}"的JS length为2但此函数为1，孤立代理码元也按1计。不做字素合并，所以组合音标可能多于1。
export function codePoints(s: string): number {
	// 累计码点数初始0。
	let n = 0;
	// i按UTF-16码元索引走，每轮n加1；若识别代理对，循环体会额外推进i。
	for (let i = 0; i < s.length; i++, n++) {
		// charCodeAt读当前16位码元，不是codePointAt完整码点。
		const c = s.charCodeAt(i);
		// A high surrogate starts a pair only when a low surrogate follows; an unpaired one is a code point of its own.
		// 高代理范围且后面还有码元才可能成对。
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			// 读紧跟的下一码元。
			const next = s.charCodeAt(i + 1);
			// 若低代理合法，额外跳过它，一对只计一次；非低代理留给下一轮单计。
			if (next >= 0xdc00 && next <= 0xdfff) i++;
		}
	}
	// 返回计数，不改字符串。
	return n;
}

// UTF-16 units bound code points from both sides (units / 2 <= points <= units), so most strings need no count.
// lengthOk借码元数上下界避免不必要的全遍历；例短ASCII可直接判断，emoji边界才计码点。结果是JSON Schema码点长度范围，不是终端显示宽度。
function lengthOk(s: string, min: number, max: number): boolean {
	// 字符串length是UTF-16码元数，天然>=码点数。
	const units = s.length;
	// 连码元都少于min，码点更不够，直接false。
	if (units < min) return false;
	// 码元>=2*min可保证码点>=min；否则精确计一次确认下限。
	if (units < 2 * min && codePoints(s) < min) return false;
	// 码元<=max即可通过上限，否则再数码点；&&/||短路可能省遍历，不缓存跨调用结果。
	return units <= max || codePoints(s) <= max;
}

/** The string keywords: length bounds, pattern and format. */
// stringCheck将长度/正则/format合为一个闭包，strict决定其他类型拒绝还是放过。例只写pattern且无type时数字不受它限制；format回调可抛错/副作用，不在此吞异常。
export function stringCheck(
	// strict=true要求字符串，false让非字符串通过；不是字符串转换开关。
	strict: boolean,
	// 码点长度下界，含端点。
	min: number,
	// 码点长度上界，可Infinity表示无上限。
	max: number,
	// 可选预编正则，由Compiler/sharedRegex提供，正常不带g/y。
	re: RegExp | undefined,
	// 可选格式回调；参数已经由闭包收窄为string，无需重复做形状检查。
	format: ((value: string) => boolean) | undefined,
): Check {
	// 只有正则而无长度/format限制，走最小专用闭包。
	if (re !== undefined && min === 0 && max === Number.POSITIVE_INFINITY && format === undefined) {
		// 严格型先typeof且正则；宽松型非字符串直接true，字符串才test。
		return strict ? (v) => typeof v === "string" && re.test(v) : (v) => typeof v !== "string" || re.test(v);
	}
	// 没有正则/format则只剩长度规则。
	if (re === undefined && format === undefined) {
		// 按strict在两个闭包中选，不是每次校验重新选择构造路径。
		return strict
			? // 严格要求字符串并满足lengthOk。
				(v) => typeof v === "string" && lengthOk(v, min, max)
			: // 宽松先放其他类型，字符串才查长度。
				(v) => typeof v !== "string" || lengthOk(v, min, max);
	}
	// 同时带多种规则走通用闭包。
	return (v) => {
		// 非字符串按strict立即返回，不调用正则/format。
		if (typeof v !== "string") return !strict;
		// 按长度→正则→format短路；undefined表示不提供那项规则，不把format自动加载。
		return lengthOk(v, min, max) && (re === undefined || re.test(v)) && (format === undefined || format(v));
	};
}

/** The number keywords. `mode`: 0 passes other types, 1 requires a number, 2 an integer. */
// numberCheck合并数值界限/整数/倍数，mode控制其他类别语义；例minimum:0只约束数字，不自动拒绝字符串，除非mode1/2要求类型。无取整/强转。
export function numberCheck(
	// 0宽松/1数字/2整数，是字面量联合参数，不是运行时enum。
	mode: 0 | 1 | 2,
	// 包含的最小值。
	min: number,
	// 包含的最大值。
	max: number,
	// 不包含的最小值，默认负Infinity。
	xmin: number,
	// 不包含的最大值，默认正Infinity。
	xmax: number,
	// 可选倍数值，具体合法性来自传入schema边界；不在此归一/取绝对值。
	multipleOf: number | undefined,
): Check {
	// 每个输入运行此闭包。
	return (v) => {
		// 其他类型只在mode0通过；数字字符串不转换。
		if (typeof v !== "number") return mode === 0;
		// mode2先排小数、NaN、Infinity。
		if (mode === 2 && !Number.isInteger(v)) return false;
		// 各边界及multiple依次短路；启用此数值组时默认开区间±Infinity会拒绝非有限数字，和单独IS_NUMBER不同。
		return v >= min && v <= max && v > xmin && v < xmax && (multipleOf === undefined || isMultiple(v, multipleOf));
	};
}

/** Whether `v` is a multiple of `d`, exactly for decimals: 0.0075 / 0.0001 is 74.99999999999999 in floating point. */
// isMultiple优先普通除法整数判断，必要时按JS十进制字符串转BigInt精算余数；例0.0075/0.0001浮点不整却可通过。不是任意外部十进制原文精度恢复。
export function isMultiple(v: number, d: number): boolean {
	// 先算浮点商，这是常见整数倍的快速路径。
	const q = v / d;
	// 商已经整数立即true，无需分解BigInt。
	if (Number.isInteger(q)) return true;
	// 商非有限时退回JS取余比较，避免把Infinity/NaN交decimal编码。
	if (!Number.isFinite(q)) return v % d === 0;
	// 把v的JS十进制显示拆成整数系数和十次方指数。
	const [vc, ve] = decimal(v);
	// 对d同样分解，符号在decimal取绝对值去掉。
	const [dc, de] = decimal(d);
	// 按指数差扩大一方系数再取BigInt余数；10n/0n为BigInt字面量，避免二进制浮点尾差。
	return ve >= de ? (vc * 10n ** BigInt(ve - de)) % dc === 0n : vc % (dc * 10n ** BigInt(de - ve)) === 0n;
}

// decimal把有限number的绝对值表示为[BigInt系数,十进指数]；例1.25→[125n,-2]，1e21→[1n,21]，1000→[1000n,0]，按toString结果分解。仅内部数值路径使用，无通用解析/异常兜底。
function decimal(x: number): [bigint, number] {
	// 绝对值的toString按e拆科学记数法，无e时指数默认字符串0。
	const [mantissa, exponent = "0"] = Math.abs(x).toString().split("e");
	// 找小数点，缺失为-1。
	const point = mantissa.indexOf(".");
	// 小数位数是点后字符数，不含指数部分。
	const fraction = point < 0 ? 0 : mantissa.length - point - 1;
	// 去点后的整数串转BigInt，原科学指数减小数位数，组成二元组返回。
	return [BigInt(mantissa.replace(".", "")), Number(exponent) - fraction];
}

/** `inner` for objects; other values pass unless `strict`. */
// guardObject包一层类别分流：例仅properties规则对数字可放过，明确type:object时数字失败。inner只在isObject成立时调用，无复制。
export function guardObject(inner: Check, strict: boolean): Check {
	// strict选择&&或||短路，确保inner收到对象类别；isObject不保证对象是普通JSON数据。
	return strict ? (v) => isObject(v) && inner(v) : (v) => !isObject(v) || inner(v);
}

/** `inner` for arrays; other values pass unless `strict`. */
// guardArray同理分流数组；例只写minItems时非数组可通过，明确数组type则拒绝其他类型。
export function guardArray(inner: Check, strict: boolean): Check {
	// 先Array.isArray，inner不在非数组分支调用。
	return strict ? (v) => Array.isArray(v) && inner(v) : (v) => !Array.isArray(v) || inner(v);
}

/**
 * An object with declared properties: `entries` is `[key, check, flags]` per property. The value's own keys are
 * walked with for...in (whose `o[k]` V8 reads from the enum cache, unlike a load by a name from a list), each found
 * among the declared names; `closed` rejects any other key. A property whose value is `undefined` counts as absent.
 */
// declaredObject为无模式/复杂依赖的对象快路径：扁平字段三元组→for...in比对→叶子内联/必填计数/未知字段。例closed=true拒绝额外键；undefined当缺失。for...in实际也枚举继承可枚举键，不能把它概括成仅Object.keys自有字段。
export function declaredObject(
	// entries为[key,check,flags]重复三元组，unknown[]以断言读取，是Compiler与此处的布局约定。
	entries: readonly unknown[],
	// 必填的已声明键总数，末尾要与实际计数相等。
	requiredCount: number,
	// closed决定未在字段表的枚举键是否立刻失败。
	closed: boolean,
	// 对象类型守卫模式；NONE要求调用方已完成类别分流。
	guard: Guard,
): Check {
	// n是扁平数组长度，不是字段数，字段数通常n/3。
	const n = entries.length;
	// 每次输入新建required计数，不在共享编译数据里累计。
	return (v) => {
		// 需要guard时非对象按LOOSE通过或STRICT失败，NONE不做此处对象检查。
		if (guard !== GUARD_NONE && !isObject(v)) return guard === GUARD_LOOSE;
		// Guarded: by the check above, or by the caller for GUARD_NONE.
		// as只把已经由本层/上层分流的v视为记录，不克隆、不排原型/访问器。
		const o = v as Record<string, unknown>;
		// 记录本值中真正遇到的非undefined必填字段数量。
		let required = 0;
		// for...in含继承可枚举字符串键，无symbol/不可枚举字段；本循环没有Object.hasOwn过滤。
		for (const k in o) {
			// 从扁平表首个key槽开始查。
			let i = 0;
			// 每次跳3到下一字段，直到找到名字或越过表尾。
			while (i < n && entries[i] !== k) i += 3;
			// 表尾表示未知字段。
			if (i === n) {
				// 闭对象立即拒绝这个未知键。
				if (closed) return false;
				// 开放对象忽略未知键，继续下一个枚举项。
				continue;
			}
			// 读取值可触发用户访问器；类型检查不意味着回调纯净。
			const x = o[k];
			// undefined视缺失，不运行子规则/不计必填。
			if (x === undefined) continue;
			// 第3槽位是位标志，as number是布局约定，没有再做运行验证。
			const f = entries[i + 2] as number;
			// 低3位提取叶代码。
			const c = f & CODE;
			// 已知叶内联，否则调用第2槽check；任一false直接失败。
			if (c !== 0 ? !leafOk(c, x) : !(entries[i + 1] as Check)(x)) return false;
			// 带REQUIRED位才加必填计数；INHERITED位在此没有额外自有键检查。
			if (f & REQUIRED) required++;
		}
		// 必须正好遇到requiredCount个必填项；未枚举到的必填字段导致false。
		return required === requiredCount;
	};
}

/** An object with declared properties, required keys not declared, pattern properties and additional properties. */
// openObject处理字段、额外必填、全部匹配模式及additional规则；例x同时命中两个pattern就都要通过。它并不天然表示额外属性一律放行，undefined/自有键规则见各分支。
export function openObject(
	// 仍用Compiler生成的扁平字段三元组。
	entries: readonly unknown[],
	// 已声明字段名列表，构建known集合用。
	keys: readonly string[],
	// required里有而properties里没声明的字段，只要求自有存在。
	extraRequired: readonly string[],
	// 每项正则/check是readonly元组，多个可同时命中同键。
	patterns: readonly (readonly [RegExp, Check])[],
	// 额外字段规则，undefined表示不需要逐额外字段验证。
	additional: Check | undefined,
	// 类型守卫模式，NONE由调用方先分流。
	guard: Guard,
): Check {
	// 有pattern或additional才分配声明名Set；其余情况省去后半Object.keys遍历。
	const known = patterns.length > 0 || additional !== undefined ? new Set(keys) : undefined;
	// 返回捕获规则的单值检查闭包。
	return (v) => {
		// 对象类型检查/宽松放行语义同前一个工厂。
		if (guard !== GUARD_NONE && !isObject(v)) return guard === GUARD_LOOSE;
		// 断言为记录供索引，不额外复制/冻结用户对象。
		const o = v as Record<string, unknown>;
		// 每步3取一个已声明字段。
		for (let i = 0; i < entries.length; i += 3) {
			// 第1槽字段名，as是内部布局约定。
			const k = entries[i] as string;
			// 直接读o[k]，一般自定义原型上同名属性也能读到。
			const x = o[k];
			// 第3槽叶代码/必填/原型成员标志。
			const f = entries[i + 2] as number;
			// undefined当缺失；仅键属于Object.prototype成员时额外要求Object.hasOwn，不能推成所有继承字段一律拒绝。
			if (x === undefined || (f & INHERITED && !Object.hasOwn(o, k))) {
				// 缺失且必填，立即false。
				if (f & REQUIRED) return false;
				// 可选缺失跳过其check。
				continue;
			}
			// 取低3位叶代码。
			const c = f & CODE;
			// 叶子内联或真实子check，失败即停止。
			if (c !== 0 ? !leafOk(c, x) : !(entries[i + 1] as Check)(x)) return false;
		}
		// 额外required字段只查Object.hasOwn；即使其值undefined也满足这个存在性分支，与已声明必填项不同。
		for (let i = 0; i < extraRequired.length; i++) if (!Object.hasOwn(o, extraRequired[i])) return false;
		// 无known说明没有模式/额外字段检查，前面通过即可true。
		if (known === undefined) return true;
		// 后半遍历实际自有可枚举字符串键，不含继承/symbol。
		for (const k of Object.keys(o)) {
			// 声明名先标匹配，避免最后误当additional。
			let matched = known.has(k);
			// 逐个pattern，不按首个匹配短路。
			for (let i = 0; i < patterns.length; i++) {
				// 正则命中这个键才验对应值。
				if (patterns[i][0].test(k)) {
					// 命中即记matched，即使其他pattern还需继续检查。
					matched = true;
					// 匹配规则的值check失败立即拒绝。
					if (!patterns[i][1](o[k])) return false;
				}
			}
			// 未具名/未匹配模式且有additional才调用；显式false编成NEVER会在这里拒绝。
			if (!matched && additional !== undefined && !additional(o[k])) return false;
		}
		// 所有规则通过返回true，不输出变换对象。
		return true;
	};
}

/** Every property name passes `check` (`v` is an object). */
// propertyNamesCheck检查每个枚举键名，输入已由上层分成对象；例键名规则pattern要求a开头。实际for...in含继承可枚举键，不修改名字。
export function propertyNamesCheck(check: Check): Check {
	// 返回检查闭包，捕获键名check。
	return (v) => {
		// as object只为TS允许枚举，for...in忽略symbol/不可枚举；首个坏键false。
		for (const k in v as object) if (!check(k)) return false;
		// 所有枚举键通过即true。
		return true;
	};
}

/** `minProperties` and `maxProperties` (`v` is an object). */
// propertyCountCheck计算for...in枚举项数量是否在含端点范围；例(1,2)要求1至2个枚举字段。普通JSON对象等同可见字段数，任意原型对象可能计入继承可枚举键。
export function propertyCountCheck(min: number, max: number): Check {
	// 每次验证重新计数，不在编译时假设用户字段量。
	return (v) => {
		// 计数初始0。
		let n = 0;
		// 变量_表示键名不使用，仍逐个for...in计入；不是跳过某类名字的语法。
		for (const _ in v as object) n++;
		// 含上下界，未命中范围即false。
		return n >= min && n <= max;
	};
}

/** `dependentRequired` (`v` is an object). */
// dependentRequiredCheck按触发字段要求其他自有键；例有creditCard就要billing。只看键存在，不要求truthy，也不在此校验各字段值。
export function dependentRequiredCheck(entries: readonly (readonly [string, readonly string[]])[]): Check {
	// 每个输入运行闭包，类型已由调用方分流成对象。
	return (v) => {
		// as object不额外做对象检查。
		const o = v as object;
		// 每条元组解构出触发键与所需字段列表。
		// 触发键自有存在才逐项要求其他自有键；undefined值在这个存在性分支仍算存在。
		for (const [k, list] of entries)
			if (Object.hasOwn(o, k)) for (const r of list) if (!Object.hasOwn(o, r)) return false;
		// 所有依赖满足通过。
		return true;
	};
}

/** `dependentSchemas` (`v` is an object). */
// dependentSchemasCheck在触发自有键存在时，把整对象交对应schema；例creditCard触发整个地址规则，不是只校验creditCard字段本身。
export function dependentSchemasCheck(entries: readonly (readonly [string, Check])[]): Check {
	// 返回可复用闭包。
	return (v) => {
		// 无触发键跳过；有且整值子check失败即false，同步异常不捕获。
		for (const [k, check] of entries) if (Object.hasOwn(v as object, k) && !check(v)) return false;
		// 所有被触发规则通过即可true。
		return true;
	};
}

/** The common array: guard, length bounds, prefix items and the items after them, in one closure. */
// listCheck把数组类别/长度/prefix/rest合一，例元组先按位置检查，再检查剩余项。prefix本身不要求最少项，长度由min决定；无输入变换。
export function listCheck(
	// guard为LOOSE才允许非数组，NONE在本实现也会拒绝非数组，而非跳过Array.isArray。
	guard: Guard,
	// 含端点最少元素数。
	min: number,
	// 含端点最多元素数。
	max: number,
	// 前缀各位置自己的Check，readonly不冻结数组。
	prefix: readonly Check[],
	// 前缀后每项的规则，undefined表示剩余项不约束。
	rest: Check | undefined,
): Check {
	// 前缀规则数量，和实际输入length不同。
	const n = prefix.length;
	// 剩余项若为共享叶函数，预取代码，避免每项Map查找；代码0调用真实rest。
	const code = rest === undefined ? 0 : (LEAF_CODES.get(rest) ?? 0);
	// 单值检查闭包，捕获预编规则/代码。
	return (v) => {
		// 先判真实数组，其他类型只有LOOSE通过。
		if (!Array.isArray(v)) return guard === GUARD_LOOSE;
		// 数组长度可含空槽；普通数组空槽通常读undefined，索引访问也可能命中原型数字属性/访问器。
		const length = v.length;
		// 长度越界先拒绝，省后面逐项检查。
		if (length < min || length > max) return false;
		// 只检查实际输入与前缀相交的个数，不因前缀有3项就自动要求至少3项。
		const m = length < n ? length : n;
		// 按位置运行对应prefix检查，首个失败即false。
		for (let i = 0; i < m; i++) if (!prefix[i](v[i])) return false;
		// 无rest规则，不再遍历后续项。
		if (rest === undefined) return true;
		// 剩余规则是常见叶子可内联。
		if (code !== 0) {
			// 从prefix总长起扫剩余项，不重复检查前缀。
			for (let i = n; i < length; i++) if (!leafOk(code, v[i])) return false;
			// 叶循环全通过即true。
			return true;
		}
		// 其他rest逐项调函数，可能运行format等回调。
		for (let i = n; i < length; i++) if (!rest(v[i])) return false;
		// 所有项和长度通过true。
		return true;
	};
}

/** Prefix items and the items after them (`v` is an array). */
// itemsCheck只组织前缀/后续规则，调用listCheck取默认长度0..Infinity；例数组已有别处guard/长度检查时复用，无复制。
export function itemsCheck(prefix: readonly Check[], rest: Check | undefined): Check {
	// NONE不是让listCheck在非数组上通过，调用方正常已分流；这里只不额外加入长度限制。
	return listCheck(GUARD_NONE, 0, Number.POSITIVE_INFINITY, prefix, rest);
}

/** `minItems` and `maxItems` (`v` is an array). */
// lengthCheck在已是数组的输入上查含端点长度；例minItems=2。as仅静态断言，没有在此再验类别。
export function lengthCheck(min: number, max: number): Check {
	// 两次读length并比较，数组空槽仍计长度，不统计实际存在元素数。
	return (v) => (v as unknown[]).length >= min && (v as unknown[]).length <= max;
}

/** `contains` with its bounds (`v` is an array). */
// containsCheck统计子规则通过次数，超max立刻失败，最后至少min；例contains:number要求有数字，min=0允许零命中。它不收集已求值下标，和annotations版扫描策略不同。
export function containsCheck(check: Check, min: number, max: number): Check {
	// 每个输入新计匹配数。
	return (v) => {
		// 数组类别由上层保证，断言不运行验证。
		const list = v as unknown[];
		// 本次命中数0。
		let n = 0;
		// 只有check真时前缀++n才执行，并立即比较max；超过上界短路，不再检查余项。
		for (let i = 0; i < list.length; i++) if (check(list[i]) && ++n > max) return false;
		// 遍历后至少min即通过，未要求提前达到min就停止，因为还要守max。
		return n >= min;
	};
}

/** `uniqueItems` (`v` is an array). */
// uniqueCheck用深相等做两两比较；例[{x:1},{x:1}]失败。最坏平方比较次数，递归对象无通用循环防护/深度预算，不排序、不修改数组。
export function uniqueCheck(v: unknown): boolean {
	// 输入已由数组group分流，as不复制。
	const list = v as unknown[];
	// 每项与此前所有项比较，遇相等立即false。
	for (let i = 1; i < list.length; i++) for (let j = 0; j < i; j++) if (deepEqual(list[i], list[j])) return false;
	// 无重复true，空/单元素自然通过。
	return true;
}

/** `enum`: up to 8 primitives by a scan, more by a Set, objects and arrays by deep equality. */
// enumCheck按候选形状/数量选扫描、Set和深比较；例少量字符串直接===。通常输入是JSON值；非JSON NaN等在<=8扫描与Set路径的相等语义不同，不能概括成任意JS值完全等价。
export function enumCheck(values: readonly unknown[]): Check {
	// 名为primitives的列表实际保留非object（含function）及null，过滤不是JSON合法性校验。
	const primitives = values.filter((x) => typeof x !== "object" || x === null);
	// 全部属于该列表且<=8，选线性扫描，包括空列表。
	if (primitives.length === values.length && primitives.length <= 8) {
		// 小枚举检查闭包。
		return (v) => {
			// 严格===命中即true，不做数字字符串强转；NaN不等于自身。
			for (let i = 0; i < primitives.length; i++) if (primitives[i] === v) return true;
			// 空/无匹配false。
			return false;
		};
	}
	// 较大或混合枚举用Set保存非对象项，Set按SameValueZero，NaN可命中。
	const set = new Set(primitives);
	// 另收非null对象候选，数组也在此列表。
	const objects = values.filter((x) => typeof x === "object" && x !== null);
	// 先Set命中，或对象值对任一对象候选deepEqual；并不做通用类型原型相等。
	return (v) => set.has(v) || (typeof v === "object" && objects.some((o) => deepEqual(v, o)));
}

/** `const`. */
// constCheck检查固定值，基础值===、对象/数组deepEqual；例const:{x:1}按内容，不要求同引用。不验证schema常量是JSON可编码值。
export function constCheck(value: unknown): Check {
	// 非对象/null直接捕获同一值做严格相等，函数等非JSON值也落此分支。
	if (typeof value !== "object" || value === null) return (v) => v === value;
	// 对象交递归结构比较，不克隆schema常量对象。
	return (v) => deepEqual(v, value);
}

/** `anyOf`. */
// anyCheck按顺序任一check通过即true，例string或number；空候选false。纯布尔版只需首个成功，与带求值账本的annotateAny不同。
export function anyCheck(checks: readonly Check[]): Check {
	// 返回复用候选函数的闭包。
	return (v) => {
		// 成功立即停止，不收集其他成功分支位置。
		for (let i = 0; i < checks.length; i++) if (checks[i](v)) return true;
		// 全部失败或零分支false。
		return false;
	};
}

/** `oneOf`. */
// oneCheck要求恰一分支通过，例integer和number对1都通过所以整体失败；第二个成功即早停，不遍历余项/不收集位置。
export function oneCheck(checks: readonly Check[]): Check {
	// 每次输入独立计数。
	return (v) => {
		// 成功分支数量初始0。
		let n = 0;
		// check真才++n，出现第2支直接false；失败不增加。
		for (let i = 0; i < checks.length; i++) if (checks[i](v) && ++n > 1) return false;
		// 末尾必须恰1，不是至少1。
		return n === 1;
	};
}

/** `not`. */
// notCheck对一个布尔检查取反；例not:{type:"string"}拒绝字符串。异常仍传播，不把throw当false。
export function notCheck(check: Check): Check {
	// !只反转返回的truth结果，无输入变换。
	return (v) => !check(v);
}

/** `if`, `then` and `else`. */
// ifCheck条件成立只跑then，否则只跑otherwise；Compiler会为缺省分支给ALWAYS。例if:type:number then:minimum，非选分支不执行。
export function ifCheck(cond: Check, then: Check, otherwise: Check): Check {
	// 三元是运行时控制流，与TS条件类型的extends ? :不同。
	return (v) => (cond(v) ? then(v) : otherwise(v));
}

/** A union of objects tagged by a const on `key`: the tag selects the one branch that can match. */
// taggedCheck在已知互斥标签联合中按标签选一条规则；例kind=text只验text分支。输入必须对象；标签约束/必填互斥性由Compiler决定，不在此重新证明。
export function taggedCheck(key: string, tags: readonly unknown[], checks: readonly Check[]): Check {
	// 捕获同序tags/checks，每个输入运行下面判断。
	return (v) => {
		// 非对象直接false，不调用任何分支。
		if (!isObject(v)) return false;
		// 直接读取v[key]，不是Object.hasOwn判断，可能读访问器/原型属性，最终分支还会运行自己的对象规则。
		const tag = v[key];
		// ===查匹配标签，同下标check决定最终结果；未在此遍历其他分支求错误总数。
		for (let i = 0; i < tags.length; i++) if (tags[i] === tag) return checks[i](v);
		// 未知标签false。
		return false;
	};
}

/** JSON equality: same primitives, arrays with equal items in order, objects with the same keys and equal values. */
// deepEqual给JSON值比较内容：同引用快过、数组按顺序、对象按键取值。例{a:1,b:2}与{b:2,a:1}相等；不完整比较原型/symbol/不可枚举属性，不追踪循环，不是任意JS对象通用相等器。
export function deepEqual(a: unknown, b: unknown): boolean {
	// ===同引用/同基础值先true，+0/-0相等，NaN仍不等。
	if (a === b) return true;
	// 不同基础值或一方null立即false，只有两个非null对象继续。
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	// 先记a是否数组。
	const array = Array.isArray(a);
	// 数组和非数组不相等，即使字段碰巧类似。
	if (array !== Array.isArray(b)) return false;
	// 双方数组走元素顺序分支。
	if (array) {
		// as仅帮助TS把已识别数组看作unknown[]。
		const x = a as unknown[];
		// b同样，未建立副本。
		const y = b as unknown[];
		// 长度不同直接false。
		if (x.length !== y.length) return false;
		// 逐下标递归，普通空槽通常读undefined，也可能读到原型数字属性/访问器；不额外比较数组自定义非索引属性。
		for (let i = 0; i < x.length; i++) if (!deepEqual(x[i], y[i])) return false;
		// 数组长度/对应项全相等true。
		return true;
	}
	// 非数组对象按记录读取；Date/Map等并没有专用比较器。
	const x = a as Record<string, unknown>;
	// 同样视b为记录。
	const y = b as Record<string, unknown>;
	// 只取a自有可枚举字符串键，symbol等忽略。
	const keys = Object.keys(x);
	// b键数必须相同。
	if (keys.length !== Object.keys(y).length) return false;
	// 每个a枚举键需是b自有键并值递归相等；并未要求b该键也可枚举，特殊JS属性描述符下不是严格的可枚举键集合对比。
	for (const k of keys) if (!Object.hasOwn(y, k) || !deepEqual(x[k], y[k])) return false;
	// 所有键相等true，两个无可枚举键的不同非数组对象也可能到这里。
	return true;
}
