// Ephemeral sessions (slice 13 §3, carry-over to slice 11): a pick-a-name login's sessions, in memory only, at most
// `max` (past it the oldest ends), and each ending with its client's connection: once the last Chord link
// authenticated with it closed and none opened for a grace period (a page reload, a reconnect after a drop), or when
// none opened within that period of the login.

// 所属：packages/chord/src/node/app，app kit 的内存临时会话表（slice 13 §3，slice 11 carry-over）。
// 职责边界：按 id 保存临时会话的 secret 摘要和 principal，跟踪连接数并在宽限期后删除；不负责 HTTP、cookie 或持久化。
// 上游：sessions.ts 的 createSessions/opened 调用 issue/get/revoke/linkOpened；下游：无，只有内存 Map 和定时器。
// 结果与错误：issue/revoke 返回 void/boolean，get/linkOpened 返回 undefined 表示不存在；不抛业务错误，定时器回调静默删除。
// 能力清单：EPHEMERAL_GRACE_MS 是默认宽限；EphemeralSessions 提供 issue/get/revoke/linkOpened；#waitForLink 负责到期。
// 组合顺序：issue → #waitForLink；linkOpened → 计数加一并清定时器 → 关闭回调 → 最后连接关闭 → 重新计时 → 到期 revoke。
// 示例：const s = new EphemeralSessions(100); s.issue(id, hash, principal); const close = s.linkOpened(id); close?.();
// 建议阅读顺序：先看 Session/EphemeralSessions 字段，再看 issue/linkOpened，最后 #waitForLink。
import type { Principal } from "../../data/index.ts";

/** How long an ephemeral session lives without a link: a minute, past a reload and the reconnect loop's pauses. */
export const EPHEMERAL_GRACE_MS = 60_000;

/** One ephemeral session: its secret's hash, its principal, its open links, its end's timer while it has none. */
// 内部会话记录：readonly 保护身份与摘要的重新赋值，links 和 timer 随连接变化；ReturnType 取 setTimeout 的返回类型。
type Session = {
	readonly hash: string;
	readonly principal: Principal;
	links: number;
	timer: ReturnType<typeof setTimeout> | undefined;
};

/** The server's ephemeral sessions. */
export class EphemeralSessions {
	readonly #max: number;
	readonly #graceMs: number;
	/** Insertion order is age order: the first entry is the oldest. */
	readonly #sessions = new Map<string, Session>();

	// 创建一个内存会话管理器，保存容量和无连接宽限期；不加载数据库。
	// 例如 max=2 时第三次 issue 会撤掉最早的一项，graceMs 默认一分钟。
	constructor(max: number, graceMs = EPHEMERAL_GRACE_MS) {
		// 保存容量；# 字段只能由这个类访问，readonly 不禁止 Map 内容变化。
		this.#max = max;
		// 保存后续定时器使用的宽限毫秒数。
		this.#graceMs = graceMs;
	}

	/** A new session `id` (its secret's hash `hash`) for `principal`; the oldest ends past the cap. */
	// 登记 id 对应的摘要/身份，立即开始等待首条连接，超容量按插入顺序撤销旧项。
	// 返回 void；例如从未连接的登录在宽限期后失效。这里持有定时器，不持久化 token。
	issue(id: string, hash: string, principal: Principal): void {
		// 新会话从零连接开始；显式类型检查字段齐全，不会运行验证器。
		const session: Session = { hash, principal, links: 0, timer: undefined };
		// 把记录加入 Map；调用方产生新 id，不在这里检查重复。
		this.#sessions.set(id, session);
		// 首次登录也必须在宽限期内打开连接。
		this.#waitForLink(id, session);
		// Map 迭代顺序是插入顺序，数组解构只取键。
		for (const [oldest] of this.#sessions) {
			// 容量已满足就停止遍历，否则逐个撤销并清计时器。
			if (this.#sessions.size <= this.#max) break;
			this.revoke(oldest);
		}
	}

	/** Session `id`'s hash and principal, while it lives. */
	// 读取当前会话的摘要/身份，找不到返回 undefined，不延长寿命；例如认证流程用它核对 token。
	// 返回类型只暴露所需字段，运行时仍是原 Session 对象，没有复制。
	get(id: string): { readonly hash: string; readonly principal: Principal } | undefined {
		// 直接按 id 查 Map，不会查磁盘或刷新插入顺序。
		return this.#sessions.get(id);
	}

	/** Ends session `id`; whether it was one. */
	// 撤销一个 id 并清除其定时器；存在返回 true，否则 false。例：重复 revoke 第二次为 false。
	revoke(id: string): boolean {
		// 先查记录，避免为不存在的项操作 timer。
		const session = this.#sessions.get(id);
		// 不存在时保持 Map 不变。
		if (session === undefined) return false;
		// 取消无连接到期任务；传 undefined 也没有待取消任务。
		clearTimeout(session.timer);
		// 从认证可见的 Map 移除此记录，已有闭包仍可能握有它。
		this.#sessions.delete(id);
		return true;
	}

	/** A link authenticated with session `id` opened: what to call when it closes; `undefined` for no such session. */
	// 在认证连接打开时增加计数并取消到期，返回一次性的关闭回调；无会话返回 undefined。
	// 例如两条连接只关闭一条仍有效，最后一条关闭才重新计时；回调重复调用不会重复减计数。
	linkOpened(id: string): (() => void) | undefined {
		const session = this.#sessions.get(id);
		// 会话已撤销时，不创建关闭回调也不恢复它。
		if (session === undefined) return undefined;
		// 可变连接数加一；同一会话共享计数。
		session.links++;
		clearTimeout(session.timer);
		// 清除计时器标识，表示现在有连接保活。
		session.timer = undefined;
		// 闭包私有标记，让每条连接的关闭回调幂等。
		let closed = false;
		// 返回闭包而非现在关闭；它保留本条连接的 session 和 closed。
		return () => {
			// 已经处理过的关闭通知直接忽略。
			if (closed) return;
			// 先标记，随后即使再次被调用也不会重复扣计数。
			closed = true;
			// 仅扣除此连接占用的一个计数。
			session.links--;
			// 最后连接关闭且 Map 仍指向该记录才计时，旧会话的晚到关闭不能影响新记录。
			if (session.links === 0 && this.#sessions.get(id) === session) this.#waitForLink(id, session);
		};
	}

	/** Ends `session` unless a link opens within the grace period. */
	// 为零连接会话启动到期任务，返回 void；如宽限期内 linkOpened，外面会清除此任务。
	// 定时器只检查连接数，unref 允许进程在没有其他工作时自行退出。
	#waitForLink(id: string, session: Session): void {
		// 保存 Node 定时器，经过宽限时间后执行回调；这不是精确实时期限。
		session.timer = setTimeout(() => {
			// 触发时仍未连接才撤销，revoke 同时删除 Map 项。
			if (session.links === 0) this.revoke(id);
		}, this.#graceMs);
		// The server's process does not wait for it.
		// 可选调用 unref：有此方法时不让单个过期任务阻止进程退出。
		session.timer.unref?.();
	}
}
