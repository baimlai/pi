// The whole sandbox Worker: one Durable Object class that runs codemode scripts for callers bound to
// it. Only Workers with a binding can reach the class; HTTP requests get a 404.
// 重导出真实服务端类并改名，供 Wrangler 的 CodemodeSandbox 绑定查找；不会在这里安装工具实现。
export { CodemodeSandboxDurableObject as CodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";

export default {
	// HTTP 处理器忽略输入并同步返回 404；脚本执行走 Durable Object RPC，不经此入口。
	fetch: () => new Response("Not found", { status: 404 }),
};
