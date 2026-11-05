# 组 e19

状态：完成

## 完成文件

- scripts/local-package-install.mjs：完整；核对 npm-command.mjs、package-artifacts.mjs、coding-agent-smoke.mjs 的导出签名，以及 npm 的 `file:` 依赖、npm overrides 与 pnpm-workspace.yaml overrides 行为；`git diff --numstat` 为 130 增 0 删；由 local-package-install.test.mjs 覆盖。
- scripts/local-package-install.test.mjs：完整；核对 fixture 包结构与三个测试的断言；`node --test scripts/local-package-install.test.mjs` 通过 3 项（使用真实 npm 与 pnpm 创建隔离消费者）。
- scripts/local-release.mjs：完整；核对 scripts/build-binaries.sh 的 `--skip-install/--skip-build/--platform/--out` 参数、根 package.json 的 `release:local`、test.sh 与 coding-agent-smoke.mjs；`node scripts/local-release.mjs --help` 退出 0；`node --check` 通过；未运行完整发布流程（见风险）。
- scripts/model-catalog-minimum-version.mjs：完整；核对 update-model-catalog-pin.mjs 并不读取该常量、check-model-catalog-compat.mjs 的读取方式；`node --check` 通过。
- scripts/model-catalog-protocol.test.ts：完整；核对了六个测试组、fixture 索引与 #9099 回归场景；包含在合并测试运行的 21 项中全部通过。
- scripts/model-catalog-protocol.ts：完整；核对 publish-model-catalog.mjs 与 check-model-catalog-compat.mjs 的实际调用，以及 URL、User-Agent、`types` 参数与 semver 比较语义；合并测试运行通过。
- scripts/npm-audit.mjs：完整；核对 npm audit `--json` 输出结构、严重级别阈值、allowlist 与 `::warning::` 注解；用假的 npm 可执行文件验证：干净结果退出 0、高危漏洞退出 1、非法 JSON 退出 1；`node --check` 通过。
- scripts/npm-command.mjs：完整；核对 Windows 上 `npm_execpath` 与 `process.execPath` 的启动差异及 CI 调用方；`node --check` 通过。
- scripts/pack-packages.mjs：完整；核对 package-artifacts.mjs 的 produceArtifactSet 参数、package-files.mjs 的 CLI 约定；`node scripts/pack-packages.mjs --help` 退出 0；在临时 fixture 仓库中实际打包，生成了 manifest.json 与 tarball 后已删除 fixture；`node --check` 通过。
- scripts/package-artifact-cli.test.mjs：完整；核对三个 CLI 的“参数错误应在做事之前失败”断言；合并测试运行通过。
- scripts/package-artifacts.mjs：完整；核对 release-packages.mjs 的 getPublicWorkspacePackages、npm-command.mjs 的 execNpmSync、npm 10/11/12 的 `npm pack --json` 输出差异、SRI 完整性校验与输出目录保护；合并测试运行通过；`node --check` 通过。
- scripts/package-artifacts.test.mjs：完整；核对内容寻址、脏工作区、完整性篡改与危险输出路径四类测试；合并测试运行通过。
- scripts/package-files.mjs：完整；核对 clean/copy/executable 三种模式、glob 展开与 chmod 语义；合并测试运行通过；`node --check` 通过。
- scripts/package-files.test.mjs：完整；核对五个测试组及 Windows 权限跳过分支；合并测试运行通过。
- scripts/preview-packages.mjs：完整；核对 .github/workflows/ci.yml 的 pack 步骤、preview-packages.yml 的 publish/delete-ref 任务、GitHub OIDC token 请求、worker 的 refs 与 upload 响应；合并测试运行通过；`node --check` 通过。
- scripts/preview-packages.test.mjs：完整；核对本地 HTTP 服务器模拟 worker/OIDC、pack 清单恢复、refs 并发更新与非 JSON 响应场景；合并测试运行通过。
- scripts/profile-coding-agent-node.mjs：完整；核对根 package.json 的 `profile:tui`/`profile:rpc`、packages/coding-agent/src/main.ts 中 `PI_STARTUP_BENCHMARK` 的 150ms 终端查询等待、core/timings.ts 的启动计时输出与 rpc-types.ts 的 get_state 响应；`node scripts/profile-coding-agent-node.mjs --help` 退出 0；未运行完整基准（见风险）；`node --check` 通过。
- scripts/publish-model-catalog.mjs：完整；核对 publish-model-catalog.yml、aws CLI 调用、publication.json 结构、协议模块的索引校验与 S3/R2 上传顺序；合并测试运行通过；`node --check` 通过。

合并测试运行：`node --test scripts/model-catalog-protocol.test.ts scripts/package-files.test.mjs scripts/package-artifact-cli.test.mjs scripts/package-artifacts.test.mjs scripts/preview-packages.test.mjs scripts/publish-model-catalog.test.mjs` → 21 项通过，0 失败。

所有 18 个文件的 `git diff --numstat` 均为 0 删除，只有注释新增；原始英文文档、字符串、类型、默认值与代码缩进保持不变。4 个 CLI 的 shebang 均在文件第 1 行。

## 未修改的数据/配置文件

- 无。本组清单只包含 `.mjs` 与 `.ts` 源码/测试，没有 JSON、YAML 或其他数据配置文件需要加注释。

## 未完成或风险

- scripts/profile-coding-agent-node.mjs：未运行完整 TUI/RPC 基准。需要先构建 packages（`npm run build`）并在 TTY 中启动 coding-agent，超出本组允许的快速离线验证范围。
- scripts/local-release.mjs：未运行完整发布演练。会执行 clean/build、`npm run check`、`./test.sh`、构建 Bun 二进制并联网安装依赖，耗时且会改动构建产物。
- scripts/npm-audit.mjs：未对真实 registry 运行。仅用假 npm 覆盖干净、高危、非法 JSON 三种退出路径，网络与真实 advisory 数据未验证。
- scripts/preview-packages.mjs、scripts/publish-model-catalog.mjs：只在测试的本地模拟服务/假 aws 路径上验证，未对真实 pkg.earendil.com、GitHub OIDC、S3/R2 运行。
