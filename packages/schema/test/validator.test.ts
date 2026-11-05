// 通过具体输入验证compile/Validator的布尔结果与错误解释：对象字段、字节、引用、draft、冻结、Unicode和大枚举。URI资源在本地登记，URL只解析语法；不读取真实文件或访问网络。
// compile() and Validator: checks, errors, values, options and schemas from other sources.

// TypeBox默认导出用于构造外来规则，本库compile接收它的普通schema数据，不要求用户先转成本库builder。
import Type from "typebox";
// Vitest分组、用例和运行时expect；本文件检查真实布尔结果/错误结构，不只检查静态类型。
import { describe, expect, it } from "vitest";
// 可选格式表要显式传compile才对已注册format进行断言；单独导入不改变全局默认。
import { formats } from "../src/formats/index.ts";
// 公开compile入口组合Compiler、Resolver、Validator和按需错误解释，不会按URI联网取schema。
import { compile } from "../src/index.ts";

// read是可复用的普通规则数据，不是文件读取工具实现；下列测试只验证对象形状，不读取path指向的文件。
const read = {
	// 只接受对象输入，数组/字节等按本库对象口径区分。
	type: "object",
	// path必须string，offset存在时为>=1整数；properties本身不意味着字段必填。
	properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 } },
	// 只把path列入required，所以offset可省。
	required: ["path"],
	// 拒绝未声明额外属性，不会自动删除输入字段。
	additionalProperties: false,
};

// block是两类消息块的anyOf联合，靠kind常量可辨text/image；两支都显式禁止额外字段。
const block = {
	// anyOf至少一支符合，不是要求恰好一支的oneOf。
	anyOf: [
		{
			// text分支只接受对象。
			type: "object",
			// kind恰好text，text内容要string。
			properties: { kind: { const: "text" }, text: { type: "string" } },
			// 两个字段都必需，不能只有标签而缺正文。
			required: ["kind", "text"],
			// text支拒绝其他键。
			additionalProperties: false,
		},
		{
			// image分支同样接受对象。
			type: "object",
			// kind恰好image，width是非负整数；没有实际图片文件输入。
			properties: { kind: { const: "image" }, width: { type: "integer", minimum: 0 } },
			// kind/width两者必填。
			required: ["kind", "width"],
			// image支也拒绝额外字段。
			additionalProperties: false,
		},
	],
};

// 错误分组围绕可读路径/关键字，而布尔合法性仍由编译检查器决定。
describe("errors", () => {
	// 缺必填、违反数值下界、额外字段同时输入，期待依序给三条错误，位置各指具体字段。
	it("reports a missing field and an unknown field at the field", () => {
		// compile(read)生成验证器后errors检查该输入；offset=0不是缺字段，而是数值不合法。
		expect(compile(read).errors({ offset: 0, extra: true })).toEqual([
			// path缺失，JSON Pointer指向/path，keyword为required。
			{ path: "/path", keyword: "required", message: "missing" },
			// offset低于1，按minimum报错。
			{ path: "/offset", keyword: "minimum", message: "expected >= 1" },
			// extra未声明，按additionalProperties报错而不是把它默默丢掉。
			{ path: "/extra", keyword: "additionalProperties", message: "unknown field" },
		]);
	});

	// 合法输入例子说明errors成功时返回空数组，而非undefined或带ok对象。
	it("is empty for a valid value", () => {
		// path字符串且无其他必需字段缺失，结果[]。
		expect(compile(read).errors({ path: "a.ts" })).toEqual([]);
	});

	// 标签选支例子在数组第1项放坏image，期待width错误；另给未知video标签，期待kind候选提示，而不是倾倒所有支错误。
	it("reports the branch a tagged union's tag selects", () => {
		// 数组items使用前面block联合，不能直接把整个输入数组当一个block。
		const validator = compile({ type: "array", items: block });
		// expect读取下面多行errors结果。
		expect(
			// 数组中包含一个合法text与一个非法image。
			validator.errors([
				// 第0项应通过，不产生无关错误。
				{ kind: "text", text: "a" },
				// 第1项kind命中image，但width=-1违反其minimum。
				{ kind: "image", width: -1 },
			]),
			// 数组索引从0计，所以错误位于/1/width，仅一条具体下界错误。
		).toEqual([{ path: "/1/width", keyword: "minimum", message: "expected >= 0" }]);
		// 未知video没有任何标签匹配，检查指向标签的范围提示。
		expect(validator.errors([{ kind: "video" }])).toEqual([
			// 该错误属于联合anyOf的解释启发式，keyword不改成type，列出text/image两个标签。
			{ path: "/0/kind", keyword: "anyOf", message: 'expected one of ["text","image"]' },
		]);
	});

	// Pointer转义例子用含/和~的字段，确认错误路径可无歧义指回原键；不是把键拆成嵌套对象。
	it("escapes ~ and / in paths as JSON Pointer does", () => {
		// 属性名a/b~c是一个完整字符串键，其值应为string。
		const validator = compile({ type: "object", properties: { "a/b~c": { type: "string" } } });
		// 输入1违反string，触发该字段类型错误。
		expect(validator.errors({ "a/b~c": 1 })).toEqual([
			// Pointer把/转~1、~转~0，得到/a~1b~0c，原始字段名没有被修改。
			{ path: "/a~1b~0c", keyword: "type", message: "expected string, got integer" },
		]);
	});

	// 引用例子把point放本地$defs，再由数组items引用；错误路径应落具体第二项缺x的位置。
	it("follows $ref into the referenced schema", () => {
		// 编译含根定义和子引用的普通规则对象。
		const validator = compile({
			// $defs声明point需对象/数值x且x必填，不是在输入里要求$defs字段。
			$defs: { point: { type: "object", properties: { x: { type: "number" } }, required: ["x"] } },
			// 根输入类型为array。
			type: "array",
			// #/$defs/point是同文档Pointer引用，Resolver本地查找，不发HTTP。
			items: { $ref: "#/$defs/point" },
		});
		// 第0项x=1合法，第1项空对象缺x，报告/1/x。
		expect(validator.errors([{ x: 1 }, {}])).toEqual([{ path: "/1/x", keyword: "required", message: "missing" }]);
	});
});

