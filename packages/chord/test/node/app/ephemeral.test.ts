// 在临时应用里验证选名字登录的输入规则和重启失效，HTTP 仅发往本地测试端口。
// Tests of the ephemeral login plugin (slice 13 §3): a public route taking a name signs the browser in as a fresh
// `{ kind: "user", id, name }` with a cookie that ends with the browser, and the session ends with the server.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { ephemeralLoginFacet } from "../../../src/node/app/index.ts";
import { Http } from "../../../src/node/http/index.ts";
import { send } from "../http/support.ts";
import { API, type TestPrincipal, testApp, WHOAMI } from "./support.ts";

// 泛型把插件限制为本测试身份联合；编译期须允许带 id/name 的 user，不在这里进行登录。
const login = ephemeralLoginFacet<TestPrincipal>();

/** The tests' API with the ephemeral login plugin in its server module. */
// 浅展开默认 API，并用提供 Http/login 的对象替换 server 模块，供临时插件 import。
const WITH_LOGIN = { ...API, modules: { ...API.modules, "@test/app/v1/server": { Http, login } } };

// 两个插件的源码作为字符串传给构建器：login 注册登录路由，whoami 返回当前身份；字符串内部保持原样。
const PLUGINS = {
	login: { "server.ts": 'import { login } from "@test/app/v1/server";\nexport default login;' },
	whoami: { "server.ts": WHOAMI },
};

/** Logs in as `name`. */
// 向测试端口 POST 名字，返回 send 的响应 Promise；unknown 允许故意传7等非法值测试运行时边界。
// 例如 logIn(port," Ada ") 在服务端去空格；这里只序列化，不自己验证或裁剪。
function logIn(port: number, name: unknown) {
	// send 连接127.0.0.1，不连接外部认证服务。
	return send(port, "POST", "/_chord/login", {
		// 声明请求体为 JSON。
		headers: { "content-type": "application/json" },
		// 把未知输入放进 name 属性并编码；实际格式判断由登录路由负责。
		body: JSON.stringify({ name }),
	});
}

// 登记登录与重启失效用例。
describe("ephemeral login", () => {
	// 此异步例启动临时应用，两次同名登录须给不同 id；再带 cookie 查身份，检查空名/非字符串和长度裁剪。
	// 会产生本地服务与临时会话，末尾关闭；不返回业务值。
	it("signs in under a picked name as a fresh user, each login its own", async () => {
		// 启动拥有两个临时插件的本地应用，端口由系统分配。
		const { app, port } = await testApp({ api: WITH_LOGIN, plugins: PLUGINS });
		// 第一次输入两端空格，等待服务端响应。
		const first = await logIn(port, "  ada  ");
		// 再次用规范化后相同名字登录，仍应独立身份。
		const second = await logIn(port, "ada");
		// Buffer 解码后解析 JSON；as 是测试的类型断言，不会运行时验证响应形状。
		const principal = JSON.parse(first.body.toString()) as { kind: string; id: string; name: string };
		// 身份应是 user，名字已trim，id 只检查16字符随机编码形状。
		expect(principal).toEqual({ kind: "user", id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), name: "ada" });
		// 同名两次登录不能复用同一个用户 id。
		expect(JSON.parse(second.body.toString()).id).not.toBe(principal.id);
		// 取登录响应的 Set-Cookie，转为字符串用于属性检查。
		const set = String(first.headers["set-cookie"]);
		// 临时浏览器 cookie 无明确持久化时长。
		expect(set).not.toContain("Max-Age");
		// 只把 name=value 部分作为 Cookie 头发回；! 是非空类型断言，不是验签。
		const whoami = await send(port, "GET", "/whoami", { headers: { cookie: set.split(";")[0]! } });
		// 本地请求应由该临时会话识别为首次登录的身份。
		expect(JSON.parse(whoami.body.toString())).toEqual(principal);
		// trim 后空名属于坏输入。
		expect((await logIn(port, "   ")).status).toBe(400);
		// 数值不应被自动当成名字。
		expect((await logIn(port, 7)).status).toBe(400);
		// 100字符输入裁到上限40，本例只用 ASCII 名字。
		expect(JSON.parse((await logIn(port, "n".repeat(100))).body.toString()).name).toHaveLength(40);
		// 按应用关闭顺序回收本地服务和存储。
		await app.close(context);
	});

	// 此例保存首轮 cookie，关闭再用同一临时数据重启，旧临时会话不能恢复；预期 /whoami 返回401。
	it("ends its sessions with the server", async () => {
		// 启动第一轮临时应用。
		const first = await testApp({ api: WITH_LOGIN, plugins: PLUGINS });
		// 取得第一轮登录 cookie，稍后只在本地重放。
		const set = String((await logIn(first.port, "ada")).headers["set-cookie"]);
		// 关闭第一轮，丢弃内存临时会话。
		await first.app.close(context);
		// 重用临时目录和插件根重启，排除只是换了数据库的情况。
		const second = await testApp({ api: WITH_LOGIN, dataDir: first.dataDir, root: first.root });
		// 旧 cookie 无法在新进程生命周期里识别出临时身份。
		expect((await send(second.port, "GET", "/whoami", { headers: { cookie: set.split(";")[0]! } })).status).toBe(401);
		// 关闭第二轮应用。
		await second.app.close(context);
	});
});
