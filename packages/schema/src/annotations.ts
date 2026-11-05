/**
 * 为unevaluatedProperties/unevaluatedItems跟踪“哪些字段/下标已经被规则检查过”。
 * 例anyOf两支分别认可a和b，再用unevaluatedProperties:false拒绝其余字段，需要先收齐成功分支的覆盖位置。
 * 此处Annotations是运行时求值记录，与builders.ts中description/default等描述元数据不是一回事。
 * helper多返回闭包供Compiler组合；它们不修改被验证数据，但会原地更新账本，false不普遍保证回滚，隔离由上层组合决定。
 */
// Annotation tracking for `unevaluatedProperties` and `unevaluatedItems`: annotating checks record which
// properties and items a schema evaluated. Only schemas that use those keywords compile into these closures.

// 运行数据边界：isObject排除null、数组和Uint8Array，返回可按字符串键读取的对象。
import { isObject } from "./checks.ts";
// Check是unknown→boolean函数类型，导入不产生运行时依赖。
import type { Check } from "./types.ts";

/** What a schema evaluated: property names (or all of them), the evaluated item prefix, items matched by `contains`. */
/** 一份值的已求值位置账本：对象字段集合、数组前缀长度与离散contains命中下标；集合延迟到第一次需要时分配。 */
export interface Annotations {
	// 已检查的具体属性名，null表示尚未建Set，不表示所有属性。
	props: Set<string> | null;
	// true表示当前对象全部属性已经覆盖，后续unevaluatedProperties无需再查。
	allProps: boolean;
	// 已检查的数组连续前缀长度，例如2覆盖下标0、1，不是最大下标本身。
	items: number;
	// true表示整数组已经覆盖，后续unevaluatedItems可跳过。
	allItems: boolean;
	// contains命中的离散下标，不一定是连续前缀；null尚未分配。
	indexes: Set<number> | null;
}

/** A check that records what it evaluated into `a` when it passes. */
// 比普通Check多接一个可变账本a；false时某些组合仍可能已写部分记录，不能当事务回滚保证。
export type AnnotatingCheck = (value: unknown, a: Annotations) => boolean;

/** Empty annotations. */
/** 为一份独立值创建空账本；例先检查prefix两项后items可变2。返回新对象，Set仍用null延迟分配，无IO。 */
export function newAnnotations(): Annotations {
	// all标记默认false，items前缀为0，未求值字段/下标还不占Set。
	return { props: null, allProps: false, items: 0, allItems: false, indexes: null };
}

/** 把b中已求值位置合入a，b不改；例a记录x、b记录y，合并后a含x/y。前缀取最大值、all标记做或，不深拷贝值对象。 */
function merge(a: Annotations, b: Annotations): void {
	// b有具体属性集合才逐项合并，addProp按需建a的Set并去重。
	if (b.props !== null) for (const k of b.props) addProp(a, k);
	// ||=仅当原false时采用右值，任一allProps为true就保持true。
	a.allProps ||= b.allProps;
	// 前缀是覆盖长度，取较大值，不能简单相加。
	if (b.items > a.items) a.items = b.items;
	// 整数组覆盖标志同样单调从false到true。
	a.allItems ||= b.allItems;
	// 离散下标逐项合并，Set不会重复存同一下标。
	if (b.indexes !== null) for (const i of b.indexes) addIndex(a, i);
}

/** 向账本记一个字段名；例addProp(a,"path")。只在第一次需要时分配Set，重复添加不会增加项目数。 */
function addProp(a: Annotations, key: string): void {
	// 初始null时才分配；不为本来没有字段的schema预先造集合。
	if (a.props === null) a.props = new Set();
	// 原地更新a的集合，不修改被验证对象本身。
	a.props.add(key);
}

/** 向账本记一个contains等已求值下标；例addIndex(a,3)。只存传入数字，不在这里额外检查下标范围。 */
function addIndex(a: Annotations, index: number): void {
	// 没离散下标时延迟分配。
	if (a.indexes === null) a.indexes = new Set();
	// Set.add保留唯一数值，a.items前缀不在此改变。
	a.indexes.add(index);
}

/** 始终通过、无记录的常量检查；true schema不等于宣称所有字段都已由properties/items求值。 */
export const ANNOTATING_TRUE: AnnotatingCheck = () => true;
/** 始终失败、无记录的常量检查；false schema拒绝当前位置。 */
export const ANNOTATING_FALSE: AnnotatingCheck = () => false;

/** The indirection a recursive reference goes through. */
/** 为递归schema返回间接闭包；Compiler先把它放缓存，再补slot.check，避免编译引用无限展开。例树节点引用自身。 */
export function indirectAnnotating(slot: { check: AnnotatingCheck | undefined }): AnnotatingCheck {
	// as只是既定“调用前slot已补好”的类型断言，不添加运行时兜底；每次调用读取slot最新check并透传同一账本。
	return (v, a) => (slot.check as AnnotatingCheck)(v, a);
}