// 值处理分组检查undefined、Uint8Array、自有键与独立check函数，不执行coerce转换。
describe("values", () => {
	// undefined例子区分可选offset和必需path：自有属性存在但值undefined，在本库该属性检查中按缺省处理。
	it("treats a property set to undefined as absent", () => {
		// 复用read规则编译，未开启coerce。
		const validator = compile(read);
		// 可选offset显式undefined仍合法，path已给字符串。
		expect(validator.check({ path: "a.ts", offset: undefined })).toBe(true);
		// 必需path为undefined则拒绝，不因为Object有该键就满足required。
		expect(validator.check({ path: undefined })).toBe(false);
	});

	// bytes例子用真正Uint8Array检查长度/类型：4字节通过、5字节失败，普通数字数组也失败，并检查长度错误文案。
	it("checks bytes as Uint8Array with length bounds", () => {
		// data可省，但给出时必须是最多4长度的Uint8Array，这是本库扩展type。
		const validator = compile({ type: "object", properties: { data: { type: "bytes", maxLength: 4 } } });
		// new Uint8Array(4)创建长度4的零值字节，不是数字4这个用户值。
		expect(validator.check({ data: new Uint8Array(4) })).toBe(true);
		// 长度5超过4，check必须false。
		expect(validator.check({ data: new Uint8Array(5) })).toBe(false);
		// [1,2]虽也是数字序列，但不是Uint8Array，不能冒充bytes。
		expect(validator.check({ data: [1, 2] })).toBe(false);
		// 额外调用errors解释字节长度失败，不是再次转换输入。
		expect(validator.errors({ data: new Uint8Array(5) })).toEqual([
			// 字段/data报maxLength，文案单位bytes而非characters。
			{ path: "/data", keyword: "maxLength", message: "expected at most 4 bytes" },
		]);
	});

	// 对象排除例子验证Uint8Array不能同时按普通object规则直接放行。
	it("does not treat bytes as an object", () => {
		// 一个字节的实例仍不是本库type:object所接受的普通对象类别。
		expect(compile({ type: "object" }).check(new Uint8Array(1))).toBe(false);
	});

	// 原型同名字段例子要求自有constructor，并检查toString实际类型；不能把Object.prototype上的同名函数当用户字段值。
	it("checks properties named like Object.prototype members as own properties", () => {
		// 创建封闭对象规则，不依赖默认Object.prototype对象字典取值来决定type名。
		const validator = compile({
			// 只允许对象输入。
			type: "object",
			// constructor应string，toString若给出应number；这两者都是普通字段名。
			properties: { constructor: { type: "string" }, toString: { type: "number" } },
			// constructor必须作为输入自有字段存在。
			required: ["constructor"],
			// 拒绝其他未声明字段。
			additionalProperties: false,
		});
		// 空对象继承constructor也不算用户提供，必须失败。
		expect(validator.check({})).toBe(false);
		// 自有constructor字符串合法，省toString没问题。
		expect(validator.check({ constructor: "a" })).toBe(true);
		// 自有toString为字符串b不符number，应失败，而非跳过原型同名键。
		expect(validator.check({ constructor: "a", toString: "b" })).toBe(false);
	});

	// 未知类型名例子专门使用constructor，防止普通对象查表误拿原型函数当类型检查器。
	it("does not accept every value for a type named like an Object.prototype member", () => {
		// 不认识的type名不能让任意输入1通过，编译检查结果false。
		expect(compile({ type: "constructor" }).check(1)).toBe(false);
	});

	// 独立函数例子解构check交Array.filter，验证它无需绑定原Validator实例，且可作逐项谓词。
	it("checks a detached check function", () => {
		// 解构读取check函数属性，没有把errors方法也一起bind。
		const { check } = compile(read);
		// filter给两个对象，只有path字符串的那一个留下；校验不会读取真实文件。
		expect([{ path: "a" }, { path: 1 }].filter(check)).toEqual([{ path: "a" }]);
	});
});

