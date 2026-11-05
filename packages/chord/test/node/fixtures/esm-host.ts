// Fixture (slice 7c): an ESM host package, given to evaluation as its namespace.

/** The default export a default import reads. */
// ES 模块默认导出一个字符串；测试会检查经过 CommonJS 包装后 default import 仍读到它。
export default "esm default";

/** A named export a named import reads. */
// 具名导出必须按 named 读取；它和默认导出是同一模块的不同属性，不创建第二个模块。
export const named = "esm named";
