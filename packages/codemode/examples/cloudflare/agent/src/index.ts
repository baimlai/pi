// A Worker whose Durable Object runs codemode the way an agent session would: tools run here, in the
// session object, and scripts run in the separately deployed pi-codemode-sandbox Worker.
//
//   curl -X POST http://localhost:8787 --data 'const n = await tools.count({ add: 2 }); text("n=" + n); return n'
// 这个示例的工具在会话对象内执行，用户脚本交给另一个已部署的 Worker；导入类型不会启动 RPC。
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
// The portable entry has no QuickJS module: the WebAssembly lives only in the sandbox Worker.
import { type CodemodeTool, RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { DurableObject } from "cloudflare:workers";

// interface 只描述部署绑定的静态类型，不会创建 Durable Object；实际名字要与 wrangler.jsonc 一致。
interface Env {
	// 泛型 <Session> 让 getByName 返回可调用本文件 Session 方法的 stub。
	SESSION: DurableObjectNamespace<Session>;
	// 此绑定指向独立 Worker 导出的类，而不是本线程的对象实例。
	CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>;
}

// extends 复用平台基类；<Env> 让 this.env 的绑定在开发时可检查。
export class Session extends DurableObject<Env> {
	// private 限制 TS 中的外部访问；这是内存计数，不是写入 Durable Object storage 的持久计数。
	private counter = 0;

	/** 接收一段脚本正文，配置 count 工具并交远端执行，返回脚本结果；最后总会关闭客户端沙箱。例 add:2 在当前对象实例内把计数加二；实例重建后从零开始。 */
	async runCodemode(code: string) {
		// CodemodeTool[] 约束工具定义；这里没有 inputSchema 或独立的运行时参数验证。
		const tools: CodemodeTool[] = [
			{
				name: "count",
				description: "Adds to a counter kept in the session and returns the new value",
				// 输入由脚本经 JSON 桥传来；箭头函数捕获 Session 的 this。返回新计数，并修改会话内存。
				execute: (args) => {
					// as 只告诉 TS 按 {add:number} 读取，不保证实际输入正确；示例假定调用方传数字。
					this.counter += (args as { add: number }).add;
					// 同步工具值会由宿主桥包装成脚本可 await 的调用结果。
					return this.counter;
				},
			},
		];
		// Before: new CodemodeSandbox({ tools, timeoutMs: 60_000 })
		// 构造客户端只保存工具和远端工厂；真正执行在 execute 时开始。
		const sandbox = new RemoteCodemodeSandbox({
			// 对象简写 tools 等同 tools: tools，函数实现保留在会话侧。
			tools,
			// 下划线分组不影响数值，六万毫秒包含工具等待；远端同步计算还受服务端中断额度限制。
			timeoutMs: 60_000,
			// One sandbox instance per session keeps a session's scripts together and apart from others.
			// 用会话 ID 选择远端对象；同会话可复用对象线程，但每次脚本仍有独立 VM。
			remote: () => this.env.CODEMODE_SANDBOX.getByName(this.ctx.id.toString()),
		});
		// finally 在成功或异常时都执行；await 保证关闭请求结算后此方法才完成。
		try {
			// 正常脚本失败返回 ok:false；启动前序列化等宿主异常仍可能抛出。
			return await sandbox.execute(code);
		} finally {
			// 关闭会取消在途执行，不回滚 count 已修改的计数，也不保证远端 VM 已即时退出。
			await sandbox.close();
		}
	}
}

export default {
	/** HTTP 入口只接受 POST：读正文、选择名为 demo 的会话并调用 RPC、把结果编码成 JSON。例 POST return 1 得脚本结果；读取/RPC 异常没有在此捕获。 */
	async fetch(request, env) {
		// 非 POST 立即返回 405，不读取正文或执行脚本。
		if (request.method !== "POST") return new Response("POST a script\n", { status: 405 });
		// await request.text() 先读完整正文，再调用会话方法；固定 demo 使所有请求指向同名会话。
		const result = await env.SESSION.getByName("demo").runCodemode(await request.text());
		// Response.json 创建 HTTP JSON 响应；脚本结果 ok:false 本身不会在此改成 HTTP 错误码。
		return Response.json(result);
	},
// satisfies 检查对象满足平台处理器类型，同时保留其推断类型；不会在运行时校验请求或绑定。
} satisfies ExportedHandler<Env>;
