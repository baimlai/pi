// 为剪贴板等平台适配提供WSL启发式检测；只读环境/内核版本，不启动Windows程序，也不保证interop当前可用。
import { readFileSync } from "node:fs";

/** Windows Subsystem for Linux, where Windows executables are reachable through interop. */
// 输入可选环境字典（默认当前进程环境），返回布尔值；先看WSL变量，再读/proc/version，读取失败返回false。
// 例如测试传{WSL_DISTRO_NAME:"Ubuntu"}即返回true；传空字典仍可能根据当前主机/proc/version返回true，并非纯环境判断。
export function isWSL(env: NodeJS.ProcessEnv = process.env): boolean {
	// 这两个环境变量任一非空就采用快速路径，不校验发行版名称或进程平台。
	if (env.WSL_DISTRO_NAME || env.WSLENV) {
		return true;
	}

	try {
		// Linux内核版本文字可能标注Microsoft/WSL；文件系统读取是本函数唯一I/O。
		const release = readFileSync("/proc/version", "utf-8");
		// 正则i忽略大小写，任一关键词匹配就判定为WSL特征。
		return /microsoft|wsl/i.test(release);
	} catch {
		// 非Linux或无访问权限等读取失败都当未发现WSL，不抛给剪贴板业务。
		return false;
	}
}
