# 组 e18

状态：完成（26 个文件已注释并复核；1 个 `.gitignore` 按规则保持原样）

## 完成文件

- scripts/agent-treeshake-smoke-entry.ts：完整；核对 check-browser-smoke.mjs 的 esbuild 入口、metafile 断言，以及 pi-agent-core / pi-ai anthropic 子路径的真实导出；`node --check` 通过。仅构建期分析，未单独执行。
- scripts/auto-pi.sh：完整；核对 README 的符号链接安装方式、开发分支 `packages/coding-agent/dist/bundle/cli.js`、`find_stable_pi` 的 PATH 搜索与 `--stable`/`update` 分支；`bash -n` 通过；未实际执行（会 exec 启动 pi）。
- scripts/browser-smoke-entry.ts：完整；核对 check-browser-smoke.mjs 的三入口打包、schema/agent/chord 的公开导出与 `validateToolArguments`；`node --check` 通过。
- scripts/build-binaries.sh：完整；核对 .github/workflows/build-binaries.yml 的调用参数、Bun `--target` 平台映射、资源与原生 prebuilds 复制清单；`bash -n` 通过；未运行（会 `npm ci` 并长时间交叉编译）。
- scripts/build-coding-agent-bundle.mjs：完整；核对 packages/coding-agent 的 `npm run build` 调用链、esbuild 的 `build()`/插件/metafile、三个主入口与懒入口约定；`node --check` 通过；未运行（需先产出 dist）。
- scripts/check-browser-smoke.mjs：完整；核对三个 entry、esbuild 两次 `write:false` 与一次落盘、`/tmp/pi-browser-smoke-errors.log` 失败路径、供应商目录断言；`node --check` 通过；未运行完整打包检查（见风险）。
- scripts/check-entry-graphs.mjs：完整；核对各包 package.json `exports` 到 src 的映射、`BUDGETS` 的 maxFiles/forbid/allow/overrides 与正则扫描边界；`node scripts/check-entry-graphs.mjs` 实际运行输出 `Entry point graphs are within budget.`，退出 0。
- scripts/check-lockfile-commit.mjs：完整；核对 .husky/pre-commit 调用、`PI_ALLOW_LOCKFILE_CHANGE` 的 1/true/yes 判定、`HEAD:package-lock.json` 与索引 `:package-lock.json` 的区别、lockfileVersion 3 的 packages 结构；`node --check` 通过；未在真实 commit 中触发。
- scripts/check-model-catalog-compat.mjs：完整；核对 publish-model-catalog.yml 调用、`MINIMUM_PI_VERSION`、`compareModelCatalogPiVersions`、`hydrate-model-catalog.ts` 与 tsc 检查入口、`git archive v<release>` 前置；`node --check` 通过；未运行（需网络、npm registry 和本地版本标签）。
- scripts/check-package-install.mjs：完整；核对 `produceArtifactSet`、`installConsumer`、`smokeTestNpmConsumer`、`smokeTestCodingAgent` 的真实签名与 npm 打包/安装边界；`node --check` 通过；未运行（需先 build 并执行真实 `npm install`）。
- scripts/coding-agent-smoke.mjs：完整；核对 manifest `bin.pi`、`dist/cli.js --version`、30 秒超时、`PI_OFFLINE=1`/`PI_TELEMETRY=0` 与临时 HOME；由同目录测试间接覆盖。
- scripts/coding-agent-smoke.test.mjs：完整；核对 fixture 包结构、`produceArtifactSet({ build: false, source: null })` 不访问 Git 的原因、#9132 回归断言；`node --test scripts/coding-agent-smoke.test.mjs` 运行通过 2 项、0 失败（约 1.2 秒）。
- scripts/cost.ts：完整；核对会话目录编码规则、`<timestamp>_<uuid>.jsonl` 文件名、`usage.cost` 字段与两级汇总；`node scripts/cost.ts --help` 退出 0；`node --check` 通过；未读取真实会话数据。
- scripts/create-source-archive.sh：完整；核对 build-binaries.yml 调用、`hydrate:model-data` 前置、`git archive`/`--mtime`/`gzip -n` 确定性参数、`check-model-data` 自检；`bash -n` 通过；未运行（需已生成模型数据并会写归档）。
- scripts/diff-model-catalog.mjs：完整；核对 `packages/ai/catalog/generate.ts`、旧版 `scripts/generate-models.ts` 回退、`generate-thinking-capabilities.mjs` 调用、git worktree 清理；`node scripts/diff-model-catalog.mjs --help` 退出 0；`node --check` 通过。
- scripts/durable-browser-smoke-entry.ts：完整；核对 check-browser-smoke.mjs 对四个 Durable 公共入口与 `node.ts` 适配器排除的断言；`node --check` 通过。
- scripts/edit-tool-stats.mjs：完整；核对会话 JSONL 的 toolCall/toolResult 配对、`--auto-since-path` 默认值、`--json`/`--include-records` 输出；`node scripts/edit-tool-stats.mjs --help` 退出 0；`node --check` 通过；未分析真实会话。
- scripts/generate-coding-agent-install-lock.mjs：完整；核对根 lockfileVersion 3、install-lock 两个输出文件、安装脚本白名单与 `--check` 只读语义；`node scripts/generate-coding-agent-install-lock.mjs --check` 输出 `packages/coding-agent/install-lock is up to date.`，退出 0。
- scripts/generate-thinking-capabilities.mjs：完整；核对 `getSupportedThinkingLevels`、`thinkingLevelMap` 过滤规则与 diff-model-catalog.mjs 的调用方式；无参数运行按预期抛 Usage 错误、退出 1；`node --check` 通过；未对真实目录生成快照。
- scripts/issues/github.ts：完整；核对 `gh issue list` 的 JSON 字段、Corpus 搜索评分/IDF/短语加权、STOPWORDS 与 main.ts/triage.ts 调用；`node --check` 通过。
- scripts/issues/main.ts：完整；核对各环境变量、HTTP 路由与 `Triage` 方法、socket/port 分支、信号关闭；`node --check` 通过；未启动服务（会同步 GitHub 并调用模型）。
- scripts/issues/register.mjs：完整；核对 run.sh 的 `--import` 顺序与 node:module `register()` 的基准 URL；`node --check` 通过。
- scripts/issues/run.sh：完整；核对 `--conditions=source`、`--import ./scripts/issues/register.mjs`、`main.ts` 的参数顺序与 exec 语义；`bash -n` 通过；未执行（会启动 triage 服务）。
- scripts/issues/source-hooks.mjs：完整；核对 Node ESM resolve 钩子的 `module-typescript` format、`shortCircuit`、TypeScript 说明符改写与 register.mjs 的关系；`node --check` 通过。
- scripts/issues/triage.ts：完整；核对 pi-ai 的 `streamSimple`/usage、pi-durable 的 Harness/存储、Chord 依赖、SQLite schema、`StateDoc` 每 64 条 delta 的 checkpoint 规则；`node --check` 通过；未运行（需 GitHub token、模型凭据与 SQLite）。
- scripts/issues/ui.html：完整；核对 main.ts 的 `GET /` 与各 API 路由、localStorage 偏好、8 秒轮询与决策 POST；内联脚本单独抽出后 `node --check` 通过；未在浏览器中做交互验证。

