# 组 g24

状态：完成

## 完成文件

- packages/durable/src/testing/assertions.ts：完整；核对 `StorageConformanceAssertions`（types.ts）与 `ExpectLike`/`ExpectResult` 的映射关系，逐方法说明 `ok`/`strictEqual`/`deepEqual`/`partialDeepEqual`/`greaterThan`/`rejects` 对应的底层 expect 方法、`result(...) as ExpectResult` 的类型断言为何编译期擦除、`rejects` 必须 await；63 行新增、0 删除。
- packages/durable/src/testing/commit-writes.ts：完整；核对 `Storage.commit` 的单批包装（`[writes]`）、回执 `(_index, seq)` 同步记录、`result.stored === 0` 时抛出原始 `refused`、`stored!` 非空断言依赖 Storage 的“成功批次必回调一次”契约；41 行新增、0 删除。
- packages/durable/src/testing/env-conformance.ts：完整；核对 `ExecutionEnv`（env/index.ts）的 Result/`getOrThrow`、`BinaryReader`、`DirReader`、`watch`、`exec`、可选 `listFiles` 与符号链接能力；注释覆盖 `createEnvConformance` 默认值（`["sh","-c"]`、symlinks=true、listFiles=false）、`createCase`/`watchCase`（30s 超时）/`execCollect`/`watching` 辅助，以及 BinaryReader 范围读取与 scanLines（BOM、非法 UTF-8、重命名后继续读）、DirReader 分页/关闭/缺失路径/枚举中删除、watch 的创建/编辑器式 rename 替换/祖先目录隐式创建/递归新目录/父目录改名重建/排除项/重叠 target/幂等 stop 与 mode、exec 的 argv 免 shell 解析/双流/ cwd 与退出码/spawn 错误/window+skipped/timeout 与 abort 区分、listFiles 的深度优先与名称顺序/gitignore 与 .git/边界与 truncated/缺失与 abort/不跟随符号链接、以及 `noFollow` 对最终链接的拒绝；255 行新增、0 删除。
- packages/durable/src/testing/index.ts：完整；说明 `"./testing"` 子路径入口只做 re-export，按断言、单批写入、两套契约套件、runner、基准数据/场景/类型分组给出能力清单，并区分运行期值与 `export type`（编译后消失）；43 行新增、0 删除。
- packages/durable/src/testing/runner.ts：完整；核对最小 runner 接口 `StorageConformanceRunner`（describe/expect/it，it 支持可选超时）、`registerStorageConformance` 中 `createExpectAssertions` 与 `withStorage` 的连接、`registerEnvConformance` 用 `Pick<EnvConformanceOptions, "shell" | "symlinks" | "listFiles">` 限制能力开关并继续传递 `timeoutMs`；52 行新增、0 删除。
- packages/durable/src/testing/storage-benchmark.ts：完整；核对 `StorageBenchmarkScale`/`STORAGE_MEMORY_SCALES`（1k/10k）、`TIMING_SCALE`（1k 条目/300 任务/300 文档）、`storageBenchmarkPrimaryRecordCount`、`seedStorageBenchmark` 的分批（BATCH_SIZE=100）与全局 ID、首条目 head、确定性 replay 尾部、跨新 base 的历史文档、8 层 fork 链 × 32 条目，以及读写场景的 `run()`/`expected()`；修正“start 是批内第一条的下标”为“该批第一条在全部条目中的全局下标”；162 行新增、0 删除。
- packages/durable/src/testing/storage-conformance.ts：完整；核对 `Storage`（types.ts）的 commit/回执/记录/文档/扫描契约，以及 Chord delta `Op` 的 `r`/`s`/`d`/`a`/`t`/`p`/`m` 语义；注释覆盖文件头、`createRoot`/`pendingTask`/`entry`/`ConformanceTest`/`Identified`/`AssertionResult`/`assertionFacade`/`checkReceipts`（Proxy 包装 commit，检查回执同步、index 对齐、seq 严格递增、数量匹配）/`createCase`（每次 withStorage 新存储），以及全部 32 个用例：根会话 ID、回执、批次原子性、写入与返回记录的双向脱离、原型键（`__proto__`/`constructor`）、乱序 ID/游标、owner 过滤、fork 历史段与 head、表扫描、任务、提交、文档 base/delta/copy/retire 与历史读、副本独立 base、生命周期原子性与空生命周期、逻辑地址与精确 scope 扫描、全局 ID 命名空间与耗尽、多批顺序/部分拒绝/自身非法批次/同批内 copy 源解析、close 后拒绝；523 行新增、0 删除。
- packages/durable/src/testing/types.ts：完整；说明纯类型模块（编译后为空）、`StorageConformanceAssertions` 六方法、`StorageConformanceProvider` 与 `EnvConformanceProvider` 的“每次 use 一次、全新资源、结束后清理”运行期契约、`StorageConformanceOptions`/`EnvConformanceOptions`（shell/symlinks/listFiles 默认值归 env-conformance 所有）、`StorageConformanceCase`/`EnvConformanceCase`（可选 timeoutMs）；56 行新增、0 删除。

验证：

- 8 个文件 `git diff --numstat` 均为 0 删除，仅插入注释行（63/41/255/43/52/162/523/56 行新增，共 1195 行）。
- 逐行检查 8 个文件 diff 的新增行：全部以 `//` 注释开头，没有非注释新增行。
- `git diff --check` 对 8 个文件无输出（退出码 0），无空白错误。
- 缩进检查：插入后对以 `//` 开头的连续注释块做“与下一条代码行同缩进”的扫描，修正并复检后无列 0 注释块紧跟缩进代码的残留。
- 在 packages/durable 下运行 `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/memory-storage.test.ts test/env-node-conformance.test.ts`：2 个文件、85 个测试通过（vitest 4.1.12，约 4.8 秒）。
- 每个文件头均包含所属包/模块、职责边界与上下游、按导出项的能力清单、典型调用示例、建议阅读顺序；类型说明区分编译期检查与运行期校验/契约。

## 未完成或风险

- 无未完成文件。
- 按要求未运行 `npm run check`、`npm run build`、全仓格式化；类型与格式的全局验证需在汇总阶段执行。
- 未运行全量测试；所跑测试覆盖 storage 契约与 Node 环境契约路径，storage-benchmark.ts 的注释修改未单独跑基准（bench 文件不做计时验证）。
- 未修改覆盖清单、进度、日志或其他代理报告；未执行 git add/commit/push。
