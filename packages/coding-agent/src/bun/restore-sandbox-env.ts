/**
 * Workaround for https://github.com/oven-sh/bun/issues/27802
 *
 * Bun compiled binaries have an empty `process.env` when running inside
 * sandbox environments (e.g. nono on Linux/macOS). On Linux we can recover
 * the environment from `/proc/self/environ`.
 *
 * Keep this in sync with getBunSandboxEnvValue() in
 * packages/ai/src/utils/provider-env.ts. The ai package duplicates the lookup
 * for direct consumers that do not go through this coding-agent entrypoint.
 */

// 仅为Bun空环境问题读取Linux /proc/self/environ；这里导入同步文件读取函数，不立即读真实环境。
import { readFileSync } from "node:fs";

/**
 * Restore environment variables from `/proc/self/environ` when running
 * inside a sandbox where Bun's `process.env` is empty.
 */
// 尽力恢复Bun沙箱里完全空的process.env，无参数/返回；只在Bun标识存在且一个环境键都没有时尝试。
// 例：本机进程环境原始记录FOO=bar再接NUL，会填process.env.FOO；有任意键就整次跳过，不修复部分缺失。
// 读UTF-8→按NUL分项→只按首个=分键值→逐项赋环境。/proc通常Linux才有，但此处不检查平台，读错会吞。
// 恢复会修改当前进程环境而非写磁盘；catch不回滚已经成功赋过的键，不保证失败后环境保持原状。
export function restoreSandboxEnv(): void {
	// 可选链兼容没有versions的视图；没有真值bun字段立即返回，普通Node不读/proc。
	if (!process.versions?.bun) return;

	// If process.env already has entries, nothing to fix.
	// Object.keys数可枚举自有键；任意一个已存在都认为无需修复，包括值为空字符串的键。
	if (Object.keys(process.env).length > 0) return;

	// 读取、拆项、写环境都在此try，任一步同步抛错都会进入catch。
	try {
		// 读取当前进程的原始环境记录，不读父进程/用户配置；无内容日志或网络请求。
		const data = readFileSync("/proc/self/environ", "utf-8");
		// split以NUL而非换行分隔；结尾NUL产生空项，会被后面的idx条件忽略。
		for (const entry of data.split("\0")) {
			// 只找第一个等号，值内部其他=仍保留。
			const idx = entry.indexOf("=");
			// idx>0要求键非空；无等号(-1)或等号在开头(0)跳过，允许等号后空值。
			if (idx > 0) {
				// 前段为键、后段为完整值，写入process.env；没有类型断言替这些字符串做额外校验。
				process.env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
		// 忽略读取/环境赋值异常，不返回成功标记或重试；有部分写入时也不撤回。
	} catch {
		// /proc/self/environ may not be readable; ignore.
	}
}
