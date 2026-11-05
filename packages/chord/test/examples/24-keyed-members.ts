// 文件导读
// 所属：packages/chord/test/examples，Chord v2 示例 24，对应 slice 6a §12（keyed state 成员）。
// 演示内容：local 契约用 keyed(schema) 把一个 keyed 文档集合暴露成单个成员。同宿主的消费者可以在工厂里用
// ref.member.at(key) 固定一个 key（得到 watchable，并成为自己 hydration 的一部分），也可以在对象外部用
// ref.member.get/watch(key, ctx) 读/观察任意 key。每个 key 只有一个 source，多个消费者共享它。
// 上游入口：命令行直接运行；全部为内存文档，不写文件、不需要 store。
// 下游调用：keyed（契约成员）、defineState（keyed 文档）、createHost/defineFacet、self.state/self.get/self.derive，
// 以及 Reference 的 at/get/watch/release。derive 的变更传播由 Chord 的 state 层完成。
// 失败行为：工厂外调用 at(key) 会抛错；读取缺失 key 的 get 返回 undefined；释放后的引用再使用会抛 released。
// 能力清单（按演示机制列出，本文件没有导出）：
// - Profile：用户资料 schema { name, status }。
// - Profiles：内存 keyed 文档，initial 为离线空 profile。
// - Directory 契约：profiles 是 keyed 成员；set 方法一次更新某用户的资料。
// - Badge 契约：params { user }，每个用户一个对象；label 是展示用字符串状态。
// - facet：Directory 返回 keyed 句柄；Badge 用 self.get + at(user) pin 资料并 derive 出 label。
// - 主流程：写入 ana 资料 → 取 ana 的 badge（激活时 pin/load）→ 读 label → 改资料 → label 跟随变化 → 读缺失 key → 释放。
// 典型运行顺序：load → get Directory → set ana → get Badge(ana)（依赖 pin 与加载）→ 读 label → set away → 再读 label。
// 示例（真实签名）：
//   const ref = self.get(Directory, {});
//   const profile = ref.profiles.at("ana");            // 仅工厂内；Watchable<{name,status}>
//   const label = self.derive([profile], ([p]) => `${p.name} (${p.status})`);
// 阅读顺序：先看 Profile/Profiles/Directory/Badge 四个声明，再看两个工厂的 pin 与 derive，最后看主流程的两次 label 读取。
// 前置条件：Node 支持 --experimental-strip-types。在 packages/chord 下运行：
//   node --conditions=source --experimental-strip-types test/examples/24-keyed-members.ts
// 预期输出（已实际运行核对）：
//   badge: Ana (online)
//   badge after a change: Ana (away)
//   ref.profiles.get(bo): undefined
// 相关文档：packages/chord/docs/slice-6a.md（§12 keyed 成员与 pin）；相关测试：test/host/ 的 keyed 成员/derive 用例。
// Keyed state members: a `local` contract exposes a keyed document set as one member, `keyed(schema)`. A consumer on
// the same host pins one key with `ref.member.at(key)` in its factory (a watchable, part of its own hydration), or
// reads and watches any key with `ref.member.get/watch(key, ctx)`. One source per key: consumers share it.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/24-keyed-members.ts
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { keyed, local, method, obj, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";

// 后台上下文：本例没有取消需求。
const context = BACKGROUND_CONTEXT;

// schema 可以提取成常量复用：Profile 是编译期类型来源，也是运行期 schema 对象。
// defineState 会 snapshot 它的规范形式并计算指纹，不会在运行期修改这个对象。
const Profile = obj({ name: str(), status: str() });

// 内存 keyed 文档：每个用户 key 一份 profile；缺席时 initial() 给出空名字 + 离线状态。
const Profiles = defineState("profiles", {
	schema: Profile,
	version: 1,
	initial: () => ({ name: "", status: "offline" }),
	keyed: true,
});

// The directory: every user's profile, one keyed member.
// keyed(Profile) 把契约成员标记为 keyed state：调用方看到的不再是单个值，而是可按 key 读/观察的成员。
// set 方法参数包含 user（选择 key）和要写入的两个字段。
const Directory = local("example.directory", {
	version: 1,
	params: {},
	members: { profiles: keyed(Profile), set: method(obj({ user: str(), name: str(), status: str() })) },
});

// A badge per user: its own object, showing one profile.
// params { user } 让每个用户有独立 Badge 实例；params 参与对象身份，也是错误信息的一部分。
// label 是 state 成员，实现里由 derive 提供。
const Badge = local("example.badge", { version: 1, params: { user: str() }, members: { label: str() } });

const facet = defineFacet((host) => {
	host.serve(Directory, (_, self) => {
		// keyed 句柄：对象内部读写 Profiles 的入口。
		const profiles = self.state(Profiles);
		return {
			// The keyed handle is the member as it is.
			// keyed 成员的实现就是 KeyedHandle：Chord 会把它解析成最终的 KeyedSlot 供消费者读取。
			profiles,
			set: async ({ user, name, status }, ctx) => {
				// change 在一个事务里草拟 user 对应的文档；Object.assign 返回目标 draft，
				// 所以表达式箭头函数把两个字段合并进草稿后返回草稿；返回值这里不需要，change 仍会等事务提交。
				// 草稿在提交后撤销，不能保存到事务外。
				await profiles.change(user, (draft) => Object.assign(draft, { name, status }), ctx);
				return null;
			},
		};
	});
	host.serve(Badge, ({ user }, self) => {
		// Pinned for this attempt; the badge goes live once the profile is loaded.
		// 工厂里 self.get 同步声明对 Directory 的依赖（不需要 ctx）；真正绑定/加载由框架在激活时完成。
		// .profiles 是该引用的 keyed 成员；.at(user) 只能在工厂内调用，它把 user 这个 key 固定到本次 attempt：
		// 返回一个 Watchable（KeyedMemberAt），并在对象 live 前加载该文档，因此 Badge 变为 live 时 profile 已有值。
		// 同一个 key 在 Directory 与 Badge 之间共享同一个 source，不会各复制一份数据。
		const profile = self.get(Directory, {}).profiles.at(user);
		// derive 接收源数组与计算函数；回调收到与源顺序对应的最新值数组。
		// 这里解构出 p，模板字符串拼出 "名字 (状态)"；p.name 为空时退回 user。
		// 结果 T 必须 extends JsonValue（此处是 string），derive 返回 watchable，作为 label 成员的实现。
		return { label: self.derive([profile], ([p]) => `${p.name || user} (${p.status})`) };
	});
});

// 无 store 宿主：所有文档与对象都在内存中。
const host = createHost({ onError: (error) => console.error("background error:", error) });
// 只加载 facet；Directory 是空 params 对象，在 load 阶段激活。
await host.load([{ name: "@example/directory", facet }], context);
// 取得 Directory 引用；空 params 传 {}。
const directory = await host.get(Directory, {}, context);
// 写入 ana 的资料：user 作为 key，name/status 写入该 keyed 文档。
await directory.set({ user: "ana", name: "Ana", status: "online" }, context);

// 取 Badge（参数 user=ana）：首次 get 触发 Badge 激活；工厂里的 at("ana") 会 pin 并加载刚写入的资料。
const badge = await host.get(Badge, { user: "ana" }, context);
// label 是引用上的 state 成员，.value 同步读取 derive 的当前结果。
console.log("badge:", badge.label.value);
// 再次修改 ana 的资料：共享同一 keyed source，derive 重新计算，label 随之变化。
await directory.set({ user: "ana", name: "Ana", status: "away" }, context);
// set 的 Promise resolve 时变更已传播到 derive，因此 .value 同步读到新值；输出 Ana (away)。
console.log("badge after a change:", badge.label.value);
// Any key, read where it is needed.
// 引用上的 keyed 成员 get 行为类似调用：对象加载中会等待，key 不存在返回 undefined（不抛错）。
// 这里 bo 从未写入，因此打印 undefined。
console.log("ref.profiles.get(bo):", await directory.profiles.get("bo", context));

// release 释放本次引用；Badge 只有这一个引用，因此对象结束后，再使用 badge 会抛 released。
// Directory 引用没有显式 release，由 host.close 统一释放。
badge.release();
// 关闭宿主：结束剩余对象及其依赖 pin，释放全部资源。
await host.close(context);
