// 为 Provider 的认证解析提供环境/文件能力，供默认 Models 集合使用；import type 在运行时擦除。
import type { AuthContext } from "./types.ts";

// 只声明这里会用到的文件系统方法形状，不加载真正 Node 模块，也不替代运行时导入。
interface NodeFsModule {
	// access 成功无结果，失败拒绝 Promise；没有指定 mode 时只用默认探测语义。
	access(path: string): Promise<void>;
}

// 只声明系统模块的 home 查询能力。
interface NodeOsModule {
	// 方法返回当前用户目录文字，不是资源根路径。
	homedir(): string;
}

// Variable specifier so browser bundlers do not try to resolve node builtins.
/**
 * 按变量形式的模块名延迟导入 Node 模块，返回模块 Promise，失败仍拒绝。
 * 例：fileExists 调用 importNodeModule("node:fs/promises") 时才加载文件系统能力；这种原有写法用于避免浏览器打包器静态追踪 Node 内置模块。
 */
const importNodeModule = (specifier: string): Promise<unknown> => import(specifier);

/**
 * 从当前全局对象取可选 process.env 字典，无文件或网络操作。
 * 返回环境对象原引用或 undefined；例：普通浏览器没有 process 时返回缺失，不创建 Node 兼容对象。
 */
function getProcessEnv(): Record<string, string | undefined> | undefined {
	// as 按浏览器/Node 双环境描述可选 process；断言不实际创建或验证该全局属性。
	const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
	// 可选链允许 process 不存在，存在则返回它的 env 引用。
	return proc?.env;
}

/**
 * Default auth context: env vars from `process.env` (undefined in browsers),
 * file existence via node:fs (always false in browsers).
 */
/**
 * 创建默认认证宿主能力，返回 env/fileExists 两个异步方法；构造本身不读取文件或检查凭证。
 * 环境变量取自当前进程，文件探测按需加载 Node 模块；例：认证器可问 ctx.env("TOKEN")，没有非空值就得到 undefined。
 */
export function defaultProviderAuthContext(): AuthContext {
	// 返回新的能力对象，下面的方法真正调用时才查环境或文件。
	return {
		/**
		 * 按名称读取环境变量，返回非纯空白的原字符串或 undefined，不修改环境。
		 * trim 只用于判定，不改变返回内容；例：" token " 返回含空格原文，"   " 则视为未配置。
		 */
		async env(name: string): Promise<string | undefined> {
			// 每次从全局重新取字典再按参数键读取，不缓存某次 token。
			const value = getProcessEnv()?.[name];
			// 运行环境能力边界确认字符串；纯空白视为缺失，有效值仍保留原始首尾空格。
			return typeof value === "string" && value.trim().length > 0 ? value : undefined;
		},

		/**
		 * 探测路径是否可 access，返回布尔值；会按需加载 Node 模块并访问文件系统，失败统一 false。
		 * 前导 ~ 简单替换为当前用户 home，不解析 ~alice 等命名用户；例：~/.aws/credentials 可供环境认证判断文件来源，不代表文件内容或权限适合认证。
		 */
		async fileExists(path: string): Promise<boolean> {
			// 导入失败、home 查询失败和文件不可 access 都在同一容错边界内。
			try {
				// await 等 Node 文件模块；as NodeFsModule 只说明需要 access，未做模块完整结构验证。
				const fs = (await importNodeModule("node:fs/promises")) as NodeFsModule;
				// let 保存可改写的探测路径，参数原文字不变。
				let resolved = path;
				// 只检查第一个字符是否为 ~，不区分 ~/ 与 ~用户名。
				if (resolved.startsWith("~")) {
					// 只有需要替换 home 时才加载 node:os，避免每次普通文件探测都加载它。
					const os = (await importNodeModule("node:os")) as NodeOsModule;
					// 去掉一个 ~ 再拼 home，属于简单字符串替换。
					resolved = os.homedir() + resolved.slice(1);
				}
				// 实际异步探测此刻路径，结果不能保证之后文件仍存在。
				await fs.access(resolved);
				// access 完成表示此次探测成功，既可能是文件也可能是目录。
				return true;
				// 容错包括浏览器缺少 Node 模块等异常，不把探测失败直接变为认证异常。
			} catch {
				// 失败只报告 false，不区分路径不存在、无权限或模块不可用。
				return false;
			}
		},
	};
}
