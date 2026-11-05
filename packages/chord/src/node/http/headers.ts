// 所属：packages/chord/src/node/http，Chord v2 HTTP 组件的响应头与 CSP 模块（slice 10 §2，安全基线 (4)）。
// 职责边界：构造默认安全头和每个响应的 nonce，校验响应头名/值；不决定状态码、不写网络、不做路由或认证。
// 上游入口：http.ts 的 refusal/#run 调用 DefaultHeaders.of；response.ts 的 answerOf 在默认头之上覆盖路由头。
// 下游依赖：node:crypto 的 randomFillSync、admission 的 Admitted（origin/framer/relay）、router 的 Router
// （framers/csp/scripts 贡献）、response.ts 的 AnswerHeaders 行迭代。
// 结果与错误流向：of 返回可写的 AnswerHeaders；set 遇到非法头名或含 CR/LF/NUL 的值抛 TypeError，
// answerOf 捕获后回答 500 并报告 response_failed。CSP 的 nonce 模板按路由器/来源缓存，中继来源不缓存。
// 能力清单：
// - AnswerHeaders：大小写无关的头集合，设置时校验，支持多行值；
// - Nonces：从 4 KiB 随机池切出 16 字节 base64 nonce；
// - DefaultHeaders：为一次响应生成默认头与 CSP，并缓存 nonce 周围的策略模板；
// - csp / scriptSources：内部函数，构造指令集与 script-src 来源；
// - TOKEN / FIELD_VALUE / NONCE：头名校验、头值校验和 CSP 占位符常量。
// 组合关系：DefaultHeaders.of 先设固定头，再取 #policy（可能命中 WeakMap 缓存）拼上 nonce，最后写入 CSP；
// response.ts 随后在同一个 AnswerHeaders 上覆盖路由指定的同名头。
// 示例：const headers = new DefaultHeaders().of(admitted, router, new Nonces().next());
//       const policy = headers.get("content-security-policy"); // 含 'nonce-...' 与来源
// 建议阅读顺序：先看 AnswerHeaders 的校验与 lines，再看 Nonces 的池化生成，随后 DefaultHeaders.of/#policy，
// 最后看 csp 的指令合并与 scriptSources 的来源选择。
// The default headers (decision "The HTTP component's security baseline" (4), "A CSP nonce per response"): on every
// response, the component's own included: no caching, no sniffing, no referrer, no framing but by the contributed
// framers, and a CSP with the response's own script nonce. A response's own headers replace same-named ones (a route
// widens its own CSP); they are validated as they are set, so a CR or LF never reaches the wire.

import { randomFillSync } from "node:crypto";
import type { Admitted } from "./admission.ts";
import type { Router } from "./router.ts";

// 类用途：以大小写无关的方式保存响应头，保留最后设置的拼写；列表值按每个值一行输出。
// 用法：const h = new AnswerHeaders(); h.set("Set-Cookie", ["a=1", "b=2"])。
/** A response's headers as the component builds them: by lowercased name, each value checked when set. */
export class AnswerHeaders {
	/** By lowercased name: the name as set and its values (several only for a header sent more than once). */
	// 私有字段 #entries 是真正运行时存在的 Map；键是小写名字，值记录原始拼写和值数组。
	// readonly 只禁止重新赋值这个字段，Map 内容仍可增删。
	readonly #entries = new Map<string, { readonly name: string; readonly values: readonly string[] }>();

	// 读取：同名多个值用 ", " 连接（与 Headers.get 一致），不存在返回 null；读取不区分大小写。
	/** The values of `name` joined with `", "`, or `null`. */
	get(name: string): string | null {
		return this.#entries.get(name.toLowerCase())?.values.join(", ") ?? null;
	}

	// 存在性检查：只把名字转小写后查 Map，不校验名字是否合法；适合在设置前判断是否已有某头。
	has(name: string): boolean {
		return this.#entries.has(name.toLowerCase());
	}

