# 组 e20

状态：完成

## 完成文件

- scripts/publish-model-catalog.test.mjs：完整；核对被测脚本 scripts/publish-model-catalog.mjs 的 `--dry-run`、临时目录输入包与 publication.json 计数结构；`git diff --numstat` 为 54 增 0 删；`node --test scripts/publish-model-catalog.test.mjs` 通过 1 项。
- scripts/publish-release-announcement.mjs：完整；核对 `aws s3api put-object`、npm registry/tarball 请求、`--if-match`/`--if-none-match: *` 条件写与 latest.json 推进顺序；`git diff --numstat` 为 157 增 0 删；未运行（见风险）。
- scripts/publish-release-announcement.test.mjs：完整；核对 `compareReleaseVersions`、`advanceLatestRelease` 的注入式 readLatest/writeLatest 与 4 个断言组；45 增 0 删；`node --test` 通过 4 项。
- scripts/publish.mjs：完整；核对 package-artifacts.mjs、release-packages.mjs、npm-command.mjs 的导出契约、`npm view` 404 判定与 provenance 发布循环；46 增 0 删；未运行（见风险）。
- scripts/read-tool-stats.mjs：完整；核对 JSONL 的 assistant usage/toolCall 记录、read 的 offset/limit 判定与按时区聚合；134 增 0 删；`--help` 退出 0，临时 fixture `--text` 退出 0（1 条 partial read）。
- scripts/release-notes.mjs：完整；核对 `gh api --paginate`、`gh release edit`、CHANGELOG 段落提取与链接归一化；145 增 0 删；`--help` 退出 0，`extract --version 1.5.0 --tag v1.5.0 --out /tmp/e20-release-notes.md` 退出 0（113 行）。
- scripts/release.mjs：完整；核对 git/npm/./test.sh 子进程、`PI_RELEASE_SKIP_TESTS`、update-model-catalog-pin 导入与 commit/tag/push 顺序；131 增 0 删；`node --check` 通过，无参数运行按预期打印用法并退出 1；未运行完整流程（见风险）。
- scripts/repro-5893-wsl-bash.mjs：完整；核对 createBashTool 的 `shellPath` 覆盖与两条 WSL 命令的字符串断言；19 增 0 删；`node --check` 通过；非 Windows 平台未运行是脚本自身的设计。
- scripts/session-context-stats.mjs：完整；核对 session JSONL 的 usage/compaction/toolCall、模型 contextWindow 读取与日/模型聚合；106 增 0 删；`--help` 退出 0，临时 fixture `--text` 退出 0。
- scripts/session-transcripts.ts：完整；核对 parseSessionEntries、cwd 目录编码、子代理 JSON 事件与 split/analyze 流程；100 增 0 删；用不存在的 cwd 运行，按预期以 1 退出并输出 "No sessions found"；`--analyze` 会启动外部 pi，未运行。
- scripts/smoke-test-codemode-binary.mjs：完整；核对本地假 OpenAI 流式服务、worker marker 往返、30 秒超时与 spawn/清理；51 增 0 删；无参数运行按预期打印用法并退出 1；完整二进制冒烟未运行（需要已构建二进制）。
- scripts/stats.ts：完整；核对 assistant usage 字段、`--sessions-base`/`-n`/`-d` 参数与按本地日历天聚合；59 增 0 删；`--help` 退出 0，临时 fixture 统计运行退出 0。
- scripts/sync-versions.test.mjs：完整；核对 spawnSync 调用 scripts/sync-versions.js、临时 workspace 夹具与两个版本断言组；47 增 0 删；`node --test` 通过 2 项。
- scripts/tool-stats.ts：完整；核对 toolCall/toolResult 配对、结果 token 估算、BUCKETS 直方图与单文件 HTML 输出；64 增 0 删；`--help` 退出 0；完整 HTML 生成未运行（会写文件并打开浏览器）。
- scripts/update-model-catalog-pin.mjs：完整；核对 pi.dev `/api/models` 与不可变 revision URL、`sha256-<hex>` 内容寻址、hydrate 验证与 nix/model-catalog.json 写入；78 增 0 删；`node --check` 通过，相关测试 12 项通过；CLI 未运行（见风险）。
- scripts/update-model-catalog-pin.test.mjs：完整；核对 globalThis.fetch mock、五种目录变体与 hydrate/分组/哈希断言；78 增 0 删；`node --test` 通过 12 项。
- scripts/update-source-imports-to-ts.sh：完整；核对 find 深度限定、NUL 分隔管道与 perl 三条原地替换规则；26 增 0 删；`bash -n` 通过；未运行（见风险）。
- scripts/use-local-packages.mjs：完整；核对 readArtifactSet 的 manifest/integrity 校验与 wireConsumer 的 package.json 改写；32 增 0 删；`node --check` 通过，`--help` 退出 0；未运行改写入路径（见风险）。

合并测试运行：`node --test scripts/publish-model-catalog.test.mjs scripts/publish-release-announcement.test.mjs scripts/sync-versions.test.mjs scripts/update-model-catalog-pin.test.mjs` → 19 项通过，0 失败。

所有 18 个文件的 `git diff --numstat` 均为 0 删除，只有注释新增；原始英文文档、代码行、字符串、类型、默认值与缩进保持不变。

## 未修改的数据/配置文件

- 无。本组清单只包含 `.mjs`、`.ts` 与一个 `.sh` 源码/测试，没有 JSON、YAML 或其他数据配置文件需要加注释；未改动 `nix/model-catalog.json`、`packages/ai/src/models.generated.ts`、各包 CHANGELOG、package.json 或 lockfile。

## 未完成或风险

- scripts/release.mjs：未运行完整流程。它会修改版本号、写 CHANGELOG、构建、跑检查与测试，并直接 git commit/tag/push，且没有 dry-run；只验证了语法和参数错误路径。
- scripts/publish.mjs：未运行真实发布。非 dry-run 会向 npm 发布包并清理 provenance，属于不可逆外部副作用；只在源码层核对了幂等跳过逻辑。
- scripts/publish-release-announcement.mjs：未运行。会向 Cloudflare R2 条件写发布对象并推进 latest.json，需要 CI 凭据与真实 npm 包；测试只覆盖纯逻辑。
- scripts/release-notes.mjs：只运行了只读的 `extract`；`fix-github-releases` 会改写真实 GitHub Release，未运行。
- scripts/update-model-catalog-pin.mjs：CLI 未运行。会访问 pi.dev 并覆盖写 nix/model-catalog.json；离线测试已覆盖 12 个决策分支。
- scripts/update-source-imports-to-ts.sh：未运行。perl -i 会原地改写 packages/*/src 下所有 .ts，没有备份与 diff 预览；只做了 `bash -n`。
- scripts/use-local-packages.mjs：未运行非帮助路径。它会改写外部消费项目的 package.json；只验证了 `--help` 与语法。
- scripts/smoke-test-codemode-binary.mjs：未运行完整冒烟。需要先构建 pi 二进制；本次只验证无参数用法。
- scripts/tool-stats.ts：未生成 HTML。会写输出文件并调用系统浏览器，超出本组快速离线验证范围；`--help` 已验证。
- scripts/session-transcripts.ts：未运行 `--analyze`。它会 spawn 外部 `pi` 进程并可能产生费用；仅验证了无会话时的退出码。
- scripts/read-tool-stats.mjs、scripts/session-context-stats.mjs、scripts/stats.ts：只用合成 fixture 验证了输出路径，未对真实会话语料运行。
