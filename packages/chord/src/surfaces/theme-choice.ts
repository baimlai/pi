// The user's theme choice (slice 11 §4b): one dark and one light theme id per principal, kept by the server (the kit
// serves it) and held by every page and terminal of that principal, so choosing a theme restyles them all at once.
// Bounded (fix round 1: Opus M4, Fable L7): an id is at most 128 characters, and the store keeps the picks of the
// `MAX_PICKS` principals who chose last (a public app's guests choose too).

//
// 文件导读
// 所属：packages/chord 的 surfaces 层，定义用户主题选择的远程契约、持久化状态和服务端 facet。
// 职责边界：约束主题 id（最多 128 字符或 null）、保存每个 principal 的深/浅色选择（最多 1 万个最近选择者）、
// 提供 choose 方法；不注册主题、不解析颜色、不计算当前生效主题（分别由 themes.ts 和 active-theme.ts 负责）。
// 上游入口：kit 的 themeChoiceFacet 在服务器宿主 setup 中调用。下游依赖：contracts DSL、defineState、local、
// principalKey、defineFacet。客户端通过 ThemeChoice 远程对象读取 pick 并调用 choose。
// 结果与错误：ThemeChoice 的 state 为 { pick: { dark, light } }，choose 返回 null；参数或状态不符合 schema 时由
// contracts 层拒绝，持久化写入错误沿 change/set 传播，本文件不吞错也不额外包装。
// 能力清单：
// - ThemeId（私有）：str({max:128}) 或 null 的 schema。
// - Pick（私有）：{ dark, light } 的 schema。
// - MAX_PICKS：保存最近选择者数量的上限。
// - ThemeChoice：principal 视角的远程契约（state.pick、methods.choose）。
// - Picks（私有）：持久化状态文档，schema 为 { picks: map(Pick) }。
// - PickStore（私有）：服务器本地类型，members 为 picks 与 set。
// - NO_PICK：未选择时的 { dark: null, light: null }。
// - themeChoiceFacet：serve PickStore 与 ThemeChoice 的 facet 工厂。
// 组合与顺序：themeChoiceFacet → host.serve(PickStore) → host.serve(ThemeChoice) 按 principal key 读写；
// choose → PickStore.set → Picks.change → 文档变更 → ThemeChoice.pick 派生更新 → 客户端 watch 收到新值。
// 示例：`const facet = themeChoiceFacet<AppPrincipal>();` 安装后客户端调用
// `choice.choose({ dark: "midnight", light: "paper" }, ctx)`，之后 choice.pick 的 watcher 看到该值。
// 阅读顺序：schemas/常量 → ThemeChoice → Picks/PickStore → NO_PICK → themeChoiceFacet 的两个 serve 与淘汰逻辑。

import { BACKGROUND_CONTEXT } from "../context/index.ts";
import { hostKind, local, map, method, nul, obj, remote, str, union } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import { principalKey } from "../data/principal.ts";
import { defineState } from "../documents/index.ts";
import { defineFacet, type Facet } from "../host/index.ts";
import type { ThemePick } from "./themes.ts";

/** A theme id (at most 128 characters), or `null` for the first contributed theme of its mode. */
// union([...]) 是运行时 schema：值必须匹配其中之一。str({max:128}) 限制长度，nul() 只接受 null。
// null 不是“缺失”，而是明确表示“使用该模式第一个贡献的主题”。
const ThemeId = union([str({ max: 128 }), nul()]);

/** A pick: a theme id per mode. */
// 两个模式都必须出现；schema 在运行时校验，类型由 Static 推导。
const Pick = obj({ dark: ThemeId, light: ThemeId });

/** How many principals' picks the store keeps: past it the earliest chooser's goes (they see the first theme). */
// 上限防止公开应用的访客无限增长；超过后按选择顺序淘汰最早的 key，被淘汰者回落到首个主题。
const MAX_PICKS = 10_000;

/** The caller's theme choice, on the server: its pick, and `choose` to change it. */
// 远程契约：version 1；无参数；hostAddress 固定为 server（对象住在服务器）；唯一变体 main 带 state.pick
// 和方法 choose(Pick)。choose 返回 null（见下方实现），客户端据此知道写入完成。
// 示例：`const choice = await host.get(ThemeChoice, {}, ctx); await choice.choose({dark:"midnight",light:null}, ctx);`
export const ThemeChoice = remote("chord.themes.choice", {
	version: 1,
	params: {},
	hostAddress: () => hostKind("server")(),
	variants: { main: { state: { pick: Pick }, methods: { choose: method(Pick) } } },
});