// 选项分组展示format显式启用、预登记外部URI、缺引用报错以及draft7与现代draft的区别。
describe("options", () => {
	// format例子用同一email规则分别不传/传表，证明默认只是注解，开启后才检查语法。
	it("treats format as an annotation unless formats are given", () => {
		// schema普通对象，format:email不自动注册邮箱验证函数。
		const schema = { type: "string", format: "email" };
		// 没传formats时只检查string，所以明显非邮箱文字仍通过。
		expect(compile(schema).check("not an email")).toBe(true);
		// 显式{formats}采用email回调，非邮箱被拒绝。
		expect(compile(schema, { formats }).check("not an email")).toBe(false);
		// 正常a@example.com语法通过，没有发邮件验证可达性。
		expect(compile(schema, { formats }).check("a@example.com")).toBe(true);
	});

	// 外部URI例子先在options.schemas登记文档，Resolver按键取该对象；“外部”指另一schema资源，不是自动网络下载。
	it("resolves $ref to registered documents", () => {
		// point规则要求数值x且必填。
		const point = { type: "object", properties: { x: { type: "number" } }, required: ["x"] };
		// compile第一个参数给根引用，第二个给资源表。
		const validator = compile(
			// https URI只是资源标识，下面已经提供其本地内容。
			{ $ref: "https://example.com/point.json" },
			// 对象属性简写point放进URI键对应值，Resolver不访问example.com。
			{ schemas: { "https://example.com/point.json": point } },
		);
		// 有数值x通过引用目标检查。
		expect(validator.check({ x: 1 })).toBe(true);
		// 缺x失败，说明真的沿引用运行目标规则。
		expect(validator.check({})).toBe(false);
	});

	// 缺引用例子把compile包进箭头给toThrow，让断言框架捕获编译异常；不是先抛异常再把结果传给expect。
	it("throws for a $ref that names nothing", () => {
		// 未登记的绝对URI应抛Unresolved $ref，正则用\$匹配字面$。
		expect(() => compile({ $ref: "https://example.com/missing.json" })).toThrow(/Unresolved \$ref/);
		// 同文档不存在的Pointer也抛未解引用错误。
		expect(() => compile({ $ref: "#/$defs/missing" })).toThrow(/Unresolved \$ref/);
	});

	// draft差异例子同一schema含$ref和maxLength兄弟：draft7忽略兄弟，默认现代draft两者共同生效。
	it("applies draft 7 semantics: $ref overrides its siblings", () => {
		// 引用定义s接受任意string，兄弟maxLength1额外限制长度；ab用于区分两种draft行为。
		const schema = { definitions: { s: { type: "string" } }, $ref: "#/definitions/s", maxLength: 1 };
		// draft:"7"沿$ref忽略maxLength，ab通过。
		expect(compile(schema, { draft: "7" }).check("ab")).toBe(true);
		// 默认现代draft仍采用maxLength，ab长2而失败。
		expect(compile(schema).check("ab")).toBe(false);
	});
});

