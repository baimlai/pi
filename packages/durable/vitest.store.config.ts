// 复用部分 Harness 测试，在模块解析时把 SQLite 存储入口换成 Chord Store 上的 StoreStorage 适配器。
// The harness test files that take a SQLite storage, run on Durable's storage on Chord's store (`StoreStorage`, slice
// 6b): `../src/storage/sqlite/node.ts`'s opener is replaced by `test/store-storage-node.ts`; the files are unchanged.
// Four tests edit or read `SqliteStorage`'s own tables with raw SQL (`tasks`, `durable_metadata`) and are left out.

// 用 URL 转换绝对文件路径，路径基于本配置的位置，不依赖调用者从哪个目录启动 Vitest。
import { fileURLToPath } from "node:url";
// defineConfig 提供静态类型提示；mergeConfig 把下面的差异配置叠到常规 Durable 配置上。
import { defineConfig, mergeConfig } from "vitest/config";
// 基础配置保留 Node 环境、source 条件、默认排除项和文档保留期 setupFiles。
import base from "./vitest.config.ts";

// 适配文件仍导出 openNodeSqliteStorage，但实际调用 openStoreStorage；测试不需要改原导入语句。
const storeOpener = fileURLToPath(new URL("./test/store-storage-node.ts", import.meta.url));

// 默认导出合并结果供 --config vitest.store.config.ts 使用；本文件本身不打开数据库或执行测试。
export default mergeConfig(
	base,
	// 差异配置缩小测试集合，并添加存储入口替换；数组按 Vite 合并规则保留基础项。
	defineConfig({
		test: {
			// ^ 后的负向前瞻要求完整测试名称不包含四个片段之一；匹配的是名称文字，不是测试文件路径。
			// 四例直接依赖 SqliteStorage 私有表布局，StoreStorage 不承诺同样的表，因此这里明确排除它们。
			testNamePattern:
				/^(?!.*(resumes a retry backoff after reopen|sleeps again for a retry stored as a running phase|polls a checkpoint stored without a thinking level|refuses to create the root of an empty storage))/,
			// 显式列出复用的25份 Harness 测试；没有列出的其他测试不会因为文件名相似而自动加入。
			include: [
				// 阶段执行完毕后的处理。
				"test/harness-after-run.test.ts",
				// 任务阻塞及解除阻塞。
				"test/harness-blocked.test.ts",
				// 对话上下文压缩。
				"test/harness-compaction.test.ts",
				// 继续既有对话的调度。
				"test/harness-continue.test.ts",
				// 对话创建和组织。
				"test/harness-conversations.test.ts",
				// 生成阶段在重启后的恢复。
				"test/harness-generation-recovery.test.ts",
				// 输入收件队列。
				"test/harness-inbox.test.ts",
				// 输入如何写入历史条目。
				"test/harness-input-entries.test.ts",
				// Harness 打开、运行及关闭的生命周期。
				"test/harness-lifecycle.test.ts",
				// 嵌套工具在重启后的恢复。
				"test/harness-nested-tools-restart.test.ts",
				// 嵌套工具执行。
				"test/harness-nested-tools.test.ts",
				// 对话与任务之间的所有权规则。
				"test/harness-ownership.test.ts",
				// 对话只读规则。
				"test/harness-read-only.test.ts",
				// 重启失败的处理。
				"test/harness-restart-failure.test.ts",
				// 调度所需的索引。
				"test/harness-scheduler-indexes.test.ts",
				// 调度记录的保留与清理。
				"test/harness-scheduler-retention.test.ts",
				// 睡眠和重试等待；上述名称过滤仍会排除依赖私有表的两例。
				"test/harness-sleep.test.ts",
				// 结构化输出。
				"test/harness-structured.test.ts",
				// 提交请求及其状态。
				"test/harness-submissions.test.ts",
				// 任务图的结构与变化。
				"test/harness-task-graph.test.ts",
				// 任务在重启后的恢复。
				"test/harness-tasks-recovery.test.ts",
				// 工具执行前后的钩子。
				"test/harness-tool-hooks.test.ts",
				// 工具阶段的重启恢复。
				"test/harness-tools-recovery.test.ts",
				// 单次运行的轮数限制。
				"test/harness-turn-limit.test.ts",
				// 对话视图的可观察结果。
				"test/harness-view.test.ts",
			],
		},
		// 正则只匹配这个完整相对导入文字；未命中的 SQLite 导入不会被一概替换。
		// 替身会丢弃 prefix 选项，用固定 owner 隔离 StoreStorage，close 时也关闭底层 store。
		resolve: { alias: [{ find: /^\.\.\/src\/storage\/sqlite\/node\.ts$/, replacement: storeOpener }] },
	}),
);
