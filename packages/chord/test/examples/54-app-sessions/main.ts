// 文件导读
// 所属：packages/chord/test/examples/54-app-sessions，Chord 示例 54，对应 slice 13 §2（sessions 与设备配对）。
// 作用：在示例 53 的 notes 应用上演示没有 owner token 文件的另一台设备如何登录：
//   1) owner 用一次性链接在浏览器登录；
//   2) 客户端 POST /_chord/pair 取得 code（给用户看）与 poll 秘密（自己保存）；
//   3) 匿名请求不能看/批准配对；owner 用会话 cookie 打开确认页并批准；
//   4) 客户端下一次轮询拿到设备 token（只返回一次），用它作 Bearer；
//   5) owner 通过 Sessions 对象列出会话并吊销设备会话，设备的下一次请求被拒绝。
// 上游：../53-app/start.ts（startNotes）、../53-app/client.ts（call）、src/node/app 的 Sessions。
// 下游：kit 的 pairingFacet 路由（/_chord/pair、/_chord/pair/poll、/_chord/pair/:code）与 Sessions 会话存储。
// 能力清单：call、Sessions（list/revoke/release）、匿名 401、owner 确认页、一次性设备 token。
// 典型运行（示例）：
//   cd packages/chord
//   node --conditions=source --experimental-strip-types test/examples/54-app-sessions/main.ts
// 预期输出形如：
//   1. pairing code: XXXX-XXXX
//      poll: {"status":"waiting"}
//   2. anonymous approval: 401
//      the owner's confirm page: 200 (names the device)
//      approved: 200
//   3. poll: approved
//      poll again: 404
//      CLI GET /: {"app":"notes v1","you":{"kind":"owner"},"sections":["Notes: /notes/:id"]}
//   4. sessions:
//      device: owner token file
//      browser: owner browser
//      device: laptop CLI
//      revoked; CLI GET /: 401
// 阅读顺序：先看第 2 步的 code/poll 分离，再看第 3 步的权限边界与第 4 步的一次性 token。
// 前置条件：Node 支持 --experimental-strip-types；从 packages/chord 运行。
// 副作用：临时数据目录、回环端口、三个会话（启动时的 owner token 文件、浏览器登录、配对设备）；
// 脚本结束删除临时目录，不访问外网。
// 非断言式示例：状态码打印后由读者核对；失败表现为非预期状态码或异常。
//
// Sessions and device pairing (slice 13 §2), with example 53's notes app. A command-line client on another machine
// has no owner token file: it asks for a pairing code (`POST /_chord/pair`, public), the owner approves the code in a
// signed-in browser (`/_chord/pair/<code>`, owner only), and the client's next poll returns its device token, once.
// The owner lists the sessions (`Sessions`, the kit's object; never a token or its hash) and revokes the device's.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/54-app-sessions/main.ts

// 临时目录与清理；readFile 不需要，本示例不读 token 文件。
import { mkdtemp, rm } from "node:fs/promises";
// 系统临时目录。
import { tmpdir } from "node:os";
// 路径拼接。
import { join } from "node:path";
// 示例级后台上下文。
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
// Sessions 是 kit 的会话契约 token；这里通过 app.host.get 取得服务器上的对象。
import { Sessions } from "../../../src/node/app/index.ts";
// 复用示例 53 的 HTTP 客户端。
import { call } from "../53-app/client.ts";
// 复用示例 53 的应用启动逻辑。
import { startNotes } from "../53-app/start.ts";

// 顶层 await：先建临时根，再启动应用（数据目录在 base/data）。
const base = await mkdtemp(join(tmpdir(), "notes-"));
const app = await startNotes(join(base, "data"), context);
// ownerLink 的 origin 与 pathname 都需要；port 转成 number 供 call 使用。
const link = new URL(app.ownerLink());
const port = Number(link.port);

// 1. The owner signs in in the browser with the owner link (example 53).
// 1. 浏览器登录：POST token 换 cookie；`?? ""` 兜底，使 browser 的类型确定为 {cookie: string}。
const browser = { cookie: (await call(port, "POST", link.pathname, {}, { token: link.hash.slice(1) })).cookie ?? "" };