// schema分组测试外来TypeBox、冻结规则、有限递归输入以及坏规则异常，不声称任意循环JS输入都终止。
describe("schemas", () => {
	// TypeBox接入例子直接编译其构造输出，合法对象通过，错误数组项保留精确路径。
	it("compiles TypeBox schemas as they are", () => {
		// Type.Object/Array/String都先造规则，compile再生成实际检查器。
		const validator = compile(Type.Object({ name: Type.String(), tags: Type.Array(Type.String()) }));
		// name为a且tags空数组合法，没有minItems要求至少一项。
		expect(validator.check({ name: "a", tags: [] })).toBe(true);
		// tags里数字1违反item string规则，errors解释失败。
		expect(validator.errors({ name: "a", tags: [1] })).toEqual([
			// 路径/tags/0定位数组首项，不误归tags字段本身。
			{ path: "/tags/0", keyword: "type", message: "expected string, got integer" },
		]);
	});

	// 冻结例子先克隆并深冻结纯规则，再编译/check/errors，比较序列化前后；这只验证该规则与路径没有被改写，不是任意输入对象保真证明。
	it("compiles deep-frozen schemas and never modifies a schema", () => {
		// 对象展开复制block顶层再加$defs，structuredClone切断嵌套引用，deepFreeze只为测试约束规则可变性。
		const schema = deepFreeze(structuredClone({ ...block, $defs: { s: { type: "string", pattern: "^a" } } }));
		// 编译前保存JSON字符串快照，后面按字节文本比较。
		const before = JSON.stringify(schema);
		// 编译已冻结schema，不能靠往它上面写缓存属性工作。
		const validator = compile(schema);
		// 运行合法text分支检查。
		expect(validator.check({ kind: "text", text: "x" })).toBe(true);
		// 运行坏image分支错误解释，应只有width一条。
		expect(validator.errors({ kind: "image", width: -1 })).toHaveLength(1);
		// 规则序列化仍相同，说明此次操作没改JSON可见内容；冻结也会使非法直接写字段暴露为异常。
		expect(JSON.stringify(schema)).toBe(before);
	});

	// 递归schema例子用items:$ref:"#"回根，输入是三层有限树；不是把用户对象直接设成循环引用。
	it("compiles a recursive schema", () => {
		// tree变量保存普通对象规则，递归靠字符串引用，不靠JS对象自引用。
		const tree = {
			// 每层节点都需object。
			type: "object",
			// value为number，children若给出为数组，所有孩子再按根规则检查。
			properties: { value: { type: "number" }, children: { type: "array", items: { $ref: "#" } } },
			// 每个节点都必填value。
			required: ["value"],
		};
		// 编译器建立递归检查槽，返回可复用validator。
		const validator = compile(tree);
		// 三层value=1/2/3且结构正确，检查true。
		expect(validator.check({ value: 1, children: [{ value: 2, children: [{ value: 3 }] }] })).toBe(true);
		// 最深空对象缺value，错误应跟随children索引完整定位。
		expect(validator.errors({ value: 1, children: [{ value: 2, children: [{}] }] })).toEqual([
			// 两层children/0后定位缺value，而非只说根节点失败。
			{ path: "/children/0/children/0/value", keyword: "required", message: "missing" },
		]);
	});

	// 坏schema例子把properties.a设为数字，不是合法对象/布尔规则，应该在编译阶段抛错。
	it("throws for a malformed schema", () => {
		// 箭头延迟执行compile供toThrow捕获；正则匹配具体形状要求，不是测试用户值本身是否合法。
		expect(() => compile({ properties: { a: 1 } })).toThrow(/must be an object or a boolean/);
	});
});

// 测试专用deepFreeze<T>原样返回T，逐个冻结尚未冻结的非null对象并递归Object.values；例冻结克隆的block。会改对象可写性，非数据克隆；不遍历symbol/不可枚举字段，已冻结父也不再深入，不能当任意对象完整深冻结库。
function deepFreeze<T>(value: T): T {
	// 判断运行值能否遍历且尚未冻结；泛型T不保证对象形态，null也需单独排除；此helper处理测试数据。
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		// 先冻结当前对象，再读其可枚举值递归；这不是生产校验器的强制冻结步骤。
		Object.freeze(value);
		// Object.values取自有可枚举字符串键值，递归结果无需赋回，因为冻结是原地副作用；getter可能执行，当前输入为普通克隆规则。
		for (const child of Object.values(value)) deepFreeze(child);
	}
	// 返回原引用与原泛型类型T，不因冻结就自动把T改成Readonly<T>。
	return value;
}

