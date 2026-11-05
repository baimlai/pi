// Registries for Chord's layers: a host's record of each registry, its contributions and its values by version.

// 文件导读
// 所属包与模块：packages/chord/src/registries 的内部入口，供 Chord 的 host 与注册表层使用。
// 职责边界：只做 re-export，暴露记录、贡献和值源的实现；应用入口是 ./index.ts。
// 上游：host/root.ts 收到 provider 后调用 checkProvider/RegistryRecord.serve 等。下游：RegistryValueSource
// 接入状态层，最终被 watch 或运行时读取消费；报告进入 host 的 onError。
// 结果与错误流向：导入本文件不创建记录；运行期错误由 RegistryRecord 转为 RegistryError 上报。
// 能力清单：
// - ContributionContent（类型）：plain/json/native 三种贡献内容。
// - Contributor（类型）：plugin + 可选 type 的来源标识。
// - RegistryContribution（类）：单份贡献的跟随、适配与表项缓存。
// - checkProvider（函数）：provider 形状的信任边界检查。
// - RegistryError（联合类型）：记录层上报的五种错误。
// - RegistryRecord（类）：每 token 的运行时记录（提供者、贡献、合成、值源）。
// - RegistryValueSource（类）：某读者版本的合成值原生 source。
// - RegistryWaiter（接口）：等待值可用性变化的回调。
// 组合关系与典型调用顺序：checkProvider -> new RegistryRecord -> add(RegistryContribution) -> value(version)
// -> RegistryValueSource.start -> compose；host 关闭时 record.close -> value.close。
// 示例（真实签名）：const record = new RegistryRecord(name, batch, report, clock);
// record.serve(1, provider); record.add(contribution);
// 建议阅读顺序：registry.ts -> contribution.ts -> record.ts -> value.ts；本文件仅是索引。

// RegistryContribution 是插件提交的一份贡献的状态机（内容、跟随、适配、拒绝/失败去重）。
// Contributor/ContributionContent 只在编译期描述来源与内容形态。
export { type ContributionContent, type Contributor, RegistryContribution } from "./contribution.ts";
// checkProvider 在信任边界校验插件提交的 provider 形状；RegistryError 是记录层上报的判别联合；
// RegistryRecord 是每 token 的运行时记录（提供者、贡献、合成缓存、按版本的值源）。
export { checkProvider, type RegistryError, RegistryRecord } from "./record.ts";
// RegistryValueSource 是某个 registry 在某个读者版本上的值源，继承 FollowedSource；
// RegistryWaiter 描述等待某个版本出现/可用时注册的回调。
export { RegistryValueSource, type RegistryWaiter } from "./value.ts";
