# 组 v1a

状态：完成

## 完成文件

- `packages/chord/src/old/object.ts`：完整；逐段读完文件本身及上下游依赖（`cell.ts`、`contract.ts`、`declare.ts`、`errors.ts`、`publish.ts`、`registry.ts`、`schema.ts`、`remote.ts`、`reload.ts`、`host.ts`），并核对 `test/old/state-init.test.ts` 等测试中的真实 v1 调用方式。文件头写明所属包与模块、职责边界、上游入口/下游依赖、错误流向、按导出项的能力清单、真实签名的典型调用示例、建议阅读顺序。正文覆盖服务与存活策略、声明类型、`ResourceImpl`/`ResourceFacade`、`Decls`/`Run`/`Installed`、`HostCore`、`CtxImpl`、信号合并/就绪等待、`RefImpl` 与 Proxy 延迟绑定、`MemberReadable` 重绑、`ObjectImpl` 的激活事务（`start`/`#activate`/`run`/`open`/`waitHydrated`/`initCells`/`unwind`/`refreshSchemas`）、监听器预订阅与 gate、任务启停、调用准入与 `guard`、引用计数/linger/销毁，以及 `SelfImpl` 的 state/get/resource/on/task/derive/expose/register。修改量为 745 行新增、0 行删除。测试命令：`cd packages/chord && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/old/state-init.test.ts test/old/readiness.test.ts test/old/hydration.test.ts test/old/reload.test.ts test/old/variants.test.ts test/old/state.test.ts test/old/bindings.test.ts test/old/principals.test.ts test/old/host-objects-reload.test.ts`；结果：9 个文件通过，72 个测试通过，约 500ms。

- `packages/chord/src/old/node.ts`：完整；原文件已有逐行中文注释，保留不改。补充了详细文件头：Node-only 导出入口的定位、浏览器安全隔离边界、上游 package exports/应用入口、下游 `loader.ts` 与 `manager.ts`、按导出项的能力清单（`nodeLoader`、控制消息/存活/退出/实例/驱动/管理器类型、`forkDriver`、`createHostManager`、`processLock`、`childControl`）、父进程与子进程两侧的典型调用示例、建议阅读顺序。修改量为 47 行新增、0 行删除。该文件本身没有运行时逻辑，未单独运行测试；`manager.test.ts`/`loader.test.ts` 会启动子进程或 `spawnSync`，未在本次离线快速验证中运行。

- `packages/chord/src/old/errors.ts`：完整；原文件已有逐行中文注释，保留不改。补充了详细文件头：错误码词汇与 `ChordError` 的职责边界、上游导出与消费方、下游无项目内依赖、按导出项的能力清单、错误码速查、`forbidden`/`isChordError`/`runAll` 的示例、建议阅读顺序。修改量为 49 行新增、0 行删除。错误辅助被上述测试的导入链覆盖，未单独运行 v1 errors 测试（仓库中的 `test/data/errors.test.ts` 针对 v2 data 层，不是本文件）。

## 未完成或风险

- `packages/chord/src/old/node.ts` 只是重导出，未运行其下游 `manager.ts`/`loader.ts` 的子进程集成测试；这类测试会 fork 子进程或 `spawnSync`，不符合本次只做离线快速验证的约束。文件头中的 manager/childControl 行为依据 `manager.ts` 的源码与已有注释核对。
- 按任务要求未运行 `npm run check`、`npm run build`、全仓格式化，也未执行 `git add`、`git commit`、`git push`、`npm install`；未修改覆盖清单、`STUDY_PROGRESS.md`、`STUDY_LOG.md`、`SESSION_PLAN.md` 或其他代理报告。
- 三个目标文件的 `git diff --numstat` 均为仅新增、0 行删除；`git diff --check` 无输出。所有改动都只是注释行，未改变代码行为、公开 API、字符串、schema 或配置。
