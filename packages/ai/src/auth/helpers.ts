// 提供可复用认证器构造函数，供各 Provider 定义采用；只导入接口类型。
import type { ApiKeyAuth, OAuthAuth } from "./types.ts";

/**
 * Standard api-key auth: a stored credential key wins, otherwise the first
 * set env var resolves. Includes a `login` that prompts for the key.
 * Providers with non-standard resolution (provider env, ambient files, IAM)
 * write their own `ApiKeyAuth`.
 */
/**
 * 构造常见 API key 认证器，输入展示名和有序环境变量名，返回 login/resolve 实现，本身不弹窗或请求网络。
 * 登录询问 secret；解析先用非空存储 key，再依次查宿主环境。例：envApiKeyAuth("Demo key",["DEMO_KEY","BACKUP_KEY"]) 中前一个有值就优先。
 */
export function envApiKeyAuth(name: string, envVars: readonly string[]): ApiKeyAuth {
	// 创建认证方法对象，函数体仍要等实际操作时才执行。
	return {
		// 展示名按输入原样保留，属性简写等价 name: name。
		name,
		/**
		 * 询问并返回带 api_key 标签的凭证，输入规范交互对象，可能弹出输入框或因取消拒绝。
		 * 提示前后检查信号，不校验 key 远端有效性，也不在这里写 CredentialStore；例：输入 abc 得 {type:"api_key",key:"abc"}。
		 */
		login: async (interaction) => {
			// 弹出输入前发现取消就直接失败。
			interaction.signal.throwIfAborted();
			// await 等秘密输入；模板字符串仅构造提示，不执行该文字。
			const key = await interaction.prompt({ type: "secret", message: `Enter ${name}` });
			// 输入期间若已取消，即使 prompt 给了字符串也不继续返回凭证。
			interaction.signal.throwIfAborted();
			// 这里只打上类型标签，不持久化，也没有对空字符串做额外检查。
			return { type: "api_key", key };
		},
		/**
		 * 解析请求认证：检查取消，优先存储非空 key，否则顺序 await ctx.env，返回首个有值来源或 undefined。
		 * 宿主 env 可有自定义副作用，不能把此方法保证为绝对无 I/O；例：空存储 key 会继续试环境，不等于忽略整个供应商的存储类别。
		 */
		resolve: async ({ ctx, credential, signal }) => {
			// 真正取认证前先检查统一信号。
			signal.throwIfAborted();
			// ?. 允许无存储凭证，truthy 条件使空 key 继续回退环境。
			if (credential?.key) {
				// 存储 key 成功时同时透传其 provider env，不把 env 混进 HTTP 头。
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			}
			// 按输入数组顺序查询，首个真值胜出，不同时查询所有变量。
			for (const envVar of envVars) {
				// 宿主 ctx.env 可异步，便于测试或浏览器替换环境来源。
				const value = await ctx.env(envVar);
				// 每次等待环境后再检查取消，避免已取消却继续用后来取到的值。
				signal.throwIfAborted();
				// 首个非空值成为请求 apiKey，source 记变量名而非秘密值。
				if (value) return { auth: { apiKey: value }, source: envVar };
			}
			// 所有来源都无值时表示未配置，是否报认证错误交上层。
			return undefined;
		},
	};
}

/**
 * Wraps a dynamically imported `OAuthAuth` so provider definitions can
 * advertise OAuth without importing the implementation. The flow loads on
 * first `login`/`refresh`/`toAuth` call; callers keep Node-only flow code out
 * of bundles by loading through a bundler-opaque dynamic import (variable
 * specifier, see the bedrock lazy wrapper).
 */
/**
 * 给 OAuth 实现加按需加载外观，输入展示元数据与 load，返回相同登录/刷新/转换接口，构造时不加载 flow。
 * 首次调用任一方法才加载并缓存 Promise，同一包装器的后续方法共用它；例：先 toAuth 后 login 只用同一次成功加载。
 * 加载 Promise 拒绝也会缓存，不自动重试；若 load 在返回 Promise 前同步抛错，赋值未发生，稍后还可能再调用。
 */
export function lazyOAuth(input: {
	// 登录界面展示名在加载前就可查询。
	name: string;
	// 订阅标记可缺省，包装器不现场核验账号套餐。
	isSubscription?: boolean;
	// 可选登录选择项文字，与展示名可以不同。
	loginLabel?: string;
	// 实现工厂异步给出 OAuthAuth；类型不保证运行时绝不抛同步异常。
	load: () => Promise<OAuthAuth>;
	// 返回 OAuth 方法外观，不是一次 OAuth 凭证。
}): OAuthAuth {
	// 闭包记住一次加载的 Promise；不是模块全局强制共用所有 Provider。
	let promise: Promise<OAuthAuth> | undefined;
	/**
	 * 取得当前包装器唯一的加载 Promise，缺省时立即调用 load；返回实现 Promise 或传播加载异常。
	 * ??= 只在 promise 为 null/undefined 时赋值，不在每个 login 时重新加载；这里没有模块卸载或重试重置逻辑。
	 */
	const loaded = () => {
		// 首次调用才启动加载；已有 fulfilled/rejected Promise 都原样复用。
		promise ??= input.load();
		// 同一 pending Promise 可被多个方法共同等待。
		return promise;
	};
	// 新对象先暴露展示字段，再逐项代理实际方法。
	return {
		// 名称直接从构造输入复制。
		name: input.name,
		// 订阅元数据也直接保留。
		isSubscription: input.isSubscription,
		// 登录标签不等到加载后才确定。
		loginLabel: input.loginLabel,
		// 先 await 实现，再调用其 login，保留交互与安装身份选项；异常使本 async 方法拒绝。
		login: async (interaction, options) => (await loaded()).login(interaction, options),
		// 刷新沿用传入凭证和信号，包装器自己不持锁或决定何时刷新。
		refresh: async (credential, signal) => (await loaded()).refresh(credential, signal),
		// 凭证转请求认证也会触发首次加载，不因名字是 toAuth 就保证这次无模块加载成本。
		toAuth: async (credential) => (await loaded()).toAuth(credential),
	};
}
