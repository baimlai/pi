// 文件导读
// 所属：packages/chord/test/examples/59-chat，Chord 示例 59；本文件是 chat 应用 API v1 的共享契约，
// 通过子路径 `@chat/app/v1` 提供给插件与客户端。
// 作用：声明整个示例的类型骨架：
//   - `Channel`：host kind "channel"，每个频道是一个独立 worker 进程；
//   - `Attachment` / `Message`：消息与附件的 pi-schema 结构（同时用于生成 TypeScript 类型）；
//   - `Room`：频道内的远程对象，活在新 worker 中，状态是最新 100 条消息，方法覆盖历史分页、
//     发消息、分块上传附件、读取附件；
//   - `Channels`：服务器上的远程对象，状态是频道名列表。
// 同时再导出插件常用的一批 Chord API 和 BACKGROUND_CONTEXT。
// 上游：plugins/chat/server.ts 与 worker.ts 实现 Room/Channels/Http；start.ts 把 Channel 作为
// worker kind；web/tui/main.ts 通过客户端 host 获取 Room。
// 下游：packages/chord/src/index.ts 的 schema 构造器、hostKind/remote/method 契约构造器；
// 本文件不执行 I/O，只产生声明对象。
// 能力清单：
// - `Channel`：频道地址构造器，参数 { id: string }；
// - `Attachment`（值+类型）、`Message`（值+类型）：JSON schema 与推导类型；
// - `Room`：远程契约（params、hostAddress、变体 main 的 state/methods）；
// - `Channels`：服务器端远程契约；
// - 再导出：BACKGROUND_CONTEXT 及插件实现需要的 Chord 名字。
// 典型用法（示例）：
//   const room = await host.get(Room, { id: "general" }, ctx);
//   await room.post("hello", ctx);
//   const messages = room.messages.value; // 最新一页
// 阅读顺序：先看 Channel → Attachment/Message → Room 的方法表，最后看 Channels 与再导出。
// 运行方式：被所有宿主与插件导入，不能单独运行。
// 校验边界：声明期会检查名称与 version；params 与 method 参数在每次调用时用编译后的闭合 schema
// 校验（缺字段/多字段都会 invalid）；state 和方法返回值不做运行时校验，只靠 TypeScript 类型。

// The chat's API, version 1, shared by every host kind (`@chat/app/v1`): the part of Chord its plugins and clients use,
// and the chat's own contracts. A channel is a worker of its own (`Channel({ id })`); its `Room` lives there, with the
// messages in a table of the worker's store (the newest live, older ones by page) and the attachments in its files.
// The server keeps the channel list (`Channels`).

// 一行导入多个 schema/契约构造器；`type Static` 是仅类型导入，其余是运行时函数。
// - arr(...) 数组 schema；bytes() 二进制叶子；int()/num()/str() 标量；obj(...) 闭合对象；
// - opt(...) 可选字段；hostKind(name, params) 宿主种类地址；remote(name, options) 远程对象契约；
// - method(args?, result?) 方法签名；Static<T> 从 schema 推导 TypeScript 类型（仅编译期）。
import { arr, bytes, hostKind, int, method, num, obj, opt, remote, type Static, str } from "../../../../src/index.ts";

// 对插件公开的 API 面：只再导出实现真正需要的名字，避免插件依赖整个 src 入口。
// `export ... from` 不会在本地创建绑定，也不会执行这些模块之外的事情。
export { BACKGROUND_CONTEXT } from "../../../../src/context/index.ts";
export {
	arr,
	constant,
	defineFacet,
	defineTable,
	int,
	json,
	local,
	lt,
	method,
	num,
	obj,
	opt,
	query,
	str,
} from "../../../../src/index.ts";

// hostKind 声明一个宿主种类：名称 "channel" 在声明时校验（小写、合法字符），参数 schema { id: str() }
// 是必需的字符串。调用 Channel({ id: "general" }) 得到该 worker 的地址；参数在提供方每次使用时校验。
/** A channel: one worker each. */
export const Channel = hostKind("channel", { id: str() });