// 未解引用分组区分默认编译抛错、reject在值实际出现处拒绝、coerce不凭缺引用猜类型和TypeBox Ref接入。
describe("unresolved references", () => {
	// dangling在可选字段t处引用不存在的本地定义。
	const dangling = { type: "object", properties: { t: { $ref: "#/definitions/Missing" } } };
	// external在同一位置引用未登记URI，同样不触发网络抓取。
	const external = { type: "object", properties: { t: { $ref: "https://example.com/schemas/t.json" } } };

	// 默认策略要求编译时发现缺引用就抛，哪怕当前尚无用户输入或t可选。
	it("throw when the schema compiles, by default", () => {
		// 本地缺定义错误包含原引用文字。
		expect(() => compile(dangling)).toThrow("Unresolved $ref #/definitions/Missing");
		// 绝对URI缺文档也在编译阶段抛出。
		expect(() => compile(external)).toThrow("Unresolved $ref https://example.com/schemas/t.json");
	});

	// reject策略把缺引用编成失败检查：字段不出现可通过，实际出现才拒绝，并能给定位到t的$ref错误。
	it("reject only values at their place with unresolvedRefs: reject", () => {
		// for...of分别验证本地和外部两份缺引用规则。
		for (const schema of [dangling, external]) {
			// 显式unresolvedRefs:reject切换策略，compile不再在这两种缺引用上直接抛错。
			const validator = compile(schema, { unresolvedRefs: "reject" });
			// t可选且未出现，缺引用子检查没有输入要处理，所以{}合法。
			expect(validator.check({})).toBe(true);
			// t实际出现值1，未知目标不能默许它通过。
			expect(validator.check({ t: 1 })).toBe(false);
		}
		// errors沿缺引用给具体字段与引用文字，而非用type错误猜测目标结构。
		expect(compile(dangling, { unresolvedRefs: "reject" }).errors({ t: 1 })).toEqual([
			// 错误归/t、keyword:$ref，引用文字保持原样。
			{ path: "/t", keyword: "$ref", message: "unresolved reference #/definitions/Missing" },
		]);
	});

	// 转换例子同时开reject与coerce：未解引用没有目标类型可转换，parse必须失败，不能把"1"凭空推成合法数字。
	it("leave values at their place uncoerced", () => {
		// 字面量coerce:true让返回类型带parse，reject仍保留缺目标失败。
		const validator = compile(dangling, { unresolvedRefs: "reject", coerce: true });
		// parse先尝试转换再实际check，得到下面ok:false结果；失败结果不暴露value。
		expect(validator.parse({ t: "1" })).toEqual({
			// ok:false是结果的判别标签，不是抛异常。
			ok: false,
			// 错误仍指/t的缺引用，不谎报数字解析或自动补定义成功。
			errors: [{ path: "/t", keyword: "$ref", message: "unresolved reference #/definitions/Missing" }],
		});
	});

	// TypeBox Ref例子直接传未提供定义A的schema，reject应同样在字段a处解释缺引用。
	it("reject a TypeBox Ref without its definition", () => {
		// Type.Ref("A")只造引用数据，不在此加载或注册A；coerce未开。
		const validator = compile(Type.Object({ a: Type.Ref("A") }), { unresolvedRefs: "reject" });
		// a给对象也不能让未知引用放行。
		expect(validator.errors({ a: { x: "1" } })).toEqual([
			// 路径/a，引用文字A保留，不把里面x:"1"擅自解释为某个未知字段类型。
			{ path: "/a", keyword: "$ref", message: "unresolved reference A" },
		]);
	});
});

