# 组 g16

状态：完成

## 完成文件

- packages/chord/src/documents/address-source.ts：完整；核对 `Source`/`Batch` 的 `deliver`/`commit` 契约、delta `Prepared`/`Op` 形状与 `written` 的根替换判定（`prepared.base !== before` 或本批已退役）；注释覆盖 `NO_OPS`、`AddressSource` 的 `deliver`/`written`/`retired`/`replaced` 及帧重置规则；34 行新增、0 删除。
- packages/chord/src/documents/definition.ts：完整；核对 `defineState` 的声明期名称/版本检查、`snapshotSchema`/`hash64` 指纹、`validatorFor` 的 WeakMap 缓存与 `chord.data.validations` 计数，以及 `CommitPersistence`/`CheckpointInfo`/`CheckpointWhen` 的消费方；59 行新增、0 删除。
- packages/chord/src/documents/documents.ts：完整；核对 `Documents` 的 `#state`（open/sealed/ended）、`declare`/`check`/`hydrate`/`load`/`onLine`/`tx`/`fence`/`assertLive`/`assertAdmitted`/`fail`/`seal`/`settled`/`end`/`released`/`#cut`/`#add`/`#persistence` 与 `TransactionCancelled`、`Line`、`SealToken` 的调用关系；103 行新增、0 删除。
- packages/chord/src/documents/fence.ts：完整；核对 `SealToken` 的 ECMAScript 私有字段 `#sealed`、单向 `seal()` 与 `sealed` getter，以及 `Documents.fence`/`Transaction.cut` 的消费路径；16 行新增、0 删除。
- packages/chord/src/documents/handles.ts：完整；核对 `SingletonHandle`/`KeyedHandle`/`HandleOf` 与事务 `Tx` 的方法面；42 行新增、0 删除。
- packages/chord/src/documents/index.ts：完整；核对 `packages/chord/package.json` 的真实包名 `@earendil-works/chord`，修正示例；覆盖 `defineState`、`CommitPersistence`/`JsonObject`/`StateDefinition`、`HandleOf`/`KeyedHandle`/`SingletonHandle`、`Tx` 的导出性质（仅 `defineState` 是运行期值）；15 行新增、0 删除。
- packages/chord/src/documents/internal.ts：完整；核对内部导出面及 `host/attempt.ts`、`jobs/` 的消费方；逐导出注释齐全；18 行新增、0 删除。
- packages/chord/src/documents/keyed-slot.ts：完整；核对 `Access`/`SharedLoad`/`KEYS_PAGE`、`KeyedSlot` 的 `get`/`keys`/`watch`/`pin`/`ensure`/`source`/`load`/`cold`/`stored`/`stage`/`hydrate`/`adopt`/`retire`/`evict` 与 `Persistence.read/find/keys/stage`、`storedText`/`compareText`、`SealToken` 围栏；137 行新增、0 删除。
- packages/chord/src/documents/line.ts：完整；核对 `Line`/`#tail`/`acquire` 的串行队列语义与 `Documents.onLine`/`tx` 的使用方式；17 行新增、0 删除。
- packages/chord/src/documents/persistence.ts：完整；核对 `store/engine.ts` 的 `findDocument`/`loadDocument`/`listDocumentKeys`/`createDocument`/`changeDocument`/`retireDocument` 签名、`ChordStore.read`、`StoredDocument`/`DocumentContent` 与 `checkReadable`/`storedAfter`；64 行新增、0 删除。
- packages/chord/src/documents/residency.ts：完整；核对 `RETENTION_MS`/`GRANULE_MS`、插入序 `Map<Resident, number>`、每对象一个定时器与对象线上的清扫；44 行新增、0 删除。
- packages/chord/src/documents/slot.ts：完整；核对 `Track`/`Prepared`、`Persistence`、`AddressSource`、`SlotDefinition` 的 `check`/`assertVersion` 错误码（`released`/`not_ready`）与 `SingletonSlot` 的 `value`/`hydrate`/`load`/`stage`/`adopt`/`retire`/`drop`；72 行新增、0 删除。
- packages/chord/src/documents/transaction.ts：完整；核对 `store/refusal.ts` 的 `refusalOf`（CHECK → invalid/args，其余拒绝 → broken，store 错误原样）、`store/step.ts` 的 fence `{ admit, adopt }`、`batch.commit` 与 delta `Tracker.beginChange`/`adopt`；覆盖 `Transaction` 状态机（open → committing → stepping → committed/discarded）、`cut`、`#step`/`#refused`/`#adopt`/`settle`/`discard` 及 `checkFound`；172 行新增、0 删除。

验证：

- 全部 13 个文件 `git diff --numstat` 均为 0 删除，仅插入注释行。
- 注释缩进检查脚本 `/tmp/g16_check_indent.py` 运行后无缩进不一致输出。
- 在 packages/chord 下运行 `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/documents/address-source.test.ts test/documents/definition.test.ts test/documents/documents.test.ts test/documents/fence.test.ts test/documents/handles.test.ts test/documents/keyed-slot.test.ts test/documents/line.test.ts test/documents/persistence.test.ts test/documents/residency.test.ts test/documents/slot.test.ts test/documents/transaction.test.ts`：11 个文件、103 个测试通过（vitest 4.1.12，约 1.0 秒）。
- 每个文件头均包含所属包/模块、职责边界与上下游/错误流向、按导出项的能力清单、组合关系或典型调用顺序、真实签名示例、建议阅读顺序（index.ts 的示例使用真实包名 `@earendil-works/chord`）。

## 未完成或风险

- 无未完成文件。
- 按要求未运行 `npm run check`、`npm run build`、全仓格式化；类型与格式的全局验证需在汇总阶段执行。
- 测试仅覆盖 documents 层相关文件；跨层行为（host、jobs、store 引擎）通过阅读 callee 与既有测试确认，未额外运行其他层的测试。
- 未修改覆盖清单、进度、日志或其他代理报告。
