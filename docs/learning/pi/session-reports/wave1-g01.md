# 组 g01

状态：完成

## 完成文件

- packages/ai/src/providers/compat-schema.ts：完整；已全文阅读 schema 构造器、`schema-builders.ts`、`model-schema.ts`、`packages/coding-agent/src/core/pi-ai-schemas.ts`、`scripts/generate-schemas.ts`、`scripts/generate-references.ts`、`@earendil-works/pi-schema` 的 `Schema`/`Optional`/`Static` 用法；补全文件导读、导出项清单、各 API 字段表说明、`UnionToIntersection`/`MergedCompatProperties`/`mergeCompatProperties` 的编译期与运行时区别。已修正原草稿中两行条件类型被改写的问题，当前 `? Intersection` 与 `: never;` 恢复原样。核对 `@earendil-works/pi-schema`、`schema-builders.ts`、`model-schema.ts` 与 `test/compat-schema.test.ts`。运行 Vitest：3 个测试文件、49 项全部通过。
- packages/ai/src/providers/data-json.d.ts：完整；补全文件导读，说明 `*.json` 通配环境声明、`resolveJsonModule` 下实际 JSON 推导优先、缺失生成数据时回退 `unknown`、数据由 `packages/ai/catalog/generate.ts` 生成并位于 gitignore 的 `src/providers/data/`。核对 `packages/ai/package.json` 的 `generate-models`/`hydrate-model-data` 脚本、`.gitignore`、任一 `*.models.ts` 的 import attributes 用法。纯声明文件无对应运行测试；未运行 `npm run check`（任务禁止）。
- packages/ai/src/providers/faux.ts：完整；补全文件导读和从常量、消息构造器、状态/选项类型、token 估算、提示词前缀、usage/缓存模拟、事件播放、`createFauxCore` 到 `fauxProvider` 的逐行注释。核对 `AssistantMessage`/`AssistantMessageEventStream`/`DeferredHandle` 等协议类型、`ToolCallArgumentsStream`、`compat.ts` 的 `registerFauxProvider`、`test/faux-provider.test.ts`。运行 Vitest：3 个测试文件、49 项全部通过。
- packages/ai/src/telemetry.ts：完整；补全文件导读，说明 `AI_TELEMETRY_SCHEMA` 的 span/事件/指标词汇、`observeModelRequest` 的首事件/结果处理、仪器 WeakMap 缓存、poll 的 token/cost 门禁和 500 UTF-16 码元错误截断。核对 `@earendil-works/pi-telemetry` 的 `createTypedMetrics`/`createTypedSpanStarter`/`defineTelemetrySchema`/noop 上下文、`packages/ai/src/api/lazy.ts` 的 `LazyStreamObserver` 与 `lazyStream` 调用顺序、`packages/ai/src/models.ts` 的 `stream`/`streamSimple`/`streamDeferred` 调用点、`test/telemetry.test.ts`。运行 Vitest：3 个测试文件、49 项全部通过。

测试命令（在 `packages/ai` 下执行）：

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/faux-provider.test.ts test/compat-schema.test.ts test/telemetry.test.ts
```

结果：`Test Files 3 passed (3)`，`Tests 49 passed (49)`。

本次四个文件均只新增注释，未修改、删除或重排原代码行。`git diff --numstat` 结果：

```text
390	0	packages/ai/src/providers/compat-schema.ts
32	0	packages/ai/src/providers/data-json.d.ts
572	0	packages/ai/src/providers/faux.ts
199	0	packages/ai/src/telemetry.ts
```

## 未完成或风险

- packages/ai/src/providers/data-json.d.ts：没有直接对应的运行测试；其行为属于编译期类型解析，已通过阅读 tsconfig、生成脚本和现有源码核对。`unknown` 回退场景未在本轮重新执行独立 tsc 实验，未运行 `npm run check`/`npm run build`（任务明确禁止）。
