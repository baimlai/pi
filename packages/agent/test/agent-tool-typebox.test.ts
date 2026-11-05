// 检查AgentTool能从TypeBox式schema类型推导工具参数；本文件手写兼容形状，不导入TypeBox运行库，也不运行bash。
// AgentTool params typed from a TypeBox-built parameter schema. pi-agent-core does not depend on TypeBox: the schema
// below has TypeBox 1.x's type shapes as its d.mts declare them; pi-schema's own tests check the shapes against TypeBox.

// describe/it登记用例，expectTypeOf主要依赖TypeScript编译检查；普通Vitest执行通过不能替代类型检查。
import { describe, expectTypeOf, it } from "vitest";
// 只导入AgentTool接口，运行时擦除，不创建Agent或模型连接。
import type { AgentTool } from "../src/types.ts";

// 用接口模拟TypeBox字符串schema的最小静态形状；接口本身不生成对象。
interface TString {
	// 带特殊字符的属性名用引号；~kind字面量供pi-schema的条件类型识别String种类。
	"~kind": "String";
	// type:string是运行schema的JSON关键字，和~kind的类型适配标记分工不同。
	type: "string";
}

// 泛型Value保存某个常量的精确类型，例TLiteral<"fast">的const只能是字符串fast。
interface TLiteral<Value> {
	// Literal种类让Static读取const的值类型。
	"~kind": "Literal";
	// 这里const是属性名，不是声明变量的const关键字；类型由泛型Value指定。
	const: Value;
}

// Branches泛型记录联合分支的schema类型，可保留元组的具体成员。
interface TUnion<Branches> {
	// Union种类标记对应下面anyOf形状。
	"~kind": "Union";
	// anyOf装候选schema；类型映射递归提取各分支的值联合，不在此验证某个值。
	anyOf: Branches;
}

// 泛型Properties描述对象的字段规则表，而不是待执行工具的参数对象值。
interface TObject<Properties> {
	// Object种类供Static选择对象映射。
	"~kind": "Object";
	// 运行规则要求object。
	type: "object";
	// properties的静态结构保留command/mode各自的schema类型。
	properties: Properties;
	// required只是string[]，静态必填推导由属性上的Optional标记区分，不从这个宽数组反推字面键。
	required: string[];
}

// &是交叉类型：原schema形状加上~optional:true，表示该对象字段在值类型中可省略；不修改运行对象。
type TOptional<Schema> = Schema & { "~optional": true };

// 构造运行schema并显式标注TObject泛型：command必填字符串，mode可选且只能fast/deep。typeof parameters之后复用这份精确声明。
const parameters: TObject<{ command: TString; mode: TOptional<TUnion<[TLiteral<"fast">, TLiteral<"deep">]>> }> = {
	// 实际对象也提供Object标记，与上面的接口形状对应。
	"~kind": "Object",
	// 根参数必须是对象的规则数据。
	type: "object",
	// 列出两个字段的子schema。
	properties: {
		// command子规则为String种类和JSON的string类型。
		command: { "~kind": "String", type: "string" },
		// mode子规则是两个字面量分支，并额外带Optional标记。
		mode: {
			// Union标记供静态适配读取anyOf。
			"~kind": "Union",
			// 数组记录两个候选子规则；这里由显式泛型约束为两项元组形状。
			anyOf: [
				// 第一支仅fast，保留字面量类型而非宽string。
				{ "~kind": "Literal", const: "fast" },
				// 第二支仅deep。
				{ "~kind": "Literal", const: "deep" },
			],
			// 运行对象包含可选标记，和接口交叉类型相对应；实际JSON必填约束仍看required。
			"~optional": true,
		},
	},
	// JSON规则只把command列为必填，mode省略时仍可合法；本文件没有调用验证器检查这些运行规则。
	required: ["command"],
};

// 手写预期值类型：?允许不提供mode，竖线将两个字符串字面量组成联合。
type Params = { command: string; mode?: "fast" | "deep" };

// 分组只检查schema到工具函数签名的类型连接，不执行工具、命令或模型请求。
describe("AgentTool params of a TypeBox schema", () => {
	// 创建带execute的工具后检查其参数类型，以及可选prepareArguments的声明返回类型；这个用例不会调用两者。
	it("are typed by the schema in execute() and prepareArguments()", () => {
		// typeof parameters在类型位置取schema变量类型，AgentTool据Static推导params；不是以schema对象作为运行构造参数。
		const tool: AgentTool<typeof parameters> = {
			// 名称bash只是工具描述，不会启动shell。
			name: "bash",
			// label为展示名，不参与工具参数类型推导。
			label: "Bash",
			// 描述字符串也只是元数据。
			description: "Runs a command",
			// 属性简写将现有parameters schema对象交给工具定义。
			parameters,
			// async方法按接口获得参数的上下文类型；_toolCallId以下划线标记未使用，params应推为Params。方法定义不会执行函数体。
			async execute(_toolCallId, params) {
				// TS检查params与Params相等；因本例没有调用execute，这一行在普通运行时不会走到。
				expectTypeOf(params).toEqualTypeOf<Params>();
				// 如果方法被调用，会返回Promise包装的空内容/undefined详情；本测试未观察实际返回值。
				return { content: [], details: undefined };
			},
		};
		// Parameters取execute的参数元组，[1]取第二项，也就是params；泛型类型运算不调用execute。
		expectTypeOf<Parameters<typeof tool.execute>[1]>().toEqualTypeOf<Params>();
		// NonNullable去掉可选prepareArguments的undefined后，ReturnType取声明返回值；对象并未实现此钩子，本行不代表钩子真实存在或被调用。
		expectTypeOf<ReturnType<NonNullable<typeof tool.prepareArguments>>>().toEqualTypeOf<Params>();
	});
});
