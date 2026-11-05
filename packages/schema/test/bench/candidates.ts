// 把8个默认候选适配成prepare/check接口供基准调用，另提供TypeBox解释器；使用这里选定的布尔路径比较，不证明每库任意配置都最快或所有规则语义完全一致。
// The validators the benchmarks compare, each behind the same interface: compile a schema, then check values.
// Every library is used through its fastest boolean path and keeps the object it returns, as an application would.
// Run the benchmarks through `npm run bench`, which sets ATA_NO_NATIVE=1: ata-validator's optional native addon only
// serves its buffer APIs, and the verdicts measured here are JavaScript either way.

// 取CfWorker的Validator并本地改名，避免和其他库同名；导入是真实运行时加载，不是type-only。
import { Validator as CfValidator } from "@cfworker/json-schema";
// omptype的JSON Schema导入器返回可校验对象，后面用allows布尔路径，不调用完整错误输出。
import { fromJsonSchema } from "@oh-my-pi/omptype";
// Ajv默认入口提供draft-7类；它是CommonJS导出，后面从导入值.default取类型声明对应的类。
import Ajv7Module from "ajv";
// 单独导入2020-12实现，不把两个draft都交默认Ajv类。
import Ajv2020Module from "ajv/dist/2020.js";
// 本机依赖内的draft-07元schema JSON，type:json是模块属性，不是从URI在线下载规范。
import draft07MetaSchema from "ajv/dist/refs/json-schema-draft-07.json" with { type: "json" };
// Ajv格式插件按开关注册它自己的检查，不接收下方Pi的formats回调表。
import addFormatsModule from "ajv-formats";
// ATA入口会加载其JS运行模块/注册懒加载逻辑；可选native供相关API首次需要时加载，这里的对象布尔路径不是buffer native API。
import { Validator as AtaValidator } from "ata-validator";
// TypeBox Compile造Validator，可能生成代码或走解释器，取决于库实际环境能力与Settings。
import { Compile } from "typebox/compile";
// 两项reset清TypeBox本次构建的全局函数/外部值累积表，不是清所有库的编译缓存。
import { ResetExternal, ResetFunctions } from "typebox/schema";
// Settings是TypeBox模块级可变设置，后面改变的是共享状态，不是每validator独立的选项对象。
import { Settings } from "typebox/system";
// Pi compile是真实运行函数；type两项只约束规则/格式回调静态类型，JS中不加载对应类型值。
import { compile, type FormatCheck, type JsonSchema } from "../../src/index.ts";
// 手写Zod适配助手：固定案例身份Map、corpus子集构建、规范导入分开；不保证三种路线完整语义相同。
import { nativeCases, nativeZod, zodFromJsonSchema } from "./zod.ts";

/** How a benchmark compiles a schema. */
// 统一准备选项只是静态契约；各适配器只使用自己代码读取的字段，不意味着所有库都支持这些选项的全部含义。
export interface PrepareOptions {
	// draft只能填两种字面量，实际是否/怎样交到库见每个prepare。
	readonly draft: "2020-12" | "7";
	// 可选URI→规则表，readonly只限制TS写入；不是远程下载器，也不深冻结规则。
	readonly schemas?: Readonly<Record<string, JsonSchema>>;
	// 可选Pi格式表；有的库用原回调，有的只用“是否提供”作开关，也有适配器忽略它。
	readonly formats?: Readonly<Record<string, FormatCheck>>;
	/** The schema is a JSON-Schema-Test-Suite schema (for libraries that take native schemas otherwise). */
	// suite标记规范用例，当前主要让Zod换用fromJSONSchema，未改变每个候选的所有配置。
	readonly suite?: boolean;
}

/** A compiled schema: its boolean check and the object the library returned (kept alive by the caller). */
// 准备后的对象同时携带布尔入口与库返回对象，便于memory基准保留真实所有者，而非只留下一个包装函数。
export interface Prepared {
	// check静态接unknown并返回boolean，readonly不限制函数内部状态或保证它不抛；类型不会把库返回值强制转布尔。
	readonly check: (value: unknown) => boolean;
	// 各库返回对象不同，用unknown承载；需具体访问时再按实际类型收窄，未做深复制。
	readonly validator: unknown;
}

/** A library under comparison. */
// 一个候选由展示名与准备函数组成，接口不自己运行基准、计时或捕获异常。
export interface Candidate {
	// 名字用于结果列/索引，不由字符串决定真实引擎实现。
	readonly name: string;
	// prepare接规则和选项返回Prepared；函数可分配缓存、改变库内部状态或抛错，无自动Promise等待。
	readonly prepare: (schema: JsonSchema, options: PrepareOptions) => Prepared;
}

