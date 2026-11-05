/**
 * 本仓库类型检查用的环境模块声明，不是Cloudflare实现，也不会输出运行JS或创建Durable Object。
 * declare module告诉TS特殊导入长什么样；真实运行依赖平台/打包器，用户项目通常由Wrangler生成更完整类型。
 * 这些声明不随包发布，不能把静态“能编译”当本机具备Cloudflare能力。
 */
// Modules that only exist when cloudflare.ts is built by Wrangler. Consumers get the real
// declarations from @cloudflare/workers-types or `wrangler types`; these keep this repository's
// type check free of a Workers type dependency and are not published.

// 字符串模块名对应cloudflare.ts的特殊import，声明没有真实模块代码。
declare module "cloudflare:workers" {
	// abstract class仅允许作为基类使用；Env=unknown是省略泛型时的默认，不额外验环境绑定。
	export abstract class DurableObject<Env = unknown> {
		// protected ctx对子类可见，unknown需先收窄才能使用其能力。
		protected ctx: unknown;
		// env使用泛型Env，省略类型参数时默认unknown；这份最小声明未完整描述平台API。
		protected env: Env;
		/** 构造器签名只用于类型检查，无函数体，不会实际保存ctx/env；真正实现由Cloudflare提供。 */
		constructor(ctx: unknown, env: Env);
	}
}

// A pattern, not the exact specifier: coding-agent declares "quickjs-wasi/quickjs.wasm" as a path
// for Bun, and an exact declaration takes precedence where both are visible. cloudflare.ts casts the
// import to the compiled module Wrangler actually produces.
// 带*的环境模块模式用于wasm导入；更精确的同名声明可优先，避免和Bun路径导入的声明混淆。
declare module "*/quickjs.wasm" {
	// 先按unknown描述构建产物，使用处知道Wrangler规则才断言为编译模块。
	const module: unknown;
	// 默认导出仅是声明，不在磁盘生成名为module的JS对象。
	export default module;
}
