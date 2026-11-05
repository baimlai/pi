import { vi } from "vitest";

/** Enable network code paths for tests that replace external I/O with local fixtures or mocks. */
// 无参数、无返回值；把测试进程的 PI_OFFLINE 暂时设为缺省，让被测代码进入联网分支。
// 例如 HTTP 已被 vi.fn 替换的用例先调用它；它本身既不发请求，也不提供网络隔离，调用方仍须保证 I/O 是夹具或 mock。
export function allowNetwork(): void {
	// Vitest 记录环境改动；本包配置的 unstubEnvs 会在测试间恢复，undefined 表示删除该环境变量。
	vi.stubEnv("PI_OFFLINE", undefined);
}
