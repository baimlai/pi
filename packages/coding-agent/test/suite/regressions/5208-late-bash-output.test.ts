// 问题 #5208：注入不启动 shell 的 BashOperations，先回调 before、结算后再回调 late，核对晚到字节被忽略。
import { describe, expect, it } from "vitest";
import { type BashOperations, createBashTool } from "../../../src/core/tools/bash.ts";

// 从工具结果提取 text 块并用换行连接，缺 content 返回空串；不修改输入。例：两个 text 块 a/b 得到 a\nb。参数形状是静态类型，不进行运行时 schema 校验。
function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	// 返回下面可选数组流水线的文字结果；括号用于跨多行表达同一表达式。
	return (
		// content 可缺失，后面的 ?. 使整条调用链在缺失时产生 undefined。
		result.content
			// 仅留下 type 等于 text 的块，filter 新建数组而不改原 content。
			?.filter((block) => block.type === "text")
			// 把每块映射到 text，?? 仅在 null/undefined 时用空串，不吞掉正常空字符串。
			.map((block) => block.text ?? "")
			// 有数组时按换行拼接，否则整条可选链的 undefined 由 ?? 转为空串。
			.join("\n") ?? ""
	);
}

// 注册晚到输出回调测试；此文件通过可替换执行后端复现，不运行命令文字 late-output。
describe("regression #5208: late bash output callbacks", () => {
	// 无输入异步用例：构造先输出、后结算、再迟到输出的后端，等 20ms 后断言只有 before；20ms 是等待窗口而非精确定时保证。
	it("ignores output callbacks after bash operations resolve", async () => {
		// BashOperations 限定可替换后端的 exec 签名；此对象只在内存生成输出字节。
		const operations: BashOperations = {
			// exec 接收命令、目录和解构出的 onData；下划线表示此替身不使用前两项，async 把结果包装成 Promise。
			exec: async (_command, _cwd, { onData }) => {
				// Promise 结算前同步推送 before 的 UTF-8 字节，模拟正常进程输出。
				onData(Buffer.from("before\n", "utf-8"));
				// 登记下一轮计时器回调推送 late；0 表示最早调度机会，不代表立即或精确零毫秒。
				setTimeout(() => onData(Buffer.from("late\n", "utf-8")), 0);
				// 立刻以成功码结算后端；bash 管线随后关闭输出接收窗口。
				return { exitCode: 0 };
			},
		};
		// 用当前目录构造 bash 工具并注入替身；工厂不启动 shell。
		const bash = createBashTool(process.cwd(), { operations });

		// 执行工具管线；调用 id 用于结果关联，command 只交给忽略它的替身。
		const result = await bash.execute("test-call-late-output", { command: "late-output" });
		// 等待足够的事件循环机会，让迟到回调实际执行后再观察结果。
		await new Promise((resolve) => setTimeout(resolve, 20));

		// 提取最终文字并去首尾空白，要求没有 late；只证明本固定时序，不枚举全部异步竞争。
		expect(getTextOutput(result).trim()).toBe("before");
	});
});