/** Whether this process runs with code generation from strings disabled, as under a strict CSP. */
// 导入时仅查execArgv是否含这个精确旗标，不运行eval能力探测；不能据false证明所有CSP/宿主环境都允许生成代码，后面也不会动态重算此常量。
export const noEval = process.execArgv.includes("--disallow-code-generation-from-strings");

// Pi候选包装，不在对象创建时compile任意业务规则。
const piSchema: Candidate = {
	// 结果展示名固定pi-schema。
	name: "pi-schema",
	// 准备Pi：原样交schema/options给compile并返回check及validator，例布尔规则准备后check(true)。会按Pi语义编译/缓存，失败直出，不在此计时或校验输入样本。
	prepare(schema, options) {
		// Pi能直接使用统一选项中的draft/本地schemas/格式回调；多出的suite字段不在此删除或自动转成其他语义。
		const validator = compile(schema, options);
		// 保留同一个validator及其check引用，没有再包一层值转换。
		return { check: validator.check, validator };
	},
};

// TypeBox keeps its last build in module-level accumulators; reset them so no build state is retained between schemas.
// 准备TypeBox：先设加速选择→Compile(context,schema)→finally清构建表并设true，返回Validator。例accelerate=false选择解释检查；会改共享Settings，Compile错误照常传播。最终固定true，非恢复调用前状态。
function typeboxCompile(schema: JsonSchema, options: PrepareOptions, accelerate: boolean) {
	// 改变模块共享useAcceleration；这一步在try前，若它自身抛错不会进入下面finally。
	Settings.Set({ useAcceleration: accelerate });
	// try只包Compile，正常return或throw都先执行finally，清理本身若抛仍会传播。
	try {
		// 无schemas用新空上下文；两处as never仅绕过TypeBox更窄静态类型，不改运行值或验证规则。这里只传引用表/规则，不传统一draft或formats。
		return Compile((options.schemas ?? {}) as never, schema as never);
		// finally在返回前运行，不会把成功Validator替换成reset函数的返回值。
	} finally {
		// 清构建函数名/代码的模块表，已返回validator自身持有的构建结果不在这里逐个销毁。
		ResetFunctions();
		// 换掉构建外部值累积数组，非清所有已有validator的上下文。
		ResetExternal();
		// 无论accelerate原值是什么都设置true，没有保存/恢复调用前其他设置。
		Settings.Set({ useAcceleration: true });
	}
}

// 默认TypeBox候选仍请求加速，由库Environment.CanEvaluate实际判断能否使用。
const typebox: Candidate = {
	// 显示名按脚本noEval标记变化，名称本身不执行或验证解释器回退。
	name: noEval ? "typebox (no eval: interpreter)" : "typebox",
	// 默认prepare以accelerate=true交助手，返回Check包装及原validator；例check(false)委托该规则。会编译/改临时共享设置，异常不在这里捕获。
	prepare(schema, options) {
		// 即使noEval标签为真也传true，库会自行探测受限环境并选择后备。
		const validator = typeboxCompile(schema, options, true);
		// 箭头保持validator作为方法接收者，Check给布尔判决；不会执行Convert/Parse或生成错误数组。
		return { check: (v) => validator.Check(v), validator };
	},
};

// 显式解释器候选只放byName，供memory额外测量，不在默认八候选数组中重复一列。
const typeboxInterpreter: Candidate = {
	// 名字与默认typebox区分，不依赖noEval拼展示后缀。
	name: "typebox interpreter",
	// 显式prepare传false来禁这次schema加速，再委托Check；返回保原validator，错误直出。此选择不等于整库从不探测Function能力。
	prepare(schema, options) {
		// TypeBox内部首次CanEvaluate仍可能尝试能力探测，真正检查选解释路线；结束共享开关仍由助手设true。
		const validator = typeboxCompile(schema, options, false);
		// 和默认候选同样保持实例调用，只改变准备时的加速选择。
		return { check: (v) => validator.Check(v), validator };
	},
};