/** A file shared in a message: its id in the channel's files, its name, type and size. */
// obj 生成闭合对象 schema（additionalProperties: false）：作为参数校验时，未知字段会直接失败，
// 而不是被静默丢弃。这里同时声明了四个必需字段。
export const Attachment = obj({ id: str(), name: str(), mime: str(), size: int() });

/** An attachment (see `Attachment`). */
// 值与类型同名但位于不同命名空间：`Attachment` 作为值可在运行时使用，作为类型由 Static 推导。
// 这是纯编译期类型，运行时不会检查任意对象是否符合该形状。
export type Attachment = Static<typeof Attachment>;

/** A message: its number, author, text, time, and maybe a file. */
// opt(Attachment) 表示 file 可缺省；at 是数字（示例里用 Date.now() 的毫秒时间戳）。
export const Message = obj({ id: int(), author: str(), text: str(), at: num(), file: opt(Attachment) });

/** A message (see `Message`). */
export type Message = Static<typeof Message>;

/**
 * A channel's room, on its worker: its newest 100 messages (live), the 100 before a message (`history`, the newest
 * without `before`), posting, sharing a file in chunks (`begin`, `append` at the stored offset, `share` posts it), and
 * a shared file's details (`attachment`) and bytes (`read`, at most 4 MiB a call).
 */
// remote 声明远程对象契约：
// - version 参与兼容性检查；任何契约变更都要提升版本；
// - params 是对象身份的一部分，跨链路调用时在提供方校验；
// - hostAddress 把参数映射为地址：Room({ id }) 因此落在 Channel({ id }) 这个 worker 上；
// - variants.main 给出该对象的状态成员与方法集合。
// 对象的身份是 (类型, 参数, principal key)，所以不同用户的 Room 引用也是不同绑定。
export const Room = remote("chat.room", {
	version: 1,
	// params 是扁平记录：只允许 str/int/bool/oneOf 等标量，且不能有可选/嵌套字段。
	params: { id: str() },
	hostAddress: ({ id }) => Channel({ id }),
	variants: {
		main: {
			// state.messages 是数组 schema。state 由服务方提供，Chord 不做运行时校验；
			// 客户端通过引用拿到的是按约定不可变的普通 JSON 值。
			state: { messages: arr(Message) },
			methods: {
				// method(参数 schema, 返回 schema)：参数在服务方校验，返回值不校验。
				// before 可选：不传时返回最新一页，传了则返回该消息之前的一页。
				history: method(obj({ before: opt(int()) }), arr(Message)),
				// 只给参数 schema、不给返回：方法没有返回值（post 不返回新消息 id）。
				post: method(str()),
				// begin 开始一次分块上传，返回 upload id（str）。
				begin: method(obj({ name: str(), mime: str() }), str()),
				// append 写入一块字节；offset 必须等于服务端已存偏移，用于断线后续传与背压。
				// bytes() 是叶子 schema：运行时只认 Uint8Array（可选长度上限），不会遍历其内容。
				append: method(obj({ upload: str(), offset: int(), bytes: bytes() })),
				// 所有分块到齐后 share 把附件和文字一起发成一条消息。
				share: method(obj({ upload: str(), text: str() })),
				// attachment 用附件 id 查元数据；返回 schema 只影响 TypeScript 类型。
				attachment: method(str(), Attachment),
				// read 按偏移/长度读取附件字节；worker 委托给 Files.read（单次最多 4 MiB），
				// 服务器 HTTP 路由再把它限制到 1 MiB。
				read: method(obj({ id: str(), offset: int(), length: int() }), bytes()),
			},
		},
	},
});

/** The channel list, on the server. */
// hostAddress 无参数，返回 server 宿主地址；`hostKind("server")` 是地址构造器，末尾 () 立即构造地址。
// params 为空对象：该对象在每个主机上只有一个实例，状态是频道名数组。
export const Channels = remote("chat.channels", {
	version: 1,
	params: {},
	hostAddress: () => hostKind("server")(),
	variants: { main: { state: { names: arr(str()) } } },
});
