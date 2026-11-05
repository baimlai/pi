// 文件导读（Durable Storage 契约一致性套件）
//
// 所属模块：packages/durable/src/testing；经包的 "./testing" 子路径导出。
// 上游入口：registerStorageConformance（./runner.ts）以及包内存储测试；调用方提供
//   StorageConformanceOptions：断言适配器 assertions 与存储工厂 withStorage。
// 下游依赖：@earendil-works/chord/context 的 BACKGROUND_CONTEXT（无取消信号的根上下文）；
//   ../types.ts 的 Storage 与记录类型（本文件校验的契约本身）；../ids.ts 的 idFromNumber
//   （构造显式 ID，用于乱序、边界和冲突场景）；./commit-writes.ts（单批提交并取回序号）；
//   ./types.ts（用例与断言接口）。
//
// 职责边界：本文件只“描述契约”，不运行用例、不选择测试框架、不创建后端。
//   - withStorage 由调用方实现：每个用例调用它一次，它必须创建干净存储、await 回调、再清理。
//   - 断言通过 StorageConformanceAssertions 抽象，因此同一套用例可在 Vitest/Jest/自研 runner 下运行。
//   - 用例通过 checkReceipts 代理 Storage，额外校验每次 commit 的回执契约。
//   - 除最后一个 close 用例外，用例不关闭存储；资源释放属于 withStorage 的职责。
//   - 类型系统负责编译期形状检查；运行期只校验契约明确要求拒绝或忽略的行为。
//
// 能力清单（唯一导出是 createStorageConformance；内部按契约分组）：
//   1. 根会话与 ID 空间：保留 ID 1、mintId 单调、显式 ID 冲突、ID 耗尽。
//   2. commit 回执与原子性：持久化后、resolve 前投递回执；拒绝不回执；混合表/文档命令整批回滚。
//   3. 数据隔离：写入参数与读回记录都深拷贝；原型键（__proto__/constructor）不改变对象原型。
//   4. 入口扫描：按 ID 而非提交顺序、游标在后续提交后仍有效、fork 祖先分段与 head 标记。
//   5. 表扫描：会话/任务/提交的升降序、过滤、游标携带自己的顺序。
//   6. 任务记录：整条替换语义、waiting/completing/sleeping/terminal 状态索引。
//   7. 提交记录：requestId 按会话唯一、input/write/continue 生命周期、状态索引维护。
//   8. 文档：base/delta/retire/copy、历史读、deltasSinceBase、current-only 文档拒绝历史读。
//   9. 批处理：多批按顺序提交、失败前缀保留、copy 解析看到更早批次的状态。
//  10. 关闭：close 之后所有操作都以 "closed" 拒绝。
//
// 典型用法（Vitest，经 runner 适配；provider 自己负责清理）：
//   registerStorageConformance({ describe, expect, it }, "MemoryStorage", (use) => {
//     const storage = new MemoryStorage();
//     return use(storage).finally(() => storage.close(BACKGROUND_CONTEXT));
//   });
// 也可以直接拿到用例自行运行：
//   for (const testCase of createStorageConformance({ assertions, withStorage })) await testCase.run();
//
// 建议阅读顺序：导入与共享 context → createRoot/pendingTask/entry fixture → assertionFacade →
//   checkReceipts → createCase → 用例数组（按上面的能力分组顺序阅读）。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// Op 与 JsonValue 只用于类型标注，用 import type 导入；编译后不会产生运行时依赖。
import type { Op } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord/json";
// idFromNumber 把普通数字转成带品牌的 ID 类型（如 EntryId）；它只影响类型，运行期仍是数字，
// 因此可以显式构造 10/20/30 这类乱序 ID 和 Number.MAX_SAFE_INTEGER 这类边界 ID。
import { idFromNumber } from "../ids.ts";
// Storage 契约及记录/查询类型。ROOT_CONVERSATION_ID 是运行时值（保留的根会话 ID 1），
// 其余都是 type-only；Page/Cursor/ScanOrder 描述分页与扫描方向。
import {
	type ConversationId,
	type Cursor,
	type DocumentCreate,
	type DocumentId,
	type EntryId,
	type EntryRecord,
	type JsonObject,
	type Page,
	ROOT_CONVERSATION_ID,
	type ScanOrder,
	type Seq,
	type Storage,
	type StorageWrite,
	type SubmissionId,
	type SubmissionQuery,
	type SubmissionRecord,
	type TaskId,
	type TaskRecord,
} from "../types.ts";
// commitWrites 把一条或多条写入包成单个批次提交并返回回执序号；拒绝时抛错。
// 用例用它准备前置数据，从而不必重复处理 { stored, refused } 返回值。
import { commitWrites } from "./commit-writes.ts";
// 套件输入与断言的抽象类型；本文件不直接依赖 vitest/jest。
import type { StorageConformanceAssertions, StorageConformanceCase, StorageConformanceOptions } from "./types.ts";

// 所有用例共享同一个无取消信号的根上下文。BACKGROUND_CONTEXT 是不可变的共享值，
// 存储实现不得依赖每次调用拿到不同对象；它只用于满足 API 的 context 参数。
const context = BACKGROUND_CONTEXT;
// StoredTask 把 TaskRecord 的三个 JSON 泛型固定为 JsonValue，避免为测试夹具声明具体类型；
// 这是纯编译期别名，运行期不存在。
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

// 创建一个只含根会话的存储。
// 输入：任意 Storage 实现；输出：ROOT_CONVERSATION_ID（类型为 ConversationId）。
// 副作用：向存储提交一条 conversation 记录；若根会话已存在，commitWrites 会抛错。
// 例子：const rootId = await createRoot(storage); 之后所有条目/任务都引用 rootId。
async function createRoot(storage: Storage): Promise<ConversationId> {
	// 根会话记录只有 id 字段，没有 owner/parent；单批提交保证它在后续用例开始前已持久化。
	await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
	return ROOT_CONVERSATION_ID;
}

// 构造一个确定性的 pending 任务夹具。
// 输入：任务 ID、所属会话 ID、可选 checkpoint phase（默认 "ready"）。
// 输出：满足 TaskRecord<JsonValue, JsonValue, JsonValue> 的普通对象。
// 副作用：无；不写存储。运行期不校验字段，形状由 satisfies 在编译期检查。
// 例子：pendingTask(taskId, rootId) 生成 state.status === "pending" 的任务。
function pendingTask(id: TaskId<JsonValue>, conversationId: ConversationId, phase = "ready") {
	return {
		id,
		conversationId,
		kind: "test.task",
		version: 1,
		// input 的 JSON 形状由调用方定义；测试把任务 ID 放进 input.value，方便追踪来源。
		input: { value: id },
		// pending 状态必须带 checkpoint；phase 用于区分不同任务的检查点。
		state: { status: "pending", checkpoint: { phase } },
		background: false,
		abortRequested: false,
		// satisfies 只做编译期结构检查，不会改变对象的运行时类型；返回对象仍是普通字面量。
	} satisfies StoredTask;
}

// 构造条目夹具。
// 输入：条目 ID、会话 ID、可选 kind（默认 "message"）、可选的额外 EntryRecord 字段。
// 输出：EntryRecord；extra 在最后展开，可以覆盖 kind 或补充 head/data 等字段。
// 副作用：无；运行期不校验。例子：entry(id, rootId, "marker", { head: otherId })。
function entry(
	id: EntryId,
	conversationId: ConversationId,
	kind = "message",
	extra: Partial<EntryRecord> = {},
): EntryRecord {
	// 先写固定字段，再展开 extra；TypeScript 的 Partial<EntryRecord> 允许只提供一部分可选字段。
	return { id, conversationId, kind, ...extra };
}

// 单条用例的实现签名：接收一个 Storage，完成全部断言后 resolve；失败通过 rejection 上报。
// 它是纯类型别名，createCase 用它约束传入的测试函数。
type ConformanceTest = (storage: Storage) => Promise<void>;

// 扫描结果断言只需要 id 一个字段；用结构化类型 { id: number } 接收各种记录，
// 避免为会话/任务/提交分别写泛型。品牌 ID 在运行时是数字，所以可以赋给 number。
type Identified = { readonly id: number };

// AssertionResult 是 Vitest expect 链的最小子集，只声明本文件用到的方法。
// 它只是编译期形状：真正执行断言的是 assertionFacade 里转调的 StorageConformanceAssertions。
// rejects/resolves 是属性而非方法，模拟 expect(promise).rejects.toThrow(...) 的链式写法。
type AssertionResult = {
	toBe(expected: unknown): void;
	toBeDefined(): void;
	toBeGreaterThan(expected: number): void;
	toBeUndefined(): void;
	toEqual(expected: unknown): void;
	toHaveLength(expected: number): void;
	toMatchObject(expected: unknown): void;
	readonly rejects: { toThrow(messageIncludes: string): Promise<void> };
	readonly resolves: { toBe(expected: unknown): Promise<void> };
};

// 把底层断言接口包装成类似 expect(value).toBe(...) 的外观，让用例读起来接近常见测试代码，
// 又不把套件绑定到具体 runner。
// 输入：调用方提供的 StorageConformanceAssertions；输出：一个函数，接收 actual 并返回断言对象。
// 副作用：无；每个方法在调用时才执行断言。运行期没有类型校验，类型由 AssertionResult 约束。
// 例子：const expect = assertionFacade(assertions); expect(actual).toEqual(expected)。
function assertionFacade(assertions: StorageConformanceAssertions) {
	// actual 用 unknown 接收：facade 不假设值的类型，具体比较交给底层断言适配器。
	return (actual: unknown): AssertionResult => ({
		// 下面各方法一一映射到底层断言：
		// toBe → strictEqual（Object.is/=== 语义由适配器决定）；
		// toBeDefined → ok(actual !== undefined)；toBeUndefined → strictEqual(actual, undefined)；
		// toEqual → deepEqual；toMatchObject → partialDeepEqual；
		// toHaveLength 读取 length 后严格比较；toBeGreaterThan 断言数值大小。
		toBe: (expected) => assertions.strictEqual(actual, expected),
		toBeDefined: () => assertions.ok(actual !== undefined, "Expected value to be defined"),
		// 这里把 unknown 断言成 number 是安全的：只有调用方在已知实际值是数字时才会用 toBeGreaterThan；
		// 它不是运行期检查，类型错误会在用例编写时暴露。
		toBeGreaterThan: (expected) => assertions.greaterThan(actual as number, expected),
		toBeUndefined: () => assertions.strictEqual(actual, undefined),
		toEqual: (expected) => assertions.deepEqual(actual, expected),
		// 同样，toHaveLength 假定 actual 有 length 属性；这是 expect API 的调用约定，不是运行时防御。
		toHaveLength: (expected) => assertions.strictEqual((actual as { readonly length: unknown }).length, expected),
		toMatchObject: (expected) => assertions.partialDeepEqual(actual, expected),
		// rejects.toThrow：Promise.resolve(actual) 把 thenable/普通值统一成 Promise；
		// 底层 rejects 会等待它拒绝，并检查错误消息包含给定片段。
		rejects: {
			toThrow: (messageIncludes) => assertions.rejects(Promise.resolve(actual), messageIncludes),
		},
		// resolves.toBe：先 await 再严格比较；如果 Promise 拒绝，错误会直接冒泡，测试失败。
		resolves: {
			toBe: async (expected) => assertions.strictEqual(await Promise.resolve(actual), expected),
		},
	});
}

// 包装 Storage，使每次 commit 都额外接受回执契约检查。
// 输入：原始 Storage 与断言实现；输出：行为相同但 commit 被代理的 Storage。
// 副作用：无；不改变底层存储。若回执违反契约，断言会抛错，从而让用例失败。
// 规则：每成功存储一个批次恰好一次 receive、index 从 0 递增、seq 严格递增，
//   且所有回执都必须在 commit Promise settle 之前送达。
// 例子：checkReceipts(storage, assertions).commit([[write]], receive, context)。
/**
 * `storage` with every commit checked against the receipt contract: one `receive` per stored batch, in order, with
 * increasing seqs, all before the call settles.
 */
