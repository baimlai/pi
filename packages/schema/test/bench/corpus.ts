// 生成可复现的工具参数schema和配套合法样本，供setup/memory基准使用；不运行验证器、不计时、不访问文件或网络。
// A deterministic corpus of distinct tool-like JSON Schemas with one valid value each: random property names,
// descriptions, leaf constraints, enums, nested objects, arrays and some $defs/$ref. No two schemas are copies.

/** A schema and a value it accepts. */
// 每项放规则和一个配套值；静态接口不保证这个值已被运行时校验器检查过。
export interface CorpusItem {
	// Record给字符串键的规则表，具体关键字值仍unknown；readonly只限制TS重赋，不冻结规则。
	readonly schema: Record<string, unknown>;
	// 合法样本的实际形状可变，用unknown保存；后续使用具体字段仍需收窄。
	readonly value: unknown;
}

// 固定18个音节，后面随机选2到4个拼字段名/文字；数组没有as const或运行时冻结，函数自身不改它。
const SYLLABLES = [
	"ka",
	"lo",
	"mi",
	"re",
	"su",
	"ta",
	"ne",
	"vo",
	"pi",
	"da",
	"ru",
	"xe",
	"bo",
	"fi",
	"gu",
	"ha",
	"jo",
	"ze",
];
// 每项是[正则文字,匹配示例]二元组；内外readonly都只约束TS写入，运行时仍是普通数组。
const PATTERNS: readonly (readonly [string, string])[] = [
	// 小写字母/数字/连字符模式配a-1，+要求至少一个字符。
	["^[a-z0-9-]+$", "a-1"],
	// 再允许大写字母、点和下划线，示例A.b_c用于产生可通过该模式的值。
	["^[A-Za-z0-9._-]+$", "A.b_c"],
	// 字符串里的双反斜杠生成正则的\d，检查日期外形，不检查真实年月日。
	["^\\d{4}-\\d{2}-\\d{2}$", "2026-10-31"],
	// 固定8-4-4-4-12段小写十六进制外形；没有额外检查UUID版本/变体。
	["^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "01890a5d-ac96-774b-bcce-b302099a8057"],
	// 井号后恰6个小写十六进制字符，示例作为配套文本直接返回。
	["^#[0-9a-f]{6}$", "#00ff00"],
];

/** `count` distinct schemas, the same for the same seed. */
// 输入样本数和默认42的seed，返回新CorpusItem数组；例corpus(2,7)重复调用产生同内容的新对象。每次拥有独立PRNG状态，生成变化规则/值而不检查它们，无外部I/O。
// 按本函数的有限整数用法生成样本；count/seed未做运行时有效性检查，也未用Set或比较来证明全局无重复。
export function corpus(count: number, seed = 42): CorpusItem[] {
	// 创建本次随机数闭包，后面每次调用都会推进同一份状态；不使用Math.random。
	const random = mulberry32(seed);
	// 局部int把[0,1)映成包含lo/hi的整数区间；例int(2,4)只可能2/3/4，此处调用均是合法界限。
	const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
	// 泛型<T>保留元素类型，readonly T[]表示只读视图；按随机下标选一个，依赖当前候选数组非空，类型不替空数组提供运行时保护。
	const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
	// word每次随机建2到4个音节再join成文本；Array.from的第二参数是逐项工厂，不复用一次选出的音节。
	const word = () => Array.from({ length: int(2, 4) }, () => pick(SYLLABLES)).join("");
	// sentence生成4到12个word、用空格连接并添句号；模板插值会调用这些工厂、消耗后续随机序列，只用于description。
	const sentence = () => `${Array.from({ length: int(4, 12) }, word).join(" ")}.`;

	// leaf输入当前深度，返回[子规则,配套值]元组；例选到整数分支会产minimum与min+1。它推进random，必要时递归object，深度到2后不再向下创建对象。
	function leaf(depth: number): [Record<string, unknown>, unknown] {
		// 仅为分支选择取一次r；各分支里的sentence/word还会继续取数。
		const r = random();
		// r在[0,0.3)时返回普通字符串规则和拼词值，description只是说明。
		if (r < 0.3) return [{ type: "string", description: sentence() }, word()];
		// 之前分支已返回，因此这里代表r在[0.3,0.4)，不是再次抽签。
		if (r < 0.4) {
			// 最小长度选0到3，为下面规则和值共同使用。
			const min = int(0, 3);
			// 返回两项元组，规则和值都在本次调用中新建。
			return [
				// 最大长度至少比min大5，配套min+1长度的值不会超它。
				{ type: "string", minLength: min, maxLength: min + int(5, 200), description: sentence() },
				// 重复x得到min+1个ASCII字符，满足这份长度范围；不是把schema本身转成字符串。
				"x".repeat(min + 1),
			];
		}
		// r在[0.4,0.47)时选择固定模式样本分支。
		if (r < 0.47) {
			// 解构同一对pattern/value，避免模式和值各随机一次而不匹配。
			const [pattern, value] = pick(PATTERNS);
			// 返回带pattern的string规则和已配好的匹配文字，不在这里new RegExp执行检查。
			return [{ type: "string", pattern, description: sentence() }, value];
		}
		// r在[0.47,0.55)时生成字符串枚举。
		if (r < 0.55) {
			// 创建2到5个随机单词，未对重复枚举成员去重。
			const values = Array.from({ length: int(2, 5) }, word);
			// 首项就是枚举内样本；values[0]来自上面非空长度，不是任意外部输入。
			return [{ type: "string", enum: values, description: sentence() }, values[0]];
		}
		// r在[0.55,0.65)时生成有上下界整数规则。
		if (r < 0.65) {
			// 下界为0到10，后面上界至少高10。
			const min = int(0, 10);
			// 规则的integer是JSON Schema关键字；配套min+1为小范围整数，TS中其运行值依旧是number。
			return [{ type: "integer", minimum: min, maximum: min + int(10, 10000), description: sentence() }, min + 1];
		}
		// r在[0.65,0.72)时返回number规则和[0,100)数值，未要求它一定有小数部分。
		if (r < 0.72) return [{ type: "number", description: sentence() }, random() * 100];
		// r在[0.72,0.8)时另抽一次数决定boolean值；比较表达式直接产生true/false。
		if (r < 0.8) return [{ type: "boolean", description: sentence() }, random() < 0.5];
		// r在[0.8,0.88)时生成字符串数组规则。
		if (r < 0.88) {
			// 最大项数取1到50，配套只有一个word，因此满足数量/成员类型；不是任意items的通用生成器。
			return [{ type: "array", items: { type: "string" }, maxItems: int(1, 50), description: sentence() }, [word()]];
		}
		// 剩余r>=0.88且depth<2才递归对象，成员数2到5；depth每层加1，使这条生成递归有界。
		if (depth < 2) return object(depth + 1, int(2, 5));
		// 深度达上限时回退普通字符串，保持规则和值配套，而不是继续产生对象。
		return [{ type: "string", description: sentence() }, word()];
	}

	// object输入深度和字段数，返回[对象schema,样本对象]；例某字段被标required就一定填配套值，否则随机省略。它消耗PRNG并创建本层表，不修改传入外部对象。
	function object(depth: number, n: number): [Record<string, unknown>, Record<string, unknown>] {
		// properties存每个字段自己的规则表，与下面实际用户值分开。
		const properties: Record<string, Record<string, unknown>> = {};
		// 新建实际样本对象，字段不是把规则直接塞进去。
		const value: Record<string, unknown> = {};
		// required记录必填字段名；空数组表示没有必填，不代表不能有字段。
		const required: string[] = [];
		// 为当前对象生成n个字段；这里n由内部有界int提供。
		for (let i = 0; i < n; i++) {
			// 首字段只用word，后续追加不同正整数后缀；三元表达式选number或空字符串，再由+拼接成键名。
			const name = word() + (i > 0 ? i : "");
			// 解构leaf的规则和值，继续沿用当前对象深度供下一次是否嵌套判断。
			const [schema, v] = leaf(depth);
			// 以计算属性名把规则写到properties表。
			properties[name] = schema;
			// 约60%的这次抽样分支设必填；不是对最终数组强制固定60%字段数。
			if (random() < 0.6) {
				// 必填名加入规则列表。
				required.push(name);
				// 必填字段同时写入样本，防生成缺字段的“合法”值。
				value[name] = v;
				// 非必填分支再独立抽一次：一半填值，一半省略；可选不等于必须缺省。
			} else if (random() < 0.5) value[name] = v;
		}
		// 组合type/properties/required，同名属性简写保存已建表引用，不深复制。
		const schema: Record<string, unknown> = { type: "object", properties, required };
		// 约一半对象显式禁止额外字段，另一半不写关键字、按JSON Schema默认允许；当前样本只填声明字段。
		if (random() < 0.5) schema.additionalProperties = false;
		// 返回元组供leaf或最外层使用，返回值本身不代表已实际check。
		return [schema, value];
	}

	// 本次结果数组从空开始，显式类型限定每个push项的形状。
	const items: CorpusItem[] = [];
	// 按i<count循环，正常有限非负整数count得到所需项数；并未自动截断或验证异常count。
	for (let i = 0; i < count; i++) {
		// 每个根对象深度0、字段2到10，子对象沿前述深度限制生成。
		const [schema, value] = object(0, int(2, 10));
		// as只把内部已构造properties视为规则表，不在运行时验证任意schema。
		const properties = schema.properties as Record<string, Record<string, unknown>>;
		// 约20%的这一抽样分支尝试抽取嵌套对象为本地$defs，并非每个schema都会有引用。
		if (random() < 0.2) {
			// Move one nested object into $defs and reference it, as MCP servers built with zod often do.
			// 按Object.keys顺序找第一个直接type为object的字段，find回调只检查这一层，不扫描所有后代。
			const key = Object.keys(properties).find((k) => properties[k].type === "object");
			// 有这种字段才改写；找不到时保留原schema，不强造$defs。
			if (key !== undefined) {
				// 用word加Def拼定义名，这些音节不含Pointer的/或~，本函数无需转义它们。
				const name = `${word()}Def`;
				// 新$defs表的计算属性保存原子规则对象引用，未克隆规则。
				schema.$defs = { [name]: properties[key] };
				// 把原properties位置替换成指向该定义的$ref对象；配套值仍原样，因为约束本身没有变。
				properties[key] = { $ref: `#/$defs/${name}` };
			}
		}
		// 补根description，推进PRNG；这段元数据影响生成内容，不增加值验证条件。
		schema.description = sentence();
		// 保存同名schema/value引用，外部调用者拿到的是本次生成的新对象图。
		items.push({ schema, value });
	}
	// 返回全部项；这里只负责生成，不校验也不测耗时。
	return items;
}

// mulberry32以number seed返回零参数取数函数；例同seed、同调用次序可复现。闭包保存并改变state，输出[0,1)，不是密码学随机源，不访问系统熵。
function mulberry32(seed: number): () => number {
	// 初始化本闭包状态，后面位运算按JS规则转32位整数。
	let state = seed;
	// 返回箭头函数而非立刻取一次数；调用者可重复调用推进序列。
	return () => {
		// 加固定常量再|0取有符号32位结果；十六进制字面量不是字符串。
		state = (state + 0x6d2b79f5) | 0;
		// >>>做无符号右移，^逐位异或，Math.imul保32位整数乘积；临时t不直接替代state。
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		// 再次混合t；赋值表达式改本次临时数，非修改入参seed。
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		// 最后>>>0转无符号32位，再除2^32得到小于1的非负小数。
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