// 2. The client asks for a code and shows it; it keeps the poll secret to itself.
// 2. 请求配对：公开路由，无需会话。响应体在类型上是 unknown，`as {...}` 只是编译期断言；
// 服务器返回的 JSON 形状由 kit 保证，客户端不再做运行时 schema 校验。
const { code, poll } = (await call(port, "POST", "/_chord/pair", {}, { label: "laptop CLI" })).body as {
	code: string;
	poll: string;
};
// code 是给用户读并转告 owner 的短码；输出前把字母数字替换成 X，避免日志/屏幕录制泄露。
// 正则 /[A-Z0-9]/g 的 g 标志让 replace 替换所有匹配而不是第一个。
console.log("1. pairing code:", code.replace(/[A-Z0-9]/g, "X"));
// poll 是客户端自己保存的秘密，用 POST body 提交，不放进 URL；第一次轮询返回 waiting。
// JSON.stringify 把 {status:"waiting"} 打印成一行 JSON，验证服务器响应。
console.log("   poll:", JSON.stringify((await call(port, "POST", "/_chord/pair/poll", {}, { poll })).body));

// 3. Only the owner may see and approve it: an anonymous request is refused before the kit's route runs.
// 3. 没有会话时，服务器在进入配对路由前返回 401；`/_chord/pair/:code` 不是公开路由。
console.log("2. anonymous approval:", (await call(port, "POST", `/_chord/pair/${code}`)).status);
// owner 的确认页：显示设备标签与 code，让 owner 核对设备屏幕上的短码。
const confirm = await call(port, "GET", `/_chord/pair/${code}`, browser);
// body 是 HTML 文本（unknown），String(...) 转成字符串后检查是否包含标签 "laptop CLI"。
// 三元表达式命中时追加说明文字，否则为空串。
console.log(
	"   the owner's confirm page:",
	confirm.status,
	String(confirm.body).includes("laptop CLI") ? "(names the device)" : "",
);
// owner 批准：kit 此时签发设备会话，principal 固定为 owner，label 用配对时的 "laptop CLI"。
console.log("   approved:", (await call(port, "POST", `/_chord/pair/${code}`, browser)).status);

// 4. The client's next poll returns its token, once; it signs in with it as a bearer token.
// 4. 再次轮询：配对已批准，响应是 {status:"approved", token}；token 只出现一次。
// 同样的 `as` 断言：形状由 kit 保证，客户端不额外校验。
const approved = (await call(port, "POST", "/_chord/pair/poll", {}, { poll })).body as {
	status: string;
	token: string;
};
// 打印 approved 字段（"approved"），而不是 token。
console.log("3. poll:", approved.status);
// 第三次轮询：pairing.poll 已经结束该配对，服务器对未知 poll 返回 404（Answer.status）；
// 注意这里打印 HTTP 状态码，响应正文不包含 token。
console.log("   poll again:", (await call(port, "POST", "/_chord/pair/poll", {}, { poll })).status);
// 设备会话使用 Bearer token；效果与 owner 的浏览器会话相同。
const device = { authorization: `Bearer ${approved.token}` };
// GET / 的身份是 {kind:"owner"}（配对签发的是 owner 设备会话），所以能看到与浏览器相同的响应。
console.log("   CLI GET /:", JSON.stringify((await call(port, "GET", "/", device)).body));

// 5. The owner lists the sessions (a server plugin would do this with `self.get(Sessions, {})`) and revokes the
//    device's: its next request is refused.
// 5. 从服务器宿主直接取得 Sessions 对象；`{}` 是空参数，context 用于生命周期。
// 返回 Reference：list 是 watchable 成员，revoke 是方法，release 释放引用。
const sessions = await app.host.get(Sessions, {}, context);
// 每条 SessionInfo 含 id/label/kind/principal/created/lastUsed，但绝不含 token 或哈希。
console.log("4. sessions:");
// 解构 kind 与 label 输出；kind 取值是 browser 或 device。
for (const { kind, label } of sessions.list.value) console.log(`   ${kind}: ${label}`);
// 按 label 找设备会话；`find` 返回 SessionInfo | undefined。
const laptop = sessions.list.value.find(({ label }) => label === "laptop CLI");
// 吊销该会话；`laptop?.id ?? ""` 在未找到时传空串——revoke 对不存在的 id 也成功（无操作）。
await sessions.revoke(laptop?.id ?? "", context);
// 已吊销的设备 token 再访问：认证失败，服务器返回 401。
console.log("   revoked; CLI GET /:", (await call(port, "GET", "/", device)).status);
// 释放 Reference；这不是关闭服务器。
sessions.release();

// 关闭应用并按顺序清理临时根目录。
await app.close(context);
await rm(base, { recursive: true, force: true });