// CfWorker适配将其结果对象的valid取为公共布尔路径。
const cfworker: Candidate = {
	// 表格名字固定，不表示代码实际在Cloudflare Worker进程运行。
	name: "cfworker",
	// 创建CfWorker→加本地引用文档→返回validate(v).valid；例draft7带一个URI表。会建立库的引用查找状态，错误直出；没有把Pi formats表交给它或在线抓取URI。
	prepare(schema, options) {
		// 第三参数true启用shortCircuit；as never只适配库schema类型，不检查输入形状，draft按选项传入。
		const validator = new CfValidator(schema as never, options.draft, true);
		// 缺schemas用空表，Object.entries逐个给addSchema(schema,uri)，URI是索引键而非要联网访问的地址。
		for (const [uri, remote] of Object.entries(options.schemas ?? {})) validator.addSchema(remote as never, uri);
		// validate运行后取valid，忽略错误细节；validator原对象另保以供内存测量。
		return { check: (v) => validator.validate(v).valid, validator };
	},
};

// omptype compiles with new Function on the first allows() call. Without eval that call throws EvalError once per
// schema; omptype then keeps validating through its interpreter, so the benchmark absorbs that one throw.
// omptype候选有专门的noEval预热分支，普通准备不先调用allows。
const omptype: Candidate = {
	// 展示名来自execArgv标记，不在这里查询库的实际引擎。
	name: noEval ? "omptype (no eval: interpreter)" : "omptype",
	// 由JSON Schema构造omptype规则，noEval时先allows(null)消化首次EvalError，再返回包装。例正常布尔规则check(true)；导入/检查可能抛，未使用统一options的draft/schemas/formats。
	prepare(schema) {
		// 真实fromJsonSchema解析规则并可因无法表示或无法解析引用失败；不先把Pi的引用表注入。
		const validator = fromJsonSchema(schema);
		// 只有脚本检测到精确禁代码生成旗标才预调用一次。
		if (noEval) {
			// 此try仅围预热allows，不含fromJsonSchema或后续每次check。
			try {
				// null只是预热输入，结果布尔被丢弃；并不要求null符合当前schema。库首次allows会准备专用布尔检查。
				validator.allows(null);
				// 捕获预热抛值，下一行只放行一种异常。
			} catch (error) {
				// 只吞本realm EvalError。已读库在构建前先发布WeakMap后备包装，首次生成失败后后续可用解释路径；这层不把其他错误当禁eval。
				if (!(error instanceof EvalError)) throw error;
			}
		}
		// 返回allows方法包装及实例，不给后续检查再加catch，也不把异常变成false。
		return { check: (v) => validator.allows(v), validator };
	},
};

// Ajv's CommonJS modules export the class as module.exports and as `default`; the latter is what its types describe.
// 当前CommonJS导出对象/函数带.default属性，这里取2020类，非创建实例或运行编译。
const Ajv2020 = Ajv2020Module.default;
// 同样取draft-7构造器。
const Ajv7 = Ajv7Module.default;
// 格式插件从.default取函数，后面只在formats开关为真时调用。
const addFormats = addFormatsModule.default;
// typeof在类型位置取得构造器类型，InstanceType推实例类型；不在运行时调用Ajv2020。
type AjvInstance = InstanceType<typeof Ajv2020>;

// One Ajv per draft, as an application keeps it. Ajv2020 also gets the draft-07 meta-schema, so tool schemas that
// declare draft-07 compile. strict: false so schemas written for other tools compile; logger: false keeps Ajv from
// printing generated code when compiling fails without eval.
// newAjv按draft选类、关严格策略/日志、按开关启格式并给2020实例加draft7元schema，返回新实例。例draft7/false不加插件；会建立库状态，异常直出，不从网络加载schema。
function newAjv(draft: "2020-12" | "7", formats: boolean): AjvInstance {
	// formats是布尔开关，logger:false as const只使TS保留false字面量；strict:false不等于所有坏schema都会通过。
	const options = { strict: false, validateFormats: formats, logger: false as const };
	// draft严格等于7选Ajv7，否则选2020类；是否有schema声明不改变这行选类。
	const ajv = draft === "7" ? new Ajv7(options) : new Ajv2020(options);
	// 2020实例登记draft-07元schema以允许识别该标识，不等于把此实例整个校验词汇切换成draft7引擎。
	if (draft !== "7") ajv.addMetaSchema(draft07MetaSchema);
	// 开关为真才安装ajv-formats自己的格式/关键词，不把Pi传进来的FormatCheck函数逐个注册。
	if (formats) addFormats(ajv);
	// 返回实例原引用，未冻结/克隆它。
	return ajv;
}

// 按draft与格式开关字符串强缓存Ajv实例；本模块存活且条目未删时会强持有，不是WeakMap，也没有逐次prepare后清理。
const sharedAjv = new Map<string, AjvInstance>();