function checkReceipts(storage: Storage, assertions: StorageConformanceAssertions): Storage {
	// 保留原 commit 的完整签名：batches、可选 receive 回调、context 都原样传递。
	const commit: Storage["commit"] = async (batches, receive, commitContext) => {
		// seqs 记录已收到的序号；settled 标记底层 commit 是否已经结束（成功或失败）。
		const seqs: Seq[] = [];
		let settled = false;
		// recording 是传给底层存储的 receive 包装：每收到一个批次回执就校验一次。
		// 它必须同步完成检查，因为契约要求回执在持久化后、resolve 前同步投递。
		const recording = (index: number, seq: Seq): void => {
			// 若 commit 已经 settle 仍收到回执，说明实现把回调推迟到了 Promise 完成之后。
			assertions.ok(!settled, "Storage.commit() received a batch after it settled");
			// 回执下标必须连续：第 n 个回执的 index 等于已收数量（从 0 开始）。
			assertions.strictEqual(index, seqs.length);
			// 序号必须严格递增；at(-1)! 的非空断言成立，因为上一行已确认 length > 0。
			if (seqs.length > 0) assertions.greaterThan(seq, seqs.at(-1)!);
			// 先记录再转交调用方的 receive；这样即使调用方回调抛错，已收状态也保持一致。
			seqs.push(seq);
			// 原样调用调用方回调；参数类型由 Storage 接口保证，无需运行期校验。
			receive(index, seq);
		};
		try {
			// 调用被代理的真实 commit；注意这里 await 的是底层 Promise。
			const result = await storage.commit(batches, recording, commitContext);
			// 成功存储的批次数必须等于回执数；被拒绝的批次不产生回执，因此不会计入 stored。
			assertions.strictEqual(seqs.length, result.stored);
			return result;
			// finally 在成功和异常路径都会执行，确保之后到达的迟到回执会被断言捕获。
		} finally {
			settled = true;
		}
	};
	// 用 Proxy 只替换 commit，其他属性/方法透明转发；这样用例无需知道代理存在。
	return new Proxy(storage, {
		// get 陷阱：读取属性时决定返回原值还是包装后的 commit。
		get(target, property) {
			// 只拦截 commit；conversation/entry/scan 等方法保持原实现。
			if (property === "commit") return commit;
			// Reflect.get(target, property, target) 以 target 作为 receiver 读取属性；
			// 方法必须 bind(target)，否则调用时 this 会指向 Proxy，可能破坏私有字段或内部状态。
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

// 把一条测试函数包装成 runner 无关的 StorageConformanceCase。
// 输入：套件选项（提供 withStorage 与 assertions）、用例名、测试函数。
// 输出：{ name, run }；run 调用 withStorage，并把 checkReceipts 代理后的 Storage 交给测试。
// 注意：withStorage 必须恰好调用一次 use 并 await 它；这是 provider 的运行期契约。
function createCase(options: StorageConformanceOptions, name: string, test: ConformanceTest): StorageConformanceCase {
	// 箭头函数延迟执行：只有 runner 调用 run() 时才创建存储并运行断言。
	return { name, run: () => options.withStorage((storage) => test(checkReceipts(storage, options.assertions))) };
}

// 生成全部 Storage 契约用例。
// 输入：StorageConformanceOptions；输出：只读的 StorageConformanceCase 数组。
// 副作用：无（构造用例不访问存储）；用例真正运行时才通过 withStorage 创建后端。
// 错误：构造阶段不抛错；断言失败或 provider 失败会成为对应 run() 的 rejection。
// 主流程：创建断言 facade → 组装用例数组；数组顺序也是建议的执行/阅读顺序。
// 例子：createStorageConformance({ assertions, withStorage }).map((c) => c.name)。
/** Creates runner-independent cases. `withStorage` must call and await its callback exactly once per case. */
export function createStorageConformance(options: StorageConformanceOptions): readonly StorageConformanceCase[] {
	// 整个套件共用一个 facade；它只是闭包，捕获 options.assertions，不保存测试状态。
	const expect = assertionFacade(options.assertions);
	// 返回数组字面量；每个元素都是 createCase(...) 的结果。下面按契约分组排列。
	return [
		// 用例 1：根会话保留 ID 1，mintId 从 2 开始，重复创建根会话被拒绝。
		// 这验证全局 ID 命名空间的起点和根会话的不可变身份。
		createCase(options, "reserves ID 1 for the immutable root conversation", async (storage) => {
			// 在写入任何记录之前，第一次分配必须是 2：ID 1 永远留给根会话。
			expect(await storage.mintId<ConversationId>()).toBe(2);
			await expect(createRoot(storage)).resolves.toBe(ROOT_CONVERSATION_ID);
			// 根会话读回只有 { id }，没有额外字段。
			expect(await storage.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });
			// 再次提交同一个会话 ID 必须失败；commitWrites 会把拒绝转换成异常。
			await expect(
				commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context),
			).rejects.toThrow(`ID ${ROOT_CONVERSATION_ID} already belongs to conversation`);
		}),

		// 用例 2：成功提交在 resolve 前恰好投递一次回执；被拒绝的提交不投递回执。
		createCase(
			options,
			"receives a durable commit once before resolving, and never a refused one",
			async (storage) => {
				// 先建立根会话，后续条目都挂在它下面。
				const rootId = await createRoot(storage);
				// events 记录回调与 resolve 的先后顺序；这是本用例的核心观测点。
				const events: string[] = [];
				// 分配条目 ID；mintId 只分配不写入。
				const entryId = await storage.mintId<EntryId>();
				// read 保存回调内部发起的读取 Promise；稍后 await 它验证持久化时机。
				let read: ReturnType<Storage["entry"]> | undefined;
				let seq: Seq | undefined;
				// 单批提交：批次是二维数组，外层每个元素是一批写入。
				const result = await storage.commit(
					[[{ type: "entry", value: entry(entryId, rootId) }]],
					// receive 回调收到 (index, seq)；index 是本批下标，seq 是本批持久化后的提交序号。
					(_index, received) => {
						seq = received;
						events.push(`receive ${received}`);
						// 回执到达时该批已经持久化：立即发起 entry 读取（不 await），此时应能读到它。
						// The batch is durable when it is received: a read started now observes it.
						// 读取在回调内启动；Promise 的结果在回调返回后由外部 await。
						read = storage.entry(entryId, context);
					},
					context,
				);
				// commit resolve 之后再记录一条事件，用于比较事件顺序。
				events.push(`resolve ${result.stored}`);
				// 期望顺序严格是：先 receive，后 resolve；且 seq 已被赋值（模板字符串插值）。
				expect(events).toEqual([`receive ${seq}`, "resolve 1"]);
				// 回调内启动的读取返回的 commitSeq 必须等于回执序号。
				expect((await read)?.commitSeq).toBe(seq);

				// 清空事件，准备观察被拒绝的提交。
				events.length = 0;
				// 用已存在的根会话 ID 制造拒绝；refused 不会抛错，而是返回 { stored:0, refused }。
				const refused = await storage.commit(
					[[{ type: "conversation", value: { id: rootId } }]],
					(_index, received) => events.push(`receive ${received}`),
					context,
				);
				// stored 为 0 表示没有任何批次落盘。
				expect(refused.stored).toBe(0);
				// refused 是 Error；String(error) 得到 "Error: ..."，检查具体原因。
				expect(String(refused.refused)).toBe(`Error: ID ${rootId} already belongs to conversation`);
				// 被拒绝的批次绝不能收到回执，因此事件数组仍为空。
				expect(events).toEqual([]);

				// 拒绝之后存储仍可继续使用；下一次成功提交的序号必须大于之前的 seq。
				const next = await commitWrites(
					storage,
					[{ type: "entry", value: entry(await storage.mintId<EntryId>(), rootId) }],
					context,
				);
				// 非空断言 seq! 成立：前面的成功提交已给它赋值；这也验证拒绝没有推进序号。
				expect(next).toBeGreaterThan(seq!);
			},
		),

		// 用例 3：一次 commit 混合写 entry/task/submission，要么全部可见，要么全部回滚。
		createCase(
			options,
			"commits mixed table writes atomically and rolls all of them back on failure",
			async (storage) => {
				// 根会话是任务和提交记录的外键目标。
				const rootId = await createRoot(storage);
				// 分别从共享 ID 空间分配三类 ID；数字大小不代表表归属。
				const entryId = await storage.mintId<EntryId>();
				const taskId = await storage.mintId<TaskId<JsonValue>>();
				const submissionId = await storage.mintId<SubmissionId>();
				const task = pendingTask(taskId, rootId);
				// input 类提交记录：requestId 在会话内唯一，entry 指向触发它的条目。
				const input: SubmissionRecord = {
					id: submissionId,
					conversationId: rootId,
					requestId: "request-1",
					type: "input",
					status: "placed",
					entry: entryId,
				};
				// 三张表的第一批写入共用一个 commit；返回初始提交序号。
				const initialSeq = await commitWrites(
					storage,
					[
						{ type: "entry", value: entry(entryId, rootId, "user", { data: { text: "hello" } }) },
						{ type: "task", value: task },
						{ type: "submission", value: input },
					],
					context,
				);

				// 提交后三张表都能按 ID 读回，且 entry 带 commitSeq。
				expect(await storage.entry(entryId, context)).toEqual({
					entry: entry(entryId, rootId, "user", { data: { text: "hello" } }),
					commitSeq: initialSeq,
				});
				expect(await storage.task(taskId, context)).toEqual(task);
				expect(await storage.submission(submissionId, context)).toEqual(input);

				// 为回滚场景准备一个新条目 ID；它只应出现在失败的批次里。
				const transientEntryId = await storage.mintId<EntryId>();
				// running 任务沿用原记录，只替换 state；这是整条记录替换，不是字段合并。
				const runningTask: StoredTask = {
					...task,
					state: { status: "running", checkpoint: { phase: "effect" } },
				};
				// done 提交记录引用 transientEntryId 作为 answer。
				const doneInput: SubmissionRecord = { ...input, status: "done", answer: transientEntryId };
				// 第四批写入的最后一条重复创建根会话，触发拒绝；前面的 task/submission/entry 也必须回滚。
				await expect(
					commitWrites(
						storage,
						[
							{ type: "task", value: runningTask },
							{ type: "submission", value: doneInput },
							{ type: "entry", value: entry(transientEntryId, rootId, "assistant") },
							{ type: "conversation", value: { id: rootId } },
						],
						context,
					),
					// 拒绝原因是根会话 ID 已属于 conversation；commitWrites 把 refused 转成异常抛出。
				).rejects.toThrow(`ID ${rootId} already belongs to conversation`);

				// 任务仍是初始 pending 状态，说明 running 写入被回滚。
				expect(await storage.task(taskId, context)).toEqual(task);
				// 提交记录仍是 placed，说明 done 更新被回滚。
				expect(await storage.submission(submissionId, context)).toEqual(input);
				// 临时条目完全不存在，说明同批前面的 entry 写入也被回滚。
				expect(await storage.entry(transientEntryId, context)).toBeUndefined();
				// 回滚后新的提交可以成功，并且序号大于初始提交，证明失败批次没有占用持久状态。
				const afterRollbackSeq = await commitWrites(
					storage,
					[{ type: "entry", value: entry(await storage.mintId<EntryId>(), rootId, "after-rollback") }],
					context,
				);
				expect(afterRollbackSeq).toBeGreaterThan(initialSeq);
			},
		),

		// 用例 4：存储必须在写入时保留快照、读出时返回副本，双向隔离调用方可变对象。
		createCase(options, "detaches retained writes and every returned record", async (storage) => {
			const rootId = await createRoot(storage);
			const entryId = await storage.mintId<EntryId>();
			const taskId = await storage.mintId<TaskId<JsonValue>>();
			const submissionId = await storage.mintId<SubmissionId>();
			// 这些是可变的普通对象，后面会故意修改它们，观察存储是否受影响。
			const entryData = { nested: [1, 2] };
			const checkpoint = { phase: "ready", nested: { count: 1 } };
			const detail = { codes: ["initial"] };
			// storedEntry 的 data 直接引用 entryData（同一对象），因此写入时的深拷贝是必要的。
			const storedEntry = entry(entryId, rootId, "note", { data: entryData });
			// 任务 checkpoint 内嵌可变对象；它与 checkpoint 变量共享引用。
			const storedTask: StoredTask = {
				...pendingTask(taskId, rootId),
				state: { status: "pending", checkpoint },
			};
			// 提交记录的 detail 也来自外部可变对象。
			const storedInput: SubmissionRecord = {
				id: submissionId,
				conversationId: rootId,
				type: "input",
				status: "unanswered",
				reason: "failed",
				detail,
			};
			// 一次性写入三张表；此时存储应已保存这些值的独立快照。
			await commitWrites(
				storage,
				[
					{ type: "entry", value: storedEntry },
					{ type: "task", value: storedTask },
					{ type: "submission", value: storedInput },
				],
				context,
			);

			// 写入完成后修改调用方对象：数组 push、嵌套字段赋值。
			entryData.nested.push(3);
			checkpoint.nested.count = 2;
			detail.codes.push("mutated");
			// 读回的 entry.data 不应包含后加的 3，说明写入时复制了数据。
			expect((await storage.entry(entryId, context))?.entry.data).toEqual({ nested: [1, 2] });
			// 任务的 checkpoint 仍是写入时的嵌套值。
			expect((await storage.task(taskId, context))?.state).toEqual({
				status: "pending",
				checkpoint: { phase: "ready", nested: { count: 1 } },
			});
			// 提交记录 detail 也未受调用方 push 影响。
			expect((await storage.submission(submissionId, context))?.detail).toEqual({ codes: ["initial"] });

			// 下面改为修改“读出的记录”，验证读取是否也返回独立副本。
			// 非空断言 ! 成立：记录刚写入且未被删除。
			const readEntry = (await storage.entry(entryId, context))!.entry;
			// 修改读回 entry 的嵌套数组；如果存储返回内部引用，后续读会看到 9。
			(readEntry.data as { nested: number[] }).nested.push(9);
			// 再读一次任务；下面用状态判别联合决定是否有 checkpoint。
			const readTask = (await storage.task(taskId, context))!;
			// terminal 状态没有 checkpoint 字段；先收窄再访问，避免类型错误。
			if (readTask.state.status !== "terminal") {
				// 这里的 as 断言是因为测试动态访问已知的 checkpoint 形状；运行期仍是普通对象。
				(readTask.state.checkpoint as { phase: string; nested: { count: number } }).nested.count = 9;
			}
			// 修改读回提交记录的 detail 数组。
			const readInput = (await storage.submission(submissionId, context))!;
			(readInput.detail as { codes: string[] }).codes.push("read mutation");

			// 重新读取：三个值都应回到最初写入的内容，证明读路径也做了拷贝。
			expect((await storage.entry(entryId, context))?.entry.data).toEqual({ nested: [1, 2] });
			expect((await storage.task(taskId, context))?.state).toEqual({
				status: "pending",
				checkpoint: { phase: "ready", nested: { count: 1 } },
			});
			expect((await storage.submission(submissionId, context))?.detail).toEqual({ codes: ["initial"] });
		}),

		// 用例 5：JSON 中的 __proto__/constructor 等键必须作为普通自有属性保存，
		// 既不能污染对象原型，也不能在序列化/反序列化中丢失。
		createCase(options, "detaches prototype-like JSON keys without changing object prototypes", async (storage) => {
			const rootId = await createRoot(storage);
			const entryId = await storage.mintId<EntryId>();
			// JSON.parse 会把 "__proto__" 创建为自有属性，而不是触发原型 setter；
			// 这正好构造出普通对象字面量难以表达的测试数据。
			const data = JSON.parse(
				'{"__proto__":{"polluted":false},"constructor":{"label":"stored"},"toString":"value"}',
			) as Record<string, JsonValue>;
			// 写入带特殊键的条目数据。
			await commitWrites(storage, [{ type: "entry", value: entry(entryId, rootId, "note", { data }) }], context);

			// 用 Reflect.get 读取自有 __proto__ 值并修改；直接 obj.__proto__ 会走原型访问器。
			(Reflect.get(data, "__proto__") as Record<string, JsonValue>).polluted = true;
			// constructor 同样按自有属性处理，修改其内部字段。
			(Reflect.get(data, "constructor") as Record<string, JsonValue>).label = "mutated";
			// 读回数据；下面验证原型与键的归属。
			const firstRead = (await storage.entry(entryId, context))!.entry.data as Record<string, JsonValue>;
			// 读回对象的原型必须仍是 Object.prototype，不能被 __proto__ 键替换。
			expect(Object.getPrototypeOf(firstRead)).toBe(Object.prototype);
			// __proto__ 必须是自有属性（hasOwn），否则说明实现把它吞掉了。
			expect(Object.hasOwn(firstRead, "__proto__")).toBe(true);
			// 写入后修改调用方对象不应影响存储中的 __proto__ 值。
			expect(Reflect.get(firstRead, "__proto__")).toEqual({ polluted: false });
			// constructor 与 toString 键都按普通数据保存。
			expect(Reflect.get(firstRead, "constructor")).toEqual({ label: "stored" });
			expect(Reflect.get(firstRead, "toString")).toBe("value");
			// 全局对象原型未被污染：任意新对象都读不到 polluted。
			expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

			// 修改读回结果中的 __proto__ 自有值，验证读路径的深拷贝。
			(Reflect.get(firstRead, "__proto__") as Record<string, JsonValue>).polluted = true;
			// 再次读取，特殊键的值仍是写入时的快照。
			const secondRead = (await storage.entry(entryId, context))!.entry.data as Record<string, JsonValue>;
			expect(Reflect.get(secondRead, "__proto__")).toEqual({ polluted: false });
			expect(Reflect.get(secondRead, "constructor")).toEqual({ label: "stored" });
			expect(Reflect.get(secondRead, "toString")).toBe("value");
		}),

		// 用例 6：条目扫描按 ID 排序，而不是按提交顺序；head 标记查找也按 ID 取最新。
		createCase(options, "indexes entries committed out of ID order", async (storage) => {
			const rootId = await createRoot(storage);
			// 同一个批次里按 30、10、20 的顺序写入，故意打乱 ID 顺序。
			await commitWrites(
				storage,
				[
					// idFromNumber 显式构造 ID；运行期就是数字，因此可以跳过 mintId。
					{ type: "entry", value: entry(idFromNumber<EntryId>(30), rootId) },
					{ type: "entry", value: entry(idFromNumber<EntryId>(10), rootId) },
					{
						type: "entry",
						// kind 为 marker 且 head 指向 ID 10，用于验证 findLatestHeadMarker 的选择规则。
						value: entry(idFromNumber<EntryId>(20), rootId, "marker", {
							head: idFromNumber<EntryId>(10),
						}),
					},
				],
				context,
			);

			// 降序扫描（默认）按 ID 从大到小返回 [30, 20, 10]，与提交顺序无关。
			expect(
				(await storage.scanEntries({ conversationId: rootId }, 10, undefined, context)).items.map(({ id }) => id),
			).toEqual([30, 20, 10]);
			// 最新 head 标记是 ID 20（ID 最大的 marker），其 head 字段为 10。
			expect((await storage.findLatestHeadMarker(rootId, undefined, context))?.id).toBe(20);
		}),

		// 用例 7：分页游标固定在“上一条已返回记录之后”，后续新提交不会插入到旧页之间。
		createCase(options, "continues an entry cursor below its last item after a newer commit", async (storage) => {
			const rootId = await createRoot(storage);
			// 连续 mint 三次得到递增 ID：oldest < middle < newest。
			const oldestId = await storage.mintId<EntryId>();
			const middleId = await storage.mintId<EntryId>();
			const newestId = await storage.mintId<EntryId>();
			await commitWrites(
				storage,
				[
					{ type: "entry", value: entry(oldestId, rootId) },
					{ type: "entry", value: entry(middleId, rootId) },
					{ type: "entry", value: entry(newestId, rootId) },
				],
				context,
			);

			// 第一页取 2 条，降序得到最新和中间两条；next 游标指向中间条目之后。
			const first = await storage.scanEntries({ conversationId: rootId }, 2, undefined, context);
			expect(first.items.map(({ id }) => id)).toEqual([newestId, middleId]);
			// 在第一页之后又提交一条更新的条目；它不应出现在旧游标的后续页里。
			const appendedId = await storage.mintId<EntryId>();
			await commitWrites(storage, [{ type: "entry", value: entry(appendedId, rootId) }], context);
			// 用旧游标继续扫描，结果只应剩 oldest；newest 已在第一页返回，appended 在游标之后提交。
			const second = await storage.scanEntries({ conversationId: rootId }, 2, first.next, context);
			expect(second.items.map(({ id }) => id)).toEqual([oldestId]);
			// 没有更多旧条目，next 为 undefined。
			expect(second.next).toBeUndefined();
		}),

		// 用例 8：会话表按 ID 升序分页；游标是不透明的，但必须能安全地 JSON 往返。
		createCase(options, "paginates conversations by opaque cursor in ascending ID order", async (storage) => {
			const rootId = await createRoot(storage);
			// 再分配两个会话 ID；加上根会话共三个。
			const secondId = await storage.mintId<ConversationId>();
			const thirdId = await storage.mintId<ConversationId>();
			// 故意按第三、第二的顺序提交，验证扫描顺序由 ID 决定。
			await commitWrites(
				storage,
				[
					{ type: "conversation", value: { id: thirdId } },
					{ type: "conversation", value: { id: secondId } },
				],
				context,
			);

			// 第一页大小 2，升序得到 [root, second]。
			const first = await storage.scanConversations({}, 2, undefined, context);
			expect(first.items.map(({ id }) => id)).toEqual([rootId, secondId]);
			// 还有第三页数据，游标必须存在。
			expect(first.next).toBeDefined();
			// 游标实现可以是任意结构；契约只要求它能被 JSON 序列化后继续使用。
			// 这里用 JSON 往返模拟跨进程/持久化场景，并用 NonNullable 去掉 undefined 类型。
			const roundTrippedCursor = JSON.parse(JSON.stringify(first.next)) as NonNullable<typeof first.next>;
			// 用往返后的游标取第二页，只剩 third，且没有后续。
			const second = await storage.scanConversations({}, 2, roundTrippedCursor, context);
			expect(second.items.map(({ id }) => id)).toEqual([thirdId]);
			expect(second.next).toBeUndefined();
		}),

		// 用例 9：按 owner 边（conversationId/taskId）过滤会话，并验证过滤+分页组合。
		createCase(options, "filters and pages conversations by durable owner edges", async (storage) => {
			const rootId = await createRoot(storage);
			// otherOwnerId 是另一个 owner 会话；两个 task ID 用于区分 owner 元组。
			const otherOwnerId = await storage.mintId<ConversationId>();
			// first/second/third 是三个被拥有的会话，owner 组合各不相同。
			const firstTaskId = await storage.mintId<TaskId<JsonValue>>();
			const secondTaskId = await storage.mintId<TaskId<JsonValue>>();
			const firstId = await storage.mintId<ConversationId>();
			const secondId = await storage.mintId<ConversationId>();
			const thirdId = await storage.mintId<ConversationId>();
			// 一次提交创建四个会话（含 otherOwner），owner 指向会话+任务。
			await commitWrites(
				storage,
				[
					{ type: "conversation", value: { id: otherOwnerId } },
					{
						type: "conversation",
						value: { id: firstId, owner: { conversationId: rootId, taskId: firstTaskId } },
					},
					{
						type: "conversation",
						value: { id: secondId, owner: { conversationId: rootId, taskId: secondTaskId } },
					},
					{
						type: "conversation",
						value: { id: thirdId, owner: { conversationId: otherOwnerId, taskId: firstTaskId } },
					},
				],
				context,
			);

			// 只按 ownerConversationId=root 过滤，每页 1 条：第一页 first。
			const first = await storage.scanConversations({ ownerConversationId: rootId }, 1, undefined, context);
			expect(first.items.map(({ id }) => id)).toEqual([firstId]);
			expect(first.next).toBeDefined();
			// 第二页 second；third 的 ownerConversationId 是 otherOwner，不在结果中。
			const second = await storage.scanConversations({ ownerConversationId: rootId }, 1, first.next, context);
			expect(second.items.map(({ id }) => id)).toEqual([secondId]);
			expect(second.next).toBeUndefined();
			// 只按 ownerTaskId=firstTask 过滤：first 和 third 都引用这个任务，升序返回。
			expect(
				(await storage.scanConversations({ ownerTaskId: firstTaskId }, 10, undefined, context)).items.map(
					({ id }) => id,
				),
			).toEqual([firstId, thirdId]);
			// 同时给两个过滤条件时是 AND 语义，只剩 first。
			expect(
				(
					await storage.scanConversations(
						{ ownerConversationId: rootId, ownerTaskId: firstTaskId },
						10,
						undefined,
						context,
					)
				).items.map(({ id }) => id),
			).toEqual([firstId]);
		}),

		// 用例 10：fork 历史扫描。核心是每段祖先只到 fork 点为止，同批中 fork 点之后的条目也被排除。
		createCase(options, "scans deep fork history newest-first through every ancestor cap", async (storage) => {
			// 根会话与根段条目：first 是最早条目；forkPoint 是 child 的分叉点；
			// excludedSameCommit 与 forkPoint 同批但在其之后，不应出现在历史里。
			const rootId = await createRoot(storage);
			const rootFirst = await storage.mintId<EntryId>();
			const rootForkPoint = await storage.mintId<EntryId>();
			const rootExcludedSameCommit = await storage.mintId<EntryId>();
			// 记录根段提交序号，后面验证 entry.commitSeq。
			const rootEntriesSeq = await commitWrites(
				storage,
				[
					{ type: "entry", value: entry(rootFirst, rootId) },
					{
						type: "entry",
						value: entry(rootForkPoint, rootId, "marker", { head: rootFirst }),
					},
					{ type: "entry", value: entry(rootExcludedSameCommit, rootId) },
				],
				context,
			);
			// child 的 parent 指向根会话的 rootForkPoint：历史只包含到该条目为止。
			const childId = await storage.mintId<ConversationId>();
			await commitWrites(
				storage,
				[
					{
						type: "conversation",
						value: { id: childId, parent: { conversationId: rootId, at: rootForkPoint } },
					},
				],
				context,
			);
			// child 段：childForkPoint 是 grandchild 的分叉点；childExcluded 在分叉点之后。
			const childForkPoint = await storage.mintId<EntryId>();
			const childExcluded = await storage.mintId<EntryId>();
			await commitWrites(
				storage,
				[
					{ type: "entry", value: entry(childForkPoint, childId, "note") },
					{ type: "entry", value: entry(childExcluded, childId) },
				],
				context,
			);
			// 在 child 创建之后再往根段追加条目；它晚于 fork 点，历史扫描必须排除。
			const rootExcludedLater = await storage.mintId<EntryId>();
			await commitWrites(storage, [{ type: "entry", value: entry(rootExcludedLater, rootId) }], context);
			// grandchild 的 parent 指向 childForkPoint。
			const grandchildId = await storage.mintId<ConversationId>();
			await commitWrites(
				storage,
				[
					{
						type: "conversation",
						value: { id: grandchildId, parent: { conversationId: childId, at: childForkPoint } },
					},
				],
				context,
			);
			// grandchild 段包含一个 head marker（指向自己）和 tail。
			const grandchildHead = await storage.mintId<EntryId>();
			const grandchildTail = await storage.mintId<EntryId>();
			const grandchildEntriesSeq = await commitWrites(
				storage,
				[
					{
						type: "entry",
						value: entry(grandchildHead, grandchildId, "marker", { head: grandchildHead }),
					},
					{ type: "entry", value: entry(grandchildTail, grandchildId) },
				],
				context,
			);
			// 在 grandchild 创建后再往 child 段追加；同样晚于 fork 点，应被排除。
			const childExcludedLater = await storage.mintId<EntryId>();
			await commitWrites(storage, [{ type: "entry", value: entry(childExcludedLater, childId) }], context);

			// 降序第一页：grandchild 段最新两条 [tail, head]。
			const first = await storage.scanEntries({ conversationId: grandchildId }, 2, undefined, context);
			expect(first.items.map(({ id }) => id)).toEqual([grandchildTail, grandchildHead]);
			const second = await storage.scanEntries({ conversationId: grandchildId }, 2, first.next, context);
			// 第二页跨入 child 段：只到 childForkPoint，然后接根段的 rootForkPoint。
			expect(second.items.map(({ id }) => id)).toEqual([childForkPoint, rootForkPoint]);
			// 第三页只剩根段的 rootFirst，历史结束。
			const third = await storage.scanEntries({ conversationId: grandchildId }, 2, second.next, context);
			expect(third.items.map(({ id }) => id)).toEqual([rootFirst]);
			expect(third.next).toBeUndefined();

			// 升序方向：先根段（到 fork 点），再 child 段（到 fork 点），最后 grandchild 段。
			// Oldest first: the root's segment, then each fork's, each capped at the next fork point.
			// as const 让 order 保持字面量 "ascending"，满足 ScanOrder 联合类型；
			// 展开到查询对象时不会拓宽成 string。
			const ascending = { conversationId: grandchildId, order: "ascending" } as const;
			// 升序第一页：[rootFirst, rootForkPoint]。
			const firstUp = await storage.scanEntries(ascending, 2, undefined, context);
			expect(firstUp.items.map(({ id }) => id)).toEqual([rootFirst, rootForkPoint]);
			// 第二页：[childForkPoint, grandchildHead]；注意这里仍显式传了 ascending。
			const secondUp = await storage.scanEntries(ascending, 2, firstUp.next, context);
			expect(secondUp.items.map(({ id }) => id)).toEqual([childForkPoint, grandchildHead]);
			// 第三页不传 order，游标会携带升序方向；结果 [grandchildTail]。
			const thirdUp = await storage.scanEntries({ conversationId: grandchildId }, 2, secondUp.next, context);
			expect(thirdUp.items.map(({ id }) => id)).toEqual([grandchildTail]);
			expect(thirdUp.next).toBeUndefined();
			// 用 minEntryId/maxEntryId 限制 ID 范围（两端包含）；结果按降序返回两个 fork 点。
			expect(
				(
					await storage.scanEntries(
						{ ...ascending, minEntryId: rootForkPoint, maxEntryId: childForkPoint },
						10,
						undefined,
						context,
					)
				).items.map(({ id }) => id),
			).toEqual([rootForkPoint, childForkPoint]);
			// 游标与查询方向不一致时必须拒绝：firstUp 是升序游标，却用于 descending 查询。
			await expect(
				storage.scanEntries({ conversationId: grandchildId, order: "descending" }, 2, firstUp.next, context),
			).rejects.toThrow("cursor");

			// 当前视角的最新 head marker 是 grandchildHead（按 ID 最大）。
			const currentMarker = await storage.findLatestHeadMarker(grandchildId, undefined, context);
			expect(currentMarker?.id).toBe(grandchildHead);
			expect(currentMarker?.head).toBe(grandchildHead);
			// 历史视角 at=childForkPoint：此时 grandchild 段尚不可见，能看到的最新 marker 是 root 段的 rootForkPoint。
			const historicalMarker = await storage.findLatestHeadMarker(grandchildId, childForkPoint, context);
			expect(historicalMarker?.id).toBe(rootForkPoint);
			expect(historicalMarker?.head).toBe(rootFirst);
			// at=rootFirst 更早，根段自己的 marker 尚未出现，因此没有 head marker。
			expect(await storage.findLatestHeadMarker(grandchildId, rootFirst, context)).toBeUndefined();

			// 从当前 head marker 的 head 字段（grandchildHead）作为 minEntryId 开始分页，
			// 验证按 ID 下界过滤时游标仍正确。
			const activeFirst = await storage.scanEntries(
				{ conversationId: grandchildId, minEntryId: currentMarker?.head },
				1,
				undefined,
				context,
			);
			// 降序第一页只有 grandchildTail（>= head 且最大）。
			expect(activeFirst.items.map(({ id }) => id)).toEqual([grandchildTail]);
			expect(activeFirst.next).toBeDefined();
			// 第二页是 head 本身；之后没有更多满足下界的条目。
			const activeSecond = await storage.scanEntries(
				{ conversationId: grandchildId, minEntryId: currentMarker?.head },
				1,
				activeFirst.next,
				context,
			);
			expect(activeSecond.items.map(({ id }) => id)).toEqual([grandchildHead]);
			expect(activeSecond.next).toBeUndefined();

			// 历史范围：从 rootFirst 到 childForkPoint（含），降序得到 [childForkPoint, rootForkPoint, rootFirst]。
			expect(
				(
					await storage.scanEntries(
						{
							conversationId: grandchildId,
							minEntryId: historicalMarker?.head,
							maxEntryId: childForkPoint,
						},
						10,
						undefined,
						context,
					)
				).items.map(({ id }) => id),
			).toEqual([childForkPoint, rootForkPoint, rootFirst]);

			// entry 的普通读取返回 { entry, commitSeq }；commitSeq 是最后一次写入该条目的提交。
			expect(await storage.entry(rootFirst, context)).toEqual({
				entry: entry(rootFirst, rootId),
				commitSeq: rootEntriesSeq,
			});
			// 同批写入的两个条目共享同一个 rootEntriesSeq。
			expect((await storage.entry(rootForkPoint, context))?.commitSeq).toBe(rootEntriesSeq);
			// grandchild 的两个条目同样共享提交序号。
			expect((await storage.entry(grandchildHead, context))?.commitSeq).toBe(grandchildEntriesSeq);
			expect((await storage.entry(grandchildTail, context))?.commitSeq).toBe(grandchildEntriesSeq);
			// 不存在的条目返回 undefined，而不是抛错。
			expect(await storage.entry(idFromNumber<EntryId>(999_999), context)).toBeUndefined();

			// entry(conversationId, entryId, context) 是 fork 感知的历史读取：
			// 在 grandchild 视角下，rootFirst 仍可见，且保留原来的 conversationId。
			expect(await storage.entry(grandchildId, rootFirst, context)).toEqual({
				entry: entry(rootFirst, rootId),
				commitSeq: rootEntriesSeq,
			});
			// childForkPoint 属于 child 段，在 grandchild 视角可见，因此 conversationId 是 child。
			expect((await storage.entry(grandchildId, childForkPoint, context))?.entry.conversationId).toBe(childId);
			// grandchild 自己的条目可见。
			expect((await storage.entry(grandchildId, grandchildTail, context))?.commitSeq).toBe(grandchildEntriesSeq);
			// 与 fork 点同批但在其后的条目不可见。
			expect(await storage.entry(grandchildId, rootExcludedSameCommit, context)).toBeUndefined();
			// 在 fork 之后才提交的根条目也不可见。
			expect(await storage.entry(grandchildId, rootExcludedLater, context)).toBeUndefined();
			// child 段中晚于 childForkPoint 的条目同样被截断。
			expect(await storage.entry(grandchildId, childExcluded, context)).toBeUndefined();
			expect(await storage.entry(grandchildId, childExcludedLater, context)).toBeUndefined();
			// 反向查询：在 root 视角下，grandchild 的条目不属于它的历史。
			expect(await storage.entry(rootId, grandchildHead, context)).toBeUndefined();
			// 不存在的条目返回 undefined。
			expect(await storage.entry(grandchildId, idFromNumber<EntryId>(999_999), context)).toBeUndefined();
			// 未知的 conversationId 是调用错误，entry 与 scanEntries 都必须以 "Unknown conversation" 拒绝。
			await expect(storage.entry(idFromNumber<ConversationId>(999_999), rootFirst, context)).rejects.toThrow(
				"Unknown conversation",
			);
			await expect(
				storage.scanEntries({ conversationId: idFromNumber<ConversationId>(999_999) }, 10, undefined, context),
			).rejects.toThrow("Unknown conversation");
		}),

		// 用例 11：三张表都支持升/降序扫描，游标携带自己的顺序，且可跨查询复用。
		createCase(options, "scans tables in either ID order and continues a cursor in its order", async (storage) => {
			const rootId = await createRoot(storage);
			// conversationIds 以根会话开头；task/submission 数组按创建顺序收集。
			const conversationIds = [rootId];
			const taskIds: TaskId<JsonValue>[] = [];
			const submissionIds: SubmissionId[] = [];
			// 循环三轮，每轮为一个会话创建一条任务和一条提交；三者 ID 都是全局递增的。
			for (let index = 0; index < 3; index++) {
				const conversationId = await storage.mintId<ConversationId>();
				const taskId = await storage.mintId<TaskId<JsonValue>>();
				const submissionId = await storage.mintId<SubmissionId>();
				await commitWrites(
					storage,
					[
						{ type: "conversation", value: { id: conversationId } },
						{ type: "task", value: pendingTask(taskId, rootId) },
						{
							type: "submission",
							value: { id: submissionId, conversationId: rootId, type: "input", status: "queued" },
						},
					],
					context,
				);
				// 记录每轮的 ID，稍后与扫描结果比较。
				conversationIds.push(conversationId);
				taskIds.push(taskId);
				submissionIds.push(submissionId);
			}
			// Scan 把“方向 + 游标”统一成函数，便于对三张表复用同一套断言。
			// Page<Identified, Cursor> 表示条目只需 id，next 是可选游标。
			type Scan = (order: ScanOrder | undefined, cursor: Cursor | undefined) => Promise<Page<Identified, Cursor>>;
			// 每个元素是 [扫描函数, 该表按 ID 升序的期望 ID 列表]。
			const scans: readonly (readonly [Scan, readonly number[]])[] = [
				[(order, cursor) => storage.scanConversations({ order }, 2, cursor, context), conversationIds],
				[(order, cursor) => storage.scanTasks({ order }, 2, cursor, context), taskIds],
				[(order, cursor) => storage.scanSubmissions({ order }, 2, cursor, context), submissionIds],
			];
			// all 反复调用扫描函数直到 next 为 undefined，收集全部 ID。
			const all = async (scan: Scan, order: ScanOrder | undefined): Promise<number[]> => {
				const found: number[] = [];
				let page = await scan(order, undefined);
				found.push(...page.items.map(({ id }) => id));
				while (page.next !== undefined) {
					// 游标自带顺序：后续查询省略 order 也能继续；JSON 往返模拟不透明游标的持久化。
					// A cursor carries its order; the query may omit it.
					page = await scan(undefined, JSON.parse(JSON.stringify(page.next)) as Cursor);
					found.push(...page.items.map(({ id }) => id));
				}
				return found;
			};
			// 三张表逐一验证：默认与 ascending 相同，descending 是反序。
			for (const [scan, ids] of scans) {
				const reversed = [...ids].reverse();
				expect(await all(scan, undefined)).toEqual(ids);
				expect(await all(scan, "ascending")).toEqual(ids);
				expect(await all(scan, "descending")).toEqual(reversed);
				// 降序游标继续分页，第二页应是 reversed[2..4]；游标与顺序匹配。
				const descending = await scan("descending", undefined);
				expect((await scan("descending", descending.next)).items.map(({ id }) => id)).toEqual(reversed.slice(2, 4));
				// 把降序游标传给升序查询必须拒绝，错误消息包含 "cursor"。
				await expect(scan("ascending", descending.next)).rejects.toThrow("cursor");
			}
		}),

		// 用例 12：任务写入是整条替换；过滤扫描按 status/background/abortRequested 维护索引。
		createCase(options, "replaces complete task records and pages filtered task scans", async (storage) => {
			const rootId = await createRoot(storage);
			const firstId = await storage.mintId<TaskId<JsonValue>>();
			const secondId = await storage.mintId<TaskId<JsonValue>>();
			const thirdId = await storage.mintId<TaskId<JsonValue>>();
			// first 带额外 memos 字段；second 标记 background；third 标记 abortRequested。
			const first = { ...pendingTask(firstId, rootId), memos: { winner: "first" } } satisfies StoredTask;
			const second = { ...pendingTask(secondId, rootId), background: true } satisfies StoredTask;
			const third = { ...pendingTask(thirdId, rootId), abortRequested: true } satisfies StoredTask;
			await commitWrites(
				storage,
				[
					{ type: "task", value: first },
					{ type: "task", value: second },
					{ type: "task", value: third },
				],
				context,
			);

			// 用 running 状态覆盖 first；注意新对象保留了 first 的其他字段，但 state 完全替换。
			const running: StoredTask = {
				...first,
				state: { status: "running", checkpoint: { phase: "effect", attempt: 1 } },
				abortRequested: true,
			};
			await commitWrites(storage, [{ type: "task", value: running }], context);
			// 读回必须等于 running，证明没有把旧 state 与新字段合并。
			expect(await storage.task(firstId, context)).toEqual(running);
			// terminal 记录没有 checkpoint；这里显式重建完整对象，验证判别联合的另一分支。
			const terminal: StoredTask = {
				id: firstId,
				conversationId: rootId,
				kind: first.kind,
				version: first.version,
				input: first.input,
				// terminal 的 outcome 携带最终结果；entryId 只是 JSON 值 99。
				state: { status: "terminal", outcome: { status: "completed", result: { entryId: 99 } } },
				background: false,
				abortRequested: true,
			};
			// 再次整条替换；旧 running 的 checkpoint 不应残留。
			await commitWrites(storage, [{ type: "task", value: terminal }], context);
			expect(await storage.task(firstId, context)).toEqual(terminal);

			// status=pending 过滤：first 已变成 terminal，只剩 second；分页大小 1。
			const pendingPage = await storage.scanTasks({ status: "pending" }, 1, undefined, context);
			expect(pendingPage.items.map(({ id }) => id)).toEqual([secondId]);
			expect(pendingPage.next).toBeDefined();
			// 第二页是 third；说明 pending 索引在状态变化后被正确维护。
			expect(
				(await storage.scanTasks({ status: "pending" }, 1, pendingPage.next, context)).items.map(({ id }) => id),
			).toEqual([thirdId]);
			// terminal + abortRequested 组合过滤返回 terminal 记录。
			expect(
				(await storage.scanTasks({ status: "terminal", abortRequested: true }, 10, undefined, context)).items,
			).toEqual([terminal]);
			// background=true 只命中 second。
			expect(
				(await storage.scanTasks({ background: true }, 10, undefined, context)).items.map(({ id }) => id),
			).toEqual([secondId]);
		}),

		// 用例 13：owner 引用、waiting/completing 状态以及状态转换后的索引更新。
		createCase(options, "stores owners and scans waiting and completing tasks by status", async (storage) => {
			const rootId = await createRoot(storage);
			const ownerId = await storage.mintId<TaskId<JsonValue>>();
			const waitingId = await storage.mintId<TaskId<JsonValue>>();
			const completingId = await storage.mintId<TaskId<JsonValue>>();
			// owner 自己是一条普通 pending 任务。
			const owner = pendingTask(ownerId, rootId);
			// waiting 任务引用 owner，on 列出等待的任务 ID，policy 为 allSettled，并保留 memos。
			const waiting: StoredTask = {
				...pendingTask(waitingId, rootId),
				owner: ownerId,
				state: { status: "waiting", checkpoint: { phase: "next" }, on: [ownerId], policy: "allSettled" },
				memos: { kept: true },
			};
			// 解构去掉 state，得到其余字段；_state 以下划线开头表示故意不使用。
			const { state: _state, ...base } = pendingTask(completingId, rootId);
			// completing 状态携带 outcome（此处为 failed）；它不再有 checkpoint。
			const completing: StoredTask = {
				...base,
				owner: ownerId,
				state: { status: "completing", outcome: { status: "failed", error: { message: "held" } } },
			};
			// map 生成 StorageWrite；as const 让 type 保持字面量 "task"，匹配判别联合。
			const writes = [owner, waiting, completing].map((value) => ({ type: "task", value }) as const);
			await commitWrites(storage, writes, context);
			// waiting 与 completing 记录读回应与写入完全一致。
			expect(await storage.task(waitingId, context)).toEqual(waiting);
			expect(await storage.task(completingId, context)).toEqual(completing);
			// 按状态扫描的辅助函数；StoredTask["state"]["status"] 是状态字面量联合。
			const scan = async (status: StoredTask["state"]["status"]) =>
				(await storage.scanTasks({ status }, 10, undefined, context)).items;
			// 各状态索引只返回对应记录。
			expect(await scan("waiting")).toEqual([waiting]);
			expect(await scan("completing")).toEqual([completing]);
			expect((await scan("pending")).map(({ id }) => id)).toEqual([ownerId]);
			// completing 的 outcome 一定存在（该状态要求它），因此 outcome! 安全；
			// terminal 复用同一个 outcome 对象。
			const terminal: StoredTask = {
				...completing,
				state: { status: "terminal", outcome: completing.state.outcome! },
			};
			await commitWrites(storage, [{ type: "task", value: terminal }], context);
			// 状态改变后，旧的 completing 索引必须为空。
			expect(await scan("completing")).toEqual([]);
			// 新状态 terminal 索引包含同一条记录（整条替换后的对象）。
			expect(await scan("terminal")).toEqual([terminal]);
		}),

		// 用例 14：sleeping 状态带 until 字段；转入 running 后状态索引要同步迁移。
		createCase(options, "stores and scans sleeping tasks by status", async (storage) => {
			const rootId = await createRoot(storage);
			const sleepingId = await storage.mintId<TaskId<JsonValue>>();
			// sleeping 任务保留 memos 与 until（毫秒时间戳）；checkpoint 仍存在。
			const sleeping: StoredTask = {
				...pendingTask(sleepingId, rootId),
				state: { status: "sleeping", checkpoint: { phase: "next" }, until: 61_000 },
				memos: { kept: true },
			};
			// 写入后读回与扫描都应命中 sleeping。
			await commitWrites(storage, [{ type: "task", value: sleeping }], context);
			expect(await storage.task(sleepingId, context)).toEqual(sleeping);
			const scan = async (status: StoredTask["state"]["status"]) =>
				(await storage.scanTasks({ status }, 10, undefined, context)).items;
			expect(await scan("sleeping")).toEqual([sleeping]);
			// 同一 ID 改写为 running；state 整条替换，until 等 sleeping 专属字段消失。
			const running: StoredTask = { ...sleeping, state: { status: "running", checkpoint: { phase: "next" } } };
			await commitWrites(storage, [{ type: "task", value: running }], context);
			// sleeping 索引清空，running 索引出现该记录。
			expect(await scan("sleeping")).toEqual([]);
			expect(await scan("running")).toEqual([running]);
		}),

		// 用例 15：requestId 在每个会话内唯一；提交记录整条替换，状态索引随之迁移。
		createCase(
			options,
			"indexes request IDs per conversation and replaces complete submission records",
			async (storage) => {
				const rootId = await createRoot(storage);
				// 第二个会话用于验证 requestId 的作用域是会话，而不是全局。
				const secondConversationId = await storage.mintId<ConversationId>();
				await commitWrites(storage, [{ type: "conversation", value: { id: secondConversationId } }], context);
				const firstId = await storage.mintId<SubmissionId>();
				const secondId = await storage.mintId<SubmissionId>();
				const otherConversationId = await storage.mintId<SubmissionId>();
				// first 与 otherConversation 使用相同 requestId "same"，但属于不同会话，允许共存。
				const first: SubmissionRecord = {
					id: firstId,
					conversationId: rootId,
					requestId: "same",
					type: "input",
					status: "queued",
				};
				const second: SubmissionRecord = {
					id: secondId,
					conversationId: rootId,
					requestId: "other",
					type: "input",
					status: "queued",
				};
				const otherConversation: SubmissionRecord = {
					id: otherConversationId,
					conversationId: secondConversationId,
					requestId: "same",
					type: "input",
					status: "queued",
				};
				// 三条记录一次提交。
				await commitWrites(
					storage,
					[
						{ type: "submission", value: first },
						{ type: "submission", value: second },
						{ type: "submission", value: otherConversation },
					],
					context,
				);
				// submissionByRequest 必须按 (conversationId, requestId) 定位。
				expect(await storage.submissionByRequest(rootId, "same", context)).toEqual(first);
				expect(await storage.submissionByRequest(secondConversationId, "same", context)).toEqual(otherConversation);

				// 更新 second 为 placed，并补上 entry 字段；这是整条替换。
				const placedSecond: SubmissionRecord = {
					...second,
					status: "placed",
					entry: await storage.mintId<EntryId>(),
				};
				// 更新后，按 ID 与按 requestId 两种读法都应看到新记录。
				await commitWrites(storage, [{ type: "submission", value: placedSecond }], context);
				expect(await storage.submission(secondId, context)).toEqual(placedSecond);
				expect(await storage.submissionByRequest(rootId, "other", context)).toEqual(placedSecond);

				// ids 辅助函数按每页 1 条遍历查询，收集所有匹配 ID。
				const ids = async (query: SubmissionQuery) => {
					const found: SubmissionId[] = [];
					let cursor: Cursor | undefined;
					do {
						const page = await storage.scanSubmissions(query, 1, cursor, context);
						found.push(...page.items.map(({ id }) => id));
						cursor = page.next;
					} while (cursor !== undefined);
					return found;
				};
				// 无过滤返回全部三条，按 ID 升序。
				expect(await ids({})).toEqual([firstId, secondId, otherConversationId]);
				// 按会话过滤只返回该会话的两条。
				expect(await ids({ conversationId: rootId })).toEqual([firstId, secondId]);
				// 状态过滤依赖索引维护：second 变成 placed 后从 queued 移到 placed。
				// A status change moves the record between status scans.
				expect(await ids({ status: "queued" })).toEqual([firstId, otherConversationId]);
				expect(await ids({ status: "placed" })).toEqual([secondId]);
				// 会话+状态组合过滤；secondConversation 没有 placed 记录，返回空。
				expect(await ids({ conversationId: secondConversationId, status: "queued" })).toEqual([
					otherConversationId,
				]);
				expect(await ids({ conversationId: secondConversationId, status: "placed" })).toEqual([]);
				// scanSubmissions 的 items 是完整记录，不只是 ID。
				expect((await storage.scanSubmissions({ status: "placed" }, 10, undefined, context)).items).toEqual([
					placedSecond,
				]);
			},
		),

		// 用例 16：type=write 的被动提交从 queued 直接到 done/unanswered，跳过 input 专属的 placed。
		createCase(options, "stores passive write submissions without input-only lifecycle states", async (storage) => {
			const rootId = await createRoot(storage);
			const doneId = await storage.mintId<SubmissionId>();
			const failedId = await storage.mintId<SubmissionId>();
			// 两条 write 提交初始都是 queued，requestId 不同。
			const queuedDone: SubmissionRecord = {
				id: doneId,
				conversationId: rootId,
				requestId: "passive-done",
				type: "write",
				status: "queued",
			};
			const queuedFailed: SubmissionRecord = {
				id: failedId,
				conversationId: rootId,
				requestId: "passive-failed",
				type: "write",
				status: "queued",
			};
			// 初始提交只写 queued 状态。
			await commitWrites(
				storage,
				[
					{ type: "submission", value: queuedDone },
					{ type: "submission", value: queuedFailed },
				],
				context,
			);

			// done 需要 entry；unanswered 需要 reason 和可选 detail。
			const done: SubmissionRecord = {
				...queuedDone,
				status: "done",
				entry: await storage.mintId<EntryId>(),
			};
			const unanswered: SubmissionRecord = {
				...queuedFailed,
				status: "unanswered",
				reason: "closed",
				detail: { retryable: false },
			};
			// 一次提交两条状态更新。
			await commitWrites(
				storage,
				[
					{ type: "submission", value: done },
					{ type: "submission", value: unanswered },
				],
				context,
			);
			// 按 ID 与按 requestId 都应读到最终记录。
			expect(await storage.submission(doneId, context)).toEqual(done);
			expect(await storage.submissionByRequest(rootId, "passive-done", context)).toEqual(done);
			expect(await storage.submission(failedId, context)).toEqual(unanswered);
			expect(await storage.submissionByRequest(rootId, "passive-failed", context)).toEqual(unanswered);
		}),

		// 用例 17：type=continue 的提交没有 entry 字段，且生命周期从 placed 开始，永远不会是 queued。
		createCase(options, "stores continue submissions, which have no entry and are never queued", async (storage) => {
			const rootId = await createRoot(storage);
			const doneId = await storage.mintId<SubmissionId>();
			const failedId = await storage.mintId<SubmissionId>();
			// continue 初始状态是 placed；记录中没有 entry。
			const placedDone: SubmissionRecord = {
				id: doneId,
				conversationId: rootId,
				requestId: "continue-done",
				type: "continue",
				status: "placed",
			};
			const placedFailed: SubmissionRecord = {
				id: failedId,
				conversationId: rootId,
				requestId: "continue-failed",
				type: "continue",
				status: "placed",
			};
			// 写入后按 ID 读回，并按 status=placed 扫描到两条。
			await commitWrites(
				storage,
				[
					{ type: "submission", value: placedDone },
					{ type: "submission", value: placedFailed },
				],
				context,
			);
			expect(await storage.submission(doneId, context)).toEqual(placedDone);
			expect((await storage.scanSubmissions({ status: "placed" }, 10, undefined, context)).items).toEqual([
				placedDone,
				placedFailed,
			]);

			// done 用 answer 引用一个条目 ID；unanswered 给出 nothing_to_answer 原因。
			const done: SubmissionRecord = { ...placedDone, status: "done", answer: await storage.mintId<EntryId>() };
			const unanswered: SubmissionRecord = { ...placedFailed, status: "unanswered", reason: "nothing_to_answer" };
			await commitWrites(
				storage,
				[
					{ type: "submission", value: done },
					{ type: "submission", value: unanswered },
				],
				context,
			);
			// 两种读法都应看到最终状态。
			expect(await storage.submission(doneId, context)).toEqual(done);
			expect(await storage.submissionByRequest(rootId, "continue-done", context)).toEqual(done);
			expect(await storage.submission(failedId, context)).toEqual(unanswered);
			expect(await storage.submissionByRequest(rootId, "continue-failed", context)).toEqual(unanswered);
		}),

		// 用例 18：可回放文档的 base/delta 重建、调用方/读回隔离、跨 base 的历史读与 retire。
		createCase(options, "reconstructs rewindable documents and preserves half-open incarnations", async (storage) => {
			const rootId = await createRoot(storage);
			// 文档记录：rewindable 保留历史，fork: "asOf" 允许从某个提交读取。
			const firstId = await storage.mintId<DocumentId>();
			const firstRecord = {
				id: firstId,
				kind: "conversation.notes",
				scope: { kind: "conversation", conversationId: rootId },
				history: "rewindable",
				fork: "asOf",
			} satisfies DocumentCreate;
			// 初始 base：items 数组与嵌套对象，便于验证深拷贝与后续 delta。
			const initial: JsonObject = { items: ["a"], nested: { count: 1 } };
			// document.create 返回创建提交的序号；后续按该序号读历史。
			const createdAt = await commitWrites(
				storage,
				[
					{
						type: "document.create",
						record: firstRecord,
						content: { kind: "base", version: 1, value: initial },
					},
				],
				context,
			);
			// appended 是稍后通过 splice 插入数组的片段，用于验证写入后修改不影响存储。
			const appended = ["b"];
			// Op 是 Chord 的文档操作：p 对数组做 splice(start, removeCount, ...items)，
			// 这里在 items 索引 1 处插入 ["b"]；s 把 nested.count 设为 2。
			const ops: Op[] = [
				["p", ["items"], 1, 0, appended],
				["s", ["nested", "count"], 2],
			];
			// delta 的 version 1 表示它基于 version 1 的 base；提交后返回 changedAt。
			const changedAt = await commitWrites(
				storage,
				[{ type: "document.change", id: firstId, content: { kind: "delta", version: 1, ops } }],
				context,
			);

			// 写入后修改调用方持有的初始对象与 appended 数组。
			(initial.items as string[]).push("caller mutation");
			appended.push("caller mutation");
			// 读取 createdAt 时的历史值：仍是 version 1 的 base，且未受调用方修改影响。
			expect(await storage.document(firstId, createdAt, context)).toMatchObject({
				version: 1,
				value: { items: ["a"], nested: { count: 1 } },
				deltasSinceBase: 0,
			});
			// 读取 changedAt：base 重放一条 delta，得到 items=[a,b]、count=2。
			const changed = (await storage.document(firstId, changedAt, context))!;
			expect(changed.value).toEqual({ items: ["a", "b"], nested: { count: 2 } });
			// deltasSinceBase 表示当前 base 之后重放了多少条 delta。
			expect(changed.deltasSinceBase).toBe(1);
			// 修改读回值不应影响存储；下一行用 current 读取验证。
			(changed.value.items as string[]).push("read mutation");
			expect((await storage.document(firstId, "current", context))?.value).toEqual({
				items: ["a", "b"],
				nested: { count: 2 },
			});

			// 写入 version 2 的完整 base；这会成为新的检查点/版本边界。
			const checkpointAt = await commitWrites(
				storage,
				[
					{
						type: "document.change",
						id: firstId,
						content: { kind: "base", version: 2, value: { items: ["checkpoint"], nested: { count: 3 } } },
					},
				],
				context,
			);
			// version 2 的 delta 用 r 整体替换根值；它基于新的 base。
			const replacedAt = await commitWrites(
				storage,
				[
					{
						type: "document.change",
						id: firstId,
						content: {
							kind: "delta",
							version: 2,
							ops: [["r", { items: ["replacement"], nested: { count: 4 } }]],
						},
					},
				],
				context,
			);
			// 历史读 changedAt 仍返回 version 1 的旧值，说明 base 之后的历史没有被覆盖。
			expect(await storage.document(firstId, changedAt, context)).toMatchObject({
				version: 1,
				value: { items: ["a", "b"], nested: { count: 2 } },
			});
			// checkpointAt 读取 version 2 base，deltasSinceBase 为 0。
			expect(await storage.document(firstId, checkpointAt, context)).toMatchObject({
				version: 2,
				value: { items: ["checkpoint"], nested: { count: 3 } },
				deltasSinceBase: 0,
			});
			// replacedAt 读取 version 2 base + 一条替换 delta，deltasSinceBase 为 1。
			expect(await storage.document(firstId, replacedAt, context)).toMatchObject({
				value: { items: ["replacement"], nested: { count: 4 } },
				deltasSinceBase: 1,
			});
			// current 与 replacedAt 的值相同，都是最新状态。
			expect((await storage.document(firstId, "current", context))?.deltasSinceBase).toBe(1);

			// 下面测试 retire 与“半个生命周期”的语义。
			const secondId = await storage.mintId<DocumentId>();
			// 同一批：创建新文档 → retire 旧文档 → 再对旧文档写 delta。
			// retire 之后的 change 不得让旧文档重新可见；新文档占用同一逻辑地址。
			const retiredAt = await commitWrites(
				storage,
				[
					{
						type: "document.create",
						record: { ...firstRecord, id: secondId },
						content: { kind: "base", version: 1, value: { items: ["new"] } },
					},
					{ type: "document.retire", id: firstId },
					{
						type: "document.change",
						id: firstId,
						content: { kind: "delta", version: 2, ops: [["s", ["retiring"], true]] },
					},
				],
				context,
			);
			// 逻辑地址只由 kind+scope 组成（没有 key 时是单例）。
			const address = { kind: firstRecord.kind, scope: firstRecord.scope };
			// 在 changedAt 时，地址仍解析到旧文档 firstId。
			expect((await storage.findDocument(address, changedAt, context))?.id).toBe(firstId);
			// 在 retiredAt 时，旧文档已退役，地址解析到同批创建的新文档。
			expect(await storage.findDocument(address, retiredAt, context)).toMatchObject({
				id: secondId,
				createdAt: retiredAt,
			});
			// 同一时刻扫描该 scope 只返回新文档；旧文档已不可见。
			expect(
				(
					await storage.scanDocuments({ scope: firstRecord.scope, at: changedAt }, 10, undefined, context)
				).items.map(({ id }) => id),
			).toEqual([firstId]);
			expect(
				(
					await storage.scanDocuments({ scope: firstRecord.scope, at: retiredAt }, 10, undefined, context)
				).items.map(({ id }) => id),
			).toEqual([secondId]);
			// 按 ID 读取旧文档在 retiredAt 时也返回 undefined。
			expect(await storage.document(firstId, retiredAt, context)).toBeUndefined();
			// 新文档的 current 值是自己的 base，不受旧文档 delta 影响。
			expect((await storage.document(secondId, "current", context))?.value).toEqual({ items: ["new"] });
		}),

		// 用例 19：长文档尾部。多次 delta 修改大数组，验证历史边界在整体替换 delta 前后都正确。
		createCase(options, "streams long document tails across root replacement deltas", async (storage) => {
			const rootId = await createRoot(storage);
			const id = await storage.mintId<DocumentId>();
			// 512 行的初始文档；每行有 value 和 stable 字段。
			const record = {
				id,
				kind: "conversation.long-tail",
				scope: { kind: "conversation", conversationId: rootId },
				history: "rewindable",
				fork: "asOf",
			} satisfies DocumentCreate;
			const initial = {
				revision: 0,
				rows: Array.from({ length: 512 }, (_, value) => ({ value, stable: `row-${value}` })),
			};
			// 创建 base version 1，返回 createdAt。
			const createdAt = await commitWrites(
				storage,
				[{ type: "document.create", record, content: { kind: "base", version: 1, value: initial } }],
				context,
			);
			// beforeReplacement 是独立副本，用作后续历史读的期望值；initial 本身不再修改。
			const beforeReplacement = structuredClone(initial);
			let beforeReplacementAt = createdAt;
			// 24 次 delta，每次都改一行 value 并提升 revision；index 用固定公式选行，保证确定性。
			for (let revision = 1; revision <= 24; revision++) {
				const index = (revision * 17) % beforeReplacement.rows.length;
				beforeReplacement.rows[index]!.value = -revision;
				beforeReplacement.revision = revision;
				// 记录最后一次 delta 的提交序号，作为“替换前”的历史坐标。
				beforeReplacementAt = await commitWrites(
					storage,
					[
						{
							type: "document.change",
							id,
							content: {
								kind: "delta",
								version: 1,
								ops: [
									["s", ["rows", index, "value"], -revision],
									["s", ["revision"], revision],
								],
							},
						},
					],
					context,
				);
			}

			// 整体替换：revision 跳到 100，rows 全部换成新值。
			const replacement = {
				revision: 100,
				rows: Array.from({ length: 512 }, (_, value) => ({ value: 10_000 + value, stable: `new-${value}` })),
			};
			// 保存替换值的快照；提交后还会修改 replacement，验证写入隔离。
			const replacementSnapshot = structuredClone(replacement);
			const replacementAt = await commitWrites(
				storage,
				[
					{
						type: "document.change",
						id,
						content: { kind: "delta", version: 1, ops: [["r", replacement]] },
					},
				],
				context,
			);
			// 提交完成后修改调用方对象；存储中的值应保持 replacementSnapshot。
			replacement.rows[0]!.value = -999;

			// 替换之后再写 24 条 delta；current 的期望值从替换快照继续演进。
			const current = structuredClone(replacementSnapshot);
			for (let revision = 101; revision <= 124; revision++) {
				const index = (revision * 19) % current.rows.length;
				current.rows[index]!.value = -revision;
				current.revision = revision;
				await commitWrites(
					storage,
					[
						{
							type: "document.change",
							id,
							content: {
								kind: "delta",
								version: 1,
								ops: [
									["s", ["rows", index, "value"], -revision],
									["s", ["revision"], revision],
								],
							},
						},
					],
					context,
				);
			}

			// 四个历史坐标分别应还原：初始 base、替换前、替换时、current。
			expect((await storage.document(id, createdAt, context))?.value).toEqual(initial);
			expect((await storage.document(id, beforeReplacementAt, context))?.value).toEqual(beforeReplacement);
			expect((await storage.document(id, replacementAt, context))?.value).toEqual(replacementSnapshot);
			// current 读取返回最新值；修改读回数组不应影响存储。
			const read = (await storage.document(id, "current", context))!;
			expect(read.value).toEqual(current);
			(read.value.rows as Array<{ value: number }>)[0]!.value = -1_000;
			// 再次读取仍是 current，证明读路径返回独立副本。
			expect((await storage.document(id, "current", context))?.value).toEqual(current);
		}),

		// 用例 20：document.copy 复制的是“存储中的 base 快照”，与源文档后续变化解耦；
		// 同一批里 copy 与 retire 源文档属于歧义源，必须拒绝且无副作用。
		createCase(
			options,
			"copies stored document bases independently and rejects ambiguous sources",
			async (storage) => {
				// 两个子会话作为复制目标。
				const rootId = await createRoot(storage);
				const childId = await storage.mintId<ConversationId>();
				const secondChildId = await storage.mintId<ConversationId>();
				await commitWrites(
					storage,
					[
						{ type: "conversation", value: { id: childId } },
						{ type: "conversation", value: { id: secondChildId } },
					],
					context,
				);
				// 源文档：可回放，按 asOf fork；初始 base version 2，count=1，rows 一行 base。
				const sourceId = await storage.mintId<DocumentId>();
				const sourceRecord = {
					id: sourceId,
					kind: "copy.source",
					scope: { kind: "conversation", conversationId: rootId },
					history: "rewindable",
					fork: "asOf",
				} satisfies DocumentCreate;
				const createdAt = await commitWrites(
					storage,
					[
						{
							type: "document.create",
							record: sourceRecord,
							content: { kind: "base", version: 2, value: { count: 1, rows: [{ value: "base" }] } },
						},
					],
					context,
				);
				// 源文档再写一条 version 2 delta：count=2，并在 rows 末尾插入 current。
				await commitWrites(
					storage,
					[
						{
							type: "document.change",
							id: sourceId,
							content: {
								kind: "delta",
								version: 2,
								ops: [
									["s", ["count"], 2],
									["p", ["rows"], 1, 0, [{ value: "current" }]],
								],
							},
						},
					],
					context,
				);
				// 三次复制：历史（createdAt）、当前（current）到不同会话、当前到根会话后立即 retire。
				const historicalCopyId = await storage.mintId<DocumentId>();
				const currentCopyId = await storage.mintId<DocumentId>();
				const retiredCopyId = await storage.mintId<DocumentId>();
				// childRecord 保留源的 kind，但替换 id 与 scope；history/fork 仍为 rewindable/asOf。
				const childRecord = (id: DocumentId, conversationId: ConversationId): DocumentCreate => ({
					id,
					kind: sourceRecord.kind,
					scope: { kind: "conversation", conversationId },
					history: "rewindable",
					fork: "asOf",
				});
				// 同一批提交三个 copy 和一个 retire；copy 的 source.at 决定复制哪个版本。
				await commitWrites(
					storage,
					[
						{
							type: "document.copy",
							record: childRecord(historicalCopyId, childId),
							source: { id: sourceId, at: createdAt },
						},
						{
							type: "document.copy",
							record: childRecord(currentCopyId, secondChildId),
							source: { id: sourceId, at: "current" },
						},
						{
							type: "document.copy",
							record: childRecord(retiredCopyId, rootId),
							source: { id: sourceId, at: "current" },
						},
						{ type: "document.retire", id: retiredCopyId },
					],
					context,
				);
				// 历史复制只包含创建时的 base（count=1），不含之后的 delta。
				expect(await storage.document(historicalCopyId, "current", context)).toMatchObject({
					version: 2,
					value: { count: 1, rows: [{ value: "base" }] },
				});
				// 当前复制包含 delta 后的值（count=2）。
				expect(await storage.document(currentCopyId, "current", context)).toMatchObject({
					version: 2,
					value: { count: 2, rows: [{ value: "base" }, { value: "current" }] },
				});
				// 同批 retire 的副本在 current 下不可见。
				expect(await storage.document(retiredCopyId, "current", context)).toBeUndefined();

				// 修改并 retire 源文档；副本应保持各自复制时的快照。
				await commitWrites(
					storage,
					[
						{
							type: "document.change",
							id: sourceId,
							content: { kind: "base", version: 2, value: { count: 99, rows: [] } },
						},
						{ type: "document.retire", id: sourceId },
					],
					context,
				);
				// 当前副本不受源文档后续 base 覆盖或 retire 影响，证明 copy 是独立副本。
				expect((await storage.document(currentCopyId, "current", context))?.value).toEqual({
					count: 2,
					rows: [{ value: "base" }, { value: "current" }],
				});

				// 再测 history: "latest"、fork: "current" 的源：它只保留当前值。
				const latestSourceId = await storage.mintId<DocumentId>();
				const latestCopyId = await storage.mintId<DocumentId>();
				const latestSource = {
					id: latestSourceId,
					kind: "copy.latest",
					scope: { kind: "conversation", conversationId: rootId },
					history: "latest",
					fork: "current",
				} satisfies DocumentCreate;
				// 源文档 base version 4，值是 retained: "copy"。
				await commitWrites(
					storage,
					[
						{
							type: "document.create",
							record: latestSource,
							content: { kind: "base", version: 4, value: { retained: "copy" } },
						},
					],
					context,
				);
				// 复制到 child 会话，source.at 为 current。
				await commitWrites(
					storage,
					[
						{
							type: "document.copy",
							record: {
								...latestSource,
								id: latestCopyId,
								scope: { kind: "conversation", conversationId: childId },
							},
							source: { id: latestSourceId, at: "current" },
						},
					],
					context,
				);
				// 源文档改成 source-only 并 retire；副本仍应是 retained: "copy"。
				await commitWrites(
					storage,
					[
						{
							type: "document.change",
							id: latestSourceId,
							content: { kind: "base", version: 4, value: { retained: "source-only" } },
						},
						{ type: "document.retire", id: latestSourceId },
					],
					context,
				);
				expect(await storage.document(latestCopyId, "current", context)).toMatchObject({
					version: 4,
					value: { retained: "copy" },
				});

				// 歧义源：同一批先 copy 一个文档、再 retire 它。
				// 存储必须拒绝整批；下面用 try/catch 捕获错误而不是用 expect rejects，因为还要检查副作用。
				const conflictId = await storage.mintId<DocumentId>();
				let conflictError: unknown;
				try {
					await commitWrites(
						storage,
						[
							{
								type: "document.copy",
								record: childRecord(conflictId, childId),
								source: { id: currentCopyId, at: "current" },
							},
							{ type: "document.retire", id: currentCopyId },
						],
						context,
					);
				} catch (error) {
					conflictError = error;
				}
				// 拒绝必须无副作用：新副本不存在，源文档也没有被 retire。
				// Rejected without effect: the copy and the retirement in the same batch are both absent.
				expect(conflictError instanceof Error).toBe(true);
				expect(await storage.document(conflictId, "current", context)).toBeUndefined();
				expect((await storage.document(currentCopyId, "current", context))?.value).toEqual({
					count: 2,
					rows: [{ value: "base" }, { value: "current" }],
				});

				// 另一个拒绝场景：copy 记录的 kind 与源文档不一致（copy.mismatch vs copy.source）。
				const mismatchId = await storage.mintId<DocumentId>();
				let mismatchError: unknown;
				try {
					await commitWrites(
						storage,
						[
							{
								type: "document.copy",
								record: { ...childRecord(mismatchId, childId), kind: "copy.mismatch" },
								source: { id: currentCopyId, at: "current" },
							},
						],
						context,
					);
				} catch (error) {
					mismatchError = error;
				}
				// 同样整批拒绝，副本不存在。
				expect(mismatchError instanceof Error).toBe(true);
				expect(await storage.document(mismatchId, "current", context)).toBeUndefined();
			},
		),

		// 用例 21：版本迁移必须用 base；current-only 文档拒绝历史读。
		createCase(
			options,
			"uses bases for version transitions and rejects historical reads of current-only documents",
			async (storage) => {
				// 根会话只需存在，返回值不使用。
				await createRoot(storage);
				const id = await storage.mintId<DocumentId>();
				// session 作用域文档不声明 history/fork，属于 current-only。
				const record = {
					id,
					kind: "session.settings",
					scope: { kind: "session" },
				} satisfies DocumentCreate;
				// version 1 base，count=1。
				await commitWrites(
					storage,
					[{ type: "document.create", record, content: { kind: "base", version: 1, value: { count: 1 } } }],
					context,
				);
				// version 1 delta，count=2。
				await commitWrites(
					storage,
					[{ type: "document.change", id, content: { kind: "delta", version: 1, ops: [["s", ["count"], 2]] } }],
					context,
				);
				// 用 version 2 base 迁移，count=3；之后 current 是 version 2。
				const migratedAt = await commitWrites(
					storage,
					[{ type: "document.change", id, content: { kind: "base", version: 2, value: { count: 3 } } }],
					context,
				);
				expect(await storage.document(id, "current", context)).toMatchObject({ version: 2, value: { count: 3 } });
				// current-only 文档不保留历史，因此按提交序号读取必须拒绝。
				await expect(storage.document(id, migratedAt, context)).rejects.toThrow(
					"does not retain historical content",
				);

				// 已是 version 2 base 后，再写 version 1 delta 属于非法版本转换：必须用新 base。
				await expect(
					commitWrites(
						storage,
						[{ type: "document.change", id, content: { kind: "delta", version: 1, ops: [["s", ["count"], 4]] } }],
						context,
					),
				).rejects.toThrow("version transition requires a base");
				// 被拒绝的提交没有改变 current 值。
				expect((await storage.document(id, "current", context))?.value).toEqual({ count: 3 });
				// retire 后 current 读取为 undefined。
				await commitWrites(storage, [{ type: "document.retire", id }], context);
				expect(await storage.document(id, "current", context)).toBeUndefined();
			},
		),

		// 用例 22：逻辑地址（kind+scope+key）与精确 scope 扫描互相独立；
		// 单例文档没有 key，family 文档有 key，二者可共存。
		createCase(options, "indexes logical addresses and exact-scope scans independently", async (storage) => {
			const rootId = await createRoot(storage);
			// 多个文档 ID 与会话/任务 ID 都来自全局命名空间。
			const firstId = await storage.mintId<DocumentId>();
			const secondId = await storage.mintId<DocumentId>();
			const conversationId = await storage.mintId<DocumentId>();
			const taskId = await storage.mintId<TaskId<JsonValue>>();
			const taskSingletonId = await storage.mintId<DocumentId>();
			const taskFamilyId = await storage.mintId<DocumentId>();
			const taskOtherKindId = await storage.mintId<DocumentId>();
			// 一次提交创建六类文档：session 单例（两个特殊 key）、conversation 文档、
			// task 单例、task family、task 其他 kind。
			const createdAt = await commitWrites(
				storage,
				[
					{ type: "task", value: pendingTask(taskId, rootId) },
					{
						type: "document.create",
						record: {
							id: firstId,
							kind: "cache",
							scope: { kind: "session" },
							key: "__proto__",
						},
						content: { kind: "base", version: 1, value: { owner: "first" } },
					},
					{
						type: "document.create",
						record: {
							id: secondId,
							kind: "cache",
							scope: { kind: "session" },
							key: "constructor",
						},
						content: { kind: "base", version: 1, value: { owner: "second" } },
					},
					{
						type: "document.create",
						record: {
							id: conversationId,
							kind: "cache",
							scope: { kind: "conversation", conversationId: rootId },
							history: "latest",
							fork: "current",
							key: "__proto__",
						},
						content: { kind: "base", version: 1, value: { owner: "conversation" } },
					},
					{
						type: "document.create",
						record: {
							id: taskSingletonId,
							kind: "task.cache",
							scope: { kind: "task", taskId },
						},
						content: { kind: "base", version: 1, value: { owner: "singleton" } },
					},
					{
						type: "document.create",
						record: {
							id: taskFamilyId,
							kind: "task.cache",
							scope: { kind: "task", taskId },
							key: "member",
						},
						content: { kind: "base", version: 1, value: { owner: "family" } },
					},
					{
						type: "document.create",
						record: {
							id: taskOtherKindId,
							kind: "task.other",
							scope: { kind: "task", taskId },
						},
						content: { kind: "base", version: 1, value: { owner: "other" } },
					},
				],
				context,
			);

			// 按 kind+scope+key 精确查找 session 文档 __proto__，应命中 firstId。
			expect(
				(
					await storage.findDocument(
						{ kind: "cache", scope: { kind: "session" }, key: "__proto__" },
						"current",
						context,
					)
				)?.id,
			).toBe(firstId);
			// session scope 扫描只包含 session 文档；先确认每页大小 1。
			expect(
				(await storage.scanDocuments({ scope: { kind: "session" }, at: "current" }, 1, undefined, context)).items,
			).toHaveLength(1);
			// 分页扫描 session 文档，两页合起来按 ID 升序是 [firstId, secondId]。
			const first = await storage.scanDocuments(
				{ scope: { kind: "session" }, at: "current" },
				1,
				undefined,
				context,
			);
			const second = await storage.scanDocuments(
				{ scope: { kind: "session" }, at: "current" },
				1,
				first.next,
				context,
			);
			expect([...first.items, ...second.items].map(({ id }) => id)).toEqual([firstId, secondId]);
			// conversation scope 扫描只返回该会话的文档，不混入 session/task。
			expect(
				(
					await storage.scanDocuments(
						{ scope: { kind: "conversation", conversationId: rootId }, at: "current" },
						10,
						undefined,
						context,
					)
				).items.map(({ id }) => id),
			).toEqual([conversationId]);
			// task 单例查找不带 key，命中 taskSingletonId。
			expect(
				(await storage.findDocument({ kind: "task.cache", scope: { kind: "task", taskId } }, "current", context))
					?.id,
			).toBe(taskSingletonId);
			// task family 查找带 key "member"，命中 taskFamilyId。
			expect(
				(
					await storage.findDocument(
						{ kind: "task.cache", scope: { kind: "task", taskId }, key: "member" },
						"current",
						context,
					)
				)?.id,
			).toBe(taskFamilyId);
			// 按 task scope + kind 扫描，返回该 kind 的单例与 family 两个文档。
			expect(
				(
					await storage.scanDocuments(
						{ scope: { kind: "task", taskId }, at: "current", kind: "task.cache" },
						10,
						undefined,
						context,
					)
				).items.map(({ id }) => id),
			).toEqual([taskSingletonId, taskFamilyId]);
			// task 文档没有声明 history，日期读取应拒绝（current-only）。
			await expect(storage.document(taskSingletonId, createdAt, context)).rejects.toThrow(
				"does not retain historical content",
			);
		}),

		// 用例 23：文档生命周期错误的原子性，以及 create+retire 同批产生的“空生命周期”。
		createCase(
			options,
			"keeps document lifecycle failures atomic and gives create-plus-retire an empty lifetime",
			async (storage) => {
				// 根会话与两个文档 ID；record 是 session 单例地址。
				const rootId = await createRoot(storage);
				const firstId = await storage.mintId<DocumentId>();
				const secondId = await storage.mintId<DocumentId>();
				const record = {
					id: firstId,
					kind: "singleton",
					scope: { kind: "session" },
				} satisfies DocumentCreate;
				// 先创建一个单例文档。
				await commitWrites(
					storage,
					[{ type: "document.create", record, content: { kind: "base", version: 1, value: { value: 1 } } }],
					context,
				);
				// 同批再创建一个同地址单例（second）并修改 first；冲突应导致整批拒绝。
				await expect(
					commitWrites(
						storage,
						[
							{
								type: "document.create",
								record: { ...record, id: secondId },
								content: { kind: "base", version: 1, value: { value: 2 } },
							},
							{ type: "document.change", id: firstId, content: { kind: "delta", version: 1, ops: [] } },
						],
						context,
					),
					// 拒绝原因是该逻辑地址已有 current incarnation。
				).rejects.toThrow("already has a current incarnation");
				// first 的值未被同批的 change 修改。
				expect((await storage.document(firstId, "current", context))?.value).toEqual({ value: 1 });
				// second 根本没有被创建。
				expect(await storage.document(secondId, "current", context)).toBeUndefined();

				// 空生命周期：同一批 create 后立刻 retire。
				const emptyId = await storage.mintId<DocumentId>();
				// 提交序号 emptyAt 标记这次 create+retire 的时刻。
				const emptyAt = await commitWrites(
					storage,
					[
						{
							type: "document.create",
							record: {
								id: emptyId,
								kind: record.kind,
								key: "empty",
								scope: { kind: "conversation", conversationId: rootId },
								history: "rewindable",
								fork: "initial",
							},
							content: { kind: "base", version: 1, value: {} },
						},
						{ type: "document.retire", id: emptyId },
					],
					context,
				);
				// 当前不可见。
				expect(await storage.document(emptyId, "current", context)).toBeUndefined();
				// 在 emptyAt 这个时刻也不可见：生命周期长度为零，没有任何历史时刻能看到它。
				expect(await storage.document(emptyId, emptyAt, context)).toBeUndefined();
				// 逻辑地址在 emptyAt 也解析不到该文档。
				expect(
					await storage.findDocument(
						{
							kind: record.kind,
							scope: { kind: "conversation", conversationId: rootId },
							key: "empty",
						},
						emptyAt,
						context,
					),
				).toBeUndefined();
			},
		),

		// 用例 24：同一批同时对同一文档执行 create 与 change，无论顺序都算“多个内容命令”而拒绝。
		createCase(
			options,
			"refuses a creation and a change of one document in one commit, in either order",
			async (storage) => {
				await createRoot(storage);
				// 两种顺序各测一次；as const 保留字面量类型。
				for (const order of ["create first", "change first"] as const) {
					const id = await storage.mintId<DocumentId>();
					// create 与 change 都显式标注 StorageWrite，确保判别联合的类型检查。
					const create: StorageWrite = {
						type: "document.create",
						record: { id, kind: "twice", key: order, scope: { kind: "session" } },
						content: { kind: "base", version: 1, value: { x: 1 } },
					};
					const change: StorageWrite = {
						type: "document.change",
						id,
						content: { kind: "delta", version: 1, ops: [["s", ["x"], 2]] },
					};
					// 根据顺序组装批次。
					const writes = order === "create first" ? [create, change] : [change, create];
					// 两种顺序都必须以 "more than one content command" 拒绝，且不留下文档。
					await expect(commitWrites(storage, writes, context)).rejects.toThrow("more than one content command");
					expect(await storage.document(id, "current", context)).toBeUndefined();
				}
			},
		),

		// 用例 25：文档命令失败时，记录表与二级索引（task/submission 状态、requestId、逻辑地址）
		// 必须和 entry/document 一起回滚。
		createCase(
			options,
			"rolls back record tables and secondary indexes when a document command fails",
			async (storage) => {
				// 准备 task、submission、document 三类前置记录。
				const rootId = await createRoot(storage);
				const taskId = await storage.mintId<TaskId<JsonValue>>();
				const submissionId = await storage.mintId<SubmissionId>();
				const documentId = await storage.mintId<DocumentId>();
				const task = pendingTask(taskId, rootId);
				const submission: SubmissionRecord = {
					id: submissionId,
					conversationId: rootId,
					requestId: "atomic",
					type: "input",
					status: "queued",
				};
				const record = {
					id: documentId,
					kind: "atomic",
					scope: { kind: "session" },
				} satisfies DocumentCreate;
				// 基线提交返回序号 baselineSeq。
				const baselineSeq = await commitWrites(
					storage,
					[
						{ type: "task", value: task },
						{ type: "submission", value: submission },
						{ type: "document.create", record, content: { kind: "base", version: 1, value: { count: 1 } } },
					],
					context,
				);

				// 失败批次：更新的 task/submission、一个新 entry、一个新文档。
				// 文档 create 与已有单例地址冲突，因此整批拒绝。
				const entryId = await storage.mintId<EntryId>();
				const conflictingDocumentId = await storage.mintId<DocumentId>();
				await expect(
					commitWrites(
						storage,
						[
							{
								type: "task",
								value: { ...task, state: { status: "running", checkpoint: { phase: "effect" } } },
							},
							{
								type: "submission",
								value: { ...submission, status: "unanswered", reason: "failed" },
							},
							{ type: "entry", value: entry(entryId, rootId, "transient") },
							{
								type: "document.create",
								record: { ...record, id: conflictingDocumentId },
								content: { kind: "base", version: 1, value: { count: 2 } },
							},
						],
						context,
					),
					// 冲突消息与用例 23 一致：已有 current incarnation。
				).rejects.toThrow("already has a current incarnation");

				// task 仍是初始对象，pending 索引也仍只有它。
				expect(await storage.task(taskId, context)).toEqual(task);
				expect((await storage.scanTasks({ status: "pending" }, 10, undefined, context)).items).toEqual([task]);
				// submissionByRequest 仍返回初始提交。
				expect(await storage.submissionByRequest(rootId, "atomic", context)).toEqual(submission);
				// 新 entry 不存在。
				expect(await storage.entry(entryId, context)).toBeUndefined();
				// 新文档不存在。
				expect(await storage.document(conflictingDocumentId, "current", context)).toBeUndefined();
				// 逻辑地址仍解析到原文档。
				expect(
					(await storage.findDocument({ kind: record.kind, scope: record.scope }, "current", context))?.id,
				).toBe(documentId);
				// 回滚后继续写入成功，序号大于基线，说明失败批次没有推进持久状态。
				const afterRollbackSeq = await commitWrites(
					storage,
					[
						{
							type: "document.change",
							id: documentId,
							content: { kind: "delta", version: 1, ops: [["s", ["count"], 3]] },
						},
					],
					context,
				);
				expect(afterRollbackSeq).toBeGreaterThan(baselineSeq);
			},
		),

		// 用例 26：字符串身份必须无损。JS 字符串允许孤立代理项（\ud800/\ud801），
		// 索引键不能用会做 Unicode 规范化的编码，否则两个不同 kind/key/requestId 会串。
		createCase(options, "keeps indexed string identities lossless", async (storage) => {
			const rootId = await createRoot(storage);
			// 两个孤立高代理项在 UTF-16 中不同；它们不是合法 Unicode 标量，但仍是不同的 JS 字符串。
			const first = "\ud800";
			const second = "\ud801";
			const firstTaskId = await storage.mintId<TaskId<JsonValue>>();
			const secondTaskId = await storage.mintId<TaskId<JsonValue>>();
			const firstSubmissionId = await storage.mintId<SubmissionId>();
			const secondSubmissionId = await storage.mintId<SubmissionId>();
			const firstKindDocumentId = await storage.mintId<DocumentId>();
			const secondKindDocumentId = await storage.mintId<DocumentId>();
			const firstKeyDocumentId = await storage.mintId<DocumentId>();
			const secondKeyDocumentId = await storage.mintId<DocumentId>();
			// 任务 kind、提交 requestId、文档 kind、文档 key 各写一对仅差一个代理项的值。
			await commitWrites(
				storage,
				[
					{ type: "task", value: { ...pendingTask(firstTaskId, rootId), kind: first } },
					{ type: "task", value: { ...pendingTask(secondTaskId, rootId), kind: second } },
					{
						type: "submission",
						value: {
							id: firstSubmissionId,
							conversationId: rootId,
							requestId: first,
							type: "input",
							status: "queued",
						},
					},
					{
						type: "submission",
						value: {
							id: secondSubmissionId,
							conversationId: rootId,
							requestId: second,
							type: "input",
							status: "queued",
						},
					},
					{
						type: "document.create",
						record: { id: firstKindDocumentId, kind: first, scope: { kind: "session" } },
						content: { kind: "base", version: 1, value: { identity: "first kind" } },
					},
					{
						type: "document.create",
						record: { id: secondKindDocumentId, kind: second, scope: { kind: "session" } },
						content: { kind: "base", version: 1, value: { identity: "second kind" } },
					},
					{
						type: "document.create",
						record: { id: firstKeyDocumentId, kind: "family", key: first, scope: { kind: "session" } },
						content: { kind: "base", version: 1, value: { identity: "first key" } },
					},
					{
						type: "document.create",
						record: { id: secondKeyDocumentId, kind: "family", key: second, scope: { kind: "session" } },
						content: { kind: "base", version: 1, value: { identity: "second key" } },
					},
				],
				context,
			);

			// 按 kind 扫描任务必须区分两个代理项。
			expect((await storage.scanTasks({ kind: first }, 10, undefined, context)).items.map(({ id }) => id)).toEqual([
				firstTaskId,
			]);
			expect((await storage.scanTasks({ kind: second }, 10, undefined, context)).items.map(({ id }) => id)).toEqual([
				secondTaskId,
			]);
			// 读回记录保留原始字符串。
			expect((await storage.task(firstTaskId, context))?.kind).toBe(first);
			expect((await storage.task(secondTaskId, context))?.kind).toBe(second);
			// submissionByRequest 用 requestId 索引，也必须无损。
			expect((await storage.submissionByRequest(rootId, first, context))?.requestId).toBe(first);
			expect((await storage.submissionByRequest(rootId, first, context))?.id).toBe(firstSubmissionId);
			expect((await storage.submissionByRequest(rootId, second, context))?.id).toBe(secondSubmissionId);
			// 文档 kind 索引区分两个值。
			expect((await storage.findDocument({ kind: first, scope: { kind: "session" } }, "current", context))?.id).toBe(
				firstKindDocumentId,
			);
			expect(
				(await storage.findDocument({ kind: second, scope: { kind: "session" } }, "current", context))?.id,
			).toBe(secondKindDocumentId);
			// 文档 key 索引同样区分。
			expect(
				(await storage.findDocument({ kind: "family", key: first, scope: { kind: "session" } }, "current", context))
					?.id,
			).toBe(firstKeyDocumentId);
			expect(
				(
					await storage.findDocument(
						{ kind: "family", key: second, scope: { kind: "session" } },
						"current",
						context,
					)
				)?.id,
			).toBe(secondKeyDocumentId);
			// 按 kind 过滤的 scanDocuments 也只返回对应文档。
			expect(
				(
					await storage.scanDocuments(
						{ scope: { kind: "session" }, at: "current", kind: first },
						10,
						undefined,
						context,
					)
				).items.map(({ id }) => id),
			).toEqual([firstKindDocumentId]);
		}),

		// 用例 27：所有表共享一个全局 ID 命名空间；显式 ID 会推进分配器；耗尽后稳定拒绝。
		createCase(options, "keeps one global record ID namespace and rejects exhausted ID minting", async (storage) => {
			const rootId = await createRoot(storage);
			// 显式提交 ID 100 的条目，不经过 mintId。
			const explicitEntryId = idFromNumber<EntryId>(100);
			await commitWrites(storage, [{ type: "entry", value: entry(explicitEntryId, rootId) }], context);
			// mintId 必须避开已用 ID：下一个是 101，而不是 2 或 100。
			expect(await storage.mintId<EntryId>()).toBe(101);
			// 其他表也不能复用 100；错误消息指出它已属于 entry。
			await expect(
				commitWrites(
					storage,
					[{ type: "task", value: pendingTask(idFromNumber<TaskId<JsonValue>>(explicitEntryId), rootId) }],
					context,
				),
			).rejects.toThrow(`ID ${explicitEntryId} already belongs to entry`);

			// 写入 MAX_SAFE_INTEGER 作为最后一个可用 ID。
			await commitWrites(
				storage,
				[{ type: "entry", value: entry(idFromNumber<EntryId>(Number.MAX_SAFE_INTEGER), rootId, "last-id") }],
				context,
			);
			// 再分配即耗尽；重复调用仍应拒绝（不是一次性错误）。
			await expect(storage.mintId<EntryId>()).rejects.toThrow("ID space is exhausted");
			await expect(storage.mintId<EntryId>()).rejects.toThrow("ID space is exhausted");
		}),

		// 用例 28：多批 commit 按顺序提交，每批一个回执；所有回执都在 resolve 前送达。
		createCase(
			options,
			"commits batches in order, each with its seq, checked against the earlier ones",
			async (storage) => {
				const rootId = await createRoot(storage);
				// 两个条目 ID 与一个文档 ID。
				const firstId = await storage.mintId<EntryId>();
				const lastId = await storage.mintId<EntryId>();
				const documentId = await storage.mintId<DocumentId>();
				// receipts 记录 (index, seq)；read 保存回调里启动的读取。
				const receipts: [number, Seq][] = [];
				let read: ReturnType<Storage["entry"]> | undefined;
				// 三个批次：创建 entry+document → 修改该 document → 再创建 entry。
				const result = await storage.commit(
					[
						[
							{ type: "entry", value: entry(firstId, rootId) },
							{
								type: "document.create",
								record: {
									id: documentId,
									kind: "batch.doc",
									scope: { kind: "conversation", conversationId: rootId },
									history: "latest",
									fork: "initial",
								},
								content: { kind: "base", version: 1, value: { count: 1 } },
							},
						],
						// 第二批依赖第一批创建的文档，验证批次按顺序作用在同一状态上。
						// Changes the document the batch before created.
						[
							{
								type: "document.change",
								id: documentId,
								content: { kind: "delta", version: 1, ops: [["s", ["count"], 2]] },
							},
						],
						[{ type: "entry", value: entry(lastId, rootId) }],
					],
					// 回执回调：先记录 (index, seq)，再在第一个回执时启动对最后一条条目的读取。
					(index, seq) => {
						receipts.push([index, seq]);
						// 所有批次都已持久化后才投递回执，因此第一个回执时读取 lastId 也能观察到第三批。
						// read ??= 只在第一次回调时赋值，后续回执复用同一个 Promise。
						// Receipts follow the last durable batch: a read started at the first observes it.
						read ??= storage.entry(lastId, context);
					},
					context,
				);
				// 三批全部存储成功，没有拒绝字段。
				expect(result).toEqual({ stored: 3 });
				// 回执下标严格是 0、1、2。
				expect(receipts.map(([index]) => index)).toEqual([0, 1, 2]);
				// 解构三个回执；类型断言让每个元组是 [number, Seq]，避免 Seq | undefined。
				const [[, first], [, second], [, last]] = receipts as [[number, Seq], [number, Seq], [number, Seq]];
				// 序号跨批次严格递增。
				expect(second).toBeGreaterThan(first);
				expect(last).toBeGreaterThan(second);
				// 第一个回执时启动的读取最终看到最后一个批次的 commitSeq。
				expect((await read)?.commitSeq).toBe(last);
				// firstId 只出现在第一批，因此 commitSeq 等于第一个回执的 seq。
				expect((await storage.entry(firstId, context))?.commitSeq).toBe(first);
				// 第二批的 delta 已生效，current 值为 count=2。
				expect((await storage.document(documentId, "current", context))?.value).toEqual({ count: 2 });
				// 后续提交的序号继续大于最后回执，证明批次顺序与全局序号一致。
				const next = await commitWrites(
					storage,
					[{ type: "entry", value: entry(await storage.mintId<EntryId>(), rootId) }],
					context,
				);
				expect(next).toBeGreaterThan(last);
			},
		),

		// 用例 29：拒绝发生在中间批次时，之前的批次保留，之后的批次不执行。
		createCase(options, "stores the batches before the first one refused, and none after it", async (storage) => {
			const rootId = await createRoot(storage);
			const firstId = await storage.mintId<EntryId>();
			const afterId = await storage.mintId<EntryId>();
			// 只记录 index，足以验证哪些批次收到了回执。
			const receipts: number[] = [];
			// 第一批写 first；第二批写 task 并重复写 first（冲突）；第三批写 after。
			const result = await storage.commit(
				[
					[{ type: "entry", value: entry(firstId, rootId) }],
					// 冲突是相对于第一批之后的状态判断的：first 此时已被占用。
					// Refused against the state the first batch left: the ID is taken now.
					[
						{ type: "task", value: pendingTask(await storage.mintId<TaskId<JsonValue>>(), rootId) },
						{ type: "entry", value: entry(firstId, rootId) },
					],
					[{ type: "entry", value: entry(afterId, rootId) }],
				],
				(index) => receipts.push(index),
				context,
			);
			// 恰好存储第一批。
			expect(result.stored).toBe(1);
			// 拒绝原因是 first 已属于 entry。
			expect(String(result.refused)).toBe(`Error: ID ${firstId} already belongs to entry`);
			// 只有下标 0 收到回执；第二、三批没有回执。
			expect(receipts).toEqual([0]);
			// 第一批的条目可见；第二/三批的条目不可见。
			expect(await storage.entry(firstId, context)).toBeDefined();
			expect(await storage.entry(afterId, context)).toBeUndefined();
			// 第二批整个回滚，因此 task 表为空。
			expect((await storage.scanTasks({}, 10, undefined, context)).items.map((task) => task.id)).toEqual([]);

			// 第一批就被拒绝时 stored=0；存储仍可继续使用。
			// A refused first batch stores nothing; the storage goes on.
			const refused = await storage.commit(
				[[{ type: "conversation", value: { id: rootId } }]],
				(index) => receipts.push(index),
				context,
			);
			// 没有批次落盘，也没有新回执（receipts 仍是 [0]）。
			expect(refused.stored).toBe(0);
			expect(String(refused.refused)).toBe(`Error: ID ${rootId} already belongs to conversation`);
			expect(receipts).toEqual([0]);
			// 之后正常提交 after 条目成功。
			await commitWrites(storage, [{ type: "entry", value: entry(afterId, rootId) }], context);
			expect(await storage.entry(afterId, context)).toBeDefined();
		}),

		// 用例 30：后续批次自身格式非法（同一文档 retire 两次）时，同批写入全部不生效，
		// 但之前的批次保留。
		createCase(
			options,
			"refuses a later batch its own malformed actions fail, keeping the batches before it",
			async (storage) => {
				const rootId = await createRoot(storage);
				// 准备一个现存文档，稍后在非法批次里重复 retire。
				const documentId = await storage.mintId<DocumentId>();
				await commitWrites(
					storage,
					[
						{
							type: "document.create",
							record: { id: documentId, kind: "staged", scope: { kind: "session" } },
							content: { kind: "base", version: 1, value: { n: 1 } },
						},
					],
					context,
				);
				// 三个条目 ID：第一批、非法批次、之后批次各一个。
				const firstId = await storage.mintId<EntryId>();
				const secondId = await storage.mintId<EntryId>();
				const afterId = await storage.mintId<EntryId>();
				const receipts: number[] = [];
				// 第二批同时包含 entry 和两个 document.retire，重复 retire 使该批在语义上非法。
				const result = await storage.commit(
					[
						[{ type: "entry", value: entry(firstId, rootId) }],
						// 非法性与存储状态无关：仅这一批自身就足以判定失败。
						// Malformed in itself, whatever is stored: one document retired twice.
						[
							{ type: "entry", value: entry(secondId, rootId) },
							{ type: "document.retire", id: documentId },
							{ type: "document.retire", id: documentId },
						],
						[{ type: "entry", value: entry(afterId, rootId) }],
					],
					(index) => receipts.push(index),
					context,
				);
				// 第一批成功存储。
				expect(result.stored).toBe(1);
				// refused 存在即可；这里不锁定具体错误消息。
				expect(result.refused).toBeDefined();
				// 只有第一批有回执。
				expect(receipts).toEqual([0]);
				// 第一批条目存在；非法批次的条目与第三批条目都不存在。
				expect(await storage.entry(firstId, context)).toBeDefined();
				expect(await storage.entry(secondId, context)).toBeUndefined();
				expect(await storage.entry(afterId, context)).toBeUndefined();
				// 文档仍保持原值，重复 retire 没有部分生效。
				expect((await storage.document(documentId, "current", context))?.value).toEqual({ n: 1 });
			},
		),

		// 用例 31：同一 commit 的后续批次能看到更早批次留下的状态；copy 解析也遵循这一点。
		createCase(options, "resolves a batched copy against the state the earlier batches left", async (storage) => {
			const rootId = await createRoot(storage);
			// 子会话、源文档、副本 ID。
			const childId = await storage.mintId<ConversationId>();
			const sourceId = await storage.mintId<DocumentId>();
			const copyId = await storage.mintId<DocumentId>();
			// 统一的文档记录工厂：可回放、asOf fork。
			const record = (id: DocumentId, conversationId: ConversationId): DocumentCreate => ({
				id,
				kind: "batch.copy",
				scope: { kind: "conversation", conversationId },
				history: "rewindable",
				fork: "asOf",
			});
			// 记录每批回执 seq，稍后用于历史读。
			const seqs: Seq[] = [];
			// 三批：创建源 → 修改源 → 创建子会话并复制源的 current 值。
			const result = await storage.commit(
				[
					[
						{
							type: "document.create",
							record: record(sourceId, rootId),
							content: { kind: "base", version: 1, value: { count: 1 } },
						},
					],
					[
						{
							type: "document.change",
							id: sourceId,
							content: { kind: "delta", version: 1, ops: [["s", ["count"], 2]] },
						},
					],
					[
						{ type: "conversation", value: { id: childId } },
						{
							type: "document.copy",
							record: record(copyId, childId),
							source: { id: sourceId, at: "current" },
						},
					],
				],
				(_index, seq) => seqs.push(seq),
				context,
			);
			// 三批全部成功。
			expect(result).toEqual({ stored: 3 });
			// 副本看到第二批 delta 后的值 count=2。
			expect((await storage.document(copyId, "current", context))?.value).toEqual({ count: 2 });
			// 源文档在第一批 seq 时的历史值为 count=1。
			expect((await storage.document(sourceId, seqs[0]!, context))?.value).toEqual({ count: 1 });

			// 同一批里 copy 源 + change 源：copy 的源在该批内是歧义的，必须拒绝且不写入任何内容。
			// A copy whose source the same batch changes is refused before the batch writes anything.
			// 为被拒绝批次准备的子会话与副本 ID。
			const laterId = await storage.mintId<ConversationId>();
			const laterCopyId = await storage.mintId<DocumentId>();
			const refused = await storage.commit(
				[
					[
						{ type: "conversation", value: { id: laterId } },
						{
							type: "document.copy",
							record: record(laterCopyId, laterId),
							source: { id: sourceId, at: "current" },
						},
						{
							type: "document.change",
							id: sourceId,
							content: { kind: "delta", version: 1, ops: [["s", ["count"], 3]] },
						},
					],
				],
				() => {},
				context,
			);
			// 整批 stored=0。
			expect(refused.stored).toBe(0);
			expect(refused.refused).toBeDefined();
			// 子会话没有被创建；源文档也保持 count=2。
			expect(await storage.conversation(laterId, context)).toBeUndefined();
			expect((await storage.document(sourceId, "current", context))?.value).toEqual({ count: 2 });
		}),

		// 用例 32：close 之后所有公开操作都以包含 "closed" 的错误拒绝。
		createCase(options, "rejects every operation after close", async (storage) => {
			// 先建根会话，再关闭存储。
			await createRoot(storage);
			await storage.close(context);
			// 读取、提交、ID 分配三类操作都在关闭后拒绝。
			await expect(storage.conversation(ROOT_CONVERSATION_ID, context)).rejects.toThrow("closed");
			await expect(
				commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context),
			).rejects.toThrow("closed");
			await expect(storage.mintId<ConversationId>()).rejects.toThrow("closed");
		}),
	];
}
