/**
 * 把schema规则编成Validator：check只作布尔校验/类型收窄，errors在失败时生成解释，coerce:true才附加转换与parse。
 * 例const v=compile(obj({n:int()}),{coerce:true}); v.parse({n:"2"})可得ok:true和{n:2}；v.check({n:"2"})仍失败。
 * 上游通常是模型工具参数/配置等unknown数据；Compiler负责组闭包，Resolver处理本地注册的引用，不会按URI联网抓schema。
 * 这里保存schema/options原引用，没有冻结/克隆；调用方不应在编译后任意修改它们，否则延迟创建的解释/转换可能读到不同规则。
 */
// compile(): a schema to a Validator, whose `check` is the fast boolean path and whose `errors` explains failures.

// Static是从builder/TypeBox规则推值类型的纯TS运算，import type运行时擦除。
import type { Static } from "./builders.ts";
// Coercer执行三轮转换，按变化路径复制；check路径不会顺便调用它。
import { Coercer } from "./coerce.ts";
// Compiler建校验闭包；RESTART是私有约定的symbol哨兵，要求按动态引用作用域重新编译。
import { Compiler, RESTART } from "./compiler.ts";
// Explainer只给失败值解释错误，不取代布尔检查器。
import { Explainer } from "./explain.ts";
// 公开类型仅约束编译期，unknown输入仍需实际check，ParseResult按ok判别。
import type { Check, CompileOptions, JsonSchema, ParseResult, ValidationError } from "./types.ts";

/**
 * Compiles `schema` into a Validator. Throws if the schema is malformed or a `$ref` names nothing (register other
 * documents with `options.schemas`). The schema is read, never modified. With `coerce: true` the validator also
 * coerces and parses loosely typed input.
 */
// compile重载一：明确字面量coerce:true时，TS让返回值带coerce/parse。例compile(str(),{coerce:true}).parse(1)。声明签名本身不执行逻辑。
export function compile<S extends JsonSchema>(
	// S extends JsonSchema保留传入schema类型，供Static<S>推导；不是把S当用户值类型。
	schema: S,
	// &把编译选项与必需的readonly coerce:true合并；不是任意boolean都能命中这个重载。
	options: CompileOptions & { readonly coerce: true },
	// 返回带推导值类型的CoercingValidator，重载行以分号结束，没有函数体。
): CoercingValidator<Static<S>>;
// compile重载二：不传选项/未在类型上明确true时，公开返回普通Validator；运行时传入true仍由下面实现决定对象类别。
export function compile<S extends JsonSchema>(schema: S, options?: CompileOptions): Validator<Static<S>>;
// compile唯一运行实现：先编检查，再按严格true选验证器。例普通compile(str()).check(1)为false；非法schema/未解引用可在编译时抛错，不访问网络。
export function compile<S extends JsonSchema>(
	// schema仍按S保存，运行时不是由TS泛型验证schema文档完整合法性。
	schema: S,
	// 没传options才用共享空对象；默认参数不处理显式null等违反类型的JS调用。
	options: CompileOptions = NO_OPTIONS,
	// 实现签名允许返回两类对象，调用方看到的是上面的重载；|是类型联合而不是运行时二选一操作。
): Validator<Static<S>> | CoercingValidator<Static<S>> {
	// 把规则编成unknown→boolean闭包，可复用于多次输入；不在此检查某个用户值。
	const check = compileCheck(schema, options);
	// 运行时只认coerce严格等于true，不因为truthy就开启转换API。
	return options.coerce === true
		? // 需要转换时构造子类，复用刚编好的同一check；尚未构造Coercer。
			new CoercingValidator(schema, options, check)
		: // 否则普通Validator，保留schema/options及check，不带parse/coerce方法。
			new Validator(schema, options, check);
}

// 空选项只创建一次并浅冻结，避免默认对象被意外加字段；传入的外部options不因此冻结。
const NO_OPTIONS: CompileOptions = Object.freeze({});

/** A compiled schema whose valid values have type `T` (`unknown` unless the schema was built with the builders). */
// Validator<T>把运行检查与静态值类型关联；T默认unknown。例obj生成的字段可在if(v.check(x))后被TS访问，界限仍取决于规则/类型是否匹配。
export class Validator<T = unknown> {
	/** Whether `value` is valid. A plain function: it may be passed around without its validator. */
	// 函数属性不是依赖this的方法，可const {check}=v后单独调用；value is T是成功分支类型谓词，不是自动转换。
	readonly check: (value: unknown) => value is T;
	// protected让子类可读schema，readonly只禁该字段重赋，不深冻结schema对象。
	protected readonly schema: JsonSchema;
	// 同样保留选项原引用，供延迟解释/转换重新建Compiler。
	protected readonly options: CompileOptions;
	// 私有解释器初始缺失，只有首次失败调用errors才分配；|undefined配合??=懒初始化。
	private explainer: Explainer | undefined = undefined;