// Ajv compiles with new Function and has no interpreter: without eval, compile() throws EvalError.
// Ajv候选在prepare编译，再用返回的函数检查；禁eval时实际编译失败由外层基准决定怎样统计。
const ajv: Candidate = {
	// noEval仅改变展示名，不在这里提前拒绝或伪造false判决。
	name: noEval ? "ajv (no eval: fails)" : "ajv",
	// 准备Ajv：无schemas复用配置实例、有schemas每次新建并登记文档，最后compile返回包装。例相同draft且无引用表复用实例；会修改缓存/库注册表，getSchema/compile错误可传播，只有addSchema局部吞错。
	prepare(schema, options) {
		// 先声明实例变量，后面两条准备路径分别赋值，类型不创建对象。
		let instance: AjvInstance;
		// 只在严格undefined时走共享；显式空{}也会进入独立实例分支。
		if (options.schemas === undefined) {
			// key只区分draft和formats是否提供，不按具体格式函数内容或每个schema生成key。
			const key = `${options.draft} ${options.formats !== undefined}`;
			// 已有实例就复用，缺省才new；formats空表仍视作启格式。
			instance = sharedAjv.get(key) ?? newAjv(options.draft, options.formats !== undefined);
			// 存回强Map，复用实例会累积Ajv自己的规则/引用/编译状态。
			sharedAjv.set(key, instance);
			// 显式传本地schemas表时独立建实例，避免不同规范组重复$id互相冲突。
		} else {
			// The suite reuses $ids across groups, which one shared instance would reject: a fresh one per schema.
			// 每次prepare都新建，不按表对象身份共享。
			instance = newAjv(options.draft, options.formats !== undefined);
			// 枚举本地URI/schema映射，未使用compileAsync的联网加载机制。
			for (const [uri, remote] of Object.entries(options.schemas)) {
				// Ajv ships its own meta-schemas; adding them again under the same id throws.
				// 先getSchema查库是否已识别该URI，它自己可能懒编译或抛；此调用不在下面addSchema的catch内。
				if (instance.getSchema(uri) === undefined) {
					// try仅覆盖addSchema一行。
					try {
						// as object不转换boolean/schema值，交真实addSchema登记；该函数可能因重复$id等多种原因抛。
						instance.addSchema(remote as object, uri);
						// catch不筛异常种类，任意addSchema抛错都吞，不只英文提到的重复键情形。
					} catch {
						// A remote whose $id Ajv already registered under another key.
					}
				}
			}
		}
		// 对根schema实际compile，可能生成Function/缓存，错误向外传播；as object没有运行时验证作用。
		const validator = instance.compile(schema as object);
		// 调用校验函数再as boolean仅改静态视图，不做Boolean(...)转换；若库给异步校验，Promise不会被自动await/变布尔，本基准用正常同步规则。
		return { check: (v) => validator(v) as boolean, validator };
	},
};

// ata-validator: its defaults fill `default` values into the input and assert `format`; both are turned off to match
// the other candidates (format checks only in the format run, with its own checks). It reads the draft only from
// $schema, so a draft 7 schema without one gets it declared.
// ATA助手接规则/统一选项/可选解释器选择，补缺省draft7声明、关defaults、配置格式开关/本地引用并返回实例。例draft7的无$schema对象会浅加声明；不改原对象字段，库后续可能懒编译，错误直出。
function ataValidator(schema: JsonSchema, options: PrepareOptions, engine: "interpreter" | undefined) {
	// declared保存要交ATA的规则，可能是新顶层对象或原schema引用。
	const declared =
		// 只有选7、规则为object且原型链上也没有$schema时才补；现有$schema不会被选项强制覆盖。
		options.draft === "7" && typeof schema === "object" && !("$schema" in schema)
			? // 浅拷贝顶层并放draft7 URI，子规则仍共享引用，不是深克隆整个图。
				{ $schema: "http://json-schema.org/draft-07/schema#", ...schema }
			: // 其他情况保原规则，包括布尔schema。
				schema;
	// new ATA实例但本机版本会把多项编译工作留到后面检查，不把构造返回等同全部热路径已编好。
	return new AtaValidator(declared, {
		// 关默认值填充，避免因default注解改变普通样本；不在这里做额外数据复制。
		useDefaults: false,
		// 只用formats是否undefined开启ATA自己的格式断言，没有把传入Pi格式回调表交ATA。
		assertFormat: options.formats !== undefined,
		// 本地引用表缺省新空对象，as Record只改TS视图，不把布尔引用规则转换成对象或远程获取文档。
		schemas: (options.schemas ?? {}) as Record<string, object>,
		// 关ATA logger，不吞异常，也不保证第三方其他全局诊断都消失。
		logger: false,
		// undefined就不传engine键，交库默认/宿主策略；interpreter才显式传，不是把undefined强改auto文字。
		...(engine === undefined ? {} : { engine }),
	});
}

