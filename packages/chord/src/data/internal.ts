// Data for Chord's layers: per-call checks of params and arguments, principal keys, and errors on the wire.

// 文件导读
// 所属包与模块：packages/chord/src/data 的内部入口，供 Chord 的 host/link/对象层使用。
// 职责边界：只做 re-export，暴露参数校验、身份键、错误信封与验证器；应用入口是 ./index.ts。
// 上游：host/link/对象层 import。下游：这些函数在真实调用边界执行校验与协议解析；导入本身不执行逻辑。
// 结果与错误流向：函数被调用时才可能抛 ChordError 或普通 Error（信封校验失败）。
// 能力清单：
// - bindProvider/binds/checkArgs/Provider/Value/CheckedArgs：契约参数绑定与检查。
// - asChordError/CHORD_ERROR_REASONS/chordErrorFromJson/invalid/PROTOCOL_VERSION：错误构造与线格式。
// - openFailure/sameCause/waitingFor：失败原因分类与比较。
// - checkAddress/checkParams/identityKey：params、地址与身份。
// - canonicalJson/principalKey：principal 键与规范 JSON。
// - check/validatorFor：编译校验器与执行检查。
// 组合关系与典型调用顺序：bindProvider -> checkArgs；checkParams/checkAddress -> validatorFor/check；
// principalKey -> identityKey；错误在 link 上 toJSON -> chordErrorFromJson。
// 示例（真实签名）：import { checkParams, identityKey } from "./data/internal.ts";
// const { key } = checkParams(contract, raw, context); const id = identityKey(contract, key);
// 建议阅读顺序：args.ts -> params.ts -> principal.ts -> validator.ts -> failure.ts -> errors.ts；本文件仅是索引。

// 内部入口供 Chord 各层使用：提供者登记/参数检查/身份键/错误信封校验；重导出不执行一次调用或开启服务。
export { bindProvider, binds, type CheckedArgs, checkArgs, type Provider, type Value } from "./args.ts";
export {
	asChordError,
	CHORD_ERROR_REASONS,
	chordErrorFromJson,
	invalid,
	PROTOCOL_VERSION,
} from "./errors.ts";
export { openFailure, sameCause, waitingFor } from "./failure.ts";
export { checkAddress, checkParams, identityKey } from "./params.ts";
export { canonicalJson, principalKey } from "./principal.ts";
export { check, validatorFor } from "./validator.ts";
