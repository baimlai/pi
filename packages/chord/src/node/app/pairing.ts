// Device pairing (slice 13 §2, decision "The app kit, point 3" (c)): a command-line or terminal client on another
// machine asks for a code (`POST /_chord/pair`, public) and polls with a secret it got with it; the owner opens
// `/_chord/pair/<code>` in a signed-in browser and approves; the next poll returns a device session's token, once.
// Codes are short, random, single use and expire after 10 minutes; the poll secret is kept only hashed. Asking is
// public, so pairings anonymous clients start are capped: `maxPending` in all (100 by default) and `perAddress` per
// client address (10). The trade: a party filling the caps locks pairing out for others for up to 10 minutes (behind a
// tunnel every remote client has the tunnel's address), instead of growing the server's memory without bound; a
// signed-in owner's pairings are not counted, so the owner can always pair.

// 所属：packages/chord/src/node/app，app kit 的设备配对（slice 13 §2；decision 点 3(c)）。
// 职责边界：管理短码与 poll 秘密的内存配对、匿名限额、owner 确认和一次性 token 交付；不持久化配对。
// 上游：startServer 创建 Pairings 并加载 pairingFacet；下游：Sessions 为 owner 签发设备会话，Http 提供公开和 owner 路由。
// 结果与错误：begin 达到限额返回 undefined（路由 429）；waiting/poll 对未知或过期返回 undefined（404）；owner 路由非 owner 返回 403。
// 能力清单：PAIRING_MS/ALPHABET/PAIR_PATH 是常量；PairingStarter/Pairing/PairingLimits 是类型；Pairings 管理表；letters 生成码；pairingFacet 提供四条路由；labelOf/confirmPage/escapeHtml 辅助。
// 组合顺序：POST /_chord/pair → begin；owner GET/POST /_chord/pair/:code → waiting → sessions.issue → Pairing.token；设备 POST /_chord/pair/poll → poll。
// 示例：const p = new Pairings(); const begun = p.begin('laptop', { kind: 'anonymous', address: '1.2.3.4' }); p.poll(begun!.poll)。
// 建议阅读顺序：先看 Pairings 的 begin/waiting/poll/#end，再看 pairingFacet 路由，最后辅助函数。
import { randomInt } from "node:crypto";
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import { Http, type HttpRequest, type HttpResponse } from "../http/index.ts";
import { OWNER } from "./owner.ts";
import { hashToken, newToken } from "./secrets.ts";
import { Sessions } from "./sessions.ts";

// 配对码有效期 10 分钟，与 poll 秘密相同。
/** How long a pairing code is valid: 10 minutes. */
const PAIRING_MS = 10 * 60_000;

// 字母表去掉了易混淆的 0/O、1/I/L；randomInt 使用加密随机源，短码不是顺序可猜的。
/** The code's letters: no 0/O, 1/I/L. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// PairingStarter 是标签联合：owner 不计数，anonymous 带 remoteAddress 用于按地址限额。
/** Who starts a pairing: the signed-in owner (not counted), or an anonymous client at an address (counted). */
export type PairingStarter = { readonly kind: "owner" } | { readonly kind: "anonymous"; readonly address: string };

// Pairing 记录码、标签、发起者、到期时间和批准后的 token；token 只在 owner 确认后出现。
/** One pairing under way: its code, the device's label, who started it, its expiry, its token once approved. */
type Pairing = {
	readonly code: string;
	readonly label: string;
	readonly by: PairingStarter;
	readonly expires: number;
	token?: string;
};

// PairingLimits 两个可选上限；缺省值在构造函数中填入。
/** The limits of pairings under way: in all (100 by default) and per client address (10 by default). */
export type PairingLimits = { readonly maxPending?: number; readonly perAddress?: number };

// 内存中的配对表，提供 begin/waiting/poll；没有持久化，重启后全部失效。
// 错误路径：匿名达到上限时 begin 返回 undefined，由路由转成 429；未知或过期码返回 undefined，由路由转成 404/403。
/** The pairings under way, by code and by their poll secret's hash, with the anonymous ones counted. */
export class Pairings {
	// byCode 供 owner 按码确认；byPoll 供设备按秘密轮询；两者指向同一个 Pairing 对象。
	readonly #byCode = new Map<string, Pairing>();
	readonly #byPoll = new Map<string, Pairing>();
	// perAddress 记录每个匿名地址的待处理数量；anonymous 是全局总数。
	readonly #perAddress = new Map<string, number>();
	#anonymous = 0;
	// 两个上限在构造时固定，运行中不改变。
	readonly #maxPending: number;
	readonly #maxPerAddress: number;