// Generated code, or its interpreted engine where code generation is blocked.
// 默认ATA候选未显式指定引擎，实际由库能力/宿主配置选择。
const ata: Candidate = {
	// noEval展示后缀不是实际engine()查询结果，也不切换整个包的所有API行为。
	name: noEval ? "ata (no eval: interpreter)" : "ata",
	// 准备ATA默认对象路径：调用助手后返回isValidObject包装及实例。例check(true)按规则返回判决，可能在首次检查才懒编译；不在此调用buffer native API或主动捕获失败。
	prepare(schema, options) {
		// 传undefined省engine选项，和下面显式interpreter分开测量。
		const validator = ataValidator(schema, options, undefined);
		// 实例方法保持this，返回布尔判决，不创建完整错误列表或主动用默认值转写输入。
		return { check: (v) => validator.isValidObject(v), validator };
	},
};

// Its eval-free engine, a tree of closures, chosen explicitly: what it runs on for schemas from outside.
// 另一个ATA候选显式选择解释器，不通过展示名自动改变共享环境。
const ataInterpreter: Candidate = {
	// 表格列和名称索引都用ata interpreter，与默认ata分列。
	name: "ata interpreter",
	// 准备ATA解释器：同样补声明/关defaults，但传engine:interpreter，再返回实例判决。例与默认候选可测同一对象，不修改默认候选设置；失败照常传播。
	prepare(schema, options) {
		// engine明确约束此validator的对象检查路线，不等于卸载包模块或关闭其他库的代码生成。
		const validator = ataValidator(schema, options, "interpreter");
		// 布尔入口仍是isValidObject，保留完整validator供memory持有。
		return { check: (v) => validator.isValidObject(v), validator };
	},
};

// Zod: native Zod schemas for the speed cases and the corpus, z.fromJSONSchema only for the suite. Its object parser
// generates code with new Function when it can and parses without it otherwise; safeParse is its boolean path.
// Zod候选比较safeParse.success，解析输出转换/剥未知字段不作为此层等价断言。
const zod: Candidate = {
	// noEval改显示后缀，真实Zod是否生成代码/退回由库处理，不在此探测。
	name: noEval ? "zod (no eval: no JIT)" : "zod",
	// Zod准备按suite走规范导入，否则先查固定schema身份Map、缺失再构建corpus子集；返回safeParse布尔包装。例原固定schema可复用原生实例，复制一份规则不会身份命中；构造/解析可抛，不保证任意JSON Schema都受支持。
	prepare(schema, options) {
		// suite真值才选第一分支；接口写boolean，但JS运行时本行未另做===true验证。
		const validator = options.suite
			? // 规范用zodFromJsonSchema并传默认draft，不把options.schemas远程表传过去。
				zodFromJsonSchema(schema, options.draft)
			: // ??仅Map没有实例时才调用nativeZod；as Record不校验任意传入规则是该子集，不比较schema内容相等。
				(nativeCases.get(schema) ?? nativeZod(schema as Record<string, unknown>));
		// 只取success，不使用解析后的data/错误数组；safeParse仍可能因规则构造问题/用户回调等抛，当前不catch。
		return { check: (v) => validator.safeParse(v).success, validator };
	},
};

/** Every candidate, ours first. */
// 八个默认候选按固定顺序导出，readonly只限制TS对数组的写操作，不冻结数组或实例；显式TypeBox解释器稍后仅加入byName。
export const candidates: readonly Candidate[] = [piSchema, typebox, ajv, ata, ataInterpreter, zod, cfworker, omptype];

/** Candidates by name, including TypeBox's interpreter (what TypeBox runs when eval is unavailable). */
// 名称索引额外收TypeBox解释器，ReadonlyMap不冻结运行Map；构建时只存对象，不调用prepare。
export const byName: ReadonlyMap<string, Candidate> = new Map(
	// 去掉名字第一个“ (”后的展示后缀，使noEval时仍能按ajv等基础名查；同基础名会被Map后项覆盖，本列表预期各名唯一。
	[...candidates, typeboxInterpreter].map((c) => [c.name.split(" (")[0], c]),
);
