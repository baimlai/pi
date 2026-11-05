// 文件导读
// 所属：packages/chord/test/examples/53-app/plugins/notes，notes 插件的 worker facet。
// 作用：在每个项目的 worker 进程里提供服务——持久化文本（Text 文档 + Store 对象）、远程契约 Notes 的 main
// 变体，以及项目文件存储里的附件（kit 的 Files）和启动数据（WorkerInfo）。
// 上游：同目录 package.json（name @notes/notes、private、type module）；start.ts 的 workers[0].entry 启动
// worker 进程，服务器在首次访问 /notes/:id 时按需拉起；发现器按 worker.ts 构建 worker facet。
// 下游：@notes/app/v1 的 defineState/local/method/obj/str、WorkerInfo、Files；./contract.ts 的 Notes。
// 能力清单：
// - Text：持久化文档 notes.text，schema {text}，每 20 个 delta 打一次检查点；
// - Store：本地契约 notes.store，params 为空，成员 text（只读）与 write（写入）；
// - Notes 的 main 变体：text/start 派生值，write/attach/attachment 三个方法。
// 典型调用（示例）：
//   await notes.write("milk, eggs", ctx);
//   const id = await notes.attach({ name: "plan.txt", body: "step 1" }, ctx);
//   const text = await notes.attachment(id, ctx);
// 阅读顺序：先看 Text/Store 两个定义，再看两个 host.serve 的工厂与成员。
// 运行方式：不单独运行；由服务器的 worker 组件启动（见 ./worker.ts 的 startWorker）。
// 副作用：写入 workers/<kind>/<key>/store.sqlite；附件写入该目录下的文件存储。空闲 60 秒后被停止，
// 下次访问时从持久状态恢复。
//
// The notes plugin's worker facet: the project's text in a persisted document (kept by a local object with empty
// params, the worker's one copy: a persisted state needs a stable identity), its attachments in the project's files
// (the kit's `Files`), and the start data the app gave the worker (`WorkerInfo`).

// defineFacet 声明 facet；defineState 声明持久化文档；local 声明本地契约；method/obj/str 是 schema；
// Files 与 WorkerInfo 是 kit 核心对象。
import { defineFacet, defineState, Files, local, method, obj, str, WorkerInfo } from "@notes/app/v1";
// 与 server facet 共享的远程契约。
import { Notes } from "./contract.ts";

// 持久化文档定义：名称、值 schema、文档版本、初始值；persist 为 true 时必须给 checkpointWhen。
// checkpointWhen 接收 (文档新值, 本次提交的 ops, CheckpointInfo)；返回 true 表示把整个值存成新 base，
// 返回 false 表示存 delta。这里按 deltasSinceBase >= 20 打检查点，控制恢复时的重放成本。
const Text = defineState("notes.text", {
	schema: obj({ text: str() }),
	version: 1,
	initial: () => ({ text: "" }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 20,
});

// 本地契约：notes.store，params 为空意味着每个 worker 一份（持久化状态需要稳定身份，空参数保证了这一点）。
// text 是只读状态成员；write 是方法，输入字符串。
/** The project's text, one per worker. */
const Store = local("notes.store", { version: 1, params: {}, members: { text: str(), write: method(str()) } });

// 本 facet 提供两个对象：Store（内部对象）与 Notes（远程契约）。host 参数不使用，故省略。
export default defineFacet((host) => {
	// host.serve(契约, 工厂) 提供对象；工厂拿到参数与 self（对象的构建上下文）。
	// Store 的 params 为空，工厂第二个参数 self 提供 state/derive 等能力。
	host.serve(Store, (_params, self) => {
		// self.state(Text) 打开（或恢复）持久化文档，返回 watchable 状态。
		const text = self.state(Text);
		return {
			// text 成员取文档的 text 字段；来源变化时派生值随之更新。
			text: self.derive([text], ([value]) => value.text),
			// write 方法：在 change 回调里修改草稿；Chord 把修改作为 delta 持久化，
			// 达到 checkpointWhen 条件时写检查点。返回 null 表示无返回值。
			write: async (next, ctx) => {
				await text.change((draft) => {
					draft.text = next;
				}, ctx);
				return null;
			},
		};
	});
	// 提供 Notes 的 main 变体。工厂签名是 (params, principal, self)；这里参数与身份都用不到。
	host.serve(Notes, (_params, _principal, self) => {
		// self.get(Store,{}) 取得本 facet 刚提供的 Store 引用；store.text 是它的 watchable 成员。
		const store = self.get(Store, {});
		// WorkerInfo 是 kit 核心契约：address 与服务器给的 start 数据。
		const info = self.get(WorkerInfo, {});
		// Files 是每主机文件存储：put/read 都带 ctx。
		const files = self.get(Files, {});
		return {
			// 变体标签：调用方请求 main 时绑定到这份实现（编译期收窄，运行时由 host 匹配）。
			variant: "main",
			members: {
				text: self.derive([store.text], ([text]) => text),
				// start 是服务器 start(address) 的返回值；这里转成 JSON 字符串，契约里声明为 str。
				start: self.derive([info.start], ([start]) => JSON.stringify(start)),
				// 方法直接委托给 Store。
				write: (next, ctx) => store.write(next, ctx),
				// attach：把文本编码成字节写入项目文件存储，返回文件 id。
				attach: ({ name, body }, ctx) =>
					files.put({ name, mime: "text/plain", bytes: new TextEncoder().encode(body) }, ctx),
				// attachment：读取文件前 64 KiB 并解码为字符串。
				// offset/length 是 Files.read 的必需参数；id 无效时错误会沿调用链返回给调用方。
				attachment: async (id, ctx) =>
					new TextDecoder().decode(await files.read({ id, offset: 0, length: 65536 }, ctx)),
			},
		};
	});
});
