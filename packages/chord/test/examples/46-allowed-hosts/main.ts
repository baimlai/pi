/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/46-allowed-hosts，Chord v2 的 HTTP 示例（slice 10 "HTTP 与 workers"）。
 * 演示什么：HTTP 组件的准入规则。服务器默认只回答回环地址上的请求；插件可以贡献额外允许的 Host，
 * 在运行时加入或撤回，不需要重启监听器。tunnel 插件在 open() 时允许它的公网主机名，close() 时收回。
 * 上游/下游：main.ts 创建宿主、HTTP 组件和插件组件，加载 chord.http 与 plugins/tunnel；插件通过
 * "@earendil-works/chord" 和 "@earendil-works/chord/http" 两个宿主包声明路由和可写贡献。请求用 Node 的
 * http.request 直接发给 127.0.0.1 的临时端口，只在本机回环通信，不访问外部网络。
 * 能力清单：
 * - Tunnel：本地契约，params 为空，open(name) 与 close() 两个方法；与插件里的声明同名同版本；
 * - createHttp(...)：启动 Chord 自己的 Node 监听器，port: 0 让系统分配端口；
 * - hello(host)：带指定 Host 头发 GET /hello，打印状态码和响应体；
 * - 三段演示：无隧道（允许主机外 403）、打开隧道（放行，origin 变为 https）、关闭隧道（再次 403）。
 * 典型运行顺序：创建宿主 -> 创建 HTTP 组件 -> 加载插件 -> 读取实际端口 -> 取 Tunnel 对象 -> 三次请求对比。
 * 示例（真实签名）：
 *   const http = chordHttp.createHttp(server, { listen: { host: "127.0.0.1", port: 0 }, onError }, context);
 *   const { port } = await http.listening(context); // port 是系统分配的真实端口
 * 建议阅读顺序：先看 Tunnel 契约，再看 createPlugins/load 的启动顺序，最后看三个 hello 调用与 tunnel.open/close。
 * 前置条件与运行方式：从 packages/chord 执行
 *   node --conditions=source --experimental-strip-types test/examples/46-allowed-hosts/main.ts
 * 预期输出（端口随机）：第 1 段 localhost 请求 200、notes.example.net 403；第 2 段 notes.example.net 200 且
 * origin 为 https；第 3 段 notes.example.net 又变回 403。示例没有断言，失败会以未捕获异常或非预期输出暴露。
 */
// Allowed hosts (slice 10): the server answers only requests on loopback or through a host a plugin contributes. A
// plugin can allow a host at runtime, a tunnel naming its public host, and take it back; links and sockets through a
// host no longer allowed are terminated at once.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/46-allowed-hosts/main.ts
// 下面是 Node 标准库与 Chord 源码入口的导入；示例脚本直接按相对路径引用 src，不需要先构建 dist/。
import { request } from "node:http";
// fileURLToPath 把 ESM 的 import.meta.url（file:// URL）转成文件系统路径，供插件根目录使用。
import { fileURLToPath } from "node:url";
// BACKGROUND_CONTEXT 是没有取消信号、没有 telemetry 的根上下文；示例用它代替真实应用里的请求上下文。
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
// 契约声明工具：local 定义本地契约，method 声明方法，str() 是字符串快照。
import { local, method, str } from "../../../src/contracts/index.ts";
// createHost 创建 Chord 宿主；宿主拥有对象、注册表和生命周期。
import { createHost } from "../../../src/host/index.ts";
// 命名空间导入（import * as）：把整个模块的导出收进一个对象，稍后原样作为插件的宿主包。
// chord 是库的公共入口，chordHttp 是 Node 端 HTTP 子模块；插件用这两个说明符 import 到同一份模块实例。
import * as chord from "../../../src/index.ts";
import * as chordHttp from "../../../src/node/http/index.ts";
// createPlugins：发现 plugins/ 目录、用 esbuild 构建 facet、求值并加载到宿主。
import { createPlugins } from "../../../src/node/plugins/index.ts";

// Tunnel 契约：name + version + params + members 组成运行时身份；main 与插件各声明一次，Chord 按名称/版本/指纹
// 匹配两端，而不是按 JavaScript 对象引用。编译期给出 ParamsOf/members 类型，运行时 local() 还会检查名称格式、
// 顶层键、版本号为整数等声明约束。
// params: {} 表示无参数：该对象每个宿主只有一个实例，属于 host-lifetime 对象（可贡献注册表）。
// method(str()) 的调用形式是 open(name, context)，method() 的调用形式是 close(context)；两者的结果 schema 都是 null。
/** The tunnel plugin's object, as the app's code declares it (the same contract). */
const Tunnel = local("example.tunnel", { version: 1, params: {}, members: { open: method(str()), close: method() } });

