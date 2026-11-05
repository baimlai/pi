// 验证 Context 的值继承、取消与遥测父子关系；遥测只写入内存，不发送到外部系统。
import { InMemoryTelemetryContext, NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { describe, expect, it, vi } from "vitest";
import {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	createContextKey,
	TODO_CONTEXT,
	traceIn,
	withAbortSignal,
	withCancel,
	withContextValue,
	withoutAbortSignal,
	withTelemetry,
} from "../src/context/index.ts";

// 回调注册各项测试，不接收业务输入；例如取消一个子上下文不应取消它的兄弟。
describe("Context", () => {
	// 检查两个空根的默认值；key 的泛型 string 只约束开发时存取的类型。
	it("provides distinct empty root contexts", () => {
		// 创建独立 Symbol 身份的键；描述文字 value 用于显示，而非按文字查找。
		const key = createContextKey<string>("value");

		// 两个根不是同一对象，即使都没有附加值。
		expect(TODO_CONTEXT).not.toBe(BACKGROUND_CONTEXT);
		// 空根没有取消信号；遥测默认是不会记录事件的 NOOP 实现。
		expect(TODO_CONTEXT.abortSignal).toBeUndefined();
		expect(TODO_CONTEXT.telemetry).toBe(NOOP_TELEMETRY_CONTEXT);
		expect(BACKGROUND_CONTEXT.telemetry).toBe(NOOP_TELEMETRY_CONTEXT);
		// 未绑定的键读取为 undefined；String 调用上下文自己的 toString。
		expect(TODO_CONTEXT.value(key)).toBeUndefined();
		expect(String(BACKGROUND_CONTEXT)).toBe("[Context BACKGROUND_CONTEXT]");
		expect(String(TODO_CONTEXT)).toBe("[Context TODO_CONTEXT]");
	});

	// 逐层加键并覆盖旧键，验证只影响新层。例子：replaced 读到 updated，second 仍读 one。
	it("layers typed values without modifying parents", () => {
		// 两个键分别携带 string 和 number；TS 防止混用键和值，运行时以 Symbol 区分。
		const firstKey = createContextKey<string>("first");
		const secondKey = createContextKey<number>("second");
		// 每次 withContextValue 创建一个包装层，找不到键时委托给 parent。
		const first = withContextValue(firstKey, "one", BACKGROUND_CONTEXT);
		const second = withContextValue(secondKey, 2, first);
		// 同一个 firstKey 在最外层重新绑定，遮住里面的 one，不改原层。
		const replaced = withContextValue(firstKey, "updated", second);

		// 根未被添加 firstKey，first 也看不到在其后才添加的 secondKey。
		expect(BACKGROUND_CONTEXT.value(firstKey)).toBeUndefined();
		expect(first.value(firstKey)).toBe("one");
		expect(first.value(secondKey)).toBeUndefined();
		// second 同时读到父层 firstKey 和本层 secondKey。
		expect(second.value(firstKey)).toBe("one");
		expect(second.value(secondKey)).toBe(2);
		// 覆盖后的新层和原 second 各读自己的 firstKey。
		expect(replaced.value(firstKey)).toBe("updated");
		expect(second.value(firstKey)).toBe("one");
		// 文本表示保留所有包装层，包括同一键的再次绑定。
		expect(String(replaced)).toBe("[Context BACKGROUND_CONTEXT].WithValue(first).WithValue(second).WithValue(first)");
	});

	// 建父、子和兄弟三个作用域；先取消 child 再取消 parent，检查取消只沿父到子传播。
	it("inherits parent cancellation and isolates child cancellation", () => {
		// AbortController 发出取消，signal 是下游只读观察入口。
		const parentController = new AbortController();
		const parent = withAbortSignal(parentController.signal, BACKGROUND_CONTEXT);
		// withCancel 返回 { context, cancel }；两个子项各有自己的 controller。
		const child = withCancel(parent);
		const sibling = withCancel(parent);
		// vi.fn 是调用记录器；这里不模拟取消逻辑，只观察真实 abort 事件次数。
		const childListener = vi.fn();
		// ?. 在没有信号时跳过调用；这里的 child 实际有一个组合信号。
		child.context.abortSignal?.addEventListener("abort", childListener);

		// 字符串原因直接传给 AbortController；此处没有调用 awaitWithContext 的错误转换。
		child.cancel("child");
		// child 已取消并保留原因，父和兄弟尚未取消，监听器只执行一次。
		expect(child.context.abortSignal?.aborted).toBe(true);
		expect(child.context.abortSignal?.reason).toBe("child");
		expect(sibling.context.abortSignal?.aborted).toBe(false);
		expect(parent.abortSignal?.aborted).toBe(false);
		expect(childListener).toHaveBeenCalledOnce();

		// 父取消会传给尚未取消的 sibling；不会把 child 已有的原因替换成 parent。
		parentController.abort("parent");
		expect(sibling.context.abortSignal?.aborted).toBe(true);
		expect(sibling.context.abortSignal?.reason).toBe("parent");
	});

	// 派生一个忽略取消的清理上下文，验证取消屏蔽不丢失业务值；例子中 preserved 始终可读。
	it("masks caller cancellation for mandatory cleanup", () => {
		// 为原上下文提供一个可手动中止的信号和 string 值键。
		const controller = new AbortController();
		const key = createContextKey<string>("value");
		// 先附加信号，再附加业务值，形成两层包装。
		const context = withContextValue(key, "preserved", withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
		// 屏蔽信号不是取消原 controller，而是在新层把信号键绑定成 undefined。
		const cleanup = withoutAbortSignal(context);

		// 原上下文观察到取消，清理上下文没有信号且仍能向父层读取业务值。
		controller.abort();
		expect(context.abortSignal?.aborted).toBe(true);
		expect(cleanup.abortSignal).toBeUndefined();
		expect(cleanup.value(key)).toBe("preserved");
	});

	// 用两个内存适配器验证替换 span、嵌套 trace 和信号/业务值相互独立；最终读取记录检验父子 ID。
	// 例如 outer/inner 都记在 telemetry 内，replaced 单独引用 otherSpan。
	it("derives telemetry independently from values and cancellation", async () => {
		// 两个独立存储器，便于检测错误地继承了另一条遥测链。
		const telemetry = new InMemoryTelemetryContext();
		const other = new InMemoryTelemetryContext();
		// await 等待整条嵌套回调；startSpan 给回调传入新建的 span，并在回调结束时完成它。
		await telemetry.startSpan({ name: "caller" }, (parent) =>
			other.startSpan({ name: "other" }, async (otherSpan) => {
				// 本例把 principal 仅当普通上下文值，并未创建 Chord 主机或进行认证。
				const key = createContextKey<string>("principal");
				const controller = new AbortController();
				const base = withContextValue(key, "owner", withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
				// 只改派生层的 telemetry，业务键和取消信号继续委托给 base。
				const context = withTelemetry(parent, base);
				const replaced = withTelemetry(otherSpan, context);
				// base 保持 NOOP；两种派生层分别持有指定 span，值与信号仍是原来的。
				expect(base.telemetry).toBe(NOOP_TELEMETRY_CONTEXT);
				expect(context.telemetry).toBe(parent);
				expect(replaced.telemetry).toBe(otherSpan);
				expect(replaced.value(key)).toBe("owner");
				expect(replaced.abortSignal).toBe(base.abortSignal);
				expect(withoutAbortSignal(context).telemetry).toBe(parent);
				// traceIn 从 context.telemetry 建一个 outer 子 span，向回调传入挂着子 span 的 Context。
				await traceIn(
					{ name: "outer" },
					async (child) => {
						// child 仍读到 owner 和同一 signal；遥测事件写在 outer 上。
						expect(child.value(key)).toBe("owner");
						expect(child.abortSignal).toBe(context.abortSignal);
						child.telemetry.addEvent("started");
						// 内层再以 child 为父创建 inner；必须传 child 才保留 outer→inner 关系。
						await traceIn(
							{ name: "inner" },
							(nested) => {
								// addLink 记录另一 span 的关联；它和 parentId 是不同字段。
								nested.telemetry.addLink({ context: child.telemetry });
								// 同步回调结果可由 traceIn 的 Promise 带回；本例不消费内层结果。
								return 42;
							},
							child,
						);
					},
					context,
				);
				// 数组解构按创建顺序取记录；?. 让缺失记录变成 undefined，断言会暴露不匹配。
				const [caller, outer, inner] = telemetry.getSpans();
				// outer 的父是 caller，inner 的父和显式 link 都指向 outer。
				expect(outer?.parentId).toBe(caller?.id);
				expect(inner?.parentId).toBe(outer?.id);
				expect(inner?.links[0]?.context).toEqual(outer?.context);
				expect(context.telemetry).toBe(parent);
				// 跟踪完成后原 context 仍挂 parent；取消传播也仍有效。
				controller.abort();
				expect(context.abortSignal?.aborted).toBe(true);
			}),
		);
	});

	// 并发启动 first/second，用 gate 让它们交错完成，再检验各自子 span、返回值和原样错误。
	// 无外部 I/O；例子 first.child 必须隶属 first，不能因 second 先运行完而改父链。
	it("isolates concurrent traceIn branches and preserves callback results and errors", async () => {
		// 适配器只把 span 放内存，便于稍后按名称寻找。
		const telemetry = new InMemoryTelemetryContext();
		await telemetry.startSpan({ name: "caller" }, async (parent) => {
			// 两个分支共享此父上下文，但各自拿到自己的派生层。
			const context = withTelemetry(parent, BACKGROUND_CONTEXT);
			// (() => void) | undefined 表示尚未保存或已经保存的解锁函数。
			let release: (() => void) | undefined;
			// Promise 构造器同步执行此回调，把 resolve 保存起来让另一个分支稍后调用。
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			// first 先建立 span，但停在 gate，暂时不创建 first.child。
			const first = traceIn(
				{ name: "first" },
				async (child) => {
					// 等第二分支显式解锁，不使用依赖机器速度的定时器。
					await gate;
					// 返回内层 Promise，外层 traceIn 会等待它并传回 first。
					return traceIn({ name: "first.child" }, () => "first", child);
				},
				context,
			);
			// second 在 first 等待期间创建自己的子 span，然后放行 first。
			const second = traceIn(
				{ name: "second" },
				async (child) => {
					// 回调返回字符串，这里 await 得到它，再唤醒另一分支。
					const result = await traceIn({ name: "second.child" }, () => "second", child);
					// ?.() 只在 resolver 已保存时调用；gate 构造器同步运行，正常路径已经保存。
					release?.();
					// 把 second.child 的结果继续传回 second 的调用方。
					return result;
				},
				context,
			);
			// Promise.all 的结果按输入顺序排列，而不是按实际完成顺序。
			expect(await Promise.all([first, second])).toEqual(["first", "second"]);
			// 读取内存记录并按名字校验每个 child 的 parentId。
			const spans = telemetry.getSpans();
			for (const name of ["first", "second"]) {
				// find 的箭头回调只是比较名字，未修改记录。
				const parent = spans.find((span) => span.name === name);
				expect(spans.find((span) => span.name === `${name}.child`)?.parentId).toBe(parent?.id);
			}
			// 故意抛普通对象，toBe 检查 traceIn 没有换成一个新的 Error。
			const failure = { reason: "same value" };
			// rejects 等待 Promise 拒绝；同步抛出由 startSpan 转成拒绝。
			await expect(
				traceIn(
					{ name: "throw" },
					() => {
						// 故意触发错误路径，原对象应到达调用方。
						throw failure;
					},
					context,
				),
			).rejects.toBe(failure);
			// 返回一个拒绝的 Promise 同样保留原原因，覆盖异步错误路径。
			await expect(traceIn({ name: "reject" }, () => Promise.reject(failure), context)).rejects.toBe(failure);
			// NOOP 适配器也执行回调并保留结果，只是不保存遥测记录。
			expect(
				await traceIn(
					{ name: "noop" },
					(child) => {
						// 此 addLink 对 NOOP 无记录副作用，不影响返回值。
						child.telemetry.addLink({ context: parent });
						return 42;
					},
					BACKGROUND_CONTEXT,
				),
			).toBe(42);
		});
	});

	// 取消包装后的等待，而非底层 Promise；例如 waiting 拒绝后 work 仍能完成为 completed later。
	it("stops waiting when the invocation is cancelled", async () => {
		// 创建可取消上下文，供 awaitWithContext 观察。
		const controller = new AbortController();
		const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
		// ! 是确定赋值断言，TS 相信 Promise 构造回调会先给此函数赋值；运行时没有额外检查。
		let resolveWork!: (value: string) => void;
		// string 泛型规定此 Promise 成功时产出字符串。
		const work = new Promise<string>((resolve) => {
			// 保存 resolver，稍后在取消后仍可完成原工作。
			resolveWork = resolve;
		});
		// 包装一个新等待者，尚未取消时它与 work 竞争完成。
		const waiting = awaitWithContext(work, context);
		// 传 Error 使 abortError 原样返回该原因，而非创建 DOMException。
		const cancellation = new Error("cancelled");

		// 发出取消，waiting 应拒绝为同一个 cancellation 实例。
		controller.abort(cancellation);
		await expect(waiting).rejects.toBe(cancellation);
		// 底层任务未被取消，依然可用原 resolver 完成。
		resolveWork("completed later");
		await expect(work).resolves.toBe("completed later");
		// 没有信号的根上下文直接等待原 Promise，成功值不变。
		await expect(awaitWithContext(Promise.resolve("completed"), BACKGROUND_CONTEXT)).resolves.toBe("completed");
	});
});
