// 为集成测试定位本机 pi-env daemon；没有二进制时在模块导入阶段失败。
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The daemon the tests run: `PI_ENV_DAEMON` (CI points it at release builds), else the one `cargo build` built in
 * ../daemon.
 */
// 测试共用的二进制路径；?? 只在环境变量未设置时回退，显式空串不会回退。此处只选路径，不构建或启动 daemon。
export const daemon =
	// CI 可用 PI_ENV_DAEMON 指向已构建的发布文件；普通本地运行走下一行 debug 路径。
	process.env.PI_ENV_DAEMON ??
	// import.meta.dirname 是当前模块目录；三元表达式仅 Windows 加 .exe，resolve 返回绝对路径。
	resolve(import.meta.dirname, `../daemon/target/debug/pi-env${process.platform === "win32" ? ".exe" : ""}`);
// 导入此模块时立即检查文件存在；存在不代表可执行、平台兼容或内容可信。
if (!existsSync(daemon)) {
	// 缺失直接抛错阻止测试收集，提示手动构建；本文件不会自动安装 Rust 或运行 cargo。
	throw new Error(`Build the daemon first: npm run build:daemon in packages/env (missing ${daemon})`);
}
