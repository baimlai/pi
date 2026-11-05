// Size limits per part and compression at the origin. A host with a synchronous compressor (`nodeCompression` on
// Node) deflates each JSON part above 16 KiB once, when it encodes it; relays forward it as it is; the end that owns it
// inflates it, within its link's decoded limit. A browser has no synchronous deflate: it sends uncompressed and
// inflates with `DecompressionStream`, later messages of its link waiting in order. Only a part that shrinks is sent
// deflated, and never hold params. Clients never send compressed parts: a host sends its call arguments up its parent
// link uncompressed, and a link the server accepted (a child) refuses compressed parts as a protocol error (a small
// part could inflate to 64 MiB there). A part past a limit fails only its own hold or call (`too_large/part`); the
// link stays. Limits and the threshold count UTF-8 bytes.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/17-limits-and-compression.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 17，对应 slice 4b（每个 part 的大小限制、源端压缩）。
// 演示什么：server 用 nodeCompression 对超过 16 KiB 的 JSON part 做同步 deflate，接收端在 decoded 限额内 inflate；
//   part 限额按 UTF-8 字节拒绝过大的分片；压缩炸弹在解压上限处失败；客户端即使配置了压缩器，也沿父链路发送未压缩
//   的调用参数，因为 server 接受的子链路会拒绝压缩分片。失败只影响该 hold/call，链路本身保持可用。
// 上游/下游：文件顶部命令启动；下游使用 src/node/compression.ts 的 nodeCompression、src/link 的 memoryLinkPair/
//   PartLimits/Compression、src/host 的 createHost/accept/connect。示例全在进程内运行；大文本由本地生成，不访问网络。
// 能力清单（按演示的机制）：
// - Compression 接口：deflate(bytes) 同步压缩；inflate(bytes, limit) 返回 bytes/too_large/corrupt 联合。
// - createHost({ compression })：宿主编码 part 时压缩；relay 原样转发，不重复压缩。
// - PartLimits：part（线上字节上限）与 decoded（解压后上限）；accept/connect 可分别设置。
// - too_large/part：超限只让当前 hold 或 call 失败，链路继续服务其他请求。
// - 压缩炸弹防护：50 KB 压缩数据解压到 6 MB，超过 tab 的 1 MiB decoded 限额，只有该 hold 失败。
// - 客户端上行不压缩：调用参数沿父链路发送，server 的 counted 包装器显示约为原始 JSON 大小。
// - counted Link：包装 Link 并累计收到的字节数，用来比较压缩前后传输量。
// 典型运行顺序：场景 1 对同一 500 KB 快照分别用无压缩与 nodeCompression，比较传输字节与耗时；场景 2 设置 part 64 KiB，
//   提交 100 KB 参数失败后仍可提交小参数；场景 3 用 6×1 MB 的重复文本制造压缩炸弹，验证只失败该 hold；
//   场景 4 让带压缩器的 client 提交 100 KB 参数，确认 server 收到的是未压缩 JSON。
// 示例（符合真实签名）：
//   const server = createHost<P>({ address: Server(), principal: { kind: "server" }, compression: nodeCompression });
//   server.accept(a, { principal: { kind: "user" }, limits: { part: 64 * 1024 } }, context);
//   // 超过 64 KiB 的分片让该次调用以 too_large/part 拒绝，链路保留
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；需要 Node 的 zlib（nodeCompression）；无环境变量、无网络。
// 预期输出（字节数与毫秒数随运行略有浮动）：snapshot uncompressed: 500 entries, 500.7 KiB received, ~2 ms；
//   snapshot deflated at the server, inflated asynchronously: 500 entries, ~142 KiB received, ~10 ms；
//   a 100 KB argument: too_large/part: a part of 100022 bytes is over the wire limit of 65536 bytes；
//   the link stays: entries [ 'small' ]；the bomb's hold: too_large/part；another hold on the same link: 500 entries；
//   a compressing client's 100 KB argument: ~98 KiB received by the server。
// 对应测试与文档：packages/chord/test/link/part.test.ts、test/node/compression.test.ts；slices.md 的 slice 4b；
//   设计文档中关于分片限额与压缩的章节。
// 建议阅读顺序：先看 Store/Conversation 契约与 facet，再看 counted 与 setUp（限额注入点），随后看 text/fill 的
//   数据生成，最后按 1-4 步读快照、限额、炸弹与上行不压缩。
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { arr, hostKind, local, method, obj, remote, str } from "../../src/contracts/index.ts";
import { isChordError } from "../../src/data/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type Host } from "../../src/host/index.ts";
import { type Compression, type Link, memoryLinkPair, type PartLimits } from "../../src/link/index.ts";
import { nodeCompression } from "../../src/node/compression.ts";

