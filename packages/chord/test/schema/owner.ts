// The object of the stored-data proof: it owns the persisted documents, the tables and the job of `declarations.ts`,
// writes them (`write-stored.ts`, with the TypeBox helpers) and reads them back (the test, after the switch).
// 这里把声明接成真实的本地对象，既供旧数据生成脚本使用，也供当前兼容性测试读取。

import type { Context } from "../../src/context/index.ts";
import { createHost, defineFacet, type Host } from "../../src/host/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import type { TableDefinition } from "../../src/store/index.ts";
import { openStore, query, type Store, sqliteBackend } from "../../src/store/index.ts";
import { ImportJob, Notes, Owner, Profile, Rows } from "./declarations.ts";

/** What the job's `run` does in this process: wait until its context ends, or finish at once. */
export type RunBehaviour = "wait" | "finish";
// 字符串联合只限制 TS 调用者；它不是对外部输入的运行时解析器。

/** The finished runs' results, in order. */
export const finished: unknown[] = [];
// 此数组是测试进程的记录器，不是持久化任务结果表；proofs.ts 每次读取前会清空。

/** The owner's facet over `edits` (the table version this process declares). */
// 接收本次要声明的 edits 表版本和任务行为，返回可交给 host.load 的 facet，不立即写库。
// 流程是注册 Owner 工厂，再由工厂声明文档/表/任务并返回方法；运行中的任务会改进度和 finished。
// 例：生成旧夹具用 EditsV1 + "wait"，读回测试用 EditsV3 + "finish"，从而实际触发表迁移与任务恢复。
export function ownerFacet(edits: TableDefinition, behaviour: RunBehaviour) {
	// defineFacet 包装同步注册回调；真正执行注册发生在主机 load 的 setup 阶段。
	return defineFacet((host) => {
		// 空参数 Owner 只有一份；_ 表示不使用 params，self 提供这个对象拥有的能力。
		host.serve(Owner, (_, self) => {
			// 声明持久化单例 profile、按键 notes 和两张表；读旧库时主机负责加载和迁移。
			const profile = self.state(Profile);
			const notes = self.state(Notes);
			const rows = self.table(Rows);
			const editsTable = self.table(edits);
			// self.job 声明任务实现；start 会先提交意图，再调用 run，结束后交给 finish。
			const imports = self.job(ImportJob, {
				// 收 path 和任务上下文；每次 run 把路径长度加到持久进度，返回最终 count。
				// 例：路径 "a" 首次运行 done=1，重启后再次 run 会在旧进度上加到 2。
				run: async ({ path }, ctx) => {
					// await 保证进度事务先完成；draft 是任务自己的状态草稿，不是 profile。
					await ctx.state.change((draft) => {
						// += 在草稿上累加，本次事务成功后才发布/保存。
						draft.done += path.length;
					}, ctx);
					// 生成夹具时让任务留在运行中，直到 host.close 使上下文取消；读取时直接跳过等待。
					if (behaviour === "wait") {
						// resolve 作为 abort 事件监听器；可选链表示没有 signal 时不安装监听器。
						// 这里没有检查“已经取消”，适用的是本测试在任务开始后才关闭主机的流程。
						await new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", resolve));
					}
					// 从当前已提交的任务状态读取进度；返回结果不自动写入 finished。
					return { count: ctx.state.value.done };
				},
				// finish 接收带 kind 的结果；成功存 result，失败只记 kind，没有额外事务写入。
				// 这是进程内测试探针，push 不是可在失败重试时撤销的数据库操作。
				finish: async (outcome) => {
					finished.push(outcome.kind === "done" ? outcome.result : outcome.kind);
				},
			});
			// 返回的成员必须匹配 Owner 合同，profile 是可观察值，另外三个成员是异步方法。
			return {
				profile,
				// write 收 id/body，在一个事务更新笔记、profile 和两张表，再另起一个任务。
				// 例：id="a",body="first note" 会计数+1并记录长度10；任务启动失败不回滚先前数据事务。
				write: async ({ id, body }, ctx) => {
					// 只有事务回调成功且提交成功，下方所有草稿与表写入才一起生效。
					await self.tx(async (tx) => {
						// keyed 文档按 id 取草稿；不存在时在初始值上写 body，随后创建实际记录。
						(await tx.draft(notes, id)).body = body;
						// 单例不传键；同一事务中的后续属性赋值记录为 Delta 操作。
						const draft = await tx.draft(profile);
						// 这些值描述写入次数、写入顺序和每个 id 最近一次正文长度。
						draft.count += 1;
						draft.tags.push(id);
						draft.extra[id] = body.length;
						// 用嵌套联合分支和可选 inner 覆盖复杂 schema 的存储/读取路径。
						draft.choice = { deep: [{ x: draft.count }] };
						draft.nested = { inner: { v: body } };
						// put 暂存行；省略 n/flag 交给表默认值填充，data 是带版本的 JSON 列。
						tx.put(rows, {
							id,
							label: body,
							data: { a: body.length, b: [id] },
							// 对象展开只在 id="a" 时添加可选 maybe，其他行保留“没有此列值”的情形。
							...(id === "a" ? { maybe: { n: 1.5 } } : {}),
						});
						// 此写入专供 EditsV1 生成夹具，字段名仍是 file；V3 读取路径不会调用 write。
						// as never 绕过表版本泛型限制，不会在运行时把 file 自动改名为 path。
						tx.put(editsTable, { id, file: `/notes/${id}.md`, at: body.length } as never);
					}, ctx);
					// 数据提交后才单独提交任务 start，等待的是任务启动意图，不是 run 完成。
					await imports.start({ path: id }, ctx);
					// 合同未声明业务返回值，其内部形式为 null。
					return null;
				},
				// read 收键和调用上下文，返回 body；不存在时 ?. 得到 undefined，?? 改成空字符串。
				// 例如 read("missing") 得 ""，这是读取，不会创建空笔记。
				read: async (id, ctx) => (await notes.get(id, ctx))?.body ?? "",
				// dump 忽略空业务参数，依次读取测试所需快照；无跨读取事务，不保证并发写入下的统一时点。
				// 例：只显式列出 a/b 笔记，但表页最多读取十行，所以夹具中第三行 c 仍在 rows/edits。
				dump: async (_, ctx) => ({
					// 单例当前值可同步读；keyed get 是异步加载，缺少时转为 JSON null。
					profile: profile.value,
					notes: { a: (await notes.get("a", ctx)) ?? null, b: (await notes.get("b", ctx)) ?? null },
					// query 不附加过滤，page 返回页对象，这里只保留 items 丢弃分页游标。
					rows: (await rows.page(query(Rows), 10, ctx)).items,
					edits: (await editsTable.page(query(edits as TableDefinition), 10, ctx)).items,
					// running 列出所有未结任务；读取测试会先等待三个 finish，期望最终为零。
					runs: imports.running.value.length,
				}),
			};
		});
	});
}

/** A host serving the owner on the SQLite store at `path`. */
// 接收库路径、表版本、任务行为和必需的 context，返回已加载的 store/host，调用者负责分别关闭。
// 先打开 SQLite 和 store，再创建 host/load；任一步拒绝会向上传播，本辅助函数没有失败清理 finally。
// 例：ownerHost(临时路径, EditsV3, "finish", context) 会读取旧库、迁移表并恢复停下的任务。
export async function ownerHost(
	path: string,
	edits: TableDefinition,
	behaviour: RunBehaviour,
	context: Context,
): Promise<{ store: Store; host: Host }> {
	// 嵌套 await 先打开数据库，再包装成通用后端，最后初始化 store 的元数据/内部表。
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
	// 忽略后台错误只是夹具的测试选择；closeTimeout=100ms 限制清理等待，不限制全部操作耗时。
	const host = createHost({ store, onError: () => {}, closeTimeout: 100 });
	// load 返回后空参数 Owner 已有首次激活结果；此处不检查报告中的 failed 列表。
	await host.load([{ name: "@fixture/owner", facet: ownerFacet(edits, behaviour) }], context);
	return { store, host };
}