	// 设置：输入头名与单个字符串或字符串数组，无返回值；同名旧值被替换。
	// 错误路径：非法头名或任一头值含 CR/LF/NUL 时抛 TypeError，调用方（answerOf）会转成 500。
	// 例子：set("Content-Security-Policy", "default-src 'none'")；set("Set-Cookie", ["a=1", "b=2"])。
	/**
	 * Sets `name` to `value` (several values: one header line each, as `Set-Cookie` needs), replacing a same-named one;
	 * throws `TypeError` for a name or value HTTP cannot carry.
	 */
	set(name: string, value: string | readonly string[]): void {
		// TOKEN 是 HTTP token 的完整匹配；名字中的空格、冒号、换行都会在这里被拒绝。
		if (!TOKEN.test(name)) throw new TypeError(`header: invalid name ${JSON.stringify(name)}`);
		// 统一成数组，后面只处理一种形状；typeof 分支是运行时检查，因为参数有两种类型。
		const values = typeof value === "string" ? [value] : value;
		// 逐个校验列表项：即使只有一项带换行，也不能写进响应。
		for (const each of values) {
			if (!FIELD_VALUE.test(each)) throw new TypeError(`header ${name}: invalid value ${JSON.stringify(each)}`);
		}
		// 以小写名为键保存，同时保留本次设置的原始拼写和值数组；后设置的同名头覆盖先前项。
		this.#entries.set(name.toLowerCase(), { name, values });
	}

	// 删除：按小写名字移除；不存在时什么也不做（Map.delete 返回 false 被忽略）。
	delete(name: string): void {
		this.#entries.delete(name.toLowerCase());
	}

	// 生成器方法：按插入顺序逐行产出 [原始拼写, 值]；列表值每个元素一行（Set-Cookie 需要）。
	// 返回 IterableIterator 是编译期类型；运行时是可被 for...of 或展开运算符消费的迭代器。
	/** Each header line as `[name as set, value]`. */
	*lines(): IterableIterator<readonly [string, string]> {
		for (const { name, values } of this.#entries.values()) for (const value of values) yield [name, value];
	}
}

// HTTP token 的字符集：字母数字和 !#$%&'*+-.^_`|~；正则锚定首尾，必须有至少一个字符。
/** A header name: an HTTP token. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// 头值允许制表符、可见 ASCII 和 Latin-1 高位字节，禁止 CR、LF、NUL；这直接防止响应头注入。
/** A header value: visible Latin-1, spaces and tabs; no CR, LF or NUL. */
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

// 类用途：从预填充的随机池中切出 nonce。池 4 KiB，一次 randomFillSync 可服务 256 个 16 字节 nonce；
// 每个响应调用 next()，避免每个 nonce 单独调用随机 API 的成本。
/** Fresh script nonces, one per response: 16 random bytes each, base64, cut from a pool filled 4 KiB at a time. */
export class Nonces {
	// #pool 是 4096 字节缓冲区；allocUnsafe 不初始化内容，但下一次填充会覆盖整块。
	readonly #pool = Buffer.allocUnsafe(4096);
	// #at 指向下一个未使用字节；初始等于池长度，表示第一次 next 需要填充。
	#at = 4096;

	// 函数用途：返回一个从未发放过的 nonce（16 字节随机数的 base64 文本）；无输入、无 I/O 参数。
	// 副作用：可能同步填充随机池并推进游标；池耗尽后从头覆盖，旧 nonce 文本已复制出去，不受影响。
	// 例子：const nonce = nonces.next(); 路由把 <script nonce="..."> 与 CSP 中的 'nonce-...' 对齐。
	/** The next nonce (never one handed out before). */
	next(): string {
		// One `randomFillSync` per 256 nonces: `randomBytes(16)` per response costs 1.6 µs.
		// 游标到达末尾时一次填充整池；randomFillSync 是同步加密随机源。
		if (this.#at === this.#pool.length) {
			randomFillSync(this.#pool);
			this.#at = 0;
		}
		// toString("base64", start, end) 只编码这 16 字节，返回新字符串；随后游标前进 16。
		const nonce = this.#pool.toString("base64", this.#at, this.#at + 16);
		this.#at += 16;
		return nonce;
	}
}

// 类用途：为一个 HTTP 组件生成默认头。CSP 中围绕 nonce 的文本按路由器缓存，再用每个响应的 nonce 拼接。
// 缓存理由：CSP 字符串构造和来源拼接有成本，而本地/允许域名请求的来源集合有界；中继来源由每个请求的中继结果
// 决定、宿主无法枚举，可能无界，因此不缓存。
/**
 * The default headers of one component's responses. The CSP around the nonce is kept per router and origin for local
 * and allowed-host requests (a bounded set: the hosts contributions name); a relayed request's origins come from its
 * relay and are never kept (Fable's and Opus's rechecks: a cache growing with each relayed origin).
 */
export class DefaultHeaders {
	// WeakMap 以 Router 为键：路由器被回收时缓存自动消失；内层 Map 以 origin 为键，保存 nonce 前后的两段文本。
	// 这不是模块级强缓存，GC 测试验证路由器离开后不残留。
	/** By router (its change makes new ones), then by origin: the CSP's text before and after the nonce. */
	readonly #policies = new WeakMap<Router, Map<string, readonly [string, string]>>();