// 字符串长度分组专门区分UTF-16码元、Unicode码点和代理对；不是终端显示列或用户可见字素计数。
describe("string lengths", () => {
	// 六个断言检查孤立高代理、合法代理对和倒序代理的码点长度。原输入字符串保持不改。
	it("count an unpaired high surrogate as one code point and a pair as one", () => {
		// 孤立高代理\ud800后加A，共两个码点，所以minLength2通过。
		expect(compile({ type: "string", minLength: 2 }).check("\ud800A")).toBe(true);
		// 同输入长2，maxLength1失败。
		expect(compile({ type: "string", maxLength: 1 }).check("\ud800A")).toBe(false);
		// 单独孤立高代理按一个码点处理，maxLength1通过。
		expect(compile({ type: "string", maxLength: 1 }).check("\ud800")).toBe(true);
		// 这里的U+1F600用两个UTF-16码元组成一个合法代理对，码点长度1，因此maxLength1通过。
		expect(compile({ type: "string", maxLength: 1 }).check("😀")).toBe(true);
		// 同一合法代理对不满足minLength2，不能按string.length的2放行。
		expect(compile({ type: "string", minLength: 2 }).check("😀")).toBe(false);
		// 低代理在前高代理在后无法组成合法一对，按两个独立码点计。
		expect(compile({ type: "string", minLength: 2 }).check("\udc00\ud800")).toBe(true);
	});
});

