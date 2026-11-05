// The whole sandbox Worker: one Durable Object class that runs codemode scripts for callers bound to
// it. Only Workers with a binding can reach the class; HTTP requests get a 404.
//
// 文件导读
//
// 所属：packages/codemode/examples/cloudflare/sandbox，Cloudflare 双层部署示例的沙箱侧。上游由
// wrangler 从本目录部署为名为 pi-codemode-sandbox 的 Worker（见同目录 wrangler.jsonc）；下游
// 只能通过 Durable Object 绑定被 agent Worker 调用，没有面向公网的执行接口。
//
// 演示什么：整个沙箱 Worker 只做一件事——重导出 pi-codemode 的 Cloudflare Durable Object 类，
// 并改名成 CodemodeSandbox，供 Wrangler 的 class_name 查找。工具实现不在这里；调用方把工具
// 定义通过 RPC 传进来，脚本在沙箱对象的 VM 中运行，工具调用再回到调用方会话。因为
// workers_dev 与 preview_urls 都关闭，且 fetch 固定 404，HTTP 无法执行脚本。
//
// 能力清单：
// - export CodemodeSandbox：Durable Object 类别名，实际实现来自 @earendil-works/pi-codemode/cloudflare。
// - default.fetch：忽略请求并返回 404，仅用于占位/阻止 HTTP 访问。
//
// 典型运行顺序与预期输出：
//   1. 在本目录部署（或在 wrangler dev 中启动）；Worker 名称必须与 agent 配置里的 script_name 一致。
//   2. 直接访问其 HTTP URL 得到 404；脚本执行只经 Durable Object RPC。
//   3. wrangler.jsonc 声明 v1 迁移与 cpu_ms=60000，后者是每请求 CPU 上限，不是客户端 timeoutMs
//      的精确墙钟限制。
//
// 示例（真实导出）：
//   export { CodemodeSandboxDurableObject as CodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
//   agent 侧以 { class_name: "CodemodeSandbox", script_name: "pi-codemode-sandbox" } 绑定它。
//
// 建议阅读顺序：先读本文件的导出与 fetch，再看 wrangler.jsonc 的名称、迁移与限制，最后回到
// agent/src/index.ts 看 RemoteCodemodeSandbox 如何选择对象。
// 重导出真实服务端类并改名，供 Wrangler 的 CodemodeSandbox 绑定查找；不会在这里安装工具实现。
export { CodemodeSandboxDurableObject as CodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";

export default {
	// HTTP 处理器忽略输入并同步返回 404；脚本执行走 Durable Object RPC，不经此入口。
	fetch: () => new Response("Not found", { status: 404 }),
};