	// 函数用途：生成一个响应的默认头。输入准入结果、路由器和本次 nonce；输出 AnswerHeaders。
	// admitted/router 可为 undefined（准入前拒绝、注册表未就绪）：此时 CSP 仍生成，但不含具体来源。
	// 副作用：可能写入/读取 #policies 缓存；无 I/O、不抛错（头名和值都是固定合法字符串）。
	// 例子：of(LOCAL, router, "N") => Cache-Control: no-store、CSP 中含 'nonce-N'。
	/**
	 * The default headers of a response to a request admitted as `admitted` (none: refused before admission), with
	 * `router`'s framers and CSP sources (none before the router is resolved), its CSP allowing scripts with `nonce`.
	 */
	of(admitted: Admitted | undefined, router: Router | undefined, nonce: string): AnswerHeaders {
		// 固定安全头：响应不得被缓存、不得被 MIME 嗅探、不得发送 Referer。
		const headers = new AnswerHeaders();
		headers.set("Cache-Control", "no-store");
		headers.set("X-Content-Type-Options", "nosniff");
		headers.set("Referrer-Policy", "no-referrer");
		// X-Frame-Options 只能表达 DENY/SAMEORIGIN，无法列出多个 framer；有 framer 时完全交给 CSP frame-ancestors。
		// 既无贡献 framer 也无本次请求 framer 时，用 DENY 提供对旧浏览器的兜底。
		// `X-Frame-Options` names no origin: with framers, only `frame-ancestors` speaks.
		if ((router?.framers.size ?? 0) === 0 && admitted?.framer === undefined) headers.set("X-Frame-Options", "DENY");
		// 拆成 nonce 前后两段：缓存的是不含 nonce 的模板，拼接时才插入本次随机值。
		const [before, after] = this.#policy(admitted, router);
		headers.set("Content-Security-Policy", `${before}${nonce}${after}`);
		return headers;
	}

