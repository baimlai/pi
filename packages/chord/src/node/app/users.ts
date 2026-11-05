// The users plugin (slice 13 §3, decision "The app kit, point 2: principals and users"): accounts keyed by the user's
// id with a profile the app describes (a schema it passes in: a Slack-like profile or just a name), kept in the
// server's store. User data never rides in the principal: a principal names the user, `Users` holds the rest.
// An exported facet, not a plugin directory: it takes the app's schema as an argument (settings are arguments), and a
// plugin directory could not import it (plugins import only the app's API). The app loads it in its root by
// re-exporting it through its API (`export const users = defineUsers(Profile)` in `/v3/server`, a one-line plugin).

// 所属：packages/chord/src/node/app，app kit 的 users 插件（slice 13 §3；decision 点 2）。
// 职责边界：按用户 id 保存应用自定义 profile，提供 list/get/update/remove；不负责认证，也不把资料放进 principal。
// 上游：应用调用 defineUsers(profileSchema) 并把结果通过 API 导出；下游：documents 持久化 Accounts，host 提供对象。
// 结果与错误：update/remove 返回 null；get 返回资料或 null；非法 profile 由文档 schema 抛 invalid，__proto__ id 也抛 invalid。
// 能力清单：defineUsers 返回 { Users, facet }；Users 是本地契约；Accounts 是持久文档；内部 get/update/remove 使用 Object.hasOwn 与 __proto__ 防护。
// 组合顺序：defineUsers → host.serve → self.state(Accounts) → list/derive、get、update/remove；应用导出 facet 后由插件加载。
// 示例：const users = defineUsers(obj({ name: str() })); const ref = await ctx.get(users.Users, {}); await ref.update({ id: 'u1', profile: { name: 'Ada' } }, ctx)。
// 建议阅读顺序：先看 defineUsers 的契约与文档声明，再看 facet 内的四个成员。
import { arr, local, map, method, nul, obj, type Schema, str, union } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { invalid } from "../../data/internal.ts";
import { defineState } from "../../documents/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";

/** The users plugin for profiles of schema `profile`: its contract and the facet serving it on the server. */
// 创建 users 插件：输入资料 schema profile，输出本地契约 Users 与在服务器主机上服务它的 facet。
// 副作用只在加载 facet/写入资料时发生；这里只声明契约和文档，不打开 store。update 遇到非法资料由文档校验报 invalid。
// 泛型 T 是资料的 JSON 类型，P 是主机 principal 类型；默认 P=Principal 表示此契约本身不限制调用者身份，权限由对象所在主机决定。
// 例子：const users = defineUsers(obj({ name: str() })); 应用把 users.facet 放进根插件，再用 users.Users 取账号。
export function defineUsers<T extends JsonValue, P extends Principal = Principal>(profile: Schema<T>) {
	// local(...) 声明空参数、每主机一个的本地契约；version 是契约版本，与下面文档状态版本分开。
	const Users = local("chord.app.users", {
		version: 1,
		// params: {} 表示对象没有定位参数，主机地址即可唯一确定它。
		params: {},
		members: {
			// list 是派生状态成员：账号文档变化会产生新数组；profile 沿用调用方 schema。
			/** Every user: id and profile. */
			// arr(obj(...)) 是运行时 schema：每项必须有 id 字符串和符合 profile 的资料。
			list: arr(obj({ id: str(), profile })),
			// get 是方法成员：传入 id，结果由 union([profile, nul()]) 描述为资料或 null。
			/** The profile of user `id`, or `null`. */
			get: method(str(), union([profile, nul()])),
			// method(obj(...)) 声明一个对象参数，成功结果默认为 null；update 写入或替换 id 的资料。
			/** Sets the profile of user `id` (a new user: an account made). */
			update: method(obj({ id: str(), profile })),
			// remove 接收一个 id 字符串，删除账号；成功仍以 null 表示。
			/** Removes user `id`'s account. */
			remove: method(str()),
		},
	});
	// Stored as JSON: the document's types cannot follow a generic profile, the contract's members do.
	// stored 把泛型 profile 断言为 Schema<JsonValue>：文档状态无法携带泛型，断言不改变运行时 schema 对象。
	const stored = profile as Schema<JsonValue>;
	// defineState 声明持久文档 Accounts：schema 是 {users: map(profile)}，即 id 到资料的映射。
	const Accounts = defineState("chord.app.users", {
		schema: obj({ users: map(stored) }),
		version: 1,
		// initial 返回空映射；没有任何持久数据时从空账号表开始。
		initial: () => ({ users: {} }),
		// persist: true 让文档写进 store；服务器重启后账号还在。
		persist: true,
		// checkpointWhen 在累计 50 个增量后写检查点，控制文档日志长度；三个参数中只用到 deltasSinceBase。
		checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
	});
	// 创建 facet；defineFacet 的 setup 在加载时执行，host.serve 注册 Users 对象工厂。
	const facet: Facet<P> = defineFacet<P>((host) =>
		// 工厂接收空参数和 self，可读取状态、派生值并定义方法；每个主机至多创建一个这样的对象。
		host.serve(Users, (_params, self) => {
			// self.state(Accounts) 取得持久文档的状态句柄（watchable）。
			const accounts = self.state(Accounts);
			return {
				// list 用 self.derive 派生：accounts 变化时重算；Object.entries 把映射转成 {id, profile} 数组。
				list: self.derive([accounts], ([value]) =>
					// each as T 是编译期断言：运行时数据已过 schema 校验，但 TypeScript 无法把 JsonValue 自动收窄为泛型 T。
					Object.entries(value.users).map(([id, each]) => ({ id, profile: each as T })),
				),
				// A trust boundary: `id` is the caller's (`Object.hasOwn`: no inherited member is a user). Written by
				// `update` from a `T`.
				// get 处理调用方输入的信任边界：Object.hasOwn 只认自有键，constructor/__proto__ 等继承键不被当成用户。
				get: async (id) => (Object.hasOwn(accounts.value.users, id) ? (accounts.value.users[id] as T) : null),
				// update 的第二个参数 ctx 是 Chord 上下文，由调用链注入；这里的箭头函数不手工构造它。
				update: async ({ id, profile: next }, ctx) => {
					// As a key it would set the record's prototype, not add a user.
					// __proto__ 作为键会改写入对象的原型而不是新增账号，因此运行时显式拒绝并返回 invalid(args)。
					if (id === "__proto__") throw invalid("args", "users: __proto__ is no user id");
					// accounts.change 以草稿方式修改文档；回调内直接赋值，提交由 change 处理。
					await accounts.change((draft) => {
						// next as JsonValue 是类型断言；资料 schema 已在契约层校验，这里不会再次深拷贝。
						draft.users[id] = next as JsonValue;
					}, ctx);
					// 无结果 schema 的方法用 null 表示成功。
					return null;
				},
				// remove 同样通过文档变更删除键；删除不存在的 id 也视为成功。
				remove: async (id, ctx) => {
					// delete 只影响自有键，不会改动对象原型。
					await accounts.change((draft) => {
						delete draft.users[id];
					}, ctx);
					// return null 与方法声明的空结果一致。
					return null;
				},
			};
		}),
	);
	// 返回契约和 facet；应用把它们导出到 API 后，其他插件才能 import 到同一契约。
	return { Users, facet };
}
