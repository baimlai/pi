# 组 g33

状态：完成

## 完成文件

- `/Users/baiml/PycharmProjects/pi/packages/evals/src/plan.ts`：完整。文件头覆盖 packages/evals 计划层、上下游（cli.ts → plan.ts → docker.ts/report.ts）、7 项能力清单、示例与阅读顺序。逐项注释 DOCUMENTATION_VARIANTS、DocumentationVariant、DiscoveredEvalCase、EvalTask、isRecord、parseDiscoveredCases、createTaskPlan。核对了 `test/plan.test.ts` 对发现结果解析、重复身份拒绝和交替变体顺序的断言。`git diff --numstat`：81 行新增，0 删除。
- `/Users/baiml/PycharmProjects/pi/packages/evals/src/cli.ts`：完整。文件头覆盖 CLI 编排入口、参数/环境变量、产物目录布局、与 docker/plan/report 的分工、5 项能力清单、示例与阅读顺序。注释 parseEvalCli、artifactRunId、containerPath、normalizeDiscoveredFile、compareDiscovery 及顶层 buildImages/discoverCases/runTask/summarizeEvalObservations 流程。核对了 `package.json` 的 `eval:docs` 入口、docker.ts 与 report.ts 的实际签名。修正了文件头中 `tasks/*/vitest.json` 会被块注释内 `*/` 提前闭合的问题，改为 `tasks/<hash>/vitest.json`。`git diff --numstat`：126 行新增，0 删除。
- `/Users/baiml/PycharmProjects/pi/packages/evals/src/docker.ts`：完整。文件头覆盖 Docker 执行层、`--read-only`/tmpfs/挂载边界、上下游、11 项能力清单、示例与阅读顺序。注释 execute、requireSuccess、buildImages、environment、requireEvalAuthFile、dockerArgs、createDockerContext、discoverCases、taskDirectoryName、runTask；核对了 `docker/entrypoint.ts`、`docker/Dockerfile` 与 report.ts 的路径约定。修正了任务名匹配格式（Vitest fullName 用空格连接，discovery 用 ` > `）与认证文件降权归属。`git diff --numstat`：117 行新增，0 删除。
- `/Users/baiml/PycharmProjects/pi/packages/evals/src/harness.ts`：完整。文件头覆盖 harness 适配层、隔离/认证/降权职责、上下游、13 项能力清单、示例与阅读顺序。注释输入与选项类型、resolveModelSelection、applyIsolatedEnvironment、parseSandboxId、resolveSandboxIdentity、chownTree、protectTransformedModules、enterToolSandbox、toTranscriptEvents、seedWorkspace、promptAgent、verifySystemPrompt、runPiCodingAgent、createPiCodingAgentHarness、DOCUMENTATION_EVAL_TOOLS、resolveDocumentationVariant、excludePiDocumentation、两个文档 harness 类型与 createPiDocumentationEvalHarness。核对了 `test/harness.test.ts`、`vitest-evals/harness.d.ts`、pi-coding-agent 的 ModelRuntime/SessionManager/AgentSession 类型、docker/entrypoint.ts 的 `PI_EVAL_CONTAINER` 与沙箱变量。保留并补充说明了原有两行英文注释。`git diff --numstat`：227 行新增，0 删除。
- `/Users/baiml/PycharmProjects/pi/packages/evals/src/report.ts`：完整。文件头覆盖报告层职责（读取 Vitest JSON、配对观测、汇总与格式化）、上下游、全部导出类型/函数清单、示例与阅读顺序。注释 PI_SESSION_SNAPSHOT_ARTIFACT、EvalRunIdentity、ExpectedEvalRun、EvalMetrics、EvalObservation、PairedMetricSummary、EvalSetComparison、BlockedPair、OperationalMetricTotal、VariantTotals、EvalComparisonReport、optionalMetric、validateScore、classifyCaseStatus、taskIdentity、erroredObservation、persistSession、readTaskObservation、Pair/PairGroup、mean、difference、pairKey、groupPairs、resolvePair、summarizeMetric、operationalTotal、variantTotals、comparisonFlags、summarizeEvalObservations、percentage、signed、pairedMetric、operationalMetric、formatEvalComparisonReport。核对了 `test/report.test.ts`、`test/comparison.test.ts` 与 `@vitest-evals/core` 的 ReportCase 状态类型；修正了 persistSession 写盘失败会向外抛、difference 的浮点示例等不准确描述。`git diff --numstat`：177 行新增，0 删除。

### 验证

- 只加注释：对 5 个文件运行 `git diff -U0 ... | grep '^-[^-]' | wc -l`，结果为 0，确认没有删除或改写任何原有代码行；`git diff --numstat` 显示全部为新增。
- 语法检查：`node --experimental-strip-types --check` 逐个检查 5 个文件，均输出 OK（Node v26.9.0）。
- 离线单元测试（packages/evals 根目录）：
  `node /Users/baiml/PycharmProjects/pi/node_modules/vitest/dist/cli.js --config vitest.test.config.ts --run test/plan.test.ts test/report.test.ts test/comparison.test.ts test/harness.test.ts`
  结果：4 个测试文件、36 个测试全部通过，耗时 2.08s。
- 按任务要求未运行 `npm run check`、`npm run build`、全仓格式化、`npm install` 或任何 Git 写操作。

## 未完成或风险

- `cli.ts` 与 `docker.ts` 没有可离线运行的单元测试：它们分别依赖顶层进程编排、Docker CLI、镜像构建和真实 provider 凭据。只做了 Node 语法检查，未实际执行 Docker 流程。
- `harness.ts` 的容器降权、`protectTransformedModules` 与 `PI_EVAL_CONTAINER` 守卫属于集成路径，`test/harness.test.ts` 只覆盖可在本机验证的纯函数/环境检查；这些路径未在本轮实际运行。
- 所有改动均为注释，未改变行为；但因未运行 `npm run check`，没有做 TypeScript 类型检查（任务禁止）。