// 宿主代表 server 进程本身；principal 是宿主上代码的默认身份，onError 接收宿主级失败报告。
const server = createHost({ principal: { kind: "server" }, onError: console.error });
// 创建 HTTP 组件。listen 非空表示启动 Chord 自己的 Node 监听器；port: 0 让操作系统挑一个空闲端口。
const http = chordHttp.createHttp(server, { listen: { host: "127.0.0.1", port: 0 }, onError: console.error }, context);
// 宿主包表：键是插件源码里的 import 说明符，值是本进程已加载的模块实例；求值时 require 会返回这些实例。
const modules = { "@earendil-works/chord": chord, "@earendil-works/chord/http": chordHttp };
const plugins = createPlugins(
	{
		// roots 里的 URL 相对 import.meta.url（本文件位置）解析，再用 fileURLToPath 转为绝对路径。
		roots: [fileURLToPath(new URL("./plugins/", import.meta.url))],
		// kinds 定义每种 facet 的构建平台与允许保持外部的宿主包；Object.keys(modules) 复用上面两个说明符。
		kinds: { server: { platform: "node", hostPackages: Object.keys(modules) } },
		onError: console.error,
	},
	context,
);
// core 是应用自己的 facet：chord.http 负责 Http/Authenticators 注册表和监听器。load 会运行插件 setup、
// 提交发布批次并等待宿主级对象首次结局；单个插件失败只进入返回的报告，不会中断示例。
await plugins.load(server, { kind: "server", core: [{ name: "chord.http", facet: http.facet }], modules }, context);
// listening() 在监听成功后 resolve；解构出实际端口，port: 0 的情形在这里才变成具体数字。
const { port } = await http.listening(context);

// 用途：向本机监听端口发 GET /hello，并把 HTTP Host 头替换成参数 host，模拟隧道转发来的请求。
// 输入：host 是客户端声称的 Host 文本；输出：Promise<void>，副作用只打印一行。网络错误未捕获，会让示例退出。
// 例子：await hello("notes.example.net") 打印 "GET /hello via notes.example.net -> 200 {...}"（是否 200 取决于准入）。
/** GET /hello through `host` (as a tunnel would forward it), printed. */
async function hello(host: string): Promise<void> {
	// Node 的 request 是回调式 API；用 Promise<string> 包一层，等响应体读完后 resolve 一次。
	const answer = await new Promise<string>((resolve) => {
		// host 选项是 TCP 连接目标（始终 127.0.0.1）；headers.host 才是发给服务器的 Host 头，两者故意分开。
		const req = request({ host: "127.0.0.1", port, path: "/hello", headers: { host } }, (res) => {
			let body = "";
			// data 事件可能分多块到达；chunk 是 Buffer，+= 会隐式转成字符串。
			res.on("data", (chunk) => {
				body += chunk;
			});
			// end 表示响应体结束；statusCode 类型是 number | undefined，模板字符串会把它转成文本。
			res.on("end", () => resolve(`${res.statusCode} ${body}`));
		});
		// 没有请求体也必须调用 end()，否则请求不会发出。
		req.end();
	});
	// 输出状态码和响应体；403/401 的 body 是标准原因短语（如 Forbidden）。
	console.log(`   GET /hello via ${host} -> ${answer}`);
}

// 取得 Tunnel 对象：get 等待对象 live 后返回引用；第二个参数是空参数对象（契约 params 为 {}）。
// 对象由 tunnel 插件的工厂提供，调用 open/close 会进入插件代码。
const tunnel = await server.get(Tunnel, {}, context);
console.log("1. no tunnel yet");
// localhost 指向回环且连接本身来自回环，准入结果是 local，origin 为 http://localhost:<port>。
await hello(`localhost:${port}`);
// notes.example.net 不是回环名，也还没有被任何贡献放进允许集合，准入直接拒绝（403），路由不会执行。
await hello("notes.example.net");
console.log("2. the tunnel opens");
// open 是契约方法：参数在调用边界按 str() 检查；插件把主机写入可写贡献，注册表重组后新请求即可见。
await tunnel.open("notes.example.net", context);
// 允许集合中的非回环 Host 按 https 处理，因此响应里的 origin 是 https://notes.example.net。
await hello("notes.example.net");
console.log("3. the tunnel closes");
// close 把允许列表清空，路由器再次重组；后续连接该 Host 的请求回到 403。
await tunnel.close(context);
await hello("notes.example.net");

// release 释放引用；Tunnel 是 host-lifetime 对象，实际结束发生在 host.close。
tunnel.release();
// 关闭顺序有要求：先让 HTTP 拒绝新请求并排空运行中的请求，再关宿主，最后停止插件 watcher。
await http.close(context);
await server.close(context);
// plugins.close 是同步方法，只停止文件监视；不会卸载已经加载的宿主。
plugins.close();
