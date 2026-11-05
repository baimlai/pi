// 所属：packages/chord/src/node/http，Chord v2 HTTP 组件的认证层（slice 10 §2，设计 §4）。
// 职责边界：定义认证函数类型与 Authenticators 注册表，并按顺序组合、询问认证器；不做准入、会话存储或 cookie 解析。
// 上游入口：http.ts 的 #principal 在准入和路由匹配后调用 authenticate，注册表值由 facet.serve(Authenticators) 组合。
// 下游依赖：HttpRequest（认证器读取请求）、Context（取消与遥测）、Principal 类型、registries 的 RegistryTable。
// 结果与错误流向：返回第一个非 undefined 的 Principal；认证器抛错经 failed 回调报告后继续；全部未认出返回
// undefined（匿名），由路由的 public/crossSite 规则决定是否放行。取消发生后不再启动新的认证器。
// 能力清单：
// - Authenticator：单个认证函数类型，可同步或异步返回 Principal 或 undefined；
// - AuthenticatorEntry：注册表条目，携带插件名与认证函数；
// - Authenticators："chord.http.authenticators" 注册表令牌，版本 1；
// - composeAuthenticators：把注册表表格转换成条目数组，保持贡献顺序；
// - authenticate：顺序执行认证器并返回第一个身份。
// 组合关系：composeAuthenticators 只整理注册表；每次请求由 authenticate 逐项调用，组件把结果放进 ctx.principal。
// 示例：const principal = await authenticate(entries, request, (plugin, error) => report(plugin, error), context);
// 建议阅读顺序：先看 Authenticator 与 AuthenticatorEntry 的形状，再看 authenticate 的循环与错误处理，
// 最后看 composeAuthenticators 与注册表定义。
// Who someone is (decision "The HTTP server is a native object", replacing the `authenticate` option): the registry
// `Authenticators`, one function per contributor, asked in contributor order (plugin name: an order with no meaning, so
// an app needing precedence between credentials contributes one authenticator that decides); the first principal
// returned wins, a throwing one is reported and skipped.

import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineRegistry, type RegistryTable } from "../../registries/index.ts";
import type { HttpRequest } from "./request.ts";

/** Who `request` is, or `undefined` (anonymous here, maybe another authenticator knows). */
// 函数类型别名：调用方传入“已准入的请求 + 上下文”，得到身份或 undefined（表示“我不认识这份凭据”）。
// 返回 Promise 时组件会等待；返回 undefined 不是错误，只是把机会让给下一个认证器。
export type Authenticator = (
	// 函数类型：输入请求和取消上下文，同步或异步返回 principal；undefined 表示自己未认出凭据，继续后面的认证器。
	request: HttpRequest,
	context: Context,
) => Principal | undefined | Promise<Principal | undefined>;

// 注册表中的一项：plugin 用于报告与排序来源，authenticate 是插件贡献的函数本身；两者都是只读引用。
// 运行时不复制或包装函数，composeAuthenticators 只是把注册表条目改名成这个形状。
/** An authenticator with its plugin, as the component asks it. */
export type AuthenticatorEntry = { readonly plugin: string; readonly authenticate: Authenticator };

// 注册表令牌：贡献类型是 Authenticator，组合值是 AuthenticatorEntry 数组；版本 1 与贡献方构建时一致。
// defineRegistry 只声明名字、版本和类型，真正的组合函数由 facet 通过 serve(Authenticators, ...) 提供。
/** The registry of authenticators (served by `http.facet`). */
export const Authenticators = defineRegistry<Authenticator, readonly AuthenticatorEntry[]>(
	"chord.http.authenticators",
	{
		version: 1,
	},
);

// 输入是注册表表格（可能为空），输出按同一顺序排列的条目数组；纯函数，不异步、不调用认证器。
// 真实运行时每个条目都是一个新对象，但 authenticate 函数引用保持原样；返回类型 readonly 只约束类型检查。
/** Composes `Authenticators`: every contribution in contributor order. */
// 把注册表的贡献项转换成请求可遍历的列表，不执行认证、无 I/O；保留 table 的顺序。
// 例如插件 a 的函数 f 变成 { plugin: "a", authenticate: f }，函数引用原样共享。
export function composeAuthenticators(table: RegistryTable<Authenticator>): readonly AuthenticatorEntry[] {
	// map 的参数解构取出插件名和贡献函数，再用对象字面量改名为 authenticate；readonly 是类型约束，不冻结数组。
	return table.map(({ plugin, value }) => ({ plugin, authenticate: value }));
}

/**
 * The principal of `request`: the first one an authenticator returns, in order; one that throws is reported through
 * `failed` and skipped; none: `undefined` (anonymous). Once `context` is aborted no further authenticator starts.
 */
// 顺序询问认证器，返回第一个身份或 undefined；failed 回调接收认证器异常，异常后仍尝试下一项。
// 例如第一项返回 undefined、第二项返回 owner，就立即结束。await 等待异步认证；此函数只在每项开始前检查取消，
// 正在执行的认证由它自己的 context 或外层请求竞速取消来处理，不会在此强制停止。
export async function authenticate(
	authenticators: readonly AuthenticatorEntry[],
	request: HttpRequest,
	failed: (plugin: string, error: unknown) => void,
	context: Context,
): Promise<Principal | undefined> {
	// for...of 逐项而非并行执行；解构中的 authenticate 是该项函数，遮蔽本函数同名标识符。
	for (const { plugin, authenticate } of authenticators) {
		// A request gone or sealed starts no new work (Sol's second recheck C).
		// ?. 在没有取消信号时返回 undefined，if 不成立；已经取消则不再启动任何认证器。
		if (context.abortSignal?.aborted) return undefined;
		try {
			// await 同时接受普通返回值与 Promise，身份不会被复制或再次校验。
			const principal = await authenticate(request, context);
			// 只有 undefined 表示未识别；找到身份就不再调用后面的认证器。
			if (principal !== undefined) return principal;
		} catch (error) {
			// 将异常交给调用方报告；若 failed 自身抛错，该异常会向上传播。
			failed(plugin, error);
		}
	}
	// 所有认证器均未识别时，请求保持匿名，后面的路由访问规则决定是否允许。
	return undefined;
}
