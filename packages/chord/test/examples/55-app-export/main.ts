// 文件导读
// 所属：packages/chord/test/examples/55-app-export，Chord 示例 55，对应 slice 13 §4（按地址导出/导入）。
// 作用：在示例 53 的 notes 应用上演示项目数据的迁移：
//   1) 向 p1 写入文本与附件（worker 的 store 与 files）；
//   2) 在 p1 的 worker 运行中导出：worker 自己打包 open store 的一致点和文件，写成一个 tar（mode 0600），
//      导出不停机；
//   3) 把归档导入新的 p2：得到 p1 的文本与附件，但有自己的 worker 与目录；随后改 p2，p1 不变；
//   4) 再向已有数据的 p1 导入：拒绝，绝不覆盖。
// 上游：../53-app/start.ts（startNotes）与 ../53-app/app/v1.ts 的构造器。
// 下游：app.exportData/importData（src/node/app/app.ts）、归档模块 archive.ts（manifest.json + store.archive +
// files/，tar，0600）、worker 的 store 与文件存储。
// 能力清单：remote 重新声明契约、app.host.get、Reference 的 write/attach/attachment/release、
// exportData、importData、stat 检查权限。
// 典型运行（示例）：
//   cd packages/chord
//   node --conditions=source --experimental-strip-types test/examples/55-app-export/main.ts
// 预期输出形如：
//   1. exported: <N> bytes mode 600
//   2. p2: "the plan" "step 1, step 2"
//      p1 unchanged: "the plan"
//   3. refused: importData: …（临时目录路径被替换成 …）
// 阅读顺序：先看 Notes 的重新声明，再看 1-3 步；归档格式细节在 src/node/app/archive.ts。
// 前置条件：Node 支持 --experimental-strip-types；从 packages/chord 运行。
// 副作用：临时数据目录、回环端口、两个项目 worker、一个 .tar 文件；结束删除临时目录（归档也在其中）。
// 说明：进程本身不能 import @notes/app/v1（那是插件构建时的宿主模块名），所以用相对路径拿到构造器后
// 按相同 name/version/schema 重新声明契约；契约是数据，两端据此绑定。
//
// Export and import a host's data (slice 13 §4, decision "App kit naming and export"), with example 53's notes app.
// `app.exportData` stops nothing: the project's running worker writes one archive of its own store (one consistent
// point) and files, with a manifest (app, API version, format); without a worker the server writes it.
// `app.importData` makes another address from it (refusing one that has data) and the next request starts its
// worker on the imported store and files. Archives of another app are refused.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/55-app-export/main.ts

// mkdtemp/rm 管理临时目录；stat 读取归档大小与 mode。
import { mkdtemp, rm, stat } from "node:fs/promises";
// 系统临时目录。
import { tmpdir } from "node:os";
// 路径拼接。
import { join } from "node:path";
// 示例级后台上下文。
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
// 用相对导入拿到契约构造器；插件源码里的 @notes/app/v1 在本进程不可解析。
import { method, obj, Project, remote, str } from "../53-app/app/v1.ts";
// 启动同一个 notes 应用。
import { startNotes } from "../53-app/start.ts";

// The notes plugin's contract, declared again with the API's builders (contracts are data: the same name, version and
// schema bind). The plugin's own files import `@notes/app/v1`, a host package this process has no module path for.
// 重新声明 notes.notes 契约：名称、版本、params、hostAddress、变体与方法都必须与 plugins/notes/contract.ts 一致。
// 这段是运行时数据构造，不是类型声明；两端各自求值后按内容匹配。
const Notes = remote("notes.notes", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Project({ id }),
	variants: {
		main: {
			state: { text: str(), start: str() },
			methods: {
				write: method(str()),
				attach: method(obj({ name: str(), body: str() }), str()),
				attachment: method(str(), str()),
			},
		},
	},
});

// 临时根与数据目录（base/data）。
const base = await mkdtemp(join(tmpdir(), "notes-"));
const app = await startNotes(join(base, "data"), context);

// 1. Project p1 gets a text and an attachment (its worker's store and files). The server reaches it as `Notes`.
// 1. app.host.get 从服务器取 Notes 对象；hostAddress 把 id p1 映射到 project 地址，
// 首次调用会启动 p1 的 worker。返回 Reference。
const p1 = await app.host.get(Notes, { id: "p1" }, context);
// 远程方法调用：参数 + 上下文；等待 worker 持久化完成。
await p1.write("the plan", context);
// attach 把文本写入项目文件存储，返回文件 id 字符串（保存下来供 p2 读取同一附件）。
const attachment = await p1.attach({ name: "plan.txt", body: "step 1, step 2" }, context);
// 释放远程引用；服务器仍保留 worker，直到空闲或被关闭。
p1.release();

// 2. Export p1 while its worker runs: the worker writes the archive (mode 0600) and goes on.
// 2. 导出时 p1 的 worker 正在运行：exportData 不停止它，而是请求 worker 打包自己的 open store；
// 归档写到 base/p1.tar，权限 0600（仅当前用户可读写）。
const archive = join(base, "p1.tar");
await app.exportData(Project({ id: "p1" }), archive, context);
// stat 读取文件元数据；mode & 0o777 去掉文件类型位，toString(8) 输出八进制权限串，例如 "600"。
// 两次 stat 是示例的简单写法，实际可只取一次。
console.log(
	"1. exported:",
	`${(await stat(archive)).size} bytes`,
	`mode ${((await stat(archive)).mode & 0o777).toString(8)}`,
);

// 3. Import it as p2: a copy with p1's text and attachment, its own worker and directory.
// 3. 导入到 p2：p2 尚无数据，importData 在 worker 锁下解包到新目录；下次访问时启动 p2 的 worker。
// 归档的 manifest 会校验格式版本与应用名；p2 的地址由调用方指定，不取自 manifest。
await app.importData(archive, Project({ id: "p2" }), context);
// 取得 p2 的 Reference（启动其 worker）。text 是导入的 store 状态，attachment 用同一文件 id 读取导入的附件。
const p2 = await app.host.get(Notes, { id: "p2" }, context);
// JSON.stringify 给字符串加引号，便于区分空串与缺失；输出 "the plan" 与 "step 1, step 2"。
console.log("2. p2:", JSON.stringify(p2.text.value), JSON.stringify(await p2.attachment(attachment, context)));
// 修改 p2：只影响 p2 的 store。
await p2.write("p2's own plan", context);
// 释放 p2 引用。
p2.release();
// 再取 p1：它的状态未被 p2 的写入影响。
const again = await app.host.get(Notes, { id: "p1" }, context);
console.log("   p1 unchanged:", JSON.stringify(again.text.value));
// 释放 p1 引用。
again.release();

// 4. An address that has data is never overwritten.
// 4. 再次导入到 p1：p1 已有数据。若 worker 仍在运行，锁被持有 → 拒绝覆盖；
// 若 worker 已空闲停止，目标目录仍存在 → unpackData 拒绝解包到已存在目录。
// `.catch` 把拒绝转成一行输出；error.message.replace(base, "…") 隐藏临时路径。
// 参数注解 `(error: Error)` 只是编译期约定，运行时错误对象来自 Error 子类。
await app
	.importData(archive, Project({ id: "p1" }), context)
	.catch((error: Error) => console.log("3. refused:", error.message.replace(base, "…")));

// 关闭应用并删除临时根（包含数据目录与归档）。
await app.close(context);
await rm(base, { recursive: true, force: true });