	// 保存上限；limits 可选，因此测试可以只覆盖其中一个。
	constructor(limits: PairingLimits = {}) {
		this.#maxPending = limits.maxPending ?? 100;
		this.#maxPerAddress = limits.perAddress ?? 10;
	}

	// 开始配对：输入标签和发起者，返回 code 与 poll 秘密；匿名达到全局或地址上限时返回 undefined。
	// 副作用是占用名额并写入两个 Map；owner 的配对不计数。码会重试直到不与现有码冲突。
	// 例子：begin('laptop', {kind:'anonymous', address:'1.2.3.4'}) 返回 {code:'ABCD-EFGH', poll:'...'}。
	/**
	 * A new pairing for a device labelled `label`, started `by` the owner or an anonymous client: its code (for the
	 * owner) and its poll secret (for the device); `undefined` when an anonymous client reached a limit.
	 */
	begin(label: string, by: PairingStarter): { readonly code: string; readonly poll: string } | undefined {
		// 每次 begin 前先回收过期配对，避免它们继续占名额。
		this.#expire();
		// 只有匿名发起者受限额约束。
		if (by.kind === "anonymous") {
			// 全局待处理数达到 maxPending 即满。
			const full = this.#anonymous >= this.#maxPending;
			// 地址计数用 ?? 0 处理第一次出现；达到每地址上限也拒绝。
			if (full || (this.#perAddress.get(by.address) ?? 0) >= this.#maxPerAddress) return undefined;
			// 两个计数同时增加，保证 begin 成功后名额立即占用。
			this.#anonymous++;
			// set 写回递增后的值；Map 的键是客户端地址。
			this.#perAddress.set(by.address, (this.#perAddress.get(by.address) ?? 0) + 1);
		}
		let code: string;
		// 码由两组 4 字母组成，例如 ABCD-EFGH；do/while 保证至少生成一次。
		do code = `${letters(4)}-${letters(4)}`;
		while (
			// 如果随机撞上已有码就重试；短码空间有限，但冲突循环仍会结束。
			this.#byCode.has(code)
		);
		// poll 秘密是完整随机 token，客户端之后用它证明自己发起过这次配对。
		const poll = newToken();
		// 到期时间从 begin 时刻开始计算；批准不会延长期限。
		const pairing: Pairing = { code, label, by, expires: Date.now() + PAIRING_MS };
		// 两个索引指向同一对象；token 在 owner 确认时写入该对象。
		this.#byCode.set(code, pairing);
		// byPoll 用 SHA-256 作键，内存泄露不会直接暴露 poll 秘密。
		this.#byPoll.set(hashToken(poll), pairing);
		// 返回给调用方的 poll 是明文；服务端只保留摘要。
		return { code, poll };
	}

	// 按码查等待中的配对：转大写以接受小写输入；已批准或不存在返回 undefined，调用前清理过期。
	/** The pairing waiting for approval under `code` (any case), unexpired. */
	waiting(code: string): Pairing | undefined {
		this.#expire();
		// toUpperCase 让 owner 输入小写码也能确认；token 已存在时不再显示确认页。
		const pairing = this.#byCode.get(code.toUpperCase());
		return pairing?.token === undefined ? pairing : undefined;
	}

	// 用 poll 秘密查配对：未知返回 undefined，未批准返回 waiting，已批准返回 token 并结束配对（只此一次）。
	/** What a poll with `poll` learns: still waiting, the device's token (once: the pairing ends), or nothing. */
	poll(
		poll: string,
	): { readonly kind: "waiting" } | { readonly kind: "approved"; readonly token: string } | undefined {
		// 先清理过期项，防止过期配对被 poll 到。
		this.#expire();
		// 只对秘密求摘要，不保存明文。
		const hash = hashToken(poll);
		// Map 中找不到说明秘密无效或配对已结束。
		const pairing = this.#byPoll.get(hash);
		if (pairing === undefined) return undefined;
		// 还没有 token 表示 owner 尚未确认。
		if (pairing.token === undefined) return { kind: "waiting" };
		// 批准后第一次 poll 立即结束配对，后续 poll 都得到 undefined。
		this.#end(hash, pairing);
		// 返回 token；调用方据此得到设备会话。
		return { kind: "approved", token: pairing.token };
	}

	// 遍历 poll 表删除过期配对；#end 同时清理 code 表和匿名计数。
	/** Drops the expired pairings. */
	#expire(): void {
		// 用一次 now 作为整轮扫描基准。
		const now = Date.now();
		// for...of 直接迭代 Map 的 [hash, pairing] 项；#end 删除当前项是安全的。
		for (const [hash, pairing] of this.#byPoll) {
			// expires <= now 即过期，与 waiting/poll 的判断一致。
			if (pairing.expires <= now) this.#end(hash, pairing);
		}
	}

	// 从两个 Map 删除并归还匿名名额；owner 不占名额，提前返回。
	/** Ends `pairing` (its poll secret's hash `hash`). */
	#end(hash: string, pairing: Pairing): void {
		// 先删 poll 索引。
		this.#byPoll.delete(hash);
		// 再删 code 索引，owner 无法再确认它。
		this.#byCode.delete(pairing.code);
		// 解构发起者以决定是否归还名额。
		const { by } = pairing;
		// owner 配对没有计数。
		if (by.kind === "owner") return;
		// 匿名名额减一。
		this.#anonymous--;
		// 读取地址计数并用 ?? 1 防御；正常情况下键一定存在。
		const left = (this.#perAddress.get(by.address) ?? 1) - 1;
		// 减到 0 时删除键，避免 Map 随地址无限增长。
		if (left === 0) this.#perAddress.delete(by.address);
		// 否则写回剩余数量。
		else this.#perAddress.set(by.address, left);
	}
}

// 从 ALPHABET 随机取 count 个字符；randomInt 上界不含参数，因此不会越界。
/** `count` random letters of `ALPHABET` (`crypto.randomInt`). */
function letters(count: number): string {
	// 逐字符拼接；count 很小，字符串拼接成本可忽略。
	let text = "";
	// randomInt(ALPHABET.length) 返回 0 到长度减一的整数。
	for (let index = 0; index < count; index++) text += ALPHABET[randomInt(ALPHABET.length)];
	return text;
}

// 所有配对路由共享同一前缀。
/** The pairing routes' prefix. */
export const PAIR_PATH = "/_chord/pair";

// 创建配对 facet：输入内存 Pairings，返回 Facet<P>；四条路由完成请求、轮询和 owner 确认。
// 公开路由不需要登录；GET/POST :code 要求 owner，否则 403。确认会签发 owner 的设备会话。
// 例子：POST /_chord/pair 得到 code/poll；owner 确认后 poll 返回 token。
/**
 * The kit's facet for device pairing: `POST /_chord/pair` (public: `{ label? }` → `{ code, poll }`, 429 past a limit
 * unless the owner asks), `POST /_chord/pair/poll` (public: `{ poll }` → `{ status: "waiting" }`, `{ status:
 * "approved", token }` once, else 404), `GET` and `POST /_chord/pair/:code` (the owner's confirm page and approval: a
 * device session of the owner).
 */
// defineFacet 的 self 用于贡献 Http；_host 未使用。
export function pairingFacet<P extends Principal>(pairings: Pairings): Facet<P> {
	// 把路由表贡献给 Http 组件。
	return defineFacet<P>((_host, self) =>
		self.contribute(Http, {
			// routes 对象用模板字面量键组合方法与路径；:code 是路由参数。
			routes: {
				// 请求配对：公开，不要求已有会话。
				[`POST ${PAIR_PATH}`]: {
					// public 跳过认证器，但 ctx.principal 仍可能是 owner（浏览器 cookie 有效时）。
					public: true,
					handler: async (request, ctx): Promise<HttpResponse> => {
						// 标签从请求体读取，缺省为 device。
						const label = await labelOf(request);
						// 按 principal 是否为 owner 选择发起者；匿名使用 remoteAddress，可能为空字符串。
						const by: PairingStarter =
							// owner 不计数；其他身份一律按匿名处理，包括普通 user。
							ctx.principal?.kind === "owner"
								? { kind: "owner" }
								: // remoteAddress ?? '' 防御没有地址的本地/测试请求。
									{ kind: "anonymous", address: request.remoteAddress ?? "" };
						// begin 在达到上限时返回 undefined。
						const begun = pairings.begin(label, by);
						// 达到上限返回 429；成功返回 code 与 poll 秘密。
						return begun === undefined ? { kind: "error", status: 429 } : { kind: "json", value: begun };
					},
				},
				// 轮询路由：公开，设备用 poll 秘密证明身份。
				[`POST ${PAIR_PATH}/poll`]: {
					// 公开是因为设备尚未登录。
					public: true,
					handler: async (request): Promise<HttpResponse> => {
						// A trust boundary: anyone may poll.
						// 请求体是信任边界：poll 可能是任意 JSON，运行时检查字符串。
						const body = (await request.json()) as { readonly poll?: unknown } | null;
						// 非字符串 poll 直接当作未知，不调用 pairings.poll。
						const polled = typeof body?.poll === "string" ? pairings.poll(body.poll) : undefined;
						// 未知或已结束的 poll 返回 404，不区分原因。
						if (polled === undefined) return { kind: "error", status: 404 };
						// 仍在等待时返回 waiting；设备应稍后重试。
						if (polled.kind === "waiting") return { kind: "json", value: { status: "waiting" } };
						// 已批准时返回 token；Pairings.poll 已结束该配对。
						return { kind: "json", value: { status: "approved", token: polled.token } };
					},
				},
				// owner 的确认页；其他身份 403。
				[`GET ${PAIR_PATH}/:code`]: async (request, ctx) => {
					// 可选链处理匿名请求；非 owner 一律拒绝。
					if (ctx.principal?.kind !== "owner") return { kind: "error", status: 403 };
					// 只查等待中的配对；已批准或过期都返回 undefined。
					const pairing = pairings.waiting(request.params.code ?? "");
					// 没有配对时返回 404 页面，不泄露码是否存在。
					if (pairing === undefined)
						// html 响应带状态码；页面文本是固定内容。
						return { kind: "html", status: 404, body: "<p>No such pairing (or it expired).</p>" };
					// 确认页显示标签和码，表单 POST 回同一路径。
					return { kind: "html", body: confirmPage(pairing.code, pairing.label) };
				},
				// owner 批准配对；表单提交没有 JSON 体。
				[`POST ${PAIR_PATH}/:code`]: async (request, ctx) => {
					// 只有 owner 能批准，普通 user 403。
					if (ctx.principal?.kind !== "owner") return { kind: "error", status: 403 };
					// 再次确认同一码时，如果已批准就不会再找到。
					const pairing = pairings.waiting(request.params.code ?? "");
					// 未知或过期码返回 404 页面。
					if (pairing === undefined)
						return { kind: "html", status: 404, body: "<p>No such pairing (or it expired).</p>" };
					// 取得 Sessions 契约，准备签发设备会话。
					const sessions = await ctx.get(Sessions, {});
					// 设备会话的 principal 固定为 OWNER，label 使用配对时提供的设备标签。
					const { token } = await sessions.issue({ principal: OWNER, label: pairing.label, kind: "device" }, ctx);
					// 把 token 写进配对对象；下一次 poll 会读取并结束配对。
					pairing.token = token;
					// 页面使用 escapeHtml 转义标签，避免标签中的 HTML 被执行。
					return {
						kind: "html",
						body: `<p>Approved: ${escapeHtml(pairing.label)} is signed in as the owner.</p>`,
					};
				},
			},
		}),
	);
}

// 读取配对请求的可选标签：没有请求体时默认 device；最多 100 字符；非 JSON、非字符串或空白也回退。
/** The device's label from a pairing request's body (`{ label }`, at most 100 characters), else `device`. */
async function labelOf(request: HttpRequest): Promise<string> {
	// content-length 为 0 且没有 transfer-encoding 说明没有请求体。
	const declared = Number(request.headers.get("content-length") ?? "0");
	// 无请求体直接返回默认值，连 4096 字节的解析都不做。
	if (declared === 0 && request.headers.get("transfer-encoding") === null) return "device";
	// A trust boundary: anyone may ask for a code.
	// 请求体是信任边界；限制 4 KiB，防止公开路由被大 JSON 占用。
	const body = (await request.json(4096)) as { readonly label?: unknown } | null;
	// 只有非空字符串才采用；trim 后截到 100 字符，其他输入回到 device。
	return typeof body?.label === "string" && body.label.trim() !== "" ? body.label.trim().slice(0, 100) : "device";
}

// 生成 owner 确认页：显示标签与码，POST 到同一路径；escapeHtml 防止注入。
/** The owner's confirm page for pairing `code` (a form posting to itself: same origin, the session cookie). */
function confirmPage(code: string, label: string): string {
	// 数组各元素是 HTML 行，join 后形成页面。
	return [
		// 标题固定；页面没有脚本，只有文本和表单。
		"<!doctype html><title>Pair a device</title>",
		// 标签和码都经过 HTML 转义；提示用户与设备上的码核对。
		`<p>Sign in <b>${escapeHtml(label)}</b> as the owner? Its code: <b>${escapeHtml(code)}</b> (compare it with the device).</p>`,
		// 表单没有 action，浏览器提交到当前 URL；同源请求自动带上 owner 的 cookie。
		'<form method="post"><button>Approve</button></form>',
	].join("\n");
}

// 把五个 HTML 特殊字符转成数字实体；用于标签和码（码本身只含字母数字）。
/** `text` safe in HTML. */
function escapeHtml(text: string): string {
	// charCodeAt 得到字符码点；数字实体在 HTML 中安全显示。
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