// 后台上下文；fill 与 get 显式传入。
const context = BACKGROUND_CONTEXT;

// P 只有 user 与 server 两种 principal。
type P = { kind: "user" } | { kind: "server" };

// Entry 是会话条目的 schema：id 与 text 都是字符串。
const Entry = obj({ id: str(), text: str() });

/** The shared store of a conversation: its entries, once, and the method that appends to them. */
// Store 按会话 id 区分；entries 是派生状态，append 接收 Entry 并返回无结果。
const Store = local("example.store", {
	version: 1,
	params: { id: str() },
	members: { entries: arr(Entry), append: method(Entry) },
});

// The server's host kind: a remote contract's `hostAddress` names the host serving its objects.
// 无参数 hostKind；Conversation 的 hostAddress 固定指向它。
const Server = hostKind("server");

/** What a tab holds: the conversation's entries, and appending. */
// Conversation 远端契约：按 id 寻址，v 变体暴露 entries 与 append。
const Conversation = remote("example.conversation", {
	version: 1,
	params: { id: str() },
	hostAddress: () => Server(),
	variants: { v: { state: { entries: arr(Entry) }, methods: { append: method(Entry) } } },
});

// 每个 Store 一份文档；list 保存全部条目。
const Entries = defineState("entries", {
	schema: obj({ list: arr(Entry) }),
	version: 1,
	initial: () => ({ list: [] }),
});

// facet 登记 Store 与 Conversation；后者的工厂通过依赖引用共享 Store。
const facet = defineFacet<P>((host) => {
	host.serve(Store, (_, self) => {
		const doc = self.state(Entries);
		return {
			// entries 派生自文档列表。
			entries: self.derive([doc], ([d]) => d.list),
			// append 追加一条 Entry；`void` 丢弃 push 的数字返回值。
			append: async (entry, ctx) => {
				await doc.change((draft) => void draft.list.push(entry), ctx);
				return null;
			},
		};
	});
	host.serve(Conversation, ({ id }, _principal, self) => {
		// 依赖同一 id 的 Store；不同会话各自一份文档。
		const store = self.get(Store, { id });
		// entries 直接复用 store 的派生；append 转调本地存储。
		return { variant: "v", members: { entries: store.entries, append: (entry, ctx) => store.append(entry, ctx) } };
	});
});

/** A link end counting the bytes its host receives. */
// counted 返回包装 Link：四个方法委托给内部链路，onMessage 先累加字节数再交给下游。
// bytes 用对象而不是 number 参数，因为数字按值传递，包装器需要写回调用者可见的计数。
function counted(link: Link, bytes: { received: number }): Link {
	return {
		send: (message) => link.send(message),
		onMessage: (listener) =>
			link.onMessage((message) => {
				// 统计线上字节（压缩后或未压缩的实际分片大小）。
				bytes.received += message.byteLength;
				listener(message);
			}),
		close: () => link.close(),
		onClose: (listener) => link.onClose(listener),
	};
}

/**
 * A server compressing with `compression` and a tab without a compressor (a browser) on a link the server accepts with
 * `limits`; the tab's own link to the server has `tabLimits`.
 */
