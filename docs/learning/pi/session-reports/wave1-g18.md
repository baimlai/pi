# 组 g18

状态：完成

## 完成文件

- packages/chord/src/store/table.ts：完整；核对 columns.ts 的 describeColumns/columnRecord/OrderColumn、expression.ts 的 columnRefs、rows.ts 的 RowCodec、table-history.ts 的 Migration；覆盖声明检查（表名/版本/主键/索引）、指纹与排序、TableDefinition 字段与构造流程；文件头含能力清单、调用顺序、defineTable 示例与阅读顺序。`git diff --numstat` 82 增 0 删。
- packages/chord/src/store/table-history.ts：完整；核对 catalog.ts 的 TableRecord、table.ts 的 TableDefinition；覆盖 TableEdit/AlterEdit/DataStep/Migration/TablePlan 与 planTable 的 create/ready/migrate/拒绝分支；文件头含示例与阅读顺序。50 增 0 删。
- packages/chord/src/store/table-evolve.ts：完整；核对 contracts/internal.ts 的 editWith/Increment、contracts/schema.ts 的 Optional/isOptional、expression.ts 的 compileWhere/compileSet、table.ts 的 INDEX_NAME/orderColumns/TableDefinition；覆盖编辑顺序、类型工具、Editor 运行时校验与 finish 物化；文件头含能力清单、示例与阅读顺序。109 增 0 删。
- packages/chord/src/store/table-handle.ts：完整；核对 query.ts 的 Query/decodeCursor/encodeCursor、sql.ts 的 TableSql、store.ts 的 ChordStore、table.ts 的 KeyOf/TableDefinition、rows.ts 解码约定；覆盖 page/rows/get/count、版本栅栏、owner 失败与查询归属检查；文件头含能力清单、示例与阅读顺序。72 增 0 删。
- packages/chord/src/store/table-writes.ts：完整；核对 step.ts 的 StagedWrite/Step、sql.ts 的 DDL 渲染、rows.ts 的 versionColumn/EncodedRow、table-history.ts 的 TableEdit/AlterEdit；覆盖 TableWrite 各变体、json 版本记录、stage* 与 applyTable/applyIndex/applyDropIndex/applyAlter；文件头含能力清单、示例与阅读顺序。80 增 0 删。
- packages/chord/src/store/table-migration.ts：完整；核对 table-history.ts 的 planTable/TablePlan/DataStep、table-writes.ts 的 stage*/jsonVersions/recordedVersions、rows.ts 的 encodeCell/ROW_VERSION、store.ts 的 ChordStore/CommitFence、context 的 withoutAbortSignal；覆盖建表、逐版本 (A)/(Z)、update/rows 数据步骤、分块分页、macrotask、patchRow 校验与提交路径；文件头含能力清单、示例与阅读顺序。94 增 0 删。
- packages/chord/src/store/text.ts：完整；核对 rows.ts/columns.ts/import.ts/keyed-slot.ts 的 storedText 调用、evaluate.ts/keyed-slot.ts 的 compareText、sql.ts 的 prefixUpperBound 调用，以及 data/errors.ts 的 invalid 构造；覆盖码点比较、代理项排名、NUL/孤立代理项处理、前缀上界；文件头含能力清单、示例与阅读顺序。71 增 0 删。
- packages/chord/src/store/writes.ts：完整；核对 engine.ts 的 DocumentWrite 与 table-writes.ts 的 TableWrite；本文件仅导出 StoreWrite 类型，注释说明类型擦除、outbox/归档重放与信任边界；文件头含能力清单、示例与阅读顺序。30 增 0 删。

统一验证：

- 全部 8 个文件 `git diff --numstat` 均为新增行、0 删除；逐文件 `git diff | grep '^-'` 无删除侧代码行。
- `git diff --check` 退出码 0，无空白错误。
- 运行命令（在 packages/chord 下）：
  `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/store/table.test.ts test/store/table-history.test.ts test/store/table-evolve.test.ts test/store/table-handle.test.ts test/store/table-writes.test.ts test/store/table-migration.test.ts test/store/text.test.ts`
- 结果：7 个测试文件通过，78 个测试通过（Vitest 4.1.12，约 0.7s）。

## 未完成或风险

- 无未完成的分配文件。
- writes.ts 是纯类型模块，没有独立测试；其形状由 table-writes/engine/import 等调用方间接覆盖，未单独运行类型检查（任务禁止 `npm run check`）。
- 按任务约束未运行 `npm run check`、`npm run build`、全仓格式化或完整测试套件；只运行了上述离线定向测试。
- 注释只使用中文说明，未改动任何代码行、缩进、字符串或类型定义。