	// 构造器保存一份已编check及原规则/选项，不主动运行某个输入。例compile内部new Validator(schema,options,check)；手工构造者也要保证三者语义一致。
	constructor(schema: JsonSchema, options: CompileOptions, check: Check) {
		// A compiled check is exactly the test that a value has the schema's static type.
		// as把“此check对应T”的约定交给TS，不在运行时证明T，也不添加检查或复制函数；规则与品牌不一致仍会破坏类型承诺。
		this.check = check as (value: unknown) => value is T;
		// 保存规则原引用，不把它变成可执行代码字符串。
		this.schema = schema;
		// 保存选项原引用，供后续errors/coerce使用。
		this.options = options;
	}

	/**
	 * Why `value` is invalid: one error per failing keyword, `[]` when it is valid. Built on the first failure and
	 * kept, so a validator whose values always pass never pays for it.
	 */
	// errors先用快速check：通过返回[]；失败才按需建Explainer再遍历规则。例缺path给/path+required。可能再次调用format等用户回调，异常不在本方法吞掉；并非保证无副作用。
	errors(value: unknown): ValidationError[] {
		// 合法值只创建空错误数组，不付解释器构建成本。
		if (this.check(value)) return [];
		// ??=仅为null/undefined创建；新的Compiler为解释遍历服务，不直接拿check闭包反编译规则。
		this.explainer ??= new Explainer(compiler(this.schema, this.options), this.schema);
		// 返回可读错误列表，具体标签/路径/分支选择由Explainer决定；动态引用的错误说明存在近似范围。
		return this.explainer.errors(value);
	}
}

/** A validator compiled with `coerce: true`: it also coerces loosely typed input towards the schema. */
// 子类继承check/errors，额外支持coerce和parse。泛型T跟随父类，不因转换就保证返回值合法，parse仍必须校验。
export class CoercingValidator<T = unknown> extends Validator<T> {
	// 转换器按首次coerce/parse惰性创建，后续复用；单次调用的临时memo由Coercer自身清理。
	private coercer: Coercer | undefined = undefined;

	/**
	 * `value` coerced towards the schema: numeric strings to numbers, `"true"` to `true`, a single value to a one-item
	 * array, an optional `null` dropped, the first union branch the value converts to (the README lists every rule).
	 * Only the changed paths are copied; `value` comes back itself when nothing changes, and is never modified. Values
	 * that cannot be coerced stay as they are. The rules are built on the first call.
	 */
	// coerce只尽量转换，不承诺合法T：例字符串"2"可转整数2，无法转换的坏值可原样留下。无变化时可保留原引用；变化路径复制，输入不直接修改，回调自身副作用另计。
	coerce(value: unknown): unknown {
		// 初次创建转换器及配套Compiler，??=避免每次重新分配；编译错误/format异常并非总被这里兜底。
		this.coercer ??= new Coercer(compiler(this.schema, this.options), this.schema);
		// 按Coercer规则执行，结果类型unknown提醒调用方不能跳过check。
		return this.coercer.coerce(value);
	}

	/** Coerces `value`, then checks it: the coerced value when it is valid, else its errors. */
	// parse流程是转换→check→成功值或错误；例{n:"2"}先变{n:2}才校验。失败errors对应转换后对象，不是原输入；并非抛异常的JSON.parse。
	parse(value: unknown): ParseResult<T> {
		// 先得到转换结果，保留为unknown直到check类型谓词收窄。
		const coerced = this.coerce(value);
		// 三元成功分支coerced收窄为T；失败分支this.errors会先再check一次再解释，用户回调不保证只执行一遍。
		return this.check(coerced) ? { ok: true, value: coerced } : { ok: false, errors: this.errors(coerced) };
	}
}

// compileCheck连接编译器选择与根检查生成；例compile传的整份规则从root入口编译，无输入数据/IO。
function compileCheck(schema: JsonSchema, options: CompileOptions): Check {
	// 普通Compiler可能已有root缓存；动态重启返回的新Compiler在这里真正编根，不保证这是全流程唯一一次root调用。
	return compiler(schema, options).root();
}

// Most schemas compile without tracking the dynamic scope; one with a bookended $dynamicRef compiles again with it.
// compiler先按无动态作用域尝试，只有精确RESTART哨兵才换动态版；例跨资源bookended $dynamicRef需要运行时scope，其余编译错误原样抛出。
function compiler(schema: JsonSchema, options: CompileOptions): Compiler {
	// 第三参数false关闭动态scope跟踪，不是关闭$ref解析或所有递归支持。
	const plain = new Compiler(schema, options, false);
	// 只包首次root构建；构造Compiler本身的异常不在此try里。
	try {
		// 先尝试实际编译根，遇动态需求由bookended抛RESTART，其他错误也可能在此出现。
		plain.root();
		// 普通编译成功就复用该Compiler及已建缓存，不再创建第二份。
		return plain;
		// catch可能接到任意抛出值，下面按哨兵身份而非错误文字判断。
	} catch (error) {
		// 不是完全相同的symbol就重抛，不把真实规则错误误当重试理由。
		if (error !== RESTART) throw error;
		// 动态版从头新建；这里只构造未root()，后续调用者负责使用/编译，不复用半完成的普通版缓存。
		return new Compiler(schema, options, true);
	}
}
