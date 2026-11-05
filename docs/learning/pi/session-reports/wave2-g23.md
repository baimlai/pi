# 组 g23

状态：完成

## 完成文件
- packages/durable/src/codemode/codemode.ts：完整；核对了 @earendil-works/pi-codemode/portable 的 CodemodeResult/CodemodeOutputItem/CodemodeHostCall、Harness ToolExecutionApi/commit/tx.doc、CodemodeSandboxBase 的 start/onCall/onIdle/deliver、NestedCallDoc/ToolTaskInput；详细导读 + 常量/类型/类字段/execute/回调链/辅助函数注释。验证：esbuild 解析通过；git diff 仅新增注释行（330 增 0 删）。
- packages/durable/src/codemode/describe.ts：完整；核对了 CodemodeNamespace、Codemode 工具声明与 CatalogEntry、rankDocuments/BM25 调用点；导读 + 各函数注释。验证同上（75 增 0 删）。
- packages/durable/src/codemode/index.ts：完整；核对导出清单与 harness/define 的 Extension 类型；导读与逐项导出注释。验证同上（21 增 0 删）。
- packages/durable/src/codemode/models.ts：完整；核对 MODEL_CALLS/CATALOG_GLOBALS、模型目录、classify/generateImages 上下文校验与 resolveModel；导读 + 逐函数注释。验证同上（94 增 0 删）。
- packages/durable/src/codemode/output.ts：完整；核对 CodemodeOutputItem/CodemodeResult、formatResult 的调用参数（OUTPUT_LIMITS、outputFiles）与 truncate/saveImages 行为；导读 + 逐函数注释。验证同上（86 增 0 删）。
- packages/durable/src/tools/bash.ts：完整；核对 ExecutionEnv.exec、ToolExecutionApi.output/retainedOutput、DEFAULT_MAX_BYTES/LINES 与 PowerShell 参数；导读 + schema/类型/validateTimeout/prepareExecution/runCommand/两个工厂注释。验证同上（98 增 0 删），tools.test.ts 覆盖。
- packages/durable/src/tools/edit-diff.ts：完整；核对 diff 包的 diffLines/createTwoFilesPatch、edit.ts 的调用顺序与 ExecutionEnv 无关的纯函数边界；导读 + 所有导出/内部函数注释。修正了 6 行误写成字面 \uXXXX 的中文注释，恢复为可读中文。验证同上（155 增 0 删），tools.test.ts 覆盖。
- packages/durable/src/tools/edit.ts：完整；核对 pi-schema 的 obj/arr/str、ToolRegistration、ExecutionEnv.fileInfo/readTextFile/writeFile 与 edit-diff 返回值；导读 + prepareArguments/校验/execute 注释。验证同上（79 增 0 删），tools.test.ts 覆盖。
- packages/durable/src/tools/env.ts：完整；核对 ToolExecutionApi.env 与 ExecutionEnv；导读 + requireEnv 注释。验证同上（21 增 0 删）。
- packages/durable/src/tools/file-mutation-queue.ts：完整；核对 ExecutionEnv.absolutePath/canonicalPath/joinPath 的 Result 语义；导读 + 队列键/递归规范化/入队释放逻辑注释。验证同上（48 增 0 删）。
- packages/durable/src/tools/image-processor.ts：完整；核对 read.ts 对 ImageLimits/PreparedImage/INLINE_IMAGE_TYPES/toBase64/base64Length 的使用；导读 + 类型/编码函数注释。验证同上（35 增 0 删），tools-images.test.ts 覆盖。
- packages/durable/src/tools/image.ts：完整；核对 read.ts 的 ByteSource 适配、PNG/JPEG/GIF/WebP/BMP 头解析与 APNG 排除；导读 + 检测/尺寸/字节读取函数注释。保留了原有英文注释行。验证同上（97 增 0 删），tools-images.test.ts 覆盖。
- packages/durable/src/tools/index.ts：完整；核对 createReadTool/createWriteTool/createEditTool/createBashTool 组合与 defineExtension；导读 + 导出项/工厂注释。验证同上（35 增 0 删）。
- packages/durable/src/tools/path-utils.ts：完整；核对 ExecutionEnv.absolutePath/exists、getOrThrow 与 read/write/edit 调用点；导读 + normalizeToolPath/resolveToolPath/resolveReadToolPath 注释。验证同上（36 增 0 删）。
- packages/durable/src/tools/read.ts：完整；核对 LineScan、truncateHeadOf、scanLines、DEFAULT_MAX_LINES/BYTES、ImageProcessor/ImageModel 与 openBinaryReader；导读 + execute/readImage/imageModel/readText/readHead/sliceIndex 注释。验证同上（126 增 0 删），tools.test.ts、tools-images.test.ts、tools-read-differential.test.ts 覆盖。
- packages/durable/src/tools/write.ts：完整；核对 writeSchema、ToolRegistration、withFileMutationQueue 与 ExecutionEnv.writeFile；导读 + execute 流程注释。验证同上（35 增 0 删），tools.test.ts 覆盖。

统一验证：
- 16 个文件均通过 `./node_modules/.bin/esbuild <file> --format=esm` 语法解析。
- `git diff --numstat` 显示 16 个文件全部为 0 删除；过滤 diff 后新增行只有注释和分隔空行，没有改动原代码。
- 16 个文件头均含：所属包/模块、职责边界、上游/下游、能力清单、示例、建议阅读顺序。

测试（在 packages/durable 下运行）：
- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/tools.test.ts`：1 文件、35 通过、1 跳过。
- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/tools-images.test.ts test/tools-read-differential.test.ts test/codemode-describe.test.ts test/codemode-models.test.ts test/codemode-checkpoints.test.ts test/codemode.test.ts test/env-line-scan.test.ts test/env-truncate.test.ts test/tool-args-typebox.test.ts test/tool-search.test.ts`：10 文件、111 通过、0 失败。

## 未完成或风险
- 无未完成文件。
- 会话中途 `packages/durable/src/types.ts:545` 曾缺少接口结束括号导致所有聚焦测试无法加载；该文件不在本组允许修改清单内，未修改。该问题在本次收尾前已由其他工作修复，上述测试随后全部通过。
- 按任务要求未运行 `npm run check`、`npm run build`、全仓格式化、git add/commit/push、npm install。