// 错误文本分组验证大型枚举提示截断/仍可接受尾项、contains边界文案和递归联合解释/memo路径。
describe("error messages", () => {
	// 枚举提示例子建5000个候选，合法末项能过，非法项提示仅列前20加剩余数；展示截断不等于枚举只收20项。
	it("list at most 20 enum values", () => {
		// Array.from回调把0..4999映成v0..v4999，_表示不用原占位值。
		const values = Array.from({ length: 5000 }, (_, i) => `v${i}`);
		// 规则要求对象字段e为string且属于大枚举。
		const validator = compile({ type: "object", properties: { e: { type: "string", enum: values } } });
		// 尾项v4999合法，证明检查未被提示上限截断。
		expect(validator.check({ e: "v4999" })).toBe(true);
		// v5000不在候选中，数组解构取第一条错误。
		const [error] = validator.errors({ e: "v5000" });
		// toBe逐字符比较下面生成的提示文本。
		expect(error.message).toBe(
			// 只JSON序列化前20个候选，去末尾]再加省略数4980；生成的是展示字符串，不是合法枚举JSON数据。
			`expected one of ${JSON.stringify(values.slice(0, 20)).slice(0, -1)}, ... and 4980 more]`,
		);
		// 再测小枚举无需省略，根级错误路径为空串。
		expect(compile({ enum: ["a", "b"] }).errors("c")).toEqual([
			// keyword为enum，提示完整列a/b。
			{ path: "", keyword: "enum", message: 'expected one of ["a","b"]' },
		]);
	});

	// 一万候选例子只检查合法末项是否接受，不是压力benchmark或所有规模的性能保证。
	it("accept a 10,000-value enum", () => {
		// 数字分隔符10_000就是10000，生成member0..member9999。
		const values = Array.from({ length: 10_000 }, (_, i) => `member${i}`);
		// member9999应通过，即便不在常见提示显示的前20项中。
		expect(compile({ enum: values }).check("member9999")).toBe(true);
	});

	// contains文案例子固定输入["a"]，变化匹配规则和上下界，分别触发至少/至多/区间文本，不改变数组内容。
	it("describe contains bounds in words", () => {
		// 局部at把传入子规则浅展开到type:array，取首条错误message；schema:object只是TS宽类型，不在此完整校验选项。
		const at = (schema: object) => compile({ type: "array", ...schema }).errors(["a"])[0]?.message;
		// a不符合number，缺省至少1匹配，给单数item提示。
		expect(at({ contains: { type: "number" } })).toBe("expected at least 1 matching item");
		// 要求至少2而实际0，给复数items。
		expect(at({ contains: { type: "number" }, minContains: 2 })).toBe("expected at least 2 matching items");
		// a符合string导致1匹配，但max0/min0只允许0，触发上限文案。
		expect(at({ contains: { type: "string" }, maxContains: 0, minContains: 0 })).toBe(
			// 预期“至多0匹配项”，不是“数组必须没有任何元素”。
			"expected at most 0 matching items",
		);
		// a不符合number且要求1..3匹配，触发区间文案。
		expect(at({ contains: { type: "number" }, minContains: 1, maxContains: 3 })).toBe(
			// 预期区间1到3文本，并非将a转换成数字再比较。
			"expected between 1 and 3 matching items",
		);
	});

	// oneOf错误选支例子定义递归过滤器：叶子field/eq，组合and数组；失败时选声明输入键较多的候选，输出内层eq类型与额外x错误，不倾倒其他分支缺字段。
	it("blame a oneOf failure on the branch that declares most of the object's properties", () => {
		// filter为可重复使用的规则数据。
		const filter = {
			// 根输入对象含可选where字段。
			type: "object",
			// where引用本地定义F，后面and的每项也引用同一定义。
			properties: { where: { $ref: "#/$defs/F" } },
			// $defs不是用户数据，而是可引用规则字典。
			$defs: {
				// F可为叶过滤条件或and组合。
				F: {
					// 此处是JSON Schema真oneOf关键字，要求恰好一支；与builder oneOf枚举函数不同。
					oneOf: [
						{
							// 第一支是对象叶节点。
							type: "object",
							// field和eq两键都要求string。
							properties: { field: { type: "string" }, eq: { type: "string" } },
							// 两键必填。
							required: ["field", "eq"],
							// 拒绝多余x等字段。
							additionalProperties: false,
						},
						{
							// 第二支是组合对象。
							type: "object",
							// and必须数组，每项递归按F判断。
							properties: { and: { type: "array", items: { $ref: "#/$defs/F" } } },
							// 组合对象必须给and，空对象不能冒充这个分支。
							required: ["and"],
							// 组合支也拒绝额外字段。
							additionalProperties: false,
						},
					],
				},
			},
		};
		// where外层按and支解释，数组首叶有eq=1和多余x；错误应准确穿过引用与联合。
		expect(compile(filter).errors({ where: { and: [{ field: "a", eq: 1, x: 2 }] } })).toEqual([
			// eq期望string却是integer，路径/where/and/0/eq。
			{ path: "/where/and/0/eq", keyword: "type", message: "expected string, got integer" },
			// 额外x单独报错，保留与类型错误并行的结果。
			{ path: "/where/and/0/x", keyword: "additionalProperties", message: "unknown field" },
		]);
	});

	// memo路径例子把同一个坏对象引用放a/b两处，两者通过同一$ref；不能复用只带/a路径的错误到/b。
	it("explain one object reached through the same reference at two paths at each path", () => {
		// schema先定义两个字段引用同一P。
		const schema = {
			// 根是object。
			type: "object",
			// a/b两位置都引用#/$defs/P，不是两份独立拷贝的定义。
			properties: { a: { $ref: "#/$defs/P" }, b: { $ref: "#/$defs/P" } },
			// P要求若有n必须integer，当前未声明required:n。
			$defs: { P: { type: "object", properties: { n: { type: "integer" } } } },
		};
		// 共享对象n:x违反integer，后面两个字段确实引用同一个JS对象身份。
		const shared = { n: "x" };
		// 一次errors应给两个路径，不因memo命中而省第二处或复制错path。
		expect(compile(schema).errors({ a: shared, b: shared })).toEqual([
			// a处错误为/a/n。
			{ path: "/a/n", keyword: "type", message: "expected integer, got string" },
			// 同样坏对象在b处必须是/b/n，而非再次/a/n。
			{ path: "/b/n", keyword: "type", message: "expected integer, got string" },
		]);
	});
});

// 格式附加项分组验证可选表中的url和json-pointer-uri-fragment，普通format默认注解行为已由前面options组测试。
describe("TypeBox's extra formats", () => {
	// URL只检查解析语法，Pointer片段只检查写法；不访问网络或在某份JSON里实际寻址。
	it("check url and json-pointer-uri-fragment", () => {
		// 显式传formats才启用url条目。
		const url = compile({ type: "string", format: "url" }, { formats });
		// 示例https URL语法可解析，不代表目标站点可访问。
		expect(url.check("https://example.com/a?b=1")).toBe(true);
		// 普通文字不是URL，false。
		expect(url.check("not a url")).toBe(false);
		// 再编URI片段Pointer格式，要求#开头并符合转义语法。
		const fragment = compile({ type: "string", format: "json-pointer-uri-fragment" }, { formats });
		// #/a/b~1c合法，~1表示Pointer键中的/转义。
		expect(fragment.check("#/a/b~1c")).toBe(true);
		// 未经编码的空格不符合本格式实现。
		expect(fragment.check("#/a b")).toBe(false);
		// /a可作为普通JSON Pointer，但缺URI片段#，本条检查false。
		expect(fragment.check("/a")).toBe(false);
	});
});
