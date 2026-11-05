// 验证注册表 token 的类型/声明校验，以及 provider 加载时的唯一性和 setup 生命周期。
import { describe, expect, expectTypeOf, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { defineRegistry, type Registry, type RegistryValue } from "../../src/registries/index.ts";
import { loadedPlugins } from "../support.ts";

// 登记 token 声明测试：token 只传身份和版本，不直接携带 compose 实现。
describe("tokens", () => {
	// 同时检验开发时泛型与运行时声明策略；无外部副作用。
	// 实际样例版本 2 合法，大写名称和版本 0 抛错；泛型本身不会校验运行时贡献值。
	it("carry a name, a version and the types only; names and versions are checked at declaration", () => {
		// 两个泛型依次为贡献值和组合值；readonly 是开发时约束，不会把对象自动冻结。
		const Http = defineRegistry<{ readonly path: string }, readonly string[]>("chord.http", { version: 2 });
		// 要求实际 token 只有协议标记、名称和版本，不含类型占位字段或 provider。
		expect(Http).toEqual({ kind: "registry", name: "chord.http", version: 2 });
		// 声明类型预期，由 TypeScript 检查类型是否相等；普通 Vitest 运行不能替代全仓类型检查。
		expectTypeOf(Http).toEqualTypeOf<Registry<{ readonly path: string }, readonly string[]>>();
		// 声明函数运行时拒绝大写名称，与调用者有没有 TypeScript 无关。
		expect(() => defineRegistry("Chord.Http", { version: 1 })).toThrow('registry "Chord.Http": expected lowercase');
		// 将非法版本调用包成回调，要求声明时同步抛错。
		expect(() => defineRegistry("chord.http", { version: 0 })).toThrow(
			// 用具体错误文本定位版本必须为正整数的声明规则。
			"chord.http.version: expected a positive integer",
		);
	});
});

// 登记 provider 注册与读取测试；每个测试单独创建并关闭 host。
describe("providers", () => {
	// 共享 token：每项贡献为字符串，compose 产出数字；泛型只约束开发时调用。
	const Names = defineRegistry<string, number>("app.names", { version: 1 });

	// 让两个插件注册同名 provider，检查后一个插件被排除并进入 failed。
	// 回调返回 Promise<void>；例如 @app/b 重复 app.names 时保留 @app/a，再关闭 host。
	it("one per host: a second serve leaves its plugin out at load, reported", async () => {
		// 创建独立 host；本例不收集后台错误，断言检查 load 返回的失败报告。
		const host = createHost({ onError: () => {} });
		// facet setup 给 host 注册 provider；compose 输入贡献表并返回项数，无表内容写入。
		const serve = defineFacet((h) => h.serve(Names, { compose: (table) => table.length }));
		// 等待加载，解构取得按插件报告的失败；不把单个插件错误当作整个 host 拒绝。
		const { failed } = await host.load(
			[
				// 先注册此插件的 provider，使它占用 Names。
				{ name: "@app/a", facet: serve },
				// 后注册同一个 facet，用不同插件名制造重复声明。
				{ name: "@app/b", facet: serve },
			],
			// 把不主动取消的背景上下文传入加载操作。
			context,
		);
		// 比较完整失败列表，确认只报告指定插件及相应错误。
		expect(failed).toEqual([
			{
				// 重复声明应归后加载的插件，而不误伤第一个。
				plugin: "@app/b",
				// 对错误只匹配列出的属性，允许实际异常还带堆栈等字段。
				error: expect.objectContaining({
					// 错误文本同时说明重复的注册表与已有 provider 的来源插件。
					message: 'plugin "@app/b": registry app.names is served twice (plugin "@app/a")',
				}),
			},
		]);
		// 等待 host 清理；避免本例创建的生命周期状态影响后续测试。
		await host.close(context);
	});

	// 故意绕过类型检查传空 provider，要求运行时加载拒绝该插件。
	// 输入样本 {} 缺 compose；副作用是创建/关闭内存 host，不调用外部插件或服务。
	it("a provider without compose leaves its plugin out at load (plugin code is not type-checked)", async () => {
		// 辅助函数按插件创建 facets；as never 只绕过开发时类型，让本例触达真实运行时声明边界。
		const { host, failed } = await loadedPlugins({ "@app/a": (h) => h.serve(Names, {} as never) });
		// 比较完整失败列表，确认只报告指定插件及相应错误。
		expect(failed).toEqual([
			{
				// 本例唯一失败插件必须就是缺失 compose 的声明者。
				plugin: "@app/a",
				// 匹配 compose 必须为函数的声明错误，证明没有接受空对象。
				error: expect.objectContaining({ message: 'plugin "@app/a": registry app.names: compose is a function' }),
			},
		]);
		// 等待 host 清理；避免本例创建的生命周期状态影响后续测试。
		await host.close(context);
	});

	// 加载合法 provider 后取得组合值句柄，同时记录类型预期。
	// 空贡献表长度实际为 0；句柄读取不等于读到一个贡献，最后清理 host。
	it("a registry whose provider comes with `load` gives `host.registry` its value", async () => {
		// 创建独立 host；本例不收集后台错误，断言检查 load 返回的失败报告。
		const host = createHost({ onError: () => {} });
		// 先完成 provider 的首次发布，再读取注册表，避免 before-load 路径。
		await host.load(
			// setup 注册只数贡献数量的纯 compose；此例没有贡献，因此组合结果为 0。
			[{ name: "@app/a", facet: defineFacet((h) => h.serve(Names, { compose: (t) => t.length })) }],
			// 把不主动取消的背景上下文传入加载操作。
			context,
		);
		// 等待注册表可用，返回跟随组合变化的 RegistryValue 句柄，而非裸数字。
		const value = await host.registry(Names, context);
		// 用类型断言约束该句柄读取的值为 number；统一类型检查另行运行。
		expectTypeOf(value).toEqualTypeOf<RegistryValue<number>>();
		// 运行时读取句柄当前组合值，要求等于空表长度。
		expect(value.value).toBe(0);
		// 等待 host 清理；避免本例创建的生命周期状态影响后续测试。
		await host.close(context);
	});

	// 将 setup 中的 FacetHost 暂存到外部，再在 setup 结束后调用 serve，要求拒绝。
	// 无输入，返回异步测试结果；实际例子说明保留句柄不能延长声明窗口。
	it("are served only while the setup runs", async () => {
		// 两层 Parameters：先取 defineFacet 的 setup，再取 setup 的首个 host 参数；初始可能 undefined。
		let later: Parameters<Parameters<typeof defineFacet>[0]>[0] | undefined;
		// 创建并加载内存测试 host，外层只取 host 供结束时清理。
		const { host } = await loadedPlugins({
			// 插件 setup 回调输入 FacetHost，不返回业务数据，只捕获引用供越界调用测试。
			"@app/a": (h) => {
				// 保存声明入口；此赋值不会让 setup 的有效期延长。
				later = h;
			},
		});
		// ! 说明 setup 已赋值；延迟调用使 toThrow 捕捉生命周期边界错误。
		expect(() => later!.serve(Names, { compose: (t) => t.length })).toThrow(
			// 要求错误明确说明 serve 只在 facet setup 执行期间有效。
			"@app/a: host.serve is valid only in the facet's setup",
		);
		// 等待 host 清理；避免本例创建的生命周期状态影响后续测试。
		await host.close(context);
	});
});