	/** The CSP's text around the nonce for `admitted` under `router`. */
	// 私有方法：取得 CSP 的 [nonce 前, nonce 后] 文本。输入准入结果与路由器；中继请求每次重算，其余按来源缓存。
	#policy(admitted: Admitted | undefined, router: Router | undefined): readonly [string, string] {
		// 路由器/准入缺失，或来源是中继：直接计算，不写入缓存（中继来源由 relay 提供，数量不可控）。
		if (router === undefined || admitted === undefined || admitted.relay !== undefined) return csp(admitted, router);
		// 按路由器取内层 Map；首次访问时创建并放入 WeakMap。
		let policies = this.#policies.get(router);
		if (policies === undefined) {
			policies = new Map();
			this.#policies.set(router, policies);
		}
		// 同一个 origin 的本地/允许域名请求共享策略模板；nonce 每次不同。
		let policy = policies.get(admitted.origin);
		if (policy === undefined) {
			policy = csp(admitted, router);
			policies.set(admitted.origin, policy);
		}
		return policy;
	}
}

/**
 * The CSP's text before and after the nonce: nothing by default, scripts from this origin or with the nonce,
 * connections to it and its WebSocket, framing by the framers, plus contributed sources.
 */
// 函数用途：构造完整 CSP 指令集。输入准入结果和路由器，输出 nonce 前后两段文本。
// 流程：先收集 framer（路由器贡献 + 本次中继），建立固定指令，再合并路由器贡献的额外来源，
// 最后用 NONCE 占位符定位并切开，返回 ["... 'nonce-", "' ..."]。
// 例子：本地请求、无额外贡献 => default-src 'none'; script-src 'self' 'nonce-<N>'; connect-src 'self' ws://...。
function csp(admitted: Admitted | undefined, router: Router | undefined): readonly [string, string] {
	// 展开 Set 得到 framer 数组；?? 处理路由器尚未解析的情况。Set 的插入顺序被保留。
	const framers = [...(router?.framers ?? [])];
	// 中继为本次请求允许的 framer 追加进来；即使同一个来源重复出现，CSP 仍能接受。
	if (admitted?.framer !== undefined) framers.push(admitted.framer);
	// Map 保持指令顺序；每条指令的值是来源数组。
	const directives = new Map<string, string[]>([
		["default-src", ["'none'"]],
		// script-src 默认只允许同源脚本和带 nonce 的脚本；NONCE 是占位符，稍后替换。
		["script-src", [...scriptSources(admitted, router), NONCE]],
		// connect-src 允许同源和本请求来源的 WebSocket：replace(/^http/, "ws") 把 http->ws、https->wss。
		// 未准入时没有 origin，只保留 'self'。
		["connect-src", ["'self'", ...(admitted === undefined ? [] : [admitted.origin.replace(/^http/, "ws")])]],
		["base-uri", ["'none'"]],
		["form-action", ["'self'"]],
		// 没有 framer 时禁止任何页面嵌入；有 framer 时只列出来源。
		["frame-ancestors", framers.length === 0 ? ["'none'"] : framers],
	]);
	// 合并插件贡献的 CSP 指令；迭代 Map 的顺序由贡献注册表组合时的插入顺序决定。
	for (const [directive, sources] of router?.csp ?? []) {
		const current = directives.get(directive);
		// 已有指令且首项为 'none' 时用贡献来源替换，否则追加；这样插件能放宽 default-src 'none' 等基线。
		// A directive the baseline sets to 'none' is replaced by the sources given for it.
		directives.set(
			directive,
			// 展开成新数组，避免把缓存中的数组原地修改。
			current === undefined || current[0] === "'none'" ? [...sources] : [...current, ...sources],
		);
	}
	// 把每条指令拼成 "directive sources..."，再用 "; " 连接成完整策略文本。
	const text = [...directives].map(([directive, sources]) => `${directive} ${sources.join(" ")}`).join("; ");
	// 找到占位符位置；at 一定是非负的，因为 script-src 刚加入 NONCE。
	const at = text.indexOf(NONCE);
	// 在占位符处切开，并在前半段末尾补上 'nonce-、后半段开头补上引号；拼接后就是 'nonce-<值>'。
	return [`${text.slice(0, at)}'nonce-`, `'${text.slice(at + NONCE.length)}`];
}

// 函数用途：决定 script-src 的同源来源。输入准入结果与路由器，输出来源数组。
// 有 contributions 的 scripts 路径时，只允许这些路径拼上请求 origin，避免同源任意响应被当作脚本执行；
// 否则退回 'self'（整个同源）。未准入时也退回 'self'。
// 例子：scripts: ["/_chord/web/"]、origin https://a.example => ["https://a.example/_chord/web/"]。
/** Where scripts may come from: the contributed script paths of the request's origin, else the whole origin. */
function scriptSources(admitted: Admitted | undefined, router: Router | undefined): string[] {
	const paths = router?.scripts ?? [];
	if (admitted === undefined || paths.length === 0) return ["'self'"];
	return paths.map((path) => `${admitted.origin}${path}`);
}

// 占位符使用 NUL 包裹，正常 CSP 文本不会包含它；构造完后被替换成真实 nonce，不会出现在响应里。
/** Where the nonce goes in the CSP's text while it is made. */
const NONCE = "\0nonce\0";
