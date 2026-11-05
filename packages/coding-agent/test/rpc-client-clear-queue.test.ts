// 只验证客户端 clearQueue 的命令封装；替换私有传输后不会启动 Pi 子进程，也不真正清理服务器队列。
import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

// 测试需要访问的最小内部形状；类型断言不会在运行时检查实例是否符合它。
type RpcClientPrivate = {
	// 发送命令后异步取得未知响应；Promise<unknown>要求消费方自行说明响应形状。
	send: (command: { type: string }) => Promise<unknown>;
	// <T>是每次调用选择的返回类型；泛型本身不校验服务端数据。
	getData: <T>(response: unknown) => T;
};

// describe 的回调登记这一组用例，本身不发送 RPC。
describe("RpcClient clearQueue", () => {
	// 无输入；异步调用公开方法，再检查假 send 的参数与返回值。例如两类队列文字都应原样交还；断言失败会使测试拒绝。
	it("sends the clear_queue RPC command", async () => {
		// 构造只保存选项；未调用 start，因此没有子进程。
		const client = new RpcClient();
		// 经 unknown 再断言可绕过 private 的编译期访问限制；不会创建一个新实例。
		const privateClient = client as unknown as RpcClientPrivate;
		// vi.fn 记录调用；async 箭头回调以 Promise 返回固定成功响应，括号让对象成为表达式。
		const send = vi.fn(async () => ({
			// 协议标签、命令名与成功位仅是假数据，不经过真正响应解析。
			type: "response",
			command: "clear_queue",
			success: true,
			// steering 是插话，followUp 是追问；这里返回被清除消息的文字。
			data: { steering: ["Change direction"], followUp: ["Summarize when finished"] },
		}));
		// 将此实例的发送函数替换成记录桩。
		privateClient.send = send;
		// 假解包器接 unknown 并声明返回 T，只读取 data；不测试生产 getData 的错误检查。
		privateClient.getData = <T>(response: unknown): T => {
			// as 只告诉 TypeScript 按 {data:T}看待响应，不做运行时校验。
			return (response as { data: T }).data;
		};

		// await 等公开包装方法完成，期间只会调用上面两处替身。
		const result = await client.clearQueue();

		// 检查确实发送 clear_queue；此断言不限制调用次数。
		expect(send).toHaveBeenCalledWith({ type: "clear_queue" });
		// 深比较返回结构，证明包装方法返回了解包数据，不证明远端队列发生变化。
		expect(result).toEqual({ steering: ["Change direction"], followUp: ["Summarize when finished"] });
	});
});