/** A plain check in annotating position: it evaluates nothing that unevaluated* sees. */
/** 将普通Check适配为带账本签名，但不记位置；例minimum只判断数值，不能替properties标记对象键。返回闭包，无IO。 */
export function ignoreAnnotations(check: Check): AnnotatingCheck {
	// JS函数可忽略多余a实参，普通check的true/false直接透传。
	return (v) => check(v);
}

/** An annotating check run as a plain check, with fresh annotations. */
/** 把带记录检查包装为普通Check，每次校验新建账本；例根schema含unevaluatedProperties时走此入口，不把上一次值的记录带到下一次。 */
export function withFreshAnnotations(check: AnnotatingCheck): Check {
	// 每次调用内创建新对象，检查结束后只返回boolean，不向调用方公开账本。
	return (v) => check(v, newAnnotations());
}

/** `check` with `uri` pushed onto the dynamic scope while it runs. */
/** 运行时把资源URI压入动态引用作用域，执行后弹出并回传结果；例跨资源$dynamicRef查找。没有try/finally，check抛错时不会自动pop。 */
export function scopedAnnotating(scope: string[], uri: string, check: AnnotatingCheck): AnnotatingCheck {
	// 返回捕获同一scope数组/uri/check的检查闭包。
	return (v, a) => {
		// 原地压栈，动态引用可看到当前资源。
		scope.push(uri);
		// 同步执行子检查，记录仍传原a；异常直接传播。
		const ok = check(v, a);
		// 正常true/false返回才弹栈，不承诺异常后作用域自动恢复。
		scope.pop();
		// 返回原判定，不把URI本身记成字段/下标。
		return ok;
	};
}

/** unevaluated* sees only the annotations of its own schema, never those of its siblings in the parent. */
/** 隔离某schema自己的已求值记录，防unevaluated*误看到父级兄弟的记录；先在新b检查，成功才合回a。失败不合入b，但不回滚输入值的外部回调副作用。 */
export function isolateAnnotations(check: AnnotatingCheck): AnnotatingCheck {
	// 每次校验都建私有账本，不沿用父a已有记录。
	return (v, a) => {
		// b只供当前schema及其子项使用。
		const b = newAnnotations();
		// false时丢弃b，即使b已产生部分位置记录。
		if (!check(v, b)) return false;
		// 整体通过才把当前schema贡献给父a。
		merge(a, b);
		// 合并完成返回true，不替父级执行剩余规则。
		return true;
	};
}

/** The non-annotating keywords, then each annotating part in order. */
/** 先普通断言，再按顺序执行所有带记录子检查；例对象类型/长度先判，再properties与unevaluatedProperties。任一false短路，已写a不在本helper内撤销。 */
export function annotateAll(plain: Check, parts: readonly AnnotatingCheck[]): AnnotatingCheck {
	// 闭包捕获plain及parts顺序。
	return (v, a) => {
		// 普通断言不通过就不运行后面的带记录检查。
		if (!plain(v)) return false;
		// 每项接同一a，让后面的unevaluated*看到前面通过项记下的位置；失败直接停止。
		for (let i = 0; i < parts.length; i++) if (!parts[i](v, a)) return false;
		// 全部通过才true。
		return true;
	};
}

/** `properties`, `patternProperties` and `additionalProperties`. */
/**
 * 对象字段检查并记已覆盖名字：具名属性→每个匹配模式→未匹配时additional→成功后合并seen。
 * 例props含x、额外y按additional通过，则x/y都记下，供unevaluatedProperties跳过。
 * 非对象直接true，类型约束由普通部分负责；自有键存在就检查，即使其值undefined，不把这里等同普通对象快路径的所有缺失规则。
 * pattern可同名多次命中并逐个检查；additional为undefined表示没此关键字，不把未声明字段记成已覆盖。
 */
