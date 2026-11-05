// 用固定输入检查工具参数转换、null处理、错误报告及返回副本；只调用内存中的验证函数，不执行echo工具或请求模型。
// Type是TypeBox规则构造器集合；Type.Number生成schema数据，不把现有值直接转成number。
import { Type } from "typebox";
// describe登记分组，it登记运行回调，expect比较结果或捕获异常；下面的回调不在登记it时立即执行。
import { describe, expect, it } from "vitest";
// import type在运行时擦除；JsonValue描述JSON兼容值，Tool带参数规则，ToolCall带调用实参和可选解析错误。
import type { JsonValue, Tool, ToolCall } from "../src/types.ts";
// 使用真实执行前验证函数：先拒绝argumentsError，再深拷贝参数并按schema转换、检查；失败通过异常报告。
import { validateToolArguments } from "../src/utils/validation.ts";

// 给任意字段规则和测试输入组装一对同名工具/调用，返回二者，不执行验证或工具。
// 流程：把schema放进必填value字段，再把value放进arguments；例number规则与字符串42用于测试转换。只创建对象，无网络副作用。
function createToolCallWithPlainSchema(
	// 索引访问类型Tool["parameters"]复用工具参数规则类型；这里只是对象类型约束，不证明schema内容合法。
	schema: Tool["parameters"],
	// unknown允许测试传入任意输入；使用前需由后续真正的运行时验证处理。
	value: unknown,
	// 冒号后的对象类型声明返回值有tool和toolCall两个成员，不是在这里构造返回对象。
): {
	// tool成员的静态类型为Tool。
	tool: Tool;
	// toolCall成员的静态类型为ToolCall，与工具定义分开保存。
	toolCall: ToolCall;
} {
	// 创建真实Tool描述对象；类型标注用于开发期检查字段，运行时不会自动调用校验器。
	const tool: Tool = {
		// 固定工具名echo，使验证错误中的名称可预测。
		name: "echo",
		// 工具说明字符串仅作元数据，此测试不把它交给模型。
		description: "Echo tool",
		// 整份parameters约束工具参数根对象；传入的schema只约束其中的value。
		parameters: {
			// 根实参必须是对象。
			type: "object",
			// properties列出已声明的字段规则，并非实际参数值。
			properties: {
				// 把调用者给的规则原引用放到value位置，不把规则展开或复制。
				value: schema,
			},
			// value列入required，即使测试输入是null也不能当作可省略字段直接丢掉。
			required: ["value"],
			// as仅向TS声明这份对象可作为参数schema，不在运行时验证关键字。
		} as Tool["parameters"],
	};

	// 创建待验证的工具调用数据，尚未执行任何函数调用。
	const toolCall: ToolCall = {
		// 字面量标签toolCall区分它与文本内容或工具结果。
		type: "toolCall",
		// 固定调用标识便于构造数据；此文件不测试结果与id的配对。
		id: "tool-1",
		// 调用名与上面的echo对应，但本函数直接返回数据，不负责查名。
		name: "echo",
		// 外层value键保存传入值；value as JsonValue只是类型断言，unknown测试输入不会因此被转换成合法JSON。
		arguments: { value: value as JsonValue },
	};

	// 对象属性简写返回现有tool、toolCall引用，供测试解构使用。
	return { tool, toolCall };
}

