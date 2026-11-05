// 文件导读
// 所属：packages/chord/test/examples/53-app/plugins/notes，notes 插件的远程契约定义。
// 作用：声明“项目笔记”这个对象——参数 id，宿主地址 Project({id})，变体 main 的状态 text/start 与方法
// write/attach/attachment。server.ts 与 worker.ts 都 import 本文件，因此两端拿到同 name/version/schema，
// 调用才能绑定；55 的导出示例在另一个进程中重新声明同一个契约。
// 上游：同目录 package.json（name @notes/notes、private、type module）让发现器把整个目录作为一个插件，
// 文件名决定 facet 种类：server.ts 是 server facet，worker.ts 是 worker facet。
// 下游：@notes/app/v1 的 remote/method/obj/str/Project；工具体逻辑在 worker.ts。
// 能力清单：
// - Notes：远程契约 notes.notes；params.id 在调用边界按 str() 校验；hostAddress 把参数映射到项目 worker；
// - main 变体：state.text/state.start 只读；write(str)、attach(obj, str)、attachment(str, str) 三个方法。
// 典型调用（示例）：
//   const notes = await ctx.get(Notes, { id: "p1" });
//   await notes.write("new text", ctx);
//   const id = await notes.attach({ name: "a.txt", body: "hi" }, ctx);
// 阅读顺序：先看 params 与 hostAddress，再看 variants.main 的 state 与 methods。
// 运行方式：不单独运行；被 server.ts 与 worker.ts import。
// 类型检查与运行时：TS 检查方法参数/返回值和变体形状；实际调用时 Chord 在调用边界按 schema 校验参数，
// 但方法返回值不做运行时校验。契约本身不创建对象，也不做 I/O。
//
// A project's notes: served by the project's worker (`Project({ id })`), reached from the server by id.

// method(输入, 返回) 声明方法；obj/str 是运行时 schema；remote 声明远程契约；Project 是宿主地址构造器。
import { method, obj, Project, remote, str } from "@notes/app/v1";

// 同一个契约只能由一个宿主提供；调用方按 name+version 找到它，再按 hostAddress 连到项目 worker。
export const Notes = remote("notes.notes", {
	// 契约版本：名称相同但版本不同是两个不同的契约。
	version: 1,
	// 参数 schema：调用方给 { id }，Chord 在调用边界校验它是字符串。
	params: { id: str() },
	// hostAddress 决定对象住在哪个宿主：每个 id 映射到一个 project 地址，因此每个项目有自己的 worker 与 store。
	hostAddress: ({ id }) => Project({ id }),
	// variants：同一契约可以按变体提供不同形状；worker 提供 main，调用方请求这个变体。
	variants: {
		main: {
			// 状态成员只读：调用方拿到的 Reference 有 .value，没有 setter；写入通过方法。
			// start 是服务器给的启动数据（这里是 JSON 字符串），由 worker 派生。
			state: { text: str(), start: str() },
			methods: {
				/** Replaces the project's text. */
				// 输入是字符串，返回 null（method 的默认返回可省略为 null）。
				write: method(str()),
				/** Stores an attachment in the project's files; its id. */
				// 输入对象含名称与文本；返回文件 id 字符串。
				attach: method(obj({ name: str(), body: str() }), str()),
				/** An attachment's text. */
				// 输入附件 id，返回其文本内容（示例截取前 64 KiB）。
				attachment: method(str(), str()),
			},
		},
	},
});