export function annotateObject(
	// 只读元组数组：每项是字段名与已编译普通Check，外层/元组的readonly都只管TS。
	props: readonly (readonly [string, Check])[],
	// 正则/Check数组可多条命中同一字段，不是找到第一条就停。
	patterns: readonly (readonly [RegExp, Check])[],
	// undefined表示没有additionalProperties规则；显式true已由Compiler转成ALWAYS函数，不等于undefined。
	additional: Check | undefined,
): AnnotatingCheck {
	// 在工厂阶段建立声明名Set，后续每次校验复用，不重新建。
	const declared = new Set(props.map(([k]) => k));
	// 每次值校验的闭包。
	return (v, a) => {
		// unknown输入边界；非对象不受这些对象关键字约束，不在这里强制其类型。
		if (!isObject(v)) return true;
		// 局部seen先积累，所有字段检查成功后才写a.props。
		const seen: string[] = [];
		// 先看具名属性。
		for (const [k, check] of props) {
			// Object.hasOwn只看自有键，不因为原型上有同名键就检查/记入。
			if (!Object.hasOwn(v, k)) continue;
			// 字段值检查失败立刻false，seen未合入a。
			if (!check(v[k])) return false;
			// 通过的具名字段先记到本地数组。
			seen.push(k);
		}
		// 再走实际自有可枚举字段，含未声明字段。
		for (const k of Object.keys(v)) {
			// 具名属性算已声明，即使还没有模式命中。
			let matched = declared.has(k);
			// 所有patternProperties正则都尝试，匹配多个规则就要全部通过。
			for (const [re, check] of patterns) {
				// regex来自共享编译，不在这里根据字段动态重建。
				if (re.test(k)) {
					// 模式匹配的值若不通过，整个对象关键字失败。
					if (!check(v[k])) return false;
					// 阻止后面再把此字段当additional。
					matched = true;
					// 记录该字段，重复名字稍后由Set去重。
					seen.push(k);
				}
			}
			// 既未具名也未匹配模式，且确有additional规则时才检查。
			if (!matched && additional !== undefined) {
				// 显式additional:false对应恒false检查，会在这里拒绝。
				if (!additional(v[k])) return false;
				// 通过额外规则的字段同样算已求值。
				seen.push(k);
			}
		}
		// 全部成功后才发布本对象规则的字段贡献，不改被验证对象。
		for (const k of seen) addProp(a, k);
		// 成功返回，类型要求仍由整体schema负责。
		return true;
	};
}

/** `prefixItems`/`items`/`additionalItems` and `contains` with its bounds. */
/**
 * 数组位置检查并记前缀/全量/contains命中；例prefix一项、contains匹配下标2，会记items>=1及indexes含2。
 * 非数组直接通过，类型约束由普通部分负责。rest若存在，连显式true也会把allItems标true。
 * contains必须扫全数组来收齐位置；计数最后才判界限，失败时本函数可能已改a，不提供局部回滚。
 */
export function annotateArray(
	// 每个前缀位置一个普通Check，数组只约束已提供的位置，不在此要求至少prefix.length项。
	prefix: readonly Check[],
	// 后续项规则，undefined为未提供，和编译出的ALWAYS不同。
	rest: Check | undefined,
	// contains候选检查，undefined则不扫命中位置。
	contains: Check | undefined,
	// 至少命中几项，默认由Compiler算好。
	minContains: number,
	// 最多命中几项，可Infinity，本函数不再独立验范围。
	maxContains: number,
): AnnotatingCheck {
	// 每次运行共用已编译checks，账本由调用方传入。
	return (v, a) => {
		// unknown边界确认数组，其他值由普通type关键字决定是否拒绝。
		if (!Array.isArray(v)) return true;
		// 只检查实际存在与前缀长度交集。
		const m = Math.min(v.length, prefix.length);
		// 任一前缀项失败就false，未进入下面位置发布。
		for (let i = 0; i < m; i++) if (!prefix[i](v[i])) return false;
		// 提供rest规则时才处理前缀后的项目。
		if (rest !== undefined) {
			// 即使rest=ALWAYS也逐项调用，并最终标整数组已覆盖。
			for (let i = prefix.length; i < v.length; i++) if (!rest(v[i])) return false;
			// 此关键字覆盖了全部后续位置；若没有后续项也可标true。
			a.allItems = true;
		}
		// 前缀覆盖长度只增不减，和其他分支记录取最大。
		if (m > a.items) a.items = m;
		// 配了contains才运行它，不能把未声明当恒true扫描。
		if (contains !== undefined) {
			// 当前contains的匹配数，不累计父级已有indexes数。
			let n = 0;
			// 必须遍历全部位置收齐注释，不按达到min/max就提早返回。
			for (let i = 0; i < v.length; i++) {
				// 检查匹配，失败这一项不代表整个contains失败。
				if (contains(v[i])) {
					// 成功匹配数加1。
					n++;
					// 已匹配项目算被contains求值，供unevaluatedItems使用。
					addIndex(a, i);
				}
			}
			// 扫描后再判断总数；若越界返回false，前面a的记录不在此撤销。
			if (n < minContains || n > maxContains) return false;
		}
		// 所有数组规则通过。
		return true;
	};
}