通用核对：26 个改动文件的 `git diff --numstat` 除旧中文草稿注释的删改外只有新增注释；`git diff --check` 退出 0。逐文件删除侧审计显示 `github.ts`、`register.mjs`、`run.sh`、`source-hooks.mjs` 存在旧中文草稿注释的删除/改写（共 91 行），其中 `run.sh` 的 4 行是 shell `#` 注释，非代码行；非注释代码删除为 0。原始英文文档、字符串、类型、默认值与缩进未改。语法检查覆盖全部 `.ts`/`.mjs`（`node --check`）与 `.sh`（`bash -n`）。

## 未修改的数据/配置文件

- scripts/issues/.gitignore：只有一行 `data/`，由 Git 读取，用于忽略本地 triage 状态（`corpus.json`、`triage.sqlite`、`token`），防止把 GitHub token、会话数据与运行状态提交进仓库。该文件是配置而非可注释的教学源码，且本组规则要求不重写 `.gitignore`，因此保持原样并在本报告说明用途；`git status` 确认其未改动。

## 未完成或风险

- scripts/check-model-catalog-compat.mjs：未运行。需要访问 npm registry、下载并安装已发布 pi-ai、且本地存在 `v<release>` 标签；属于联网且较重的检查。
- scripts/build-binaries.sh、scripts/create-source-archive.sh、scripts/build-coding-agent-bundle.mjs、scripts/check-package-install.mjs、scripts/check-browser-smoke.mjs：未执行完整流程。它们需要先 `npm run build`、Bun/zip 工具链、已水合的模型数据或真实 `npm install`，超出本组允许的快速离线验证范围；仅完成 `bash -n`/`node --check` 与调用关系核对。
- scripts/agent-treeshake-smoke-entry.ts、scripts/browser-smoke-entry.ts、scripts/durable-browser-smoke-entry.ts：仅作为 esbuild 入口被分析，未单独运行（本身也不是可运行程序）。
- scripts/auto-pi.sh：未执行，避免实际启动 pi 或依赖当前构建产物；仅做 `bash -n`。
- scripts/cost.ts、scripts/edit-tool-stats.mjs：只验证了 `--help` 与解析逻辑，未读取 `~/.pi/agent/sessions` 下的真实会话，统计结果分支未被真实数据覆盖。
- scripts/diff-model-catalog.mjs、scripts/generate-thinking-capabilities.mjs：只验证了 `--help`/用法错误路径，未生成真实目录差异或思考能力快照（需要 worktree 与完整目录生成）。
- scripts/check-lockfile-commit.mjs：未在真实 `git commit` 钩子中端到端触发，只核对了 git ref 与分支逻辑；实际拦截/放行仍依赖 husky 环境。
- scripts/issues/main.ts、scripts/issues/run.sh、scripts/issues/triage.ts：未启动。运行会同步 GitHub、打开 SQLite 并调用配置的模型，需要 token/凭据与网络，不能在本次检查中安全执行。
- scripts/issues/ui.html：仅做了 HTML/内联 JS 语法检查，未在浏览器中验证轮询、筛选、快捷键与决策提交的实际交互。
- 按任务约束未运行 `npm run check`、`npm run build`、仓库级格式化、`npm test` 或完整 vitest；这些应由汇总方在所有并行注释完成后统一执行。