/** Every principal's pick, by principal key: one document of the server's store. */
// 持久化状态：schema 是 { picks: { [principalKey]: Pick } }；map(Pick) 是动态键字典的 schema。
// initial 提供空字典；persist 让文档写入存储；checkpointWhen 每累计 50 个 delta 做一次检查点，控制重放成本。
// 参数 _value/_ops 不使用，下划线表示“有意忽略”；deltasSinceBase 来自存储层。
const Picks = defineState("chord.themes.picks", {
	schema: obj({ picks: map(Pick) }),
	version: 1,
	initial: () => ({ picks: {} }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
});

/** The server's keeper of every pick (a persisted state needs a local type with empty params). */
// 本地对象类型：持久化状态必须由一个本地类型承载，且参数为空（docs 的状态不能直接作为远程对象暴露）。
// members.picks 暴露只读派生；set({ key, pick }) 是唯一的写入入口，key 由 ThemeChoice 按 principal 计算。
const PickStore = local("chord.themes.picks", {
	version: 1,
	params: {},
	members: { picks: map(Pick), set: method(obj({ key: str(), pick: Pick })) },
});

/** No choice yet: the first contributed theme of each mode. */
// 共享的只读默认值对象；ThemeChoice.pick 在字典中没有该 principal 时直接返回它。
// 不修改它，避免一个调用方改变其他 principal 的默认结果。
const NO_PICK: ThemePick = { dark: null, light: null };

/** The kit's server facet for theme choices: the store of picks and each principal's `ThemeChoice`. */
// facet 工厂：setup 时声明两个服务对象。PickStore 每个宿主只有一个，保存所有 principal 的选择；
// ThemeChoice 每个 (principal, params) 一个实例，按 principal 的规范 key 读取同一条字典记录。
// 两个 serve 在同一 setup 中完成，发布批次保证 ThemeChoice 能解析到 PickStore。
// 示例：安装后任意页面/终端 hold 自己的 ThemeChoice，watch pick；一个设备 choose 后所有同 principal 的设备都会更新。
export function themeChoiceFacet<P extends Principal>(): Facet<P> {
	return defineFacet<P>((host) => {
		// 单一存储对象：空参数工厂，每个宿主一个实例。self.state 取得持久化文档句柄。
		host.serve(PickStore, (_params, self) => {
			const picks = self.state(Picks);
			return {
				// picks 是只读派生：从文档快照中取字典引用；文档变化时派生值更新。
				picks: self.derive([picks], ([value]) => value.picks),
				// 写入入口：先把 key 删除再重新插入到末尾，使键顺序等于“最近选择”顺序。
				set: async ({ key, pick }, ctx) => {
					// change 在事务中修改草稿；ctx 提供取消与遥测。
					await picks.change((draft) => {
						// Re-added last: the keys keep the order of choosing, the first the earliest.
						// 删除再赋值会把 key 移到对象属性顺序的末尾（字符串键按插入顺序）。
						delete draft.picks[key];
						draft.picks[key] = pick;
						const keys = Object.keys(draft.picks);
						// 超出上限时删除最前面的旧键；Math.max 防止键数不足时出现负的 slice 终点。
						// 这里的策略是“最后选择者保留”，被淘汰的 principal 会回落到 NO_PICK。
						for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PICKS))) delete draft.picks[old];
					}, ctx);
					// 方法成功返回 null；契约中 choose 的返回类型由此确定。
					return null;
				},
			};
		});
		// principal 视角的远程对象：self.get 解析同 setup 中的本地 PickStore；principal 是当前调用者。
		host.serve(ThemeChoice, (_params, principal, self) => {
			const store = self.get(PickStore, {});
			// principalKey 把 principal 转成规范 JSON 字符串；同一个 principal 在所有设备上得到相同 key。
			const key = principalKey(principal, BACKGROUND_CONTEXT);
			return {
				variant: "main",
				members: {
					// A key that is a principal's canonical JSON: `Object.hasOwn`, no inherited member is a pick.
					// 字典可能来自普通对象；hasOwn 排除原型链上的同名属性，避免把 "constructor" 等误当选择。
					// 非空断言 ! 是因为 hasOwn 已保证存在，TypeScript 的索引访问无法自行收窄。
					pick: self.derive([store.picks], ([picks]) => (Object.hasOwn(picks, key) ? picks[key]! : NO_PICK)),
					// choose 复用同一个 key 写入；返回值透传 store.set 的 null。
					choose: (pick, ctx) => store.set({ key, pick }, ctx),
				},
			};
		});
	});
}
