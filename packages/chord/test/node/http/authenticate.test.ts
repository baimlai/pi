// 在内存里验证认证器的先后顺序、失败隔离和取消；不连接真实账户。
// Tests of the authenticators: asked in contributor order, the first principal wins, a throwing one reported and
// skipped, none: anonymous.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../../../src/context/index.ts";
import { type Authenticator, authenticate, composeAuthenticators } from "../../../src/node/http/authenticate.ts";
import type { HttpRequest } from "../../../src/node/http/index.ts";
import type { RegistryTable } from "../../../src/registries/index.ts";

// 仅构造这些认证器会读的 headers；as 是编译期断言，不会补齐 HttpRequest 的其他字段。
const request = { headers: new Headers() } as HttpRequest;

// describe 注册一组测试；它的回调登记 it 用例，不在这里处理 HTTP 请求。
describe("authenticators", () => {
	// 此异步用例无参数、无返回业务值；依次安排无答案、抛错、owner、guest 四个替身，再检查调用轨迹。
	// 例如预期 a→b→c 后停止，d 不执行；副作用只写本测试数组，异常由认证流程捕获。
	it("are asked in contributor order; the first principal wins; a throwing one is reported and skipped", async () => {
		// string[] 限定轨迹元素是字符串；初始没有认证器被询问。
		const asked: string[] = [];
		// 辅助回调接收名字和身份，记录后原样返回身份；例如 answer("c", {kind:"owner"}) 让 c 成为成功项。
		const answer = (name: string, principal: { kind: string }) => {
			// 把本次被询问的认证器名追加到轨迹。
			asked.push(name);
			// 把传入的身份直接交给 authenticate，不复制或检查真实凭证。
			return principal;
		};
		// 泛型指定每条贡献的 value 是认证函数；plugin/version 是注册表元数据，数组顺序就是本例询问顺序。
		const table: RegistryTable<Authenticator> = [
			// a 记录调用后通过 void 丢弃 push 返回的数组长度，故返回 undefined，表示它没有识别出身份。
			{ plugin: "@app/a", version: 1, value: () => void asked.push("a") },
			{
				plugin: "@app/b",
				version: 1,
				// b 的无参替身先记录轨迹，再主动抛错；这不是任何真实认证系统的错误。
				value: () => {
					// 留下 b 已被执行的证据。
					asked.push("b");
					// 模拟单个认证器故障，检查它不会阻止后续认证器。
					throw new Error("broken");
				},
			},
			// async 把 owner 答案包装成 Promise，验证流程也能等待异步认证器。
			{ plugin: "@app/c", version: 1, value: async () => answer("c", { kind: "owner" }) },
			// d 若执行会返回 guest；期望前面的 owner 已使遍历停止。
			{ plugin: "@app/d", version: 1, value: () => answer("d", { kind: "guest" }) },
		];
		// 元组 [string, unknown] 保存插件名与原错误；unknown 要先缩小类型才能访问错误属性。
		const failed: [string, unknown][] = [];
		// 等待认证结果：compose 保留贡献者顺序，request 是上面的内存请求，context 没有取消。
		const principal = await authenticate(
			composeAuthenticators(table),
			request,
			// 失败回调收集被跳过的认证器及错误，不向外发送日志。
			(plugin, error) => failed.push([plugin, error]),
			context,
		);
		// 同时比较身份、先后顺序和失败记录；toEqual 比较结构，未证明任何真实凭证可用。
		expect([principal, asked, failed]).toEqual([
			{ kind: "owner" },
			["a", "b", "c"],
			[["@app/b", new Error("broken")]],
		]);
	});

	// Sol's second recheck C: a fresh authenticator started after the request was cancelled.
	// 此用例用已取消的上下文调用认证；输入的唯一认证器会计数，预期结果匿名且计数为零。
	it("start no authenticator once the context is aborted", async () => {
		// 可变计数器记录认证器实际启动次数。
		let calls = 0;
		// 这个替身若执行就自增，但不返回身份；数组类型只由 TypeScript 检查。
		const table: RegistryTable<Authenticator> = [{ plugin: "@app/a", version: 1, value: () => void calls++ }];
		// AbortSignal.abort() 创建已经取消的信号；withAbortSignal 将它放入派生上下文。
		const aborted = withAbortSignal(AbortSignal.abort(), context);
		// 等待流程并断言没有身份；空失败回调不处理任何业务。
		expect(await authenticate(composeAuthenticators(table), request, () => {}, aborted)).toBeUndefined();
		// 确认取消检查发生在启动认证器之前。
		expect(calls).toBe(0);
	});

	// 空认证列表这个例子没有可询问的函数；期望异步结果为 undefined，既不抛错也不假造身份。
	it("give no principal when none knows the request", async () => {
		// 直接传空数组，检查匿名这一约定值。
		expect(await authenticate([], request, () => {}, context)).toBeUndefined();
	});
});
