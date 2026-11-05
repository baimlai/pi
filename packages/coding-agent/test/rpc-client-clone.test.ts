// 用内存替身检查 clone 的命令名和返回数据；不执行真正的会话文件克隆。
import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

// 公开一个仅供测试断言的内部视图；TypeScript private 在运行时仍是普通属性。
type RpcClientPrivate = {
	// 参数只需命令标签；返回未知响应的 Promise。
	send: (command: { type: string }) => Promise<unknown>;
	// 泛型 T 由调用点决定；unknown 到 T 的转换仍需下面的显式断言。
	getData: <T>(response: unknown) => T;
};

// 登记客户端克隆包装方法的测试组。
describe("RpcClient clone", () => {
	// 无输入；替换 send/getData 后 await clone，并检查命令及取消标志。例如 cancelled:false 表示假服务器允许动作；失败由断言报告。
	it("sends the clone RPC command", async () => {
		// new 不会启动子进程，start 才会。
		const client = new RpcClient();
		// 双重 as 只改变编译器视图，仍指向 client 本身。
		const privateClient = client as unknown as RpcClientPrivate;
		// 记录调用的异步桩返回固定对象；括号包裹对象，避免被当成箭头函数体。
		const send = vi.fn(async () => ({
			// 固定成功的 clone 响应；该测试没有构造取消或错误分支。
			type: "response",
			command: "clone",
			success: true,
			data: { cancelled: false },
		}));
		// 替换本实例的内部方法，避免真正写进程 stdin。
		privateClient.send = send;
		// 解包替身只取 data；因此生产 getData 的 success 检查不在这里的覆盖范围。
		privateClient.getData = <T>(response: unknown): T => {
			// as 的形状断言不会验证 response；固定夹具负责满足约定。
			return (response as { data: T }).data;
		};

		// 公共方法发送命令并等待上面固定响应。
		const result = await client.clone();

		// 参数匹配证明使用 clone 标签，不限制总调用次数。
		expect(send).toHaveBeenCalledWith({ type: "clone" });
		// 深比较取消状态；不会因此创建真实会话。
		expect(result).toEqual({ cancelled: false });
	});
});
