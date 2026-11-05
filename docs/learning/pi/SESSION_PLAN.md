# 中文注释：多 Session 分工

目标：面向完全不熟悉 Pi、同时初学 TypeScript 的读者，完善整个仓库的中文注释。沿用分支 `learning/full-chain-study-bay`，不改程序行为。当前已验收 693 个文件；未完成范围以 `node scripts/study-status.mjs --files` 为准。五小时是本轮目标，不能用泛泛注释或虚报完成来赶时间。

## 所有 Session 共用的要求

- 先读根目录 `AGENTS.md`。完整阅读负责文件及相关调用、类型；函数前用大白话解释用途、参数、返回值、流程、副作用、错误和小例子；函数内解释每条有意义语句，同时讲清 TypeScript 语法及常用用法。纯闭括号不凑注释，不加“中文学习”等标签。
- 保留原英文、表达式、类型、API、默认值、提示词、模板字符串和检查指令的相邻关系，只加或修正中文说明。注释必须描述真实行为，区分“类型检查”“运行时校验”和“测试实际证明的范围”。
- 只改自己目录内的待处理文件，已完成文件跳过；其他 Session 的文件可读不可改。生成物、第三方代码只追溯来源并写配套说明；JSON/YAML 等格式按其允许的注释方式处理，JSON 不直接塞注释。Chord v2 另须读完整 design、slices 和对应 slice 规范。
- 允许各自再开子代理，内部划分不重叠目录；自行完成注释、全文复读、仅注释差异验证和必要的指定测试，不逐文件等主 Session 批准。不运行真实模型、真实认证、用户剪贴板、发布或安装。不能安全运行的测试记录原因，不冒称通过。
- 共用当前工作区，不切换分支、不创建 worktree、不 merge、不独立提交/推送、不运行会全仓改写的检查。完成一组后写 `docs/learning/pi/session-reports/NN.md`，列实际改动路径、完成范围、验证命令/结果及剩余问题，源码保持稳定。继续下一组时先更新报告状态。
- Session 20 负责最终汇总：确认全部写入者已停止，再统一 `npm run check`、复核格式差异、更新覆盖指纹/学习日志、按阶段正常提交并非强制推送。仅收录已验证的团队改动；当前 origin 是官方仓库，已返回无写权限 403，未提供可写目标前不能声称推送成功。最后半小时预留汇总验收，未完成如实交接。

## 目录分工（“直接文件”不含子目录；“其余”排除已分配目录）

| Session | 独占修改范围 |
| --- | --- |
| 01 | `packages/ai/`：剩余源码、catalog、测试及配置 |
| 02 | `packages/coding-agent/test/` 的直接文件 |
| 03 | `packages/coding-agent/test/` 的全部子目录 |
| 04 | `packages/coding-agent/examples/` |
| 05 | `packages/chord/src/{node,store,link}/` |
| 06 | `packages/chord/src/{host,jobs,remote}/` |
| 07 | `packages/chord/src/` 其余范围，含 old |
| 08 | `packages/chord/test/{node,store,link,registries}/` |
| 09 | `packages/chord/test/{host,jobs,remote}/` |
| 10 | `packages/chord/test/` 的直接文件，以及 `old/`、`schema/` |
| 11 | `packages/chord/test/` 其余子目录，含 examples、bench |
| 12 | `packages/durable/src/{harness,session,tools}/` |
| 13 | `packages/durable/src/` 其余范围 |
| 14 | `packages/durable/test/` 的直接文件 |
| 15 | `packages/durable/test/` 子目录及 `packages/durable/test-workers/` |
| 16 | `packages/schema/`：重点核对官方测试夹具来源，第三方正文不改、不计中文注释完成 |
| 17 | `packages/env/`：重点 Rust daemon 与测试 |
| 18 | 根目录 `scripts/`、`.github/`、`.husky/` |
| 19 | `packages/{agent,codemode,evals,mcp,telemetry,tui}/` |
| 20 | 其余目录和配置：根目录直接文件、`nix/`、`.pi/`、Chord docs/包根、Durable 包根、coding-agent 的 src/docs/scripts/包根；另负责汇总验收、日志、提交与推送 |

启动提示词：**“执行 `docs/learning/pi/SESSION_PLAN.md` 中 Session NN 的全部任务；先读共用要求和 AGENTS.md，按目录自主并行推进，报告写入对应 NN.md，遵守统一检查/提交分工。”**

交接：此前主 Session 的源码写入已停止。`/tmp/pi-study-validation-bay/` 中有 AI compat-schema/data-json/telemetry/faux、TUI native-clipboard 等未验收草稿，可供 Session 01/19 参考，不能直接当完成。当前覆盖、进度和日志的待提交维护由 Session 20 接收；旧主 Session 不再继续源码注释。
