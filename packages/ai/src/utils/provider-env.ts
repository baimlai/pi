// 请求/认证适配读取环境配置的统一入口；优先显式请求覆盖，再看process.env，最后补Bun Linux沙箱的特殊回退。
// 只导入环境覆盖字典类型，运行时仍是普通对象。
import type { ProviderEnv } from "../types.ts";

// null 表示尚未尝试读/proc；空Map表示尝试过但没读到，避免失败时每次重复IO。
let procEnvCache: Map<string, string> | null = null;

/**
 * Fallback for https://github.com/oven-sh/bun/issues/27802.
 * Bun compiled binaries can expose an empty process.env inside Linux sandboxes
 * even though /proc/self/environ contains the environment.
 *
 * This intentionally duplicates restoreSandboxEnv() in
 * packages/coding-agent/src/bun/restore-sandbox-env.ts. The ai package can be
 * used directly, without going through that entrypoint, so provider env lookup
 * must not depend on process.env having been patched.
 */
// 用途：仅在Bun且process.env整体为空时，从/proc/self/environ查值。例Linux沙箱隐藏了process.env但内核仍提供环境；首次调用会同步读取并缓存，失败返回缺失，不抛IO错误。
function getBunSandboxEnvValue(name: string): string | undefined {
	// 运行环境能力边界：浏览器没有process，非Bun或已有正常环境时都不走特殊回退。
	if (typeof process === "undefined" || !process.versions?.bun || Object.keys(process.env).length > 0) {
		// 回退不适用或确实没此变量时，返回缺失供上层继续处理。
		return undefined;
	}

	// 只首次探测时读/proc，其后复用同一份解析结果。
	if (procEnvCache === null) {
		// 先创建缓存，保证即使读取失败也记住“已经尝试过”。
		procEnvCache = new Map();
		// /proc可能不存在或没权限，必须把环境探测失败控制在本函数内。
		try {
			// 只有该Node/Bun分支才加载fs；原代码使用require以保持特定编译运行方式，as只声明所需方法类型。
			const { readFileSync } = require("node:fs") as {
				// 声明读取指定编码后得到字符串，并不会在这里执行读取。
				readFileSync(path: string, encoding: BufferEncoding): string;
			};
			// 真正同步读取当前进程环境；内容可能含敏感值，不应打印。
			const data = readFileSync("/proc/self/environ", "utf-8");
			// Linux环境以NUL字符分隔条目，不是按普通换行分隔。
			for (const entry of data.split("\0")) {
				// 只找第一个等号，变量值本身还可能包含等号。
				const idx = entry.indexOf("=");
				// 必须有非空变量名；没有等号或等号在开头的条目忽略。
				if (idx > 0) {
					// 等号前为名字、后为完整值，保存到缓存。
					procEnvCache.set(entry.slice(0, idx), entry.slice(idx + 1));
				}
			}
		} catch {
			// /proc/self/environ may not exist or may not be readable.
		}
	}

	// 按名称读取缓存，没找到时Map.get返回undefined。
	return procEnvCache.get(name);
}

/**
 * Resolve a provider env value from scoped overrides, normal process.env, then
 * the duplicated Bun sandbox fallback for direct pi-ai consumers.
 */
// 用途：按优先级取一个供应商环境值。例请求env中有API_KEY就优先于进程环境；空字符串按当前||规则视为无值，可能继续回退。
export function getProviderEnvValue(name: string, env?: ProviderEnv): string | undefined {
	// 下面短路或表达式找到首个真值即停止读取后续来源。
	return (
		// 显式请求覆盖优先；?.允许调用者不提供覆盖对象。
		env?.[name] ||
		// 有process时再查进程环境，兼容浏览器运行。
		(typeof process !== "undefined" ? process.env[name] : undefined) ||
		// 常规来源无值时再尝试Bun沙箱回退，不要求coding-agent入口先修补环境。
		getBunSandboxEnvValue(name) ||
		// 所有来源无有效值时统一为undefined，不返回空字符串。
		undefined
	);
}
