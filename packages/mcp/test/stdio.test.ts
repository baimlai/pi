// 通过仓库固定Node模拟服务验证stdio握手、工具往返、stderr与POSIX关闭升级；这组会真实启动子进程，不接外部模型或HTTP服务器。
// 服务/孙进程只运行下面两个已知fixture；每例成功路径close，但未用finally保证断言失败后也关闭。
// fileURLToPath把file:地址转成本机路径，正确处理空格/URL编码，不执行文件。
import { fileURLToPath } from "node:url";
// Vitest的分组、断言、用例API，skipIf可按运行平台跳过特定用例。
import { describe, expect, it } from "vitest";
// 本包客户端管理请求Promise，StdioTransport负责spawn及stdin/stdout协议和stderr缓存。
import { McpClient, StdioTransport } from "../src/index.ts";

// import.meta.url作为当前测试文件基址，得到固定正常服务脚本绝对路径；new URL只构造地址。
const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
// 同样定位故意不自行退出的服务脚本，定义路径本身不会启动它。
const stubborn = fileURLToPath(new URL("./fixtures/stubborn-server.mjs", import.meta.url));

// 围绕同一个stdio传输机制分组，两例各创建独立client/transport。
describe("StdioTransport", () => {
	// 启动正常fixture，完成initialize→tools/list→echo并检查stderr回调/缓存和关闭状态。
	// 例传text=hello应回同值；只断言pid为数字，不验证任意命令安全或日志截尾极限，失败前未进入close时没有本例finally收尾。
	it("connects to a newline-delimited MCP server and captures stderr", async () => {
		// 收集每次onStderr给的字符串块，不假定一块恰一行或完整Unicode字符。
		const stderr: string[] = [];
		// 构造配置对象，不在new时spawn；真正启动发生在下面connect调用transport.start时。
		const transport = new StdioTransport({
			// 明确用当前Node可执行文件，不在PATH搜索第三方MCP命令。
			command: process.execPath,
			// 参数只给固定仓库脚本路径，由Node执行其模块体。
			args: [fixture],
			// 同步箭头把每块stderr文字push记录，数组长度返回值被void回调契约忽略。
			onStderr: (chunk) => stderr.push(chunk),
		});
		// 创建新客户端自报身份，不访问认证存储。
		const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
		// await启动进程并完成initialize/initialized握手；start成功本身还不代表协议就绪。
		await client.connect(transport);
		// 列表应只有echo与object参数schema，深比较结果内容。
		expect(await client.listTools()).toEqual([{ name: "echo", inputSchema: { type: "object" } }]);
		// 实际通过stdin发tools/call，fixture会把arguments.text经String回显到stdout结果。
		expect(await client.callTool("echo", { text: "hello" })).toEqual({
			// 预期恰一个hello text块，与输入样本相同，但未穷举参数缺失/非法形状。
			content: [{ type: "text", text: "hello" }],
		});
		// pid getter应给number；这一运行时类型断言不等于操作系统存活探测，本行也没判断数字是否正值。
		expect(transport.pid).toBeTypeOf("number");
		// 等约10ms让stderr事件被处理，宿主调度可能延后；固定延时不是通用日志就绪同步机制。
		await new Promise((resolve) => setTimeout(resolve, 10));
		// 把日志回调块拼在一起查ready子串，不要求块数或恰好一次。
		expect(stderr.join("")).toContain("stdio fixture ready");
		// 另检查传输自身缓存也有ready，覆盖回调与缓存两条读取入口。
		expect(transport.stderr).toContain("stdio fixture ready");
		// 显式close先关stdin，正常fixture在读流EOF后退出；传输必要时仍可升级信号。
		await client.close();
		// 检查客户端本地closed状态，不把它单独当所有后代/文件句柄都清理完的证明。
		expect(client.connectionState).toBe("closed");
	});

	// Windows跳过下一例，因为它测试POSIX进程组/信号语义；skipIf先返回适用的测试登记函数。
	it.skipIf(process.platform === "win32")(
		// 用例名称说明要验证顽固服务及它的子进程，不会按这个文字启动外部命令。
		"kills a server that ignores shutdown, including its children",
		// 异步用例：启动顽固fixture→从stderr找孙进程pid→close→限时检查与轮询探测；异常不由finally清理。
		// 仅此固定同组后代样本，不涵盖后代另建会话、所有权限错误或所有操作系统的进程回收。
		async () => {
			// 创建将来运行顽固脚本的传输。
			const transport = new StdioTransport({
				// 同样使用当前Node程序。
				command: process.execPath,
				// 固定stubborn脚本会再spawn一个固定Node -e脚本，非下载/用户输入命令。
				args: [stubborn],
				// 关闭配置100ms；实现先给min(500,100)=100ms宽限，再SIGTERM，再约100ms后SIGKILL，不保证close严格200ms完成。
				closeTimeoutMs: 100,
			});
			// 独立客户端，只需顽固fixture支持initialize即可连接。
			const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
			// 握手后才能确定服务有正常协议响应，不靠stderr日志替代握手。
			await client.connect(transport);
			// 孙进程pid尚未知，联合undefined供下面轮询终止判断。
			let grandchild: number | undefined;
			// 最多100轮且找到pid就停；i++每轮末增加，等待只在尚未匹配时发生。
			for (let i = 0; i < 100 && grandchild === undefined; i++) {
				// 从已缓存stderr查grandchild后面的十进制数字，可能为null；不是枚举进程表。
				const match = /grandchild (\d+)/.exec(transport.stderr);
				// 有匹配把捕获字符串转number，不在此校验是否仍是同一活进程或是否超安全整数。
				if (match) grandchild = Number(match[1]);
				// 未匹配等待约10ms再读缓存，而不是忙循环占满CPU。
				else await new Promise((resolve) => setTimeout(resolve, 10));
			}
			// 确保拿到数字，否则后面的信号0探测没有可靠样本pid；expect断言不会使TS自动收窄后面变量。
			expect(grandchild).toBeTypeOf("number");

			// 记下关闭前墙钟毫秒时间，Date.now可受系统时钟调整影响。
			const startedAt = Date.now();
			// 显式关闭会请求EOF并在顽固进程仍活时升级组信号，等待相应close分支。
			await client.close();
			// 本样本实测应小于5秒，不把它当实现对任意命令的严格完成上限。
			expect(Date.now() - startedAt).toBeLessThan(5_000);
			// 先假设孙进程仍可探测，之后失败会改false。
			let alive = true;
			// 最多100轮、alive为false就停，允许进程终止/回收有短暂延迟。
			for (let i = 0; i < 100 && alive; i++) {
				// try同时包住kill(0)与延时await；任一步抛错/拒绝都走catch。
				try {
					// 信号0只探测pid及发送权限，不实际终止该进程；as number只给TS视图，实际数字来自前面日志解析。
					process.kill(grandchild as number, 0);
					// 探测未抛错则等约20ms再试，不立即断言进程永远活着。
					await new Promise((resolve) => setTimeout(resolve, 20));
					// 探测或等待失败进入catch，不只针对ESRCH做错误码识别。
				} catch {
					// 失败即认为不再可探测；这不是对所有错误都证明“进程已不存在”的通用判断。
					alive = false;
				}
			}
			// 最后要求至少一次探测/等待失败使alive=false；不检查每个后代pid或退出信号具体值。
			expect(alive).toBe(false);
		},
		// 第三个it参数为整例10000ms测试超时，和传输closeTimeoutMs=100是不同计时层。
		10_000,
	);
});