// setUp 建立一组 server/tab：server 侧 accept 时设置 limits（限制来自 tab 的分片），
// tab 侧 connect 时设置 tabLimits（限制来自 server 的分片与解压上限）；tab 端用 counted 统计接收字节。
async function setUp(compression: Compression | undefined, limits?: PartLimits, tabLimits?: PartLimits) {
	const server = createHost<P>({
		address: Server(),
		principal: { kind: "server" },
		// compression 可选：undefined 表示不压缩（模拟不支持同步 deflate 的浏览器服务端）。
		compression,
		onError: console.error,
	});
	await server.load([{ name: "@example/conversation", facet }], context);
	// tab 没有压缩器，模拟浏览器；它只接收并异步解压。
	const tab = createHost<P>({ onError: console.error });
	await tab.load([], context);
	const [a, b] = memoryLinkPair();
	// 计数对象由调用者持有，最后返回以便打印。
	const bytes = { received: 0 };
	// server 接受子链路：principal 为 user，limits 限制 tab 发来的 part。
	server.accept(a, { principal: { kind: "user" }, limits }, context);
	// tab 连接父链路：counted 包住 tab 端，limits 覆盖默认的 part/decoded 上限。
	tab.connect(counted(b, bytes), { principal: { kind: "server" }, limits: tabLimits }, context);
	return { server, tab, bytes };
}

/** Words for entries that compress like prose (about 3x), not like a repeated string. */
// 单词表用于生成接近自然语言的文本，压缩率约 3 倍；用空格切分得到数组。
const WORDS = "the a model tool call file read write test error result agent session note code run build".split(" ");

/** Entry `i`'s text: about 1 KB of words picked by a fixed pseudo-random sequence. */
// text 生成第 i 条约 1 KB 的文本：线性同余伪随机数选择单词，偶尔拼接数字；结果确定、可复现。
// 参数 i 是数字，返回字符串；没有副作用。
function text(i: number): string {
	// seed 的初值随 i 变化；JS 数字是双精度，乘积可能超出安全整数范围，但示例只要求可重复，不要求随机质量。
	let seed = i * 7919 + 1;
	const words: string[] = [];
	// 循环直到累计长度达到 1000；words.at(-1) 取最后一个单词，! 断言其存在（首次循环条件已保证）。
	for (let length = 0; length < 1000; length += words.at(-1)!.length + 1) {
		// LCG 更新：乘加后对 2^31 取模，得到下一个伪随机值。
		seed = (seed * 1103515245 + 12345) % 2147483648;
		// 用 seed 对单词表长度取模选词；! 断言索引一定在范围内。
		const word = WORDS[seed % WORDS.length]!;
		// 五分之一概率给单词加数字后缀，增加词汇多样性。
		words.push(seed % 5 === 0 ? `${word}${seed % 1000}` : word);
	}
	// 用空格连接；长度会比循环累计略大，不影响演示。
	return words.join(" ");
}

/** Fills the server's conversation `id` with 500 entries of about 1 KB (its store kept by this reference). */
// fill 在 server 本地获取 Store 引用（保持对象存活），连续 append 500 条约 1 KB 的条目。
async function fill(server: Host<P>, id: string): Promise<void> {
	const conversation = await server.get(Store, { id }, context);
	for (let i = 0; i < 500; i++) await conversation.append({ id: `e${i}`, text: text(i) }, context);
}

// 1. A 500 KB snapshot to a browser tab, without and with compression at the server.
// 场景 1：分别用 undefined 与 nodeCompression 建立两组宿主，观察同一快照的传输字节与耗时。
for (const compression of [undefined, nodeCompression]) {
	const { server, tab, bytes } = await setUp(compression);
	await fill(server, "c1");
	// performance.now 返回毫秒时间戳；相减得到 get 的耗时。
	const started = performance.now();
	// 首次 get 触发完整快照（超过 16 KiB，压缩器存在时会被 deflate）。
	const conversation = await tab.get(Conversation, { id: "c1" }, context);
	const ms = (performance.now() - started).toFixed(1);
	// 标签区分两种传输方式；三元表达式只在展示层使用。
	const label = compression === undefined ? "uncompressed" : "deflated at the server, inflated asynchronously";
	// KiB 由字节数除以 1024 得到；entries 数量验证内容完整。
	console.log(
		`snapshot ${label}: ${conversation.entries.value.length} entries, ${(bytes.received / 1024).toFixed(1)} KiB received, ${ms} ms`,
	);
	// 关闭本组宿主，进入下一轮。
	await tab.close(context);
	await server.close(context);
}

