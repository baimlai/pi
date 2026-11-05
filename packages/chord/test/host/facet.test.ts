// 验证 facet 只在同步 setup 内声明服务和贡献，并通过类型把插件绑定到应用的 principal 联合类型。
import { describe, expect, expectTypeOf, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, local } from "../../src/contracts/index.ts";
import { defineFacet, type Facet, type FacetHost, type FacetSelf, type Host } from "../../src/host/index.ts";
import { defineRegistry } from "../../src/registries/index.ts";
import { constant } from "../../src/state/index.ts";
import { loaded } from "../support.ts";

// local 是只在本 host 可用的契约；空 params 使它具有 host 生命周期，n 是整数状态成员。
const Info = local("app.info", { version: 1, params: {}, members: { n: int() } });

// 注册 facet 机制的测试集合；测试闭包中的 expect 才执行验证。
describe("facets", () => {
	// 捕获 setup 的 host 后晚用 serve，断言运行时声明窗口已经关闭；无输入，返回 Promise<void>。
	// 例：loaded 返回后再 serve Info 会抛指定错误；不会启动新的 Info 对象。
	it("declare only while their setup runs", async () => {
		// 联合 undefined 表示 setup 尚未把句柄放入变量。
		let later: FacetHost | undefined;
		// loaded 创建 host 并加载单个测试 facet，回调保存它的声明接口。
		await loaded((host) => {
			later = host;
		});
		// ! 只让 TypeScript 相信 later 已赋值；真正拒绝晚声明的是 serve 内的 assertOpen。
		// 嵌套工厂若被允许会返回 constant(1)，此例预期在运行工厂前就失败。
		expect(() => later!.serve(Info, () => ({ n: constant(1) }))).toThrow(
			"@test/app: host.serve is valid only in the facet's setup",
		);
	});

	// 只做编译期 API 验证，不在运行时造 state/open；Parameters 提取 setup 参数元组。
	// 例：FacetSelf 的键只能是 contribute；若 API 意外加上 state，类型检查会失败。
	it("only declare: a setup takes the host and a self that only contributes; no documents, routines or natives", () => {
		// 索引访问类型 ["setup"] 取出函数类型；两项元组分别为声明 host 和贡献 self。
		expectTypeOf<Parameters<Facet<{ kind: "owner" }>["setup"]>>().toEqualTypeOf<
			[FacetHost<{ kind: "owner" }>, FacetSelf]
		>();
		// keyof 得到属性名的联合；其余断言确认对象状态与 routine 不属于声明 host。
		expectTypeOf<keyof FacetSelf>().toEqualTypeOf<"contribute">();
		expectTypeOf<FacetHost>().not.toHaveProperty("state");
		expectTypeOf<FacetHost>().not.toHaveProperty("on");
		expectTypeOf<FacetHost>().not.toHaveProperty("onLive");
	});

	// 同一 setup 贡献两次会记入 load.failed，setup 后贡献则直接抛错；返回 Promise<void>。
	// 例：Names 接受 string 贡献、compose 成 number；a 后再贡献 b 被拒，later.contribute("late") 也被拒。
	it("contribute at most one value per registry, only while their setup runs", async () => {
		// 两个泛型分别是贡献值与组合结果的类型；运行时不会用它们校验字符串。
		const Names = defineRegistry<string, number>("app.names", { version: 1 });
		// 同一个插件同一个 registry 只许一次贡献；第二行触发声明错误。
		const twice = await loaded((_, self) => {
			self.contribute(Names, "a");
			self.contribute(Names, "b");
		});
		// load 将错误记为插件失败而不是让整个 host 关闭；这里只比较 Error.message。
		expect(twice.failed.map(({ error }) => (error as Error).message)).toEqual([
			'plugin "@test/app": @test/app: registry app.names is contributed to twice',
		]);
		// 显式关掉首个测试 host，避免和第二个场景的生命周期混杂。
		await twice.host.close(context);
		// 可选变量捕获第二个 setup 的贡献接口。
		let later: FacetSelf | undefined;
		const { host } = await loaded((host, self) => {
			// compose 不读取贡献内容，只数 table 条目，返回 number 与声明类型一致。
			host.serve(Names, { compose: (table) => table.length });
			later = self;
		});
		// setup 已结束；! 只消除静态 undefined，运行时仍由声明窗口保护。
		expect(() => later!.contribute(Names, "late")).toThrow(
			"@test/app: self.contribute is valid only in the facet's setup",
		);
		// 第二个 host 也按正常关闭路径清理。
		await host.close(context);
	});

	// 验证 principal 必须精确一致；这里只检查类型，不做身份认证，也不把泛型当运行时校验。
	// 例：owner|guest 的 host 既不能载入仅 owner 的 facet，也不能载入额外接受 robot 的 facet。
	it("are typed by exactly the app's principal type", () => {
		// kind 区分联合分支；只有 guest 带 session 字段。
		type App = { kind: "owner" } | { kind: "guest"; session: string };
		// 空 setup 不声明内容，App 泛型把类型约束保留在 facet token 上。
		const facet = defineFacet<App>(() => {});
		expectTypeOf(facet).toEqualTypeOf<Facet<App>>();
		// 从 Host<App> 提取 load 的类型，再用 Parameters 的第零项验证只读插件列表。
		type Load = Host<App>["load"];
		expectTypeOf<Parameters<Load>[0]>().toEqualTypeOf<
			readonly { readonly name: string; readonly facet: Facet<App> }[]
		>();
		// 相同类型可赋值；更窄与更宽的 principal 联合都不可，证明这里要求不变而非单向兼容。
		expectTypeOf<Facet<App>>().toExtend<Facet<App>>();
		expectTypeOf<Facet<{ kind: "owner" }>>().not.toExtend<Facet<App>>();
		expectTypeOf<Facet<App | { kind: "robot" }>>().not.toExtend<Facet<App>>();
	});
});
