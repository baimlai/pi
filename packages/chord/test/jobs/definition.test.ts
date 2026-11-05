// Tests of job definitions (§15): what `defineJob` checks at declaration (names, versions, closed JSON args, a
// singleton state, concurrency, the shape of `accepts`, `persist` refused before slice 6) and the types it gives.

import { describe, expect, expectTypeOf, it } from "vitest";
import { bytes, int, map, obj, str, unknown } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { defineJob, type JobDefinition } from "../../src/jobs/index.ts";

// 任务的状态文档是单个 JSON 对象；schema 同时给出 TS 推导所需的形状和首次初值校验的规则。
const Progress = defineState("app.progress", {
	// output 只能是字符串；这不是每次运行结果都要经过的校验器。
	schema: obj({ output: str() }),
	version: 1,
	// 无参初值函数返回一个新对象，例如新任务开始时 output 为 ""；不会在此处执行 shell。
	initial: () => ({ output: "" }),
});

// keyed: true 表示同一定义按键拥有多个文档，下面用它证明 job.state 不接受这种定义。
const Keyed = defineState("app.keyed", {
	schema: obj({ output: str() }),
	version: 1,
	initial: () => ({ output: "" }),
	keyed: true,
});

// obj 默认封闭对象，未知字段会在任务 start 时被拒绝；这里只声明必填 command 字符串。
const args = obj({ command: str() });