/** `anyOf` (or `oneOf` when `exactlyOne`): every passing branch contributes its annotations. */
/** anyOf/oneOf带记录版本，例两条anyOf都通过时两者位置都应贡献；exactlyOne=true最后要求恰一条。遍历全部分支，不因首个通过就停。失败时已合入a的成功分支记录不在此回滚。 */
export function annotateAny(branches: readonly AnnotatingCheck[], exactlyOne: boolean): AnnotatingCheck {
	// 每次运行重新计通过分支数。
	return (v, a) => {
		// 不用boolean短路，因为仍需其他通过分支的记录。
		let n = 0;
		// 依输入顺序逐分支检查。
		for (const branch of branches) {
			// 每支独立空b，不能让分支互相看到对方记录。
			const b = newAnnotations();
			// 只合并真正通过分支的b，失败分支局部记录丢弃。
			if (branch(v, b)) {
				// 统计通过分支。
				n++;
				// 合进调用方a；oneOf后来发现多支通过时也不在此撤销。
				merge(a, b);
			}
		}
		// 三元表达式按exactlyOne选择：oneOf恰一支通过，anyOf至少一支通过。
		return exactlyOne ? n === 1 : n > 0;
	};
}

/** `if`, `then` and `else`: a passing `if` contributes its annotations even without `then`. */
/** 条件检查：cond成功贡献其记录并走then；失败丢弃cond记录并走otherwise。例if仅判某属性也会影响unevaluated*，即使没有then。此helper不回滚then失败前已写a。 */
export function annotateIf(
	// if条件本身也是带记录检查。
	cond: AnnotatingCheck,
	// then可缺，条件成立且缺then即通过。
	then: AnnotatingCheck | undefined,
	// else可缺，条件不成立且缺else即通过。
	otherwise: AnnotatingCheck | undefined,
): AnnotatingCheck {
	// 每次调用创建条件私有账本。
	return (v, a) => {
		// 条件不能直接读父a已有位置，先写b。
		const b = newAnnotations();
		// cond的true/false决定执行哪侧，不把cond失败本身当整个schema失败。
		if (cond(v, b)) {
			// 条件通过才合并其求值记录。
			merge(a, b);
			// ||短路：没有then直接true，有则运行并继续写同一a。
			return then === undefined || then(v, a);
		}
		// 条件失败不合并b，只采用else结果/记录；缺else则true。
		return otherwise === undefined || otherwise(v, a);
	};
}

/** One `dependentSchemas` entry. */
/** dependentSchemas单项：例对象有creditCard键才把整对象交该schema；未出现或非对象直接通过。只触发检查，不自动把触发键本身标已求值。 */
export function annotateDependent(key: string, check: AnnotatingCheck): AnnotatingCheck {
	// ||短路避免对非对象查键；Object.hasOwn表示键存在，不要求其值truthy，也不在此过滤undefined。
	return (v, a) => !isObject(v) || !Object.hasOwn(v, key) || check(v, a);
}

/** `unevaluatedProperties`: every property no other keyword evaluated passes `check`. */
/** 对所有尚未求值的自有字段运行check，成功标整对象已覆盖；例false规则拒绝任一没被properties/分支等覆盖的键。类型非对象或allProps已true直接跳过。 */
export function unevaluatedProperties(check: Check): AnnotatingCheck {
	// 账本应属于当前值，调用方负责隔离/初始化，不跨不相干值共用。
	return (v, a) => {
		// 非对象不受对象关键字影响；全部覆盖时无需再枚举。
		if (!isObject(v) || a.allProps) return true;
		// ?.和??把未建Set视为没有命中；只检查尚未记录字段，任一失败立即返回。
		for (const k of Object.keys(v)) if (!(a.props?.has(k) ?? false) && !check(v[k])) return false;
		// 所有剩余字段通过后标allProps，不逐个把它们写Set。
		a.allProps = true;
		// 本规则成功，不修改输入字段或填默认值。
		return true;
	};
}

/** `unevaluatedItems`: every item no other keyword evaluated passes `check`. */
/** 对前缀之后、又未被contains等命中的数组项运行check；全部通过标allItems。例prefix覆盖前2项、contains覆盖第4项，只需再查其他项。 */
export function unevaluatedItems(check: Check): AnnotatingCheck {
	// 复用调用方当前数组的账本。
	return (v, a) => {
		// 非数组或已整段覆盖就无额外检查。
		if (!Array.isArray(v) || a.allItems) return true;
		// 从a.items覆盖长度起步，跳过离散indexes命中；失败即false，不删除或转换项目。
		for (let i = a.items; i < v.length; i++) if (!(a.indexes?.has(i) ?? false) && !check(v[i])) return false;
		// 所有剩余项通过才宣布全数组覆盖。
		a.allItems = true;
		// 返回boolean，不向调用方输出新数组。
		return true;
	};
}
