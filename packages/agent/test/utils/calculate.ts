// 测试用计算工具和用量包装：把表达式交给Function执行并输出文本；并非限制语法的数学解析器，不适合直接执行不可信字符串。
// 只导入用量类型，运行时不加载模型客户端。
import type { Usage } from "@earendil-works/pi-ai";
// obj/str构造规则数据，Static只在编译期推导通过规则后的参数类型。
import { obj, type Static, str } from "@earendil-works/pi-schema";
// AgentTool定义工具执行签名，AgentToolResult定义模型可见content和程序用details。
import type { AgentTool, AgentToolResult } from "../../src/types.ts";

// 细化工具结果：details固定undefined，content只返回文字块；接口不会检查表达式结果本身的类型。
export interface CalculateResult extends AgentToolResult<undefined> {
	// Array<{...}>表示文字对象数组，type字面量固定text，每块text必须字符串。
	content: Array<{ type: "text"; text: string }>;
	// 详情字段明确存在但值为undefined，与可选details?不同。
	details: undefined;
}

// 执行表达式并返回CalculateResult。例2+3得到文字2+3 = 5；先编译/调用Function，再包装文本，失败时catch尝试包装Error。
// 副作用取决于表达式：它可访问全局对象或执行任意JS，并无沙箱/超时/整数限制；不能靠参数schema把它限制成数学。
export function calculate(expression: string): CalculateResult {
	// try同时覆盖函数构造、执行和结果转字符串，任一步出错都进catch。
	try {
		// 模板字符串拼成return语句，new Function在全局作用域创建函数，末尾()立刻执行；不会自动await表达式返回的Promise。
		const result = new Function(`return ${expression}`)();
		// 把表达式和结果插进text，模型可见这段文字；details不携带数值结果，特殊对象的字符串转换本身也可能执行代码或抛错。
		return { content: [{ type: "text", text: `${expression} = ${result}` }], details: undefined };
		// 既有catch(e:any)让TS允许直接读message，不代表真实抛出值一定有该字段；例如抛null可能在读message时再抛错。
	} catch (e: any) {
		// 优先用truthy的e.message，否则String(e)，重新创建Error；原错误身份/堆栈不直接保留，空message也走后备值。
		throw new Error(e.message || String(e));
	}
}

// 在模块加载时生成开放对象schema：expression必填字符串；构造规则不执行计算，真实参数验证由Agent管线另行完成。
const calculateSchema = obj(
	// 描述说明expression意图，str只约束它是字符串，不检查字符串是否安全或真是数学表达式。
	{ expression: str({ description: "The mathematical expression to evaluate" }) },
	// Open, as the tool accepted extra arguments before it moved from TypeBox.
	// open:true使规则允许额外参数字段；不在静态类型中额外添加任意键索引签名。
	{ open: true },
);

// typeof取schema的类型，Static读其品牌，得到expression:string；这是纯类型别名。
type CalculateParams = Static<typeof calculateSchema>;

// 定义异步AgentTool：模型名calculate、展示名Calculator、规则calculateSchema，execute委托calculate；例execute(id,{expression:"2+3"})返回计算结果Promise。
export const calculateTool: AgentTool<typeof calculateSchema, undefined> = {
	// 工具展示名称。
	label: "Calculator",
	// 模型调用时使用的匹配名字。
	name: "calculate",
	// 工具用途说明，不是可执行逻辑。
	description: "Evaluate mathematical expressions",
	// 引用前面构造的同一schema对象。
	parameters: calculateSchema,
	// async箭头把同步calculate的返回或异常转换为Promise完成/拒绝；_toolCallId未使用，不处理signal或进度回调。
	execute: async (_toolCallId: string, args: CalculateParams) => {
		// 取已按接口声明的expression传给同步执行器；直接手工调用execute不会自动经过Agent的schema验证。
		return calculate(args.expression);
	},
};

// 创建带固定usage的计算工具变体，输入用量对象，返回浅复制的新工具；例调用后结果另含usage。
// 只替换execute，其余元数据/schema沿原引用；每次计算仍执行表达式，返回usage原引用，不累计/校验用量，也不发模型请求。
export function createCalculateToolWithUsage(usage: Usage): AgentTool<typeof calculateSchema, undefined> {
	// 返回新的工具对象，与calculateTool的根引用不同。
	return {
		// 对象展开浅复制原字段；parameters等嵌套对象仍共享。
		...calculateTool,
		// 覆盖execute：先算结果再展开，追加闭包中的usage。async单表达式箭头用圆括号返回对象，不是代码块；表达式抛错仍导致Promise拒绝。
		execute: async (_toolCallId: string, args: CalculateParams) => ({ ...calculate(args.expression), usage }),
	};
}
