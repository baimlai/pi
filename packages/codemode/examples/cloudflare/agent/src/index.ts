// A Worker whose Durable Object runs codemode the way an agent session would: tools run here, in the
// session object, and scripts run in the separately deployed pi-codemode-sandbox Worker.
//
//   curl -X POST http://localhost:8787 --data 'const n = await tools.count({ add: 2 }); text("n=" + n); return n'
// 这个示例的工具在会话对象内执行，用户脚本交给另一个已部署的 Worker；导入类型不会启动 RPC。
//
// 文件导读
//
// 所属：packages/codemode/examples/cloudflare/agent，Cloudflare 双层部署示例的调用侧。上游由
// wrangler 从本目录部署（配置见同目录 wrangler.jsonc）；运行时由 HTTP POST 进入 fetch，下游
// 通过 SESSION 绑定调用本 Worker 的 Session Durable Object，再用 CODEMODE_SANDBOX 绑定把脚本
// 交给单独部署的 pi-codemode-sandbox Worker 执行。
//
// 演示什么：工具实现留在会话对象内，只有脚本在独立 Worker 中运行，因此脚本无法直接拿到宿主
// 工具函数，只能通过 RPC 调用它们。此处使用 portable 入口，因当前 Worker 不包含 QuickJS
// WebAssembly；真正的沙箱类在 sandbox Worker 中。wrangler.jsonc 的 script_name 决定“另一个
// isolate”，若省略它而绑定本 Worker 导出的类，脚本会跑在会话线程上。
//
// 能力清单：
// - Env：SESSION 与 CODEMODE_SANDBOX 两个 Durable Object 命名空间绑定。
// - Session.runCodemode(code)：定义 count 工具、创建 RemoteCodemodeSandbox、执行并关闭。
// - default.fetch：只接受 POST，固定使用名为 demo 的会话，把结果编码成 JSON。
//
// 典型运行顺序与预期输出：
//   1. 先部署 sandbox Worker（名称必须是 pi-codemode-sandbox），再部署本 agent Worker。
//   2. 本地或用 curl POST 一段脚本正文；非 POST 返回 405 和 "POST a script"。
//   3. 成功返回脚本执行结果的 JSON；脚本自身失败通常仍是 HTTP 200，JSON 中带 ok:false。
//   4. 计数只存在于 Session 实例内存中，实例重建后归零；没有写 Durable Object storage。
//   5. 请求/绑定/RPC 异常没有被 fetch 捕获，会按平台默认错误响应处理。
//
// 示例（真实签名）：
//   curl -X POST http://localhost:8787 --data 'const n = await tools.count({ add: 2 }); text("n=" + n); return n'
//   脚本是异步函数体；tools.count 由本文件的 runCodemode 注入。
//
// 建议阅读顺序：先看 Env 的两个绑定，再看 runCodemode 的工具与远端沙箱，最后看 fetch 的路由。
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