// 登记参数验证分组；每例给固定规则/输入，比较转换值或错误，不测工具业务执行。
describe("validateToolArguments", () => {
	// 模拟字符串代码生成不可用：暂时替换全局Function，再验证数字转换，最后还原。仅证明这一输入路径能通过，不覆盖所有schema或完整CSP策略。
	it("still validates when Function constructor is unavailable", () => {
		// 保存原Function引用，供finally精确恢复，避免影响后续测试。
		const originalFunction = globalThis.Function;
		// 定义一个要求count数字的echo工具。
		const tool: Tool = {
			// 工具元数据名固定echo。
			name: "echo",
			// 给工具补齐描述字段，不参与count校验。
			description: "Echo tool",
			// Type.Object按子字段生成对象schema，并将未标Optional的count列为必填。
			parameters: Type.Object({
				// count的运行规则是number，不是只在TS里声明number。
				count: Type.Number(),
			}),
		};
		// 构造模型可能发来的调用形状，刻意放入错误类型的值。
		const toolCall: ToolCall = {
			// 标记为工具调用内容。
			type: "toolCall",
			// 提供本例固定调用id。
			id: "tool-1",
			// 目标名称保持echo。
			name: "echo",
			// 双重as先转unknown再声称number以绕过静态不相容检查；真实值仍是字符串42，后续验证必须实际转换。
			arguments: { count: "42" as unknown as number },
		};

		// 用箭头函数替换全局Function；调用它会抛错，箭头自身也不能像普通构造器那样被new。这个替身并非完整浏览器安全沙箱。
		globalThis.Function = (() => {
			// 若代码调用此替身，会得到固定EvalError，模拟禁用字符串动态代码生成。
			throw new EvalError("Code generation from strings disallowed for this context");
			// 断言为FunctionConstructor仅让赋值通过TS，不给箭头补上构造能力。
		}) as unknown as FunctionConstructor;

		// 将实际校验放在try内，使成功或断言失败后都走finally恢复全局状态。
		try {
			// 调用真实验证器并深比较对象；期望返回数字42，证明本例不会依赖可用的全局Function来完成转换。
			expect(validateToolArguments(tool, toolCall)).toEqual({ count: 42 });
			// finally无论验证/断言是否抛错都会执行，不吞掉原异常。
		} finally {
			// 恢复最初的Function引用；替换发生在try之前，本例不是通用的全局补丁事务机制。
			globalThis.Function = originalFunction;
		}
	});

	// 用普通JSON Schema表驱动检查成功转换，和前例TypeBox规则共用入口。每行是一个输入/输出示例，不是在此调用TypeBox的Value.Convert作双边比较。
	it("coerces serialized plain JSON schemas like TypeBox schemas", () => {
		// Array<对象类型>声明用例表，每项必须有下面三个字段；泛型只约束开发期。
		const passingCases: Array<{
			// schema是被包进value字段的规则。
			schema: Tool["parameters"];
			// input保留unknown，以便构造与规则不一致的输入。
			input: unknown;
			// expected记录转换后的预期值，也允许不同类型。
			expected: unknown;
		}> = [
			// 数字规则：字符串42应转成数字42；这里as不执行转换。
			{ schema: { type: "number" } as Tool["parameters"], input: "42", expected: 42 },
			// 数字规则：布尔true按既定转换规则得到1。
			{ schema: { type: "number" } as Tool["parameters"], input: true, expected: 1 },
			// 必填数字字段的null应转0，而不是删掉字段。
			{ schema: { type: "number" } as Tool["parameters"], input: null, expected: 0 },
			// 整数规则接受转换后的整数42。
			{ schema: { type: "integer" } as Tool["parameters"], input: "42", expected: 42 },
			// 布尔规则把文本true转成布尔true。
			{ schema: { type: "boolean" } as Tool["parameters"], input: "true", expected: true },
			// 文本false转成布尔false，不按非空字符串的JS truthy值处理。
			{ schema: { type: "boolean" } as Tool["parameters"], input: "false", expected: false },
			// 布尔规则把数字1转true。
			{ schema: { type: "boolean" } as Tool["parameters"], input: 1, expected: true },
			// 布尔规则把数字0转false。
			{ schema: { type: "boolean" } as Tool["parameters"], input: 0, expected: false },
			// TypeBox's conversion rules come first: null is "null" for a required string.
			// 本库第二轮沿用TypeBox转换顺序，所以必填字符串的null先变文本null，不留到第三轮转空串。
			{ schema: { type: "string" } as Tool["parameters"], input: null, expected: "null" },
			// 布尔true转成字符串true。
			{ schema: { type: "string" } as Tool["parameters"], input: true, expected: "true" },
			// null规则允许把空字符串转换成null。
			{ schema: { type: "null" } as Tool["parameters"], input: "", expected: null },
			// 数字0在本套规则下可转null。
			{ schema: { type: "null" } as Tool["parameters"], input: 0, expected: null },
			// 布尔false在本套规则下可转null。
			{ schema: { type: "null" } as Tool["parameters"], input: false, expected: null },
			{
				// type数组表示允许数字或字符串；若原值已匹配一种类型，第三轮不会强迫转成排第一的数字。
				schema: { type: ["number", "string"] } as Tool["parameters"],
				// 输入本来就是字符串1。
				input: "1",
				// 期望保留字符串，验证类型联合已有匹配的行为。
				expected: "1",
			},
			{
				// 这里type数组先boolean后number；原值未匹配两者时按第三轮原始类型规则逐一尝试。
				schema: { type: ["boolean", "number"] } as Tool["parameters"],
				// 字符串1不是已有布尔或数字。
				input: "1",
				// 第三轮布尔分支不把此字符串转布尔，数字分支得到1；这与下面单一boolean规则经第二轮转换不同。
				expected: 1,
			},
			// 单一boolean规则在第二轮可把字符串1转成true。
			{ schema: { type: "boolean" } as Tool["parameters"], input: "1", expected: true },
			// 同理字符串0转成false。
			{ schema: { type: "boolean" } as Tool["parameters"], input: "0", expected: false },
			// null规则把字符串null转为实际null。
			{ schema: { type: "null" } as Tool["parameters"], input: "null", expected: null },
			// 整数转换会截去小数部分：字符串42.1先变数字再截为42，不是四舍五入。
			{ schema: { type: "integer" } as Tool["parameters"], input: "42.1", expected: 42 },
			// 数组规则把单个值包成一项数组，再按items把字符串7转成数字7。
			{ schema: { type: "array", items: { type: "number" } } as Tool["parameters"], input: "7", expected: [7] },
		];

		// for...of逐项执行同一组装和断言逻辑；它们属于一个it，不是20个独立Vitest用例。
		for (const testCase of passingCases) {
			// 对象解构取得本行的工具/调用，各行重新构造参数根schema对象。
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			// 调用校验后深比较value；验证的是最终转换加检查的组合，不隔离某一轮转换。
			expect(validateToolArguments(tool, toolCall)).toEqual({ value: testCase.expected });
		}
	});

	// 验证可选且不接收null的字段会被省略，同时显式可空字段保留null，并递归处理metadata内部；没有请求模型。
	it("treats null as omission for optional non-nullable properties", () => {
		// 定义包含必填和可选成员的工具schema。
		const tool: Tool = {
			// 固定目标名。
			name: "echo",
			// 固定说明字段。
			description: "Echo tool",
			// Type.Object根据Optional标记生成required列表。
			parameters: Type.Object({
				// path未标可选，必须存在且为字符串。
				path: Type.String(),
				// offset可省略，若存在其规则是number且不允许null；第一轮可将这里的null删除。
				offset: Type.Optional(Type.Number()),
				// nullable既可省略又显式允许string或null；Optional控制缺省，Union控制实际值，两者含义不同。
				nullable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				// metadata本身必填，其内部enabled可省略但不允许null。
				metadata: Type.Object({ enabled: Type.Optional(Type.Boolean()) }),
			}),
		};
		// 准备三个null字段，观察不同规则的区别。
		const toolCall: ToolCall = {
			// 声明调用标签。
			type: "toolCall",
			// 设置固定调用id。
			id: "tool-1",
			// 请求echo工具。
			name: "echo",
			// 给出合法path、可删除offset、应保留nullable以及嵌套enabled；初始参数仍包含所有键。
			arguments: { path: "file.txt", offset: null, nullable: null, metadata: { enabled: null } },
		};

		// 预期转换结果省略offset/enabled并保留其他值；toEqual忽略值为undefined的对象键，单凭此断言不能证明这些自有键一定不存在。
		expect(validateToolArguments(tool, toolCall)).toEqual({
			// 必填path原样保留。
			path: "file.txt",
			// 显式可空的nullable保持null。
			nullable: null,
			// metadata对象仍存在，内部可选enabled被移除后为空对象。
			metadata: {},
		});
	});

	// 检查可选字段通过本地$ref引用可空规则时保留null。没有required使value可省略；此例不证明所有引用组合的转换行为。
	it("preserves optional nulls whose referenced schema is nullable", () => {
		// 用普通schema描述引用，避免依赖TypeBox标记。
		const tool: Tool = {
			// 固定echo名称。
			name: "echo",
			// 补齐工具元数据描述。
			description: "Echo tool",
			// 开始声明完整参数schema。
			parameters: {
				// 根值必须是对象。
				type: "object",
				// value字段引用当前schema的$defs/value；引用由本地Resolver处理，不联网取规则。
				properties: { value: { $ref: "#/$defs/value" } },
				// $defs中定义number或null的anyOf，null已满足其中一支。
				$defs: { value: { anyOf: [{ type: "number" }, { type: "null" }] } },
				// as声明此对象可放入parameters，不验证引用是否真的可解析。
			} as Tool["parameters"],
		};
		// 构造有value:null的调用。
		const toolCall: ToolCall = {
			// 设置工具调用标签。
			type: "toolCall",
			// 固定调用id。
			id: "tool-1",
			// 名称对应echo。
			name: "echo",
			// 显式提供null，与完全省略value不同。
			arguments: { value: null },
		};

		// 转换后value仍应存在且为null，不变0或被删除。
		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	// 验证anyOf可空联合在原值已匹配某分支时优先保留原值；例null虽也可转数字0，此时应不转换。
	it("preserves a value that already matches a nullable union arm", () => {
		// 创建含必填value的TypeBox工具schema。
		const tool: Tool = {
			// 固定工具名。
			name: "echo",
			// 固定描述。
			description: "Echo tool",
			// Type.Object会把value列入required。
			parameters: Type.Object({
				// Type.Union生成anyOf，数字分支在前、null分支在后。
				value: Type.Union([Type.Number(), Type.Null()]),
			}),
		};
		// 构造待检调用。
		const toolCall: ToolCall = {
			// 声明调用类型。
			type: "toolCall",
			// 提供固定id。
			id: "tool-1",
			// 请求echo。
			name: "echo",
			// null已满足第二分支，因此不应仅因数字分支排在前面就变0。
			arguments: { value: null },
		};

		// 比较完整结果，确认保留原null。
		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	// 用plain oneOf检查同样的已匹配null保留规则；最终仍需通过oneOf恰好一支的校验，不等同任意联合都放行。
	it("preserves a value that already matches a oneOf nullable union arm", () => {
		// 组装工具及调用，把下面的联合规则放在必填value位置。
		const { tool, toolCall } = createToolCallWithPlainSchema(
			// number和null在本输入上互斥，oneOf要求恰好一个分支满足。
			{ oneOf: [{ type: "number" }, { type: "null" }] } as Tool["parameters"],
			// 把实际null作为待检输入。
			null,
		);

		// 确认最终输出保留null。
		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	// 与前例对照：原值不匹配number/null任何分支时，允许转换后再检查；字符串42应变数字42。
	it("still coerces nullable unions when the original value does not match any arm", () => {
		// 创建使用plain anyOf的工具和调用。
		const { tool, toolCall } = createToolCallWithPlainSchema(
			// 两个分支依次为number与null；这里用anyOf而不是oneOf。
			{ anyOf: [{ type: "number" }, { type: "null" }] } as Tool["parameters"],
			// 原输入是字符串，尚不匹配任一分支。
			"42",
		);

		// 转换得到数字42后通过联合规则，返回对象含数字值。
		expect(validateToolArguments(tool, toolCall)).toEqual({ value: 42 });
	});

	// 检查type数组允许array或null且声明items时，已有合法null不会被错误包装成数组；items仅在数组值上约束元素。
	it("accepts null for nullable array schemas with items", () => {
		// 用辅助函数生成必填value规则及null输入。
		const { tool, toolCall } = createToolCallWithPlainSchema(
			// value允许字符串数组或null，items不是要求null也可迭代。
			{ type: ["array", "null"], items: { type: "string" } } as Tool["parameters"],
			// 传入已匹配null类型的值。
			null,
		);
		// 确认最终仍是null而不是单元素数组。
		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	// 表驱动验证无法有效转换的输入应抛验证错误；不要求所有非法值都会抛同一完整文案。
	it("rejects invalid coercions for serialized plain JSON schemas", () => {
		// 失败表每项只有schema和input，没有成功expected字段。
		const failingCases: Array<{
			// schema仍复用工具参数规则类型。
			schema: Tool["parameters"];
			// input为unknown，允许故意传不符合规则的字符串。
			input: unknown;
		}> = [
			// yes不属于本套布尔转换接受的文本。
			{ schema: { type: "boolean" } as Tool["parameters"], input: "yes" },
			// abc不能变成合法number。
			{ schema: { type: "number" } as Tool["parameters"], input: "abc" },
			// nil不是null转换认可的字符串。
			{ schema: { type: "null" } as Tool["parameters"], input: "nil" },
			// 4x不能被当作整数4，规则不会用parseInt忽略尾部x。
			{ schema: { type: "integer" } as Tool["parameters"], input: "4x" },
		];

		// 逐项运行四种失败场景，仍只登记一个Vitest用例。
		for (const testCase of failingCases) {
			// 每项创建独立工具规则及参数对象。
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			// 箭头延迟执行验证，让toThrow捕获抛错；字符串参数检查错误消息包含该片段，而非整条消息完全相等。
			expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
		}
	});
	// 验证消息同时列规则错误与原始参数，具体例子是number字段收到了many；不是直接检查错误对象全部属性。
	it("lists pi-schema's errors, then the arguments it received", () => {
		// 组装必填数字规则和无法转换的many字符串。
		const { tool, toolCall } = createToolCallWithPlainSchema({ type: "number" } as Tool["parameters"], "many");
		// 将调用放进箭头交给toThrow，避免验证在expect前就抛出。
		expect(() => validateToolArguments(tool, toolCall)).toThrow(
			// 匹配包含此完整片段的消息：路径value、期望/实际类型，以及两空格缩进的原始参数；toThrow字符串仍是包含判断。
			'Validation failed for tool "echo":\n  - value: expected number, got string\n\nReceived arguments:\n{\n  "value": "many"\n}',
		);
	});

	// 验证缺失字段的错误指向value；此例只断言消息片段，不限定所有错误条目。
	it("reports a missing required property at the property", () => {
		// 先造合法必填字符串schema与调用，下一行再覆盖实参。
		const { tool, toolCall } = createToolCallWithPlainSchema({ type: "string" } as Tool["parameters"], "x");
		// 对象展开浅拷贝调用并用空arguments覆盖；必填value缺失应报告value: missing，原toolCall不因展开而改变。
		expect(() => validateToolArguments(tool, { ...toolCall, arguments: {} })).toThrow("  - value: missing");
	});

	// 即便无需转换也应返回独立根对象，防止工具修改参数根影响历史；此例只有平坦对象，不直接证明所有嵌套对象都深拷贝。
	it("returns a copy of the arguments, also when nothing is coerced", () => {
		// 原值x已符合必填字符串规则。
		const { tool, toolCall } = createToolCallWithPlainSchema({ type: "string" } as Tool["parameters"], "x");
		// 保存验证函数返回的参数对象。
		const args = validateToolArguments(tool, toolCall);
		// 深比较内容相同，确认复制没有丢失value。
		expect(args).toEqual({ value: "x" });
		// toBe比较引用身份，not要求返回根对象不与历史arguments同一引用。
		expect(args).not.toBe(toolCall.arguments);
	});

	// #10897
	// 回归#10897：解析器已标记参数JSON有错时必须先失败，不能把临时空对象当作可执行实参；不在此重新解析JSON。
	it("reports malformed arguments JSON instead of validating empty arguments", () => {
		// 创建即使空参数也能通过schema的工具，突出解析错误的优先级。
		const tool: Tool = {
			// 固定工具名echo。
			name: "echo",
			// 填写描述字段。
			description: "Echo tool",
			// value标Optional，所以单看schema时空对象允许通过；拒绝原因应来自argumentsError。
			parameters: Type.Object({ value: Type.Optional(Type.String()) }),
		};
		// 模拟完整参数解析失败后记录的工具调用。
		const toolCall: ToolCall = {
			// 类型仍是toolCall，不因为解析错误改变标签。
			type: "toolCall",
			// 保留固定调用id。
			id: "tool-1",
			// 目标名称为echo。
			name: "echo",
			// 解析失败时实参占位为{}，并非模型一定真的发送了合法空对象。
			arguments: {},
			// 显式携带解析错误文字，供验证入口优先拒绝。
			argumentsError: "Unexpected token",
		};

		// 用toThrow捕获真实验证入口抛错，检查它采用解析错误分支。
		expect(() => validateToolArguments(tool, toolCall)).toThrow(
			// 消息应包含工具名和原解析错误，不应误报schema的必填字段错误。
			'Invalid arguments for tool "echo": Unexpected token',
		);
	});
});
