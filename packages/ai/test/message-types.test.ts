import { describe, expect, expectTypeOf, it } from "vitest";
import type { Context, JsonValue, Message, ToolResultMessage } from "../src/types.ts";

// 复用工具结果的必填字段；as const 只把 role 收窄为字面量，编译后仍是普通字符串，不冻结整个对象。
const base = {
	// 角色是 Message 联合的分辨字段。
	role: "toolResult" as const,
	// 调用 id 用来与 assistant 中的 toolCall 配对；此处不执行实际工具。
	toolCallId: "call-1",
	// 工具名称只用固定示例 read。
	toolName: "read",
	// 本组只研究 details 类型，给模型看的 content 留空。
	content: [],
	// 固定成功标记与时间，避免引入执行状态或时钟依赖。
	isError: false,
	timestamp: 1,
};

// 注册 JSON 详情类型用例；expectTypeOf 的约束由 TypeScript 检查，运行 Vitest 本身不代替完整类型检查。
describe("message JSON types", () => {
	// 构造多种合法 details 并赋给通用 Message/Context；无外部副作用，断言保留值与引用，类型不符由编译报错。
	it("preserves JSON-compatible detail types without requiring index signatures", () => {
		// interface 声明具体字段而不用 [key: string] 索引签名；这应仍可映成 JSON 表示。
		interface Details {
			// 普通字符串字段必填。
			path: string;
			// readonly 禁止通过这个类型修改数组，不在运行时冻结数组。
			items: readonly string[];
			// ? 表示 summary 可缺省，内层 lines 也可缺省。
			summary?: {
				lines?: number;
			};
		}

		// 泛型 Details 让 details 保留字段信息；对象展开复制 base 的顶层字段，content 数组引用仍共享。
		const objectMessage: ToolResultMessage<Details> = {
			...base,
			details: { path: "a.ts", items: ["first"], summary: { lines: 3 } },
		};
		// 数组也可作为 JSON 详情，不要求详情一定是对象。
		const arrayMessage: ToolResultMessage<string[]> = { ...base, details: ["a", "b"] };
		// readonly [A,B] 是只读元组，固定两个位置；第二项对象的 count 同时只读且可选。
		const readonlyArrayMessage: ToolResultMessage<readonly [string, { readonly count?: number }]> = {
			...base,
			details: ["a", { count: 1 }],
		};
		// 字符串原始值本身符合 JSON，可作 details。
		const primitiveMessage: ToolResultMessage<string> = { ...base, details: "diagnostic" };
		// null 是合法 JSON 值，区别于字段缺省的 undefined。
		const nullMessage: ToolResultMessage<null> = { ...base, details: null };
		// 向更宽的消息联合赋值只改变静态视图，不复制消息。
		const transcriptMessage: Message = objectMessage;
		// 只读元组详情也应能进入通用 Message。
		const readonlyTranscriptMessage: Message = readonlyArrayMessage;
		// Context 的消息列表接受上述两种工具详情，不需要先 JSON.stringify。
		const context: Context = { messages: [objectMessage, readonlyArrayMessage] };

		// ?. 在可选对象不存在时短路为 undefined；这里真实值应为 3。
		expect(objectMessage.details?.summary?.lines).toBe(3);
		// toEqual 比较数组/对象的结构值。
		expect(arrayMessage.details).toEqual(["a", "b"]);
		expect(readonlyArrayMessage.details).toEqual(["a", { count: 1 }]);
		// toBe 检查原始值严格相等，toBeNull 检查明确 null。
		expect(primitiveMessage.details).toBe("diagnostic");
		expect(nullMessage.details).toBeNull();
		// toBe 对对象检查同一引用，证明宽类型赋值没有变换对象。
		expect(transcriptMessage).toBe(objectMessage);
		expect(readonlyTranscriptMessage).toBe(readonlyArrayMessage);
		// 这里只比较上下文中的两条消息值，没有调用模型或工具。
		expect(context.messages).toEqual([objectMessage, readonlyArrayMessage]);
		// 索引访问类型取默认 ToolResultMessage 的 details；可选属性读取为 JsonValue | undefined。
		expectTypeOf<ToolResultMessage["details"]>().toEqualTypeOf<JsonValue | undefined>();
	});

	// 无参数/副作用，列出非法详情类型并要求结果为 never；例函数不能序列化为 JSON，此处不实际序列化任何值。
	it("rejects non-JSON detail types", () => {
		// 刻意用 any 作负面类型样本：可选属性也不能借 any 绕过 JSON 兼容检查。
		type OptionalAny = { value?: any };
		// never 表示类型层没有可构造的工具结果，不代表这里会抛运行时异常。
		expectTypeOf<ToolResultMessage<OptionalAny>>().toEqualTypeOf<never>();
		// 数组元素不能是 undefined；对象的可选属性与数组空缺是不同的契约。
		expectTypeOf<ToolResultMessage<undefined[]>>().toEqualTypeOf<never>();
		// 函数、unknown 与 Date 对象都不被视为直接可用的 JSON 详情。
		expectTypeOf<ToolResultMessage<{ callback: () => void }>>().toEqualTypeOf<never>();
		expectTypeOf<ToolResultMessage<{ value: unknown }>>().toEqualTypeOf<never>();
		expectTypeOf<ToolResultMessage<{ value: Date }>>().toEqualTypeOf<never>();
	});
});