// 2. Limits per part: the server admits at most 64 KiB per part from this tab. A larger argument fails its call only.
// 场景 2：server 的 accept 限制每个 part 最大 64 KiB。
{
	const { server, tab } = await setUp(nodeCompression, { part: 64 * 1024 });
	const conversation = await tab.get(Conversation, { id: "c2" }, context);
	// try/catch 展示超限：100_000 个字符的参数超过 64 KiB，只有这次调用失败。
	try {
		await conversation.append({ id: "big", text: "x".repeat(100_000) }, context);
	} catch (error) {
		// 打印 code/reason 与消息；消息包含实际字节数和限额。
		console.log(
			"a 100 KB argument:",
			isChordError(error) ? `${error.code}/${error.reason}: ${error.message}` : error,
		);
	}
	// 链路仍然可用：下一次小参数调用成功。
	await conversation.append({ id: "small", text: "fits" }, context);
	console.log(
		"the link stays: entries",
		conversation.entries.value.map(({ id }) => id),
	);
	await tab.close(context);
	await server.close(context);
}

// 3. A compression bomb: 50 KB deflated that would inflate to 6 MB, past the tab's decoded limit of 1 MiB. The tab
// stops inflating at the limit; only that hold fails.
// 场景 3：server 提供压缩；tab 的 connect 设置 decoded 1 MiB 上限。
{
	const { server, tab } = await setUp(nodeCompression, undefined, { decoded: 1024 * 1024 });
	// 先在 server 本地写入 6 条各 1 MB 的重复文本；它们压缩后很小，但解压后是 6 MB。
	const bomb = await server.get(Store, { id: "bomb" }, context);
	for (let i = 0; i < 6; i++) await bomb.append({ id: `z${i}`, text: "0".repeat(1_000_000) }, context);
	// 另一个正常会话，用于验证同一链路仍可服务其他 hold。
	await fill(server, "fine");
	try {
		await tab.get(Conversation, { id: "bomb" }, context);
	} catch (error) {
		// 解压超过 decoded 上限 → too_large/part；只有这个 hold 失败。
		console.log("the bomb's hold:", isChordError(error) ? `${error.code}/${error.reason}` : error);
	}
	// 同一链路上的另一个 hold 正常返回 500 条。
	const fine = await tab.get(Conversation, { id: "fine" }, context);
	console.log("another hold on the same link:", fine.entries.value.length, "entries");
	await tab.close(context);
	await server.close(context);
}

// 4. A client with a compressor still sends its arguments up uncompressed: the server, which accepted its link as a
// child, would refuse a compressed part. Its 100 KB argument arrives as JSON, within the server's default limits.
// 场景 4：client 也配置了 nodeCompression，但上行参数仍不压缩；server 端用 counted 统计收到的字节。
{
	const server = createHost<P>({
		address: Server(),
		principal: { kind: "server" },
		compression: nodeCompression,
		onError: console.error,
	});
	await server.load([{ name: "@example/conversation", facet }], context);
	// 客户端压缩器只用于它作为 origin 发送的状态；调用参数走父链路时保持未压缩。
	const client = createHost<P>({ compression: nodeCompression, onError: console.error });
	await client.load([], context);
	const [a, b] = memoryLinkPair();
	const bytes = { received: 0 };
	// server 端计数；accept 不额外设置 limits，使用默认限额。
	server.accept(counted(a, bytes), { principal: { kind: "user" } }, context);
	client.connect(b, { principal: { kind: "server" } }, context);
	const conversation = await client.get(Conversation, { id: "c4" }, context);
	// 约 100 KB 的参数经 JSON 分片上行；server 收到的字节数接近原始大小。
	await conversation.append({ id: "big", text: text(0).repeat(100) }, context);
	console.log(
		`a compressing client's 100 KB argument: ${(bytes.received / 1024).toFixed(1)} KiB received by the server`,
	);
	await client.close(context);
	await server.close(context);
}
