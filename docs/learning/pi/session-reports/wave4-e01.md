# 组 e01

状态：完成

验证基线：24 个文件均只新增中文注释行；`git diff --unified=0 HEAD -- <paths>` 审计为 1058 行新增、0 行删除、0 行非注释新增。`esbuild` transform 检查 24/24 通过；模板字符串范围检查 0 处注释落入模板；闭括号前置注释检查通过。3 个直接相关测试共 15 个用例通过。

## 完成文件

- packages/coding-agent/examples/extensions/auto-commit-on-exit.ts：完整；核对 `session_shutdown`、`pi.exec` 的 `git status/add/commit`、`ctx.sessionManager.getEntries()`、`ctx.ui.notify`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/bash-spawn-hook.ts：完整；核对 `createBashTool`、`BashSpawnContext`、`pi.registerTool` 和覆盖后的 `execute`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/bookmark.ts：完整；核对 `pi.setLabel`、`ctx.sessionManager.getEntries()/getLabel()`、`ctx.ui.notify`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/border-status-editor.ts：完整；核对 `ctx.ui.setFooter/setWorkingVisible/setEditorComponent`、`CustomEditor`、`pi-tui` 的 `Component` 与宽度工具；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/built-in-tool-renderer.ts：完整；核对 `createReadStream` 等内置工具工厂、`pi.registerTool`、`Text`；测试 `tool-renderer-examples.test.ts` 通过。
- packages/coding-agent/examples/extensions/claude-rules.ts：完整；核对 `session_start`/`before_agent_start`、`findMarkdownFiles`、返回的 `systemPrompt`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/commands.ts：完整；核对 `pi.registerCommand`、`pi.getCommands()`、`ctx.ui.select/confirm/notify`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/confirm-destructive.ts：完整；核对可取消的 `session_before_switch`/`session_before_fork`、`ctx.ui.confirm/select`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/custom-compaction.ts：完整；核对 `session_before_compact`、`modelRegistry.find/complete`、`serializeConversation`、`CompactionResult`；测试 `compaction-extensions-example.test.ts` 通过。
- packages/coding-agent/examples/extensions/custom-footer.ts：完整；核对 `ctx.ui.setFooter`、`footerData.getGitBranch()`、`sessionManager.getBranch()`、`truncateToWidth`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/custom-header.ts：完整；核对 `ctx.ui.setHeader`、`getPiMascot`、`/builtin-header`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/debug-provider.ts：完整；核对 `pi.registerEntryRenderer`、`pi.appendEntry`、`provider_stream_event`/`message_end`/`turn_end`、`ctx.ui.setStatus`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/dirty-repo-guard.ts：完整；核对 `session_before_switch`/`session_before_fork`、`pi.exec` 的 `git status --porcelain`、`ctx.ui.select`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/dynamic-tools.ts：完整；核对 TypeBox schema、`normalizeToolName`、`pi.registerTool`、动态 `execute`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/entry-renderer.ts：完整；核对 `pi.appendEntry`、`pi.registerEntryRenderer<StatusCardData>`、`Box`/`Text`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/event-bus.ts：完整；核对 `pi.events.on/emit`、`ExtensionContext`、`ctx.ui.notify`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/file-trigger.ts：完整；核对 `fs.watch/readFileSync/writeFileSync`、`pi.sendMessage` 的 `triggerTurn`、`ctx.hasUI`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/git-checkpoint.ts：完整；核对 `tool_result`/`turn_start`/`session_before_fork`/`agent_settled`、`git stash create/apply`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/git-merge-and-resolve.ts：完整；核对 `agent_end`、`git rev-parse/status/fetch/merge`、`readline`、`pi.sendUserMessage({deliverAs:"followUp"})`；测试 `git-merge-and-resolve-extension.test.ts` 通过。
- packages/coding-agent/examples/extensions/github-issue-autocomplete.ts：完整；核对 `git remote -v`、`gh issue list`、`AutocompleteProvider`、`fuzzyFilter`、`ctx.ui.addAutocompleteProvider`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/handoff.ts：完整；核对 `getHandoffMessages`、`convertToLlm`/`serializeConversation`、`BorderedLoader`、`modelRegistry.complete`、`ctx.ui.editor`、`ctx.newSession`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/hello.ts：完整；核对 TypeBox `Type.Object/String`、`defineTool`、`pi.registerTool`；导入来源风险见下；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/hidden-thinking-label.ts：完整；核对 `ctx.ui.setHiddenThinkingLabel`、`session_start`、`/thinking-label`；diff/esbuild 通过。
- packages/coding-agent/examples/extensions/inline-bash.ts：完整；核对 `input` 事件、`pi.exec("bash", ["-c", ...])` 的 `ExecResult`、`transform` 返回和 `images` 透传；diff/esbuild 通过。