// 此分组同步注册声明期测试；没有任务宿主，也不调用 run。例：把 version 改成 0 会在 defineJob 时抛错。
describe("defineJob", () => {
	// 无参用例建立有/无状态的定义，返回 void；检查元数据、schema 复制和静态类型，不产生任务运行。
	it("keeps its name, version, Chord's copies of its schemas, its state and concurrency", () => {
		// 并发 1 是每个拥有对象的限制，version 2 只是本任务定义版本。
		const Shell = defineJob("app.shell", { version: 2, args, result: int(), state: Progress, concurrency: 1 });
		// toMatchObject 检查列出的字段；没提供 accepts 时定义内保存空映射表。
		expect(Shell).toMatchObject({ name: "app.shell", version: 2, state: Progress, concurrency: 1, accepts: {} });
		// toBe 比较引用；not.toBe 证明内部 schema 不直接使用调用者的原对象。
		expect(Shell.args.schema).not.toBe(args);
		// expectTypeOf 的泛型证明由类型检查器完成，不会在运行时遍历 command/output。
		expectTypeOf(Shell).toEqualTypeOf<JobDefinition<{ command: string }, number, { output: string }>>();
		// 不声明 state 时，JobDefinition 的第三个类型参数应是 undefined。
		const Plain = defineJob("app.plain", { version: 1, args, result: str() });
		expectTypeOf(Plain).toEqualTypeOf<JobDefinition<{ command: string }, string, undefined>>();
	});

	// 同步遍历合法/非法名称并断言声明结果；例如 app:run 被拒绝而 @app/jobs.run_1~x-y 可用。
	it('takes a restricted name only: lowercase [a-z0-9@/._~-] (decision "Restricted names")', () => {
		// 没有花括号的 for 只循环执行紧随其后的一条 expect。
		for (const name of ["@app/jobs.run_1~x-y", "a"])
			expect(defineJob(name, { version: 1, args, result: int() }).name).toBe(name);
		// 空串、大写、冒号、空格、NUL、孤立代理项和非 ASCII 字母都不在允许集合内。
		for (const name of ["", "App.run", "app:run", "app run", "a\0b", "a\uD800", "é"]) {
			// 传函数给 toThrow 才能捕获同步异常；JSON.stringify 让不可见字符也出现在预期错误里。
			expect(() => defineJob(name, { version: 1, args, result: int() })).toThrow(
				`A job name ${JSON.stringify(name)}: expected lowercase [a-z0-9@/._~-]`,
			);
		}
		// Plugin code, not type-checked.
		// as never 只绕开 TS 参数限制，42 在运行时仍是数字；模拟未经类型检查的插件边界。
		expect(() => defineJob(42 as never, { version: 1, args, result: int() })).toThrow("A job name 42");
	});

	// 检查声明政策而非 run 行为：无效输入立即抛错，例如 concurrency 1.5 不是正整数。
	it("refuses a bad name, version, unknown option or concurrency", () => {
		// 即使其余配置合法，空名称也应优先被名称检查拒绝。
		expect(() => defineJob("", { version: 1, args, result: int() })).toThrow("A job name");
		// 版本从 1 开始；匹配错误消息，确保不是稍后的 schema 步骤偶然失败。
		expect(() => defineJob("j", { version: 0, args, result: int() })).toThrow(
			"j.version: expected a positive integer",
		);
		// Plugin code, not type-checked.
		// retries 不属于 JobOptions；断言只让错误配置进入运行时，并没有删除该字段。
		const unknownKey = { version: 1, args, result: int(), retries: 3 } as never;
		expect(() => defineJob("j", unknownKey)).toThrow('j: unknown key "retries"');
		// 分别覆盖零、小数、负数；每次都新建定义以验证声明时的数值政策。
		for (const concurrency of [0, 1.5, -1]) {
			expect(() => defineJob("j", { version: 1, args, result: int(), concurrency })).toThrow(
				"j.concurrency: expected a positive integer",
			);
		}
	});

	// 验证 schema 形状边界：任务参数进入 running，必须是 JSON；例如 tags 字符串字典可用，bytes 不可用。
	it("requires closed JSON args, as a method's: open objects and bytes are refused; records are fine", () => {
		// 手写对象 schema 缺少 additionalProperties: false，因此不是 Chord 要求的封闭对象。
		const open = { type: "object", properties: { a: str() } } as never;
		expect(() => defineJob("j", { version: 1, args: open, result: int() })).toThrow(
			"argument objects must be closed",
		);
		// bytes 是 Uint8Array 数据叶节点，虽然普通方法支持它，任务参数仍不允许。
		expect(() => defineJob("j", { version: 1, args: obj({ data: bytes() }), result: int() })).toThrow(
			"j.args: job arguments are JSON",
		);
		// map(str()) 明确声明任意键的字符串字典，区别于遗漏封闭规则的对象；unknown() 作为结果 schema 可声明。
		expect(() => defineJob("j", { version: 1, args: obj({ tags: map(str()) }), result: unknown() })).not.toThrow();
	});

	// 运行期将按任务 id 管理每次运行的单例状态，因此作者不能再提供 keyed 定义；只断言声明拒绝。
	it("takes a singleton document definition as its state", () => {
		expect(() => defineJob("j", { version: 1, args, result: int(), state: Keyed as never })).toThrow(
			"j.state: expected a singleton document definition",
		);
	});

	// accepts 声明旧版本如何向当前版本映射；此用例只检查表的版本和函数形状，不调用映射运行任务。
	it("checks accepts at declaration: older versions only, each with an args and a result function", () => {
		// 两个纯函数示例：旧 cmd 改名为 command，旧数字结果原样保留；old 的类型仅供 TS 检查。
		const adapter = { args: (old: { cmd: string }) => ({ command: old.cmd }), result: (old: number) => old };
		// 版本 3 可以接纳 1、2，两个键共用 adapter 不会被禁止。
		expect(() =>
			defineJob("j", { version: 3, args, result: int(), accepts: { 1: adapter, 2: adapter } }),
		).not.toThrow();
		// 等于当前版本的键也无效，accepts 只接受严格更旧的正整数版本。
		expect(() => defineJob("j", { version: 2, args, result: int(), accepts: { 2: adapter } })).toThrow(
			"j.accepts[2]: not an older version",
		);
		// 零不是合法历史版本，不能用来表示“所有旧版本”。
		expect(() => defineJob("j", { version: 2, args, result: int(), accepts: { 0: adapter } })).toThrow(
			"j.accepts[0]: not an older version",
		);
		// 模拟 JS 插件漏填 result；as never 不会补上这个函数。
		const noResult = { 1: { args: adapter.args } } as never;
		expect(() => defineJob("j", { version: 2, args, result: int(), accepts: noResult })).toThrow(
			"j.accepts[1].result: expected a function",
		);
		// 展开原映射后加一个不允许的 state 回调；状态迁移应由文档自己的 migrate 负责。
		const extra = { 1: { ...adapter, state: () => null } } as never;
		expect(() => defineJob("j", { version: 2, args, result: int(), accepts: extra })).toThrow(
			'j.accepts[1]: unknown key "state"',
		);
	});

	// 检查持久化任务的声明组合；例：rerun 可用，但内存状态/bytes 结果/缺失 resume 被拒绝。这里不打开数据库。
	it("takes persist with a resume rule, a persisted state and a JSON-only result (slice 6b §4)", () => {
		// 声明可持久化单例状态，checkpointWhen 每次都选择保存完整基值；初始 n 是 0。
		const Persisted = defineState("p.state", {
			schema: obj({ n: int() }),
			version: 1,
			initial: () => ({ n: 0 }),
			persist: true,
			checkpointWhen: () => true,
		});
		// 同样的形状但没有 persist，作为配置错误的对照；无参箭头函数只生产初值。
		const InMemory = defineState("m.state", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
		// rerun 表示恢复后重跑 run；这条只读取定义上的策略，不能证明实际恢复已经发生。
		const job = defineJob("j", { version: 1, args, result: int(), state: Persisted, persist: { resume: "rerun" } });
		expect(job.persist).toEqual({ resume: "rerun" });
		// 持久化任务一旦拥有状态，其状态也必须持久化，否则重启只能恢复一半。
		expect(() =>
			defineJob("j", { version: 1, args, result: int(), state: InMemory, persist: { resume: "abandon" } }),
		).toThrow("a persisted job's state is a persisted document");
		// 结果要写入 JSON 运行记录，因此即使没有 state，bytes 结果也不允许持久化。
		expect(() => defineJob("j", { version: 1, args, result: bytes(), persist: { resume: "rerun" } })).toThrow(
			"a persisted job's result is JSON",
		);
		// An in-memory job may return bytes.
		// 不持久化的任务不受此结果限制；仍只检查声明，不执行返回字节的 run。
		expect(() => defineJob("j", { version: 1, args, result: bytes() })).not.toThrow();
		// 下一条同时留给 TS 证明缺少 resume 是类型错误，并在运行时验证被绕过的错误配置；指令紧贴目标。
		// @ts-expect-error: resume is required
		expect(() => defineJob("j", { version: 1, args, result: int(), persist: {} })).toThrow(
			'expected "rerun" or "abandon"',
		);
	});

	// 指纹反映结构而非定义对象引用；例：result 从整数改为字符串会变，这里没测试有旧运行时的重载拒绝。
	it("fingerprints args, result and state: a schema change without a version bump changes it", () => {
		// 相同配置重建，作为指纹应相等的基线。
		const one = defineJob("j", { version: 1, args, result: int() });
		expect(defineJob("j", { version: 1, args, result: int() }).fingerprint).toBe(one.fingerprint);
		// 版本仍为 1，但 result 形状不同，指纹必须不同；后续记录绑定才决定如何处理这种冲突。
		expect(defineJob("j", { version: 1, args, result: str() }).fingerprint).not.toBe(one.fingerprint);
	});
});
