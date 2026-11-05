// Loaded by vitest for every test file: `PI_DURABLE_DOCUMENT_RETENTION_MS` sets the document retention of every Session
// that keeps the default, so the suite can run with each unattached document evicted right after use
// (`npm run test:evicting`).
import { setDefaultDocumentRetention } from "../src/session/session.ts";

// 读取进程环境变量，导入此 setup 文件时即执行；没有变量则沿用默认保留时间。
const forced = process.env.PI_DURABLE_DOCUMENT_RETENTION_MS;
// 例如字符串 "0" 转成数字 0，使默认配置的文档尽快被逐出；Number 本身不校验有限性。
// setDefaultDocumentRetention 仅赋值，不校验；例如非数字字符串会写入 NaN，测试环境须提供合理值。
if (forced !== undefined) setDefaultDocumentRetention(Number(forced));