实际运行的验证命令与结果：

- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/compaction-extensions-example.test.ts test/git-merge-and-resolve-extension.test.ts test/tool-renderer-examples.test.ts`：3 个测试文件、15 个用例全部通过。
- `esbuild <file> --format=esm --outfile=/tmp/e01-syntax-check.js`（逐个运行 24 个文件）：全部通过。
- `python3 /tmp/verify_e01.py`：24/24 个文件有 diff，1058 行新增均为 `//` 注释，0 行删除。
- 模板字符串和闭括号注释位置审计：0 处违规。

## 未修改的数据/配置文件

- 无：本组分配的 24 个文件全部是 TypeScript 扩展示例，没有分配给本组的 `.json`、配置或数据文件；未修改 `study-coverage.json`、`STUDY_PROGRESS.md`、`STUDY_LOG.md`、`SESSION_PLAN.md` 或其他代理报告。`packages/coding-agent/examples/extensions/**` 被根 `tsconfig.json` 的 `exclude` 排除，因此全仓类型检查不会覆盖这些示例。

## 未完成或风险

- 全组没有运行 `npm run check`、`npm run build`、全量测试或全仓格式化：任务明确禁止；且这些示例不在根 tsconfig 的检查范围内。除 3 个直接测试外，其余示例需要 TUI、真实模型、`gh` 认证或网络环境，未做交互式运行验证。
- packages/coding-agent/examples/extensions/hello.ts：`Type` 从 `@earendil-works/pi-ai` 导入，但当前该包的公共入口没有 `Type` 导出；同目录 `dynamic-tools.ts` 从 `typebox` 导入。未改代码，加载时可能报 missing export。
- packages/coding-agent/examples/extensions/git-checkpoint.ts：`agent_settled` 会清空检查点 Map，正常空闲后分叉通常找不到快照；`git stash create` 只含已跟踪文件，且对象可能被 GC；`git stash apply` 未检查 `code`，失败也会提示成功。
- packages/coding-agent/examples/extensions/git-merge-and-resolve.ts：git 命令使用扩展加载 cwd，而 `findConflicts` 用 `ctx.cwd` 读文件，可能错位；只发送冲突行范围，不发送 ours/theirs 内容；未完成 merge 时每次 `agent_end` 可能重复发送 follow-up。
- packages/coding-agent/examples/extensions/github-issue-autocomplete.ts：`issuesPromise` 缓存失败结果，后续不再重试；`gh` 进程没有收到 autocomplete 的取消信号；任意 github.com remote 都可能被选中，且只支持 github.com URL 形式。
- packages/coding-agent/examples/extensions/handoff.ts：只把 `stopReason === "aborted"` 当取消，`error`/`length` 等仍可能返回文本；生成失败和用户取消都显示 Cancelled；空文本仍会打开空编辑器。
- packages/coding-agent/examples/extensions/inline-bash.ts：`String.replace` 的字符串替换值会解释 `$&`/`$1`/`$$`；输出若含 `!{...}` 可能被后续替换命中；非零退出但 stderr 为空时不会标记错误；没有传 `ctx.cwd`。
- 其他已知演示缺口（已在文件头记录，未改行为）：`custom-compaction.ts` 不检查 `stopReason`；`file-trigger.ts` watcher 没有关闭且路径写死；`built-in-tool-renderer.ts` 的 bash 失败正则与当前内置输出不一致；`dirty-repo-guard.ts` 与 `git-merge-and-resolve.ts` 的 git 命令未显式使用 `ctx.cwd`。
